import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveAppName } from "../dist/build/packager.js";

// Result is written verbatim into generated .xcodeproj XML and used as a
// dir/scheme/bundle-id part, so nothing outside [letters, digits, - _] may survive.
test("strips XML/shell-dangerous chars", () => {
  assert.equal(deriveAppName('evil<foo>'), "evilfoo");
  assert.equal(deriveAppName('a"&$`()|b'), "ab");
  assert.equal(deriveAppName("My/Ext:v2"), "MyExtv2");
});

test("keeps unicode letters, digits, dash, underscore", () => {
  assert.equal(deriveAppName("日本語_1-2"), "日本語_1-2");
});

test("falls back to Extension when nothing survives", () => {
  assert.equal(deriveAppName("<>&"), "Extension");
  assert.equal(deriveAppName("   "), "Extension");
});
