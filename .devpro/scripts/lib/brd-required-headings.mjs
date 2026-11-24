import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { CHANGE_ID_SHAPE, verifyParentPath } from "./durable-fs.mjs";
import { PROPOSAL_CARRIERS } from "./proposal-carriers.mjs";

export const BRD_REQUIRED_HEADINGS = Object.freeze([
  "問題陳述",
  "業務目標",
  "功能需求",
  "非功能需求",
  "範圍界定",
  "限制與假設",
  "成功標準",
  "風險",
  "現況分析",
  "先前嘗試",
  "Pre-flight 驗證結果表",
  "分支資訊",
]);

const MAX_ARCHIVE_CANDIDATES = 64;
// Lite batch scope record: a one-line gitignored file a lite batch writes in its
// worktree and never archives. Together with the two untracked hook carriers it
// is the only content a `proven-lite` change folder may hold.
const LITE_SCOPE_RECORD = "lite-scope.md";
const UNTRACKED_CARRIER_DIRS = Object.freeze(["admission-records", "override-ledger"]);
const absent = (error) => error?.code === "ENOENT";

function normalizedHeadingTitle(line) {
  const match = line.match(/^#{1,6}[\t ]+(.+)$/u);
  if (match === null) return null;
  const withoutClosingHashes = match[1].trim().replace(/[\t ]+#+[\t ]*$/u, "").trim();
  const withoutOrdinal = withoutClosingHashes.replace(/^\d+\.[\t ]+/u, "");
  return withoutOrdinal.replace(/(?:（[^（）]*）|\([^()]*\))$/u, "").trim();
}

// Proposal-less shape check: `proven-lite` only when `lite-scope.md` is a regular
// file and every other entry is one of the untracked carrier directories. Returns
// null for every other shape so the caller keeps its `artifact-class-unknown`.
function classifyLiteScopeOnlyDirectory(changeDir, entries, lstat) {
  if (!entries.some((entry) => entry.name === LITE_SCOPE_RECORD)) return null;
  try {
    for (const entry of entries) {
      const stat = lstat(path.join(changeDir, entry.name));
      if (stat.isSymbolicLink()) return null;
      if (entry.name === LITE_SCOPE_RECORD) {
        if (!stat.isFile()) return null;
        continue;
      }
      // `lite-scope.md` 本身就是 classification marker；同資料夾裡的已追蹤設計文件
      // （design.md、specs/ …）或 untracked side dir 都不改變「這是 lite」這個事實，
      // 以前只認 UNTRACKED_CARRIER_DIRS 會讓這種資料夾判成 artifact-class-unknown。
      if (!stat.isFile() && !stat.isDirectory()) return null;
    }
  } catch {
    return { ok: false, applicability: "unknown", code: "proposal-scan-failed", missing: [] };
  }
  return { ok: true, applicability: "not-applicable", reason: "proven-lite", code: null, missing: [] };
}

export function classifyExistingBrdDirectory(changeDir, hooks = {}) {
  const lstat = hooks.lstat ?? lstatSync;
  let entries;
  try {
    entries = (hooks.readdir ?? ((target) => readdirSync(target, { withFileTypes: true })))(changeDir);
  } catch {
    return { ok: false, applicability: "unknown", code: "proposal-scan-failed", missing: [] };
  }
  const exact = [];
  for (const expected of PROPOSAL_CARRIERS) {
    if (entries.some((entry) => entry.name !== expected && entry.name.toLowerCase() === expected)) {
      return { ok: false, applicability: "unknown", code: "proposal-carrier-case-mismatch", missing: [] };
    }
    if (!entries.some((entry) => entry.name === expected)) continue;
    try {
      const stat = lstat(path.join(changeDir, expected));
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return { ok: false, applicability: "unknown", code: "proposal-carrier-invalid", missing: [] };
      }
    } catch {
      return { ok: false, applicability: "unknown", code: "proposal-scan-failed", missing: [] };
    }
    exact.push(expected);
  }
  const hasLiteScopeEntry = entries.some((entry) => entry.name === LITE_SCOPE_RECORD);
  if (exact.length > 0 && hasLiteScopeEntry) {
    return { ok: false, applicability: "unknown", code: "lite-scope-with-proposal", missing: [] };
  }
  if (exact.length === 2) return { ok: false, applicability: "unknown", code: "proposal-carrier-ambiguous", missing: [] };
  if (exact.length === 0) {
    const lite = classifyLiteScopeOnlyDirectory(changeDir, entries, lstat);
    if (lite !== null) return lite;
    return { ok: false, applicability: "unknown", code: "artifact-class-unknown", missing: [] };
  }
  if (exact[0] === "proposal-mini.md") {
    return { ok: true, applicability: "not-applicable", reason: "proven-b-mini", code: null, missing: [] };
  }
  return { ok: true, applicability: "required", reason: null, code: null, missing: [] };
}

export function validateRequiredBrd(changeDir, hooks = {}) {
  const classification = classifyExistingBrdDirectory(changeDir, hooks);
  if (!classification.ok || classification.applicability !== "required") return classification;
  const lstat = hooks.lstat ?? lstatSync;
  const brdPath = path.join(changeDir, "brd.md");
  let body;
  try {
    const stat = lstat(brdPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { ok: false, applicability: "required", code: "brd-invalid", missing: [] };
    }
    body = (hooks.readFile ?? readFileSync)(brdPath, "utf8");
  } catch (error) {
    return {
      ok: false,
      applicability: "required",
      code: absent(error) ? "brd-missing" : "brd-read-failed",
      missing: absent(error) ? [...BRD_REQUIRED_HEADINGS] : [],
    };
  }
  const headingTitles = new Set(body.split(/\r?\n/u).map(normalizedHeadingTitle).filter((title) => title !== null));
  const missing = BRD_REQUIRED_HEADINGS.filter((required) => !headingTitles.has(required));
  return { ok: missing.length === 0, applicability: "required", code: missing.length ? "brd-headings-missing" : null, missing };
}

export function classifyOwnedChangeBrd({ repoRoot, changeId, hooks = {} }) {
  if (typeof repoRoot !== "string" || !repoRoot || typeof changeId !== "string" || !CHANGE_ID_SHAPE.test(changeId)) {
    return { ok: false, applicability: "unknown", code: "artifact-class-unknown", missing: [] };
  }
  const lstat = hooks.lstat ?? lstatSync;
  const active = path.join(repoRoot, "openspec", "changes", changeId);
  try {
    const stat = lstat(active);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false, applicability: "unknown", code: "archive-candidate-invalid", missing: [] };
    verifyParentPath(repoRoot, active);
    return validateRequiredBrd(active, hooks);
  } catch (error) {
    if (!absent(error)) return { ok: false, applicability: "unknown", code: "archive-scan-failed", missing: [] };
  }
  const archiveRoot = path.join(repoRoot, "openspec", "changes", "archive");
  let entries;
  try {
    const stat = lstat(archiveRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return { ok: false, applicability: "unknown", code: "archive-scan-failed", missing: [] };
    }
    verifyParentPath(repoRoot, archiveRoot);
    entries = (hooks.readdir ?? ((target) => readdirSync(target, { withFileTypes: true })))(archiveRoot);
  } catch (error) {
    if (absent(error)) return { ok: true, applicability: "not-applicable", reason: "proven-chore-a", code: null, missing: [] };
    return { ok: false, applicability: "unknown", code: "archive-scan-failed", missing: [] };
  }
  const pattern = new RegExp(`^[0-9]{4}-[0-9]{2}-[0-9]{2}-${changeId}$`, "u");
  if (entries.some((entry) => entry.name.toLowerCase().endsWith(`-${changeId}`) && !pattern.test(entry.name))) {
    return { ok: false, applicability: "unknown", code: "archive-entry-case-mismatch", missing: [] };
  }
  const matches = entries.filter((entry) => pattern.test(entry.name));
  if (matches.length > MAX_ARCHIVE_CANDIDATES) return { ok: false, applicability: "unknown", code: "archive-candidate-limit-exceeded", missing: [] };
  if (matches.length === 0) return { ok: true, applicability: "not-applicable", reason: "proven-chore-a", code: null, missing: [] };
  if (matches.length !== 1) return { ok: false, applicability: "unknown", code: "archive-candidate-invalid", missing: [] };
  const archived = path.join(archiveRoot, matches[0].name);
  try {
    const stat = lstat(archived);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false, applicability: "unknown", code: "archive-candidate-invalid", missing: [] };
    verifyParentPath(repoRoot, archived);
  } catch {
    return { ok: false, applicability: "unknown", code: "archive-candidate-invalid", missing: [] };
  }
  return validateRequiredBrd(archived, hooks);
}
