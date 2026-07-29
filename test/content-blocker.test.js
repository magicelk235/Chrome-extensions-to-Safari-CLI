import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanExtension } from "../dist/analyze/analyze.js";

// Write a manifest (and optional extra files) to a temp dir and scan it.
function scan(manifest, extraFiles = {}) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-cb-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(extraFiles)) writeFileSync(join(dir, name), content);
  try {
    return scanExtension(dir, manifest, "all");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cb = (issues) => issues.find((i) => i.category === "content-blocker");

test("fires on a uBO-shaped MV2 blocking-webRequest manifest", () => {
  const issues = scan({
    manifest_version: 2,
    name: "uBlock Origin",
    version: "1.72.2",
    permissions: ["storage", "webRequest", "webRequestBlocking", "<all_urls>"],
  });
  const issue = cb(issues);
  assert.ok(issue, "content-blocker issue expected");
  assert.equal(issue.severity, "error");
  assert.equal(issue.file, "manifest.json");
  assert.match(issue.fix, /uBlock Origin Lite|declarativeNetRequest/);
});

test("does NOT fire on uBO-Lite (declares DNR)", () => {
  const issues = scan({
    manifest_version: 3,
    name: "uBO Lite",
    version: "1.0",
    permissions: ["declarativeNetRequest", "storage"],
    host_permissions: ["<all_urls>"],
    declarative_net_request: { rule_resources: [{ id: "r", enabled: true, path: "r.json" }] },
  });
  assert.equal(cb(issues), undefined);
});

test("does NOT fire on a narrow-host password-manager style manifest", () => {
  const issues = scan({
    manifest_version: 2,
    name: "PwMgr",
    version: "1.0",
    permissions: ["storage", "webRequest", "webRequestBlocking", "https://vault.example.com/*"],
  });
  assert.equal(cb(issues), undefined);
});

test("does NOT fire on a plain extension with no webRequestBlocking", () => {
  const issues = scan({
    manifest_version: 3,
    name: "Plain",
    version: "1.0",
    permissions: ["storage"],
    host_permissions: ["<all_urls>"],
  });
  assert.equal(cb(issues), undefined);
});

test("fires when broad host comes from content_scripts matches (MV3, no host_permissions)", () => {
  const issues = scan(
    {
      manifest_version: 3,
      name: "Blocker",
      version: "1.0",
      permissions: ["webRequestBlocking"],
      content_scripts: [{ js: ["cs.js"], matches: ["https://*/*"] }],
    },
    { "cs.js": "// content script" }
  );
  assert.ok(cb(issues), "content-blocker issue expected from content_scripts matches");
});

test("does NOT fire on a userscript manager that drives DNR dynamically", () => {
  const issues = scan({
    manifest_version: 3,
    name: "Tampermonkey",
    version: "5.5.0",
    permissions: [
      "webRequest",
      "webRequestBlocking",
      "declarativeNetRequestWithHostAccess",
      "scripting",
      "userScripts",
    ],
    host_permissions: ["<all_urls>"],
  });
  assert.equal(cb(issues), undefined);
});
