import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { repoPath } from "./lib/repo-root.mjs";
import { readRepoFile } from "./lib/read.mjs";
const retiredPath = ".gh" + "-body";

const activeFiles = [
  ".gitignore",
  "AGENTS.md",
  ".devpro/agent-rules/file-write-destinations.md",
  ".devpro/agent-rules/git-pr-template-and-merge.md",
  ".devpro/agent-rules/gitignore-alignment.md",
  ".devpro/agent-rules/platform-adapters/codex.md",
  ".devpro/agent-rules/platform-adapters/claude-code-cross-review.md",
  ".devpro/agent-rules/platform-adapters/codex-host-cross-review.md",
  ".devpro/scripts/hooks/gh-footer-gate.mjs",
  ".devpro/scripts/hooks/pre-tool-gate.mjs",
  ".devpro/scripts/tests/hook-pre-tool-gate-worktree-mandatory.test.mjs",
  ".devpro/scripts/tests/hook-gh-footer-gate.test.mjs",
  "openspec/specs/pre-tool-mechanical-gates/spec.md",
  "openspec/specs/cross-runtime-parity/spec.md",
  "openspec/specs/output-discipline/spec.md",
  "openspec/specs/openspec-flow/spec.md",
];

test("retired GitHub body directory path is absent from active carriers", () => {
  const hits = activeFiles.filter((relativePath) => readRepoFile(relativePath).includes(retiredPath));
  assert.deepEqual(hits, []);
});

test("gitignore baseline does not reintroduce retired body directory", () => {
  for (const relativePath of [".gitignore", ".devpro/agent-rules/gitignore-alignment.md"]) {
    assert.equal(readRepoFile(relativePath).includes(`${retiredPath}/`), false, relativePath);
  }
});

test("repo root has no retired body directory", () => {
  assert.equal(existsSync(repoPath(retiredPath)), false);
});

test("TL gh body happy paths use collision-resistant notes/tmp carriers", () => {
  const positiveRecipeFiles = [
    ".devpro/agent-rules/ai-autonomy.md",
    ".devpro/agent-rules/file-write-destinations.md",
    ".devpro/agent-rules/git-branch-and-pr-flow.md",
    ".devpro/agent-rules/git-pr-template-and-merge.md",
    ".devpro/scripts/hooks/gh-footer-gate.mjs",
    ".devpro/scripts/hooks/pre-tool-gate.mjs",
    ".devpro/scripts/tests/hook-gh-footer-gate.test.mjs",
    "openspec/specs/pre-tool-mechanical-gates/spec.md",
    "openspec/specs/output-discipline/spec.md",
    "openspec/specs/openspec-flow/spec.md",
    ".devpro/agent-rules/platform-adapters/codex.md",
    ".devpro/agent-rules/platform-adapters/codex-github-writes.md",
  ];
  const retiredPositiveShapes = [
    "gh pr create --body-file <worktree>/.pr-body.md",
    "gh pr create --body-file .pr-body.md",
    "<repo-root>/notes/tmp/<name>.md",
    "<main-checkout-root>/notes/tmp/<name>.md",
    "notes/tmp/<name>.md",
    "<repo-root>/notes/tmp/pr-body.md",
    "<main-checkout>/notes/tmp/pr-body.md",
    "`notes/tmp/pr-body.md`",
    "hook-visible worktree-internal body file",
    "inside the target worktree before dispatch",
    "worktree-internal body file path",
    "body 檔放當下 worktree cwd 用相對檔名",
  ];
  const fixedPrBodyPathJoin = /path\.join\([^)]*"notes"[^)]*"tmp"[^)]*"pr-body\.md"/;

  for (const relativePath of positiveRecipeFiles) {
    const content = readRepoFile(relativePath);
    for (const shape of retiredPositiveShapes) {
      assert.equal(content.includes(shape), false, `${relativePath} reintroduced ${shape}`);
    }
    assert.equal(fixedPrBodyPathJoin.test(content), false, `${relativePath} reintroduced path.join(... "notes", "tmp", "pr-body.md")`);
  }

  assert.match(readRepoFile(".devpro/agent-rules/ai-autonomy.md"), /gh `--body-file`[^\n]*`file-write-destinations\.md`[^\n]*字面絕對路徑/);
  assert.match(readRepoFile(".devpro/agent-rules/file-write-destinations.md"), /collision-resistant/);
  assert.match(readRepoFile(".devpro/agent-rules/git-pr-template-and-merge.md"), /collision-resistant suffix/);
  assert.match(readRepoFile(".devpro/agent-rules/git-branch-and-pr-flow.md"), /notes\/tmp\/<purpose>-<unique>\.md/);
  assert.match(readRepoFile(".devpro/agent-rules/git-branch-and-pr-flow.md"), /successful `gh` write/);
  assert.match(readRepoFile(".devpro/agent-rules/platform-adapters/codex-github-writes.md"), /basename includes purpose plus session\/timestamp\/PID\/random entropy/);
  assert.match(readRepoFile(".devpro/scripts/hooks/gh-footer-gate.mjs"), /notes\/tmp\/<purpose>-<unique>\.md/);
  assert.match(readRepoFile("openspec/specs/pre-tool-mechanical-gates/spec.md"), /change name alone is not enough/);
  assert.match(readRepoFile("openspec/specs/output-discipline/spec.md"), /notes\/tmp\/remove-gh-body-pr-body-<unique>\.md/);
  assert.match(readRepoFile(".devpro/agent-rules/file-write-destinations.md"), /MUST immediately delete the body file/);
  assert.match(readRepoFile(".devpro/agent-rules/git-pr-template-and-merge.md"), /MUST 立即刪除該 body file/);
  assert.match(readRepoFile("openspec/specs/openspec-flow/spec.md"), /notes\/tmp\/<purpose>-<unique>\.md/);
  assert.match(readRepoFile("openspec/specs/openspec-flow/spec.md"), /fixed names such as `pr-body\.md` are not sufficient/);
  assert.match(readRepoFile("openspec/specs/openspec-flow/spec.md"), /MUST immediately remove the temporary body file/);
});

test("gh-footer diagnostics keep TL body staging in main-checkout notes/tmp and route reviewer sticky staging out of the repo", () => {
  const content = readRepoFile(".devpro/scripts/hooks/gh-footer-gate.mjs");
  // TL-authored body staging is unchanged by issue #1735: it still lands in main-checkout notes/tmp.
  assert.match(content, /notes\/tmp\/<purpose>-<unique>\.md/);
  // issue #1735 regression fence: the diagnostic must no longer send reviewer sticky bodies into
  // the shared main-checkout tree, and must say so explicitly rather than staying silent.
  assert.doesNotMatch(content, /notes\/tmp\/\.cross-model-sticky-\*\.md/);
  assert.match(content, /reviewer sticky body 不走這條路/);
  assert.match(content, /neutral cwd/);
  assert.equal(content.includes("/tmp 僅保留給 documented reviewer sticky staging"), false);
  assert.equal(content.includes("/tmp only for documented reviewer sticky staging"), false);
});
