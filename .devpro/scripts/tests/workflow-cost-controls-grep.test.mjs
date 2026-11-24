import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { repoPath } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";
import { readPrePrSkillFullReadingOrder } from "./lib/pre-pr-skill.mjs";

const changeName = "strengthen-token-waste-controls";
const shortestDecisionChainChangeName = "strengthen-shortest-decision-chain";

function assertIncludes(content, tokens, label) {
  for (const token of tokens) {
    assert.ok(content.includes(token), `${label} missing ${token}`);
  }
}

function uniqueSection(content, headingPattern, nextHeadingPattern, label) {
  const lines = content.split("\n");
  const starts = lines.flatMap((line, index) => headingPattern.test(line) ? [index] : []);
  assert.equal(starts.length, 1, `${label} must have exactly one heading`);
  const start = starts[0];
  const relativeEnd = lines.slice(start + 1).findIndex((line) => nextHeadingPattern.test(line));
  const end = relativeEnd < 0 ? lines.length : start + 1 + relativeEnd;
  return { lines: lines.slice(start, end), text: lines.slice(start, end).join("\n") };
}

function readWorkflowCostControlsSpecCarrier(targetChangeName = changeName) {
  const candidates = [
    `openspec/changes/${targetChangeName}/specs/workflow-cost-controls/spec.md`,
    "openspec/specs/workflow-cost-controls/spec.md",
  ];

  for (const relPath of candidates) {
    const fullPath = repoPath(relPath);
    if (existsSync(fullPath)) return readFileSync(fullPath, "utf8");
  }

  const archiveRoot = repoPath("openspec/changes/archive");
  const archivedDir = existsSync(archiveRoot)
    ? readdirSync(archiveRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.endsWith(`-${targetChangeName}`))
        .map((entry) => entry.name)
        .sort()
        .at(-1)
    : undefined;

  assert.ok(
    archivedDir,
    `missing active, canonical, or archived workflow-cost-controls spec for ${targetChangeName}`,
  );

  const archivedSpecPath = path.join(
    archiveRoot,
    archivedDir,
    "specs/workflow-cost-controls/spec.md",
  );
  assert.ok(existsSync(archivedSpecPath), `missing archived spec carrier: ${archivedSpecPath}`);
  return readFileSync(archivedSpecPath, "utf8");
}

function assertUniqueOperativeLine(lines, pattern, label) {
  const matchingIndexes = lines.flatMap((line, index) => pattern.test(line) ? [index] : []);
  assert.equal(matchingIndexes.length, 1, `${label} must match exactly one operative line`);

  const withoutOperativeLine = lines
    .filter((_, index) => index !== matchingIndexes[0])
    .join("\n");
  assert.doesNotMatch(
    withoutOperativeLine,
    pattern,
    `${label} delete-line mutation must remove the protected anchor`,
  );
}

test("AGENTS.md routes status and next-step questions to workflow-cost-controls", () => {
  const agents = read("AGENTS.md");

  assert.ok(
    agents.includes("status/next-step") ||
      agents.includes("status / next-step") ||
      agents.includes("status／next-step"),
    "AGENTS.md must expose status/next-step routing language",
  );
  assert.ok(
    agents.includes(".devpro/agent-rules/workflow-cost-controls.md") ||
      agents.includes("workflow-cost-controls.md"),
    "AGENTS.md must route status/next-step questions to workflow-cost-controls.md",
  );
});

// strengthen-subagent-delegation-strategy round-6 F-r7-done-when-3-literal-stale-after-r6-fix:
// the half-state evaluation-face clause had zero anchors here, so the only
// mechanical carrier for it was a verbatim quote inside proposal.md done_when #3.
// Rewriting the sentence to key on authorization-need silently falsified that
// done_when. Bind the clause here — polarity included — so the rule sentence and
// its acceptance criterion cannot drift apart again.
test("workflow-cost-controls half-state clause limits the evaluation face to actions needing a fresh authorization", () => {
  const leafPath = ".devpro/agent-rules/workflow-cost-controls.md";
  const leaf = read(leafPath);

  assertIncludes(leaf, ["**評估面限定**"], leafPath);
  // Criterion, not a lane enumeration: a lane list is what made the previous
  // wording ambiguous for a continue-dispatched bounded rereview.
  assert.match(
    leaf,
    /`budget_state` 只在\*\*需要一次新授權的動作\*\*之前評估/u,
    `${leafPath}: the evaluation face must be keyed on authorization need, not on a lane enumeration`,
  );
  // Both polarities in one contiguous literal: continue/TL-direct do not need a
  // new budget-state authorization. This audit carve-out is not a substitute
  // for the distinct stalled/cap handback authority asserted below.
  assert.match(
    leaf,
    /`continue` 續作與 TL-direct 都不需要新授權，故 MUST NOT 評估/u,
    `${leafPath}: the carve-out for continue and TL-direct lost its MUST NOT polarity`,
  );
  assert.match(
    leaf,
    /以 `continue` 派的 bounded rereview 亦同/u,
    `${leafPath}: the continue-dispatched bounded rereview case must stay explicitly placed`,
  );
});

test("workflow-cost-controls keeps stalled and bounded-cap recovery exits aligned with classifier authority", () => {
  const leafPath = ".devpro/agent-rules/workflow-cost-controls.md";
  const leaf = read(leafPath);
  const authorityLine = leaf
    .split("\n")
    .find((line) => line.includes("stalled_rounds") && line.includes("convergence_recovery"));

  assert.ok(authorityLine, `${leafPath}: missing the convergent stall/cap recovery authority line`);
  assertIncludes(
    authorityLine,
    [
      "stalled_rounds",
      "convergence_recovery",
      "handback_required",
      "handbackCause",
      "`continue`",
      "recovery_disposition_required",
      "final_ready",
      "single-use override",
      "route=bounded",
      "handback_authorized_bounded",
      "handback_authorized_full",
      "REVIEW_STALL_ROUND_CAP",
      "必須讓位",
    ],
    `${leafPath}: stalled/cap recovery authority line`,
  );
});

test("workflow-cost-controls leaf contains fast-path and broad-scan guard anchors", () => {
  const leafPath = ".devpro/agent-rules/workflow-cost-controls.md";
  const fullPath = repoPath(leafPath);

  assert.ok(existsSync(fullPath), `${leafPath} must exist`);
  const leaf = read(leafPath);
  const compactLeaf = leaf.replace(/\s+/g, " ");

  assertIncludes(
    leaf,
    [
      "Status Fast Path",
      "Broad Scan Avoidance",
      "no-op evidence",
      "session-pending",
      "PR state",
      "release state",
      "cleanup branch hygiene",
      "notes/tmp/state",
      "openspec/changes/archive",
      ".worktree",
      "refs",
    ],
    leafPath,
  );
  assert.match(
    leaf,
    /MUST NOT[^.\n]*(?:begin|start)[^.\n]*(?:broad repo-wide `rg -n`|repo-wide `rg -n`|`rg -n`[^.\n]*first pass)/i,
    `${leafPath} must forbid broad repo-wide rg -n as the first pass`,
  );
  assert.match(
    compactLeaf,
    /session-pending \| `node \.devpro\/scripts\/session-pending-claim\.mjs list` or direct bounded read of `notes\/session-pending\.md` \| no open or unclaimed matching item/,
    `${leafPath} must bind session-pending asks to the narrow first lane and no-op evidence`,
  );
  assert.match(
    compactLeaf,
    /PR state \| known PR: `gh pr view --json number,state,headRefName,mergeStateStatus,statusCheckRollup,url`; unknown PR: `gh pr list --state open --json number,title,headRefName,state,url` \| no open matching PR, or known PR is terminal/,
    `${leafPath} must bind PR asks to the narrow first lane and terminal no-op evidence`,
  );
  assert.match(
    compactLeaf,
    /release state \| targeted `gh run list --json databaseId,status,conclusion,workflowName,headBranch -L 10` plus named release branch\/tag only when relevant \| no relevant nonterminal or failed run and no user-requested release action/,
    `${leafPath} must bind release asks to the narrow first lane and no-op evidence`,
  );
  assert.match(
    compactLeaf,
    /cleanup branch hygiene \| `git branch --merged <target>` plus `git worktree list --porcelain` for the named branch\/target \| branch not production-eligible, or cleanup deferred until production/,
    `${leafPath} must bind cleanup asks to the narrow first lane and production deferral evidence`,
  );
  assert.match(
    compactLeaf,
    /The answer MUST include result, no-op evidence when applicable, owner, and next action/,
    `${leafPath} must require a bounded status answer shape`,
  );
  assert.match(
    compactLeaf,
    /The first pass MUST NOT start with broad repo-wide `rg -n`, broad state dumps, `notes\/tmp\/state`, `openspec\/changes\/archive`, `\.worktree`, or `refs`/,
    `${leafPath} must bind first-pass broad-scan prohibition to the expensive targets`,
  );
  assert.match(
    compactLeaf,
    /If narrow evidence is sufficient, stop there and say so/,
    `${leafPath} must require stopping after sufficient narrow evidence`,
  );
});

test("workflow-cost-controls spec carrier preserves required requirement anchors", () => {
  const spec = readWorkflowCostControlsSpecCarrier();
  const compactSpec = spec.replace(/\s+/g, " ");

  assertIncludes(
    spec,
    [
      "Status Fast Path",
      "Post-Merge Continuation Priority",
      "Rule-Feedback Implementation Requests",
    ],
    "workflow-cost-controls spec carrier",
  );
  assert.match(
    compactSpec,
    /Post-Merge Continuation Priority[^#]*ordered continuation priority `sync main -> recap -> user-requested release -> production back merge -> cleanup`[^#]*cleanup/,
    "workflow-cost-controls spec carrier must preserve the exact post-merge continuation order",
  );
});

test("costly work follows one shortest decision chain contract", () => {
  const leaf = read(".devpro/agent-rules/workflow-cost-controls.md");
  const section = uniqueSection(
    leaf,
    /^### Shortest Decision Chain\s*$/u,
    /^#{1,3}\s+/u,
    "workflow-cost-controls shortest decision chain",
  );
  const operativeAnchors = [
    [
      "define decision target, minimum evidence, and stop condition",
      /MUST[^\n]*define[^\n]*`decision target`[^\n]*`minimum evidence`[^\n]*`stop condition`/u,
    ],
    [
      "skip non-atomic actions outside the evidence or gate path",
      /Every subsequent non-atomic action[^\n]*MUST[^\n]*`minimum evidence`[^\n]*mandatory gate[^\n]*if it cannot do either[^\n]*MUST be skipped/u,
    ],
    [
      "forbid chain-external exploration, documentation, review, and testing",
      /outside the chain[^\n]*MUST NOT[^\n]*exploration[^\n]*documentation[^\n]*review[^\n]*testing/u,
    ],
    [
      "stop when the stop condition is satisfied",
      /`stop condition`[^\n]*satisfied[^\n]*MUST stop/u,
    ],
    [
      "do not repeat unchanged chain narration",
      /unchanged chain state[^\n]*MUST NOT[^\n]*(?:repeatedly narrated|be narrated again)/iu,
    ],
    [
      "do not create a narration-only artifact",
      /active plan or task ledger[^\n]*MUST NOT[^\n]*new artifact[^\n]*narration/u,
    ],
    [
      "end the current chain, then replace or stop without accumulating branches",
      /New evidence[^\n]*MUST end the current chain[^\n]*if work remains authorized and continues[^\n]*MUST be replaced by the shortest next decision chain[^\n]*otherwise[^\n]*MUST stop[^\n]*report[^\n]*MUST NOT[^\n]*speculative branches/u,
    ],
  ];
  for (const [label, pattern] of operativeAnchors) {
    assertUniqueOperativeLine(section.lines, pattern, label);
  }

  const agentsLines = read("AGENTS.md").split("\n");
  assertUniqueOperativeLine(
    agentsLines,
    /^\|status\/next-step／多步高成本／最短判定鏈\|`workflow-cost-controls\.md`\|$/u,
    "AGENTS shortest-decision-chain trigger",
  );

  const scenarioPath = "scenarios/scenario-shortest-decision-chain.md";
  assert.ok(existsSync(repoPath(scenarioPath)), `${scenarioPath} must exist`);
  assertIncludes(
    read(scenarioPath),
    [
      "## Context",
      "## Preconditions",
      "## Rule Walkthrough",
      "Minimum Evidence First",
      "Chain-External Work Is Skipped",
      "Sufficient Evidence Stops The Chain",
      "New Evidence Replaces The Chain",
      "Quota Hard-Stop Remains Stronger",
      "## Negative Checks",
      "## Assertions",
      "## Pass Criteria",
    ],
    scenarioPath,
  );

  const spec = readWorkflowCostControlsSpecCarrier(shortestDecisionChainChangeName);
  const requirement = uniqueSection(
    spec,
    /^### Requirement: Costly Work Uses A Shortest Decision Chain\s*$/u,
    /^#{1,3}\s+/u,
    "shortest-decision-chain spec requirement",
  ).text;
  assert.match(
    requirement,
    /decision target[^.]*minimum next evidence[^.]*stop condition/u,
    "spec requirement must define the three shortest-chain inputs",
  );
  assertIncludes(
    requirement,
    [
      "Costly Work Starts With Minimum Decisive Evidence",
      "Chain-External Action Is Skipped",
      "Sufficient Evidence Stops Planned Extra Work",
      "New Evidence Replaces Rather Than Accumulates The Chain",
    ],
    "shortest-decision-chain spec requirement",
  );
});

test("T37 review remediation cost stop-loss contract and devpro:pre-pr action point", async (t) => {
  await t.test("workflow-cost-controls owns four compound stop-loss axes", () => {
    const section = uniqueSection(
      read(".devpro/agent-rules/workflow-cost-controls.md"),
      /^### Review Remediation Cost Stop-Loss\s*$/u,
      /^#{1,3}\s+/u,
      "workflow-cost-controls stop-loss",
    ).text;
    const compact = section.replace(/\s+/gu, " ");
    const axes = [
      ["batch admission", /primary review receipt[^.]*freeze[^.]*accepted remediation batch.*same-PR[^.]*only[^.]*Critical[^.]*(?:source\/reproduction|source\/repro)[^.]*current acceptance[^.]*security[^.]*trust[^.]*runtime correctness[^.]*existing RED validity.*Suggestion[^.]*disposition[^.]*MUST NOT[^.]*(?:behavior-risk|risk)[^.]*(?:full review|full).*Critical=0[^.]*Important=0/i],
      ["bounded loops", /per accepted batch[^.]*at most one[^.]*RED-contract review[^.]*at most one[^.]*post-GREEN source review[^.]*at most one[^.]*OpenSpec update[^.]*at most one[^.]*OpenSpec closeout.*reviewer-of-review[^.]*MUST NOT[^.]*dispatch another reviewer/i],
      ["quota stop", /quota\/cost concern[^.]*trusted runtime\/provider[^.]*warning[^.]*hard-stop[^.]*before[^.]*non-atomic reviewer[^.]*fanout[^.]*broad suite.*only[^.]*already-running atomic command[^.]*finish.*resume[^.]*explicit user approval[^.]*exact bounded scope/i],
      ["pointers and savings", /model-delegation\.md[^.]*token-frugal-io\.md.*estimate[^.]*MUST NOT[^.]*(?:actual savings|reported as actual)/i],
      ["blocking_ids stall", /blocking_ids[^.]*true-subset|strict subset shrink of `blocking_ids`|swap[^.]*counts as stall/i],
    ];
    for (const [label, pattern] of axes) assert.match(compact, pattern, label);
  });

  await t.test("devpro:pre-pr Step 3 has one pre-dispatch and post-receipt stop-loss action point", () => {
    // Step 3 body lives in references/full-review-and-archive.md; read the full-rigor reading order.
    const step = uniqueSection(
      readPrePrSkillFullReadingOrder(),
      /^### 第三步：Six-Axis Review\s*$/u,
      /^###\s+/u,
      "devpro:pre-pr Step 3",
    );
    const actionLines = step.lines.filter((line) =>
      /workflow-cost-controls\.md[^\n]*Review Remediation Cost Stop-Loss/u.test(line),
    );
    assert.equal(actionLines.length, 1, "Step 3 needs one stop-loss action line");
    const actionLine = actionLines[0];
    assert.match(actionLine, /MUST[^\n]*任何 reviewer dispatch 前[^\n]*每個 receipt 後/u);
    const actionIndex = step.lines.indexOf(actionLine);
    const dispatchIndex = step.lines.findIndex((line) => /呼叫前準備/u.test(line));
    assert.ok(dispatchIndex >= 0 && actionIndex < dispatchIndex, "action point must precede 呼叫前準備");
  });
});
