// Emulates the ServiceWorkerGlobalScope lifecycle surface inside the converted
// MV3 background PAGE (loaded only by the generated background.html, before the
// compat shim and the SW module). Real SW bundles branch on this surface at eval:
//
//   self.addEventListener("install", boot);                 // first-install path
//   "activated" === self.serviceWorker.state && boot();     // SW-restart path
//
// A plain page has neither, so `self.serviceWorker.state` throws (or boot simply
// never runs) and the extension is dead before it registers any listeners
// (MetaMask's app-init is exactly this shape). Report state "parsed" during
// evaluation — the truthful first-install answer — then walk the real state
// machine (installing → installed → activating → activated) AFTER
// DOMContentLoaded: by then every deferred script (the SW module and any
// pre-registered webpack chunks — see convertServiceWorkerToBackgroundPage) has
// executed, so install handlers see the same module graph importScripts would
// have produced. Fires on every background-page start; that matches Chrome's
// first-install sequence, which every well-formed SW must already handle.
(function () {
  "use strict";
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (self.serviceWorker) return;

  var listeners = {};
  var sw = {
    scriptURL: String(location.href),
    state: "parsed",
    onstatechange: null,
    postMessage: function () {},
    addEventListener: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: function (type, fn) {
      var l = listeners[type] || [];
      var i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
  };

  function setState(state) {
    sw.state = state;
    var ev;
    try { ev = new Event("statechange"); } catch (e) { ev = { type: "statechange", target: sw }; }
    if (typeof sw.onstatechange === "function") { try { sw.onstatechange.call(sw, ev); } catch (e) {} }
    // Snapshot before dispatch so a self-removing listener can't skip a sibling.
    var snap = (listeners.statechange || []).slice();
    for (var i = 0; i < snap.length; i++) { try { snap[i].call(sw, ev); } catch (e) {} }
  }

  // Dispatch an ExtendableEvent-shaped lifecycle event on self and resolve once
  // every waitUntil() promise settles. Rejections are swallowed — a failed
  // install extender must not wedge the page in "installing" forever (the page
  // is already committed; there is no not-installing fallback to fall back to).
  function dispatchExtendable(type) {
    var pending = [];
    var ev;
    try { ev = new Event(type); } catch (e) {
      ev = document.createEvent("Event");
      ev.initEvent(type, false, false);
    }
    try { ev.waitUntil = function (p) { pending.push(Promise.resolve(p).catch(function () {})); }; } catch (e) {}
    try { self.dispatchEvent(ev); } catch (e) {}
    return Promise.all(pending);
  }

  try { self.serviceWorker = sw; } catch (e) {}
  if (typeof self.skipWaiting !== "function") {
    try { self.skipWaiting = function () { return Promise.resolve(); }; } catch (e) {}
  }

  // A bundle also asks whether it IS the worker, and routes on the answer:
  //
  //   if ("ServiceWorkerGlobalScope" in globalThis) return readTokenLocally();
  //   const r = await chrome.runtime.sendMessage({ type: "check_and_refresh_oauth" });
  //
  // In Chrome the background is a ServiceWorkerGlobalScope, so it takes the local
  // branch while panels and popups ask it over messaging. The conversion makes the
  // background a PAGE, the global disappears, and the background falls into the
  // asking branch: it messages itself, nothing answers (no context receives its own
  // runtime message), and the work never happens. Claude for Chrome routes its OAuth
  // refresh exactly this way, so the token stops being refreshed and the user is sent
  // back to a login screen once it expires.
  //
  // A build-time rewrite cannot fix this, because the module that asks is usually
  // shared with the panel, where the answer must stay NO. So answer at runtime, and
  // only here: this file is loaded by the generated background.html alone. Other
  // extension pages keep seeing no worker scope and keep asking the background, which
  // is what keeps one refresh in one place rather than two racing over a
  // single-use refresh token.
  if (typeof self.ServiceWorkerGlobalScope === "undefined") {
    try {
      var SWGS = function ServiceWorkerGlobalScope() {};
      // `self instanceof ServiceWorkerGlobalScope` is the other half of the idiom.
      try {
        Object.defineProperty(SWGS, Symbol.hasInstance, {
          value: function (o) { return o === self || o === globalThis; },
        });
      } catch (e) {}
      SWGS.prototype = Object.create(Object.prototype);
      self.ServiceWorkerGlobalScope = SWGS;
    } catch (e) {}
  }

  function run() {
    setState("installing");
    dispatchExtendable("install")
      .then(function () {
        setState("installed");
        setState("activating");
        return dispatchExtendable("activate");
      })
      .then(function () {
        setState("activated");
        // Keep the shim's registration stub coherent for post-boot inspection.
        try { if (self.registration && !self.registration.active) self.registration.active = sw; } catch (e) {}
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
