import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeManifest, transformManifest } from "../dist/manifest/manifest.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "viaduct-cdp-"));
}

test("analyzeManifest sets needsCdpShim when debugger is declared", () => {
  const a = analyzeManifest({ manifest_version: 3, permissions: ["debugger", "tabs"] });
  assert.equal(a.needsCdpShim, true);
  assert.ok(a.permissionsToRemove.includes("debugger"));
});

test("analyzeManifest leaves needsCdpShim false without debugger", () => {
  assert.equal(analyzeManifest({ manifest_version: 3, permissions: ["tabs"] }).needsCdpShim, false);
});

test("transformManifest with cdpShim keeps scripting + <all_urls>", () => {
  const dir = tmp();
  try {
    const out = transformManifest(
      { manifest_version: 3, permissions: ["debugger", "tabs"] },
      ["debugger"],
      dir,
      { keepModuleBackground: false, cdpShim: true },
    );
    assert.ok(out.permissions.includes("scripting"));
    assert.ok(!out.permissions.includes("debugger"));
    assert.ok((out.host_permissions || []).includes("<all_urls>"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transformManifest without cdpShim does not inject scripting/<all_urls>", () => {
  const dir = tmp();
  try {
    const out = transformManifest(
      { manifest_version: 3, permissions: ["tabs"] },
      [],
      dir,
      { keepModuleBackground: false },
    );
    assert.ok(!(out.permissions || []).includes("scripting"));
    assert.ok(!((out.host_permissions || []).includes("<all_urls>")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transformManifest cdpShim does not duplicate existing scripting/<all_urls>", () => {
  const dir = tmp();
  try {
    const out = transformManifest(
      { manifest_version: 3, permissions: ["debugger", "scripting"], host_permissions: ["<all_urls>"] },
      ["debugger"],
      dir,
      { keepModuleBackground: false, cdpShim: true },
    );
    assert.equal(out.permissions.filter((p) => p === "scripting").length, 1);
    assert.equal((out.host_permissions || []).filter((h) => h === "<all_urls>").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
