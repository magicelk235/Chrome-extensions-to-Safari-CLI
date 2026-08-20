import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Write Safari 18+ "Add Temporary Extension…" instructions NEXT TO the staged
 * dir (in its parent output dir), not inside it — the staged dir is the exact
 * folder Safari loads (and `--zip` archives), so a stray doc file would pollute
 * the distributable extension package.
 */
export function writeTempLoadInstructions(stagedDir: string): string {
  const body = `# Load this extension in Safari 18+ without Xcode

Staged extension: ${stagedDir}

1. Safari → Settings → Advanced → check "Show features for web developers".
2. Safari → Settings → Developer → check "Allow Unsigned Extensions"
   (enter your macOS password; this resets every time Safari restarts).
3. Develop menu → "Add Temporary Extension…".
4. Select this folder:
   ${stagedDir}
5. Enable the extension in Safari → Settings → Extensions.

Notes:
- Temporary extensions must be re-added after each Safari restart.
- Nothing is code-signed and Xcode never runs, so a re-stage is quick.
`;
  const p = join(dirname(stagedDir), "SAFARI_LOAD_INSTRUCTIONS.md");
  writeFileSync(p, body, "utf-8");
  return p;
}
