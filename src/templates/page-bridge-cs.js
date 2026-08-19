// page-bridge-cs.js — content script (isolated world) on the externally_connectable
// origins. Injects page-bridge.js into the MAIN world (a separate world:"MAIN" entry,
// to bypass the page's CSP) and relays page messages to the background as internal
// messages tagged {__bridge:true}, then posts the response back to the page.
(function () {
  var api = typeof browser !== "undefined" ? browser : (typeof chrome !== "undefined" ? chrome : null);
  if (!api) return;
  // Verbose logging OFF by default. Set window.__C2S_DEBUG = true to re-enable.
  // Read at call time, not at load: this runs at document_start, long before anyone
  // can open a console on the page it is relaying for.
  var DEBUG = function () { try { return !!(typeof window !== "undefined" && window.__C2S_DEBUG); } catch (e) { return false; } };
  var DBG = function () { if (DEBUG()) try { console.log.apply(console, arguments); } catch (e) {} };

  // ── two transports, because Safari only sometimes has one ────────────────────
  // A converted MV3 background is a NON-PERSISTENT page, and Safari's delivery to it
  // is unreliable in two distinct ways the shim already documents:
  //   * a sendMessage into a SUSPENDED background is not reliably delivered or
  //     rejected — the promise can simply never settle (the same behavior the shim's
  //     runtime.connect wrapper retries around, where Safari either throws "No
  //     runtime.onConnect listeners found" or hands back a port that dies a tick later);
  //   * on some builds Safari stops delivering content-script messages to an extension
  //     page ENTIRELY, silently, which is why the shim relays extension-page traffic
  //     through chrome.storage.local instead (see the storage relay in the shim).
  // Sending once over sendMessage therefore loses the whole handshake with no error
  // anywhere: the page waits out its timeout and the only trace is a spinning button.
  //
  // So probe both transports and use whichever answers. The probe is a ping the
  // SW-side polyfill answers ITSELF, never forwarded to the extension's own listeners:
  // that works for a bundle with no idea what a "ping" is (the previous probe sent
  // {type:"ping"} into externally_connectable listeners and read "no answer" as "dead
  // background", when for most extensions it just means an unknown message type was
  // ignored), it keeps retries idempotent, and a reply proves the polyfill is installed
  // and listening rather than merely that something is awake.
  var PING_WINDOW_MS = 800, PING_GAP_MS = 700, NATIVE_TRIES = 3;
  // A mailbox attempt polls the reply key for its whole window, so it needs a longer one
  // and fewer repeats than a native send that may simply never settle.
  var MBX_WINDOW_MS = 2000, MBX_TRIES = 3;
  var PAYLOAD_TIMEOUT_MS = 30000;

  // The shim's storage mailbox, verbatim: the background mirrors any
  // __c2sMbxReq:<id> record into its own onMessage listeners (via storage.onChanged, a
  // ~200ms doorbell poll on __c2sMbxBell, and a scan on wake) and writes the answer to
  // __c2sMbxRsp:<id>. Speaking that protocol from here reaches the polyfill's listener
  // without depending on Safari delivering a message at all.
  var REQ = "__c2sMbxReq:", RSP = "__c2sMbxRsp:", BELL = "__c2sMbxBell";
  var store = null;
  try { store = (api.storage && api.storage.local && api.storage.onChanged) ? api.storage : null; } catch (e) { store = null; }

  function uid() { return "cs-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); }

  /** The sender the background should see: this content script's page. */
  function pageSender() {
    var s = {};
    try { s.id = api.runtime.id; } catch (e) {}
    try { s.url = location.href; s.origin = location.origin; } catch (e) {}
    return s;
  }

  // Safari rejects runtime.sendMessage with "Invalid call to runtime.sendMessage(). Tab
  // not found." when it cannot resolve the SENDER's tab — the page is unloading, being
  // discarded, or (routinely, at the end of a successful OAuth flow) has just been
  // navigated away by the extension itself. That is teardown, not a failure: there is no
  // page left to answer. Forwarding it as an error made page-bridge reject the promise it
  // handed the page, and a page on its way out never catches it → "Unhandled Promise
  // Rejection: Invalid call to runtime.sendMessage(). Tab not found." (claude.ai carries
  // that exact string in its own ignore list, so it is well-known noise). It must also
  // not count toward the "background answered no wake ping" diagnosis, which would
  // otherwise blame a perfectly healthy background for a closing tab.
  var TAB_GONE_RE = /tab not found|no tab with id|frame not found|invalidated/i;
  // Sticky: once Safari has told us this page's tab is gone, EVERY diagnostic below is
  // noise about a page that no longer exists — the missing background, the missing page
  // world, all of it. One flag, checked wherever we would otherwise report.
  var tabGone = false;

  /** Both transports resolve {value, gone} — `gone` meaning this page is on its way out. */
  function nativeSend(msg, timeoutMs) {
    return new Promise(function (resolve) {
      var settled = false;
      var done = function (value, gone) {
        if (settled) return; settled = true; clearTimeout(t);
        resolve({ value: value, gone: !!gone });
      };
      var t = setTimeout(function () { done(undefined, false); }, timeoutMs);
      var failed = function (e) {
        var m = String((e && e.message) || e || "");
        var gone = TAB_GONE_RE.test(m);
        if (gone) tabGone = true;
        done(undefined, gone);
      };
      try {
        // Safari's runtime.sendMessage is PROMISE-based and ignores the callback arg
        // (the callback form is a Chrome-ism). Handle both.
        var ret = api.runtime.sendMessage(msg, function (r) {
          var err = null;
          try { err = api.runtime.lastError ? api.runtime.lastError.message : null; } catch (e2) {}
          if (err) return failed(err);
          done(r, false);
        });
        if (ret && typeof ret.then === "function") ret.then(function (r) { done(r, false); }, failed);
      } catch (e) { failed(e); }
    });
  }

  function mailboxSend(msg, timeoutMs) {
    // Storage carries no notion of the sender's tab, so this transport is never "gone".
    if (!store) return Promise.resolve({ value: undefined, gone: false });
    return new Promise(function (resolve) {
      var id = uid(), reqKey = REQ + id, rspKey = RSP + id;
      var done = false, pollT = null, deadline = Date.now() + timeoutMs;
      var onCh = function (ch, area) {
        if (done || area !== "local" || !ch || !ch[rspKey]) return;
        accept(ch[rspKey].newValue);
      };
      function finish(v) {
        if (done) return; done = true;
        clearTimeout(pollT);
        try { store.onChanged.removeListener(onCh); } catch (e) {}
        try { store.local.remove([rspKey, reqKey]); } catch (e) {}
        resolve({ value: v, gone: false });
      }
      function accept(nv) { finish(nv && nv.has ? nv.resp : undefined); }
      // Safari's cross-context storage.onChanged is unreliable in both directions, but
      // storage.local.get always reads the committed value — so poll, and keep
      // onChanged as a best-effort fast path (same rule as the shim's own sender).
      function poll() {
        if (done) return;
        if (Date.now() > deadline) { finish(undefined); return; }
        try {
          store.local.get([rspKey], function (res) {
            if (done) return;
            var nv = res && res[rspKey];
            if (nv) { accept(nv); return; }
            pollT = setTimeout(poll, 120);
          });
        } catch (e) { pollT = setTimeout(poll, 120); }
      }
      try { store.onChanged.addListener(onCh); } catch (e) {}
      var o = {};
      o[reqKey] = { id: id, from: id, sender: pageSender(), msg: msg, t: Date.now() };
      o[BELL] = Date.now();
      try { store.local.set(o, function () { poll(); }); } catch (e) { finish(undefined); }
    });
  }

  // Resolves to the transport that answered: "native" | "mailbox" | null, or "gone" when
  // this page is being torn down. Memoized — every relayed message waits on the same
  // handshake, and a background that has answered once is not re-probed per message.
  var probed = null;
  function transport() {
    if (probed) return probed;
    probed = new Promise(function (resolve) {
      var tries = 0;
      (function attempt() {
        tries++;
        // Repeated sends are also the wake nudge, so keep trying the native path even
        // after falling back; a woken background is the better transport.
        var useMbx = tries > NATIVE_TRIES && store;
        (useMbx ? mailboxSend({ __bridgePing: true }, MBX_WINDOW_MS)
                : nativeSend({ __bridgePing: true }, PING_WINDOW_MS)
        ).then(function (r) {
          if (r.value && r.value.ok) {
            DBG("[bridge-cs] background answered over", useMbx ? "storage mailbox" : "sendMessage", "after", tries, "ping(s)");
            return resolve(useMbx ? "mailbox" : "native");
          }
          // The tab is going away. Nothing is wrong with the extension and there is
          // nobody left to relay for, so stop quietly rather than blaming the background.
          if (r.gone) {
            DBG("[bridge-cs] tab is going away — abandoning the handshake");
            return resolve("gone");
          }
          if (tries >= NATIVE_TRIES + (store ? MBX_TRIES : 0)) {
            console.error("[bridge-cs] background answered no wake ping over either transport (" +
                          NATIVE_TRIES + " via sendMessage" + (store ? ", " + MBX_TRIES + " via storage.local" : "") +
                          "). It is not running, or it threw while loading — check the extension's " +
                          "background console." + (store ? "" : " (No storage permission, so the mailbox fallback is unavailable.)"));
            return resolve(null);
          }
          setTimeout(attempt, PING_GAP_MS);
        });
      })();
    });
    return probed;
  }

  // ── making sure the page world actually got the bridge ───────────────────────
  // page-bridge.js is declared as a separate world:"MAIN" content-script entry,
  // because the isolated world cannot define anything on the PAGE's `chrome`. Safari
  // honors that entry only from 18.4 and ignores it silently below — leaving the page
  // with no `chrome.runtime` at all, so an externally_connectable page messages nobody
  // and its login button spins forever with nothing logged: the relay is healthy, the
  // background is healthy, and the one missing piece is invisible from both.
  //
  // The manifest has always made page-bridge.js web-accessible for exactly this
  // fallback (see applyOAuthBridge) — it just was never performed. So: ASK the page
  // world whether it has the bridge, and on silence inject the same file as a <script>
  // tag, which runs in the page world on every Safari version. A page CSP can refuse
  // the tag (that is what world:"MAIN" exists to sidestep), so say so rather than
  // leaving another silent hole.
  //
  // Asking, rather than waiting for one announcement: the two content scripts are
  // separate script evaluations, so page-bridge.js's eager announcement can be posted
  // before this listener exists. Treating that as "no bridge" would inject a second
  // copy, whose install-once guard returns early and announces nothing — and the relay
  // would then report a bridge-less page that in fact had one all along.
  var PROBE_GRACE_MS = 400, PROBE_WAIT_MS = 250, INJECT_WAIT_MS = 800;
  var mainReady = false;
  window.addEventListener("message", function (ev) {
    if (ev.source !== window || ev.origin !== window.location.origin) return;
    if (ev.data && ev.data.__claudeBridge === "ready") {
      if (!mainReady) DBG("[bridge-cs] page world has the bridge");
      mainReady = true;
    }
  });
  // Ask the page world to confirm, resolving true as soon as it answers. Polled with a
  // recursive setTimeout rather than setInterval: setTimeout is the only timer the rest
  // of these templates assume, and there is no cleanup to get wrong.
  function confirmPageBridge(waitMs) {
    if (mainReady) return Promise.resolve(true);
    try { window.postMessage({ __claudeBridge: "probe" }, window.location.origin); } catch (e) {}
    return new Promise(function (resolve) {
      var deadline = Date.now() + waitMs;
      (function poll() {
        if (mainReady) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(poll, 40);
      })();
    });
  }
  function injectPageBridge() {
    var url = null;
    try { url = api.runtime.getURL("page-bridge.js"); } catch (e) {}
    if (!url) return false;
    DBG("[bridge-cs] no world:MAIN bridge — injecting", url);
    try {
      var s = document.createElement("script");
      s.src = url;
      s.async = false;
      s.onerror = function () {
        console.error("[bridge-cs] page-bridge.js failed to load into the page from " + url +
                      " — the page CSP most likely refused it. Safari runs world:\"MAIN\" " +
                      "content scripts only from 18.4; below that this page cannot be bridged.");
      };
      (document.head || document.documentElement).appendChild(s);
      if (s.parentNode) s.parentNode.removeChild(s);
      return true;
    } catch (e) {
      console.error("[bridge-cs] page-bridge.js injection threw:", String((e && e.message) || e));
      return false;
    }
  }
  setTimeout(function () {
    if (tabGone) return;
    confirmPageBridge(PROBE_WAIT_MS).then(function (ok) {
      if (ok || tabGone) return;
      if (!injectPageBridge()) return;
      confirmPageBridge(INJECT_WAIT_MS).then(function (ok2) {
        if (ok2 || tabGone) return;
        console.error("[bridge-cs] the page has no chrome.runtime even after injecting " +
                      "page-bridge.js — the page CSP most likely blocked it, so this page " +
                      "cannot message the extension. On Safari 18.4+ the world:\"MAIN\" " +
                      "content script covers this.");
      });
    });
  }, PROBE_GRACE_MS);

  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    if (ev.origin !== window.location.origin) return;
    var d = ev.data;
    if (!d || d.__claudeBridge !== "page") return;
    var mtype = d.msg && d.msg.type ? d.msg.type : "(no type)";
    DBG("[bridge-cs] relay page->SW", mtype, "reqId", d.reqId);
    var done = false;
    function back(response, err) {
      if (done) return; done = true;
      clearTimeout(t);
      DBG("[bridge-cs] SW resp", mtype, d.reqId, err ? ("ERR " + err) : (response ? "(ok)" : response));
      window.postMessage({ __claudeBridge: "cs", reqId: d.reqId, response: response, error: err }, window.location.origin);
    }
    // The clock starts when the page asks, not after the handshake, so a page waiting
    // on a dead background still hears back instead of spinning forever.
    var t = setTimeout(function () {
      back(undefined, "no response after 30s (background not running or not receiving?)");
    }, PAYLOAD_TIMEOUT_MS);
    // Exactly ONE transport, exactly ONE send: an OAuth code is single-use, so replaying
    // the payload would trade a hang for a token exchange that fails the second time.
    // When nothing answered the ping, still try natively — best effort beats dropping the
    // message, and the timeout above reports it.
    transport().then(function (via) {
      if (done) return;
      if (via === "gone") { done = true; clearTimeout(t); return; }
      var send = (via === "mailbox") ? mailboxSend : nativeSend;
      send({ __bridge: true, payload: d.msg }, PAYLOAD_TIMEOUT_MS).then(function (r) {
        // The tab went away mid-flight (routinely: the extension navigated it away after
        // a successful OAuth exchange). There is no page left to answer, and rejecting
        // page-bridge's promise into an unloading page is what produced "Unhandled
        // Promise Rejection: … Tab not found." Drop it instead.
        if (r.gone) { done = true; clearTimeout(t); return; }
        if (r.value === undefined) {
          var err = null;
          try { err = api.runtime.lastError ? api.runtime.lastError.message : null; } catch (e) {}
          back(undefined, err || "background did not answer (" + (via || "sendMessage") + ")");
          return;
        }
        back(r.value, null);
      });
    });
  });
  DBG("[bridge-cs] installed v5 — probing background…");

  // Start the handshake at load so the background is up before the user clicks
  // anything, and so a genuinely dead background is reported once, up front.
  transport();
})();
