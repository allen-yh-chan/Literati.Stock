/**
 * Renderer-level R3 prove-it: checkReviewRoundBudget must forward
 * pageWindowHandoff so proven page-window-continue remains reachable at cap
 * (parity with recordReviewRoundBudgetDispatch).
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  PR_STICKY_REVIEW_ROUND_CAP,
  reviewRoundSidecarPath,
} from "../hooks/lib/review-round-budget.mjs";
import {
  buildPageWindowHandoffFromCarrier,
  checkReviewRoundBudget,
} from "../render-second-review-packet.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

function withStateDir(fn) {
  const dir = makeTempDir("devpro-render-round-handoff-");
  const previous = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (previous === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previous;
  }
}

test("buildPageWindowHandoffFromCarrier mirrors check/record carrier shape", () => {
  assert.equal(buildPageWindowHandoffFromCarrier(null), null);
  assert.equal(buildPageWindowHandoffFromCarrier({ page_window_checkpoint_handoff: false }), null);
  assert.deepEqual(
    buildPageWindowHandoffFromCarrier({
      page_window_checkpoint_handoff: true,
      head_ref_oid: "a".repeat(40),
      page_window_index: 3,
    }),
    {
      page_window_checkpoint_handoff: true,
      head_ref_oid: "a".repeat(40),
      window_index: 3,
    },
  );
});

test("R3 renderer: checkReviewRoundBudget exempts proven continue at round_count cap", () => {
  withStateDir(() => {
    const prNumber = "2810";
    const head = "f".repeat(40);
    const file = reviewRoundSidecarPath({ prNumber });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      schema_version: 1,
      pr_number: prNumber,
      repository_slug: "devpro/example",
      round_count: PR_STICKY_REVIEW_ROUND_CAP,
      dispatch_lineage: [
        {
          round: 1,
          kind: "initial",
          attempt: "initial",
          dispatch_id: "dispatch-w1",
          head_ref_oid: head,
          review_scope: "full-pr",
          page_window_index: 1,
          recorded_at: new Date(0).toISOString(),
        },
        {
          round: 2,
          kind: "focused-sticky-refresh",
          attempt: "focused-sticky-refresh",
          dispatch_id: "dispatch-f2",
          head_ref_oid: head,
          review_scope: "full-pr",
          recorded_at: new Date(0).toISOString(),
        },
        {
          round: 3,
          kind: "focused-sticky-refresh",
          attempt: "focused-sticky-refresh",
          dispatch_id: "dispatch-f3",
          head_ref_oid: head,
          review_scope: "full-pr",
          recorded_at: new Date(0).toISOString(),
        },
      ],
      updated_at: new Date(0).toISOString(),
    }));

    const countingInput = {
      mode: "pr-sticky",
      attempt: "initial",
      target: `PR #${prNumber}`,
      repository_slug: "devpro/example",
      head_ref_oid: head,
    };
    assert.equal(checkReviewRoundBudget({ ...countingInput, repository_slug: "fixture/other-repo" }, { env: {} }).prior_round_count, 0);
    let thrown = null;
    try {
      checkReviewRoundBudget(countingInput);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, "counting attempt at cap must exhaust via renderer check");
    assert.equal(thrown.classification, "review_round_budget_exhausted");

    const continueInput = {
      mode: "pr-sticky",
      attempt: "initial",
      target: `PR #${prNumber}`,
      repository_slug: "devpro/example",
      head_ref_oid: head,
      page_window_checkpoint_handoff: true,
      page_window_index: 2,
    };
    const evaluation = checkReviewRoundBudget(continueInput);
    assert.ok(evaluation);
    assert.equal(evaluation.resolved_attempt.kind, "page-window-continue");
    assert.equal(evaluation.resolved_attempt.counting, false);
  });
});
