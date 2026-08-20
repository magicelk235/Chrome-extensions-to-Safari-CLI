import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { run, info, ok, warn, fail } from "../util.js";
import { pluginkitStatus } from "./packager.js";
import { bundleRegistered } from "./installer.js";

export interface VerifyResult {
  registered: boolean;
  /** pluginkit reports the extension as enabled/allowed (not just present). */
  enabled: boolean | null;
}

// Enabled/disabled state is NOT in pluginkit's verbose (`-mAvvv`) block — that block
// only carries Path/UUID/SDK/Display Name/… (no "enabled" key, and the words
// enabled/disabled never appear). State lives in the FLAGS COLUMN of the compact
// `-mv`/`-m` listing: each line is `<flags><bundleId>(<ver>)\t<UUID>\t…`. Per
// `man pluginkit`, the annotation chars are: `+` = user elected to use, `-` =
// elected to ignore, `!` = elected for debugger use, `=` = superseded, `?` =
// unknown; no annotation means no election recorded (default policy), NOT
// "enabled". Parse that column, not the verbose block (the old `"enabled"=N`
// regexes were dead on real output, and a bare `\bdisabled\b` scan
// false-flagged any extension whose Path or name merely contained the word
// "disabled"). Returns null when the id isn't found (caller already checks
// registration separately).
// Flag-column heuristic, upgrade to WebInspector relay if console errors are needed.
export function parseEnabled(pluginkitCompact: string, extBundleId: string): boolean | null {
  const id = `${extBundleId}.Extension`;
  for (const line of pluginkitCompact.split("\n")) {
    const at = line.indexOf(id);
    if (at === -1) continue;
    // Everything before the id on its line is the annotation column (plus indent).
    const flags = line.slice(0, at).trim();
    if (flags.includes("+") || flags.includes("!")) return true; // elected to use
    if (flags.includes("-")) return false;                       // elected to ignore
    return null; // blank/'='/'?' → no election recorded / unknown
  }
  return null;
}

// Compact, machine-parseable plugin listing whose leading flag column carries the
// enabled/disabled state (unlike the verbose -mAvvv block used for registration).
export function pluginkitCompactStatus(): string {
  return run("pluginkit", ["-mv", "-p", "com.apple.Safari.web-extension"]).stdout;
}

/**
 * Post-install sanity check: confirm Safari actually registered (and didn't
 * disable) the extension. Launches Safari so the appex gets a chance to register,
 * then polls pluginkit. Best-effort — a `null` enabled state means "registered,
 * couldn't confirm enabled", not failure.
 */
export function verifyInSafari(bundleId: string): VerifyResult {
  info("Verifying the extension loaded in Safari …");
  // Nudge Safari to scan extensions; harmless if already open.
  run("/usr/bin/open", ["-a", "Safari"]);

  // Registration lands asynchronously after Safari launches; one immediate query
  // races it and flips the --verify exit code spuriously. Poll for up to ~10s.
  let registered = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) run("/bin/sleep", ["1"]);
    registered = bundleRegistered(pluginkitStatus(), bundleId);
    if (registered) break;
  }
  // State comes from the compact flag column, not the verbose block.
  const enabled = parseEnabled(pluginkitCompactStatus(), bundleId);

  if (!registered) {
    warn("Extension is not registered with Safari yet. Open Safari → Settings → Extensions and enable it, then re-run --verify.");
  } else if (enabled === false) {
    warn("Extension is registered but disabled. Enable it in Safari → Settings → Extensions.");
  } else {
    ok("Extension is registered with Safari." + (enabled ? " Enabled." : " (Enable it in Settings → Extensions if not already.)"));
  }
  return { registered, enabled };
}

/** What a built bundle's signature actually is, read back off the artifact. */
export interface SigningInfo {
  /** Ad-hoc: Safari disables the extension every time it quits. */
  adhoc: boolean;
  /** Team the artifact carries, when it carries one. */
  teamId: string | null;
}

/** What the run asked signing to be, so the artifact can be held to it. */
export interface SigningExpectation {
  /** A concrete team reached the build, so the artifact must carry it. */
  wantsTeam: boolean;
  /** The team the build was told to use; absent when detection found none. */
  teamId?: string;
  /** A team was asked for (`--team auto` / plain `--install`) but the run could not
   *  use one — none was found, or the one it found could not sign — so it announced
   *  an ad-hoc fallback and ad-hoc is expected. */
  fellBack?: boolean;
}

export interface SigningVerdict {
  ok: boolean;
  level: "ok" | "warn" | "fail";
  message: string;
}

/**
 * Parse a `codesign -dvv` report. Ad-hoc shows up two ways depending on the
 * bundle — a bare `Signature=adhoc` line and the CodeDirectory's
 * `flags=0x2(adhoc)` — so both count. `TeamIdentifier=not set` is codesign
 * saying "none", not a team named "not". Returns null when the bundle carries
 * no signature at all, which codesign reports on stderr with a non-zero exit.
 */
export function parseSigning(codesignOutput: string): SigningInfo | null {
  const adhoc =
    /^Signature=adhoc$/m.test(codesignOutput) || /flags=\S*\(adhoc[,)]/.test(codesignOutput);
  const match = codesignOutput.match(/^TeamIdentifier=(.+)$/m);
  const raw = match?.[1].trim();
  const teamId = raw && raw !== "not set" ? raw : null;
  // Nothing that looks like a signature block at all → unsigned or unreadable.
  if (!adhoc && !teamId && !/^Signature size=/m.test(codesignOutput)) return null;
  return { adhoc, teamId };
}

/**
 * Decide whether the artifact matches the request. Pure: no IO, no printing, so
 * the decision is testable without a signed bundle on disk.
 */
export function signingVerdict(info: SigningInfo | null, want: SigningExpectation): SigningVerdict {
  if (!info) {
    // An unsigned .appex never loads, whether or not a team was in play. The
    // fallback promised ad-hoc signing, not no signature.
    return want.wantsTeam || want.fellBack
      ? { ok: false, level: "fail",
          message: "The installed extension carries no signature at all, so Safari will not load it." }
      : { ok: true, level: "warn",
          message: "Could not read the installed extension's signature." };
  }
  if (!want.wantsTeam) {
    if (!info.adhoc && info.teamId) {
      return { ok: true, level: "ok", message: `Signed with team ${info.teamId}.` };
    }
    return want.fellBack
      ? {
          ok: true,
          level: "warn",
          message:
            "Ad-hoc signed. The run fell back as warned, with no Apple team this Mac can sign with. Safari " +
            'disables the extension every time it quits; keep Develop → "Allow Unsigned Extensions" ticked, or pass ' +
            "--team <TEAMID> and re-run.",
        }
      : {
          ok: true,
          level: "ok",
          message:
            'Ad-hoc signed, as asked. Safari drops it whenever it quits (keep "Allow Unsigned Extensions" on, or re-run with --team).',
        };
  }
  if (info.adhoc || !info.teamId) {
    return {
      ok: false,
      level: "fail",
      message:
        `Team ${want.teamId ?? "signing"} was requested and reached xcodebuild, but the installed extension is ` +
        "ad-hoc, so Safari disables it every time it quits. The build dropped the identity: check that an " +
        '"Apple Development" certificate for that team is in your keychain (Xcode → Settings → Accounts → ' +
        "Manage Certificates → +), then re-run.",
    };
  }
  if (want.teamId && info.teamId !== want.teamId) {
    return {
      ok: false,
      level: "fail",
      message: `Installed extension is signed with team ${info.teamId}, not the requested ${want.teamId}.`,
    };
  }
  return { ok: true, level: "ok", message: `Team-signed (${info.teamId}), so it survives Safari quitting.` };
}

/** The bundle Safari actually loads: the .appex inside the built app. */
export function extensionBundlePath(appPath: string): string {
  const plugins = join(appPath, "Contents", "PlugIns");
  if (existsSync(plugins)) {
    const appex = readdirSync(plugins).find((name) => name.endsWith(".appex"));
    if (appex) return join(plugins, appex);
  }
  return appPath;
}

/**
 * Hold the installed artifact to what the run asked for. Team detection only
 * predicts how the build will be signed; this reads the signature back off the
 * bundle Safari loads, so a fallback anywhere in the chain — no certificate, a
 * stale copy of this tool, xcodebuild quietly dropping the identity — surfaces
 * as a failed `--verify` instead of an extension that disappears on the next
 * Safari restart.
 */
export function verifySigning(appPath: string, want: SigningExpectation): boolean {
  const target = extensionBundlePath(appPath);
  // codesign writes its report to stderr; stdout stays empty.
  const res = run("codesign", ["-dvv", target]);
  const verdict = signingVerdict(parseSigning(res.stderr + res.stdout), want);
  if (verdict.level === "ok") ok(verdict.message);
  else if (verdict.level === "warn") warn(verdict.message);
  else fail(verdict.message);
  return verdict.ok;
}
