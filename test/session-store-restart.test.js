import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Chrome keeps storage.session for the life of the BROWSER session: a service worker that
// restarts reads back everything it put there, which is why an extension is willing to
// keep live state — Claude for Chrome keeps its OAuth tokens there on purpose, to keep
// them off disk. Safari hands every PAGE LOAD its own session store, so a converted
// background comes back empty. Measured on Safari 18: seconds after one background page
// stored a valid token, the next one read none, so every wake answered the panel with a
// login screen and opened another silent re-auth tab.
//
// The shim mirrors the owner's session store into storage.local and restores it when the
// background comes back. The mirror is stamped and expires, which bounds how long values
// the extension kept out of storage.local sit there; past the deadline the extension takes
// its own recovery path. Safari never fires runtime.onStartup for a converted background
// (measured), so a deadline is the only signal available.

const MIRROR = "__c2sSessMirror";

/** One background page load. `disk` is storage.local, shared across loads like the file is. */
function backgroundPage(disk) {
  const timers = new Set();
  const own = Object.create(null);      // this page load's private native session space
  const pick = (keys, from) => {
    if (keys == null) return { ...from };
    const out = {};
    for (const k of [].concat(keys)) if (k in from) out[k] = from[k];
    return out;
  };
  const areaOver = (store) => ({
    get(keys, cb) {
      const v = pick(typeof keys === "function" ? null : keys, store);
      if (typeof keys === "function") keys(v); else if (cb) cb(v);
      return Promise.resolve(v);
    },
    set(items, cb) { Object.assign(store, items); if (cb) cb(); return Promise.resolve(); },
    remove(keys, cb) { for (const k of [].concat(keys)) delete store[k]; if (cb) cb(); return Promise.resolve(); },
    clear(cb) { for (const k of Object.keys(store)) delete store[k]; if (cb) cb(); return Promise.resolve(); },
    setAccessLevel(_o, cb) { if (cb) cb(); return Promise.resolve(); },
  });
  const local = areaOver(disk);
  const session = areaOver(own);
  const chrome = {
    runtime: {
      id: "com.viaduct.Test.Extension",
      lastError: null,
      getURL: (p) => "safari-web-extension://ABC/" + String(p ?? "").replace(/^\//, ""),
      getManifest: () => ({ manifest_version: 3 }),
      sendMessage: () => Promise.resolve(undefined),
      connect: () => ({ name: "", onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {}, disconnect() {} }),
      onMessage: { addListener() {}, removeListener() {}, hasListener: () => false },
      onConnect: { addListener() {}, removeListener() {}, hasListener: () => false },
    },
    storage: { local, sync: local, session, onChanged: { addListener() {}, removeListener() {} } },
    tabs: { query: () => Promise.resolve([]), onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, onActivated: { addListener() {} } },
    windows: { onFocusChanged: { addListener() {} }, getAll: () => Promise.resolve([]) },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const sandbox = {
    chrome, browser: chrome, console: { log() {}, warn() {}, error() {}, debug() {} },
    Promise, JSON, Object, Array, Error, Date, Math, String, Number, Boolean, URL, Symbol,
    Proxy, Reflect, Map, Set, WeakMap, WeakSet, RegExp, TypeError, isNaN, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent, Uint8Array, ArrayBuffer, MessageChannel,
    MessageEvent: class { constructor(t, i) { Object.assign(this, { type: t }, i); } },
    location: { href: "safari-web-extension://ABC/background.html", protocol: "safari-web-extension:", pathname: "/background.html", search: "", origin: "safari-web-extension://abc" },
    history: { pushState() {}, replaceState() {} },
    navigator: { userAgent: "Safari" },
    addEventListener() {}, removeEventListener() {},
    document: { addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {} }), body: { appendChild() {} }, documentElement: {}, readyState: "complete" },
    setTimeout: (f, m) => { const h = setTimeout(f, m); timers.add(h); return h; },
    clearTimeout: (h) => { timers.delete(h); clearTimeout(h); },
    setInterval: (f, m) => { const h = setInterval(f, m); timers.add(h); return h; },
    clearInterval: (h) => { timers.delete(h); clearInterval(h); },
    fetch: () => Promise.reject(new Error("no net")),
    XMLHttpRequest: class { open() {} send() {} setRequestHeader() {} addEventListener() {} },
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource({ origin: "chrome-extension://abcdef", hosts: [] }), sandbox, { filename: "safari-compat-shim.js" });
  return { chrome, own, dispose: () => { for (const h of timers) { clearTimeout(h); clearInterval(h); } } };
}

test("what the background stored is there after it restarts", async (t) => {
  const disk = Object.create(null);
  const first = backgroundPage(disk);
  t.after(first.dispose);
  await first.chrome.storage.session.set({ accessToken: "tok-123", tokenExpiry: 42 });

  const second = backgroundPage(disk);          // Safari tore the page down and brought it back
  t.after(second.dispose);
  assert.ok(disk[MIRROR], "the previous page left the session on disk to come back to");
  const got = await second.chrome.storage.session.get(["accessToken", "tokenExpiry"]);
  assert.deepEqual(JSON.parse(JSON.stringify(got)), { accessToken: "tok-123", tokenExpiry: 42 });
});

test("a read that beats the restore is answered from the restore, not the empty store", async (t) => {
  const disk = Object.create(null);
  disk[MIRROR] = { t: Date.now(), v: { accessToken: "tok-early" } };
  const page = backgroundPage(disk);
  t.after(page.dispose);
  // No await in between: this is the bundle asking for its token as the page evaluates.
  const got = await page.chrome.storage.session.get("accessToken");
  assert.deepEqual(JSON.parse(JSON.stringify(got)), { accessToken: "tok-early" });
});

test("the callback form is answered too", async (t) => {
  const disk = Object.create(null);
  disk[MIRROR] = { t: Date.now(), v: { accessToken: "tok-cb" } };
  const page = backgroundPage(disk);
  t.after(page.dispose);
  const got = await new Promise((r) => page.chrome.storage.session.get("accessToken", r));
  assert.deepEqual(JSON.parse(JSON.stringify(got)), { accessToken: "tok-cb" });
});

test("removing and clearing take the mirror with them", async (t) => {
  const disk = Object.create(null);
  const first = backgroundPage(disk);
  t.after(first.dispose);
  await first.chrome.storage.session.set({ a: 1, b: 2 });
  await first.chrome.storage.session.remove("a");

  const second = backgroundPage(disk);
  t.after(second.dispose);
  assert.deepEqual(JSON.parse(JSON.stringify(await second.chrome.storage.session.get(["a", "b"]))), { b: 2 });
  await second.chrome.storage.session.clear();

  const third = backgroundPage(disk);
  t.after(third.dispose);
  assert.deepEqual(JSON.parse(JSON.stringify(await third.chrome.storage.session.get(["a", "b"]))), {});
});

test("a stale mirror is ignored and dropped", async (t) => {
  const disk = Object.create(null);
  // Older than the deadline: the extension gets the empty store Chrome would give it at
  // the start of a browser session, and takes its own recovery path from there.
  disk[MIRROR] = { t: Date.now() - 13 * 60 * 60 * 1000, v: { accessToken: "expired" } };
  const page = backgroundPage(disk);
  t.after(page.dispose);
  const got = await page.chrome.storage.session.get("accessToken");
  assert.deepEqual(JSON.parse(JSON.stringify(got)), {});
  assert.equal(disk[MIRROR], undefined, "and it does not sit on disk any longer");
});

test("a malformed mirror is not trusted", async (t) => {
  const disk = Object.create(null);
  disk[MIRROR] = { v: { accessToken: "no-stamp" } };     // no timestamp
  const page = backgroundPage(disk);
  t.after(page.dispose);
  assert.deepEqual(JSON.parse(JSON.stringify(await page.chrome.storage.session.get("accessToken"))), {});
});

test("the mirror holds only what session storage was given", async (t) => {
  const disk = Object.create(null);
  const page = backgroundPage(disk);
  t.after(page.dispose);
  await page.chrome.storage.session.set({ accessToken: "tok" });
  await page.chrome.storage.local.set({ accountUuid: "uuid" });
  assert.deepEqual(Object.keys(disk[MIRROR].v), ["accessToken"], "storage.local's own keys stay out of it");
});
