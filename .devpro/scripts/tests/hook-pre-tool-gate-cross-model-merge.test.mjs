import "./lib/git-location-isolated-env.mjs";
import "./lib/isolated-control-evidence-state.mjs";
/**
 * hook-pre-tool-gate-cross-model-merge.test.mjs
 *
 * TDD tests for checkCrossModelMergeGate (Gate: cross-model merge gate) in
 * pre-tool-gate.mjs.
 *
 * Tests cover FR-6 paths A-F + edge cases per proposal.md Section 1 done-when #2:
 *   Path A — diff has no proposal.md → chore-A exempt (default-on design)
 *   Path A — branch matches exempt set (chore/bump-v*, rules-sync, release/*) → pass
 *   Path B — diff has proposal.md (non-exempt branch), sticky absent → block
 *   Path C — sticky present, verdict parse fail → block
 *   Path D — sticky present, last_reviewed_sha ≠ headRefOid → block
 *   Path E — sticky verdict: CRITICAL → block
 *   Path F — sticky verdict: PASS | WARN → pass
 *   Path U — sticky verdict: UNAVAILABLE → block
 *   + chore/bump-v* exemption (FR-9 / AC-9)
 *   + multiple sticky comments edge case (fail-closed)
 *   + non-merge command pass-through
 *   + idempotency (NFR-7)
 *
 * Default-on design (T1):
 *   The gate is now DEFAULT-ON — every PR requires cross-model review unless
 *   it is explicitly exempted. Exemptions:
 *     1. Branch-pattern: chore/bump-v*, rules/<source>-v*, release/v*, release/<date>-<sha>,
 *        release/rules-<date>
 *     2. Diff-shape (chore-A class): PR diff contains NO openspec/changes/<name>/proposal*.md
 *        -> treated as mechanical chore, exempt (D1).
 *   To test "requires review" scenarios, diffFiles MUST include a proposal.md path.
 *
 * Mock strategy:
 *   The production code reads `CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT` env var to
 *   inject `gh pr view --json comments,headRefOid` output in tests. This avoids
 *   spawning real gh CLI.
 *   Branch detection uses `CROSS_MODEL_MERGE_GATE_MOCK_BRANCH` env var.
 *   PR diff uses `CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES` env var
 *   (newline-separated list of changed files).
 *
 * Convention: all test fixtures use fictitious PR #9999 at
 *   https://github.com/example/repo/pull/9999 to avoid hitting real GitHub.
 */

import { test, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./lib/portable-command-shims.cjs";
import { makeTempDir } from "./lib/tmp.mjs";
import { repoPath } from "./lib/repo-root.mjs";
import { runHook as runHarnessHook } from "./lib/hook-harness.mjs";

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/pre-tool-gate.mjs"
);

// Named imports for direct unit tests (C1-residual-2 / C1-residual-3)
// checkCrossModelMergeGate is imported for the in-process fast path (perf
// refactor): the gate reads its mocks straight from process.env and returns
// null (pass) | {block, reason}, so most cases call it directly instead of
// spawning the full hook. The few cases that assert the end-to-end hook
// contract (always exit 0, stdout JSON shape) keep using runHookSpawn().
import {
  _extractPrNumber,
  _extractRepoFlag,
  GH_PR_MERGE_VALUE_TAKING_FLAGS,
  GH_PR_CHECKS_VALUE_TAKING_FLAGS,
  checkCrossModelMergeGate,
  evaluatePreToolUsePayload,
  _getPrChangedFiles,
  _getPrChangedFileEntries,
  isCrossModelExempt,
  _withPrChangedFilesMemo,
} from "../hooks/pre-tool-gate.mjs";
import { toExemptionInput } from "../lib/changed-file-status.mjs";

const tmpRoot = makeTempDir("cross-model-merge-test-");
after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

// Keep a transcript-shaped payload fixture for host compatibility; PreToolUse no
// longer parses transcript text for merge readiness.
const FAKE_TRANSCRIPT_PATH = path.join(tmpRoot, "fake-transcript.txt");
writeFileSync(
  FAKE_TRANSCRIPT_PATH,
  "Totals: 42 passed, 0 failed\n"
);

// ── Constants (must match production code) ────────────────────────────────

const MAGIC_MARKER = "<!-- cross-model-second-opinion:sticky -->";
const TRIGGER_PATH = ".devpro/agent-rules/code-review-checklist.md";
const NON_TRIGGER_PATH = "docs/random.md";
const PR_NUMBER = "9999";
// The cross-repo merge gate wants the repository of every merge written in full, and the whole-hook cases run it in
// SOURCE_CHECKOUT, a checkout whose origin is that repository with no global or system git configuration, so they reach
// the sticky gate from any clone of this repository (a fork, an ssh alias, an insteadOf rewrite) (PR #3703 r3 F6).
const SOURCE_REPO_FLAG = "--repo github.com/devpro-tw/devpro-agent-rules";
const GIT_ISOLATION = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const SOURCE_CHECKOUT = path.join(tmpRoot, "source-origin-checkout");
mkdirSync(SOURCE_CHECKOUT);
for (const args of [["init", "-q"], ["remote", "add", "origin", "https://github.com/devpro-tw/devpro-agent-rules.git"]]) {
  assert.equal(spawnSync("git", ["-C", SOURCE_CHECKOUT, ...args], { env: { ...process.env, ...GIT_ISOLATION } }).status, 0, args.join(" "));
}
const CURRENT_SHA = "abc1234def5678901234567890abcdef01234567";
const OLD_SHA = "999oldsha000000000000000000000000000000";

// Default-on reframe: to simulate a PR that requires cross-model review,
// the diff must contain a proposal.md (otherwise chore-A exempt applies).
const PROPOSAL_PATH = "openspec/changes/test-change/proposal.md";
const TRIGGER_PATH_WITH_PROPOSAL = `${TRIGGER_PATH}\n${PROPOSAL_PATH}`;

// ── Fixture builders ──────────────────────────────────────────────────────

/**
 * Build a PR JSON response for gh pr view --json comments,headRefOid,headRefName.
 * @param {Array<{body: string, url?: string, id?: string}>} comments
 * @param {string} headRefOid
 * @param {string} headRefName
 */
function buildPrJson({ comments = [], headRefOid = CURRENT_SHA, headRefName = "chore/some-feature", body } = {}) {
  return JSON.stringify({
    headRefOid,
    headRefName,
    ...(body === undefined ? {} : { body }),
    comments: comments.map((c, i) => ({
      id: c.id || `C_${i}`,
      url: c.url || `https://github.com/example/repo/pull/${PR_NUMBER}#issuecomment-${i}`,
      body: c.body,
    })),
  });
}

/**
 * Build a sticky comment body with the given fields.
 */
function buildStickyBody({
  verdict = "PASS",
  lastReviewedSha = CURRENT_SHA,
  includeMarker = true,
  includeVerdict = true,
  includeLastReviewedSha = true,
  reason = "",
} = {}) {
  const lines = [];
  if (includeMarker) lines.push(MAGIC_MARKER);
  lines.push("## Cross-Model Second Opinion Review");
  lines.push("");
  lines.push("Some review content here.");
  lines.push("");
  if (includeVerdict) lines.push(`verdict: ${verdict}`);
  if (includeLastReviewedSha) lines.push(`last_reviewed_sha: ${lastReviewedSha}`);
  lines.push("dispatch_id: dispatch-merge-gate-test");
  lines.push(`reason: ${reason || "The bounded review completed for the requested scope."}`);
  lines.push("Rules: v6.83.10 · Tool: Claude Code · Model: claude-test");
  return lines.join("\n");
}

function duplicateStickyAuthority(body, authority) {
  const lines = body.split("\n");
  const marker = lines[0];
  const footer = lines.at(-1);
  const mutations = {
    marker: () => lines.splice(1, 0, marker),
    verdict: () => lines.splice(lines.indexOf("verdict: PASS") + 1, 0, "verdict: PASS"),
    last_reviewed_sha: () => lines.splice(
      lines.findIndex((line) => line.startsWith("last_reviewed_sha:")) + 1,
      0,
      `last_reviewed_sha: ${CURRENT_SHA}`
    ),
    dispatch_id: () => lines.splice(
      lines.findIndex((line) => line.startsWith("dispatch_id:")) + 1,
      0,
      "dispatch_id: dispatch-merge-gate-test"
    ),
    reason: () => lines.splice(
      lines.findIndex((line) => line.startsWith("reason:")) + 1,
      0,
      "reason: The bounded review completed for the requested scope."
    ),
    rules: () => lines.splice(lines.length - 1, 0, footer),
    tool: () => lines.splice(lines.length - 1, 0, "Tool: Claude Code"),
    model: () => lines.splice(lines.length - 1, 0, "Model: claude-test"),
  };
  mutations[authority]();
  return lines.join("\n");
}

// ── runHook helper ────────────────────────────────────────────────────────

// Env keys the cross-model merge gate reads from process.env. The in-process
// path sets these before calling the gate and restores them afterwards so a
// shared process.env never leaks mocks across tests.
const CM_MOCK_ENV_KEYS = [
  "CROSS_MODEL_MERGE_GATE_MOCK_BRANCH",
  "CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES",
  "CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT",
  "CROSS_MODEL_MERGE_GATE_MOCK_REST_COMMENTS",
];

/**
 * In-process fast path: set the gate's env mocks, call checkCrossModelMergeGate
 * directly, then restore env. Returns the same shape as the spawn path so test
 * assertions (r.json?.decision / r.json?.reason) are unchanged:
 *   gate returns null            → pass  → { json: null }
 *   gate returns {block, reason} → block → { json: { decision: "block", reason } }
 *
 * Use runHookSpawn() instead when a test must assert the end-to-end hook
 * contract (process exit code, stdout JSON emission).
 */
function runHook(command, {
  ghOutput = null,
  branch = "chore/some-feature",
  diffFiles = TRIGGER_PATH,
  extraEnv = {},
} = {}) {
  const saved = {};
  for (const k of CM_MOCK_ENV_KEYS) saved[k] = process.env[k];
  for (const k of Object.keys(extraEnv)) {
    if (!(k in saved)) saved[k] = process.env[k];
  }
  try {
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_BRANCH = branch;
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES = diffFiles;
    if (ghOutput !== null) {
      process.env.CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT = ghOutput;
    } else {
      delete process.env.CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT;
    }
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }

    const result = checkCrossModelMergeGate(command, process.cwd());
    const json =
      result && result.block
        ? { decision: "block", reason: result.reason }
        : null;
    return { code: 0, json };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * Spawn path (end-to-end). Runs the full hook in a child process so a test can
 * assert the hook contract: always exit 0, decision delivered via stdout JSON.
 */
function runHookSpawn(command, {
  ghOutput = null,
  branch = "chore/some-feature",
  diffFiles = TRIGGER_PATH,
  transcriptPath = FAKE_TRANSCRIPT_PATH,
  extraEnv = {},
} = {}) {
  const env = {
    ...process.env,
    CODEX_CI: "",
    CODEX_THREAD_ID: "",
    DEVPRO_SENTINEL_STATE_DIR: makeTempDir("sentinel-cm-"),
    // Isolate marker state dirs: `gh pr merge` here writes postmerge + recap-pending
    // markers; without isolation they leak into the real repo state dir and the
    // Stop hooks later surface fixture branches (e.g. chore/some-feature) as if they
    // were real merges. (fix-stop-hook-noise R1)
    DEVPRO_POSTMERGE_STATE_DIR: makeTempDir("postmerge-cm-"),
    DEVPRO_RECAP_PENDING_DIR: makeTempDir("recap-pending-cm-"),
    DEVPRO_RECAP_STATE_DIR: makeTempDir("recap-state-cm-"),
    CROSS_MODEL_MERGE_GATE_MOCK_BRANCH: branch,
    CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: diffFiles,
    ...GIT_ISOLATION,
    ...extraEnv,
  };
  if (ghOutput !== null) {
    env.CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT = ghOutput;
  }

  const payload = {
    cwd: SOURCE_CHECKOUT,
    tool_name: "Bash",
    tool_input: { command },
    transcript_path: transcriptPath,
  };

  const result = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd: SOURCE_CHECKOUT,
    env,
  });

  let json = null;
  if (result.stdout && result.stdout.trim()) {
    try {
      json = JSON.parse(result.stdout);
    } catch {
      // not JSON
    }
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

// ── Test cases ────────────────────────────────────────────────────────────

test("local review PR head is rejected from authoritative GitHub state before diff exemptions", () => {
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput: buildPrJson({ headRefName: "review/pr41" }),
    diffFiles: NON_TRIGGER_PATH,
    branch: "chore/some-unrelated",
  });
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /local.review|僅本機/i);
});

// 1. Path A variant: diff has no proposal.md → chore-A exempt → pass
// (default-on reframe: semantics changed from "trigger path not hit" to
// "diff contains no openspec/changes/*/proposal*.md → chore-A fast-track exempt per D1")
// ── Issue #3602: REST re-read closes the just-posted waiver window ───────
// Scenario: A waiver missing from the GraphQL snapshot is found by the REST re-read
// Scenario: A re-read without review authority blocks with a read-lag hint
// Scenario: An unavailable re-read keeps the fail-closed block
// Scenario: The re-read only widens the evidence set

const WAIVER_MARKER = "<!-- devpro-cross-model-waiver -->";
const STALE_HEAD = "73d304c3a405548bec7b761e63b713edeb252a2d";

function waiverBody(head) {
  return [WAIVER_MARKER, `waived_head_sha: ${head}`, "granted_by: repo-owner", "reason: user waived this PR"].join("\n");
}

function restComment(body) {
  // Raw REST shape (`user.login`, snake_case, `html_url`) — the production helper must normalise it.
  return { id: 424242, body, user: { login: "repo-owner" }, author_association: "OWNER", html_url: "https://github.com/example/repo/pull/9999#issuecomment-424242" };
}

function restPages(comments) {
  return JSON.stringify([comments]);
}

function staleSnapshot() {
  return JSON.stringify({
    headRefOid: STALE_HEAD,
    headRefName: "chore/some-feature",
    baseRefName: "main",
    state: "OPEN",
    comments: [],
  });
}

test("issue #3602: waiver absent from the GraphQL snapshot is found by the REST re-read", () => {
  const r = runHook("gh pr merge 9999 --merge", {
    ghOutput: staleSnapshot(),
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,
    extraEnv: { CROSS_MODEL_MERGE_GATE_MOCK_REST_COMMENTS: restPages([restComment(waiverBody(STALE_HEAD))]) },
  });
  assert.equal(r.json, null, `REST re-read must surface the fresh waiver; got ${JSON.stringify(r.json)}`);
});

test("issue #3602: an empty REST re-read blocks and says the read may lag instead of claiming no waiver exists", () => {
  const r = runHook("gh pr merge 9999 --merge", {
    ghOutput: staleSnapshot(),
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,
    extraEnv: { CROSS_MODEL_MERGE_GATE_MOCK_REST_COMMENTS: JSON.stringify([]) },
  });
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /已用 REST 重讀一次 PR comments/);
  assert.match(r.json.reason, /不要重貼同一份 comment/);
});

test("issue #3602: the read-lag hint also fires when other comments exist but no waiver is among them", () => {
  const r = runHook("gh pr merge 9999 --merge", {
    ghOutput: staleSnapshot(),
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,
    extraEnv: {
      CROSS_MODEL_MERGE_GATE_MOCK_REST_COMMENTS: restPages([{ id: 1, body: "just a normal comment", user: { login: "someone" }, author_association: "NONE" }]),
    },
  });
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /已用 REST 重讀一次 PR comments/);
});

test("issue #3602: a mocked pr view without a mocked REST result keeps the fail-closed block and adds no read-lag hint", () => {
  const r = runHook("gh pr merge 9999 --merge", { ghOutput: staleSnapshot(), diffFiles: TRIGGER_PATH_WITH_PROPOSAL });
  assert.equal(r.json?.decision, "block");
  assert.ok(!/已用 REST 重讀一次 PR comments/.test(r.json.reason));
});

test("CM-1: Path A — diff has no proposal.md → chore-A exempt → pass", () => {
  const ghOutput = buildPrJson({
    comments: [],
    headRefOid: CURRENT_SHA,
    headRefName: "chore/some-unrelated",
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: NON_TRIGGER_PATH,  // no proposal.md → chore-A exempt
    branch: "chore/some-unrelated",
  });
  assert.ok(
    r.json?.decision !== "block",
    `expected pass (chore-A exempt: no proposal in diff), got: ${JSON.stringify(r.json)}`
  );
});

// 2. Path A variant: chore/bump-v* PR headRefName + trigger hit → pass (FR-9 / AC-9)
test("CM-2: Path A variant — chore/bump-v1.2.3 PR headRefName + trigger hit → pass (FR-9 exemption)", () => {
  // Even with trigger path hit, bump-v* PRs are exempt (exemption keyed on PR headRefName, not local branch)
  const ghOutput = JSON.stringify({
    headRefOid: CURRENT_SHA,
    headRefName: "chore/bump-v1.2.3",
    comments: [],
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH,
    branch: "chore/bump-v1.2.3",
  });
  assert.ok(
    r.json?.decision !== "block",
    `chore/bump-v* PR should be exempt from cross-model gate, got: ${JSON.stringify(r.json)}`
  );
});

// 3. Path B: diff includes proposal.md → not chore-A exempt → enters sticky check.
//    No sticky comment present → block + /devpro:cross-review hint.
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters sticky check)
test("CM-3: Path B — diff includes proposal.md, sticky absent → block with /devpro:cross-review hint", () => {
  const ghOutput = buildPrJson({ comments: [], headRefOid: CURRENT_SHA });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
    branch: "chore/add-feature",
  });
  assert.equal(r.json?.decision, "block",
    `expected block, got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /cross-review|devpro:cross-review/i,
    `reason should mention /devpro:cross-review: ${r.json?.reason}`);
  // Issue #3574: the block must name the sanctioned quota ladder and must not
  // let the generic bypass hint read as the sanctioned way out.
  assert.match(r.json.reason, /quota-unavailable/,
    `reason should name quota-unavailable: ${r.json?.reason}`);
  assert.match(r.json.reason, /不是 sanctioned 解除路徑/,
    `reason should say the bypass prefix is not the sanctioned route: ${r.json?.reason}`);
});

// 4. Path C: sticky exists but no verdict: line → block.
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters sticky check)
test("CM-4: Path C — sticky present, verdict line absent → block", () => {
  const stickyBody = [
    MAGIC_MARKER,
    "## Cross-Model Second Opinion Review",
    "",
    "Some review content here.",
    "",
    // No verdict: line
    `last_reviewed_sha: ${CURRENT_SHA}`,
  ].join("\n");
  const ghOutput = buildPrJson({
    comments: [{ body: stickyBody }],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
  });
  assert.equal(r.json?.decision, "block",
    `expected block when verdict line missing, got: ${JSON.stringify(r.json)}`);
});

// 4b. Path C variant: sticky has verdict but invalid enum value → block.
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters sticky check)
test("CM-4b: Path C variant — verdict value not in enum → block", () => {
  const stickyBody = buildStickyBody({ verdict: "UNKNOWN_VALUE" });
  const ghOutput = buildPrJson({
    comments: [{ body: stickyBody }],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
  });
  assert.equal(r.json?.decision, "block",
    `expected block when verdict enum invalid, got: ${JSON.stringify(r.json)}`);
});

test("CM-4c: Path C variant — markdown-emphasized verdict line is malformed → block", () => {
  const stickyBody = [
    MAGIC_MARKER,
    "## Cross-Model Second Opinion Review",
    "",
    "**verdict: PASS**",
    `last_reviewed_sha: ${CURRENT_SHA}`,
  ].join("\n");
  const ghOutput = buildPrJson({
    comments: [{ body: stickyBody }],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,
  });
  assert.equal(r.json?.decision, "block",
    `expected block when verdict schema is markdown-wrapped, got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /verdict/i);
});

test("CM-4d: Path C variant — duplicate verdict machine fields fail closed", () => {
  const cases = [
    {
      name: "identical verdicts",
      verdictLines: ["verdict: PASS", "verdict: PASS"],
    },
    {
      name: "conflicting verdicts",
      verdictLines: ["verdict: PASS", "verdict: WARN"],
    },
  ];

  for (const { name, verdictLines } of cases) {
    const stickyBody = [
      MAGIC_MARKER,
      "## Cross-Model Second Opinion Review",
      "",
      ...verdictLines,
      `last_reviewed_sha: ${CURRENT_SHA}`,
    ].join("\n");
    const ghOutput = buildPrJson({
      comments: [{ body: stickyBody }],
      headRefOid: CURRENT_SHA,
    });
    const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
      ghOutput,
      diffFiles: TRIGGER_PATH_WITH_PROPOSAL,
    });

    assert.equal(
      r.json?.decision,
      "block",
      `${name} must not be resolved by selecting the first verdict: ${JSON.stringify(r.json)}`
    );
    assert.match(r.json.reason, /verdict/i);
  }
});

// 5. Path C variant: sticky exists but no last_reviewed_sha: line → block (NFR-2).
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters sticky check)
test("CM-5: Path C variant — sticky missing last_reviewed_sha → block (fail-closed)", () => {
  const stickyBody = buildStickyBody({
    verdict: "PASS",
    includeLastReviewedSha: false,
  });
  const ghOutput = buildPrJson({
    comments: [{ body: stickyBody }],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
  });
  assert.equal(r.json?.decision, "block",
    `expected block when last_reviewed_sha missing, got: ${JSON.stringify(r.json)}`);
});

test("CM-5b: Path C variant — code-spanned last_reviewed_sha line is malformed → block", () => {
  const stickyBody = [
    MAGIC_MARKER,
    "## Cross-Model Second Opinion Review",
    "",
    "verdict: PASS",
    `\`last_reviewed_sha: ${CURRENT_SHA}\``,
  ].join("\n");
  const ghOutput = buildPrJson({
    comments: [{ body: stickyBody }],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,
  });
  assert.equal(r.json?.decision, "block",
    `expected block when last_reviewed_sha schema is code-spanned, got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /last_reviewed_sha/i);
});

test("CM-5c: Path C variant — duplicate last_reviewed_sha machine fields fail closed", () => {
  const cases = [
    {
      name: "identical last_reviewed_sha values",
      shaLines: [
        `last_reviewed_sha: ${CURRENT_SHA}`,
        `last_reviewed_sha: ${CURRENT_SHA}`,
      ],
    },
    {
      name: "conflicting last_reviewed_sha values",
      shaLines: [
        `last_reviewed_sha: ${CURRENT_SHA}`,
        `last_reviewed_sha: ${OLD_SHA}`,
      ],
    },
  ];

  for (const { name, shaLines } of cases) {
    const stickyBody = [
      MAGIC_MARKER,
      "## Cross-Model Second Opinion Review",
      "",
      "verdict: PASS",
      ...shaLines,
    ].join("\n");
    const ghOutput = buildPrJson({
      comments: [{ body: stickyBody }],
      headRefOid: CURRENT_SHA,
    });
    const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
      ghOutput,
      diffFiles: TRIGGER_PATH_WITH_PROPOSAL,
    });

    assert.equal(
      r.json?.decision,
      "block",
      `${name} must not be resolved by selecting the first SHA: ${JSON.stringify(r.json)}`
    );
    assert.match(r.json.reason, /last_reviewed_sha/i);
  }
});

// 6. Path D: sticky has stale last_reviewed_sha → block + re-run hint.
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters sticky check)
test("CM-6: Path D — stale last_reviewed_sha ≠ headRefOid → block with re-run hint", () => {
  const stickyBody = buildStickyBody({ verdict: "PASS", lastReviewedSha: OLD_SHA });
  const ghOutput = buildPrJson({
    comments: [{ body: stickyBody }],
    headRefOid: CURRENT_SHA, // different from OLD_SHA
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
  });
  assert.equal(r.json?.decision, "block",
    `expected block when sha stale, got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /re-run|stale|sha/i,
    `reason should mention re-run or stale sha: ${r.json?.reason}`);
});

test("CM-6b: Path D — stale last_reviewed_sha not equal to current head still blocks until current-head review", () => {
  const stickyBody = buildStickyBody({
    verdict: "WARN",
    lastReviewedSha: OLD_SHA,
    reason: "Old reviewed head SHA string does not equal the current PR head SHA string.",
  });
  const ghOutput = buildPrJson({
    comments: [{ body: stickyBody }],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,
  });
  assert.equal(
    r.json?.decision,
    "block",
    `expected block when reviewed sha string is not equal to current head sha string, got: ${JSON.stringify(r.json)}`
  );
  assert.match(r.json.reason, /last_reviewed_sha/i);
  assert.match(r.json.reason, /headRefOid|current head|stale|sha/i);
});

// 7. Path E: sticky verdict: CRITICAL → block + stderr shows verdict + URL.
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters sticky check)
test("CM-7: Path E — verdict CRITICAL → block with verdict + sticky URL", () => {
  const stickyUrl = `https://github.com/example/repo/pull/${PR_NUMBER}#issuecomment-99`;
  const stickyBody = buildStickyBody({ verdict: "CRITICAL", lastReviewedSha: CURRENT_SHA });
  const ghOutput = buildPrJson({
    comments: [{ body: stickyBody, url: stickyUrl }],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
  });
  assert.equal(r.json?.decision, "block",
    `expected block on CRITICAL verdict, got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /CRITICAL/,
    `reason should mention CRITICAL verdict: ${r.json?.reason}`);
  assert.match(r.json.reason, /github\.com.*example.*repo.*pull|issuecomment/i,
    `reason should contain sticky comment URL: ${r.json?.reason}`);
  assert.doesNotMatch(r.json.reason, /TL Response to Cross-Model Review|comment 回應爭議後再嘗試 merge/,
    `CRITICAL block reason must not advertise a comment-only bypass: ${r.json?.reason}`);
});

// 8. Path F-PASS: sticky verdict: PASS + sha aligned → pass.
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters sticky check → Path F)
test("CM-8: Path F-PASS — verdict PASS + sha aligned → pass", () => {
  const stickyBody = buildStickyBody({ verdict: "PASS", lastReviewedSha: CURRENT_SHA });
  const ghOutput = buildPrJson({
    comments: [{ body: stickyBody }],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt → Path F
  });
  assert.ok(
    r.json?.decision !== "block",
    `expected pass on PASS verdict with aligned sha, got: ${JSON.stringify(r.json)}`
  );
});

// 9. Path F-WARN: sticky verdict: WARN + sha aligned → pass.
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters sticky check → Path F)
test("CM-9: Path F-WARN — verdict WARN + sha aligned → pass", () => {
  const stickyBody = buildStickyBody({ verdict: "WARN", lastReviewedSha: CURRENT_SHA });
  const ghOutput = buildPrJson({
    comments: [{ body: stickyBody }],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt → Path F
  });
  assert.ok(
    r.json?.decision !== "block",
    `expected pass on WARN verdict, got: ${JSON.stringify(r.json)}`
  );
});

test("CM-9-EXACT-ONE: one sticky comment with any duplicate authority carrier fails closed", () => {
  for (const authority of [
    "marker",
    "verdict",
    "last_reviewed_sha",
    "dispatch_id",
    "reason",
    "rules",
    "tool",
    "model",
  ]) {
    const stickyBody = duplicateStickyAuthority(buildStickyBody(), authority);
    const ghOutput = buildPrJson({
      comments: [{ body: stickyBody }],
      headRefOid: CURRENT_SHA,
    });
    const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
      ghOutput,
      diffFiles: TRIGGER_PATH_WITH_PROPOSAL,
    });
    assert.equal(
      r.json?.decision,
      "block",
      `${authority} duplicate must fail closed: ${JSON.stringify(r.json)}`
    );
  }
});

// 10. Path U-UNAVAILABLE: sticky verdict: UNAVAILABLE + reason → block.
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters sticky check)
test("CM-10: Path U-UNAVAILABLE — verdict UNAVAILABLE + reason → block", () => {
  const stickyBody = buildStickyBody({
    verdict: "UNAVAILABLE",
    lastReviewedSha: CURRENT_SHA,
    reason: "codex CLI not installed",
  });
  const ghOutput = buildPrJson({
    comments: [{ body: stickyBody }],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
  });
  assert.equal(r.json?.decision, "block",
    `expected block on UNAVAILABLE verdict, got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /UNAVAILABLE/);
  assert.match(r.json.reason, /not merge approval|不是 merge approval|不是合併核准|human/i);
  assert.match(r.json.reason, /quota-unavailable/,
    `Path U should also name the quota ladder: ${r.json?.reason}`);
  assert.match(r.json.reason, /不是 sanctioned 解除路徑/,
    `Path U should say the bypass prefix is not the sanctioned route: ${r.json?.reason}`);
});

// 11. Multiple sticky comments edge case: fail-closed → block.
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters sticky check)
test("CM-11: Multiple sticky comments → fail-closed block", () => {
  const stickyBody1 = buildStickyBody({ verdict: "PASS", lastReviewedSha: CURRENT_SHA });
  const stickyBody2 = buildStickyBody({ verdict: "WARN", lastReviewedSha: CURRENT_SHA });
  const ghOutput = buildPrJson({
    comments: [
      { body: stickyBody1, id: "C_1" },
      { body: stickyBody2, id: "C_2" },
    ],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
  });
  assert.equal(r.json?.decision, "block",
    `expected fail-closed block on multiple sticky comments, got: ${JSON.stringify(r.json)}`);
  // Should give a clear message about multiple stickies
  assert.ok(
    r.json?.reason && r.json.reason.length > 0,
    `block reason should be non-empty: ${r.json?.reason}`
  );
});

// 12. Non-merge command pass-through: gh pr view / gh pr checks → no trigger
test("CM-12a: Non-merge command gh pr view → pass (not a merge command)", () => {
  const r = runHook(`gh pr view ${PR_NUMBER}`, {
    diffFiles: TRIGGER_PATH,
    branch: "chore/add-feature",
  });
  assert.ok(
    r.json?.decision !== "block" || !r.json?.reason?.includes("cross-model"),
    `gh pr view should not trigger cross-model gate, got: ${JSON.stringify(r.json)}`
  );
});

test("CM-12b: Non-merge command gh pr checks → pass (not a merge command)", () => {
  const r = runHook(`gh pr checks ${PR_NUMBER}`, {
    diffFiles: TRIGGER_PATH,
    branch: "chore/add-feature",
  });
  assert.ok(
    r.json?.decision !== "block" || !r.json?.reason?.includes("cross-model"),
    `gh pr checks should not trigger cross-model gate, got: ${JSON.stringify(r.json)}`
  );
});

// 13. Idempotency: same sticky + same sha called twice → byte-equal behavior (NFR-7).
// (default-on reframe: diff includes proposal.md → not chore-A exempt → exercises Path F idempotency)
test("CM-13: Idempotency — same sticky + same sha twice → same block/pass result", () => {
  const stickyBody = buildStickyBody({ verdict: "PASS", lastReviewedSha: CURRENT_SHA });
  const ghOutput = buildPrJson({
    comments: [{ body: stickyBody }],
    headRefOid: CURRENT_SHA,
  });

  // proposal.md present → not chore-A exempt → exercises the full Path F idempotency
  const opts = { ghOutput, diffFiles: TRIGGER_PATH_WITH_PROPOSAL };
  const cmd = `gh pr merge ${PR_NUMBER} --merge`;

  const r1 = runHook(cmd, opts);
  const r2 = runHook(cmd, opts);

  // Both should have the same decision
  assert.equal(r1.json?.decision, r2.json?.decision,
    `idempotency: second call should have same decision as first call`);
  // Both should pass (PASS verdict, aligned sha)
  assert.ok(
    r1.json?.decision !== "block",
    `expected pass on PASS verdict (run 1), got: ${JSON.stringify(r1.json)}`
  );
  assert.ok(
    r2.json?.decision !== "block",
    `expected pass on PASS verdict (run 2), got: ${JSON.stringify(r2.json)}`
  );
});

// Additional: verify mock injection working - if no mock output is set and
// we have a real trigger, the gate should still handle gracefully.
// (This tests fail-closed when gh CLI cannot be called and no mock is set.)
// End-to-end (spawn): this case asserts the hook process contract (always exit
// 0) and exercises the real-gh fail-closed path with no mock, so it MUST run in
// a child process — keep it on runHookSpawn().
test("CM-bonus: No gh mock output + trigger hit → fail-closed block or handle gracefully", () => {
  // Don't set CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT.
  // Production code should fail-closed (block) when gh CLI output is unavailable
  // in an environment where real gh CLI may not be authenticated.
  // We only assert it doesn't crash (exit 0 is expected per hook contract).
  const r = runHookSpawn(`gh pr merge ${PR_NUMBER} --merge`, {
    diffFiles: TRIGGER_PATH,
    branch: "chore/add-feature",
    extraEnv: {
      // Unset mock to force real path, but override PATH to block real gh
      CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: undefined,
    },
  });
  // Hook must exit cleanly (code 0 per hook contract)
  assert.equal(r.code, 0, `hook must always exit 0, got code: ${r.code}`);
});

// ── C1: Widened GH_PR_MERGE_RE — various `gh pr merge` forms ─────────────

// C1-a: `gh pr merge` with no PR# (current branch resolution via fallback mock).
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters sticky check → block)
test("C1-a: gh pr merge (no #) — fallback to current branch PR# → block (Path B: no sticky)", () => {
  // CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER injects the fallback PR#
  const ghOutput = buildPrJson({ comments: [], headRefOid: CURRENT_SHA });
  const r = runHook("gh pr merge", {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
    branch: "chore/add-feature",
    extraEnv: {
      CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER: PR_NUMBER,
    },
  });
  assert.equal(r.json?.decision, "block",
    `C1-a: gh pr merge (no #) should trigger gate → block (no sticky), got: ${JSON.stringify(r.json)}`);
});

// C1-b: `gh pr merge --merge --auto` (flag-only, no explicit #).
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters sticky check → block)
test("C1-b: gh pr merge --merge --auto (flag-only, no #) → block (Path B: no sticky)", () => {
  const ghOutput = buildPrJson({ comments: [], headRefOid: CURRENT_SHA });
  const r = runHook("gh pr merge --merge --auto", {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
    branch: "chore/add-feature",
    extraEnv: {
      CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER: PR_NUMBER,
    },
  });
  assert.equal(r.json?.decision, "block",
    `C1-b: flag-only merge should trigger gate, got: ${JSON.stringify(r.json)}`);
});

// C1-c: `gh pr merge https://github.com/owner/repo/pull/9999` (URL form).
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters sticky check → block)
test("C1-c: gh pr merge <URL> → block (Path B: no sticky, PR# from URL)", () => {
  const ghOutput = buildPrJson({ comments: [], headRefOid: CURRENT_SHA });
  const r = runHook(`gh pr merge https://github.com/owner/repo/pull/${PR_NUMBER}`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
    branch: "chore/add-feature",
  });
  assert.equal(r.json?.decision, "block",
    `C1-c: URL-form merge should trigger gate, got: ${JSON.stringify(r.json)}`);
});

// C1-d: `gh pr merge --merge 9999` (flag before #).
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters sticky check → block)
test("C1-d: gh pr merge --merge 9999 (flag before #) → block (Path B: no sticky)", () => {
  const ghOutput = buildPrJson({ comments: [], headRefOid: CURRENT_SHA });
  const r = runHook(`gh pr merge --merge ${PR_NUMBER}`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
    branch: "chore/add-feature",
  });
  assert.equal(r.json?.decision, "block",
    `C1-d: flag-before-# merge should trigger gate, got: ${JSON.stringify(r.json)}`);
});

// C1-e: `gh pr merge feature/foo` (branch name, no # — fallback to mock).
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters sticky check → block)
test("C1-e: gh pr merge feature/foo (branch name, no #) → block (Path B: no sticky)", () => {
  const ghOutput = buildPrJson({ comments: [], headRefOid: CURRENT_SHA });
  const r = runHook("gh pr merge feature/foo", {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
    branch: "chore/add-feature",
    extraEnv: {
      CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER: PR_NUMBER,
    },
  });
  assert.equal(r.json?.decision, "block",
    `C1-e: branch-name merge should trigger gate, got: ${JSON.stringify(r.json)}`);
});

// C1-f: fallback fails (no mock current PR# and no digits in cmd) → fail-closed block
test("C1-f: gh pr merge (no #, fallback unavailable) → fail-closed block", () => {
  const r = runHook("gh pr merge", {
    diffFiles: TRIGGER_PATH,
    branch: "chore/add-feature",
    extraEnv: {
      CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER: "",
      // No CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT set, and no real gh
    },
  });
  // Must block (fail-closed) because we can't determine the PR#
  assert.equal(r.json?.decision, "block",
    `C1-f: fallback-fail must be fail-closed block, got: ${JSON.stringify(r.json)}`);
});

// ── C2: _getPrChangedFiles fail-open bugs ─────────────────────────────────

// C2-a: _getPrChangedFiles mock error → caller must block (fail-closed)
test("C2-a: _getPrChangedFiles error (mock error) → fail-closed block", () => {
  const ghOutput = buildPrJson({ comments: [], headRefOid: CURRENT_SHA });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    branch: "chore/add-feature",
    extraEnv: {
      CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES_ERROR: "simulated gh auth error: exit status 1",
      // Override diffFiles to undefined to avoid the normal mock path
      CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: undefined,
    },
  });
  assert.equal(r.json?.decision, "block",
    `C2-a: diff-files error must block (fail-closed), got: ${JSON.stringify(r.json)}`);
  assert.match(r.json?.reason || "", /unable to fetch|PR changed files|diff|fail/i,
    `C2-a: reason should mention fetch failure, got: ${r.json?.reason}`);
});

// C2-b: _getPrChangedFiles mock invalid JSON → caller must block
test("C2-b: _getPrChangedFiles invalid JSON output → fail-closed block", () => {
  const ghOutput = buildPrJson({ comments: [], headRefOid: CURRENT_SHA });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    branch: "chore/add-feature",
    extraEnv: {
      CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES_ERROR: "invalid json: {not json}",
      CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: undefined,
    },
  });
  assert.equal(r.json?.decision, "block",
    `C2-b: diff-files invalid output must block (fail-closed), got: ${JSON.stringify(r.json)}`);
});

// ── C3: chore/bump-v* exemption must use PR headRefName, not local branch ─

// C3-a: local branch = chore/bump-v1.2.3, PR headRefName = feature/foo → MUST block.
// (default-on reframe: diff includes proposal.md → not chore-A exempt → PR headRefName=feature/foo
//  not exempt → enters sticky check → block)
test("C3-a: local=chore/bump-v1.2.3, PR headRefName=feature/foo → MUST block (no exemption)", () => {
  const ghOutput = JSON.stringify({
    headRefOid: CURRENT_SHA,
    headRefName: "feature/foo",
    comments: [],
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
    branch: "chore/bump-v1.2.3",  // local branch is bump, but PR is feature/foo
  });
  assert.equal(r.json?.decision, "block",
    `C3-a: exemption must use PR headRefName, not local branch — should block, got: ${JSON.stringify(r.json)}`);
});

// C3-b: local branch = feature/foo, PR headRefName = chore/bump-v1.2.3 → MUST pass (exempt)
test("C3-b: local=feature/foo, PR headRefName=chore/bump-v1.2.3 → MUST pass (exemption from PR headRefName)", () => {
  const ghOutput = JSON.stringify({
    headRefOid: CURRENT_SHA,
    headRefName: "chore/bump-v1.2.3",
    comments: [],
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH,
    branch: "feature/foo",  // local branch is NOT bump, but PR's head is
  });
  assert.ok(
    r.json?.decision !== "block",
    `C3-b: PR headRefName=chore/bump-v* should be exempt, got: ${JSON.stringify(r.json)}`
  );
});

// ── C4: headRefOid validation — fail-closed on falsy/invalid headRefOid ──

// C4-a: PR JSON headRefOid absent → fail-closed block.
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters sticky check
//  → invalid headRefOid → fail-closed block)
test("C4-a: PR JSON missing headRefOid → fail-closed block", () => {
  const ghOutput = JSON.stringify({
    // headRefOid intentionally omitted
    headRefName: "feature/foo",
    comments: [
      {
        id: "C_0",
        url: `https://github.com/example/repo/pull/${PR_NUMBER}#issuecomment-0`,
        body: buildStickyBody({ verdict: "PASS", lastReviewedSha: CURRENT_SHA }),
      },
    ],
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
    branch: "chore/add-feature",
  });
  assert.equal(r.json?.decision, "block",
    `C4-a: missing headRefOid must be fail-closed block, got: ${JSON.stringify(r.json)}`);
});

// C4-b: PR JSON headRefOid = "" (empty string) → fail-closed block.
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters sticky check
//  → invalid headRefOid → fail-closed block)
test("C4-b: PR JSON headRefOid = empty string → fail-closed block", () => {
  const ghOutput = JSON.stringify({
    headRefOid: "",
    headRefName: "feature/foo",
    comments: [
      {
        id: "C_0",
        url: `https://github.com/example/repo/pull/${PR_NUMBER}#issuecomment-0`,
        body: buildStickyBody({ verdict: "PASS", lastReviewedSha: CURRENT_SHA }),
      },
    ],
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
    branch: "chore/add-feature",
  });
  assert.equal(r.json?.decision, "block",
    `C4-b: empty headRefOid must be fail-closed block, got: ${JSON.stringify(r.json)}`);
});

// C4-c: PR JSON headRefOid = "abcde" (short, invalid sha) → fail-closed block.
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters sticky check
//  → invalid headRefOid → fail-closed block)
test("C4-c: PR JSON headRefOid = short invalid sha → fail-closed block", () => {
  const ghOutput = JSON.stringify({
    headRefOid: "abcde",
    headRefName: "feature/foo",
    comments: [
      {
        id: "C_0",
        url: `https://github.com/example/repo/pull/${PR_NUMBER}#issuecomment-0`,
        body: buildStickyBody({ verdict: "PASS", lastReviewedSha: CURRENT_SHA }),
      },
    ],
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
    branch: "chore/add-feature",
  });
  assert.equal(r.json?.decision, "block",
    `C4-c: invalid (short) headRefOid must be fail-closed block, got: ${JSON.stringify(r.json)}`);
});

// ── C1-residual: argv-aware positional digit extraction boundary cases ────

// C1-residual-a: branch name with embedded number should NOT be treated as PR#.
// `gh pr merge issue-42-fix` → fallback to current-branch resolver, not PR #42.
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters gate → block)
test("C1-residual-a: gh pr merge issue-42-fix → fallback path (branch name, not PR#42)", () => {
  const ghOutput = buildPrJson({ comments: [], headRefOid: CURRENT_SHA });
  const r = runHook("gh pr merge issue-42-fix", {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
    branch: "chore/add-feature",
    extraEnv: {
      // Provide fallback PR# 999 so we confirm fallback was used (gate blocks due to no sticky)
      CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER: "999",
    },
  });
  // Gate should block (no sticky for PR 999) — the important part is it did NOT
  // short-circuit on PR #42 (word boundary match from old regex).
  assert.equal(r.json?.decision, "block",
    `C1-residual-a: issue-42-fix should use fallback PR# (not match #42), got: ${JSON.stringify(r.json)}`);
});

// C1-residual-b: release branch name with date numbers should NOT be treated as PR#.
// `gh pr merge release-2026-05` → fallback, not PR #2026 or #5.
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters gate → block)
test("C1-residual-b: gh pr merge release-2026-05 → fallback path (not PR#2026)", () => {
  const ghOutput = buildPrJson({ comments: [], headRefOid: CURRENT_SHA });
  const r = runHook("gh pr merge release-2026-05", {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
    branch: "chore/add-feature",
    extraEnv: {
      CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER: "999",
    },
  });
  assert.equal(r.json?.decision, "block",
    `C1-residual-b: release-2026-05 should use fallback, not match #2026, got: ${JSON.stringify(r.json)}`);
});

// C1-residual-c: body string with #42 should NOT steal PR# from explicit positional 9999.
// `gh pr merge --body "see #42" 9999` → should use PR# 9999 (the positional digit after flags).
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters gate → block)
test("C1-residual-c: gh pr merge --body 'see #42' 9999 → argv-aware extraction finds 9999", () => {
  // Build gh output for PR# 9999 (no sticky → block at Path B)
  const ghOutput = buildPrJson({ comments: [], headRefOid: CURRENT_SHA });
  const r = runHook(`gh pr merge --body "see #42" ${PR_NUMBER}`, {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
    branch: "chore/add-feature",
  });
  // Gate blocks at Path B (no sticky) confirming PR# was correctly resolved to 9999.
  assert.equal(r.json?.decision, "block",
    `C1-residual-c: should resolve PR# 9999 (not #42 from body), got: ${JSON.stringify(r.json)}`);
});

// C1-residual-d: pure digit token after a flag (flag-value pattern).
// `gh pr merge --merge 456` → should extract PR# 456.
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters gate → block)
test("C1-residual-d: gh pr merge --merge 456 → argv-aware extraction finds 456", () => {
  const ghOutput = buildPrJson({ comments: [], headRefOid: CURRENT_SHA });
  const r = runHook("gh pr merge --merge 456", {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
    branch: "chore/add-feature",
  });
  // Gate blocks at Path B (no sticky for PR 456) → PR# was correctly extracted as 456
  assert.equal(r.json?.decision, "block",
    `C1-residual-d: --merge 456 should extract PR# 456, got: ${JSON.stringify(r.json)}`);
});

// C1-residual-e: no token at all after "gh pr merge" → fallback path.
// (default-on reframe: diff includes proposal.md → not chore-A exempt → enters gate → block)
test("C1-residual-e: gh pr merge (bare, no tokens) → fallback path", () => {
  const ghOutput = buildPrJson({ comments: [], headRefOid: CURRENT_SHA });
  const r = runHook("gh pr merge", {
    ghOutput,
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,  // proposal.md present → not chore-A exempt
    branch: "chore/add-feature",
    extraEnv: {
      CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER: PR_NUMBER,
    },
  });
  // With fallback PR# = PR_NUMBER and no sticky → block at Path B
  assert.equal(r.json?.decision, "block",
    `C1-residual-e: bare gh pr merge should use fallback PR#, got: ${JSON.stringify(r.json)}`);
});

// ── _extractPrNumber direct unit tests (C1-residual-2 + oracle strengthening) ──

describe("_extractPrNumber direct unit tests (C1-residual-2 + oracle strengthening)", () => {
  it("URL form takes priority over positional digit", () => {
    assert.strictEqual(
      _extractPrNumber("gh pr merge https://github.com/o/r/pull/123"),
      "123"
    );
  });

  it("simple positional digit token", () => {
    assert.strictEqual(_extractPrNumber("gh pr merge 456"), "456");
  });

  it("value-taking flag --body with digit value: skips 123, takes 456", () => {
    assert.strictEqual(_extractPrNumber("gh pr merge --body 123 456"), "456");
  });

  it("value-taking flag short form -b with digit value: skips 99, takes 8888", () => {
    assert.strictEqual(_extractPrNumber("gh pr merge -b 99 8888"), "8888");
  });

  it("value-taking flag --subject with digit value: skips 42, takes 999", () => {
    assert.strictEqual(_extractPrNumber("gh pr merge --subject 42 999"), "999");
  });

  it("value-taking flag --match-head-commit with 7-digit hash: skips 1234567, takes 456", () => {
    assert.strictEqual(
      _extractPrNumber("gh pr merge --match-head-commit 1234567 456"),
      "456"
    );
  });

  it("value-taking flag -R (--repo) skips owner/repo, takes digit token", () => {
    assert.strictEqual(_extractPrNumber("gh pr merge -R owner/repo 100"), "100");
    assert.strictEqual(_extractPrNumber("gh pr merge --repo owner/repo 200"), "200");
  });

  it("inline --flag=value form: skips flag+value as single token, takes 456", () => {
    assert.strictEqual(_extractPrNumber("gh pr merge --body=foo 456"), "456");
  });

  it("boolean flags --auto and --merge skipped without consuming next token", () => {
    assert.strictEqual(_extractPrNumber("gh pr merge --auto --merge 456"), "456");
  });

  it("branch name token issue-42-fix is not extracted as PR# — uses fallback mock", () => {
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER = "777";
    try {
      assert.strictEqual(_extractPrNumber("gh pr merge issue-42-fix"), "777");
    } finally {
      delete process.env.CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER;
    }
  });

  it("release branch name release-2026-05 is not extracted — uses fallback mock", () => {
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER = "555";
    try {
      assert.strictEqual(_extractPrNumber("gh pr merge release-2026-05"), "555");
    } finally {
      delete process.env.CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER;
    }
  });

  it("body value with '#42' skipped, positional 9999 taken", () => {
    // After split: tokens include '--body', '"see', '#42"', '9999'
    // '--body' is value-taking → skip '--body' and next token ('"see')
    // '#42"' is not pure-digit → skip
    // '9999' is pure-digit → return 9999
    assert.strictEqual(_extractPrNumber('gh pr merge --body "see #42" 9999'), "9999");
  });

  it("value-taking flag --body-file skips filename, takes digit PR#", () => {
    assert.strictEqual(_extractPrNumber("gh pr merge --body-file body.txt 300"), "300");
  });

  it("value-taking flag -F (short --body-file) skips filename, takes digit PR#", () => {
    assert.strictEqual(_extractPrNumber("gh pr merge -F body.txt 400"), "400");
  });

  // C1-residual-3: explicit regression markers for -t and -A short aliases
  it("C1-residual-3: -t short alias for --subject skips its value, takes positional PR#", () => {
    assert.strictEqual(_extractPrNumber("gh pr merge -t 123 456"), "456");
  });

  it("C1-residual-3: -A short alias for --author-email skips its value, takes positional PR#", () => {
    assert.strictEqual(_extractPrNumber("gh pr merge -A 123 456"), "456");
  });

  // Table-driven: automatically covers every flag in the Set (space-separated form)
  it("table-driven: every value-taking flag in Set skips its numeric value", () => {
    // Iterates the entire GH_PR_MERGE_VALUE_TAKING_FLAGS Set so future additions
    // are automatically covered without writing new cases.
    for (const flag of GH_PR_MERGE_VALUE_TAKING_FLAGS) {
      const cmd = `gh pr merge ${flag} 123 456`;
      assert.strictEqual(
        _extractPrNumber(cmd),
        "456",
        `flag ${flag} should skip its value "123" and return positional "456"`
      );
    }
  });

  // Table-driven: inline = form (--flag=value) is treated as a single token and skipped
  it("table-driven: every value-taking flag with inline = form skips correctly", () => {
    for (const flag of GH_PR_MERGE_VALUE_TAKING_FLAGS) {
      const cmd = `gh pr merge ${flag}=foo 789`;
      assert.strictEqual(
        _extractPrNumber(cmd),
        "789",
        `flag ${flag}=value inline form should be skipped, expected positional "789"`
      );
    }
  });

  it("gh pr checks positional digit is a PR number", () => {
    assert.strictEqual(_extractPrNumber("gh pr checks 2024"), "2024");
  });

  it("gh pr checks --interval skips its value and takes positional PR#", () => {
    assert.strictEqual(_extractPrNumber("gh pr checks --interval 10 2024"), "2024");
  });

  it("gh pr checks 2188 && sleep 10 still extracts the same-segment PR#", () => {
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER = "";
    try {
      assert.strictEqual(_extractPrNumber("gh pr checks 2188 && sleep 10"), "2188");
    } finally {
      delete process.env.CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER;
    }
  });

  it("gh pr merge 2188 && sleep 10 still extracts the same-segment PR#", () => {
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER = "";
    try {
      assert.strictEqual(_extractPrNumber("gh pr merge 2188 && sleep 10"), "2188");
    } finally {
      delete process.env.CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER;
    }
  });

  it("gh pr checks URL form extracts pull digits", () => {
    assert.strictEqual(
      _extractPrNumber("gh pr checks https://github.com/o/r/pull/2024"),
      "2024"
    );
  });

  it("table-driven: every gh pr checks value-taking flag skips its numeric value", () => {
    for (const flag of GH_PR_CHECKS_VALUE_TAKING_FLAGS) {
      const cmd = `gh pr checks ${flag} 10 2024`;
      assert.strictEqual(
        _extractPrNumber(cmd),
        "2024",
        `flag ${flag} should skip its value "10" and return positional "2024"`
      );
    }
  });

  it("table-driven: every gh pr checks value-taking flag with inline = form skips correctly", () => {
    for (const flag of GH_PR_CHECKS_VALUE_TAKING_FLAGS) {
      const cmd = `gh pr checks ${flag}=foo 2024`;
      assert.strictEqual(
        _extractPrNumber(cmd),
        "2024",
        `flag ${flag}=value inline form should be skipped, expected positional "2024"`
      );
    }
  });

  it("gh run view run-id is not a PR number when current-PR mock is empty", () => {
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER = "";
    try {
      assert.notStrictEqual(
        _extractPrNumber("gh run view 12345678"),
        "12345678"
      );
    } finally {
      delete process.env.CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER;
    }
  });

  it("gh pr checks && sleep 10 is not extracted as PR# 10 when current-PR mock is empty", () => {
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER = "";
    try {
      assert.notStrictEqual(_extractPrNumber("gh pr checks && sleep 10"), "10");
    } finally {
      delete process.env.CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER;
    }
  });

  it("gh pr merge && sleep 10 is not extracted as PR# 10 when current-PR mock is empty", () => {
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER = "";
    try {
      assert.notStrictEqual(_extractPrNumber("gh pr merge && sleep 10"), "10");
    } finally {
      delete process.env.CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER;
    }
  });

  it("gh pr checks | head -n 10 is not extracted as PR# 10 when current-PR mock is empty", () => {
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER = "";
    try {
      assert.notStrictEqual(_extractPrNumber("gh pr checks | head -n 10"), "10");
    } finally {
      delete process.env.CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER;
    }
  });
});

// ── _extractRepoFlag direct unit tests (issue #762) ──────────────────────────

describe("_extractRepoFlag direct unit tests", () => {
  it("1. --repo space-separated form returns owner/repo", () => {
    assert.strictEqual(
      _extractRepoFlag("gh pr merge 25 --repo owner/repo --merge"),
      "owner/repo"
    );
  });

  it("2. -R space-separated form returns owner/repo", () => {
    assert.strictEqual(
      _extractRepoFlag("gh pr merge 25 -R owner/repo --merge"),
      "owner/repo"
    );
  });

  it("3. --repo=value inline form returns owner/repo", () => {
    assert.strictEqual(
      _extractRepoFlag("gh pr merge 25 --repo=owner/repo --merge"),
      "owner/repo"
    );
  });

  it("4. -R=value inline form returns owner/repo", () => {
    assert.strictEqual(
      _extractRepoFlag("gh pr merge 25 -R=owner/repo --merge"),
      "owner/repo"
    );
  });

  it("5. no --repo flag returns null", () => {
    assert.strictEqual(
      _extractRepoFlag("gh pr merge 25 --merge"),
      null
    );
  });

  it("6. --repo value with whitespace (multi-token) returns null (shape invalid)", () => {
    // "owner with space" tokenises to three tokens; "owner" alone fails shape /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
    assert.strictEqual(
      _extractRepoFlag("gh pr merge 25 --repo owner with space --merge"),
      null
    );
  });

  it("7. --repo owner/repo/extra (multiple slashes) returns null", () => {
    assert.strictEqual(
      _extractRepoFlag("gh pr merge 25 --repo owner/repo/extra --merge"),
      null
    );
  });

  it("8. allowed chars (dots, hyphens, underscores) in owner and repo are accepted", () => {
    assert.strictEqual(
      _extractRepoFlag("gh pr merge 25 --repo owner.repo-name/sub_repo --merge"),
      "owner.repo-name/sub_repo"
    );
  });

  it("9a. a merge clause after a checks clause supplies the repo, in every flag position", () => {
    // fix-pre-verb-repo-flag-checks review r1: the repo and the PR number must come from the same (merge) clause.
    for (const command of [
      "gh pr checks 11 -R org/checks && gh pr merge 22 -R org/target --merge",
      "gh pr -R org/checks checks 11 && gh pr -R org/target merge 22 --merge",
      "gh -R org/checks pr checks 11 && gh -R org/target pr merge 22 --merge",
    ]) {
      assert.strictEqual(_extractRepoFlag(command), "org/target", command);
      assert.strictEqual(_extractPrNumber(command), "22", command);
    }
  });

  it("9. gh pr checks --repo space-separated form returns owner/repo", () => {
    assert.strictEqual(
      _extractRepoFlag("gh pr checks 2024 --repo owner/repo"),
      "owner/repo"
    );
  });
});

// ── End-to-end: checkCrossModelMergeGate with --repo flag (issue #762) ───────

describe("checkCrossModelMergeGate with --repo flag end-to-end (tracer pattern)", () => {
  it("9. _runGhPrView receives the --repo value from user command", () => {
    const traceFile = path.join(tmpRoot, "trace-9.jsonl");
    const ghOutput = JSON.stringify({
      headRefOid: CURRENT_SHA,
      headRefName: "chore/some-feature",
      comments: [],
    });
    runHook("gh pr merge 25 --repo owner/repo --merge", {
      ghOutput,
      diffFiles: NON_TRIGGER_PATH,
      branch: "chore/some-feature",
      extraEnv: { CROSS_MODEL_MERGE_GATE_TRACE_REPO_FILE: traceFile },
    });
    const lines = readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean);
    const viewEntry = lines.map((l) => JSON.parse(l)).find((e) => e.helper === "_runGhPrView");
    assert.ok(viewEntry, "expected a _runGhPrView trace entry in the trace file");
    assert.strictEqual(
      viewEntry.repo,
      "owner/repo",
      `expected _runGhPrView to receive repo=owner/repo from user cmd, got: ${viewEntry.repo}`
    );
  });

  it("10. _runGhPrView receives empty string when --repo absent", () => {
    const traceFile = path.join(tmpRoot, "trace-10.jsonl");
    const ghOutput = JSON.stringify({
      headRefOid: CURRENT_SHA,
      headRefName: "chore/some-feature",
      comments: [],
    });
    runHook("gh pr merge 25 --merge", {
      ghOutput,
      diffFiles: NON_TRIGGER_PATH,
      branch: "chore/some-feature",
      extraEnv: { CROSS_MODEL_MERGE_GATE_TRACE_REPO_FILE: traceFile },
    });
    const lines = readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean);
    const viewEntry = lines.map((l) => JSON.parse(l)).find((e) => e.helper === "_runGhPrView");
    assert.ok(viewEntry, "expected a _runGhPrView trace entry in the trace file");
    assert.strictEqual(
      viewEntry.repo,
      "",
      `expected _runGhPrView to receive empty repo when --repo absent, got: ${viewEntry.repo}`
    );
  });

  it("11. _getPrChangedFiles receives the --repo value from user command", () => {
    const traceFile = path.join(tmpRoot, "trace-11.jsonl");
    const ghOutput = JSON.stringify({
      headRefOid: CURRENT_SHA,
      headRefName: "chore/some-feature",
      comments: [],
    });
    runHook("gh pr merge 25 --repo owner/repo --merge", {
      ghOutput,
      diffFiles: NON_TRIGGER_PATH,
      branch: "chore/some-feature",
      extraEnv: { CROSS_MODEL_MERGE_GATE_TRACE_REPO_FILE: traceFile },
    });
    const lines = readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean);
    const filesEntry = lines.map((l) => JSON.parse(l)).find((e) => e.helper === "_getPrChangedFiles");
    assert.ok(filesEntry, "expected a _getPrChangedFiles trace entry in the trace file");
    assert.strictEqual(
      filesEntry.repo,
      "owner/repo",
      `expected _getPrChangedFiles to receive repo=owner/repo from user cmd, got: ${filesEntry.repo}`
    );
  });

  it("12. _getPrChangedFiles receives empty string when --repo absent", () => {
    const traceFile = path.join(tmpRoot, "trace-12.jsonl");
    const ghOutput = JSON.stringify({
      headRefOid: CURRENT_SHA,
      headRefName: "chore/some-feature",
      comments: [],
    });
    runHook("gh pr merge 25 --merge", {
      ghOutput,
      diffFiles: NON_TRIGGER_PATH,
      branch: "chore/some-feature",
      extraEnv: { CROSS_MODEL_MERGE_GATE_TRACE_REPO_FILE: traceFile },
    });
    const lines = readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean);
    const filesEntry = lines.map((l) => JSON.parse(l)).find((e) => e.helper === "_getPrChangedFiles");
    assert.ok(filesEntry, "expected a _getPrChangedFiles trace entry in the trace file");
    assert.strictEqual(
      filesEntry.repo,
      "",
      `expected _getPrChangedFiles to receive empty repo when --repo absent, got: ${filesEntry.repo}`
    );
  });
});

// #3556 item 3: the hook decides before the shell expands a variable, so a PR number or --repo/-R written as one
// cannot be looked up. The gate names that cause before any lookup instead of reporting a failed `gh pr view`.
describe("checkCrossModelMergeGate names a shell-expanded PR number or --repo/-R", () => {
  for (const command of [
    "R=owner/repo; gh pr merge 25 -R $R --merge",
    'gh pr merge 25 --repo "$R" --merge',
    "gh pr merge 25 --repo=${R} --merge",
    "N=25; gh pr merge $N --repo owner/repo --merge",
    'gh pr merge "$(cat pr-number)" --merge',
  ]) {
    it(`blocks before lookup: ${command}`, () => {
      const traceFile = path.join(tmpRoot, `trace-expanded-${Buffer.from(command).toString("hex").slice(0, 24)}.jsonl`);
      const result = runHook(command, {
        ghOutput: JSON.stringify({ headRefOid: CURRENT_SHA, headRefName: "chore/some-feature", comments: [] }),
        diffFiles: NON_TRIGGER_PATH,
        extraEnv: { CROSS_MODEL_MERGE_GATE_TRACE_REPO_FILE: traceFile },
      });
      assert.equal(result.json?.decision, "block", command);
      assert.match(result.json.reason, /shell 變數或命令替換/, command);
      assert.match(result.json.reason, /字面值/, command);
      assert.doesNotMatch(result.json.reason, /DEVPRO_HOOK_BYPASS|gh pr view 失敗/, command);
      let trace = "";
      try { trace = readFileSync(traceFile, "utf8"); } catch {}
      assert.equal(trace, "", `no PR lookup may run for ${command}`);
    });
  }

  // A `$` in the value of another value-taking flag is not a PR selector.
  for (const [label, body] of [["single-quoted", "'costs $5'"], ["double-quoted", '"costs $5"']]) {
    it(`a literal PR number and repository keep the existing lookup (${label} --body with $)`, () => {
      const traceFile = path.join(tmpRoot, `trace-expanded-literal-${label}.jsonl`);
      const result = runHook(`gh pr merge 25 --repo owner/repo --body ${body} --merge`, {
        ghOutput: JSON.stringify({ headRefOid: CURRENT_SHA, headRefName: "chore/some-feature", comments: [] }),
        diffFiles: NON_TRIGGER_PATH,
        extraEnv: { CROSS_MODEL_MERGE_GATE_TRACE_REPO_FILE: traceFile },
      });
      assert.doesNotMatch(result.json?.reason ?? "", /shell 變數或命令替換/);
      assert.match(readFileSync(traceFile, "utf8"), /"repo":"owner\/repo"/);
    });
  }
});

// ── SA: shell-aware — the gate must NOT fire on `gh pr merge` text that lives
// inside a quoted string / heredoc / comment (commit message, echo, node -e).
// Regression for the false-positive where the gate tested the raw command and
// blocked any command merely MENTIONING the verb. ─────────────────────────────

// SA-1: a git commit whose MESSAGE documents `gh pr merge` must not trip the
// cross-model gate. Discriminating: the verb is preceded by a space inside the
// quoted message (` gh pr merge`), which the raw-cmd regex boundary `[\s;|&(]`
// WOULD match — so on the pre-fix code this command was blocked by the cross-model
// gate. A footer is included so the commit-attribution gate does NOT intercept
// first, isolating the cross-model gate as the only thing that could block here.
test("SA-1: git commit -m '...gh pr merge...' (with footer) → no cross-model block", () => {
  const r = runHook(
    'git commit -m "docs: explain gh pr merge sentinel' +
      "\n\nRules: v6.61.3 · Tool: x · Model: y\"",
    { branch: "chore/add-feature" }
  );
  const reason = r.json?.reason || "";
  assert.ok(
    !/Cross-Model Merge Gate/.test(reason),
    `commit message mentioning the verb must not trigger the cross-model gate; got: ${JSON.stringify(r.json)}`
  );
});

// SA-2: an echo whose argument mentions the verb must not be blocked at all.
test("SA-2: echo \"...gh pr merge...\" → not blocked", () => {
  const r = runHook('echo "see the gh pr merge docs"', { branch: "chore/add-feature" });
  assert.notEqual(
    r.json?.decision,
    "block",
    `echo mentioning the verb must not be blocked; got: ${JSON.stringify(r.json)}`
  );
});

// SA-3: a node -e script string mentioning the verb must not be blocked.
// Discriminating: the verb is preceded by a SPACE inside the quoted string
// (`"... gh pr merge ..."`), so the raw-cmd regex boundary `[\s;|&(]` WOULD match
// it on the pre-fix code; the shell-aware view collapses the quote to `__QUOTED__`
// so it no longer matches. (The earlier `console.log("gh pr...` shape was vacuous
// because `"` is not a regex boundary char — fixed here.)
test("SA-3: node -e '... gh pr merge ...' → not blocked by cross-model gate", () => {
  const r = runHook(
    `node -e 'const doc = " gh pr merge 123 docs "; console.log(doc)'`,
    { branch: "chore/add-feature" }
  );
  const reason = r.json?.reason || "";
  assert.ok(
    !/Cross-Model Merge Gate/.test(reason),
    `node -e string mentioning the verb must not trigger the cross-model gate; got: ${JSON.stringify(r.json)}`
  );
});

// SA-4 (regression guard): a GENUINE `gh pr merge <#>` must still engage the gate
// and resolve the PR# (block reason must be the real gate logic, NOT
// "cannot determine PR#").
test("SA-4: genuine gh pr merge <#> still engages gate with resolved PR#", () => {
  const ghOutput = buildPrJson({ comments: [], headRefOid: CURRENT_SHA });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    branch: "chore/add-feature",
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL, // proposal present → not chore-A exempt → reaches Path B
  });
  // No sticky comment in the mocked PR → Path B block, but crucially the PR# WAS
  // resolved (so the reason is the real review-required path, not "無法判定 PR#").
  assert.equal(r.json?.decision, "block", `genuine merge must still be gated; got: ${JSON.stringify(r.json)}`);
  assert.ok(
    !/無法判定 PR#/.test(r.json?.reason || ""),
    `genuine merge must resolve PR# (not 'cannot determine'); got: ${JSON.stringify(r.json)}`
  );
});

// FP-HELP-1: help/introspection command segments are read-only. They must not
// enter the cross-model merge gate or try to resolve a PR number.
test("FP-HELP-1: gh pr merge --help pipeline → no cross-model block", () => {
  const r = runHook("gh pr merge --help | sed -n '1,40p'", {
    branch: "chore/add-feature",
    extraEnv: {
      CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER: "",
    },
  });
  assert.notEqual(
    r.json?.decision,
    "block",
    `help/introspection must not be hard-blocked; got: ${JSON.stringify(r.json)}`
  );
  assert.ok(
    !/Cross-Model Merge Gate/.test(r.json?.reason || ""),
    `help/introspection must not trigger cross-model gate; got: ${JSON.stringify(r.json)}`
  );
});

// FP-HELP-2: stripping help segments must not bypass a real merge later in the
// same Bash payload.
test("FP-HELP-2: gh pr merge --help ; real gh pr merge still engages gate", () => {
  const ghOutput = buildPrJson({ comments: [], headRefOid: CURRENT_SHA });
  const r = runHook(`gh pr merge --help ; gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    branch: "chore/add-feature",
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,
    extraEnv: {
      CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER: "",
    },
  });
  assert.equal(r.json?.decision, "block", `real merge must still be gated; got: ${JSON.stringify(r.json)}`);
  assert.match(r.json?.reason || "", /Path B/);
});

// FP-HELP-3: a -h/--help token in the VALUE position of a value-taking flag must
// NOT cause the whole `gh pr merge` statement to be stripped as help-only. gh
// consumes `-h` as the flag value and actually performs the merge, so the
// cross-model merge gate must still engage (help-strip fail-OPEN regression).
for (const [label, command] of [
  ["-h as value of --subject", `gh pr merge ${PR_NUMBER} --merge --subject -h`],
  ["-h as value of -b (body)", `gh pr merge ${PR_NUMBER} --merge -b -h`],
  ["--help as value of --body-file", `gh pr merge ${PR_NUMBER} --merge --body-file --help`],
]) {
  test(`FP-HELP-3: ${label} → real merge still engages cross-model gate`, () => {
    const ghOutput = buildPrJson({ comments: [], headRefOid: CURRENT_SHA });
    const r = runHook(command, {
      ghOutput,
      branch: "chore/add-feature",
      diffFiles: TRIGGER_PATH_WITH_PROPOSAL,
      extraEnv: {
        CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER: "",
      },
    });
    assert.equal(r.json?.decision, "block", `real merge must still be gated; got: ${JSON.stringify(r.json)}`);
    assert.match(r.json?.reason || "", /Cross-Model Merge Gate|Path B/);
  });
}

test("Shell tool_name engages cross-model merge gate (Cursor live surface)", () => {
  const saved = {};
  for (const k of [...CM_MOCK_ENV_KEYS, ...Object.keys(GIT_ISOLATION)]) saved[k] = process.env[k];
  try {
    Object.assign(process.env, GIT_ISOLATION);
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_BRANCH = "bugfix/test-merge-gate";
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES = TRIGGER_PATH_WITH_PROPOSAL;
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT = buildPrJson({
      comments: [],
      headRefOid: CURRENT_SHA,
    });
    const result = evaluatePreToolUsePayload({
      cwd: SOURCE_CHECKOUT,
      tool_name: "Shell",
      tool_input: { command: `gh pr merge ${PR_NUMBER} ${SOURCE_REPO_FLAG} --merge` },
    });
    assert.ok(result?.block, `Shell gh pr merge without sticky must block; got ${JSON.stringify(result)}`);
    assert.match(result.reason || "", /Path B|Cross-Model Merge Gate/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// -------------------------------------------------------------------------
// fix-pr-changed-files-truncation — `_getPrChangedFiles` must read the
// COMPLETE PR changed-file list. `gh pr view --json files --jq .files[].path`
// (the pre-fix code path) is capped by GitHub at 100 files; a PR with more
// than 100 changed files whose proposal.md sorts past file 100 (e.g. an
// archived proposal) is misjudged as chore-A-class exempt. These tests spawn
// a fake `gh` on PATH (real gh CLI protocol, not the env-var mocks used
// elsewhere in this file) and call `_getPrChangedFiles` in-process.
// Spec: openspec/changes/fix-pr-changed-files-truncation/specs/
// pre-tool-mechanical-gates/spec.md "PR Changed-File Lists Are Complete
// Before Classification".
// -------------------------------------------------------------------------
describe("PR Changed-File Lists Are Complete Before Classification", () => {
  const DIFF_MOCK_ENV_KEYS = [
    "CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES",
    "CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES_ERROR",
  ];
  let truncationCounter = 0;

  // The mock-env branches at the top of `_getPrChangedFiles` must be off so the
  // real spawnSync("gh", ...) path runs against our fake `gh` on PATH.
  function withRealGh(fakeBin, fn) {
    const savedPath = process.env.PATH;
    const savedMocks = {};
    for (const k of DIFF_MOCK_ENV_KEYS) {
      savedMocks[k] = process.env[k];
      delete process.env[k];
    }
    process.env.PATH = `${fakeBin}${path.delimiter}${savedPath || ""}`;
    try {
      return fn();
    } finally {
      process.env.PATH = savedPath;
      for (const [k, v] of Object.entries(savedMocks)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  // Builds one fake `gh` binary that mimics all THREE call shapes the
  // implementation may issue against a single fixture, so the pre-fix code
  // (single `--json files --jq .files[].path` call) and the fixed code (total
  // + paginated list) both get a realistic response instead of a spawn error —
  // pre-fix RED failures must be semantic (wrong count/content), not a crash.
  //   - `pr view <n> --json files --jq .files[].path`       → first `legacyCount` paths (old capped path)
  //   - `pr view <n> --json changedFiles --jq .changedFiles` → `totalExpr` (sees `repoFlag`)
  //   - `api --paginate .../pulls/<n>/files?per_page=100 --jq .[].filename` → `apiCountExpr` paths (sees `ghRepoEnv`)
  //   - `pathTemplate` ("{i}" is the index) names the non-proposal files.
  //   - `apiFailFirst` makes the first N `api` calls exit 1 (a transient list failure).
  function writeFakeGh(scriptPath, { legacyCount = 100, totalExpr = "433", apiCountExpr = "433", proposalIndex = 372, traceFile = "", pathTemplate = ".devpro/scripts/f{i}.mjs", apiFailFirst = 0, proposalStatus = "added", apiPlain = false } = {}) {
    writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
function flagValue(name) {
  const idx = args.indexOf(name);
  return idx === -1 ? undefined : args[idx + 1];
}
function trace(entry) {
  ${traceFile ? `try { fs.appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify(entry) + "\\n"); } catch {}` : ""}
}
function buildPaths(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(i === ${proposalIndex} ? "openspec/changes/archive/2026-09-28-x/proposal.md" : ${JSON.stringify(pathTemplate)}.replace("{i}", String(i)));
  }
  return out;
}
// fs.writeSync(1, ...) (not process.stdout.write + process.exit) — stdout to a
// pipe is async in Node; a large write (the 433-file fixture exceeds the ~8KB
// pipe buffer) followed immediately by process.exit() truncates unflushed
// output. writeSync blocks until the write completes.
function writeStdoutSync(text) {
  fs.writeSync(1, text);
}
if (args[0] === "pr" && args[1] === "view") {
  const jq = flagValue("--jq");
  const repoFlag = flagValue("--repo") || null;
  trace({ call: "view", jq, repoFlag });
  if (jq === ".files[].path") {
    writeStdoutSync(buildPaths(${legacyCount}).join("\\n") + "\\n");
    process.exit(0);
  }
  if (jq === ".changedFiles") {
    writeStdoutSync(String(${totalExpr}) + "\\n");
    process.exit(0);
  }
}
if (args[0] === "api") {
  const ghRepoEnv = process.env.GH_REPO || null;
  trace({ call: "api", ghRepoEnv });
  ${apiFailFirst > 0 ? `{
    const counterPath = ${JSON.stringify(`${scriptPath}.api-count`)};
    let seen = 0;
    try { seen = Number(fs.readFileSync(counterPath, "utf8")) || 0; } catch {}
    fs.writeFileSync(counterPath, String(seen + 1));
    if (seen < ${apiFailFirst}) {
      process.stderr.write("simulated transient api failure\\n");
      process.exit(1);
    }
  }` : ""}
  // The hook asks for status-aware JSON records (\`@json\` in --jq); a plain-path jq gets paths.
  const apiJq = flagValue("--jq") || "";
  const apiPaths = buildPaths(${apiCountExpr});
  const apiLines = apiJq.includes("@json") && !${apiPlain ? "true" : "false"}
    ? apiPaths.map((p) => JSON.stringify({ status: p.endsWith("/proposal.md") ? ${JSON.stringify(proposalStatus)} : "modified", filename: p, previous_filename: null }))
    : apiPaths;
  writeStdoutSync(apiLines.join("\\n") + "\\n");
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`);
    chmodSync(scriptPath, 0o755);
  }

  function readTrace(traceFile) {
    try {
      return readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  it("Archived proposal past the first 100 files prevents chore-A exemption", () => {
    const fakeBin = path.join(tmpRoot, `fake-gh-truncation-${truncationCounter++}`);
    mkdirSync(fakeBin, { recursive: true });
    writeFakeGh(path.join(fakeBin, "gh"), { totalExpr: "433", apiCountExpr: "433", proposalIndex: 372 });

    const result = withRealGh(fakeBin, () => _getPrChangedFiles("9999", tmpRoot, ""));

    assert.equal(result.length, 433, `must return all 433 files, got ${result.length}`);
    assert.ok(
      result.includes("openspec/changes/archive/2026-09-28-x/proposal.md"),
      "must include the archived proposal past file 100"
    );
    assert.equal(
      isCrossModelExempt("chore/x", result, tmpRoot),
      false,
      "chore/* PR with an archived proposal past file 100 must not be exempt"
    );
  });

  // ── #3333: status-aware entries ───────────────────────────────────────────
  it("Entries carry the REST status, and an in-place edit of another change's proposal keeps chore-A", () => {
    const fakeBin = path.join(tmpRoot, `fake-gh-truncation-${truncationCounter++}`);
    mkdirSync(fakeBin, { recursive: true });
    writeFakeGh(path.join(fakeBin, "gh"), { totalExpr: "5", apiCountExpr: "5", proposalIndex: 3, proposalStatus: "modified" });

    const entries = withRealGh(fakeBin, () => _getPrChangedFileEntries("9999", tmpRoot, ""));

    assert.equal(entries.length, 5);
    assert.deepEqual(entries[3], {
      path: "openspec/changes/archive/2026-09-28-x/proposal.md",
      status: "modified",
      previousPath: null,
    });
    const { files, statuses } = toExemptionInput(entries);
    assert.equal(isCrossModelExempt("chore/y", files, tmpRoot, statuses), true, "foreign proposal modified in place");
    assert.equal(isCrossModelExempt("chore/x", files, tmpRoot, statuses), false, "the branch's own change");
    assert.equal(isCrossModelExempt("chore/y", files, tmpRoot), false, "no statuses supplied keeps the old answer");
  });

  it("A foreign proposal that is ADDED still prevents chore-A exemption through the real gh path", () => {
    const fakeBin = path.join(tmpRoot, `fake-gh-truncation-${truncationCounter++}`);
    mkdirSync(fakeBin, { recursive: true });
    writeFakeGh(path.join(fakeBin, "gh"), { totalExpr: "5", apiCountExpr: "5", proposalIndex: 3, proposalStatus: "added" });

    const { files, statuses } = toExemptionInput(withRealGh(fakeBin, () => _getPrChangedFileEntries("9999", tmpRoot, "")));

    assert.equal(isCrossModelExempt("chore/y", files, tmpRoot, statuses), false);
  });

  it("A record that is not the requested JSON shape throws instead of reading as a path", () => {
    const fakeBin = path.join(tmpRoot, `fake-gh-truncation-${truncationCounter++}`);
    mkdirSync(fakeBin, { recursive: true });
    writeFakeGh(path.join(fakeBin, "gh"), { totalExpr: "3", apiCountExpr: "3", proposalIndex: -1, apiPlain: true });

    assert.throws(
      () => withRealGh(fakeBin, () => _getPrChangedFileEntries("9999", tmpRoot, "")),
      /unparseable record/,
      "plain-path output must fail closed, never be mistaken for a status-less list"
    );
  });

  it("Incomplete list throws", () => {
    const fakeBin = path.join(tmpRoot, `fake-gh-truncation-${truncationCounter++}`);
    mkdirSync(fakeBin, { recursive: true });
    // Total says 433, but the paginated endpoint only returns 100 — a second
    // form of truncation the total check alone would not catch.
    writeFakeGh(path.join(fakeBin, "gh"), { totalExpr: "433", apiCountExpr: "100", proposalIndex: 372 });

    assert.throws(
      () => withRealGh(fakeBin, () => _getPrChangedFiles("9999", tmpRoot, "")),
      (err) => /100/.test(err.message) && /433/.test(err.message),
      "must throw an error naming both counts (100 and 433)"
    );
  });

  it("Total above the REST limit throws before listing", () => {
    const fakeBin = path.join(tmpRoot, `fake-gh-truncation-${truncationCounter++}`);
    mkdirSync(fakeBin, { recursive: true });
    const traceFile = path.join(fakeBin, "trace.jsonl");
    writeFakeGh(path.join(fakeBin, "gh"), { totalExpr: "3001", apiCountExpr: "3001", proposalIndex: -1, traceFile });

    assert.throws(
      () => withRealGh(fakeBin, () => _getPrChangedFiles("9999", tmpRoot, "")),
      /3001|3000/,
      "must throw naming the over-limit total"
    );
    const apiCalls = readTrace(traceFile).filter((e) => e.call === "api");
    assert.deepEqual(apiCalls, [], "must not call the paginated api endpoint when total exceeds the REST limit");
  });

  it("Non-integer total throws before listing", () => {
    // Blank stdout is the fail-open case: Number("") is 0, and an empty list
    // would then "match" it. Hex/exponent forms also coerce to integers.
    for (const totalExpr of ['""', '"0x1b1"', '"1e3"']) {
      const fakeBin = path.join(tmpRoot, `fake-gh-truncation-${truncationCounter++}`);
      mkdirSync(fakeBin, { recursive: true });
      const traceFile = path.join(fakeBin, "trace.jsonl");
      writeFakeGh(path.join(fakeBin, "gh"), { totalExpr, apiCountExpr: "0", proposalIndex: -1, traceFile });

      assert.throws(
        () => withRealGh(fakeBin, () => _getPrChangedFiles("9999", tmpRoot, "")),
        /non-integer total/,
        `total ${totalExpr} must throw`
      );
      const apiCalls = readTrace(traceFile).filter((e) => e.call === "api");
      assert.deepEqual(apiCalls, [], `total ${totalExpr} must not reach the paginated api endpoint`);
    }
  });

  it("Repo flag reaches both gh calls", () => {
    const fakeBin = path.join(tmpRoot, `fake-gh-truncation-${truncationCounter++}`);
    mkdirSync(fakeBin, { recursive: true });
    const traceFile = path.join(fakeBin, "trace.jsonl");
    // Total call only returns the real 433 when it carries --repo example/repo
    // (else 7); the list call only returns the real 433 when GH_REPO is set to
    // example/repo in its env (else 3) — a differential that fails loudly if
    // either flag/env fails to reach its gh call.
    writeFakeGh(path.join(fakeBin, "gh"), {
      totalExpr: `(repoFlag === "example/repo" ? 433 : 7)`,
      apiCountExpr: `(ghRepoEnv === "example/repo" ? 433 : 3)`,
      proposalIndex: -1,
      traceFile,
    });

    const result = withRealGh(fakeBin, () => _getPrChangedFiles("9999", tmpRoot, "example/repo"));

    assert.equal(result.length, 433, `repo flag must reach both gh calls, got ${result.length} files`);
    const trace = readTrace(traceFile);
    const viewCall = trace.find((e) => e.call === "view" && e.jq === ".changedFiles");
    const apiCall = trace.find((e) => e.call === "api");
    assert.equal(viewCall?.repoFlag, "example/repo", "the total call must carry --repo example/repo");
    assert.equal(apiCall?.ghRepoEnv, "example/repo", "the list call must run with GH_REPO=example/repo");
  });

  // ── fix-merge-gate-pr-file-list-paging-cost ──────────────────────────────
  // One `gh pr merge` hook run reaches `_getPrChangedFiles` from up to three
  // gates (cross-model sticky, local-test evidence, exemption advisory). Each
  // call is a total check plus a paginated `gh api` listing, and the list
  // cannot change inside one run, so a run-scoped memo serves later callers.
  const memoScope = _withPrChangedFilesMemo;

  function countCalls(traceFile) {
    const trace = readTrace(traceFile);
    return {
      api: trace.filter((e) => e.call === "api").length,
      total: trace.filter((e) => e.call === "view" && e.jq === ".changedFiles").length,
    };
  }

  function setupMemoFakeGh(options = {}) {
    const fakeBin = path.join(tmpRoot, `fake-gh-memo-${truncationCounter++}`);
    mkdirSync(fakeBin, { recursive: true });
    const traceFile = path.join(fakeBin, "trace.jsonl");
    writeFakeGh(path.join(fakeBin, "gh"), {
      totalExpr: "3",
      apiCountExpr: "3",
      proposalIndex: -1,
      traceFile,
      pathTemplate: "docs/note-{i}.md",
      ...options,
    });
    return { fakeBin, traceFile };
  }

  it("Memo scope: a repeated lookup reads gh once and hands each caller its own list", () => {
    const { fakeBin, traceFile } = setupMemoFakeGh();
    const [first, second] = withRealGh(fakeBin, () =>
      memoScope(() => {
        const a = _getPrChangedFiles("9999", tmpRoot, "");
        a.push("mutated-by-first-caller");
        return [a, _getPrChangedFiles("9999", tmpRoot, "")];
      })
    );
    assert.deepEqual(countCalls(traceFile), { api: 1, total: 1 });
    assert.deepEqual(second, ["docs/note-0.md", "docs/note-1.md", "docs/note-2.md"], "a later caller must get the untouched list");
    assert.equal(first.length, 4);
  });

  it("Memo scope: the path view and the entries view share one fetch (#3333)", () => {
    const { fakeBin, traceFile } = setupMemoFakeGh();
    const [paths, entries] = withRealGh(fakeBin, () =>
      memoScope(() => [
        _getPrChangedFiles("9999", tmpRoot, ""),
        _getPrChangedFileEntries("9999", tmpRoot, ""),
      ])
    );
    assert.deepEqual(countCalls(traceFile), { api: 1, total: 1 });
    assert.deepEqual(entries.map((e) => e.path), paths);
  });

  it("Outside a memo scope every lookup still reads gh", () => {
    const { fakeBin, traceFile } = setupMemoFakeGh();
    withRealGh(fakeBin, () => {
      _getPrChangedFiles("9999", tmpRoot, "");
      _getPrChangedFiles("9999", tmpRoot, "");
    });
    assert.deepEqual(countCalls(traceFile), { api: 2, total: 2 });
  });

  it("Memo scope: entries are keyed by PR number, repo and cwd", () => {
    const { fakeBin, traceFile } = setupMemoFakeGh();
    const otherCwd = path.join(tmpRoot, "memo-other-cwd");
    mkdirSync(otherCwd, { recursive: true });
    withRealGh(fakeBin, () =>
      memoScope(() => {
        for (let round = 0; round < 2; round++) {
          _getPrChangedFiles("9999", tmpRoot, "");
          _getPrChangedFiles("9998", tmpRoot, "");
          _getPrChangedFiles("9999", tmpRoot, "example/repo");
          _getPrChangedFiles("9999", otherCwd, "");
        }
      })
    );
    assert.deepEqual(countCalls(traceFile), { api: 4, total: 4 }, "four distinct keys, each fetched once across two rounds");
  });

  it("Memo scope: a failed lookup is not memoized; the retry is, once it succeeds", () => {
    const { fakeBin, traceFile } = setupMemoFakeGh({ apiFailFirst: 1 });
    withRealGh(fakeBin, () =>
      memoScope(() => {
        assert.throws(() => _getPrChangedFiles("9999", tmpRoot, ""), /gh api pulls files failed/);
        assert.equal(_getPrChangedFiles("9999", tmpRoot, "").length, 3);
        assert.equal(_getPrChangedFiles("9999", tmpRoot, "").length, 3);
      })
    );
    assert.deepEqual(countCalls(traceFile), { api: 2, total: 2 });
  });

  it("Memo scope ends with the scope (also on throw); a nested scope shares the outer memo", () => {
    const { fakeBin, traceFile } = setupMemoFakeGh();
    withRealGh(fakeBin, () => {
      memoScope(() => {
        _getPrChangedFiles("9999", tmpRoot, "");
        memoScope(() => _getPrChangedFiles("9999", tmpRoot, ""));
      });
      assert.throws(
        () => memoScope(() => {
          _getPrChangedFiles("9999", tmpRoot, "");
          throw new Error("boom");
        }),
        /boom/
      );
      _getPrChangedFiles("9999", tmpRoot, "");
      _getPrChangedFiles("9999", tmpRoot, "");
    });
    assert.deepEqual(
      countCalls(traceFile),
      { api: 4, total: 4 },
      "scope 1 (nested reuse) = 1, scope 2 = 1, then two unscoped lookups = 2"
    );
  });

  it("One real `gh pr merge` hook run lists the PR files once across all three gate callers", () => {
    const { fakeBin, traceFile } = setupMemoFakeGh();
    const env = {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
      CODEX_CI: "",
      CODEX_THREAD_ID: "",
      DEVPRO_SENTINEL_STATE_DIR: makeTempDir("sentinel-memo-"),
      DEVPRO_POSTMERGE_STATE_DIR: makeTempDir("postmerge-memo-"),
      DEVPRO_RECAP_PENDING_DIR: makeTempDir("recap-pending-memo-"),
      DEVPRO_RECAP_STATE_DIR: makeTempDir("recap-state-memo-"),
      CROSS_MODEL_MERGE_GATE_MOCK_BRANCH: "chore/docs-only",
      CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: buildPrJson({
        comments: [],
        headRefOid: CURRENT_SHA,
        headRefName: "chore/docs-only",
        // The run is in SOURCE_CHECKOUT, not a source checkout, so the waiver gate reads the description.
        body: "",
      }),
    };
    for (const k of DIFF_MOCK_ENV_KEYS) delete env[k];
    const result = spawnSync("node", [HOOK], {
      input: JSON.stringify({ cwd: SOURCE_CHECKOUT, tool_name: "Bash", tool_input: { command: `gh pr merge ${PR_NUMBER} ${SOURCE_REPO_FLAG} --merge` } }),
      encoding: "utf8",
      cwd: SOURCE_CHECKOUT,
      env: { ...env, ...GIT_ISOLATION },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      !/"decision"\s*:\s*"block"/.test(result.stdout || ""),
      `a docs-only chore PR must reach every gate caller (no early block): ${result.stdout}`
    );
    assert.deepEqual(
      countCalls(traceFile),
      { api: 1, total: 1 },
      "the three gates must share one paginated listing and one total check per hook run"
    );
  });
});

// -------------------------------------------------------------------------
// remove-second-review-disclosure-approval T7 — removing the per-PR consent
// step must not relax the merge gate: second review stays a merge gate and a
// block here is a block decision, never a host prompt (`permissionDecision`).
// -------------------------------------------------------------------------
const MERGE_COMMAND = `gh pr merge ${PR_NUMBER} ${SOURCE_REPO_FLAG} --merge`;

/** Every state in which no exactly-one canonical current-head PASS/WARN sticky exists. */
function secondReviewMissingFixtures() {
  const sticky = (options) => buildPrJson({ comments: [{ body: buildStickyBody(options) }], headRefOid: CURRENT_SHA });
  return {
    "no sticky comment": buildPrJson({ comments: [], headRefOid: CURRENT_SHA }),
    "PASS sticky for an older head": sticky({ verdict: "PASS", lastReviewedSha: OLD_SHA }),
    "CRITICAL sticky for the current head": sticky({ verdict: "CRITICAL", lastReviewedSha: CURRENT_SHA }),
    "UNAVAILABLE sticky for the current head": sticky({ verdict: "UNAVAILABLE", lastReviewedSha: CURRENT_SHA, reason: "reviewer CLI not installed" }),
    "two canonical stickies": buildPrJson({
      comments: [
        { body: buildStickyBody({ verdict: "PASS", lastReviewedSha: CURRENT_SHA }), id: "C_1" },
        { body: buildStickyBody({ verdict: "WARN", lastReviewedSha: CURRENT_SHA }), id: "C_2" },
      ],
      headRefOid: CURRENT_SHA,
    }),
  };
}

test("Merge without a current-head PASS or WARN sticky and without a waiver is blocked: no current-head PASS or WARN sticky and no waiver blocks gh pr merge", () => {
  for (const [label, ghOutput] of Object.entries(secondReviewMissingFixtures())) {
    const r = runHook(MERGE_COMMAND, { ghOutput, diffFiles: TRIGGER_PATH_WITH_PROPOSAL, branch: "feature/second-review-merge-gate" });
    assert.equal(r.json?.decision, "block", `${label}: checkCrossModelMergeGate must block, got ${JSON.stringify(r.json)}`);
    assert.ok(r.json.reason.length > 0, `${label}: the block carries a reason`);
  }
  const waiverFree = runHook(MERGE_COMMAND, {
    ghOutput: buildPrJson({ comments: [], headRefOid: CURRENT_SHA }),
    diffFiles: TRIGGER_PATH_WITH_PROPOSAL,
    branch: "feature/second-review-merge-gate",
  });
  assert.match(waiverFree.json.reason, /cross-review/i, "the block still points at the second review");
});

test("Second Review Stays A Merge Gate: gh pr merge without a passing current-head sticky is a block decision, not a host prompt", () => {
  const ghOutput = buildPrJson({ comments: [], headRefOid: CURRENT_SHA });
  const r = runHookSpawn(MERGE_COMMAND, { ghOutput, diffFiles: TRIGGER_PATH_WITH_PROPOSAL, branch: "feature/second-review-merge-gate" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json?.decision, "block", `expected a block decision on stdout, got: ${r.stdout}`);
  assert.match(r.json.reason, /cross-review/i);
  assert.equal(r.stdout.includes("permissionDecision"), false, "the merge block is never a host permission prompt");
  assert.equal(r.stdout.includes('"ask"'), false);
});

test("Same-repo second review remains a merge gate: merge is blocked until exactly one canonical current-head PASS or WARN sticky exists", () => {
  for (const [label, ghOutput] of Object.entries(secondReviewMissingFixtures())) {
    const r = runHook(MERGE_COMMAND, { ghOutput, diffFiles: TRIGGER_PATH_WITH_PROPOSAL, branch: "feature/second-review-merge-gate" });
    assert.equal(r.json?.decision, "block", `${label}: merge stays blocked`);
  }
  for (const verdict of ["PASS", "WARN"]) {
    const ghOutput = buildPrJson({ comments: [{ body: buildStickyBody({ verdict, lastReviewedSha: CURRENT_SHA }) }], headRefOid: CURRENT_SHA });
    const r = runHook(MERGE_COMMAND, { ghOutput, diffFiles: TRIGGER_PATH_WITH_PROPOSAL, branch: "feature/second-review-merge-gate" });
    assert.notEqual(r.json?.decision, "block", `exactly one current-head ${verdict} sticky opens the gate, got ${JSON.stringify(r.json)}`);
  }
});

// The shared pre-tool hook never turns a second-review command into a host permission prompt.
const NO_ASK_BUILDER_CMD = "node .devpro/scripts/build-pr-sticky-handoff.mjs --pr 3018 --lite --branch feature/x";
const NO_ASK_RENDERER_CMD = "node .devpro/scripts/render-second-review-packet.mjs --handoff notes/tmp/synthetic-handoff.json";
// Every host the hook can run under: the Claude Code marker, other host markers, the Codex runtime and no marker.
const NO_ASK_HOST_ENVS = [
  { label: "claude-code host", env: { DEVPRO_HOOK_HOST: "claude-code" } },
  { label: "cursor host", env: { DEVPRO_HOOK_HOST: "cursor" } },
  { label: "opencode host", env: { DEVPRO_HOOK_HOST: "opencode" } },
  { label: "codex host marker", env: { DEVPRO_HOOK_HOST: "codex" } },
  { label: "codex runtime", env: { CODEX_THREAD_ID: "synthetic-thread" } },
  { label: "claude-code marker inside the codex runtime", env: { DEVPRO_HOOK_HOST: "claude-code", CODEX_THREAD_ID: "synthetic-thread" } },
  { label: "no host marker", env: {} },
];

function runNoAskBash(command, env = {}) {
  return runHarnessHook(HOOK, { tool_name: "Bash", tool_input: { command, cwd: repoPath(".") } }, {
    cwd: repoPath("."),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
}

// The hook prints nothing when it passes through; any output must be JSON that carries no permission prompt.
function assertNoAsk(result, context) {
  assert.equal(result.status, 0, context);
  if (result.stdout.trim() === "") return;
  const out = JSON.parse(result.stdout);
  assert.notEqual(out.hookSpecificOutput?.permissionDecision, "ask", context);
  assert.equal(out.hookSpecificOutput?.permissionDecisionReason, undefined, context);
  assert.ok(!result.stdout.includes('"ask"'), context);
}

// The hook source is the second half of the guard: nothing in it may route to an ask.
function assertSourceHasNoAskRoute(source) {
  assert.ok(!source.includes("lite-grant-gate"), "pre-tool-gate.mjs does not import or mention the lite grant gate");
  assert.ok(!source.includes("emitAsk"), "pre-tool-gate.mjs does not define or call emitAsk");
}

test("Pre-tool hook never asks for the second-review builder or renderer commands: no permissionDecision of ask on any host, with or without the bypass prefix", () => {
  for (const { label, env } of NO_ASK_HOST_ENVS) {
    for (const [name, command] of [["handoff builder", NO_ASK_BUILDER_CMD], ["packet renderer", NO_ASK_RENDERER_CMD]]) {
      for (const prefix of ["", "DEVPRO_HOOK_BYPASS=1 "]) {
        assertNoAsk(runNoAskBash(`${prefix}${command}`, env), `${name} on ${label} with prefix ${JSON.stringify(prefix)}`);
      }
    }
  }
});

test("Pre-tool hook source has no lite grant gate and no emitAsk route", () => {
  const source = readFileSync(HOOK, "utf8");
  assertSourceHasNoAskRoute(source);
  // Mutation: reintroducing either token turns the source check red.
  assert.throws(() => assertSourceHasNoAskRoute(`${source}\nimport "./lite-grant-gate.mjs";`));
  assert.throws(() => assertSourceHasNoAskRoute(`${source}\nfunction emitAsk() {}`));
});
