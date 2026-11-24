/**
 * protected-main-miswrite-recovery-grep.test.mjs
 *
 * MAINTENANCE NOTE:
 * This test locks the Protected-branch Agent Miswrite Recovery ladder:
 *   - SSOT in `git-branch-hygiene.md` §Protected-branch Agent Miswrite Recovery
 *     (4-step ladder: agent-owned + merged判定 → git pull --ff-only --autostash →
 *      未merged走 fix branch 不 bypass → 破壞性前須使用者同意)
 *   - Pointer in `multi-agent-handoff.md` §Recovery Checklist (consumer, does NOT copy 判定)
 *   - Pointer in `platform-adapters/codex.md` 風險 H     (consumer, does NOT copy 判定)
 *
 * If the SSOT heading or ladder steps are refactored in git-branch-hygiene.md,
 * update this test to match the new literals. The two consumer pointer files
 * must only point back to the SSOT — never re-implement the ladder.
 *
 * Locks: SSOT heading + step 1/2/3/4 substance + SSOT self-declaration +
 *        structural position (after Local Delete gap, before Commit 前) +
 *        both consumer pointers + regression guards +
 *        (E) step-2 autostash conflict stop-condition +
 *        (F) NEGATIVE guard — consumers must NOT copy SSOT distinctive step-prose
 *            (prose-duplication = SSOT-drift → FAIL). If you add/rename SSOT step
 *            prose, update SSOT_DISTINCTIVE_PROSE to keep the guard meaningful.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";
const hygienePath = path.join(
  REPO_ROOT,
  ".devpro/agent-rules/git-branch-hygiene.md"
);
const handoffPath = path.join(
  REPO_ROOT,
  ".devpro/agent-rules/multi-agent-handoff.md"
);
const codexPath = path.join(
  REPO_ROOT,
  ".devpro/agent-rules/platform-adapters/codex.md"
);

const hygieneBody = readFileSync(hygienePath, "utf8");
const handoffBody = readFileSync(handoffPath, "utf8");
const codexBody = readFileSync(codexPath, "utf8");

// ── A. git-branch-hygiene.md (SSOT) ─────────────────────────────────────────

// A1. SSOT section heading exists
test("git-branch-hygiene.md: SSOT heading 'Protected-branch Agent Miswrite Recovery' exists", () => {
  assert.ok(
    hygieneBody.includes("Protected-branch Agent Miswrite Recovery"),
    `expected git-branch-hygiene.md to contain heading "Protected-branch Agent Miswrite Recovery"`
  );
});

// A2. Step 2 core technique: git pull --ff-only --autostash
test("git-branch-hygiene.md: contains 'git pull --ff-only --autostash' (step 2 core technique)", () => {
  assert.ok(
    hygieneBody.includes("git pull --ff-only --autostash"),
    `expected git-branch-hygiene.md to contain "git pull --ff-only --autostash" (step 2 non-destructive cleanup)`
  );
});

// A3. Step 1 concept: agent-owned + merged判定
test("git-branch-hygiene.md: step 1 contains 'agent-owned' and 'merged' determination concepts", () => {
  assert.ok(
    hygieneBody.includes("agent-owned"),
    `expected git-branch-hygiene.md to contain "agent-owned" (step 1 source verification)`
  );
  assert.ok(
    hygieneBody.includes("merged"),
    `expected git-branch-hygiene.md to contain "merged" (step 1 PR merged判定)`
  );
});

// A4. Step 3 concept: 未merged → fix branch/worktree, not bypass
test("git-branch-hygiene.md: step 3 routes 未merged to fix branch/worktree without bypass", () => {
  assert.ok(
    hygieneBody.includes("fix branch") || hygieneBody.includes("fix worktree"),
    `expected git-branch-hygiene.md to contain "fix branch" or "fix worktree" (step 3 未merged routing)`
  );
  assert.ok(
    hygieneBody.includes("bypass"),
    `expected git-branch-hygiene.md to contain "bypass" in context of step 3 prohibition`
  );
});

// A5. Step 4 concept: 破壞性 cleanup / hook bypass 前須使用者同意
test("git-branch-hygiene.md: step 4 requires 使用者同意 before 破壞性 operations", () => {
  assert.ok(
    hygieneBody.includes("破壞性"),
    `expected git-branch-hygiene.md to contain "破壞性" (destructive operation gate)`
  );
  assert.ok(
    hygieneBody.includes("使用者"),
    `expected git-branch-hygiene.md to contain "使用者" (user consent requirement)`
  );
  assert.ok(
    hygieneBody.includes("同意"),
    `expected git-branch-hygiene.md to contain "同意" (explicit consent)`
  );
});

// A6. SSOT self-declaration: 本段為...唯一權威來源 + 不複寫
test("git-branch-hygiene.md: SSOT self-declares as authority and consumers must not copy 判定", () => {
  assert.ok(
    hygieneBody.includes("唯一權威來源"),
    `expected git-branch-hygiene.md to contain "唯一權威來源" (SSOT self-declaration)`
  );
  assert.ok(
    hygieneBody.includes("不複寫"),
    `expected git-branch-hygiene.md to contain "不複寫" (prohibition on consumer duplication)`
  );
});

// A7. Structural position: SSOT section appears after Local Delete gap and before Commit前
test("git-branch-hygiene.md: SSOT section is positioned after '### Local Delete 無 Git-Native 攔截點' and before '### Commit 前'", () => {
  const localDeleteMarker = "### Local Delete 無 Git-Native 攔截點";
  const ssotMarker = "### Protected-branch Agent Miswrite Recovery";
  const commitBeforeMarker = "### Commit 前";

  const localDeleteIdx = hygieneBody.indexOf(localDeleteMarker);
  const ssotIdx = hygieneBody.indexOf(ssotMarker);
  const commitBeforeIdx = hygieneBody.indexOf(commitBeforeMarker);

  assert.ok(
    localDeleteIdx !== -1,
    `local delete gap marker "${localDeleteMarker}" not found — regression`
  );
  assert.ok(ssotIdx !== -1, `SSOT marker "${ssotMarker}" not found`);
  assert.ok(
    commitBeforeIdx !== -1,
    `commit-before marker "${commitBeforeMarker}" not found`
  );

  assert.ok(
    localDeleteIdx < ssotIdx,
    `SSOT section (pos=${ssotIdx}) must appear after Local Delete gap (pos=${localDeleteIdx})`
  );
  assert.ok(
    ssotIdx < commitBeforeIdx,
    `SSOT section (pos=${ssotIdx}) must appear before Commit 前 section (pos=${commitBeforeIdx})`
  );
});

// ── B. multi-agent-handoff.md (Pointer 1) ────────────────────────────────────

// B1. Contains the SSOT section title (pointer back)
test("multi-agent-handoff.md: contains 'Protected-branch Agent Miswrite Recovery' pointer to SSOT", () => {
  assert.ok(
    handoffBody.includes("Protected-branch Agent Miswrite Recovery"),
    `expected multi-agent-handoff.md to contain "Protected-branch Agent Miswrite Recovery" (pointer to SSOT)`
  );
});

// B2. Pointer references git-branch-hygiene.md as authority
test("multi-agent-handoff.md: pointer references 'git-branch-hygiene.md'", () => {
  assert.ok(
    handoffBody.includes("git-branch-hygiene.md"),
    `expected multi-agent-handoff.md to contain "git-branch-hygiene.md" (SSOT reference)`
  );
});

// ── C. platform-adapters/codex.md (Pointer 2) ───────────────────────────────

// C1. Contains the SSOT section title (pointer back)
test("codex.md: contains 'Protected-branch Agent Miswrite Recovery' pointer to SSOT", () => {
  assert.ok(
    codexBody.includes("Protected-branch Agent Miswrite Recovery"),
    `expected codex.md to contain "Protected-branch Agent Miswrite Recovery" (pointer to SSOT)`
  );
});

// C2. Pointer references git-branch-hygiene.md as authority
test("codex.md: pointer references 'git-branch-hygiene.md'", () => {
  assert.ok(
    codexBody.includes("git-branch-hygiene.md"),
    `expected codex.md to contain "git-branch-hygiene.md" (SSOT reference)`
  );
});

// ── D. Regression guards ─────────────────────────────────────────────────────

// D1. Pre-existing Local Delete gap heading still present in git-branch-hygiene.md
test("git-branch-hygiene.md regression: '### Local Delete 無 Git-Native 攔截點（誠實 gap）' heading still present", () => {
  assert.ok(
    hygieneBody.includes(
      "### Local Delete 無 Git-Native 攔截點（誠實 gap）"
    ),
    `regression: "### Local Delete 無 Git-Native 攔截點（誠實 gap）" heading missing from git-branch-hygiene.md`
  );
});

// D2. Pre-existing 風險 H heading still present in codex.md
test("codex.md regression: '### 風險 H：worktree/cwd 錯位' heading still present", () => {
  assert.ok(
    codexBody.includes("### 風險 H：worktree/cwd 錯位"),
    `regression: "### 風險 H：worktree/cwd 錯位" heading missing from codex.md`
  );
});

// ── E. Step 2 autostash conflict stop-condition (hardening: PR #1304 Suggestion 2) ──

// E1. Step 2 has a stop-condition for residual conflict after autostash pop
test("git-branch-hygiene.md: step 2 has autostash conflict stop-condition (殘留 conflict → 轉步驟 3)", () => {
  assert.ok(
    hygieneBody.includes("stop-condition"),
    `expected git-branch-hygiene.md step 2 to contain "stop-condition" (autostash residual conflict handling)`
  );
  assert.ok(
    hygieneBody.includes("殘留 conflict"),
    `expected git-branch-hygiene.md step 2 to handle "殘留 conflict" after autostash pop`
  );
  assert.ok(
    hygieneBody.includes("非同 patch") && hygieneBody.includes("轉步驟 3"),
    `expected step 2 conflict path to treat as 非同 patch and 轉步驟 3 (route to fix worktree)`
  );
});

// ── F. Negative guard: consumers must NOT copy SSOT 判定 prose (hardening: PR #1304 Suggestion 1) ──
//
// The two consumer pointer files (multi-agent-handoff.md, codex.md) may summarize keywords
// and point back, but must NOT re-implement the ladder by copying SSOT distinctive step-prose.
// These literals are SSOT step-determination sentences that should appear ONLY in
// git-branch-hygiene.md — if they ever show up in a consumer, that's prose-duplication
// (SSOT-drift) and this guard FAILs. Picks distinctive prose, not keyword summaries.
const SSOT_DISTINCTIVE_PROSE = [
  "模糊就停下問使用者", // step 1 exact determination prose
  "視為「非同 patch」轉步驟 3", // step 2 conflict stop-condition prose
];

// F1. multi-agent-handoff.md must NOT copy SSOT distinctive prose
test("multi-agent-handoff.md negative guard: does NOT copy SSOT distinctive 判定 prose", () => {
  for (const prose of SSOT_DISTINCTIVE_PROSE) {
    assert.ok(
      !handoffBody.includes(prose),
      `SSOT-drift: multi-agent-handoff.md copied SSOT distinctive prose "${prose}" — consumer must point back, not re-implement the ladder`
    );
  }
});

// F2. codex.md must NOT copy SSOT distinctive prose
test("codex.md negative guard: does NOT copy SSOT distinctive 判定 prose", () => {
  for (const prose of SSOT_DISTINCTIVE_PROSE) {
    assert.ok(
      !codexBody.includes(prose),
      `SSOT-drift: codex.md copied SSOT distinctive prose "${prose}" — consumer must point back, not re-implement the ladder`
    );
  }
});
