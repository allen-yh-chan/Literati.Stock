import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";



const gitBranchNaming = read(".devpro/agent-rules/git-branch-naming-and-anchor.md");
const gitBranchFlow = read(".devpro/agent-rules/git-branch-and-pr-flow.md");
const openspecStep = read(".devpro/agent-rules/openspec-step-1-to-9.md");
// de-bundle (refactor-ai-autonomy-debundle): §Common Rationalizations (with the
// git-startup-sync rationalization row) moved from ai-autonomy.md to this sibling
const aiAutonomyRationalizations = read(".devpro/agent-rules/ai-autonomy-rationalizations.md");
const dpChangeCommand = read(".devpro/agent-skills/devpro-workflows/change/SKILL.md");
const codexAdapter = read(".devpro/agent-rules/platform-adapters/codex.md");
const sessionRecap = read(".devpro/agent-rules/session-recap.md");
const preToolGate = read(".devpro/scripts/hooks/pre-tool-gate.mjs");
const hookTests = read(".devpro/scripts/tests/hook-pre-tool-gate.test.mjs");
const recapHookTests = read(".devpro/scripts/tests/hook-pre-tool-gate-recap-body-gate.test.mjs");
const codexGithubWrites = read(".devpro/agent-rules/platform-adapters/codex-github-writes.md");
const cursorAdapter = read(".devpro/agent-rules/platform-adapters/cursor.md");
const workflowsSkill = read(".devpro/agent-skills/devpro-workflows/workflows/SKILL.md");
const canonicalGates = read("openspec/specs/pre-tool-mechanical-gates/spec.md");
const canonicalOpenspecFlow = read("openspec/specs/openspec-flow/spec.md");
const canonicalParity = read("openspec/specs/cross-runtime-parity/spec.md");
const claudeAdapter = read(".devpro/agent-rules/platform-adapters/claude-code.md");
const opencodeAdapter = read(".devpro/agent-rules/platform-adapters/opencode.md");
const prePrArchiveReference = read(".devpro/agent-skills/devpro-workflows/pre-pr/references/full-review-and-archive.md");

test("git startup sync avoids fetching into a checked-out local main ref", () => {
  assert.match(gitBranchNaming, /git fetch origin --tags/);
  assert.match(gitBranchNaming, /\*\*禁用\*\* `git fetch origin main:main --tags`/);
  assert.match(gitBranchNaming, /fetch into checked-out branch/);
  assert.match(gitBranchNaming, /git pull --ff-only/);
  assert.match(gitBranchFlow, /git fetch origin --tags/);
  assert.match(gitBranchFlow, /避免 fetch into checked-out `main`/);
  assert.match(openspecStep, /git fetch origin --tags/);
  assert.match(openspecStep, /不寫 checked-out local branch ref/);
  assert.match(aiAutonomyRationalizations, /git fetch origin --tags/);
  assert.match(dpChangeCommand, /git fetch origin --tags/);
  assert.match(dpChangeCommand, /checked-out local `main` ref/);
});

test("Codex protected-branch guidance distinguishes tool workdir from hook-visible cwd", () => {
  for (const phrase of [
    "functions.exec_command.workdir",
    "PreToolUse payload",
    "命令字串本身",
    "fallback-only evidence",
    "git -C <abs-worktree>",
  ]) {
    assert.match(codexAdapter, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(hookTests, /fallback-only hook cwd on main \+ plain git add/);
  assert.match(hookTests, /payload cwd confirming main \+ git add/);
  assert.match(hookTests, /git -C <worktree> add from hook cwd main/);
  assert.match(codexAdapter, /\| Protected-branch git write inside Codex worktree \|[^|\n]*command string itself carry worktree evidence:[^|\n]*`git -C <abs-worktree> \.\.\.`[^|\n]*separate Bash calls/);
  assert.doesNotMatch(codexAdapter, /cd <abs-worktree> && git/);
  assert.match(codexAdapter, /單靠 tool `workdir` 不視為等價/);
});

// fix-protected-branch-gate-payload-cwd R2/R8: the dual recommendation
// (`git -C ...` or `cd <abs-worktree> && git ...`) is gone from every live
// carrier; only the single `git -C <abs-worktree>` git-write form survives.
test("protected-branch git-write guidance keeps the single `git -C <abs-worktree>` form", () => {
  const carriers = [
    [".devpro/scripts/hooks/pre-tool-gate.mjs", preToolGate],
    [".devpro/agent-rules/git-branch-naming-and-anchor.md", gitBranchNaming],
    [".devpro/agent-rules/platform-adapters/codex.md", codexAdapter],
    [".devpro/agent-rules/platform-adapters/codex-github-writes.md", codexGithubWrites],
    [".devpro/agent-rules/platform-adapters/cursor.md", cursorAdapter],
    [".devpro/agent-skills/devpro-workflows/workflows/SKILL.md", workflowsSkill],
    ["openspec/specs/pre-tool-mechanical-gates/spec.md", canonicalGates],
    ["openspec/specs/openspec-flow/spec.md", canonicalOpenspecFlow],
    ["openspec/specs/cross-runtime-parity/spec.md", canonicalParity],
    [".devpro/agent-rules/platform-adapters/claude-code.md", claudeAdapter],
    [".devpro/agent-rules/platform-adapters/opencode.md", opencodeAdapter],
    [".devpro/agent-skills/devpro-workflows/pre-pr/references/full-review-and-archive.md", prePrArchiveReference],
  ];
  for (const [label, text] of carriers) {
    assert.doesNotMatch(
      text,
      /cd <abs-worktree> && git/,
      `${label} must not recommend a cd-prefixed git write form`
    );
    assert.match(
      text,
      /git -C <abs-worktree>/,
      `${label} must carry the single \`git -C <abs-worktree>\` git-write form`
    );
  }
  // Remediation-advice carriers only: the canonical specs legitimately DESCRIBE both
  // mechanisms (resolver behaviour), so a bare dual-form phrase there is not advice.
  const adviceCarriers = carriers.filter(([label]) => !label.startsWith("openspec/specs/"));
  for (const [label, text] of adviceCarriers) {
    assert.doesNotMatch(
      text,
      /`git -C`\s*(?:或|or|\/)\s*(?:explicit\s+)?`cd`/i,
      `${label} must not keep a dual git-write form (git -C or cd) as remediation advice`
    );
  }
});

// fix-pre-pr-archive-commit-example: a copy-execute example that chains `git add` and `git commit` in one
// Bash call makes the commit-time EOF re-stage gate fall back to checked=false, contradicting the adapters'
// "add and commit MUST be separate Bash calls" obligation.
test("pre-pr archive example commits with git add and git commit as separate calls", () => {
  assert.doesNotMatch(prePrArchiveReference, /git\b[^\n`]*\badd\b[^\n`]*(?:&&|;)[^\n`]*\bgit\b[^\n`]*\bcommit\b/);
  assert.match(prePrArchiveReference, /^git -C <abs-worktree> add openspec\/$/m);
  assert.match(prePrArchiveReference, /^git -C <abs-worktree> commit -m "chore: archive <name> & promote canonical specs"$/m);
  assert.match(prePrArchiveReference, /`git add` 與 `git commit` MUST 分兩次 Bash 呼叫/);
});

test("Session Recap discussion writes prefer gh @file body without command substitution", () => {
  assert.match(sessionRecap, /-F body=@<repo-root>\/notes\/tmp\/recap-<change>-<unique>\.md/);
  // The change name alone is not a collision-resistant basename (file-write-destinations.md).
  assert.doesNotMatch(sessionRecap, /recap-<change>\.md/);
  assert.match(sessionRecap, /`<unique>` MUST 是 collision-resistant 後綴/);
  assert.match(sessionRecap, /為什麼用 `-F body=@<file>`/);
  assert.match(sessionRecap, /command substitution/);
  assert.match(sessionRecap, /non-sandbox \/ host-runner `gh api`/);
  assert.match(preToolGate, /preferred `body=@<file>`/);
  assert.match(recapHookTests, /case 15c \(PASS\): -F body=@<valid-file>/);
});
