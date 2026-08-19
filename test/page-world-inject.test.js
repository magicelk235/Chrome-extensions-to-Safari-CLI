import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { wirePageWorldMainInjection } from "../dist/runtime/shim.js";

// A content script that injects a web-accessible-resource <script> into the page
// (`el.src = runtime.getURL("x.js")`) runs in the page's MAIN world in Chrome, exempt
// from the page CSP. Safari enforces the page CSP against the extension scheme, so the
// injection is refused and the page-world code silently dies. wirePageWorldMainInjection
// re-declares each injected target as a world:"MAIN" content script (CSP-exempt on
// Safari 18.4+).

function stage(files) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-pw-"));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const mainEntries = (m) => m.content_scripts.filter((cs) => cs.world === "MAIN");

test("re-declares an injected page-world script as a world:MAIN content script", () => {
  const dir = stage({
    "cs.js": 'const s=document.createElement("script");s.src=chrome.runtime.getURL("page/world.js");document.head.append(s);',
    "page/world.js": "globalThis.__ran = true;",
  });
  const manifest = {
    manifest_version: 3,
    content_scripts: [{ matches: ["https://*/*"], js: ["cs.js"], all_frames: true }],
  };
  try {
    const wired = wirePageWorldMainInjection(dir, manifest);
    assert.deepEqual(wired, ["page/world.js"]);
    const main = mainEntries(manifest);
    assert.equal(main.length, 1);
    assert.deepEqual(main[0].js, ["page/world.js"]);
    assert.equal(main[0].world, "MAIN");
    assert.equal(main[0].run_at, "document_start");
    // mirrors the extension's own reach, never broader
    assert.deepEqual(main[0].matches, ["https://*/*"]);
    assert.equal(main[0].all_frames, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detects injection from a NON-declared script (dynamically registered content scripts)", () => {
  // The injecting file isn't in manifest.content_scripts — it's registered at runtime via
  // chrome.scripting.registerContentScripts, so the scan must cover all bundled JS.
  const dir = stage({
    "content/main.js": "// declared entry, no injection here",
    "content/injector.js": 'var n=document.createElement("script");n.src=browser.runtime.getURL("content/page-world.js");document.documentElement.prepend(n);',
    "content/page-world.js": "1;",
  });
  const manifest = {
    manifest_version: 3,
    content_scripts: [{ matches: ["http://*/*", "https://*/*"], js: ["content/main.js"], match_about_blank: true }],
  };
  try {
    const wired = wirePageWorldMainInjection(dir, manifest);
    assert.deepEqual(wired, ["content/page-world.js"]);
    const main = mainEntries(manifest);
    assert.equal(main.length, 1);
    assert.deepEqual(main[0].matches, ["http://*/*", "https://*/*"]);
    assert.equal(main[0].match_about_blank, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does nothing when no page-world injection exists", () => {
  const dir = stage({
    "cs.js": 'chrome.runtime.getURL("some/asset.png"); fetch(chrome.runtime.getURL("data.js"));',
    "data.js": "1;",
  });
  const manifest = { manifest_version: 3, content_scripts: [{ matches: ["https://*/*"], js: ["cs.js"] }] };
  try {
    // fetch(getURL(...)) is not a <script>.src injection — must not be wired.
    assert.deepEqual(wirePageWorldMainInjection(dir, manifest), []);
    assert.equal(mainEntries(manifest).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skips targets that do not exist on disk", () => {
  const dir = stage({
    "cs.js": 'x.src=chrome.runtime.getURL("missing.js");',
  });
  const manifest = { manifest_version: 3, content_scripts: [{ matches: ["https://*/*"], js: ["cs.js"] }] };
  try {
    assert.deepEqual(wirePageWorldMainInjection(dir, manifest), []);
    assert.equal(mainEntries(manifest).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("is idempotent — a second run does not duplicate the MAIN-world entry", () => {
  const dir = stage({
    "cs.js": 'e.src=chrome.runtime.getURL("world.js");',
    "world.js": "1;",
  });
  const manifest = { manifest_version: 3, content_scripts: [{ matches: ["https://*/*"], js: ["cs.js"] }] };
  try {
    assert.deepEqual(wirePageWorldMainInjection(dir, manifest), ["world.js"]);
    assert.deepEqual(wirePageWorldMainInjection(dir, manifest), []); // already wired
    assert.equal(mainEntries(manifest).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("falls back to <all_urls> when the extension declares no content-script matches", () => {
  const dir = stage({
    "injector.js": 'a.src=chrome.runtime.getURL("pw.js");',
    "pw.js": "1;",
  });
  const manifest = { manifest_version: 3 }; // no content_scripts at all
  try {
    assert.deepEqual(wirePageWorldMainInjection(dir, manifest), ["pw.js"]);
    assert.deepEqual(mainEntries(manifest)[0].matches, ["<all_urls>"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
