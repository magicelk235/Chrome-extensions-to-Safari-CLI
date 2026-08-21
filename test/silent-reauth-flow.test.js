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
  const nav = { onBeforeNavigate: [], onCommitted: [], onCompleted: [], onErrorOccurred: [] };
  const ev = (bucket) => ({
    addListener: (f) => nav[bucket].push(f),
    removeListener: (f) => { const i = nav[bucket].indexOf(f); if (i >= 0) nav[bucket].splice(i, 1); },
  });
  const bg = {
    console: { log() {}, warn() {}, error() {} },
    URL, Promise, setTimeout, clearTimeout, Number, Object, JSON, String, Error, Date,
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
        create(opts, cb) { created.push(opts); cb({ id: 99 }); },
        remove(id, cb) { removed.push(id); if (cb) cb(); },
        onRemoved: { addListener() {}, removeListener() {} },
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
  return { bg, created, removed, fire };
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
