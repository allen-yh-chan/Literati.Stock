import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as stickyAuthority from "../hooks/lib/second-review-sticky-authority.mjs";

const MARKER = "<!-- cross-model-second-opinion:sticky -->";
const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FOOTER = "Rules: v6.83.10 · Tool: Claude Code · Model: claude-test";

function canonicalBody() {
  return [
    MARKER,
    "verdict: PASS",
    `last_reviewed_sha: ${SHA}`,
    "dispatch_id: dispatch-authority-test",
    "reason: The bounded review completed for the requested scope.",
    FOOTER,
  ].join("\n");
}

function duplicateAuthority(body, authority) {
  const lines = body.split("\n");
  const footerIndex = lines.length - 1;
  const mutations = {
    marker: () => lines.splice(1, 0, MARKER),
    verdict: () => lines.splice(2, 0, "verdict: PASS"),
    last_reviewed_sha: () => lines.splice(3, 0, `last_reviewed_sha: ${SHA}`),
    dispatch_id: () => lines.splice(4, 0, "dispatch_id: dispatch-authority-test"),
    reason: () => lines.splice(5, 0, "reason: The bounded review completed for the requested scope."),
    rules: () => lines.splice(footerIndex, 0, FOOTER),
    tool: () => lines.splice(footerIndex, 0, "Tool: Claude Code"),
    model: () => lines.splice(footerIndex, 0, "Model: claude-test"),
  };
  mutations[authority]();
  return lines.join("\n");
}

test("shared sticky authority parser preserves the canonical happy path", () => {
  assert.equal(
    typeof stickyAuthority.parseSecondReviewStickyAuthorityBody,
    "function",
    "runner and gates need one shared body parser"
  );
  const parsed = stickyAuthority.parseSecondReviewStickyAuthorityBody(canonicalBody());
  assert.equal(parsed.status, "valid");
  assert.equal(parsed.verdict, "PASS");
  assert.equal(parsed.last_reviewed_sha, SHA);
  assert.equal(parsed.dispatch_id, "dispatch-authority-test");
  assert.equal(parsed.reason, "The bounded review completed for the requested scope.");
  assert.equal(parsed.rules_version, "6.83.10");
  assert.equal(parsed.reviewer_tool, "Claude Code");
  assert.equal(parsed.reviewer_model, "claude-test");
  assert.deepEqual(parsed.contract_errors, []);
});

test("shared sticky authority parser rejects every repeated authority carrier", () => {
  const cases = [
    ["marker", "sticky_marker_duplicate"],
    ["verdict", "sticky_verdict_duplicate"],
    ["last_reviewed_sha", "sticky_last_reviewed_sha_duplicate"],
    ["dispatch_id", "sticky_dispatch_id_duplicate"],
    ["reason", "sticky_reason_duplicate"],
    ["rules", "sticky_rules_duplicate"],
    ["tool", "sticky_tool_duplicate"],
    ["model", "sticky_model_duplicate"],
  ];

  for (const [authority, expectedError] of cases) {
    const parsed = stickyAuthority.parseSecondReviewStickyAuthorityBody(
      duplicateAuthority(canonicalBody(), authority)
    );
    assert.equal(parsed.status, "invalid", `${authority} duplicate must fail closed`);
    assert.ok(
      parsed.contract_errors.includes(expectedError),
      `${authority} duplicate errors: ${JSON.stringify(parsed.contract_errors)}`
    );
  }
});

test("shared sticky authority parser rejects reordered fields and a non-final footer", () => {
  const reordered = canonicalBody()
    .replace(
      `last_reviewed_sha: ${SHA}\ndispatch_id: dispatch-authority-test`,
      `dispatch_id: dispatch-authority-test\nlast_reviewed_sha: ${SHA}`
    );
  const reorderedResult = stickyAuthority.parseSecondReviewStickyAuthorityBody(reordered);
  assert.equal(reorderedResult.status, "invalid");
  assert.ok(reorderedResult.contract_errors.includes("sticky_authority_field_order_invalid"));

  const footerNotFinal = `${canonicalBody()}\nunexpected trailing text`;
  const footerResult = stickyAuthority.parseSecondReviewStickyAuthorityBody(footerNotFinal);
  assert.equal(footerResult.status, "invalid");
  assert.ok(footerResult.contract_errors.includes("sticky_provenance_footer_missing_or_invalid"));
});

const REPOSITORY_SLUG = "devpro/example";
const PR_NUMBER = 1716;
const COMMENT_ID = 4242;
const COMMENT_URL =
  "https://github.com/devpro/example/pull/1716#issuecomment-4242";
const COMMENT_NODE_ID = "IC_kwDOExample1716";
const COMMENT_UPDATED_AT = "2026-07-20T03:04:05Z";
const DISPOSITION_SCHEMA = "devpro-second-review-sticky-write-disposition/v1";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function restComment(overrides = {}) {
  return {
    id: COMMENT_ID,
    node_id: COMMENT_NODE_ID,
    html_url: COMMENT_URL,
    body: canonicalBody(),
    updated_at: COMMENT_UPDATED_AT,
    ...overrides,
  };
}

function graphqlComment(overrides = {}) {
  return {
    id: COMMENT_NODE_ID,
    url: COMMENT_URL,
    body: canonicalBody(),
    updatedAt: COMMENT_UPDATED_AT,
    ...overrides,
  };
}

function completeSnapshot(comments, overrides = {}) {
  return {
    repository_slug: REPOSITORY_SLUG,
    pr_number: PR_NUMBER,
    completeness: {
      status: "complete",
      pagination_exhausted: true,
      pages_fetched: 1,
    },
    query_error: null,
    comments,
    ...overrides,
  };
}

// The fallback deliberately exercises the pre-fix shared selector so RED failures
// report the missing disposition semantics instead of failing on a missing export.
function resolveUnderTest(snapshot, options = {}) {
  if (typeof stickyAuthority.resolveSecondReviewStickyWriteDisposition === "function") {
    return stickyAuthority.resolveSecondReviewStickyWriteDisposition(snapshot, options);
  }
  const comments = Array.isArray(snapshot?.comments) ? snapshot.comments : [];
  return stickyAuthority.selectExactSecondReviewStickyAuthority(comments);
}

function assertBlockedDisposition(disposition, label) {
  assert.equal(disposition.action, "blocked", `${label} must fail closed`);
  assert.match(
    disposition.classification,
    /^[a-z0-9_]{1,80}$/,
    `${label} needs one bounded machine classification`
  );
  assert.equal(typeof disposition.reason, "string", `${label} needs a bounded reason`);
  assert.ok(disposition.reason.length > 0 && disposition.reason.length <= 512);
  assert.equal(disposition.target, undefined, `${label} must not expose an executable target`);
}

for (const attempt of ["initial", "focused-sticky-refresh", "fault-recovery"]) {
  for (const [candidateCount, expectedAction] of [
    [0, "create"],
    [1, "update"],
    [2, "blocked"],
  ]) {
    test(`RED-1 ${attempt} attempt resolves ${candidateCount} sticky candidates to ${expectedAction}`, () => {
      const comments = Array.from({ length: candidateCount }, (_, index) =>
        restComment({
          id: COMMENT_ID + index,
          html_url: COMMENT_URL.replace("4242", String(COMMENT_ID + index)),
        })
      );
      const disposition = resolveUnderTest(completeSnapshot(comments));

      assert.equal(disposition.action, expectedAction);
      assert.equal(disposition.candidate_count, candidateCount);
      assert.equal(disposition.schema, DISPOSITION_SCHEMA);
      assert.equal(disposition.repository_slug, REPOSITORY_SLUG);
      assert.equal(disposition.pr_number, PR_NUMBER);
      assert.equal(disposition.marker, MARKER);
      assert.match(disposition.snapshot_digest, /^[a-f0-9]{64}$/);
      if (expectedAction === "blocked") {
        assertBlockedDisposition(disposition, `${attempt} duplicate authority`);
      }
    });
  }
}

test("RED-1 normalizes REST and GraphQL comment identities to the same exact update target", () => {
  const dispositions = [restComment(), graphqlComment()].map((comment) => {
    const disposition = resolveUnderTest(completeSnapshot([comment]));
    assert.equal(disposition.action, "update");
    assert.deepEqual(disposition.target, {
      id: COMMENT_ID,
      url: COMMENT_URL,
      node_id: COMMENT_NODE_ID,
      body_sha256: sha256(canonicalBody()),
      updated_at: COMMENT_UPDATED_AT,
    });
    return disposition;
  });
  assert.equal(
    dispositions[0].snapshot_digest,
    dispositions[1].snapshot_digest,
    "logically identical complete REST and GraphQL snapshots need one provider-neutral authority digest"
  );
});

test("RED-1 blocks incomplete, failed, malformed, and cross-scope authority snapshots", () => {
  const invalidSnapshots = [
    [
      "incomplete pagination",
      completeSnapshot([], {
        completeness: {
          status: "incomplete",
          pagination_exhausted: false,
          pages_fetched: 1,
        },
      }),
    ],
    [
      "query failure",
      completeSnapshot([], {
        completeness: {
          status: "failed",
          pagination_exhausted: false,
          pages_fetched: 0,
        },
        query_error: { classification: "github_query_failed", message: "bounded fixture" },
      }),
    ],
    ["invalid snapshot shape", completeSnapshot("not-an-array")],
    [
      "cross-repository canonical URL",
      completeSnapshot([
        restComment({
          html_url:
            "https://github.com/devpro/another/pull/1716#issuecomment-4242",
        }),
      ]),
    ],
    [
      "cross-PR canonical URL",
      completeSnapshot([
        restComment({
          html_url:
            "https://github.com/devpro/example/pull/1717#issuecomment-4242",
        }),
      ]),
    ],
    [
      "REST ID and canonical URL mismatch",
      completeSnapshot([restComment({ id: 4243 })]),
    ],
    [
      "GraphQL node ID mismatch",
      completeSnapshot([
        restComment({
          node_id: COMMENT_NODE_ID,
          graphql_id: "IC_kwDOMismatched1716",
        }),
      ]),
    ],
  ];

  for (const [label, snapshot] of invalidSnapshots) {
    assertBlockedDisposition(resolveUnderTest(snapshot), label);
  }
});

test("RED-1 expected disposition revalidation blocks freshness and render-to-spawn drift", () => {
  const renderedUpdate = resolveUnderTest(completeSnapshot([restComment()]));
  const driftCases = [
    [
      "GraphQL node ID drift",
      completeSnapshot([restComment({ node_id: "IC_kwDOChanged1716" })]),
      renderedUpdate,
    ],
    [
      "body digest drift",
      completeSnapshot([
        restComment({
          body: canonicalBody().replace("verdict: PASS", "verdict: REQUEST_CHANGES"),
        }),
      ]),
      renderedUpdate,
    ],
    [
      "updated_at drift",
      completeSnapshot([restComment({ updated_at: "2026-07-20T03:05:06Z" })]),
      renderedUpdate,
    ],
    [
      "render-to-spawn candidate-count drift",
      completeSnapshot([restComment()]),
      resolveUnderTest(completeSnapshot([])),
    ],
  ];

  for (const [label, liveSnapshot, expectedDisposition] of driftCases) {
    assertBlockedDisposition(
      resolveUnderTest(liveSnapshot, { expectedDisposition }),
      label
    );
  }
});

// RED-2: marker presence is undecidable for an element that does not carry a
// verbatim string `body`, so dropping it silently makes "the handoff snapshot is
// lossy" indistinguishable from "this PR really has no sticky". Both arms below
// resolved to an executable disposition before the fix — `create` when the lossy
// element left zero visible candidates, `update` when one visible candidate
// remained while the lossy element may itself have been a second canonical
// sticky (the state `sticky_authority_ambiguous` exists to refuse).
const LOSSY_COMMENT_ELEMENTS = [
  ["null element", null],
  ["string element carrying the marker", `${MARKER} verdict: PASS`],
  ["summary-only element", { id: COMMENT_ID + 9, summary: "second opinion sticky" }],
  ["non-string body", restComment({ id: COMMENT_ID + 9, body: { text: canonicalBody() } })],
];

for (const [label, element] of LOSSY_COMMENT_ELEMENTS) {
  test(`RED-2 ${label} blocks instead of creating a second sticky`, () => {
    const disposition = resolveUnderTest(completeSnapshot([element]));
    assertBlockedDisposition(disposition, `${label} with no visible candidate`);
    assert.equal(disposition.classification, "sticky_snapshot_comments_invalid");
  });

  test(`RED-2 ${label} blocks instead of updating the only visible candidate`, () => {
    const disposition = resolveUnderTest(completeSnapshot([restComment(), element]));
    assertBlockedDisposition(disposition, `${label} beside one visible candidate`);
    assert.equal(disposition.classification, "sticky_snapshot_comments_invalid");
  });
}

test("rewriteStickyProvenanceModel replaces only the final provenance Model token", () => {
  assert.equal(typeof stickyAuthority.rewriteStickyProvenanceModel, "function");
  const rewritten = stickyAuthority.rewriteStickyProvenanceModel(
    canonicalBody(),
    "claude-opus-5",
  );
  const parsed = stickyAuthority.parseSecondReviewStickyAuthorityBody(rewritten);
  assert.equal(parsed.status, "valid");
  assert.equal(parsed.reviewer_model, "claude-opus-5");
  assert.equal(parsed.reviewer_tool, "Claude Code");
  assert.equal(parsed.rules_version, "6.83.10");
  assert.equal(
    rewritten.split("\n").at(-1),
    "Rules: v6.83.10 · Tool: Claude Code · Model: claude-opus-5",
  );
  assert.equal(
    rewritten.split("\n").filter((line) => line.startsWith("Rules:")).length,
    1,
  );
});

test("rewriteStickyProvenanceModel leaves a non-footer body unchanged", () => {
  const body = "not a sticky\n";
  assert.equal(
    stickyAuthority.rewriteStickyProvenanceModel(body, "claude-opus-5"),
    body,
  );
});

function bodyWithFooter(footerLine) {
  return [
    MARKER,
    "verdict: PASS",
    `last_reviewed_sha: ${SHA}`,
    "dispatch_id: dispatch-authority-test",
    "reason: The bounded review completed for the requested scope.",
    footerLine,
  ].join("\n");
}

test("D3: STICKY_PROVENANCE_TOOL_TOKENS is the exact frozen closed set", () => {
  assert.deepEqual(stickyAuthority.STICKY_PROVENANCE_TOOL_TOKENS, [
    "Claude Code",
    "Codex",
    "Gemini CLI",
    "OpenCode",
    "Cursor",
    "Copilot CLI",
  ]);
  assert.ok(Object.isFrozen(stickyAuthority.STICKY_PROVENANCE_TOOL_TOKENS));
});

test("D3: shared sticky authority parser accepts every closed-set provenance token", () => {
  for (const token of stickyAuthority.STICKY_PROVENANCE_TOOL_TOKENS) {
    const body = bodyWithFooter(`Rules: v6.83.10 · Tool: ${token} · Model: some-model-identity`);
    const parsed = stickyAuthority.parseSecondReviewStickyAuthorityBody(body);
    assert.equal(parsed.status, "valid", `token ${token} should parse valid`);
    assert.equal(parsed.reviewer_tool, token, `token ${token} reviewer_tool group`);
    assert.equal(parsed.reviewer_model, "some-model-identity", `token ${token} reviewer_model group`);
    assert.equal(parsed.rules_version, "6.83.10", `token ${token} rules_version group`);
    assert.deepEqual(parsed.contract_errors, []);
  }
});

test("D3: shared sticky authority parser hard-blocks a Tool token outside the closed set", () => {
  const body = bodyWithFooter("Rules: v6.83.10 · Tool: Foo Bar · Model: some-model-identity");
  const parsed = stickyAuthority.parseSecondReviewStickyAuthorityBody(body);
  assert.equal(parsed.status, "invalid");
  assert.ok(parsed.contract_errors.includes("sticky_provenance_footer_missing_or_invalid"));
  assert.equal(parsed.reviewer_tool, null);
});

test("D3: existing runner footer tokens (Claude Code, Codex) remain byte-identical", () => {
  for (const token of ["Claude Code", "Codex"]) {
    const body = bodyWithFooter(`Rules: v6.83.10 · Tool: ${token} · Model: claude-test`);
    const parsed = stickyAuthority.parseSecondReviewStickyAuthorityBody(body, {
      expectedReviewerTool: token,
    });
    assert.equal(parsed.status, "valid");
    assert.equal(parsed.reviewer_tool, token);
    assert.deepEqual(parsed.contract_errors, []);
  }
});

test("D3: MODEL_FAMILY_PATTERNS classify each family's model identity prefix, case-insensitively", () => {
  const patterns = stickyAuthority.MODEL_FAMILY_PATTERNS;
  assert.match("claude-opus-5", patterns.claude);
  assert.match("CLAUDE-OPUS-5", patterns.claude);
  assert.doesNotMatch("gpt-5", patterns.claude);

  assert.match("gpt-5-codex", patterns.codex);
  assert.match("o1-preview", patterns.codex);
  assert.match("codex-mini", patterns.codex);
  assert.doesNotMatch("claude-opus-5", patterns.codex);

  assert.match("gpt-5-codex", patterns["openai-codex"]);
  assert.match("o3-mini", patterns["openai-codex"]);

  assert.match("gemini-2.5-pro", patterns.gemini);
  assert.match("GEMINI-2.5-PRO", patterns.gemini);
  assert.doesNotMatch("claude-opus-5", patterns.gemini);
});

// fix-session-pending-residual-gaps: the one reader of "what was last reviewed" that the
// renderer's minimality gate and the handoff builder both use.
test("resolveReadyStickyBaseline returns the single READY sticky and null for every other shape", () => {
  const ready = stickyAuthority.resolveReadyStickyBaseline(completeSnapshot([restComment()]));
  assert.equal(ready?.verdict, "PASS");
  assert.equal(ready?.last_reviewed_sha, SHA);

  const warn = stickyAuthority.resolveReadyStickyBaseline(
    completeSnapshot([restComment({ body: canonicalBody().replace("verdict: PASS", "verdict: WARN") })]),
  );
  assert.equal(warn?.verdict, "WARN");

  assert.equal(stickyAuthority.resolveReadyStickyBaseline(completeSnapshot([])), null, "no sticky: nothing was reviewed");
  assert.equal(
    stickyAuthority.resolveReadyStickyBaseline(completeSnapshot([restComment({ body: canonicalBody().replace("verdict: PASS", "verdict: UNAVAILABLE") })])),
    null,
    "only PASS or WARN is a reviewed baseline",
  );
  assert.equal(
    stickyAuthority.resolveReadyStickyBaseline(completeSnapshot([restComment({ body: "a human comment, no marker" })])),
    null,
  );
  assert.equal(
    stickyAuthority.resolveReadyStickyBaseline(completeSnapshot([restComment()], { completeness: { status: "failed", pagination_exhausted: false, pages_fetched: 1 } })),
    null,
    "an incomplete snapshot never yields a baseline",
  );
});
