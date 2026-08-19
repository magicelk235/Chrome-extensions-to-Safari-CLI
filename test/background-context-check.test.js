import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { rewriteBackgroundContextChecks } from "../dist/input/stage.js";

// Regression: Cloaked - Privacy & Password Manager. In Chrome the MV3 background is a
// service worker, so bundles detect it by the absence of `window`. The conversion makes
// the background a PAGE, which has one, so the bundle concludes it is a content script
// and its dispatcher (`if (msg.to !== this.myEndpoint) return false`) silently drops
// every message addressed to the background. Clicking "Log in" hung forever with no
// error in any console.

function stage(files) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-bgctx-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function run(files, manifest) {
  const dir = stage(files);
  try {
    const n = rewriteBackgroundContextChecks(dir, manifest);
    const out = {};
    for (const name of Object.keys(files)) out[name] = readFileSync(join(dir, name), "utf-8");
    return { n, out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SW = { background: { service_worker: "static/js/background.js" } };

test("the minified Cloaked shape flips to true", () => {
  const src = 'function r(){if(!chrome?.runtime?.id)return null;if(void 0===globalThis.window)return"background_script";return"content_script"}';
  const { n, out } = run({ "static/js/background.js": src }, SW);
  assert.equal(n, 1);
  assert.match(out["static/js/background.js"], /if\(true\)return"background_script"/);
  // Everything else in the statement survives intact.
  assert.match(out["static/js/background.js"], /if\(!chrome\?\.runtime\?\.id\)return null;/);
});

test("the unminified and terser spellings are all covered", () => {
  const variants = [
    ['if (typeof window === "undefined") return "background";', /if \(true\) return "background";/],
    ["if (typeof window === 'undefined') return 'service_worker';", /if \(true\) return 'service_worker';/],
    ['if ("undefined" == typeof window) return "backgroundScript";', /if \(true\) return "backgroundScript";/],
    ['if(typeof window>"u")return"sw"', /if\(true\)return"sw"/],
    ['if (typeof globalThis.window === "undefined") return "background_script";', /if \(true\) return "background_script";/],
  ];
  for (const [src, expected] of variants) {
    const { n, out } = run({ "static/js/background.js": src }, SW);
    assert.equal(n, 1, `not rewritten: ${src}`);
    assert.match(out["static/js/background.js"], expected);
  }
});

test("a braced body keeps its brace (dropping it would break the parse)", () => {
  const src = 'if (typeof window === "undefined") { return "background_script"; }\nconsole.log(1);';
  const { out } = run({ "static/js/background.js": src }, SW);
  const text = out["static/js/background.js"];
  assert.match(text, /if \(true\) \{ return "background_script"; \}/);
  assert.equal((text.match(/\{/g) || []).length, (text.match(/\}/g) || []).length);
});

test("the ternary form is covered too", () => {
  const src = 'const t=typeof window==="undefined"?"background":"content_script";';
  const { n, out } = run({ "static/js/background.js": src }, SW);
  assert.equal(n, 1);
  assert.match(out["static/js/background.js"], /const t=true\?"background":"content_script";/);
});

test("the same detector in the POPUP bundle is left alone", () => {
  // The popup must keep answering "not the background" — rewriting it would make the
  // popup claim the background's endpoint and swallow its own replies.
  const src = 'if(void 0===globalThis.window)return"background_script";';
  const { n, out } = run(
    { "static/js/background.js": "// nothing here\n", "static/js/popup.js": src },
    SW,
  );
  assert.equal(n, 0);
  assert.equal(out["static/js/popup.js"], src);
});

test("a library using the same idiom for something else is left alone", () => {
  // Universal (node/browser) libraries branch on `window` constantly. Only a check that
  // directly yields a background-ish value is about extension context.
  const src = 'const isNode = typeof window === "undefined";\nif (typeof window === "undefined") return require("fs");';
  const { n, out } = run({ "static/js/background.js": src }, SW);
  assert.equal(n, 0);
  assert.equal(out["static/js/background.js"], src);
});

test("MV2 background.scripts entries are rewritten as well", () => {
  const src = 'if(void 0===globalThis.window)return"background_script";';
  const { n, out } = run(
    { "bg/a.js": src, "bg/b.js": src },
    { background: { scripts: ["bg/a.js", "./bg/b.js"] } },
  );
  assert.equal(n, 2);
  for (const f of ["bg/a.js", "bg/b.js"]) assert.match(out[f], /if\(true\)return"background_script"/);
});

test("a manifest with no background section is a no-op", () => {
  const { n } = run({ "static/js/background.js": 'if(void 0===globalThis.window)return"background_script";' }, {});
  assert.equal(n, 0);
});
