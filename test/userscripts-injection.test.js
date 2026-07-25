import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { shimSource, wireUserScriptsContentScript, USERSCRIPTS_CS_FILENAME } from "../dist/runtime/shim.js";

// chrome.userScripts has two halves on Safari: the background publishes its registry to
// storage, and a declared content script reads it and evaluates what matches. It does
// NOT go over runtime.sendMessage — that broadcast reaches every listener and the first
// sendResponse wins, and live, Tampermonkey's own background handler consumed the
// request and answered with nothing on all twelve retries. Storage also survives the
// background being torn down, so a document_start injector that runs before the
// background has woken still finds the scripts.
const STORE_KEY = "__viaductUserScripts";

/** The background half: run the shim, register scripts, capture what it stores. */
function background() {
  const stored = {};
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: (u) => Promise.resolve({ text: () => Promise.resolve(`/* ${u} */ window.__fromFile = true;`) }),
    location: { href: "safari-web-extension://TEST/background.html", protocol: "safari-web-extension:" },
    navigator: { userAgent: "test" },
    chrome: {
      runtime: {
        id: "test-ext",
        getURL: (p) => "safari-web-extension://TEST/" + p,
        onMessage: { addListener() {}, removeListener() {} },
        sendMessage() {},
      },
      storage: {
        local: {
          set(obj, cb) { Object.assign(stored, obj); cb && cb(); },
          get(key, cb) { cb({ [key]: stored[key] }); },
        },
      },
      scripting: { executeScript: () => Promise.resolve([]) },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  return { sandbox, stored, published: () => stored[STORE_KEY] };
}

/** The page half: run the generated injector against a published registry. */
function page(published, { url = "https://example.com/page", isTop = true, readyState = "loading" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-us-"));
  const original = { permissions: ["userScripts"] };
  const transformed = { permissions: [] };
  wireUserScriptsContentScript(dir, transformed, original);
  const src = readFileSync(join(dir, USERSCRIPTS_CS_FILENAME), "utf-8");
  rmSync(dir, { recursive: true, force: true });

  const domReady = [];
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    location: { href: url },
    document: {
      readyState,
      addEventListener: (t, fn) => { if (t === "DOMContentLoaded") domReady.push(fn); },
    },
    chrome: {
      runtime: { getURL: (p) => "safari-web-extension://TEST/" + p },
      storage: { local: { get: (key, cb) => cb({ [key]: published }) } },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.top = isTop ? sandbox : {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { sandbox, fireDomReady: () => domReady.forEach((fn) => fn()) };
}

const userScript = (over = {}) => ({
  id: "tm-1",
  js: [{ code: "window.__ran = true;" }],
  matches: ["<all_urls>"],
  runAt: "document_start",
  world: "USER_SCRIPT",
  allFrames: true,
  ...over,
});

test("registering publishes the script for the page to find", async () => {
  const bg = background();
  await bg.sandbox.chrome.userScripts.register([userScript()]);
  const out = bg.published();
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "tm-1");
  assert.equal(out[0].code, "window.__ran = true;");
  assert.equal(out[0].allFrames, true);
});

test("end to end: a registered script actually runs on a matching page", async () => {
  const bg = background();
  await bg.sandbox.chrome.userScripts.register([userScript()]);
  const { sandbox } = page(bg.published());
  assert.equal(sandbox.__ran, true, "the userscript body must have executed in the page");
});

test("end to end: Tampermonkey's real registration shape runs", async () => {
  // Exactly what Tampermonkey registers, from a live getScripts() dump.
  const bg = background();
  await bg.sandbox.chrome.userScripts.register([
    { id: "3|content|wwywq+undefined|r|x", matches: ["<all_urls>"], allFrames: true,
      runAt: "document_start", world: "USER_SCRIPT", js: [{ code: "window.__tmContent = 1;" }] },
    { id: "1|page|wwywq+undefined", matches: ["<all_urls>"], allFrames: true,
      runAt: "document_start", world: "USER_SCRIPT", js: [{ code: "window.__tmPage = 1;" }] },
  ]);
  const { sandbox } = page(bg.published());
  assert.equal(sandbox.__tmContent, 1);
  assert.equal(sandbox.__tmPage, 1);
});

test("a page the script does not match runs nothing", async () => {
  const bg = background();
  await bg.sandbox.chrome.userScripts.register([userScript({ matches: ["https://other.test/*"] })]);
  const { sandbox } = page(bg.published());
  assert.equal(sandbox.__ran, undefined);
});

test("excludeMatches and globs are honoured in the page", async () => {
  const bg = background();
  await bg.sandbox.chrome.userScripts.register([
    userScript({ id: "excluded", matches: ["<all_urls>"], excludeMatches: ["https://example.com/*"],
                 js: [{ code: "window.__excluded = true;" }] }),
    userScript({ id: "globbed", matches: ["<all_urls>"], includeGlobs: ["*/other*"],
                 js: [{ code: "window.__globbed = true;" }] }),
  ]);
  const { sandbox } = page(bg.published());
  assert.equal(sandbox.__excluded, undefined);
  assert.equal(sandbox.__globbed, undefined);
});

test("a subframe only runs the scripts that asked for all frames", async () => {
  const bg = background();
  await bg.sandbox.chrome.userScripts.register([
    userScript({ id: "main-only", allFrames: false, js: [{ code: "window.__mainOnly = true;" }] }),
    userScript({ id: "all", allFrames: true, js: [{ code: "window.__all = true;" }] }),
  ]);
  const { sandbox } = page(bg.published(), { isTop: false });
  assert.equal(sandbox.__mainOnly, undefined);
  assert.equal(sandbox.__all, true);
});

test("document_idle waits for DOMContentLoaded", async () => {
  const bg = background();
  await bg.sandbox.chrome.userScripts.register([
    userScript({ runAt: "document_idle", js: [{ code: "window.__late = true;" }] }),
  ]);
  const { sandbox, fireDomReady } = page(bg.published(), { readyState: "loading" });
  assert.equal(sandbox.__late, undefined, "must not run before the DOM is ready");
  fireDomReady();
  assert.equal(sandbox.__late, true);
});

test("file-backed scripts are read in the background, where they are reachable", async () => {
  const bg = background();
  await bg.sandbox.chrome.userScripts.register([userScript({ js: [{ file: "us.js" }] })]);
  await new Promise((r) => setTimeout(r, 10)); // the fetch is async
  const out = bg.published();
  assert.match(out[0].code, /__fromFile/, "the file's text must be inlined for the page");
});

test("unregistering removes it from what the page can find", async () => {
  const bg = background();
  await bg.sandbox.chrome.userScripts.register([userScript()]);
  await bg.sandbox.chrome.userScripts.unregister({ ids: ["tm-1"] });
  assert.equal(bg.published().length, 0);
  const { sandbox } = page(bg.published());
  assert.equal(sandbox.__ran, undefined);
});

test("updating the code changes what the page runs", async () => {
  const bg = background();
  await bg.sandbox.chrome.userScripts.register([userScript()]);
  await bg.sandbox.chrome.userScripts.update([{ id: "tm-1", js: [{ code: "window.__v = 2;" }] }]);
  const { sandbox } = page(bg.published());
  assert.equal(sandbox.__v, 2);
});

// ── how the injector gets into the bundle ──────────────────────────────────────
test("the injector is wired only for an extension that asked for userScripts", () => {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-us-"));
  try {
    const plain = { permissions: ["storage"] };
    assert.equal(wireUserScriptsContentScript(dir, plain, plain), null);
    assert.equal(existsSync(join(dir, USERSCRIPTS_CS_FILENAME)), false);
    assert.equal(plain.content_scripts, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the injector is declared at document_start in all frames", () => {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-us-"));
  try {
    const original = { permissions: ["userScripts", "scripting"] };
    const transformed = { permissions: ["scripting"] };
    assert.equal(wireUserScriptsContentScript(dir, transformed, original), USERSCRIPTS_CS_FILENAME);
    const entry = transformed.content_scripts.find((cs) => cs.js.includes(USERSCRIPTS_CS_FILENAME));
    assert.ok(entry);
    assert.deepEqual(entry.matches, ["<all_urls>"]);
    assert.equal(entry.run_at, "document_start");
    assert.equal(entry.all_frames, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-wiring the same bundle does not declare it twice", () => {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-us-"));
  try {
    const original = { permissions: ["userScripts"] };
    const transformed = { permissions: [] };
    wireUserScriptsContentScript(dir, transformed, original);
    wireUserScriptsContentScript(dir, transformed, original);
    assert.equal(transformed.content_scripts.filter((cs) => cs.js.includes(USERSCRIPTS_CS_FILENAME)).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
