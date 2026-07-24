import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { wireActionClickBridge } from "../dist/runtime/shim.js";

function stage(files) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-acb-"));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

test("wires a synthetic popup when the action has no popup but the SW uses action.onClicked", () => {
  const dir = stage({ "bg.js": "chrome.action.onClicked.addListener(t => chrome.tabs.sendMessage(t.id, {}));" });
  const manifest = { manifest_version: 3, action: { default_title: "X" }, background: { service_worker: "bg.js" } };
  try {
    assert.equal(wireActionClickBridge(dir, manifest), true);
    assert.equal(manifest.action.default_popup, "__viaduct-action.html");
    assert.ok(existsSync(join(dir, "__viaduct-action.html")));
    assert.ok(existsSync(join(dir, "__viaduct-action.js")));
    // the popup wakes the background via getBackgroundPage and fires the click on it
    const js = readFileSync(join(dir, "__viaduct-action.js"), "utf-8");
    assert.match(js, /__viaductFireClick/);
    assert.match(js, /getBackgroundPage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does nothing when the action already has a real popup", () => {
  const dir = stage({ "bg.js": "chrome.action.onClicked.addListener(() => {});" });
  const manifest = { manifest_version: 3, action: { default_popup: "popup.html" }, background: { service_worker: "bg.js" } };
  try {
    assert.equal(wireActionClickBridge(dir, manifest), false);
    assert.equal(manifest.action.default_popup, "popup.html");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does nothing when the background never registers an action click handler", () => {
  const dir = stage({ "bg.js": "chrome.runtime.onMessage.addListener(() => {});" });
  const manifest = { manifest_version: 3, action: { default_title: "X" }, background: { service_worker: "bg.js" } };
  try {
    assert.equal(wireActionClickBridge(dir, manifest), false);
    assert.equal(manifest.action.default_popup, undefined);
    assert.ok(!existsSync(join(dir, "__viaduct-action.html")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handles MV2 browser_action + browserAction.onClicked", () => {
  const dir = stage({ "bg.js": "chrome.browserAction.onClicked.addListener(() => {});" });
  const manifest = { manifest_version: 2, browser_action: {}, background: { scripts: ["bg.js"] } };
  try {
    assert.equal(wireActionClickBridge(dir, manifest), true);
    assert.equal(manifest.browser_action.default_popup, "__viaduct-action.html");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does nothing when the background sets a real popup at runtime (TWP setPopup path)", () => {
  // TWP registers browserAction.onClicked but its handler is a no-op under default
  // config; the real UI is popup/popup.html, wired dynamically via setPopup at startup.
  // The bridge must not hijack a setPopup-driven button.
  const dir = stage({
    "bg.js": [
      'chrome.browserAction.setPopup({ popup: "popup/popup.html" });',
      "chrome.browserAction.onClicked.addListener((tab) => {",
      '  if (cfg.get("translateClickingOnce") === "yes") send(tab.id);',
      "});",
    ].join("\n"),
  });
  const manifest = { manifest_version: 2, browser_action: {}, background: { scripts: ["bg.js"] } };
  try {
    assert.equal(wireActionClickBridge(dir, manifest), false);
    assert.equal(manifest.browser_action.default_popup, undefined);
    assert.ok(!existsSync(join(dir, "__viaduct-action.html")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("still wires the bridge when setPopup only ever clears the popup", () => {
  // setPopup({popup:""}) disables the popup — the button is genuinely onClicked-driven,
  // so an empty-string setPopup must NOT be read as "has a popup".
  const dir = stage({
    "bg.js": [
      'chrome.action.setPopup({ popup: "" });',
      "chrome.action.onClicked.addListener((t) => chrome.tabs.sendMessage(t.id, {}));",
    ].join("\n"),
  });
  const manifest = { manifest_version: 3, action: { default_title: "X" }, background: { service_worker: "bg.js" } };
  try {
    assert.equal(wireActionClickBridge(dir, manifest), true);
    assert.equal(manifest.action.default_popup, "__viaduct-action.html");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setPopup opt-out survives a shim script (onClicked+action, no setPopup) listed before background.js", () => {
  // viaduct prepends its own shim to background.scripts; the shim mentions onClicked and
  // action but never setPopup. The detector must not short-circuit true on that file and
  // must still honor the real setPopup in the extension's own background.js.
  const dir = stage({
    "safari-compat-shim.js": "chrome.action.onClicked; var x = browserAction;",
    "bg.js": 'chrome.browserAction.setPopup({ popup: "popup/popup.html" });\nchrome.browserAction.onClicked.addListener(() => {});',
  });
  const manifest = {
    manifest_version: 2,
    browser_action: {},
    background: { scripts: ["safari-compat-shim.js", "bg.js"] },
  };
  try {
    assert.equal(wireActionClickBridge(dir, manifest), false);
    assert.equal(manifest.browser_action.default_popup, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
