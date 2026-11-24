import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, VALID_BRD_FIXTURE } from './lib/tmp.mjs';

// Gate (q): design.md format-when-present check (BRD FR5 / Cooperative
// watershed). design.md is NEVER required (no presence gate) — an archive
// with no design.md must always pass. But when a PR-touched relevant archive
// DOES contain design.md, its hook-enforced required headings (single SSOT:
// .devpro/agent-rules/design-template.md — `## Context` + `## Decisions`)
// must be present. Scope-bound to relevantExistingArchives (mirrors check
// (o), NOT the bcEvalArchives empty-set-fallback-to-latest pattern of (b)/(c))
// so Grandfather archives never get retroactively validated.

const GATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../pre-pr-archive-gate.mjs'
);

// Reused from pre-pr-archive-gate.test.mjs — keeps (c)/(d)/(m) green so
// (q) is the only gate under test.
const VALID_PROPOSAL_CONTENT =
  '# Proposal: fixture\n\n' +
  '## Why\n\ntest fixture\n\n' +
  '## What Changes\n\ntest changes\n\n' +
  '## Requirement Ledger\n\n' +
  '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
  '|---|---|---|---|---|---|\n' +
  '| R1 | fixture root | same as root | fixture current | implemented | this fixture |\n\n' +
  '## Section 3: Tasks\n\n' +
  '- [x] [Req: R1] fixture task coverage\n\n' +
  '## Issue Anchor Verification\n\n' +
  '`grep -F "anchor" file.md` → 1 hit @ file.md:10\n\n' +
  '## Batch Approval Ledger\n\nN/A: no batch approval selected\n';

const WELL_FORMED_DESIGN =
  '# Design: fixture\n\n## Context\n\nbackground.\n\n## Decisions\n\ndecision + tradeoff.\n';
const MISSING_DECISIONS_DESIGN =
  '# Design: fixture\n\n## Context\n\nbackground only, no Decisions heading.\n';
const MISSING_CONTEXT_DESIGN =
  '# Design: fixture\n\n## Decisions\n\ndecision only, no Context heading.\n';

// env: DEVPRO_DIFF_ACTIVE_CHANGES='' clears gate (a); DEVPRO_RELEVANT_ARCHIVES
// scopes gates (b)/(c)/(d)/(e)/(g)/(m)/(o)/(q) to the fixture archive (mirrors
// the (o) test suite's O_ENV convention in pre-pr-archive-gate.test.mjs).
const Q_ENV = { DEVPRO_DIFF_ACTIVE_CHANGES: '' };

function git(repo, ...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

function initializeGitFixture(dir) {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture baseline');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
}

function setupFixture({ archiveName, designContent, proposalContent = VALID_PROPOSAL_CONTENT }) {
  const dir = makeTempDir('archive-gate-q-test-');
  const archivePath = path.join(dir, 'openspec/changes/archive', archiveName);
  mkdirSync(archivePath, { recursive: true });
  writeFileSync(path.join(archivePath, 'proposal.md'), proposalContent);
  writeFileSync(path.join(archivePath, 'brd.md'), VALID_BRD_FIXTURE);
  if (designContent !== undefined) {
    writeFileSync(path.join(archivePath, 'design.md'), designContent);
  }
  initializeGitFixture(dir);
  return dir;
}

function run(fixtureDir, env = {}) {
  return spawnSync('node', [GATE, fixtureDir], {
    encoding: 'utf8',
    env: { ...process.env, ...Q_ENV, ...env },
  });
}

test('case (q-1): relevant archive design.md missing ## Decisions → exit 1', () => {
  const archiveName = '2026-07-16-q-missing-decisions';
  const dir = setupFixture({ archiveName, designContent: MISSING_DECISIONS_DESIGN });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 1, `expected exit 1 (design.md missing ## Decisions), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /\(q\)/);
    assert.match(r.stderr, /design\.md/);
    assert.match(r.stderr, /## Decisions/);
    assert.match(r.stderr, /design-template\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (q-1b): relevant archive design.md missing ## Context → exit 1', () => {
  const archiveName = '2026-07-16-q-missing-context';
  const dir = setupFixture({ archiveName, designContent: MISSING_CONTEXT_DESIGN });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 1, `expected exit 1 (design.md missing ## Context), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /\(q\)/);
    assert.match(r.stderr, /## Context/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (q-2): relevant archive with NO design.md → exit 0 (no presence gate)', () => {
  const archiveName = '2026-07-16-q-no-design';
  const dir = setupFixture({ archiveName, designContent: undefined });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 0, `expected exit 0 (no design.md must never block), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /\(q\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (q-3): relevant archive with well-formed design.md → exit 0', () => {
  const archiveName = '2026-07-16-q-well-formed';
  const dir = setupFixture({ archiveName, designContent: WELL_FORMED_DESIGN });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 0, `expected exit 0 (well-formed design.md), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /\(q\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (q-4): out-of-scope archive with malformed design.md → NOT validated, exit 0 (Grandfather)', () => {
  // Two archives exist on disk: an in-scope one (clean, no design.md) and an
  // out-of-scope one (malformed design.md, pre-existing debt this PR did not
  // touch). DEVPRO_RELEVANT_ARCHIVES names ONLY the in-scope archive, so the
  // out-of-scope archive's malformed design.md must never be evaluated —
  // proving scope-binding = Grandfather (no retroactive validation).
  const dir = makeTempDir('archive-gate-q-test-');
  const inScopeName = '2026-07-16-q-in-scope';
  const outOfScopeName = '2020-01-01-q-out-of-scope-legacy';
  try {
    const inScopePath = path.join(dir, 'openspec/changes/archive', inScopeName);
    mkdirSync(inScopePath, { recursive: true });
    writeFileSync(path.join(inScopePath, 'proposal.md'), VALID_PROPOSAL_CONTENT);
    writeFileSync(path.join(inScopePath, 'brd.md'), VALID_BRD_FIXTURE);

    const outOfScopePath = path.join(dir, 'openspec/changes/archive', outOfScopeName);
    mkdirSync(outOfScopePath, { recursive: true });
    writeFileSync(path.join(outOfScopePath, 'proposal.md'), VALID_PROPOSAL_CONTENT);
    writeFileSync(path.join(outOfScopePath, 'brd.md'), VALID_BRD_FIXTURE);
    writeFileSync(path.join(outOfScopePath, 'design.md'), MISSING_DECISIONS_DESIGN);
    initializeGitFixture(dir);

    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: inScopeName });
    assert.equal(
      r.status, 0,
      `expected exit 0 (out-of-scope malformed design.md must not block), got ${r.status}: ${r.stderr}`
    );
    assert.doesNotMatch(r.stderr, /\(q\)/);
    assert.doesNotMatch(r.stderr, new RegExp(outOfScopeName));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
