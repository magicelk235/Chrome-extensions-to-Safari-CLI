import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// The emulated offscreen document is an iframe inside the background page, and
// Safari never delivers same-page sendMessage — so the shim hand-delivers via
// __c2sDeliverLocalMsg and must route responses back (sync sendResponse,
// `return true` + async sendResponse, and promise-returning listeners).
// Tampermonkey's storage bus depends on this round-trip; a black-hole
// sendResponse blanks its popup. Run the real shim in a VM where the fake
// iframe's contentWindow IS the same context, then exercise all three modes.
function makeContext() {
  const frames = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    location: { href: "safari-web-extension://TEST/background.html" },
    navigator: { userAgent: "test" },
    __nativeSends: [],
    document: {
      body: {
        appendChild(f) {
          // Fire `load` async like a real iframe so createDocument resolves.
          setTimeout(() => f._listeners.load?.(), 0);
        },
      },
      createElement() {
        const f = { style: {}, _listeners: {}, setAttribute() {}, addEventListener(t, fn) { f._listeners[t] = fn; } };
        frames.push(f);
        return f;
      },
    },
    chrome: {
      runtime: {
        id: "test-ext",
        getURL: (p) => "safari-web-extension://TEST/" + p,
        onMessage: {
          addListener() {},
          removeListener() {},
        },
        // Native Safari behavior for a message nobody answers: callback fires
        // with undefined. Record calls so tests can assert the fall-through.
        sendMessage(...args) {
          sandbox.__nativeSends.push(args);
          const cb = typeof args[args.length - 1] === "function" ? args[args.length - 1] : null;
          if (cb) setTimeout(() => cb(undefined), 0);
        },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  assert.ok(sandbox.chrome.offscreen, "shim must install the offscreen emulation");
  return { sandbox, frames };
}

async function boot(listenerSrc) {
  const { sandbox, frames } = makeContext();
  vm.runInContext(`chrome.runtime.onMessage.addListener(${listenerSrc});`, sandbox);
  await sandbox.chrome.offscreen.createDocument({ url: "offscreen.html" });
  assert.equal(frames.length, 1, "createDocument must create the iframe");
  frames[0].contentWindow = sandbox; // iframe context = same VM context
  return sandbox;
}

const send = (sandbox, msg) =>
  new Promise((res) => sandbox.chrome.runtime.sendMessage(msg, res));

// VM-context objects have a foreign Object.prototype, which trips
// assert.deepEqual's prototype check — compare by JSON shape instead.
const assertJson = (actual, expected) =>
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));

test("sync sendResponse from the iframe listener reaches the caller", async () => {
  const sandbox = await boot(`(msg, sender, sendResponse) => {
    if (msg.q === "sync") { sendResponse({ ok: "sync" }); }
  }`);
  assertJson(await send(sandbox, { q: "sync" }), { ok: "sync" });
});

test("return true + async sendResponse reaches the caller", async () => {
  const sandbox = await boot(`(msg, sender, sendResponse) => {
    if (msg.q === "async") { setTimeout(() => sendResponse({ ok: "async" }), 5); return true; }
  }`);
  assertJson(await send(sandbox, { q: "async" }), { ok: "async" });
});

test("promise-returning listener (polyfill style) reaches the caller", async () => {
  const sandbox = await boot(`(msg) => {
    if (msg.q === "promise") return Promise.resolve({ ok: "promise" });
  }`);
  assertJson(await send(sandbox, { q: "promise" }), { ok: "promise" });
});

test("promise form of sendMessage resolves with the iframe's response", async () => {
  const sandbox = await boot(`(msg, sender, sendResponse) => {
    if (msg.q === "async") { setTimeout(() => sendResponse({ ok: "p-async" }), 5); return true; }
  }`);
  const resp = await sandbox.chrome.runtime.sendMessage({ q: "async" });
  assertJson(resp, { ok: "p-async" });
});

test("unhandled message falls through to native semantics", async () => {
  const sandbox = await boot(`() => {}`);
  sandbox.__nativeSends.length = 0;
  assert.equal(await send(sandbox, { q: "nobody" }), undefined);
  assert.ok(sandbox.__nativeSends.length >= 1, "native sendMessage must still be called");
});

test("first response wins — no double callback", async () => {
  const sandbox = await boot(`(msg, sender, sendResponse) => {
    sendResponse({ n: 1 }); setTimeout(() => sendResponse({ n: 2 }), 5); return true;
  }`);
  let calls = 0, last;
  sandbox.chrome.runtime.sendMessage({ q: "x" }, (r) => { calls++; last = r; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 1);
  assertJson(last, { n: 1 });
});
