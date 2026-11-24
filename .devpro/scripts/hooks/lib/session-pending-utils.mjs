/**
 * session-pending-utils.mjs — 共用 helper
 *
 * 共用 helper：session-pending.md 路徑解析、list-item 計數、claimed 條目反查。
 *   - countPendingItems(notesDir?)：讀 session-pending.md，數 /^[-*] .+/ 行數
 *   - findClaimedChangesForBranch(branch, notesDir?)：反查 merged branch 對應的 claimed 條目
 *   - resolveNotesDir()：module-private path 解析（DEVPRO_NOTES_DIR 優先，否則 git rev-parse + /notes），
 *     countPendingItems 與 findClaimedChangesForBranch 皆呼叫此 helper
 *
 * 消費者：
 *   - session-start.mjs buildSessionPendingSection()：count > 0 → 注入 session 提醒段落
 *   - post-merge-check.mjs 段2：merge kind + count > 0 → 注入 session-pending 軟提醒；
 *     merge kind + claimed 條目命中 merged branch → 注入完成側刪除前饋
 * Fail-open：任何讀取錯誤 → countPendingItems 回 0、findClaimedChangesForBranch 回 []，不 throw。
 */

import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

/**
 * Resolve the notes directory.
 * Priority: DEVPRO_NOTES_DIR env var → git rev-parse --show-toplevel + /notes
 * Returns null if resolution fails.
 *
 * Module-private: only countPendingItems() and findClaimedChangesForBranch()
 * consume this. Not exported — no external call site exists, so exporting
 * would advertise an API the module doesn't actually offer.
 */
function resolveNotesDir() {
  if (process.env.DEVPRO_NOTES_DIR) return process.env.DEVPRO_NOTES_DIR;
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return path.join(root, "notes");
  } catch {
    return null;
  }
}

/**
 * Count list items in notes/session-pending.md.
 * A list item is a line matching /^[-*] .+/.
 * Fail-open: returns 0 on any error (file missing, read failure, etc.).
 *
 * @param {string|null} [notesDir] - Override notes directory (uses resolveNotesDir() if omitted).
 * @returns {number} Count of pending list items, or 0 on any error.
 */
export function countPendingItems(notesDir) {
  try {
    const dir = notesDir ?? resolveNotesDir();
    if (!dir) return 0;
    const pendingPath = path.join(dir, "session-pending.md");
    if (!existsSync(pendingPath)) return 0;
    const content = readFileSync(pendingPath, "utf8");
    return content.split("\n").filter((line) => /^[-*] .+/.test(line)).length;
  } catch {
    return 0;
  }
}

// Prefixes a claimed change-name may be branch-qualified with. Mirrors the
// prefix set used across session-pending-lifecycle.md's stale/claim lookup
// (feature/bugfix/hotfix/chore) — kept in sync with that leaf, not re-derived
// from any other SSOT.
const CLAIM_BRANCH_PREFIXES = ["feature", "bugfix", "hotfix", "chore"];

/**
 * Find `claimed: <change-name>` entries in notes/session-pending.md whose
 * change name resolves (prefix-aware) to the given merged branch.
 *
 * `claimed:` lines store a bare change-name with no prefix (per
 * session-pending-lifecycle.md). A branch is considered a match when either:
 *   - `<prefix>/<change-name>` === branch for some prefix in
 *     {feature, bugfix, hotfix, chore}, or
 *   - branch === change-name (already bare / no prefix to strip)
 *
 * Fail-open: any error (missing file, read failure, malformed content) yields
 * an empty array — never throws. This lookup is a soft completion-side nudge,
 * not a gate; a failure here must not block or crash the calling hook.
 *
 * @param {string} branch - The merged branch name (e.g. "chore/my-change").
 * @param {string|null} [notesDir] - Override notes directory (uses resolveNotesDir() if omitted).
 * @returns {string[]} De-duplicated array of matching claimed change names, or [] on any error.
 */
export function findClaimedChangesForBranch(branch, notesDir) {
  try {
    if (!branch) return [];
    const dir = notesDir ?? resolveNotesDir();
    if (!dir) return [];
    const pendingPath = path.join(dir, "session-pending.md");
    if (!existsSync(pendingPath)) return [];
    const content = readFileSync(pendingPath, "utf8");
    const matches = new Set();
    for (const line of content.split("\n")) {
      const claimMatch = line.match(/claimed:\s*(\S+)/);
      if (!claimMatch) continue;
      const changeName = claimMatch[1].trim();
      if (!changeName) continue;
      const candidates = [
        changeName,
        ...CLAIM_BRANCH_PREFIXES.map((prefix) => `${prefix}/${changeName}`),
      ];
      if (candidates.includes(branch)) matches.add(changeName);
    }
    return [...matches];
  } catch {
    return [];
  }
}
