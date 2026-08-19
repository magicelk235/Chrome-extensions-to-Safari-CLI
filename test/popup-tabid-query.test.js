import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Safari opens a side panel as a popover with no ?tabId=<n> query, so the shim resolves
// the active tab and writes the param in with history.replaceState. That is right for a
// side panel and wrong for an action popup: Chrome puts no query on a popup URL either,
// so the injection invents a URL the bundle never expects to see. Honey routes its own
// messages off that comparison:
//
//   let service = "messages:cs";
//   window.location.href === chrome.runtime.getURL("/popover/popover.html") &&
//     (service = "messages:popover");                       // Honey, verbatim
//
// Once ?tabId lands the compare fails, every popup RPC goes out as messages:cs, and the
// background's messages:cs listener drops anything with no sender.tab — which is every
// message a popup sends. No reply, no error, popup renders empty.

function runShimOnPage(href, manifest) {
  const timers = new Set();
  const url = new URL(href);
  const location = {
    href,
    protocol: url.protocol,
    origin: url.origin,
    pathname: url.pathname,
    search: url.search,
  };
  const replaceStateCalls = [];
  const area = {
    get: (_k, cb) => { if (typeof cb === "function") cb({}); return Promise.resolve({}); },
    set: (_o, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
    remove: (_k, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
  };
  const chrome = {
    runtime: {
      id: "abc",
      lastError: null,
      getURL: (p) => "safari-web-extension://abc" + (p.startsWith("/") ? p : "/" + p),
      getManifest: () => manifest,
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener() {}, removeListener() {}, hasListener: () => false },
      onConnect: { addListener() {}, removeListener() {}, hasListener: () => false },
      connect: () => ({ onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {}, disconnect() {} }),
    },
    storage: { local: area, sync: area, onChanged: { addListener() {}, removeListener() {} } },
    tabs: {
      query: (_q, cb) => { const r = [{ id: 42, url: "https://example.com/" }]; if (typeof cb === "function") cb(r); return Promise.resolve(r); },
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
    location,
    history: {
      state: null,
      pushState() {},
      // Mirror the browser: a replaceState URL becomes location.href.
      replaceState(state, _title, u) {
        replaceStateCalls.push(u);
        const next = new URL(u);
        location.href = next.href;
        location.pathname = next.pathname;
        location.search = next.search;
      },
    },
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
  return { location, replaceStateCalls, chrome, dispose };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test("an action popup's URL is left alone — no ?tabId is injected", async (t) => {
  const href = "safari-web-extension://abc/popover/popover.html";
  const { location, replaceStateCalls, chrome, dispose } = runShimOnPage(href, {
    manifest_version: 3,
    action: { default_popup: "popover/popover.html" },
  });
  t.after(dispose);

  await settle();

  assert.deepEqual(replaceStateCalls, [], "the popup document's URL must not be rewritten");
  assert.equal(
    location.href,
    chrome.runtime.getURL("/popover/popover.html"),
    "must still equal getURL(path) exactly — bundles route their own messages off this compare",
  );
});

test("a side panel still gets the tabId param Safari omits", async (t) => {
  const { location, dispose } = runShimOnPage("safari-web-extension://abc/sidepanel.html", {
    manifest_version: 3,
    side_panel: { default_path: "sidepanel.html" },
  });
  t.after(dispose);

  await settle();

  assert.equal(
    new URLSearchParams(location.search).get("tabId"),
    "42",
    "a side panel reads the active tab out of location.search; Safari never puts one there",
  );
});

test("a page that is both the side panel and the action popup still gets the param", async (t) => {
  const { location, dispose } = runShimOnPage("safari-web-extension://abc/panel.html", {
    manifest_version: 3,
    side_panel: { default_path: "panel.html" },
    action: { default_popup: "panel.html" },
  });
  t.after(dispose);

  await settle();

  assert.equal(new URLSearchParams(location.search).get("tabId"), "42");
});
