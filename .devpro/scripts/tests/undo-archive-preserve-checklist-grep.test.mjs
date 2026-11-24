/**
 * Locks Undo-Archive Preserve Checklist ownership:
 * - exact ASCII anchor `untracked != disposable` lives only in the SSOT leaf
 *   (and this lock test as a quoted expect string is allowed to match itself)
 * - devpro:pre-pr pointer MUST use the exact imperative and MUST NOT carry the anchor
 * - uniqueness scan is git-tracked files only (excludes managed-gitignored notes/)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { readPrePrSkillFullReadingOrder } from "./lib/pre-pr-skill.mjs";

const ANCHOR = "untracked != disposable";
const SSOT = ".devpro/agent-rules/openspec-archive-redo-undo.md";
const ENTRY = ".devpro/agent-rules/openspec-archive-principles.md";
const RATIONALIZATIONS = ".devpro/agent-rules/ai-autonomy-rationalizations.md";
const THIS_TEST = ".devpro/scripts/tests/undo-archive-preserve-checklist-grep.test.mjs";
const IMPERATIVE =
  "Before any git reset/revert of an archive commit, MUST execute the Undo-Archive Preserve Checklist in openspec-archive-redo-undo.md.";

function trackedTextFiles() {
  const out = execFileSync(
    "git",
    [
      "-c",
      "core.quotePath=false",
      "ls-files",
      "-z",
      "--",
      "*.md",
      "*.mjs",
      "*.js",
      "*.ts",
      "*.tsx",
      "*.yml",
      "*.yaml",
      "*.json",
      "*.txt",
    ],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return out.split("\0").filter(Boolean);
}

test("SSOT leaf owns exact ASCII untracked != disposable anchor", () => {
  const body = readFileSync(repoPath(SSOT), "utf8");
  assert.ok(
    body.includes(ANCHOR),
    `${SSOT} MUST contain exact ASCII token ${ANCHOR}`,
  );
  assert.ok(
    body.includes("Undo-Archive Preserve Checklist"),
    `${SSOT} MUST contain Undo-Archive Preserve Checklist heading`,
  );
  assert.match(
    body,
    /^\*\*Undo-Archive Preserve Checklist\*\*（SSOT/m,
    `${SSOT} MUST open the checklist with its own SSOT-marked heading line (a mention elsewhere does not count)`,
  );
  assert.match(
    body,
    /頂層只有兩個/,
    `${SSOT} MUST assert exactly two top-level authority carriers`,
  );
  assert.match(
    body,
    /intents 不是頂層第三目錄/,
    `${SSOT} MUST deny intents as a third top-level carrier`,
  );
  assert.ok(
    body.includes("admission-records/") && body.includes("override-ledger/"),
    `${SSOT} MUST name both top-level authority carriers`,
  );
  assert.ok(
    body.includes("notes/undo-archive-authority-backup/"),
    `${SSOT} MUST prescribe notes/undo-archive-authority-backup/ (avoid tmp)`,
  );
  assert.ok(
    body.includes("notes/quarantine-dead-receipts/"),
    `${SSOT} MUST mention dead-receipt quarantine path`,
  );
  assert.equal(
    (body.match(/untracked ≠ disposable/g) || []).length,
    0,
    "MUST NOT use Unicode ≠ in the anchor phrase",
  );
});

test("archive principles entry routes to the SSOT leaf without copying the checklist", () => {
  const body = readFileSync(repoPath(ENTRY), "utf8");
  assert.ok(
    body.includes("MUST 先讀 `openspec-archive-redo-undo.md`"),
    `${ENTRY} MUST keep the mandatory pointer to the SSOT leaf`,
  );
  // One physical line carries the section name that hook/gate messages and the
  // pre-tool-mechanical-gates spec resolve to, the undo trigger, the mandatory
  // pointer and the checklist name; the frontmatter mention cannot satisfy this.
  assert.match(
    body,
    /^\*\*Pre-merge Archive Re-do \/ pre-merge re-archive\*\*.*undo archive commit.*MUST 先讀 `openspec-archive-redo-undo\.md`.*Undo-Archive Preserve Checklist/m,
    `${ENTRY} MUST keep the Pre-merge Archive Re-do routing line that sends undo readers to the checklist leaf`,
  );
  assert.equal(body.includes(ANCHOR), false, `${ENTRY} MUST NOT carry the SSOT-owned anchor token`);
  assert.doesNotMatch(body, /頂層只有兩個/, `${ENTRY} MUST NOT copy the checklist body`);
});

test("devpro:pre-pr Fail/Re-do has exact imperative pointer without anchor token", () => {
  // 第三點六步段 Fail/Re-do lives in references/full-review-and-archive.md; read the full-rigor reading order.
  const body = readPrePrSkillFullReadingOrder();
  assert.ok(body.includes(IMPERATIVE), `devpro:pre-pr MUST contain exact imperative`);
  assert.equal(
    body.includes(ANCHOR),
    false,
    "devpro:pre-pr pointer MUST NOT contain untracked != disposable",
  );
});

test("rationalization cross-refs checklist without copying anchor into a second prose SSOT", () => {
  const body = readFileSync(repoPath(RATIONALIZATIONS), "utf8");
  assert.match(
    body,
    /gitignore／未 commit／archive leftover = 可當殘渣刪掉/,
  );
  assert.match(body, /Undo-Archive Preserve Checklist/);
  assert.equal(
    body.includes(ANCHOR),
    false,
    "rationalizations MUST NOT duplicate the grep anchor token",
  );
});

test("git-tracked untracked != disposable hits only SSOT leaf and this lock test", () => {
  const allowed = new Set([SSOT, THIS_TEST]);
  const hits = [];
  for (const rel of trackedTextFiles()) {
    let text;
    try {
      text = readFileSync(repoPath(rel), "utf8");
    } catch {
      continue;
    }
    if (!text.includes(ANCHOR)) continue;
    hits.push(rel);
  }
  const unexpected = hits.filter((rel) => !allowed.has(rel));
  assert.deepEqual(
    unexpected,
    [],
    `unexpected anchor hits: ${unexpected.join(", ") || "(none)"}; all=${hits.join(", ")}`,
  );
  assert.ok(hits.includes(SSOT), "SSOT leaf MUST be among hits");
  assert.ok(hits.includes(THIS_TEST), "lock test MUST be among hits");
});

test("undoing an archive commit: emptied dated archive shell dir must be deleted, and the classify-bounded hint names the leftover", () => {
  const ssot = readFileSync(repoPath(SSOT), "utf8");
  assert.match(
    ssot,
    /搬回後 MUST 刪除清空的 dated archive 殼目錄[^\n]*change_folder_invalid/,
    "SSOT checklist item 3(b) must tell operators to delete the emptied archive shell dir (else change_folder_invalid)",
  );
  const helper = readFileSync(repoPath(".devpro/scripts/review-remediation-evidence.mjs"), "utf8");
  assert.match(
    helper,
    /change_folder_invalid:[^\n]*leftover archive\/<date>-<change>\/ shell holding only untracked admission-records[^\n]*delete the emptied shell dir/,
    "classify-bounded change_folder_invalid hint must name the leftover archive shell dir cause",
  );
});
