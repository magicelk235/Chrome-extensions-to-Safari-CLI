import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// The --debug staging contract. shimSource({ debug: true }) flips the compiled-in
// __C2S_DEBUG__ gate to true and splices the persistent ring-buffer logger over
// its marker line, so traces mirror into storage.local __viaduct_debug_log__.
// The default emit carries NEITHER: a release shim must have no ring-buffer
// write path at all — not present-but-dormant, absent. And a debug emit is
// still bound by the cardinal rule: it must never throw at top level, even in
// a context with no extension API whatsoever.

test("debug emit flips the gate on and installs the ring buffer", () => {
  const src = shimSource({ debug: true });
  assert.ok(src.includes("var __C2S_DEBUG__ = true;"), "gate flipped to true");
  assert.ok(!src.includes("var __C2S_DEBUG__ = false;"), "no stale false gate");
  assert.ok(src.includes("__viaduct_debug_log__"), "ring-buffer storage key present");
});

test("default emit keeps the gate off and has no ring-buffer write path", () => {
  for (const src of [shimSource(), shimSource({ debug: false })]) {
    assert.ok(src.includes("var __C2S_DEBUG__ = false;"), "gate stays false");
    assert.ok(!src.includes("var __C2S_DEBUG__ = true;"), "gate never true");
    assert.ok(!src.includes("__viaduct_debug_log__"), "no ring key anywhere");
    assert.ok(!src.includes("__C2S_DEBUG_WRITE__ = "), "no ring writer installed");
  }
});

test("debug emit never throws at top level, even with no extension API", () => {
  const sandbox = { console, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource({ debug: true }), sandbox); // must not throw
  assert.equal(typeof sandbox.__C2S_DEBUG_WRITE__, "function", "ring writer defined");
  // API-less context (page world): a write must be a swallowed no-op, not a throw.
  sandbox.__C2S_DEBUG_WRITE__(["probe entry"]);
});
