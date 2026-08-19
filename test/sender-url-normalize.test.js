import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Safari appends `?tabId=<n>` to the popup's sender.url (live-proven: Dark Reader on
// Safari 18 sends some popup messages bare and others with ?tabId). Bundles allow-list
// their own pages by EXACT-matching sender.url against getURL(path), which has no query,
// so the ?tabId message is silently dropped → popup RPC hangs → dead buttons. The shim's
// onMessage wrapper must hand the listener a sender whose url has the query/fragment
// stripped, so getURL(path) === sender.url succeeds.
// The shim wraps onMessage.addListener: when the bundle registers its listener, the
// shim's addListener stores a WRAPPER with the native addListener. We capture that
// wrapper (nativeWrappers[]) so we can invoke it exactly as Safari would, with a raw
// sender, and observe the sender the bundle's listener actually receives.
function makeContext() {
  const nativeWrappers = [];
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { href: "safari-web-extension://TEST/background.html", origin: "safari-web-extension://TEST", pathname: "/background.html" },
    navigator: { userAgent: "test" },
    chrome: {
      runtime: {
        id: "test-ext",
        getURL: (p) => "safari-web-extension://TEST/" + String(p == null ? "" : p).replace(/^\//, ""),
        onMessage: {
          // configurable but not writable, like Safari's real native event — forces the
          // shim's installOverride to use defineProperty (the code path we ship).
          addListener(fn) { nativeWrappers.push(fn); },
          removeListener() {},
          hasListener() { return false; },
        },
        onConnect: { addListener() {}, removeListener() {}, hasListener() { return false; } },
        sendMessage() {},
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  return { sandbox, nativeWrappers };
}

// Register `listener` through the (now shim-wrapped) addListener, then return the wrapper
// the shim handed to the native event — calling it mirrors Safari delivering a message.
function register(sandbox, nativeWrappers, listener) {
  const before = nativeWrappers.length;
  sandbox.chrome.runtime.onMessage.addListener(listener);
  assert.ok(nativeWrappers.length > before, "shim must forward the listener to native addListener");
  return nativeWrappers[nativeWrappers.length - 1];
}

test("popup sender.url ?tabId query is stripped so exact allow-lists match", () => {
  const { sandbox, nativeWrappers } = makeContext();
  const allow = [sandbox.chrome.runtime.getURL("/ui/popup/index.html")];
  let sawUrl = null, inAllowList = null;
  const wrapper = register(sandbox, nativeWrappers, (msg, sender) => {
    sawUrl = sender && sender.url;
    inAllowList = allow.indexOf(sender && sender.url) >= 0;
  });
  wrapper({ type: "ui-bg-get-data" }, { url: "safari-web-extension://TEST/ui/popup/index.html?tabId=188", origin: "safari-web-extension://TEST" }, () => {});
  assert.equal(sawUrl, "safari-web-extension://TEST/ui/popup/index.html", "query must be stripped");
  assert.equal(inAllowList, true, "stripped url must match the getURL allow-list entry");
});

test("bare popup sender.url and web-page senders are left untouched", () => {
  const { sandbox, nativeWrappers } = makeContext();
  const seen = [];
  const wrapper = register(sandbox, nativeWrappers, (msg, sender) => { seen.push(sender && sender.url); });
  wrapper({ type: "x" }, { url: "safari-web-extension://TEST/ui/popup/index.html", origin: "safari-web-extension://TEST" }, () => {});
  wrapper({ type: "y" }, { url: "https://example.com/page?q=1", origin: "https://example.com", tab: { id: 5 } }, () => {});
  assert.equal(seen[0], "safari-web-extension://TEST/ui/popup/index.html", "already-bare ext url unchanged");
  assert.equal(seen[1], "https://example.com/page?q=1", "web-page sender.url must NOT be stripped");
});
