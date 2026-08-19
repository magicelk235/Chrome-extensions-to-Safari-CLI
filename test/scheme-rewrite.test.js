import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rewriteChromeSchemeLiterals } from "../dist/input/stage.js";

function stage(files) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-scheme-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

test("rewrites protocol-table and prefix-check literals", () => {
  const dir = stage({
    "bg.js": 'T={INTERNAL_PAGE_PROTOCOLS:["chrome-extension:"]};u.startsWith("chrome-extension://")',
  });
  assert.equal(rewriteChromeSchemeLiterals(dir), 1);
  assert.equal(
    readFileSync(join(dir, "bg.js"), "utf-8"),
    'T={INTERNAL_PAGE_PROTOCOLS:["safari-web-extension:"]};u.startsWith("safari-web-extension://")'
  );
  rmSync(dir, { recursive: true, force: true });
});

test("preserves concrete-host URLs (OAuth redirect_uris), rewrites wildcard hosts", () => {
  const dir = stage({
    "oauth.js":
      'R=`chrome-extension://${A}/oauth_callback.html`;' +
      'S="chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/oauth_callback.html";' +
      'M="chrome-extension://*/*";',
  });
  assert.equal(rewriteChromeSchemeLiterals(dir), 1);
  assert.equal(
    readFileSync(join(dir, "oauth.js"), "utf-8"),
    'R=`chrome-extension://${A}/oauth_callback.html`;' +
      'S="chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/oauth_callback.html";' +
      'M="safari-web-extension://*/*";'
  );
  rmSync(dir, { recursive: true, force: true });
});

test("leaves lookalike tokens and untouched files alone", () => {
  const dir = stage({
    "a.js": 'x = "my-chrome-extension:" + "xchrome-extension:";', // preceded by -/word → not the scheme
    "b.js": 'console.log("no scheme here");',
  });
  assert.equal(rewriteChromeSchemeLiterals(dir), 0);
  assert.equal(readFileSync(join(dir, "a.js"), "utf-8"), 'x = "my-chrome-extension:" + "xchrome-extension:";');
  rmSync(dir, { recursive: true, force: true });
});
