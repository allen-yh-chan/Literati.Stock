/**
 * review-findings-persistence-grep.test.mjs
 *
 * Locks Six-Axis Review Report Persistence in code-review-checklist.md:
 *   (a) heading + persist path structural anchors
 *   (b) three same-physical-line polarity clauses
 *   (c) file-write-destinations destination cell
 *   (d) devpro:pre-pr SKILL + dispatch persist-first for blocked / partial / finished
 *
 * Style reference: enforce-review-finding-disposition-grep.test.mjs
 * Strength SSOT: rule-anchor-guard-strength.md — isolation fail-closed if
 * slice count !== 1; polarity MUST same-line compound regex (no decoupled
 * includes); MUST guarded with (?!\s+NOT).
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { repoPath } from './lib/repo-root.mjs';
import { readPrePrSkillFullReadingOrder } from './lib/pre-pr-skill.mjs';

const checklist = readFileSync(
  repoPath('.devpro/agent-rules/code-review-checklist.md'),
  'utf8'
);
const destinations = readFileSync(
  repoPath('.devpro/agent-rules/file-write-destinations.md'),
  'utf8'
);
const skill = readFileSync(
  repoPath('.devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md'),
  'utf8'
);
// Full-rigor steps 3.0/3/3.6/3.7 live in references/full-review-and-archive.md; SKILL.md keeps
// the spec-named 第三步 paragraphs. skillFullReadingOrder rebuilds the full-rigor reading order.
const skillFullReadingOrder = readPrePrSkillFullReadingOrder();
const dispatch = readFileSync(
  repoPath(
    '.devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md'
  ),
  'utf8'
);
const fallback = readFileSync(
  repoPath('.devpro/agent-rules/code-review-checklist-fallback.md'),
  'utf8'
);
const reviewer = readFileSync(
  repoPath('.claude/agents/dp-reviewer.md'),
  'utf8'
);
const suiteCadence = readFileSync(
  repoPath('.devpro/agent-rules/test-suite-cadence.md'),
  'utf8'
);

const scenarioM = readFileSync(
  repoPath('scenarios/scenario-m-consumer-repo-pre-pr-flow.md'),
  'utf8'
);

const QA_ACTIVE_PATH = repoPath(
  'openspec/changes/strengthen-review-remediation/qa-test-scope.md'
);
const QA_ARCHIVE_ROOT = repoPath('openspec/changes/archive');

function discoverArchivedQaScopeCandidates() {
  if (!existsSync(QA_ARCHIVE_ROOT)) return [];
  return readdirSync(QA_ARCHIVE_ROOT, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        /^\d{4}-\d{2}-\d{2}-strengthen-review-remediation$/.test(entry.name),
    )
    .map((entry) =>
      repoPath(`openspec/changes/archive/${entry.name}/qa-test-scope.md`),
    )
    .filter((candidate) => existsSync(candidate));
}

function resolveQaTestScopePath({
  activePath = QA_ACTIVE_PATH,
  activeExists = existsSync(activePath),
  archiveCandidates = discoverArchivedQaScopeCandidates(),
} = {}) {
  if (activeExists) return activePath;
  assert.equal(
    archiveCandidates.length,
    1,
    `QA scope resolver fail closed: active missing and archive candidate count=${archiveCandidates.length}`,
  );
  return archiveCandidates[0];
}

const PERSIST_HEADING = '### Six-Axis Review Report Persistence';
const NOTES_PATH = 'notes/review-<change>-r<N>.md';
const MAIN_CHECKOUT_ROOT = '<main-checkout-root>';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Bounded heading slice: terminator = next `### ` (or caller regex) or EOF.
 * Fail closed if heading match count !== 1; message reports count + positions.
 */
function isolateHeadingSlice(content, heading, terminatorRe, label) {
  const headingRe = new RegExp(`^${escapeRegExp(heading)}\\s*$`, 'gm');
  const matches = [...content.matchAll(headingRe)];
  assert.equal(
    matches.length,
    1,
    `${label} isolation fail closed: slice count=${matches.length} (expected 1); heading="${heading}"; positions=${matches.map((m) => m.index).join(',') || 'none'}`
  );
  const start = matches[0].index;
  const matched = matches[0][0];
  const after = content.slice(start + matched.length);
  const term = after.search(terminatorRe);
  return term === -1
    ? content.slice(start)
    : content.slice(start, start + matched.length + term);
}

function uniqueHeadingStart(content, heading, label) {
  const matches = [...content.matchAll(new RegExp(`^${escapeRegExp(heading)}\\s*$`, 'gm'))];
  assert.equal(
    matches.length,
    1,
    `${label} heading position fail closed: count=${matches.length}`
  );
  return matches[0].index;
}

function assertOperativeLine(slice, pattern, label) {
  const matches = slice.split('\n').filter((line) => pattern.test(line));
  assert.equal(
    matches.length,
    1,
    `${label} operative action line fail closed: count=${matches.length}`
  );
  return matches[0];
}

function persistSlice() {
  return isolateHeadingSlice(
    checklist,
    PERSIST_HEADING,
    /\n### /,
    'Persistence'
  );
}

function boundedCadenceSlice() {
  return isolateHeadingSlice(
    checklist,
    '### Bounded Six-Axis Rereview Cadence',
    /\n### /,
    'Bounded Six-Axis Rereview Cadence'
  );
}

function dispatchStep3Slice() {
  return isolateHeadingSlice(
    dispatch,
    '## Step 3: dp-reviewer dispatch (Six-Axis Review)',
    /\n## /,
    'dispatch Step 3'
  );
}

function dispatchStep3AgentPromptFence() {
  const matches = dispatchStep3Slice().match(/```[^\n]*\nAgent\(\{[\s\S]*?\n\}\)\n```/g) ?? [];
  assert.equal(
    matches.length,
    1,
    `dispatch Step 3 literal Agent prompt isolation fail closed: fence count=${matches.length}`
  );
  return matches[0].replaceAll('\\n', '\n');
}

function postResponseRawLedgerActionLine(content, label) {
  const lines = content.split('\n').filter((line) =>
    /(?:On reviewer response|收到 reviewer 回報)/i.test(line)
    && /notes\/review-<change>-r<N>\.md/.test(line)
  );
  assert.equal(
    lines.length,
    1,
    `${label} post-response raw-ledger action isolation fail closed: line count=${lines.length}`
  );
  return lines[0];
}

function skillStep3Slice() {
  return isolateHeadingSlice(
    skill,
    '### 第三步：Six-Axis Review',
    /\n### /,
    'devpro:pre-pr SKILL Step 3'
  );
}

function skillFullStep3Slice() {
  return isolateHeadingSlice(
    skillFullReadingOrder,
    '### 第三步：Six-Axis Review',
    /\n### /,
    'devpro:pre-pr full reading order Step 3'
  );
}

function skillStep36Slice() {
  return isolateHeadingSlice(
    skillFullReadingOrder,
    '### 第三點六步段：Spec Freeze Archive + Archive Gate Check（必過）',
    /\n### /,
    'devpro:pre-pr SKILL Step 3.6'
  );
}

function skillStep37Slice() {
  return isolateHeadingSlice(
    skillFullReadingOrder,
    '### 第三點七步段：OpenSpec Validate Gate（必過）',
    /\n### /,
    'devpro:pre-pr SKILL Step 3.7'
  );
}

function skillPostLedgerSlice() {
  return isolateHeadingSlice(
    skill,
    '### Post-Ledger Final Evidence Gate',
    /\n### /,
    'devpro:pre-pr SKILL Post-Ledger Final Evidence Gate'
  );
}

function reviewerOutputFormatSlice() {
  return isolateHeadingSlice(
    reviewer,
    '## 輸出格式',
    /\n## /,
    'dp-reviewer output format'
  );
}

function reviewerProtocolInputSlice() {
  return isolateHeadingSlice(
    reviewer,
    '### Input（主 agent 傳入）',
    /\n### /,
    'dp-reviewer protocol input'
  );
}

function reviewerProtocolOutputSlice() {
  return isolateHeadingSlice(
    reviewer,
    '### Output（主 agent 期待接收）',
    /\n### /,
    'dp-reviewer protocol output'
  );
}

function reviewerForbiddenSlice() {
  return isolateHeadingSlice(
    reviewer,
    '## 禁止事項',
    /\n## /,
    'dp-reviewer prohibitions'
  );
}

function reviewerRetrySlice() {
  return isolateHeadingSlice(
    reviewer,
    '### 降級情境',
    /\n## /,
    'dp-reviewer retry'
  );
}

function fallbackWhenToUseSlice() {
  return isolateHeadingSlice(
    fallback,
    '## When to Use',
    /\n## /,
    'fallback When to Use'
  );
}

function fallbackRoutingSlice() {
  return isolateHeadingSlice(
    fallback,
    '## Bounded Review Remediation Routing',
    /\n## /,
    'fallback bounded remediation routing'
  );
}

test('checklist 含 Persistence 段標題且 isolation 唯一', () => {
  const slice = persistSlice();
  assert.ok(
    slice.includes(PERSIST_HEADING),
    'code-review-checklist.md 缺少 ### Six-Axis Review Report Persistence'
  );
});

test('Persistence 節含 notes/review-<change>-r<N>.md 與 <main-checkout-root> persist path', () => {
  const slice = persistSlice();
  assert.ok(
    slice.includes(NOTES_PATH),
    `Persistence 節缺少 literal ${NOTES_PATH}`
  );
  assert.ok(
    slice.includes(MAIN_CHECKOUT_ROOT),
    'Persistence 節 persist path 缺少 <main-checkout-root>'
  );
  assert.ok(
    slice.includes(`${MAIN_CHECKOUT_ROOT}/${NOTES_PATH}`),
    'persist path 必須是 <main-checkout-root>/notes/review-<change>-r<N>.md'
  );
});

test('MUST 第一個動作落盤 同一物理行 polarity', () => {
  const slice = persistSlice();
  assert.ok(
    /MUST(?!\s+NOT)[^\n]*第一個動作落盤/.test(slice),
    'Persistence 節必須同一物理行綁定 MUST 與「第一個動作落盤」（MUST 以 (?!\\s+NOT) 防護）'
  );
});

test('MUST NOT 假裝 bounded rereview 同一物理行 polarity', () => {
  const slice = persistSlice();
  assert.ok(
    /MUST NOT[^\n]*假裝 bounded rereview/.test(slice),
    'Persistence 節必須同一物理行綁定 MUST NOT 與「假裝 bounded rereview」'
  );
});

test('MUST NOT 由摘要重建 同一物理行 polarity', () => {
  const slice = persistSlice();
  assert.ok(
    /MUST NOT[^\n]*由摘要重建/.test(slice),
    'Persistence 節必須同一物理行綁定 MUST NOT 與「由摘要重建」'
  );
});

test('file-write-destinations 目的地欄含 notes/review-<change>-r<N>.md', () => {
  const row = destinations.split('\n').find(
    (line) => /^\|/.test(line) && line.includes(NOTES_PATH)
  );
  assert.ok(row, `file-write-destinations.md 缺少含 ${NOTES_PATH} 的表列`);
  const destCell = row.split('|')[1] ?? '';
  assert.ok(
    destCell.includes(NOTES_PATH),
    `目的地欄必須含 ${NOTES_PATH}，實際：${destCell.trim()}`
  );
  assert.ok(
    row.includes('本表定路徑'),
    'file-write-destinations.md 列必須宣告本表定路徑'
  );
  assert.ok(
    !row.includes('SSOT `code-review-checklist.md`'),
    'file-write-destinations.md 列不得把 checklist 標成路徑 SSOT'
  );
  assert.ok(
    row.includes('code-review-checklist.md'),
    'file-write-destinations.md 列必須把何時落盤指回 checklist Persistence'
  );
});

test('Persistence 節把路徑列指回 file-write-destinations.md', () => {
  const slice = persistSlice();
  assert.ok(
    slice.includes('file-write-destinations.md'),
    'Persistence 節必須把路徑列指回 file-write-destinations.md'
  );
});

test('devpro:pre-pr SKILL.md Step 3 含 canonical raw 落盤與 blocked / partial / finished', () => {
  const slice = isolateHeadingSlice(
    skill,
    '### 第三步：Six-Axis Review',
    /\n### /,
    'devpro:pre-pr SKILL Step 3'
  );
  assert.ok(slice.includes('落盤'), 'devpro:pre-pr SKILL.md 第三步缺少「落盤」');
  assert.ok(slice.includes('canonicalJsonV1(payload) + "\\n"'), 'devpro:pre-pr SKILL.md 第三步缺少 canonical raw + exact LF contract');
  assert.ok(slice.includes('blocked'), 'devpro:pre-pr SKILL.md 第三步缺少 blocked');
  assert.ok(slice.includes('partial'), 'devpro:pre-pr SKILL.md 第三步缺少 partial');
  assert.ok(slice.includes('finished'), 'devpro:pre-pr SKILL.md 第三步缺少 finished');
});

test('subagent-dispatch-blocks.md Step 3 含 落盤 與 blocked / partial / finished', () => {
  const slice = dispatchStep3Slice();
  assert.ok(slice.includes('落盤'), 'subagent-dispatch-blocks.md Step 3 缺少「落盤」');
  assert.ok(slice.includes('JSON 原文'), 'subagent-dispatch-blocks.md Step 3 缺少「JSON 原文」');
  assert.ok(slice.includes('blocked'), 'subagent-dispatch-blocks.md Step 3 缺少 blocked');
  assert.ok(slice.includes('partial'), 'subagent-dispatch-blocks.md Step 3 缺少 partial');
  assert.ok(slice.includes('finished'), 'subagent-dispatch-blocks.md Step 3 缺少 finished');
});

test('首次 stable final tree 仍完整執行 full six-axis discovery', () => {
  const slice = boundedCadenceSlice();
  assert.match(
    slice,
    /Stable final tree[^\n]*MUST[^\n]*完整跑一次六軸/,
    '首次 stable final tree 必須保留完整六軸 discovery，不得由 receipt/manifest 取代'
  );
});

test('bounded scope 唯一包含 open finding IDs、repair delta 與 immutable dependency closure', () => {
  const slice = boundedCadenceSlice();
  assert.match(
    slice,
    /bounded[^\n]*open finding IDs[^\n]*repair delta[^\n]*(?:immutable|sealed)[^\n]*dependency[- ]closure/i,
    'bounded cadence 必須同一 operative line 鎖 open IDs + repair delta + immutable closure'
  );
  assert.match(
    slice,
    /bounded_rereview_count[^\n]*(?:monotonic|不增加也不reset|不重置)[^\n]*(?:0\.\.2|<\s*3|count<3)/i,
    'bounded cadence 必須鎖 monotonic count 與只允許 0..2 dispatch'
  );
});

test('every receipt verdict binds closed Critical allowlist and evidence before convergence', () => {
  const line = assertOperativeLine(
    boundedCadenceSlice(),
    /Critical[^\n]*`fix-now`[^\n]*`non-issue-with-evidence`/,
    'receipt-level Critical closure invariant'
  );
  assert.match(
    line,
    /(?:blocked[^\n]*partial[^\n]*finished|finished[^\n]*blocked[^\n]*partial|any receipt|every receipt|all receipts|任何\s*receipt|每(?:一|個)\s*receipt)[^\n]*Critical/i,
    'the operative line must cover blocked, partial, and finished receipts rather than finished-only convergence'
  );
  assert.match(
    line,
    /Critical[^\n]*`fix-now`[^\n]*`non-issue-with-evidence`[^\n]*(?:both|兩者)[^\n]*current receipt HEAD[^\n]*stable finding ID[^\n]*current observation hash[^\n]*carrier\+anchor[^\n]*unique evidence[^\n]*tracked\/defer[^\n]*(?:block|不得)/i,
    'one operative line must bind every closed Critical to the allowlist, current-HEAD finding/observation carrier+anchor+unique evidence, and tracked/defer blocking'
  );
});

test('bounded cadence keeps savings or consumer causal effect unknown without tracker causality claims', () => {
  const canonicalSlice = boundedCadenceSlice();
  assert.match(
    canonicalSlice,
    /(?:savings|consumer(?:[- ](?:impact|effect))?|causal effect)[^\n]*unknown/i,
    'canonical bounded cadence must state that savings/consumer causal effect is unknown in the operative section'
  );

  const provenTrackerCausality = /(?:#(?:468|783)[^\n]*(?:proves?|proven|demonstrates?|confirmed|establish(?:es|ed)?|caused?|drives?|results? in|證實|證明|已確認|導致|造成|因而)|(?:proves?|proven|demonstrates?|confirmed|establish(?:es|ed)?|caused?|drives?|results? in|證實|證明|已確認|導致|造成|因而)[^\n]*#(?:468|783))/i;
  const carrierSlices = [
    ['canonical bounded cadence', canonicalSlice],
    ['fallback bounded routing', fallbackRoutingSlice()],
    ['skill Step 3', skillStep3Slice()],
    ['dispatch Step 3', dispatchStep3Slice()],
    [
      'reviewer communication protocol',
      isolateHeadingSlice(reviewer, '## Communication Protocol', /\n## /, 'dp-reviewer protocol')
    ]
  ];
  for (const [label, slice] of carrierSlices) {
    assert.doesNotMatch(
      slice,
      provenTrackerCausality,
      `${label} must not cite #468/#783 as proven causal evidence`
    );
  }
});

test('raw markdown ledger 與 immutable receipt/manifest/final record 分責', () => {
  const slice = persistSlice();
  assert.match(
    slice,
    /notes\/review-<change>-r<N>\.md[^\n]*(?:mutable|raw)[^\n]*(?:不是|MUST NOT)[^\n]*(?:machine receipt|immutable receipt)/i,
    'Persistence 必須明定 raw .md mutable 且不是 machine receipt'
  );
  const requiredDestinationPaths = [
    'notes/review-<change>-receipt-r<N>.json',
    'notes/review-<change>-manifest-<purpose>-r<N>.json',
    'notes/review-<change>-archive-transition-<postsha>.json',
    'notes/review-<change>-final-evidence-<head>.json'
  ];
  for (const literal of requiredDestinationPaths) {
    assert.ok(destinations.includes(literal), `file-write-destinations 缺少 immutable carrier ${literal}`);
  }
});

test('canonical routing carrier requires v1 receipt lineage, purpose polarity, closure, and Critical escalation', () => {
  const slice = boundedCadenceSlice();
  const anchors = [
    /ReviewRoundReceipt/,
    /previous_receipt_digest_sha256/,
    /initial_full_receipt_digest_sha256/,
    /repair-delta/,
    /dependency-closure/,
    /content-comparison/,
    /new Critical[^\n]*(?:記錄|record)[^\n]*full reopen/i,
    /out-of-manifest[^\n]*(?:記錄|record)[^\n]*full reopen/i
  ];
  for (const anchor of anchors) {
    assert.match(slice, anchor, `bounded canonical routing missing ${anchor}`);
  }
});

test('fallback、skill、dispatch、reviewer carry durable replacement-safe bounded handoff', () => {
  const carrierSlices = [
    ['fallback', fallbackRoutingSlice()],
    [
      'skill Step 3',
      isolateHeadingSlice(skill, '### 第三步：Six-Axis Review', /\n### /, 'devpro:pre-pr SKILL Step 3')
    ],
    ['dispatch Step 3', dispatchStep3Slice()],
    [
      'reviewer Input/Output',
      isolateHeadingSlice(reviewer, '## Communication Protocol', /\n## /, 'dp-reviewer protocol')
    ]
  ];
  for (const [label, slice] of carrierSlices) {
    for (const anchor of [
      /receipt(?:_payload| path| digest|_digest)/i,
      /finding_id/,
      /observation_hash/i,
      /repair[-_ ]delta/i,
      /dependency[-_ ]closure/i
    ]) {
      assert.match(slice, anchor, `${label} missing durable bounded handoff anchor ${anchor}`);
    }
  }
  assert.match(
    dispatchStep3Slice(),
    /same-agent[^\n]*(?:optimization|最佳化|優化)[^\n]*(?:MUST NOT|required|correctness)/i,
    'same-agent continuity must be optimization only, never correctness authority'
  );
});

test('FinalEvidenceRecord stays separate and invalidates on exact-HEAD/carrier mutation without deleting lineage', () => {
  assert.match(suiteCadence, /FinalEvidenceRecord/);
  assert.match(suiteCadence, /exact clean HEAD/);
  assert.match(suiteCadence, /--changed main/);
  assert.match(
    suiteCadence,
    /carrier (?:edit|mutation)[^\n]*(?:invalid|失效)[^\n]*(?:review lineage|receipt)[^\n]*(?:保持|保留|remain)/i,
    'test suite cadence SSOT must invalidate final evidence after carrier mutation while preserving review lineage'
  );
});

test('Step 3 → Step 3.6 → Step 3.7 → Post-Ledger preserves review-before-archive ordering', () => {
  const orderedHeadings = [
    ['### 第三步：Six-Axis Review', 'Step 3'],
    ['### 第三點六步段：Spec Freeze Archive + Archive Gate Check（必過）', 'Step 3.6'],
    ['### 第三點七步段：OpenSpec Validate Gate（必過）', 'Step 3.7'],
    ['### Post-Ledger Final Evidence Gate', 'Post-Ledger']
  ];
  const starts = orderedHeadings.map(([heading, label]) => uniqueHeadingStart(skillFullReadingOrder, heading, label));
  assert.deepEqual(
    starts,
    [...starts].sort((left, right) => left - right),
    'full skill heading starts must be uniquely ordered Step 3 < Step 3.6 < Step 3.7 < Post-Ledger'
  );
  const step3 = skillFullStep3Slice();
  const step36 = skillStep36Slice();
  const step37 = skillStep37Slice();
  const postLedger = skillPostLedgerSlice();
  assertOperativeLine(
    step3,
    /(?:MUST|必須)[^\n]*(?:primary full|完整六軸)[^\n]*(?:committed active|active[^\n]*(?:artifact|carrier))/i,
    'Step 3 committed-active primary full'
  );
  assertOperativeLine(
    step36,
    /terminal[^\n]*(?:no blocking|無 blocking)[^\n]*receipt[^\n]*(?:MUST|必須)[^\n]*archive/i,
    'Step 3.6 terminal receipt before archive'
  );
  assertOperativeLine(step36, /^openspec archive <name> -y$/, 'Step 3.6 archive action');
  assertOperativeLine(step37, /^openspec validate --strict --specs$/, 'Step 3.7 strict specs action');
  assertOperativeLine(step37, /^node \.devpro\/scripts\/lint-spec-shall-must\.mjs /, 'Step 3.7 SHALL/MUST lint action');
  assertOperativeLine(
    postLedger,
    /archive transition[^\n]*(?:equivalent|等價)[^\n]*MUST NOT[^\n]*(?:second|第二次)[^\n]*(?:primary full|完整六軸)/i,
    'a valid mechanical transition must not dispatch a second primary full review'
  );
  assertOperativeLine(
    postLedger,
    /(?:invalid|non-equivalent|不等價)[^\n]*(?:full_reopen_required|full reopen)/i,
    'invalid transition must route to full reopen'
  );
  assertOperativeLine(
    postLedger,
    /archive[^\n]*(?:seal-final|sealFinalEvidenceRecord)[^\n]*--changed main/i,
    'seal-final and the sole canonical final suite must occur after archive'
  );
});

test('archive-transition operative slices preserve Step 2.5, Step 5.5.3, and provenance scope', () => {
  assert.match(skill, /#### Part 3: Safety Net/);
  assert.match(skill, /#### Step 5\.5\.3: Host-aware Subagent Dispatch/);
  assert.match(dispatch, /## Step 5\.5\.3: devpro:second-review dispatch \(Post-PR Cross-Model Review\)/);
  const transitionSurface = [
    skillFullStep3Slice(),
    skillStep36Slice(),
    skillStep37Slice(),
    skillPostLedgerSlice()
  ].join('\n');
  assert.doesNotMatch(
    transitionSurface,
    /reviewer[_ -]?(?:model|family)[^\n]*provenance|provenance[^\n]*reviewer[_ -]?(?:model|family)/i,
    'archive-transition contract must not absorb the out-of-scope reviewer provenance work'
  );
});

test('dispatch Step 3 no longer unconditionally restarts the entire devpro:pre-pr workflow', () => {
  assert.doesNotMatch(
    dispatchStep3Slice(),
    /re-run the entire `\/devpro:pre-pr` skill from Step 1/,
    'blocked remediation must route by durable bounded/full evidence, not unconditional Step 1 restart'
  );
});

test('rich reviewer bounded retry no longer fills unrelated six-axis remainder', () => {
  assert.doesNotMatch(
    reviewerRetrySlice(),
    /補全六軸其餘項目/,
    'bounded retry must stay within open IDs + repair delta + immutable closure'
  );
});

test('rich reviewer output completeness is conditional on full versus bounded mode', () => {
  const surface = [
    reviewerOutputFormatSlice(),
    reviewerRetrySlice(),
    reviewerForbiddenSlice()
  ].join('\n');
  const contract = {
    unconditionalGlobalAxes: /(?:軸 1-6 每項都要有判定，不得跳過|必須六軸每一項都有判定)/.test(surface),
    fullRequiresAllAxes: /review_mode\s*=\s*full[^\n]*(?:軸\s*1-6|all six axes)[^\n]*(?:每項|complete|required|完整)/i.test(surface),
    boundedEmitsRepresentedAxesOnly: /review_mode\s*=\s*bounded[^\n]*(?:emit|輸出)[^\n]*(?:only|只)[^\n]*(?:represented|對應)[^\n]*axes/i.test(surface),
    boundedRejectsUnrelatedPlaceholders: /review_mode\s*=\s*bounded[^\n]*(?:MUST NOT|不得)[^\n]*(?:placeholder|unrelated)[^\n]*(?:axis|axes|verdict)/i.test(surface)
  };
  assert.deepEqual(
    contract,
    {
      unconditionalGlobalAxes: false,
      fullRequiresAllAxes: true,
      boundedEmitsRepresentedAxesOnly: true,
      boundedRejectsUnrelatedPlaceholders: true
    },
    'reviewer output contract must scope axes1-6 completeness to full and omit unrelated bounded placeholders/verdicts'
  );
});

test('dispatch and reviewer bind only classifier-produced logical receipt authority', () => {
  const promptFence = dispatchStep3AgentPromptFence();
  const carriers = [
    ['dispatch prompt', promptFence],
    ['reviewer Input', reviewerProtocolInputSlice()],
    ['reviewer Output', reviewerProtocolOutputSlice()]
  ];
  for (const [label, slice] of carriers) {
    for (const field of ['dispatch_id', 'round_number', 'risk_shape_digest_sha256', 'risk_shape_digest_alg']) {
      assert.match(
        slice,
        new RegExp(`(?:^|[^\\w])${field}(?:[^\\w]|$)`, 'm'),
        `${label} missing authoritative ${field}; replacement reviewer cannot construct a sealable receipt_payload`
      );
    }
  }
  for (const field of ['dispatch_id', 'round_number', 'risk_shape_digest_sha256', 'risk_shape_digest_alg']) {
    assert.match(
      promptFence,
      new RegExp(`${field}[^\\n]*(?:classifier|classify-bounded)[-_ ]?(?:produced|provided|generated|輸出|產生)[^\\n]*(?:MUST NOT|不得)[^\\n]*(?:guess|invent|自造|改寫)`, 'i'),
      `${field} must name classify-bounded as its authority and forbid reviewer guessing or rewriting on the same operative line`
    );
  }
  assert.match(
    promptFence,
    /receipt_payload[^\n]*(?:echo|bind|回傳|綁定)[^\n]*dispatch_id[^\n]*round_number[^\n]*risk_shape_digest_sha256[^\n]*risk_shape_digest_alg/i,
    'literal Step 3 prompt must require receipt_payload to echo/bind the exact four classifier-produced authority fields'
  );
  assert.doesNotMatch(
    [promptFence, reviewerProtocolInputSlice(), reviewerProtocolOutputSlice()].join('\n'),
    /(?:^|[^\w])(?:invocation_id|transport_invocation_id)(?:[^\w]|$)/m,
    'pre-dispatch prompt and immutable reviewer payload MUST NOT carry runtime invocation identity'
  );
  for (const [label, actionLine] of [
    ['skill Step 3', postResponseRawLedgerActionLine(skillStep3Slice(), 'skill Step 3')],
    ['dispatch Step 3', postResponseRawLedgerActionLine(dispatchStep3Slice(), 'dispatch Step 3')]
  ]) {
    for (const [concept, pattern] of [
      ['transport field', /transport_invocation_id/i],
      ['optional polarity', /(?:optional|MAY|可選)/i],
      ['raw-only carrier', /(?:raw|mutable|JSON 原文)/i],
      ['post-response timing', /(?:after|收到|回傳後)/i],
      ['non-authority polarity', /(?:MUST NOT|不得)[^\n]*(?:auth|provenance|authority|驗證|權威)/i]
    ]) {
      assert.match(actionLine, pattern, `${label} post-response raw-ledger action line missing ${concept}`);
    }
  }
});

test('unavailable reviewer fallback preserves the helper-classified route', () => {
  for (const [label, slice] of [
    ['skill Step 3', skillFullStep3Slice()],
    ['dispatch Step 3', dispatchStep3Slice()]
  ]) {
    const contract = {
      unconditionalAllAxes: /(?:subagent|reviewer)[^\n]*(?:unavailable|不可用)[^\n]*(?:checks all six axes|逐一檢查六軸)/i.test(slice),
      firstFull: /(?:first|首次)[^\n]*full[^\n]*(?:all six axes|完整六軸|六軸全部)/i.test(slice),
      fullRoute: /fallback[^\n]*full[^\n]*(?:all six axes|完整六軸|六軸全部)/i.test(slice),
      boundedRoute: /fallback[^\n]*bounded[^\n]*open(?: finding)? IDs[^\n]*repair[-_ ]delta[^\n]*dependency[-_ ]closure/i.test(slice),
      handbackRoute: /fallback[^\n]*handback[^\n]*(?:handback|交回)/i.test(slice)
    };
    assert.deepEqual(
      contract,
      {
        unconditionalAllAxes: false,
        firstFull: true,
        fullRoute: true,
        boundedRoute: true,
        handbackRoute: true
      },
      `${label} fallback must preserve classified full/bounded/handback routing while keeping first review full`
    );
  }
});

test('fallback bounded retry no longer reruns all six axes to resolve everything', () => {
  assert.doesNotMatch(
    fallbackWhenToUseSlice(),
    /重跑六軸確認全部 resolve/,
    'fallback must use the same bounded/full routing instead of unconditional full rerun'
  );
});

test('Step 2.5 scenario-walkthrough FAIL keeps its independent Step 1 restart route', () => {
  const slice = isolateHeadingSlice(
    skill,
    '### 第二點五步段：Scenario Walkthrough',
    /\n### /,
    'Scenario Walkthrough Step 2.5'
  );
  assert.match(
    slice,
    /scenario FAIL[^\n]*整個 `\/devpro:pre-pr`[^\n]*step 1 重跑/i,
    'Step 2.5 scenario failure is a separate route and must remain intact'
  );
});

test('QA scope resolver fails closed when active is missing and archive match is missing or ambiguous', () => {
  assert.throws(
    () => resolveQaTestScopePath({ activeExists: false, archiveCandidates: [] }),
    /archive candidate count=0/,
  );
  assert.throws(
    () =>
      resolveQaTestScopePath({
        activeExists: false,
        archiveCandidates: ['/archive/a/qa-test-scope.md', '/archive/b/qa-test-scope.md'],
      }),
    /archive candidate count=2/,
  );
});

test('strengthen-review-remediation QA scope binds the Round-2 reviewed snapshot and keeps final gates pending', () => {
  const qaTestScope = readFileSync(resolveQaTestScopePath(), 'utf8');
  const taskIds = Array.from({ length: 11 }, (_, index) => `T${index + 17}`);
  const taskEvidencePattern = (taskId) =>
    new RegExp(`^\\s*-\\s*${taskId}\\s+[^\\n]*(?:evidence|證據|RED|GREEN|PASS)`, 'i');
  const hasTaskEvidence = (content, taskId) =>
    content.split('\n').some((line) => taskEvidencePattern(taskId).test(line));
  const missingTaskEvidence = (content) =>
    taskIds.filter((taskId) => !hasTaskEvidence(content, taskId));
  assert.match(
    qaTestScope,
    /(?:Round-2[^\n]*(?:reviewed snapshot|reviewed HEAD|receipt authority)[^\n]*e88002767f0d2a72125289f79d88509c268d3e7b|e88002767f0d2a72125289f79d88509c268d3e7b[^\n]*Round-2[^\n]*(?:reviewed snapshot|reviewed HEAD|receipt authority))/i,
    'QA scope must bind e880 as the Round-2 reviewed snapshot/receipt authority without freezing the later current HEAD',
  );
  const qaLines = qaTestScope.split('\n');
  for (const taskId of taskIds) {
    const matchingLineIndexes = qaLines
      .map((line, index) => taskEvidencePattern(taskId).test(line) ? index : -1)
      .filter((index) => index >= 0);
    assert.deepEqual(
      matchingLineIndexes.length,
      1,
      `QA scope must carry exactly one explicit ${taskId} evidence line`,
    );
    const withoutExactEvidenceLine = qaLines
      .filter((_, index) => index !== matchingLineIndexes[0])
      .join('\n');
    assert.deepEqual(
      missingTaskEvidence(withoutExactEvidenceLine),
      [taskId],
      `removing the exact ${taskId} evidence line must report only ${taskId} missing`,
    );
  }
  const missing = missingTaskEvidence(qaTestScope);
  assert.deepEqual(
    missing,
    [],
    `QA scope must retain explicit rerunnable T17-T27 evidence; missing: ${missing.join(', ')}`,
  );
  assert.match(
    qaTestScope,
    /\[x\][^\n]*Scope-filtered Scenario Walkthrough[^\n]*(?:executed|PASS|已執行)/i,
    'QA scope must record the scope-filtered scenario walkthrough as executed',
  );
  assert.match(
    qaTestScope,
    /\[ \][^\n]*(?:Archive-transition|archive transition)[^\n]*(?:canonical[^\n]*final suite|final[^\n]*canonical suite)[^\n]*(?:pending|待執行)/i,
    'archive transition and the canonical final suite must remain explicitly pending',
  );
  assert.doesNotMatch(
    qaTestScope,
    /4534d09f58a058744e9e65e9e3c7e77e9188ef85/,
    'stale pre-remediation HEAD must not remain current QA authority',
  );
  assert.doesNotMatch(
    qaTestScope,
    /(?:154\/154|194\/194) PASS/,
    'stale focused aggregates must not remain current QA authority',
  );
});

// Scenario: Consumer Not-Applicable Final Evidence Satisfies Final-Suite Success Only Under The Consumer Profile
// Document-layer lock for the "report N/A, never passed" half: every carrier below keeps
// one same-physical-line consumer N/A sentence (polarity words bound to their object).
test('consumer N/A 句：test-suite-cadence 三處（consumer 分流／Transition suite result／Merge evidence 只認 pass）', () => {
  assertOperativeLine(
    suiteCadence,
    /^- \*\*consumer rules tag 例外／consumer context 先分流\*\*[^\n]*`seal-final` 只在 direct consumer（Mode A）判定下封存 `not-applicable-consumer-profile`（N\/A，不代表專案測試已跑）；Mode B 仍 fail closed。/,
    'test-suite-cadence consumer context 先分流 N/A sentence'
  );
  assertOperativeLine(
    suiteCadence,
    /^- \*\*Transition\/FinalEvidenceRecord\*\*[^\n]*immutable log、suite result（source 為 pass 與計數；consumer 為 `not-applicable-consumer-profile` 與 `null` 計數）/,
    'test-suite-cadence Transition/FinalEvidenceRecord suite result'
  );
  assertOperativeLine(
    suiteCadence,
    /^- \*\*Merge evidence[^\n]*(?:\(3\))[^\n]*只有 `result: pass` 紀錄成立，consumer N\/A 紀錄不成立/,
    'test-suite-cadence Merge evidence form (3) accepts pass only'
  );
});

test('consumer N/A 句：pre-pr SKILL Post-Ledger gate 記 N/A（consumer profile）且不得寫 passed', () => {
  assertOperativeLine(
    skillPostLedgerSlice(),
    /consumer 判定下 `seal-final` 記 `not-applicable-consumer-profile`；PR Test Evidence 寫 N\/A（consumer profile）[^\n]*`seal-final`／`verify-final`[^\n]*`result`，不得寫 passed/,
    'pre-pr SKILL Post-Ledger consumer N/A sentence'
  );
});

test('consumer N/A 句：scenario-m Step 6 checkbox 與 Negative Checks 不得把 N/A 記為 pass', () => {
  const step6 = isolateHeadingSlice(
    scenarioM,
    '### Step 6: Archive',
    /\n##+ /,
    'scenario-m Step 6'
  );
  assertOperativeLine(
    step6,
    /^- \[ \] `seal-final` 在 consumer 封存 `not-applicable-consumer-profile`（N\/A），`verify-final` 通過；PR Test Evidence 寫 N\/A（consumer profile），不寫 passed$/,
    'scenario-m Step 6 consumer N/A checkbox'
  );
  const negative = isolateHeadingSlice(
    scenarioM,
    '## Negative Checks',
    /\n## /,
    'scenario-m Negative Checks'
  );
  assertOperativeLine(
    negative,
    /^- \[ \] \*\*不應\*\*把 consumer 的 `not-applicable-consumer-profile` 記為 pass 或當成專案測試證據$/,
    'scenario-m Negative Checks N/A must not be recorded as pass'
  );
});
