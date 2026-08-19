import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { transformManifest, analyzeManifest } from "../dist/manifest/manifest.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "viaduct-dyn-"));
}

test("transform clears use_dynamic_url:true (unsupported in Safari) so getURL resolves", () => {
  const dir = tmp();
  try {
    const out = transformManifest(
      {
        manifest_version: 3,
        web_accessible_resources: [
          { resources: ["a.css"], use_dynamic_url: true, matches: ["<all_urls>"] },
          { resources: ["b.png"], matches: ["<all_urls>"] },
        ],
      },
      [],
      dir,
      { keepModuleBackground: false },
    );
    const war = out.web_accessible_resources;
    assert.equal(war[0].use_dynamic_url, false, "true must be flipped to false");
    assert.ok(!("use_dynamic_url" in war[1]), "entry without the flag stays untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transform leaves an already-false use_dynamic_url alone", () => {
  const dir = tmp();
  try {
    const out = transformManifest(
      { manifest_version: 3, web_accessible_resources: [{ resources: ["a.js"], use_dynamic_url: false, matches: ["<all_urls>"] }] },
      [],
      dir,
      { keepModuleBackground: false },
    );
    assert.equal(out.web_accessible_resources[0].use_dynamic_url, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analyzer flags use_dynamic_url:true as an auto-fixed Safari incompatibility", () => {
  const { issues } = analyzeManifest({
    manifest_version: 3,
    web_accessible_resources: [{ resources: ["a.css"], use_dynamic_url: true, matches: ["<all_urls>"] }],
  });
  const hit = issues.find((i) => /use_dynamic_url/.test(i.message));
  assert.ok(hit, "an issue mentioning use_dynamic_url must be raised");
  assert.equal(hit.autoFixed, true);
});

test("analyzer stays silent when no entry uses use_dynamic_url", () => {
  const { issues } = analyzeManifest({
    manifest_version: 3,
    web_accessible_resources: [{ resources: ["a.css"], matches: ["<all_urls>"] }],
  });
  assert.ok(!issues.some((i) => /use_dynamic_url/.test(i.message)));
});
