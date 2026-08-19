import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeManifest } from "../dist/manifest/manifest.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "viaduct-cs-"));
}

function written(dir) {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8"));
}

// Safari rejects `content_scripts: []` ("Empty or invalid content_scripts
// manifest entry") and refuses to load the extension; Chrome tolerates it.
// ChatGPT ships exactly this, so the empty array must be dropped on write.
test("writeManifest drops an empty content_scripts array (Safari rejects it)", () => {
  const dir = tmp();
  try {
    writeManifest(dir, { manifest_version: 3, content_scripts: [] });
    assert.ok(!("content_scripts" in written(dir)), "empty array must be removed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeManifest preserves a populated content_scripts array", () => {
  const dir = tmp();
  try {
    const cs = [{ js: ["cs.js"], matches: ["<all_urls>"] }];
    writeManifest(dir, { manifest_version: 3, content_scripts: cs });
    assert.deepEqual(written(dir).content_scripts, cs, "real entries must survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeManifest leaves a manifest without content_scripts untouched", () => {
  const dir = tmp();
  try {
    writeManifest(dir, { manifest_version: 3 });
    assert.ok(!("content_scripts" in written(dir)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
