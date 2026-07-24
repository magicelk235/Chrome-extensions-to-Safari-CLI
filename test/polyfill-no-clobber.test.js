import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePolyfill, POLYFILL_FILENAME, POLYFILL_ALT_FILENAME } from "../dist/runtime/shim.js";
import { transformManifest } from "../dist/manifest/manifest.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "viaduct-poly-"));
}

// Regression (#10): uBlock Origin ships its own browser-polyfill.min.js. viaduct used
// to overwrite it with its own build; uBlock's vapi.js was compiled against its own
// copy, threw at load, and every content script after it (the cosmetic filter) died.
test("writePolyfill does not overwrite an extension's own browser-polyfill.min.js", () => {
  const dir = tmp();
  try {
    const ownContents = "/* uBlock's own polyfill build */";
    writeFileSync(join(dir, POLYFILL_FILENAME), ownContents, "utf-8");

    const name = writePolyfill(dir);

    // viaduct's copy lands under the alt name, not on top of the extension's file.
    assert.equal(name, POLYFILL_ALT_FILENAME, "must return the alt name when the file already exists");
    assert.equal(readFileSync(join(dir, POLYFILL_FILENAME), "utf-8"), ownContents, "extension's own polyfill must be left untouched");
    assert.ok(existsSync(join(dir, POLYFILL_ALT_FILENAME)), "viaduct's polyfill must be written under the alt name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transform prepends viaduct's alt-named polyfill without disturbing the extension's own", () => {
  const dir = tmp();
  try {
    const out = transformManifest(
      {
        manifest_version: 2,
        content_scripts: [
          { matches: ["https://*/*"], js: ["browser-polyfill.min.js", "/js/vapi.js", "/js/contentscript.js"] },
        ],
      },
      [],
      dir,
      { keepModuleBackground: false, shimFile: "safari-compat-shim.js", polyfillFile: POLYFILL_ALT_FILENAME },
    );
    const js = out.content_scripts[0].js;
    // viaduct's polyfill + shim lead; the extension's own browser-polyfill and its
    // scripts stay in their original relative order behind them.
    assert.deepEqual(js, [
      POLYFILL_ALT_FILENAME,
      "safari-compat-shim.js",
      "browser-polyfill.min.js",
      "/js/vapi.js",
      "/js/contentscript.js",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writePolyfill uses the normal name when the extension ships no polyfill", () => {
  const dir = tmp();
  try {
    const name = writePolyfill(dir);
    assert.equal(name, POLYFILL_FILENAME, "no collision → keep the standard filename");
    assert.ok(existsSync(join(dir, POLYFILL_FILENAME)));
    assert.ok(!existsSync(join(dir, POLYFILL_ALT_FILENAME)), "alt name only used on collision");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
