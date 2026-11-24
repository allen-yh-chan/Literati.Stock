import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { sourcePath } from './lib/source-root.mjs';
import { readSourceFile as read } from './lib/read.mjs';



function readIfExists(rel) {
  const file = sourcePath(rel);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

// Read the local-md delta from whichever location holds it: the active change folder
// pre-archive, or the archived folder post-archive. A fixed active-only path would
// read empty after archive and silently stop guarding the delta (cross-model finding,
// PR #1055). Glob the archive dir for the *-add-program-tracker-mode folder.
function readProgramTrackerDelta() {
  const active = readIfExists(
    'openspec/changes/add-program-tracker-mode/specs/openspec-flow/spec.md',
  );
  if (active) return active;
  const archiveDir = sourcePath('openspec/changes/archive');
  if (!existsSync(archiveDir)) return '';
  const match = readdirSync(archiveDir)
    .filter((d) => d.endsWith('-add-program-tracker-mode'))
    .sort()
    .pop();
  if (!match) return '';
  return readIfExists(`openspec/changes/archive/${match}/specs/openspec-flow/spec.md`);
}

const consumerFlow = read('.devpro/agent-rules/openspec-flow-consumer.md');
const programTrackerMode = read('.devpro/agent-rules/program-tracker-mode.md');
const platformMigration = read('.devpro/agent-rules/platform-migration.md');
const canonicalSpec = read('openspec/specs/openspec-flow/spec.md');
const localMdDelta = readProgramTrackerDelta();
const programSpecText = `${canonicalSpec}\n${localMdDelta}`;
const programPlanningState = readIfExists('.devpro/agent-rules/program-planning-state.md');

// Slice one H3 section (heading through the next H3 heading, or EOF) out of the new
// sibling leaf so assertions can be scoped per planning-state facet instead of
// matching anywhere in the file (would hide a phrase landing in the wrong section).
function planningSection(heading) {
  const start = programPlanningState.indexOf(heading);
  if (start < 0) return '';
  const next = programPlanningState.indexOf('\n### ', start + 1);
  return programPlanningState.slice(start, next > 0 ? next : programPlanningState.length);
}

// Locate the single physical line carrying an anchor token. design.md pins several
// anchor sentences (L1-L4) as single physical lines on purpose so a compound regex
// can bind polarity tokens + operative tokens on the same line (rule-anchor-guard-strength.md);
// this helper makes that row-bound check explicit instead of falling back to whole-file includes().
function findLine(text, anchor) {
  return text.split('\n').find((line) => line.includes(anchor)) || '';
}

test('program-tracker-mode sibling defines Program Tracker Mode wrapper and resolution', () => {
  for (const phrase of [
    '### Program Tracker Mode',
    'external-tracker',
    'local-md',
    'per-program presence 推斷',
    'mode 是 **per-program**',
    'openspec/programs/<program-key>/program.md',
    'Discovery MUST 同時掃兩邊',
    '不相關的 program.md 不得抑制 external discovery',
    '歧義即停',
    'Bootstrap 選 mode',
    'MUST stop and ask before creating any tracker artifact',
    '禁止默默推斷 mode',
  ]) {
    assert.ok(programTrackerMode.includes(phrase), `program-tracker-mode.md missing ${phrase}`);
  }
});

test('program-tracker-mode sibling defines Local-MD Program Tracking anchors', () => {
  for (const phrase of [
    '### Local-MD Program Tracking',
    'program.md 內容邊界',
    '只放 program-level requirements',
    '複製 phase BRD',
    'openspec/changes/<phase>/brd.md',
    'phase dashboard 表',
    'OpenSpec change path、PR、Status、Risk、Completion summary',
    'MUST NOT 設 per-phase pointer 檔',
    'PR body MUST 連 `program.md` path',
    'openspec/programs/archive/<YYYY-MM-DD>-<program-key>/',
    '降級為單一短命 OpenSpec change',
    'local-md 僅供 consumer repo；source repo 不適用',
  ]) {
    assert.ok(programTrackerMode.includes(phrase), `program-tracker-mode.md missing ${phrase}`);
  }
});

test('external-tracker default and Issue-first section are preserved in sibling', () => {
  // Program Tracker Mode wrapper must sit before the unchanged Issue-first section.
  const modeIdx = programTrackerMode.indexOf('### Program Tracker Mode');
  const issueIdx = programTrackerMode.indexOf('### Issue-first Program Tracking');
  const localIdx = programTrackerMode.indexOf('### Local-MD Program Tracking');
  assert.ok(modeIdx >= 0 && issueIdx >= 0 && localIdx >= 0, 'all three sections must exist in program-tracker-mode.md');
  assert.ok(modeIdx < issueIdx, 'Program Tracker Mode wrapper must precede Issue-first section');
  assert.ok(issueIdx < localIdx, 'Local-MD section must follow Issue-first section');
  assert.ok(
    programTrackerMode.includes('**default `external-tracker`**'),
    'wrapper must state external-tracker is the default mode',
  );
});

test('platform-migration tracker wording is mode-neutral', () => {
  assert.match(
    platformMigration,
    /第一個 PR 前需 program tracker \+ Program base branch \+ phase dashboard/,
    'L17 trigger must read mode-neutral "program tracker"',
  );
  assert.ok(
    platformMigration.includes('依 `program-tracker-mode.md` Program Tracker Mode'),
    'Program Issue / Phase Tracking section must route to program-tracker-mode.md',
  );
  assert.ok(
    platformMigration.includes('local-md 下 Program issue→`program.md`、sub-issue→dashboard row'),
    'platform-migration must map local-md tracker medium',
  );
});

test('openspec-flow spec records mode-neutral requirement and local-md scenarios', () => {
  for (const phrase of [
    'Requirement: Consumer Issue-first Program Tracking',
    'Program Tracker Mode',
    'The default mode is `external-tracker`',
    'Requirement: Consumer Local-MD Program Tracking',
    'resolved per program, not per repository',
    'Every scenario in this requirement applies only to programs resolved to `external-tracker` mode',
    'Scenario: Per-program presence inference selects mode without suppressing the other tracker',
    'unrelated `program.md` present in the repo MUST NOT suppress the active Program Issue search',
    'Scenario: Bootstrap with no matching tracker asks the user to choose a mode',
    'Scenario: local-md program.md holds dashboard but not phase BRD',
    'Scenario: local-md state changes are updated before PR',
    'Scenario: local-md completion archives the program folder',
    'Scenario: local-md fails closed on unreadable tracker',
    'Scenario: local-md repo-specific program rules stay out of AGENTS',
    'openspec/programs/archive/<YYYY-MM-DD>-<program-key>/',
  ]) {
    assert.ok(programSpecText.includes(phrase), `openspec-flow spec missing ${phrase}`);
  }
});

test('local-md delta is read and guarded distinctly from the promoted canonical spec', () => {
  // The spec-scenario test asserts against canonicalSpec+localMdDelta, but every
  // asserted phrase was promoted into the canonical spec — so localMdDelta could read
  // empty and that test would still pass, making the archived-delta fallback a silent
  // no-op (cross-model finding, PR #1055). Assert the delta non-empty and pin a
  // delta-only anchor that does NOT exist in the canonical spec, so a broken glob or a
  // gutted delta fails here.
  assert.ok(localMdDelta.length > 0, 'local-md delta must be readable from active or archived folder');
  const deltaAnchor = '# openspec-flow Delta: Program Tracker Mode';
  assert.ok(localMdDelta.includes(deltaAnchor), `local-md delta missing anchor ${deltaAnchor}`);
  assert.ok(
    !canonicalSpec.includes(deltaAnchor),
    'delta anchor must be delta-only so this guard actually exercises the delta path',
  );
});

test('Issue-first requirement framing and scenarios are per-program, not mode-blind', () => {
  // Scope to the whole Consumer Issue-first Program Tracking requirement block.
  // A positive-only guard stays green even if a scenario regresses to mode-blind
  // wording that is over-broad under the per-program model — the same isolated-read
  // drift class cross-model review surfaced three times on PR #1055 (lead paragraph,
  // then sibling scenarios). Negative-assert each regressed form across the block.
  const reqStart = canonicalSpec.indexOf('### Requirement: Consumer Issue-first Program Tracking');
  assert.ok(reqStart >= 0, 'canonical spec must contain the Issue-first requirement');
  const nextReq = canonicalSpec.indexOf('\n### Requirement:', reqStart + 1);
  const block = canonicalSpec.slice(reqStart, nextReq > 0 ? nextReq : reqStart + 4000);
  // Positive: lead paragraph states per-program resolution.
  assert.ok(
    block.includes('per program, not per repository'),
    'Issue-first requirement framing must state per-program resolution',
  );
  // Negative: lead paragraph must not carry the repo-level presence shorthand.
  assert.ok(
    !/an active `openspec\/programs\/<program-key>\/program\.md` selects `local-md`, otherwise/.test(block),
    'Issue-first requirement must NOT carry the repo-level presence shorthand',
  );
  // Negative: bootstrap scenario must not fire on "no Program Issue" alone (over-broad
  // under per-program — a local-md-matching request also has no Program Issue).
  assert.ok(
    !/\*\*WHEN\*\* no active Program Issue exists but the request is program-shaped/.test(block),
    'Missing-tracker bootstrap scenario must be qualified to external-tracker, not fire on absent Program Issue alone',
  );
  // Negative: discovery scenario must not mandate an unconditional Program Issue search
  // as the sole THEN (per-program discovery scans both mediums first).
  assert.ok(
    !/\*\*THEN\*\* the AI MUST search for an active Program Issue before planning or implementation/.test(block),
    'Discovery scenario must run per-program discovery, not mandate an unconditional Program Issue search',
  );
});

test('program-planning-state sibling exists with five planning-state H3 anchors (A1)', () => {
  for (const heading of [
    '### 既有 Program 的過渡（不 backfill）',
    '### Program 目的地',
    '### Program 還講不清的部分',
    '### Program 不做的部分',
    '### 卡關關係與認領判定',
  ]) {
    assert.ok(programPlanningState.includes(heading), `program-planning-state.md missing ${heading}`);
  }
});

test('既有 Program 的過渡 clause locks no-backfill + create-on-demand + no-retroactivity on one physical line (A15)', () => {
  const section = planningSection('### 既有 Program 的過渡（不 backfill）');
  const line = findLine(section, '一次性回填');
  for (const token of ['MUST NOT', '一次性回填', 'create-on-demand', '不追溯']) {
    assert.ok(line.includes(token), `transition clause line missing token: ${token}`);
  }
});

test('program-planning-state sibling declares a Load-chain back-reference to the parent carrier (A4)', () => {
  assert.ok(
    programPlanningState.includes('> Load-chain：'),
    'program-planning-state.md missing Load-chain back-reference',
  );
  assert.ok(
    programPlanningState.includes('program-tracker-mode.md'),
    'program-planning-state.md Load-chain must reference program-tracker-mode.md',
  );
});

test('Program 目的地 section carries both mode labels (A2)', () => {
  const section = planningSection('### Program 目的地');
  assert.ok(section.includes('**external-tracker**'), 'destination section missing external-tracker label');
  assert.ok(section.includes('**local-md**'), 'destination section missing local-md label');
});

test('Program 目的地 section states the destination-vs-requirements division of labor (A8)', () => {
  const section = planningSection('### Program 目的地');
  assert.ok(section.includes('要滿足什麼'), 'destination section missing "要滿足什麼" (program-level requirements phrasing)');
  assert.ok(section.includes('到什麼狀態就收工'), 'destination section missing "到什麼狀態就收工" (destination phrasing)');
});

test('Program 還講不清的部分 admission/exclusion clause is polarity-guarded on a single physical line (A14)', () => {
  const section = planningSection('### Program 還講不清的部分');
  // L1: admission half + exclusion half share one physical line (design.md D3 anchor row).
  const l1 = findLine(section, '才進本段');
  for (const token of [
    '只有',
    '不確定點本身',
    '要交付什麼',
    '怎樣算完成',
    '才進本段',
    '做法',
    '整合邊界',
    '不屬本段',
  ]) {
    assert.ok(l1.includes(token), `L1 admission/exclusion line missing token: ${token}`);
  }
  // L2: distinguish sentence — the three graduation questions are an exit gate, not an
  // admission ticket. Must be a separate physical line from L1.
  const l2 = findLine(section, '不是收容條件');
  assert.notEqual(l2, l1, 'L2 distinguish sentence must be a distinct physical line from L1');
  for (const token of ['三題', '畢業門檻', '不是收容條件']) {
    assert.ok(l2.includes(token), `L2 distinguish line missing token: ${token}`);
  }
});

test('Every planning-state section binds its own clauses to the parent update gate and completion, once per mode (A6)', () => {
  // design.md D2 line 144: "新檔每節 MUST 明文寫出" the gate-binding phrase — this is a
  // per-section reachability declaration (D2 rationale (c): if a section's content is
  // deleted, its own binding disappears with it, so a file-wide count can't tell which
  // section lost coverage). A global occurrence count can't discriminate a single
  // section carrying it twice from all four sections carrying it once each — it must
  // be checked per section.
  const bindingPhrase = '本節條款於 `program-tracker-mode.md` 的 update gate（PR 前）與 completion 執行';
  for (const heading of [
    '### Program 目的地',
    '### Program 還講不清的部分',
    '### Program 不做的部分',
    '### 卡關關係與認領判定',
  ]) {
    const section = planningSection(heading);
    const occurrences = section.split(bindingPhrase).length - 1;
    assert.ok(
      occurrences >= 2,
      `expected gate-binding phrase at least twice (once per mode) in ${heading}, got ${occurrences}`,
    );
  }
});

test('Program 還講不清的部分 completion clause enumerates all three residual-item dispositions (A7)', () => {
  const section = planningSection('### Program 還講不清的部分');
  assert.ok(section.includes('MUST 為空'), 'completion clause must require the section be empty at completion');
  for (const word of ['畢業', '併入不做的部分', '移交後續 program']) {
    assert.ok(section.includes(word), `completion clause missing disposition: ${word}`);
  }
});

test('Program 還講不清的部分 graduation destinations are exhaustive and correctly timed (A10)', () => {
  const section = planningSection('### Program 還講不清的部分');
  const l3 = findLine(section, '落點只有兩處');
  for (const token of ['落點只有兩處', '`Phase` 欄', 'sub-issue title', '目的地']) {
    assert.ok(l3.includes(token), `L3 graduation-destination line missing token: ${token}`);
  }
  const l4 = findLine(section, '不是畢業落點');
  assert.notEqual(l4, l3, 'L4 timing clarification must be a distinct physical line from L3');
  for (const token of ['Completion summary', '不是畢業落點']) {
    assert.ok(l4.includes(token), `L4 timing-clarification line missing token: ${token}`);
  }
  for (const forbidden of ['## Open Questions', 'clarification round', 'chore A']) {
    assert.ok(
      !section.includes(forbidden),
      `section must not name ${forbidden} as a graduation destination`,
    );
  }
});

test('Program 不做的部分 section carries both mode labels and the four-layer cross-cite (A2)', () => {
  const section = planningSection('### Program 不做的部分');
  assert.ok(section.includes('**external-tracker**'), 'non-goals section missing external-tracker label');
  assert.ok(section.includes('**local-md**'), 'non-goals section missing local-md label');
  for (const carrier of [
    'design-template.md',
    'ambiguity-scoring.md',
    'platform-migration.md',
  ]) {
    assert.ok(section.includes(carrier), `non-goals section missing cross-cite to ${carrier}`);
  }
  assert.ok(section.includes('program 層'), 'non-goals section must self-identify as the program layer');
});

test('卡關關係與認領判定 section carries both mode labels (A2)', () => {
  const section = planningSection('### 卡關關係與認領判定');
  assert.ok(section.includes('**external-tracker**'), 'blocked-relationship section missing external-tracker label');
  assert.ok(section.includes('**local-md**'), 'blocked-relationship section missing local-md label');
});

test('卡關關係 carriers are semantically symmetric across modes, not structurally identical (A9)', () => {
  const section = planningSection('### 卡關關係與認領判定');
  assert.ok(section.includes('Blocked-by'), 'local-md Blocked-by dashboard column anchor missing');
  assert.ok(section.includes('native issue dependency'), 'external-tracker native dependency anchor missing');
  assert.ok(
    /MUST[^\n]*fallback/.test(section),
    'external-tracker unconditional-fallback MUST anchor missing',
  );
});

test('卡關關係 claim determination cites session-pending-lifecycle.md without duplicating its ordering logic (A11)', () => {
  const section = planningSection('### 卡關關係與認領判定');
  assert.ok(
    section.includes('session-pending-lifecycle.md'),
    'claim-determination clause must cite session-pending-lifecycle.md',
  );
  assert.ok(
    !section.includes('**對應 PR 已 merge**（不論 branch 是否還在）'),
    'must not verbatim-copy the merged-order determination sentence',
  );
  assert.ok(
    !section.includes('branch 已無且無 merged PR'),
    'must not verbatim-copy the stale-order determination sentence',
  );
});

test('program-planning-state is reachable from both the parent carrier and the entry leaf (A3)', () => {
  assert.ok(
    programTrackerMode.includes('`program-planning-state.md`'),
    'program-tracker-mode.md must reference program-planning-state.md',
  );
  assert.ok(
    consumerFlow.includes('`program-planning-state.md`'),
    'openspec-flow-consumer.md must reference program-planning-state.md',
  );
});

test('program-tracker-mode dashboard gains Blocked-by while preserving the existing field prefix (A5)', () => {
  assert.ok(
    programTrackerMode.includes(
      'OpenSpec change path、PR、Status、Risk、Completion summary、Blocked-by',
    ),
    'dashboard field list must append Blocked-by after the existing, unmodified prefix',
  );
});

test('platform-migration dashboard field list gains Blocked-by（local-md）(A12)', () => {
  assert.ok(
    platformMigration.includes('Blocked-by（local-md）'),
    'platform-migration.md dashboard field list missing Blocked-by（local-md）',
  );
});

test('Neither planning-state carrier leaks external tracker-tool jargon (A13)', () => {
  // Only extracted planning semantics were ported, not the tracker-tool chrome itself
  // (see decisions.md rejected R11). A regression here means the 9-item non-adopted
  // list from that decision is leaking back into the shipped carriers.
  const negatives = [
    /\bwayfinder\b/i,
    /fog of war/i,
    /\bfog\b/i,
    /\bfrontier\b/i,
    /sharpness test/i,
    /wayfinder:map/i,
    /map-as-issue/i,
    /\bmap\b/i,
    /\bgrilling\b/i,
    /\bHITL\b/,
    /\bAFK\b/,
    /setup-matt-pocock-skills/,
  ];
  for (const [label, text] of [
    ['program-planning-state.md', programPlanningState],
    ['program-tracker-mode.md', programTrackerMode],
  ]) {
    for (const pattern of negatives) {
      assert.ok(!pattern.test(text), `${label} must not match forbidden external-tracker jargon: ${pattern}`);
    }
  }
});
