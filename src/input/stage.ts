import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, lstatSync, statSync, realpathSync, copyFileSync } from "node:fs";
import { basename, join, dirname, resolve, relative, sep } from "node:path";
import { cleanExtendedAttributes } from "./extract.js";
import type { Manifest } from "../types.js";

/** Names/globs excluded from the clean staged extension. */
const EXCLUDE_EXACT = new Set([
  ".DS_Store",
  "__MACOSX",
  ".git",
  ".gitignore",
  ".github",
  ".svn",
  "node_modules",
  "_metadata", // Chrome Web Store signing metadata
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "tsconfig.json",
]);

const EXCLUDE_SUFFIX = [".map", ".ts", ".tsx", ".md", ".log"];
// Doc/config files: bare name or name + extension only (e.g. "LICENSE",
// "LICENSE.txt"), never a prefix match — that would drop legit runtime files
// like "LICENSE_KEY.js" or "READMExporter.js".
// Only doc-typed variants (or the bare name). A runtime file that merely shares
// the name — changelog.html, license.js, Changelog.json — must ship, or it 404s
// at runtime (only manifest-referenced paths are otherwise protected).
const EXCLUDE_DOC_RE = /^(README|CHANGELOG|LICENSE)(\.(txt|md|markdown|rst|adoc))?$/i;
const EXCLUDE_DOTFILE = [".eslint", ".prettier"];

function shouldExclude(name: string): boolean {
  if (EXCLUDE_EXACT.has(name)) return true;
  if (EXCLUDE_SUFFIX.some((s) => name.endsWith(s))) return true;
  if (EXCLUDE_DOC_RE.test(name)) return true;
  if (EXCLUDE_DOTFILE.some((p) => name.startsWith(p))) return true;
  return false;
}

/**
 * Copy the extension into stageDir, dropping dev cruft and store metadata.
 * The manifest + shim are written separately by the caller afterward.
 * stageDir is recreated fresh each run.
 *
 * `keep` is a set of manifest-relative paths (forward-slash) that the manifest
 * declares as runtime assets; these are copied even if their name matches an
 * exclusion rule — otherwise a web-accessible LICENSE.txt or a .map served to a
 * page would be dropped and 404 in Safari.
 */
// Returns the manifest-referenced asset paths that could NOT be staged (a kept symlink
// whose target escaped the tree, vanished, or failed to copy). The caller warns on
// these — otherwise they 404 in Safari with no build-time signal.
export function stageExtension(sourceDir: string, stageDir: string, keep: Set<string> = new Set()): string[] {
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  const root = resolve(sourceDir);
  // Realpath'd root for the kept-symlink containment check below. resolve() doesn't
  // collapse symlinked ancestors, but realpathSync(srcLink) does — so on macOS where
  // scratch dirs live under /tmp (a symlink to /private/tmp), an in-tree target would
  // realpath to /private/... and fail `startsWith(root)`, silently dropping the asset.
  let realRoot = root;
  try { realRoot = realpathSync(root); } catch { /* source missing → cpSync errors anyway */ }
  cpSync(sourceDir, stageDir, {
    recursive: true,
    filter: (src) => {
      const rel = relative(root, resolve(src)).split(sep).join("/");
      if (rel === "") return true; // the stage root itself
      // Never copy symlinks into the package. cpSync reproduces them verbatim, so a
      // link in the source (evil.txt -> /etc/hosts) would ship a dangling/absolute
      // link that leaks the build host's layout and 404s in Safari. Drop them.
      // lstat can throw on a broken/racing entry; an unguarded throw here escapes the
      // filter and aborts the whole copy with an opaque ENOENT — exclude on error.
      let st;
      try { st = lstatSync(src); } catch { return false; }
      if (st.isSymbolicLink()) return false;
      // A manifest-referenced path is always kept, even under an excluded ancestor.
      if (keep.has(rel)) return true;
      // Excluded if its own name OR any ancestor segment is excluded — this stops a
      // file like _metadata/junk.js (parent excluded) from riding in just because
      // its own basename is clean.
      const segments = rel.split("/");
      if (segments.some(shouldExclude)) {
        // Still allow an excluded directory to be entered when a kept path lives
        // inside it; cpSync won't recurse otherwise and the kept child is lost.
        const asDir = rel + "/";
        for (const k of keep) if (k.startsWith(asDir)) return true;
        return false;
      }
      return true;
    },
  });

  // The filter above drops ALL symlinks (verbatim-copied links 404 in Safari and
  // leak the build host's layout). But a manifest-referenced asset that happens to
  // be a symlink in the source (common with pnpm/monorepo asset linking) is a real
  // runtime dependency — dropping it 404s the page that needs it. For kept paths
  // only, dereference the link and copy the actual target file (staying inside the
  // source tree) so the bytes ship without the dangling-link hazard.
  const dropped: string[] = [];
  for (const rel of keep) {
    const srcLink = join(root, rel);
    let lst;
    try { lst = lstatSync(srcLink); } catch { continue; }
    // Skip only when it's a plain file cpSync already staged. A non-link that never
    // got staged means an ancestor directory was a symlink (dropped by the filter),
    // so fall through and dereference it via realpathSync below.
    if (!lst.isSymbolicLink() && existsSync(join(stageDir, rel))) continue;
    let target;
    try {
      target = realpathSync(srcLink);
      // Only follow links whose target stays inside the source tree (compare against
      // the realpath'd root so a symlinked ancestor like /tmp→/private/tmp doesn't
      // make an in-tree target look external).
      if (target !== realRoot && !target.startsWith(realRoot + sep)) { dropped.push(rel); continue; }
      if (!statSync(target).isFile()) { dropped.push(rel); continue; }
    } catch { dropped.push(rel); continue; }
    const dest = join(stageDir, rel);
    try { mkdirSync(dirname(dest), { recursive: true }); copyFileSync(target, dest); }
    catch { dropped.push(rel); }
  }

  cleanExtendedAttributes(stageDir);
  return dropped;
}

const SOURCEMAP_RE = /^[ \t]*\/\/[#@] sourceMappingURL=(\S+)[ \t]*\r?$/gm;

// Safari drops the LAST entry of _locales/<locale>/messages.json. Live on
// Tampermonkey: `v0version0` ("v$version$") is the final message and getMessage
// returned "" for it in every form — no substitution, string substitution, array
// substitution — while `top_level_await`, the entry immediately before it, resolved
// fine. Nothing about the entry is special (its neighbours past the same byte offset
// work, and other placeholder messages work); it is dropped for being last. The
// extension then falls back to displaying the raw message key, which is how the
// Tampermonkey dashboard came to render a literal "v0version0" as its version.
//
// Append a sacrificial message so the extension's own last string is no longer last.
// The insert is textual, before the closing brace, so every existing byte (formatting,
// escapes, unicode) survives exactly as shipped. Returns files modified.
const LOCALE_TAIL_GUARD = "viaduct_locale_tail_guard";

export function guardLocaleTailMessage(stageDir: string): number {
  const localesDir = join(stageDir, "_locales");
  if (!existsSync(localesDir)) return 0;
  let modified = 0;
  for (const entry of readdirSync(localesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(localesDir, entry.name, "messages.json");
    if (!existsSync(file)) continue;
    let raw: string;
    try {
      raw = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    // Only touch a catalog we can confirm is a non-empty JSON object — a broken or
    // empty one has no last message to lose, and rewriting it could only make things
    // worse.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const keys = Object.keys(parsed as Record<string, unknown>);
    if (keys.length === 0 || keys[keys.length - 1] === LOCALE_TAIL_GUARD) continue;
    const close = raw.lastIndexOf("}");
    if (close < 0) continue;
    const next =
      raw.slice(0, close) +
      `,"${LOCALE_TAIL_GUARD}":{"message":"viaduct"}` +
      raw.slice(close);
    writeFileSync(file, next, "utf-8");
    modified++;
  }
  return modified;
}

export function walkScripts(dir: string, acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith("__MACOSX")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkScripts(full, acc);
    else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".mjs"))) acc.push(full);
  }
  return acc;
}

/**
 * Strip `//# sourceMappingURL=…` comments that point at a .map file no longer
 * present in the staged extension (stageExtension excludes *.map as dev cruft).
 * A dangling reference makes Safari's Web Inspector emit a 404 for the missing
 * map on every load. Only strips refs whose target is gone and is a local path —
 * data: URIs (inline maps) and existing maps are left untouched. Returns the
 * number of files modified.
 */
export function stripDanglingSourcemaps(stageDir: string): number {
  let modified = 0;
  for (const file of walkScripts(stageDir)) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    let changed = false;
    const next = content.replace(SOURCEMAP_RE, (whole, url: string) => {
      if (url.startsWith("data:")) return whole; // inline map, self-contained
      // Resolve relative to the script; keep the ref if the map actually shipped.
      const mapPath = resolve(dirname(file), url);
      if (existsSync(mapPath)) return whole;
      changed = true;
      return "";
    });
    if (changed) {
      writeFileSync(file, next, "utf-8");
      modified++;
    }
  }
  return modified;
}

// Safari's `chrome.scripting` (and `chrome.runtime` etc.) are EXOTIC, IMMUTABLE host
// slots: the shim cannot install the `ExecutionWorld`/`RegistrationWorld` enum objects
// onto them (assign/defineProperty are silent no-ops, delete re-materializes the empty
// native slot — proven live). Bundles read e.g. `chrome.scripting.ExecutionWorld.ISOLATED`
// at runtime and get `undefined.ISOLATED` → TypeError that aborts the call (Bitwarden:
// "undefined is not an object (evaluating 'chrome.scripting.ExecutionWorld.ISOLATED')").
// Since the enum members are fixed string constants, rewrite the reads to their literal
// values directly in the staged source. Covers chrome|browser, dot or ["bracket"] access
// for the namespace step, and the two enums Safari omits. Returns files modified.
//
// Literal-substitution, not a JS parser. These enums are only ever read as
// `.ExecutionWorld.<MEMBER>` member chains in real bundles (verified across the corpus);
// a regex is enough and can't mangle unrelated code. If a bundle ever aliased the enum
// object itself (`const W = chrome.scripting.ExecutionWorld`) we'd need AST work — add
// then.
// ExecutionWorld and RegistrationWorld are identical enums whose value === member
// name, so this is just an allowlist of valid members (any unknown member is left
// untouched). If a future enum ever has value !== name, switch back to a name→value map.
const ENUM_MEMBERS = new Set(["ISOLATED", "MAIN"]);
// e.g.  chrome.scripting.ExecutionWorld.ISOLATED  |  browser["scripting"].RegistrationWorld.MAIN
// (?<![\w$.]) plus the optional global prefix: `self.chrome.scripting...` must be
// consumed WHOLE (matching from `chrome` would leave `self."ISOLATED"` — a
// SyntaxError), while `myObj.chrome.scripting...` must not match at all.
const ENUM_RE =
  /(?<![\w$.])(?:(?:self|globalThis|window)\s*\.\s*)?(?:chrome|browser)\s*(?:\.\s*scripting|\[\s*["']scripting["']\s*\])\s*\.\s*(ExecutionWorld|RegistrationWorld)\s*\.\s*([A-Z_]+)\b/g;

export function inlineImmutableEnums(stageDir: string): number {
  let modified = 0;
  for (const file of walkScripts(stageDir)) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    let changed = false;
    const next = content.replace(ENUM_RE, (whole, _enumName: string, member: string) => {
      if (!ENUM_MEMBERS.has(member)) return whole; // unknown member — leave it untouched
      changed = true;
      return JSON.stringify(member); // "ISOLATED"
    });
    if (changed) {
      writeFileSync(file, next, "utf-8");
      modified++;
    }
  }
  return modified;
}

// Chrome bundles bake the literal scheme of their own pages into compiled
// platform tables and URL checks:
//   INTERNAL_PAGE_PROTOCOLS: ["chrome-extension:"]        (Tampermonkey)
//   sender.url.startsWith("chrome-extension://")           (common idiom)
// On Safari every extension page is safari-web-extension://…, so each of these
// checks is false at runtime. The damage is silent and structural: message
// dispatchers that gate privileged methods on "is the sender one of my own
// pages?" refuse every popup/options RPC, and the page waiting on the reply
// renders nothing (Tampermonkey's action popup: loadTree refused → blank).
// A chrome-extension:// URL can never legitimately occur inside Safari, so the
// literal is dead code unless rewritten. Swap the scheme token to Safari's in
// the staged sources; host/path parts of any such URL are left untouched.
// Must run BEFORE the shim/polyfill are written — those templates carry
// chrome-extension:// strings on purpose (origin spoofing) and must keep them.
//
// Token substitution, not a JS parser. Matches the scheme token
// wherever it appears (comments too — harmless). A dual-browser bundle that
// compares against BOTH schemes ends up with two equal branches; the first
// wins, same outcome either way.
//
// EXCEPT concrete-host URLs: "chrome-extension://<id>/…" (id literal or ${…}
// interpolation) is never a local check the swap can fix — Safari's page host
// is a per-install UUID, so the host part can't match regardless of scheme.
// Such literals are server-bound tokens instead, above all OAuth redirect_uris
// registered verbatim with the provider (Claude in Chrome:
// chrome-extension://<id>/oauth_callback.html); rewriting one turns a working
// login into "Redirect URI … is not supported by client". Keep them intact.
// A wildcard host ("chrome-extension://*/…", match patterns) still rewrites —
// there the scheme is the only thing that can mismatch.
const CHROME_SCHEME_RE = /(?<![-\w])chrome-extension:(?!\/\/[\w$])/g;

export function rewriteChromeSchemeLiterals(stageDir: string): number {
  let modified = 0;
  for (const file of walkScripts(stageDir)) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (!CHROME_SCHEME_RE.test(content)) continue;
    CHROME_SCHEME_RE.lastIndex = 0;
    writeFileSync(file, content.replace(CHROME_SCHEME_RE, "safari-web-extension:"), "utf-8");
    modified++;
  }
  return modified;
}

// Bundles route extension-page ports (popup / side panel / devtools) by testing the
// sender's URL against a RegExp built from chrome.runtime.id:
//   new RegExp(chrome.runtime.id + "/src/popup.html").test(port.sender.url)
// On Chrome that works because runtime.id IS the host of every extension URL. On Safari
// it CANNOT: runtime.id is the App-Extension BUNDLE id ("com.x.Extension (TEAM)"), while
// sender.url's host is the per-install UUID — two different strings, and the bundle id even
// contains regex metacharacters. Safari exposes chrome.runtime.id as a frozen/exotic slot
// (assignment AND defineProperty silently no-op, and chrome.runtime itself can't be replaced
// — all proven live), so the shim cannot fix runtime.id at runtime. The port is never
// routed → the bg posts no reply → the popup's init RPC never resolves (e.g. Grammarly hangs
// on "starting…").
//
// Fix at conversion time: drop the `runtime.id +` prefix so the matcher becomes
//   new RegExp("/src/popup.html").test(sender.url)
// which is host-agnostic and matches the real Safari URL (any UUID host, and tolerant of
// Safari's "?tabId=N" query — the path substring still matches). It stays path-specific, so
// popup/sidePanel/devtools matchers remain distinct and content-script URLs don't match.
//
// Literal substitution, not a JS parser. Targets the exact, common shape
// `new RegExp(<chrome|browser>[.|["..."]]runtime.id + "<path>")`. A bundle that built the
// pattern some other way (string concat into a var first) would need AST work — add then.
const RUNTIME_ID_URL_RE =
  /new\s+RegExp\s*\(\s*(?:chrome|browser|self|globalThis|window)?\s*(?:\.\s*chrome|\.\s*browser)?\s*\.\s*runtime\s*\.\s*id\s*\+\s*(["'])((?:\\.|(?!\1).)*)\1\s*\)/g;

export function rewriteRuntimeIdUrlMatchers(stageDir: string): number {
  let modified = 0;
  for (const file of walkScripts(stageDir)) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    let changed = false;
    const next = content.replace(RUNTIME_ID_URL_RE, (whole, quote: string, path: string) => {
      // Only rewrite when the appended literal looks like a URL path (starts with "/").
      // That's the port-routing idiom; anything else we leave alone to stay conservative.
      if (!path.startsWith("/")) return whole;
      changed = true;
      return "new RegExp(" + quote + path + quote + ")";
    });
    if (changed) {
      writeFileSync(file, next, "utf-8");
      modified++;
    }
  }
  return modified;
}

// Chrome extension pages sit in a nested browsing context, so bundles read
// `location.ancestorOrigins[0]` to learn who framed them (e.g. "am I the top-level
// extension page?"). In Safari the extension popup/options page is TOP-LEVEL, so
// ancestorOrigins is an EMPTY DOMStringList — present (the `?.` guard passes) but
// [0] is undefined, and the trailing `.includes(...)` throws at module top level.
// A module that throws before it renders leaves a blank white popup (Salesforce
// Inspector Reloaded: popup.js line 1 → empty popover).
//
// Guard the index read so the method call sees an empty string instead of undefined:
//   location.ancestorOrigins?.[0].includes(x)  ->  (location.ancestorOrigins?.[0] || "").includes(x)
//   location.ancestorOrigins[0].includes(x)    ->  (location.ancestorOrigins[0] || "").includes(x)
// "" is falsy and safely answers every string method (.includes/.indexOf/.startsWith
// → false/-1), matching what the check wants when there's no ancestor: "not framed".
//
// Literal substitution, not a JS parser. Matches the `.ancestorOrigins` access with an
// immediate `[0]` (optional-chained or plain) that is followed by a method call. Only that
// followed-by-`.`method shape can throw here; a bare `ancestorOrigins[0]` assigned to a var
// is left alone (already undefined-tolerant).
// The receiver of `.ancestorOrigins` is always a dotted-identifier Location chain
// (location, window.location, self.location, document.location, top.location), so the
// walk-back class is plain identifier chars + `.`/`?.`. It must NOT include `)` or `]`:
// a `)`/`]` in the class lets the match START mid-expression (e.g. at the `)` of
// `foo().ancestorOrigins…`), and the `|| ""` wrap then emits unbalanced `foo((…))` —
// a SyntaxError that kills the whole file. (Latent: real bundles never call-through to
// ancestorOrigins, but a token class must not be able to produce invalid output.)
const ANCESTOR_ORIGINS_RE =
  /((?:[\w$.]|\?\.)+\.ancestorOrigins(\?\.\[0\]|\[0\]))(?=\s*\.)/g;

export function guardAncestorOriginsAccess(stageDir: string): number {
  let modified = 0;
  for (const file of walkScripts(stageDir)) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    let changed = false;
    const next = content.replace(ANCESTOR_ORIGINS_RE, (whole) => {
      changed = true;
      return "(" + whole + ' || "")';
    });
    if (changed) {
      writeFileSync(file, next, "utf-8");
      modified++;
    }
  }
  return modified;
}

// Safari re-evaluates a content-script group a SECOND time into a world that already
// ran it. It happens for the document_end / document_idle groups on all_frames pages:
// an about:blank / about:srcdoc subframe (and some same-origin navigations) shares the
// parent frame's isolated world, and Safari fires the injection for it again — so every
// file in the group is evaluated twice in one world. Chrome gives each such frame its own
// world and never does this.
//
// The second evaluation is fatal only where a file has a top-level `const`/`let`/`class`:
// re-declaring a lexical binding throws "Can't create duplicate variable" and aborts the
// rest of the group, so the extension's content side dies (TWP: `const twpI18n` in i18n.js
// then `const startMark` in pageTranslator.js — the exact two errors reported). Viaduct's
// own shim/polyfill survive the same double-eval purely because they declare with `var`,
// whose re-declaration is a silent no-op.
//
// Do the same for the extension: demote each COLUMN-0 (top-level) `const`/`let` to `var`.
// These are module-scoped singletons assigned once; `var` keeps them global — which they
// MUST stay, since TWP's files share `twpI18n` / `startMark` across the group — and makes
// the redeclaration harmless. Nothing changes on the normal single-eval path. Scoped to
// files referenced by an isolated-world content_scripts entry (the only realm that
// double-injects); background/popup/library files and world:"MAIN" scripts are untouched.
//
// Literal, line-anchored substitution, not a JS parser: only column-0 declarations match,
// so block-scoped `const`/`let` inside functions/loops are left alone, and minified
// bundles (everything on one line, already IIFE-wrapped) are naturally skipped. Top-level
// `class` is left as-is — no real content-script bundle declares one bare at top level; if
// one ever does, `var C = class {…}` needs AST work, add then.
const TOPLEVEL_LEXICAL_RE = /^(const|let)([ \t]+[$A-Za-z_])/gm;

export function idempotentContentScriptGlobals(
  stageDir: string,
  manifest: { content_scripts?: Array<{ js?: unknown; world?: string }> }
): number {
  const files = new Set<string>();
  for (const cs of manifest.content_scripts ?? []) {
    if (cs.world === "MAIN") continue; // page world; not re-injected into a shared isolated world
    if (!Array.isArray(cs.js)) continue;
    for (const j of cs.js) {
      // Normalize like collectReferencedPaths so we hit the same on-disk file the
      // stager wrote: "/lib/x.js", "./lib/x.js", and backslash paths all resolve.
      if (typeof j === "string" && j) files.add(j.replace(/^\.?\//, "").replace(/\\/g, "/"));
    }
  }
  let modified = 0;
  for (const rel of files) {
    const file = join(stageDir, rel);
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (!TOPLEVEL_LEXICAL_RE.test(content)) continue;
    TOPLEVEL_LEXICAL_RE.lastIndex = 0;
    writeFileSync(file, content.replace(TOPLEVEL_LEXICAL_RE, "var$2"), "utf-8");
    modified++;
  }
  return modified;
}

// A template literal whose ENTIRE value is `chrome-extension://${<ext-id>}/<path>` is a
// self-page navigation (fed to tabs.create / window.open / location=), NOT an OAuth
// redirect_uri. rewriteChromeSchemeLiterals deliberately skips `chrome-extension://${…}`
// to preserve redirect_uris registered with the provider — but that also skips these real
// navigations, which then point at a scheme+host that don't exist in Safari (the scheme is
// safari-web-extension:// and the host is a per-install UUID, not @@extension_id). Result:
// Salesforce Inspector's keyboard-command page opens (data-export, options, …) land on a
// dead chrome-extension://<bundle-id>/foo.html tab.
//
// Rewrite them to chrome.runtime.getURL(`<path>`), which resolves to the correct Safari
// scheme + UUID host at runtime. Safe because we ONLY match when the backtick immediately
// precedes `chrome-extension://` (the literal IS the whole URL) and the host is an
// extension-id expression — so an embedded redirect_uri like `…redirect_uri=${browser}-
// extension://…` inside a larger authorize URL never matches (its scheme is interpolated,
// and it isn't at the start of the literal).
//
// Host expr covered: chrome.i18n.getMessage("@@extension_id"), (chrome|browser).runtime.id.
const SELF_PAGE_URL_RE =
  /`chrome-extension:\/\/\$\{\s*(?:(?:chrome|browser)\s*\.\s*i18n\s*\.\s*getMessage\s*\(\s*(["'])@@extension_id\1\s*\)|(?:chrome|browser)\s*\.\s*runtime\s*\.\s*id)\s*\}\/([^`]*)`/g;

export function rewriteSelfPageExtensionUrls(stageDir: string): number {
  let modified = 0;
  for (const file of walkScripts(stageDir)) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    let changed = false;
    const next = content.replace(SELF_PAGE_URL_RE, (_whole, _q, path: string) => {
      changed = true;
      return "chrome.runtime.getURL(`" + path + "`)";
    });
    if (changed) {
      writeFileSync(file, next, "utf-8");
      modified++;
    }
  }
  return modified;
}

// MV3 bundles decide "am I the background?" by the absence of `window`, because in Chrome
// the background is a service worker. Safari has no offscreen documents and an unreliable
// SW background, so the conversion turns the worker into a background PAGE — which HAS a
// window, so the check says no and the bundle concludes it is a content script. Anything
// keyed off that identity then misroutes silently: no error, no log, just a promise that
// never settles. Live: Cloaked's crx-kit dispatcher opens with
// `if (msg.to !== this.myEndpoint) return false`, and its background page reported
// FOREGROUND — so clicking "Log in" delivered {to:"BACKGROUND", name:"openAuthUrl"} to a
// listener that dropped it on the floor, and the popup spun forever.
//
// Only rewritten inside the files the background itself loads, and only where the check
// directly produces a background-ish value — so a bundled library using the same idiom to
// pick a Node path, or the identical detector inside the POPUP bundle (which must keep
// answering "foreground"), is never touched.
const WINDOW_IS_UNDEFINED = [
  String.raw`void\s+0\s*===?\s*(?:globalThis\.|self\.)?window`,
  String.raw`(?:globalThis\.|self\.)?window\s*===?\s*void\s+0`,
  String.raw`typeof\s+(?:globalThis\.|self\.)?window\s*===?\s*(?:"undefined"|'undefined')`,
  String.raw`(?:"undefined"|'undefined')\s*===?\s*typeof\s+(?:globalThis\.|self\.)?window`,
  // terser shorthand: a type string sorts after "u" only when it is "undefined"
  String.raw`typeof\s+(?:globalThis\.|self\.)?window\s*>\s*(?:"u"|'u')`,
].join("|");

const BACKGROUND_LITERAL =
  String.raw`(?:"|')(?:background|background_script|backgroundScript|background-script|service_worker|serviceWorker|sw)(?:"|')`;

/** `if (typeof window === "undefined") return "background_script"` */
const BG_CHECK_RETURN_RE = new RegExp(
  // `return` may butt straight against the quote — minifiers emit `return"background"`.
  String.raw`(\bif\s*\(\s*)(?:${WINDOW_IS_UNDEFINED})(\s*\)\s*\{?\s*return\s*${BACKGROUND_LITERAL})`,
  "g",
);

/** `typeof window === "undefined" ? "background" : …` */
const BG_CHECK_TERNARY_RE = new RegExp(
  String.raw`(?:${WINDOW_IS_UNDEFINED})(\s*\?\s*${BACKGROUND_LITERAL})`,
  "g",
);

/** Absolute paths of the staged scripts the background context loads. */
function backgroundScriptPaths(stageDir: string, manifest: Manifest): string[] {
  const rel: string[] = [];
  const sw = manifest.background?.service_worker;
  if (typeof sw === "string") rel.push(sw);
  for (const s of manifest.background?.scripts ?? []) if (typeof s === "string") rel.push(s);
  return rel
    .map((r) => join(stageDir, r.replace(/^\.?\//, "")))
    .filter((p) => existsSync(p));
}

export function rewriteBackgroundContextChecks(stageDir: string, manifest: Manifest): number {
  let modified = 0;
  for (const file of backgroundScriptPaths(stageDir, manifest)) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    // The file IS the background, page or worker, so the check's answer is
    // unconditionally yes.
    const next = content
      .replace(BG_CHECK_RETURN_RE, "$1true$2")
      .replace(BG_CHECK_TERNARY_RE, "true$1");
    if (next !== content) {
      writeFileSync(file, next, "utf-8");
      modified++;
    }
  }
  return modified;
}
