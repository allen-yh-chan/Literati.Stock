import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";



function archivedOrActiveEvaluationPath() {
  const active = "openspec/changes/add-reusable-skill-evaluation/skill-evaluation.md";
  if (existsSync(repoPath(active))) return active;

  const archiveRoot = repoPath("openspec/changes/archive");
  const match = readdirSync(archiveRoot)
    .filter((entry) => entry.endsWith("-add-reusable-skill-evaluation"))
    .sort()
    .at(-1);
  assert.ok(match, "archived add-reusable-skill-evaluation change missing");
  return `openspec/changes/archive/${match}/skill-evaluation.md`;
}

test("reusable skill evaluation covers all primary candidates", () => {
  const evaluation = read(archivedOrActiveEvaluationPath());
  for (const phrase of [
    "Root-cause debugging",
    "TDD RED quality",
    "Pre-commit / deep review",
    "Spike workflow",
    "Spec interview",
    "Prime / cold-start",
    "Reference knowledge digest",
    "Direct Copy Exclusions",
  ]) {
    assert.match(evaluation, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("adopted rule anchors are present", () => {
  assert.match(read(".devpro/agent-rules/troubleshooting.md"), /Root-Cause Debugging 6 步/);
  assert.match(read(".devpro/agent-rules/troubleshooting.md"), /Debug Report/);
  assert.match(read(".devpro/agent-rules/testing-and-qa.md"), /RED Evidence Quality/);
  assert.match(read(".devpro/agent-rules/testing-and-qa.md"), /Spike Workflow/);
  assert.match(read(".devpro/agent-rules/code-review-checklist.md"), /Local Deep Review/);
  assert.match(read(".devpro/agent-rules/ambiguity-scoring.md"), /Spec-Interview Lens/);
  assert.match(read(".devpro/agent-rules/observability-capabilities.md"), /Bounded Prime \/ Cold-Start Context/);
  assert.match(read(".devpro/agent-rules/knowledge-digest.md"), /Knowledge Digest/);
  assert.match(read("AGENTS.md"), /knowledge-digest\.md/);
  assert.match(read("README.md"), /knowledge-digest\.md/);
});

// Runtime skill discovery dirs (.claude/skills, .agents/skills) may exist for
// cross-platform discovery, but design D3 (refactor-agent-skills-entry)
// collapses discovery to a single `devpro` entry per root, resolving to the
// catalog root itself — never a per-skill link, and never independent
// (non-symlink) skill content. Root skills/ and local knowledge stores
// (.omx/*) remain hard-forbidden. .cursor/skills was retired as a managed
// discovery root (design D1 of remove-cursor-skill-discovery) and MUST NOT
// exist in source at all — see assertNoCursorSkillDiscoveryRoot() below
// (Runtime-Specific Skill Copy Exclusion absence contract).
function assertSkillDiscoveryDirIsSymlinksOnly(dirRelPath) {
  const dirAbs = repoPath(dirRelPath);
  if (!existsSync(dirAbs)) return;
  const sourceRootAbs = path.join(REPO_ROOT, ".devpro", "agent-skills");
  assert.deepEqual(
    readdirSync(dirAbs),
    ["devpro"],
    `${dirRelPath} must hold only the 'devpro' entry, not a per-skill link`
  );
  const entryAbs = path.join(dirAbs, "devpro");
  assert.equal(lstatSync(entryAbs).isSymbolicLink(), true, `${dirRelPath}/devpro must be a symlink`);
  assert.equal(
    realpathSync(entryAbs),
    realpathSync(sourceRootAbs),
    `${dirRelPath}/devpro must resolve to the catalog root itself`
  );
}

// Absence contract (design D6): unlike assertSkillDiscoveryDirIsSymlinksOnly()
// above (which tolerates absence and only constrains any *existing* entry),
// .cursor/skills itself MUST NOT exist in source at all, regardless of node
// type — a plain file, a plain directory, or a symlink left behind by a
// regression are all failures. lstat (not existsSync) so a dangling symlink
// node is still caught.
function assertNoCursorSkillDiscoveryRoot() {
  let stat;
  try {
    stat = lstatSync(repoPath(".cursor/skills"));
  } catch {
    return;
  }
  const nodeType = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file";
  assert.fail(
    `.cursor/skills must not exist in source — it was retired as a managed discovery root (design D1 of remove-cursor-skill-discovery); found a ${nodeType} node`
  );
}

test("runtime-specific skill directories hold only symlinks into source", () => {
  assertSkillDiscoveryDirIsSymlinksOnly(".claude/skills");
  assertNoCursorSkillDiscoveryRoot();
  assert.equal(existsSync(repoPath("skills")), false);
  assert.equal(existsSync(repoPath(".omx/wiki")), false);
  assert.equal(existsSync(repoPath(".omx/notepad.md")), false);
});
