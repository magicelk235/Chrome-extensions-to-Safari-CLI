import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// A site decides who may embed it and the list is written for Chrome: claude.ai serves its
// side-panel URL with `frame-ancestors 'self' chrome-extension://<their id> …`, and a
// converted extension page is safari-web-extension://<per-install UUID>, which cannot be
// on that list. Safari computes the ancestor chain itself, so nothing on this side reaches
// the check, and the user just gets a blank panel plus one WebKit console line in a context
// most people never open.
//
// The shim says so in the frame instead. A blocked frame stays on its inherited
// about:blank, which is same-origin and therefore writable; a frame that really loaded
// cross-origin reports contentDocument null, which is what keeps a working frame safe.

function extensionPage() {
  const timers = new Set();
  const errors = [];
  const observers = [];
  const area = {
    get: (_k, cb) => { if (cb) cb({}); return Promise.resolve({}); },
    set: (_o, cb) => { if (cb) cb(); return Promise.resolve(); },
    remove: (_k, cb) => { if (cb) cb(); return Promise.resolve(); },
  };
  const runtime = {
    id: "com.viaduct.Test.Extension",
    lastError: null,
    getURL: (p) => "safari-web-extension://ABC-DEF/" + String(p ?? "").replace(/^\//, ""),
    getManifest: () => ({ manifest_version: 3 }),
    sendMessage: () => Promise.resolve(),
    connect: () => ({ name: "", onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {}, disconnect() {} }),
    onMessage: { addListener() {}, removeListener() {}, hasListener: () => false },
    onConnect: { addListener() {}, removeListener() {}, hasListener: () => false },
  };
  const mkArea = () => ({
    get: (_k, cb) => { if (typeof cb === "function") cb({}); return Promise.resolve({}); },
    set: (_o, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
    remove: (_k, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
    clear: (cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
  });
  const chrome = {
    runtime,
    storage: { local: mkArea(), sync: mkArea(), session: mkArea(), onChanged: { addListener() {}, removeListener() {} } },
    tabs: { query: () => Promise.resolve([]), onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, onActivated: { addListener() {} } },
    windows: { onFocusChanged: { addListener() {} }, getAll: () => Promise.resolve([]) },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const el = (tag) => ({
    tagName: String(tag).toUpperCase(), nodeType: 1, style: {}, childNodes: [],
    attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
    appendChild(n) { this.childNodes.push(n); return n; },
    addEventListener() {}, querySelectorAll: () => [],
  });
  const sandbox = {
    chrome, browser: chrome,
    console: { log() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.join(" ")) },
    Promise, JSON, Object, Array, Error, Date, Math, String, Number, Boolean, URL, Symbol,
    Proxy, Reflect, Map, Set, WeakMap, WeakSet, RegExp, TypeError, isNaN, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent, Uint8Array, ArrayBuffer, MessageChannel,
    MessageEvent: class { constructor(t, i) { Object.assign(this, { type: t }, i); } },
    location: { href: "safari-web-extension://ABC-DEF/sidepanel.html", protocol: "safari-web-extension:", pathname: "/sidepanel.html", search: "", origin: "safari-web-extension://abc-def" },
    history: { pushState() {}, replaceState() {} },
    navigator: { userAgent: "Safari" },
    addEventListener() {}, removeEventListener() {},
    setTimeout: (f, m) => { const h = setTimeout(f, m); timers.add(h); return h; },
    clearTimeout: (h) => { timers.delete(h); clearTimeout(h); },
    setInterval: (f, m) => { const h = setInterval(f, m); timers.add(h); return h; },
    clearInterval: (h) => { timers.delete(h); clearInterval(h); },
    fetch: () => Promise.resolve({ headers: { get: () => "frame-ancestors 'self' chrome-extension://abcdef" }, body: { cancel() {} } }),
    MutationObserver: class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe() {} disconnect() {}
    },
  };
  sandbox.document = {
    documentElement: el("html"),
    body: el("body"),
    createElement: el,
    addEventListener() {}, removeEventListener() {},
    querySelectorAll: () => [],
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource({ origin: "chrome-extension://abcdef", hosts: [] }), sandbox, { filename: "safari-compat-shim.js" });
  const add = (frame) => { for (const o of observers) o.cb([{ addedNodes: [frame] }]); };
  return { sandbox, errors, add, el, dispose: () => { for (const h of timers) { clearTimeout(h); clearInterval(h); } } };
}

/** A frame Safari refused: still on its inherited, writable about:blank. */
const blockedFrame = (el, src) => {
  const doc = el("document");
  doc.URL = "about:blank";
  doc.body = el("body");
  doc.createElement = el;
  return { tagName: "IFRAME", nodeType: 1, src, getAttribute: () => src, contentDocument: doc, _doc: doc };
};

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test("a refused cross-origin frame gets the reason written into it", async (t) => {
  const { errors, add, el, dispose } = extensionPage();
  t.after(dispose);
  const frame = blockedFrame(el, "https://claude.ai/cic/new?surface=cic_sidepanel");
  add(frame);
  await settle(2800);
  assert.equal(frame._doc.body.childNodes.length, 1, "an explanation in the blank frame");
  assert.match(frame._doc.body.childNodes[0].textContent, /claude\.ai/);
  assert.match(frame._doc.body.childNodes[0].textContent, /Content-Security-Policy/);
  const log = errors.join(" | ");
  assert.match(log, /frame-ancestors/);
  assert.match(log, /claude\.ai/);
  assert.match(log, /non-embedded mode/, "point at the way out");
});

test("a frame that really loaded is never touched", async (t) => {
  const { add, dispose } = extensionPage();
  t.after(dispose);
  // A loaded cross-origin document is unreachable: contentDocument is null.
  const frame = { tagName: "IFRAME", nodeType: 1, src: "https://claude.ai/cic/new", getAttribute: () => "https://claude.ai/cic/new", contentDocument: null };
  add(frame);
  await settle(2800);
  assert.equal(frame.contentDocument, null, "nothing written, nothing replaced");
});

test("a frame with content in it is left alone", async (t) => {
  const { add, el, dispose } = extensionPage();
  t.after(dispose);
  const frame = blockedFrame(el, "https://example.com/panel");
  frame._doc.body.childNodes.push({ tagName: "DIV" });   // it rendered something
  add(frame);
  await settle(2800);
  assert.equal(frame._doc.body.childNodes.length, 1, "no explanation appended over real content");
});

test("an extension-resource frame is not our business", async (t) => {
  const { errors, add, el, dispose } = extensionPage();
  t.after(dispose);
  const frame = blockedFrame(el, "safari-web-extension://ABC-DEF/offscreen.html");
  add(frame);
  await settle(2800);
  assert.equal(frame._doc.body.childNodes.length, 0);
  assert.deepEqual(errors, []);
});
