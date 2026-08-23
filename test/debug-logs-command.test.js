import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { readDebugLog, formatDebugLog, DEBUG_LOG_KEY } from "../dist/runtime/debug-logs.js";

// viaduct --logs <name>: locate an installed extension's on-disk storage.local
// (Safari keeps it as SQLite at ~/Library/Containers/com.apple.Safari/…/
// WebExtensions/Default/<bundle-id>.Extension (<team>)/LocalStorage.db, table
// extension_storage) and dump the __viaduct_debug_log__ ring buffer. Exercised
// here against a fixture base dir shaped exactly like Safari's real one.

const ENTRIES = [
  { t: 1700000000000, ctx: "background", msg: "boot" },
  { t: 1700000001500, ctx: "content", msg: "fetch retried via proxy" },
];

function makeStorageBase() {
  const base = mkdtempSync(join(tmpdir(), "viaduct-logs-test-"));
  const dir = join(base, "com.viaduct.MyTestThing.Extension (ABCDE12345)");
  mkdirSync(dir);
  const sql =
    "CREATE TABLE extension_storage (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);" +
    `INSERT INTO extension_storage VALUES ('${DEBUG_LOG_KEY}', '${JSON.stringify(ENTRIES)}');` +
    "INSERT INTO extension_storage VALUES ('unrelated', '42');";
  const r = spawnSync("/usr/bin/sqlite3", [join(dir, "LocalStorage.db"), sql], { encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr);
  return base;
}

test("dumps the ring buffer for a name matching the storage dir", () => {
  const base = makeStorageBase();
  try {
    // App-name style query: spacing and case must not matter.
    const { entries, dir } = readDebugLog("my test thing", base);
    assert.deepEqual(entries, ENTRIES);
    assert.ok(dir.includes("com.viaduct.MyTestThing.Extension"));
    const text = formatDebugLog(entries);
    assert.match(text, /\[background\] boot/);
    assert.match(text, /\[content\] fetch retried via proxy/);
    assert.match(text, /2023-11-14T22:13:20\.000Z/, "epoch ms rendered as ISO time");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("an unmatched name fails with the available extensions listed", () => {
  const base = makeStorageBase();
  try {
    assert.throws(() => readDebugLog("nonexistent", base), /com\.viaduct\.MyTestThing\.Extension/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a matched extension without a recorded log names --debug as the fix", () => {
  const base = mkdtempSync(join(tmpdir(), "viaduct-logs-test-"));
  try {
    const dir = join(base, "com.viaduct.Empty.Extension (ABCDE12345)");
    mkdirSync(dir);
    const r = spawnSync("/usr/bin/sqlite3", [join(dir, "LocalStorage.db"),
      "CREATE TABLE extension_storage (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);"], { encoding: "utf-8" });
    assert.equal(r.status, 0, r.stderr);
    assert.throws(() => readDebugLog("empty", base), /--debug/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
