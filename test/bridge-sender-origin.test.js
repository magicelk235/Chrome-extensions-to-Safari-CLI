import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATE_DIR } from "../dist/paths.js";

// An externally_connectable page messages the extension and the extension answers only
// past an origin allow-list. Claude for Chrome's handler is the live case, verbatim:
//   (s,o,r)=>((async()=>{const u=!!(m=o.origin)&&["https://claude.ai"].includes(m);
//     if(u) if("oauth_redirect"===s.type){…;r(t)}})(),!0)
// Safari gives the page no `chrome`, so the relay turns that external message into an
// internal one and the SW-side polyfill re-dispatches it with a synthesized sender. The
// sender it gets from Safari is a CONTENT SCRIPT sender, whose `origin` is whatever
// Safari put there rather than the page's. Trusting that field first hands the gate the
// wrong origin: the listener returns true, answers nothing, and the page's Authorize
// button spins until the relay times out with nothing logged. The page URL is the
// authoritative source of the origin Chrome would have reported.
const read = (f) => readFileSync(join(TEMPLATE_DIR, f), "utf8");

function makeEvent() {
  const ls = [];
  return {
    addListener: (f) => ls.push(f),
    removeListener: (f) => { const i = ls.indexOf(f); if (i >= 0) ls.splice(i, 1); },
    hasListener: (f) => ls.indexOf(f) >= 0,
    _ls: ls,
  };
}

/** Background realm with the polyfill installed and one origin-gated external listener. */
function boot(allowedOrigin) {
  const onMessage = makeEvent();
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
        onMessageExternal: makeEvent(),
        lastError: undefined,
      },
    },
  };
  bg.self = bg;
  bg.globalThis = bg;
  vm.createContext(bg);
  vm.runInContext(read("identity-polyfill.js"), bg);

  const seen = [];
  bg.chrome.runtime.onMessageExternal.addListener((msg, sender, respond) => {
    seen.push(sender.origin);
    if (sender.origin === allowedOrigin && msg.type === "oauth_redirect") {
      respond({ success: true });
    }
    return true; // channel held open either way, as Chrome's contract allows
  });
  return { bg, onMessage, seen };
}

/**
 * Deliver a bridged page message the way the relay content script does. Resolves to
 * "unanswered" rather than hanging when the channel is held open with no reply — the
 * failure this file is about, and one that would otherwise cancel the whole file.
 */
function relay(onMessage, sender, waitMs = 200) {
  const msg = { __bridge: true, payload: { type: "oauth_redirect", redirect_uri: "https://x/cb?code=1" } };
  let out;
  const stalled = new Promise((r) => setTimeout(() => r("unanswered"), waitMs));
  for (const l of onMessage._ls) {
    const ret = l(msg, sender, (r) => { out = r; });
    if (ret && typeof ret.then === "function") {
      return Promise.race([ret.then(() => out), stalled]);
    }
  }
  return Promise.resolve(out);
}

test("bridged sender.origin comes from the page URL, not Safari's sender.origin", async () => {
  const { onMessage, seen } = boot("https://claude.ai");
  const resp = await relay(onMessage, {
    // What Safari hands the relay: the page's url, and an origin of its own choosing.
    url: "https://claude.ai/oauth/authorize?client_id=x",
    origin: "safari-web-extension://abc",
    tab: { id: 7, url: "https://claude.ai/oauth/authorize?client_id=x" },
    frameId: 0,
  });
  assert.deepEqual(seen, ["https://claude.ai"]);
  assert.deepEqual(resp, { success: true });
});

test("sender.tab.url covers a sender with no url of its own", async () => {
  const { onMessage, seen } = boot("https://claude.ai");
  const resp = await relay(onMessage, { origin: undefined, tab: { id: 7, url: "https://claude.ai/chrome" } });
  assert.deepEqual(seen, ["https://claude.ai"]);
  assert.deepEqual(resp, { success: true });
});

test("sender.origin still answers when no URL is available at all", async () => {
  const { onMessage, seen } = boot("https://claude.ai");
  const resp = await relay(onMessage, { origin: "https://claude.ai" });
  assert.deepEqual(seen, ["https://claude.ai"]);
  assert.deepEqual(resp, { success: true });
});

test("a gate that rejects the message is reported instead of hanging silently", async () => {
  const errs = [];
  const { bg, onMessage } = boot("https://example.com");
  bg.console.error = (...a) => errs.push(a.join(" "));
  const answer = relay(onMessage, { url: "https://claude.ai/oauth/authorize", tab: { id: 1 } }, 5100);
  // The listener returned true and never answered. The channel stays open (the relay
  // content script's own timeout owns the page's reply), but the reason must reach the
  // console rather than leaving a spinning page and an empty log.
  assert.equal(await answer, "unanswered");
  assert.equal(errs.length, 1);
  assert.match(errs[0], /oauth_redirect/);
  assert.match(errs[0], /https:\/\/claude\.ai/);
  assert.match(errs[0], /none answered/);
});

test("debug logging can be turned on after the polyfill has loaded", async () => {
  const logs = [];
  const { bg, onMessage } = boot("https://claude.ai");
  bg.console.log = (...a) => logs.push(a.join(" "));
  await relay(onMessage, { url: "https://claude.ai/a", tab: { id: 1 } });
  assert.equal(logs.length, 0, "quiet by default");
  bg.__C2S_DEBUG = true;
  await relay(onMessage, { url: "https://claude.ai/a", tab: { id: 1 } });
  assert.ok(logs.some((l) => l.includes("[idpoly] bridge msg")), "flips on live");
});

// Chrome always gives an external message from a page a sender.tab, and handlers act on
// it. Claude's oauth_redirect finishes by navigating `sender.tab.id` to
// claude.ai/chrome/installed — that navigation is what dismisses the consent window. The
// relay's storage-mailbox transport cannot supply a tab (a content script can't read its
// own tab id, and the shim's own selfSender has the same gap), so a user who had just
// logged in successfully was left staring at a spinner on a page the extension was done
// with. The polyfill resolves the tab from the page URL instead.
function bootWithTabs(tabs, allowedOrigin = "https://claude.ai") {
  const onMessage = makeEvent();
  const queries = [];
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
        onMessageExternal: makeEvent(),
        lastError: undefined,
      },
      tabs: {
        query(q) { queries.push(q); return Promise.resolve(tabs(q)); },
      },
    },
  };
  bg.self = bg; bg.globalThis = bg;
  vm.createContext(bg);
  vm.runInContext(read("identity-polyfill.js"), bg);
  const seen = [];
  bg.chrome.runtime.onMessageExternal.addListener((msg, sender, respond) => {
    seen.push({ origin: sender.origin, tabId: sender.tab && sender.tab.id });
    if (sender.origin === allowedOrigin) respond({ success: true });
    return true;
  });
  return { onMessage, seen, queries };
}

const PAGE = "https://claude.ai/oauth/authorize?client_id=x&state=y";

test("a bridged sender with no tab gets one matched by page URL", async () => {
  const { onMessage, seen } = bootWithTabs(() => [
    { id: 11, url: "https://claude.ai/chats" },
    { id: 42, url: PAGE },
    { id: 77, url: "https://example.com/" },
  ]);
  const resp = await relay(onMessage, { url: PAGE, origin: "https://claude.ai" }, 2500);
  assert.deepEqual(resp, { success: true });
  assert.deepEqual(seen, [{ origin: "https://claude.ai", tabId: 42 }]);
});

test("the URL match ignores query and fragment", async () => {
  const { onMessage, seen } = bootWithTabs(() => [{ id: 9, url: "https://claude.ai/oauth/authorize?other=1#frag" }]);
  await relay(onMessage, { url: PAGE, origin: "https://claude.ai" }, 2500);
  assert.equal(seen[0].tabId, 9);
});

test("no URL match falls back to the active tab of the last-focused window", async () => {
  const { onMessage, seen, queries } = bootWithTabs((q) =>
    q && q.active ? [{ id: 5 }] : [{ id: 1, url: "https://elsewhere/" }]
  );
  await relay(onMessage, { url: PAGE, origin: "https://claude.ai" }, 2500);
  assert.equal(seen[0].tabId, 5);
  const last = queries.at(-1);
  assert.equal(last.active, true);
  assert.equal(last.lastFocusedWindow, true);
});

test("a sender that already has a tab is not re-resolved", async () => {
  const { onMessage, seen, queries } = bootWithTabs(() => [{ id: 99, url: PAGE }]);
  await relay(onMessage, { url: PAGE, origin: "https://claude.ai", tab: { id: 7, url: PAGE } }, 2500);
  assert.equal(seen[0].tabId, 7, "Safari's own sender.tab wins");
  assert.deepEqual(queries, [], "and costs no tabs.query");
});

test("no tabs API (or nothing to match) still dispatches", async () => {
  const { onMessage, seen } = bootWithTabs(() => []);
  const resp = await relay(onMessage, { url: PAGE, origin: "https://claude.ai" }, 2500);
  assert.deepEqual(resp, { success: true }, "a missing tab must never block the answer");
  assert.equal(seen[0].tabId, undefined);
});

test("the active-tab fallback refuses a tab that is visibly another site", async () => {
  // A handler acting on sender.tab.id NAVIGATES it (Claude's oauth_redirect does), so
  // handing over the wrong tab would send a user's unrelated page somewhere else. Worse
  // than supplying no tab at all.
  const { onMessage, seen } = bootWithTabs((q) =>
    q && q.active ? [{ id: 3, url: "https://mybank.example/transfer" }] : [{ id: 1, url: "https://elsewhere/" }]
  );
  const resp = await relay(onMessage, { url: PAGE, origin: "https://claude.ai" }, 2500);
  assert.deepEqual(resp, { success: true }, "still answers");
  assert.equal(seen[0].tabId, undefined, "but hands over no tab");
});

test("the active-tab fallback accepts a same-origin tab", async () => {
  // The page navigated (a redirect mid-flow), so no exact URL match exists, but the
  // active tab is demonstrably the same site.
  const { onMessage, seen } = bootWithTabs((q) =>
    q && q.active ? [{ id: 8, url: "https://claude.ai/oauth/consent" }] : [{ id: 1, url: "https://elsewhere/" }]
  );
  await relay(onMessage, { url: PAGE, origin: "https://claude.ai" }, 2500);
  assert.equal(seen[0].tabId, 8);
});

test("an opaque sender URL is not passed off as the origin \"null\"", async () => {
  // new URL("about:blank").origin is the STRING "null". Handing that to an allow-list
  // looks like a real origin, matches nothing, and cannot be diagnosed from outside; the
  // next source in the chain must get a turn instead.
  const { onMessage, seen } = bootWithTabs(() => []);
  const resp = await relay(onMessage, { url: "about:blank", origin: "https://claude.ai" }, 2500);
  assert.deepEqual(seen, [{ origin: "https://claude.ai", tabId: undefined }]);
  assert.deepEqual(resp, { success: true });
});
