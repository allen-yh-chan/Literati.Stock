/**
 * pre-pr-spec-eof-disclosure-grep.test.mjs
 *
 * Prove-it / wording lock for #2339:
 * keep repo-wide `normalize-eof.mjs --fix`, but MUST NOT blindly
 * `git add openspec/specs/` after --fix. Out-of-three-dot-diff spec.md
 * changes MUST independent commit + PR-body disclosure.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { readSourceFile as read } from "./lib/read.mjs";
import { sourcePath } from "./lib/source-root.mjs";

const SKILL_SSOT = ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md";
const SKILL_COPIES = [
  SKILL_SSOT,
  ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md",
  ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md",
];

const STEP = ".devpro/agent-rules/openspec-step-1-to-9.md";

function specEofBlock(body) {
  const match = body.match(
    /\*\*Spec EOF 自動自癒\*\*[\s\S]*?(?=\n(?:\d+\. |\### ))/,
  );
  assert.ok(match, "devpro:pre-pr SKILL.md missing Spec EOF 自動自癒 block");
  return match[0];
}

function archiveEofBlock(body) {
  const match = body.match(
    /> \*\*Archive EOF checkpoint\*\*：[^\n]+/,
  );
  assert.ok(match, "openspec-step-1-to-9.md missing Archive EOF checkpoint");
  return match[0];
}

test("prove-it: skill must not blindly git add openspec/specs/ after --fix", () => {
  const eof = specEofBlock(read(SKILL_SSOT));
  assert.match(eof, /normalize-eof\.mjs --fix/);
  assert.doesNotMatch(
    eof,
    /git add openspec\/specs\//,
    "Spec EOF 自動自癒 still instructs git add openspec/specs/ after --fix",
  );
  assert.doesNotMatch(eof, /re-stage/);
});

test("skill requires independent commit and PR-body disclosure for out-of-diff specs", () => {
  const eof = specEofBlock(read(SKILL_SSOT));
  assert.match(eof, /獨立 commit/);
  assert.match(eof, /\.\.\.HEAD/);
  assert.match(eof, /PR body/);
  assert.match(eof, /originating commits/);
});

test("all devpro:pre-pr skill copies share SSOT wording", () => {
  const ssotAbs = realpathSync(sourcePath(SKILL_SSOT));
  const eof = specEofBlock(read(SKILL_SSOT));
  for (const rel of SKILL_COPIES) {
    const abs = realpathSync(sourcePath(rel));
    assert.equal(
      abs,
      ssotAbs,
      `${rel} must resolve to ${SKILL_SSOT} (symlink or same file)`,
    );
    assert.match(eof, /normalize-eof\.mjs --fix/);
  }
});

test("Archive EOF checkpoint does not contradict disclosure / independent-commit", () => {
  const checkpoint = archiveEofBlock(read(STEP));
  assert.match(checkpoint, /normalize-eof\.mjs/);
  assert.match(checkpoint, /獨立 commit/);
  assert.match(checkpoint, /\.\.\.HEAD|三點 diff/);
  assert.doesNotMatch(checkpoint, /git add openspec\/specs\//);
});
