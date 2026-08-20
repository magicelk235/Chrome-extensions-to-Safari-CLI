import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { xcodebuildDiagnostics } from "../dist/build/packager.js";

// Issue #15: a conversion died with "build failed" followed by nothing but
// xcodebuild's destination noise and "** BUILD FAILED **". The cause — a team id
// this Mac had no account for — was printed by xcodebuild, on the other stream,
// and viaduct threw it away. Two things had to change: the failure has to name a
// cause, and a team viaduct picked itself must not sink the whole run.

// The streams as xcodebuild actually splits them (captured from Xcode 26).
const REAL_STDOUT = `Command line invocation:
    /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -project X.xcodeproj

Build settings from command line:
    DEVELOPMENT_TEAM = UBF8T346G9

/tmp/p/X.xcodeproj: error: No Account for Team "UBF8T346G9". Add a new account in Accounts settings or verify that your accounts have valid credentials. (in target 'X' from project 'X')
/tmp/p/X.xcodeproj: error: No signing certificate "Mac Development" found: No "Mac Development" signing certificate matching team ID "UBF8T346G9" with a private key was found. (in target 'X' from project 'X')
/tmp/p/X.xcodeproj: error: No Account for Team "UBF8T346G9". Add a new account in Accounts settings or verify that your accounts have valid credentials. (in target 'X Extension' from project 'X')
/tmp/p/X.xcodeproj: error: No signing certificate "Mac Development" found: No "Mac Development" signing certificate matching team ID "UBF8T346G9" with a private key was found. (in target 'X Extension' from project 'X')
`;
const REAL_STDERR = `2026-08-19 20:19:45.619 xcodebuild[91243:14712822] [MT] IDERunDestination: Supported platforms for the buildables in the current scheme is empty.
--- xcodebuild: WARNING: Using the first of multiple matching destinations:
{ platform:macOS, arch:arm64, id:00008122-001111D83801401C, name:My Mac }
** BUILD FAILED **


The following build commands failed:
	Building project X with scheme X and configuration Release
(1 failure)
`;

test("a build failure reports the diagnostics xcodebuild put on stdout", () => {
  const out = xcodebuildDiagnostics({ stdout: REAL_STDOUT, stderr: REAL_STDERR });
  assert.match(out, /No Account for Team "UBF8T346G9"/);
  assert.match(out, /No signing certificate "Mac Development" found/);
  // stderr is non-empty on every xcodebuild run (destination noise), so keying off
  // "stderr or else stdout" is what hid the cause.
  assert.doesNotMatch(out, /IDERunDestination/);
  // Each diagnostic is repeated once per target; say it once.
  assert.equal(out.split("\n").length, 2);
});

test("a failure with no diagnostic still shows the raw output", () => {
  const out = xcodebuildDiagnostics({ stdout: "", stderr: "xcodebuild: command timed out\n" });
  assert.match(out, /command timed out/);
});

test("compile errors are reported too, not just signing ones", () => {
  const out = xcodebuildDiagnostics({
    stdout: "/tmp/p/AppDelegate.swift:12:5: error: cannot find 'foo' in scope\n",
    stderr: "** BUILD FAILED **\n",
  });
  assert.equal(out, "/tmp/p/AppDelegate.swift:12:5: error: cannot find 'foo' in scope");
});

/**
 * Stub xcodebuild: answers `-list -json` with one scheme, then fails any build
 * carrying a non-empty DEVELOPMENT_TEAM the way a real one does (diagnostics on
 * stdout, summary on stderr, exit 65) and produces an app bundle otherwise.
 */
const XCODEBUILD_STUB = `#!/bin/sh
for arg in "$@"; do
  [ "$arg" = "-list" ] && { echo '{ "project": { "schemes": ["App"] } }'; exit 0; }
done
derived=""
team=""
prev=""
for arg in "$@"; do
  [ "$prev" = "-derivedDataPath" ] && derived="$arg"
  case "$arg" in DEVELOPMENT_TEAM=*) team="\${arg#DEVELOPMENT_TEAM=}";; esac
  prev="$arg"
done
echo "attempt team='$team'" >> "$LOG"
if [ -n "$team" ]; then
  echo "/tmp/p/App.xcodeproj: error: No Account for Team \\"$team\\". Add a new account in Accounts settings or verify that your accounts have valid credentials. (in target 'App' from project 'App')"
  echo "2026-01-01 00:00:00.000 xcodebuild[1:1] [MT] IDERunDestination: Supported platforms for the buildables in the current scheme is empty." >&2
  echo "** BUILD FAILED **" >&2
  exit 65
fi
mkdir -p "$derived/Build/Products/Release/App.app/Contents"
echo built > "$derived/Build/Products/Release/App.app/Contents/Info.plist"
echo "** BUILD SUCCEEDED **"
exit 0
`;

/** Run buildXcodeProject against the stub. Returns its result plus what printed. */
function build({ team, teamAutoDetected }) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-build-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "xcodebuild"), XCODEBUILD_STUB);
    chmodSync(join(bin, "xcodebuild"), 0o755);
    const log = join(dir, "attempts.log");
    const packager = fileURLToPath(new URL("../dist/build/packager.js", import.meta.url));
    const r = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { buildXcodeProject } from ${JSON.stringify(packager)};
         const r = buildXcodeProject("/tmp/p/App.xcodeproj", "App", "macos", ${JSON.stringify(team ?? null)} ?? undefined, ${JSON.stringify({ teamAutoDetected: Boolean(teamAutoDetected) })});
         process.stdout.write(JSON.stringify(r));`,
      ],
      { encoding: "utf-8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOG: log } },
    );
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    if (result?.derivedDir) rmSync(result.derivedDir, { recursive: true, force: true });
    return {
      result,
      printed: r.stderr,
      attempts: existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n") : [],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an auto-detected team that cannot sign falls back to an ad-hoc build", () => {
  const { result, printed, attempts } = build({ team: "UBF8T346G9", teamAutoDetected: true });
  assert.ok(result, "the run produced no app at all");
  assert.equal(result.adHocFallback, true);
  assert.match(result.builtApp, /App\.app$/);
  // The cause is on screen before the fallback notice: the user has to be able to
  // tell why they got an ad-hoc build.
  assert.match(printed, /No Account for Team "UBF8T346G9"/);
  assert.match(printed, /Rebuilding ad-hoc/);
  assert.deepEqual(attempts, ["attempt team='UBF8T346G9'", "attempt team=''"]);
});

test("a team the user named is not silently downgraded", () => {
  // Passing --team <ID> is a deliberate request for a signature that survives
  // Safari quitting. Quietly shipping ad-hoc instead would look like it worked.
  const { result, printed, attempts } = build({ team: "UBF8T346G9" });
  assert.equal(result, null);
  assert.match(printed, /No Account for Team "UBF8T346G9"/);
  assert.deepEqual(attempts, ["attempt team='UBF8T346G9'"]);
});

test("an ad-hoc build is never retried", () => {
  const { result, attempts } = build({});
  assert.equal(result.adHocFallback, undefined);
  assert.deepEqual(attempts, ["attempt team=''"]);
});
