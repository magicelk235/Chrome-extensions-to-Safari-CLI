import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Regression: TWP - Translate Web Pages (issue #4). Safari's menus.create rejects
// documentUrlPatterns containing ftp:// ("'ftp://*/*' is not a valid pattern") and
// throws, aborting the caller. The shim wraps create to drop patterns Safari won't
// accept; ftp had been wrongly whitelisted, so it slipped through. It must be stripped.
function makeContext() {
  const created = [];
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { href: "safari-web-extension://TEST/background.html", origin: "safari-web-extension://TEST", pathname: "/background.html" },
    navigator: { userAgent: "test" },
    chrome: {
      runtime: {
        id: "test-ext",
        getURL: (p) => "safari-web-extension://TEST/" + String(p == null ? "" : p).replace(/^\//, ""),
        onMessage: { addListener() {}, removeListener() {}, hasListener() { return false; } },
        onConnect: { addListener() {}, removeListener() {}, hasListener() { return false; } },
        sendMessage() {},
      },
      contextMenus: {
        // Native create records what it actually received (after shim sanitization).
        create(props, cb) { created.push(props); if (typeof cb === "function") cb(); return 1; },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  return { sandbox, created };
}

test("menus.create strips ftp:// from documentUrlPatterns, keeps http/https/file", () => {
  const { sandbox, created } = makeContext();
  sandbox.chrome.contextMenus.create({
    id: "translate",
    documentUrlPatterns: ["http://*/*", "https://*/*", "file://*/*", "ftp://*/*"],
  });
  assert.equal(created.length, 1);
  const patterns = created[0].documentUrlPatterns;
  assert.ok(!patterns.includes("ftp://*/*"), "ftp:// must be stripped");
  assert.deepEqual(patterns, ["http://*/*", "https://*/*", "file://*/*"]);
});

test("menus.create drops documentUrlPatterns entirely when only ftp was present", () => {
  const { sandbox, created } = makeContext();
  sandbox.chrome.contextMenus.create({ id: "x", documentUrlPatterns: ["ftp://*/*"] });
  assert.equal(created.length, 1);
  // An empty array is itself invalid, so the key must be removed, not left as [].
  assert.equal(created[0].documentUrlPatterns, undefined);
});
