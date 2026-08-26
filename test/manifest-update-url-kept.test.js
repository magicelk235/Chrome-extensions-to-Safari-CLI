import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { transformManifest } from "../dist/manifest/manifest.js";

// A self-hosted bundle asks "do I update myself?" by ORing the browsers' update
// fields together, and the Firefox operand is usually written unguarded:
//
//   !!(manifest.update_url || (manifest.browser_specific_settings &&
//      manifest.browser_specific_settings.gecko.update_url))
//
// viaduct ADDS browser_specific_settings.safari for strict_min_version, so the
// object exists with no `gecko` block. Deleting update_url made that expression
// fall through to `.gecko.update_url` and THROW at the top level of the background
// script, killing every statement after it. Live: Bypass Paywalls Clean
// (background.js:260) registered none of its 802 DNR rules and injected no content
// scripts. Safari ignores update_url, so keeping it costs nothing.

const base = () => ({
  manifest_version: 3,
  name: "Self Hosted",
  version: "1.0",
  update_url: "https://example.com/updates.xml",
  background: { service_worker: "bg.js" },
});

const transform = (m) =>
  transformManifest(m, [], mkdtempSync(join(tmpdir(), "viaduct-mf-")), { keepModuleBackground: false });

test("update_url survives the transform", () => {
  const out = transform(base());
  assert.equal(out.update_url, "https://example.com/updates.xml");
});

test("the self-hosted probe an extension actually writes does not throw", () => {
  const out = transform(base());
  assert.ok(out.browser_specific_settings?.safari, "the transform adds a Safari settings block");
  assert.equal(out.browser_specific_settings.gecko, undefined, "and no gecko block to read through");
  const selfHosted = () =>
    !!(out.update_url ||
      (out.browser_specific_settings && out.browser_specific_settings.gecko.update_url));
  assert.equal(selfHosted(), true);
});

test("key and minimum_chrome_version are still dropped", () => {
  const out = transform({ ...base(), key: "AAAA", minimum_chrome_version: "109" });
  assert.equal(out.key, undefined);
  assert.equal(out.minimum_chrome_version, undefined);
});
