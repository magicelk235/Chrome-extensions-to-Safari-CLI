import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { convertServiceWorkerToBackgroundPage, pushArrayElementCount, SW_LIFECYCLE_FILENAME } from "../dist/runtime/shim.js";
import { analyzeManifest, transformManifest } from "../dist/manifest/manifest.js";

function stage(files) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-chunks-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

// Minified webpack worker runtime shape (MetaMask's service-worker.js).
const SW_WEBPACK =
  'var r={f:{}};r.u=e=>e+".js";' +
  'var e={5864:1};r.f.i=(t,n)=>{e[t]||importScripts(r.p+r.u(t))};' +
  "var t=globalThis.webpackChunk=globalThis.webpackChunk||[],n=t.push.bind(t);" +
  "t.push=t=>{var[i,s,a]=t;for(var o in s)r.m[o]=s[o];for(a&&a(r);i.length;)e[i.pop()]=1;n(t)};" +
  'self.addEventListener("install",()=>{});';

test("pre-registers 2-element webpack chunk pushes after the SW module tag", () => {
  const dir = stage({
    "sw.js": SW_WEBPACK,
    // pure async chunk (with "use strict" prefix, like MetaMask's)
    "123.abc.js": '"use strict";(globalThis.webpackChunk=globalThis.webpackChunk||[]).push([[123],{1(e,t,r){}}]);',
    // license banner prefix is still a pure chunk
    "456.def.js": "/*! license */(globalThis.webpackChunk=globalThis.webpackChunk||[]).push([[456],{2(e,t,r){}}]);\n//# sourceMappingURL=456.def.js.map",
    // 3-element push = entry startup callback — must NOT be loaded
    "entry.js": "(globalThis.webpackChunk=globalThis.webpackChunk||[]).push([[9],{3(e){}},r=>{r(3)}]);",
    // different chunk global = another bundle's chunk — must NOT be loaded
    "ui.js": "(globalThis.webpackChunkui=globalThis.webpackChunkui||[]).push([[7],{4(e){}}]);",
    // real code before the push = entry script — must NOT be loaded
    "boot.js": 'console.log("hi");(globalThis.webpackChunk=globalThis.webpackChunk||[]).push([[8],{5(e){}}]);',
  });
  const manifest = { manifest_version: 3, name: "T", background: { service_worker: "sw.js" } };
  assert.equal(convertServiceWorkerToBackgroundPage(dir, manifest), true);
  const html = readFileSync(join(dir, "background.html"), "utf-8");

  assert.match(html, /<script defer src="123\.abc\.js"><\/script>/);
  assert.match(html, /<script defer src="456\.def\.js"><\/script>/);
  assert.ok(!html.includes('src="entry.js"'), "entry-callback push must be excluded");
  assert.ok(!html.includes('src="ui.js"'), "foreign chunk global must be excluded");
  assert.ok(!html.includes('src="boot.js"'), "file with leading code must be excluded");
  // chunks load AFTER the SW module (shared in-order deferred queue)
  assert.ok(html.indexOf('type="module" src="sw.js"') < html.indexOf('src="123.abc.js"'));
  // lifecycle shim is staged and loads first
  assert.ok(existsSync(join(dir, SW_LIFECYCLE_FILENAME)));
  assert.ok(html.indexOf(SW_LIFECYCLE_FILENAME) < html.indexOf('type="module"'));
  // the dynamic importScripts call itself is still neutralized
  assert.ok(!/\bimportScripts\s*\(/.test(readFileSync(join(dir, "sw.js"), "utf-8")));
  rmSync(dir, { recursive: true, force: true });
});

test("a chunk push behind a >4KB license banner is still pre-registered", () => {
  const banner = "/*!" + "L".repeat(6000) + "*/\n"; // bigger than the old 4KB head window
  const dir = stage({
    "sw.js": SW_WEBPACK,
    "big.js": banner + "(globalThis.webpackChunk=globalThis.webpackChunk||[]).push([[42],{6(e,t,r){}}]);",
  });
  const manifest = { manifest_version: 3, name: "T", background: { service_worker: "sw.js" } };
  convertServiceWorkerToBackgroundPage(dir, manifest);
  const html = readFileSync(join(dir, "background.html"), "utf-8");
  assert.match(html, /<script defer src="big\.js"><\/script>/);
  rmSync(dir, { recursive: true, force: true });
});

test("a static backtick importScripts target is hoisted like a quoted one", () => {
  const dir = stage({
    "sw.js": "importScripts(`worker-core.js`);",
    "worker-core.js": "self.core=1;",
  });
  const manifest = { manifest_version: 3, name: "T", background: { service_worker: "sw.js" } };
  convertServiceWorkerToBackgroundPage(dir, manifest);
  const html = readFileSync(join(dir, "background.html"), "utf-8");
  assert.match(html, /<script src="worker-core\.js"><\/script>/);
  assert.ok(!/\bimportScripts\s*\(/.test(readFileSync(join(dir, "sw.js"), "utf-8")));
  rmSync(dir, { recursive: true, force: true });
});

test("an interpolated-template importScripts arg is treated as dynamic (chunk fallback runs)", () => {
  // importScripts(`${r.p}chunk.js`) is a runtime value, NOT a static target: it must
  // NOT be hoisted as a literal, and — because it's dynamic — the webpack-chunk
  // pre-registration must kick in so the async chunk still loads.
  const dir = stage({
    "sw.js": SW_WEBPACK.replace("importScripts(r.p+r.u(t))", "importScripts(`${r.p}${r.u(t)}`)"),
    "77.js": "(globalThis.webpackChunk=globalThis.webpackChunk||[]).push([[77],{7(e,t,r){}}]);",
  });
  const manifest = { manifest_version: 3, name: "T", background: { service_worker: "sw.js" } };
  convertServiceWorkerToBackgroundPage(dir, manifest);
  const html = readFileSync(join(dir, "background.html"), "utf-8");
  // dynamic detected → chunk fallback pre-registers 77.js; the template is not hoisted
  assert.match(html, /<script defer src="77\.js"><\/script>/);
  assert.ok(!/<script src="`/.test(html), "interpolated template must not be hoisted as a literal");
  rmSync(dir, { recursive: true, force: true });
});

test("importScripts on an aliased receiver is neutralized without a syntax error", () => {
  const dir = stage({
    // `g` is a self alias — the whole member-call must be replaced, not just
    // `importScripts(...)` (which would leave `g.void 0`, a SyntaxError).
    "sw.js": 'var g=self;g.importScripts("lib.js");self.ok=1;',
    "lib.js": "self.lib=1;",
  });
  const manifest = { manifest_version: 3, name: "T", background: { service_worker: "sw.js" } };
  convertServiceWorkerToBackgroundPage(dir, manifest);
  const swOut = readFileSync(join(dir, "sw.js"), "utf-8");
  assert.ok(!/\.void 0/.test(swOut), "receiver must be consumed, not left dangling");
  assert.doesNotThrow(() => new Function(swOut), "neutralized SW must still parse");
  const html = readFileSync(join(dir, "background.html"), "utf-8");
  assert.match(html, /<script src="lib\.js"><\/script>/);
  rmSync(dir, { recursive: true, force: true });
});

test("no chunk scan without a dynamic importScripts", () => {
  const dir = stage({
    "sw.js": 'importScripts("lib.js");self.x=1;',
    "lib.js": "self.lib=1;",
    "999.js": "(globalThis.webpackChunk=globalThis.webpackChunk||[]).push([[999],{9(e){}}]);",
  });
  const manifest = { manifest_version: 3, name: "T", background: { service_worker: "sw.js" } };
  convertServiceWorkerToBackgroundPage(dir, manifest);
  const html = readFileSync(join(dir, "background.html"), "utf-8");
  assert.match(html, /<script src="lib\.js"><\/script>/);
  assert.ok(!html.includes("999.js"), "static-only SW must not pull in chunk files");
  rmSync(dir, { recursive: true, force: true });
});

test("hoists and neutralizes importScripts in hoisted files recursively, dep first", () => {
  const dir = stage({
    "sw.js": 'importScripts("a.js");',
    "a.js": 'importScripts("b.js");self.a=1;',
    "b.js": 'self.b=1;importScripts("a.js");', // cycle back — must not loop
  });
  const manifest = { manifest_version: 3, name: "T", background: { service_worker: "sw.js" } };
  convertServiceWorkerToBackgroundPage(dir, manifest);
  const html = readFileSync(join(dir, "background.html"), "utf-8");
  // b (a's dep) is tagged before a, both before the SW itself
  assert.ok(html.indexOf('src="b.js"') < html.indexOf('src="a.js"'));
  assert.ok(html.indexOf('src="a.js"') < html.indexOf('src="sw.js"'));
  // no-ESM bundle loads as a classic script (synchronous listener registration for
  // Safari); type="module" is reserved for bundles that actually need it
  assert.ok(!/type="module"/.test(html));
  // every hoisted file is de-fanged — no page-time importScripts calls remain
  assert.ok(!/\bimportScripts\s*\(/.test(readFileSync(join(dir, "a.js"), "utf-8")));
  assert.ok(!/\bimportScripts\s*\(/.test(readFileSync(join(dir, "b.js"), "utf-8")));
  rmSync(dir, { recursive: true, force: true });
});

test("pushArrayElementCount distinguishes chunk pushes from entry pushes", () => {
  assert.equal(pushArrayElementCount('[[123],{1(e,t,r){"a,b"}}]'), 2);
  assert.equal(pushArrayElementCount("[[1],{2(e){}},r=>{r(2)}]"), 3);
  assert.equal(pushArrayElementCount('[[1],{f(e){return /,/.test(e)}}]'), 2); // regex comma
  assert.equal(pushArrayElementCount("[[1],{a:1,b:2}]"), 2); // nested commas don't count
  assert.equal(pushArrayElementCount("notanarray"), -1);
  assert.equal(pushArrayElementCount("[[1],{}] , extra"), -1); // trailing junk
  // Nested template literals (MetaMask chunk 6078 shape) — interpolations are
  // code; inner templates must not desync the lexer.
  assert.equal(pushArrayElementCount("[[1],{f(e){return`a${e.map(e=>`\"${e.type}\"`).join(\", \")}b`}}]"), 2);
  assert.equal(pushArrayElementCount('[[1],{f(y,b){return`${b}${"0"===y?"":`.${y}`}`}}]'), 2);
  assert.equal(pushArrayElementCount("[[1],{f(e){return`${(e)}`}},r=>{r(1)}]"), 3); // still sees 3rd element
});

test("invalid host_permissions are auto-fixed warnings and removed by transform", () => {
  const manifest = {
    manifest_version: 3,
    name: "T",
    version: "1.0",
    permissions: ["storage"],
    host_permissions: ["ws://*/*", "wss://*/*", "https://*/*"],
  };
  const { issues } = analyzeManifest(manifest);
  const wsIssues = issues.filter((i) => i.message.includes('"ws://*/*"') || i.message.includes('"wss://*/*"'));
  assert.equal(wsIssues.length, 2);
  for (const i of wsIssues) {
    assert.equal(i.severity, "warning");
    assert.equal(i.autoFixed, true);
  }
  const dir = mkdtempSync(join(tmpdir(), "viaduct-hosts-"));
  const out = transformManifest(manifest, [], dir, { keepModuleBackground: false });
  assert.deepEqual(out.host_permissions, ["https://*/*"]);
  rmSync(dir, { recursive: true, force: true });
});
