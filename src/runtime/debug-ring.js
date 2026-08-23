// Persistent debug ring buffer. This file is NOT staged on its own: shimSource()
// splices it into safari-compat-shim.js (over the marker line under the
// __C2S_DEBUG__ gate) only for a --debug conversion, so a release shim carries
// no trace of it. It runs at the shim's top level, ABOVE the outer try — the
// cardinal rule applies in full: nothing here may ever throw.
//
// Every gated trace in the shim tees into __C2S_DEBUG_WRITE__. Entries are
// { t: epoch-ms, ctx: "background"|"content"|"page", msg } — batched behind one
// timer per flush window so logging can never hammer storage, and persisted to
// storage.local under __viaduct_debug_log__ capped to the last 2000 entries.
// Read them back with `viaduct --logs <name>` (Safari keeps storage.local as
// SQLite on disk) or the console one-liner in wiki/Testing-and-Debugging.md.
var __C2S_DEBUG_WRITE__ = (function () {
  try {
    var KEY = "__viaduct_debug_log__";
    var CAP = 2000;
    var FLUSH_MS = 1000;
    var api = null;
    try {
      api = (typeof browser !== "undefined" && browser && browser.storage && browser.storage.local) ? browser
        : ((typeof chrome !== "undefined" && chrome && chrome.storage && chrome.storage.local) ? chrome : null);
    } catch (e) {}
    // The OAuth-bridge templates (identity-polyfill, page-bridge-cs) read the
    // __C2S_DEBUG global at CALL time; light them up wherever the shim runs so a
    // --debug build gets their named diagnostics without a console visit.
    try { if (typeof self !== "undefined") self.__C2S_DEBUG = true; } catch (e) {}
    try { if (typeof window !== "undefined") window.__C2S_DEBUG = true; } catch (e) {}
    var ctx = "page";
    try {
      if (api) {
        var proto = (typeof location !== "undefined" && location.protocol) || "";
        if (proto === "safari-web-extension:" || proto === "chrome-extension:" || proto === "moz-extension:") {
          ctx = "background";
          // Extension pages that are not THE background page (popup, options) log as "page".
          try {
            if (api.extension && api.extension.getBackgroundPage && typeof window !== "undefined"
                && api.extension.getBackgroundPage() !== window) ctx = "page";
          } catch (e) {}
        } else {
          ctx = "content";
        }
      }
    } catch (e) {}
    var pending = [];
    var timer = null;
    function fmt(a) {
      try {
        if (typeof a === "string") return a;
        if (a instanceof Error) return String(a.message || a);
        return JSON.stringify(a);
      } catch (e) { try { return String(a); } catch (e2) { return "<unprintable>"; } }
    }
    function persist(batch) {
      if (!api) return;
      // Some backends call the trailing callback, some resolve a Promise, and the
      // polyfill browser.* does only the latter — guard against both firing.
      var done = false;
      var merge = function (res) {
        if (done) return;
        done = true;
        try {
          var arr = (res && res[KEY]) || [];
          if (!Array.isArray(arr)) arr = [];
          arr = arr.concat(batch);
          if (arr.length > CAP) arr = arr.slice(arr.length - CAP);
          var obj = {};
          obj[KEY] = arr;
          try {
            var p = api.storage.local.set(obj, function () { try { void (api.runtime && api.runtime.lastError); } catch (e) {} });
            if (p && typeof p.catch === "function") p.catch(function () {});
          } catch (e) {}
        } catch (e) {}
      };
      try {
        var r = api.storage.local.get(KEY, function (res) {
          try { void (api.runtime && api.runtime.lastError); } catch (e) {}
          merge(res);
        });
        if (r && typeof r.then === "function") r.then(merge, function () {});
      } catch (e) {
        // Promise-only backend that rejects a trailing callback argument.
        try { api.storage.local.get(KEY).then(merge, function () {}); } catch (e2) {}
      }
    }
    function flush() {
      timer = null;
      if (!pending.length) return;
      var batch = pending;
      pending = [];
      try { persist(batch); } catch (e) {}
    }
    return function (args) {
      try {
        var parts = [];
        for (var i = 0; i < args.length; i++) parts.push(fmt(args[i]));
        pending.push({ t: Date.now(), ctx: ctx, msg: parts.join(" ") });
        if (pending.length > CAP) pending.splice(0, pending.length - CAP);
        if (timer == null) timer = setTimeout(flush, FLUSH_MS);
      } catch (e) {}
    };
  } catch (e) {
    return function () {};
  }
})();
