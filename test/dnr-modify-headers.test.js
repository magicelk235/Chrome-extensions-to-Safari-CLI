import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { shimSource } from "../dist/runtime/shim.js";
import { applyDnr, stripModifyHeaders } from "../dist/manifest/dnr.js";

// Safari ACCEPTS a declarativeNetRequest modifyHeaders rule and then never acts on it.
// Measured on Safari 26.6.2, converted extension with all-website access, rules
// registered against a public host and the headers read back off the server:
//   - update{Session,Dynamic}Rules RESOLVE; get{Session,Dynamic}Rules list the rule back
//   - every request still carries Safari's own User-Agent and Referer (main-frame
//     navigation, page-context XHR, subresources; session and dynamic alike)
//   - a `block` rule registered in the SAME call DID block, so the rule list is
//     compiled and live — the header action specifically is inert
// On top of that, a header name off WebKit's allowlist (x-forwarded-for, any custom
// x-*) makes the call throw SYNCHRONOUSLY, taking down the extension's own registration
// code and every other rule in the batch. Hence: drop header rules, keep the rest, and
// never let a synchronous throw escape the wrapper.

function boot({ throwOnHeaderRule = false, throwOnFirstBatch = false } = {}) {
  const applied = [];
  const removed = [];
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { href: "safari-web-extension://TEST/background.html" },
    navigator: { userAgent: "test" },
    applied,
    removed,
    chrome: {
      runtime: {
        id: "test-ext",
        getURL: (p) => "safari-web-extension://TEST/" + p,
        onMessage: { addListener() {}, removeListener() {} },
        sendMessage() {},
      },
      declarativeNetRequest: {
        updateSessionRules(opts) {
          const rules = opts?.addRules ?? [];
          // Stand-in for WebKit's validator: it THROWS (does not reject) on a rule it
          // considers malformed, e.g. an unrecognized header name.
          if (throwOnHeaderRule && rules.some((r) => r?.action?.type === "modifyHeaders")) {
            throw new Error("Rule with id 1 is invalid. The header `x-forwarded-for` is not recognized.");
          }
          if (throwOnFirstBatch && rules.length > 1) {
            throw new Error("Invalid call to declarativeNetRequest.updateSessionRules().");
          }
          for (const id of opts?.removeRuleIds ?? []) removed.push(id);
          for (const r of rules) applied.push(r);
          return Promise.resolve();
        },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  return sandbox;
}

const headerRule = (id) => ({
  id,
  priority: 1,
  action: {
    type: "modifyHeaders",
    requestHeaders: [
      { header: "user-agent", operation: "set", value: "Googlebot/2.1" },
      { header: "x-forwarded-for", operation: "set", value: "185.1.2.3" },
    ],
  },
  condition: { urlFilter: "||example.com", resourceTypes: ["main_frame"] },
});
const blockRule = (id) => ({
  id,
  priority: 1,
  action: { type: "block" },
  condition: { urlFilter: "||ads.example", resourceTypes: ["script"] },
});

test("a header rule never reaches Safari, its batch-mates still do", async () => {
  const s = boot({ throwOnHeaderRule: true });
  await s.chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [7],
    addRules: [headerRule(1), blockRule(2)],
  });
  assert.deepEqual(s.applied.map((r) => r.id), [2], "the block rule must survive");
  assert.deepEqual(s.removed, [7], "removals must still be applied");
});

test("the caller's rule array is not mutated", async () => {
  const s = boot();
  const rules = [headerRule(1), blockRule(2)];
  await s.chrome.declarativeNetRequest.updateSessionRules({ addRules: rules });
  assert.equal(rules.length, 2);
  assert.equal(rules[0].action.requestHeaders.length, 2);
});

test("a synchronous throw from Safari is salvaged, not propagated to the extension", async () => {
  // Safari reports a rule it dislikes by throwing OUT of the call rather than through
  // the callback. Unhandled, that aborts the extension's registration code mid-way, so
  // the wrapper catches it and re-tries the batch one rule at a time.
  const s = boot({ throwOnFirstBatch: true });
  await new Promise((resolve) => {
    s.chrome.declarativeNetRequest.updateSessionRules({ addRules: [blockRule(1), blockRule(2)] }, resolve);
  });
  assert.deepEqual(s.applied.map((r) => r.id), [1, 2], "both rules land through the salvage");
});

test("stripModifyHeaders keeps every other action type by identity", () => {
  const block = blockRule(1);
  const res = stripModifyHeaders([block, headerRule(2)]);
  assert.equal(res.dropped, 1);
  assert.deepEqual(res.rules, [block]);
  assert.equal(res.rules[0], block);
});

test("applyDnr rewrites a static ruleset and reports the drop", () => {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-dnr-"));
  writeFileSync(join(dir, "rules.json"), JSON.stringify([blockRule(1), headerRule(2)]), "utf-8");
  const notes = applyDnr(dir, {
    declarative_net_request: { rule_resources: [{ id: "ruleset", path: "rules.json", enabled: true }] },
  });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "rules.json"), "utf-8")).map((r) => r.id), [1]);
  const note = notes.find((n) => n.startsWith("Dropped 1 modifyHeaders"));
  assert.ok(note, `expected a drop note, got ${JSON.stringify(notes)}`);
  assert.match(note, /never applies them/);
});
