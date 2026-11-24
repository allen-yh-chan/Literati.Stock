import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, repoPath } from './lib/repo-root.mjs';

const agentRulesDir = repoPath('.devpro/agent-rules');
const dpCommandsDir = repoPath('.claude/commands/dp');

// KNOWN GAPS: covers Pattern A only (`<file>.md`「<phrase>」 with backtick).
// Pattern B (見 <file>.md「<phrase>」 without backtick) intentionally not covered:
// regex risk of natural-language false positives. Manual sweep + future PR if needed.
const CROSS_REF_RE = /`([a-z][a-z0-9-]*\.md)`「([^」]+)」/g;

function resolveTarget(filename) {
  const a = path.join(agentRulesDir, filename);
  const b = path.join(dpCommandsDir, filename);
  try { readFileSync(a); return a; } catch (_) {}
  try { readFileSync(b); return b; } catch (_) {}
  return null;
}

function collectSources() {
  const dirs = [agentRulesDir, dpCommandsDir];
  return dirs.flatMap(dir =>
    existsSync(dir)
      ? readdirSync(dir).filter(f => f.endsWith('.md')).map(f => path.join(dir, f))
      : []
  );
}

for (const srcPath of collectSources()) {
  const srcBase = path.basename(srcPath);
  const content = readFileSync(srcPath, 'utf8');
  const srcRel = srcPath.replace(REPO_ROOT + '/', '');
  for (const [, filename, phrase] of content.matchAll(CROSS_REF_RE)) {
    if (filename === srcBase) continue; // skip self-ref
    test(`${srcRel} ref to ${filename}「${phrase}」 — phrase exists`, () => {
      const targetPath = resolveTarget(filename);
      assert.ok(targetPath, `target file not found: ${filename}`);
      const targetContent = readFileSync(targetPath, 'utf8');
      assert.ok(
        targetContent.includes(phrase),
        `${filename} does not contain phrase: 「${phrase}」`
      );
    });
  }
}
