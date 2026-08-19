import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Regression: the content-script half of the onHistoryStateUpdated emulation used to hook
// history.pushState. A content script runs in an ISOLATED WORLD and holds a different
// `history` than the page, so page-initiated routing was invisible — measured live on
// GitHub, whose Turbo router pushes state in the page world and produced no events at all.
// location.href reflects the result in both worlds, so it is watched instead — in short
// bursts after user input, since a standing timer in every frame of every page is a real
// cost for a rare event.
//
// Second regression, same feature: Safari RE-INJECTS content scripts on same-document
// navigations (measured on GitHub — every Turbo click re-ran the shim) and gives each
// injection a FRESH isolated world. Neither a closure nor a `window` property survives to
// be compared against; both are re-seeded to the very URL being detected. So this half is
// stateless: it announces the current URL on every injection and the background diffs.

/**
 * Model a content-script context on an http(s) origin. `navWatch` mirrors a background
 * that has a listener registered, which is what it answers a nav report with.
 */
function installContentScript(startUrl, protocol = "https:", { navWatch = false, top = null } = {}) {
  const sent = [];
  const listeners = {};
  const docListeners = {};
  const timers = new Set();
  const chrome = {
    runtime: {
      id: "test-ext",
      lastError: null,
      getURL: (p) => "safari-web-extension://TEST/" + String(p ?? ""),
      getManifest: () => ({ manifest_version: 3, action: {} }),
      onMessage: { addListener() {}, removeListener() {}, hasListener: () => false },
      sendMessage: (m, cb) => {
        sent.push(m);
        if (m && m.__c2sNav && cb) cb({ __c2sNavWatch: navWatch });
      },
      connect: () => ({ onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {}, disconnect() {} }),
      onConnect: { addListener() {} },
    },
    storage: { local: { set() {}, get(_k, cb) { cb && cb({}); } } },
  };
  const sandbox = {
    chrome, console, Promise, JSON, Object, Array, Error, Date, Math, String, Number,
    Boolean, URL, Symbol, Proxy, Reflect, Map, Set, WeakMap, RegExp, TypeError, isNaN,
    parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    location: { href: startUrl, protocol, pathname: "/", search: "" },
    history: { pushState() {}, replaceState() {} },
    addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); },
    removeEventListener() {},
    document: {
      addEventListener: (name, fn) => { (docListeners[name] = docListeners[name] || []).push(fn); },
      removeEventListener() {},
    },
    setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); timers.add(h); return h; },
    clearTimeout: (h) => { timers.delete(h); clearTimeout(h); },
    setInterval: (fn, ms) => { const h = setInterval(fn, ms); timers.add(h); return h; },
    clearInterval: (h) => { timers.delete(h); clearInterval(h); },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  // A content script in the top frame sees window.top === window; a subframe does not.
  sandbox.top = top === null ? sandbox : top;
  vm.createContext(sandbox);
  const inject = () => vm.runInContext(shimSource({ origin: "", hosts: [] }), sandbox, { filename: "safari-compat-shim.js" });
  inject();

  const navs = () => sent.filter((m) => m && m.__c2sNav).map((m) => m.__c2sNav);
  const dispose = () => { for (const h of timers) { clearTimeout(h); clearInterval(h); } timers.clear(); };
  // SPA routing is user-driven, so the watcher only runs after input.
  const click = () => { for (const fn of docListeners.click || []) fn({}); };
  return { sandbox, listeners, click, inject, navs, dispose };
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test("a re-injected content script announces the new URL", async (t) => {
  // Safari's actual behaviour on a Turbo click: the URL changes, then the whole content
  // script runs again — in a fresh isolated world, so it cannot remember the old URL.
  const { sandbox, inject, navs, dispose } = installContentScript("https://github.com/o/r");
  t.after(dispose);

  sandbox.location.href = "https://github.com/o/r/pulls";
  inject();

  assert.deepEqual(navs().map((n) => n.url), [
    "https://github.com/o/r",
    "https://github.com/o/r/pulls",
  ], "every injection announces so the background can diff");
});

test("a page-world URL change is reported without any history hook firing", async (t) => {
  // The other half: a document that is NOT re-injected, where the burst watcher carries it.
  const { sandbox, click, navs, dispose } = installContentScript("https://github.com/o/r");
  t.after(dispose);

  click();
  sandbox.location.href = "https://github.com/o/r/pulls";
  await settle(700);

  assert.deepEqual(navs().map((n) => n.url), [
    "https://github.com/o/r",
    "https://github.com/o/r/pulls",
  ], "the watcher must notice the page-world navigation");
});

test("the first injection announces exactly once", async (t) => {
  const { navs, dispose } = installContentScript("https://github.com/o/r");
  t.after(dispose);
  assert.equal(navs().length, 1);
  assert.equal(navs()[0].url, "https://github.com/o/r");
});

test("a stationary page reports nothing", async (t) => {
  const { click, navs, dispose } = installContentScript("https://github.com/o/r");
  t.after(dispose);
  click();
  await settle(700);
  assert.equal(navs().length, 1, "only the install-time announcement");
});

test("an idle page arms no timer until the extension asks for one", async (t) => {
  // A standing interval in every frame of every page was what made the suite hang, so it
  // stays off for an extension that never listens for SPA navigation.
  const { sandbox, navs, dispose } = installContentScript("https://a.example/1");
  t.after(dispose);
  sandbox.location.href = "https://a.example/2";
  await settle(700);
  assert.equal(navs().length, 1, "no listener, no watcher — just the install announcement");
});

test("a programmatic route change is reported once the watch is armed", async (t) => {
  // Regression: Cloaked's login. Its dashboard pushes the extension-auth status route
  // seconds after the last click, when the token exchange returns, and installs the
  // page↔extension bridge from the event. Measured on Safari 26, that push neither
  // re-injects this file nor fires any input event, so a burst-only watcher saw nothing
  // and the extension stayed logged out behind a page that said it had logged in.
  const { sandbox, navs, dispose } = installContentScript("https://my.cloaked.com/extension-auth/issue/", "https:", { navWatch: true });
  t.after(dispose);

  sandbox.location.href = "https://my.cloaked.com/extension-auth/status/";
  await settle(700);

  assert.deepEqual(navs().map((n) => n.url), [
    "https://my.cloaked.com/extension-auth/issue/",
    "https://my.cloaked.com/extension-auth/status/",
  ], "no click, no keypress, no re-injection — the standing watch is the only witness");
});

test("the standing watch stays out of subframes", async (t) => {
  // An SPA route change is the top document's, and one timer per page is the budget.
  const { sandbox, navs, dispose } = installContentScript("https://a.example/1", "https:", { navWatch: true, top: {} });
  t.after(dispose);
  sandbox.location.href = "https://a.example/2";
  await settle(700);
  assert.equal(navs().length, 1, "only the install-time announcement");
});

test("each hop is reported once, chained previous → url", async (t) => {
  const { sandbox, click, navs, dispose } = installContentScript("https://a.example/1");
  t.after(dispose);

  click();
  sandbox.location.href = "https://a.example/2";
  await settle(600);
  click();
  sandbox.location.href = "https://a.example/3";
  await settle(600);

  // Mapped to plain strings: objects created inside the vm context have a different
  // Object.prototype, which deepStrictEqual rejects on identity alone.
  assert.deepEqual(navs().map((n) => n.url), [
    "https://a.example/1",
    "https://a.example/2",
    "https://a.example/3",
  ]);
});

test("popstate reports immediately rather than waiting for the next poll", async (t) => {
  const { sandbox, listeners, navs, dispose } = installContentScript("https://a.example/1");
  t.after(dispose);

  sandbox.location.href = "https://a.example/2";
  for (const fn of listeners.popstate || []) fn({});
  await settle(50); // well inside the watcher's tick

  assert.deepEqual(navs().map((n) => n.url), ["https://a.example/1", "https://a.example/2"]);
});

test("the watcher stops on pagehide", async (t) => {
  const { sandbox, listeners, click, navs, dispose } = installContentScript("https://a.example/1");
  t.after(dispose);

  click();
  for (const fn of listeners.pagehide || []) fn({});
  sandbox.location.href = "https://a.example/2";
  await settle(700);

  assert.equal(navs().length, 1, "a torn-down page must not keep watching");
});

test("an extension page does not report its own navigations", async (t) => {
  // A popup or options page moving its own hash is not a browsing navigation, and
  // reporting it would fire onHistoryStateUpdated with no real tab behind it.
  const { sandbox, click, navs, dispose } = installContentScript(
    "safari-web-extension://TEST/popup.html",
    "safari-web-extension:",
  );
  t.after(dispose);

  click();
  sandbox.location.href = "safari-web-extension://TEST/popup.html#tab=2";
  await settle(700);

  assert.equal(navs().length, 0, "an extension page never announces at all");
});
