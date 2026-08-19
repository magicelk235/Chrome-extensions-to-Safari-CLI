import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// An extension page's href can carry a ?tabId=<n> query that runtime.getURL(path) never
// has — the shim writes one into a side panel's URL, since Safari opens the panel as a
// popover with no query — and bundles allow-list their own pages by exact-matching
// sender.url against getURL:
//
//   const allowedSenderURL = [chrome.runtime.getURL("/ui/popup/index.html"), …];
//   if (allowedSenderURL.includes(sender.url)) { … }        // Dark Reader, verbatim
//
// Native delivery has that query stripped by senderWithFixedUrl. The storage relay, which
// takes over runtime.sendMessage on every extension page, builds its own sender out of
// location.href instead — so it reintroduced the exact bug on a second path: every popup
// RPC (GET_DATA, CHANGE_SETTINGS…) failed the includes(), was dropped without a
// sendResponse, and the popup's await sat unresolved until the 30s deadline. Live symptom
// on Dark Reader: the popup stuck on "Loading, please wait", and once it did paint from
// cache, every button was dead.

/** Run the shim on an extension page at `href` and capture the relay's mailbox writes. */
function runShimOnExtensionPage(href) {
  const timers = new Set();
  const writes = [];
  const url = new URL(href);
  const storageArea = {
    get: (_k, cb) => { if (typeof cb === "function") cb({}); return Promise.resolve({}); },
    set: (o, cb) => { writes.push(o); if (typeof cb === "function") cb(); return Promise.resolve(); },
    remove: (_k, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
  };
  const runtime = {
    id: "abc",
    lastError: null,
    getURL: (p) => "safari-web-extension://abc" + (p.startsWith("/") ? p : "/" + p),
    getManifest: () => ({ manifest_version: 3 }),
    sendMessage: () => Promise.resolve(),
    onMessage: { addListener() {}, removeListener() {}, hasListener: () => false },
    onConnect: { addListener() {}, removeListener() {}, hasListener: () => false },
    connect: () => ({ onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {}, disconnect() {} }),
  };
  const chrome = {
    runtime,
    storage: { local: storageArea, sync: storageArea, onChanged: { addListener() {}, removeListener() {} } },
    tabs: { query: () => Promise.resolve([]), onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const sandbox = {
    chrome, browser: chrome, console, Promise, JSON, Object, Array, Error, Date, Math,
    String, Number, Boolean, URL, Symbol, Proxy, Reflect, Map, Set, WeakMap, RegExp,
    TypeError, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    location: { href, protocol: url.protocol, origin: url.origin, pathname: url.pathname, search: url.search },
    history: { pushState() {}, replaceState() {} },
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
  return { sandbox, chrome, writes, dispose };
}

/** The sender the relay recorded for the one request it wrote to the mailbox. */
function relayedSender(writes) {
  for (const o of writes) {
    for (const k of Object.keys(o)) {
      if (k.startsWith("__c2sMbxReq:") && o[k] && o[k].sender) return o[k].sender;
    }
  }
  return null;
}

test("the relay strips Safari's ?tabId from the popup's sender.url", (t) => {
  const { chrome, writes, dispose } = runShimOnExtensionPage(
    "safari-web-extension://abc/ui/popup/index.html?tabId=188",
  );
  t.after(dispose);

  // Deliberately not awaited: without a background to answer, this promise only settles
  // at the relay's 30s deadline. The mailbox record is written synchronously.
  chrome.runtime.sendMessage({ type: "get-data" });

  const sender = relayedSender(writes);
  assert.ok(sender, "the relay must write a request record for a popup sendMessage");
  assert.equal(
    sender.url,
    chrome.runtime.getURL("/ui/popup/index.html"),
    "must equal getURL(path) exactly — a bundle's allowedSenderURL.includes(sender.url) drops anything else",
  );
});

test("a sender.url with no query is passed through untouched", (t) => {
  const href = "safari-web-extension://abc/ui/options/index.html";
  const { chrome, writes, dispose } = runShimOnExtensionPage(href);
  t.after(dispose);

  chrome.runtime.sendMessage({ type: "get-data" });

  const sender = relayedSender(writes);
  assert.ok(sender, "the relay must write a request record");
  assert.equal(sender.url, href, "nothing to strip → the URL must survive verbatim");
});
