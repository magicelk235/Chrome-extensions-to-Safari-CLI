import { mkdirSync, existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute, basename } from "node:path";
import { run, info, ok, warn, fail, moveBundle } from "../util.js";
import { pluginkitStatus, defaultBundleId, deriveAppName, plistValue } from "./packager.js";

/** Full path to LaunchServices' lsregister (not on PATH). */
export const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

export interface InstallOptions {
  /** The built .app produced by buildXcodeProject. */
  builtAppPath: string;
  appName: string;
  bundleId: string;
  /** Target dir for the installed app; defaults to ~/Applications. */
  installDir?: string;
  /** When false, skip the Safari quit/toggle/relaunch (gentler mode). */
  safariRestart: boolean;
  /** App is signed with a real Apple team → skip the unsigned toggle (it persists). */
  signed: boolean;
}

export interface InstallResult {
  /** Where the app was installed, or null if the copy failed. */
  installedAppPath: string | null;
  /** pluginkit reports the extension's bundle id as registered. */
  registered: boolean;
  /** We wrote AllowUnsignedAppExtensions = true. */
  unsignedToggleSet: boolean;
}

/** Expand a leading ~ to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Read an installed .app's real CFBundleIdentifier (what the broker LaunchAgent was
 * keyed on at install time — a custom --bundle-id, not necessarily com.viaduct.<name>).
 * Handles both bundle layouts: macOS nests Info.plist under Contents/, iOS is flat.
 * Falls back to the derived default id when the plist can't be read (bundle already
 * gone, unreadable) so uninstall still makes a best-effort broker cleanup.
 */
function installedBundleId(appDest: string, cleanName: string): string {
  const contents = join(appDest, "Contents", "Info.plist");
  const plist = existsSync(contents) ? contents : join(appDest, "Info.plist");
  return plistValue(plist, "CFBundleIdentifier") ?? defaultBundleId(deriveAppName(cleanName));
}

/**
 * True when pluginkit's output lists the EXTENSION (appex) bundle id. Callers
 * pass the app's bundleId; the registered appex is "<bundleId>.Extension". A bare
 * `includes(bundleId)` would also report true when only the app (not the appex)
 * appears, so match the appex id explicitly.
 */
export function bundleRegistered(pluginkitOutput: string, bundleId: string): boolean {
  return pluginkitOutput.includes(`${bundleId}.Extension`);
}

function safariRunning(): boolean {
  return run("/usr/bin/pgrep", ["-x", "Safari"]).code === 0;
}

/**
 * Install the built host app so its Safari extension persists across Safari
 * restarts: copy to a stable dir, register with LaunchServices, optionally
 * enable Safari's unsigned-extension toggle and bounce Safari, then launch the
 * host app so Safari registers the appex.
 */
export function installToSafari(opts: InstallOptions): InstallResult {
  const result: InstallResult = {
    installedAppPath: null,
    registered: false,
    unsignedToggleSet: false,
  };

  const targetDir = expandHome(opts.installDir ?? "~/Applications");
  mkdirSync(targetDir, { recursive: true });
  const dest = join(targetDir, `${opts.appName}.app`);

  info(`Installing host app → ${dest}`);
  // Move (not copy) the signed Release product here, leaving no duplicate behind. A
  // same-volume rename is atomic and preserves the signature/seal untouched.
  if (!moveBundle(opts.builtAppPath, dest)) {
    warn(`Install move failed: ${opts.builtAppPath} → ${dest}`);
    return result;
  }
  result.installedAppPath = dest;
  ok(`Moved host app to ${dest}`);

  // The build already signs with the App Sandbox entitlement and seals the bundle; the
  // move preserves that. Do NOT re-sign here — a plain `codesign --sign -` would strip
  // the entitlements and Safari would stop registering the appex.
  const reg = run(LSREGISTER, ["-f", dest]);
  if (reg.code === 0) ok("Registered with LaunchServices");
  else warn(`lsregister exit ${reg.code}; Safari may take a moment to see the app.`);

  // A team-signed extension loads without the (session-scoped) unsigned toggle, so skip
  // the whole Safari quit/toggle/relaunch dance when signed.
  const applyUnsigned = !opts.signed && opts.safariRestart;
  if (applyUnsigned) {
    if (safariRunning()) {
      warn("Quitting Safari to apply the unsigned-extension setting …");
      run("/usr/bin/osascript", ["-e", 'tell application "Safari" to quit']);
    }
    const def = run("/usr/bin/defaults", [
      "write",
      "com.apple.Safari",
      "AllowUnsignedAppExtensions",
      "-bool",
      "true",
    ]);
    if (def.code === 0) {
      result.unsignedToggleSet = true;
      ok('Set Safari "Allow Unsigned Extensions" = true');
    } else {
      warn('Could not set "Allow Unsigned Extensions"; enable it manually (Develop menu).');
    }
  }

  info("Launching host app to register the extension …");
  const launch = run("/usr/bin/open", [dest]);
  if (launch.code !== 0) {
    warn(`Could not launch the host app (open exit ${launch.code}); the extension may not register. Open ${dest} manually.`);
  }

  if (applyUnsigned) {
    const reopen = run("/usr/bin/open", ["-a", "Safari"]);
    if (reopen.code !== 0) warn(`Could not relaunch Safari (open exit ${reopen.code}); reopen it manually.`);
  }

  result.registered = bundleRegistered(pluginkitStatus(), opts.bundleId);
  if (result.registered) ok("pluginkit lists the extension as registered.");
  else warn("pluginkit has not listed the extension yet (give Safari a moment, then check Settings → Extensions).");

  return result;
}

export interface SafariExtension {
  bundleId: string;
  path: string;
}

/**
 * Parse pluginkit's machine-readable `-mv` output: each extension is one line of
 * `<flags>\t<bundleId>(<version>)\t<path>`. pluginkit prints "(no matches)" (or
 * nothing) when none are registered. Pure (no I/O) so it's unit-testable.
 */
export function parsePluginkitList(stdout: string): SafariExtension[] {
  const out: SafariExtension[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line || line === "(no matches)") continue;
    // Format: `<flags> <bundleId>(<version>)\t<path>`. Flags and id share the
    // first tab-column (space-separated); the path follows the last tab.
    const cols = line.split("\t").filter((c) => c.length > 0);
    if (cols.length < 2) continue;
    const path = cols[cols.length - 1];
    // Some pluginkit states print only flags+id with no path tab; filtering empties
    // then makes the id token masquerade as the path. Require an absolute path so a
    // malformed line is skipped rather than surfaced as a garbage --list entry.
    if (!path.startsWith("/")) continue;
    // The id is the last space-separated token of the first column; it carries a
    // trailing "(version)" — strip it for a clean id.
    const idToken = cols[0].split(/\s+/).filter(Boolean).pop() ?? "";
    const bundleId = idToken.replace(/\(.*\)$/, "").trim();
    if (bundleId) out.push({ bundleId, path });
  }
  return out;
}

/** List Safari Web Extensions registered with pluginkit for this user. */
export function listSafariExtensions(): SafariExtension[] {
  return parsePluginkitList(run("pluginkit", ["-mv", "-p", "com.apple.Safari.web-extension"]).stdout);
}

/**
 * Remove a previously installed Safari host app: delete <AppName>.app from the
 * install dir and unregister it from LaunchServices. Inverse of installToSafari.
 * Only ever touches a single .app bundle inside the install dir (never recurses
 * elsewhere); returns true when the bundle was found and removed.
 */
export function uninstallFromSafari(appName: string, installDir?: string): boolean {
  const cleanName = appName.replace(/\.app$/i, "");
  const targetDir = resolve(expandHome(installDir ?? "~/Applications"));
  const dest = resolve(targetDir, `${cleanName}.app`);

  // Guard against path traversal: `--uninstall "../../../Other"` would escape the
  // install dir and let us rmSync an arbitrary .app elsewhere. Refuse anything
  // whose resolved path isn't a direct child of targetDir.
  const rel = relative(targetDir, dest);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.includes("/")) {
    fail(`Refusing to remove ${dest}: outside the install dir ${targetDir}.`);
    return false;
  }

  if (!existsSync(dest)) {
    fail(`No installed app found at ${dest}.`);
    return false;
  }
  // Guard: refuse anything that isn't an .app bundle directory (never delete a
  // file or a symlink target outside the install dir).
  let isDir = false;
  try {
    isDir = statSync(dest).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir || !dest.endsWith(".app")) {
    fail(`Refusing to remove ${dest}: not an .app bundle.`);
    return false;
  }

  // Remove the broker LaunchAgent (best-effort). It was keyed on the app's ACTUAL
  // bundle id when installed, which may be a custom --bundle-id, not com.viaduct.<name>.
  // Read it back off the still-present bundle (this runs before the rmSync below) so a
  // custom-id install's plist is actually removed; fall back to the default id only if
  // the plist read fails.
  uninstallBrokerAgent(installedBundleId(dest, cleanName));

  // Unregister BEFORE deleting so LaunchServices drops the appex record cleanly.
  const unreg = run(LSREGISTER, ["-u", dest]);
  if (unreg.code === 0) ok("Unregistered from LaunchServices");
  else warn(`lsregister -u exit ${unreg.code}; continuing with removal.`);

  try {
    rmSync(dest, { recursive: true, force: true });
  } catch (e) {
    fail(`Could not remove ${dest}: ${(e as Error).message}`);
    return false;
  }
  ok(`Removed ${dest}`);
  warn("Quit and reopen Safari for it to drop the extension from Settings → Extensions.");
  return true;
}

/** Path to the per-user LaunchAgent plist that keeps the broker alive. */
function brokerAgentPlistPath(bundleId: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${bundleId}.broker.plist`);
}

/**
 * Install a LaunchAgent that keeps the container app (the native-messaging broker)
 * running. macOS auto-terminates the idle GUI app (observed live), which kills the
 * broker. The agent launches it via `open -g -W`: `open` gives the app a real GUI
 * session so AppKit initializes and the broker actually starts (launching the binary
 * directly does NOT — applicationDidFinishLaunching never fires), `-g` keeps it in the
 * background, and `-W` blocks until the app exits so KeepAlive relaunches it. RunAtLoad
 * starts it at login.
 */
export function installBrokerAgent(appPath: string, bundleId: string): boolean {
  if (!existsSync(appPath)) {
    warn(`Broker app not found at ${appPath}; native messaging will only work while the app is open manually.`);
    return false;
  }
  const label = `${bundleId}.broker`;
  const plist = brokerAgentPlistPath(bundleId);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-g</string>
    <string>-W</string>
    <string>${appPath}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
  try {
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plist, xml, "utf-8");
  } catch (e) {
    warn(`Could not write broker LaunchAgent: ${(e as Error).message}`);
    return false;
  }
  const uid = String(process.getuid?.() ?? "");
  const domain = `gui/${uid}`;
  // Re-bootstrap cleanly: bootout an old instance (ignore errors), then bootstrap.
  run("launchctl", ["bootout", `${domain}/${label}`]);
  const boot = run("launchctl", ["bootstrap", domain, plist]);
  if (boot.code !== 0) {
    // Fall back to the legacy load verb on older macOS.
    const legacy = run("launchctl", ["load", "-w", plist]);
    if (legacy.code !== 0) {
      warn(`Could not load broker LaunchAgent (${boot.stderr.trim() || legacy.stderr.trim() || "launchctl failed"}); the broker will only run while the app is open.`);
      return false;
    }
  }
  ok(`Broker LaunchAgent installed (${label}); native messaging stays alive across restarts.`);
  return true;
}

/** Remove and unload the broker LaunchAgent, if present. */
export function uninstallBrokerAgent(bundleId: string): void {
  const label = `${bundleId}.broker`;
  const plist = brokerAgentPlistPath(bundleId);
  const uid = String(process.getuid?.() ?? "");
  run("launchctl", ["bootout", `gui/${uid}/${label}`]);
  if (existsSync(plist)) {
    run("launchctl", ["unload", "-w", plist]);
    try { rmSync(plist, { force: true }); } catch { /* best effort */ }
  }
}
