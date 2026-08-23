import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Regression: uBlock Origin 1.71.0 strict blocker on Safari. WebKit's webRequest
// delivers SUBFRAME document loads with type "main_frame" and a raw 64-bit
// FrameIdentifier as frameId (live probe: {type:'main_frame', frameId:30064771073,
// parentFrameId:4294967298}); Chrome's main_frame ALWAYS has frameId 0. Bundles
// that gate top-level-navigation logic on type === 'main_frame' therefore hijack
// the tab for every ad iframe — uBlock's strict-block interstitial replaced the
// page on w3schools when an ad frame navigated. The shim's webRequest sanitizer
// must hand listeners type 'sub_frame' for the impossible-in-Chrome shape
// (main_frame + nonzero frameId) on a shallow clone, never mutate Safari's native
// details object, and keep object identity for everything Chrome-shaped.

function makeContext({ frozen = true } = {}) {
  const registered = [];
  const removed = [];

  // Shared event prototype, like WebKit's wrapper prototypes.
  const eventProto = {
    addListener(cb, filter) { registered.push({ event: this.__name, filter, listener: cb }); },
    removeListener(cb) { removed.push({ event: this.__name, listener: cb }); },
    hasListener(cb) { return registered.some((r) => r.listener === cb); },
  };
  const makeEvent = (name) => {
    const ev = Object.create(eventProto);
    Object.defineProperty(ev, "__name", { value: name });
    // frozen: instance-level override cannot take → shim patches the prototype,
    // the path live Safari forces. Unfrozen exercises the instance path.
    return frozen ? Object.freeze(ev) : ev;
  };

  const webRequest = {};
  for (const name of ["onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders",
    "onHeadersReceived", "onAuthRequired", "onResponseStarted",
    "onBeforeRedirect", "onCompleted", "onErrorOccurred", "onActionIgnored"]) {
    webRequest[name] = makeEvent(name);
  }
  webRequest.handlerBehaviorChanged = (cb) => { if (typeof cb === "function") cb(); };
  webRequest.MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES = 20;

  const chrome = {
    runtime: {
      id: "test-ext",
      getURL: (p) => "safari-web-extension://TEST/" + String(p == null ? "" : p).replace(/^\//, ""),
      onMessage: { addListener() {}, removeListener() {}, hasListener() { return false; } },
      onConnect: { addListener() {}, removeListener() {}, hasListener() { return false; } },
      sendMessage() {},
    },
    webRequest,
  };

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { href: "safari-web-extension://TEST/background.html", origin: "safari-web-extension://TEST", pathname: "/background.html" },
    navigator: { userAgent: "test" },
    chrome,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  return { sandbox, registered, removed };
}

// What Safari hands the wrapper at dispatch for an ad iframe's document load,
// verbatim from the live probe.
const safariIframeLoad = () => ({
  type: "main_frame",
  frameId: 30064771073,
  parentFrameId: 4294967298,
  url: "https://ads.example/frame.html",
  tabId: 50,
});

test("Safari's mislabeled iframe load reaches the listener as sub_frame on a clone", () => {
  const { sandbox, registered } = makeContext();
  let seen;
  sandbox.chrome.webRequest.onBeforeRequest.addListener((d) => { seen = d; return { cancel: true }; },
    { urls: ["<all_urls>"] });
  assert.equal(registered.length, 1);

  const native = safariIframeLoad();
  const ret = registered[0].listener(native);
  assert.equal(seen.type, "sub_frame", "main_frame + nonzero frameId is Chrome-impossible; must normalize");
  assert.equal(seen.frameId, 30064771073);
  assert.equal(seen.parentFrameId, 4294967298, "parentFrameId passes through as Safari gave it");
  assert.equal(seen.url, "https://ads.example/frame.html");
  assert.equal(seen.tabId, 50);
  assert.notEqual(seen, native, "listener must get a clone, not the native object");
  assert.equal(native.type, "main_frame", "Safari's native details object must never be mutated");
  assert.deepEqual(ret, { cancel: true }, "blocking return value must propagate");
});

test("a true top-level load passes through untouched with identity preserved", () => {
  const { sandbox, registered } = makeContext();
  let seen;
  sandbox.chrome.webRequest.onCompleted.addListener((d) => { seen = d; }, { urls: ["<all_urls>"] });

  const native = { type: "main_frame", frameId: 0, parentFrameId: -1, url: "https://example.com/", tabId: 50 };
  registered[0].listener(native);
  assert.equal(seen, native, "frameId 0 is the common case; object identity must survive");
  assert.equal(seen.type, "main_frame");
});

test("non-main_frame details are untouched", () => {
  const { sandbox, registered } = makeContext();
  let seen;
  sandbox.chrome.webRequest.onBeforeRequest.addListener((d) => { seen = d; }, { urls: ["<all_urls>"] });

  const native = { type: "script", frameId: 0, url: "https://example.com/a.js", tabId: 50 };
  registered[0].listener(native);
  assert.equal(seen, native);
  assert.equal(seen.type, "script");
});

test("normalization also applies on the unfrozen instance path, filter or not", () => {
  const { sandbox, registered } = makeContext({ frozen: false });
  let seen;
  sandbox.chrome.webRequest.onErrorOccurred.addListener((d) => { seen = d; });

  registered[0].listener(safariIframeLoad());
  assert.equal(seen.type, "sub_frame");
});

test("removeListener resolves the bundle's function to the registered wrapper", () => {
  const { sandbox, registered, removed } = makeContext();
  const cb = () => {};
  sandbox.chrome.webRequest.onBeforeRequest.addListener(cb, { urls: ["<all_urls>"] });
  assert.notEqual(registered[0].listener, cb, "the native event holds the shim's wrapper");
  sandbox.chrome.webRequest.onBeforeRequest.removeListener(cb);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].listener, registered[0].listener,
    "removeListener must translate to the wrapper or removal silently no-ops");
});

// The sanitizer's pre-existing job must survive the extension: url filters are
// still stripped to the parseable subset (mirrors webrequest-global-identity).
test("url filter sanitization still works alongside frame-type normalization", () => {
  const { sandbox, registered } = makeContext();
  sandbox.chrome.webRequest.onBeforeRequest.addListener(() => {}, {
    urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"],
  });
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0].filter.urls, ["http://*/*", "https://*/*"],
    "ws/wss must be stripped before reaching the native addListener");

  sandbox.chrome.webRequest.onHeadersReceived.addListener(() => {}, { urls: ["ws://*/*"] });
  assert.equal(registered.length, 1, "a filter left with no parseable urls registers nothing");
});
