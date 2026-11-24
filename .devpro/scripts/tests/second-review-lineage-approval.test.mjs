import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  LINEAGE_APPROVAL_MARKER,
  LINEAGE_APPROVAL_RECEIPT_SCHEMA,
  resolveSecondReviewLineageApproval,
} from "../hooks/lib/second-review-lineage-approval.mjs";
import {
  LINEAGE_APPROVAL_MAX_AGE_MS,
  LINEAGE_APPROVAL_RECEIPT_SCHEMA as CONTROL_EVIDENCE_RECEIPT_SCHEMA,
} from "../hooks/lib/second-review-control-evidence.mjs";

// Fixtures carry a fixed comment time, so the resolver gets a fixed clock instead of the real one;
// otherwise these tests would start failing once the real date passes the approval age limit.
const FIXTURE_NOW = Date.parse("2026-09-29T00:00:00Z");
const repositorySlug = "devpro/example";
const prNumber = "123";
const oldHead = "a".repeat(40);
const newHead = "b".repeat(40);
const oldDispatchId = "dispatch-049ba0e0-c723-4b7b-a83c-9df0d9a0b990";
const approvedFields = {
  action: "rebind",
  source_state: "dispatch-marker",
  pr: prNumber,
  old_head: oldHead,
  new_head: newHead,
  old_dispatch_id: oldDispatchId,
  granted_by: "repo-owner",
  reason: "Rebind the marker after the approved PR #2879 rebase.",
};

function approvalBody(fields = approvedFields) {
  return [LINEAGE_APPROVAL_MARKER, ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`)].join("\n");
}

function comment(id, body, extra = {}) {
  return {
    id,
    node_id: `IC_kwDOExample${id}`,
    html_url: `https://github.com/${repositorySlug}/pull/${prNumber}#issuecomment-${id}`,
    body,
    created_at: "2026-09-28T00:20:00Z",
    updated_at: "2026-09-28T00:20:00Z",
    author_association: "OWNER",
    user: { login: "repo-owner" },
    ...extra,
  };
}

const approvedComment = comment(9001, approvalBody());
const stickyComment = comment(4242, "<!-- cross-model-second-opinion:sticky -->\nverdict: WARN");
const cleanEditMetadata = {
  data: { node: { lastEditedAt: null, userContentEdits: { pageInfo: { hasNextPage: false }, nodes: [] } } },
};

function resolver({ comments = [stickyComment, approvedComment], permission = "write", editMetadata = cleanEditMetadata } = {}) {
  const calls = [];
  const spawnSyncImpl = (_command, args) => {
    calls.push(args);
    if (args[0] === "api" && args[1] === `repos/${repositorySlug}/issues/${prNumber}/comments`) {
      return { status: 0, stdout: JSON.stringify([comments]), stderr: "" };
    }
    if (args[0] === "api" && args[1] === `repos/${repositorySlug}/collaborators/repo-owner/permission`) {
      return { status: 0, stdout: JSON.stringify({ permission }), stderr: "" };
    }
    if (args[0] === "api" && args[1] === "graphql") {
      return { status: 0, stdout: JSON.stringify(editMetadata), stderr: "" };
    }
    return { status: 64, stdout: "", stderr: "unexpected command" };
  };
  return {
    calls,
    resolve: (now = FIXTURE_NOW) => resolveSecondReviewLineageApproval({
      repositorySlug, prNumber, sourceState: "dispatch-marker", oldHead, newHead, oldDispatchId, action: "rebind",
      now, cwd: "/tmp/approval-fixture", env: {}, spawnSyncImpl,
    }),
  };
}

test("lineage approval requires one exact complete comment and records fixed audit identity", () => {
  assert.equal(LINEAGE_APPROVAL_RECEIPT_SCHEMA, CONTROL_EVIDENCE_RECEIPT_SCHEMA);
  const fixture = resolver();
  const resolved = fixture.resolve();
  assert.equal(resolved.receipt.schema, LINEAGE_APPROVAL_RECEIPT_SCHEMA);
  assert.equal(resolved.receipt.approval_comment_id, "9001");
  assert.equal(resolved.receipt.old_head_ref_oid, oldHead);
  assert.equal(resolved.receipt.new_head_ref_oid, newHead);
  assert.equal(resolved.receipt.old_dispatch_id, oldDispatchId);
  assert.equal(resolved.receipt.repository_permission, "write");
  assert.equal(resolved.receipt.comment_body_sha256.length, 64);
  assert.ok(fixture.calls[0].includes("--paginate") && fixture.calls[0].includes("--slurp"));
  assert.equal(fixture.calls.length, 3, "comment, live permission, and GraphQL edit state are separately queried");
});

test("lineage approval parses CRLF comments and hashes the original body bytes", () => {
  const rawBody = approvalBody().replace(/\n/g, "\r\n");
  const fixture = resolver({ comments: [stickyComment, comment(9005, rawBody)] });
  const resolved = fixture.resolve();
  assert.equal(resolved.receipt.approval_comment_id, "9005");
  assert.equal(
    resolved.receipt.comment_body_sha256,
    createHash("sha256").update(rawBody, "utf8").digest("hex"),
  );
});

test("lineage approval rejects missing, duplicate, conflicting, and extended body candidates", () => {
  for (const [label, comments] of [
    ["missing", [stickyComment]],
    ["duplicate", [stickyComment, approvedComment, comment(9002, approvalBody())]],
    ["conflicting action", [stickyComment, approvedComment, comment(9002, approvalBody({ ...approvedFields, action: "clear" }))]],
    ["extended body", [stickyComment, comment(9002, `${approvalBody()}\nrepository: devpro/example`)]],
  ]) {
    assert.throws(resolver({ comments }).resolve, /lineage-approval-invalid/u, label);
  }
});

test("lineage approval rejects author, permission, timestamp, and GraphQL edit uncertainty", () => {
  const unauthorizedComment = comment(9003, approvalBody(), { author_association: "CONTRIBUTOR" });
  assert.throws(resolver({ comments: [stickyComment, unauthorizedComment] }).resolve, /lineage-approval-invalid/u);
  assert.throws(resolver({ permission: "read" }).resolve, /lineage-approval-invalid/u);
  assert.throws(resolver({ comments: [stickyComment, comment(9004, approvalBody(), { updated_at: "2026-09-28T00:21:00Z" })] }).resolve, /lineage-approval-invalid/u);
  assert.throws(resolver({ editMetadata: {
    data: { node: { lastEditedAt: "2026-09-28T00:21:00Z", userContentEdits: { pageInfo: { hasNextPage: false }, nodes: [{ id: "edit-1" }] } } },
  } }).resolve, /lineage-approval-invalid/u);
  assert.throws(resolver({ editMetadata: {
    data: { node: { lastEditedAt: null, userContentEdits: { pageInfo: { hasNextPage: true }, nodes: [] } } },
  } }).resolve, /lineage-approval-invalid/u, "truncated edit history fails closed");
});

test("an approval older than the age limit is neither a candidate nor a duplicate", () => {
  const created = Date.parse("2026-09-28T00:20:00Z");
  const justInside = created + LINEAGE_APPROVAL_MAX_AGE_MS;
  const justOutside = created + LINEAGE_APPROVAL_MAX_AGE_MS + 1000;
  assert.equal(resolver().resolve(justInside).receipt.approval_comment_id, "9001", "the limit itself is still accepted");
  assert.throws(
    () => resolver().resolve(justOutside),
    /approval is missing/u,
    "an expired approval can no longer authorize a transition",
  );
  // Once the dispatch that consumed an old approval has been reclaimed, that comment is no longer
  // listed as consumed; its age keeps it from counting as a second candidate for a newer approval.
  const freshApproval = comment(9006, approvalBody(), {
    created_at: "2026-10-30T00:00:00Z",
    updated_at: "2026-10-30T00:00:00Z",
  });
  const resolved = resolver({ comments: [stickyComment, approvedComment, freshApproval] }).resolve(Date.parse("2026-10-30T01:00:00Z"));
  assert.equal(resolved.receipt.approval_comment_id, "9006");
});
