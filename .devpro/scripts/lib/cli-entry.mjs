/**
 * cli-entry.mjs
 *
 * Symlink-safe realpath comparison for direct CLI invocation (V3).
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function isDirectCliInvocation(moduleUrlOrPath) {
  if (!process.argv[1]) return false;
  try {
    const modulePath = String(moduleUrlOrPath).startsWith("file:")
      ? fileURLToPath(moduleUrlOrPath)
      : moduleUrlOrPath;
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(modulePath);
  } catch {
    return false;
  }
}
