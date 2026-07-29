import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { transformManifest, analyzeManifest } from "../dist/manifest/manifest.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "viaduct-scheme-"));
}

// Regression: Tampermonkey's manifest carries "chrome://favicon/" in permissions.
// Left in place Safari rejects the whole manifest and never loads the extension.
test("transform strips a chrome:// scheme URL from permissions", () => {
  const dir = tmp();
  try {
    const out = transformManifest(
      {
        manifest_version: 3,
        permissions: ["tabs", "storage", "chrome://favicon/", "scripting"],
      },
      [],
      dir,
      { keepModuleBackground: false },
    );
    assert.ok(!out.permissions.includes("chrome://favicon/"), "chrome:// entry must be dropped");
    assert.deepEqual(out.permissions, ["tabs", "storage", "scripting"], "plain permissions untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transform keeps a legal https:// pattern in permissions (warn-don't-move)", () => {
  const dir = tmp();
  try {
    const out = transformManifest(
      { manifest_version: 3, permissions: ["tabs", "https://example.com/*"] },
      [],
      dir,
      { keepModuleBackground: false },
    );
    assert.ok(out.permissions.includes("https://example.com/*"), "grantable pattern must survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transform strips ws:// (webRequest websocket) from optional_permissions", () => {
  const dir = tmp();
  try {
    const out = transformManifest(
      { manifest_version: 3, optional_permissions: ["ws://example.com/*", "cookies"] },
      [],
      dir,
      { keepModuleBackground: false },
    );
    assert.deepEqual(out.optional_permissions, ["cookies"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analyzer flags the chrome:// scheme as auto-fixed, not move-it", () => {
  const found = analyzeManifest({ manifest_version: 3, permissions: ["tabs", "chrome://favicon/"] });
  const issue = found.issues.find((i) => i.message.includes("chrome://favicon/"));
  assert.ok(issue, "an issue must be raised for the chrome:// entry");
  assert.equal(issue.autoFixed, true, "must be reported as auto-fixed (dropped), not move-it");
});
