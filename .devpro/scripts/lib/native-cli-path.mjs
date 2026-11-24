/**
 * native-cli-path.mjs
 *
 * Resolves a path typed on a command line into the native path of the platform. Git Bash hands Node
 * `/c/work/repo`, which `path.resolve` reads on Windows as `\c\work\repo` on the current drive; the Git Bash
 * drive spelling is mapped first by the repository's single mapper (`mapMsysDrivePath`). Off Windows
 * `/c/work` is a legitimate absolute path and is never reinterpreted.
 */

import path from "node:path";
import { mapMsysDrivePath } from "../hooks/lib/hook-command-context.mjs";

export function resolveCliPath(value, { platform = process.platform } = {}) {
  if (platform !== "win32") return path.posix.resolve(value);
  const resolved = path.win32.resolve(mapMsysDrivePath(value));
  return resolved.replace(/^[a-z]:/u, (drive) => drive.toUpperCase()); // one spelling of the drive for every input form
}

/** Whether the typed path names an absolute location once its Git Bash drive spelling is mapped. */
export function isAbsoluteCliPath(value, { platform = process.platform } = {}) {
  if (platform !== "win32") return path.posix.isAbsolute(value);
  return path.win32.isAbsolute(mapMsysDrivePath(value));
}
