import { test } from "node:test";
import assert from "node:assert/strict";
import { raiseMinVersionForMainWorld, MAIN_WORLD_MIN_SAFARI_VERSION, DEFAULT_MIN_SAFARI_VERSION } from "../dist/manifest/manifest.js";

// Safari runs a world:"MAIN" content script only from 18.4; below that it ignores the
// entry silently. wirePageWorldMainInjection (d35e3ad) adds such entries AFTER the
// transform has written strict_min_version, so the emitted manifest claimed 15.4 while
// depending on 18.4 behavior and the injection never ran.
//
// Scope matters as much as the fix. Only entries THIS CONVERSION injected are considered:
//  - an entry the extension itself declared is the author's compatibility claim, and the
//    analyzer's standing advice for it is to degrade on older Safari (a40114e) — raising
//    the floor there would refuse the install outright to Safari 15.4–18.3 users over a
//    script that may well be optional;
//  - page-bridge.js is never passed in, because when Safari ignores its entry the
//    isolated-world relay injects it as a web-accessible <script> instead.

const INJECTED = "inject-page.js";

/** Manifest with an author-declared MAIN entry plus (optionally) one viaduct injected. */
const manifest = ({ injected = false, authorMain = true } = {}) => {
  const cs = [{ js: ["cs.js"], matches: ["https://x/*"] }];
  if (authorMain) cs.push({ js: ["author-page.js"], matches: ["https://x/*"], world: "MAIN" });
  if (injected) cs.push({ js: [INJECTED], matches: ["https://x/*"], world: "MAIN" });
  return {
    manifest_version: 3,
    content_scripts: cs,
    browser_specific_settings: { safari: { strict_min_version: DEFAULT_MIN_SAFARI_VERSION } },
  };
};

test("an injected world:MAIN entry raises the Safari floor to 18.4", () => {
  const m = manifest({ injected: true });
  assert.equal(raiseMinVersionForMainWorld(m, [INJECTED]), DEFAULT_MIN_SAFARI_VERSION, "reports what it replaced");
  assert.equal(m.browser_specific_settings.safari.strict_min_version, MAIN_WORLD_MIN_SAFARI_VERSION);
});

test("an author-declared world:MAIN entry does NOT raise the floor", () => {
  // Their claim, their call — the analyzer warns and tells them to degrade. Refusing to
  // install would trade one dead feature for no extension at all.
  const m = manifest({ injected: false });
  assert.equal(raiseMinVersionForMainWorld(m, [INJECTED]), null);
  assert.equal(m.browser_specific_settings.safari.strict_min_version, DEFAULT_MIN_SAFARI_VERSION);
});

test("nothing injected means nothing to raise", () => {
  const m = manifest({ injected: true });
  assert.equal(raiseMinVersionForMainWorld(m, []), null);
  assert.equal(m.browser_specific_settings.safari.strict_min_version, DEFAULT_MIN_SAFARI_VERSION);
});

test("the OAuth page bridge is simply never passed in", () => {
  const m = manifest({ injected: false, authorMain: false });
  m.content_scripts.push({ js: ["page-bridge.js"], matches: ["https://x/*"], world: "MAIN" });
  assert.equal(raiseMinVersionForMainWorld(m, []), null);
  assert.equal(m.browser_specific_settings.safari.strict_min_version, DEFAULT_MIN_SAFARI_VERSION);
});

test("an already-high floor is left alone, including a higher one", () => {
  for (const v of ["18.4", "18.5", "19.0", "26"]) {
    const m = manifest({ injected: true });
    m.browser_specific_settings.safari.strict_min_version = v;
    assert.equal(raiseMinVersionForMainWorld(m, [INJECTED]), null, v);
    assert.equal(m.browser_specific_settings.safari.strict_min_version, v);
  }
});

test("version comparison is numeric, not lexicographic", () => {
  // "9.0" > "18.4" as strings; the floor must still be raised.
  const m = manifest({ injected: true });
  m.browser_specific_settings.safari.strict_min_version = "9.0";
  assert.equal(raiseMinVersionForMainWorld(m, [INJECTED]), "9.0");
  assert.equal(m.browser_specific_settings.safari.strict_min_version, MAIN_WORLD_MIN_SAFARI_VERSION);
  // And a two-digit minor must not read as smaller than a one-digit one.
  const n = manifest({ injected: true });
  n.browser_specific_settings.safari.strict_min_version = "18.10";
  assert.equal(raiseMinVersionForMainWorld(n, [INJECTED]), null);
});

test("a malformed browser_specific_settings is repaired, not trusted", () => {
  for (const bss of [undefined, {}, { safari: null }, { safari: "18.4" }, { safari: { strict_min_version: 15.4 } }, { safari: [] }]) {
    const m = manifest({ injected: true });
    m.browser_specific_settings = bss;
    const replaced = raiseMinVersionForMainWorld(m, [INJECTED]);
    assert.equal(m.browser_specific_settings.safari.strict_min_version, MAIN_WORLD_MIN_SAFARI_VERSION, JSON.stringify(bss));
    assert.equal(replaced, DEFAULT_MIN_SAFARI_VERSION, "a non-string declaration counts as unset");
  }
});

test("sibling browser_specific_settings keys survive", () => {
  const m = manifest({ injected: true });
  m.browser_specific_settings = { gecko: { id: "x@y" }, safari: { strict_min_version: "15.4", extra: 1 } };
  raiseMinVersionForMainWorld(m, [INJECTED]);
  assert.deepEqual(m.browser_specific_settings.gecko, { id: "x@y" });
  assert.equal(m.browser_specific_settings.safari.extra, 1);
  assert.equal(m.browser_specific_settings.safari.strict_min_version, MAIN_WORLD_MIN_SAFARI_VERSION);
});

test("a manifest with no content_scripts at all is left alone", () => {
  const m = { manifest_version: 3 };
  assert.equal(raiseMinVersionForMainWorld(m, [INJECTED]), null);
  assert.equal(m.browser_specific_settings, undefined);
});
