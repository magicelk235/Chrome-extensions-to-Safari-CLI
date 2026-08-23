import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// The ring buffer behind --debug: entries carry a timestamp, a context label and
// the message; writes are batched behind one timer per flush window (so logging
// cannot hammer storage.local); the persisted array is capped at the last 2000
// entries; and a broken storage backend is swallowed, never thrown.

const KEY = "__viaduct_debug_log__";

function makeContext({ protocol = "https:", breakSet = false } = {}) {
  const store = {};
  const calls = { ringGets: 0, ringSets: 0 };
  const chrome = {
    runtime: { id: "test-ext" },
    storage: {
      local: {
        get(key, cb) {
          if (key === KEY) calls.ringGets++;
          const res = {};
          if (store[key] !== undefined) res[key] = store[key];
          cb(res);
        },
        set(obj, cb) {
          if (KEY in obj) {
            calls.ringSets++;
            if (breakSet) throw new Error("storage backend down");
          }
          Object.assign(store, obj);
          if (cb) cb();
        },
      },
    },
  };
  const timers = [];
  const sandbox = {
    console,
    chrome,
    browser: chrome,
    location: { protocol, href: protocol + "//example.test/" },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource({ debug: true }), sandbox);
  // Drain every scheduled timer; the shim's unrelated timers must not abort the drain.
  const drain = () => { while (timers.length) { try { timers.shift()(); } catch { /* not ours */ } } };
  return { sandbox, store, calls, drain, timers };
}

test("entries persist under __viaduct_debug_log__ with timestamp, context and message", () => {
  const { sandbox, store, drain } = makeContext();
  const before = Date.now();
  sandbox.__C2S_DEBUG_WRITE__(["hello", { n: 1 }]);
  drain();
  const log = (store[KEY] || []).filter((e) => e.msg.startsWith("hello"));
  assert.equal(log.length, 1);
  assert.equal(log[0].msg, 'hello {"n":1}');
  assert.equal(log[0].ctx, "content", "http(s) page with an API is a content script");
  assert.ok(log[0].t >= before && log[0].t <= Date.now(), "epoch-ms timestamp");
});

test("extension-origin contexts are labeled background", () => {
  const { sandbox, store, drain } = makeContext({ protocol: "safari-web-extension:" });
  sandbox.__C2S_DEBUG_WRITE__(["from bg"]);
  drain();
  const log = (store[KEY] || []).filter((e) => e.msg === "from bg");
  assert.equal(log[0].ctx, "background");
});

test("writes are batched: many entries, one storage round-trip per flush", () => {
  const { sandbox, store, calls, drain } = makeContext();
  for (let i = 0; i < 50; i++) sandbox.__C2S_DEBUG_WRITE__(["burst " + i]);
  assert.equal(calls.ringSets, 0, "nothing hits storage before the flush timer");
  drain();
  assert.equal(calls.ringSets, 1, "one set() for the whole burst");
  assert.equal(calls.ringGets, 1, "one get() for the whole burst");
  assert.equal((store[KEY] || []).filter((e) => e.msg.startsWith("burst ")).length, 50);
});

test("the persisted log is capped at the last 2000 entries", () => {
  const { sandbox, store, drain } = makeContext();
  store[KEY] = Array.from({ length: 1990 }, (_, i) => ({ t: i, ctx: "content", msg: "old " + i }));
  for (let i = 0; i < 20; i++) sandbox.__C2S_DEBUG_WRITE__(["new " + i]);
  drain();
  const log = store[KEY];
  assert.equal(log.length, 2000, "capped at 2000");
  assert.equal(log[0].msg, "old 10", "oldest entries dropped first");
  assert.equal(log[log.length - 1].msg, "new 19", "newest entry kept");
});

test("a throwing storage backend is swallowed, never propagated", () => {
  const { sandbox, timers } = makeContext({ breakSet: true });
  const preexisting = timers.length;
  sandbox.__C2S_DEBUG_WRITE__(["doomed"]);
  // Run exactly the timers the write scheduled, with NO try/catch around them:
  // the flush itself must contain the backend throw.
  for (const fn of timers.splice(preexisting)) fn();
  sandbox.__C2S_DEBUG_WRITE__(["still alive"]); // writer keeps accepting entries
});
