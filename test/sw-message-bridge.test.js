import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// An extension page reaches an MV3 background through navigator.serviceWorker on
// Chrome, and the documented web-page ↔ background channel is built on it:
//
//   (await navigator.serviceWorker.ready).active.postMessage(msg, [...ev.ports])
//
// Kondo's app.trykondo.com bridge is exactly that, and it is the extension's only
// channel. A converted extension has no service-worker registration for its origin
// (measured in Safari: getRegistrations() → [], controller null, `ready` pending
// forever), so the await never returns and the bridge dies with no error. The shim
// emulates the surface in extension pages and tunnels postMessage — transferred
// MessagePorts included — over a runtime port to the background page, which replays
// it as a `message` event carrying real MessagePorts.

// Minimal MessagePort/MessageChannel/MessageEvent doubles. Node's own are close
// enough to work but drag in worker_threads serialization; these keep the test to
// the contract the shim actually uses.
function makePortPair() {
  const mk = () => ({ onmessage: null, closed: false, _peer: null, sent: [],
    postMessage(data) {
      this.sent.push(data);
      const peer = this._peer;
      if (!peer || peer.closed) return;
      setTimeout(() => { if (typeof peer.onmessage === "function") peer.onmessage({ data }); }, 0);
    },
    close() { this.closed = true; },
    start() {},
    addEventListener() {}, removeEventListener() {},
  });
  const a = mk(), b = mk();
  a._peer = b; b._peer = a;
  return [a, b];
}

class FakeMessageEvent {
  constructor(type, init) {
    this.type = type;
    this.data = init && init.data;
    this.origin = (init && init.origin) || "";
    this.ports = (init && init.ports) || [];
  }
}

// A runtime Port double: records what the shim sends, lets the test push messages in.
function makeRuntimePort(name) {
  const msgL = [], discL = [];
  return {
    name,
    sent: [],
    postMessage(m) { this.sent.push(m); },
    disconnect() { for (const f of discL.slice()) f(); },
    onMessage: { addListener: (f) => msgL.push(f), removeListener() {}, hasListener: () => false },
    onDisconnect: { addListener: (f) => discL.push(f), removeListener() {}, hasListener: () => false },
    _deliver(m) { for (const f of msgL.slice()) f(m); },
  };
}

function runShim(href, { manifest = { manifest_version: 3 }, serviceWorker } = {}) {
  const timers = new Set();
  const url = new URL(href);
  // new URL() reports origin "null" for an unknown scheme; Safari reports the real one.
  const origin = href.slice(0, href.indexOf("/", href.indexOf("//") + 2));
  const location = { href, protocol: url.protocol, origin, pathname: url.pathname, search: url.search };
  const connects = [];
  const onConnectListeners = [];
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
      connect: (opts) => { const p = makeRuntimePort((opts && opts.name) || ""); connects.push(p); return p; },
      onMessage: { addListener() {}, removeListener() {}, hasListener: () => false },
      onConnect: { addListener: (f) => onConnectListeners.push(f), removeListener() {}, hasListener: () => false },
    },
    storage: { local: area, sync: area, session: area, onChanged: { addListener() {}, removeListener() {} } },
    tabs: {
      query: (_q, cb) => { const r = [{ id: 42, url: "https://example.com/" }]; if (typeof cb === "function") cb(r); return Promise.resolve(r); },
      onUpdated: { addListener() {} }, onRemoved: { addListener() {} },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const selfEvents = [];
  const selfListeners = {};
  const sandbox = {
    chrome, browser: chrome, console, Promise, JSON, Object, Array, Error, Date, Math,
    String, Number, Boolean, URL, URLSearchParams, Symbol, Proxy, Reflect, Map, Set,
    WeakMap, RegExp, TypeError, isNaN, parseInt, parseFloat, encodeURIComponent,
    decodeURIComponent,
    location,
    navigator: { userAgent: "Safari", serviceWorker },
    history: { state: null, pushState() {}, replaceState() {} },
    MessageEvent: FakeMessageEvent,
    MessageChannel: function () { const [a, b] = makePortPair(); this.port1 = a; this.port2 = b; },
    addEventListener(type, fn) { (selfListeners[type] = selfListeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatchEvent(ev) { selfEvents.push(ev); for (const f of (selfListeners[ev.type] || []).slice()) f(ev); return true; },
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
  return { sandbox, connects, onConnectListeners, selfEvents, dispose };
}

// A ServiceWorkerContainer double: no controller, a `ready` that never settles —
// what Safari hands a converted extension page.
function deadContainer() {
  const listeners = [];
  return {
    controller: null,
    ready: new Promise(() => {}),
    register: () => Promise.reject(new Error("unsupported")),
    getRegistration: () => Promise.resolve(undefined),
    getRegistrations: () => Promise.resolve([]),
    addEventListener: (_t, f) => listeners.push(f),
    removeEventListener() {},
    dispatchEvent(ev) { for (const f of listeners.slice()) f(ev); return true; },
    _listeners: listeners,
  };
}

// Objects that crossed the vm realm carry a foreign Object.prototype, so compare shape.
const plain = (v) => JSON.parse(JSON.stringify(v));

const settle = () => new Promise((r) => setTimeout(r, 20));

// Without the emulation `ready` never settles, which is the bug under test — bound the
// wait so that reads as a failed assertion instead of a hung suite.
const readyWithin = (container, ms = 200) =>
  Promise.race([container.ready, new Promise((r) => setTimeout(() => r(null), ms))]);

test("an extension page's navigator.serviceWorker resolves and tunnels a transferred port", async (t) => {
  const serviceWorker = deadContainer();
  const { sandbox, connects, dispose } = runShim("safari-web-extension://abc/ext.html?session=s1", { serviceWorker });
  t.after(dispose);

  const reg = await readyWithin(sandbox.navigator.serviceWorker);
  assert.ok(reg && reg.active, "ready must resolve with an active worker, not hang");
  assert.equal(sandbox.navigator.serviceWorker.controller, reg.active, "controller gates the send in most bundles");

  // The page hands the extension iframe a MessagePort; the bundle forwards it on.
  const [pageEnd, transferred] = makePortPair();
  reg.active.postMessage({ source: "kondo-iframe" }, [transferred]);

  assert.equal(connects.length, 1, "one runtime port carries the bridge");
  assert.equal(connects[0].name, "__c2sSwBridge");
  assert.deepEqual(plain(connects[0].sent), [{
    t: "msg", seq: 1, data: { source: "kondo-iframe" }, pids: ["p1"],
    origin: "safari-web-extension://abc",
  }]);

  // Page → background: what the app writes into its end of the channel.
  pageEnd.postMessage({ ask: "conversations" });
  await settle();
  assert.deepEqual(plain(connects[0].sent[1]), { t: "port", pid: "p1", data: { ask: "conversations" } });

  // Background → page: replies come back down the tunnel and into the same port.
  const got = [];
  pageEnd.onmessage = (ev) => got.push(ev.data);
  connects[0]._deliver({ t: "port", pid: "p1", data: { status: "connected" } });
  await settle();
  assert.deepEqual(plain(got), [{ status: "connected" }], "the reply must land on the app's port");
});

test("event.source.postMessage from the background reaches the page's serviceWorker listeners", async (t) => {
  const serviceWorker = deadContainer();
  const { sandbox, connects, dispose } = runShim("safari-web-extension://abc/ext.html", { serviceWorker });
  t.after(dispose);

  const reg = await readyWithin(sandbox.navigator.serviceWorker);
  assert.ok(reg && reg.active, "ready must resolve with an active worker, not hang");
  reg.active.postMessage({ hello: 1 });
  assert.equal(connects.length, 1);

  const seen = [];
  sandbox.navigator.serviceWorker.addEventListener("message", (ev) => seen.push(ev.data));
  connects[0]._deliver({ t: "client", data: { from: "bg" } });
  assert.deepEqual(plain(seen), [{ from: "bg" }]);
});

test("the background page replays a tunneled message as a message event with real ports", async (t) => {
  const { sandbox, onConnectListeners, selfEvents, dispose } = runShim("safari-web-extension://abc/background.html");
  t.after(dispose);

  assert.ok(onConnectListeners.length > 0, "the background must listen for bridge ports");
  const port = makeRuntimePort("__c2sSwBridge");
  for (const f of onConnectListeners) f(port);

  const delivered = [];
  sandbox.addEventListener("message", (ev) => delivered.push(ev));
  port._deliver({ t: "msg", seq: 1, data: { source: "kondo-iframe" }, pids: ["p1"], origin: "safari-web-extension://abc" });

  assert.equal(delivered.length, 1, "one message event per tunneled postMessage");
  const ev = delivered[0];
  assert.deepEqual(plain(ev.data), { source: "kondo-iframe" });
  assert.equal(ev.ports.length, 1, "the bundle reads its channel out of event.ports");
  assert.equal(typeof ev.waitUntil, "function", "SW handlers call waitUntil unconditionally");
  assert.equal(typeof ev.source.postMessage, "function", "and answer on event.source");

  // What the background writes into the port must come back out of the tunnel.
  ev.ports[0].postMessage({ status: "connected" });
  await settle();
  assert.deepEqual(plain(port.sent), [{ t: "port", pid: "p1", data: { status: "connected" } }]);

  ev.source.postMessage({ from: "bg" });
  assert.deepEqual(plain(port.sent[1]), { t: "client", data: { from: "bg" } });

  // Page → background traffic reaches the same port pair.
  const inbound = [];
  ev.ports[0].onmessage = (m) => inbound.push(m.data);
  port._deliver({ t: "port", pid: "p1", data: { ask: "conversations" } });
  await settle();
  assert.deepEqual(plain(inbound), [{ ask: "conversations" }]);
});

test("a replayed send is delivered once — the connect proxy re-flushes its queue", async (t) => {
  const { sandbox, onConnectListeners, dispose } = runShim("safari-web-extension://abc/background.html");
  t.after(dispose);

  const port = makeRuntimePort("__c2sSwBridge");
  for (const f of onConnectListeners) f(port);
  const delivered = [];
  sandbox.addEventListener("message", (ev) => delivered.push(ev));

  const msg = { t: "msg", seq: 1, data: { source: "kondo-iframe" }, pids: ["p1"] };
  port._deliver(msg);
  port._deliver(msg);
  port._deliver({ t: "msg", seq: 2, data: { second: true }, pids: [] });

  assert.deepEqual(plain(delivered.map((e) => e.data)), [{ source: "kondo-iframe" }, { second: true }]);
});

test("a port with another name is left to the extension", async (t) => {
  const { sandbox, onConnectListeners, dispose } = runShim("safari-web-extension://abc/background.html");
  t.after(dispose);

  const port = makeRuntimePort("kondo-content");
  for (const f of onConnectListeners) f(port);
  const delivered = [];
  sandbox.addEventListener("message", (ev) => delivered.push(ev));
  port._deliver({ t: "msg", seq: 1, data: { source: "kondo-iframe" }, pids: [] });

  assert.deepEqual(delivered, [], "only the bridge channel is ours");
});

test("a content script's navigator.serviceWorker is left alone", async (t) => {
  const serviceWorker = deadContainer();
  const { sandbox, connects, dispose } = runShim("https://app.trykondo.com/inboxes", { serviceWorker });
  t.after(dispose);

  assert.equal(sandbox.navigator.serviceWorker.controller, null, "the page's own registration must not be shadowed");
  assert.equal(connects.length, 0);
  let settled = false;
  sandbox.navigator.serviceWorker.ready.then(() => { settled = true; });
  await settle();
  assert.equal(settled, false, "the page's real ready promise is untouched");
});

test("a page that really is controlled keeps its own container", async (t) => {
  const serviceWorker = deadContainer();
  const own = { active: { postMessage() {} } };
  serviceWorker.controller = own.active;
  serviceWorker.ready = Promise.resolve(own);
  const { sandbox, dispose } = runShim("safari-web-extension://abc/ext.html", { serviceWorker });
  t.after(dispose);

  assert.equal(await sandbox.navigator.serviceWorker.ready, own, "a live worker wins over the emulation");
  assert.equal(sandbox.navigator.serviceWorker.controller, own.active);
});
