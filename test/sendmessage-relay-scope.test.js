import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Transport by context:
//   Content scripts (http/https) → NATIVE runtime.sendMessage/onMessage, untouched. Safari
//     delivers a content script's native send to the background (and wakes it), and it only
//     works on the real, unwrapped chrome. The shim must NOT wrap a content script's
//     chrome or route it through the storage relay — doing so drops delivery and TWP's
//     translateHTML reply never arrives (the regression this pins).
//   Extension pages (popover/panel/options) → the storage relay, because Safari drops
//     native runtime messaging between an extension page and a suspended background.
//
// These tests run the real shim in a fake content-script vs extension-page context and
// observe which transport chrome.runtime.sendMessage actually uses.
function makeContext(protocol) {
  const nativeSends = []; // args passed to the NATIVE sendMessage
  const stored = {};      // storage.local backing map
  const timers = new Set();
  const href = protocol === "https:"
    ? "https://example.com/page"
    : "safari-web-extension://TEST/background.html";
  const nativeRuntime = {
    id: "test-ext",
    getURL: (p) => "safari-web-extension://TEST/" + String(p == null ? "" : p).replace(/^\//, ""),
    onMessage: { addListener() {}, removeListener() {}, hasListener() { return false; } },
    onConnect: { addListener() {}, removeListener() {}, hasListener() { return false; } },
    sendMessage() { nativeSends.push([].slice.call(arguments)); },
  };
  const sandbox = {
    console,
    // Tracked so the test can clear them: the shim's polling intervals otherwise keep the
    // test process alive forever after the assertions pass.
    setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); timers.add(h); return h; },
    clearTimeout: (h) => { timers.delete(h); clearTimeout(h); },
    setInterval: (fn, ms) => { const h = setInterval(fn, ms); timers.add(h); return h; },
    clearInterval: (h) => { timers.delete(h); clearInterval(h); },
    location: { href, origin: href.replace(/\/[^/]*$/, ""), protocol, pathname: protocol === "https:" ? "/page" : "/background.html" },
    navigator: { userAgent: "test" },
    Promise, Proxy, Date,
    chrome: {
      runtime: nativeRuntime,
      storage: {
        local: {
          get(keys, cb) { if (typeof keys === "function") { keys(Object.assign({}, stored)); return; } cb && cb(Object.assign({}, stored)); },
          set(o, cb) { for (var k in o) stored[k] = o[k]; cb && cb(); },
          remove(k) { [].concat(k).forEach((x) => { delete stored[x]; }); },
        },
        onChanged: { addListener() {}, removeListener() {} },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  const dispose = () => { for (const h of timers) { clearTimeout(h); clearInterval(h); } timers.clear(); };
  return { sandbox, nativeSends, stored, dispose };
}

/** The bundle's own sends, minus the shim's __c2sNav navigation pings. */
const appSends = (nativeSends) => nativeSends.filter((a) => !(a[0] && a[0].__c2sNav));

test("content-script context keeps NATIVE sendMessage (no storage relay, no Proxy)", (t) => {
  // The core regression: TWP's content script sends translateHTML and awaits the reply.
  // On https, the shim must leave chrome.runtime.sendMessage native and write NO relay
  // request — Safari delivers native content→bg fine, but a Proxy-wrapped/relayed send
  // silently drops it.
  const { sandbox, nativeSends, stored, dispose } = makeContext("https:");
  t.after(dispose);
  sandbox.chrome.runtime.sendMessage({ action: "translateHTML" }, () => {});
  const sends = appSends(nativeSends);
  assert.equal(sends.length, 1, "content-script send must use the native transport");
  assert.deepEqual(sends[0][0], { action: "translateHTML" });
  assert.ok(!Object.keys(stored).some((k) => k.indexOf("__c2sMbxReq:") === 0),
    "content-script send must NOT write a storage relay request");
});

test("extension-page context routes sendMessage through the storage relay", (t) => {
  const { sandbox, nativeSends, stored, dispose } = makeContext("safari-web-extension:");
  t.after(dispose);
  sandbox.chrome.runtime.sendMessage({ message: "ping" }, () => {});
  assert.equal(appSends(nativeSends).length, 0, "extension-page send must NOT use the native transport");
  assert.ok(Object.keys(stored).some((k) => k.indexOf("__c2sMbxReq:") === 0),
    "extension-page send must write a storage relay request");
});
