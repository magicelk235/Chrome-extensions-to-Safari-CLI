import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Safari hands onConnect listeners a Port whose `sender` is a read-only exotic getter
// (a fresh object per read), so the shim's corrected sender clone can't be assigned onto
// the native port. Bundles privilege-gate their own pages at CONNECT time on exactly that
// sender:
//
//   uBlock: privileged = origin !== undefined ? origin === PRIVILEGED_ORIGIN
//                                             : url.startsWith(PRIVILEGED_ORIGIN);
//   with PRIVILEGED_ORIGIN = vAPI.getURL('').slice(0, -1)
//
// getURL("") is lowercased (see geturl-host-case.test.js) while Safari's sender.url keeps
// the UPPERCASE UUID host, so the url fallback can never pass — only the origin branch can,
// and only if the port's sender carries the canonical origin. The shim tries the native
// port in place first (assignment, then defineProperty), and when the slot is read-only it
// hands the listener a memoized wrapper that differs from the native port in `sender` alone.

const UPPER = "safari-web-extension://E3AEF829-D4B2-4F9F-8CCA-AA2D0F1CD13A";

function fakeEvent() {
  const fns = [];
  return {
    addListener(fn) { fns.push(fn); },
    removeListener(fn) { const i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
    hasListener(fn) { return fns.includes(fn); },
    emit(...args) { for (const fn of [...fns]) fn(...args); },
    size() { return fns.length; },
  };
}

// A Port shaped like Safari's: `sender` is a read-only accessor returning a FRESH object
// on every read (so an in-place write can't stick and can't be verified), everything else
// records what reaches the native object.
function fakePort(name, senderProps) {
  const port = {
    name,
    posted: [],
    disconnected: false,
    onMessage: fakeEvent(),
    onDisconnect: fakeEvent(),
    postMessage(m) { port.posted.push(m); },
    disconnect() { port.disconnected = true; },
  };
  Object.defineProperty(port, "sender", {
    get() { return { ...senderProps }; },
    enumerable: true,
    // configurable defaults to false — defineProperty on the slot throws, like Safari.
  });
  return port;
}

function runShim(href) {
  const timers = new Set();
  const url = new URL(href);
  const nativeConnectListeners = [];
  const area = {
    get: (_k, cb) => { if (typeof cb === "function") cb({}); return Promise.resolve({}); },
    set: (_o, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
    remove: (_k, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
  };
  const chrome = {
    runtime: {
      id: "com.viaduct.Test.Extension",
      lastError: null,
      // Safari's own casing: the real host, exactly as it appears in location.href.
      getURL: (p) => UPPER + "/" + String(p == null ? "" : p).replace(/^\.?\//, ""),
      getManifest: () => ({ manifest_version: 3 }),
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener() {}, removeListener() {}, hasListener: () => false },
      onConnect: {
        addListener(fn) { nativeConnectListeners.push(fn); },
        removeListener(fn) { const i = nativeConnectListeners.indexOf(fn); if (i >= 0) nativeConnectListeners.splice(i, 1); },
        hasListener: (fn) => nativeConnectListeners.includes(fn),
      },
      connect: () => ({ onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {}, disconnect() {} }),
    },
    storage: { local: area, sync: area, onChanged: { addListener() {}, removeListener() {} } },
    tabs: { query: () => Promise.resolve([]), onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const sandbox = {
    chrome, browser: chrome, console, Promise, JSON, Object, Array, Error, Date, Math,
    String, Number, Boolean, URL, URLSearchParams, Symbol, Proxy, Reflect, Map, Set,
    WeakMap, RegExp, TypeError, isNaN, parseInt, parseFloat, encodeURIComponent,
    decodeURIComponent,
    location: { href, protocol: url.protocol, origin: url.origin, pathname: url.pathname, search: url.search },
    navigator: { userAgent: "test" },
    history: { state: null, pushState() {}, replaceState() {} },
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

  // The shim registers onConnect listeners of its own (panel port, keepalives, sw bridge);
  // drive them all, like a real dispatch would, but let none of them sink the test.
  const dispatch = (port) => {
    for (const fn of [...nativeConnectListeners]) { try { fn(port); } catch (e) {} }
  };
  const dispose = () => { for (const h of timers) { clearTimeout(h); clearInterval(h); } timers.clear(); };
  return { sandbox, chrome, dispatch, dispose };
}

test("a port sender with NO origin gets the canonical origin, so uBlock's privilege gate passes", (t) => {
  const { chrome, dispatch, dispose } = runShim(UPPER + "/background.html");
  t.after(dispose);

  let delivered = null;
  chrome.runtime.onConnect.addListener((port) => { delivered = port; });
  dispatch(fakePort("popupPanel", { url: UPPER + "/popup.html", frameId: 0 }));

  assert.ok(delivered, "the listener must be called");
  const PRIVILEGED_ORIGIN = chrome.runtime.getURL("").slice(0, -1);
  const { origin, url } = delivered.sender;
  assert.equal(origin, PRIVILEGED_ORIGIN,
    "must equal getURL('').slice(0,-1) — uBlock gates its popup on exactly that");
  // uBlock's gate, verbatim — the whole point of the fix.
  const privileged = origin !== undefined
    ? origin === PRIVILEGED_ORIGIN
    : url.startsWith(PRIVILEGED_ORIGIN);
  assert.equal(privileged, true, "onPortConnect must classify our own page as privileged");
});

test("a port sender with an UPPERCASE origin is aligned to the canonical origin", (t) => {
  const { chrome, dispatch, dispose } = runShim(UPPER + "/background.html");
  t.after(dispose);

  let delivered = null;
  chrome.runtime.onConnect.addListener((port) => { delivered = port; });
  dispatch(fakePort("popupPanel", { url: UPPER + "/popup.html", frameId: 0, origin: UPPER }));

  assert.ok(delivered, "the listener must be called");
  assert.equal(delivered.sender.origin, chrome.runtime.getURL("").slice(0, -1));
});

test("port.sender = undefined must not throw (uBlock clears it from a strict-mode module)", (t) => {
  const { chrome, dispatch, dispose } = runShim(UPPER + "/background.html");
  t.after(dispose);

  let delivered = null;
  chrome.runtime.onConnect.addListener((port) => { delivered = port; });
  dispatch(fakePort("popupPanel", { url: UPPER + "/popup.html", frameId: 0 }));

  assert.ok(delivered);
  // This test file is a module, so the assignment below runs in strict mode — a
  // writable:false slot would throw here, exactly as it would inside onPortConnect.
  delivered.sender = undefined;
  assert.equal(delivered.sender, undefined);
});

test("name is preserved and postMessage/disconnect reach the native port", (t) => {
  const { chrome, dispatch, dispose } = runShim(UPPER + "/background.html");
  t.after(dispose);

  let delivered = null;
  chrome.runtime.onConnect.addListener((port) => { delivered = port; });
  const native = fakePort("popupPanel", { url: UPPER + "/popup.html", frameId: 0 });
  dispatch(native);

  assert.ok(delivered);
  assert.equal(delivered.name, "popupPanel", "uBlock keys its ports Map by port.name");
  delivered.postMessage({ what: "getPopupData" });
  assert.deepEqual(native.posted, [{ what: "getPopupData" }]);
  delivered.disconnect();
  assert.equal(native.disconnected, true);
});

test("onMessage/onDisconnect hand back the SAME object onConnect delivered, and removeListener unsubscribes", (t) => {
  const { chrome, dispatch, dispose } = runShim(UPPER + "/background.html");
  t.after(dispose);

  let delivered = null;
  chrome.runtime.onConnect.addListener((port) => { delivered = port; });
  const native = fakePort("popupPanel", { url: UPPER + "/popup.html", frameId: 0 });
  dispatch(native);
  assert.ok(delivered);

  const msgs = [];
  const onMsg = (m, p) => { msgs.push([m, p]); };
  delivered.onMessage.addListener(onMsg);
  native.onMessage.emit({ n: 1 }, native);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0][0].n, 1);
  assert.equal(msgs[0][1], delivered,
    "the port argument must be identical to what onConnect delivered (Map/indexOf bookkeeping)");

  delivered.onMessage.removeListener(onMsg);
  native.onMessage.emit({ n: 2 }, native);
  assert.equal(msgs.length, 1, "removeListener must unsubscribe the caller's original reference");

  let gone = null;
  delivered.onDisconnect.addListener((p) => { gone = p; });
  native.onDisconnect.emit(native);
  assert.equal(gone, delivered, "onDisconnect's port must be the delivered object too");
});

test("two onConnect listeners receive the same object for one native port (no double-wrap)", (t) => {
  const { chrome, dispatch, dispose } = runShim(UPPER + "/background.html");
  t.after(dispose);

  let first = null, second = null;
  chrome.runtime.onConnect.addListener((port) => { first = port; });
  chrome.runtime.onConnect.addListener((port) => { second = port; });
  dispatch(fakePort("popupPanel", { url: UPPER + "/popup.html", frameId: 0 }));

  assert.ok(first && second);
  assert.equal(first, second, "one dispatch, one object — memoized per native port");
});

test("a content-script port passes through NATIVE and untouched — no synthesized origin", (t) => {
  const { chrome, dispatch, dispose } = runShim(UPPER + "/background.html");
  t.after(dispose);

  let delivered = null;
  chrome.runtime.onConnect.addListener((port) => { delivered = port; });
  const native = fakePort("contentScript", {
    url: "https://example.com/p",
    origin: "https://example.com",
    frameId: 0,
    tab: { id: 7, url: "https://example.com/p" },
  });
  dispatch(native);

  assert.equal(delivered, native,
    "an http(s) sender must get the native port — wrapping it would be pure overhead");
  assert.equal(delivered.sender.origin, "https://example.com",
    "a web page must NEVER be handed the extension origin — that would be privilege escalation");
  assert.equal(delivered.sender.url, "https://example.com/p");
});
