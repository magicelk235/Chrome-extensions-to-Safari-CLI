import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Safari hands out the extension UUID in different cases per API: getURL(), location.href
// and sender.url carry it UPPERCASE, but every origin — sender.origin, location.origin, and
// new URL(url).origin — is lowercase (the URL parser lowercases the host). Two idioms gate
// a bundle's own pages, and they want opposite cases:
//
//   uBlock:   sender.origin === getURL("").slice(0,-1)        // lowercase both sides
//   Honey:    location.href.includes(getExtensionURL("/"))    // uppercase both sides
//   LastPass: new URL(sender.url).origin === sender.origin    // lowercase both sides
//
// An earlier fix lowercased getURL("") AND getURL("/"), which broke Honey: getURL("/") went
// lowercase, inPopover() went false, its popup sent every message without a data.tabId, and
// the background dropped them → blank popup. So the split is: lowercase the host for the
// EMPTY arg only (what the origin comparisons use), and keep Safari's real case for "/" and
// resource paths (the resource server is case-sensitive; a lowercased fetch 404s). That
// leaves sender.origin already lowercase and equal on both sides, so the clone's origin
// alignment is a Safari no-op.

const UPPER = "safari-web-extension://E3AEF829-D4B2-4F9F-8CCA-AA2D0F1CD13A";

function runShim(href) {
  const timers = new Set();
  const url = new URL(href);
  const nativeListeners = [];
  const area = {
    get: (_k, cb) => { if (typeof cb === "function") cb({}); return Promise.resolve({}); },
    set: (_o, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
    remove: (_k, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
  };
  const chrome = {
    runtime: {
      id: "com.viaduct.Test.Extension",
      lastError: null,
      // Safari's own casing: the real host, exactly as it appears in location.href.
      getURL: (p) => UPPER + "/" + String(p == null ? "" : p).replace(/^\.?\//, ""),
      getManifest: () => ({ manifest_version: 3 }),
      sendMessage: () => Promise.resolve(),
      onMessage: {
        addListener(fn) { nativeListeners.push(fn); },
        removeListener() {}, hasListener: () => false,
      },
      onConnect: { addListener() {}, removeListener() {}, hasListener: () => false },
      connect: () => ({ onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {}, disconnect() {} }),
    },
    storage: { local: area, sync: area, onChanged: { addListener() {}, removeListener() {} } },
    tabs: { query: () => Promise.resolve([]), onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const sandbox = {
    chrome, browser: chrome, console, Promise, JSON, Object, Array, Error, Date, Math,
    String, Number, Boolean, URL, URLSearchParams, Symbol, Proxy, Reflect, Map, Set,
    WeakMap, RegExp, TypeError, isNaN, parseInt, parseFloat, encodeURIComponent,
    decodeURIComponent,
    location: { href, protocol: url.protocol, origin: url.origin, pathname: url.pathname, search: url.search },
    navigator: { userAgent: "test" },
    history: { state: null, pushState() {}, replaceState() {} },
    addEventListener() {}, removeEventListener() {},
    document: { addEventListener() {}, removeEventListener() {} },
    setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); timers.add(h); return h; },
    clearTimeout: (h) => { timers.delete(h); clearTimeout(h); },
    setInterval: (fn, ms) => { const h = setInterval(fn, ms); timers.add(h); return h; },
    clearInterval: (h) => { timers.delete(h); clearInterval(h); },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource({ origin: "", hosts: [] }), sandbox, { filename: "safari-compat-shim.js" });

  const dispose = () => { for (const h of timers) { clearTimeout(h); clearInterval(h); } timers.clear(); };
  return { sandbox, chrome, nativeListeners, dispose };
}

test("getURL lowercases the empty-arg host but keeps Safari's case for root and resource paths", (t) => {
  const href = UPPER + "/popover/popover.html";
  const { chrome, dispose } = runShim(href);
  t.after(dispose);

  assert.equal(chrome.runtime.getURL("/"), UPPER + "/", "root arg must keep Safari's real case");
  assert.equal(chrome.runtime.getURL(""), UPPER.toLowerCase() + "/",
    "empty arg host is lowercased so it matches sender.origin / new URL().origin");
  assert.ok(href.includes(chrome.runtime.getURL("/")),
    "location.href.includes(getURL('/')) is how a bundle detects its own page");
});

test("getURL keeps Safari's host case for resource paths (the resource server is case-sensitive)", (t) => {
  const { chrome, dispose } = runShim(UPPER + "/popover/popover.html");
  t.after(dispose);
  assert.equal(chrome.runtime.getURL("manifest.json"), UPPER + "/manifest.json");
});

test("a sender's origin equals getURL('').slice(0,-1) so uBlock's privilege gate passes", (t) => {
  const { chrome, nativeListeners, dispose } = runShim("https://example.com/page");
  t.after(dispose);

  let seen = null;
  chrome.runtime.onMessage.addListener((_msg, sender) => { seen = sender; });
  assert.ok(nativeListeners.length, "the shim must register the listener natively");

  // Safari's sender for an extension page: uppercase url (plus the panel tabId query),
  // lowercase origin. uBlock gates on sender.origin === getURL('').slice(0,-1); both are
  // now lowercase. The shim registers listeners of its own, so drive them all.
  const sender = { id: "com.viaduct.Test.Extension", url: UPPER + "/ui/popup/index.html?tabId=7", origin: UPPER.toLowerCase() };
  for (const fn of nativeListeners) fn({ hello: 1 }, sender, () => {});

  assert.ok(seen, "the listener must be called");
  assert.equal(seen.url, UPPER + "/ui/popup/index.html", "the ?tabId query must be stripped");
  assert.equal(seen.origin, chrome.runtime.getURL("").slice(0, -1),
    "must equal getURL('').slice(0,-1) — bundles gate their own pages on exactly that");
});

test("a sender's origin stays lowercase, so LastPass's new URL(sender.url).origin === sender.origin gate passes", (t) => {
  const { chrome, nativeListeners, dispose } = runShim("https://example.com/page");
  t.after(dispose);

  let seen = null;
  chrome.runtime.onMessage.addListener((_msg, sender) => { seen = sender; });

  // LastPass's background accepts its popup's `initialize` message only when
  // new URL(sender.url).origin === sender.origin. In a browser both are the lowercase host
  // origin (the URL parser lowercases the host). If the shim pushed sender.origin up to
  // getURL's uppercase, the gate would fail and the popup would hang on its splash — so the
  // origin the listener sees must stay the lowercase host origin.
  const sender = { id: "com.viaduct.Test.Extension", url: UPPER + "/webclient-extension-toolbar.html", origin: UPPER.toLowerCase() };
  for (const fn of nativeListeners) fn({ initialize: {} }, sender, () => {});

  assert.ok(seen, "the listener must be called");
  assert.equal(seen.origin, UPPER.toLowerCase(),
    "sender.origin must stay the lowercase host origin that new URL(sender.url).origin returns");
});

test("a content script's http sender is left alone", (t) => {
  const { chrome, nativeListeners, dispose } = runShim("https://example.com/page");
  t.after(dispose);

  let seen = null;
  chrome.runtime.onMessage.addListener((_msg, sender) => { seen = sender; });
  const sender = { id: "com.viaduct.Test.Extension", url: "https://example.com/p?q=1", origin: "https://example.com" };
  for (const fn of nativeListeners) fn({ hello: 1 }, sender, () => {});

  assert.equal(seen.url, "https://example.com/p?q=1", "a page sender's query must survive");
  assert.equal(seen.origin, "https://example.com");
});
