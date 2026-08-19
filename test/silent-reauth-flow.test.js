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

test("the silent deadline is the caller's, not the interactive ceiling", async () => {
  const { bg } = background();
  const started = Date.now();
  await assert.rejects(
    bg.chrome.identity.launchWebAuthFlow({ url: AUTH, interactive: false, timeoutMsForNonInteractive: 250 }),
    /no silent redirect/
  );
  assert.ok(Date.now() - started < 3000, "gave up on the caller's clock");
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
