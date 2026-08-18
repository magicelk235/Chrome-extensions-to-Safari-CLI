import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectXcodeTeam } from "../dist/build/packager.js";

// Xcode's IDEProvisioningTeamByIdentifier cache is written asynchronously and is
// missing on plenty of machines where an Apple account is signed in and can sign
// fine. Returning null there makes Viaduct claim there is no Apple account and
// silently drop to ad-hoc signing, which Safari disables on every quit. So the
// keychain has to cover for the cache.

const TEAM_ID = /^[A-Z0-9]{10}$/;

/** True when this machine has anything to detect at all. */
function machineCanSign() {
  const r = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf-8",
  });
  return r.status === 0 && /"(Apple Development|Mac Developer|Apple Distribution|iPhone Developer):/.test(r.stdout);
}

/** Re-run detectXcodeTeam in a child process with `defaults` shadowed to fail. */
function detectWithoutXcodePrefs() {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-nodefaults-"));
  try {
    writeFileSync(join(dir, "defaults"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(dir, "defaults"), 0o755);
    const packager = fileURLToPath(new URL("../dist/build/packager.js", import.meta.url));
    const r = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { detectXcodeTeam } from ${JSON.stringify(packager)};
         process.stdout.write(String(detectXcodeTeam()));`,
      ],
      { encoding: "utf-8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } },
    );
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() === "null" ? null : r.stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a signable machine resolves a team id even with Xcode's cache unreadable", (t) => {
  if (!machineCanSign()) {
    t.skip("no codesigning identity in this keychain");
    return;
  }
  const fromKeychain = detectWithoutXcodePrefs();
  assert.match(fromKeychain ?? "", TEAM_ID, "keychain fallback returned no team id");
});

test("the keychain fallback agrees with Xcode's cache when both are available", (t) => {
  const cached = detectXcodeTeam();
  if (!cached || !machineCanSign()) {
    t.skip("needs both an Xcode team cache and a keychain identity");
    return;
  }
  // Both read the same team: the cache's teamID and the certificate subject's OU.
  // If they ever disagree, the warning would fire against the wrong signal.
  assert.equal(detectWithoutXcodePrefs(), cached);
});

// A freshly signed-in Xcode has no certificate yet — it mints one on the first
// build — and only caches the team id once it has provisioned something. On such
// a machine both sources above come up empty and Viaduct told the user to sign in
// to Xcode, which they already had (issue #14). Any provisioning profile on disk
// carries the team id, and that is all the build needs: xcodebuild runs with
// -allowProvisioningUpdates, so Xcode creates the certificate itself.
test("a provisioning profile supplies the team when Xcode's cache and the keychain are empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-profile-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const cmd of ["defaults", "security"]) {
      writeFileSync(join(bin, cmd), "#!/bin/sh\nexit 1\n");
      chmodSync(join(bin, cmd), 0o755);
    }
    const home = join(dir, "home");
    const profiles = join(home, "Library", "Developer", "Xcode", "UserData", "Provisioning Profiles");
    mkdirSync(profiles, { recursive: true });
    // Real profiles are CMS-signed; the payload plist sits in the blob as plain
    // XML, binary wrapper bytes and all.
    writeFileSync(
      join(profiles, "abc.provisionprofile"),
      Buffer.concat([
        Buffer.from([0x30, 0x82, 0x0a, 0x00]),
        Buffer.from(
          "<plist version=\"1.0\"><dict><key>TeamIdentifier</key><array><string>ABCDE12345</string></array></dict></plist>",
        ),
      ]),
    );
    const packager = fileURLToPath(new URL("../dist/build/packager.js", import.meta.url));
    const r = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { detectXcodeTeam } from ${JSON.stringify(packager)};
         process.stdout.write(String(detectXcodeTeam()));`,
      ],
      { encoding: "utf-8", env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "ABCDE12345");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
