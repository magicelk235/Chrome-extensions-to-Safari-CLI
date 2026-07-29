import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Chrome's documented SW->offscreen binary handshake is
// `client.postMessage(msg, [port2])` followed by `await port1.onmessage`, with the
// offscreen document listening on navigator.serviceWorker.onmessage. The converted
// background is a PAGE with no `clients`, so the shim fabricates one over the
// emulated offscreen iframe — and a fabricated client whose postMessage drops the
// message hangs that await forever, with nothing thrown to show for it. Live case:
// Tampermonkey's editor save wraps the script source in an object URL created in
// the offscreen document, so saving any userscript spun on "Please wait..." and
// then reported a bogus parse error.
function boot() {
  const frames = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    location: { href: "safari-web-extension://TEST/background.html" },
    navigator: { userAgent: "test" },
    document: {
      body: {
        appendChild(f) {
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
        onMessage: { addListener() {}, removeListener() {} },
        sendMessage() {},
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  return { sandbox, frames };
}

// Stand-in for the offscreen document's realm: a ServiceWorkerContainer that
// records what the shim dispatches at it, plus the MessageEvent constructor the
// shim builds the event with.
function makeIframeWindow() {
  const delivered = [];
  class StubMessageEvent {
    constructor(type, init) {
      this.type = type;
      this.data = init?.data;
      this.ports = init?.ports ?? [];
    }
  }
  return {
    delivered,
    win: {
      MessageEvent: StubMessageEvent,
      navigator: {
        serviceWorker: {
          dispatchEvent(ev) { delivered.push(ev); return true; },
        },
      },
      postMessage() { throw new Error("must deliver via navigator.serviceWorker, not window.postMessage"); },
    },
  };
}

// An open MessagePort holds the event loop, and a failed assertion would skip any
// close() at the end of a test, hanging the whole run. Unref on creation instead.
function channel() {
  const ch = new MessageChannel();
  ch.port1.unref();
  ch.port2.unref();
  return ch;
}

async function bootWithOffscreen() {
  const { sandbox, frames } = boot();
  assert.ok(sandbox.chrome.offscreen, "shim must install the offscreen emulation");
  await sandbox.chrome.offscreen.createDocument({ url: "offscreen.html" });
  assert.equal(frames.length, 1, "createDocument must create the iframe");
  const { win, delivered } = makeIframeWindow();
  frames[0].contentWindow = win;
  return { sandbox, delivered };
}

test("fabricated client delivers postMessage to the offscreen document", async () => {
  const { sandbox, delivered } = await bootWithOffscreen();
  const clients = await sandbox.self.clients.matchAll({ includeUncontrolled: true });
  assert.equal(clients.length, 1, "matchAll must report the emulated offscreen document");

  const ch = channel();
  clients[0].postMessage({ action: "objectURL" }, [ch.port2]);

  assert.equal(delivered.length, 1, "message must reach navigator.serviceWorker");
  assert.equal(delivered[0].type, "message");
  assert.equal(delivered[0].data.action, "objectURL");
  assert.equal(delivered[0].ports.length, 1, "transferred port must ride along");
});

test("the transferred port still carries the offscreen document's reply back", async () => {
  const { sandbox, delivered } = await bootWithOffscreen();
  const clients = await sandbox.self.clients.matchAll({ includeUncontrolled: true });

  const ch = channel();
  const reply = new Promise((res) => { ch.port1.onmessage = (e) => res(e.data); });
  ch.port1.unref(); // assigning onmessage re-refs the port
  clients[0].postMessage({ action: "objectURL" }, [ch.port2]);

  // The offscreen document answers on the port it was handed, exactly as
  // Tampermonkey's offscreen.js does.
  delivered[0].ports[0].postMessage({ result: { url: "blob:x" } });
  assert.deepEqual(await reply, { result: { url: "blob:x" } });
});

test("no offscreen document means no client to post to", async () => {
  const { sandbox } = boot();
  const clients = await sandbox.self.clients.matchAll({ includeUncontrolled: true });
  assert.equal(clients.length, 0);
});
