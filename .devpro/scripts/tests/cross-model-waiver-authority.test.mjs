import "./lib/isolated-control-evidence-state.mjs";
/**
 * Prove-it tests for cross-model Path W waiver authority (#2499 / PR #2672 WARN remediations).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  CROSS_MODEL_WAIVER_MARKER,
  CROSS_MODEL_WAIVER_AUTHORIZED_ASSOCIATIONS,
  parseCrossModelWaiverAuthorityBody,
  selectExactCrossModelWaiverAuthority,
  evaluateCrossModelWaiverPathW,
  stickyAllowsCrossModelWaiverPathW,
  extractCrossModelWaiverCommentBodyFilePaths,
  bodyStartsWithCrossModelWaiverMarker,
} from "../hooks/lib/second-review-waiver-authority.mjs";
import { checkCrossModelMergeGate } from "../hooks/pre-tool-gate.mjs";
import { __testSnapshotFromGhData as snapshotFromGhData } from "../hooks/post-pr-completion-check.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HEAD = "abc1234def5678901234567890abcdef01234567";
const OLD = "9990a1d5aa000000000000000000000000000000";
const ABBREV = "abc1234";
const PR = "9999";
const PROPOSAL = "openspec/changes/test-change/proposal.md";
const STICKY_MARKER = "<!-- cross-model-second-opinion:sticky -->";

function validWaiverBody({ sha = HEAD, grantedBy = "human-operator", reason = "Windows paged carrier blocks sticky write" } = {}) {
  return [
    CROSS_MODEL_WAIVER_MARKER,
    `waived_head_sha: ${sha}`,
    `granted_by: ${grantedBy}`,
    `reason: ${reason}`,
  ].join("\n");
}

function authorizedComment(body, {
  id = "W_1",
  login = "repo-owner",
  authorAssociation = "OWNER",
} = {}) {
  return {
    id,
    url: `https://github.com/example/repo/pull/${PR}#issuecomment-1`,
    body,
    author: { login },
    authorAssociation,
  };
}

function stickyBody({ verdict = "PASS", sha = HEAD } = {}) {
  return [
    STICKY_MARKER,
    "## Cross-Model Second Opinion Review",
    "",
    `verdict: ${verdict}`,
    `last_reviewed_sha: ${sha}`,
    "dispatch_id: dispatch-waiver-test",
    "reason: Bounded review completed for the requested scope.",
    "Rules: v6.95.0 · Tool: Claude Code · Model: claude-test",
  ].join("\n");
}

function withMergeMocks({ comments, headRefOid = HEAD, headRefName = "feature/needs-review" }, fn) {
  const saved = {
    CROSS_MODEL_MERGE_GATE_MOCK_BRANCH: process.env.CROSS_MODEL_MERGE_GATE_MOCK_BRANCH,
    CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: process.env.CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES,
    CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: process.env.CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT,
  };
  try {
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_BRANCH = headRefName;
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES = PROPOSAL;
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT = JSON.stringify({
      headRefOid,
      headRefName,
      comments: comments.map((c, i) => (
        typeof c === "string"
          ? authorizedComment(c, { id: `W_${i}` })
          : { ...authorizedComment(c.body || "", { id: `W_${i}` }), ...c }
      )),
    });
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("parseCrossModelWaiverAuthorityBody", () => {
  it("accepts exact-once marker + three bare fields with 40-hex sha", () => {
    const parsed = parseCrossModelWaiverAuthorityBody(validWaiverBody());
    assert.equal(parsed.status, "valid");
    assert.equal(parsed.waived_head_sha, HEAD);
    assert.equal(parsed.granted_by, "human-operator");
    assert.match(parsed.reason, /Windows/);
  });

  it("rejects abbreviated sha, missing marker, duplicate fields, and non-first marker", () => {
    assert.ok(
      parseCrossModelWaiverAuthorityBody(validWaiverBody({ sha: ABBREV }))
        .contract_errors.includes("waiver_waived_head_sha_invalid")
    );
    assert.equal(parseCrossModelWaiverAuthorityBody("waived_head_sha: x\ngranted_by: a\nreason: b").status, "invalid");
    assert.ok(
      parseCrossModelWaiverAuthorityBody(
        `${validWaiverBody()}\nwaived_head_sha: ${HEAD}`
      ).contract_errors.includes("waiver_waived_head_sha_duplicate")
    );
    assert.ok(
      parseCrossModelWaiverAuthorityBody(`note\n${validWaiverBody()}`).contract_errors.includes(
        "waiver_marker_not_first_line"
      )
    );
  });
});

describe("selectExactCrossModelWaiverAuthority / Path W", () => {
  it("requires marker on first line; prose quote is not a candidate", () => {
    assert.equal(bodyStartsWithCrossModelWaiverMarker(`see ${CROSS_MODEL_WAIVER_MARKER} below`), false);
    assert.equal(
      selectExactCrossModelWaiverAuthority([
        { body: `Quoted marker ${CROSS_MODEL_WAIVER_MARKER} in prose` },
        { body: stickyBody() },
      ]).status,
      "missing"
    );
    assert.equal(
      selectExactCrossModelWaiverAuthority([{ body: validWaiverBody() }]).status,
      "selected"
    );
    assert.equal(
      selectExactCrossModelWaiverAuthority([
        { body: validWaiverBody() },
        { body: validWaiverBody({ reason: "second" }) },
      ]).status,
      "ambiguous"
    );
  });

  it("evaluateCrossModelWaiverPathW distinguishes pass / stale / invalid / unauthorized", () => {
    assert.equal(
      evaluateCrossModelWaiverPathW([authorizedComment(validWaiverBody())], HEAD).status,
      "pass"
    );
    const pass = evaluateCrossModelWaiverPathW([authorizedComment(validWaiverBody())], HEAD);
    assert.equal(pass.audit?.author_association, "OWNER");
    assert.equal(pass.audit?.author_login, "repo-owner");
    assert.ok(pass.audit?.comment_id);

    assert.equal(
      evaluateCrossModelWaiverPathW([authorizedComment(validWaiverBody({ sha: OLD }))], HEAD).status,
      "stale"
    );
    assert.equal(
      evaluateCrossModelWaiverPathW(
        [authorizedComment(`${CROSS_MODEL_WAIVER_MARKER}\nwaived_head_sha: ${HEAD}`)],
        HEAD
      ).status,
      "invalid"
    );
    assert.equal(
      evaluateCrossModelWaiverPathW(
        [authorizedComment(validWaiverBody(), { authorAssociation: "CONTRIBUTOR" })],
        HEAD
      ).status,
      "unauthorized"
    );
    assert.equal(
      evaluateCrossModelWaiverPathW([{ body: validWaiverBody() }], HEAD).status,
      "unauthorized"
    );
  });

  it("stickyAllowsCrossModelWaiverPathW only for missing or UNAVAILABLE", () => {
    assert.equal(stickyAllowsCrossModelWaiverPathW({ status: "missing" }), true);
    assert.equal(stickyAllowsCrossModelWaiverPathW({ status: "selected", stickyVerdict: "UNAVAILABLE" }), true);
    assert.equal(stickyAllowsCrossModelWaiverPathW({ status: "selected", stickyVerdict: "CRITICAL" }), false);
    assert.equal(stickyAllowsCrossModelWaiverPathW({ status: "selected", stickyVerdict: "PASS" }), false);
    assert.equal(stickyAllowsCrossModelWaiverPathW({ status: "ambiguous" }), false);
  });

  it("authorized associations are a frozen allowlist array", () => {
    assert.deepEqual([...CROSS_MODEL_WAIVER_AUTHORIZED_ASSOCIATIONS], ["OWNER", "MEMBER", "COLLABORATOR"]);
    assert.ok(Object.isFrozen(CROSS_MODEL_WAIVER_AUTHORIZED_ASSOCIATIONS));
  });
});

describe("checkCrossModelMergeGate Path W", () => {
  it("passes on exact-one authorized current-head waiver without sticky", () => {
    const result = withMergeMocks({ comments: [validWaiverBody()] }, () => (
      checkCrossModelMergeGate(`gh pr merge ${PR} --merge`, process.cwd())
    ));
    assert.equal(result, null);
  });

  it("blocks ambiguous waiver markers", () => {
    const result = withMergeMocks({
      comments: [validWaiverBody(), validWaiverBody({ reason: "dup" })],
    }, () => checkCrossModelMergeGate(`gh pr merge ${PR} --merge`, process.cwd()));
    assert.equal(result?.block, true);
    assert.match(result.reason, /Path W/);
    assert.match(result.reason, /2 條/);
  });

  it("Path B mentions stale / unauthorized waiver when sticky missing", () => {
    const stale = withMergeMocks({
      comments: [validWaiverBody({ sha: OLD })],
    }, () => checkCrossModelMergeGate(`gh pr merge ${PR} --merge`, process.cwd()));
    assert.equal(stale?.block, true);
    assert.match(stale.reason, /Path B/);
    assert.match(stale.reason, /stale waiver/);

    const unauthorized = withMergeMocks({
      comments: [authorizedComment(validWaiverBody(), { authorAssociation: "NONE" })],
    }, () => checkCrossModelMergeGate(`gh pr merge ${PR} --merge`, process.cwd()));
    assert.equal(unauthorized?.block, true);
    assert.match(unauthorized.reason, /Path B/);
    assert.match(unauthorized.reason, /unauthorized waiver/);
  });

  it("Path W MUST NOT override CRITICAL sticky (Path E)", () => {
    const result = withMergeMocks({
      comments: [
        authorizedComment(validWaiverBody()),
        { body: stickyBody({ verdict: "CRITICAL" }) },
      ],
    }, () => checkCrossModelMergeGate(`gh pr merge ${PR} --merge`, process.cwd()));
    assert.equal(result?.block, true);
    assert.match(result.reason, /Path E/);
    assert.match(result.reason, /CRITICAL/);
    assert.match(result.reason, /Path W waiver/);
  });

  it("Path W may clear UNAVAILABLE sticky (Path U)", () => {
    const result = withMergeMocks({
      comments: [
        authorizedComment(validWaiverBody()),
        { body: stickyBody({ verdict: "UNAVAILABLE" }) },
      ],
    }, () => checkCrossModelMergeGate(`gh pr merge ${PR} --merge`, process.cwd()));
    assert.equal(result, null);
  });

  it("Path W MUST NOT override multi-sticky ambiguity (pre-Path F)", () => {
    const result = withMergeMocks({
      comments: [
        authorizedComment(validWaiverBody()),
        { body: stickyBody({ verdict: "PASS" }), id: "S1" },
        { body: stickyBody({ verdict: "WARN" }), id: "S2" },
      ],
    }, () => checkCrossModelMergeGate(`gh pr merge ${PR} --merge`, process.cwd()));
    assert.equal(result?.block, true);
    assert.match(result.reason, /2 條/);
    assert.match(result.reason, /sticky comment/);
    assert.doesNotMatch(result.reason, /Path W：/);
  });

  it("quoted marker in sticky-present prose does not create ambiguous Path W", () => {
    const result = withMergeMocks({
      comments: [
        { body: stickyBody({ verdict: "PASS" }) },
        { body: `Docs mention ${CROSS_MODEL_WAIVER_MARKER} but this is not a waiver` },
      ],
    }, () => checkCrossModelMergeGate(`gh pr merge ${PR} --merge`, process.cwd()));
    assert.equal(result, null);
  });

  it("stale waiver does not override fresh PASS sticky", () => {
    const result = withMergeMocks({
      comments: [
        authorizedComment(validWaiverBody({ sha: OLD })),
        { body: stickyBody({ verdict: "PASS" }) },
      ],
    }, () => checkCrossModelMergeGate(`gh pr merge ${PR} --merge`, process.cwd()));
    assert.equal(result, null);
  });
});

describe("Path W waiver comment writes (the AI posts after the user says so in the conversation)", () => {
  it("pre-tool-gate registers no waiver comment write guard", () => {
    const pre = readFileSync(path.join(HERE, "../hooks/pre-tool-gate.mjs"), "utf8");
    assert.doesNotMatch(pre, /cross-model-waiver-comment-write/);
    assert.doesNotMatch(pre, /checkCrossModelWaiverCommentWriteGuard/);
  });

  it("body-file extraction still serves the lineage approval guard", () => {
    assert.deepEqual(extractCrossModelWaiverCommentBodyFilePaths(`gh pr comment ${PR} -F /tmp/w.md`), ["/tmp/w.md"]);
    assert.deepEqual(extractCrossModelWaiverCommentBodyFilePaths(`gh pr comment ${PR} --body-file=/tmp/w.md`), ["/tmp/w.md"]);
    assert.deepEqual(
      extractCrossModelWaiverCommentBodyFilePaths(`gh api repos/o/r/issues/${PR}/comments -F body=@/tmp/a.md -F body=@/tmp/b.md`),
      ["/tmp/a.md", "/tmp/b.md"],
    );
    assert.deepEqual(extractCrossModelWaiverCommentBodyFilePaths(`gh pr comment ${PR} -F -`), []);
  });
});

describe("post-PR Path W via snapshotFromGhData", () => {
  it("CRITICAL + waiver → no clear; missing/UNAVAILABLE + waiver → hasFreshWaiver", () => {
    const waiver = authorizedComment(validWaiverBody());
    // CRITICAL/UNAVAILABLE are never READY → hasFreshSticky stays false, but
    // Path W still reads ungated stickyVerdictForPathW locally.
    const critical = snapshotFromGhData({
      number: PR,
      headRefOid: HEAD,
      headRefName: "feature/needs-review",
      comments: [waiver, { body: stickyBody({ verdict: "CRITICAL" }), id: "S1" }],
    });
    assert.equal(critical.hasFreshSticky, false);
    assert.equal(critical.stickyVerdict, "");
    assert.equal(critical.hasFreshWaiver, false);

    const missing = snapshotFromGhData({
      number: PR,
      headRefOid: HEAD,
      headRefName: "feature/needs-review",
      comments: [waiver],
    });
    assert.equal(missing.hasFreshWaiver, true);
    assert.equal(missing.hasFreshSticky, false);
    assert.equal(missing.stickyVerdict, "");

    const unavailable = snapshotFromGhData({
      number: PR,
      headRefOid: HEAD,
      headRefName: "feature/needs-review",
      comments: [waiver, { body: stickyBody({ verdict: "UNAVAILABLE" }), id: "S1" }],
    });
    assert.equal(unavailable.hasFreshSticky, false);
    assert.equal(unavailable.stickyVerdict, "");
    assert.equal(unavailable.hasFreshWaiver, true);
  });

  it("keeps snapshot.stickyVerdict fresh-gated; Path W still sees stale UNAVAILABLE", () => {
    const waiver = authorizedComment(validWaiverBody());
    const staleUnavailable = snapshotFromGhData({
      number: PR,
      headRefOid: HEAD,
      headRefName: "feature/needs-review",
      comments: [
        waiver,
        { body: stickyBody({ verdict: "UNAVAILABLE", sha: OLD }), id: "S1" },
      ],
    });
    assert.equal(staleUnavailable.hasFreshSticky, false);
    assert.equal(staleUnavailable.stickyVerdict, "", "stale verdict MUST NOT leak onto snapshot.stickyVerdict");
    assert.equal(staleUnavailable.hasFreshWaiver, true, "Path W uses local ungated verdict for stale UNAVAILABLE");

    const stalePass = snapshotFromGhData({
      number: PR,
      headRefOid: HEAD,
      headRefName: "feature/needs-review",
      comments: [
        waiver,
        { body: stickyBody({ verdict: "PASS", sha: OLD }), id: "S1" },
      ],
    });
    assert.equal(stalePass.hasFreshSticky, false);
    assert.equal(stalePass.stickyVerdict, "");
    assert.equal(stalePass.hasFreshWaiver, false, "stale PASS MUST NOT clear via Path W");

    // Fresh PASS surfaces on snapshot.stickyVerdict; Path W must not clear it.
    const freshPass = snapshotFromGhData({
      number: PR,
      headRefOid: HEAD,
      headRefName: "feature/needs-review",
      comments: [
        waiver,
        { body: stickyBody({ verdict: "PASS", sha: HEAD }), id: "S1" },
      ],
    });
    assert.equal(freshPass.hasFreshSticky, true);
    assert.equal(freshPass.stickyVerdict, "PASS");
    assert.equal(freshPass.hasFreshWaiver, false);
  });

  it("multi-sticky ambiguous MUST NOT set hasFreshWaiver", () => {
    const snap = snapshotFromGhData({
      number: PR,
      headRefOid: HEAD,
      headRefName: "feature/needs-review",
      comments: [
        authorizedComment(validWaiverBody()),
        { body: stickyBody({ verdict: "UNAVAILABLE" }), id: "S1" },
        { body: stickyBody({ verdict: "PASS" }), id: "S2" },
      ],
    });
    assert.equal(snap.hasFreshWaiver, false);
  });
});

describe("carrier wiring", () => {
  it("pre-tool-gate and post-pr-completion import waiver authority; no waiver write guard remains", () => {
    const pre = readFileSync(path.join(HERE, "../hooks/pre-tool-gate.mjs"), "utf8");
    const post = readFileSync(path.join(HERE, "../hooks/post-pr-completion-check.mjs"), "utf8");
    assert.match(pre, /evaluateCrossModelWaiverPathW/);
    assert.doesNotMatch(pre, /checkCrossModelWaiverCommentWriteGuard/);
    assert.match(pre, /Path W/);
    assert.match(pre, /MUST NOT override/);
    assert.match(post, /hasFreshWaiver/);
    assert.match(post, /stickyAllowsCrossModelWaiverPathW/);
    assert.match(post, /evaluateCrossModelWaiverPathW/);
    assert.match(post, /stickyVerdictForPathW/);
    assert.match(post, /__testSnapshotFromGhData/);
  });
});
