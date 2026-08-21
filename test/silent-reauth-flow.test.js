import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATE_DIR } from "../dist/paths.js";

// `launchWebAuthFlow({interactive:false})` is a silent token refresh, not a login. Chrome
// runs it with no visible UI and gives up quickly when the provider would need the user.
// A converted extension has only a real tab to work with, and doing it with a FOCUSED tab
// on a 120s ceiling meant every silent refresh stole focus and left a stray tab open long
// after the caller had given up and shown a login screen.
//
// This is the path that keeps a user signed in. A bundle whose tokens live in
// storage.session loses them when Safari tears the background page down, and its recovery
// is exactly this call (prompt=none plus a login_hint).
const polyfill = readFileSync(join(TEMPLATE_DIR, "identity-polyfill.js"), "utf8");

function background() {
  const created = [];
  const removed = [];
  // Safari does not deliver webNavigation events for the auth tab at all (see the
  // poll-only test below), so the tab's own reported URL is modelled separately: a test
  // moves `tab.url` the way a navigation would, and fires events only when it wants to
  // check the paths a browser that DOES report them takes.
  const tab = { id: 99, url: undefined, gone: false };
  const nav = { onBeforeNavigate: [], onCommitted: [], onCompleted: [], onErrorOccurred: [] };
  const ev = (bucket) => ({
    addListener: (f) => nav[bucket].push(f),
    removeListener: (f) => { const i = nav[bucket].indexOf(f); if (i >= 0) nav[bucket].splice(i, 1); },
  });
  const timers = new Set();
  const bg = {
    console: { log() {}, warn() {}, error() {} },
    URL, Promise, Number, Object, Array, JSON, String, Error, Date, Math,
    setTimeout: (f, m) => { const h = setTimeout(f, m); timers.add(h); return h; },
    clearTimeout: (h) => { timers.delete(h); clearTimeout(h); },
    setInterval: (f, m) => { const h = setInterval(f, m); timers.add(h); return h; },
    clearInterval: (h) => { timers.delete(h); clearInterval(h); },
    location: { href: "safari-web-extension://ABC/background.html", pathname: "/background.html" },
    navigator: { userAgent: "test" },
    chrome: {
      runtime: {
        id: "com.viaduct.Test.Extension",
        getURL: (p) => "safari-web-extension://ABC/" + String(p ?? "").replace(/^\//, ""),
        onMessage: { addListener() {} },
        onMessageExternal: { addListener() {}, removeListener() {}, hasListener: () => false },
        lastError: undefined,
      },
      tabs: {
        create(opts, cb) { created.push(opts); cb({ id: tab.id }); },
        get(id, cb) { cb(id === tab.id && !tab.gone ? { id: tab.id, url: tab.url } : undefined); },
        remove(id, cb) { removed.push(id); tab.gone = true; if (cb) cb(); },
        onRemoved: { addListener() {}, removeListener() {} },
        onUpdated: { addListener() {}, removeListener() {} },
      },
      webNavigation: {
        onBeforeNavigate: ev("onBeforeNavigate"),
        onCommitted: ev("onCommitted"),
        onCompleted: ev("onCompleted"),
        onErrorOccurred: ev("onErrorOccurred"),
      },
    },
  };
  bg.self = bg; bg.globalThis = bg;
  vm.createContext(bg);
  vm.runInContext(polyfill, bg, { filename: "identity-polyfill.js" });
  const fire = (bucket, detail) => { for (const f of nav[bucket].slice()) f(detail); };
  const stop = () => { for (const h of timers) { clearTimeout(h); clearInterval(h); } };
  return { bg, created, removed, fire, tab, nav, stop };
}

const AUTH = "https://claude.ai/oauth/authorize?redirect_uri=" +
  encodeURIComponent("https://fcoe.chromiumapp.org/") + "&prompt=none";

test("a silent attempt does not steal focus", async () => {
  const { bg, created, fire } = background();
  const p = bg.chrome.identity.launchWebAuthFlow({ url: AUTH, interactive: false });
  assert.equal(created.length, 1);
  assert.equal(created[0].active, false, "a background tab, not a focus grab");
  fire("onBeforeNavigate", { tabId: 99, frameId: 0, url: "https://fcoe.chromiumapp.org/?code=abc" });
  assert.equal(await p, "https://fcoe.chromiumapp.org/?code=abc");
});

test("an interactive login is still shown to the user", async () => {
  const { bg, created, fire } = background();
  const p = bg.chrome.identity.launchWebAuthFlow({ url: AUTH, interactive: true });
  assert.equal(created[0].active, true);
  fire("onCommitted", { tabId: 99, frameId: 0, url: "https://fcoe.chromiumapp.org/?code=abc" });
  await p;
});

test("a silent attempt that needs the user ends at once, and the tab goes", async () => {
  const { bg, removed, fire } = background();
  const p = bg.chrome.identity.launchWebAuthFlow({ url: AUTH, interactive: false });
  // The provider served a login page instead of redirecting.
  fire("onCompleted", { tabId: 99, frameId: 0, url: "https://claude.ai/login?returnTo=x" });
  await assert.rejects(p, /interaction required/);
  assert.deepEqual(removed, [99], "no stray tab left behind");
});

test("abortOnLoadForNonInteractive:false waits for the caller's deadline instead", async () => {
  const { bg, removed, fire } = background();
  const p = bg.chrome.identity.launchWebAuthFlow({
    url: AUTH, interactive: false, abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 300,
  });
  fire("onCompleted", { tabId: 99, frameId: 0, url: "https://claude.ai/login?returnTo=x" });
  // Still waiting: a provider that redirects late is allowed to.
  assert.deepEqual(removed, []);
  await assert.rejects(p, /no silent redirect/);
  assert.deepEqual(removed, [99]);
});

test("a silent attempt never runs to the interactive ceiling", async () => {
  // A dead attempt has to end while the caller is still listening. Callers race these on
  // their own short timers (Claude allows itself 15s), so anything near the 120s
  // interactive ceiling is the same as hanging.
  const { bg } = background();
  const started = Date.now();
  await assert.rejects(
    bg.chrome.identity.launchWebAuthFlow({ url: AUTH, interactive: false, timeoutMsForNonInteractive: 250 }),
    /no silent redirect/
  );
  const took = Date.now() - started;
  assert.ok(took < 12000, `ended in ${took}ms, well inside a caller's patience`);
});

test("a redirect inside a sub-frame cannot complete the flow", async () => {
  const { bg, fire } = background();
  let settled = false;
  const p = bg.chrome.identity.launchWebAuthFlow({ url: AUTH, interactive: false, timeoutMsForNonInteractive: 250 });
  p.then(() => { settled = true; }, () => { settled = true; });
  fire("onBeforeNavigate", { tabId: 99, frameId: 3, url: "https://fcoe.chromiumapp.org/?code=stolen" });
  assert.equal(settled, false, "frameId 0 only");
  await assert.rejects(p, /no silent redirect/);
});

// The caller's non-interactive deadline is meant to bound how long the PROVIDER takes.
// Spending it on tab creation and Safari loading the authorize page cold means a 5s budget
// (Claude's) can be gone before the provider is even asked: the redirect arrives after the
// attempt was abandoned, the caller falls back to an interactive login, and the user sees a
// tab flash past and a login screen for no reason.
test("the caller's window covers the provider, not our tab setup", async () => {
  const { bg, created, fire } = background();
  const p = bg.chrome.identity.launchWebAuthFlow({
    url: AUTH, interactive: false, timeoutMsForNonInteractive: 250,
  });
  assert.equal(created.length, 1);
  // Setup is slower than the caller's whole budget, as a cold tab load can be.
  await new Promise((r) => setTimeout(r, 700));
  // The page reaches the provider only now, and then redirects within the caller's window.
  fire("onCommitted", { tabId: 99, frameId: 0, url: "https://claude.ai/oauth/authorize?prompt=none" });
  fire("onBeforeNavigate", { tabId: 99, frameId: 0, url: "https://fcoe.chromiumapp.org/?code=abc" });
  assert.equal(await p, "https://fcoe.chromiumapp.org/?code=abc", "not abandoned during setup");
});

test("a provider that never redirects still ends on the caller's clock", async () => {
  const { bg, removed, fire } = background();
  const started = Date.now();
  const p = bg.chrome.identity.launchWebAuthFlow({
    url: AUTH, interactive: false, abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 300,
  });
  fire("onCommitted", { tabId: 99, frameId: 0, url: "https://claude.ai/oauth/authorize?prompt=none" });
  await assert.rejects(p, /no silent redirect/);
  const took = Date.now() - started;
  assert.ok(took >= 250, `waited for the provider (${took}ms)`);
  assert.ok(took < 4000, `but not the setup allowance (${took}ms)`);
  assert.deepEqual(removed, [99]);
});

test("a tab that never navigates is given up on without waiting out the ceiling", async () => {
  const { bg, removed } = background();
  const p = bg.chrome.identity.launchWebAuthFlow({ url: AUTH, interactive: false, timeoutMsForNonInteractive: 100 });
  await assert.rejects(p, /tab never navigated/);
  assert.deepEqual(removed, [99], "and the tab is closed");
});

// The bug this file's harness now models. Safari delivers NO webNavigation event for the
// auth tab: measured on Safari 18 with the background page provably alive (a 2s heartbeat
// kept ticking through the attempt), every silent flow ended with an empty navigation list
// and "tab never navigated", while Safari's own history showed the authorize page had
// loaded and redirected. For Claude for Chrome — whose tokens live in storage.session and
// whose only recovery is this flow — that meant a login screen on every launch. Asking the
// tab where it is works, so the flow leans on that and treats the events as a fast path.
test("a flow completes on the tab's own URL when no navigation event is delivered", async (t) => {
  const { bg, tab, removed, stop } = background();
  t.after(stop);
  const p = bg.chrome.identity.launchWebAuthFlow({
    url: AUTH, interactive: false, abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 3000,
  });
  tab.url = "https://claude.ai/oauth/authorize?prompt=none";   // page loaded, no event
  await new Promise((r) => setTimeout(r, 400));
  tab.url = "https://fcoe.chromiumapp.org/?code=abc";          // redirected, no event
  assert.equal(await p, "https://fcoe.chromiumapp.org/?code=abc");
  assert.deepEqual(removed, [99], "and the tab it opened is closed again");
});

test("the tab's reported URL cannot smuggle in a look-alike callback", async (t) => {
  const { bg, tab, stop } = background();
  t.after(stop);
  const p = bg.chrome.identity.launchWebAuthFlow({
    url: AUTH, interactive: false, abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 400,
  });
  tab.url = "https://fcoe.chromiumapp.org.evil.test/?code=stolen";
  await assert.rejects(p, /no silent redirect/, "prefix alone is not the redirect target");
});

// Safari only delivers webNavigation to listeners the background page registered while it
// was evaluating; one added later, when a flow opens its tab, receives nothing. So the
// observers are installed at load and routed per tab, and a flow adds none of its own.
test("navigation observers are registered at load, not per flow", async (t) => {
  const { bg, nav, tab, stop } = background();
  t.after(stop);
  const atLoad = Object.keys(nav).map((k) => nav[k].length);
  assert.ok(atLoad.every((n) => n === 1), `one observer per event at load, got ${atLoad}`);
  const p = bg.chrome.identity.launchWebAuthFlow({
    url: AUTH, interactive: false, abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 3000,
  });
  assert.deepEqual(Object.keys(nav).map((k) => nav[k].length), atLoad, "a flow adds no listeners");
  tab.url = "https://fcoe.chromiumapp.org/?code=abc";
  await p;
  assert.deepEqual(Object.keys(nav).map((k) => nav[k].length), atLoad, "and removes none");
});

test("a delivered navigation event still completes the flow at once", async (t) => {
  // The events are a fast path where a browser does report them: no waiting on a poll.
  const { bg, fire, stop } = background();
  t.after(stop);
  const p = bg.chrome.identity.launchWebAuthFlow({ url: AUTH, interactive: false });
  fire("onErrorOccurred", { tabId: 99, frameId: 0, url: "https://fcoe.chromiumapp.org/?code=abc" });
  assert.equal(await p, "https://fcoe.chromiumapp.org/?code=abc", "a dead redirect host still carries the code");
});
