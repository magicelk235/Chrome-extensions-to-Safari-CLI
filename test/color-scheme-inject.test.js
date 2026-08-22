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

test("the light floor paints body, never html, so a JS-applied dark theme wins", () => {
  // TWP's popup appends `html *{background-color:#181a1b!important}` from JS when the
  // OS is dark. `html *` matches the body but never the root, so a floor on `html`
  // kept the canvas white behind the app's own dark UI: half-light, half-dark page.
  // A floor on `body` still whitens the canvas for a genuinely light page (a
  // transparent html propagates the body background) and loses to the app's rule.
  const dir = stage({
    "popup/popup.html": '<html><head><link rel="stylesheet" href="popup.css"></head><body><script src="popup.js"></script></body></html>',
    "popup/popup.css": "body{width:380px}",
  });
  injectShimIntoHtmlPages(dir);
  const html = readFileSync(join(dir, "popup/popup.html"), "utf-8");
  const style = /<style id="c2s-color-scheme">([^<]*)<\/style>/.exec(html)?.[1];
  assert.ok(style, "light page must still get the floor");
  assert.match(style, /(^|[;{}])body\{background-color:#fff/);
  assert.doesNotMatch(style, /html\s*[,{]/, "the floor must not paint html — it becomes unbeatable");
});

test("root-absolute stylesheet href resolves from the staged root", () => {
  const dir = stage({
    "options/options.html": '<html><head><link rel="stylesheet" href="/css/app.css"></head><body></body></html>',
    "css/app.css": "@media (prefers-color-scheme: dark){body{color:#fff}}",
  });
  injectShimIntoHtmlPages(dir);
  const html = readFileSync(join(dir, "options/options.html"), "utf-8");
  assert.ok(!/c2s-color-scheme/.test(html), "a root-absolute stylesheet must be read from the staged root");
});

test("remote stylesheets are not fetched and do not count as theme handling", () => {
  const dir = stage({
    "page.html": '<html><head><link rel="stylesheet" href="https://cdn.example.com/app.css"><link rel="stylesheet" href="//cdn.example.com/b.css"></head><body></body></html>',
  });
  injectShimIntoHtmlPages(dir);
  const html = readFileSync(join(dir, "page.html"), "utf-8");
  assert.match(html, /color-scheme:light/);
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
