import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Regression: Cloaked - Privacy & Password Manager. Its "Log in" button asks the
// background to open the auth window, then closes the popup. The background does:
//
//   const w = await chrome.windows.create({url, type:"popup", ...});
//   if (!w.tabs || w.tabs.length === 0) throw new Error("Created window has no tabs available");
//   return w.tabs[0];
//
// Chrome populates `tabs` on the created Window. Safari's native windows.create
// leaves it undefined, so the throw fires, the popup has already closed itself, and
// login dies as a spinner that vanishes. The shim has to make `tabs` always present.

/** Evaluate the shim against a fake Safari-shaped `browser`/`chrome`. */
function runShim({ createResult, createRejectsOnType = false, tabsInWindow = [] } = {}) {
  const calls = { create: [] };
  const chrome = {
    runtime: { id: "abc", lastError: null, getURL: (p) => "safari-web-extension://abc/" + p, getManifest: () => ({}) },
    tabs: {
      query: (info) => Promise.resolve(info && info.windowId === 7 ? tabsInWindow : []),
      create: () => Promise.resolve({ id: 1 }),
    },
    windows: {
      create: (opts) => {
        calls.create.push(opts);
        if (createRejectsOnType && opts && opts.type && opts.type !== "normal") {
          return Promise.reject(new Error("Type not supported"));
        }
        return Promise.resolve(typeof createResult === "function" ? createResult(opts) : createResult);
      },
      get: () => Promise.resolve({ id: 7 }),
      getCurrent: () => Promise.resolve({ id: 7 }),
      getLastFocused: () => Promise.resolve({ id: 7, left: 0, top: 0, width: 1440, height: 900 }),
      getAll: () => Promise.resolve([{ id: 7 }]),
      update: () => Promise.resolve({ id: 7 }),
      remove: () => Promise.resolve(),
      onCreated: { addListener() {}, removeListener() {}, hasListener: () => false },
      onRemoved: { addListener() {}, removeListener() {}, hasListener: () => false },
      onFocusChanged: { addListener() {}, removeListener() {}, hasListener: () => false },
    },
  };
  // The shim arms keepalive timers on load. Hand it timers we can cancel, or they
  // hold the test runner's event loop open after the assertions are done.
  const timers = new Set();
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
  const dispose = () => {
    for (const h of timers) { clearTimeout(h); clearInterval(h); }
    timers.clear();
  };
  return { chrome, calls, dispose };
}

test("windows.create backfills tabs from the new window when Safari omits them", async (t) => {
  const { chrome, dispose } = runShim({
    createResult: { id: 7, focused: true },
    tabsInWindow: [{ id: 42, windowId: 7, index: 0, active: true, url: "https://my.cloaked.com/login" }],
  });
  t.after(dispose);
  const w = await chrome.windows.create({ url: "https://my.cloaked.com/login", type: "popup" });
  assert.ok(w.tabs && w.tabs.length > 0, "Window came back with no tabs");
  assert.equal(w.tabs[0].id, 42);
  assert.equal(w.tabs[0].windowId, 7);
});

test("windows.create still yields a usable tab when the window query comes back empty", async (t) => {
  const { chrome, dispose } = runShim({ createResult: { id: 7 }, tabsInWindow: [] });
  t.after(dispose);
  const w = await chrome.windows.create({ url: "https://my.cloaked.com/login", type: "popup" });
  // Callers index tabs[0] unconditionally; an empty array is as fatal as undefined.
  assert.ok(w.tabs && w.tabs.length > 0, "Window came back with no tabs");
  assert.equal(w.tabs[0].windowId, 7);
  assert.equal(w.tabs[0].url, "https://my.cloaked.com/login");
});

test("a window type Safari refuses is retried as a normal window", async (t) => {
  const { chrome, calls, dispose } = runShim({
    createRejectsOnType: true,
    createResult: { id: 7 },
    tabsInWindow: [{ id: 42, windowId: 7, index: 0, active: true, url: "https://my.cloaked.com/login" }],
  });
  t.after(dispose);
  const w = await chrome.windows.create({ url: "https://my.cloaked.com/login", type: "popup", width: 900 });
  assert.equal(calls.create.length, 2, "expected a retry after the popup type was refused");
  assert.equal(calls.create[1].type, undefined, "retry must drop the unsupported type");
  assert.equal(calls.create[1].width, 900, "retry must keep the other options");
  assert.equal(w.tabs[0].id, 42);
});

test("a Window that already carries tabs is passed through untouched", async (t) => {
  const native = [{ id: 9, windowId: 7, index: 0, active: true, url: "https://example.com/" }];
  const { chrome, dispose } = runShim({ createResult: { id: 7, tabs: native }, tabsInWindow: [] });
  t.after(dispose);
  const w = await chrome.windows.create({ url: "https://example.com/" });
  assert.equal(w.tabs, native);
});

test("the callback form still receives the Window", async (t) => {
  const { chrome, dispose } = runShim({
    createResult: { id: 7 },
    tabsInWindow: [{ id: 42, windowId: 7, index: 0, active: true, url: "https://my.cloaked.com/login" }],
  });
  t.after(dispose);
  const w = await new Promise((res) => chrome.windows.create({ url: "https://my.cloaked.com/login" }, res));
  assert.equal(w.tabs[0].id, 42);
});
