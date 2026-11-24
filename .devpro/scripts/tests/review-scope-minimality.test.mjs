import "./lib/model-probe-fixture.mjs";
// TC4 (strengthen-cross-review-loop-termination R5/R6/R7/D6): renderer-side
// review-scope minimality + drift + convergence-instruction coverage.
//   - `review_scope_not_minimal` blocks a full-pr pr-sticky handoff without
//     `full_scope_reason` once a prior READY sticky (PASS/WARN with
//     last_reviewed_sha) exists in the handoff's sticky_authority_snapshot;
//     the sticky snapshot — NOT the round-budget sidecar lineage — is the
//     reviewed-baseline evidence (no sticky → full-pr stays the only legal
//     scope and must pass).
//   - `attempt: fault-recovery` is exempt.
//   - `review_scope_drift` is advisory-only: the packet carries the advisory
//     bullet, the render still succeeds.
//   - The reviewer instructions carry the R6 carrier_class + convergence
//     rule lines; sticky bodies parse with and without the optional
//     `tracked_follow_up:` line.
import "./lib/portable-command-shims.cjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalEmbeddedReviewMaterialProof } from "../second-review-material-contract.mjs";
import { secondReviewRulesVersion } from "../validate-second-review-packet.mjs";
import { parseSecondReviewStickyAuthorityBody } from "../hooks/lib/second-review-sticky-authority.mjs";
import { deriveMainCheckoutNotesTmp } from "../second-reviewer-cli-recipe-contract.mjs";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { resolveNativeExecutableOnPath } from "./lib/resolve-native-executable.mjs";
import {
  assertAttemptUnderOwnedRoot,
  assertNotLiveWrite,
  clearOwnedCanonicalCache,
  prepareOwnedCanonicalRenderer,
} from "./lib/owned-canonical-carrier.mjs";

// Keep renderer integration tests off live Claude; same stubs as
// validate-second-review-packet.test.mjs.
process.env.DEVPRO_ALLOW_CLAUDE_EFFORT_STUB ??= "1";
process.env.DEVPRO_SECOND_REVIEW_CLAUDE_EFFORT_STUB ??= "xhigh";

const RENDERER = repoPath(".devpro/scripts/render-second-review-packet.mjs");
const RULES_VERSION = secondReviewRulesVersion(REPO_ROOT);
const liveCanonicalCarrierRoot = path.join(
  path.dirname(deriveMainCheckoutNotesTmp(REPO_ROOT)),
  "cross-review"
);
const HEAD_SHA = "c".repeat(40);

function diffFor(file) {
  return [
    `diff --git a/${file} b/${file}`,
    "index 1111111..2222222 100644",
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1 +1 @@",
    "-legacy",
    "+typed scope",
    "",
  ].join("\n");
}

function readyStickyComment() {
  return {
    id: 4242,
    node_id: "IC_kwDOExample1716",
    html_url: "https://github.com/devpro/example/pull/1716#issuecomment-4242",
    body: [
      "<!-- cross-model-second-opinion:sticky -->",
      "verdict: PASS",
      "last_reviewed_sha: abc1234",
      "dispatch_id: prior-dispatch",
      "reason: Prior bounded review completed.",
      `Rules: v${RULES_VERSION} · Tool: Claude Code · Model: claude-test`,
    ].join("\n"),
    updated_at: "2026-07-20T03:04:05Z",
  };
}

function minimalityHandoff({
  comments = [],
  attempt = "initial",
  fullScopeReason,
  files = ["src/minimality-case.mjs"],
  scopeSummary = "bounded pr-sticky minimality fixture",
} = {}) {
  const approvalContext = "none";
  const reviewScope = { kind: "full-pr", pull_request_number: 1716, head_sha: HEAD_SHA };
  const material = files.map(diffFor).join("");
  return {
    mode: "pr-sticky",
    attempt,
    primary_family: "openai-codex",
    reviewer_family: "claude",
    target: "PR #1716",
    head_ref_oid: HEAD_SHA,
    repository_slug: "devpro/example",
    approval_context: approvalContext,
    approval_resolution: { status: "not-required" },
    pr_head_ref_name: "chore/strengthen-cross-review-loop-termination",
    scope_summary: scopeSummary,
    changed_files_or_touch_list: files,
    review_scope: reviewScope,
    review_material_carrier: "embedded-diff",
    review_material_capability: "scope-bound-embedded-complete-diff-v1",
    review_material_proof: canonicalEmbeddedReviewMaterialProof(reviewScope, material),
    review_material: material,
    primary_validation_evidence: "openspec validate strengthen-cross-review-loop-termination --strict passed",
    primary_test_evidence: "node --test focused second-review suites passed",
    retry_context: { classification: "none", sticky_verification: "not-needed" },
    write_path: "reviewer current neutral cwd body file plus disposition-bound gh api only",
    allowed_tools: `Write,Bash(command -v gh),Bash(gh pr view:*),Bash(node ${repoPath(".devpro/scripts/read-second-review-sticky-comment.mjs")}:*),Bash(node ${repoPath(".devpro/scripts/write-second-review-sticky-gated.mjs")}:*)`,
    sticky_authority_snapshot: {
      repository_slug: "devpro/example",
      pr_number: 1716,
      completeness: { status: "complete", pagination_exhausted: true, pages_fetched: 1 },
      query_error: null,
      comments,
    },
    ...(fullScopeReason ? { full_scope_reason: fullScopeReason } : {}),
  };
}

// Same immutable-closure PATH shim shape as validate-second-review-packet.test.mjs:
// A (git name-status) and M (raw diff bytes) are generated from the handoff
// itself so A = D = M holds for every fixture.
function immutableAuthorityFixture(handoff, dir) {
  const fixtureBin = path.join(dir, "immutable-authority-bin");
  mkdirSync(fixtureBin, { recursive: true });
  const comparisonBase = "c".repeat(40);
  const nameStatus = handoff.changed_files_or_touch_list
    .map((changedPath) => `M\0${changedPath}\0`)
    .join("");
  const realGit = resolveNativeExecutableOnPath("git");
  writeFileSync(path.join(fixtureBin, "git"), `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.join(" ") === "rev-parse --show-toplevel") process.stdout.write(${JSON.stringify(`${REPO_ROOT}\n`)});
else if (args[0] === "merge-base") process.stdout.write(${JSON.stringify(`${comparisonBase}\n`)});
else if (args[0] === "diff" && args.includes("--name-status")) process.stdout.write(Buffer.from(${JSON.stringify(Buffer.from(nameStatus, "utf8").toString("base64"))}, "base64"));
else if (args[0] === "diff") process.stdout.write(Buffer.from(${JSON.stringify(Buffer.from(handoff.review_material, "utf8").toString("base64"))}, "base64"));
else { const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" }); process.exit(result.status ?? 1); }
`, { mode: 0o700 });
writeFileSync(path.join(fixtureBin, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view" && args.includes("baseRefOid,headRefOid")) {
  process.stdout.write(JSON.stringify({ baseRefOid: ${JSON.stringify(comparisonBase)}, headRefOid: ${JSON.stringify(handoff.review_scope?.head_sha)} }));
} else { process.stderr.write("unexpected gh fixture args: " + JSON.stringify(args) + "\\n"); process.exit(97); }
`, { mode: 0o700 });
  return `${fixtureBin}${path.delimiter}${process.env.PATH}`;
}

function renderAttempt(handoff) {
  const dir = mkdtempSync(path.join(tmpdir(), "review-scope-minimality-"));
  try {
    const handoffPath = path.join(dir, "handoff.json");
    writeFileSync(handoffPath, JSON.stringify(handoff), "utf8");
    const prepared = prepareOwnedCanonicalRenderer({
      fixtureDir: dir,
      repoRoot: REPO_ROOT,
      rendererPath: RENDERER,
    });
    assertNotLiveWrite(
      prepared.mutatedRendererPath,
      prepared.carrierRootArg,
      liveCanonicalCarrierRoot,
      RENDERER,
    );
    const result = spawnSync(
      process.execPath,
      [prepared.mutatedRendererPath, handoffPath, "--carrier-root", prepared.carrierRootArg],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: immutableAuthorityFixture(handoff, dir),
          DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(dir, "control-evidence"),
          DEVPRO_POST_PR_COMPLETION_STATE_DIR: path.join(dir, "post-pr-completion-state"),
        },
      }
    );
    let packet = null;
    if (result.status === 0) {
      const packetPath = result.stdout.trim();
      assertAttemptUnderOwnedRoot(packetPath, prepared.ownedCarrierRoot);
      packet = readFileSync(packetPath, "utf8");
      rmSync(path.dirname(packetPath), { recursive: true, force: true });
    }
    return { result, packet, output: `${result.stdout}\n${result.stderr}` };
  } finally {
    clearOwnedCanonicalCache(dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("RSM-1: READY sticky + full-pr without full_scope_reason fails closed review_scope_not_minimal", () => {
  const { result, output } = renderAttempt(
    minimalityHandoff({ comments: [readyStickyComment()] })
  );
  assert.notEqual(result.status, 0, "render must fail closed");
  assert.match(output, /review_scope_not_minimal/);
});

test("RSM-2: READY sticky + full-pr WITH full_scope_reason renders; instructions carry carrier_class + convergence rule", () => {
  const { result, packet } = renderAttempt(
    minimalityHandoff({
      comments: [readyStickyComment()],
      fullScopeReason: "re-verifying full-pr minimality fixture",
    })
  );
  assert.equal(result.status, 0, "full_scope_reason must unlock full-pr");
  assert.match(packet, /carrier_class:/);
  assert.match(packet, /Convergence rule: at review round 2 or later/);
  assert.match(packet, /tracked_follow_up_value_rule:/);
  assert.doesNotMatch(
    packet,
    /full_scope_reason/,
    "full_scope_reason is a renderer gate input, not packet payload"
  );
});

test("RSM-3: no prior sticky → full-pr without full_scope_reason stays the only legal scope and renders", () => {
  const { result } = renderAttempt(minimalityHandoff({ comments: [] }));
  assert.equal(result.status, 0, "no reviewed baseline → full-pr must pass without a reason");
});

test("RSM-4: attempt fault-recovery is exempt from minimality even with a READY sticky", () => {
  const { result } = renderAttempt(
    minimalityHandoff({ comments: [readyStickyComment()], attempt: "fault-recovery" })
  );
  assert.equal(result.status, 0, "fault-recovery re-dispatch must not be blocked");
});

test("RSM-5: hooks-touching diff without hooks in scope_summary/target carries the review_scope_drift advisory and still renders", () => {
  const { result, packet } = renderAttempt(
    minimalityHandoff({ files: [".devpro/scripts/hooks/lib/minimality-probe.mjs"] })
  );
  assert.equal(result.status, 0, "drift is advisory-only; render must succeed");
  assert.match(packet, /review_scope_drift/);
});

test("RSM-6: scope_summary naming hooks suppresses the drift advisory", () => {
  const { result, packet } = renderAttempt(
    minimalityHandoff({
      files: [".devpro/scripts/hooks/lib/minimality-probe.mjs"],
      scopeSummary: "hooks infra change reviewed in scope: bounded fixture",
    })
  );
  assert.equal(result.status, 0);
  assert.doesNotMatch(packet, /review_scope_drift/);
});

test("RSM-7: sticky bodies parse with and without the optional tracked_follow_up line", () => {
  const base = readyStickyComment().body;
  const withoutLine = parseSecondReviewStickyAuthorityBody(base);
  assert.equal(withoutLine.status, "valid", "missing tracked_follow_up must stay valid (R-7)");
  assert.equal(withoutLine.tracked_follow_up, null);

  const withLine = parseSecondReviewStickyAuthorityBody(
    base.replace(
      "reason: Prior bounded review completed.",
      "reason: Prior bounded review completed.\ntracked_follow_up: fold lint follow-up into next change"
    )
  );
  assert.equal(withLine.status, "valid");
  assert.equal(withLine.tracked_follow_up, "fold lint follow-up into next change");

  const duplicated = parseSecondReviewStickyAuthorityBody(
    base.replace(
      "reason: Prior bounded review completed.",
      "reason: Prior bounded review completed.\ntracked_follow_up: one\ntracked_follow_up: two"
    )
  );
  assert.notEqual(duplicated.status, "valid", "duplicate tracked_follow_up must fail closed");
});
