/**
 * True when `folder` sits under `openspec/changes/archive/`. Decided on the path
 * segment after the last `openspec/changes` pair, so an active change whose name
 * merely starts with `archive` (e.g. `archive-tooling-cleanup`) is not refused.
 * @param {string} folder
 * @returns {boolean}
 */
export function isArchivePath(folder) {
  const segments = folder.split(/[/\\]/u);
  for (let i = segments.length - 3; i >= 0; i--) {
    if (segments[i] === 'openspec' && segments[i + 1] === 'changes') {
      return segments[i + 2] === 'archive';
    }
  }
  return false;
}
