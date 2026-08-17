import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// cookies.get has to return the cookie the request will actually carry. Two cookies can
// share a name on nested domains — LinkedIn's real JSESSIONID sits on `.www.linkedin.com`,
// and Kondo mints a fallback one on `.linkedin.com` when it finds no session. Safari then
// answers get({name:"JSESSIONID", url:"https://www.linkedin.com/"}) with the APEX cookie
// while the network stack sends the host one first, so the Csrf-Token header contradicts
// the Cookie header on every request and LinkedIn answers 403 "CSRF check failed".

const REAL = { name: "JSESSIONID", domain: ".www.linkedin.com", path: "/", value: "ajax:-5864878726027283640" };
const MINTED = { name: "JSESSIONID", domain: ".linkedin.com", path: "/", value: "ajax:69910599375289214683" };

function runShim({ getAllResult, getResult, getAllPromise = true }) {
  const timers = new Set();
  const calls = { get: [], getAll: [] };
  const area = {
    get: (_k, cb) => { if (typeof cb === "function") cb({}); return Promise.resolve({}); },
    set: (_o, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
    remove: (_k, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
  };
  const cookies = {
    // Safari's cookies API is promise-based and its get answers with the apex cookie.
    get(details, cb) {
      calls.get.push(details);
      const r = typeof getResult === "function" ? getResult(details) : getResult;
      if (typeof cb === "function") { cb(r); return undefined; }
      return Promise.resolve(r);
    },
    getAll(details, cb) {
      calls.getAll.push(details);
      const r = typeof getAllResult === "function" ? getAllResult(details) : getAllResult;
      if (typeof cb === "function") { cb(r); return undefined; }
      return getAllPromise ? Promise.resolve(r) : r;
    },
    set: () => Promise.resolve(null),
    remove: () => Promise.resolve(null),
    onChanged: { addListener() {}, removeListener() {}, hasListener: () => false },
  };
  const chrome = {
    runtime: {
      id: "abc",
      lastError: null,
      getURL: (p) => "safari-web-extension://abc" + (p.startsWith("/") ? p : "/" + p),
      getManifest: () => ({ manifest_version: 3, permissions: ["cookies"] }),
      sendMessage: () => Promise.resolve(),
      connect: () => ({ name: "", postMessage() {}, disconnect() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }),
      onMessage: { addListener() {}, removeListener() {}, hasListener: () => false },
      onConnect: { addListener() {}, removeListener() {}, hasListener: () => false },
    },
    cookies,
    storage: { local: area, sync: area, session: area, onChanged: { addListener() {}, removeListener() {} } },
    tabs: { query: (_q, cb) => { const r = []; if (typeof cb === "function") cb(r); return Promise.resolve(r); }, onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const sandbox = {
    chrome, browser: chrome, console, Promise, JSON, Object, Array, Error, Date, Math,
    String, Number, Boolean, URL, URLSearchParams, Symbol, Proxy, Reflect, Map, Set,
    WeakMap, RegExp, TypeError, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    location: {
      href: "safari-web-extension://abc/background.html",
      protocol: "safari-web-extension:",
      origin: "safari-web-extension://abc",
      pathname: "/background.html",
      search: "",
    },
    navigator: { userAgent: "Safari" },
    history: { state: null, pushState() {}, replaceState() {} },
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    document: { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" },
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
  return { sandbox, calls, dispose };
}

test("the host cookie wins over a parent-domain cookie of the same name", async (t) => {
  const { sandbox, dispose } = runShim({ getAllResult: [MINTED, REAL], getResult: MINTED });
  t.after(dispose);

  const c = await sandbox.chrome.cookies.get({ name: "JSESSIONID", url: "https://www.linkedin.com/" });
  assert.equal(c.domain, ".www.linkedin.com", "the request sends this one first, so the read must agree");
  assert.equal(c.value, REAL.value);
});

test("a longer path outranks a more specific domain, as the server orders them", async (t) => {
  const deepPath = { name: "sid", domain: ".linkedin.com", path: "/voyager/api", value: "deep" };
  const shallowHost = { name: "sid", domain: "www.linkedin.com", path: "/", value: "shallow" };
  const { sandbox, dispose } = runShim({ getAllResult: [shallowHost, deepPath], getResult: shallowHost });
  t.after(dispose);

  const c = await sandbox.chrome.cookies.get({ name: "sid", url: "https://www.linkedin.com/voyager/api/me" });
  assert.equal(c.value, "deep");
});

test("the callback form is honored", async (t) => {
  const { sandbox, dispose } = runShim({ getAllResult: [MINTED, REAL], getResult: MINTED });
  t.after(dispose);

  const got = await new Promise((resolve) => {
    sandbox.chrome.cookies.get({ name: "JSESSIONID", url: "https://www.linkedin.com/" }, resolve);
  });
  assert.equal(got.domain, ".www.linkedin.com");
});

test("a single candidate falls through to the native get", async (t) => {
  const { sandbox, calls, dispose } = runShim({ getAllResult: [REAL], getResult: REAL });
  t.after(dispose);

  const c = await sandbox.chrome.cookies.get({ name: "JSESSIONID", url: "https://www.linkedin.com/" });
  assert.equal(c.value, REAL.value);
  assert.equal(calls.get.length, 1, "nothing to disambiguate — the platform answers");
});

test("no candidates leaves the native answer (and its null) alone", async (t) => {
  const { sandbox, dispose } = runShim({ getAllResult: [], getResult: null });
  t.after(dispose);

  assert.equal(await sandbox.chrome.cookies.get({ name: "JSESSIONID", url: "https://www.linkedin.com/" }), null);
});

test("a get without a url or name is passed straight through", async (t) => {
  const { sandbox, calls, dispose } = runShim({ getAllResult: [MINTED, REAL], getResult: MINTED });
  t.after(dispose);

  await sandbox.chrome.cookies.get({ name: "JSESSIONID" });
  assert.equal(calls.getAll.length, 0, "an incomplete query is the platform's to reject");
  assert.equal(calls.get.length, 1);
});

test("a callback-only getAll host is left on the native path", async (t) => {
  const { sandbox, calls, dispose } = runShim({ getAllResult: [MINTED, REAL], getResult: MINTED, getAllPromise: false });
  t.after(dispose);

  const c = await sandbox.chrome.cookies.get({ name: "JSESSIONID", url: "https://www.linkedin.com/" });
  assert.equal(c.value, MINTED.value, "no promise to await → don't invent one");
  assert.equal(calls.get.length, 1);
});
