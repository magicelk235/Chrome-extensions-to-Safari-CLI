#!/usr/bin/env node
import { parseArgs } from "node:util";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { convert } from "./convert.js";
import { extractExtension } from "./input/extract.js";
import { loadManifest, analyzeManifest, resolveI18nString, transformManifest, DEFAULT_MIN_SAFARI_VERSION } from "./manifest/manifest.js";
import { scanExtension } from "./analyze/analyze.js";
import { printIssues, countBlocking, summarizeManifestChanges, buildReportMarkdown } from "./analyze/report.js";
import { run, info, ok, warn, fail, color, commandExists, setVerbose, setQuiet } from "./util.js";
import { LSREGISTER, uninstallFromSafari, listSafariExtensions } from "./build/installer.js";
import { detectXcodeTeam, defaultBundleId, deriveAppName } from "./build/packager.js";
import { verifyInSafari, verifySigning } from "./build/verify.js";
import { isUrl, downloadExtension } from "./input/download.js";
import type { Platforms } from "./types.js";

// Option keys a config file may set. Mirrors the long-flag names in parseArgs so
// a viaduct.config.json reads exactly like the CLI: { "bundle-id": "...", "team": "auto" }.
// Excludes one-shot/meta flags (analyze, doctor, list, version, etc.) that make no
// sense to persist. Hand-listed; add a key here when it's worth persisting.
const CONFIG_KEYS = [
  "output", "bundle-id", "app-name", "min-safari", "platforms", "ci",
  "zip", "no-build", "open-xcode", "install", "install-dir",
  "no-safari-restart", "team", "no-shim", "no-oauth-bridge", "keep-module",
  "force", "strict", "verify", "clean",
] as const;

// Boolean-typed config keys (mirror the `type: "boolean"` entries in parseArgs). A
// config value for these must be a real boolean: a string like "false" is truthy in
// JS and would silently flip the flag ON. The rest are string-typed.
const BOOLEAN_CONFIG_KEYS = new Set<string>([
  "ci", "zip", "no-build", "open-xcode", "install", "no-safari-restart",
  "no-shim", "no-oauth-bridge", "keep-module", "force", "strict", "verify", "clean",
]);

// Config keys that also have a short CLI alias. Used to detect "the user typed it on
// the CLI" — argv carries the short form (`-o`), never `--output`, in that case.
const CONFIG_SHORT_ALIAS: Record<string, string> = { output: "o" };

// Load a JSON config and overlay it onto parsed CLI values: a value the user
// passed on the CLI always wins (we detect that via argv), config fills the rest.
// Returns the config path used (for messaging) or null if none was loaded.
function applyConfig(
  values: Record<string, unknown>,
  explicitPath: string | undefined,
  argv: string[]
): { path: string | null; applied: Set<string> } {
  const applied = new Set<string>();
  const path = explicitPath ?? (existsSync("viaduct.config.json") ? "viaduct.config.json" : undefined);
  if (!path) return { path: null, applied };
  if (!existsSync(path)) {
    fail(`Config file not found: ${path}`);
    process.exit(2);
  }
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(readFileSync(resolve(path), "utf-8"));
  } catch (e) {
    fail(`Could not parse ${path}: ${(e as Error).message}`);
    process.exit(2);
  }
  const allowed = new Set<string>(CONFIG_KEYS);
  for (const [key, val] of Object.entries(cfg)) {
    if (!allowed.has(key)) {
      warn(`Ignoring unknown config key "${key}" in ${path}.`);
      continue;
    }
    // Validate the value against the flag's declared type, exactly as a typed CLI flag
    // would be. A boolean key set to a string ({"install":"false"}) is truthy in JS and
    // would silently enable the feature — reject it instead of copying it verbatim.
    if (BOOLEAN_CONFIG_KEYS.has(key)) {
      if (typeof val !== "boolean") {
        warn(`Ignoring config "${key}": expected true/false, got ${JSON.stringify(val)}.`);
        continue;
      }
    } else if (typeof val !== "string") {
      warn(`Ignoring config "${key}": expected a string, got ${JSON.stringify(val)}.`);
      continue;
    }
    // A flag the user typed (e.g. --bundle-id) overrides config. parseArgs doesn't
    // record provenance, so scan argv for the long flag — and the short alias (-o),
    // which is the form argv actually carries for aliased flags.
    const short = CONFIG_SHORT_ALIAS[key];
    if (
      argv.includes(`--${key}`) ||
      argv.some((a) => a.startsWith(`--${key}=`)) ||
      // The short alias appears bare (`-o dir`), attached (`-odir`), or grouped
      // behind boolean shorts (`-qo dir`, `-qvodir`) — parseArgs accepts all of
      // these, so all must count as "the user typed it".
      (short !== undefined && argv.some((a) => new RegExp(`^-(?!-)[A-Za-z]*${short}`).test(a)))
    ) continue;
    values[key] = val;
    applied.add(key);
  }
  return { path, applied };
}

function pkgVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

// Apple bundle ids are reverse-DNS: dot-separated segments of letters, digits and
// hyphens. No spaces, underscores, leading/trailing/empty dots. A segment that
// starts with a digit is rejected by parts of Apple's toolchain (defaultBundleId
// strips leading digits for exactly this reason) — so require each segment to
// start with a letter, keeping the manual --bundle-id path as strict as the auto
// one. Xcode silently fails the build on an invalid id, so reject it up front.
const BUNDLE_ID_RE = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/;

// Apple version strings are 1–3 dot-separated non-negative integers.
const SAFARI_VERSION_RE = /^\d+(\.\d+){0,2}$/;

// Apple Developer Team IDs are exactly 10 uppercase alphanumeric characters.
const TEAM_ID_RE = /^[A-Z0-9]{10}$/;

const HELP = `viaduct — convert a Chrome extension to a Safari Web Extension

USAGE
  viaduct <input> [options]
  viaduct <in1> <in2> …             # batch: convert several inputs in one run
  viaduct <input> --analyze         # report only, no conversion
  viaduct --doctor                  # check local toolchain
  viaduct --list                    # list registered Safari Web Extensions
  viaduct --uninstall <AppName>     # remove a previously installed app

INPUT
  A .zip, .crx, .xpi, an unpacked extension directory, or a URL (type detected by magic bytes).
  URLs may be a Chrome Web Store link (https://chromewebstore.google.com/detail/<name>/<id>)
  or a direct .crx / .zip download link; the source is fetched automatically.

OPTIONS
  -o, --output <dir>        Output directory (default: ./<AppName>_Safari)
      --bundle-id <id>      Reverse-DNS bundle id (default: com.viaduct.<app>)
      --app-name <name>     Host app name (default: extension name)
      --min-safari <ver>    Safari strict_min_version (default: ${DEFAULT_MIN_SAFARI_VERSION}; use 18.4 for world:MAIN)
      --platforms <p>       all | macos | ios            (default: macos)
      --ci                  Clean-copy resources into the project (CI/TestFlight-safe).
                            Default symlinks resources instead, for live dev edits.
      --temp-load           Stage only, for Safari 18 "Add Temporary Extension…" (no Xcode)
      --zip                 Also emit a distributable .zip of the staged extension
      --clean               Wipe the output directory before staging (drop stale leftovers)
      --no-build            Generate the Xcode project but do not run xcodebuild
      --open-xcode          Open the generated .xcodeproj in Xcode when done
      --install             Install the built app to ~/Applications + register it with Safari
      --verify              After --install, check Safari registered/enabled the extension
      --install-dir <dir>   Install target directory (default: ~/Applications)
      --no-safari-restart   With --install, don't quit/relaunch Safari or set the unsigned toggle
      --team <id>           Sign with an Apple Developer Team ID (real signing → the
                            extension persists across Safari quits; no unsigned toggle).
                            Use --team auto (or plain --install) to auto-detect the team
                            from Xcode, a provisioning profile, or your signing
                            certificate; when nothing is found the run warns and falls
                            back to ad-hoc. The signature is checked against the built
                            app, so a team that did reach xcodebuild but came out ad-hoc
                            fails. Omit for ad-hoc signing. Free personal teams expire
                            ~7 days.
      --no-shim             Do not generate/inject the compatibility shim
      --no-oauth-bridge     Do not wire the Safari OAuth/externally_connectable bridge
      --keep-module         Keep background.type:"module" (default strips it)
      --force               Convert despite blocking errors
      --strict              Treat warnings as blocking too (CI gate). With --analyze,
                            exit 1 if any warning/error is present.
      --analyze             Analyze and report only (also previews the manifest rewrites)
      --json                With --analyze, print a machine-readable JSON report
      --report <file>       With --analyze, also write the report to <file> (.json if --json, else Markdown)
      --config <file>       Load defaults from <file> (default: ./viaduct.config.json if present).
                            JSON keyed by long-flag name; CLI flags override it.
      --doctor              Verify xcrun/packager/xcodebuild availability
      --list                List Safari Web Extensions registered with pluginkit
      --uninstall <name>    Remove the installed <name>.app + unregister it (use with --install-dir)
  -q, --quiet               Suppress progress messages (warnings/errors still print)
  -v, --verbose             Verbose output
  -h, --help                Show this help
      --version             Print the viaduct version and exit
`;

function doctor(): number {
  const checks: Array<[string, () => boolean, string]> = [
    ["xcrun", () => run("xcrun", ["--version"]).code === 0, "Install Xcode command line tools."],
    [
      "safari-web-extension-packager",
      () => run("xcrun", ["--find", "safari-web-extension-packager"]).code === 0,
      "Requires a full Xcode install (not just CLT).",
    ],
    ["xcodebuild", () => run("xcodebuild", ["-version"]).code === 0, "Requires full Xcode."],
    ["plutil", () => commandExists("plutil"), "Part of macOS."],
    ["pluginkit", () => run("/usr/bin/which", ["pluginkit"]).code === 0, ""],
    ["ditto", () => commandExists("ditto"), "Part of macOS."],
    ["osascript", () => commandExists("osascript"), "Part of macOS."],
    ["lsregister", () => existsSync(LSREGISTER), "Part of macOS LaunchServices."],
  ];
  let allOk = true;
  for (const [name, fn, hint] of checks) {
    if (fn()) ok(name);
    else {
      fail(`${name} — ${hint}`);
      allOk = false;
    }
  }
  return allOk ? 0 : 1;
}

function analyzeOnly(
  input: string,
  platforms: Platforms,
  json: boolean,
  strict: boolean,
  keepModuleBackground: boolean,
  reportPath?: string
): number {
  const scratch = mkdtempSync(join(tmpdir(), "viaduct-"));
  try {
    let extPath: string;
    let manifest;
    try {
      extPath = extractExtension(resolve(input), scratch);
      manifest = loadManifest(extPath);
    } catch (e) {
      const msg = (e as Error).message;
      // In JSON mode always emit parseable output so a CI consumer never gets a
      // bare stack trace on a corrupt archive / missing manifest.
      if (json) console.log(JSON.stringify({ error: msg, convertible: false }, null, 2));
      else fail(msg);
      return 1;
    }
    const name = resolveI18nString(manifest.name, extPath, manifest.default_locale) ?? manifest.name ?? "Unknown";
    if (!json) info(`${name} (MV${manifest.manifest_version ?? 3})`);
    const { issues: mIssues, permissionsToRemove } = analyzeManifest(manifest);
    const issues = [...mIssues, ...scanExtension(extPath, manifest, platforms)];

    // Preview the real manifest rewrites the converter would apply. transformManifest
    // deep-clones its input and only reads from extPath, so this is side-effect-free.
    const transformed = transformManifest(manifest, permissionsToRemove, extPath, {
      keepModuleBackground,
    });
    const changes = summarizeManifestChanges(manifest, transformed);

    // Mirror the real conversion gate: an auto-fixed issue (e.g. the MV2 persistent
    // background that transformManifest rewrites) is NOT blocking, so --analyze and
    // an actual convert agree on the exit code.
    const blockingCount = countBlocking(issues, strict);
    if (json) {
      const counts = { error: 0, warning: 0, info: 0 };
      let autoFixed = 0;
      let shimmed = 0;
      for (const i of issues) {
        counts[i.severity]++;
        if (i.shimmed) shimmed++;
        else if (i.autoFixed) autoFixed++;
      }
      const appName = deriveAppName(name);
      const payload = {
        name,
        appName,
        bundleId: defaultBundleId(appName),
        version: manifest.version,
        manifestVersion: manifest.manifest_version ?? 3,
        platforms,
        counts,
        autoFixed,
        shimmed,
        blocking: blockingCount,
        convertible: blockingCount === 0,
        removedPermissions: permissionsToRemove,
        manifestChanges: changes,
        issues,
      };
      const out = JSON.stringify(payload, null, 2);
      console.log(out);
      if (reportPath) writeAnalyzeReport(reportPath, out);
    } else {
      printIssues(issues, strict);
      if (changes.length > 0) {
        console.log(`\n${color("blue", `Manifest changes the converter would apply (${changes.length})`)}`);
        for (const c of changes) console.log(`  • ${c}`);
      }
      if (reportPath) {
        const md = buildReportMarkdown(
          {
            name,
            version: manifest.version,
            manifestVersion: manifest.manifest_version ?? 3,
            platforms,
            removedPermissions: permissionsToRemove,
            manifestChanges: changes,
            strict,
          },
          issues
        );
        writeAnalyzeReport(reportPath, md);
      }
    }
    return blockingCount > 0 ? 1 : 0;
  } finally {
    if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  }
}

function writeAnalyzeReport(path: string, content: string): void {
  try {
    writeFileSync(resolve(path), content, "utf-8");
    ok(`Report written → ${path}`);
  } catch (e) {
    warn(`Could not write report to ${path}: ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        output: { type: "string", short: "o" },
        "bundle-id": { type: "string" },
        "app-name": { type: "string" },
        "min-safari": { type: "string" },
        platforms: { type: "string", default: "macos" },
        ci: { type: "boolean", default: false },
        "temp-load": { type: "boolean", default: false },
        zip: { type: "boolean", default: false },
        clean: { type: "boolean", default: false },
        "no-build": { type: "boolean", default: false },
        "open-xcode": { type: "boolean", default: false },
        install: { type: "boolean", default: false },
        "install-dir": { type: "string" },
        "no-safari-restart": { type: "boolean", default: false },
        team: { type: "string" },
        verify: { type: "boolean", default: false },
        config: { type: "string" },
        "no-shim": { type: "boolean", default: false },
        "no-oauth-bridge": { type: "boolean", default: false },
        "keep-module": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        strict: { type: "boolean", default: false },
        analyze: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        report: { type: "string" },
        doctor: { type: "boolean", default: false },
        list: { type: "boolean", default: false },
        uninstall: { type: "string" },
        quiet: { type: "boolean", short: "q", default: false },
        verbose: { type: "boolean", short: "v", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", default: false },
      },
    });
  } catch (e) {
    fail((e as Error).message);
    console.log(HELP);
    process.exit(2);
  }

  const { values, positionals } = parsed;
  setVerbose(values.verbose);
  setQuiet(values.quiet && !values.verbose);

  // Overlay config before validation so config-supplied bundle-id/team/etc. are
  // validated like CLI ones. Meta flags (--version/--help/--doctor/--list/
  // --uninstall/--analyze) run below and ignore config; that's fine.
  const { path: configPath, applied: configApplied } = applyConfig(values as Record<string, unknown>, values.config, process.argv.slice(2));
  if (configPath) info(`Using config ${configPath}`);

  if (values.version) {
    console.log(pkgVersion());
    process.exit(0);
  }
  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (values.doctor) process.exit(doctor());
  if (values.list) {
    const exts = listSafariExtensions();
    if (exts.length === 0) {
      info("No Safari Web Extensions are registered with this user.");
    } else {
      info(`Registered Safari Web Extensions (${exts.length}):`);
      for (const e of exts) console.log(`  ${e.bundleId}\n    ${color("dim", e.path)}`);
    }
    process.exit(0);
  }
  if (values.uninstall !== undefined) {
    const name = values.uninstall.trim();
    if (!name) {
      fail("--uninstall needs an app name (e.g. --uninstall \"My Extension\").");
      process.exit(1);
    }
    process.exit(uninstallFromSafari(name, values["install-dir"]) ? 0 : 1);
  }

  const inputs = positionals;
  if (inputs.length === 0) {
    fail("Missing <input> (a .zip, .crx, extension directory, or URL).");
    console.log(HELP);
    process.exit(2);
  }
  // Existence is checked per-input inside the loop below so one bad input doesn't
  // abort the rest of a batch (matches the mid-batch download-failure handling).

  const platforms = values.platforms as Platforms;
  if (!["all", "macos", "ios"].includes(platforms)) {
    fail(`Invalid --platforms "${platforms}". Use all | macos | ios.`);
    process.exit(2);
  }

  if (values.install && (values["no-build"] || values["temp-load"])) {
    fail("--install requires a build; remove --no-build / --temp-load.");
    process.exit(2);
  }

  if (values.install && platforms === "ios") {
    fail("--install targets macOS Safari; use --platforms macos or all.");
    process.exit(2);
  }

  if (values.verify && !values.install) {
    fail("--verify requires --install (it checks the installed extension).");
    process.exit(2);
  }

  if (values["bundle-id"] !== undefined && !BUNDLE_ID_RE.test(values["bundle-id"])) {
    fail(`Invalid --bundle-id "${values["bundle-id"]}". Use reverse-DNS (e.g. com.example.myext): letters/digits/hyphens, dot-separated, 2+ segments.`);
    process.exit(2);
  }

  if (values["min-safari"] !== undefined && !SAFARI_VERSION_RE.test(values["min-safari"])) {
    fail(`Invalid --min-safari "${values["min-safari"]}". Use a version like 15.4 or 18.4 (1–3 numbers).`);
    process.exit(2);
  }

  if (values.team !== undefined && values.team !== "auto" && !TEAM_ID_RE.test(values.team)) {
    fail(`Invalid --team "${values.team}". Use a 10-character Apple Team ID (e.g. A1B2C3D4E5) or "auto".`);
    process.exit(2);
  }

  if (values.json && !values.analyze) {
    fail("--json is only valid with --analyze.");
    process.exit(2);
  }

  if (values.report !== undefined && !values.analyze) {
    fail("--report is only valid with --analyze.");
    process.exit(2);
  }

  // Single-file outputs can't hold multiple extensions, so forbid them in batch.
  if (inputs.length > 1) {
    // Config-file values are shared defaults; the per-extension ones can't apply
    // to a batch. Drop them with a note — only a flag the user actually typed
    // should hard-fail the run.
    for (const key of ["output", "app-name", "bundle-id"] as const) {
      if (configApplied.has(key) && values[key] !== undefined) {
        warn(`Config "${key}" ignored for batch runs (it applies to a single extension).`);
        (values as Record<string, unknown>)[key] = undefined;
      }
    }
    if (values.output !== undefined) {
      fail("--output names a single directory; omit it for batch (each extension gets its default ./<App>_Safari).");
      process.exit(2);
    }
    if (values.report !== undefined) {
      fail("--report names a single file; omit it for batch runs.");
      process.exit(2);
    }
    if (values.json) {
      // Each input prints a standalone JSON object, so a batch stream is multiple
      // top-level objects — unparseable by `jq`. Run inputs one at a time for JSON.
      fail("--json emits one object per extension; run a single extension at a time for parseable JSON.");
      process.exit(2);
    }
    if (values["app-name"] !== undefined || values["bundle-id"] !== undefined) {
      fail("--app-name / --bundle-id apply to one extension; omit them for batch (names are derived per-extension).");
      process.exit(2);
    }
  }

  // Every report of "your fix didn't work" starts with figuring out which version
  // actually ran, and nothing in a run used to say. The GUI compounds it: it updates
  // its bundled CLI in the background, so the user cannot know which one their
  // conversion used either. One line on stderr — it lands in a pasted terminal log and
  // in the app's log pane, and stdout stays clean for --analyze --json.
  info(`viaduct ${pkgVersion()}`);

  // Team detection is the same for every input; do it once up front. Remember
  // whether a team was asked for even after the fallback clears it, so the
  // signature check can tell "ad-hoc because you asked" from "ad-hoc because we
  // gave up" from "ad-hoc even though a team reached xcodebuild".
  const teamRequested = !values.analyze && (values.team !== undefined || Boolean(values.install));
  let team = values.team;
  let teamFallback = false;
  if (!values.analyze && (team === "auto" || (team === undefined && values.install))) {
    const detected = detectXcodeTeam();
    if (detected) {
      team = detected;
      info(`Auto-detected Apple Team ID ${detected} → team-signing (persists across Safari quits).`);
    } else {
      teamFallback = true;
      team = undefined;
      if (values.team === "auto") {
        warn(
          "No Apple team found in Xcode or the keychain; falling back to ad-hoc signing.\n" +
            "  Already signed in to Xcode? The team id is only cached once Xcode has provisioned\n" +
            "  something. Open Xcode → Settings → Accounts, select the account, Manage Certificates\n" +
            "  → + → Apple Development, then re-run. Or pass the id directly with --team <TEAMID>\n" +
            "  (developer.apple.com → Account → Membership details).",
        );
      }
    }
  }

  // Process each input independently and remember whether it succeeded. One bad
  // input doesn't abort the rest of a batch; the exit code is non-zero if any failed.
  const batch = inputs.length > 1;
  let anyFailed = false;
  // Download scratch dirs in flight. Each is removed per-iteration in a finally, but a
  // process.exit() on an error path skips that finally — a single exit handler drains
  // whatever is still tracked, so nothing leaks no matter which path exits. (One
  // handler, not one-per-input: avoids Node's MaxListenersExceededWarning on big
  // URL batches and frees each archive as soon as its conversion finishes.)
  const liveScratch = new Set<string>();
  // One dir failing to remove (EPERM/EBUSY) must not abort cleanup of the rest.
  process.on("exit", () => { for (const d of liveScratch) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });
  // Signal death skips 'exit' handlers entirely (Ctrl-C mid-download leaked the
  // scratch dir). Route signals through process.exit so the cleanup above runs;
  // deferred one tick so convert()'s own SIGINT cleanup (registered later, exits
  // itself) still runs first when a conversion is in flight.
  const onSignal = () => { setImmediate(() => process.exit(130)); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  for (const input of inputs) {
    if (batch) console.error(`\n${color("bold", `── ${basename(input)} ──`)}`);

    // Per-input existence check (batch-aware): a missing local path fails just this
    // input and the batch continues, mirroring the download-failure handling below.
    if (!isUrl(input) && !existsSync(input)) {
      fail(`Input not found: ${input}`);
      if (!batch) process.exit(1);
      anyFailed = true;
      continue;
    }

    let localInput = input;
    let dlScratch: string | undefined;
    try {
    if (isUrl(input)) {
      info(`Downloading extension from ${input} …`);
      dlScratch = mkdtempSync(join(tmpdir(), "c2s-dl-"));
      liveScratch.add(dlScratch);
      try {
        localInput = await downloadExtension(input, dlScratch);
      } catch (e) {
        fail((e as Error).message);
        if (!batch) process.exit(1);
        anyFailed = true;
        continue;
      }
      ok(`Downloaded → ${basename(localInput)}`);
    }

    if (values.analyze) {
      const code = analyzeOnly(localInput, platforms, values.json, values.strict, values["keep-module"], values.report);
      if (code !== 0) anyFailed = true;
      continue;
    }

    let result;
    try {
      result = convert({
        input: localInput,
        output: values.output,
        bundleId: values["bundle-id"],
        appName: values["app-name"],
        minSafariVersion: values["min-safari"],
        platforms,
        copyResources: values.ci, // default false → symlink dev mode
        tempLoadOnly: values["temp-load"],
        generateShim: !values["no-shim"],
        oauthBridge: !values["no-oauth-bridge"],
        build: !values["no-build"],
        install: values.install,
        installDir: values["install-dir"],
        safariRestart: !values["no-safari-restart"],
        team,
        force: values.force,
        strict: values.strict,
        clean: values.clean,
        zip: values.zip,
        openXcode: values["open-xcode"],
        keepModuleBackground: values["keep-module"],
      });
    } catch (e) {
      fail((e as Error).message);
      if (!batch) process.exit(1);
      anyFailed = true;
      continue;
    }

    console.log("");
    if (result.success) {
      ok(color("bold", `Done: ${result.extensionName}`));
      if (result.installedAppPath) {
        console.log(`  Installed: ${result.installedAppPath}`);
        console.log("  Safari → Settings → Extensions → enable the extension.");
        if (result.needsWebsiteAccessGrant) {
          console.log("  Then grant website access (Safari defaults to Ask — until allowed, content");
          console.log("  scripts and external API calls silently do nothing): click the extension's");
          console.log('  toolbar icon → "Always Allow on Every Website", or Settings → Extensions →');
          console.log("  the extension → Edit Websites.");
        }
        if (team) {
          console.log("  Team-signed: stays enabled across Safari quits (no unsigned toggle).");
          console.log("  Free personal team: re-run this command to re-sign before the ~7-day profile expires.");
        } else {
          console.log('  After each Safari restart, re-tick Develop → "Allow Unsigned Extensions".');
        }
      } else if (result.appPath) {
        console.log(`  App:    ${result.appPath}`);
        console.log(`  Install: re-run with --install, or  cp -R "${result.appPath}" ~/Applications/`);
        console.log("  Then: Safari → Settings → Extensions → enable.");
        if (result.needsWebsiteAccessGrant) {
          console.log('  And grant website access (toolbar icon → "Always Allow on Every Website") — Safari defaults to Ask.');
        }
      } else if (result.xcodeProject) {
        console.log(`  Project: ${result.xcodeProject}`);
      } else if (result.stagedPath) {
        console.log(`  Staged:  ${result.stagedPath}`);
      }
      if (result.zipPath) console.log(`  Zip:     ${result.zipPath}`);

      // The build succeeded but the requested install didn't land — that's a failure
      // for the user's intent, so exit non-zero (the warning already printed above).
      if (result.installFailed) anyFailed = true;

      // Same category, and deliberately not behind --verify: a run that asked for
      // team signing and produced an ad-hoc bundle did not do what it was asked.
      // Detection only predicts how the build will be signed, so read the signature
      // back off the artifact — an ad-hoc install looks perfectly fine right up until
      // Safari next quits and drops the extension.
      const signedArtifact = result.installedAppPath ?? result.appPath;
      if (teamRequested && signedArtifact) {
        if (!verifySigning(signedArtifact, { wantsTeam: team !== undefined, teamId: team, fellBack: teamFallback }))
          anyFailed = true;
      }

      if (values.verify) {
        if (result.installedAppPath && result.resolvedBundleId) {
          const v = verifyInSafari(result.resolvedBundleId);
          // A registered-but-disabled extension won't run — fail the verify the user
          // asked for. enabled===null is best-effort-unknown (verify.ts contract), not a
          // failure.
          if (!v.registered || v.enabled === false) anyFailed = true;
        } else {
          // --verify was requested but there's nothing installed to verify (install
          // failed). Don't silently skip it — that's the check the user asked for.
          fail("--verify could not run: the extension was not installed.");
          anyFailed = true;
        }
      }
    } else {
      fail("Conversion did not complete. See messages above.");
      anyFailed = true;
    }
    } finally {
      // Free this input's downloaded archive now (not deferred to process exit), so a
      // long batch doesn't accumulate every download's scratch dir on disk. A `continue`
      // above still runs this; only a process.exit() skips it (the exit handler covers
      // that path via liveScratch).
      if (dlScratch) { rmSync(dlScratch, { recursive: true, force: true }); liveScratch.delete(dlScratch); }
    }
  }

  if (batch) {
    const n = inputs.length;
    if (anyFailed) fail(`Batch finished with failures (${n} input(s)). See messages above.`);
    else ok(color("bold", `Batch complete: ${n} extension(s).`));
  }
  // process.exit() truncates pending async stdout writes (a piped --analyze
  // --json payload is exactly that); set the code and let the process drain.
  process.exitCode = anyFailed ? 1 : 0;
}

main().catch((e) => {
  fail((e as Error).message);
  process.exit(1);
});
