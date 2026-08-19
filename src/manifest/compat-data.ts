import type { Issue } from "../types.js";

// Compatibility data tables — pure data, no logic. Which Chrome permissions/APIs
// Safari lacks, which the shim emulates, and the per-API remediation notes the
// analyzer surfaces. Split out of manifest.ts to keep that file focused on
// parsing + transform logic.

/** Permissions Safari does not implement. Value = remediation note. */
export const UNSUPPORTED_PERMISSIONS: Record<string, string> = {
  identity: "Safari lacks chrome.identity; use a hosted web OAuth2 flow + window.postMessage.",
  debugger: "chrome.debugger (Chrome DevTools Protocol) is emulated by the viaduct CDP shim (attach/detach/sendCommand/getTargets plus a Page/Target/Input/DOM/Runtime/Accessibility subset over Safari tabs + scripting). Network/Fetch domains and OS-trusted input are not available.",
  sidePanel: "Safari has no native sidePanel API; the shim emulates it (open via the action popover on Safari 17.4+, tab fallback on older; setOptions/getOptions/setPanelBehavior).",
  tabGroups: "Safari has no native tabGroups API; the shim emulates it in memory (no tab-bar coloring).",
  offscreen: "Safari has no offscreen documents API; the shim emulates it via an extension-origin iframe (createDocument/close/hasDocument/getContexts) so SW→offscreen messaging keeps working. The offscreen doc still has no DOM in a true SW context.",
  webRequestBlocking: "Blocking webRequest is unsupported; use declarativeNetRequest.",
  webRequestAuthProvider: "Safari can't provide credentials for onAuthRequired (proxy/HTTP auth) via webRequest; the listener still fires read-only, but handle auth in-page or natively.",
  declarativeNetRequestWithHostAccess: "Safari doesn't recognize this DNR variant token; declare plain declarativeNetRequest (rules still apply on hosts the extension already has access to).",
  gcm: "chrome.gcm is Chrome-only; relay via APNs in the host app or poll with chrome.alarms.",
  tts: "Permission dropped, but the shim routes chrome.tts to the Web Speech API (speechSynthesis), so speak/stop/pause keep working.",
  ttsEngine: "TTS engine API unavailable.",
  platformKeys: "platformKeys unavailable.",
  "enterprise.platformKeys": "enterprise.platformKeys unavailable.",
  // OS-capability APIs — route through the native container app or drop.
  tabCapture: "tabCapture is unsupported; use getDisplayMedia() or a native bridge.",
  desktopCapture: "desktopCapture is unsupported; use getDisplayMedia() or a native bridge.",
  pageCapture: "pageCapture is unsupported; drop or reimplement via a native bridge.",
  proxy: "chrome.proxy has no Safari equivalent; drop or configure proxy natively.",
  privacy: "chrome.privacy has no Safari equivalent; drop.",
  contentSettings: "chrome.contentSettings has no Safari equivalent; drop.",
  browsingData: "chrome.browsingData has no Safari equivalent; drop.",
  management: "chrome.management has no Safari equivalent; drop or move to the native host app.",
  power: "Permission dropped, but the shim backs chrome.power.requestKeepAwake with the Screen Wake Lock API (navigator.wakeLock).",
  "system.cpu": "chrome.system.cpu has no Safari equivalent; native bridge or drop.",
  "system.memory": "chrome.system.memory has no Safari equivalent; native bridge or drop.",
  "system.storage": "chrome.system.storage has no Safari equivalent; native bridge or drop.",
  "system.display": "chrome.system.display has no Safari equivalent; native bridge or drop.",
  // Chrome-UI APIs — no Safari surface; reshape to popup/page or drop.
  omnibox: "Safari has no address-bar keyword API; drop the omnibox feature.",
  sessions: "chrome.sessions is unsupported; shim returns empty results.",
  topSites: "chrome.topSites is unsupported; shim returns an empty list.",
  search: "chrome.search is unsupported; shim opens queries in a search-engine tab.",
  declarativeContent: "declarativeContent rules never fire in Safari; use content scripts + chrome.action.",
  userScripts: "The shim emulates chrome.userScripts registration (register/update/getScripts/unregister); dynamic injection of new scripts at runtime is not supported, so declare content scripts statically or use chrome.scripting where injection must actually run.",
  idle: "chrome.idle is unsupported; shim derives state from page visibility.",
  instanceID: "instanceID push plumbing is Chrome-only; use APNs natively or poll.",
  // ChromeOS-only APIs — always drop on Safari.
  fileBrowserHandler: "fileBrowserHandler is ChromeOS-only; drop.",
  fileSystemProvider: "fileSystemProvider is ChromeOS-only; drop.",
  documentScan: "documentScan is ChromeOS-only; drop.",
  printerProvider: "printerProvider is ChromeOS/print-only; drop or move to a native bridge.",
  printing: "chrome.printing is ChromeOS-only; drop.",
  printingMetrics: "chrome.printingMetrics is ChromeOS-only; drop.",
  certificateProvider: "certificateProvider is ChromeOS-enterprise-only; drop.",
  vpnProvider: "vpnProvider is ChromeOS-only; use a Network Extension natively or drop.",
  wallpaper: "chrome.wallpaper is ChromeOS-only; drop.",
  loginScreenStorage: "loginScreenStorage is ChromeOS-kiosk-only; drop.",
  webAuthenticationProxy: "webAuthenticationProxy is enterprise-only; drop.",
  accessibilityFeatures: "accessibilityFeatures has no Safari equivalent; drop.",
  fontSettings: "fontSettings has no Safari equivalent; drop.",
};

/**
 * Permissions that are removed from the manifest (Safari rejects them) but whose
 * API the runtime shim still emulates with real, usable behavior — so the feature
 * keeps working at runtime. These get a "shimmed" tag instead of a bare "removed"
 * warning, so the author isn't misled into thinking the capability is gone.
 * Only list permissions the shim functionally backs; APIs that merely reject
 * gracefully (debugger, tabCapture, …) do NOT belong here.
 */
export const SHIMMED_PERMISSIONS = new Set([
  "tabGroups",
  "userScripts",
  "idle",
  "sessions",
  "topSites",
  "search",
  // sidePanel → action popover (Safari 17.4+) / tab fallback; offscreen → extension-
  // origin iframe. Both emulated in safari-compat-shim.js, so flag them shimmed, not
  // bare-removed.
  "sidePanel",
  "offscreen",
  // Real shim implementations (not graceful no-ops): tts → Web Speech
  // (speechSynthesis), power → Screen Wake Lock (navigator.wakeLock). See
  // safari-compat-shim.js §chrome.tts / §chrome.power. (`notifications` is shimmed
  // too via Notification(), but it isn't a stripped permission — Safari keeps the
  // permission — so it never reaches this set.)
  "tts",
  "power",
  // chrome.debugger → CDP subset (Page/Target/Input/DOM/Runtime/Accessibility)
  // emulated over Safari tabs + scripting in safari-compat-shim.js. Network/Fetch
  // and OS-trusted input remain unavailable, but the core capability is backed.
  "debugger",
]);

/** chrome.* API call patterns flagged during JS scans. */
export const UNSUPPORTED_APIS: Record<
  string,
  { severity: Issue["severity"]; message: string; fix: string; shimmed?: boolean }
> = {
  "chrome.identity.launchWebAuthFlow": {
    severity: "warning",
    message: "launchWebAuthFlow is unsupported and safari-web-extension:// redirects are blocked.",
    fix: "Open hosted auth in a tab, redirect to your own HTTPS callback, postMessage the code back.",
  },
  "chrome.identity": {
    severity: "warning",
    message: "chrome.identity is unsupported in Safari (all platforms).",
    fix: "Replace with a hosted OAuth2 redirect flow; shim stubs it so calls reject instead of throwing.",
    shimmed: true,
  },
  "chrome.debugger": {
    severity: "info",
    shimmed: true,
    message: "chrome.debugger (Chrome DevTools Protocol) is emulated by the viaduct CDP shim.",
    fix: "A CDP subset (Page/Target/Input/DOM/Runtime/Accessibility) is backed by Safari tabs + scripting; Network/Fetch and trusted-input gaps remain.",
  },
  "chrome.gcm": {
    severity: "warning",
    message: "chrome.gcm push messaging is Chrome-only.",
    fix: "Use APNs in the native host app, or poll via chrome.alarms + fetch.",
  },
  "chrome.notifications": {
    severity: "info",
    message: "chrome.notifications is backed by the Web Notification API (create + clear/update/getAll/getPermissionLevel and all events).",
    fix: "No action needed; banners fire once notification permission is granted. Call Notification.requestPermission() if you haven't.",
    shimmed: true,
  },
  "chrome.contextMenus": {
    severity: "info",
    message: "chrome.contextMenus works natively on macOS Safari but is absent on iOS (no right-click surface).",
    fix: "Fine for macOS-only targets. For iOS, register a 'contextmenu' listener in a content script and relay via runtime.sendMessage.",
  },
  "cookies.onChanged": {
    severity: "warning",
    message: "cookies.onChanged is unsupported.",
    fix: "Poll cookies, or monitor session state from a content script.",
  },
  "runtime.setUninstallURL": {
    severity: "info",
    message: "runtime.setUninstallURL has no Safari surface; the shim no-ops the call (the uninstall page just won't open).",
    fix: "No action needed; remove the call if you want to drop the dead code.",
    shimmed: true,
  },
  "runtime.connectNative": {
    severity: "info",
    message: "connectNative is bridged: the (unsandboxed) container app runs a loopback broker that launches the Chrome native-messaging host from its on-disk manifest and pipes stdio framing; the sandboxed appex relays to it.",
    fix: "Keep the container app running (it hosts the broker) and install the companion app that registered the native host.",
    shimmed: true,
  },
  "runtime.sendNativeMessage": {
    severity: "info",
    message: "sendNativeMessage is bridged: the container app's broker launches the manifest-declared native host for one exchange and returns its reply; the sandboxed appex relays over loopback.",
    fix: "Keep the container app running and install the companion app that registered the native host.",
    shimmed: true,
  },
  "tabs.move": { severity: "warning", message: "tabs.move is unsupported.", fix: "Remove or rework UX." },
  "tabs.highlighted": {
    severity: "warning",
    message: "tabs.highlighted query is unsupported.",
    fix: "Use tabs.query({ active: true }).",
  },
  "webNavigation.onCreatedNavigationTarget": {
    severity: "warning",
    message: "webNavigation.onCreatedNavigationTarget is unsupported.",
    fix: "Use webNavigation.onCommitted.",
  },
  "webNavigation.onHistoryStateUpdated": {
    // Safari has no implementation; the shim feeds the event from the content script,
    // which is exactly what the old advice here told the developer to write themselves.
    severity: "info",
    message: "webNavigation.onHistoryStateUpdated has no Safari surface; the shim emulates it (and onReferenceFragmentUpdated) from the content script, which reports the top frame's URL.",
    fix: "No action needed on a granted site. A frame the user hasn't granted access to reports nothing, and a hidden tab is only caught when it is shown again.",
    shimmed: true,
  },
  "chrome.tts\\b": {
    // Keep in sync with SHIMMED_PERMISSIONS/UNSUPPORTED_PERMISSIONS.tts: the shim
    // routes chrome.tts to the Web Speech API, so this is informational.
    severity: "info",
    message: "chrome.tts is routed to the Web Speech API (speechSynthesis) by the shim; speak/stop/pause keep working.",
    fix: "No action needed for basic speech; voices map to the platform's speechSynthesis voices.",
    shimmed: true,
  },
  "chrome.ttsEngine": {
    severity: "warning",
    message: "chrome.ttsEngine is unsupported in Safari.",
    fix: "Provide TTS via the native host (AVSpeechSynthesizer); there is no Safari TTS-engine API.",
  },
  "chrome.tabCapture": {
    severity: "warning",
    message: "chrome.tabCapture is unsupported in Safari.",
    fix: "Use navigator.mediaDevices.getDisplayMedia(), or a native bridge.",
  },
  "chrome.desktopCapture": {
    severity: "warning",
    message: "chrome.desktopCapture is unsupported in Safari.",
    fix: "Use navigator.mediaDevices.getDisplayMedia(), or a native bridge.",
  },
  "chrome.pageCapture": {
    severity: "warning",
    message: "chrome.pageCapture is unsupported in Safari.",
    fix: "Reconstruct via content-script DOM serialization, or drop.",
  },
  "chrome.proxy": {
    severity: "warning",
    message: "chrome.proxy has no Safari equivalent.",
    fix: "Configure proxying natively (Network Extension) or drop the feature.",
  },
  "chrome.privacy": {
    severity: "warning",
    message: "chrome.privacy has no Safari equivalent.",
    fix: "Remove or guard behind feature detection.",
  },
  "chrome.contentSettings": {
    severity: "warning",
    message: "chrome.contentSettings has no Safari equivalent.",
    fix: "Remove or guard behind feature detection.",
  },
  "chrome.browsingData": {
    severity: "warning",
    message: "chrome.browsingData has no Safari equivalent.",
    fix: "Remove or guard behind feature detection.",
  },
  "chrome.management": {
    severity: "info",
    message: "chrome.management: the shim provides getSelf() (from the manifest); other methods reject/resolve empty.",
    fix: "Self-introspection works; if you rely on managing other extensions, move that to the native host app.",
  },
  "chrome.power": {
    // Keep in sync with SHIMMED_PERMISSIONS/UNSUPPORTED_PERMISSIONS.power: the
    // shim backs requestKeepAwake with the Screen Wake Lock API.
    severity: "info",
    message: "chrome.power is backed by the Screen Wake Lock API (navigator.wakeLock) by the shim.",
    fix: "No action needed; the 'system' (display-off) level has no web equivalent and behaves like 'display'.",
    shimmed: true,
  },
  "chrome.system": {
    severity: "warning",
    message: "chrome.system.* (cpu/memory/storage/display) has no Safari equivalent.",
    fix: "Route through a native bridge, or drop.",
  },
  "chrome.omnibox": {
    severity: "warning",
    message: "chrome.omnibox has no Safari equivalent (no address-bar keyword).",
    fix: "Drop the omnibox feature; expose the action via the popup instead.",
  },
  "chrome.fontSettings": {
    severity: "warning",
    message: "chrome.fontSettings has no Safari equivalent.",
    fix: "Remove or guard behind feature detection.",
  },
  "chrome.accessibilityFeatures": {
    severity: "warning",
    message: "chrome.accessibilityFeatures has no Safari equivalent.",
    fix: "Remove or guard behind feature detection.",
  },
  "chrome.readingList": {
    severity: "info",
    message: "chrome.readingList is emulated (add/remove/update/query + events) over an extension-private store — NOT the user's native Safari Reading List (no API exists).",
    fix: "No action needed if you manage your own list; you cannot read/write Safari's native Reading List.",
  },
  "chrome.sessions": {
    severity: "info",
    message: "chrome.sessions has no Safari equivalent; shim returns empty results.",
    fix: "Feature-detect; hide recently-closed UI on Safari.",
  },
  "chrome.topSites": {
    severity: "info",
    message: "chrome.topSites has no Safari equivalent; shim returns an empty list.",
    fix: "Feature-detect; hide top-sites UI on Safari.",
  },
  "chrome.declarativeContent": {
    severity: "warning",
    message: "chrome.declarativeContent rules never fire in Safari (shim stubs the constructors).",
    fix: "Use content scripts + chrome.action instead of declarative page rules.",
  },
  "chrome.search\\b": {
    severity: "info",
    message: "chrome.search has no Safari equivalent; shim opens the query in a search-engine tab.",
    fix: "Acceptable fallback for most flows; otherwise open a search URL yourself.",
  },
  "chrome.userScripts": {
    severity: "warning",
    message: "chrome.userScripts: the management surface is emulated (register/getScripts/update/unregister round-trip), but the scripts are NOT actually injected — WebKit has no dynamic user-world API.",
    fix: "For real injection, statically declare content scripts or use chrome.scripting.",
  },
  "chrome.idle": {
    severity: "info",
    message: "chrome.idle is unsupported; shim derives state from page visibility.",
    fix: "Don't rely on machine-level idle detection on Safari.",
  },
  "chrome.instanceID": {
    severity: "info",
    message: "chrome.instanceID: getID/getCreationTime/deleteID work (stable persisted ID); getToken/deleteToken (FCM push) still reject — no Safari surface.",
    fix: "For push, use APNs via the native host or poll with chrome.alarms.",
  },
  "chrome.bookmarks": {
    severity: "info",
    message: "chrome.bookmarks is fully emulated (CRUD/search/events) over an extension-private store in storage.local — NOT the user's Safari bookmarks (no API exists for those).",
    fix: "No action needed if you manage your own bookmark data; you cannot read/write the user's real Safari bookmarks.",
  },
  "chrome.history": {
    severity: "info",
    message: "chrome.history is limited in Safari.",
    fix: "Verify availability; feature-detect and degrade.",
  },
  "chrome.downloads": {
    severity: "info",
    message: "chrome.downloads: download() triggers a real download and items are tracked in a registry (search/onCreated/onChanged work); WebKit gives no progress, so items go in_progress→complete with unknown byte counts.",
    fix: "Works for start-then-track flows; don't rely on byte-level progress.",
  },
  "chrome.i18n.detectLanguage": {
    severity: "info",
    message: "chrome.i18n.detectLanguage has no Safari engine; the shim returns 'und' (undetermined).",
    fix: "Don't branch on detected language in Safari; detect server-side or skip the feature.",
  },
};
