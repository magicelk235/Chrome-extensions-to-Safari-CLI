import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Chrome keeps storage.session in the browser: one map for every extension context, and
// it outlives a worker restart. Safari gives each context its own space, which breaks the
// ordinary MV3 pattern of state the background owns and a panel reads:
//
//   const r = await chrome.runtime.sendMessage({type:"check_and_refresh_oauth"});
//   if (r?.isValid) return chrome.storage.session.get("accessToken");   // in the panel
//
// The background answers "valid", the panel reads its own empty space, and the user gets
// a login screen. Live on Claude for Chrome, which moves its OAuth tokens into session
// storage on purpose so they never reach disk. The background page stays the owner and
// every other context forwards to it, which buys Chrome's sharing without persisting
// anything the extension kept out of storage.local.

/** One extension context. `page` picks background.html vs any other extension page. */
function context(page, wiring, shared) {
  const timers = new Set();
  const own = Object.create(null);   // this context's private native session space
  const changeListeners = [];
  shared.onChanged.push((changes) => { for (const f of changeListeners.slice()) f(changes, "local"); });
  const readLocal = (keys) => {
    if (keys == null) return { ...shared.local };
    const out = {};
    for (const k of [].concat(keys)) if (k in shared.local) out[k] = shared.local[k];
    return out;
  };
  const area = {
    get(keys, cb) { const v = readLocal(typeof keys === "function" ? null : keys); if (typeof keys === "function") keys(v); else if (cb) cb(v); return Promise.resolve(v); },
    set(items, cb) {
      const changes = {};
      for (const k of Object.keys(items)) { changes[k] = { newValue: items[k] }; shared.local[k] = items[k]; }
      if (cb) cb();
      for (const f of shared.onChanged.slice()) f(changes);
      return Promise.resolve();
    },
    remove(keys, cb) { for (const k of [].concat(keys)) delete shared.local[k]; if (cb) cb(); return Promise.resolve(); },
  };
  const pick = (keys) => {
    if (keys == null) return { ...own };
    const out = {};
    for (const k of [].concat(keys)) if (k in own) out[k] = own[k];
    return out;
  };
  const session = {
    get(keys, cb) { const v = pick(typeof keys === "function" ? null : keys); if (typeof keys === "function") keys(v); else if (cb) cb(v); return Promise.resolve(v); },
    set(items, cb) { Object.assign(own, items); if (cb) cb(); return Promise.resolve(); },
    remove(keys, cb) { for (const k of [].concat(keys)) delete own[k]; if (cb) cb(); return Promise.resolve(); },
    clear(cb) { for (const k of Object.keys(own)) delete own[k]; if (cb) cb(); return Promise.resolve(); },
    setAccessLevel(_o, cb) { if (cb) cb(); return Promise.resolve(); },
  };
  const listeners = [];
  const chrome = {
    runtime: {
      id: "com.viaduct.Test.Extension",
      lastError: null,
      getURL: (p) => "safari-web-extension://ABC/" + String(p ?? "").replace(/^\//, ""),
      getManifest: () => ({ manifest_version: 3 }),
      sendMessage: (msg, cb) => wiring.send(msg, cb),
      connect: () => ({ name: "", onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {}, disconnect() {} }),
      onMessage: { addListener: (f) => listeners.push(f), removeListener() {}, hasListener: () => false },
      onConnect: { addListener() {}, removeListener() {}, hasListener: () => false },
    },
    storage: { local: area, sync: area, session, onChanged: { addListener: (f) => changeListeners.push(f), removeListener(f) { const i = changeListeners.indexOf(f); if (i >= 0) changeListeners.splice(i, 1); } } },
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
    location: { href: "safari-web-extension://ABC/" + page, protocol: "safari-web-extension:", pathname: "/" + page, search: "", origin: "safari-web-extension://abc" },
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
  return { sandbox, chrome, own, listeners, dispose: () => { for (const h of timers) { clearTimeout(h); clearInterval(h); } } };
}

/** A background page and a panel, with runtime messaging wired between them. */
function extension({ deliver = true } = {}) {
  const wiring = { send: () => Promise.resolve(undefined) };
  const shared = { local: Object.create(null), onChanged: [] };
  const bg = context("background.html", wiring, shared);
  const panel = context("sidepanel.html", wiring, shared);
  wiring.send = (msg, cb) => {
    const p = new Promise((resolve) => {
      if (!deliver) return;                       // background unreachable
      let answered = false;
      const respond = (r) => { if (!answered) { answered = true; resolve(r); } };
      for (const l of bg.listeners) {
        const ret = l(msg, { url: "safari-web-extension://ABC/sidepanel.html" }, respond);
        if (ret && typeof ret.then === "function") ret.then(respond);
      }
    });
    if (typeof cb === "function") { p.then((v) => cb(v)); return undefined; }
    return p;
  };
  return { bg, panel, dispose: () => { bg.dispose(); panel.dispose(); } };
}

test("a panel reads what the background wrote", async (t) => {
  const { bg, panel, dispose } = extension();
  t.after(dispose);
  await bg.chrome.storage.session.set({ accessToken: "tok-123", tokenExpiry: 999 });
  const got = await panel.chrome.storage.session.get(["accessToken", "tokenExpiry"]);
  assert.deepEqual(JSON.parse(JSON.stringify(got)), { accessToken: "tok-123", tokenExpiry: 999 });
});

test("a panel's write is visible to the background", async (t) => {
  const { bg, panel, dispose } = extension();
  t.after(dispose);
  await panel.chrome.storage.session.set({ from: "panel" });
  const got = await bg.chrome.storage.session.get("from");
  assert.deepEqual(JSON.parse(JSON.stringify(got)), { from: "panel" });
  assert.equal(panel.own.from, undefined, "the panel's own space stays empty; one owner");
});

test("remove and clear go to the owner too", async (t) => {
  const { bg, panel, dispose } = extension();
  t.after(dispose);
  await bg.chrome.storage.session.set({ a: 1, b: 2 });
  await panel.chrome.storage.session.remove("a");
  // Scoped to these keys: the owner store also holds the shim's own panel-open
  // bookkeeping, which is legitimately there.
  const after = await bg.chrome.storage.session.get(["a", "b"]);
  assert.deepEqual(JSON.parse(JSON.stringify(after)), { b: 2 });
  await panel.chrome.storage.session.clear();
  const cleared = await bg.chrome.storage.session.get(["a", "b"]);
  assert.deepEqual(JSON.parse(JSON.stringify(cleared)), {});
});

test("the callback form is honored", async (t) => {
  const { bg, panel, dispose } = extension();
  t.after(dispose);
  await bg.chrome.storage.session.set({ k: "v" });
  const got = await new Promise((r) => panel.chrome.storage.session.get("k", r));
  assert.deepEqual(JSON.parse(JSON.stringify(got)), { k: "v" });
});

test("an unreachable owner degrades to this context's own space", async (t) => {
  // Never worse than the behavior this replaces: if the background cannot be reached,
  // a context still reads and writes something rather than nothing.
  const { panel, dispose } = extension({ deliver: false });
  t.after(dispose);
  await panel.chrome.storage.session.set({ solo: 1 });
  const got = await panel.chrome.storage.session.get("solo");
  assert.deepEqual(JSON.parse(JSON.stringify(got)), { solo: 1 });
});

test("the background keeps using the native store, not a proxy of itself", async (t) => {
  const { bg, dispose } = extension();
  t.after(dispose);
  await bg.chrome.storage.session.set({ x: 7 });
  assert.equal(bg.own.x, 7, "written straight through, no self-message");
});
