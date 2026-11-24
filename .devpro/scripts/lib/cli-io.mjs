/**
 * cli-io.mjs
 *
 * Scripts CLI contract: read `--body-file <path>` or stdin fd 0, then trim.
 * Intentionally separate from hook stdin readers.
 */

import { readFileSync } from "node:fs";

export function readBodyFromFileArgOrStdin({ argv = process.argv } = {}) {
  const args = argv.slice(2);
  const bodyFileIdx = args.indexOf("--body-file");

  if (bodyFileIdx !== -1) {
    const filePath = args[bodyFileIdx + 1];
    if (!filePath) {
      process.stderr.write("ERROR: --body-file requires a path argument\n");
      process.exit(2);
    }
    try {
      const content = readFileSync(filePath, "utf8");
      return content.trim() || null;
    } catch {
      return null;
    }
  }

  try {
    const content = readFileSync(0, "utf8");
    return content.trim() || null;
  } catch {
    return null;
  }
}
