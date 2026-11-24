/**
 * Unit + wiring prove-it for `.devpro/scripts/lib/task-ledger-resolution.mjs`.
 *
 * T1 (wiring): consumers must import the SSOT and must not keep silent-diverged
 * inline carrier policies. These assertions are RED before the SSOT is wired
 * and GREEN after.
 *
 * T4 (API): null / single / dual ordered-first / any-marker / no-marker.
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');
const SSOT_PATH = join(SCRIPTS, 'lib', 'task-ledger-resolution.mjs');
const GATE_PATH = join(SCRIPTS, 'pre-pr-archive-gate.mjs');
const LINT_PATH = join(SCRIPTS, 'lint-proposal-tasks-checked.mjs');

function mkChangeDir() {
  const root = join(tmpdir(), `tlr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

// ── T1 prove-it: SSOT wiring across three consumers ─────────────────────────

describe('T1 prove-it: task-ledger SSOT wiring', () => {
  test('SSOT module file exists', () => {
    assert.ok(existsSync(SSOT_PATH), `expected ${SSOT_PATH} to exist`);
  });

  test('pre-pr-archive-gate.mjs imports SSOT and has no inline taskLedgerCarrierCandidates', () => {
    const src = readFileSync(GATE_PATH, 'utf8');
    assert.match(
      src,
      /from ['"]\.\/lib\/task-ledger-resolution\.mjs['"]/,
      'gate must import lib/task-ledger-resolution.mjs'
    );
    assert.ok(
      !src.includes('taskLedgerCarrierCandidates'),
      'gate must not keep inline taskLedgerCarrierCandidates after SSOT wiring'
    );
    assert.match(
      src,
      /findProveItInTaskLedgerCarriers/,
      'check (l) must call findProveItInTaskLedgerCarriers'
    );
    assert.match(
      src,
      /resolveExecutableTaskLedgerCarrier/,
      'check (m) coverage must call resolveExecutableTaskLedgerCarrier'
    );
    assert.ok(
      !/existsSync\(tasksPath\)\s*\?\s*readFileSync\(tasksPath/.test(src),
      'check (m) must not keep tasks.md-first coverage ternary'
    );
  });

  test('lint-proposal-tasks-checked.mjs imports SSOT resolveExecutableTaskLedgerCarrier', () => {
    const src = readFileSync(LINT_PATH, 'utf8');
    assert.match(
      src,
      /from ['"]\.\/lib\/task-ledger-resolution\.mjs['"]/,
      'lint must import lib/task-ledger-resolution.mjs'
    );
    assert.match(
      src,
      /resolveExecutableTaskLedgerCarrier/,
      'lint must select carrier via resolveExecutableTaskLedgerCarrier'
    );
    // Local mini/tasks join+exists policy must not remain as the selection path.
    assert.ok(
      !/Prefer proposal-mini\.md \(B-mini carries tasks inline\); fall back to tasks\.md/.test(src),
      'lint must not keep the local Prefer proposal-mini.md policy comment as the selection path'
    );
  });
});

// ── T4: SSOT public API ─────────────────────────────────────────────────────

describe('task-ledger-resolution SSOT API', async () => {
  // Dynamic import so T1's "file exists" can fail first without cascading
  // ERR_MODULE_NOT_FOUND into every API test when the module is absent.
  if (!existsSync(SSOT_PATH)) {
    test('SSOT API tests skipped until module exists', { skip: 'SSOT module not yet created' }, () => {});
    return;
  }

  const {
    TASK_LEDGER_CARRIER_CANDIDATES,
    DEFAULT_PROVE_IT_RE,
    resolveExecutableTaskLedgerCarrier,
    listExistingTaskLedgerCarriers,
    findProveItInTaskLedgerCarriers,
  } = await import('../lib/task-ledger-resolution.mjs');

  test('exports frozen candidate list proposal-mini.md then tasks.md', () => {
    assert.deepEqual([...TASK_LEDGER_CARRIER_CANDIDATES], ['proposal-mini.md', 'tasks.md']);
    assert.ok(Object.isFrozen(TASK_LEDGER_CARRIER_CANDIDATES));
  });

  test('exports DEFAULT_PROVE_IT_RE matching accepted markers', () => {
    assert.ok(DEFAULT_PROVE_IT_RE.test('prove-it'));
    assert.ok(DEFAULT_PROVE_IT_RE.test('prove it'));
    assert.ok(DEFAULT_PROVE_IT_RE.test('failing test'));
    assert.ok(DEFAULT_PROVE_IT_RE.test('重現這個bug'));
    assert.ok(!DEFAULT_PROVE_IT_RE.test('no marker here'));
  });

  test('resolveExecutableTaskLedgerCarrier returns null when no carrier exists', () => {
    const dir = mkChangeDir();
    try {
      assert.equal(resolveExecutableTaskLedgerCarrier(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resolveExecutableTaskLedgerCarrier returns single existing carrier', () => {
    const dir = mkChangeDir();
    try {
      writeFileSync(join(dir, 'tasks.md'), '## Tasks\n', 'utf8');
      const resolved = resolveExecutableTaskLedgerCarrier(dir);
      assert.equal(resolved.filename, 'tasks.md');
      assert.equal(resolved.absolutePath, join(dir, 'tasks.md'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resolveExecutableTaskLedgerCarrier prefers proposal-mini.md when both exist', () => {
    const dir = mkChangeDir();
    try {
      writeFileSync(join(dir, 'proposal-mini.md'), '## Tasks\nmini\n', 'utf8');
      writeFileSync(join(dir, 'tasks.md'), '## Tasks\ntasks\n', 'utf8');
      const resolved = resolveExecutableTaskLedgerCarrier(dir);
      assert.equal(resolved.filename, 'proposal-mini.md');
      const listed = listExistingTaskLedgerCarriers(dir);
      assert.deepEqual(
        listed.map((c) => c.filename),
        ['proposal-mini.md', 'tasks.md']
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('findProveItInTaskLedgerCarriers: no-carrier', () => {
    const dir = mkChangeDir();
    try {
      const r = findProveItInTaskLedgerCarriers(dir);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'no-carrier');
      assert.equal(r.matchedFilename, null);
      assert.deepEqual(r.carriersChecked, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('findProveItInTaskLedgerCarriers: no-marker when carriers lack prove-it', () => {
    const dir = mkChangeDir();
    try {
      writeFileSync(join(dir, 'proposal-mini.md'), '## Tasks\n- [x] fix only\n', 'utf8');
      writeFileSync(join(dir, 'tasks.md'), '## Tasks\n- [x] also fix only\n', 'utf8');
      const r = findProveItInTaskLedgerCarriers(dir);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'no-marker');
      assert.equal(r.matchedFilename, null);
      assert.deepEqual(r.carriersChecked, ['proposal-mini.md', 'tasks.md']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('findProveItInTaskLedgerCarriers: any-marker matches second carrier', () => {
    const dir = mkChangeDir();
    try {
      writeFileSync(join(dir, 'proposal-mini.md'), '## Tasks\n- [x] stale mini without marker\n', 'utf8');
      writeFileSync(
        join(dir, 'tasks.md'),
        '## Tasks\n- [x] [Req: R1] T1 — prove-it: write failing test\n',
        'utf8'
      );
      const r = findProveItInTaskLedgerCarriers(dir);
      assert.equal(r.ok, true);
      assert.equal(r.reason, 'matched');
      assert.equal(r.matchedFilename, 'tasks.md');
      assert.deepEqual(r.carriersChecked, ['proposal-mini.md', 'tasks.md']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('findProveItInTaskLedgerCarriers: matched on ordered-first carrier alone', () => {
    const dir = mkChangeDir();
    try {
      writeFileSync(
        join(dir, 'proposal-mini.md'),
        '## Tasks\n- [x] prove-it: failing test first\n',
        'utf8'
      );
      const r = findProveItInTaskLedgerCarriers(dir);
      assert.equal(r.ok, true);
      assert.equal(r.reason, 'matched');
      assert.equal(r.matchedFilename, 'proposal-mini.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
