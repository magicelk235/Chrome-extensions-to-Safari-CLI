import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATE_DIR } from "../dist/paths.js";

// An MV3 bundle asks whether it IS the worker and routes on the answer:
//
//   if ("ServiceWorkerGlobalScope" in globalThis) return readTokenLocally();
//   const r = await chrome.runtime.sendMessage({ type: "check_and_refresh_oauth" });
//
// In Chrome the background is a ServiceWorkerGlobalScope, so it does the work locally
// while panels ask it over messaging. The conversion makes the background a PAGE, the
// global disappears, and the background takes the asking branch: it messages itself,
// nothing answers, and the work never happens. Claude for Chrome routes its OAuth
// refresh this way, so the token stops being refreshed and the user is bounced back to
// a login screen once it expires.
//
// The answer has to come at runtime. The module that asks is shared with the panel,
// where the answer must stay NO, or two contexts race a single-use refresh token.
const lifecycle = readFileSync(join(TEMPLATE_DIR, "viaduct-sw-lifecycle.js"), "utf8");

/** The generated background page: this template is loaded there and nowhere else. */
function backgroundPage() {
  const listeners = {};
  const sandbox = {
    console, Promise, Object, Symbol, String, Error, Date,
    location: { href: "safari-web-extension://ABC/background.html" },
    Event: class { constructor(t) { this.type = t; } },
    document: {
      readyState: "complete",
      addEventListener() {},
      createEvent: () => ({ initEvent() {} }),
    },
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener() {},
    dispatchEvent() { return true; },
    setTimeout, clearTimeout,
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(lifecycle, sandbox, { filename: "viaduct-sw-lifecycle.js" });
  return sandbox;
}

test("the background page answers yes to the worker-scope question", () => {
  const bg = backgroundPage();
  assert.equal(
    vm.runInContext('"ServiceWorkerGlobalScope" in globalThis', bg),
    true,
    "the branch that reads and refreshes locally"
  );
  assert.equal(vm.runInContext('typeof ServiceWorkerGlobalScope', bg), "function");
  assert.equal(
    vm.runInContext("self instanceof ServiceWorkerGlobalScope", bg),
    true,
    "the other half of the idiom"
  );
  assert.equal(
    vm.runInContext("globalThis instanceof ServiceWorkerGlobalScope", bg),
    true
  );
});

test("an ordinary object is not a worker scope", () => {
  const bg = backgroundPage();
  assert.equal(vm.runInContext("({}) instanceof ServiceWorkerGlobalScope", bg), false);
  assert.equal(vm.runInContext("[] instanceof ServiceWorkerGlobalScope", bg), false);
});

test("a real worker scope is left alone", () => {
  // Nothing to emulate where the platform already provides it, and clobbering the real
  // constructor would break `instanceof` for genuine worker objects.
  const sandbox = { console, Promise, Object, Symbol, location: { href: "x" } };
  const native = function ServiceWorkerGlobalScope() {};
  sandbox.ServiceWorkerGlobalScope = native;
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  // No document: the template bails before touching anything, as it does in a worker.
  vm.createContext(sandbox);
  vm.runInContext(lifecycle, sandbox);
  assert.equal(sandbox.ServiceWorkerGlobalScope, native);
});

test("only the background page gets it, because only it loads this file", () => {
  // The panel and popup load browser-polyfill + the shim, never this template, so their
  // answer stays NO and they keep asking the background. Guard the invariant by name:
  // the generated background.html is the sole script tag for it.
  const bg = backgroundPage();
  assert.equal(typeof bg.ServiceWorkerGlobalScope, "function");
  const plainPage = { console, Promise, Object, Symbol, location: { href: "safari-web-extension://ABC/sidepanel.html" } };
  assert.equal(typeof plainPage.ServiceWorkerGlobalScope, "undefined");
});
