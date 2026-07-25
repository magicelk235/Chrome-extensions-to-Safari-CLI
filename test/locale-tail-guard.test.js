import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { guardLocaleTailMessage } from "../dist/input/stage.js";

// Safari drops the LAST entry of _locales/<locale>/messages.json: proven live on
// Tampermonkey, where `v0version0` (the final message, "v$version$") returned "" from
// getMessage while `top_level_await` immediately before it resolved fine, so its
// dashboard rendered the raw message key instead of the version. Nothing else about
// the entry is special — it is dropped for being last. Staging appends a sacrificial
// message so the extension's own last string survives.
function stage(locales) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-loc-"));
  for (const [locale, body] of Object.entries(locales)) {
    mkdirSync(join(dir, "_locales", locale), { recursive: true });
    writeFileSync(join(dir, "_locales", locale, "messages.json"), body);
  }
  return dir;
}

const read = (dir, locale) => readFileSync(join(dir, "_locales", locale, "messages.json"), "utf-8");

test("the extension's last message is no longer last", () => {
  const dir = stage({ en: '{"first":{"message":"a"},"last":{"message":"z"}}' });
  try {
    assert.equal(guardLocaleTailMessage(dir), 1);
    const out = JSON.parse(read(dir, "en"));
    const keys = Object.keys(out);
    assert.notEqual(keys[keys.length - 1], "last", "the real last message must not be last anymore");
    assert.equal(out.last.message, "z", "the real message must survive untouched");
    assert.equal(out.first.message, "a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every locale is guarded", () => {
  const dir = stage({
    en: '{"a":{"message":"1"}}',
    de: '{"a":{"message":"2"}}',
    "pt_BR": '{"a":{"message":"3"}}',
  });
  try {
    assert.equal(guardLocaleTailMessage(dir), 3);
    for (const locale of ["en", "de", "pt_BR"]) {
      const keys = Object.keys(JSON.parse(read(dir, locale)));
      assert.equal(keys.length, 2, `${locale} must gain the guard`);
      assert.equal(keys[0], "a");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the original bytes are left alone — only an entry is appended", () => {
  const body = '{\n  "greeting": {\n    "message": "hi $name$",\n    "placeholders": { "name": { "content": "$1" } }\n  }\n}\n';
  const dir = stage({ en: body });
  try {
    guardLocaleTailMessage(dir);
    const out = read(dir, "en");
    assert.ok(out.startsWith(body.slice(0, body.lastIndexOf("}"))), "existing text must be preserved verbatim");
    assert.deepEqual(JSON.parse(out).greeting, JSON.parse(body).greeting);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("running twice does not stack guards", () => {
  const dir = stage({ en: '{"a":{"message":"1"}}' });
  try {
    guardLocaleTailMessage(dir);
    assert.equal(guardLocaleTailMessage(dir), 0, "an already-guarded file is left alone");
    assert.equal(Object.keys(JSON.parse(read(dir, "en"))).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("files that are not usable message catalogs are skipped", () => {
  const dir = stage({ en: "{ not json", de: "{}", fr: "[]" });
  try {
    assert.equal(guardLocaleTailMessage(dir), 0);
    assert.equal(read(dir, "en"), "{ not json", "a broken catalog is never rewritten");
    assert.equal(read(dir, "de"), "{}", "an empty catalog has no last message to lose");
    assert.equal(read(dir, "fr"), "[]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no _locales directory is a no-op", () => {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-loc-"));
  try {
    assert.equal(guardLocaleTailMessage(dir), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
