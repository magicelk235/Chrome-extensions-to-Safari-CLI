// identity-polyfill.js — Safari chrome.identity shim for OAuth.
// Verbose logging is OFF by default (it can leak OAuth tokens into the console).
// Set self.__C2S_DEBUG = true to re-enable diagnostic logs. The flag is read at CALL
// time, not at load: this file runs before the bundle, so a load-time read can only
// ever be flipped by editing the build, and diagnosing a dead page->SW handshake
// means turning logging on in a background console that is already running.
(function () {
  "use strict";
  var DEBUG = function () {
    try {
      if (typeof self !== "undefined" && self.__C2S_DEBUG) return true;
      if (typeof globalThis !== "undefined" && globalThis.__C2S_DEBUG) return true;
    } catch (e) {}
    return false;
  };
  var DBG = function () { if (DEBUG()) try { console.log.apply(console, arguments); } catch (e) {} };
  var DBGW = function () { if (DEBUG()) try { console.warn.apply(console, arguments); } catch (e) {} };
  // Install-once: background.html loads this as a classic script (so the
  // onMessageExternal capture beats hoisted importScripts chunks) AND the SW
  // module imports it; the second evaluation must be a no-op or listeners
  // double-dispatch.
  var __g = typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : {});
  if (__g.__c2sIdentityPolyfill) { return; }
  __g.__c2sIdentityPolyfill = true;
  var api = typeof self !== "undefined" && self.chrome ? self.chrome
          : (typeof chrome !== "undefined" ? chrome : null);
  if (!api) { DBGW("[idpoly] no chrome api"); return; }

  // Chrome's chrome.identity.getRedirectURL() bases the redirect on the
  // extension's OWN id. Derive it from the live runtime so this works for ANY
  // converted extension instead of a single hardcoded id. Fall back to the
  // build-time placeholder only if runtime.id is somehow unavailable.
  var EXT_ID = "__C2S_EXTENSION_ID__";
  if (EXT_ID === "__C2S_" + "EXTENSION_ID__") EXT_ID = (api.runtime && api.runtime.id) || "";
  var REDIRECT_BASE = "https://" + EXT_ID + ".chromiumapp.org/";
  DBG("[idpoly] loaded. native identity?", !!api.identity,
              "tabs?", !!api.tabs, "webNavigation?", !!api.webNavigation,
              "REDIRECT_BASE", REDIRECT_BASE);

  // Surface any throw during SW bundle module-eval. A missing-API TypeError there
  // aborts evaluation BEFORE onMessageExternal registers, but can be easy to miss
  // in the console — log it loudly with a stack so the failing API is obvious.
  try {
    self.addEventListener("error", function (e) {
      console.error("[idpoly] GLOBAL ERROR:", (e && e.message) || e,
                    e && e.filename, e && e.lineno, e && e.error && e.error.stack);
    });
    self.addEventListener("unhandledrejection", function (e) {
      var r = e && e.reason;
      console.error("[idpoly] UNHANDLED REJECTION:", r && (r.stack || r.message || r));
    });
  } catch (e) { /* no event target */ }

  function getRedirectURL(path) {
    var u = !path ? REDIRECT_BASE : REDIRECT_BASE + String(path).replace(/^\//, "");
    DBG("[idpoly] getRedirectURL ->", u);
    return u;
  }

  function launchWebAuthFlow(details, callback) {
    DBG("[idpoly] launchWebAuthFlow", JSON.stringify(details));
    var p = new Promise(function (resolve, reject) {
      var authUrl = details && details.url;
      if (!authUrl) { reject(new Error("launchWebAuthFlow: missing url")); return; }

      // The redirect target is whatever redirect_uri the caller embedded in the
      // authorize URL (chromiumapp.org for one flow, chrome-extension://.../
      // oauth_callback.html for another). Watch for navigation to THAT, not a
      // hardcoded base — that is what Chrome's launchWebAuthFlow does.
      var redirectTarget = REDIRECT_BASE;
      try {
        var ru = new URL(authUrl).searchParams.get("redirect_uri");
        if (ru) redirectTarget = ru;
      } catch (e) { /* keep default */ }
      DBG("[idpoly] redirectTarget", redirectTarget);

      if (!api.tabs || !api.webNavigation) {
        reject(new Error("launchWebAuthFlow requires the tabs + webNavigation APIs, which are unavailable"));
        return;
      }
      // `interactive: false` is a silent token refresh, not a login. Chrome runs it with
      // no visible UI and gives up quickly when the provider would need the user; a
      // converted extension has only a real tab to work with, so keep that tab in the
      // background and hold it to the caller's own short deadline.
      //
      // This matters for staying signed in. A bundle whose tokens live in
      // storage.session loses them when Safari tears the background page down, and its
      // designed recovery is exactly this silent re-auth (prompt=none plus a
      // login_hint). Done with a focused tab and a 120s ceiling, every wake would steal
      // focus and leave a stray tab sitting there long after the caller had given up
      // and shown a login screen.
      var interactive = !(details && details.interactive === false);
      var quietMs = Number(details && details.timeoutMsForNonInteractive) || 5000;
      // Chrome's default: a page that finishes loading without redirecting means the
      // provider wants the user, so the silent attempt is over.
      var abortOnLoad = !(details && details.abortOnLoadForNonInteractive === false);
      api.tabs.create({ url: authUrl, active: interactive }, function (tab) {
        if (api.runtime.lastError || !tab) {
          console.error("[idpoly] tab create err", api.runtime.lastError);
          reject(new Error((api.runtime.lastError && api.runtime.lastError.message) || "tab create failed"));
          return;
        }
        var tabId = tab.id;
        var settled = false;
        DBG("[idpoly] auth tab", tabId, "interactive", interactive, "url", authUrl);
        // The caller's non-interactive deadline is meant to bound how long the PROVIDER
        // takes to answer, which is what it measures in Chrome. Here it would also be
        // paying for a tab being created and Safari loading the authorize page cold,
        // through whatever edge sits in front of it, and a 5s budget (Claude's) is
        // routinely gone before the provider is even asked. The redirect then arrives
        // after the attempt was abandoned, the caller falls back to an interactive login,
        // and the user gets a tab flashing past and a login screen for no reason.
        //
        // So allow the setup separately, and start the caller's clock when the auth page
        // first navigates. A hard ceiling still bounds the whole thing, since the caller
        // is usually racing a timer of its own.
        var SILENT_SETUP_MS = 8000, SILENT_CEILING_MS = 20000;
        var timer = null, clockStarted = false;
        function arm(ms, why) {
          clearTimeout(timer);
          timer = setTimeout(function () {
            DBGW("[idpoly] TIMEOUT", tabId, why);
            if (settled) return;
            settled = true;
            cleanup();
            try { api.tabs.remove(tabId, function () { void api.runtime.lastError; }); } catch (e) {}
            reject(new Error(interactive ? "launchWebAuthFlow timeout" : "launchWebAuthFlow: no silent redirect (" + why + ")"));
          }, ms);
        }
        // Bound the whole attempt regardless of what the phases do.
        var ceiling = interactive ? null : setTimeout(function () {
          if (!settled) arm(0, "ceiling");
        }, SILENT_CEILING_MS);
        function startCallerClock() {
          if (clockStarted || interactive || settled) return;
          clockStarted = true;
          DBG("[idpoly] auth page navigated; caller's silent window starts now:", quietMs + "ms");
          arm(quietMs, "provider did not redirect");
        }
        arm(interactive ? 120000 : SILENT_SETUP_MS, interactive ? "user did not finish" : "tab never navigated");

        function captured(url) {
          if (typeof url !== "string" || url.indexOf(redirectTarget) !== 0) return false;
          // Require a clean boundary after the redirect target so a longer host/path
          // that merely STARTS with it (e.g. ".../cb.html.evil/") is not mistaken for
          // the trusted callback. Chrome matches the redirect URL, not an arbitrary
          // prefix. End-of-string, "/", "?" or "#" are the only valid continuations.
          var next = url.charAt(redirectTarget.length);
          return next === "" || next === "/" || next === "?" || next === "#";
        }
        function onNav(d) {
          // Only the auth tab's TOP-LEVEL navigation may complete the flow. Chrome's
          // launchWebAuthFlow watches its dedicated auth window's main frame; without
          // the frameId===0 check a sub-iframe navigating to a URL that startsWith the
          // redirect target would resolve the flow with a frame-controlled URL the
          // caller then parses for the OAuth code/token.
          if (d.tabId !== tabId || d.frameId !== 0) return;
          DBG("[idpoly] nav", d.url);
          if (captured(d.url)) { finish(resolve, d.url); return; }
          // The provider has been reached; from here the caller's own window applies.
          startCallerClock();
        }
        function onErr(d) {
          if (d.tabId !== tabId || d.frameId !== 0) return;
          DBG("[idpoly] navERR", d.url, d.error);
          if (captured(d.url)) finish(resolve, d.url);
        }
        function onRemoved(id) {
          if (id === tabId) { DBGW("[idpoly] tab removed"); finish(reject, new Error("auth tab closed")); }
        }
        function onDone(d) {
          if (d.tabId !== tabId || d.frameId !== 0) return;
          if (captured(d.url)) { finish(resolve, d.url); return; }
          // A silent attempt whose page finished loading somewhere other than the
          // redirect target is the provider asking for the user. Chrome ends the
          // attempt there; hanging on would keep a background tab open on a login
          // screen the caller has already stopped waiting for.
          if (!interactive && abortOnLoad) {
            DBG("[idpoly] silent attempt needs interaction, aborting");
            finish(reject, new Error("launchWebAuthFlow: interaction required"));
          }
        }
        function cleanup() {
          clearTimeout(timer);
          clearTimeout(ceiling);
          api.webNavigation.onBeforeNavigate.removeListener(onNav);
          api.webNavigation.onCommitted.removeListener(onNav);
          api.webNavigation.onCompleted.removeListener(onDone);
          api.webNavigation.onErrorOccurred.removeListener(onErr);
          api.tabs.onRemoved.removeListener(onRemoved);
        }
        function finish(fn, arg) {
          if (settled) return;
          settled = true;
          cleanup();
          // Redact the OAuth token/code: the redirect URL carries it in the query/
          // fragment, so log only origin+path, never the full URL.
          var redacted = arg;
          if (fn === resolve && typeof arg === "string") {
            try { var ru = new URL(arg); redacted = ru.origin + ru.pathname + " (params redacted)"; } catch (e) { redacted = "(redirect url redacted)"; }
          }
          DBG("[idpoly] finish ->", (fn === resolve ? "RESOLVE " + redacted : "reject " + arg));
          try { api.tabs.remove(tabId, function () { void api.runtime.lastError; }); } catch (e) {}
          fn(arg);
        }

        api.webNavigation.onBeforeNavigate.addListener(onNav);
        api.webNavigation.onCommitted.addListener(onNav);
        api.webNavigation.onCompleted.addListener(onDone);
        api.webNavigation.onErrorOccurred.addListener(onErr);
        api.tabs.onRemoved.addListener(onRemoved);
      });
    });

    if (typeof callback === "function") {
      p.then(function (u) { callback(u); }, function (err) {
        // Chrome invokes the callback with undefined AND sets lastError for its
        // duration; without it callers can't tell failure from empty success
        // (getAuthToken below already follows this contract).
        try { if (api.runtime) api.runtime.lastError = { message: (err && err.message) || "launchWebAuthFlow failed" }; } catch (e) {}
        try { callback(undefined); } finally { try { if (api.runtime) delete api.runtime.lastError; } catch (e) {} }
      });
      return;
    }
    return p;
  }

  var identity = api.identity || {};
  identity.getRedirectURL = getRedirectURL;
  identity.launchWebAuthFlow = launchWebAuthFlow;
  if (!identity.removeCachedAuthToken) identity.removeCachedAuthToken = function (d, cb) { if (cb) cb(); return Promise.resolve(); };
  if (!identity.getAuthToken) identity.getAuthToken = function () {
    // getAuthToken(details, cb) is callback-based in Chrome. Honor a trailing
    // callback (invoking it with undefined + a lastError-style note) so callers
    // don't hang on an ignored callback or an unhandled promise rejection.
    var cb = arguments.length && typeof arguments[arguments.length - 1] === "function"
           ? arguments[arguments.length - 1] : null;
    if (cb) {
      // Chrome scopes runtime.lastError to the callback's duration only. Set it,
      // invoke cb, then clear it — a persistent lastError misreports every later call.
      try { if (api.runtime) api.runtime.lastError = { message: "getAuthToken unsupported" }; } catch (e) {}
      try { cb(undefined); } finally { try { if (api.runtime) delete api.runtime.lastError; } catch (e) {} }
      return;
    }
    return Promise.reject(new Error("getAuthToken unsupported"));
  };
  api.identity = identity;
  DBG("[idpoly] identity patched");

  // --- page<->extension bridge (SW side) ---------------------------------
  // Safari requires the page to pass the (Safari) extension id to message the
  // SW, but pages typically hardcode the Chrome id, so page->ext messaging fails
  // ("Chrome extension API not available"). A content script relays page
  // messages to the SW as internal messages tagged {__bridge:true}. Here we
  // capture the extension's onMessageExternal listeners and re-dispatch those
  // tagged messages to them, synthesizing sender.origin so origin checks pass.
  // An opaque URL (about:blank, data:, a sandboxed frame) parses to the STRING "null".
  // Returning that would hand an allow-list a plausible-looking origin that matches
  // nothing and can never be diagnosed from the outside; treat it as no answer so the
  // next source in the chain gets a turn.
  function safeOrigin(u) {
    try {
      var o = new URL(u).origin;
      return o && o !== "null" ? o : undefined;
    } catch (e) { return undefined; }
  }
  /** URL without query/fragment — a tab's URL and the sender's must agree on the path. */
  function samePage(u) { try { return String(u).split(/[?#]/)[0]; } catch (e) { return ""; } }
  /**
   * The tab a bridged page message came from. Matched by URL across all tabs, then the
   * active tab of the last-focused window, then nothing. Never throws, and resolves
   * within 1.5s whatever happens — a handler waiting on this must not be the reason a
   * page hangs.
   *
   * The active-tab fallback exists because reading `tab.url` needs the tabs (or a host)
   * permission: without it every tab comes back url-less and no match is possible. But
   * it must never hand over a tab we can SEE belongs to another site — a handler acting
   * on sender.tab.id navigates it (Claude's oauth_redirect does exactly that), and
   * navigating a user's unrelated tab away is worse than supplying no tab at all. So the
   * fallback is taken only when the candidate's origin matches, or when its URL is
   * unreadable and therefore cannot be contradicted.
   */
  function findSenderTab(url, origin) {
    return new Promise(function (resolve) {
      var settled = false;
      var finish = function (t) { if (!settled) { settled = true; resolve(t); } };
      setTimeout(function () { finish(undefined); }, 1500);
      var tabs = api.tabs;
      if (!tabs || typeof tabs.query !== "function") return finish(undefined);
      var want = samePage(url);
      var query = function (q, cb) {
        try {
          var r = tabs.query(q, function (list) { cb(list); });
          if (r && typeof r.then === "function") r.then(cb, function () { cb(null); });
        } catch (e) { cb(null); }
      };
      query({}, function (all) {
        if (want && all && all.length) {
          for (var i = 0; i < all.length; i++) {
            if (all[i] && all[i].url && samePage(all[i].url) === want) return finish(all[i]);
          }
        }
        query({ active: true, lastFocusedWindow: true }, function (act) {
          var t = act && act.length ? act[0] : undefined;
          if (!t) return finish(undefined);
          if (!t.url) return finish(t);                       // unreadable → can't contradict
          if (origin && safeOrigin(t.url) === origin) return finish(t);
          DBG("[idpoly] active tab is a different origin than the sender — no tab supplied");
          finish(undefined);
        });
      });
    });
  }

  var extListeners = [];
  // Capture the SW's onMessageExternal handler so bridged page messages can be
  // dispatched to it. Safari may expose onMessageExternal as a read-only/native
  // event; under "use strict" a naive `addListener =` reassignment THROWS and
  // aborts this whole polyfill, leaving the bridge dead (tab opens, login never
  // finishes). Replace the event object wholesale via defineProperty, with
  // progressive fallbacks, so addListener is always captured here.
  (function () {
    var rt = api.runtime;
    if (!rt) { DBGW("[idpoly] no runtime for onMessageExternal capture"); return; }
    var nativeExt = rt.onMessageExternal;
    var nativeAdd = (nativeExt && typeof nativeExt.addListener === "function")
                  ? nativeExt.addListener.bind(nativeExt) : null;
    DBG("[idpoly] native onMessageExternal?", !!nativeExt, "nativeAdd?", !!nativeAdd);
    // Single capture sink. Whether the SW bundle calls addListener on our
    // defineProperty shadow OR on the original native event object, the listener
    // must land here — else extListeners stays empty and bridged page messages
    // have nowhere to go ("no external listener captured"). Also forward to the
    // native event so genuine external messages still work.
    var forwarded = [];
    function capture(l) {
      if (typeof l !== "function") return;
      if (extListeners.indexOf(l) < 0) {
        extListeners.push(l);
        DBG("[idpoly] captured onMessageExternal listener; total", extListeners.length);
      }
      // capture can be reached via both the defineProperty shadow and the native
      // in-place wrap for the same listener; dedupe the native forward too, or the
      // native event fires the listener twice for genuine external messages.
      if (nativeAdd && forwarded.indexOf(l) < 0) {
        forwarded.push(l);
        try { nativeAdd(l); } catch (e) { /* native may reject */ }
      }
    }
    var controlled = {
      addListener: capture,
      removeListener: function (l) {
        var i = extListeners.indexOf(l); if (i >= 0) extListeners.splice(i, 1);
        // capture() also forwarded the listener to the native event; detach it
        // there too or genuine external messages keep firing a "removed" listener.
        var f = forwarded.indexOf(l);
        if (f >= 0) {
          forwarded.splice(f, 1);
          try { if (nativeExt && typeof nativeExt.removeListener === "function") nativeExt.removeListener(l); } catch (e) {}
        }
      },
      hasListener: function (l) { return extListeners.indexOf(l) >= 0; }
    };
    // (1) Replace the event object so `rt.onMessageExternal.addListener` hits us.
    try {
      Object.defineProperty(rt, "onMessageExternal", { value: controlled, configurable: true, writable: true });
      DBG("[idpoly] onMessageExternal replaced via defineProperty");
    } catch (e1) {
      try { rt.onMessageExternal = controlled; DBG("[idpoly] onMessageExternal replaced via assignment"); }
      catch (e2) { DBGW("[idpoly] could not replace onMessageExternal object", e2); }
    }
    // (2) ALSO patch addListener on the ORIGINAL native object in place, in case
    // the bundle reaches the native event reference directly (Safari may hand out
    // a runtime/event object distinct from our shadow). Belt and suspenders.
    if (nativeExt && nativeExt !== controlled) {
      try {
        Object.defineProperty(nativeExt, "addListener", { value: capture, configurable: true, writable: true });
        DBG("[idpoly] native onMessageExternal.addListener wrapped");
      } catch (e3) {
        try { nativeExt.addListener = capture; DBG("[idpoly] native onMessageExternal.addListener wrapped (assign)"); }
        catch (e4) { DBGW("[idpoly] could not wrap native onMessageExternal.addListener", e4); }
      }
    }
  })();
  if (api.runtime && api.runtime.onMessage) {
    api.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg) return;
      // The relay's wake handshake. Answered here, never forwarded to the
      // extension's own listeners: it has to work for a bundle that knows nothing
      // about a "ping", and the relay repeats it until it lands, so it must not
      // reach anything with a side effect. A reply also proves more than that the
      // background is awake — it proves THIS polyfill is installed and listening,
      // which is the whole precondition for the bridge.
      if (msg.__bridgePing === true) {
        try { sendResponse({ ok: true }); } catch (e) {}
        return Promise.resolve({ ok: true });
      }
      if (msg.__bridge !== true) return;
      // The bridged message's real sender is the PAGE, and Chrome's external sender
      // reports that page's own url/origin. The relay hands us a CONTENT SCRIPT
      // sender instead, whose `origin` is whatever Safari chose to put there — not
      // necessarily the page's (Safari has been observed reporting an extension
      // origin on senders it builds itself). The page URL is the authoritative
      // source, so derive from it first and keep sender.origin only as the last
      // resort: an extension gating on `sender.origin === "https://site"` (Claude's
      // oauth_redirect handler, verbatim) otherwise fails the gate, answers nothing,
      // and leaves the page's Authorize button spinning with nothing logged.
      var origin = safeOrigin(sender.url) ||
                   (sender.tab && sender.tab.url ? safeOrigin(sender.tab.url) : undefined) ||
                   sender.origin;
      var fixed = Object.assign({}, sender, { origin: origin });
      var mtype = (msg.payload && msg.payload.type) || "(no type)";
      DBG("[idpoly] bridge msg", JSON.stringify(msg.payload), "origin", origin,
                  "listeners", extListeners.length);
      // Return a Promise so Safari/Firefox deliver the async response. Safari
      // IGNORES `return true`, so a `return true` + async sendResponse drops the
      // reply and the page hangs forever. Also call sendResponse for Chrome
      // callers (Chrome ignores the returned Promise).
      return new Promise(function (resolve) {
        var settled = false;
        var resp = function (r) {
          if (settled) return; settled = true;
          DBG("[idpoly] bridge resp ->", (r && r.success === false) ? JSON.stringify(r) : "(ok, payload redacted)");
          try { sendResponse(r); } catch (e) {}
          resolve(r);
        };
        if (extListeners.length === 0) {
          console.error("[idpoly] bridge msg but NO captured onMessageExternal listeners — SW handler not registered/captured");
          resp({ success: false, error: "bridge: no external listener captured" });
          return;
        }
        function dispatch(s) {
          // Chrome's channel contract: a listener keeps the channel open only by
          // returning true (or a Promise). If none does, close it now — otherwise a
          // fire-and-forget message leaves the page waiting out its 30s timeout.
          var willRespond = false;
          for (var i = 0; i < extListeners.length; i++) {
            try {
              var ret = extListeners[i](msg.payload, s, resp);
              if (ret === true) willRespond = true;
              else if (ret && typeof ret.then === "function") { willRespond = true; ret.then(resp, function () { resp(undefined); }); }
            } catch (e) { console.error("[idpoly] extListener err", e); }
          }
          if (!willRespond && !settled) { resp(undefined); return; }
          // A listener held the channel open and never answered. Chrome only does that
          // when its own gate rejected the message (an origin allow-list, usually), and
          // the page then waits out the relay's timeout with no error anywhere. Name it
          // once instead: which message, which origin the listeners were handed.
          setTimeout(function () {
            if (settled) return;
            console.error("[idpoly] bridge msg '" + mtype + "' accepted by " + extListeners.length +
                          " onMessageExternal listener(s) but none answered — sender.origin was '" +
                          origin + "'. The extension's own origin check most likely rejected it.");
          }, 5000);
        }
        // Chrome always gives an external message from a page a sender.tab — the page
        // IS in a tab — and handlers act on it: Claude's oauth_redirect finishes by
        // navigating `sender.tab.id` to claude.ai/chrome/installed, which is what
        // dismisses the consent window. The relay's storage-mailbox transport cannot
        // supply one (a content script can't read its own tab id, and the shim's own
        // selfSender has the same gap), so the handler saw `undefined`, skipped the
        // navigation, and left a logged-in user staring at a spinner. Resolve it here
        // from the page URL before dispatching.
        if (fixed.tab && fixed.tab.id != null) { dispatch(fixed); return; }
        findSenderTab(sender.url, origin).then(function (t) {
          dispatch(t && t.id != null ? Object.assign({}, fixed, { tab: t }) : fixed);
        });
      });
    });
  }
})();
