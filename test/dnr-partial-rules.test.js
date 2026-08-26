import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Safari rejects an ENTIRE update{Session,Dynamic}Rules call when any single rule is
// invalid — usually an unsupported regexFilter, since WebKit's regex engine takes a
// narrower subset than Chrome's. One bad rule therefore costs the extension every
// other rule in the batch. Live: Tampermonkey registers all its *.user.js
// interception rules in one call and Safari threw
//   "Rule with id 2 is invalid. `regexFilter` is not a supported regular expression"
// so userscript-URL detection was dead outright.
function boot({ rejectRegex = /\(\?:/ } = {}) {
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
        // Stand-in for Safari: atomic, and it refuses the whole call if any rule
        // carries a regex it can't compile.
        updateSessionRules(opts) {
          const rules = opts?.addRules ?? [];
          const bad = rules.find((r) => rejectRegex.test(r?.condition?.regexFilter ?? ""));
          if (bad) {
            return Promise.reject(
              new Error(
                "Invalid call to declarativeNetRequest.updateSessionRules(). The 'addRules' value is " +
                  `invalid, because an error with rule at index 0: Rule with id ${bad.id} is invalid. ` +
                  "`regexFilter` is not a supported regular expression."
              )
            );
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

const rule = (id, regexFilter) => ({
  id,
  priority: 1,
  action: { type: "redirect", redirect: { regexSubstitution: "https://x/#url=\\0" } },
  condition: { regexFilter, resourceTypes: ["main_frame"] },
});

test("one unsupported regexFilter does not take the whole batch down", async () => {
  const s = boot();
  await s.chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [7],
    addRules: [rule(1, "^https://a\\.example/"), rule(2, "^(?:https?|ftp)://.*\\.user\\.js$"), rule(3, "^https://b\\.example/")],
  });
  assert.deepEqual(s.applied.map((r) => r.id), [1, 3], "the compilable rules must survive");
  assert.deepEqual(s.removed, [7], "removals must still be applied");
});

test("a batch Safari accepts outright is applied in one call, untouched", async () => {
  const s = boot();
  await s.chrome.declarativeNetRequest.updateSessionRules({
    addRules: [rule(1, "^https://a\\.example/"), rule(2, "^https://b\\.example/")],
  });
  assert.deepEqual(s.applied.map((r) => r.id), [1, 2]);
});

test("a batch where nothing lands still rejects", async () => {
  const s = boot();
  await assert.rejects(
    s.chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule(1, "^(?:a)$"), rule(2, "^(?:b)$")] }),
    /not a supported regular expression/
  );
  assert.equal(s.applied.length, 0);
});

test("a modifyHeaders rule with no usable header edit is dropped before the call", async () => {
  const s = boot();
  await s.chrome.declarativeNetRequest.updateSessionRules({
    addRules: [
      rule(1, "^https://a\\.example/"),
      { id: 2, priority: 1, action: { type: "modifyHeaders" }, condition: { urlFilter: "*" } },
    ],
  });
  assert.deepEqual(s.applied.map((r) => r.id), [1], "Safari rejects a modifyHeaders action with no header list");
});
