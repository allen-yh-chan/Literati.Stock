// Keep list shared by prune-merged-local.mjs and prune-rules-lane.mjs: branch names listed in
// <common git dir>/info/deletable-keep are skipped by every prune scan. One name per line; blank
// lines and lines starting with # are ignored. The common git dir is the same from the main
// checkout and from every linked worktree (`--git-dir` would give a linked worktree its own
// private directory).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const KEEP_LIST_GIT_DIR_ARGV = Object.freeze(['rev-parse', '--path-format=absolute', '--git-common-dir']);

export function keepListPath(gitDir) {
  return join(gitDir, 'info', 'deletable-keep');
}

export function readKeepListAt(gitDir) {
  const p = keepListPath(gitDir);
  if (!existsSync(p)) return new Set();
  return new Set(
    readFileSync(p, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  );
}
