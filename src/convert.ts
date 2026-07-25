import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, basename, sep } from "node:path";
import type { ConvertOptions, ConvertResult, Issue } from "./types.js";
import { extractExtension } from "./input/extract.js";
import { loadManifest, analyzeManifest, transformManifest, writeManifest, resolveI18nString, collectReferencedPaths } from "./manifest/manifest.js";
import { scanExtension } from "./analyze/analyze.js";
import { stageExtension, stripDanglingSourcemaps, inlineImmutableEnums, rewriteRuntimeIdUrlMatchers, rewriteChromeSchemeLiterals, guardAncestorOriginsAccess, rewriteSelfPageExtensionUrls, idempotentContentScriptGlobals, guardLocaleTailMessage } from "./input/stage.js";
import { writeShim, writePolyfill, injectShimIntoHtmlPages, injectPopupSizing, convertServiceWorkerToBackgroundPage, wireActionClickBridge, wireActionHotkey, wirePageWorldMainInjection, wireUserScriptsContentScript, wireCdpKeepalive, deriveProxyHosts } from "./runtime/shim.js";
import { applyOAuthBridge, deriveChromeId } from "./runtime/oauth-bridge.js";
import { applyDnr } from "./manifest/dnr.js";
import { synthesizePlaceholderIcons } from "./input/icons.js";
import { writeTempLoadInstructions } from "./build/tempload.js";
import { installToSafari, installBrokerAgent } from "./build/installer.js";
import {
  runPackager,
  patchProjectBundleIds,
  setBuildVersion,
  writeNativeHandler,
  writeAppBroker,
  unsandboxAppTarget,
  buildXcodeProject,
  verifyBuiltBundleId,
  pluginkitStatus,
  unsignedExtensionsAllowed,
  defaultBundleId,
  deriveAppName,
} from "./build/packager.js";
import { printIssues, countBlocking, writeReportFile } from "./analyze/report.js";
import { info, ok, warn, fail, moveBundle, run } from "./util.js";

export function convert(opts: ConvertOptions): ConvertResult {
  const result: ConvertResult = {
    success: false,
    extensionName: "Unknown",
    manifestVersion: 3,
    issues: [],
  };

  const scratch = mkdtempSync(join(tmpdir(), "viaduct-"));
  // Throwaway DerivedData from buildXcodeProject; removed once the built app is moved out.
  let derivedDir: string | undefined;
  const cleanup = () => {
    if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
    if (derivedDir && existsSync(derivedDir)) rmSync(derivedDir, { recursive: true, force: true });
  };
  const onSignal = () => {
    cleanup();
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    info(`Extracting ${basename(opts.input)} …`);
    const extPath = extractExtension(resolve(opts.input), scratch);

    const manifest = loadManifest(extPath);
    result.extensionName = resolveI18nString(manifest.name, extPath, manifest.default_locale) ?? manifest.name ?? "Unknown";
    result.manifestVersion = manifest.manifest_version ?? 3;
    ok(`Loaded "${result.extensionName}" (MV${result.manifestVersion})`);

    // Compute the real Chrome id NOW, before transformManifest strips the `key`.
    // Used to bake the original id into the OAuth bridge templates so pages that
    // check chrome.runtime.id keep working after conversion.
    const chromeId = deriveChromeId(manifest);

    const { issues: manifestIssues, permissionsToRemove, needsCdpShim } = analyzeManifest(manifest);
    const issues: Issue[] = [...manifestIssues, ...scanExtension(extPath, manifest, opts.platforms)];
    result.issues = issues;

    // Safari gates every website match pattern behind a per-user grant defaulting
    // to "Ask": until the user allows website access, content scripts never inject
    // and cross-origin API fetches stay CORS-blocked — which reads as "the
    // extension doesn't work" (live report: TWP translate). Flag it so the CLI's
    // Done block spells out the grant step, not just "enable the extension".
    const isMatchPattern = (p: unknown): boolean =>
      typeof p === "string" && (p === "<all_urls>" || /^(\*|https?|wss?|ftp):\/\//.test(p));
    // The CDP executor injects into arbitrary tabs via chrome.scripting, so it needs
    // the same website-access grant even if the source manifest declared no host
    // patterns of its own (a debugger-only extension would otherwise miss this).
    result.needsWebsiteAccessGrant =
      needsCdpShim ||
      (manifest.permissions ?? []).some(isMatchPattern) ||
      (manifest.host_permissions ?? []).some(isMatchPattern) ||
      (manifest.content_scripts ?? []).some((cs) => (cs?.matches ?? []).length > 0);

    const blocking = countBlocking(issues, opts.strict);
    if (blocking > 0 && !opts.force) {
      printIssues(issues);
      const what = opts.strict ? "blocking issue(s) (--strict: warnings count)" : "blocking error(s)";
      fail(`${blocking} ${what}. Re-run with --force to convert anyway.`);
      return result;
    }

    const appName = deriveAppName(opts.appName ?? result.extensionName);
    const bundleId = opts.bundleId ?? defaultBundleId(appName);
    result.resolvedBundleId = bundleId;

    const outputDir = resolve(opts.output ?? join(process.cwd(), `${appName}_Safari`));

    // Refuse overlapping input/output BEFORE anything destructive. Re-converting a
    // previous run's staged_extension with the same output dir would rmSync the
    // input (stageExtension recreates stageDir fresh; --clean wipes outputDir);
    // and `cd my-ext && viaduct .` puts stageDir inside the source, which cpSync
    // rejects with a raw ERR_FS_CP_EINVAL. Fail with an actionable message instead.
    const realOrSelf = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
    const realExt = realOrSelf(extPath);
    const realOut = realOrSelf(outputDir);
    const isInside = (child: string, parent: string) => child === parent || child.startsWith(parent + sep);
    if (isInside(realExt, realOut)) {
      fail(`Input extension (${extPath}) lives inside the output directory (${outputDir}); converting would delete it. Pass -o <dir> outside the input.`);
      return result;
    }
    if (isInside(realOut, realExt)) {
      fail(`Output directory (${outputDir}) is inside the input extension; staging cannot copy a directory into itself. Pass -o <dir> outside the input.`);
      return result;
    }

    if (opts.clean && existsSync(outputDir)) {
      rmSync(outputDir, { recursive: true, force: true });
      ok(`Cleaned output dir → ${outputDir}`);
    }
    mkdirSync(outputDir, { recursive: true });

    // Persistent staged dir (NOT in scratch) so dev-mode symlinks survive cleanup.
    const stageDir = join(outputDir, "staged_extension");
    info("Staging clean extension assets …");
    const droppedAssets = stageExtension(extPath, stageDir, collectReferencedPaths(manifest));
    for (const a of droppedAssets) {
      warn(`Manifest-referenced asset not staged (broken/external symlink or copy error): ${a} — it will 404 in Safari.`);
    }

    // Safari's chrome.scripting is an immutable host slot — the shim can't add the
    // ExecutionWorld/RegistrationWorld enums, so bundles reading
    // chrome.scripting.ExecutionWorld.ISOLATED hit `undefined.ISOLATED`. Inline those
    // reads to their literal string values in the staged source (the shim handles the
    // mutable-namespace cases; this covers the immutable ones).
    const inlined = inlineImmutableEnums(stageDir);
    if (inlined > 0) ok(`Inlined immutable scripting enums in ${inlined} script(s)`);

    // Safari's chrome.runtime.id is the bundle id, not the URL-host UUID, so bundles that
    // route extension-page ports via `new RegExp(runtime.id + "/src/popup.html").test(
    // sender.url)` never match → popup/side-panel ports go unrouted and their init RPCs
    // hang. runtime.id is a frozen exotic slot the shim can't rewrite, so strip the
    // `runtime.id +` prefix here, making the matcher host-agnostic + query-tolerant.
    const rerouted = rewriteRuntimeIdUrlMatchers(stageDir);
    if (rerouted > 0) ok(`Rewrote runtime.id-based port matchers in ${rerouted} script(s)`);

    // Compiled bundles hardcode "chrome-extension:" when classifying their own pages
    // (sender.url prefix checks, internal-protocol tables). Safari pages are
    // safari-web-extension://, so those checks all fail and background dispatchers
    // refuse popup/options RPCs (Tampermonkey: blank action popup). Rewrite the
    // scheme literal in the staged sources — before writeShim/writePolyfill below,
    // whose templates carry chrome-extension:// on purpose.
    const reschemed = rewriteChromeSchemeLiterals(stageDir);
    if (reschemed > 0) ok(`Rewrote chrome-extension: scheme literals in ${reschemed} script(s)`);

    // The scheme rewrite above skips `chrome-extension://${id}/…` (could be an OAuth
    // redirect_uri). But when that literal is the WHOLE URL of a self-page navigation
    // (tabs.create/window.open), it must become runtime.getURL — otherwise it opens a
    // dead chrome-extension://<bundle-id>/page.html tab in Safari (SF Inspector's
    // keyboard-command page opens).
    const selfPaged = rewriteSelfPageExtensionUrls(stageDir);
    if (selfPaged > 0) ok(`Rewrote self-page chrome-extension: URLs to runtime.getURL in ${selfPaged} script(s)`);

    // Safari extension pages are top-level, so location.ancestorOrigins is an empty (but
    // present) DOMStringList: ancestorOrigins?.[0] is undefined and the trailing string
    // method throws at module load, leaving a blank popup. Guard the [0] read so the call
    // sees "" (Salesforce Inspector Reloaded: blank action popup).
    const guardedAncestors = guardAncestorOriginsAccess(stageDir);
    if (guardedAncestors > 0) ok(`Guarded location.ancestorOrigins[0] reads in ${guardedAncestors} script(s)`);

    // Safari drops the last entry of each _locales/<locale>/messages.json, so whatever
    // string happens to be last in the file resolves to "" and the extension renders
    // its raw message key (Tampermonkey's dashboard showed a literal "v0version0" for
    // its version). Append a sacrificial message to take the hit.
    const guardedLocales = guardLocaleTailMessage(stageDir);
    if (guardedLocales > 0) ok(`Guarded the last message in ${guardedLocales} locale catalog(s) (Safari drops it)`);

    // Derived once and shared by the shim allowlist (below) and the Swift native
    // allowlist (later). transformManifest deep-clones its input, so the value is
    // identical at both points — no reason to recompute.
    const proxyHosts = deriveProxyHosts(manifest);

    let shimFile: string | undefined;
    let polyfillFile: string | undefined;
    if (opts.generateShim) {
      polyfillFile = writePolyfill(stageDir);
      if (polyfillFile) ok("Bundled webextension-polyfill (browser.* promises on all browsers)");
      shimFile = writeShim(stageDir, {
        chromeOrigin: chromeId ? `chrome-extension://${chromeId}` : "",
        proxyHosts,
        cdp: needsCdpShim,
      });
      const n = injectShimIntoHtmlPages(stageDir, polyfillFile);
      if (n > 0) ok(`Shim${polyfillFile ? " + polyfill" : ""} injected into ${n} HTML page(s)`);
      if (needsCdpShim) ok("chrome.debugger detected \u2192 enabled CDP emulation shim (kept scripting + <all_urls>)");
    }

    const transformed = transformManifest(manifest, permissionsToRemove, stageDir, {
      keepModuleBackground: opts.keepModuleBackground,
      shimFile,
      polyfillFile,
      minSafariVersion: opts.minSafariVersion,
      cdpShim: needsCdpShim,
    });

    // Safari re-evaluates a document_end/idle content-script group a second time into the
    // same isolated world (about:blank/srcdoc subframes on all_frames pages), which throws
    // on any top-level const/let and kills the group. Demote those to var so the second
    // eval is a no-op (TWP: twpI18n / startMark duplicate-variable crash).
    const idempotent = idempotentContentScriptGlobals(stageDir, transformed);
    if (idempotent > 0) ok(`Made top-level content-script globals re-injection-safe in ${idempotent} script(s)`);

    const dnrNotes = applyDnr(stageDir, transformed);
    for (const n of dnrNotes) warn(n);

    if (opts.oauthBridge !== false) {
      const bridgeNotes = applyOAuthBridge(stageDir, transformed, chromeId);
      for (const n of bridgeNotes) ok(n);
    }

    // Prefer the popover-free in-page hotkey. Only fall back to the synthetic popup (which
    // makes the toolbar button work but forces Safari's un-closable popover) when the
    // hotkey can't be wired.
    const hotkey = wireActionHotkey(stageDir, transformed);
    if (hotkey) {
      ok(`Action hotkey: ${hotkey} toggles the extension in-page (popover-free — the toolbar button stays inert to avoid Safari's un-closable popover)`);
    } else if (wireActionClickBridge(stageDir, transformed)) {
      ok("Action-click bridge: synthetic popup replays action.onClicked (Safari won't fire it on the toolbar button; shows a brief popover)");
    }

    if (convertServiceWorkerToBackgroundPage(stageDir, transformed, polyfillFile)) {
      ok("Service worker → persistent background page (Safari reachability)");
    }

    if (needsCdpShim && wireCdpKeepalive(stageDir, transformed)) {
      ok("CDP keep-alive content script wired (holds Safari background loaded during debugger sessions)");
    }

    // Content scripts that inject a page-world <script src=getURL(X)> are CSP-blocked in
    // Safari (Chrome exempts web-accessible-resource scripts from the page CSP; Safari
    // doesn't). Re-declare each X as a world:"MAIN" content script, which Safari runs
    // CSP-exempt (Jump Cutter's MediaSource-clone bridge on YouTube).
    const mainWorld = wirePageWorldMainInjection(stageDir, transformed);
    if (mainWorld.length > 0) {
      ok(`Page-world injection → world:"MAIN" content script (Safari 18.4+, CSP-exempt): ${mainWorld.join(", ")}`);
    }

    // chrome.userScripts has no way to reach the page on its own: Safari delivers no
    // navigation event to a converted background page, so the registry can't inject from
    // one. A declared content script does run, so give the registry one to serve.
    if (wireUserScriptsContentScript(stageDir, transformed, manifest)) {
      ok("chrome.userScripts → content-script injector wired (registry published to storage)");
    }

    const synthIcons = synthesizePlaceholderIcons(stageDir, transformed, appName);
    if (synthIcons.length > 0) ok(`Synthesized placeholder icons (${synthIcons.join("/")}px) — manifest had none`);

    const strippedMaps = stripDanglingSourcemaps(stageDir);
    if (strippedMaps > 0) ok(`Stripped dangling sourcemap refs from ${strippedMaps} script(s)`);

    writeManifest(stageDir, transformed);
    const popupFile = (transformed.action ?? transformed.browser_action)?.default_popup;
    if (popupFile && popupFile !== "__viaduct-action.html") {
      // A SIDE-PANEL page wired as the popup needs an explicit height or its
      // height:100% layout collapses in a popover (Claude's sidepanel.html). Gate
      // strictly on the side_panel manifest field OR a "side panel" filename —
      // NOT generic names like index.html (that would blow up normal popups like
      // Urban VPN's). Everything else gets the floor-only treatment.
      const panelPath = transformed.side_panel?.default_path;
      const stripFrag = (p?: string) => (typeof p === "string" ? p.split(/[#?]/)[0].replace(/^\//, "") : p);
      const base = stripFrag(popupFile) ?? "";
      const isSidePanel =
        (!!panelPath && stripFrag(panelPath) === base) ||
        /(^|\/)side[_-]?panel\.html$/i.test(base);
      // `base` is the fragment/query-stripped on-disk filename; popupFile may carry a
      // #/? that would make injectPopupSizing's readFileSync miss the real file.
      injectPopupSizing(stageDir, base, isSidePanel);
    }
    result.stagedPath = stageDir;
    ok(`Staged → ${stageDir}`);

    const reportPath = writeReportFile(
      outputDir,
      {
        name: result.extensionName,
        version: transformed.version,
        manifestVersion: result.manifestVersion,
        platforms: opts.platforms,
        removedPermissions: permissionsToRemove,
        strict: opts.strict,
      },
      issues
    );
    ok(`Report → ${reportPath}`);

    if (opts.zip) {
      const zipPath = join(outputDir, `${appName}_SafariExtension.zip`);
      if (existsSync(zipPath)) rmSync(zipPath, { force: true });
      // ditto -c -k zips the staged dir's CONTENTS (--keepParent off) so the archive
      // unpacks straight to manifest.json — the shape Safari's temp-load expects.
      const z = run("ditto", ["-c", "-k", "--sequesterRsrc", stageDir, zipPath]);
      if (z.code === 0 && existsSync(zipPath)) {
        result.zipPath = zipPath;
        ok(`Zipped staged extension → ${zipPath}`);
      } else {
        warn(`Could not create the extension zip (${z.stderr.trim() || "ditto failed"}).`);
      }
    }

    if (opts.tempLoadOnly) {
      const notes = writeTempLoadInstructions(stageDir);
      ok(`Safari 18+ temp-load ready. See ${notes}`);
      result.success = true;
      printIssues(issues);
      return result;
    }

    info("Running safari-web-extension-packager …");
    const xcodeproj = runPackager({
      stagedDir: stageDir,
      outputDir,
      bundleId,
      appName,
      platforms: opts.platforms,
      copyResources: opts.copyResources,
    });
    if (!xcodeproj) {
      fail("Packager did not produce an Xcode project.");
      printIssues(issues);
      return result;
    }
    result.xcodeProject = xcodeproj;
    ok(`Xcode project → ${xcodeproj}`);

    info("Patching bundle identifiers …");
    patchProjectBundleIds(xcodeproj, bundleId);
    // Unique version per build so Safari reloads the extension's resources. Safari
    // caches the shim/background JS keyed on CFBundleShortVersionString (MARKETING_
    // VERSION), which the packager hardcodes to 1.0 → stale JS survives reinstalls.
    const buildStamp = Math.floor(Date.now() / 1000);
    setBuildVersion(xcodeproj, { short: `1.0.${buildStamp % 10000000}`, build: String(buildStamp) });

    // Native handler in the (sandboxed) appex: an out-of-process HTTP proxy (send the
    // extension's backends the Chrome origin the shim can't set) AND, for native
    // messaging, a client that forwards to the broker in the container app.
    const usesNativeMessaging = (manifest.permissions ?? []).includes("nativeMessaging");
    if (proxyHosts.length > 0 || usesNativeMessaging) {
      // Loopback broker coordinates, baked into BOTH the appex client and the app
      // broker. Derived deterministically from the bundle id (not random) so they
      // always agree even if a stale broker instance from a prior install lingers —
      // and stable across re-installs. Loopback-only + token gates casual local access.
      const coordHash = createHash("sha256").update(bundleId).digest();
      const brokerPort = usesNativeMessaging ? 49152 + (coordHash.readUInt16BE(0) % 16000) : 0;
      const brokerToken = usesNativeMessaging ? coordHash.subarray(0, 16).toString("hex") : "";
      writeNativeHandler(xcodeproj, {
        chromeOrigin: chromeId ? `chrome-extension://${chromeId}` : "",
        allowHosts: proxyHosts,
        nativeMessaging: usesNativeMessaging,
        brokerPort,
        brokerToken,
      });
      const roles = [
        proxyHosts.length > 0 ? `${proxyHosts.length} backend host(s)` : "",
        usesNativeMessaging ? "native-messaging broker client" : "",
      ].filter(Boolean).join(" + ");
      ok(`Native handler wired: ${roles}`);
      if (usesNativeMessaging) {
        // The broker must exec the host + read Chrome's manifest dir — impossible in
        // the sandbox — so it lives in the container app, which we unsandbox (the
        // appex stays sandboxed so Safari still registers it).
        writeAppBroker(xcodeproj, { brokerPort, brokerToken });
        unsandboxAppTarget(xcodeproj);
        ok(`Native-messaging broker installed in the app (loopback :${brokerPort}); app target unsandboxed (appex stays sandboxed).`);
        warn("Native messaging needs the container app running (it hosts the broker) and the companion app's native host installed. The app stays open in the background after you close its window; quitting it stops native messaging.");
      }
    }

    if (opts.openXcode) {
      const o = run("/usr/bin/open", ["-a", "Xcode", xcodeproj]);
      if (o.code === 0) ok("Opened the project in Xcode");
      else warn(`Could not open Xcode (${o.stderr.trim() || `exit ${o.code}`}).`);
    }

    if (!opts.build) {
      ok("Skipping build (--no-build). Open the project in Xcode to build.");
      result.success = true;
      printIssues(issues);
      return result;
    }

    info(opts.team ? `Building (signed: team ${opts.team}) …` : "Building (ad-hoc signed) …");
    const build = buildXcodeProject(xcodeproj, appName, opts.platforms, opts.team);
    if (!build) {
      fail("Build failed. See output above.");
      printIssues(issues);
      return result;
    }
    const builtApp = build.builtApp;
    derivedDir = build.derivedDir;
    ok(`Built & signed → ${builtApp}`);

    // The check v2 lacked: confirm the COMPILED bundle ids match intent (before it moves).
    const v = verifyBuiltBundleId(builtApp, bundleId);
    if (!v.ok) {
      fail("Bundle identifier mismatch in the built app — Safari would register the wrong extension.");
      console.error(`    app  expected ${v.expectedAppId}  got ${v.appId ?? "∅"}`);
      console.error(`    appex expected ${v.expectedExtId} got ${v.extId ?? "∅"}`);
      console.error("    This is the exact failure mode of the previous attempt. Aborting as failed.");
      printIssues(issues);
      return result;
    }
    ok(`Bundle ids verified: ${v.appId} / ${v.extId}`);

    const pk = pluginkitStatus();
    if (pk) info(`pluginkit:\n${pk}`);

    // The unsigned toggle only matters for ad-hoc builds; a team-signed app ignores it.
    if (!opts.team) {
      const allowed = unsignedExtensionsAllowed();
      if (allowed === false) {
        warn('Safari "Allow Unsigned Extensions" is OFF — enable it (Develop menu) or the extension will not load.');
      } else if (allowed === null) {
        warn('Could not read Safari "Allow Unsigned Extensions"; enable it manually for ad-hoc builds.');
      }
    }

    if (opts.install) {
      // Move the Release product straight into ~/Applications — no intermediate copy.
      const inst = installToSafari({
        builtAppPath: builtApp,
        appName,
        bundleId,
        installDir: opts.installDir,
        safariRestart: opts.safariRestart,
        signed: !!opts.team,
      });
      if (inst.installedAppPath) {
        result.appPath = inst.installedAppPath;
        result.installedAppPath = inst.installedAppPath;
        ok(`Installed → ${inst.installedAppPath}`);
        // Keep the broker (in the container app) alive across restarts/idle so the
        // sandboxed appex can always reach it over loopback.
        if (usesNativeMessaging) installBrokerAgent(inst.installedAppPath, bundleId);
      } else {
        // The user asked for --install and it didn't happen. The build is fine, so we
        // still surface the app path, but flag the run as install-failed so the CLI
        // exits non-zero rather than printing "Done" and exiting 0.
        result.installFailed = true;
        const stableApp = join(outputDir, basename(builtApp));
        if (moveBundle(builtApp, stableApp)) {
          result.appPath = stableApp;
        } else {
          // Relocation failed: the only copy is still inside derivedDir, which the
          // finally-cleanup would delete. Keep it by sparing derivedDir, and point
          // the user at the path that will actually survive.
          derivedDir = undefined;
          result.appPath = builtApp;
        }
        warn(`Install did not complete; the built app is at ${result.appPath}.`);
      }
    } else {
      // No install: relocate the signed product out of the throwaway build dir to a
      // stable path in the output dir. A move, not a copy.
      const stableApp = join(outputDir, basename(builtApp));
      if (moveBundle(builtApp, stableApp)) {
        result.appPath = stableApp;
        ok(`Built app → ${stableApp}`);
      } else {
        // Spare derivedDir from cleanup so the only built copy isn't deleted.
        derivedDir = undefined;
        result.appPath = builtApp;
        warn(`Could not relocate the built app; it remains at ${builtApp}.`);
      }
    }

    result.success = true;
    printIssues(issues);
    return result;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    cleanup();
  }
}
