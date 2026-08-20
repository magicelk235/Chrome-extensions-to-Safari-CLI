import { test } from "node:test";
import assert from "node:assert/strict";
import { crxEndpoint, storeEndpoints } from "../dist/input/download.js";

// Regression (issue #16, Enhancer for YouTube): the CRX endpoint gates on the
// prodversion we claim. Ask for an extension whose minimum_chrome_version is
// newer and the answer is 204 with an empty body, not an error, so the download
// looked like "the store has no package for this extension". Verified against
// the live endpoint for ponfpcnoihfmfllpaingbgckeeldkhle: prodversion=120.0.0.0
// gives 204/0 bytes, 130.0 and up give 200/498490 bytes. Any hardcoded version
// goes stale the same way, so a store download makes a second attempt claiming a
// version no extension can gate past.

const ID = "ponfpcnoihfmfllpaingbgckeeldkhle";

function prodversionOf(url) {
  return new URL(url).searchParams.get("prodversion");
}

test("a store download retries at a higher prodversion", () => {
  const urls = storeEndpoints(ID);
  assert.equal(urls.length, 2, "expected a first attempt and a higher-version retry");
  const [first, second] = urls.map(prodversionOf);
  assert.notEqual(first, second);
  assert.ok(
    Number.parseInt(second, 10) > Number.parseInt(first, 10),
    `retry should claim a newer Chrome than ${first}, got ${second}`,
  );
  // The retry has to out-run any plausible minimum_chrome_version, not just the
  // next major, or it goes stale again in a few weeks.
  assert.ok(Number.parseInt(second, 10) >= 1000, `retry claim ${second} is too low to be future-proof`);
});

test("every store attempt asks for the same extension by id", () => {
  for (const url of storeEndpoints(ID)) {
    const u = new URL(url);
    assert.equal(u.host, "clients2.google.com");
    assert.equal(u.searchParams.get("response"), "redirect");
    assert.equal(u.searchParams.get("acceptformat"), "crx2,crx3");
    assert.equal(u.searchParams.get("x"), `id=${ID}&installsource=ondemand&uc`);
  }
});

test("crxEndpoint takes an explicit prodversion", () => {
  assert.equal(prodversionOf(crxEndpoint(ID, "142.0")), "142.0");
});
