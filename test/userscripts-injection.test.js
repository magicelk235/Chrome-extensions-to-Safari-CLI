import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Safari has no dynamic user-script registry, so the shim kept a coherent
// chrome.userScripts registry that never injected anything. That is fatal for a
// userscript manager: Tampermonkey ships NO content_scripts at all and registers
// every userscript through this API, so its scripts were stored, listed as enabled
// in the popup, and never ran. Safari does have scripting.executeScript, so the
// registry now drives the injection itself on each navigation.
function boot({ webNavigation = true } = {}) {
  const injected = [];
  const navListeners = [];
  const tabListeners = [];
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { href: "safari-web-extension://TEST/background.html" },
    navigator: { userAgent: "test" },
    injected,
    chrome: {
      runtime: {
        id: "test-ext",
        getURL: (p) => "safari-web-extension://TEST/" + p,
        onMessage: { addListener() {}, removeListener() {} },
        sendMessage() {},
      },
      scripting: {
        executeScript(opts) {
          injected.push(opts);
          return Promise.resolve([{ result: undefined }]);
        },
      },
      ...(webNavigation
        ? { webNavigation: { onCommitted: { addListener: (fn) => navListeners.push(fn) } } }
        : {}),
      tabs: {
        onUpdated: { addListener: (fn) => tabListeners.push(fn) },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  const navigate = (url, { tabId = 7, frameId = 0 } = {}) => {
    for (const fn of navListeners) fn({ tabId, frameId, url });
  };
  return { sandbox, injected, navigate, navListeners, tabListeners };
}

// Tampermonkey's real shape.
const userScript = (over = {}) => ({
  id: "tm-1",
  js: [{ code: "window.__ran = true;" }],
  matches: ["https://example.com/*"],
  runAt: "document_start",
  world: "USER_SCRIPT",
  allFrames: false,
  ...over,
});

test("the navigation listener is wired at load, not by register()", async () => {
  // Safari only delivers events to listeners a non-persistent background registered
  // synchronously at startup. Wiring on the first register() call, which happens later
  // during async init, produced a listener that never fired once, live.
  const { sandbox, navListeners } = boot();
  const atLoad = navListeners.length;
  assert.ok(atLoad > 0, "shim load must wire a navigation listener");
  await sandbox.chrome.userScripts.register([userScript()]);
  assert.equal(navListeners.length, atLoad, "register() must not be what wires it");
});

test("a registered user script is injected on a matching navigation", async () => {
  const { sandbox, injected, navigate } = boot();
  await sandbox.chrome.userScripts.register([userScript()]);
  navigate("https://example.com/page");

  assert.equal(injected.length, 1, "one injection expected");
  const opts = injected[0];
  assert.equal(opts.target.tabId, 7);
  assert.equal(typeof opts.func, "function", "the source runs through an injected runner");
  assert.equal(opts.args[0], "window.__ran = true;", "the registered code must be handed to the runner");
});

test("a non-matching URL is left alone", async () => {
  const { sandbox, injected, navigate } = boot();
  await sandbox.chrome.userScripts.register([userScript()]);
  navigate("https://other.test/page");
  assert.equal(injected.length, 0);
});

test("excludeMatches and excludeGlobs both suppress a match", async () => {
  const { sandbox, injected, navigate } = boot();
  await sandbox.chrome.userScripts.register([
    userScript({ id: "a", matches: ["https://example.com/*"], excludeMatches: ["https://example.com/admin/*"] }),
    userScript({ id: "b", matches: ["https://example.com/*"], excludeGlobs: ["*/private/*"] }),
  ]);
  navigate("https://example.com/admin/panel");
  assert.deepEqual(injected.map((o) => o.args[1]), ["b"], "only the script without a matching exclude runs");

  injected.length = 0;
  navigate("https://example.com/private/x");
  assert.deepEqual(injected.map((o) => o.args[1]), ["a"]);
});

test("includeGlobs narrow a match further", async () => {
  const { sandbox, injected, navigate } = boot();
  await sandbox.chrome.userScripts.register([userScript({ includeGlobs: ["*/wanted*"] })]);
  navigate("https://example.com/nope");
  assert.equal(injected.length, 0);
  navigate("https://example.com/wanted/x");
  assert.equal(injected.length, 1);
});

test("allFrames decides whether subframes run it", async () => {
  const { sandbox, injected, navigate } = boot();
  await sandbox.chrome.userScripts.register([
    userScript({ id: "main-only", allFrames: false }),
    userScript({ id: "all", allFrames: true }),
  ]);
  navigate("https://example.com/x", { frameId: 3 });
  assert.deepEqual(injected.map((o) => o.args[1]), ["all"], "a subframe only runs allFrames scripts");

  injected.length = 0;
  navigate("https://example.com/x", { frameId: 0 });
  assert.deepEqual(injected.map((o) => o.args[1]).sort(), ["all", "main-only"]);
});

test("USER_SCRIPT maps to the isolated world, MAIN is requested explicitly", async () => {
  const { sandbox, injected, navigate } = boot();
  await sandbox.chrome.userScripts.register([
    userScript({ id: "iso", world: "USER_SCRIPT" }),
    userScript({ id: "main", world: "MAIN" }),
  ]);
  navigate("https://example.com/x");
  const byId = Object.fromEntries(injected.map((o) => [o.args[1], o]));
  // Safari has one isolated world and it is the one where chrome.runtime lives, which
  // is what Tampermonkey's GM bridge needs to reach the background.
  assert.equal(byId.iso.world, undefined, "USER_SCRIPT must not ask for a world Safari lacks");
  assert.equal(byId.main.world, "MAIN");
});

test("runAt document_start injects immediately", async () => {
  const { sandbox, injected, navigate } = boot();
  await sandbox.chrome.userScripts.register([
    userScript({ id: "start", runAt: "document_start" }),
    userScript({ id: "idle", runAt: "document_idle" }),
  ]);
  navigate("https://example.com/x");
  const byId = Object.fromEntries(injected.map((o) => [o.args[1], o]));
  assert.equal(byId.start.injectImmediately, true);
  assert.notEqual(byId.idle.injectImmediately, true);
});

test("file-backed scripts inject as files, not as evaluated source", async () => {
  const { sandbox, injected, navigate } = boot();
  await sandbox.chrome.userScripts.register([userScript({ js: [{ file: "us.js" }] })]);
  navigate("https://example.com/x");
  assert.equal(injected.length, 1);
  // The array is built inside the VM, so its prototype is foreign to deepEqual.
  assert.equal(JSON.stringify(injected[0].files), '["us.js"]');
  assert.equal(injected[0].func, undefined);
});

test("unregistering stops the injection", async () => {
  const { sandbox, injected, navigate } = boot();
  await sandbox.chrome.userScripts.register([userScript()]);
  await sandbox.chrome.userScripts.unregister({ ids: ["tm-1"] });
  navigate("https://example.com/x");
  assert.equal(injected.length, 0);
});

test("updating the code changes what gets injected", async () => {
  const { sandbox, injected, navigate } = boot();
  await sandbox.chrome.userScripts.register([userScript()]);
  await sandbox.chrome.userScripts.update([{ id: "tm-1", js: [{ code: "window.__v = 2;" }] }]);
  navigate("https://example.com/x");
  assert.equal(injected[0].args[0], "window.__v = 2;");
});

test("a backfilled webNavigation is not mistaken for a working one", async () => {
  // The shim backfills chrome.webNavigation.onCommitted with an inert event so a
  // module-eval read can't throw. Wiring saw that stub, reported the signal as
  // available, and listened to something that can never fire — live, that silently
  // cost three build-and-reinstall rounds. Without webNavigation, injection must fall
  // through to tabs.onUpdated and still work.
  const { sandbox, injected, navListeners, tabListeners } = boot({ webNavigation: false });
  assert.ok(sandbox.chrome.webNavigation.onCommitted.__c2sInert, "the backfill is a stub");
  assert.equal(navListeners.length, 0, "nothing may listen to the stub");
  assert.ok(tabListeners.length > 0, "the real signal must be wired instead");

  await sandbox.chrome.userScripts.register([userScript()]);
  for (const fn of tabListeners) fn(7, { url: "https://example.com/x" }, {});
  assert.equal(injected.length, 1, "tabs.onUpdated must drive injection on its own");
});

test("tabs.onUpdated drives injection without a status field", async () => {
  // Safari does not have to report changeInfo.status; gating on "loading" threw away
  // the only signal that fires.
  const { sandbox, injected, tabListeners } = boot({ webNavigation: false });
  await sandbox.chrome.userScripts.register([userScript()]);
  for (const fn of tabListeners) fn(7, {}, { url: "https://example.com/x" });
  assert.equal(injected.length, 1, "the tab's own url is enough");
});

test("one navigation delivered by both signals injects once", async () => {
  const { sandbox, injected, navListeners, tabListeners } = boot();
  assert.ok(navListeners.length > 0 && tabListeners.length > 0, "both signals must be wired");
  await sandbox.chrome.userScripts.register([userScript()]);

  // Safari may deliver either, both, or neither; the shim wires both and dedupes.
  for (const fn of navListeners) fn({ tabId: 7, frameId: 0, url: "https://example.com/x" });
  for (const fn of tabListeners) fn(7, { status: "loading", url: "https://example.com/x" }, {});
  assert.equal(injected.length, 1, "the same navigation must not inject twice");

  // A different URL in the same tab is a real navigation, not a duplicate.
  for (const fn of navListeners) fn({ tabId: 7, frameId: 0, url: "https://example.com/y" });
  assert.equal(injected.length, 2);
});

test("<all_urls> matches http and https", async () => {
  const { sandbox, injected, navigate } = boot();
  await sandbox.chrome.userScripts.register([userScript({ matches: ["<all_urls>"] })]);
  navigate("http://anything.test/a");
  navigate("https://other.test/b");
  assert.equal(injected.length, 2);
});
