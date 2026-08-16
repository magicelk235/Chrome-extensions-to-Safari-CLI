import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { rewriteExtensionIdPlaceholderUrls } from "../dist/input/stage.js";

function stage(files) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-extid-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

// Regression: Cloaked's content.css loads its webfonts from
// chrome-extension://__MSG_@@extension_id__/fonts/inter-400.woff2. Safari substitutes
// the placeholder with the install UUID but keeps the scheme, so the page ends up
// requesting chrome-extension://<uuid>/… over https and blocks every one of them:
// "requested insecure content … must be served over HTTPS". Live on my.cloaked.com,
// 18 blocked font requests per injection.
test("rewrites the scheme on @@extension_id placeholder URLs in CSS", () => {
  const dir = stage({
    "static/css/content.css":
      "@font-face{font-family:Inter;src:url(chrome-extension://__MSG_@@extension_id__/fonts/inter-400.woff2)}",
  });
  assert.equal(rewriteExtensionIdPlaceholderUrls(dir), 1);
  assert.equal(
    readFileSync(join(dir, "static/css/content.css"), "utf-8"),
    "@font-face{font-family:Inter;src:url(safari-web-extension://__MSG_@@extension_id__/fonts/inter-400.woff2)}"
  );
  rmSync(dir, { recursive: true, force: true });
});

test("covers the same literal in js and html", () => {
  const dir = stage({
    "a.js": 'i.src = "chrome-extension://__MSG_@@extension_id__/images/logo.png";',
    "p.html": '<img src="chrome-extension://__MSG_@@extension_id__/images/logo.png">',
  });
  assert.equal(rewriteExtensionIdPlaceholderUrls(dir), 2);
  assert.equal(
    readFileSync(join(dir, "a.js"), "utf-8"),
    'i.src = "safari-web-extension://__MSG_@@extension_id__/images/logo.png";'
  );
  assert.equal(
    readFileSync(join(dir, "p.html"), "utf-8"),
    '<img src="safari-web-extension://__MSG_@@extension_id__/images/logo.png">'
  );
  rmSync(dir, { recursive: true, force: true });
});

// The placeholder host is resolved by the browser at load time, so it can never be a
// redirect_uri registered with a provider — unlike the concrete-host URLs
// rewriteChromeSchemeLiterals deliberately leaves alone. Those must stay untouched here.
test("leaves concrete-host and interpolated URLs alone", () => {
  const dir = stage({
    "oauth.js":
      'S="chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/oauth_callback.html";' +
      "R=`chrome-extension://${chrome.runtime.id}/oauth_callback.html`;",
  });
  assert.equal(rewriteExtensionIdPlaceholderUrls(dir), 0);
  assert.equal(
    readFileSync(join(dir, "oauth.js"), "utf-8"),
    'S="chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/oauth_callback.html";' +
      "R=`chrome-extension://${chrome.runtime.id}/oauth_callback.html`;"
  );
  rmSync(dir, { recursive: true, force: true });
});
