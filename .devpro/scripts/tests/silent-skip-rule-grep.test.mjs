import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { repoPath } from './lib/repo-root.mjs';
const prePrPath = repoPath('.devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md');

const SECTION_HEADING = '### 第二點五步段：Scenario Walkthrough';

const REQUIRED = [
  'AskUserQuestion',
  '禁止 silent skip',
  '即使 auto mode',
];

const FORBIDDEN = [
  '可酌情',
  '可省略',
  'low-risk 跳過',
];

const MATCHING_COVERED_AUTHORITY_RE =
  /^.*exact matching-and-covered.*scenario_walkthrough.*AI.*needed\/not-needed.*$/mi;
const COVERED_NEEDED_RE =
  /^.*matching-and-covered.*needed.*directly (?:execute|run).*without another user prompt.*$/mi;
const COVERED_NOT_NEEDED_RE =
  /^.*matching-and-covered.*not-needed.*skipped by AI decision: <reason>.*non-empty.*(?:diff-risk-specific|change-specific risk).*$/mi;
const USER_FALLBACK_RE =
  /^.*missing.*malformed.*ambiguous.*mismatch.*coverage absent.*custom excluded.*structured.*user prompt.*numbered plain-text.*wait.*$/mi;

const content = readFileSync(prePrPath, 'utf8');
const lines = content.split('\n');
const startLine = lines.findIndex(l => l.startsWith(SECTION_HEADING));
const endLine = lines.findIndex((l, i) => i > startLine && /^### /.test(l));
const section = startLine === -1
  ? null
  : lines.slice(startLine, endLine === -1 ? undefined : endLine).join('\n');

test('pre-pr.md 第二點五步段 存在', () => {
  assert.ok(section, '找不到「### 第二點五步段：Scenario Walkthrough」heading — silent-skip rule scaffold 已被移除');
});

for (const phrase of REQUIRED) {
  test(`第二點五步段 必含 "${phrase}"`, () => {
    assert.ok(
      section.includes(phrase),
      `silent-skip 規則完整性受損: 「${phrase}」 missing — walkthrough opt-out 可能被同義詞回退`
    );
  });
}

for (const phrase of FORBIDDEN) {
  test(`第二點五步段 禁含 "${phrase}"`, () => {
    assert.ok(
      !section.includes(phrase),
      `silent-skip 規則退化: 「${phrase}」 出現於段內 — 該 phrase 為 walkthrough opt-out 同義詞退化訊號（per archive 2026-04-26-strengthen-walkthrough-trigger D1 後續監控）`
    );
  });
}

test('第二點五步段 只把 exact matching-and-covered scenario_walkthrough 交給 bounded AI needed/not-needed decision', () => {
  assert.match(
    section,
    MATCHING_COVERED_AUTHORITY_RE,
    '缺少同一物理行的 narrow authority contract: exact matching-and-covered + scenario_walkthrough + AI needed/not-needed'
  );
});

test('第二點五步段 matching-and-covered needed 直接執行且不再 prompt', () => {
  assert.match(
    section,
    COVERED_NEEDED_RE,
    '缺少同一物理行的 covered-needed polarity: matching-and-covered + needed + directly execute/run + without another user prompt'
  );
});

test('第二點五步段 matching-and-covered not-needed 寫入 bounded AI skip reason', () => {
  assert.match(
    section,
    COVERED_NOT_NEEDED_RE,
    '缺少同一物理行的 covered-not-needed polarity: matching-and-covered + not-needed + exact AI skip state + non-empty diff-risk-specific reason'
  );
});

test('第二點五步段 nonmatching authority 保留 structured/plain-text user fallback', () => {
  assert.match(
    section,
    USER_FALLBACK_RE,
    '缺少同一物理行的 fail-closed fallback: missing/malformed/ambiguous/mismatch/coverage absent/custom excluded → structured user prompt → numbered plain-text + wait'
  );
});

test('第二點五步段 禁止舊的 unconditional AskUserQuestion polarity', () => {
  assert.doesNotMatch(
    section,
    /^觸發條件命中時，TL \*\*必須\*\*用 `AskUserQuestion` 工具詢問使用者：$/m,
    '舊 polarity 仍存在：只要 trigger 命中就無條件 AskUserQuestion，未先解析 matching-and-covered authority'
  );
});

test('第二點五步段 禁止舊的 blanket AI opt-out prohibition', () => {
  assert.doesNotMatch(
    section,
    /^.*AI.*禁止.*自判斷 opt-out.*$/m,
    '舊 polarity 仍存在：blanket 禁止 AI opt-out，未保留 matching-and-covered 的 bounded needed/not-needed decision'
  );
});

// A walkthrough that only checks "did it stop" and the final output can pass while the stop message
// itself omits what the rule requires (PR #3243: a deleted-list stop that never listed the deleted lines).
const STOP_MESSAGE_REPORT_RE =
  /^.*委派時 MUST 要求回報每個停點實際對使用者說的內容.*TL 判定前 MUST 逐一對照規則原文.*寫在其他步驟而指向這個停點的也算.*缺任一項即 FAIL.*$/m;
const STOP_MESSAGE_PASS_GUARD_RE =
  /^.*只比對「停不停」與最終產出.*不得記 `executed PASS`.*$/m;

test('第二點五步段 判定通過前要求回報停點訊息並逐一對照規則原文', () => {
  assert.match(
    section,
    STOP_MESSAGE_REPORT_RE,
    '缺少同一物理行的停點訊息驗證: 委派時要求回報停點內容 + TL 逐一對照規則原文 + 其他步驟指向這個停點的要求也算 + 缺任一項即 FAIL'
  );
});

test('第二點五步段 只比對停不停與最終產出不得記 executed PASS', () => {
  assert.match(
    section,
    STOP_MESSAGE_PASS_GUARD_RE,
    '缺少同一物理行的 polarity: 只比對停不停與最終產出 + 不得記 executed PASS'
  );
});

test('第二點五步段 停點訊息驗證只由一行承載', () => {
  const sectionLines = section.split('\n');
  assert.equal(sectionLines.filter(l => STOP_MESSAGE_REPORT_RE.test(l)).length, 1);
  assert.equal(sectionLines.filter(l => STOP_MESSAGE_PASS_GUARD_RE.test(l)).length, 1);
});
