import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { shimSource, wireUserScriptsContentScript, USERSCRIPTS_CS_FILENAME } from "../dist/runtime/shim.js";

// Safari delivers NO navigation events to a converted background page: neither
// tabs.onUpdated nor webNavigation.onCommitted ever fired, with listeners registered at
// background load and again live from the inspector, on a page that was demonstrably
// awake, and both events report as present and non-inert so no capability check catches
// it. So chrome.userScripts cannot inject from a navigation listener at all. A declared
// content script does run — it is how every working converted extension reaches the page
// — so it asks the background what matches its URL and evaluates that.
function boot() {
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: () => Promise.reject(new Error("no network in tests")),
    location: { href: "safari-web-extension://TEST/background.html", protocol: "safari-web-extension:" },
    navigator: { userAgent: "test" },
    chrome: {
      runtime: {
        id: "test-ext",
        getURL: (p) => "safari-web-extension://TEST/" + p,
        onMessage: { addListener: (fn) => listeners.push(fn), removeListener() {} },
        sendMessage() {},
      },
      scripting: { executeScript: () => Promise.resolve([]) },
    },
  };
  const listeners = [];
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);

  // What the injected content script sends, and what it gets back.
  const ask = (url, { top = true } = {}) =>
    new Promise((resolve) => {
      const msg = { __viaductUserScripts: { url, top } };
      for (const fn of listeners) {
        const kept = fn(msg, { id: "test-ext" }, resolve);
        if (kept === true) return;
      }
      resolve(undefined);
    });
  return { sandbox, ask, listeners };
}

const userScript = (over = {}) => ({
  id: "tm-1",
  js: [{ code: "window.__ran = true;" }],
  matches: ["https://example.com/*"],
  runAt: "document_start",
  world: "USER_SCRIPT",
  allFrames: false,
  ...over,
});

// Array.from rebuilds it in this realm; the response is built inside the VM and its
// foreign Array.prototype trips assert.deepEqual.
const ids = (resp) => Array.from(resp.scripts || [], (s) => s.id).sort();

test("the page is served the scripts that match its URL", async () => {
  const { sandbox, ask } = boot();
  await sandbox.chrome.userScripts.register([userScript()]);
  const resp = await ask("https://example.com/page");
  assert.deepEqual(ids(resp), ["tm-1"]);
  assert.equal(resp.scripts[0].code, "window.__ran = true;");
  assert.equal(resp.scripts[0].runAt, "document_start");
});

test("a non-matching URL is served nothing", async () => {
  const { sandbox, ask } = boot();
  await sandbox.chrome.userScripts.register([userScript()]);
  assert.deepEqual(ids(await ask("https://other.test/page")), []);
});

test("excludeMatches and excludeGlobs both suppress a match", async () => {
  const { sandbox, ask } = boot();
  await sandbox.chrome.userScripts.register([
    userScript({ id: "a", excludeMatches: ["https://example.com/admin/*"] }),
    userScript({ id: "b", excludeGlobs: ["*/private/*"] }),
  ]);
  assert.deepEqual(ids(await ask("https://example.com/admin/panel")), ["b"]);
  assert.deepEqual(ids(await ask("https://example.com/private/x")), ["a"]);
});

test("includeGlobs narrow a match further", async () => {
  const { sandbox, ask } = boot();
  await sandbox.chrome.userScripts.register([userScript({ includeGlobs: ["*/wanted*"] })]);
  assert.deepEqual(ids(await ask("https://example.com/nope")), []);
  assert.deepEqual(ids(await ask("https://example.com/wanted/x")), ["tm-1"]);
});

test("a subframe only gets the scripts that asked for all frames", async () => {
  const { sandbox, ask } = boot();
  await sandbox.chrome.userScripts.register([
    userScript({ id: "main-only", allFrames: false }),
    userScript({ id: "all", allFrames: true }),
  ]);
  assert.deepEqual(ids(await ask("https://example.com/x", { top: false })), ["all"]);
  assert.deepEqual(ids(await ask("https://example.com/x")), ["all", "main-only"]);
});

test("unregistering stops it being served", async () => {
  const { sandbox, ask } = boot();
  await sandbox.chrome.userScripts.register([userScript()]);
  await sandbox.chrome.userScripts.unregister({ ids: ["tm-1"] });
  // Nothing left to hold, so this context abstains entirely rather than answering
  // empty and shouting down a context that does hold scripts.
  assert.equal(await ask("https://example.com/x"), undefined);
});

test("updating the code changes what is served", async () => {
  const { sandbox, ask } = boot();
  await sandbox.chrome.userScripts.register([userScript()]);
  await sandbox.chrome.userScripts.update([{ id: "tm-1", js: [{ code: "window.__v = 2;" }] }]);
  const resp = await ask("https://example.com/x");
  assert.equal(resp.scripts[0].code, "window.__v = 2;");
});

test("<all_urls> matches http and https", async () => {
  const { sandbox, ask } = boot();
  await sandbox.chrome.userScripts.register([userScript({ matches: ["<all_urls>"] })]);
  assert.deepEqual(ids(await ask("http://anything.test/a")), ["tm-1"]);
  assert.deepEqual(ids(await ask("https://other.test/b")), ["tm-1"]);
});

test("the registry answers synchronously so another listener cannot win the race", async () => {
  // sendMessage broadcasts to every listener and the FIRST sendResponse wins. This
  // shim's listener is registered first, but it used to answer from a promise, so the
  // extension's own handler replied first with its own shape and the page was told it
  // had no scripts — live, that read as "received 0 script(s)".
  const { sandbox, listeners } = boot();
  await sandbox.chrome.userScripts.register([userScript()]);
  let answeredDuringCall = false;
  let resp;
  const kept = listeners.some((fn) => {
    const r = fn({ __viaductUserScripts: { url: "https://example.com/x", top: true } }, {}, (v) => {
      answeredDuringCall = true;
      resp = v;
    });
    return r === true;
  });
  assert.equal(answeredDuringCall, true, "the answer must arrive before the listener returns");
  assert.equal(kept, false, "and it must not ask to keep the channel open");
  assert.deepEqual(ids(resp), ["tm-1"]);
});

test("an extension page with no scripts abstains instead of answering empty", async () => {
  // onMessage reaches every extension page, each running this shim with its own
  // registry. A popup or options page answering first with an empty list tells the
  // content script there is nothing to run, even though the background holds the
  // scripts — live, that is exactly what produced "received 0 script(s)".
  const { listeners } = boot(); // nothing registered in this context
  let answered = false;
  const kept = listeners.some(
    (fn) => fn({ __viaductUserScripts: { url: "https://example.com/x", top: true } }, {}, () => { answered = true; }) === true,
  );
  assert.equal(kept, false, "an empty context must not keep the channel open");
  assert.equal(answered, false, "and must not answer");
});

test("a message that isn't ours is left alone for the extension's own handlers", async () => {
  const { sandbox, listeners } = boot();
  await sandbox.chrome.userScripts.register([userScript()]);
  let answered = false;
  // Keeping the channel open (returning true) for someone else's message would stall
  // their sendResponse; answering it would corrupt their reply.
  const kept = listeners.some((fn) => fn({ hello: "world" }, {}, () => { answered = true; }) === true);
  assert.equal(kept, false);
  assert.equal(answered, false);
});

// ── the injector viaduct writes into the bundle ────────────────────────────────
function stageDir() {
  return mkdtempSync(join(tmpdir(), "viaduct-us-"));
}

test("the injector is wired only for an extension that asked for userScripts", () => {
  const dir = stageDir();
  try {
    const plain = { permissions: ["storage"] };
    assert.equal(wireUserScriptsContentScript(dir, plain, plain), null);
    assert.equal(existsSync(join(dir, USERSCRIPTS_CS_FILENAME)), false);
    assert.equal(plain.content_scripts, undefined, "no extension gains a content script it never asked for");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the injector is declared at document_start in all frames", () => {
  const dir = stageDir();
  try {
    // transformManifest strips userScripts for Safari, so the check reads the original.
    const original = { permissions: ["userScripts", "scripting"] };
    const transformed = { permissions: ["scripting"] };
    assert.equal(wireUserScriptsContentScript(dir, transformed, original), USERSCRIPTS_CS_FILENAME);

    const entry = transformed.content_scripts.find((cs) => cs.js.includes(USERSCRIPTS_CS_FILENAME));
    assert.ok(entry, "the injector must be declared");
    assert.deepEqual(entry.matches, ["<all_urls>"]);
    assert.equal(entry.run_at, "document_start");
    assert.equal(entry.all_frames, true);

    const src = readFileSync(join(dir, USERSCRIPTS_CS_FILENAME), "utf-8");
    assert.match(src, /__viaductUserScripts/, "it must ask the background for its scripts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-wiring the same bundle does not declare it twice", () => {
  const dir = stageDir();
  try {
    const original = { permissions: ["userScripts"] };
    const transformed = { permissions: [] };
    wireUserScriptsContentScript(dir, transformed, original);
    wireUserScriptsContentScript(dir, transformed, original);
    const entries = transformed.content_scripts.filter((cs) => cs.js.includes(USERSCRIPTS_CS_FILENAME));
    assert.equal(entries.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
