import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeNativeHandler, writeAppBroker, unsandboxAppTarget } from "../dist/build/packager.js";

// writeNativeHandler/writeAppBroker resolve the project root from the .xcodeproj
// path and rewrite the target Swift in place. Build a minimal project layout.
function project() {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-nmh-"));
  const extDir = join(dir, "Ext");
  const appDir = join(dir, "App");
  mkdirSync(extDir, { recursive: true });
  mkdirSync(appDir, { recursive: true });
  const handler = join(extDir, "SafariWebExtensionHandler.swift");
  const delegate = join(appDir, "AppDelegate.swift");
  writeFileSync(handler, "// original echo handler placeholder\n", "utf-8");
  writeFileSync(delegate, "// original app delegate placeholder\n", "utf-8");
  return { dir, xcodeproj: join(dir, "App.xcodeproj"), handler, delegate };
}

test("nativeMessaging wires the appex as a loopback broker client", () => {
  const { dir, xcodeproj, handler } = project();
  try {
    writeNativeHandler(xcodeproj, { chromeOrigin: "", allowHosts: [], nativeMessaging: true, brokerPort: 51234, brokerToken: "deadbeef" });
    const swift = readFileSync(handler, "utf-8");
    assert.match(swift, /func handleNative/, "native op dispatcher present");
    assert.match(swift, /__c2sNM/, "native envelope key handled");
    assert.match(swift, /func brokerCall/, "forwards to the broker over a socket");
    assert.match(swift, /brokerPort: UInt16 = 51234/, "broker port baked in");
    assert.match(swift, /brokerToken = "deadbeef"/, "broker token baked in");
    // The appex must NOT launch hosts itself (sandboxed) — that lives in the broker.
    assert.doesNotMatch(swift, /NativeMessagingHosts/, "appex never touches Chrome's host dir");
    assert.doesNotMatch(swift, /Process\(\)/, "appex never spawns a process");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeAppBroker installs the host-launching broker into the app delegate", () => {
  const { dir, xcodeproj, delegate } = project();
  try {
    writeAppBroker(xcodeproj, { brokerPort: 51234, brokerToken: "deadbeef" });
    const swift = readFileSync(delegate, "utf-8");
    assert.match(swift, /class NMBroker/, "broker class present");
    assert.match(swift, /NativeMessagingHosts/, "broker searches Chrome's host dirs");
    assert.match(swift, /func launch/, "broker launches the host binary");
    assert.match(swift, /port: UInt16 = 51234/, "broker port baked in");
    assert.match(swift, /token = "deadbeef"/, "broker token baked in");
    assert.match(swift, /applicationShouldTerminateAfterLastWindowClosed[\s\S]*?return false/, "app stays alive to keep serving");
    assert.match(swift, /@main/, "still the app entry point");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unsandboxAppTarget drops the sandbox on the app but keeps it on the appex", () => {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-sb-"));
  const proj = join(dir, "App.xcodeproj");
  mkdirSync(proj, { recursive: true });
  // Two build-config blocks: the appex (.Extension) and the app, each with the
  // sandbox setting preceding its bundle id — the shape Xcode emits.
  const pbxproj = [
    "buildSettings = {",
    "  ENABLE_APP_SANDBOX = YES;",
    '  PRODUCT_BUNDLE_IDENTIFIER = "com.viaduct.App.Extension";',
    "};",
    "buildSettings = {",
    "  ENABLE_APP_SANDBOX = YES;",
    '  PRODUCT_BUNDLE_IDENTIFIER = "com.viaduct.App";',
    "};",
  ].join("\n");
  writeFileSync(join(proj, "project.pbxproj"), pbxproj, "utf-8");
  try {
    unsandboxAppTarget(proj);
    const out = readFileSync(join(proj, "project.pbxproj"), "utf-8");
    // Appex block: sandbox stays YES. App block: flipped to NO.
    assert.match(out, /ENABLE_APP_SANDBOX = YES;\s*PRODUCT_BUNDLE_IDENTIFIER = "com\.viaduct\.App\.Extension"/);
    assert.match(out, /ENABLE_APP_SANDBOX = NO;\s*PRODUCT_BUNDLE_IDENTIFIER = "com\.viaduct\.App"/);
    assert.equal((out.match(/ENABLE_APP_SANDBOX = NO;/g) || []).length, 1, "only the app target flipped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no proxy hosts and no native messaging leaves the echo handler untouched", () => {
  const { dir, xcodeproj, handler } = project();
  try {
    const before = readFileSync(handler, "utf-8");
    writeNativeHandler(xcodeproj, { chromeOrigin: "", allowHosts: [], nativeMessaging: false });
    assert.equal(readFileSync(handler, "utf-8"), before, "handler must be a no-op");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proxy hosts wire the HTTP proxy branch with the allowlist baked in", () => {
  const { dir, xcodeproj, handler } = project();
  try {
    writeNativeHandler(xcodeproj, { chromeOrigin: "chrome-extension://abc/", allowHosts: ["api.example.com"], nativeMessaging: false });
    const swift = readFileSync(handler, "utf-8");
    assert.match(swift, /"api\.example\.com"/, "allowlist host baked in");
    assert.match(swift, /__c2sProxy/, "HTTP proxy branch present");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
