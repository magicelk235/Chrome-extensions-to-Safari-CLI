import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Regression, bisected live across six builds on Safari 26: the shim replaced an
// extension page's global `chrome`/`browser` with a Proxy so the storage relay could
// intercept sendMessage/onMessage. Safari then stopped delivering content-script
// messages to that page ENTIRELY — including to a listener registered on the pristine
// native event before the swap. Replacing `runtime.onMessage` in place turned out to be
// just as fatal, so Safari resolves delivery through those exact object identities at
// dispatch time.
//
// Nothing threw and nothing logged, so every converted extension whose content scripts
// message the background was silently broken (Cloaked's login tokens travel exactly that
// path). The relay may wrap `addListener`, but the global and the event object must keep
// their identities.

/** Model an extension page (background/popup) with identity-tracked API objects. */
function runShimOnExtensionPage({ freezeRuntime = false } = {}) {
  const timers = new Set();
  const nativeAdded = [];
  const onMessage = {
    addListener: (f) => nativeAdded.push(f),
    removeListener() {},
    hasListener: () => false,
  };
  const runtime = {
    id: "abc",
    lastError: null,
    getURL: (p) => "safari-web-extension://abc/" + p,
    getManifest: () => ({ manifest_version: 3 }),
    sendMessage: () => Promise.resolve(),
    onMessage,
    onConnect: { addListener() {}, removeListener() {}, hasListener: () => false },
    connect: () => ({ onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {}, disconnect() {} }),
  };
  const storageArea = {
    get: (_k, cb) => { if (typeof cb === "function") cb({}); return Promise.resolve({}); },
    set: (_o, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
    remove: (_k, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
  };
  // Safari's own shape when it hands out a frozen namespace: the object is
  // non-extensible, so neither assignment nor defineProperty lands on it.
  if (freezeRuntime) Object.freeze(runtime);
  const chrome = {
    runtime,
    storage: { local: storageArea, sync: storageArea, onChanged: { addListener() {}, removeListener() {} } },
    tabs: { query: () => Promise.resolve([]), onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const sandbox = {
    chrome, browser: chrome, console, Promise, JSON, Object, Array, Error, Date, Math,
    String, Number, Boolean, URL, Symbol, Proxy, Reflect, Map, Set, WeakMap, RegExp,
    TypeError, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    location: { href: "safari-web-extension://abc/background.html", protocol: "safari-web-extension:", pathname: "/background.html", search: "" },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {}, removeEventListener() {},
    document: { addEventListener() {}, removeEventListener() {} },
    setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); timers.add(h); return h; },
    clearTimeout: (h) => { timers.delete(h); clearTimeout(h); },
    setInterval: (fn, ms) => { const h = setInterval(fn, ms); timers.add(h); return h; },
    clearInterval: (h) => { timers.delete(h); clearInterval(h); },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource({ origin: "", hosts: [] }), sandbox, { filename: "safari-compat-shim.js" });

  const dispose = () => { for (const h of timers) { clearTimeout(h); clearInterval(h); } timers.clear(); };
  return { sandbox, chrome, runtime, onMessage, nativeAdded, dispose };
}

test("the extension page's global api object is not replaced", (t) => {
  const { sandbox, chrome, dispose } = runShimOnExtensionPage();
  t.after(dispose);
  assert.equal(sandbox.chrome, chrome, "swapping the global stops Safari delivering to this page");
  assert.equal(sandbox.browser, chrome, "same for browser");
});

test("runtime.onMessage keeps its identity", (t) => {
  const { chrome, onMessage, dispose } = runShimOnExtensionPage();
  t.after(dispose);
  assert.equal(chrome.runtime.onMessage, onMessage, "Safari dispatches through this exact object");
});

test("a listener still reaches Safari's native addListener", (t) => {
  const { chrome, nativeAdded, dispose } = runShimOnExtensionPage();
  t.after(dispose);
  const before = nativeAdded.length;
  chrome.runtime.onMessage.addListener(() => {});
  // Counted, not compared by reference: earlier shim blocks wrap a listener before
  // handing it on, so the native event legitimately receives a wrapper rather than the
  // caller's own function. What matters is that the registration reaches Safari at all —
  // a relay that only recorded it locally is what broke delivery in the first place.
  assert.equal(nativeAdded.length, before + 1, "the relay wrapper must forward to the native event");
});

// Safari hands some extensions a FROZEN chrome.runtime (the shim's getURL wrap has to
// work around it: on a frozen runtime both assignment and defineProperty fail). The
// relay then cannot patch runtime.sendMessage in place, and its fallback is the global
// swap this file exists to forbid. Measured across tags: the swap does happen on
// v1.7.0/v1.8.0 and stopped on v1.9.0 — but only the extensible shape was ever pinned by
// a test, so nothing stops it coming back for the frozen one, where the consequence is
// identical (Safari silently stops delivering content-script messages to the page).
test("a frozen runtime does not cost the page its delivery identities", (t) => {
  const { sandbox, chrome, onMessage, nativeAdded, dispose } = runShimOnExtensionPage({ freezeRuntime: true });
  t.after(dispose);
  assert.equal(sandbox.chrome, chrome, "global chrome swapped → content-script delivery dies");
  assert.equal(sandbox.browser, chrome, "same for browser");
  assert.equal(chrome.runtime.onMessage, onMessage, "Safari dispatches through this exact object");
  const before = nativeAdded.length;
  chrome.runtime.onMessage.addListener(() => {});
  assert.equal(nativeAdded.length, before + 1, "a listener must still reach the native event");
});
