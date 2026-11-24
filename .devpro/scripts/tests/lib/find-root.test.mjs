/**
 * find-root.test.mjs
 *
 * Integration tests for openspec vs consumer walk-up root criteria.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findConsumerRepoRoot, findOpenspecRepoRoot } from '../../lib/find-root.mjs';

function withTemp(prefix, fn) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('findOpenspecRepoRoot walks up until both openspec/ and .devpro/ exist', () => {
  withTemp('find-openspec-root-', (root) => {
    mkdirSync(path.join(root, 'openspec'));
    mkdirSync(path.join(root, '.devpro'));
    const nested = path.join(root, 'openspec', 'changes', 'demo');
    mkdirSync(nested, { recursive: true });
    assert.equal(findOpenspecRepoRoot(nested), path.resolve(root));
  });
});

test('findOpenspecRepoRoot falls back to path.resolve(start) when markers are absent', () => {
  withTemp('find-openspec-fallback-', (root) => {
    const start = path.join(root, 'no-markers');
    mkdirSync(start);
    assert.equal(findOpenspecRepoRoot(start), path.resolve(start));
  });
});

test('findConsumerRepoRoot accepts AGENTS.md, submodule AGENTS.md, or .git', () => {
  withTemp('find-consumer-agents-', (root) => {
    writeFileSync(path.join(root, 'AGENTS.md'), '# agents\n');
    const nested = path.join(root, 'src', 'app');
    mkdirSync(nested, { recursive: true });
    assert.equal(findConsumerRepoRoot(nested), path.resolve(root));
  });

  withTemp('find-consumer-submodule-', (root) => {
    mkdirSync(path.join(root, '.devpro-agent-rules'), { recursive: true });
    writeFileSync(path.join(root, '.devpro-agent-rules', 'AGENTS.md'), '# agents\n');
    const nested = path.join(root, 'pkg');
    mkdirSync(nested);
    assert.equal(findConsumerRepoRoot(nested), path.resolve(root));
  });

  withTemp('find-consumer-git-', (root) => {
    mkdirSync(path.join(root, '.git'));
    const nested = path.join(root, 'lib');
    mkdirSync(nested);
    assert.equal(findConsumerRepoRoot(nested), path.resolve(root));
  });
});

test('findConsumerRepoRoot last-resort is path.resolve(start)', () => {
  withTemp('find-consumer-fallback-', (root) => {
    const start = path.join(root, 'orphan');
    mkdirSync(start);
    assert.equal(findConsumerRepoRoot(start), path.resolve(start));
  });
});
