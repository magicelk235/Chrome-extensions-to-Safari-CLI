import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATE_DIR } from "../dist/paths.js";

// page-bridge.js is the ONLY thing that gives an externally_connectable page a
// `chrome.runtime` on Safari, and it is declared as a separate world:"MAIN" content
// script because the isolated world cannot define anything on the PAGE's globals.
// Safari honors that entry only from 18.4 and ignores it silently below, which leaves
// the page unable to message the extension at all: claude.ai's Authorize button calls
// nothing and spins forever, while the relay, the background and the polyfill are all
// healthy — nothing in the chain can see the missing piece.
//
// applyOAuthBridge has made page-bridge.js web-accessible for a script-tag fallback
// since the first bridge commit (53b8e3c, "so a getURL/script-tag fallback works on
// Safari versions that ignore world:MAIN"). The fallback was never written. This pins it.
const read = (f) => readFileSync(join(TEMPLATE_DIR, f), "utf8");
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
// Objects built inside a vm realm carry that realm's prototypes, which strict deepEqual
// compares. Only the data matters here.
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));

/** A page realm the relay runs against, with a scripted document + storage-less chrome. */
function realm({ mainWorldRuns = false, injectionBlocked = false } = {}) {
  const errors = [];
  const appended = [];
  const win = {
    console: { log() {}, warn() {}, error: (...a) => errors.push(a.join(" ")) },
    setTimeout, clearTimeout, Promise, Date, Math, JSON,
    location: { origin: "https://claude.ai", href: "https://claude.ai/oauth/authorize" },
    _listeners: [],
    addEventListener(t, f) { if (t === "message") win._listeners.push(f); },
    postMessage(data) {
      for (const f of win._listeners.slice()) setTimeout(() => f({ source: win._inner, origin: "https://claude.ai", data }), 0);
    },
  };
  win.document = {
    head: {
      appendChild(node) {
        appended.push(node.src);
        // Model the page world evaluating (or refusing) the injected file.
        setTimeout(() => {
          if (injectionBlocked) { if (node.onerror) node.onerror(); return; }
          win.postMessage({ __claudeBridge: "ready" });
        }, 10);
        node.parentNode = { removeChild() {} };
      },
    },
    createElement: () => ({ style: {}, setAttribute() {} }),
  };
  win.documentElement = win.document.head;
  win.window = win; win.self = win; win.globalThis = win;
  vm.createContext(win);
  win._inner = vm.runInContext("window", win);
  const api = {
    runtime: {
      id: "com.viaduct.Test.Extension",
      lastError: undefined,
      getURL: (p) => "safari-web-extension://ABC/" + p,
      // Answer the wake ping so the transport probe cannot muddy these assertions.
      sendMessage: (msg) => Promise.resolve(msg.__bridgePing ? { ok: true } : { relayed: true }),
    },
  };
  vm.runInContext("(function(chrome, browser){" + read("page-bridge-cs.js") + "})", win)(api, undefined);
  // A world:"MAIN" entry that Safari DID run announces itself.
  if (mainWorldRuns) win.postMessage({ __claudeBridge: "ready" });
  return { win, errors, appended };
}

test("Safari ignoring world:MAIN → the relay injects page-bridge.js itself", async () => {
  const { appended, errors } = realm({ mainWorldRuns: false });
  await tick(900);
  assert.deepEqual(appended, ["safari-web-extension://ABC/page-bridge.js"]);
  await tick(1400);
  assert.deepEqual(errors, [], "the injected copy announced itself, so nothing to report");
});

test("a world:MAIN entry that did run is not injected over", async () => {
  const { appended, errors } = realm({ mainWorldRuns: true });
  await tick(900);
  assert.deepEqual(appended, [], "double-installing the page bridge is not free — don't");
  assert.deepEqual(errors, []);
});

test("a page CSP blocking the fallback is reported, not swallowed", async () => {
  const { appended, errors } = realm({ mainWorldRuns: false, injectionBlocked: true });
  await tick(2600);
  assert.equal(appended.length, 1);
  assert.ok(errors.length >= 1, "a page with no bridge must say so");
  assert.match(errors.join(" | "), /CSP/);
  assert.match(errors.join(" | "), /18\.4/);
});

test("page-bridge.js announces itself so the relay can tell", async () => {
  const posted = [];
  const win = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Promise,
    location: { origin: "https://claude.ai", href: "https://claude.ai/oauth/authorize" },
    addEventListener() {},
    postMessage: (d, origin) => posted.push([d, origin]),
    chrome: undefined,
  };
  win.window = win; win.self = win; win.globalThis = win;
  vm.createContext(win);
  vm.runInContext(read("page-bridge.js"), win);
  assert.equal(typeof win.chrome.runtime.sendMessage, "function", "the page gets a chrome.runtime");
  assert.deepEqual(plain(posted.at(-1)), [{ __claudeBridge: "ready" }, "https://claude.ai"]);
});

test("an announcement missed before the relay attached is recovered by the probe", async () => {
  // page-bridge.js and page-bridge-cs.js are separate script evaluations, so the eager
  // announcement can land before the relay's listener exists. Treating that as "no
  // bridge" injects a second copy, whose install-once guard returns early and announces
  // nothing — and the relay would then report a bridge-less page that had one all along.
  const { win, appended, errors } = realm({ mainWorldRuns: false });
  // A page world that already has the bridge: silent until asked.
  win._listeners.push((ev) => {
    if (ev.data && ev.data.__claudeBridge === "probe") win.postMessage({ __claudeBridge: "ready" });
  });
  await tick(2600);
  assert.deepEqual(appended, [], "answered the probe, so nothing was injected");
  assert.deepEqual(errors, [], "and nothing was misreported");
});

test("page-bridge.js answers a probe even when already installed", async () => {
  const posted = [];
  const listeners = [];
  const win = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Promise,
    location: { origin: "https://claude.ai", href: "https://claude.ai/oauth/authorize" },
    addEventListener(t, f) { if (t === "message") listeners.push(f); },
    postMessage: (d) => posted.push(d),
  };
  win.window = win; win.self = win; win.globalThis = win;
  vm.createContext(win);
  const inner = vm.runInContext("window", win);
  vm.runInContext(read("page-bridge.js"), win);
  // Two listeners on a first install: the sendMessage response handler and the probe
  // handler. What matters is that a SECOND evaluation adds none — the relay's injected
  // copy landing on a page that already has the bridge must not double-install — while
  // the page can still answer a probe.
  const afterFirst = listeners.length;
  vm.runInContext(read("page-bridge.js"), win);
  assert.equal(listeners.length, afterFirst, "install-once guard held");
  posted.length = 0;
  for (const l of listeners) l({ source: inner, origin: "https://claude.ai", data: { __claudeBridge: "probe" } });
  assert.deepEqual(plain(posted), [{ __claudeBridge: "ready" }], "exactly one answer");
});
