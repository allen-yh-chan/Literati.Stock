import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";



function literalRe(phrase) {
  return new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

const modelDelegation = read(".devpro/agent-rules/model-delegation.md");
// rationalize-overbundled-entry-leaves T1: Subagent Artifact Landing Verification section
// moved from model-delegation.md to model-delegation-briefing.md (on-demand sibling).
// It then moved on to the post-dispatch sibling
// model-delegation-active-lifecycle.md together with the interruption gate.
const modelDelegationActiveLifecycle = read(".devpro/agent-rules/model-delegation-active-lifecycle.md");
const multiAgentHandoff = read(".devpro/agent-rules/multi-agent-handoff.md");
const codeReviewChecklist = read(".devpro/agent-rules/code-review-checklist.md") + "\n" +
  read(".devpro/agent-rules/code-review-cross-model.md") + "\n" +
  read(".devpro/agent-rules/code-review-cross-model-rationale.md");
const postPrCompletion = read(".devpro/agent-rules/post-pr-completion-gate.md");
const codexCrossReview = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
const claudeCode = read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md");
const codexAdapter = read(".devpro/agent-rules/platform-adapters/codex.md");
const gitPrTemplate = read(".devpro/agent-rules/git-pr-template-and-merge.md");
const openspecStep = read(".devpro/agent-rules/openspec-step-1-to-9.md");
const openspecArchivePrinciples = read(".devpro/agent-rules/openspec-archive-principles.md");
const preToolGate = read(".devpro/scripts/hooks/pre-tool-gate.mjs");
const ghFooterGate = read(".devpro/scripts/hooks/gh-footer-gate.mjs");

test("issue #1126: TL verifies subagent claimed artifacts before accepting completion", () => {
  // rationalize-overbundled-entry-leaves T1: Subagent Artifact Landing Verification
  // moved from model-delegation.md to model-delegation-briefing.md, then on to
  // model-delegation-active-lifecycle.md (on-demand sibling).
  for (const phrase of [
    "Subagent Artifact Landing Verification",
    "git status --short",
    "test -f <path>",
    "git diff --name-only",
    "MUST NOT mark OpenSpec tasks",
    "partial` / `failed",
  ]) {
    assert.match(modelDelegationActiveLifecycle, literalRe(phrase));
  }

  for (const phrase of [
    "claimed artifact paths",
    "artifact landing verification",
    "git status --short",
    "MUST NOT move tasks.md",
  ]) {
    assert.match(multiAgentHandoff, literalRe(phrase));
  }
});

test("issue #1129: sticky schema guidance rejects markdown-wrapped schema lines", () => {
  const verdictRegex = "^verdict:\\s+(PASS|WARN|CRITICAL|UNAVAILABLE)\\s*$";
  const shaRegex = "^last_reviewed_sha:\\s+([a-f0-9]{7,40})\\s*$";

  for (const doc of [codeReviewChecklist, postPrCompletion, codexCrossReview, claudeCode]) {
    assert.match(doc, literalRe(verdictRegex));
    assert.match(doc, literalRe(shaRegex));
    assert.match(doc, /Markdown emphasis/);
    assert.match(doc, /code spans/);
    assert.match(doc, /bullets/);
    assert.match(doc, /headings/);
  }
});

test("rule-feedback: cross-review auth probes redact identity output", () => {
  for (const doc of [codexCrossReview, claudeCode]) {
    assert.match(doc, /Auth probe output hygiene|Auth probe transcript hygiene/);
    assert.match(doc, /raw auth status output/);
    assert.match(doc, /email \/ org \/ account \/ login/);
    assert.match(doc, /redacted summary/);
    assert.match(doc, /transcript \/ recap \/ PR body \/ sticky \/ issue \/ log excerpt \/ repo artifact/);
  }
});

test("issue #1130: body-file guidance routes TL bodies to notes/tmp main-checkout and discourages repo-external /tmp", () => {
  for (const doc of [codexAdapter, gitPrTemplate, ghFooterGate]) {
    assert.match(doc, /notes\/tmp/);
    assert.match(doc, /main-checkout/);
  }
  // gh-footer-gate footer-missing message explicitly names repo-external /tmp as discouraged for TL bodies
  assert.match(ghFooterGate, /[Rr]epo-external \/tmp/);
  assert.doesNotMatch(ghFooterGate, /勿用 \/tmp 絕對路徑/);
});

test("issue #1135: Codex protected-branch fallback-only diagnostics describe proof gap", () => {
  for (const doc of [codexAdapter, preToolGate]) {
    assert.match(doc, /target branch\/worktree could not be proven/);
    assert.match(doc, /fallback-only evidence/);
    assert.match(doc, literalRe("git -C <abs-worktree>"));
    // R2 (fix-protected-branch-gate-payload-cwd): the cd-prefixed git write form
    // was retired; the guidance must instead require separate add/commit calls.
    assert.doesNotMatch(doc, /cd <abs-worktree> && git/);
    assert.match(doc, /分兩次 Bash 呼叫/);
  }
});

test("issue #1237: attribution footer docs include copy-ready example and anti-examples", () => {
  assert.match(gitPrTemplate, /Byte-for-byte 正確範例/);
  assert.match(gitPrTemplate, /Rules: v\d+\.\d+\.\d+ · Tool: Codex · Model: GPT-5/);
  assert.match(gitPrTemplate, /常見錯誤反例/);
  assert.match(gitPrTemplate, /Rules: v\d+\.\d+\.\d+\nTool: Codex\nModel: GPT-5/);
  assert.match(gitPrTemplate, /Co-Authored-By: <AI tool or model marker>/);
  assert.match(gitPrTemplate, /ai-autonomy\.md/);
  assert.match(gitPrTemplate, /F1-F5 forbidden pattern/);
});

// #2858: a version bump PR is metadata-only (chore-classification.md), so it cannot also edit this
// example. The example therefore stays copy-ready in format but its version may lag AGENTS.md; the
// rule has to say so, and the three copies (example + two anti-examples) must move together.
test("issue #2858: footer example version is illustrative, AGENTS.md is the source, copies agree", () => {
  assert.match(gitPrTemplate, /版號以 `AGENTS\.md` 開頭為準，下例版號只示意格式、不隨 bump 更新/);
  const versions = [...gitPrTemplate.matchAll(/^Rules: v(\d+\.\d+\.\d+)(?: · Tool: Codex| ?\nTool: Codex)/gm)].map((m) => m[1]);
  assert.equal(versions.length, 3, "example + two anti-examples");
  assert.equal(new Set(versions).size, 1, `footer example versions diverged: ${versions.join(", ")}`);
});

test("issue #1238: post-archive guidance reruns brand and vendor guards after promotion", () => {
  // Archive 原則 de-bundle：brand/vendor guard 正文在 sibling；entry Load-chain 具名該題。
  assert.match(openspecStep, /openspec-archive-principles\.md/);
  assert.match(openspecStep, /Post-archive brand\/vendor guard/);
  assert.match(openspecArchivePrinciples, /Post-archive brand\/vendor guard/);
  assert.match(openspecArchivePrinciples, /openspec archive` 會把 change delta promote 進 canonical `openspec\/specs\/`/);
  assert.match(openspecArchivePrinciples, /platform-brand-isolation-grep\.test\.mjs/);
  assert.match(openspecArchivePrinciples, /vendor-leak-regression\.test\.mjs/);
  assert.match(openspecArchivePrinciples, /node --test \.devpro\/scripts\/tests\//);
});

test("strengthen-cross-model-blindspot-rationale: same-family blind-spot rationale + scan checklist", () => {
  // Rationale: cross-model 結構性補位 same-family 系統性盲區（doc 因果誤歸因 / dangling cross-ref /
  // dead code / cross-platform test）；reviewer 重點掃描項清單鎖定。無聲移除任一 anchor → RED。
  for (const phrase of [
    "Same-Family Systematic Blind Spots",
    "結構性補位",
    "spec-scenario THEN-clause cross-ref",
    "grep-asserted phrase 單行可 match",
    "dead-code after refactor",
    "cross-platform test 正確性",
  ]) {
    assert.match(codeReviewChecklist, literalRe(phrase));
  }
});
