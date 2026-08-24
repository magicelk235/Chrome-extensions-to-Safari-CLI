import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Regression: Replace AI Translator API on Safari 26. Safari's action popover cannot
// scroll its own main frame — measured live, the popover viewport was 360x600 with a
// 989px document and both window.scrollTo(0, 400) and documentElement.scrollTop = 400
// left the offset at 0, so the whole API-settings list was unreachable with no
// scrollbar and no error. The shim hands the overflow to <body> instead: html loses
// overflow:visible (or CSS propagates the body's overflow to the viewport and nothing
// scrolls), and body is capped at the popover's measured height and scrolls itself.
//
// Two things must stay true. It only fires on the popover document and only once the
// frame has PROVEN it can't scroll — a popup that fits, or one whose frame scrolls,
// must be left alone, because making body a scroll container clips content that used
// to grow the popover. And the cap is a PIXEL value read off the settled frame, never
// 100vh: the popover is sized from the document, so a vh cap feeds back into itself.
// Applied while Safari still reported a 1px viewport, that circle latched and
// collapsed the whole popup to a 1px sliver.

function makeContext({ viewport = 600, content = 989, frameScrolls = false, popupPath = "popup.html", path = "/popup.html" } = {}) {
  const styleOf = () => {
    const props = {};
    return {
      props,
      setProperty(name, value, priority) { props[name] = { value, priority: priority || "" }; },
    };
  };

  const docEl = { clientHeight: viewport, scrollHeight: content, scrollTop: 0, style: styleOf() };
  const body = { style: styleOf() };
  const listeners = {};
  const observed = [];

  const document = {
    readyState: "complete",
    documentElement: docEl,
    body,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    querySelector: () => null,
    createElement: () => ({ style: styleOf(), setAttribute() {}, appendChild() {} }),
    head: { appendChild() {} },
  };

  const chrome = {
    runtime: {
      id: "test-ext",
      getURL: (p) => "safari-web-extension://TEST/" + String(p == null ? "" : p).replace(/^\//, ""),
      getManifest: () => ({ manifest_version: 3, action: { default_popup: popupPath } }),
      onMessage: { addListener() {}, removeListener() {}, hasListener() { return false; } },
      onConnect: { addListener() {}, removeListener() {}, hasListener() { return false; } },
      sendMessage() {},
    },
  };

  const sandbox = {
    console,
    // Unref'd: with a `document` in scope the shim starts its own polling timers,
    // and real ones would hold node's event loop open past the last assertion.
    setTimeout: (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); t.unref?.(); return t; },
    setInterval: (fn, ms, ...a) => { const t = setInterval(fn, ms, ...a); t.unref?.(); return t; },
    clearTimeout, clearInterval,
    location: {
      href: "safari-web-extension://TEST" + path,
      origin: "safari-web-extension://TEST",
      protocol: "safari-web-extension:",
      pathname: path,
      search: "",
    },
    navigator: { userAgent: "test" },
    history: { state: null, replaceState() {} },
    document,
    chrome,
    pageYOffset: 0,
    scrollTo(_x, y) {
      // A frame that scrolls moves; Safari's popover silently ignores the call.
      if (frameScrolls) { sandbox.pageYOffset = Math.min(y, Math.max(0, content - viewport)); docEl.scrollTop = sandbox.pageYOffset; }
    },
    ResizeObserver: class {
      constructor(cb) { this.cb = cb; }
      observe(el) { observed.push(el); }
      disconnect() { this.disconnected = true; }
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const l = listeners[type] || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  return { sandbox, docEl, body, listeners, observed };
}

test("a popover whose frame refuses to scroll gets body as the scroller", () => {
  const { docEl, body } = makeContext();
  assert.deepEqual(docEl.style.props.overflow, { value: "hidden", priority: "important" },
    "html must lose overflow:visible or the body's overflow propagates to the viewport");
  assert.deepEqual(body.style.props["max-height"], { value: "600px", priority: "important" },
    "cap is the measured popover height in px — 100vh feeds back into the popover size");
  assert.deepEqual(body.style.props["overflow-y"], { value: "auto", priority: "important" });
});

test("a popup that fits the popover is left alone", () => {
  const { docEl, body } = makeContext({ viewport: 600, content: 480 });
  assert.deepEqual(docEl.style.props, {}, "nothing overflows, so there is no verdict to act on");
  assert.deepEqual(body.style.props, {});
});

test("a frame that does scroll is left alone", () => {
  const { docEl, body, sandbox } = makeContext({ frameScrolls: true });
  assert.deepEqual(docEl.style.props, {}, "a scrollable frame needs no rescue");
  assert.deepEqual(body.style.props, {});
  assert.equal(sandbox.pageYOffset, 0, "the probe scroll must be restored");
});

test("a 1px viewport is not yet a verdict; the resize that settles it is", () => {
  const { docEl, body, listeners } = makeContext({ viewport: 1 });
  assert.deepEqual(body.style.props, {},
    "capping against Safari's pre-sizing 1px frame collapses the popup to a sliver");

  docEl.clientHeight = 600; // Safari settles the popover
  for (const fn of listeners.resize || []) fn();
  assert.deepEqual(body.style.props["max-height"], { value: "600px", priority: "important" });
});

test("only the popover document is touched", () => {
  const { docEl, body } = makeContext({ popupPath: "popup.html", path: "/options.html" });
  assert.deepEqual(docEl.style.props, {}, "an options page in a tab scrolls natively");
  assert.deepEqual(body.style.props, {});
});

test("the watchers stop once the rescue lands", () => {
  const { listeners } = makeContext();
  assert.equal((listeners.resize || []).length, 0, "resolved on the first check, so nothing is left listening");
});
