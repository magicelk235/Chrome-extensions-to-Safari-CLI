import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { injectShimIntoHtmlPages } from "../dist/runtime/shim.js";

function stage(files) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-cs-"));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

test("light-only page gets color-scheme:light so Safari renders it like Chrome", () => {
  const dir = stage({
    "page.html": '<html><head><link rel="stylesheet" href="app.css"><title>x</title></head><body></body></html>',
    "app.css": "body{background:#fff;color:#000}",
  });
  injectShimIntoHtmlPages(dir);
  const html = readFileSync(join(dir, "page.html"), "utf-8");
  assert.match(html, /color-scheme:light/);
});

test("page whose CSS handles dark mode is left untouched", () => {
  const dir = stage({
    "page.html": '<html><head><link rel="stylesheet" href="app.css"></head><body></body></html>',
    "app.css": "@media (prefers-color-scheme: dark){body{background:#000}}",
  });
  injectShimIntoHtmlPages(dir);
  const html = readFileSync(join(dir, "page.html"), "utf-8");
  assert.ok(!/c2s-color-scheme/.test(html), "theme-aware page must not be forced to light");
});

test("page that declares color-scheme itself is left untouched", () => {
  const dir = stage({
    "page.html": '<html><head><style>:root{color-scheme:light dark}</style></head><body></body></html>',
  });
  injectShimIntoHtmlPages(dir);
  const html = readFileSync(join(dir, "page.html"), "utf-8");
  assert.ok(!/c2s-color-scheme/.test(html), "page with its own color-scheme must not be double-set");
});

test("subdir stylesheet is resolved relative to the html file", () => {
  const dir = stage({
    "sub/page.html": '<html><head><link rel="stylesheet" href="theme.css"></head><body></body></html>',
    "sub/theme.css": "@media(prefers-color-scheme:dark){body{color:#fff}}",
  });
  injectShimIntoHtmlPages(dir);
  const html = readFileSync(join(dir, "sub/page.html"), "utf-8");
  assert.ok(!/c2s-color-scheme/.test(html), "dark-aware subdir CSS must be detected");
});

test("injection is idempotent — re-running adds no duplicate color-scheme", () => {
  const dir = stage({
    "page.html": "<html><head><title>x</title></head><body></body></html>",
  });
  injectShimIntoHtmlPages(dir);
  injectShimIntoHtmlPages(dir);
  const html = readFileSync(join(dir, "page.html"), "utf-8");
  assert.equal(html.match(/c2s-color-scheme/g).length, 1);
});
