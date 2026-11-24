import "./lib/isolated-control-evidence-state.mjs";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnWithReminderDetails as spawnSync } from "./lib/post-pr-reminder-fixtures.mjs";
import { readFileSync, existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkStopPointHandoffShape } from "../hooks/lib/stop-point-handoff-shape-gate.mjs";
import { writePostPrCompletionMarker } from "../hooks/lib/post-pr-completion-state.mjs";
import { repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

// The Stop hook is spawned as a child process against a throwaway git repo. The PR snapshot comes from the hook's own mock
// knobs (MOCK_HEAD_REF / MOCK_HEAD_SHA / MOCK_BODY_B64 / MOCK_STICKY), so no gh is involved and no production seam is added.
// A same-repo pending marker gets one fixed next step that no approval evidence (ledger, lite scope record, proposal)
// can change; the fixtures below differ only in that evidence.


process.env.DEVPRO_POST_PR_COMPLETION_SESSION_ID = "approval-routing-session";
process.env.DEVPRO_HOOK_HOST = "test";
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.CLAUDE_CONVERSATION_ID;

const STOP_HOOK = repoPath(".devpro/scripts/hooks/post-pr-completion-check.mjs");
const tmpRoot = makeTempDir("post-pr-approval-routing-");
after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const OWNER_REPO = "devpro-tw/devpro-agent-rules";
const BRANCH = "feature/adoption-consent-demo";
const CHANGE = "adoption-consent-demo";
const PROPOSAL_DIR = `openspec/changes/${CHANGE}`;
const PR_NUMBER = 3101;

let counter = 0;

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed\nstderr: ${result.stderr}`);
  return result.stdout.trim();
}

const NA_PROPOSAL = [
  "## Section 1: Target State (Done When)", "", "- done", "",
  "## Batch Approval Ledger",
  "N/A: no batch approval selected", "",
].join("\n");

const STRUCTURED_PROPOSAL = [
  "## Section 1: Target State (Done When)", "", "- done", "",
  "## Batch Approval Ledger",
  "kind: same-change-dp-change-batch",
  `named_change: ${CHANGE}`,
  `branch: ${BRANCH}`,
  "repo_scope: same-repo",
  "covers: [implementation_writes, local_commit]",
  "excludes: []", "",
].join("\n");

const BROKEN_PROPOSAL = STRUCTURED_PROPOSAL.replace("covers: [implementation_writes, local_commit]", "covers: [unterminated");

const LITE_SCOPE_LINE =
  `kind=same-change-dp-change-batch; named_change=${CHANGE}; branch=${BRANCH}; repo_scope=same-repo; covers=implementation_writes; excludes=none`;

/** A fixture repo with the PR branch checked out; `proposal` and `liteScope` (when given) are written into the change folder. */
function makeFixture({ proposal, liteScope } = {}) {
  const repo = path.join(tmpRoot, `repo-${counter++}`);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "Devpro Test"]);
  writeFileSync(path.join(repo, "README.md"), "test\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "init"]);
  git(repo, ["checkout", "-b", BRANCH]);
  if (proposal !== undefined) {
    mkdirSync(path.join(repo, PROPOSAL_DIR), { recursive: true });
    writeFileSync(path.join(repo, PROPOSAL_DIR, "proposal.md"), proposal);
    git(repo, ["add", PROPOSAL_DIR]);
    git(repo, ["commit", "-m", "proposal"]);
  }
  if (liteScope !== undefined) {
    // The lite scope record is untracked by design.
    mkdirSync(path.join(repo, PROPOSAL_DIR), { recursive: true });
    writeFileSync(path.join(repo, PROPOSAL_DIR, "lite-scope.md"), `${liteScope}\n`);
  }
  const stateDir = path.join(tmpRoot, `state-${counter++}`);
  mkdirSync(stateDir, { recursive: true });
  return { repo, stateDir, headSha: git(repo, ["rev-parse", "HEAD"]) };
}

function addMarker({ repo, stateDir }, prNumber, extra = {}) {
  const previous = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  try {
    return writePostPrCompletionMarker({
      cwd: repo,
      prNumber: String(prNumber),
      branch: BRANCH,
      url: `https://github.com/${OWNER_REPO}/pull/${prNumber}`,
      sessionId: "approval-routing-session",
      ...extra,
    });
  } finally {
    if (previous === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previous;
  }
}

/** Runs the Stop hook once for `prs` (all on the fixture branch). */
function runStop(fixture, { prs = [PR_NUMBER], extraEnv = {} } = {}) {
  const per = (value) => prs.map((pr) => `${pr}:${value}`).join(",");
  const env = {
    ...process.env,
    DEVPRO_POST_PR_COMPLETION_STATE_DIR: fixture.stateDir,
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: per(BRANCH),
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: per(fixture.headSha),
    ...extraEnv,
  };
  return spawnSync("node", [STOP_HOOK], { cwd: fixture.repo, encoding: "utf8", env });
}

function hardBlock(fixture, options) {
  for (const pr of options?.prs ?? [PR_NUMBER]) addMarker(fixture, pr);
  const result = runStop(fixture, options);
  assert.equal(result.status, 2, `first Stop run hard-blocks; stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.decision, "block", "every scenario keeps the block decision");
  return payload.reason;
}

const markerFiles = (stateDir) => readdirSync(stateDir).filter((name) => name.startsWith("pending-post-pr-completion-") && name.endsWith(".json"));

/** The `Agent-facing next step` block: its header line up to the first blank line. */
function nextStepBlock(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("Agent-facing next step"));
  assert.notEqual(start, -1, `the output carries the agent-facing next step\n${text}`);
  const end = lines.findIndex((line, index) => index > start && line.trim() === "");
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}
const lineOf = (block, prefix) => block.split("\n").find((line) => line.startsWith(prefix)) ?? "";
const linesOf = (block, prefix) => block.split("\n").filter((line) => line.startsWith(prefix));

function assertSingleTlRoute(block) {
  assert.match(block, /^- Status: blocked/m);
  assert.deepEqual(linesOf(block, "- Owner:"), ["- Owner: TL/reviewer。"]);
  assert.equal(block.includes("- Disclosure:"), false, "the retired Disclosure line is not part of the next step");
  const next = linesOf(block, "- Next action:");
  assert.equal(next.length, 1, "exactly one next action");
  assert.match(next[0], /\/devpro:cross-review <PR#>/);
  assert.match(next[0], /\/devpro:pre-pr/);
  assert.match(block, /^- Unblock condition: dispatch 未被 operator-disposed，且 exactly one canonical sticky/m);
  for (const gone of ["Approval requirement:", "Owner after approval:", "Renewal:", "必須在自己的回覆中詢問使用者", "ExternalDisclosureApproval"]) {
    assert.equal(block.includes(gone), false, `the next step no longer contains ${gone}`);
  }
  const order = ["- Owner:", "- Next action:", "- Unblock condition:"].map((label) => block.indexOf(label));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "owner, next action, unblock condition in that order");
}

// Scenario: Pending Same-Repo Marker Gets One TL-Owned Next Step
test("Pending Same-Repo Marker Gets One TL-Owned Next Step: hard-block, TL/reviewer owner, cross-review action, unblock line", () => {
  const fixture = makeFixture();
  const reason = hardBlock(fixture);
  const block = nextStepBlock(reason);
  assertSingleTlRoute(block);
  assert.equal(reason.includes("Approval requirement:"), false);
  assert.equal(reason.includes("Owner after approval:"), false);
  assert.equal(reason.includes("Renewal:"), false);
  assert.equal(markerFiles(fixture.stateDir).length, 1, "the marker stays while the unblock condition does not hold");
});

// Scenario: Next Step Does Not Depend On Approval Evidence
test("Next Step Does Not Depend On Approval Evidence: the next-step text is identical across ledger and lite scope record fixtures", () => {
  const fixtures = {
    "no proposal and no lite scope record": {},
    "N/A ledger": { proposal: NA_PROPOSAL },
    "structured ledger": { proposal: STRUCTURED_PROPOSAL },
    "ledger that cannot be parsed": { proposal: BROKEN_PROPOSAL },
    "lite scope record without a proposal": { liteScope: LITE_SCOPE_LINE },
    "structured ledger and lite scope record": { proposal: STRUCTURED_PROPOSAL, liteScope: LITE_SCOPE_LINE },
  };
  const blocks = Object.entries(fixtures).map(([label, setup]) => [label, nextStepBlock(hardBlock(makeFixture(setup)))]);
  const [firstLabel, expected] = blocks[0];
  assertSingleTlRoute(expected);
  for (const [label, block] of blocks.slice(1)) {
    assert.equal(block, expected, `${label} differs from ${firstLabel}`);
  }
});

// Scenario: Builder Refusals Route To The AI Or The User
test("Builder Refusals Route To The AI Or The User: lite_proposal_present goes to the AI, pr_repository_mismatch goes to the user", () => {
  const reason = hardBlock(makeFixture());
  const block = nextStepBlock(reason);
  const routing = lineOf(block, "- Builder 拒絕分流");
  assert.notEqual(routing, "", "the next step carries the builder refusal routing line");
  const [aiPart, userPart] = routing.split("；").reduce(
    (acc, part) => {
      acc[part.includes("pr_repository_mismatch") ? 1 : 0].push(part);
      return acc;
    },
    [[], []]
  ).map((parts) => parts.join("；"));
  assert.ok(aiPart.includes("lite_proposal_present"), "lite_proposal_present is routed with the AI-repair refusals");
  assert.equal(/disclosure_notice_|告知行/.test(routing), false, "the retired notice-line refusals are no longer routed");
  assert.match(aiPart, /AI 修正後重跑 builder/);
  assert.match(aiPart, /不問使用者/);
  assert.match(userPart, /停下.*問使用者/);
  assert.match(userPart, /不派第二審/);
  assert.equal(aiPart.includes("pr_repository_mismatch"), false);
  assert.equal(userPart.includes("lite_proposal_present"), false);
  for (const gone of ["lite_batch_", "lite_approval_", "授權類拒絕", "續期", "--lite-batch-approval"]) {
    assert.equal(reason.includes(gone), false, `${gone} belongs to the removed grant flow`);
  }
});

// Scenario: Hard Block Still Holds Without Any Approval Check
test("Hard Block Still Holds Without Any Approval Check: block decision, marker kept, repeat Stop downgrades to a soft reminder", () => {
  const fixture = makeFixture({ proposal: BROKEN_PROPOSAL });
  const first = hardBlock(fixture);
  assert.match(first, /Post-PR completion gate hard-block/);
  assertSingleTlRoute(nextStepBlock(first));
  assert.equal(markerFiles(fixture.stateDir).length, 1, "the unblock condition does not hold, so the marker stays");

  const second = runStop(fixture);
  assert.equal(second.status, 0, `repeat Stop soft-reminds; stderr: ${second.stderr}`);
  const message = JSON.parse(second.stdout).systemMessage;
  assert.match(message, /Stop hook loop/);
  assertSingleTlRoute(nextStepBlock(message));
  assert.equal(message.includes("Approval requirement:"), false);
  assert.equal(markerFiles(fixture.stateDir).length, 1, "the soft reminder does not clear the marker");
});

// Scenario: All-External Turn Keeps The External Evaluator Next Step
test("All-External Turn Keeps The External Evaluator Next Step: the external-evaluator next step, no Disclosure line, no cross-review next action", () => {
  const fixture = makeFixture();
  const markerFile = addMarker(fixture, PR_NUMBER, {
    repositorySlug: OWNER_REPO,
    headRefOid: fixture.headSha,
    expectedDispatchId: "dispatch-ext-3101",
    executorKind: "external-evaluator",
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);
  const result = runStop(fixture, { extraEnv: { DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(fixture.stateDir, "control-evidence") } });
  assert.equal(result.status, 2, `an unaccepted external marker hard-blocks; stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const reason = JSON.parse(result.stdout).reason;
  const block = nextStepBlock(reason);
  assert.match(block, /^- Owner: TL（external evaluator 審查單驗收人）。/m);
  assert.match(block, /^- Next action: 見下方 external evaluator 審查單 pending 清單各列的 next action。/m);
  assert.match(block, /^- Unblock condition: 只認 TL 執行 accept helper 產生的第四形 completion receipt/m);
  assert.equal(block.includes("- Disclosure:"), false);
  assert.equal(reason.includes("- Disclosure:"), false);
  assert.equal(reason.includes("/devpro:cross-review <PR#>"), false, "no cross-review next action for an external-evaluator turn");
  assert.equal(reason.includes("- Builder 拒絕分流"), false);
  assert.equal(existsSync(markerFile), true, "the marker is retained");
});

// Scenario: Blocked Post-PR Final Names TL-Owned Cross-Review
test("Blocked Post-PR Final Names TL-Owned Cross-Review: TL/reviewer owner and one cross-review step with no approval step before it", () => {
  const block = nextStepBlock(hardBlock(makeFixture()));
  assert.match(block, /^- Status: blocked；不得宣告 ready \/ complete \/ mergeable。/m);
  const lines = block.split("\n");
  const nextIndex = lines.findIndex((line) => line.startsWith("- Next action:"));
  const before = lines.slice(0, nextIndex).join("\n");
  assert.doesNotMatch(before, /詢問使用者|核准|approval/i, "no disclosure approval step sits before the next action");
  assert.match(lines[nextIndex], /^- Next action: 直接跑 `\/devpro:cross-review <PR#>`/);
  assert.match(block, /last_reviewed_sha == headRefOid/);
  assert.match(block, /WARN.*completion receipt/);

  // A final response that follows this next step names TL/reviewer, so the shape gate asks for no user options.
  const finalResponse = [
    "Status: blocked",
    "Blocker: PR 尚無 current-head PASS / WARN sticky",
    "Owner: TL/reviewer",
    "Next step: /devpro:cross-review <PR#>",
    "Unblock condition: exactly one canonical sticky 的 verdict PASS，last_reviewed_sha == headRefOid",
  ].join("\n");
  const shape = checkStopPointHandoffShape({ messageText: finalResponse });
  assert.equal(shape.shouldBlock, false);
  assert.equal(shape.trigger, "");
});

// Scenario: Stop Hook Next Step Names A Single TL-Owned Route
test("Stop Hook Next Step Names A Single TL-Owned Route: one owner, one next action, no approval-requirement line, hard-block until unblocked", () => {
  const fixture = makeFixture({ proposal: STRUCTURED_PROPOSAL });
  const reason = hardBlock(fixture);
  const block = nextStepBlock(reason);
  assertSingleTlRoute(block);
  assert.equal(reason.includes("Approval requirement"), false);
  assert.match(reason, /Post-PR completion gate hard-block/);
  assert.equal(markerFiles(fixture.stateDir).length, 1, "the hard-block holds, marker kept");

  const soft = JSON.parse(runStop(fixture).stdout).systemMessage;
  assert.equal(nextStepBlock(soft), block, "the soft reminder carries the same single route");
});

// Scenario: Cross-Repo PR Blocked Response Is User-Owned
test("Cross-Repo PR Blocked Response Is User-Owned: the refusal routes to the user and the final response needs the stop-point-comms shape", () => {
  const block = nextStepBlock(hardBlock(makeFixture()));
  const routing = lineOf(block, "- Builder 拒絕分流");
  assert.match(routing, /pr_repository_mismatch/);
  assert.match(routing, /使用者/);
  assert.match(routing, /stop-point-comms\.md/);
  assert.match(routing, /編號選項/);
  assert.match(routing, /末項開放/);

  const crossRepoStop = [
    "Status: blocked",
    "Blocker: builder 拒絕 pr_repository_mismatch（cross-repo PR）",
    "Owner: user",
  ].join("\n");
  const bare = checkStopPointHandoffShape({ messageText: crossRepoStop });
  assert.equal(bare.shouldBlock, true, "labels alone do not satisfy the user-owned stop");
  assert.equal(bare.trigger, "Owner: user");
  const lastNotOpen = checkStopPointHandoffShape({
    messageText: [
      crossRepoStop,
      "為什麼停：這是 cross-repo PR，第二審不能照 same-repo 流程派送。",
      "要你做什麼（回數字）：",
      "1. 是，改由你處理這個 PR 的第二審",
      "2. 否，先停著",
      "回了會怎樣：回 1 我等你；回 2 我先停著。",
    ].join("\n"),
  });
  assert.equal(lastNotOpen.shouldBlock, true);
  assert.match(lastNotOpen.message, /open-ended last option/);
  const full = checkStopPointHandoffShape({
    messageText: [
      crossRepoStop,
      "為什麼停：這是 cross-repo PR，builder 拒絕 pr_repository_mismatch，第二審怎麼處理要你決定。",
      "要你做什麼（回數字）：",
      "1. 是，你指定第二審的處理方式（例如走 waiver）",
      "2. 否，先停著",
      "3. 其他",
      "回了會怎樣：回 1 我照你的指定處理；回 2 我先停著；回 3 我照你的說明調整。",
    ].join("\n"),
  });
  assert.equal(full.shouldBlock, false);
  assert.equal(full.trigger, "stop-point handoff label");
});

// Scenario: Builder Refusals Route To The AI Or The User
test("Cross-repo PR stops with pr_repository_mismatch and goes to the user: the Stop hook routes a pr_repository_mismatch refusal to the user, not to an AI fix-and-rerun", () => {
  const reason = hardBlock(makeFixture());
  const routing = lineOf(nextStepBlock(reason), "- Builder 拒絕分流");
  const userClause = routing.split("；").find((part) => part.includes("pr_repository_mismatch")) ?? "";
  assert.match(userClause, /停下.*問使用者/, "pr_repository_mismatch means stop and ask the user");
  assert.equal(/AI 修正後重跑/.test(userClause), false, "it is not an AI fix-and-rerun refusal");
  const aiClauses = routing.split("；").filter((part) => !part.includes("pr_repository_mismatch")).join("；");
  assert.equal(aiClauses.includes("pr_repository_mismatch"), false);
});

// Scenario: Default flow produces no user-wait stop point for same-repo second review
test("Default flow produces no user-wait stop point for same-repo second review: TL/reviewer owns the pending dispatch and no user answer is awaited", () => {
  const block = nextStepBlock(hardBlock(makeFixture()));
  assert.deepEqual(linesOf(block, "- Owner:"), ["- Owner: TL/reviewer。"]);
  assert.doesNotMatch(block, /Owner:\s*(?:user|使用者)/i);
  assert.doesNotMatch(block, /Approval|approval|詢問使用者/, "no wait for disclosure consent");
  assert.match(lineOf(block, "- Next action:"), /直接跑 `\/devpro:cross-review <PR#>`/);

  // The hook's own text is not a user-owned stop for the shape gate either.
  const shape = checkStopPointHandoffShape({ messageText: block });
  assert.equal(shape.shouldBlock, false);
  assert.equal(shape.trigger, "");
});

// Scenario: Same-repo second review remains a merge gate
test("Same-repo second review remains a merge gate: the Stop hook keeps its hard-block until the post-PR completion evidence is satisfied", () => {
  const fixture = makeFixture();
  addMarker(fixture, PR_NUMBER);
  const blocked = runStop(fixture);
  assert.equal(blocked.status, 2, `no sticky for the current head: still hard-blocked; stdout: ${blocked.stdout}`);
  assert.equal(JSON.parse(blocked.stdout).decision, "block");
  assert.equal(markerFiles(fixture.stateDir).length, 1);

  const satisfied = runStop(fixture, { extraEnv: { DEVPRO_POST_PR_GATE_MOCK_STICKY: String(PR_NUMBER) } });
  assert.equal(satisfied.status, 0, `a current-head PASS sticky satisfies the evidence; stdout: ${satisfied.stdout}\nstderr: ${satisfied.stderr}`);
  assert.equal(markerFiles(fixture.stateDir).length, 0, "the marker clears only once the evidence exists");
});
