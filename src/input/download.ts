import { get as httpsGet } from "node:https";
import { get as httpGetPlain } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB
const TIMEOUT_MS = 60_000; // socket IDLE timeout: no data at all for this long
// Whole-download wall clock. Distinct from (and much larger than) the idle
// timeout: equal values made the 100 MB cap unreachable below ~1.7 MB/s.
const TOTAL_TIMEOUT_MS = 5 * 60_000;
const MAX_REDIRECTS = 5;

// Chrome extension IDs are 32 chars from the alphabet a–p (base16-ish mojibake).
const EXT_ID_RE = /^[a-p]{32}$/;

export function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/** Pull the 32-char extension ID out of a Chrome Web Store detail URL. */
export function extractStoreId(url: string): string | undefined {
  let host: string;
  let segments: string[];
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    segments = u.pathname.split("/").filter(Boolean);
  } catch {
    return undefined;
  }
  const isStore =
    host === "chromewebstore.google.com" ||
    host === "chrome.google.com"; // legacy /webstore/detail/...
  if (!isStore) return undefined;
  // Last path segment that looks like an extension ID wins; store URLs put it last.
  for (let i = segments.length - 1; i >= 0; i--) {
    if (EXT_ID_RE.test(segments[i])) return segments[i];
  }
  return undefined;
}

// Google's CRX endpoint gates responses on prodversion: an extension whose
// minimum_chrome_version is newer than the version we claim gets declined with a
// 204 and an empty body, not an error. Chrome majors move every few weeks, so any
// value here goes stale. Ask as current-ish stable first, then retry as a version
// nothing can gate past. Override the first claim with VIADUCT_CRX_PRODVERSION.
const CRX_PRODVERSION = process.env.VIADUCT_CRX_PRODVERSION || "138.0";
const CRX_PRODVERSION_MAX = "9999.0";

/** Build the clients2 CRX download endpoint (302-redirects to the real CRX). */
export function crxEndpoint(id: string, prodversion = CRX_PRODVERSION): string {
  const x = `id=${id}&installsource=ondemand&uc`;
  return (
    "https://clients2.google.com/service/update2/crx" +
    `?response=redirect&acceptformat=crx2,crx3&prodversion=${prodversion}` +
    `&x=${encodeURIComponent(x)}`
  );
}

/** Store endpoints to try in order: the configured Chrome version, then the
 * maximum. One entry when they coincide (the user pinned it that high). */
export function storeEndpoints(id: string): string[] {
  const urls = [crxEndpoint(id)];
  if (CRX_PRODVERSION !== CRX_PRODVERSION_MAX) urls.push(crxEndpoint(id, CRX_PRODVERSION_MAX));
  return urls;
}

interface HttpResult {
  buffer: Buffer;
  contentType: string;
}

function httpGet(
  url: string,
  redirectsLeft = MAX_REDIRECTS,
  // Absolute wall-clock deadline for the WHOLE fetch, redirect chain included.
  // Threaded through the redirect recursion so it spans every hop, not re-armed
  // per hop — otherwise a server redirecting MAX_REDIRECTS times could hold the
  // request open for (hops+1)×TOTAL_TIMEOUT_MS, far past the advertised bound.
  deadlineAt = Date.now() + TOTAL_TIMEOUT_MS,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    // Guard against resolve/reject racing each other: a size-cap reject and a
    // buffered `end` (which would resolve with the truncated buffer) can both
    // fire, and whichever lands second is a silent no-op. Settle exactly once.
    let settled = false;
    // Wall-clock deadline for the whole download. req.setTimeout below is only a
    // socket IDLE timeout: a slow-drip server sending a few bytes every <TIMEOUT_MS
    // never trips it and could hold the request open far past TIMEOUT_MS. This hard
    // deadline (cleared on any settle) enforces the advertised bound. Armed after req
    // is created, below.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const done = (fn: () => void) => { if (!settled) { settled = true; if (deadline) clearTimeout(deadline); fn(); } };
    // isUrl() permits http:// too; https.get throws ERR_INVALID_PROTOCOL on it
    // synchronously. Pick the matching agent so an http:// input downloads (or
    // fails) gracefully instead of with a cryptic internal TypeError.
    let get: typeof httpsGet;
    try {
      get = new URL(url).protocol === "http:" ? httpGetPlain : httpsGet;
    } catch {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }
    const req = get(url, (res) => {
      const status = res.statusCode ?? 0;

      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = res.headers.location;
        res.resume(); // drain
        if (!location) {
          done(() => reject(new Error(`Redirect (${status}) with no Location header: ${url}`)));
          return;
        }
        if (redirectsLeft <= 0) {
          done(() => reject(new Error(`Too many redirects fetching ${url}`)));
          return;
        }
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          done(() => reject(new Error(`Invalid redirect Location "${location}" from ${url}`)));
          return;
        }
        // Only follow https redirects; an untrusted endpoint must not be able to
        // redirect the fetch to http:// (or another scheme) and reach an internal host.
        if (next.protocol !== "https:") {
          done(() => reject(new Error(`Refusing non-https redirect to ${next.protocol}// from ${url}`)));
          return;
        }
        done(() => resolve(httpGet(next.toString(), redirectsLeft - 1, deadlineAt)));
        return;
      }

      if (status < 200 || status >= 300) {
        res.resume();
        done(() => reject(new Error(`HTTP ${status} fetching ${url}`)));
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > MAX_BYTES) {
          res.destroy();
          req.destroy();
          done(() => reject(new Error(`Download exceeds ${MAX_BYTES} bytes: ${url}`)));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        done(() => resolve({
          buffer: Buffer.concat(chunks),
          contentType: String(res.headers["content-type"] ?? ""),
        }));
      });
      res.on("error", (e) => done(() => reject(e)));
    });

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error(`No data for ${TIMEOUT_MS}ms fetching ${url}`));
    });
    // Total wall-clock deadline (idle timeout above can't bound a slow-drip response).
    // Fires at the SHARED deadline so the whole redirect chain stays within
    // TOTAL_TIMEOUT_MS; a chain that already burned most of the budget gets what's left.
    deadline = setTimeout(() => {
      req.destroy(new Error(`Timed out after ${TOTAL_TIMEOUT_MS}ms fetching ${url}`));
    }, Math.max(0, deadlineAt - Date.now()));
    req.on("error", (e) => done(() => reject(e)));
  });
}

/** Sniff CRX/ZIP magic; fall back to the URL's extension. `url` may be "" (store
 * downloads have no trustworthy suffix — magic bytes are authoritative there). */
function inferKind(buf: Buffer, url: string, contentType = ""): "crx" | "zip" {
  if (buf.subarray(0, 4).toString("ascii") === "Cr24") return "crx";
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return "zip";
  }
  // Magic didn't match. An HTML error/captcha page (content-type text/html, or a
  // leading "<") is the common culprit — say so instead of trusting a misleading suffix.
  const looksHtml = /text\/html/i.test(contentType) || buf.subarray(0, 1).toString("ascii") === "<";
  const lower = url.toLowerCase();
  if (!looksHtml && lower.endsWith(".crx")) return "crx";
  if (!looksHtml && lower.endsWith(".zip")) return "zip";
  throw new Error(
    "Downloaded file is not a CRX or ZIP (got an unexpected response, e.g. an HTML error page).",
  );
}

function save(buffer: Buffer, url: string, contentType: string, scratchDir: string): string {
  const kind = inferKind(buffer, url, contentType);
  const dest = join(scratchDir, `download.${kind}`);
  writeFileSync(dest, buffer);
  return dest;
}

/**
 * Download an extension from a Chrome Web Store URL or a direct .crx/.zip URL.
 * Returns the local path to the saved archive (for extractExtension).
 */
export async function downloadExtension(url: string, scratchDir: string): Promise<string> {
  const storeId = extractStoreId(url);
  if (storeId) return downloadFromStore(storeId, scratchDir);
  if (/chromewebstore\.google\.com|chrome\.google\.com\/webstore/i.test(url)) {
    throw new Error(
      `Could not find a 32-char extension ID in the store URL.\n` +
        `Expected something like https://chromewebstore.google.com/detail/<name>/<id>`,
    );
  }

  const { buffer, contentType } = await httpGet(url);
  // A real CRX/ZIP is always larger than its magic header. Without this guard
  // inferKind falls back to the URL suffix, an empty file is written, and the
  // user hits a baffling "bad magic" error deep in the extractor.
  if (buffer.length < 4) {
    throw new Error(`Downloaded an empty response from ${url} (no extension package returned).`);
  }
  return save(buffer, url, contentType, scratchDir);
}

/** Fetch a store extension by ID, claiming a newer Chrome on each attempt. The
 * endpoint answers 204 with an empty body (not an error) when it won't serve the
 * extension to the Chrome version we claimed, so an empty body means retry. */
async function downloadFromStore(id: string, scratchDir: string): Promise<string> {
  for (const endpoint of storeEndpoints(id)) {
    const { buffer, contentType } = await httpGet(endpoint);
    // Store downloads have no trustworthy suffix, so pass "": magic bytes decide.
    if (buffer.length >= 4) return save(buffer, "", contentType, scratchDir);
  }
  throw new Error(
    `The Chrome Web Store returned no downloadable package for extension ${id} ` +
      `(the on-demand CRX endpoint declined it, which happens for delisted, region-blocked ` +
      `or policy-gated extensions).\n` +
      `Download the .crx manually and pass the local file path instead.`,
  );
}
