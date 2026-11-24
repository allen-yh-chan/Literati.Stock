import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";



function literalRe(phrase) {
  return new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

const gitFlow = read(".devpro/agent-rules/git-branch-and-pr-flow.md");
const codexAdapter = read(".devpro/agent-rules/platform-adapters/codex.md");
const codexGithubWrites = read(".devpro/agent-rules/platform-adapters/codex-github-writes.md");
const prTemplate = read(".devpro/agent-rules/git-pr-template-and-merge.md");
const fileWriteDestinations = read(".devpro/agent-rules/file-write-destinations.md");
const outputDisciplineSpec = read("openspec/specs/output-discipline/spec.md");
const openspecFlowSpec = read("openspec/specs/openspec-flow/spec.md");

test("GitHub flow documents first-attempt notes/tmp main-checkout body-file pattern", () => {
  for (const phrase of [
    "GitHub write-back body pattern",
    "main checkout at `<repo-root>/notes/tmp/<purpose>-<unique>.md`",
    "change name alone or fixed names such as `pr-body.md` are not enough",
    "Rules: v<X.Y.Z> · Tool: <tool> · Model: <model>",
    "gh-footer-gate.mjs --strict-exit -- gh issue create --body-file <repo-root>/notes/tmp/<purpose>-<unique>.md",
    "Delete the temporary body file immediately after a successful `gh` write",
    "git status --short",
  ]) {
    assert.match(gitFlow, literalRe(phrase));
  }
});

test("GitHub flow rejects stdin and repo-external tmp for TL-authored bodies", () => {
  for (const phrase of [
    "do not use `--body-file -`",
    "heredoc stdin",
    "Do not use repo-external `/tmp` body files",
    // issue #1735: the retired wording was "renderer/validator-fixed family-specific
    // reachable staging", which read as a per-family staging *path*. One destination now.
    "Reviewer-owned sticky staging uses the renderer-owned per-dispatch neutral cwd for every reviewer family",
    "no recipe grants a main-checkout `<repo-root>/notes/tmp/` staging path",
  ]) {
    assert.match(gitFlow, literalRe(phrase));
  }
  assert.doesNotMatch(gitFlow, /family-specific reachable staging/);
});

test("Codex adapter carries the same TL body-file anti-patterns", () => {
  for (const phrase of [
    "First-attempt TL body pattern",
    "delete the temporary body file",
    "TL-authored GitHub bodies 不得用 `--body-file -`",
    "不得用 repo-external `/tmp` body file",
    // same retired wording, Codex adapter copy (issue #1735)
    "renderer 固定的 per-dispatch neutral cwd（全 family 一致、repo 外",
  ]) {
    assert.match(codexAdapter, literalRe(phrase));
  }
  assert.doesNotMatch(codexAdapter, /family-specific reachable staging/);
  assert.doesNotMatch(codexAdapter, /Codex main-checkout notes\/tmp/);
});

test("OpenSpec spec captures observable GitHub write-back body handling", () => {
  for (const phrase of [
    "GitHub Write-Back Body Uses Main-Checkout Notes Tmp File",
    "TL GitHub Write-Back Avoids Stdin And Repo-External Tmp Bodies",
    "MUST immediately remove the temporary body file",
    "MUST NOT use `--body-file -`",
    "MUST NOT use a repo-external `/tmp` body file",
  ]) {
    assert.match(openspecFlowSpec, literalRe(phrase));
  }
});

test("GitHub footer strict preflight is documented as validator-only", () => {
  const carriers = [
    [".devpro/agent-rules/git-branch-and-pr-flow.md", gitFlow],
    [".devpro/agent-rules/platform-adapters/codex.md", codexAdapter],
    [".devpro/agent-rules/platform-adapters/codex-github-writes.md", codexGithubWrites],
    [".devpro/agent-rules/git-pr-template-and-merge.md", prTemplate],
    [".devpro/agent-rules/file-write-destinations.md", fileWriteDestinations],
    ["openspec/specs/output-discipline/spec.md", outputDisciplineSpec],
  ];
  for (const [rel, content] of carriers) {
    for (const phrase of [
      "validator-only dry run",
      "never executes the nested `gh` command",
      "Exit `0` means validation passed only",
    ]) {
      assert.match(content, literalRe(phrase), rel);
    }
  }
  for (const phrase of [
    "MUST NOT be treated as a GitHub write",
    "MUST NOT manually insert this validator as an executor wrapper",
  ]) {
    assert.match(gitFlow, literalRe(phrase));
    assert.match(codexGithubWrites, literalRe(phrase));
    assert.match(outputDisciplineSpec, literalRe(phrase));
  }
  assert.match(
    read(".devpro/scripts/hooks/gh-footer-gate.mjs"),
    literalRe("gh-footer-gate strict preflight: validation passed only; validator did not execute `gh`")
  );
});

test("GitHub body ordinal hash-numbers avoid unrelated autolinks without weakening real references", () => {
  for (const phrase of [
    "gh body 序數防誤連結（cooperative-only）",
    "MUST 改寫為中文序數",
    "純序數 token 放入 code-span",
    "只有真正引用既有 issue/PR 時才保留裸文字 hash-number",
    "auto-close 關鍵字仍必須保持裸文字",
    "MUST NOT 以編號是否存在、大小等 heuristic 新增 mechanical gate",
  ]) {
    assert.match(prTemplate, literalRe(phrase));
  }
});

test("universal gh-body carrier requires every GitHub surface to follow the canonical ordinal rule", () => {
  const pointerLine = fileWriteDestinations
    .split("\n")
    .find((line) => line.includes("issue / PR / comment / Discussion"));
  assert.ok(pointerLine, "universal GitHub body pointer line is missing");
  assert.match(
    pointerLine,
    literalRe("凡 GitHub body 寫入（issue / PR / comment / Discussion）都 MUST 遵守 `git-pr-template-and-merge.md` § `gh body 序數防誤連結（cooperative-only）`")
  );
  assert.match(pointerLine, literalRe("canonical How 為準，本 leaf 不複寫"));
});

test("寫檔目的地總表 cross-ref 指向 file-write-destinations.md 而非 rule-design-principles.md", () => {
  const files = [
    ".devpro/agent-rules/git-pr-template-and-merge.md",
    ".devpro/agent-rules/session-recap.md",
    ".devpro/agent-rules/git-branch-and-pr-flow.md",
    ".devpro/agent-rules/platform-adapters/codex.md",
    ".devpro/agent-rules/platform-adapters/codex-github-writes.md",
  ];
  for (const rel of files) {
    const content = read(rel);
    const lines = content.split("\n");
    const matchingLines = lines.filter((l) => l.includes("寫檔目的地總表見"));
    assert.ok(
      matchingLines.length > 0,
      `${rel}: 找不到「寫檔目的地總表見」句`
    );
    for (const line of matchingLines) {
      assert.ok(
        line.includes("file-write-destinations.md"),
        `${rel}: 「寫檔目的地總表見」應指向 file-write-destinations.md，實際：${line.trim()}`
      );
      assert.ok(
        !line.includes("rule-design-principles.md"),
        `${rel}: 「寫檔目的地總表見」不應指向 rule-design-principles.md，實際：${line.trim()}`
      );
    }
  }
});

test("proposal issue: #N must reach the PR body as a closing or related line (leaf + pre-pr pointer)", () => {
  assert.match(
    prTemplate,
    /proposal 帶 `issue: #N`[^\n]*MUST[^\n]*完整交付＝裸 `Fixes #N`[^\n]*部分或延期＝`Related to #N`/,
  );
  const preprSkill = read(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md");
  assert.match(
    preprSkill,
    /proposal 帶 `issue: #N` 時，PR 描述 MUST 帶對應行[^\n]*git-pr-template-and-merge\.md/,
  );
});
