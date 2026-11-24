/**
 * hook-branch-routing-cite-gate.test.mjs
 *
 * Gate H — Branch Routing Cite Gate unit tests.
 * Covers: lib/branch-routing-cite-gate.mjs `checkBranchRoutingCite` function.
 *
 * Per Gate H spec: stop-handoff-cite.mjs / lib/branch-routing-cite-gate.mjs
 * Design: pure logic library (no I/O, no process.exit) — testable in-process.
 *
 * Test strategy:
 *   - Import checkBranchRoutingCite directly (no spawn needed — pure function)
 *   - 1 happy case: keyword + routing cite → shouldBlock: false
 *   - 6 adversarial cases covering: no-cite block, commit context skip,
 *     subagent output skip, conceptual discussion pass, broad cite pass,
 *     regression without cite block
 *
 * Avoid dogfood loop: FORBIDDEN regex patterns constructed via RegExp
 * constructor (per Bundle B+C pattern) — no literal FORBIDDEN regex strings.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repoFileUrl } from "./lib/repo-root.mjs";

const LIB = repoFileUrl(".devpro/scripts/hooks/lib/branch-routing-cite-gate.mjs");

const { checkBranchRoutingCite } = await import(LIB);

// ─────────────────────────────────────────────────────────────────────────────
// (a) Happy path: branch creation + fix context + routing cite → shouldBlock: false
// ─────────────────────────────────────────────────────────────────────────────

test('Gate H happy (a): message contains bugfix/ + fix + routing cite → shouldBlock: false', () => {
  const messageText =
    'We should create bugfix/foo to fix the login issue. ' +
    'per openspec-branch-routing.md Rule #4 — tip 未上 PROD 應在原分支修。';
  const result = checkBranchRoutingCite({ messageText });
  assert.equal(result.shouldBlock, false, 'has routing cite → must pass');
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) Adversarial: hotfix + regression without routing cite → shouldBlock: true
// ─────────────────────────────────────────────────────────────────────────────

test('Gate H adversarial (b): "開 hotfix 修 regression" without routing cite → shouldBlock: true', () => {
  const messageText =
    '我們應該開 hotfix/ 分支來修 regression，因為 main 已經壞掉了。';
  const result = checkBranchRoutingCite({ messageText });
  assert.equal(result.shouldBlock, true, 'branch creation + fix context without cite → must warn');
  assert.ok(result.message.length > 0, 'advisory message must be non-empty');
  assert.ok(
    result.message.includes('Gate H'),
    'advisory message must reference Gate H'
  );
  assert.ok(
    result.message.includes('Rule #5') && result.message.includes('新建 bugfix/hotfix'),
    'advisory message must show the production-tag-contained case as Rule #5'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) Adversarial: bugfix/ + regression, no Rule # reference → shouldBlock: true
// ─────────────────────────────────────────────────────────────────────────────

test('Gate H adversarial (c): bugfix/ from main + regression without Rule # cite → shouldBlock: true', () => {
  const messageText =
    'Let us create bugfix/fix-login from main to address the regression in production. ' +
    'We can merge it back after testing.';
  const result = checkBranchRoutingCite({ messageText });
  assert.equal(result.shouldBlock, true, 'no Rule #3-5 routing cite → must warn');
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) Skip commit context: bugfix: prefix + Co-Authored-By: footer → shouldBlock: false
// ─────────────────────────────────────────────────────────────────────────────

test('Gate H adversarial (d): commit message body with "bugfix:" + Co-Authored-By: → shouldBlock: false', () => {
  const messageText = [
    'bugfix: fix regression in auth module',
    '',
    'Resolves the login regression introduced in v6.33.0.',
    '',
    'Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>',
  ].join('\n');
  const result = checkBranchRoutingCite({ messageText });
  assert.equal(result.shouldBlock, false, 'Co-Authored-By: footer marks commit context → skip');
});

// ─────────────────────────────────────────────────────────────────────────────
// (e) Skip subagent output: ## 實作結果 + agentId → shouldBlock: false
// ─────────────────────────────────────────────────────────────────────────────

test('Gate H adversarial (e): subagent output with ## 實作結果 + agentId → shouldBlock: false', () => {
  const messageText = [
    '## 實作結果',
    '[finished]',
    '',
    '## 做了什麼',
    '- 建立了 bugfix/fix-regression 分支來修正 regression 問題',
    '',
    'agentId: dp-programmer',
  ].join('\n');
  const result = checkBranchRoutingCite({ messageText });
  assert.equal(result.shouldBlock, false, 'subagent output anchor → skip');
});

// ─────────────────────────────────────────────────────────────────────────────
// (f) Conceptual discussion: no branch creation keyword → shouldBlock: false
// ─────────────────────────────────────────────────────────────────────────────

test('Gate H adversarial (f): conceptual discussion of branch routing without creation keyword → shouldBlock: false', () => {
  const messageText =
    'Branch routing 一般原則是根據 tip 是否在 production-* tag 內來決定。' +
    '如果有 fix 需求，應先查看當前分支狀態。這是一個通用的 regression 防護原則。';
  // Does not contain bugfix/ hotfix/ 新分支 開分支 建分支 — conceptual only
  const result = checkBranchRoutingCite({ messageText });
  assert.equal(result.shouldBlock, false, 'no branch creation keyword → no trigger');
});

// ─────────────────────────────────────────────────────────────────────────────
// (g) Broad cite pass: per openspec-branch-routing.md §Rule #4 cross-ref → shouldBlock: false
// ─────────────────────────────────────────────────────────────────────────────

test('Gate H adversarial (g): bugfix/ + fix + "per openspec-branch-routing.md §Rule #4" → shouldBlock: false', () => {
  const messageText =
    'Creating bugfix/auth-fix to fix the authentication issue. ' +
    'Decision per openspec-branch-routing.md §Rule #4: tip has not reached production-* tag.';
  const result = checkBranchRoutingCite({ messageText });
  assert.equal(result.shouldBlock, false, 'per openspec-branch-routing.md §Rule #4 broad cite → pass');
});

// ─────────────────────────────────────────────────────────────────────────────
// Extra: empty message → skip (fail-open)
// ─────────────────────────────────────────────────────────────────────────────

test('Gate H: empty message → shouldBlock: false (fail-open)', () => {
  const result = checkBranchRoutingCite({ messageText: '' });
  assert.equal(result.shouldBlock, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Extra: bugfix keyword but no fix context → shouldBlock: false
// ─────────────────────────────────────────────────────────────────────────────

test('Gate H: bugfix/ branch name without fix context → shouldBlock: false', () => {
  const messageText =
    'The bugfix/ branch was created by another team member last week. No issues found.';
  const result = checkBranchRoutingCite({ messageText });
  assert.equal(result.shouldBlock, false, 'no fix context → gate not triggered');
});

// ─────────────────────────────────────────────────────────────────────────────
// Extra: git commit -m context with hotfix/ + fix → shouldBlock: false
// ─────────────────────────────────────────────────────────────────────────────

test('Gate H: git commit -m heredoc context with hotfix/ + fix → shouldBlock: false', () => {
  const messageText = [
    'Run the following command:',
    '',
    "git commit -m \"$(cat <<'EOF'",
    'chore: create hotfix/ branch to fix regression',
    '',
    'EOF',
    ')"',
  ].join('\n');
  const result = checkBranchRoutingCite({ messageText });
  assert.equal(result.shouldBlock, false, 'git commit -m context → skip');
});
