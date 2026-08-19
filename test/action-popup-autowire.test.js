import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { transformManifest } from "../dist/manifest/manifest.js";

function stage(files) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-autowire-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

const OPTS = { keepModuleBackground: false };

// Regression: Salesforce Inspector Reloaded. Its UI is a content-script-injected iframe
// (popup.html is a web_accessible_resource), and the toolbar button is driven by
// action.onClicked in the background. The auto-wire used to grab popup.html as
// default_popup, hijacking the click into an orphan popover that never initialized
// (empty gray box) and suppressing the onClicked bridge. It must now leave default_popup
// unset so wireActionClickBridge can replay the real click.
test("does NOT auto-wire popup.html when the background registers action.onClicked", () => {
  const dir = stage({
    "popup.html": "<!doctype html><div id=root></div>",
    "background.js": 'chrome.action.onClicked.addListener(() => chrome.runtime.sendMessage({msg:"open-popup"}));',
  });
  try {
    const out = transformManifest(
      { manifest_version: 3, action: { default_title: "Open popup" }, background: { service_worker: "background.js" } },
      [],
      dir,
      OPTS,
    );
    assert.equal(out.action?.default_popup, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("still auto-wires popup.html when the toolbar button has no onClicked behavior", () => {
  const dir = stage({
    "popup.html": "<!doctype html><div id=root></div>",
    "background.js": "chrome.runtime.onInstalled.addListener(() => {});",
  });
  try {
    const out = transformManifest(
      { manifest_version: 3, action: { default_title: "X" }, background: { service_worker: "background.js" } },
      [],
      dir,
      OPTS,
    );
    assert.equal(out.action?.default_popup, "popup.html");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an author-declared default_popup is always preserved, onClicked or not", () => {
  const dir = stage({
    "mypopup.html": "<!doctype html>",
    "background.js": "chrome.action.onClicked.addListener(() => {});",
  });
  try {
    const out = transformManifest(
      { manifest_version: 3, action: { default_popup: "mypopup.html" }, background: { service_worker: "background.js" } },
      [],
      dir,
      OPTS,
    );
    assert.equal(out.action?.default_popup, "mypopup.html");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
