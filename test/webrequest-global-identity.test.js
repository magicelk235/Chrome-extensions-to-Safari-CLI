import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Regression: TWP - Translate Web Pages 10.2.5 (MV3). WebKit re-derives the message
// dispatch namespace from the page's global `browser`/`chrome` at EVERY dispatch
// (enumerateFramesAndNamespaceObjects) with a cast that only succeeds on the native
// namespace wrapper. The webRequest url-sanitizer used to republish global
// chrome/browser as Object.create(native) roots when Safari's exotic root refused
// the webRequest slot override — which silently killed all native runtime message
// delivery to that context: listeners stayed registered, the sender's callback
// resolved undefined with no lastError, and the background never received a
// content script's translateHTML. The shim must NEVER replace the global roots;
// it sanitizes by patching addListener on the event instance, or on the shared
// event prototype when the instance is frozen.

function makeContext() {
  const registered = [];

  // Shared event prototype, like WebKit's wrapper prototypes.
  const eventProto = {
    addListener(cb, filter) { registered.push({ event: this.__name, filter }); },
    removeListener() {},
    hasListener() { return false; },
  };
  const makeFrozenEvent = (name) => {
    const ev = Object.create(eventProto);
    Object.defineProperty(ev, "__name", { value: name });
    return Object.freeze(ev); // instance-level addListener override cannot take
  };

  const webRequest = {};
  for (const name of ["onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders",
    "onHeadersReceived", "onAuthRequired", "onResponseStarted",
    "onBeforeRedirect", "onCompleted", "onErrorOccurred", "onActionIgnored"]) {
    webRequest[name] = makeFrozenEvent(name);
  }
  webRequest.handlerBehaviorChanged = (cb) => { if (typeof cb === "function") cb(); };
  webRequest.MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES = 20;

  const realChrome = {
    runtime: {
      id: "test-ext",
      getURL: (p) => "safari-web-extension://TEST/" + String(p == null ? "" : p).replace(/^\//, ""),
      onMessage: { addListener() {}, removeListener() {}, hasListener() { return false; } },
      onConnect: { addListener() {}, removeListener() {}, hasListener() { return false; } },
      sendMessage() {},
    },
    webRequest,
  };

  // Safari's root is a WebKit exotic: assignment and defineProperty on the
  // webRequest slot "succeed" but change nothing. Emulate that so the shim's
  // installOverride fails exactly the way it does live.
  const chromeProxy = new Proxy(realChrome, {
    set(target, key, value) {
      if (key === "webRequest") return true; // silently ignored
      target[key] = value;
      return true;
    },
    defineProperty(target, key, descriptor) {
      if (key === "webRequest") return true; // claims success, keeps old value
      Object.defineProperty(target, key, descriptor);
      return true;
    },
  });

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { href: "safari-web-extension://TEST/background.html", origin: "safari-web-extension://TEST", pathname: "/background.html" },
    navigator: { userAgent: "test" },
    chrome: chromeProxy,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  return { sandbox, chromeProxy, eventProto, registered };
}

test("global chrome keeps its identity when the webRequest slot refuses overrides", () => {
  const { sandbox, chromeProxy } = makeContext();
  assert.equal(sandbox.chrome, chromeProxy,
    "the shim must never republish global chrome; WebKit resolves message dispatch through it");
});

test("webRequest urls are still sanitized via the event prototype on frozen instances", () => {
  const { sandbox, registered } = makeContext();
  sandbox.chrome.webRequest.onBeforeRequest.addListener(() => {}, {
    urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"],
  });
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0].filter.urls, ["http://*/*", "https://*/*"],
    "ws/wss must be stripped before reaching the native addListener");
});

test("a filter left with no parseable urls registers nothing", () => {
  const { sandbox, registered } = makeContext();
  sandbox.chrome.webRequest.onHeadersReceived.addListener(() => {}, { urls: ["ws://*/*"] });
  assert.equal(registered.length, 0);
});
