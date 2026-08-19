import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATE_DIR } from "../dist/paths.js";

// A converted MV3 background is a non-persistent PAGE, and Safari's delivery to it
// fails in two distinct ways this codebase has already had to work around:
//   * a sendMessage into a SUSPENDED background is not reliably delivered or rejected —
//     the promise can just never settle (what the shim's runtime.connect wrapper retries
//     around);
//   * on some builds Safari stops delivering content-script messages to an extension
//     page entirely and silently, which is why the shim relays extension-page traffic
//     through chrome.storage.local at all.
// The relay used to send once over sendMessage, so either failure lost the whole
// handshake: the page waited out its timeout and the only trace was
// "[bridge-cs] background NO RESPONSE" on the page console, with the extension itself
// running fine. It now probes both transports with a ping the polyfill answers itself,
// then relays the payload exactly once over whichever answered.
const read = (f) => readFileSync(join(TEMPLATE_DIR, f), "utf8");
// Objects built inside a vm realm carry that realm's prototypes, which strict deepEqual
// compares. Only the data matters here.
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

const REQ = "__c2sMbxReq:", RSP = "__c2sMbxRsp:", BELL = "__c2sMbxBell";

/**
 * Isolated-world realm running page-bridge-cs.js against a scripted `chrome`.
 *  - `nativeAnswersFrom`: sendMessage never settles before this call number (Infinity =
 *    Safari never delivers to the background at all).
 *  - `storage`: give the realm a storage.local + onChanged so the mailbox fallback is
 *    available, and model the background's side of the shim's mailbox protocol.
 */
function relayRealm({ nativeAnswersFrom = 1, storage = false, backgroundAnswers = true } = {}) {
  const sent = [];
  const errors = [];
  const mailbox = { requests: [], data: Object.create(null) };
  const win = {
    console: { log() {}, warn() {}, error: (...a) => errors.push(a.join(" ")) },
    setTimeout, clearTimeout, Promise, Date, Math, JSON,
    location: { origin: "https://claude.ai", href: "https://claude.ai/oauth/authorize?code=1" },
    _listeners: [],
    _posted: [],
    addEventListener(t, f) { if (t === "message") win._listeners.push(f); },
    // Only the replies the relay sends BACK to the page matter here; it also posts a
    // {__claudeBridge:"probe"} asking the page world to confirm it has the bridge.
    postMessage(data) { if (data && data.__claudeBridge === "cs") win._posted.push(data); },
  };
  win.window = win; win.self = win; win.globalThis = win;
  vm.createContext(win);

  const answer = (msg) => (msg.__bridgePing ? { ok: true } : { relayed: true, got: msg.payload });

  const api = {
    runtime: {
      id: "com.viaduct.Test.Extension",
      lastError: undefined,
      sendMessage(msg) {
        sent.push({ via: "native", msg });
        if (sent.filter((s) => s.via === "native").length < nativeAnswersFrom) return new Promise(() => {});
        return Promise.resolve(answer(msg));
      },
    },
  };
  if (storage) {
    const changeListeners = [];
    api.storage = {
      onChanged: { addListener: (f) => changeListeners.push(f), removeListener(f) { const i = changeListeners.indexOf(f); if (i >= 0) changeListeners.splice(i, 1); } },
      local: {
        set(o, cb) {
          for (const k of Object.keys(o)) mailbox.data[k] = o[k];
          // The background side of the shim's relay: mirror any request record into its
          // onMessage listeners and write the answer to __c2sMbxRsp:<id>.
          for (const k of Object.keys(o)) {
            if (k.indexOf(REQ) !== 0) continue;
            const rec = o[k];
            mailbox.requests.push(rec);
            if (!backgroundAnswers) continue;
            setTimeout(() => {
              const resp = answer(rec.msg);
              mailbox.data[RSP + rec.id] = { from: "bg", has: resp !== undefined, resp, t: Date.now() };
            }, 30);
          }
          if (typeof cb === "function") cb();
        },
        get(keys, cb) {
          const out = {};
          for (const k of [].concat(keys)) if (k in mailbox.data) out[k] = mailbox.data[k];
          if (typeof cb === "function") cb(out);
        },
        remove(keys) { for (const k of [].concat(keys)) delete mailbox.data[k]; },
      },
    };
  }
  vm.runInContext("(function(chrome, browser){" + read("page-bridge-cs.js") + "})", win)(api, undefined);
  return { win, sent, errors, mailbox };
}

/** Deliver a page->relay request the way page-bridge.js does. */
function pageSends(win, msg) {
  for (const f of win._listeners.slice()) {
    f({ source: vm.runInContext("window", win), origin: "https://claude.ai", data: { __claudeBridge: "page", reqId: "r1", msg } });
  }
}

test("the relay probes the background before relaying, and the probe is idempotent", async () => {
  const { sent } = relayRealm();
  await tick(60);
  assert.deepEqual(plain(sent), [{ via: "native", msg: { __bridgePing: true } }]);
});

test("a background that only answers the third ping still gets the payload, once", async () => {
  const { win, sent } = relayRealm({ nativeAnswersFrom: 3 });
  pageSends(win, { type: "oauth_redirect", redirect_uri: "https://x/cb?code=1" });
  await tick(4000);
  const pings = sent.filter((s) => s.msg.__bridgePing);
  const payloads = sent.filter((s) => s.msg.__bridge);
  assert.ok(pings.length >= 3, `expected retries, got ${pings.length}`);
  assert.equal(payloads.length, 1, "an OAuth code is single-use — never replay the payload");
  assert.deepEqual(plain(payloads[0].msg.payload), { type: "oauth_redirect", redirect_uri: "https://x/cb?code=1" });
  assert.deepEqual(plain(win._posted), [{ __claudeBridge: "cs", reqId: "r1", response: { relayed: true, got: { type: "oauth_redirect", redirect_uri: "https://x/cb?code=1" } }, error: null }]);
});

test("Safari never delivering sendMessage falls back to the storage mailbox", async () => {
  const { win, sent, mailbox, errors } = relayRealm({ nativeAnswersFrom: Infinity, storage: true });
  pageSends(win, { type: "oauth_redirect", redirect_uri: "https://x/cb?code=1" });
  await tick(6000);
  assert.equal(errors.length, 0, `no diagnosis expected, got: ${errors.join(" | ")}`);
  // Native was tried first (it is the better transport when it works), then the mailbox.
  assert.ok(sent.every((s) => s.msg.__bridgePing), "payload must not go out natively when native never answered");
  const payloads = mailbox.requests.filter((r) => r.msg.__bridge);
  assert.equal(payloads.length, 1, "payload relayed exactly once, over the mailbox");
  assert.deepEqual(plain(payloads[0].msg.payload), { type: "oauth_redirect", redirect_uri: "https://x/cb?code=1" });
  // The background must see the PAGE as the sender, or the extension's origin gate
  // rejects the message.
  assert.equal(payloads[0].sender.url, "https://claude.ai/oauth/authorize?code=1");
  assert.equal(payloads[0].sender.origin, "https://claude.ai");
  assert.deepEqual(plain(win._posted[0].response), { relayed: true, got: { type: "oauth_redirect", redirect_uri: "https://x/cb?code=1" } });
});

test("a background dead on both transports is named once, and names the mailbox", async () => {
  const { win, sent, mailbox, errors } = relayRealm({ nativeAnswersFrom: Infinity, storage: true, backgroundAnswers: false });
  pageSends(win, { type: "oauth_redirect" });
  await tick(13000);
  assert.equal(errors.length, 1, `one diagnosis, got ${errors.length}`);
  assert.match(errors[0], /either transport/);
  assert.match(errors[0], /background console/);
  // Still attempted rather than dropped, and still only once.
  assert.equal(sent.filter((s) => s.msg.__bridge).length + mailbox.requests.filter((r) => r.msg.__bridge).length, 1);
  assert.equal(win._posted.length, 0, "the page hears back from the 30s timeout, not from a fake answer");
});

test("no storage permission: native only, and the diagnosis says so", async () => {
  const { errors } = relayRealm({ nativeAnswersFrom: Infinity, storage: false });
  await tick(6000);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /No storage permission/);
});

test("the polyfill answers the wake ping with no external listener registered", async () => {
  const onMessage = { _ls: [], addListener: (f) => onMessage._ls.push(f), removeListener() {}, hasListener: () => false };
  const bg = {
    console: { log() {}, warn() {}, error() {} },
    URL, Promise, setTimeout, clearTimeout,
    location: { href: "safari-web-extension://ABC/background.html", pathname: "/background.html" },
    navigator: { userAgent: "test" },
    chrome: {
      runtime: {
        id: "com.viaduct.Test.Extension",
        getURL: (p) => "safari-web-extension://ABC/" + String(p ?? "").replace(/^\//, ""),
        onMessage,
        onMessageExternal: { addListener() {}, removeListener() {}, hasListener: () => false },
        lastError: undefined,
      },
    },
  };
  bg.self = bg; bg.globalThis = bg;
  vm.createContext(bg);
  vm.runInContext(read("identity-polyfill.js"), bg);

  // No onMessageExternal listener at all: the bundle may not have evaluated yet, or may
  // not use externally_connectable. The ping must still answer, or the relay reads a
  // perfectly healthy background as dead.
  let replied;
  const ret = onMessage._ls[0]({ __bridgePing: true }, { url: "https://claude.ai/" }, (r) => { replied = r; });
  assert.deepEqual(plain(replied), { ok: true }, "callback form (Chrome)");
  assert.deepEqual(plain(await ret), { ok: true }, "promise form (Safari ignores `return true`)");
});

// Safari rejects runtime.sendMessage with "Invalid call to runtime.sendMessage(). Tab not
// found." when it cannot resolve the SENDER's tab: the page is unloading, discarded, or
// — routinely, at the end of a successful OAuth flow — has just been navigated away by
// the extension itself. Forwarding that as an error made page-bridge reject the promise
// it handed the page, and an unloading page never catches it: "Unhandled Promise
// Rejection: … Tab not found." claude.ai carries that exact string in its own ignore
// list, which is how well-known this noise is. It must also not be blamed on the
// background, which is healthy.
function goneRealm() {
  const sent = [];
  const errors = [];
  const win = {
    console: { log() {}, warn() {}, error: (...a) => errors.push(a.join(" ")) },
    setTimeout, clearTimeout, Promise, Date, Math, JSON,
    location: { origin: "https://claude.ai", href: "https://claude.ai/oauth/authorize" },
    _listeners: [],
    _posted: [],
    addEventListener(t, f) { if (t === "message") win._listeners.push(f); },
    postMessage(data) { if (data && data.__claudeBridge === "cs") win._posted.push(data); },
    // A content script always has a document; the page-world presence check uses it.
    document: { head: { appendChild() {} }, createElement: () => ({ style: {}, setAttribute() {} }) },
  };
  win.documentElement = win.document.head;
  win.window = win; win.self = win; win.globalThis = win;
  vm.createContext(win);
  const api = {
    runtime: {
      id: "com.viaduct.Test.Extension",
      lastError: undefined,
      getURL: (p) => "safari-web-extension://ABC/" + p,
      sendMessage(msg) {
        sent.push(msg);
        return Promise.reject(new Error("Invalid call to runtime.sendMessage(). Tab not found."));
      },
    },
    // Storage is available: the point is that a departing tab must not fall back to it
    // and must not be reported either.
    storage: {
      onChanged: { addListener() {}, removeListener() {} },
      local: { set(o, cb) { if (cb) cb(); }, get(k, cb) { if (cb) cb({}); }, remove() {} },
    },
  };
  vm.runInContext("(function(chrome, browser){" + read("page-bridge-cs.js") + "})", win)(api, undefined);
  return { win, sent, errors };
}

test("a tab going away is abandoned quietly, not blamed on the background", async () => {
  const { win, sent, errors } = goneRealm();
  pageSends(win, { type: "oauth_redirect" });
  await tick(3000);
  assert.deepEqual(errors, [], "no diagnosis: the extension is fine, the page is leaving");
  assert.equal(sent.filter((m) => m.__bridgePing).length, 1, "one ping, then stop — no retry storm");
  assert.equal(win._posted.length, 0, "nothing posted back into an unloading page to reject");
});
