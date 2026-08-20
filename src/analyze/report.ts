import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Issue, Manifest, Severity } from "../types.js";
import { color } from "../util.js";

/**
 * Human-readable list of what transformManifest() changed, original → transformed.
 * Lets `--analyze` preview the real manifest rewrites (not just compatibility
 * issues) without writing anything. Covers the fields the converter actually
 * touches; intentionally not a full deep diff.
 */
export function summarizeManifestChanges(before: Manifest, after: Manifest): string[] {
  const out: string[] = [];

  for (const key of ["update_url", "key", "minimum_chrome_version"] as const) {
    if (before[key] !== undefined && after[key] === undefined) out.push(`Dropped \`${key}\` (Chrome-only).`);
  }

  if (before.version !== after.version) out.push(`Version \`${before.version}\` → \`${after.version}\` (Apple format).`);

  // A malformed manifest can set permissions to a non-array (a bare string,
  // an object); guard with Array.isArray so .filter()/.includes() never throw
  // and abort the --analyze run, matching the array guards used elsewhere.
  const permList = (m: Manifest, key: "permissions" | "optional_permissions"): string[] =>
    Array.isArray(m[key]) ? (m[key] as string[]) : [];
  const removedPerms = permList(before, "permissions").filter((p) => !permList(after, "permissions").includes(p));
  if (removedPerms.length) out.push(`Removed permission(s): ${removedPerms.map((p) => `\`${p}\``).join(", ")}.`);

  const removedOptPerms = permList(before, "optional_permissions").filter((p) => !permList(after, "optional_permissions").includes(p));
  if (removedOptPerms.length) out.push(`Removed optional permission(s): ${removedOptPerms.map((p) => `\`${p}\``).join(", ")}.`);

  for (const key of ["host_permissions", "optional_host_permissions"] as const) {
    const beforeHosts = Array.isArray(before[key]) ? (before[key] as unknown[]).filter((p): p is string => typeof p === "string") : [];
    const afterHosts = new Set(Array.isArray(after[key]) ? (after[key] as string[]) : []);
    const removed = beforeHosts.filter((p) => !afterHosts.has(p));
    if (removed.length) out.push(`Removed invalid \`${key}\` pattern(s): ${removed.map((p) => `\`${p}\``).join(", ")}.`);
  }

  if (before.background?.persistent !== false && after.background?.persistent === false)
    out.push("Background made non-persistent (MV2 → Safari).");
  if (before.background?.type === "module" && after.background?.type === undefined)
    out.push("Stripped `background.type:\"module\"` (Safari service-worker compat).");

  // page_action folds into the toolbar-button key valid for the manifest version:
  // `action` on MV3, `browser_action` on MV2 (Safari rejects MV2 `action`). Report
  // whichever one the transform actually produced.
  if (before.page_action && !after.page_action) {
    const foldedInto = after.action ? "action" : after.browser_action ? "browser_action" : null;
    if (foldedInto) out.push(`Folded \`page_action\` into \`${foldedInto}\` (Safari has no page_action).`);
  }

  if (typeof before.content_security_policy === "string" && typeof after.content_security_policy === "object")
    out.push("Wrapped string CSP into MV3 `{ extension_pages }` object.");

  if (Array.isArray(before.web_accessible_resources) && Array.isArray(after.web_accessible_resources)) {
    const beforeHadStrings = (before.web_accessible_resources as unknown[]).some((e) => typeof e === "string");
    // The transform only wraps on MV3; an untouched MV2 string list is not a change.
    const afterHasStrings = (after.web_accessible_resources as unknown[]).some((e) => typeof e === "string");
    if (beforeHadStrings && !afterHasStrings) out.push("Wrapped MV2 `web_accessible_resources` strings into MV3 objects.");
  }

  if (!hasSafariSettings(before) && hasSafariSettings(after))
    out.push("Added `browser_specific_settings.safari.strict_min_version`.");

  const beforePopup = actionPopup(before);
  const afterPopup = actionPopup(after);
  if (!beforePopup && afterPopup) out.push(`Wired toolbar popup → \`${afterPopup}\`.`);

  return out;
}

function hasSafariSettings(m: Manifest): boolean {
  const bss = m.browser_specific_settings as { safari?: unknown } | undefined;
  return !!bss?.safari;
}

function actionPopup(m: Manifest): string | undefined {
  return (m.action ?? m.browser_action ?? m.page_action)?.default_popup;
}

const ORDER: Severity[] = ["error", "warning", "info"];
const LABEL: Record<Severity, string> = { error: "ERROR", warning: "WARN", info: "INFO" };
const HUE: Record<Severity, "red" | "yellow" | "blue"> = { error: "red", warning: "yellow", info: "blue" };

// When `strict` is provided, append a convertible/blocking verdict line matching the
// markdown report and the exit code, so `--analyze` terminal output agrees with both
// and --strict has a visible effect. Omit it (mid-pipeline convert calls) for no verdict.
export function printIssues(issues: Issue[], strict?: boolean): void {
  const verdict = () => {
    if (strict === undefined) return;
    const blocking = countBlocking(issues, strict);
    console.log(
      blocking === 0
        ? color("green", "\nConvertible: no blocking issues.")
        : color("red", `\n${blocking} blocking issue(s)${strict ? " (--strict: warnings count as blocking)" : ""}.`),
    );
  };
  if (issues.length === 0) {
    console.log(color("green", "No compatibility issues found."));
    verdict();
    return;
  }
  const bySeverity: Record<Severity, Issue[]> = { error: [], warning: [], info: [] };
  let autoFixed = 0;
  let shimmed = 0;
  for (const i of issues) {
    bySeverity[i.severity].push(i);
    if (i.shimmed) shimmed++;
    else if (i.autoFixed) autoFixed++;
  }
  for (const sev of ORDER) {
    const group = bySeverity[sev];
    if (group.length === 0) continue;
    console.log(`\n${color(HUE[sev], `${LABEL[sev]} (${group.length})`)}`);
    for (const i of group) {
      const loc = i.file ? color("dim", ` ${i.file}${i.line ? `:${i.line}` : ""}`) : "";
      // A shimmed issue is the strongest reassurance ("still works at runtime"),
      // so prefer that badge over the generic [auto-fixed] when both apply.
      const badge = i.shimmed
        ? color("green", " [shimmed]")
        : i.autoFixed
        ? color("green", " [auto-fixed]")
        : "";
      console.log(`  • [${i.category}]${loc}${badge}`);
      console.log(`    ${i.message}`);
      if (i.fix && !i.autoFixed) console.log(color("dim", `    fix: ${i.fix}`));
      else if (i.fix && i.autoFixed) console.log(color("dim", `    ${i.fix}`));
    }
  }
  const parts = ORDER.map((sev) => {
    const n = bySeverity[sev].length;
    if (!n) return null;
    const word = sev === "info" ? "info" : n > 1 ? `${sev}s` : sev;
    return color(HUE[sev], `${n} ${word}`);
  }).filter(Boolean);
  const tally = [
    autoFixed ? `${autoFixed} auto-fixed` : null,
    shimmed ? `${shimmed} shimmed` : null,
  ].filter(Boolean);
  console.log(`\n${parts.join(color("dim", " · "))}${tally.length ? color("green", ` (${tally.join(", ")})`) : ""}`);
  verdict();
}

export function countBlocking(issues: Issue[], strict = false): number {
  return issues.filter(
    (i) => !i.autoFixed && (i.severity === "error" || (strict && i.severity === "warning"))
  ).length;
}

const HEADING: Record<Severity, string> = { error: "Errors", warning: "Warnings", info: "Info" };

export interface ReportMeta {
  name: string;
  version?: string;
  manifestVersion: number;
  platforms: string;
  removedPermissions?: string[];
  /** Human-readable manifest rewrites (from summarizeManifestChanges). */
  manifestChanges?: string[];
  /** --strict: count warnings as blocking, so the status matches the exit code. */
  strict?: boolean;
}

/** Build the Markdown conversion report as a string (no I/O). */
export function buildReportMarkdown(meta: ReportMeta, issues: Issue[]): string {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  let autoFixed = 0;
  let shimmed = 0;
  for (const i of issues) {
    counts[i.severity]++;
    if (i.shimmed) shimmed++;
    else if (i.autoFixed) autoFixed++;
  }

  // Blocking = unresolved errors (auto-fixed ones don't block); same gate the
  // converter and --analyze use, so the verdict here agrees with the exit code.
  const blocking = countBlocking(issues, meta.strict);
  // Mirror the terminal verdict's wording: under --strict the blocking count
  // includes promoted warnings, so calling them all "error(s)" contradicts the
  // per-severity counts a few lines below.
  const status = blocking === 0
    ? "Convertible, no blocking issues"
    : `${blocking} blocking issue(s)${meta.strict ? " (--strict: warnings count as blocking)" : ""}. Use --force to convert anyway`;

  const lines: string[] = [
    `# Conversion report: ${meta.name}`,
    "",
    `- Status: ${status}`,
    `- Version: ${meta.version ?? "(none)"}`,
    `- Manifest: MV${meta.manifestVersion}`,
    `- Platforms: ${meta.platforms}`,
    `- Issues: ${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info` +
      (autoFixed ? `, ${autoFixed} auto-fixed` : "") +
      (shimmed ? `, ${shimmed} shimmed` : ""),
    "",
  ];

  if (meta.removedPermissions && meta.removedPermissions.length > 0) {
    lines.push(`## Removed permissions (${meta.removedPermissions.length})`, "");
    for (const p of meta.removedPermissions) lines.push(`- \`${p}\``);
    lines.push("");
  }

  if (meta.manifestChanges && meta.manifestChanges.length > 0) {
    lines.push(`## Manifest changes (${meta.manifestChanges.length})`, "");
    for (const c of meta.manifestChanges) lines.push(`- ${c}`);
    lines.push("");
  }

  for (const sev of ORDER) {
    const group = issues.filter((i) => i.severity === sev);
    if (group.length === 0) continue;
    lines.push(`## ${HEADING[sev]} (${group.length})`, "");
    for (const i of group) {
      const loc = i.file ? ` \`${i.file}${i.line ? `:${i.line}` : ""}\`` : "";
      const tag = i.shimmed ? " _(shimmed, handled at runtime)_" : i.autoFixed ? " _(auto-fixed)_" : "";
      lines.push(`- **[${i.category}]**${loc}${tag}: ${i.message}`);
      if (i.fix) lines.push(`  - ${i.autoFixed ? "" : "fix: "}${i.fix}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Write a Markdown summary of the conversion next to the output, so the issue
 * report survives past the terminal scrollback (useful for CI logs / handoff).
 * Returns the path written.
 */
export function writeReportFile(dir: string, meta: ReportMeta, issues: Issue[]): string {
  const p = join(dir, "CONVERSION_REPORT.md");
  writeFileSync(p, buildReportMarkdown(meta, issues), "utf-8");
  return p;
}
