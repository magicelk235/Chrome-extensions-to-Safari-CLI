import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Regression: SuperDev Pro's Cmd+Shift+S sidebar toggle did nothing after conversion.
// viaduct wired the in-page hotkey (__viaduct-hotkey.js) correctly, but the shim only
// captured the content script's runtime.onMessage listeners when it believed a hotkey
// was wired — a belief it derived from getManifest().content_scripts. Safari strips
// content_scripts from getManifest() inside a content script, so that check read false,
// the capture never installed, and the hotkey replayed TOGGLE_SHELL to an empty list.
//
// Model a content-script context: no chrome.tabs.query, window present, and a
// getManifest() that (like Safari) omits content_scripts. The listener a content script
// registers after the shim runs must still land in self.__viaductMsgListeners.
function installContentScript() {
  const onMessageListeners = [];
  const chrome = {
    // No chrome.tabs at all → the shim treats this as a content-script context.
    runtime: {
      id: "test-ext",
      lastError: undefined,
      getURL: (p) => "safari-web-extension://TEST/" + String(p ?? ""),
      // Safari's content-script getManifest(): no content_scripts, no background.
      getManifest: () => ({ manifest_version: 3, action: {} }),
      onMessage: {
        addListener(fn) { onMessageListeners.push(fn); },
        removeListener(fn) { const i = onMessageListeners.indexOf(fn); if (i >= 0) onMessageListeners.splice(i, 1); },
      },
      sendMessage() {},
      connect() { return { onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {}, disconnect() {} }; },
      onConnect: { addListener() {} },
    },
    storage: { local: { set() {}, get(_k, cb) { cb && cb({}); } } },
  };
  const sandbox = { chrome, console, setTimeout, clearTimeout, Promise };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  return { chrome, sandbox, onMessageListeners };
}

test("shim captures content-script onMessage listeners even when getManifest() omits content_scripts", () => {
  const { chrome, sandbox } = installContentScript();

  // A content script registers its message listener AFTER the shim has run (real order:
  // shim is prepended ahead of the bundle's content scripts).
  let sawToggle = false;
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "TOGGLE_SHELL") sawToggle = true;
  });

  const captured = sandbox.self.__viaductMsgListeners;
  assert.ok(Array.isArray(captured), "__viaductMsgListeners must be installed in a content-script context");
  assert.equal(captured.length, 1, "the content script's listener must be captured");

  // Replaying the action message (what __viaduct-hotkey.js does) must reach it.
  captured[0]({ type: "TOGGLE_SHELL" }, { id: "test-ext" }, () => {});
  assert.ok(sawToggle, "replayed TOGGLE_SHELL must invoke the captured listener");
});
