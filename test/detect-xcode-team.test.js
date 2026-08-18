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

/**
 * Run detection in a sealed environment: a temp HOME so only the profiles this
 * test writes are visible, and stub `defaults` / `security` / `openssl` on PATH
 * so only the source under test can answer. Returns what detection resolved.
 */
function detectIn({ shell = {}, profiles = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-detect-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const cmd of ["defaults", "security", "openssl"]) {
      writeFileSync(join(bin, cmd), shell[cmd] ?? "#!/bin/sh\nexit 1\n");
      chmodSync(join(bin, cmd), 0o755);
    }
    const home = join(dir, "home");
    mkdirSync(home);
    for (const { dir: rel, name, plist } of profiles) {
      const target = join(home, ...rel);
      mkdirSync(target, { recursive: true });
      // Real profiles are CMS-signed; the payload plist sits in the blob as
      // plain XML, binary wrapper bytes and all.
      writeFileSync(join(target, name), Buffer.concat([Buffer.from([0x30, 0x82, 0x0a, 0x00]), Buffer.from(plist)]));
    }
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
    return r.stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `defaults read <domain> <key>` stub that answers one domain/key pair. */
function defaultsStub(domain, key, payload) {
  return `#!/bin/sh
if [ "$2" = "${domain}" ] && [ "$3" = "${key}" ]; then
cat <<'PLIST'
${payload}
PLIST
exit 0
fi
exit 1
`;
}

/** `security` + `openssl` stubs standing in for one keychain identity. */
function keychainStub(identity, team) {
  return {
    security: `#!/bin/sh
case "$1" in
  find-identity) echo '  1) DEADBEEF "${identity}"'; exit 0;;
  find-certificate) echo "-----BEGIN CERTIFICATE-----"; echo "ZmFrZQ=="; echo "-----END CERTIFICATE-----"; exit 0;;
esac
exit 1
`,
    openssl: `#!/bin/sh
cat >/dev/null
echo "subject=UID=${team}, CN=${identity}, OU=${team}, O=Example, C=US"
`,
  };
}

const XCODE_PROFILES = ["Library", "Developer", "Xcode", "UserData", "Provisioning Profiles"];
const LEGACY_PROFILES = ["Library", "MobileDevice", "Provisioning Profiles"];
const wrap = (body) => `<plist version="1.0"><dict>${body}</dict></plist>`;

// Detection has to survive the range of Xcode versions people actually run, not
// just the one on the maintainer's machine. Every case below is a shape some
// Xcode wrote: which preference key and domain get used varies by version, the
// profile directory moved in Xcode 16, TeamIdentifier only appeared in profiles
// around Xcode 6, and a paid account that has never made a development cert has
// nothing in the keychain but a Developer ID one.
const CASES = [
  {
    name: "IDEProvisioningTeamByIdentifier in the Xcode domain",
    env: { shell: { defaults: defaultsStub("com.apple.dt.Xcode", "IDEProvisioningTeamByIdentifier", '{ "702A" = ( { teamID = AA11111111; } ); }') } },
    team: "AA11111111",
  },
  {
    name: "IDEProvisioningTeams, the key older Xcodes wrote",
    env: { shell: { defaults: defaultsStub("com.apple.dt.Xcode", "IDEProvisioningTeams", '{ "me@example.com" = ( { isFreeProvisioningTeam = 1; teamID = BB22222222; } ); }') } },
    team: "BB22222222",
  },
  {
    name: "the xcodebuild preference domain when the Xcode one is empty",
    env: { shell: { defaults: defaultsStub("com.apple.dt.xcodebuild", "IDEProvisioningTeamByIdentifier", '{ "702A" = ( { teamID = CC33333333; } ); }') } },
    team: "CC33333333",
  },
  {
    name: "a quoted team id",
    env: { shell: { defaults: defaultsStub("com.apple.dt.Xcode", "IDEProvisioningTeamByIdentifier", '{ x = ( { teamID = "DD44444444"; } ); }') } },
    team: "DD44444444",
  },
  {
    name: "a profile in the Xcode 16 location",
    env: { profiles: [{ dir: XCODE_PROFILES, name: "a.provisionprofile", plist: wrap("<key>TeamIdentifier</key><array><string>EE55555555</string></array>") }] },
    team: "EE55555555",
  },
  {
    name: "a profile in the pre-Xcode 16 location",
    env: { profiles: [{ dir: LEGACY_PROFILES, name: "a.mobileprovision", plist: wrap("<key>TeamIdentifier</key><array><string>FF66666666</string></array>") }] },
    team: "FF66666666",
  },
  {
    name: "a pre-Xcode 6 profile that predates TeamIdentifier",
    env: { profiles: [{ dir: LEGACY_PROFILES, name: "a.mobileprovision", plist: wrap("<key>ApplicationIdentifierPrefix</key><array><string>GG77777777</string></array>") }] },
    team: "GG77777777",
  },
  {
    name: "the team-identifier entitlement inside a profile",
    env: { profiles: [{ dir: XCODE_PROFILES, name: "a.provisionprofile", plist: wrap("<key>Entitlements</key><dict><key>com.apple.developer.team-identifier</key><string>HH88888888</string></dict>") }] },
    team: "HH88888888",
  },
  {
    name: "an Apple Development certificate",
    env: { shell: keychainStub("Apple Development: me@example.com (II99999999)", "II99999999") },
    team: "II99999999",
  },
  {
    name: "a Mac Developer certificate from an older Xcode",
    env: { shell: keychainStub("Mac Developer: me@example.com (JJ10101010)", "JJ10101010") },
    team: "JJ10101010",
  },
  {
    name: "a Developer ID certificate, the only one some paid accounts have",
    env: { shell: keychainStub("Developer ID Application: Example Ltd (KK11111111)", "KK11111111") },
    team: "KK11111111",
  },
  {
    name: "a Mac App Store distribution certificate",
    env: { shell: keychainStub("3rd Party Mac Developer Application: Example (LL12121212)", "LL12121212") },
    team: "LL12121212",
  },
];

for (const { name, env, team } of CASES) {
  test(`detectXcodeTeam resolves the team from ${name}`, () => {
    assert.equal(detectIn(env), team);
  });
}

test("detectXcodeTeam returns null when no source has a team", () => {
  assert.equal(detectIn({}), "null");
});

test("detectXcodeTeam ignores a token that only looks like a team id", () => {
  // 11 characters: a real team id is exactly 10, and truncating a longer token
  // would hand xcodebuild a plausible but wrong id.
  const shell = { defaults: defaultsStub("com.apple.dt.Xcode", "IDEProvisioningTeamByIdentifier", "{ x = ( { teamID = AA111111112; } ); }") };
  assert.equal(detectIn({ shell }), "null");
});
