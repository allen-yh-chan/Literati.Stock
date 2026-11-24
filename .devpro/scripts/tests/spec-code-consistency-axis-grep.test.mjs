import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";
import { readSpecWithDelta } from "./lib/spec-delta-reader.mjs";

const changeName = "add-spec-code-consistency-axis";

// Presence/polarity guards for the operative clauses, not an automated
// classification of correctness, security, or finding severity.
function assertIndependentSeverityContract(checklist, spec) {
  const guidance = checklist.split("\n").find((line) => line.startsWith("**decisions.md 讀取指引**"));
  assert.match(guidance ?? "", /MUST.*實際行為與影響.*MUST NOT.*proposal.*decisions.*降級.*Critical.*Important/);
  const subCheck = checklist.split("\n").find((line) => line.startsWith("- **Spec↔Code Behavioral Consistency sub-check"));
  assert.match(subCheck ?? "", /已載明的差異本身不標.*MUST NOT.*spec↔code 自洽.*降級.*豁免 correctness\/security 缺陷/);
  assert.doesNotMatch(subCheck, /有追溯即放行/);
  const requirement = spec.split("### Requirement: Spec↔Code Behavioral Consistency Sub-check\n")[1]?.split("\n### Requirement:")[0];
  assert.match(requirement ?? "", /MUST NOT downgrade or waive a correctness\/security defect solely because.*proposal.*decisions.*spec and code agree/);
}

test("operative review clauses preserve severity independence in the rule and canonical spec", () => {
  assertIndependentSeverityContract(
    read(".devpro/agent-rules/code-review-checklist.md"),
    read("openspec/specs/code-review-checklist/spec.md"),
  );
});

test("severity clause guard rejects deletion, reversed polarity, and traceability blanket exemption", () => {
  const checklist = read(".devpro/agent-rules/code-review-checklist.md");
  const spec = read("openspec/specs/code-review-checklist/spec.md");
  assertIndependentSeverityContract(checklist, spec);
  const guidance = checklist.split("\n").find((line) => line.startsWith("**decisions.md 讀取指引**"));
  assert.throws(() => assertIndependentSeverityContract(checklist.replace(guidance, ""), spec));
  assert.throws(() => assertIndependentSeverityContract(checklist.replace(guidance, guidance.replace("MUST NOT", "MAY")), spec));
  assert.throws(() => assertIndependentSeverityContract(checklist.replace("已載明的差異本身不標", "有追溯即放行"), spec));
  assert.throws(() => assertIndependentSeverityContract(checklist, spec.replace("MUST NOT downgrade or waive", "MAY downgrade or waive")));
});

function assertIncludes(body, phrases) {
  for (const phrase of phrases) {
    assert.ok(body.includes(phrase), `missing phrase: ${phrase}`);
  }
}

test("軸 1 carries the Spec↔Code Behavioral Consistency sub-check", () => {
  const checklist = read(".devpro/agent-rules/code-review-checklist.md");
  assertIncludes(checklist, [
    "Spec↔Code Behavioral Consistency sub-check",
    "openspec/specs/<cap>/spec.md",
    "spec 的行為契約",
    "current behavior 的 source of truth",
  ]);
});

test("sub-check phrase and Important grade sit on single grep-matchable lines", () => {
  const checklist = read(".devpro/agent-rules/code-review-checklist.md");
  const lines = checklist.split("\n");
  const subCheckLine = lines.find((l) => l.includes("Spec↔Code Behavioral Consistency sub-check"));
  assert.ok(subCheckLine, "sub-check line not found on a single line");
  // 分級 Important 與 cooperative-only 皆在同一行，避免 promote/換行後 grep 斷裂
  assert.ok(subCheckLine.includes("標 **Important**"), "Important grade not on the sub-check line");
  assert.ok(subCheckLine.includes("無 mechanical hook gate"), "cooperative-only marker not on the sub-check line");
});

test("sub-check is cooperative-only and applies to both reviewers", () => {
  const checklist = read(".devpro/agent-rules/code-review-checklist.md");
  const subCheckLine = checklist
    .split("\n")
    .find((l) => l.includes("Spec↔Code Behavioral Consistency sub-check"));
  // cooperative-only：不得宣稱機械閘 enforce spec↔code 行為等價
  assertIncludes(subCheckLine, ["不要求外部工具", "純語意判斷"]);
  // 雙 reviewer 適用
  assertIncludes(subCheckLine, ["dp-reviewer", "devpro:second-review"]);
  // 不升 Critical
  assert.ok(
    subCheckLine.includes("不因單純偏離就升 Critical"),
    "escalation guard (no Critical on divergence alone) missing",
  );
});

test("capability spec delta carries the Spec↔Code consistency requirement", () => {
  const checklistSpec = readSpecWithDelta("code-review-checklist", { changeName });
  assertIncludes(checklistSpec, [
    "Spec↔Code Behavioral Consistency Sub-check",
    "cooperative-only",
    "no mechanical hook gate enforces it",
    "devpro:second-review",
    "SHALL NOT escalate a spec↔code mismatch to Critical solely on the basis of divergence",
  ]);
});

test("軸 1 carries the Resource Lifecycle / Memory Leak sub-check", () => {
  const checklist = read(".devpro/agent-rules/code-review-checklist.md");
  assertIncludes(checklist, [
    "Resource Lifecycle / Memory Leak sub-check",
    "IDisposable",
    "event handler `+=` 無對應 `-=`",
    "無界成長",
  ]);
});

test("leak sub-check phrase, Important grade, and cooperative-only marker are single-line grep-matchable", () => {
  const checklist = read(".devpro/agent-rules/code-review-checklist.md");
  const leakLine = checklist
    .split("\n")
    .find((l) => l.includes("Resource Lifecycle / Memory Leak sub-check"));
  assert.ok(leakLine, "leak sub-check line not found on a single line");
  assert.ok(leakLine.includes("標 **Important**"), "Important grade not on the leak sub-check line");
  assert.ok(leakLine.includes("無 mechanical hook gate"), "cooperative-only marker not on the leak sub-check line");
  // 雙 reviewer 適用 + 不自動升 Critical
  assertIncludes(leakLine, ["dp-reviewer", "devpro:second-review"]);
  assert.ok(
    leakLine.includes("不因單純未釋放就升 Critical"),
    "escalation guard (no Critical on non-release alone) missing",
  );
  // 明示現行「安全」軸不含資源生命週期（此軸存在理由）
  assert.ok(
    leakLine.includes("不含資源生命週期"),
    "rationale (安全 axis excludes resource lifecycle) missing",
  );
});

test("capability spec delta carries the Resource Lifecycle Leak requirement", () => {
  const checklistSpec = readSpecWithDelta("code-review-checklist", { changeName });
  assertIncludes(checklistSpec, [
    "Resource Lifecycle Leak Sub-check",
    "IDisposable",
    "event handler `+=` with no corresponding `-=`",
    "unbounded growth",
    "SHALL NOT escalate a leak to Critical solely on the basis of non-release",
    "devpro:second-review",
  ]);
});
