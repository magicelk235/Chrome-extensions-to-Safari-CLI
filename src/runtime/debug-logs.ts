import { readdirSync, existsSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { run } from "../util.js";

/** storage.local key the --debug ring buffer persists under (see debug-ring.js). */
export const DEBUG_LOG_KEY = "__viaduct_debug_log__";

/** Safari keeps each installed web extension's storage.local as a SQLite file
 *  on disk: <base>/<bundle-id>.Extension (<team>)/LocalStorage.db, table
 *  extension_storage (key TEXT, value TEXT with JSON values). Readable with the
 *  extension installed and Safari open — no console needed. */
export const SAFARI_EXTENSION_STORAGE_DIR = join(
  homedir(),
  "Library", "Containers", "com.apple.Safari", "Data", "Library", "WebKit", "WebExtensions", "Default",
);

export interface DebugLogEntry {
  /** epoch ms */
  t: number;
  /** background | content | page */
  ctx: string;
  msg: string;
}

/** Case/spacing/punctuation-insensitive containment, so both an app name
 *  ("TWP Translate Web Pages") and a bundle id fragment match the storage dir
 *  ("com.viaduct.TWPTranslateWebPagesd221b48f.Extension (TEAM)"). */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function storageDirs(baseDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(baseDir);
  } catch {
    return [];
  }
  return names.filter((n) => existsSync(join(baseDir, n, "LocalStorage.db")));
}

/**
 * Read the persisted --debug ring buffer of an installed converted extension
 * straight from Safari's on-disk storage. Throws with an actionable message on
 * every miss (no store, ambiguous name, no log recorded).
 *
 * The DB is WAL-journaled and possibly live under Safari, so the file trio is
 * copied to a scratch dir first and queried read-only there — never touching
 * Safari's own handle.
 */
export function readDebugLog(query: string, baseDir: string = SAFARI_EXTENSION_STORAGE_DIR): { entries: DebugLogEntry[]; dir: string } {
  const dirs = storageDirs(baseDir);
  if (dirs.length === 0) {
    throw new Error(`No Safari web-extension storage found under ${baseDir} — is a converted extension installed and enabled?`);
  }
  const q = normalize(query);
  const matches = q ? dirs.filter((d) => normalize(d).includes(q)) : [];
  if (matches.length === 0) {
    throw new Error(`No installed extension matches "${query}". Extensions with storage on disk:\n  ${dirs.join("\n  ")}`);
  }
  if (matches.length > 1) {
    throw new Error(`"${query}" matches ${matches.length} extensions — be more specific:\n  ${matches.join("\n  ")}`);
  }
  const dir = join(baseDir, matches[0]);

  const scratch = mkdtempSync(join(tmpdir(), "viaduct-logs-"));
  try {
    // Copy the WAL trio so the read-only query sees a consistent snapshot even
    // while Safari holds the live database.
    for (const f of ["LocalStorage.db", "LocalStorage.db-wal", "LocalStorage.db-shm"]) {
      const src = join(dir, f);
      if (existsSync(src)) copyFileSync(src, join(scratch, f));
    }
    const res = run("/usr/bin/sqlite3", [
      "-readonly",
      join(scratch, "LocalStorage.db"),
      `SELECT value FROM extension_storage WHERE key='${DEBUG_LOG_KEY}';`,
    ]);
    if (res.code !== 0) {
      throw new Error(`Could not read ${join(dir, "LocalStorage.db")}: ${res.stderr.trim() || `sqlite3 exited ${res.code}`}`);
    }
    const raw = res.stdout.trim();
    if (!raw) {
      throw new Error(
        `${matches[0]} has no recorded debug log. The ring buffer only exists in a --debug conversion — ` +
        `re-convert with --debug, reinstall, exercise the extension, then retry.`,
      );
    }
    let entries: DebugLogEntry[];
    try {
      entries = JSON.parse(raw) as DebugLogEntry[];
    } catch {
      throw new Error(`${matches[0]}: the stored ${DEBUG_LOG_KEY} value is not valid JSON.`);
    }
    if (!Array.isArray(entries)) {
      throw new Error(`${matches[0]}: the stored ${DEBUG_LOG_KEY} value is not a log array.`);
    }
    return { entries, dir };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** One line per entry: ISO timestamp, context label, message. */
export function formatDebugLog(entries: DebugLogEntry[]): string {
  return entries
    .map((e) => `${new Date(e.t).toISOString()} [${e.ctx}] ${e.msg}`)
    .join("\n");
}
