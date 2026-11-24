/**
 * fix-codex-spawn-admission-bypass T6: seams fingerprint + non-goal lock.
 * Locks `no-ticket-ordinary-all-hosts-v3` in skill/change carriers and asserts
 * changed skill files do not authorize broker / Task-mint / discard-six-axis
 * as success criteria.
 *
 * Change artifacts resolve active `openspec/changes/<name>/` when present,
 * else the latest matching `openspec/changes/archive/*-<name>/` so the suite
 * survives `openspec archive`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { readPrePrSkillFullReadingOrder } from "./lib/pre-pr-skill.mjs";

const SEAMS = "no-ticket-ordinary-all-hosts-v3";
const CHANGE_NAME = "fix-codex-spawn-admission-bypass";
const SKILL = ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md";
const DISPATCH =
  ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md";

/** Phrases that must not appear as authorizing success criteria in skill files. */
const NEGATIVE_DONE = [
  "host-universal ticket broker",
  "Cursor Task 必須能產票才算修好",
  "缺票就丟六軸",
  "Task 必須產票才算修好",
];

/**
 * Active change dir if present; otherwise latest dated archive match.
 * Mirrors durable post-archive resolution used by other grep locks.
 */
function resolveChangeArtifactDir(changeName) {
  const activeRel = `openspec/changes/${changeName}`;
  if (existsSync(repoPath(activeRel))) return activeRel;

  const archiveRoot = repoPath("openspec/changes/archive");
  assert.ok(existsSync(archiveRoot), "openspec/changes/archive missing");
  const match = readdirSync(archiveRoot)
    .filter((entry) => /^\d{4}-\d{2}-\d{2}-/u.test(entry) && entry.slice(11) === changeName)
    .sort()
    .at(-1);
  assert.ok(match, `active or archived change directory missing for ${changeName}`);
  return `openspec/changes/archive/${match}`;
}

test("seams fingerprint appears in skill and change artifacts", () => {
  // Step 3 body lives in references/full-review-and-archive.md; read the full-rigor reading order.
  const skill = readPrePrSkillFullReadingOrder();
  const dispatch = readFileSync(repoPath(DISPATCH), "utf8");
  assert.ok(skill.includes(SEAMS), `${SKILL} missing ${SEAMS}`);
  assert.ok(dispatch.includes(SEAMS), `${DISPATCH} missing ${SEAMS}`);
  assert.match(skill, /ordinary／advisory|ordinary\/advisory/);
  assert.match(skill, /MUST NOT[\s\S]{0,80}丟棄 findings／六軸|不得丟棄 findings／六軸/);

  const changeDir = resolveChangeArtifactDir(CHANGE_NAME);
  const meeting = readFileSync(repoPath(`${changeDir}/meeting-notes.md`), "utf8");
  const proposal = readFileSync(repoPath(`${changeDir}/proposal.md`), "utf8");
  assert.ok(meeting.includes(SEAMS), `${changeDir}/meeting-notes.md missing seams`);
  assert.ok(proposal.includes(SEAMS), `${changeDir}/proposal.md missing seams`);
});

test("changed skill files omit negative done phrases authorizing broker/Task-mint/discard", () => {
  for (const rel of [SKILL, DISPATCH]) {
    const content = readFileSync(repoPath(rel), "utf8");
    for (const phrase of NEGATIVE_DONE) {
      assert.equal(
        content.includes(phrase),
        false,
        `${rel} must not authorize success via ${JSON.stringify(phrase)}`,
      );
    }
  }
});

/**
 * Change-scoped QA evidence only: runs while the active change folder exists.
 * MUST NOT remain a permanent post-merge ambient prohibition on
 * `origin/main...HEAD` (archive removes the gate; seams/negative-done stay).
 */
test("active-change QA: three-dot diff does not touch answer-bag product paths", { skip: !existsSync(repoPath(`openspec/changes/${CHANGE_NAME}`)) }, () => {
  const out = execFileSync(
    "git",
    ["diff", "origin/main...HEAD", "--name-only"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  const hits = out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => /(^|\/)answer-bag(\/|$)/.test(path));
  assert.deepEqual(hits, [], `answer-bag product paths in diff: ${hits.join(", ")}`);
});

test("change artifact resolver prefers active then latest archive match", () => {
  const activeRel = `openspec/changes/${CHANGE_NAME}`;
  if (existsSync(repoPath(activeRel))) {
    assert.equal(resolveChangeArtifactDir(CHANGE_NAME), activeRel);
  } else {
    const resolved = resolveChangeArtifactDir(CHANGE_NAME);
    assert.match(resolved, new RegExp(`^openspec/changes/archive/\\d{4}-\\d{2}-\\d{2}-${CHANGE_NAME}$`));
    assert.ok(existsSync(repoPath(`${resolved}/meeting-notes.md`)));
    assert.ok(existsSync(repoPath(`${resolved}/proposal.md`)));
  }
});
