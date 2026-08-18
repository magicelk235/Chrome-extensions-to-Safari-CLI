import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseEnabled,
  parseSigning,
  signingVerdict,
  extensionBundlePath,
} from "../dist/build/verify.js";

const ID = "com.viaduct.MyExt";

// Real `pluginkit -mv` lines: a leading annotation column, then the bundle id,
// version, UUID, path… Per `man pluginkit` the annotation chars are `+` (user
// elected to use), `-` (elected to ignore), `!` (debugger use), `=` (superseded),
// `?` (unknown); a BLANK column means no election recorded — NOT "enabled".
const ELECTED_LINE = `+   com.viaduct.MyExt.Extension(1.0)\t11111111-1111-1111-1111-111111111111\t/Users/me/Applications/MyExt.app/Contents/PlugIns/MyExt Extension.appex\n`;
const BLANK_LINE = `    com.viaduct.MyExt.Extension(1.0)\t11111111-1111-1111-1111-111111111111\t/Users/me/Applications/MyExt.app/Contents/PlugIns/MyExt Extension.appex\n`;
const IGNORED_LINE = `-   com.viaduct.MyExt.Extension(1.0)\t11111111-1111-1111-1111-111111111111\t/Users/me/Applications/MyExt.app/Contents/PlugIns/MyExt Extension.appex\n`;

test("parseEnabled: returns null when the extension's line is absent", () => {
  assert.equal(parseEnabled("(no matches)\n", ID), null);
});

test("parseEnabled: true when the user elected to use it ('+')", () => {
  assert.equal(parseEnabled(ELECTED_LINE, ID), true);
});

test("parseEnabled: true for the debugger-use election ('!')", () => {
  assert.equal(parseEnabled(IGNORED_LINE.replace("-", "!"), ID), true);
});

test("parseEnabled: null when the annotation column is blank (no election recorded)", () => {
  assert.equal(parseEnabled(BLANK_LINE, ID), null);
});

test("parseEnabled: false when the user elected to ignore ('-')", () => {
  assert.equal(parseEnabled(IGNORED_LINE, ID), false);
});

test("parseEnabled: does NOT false-flag a path that merely contains 'disabled'", () => {
  // The install dir is user-chosen; a path segment named 'disabled' must not be read
  // as disabled state. The old \bdisabled\b substring scan got this wrong.
  const out = `+   com.viaduct.MyExt.Extension(1.0)\t11111111-1111-1111-1111-111111111111\t/Users/me/Apps/disabled/MyExt.app/Contents/PlugIns/Ext.appex\n`;
  assert.equal(parseEnabled(out, ID), true);
});

test("parseEnabled: reads its own line, not a neighbour's flag", () => {
  // Our line is elected ('+'); a different, ignored extension follows.
  const out = ELECTED_LINE + `-   com.other.App.Extension(2.0)\t22222222-2222-2222-2222-222222222222\t/x\n`;
  assert.equal(parseEnabled(out, ID), true);
});

// Real `codesign -dvv` output. It goes to stderr, and the two signing states
// look nothing alike: a team-signed bundle carries `Signature size=` plus a
// TeamIdentifier, an ad-hoc one carries `Signature=adhoc` and the literal
// string `not set` where the team would be.
const TEAM_SIGNED = `Executable=/tmp/out/JSONViewer.app/Contents/PlugIns/JSONViewer Extension.appex/Contents/MacOS/JSONViewer Extension
Identifier=com.viaduct.JSONViewer.Extension
Format=bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=556 flags=0x10000(runtime) hashes=6+7 location=embedded
Signature size=4796
Authority=Apple Development: me@example.com (R28RG6QC6S)
Authority=Apple Root CA
Info.plist entries=21
TeamIdentifier=V8K8L3ZSD5
`;

const ADHOC = `Executable=/tmp/adhoc.app/Contents/MacOS/JSONViewer
Identifier=com.viaduct.JSONViewer
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=399 flags=0x2(adhoc) hashes=6+3 location=embedded
Signature=adhoc
Info.plist entries=25
TeamIdentifier=not set
`;

test("parseSigning: reads the team off a team-signed bundle", () => {
  assert.deepEqual(parseSigning(TEAM_SIGNED), { adhoc: false, teamId: "V8K8L3ZSD5" });
});

test("parseSigning: ad-hoc bundle reports no team", () => {
  // "not set" is codesign saying there is none — it must not become a team id.
  assert.deepEqual(parseSigning(ADHOC), { adhoc: true, teamId: null });
});

test("parseSigning: detects ad-hoc from the CodeDirectory flags alone", () => {
  // Some bundles carry the flag without a separate `Signature=adhoc` line.
  const out = ADHOC.replace("Signature=adhoc\n", "");
  assert.equal(parseSigning(out)?.adhoc, true);
});

test("parseSigning: reads ad-hoc out of a combined flags list", () => {
  const out = ADHOC.replace("flags=0x2(adhoc)", "flags=0x10002(adhoc,runtime)");
  assert.equal(parseSigning(out)?.adhoc, true);
});

test("parseSigning: null when the bundle carries no signature at all", () => {
  assert.equal(parseSigning("/tmp/x.app: code object is not signed at all\n"), null);
});

test("signingVerdict: team requested, ad-hoc delivered → failure", () => {
  // The exact regression this guards: detection said a team was available, the
  // build produced ad-hoc, and nothing downstream noticed.
  const v = signingVerdict(parseSigning(ADHOC), { wantsTeam: true });
  assert.equal(v.ok, false);
  assert.equal(v.level, "fail");
});

test("signingVerdict: team requested and delivered → pass", () => {
  const v = signingVerdict(parseSigning(TEAM_SIGNED), { wantsTeam: true, teamId: "V8K8L3ZSD5" });
  assert.equal(v.ok, true);
});

test("signingVerdict: auto-detected team passes without an expected id", () => {
  const v = signingVerdict(parseSigning(TEAM_SIGNED), { wantsTeam: true });
  assert.equal(v.ok, true);
});

test("signingVerdict: signed with a different team than asked → failure", () => {
  const v = signingVerdict(parseSigning(TEAM_SIGNED), { wantsTeam: true, teamId: "AAAAAAAAAA" });
  assert.equal(v.ok, false);
  assert.match(v.message, /V8K8L3ZSD5/);
});

test("signingVerdict: ad-hoc is fine when no team was asked for", () => {
  const v = signingVerdict(parseSigning(ADHOC), { wantsTeam: false });
  assert.equal(v.ok, true);
});

test("signingVerdict: an announced ad-hoc fallback is not a failure", () => {
  // --team auto with no team on the machine: the run already warned it was
  // falling back, so the predicted ad-hoc bundle must not exit 1 (issue #14).
  const v = signingVerdict(parseSigning(ADHOC), { wantsTeam: false, fellBack: true });
  assert.equal(v.ok, true);
  assert.equal(v.level, "warn");
  assert.match(v.message, /--team/);
});

test("signingVerdict: a fallback run still fails on an unsigned bundle", () => {
  // The fallback promises ad-hoc signing, not the absence of a signature.
  assert.equal(signingVerdict(null, { wantsTeam: false, fellBack: true }).ok, false);
});

test("signingVerdict: a fallback run that somehow team-signed still passes", () => {
  const v = signingVerdict(parseSigning(TEAM_SIGNED), { wantsTeam: false, fellBack: true });
  assert.equal(v.ok, true);
  assert.equal(v.level, "ok");
});

test("signingVerdict: an unsigned bundle fails a team-signing request", () => {
  assert.equal(signingVerdict(null, { wantsTeam: true }).ok, false);
});

test("signingVerdict: unreadable signature only warns when nothing was asked for", () => {
  const v = signingVerdict(null, { wantsTeam: false });
  assert.equal(v.ok, true);
  assert.equal(v.level, "warn");
});

test("extensionBundlePath: picks the appex Safari loads, not the app wrapper", () => {
  const app = join(mkdtempSync(join(tmpdir(), "viaduct-verify-")), "MyExt.app");
  const plugins = join(app, "Contents", "PlugIns");
  mkdirSync(plugins, { recursive: true });
  mkdirSync(join(plugins, "MyExt Extension.appex"));
  assert.equal(extensionBundlePath(app), join(plugins, "MyExt Extension.appex"));
});

test("extensionBundlePath: falls back to the app when there is no appex", () => {
  const app = join(mkdtempSync(join(tmpdir(), "viaduct-verify-")), "MyExt.app");
  mkdirSync(app, { recursive: true });
  assert.equal(extensionBundlePath(app), app);
});
