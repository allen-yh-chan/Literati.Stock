/**
 * bootstrap-first-run-blockers-grep.test.mjs
 *
 * Prove-it / drift locks for fix-bootstrap-first-run-blockers (G1):
 *   R1/R2 — README Step 1 `.worktree/` carve-out; no delete/stash live worktree as required fix
 *   R3    — README Step 6 must not hardcode obsolete `git add` path list; managed set covers
 *           `.agents` / `.opencode` / `.gitattributes`
 *   R7    — README MUST ban AI coauthor brand trailer before sync
 *
 * Parity invariant: keep (listSyncCommitPaths is export-only; STATIC_FILES/SYNC_DIRS membership unchanged).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";
import { listSyncCommitPaths, STATIC_FILES, SYNC_DIRS } from "../sync-agent-rules.mjs";

const OBSOLETE_HARDCODED_GIT_ADD =
  "git add .gitmodules .devpro-agent-rules CLAUDE.md AGENTS.md GEMINI.md .windsurfrules .claude/ .codex/ .cursor/ .devpro/ .github/ .gitignore";

function firstSetupSection(readme) {
  const start = readme.indexOf("### 首次導入");
  const end = readme.indexOf("### 每次開新對話");
  assert.ok(start >= 0 && end > start, "README first-setup section markers missing");
  return readme.slice(start, end);
}

test("README Step 1: .worktree/ clean-tree carve-out present; must not require delete/stash live worktree", () => {
  const section = firstSetupSection(read("README.md"));
  assert.match(section, /clean-tree carve-out:\s*\.worktree\//);
  assert.match(section, /\.worktree\//);
  assert.match(
    section,
    /不得.*(?:delete|stash|discard).*(?:活|registered).*worktree|不要求 delete\/stash/,
  );
  // Early-ignore指示（併用）：sync 前可確保 .worktree/ ignore
  assert.match(section, /early-ignore|可選.*\.worktree\/|確保.*\.worktree\//);
});

test("README Step 6: MUST NOT contain obsolete hardcoded git add path list", () => {
  const readme = read("README.md");
  assert.doesNotMatch(readme, new RegExp(OBSOLETE_HARDCODED_GIT_ADD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const section = firstSetupSection(readme);
  assert.match(section, /managed.?set|listSyncCommitPaths|STATIC_FILES|SYNC_DIRS/i);
  // F1 harden: pipefail + nonempty guard + direct NUL pipe (no shell-var capture of node stdout)
  assert.match(section, /set -euo pipefail/);
  assert.match(section, /listSyncCommitPaths returned empty|!p\.length/);
  assert.match(section, /bash strips NULs|never assign node stdout into a shell variable/i);
  assert.match(
    section,
    /node -e 'import\("\.\/\.devpro\/scripts\/sync-agent-rules\.mjs"\)\.then\(\(m\) => \{[\s\S]*?listSyncCommitPaths\(\)[\s\S]*?join\("\\0"\)[\s\S]*?\}\)' \| xargs -0 git add --/,
  );
});

test("listSyncCommitPaths managed set covers .agents / .opencode / .gitattributes / .claude/settings.json (Parity keep)", () => {
  const paths = listSyncCommitPaths();
  assert.ok(paths.includes(".agents"), "managed set must include .agents");
  assert.ok(paths.includes(".opencode"), "managed set must include .opencode");
  assert.ok(paths.includes(".gitattributes"), "managed set must include .gitattributes");
  assert.ok(
    paths.includes(".claude/settings.json"),
    "managed set must include .claude/settings.json (syncClaudeConfig wirefile)",
  );
  assert.ok(paths.includes(".gitmodules"));
  assert.ok(paths.includes(".devpro-agent-rules"));
  assert.ok(paths.includes("AGENTS.md"));
  assert.ok(paths.includes(".gitignore"));
  // F2: HOOK_JSON_CONFIGS outputs live under SYNC_DIRS (.codex / .cursor)
  assert.ok(paths.includes(".codex"), "managed set must cover HOOK_JSON .codex/");
  assert.ok(paths.includes(".cursor"), "managed set must cover HOOK_JSON .cursor/");
  // Parity keep: membership of STATIC_FILES / SYNC_DIRS unchanged by this helper
  assert.ok(STATIC_FILES.some((e) => e.relPath === "CLAUDE.md"));
  assert.ok(SYNC_DIRS.some((e) => e.relPath === ".agents"));
  assert.ok(SYNC_DIRS.some((e) => e.relPath === ".opencode"));
});

test("README Step 1: non-.worktree/ dirty still stops (carve-out is not arbitrary dirty)", () => {
  const section = firstSetupSection(read("README.md"));
  assert.match(section, /其餘 dirty 停下/);
});

test("release-rules-lane: first-rules-release verifies FIRST_BASE is ancestor of origin/main", () => {
  const lane = read(".devpro/agent-rules/release-rules-lane.md");
  assert.match(lane, /merge-base --is-ancestor "\$FIRST_BASE" origin\/main/);
  // Bash fence must use # comments; JS // is exit 126 under set -e (F-lane-bash-js-comment)
  const fenceStart = lane.indexOf("# Step 2：有 tag");
  const fenceEnd = lane.indexOf("# Step 3：從該 base");
  assert.ok(fenceStart >= 0 && fenceEnd > fenceStart, "first-rules-release Step 2/3 fence missing");
  const fence = lane.slice(fenceStart, fenceEnd);
  assert.equal(
    /(?:^|\n)\s*\/\//m.test(fence),
    false,
    "first-rules-release bash fence must not contain JS // comments",
  );
  assert.match(fence, /# MUST NOT use main \/ origin\/main as FIRST_BASE/);
});

test("README: MUST ban AI coauthor brand trailer before sync commit", () => {
  const section = firstSetupSection(read("README.md"));
  assert.match(section, /禁.*AI coauthor brand trailer|禁含.*AI.*coauthor|禁.*Co-Authored-By/i);
});

test("release-rules-lane: zero-tag path is not sole abort: no production-* tag", () => {
  const lane = read(".devpro/agent-rules/release-rules-lane.md");
  // Must document first-rules-release / production tip path; sole hard abort without carve-out is a fail
  assert.match(lane, /first-rules-release|FIRST_BASE/);
  assert.match(lane, /origin\/production|production tip/);
  // Scoped supersede: explicitly does NOT restore acknowledgement bypass
  assert.match(lane, /不.*恢復 acknowledgement bypass|MUST NOT restore acknowledgement bypass/i);
  // Must not be the sole Step 2 exit as hard abort without first-rules-release branch
  assert.doesNotMatch(
    lane,
    /# Step 2：無 tag 時 abort[\s\S]*?\[ -z "\$TAG" \] && \{ echo "abort: no production-\* tag"; exit 1; \}/,
  );
});
