import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { transformManifest } from "../dist/manifest/manifest.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "viaduct-mv2bg-"));
}

const OPTS = { keepModuleBackground: false, shimFile: "safari-compat-shim.js", polyfillFile: "browser-polyfill.min.js" };

// Regression: TWP - Translate Web Pages. The compat shim must NOT be prepended to an MV2
// background.scripts list. The shim's storage relay republishes chrome/browser as a
// Proxy, and Safari only delivers a content script's native runtime.sendMessage to the
// background when the background's onMessage is registered on the REAL, unwrapped runtime.
// Wrapping it drops that delivery, so a content script's request (TWP's translateHTML)
// never reaches the background and its reply never comes back — the page won't translate.
// The pre-relay builds never injected the shim into the MV2 background and worked; the MV2
// background must be left exactly as-is.
test("MV2 background.scripts is left untouched (no shim/polyfill prepended)", () => {
  const dir = tmp();
  try {
    const out = transformManifest(
      { manifest_version: 2, background: { scripts: ["lib/polyfill.js", "background/background.js"] } },
      [],
      dir,
      OPTS,
    );
    assert.deepEqual(out.background.scripts, [
      "lib/polyfill.js",
      "background/background.js",
    ]);
    assert.ok(!out.background.scripts.includes("safari-compat-shim.js"),
      "the compat shim must not run in the MV2 background (it breaks native content→bg messaging)");
    assert.ok(!out.background.scripts.includes("browser-polyfill.min.js"),
      "no polyfill is prepended to the MV2 background either");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does NOT touch an MV3 service_worker background (handled elsewhere)", () => {
  const dir = tmp();
  try {
    const out = transformManifest(
      { manifest_version: 3, background: { service_worker: "sw.js" } },
      [],
      dir,
      OPTS,
    );
    // No scripts array to inject into; service_worker untouched by this pass.
    assert.equal(out.background.service_worker, "sw.js");
    assert.equal(out.background.scripts, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
