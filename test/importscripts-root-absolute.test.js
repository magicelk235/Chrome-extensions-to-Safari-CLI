import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { convertServiceWorkerToBackgroundPage } from "../dist/runtime/shim.js";

// Regression: Replace AI Translator API 1.0.21. Its service worker lives in src/ and
// imports its libraries by ROOT-absolute path — importScripts("/src/lib/actions.js").
// That is how importScripts resolves URLs (against the worker's location, so a leading
// "/" is the extension root), but the converter joined the literal onto the worker's
// own directory: "src" + "/src/lib/actions.js" = "src/src/lib/actions.js", which
// exists nowhere. The target was dropped while the call was still neutralized, so the
// background page loaded none of its libraries and every message handler threw on the
// first missing global. The popup's GET_STATE came back {ok:false,error:"exception"},
// its settings stayed null, and clicking a provider did nothing at all.

function stage(files) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-imports-"));
  for (const [name, content] of Object.entries(files)) {
    const at = join(dir, name);
    mkdirSync(join(at, ".."), { recursive: true });
    writeFileSync(at, content);
  }
  return dir;
}

test("a root-absolute importScripts target is hoisted, not silently dropped", () => {
  const dir = stage({
    "src/service_worker.js":
      'if (typeof importScripts === "function") {\n' +
      '  importScripts("/src/lib/actions.js", "/src/lib/providers.js");\n' +
      "}\n" +
      "chrome.runtime.onMessage.addListener(() => Actions.GET_STATE);\n",
    "src/lib/actions.js": "var Actions = { GET_STATE: 'GET_STATE' };\n",
    "src/lib/providers.js": "var Providers = { ids: [] };\n",
  });
  const manifest = { manifest_version: 3, name: "T", background: { service_worker: "src/service_worker.js" } };
  assert.equal(convertServiceWorkerToBackgroundPage(dir, manifest), true);

  const html = readFileSync(join(dir, "background.html"), "utf-8");
  assert.match(html, /<script src="src\/lib\/actions\.js"><\/script>/);
  assert.match(html, /<script src="src\/lib\/providers\.js"><\/script>/);
  assert.ok(!html.includes("src/src/"), "the leading / is the extension root, not the worker's dir");
  // Libraries must be in scope before the worker body runs.
  assert.ok(html.indexOf('src="src/lib/actions.js"') < html.indexOf('src="src/service_worker.js"'));

  const sw = readFileSync(join(dir, "src/service_worker.js"), "utf-8");
  assert.ok(!/\bimportScripts\s*\(/.test(sw), "the call is still neutralized for the background page");
  rmSync(dir, { recursive: true, force: true });
});

test("a worker-relative target still resolves against the worker's dir", () => {
  const dir = stage({
    "src/service_worker.js": 'importScripts("lib/actions.js", "./lib/providers.js");\n',
    "src/lib/actions.js": "var Actions = {};\n",
    "src/lib/providers.js": "var Providers = {};\n",
  });
  const manifest = { manifest_version: 3, name: "T", background: { service_worker: "src/service_worker.js" } };
  assert.equal(convertServiceWorkerToBackgroundPage(dir, manifest), true);

  const html = readFileSync(join(dir, "background.html"), "utf-8");
  assert.match(html, /<script src="src\/lib\/actions\.js"><\/script>/);
  assert.match(html, /<script src="src\/lib\/providers\.js"><\/script>/);
  rmSync(dir, { recursive: true, force: true });
});
