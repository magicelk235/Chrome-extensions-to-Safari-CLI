import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { guardGeckoSettingsAccess } from "../dist/input/stage.js";

// viaduct ADDS browser_specific_settings.safari (the only home for strict_min_version),
// so a bundle that reads its Firefox block through the container-only guard
// (`bss && bss.gecko.update_url`) finds the container and throws on the missing `gecko`.
// At the top level of a background script that kills every statement after it: Bypass
// Paywalls Clean (background.js:260) registered none of its 802 DNR rules and injected
// no content scripts. Optional-chain the block so the read yields undefined.

function stage(files) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-gecko-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, "utf-8");
  return dir;
}

test("the self-hosted probe stops throwing and answers falsy", () => {
  const dir = stage({
    "background.js":
      "var self_hosted = !!(manifestData.update_url || (manifestData.browser_specific_settings && manifestData.browser_specific_settings.gecko.update_url));\n",
  });
  assert.equal(guardGeckoSettingsAccess(dir), 1);
  const out = readFileSync(join(dir, "background.js"), "utf-8");
  assert.match(out, /browser_specific_settings\.gecko\?\.update_url/);

  const manifestData = { browser_specific_settings: { safari: { strict_min_version: "15.4" } } };
  assert.equal(eval(out.replace("var self_hosted =", "")), false);
});

test("a deeper read through the block is guarded too", () => {
  const dir = stage({
    "bg.js": "let id = manifestData.browser_specific_settings.gecko.id;\n",
  });
  guardGeckoSettingsAccess(dir);
  assert.match(readFileSync(join(dir, "bg.js"), "utf-8"), /\.gecko\?\.id/);
});

test("a gecko presence test keeps reading false, so no Firefox path is taken", () => {
  const dir = stage({ "bg.js": "if (m.browser_specific_settings.gecko) firefoxOnly();\n" });
  // Nothing to guard: the read is of `gecko` itself, not through it.
  assert.equal(guardGeckoSettingsAccess(dir), 0);
  assert.match(readFileSync(join(dir, "bg.js"), "utf-8"), /\.gecko\) firefoxOnly/);
});

test("the rewrite is idempotent and leaves other settings blocks alone", () => {
  const dir = stage({
    "bg.js": "a.browser_specific_settings.gecko?.id; b.browser_specific_settings.safari.strict_min_version;\n",
  });
  assert.equal(guardGeckoSettingsAccess(dir), 0);
  const out = readFileSync(join(dir, "bg.js"), "utf-8");
  assert.match(out, /gecko\?\.id/);
  assert.match(out, /safari\.strict_min_version/);
});

test("files that never mention the key are not rewritten", () => {
  const dir = stage({ "bg.js": "const x = 1;\n" });
  assert.equal(guardGeckoSettingsAccess(dir), 0);
});
