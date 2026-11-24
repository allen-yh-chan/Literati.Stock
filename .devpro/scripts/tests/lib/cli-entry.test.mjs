/**
 * cli-entry.test.mjs
 *
 * Integration tests for symlink-safe direct CLI invocation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDirectCliInvocation } from '../../lib/cli-entry.mjs';

const libPath = fileURLToPath(new URL('../../lib/cli-entry.mjs', import.meta.url));

function fixtureSource() {
  return [
    'import { isDirectCliInvocation } from ' + JSON.stringify(pathToFileURL(libPath).href) + ';',
    'const direct = isDirectCliInvocation(import.meta.url);',
    "process.stdout.write(direct ? 'direct' : 'imported');",
    'process.exit(direct ? 0 : 3);',
    '',
  ].join('\n');
}

test('isDirectCliInvocation is true for a spawned file and its symlink', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cli-entry-'));
  try {
    const fixture = path.join(dir, 'fixture.mjs');
    const link = path.join(dir, 'alias.mjs');
    writeFileSync(fixture, fixtureSource());
    symlinkSync(fixture, link);

    const direct = spawnSync(process.execPath, [fixture], { encoding: 'utf8' });
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(direct.stdout, 'direct');

    const viaLink = spawnSync(process.execPath, [link], { encoding: 'utf8' });
    assert.equal(viaLink.status, 0, viaLink.stderr);
    assert.equal(viaLink.stdout, 'direct');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isDirectCliInvocation is false when the module is imported', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cli-entry-import-'));
  try {
    const fixture = path.join(dir, 'fixture.mjs');
    const importer = path.join(dir, 'importer.mjs');
    writeFileSync(fixture, fixtureSource());
    writeFileSync(
      importer,
      `import ${JSON.stringify(pathToFileURL(fixture).href)};\n`,
    );

    const imported = spawnSync(process.execPath, [importer], { encoding: 'utf8' });
    assert.equal(imported.status, 3, imported.stderr);
    assert.equal(imported.stdout, 'imported');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isDirectCliInvocation returns false when argv[1] is missing', () => {
  const original = process.argv[1];
  try {
    process.argv[1] = undefined;
    assert.equal(isDirectCliInvocation(import.meta.url), false);
  } finally {
    process.argv[1] = original;
  }
});
