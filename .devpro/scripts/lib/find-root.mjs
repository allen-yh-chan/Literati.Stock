/**
 * find-root.mjs
 *
 * Two walk-up root locators with different stop criteria. Do not unify them.
 */

import { existsSync } from "node:fs";
import path from "node:path";

export function findOpenspecRepoRoot(start = process.cwd()) {
  let current = path.resolve(start);
  for (;;) {
    if (
      existsSync(path.join(current, "openspec")) &&
      existsSync(path.join(current, ".devpro"))
    ) {
      return current;
    }
    const parent = path.resolve(current, "..");
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

export function findConsumerRepoRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  while (true) {
    if (
      existsSync(path.join(dir, "AGENTS.md")) ||
      existsSync(path.join(dir, ".devpro-agent-rules", "AGENTS.md")) ||
      existsSync(path.join(dir, ".git"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}
