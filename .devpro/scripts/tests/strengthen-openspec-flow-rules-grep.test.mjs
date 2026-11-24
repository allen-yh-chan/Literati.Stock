/**
 * strengthen-openspec-flow-rules-grep.test.mjs
 *
 * Locks anchor strings introduced by the 4-issue chore:
 *   #384 Verb Whitelist Precheck
 *   #385 Rule-doc dogfooding self-check
 *   #386 proposal-template + pre-pr-archive-gate check (c)
 *   #387 物理切分例外
 *
 * Also runs the canonical FORBIDDEN regex set against this change's own
 * proposal-mini.md (dogfood self-check per preflight-checklist.md 點 9).
 *
 * Style reference: branch-legality-grep.test.mjs
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { SOURCE_ROOT, sourcePath } from './lib/source-root.mjs';
import { repoPath } from './lib/repo-root.mjs';
import { readSourceFile as read } from './lib/read.mjs';



// ---------------------------------------------------------------------------
// Group #384 — Verb Whitelist Precheck
// ---------------------------------------------------------------------------

const changeMd = read('.devpro/agent-skills/devpro-workflows/change/SKILL.md');

function extractVerbWhitelistPrecheckSection() {
  const headingMatch = changeMd.match(/^\*\*[^*\n]*Verb Whitelist Precheck[^*\n]*\*\*$/m);
  assert.ok(
    headingMatch,
    'change.md 找不到 Verb Whitelist Precheck 段標題；測試不得在 section 缺失時假綠'
  );
  const startIdx = headingMatch.index;
  const nextStepMatch = changeMd.slice(startIdx + headingMatch[0].length).match(/\n\*\*[^*\n]+步[：:]/);
  const endIdx = nextStepMatch
    ? startIdx + headingMatch[0].length + nextStepMatch.index
    : changeMd.length;
  return changeMd.slice(startIdx, endIdx);
}

test('#384: change.md 含「Verb Whitelist Precheck」字串', () => {
  assert.ok(
    changeMd.includes('Verb Whitelist Precheck'),
    'change.md 缺少「Verb Whitelist Precheck」段——此段為 pre-flight process gap 補充'
  );
});

test('#384: change.md Verb Whitelist Precheck 段含 preflight-checklist.md 點 2 marker 引用', () => {
  assert.ok(
    changeMd.includes('preflight-checklist.md'),
    'change.md 應引用 preflight-checklist.md 作為白名單 SSOT，避免 SSOT 漂移'
  );
  assert.ok(
    changeMd.includes('marker 區塊') || changeMd.includes('branch-verb-whitelist:start'),
    'change.md 應引用 marker 區塊（SSOT 定位語），確保讀者知道去哪找白名單'
  );
});

test('#384 FORBIDDEN: change.md Verb Whitelist Precheck 段不直接列出白名單動詞集合（避免 SSOT 漂移）', () => {
  const section = extractVerbWhitelistPrecheckSection();

  // 白名單動詞不應以 bullet list 形式直接出現在此段（避免 SSOT 漂移）
  // 合法引用如 verb=`strengthen` 或 `enforce`/`strengthen` 範例僅含個別動詞
  // 但不應出現 "- `add`" "- `fix`" "- `refactor`" 等完整白名單列舉
  const bulletVerbPattern = /^- `(add|fix|refactor|remove|migrate|update|sync|docs|amend|strengthen|wire|clarify|enforce|revert)`/m;
  assert.ok(
    !bulletVerbPattern.test(section),
    'change.md Verb Whitelist Precheck 段不應直接列出白名單動詞 bullet list（SSOT 漂移）——白名單 SSOT 在 preflight-checklist.md 點 2 marker 區塊'
  );
});

// ---------------------------------------------------------------------------
// Group #385 — Rule-doc dogfooding self-check
// ---------------------------------------------------------------------------

const preflightMd = read('.devpro/agent-rules/preflight-checklist.md');
const ruleDesignMd = read('.devpro/agent-rules/rule-design-principles.md');

test('#385: preflight-checklist.md 含「Rule-doc dogfooding self-check」字串', () => {
  assert.ok(
    preflightMd.includes('Rule-doc dogfooding self-check'),
    'preflight-checklist.md 缺點 9 Rule-doc dogfooding self-check'
  );
});

test('#385: rule-design-principles.md 含「## Example Sanitization」heading', () => {
  assert.ok(
    ruleDesignMd.includes('## Example Sanitization'),
    'rule-design-principles.md 缺 ## Example Sanitization 段'
  );
});

test('#385: rule-design-principles.md 含「Canonical FORBIDDEN Regex Set」字串', () => {
  assert.ok(
    ruleDesignMd.includes('Canonical FORBIDDEN Regex Set'),
    'rule-design-principles.md 缺 Canonical FORBIDDEN Regex Set 表'
  );
});

test('#385: rule-design-principles.md 含 ≥ 4 個 placeholder 例（dogfood 可用值）', () => {
  const placeholders = [
    'user@example.com',
    '/path/to/example',
    '<user-email>',
    '<account-id>',
  ];
  for (const ph of placeholders) {
    assert.ok(
      ruleDesignMd.includes(ph),
      `rule-design-principles.md 缺 placeholder 例：「${ph}」`
    );
  }
});

test('#385 FORBIDDEN: preflight 點 9 段不複製 FORBIDDEN regex 字面（SSOT 在 rule-design-principles.md）', () => {
  // 取 9. 起到下一個 ## 段為止
  const startIdx = preflightMd.indexOf("9. **Rule-doc dogfooding self-check**");
  const endIdx = preflightMd.indexOf("\n## ", startIdx);
  const section = startIdx === -1 ? '' : preflightMd.slice(startIdx, endIdx === -1 ? undefined : endIdx);

  // 點 9 應為 pure pointer：不可含 SSOT 表內的 regex 字面（避免漂移）
  const forbiddenLiterals = [
    '[a-z0-9._%+-]+@',          // email regex
    '/Users/[a-z]',             // Unix path regex
    'C:\\\\Users\\\\',          // Windows path regex (escaped)
    '\\b\\d{17,19}\\b',         // snowflake id regex
  ];
  for (const lit of forbiddenLiterals) {
    assert.ok(
      !section.includes(lit),
      `preflight 點 9 含 SSOT 表中 regex 字面「${lit}」——應改為 pointer-only 引用 §Example Sanitization`
    );
  }
});

// ---------------------------------------------------------------------------
// Group #386 — proposal-template + archive gate (c)
// ---------------------------------------------------------------------------

const proposalTemplatePath = repoPath('.devpro/agent-rules/proposal-template.md');
const agentsMd = read('AGENTS.md');
const openspecStepsMd = read('.devpro/agent-rules/openspec-step-1-to-9.md');
const knowledgeDigestMd = read('.devpro/agent-rules/knowledge-digest.md');
const archiveGateMjs = read('.devpro/scripts/pre-pr-archive-gate.mjs');

test('#386: proposal-template.md 存在', () => {
  assert.ok(
    existsSync(proposalTemplatePath),
    '.devpro/agent-rules/proposal-template.md 不存在——新 rule 檔未建立'
  );
});

test('#386: proposal-template.md 自身含「## Why」（dogfood self-check）', () => {
  const content = read('.devpro/agent-rules/proposal-template.md');
  assert.ok(
    content.includes('## Why'),
    'proposal-template.md 本身缺 ## Why——template 自身違反它定義的規則（dogfood fail）'
  );
});

test('#386: proposal-template.md 自身含「## What Changes」（dogfood self-check）', () => {
  const content = read('.devpro/agent-rules/proposal-template.md');
  assert.ok(
    content.includes('## What Changes'),
    'proposal-template.md 本身缺 ## What Changes——template 自身違反它定義的規則（dogfood fail）'
  );
});

test('#386: proposal-template remains reachable through digest Load-chain', () => {
  assert.ok(
    agentsMd.includes('knowledge-digest.md'),
    'AGENTS.md 觸發式載入索引缺 knowledge-digest.md entry'
  );
  assert.ok(
    knowledgeDigestMd.includes('proposal-template.md'),
    'knowledge-digest.md Load-chain 缺 proposal-template.md entry'
  );
});

test('#386: openspec-step-1-to-9.md 含「Pre-archive proposal headings 驗證」字串', () => {
  assert.ok(
    openspecStepsMd.includes('Pre-archive proposal headings 驗證'),
    'openspec-step-1-to-9.md 缺 Pre-archive proposal headings 驗證 blockquote'
  );
});

test('#386: pre-pr-archive-gate.mjs 含「(c) Proposal headings check (issue #386)」', () => {
  // Anchor tracks check (c)'s presence (the proposal-headings mechanical
  // backstop). Wording de-coupled from "Latest archive" per issue #959, which
  // made (c) diff-scoped (bcEvalArchives, empty-set fallback to latest); the
  // anchor now keys on the stable "(c) Proposal headings check (issue #386)"
  // comment instead of the stale latest-only phrasing.
  assert.ok(
    archiveGateMjs.includes('(c) Proposal headings check (issue #386)'),
    'pre-pr-archive-gate.mjs 缺 check (c)——proposal headings mechanical backstop 未加入'
  );
});

// ---------------------------------------------------------------------------
// Group #387 — 物理切分例外
// ---------------------------------------------------------------------------

const codeSimplificationMd = read('.devpro/agent-rules/code-simplification.md');

test('#387: code-simplification.md 含「物理切分例外」字串', () => {
  assert.ok(
    codeSimplificationMd.includes('物理切分例外'),
    'code-simplification.md 缺「物理切分例外」段'
  );
});

test('#387: code-simplification.md 含「commit body 分層描述」字串', () => {
  assert.ok(
    codeSimplificationMd.includes('commit body 分層描述'),
    'code-simplification.md 物理切分例外段缺「commit body 分層描述」要求'
  );
});

test('#387: code-simplification.md 含「Behavior fixes」字串', () => {
  assert.ok(
    codeSimplificationMd.includes('Behavior fixes'),
    'code-simplification.md 缺 commit body 分層格式範例中的「Behavior fixes」分類'
  );
});

test('#387: code-simplification.md 含「Behavior-equivalent restructure」字串', () => {
  assert.ok(
    codeSimplificationMd.includes('Behavior-equivalent restructure'),
    'code-simplification.md 缺 commit body 分層格式範例中的「Behavior-equivalent restructure」分類'
  );
});

// ---------------------------------------------------------------------------
// 全體 dogfood：對本 change 自身 proposal-mini.md 跑 canonical FORBIDDEN regex set
// (preflight-checklist.md 點 9 self-check — 0 hit 驗證)
// ---------------------------------------------------------------------------

// Resolve proposal-mini.md from active folder (pre-archive) or archive
// folder (post-archive). The dogfood self-check must work both before and
// after `openspec archive` runs, since /dp:pre-pr executes the archive gate
// after the change has already been archived.
import { readdirSync } from 'node:fs';

function resolveProposalMiniPath() {
  const activePath = path.join(
    SOURCE_ROOT,
    'openspec/changes/strengthen-openspec-flow-rules/proposal-mini.md'
  );
  if (existsSync(activePath)) return activePath;
  const archiveDir = sourcePath('openspec/changes/archive');
  if (!existsSync(archiveDir)) return activePath;
  const match = readdirSync(archiveDir).find((d) =>
    d.endsWith('-strengthen-openspec-flow-rules')
  );
  if (!match) return activePath;
  return path.join(archiveDir, match, 'proposal-mini.md');
}

const proposalMiniPath = resolveProposalMiniPath();

test('dogfood: proposal-mini.md 不含 real email（canonical FORBIDDEN regex set）', () => {
  const content = readFileSync(proposalMiniPath, 'utf8');
  const emailMatches = content.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
  assert.deepEqual(
    emailMatches,
    [],
    `proposal-mini.md 含真實 email：${emailMatches.join(', ')}——違反 preflight-checklist.md 點 9（rule-doc dogfooding）`
  );
});

test('dogfood: proposal-mini.md 不含 Unix 絕對路徑（canonical FORBIDDEN regex set）', () => {
  const content = readFileSync(proposalMiniPath, 'utf8');
  const pathMatches = content.match(/\/Users\/[a-z]|\/home\/[a-z]/g) || [];
  assert.deepEqual(
    pathMatches,
    [],
    `proposal-mini.md 含 Unix 絕對路徑：${pathMatches.join(', ')}——違反 preflight-checklist.md 點 9`
  );
});

test('dogfood: proposal-mini.md 不含 Windows 絕對路徑（canonical FORBIDDEN regex set）', () => {
  const content = readFileSync(proposalMiniPath, 'utf8');
  const pathMatches = content.match(/C:\\Users\\/g) || [];
  assert.deepEqual(
    pathMatches,
    [],
    `proposal-mini.md 含 Windows 絕對路徑——違反 preflight-checklist.md 點 9`
  );
});
