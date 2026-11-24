import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath, SOURCE_ROOT } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";

const changeName = "strengthen-flow-decay-discipline";


function literalRe(text) {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

function readChangeFile(relPath) {
  const activePath = path.join(SOURCE_ROOT, "openspec/changes", changeName, relPath);
  if (existsSync(activePath)) return readFileSync(activePath, "utf8");

  const archiveRoot = repoPath("openspec/changes/archive");
  const archivedDir = readdirSync(archiveRoot)
    .filter((name) => name.endsWith(`-${changeName}`))
    .sort()
    .at(-1);
  assert.ok(archivedDir, `missing active or archived change for ${changeName}`);
  return readFileSync(path.join(archiveRoot, archivedDir, relPath), "utf8");
}

test("B-mini self-authored proposal path forbids hand-rolled proposal sections", () => {
  const flow = read(".devpro/agent-rules/openspec-flow.md");
  for (const phrase of [
    "TL 自寫不是手搓",
    "openspec-artifact-authoring",
    "proposal-template.md",
    "openspec-quality-and-formats.md",
    "不得憑記憶自創 proposal/proposal-mini 章節名",
  ]) {
    assert.match(flow, literalRe(phrase));
  }
});

test("output language policy carries flow-state decay pre-send reminder", () => {
  const autonomy = read(".devpro/agent-rules/ai-autonomy.md");
  for (const phrase of [
    "flow-state decay 提醒",
    "resume/長流程後送出前重核本節",
    "未指定語言即正體中文",
    "rule leaves、skills、OpenSpec spec/delta",
    "不退回英文環境預設",
  ]) {
    assert.match(autonomy, literalRe(phrase));
  }
});

test("stop-point and dev-flow rules do not outsource gate-passed AI closeout", () => {
  const stopPoint = read(".devpro/agent-rules/stop-point-comms.md");
  const checklist = read(".devpro/agent-rules/dev-flow-checklist.md");
  for (const phrase of [
    "AI-actionable 收尾",
    "regular merge",
    "是否授權 AI 執行",
  ]) {
    assert.match(stopPoint, literalRe(phrase), `stop-point missing ${phrase}`);
    assert.match(checklist, literalRe(phrase), `dev-flow checklist missing ${phrase}`);
  }
  assert.match(stopPoint, /不把它列成「使用者去做」/, "stop-point must forbid outsourcing the action to the user");
  assert.match(checklist, /不要外包成使用者手動動作/, "dev-flow checklist must forbid manual-user outsourcing");
});

test("testing discipline protects direct gate exit code and contradictory pass recheck", () => {
  const testing = read(".devpro/agent-rules/testing-and-qa.md");
  for (const phrase of [
    "Gate exit-code discipline",
    "node .devpro/scripts/validate-openspec-change.mjs <change> --strict; echo $?",
    "node .devpro/scripts/validate-openspec-change.mjs <change> --strict | tail; echo $?",
    "一律當假通過重驗",
  ]) {
    assert.match(testing, literalRe(phrase));
  }
});

test("output-discipline delta and proposal matrix cover the flow-decay surfaces", () => {
  const delta = readChangeFile("specs/output-discipline/spec.md");
  const proposal = readChangeFile("proposal-mini.md");
  for (const phrase of [
    "Requirement: Flow-State Decay Discipline",
    "Self-authored OpenSpec artifact uses template SSOT",
    "Output language is rechecked after flow-state decay",
    "AI-actionable completion is not outsourced",
    "Gate verdict uses direct exit evidence",
    "Contradictory green verdict is treated as false pass",
  ]) {
    assert.match(delta, literalRe(phrase));
  }
  for (const phrase of [
    "Rule-feedback Surface Matrix",
    "Affected capability spec",
    "Cross-runtime parity spec",
    "N/A: shared rule leaf + cooperative discipline only",
    "Mechanical guard",
    ".devpro/scripts/tests/flow-decay-discipline-grep.test.mjs",
    "PR dependency wording",
    "main-tip dependency SHA",
    "23cddc23b32ed9054694a84086687cc9e355a503",
    "Flow-state decay 同型現象",
  ]) {
    assert.match(proposal, literalRe(phrase));
  }
  // The spec-delta row may name the active path (pre-archive) or the dated
  // archive path after the archived Touch-row sweep (strengthen-residue-guards).
  assert.match(
    proposal,
    /openspec\/changes\/(?:archive\/\d{4}-\d{2}-\d{2}-)?strengthen-flow-decay-discipline\/specs\/output-discipline\/spec\.md/,
    "proposal must name its spec delta (active or dated archive path)"
  );
});
