import { writeFileSync, readFileSync, readdirSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname, relative, basename } from "node:path";
import type { Manifest } from "../types.js";
import { TEMPLATE_DIR, RUNTIME_DIR } from "../paths.js";
import { resolveI18nString } from "../manifest/manifest.js";
import { walkScripts } from "../input/stage.js";

export const SHIM_FILENAME = "safari-compat-shim.js";
export const POLYFILL_FILENAME = "browser-polyfill.min.js";
// Fallback name used when the extension already ships its OWN browser-polyfill.min.js
// (uBlock Origin does). Writing viaduct's polyfill over that file replaced the exact
// build the extension's content scripts were compiled against; uBlock's vapi.js then
// threw at load and every script after it in the content-script list (contentscript.js,
// the cosmetic filter) never ran. Keep the extension's file intact and load viaduct's
// under this distinct name instead.
export const POLYFILL_ALT_FILENAME = "viaduct-browser-polyfill.min.js";
export const BACKGROUND_PAGE_FILENAME = "background.html";
export const SW_LIFECYCLE_FILENAME = "viaduct-sw-lifecycle.js";
export const ACTION_HOTKEY_FILENAME = "__viaduct-hotkey.js";
export const USERSCRIPTS_CS_FILENAME = "__viaduct-userscripts.js";
export const CDP_KEEPALIVE_FILENAME = "viaduct-cdp-keepalive.js";

/**
 * Copy the bundled webextension-polyfill into the staged extension so Chrome code
 * that calls promise-based `browser.*` runs on every browser. The polyfill no-ops
 * when a native `browser` already exists (Safari/Firefox) and otherwise wraps
 * `chrome.*` callbacks as promises. Must load BEFORE the compat shim so the shim's
 * `browser`-namespace patches apply to the polyfilled object. Returns the filename
 * or undefined if the template is unavailable.
 */
export function writePolyfill(targetDir: string): string | undefined {
  const src = join(TEMPLATE_DIR, POLYFILL_FILENAME);
  if (!existsSync(src)) return undefined;
  // Don't clobber the extension's own browser-polyfill.min.js. webextension-polyfill
  // is idempotent (it no-ops once `browser` exists), so loading viaduct's copy under a
  // second name alongside the extension's is harmless, whereas overwriting the
  // extension's build breaks scripts compiled against it.
  const name = existsSync(join(targetDir, POLYFILL_FILENAME)) ? POLYFILL_ALT_FILENAME : POLYFILL_FILENAME;
  copyFileSync(src, join(targetDir, name));
  return name;
}

/**
 * Wire the CDP keep-alive content script (declared on <all_urls>) for extensions that
 * use chrome.debugger. Safari suspends the non-persistent MV3 background between the
 * agent's CDP command bursts, stalling the connectNative poll loop and dropping the
 * agent's connection. Safari keeps the background LOADED while a runtime.connect port is
 * open to it, and (unlike an injected executeScript port) a DECLARED content script's
 * port persists — so this script holds that port for the duration of a debugger session.
 * Idempotent; a no-op if the extension has no matching content-script host.
 */
export function wireCdpKeepalive(dir: string, manifest: Manifest): boolean {
  const src = join(TEMPLATE_DIR, CDP_KEEPALIVE_FILENAME);
  if (!existsSync(src)) return false;
  copyFileSync(src, join(dir, CDP_KEEPALIVE_FILENAME));
  const cs = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  cs.push({ matches: ["<all_urls>"], js: [CDP_KEEPALIVE_FILENAME], run_at: "document_start", all_frames: false });
  manifest.content_scripts = cs;
  return true;
}

/**
 * Runtime compatibility shim, prepended to content scripts.
 * Patches the gaps documented in the engineering guide so calls degrade
 * gracefully instead of throwing.
 */
/** Build-time config baked into the shim. All values are derived generically
 *  from the source manifest — nothing extension-specific is hardcoded. */
export interface ShimConfig {
  /** chrome-extension://<id> origin to spoof on proxied requests, or "" if the
   *  source manifest had no `key` to derive an id from. */
  chromeOrigin?: string;
  /** Bare hostnames the extension declares it talks to (host_permissions +
   *  externally_connectable). A cross-origin request to one of these that the
   *  browser blocks (CORS/401/403) is retried through the native host. */
  proxyHosts?: string[];
  /** Install the chrome.debugger / CDP emulation block. convert.ts passes needsCdpShim; when omitted the shim block self-defaults ON (so direct shimSource() calls in tests keep it enabled). */
  cdp?: boolean;
}

export function shimSource(config: ShimConfig = {}): string {
  // The proxy allowlist + spoofed origin are injected as a JSON literal so the
  // shim needs no string interpolation of untrusted data into code. The runtime
  // JS lives in src/runtime/safari-compat-shim.js (a real, lintable .js file);
  // we read it and substitute the one placeholder. Reading bytes verbatim keeps
  // every regex backslash (/\\$(\\d+)/, /api\\.anthropic\\.com/) intact — no
  // template-literal escaping to corrupt them.
  // JSON.stringify leaves U+2028/U+2029 raw — legal in JSON but a line terminator
  // inside a JS string literal, so an exotic host carrying one would make the
  // emitted shim a SyntaxError (→ whole shim dead). Escape them to \u form.
  const proxyCfg = JSON.stringify({
    origin: config.chromeOrigin || "",
    hosts: config.proxyHosts || [],
    cdp: config.cdp !== false,
  }).replace(/[\u2028\u2029]/g, (c) => c === "\u2028" ? "\\u2028" : "\\u2029");
  const runtime = readFileSync(join(RUNTIME_DIR, SHIM_FILENAME), "utf-8");
  // split/join = global replace; the placeholder appears once today, but a stray
  // second occurrence must not survive as invalid JS (matches oauth-bridge.ts).
  return runtime.split("__C2S_PROXY_CONFIG_JSON__").join(proxyCfg);
}

export function writeShim(targetDir: string, config: ShimConfig = {}): string {
  const p = join(targetDir, SHIM_FILENAME);
  writeFileSync(p, shimSource(config), "utf-8");
  return SHIM_FILENAME;
}

/** Hostnames the extension declares it talks to: host_permissions +
 *  externally_connectable.matches. These are the backends that may reject the
 *  Safari origin and therefore need native-host proxying. Generic — derived
 *  purely from the manifest. */
export function deriveProxyHosts(manifest: Manifest): string[] {
  const patterns: string[] = [];
  if (Array.isArray(manifest.host_permissions)) patterns.push(...manifest.host_permissions);
  const ec = manifest.externally_connectable;
  if (ec && Array.isArray(ec.matches)) patterns.push(...ec.matches);
  // CSP connect-src is where API endpoints are declared when host_permissions is
  // a broad wildcard (<all_urls>). These https/wss origins are the real backends.
  const csp = manifest.content_security_policy;
  const cspStr = typeof csp === "string" ? csp : csp?.extension_pages ?? "";
  const connect = /(?:^|;)\s*connect-src\s+([^;]+)/i.exec(cspStr);
  if (connect) {
    for (const tok of connect[1].split(/\s+/)) {
      if (/^(https?|wss?):\/\//i.test(tok)) patterns.push(tok);
    }
  }
  const hosts = new Set<string>();
  for (const pat of patterns) {
    if (typeof pat !== "string") continue;
    // Match patterns / CSP sources: "*://*.example.com/*", "https://api.foo.com/*",
    // "wss://api.foo.com". Strip scheme, leading "*.", port, and any path.
    const m = /^[^:]+:\/\/([^/]+)/.exec(pat);
    if (!m) continue;
    const host = m[1].replace(/^\*\./, "").replace(/:\d+$/, "");
    // Skip wildcard-only hosts (<all_urls>, "*") — too broad to proxy safely.
    if (!host || host === "*" || host.includes("*")) continue;
    hosts.add(host.toLowerCase());
  }
  return [...hosts];
}

/**
 * Index just past the first REAL `<head ...>` tag, skipping any `<head>` that
 * sits inside an HTML comment (`<!-- <head> -->`). Injecting a <script> after a
 * commented-out head buries it inside the comment → it never runs (blank popup /
 * dead page). Returns -1 when there's no usable head tag.
 */
function headInsertIndex(html: string): number {
  const re = /<head(?=[\s/>])[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    // Inside a comment if the last "<!--" before this point has no "-->" before
    // the head tag. indexOf returning -1 means the comment is never closed at
    // all (unterminated) — still inside it, so skip this head too.
    const open = html.lastIndexOf("<!--", m.index);
    if (open !== -1) {
      const close = html.indexOf("-->", open);
      if (close === -1 || close > m.index) continue;
    }
    return m.index + m[0].length;
  }
  return -1;
}

function walkHtmlFiles(dir: string, acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name === "node_modules" || name === ".git" || name.startsWith("__MACOSX")) continue;
    const full = join(dir, name);
    if (entry.isDirectory()) walkHtmlFiles(full, acc);
    else if (entry.isFile() && name.toLowerCase().endsWith(".html")) acc.push(full);
  }
  return acc;
}

/**
 * Inject the polyfill (optional) + shim as the first <head> scripts of every
 * extension HTML page (recursively — options/sidepanel pages often live in
 * subdirs). The tags use root-absolute src so they resolve from any depth.
 * Module scripts are deferred, so classic scripts placed in <head> run first —
 * the polyfill defines `browser`, then the shim patches missing chrome / browser
 * namespaces, all before bundle module-eval.
 */
const COLOR_SCHEME_MARKER = "c2s-color-scheme";

/**
 * Does the page (or the stylesheets it links from the same staged dir) handle dark
 * mode itself? A page that declares `color-scheme` or has any `prefers-color-scheme`
 * media query is theme-aware and must be left alone. Everything else is a
 * light-only page: Chrome renders extension pages light regardless of the OS theme,
 * but Safari honors the OS dark mode — so a light-only page gets a dark default text
 * color over its explicit `background:white` islands and goes white-on-white (live:
 * "Chrome extension source viewer" file list is invisible in Safari dark mode).
 */
function pageHandlesDarkMode(dir: string, htmlFile: string, html: string): boolean {
  const declaresTheme = (css: string): boolean =>
    /prefers-color-scheme/i.test(css) || /\bcolor-scheme\s*:/i.test(css);
  if (declaresTheme(html)) return true;
  // Also honor a <meta name="color-scheme"> the page already ships.
  if (/<meta[^>]+name\s*=\s*["']color-scheme["']/i.test(html)) return true;
  // Read every same-dir stylesheet the page links (skip absolute/remote hrefs).
  const linkRe = /<link\b[^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*>/gi;
  const hrefRe = /\bhref\s*=\s*["']([^"']+)["']/i;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const href = hrefRe.exec(m[0])?.[1];
    if (!href || /^(https?:)?\/\//i.test(href) || href.startsWith("data:")) continue;
    const cssPath = join(dirname(htmlFile), href.split("?")[0].split("#")[0]);
    try {
      if (declaresTheme(readFileSync(cssPath, "utf-8"))) return true;
    } catch {
      /* missing stylesheet → ignore */
    }
  }
  return false;
}

export function injectShimIntoHtmlPages(dir: string, polyfillFile?: string): number {
  const shimTag = `<script src="/${SHIM_FILENAME}"></script>`;
  const polyTag = polyfillFile ? `<script src="/${polyfillFile}"></script>` : "";
  let count = 0;
  for (const file of walkHtmlFiles(dir)) {
    let html = readFileSync(file, "utf-8");
    // A light-only page needs Chrome's light rendering. `color-scheme:light` alone
    // is not enough: Safari sets the scheme but leaves the canvas transparent and
    // the DEFAULT text color light, so a page that never set its own body
    // background/color (it relied on Chrome's white default) ends up white text on a
    // transparent body over Safari's dark window — invisible, with transparent panes
    // showing through as black (live: crxviewer source pane). Chrome's UA default for
    // an extension page is white bg + black text; replicate it, but only as a FLOOR
    // (no !important) so any explicit color the page's own CSS sets still wins.
    // Theme-aware pages are detected and left untouched.
    const csTag =
      !html.includes(COLOR_SCHEME_MARKER) && !pageHandlesDarkMode(dir, file, html)
        ? `<style id="${COLOR_SCHEME_MARKER}">:root{color-scheme:light;}html,body{background-color:#fff;color:#000;}</style>`
        : "";
    // Insert only the missing tag(s) so a partial prior injection (any tag)
    // never produces duplicates. Polyfill stays before the shim.
    const missing = [polyTag, shimTag, csTag].filter((t) => t && !html.includes(t));
    if (missing.length === 0) continue;
    const toInsert = missing.join("\n    ");
    const at = headInsertIndex(html);
    if (at >= 0) {
      html = html.slice(0, at) + "\n    " + toInsert + html.slice(at);
    } else {
      html = toInsert + "\n" + html;
    }
    writeFileSync(file, html, "utf-8");
    count++;
  }
  return count;
}

/**
 * Side-panel/full-height pages wired as a Safari action popup collapse to a tiny
 * window because they carry no intrinsic size. Inject a sizing style so the popup
 * opens at usable dimensions. style-src allows 'unsafe-inline' in typical MV3 CSPs.
 */
export function injectPopupSizing(dir: string, popupFile: string, fullHeight = false): void {
  const file = join(dir, popupFile);
  let html: string;
  try {
    html = readFileSync(file, "utf-8");
  } catch {
    return;
  }
  const marker = "c2s-popup-size";
  if (html.includes(marker)) return;
  // color-scheme lets Safari paint the popup canvas in the OS theme *before* the
  // app's CSS/JS boots — without it the popover flashes light even in dark mode.
  //
  // The ONLY job here is to stop a popover collapsing to nothing when the page
  // carries no intrinsic size (empty <body> filled by JS) — NOT to dictate size.
  // An extension knows its own dimensions; overriding them with !important fixed
  // sizes makes correctly-sized popups too big/small (Urban VPN's app forced to
  // 780x600). So:
  //  - margin:0 !important — the one override worth forcing: a stray app
  //    `body{margin:auto}` (Tampermonkey) offsets the popover otherwise.
  //  - min-width/min-height as a FLOOR only, NO !important — a non-important rule
  //    that loses to any size the app's own CSS sets, so it only takes effect when
  //    the app declares nothing (the empty-at-load case). No fixed width/height,
  //    no max caps: the popover follows the content/app, Safari clamps the ceiling.
  // Floor-only; if some app still opens too small add a per-extension
  // size override, don't reintroduce a global fixed size.
  //
  // fullHeight: a SIDE-PANEL page wired as the popup (Claude's sidepanel.html).
  // Side panels lay out against the panel's full height (height:100%/100vh). In a
  // popover with no fixed height, 100% resolves to ~0 and the app collapses to a
  // sliver. Give html/body an explicit large height so the app's % layout fills.
  // Use !important on height ONLY (the collapse is the bug); width still follows
  // the app. This is gated to side-panel pages, so normal popups are untouched.
  // The min-* values are a FLOOR (no !important) to stop an empty-at-load popup
  // collapsing to nothing — NOT a target size. Keep them small: a popup WITH content
  // (e.g. CRX Viewer's two buttons, ~250px) sizes to its content and must not be
  // inflated with empty space. Too-large floors (the old 320x160) padded compact
  // popups; a modest width floor + fit-content height lets content-sized popups stay
  // tight while still rescuing a genuinely empty body. `width:fit-content` makes the
  // body shrink-wrap its content in Safari's over-wide popover so there's no slack.
  // fullHeight is the side-panel-converted-to-popup case. A Chrome side panel has a
  // defined width; as a Safari popover the app's own CSS (built for a sized side-panel
  // container) collapses to a strip, so force a standard side-panel width AND height.
  const sizeFloor = fullHeight
    ? `html,body{margin:0!important;height:600px!important;width:400px!important;min-width:400px!important;}`
    : `html,body{margin:0!important;}body{min-width:180px;width:-webkit-fit-content;width:fit-content;}`;
  // Anchor a flex `:root` to the start. uBlock makes `<html>` a flex container with
  // `justify-content:flex-end` (popup-fenix.css `:root.desktop`) and relies on Chrome
  // sizing the popover to the exact body width so flex-end never has slack to act on.
  // Safari's popover is wider than the content (our min-width floor + Safari's own
  // popover minimum), so that flex-end shoves the whole popup to the right edge.
  // `:root:root:root` (specificity 0,3,0) beats uBlock's class-qualified
  // `:root.desktop` (0,2,0) — a bare `:root!important` ties on importance but LOSES
  // the specificity tiebreak, which is why a plain `:root` override didn't take.
  const flexAnchor = `:root:root:root{justify-content:flex-start!important;align-items:flex-start!important;}`;
  const style = `<style id="${marker}">:root{color-scheme:light dark;}${sizeFloor}${flexAnchor}</style>`;
  const at = headInsertIndex(html);
  if (at >= 0) {
    html = html.slice(0, at) + "\n    " + style + html.slice(at);
  } else {
    html = style + "\n" + html;
  }
  writeFileSync(file, html, "utf-8");
}

/**
 * True when a converted service-worker bundle genuinely needs ES-module loading: it
 * uses top-level `import`/`export` statements or `import.meta`. Dynamic `import()` is
 * legal in a classic script and does NOT count. Source is usually minified, so match
 * only at source start or right after `;`/`}`/newline — keeps identifiers and string
 * contents ("important", "reportExport") from false-positiving.
 */
function swNeedsModule(src: string): boolean {
  if (/\bimport\s*\.\s*meta\b/.test(src)) return true;
  if (/(^|[;}\n])\s*import\s*["'`{*]/.test(src)) return true;
  if (/(^|[;}\n])\s*import\s+[\w$]+\s*(?:,\s*[{*]|from\b)/.test(src)) return true;
  if (/(^|[;}\n])\s*export\s*(?:default\b|[{*]|(?:const|let|var|function|class|async)\b)/.test(src)) return true;
  return false;
}

/**
 * Safari starts module service workers unreliably for temp-loaded extensions —
 * the SW often never runs, so anything probing it (e.g. the OAuth content-script
 * bridge) times out with "background not running/reachable". Convert the MV3
 * service worker into a non-persistent background page that loads the compat shim
 * first (so missing chrome.* events are backfilled before the bundle module-evals
 * and aborts) then the SW loader as a module. Mutates `manifest`. No-op when there
 * is no service_worker. Must run AFTER the OAuth bridge so the loader already
 * imports its polyfill.
 */
export function convertServiceWorkerToBackgroundPage(dir: string, manifest: Manifest, polyfillFile?: string): boolean {
  const sw = manifest.background?.service_worker;
  if (!sw) return false;

  const polyTag = polyfillFile && existsSync(join(dir, polyfillFile)) ? `<script src="${polyfillFile}"></script>\n` : "";
  // --no-shim conversions have no shim file; don't reference a missing script.
  const shimTag = existsSync(join(dir, SHIM_FILENAME)) ? `<script src="${SHIM_FILENAME}"></script>\n` : "";

  // importScripts() is undefined in a module background page, so the first call
  // throws and aborts SW evaluation BEFORE its onConnect/onMessage listeners
  // register (→ popup's runtime.connect() gets "No onConnect listeners found").
  // The default extension CSP is script-src 'self' (no eval), so a runtime
  // fetch+eval polyfill can't substitute. Instead hoist each importScripts target
  // into background.html as a classic <script> BEFORE the SW module (the imported
  // files are self-contained IIFEs that just need to run in global scope first —
  // exactly what a prior <script> tag gives), then neutralize the calls in the SW
  // so the now-undefined global is never invoked. CSP-safe and generic.
  const hoist = hoistImportScripts(dir, sw);
  const importTags = hoist.tags;

  // A dynamic-arg importScripts (webpack worker builds: importScripts(r.p+r.u(id)))
  // can't be hoisted — after neutralization the async chunks would simply never
  // load and the bundle dies mid-boot (MetaMask). Pre-register the chunks instead:
  // load every pure chunk-push file AFTER the SW module. Deferred classic scripts
  // and module scripts share one in-order execution queue, so each chunk pushes
  // through the runtime's wrapped webpackChunk.push and marks itself loaded before
  // DOMContentLoaded — by the time the SW's install handler asks for a chunk, the
  // runtime sees it registered and the neutralized importScripts is never reached.
  const chunkFiles = hoist.dynamic ? collectWebpackChunks(dir, sw, hoist.hoisted) : [];
  const chunkTags = chunkFiles.length
    ? chunkFiles.map((rel) => `<script defer src="${rel}"></script>`).join("\n") + "\n"
    : "";

  // SW-lifecycle emulation (self.serviceWorker state machine + synthetic
  // install/activate) — must be the FIRST script so the surface exists before
  // anything evaluates. See src/templates/viaduct-sw-lifecycle.js for why.
  let lifecycleTag = "";
  const lifecycleTemplate = join(TEMPLATE_DIR, SW_LIFECYCLE_FILENAME);
  if (existsSync(lifecycleTemplate)) {
    copyFileSync(lifecycleTemplate, join(dir, SW_LIFECYCLE_FILENAME));
    lifecycleTag = `<script src="${SW_LIFECYCLE_FILENAME}"></script>\n`;
  }

  // The OAuth bridge's onMessageExternal capture must install BEFORE any hoisted
  // importScripts chunk runs — SW-loader bundles register their listeners inside
  // those chunks, and the polyfill import injected into the SW module runs too
  // late (modules are deferred). Load it as a classic script first; the polyfill
  // is install-once, so the SW module's own import becomes a no-op.
  const idPolyTag = existsSync(join(dir, "identity-polyfill.js")) ? `<script src="identity-polyfill.js"></script>\n` : "";

  // manifest.name may be an unresolved "__MSG_*__" i18n key (Honey: "__MSG_Honey_Title__")
  // — resolve it from _locales first so the title isn't a raw placeholder. Then escape:
  // the name can still contain <,>,& (e.g. "Save to Notion <Beta>"), so a stray "<" /
  // "</title>" must not break out of the title and corrupt the background page's HTML.
  const resolvedName = resolveI18nString(manifest.name, dir, manifest.default_locale) ?? manifest.name;
  const title = String(resolvedName ?? "Extension")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Load the converted SW CLASSIC (not type="module") when it has no ES-module syntax
  // of its own. A classic script runs during the page's synchronous parse, so the
  // shim's action.onClicked capture AND the bundle's own listener registration are
  // complete by the time the synthetic action popup calls chrome.runtime.
  // getBackgroundPage() — a deferred module leaves getBackgroundPage with an un-run
  // background, so the click bridge finds no listeners and the toolbar button stays
  // dead. (Also avoids the module-background "silent popup failure" the README notes.)
  // Keep module only for bundles that truly need it (own import/export, import.meta)
  // or that depend on deferred webpack chunk <script> ordering.
  const swPath = join(dir, sw);
  let swSrc = existsSync(swPath) ? readFileSync(swPath, "utf-8") : "";
  // The OAuth bridge injected `import "./identity-polyfill.js";`. In an otherwise
  // classic IIFE bundle that lone import is the only module syntax, and it's redundant
  // — identity-polyfill.js already loads as a classic <script> above. Strip it so the
  // bundle can load classic; keep it (and module) when the SW has other ESM syntax.
  const swWithoutInjected = swSrc.replace(/^import\s+["'][^"']*identity-polyfill\.js["'];\s*\n?/, "");
  const useModule = chunkFiles.length > 0 || swNeedsModule(swWithoutInjected);
  if (!useModule && swSrc !== swWithoutInjected) {
    swSrc = swWithoutInjected;
    writeFileSync(swPath, swSrc, "utf-8");
  }
  const swScriptTag = useModule
    ? `<script type="module" src="${sw}"></script>`
    : `<script src="${sw}"></script>`;

  const html = `<!DOCTYPE html>
<meta charset="utf-8">
<title>${title} background</title>
${lifecycleTag}${polyTag}${shimTag}${idPolyTag}${importTags}${swScriptTag}
${chunkTags}`;
  writeFileSync(join(dir, BACKGROUND_PAGE_FILENAME), html, "utf-8");
  // MV3 (Safari) rejects persistent background: "A manifest_version >= 3 must be non-persistent."
  manifest.background = { page: BACKGROUND_PAGE_FILENAME, persistent: false };
  return true;
}

/** Synthetic-popup filenames for the action-click bridge (see wireActionClickBridge). */
const ACTION_BRIDGE_HTML = "__viaduct-action.html";
const ACTION_BRIDGE_JS = "__viaduct-action.js";

function actionSlot(manifest: Manifest): "action" | "browser_action" | "page_action" {
  if (manifest.action) return "action";
  if (manifest.browser_action) return "browser_action";
  if (manifest.page_action) return "page_action";
  return (manifest.manifest_version ?? 2) === 3 ? "action" : "browser_action";
}

// True when a background source calls (browser|page)Action.setPopup with a non-empty
// popup string — i.e. the toolbar button opens a popup wired at runtime. An empty popup
// (`setPopup({popup:""})`) disables the popup and doesn't count. Loose regex to survive
// minification: `setPopup(` … `popup:` "<non-empty>" within the same call.
function setsNonEmptyPopup(src: string): boolean {
  return /setPopup\s*\(\s*\{[^}]*\bpopup\s*:\s*(["'`])(?!\1)[^"'`]/.test(src);
}

/** Heuristic: do the manifest's background scripts register an action click handler? */
function backgroundRegistersActionOnClicked(dir: string, manifest: Manifest): boolean {
  const files: string[] = [];
  const sw = manifest.background?.service_worker;
  if (typeof sw === "string") files.push(sw);
  for (const s of manifest.background?.scripts ?? []) if (typeof s === "string") files.push(s);
  // Two passes over ALL background files, not a per-file short-circuit: viaduct prepends
  // its own shim to background.scripts, and the shim references onClicked + action without
  // any setPopup, so a per-file "onClicked here, no setPopup here → true" would fire on the
  // shim before ever reaching the bundle's own background.js where the setPopup lives.
  // A non-empty setPopup ANYWHERE means the button is popup-driven (Safari honors setPopup),
  // so the bridge must not hijack it — that wins over an onClicked registration elsewhere.
  // Empty setPopup({popup:""}) clears the popup and does not count. (TWP sets popup/popup.html.)
  let sawOnClicked = false;
  for (const rel of files) {
    const p = join(dir, rel.replace(/^\.?\//, ""));
    if (!existsSync(p)) continue;
    let src: string;
    try { src = readFileSync(p, "utf-8"); } catch { continue; }
    if (setsNonEmptyPopup(src)) return false;
    // Loose but effective on minified bundles: an onClicked registration alongside an
    // action/browserAction reference. Favors wiring a working button over a miss.
    if (/onClicked/.test(src) && /\b(?:action|browserAction)\b/.test(src)) sawOnClicked = true;
  }
  return sawOnClicked;
}

/**
 * Safari never dispatches `action.onClicked` to a converted background context, so a
 * toolbar button with no popup is inert — an extension that toggles in-page UI from
 * onClicked (a sidebar, an overlay) does nothing when clicked. Safari DOES reliably
 * open a `default_popup`, though. So when the action has no popup but the background
 * registers action.onClicked, wire a tiny synthetic popup that, on open, reaches the
 * background page via chrome.runtime.getBackgroundPage() and replays the listeners the
 * shim captured (self.__viaductOnClicked) with the active tab, then closes itself —
 * reproducing the Chrome click. Mutates `manifest`; returns true when wired. Must run
 * BEFORE convertServiceWorkerToBackgroundPage so the background scripts are still on
 * the manifest for the scan and the popup resolves the page the conversion produces.
 */
export function wireActionClickBridge(dir: string, manifest: Manifest): boolean {
  const slot = actionSlot(manifest);
  const current = manifest[slot];
  // A real popup already handles the click (and suppresses onClicked anyway).
  if (current?.default_popup) return false;
  if (!backgroundRegistersActionOnClicked(dir, manifest)) return false;

  // Transparent so the popover shows no white/colored fill. (Safari enforces a minimum
  // popover size and draws its own gray chrome, so the popover can't be hidden or shrunk
  // to nothing — this only removes the page's own background.)
  const html = `<!doctype html><html style="background:transparent"><meta charset="utf-8"><title></title><body style="margin:0;padding:0;background:transparent;color-scheme:normal"></body><script src="${ACTION_BRIDGE_JS}"></script></html>\n`;
  const js = `(function () {
  var api = (typeof browser !== "undefined" && browser && browser.runtime) ? browser : chrome;
  // Safari refuses to fire action.onClicked, so this (transparent) popover is the only
  // click signal we get. getBackgroundPage() both WAKES the suspended background and
  // returns the one canonical background page; we call __viaductFireClick on it, which
  // replays the real onClicked listeners with the active tab, in the background realm.
  // (runtime.sendMessage does NOT wake a suspended Safari background, so it can't be used
  // here.) Retry until the call lands (covers wake latency); the background dedups on the
  // id, so retries fire exactly one toggle. Safari won't let us close the popover (blur/
  // close are ignored); it dismisses on the next interaction. The hotkey path avoids it.
  var id = String(Date.now()) + ":" + Math.random().toString(36).slice(2);
  var done = false, tries = 0;
  function finish() { if (done) return; done = true; try { window.blur(); } catch (e) {} try { window.close(); } catch (e) {} }
  function hit(bg) {
    if (done || !bg || typeof bg.__viaductFireClick !== "function") return false;
    try { bg.__viaductFireClick(id); } catch (e) {}
    finish();
    return true;
  }
  (function poke() {
    tries++;
    try {
      var r = api.runtime.getBackgroundPage(function (bg) { var _ = api.runtime && api.runtime.lastError; hit(bg); });
      if (r && typeof r.then === "function") r.then(hit, function () {});
    } catch (e) {}
    if (!done && tries < 80) setTimeout(poke, 100);
    else if (!done) finish();
  })();
  setTimeout(finish, 10000);
})();
`;
  writeFileSync(join(dir, ACTION_BRIDGE_HTML), html, "utf-8");
  writeFileSync(join(dir, ACTION_BRIDGE_JS), js, "utf-8");
  manifest[slot] = { ...(current ?? {}), default_popup: ACTION_BRIDGE_HTML };
  return true;
}

/**
 * Extract the message literal the background's onClicked handler sends to the tab via
 * tabs.sendMessage. That message (e.g. {type:"TOGGLE_SHELL"}) is what actually toggles
 * the in-page UI, so an in-page hotkey can replay it to the content-script listeners the
 * shim captured — no toolbar, no popover. Returns the literal source or null when it
 * can't be determined statically (dynamic message, nested braces, no match).
 */
function extractActionMessage(dir: string, manifest: Manifest): string | null {
  const files: string[] = [];
  const sw = manifest.background?.service_worker;
  if (typeof sw === "string") files.push(sw);
  for (const s of manifest.background?.scripts ?? []) if (typeof s === "string") files.push(s);
  for (const rel of files) {
    const p = join(dir, rel.replace(/^\.?\//, ""));
    if (!existsSync(p)) continue;
    let src: string;
    try { src = readFileSync(p, "utf-8"); } catch { continue; }
    const idx = src.search(/onClicked/);
    if (idx < 0) continue;
    // Within a window after the onClicked registration, find tabs.sendMessage(tab, {..}).
    const win = src.slice(idx, idx + 600);
    const m = win.match(/sendMessage\s*\(\s*[^,]+,\s*(\{[^{}]*\})/);
    if (m && m[1]) return m[1];
  }
  return null;
}

interface HotkeyCombo { meta: boolean; ctrl: boolean; shift: boolean; alt: boolean; key: string; }

// WebExtensions command key tokens whose DOM KeyboardEvent.key differs from the token
// (all compared lowercased against `e.key` in the generated hotkey script). The arrow
// keys are the trap: token "Up" → e.key "ArrowUp", so a bare lowercase "up" never
// matches and the hotkey silently never fires. Anything not here and longer than one
// char is a token we can't reliably map to an e.key, so parseCombo bails (→ the caller
// uses its Ctrl+Shift+Y default rather than wiring a dead shortcut).
const COMMAND_KEY_TO_DOM: Record<string, string> = {
  up: "arrowup", down: "arrowdown", left: "arrowleft", right: "arrowright",
  space: " ", comma: ",", period: ".",
  pageup: "pageup", pagedown: "pagedown", home: "home", end: "end",
  insert: "insert", delete: "delete", tab: "tab",
};

/** Parse a WebExtensions command key ("Command+Shift+S", "Ctrl+Shift+Y") into a combo.
 *  Returns null when the key token can't be mapped to a DOM KeyboardEvent.key, so the
 *  caller falls back to a working default instead of wiring a hotkey that never fires. */
function parseCombo(key: unknown): HotkeyCombo | null {
  if (typeof key !== "string" || !key) return null;
  const combo: HotkeyCombo = { meta: false, ctrl: false, shift: false, alt: false, key: "" };
  let unmappable = false;
  for (const part of key.split("+").map((s) => s.trim().toLowerCase())) {
    if (part === "command" || part === "cmd") combo.meta = true;
    else if (part === "ctrl" || part === "control" || part === "macctrl") combo.ctrl = true;
    else if (part === "shift") combo.shift = true;
    else if (part === "alt" || part === "option") combo.alt = true;
    else if (part) {
      const named = part.replace(/^key/, "");
      if (named.length === 1) combo.key = named;
      else if (COMMAND_KEY_TO_DOM[named]) combo.key = COMMAND_KEY_TO_DOM[named];
      else unmappable = true; // a named key we can't match against e.key → bail
    }
  }
  return combo.key && !unmappable ? combo : null;
}

/**
 * Safari's only popover-free way to trigger an in-page toggle: a page-level keydown. The
 * shim captures the content script's runtime.onMessage listeners; this wires a generated
 * content script that, on a shortcut, replays the action message (from extractActionMessage)
 * to them — reproducing the onClicked toggle with NO toolbar popover. Reuses a declared
 * command's shortcut when present (Safari never fires commands.onCommand, so that key is
 * otherwise dead) and removes that now-inert command. Returns the human shortcut label, or
 * null when it can't be wired (no message, no content scripts). Must run BEFORE the SW→page
 * conversion so the background scripts are still on the manifest for the scan.
 */
export function wireActionHotkey(dir: string, manifest: Manifest): string | null {
  if (!backgroundRegistersActionOnClicked(dir, manifest)) return null;
  if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length === 0) return null;
  const msg = extractActionMessage(dir, manifest);
  if (!msg) return null;

  // Pick the shortcut. Prefer the extension's own action command so the binding matches
  // what users expect: `_execute_action` (the standard "activate the action" command), or
  // a lone declared command (unambiguously the action for a single-purpose toggle). Reusing
  // its key is safe because Safari never fires commands.onCommand — the key is otherwise
  // dead — and we remove that now-inert command so Safari doesn't reserve the combo. With
  // several ambiguous commands, don't guess: use a viaduct default and leave commands alone.
  const commands = (manifest.commands ?? {}) as Record<string, { suggested_key?: unknown }>;
  const keyOf = (name: string): string | undefined => {
    const sk = commands[name]?.suggested_key as string | { mac?: string; default?: string } | undefined;
    return typeof sk === "string" ? sk : sk?.mac || sk?.default;
  };
  const names = Object.keys(commands);
  const preferred = names.includes("_execute_action") ? "_execute_action" : names.length === 1 ? names[0] : null;
  let combo: HotkeyCombo | null = preferred ? parseCombo(keyOf(preferred)) : null;
  let label = "";
  let usedCmd: string | null = null;
  if (combo && preferred) { label = String(keyOf(preferred)); usedCmd = preferred; }
  if (!combo) { combo = { meta: false, ctrl: true, shift: true, alt: false, key: "y" }; label = "Ctrl+Shift+Y"; }
  if (usedCmd) {
    delete commands[usedCmd];
    if (Object.keys(commands).length === 0) delete manifest.commands;
    else manifest.commands = commands;
  }

  const js = `(function () {
  if (typeof window === "undefined" || self.__viaductHotkeyBound) return;
  self.__viaductHotkeyBound = true;
  var COMBO = ${JSON.stringify(combo)};
  // Safari never fires action.onClicked/commands.onCommand for a converted extension, and
  // always shows an un-closable popover for a toolbar popup. This page-level keydown is the
  // popover-free path: replay the action's own message to the runtime.onMessage listeners
  // the compat shim captured (self.__viaductMsgListeners), reproducing the onClicked toggle.
  window.addEventListener("keydown", function (e) {
    if (!!COMBO.meta !== !!e.metaKey || !!COMBO.ctrl !== !!e.ctrlKey || !!COMBO.shift !== !!e.shiftKey || !!COMBO.alt !== !!e.altKey) return;
    if (String(e.key || "").toLowerCase() !== COMBO.key) return;
    try { e.preventDefault(); } catch (e0) {}
    var api = (typeof browser !== "undefined" && browser && browser.runtime) ? browser : chrome;
    var sender = { id: api && api.runtime && api.runtime.id, url: location.href, tab: { id: 0, url: location.href } };
    var list = self.__viaductMsgListeners || [];
    for (var i = 0; i < list.length; i++) { try { list[i](${msg}, sender, function () {}); } catch (e2) {} }
  }, true);
})();
`;
  writeFileSync(join(dir, ACTION_HOTKEY_FILENAME), js, "utf-8");
  for (const cs of manifest.content_scripts) {
    if (Array.isArray(cs.js) && (cs as { world?: string }).world !== "MAIN" && !cs.js.includes(ACTION_HOTKEY_FILENAME)) {
      cs.js.push(ACTION_HOTKEY_FILENAME);
    }
  }
  return label;
}

// A content script staging a page-world <script>: `<el>.src = <ns>.runtime.getURL("x.js")`.
// The captured group is the resource path. Chrome exempts web-accessible-resource scripts
// from the page's CSP; Safari does NOT, so `<script src="safari-web-extension://…">` is
// refused by a strict page CSP (e.g. YouTube's script-src) and the page-world code never
// runs — the extension's MAIN-world logic silently dies (live report: Jump Cutter's
// MediaSource-clone bridge → no audio analysis → playback stuck at silence speed).
const PAGE_WORLD_INJECT_RE =
  /\.src\s*=\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.runtime\.getURL\(\s*(["'])([^"'`]+\.m?js)\1\s*\)/g;

/**
 * Re-declare every page-world script a content script injects via
 * `<script src=runtime.getURL(X)>` as a `world:"MAIN"` content script. Safari runs
 * MAIN-world content scripts with extension privilege — CSP-exempt — reproducing the
 * Chrome behavior where web-accessible-resource scripts bypass the page CSP. This is the
 * generic fix for "extension works in Chrome, its page-world script is CSP-blocked in
 * Safari"; the injected targets are read straight from the bundled source, nothing is
 * extension-specific.
 *
 * Scans ALL bundled scripts, not just declared content_scripts, because the injecting
 * script is often registered dynamically from background code (chrome.scripting.
 * registerContentScripts) rather than declared in the manifest.
 *
 * world:"MAIN" needs Safari 18.4+. On older Safari the entry is ignored (or run in the
 * isolated world, where proxying the isolated globals is a harmless no-op) — the page-world
 * code stays dead exactly as it is today, so there is no regression. The extension's own
 * (now redundant) `<script>` injection is left in place: it still fails the page CSP
 * harmlessly while the MAIN-world content script does the real work. Returns the wired
 * resource paths.
 */
/**
 * Give chrome.userScripts a way to actually reach the page.
 *
 * Safari delivers no navigation events to a converted background page (neither
 * tabs.onUpdated nor webNavigation.onCommitted, verified live), so the shim's
 * userScripts registry has no way to inject on its own. A DECLARED content script does
 * run, so wire one that reports its URL to the background and evaluates whatever the
 * registry says matches. It runs in the isolated world, where chrome.runtime is
 * available for a manager's own bridge.
 *
 * Only wired when the extension declares the userScripts permission, so nothing else
 * gains a content script it never asked for. Call BEFORE transformManifest, which
 * strips that permission for Safari. Returns the filename, or null when not applicable.
 */
export function wireUserScriptsContentScript(
  dir: string,
  manifest: Manifest,
  original: Manifest = manifest,
): string | null {
  const perms = [
    ...(Array.isArray(original.permissions) ? original.permissions : []),
    ...(Array.isArray(original.optional_permissions) ? original.optional_permissions : []),
  ];
  if (!perms.includes("userScripts")) return null;

  const js = `// Injected by viaduct: runs the scripts registered through chrome.userScripts.
// Safari fires no navigation event the background could inject from, so the page asks.
(function () {
  if (window.__viaductUserScriptsRan) return;
  window.__viaductUserScriptsRan = true;
  function exec(s) {
    try { (0, eval)(s.code); }
    catch (e) { try { console.error("[viaduct] user script " + s.id + " failed:", e); } catch (e2) {} }
  }
  function run(list) {
    if (!list || !list.length) return;
    var later = [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || !s.code) continue;
      if (s.runAt === "document_start" || document.readyState !== "loading") exec(s);
      else later.push(s);
    }
    if (later.length) {
      document.addEventListener("DOMContentLoaded", function () {
        for (var j = 0; j < later.length; j++) exec(later[j]);
      });
    }
  }
  // Logged from the page's own console, which is the only place an isolated-world
  // content script is observable from outside. Reading a flag off window does not work:
  // the page console evaluates in the page world and never sees this one.
  function log(msg) { try { console.log("[viaduct:userScripts] " + msg); } catch (e) {} }
  // The background is non-persistent and this runs at document_start, so the registry
  // is often not populated yet: the extension re-registers its scripts while its
  // background is still booting. A context holding no scripts stays silent rather than
  // answering empty, so silence means "ask again shortly", not "nothing to run".
  var attempts = 0;
  var MAX_ATTEMPTS = 12;
  var RETRY_MS = 250;
  function requestScripts() {
    attempts++;
    var retry = function (why) {
      if (attempts < MAX_ATTEMPTS) { setTimeout(requestScripts, RETRY_MS); return; }
      log("gave up after " + attempts + " attempts: " + why);
    };
    try {
      chrome.runtime.sendMessage(
        { __viaductUserScripts: { url: location.href, top: window.top === window } },
        function (resp) {
          try {
            if (chrome.runtime.lastError) return retry("no listener (" + chrome.runtime.lastError.message + ")");
          } catch (e) {}
          // A reply without our shape came from someone else's onMessage handler.
          if (!resp || !resp.scripts) return retry("answered by another listener: " + JSON.stringify(resp));
          log("received " + resp.scripts.length + " script(s) after " + attempts + " attempt(s)");
          run(resp.scripts);
        }
      );
    } catch (e) { retry("send failed: " + ((e && e.message) || e)); }
  }
  log("injector running on " + location.href);
  requestScripts();
})();
`;
  writeFileSync(join(dir, USERSCRIPTS_CS_FILENAME), js, "utf-8");

  if (!Array.isArray(manifest.content_scripts)) manifest.content_scripts = [];
  const already = manifest.content_scripts.some(
    (cs) => Array.isArray(cs.js) && cs.js.includes(USERSCRIPTS_CS_FILENAME),
  );
  if (!already) {
    manifest.content_scripts.push({
      matches: ["<all_urls>"],
      js: [USERSCRIPTS_CS_FILENAME],
      run_at: "document_start",
      all_frames: true,
    });
  }
  return USERSCRIPTS_CS_FILENAME;
}

export function wirePageWorldMainInjection(dir: string, manifest: Manifest): string[] {
  if (!Array.isArray(manifest.content_scripts)) manifest.content_scripts = [];
  // Never scan or re-wire viaduct's own injected files.
  const ownFiles: Record<string, true> = {
    [SHIM_FILENAME]: true,
    [POLYFILL_FILENAME]: true,
    [POLYFILL_ALT_FILENAME]: true,
    [SW_LIFECYCLE_FILENAME]: true,
    [ACTION_HOTKEY_FILENAME]: true,
    [USERSCRIPTS_CS_FILENAME]: true,
  };
  const targets = new Set<string>();
  for (const file of walkScripts(dir)) {
    if (ownFiles[basename(file)]) continue;
    let src: string;
    try { src = readFileSync(file, "utf-8"); } catch { continue; }
    if (src.indexOf(".getURL") === -1) continue;
    PAGE_WORLD_INJECT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PAGE_WORLD_INJECT_RE.exec(src)) !== null) {
      targets.add(m[2].replace(/^\.?\/+/, ""));
    }
  }
  if (targets.size === 0) return [];

  // Mirror the extension's own content-script reach (match patterns + frame options) so
  // the MAIN-world twin runs exactly where the isolated injector would — never broader.
  const csMatches = new Set<string>();
  let allFrames = false;
  let matchAboutBlank = false;
  for (const cs of manifest.content_scripts) {
    if (cs.world === "MAIN") continue;
    for (const mt of cs.matches ?? []) csMatches.add(mt);
    if (cs.all_frames) allFrames = true;
    if (cs.match_about_blank) matchAboutBlank = true;
  }
  const matches = csMatches.size > 0 ? [...csMatches] : ["<all_urls>"];

  const wired: string[] = [];
  for (const target of targets) {
    if (ownFiles[basename(target)]) continue;
    // Must be a real file we can run as a content script.
    if (!existsSync(join(dir, target))) continue;
    // Idempotent: skip if already a MAIN-world entry (re-convert, or the OAuth
    // page-bridge which registers its own MAIN-world script).
    const already = manifest.content_scripts.some(
      (cs) => cs.world === "MAIN" && Array.isArray(cs.js) && cs.js.includes(target),
    );
    if (already) continue;
    manifest.content_scripts.push({
      matches,
      js: [target],
      run_at: "document_start",
      all_frames: allFrames || undefined,
      match_about_blank: matchAboutBlank || undefined,
      world: "MAIN",
    });
    wired.push(target);
  }
  return wired;
}

/**
 * Find importScripts("a.js", "b.js") calls in the SW bundle, resolve each path
 * relative to the SW file, and return <script src="..."> tags for the ones that
 * exist on disk (root-relative so they resolve from background.html). The calls
 * themselves are replaced in the SW source with a void 0 no-op so the undefined
 * worker global is never invoked. Paths are resolved against the SW's directory;
 * the emitted src is relative to the extension root (where background.html lives).
 * Returns "" when there are no resolvable importScripts calls.
 */
/**
 * Lexing walk shared by matchBalancedParen and pushArrayElementCount so the two
 * can never disagree about what is code. Invokes onCode(c, i) for every character
 * outside string/template/comment/regex content. Template literals get full
 * `${…}` handling: interpolations re-enter code mode, nested templates included —
 * the old "skip to the next backtick" approach turned everything after an inner
 * template into mislexed noise (MetaMask's 1MB chunk 6078 nests templates two
 * deep and was wrongly rejected by the chunk collector because of it).
 * Returns the index where onCode returned true, else -1 (end of input reached,
 * or an unterminated construct).
 */
function walkCode(src: string, start: number, onCode: (c: string, i: number) => boolean): number {
  // Context stack: "T" = inside template-literal text; a number = inside a `${}`
  // interpolation, holding its open-brace count so the matching "}" hands control
  // back to the surrounding template text instead of being reported as code.
  const stack: Array<"T" | number> = [];
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    const top = stack.length ? stack[stack.length - 1] : undefined;
    if (top === "T") {
      if (c === "\\") { i++; continue; }
      if (c === "`") { stack.pop(); continue; }
      if (c === "$" && src[i + 1] === "{") { stack.push(0); i++; continue; }
      continue;
    }
    if (c === "`") { stack.push("T"); continue; }
    if (typeof top === "number") {
      if (c === "}") {
        if (top === 0) { stack.pop(); continue; } // closes the ${ — resume template text
        stack[stack.length - 1] = top - 1;
      } else if (c === "{") {
        stack[stack.length - 1] = top + 1;
      }
    }
    if (c === '"' || c === "'") {
      // skip the string literal
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === c) break;
        i++;
      }
      continue;
    }
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      // Always a comment: a regex literal's first body char can never be `/` or `*`
      // (RegularExpressionFirstChar excludes both — even /[/*]/ starts with `[`), so
      // `//` and `/*` are unconditionally comments regardless of expression position.
      if (src[i + 1] === "/") {
        const nl = src.indexOf("\n", i);
        if (nl < 0) return -1;
        i = nl;
      } else {
        const close = src.indexOf("*/", i + 2);
        if (close < 0) return -1;
        i = close + 1;
      }
      continue;
    }
    if (c === "/" && startsRegexAt(src, i, start)) {
      // A regex literal whose body doesn't start with `/`/`*` (e.g. /\//, /a-z/).
      i = skipRegex(src, i);
      if (i < 0) return -1;
      continue;
    }
    if (onCode(c, i)) return i;
  }
  return -1;
}

/**
 * Given the index of an opening "(" in `src`, return the index just PAST its
 * matching ")", honoring nested parens and skipping string/template/comment/regex
 * content (see walkCode). Returns -1 if no balanced close is found. A ")" inside
 * a template interpolation still counts — interpolations are code.
 */
export function matchBalancedParen(src: string, open: number): number {
  let depth = 0;
  const at = walkCode(src, open, (c) => {
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return true;
    }
    return false;
  });
  return at < 0 ? -1 : at + 1;
}

// Keywords a regex literal can directly follow (`return/,/.test(x)` is how terser
// emits it). An identifier ending just before the `/` that ISN'T one of these means
// division (`n / 2`).
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw",
  "case", "do", "else", "yield", "await",
]);

// Does the `/` at src[slashIdx] begin a regex literal (vs division)? Looks back at
// the previous significant char: operators/openers/commas can't end a value, so a
// regex follows; an identifier char means division UNLESS the whole word is a
// keyword like `return`. Conservative: when unsure, treats `/` as division.
function startsRegexAt(src: string, slashIdx: number, floor: number): boolean {
  let j = slashIdx - 1;
  while (j >= floor && (src[j] === " " || src[j] === "\t" || src[j] === "\n" || src[j] === "\r")) j--;
  if (j < floor) return true; // expression start
  const c = src[j];
  if ("(,=:[!&|?{};+-*%^~<>".indexOf(c) >= 0) return true;
  if (/[A-Za-z0-9_$]/.test(c)) {
    let k = j;
    while (k >= floor && /[A-Za-z0-9_$]/.test(src[k])) k--;
    // A word matching a keyword is only the keyword when it's NOT a member name:
    // `o.return / 2` is division (property `return`), not `return /regex/`. Look
    // past whitespace before the word — a `.` (dot or `?.`) means member access.
    let d = k;
    while (d >= floor && (src[d] === " " || src[d] === "\t" || src[d] === "\n" || src[d] === "\r")) d--;
    if (src[d] === ".") return false;
    return REGEX_PRECEDING_KEYWORDS.has(src.slice(k + 1, j + 1));
  }
  return false;
}

// Given index `start` at the opening `/` of a regex literal, return the index of its
// closing `/`, honoring `\` escapes and `[...]` character classes (where `/` is not a
// delimiter). Returns -1 if unterminated.
function skipRegex(src: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) return i;
    else if (ch === "\n") return -1;
  }
  return -1;
}

interface HoistResult {
  /** <script> tags for the resolved string-literal targets, "" when none. */
  tags: string;
  /** Root-relative paths of the hoisted files (so chunk collection can skip them). */
  hoisted: Set<string>;
  /** True when at least one call had a non-literal argument — those targets are
   *  unknowable at staging time, so the caller pre-registers webpack chunks. */
  dynamic: boolean;
}

function hoistImportScripts(dir: string, swPath: string): HoistResult {
  const none: HoistResult = { tags: "", hoisted: new Set(), dynamic: false };
  const swFile = join(dir, swPath);
  if (!existsSync(swFile)) return none;

  // Hoisted files can THEMSELVES call importScripts (a lib pulled in by the SW
  // pulling in its own dep), so neutralize + hoist depth-first: a file's targets
  // are tagged before the file, matching "the import has run by the time the
  // importer's later code executes". Per spec, importScripts resolves every URL
  // against the worker's own location — i.e. the SW's dir — not the importing
  // file's dir, so one resolve base serves the whole tree. `seen` doubles as the
  // cycle guard. Neutralizing EVERY call in every hoisted file also means no page
  // ever needs a runtime importScripts stub — defining one would break the
  // standard `typeof importScripts === "function"` worker-detection idiom
  // (crxviewer's Prism glue clobbers its own page-loaded Prism when that check
  // lies).
  const swDir = dirname(swPath); // e.g. "service-worker"
  const tags: string[] = [];
  const seen = new Set<string>();
  let dynamic = false;

  const hoistFile = (rootRel: string): void => {
    const res = neutralizeImportScripts(dir, rootRel, swDir);
    if (res.dynamic) dynamic = true;
    for (const target of res.targets) {
      if (seen.has(target)) continue;
      seen.add(target);
      hoistFile(target);
      tags.push(`<script src="${target}"></script>`);
    }
  };
  hoistFile(swPath);

  return { tags: tags.length ? tags.join("\n") + "\n" : "", hoisted: seen, dynamic };
}

/**
 * Replace every importScripts(...) call in ONE file with a void-0 no-op and
 * return the resolvable string-literal targets (root-relative, existing on disk)
 * plus whether any call had a runtime-computed argument.
 */
function neutralizeImportScripts(dir: string, rootRel: string, resolveDir: string): { targets: string[]; dynamic: boolean } {
  const filePath = join(dir, rootRel);
  let src: string;
  try {
    src = readFileSync(filePath, "utf-8");
  } catch {
    return { targets: [], dynamic: false };
  }
  if (!/\bimportScripts\s*\(/.test(src)) return { targets: [], dynamic: false };

  const targets: string[] = [];
  let dynamic = false;
  // Find each importScripts( ... ) call and its argument list. A regex with
  // [^)]* truncates at the FIRST ")", which is wrong when an argument itself
  // contains parens — e.g. webpack's `importScripts(o.p+o.u(t))`. That left the
  // outer ")" dangling after the no-op replacement and broke the bundle with a
  // SyntaxError. Scan for the balanced closing paren instead (string-literal and
  // comment aware), so the WHOLE call is replaced regardless of nesting.
  // Also consume an optional `<receiver>.` prefix so the whole member-call
  // `self.importScripts(...)` — the idiomatic Workbox / TS-WebWorker form — is
  // replaced as one span. Matching only `importScripts(` (\b sits between the "."
  // and "i") would leave the receiver behind and emit the syntax error
  // `self.void 0`, breaking the entire background module. The receiver isn't just
  // the well-known globals: bundlers alias them (`var g=self; g.importScripts(…)`),
  // so consume ANY member chain ending in `.importScripts(` — a leading identifier
  // plus zero+ `.name` / `?.name` / `[...]` steps. A bare `importScripts(` (no
  // receiver) still matches via the leading `\b`.
  const callOpenRe = /(?:[A-Za-z_$][\w$]*(?:\s*(?:\?\.\s*[\w$]+|\.\s*[\w$]+|\[[^\]]*\]))*\s*(?:\?\.|\.)\s*)?\bimportScripts\s*\(/g;
  let neutralized = 0;
  let out = "";
  let last = 0;
  let mm: RegExpExecArray | null;
  while ((mm = callOpenRe.exec(src))) {
    const openParen = mm.index + mm[0].length - 1; // index of the "(" itself
    const end = matchBalancedParen(src, openParen); // index just past the ")"
    if (end < 0) continue; // unbalanced (shouldn't happen in valid JS) → leave as-is
    const argList = src.slice(openParen + 1, end - 1);
    // Anything left after stripping STATIC literals and separators means an
    // argument is computed at runtime (`o.p+o.u(t)`, a variable, an interpolated
    // template) — the target can't be hoisted here. Strip "…"/'…' and only
    // interpolation-free templates: a `${…}` template must NOT be stripped or its
    // runtime value would masquerade as a static string and go undetected — the
    // remaining `${…}` keeps the residue non-empty, correctly marking it dynamic.
    const stripStatics = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`$\\]|\$(?!\{))*`/g;
    // Strip comments too before the emptiness test: `importScripts("a.js" /*x*/, "b.js")`
    // is fully static, but a leftover comment would read as residue and wrongly flip the
    // call to dynamic (→ needless webpack-chunk collection + module-mode background).
    // Statics first, then comments — a comment token inside a string literal is already
    // gone, so this can't strip a `//`/`/*` that was actually part of a path literal.
    const stripComments = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
    if (argList.replace(stripStatics, "").replace(stripComments, "").replace(/[\s,]/g, "") !== "") dynamic = true;
    // Extract string OR interpolation-free template targets (`a.js`). A backtick
    // with `${}` stays dynamic above, so only static templates reach here as
    // hoistable literals (the `$(?!\{)` lets a literal `$` in a filename through).
    const argRe = /"([^"]+)"|'([^']+)'|`((?:[^`$\\]|\$(?!\{))+)`/g;
    let m: RegExpExecArray | null;
    while ((m = argRe.exec(argList))) {
      const literal = m[1] ?? m[2] ?? m[3]; // "…" | '…' | `…`
      // Resolve relative to the worker's dir → a path from the extension root.
      const fromRoot = join(resolveDir, literal).split("\\").join("/");
      // Unresolved → skip the tag; the no-op replacement still applies.
      if (existsSync(join(dir, fromRoot))) targets.push(fromRoot);
    }
    out += src.slice(last, mm.index) + "void 0 /* importScripts hoisted to background.html */";
    last = end;
    neutralized++;
    callOpenRe.lastIndex = end; // continue scanning after the full call
  }
  out += src.slice(last);

  // Write whenever ANY call was neutralized — even an unresolved target must be
  // de-fanged (it would throw on the undefined global), not just hoisted ones.
  if (neutralized > 0) writeFileSync(filePath, out, "utf-8");
  return { targets, dynamic };
}

// A pure webpack async chunk is a single statement:
//   (globalThis.webpackChunkNAME = globalThis.webpackChunkNAME || []).push([[ids], {modules}]);
// optionally preceded by a license banner / "use strict" and followed only by a
// sourcemap pragma. Anything else before/after is real top-level code — that's an
// entry script, not a registration, and must not be loaded into the background page.
const CHUNK_PREFIX_RE = /^(?:\uFEFF|\s|;|["']use strict["'];?|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*$/;
const CHUNK_SUFFIX_RE = /^(?:\s|;|\/\/[#@][^\n]*(?:\n|$)|\/\*[#@][\s\S]*?\*\/)*$/;

/**
 * Find every webpack async chunk belonging to the SW's bundle: the SW declares a
 * `webpackChunk*` loading global, and each chunk file starts with a push into that
 * SAME global (different bundles in the extension use different globals or none).
 * Only 2-element pushes ([chunkIds, modules]) qualify — a 3rd element is webpack's
 * runtime/startup callback, which the wrapped push EXECUTES, so loading such a
 * file would boot a foreign entry point inside the background page. Registration
 * pushes only define modules; nothing runs until the SW require()s them.
 * Returns root-relative paths, sorted for a deterministic background.html.
 */
function collectWebpackChunks(dir: string, swPath: string, hoisted: Set<string>): string[] {
  let swSrc: string;
  try {
    swSrc = readFileSync(join(dir, swPath), "utf-8");
  } catch {
    return [];
  }
  // The chunk-loading global, dot or bracket form: globalThis.webpackChunkfoo = ...
  const gm = /(?:globalThis|self|window)\s*(?:\.\s*(webpackChunk[$\w]*)|\[\s*["'](webpackChunk[^"'\\]*)["']\s*\])\s*=(?!=)/.exec(swSrc);
  const name = gm && (gm[1] || gm[2]);
  if (!name) return [];
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ref = `(?:globalThis|self|window)\\s*(?:\\.\\s*${esc}|\\[\\s*["']${esc}["']\\s*\\])`;
  const pushRe = new RegExp(`\\(\\s*${ref}\\s*=\\s*${ref}\\s*\\|\\|\\s*\\[\\s*\\]\\s*\\)\\s*\\.push\\s*\\(`);

  const chunks: string[] = [];
  for (const abs of walkScripts(dir)) {
    const rel = relative(dir, abs).split("\\").join("/");
    if (rel === swPath || hoisted.has(rel)) continue;
    let src: string;
    try {
      src = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    // Scan the whole file, not a fixed head window: a chunk push is a single
    // top-level statement, but a third-party-license banner can run to many KB and
    // shove it well past any fixed offset (LicenseWebpackPlugin headers routinely
    // exceed 4KB), so a windowed search silently drops the chunk. The push must
    // still be the FIRST real statement — CHUNK_PREFIX_RE below rejects a match
    // with any real code before it, so a mid-file coincidental push never qualifies.
    const m = pushRe.exec(src);
    if (!m || !CHUNK_PREFIX_RE.test(src.slice(0, m.index))) continue;
    const open = m.index + m[0].length - 1; // the push's "("
    const end = matchBalancedParen(src, open);
    if (end < 0) continue;
    if (pushArrayElementCount(src.slice(open + 1, end - 1)) !== 2) continue;
    if (!CHUNK_SUFFIX_RE.test(src.slice(end))) continue;
    chunks.push(rel);
  }
  return chunks.sort();
}

/**
 * Given the text between push( and ), verify it is a single array literal and
 * count its top-level elements. Shares walkCode's lexing with matchBalancedParen,
 * tracking all bracket kinds so a comma only counts at the array's own level.
 * Returns -1 when the text isn't one bare array literal.
 */
export function pushArrayElementCount(s: string): number {
  let start = 0;
  while (start < s.length && /\s/.test(s[start])) start++;
  if (s[start] !== "[") return -1;
  let depth = 0;
  let count = 1;
  const at = walkCode(s, start, (c) => {
    if (c === "[" || c === "(" || c === "{") depth++;
    else if (c === "]" || c === ")" || c === "}") {
      depth--;
      if (depth === 0) return true; // closed the outer array
    } else if (c === "," && depth === 1) count++;
    return false;
  });
  if (at < 0) return -1;
  // Only trailing whitespace may follow the outer array.
  for (let j = at + 1; j < s.length; j++) if (!/\s/.test(s[j])) return -1;
  return count;
}
