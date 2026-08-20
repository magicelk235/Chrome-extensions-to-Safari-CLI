import { readdirSync, existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir, homedir } from "node:os";
import { join, basename } from "node:path";
import { run, info, warn } from "../util.js";
import type { Platforms } from "../types.js";

function findFiles(dir: string, predicate: (name: string, full: string) => boolean, depth = 3, acc: string[] = []): string[] {
  if (depth < 0) return acc;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (predicate(entry.name, full)) acc.push(full);
    // staged_extension is the web-extension payload — never contains Xcode artifacts.
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "staged_extension") {
      findFiles(full, predicate, depth - 1, acc);
    }
  }
  return acc;
}

export interface PackageOptions {
  stagedDir: string;
  outputDir: string;
  bundleId: string;
  appName: string;
  platforms: Platforms;
  copyResources: boolean;
}

/** Run the Apple packager. Returns path to the generated .xcodeproj, or null. */
export function runPackager(opts: PackageOptions): string | null {
  const args = [
    "safari-web-extension-packager",
    opts.stagedDir,
    "--project-location",
    opts.outputDir,
    "--app-name",
    opts.appName,
    "--bundle-identifier",
    opts.bundleId,
    "--swift",
    "--no-open",
    "--no-prompt",
    "--force",
  ];
  if (opts.copyResources) args.push("--copy-resources");
  if (opts.platforms === "macos") args.push("--macos-only");
  else if (opts.platforms === "ios") args.push("--ios-only");

  info(`xcrun ${args.join(" ")}`);
  const res = run("xcrun", args);
  if (res.code !== 0) {
    warn(`packager stderr:\n${res.stderr.trim()}`);
    return null;
  }

  const projects = findFiles(opts.outputDir, (n) => n.endsWith(".xcodeproj"), 4);
  // Prefer the project we just generated; a stale .xcodeproj from a prior run in a
  // reused outputDir can otherwise be picked (readdir order is not guaranteed).
  return projects.find((p) => basename(p) === `${opts.appName}.xcodeproj`) ?? projects[0] ?? null;
}

/**
 * Stamp a unique version on every target so Safari reloads the extension's resources.
 * Apple's packager hardcodes MARKETING_VERSION = 1.0 and CURRENT_PROJECT_VERSION = 1,
 * so a re-converted extension keeps version "1.0 (1)" forever — and Safari keys its
 * cached copy of the resources (shim, background JS, …) on the user-facing
 * CFBundleShortVersionString (MARKETING_VERSION), serving STALE JS across reinstalls
 * even after a full uninstall + Safari restart (observed live: shim fixes never
 * loaded until this bumped). Both `short` (≤3 dotted ints, CFBundleShortVersionString)
 * and `build` (CFBundleVersion) must be dotted integers.
 */
export function setBuildVersion(xcodeproj: string, opts: { short: string; build: string }): void {
  const pbxproj = join(xcodeproj, "project.pbxproj");
  if (!existsSync(pbxproj)) return;
  const content = readFileSync(pbxproj, "utf-8");
  const next = content
    .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${opts.build};`)
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${opts.short};`);
  if (next !== content) writeFileSync(pbxproj, next, "utf-8");
}

/**
 * Force every PRODUCT_BUNDLE_IDENTIFIER in the project to the intended value.
 * App targets → bundleId; extension/appex targets → bundleId.Extension.
 * This is best-effort; the authoritative check is verifyBuiltBundleId().
 */
export function patchProjectBundleIds(xcodeproj: string, bundleId: string): void {
  const pbxproj = join(xcodeproj, "project.pbxproj");
  if (!existsSync(pbxproj)) return;
  let content = readFileSync(pbxproj, "utf-8");
  const extId = `${bundleId}.Extension`;

  // Extension targets carry a ".Extension" suffix in the generated id. Skip the
  // exact app id: a user bundle id that itself ends in ".Extension" (allowed by
  // BUNDLE_ID_RE) would otherwise be rewritten to the appex id on a re-run,
  // leaving both targets identical and failing verifyBuiltBundleId.
  const escapedBundleId = bundleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  content = content.replace(
    new RegExp(`PRODUCT_BUNDLE_IDENTIFIER = "?(?!${escapedBundleId}"?;)[\\w.\\-$()]+\\.Extension"?;`, "g"),
    `PRODUCT_BUNDLE_IDENTIFIER = "${extId}";`
  );
  // Remaining ones are the app target(s). The value-scoped negative lookahead
  // `(?![\w.\-$()]*\.Extension"?;)` only inspects the current identifier, so it
  // skips lines already rewritten to "<id>.Extension" without scanning the rest
  // of the file (a `.*` lookahead would match any later .Extension line).
  content = content.replace(
    /PRODUCT_BUNDLE_IDENTIFIER = "?(?![\w.\-$()]*\.Extension"?;)[\w.\-$()]+"?;/g,
    `PRODUCT_BUNDLE_IDENTIFIER = "${bundleId}";`
  );
  // The extension appex is sandboxed (ENABLE_APP_SANDBOX = YES) but xcrun only
  // grants ENABLE_OUTGOING_NETWORK_CONNECTIONS to the APP target — not the
  // extension. Without it the appex's URLSession can't resolve any host ("A
  // server with the specified hostname could not be found"), which kills the
  // native HTTP proxy. Grant outgoing network to every sandboxed target that
  // lacks it. Idempotent: skips a block that already has the setting.
  // Add the key right after the sandbox line in any block that doesn't already
  // declare it on the immediately following line. The app target also
  // has it on a separate line, so it ends up duplicated within that block —
  // xcodebuild takes last-wins on identical values, so this is harmless; a
  // proper pbxproj parser would dedupe but isn't worth it for a cosmetic repeat.
  content = content.replace(
    /(\bENABLE_APP_SANDBOX = YES;)(?!\s*ENABLE_OUTGOING_NETWORK_CONNECTIONS)/g,
    "$1\n\t\t\t\tENABLE_OUTGOING_NETWORK_CONNECTIONS = YES;"
  );

  writeFileSync(pbxproj, content, "utf-8");

  // The generated Swift references the extension id for "open preferences" deep links.
  for (const swift of findFiles(xcodeproj.replace(/[^/]+\.xcodeproj$/, ""), (n) => n.endsWith(".swift"), 4)) {
    let s = readFileSync(swift, "utf-8");
    if (s.includes("extensionBundleIdentifier")) {
      s = s.replace(/let extensionBundleIdentifier = "[^"]+"/g, `let extensionBundleIdentifier = "${extId}"`);
      writeFileSync(swift, s, "utf-8");
    }
  }
}
/**
 * Rewrite the generated echo SafariWebExtensionHandler (in the sandboxed appex) to:
 *
 *  1. HTTP proxy — perform `__c2sProxy` requests server-side (no browser CORS) and
 *     set the Chrome-extension Origin header Safari forbids JS/DNR from setting.
 *
 *  2. Native-messaging client — forward `__c2sNM` envelopes over loopback TCP to the
 *     broker that runs in the (unsandboxed) container app. The sandbox forbids the
 *     appex from exec'ing the host or reading Chrome's manifest dir, so the actual
 *     launch happens in the app; here we only relay. `network.client` permits the
 *     loopback connection.
 *
 * Writes the handler when there's a proxy allowlist OR native messaging is used.
 */
export function writeNativeHandler(
  xcodeproj: string,
  opts: { chromeOrigin: string; allowHosts: string[]; nativeMessaging: boolean; brokerPort?: number; brokerToken?: string }
): void {
  const { chromeOrigin, allowHosts, nativeMessaging } = opts;
  if (allowHosts.length === 0 && !nativeMessaging) return;
  const root = xcodeproj.replace(/[^/]+\.xcodeproj$/, "");
  const handlers = findFiles(root, (n) => n === "SafariWebExtensionHandler.swift", 4);
  if (handlers.length === 0) return;

  // These values land inside Swift string literals. Whitelist to characters valid in
  // a hostname / origin so a malformed manifest can't break the literal.
  const hostsLiteral = allowHosts
    .map((h) => h.replace(/[^a-zA-Z0-9.\-:]/g, ""))
    .filter((h) => h.length > 0)
    .map((h) => `"${h}"`)
    .join(", ");
  const originLiteral = chromeOrigin.replace(/[^a-zA-Z0-9.\-:/]/g, "");
  const port = String(opts.brokerPort ?? 0);
  const token = (opts.brokerToken ?? "").replace(/[^a-zA-Z0-9]/g, "");
  // Swift below uses string concatenation, never interpolation (\\(x)), which this JS
  // template literal would corrupt.
  const swift = `//
//  SafariWebExtensionHandler.swift — HTTP proxy + native-messaging broker client.
//  Auto-generated by viaduct. Do not edit.
//
import SafariServices
import Foundation

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling, URLSessionTaskDelegate {
    static let allowHosts: Set<String> = [${hostsLiteral}]
    static let chromeOrigin = "${originLiteral}"
    static let brokerPort: UInt16 = ${port}
    static let brokerToken = "${token}"

    // ── loopback framing (4-byte LE length + JSON), shared with the app broker ──
    static func frameData(_ obj: Any) -> Data? {
        guard JSONSerialization.isValidJSONObject(obj),
              let body = try? JSONSerialization.data(withJSONObject: obj) else { return nil }
        let n = UInt32(truncatingIfNeeded: body.count)
        var out = Data([UInt8(n & 0xff), UInt8((n >> 8) & 0xff), UInt8((n >> 16) & 0xff), UInt8((n >> 24) & 0xff)])
        out.append(body)
        return out
    }
    static func readN(_ fd: Int32, _ n: Int) -> Data? {
        if n == 0 { return Data() }
        var out = Data(); out.reserveCapacity(n)
        var tmp = [UInt8](repeating: 0, count: n)
        while out.count < n {
            let need = n - out.count
            let r = tmp.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, need) }
            if r <= 0 { return nil }
            out.append(contentsOf: tmp[0..<r])
        }
        return out
    }
    static func readFrame(_ fd: Int32) -> Any? {
        guard let h = readN(fd, 4) else { return nil }
        let b = [UInt8](h)
        let len = Int(UInt32(b[0]) | (UInt32(b[1]) << 8) | (UInt32(b[2]) << 16) | (UInt32(b[3]) << 24))
        if len <= 0 || len > 64 * 1024 * 1024 { return nil }
        guard let body = readN(fd, len) else { return nil }
        return try? JSONSerialization.jsonObject(with: body, options: [.allowFragments])
    }
    static func writeAll(_ fd: Int32, _ data: Data) -> Bool {
        var ok = true
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard var p = raw.baseAddress else { ok = false; return }
            var rem = raw.count
            while rem > 0 { let w = Darwin.write(fd, p, rem); if w <= 0 { ok = false; break }; p = p.advanced(by: w); rem -= w }
        }
        return ok
    }
    // One request/reply round-trip to the broker over 127.0.0.1. Returns nil when the
    // broker (container app) isn't running.
    static func brokerCall(_ obj: [String: Any]) -> [String: Any]? {
        if brokerPort == 0 { return nil }
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        if fd < 0 { return nil }
        defer { close(fd) }
        _ = fcntl(fd, F_SETNOSIGPIPE, 1)
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = brokerPort.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let c = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if c < 0 { return nil }
        guard let frame = frameData(obj), writeAll(fd, frame) else { return nil }
        return readFrame(fd) as? [String: Any]
    }

    func handleNative(_ context: NSExtensionContext, _ dict: [String: Any]) {
        var env = dict
        env["token"] = Self.brokerToken
        if let reply = Self.brokerCall(env) {
            self.reply(context, reply)
        } else {
            self.reply(context, ["error": "native-messaging broker unavailable — open the extension's app", "closed": true])
        }
    }

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = item?.userInfo?[SFExtensionMessageKey]
        } else {
            message = item?.userInfo?["message"]
        }

        guard let dict = message as? [String: Any] else {
            self.reply(context, ["echo": message as Any])
            return
        }

        if dict["__c2sNM"] != nil {
            self.handleNative(context, dict)
            return
        }

        guard dict["__c2sProxy"] as? Bool == true,
              !Self.allowHosts.isEmpty,
              let urlString = dict["url"] as? String,
              let url = URL(string: urlString),
              let host = url.host,
              Self.hostAllowed(host) else {
            self.reply(context, ["echo": message as Any])
            return
        }

        var req = URLRequest(url: url)
        req.httpMethod = (dict["method"] as? String) ?? "GET"
        if let headers = dict["headers"] as? [String: String] {
            for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        }
        if !Self.chromeOrigin.isEmpty {
            req.setValue(Self.chromeOrigin, forHTTPHeaderField: "Origin")
        }
        if let cookie = dict["cookie"] as? String, !cookie.isEmpty {
            req.setValue(cookie, forHTTPHeaderField: "Cookie")
        }
        req.httpShouldHandleCookies = false
        if let body = dict["body"] as? String { req.httpBody = body.data(using: .utf8) }

        let cfg = URLSessionConfiguration.default
        cfg.httpShouldSetCookies = false
        cfg.httpCookieAcceptPolicy = .never
        let session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        let task = session.dataTask(with: req) { data, response, error in
            if let error = error {
                self.reply(context, ["error": error.localizedDescription])
                return
            }
            let http = response as? HTTPURLResponse
            var headers: [String: String] = [:]
            for (k, v) in (http?.allHeaderFields ?? [:]) {
                if let ks = k as? String, let vs = v as? String { headers[ks] = vs }
            }
            self.reply(context, [
                "status": http?.statusCode ?? 200,
                "headers": headers,
                "bodyB64": (data ?? Data()).base64EncodedString(),
            ])
        }
        task.resume()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        if let host = request.url?.host, Self.hostAllowed(host) {
            completionHandler(request)
        } else {
            completionHandler(nil)
        }
    }

    static func hostAllowed(_ host: String) -> Bool {
        let h = host.lowercased()
        for a in allowHosts where h == a || h.hasSuffix("." + a) { return true }
        return false
    }

    private func reply(_ context: NSExtensionContext, _ payload: [String: Any]) {
        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: payload]
        } else {
            response.userInfo = ["message": payload]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
`;
  for (const h of handlers) writeFileSync(h, swift, "utf-8");
}

/**
 * Disable the App Sandbox on the APP target only. Safari REQUIRES the appex to keep
 * com.apple.security.app-sandbox or it refuses to register the extension, but the
 * container app can be unsandboxed — and must be, since it hosts the broker that
 * reads Chrome's host-manifest dir and exec's the host binary (both forbidden under
 * the sandbox). ENABLE_APP_SANDBOX precedes PRODUCT_BUNDLE_IDENTIFIER in every Xcode
 * build-config block (settings are emitted alphabetically), so pair them and flip
 * only blocks whose bundle id is NOT the ".Extension" appex.
 */
export function unsandboxAppTarget(xcodeproj: string): void {
  const pbxproj = join(xcodeproj, "project.pbxproj");
  if (!existsSync(pbxproj)) return;
  const content = readFileSync(pbxproj, "utf-8");
  const next = content.replace(
    /ENABLE_APP_SANDBOX = YES;([\s\S]*?PRODUCT_BUNDLE_IDENTIFIER = "?)([\w.\-$()]+)("?;)/g,
    (m, mid, bid, tail) => (bid.endsWith(".Extension") ? m : "ENABLE_APP_SANDBOX = NO;" + mid + bid + tail),
  );
  if (next !== content) writeFileSync(pbxproj, next, "utf-8");
}

/**
 * Install the native-messaging broker into the (unsandboxed) container app by
 * rewriting its AppDelegate.swift. The broker listens on 127.0.0.1:<port>, gated by
 * a build-time token, and for each `__c2sNM` op the appex forwards it: locates the
 * Chrome native-messaging host manifest, launches the host binary, and pipes Chrome's
 * stdio framing — persisting each launched host across ops keyed by the JS port id.
 * The app stays alive after its window closes so the broker keeps serving.
 */
export function writeAppBroker(xcodeproj: string, opts: { brokerPort: number; brokerToken: string }): void {
  const root = xcodeproj.replace(/[^/]+\.xcodeproj$/, "");
  const delegates = findFiles(root, (n) => n === "AppDelegate.swift", 4);
  if (delegates.length === 0) return;
  const port = String(opts.brokerPort);
  const token = opts.brokerToken.replace(/[^a-zA-Z0-9]/g, "");
  const swift = `//
//  AppDelegate.swift — host app + native-messaging broker.
//  Auto-generated by viaduct. Do not edit.
//
import Cocoa
import Foundation

@main
class AppDelegate: NSObject, NSApplicationDelegate {
    // Retain the activity token for the whole process lifetime — releasing it ends the
    // activity and re-arms automatic termination.
    var activityToken: NSObjectProtocol?
    func applicationDidFinishLaunching(_ notification: Notification) {
        // The broker is a windowless background helper. macOS "automatic termination"
        // reaps such a process when it looks idle (observed live: the app was terminated
        // and KeepAlive-relaunched), which WIPES the broker's in-memory host map and
        // orphans live native hosts → every subsequent poll returns closed. Holding a
        // background activity for the whole process lifetime is the documented, reliable
        // opt-out (it disables both automatic and sudden termination while held).
        NSApp.setActivationPolicy(.accessory)
        activityToken = ProcessInfo.processInfo.beginActivity(
            options: [.automaticTerminationDisabled, .suddenTerminationDisabled, .background],
            reason: "native-messaging broker")
        NMBroker.shared.start()
    }
    // Stay alive after the window closes so the broker keeps serving the extension.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }
}

// One launched Chrome native-messaging host, keyed by the JS-side port id.
final class NMHost {
    let proc = Process()
    let stdinPipe = Pipe()
    let stdoutPipe = Pipe()
    var inbox: [Any] = []
    var buf = Data()
    var closed = false
    let lock = NSLock()
    let writeLock = NSLock()
}

// One tunneled WebSocket to a loopback app server, keyed by the JS-side ws id.
// Safari blocks insecure ws:// from the (secure) extension page as mixed content
// (no loopback exemption), so the panel's WebSocket to the local app server is
// relayed here: this native process holds the real connection (URLSession has no
// mixed-content limit) and the extension sends/polls frames over the broker.
final class NMWS: NSObject, URLSessionWebSocketDelegate {
    var session: URLSession?
    var task: URLSessionWebSocketTask?
    var inbox: [[String: String]] = []
    var open = false
    var closed = false
    var code = 0
    var lastSeen = Date()
    var clientId = ""
    let lock = NSLock()
    func connect(_ urlStr: String, _ origin: String) {
        guard let u = URL(string: urlStr) else { finish(1006); return }
        var req = URLRequest(url: u)
        if !origin.isEmpty { req.setValue(origin, forHTTPHeaderField: "Origin") }
        let s = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        session = s
        let t = s.webSocketTask(with: req)
        // URLSessionWebSocketTask defaults to a 1 MiB max frame; a single app-server
        // message (e.g. an echoed user turn carrying injected page/tab context, or thread
        // state) can exceed that, which fails receive() and drops the socket. Raise it.
        t.maximumMessageSize = 100 * 1024 * 1024
        task = t
        t.resume()
        receive()
    }
    static let CHUNK = 100_000
    func receive() {
        task?.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure:
                self.finish(1006)
            case .success(let m):
                switch m {
                case .string(let str): self.enqueueText(str)
                case .data(let d): self.enqueueBinary(d.base64EncodedString())
                @unknown default: break
                }
                NMBroker.shared.blog("WS-RECV<-appserver")
                self.receive()
            }
        }
    }
    // Safari's native-messaging relay (broker→panel via sendNativeMessage) caps a single
    // message; a large app-server frame (e.g. an echoed turn carrying page/tab context)
    // must be split so each wspoll response stays small. Small messages pass whole.
    func enqueueText(_ str: String) {
        if str.utf8.count <= NMWS.CHUNK { lock.lock(); inbox.append(["kind": "text", "text": str]); lock.unlock(); return }
        chunkInto(Data(str.utf8).base64EncodedString(), "text")
    }
    func enqueueBinary(_ b64: String) {
        if b64.utf8.count <= NMWS.CHUNK { lock.lock(); inbox.append(["kind": "binary", "b64": b64]); lock.unlock(); return }
        chunkInto(b64, "binary")
    }
    func chunkInto(_ b64: String, _ ck: String) {
        let chars = Array(b64.utf8)  // base64 is ASCII → 1 byte per char, safe to split
        let n = (chars.count + NMWS.CHUNK - 1) / NMWS.CHUNK
        let id = UUID().uuidString
        lock.lock(); defer { lock.unlock() }
        var i = 0, idx = 0
        while idx < chars.count {
            let end = min(idx + NMWS.CHUNK, chars.count)
            let part = String(decoding: chars[idx..<end], as: UTF8.self)
            inbox.append(["kind": "chunk", "id": id, "i": String(i), "n": String(n), "ck": ck, "d": part])
            i += 1; idx = end
        }
    }
    func urlSession(_ s: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol proto: String?) {
        lock.lock(); open = true; lock.unlock()
        NMBroker.shared.blog("WS-OPEN cid=" + clientId)
    }
    func urlSession(_ s: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith c: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        finish(c.rawValue)
    }
    func finish(_ c: Int) {
        lock.lock(); if !closed { closed = true; code = c }; lock.unlock()
        NMBroker.shared.blog("WS-CLOSE code=" + String(c))
    }
    func shutdown() {
        task?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()
    }
}

final class NMBroker {
    static let shared = NMBroker()
    static let port: UInt16 = ${port}
    static let token = "${token}"
    let lock = NSLock()
    let blogLock = NSLock()
    func blog(_ s: String) {
        let p = (NSHomeDirectory() as NSString).appendingPathComponent("viaduct-broker.log")
        let t = Int(Date().timeIntervalSince1970 * 1000) % 1000000
        let bytes = (String(t) + " " + s + "\\n").data(using: .utf8) ?? Data()
        blogLock.lock()
        if let fh = FileHandle(forWritingAtPath: p) { fh.seekToEndOfFile(); fh.write(bytes); try? fh.close() }
        else { try? bytes.write(to: URL(fileURLWithPath: p)) }
        blogLock.unlock()
    }
    var hosts: [String: NMHost] = [:]
    var wsConns: [String: NMWS] = [:]
    let queue = DispatchQueue(label: "viaduct.nmbroker", attributes: .concurrent)
    func start() {
        signal(SIGPIPE, SIG_IGN)   // writing to a dead host/socket must not kill us
        queue.async { self.serve() }
    }

    func serve() {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        if fd < 0 { return }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = NMBroker.port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")   // loopback only
        let bound = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if bound < 0 { close(fd); return }
        if listen(fd, 32) < 0 { close(fd); return }
        while true {
            let c = accept(fd, nil, nil)
            if c < 0 { if errno == EINTR { continue }; break }
            _ = fcntl(c, F_SETNOSIGPIPE, 1)
            queue.async { self.handleConn(c) }
        }
        close(fd)
    }

    // ── framing (shared shape with the appex client) ──
    static func frameData(_ obj: Any) -> Data? {
        let body: Data
        if JSONSerialization.isValidJSONObject(obj) {
            guard let d = try? JSONSerialization.data(withJSONObject: obj) else { return nil }
            body = d
        } else {
            let enc = JSONEncoder()
            if let s = obj as? String, let d = try? enc.encode(s) { body = d }
            else if let b = obj as? Bool, let d = try? enc.encode(b) { body = d }
            else if let i = obj as? Int, let d = try? enc.encode(i) { body = d }
            else if let x = obj as? Double, let d = try? enc.encode(x) { body = d }
            else { return nil }
        }
        let n = UInt32(truncatingIfNeeded: body.count)
        var out = Data([UInt8(n & 0xff), UInt8((n >> 8) & 0xff), UInt8((n >> 16) & 0xff), UInt8((n >> 24) & 0xff)])
        out.append(body)
        return out
    }
    func readN(_ fd: Int32, _ n: Int) -> Data? {
        if n == 0 { return Data() }
        var out = Data(); out.reserveCapacity(n)
        var tmp = [UInt8](repeating: 0, count: n)
        while out.count < n {
            let need = n - out.count
            let r = tmp.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, need) }
            if r <= 0 { return nil }
            out.append(contentsOf: tmp[0..<r])
        }
        return out
    }
    func readFrame(_ fd: Int32) -> Any? {
        guard let h = readN(fd, 4) else { return nil }
        let b = [UInt8](h)
        let len = Int(UInt32(b[0]) | (UInt32(b[1]) << 8) | (UInt32(b[2]) << 16) | (UInt32(b[3]) << 24))
        if len <= 0 || len > 64 * 1024 * 1024 { return nil }
        guard let body = readN(fd, len) else { return nil }
        return try? JSONSerialization.jsonObject(with: body, options: [.allowFragments])
    }
    func writeAll(_ fd: Int32, _ data: Data) -> Bool {
        var ok = true
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard var p = raw.baseAddress else { ok = false; return }
            var rem = raw.count
            while rem > 0 { let w = Darwin.write(fd, p, rem); if w <= 0 { ok = false; break }; p = p.advanced(by: w); rem -= w }
        }
        return ok
    }
    func handleConn(_ fd: Int32) {
        defer { close(fd) }
        guard let req = readFrame(fd) as? [String: Any] else { return }
        guard (req["token"] as? String) == NMBroker.token else { return }
        let reply = handleOp(req)
        if let frame = NMBroker.frameData(reply) { _ = writeAll(fd, frame) }
    }

    // ── Chrome native-messaging host management ──
    func manifestDirs() -> [String] {
        let home = NSHomeDirectory()
        let bases = [
            "Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Google/Chrome Dev",
            "Google/Chrome for Testing", "Chromium", "Microsoft Edge", "Microsoft Edge Beta",
            "BraveSoftware/Brave-Browser", "Vivaldi", "com.operasoftware.Opera", "Arc/User Data"
        ]
        var dirs: [String] = []
        for b in bases { dirs.append(home + "/Library/Application Support/" + b + "/NativeMessagingHosts") }
        dirs.append("/Library/Google/Chrome/NativeMessagingHosts")
        dirs.append("/Library/Application Support/Chromium/NativeMessagingHosts")
        dirs.append("/Library/Microsoft/Edge/NativeMessagingHosts")
        return dirs
    }
    func findManifest(_ host: String) -> [String: Any]? {
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789._")
        let safe = String(host.lowercased().filter { allowed.contains($0) })
        if safe.isEmpty { return nil }
        for dir in manifestDirs() {
            let path = dir + "/" + safe + ".json"
            guard let data = FileManager.default.contents(atPath: path) else { continue }
            if let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] { return obj }
        }
        return nil
    }
    func drainFrames(_ h: NMHost) {
        while h.buf.count >= 4 {
            let b = [UInt8](h.buf.subdata(in: 0..<4))
            let len = Int(UInt32(b[0]) | (UInt32(b[1]) << 8) | (UInt32(b[2]) << 16) | (UInt32(b[3]) << 24))
            let total = 4 + len
            if len < 0 || h.buf.count < total { break }
            let body = h.buf.subdata(in: 4..<total)
            h.buf.removeSubrange(0..<total)
            if let obj = try? JSONSerialization.jsonObject(with: body, options: [.allowFragments]) { h.inbox.append(obj) }
        }
    }
    func drain(_ h: NMHost) -> [Any] {
        h.lock.lock(); let o = h.inbox; h.inbox.removeAll(); h.lock.unlock(); return o
    }
    func launch(_ host: String) -> NMHost? {
        guard let manifest = findManifest(host) else { return nil }
        guard let path = manifest["path"] as? String, !path.isEmpty else { return nil }
        let h = NMHost()
        h.proc.executableURL = URL(fileURLWithPath: path)
        var origin = ""
        if let origins = manifest["allowed_origins"] as? [String], let first = origins.first, !first.isEmpty { origin = first }
        h.proc.arguments = origin.isEmpty ? [] : [origin]
        h.proc.standardInput = h.stdinPipe
        h.proc.standardOutput = h.stdoutPipe
        h.proc.standardError = FileHandle.nullDevice
        h.stdoutPipe.fileHandleForReading.readabilityHandler = { fh in
            let d = fh.availableData
            if d.isEmpty { fh.readabilityHandler = nil; h.lock.lock(); h.closed = true; h.lock.unlock(); return }
            h.lock.lock(); h.buf.append(d); self.drainFrames(h); h.lock.unlock()
        }
        h.proc.terminationHandler = { _ in h.lock.lock(); h.closed = true; h.lock.unlock() }
        do { try h.proc.run() } catch { return nil }
        _ = fcntl(h.stdinPipe.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
        return h
    }
    func writeToHost(_ h: NMHost, _ message: Any) -> Bool {
        guard let frame = NMBroker.frameData(message) else { return false }
        h.writeLock.lock()
        let ok = writeAll(h.stdinPipe.fileHandleForWriting.fileDescriptor, frame)
        h.writeLock.unlock()
        if !ok { h.lock.lock(); h.closed = true; h.lock.unlock() }
        return ok
    }

    func handleOp(_ dict: [String: Any]) -> [String: Any] {
        let op = dict["op"] as? String ?? ""
        switch op {
        case "connect":
            let host = dict["host"] as? String ?? ""
            let portId = dict["portId"] as? String ?? ""
            lock.lock()
            var conn = hosts[portId]
            if conn == nil { conn = launch(host); if let c = conn { hosts[portId] = c } }
            lock.unlock()
            guard let h = conn else { return ["error": "native host '" + host + "' not found or failed to launch"] }
            let __m = drain(h); blog("connect host=" + host + " port=" + portId + " msgs=" + String(__m.count)); return ["ok": true, "messages": __m]
        case "post":
            let portId = dict["portId"] as? String ?? ""
            lock.lock(); let conn = hosts[portId]; lock.unlock()
            guard let h = conn else { return ["error": "port closed", "closed": true] }
            blog("post port=" + portId)
            var wrote = true
            if let message = dict["message"] { wrote = writeToHost(h, message) }
            if !wrote { return ["error": "write failed", "closed": true] }
            return ["ok": true]
        case "poll":
            let portId = dict["portId"] as? String ?? ""
            lock.lock(); let conn = hosts[portId]; lock.unlock()
            guard let h = conn else { return ["closed": true, "messages": []] }
            let msgs = drain(h); blog("poll port=" + portId + " msgs=" + String(msgs.count) + (h.closed ? " CLOSED" : ""))
            if h.closed && msgs.isEmpty {
                h.stdoutPipe.fileHandleForReading.readabilityHandler = nil
                lock.lock(); hosts.removeValue(forKey: portId); lock.unlock()
                return ["closed": true, "messages": []]
            }
            return ["messages": msgs, "closed": false]
        case "disconnect":
            let portId = dict["portId"] as? String ?? ""
            lock.lock(); let h = hosts.removeValue(forKey: portId); lock.unlock()
            h?.stdoutPipe.fileHandleForReading.readabilityHandler = nil
            h?.proc.terminate()
            return ["ok": true]
        case "once":
            let host = dict["host"] as? String ?? ""
            guard let h = launch(host) else { return ["error": "native host '" + host + "' not found"] }
            if let message = dict["message"] { _ = writeToHost(h, message) }
            var reply: Any? = nil
            let deadline = Date().addingTimeInterval(10)
            while Date() < deadline {
                h.lock.lock(); if !h.inbox.isEmpty { reply = h.inbox.removeFirst() }; let closed = h.closed; h.lock.unlock()
                if reply != nil || closed { break }
                Thread.sleep(forTimeInterval: 0.02)
            }
            h.stdoutPipe.fileHandleForReading.readabilityHandler = nil
            h.proc.terminate()
            if let r = reply { return ["message": r] }
            return ["error": "no reply from native host '" + host + "'"]
        case "wsopen":
            let wsId = dict["wsId"] as? String ?? ""
            let url = dict["url"] as? String ?? ""
            let origin = dict["origin"] as? String ?? ""
            if wsId.isEmpty || url.isEmpty { return ["error": "bad wsopen params"] }
            var cid = ""
            if let comps = URLComponents(string: url), let items = comps.queryItems {
                for it in items where it.name == "clientId" { cid = it.value ?? "" }
            }
            let w = NMWS(); w.clientId = cid
            lock.lock()
            // Retire (a) connections unpolled for a while — a live tunnel polls
            // continuously, so silence means the panel context went away without closing
            // it (a GC'd/torn-down page never sends wsclose), and (b) any prior connection
            // for the same client id. Many local app servers allow only ONE connection per
            // client (identified by a clientId query param) and drop the older when a new
            // one arrives; retiring it here — instead of letting the server kill it — keeps
            // the broker's live set in step with the panel and avoids a reconnect war.
            let now = Date()
            for (k, v) in wsConns where now.timeIntervalSince(v.lastSeen) > 60 || (!cid.isEmpty && v.clientId == cid) {
                v.shutdown(); wsConns.removeValue(forKey: k)
            }
            wsConns[wsId] = w
            lock.unlock()
            w.connect(url, origin)
            blog("wsopen cid=" + cid + " url=" + url)
            return ["ok": true]
        case "wssend":
            let sid = dict["wsId"] as? String ?? ""
            lock.lock(); let sw = wsConns[sid]; lock.unlock()
            guard let sconn = sw, let stask = sconn.task else { return ["error": "ws not open", "closed": true] }
            let kind = dict["kind"] as? String ?? "text"
            blog("wssend kind=" + kind)
            if kind == "binary", let b64 = dict["b64"] as? String, let d = Data(base64Encoded: b64) {
                stask.send(.data(d)) { _ in }
            } else if let text = dict["text"] as? String {
                stask.send(.string(text)) { _ in }
            }
            return ["ok": true]
        case "wspoll":
            let pid = dict["wsId"] as? String ?? ""
            lock.lock(); let pw = wsConns[pid]; pw?.lastSeen = Date(); lock.unlock()
            guard let pconn = pw else { return ["closed": true, "messages": []] }
            pconn.lock.lock()
            // Drain up to ~200 KB of records per poll so each native-messaging response
            // stays within Safari's relay cap; the shim polls again for the rest.
            var msgs: [[String: String]] = []
            var used = 0
            while !pconn.inbox.isEmpty {
                let rec = pconn.inbox[0]
                let sz = (rec["text"]?.utf8.count ?? 0) + (rec["b64"]?.utf8.count ?? 0) + (rec["d"]?.utf8.count ?? 0)
                if !msgs.isEmpty && used + sz > 200_000 { break }
                msgs.append(rec); pconn.inbox.removeFirst(); used += sz
            }
            let isOpen = pconn.open; let isClosed = pconn.closed; let ccode = pconn.code
            pconn.lock.unlock()
            blog("wspoll msgs=" + String(msgs.count) + (isClosed ? " CLOSED" : ""))
            if isClosed && msgs.isEmpty {
                pconn.shutdown()
                lock.lock(); wsConns.removeValue(forKey: pid); lock.unlock()
                return ["closed": true, "messages": [], "code": ccode]
            }
            return ["messages": msgs, "open": isOpen, "closed": false]
        case "wsclose":
            let xid = dict["wsId"] as? String ?? ""
            lock.lock(); let cw = wsConns.removeValue(forKey: xid); lock.unlock()
            cw?.shutdown()
            return ["ok": true]
        case "clog":
            let line = dict["line"] as? String ?? ""
            let logPath = (NSHomeDirectory() as NSString).appendingPathComponent("viaduct-cdp.log")
            let bytes = (line + "\\n").data(using: .utf8) ?? Data()
            lock.lock()
            if let fh = FileHandle(forWritingAtPath: logPath) { fh.seekToEndOfFile(); fh.write(bytes); try? fh.close() }
            else { try? bytes.write(to: URL(fileURLWithPath: logPath)) }
            lock.unlock()
            return ["ok": true]
        default:
            return ["error": "unknown native op '" + op + "'"]
        }
    }
}
`;
  for (const d of delegates) writeFileSync(d, swift, "utf-8");
}

function pickScheme(xcodeproj: string, appName: string, platforms: Platforms): string | null {
  const res = run("xcodebuild", ["-project", xcodeproj, "-list", "-json"]);
  if (res.code !== 0) return null;
  let schemes: string[] = [];
  try {
    schemes = JSON.parse(res.stdout)?.project?.schemes ?? [];
  } catch {
    return null;
  }
  const want = platforms === "ios" ? "iOS" : "macOS";
  const preferred = [`${appName} (${want})`, appName, `${want} (App)`];
  for (const p of preferred) if (schemes.includes(p)) return p;
  const byPlat = schemes.find((s) => s.includes(want));
  return byPlat ?? schemes[0] ?? null;
}

/**
 * xcodebuild splits a failed build across both streams: the diagnostics that say
 * WHY ("… error: No Account for Team "X" …") go to stdout, while stderr carries
 * only the "** BUILD FAILED **" summary and run-destination noise. Printing
 * stderr and falling back to stdout only when stderr is empty therefore hid every
 * signing error behind a summary that names no cause (issue #15). Collect the
 * diagnostics from both streams instead, and keep the tail of the raw output as the
 * last resort for a failure that carries no diagnostic at all.
 */
export function xcodebuildDiagnostics(res: { stdout: string; stderr: string }): string {
  const combined = `${res.stdout}\n${res.stderr}`;
  // Keyed on the diagnostic without its trailing "(in target 'X' from project 'Y')":
  // xcodebuild reports one signing failure once per target, and four lines saying the
  // same thing bury the two that differ. First occurrence wins, target and all.
  const seen = new Map<string, string>();
  for (const line of combined.split("\n")) {
    if (!/(?:^|\s)(?:error|fatal error):/.test(line)) continue;
    const text = line.trim();
    if (!text) continue;
    const key = text.replace(/\s*\(in target '.*$/, "");
    if (!seen.has(key)) seen.set(key, text);
    // A thousand compile errors are no more informative than the first few, and this
    // lands in a terminal (and in bug reports).
    if (seen.size >= 20) break;
  }
  return seen.size ? [...seen.values()].join("\n") : combined.trim().slice(-2000);
}

/** Signing failures xcodebuild reports when the team it was handed is not one this
 *  machine can sign for: no Apple account, no certificate, no profile. These are
 *  recoverable by dropping to ad-hoc; a compile error is not. */
const SIGNING_FAILURE =
  /error:.*(No Account for Team|No signing certificate|requires a development team|No profiles for|Failed to (?:register bundle identifier|create provisioning profile)|Provisioning profile .* (?:doesn't|does not) )/;

export interface XcodeBuildResult {
  builtApp: string;
  derivedDir: string;
  /** The team-signed build failed for a signing reason and the app was rebuilt
   *  ad-hoc instead, so the artifact carries no team signature and Safari needs
   *  its unsigned-extensions toggle. */
  adHocFallback?: boolean;
}

/**
 * Build the Xcode project. With `team` → automatic Apple-issued dev signing, which
 * Safari loads WITHOUT the session-scoped "Allow Unsigned Extensions" toggle, so the
 * extension survives quitting Safari. Without `team` → ad-hoc signing (needs the toggle,
 * which resets every Safari session). Returns the freshly built .app still sitting in
 * the throwaway DerivedData dir, plus that dir — the caller MOVES the app to its final
 * home (no intermediate copy) and then deletes the dir.
 */
export function buildXcodeProject(
  xcodeproj: string,
  appName: string,
  platforms: Platforms,
  team?: string,
  opts: { teamAutoDetected?: boolean } = {}
): XcodeBuildResult | null {
  const scheme = pickScheme(xcodeproj, appName, platforms);
  if (!scheme) {
    warn("No Xcode scheme found; skipping build.");
    return null;
  }
  // One xcodebuild run. Kept as a closure so a team-signed build that dies on
  // signing can be retried ad-hoc without redoing scheme lookup.
  const attempt = (
    signWithTeam: string | undefined,
  ): { app: string; derived: string } | { signingFailure: boolean } => {
    // Build into a temp DerivedData OUTSIDE the project tree. When the project lives on
    // an iCloud-synced volume (e.g. ~/Desktop or ~/Documents), the file provider stamps
    // the freshly built .appex with `com.apple.fileprovider.fpfs#P` / `com.apple.FinderInfo`,
    // and codesign then aborts with "resource fork, Finder information, or similar detritus
    // not allowed" — so signing the App Sandbox entitlement fails and the build dies.
    // $TMPDIR is never file-provider managed, so the bundle stays clean for signing.
    const derived = mkdtempSync(join(tmpdir(), "c2s-dd-"));
    const signing = signWithTeam
      ? [
          // Real Apple-issued development signing. Automatic style + -allowProvisioningUpdates
          // lets Xcode create/refresh the development provisioning profile (the App Sandbox
          // entitlement requires one). A team-signed extension loads in Safari without the
          // unsigned toggle and persists across restarts.
          "-allowProvisioningUpdates",
          "CODE_SIGN_STYLE=Automatic",
          `DEVELOPMENT_TEAM=${signWithTeam}`,
          "CODE_SIGN_IDENTITY=Apple Development",
        ]
      : [
          // Ad-hoc sign WITH entitlements. The targets set ENABLE_APP_SANDBOX=YES, which
          // Xcode turns into the App Sandbox entitlement at sign time — and Safari refuses
          // to register a web-extension appex that lacks it. CODE_SIGNING_ALLOWED=NO skips
          // signing AND entitlement application, so the extension silently never appears in
          // Safari. Manual style + empty team/profile lets the ad-hoc "-" identity sign
          // without a provisioning profile.
          "CODE_SIGN_IDENTITY=-",
          "CODE_SIGN_STYLE=Manual",
          "DEVELOPMENT_TEAM=",
          "PROVISIONING_PROFILE_SPECIFIER=",
          "CODE_SIGNING_REQUIRED=NO",
        ];
    const args = [
      "-project",
      xcodeproj,
      "-scheme",
      scheme,
      "-configuration",
      "Release",
      "-derivedDataPath",
      derived,
      ...signing,
      "build",
    ];
    info(`xcodebuild -scheme "${scheme}" (${signWithTeam ? `team ${signWithTeam}` : "ad-hoc"} signed)`);
    const res = run("xcodebuild", args);
    if (res.code !== 0) {
      warn(`build failed:\n${xcodebuildDiagnostics(res)}`);
      rmSync(derived, { recursive: true, force: true });
      return { signingFailure: SIGNING_FAILURE.test(`${res.stdout}\n${res.stderr}`) };
    }
    // Search the whole Products dir, not just Release/: macOS lands the app in
    // "Release", but an iOS build puts it in the SDK-suffixed "Release-iphoneos"
    // sibling — a hardcoded "Release" path finds no .app for iOS, so the build
    // reads as failed. The name match below still prevents a wrong-platform bundle.
    const productsDir = join(derived, "Build", "Products");
    const apps = findFiles(productsDir, (n) => n.endsWith(".app"), 4);
    // Match the app we built by name; a multi-platform Products dir can hold several .app
    // bundles, and readdir order is not guaranteed, so [0] could be the wrong one — never
    // fall back to an arbitrary bundle (it could be the iOS app for a macOS build).
    const built = apps.find((p) => basename(p) === `${appName}.app`);
    if (!built) {
      rmSync(derived, { recursive: true, force: true });
      return { signingFailure: false };
    }
    return { app: built, derived };
  };

  // Hand the signed .app back where it sits (in DerivedData). The caller moves it to its
  // final home in one hop — no copy onto the iCloud-synced project tree — then deletes
  // derivedDir. A move preserves the signature/seal untouched (no re-stamp, no re-sign).
  const first = attempt(team);
  if ("app" in first) return { builtApp: first.app, derivedDir: first.derived };

  // An auto-detected team can turn out to be one this machine cannot sign for — an
  // expired certificate, a revoked account, a free team that hit Apple's app-id
  // limit. The user asked for "whatever signing you can manage", so finish the
  // conversion ad-hoc instead of throwing the whole run away; the caller adjusts
  // its signing expectation and tells the user about the unsigned toggle.
  if (!team || !opts.teamAutoDetected || !first.signingFailure) return null;
  warn(
    `Team ${team} cannot sign on this Mac (see the error above) — rebuilding ad-hoc so the conversion still produces an app.\n` +
      "  Ad-hoc extensions need Safari → Develop → \"Allow Unsigned Extensions\" re-ticked after every Safari restart.\n" +
      "  To get a team-signed build, sign in to Xcode → Settings → Accounts, then re-run.",
  );
  const retry = attempt(undefined);
  if (!("app" in retry)) return null;
  return { builtApp: retry.app, derivedDir: retry.derived, adHocFallback: true };
}

export function plistValue(plistPath: string, key: string): string | null {
  if (!existsSync(plistPath)) return null;
  const res = run("plutil", ["-extract", key, "raw", "-o", "-", plistPath]);
  return res.code === 0 ? res.stdout.trim() : null;
}

export interface BundleVerification {
  ok: boolean;
  appId: string | null;
  extId: string | null;
  expectedAppId: string;
  expectedExtId: string;
}

/**
 * Read the BUILT bundle Info.plists and confirm the identifiers match intent.
 * This is the check v2 lacked: it patched the project but never verified the
 * compiled .appex, so Safari registered the packager-default id.
 *
 * Handles BOTH bundle layouts: a macOS app nests everything under `Contents/`
 * (Contents/Info.plist, Contents/PlugIns/Foo.appex/Contents/Info.plist); an iOS
 * `.app` is flat (Info.plist + PlugIns/Foo.appex/Info.plist at the root).
 * Detecting the layout per-bundle keeps iOS builds from spuriously failing — the
 * old macOS-only `Contents/` paths returned null for every iOS app, which
 * convert.ts then treats as a fatal bundle-id mismatch and aborts the build.
 */
export function verifyBuiltBundleId(appPath: string, bundleId: string): BundleVerification {
  const expectedAppId = bundleId;
  const expectedExtId = `${bundleId}.Extension`;
  // macOS bundles hold Info.plist under Contents/; iOS bundles are flat. Resolve
  // the dir that actually carries Info.plist for each bundle (app and appex).
  const plistDir = (base: string) =>
    existsSync(join(base, "Contents", "Info.plist")) ? join(base, "Contents") : base;
  const appDir = plistDir(appPath);
  const appId = plistValue(join(appDir, "Info.plist"), "CFBundleIdentifier");

  const appexes = findFiles(join(appDir, "PlugIns"), (n) => n.endsWith(".appex"), 1);
  const extId = appexes.length
    ? plistValue(join(plistDir(appexes[0]), "Info.plist"), "CFBundleIdentifier")
    : null;

  return {
    ok: appId === expectedAppId && extId === expectedExtId,
    appId,
    extId,
    expectedAppId,
    expectedExtId,
  };
}

/** Query macOS pluginkit for Safari web-extension registration. */
export function pluginkitStatus(): string {
  const res = run("pluginkit", ["-mAvvv", "-p", "com.apple.Safari.web-extension"]);
  return res.stdout.trim();
}

/**
 * Best-effort read of Safari's "Allow Unsigned Extensions" toggle.
 * It is session-scoped and required to load ad-hoc-signed extensions.
 */
export function unsignedExtensionsAllowed(): boolean | null {
  const res = run("defaults", ["read", "com.apple.Safari", "AllowUnsignedAppExtensions"]);
  if (res.code !== 0) return null;
  return res.stdout.trim() === "1";
}

/** A real Apple team id is exactly 10 alphanumerics; anchor so a longer token
 *  never gets truncated into a wrong-but-plausible id. */
const TEAM_ID = "([A-Z0-9]{10})(?![A-Z0-9])";

/**
 * Best-effort read of an Apple Developer Team ID, so the tool can team-sign
 * without the user knowing or passing the id. The team id is all the build
 * needs: xcodebuild runs with -allowProvisioningUpdates, so Xcode mints the
 * development certificate and profile on demand. Sources: Xcode's cached team
 * list (and xcodebuild's copy of it), the provisioning profiles on disk, and the
 * codesigning identities in the keychain. Returns null when nothing usable turns
 * up, which the caller reports as an ad-hoc fallback.
 *
 * A team id lying on disk is not proof this Mac can sign for it. Profiles outlive
 * the account that installed them, and installers drop profiles for their vendor's
 * team — issue #15 auto-detected a third-party vendor's team on a Mac with no Apple
 * account, so every build died on "No Account for Team". Only a team Xcode holds an
 * account for, or one with a certificate in the keychain, can actually sign. So a
 * profile now only chooses among those; it never nominates a team on its own.
 */
export function detectXcodeTeam(): string | null {
  const accounts = teamsFromPrefs();
  const certs = teamsFromKeychain();
  const signable = new Set([...accounts, ...certs]);
  // Newest profile first, so when the keychain holds several teams the pick is the
  // one the user most recently provisioned for.
  const provisioned = teamsFromProvisioningProfiles().filter((id) => signable.has(id));
  return accounts[0] ?? provisioned[0] ?? certs[0] ?? null;
}

/**
 * Team ids Xcode caches after an account is added. Two domains and two keys:
 * Xcode writes IDEProvisioningTeamByIdentifier (keyed by Apple ID account uuid),
 * older versions and xcodebuild itself write IDEProvisioningTeams, and the
 * xcodebuild domain is sometimes populated when the Xcode one is not. Reading
 * all four costs four cheap `defaults` calls and covers machines where only one
 * of them was ever written.
 */
function teamsFromPrefs(): string[] {
  const found: string[] = [];
  for (const domain of ["com.apple.dt.Xcode", "com.apple.dt.xcodebuild"]) {
    for (const key of ["IDEProvisioningTeamByIdentifier", "IDEProvisioningTeams"]) {
      const res = run("defaults", ["read", domain, key]);
      if (res.code !== 0) continue;
      for (const m of res.stdout.matchAll(new RegExp(`teamID\\s*=\\s*"?${TEAM_ID}"?`, "g"))) {
        if (!found.includes(m[1])) found.push(m[1]);
      }
    }
  }
  return found;
}

/** Where Xcode keeps provisioning profiles it has downloaded, macOS then iOS. */
const PROFILE_DIRS = [
  join(homedir(), "Library", "Developer", "Xcode", "UserData", "Provisioning Profiles"),
  join(homedir(), "Library", "MobileDevice", "Provisioning Profiles"),
];

/**
 * Team ids off the provisioning profiles on disk, newest profile first — that
 * order is what makes the most recently provisioned team win. Profiles are
 * CMS-signed but the payload plist sits in the blob as plain XML, so a scan beats
 * shelling out to `security cms -D` once per file.
 */
function teamsFromProvisioningProfiles(): string[] {
  const profiles: { path: string; mtime: number }[] = [];
  for (const dir of PROFILE_DIRS) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".provisionprofile") && !entry.name.endsWith(".mobileprovision")) continue;
      const full = join(dir, entry.name);
      try {
        profiles.push({ path: full, mtime: statSync(full).mtimeMs });
      } catch {}
    }
  }
  profiles.sort((a, b) => b.mtime - a.mtime);
  const found: string[] = [];
  for (const profile of profiles) {
    let xml;
    try {
      // latin1: the CMS wrapper is binary, and decoding it as utf-8 would mangle
      // bytes around the plist. The plist itself is ASCII either way.
      xml = readFileSync(profile.path, "latin1");
    } catch {
      continue;
    }
    // TeamIdentifier is the modern key; profiles cut before Xcode 6 carry only
    // ApplicationIdentifierPrefix, whose single element is the same team id.
    const id = xml.match(
      new RegExp(
        "<key>(?:TeamIdentifier|ApplicationIdentifierPrefix|com\\.apple\\.developer\\.team-identifier)</key>" +
          `\\s*(?:<array>\\s*)?<string>${TEAM_ID}</string>`,
      ),
    )?.[1];
    if (id && !found.includes(id)) found.push(id);
  }
  return found;
}

/**
 * Cert prefixes that carry a team id in the subject OU, best first. The
 * development ones come first because that is what the build asks for, but a
 * paid account that only ever signed notarized releases has nothing but a
 * `Developer ID` cert, and reading the team off that is still better than
 * telling the user they have no Apple account.
 */
const SIGNING_CERT_PREFIXES = [
  "Apple Development",
  "Mac Developer",
  "Apple Distribution",
  "iPhone Developer",
  "Developer ID Application",
  "3rd Party Mac Developer Application",
];

/**
 * Team ids read off the signing certificates themselves, best cert class first.
 * The certificate is the most authoritative source: it is what codesign consumes,
 * and Apple puts the team id in the subject's OU. `-v` keeps expired and
 * private-key-less certificates out, so every id here is one this Mac can sign with.
 */
function teamsFromKeychain(): string[] {
  const list = run("security", ["find-identity", "-v", "-p", "codesigning"]);
  if (list.code !== 0) return [];
  // Lines look like:  1) <sha1> "Apple Development: me@example.com (XXXXXXXXXX)"
  const names = [...list.stdout.matchAll(/"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((n) => SIGNING_CERT_PREFIXES.some((p) => n.startsWith(p)))
    .sort(
      (a, b) =>
        SIGNING_CERT_PREFIXES.findIndex((p) => a.startsWith(p)) -
        SIGNING_CERT_PREFIXES.findIndex((p) => b.startsWith(p)),
    );
  const found: string[] = [];
  for (const name of names) {
    const pem = run("security", ["find-certificate", "-c", name, "-p"]);
    if (pem.code !== 0 || !pem.stdout.includes("BEGIN CERTIFICATE")) continue;
    const subject = run("openssl", ["x509", "-noout", "-subject"], { input: pem.stdout });
    if (subject.code !== 0) continue;
    const ou = subject.stdout.match(new RegExp(`OU\\s*=\\s*${TEAM_ID}`));
    if (ou && !found.includes(ou[1])) found.push(ou[1]);
  }
  return found;
}

/**
 * Sanitize a raw extension name into an app name. The result becomes a directory
 * name, an xcodebuild scheme, and part of the bundle id, and is passed verbatim to
 * `xcrun ... --app-name`, which writes it into generated .xcodeproj XML. So we
 * whitelist rather than blacklist: keep letters (any script), digits, and the two
 * safe joiners `-` `_`; drop everything else. This closes XML/scheme/make-variable
 * injection via `< > & " $ \` ( ) |` that a blacklist would leave through.
 */
export function deriveAppName(rawName: string): string {
  return rawName.replace(/[^\p{L}\p{N}_-]+/gu, "") || "Extension";
}

export function defaultBundleId(appName: string): string {
  // Strip non-alphanumerics, then drop any leading digits: a CFBundleIdentifier
  // segment that starts with a digit (e.g. "123App") is rejected by parts of
  // Apple's toolchain.
  const slug = appName.replace(/[^A-Za-z0-9]/g, "").replace(/^[0-9]+/, "");
  // Two DISTINCT names can reduce to the same non-empty slug — "Foo" and "1Foo"
  // both slug to "Foo"; "Café" and "Cafe" both to "Caf" — so using the slug alone
  // would hand them the same bundle id and LaunchServices would let the second
  // install shadow the first. Only trust the slug when it is a lossless rendering
  // of the name (already reverse-DNS-safe: letters/digits, starting with a letter);
  // anything the slug dropped or reordered falls back to a per-name SHA-1 suffix so
  // distinct names stay distinct.
  const lossless = /^[A-Za-z][A-Za-z0-9]*$/.test(appName);
  const suffix = slug && lossless ? slug : (slug || "ext") + createHash("sha1").update(appName).digest("hex").slice(0, 8);
  return `com.viaduct.${suffix}`;
}
