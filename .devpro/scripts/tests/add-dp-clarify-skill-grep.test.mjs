import assert from 'node:assert/strict';
import { readFileSync, lstatSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import test from 'node:test';
import { mergePromotableDecisions } from '../lib/promote-pending-clarification.mjs';
import { repoPath } from './lib/repo-root.mjs';
import { readChangeSkillFullReadingOrder } from './lib/change-skill.mjs';

const clarifySkill = repoPath('.devpro/agent-skills/devpro-workflows/clarify/SKILL.md');
const manifestPath = repoPath('.devpro/agent-skills/manifest.json');
const catalogRoot = repoPath('.devpro/agent-skills');

test('T1: devpro:clarify skill exists with modes and user-invocable', () => {
  assert.equal(existsSync(clarifySkill), true);
  const body = readFileSync(clarifySkill, 'utf8');
  assert.match(body, /name:\s*clarify/);
  assert.match(body, /user-invocable:\s*true/);
  assert.match(body, /## Mode: explore/);
  assert.match(body, /## Mode: pre-analyst/);
  assert.match(body, /Policy SSOT 留在 rule leaves/);
});

test('T1: manifest + discoverable via the two-entry devpro topology', () => {
  const manifest = readFileSync(manifestPath, 'utf8');
  assert.match(manifest, /"name":\s*"clarify"/);
  const catalogRealpath = realpathSync(catalogRoot);
  for (const discoveryDir of ['.agents/skills', '.claude/skills']) {
    const dirFull = repoPath(discoveryDir);
    assert.deepEqual(
      readdirSync(dirFull),
      ['devpro'],
      `${discoveryDir} must hold only the 'devpro' entry, not a per-skill link`,
    );
    const entryFull = repoPath(`${discoveryDir}/devpro`);
    assert.equal(lstatSync(entryFull).isSymbolicLink(), true, `${discoveryDir}/devpro must be symlink`);
    assert.equal(
      realpathSync(entryFull),
      catalogRealpath,
      `${discoveryDir}/devpro must resolve to the catalog root itself`,
    );
    assert.equal(
      existsSync(repoPath(`${discoveryDir}/devpro/devpro-workflows/clarify/SKILL.md`)),
      true,
      `clarify must be discoverable via ${discoveryDir}/devpro/devpro-workflows/clarify/SKILL.md`,
    );
  }
});

test('T2: devpro:change Step 4 MUST invoke devpro:clarify pre-analyst; no embedded multi-step recipe', () => {
  const body = readChangeSkillFullReadingOrder();
  assert.match(body, /第四步：Pre-analyst Clarification（MUST invoke `\/devpro:clarify`）/);
  assert.match(body, /MUST load[\s\S]*devpro:clarify[\s\S]*pre-analyst/);
  assert.doesNotMatch(
    body,
    /\*\*Seams-first\*\*[\s\S]{0,200}\*\*Clarification rounds\*\*[\s\S]{0,200}\*\*Cap-hit/,
    'must not keep embedded Seams-first → Clarification rounds → Cap-hit list',
  );
  assert.match(body, /禁止[\s\S]{0,80}等價 gate/);
});

test('T3/T4: explore capsule + formalize promote owner = devpro:change', () => {
  const clarify = readFileSync(clarifySkill, 'utf8');
  const change = readChangeSkillFullReadingOrder();
  assert.match(clarify, /clarify_stage:\s*explore/);
  assert.match(clarify, /promote_ready/);
  assert.match(clarify, /MUST NOT[\s\S]{0,120}meeting-notes/);
  assert.match(clarify, /MUST NOT[\s\S]{0,120}dp-analyst/);
  assert.match(change, /Formalize auto-promote（唯一 owner/);
  assert.match(change, /idempotent merge/);
  assert.match(clarify, /MUST NOT[\s\S]{0,80}第二套 promote/);
});

test('D2 decision-table anchors in devpro:clarify', () => {
  const body = readFileSync(clarifySkill, 'utf8');
  assert.match(body, /強制\*\* `pre-analyst`/);
  assert.match(body, /明確\*\* `mode=explore`/);
  assert.match(body, /即使 repo 另有其他 active/);
  assert.match(body, /≥1 個 active/);
  assert.match(body, /零\*\* active change folder → `explore`/);
  assert.match(body, /禁猜最新/);
  assert.match(body, /\*\*停下\*\*問/);
  assert.match(body, /Decision-table/);
});

test('R7 negative: no grill-me / US / UC product port outside forbid lists', () => {
  const body = readFileSync(clarifySkill, 'utf8');
  const affirmative = body
    .split('\n')
    .filter((l) => !/MUST NOT|禁|不做|移植|Avoid|_Avoid_/i.test(l))
    .join('\n');
  assert.doesNotMatch(affirmative, /\bgrill-me\b/i);
  assert.doesNotMatch(affirmative, /\bUser Story\b/);
  assert.doesNotMatch(affirmative, /\bUse Case\b/);
  assert.doesNotMatch(affirmative, /\bJTBD\b/);
  assert.doesNotMatch(affirmative, /\bOST\b/);
  assert.doesNotMatch(body, /working cap\s*3/);
  assert.doesNotMatch(body, /absolute max\s*4/);
});

test('promote lib: idempotent retry + missing provenance + conflict fail-closed', () => {
  const first = mergePromotableDecisions([], ['lock batch (provenance: user)']);
  assert.equal(first.decisions.length, 1);
  const retry = mergePromotableDecisions(first.decisions, ['lock batch (provenance: user)']);
  assert.equal(retry.decisions.length, 1);
  const missing = mergePromotableDecisions([], ['no provenance here']);
  assert.equal(missing.rejected.length, 1);
  assert.match(missing.unresolved[0], /missing-provenance/);
  const conflict = mergePromotableDecisions(
    ['same text (provenance: user)'],
    ['same text (provenance: repo-fact)', 'other ok (provenance: user)'],
  );
  assert.match(conflict.unresolved[0], /promote-provenance-conflict/);
  assert.equal(conflict.aborted, true);
  assert.equal(conflict.decisions.length, 1);
  assert.equal(conflict.decisions[0], 'same text (provenance: user)');
  const incomingConflict = mergePromotableDecisions(
    [],
    ['dup (provenance: user)', 'dup (provenance: repo-fact)', 'after (provenance: user)'],
  );
  assert.match(incomingConflict.unresolved[0], /promote-provenance-conflict/);
  assert.equal(incomingConflict.aborted, true);
  assert.equal(incomingConflict.decisions.length, 0);
});
