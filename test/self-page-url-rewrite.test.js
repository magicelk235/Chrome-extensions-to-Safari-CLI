import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rewriteSelfPageExtensionUrls } from "../dist/input/stage.js";

function stage(files) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-selfpage-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

// Regression: Salesforce Inspector Reloaded background.js — keyboard-command page opens.
// `chrome-extension://${@@extension_id}/foo.html` is a self-page nav that must become
// runtime.getURL or it opens a dead tab in Safari (wrong scheme + wrong host).
test("rewrites a full-URL chrome-extension://${@@extension_id}/... literal to runtime.getURL", () => {
  const dir = stage({
    "bg.js": 'chrome.tabs.create({url: `chrome-extension://${chrome.i18n.getMessage("@@extension_id")}/${command}.html?host=${sfHost}`});',
  });
  assert.equal(rewriteSelfPageExtensionUrls(dir), 1);
  assert.equal(
    readFileSync(join(dir, "bg.js"), "utf-8"),
    'chrome.tabs.create({url: chrome.runtime.getURL(`${command}.html?host=${sfHost}`)});'
  );
  rmSync(dir, { recursive: true, force: true });
});

test("also handles chrome.runtime.id as the host expression", () => {
  const dir = stage({
    "a.js": 'window.open(`chrome-extension://${chrome.runtime.id}/panel.html`);',
  });
  assert.equal(rewriteSelfPageExtensionUrls(dir), 1);
  assert.equal(
    readFileSync(join(dir, "a.js"), "utf-8"),
    'window.open(chrome.runtime.getURL(`panel.html`));'
  );
  rmSync(dir, { recursive: true, force: true });
});

// The critical safety case: an OAuth redirect_uri embedded mid-string inside a larger
// authorize URL must NOT be rewritten — it's a server-registered token, and rewriting it
// breaks login. It differs because (a) the scheme is interpolated (${browser}-extension),
// and (b) it isn't at the start of the template literal.
test("does NOT rewrite an embedded OAuth redirect_uri (interpolated scheme, mid-string)", () => {
  const src = 'const url = `https://${sfHost}/services/oauth2/authorize?response_type=token&redirect_uri=${browser}-extension://${chrome.i18n.getMessage("@@extension_id")}/data-export.html`;';
  const dir = stage({ "oauth.js": src });
  assert.equal(rewriteSelfPageExtensionUrls(dir), 0);
  assert.equal(readFileSync(join(dir, "oauth.js"), "utf-8"), src);
  rmSync(dir, { recursive: true, force: true });
});

// A literal chrome-extension:// redirect embedded after redirect_uri= (not the whole URL)
// also must not match — the backtick doesn't immediately precede the scheme.
test("does NOT rewrite a chrome-extension:// that is embedded, not the whole literal", () => {
  const src = 'const u = `https://x.test/auth?redirect_uri=chrome-extension://${chrome.runtime.id}/cb.html`;';
  const dir = stage({ "b.js": src });
  assert.equal(rewriteSelfPageExtensionUrls(dir), 0);
  assert.equal(readFileSync(join(dir, "b.js"), "utf-8"), src);
  rmSync(dir, { recursive: true, force: true });
});
