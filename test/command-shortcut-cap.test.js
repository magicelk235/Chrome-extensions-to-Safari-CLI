import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { transformManifest, analyzeCommands } from "../dist/manifest/manifest.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "viaduct-cmdcap-"));
}
const OPTS = { keepModuleBackground: false };

function commands(n) {
  const out = {};
  for (let i = 1; i <= n; i++) out["cmd-" + i] = { suggested_key: { default: "Ctrl+Alt+" + i }, description: "c" + i };
  return out;
}

// Regression: TWP - Translate Web Pages. Safari rejects the whole manifest when >4
// commands carry a suggested_key ("only 4 shortcuts are allowed"). Keep the first 4,
// strip the default chord from the rest (commands stay, just unbound by default).
test("transformManifest keeps 4 suggested_keys and strips the rest, in declaration order", () => {
  const dir = tmp();
  try {
    const out = transformManifest({ manifest_version: 3, commands: commands(8) }, [], dir, OPTS);
    const kept = Object.keys(out.commands).filter((k) => out.commands[k].suggested_key !== undefined);
    assert.deepEqual(kept, ["cmd-1", "cmd-2", "cmd-3", "cmd-4"]);
    // The extra commands still exist — only their chord is gone.
    assert.ok("cmd-8" in out.commands);
    assert.equal(out.commands["cmd-8"].suggested_key, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transformManifest leaves 4-or-fewer commands untouched", () => {
  const dir = tmp();
  try {
    const out = transformManifest({ manifest_version: 3, commands: commands(4) }, [], dir, OPTS);
    const kept = Object.keys(out.commands).filter((k) => out.commands[k].suggested_key !== undefined);
    assert.equal(kept.length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a windows/linux-only chord does not count toward the 4 limit", () => {
  const dir = tmp();
  try {
    // 4 Safari-readable + 1 that's windows-only: the windows one shouldn't be stripped
    // for exceeding the cap (it's already a dead key on Safari, not counted).
    const cmds = commands(4);
    cmds["win-only"] = { suggested_key: { windows: "Ctrl+Alt+9" }, description: "w" };
    const out = transformManifest({ manifest_version: 3, commands: cmds }, [], dir, OPTS);
    // All 4 default chords survive; win-only keeps its (irrelevant) key untouched.
    for (let i = 1; i <= 4; i++) assert.ok(out.commands["cmd-" + i].suggested_key, "cmd-" + i + " kept");
    assert.ok(out.commands["win-only"].suggested_key.windows);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analyzeCommands warns which commands lose their default chord when >4", () => {
  const issues = analyzeCommands(commands(6));
  const capWarn = issues.find((i) => /only 4/.test(i.message));
  assert.ok(capWarn, "expected an over-4 warning");
  assert.match(capWarn.message, /cmd-5/);
  assert.match(capWarn.message, /cmd-6/);
  assert.doesNotMatch(capWarn.message, /cmd-1\b/); // the kept ones aren't listed as dropped
});
