import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, SOURCE_ROOT } from "./lib/repo-root.mjs";

// #2975: a round that exists only to make the receipt cover a new reviewed head (the delta is
// bookkeeping, nothing behavioural) is mechanically the same cost as a real remediation round.
// `seal-receipt` already accepts `executor_kind: tl-direct`, but no checklist pointed there. The
// pointer is one physical line in the Step 3 section of the dispatch-blocks reference. Structural
// terms use includes(); the two polarity-sensitive clauses (no admission ref for tl-direct, tl-direct
// cannot satisfy requireIndependence) are same-line compound regexes that bind the negation to its object.

const file = path.join(REPO_ROOT, ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md");
const doc = readFileSync(file, "utf8");
const step3Start = doc.indexOf("## Step 3: dp-reviewer dispatch");
const step3End = doc.indexOf("## Step 5.5.3");
assert.ok(step3Start >= 0 && step3End > step3Start, "Step 3 section bounds must exist");
const step3 = doc.slice(step3Start, step3End);
const lines = step3.split("\n").filter((line) => line.includes("覆蓋輪"));

test("exactly one Step 3 line carries the coverage-round tl-direct pointer", () => {
  assert.equal(lines.length, 1);
  assert.equal(doc.split("\n").filter((line) => line.includes("覆蓋輪")).length, 1, "no copy outside Step 3");
});

test("pointer names the bookkeeping-only delta, risk_classes none and the decision-order SSOT", () => {
  const [line] = lines;
  assert.ok(line.includes("evaluateRegressionHeadCurrency"));
  assert.ok(line.includes("`risk_classes` 為 `none`"));
  assert.ok(line.includes("model-delegation-delegation-rules.md"));
});

test("pointer routes the coverage round to seal-receipt tl-direct and keeps authority refs off it", () => {
  const [line] = lines;
  assert.match(line, /覆蓋輪[^\n]*`seal-receipt`[^\n]*`executor_kind: tl-direct`/);
  assert.match(line, /`executor_kind: tl-direct`[^\n]*MUST NOT 傳 `admissionRecordId`/);
});

test("pointer states tl-direct cannot satisfy requireIndependence and falls back to dp-reviewer", () => {
  const [line] = lines;
  assert.match(line, /不滿足 `requireIndependence: true`[^\n]*仍須走 `dp-reviewer`/);
});

test("coverage-round pointer binds proportional work to a classified bounded route", () => {
  const [line] = lines;
  assert.match(line, /`route=bounded`[^\n]*只核對[^\n]*bookkeeping delta[^\n]*必要 dependency closure/);
  assert.match(line, /MUST NOT[^\n]*重掃整包[^\n]*新派 reviewer/);
  assert.match(line, /比例規則[^\n]*code-review-checklist\/spec\.md[^\n]*Coverage-Only Rereview Work Is Proportional Without Relaxing Authority/);
  assert.doesNotMatch(line, /比例規則尚未規格化/);
});

test("canonical coverage-only scenario preserves complete authority while bounding review work", () => {
  const spec = readFileSync(path.join(SOURCE_ROOT, "openspec/specs/code-review-checklist/spec.md"), "utf8");
  const heading = "#### Scenario: Coverage-Only Rereview Work Is Proportional Without Relaxing Authority\n";
  const start = spec.indexOf(heading);
  assert.ok(start >= 0, "coverage-only proportionality scenario must exist");
  const rest = spec.slice(start + heading.length);
  const end = rest.search(/\n#{1,4} /);
  const scenario = end < 0 ? rest : rest.slice(0, end);
  assert.match(scenario, /GIVEN[^\n]*R6 bookkeeping[^\n]*verified nonbehavioral[^\n]*risk_classes[^\n]*none/);
  assert.match(scenario, /WHEN[^\n]*route=bounded[^\n]*TL-direct[^\n]*no independent judgement/);
  assert.match(scenario, /TL SHALL verify only[^\n]*bookkeeping delta[^\n]*necessary dependency closure/);
  assert.match(scenario, /MUST NOT[^\n]*full six-axis rescan[^\n]*new reviewer/);
  assert.match(scenario, /MUST retain[^\n]*complete[^\n]*manifest[^\n]*exact-HEAD[^\n]*round[^\n]*Critical[^\n]*Important/);
  assert.match(scenario, /MUST NOT[^\n]*mandatory-full[^\n]*requireIndependence[^\n]*independent review/);
});
