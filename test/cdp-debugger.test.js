import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Safari has no DevTools Protocol, so the shim installs a chrome.debugger polyfill
// that maps a subset of CDP onto Safari-available chrome.* APIs (tabs, scripting).
// Run the real shim in a VM with a fake `chrome` that lacks `debugger` (so the gate
// installs it) and exercise only the non-DOM commands — DOM.*/Accessibility.* need a
// real document. chrome.scripting.executeScript is faked to run the injected function
// in-context, so Runtime.evaluate/callFunctionOn actually execute.
function install(config) {
  const updatedListeners = [];
  const removedListeners = [];
  const chrome = {
    tabs: {
      update(tabId, props, cb) { chrome.tabs.__update.push([tabId, props]); if (cb) cb(); },
      get(tabId, cb) { cb(chrome.tabs.__getTab); },
      query(_q, cb) { cb(chrome.tabs.__queryTabs); },
      captureVisibleTab(windowId, opts, cb) { cb(chrome.tabs.__capture); },
      remove(tabId, cb) { if (cb) cb(); },
      create(props, cb) { if (cb) cb({ id: 99 }); },
      onUpdated: { addListener(fn) { updatedListeners.push(fn); } },
      onRemoved: { addListener(fn) { removedListeners.push(fn); } },
      __update: [],
      __getTab: { windowId: 0, url: "" },
      __queryTabs: [],
      __capture: "data:image/png;base64,",
    },
    scripting: {
      executeScript({ func, args }) {
        return Promise.resolve([{ result: func.apply(null, args || []) }]);
      },
    },
    // The shim self-backfills chrome.webNavigation (with a working onCommitted) at
    // install time. Its lifecycle hook prefers webNavigation over tabs.onUpdated, so
    // to exercise the tabs.onUpdated fallback path we present a webNavigation whose
    // onCommitted has NO addListener — the shim's fill() only adds missing members,
    // leaving it non-functional so the hook falls back to tabs.onUpdated.
    webNavigation: { onCommitted: {} },
    runtime: {
      id: "test-ext",
      lastError: undefined,
      getURL: (p) => "safari-web-extension://TEST/" + String(p == null ? "" : p),
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage() {},
    },
  };
  const sandbox = { chrome, console, setTimeout, clearTimeout, Promise };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(config), sandbox);
  return { chrome, sandbox, updatedListeners, removedListeners };
}

test("installs chrome.debugger with the full method surface", () => {
  const { chrome } = install();
  assert.ok(chrome.debugger, "chrome.debugger must be installed");
  assert.equal(typeof chrome.debugger.attach, "function");
  assert.equal(typeof chrome.debugger.detach, "function");
  assert.equal(typeof chrome.debugger.sendCommand, "function");
  assert.equal(typeof chrome.debugger.getTargets, "function");
  assert.equal(typeof chrome.debugger.onEvent.addListener, "function");
  assert.equal(typeof chrome.debugger.onDetach.addListener, "function");
});

test("getTargets reflects real tabs; attach/detach flips the attached flag", async () => {
  const { chrome } = install();
  chrome.tabs.__queryTabs = [{ id: 7, title: "Seven", url: "https://seven.test" }];
  await chrome.debugger.attach({ tabId: 7 });
  let targets = await chrome.debugger.getTargets();
  let seven = targets.find((t) => t.tabId === 7);
  assert.ok(seven && seven.attached === true, "attached tab must be listed with attached:true");
  assert.equal(seven.targetId, "tab-7");
  assert.equal(seven.url, "https://seven.test");
  await chrome.debugger.detach({ tabId: 7 });
  targets = await chrome.debugger.getTargets();
  seven = targets.find((t) => t.tabId === 7);
  assert.ok(seven && seven.attached === false, "detached tab stays listed but attached:false");
});

test("Page.navigate updates the tab URL", async () => {
  const { chrome } = install();
  await chrome.debugger.attach({ tabId: 3 });
  const r = await chrome.debugger.sendCommand({ tabId: 3 }, "Page.navigate", { url: "https://github.com" });
  const call = chrome.tabs.__update.find((c) => c[0] === 3);
  assert.ok(call, "tabs.update must be called for tabId 3");
  assert.equal(call[1].url, "https://github.com");
  assert.equal(r.frameId, "3");
});

test("Page.captureScreenshot returns base64 data", async () => {
  const { chrome } = install();
  chrome.tabs.__getTab = { windowId: 9 };
  chrome.tabs.__capture = "data:image/png;base64,AAAA";
  const r = await chrome.debugger.sendCommand({ tabId: 1 }, "Page.captureScreenshot", {});
  assert.equal(r.data, "AAAA");
});

test("Runtime.evaluate returns the evaluated value", async () => {
  const { chrome } = install();
  const r = await chrome.debugger.sendCommand({ tabId: 1 }, "Runtime.evaluate", { expression: "1+1" });
  assert.equal(r.result.value, 2);
});

test("Runtime.callFunctionOn applies the function declaration", async () => {
  const { chrome } = install();
  const r = await chrome.debugger.sendCommand({ tabId: 1 }, "Runtime.callFunctionOn", {
    functionDeclaration: "function(){return 40+2}",
    arguments: [],
  });
  assert.equal(r.result.value, 42);
});

test("Target.getTargets enumerates tabs", async () => {
  const { chrome } = install();
  chrome.tabs.__queryTabs = [
    { id: 11, title: "A", url: "https://a.test" },
    { id: 12, title: "B", url: "https://b.test" },
  ];
  const r = await chrome.debugger.sendCommand({}, "Target.getTargets", {});
  assert.equal(r.targetInfos.length, 2);
  assert.equal(r.targetInfos[0].targetId, "tab-11");
});

test("unsupported Network.getResponseBody rejects", async () => {
  const { chrome } = install();
  await assert.rejects(
    () => chrome.debugger.sendCommand({ tabId: 1 }, "Network.getResponseBody", { requestId: "x" }),
    /unsupported in Safari/,
  );
});

test("tabs.onUpdated complete synthesizes Page.loadEventFired", async () => {
  const { chrome, updatedListeners } = install();
  await chrome.debugger.attach({ tabId: 5 });
  const events = [];
  chrome.debugger.onEvent.addListener((source, method, params) => {
    events.push({ tabId: source && source.tabId, method, params });
  });
  assert.ok(updatedListeners.length > 0, "attach must register a tabs.onUpdated listener");
  updatedListeners[updatedListeners.length - 1](5, { status: "complete" }, { id: 5, url: "https://x.test" });
  assert.ok(
    events.some((e) => e.method === "Page.loadEventFired" && e.tabId === 5),
    "a Page.loadEventFired for tabId 5 must be emitted",
  );
});

test("cdp:false skips installation", () => {
  const { chrome: c2 } = install({ cdp: false });
  assert.equal(c2.debugger, undefined);
});

test("Runtime.evaluate returns an objectId for non-primitive results", async () => {
  const { chrome } = install();
  const r = await chrome.debugger.sendCommand({ tabId: 1 }, "Runtime.evaluate", { expression: "({a:1,b:2})" });
  assert.equal(r.result.type, "object");
  assert.ok(/^obj-\d+$/.test(r.result.objectId), "expected an obj- handle, got " + JSON.stringify(r.result));
});

test("objectId round-trips through callFunctionOn and getProperties", async () => {
  const { chrome } = install();
  const t = { tabId: 1 };
  const ev = await chrome.debugger.sendCommand(t, "Runtime.evaluate", { expression: "({a:1,b:2})" });
  const oid = ev.result.objectId;
  const call = await chrome.debugger.sendCommand(t, "Runtime.callFunctionOn", {
    objectId: oid, functionDeclaration: "function(){return this.a + this.b}", returnByValue: true,
  });
  assert.equal(call.result.value, 3);
  const props = await chrome.debugger.sendCommand(t, "Runtime.getProperties", { objectId: oid, ownProperties: true });
  const a = props.result.find((p) => p.name === "a");
  const b = props.result.find((p) => p.name === "b");
  assert.ok(a && b, "own props a and b should be enumerated");
  assert.equal(a.value.value, 1);
  assert.equal(b.value.value, 2);
});

test("Runtime.evaluate returnByValue serializes objects instead of handing back a handle", async () => {
  const { chrome } = install();
  const r = await chrome.debugger.sendCommand({ tabId: 1 }, "Runtime.evaluate", { expression: "({a:1})", returnByValue: true });
  assert.equal(r.result.type, "object");
  assert.equal(r.result.objectId, undefined);
  assert.equal(r.result.value.a, 1);
});

test("attach + commands route by synthetic targetId (not just tabId)", async () => {
  const { chrome } = install();
  chrome.tabs.__queryTabs = [{ id: 9, title: "Nine", url: "https://nine.test" }];
  await chrome.debugger.attach({ targetId: "tab-9" });
  const targets = await chrome.debugger.getTargets();
  assert.ok(targets.some((t) => t.tabId === 9 && t.attached === true), "getTargets should mark the targetId-attached tab attached");
  await chrome.debugger.sendCommand({ targetId: "tab-9" }, "Page.navigate", { url: "https://ex.test" });
  assert.ok(chrome.tabs.__update.some((u) => u[0] === 9 && u[1].url === "https://ex.test"), "navigate should route to tab 9");
});

test("Emulation.setDeviceMetricsOverride is accepted and screenshot still returns raw when no downscale canvas exists", async () => {
  const { chrome } = install();
  chrome.tabs.__capture = "data:image/png;base64,ABCD";
  const t = { tabId: 1 };
  const ack = await chrome.debugger.sendCommand(t, "Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  assert.equal(Object.keys(ack).length, 0);
  // OffscreenCanvas/createImageBitmap are absent in the VM sandbox, so the guarded
  // downscale path must fall back to the raw capture — never worse than before.
  const r = await chrome.debugger.sendCommand(t, "Page.captureScreenshot", {});
  assert.equal(r.data, "ABCD");
});

test("captureScreenshot activates the attached tab before capturing (avoids shooting the wrong tab)", async () => {
  const { chrome } = install();
  chrome.tabs.__capture = "data:image/png;base64,PIC";
  const r = await chrome.debugger.sendCommand({ tabId: 5 }, "Page.captureScreenshot", {});
  assert.ok(chrome.tabs.__update.some((u) => u[0] === 5 && u[1].active === true), "should activate tab 5 before capture");
  assert.equal(r.data, "PIC");
});

test("captureVisibleTab rate-limit is retried instead of returned as a blank frame", async () => {
  const { chrome } = install();
  let calls = 0;
  chrome.tabs.captureVisibleTab = (windowId, opts, cb) => {
    calls++;
    if (calls === 1) {
      chrome.runtime.lastError = { message: "MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND" };
      cb(undefined);
      chrome.runtime.lastError = undefined;
    } else {
      cb("data:image/png;base64,RETRIED");
    }
  };
  const r = await chrome.debugger.sendCommand({ tabId: 1 }, "Page.captureScreenshot", {});
  assert.ok(calls >= 2, "should retry after a rate-limit error");
  assert.equal(r.data, "RETRIED");
});

test("Runtime.evaluate awaitPromise resolves the promise's value", async () => {
  const { chrome } = install();
  const r = await chrome.debugger.sendCommand({ tabId: 1 }, "Runtime.evaluate", { expression: "Promise.resolve(42)", awaitPromise: true, returnByValue: true });
  assert.equal(r.result.value, 42);
});

test("Runtime.evaluate without awaitPromise hands back a promise handle", async () => {
  const { chrome } = install();
  const r = await chrome.debugger.sendCommand({ tabId: 1 }, "Runtime.evaluate", { expression: "Promise.resolve(1)" });
  assert.equal(r.result.type, "object");
  assert.ok(/^obj-\d+$/.test(r.result.objectId), "unawaited promise should be a handle");
});
