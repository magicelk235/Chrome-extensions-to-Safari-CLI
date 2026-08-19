import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Regression: Cloaked - Privacy & Password Manager. It installs its page↔extension
// bridge from webNavigation.onHistoryStateUpdated on my.cloaked.com (a Vue SPA). Safari
// has no implementation and the shim used to backfill an inert stub, so the bridge was
// never installed, the dashboard's postMessage had no listener, and the extension never
// received the session after login.
//
// This is the receiving half. Content scripts announce their URL on every injection
// (measured: Safari delivers no navigation events to a background page at all, so there
// is nothing background-side to build on) and the background holds the per-tab baseline
// and decides what changed. tabs.onUpdated stays wired for hosts that do deliver it.

/** Evaluate the shim against a fake Safari-shaped `chrome` with drivable events. */
function runShim() {
  const timers = new Set();
  const updatedListeners = [];
  const removedListeners = [];
  const messageListeners = [];
  const chrome = {
    runtime: {
      id: "abc", lastError: null,
      getURL: (p) => "safari-web-extension://abc/" + p,
      getManifest: () => ({}),
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener: (f) => messageListeners.push(f), removeListener() {}, hasListener: () => false },
    },
    tabs: {
      query: () => Promise.resolve([]),
      create: () => Promise.resolve({ id: 1 }),
      onUpdated: { addListener: (f) => updatedListeners.push(f), removeListener() {}, hasListener: () => false },
      onRemoved: { addListener: (f) => removedListeners.push(f), removeListener() {}, hasListener: () => false },
    },
    // Deliberately no webNavigation: Safari omits these events, so the shim backfills.
  };
  const sandbox = {
    chrome, browser: chrome, console, Promise, JSON, Object, Array, Error, Date, Math,
    String, Number, Boolean, URL, Symbol, Proxy, Reflect, Map, Set, WeakMap, RegExp,
    TypeError, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); timers.add(h); return h; },
    clearTimeout: (h) => { timers.delete(h); clearTimeout(h); },
    setInterval: (fn, ms) => { const h = setInterval(fn, ms); timers.add(h); return h; },
    clearInterval: (h) => { timers.delete(h); clearInterval(h); },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource({ origin: "", hosts: [] }), sandbox, { filename: "safari-compat-shim.js" });

  const update = (tabId, changeInfo, tab) => {
    for (const f of updatedListeners) f(tabId, changeInfo, tab || { id: tabId });
  };
  const close = (tabId) => { for (const f of removedListeners) f(tabId); };
  const relayRaw = (msg, sender, respond) => {
    for (const f of messageListeners) f(msg, sender, respond || (() => {}));
  };
  const relay = (url, sender) => relayRaw({ __c2sNav: { url } }, sender);
  // What the sender actually reads: the answer to its own report.
  const answerTo = (url, sender) => {
    let answer;
    relayRaw({ __c2sNav: { url } }, sender || { tab: { id: 1 }, frameId: 0 }, (r) => { answer = r; });
    return answer;
  };
  const dispose = () => { for (const h of timers) { clearTimeout(h); clearInterval(h); } timers.clear(); };
  return { chrome, update, close, relay, relayRaw, answerTo, dispose };
}

test("the answer to a report says whether anything is listening", (t) => {
  // A page-world pushState with no preceding input is invisible to a content script that
  // only watches in bursts after input (measured on Safari 26: no re-injection, no report),
  // and that is the navigation Cloaked's login turns on. So the content script watches
  // continuously — but only where something listens, which is what this answer tells it.
  const { chrome, answerTo, dispose } = runShim();
  t.after(dispose);

  // The answer object comes out of the VM realm, so read the field rather than compare shapes.
  assert.equal(answerTo("https://a.example/1").__c2sNavWatch, false, "nobody listens yet");

  const fn = () => {};
  chrome.webNavigation.onHistoryStateUpdated.addListener(fn);
  assert.equal(answerTo("https://a.example/2").__c2sNavWatch, true);

  chrome.webNavigation.onReferenceFragmentUpdated.addListener(() => {});
  chrome.webNavigation.onHistoryStateUpdated.removeListener(fn);
  assert.equal(answerTo("https://a.example/3").__c2sNavWatch, true, "the fragment listener still wants it");
});

test("dropping the last listener stops asking pages for a standing watch", (t) => {
  const { chrome, answerTo, dispose } = runShim();
  t.after(dispose);
  const fn = () => {};
  chrome.webNavigation.onHistoryStateUpdated.addListener(fn);
  chrome.webNavigation.onHistoryStateUpdated.removeListener(fn);
  assert.equal(answerTo("https://a.example/9").__c2sNavWatch, false);
});

test("a same-document URL change fires onHistoryStateUpdated", (t) => {
  const { chrome, update, dispose } = runShim();
  t.after(dispose);
  const seen = [];
  chrome.webNavigation.onHistoryStateUpdated.addListener((d) => seen.push(d));
  assert.notEqual(chrome.webNavigation.onHistoryStateUpdated.__c2sInert, true);

  update(7, { url: "https://my.cloaked.com/" });
  update(7, { url: "https://my.cloaked.com/dashboard" });

  assert.equal(seen.length, 1, "expected exactly one history-state event");
  assert.equal(seen[0].url, "https://my.cloaked.com/dashboard");
  assert.equal(seen[0].tabId, 7);
  // Cloaked gates on frameId === 0; anything else is silently ignored.
  assert.equal(seen[0].frameId, 0);
});

test("a real page load does not masquerade as a history-state change", (t) => {
  const { chrome, update, dispose } = runShim();
  t.after(dispose);
  const seen = [];
  chrome.webNavigation.onHistoryStateUpdated.addListener((d) => seen.push(d));

  update(7, { url: "https://example.com/", status: "loading" });
  update(7, { status: "complete" });

  assert.equal(seen.length, 0, "status:loading is onCommitted's job, not ours");
});

test("a fragment-only change fires onReferenceFragmentUpdated instead", (t) => {
  const { chrome, update, dispose } = runShim();
  t.after(dispose);
  const hist = [];
  const frag = [];
  chrome.webNavigation.onHistoryStateUpdated.addListener((d) => hist.push(d));
  chrome.webNavigation.onReferenceFragmentUpdated.addListener((d) => frag.push(d));

  update(7, { url: "https://example.com/docs" });
  update(7, { url: "https://example.com/docs#install" });

  assert.equal(hist.length, 0);
  assert.equal(frag.length, 1);
  assert.equal(frag[0].url, "https://example.com/docs#install");
});

test("an unchanged URL fires nothing", (t) => {
  const { chrome, update, dispose } = runShim();
  t.after(dispose);
  const seen = [];
  chrome.webNavigation.onHistoryStateUpdated.addListener((d) => seen.push(d));

  update(7, { url: "https://example.com/a" });
  update(7, { url: "https://example.com/a" });
  update(7, { url: "https://example.com/a" });

  assert.equal(seen.length, 0);
});

test("tabs are tracked independently and forgotten when closed", (t) => {
  const { chrome, update, close, dispose } = runShim();
  t.after(dispose);
  const seen = [];
  chrome.webNavigation.onHistoryStateUpdated.addListener((d) => seen.push(d));

  update(1, { url: "https://a.example/" });
  update(2, { url: "https://b.example/" });
  update(1, { url: "https://a.example/next" });
  assert.deepEqual(seen.map((d) => [d.tabId, d.url]), [[1, "https://a.example/next"]]);

  // After the tab closes its baseline is dropped, so the first URL of a reused id
  // seeds fresh rather than firing a bogus navigation.
  close(1);
  update(1, { url: "https://c.example/" });
  assert.equal(seen.length, 1);
});

test("a content script's relayed navigation fires the event", (t) => {
  const { chrome, relay, dispose } = runShim();
  t.after(dispose);
  const hist = [];
  chrome.webNavigation.onHistoryStateUpdated.addListener((d) => hist.push(d));

  const from = { tab: { id: 9 }, frameId: 0 };
  // The sender is stateless — each injection announces its URL and the background keeps
  // the baseline. The first announcement is the page load, so it must stay silent.
  relay("https://my.cloaked.com/", from);
  assert.equal(hist.length, 0, "the first report for a tab is a full load, not a history change");

  relay("https://my.cloaked.com/dashboard", from);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].url, "https://my.cloaked.com/dashboard");
  assert.equal(hist[0].tabId, 9, "tabId must come from the sender — Cloaked messages that tab back");
});

test("a relayed fragment-only change routes to onReferenceFragmentUpdated", (t) => {
  const { chrome, relay, dispose } = runShim();
  t.after(dispose);
  const hist = [];
  const frag = [];
  chrome.webNavigation.onHistoryStateUpdated.addListener((d) => hist.push(d));
  chrome.webNavigation.onReferenceFragmentUpdated.addListener((d) => frag.push(d));

  const from = { tab: { id: 9 }, frameId: 0 };
  relay("https://example.com/docs", from);
  relay("https://example.com/docs#install", from);

  assert.equal(hist.length, 0);
  assert.equal(frag.length, 1);
  assert.equal(frag[0].url, "https://example.com/docs#install");
});

test("each tab keeps its own baseline across relays", (t) => {
  const { chrome, relay, dispose } = runShim();
  t.after(dispose);
  const seen = [];
  chrome.webNavigation.onHistoryStateUpdated.addListener((d) => seen.push(d));

  relay("https://a.example/", { tab: { id: 1 }, frameId: 0 });
  relay("https://b.example/", { tab: { id: 2 }, frameId: 0 });
  relay("https://a.example/next", { tab: { id: 1 }, frameId: 0 });

  assert.deepEqual(seen.map((d) => d.tabId + " " + d.url), ["1 https://a.example/next"]);
});

test("the same navigation from both sources is only emitted once", (t) => {
  const { chrome, update, relay, dispose } = runShim();
  t.after(dispose);
  const seen = [];
  chrome.webNavigation.onHistoryStateUpdated.addListener((d) => seen.push(d));

  update(9, { url: "https://a.example/" });
  relay("https://a.example/next", { tab: { id: 9 }, frameId: 0 });
  update(9, { url: "https://a.example/next" });

  assert.equal(seen.length, 1, "content script and tabs.onUpdated described the same hop");
});

test("an unrelated runtime message is ignored", (t) => {
  const { chrome, relayRaw, dispose } = runShim();
  t.after(dispose);
  const seen = [];
  chrome.webNavigation.onHistoryStateUpdated.addListener((d) => seen.push(d));
  relayRaw({ hello: "world" }, { tab: { id: 9 } });
  relayRaw(null, { tab: { id: 9 } });
  assert.equal(seen.length, 0);
});

test("removeListener detaches", (t) => {
  const { chrome, update, dispose } = runShim();
  t.after(dispose);
  const seen = [];
  const fn = (d) => seen.push(d);
  chrome.webNavigation.onHistoryStateUpdated.addListener(fn);
  update(7, { url: "https://example.com/a" });
  chrome.webNavigation.onHistoryStateUpdated.removeListener(fn);
  update(7, { url: "https://example.com/b" });
  assert.equal(seen.length, 0);
});
