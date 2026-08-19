import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Safari delivers no tabs.onActivated to a converted background page — probed live on
// Honey, whose background registered the listener at boot and received nothing while the
// user clicked between three tabs. Extensions that cache the selected tab from that event
// alone are then permanently blind:
//
//   chrome.tabs.onActivated.addListener(e => { selectedTabId = e.tabId; … });
//   function getSelectedTab(){ return tabs.get(selectedTabId) }      // Honey, verbatim
//
// Its popup asked for the selected tab, the background called tabs.get(undefined), and
// Safari answered "Invalid call to tabs.get(). The 'tabID' value is invalid" — leaving the
// popup with no tab id, so every message it sent afterwards was dropped and it rendered
// empty.

function runShim({ href, tabs, manifest }) {
  const timers = new Set();
  const url = new URL(href);
  const nativeActivatedListeners = [];
  const area = {
    get: (_k, cb) => { if (typeof cb === "function") cb({}); return Promise.resolve({}); },
    set: (_o, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
    remove: (_k, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
  };
  const state = { active: tabs[0] };
  const chrome = {
    runtime: {
      id: "com.viaduct.Test.Extension",
      lastError: null,
      getURL: (p) => url.origin + "/" + String(p == null ? "" : p).replace(/^\.?\//, ""),
      getManifest: () => manifest || { manifest_version: 3 },
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener() {}, removeListener() {}, hasListener: () => false },
      onConnect: { addListener() {}, removeListener() {}, hasListener: () => false },
      connect: () => ({ onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {}, disconnect() {} }),
    },
    storage: { local: area, sync: area, onChanged: { addListener() {}, removeListener() {} } },
    tabs: {
      // Safari's own behaviour: the query works, the event never comes.
      query: (_q, cb) => { const r = [state.active]; if (typeof cb === "function") cb(r); return Promise.resolve(r); },
      get: (_id, cb) => { if (typeof cb === "function") cb(state.active); },
      onActivated: {
        addListener(fn) { nativeActivatedListeners.push(fn); },
        removeListener() {}, hasListener: () => false,
      },
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} },
    },
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
  vm.runInContext(shimSource({ hosts: [] }), sandbox, { filename: "safari-compat-shim.js" });

  const dispose = () => { for (const h of timers) { clearTimeout(h); clearInterval(h); } timers.clear(); };
  return { sandbox, chrome, state, nativeActivatedListeners, dispose };
}

const HOST = "safari-web-extension://ABCD1234";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("a background with no native onActivated learns the active tab anyway", async (t) => {
  const { chrome, dispose } = runShim({
    href: HOST + "/background.html",
    tabs: [{ id: 41, windowId: 1, url: "https://example.com/" }],
  });
  t.after(dispose);

  const seen = [];
  chrome.tabs.onActivated.addListener((info) => seen.push(info));

  await wait(600);

  assert.equal(seen.length, 1, "the first poll must dispatch, so a woken background isn't blind");
  assert.equal(seen[0].tabId, 41);
  assert.equal(seen[0].windowId, 1);
  assert.deepEqual(Object.keys(seen[0]).sort(), ["tabId", "windowId"], "Chrome's activeInfo shape");
});

test("switching tabs dispatches again", async (t) => {
  const { chrome, state, dispose } = runShim({
    href: HOST + "/background.html",
    tabs: [{ id: 41, windowId: 1, url: "https://example.com/" }],
  });
  t.after(dispose);

  const seen = [];
  chrome.tabs.onActivated.addListener((info) => seen.push(info));
  await wait(600);
  state.active = { id: 77, windowId: 1, url: "https://other.test/" };
  await wait(1900);

  assert.equal(seen.length, 2, "the change must be picked up by the poll");
  assert.equal(seen[1].tabId, 77);
  assert.equal(seen[1].windowId, 1);
});

test("a native onActivated stands the emulation down — never deliver twice", async (t) => {
  const { chrome, state, nativeActivatedListeners, dispose } = runShim({
    href: HOST + "/background.html",
    tabs: [{ id: 41, windowId: 1, url: "https://example.com/" }],
  });
  t.after(dispose);

  const seen = [];
  chrome.tabs.onActivated.addListener((info) => seen.push(info));

  // Safari (or another browser) fires for real: every registered listener hears it.
  for (const fn of nativeActivatedListeners) fn({ tabId: 41, windowId: 1 });
  const afterNative = seen.length;

  state.active = { id: 77, windowId: 1, url: "https://other.test/" };
  await wait(1900);

  assert.equal(seen.length, afterNative, "no synthetic dispatch once the real event works");
});

test("an extension page does not poll — only the background caches a selected tab", async (t) => {
  const { chrome, dispose } = runShim({
    href: HOST + "/popover/popover.html",
    tabs: [{ id: 41, windowId: 1, url: "https://example.com/" }],
  });
  t.after(dispose);

  const seen = [];
  chrome.tabs.onActivated.addListener((info) => seen.push(info));
  await wait(600);

  assert.equal(seen.length, 0);
});

test("re-registering a listener restarts the poll", async (t) => {
  const { chrome, state, dispose } = runShim({
    href: HOST + "/background.html",
    tabs: [{ id: 41, windowId: 1, url: "https://example.com/" }],
  });
  t.after(dispose);

  const seen = [];
  const fn = (info) => seen.push(info);
  chrome.tabs.onActivated.addListener(fn);
  await wait(600);
  chrome.tabs.onActivated.removeListener(fn);

  // Removing the last listener stops the timer; adding one back has to start it again,
  // or the extension goes permanently blind after any teardown/re-init cycle.
  chrome.tabs.onActivated.addListener(fn);
  state.active = { id: 77, windowId: 1, url: "https://other.test/" };
  await wait(1900);

  assert.equal(seen.length, 2);
  assert.equal(seen[1].tabId, 77);
});

test("an MV2 background page named something else still polls", async (t) => {
  const { chrome, dispose } = runShim({
    href: HOST + "/bg/main.html",
    tabs: [{ id: 41, windowId: 1, url: "https://example.com/" }],
    manifest: { manifest_version: 2, background: { page: "bg/main.html" } },
  });
  t.after(dispose);

  const seen = [];
  chrome.tabs.onActivated.addListener((info) => seen.push(info));
  await wait(600);

  assert.equal(seen.length, 1, "the converted MV3 page is background.html, MV2 keeps its own");
});
