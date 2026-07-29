import { readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Manifest, Issue } from "../types.js";

/**
 * Parse JSON that may carry // and /* *\/ comments or trailing commas — both are
 * illegal in strict JSON but common in hand-edited Chrome manifests (Chrome's own
 * loader tolerates comments). A single character-state scan skips comment runs and
 * trailing commas WITHOUT touching their look-alikes inside string literals (e.g.
 * the "//" in an "https://…" URL), then hands clean JSON to JSON.parse.
 */
export function parseJsonc<T = unknown>(text: string): T {
  // Strip a leading UTF-8 BOM (U+FEFF). Node's readFileSync('utf-8') leaves it in
  // place and it is none of "/,; so it survives the scan and makes JSON.parse throw
  // on the first char. BOMs are common in Windows-edited manifests / messages.json,
  // and Chrome's own loader tolerates them — match that.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n"; // preserve line numbering for parse errors
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // land on the '/', loop's i++ steps past it
      continue;
    }
    if (c === ",") {
      // Trailing comma? Peek past whitespace AND any comments; drop the comma when
      // the next significant character closes an object/array. Done in-scanner (not
      // a post-regex) so a "," inside a string literal is never affected.
      let j = i + 1;
      while (j < text.length) {
        const d = text[j];
        if (d === " " || d === "\t" || d === "\r" || d === "\n") j++;
        else if (d === "/" && text[j + 1] === "/") {
          j += 2;
          while (j < text.length && text[j] !== "\n") j++;
        } else if (d === "/" && text[j + 1] === "*") {
          j += 2;
          while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) j++;
          j += 2;
        } else break;
      }
      if (text[j] === "}" || text[j] === "]") continue; // skip trailing comma
    }
    out += c;
  }
  return JSON.parse(out) as T;
}

export function loadManifest(extPath: string): Manifest {
  const p = join(extPath, "manifest.json");
  if (!existsSync(p)) throw new Error(`No manifest.json found in ${extPath}`);
  return parseJsonc<Manifest>(readFileSync(p, "utf-8"));
}

/**
 * Resolve a __MSG_key__ manifest value from _locales. Chrome substitutes these
 * at load time; the converter needs the literal text to derive the app name /
 * bundle id / output dir (otherwise they become "__MSG_extName___Safari").
 * Lookup order: default_locale, English variants, then any locale present.
 * Message names are case-insensitive, matching Chrome. Returns the input
 * unchanged when it is not a __MSG_ reference; undefined when unresolvable.
 */
export function resolveI18nString(value: string | undefined, extPath: string, defaultLocale?: string): string | undefined {
  if (!value) return value;
  const ref = /^__MSG_(.+?)__$/.exec(value);
  if (!ref) return value;
  const key = ref[1].toLowerCase();
  const localesDir = join(extPath, "_locales");
  if (!existsSync(localesDir)) return undefined;
  let available: string[] = [];
  try {
    available = readdirSync(localesDir);
  } catch {
    return undefined;
  }
  const preferred = [defaultLocale, "en", "en_US", "en_GB"].filter((l): l is string => !!l);
  const seen = new Set<string>();
  for (const loc of [...preferred, ...available]) {
    if (seen.has(loc)) continue;
    seen.add(loc);
    const p = join(localesDir, loc, "messages.json");
    if (!existsSync(p)) continue;
    try {
      const msgs = parseJsonc<Record<string, { message?: string }>>(readFileSync(p, "utf-8"));
      for (const k of Object.keys(msgs)) {
        if (k.toLowerCase() === key) {
          const msg = msgs[k]?.message;
          if (typeof msg === "string" && msg.trim()) return msg.trim();
        }
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Strict variant for the analyzer's placeholder check. Chrome substitutes manifest
 * __MSG_ placeholders ONLY from the default_locale's messages.json — it does NOT apply
 * the runtime UI-locale fallback to manifest fields. So a key present in en but missing
 * from default_locale 'de' is NOT substituted: Chrome/Safari render the literal token.
 * resolveI18nString's broad cross-locale fallback would find the 'en' value and hide
 * that, so the analyzer must resolve against default_locale only. Returns the resolved
 * message, or undefined if the key is absent from the default locale (the real error
 * condition). The lenient resolveI18nString stays the right choice for deriving a
 * human label (a real name beats a literal token), but not for correctness checking.
 */
export function resolveI18nStringStrict(value: string | undefined, extPath: string, defaultLocale?: string): string | undefined {
  if (!value) return value;
  const ref = /^__MSG_(.+?)__$/.exec(value);
  if (!ref) return value;
  // No default_locale declared → Chrome can't localize the manifest at all; the token
  // stays literal, so treat as unresolved.
  if (!defaultLocale) return undefined;
  const key = ref[1].toLowerCase();
  const p = join(extPath, "_locales", defaultLocale, "messages.json");
  if (!existsSync(p)) return undefined;
  try {
    const msgs = parseJsonc<Record<string, { message?: string }>>(readFileSync(p, "utf-8"));
    for (const k of Object.keys(msgs)) {
      if (k.toLowerCase() === key) {
        const msg = msgs[k]?.message;
        if (typeof msg === "string" && msg.trim()) return msg.trim();
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

// Compatibility data tables live in compat-data.ts; imported for internal use
// and re-exported so existing importers (analyze.ts, report.ts) keep their path.
import { UNSUPPORTED_PERMISSIONS, SHIMMED_PERMISSIONS, UNSUPPORTED_APIS } from "./compat-data.js";
export { UNSUPPORTED_PERMISSIONS, SHIMMED_PERMISSIONS, UNSUPPORTED_APIS };

/**
 * Default Safari strict_min_version when --min-safari is not passed. 15.4 is the
 * floor for Manifest V3 web extensions; bump only with a matching note in the CLI
 * help. Single source of truth — referenced by the transform default and the help
 * text so they can't drift apart.
 */
export const DEFAULT_MIN_SAFARI_VERSION = "15.4";

export interface ManifestAnalysis {
  issues: Issue[];
  permissionsToRemove: string[];
  needsCdpShim: boolean;
}

const MATCH_SCHEMES = new Set(["http", "https", "*", "file", "ftp"]);

/**
 * Validate a Chrome match pattern (https://developer.chrome.com/docs/extensions/mv3/match_patterns/).
 * Chrome only warns on a bad pattern, but Safari silently drops the entire
 * content script that contains it — so a malformed entry must surface as an
 * error before conversion. Returns null when valid, else a short reason.
 */
export function matchPatternError(pattern: string): string | null {
  if (pattern === "<all_urls>") return null;
  const m = /^(\*|https?|file|ftp):\/\/(.*)$/.exec(pattern);
  if (!m) return "missing or unsupported scheme (expected http/https/file/ftp/*://)";
  const scheme = m[1];
  if (!MATCH_SCHEMES.has(scheme)) return `unsupported scheme "${scheme}"`;
  const rest = m[2];

  // file:// is host-less, but Chrome accepts an optional "*" host placeholder
  // before the path (e.g. "file://*/*" is extremely common). Strip a leading
  // "*" so both "file:///path" (empty host) and "file://*/path" validate.
  if (scheme === "file") {
    const path = rest.startsWith("*") ? rest.slice(1) : rest;
    return path.startsWith("/") ? null : "file:// pattern path must start with '/'";
  }

  const slash = rest.indexOf("/");
  if (slash === -1) return "missing path (a match pattern must end with a path, e.g. '/*')";
  const host = rest.slice(0, slash);
  if (host === "") return "empty host";
  // '*' alone, or '*.' prefix, are the only legal wildcard host forms.
  if (host !== "*") {
    const body = host.startsWith("*.") ? host.slice(2) : host;
    if (body.includes("*")) return `host "${host}" may only use '*' as a full or leftmost-label wildcard`;
    if (body === "") return "empty host after '*.'";
  }
  return null;
}

/**
 * Validate manifest `commands` for Safari. Chrome and Safari both expect each
 * suggested_key chord to be `Modifier+[Modifier+]Key`, but Safari is stricter:
 * - A chord with NO modifier (or only Shift) is rejected — Chrome allows a few
 *   media keys bare, Safari does not register them and the command silently has
 *   no shortcut.
 * - Safari recognizes Ctrl/Command/Alt(Option)/MacCtrl/Shift; Chrome's "Search"
 *   modifier (ChromeOS) has no Safari equivalent.
 * Reserved commands (_execute_action etc.) are allowed and skipped.
 */
const COMMAND_MODIFIERS = new Set(["Ctrl", "Command", "Alt", "Option", "MacCtrl", "Shift"]);

// suggested_key platforms Safari can actually read. Chords declared only for
// chromeos/windows/linux are dead keys on Safari — warning about them is noise.
const SAFARI_COMMAND_PLATFORMS = new Set(["default", "mac", "ios"]);

// True when a command definition has a suggested_key chord Safari would honor — a
// plain string (all platforms) or a per-platform map with a default/mac/ios entry.
// These are the ones that count toward Safari's 4-shortcut limit.
function hasSafariSuggestedKey(def: unknown): boolean {
  const suggested = (def as { suggested_key?: unknown } | undefined)?.suggested_key;
  if (typeof suggested === "string") return suggested.trim() !== "";
  if (suggested && typeof suggested === "object") {
    return Object.entries(suggested as Record<string, unknown>).some(
      ([platform, v]) => SAFARI_COMMAND_PLATFORMS.has(platform) && typeof v === "string" && v.trim() !== ""
    );
  }
  return false;
}

export function analyzeCommands(commands: Record<string, unknown>): Issue[] {
  const issues: Issue[] = [];
  for (const [name, def] of Object.entries(commands)) {
    const suggested = (def as { suggested_key?: unknown } | undefined)?.suggested_key;
    if (suggested == null) continue; // undefined or null → user can still bind it manually in Safari
    // suggested_key is either a string (all platforms) or a per-platform map.
    const chords =
      typeof suggested === "string"
        ? [suggested]
        : Object.entries(suggested as Record<string, unknown>)
            .filter(([platform]) => SAFARI_COMMAND_PLATFORMS.has(platform))
            .map(([, v]) => v)
            .filter((v): v is string => typeof v === "string");
    for (const chord of chords) {
      const parts = chord.split("+").map((p) => p.trim());
      const key = parts.pop();
      const mods = parts;
      const hasPrimaryModifier = mods.some((mo) => mo === "Ctrl" || mo === "Command" || mo === "Alt" || mo === "Option" || mo === "MacCtrl");
      if (!key || !hasPrimaryModifier) {
        issues.push({
          severity: "warning",
          category: "ui",
          message: `commands.${name} shortcut "${chord}" lacks a Ctrl/Command/Alt modifier; Safari ignores it and the command gets no shortcut.`,
          file: "manifest.json",
          fix: "Use a chord like Command+Shift+Y; Safari requires a primary modifier (Shift-only is not enough).",
        });
      }
      const unknownMod = mods.find((mo) => !COMMAND_MODIFIERS.has(mo));
      if (unknownMod) {
        issues.push({
          severity: "warning",
          category: "ui",
          message: `commands.${name} uses modifier "${unknownMod}" which Safari does not support.`,
          file: "manifest.json",
          fix: "Use Ctrl/Command/Alt/Option/MacCtrl/Shift; ChromeOS-only modifiers (e.g. Search) have no Safari equivalent.",
        });
      }
    }
  }

  // Safari allows at most 4 commands with a suggested_key; a 5th makes it reject the
  // whole manifest at load. transformManifest strips the default chord from the extras,
  // so flag which lost it (they're still bindable manually in Safari's settings).
  const withKeys = Object.keys(commands).filter((name) => hasSafariSuggestedKey(commands[name]));
  if (withKeys.length > 4) {
    const dropped = withKeys.slice(4);
    issues.push({
      severity: "warning",
      category: "ui",
      message: `${withKeys.length} commands declare a keyboard shortcut, but Safari allows only 4; dropping the default chord from: ${dropped.join(", ")}.`,
      file: "manifest.json",
      fix: "Safari rejects the manifest with a 5th shortcut. The extra commands keep working and can be bound by the user in Safari → Settings → Extensions.",
      autoFixed: true,
    });
  }
  return issues;
}

export function analyzeManifest(m: Manifest): ManifestAnalysis {
  const issues: Issue[] = [];
  const permissionsToRemove: string[] = [];
  const allPerms = [
    ...(Array.isArray(m.permissions) ? m.permissions : []),
    ...(Array.isArray(m.optional_permissions) ? m.optional_permissions : []),
  ];

  // Bad match patterns make Safari silently drop the whole content script.
  // Guard against a malformed manifest where these aren't arrays/strings — Chrome
  // rejects such a manifest, but the converter must report rather than crash.
  const contentScripts = Array.isArray(m.content_scripts) ? m.content_scripts : [];
  contentScripts.forEach((cs, i) => {
    const matches = Array.isArray(cs?.matches) ? cs.matches : [];
    for (const pat of matches) {
      if (typeof pat !== "string") continue;
      const err = matchPatternError(pat);
      if (err) {
        issues.push({
          severity: "error",
          category: "content_scripts",
          message: `Invalid match pattern "${pat}" in content_scripts[${i}]: ${err}.`,
          file: "manifest.json",
          fix: "Safari drops the entire content script for one bad pattern; correct or remove it.",
        });
      }
    }
    // world:"MAIN" injects into the page's JS context. Safari only added support in
    // 18.4; on earlier versions the script silently does not run, and it never has
    // access to chrome.* — a common source of "works in Chrome, dead in Safari".
    if (cs?.world === "MAIN") {
      issues.push({
        severity: "warning",
        category: "content_scripts",
        message: `content_scripts[${i}] uses world:"MAIN"; supported only on Safari 18.4+ and has no chrome.* access.`,
        file: "manifest.json",
        fix: "Provide an ISOLATED-world fallback, or feature-detect and degrade on older Safari.",
      });
    }
  });

  // Same "Safari silently drops a malformed pattern" failure mode as content-script
  // matches, but for host access: a bad host_permission grants NO host access in
  // Safari with no error. Unlike content-script matches this is auto-fixable:
  // some patterns here are valid CHROME manifests (ws://\wss:// for webRequest
  // websocket interception — MetaMask ships them) that Safari simply can't grant,
  // so transformManifest drops the invalid entries and the valid rest keeps
  // working. Removal is behavior-identical to what Safari would do anyway.
  for (const key of ["host_permissions", "optional_host_permissions"] as const) {
    const hosts = Array.isArray(m[key]) ? (m[key] as unknown[]) : [];
    for (const pat of hosts) {
      if (typeof pat !== "string") continue;
      const err = matchPatternError(pat);
      if (err) {
        issues.push({
          severity: "warning",
          category: "permission",
          message: `Invalid match pattern "${pat}" in ${key} will be removed: ${err}.`,
          file: "manifest.json",
          fix: "Safari grants no host access for this pattern (Chrome-only schemes like ws:// cannot be granted); the converter drops it so the remaining patterns still apply.",
          autoFixed: true,
        });
      }
    }
  }

  // Set-dedupe: a permission listed in BOTH permissions and optional_permissions
  // would otherwise produce two identical issues.
  for (const perm of new Set(allPerms)) {
    if (perm in UNSUPPORTED_PERMISSIONS) {
      const shimmed = SHIMMED_PERMISSIONS.has(perm);
      issues.push({
        // A shimmed permission's capability still works (the shim emulates the API),
        // so it's informational, not a warning — matching the severity the same
        // capability gets in UNSUPPORTED_APIS. Telling authors a working feature
        // "will be removed" at warning level is the over-flagging the project guards
        // against. Only a genuinely-dropped (unshimmed) permission stays a warning.
        severity: shimmed ? "info" : "warning",
        category: "permission",
        message: shimmed
          ? `Permission "${perm}" is removed (Safari rejects it), but the shim emulates the API so it keeps working.`
          : `Unsupported permission "${perm}" will be removed.`,
        file: "manifest.json",
        fix: UNSUPPORTED_PERMISSIONS[perm],
        autoFixed: true,
        shimmed,
      });
      permissionsToRemove.push(perm);
    }
  }

  // Under MV3, URL match patterns belong in host_permissions, not permissions.
  // A pattern left in permissions is legal MV2 but SILENTLY IGNORED under MV3 —
  // Safari (and Chrome MV3) grant no host access, so the extension "works in the
  // old build, breaks after migration". Flag each misplaced entry; it's a likely
  // bug the converter won't auto-move (intent is ambiguous).
  if ((m.manifest_version ?? 2) === 3) {
    const fields: Array<["permissions" | "optional_permissions", "host_permissions" | "optional_host_permissions"]> = [
      ["permissions", "host_permissions"],
      ["optional_permissions", "optional_host_permissions"],
    ];
    for (const [src, dest] of fields) {
      const declared = Array.isArray(m[src]) ? (m[src] as unknown[]) : [];
      for (const perm of declared) {
        if (typeof perm !== "string") continue;
        const looksLikeHost = perm === "<all_urls>" || perm.includes("://");
        if (looksLikeHost && !(perm in UNSUPPORTED_PERMISSIONS)) {
          // A host pattern whose scheme Safari can't parse (chrome://favicon/, ws://…)
          // isn't merely ignored — Safari rejects the whole manifest and the extension
          // never loads. transformManifest drops these, so report it as auto-fixed
          // rather than telling the author to move a value Safari can't grant anywhere.
          if (perm !== "<all_urls>" && matchPatternError(perm) !== null) {
            issues.push({
              severity: "warning",
              category: "permission",
              message: `"${perm}" in "${src}" uses a scheme Safari can't parse; left in place Safari rejects the whole manifest and won't load the extension. It will be removed.`,
              file: "manifest.json",
              fix: `Chrome-only schemes have no Safari equivalent and can't be granted in "${dest}" either, so the entry is dropped.`,
              autoFixed: true,
            });
          } else {
            issues.push({
              severity: "warning",
              category: "permission",
              message: `"${perm}" is a host match pattern in "${src}"; under MV3 it is ignored and grants no host access.`,
              file: "manifest.json",
              fix: `Move it into "${dest}" (MV3 requires URL patterns there, not in "${src}").`,
            });
          }
        }
      }
    }
  }

  if (!m.description || (typeof m.description === "string" && !m.description.trim())) {
    issues.push({
      severity: "info",
      category: "manifest",
      message: "No description in the manifest; the App Store requires one for submission.",
      file: "manifest.json",
      fix: "Add a short description; Safari shows it in Settings → Extensions and the App Store needs it.",
    });
  }

  if (m.key) {
    issues.push({
      severity: "info",
      category: "manifest",
      message: "key (Chrome CRX packing identity) has no meaning for Safari; removing.",
      file: "manifest.json",
      fix: "Safari derives extension identity from the bundle id; the key field is dropped.",
      autoFixed: true,
    });
  }

  if (m.update_url) {
    issues.push({
      severity: "info",
      category: "manifest",
      message: "update_url ignored by Safari (App Store updates only); removing.",
      file: "manifest.json",
      autoFixed: true,
    });
  }
  if (!m.version || (typeof m.version === "string" && !m.version.trim())) {
    issues.push({
      severity: "warning",
      category: "manifest",
      message: "No version in the manifest; Apple requires a CFBundleShortVersionString and the build will fail.",
      file: "manifest.json",
      fix: 'Add a numeric "version" (e.g. "1.0.0") to the manifest.',
    });
  } else if (typeof m.version === "string") {
    // Apple's CFBundleShortVersionString (like Chrome) needs dot-separated
    // non-negative integers, each 0–65535. A part like "beta" or "1-rc1" loads
    // in Chrome from an unpacked dir but fails the Xcode build with an opaque
    // error, so surface it up front.
    // Mirror transformManifest's actual rewrite: it keeps leading numeric parts,
    // clamps each to 65535, stops at the first non-numeric part, and caps at 3. So a
    // non-numeric part only changes the shipped version if it's within the first 3
    // (transform cuts it); a >65535 part is silently clamped, not a build failure;
    // and parts past the 3rd are dropped. Warn for what actually changes, not for a
    // part that gets truncated away anyway — the old check flagged discarded parts and
    // wrongly claimed the build would fail.
    const parts = m.version.split(".");
    const shipped = parts.slice(0, 3);
    const cutPart = shipped.find((p) => !/^\d+$/.test(p));
    if (cutPart !== undefined) {
      issues.push({
        severity: "warning",
        category: "manifest",
        message: `version "${m.version}" has a non-numeric part ("${cutPart}"); Apple requires integer parts, so the version is truncated at the first non-numeric part (becoming "${shipped.slice(0, shipped.indexOf(cutPart)).map((p) => String(Math.min(Number(p), 65535))).join(".") || "1.0.0"}").`,
        file: "manifest.json",
        fix: 'Use a numeric dotted version like "1.2.3" (no suffixes such as -rc1 or +build).',
        autoFixed: true,
      });
    } else if (parts.length > 3 || shipped.some((p) => Number(p) > 65535)) {
      issues.push({
        severity: "info",
        category: "manifest",
        message: `version "${m.version}" exceeds Apple's CFBundleShortVersionString limits (3 parts, each ≤65535); truncating/clamping.`,
        file: "manifest.json",
        autoFixed: true,
      });
    }
  }

  // Only the extension_pages policy governs the extension's own pages/SW; the
  // sandbox policy intentionally relaxes rules for sandboxed iframes, so scanning
  // it for "remote script-src" would false-flag legitimate sandbox allowances.
  // A bare string is the MV2 form, which maps to extension_pages.
  const cspObj = m.content_security_policy;
  // A malformed-but-parseable manifest can set extension_pages to a non-string
  // (object/number/array); coerce anything that isn't a string to "" so the
  // .includes()/.matchAll() below can't throw and abort the analyzer.
  const csp =
    typeof cspObj === "string"
      ? cspObj
      : typeof cspObj?.extension_pages === "string"
        ? cspObj.extension_pages
        : "";
  // Match the standalone 'unsafe-eval' token, not the substring inside the
  // distinct, valid 'wasm-unsafe-eval' keyword (WebAssembly compilation, which
  // Safari supports and which does NOT enable eval()).
  if (/(?:^|[\s;'"])unsafe-eval(?:[\s;'"]|$)/.test(csp)) {
    issues.push({
      severity: "warning",
      category: "manifest",
      message: "CSP allows 'unsafe-eval'; Safari rejects eval in extension contexts regardless.",
      file: "manifest.json",
      fix: "Remove eval()/new Function usage; precompile templates or use JSON.parse.",
    });
  }

  // A script-src/script-src-elem directive that whitelists a remote origin (a
  // hosted CDN, etc.) means the extension loads code from the network. Safari
  // forbids remote script in extension pages and the App Store review rejects it.
  const scriptSrc = /(?:^|;)\s*script-src(?:-elem)?\s+([^;]+)/gi;
  const remoteSrc = new Set<string>();
  for (const dm of csp.matchAll(scriptSrc)) {
    for (const token of dm[1].trim().split(/\s+/)) {
      // A bare "*" (or scheme-wildcard like https://*) whitelists the whole network.
      if (token === "*" || /^(https?:|\/\/|wss?:|\*:)/i.test(token) || /^(?:\*\.)?[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?$/i.test(token)) {
        remoteSrc.add(token);
      }
    }
  }
  if (remoteSrc.size > 0) {
    issues.push({
      severity: "warning",
      category: "manifest",
      message: `CSP script-src allows remote origin(s) (${[...remoteSrc].join(", ")}); Safari blocks remote scripts and the App Store rejects them.`,
      file: "manifest.json",
      fix: "Bundle the script into the extension and load it locally; remove remote script-src entries.",
    });
  }

  if (m.minimum_chrome_version) {
    issues.push({
      severity: "info",
      category: "manifest",
      message: "minimum_chrome_version is meaningless for Safari; removing.",
      file: "manifest.json",
      autoFixed: true,
    });
  }

  const mv = m.manifest_version ?? 2;
  if (mv === 2 && m.background && m.background.persistent !== false) {
    issues.push({
      severity: "warning",
      category: "background",
      message: "MV2 persistent background is unsupported; setting persistent:false.",
      file: "manifest.json",
      fix: "Prefer migrating to an MV3 service worker.",
      autoFixed: true,
    });
  }

  if (mv === 3 && m.background?.type === "module") {
    issues.push({
      severity: "warning",
      category: "background",
      message: 'background.type:"module" causes silent popup failures on Safari/TestFlight.',
      file: "manifest.json",
      fix: "Removing type:module (use --keep-module to preserve).",
      autoFixed: true,
    });
  }

  const action = m.action ?? m.browser_action ?? m.page_action;
  if (!action?.default_popup) {
    issues.push({
      severity: "info",
      category: "ui",
      message: "Action has no default_popup; a toolbar button with no behavior is inert in Safari.",
      file: "manifest.json",
      fix: "Wiring a detected popup/sidepanel page, or (if the background handles action.onClicked) an onClicked bridge, so the button works.",
      autoFixed: true,
    });
  }

  // web_accessible_resources.use_dynamic_url is a Chrome-only feature (rotates the
  // resource URL per session). Safari does not implement it: an entry carrying
  // use_dynamic_url:true fails to serve, so chrome.runtime.getURL() hands back a
  // URL Safari refuses to load. A content script that injects a stylesheet/asset
  // this way (e.g. a shadow-DOM sidebar's CSS) then renders unstyled and stays
  // invisible — a silent "the popup/panel never shows". Strip the flag so the
  // resource loads at its stable static extension URL.
  const dynamicUrlWar = (Array.isArray(m.web_accessible_resources) ? m.web_accessible_resources : []).some(
    (e) => typeof e === "object" && e !== null && "use_dynamic_url" in e && e.use_dynamic_url === true,
  );
  if (dynamicUrlWar) {
    issues.push({
      severity: "warning",
      category: "resources",
      message: "web_accessible_resources use_dynamic_url is unsupported in Safari; getURL() returns an unservable URL and the resource silently fails to load.",
      file: "manifest.json",
      fix: "Clearing use_dynamic_url (set false) so the resource loads at its static extension URL.",
      autoFixed: true,
    });
  }

  if (m.externally_connectable?.ids?.length) {
    issues.push({
      severity: "warning",
      category: "manifest",
      message: "externally_connectable by extension IDs is unsupported in Safari.",
      file: "manifest.json",
      fix: "Use matches for web-page messaging; ID-based connections will not resolve.",
    });
  }

  if (allPerms.includes("storage")) {
    issues.push({
      severity: "info",
      category: "storage",
      message: "storage.sync does NOT sync across iCloud devices in Safari (maps to local).",
      file: "manifest.json",
      fix: "Shim routes sync→local; implement custom cloud sync if cross-device is required.",
    });
  }

  // Surfaced from the permission too (not just JS) because native-messaging calls
  // are often in minified bundles the source scanner attributes imprecisely.
  if (allPerms.includes("nativeMessaging")) {
    issues.push({
      severity: "warning",
      category: "permission",
      message: "nativeMessaging works differently in Safari: there is no native-messaging-hosts manifest or host binary.",
      file: "manifest.json",
      fix: "Route messages to the containing macOS app's SafariWebExtensionHandler (beginRequest); the permission stays but the host model changes.",
    });
  }

  if (m.commands && Object.keys(m.commands).length > 0) {
    issues.push({
      severity: "info",
      category: "ui",
      message: "Keyboard commands are only partially supported in Safari; some chords are unavailable.",
      file: "manifest.json",
      fix: "Verify each shortcut in Safari → Settings → Extensions; provide an in-UI fallback.",
    });
    for (const issue of analyzeCommands(m.commands)) issues.push(issue);
  }

  if (m.chrome_url_overrides?.newtab) {
    issues.push({
      severity: "warning",
      category: "ui",
      message: "chrome_url_overrides.newtab has gaps in Safari and behaves inconsistently per platform.",
      file: "manifest.json",
      fix: "Test the new-tab override on macOS and iOS; consider dropping it if unreliable.",
    });
  }
  for (const k of Object.keys(m.chrome_url_overrides ?? {})) {
    if (k !== "newtab") {
      issues.push({
        severity: "warning",
        category: "ui",
        message: `chrome_url_overrides.${k} is not supported in Safari.`,
        file: "manifest.json",
        fix: "Remove the override; Safari only partially honors newtab.",
      });
    }
  }

  if (m.devtools_page) {
    issues.push({
      severity: "warning",
      category: "ui",
      message: "devtools_page panels use a different surface in Safari (Web Inspector Extensions).",
      file: "manifest.json",
      fix: "Reimplement DevTools panels via Safari Web Inspector extension APIs, or drop.",
    });
  }

  // Under MV3 a host pattern in `permissions` grants NO access (flagged separately as
  // misplaced above), so don't also count it as "broad host access" — that's the exact
  // contradiction. Only MV2 puts host patterns in `permissions` legitimately.
  const hosts = [
    ...(Array.isArray(m.host_permissions) ? m.host_permissions : []),
    ...((m.manifest_version ?? 2) < 3 && Array.isArray(m.permissions) ? m.permissions : []),
  ];
  if (hosts.some((h) => h === "<all_urls>" || h === "*://*/*" || h === "http://*/*" || h === "https://*/*")) {
    issues.push({
      severity: "info",
      category: "permission",
      message: "Broad host access (<all_urls>): Safari asks the user per-site and defaults to 'Ask'.",
      file: "manifest.json",
      fix: "Expect degraded behavior until the user grants access; handle permission denials gracefully.",
    });
  }

  if (!m.icons || Object.keys(m.icons).length === 0) {
    issues.push({
      severity: "info",
      category: "ui",
      message: "No icons in the manifest; synthesizing a solid-color placeholder set (48/128/256/512px).",
      file: "manifest.json",
      fix: "Replace with real PNG icons for production; the placeholder only avoids a blank toolbar glyph.",
      autoFixed: true,
    });
  }

  if (m.incognito) {
    issues.push({
      severity: "info",
      category: "manifest",
      message: `incognito:"${m.incognito}" maps to Safari Private Browsing (off by default; user opts in per extension).`,
      file: "manifest.json",
      fix: "Don't rely on split-process isolation; assume spanning-like and re-test state separation.",
    });
  }

  const needsCdpShim = allPerms.includes("debugger");
  return { issues, permissionsToRemove, needsCdpShim };
}

/**
 * Collect every concrete file path the manifest references as a runtime asset
 * (scripts, pages, css, icons, web_accessible_resources, DNR rulesets, …),
 * normalized to forward-slash relative paths. Glob/wildcard resource entries
 * (containing '*') are skipped — only literal paths are returned. Used by the
 * stager so a declared resource is never dropped as "dev cruft" (e.g. a
 * web-accessible LICENSE.txt or a .map served to a page), which would 404 at
 * runtime in Safari.
 */
export function collectReferencedPaths(m: Manifest): Set<string> {
  const paths = new Set<string>();
  const add = (p: unknown) => {
    if (typeof p === "string" && p && !p.includes("*")) {
      // Drop any #fragment/?query (e.g. "devpanel.html#popup") so the concrete
      // file on disk is preserved during staging, not a phantom "…#popup" name.
      const filePart = p.split(/[#?]/)[0];
      if (filePart) paths.add(filePart.replace(/^\.?\//, "").replace(/\\/g, "/"));
    }
  };
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

  for (const cs of arr(m.content_scripts) as Array<{ js?: unknown; css?: unknown }>) {
    for (const j of arr(cs?.js)) add(j);
    for (const c of arr(cs?.css)) add(c);
  }
  for (const b of arr(m.background?.scripts)) add(b);
  add(m.background?.service_worker);
  add(m.background?.page);
  for (const a of [m.action, m.browser_action, m.page_action]) {
    add((a as { default_popup?: unknown } | undefined)?.default_popup);
    const di = (a as { default_icon?: unknown } | undefined)?.default_icon;
    if (typeof di === "string") add(di);
    else if (di && typeof di === "object") for (const p of Object.values(di)) add(p);
  }
  for (const p of Object.values(m.icons ?? {})) add(p);
  add(m.options_page);
  add(m.options_ui?.page);
  add(m.devtools_page);
  for (const p of Object.values(m.chrome_url_overrides ?? {})) add(p);
  for (const p of arr(m.sandbox?.pages)) add(p);
  for (const r of arr(m.declarative_net_request?.rule_resources) as Array<{ path?: unknown }>) add(r?.path);
  // side_panel.default_path: the shim opens this page at runtime (see shim.ts),
  // so a miss here drops the panel HTML and open() 404s in Safari.
  add((m as { side_panel?: { default_path?: unknown } }).side_panel?.default_path);
  add((m as { sidebar_action?: { default_panel?: unknown } }).sidebar_action?.default_panel);
  add((m as { storage?: { managed_schema?: unknown } }).storage?.managed_schema);

  // web_accessible_resources: MV2 string[], MV3 [{resources: string[]}], or a bare
  // string (invalid but hand-edited manifests produce it — transformManifest wraps
  // it, so stage it here too or the referenced file is dropped).
  if (typeof m.web_accessible_resources === "string") add(m.web_accessible_resources);
  for (const entry of arr(m.web_accessible_resources)) {
    if (typeof entry === "string") add(entry);
    else for (const r of arr((entry as { resources?: unknown })?.resources)) add(r);
  }
  return paths;
}

/**
 * Add `'self'` to a CSP's connect-src so Safari allows same-origin fetch/XHR of
 * bundled resources (Chrome implies this; Safari enforces connect-src strictly).
 * Only touches a connect-src that EXISTS but lacks 'self' — a policy with no
 * connect-src already falls back to default-src/'self'. Leaves every other
 * directive untouched. Accepts the MV3 object form, the bare MV2 string, or
 * undefined, and returns the same shape.
 */
export function addSelfToConnectSrc<T extends string | Record<string, string> | undefined>(csp: T): T {
  const fixOne = (policy: string): string => {
    if (/(?:^|;)\s*connect-src(?:\s|;|$)/i.test(policy)) {
      return policy.replace(/(^|;)\s*connect-src\s+([^;]*)/i, (full, sep: string, sources: string) => {
        const tokens = sources.trim().split(/\s+/).filter(Boolean);
        // 'none' means "block everything" — don't loosen it; 'self' already present → no-op.
        if (tokens.includes("'none'") || tokens.includes("'self'")) return full;
        return `${sep} connect-src 'self' ${tokens.join(" ")}`;
      });
    }
    // No connect-src: fetches fall back to default-src. Chrome still implies
    // same-origin there; Safari doesn't — a default-src without 'self' (e.g.
    // "default-src 'none'") blocks the extension's own bundled fetches too.
    // Synthesize a connect-src that keeps the author's default scope + 'self'.
    const dm = /(?:^|;)\s*default-src\s+([^;]*)/i.exec(policy);
    if (!dm) return policy; // no default-src either → browser default covers 'self'
    const tokens = dm[1].trim().split(/\s+/).filter(Boolean);
    if (tokens.includes("'self'")) return policy;
    const scope = tokens.filter((t) => t !== "'none'");
    return `${policy.replace(/;?\s*$/, "")}; connect-src 'self'${scope.length ? " " + scope.join(" ") : ""}`;
  };
  if (csp == null) return csp;
  if (typeof csp === "string") return fixOne(csp) as T;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(csp)) out[k] = typeof v === "string" ? fixOne(v) : v;
  return out as T;
}

// True when a background script registers action.onClicked — i.e. the toolbar button's
// behavior lives in code, not in a popup page. Same heuristic (and same signal) as the
// shim's own detector in runtime/shim.ts; kept as a local copy here because shim.ts
// already imports from this module, and reversing that edge to share one function would
// create an import cycle. Both read the staged background source; neither owns the other.
function backgroundRegistersActionOnClicked(manifest: Manifest, extPath: string): boolean {
  const files: string[] = [];
  const sw = manifest.background?.service_worker;
  if (typeof sw === "string") files.push(sw);
  for (const s of manifest.background?.scripts ?? []) if (typeof s === "string") files.push(s);
  // Collective scan over all background files (not a per-file short-circuit): a non-empty
  // setPopup ANYWHERE makes the button popup-driven, which wins over an onClicked
  // registration in another file. Mirrors the shim's detector (runtime/shim.ts); the shim
  // there is prepended to background.scripts and references onClicked without setPopup, so
  // a per-file return-true would fire on it before reaching the bundle's own setPopup.
  // Empty setPopup({popup:""}) clears the popup and doesn't count.
  let sawOnClicked = false;
  for (const rel of files) {
    const p = join(extPath, rel.replace(/^\.?\//, ""));
    if (!existsSync(p)) continue;
    let src: string;
    try { src = readFileSync(p, "utf-8"); } catch { continue; }
    if (/setPopup\s*\(\s*\{[^}]*\bpopup\s*:\s*(["'`])(?!\1)[^"'`]/.test(src)) return false;
    if (/onClicked/.test(src) && /\b(?:action|browserAction)\b/.test(src)) sawOnClicked = true;
  }
  return sawOnClicked;
}

/** Produce the Safari-ready manifest. Pure: does not write to disk. */
export function transformManifest(
  m: Manifest,
  permissionsToRemove: string[],
  extPath: string,
  opts: { keepModuleBackground: boolean; shimFile?: string; polyfillFile?: string; minSafariVersion?: string; cdpShim?: boolean }
): Manifest {
  const out: Manifest = JSON.parse(JSON.stringify(m));

  delete out.update_url;
  delete out.key;
  delete out.minimum_chrome_version;
  // Keep version_name: the App Store ignores it, but it's a real runtime field —
  // extensions read chrome.runtime.getManifest().version_name for display (Salesforce
  // Inspector renders it in its footer and crashes on undefined.replace if it's gone).
  // Harmless to leave in the Safari bundle; removing it breaks that read.

  if (out.version) {
    // Safari/Xcode require dot-separated integers (max 3 components, each ≤ 65535).
    // Keep leading numeric parts and stop at the first non-numeric one; if nothing
    // usable remains, fall back to 1.0.0 rather than writing a manifest that fails the build.
    const numeric: string[] = [];
    for (const p of out.version.split(".")) {
      if (!/^\d+$/.test(p)) break;
      numeric.push(String(Math.min(Number(p), 65535)));
      if (numeric.length === 3) break;
    }
    out.version = numeric.length ? numeric.join(".") : "1.0.0";
  }

  const removeSet = new Set(permissionsToRemove);
  // A permissions entry that is a host match pattern with a scheme Safari can't
  // parse (chrome://favicon/, ws://…) is not just ignored like a stray https://
  // pattern — Safari treats the whole manifest as invalid and refuses to load the
  // extension. Drop those outright, the same way host_permissions filters them
  // below. A plain name ("tabs") has no "://" so it's untouched, and a legal
  // https:// pattern passes matchPatternError so the warn-don't-move behavior for
  // misplaced host patterns is preserved.
  const isUngrantablePattern = (p: unknown): boolean =>
    typeof p === "string" && p.includes("://") && matchPatternError(p) !== null;
  if (Array.isArray(out.permissions)) {
    out.permissions = out.permissions.filter((p) => !removeSet.has(p) && !isUngrantablePattern(p));
  }
  if (Array.isArray(out.optional_permissions)) {
    out.optional_permissions = out.optional_permissions.filter((p) => !removeSet.has(p) && !isUngrantablePattern(p));
  }
  // Safari rejects the declarativeNetRequestWithHostAccess token, but either token
  // grants the DNR API. Re-add plain declarativeNetRequest to whichever list the
  // variant was declared in (a variant declared ONLY in optional_permissions must
  // not silently lose the DNR capability), unless it's already present.
  if (removeSet.has("declarativeNetRequestWithHostAccess")) {
    const inRequired = Array.isArray(m.permissions) && m.permissions.includes("declarativeNetRequestWithHostAccess");
    const key = inRequired ? "permissions" : "optional_permissions";
    if (!Array.isArray(out[key])) out[key] = [];
    const list = out[key] as string[];
    if (!list.includes("declarativeNetRequest")) list.push("declarativeNetRequest");
  }
  if (Array.isArray(out.optional_permissions) && out.optional_permissions.length === 0) delete out.optional_permissions;

  // The CDP shim's executor injects into arbitrary tabs via chrome.scripting, so
  // when the debugger permission was shimmed we must keep scripting granted (debugger
  // itself stays stripped). Broad host access (<all_urls>) is added below after the
  // match-pattern filter so CDP can attach to any tab.
  if (opts.cdpShim) {
    if (!Array.isArray(out.permissions)) out.permissions = [];
    if (!(out.permissions as string[]).includes("scripting")) (out.permissions as string[]).push("scripting");
  }

  // Drop host patterns Safari's match-pattern parser rejects (ws://*/* etc. — valid
  // in Chrome for webRequest websockets, ungrantable in Safari). Keeping them risks
  // Safari discarding host access; removal matches analyzeManifest's auto-fix note.
  for (const key of ["host_permissions", "optional_host_permissions"] as const) {
    if (!Array.isArray(out[key])) continue;
    const kept = (out[key] as unknown[]).filter((p) => typeof p !== "string" || matchPatternError(p) === null);
    if (kept.length === 0) delete out[key];
    else out[key] = kept as string[];
  }

  // CDP attaches to any tab, so ensure broad host access. Placed after the match-
  // pattern filter above (<all_urls> passes matchPatternError) so it is never dropped.
  if (opts.cdpShim) {
    if (!Array.isArray(out.host_permissions)) out.host_permissions = [];
    if (!(out.host_permissions as string[]).includes("<all_urls>")) (out.host_permissions as string[]).push("<all_urls>");
  }

  const mv = out.manifest_version ?? 2;
  // Guard the type, not just truthiness: a hand-edited manifest can set background to
  // a primitive, and assigning .persistent on a string throws in strict mode (ESM).
  if (mv === 2 && out.background && typeof out.background === "object") {
    out.background.persistent = false;
  }
  if (mv === 3 && out.background?.type === "module" && !opts.keepModuleBackground) {
    delete out.background.type;
  }

  // Safari rejects the whole manifest ("Too many shortcuts specified for commands,
  // only 4 shortcuts are allowed") when more than 4 commands carry a suggested_key
  // Safari can read. Chrome has no such cap, so bundles like TWP declare 8+. Keep the
  // first 4 (declaration order) and strip suggested_key from the rest — those commands
  // still exist and stay bindable in Safari → Settings → Extensions, they just lose
  // their default chord. Only Safari-platform chords count toward the limit; a command
  // whose suggested_key is windows/linux-only is already a dead key here.
  if (out.commands && typeof out.commands === "object") {
    let kept = 0;
    for (const def of Object.values(out.commands as Record<string, unknown>)) {
      if (!hasSafariSuggestedKey(def)) continue;
      kept++;
      if (kept > 4) delete (def as { suggested_key?: unknown }).suggested_key;
    }
  }

  // page_action has no Safari equivalent; fold it into the toolbar-button key that
  // is valid for THIS manifest version. On MV3 that's `action`; on MV2 it must be
  // `browser_action` — injecting an `action` key into an MV2 manifest makes Safari
  // reject it at load (same rule the popup-wiring below relies on). (MV3 dropped the
  // show-only-on-some-pages distinction; Safari treats both as a plain action.)
  // Treat an empty `action: {}` / `browser_action: {}` as absent — migration tools
  // leave these stubs behind, and an empty object must not block the page_action
  // fold (which would silently drop the page_action's real default_popup) nor pin
  // the wrong toolbar key below.
  const nonEmpty = (v: unknown): boolean =>
    typeof v === "object" && v !== null && Object.keys(v as object).length > 0;
  if (out.action && !nonEmpty(out.action)) delete out.action;
  if (out.browser_action && !nonEmpty(out.browser_action)) delete out.browser_action;

  if (out.page_action && !out.action && !out.browser_action) {
    const foldKey = mv === 3 ? "action" : "browser_action";
    out[foldKey] = out.page_action as Manifest["action"];
    delete out.page_action;
  }

  // MV3 requires content_security_policy to be an object keyed by context, not the
  // bare MV2 string. Safari silently ignores a string-form CSP under MV3, so the
  // extension runs with the default policy instead of the author's. Wrap it.
  if (mv === 3 && typeof out.content_security_policy === "string") {
    out.content_security_policy = { extension_pages: out.content_security_policy };
  }

  // Chrome implicitly allows an extension page to fetch/connect to its OWN bundled
  // resources (same-origin) regardless of connect-src; Safari enforces connect-src
  // strictly, so a policy that declares connect-src but omits 'self' makes Safari
  // REFUSE same-origin fetch()/XHR of bundled assets ("Refused to connect to
  // safari-web-extension://… because it does not appear in the connect-src
  // directive"). Live-proven on Grammarly: its bg fetches its own fonts/*.css and
  // the missing 'self' silently breaks init. Inject 'self' into connect-src (only
  // when the directive exists but lacks it — if there's no connect-src, the default
  // covers 'self' already). Applies to every CSP key (extension_pages, sandbox).
  out.content_security_policy = addSelfToConnectSrc(out.content_security_policy);

  // MV3 requires web_accessible_resources to be an array of {resources, matches}
  // objects. A bare MV2 string[] makes Safari reject the manifest at load. Wrap
  // the flat list, exposing it to all URLs (the MV2 default visibility).
  // A bare-string web_accessible_resources ("inject.js") is invalid even under MV2,
  // but hand edits / loose tooling produce it. Normalize to a one-element array so
  // the wrapping below applies and collectReferencedPaths stages the file.
  if (typeof out.web_accessible_resources === "string") {
    out.web_accessible_resources = [out.web_accessible_resources] as unknown as Manifest["web_accessible_resources"];
  }
  if (mv === 3 && Array.isArray(out.web_accessible_resources)) {
    const flat = out.web_accessible_resources as unknown[];
    // Handle mixed arrays per-entry: a bare string[] is MV2-style, but hand-edited
    // manifests sometimes mix loose strings with MV3 objects. Wrap only the loose
    // strings and pass the already-valid objects through untouched.
    const looseStrings = flat.filter((e): e is string => typeof e === "string");
    const objects = flat.filter((e) => typeof e === "object" && e !== null);
    if (looseStrings.length > 0) {
      out.web_accessible_resources = [
        { resources: looseStrings, matches: ["<all_urls>"] },
        ...objects,
      ] as Manifest["web_accessible_resources"];
    }
  }

  // Safari does not implement web_accessible_resources.use_dynamic_url (Chrome-only
  // per-session URL rotation). An entry left with use_dynamic_url:true is unservable
  // in Safari, so chrome.runtime.getURL() returns a URL that 404s and any asset
  // loaded that way (a content script's injected CSS, an <img>/<link>/iframe src)
  // silently fails. Clear the flag on every object entry so the resource resolves at
  // its stable static extension URL. Chrome treats the absent/false flag as the
  // default, so this is a no-op there.
  if (Array.isArray(out.web_accessible_resources)) {
    for (const entry of out.web_accessible_resources) {
      if (typeof entry === "object" && entry !== null && "use_dynamic_url" in entry && entry.use_dynamic_url === true) {
        entry.use_dynamic_url = false;
      }
    }
  }

  const existingSafari = (out.browser_specific_settings as { safari?: { strict_min_version?: string } } | undefined)?.safari;
  out.browser_specific_settings = {
    ...(out.browser_specific_settings ?? {}),
    safari: {
      ...(existingSafari ?? {}),
      strict_min_version: opts.minSafariVersion ?? existingSafari?.strict_min_version ?? DEFAULT_MIN_SAFARI_VERSION,
    },
  };

  // Ensure the toolbar button does something: wire a popup if one exists. Normalize
  // to the key VALID for this manifest version rather than trusting the input's
  // shape — MV2 must use `browser_action` (Safari rejects `action` in an MV2
  // manifest), MV3 must use `action` (Safari ignores `browser_action` under MV3, so
  // a popup wired there would be dropped). Migrate a mismatched existing key so its
  // contents (e.g. an author-set default_popup) survive into the right slot.
  const actionKey = mv === 3 ? "action" : "browser_action";
  const wrongKey = mv === 3 ? "browser_action" : "action";
  if (out[wrongKey] && !out[actionKey]) {
    out[actionKey] = out[wrongKey] as Manifest["action"];
    delete out[wrongKey];
  } else if (out[wrongKey]) {
    // Both keys present (Chrome just ignores the one invalid for its MV). Keep
    // only the valid key: Safari REJECTS an MV2 manifest carrying `action`.
    delete out[wrongKey];
  }
  const action = (out[actionKey] as Manifest["action"]) ?? {};
  if (!action.default_popup) {
    // An extension whose UI is a Chrome side panel (chrome.sidePanel) has no Safari
    // equivalent; the shim emulates sidePanel.open() by toggling the panel page as
    // the action popover — which only works when that page is wired here as
    // default_popup. Prefer the manifest's declared panel (often in a subdir, e.g.
    // ChatGPT's codex-sidepanel/index.html) over the root-level guesses below;
    // otherwise the action-click bridge wires an empty placeholder popover and the
    // panel never shows (live: ChatGPT — empty popup on click).
    const panelPath = (out.side_panel?.default_path ?? "").split(/[#?]/)[0].replace(/^\/+/, "");
    if (panelPath && existsSync(join(extPath, panelPath))) {
      action.default_popup = panelPath;
    } else if (!backgroundRegistersActionOnClicked(out, extPath)) {
      // Only guess a popup page when the toolbar button has no other behavior. If the
      // background registers action.onClicked, the button is code-driven (it toggles
      // in-page UI, opens a tab, etc.), and the extension's own popup.html is usually a
      // content-script-injected iframe (a web_accessible_resource), NOT a toolbar popup —
      // wiring it here hijacks the click into an orphan popover that never initializes
      // (Salesforce Inspector Reloaded: empty gray box). Leave default_popup unset so
      // wireActionClickBridge replays the real onClicked instead.
      for (const candidate of ["popup.html", "sidepanel.html", "panel.html", "index.html"]) {
        if (existsSync(join(extPath, candidate))) {
          action.default_popup = candidate;
          break;
        }
      }
    }
  }
  // Don't inject an empty action onto extensions that never had a toolbar button.
  if (Object.keys(action).length > 0) out[actionKey] = action;

  // Prepend the compat shim to every content script so sync/identity/sidePanel are
  // patched. Then prepend the polyfill so `browser` exists before the shim runs —
  // final order per script: [polyfill, shim, ...original].
  if ((opts.shimFile || opts.polyfillFile) && Array.isArray(out.content_scripts)) {
    for (const cs of out.content_scripts) {
      if (!Array.isArray(cs.js)) continue;
      // MAIN-world scripts run in the page context where chrome/browser don't exist;
      // the bundled webextension-polyfill throws at top level there. Leave them alone.
      if ((cs as { world?: string }).world === "MAIN") continue;
      if (opts.shimFile && !cs.js.includes(opts.shimFile)) cs.js.unshift(opts.shimFile);
      if (opts.polyfillFile && !cs.js.includes(opts.polyfillFile)) cs.js.unshift(opts.polyfillFile);
    }
  }

  // Do NOT prepend the compat shim to an MV2 background.scripts list. The shim's storage
  // relay republishes chrome/browser as a Proxy, and Safari only delivers a content
  // script's native runtime.sendMessage to the background when the background's onMessage
  // is registered on the REAL, unwrapped runtime — wrapping it drops that delivery, so a
  // content script's request (e.g. TWP's translateHTML) never reaches the background and
  // its reply never comes back. The pre-relay builds never injected the shim into the MV2
  // background and worked; match that. (MV3 service workers are handled separately by
  // convertServiceWorkerToBackgroundPage, which builds background.html with the shim.)

  return out;
}

export function writeManifest(targetDir: string, manifest: Manifest): void {
  // Chrome tolerates `content_scripts: []`; Safari rejects it outright ("Empty or
  // invalid content_scripts manifest entry") and refuses to load the extension
  // (live: ChatGPT ships an empty array). Drop the key when nothing populated it —
  // this is the final write, after every content-script wiring step has run.
  if (Array.isArray(manifest.content_scripts) && manifest.content_scripts.length === 0) {
    delete manifest.content_scripts;
  }
  writeFileSync(join(targetDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}
