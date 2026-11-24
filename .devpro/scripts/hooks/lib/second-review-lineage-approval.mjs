import { createHash } from "node:crypto";
import { reviewGithubSpawnSync as spawnSync } from "../../lib/second-review-github-transport.mjs";
import { LINEAGE_APPROVAL_MAX_AGE_MS, LINEAGE_APPROVAL_RECEIPT_SCHEMA } from "./second-review-control-evidence.mjs";

export const LINEAGE_APPROVAL_MARKER = "<!-- devpro-post-pr-lineage-approval -->";
export { LINEAGE_APPROVAL_RECEIPT_SCHEMA };

const APPROVAL_FIELDS = Object.freeze([
  "action",
  "source_state",
  "pr",
  "old_head",
  "new_head",
  "old_dispatch_id",
  "granted_by",
  "reason",
]);
const ALLOWED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const ALLOWED_PERMISSIONS = new Set(["write", "maintain", "admin"]);
const SHA40 = /^[a-f0-9]{40}$/i;
const DISPATCH_ID = /^dispatch-[0-9a-f-]{36}$/i;

function fail(message) {
  const error = new Error(`lineage-approval-invalid: ${message}`);
  error.classification = "lineage_approval_invalid";
  throw error;
}

function parseApprovalBody(body) {
  if (typeof body !== "string") return null;
  const normalizedBody = body.replace(/\r\n/g, "\n");
  if (!normalizedBody.startsWith(`${LINEAGE_APPROVAL_MARKER}\n`)) return null;
  const lines = normalizedBody.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== APPROVAL_FIELDS.length + 1 || lines[0] !== LINEAGE_APPROVAL_MARKER) return null;
  const result = {};
  for (let index = 0; index < APPROVAL_FIELDS.length; index += 1) {
    const field = APPROVAL_FIELDS[index];
    const prefix = `${field}: `;
    const line = lines[index + 1];
    if (!line.startsWith(prefix) || Object.hasOwn(result, field)) return null;
    result[field] = line.slice(prefix.length);
  }
  if (result.action !== "rebind" && result.action !== "clear") return null;
  if (result.source_state !== "dispatch-marker" && result.source_state !== "clear-obligation") return null;
  if (!/^[1-9][0-9]*$/.test(result.pr)
    || !SHA40.test(result.old_head)
    || !SHA40.test(result.new_head)
    || !DISPATCH_ID.test(result.old_dispatch_id)
    || !/^[A-Za-z0-9-]{1,39}$/.test(result.granted_by)
    || Buffer.byteLength(result.reason, "utf8") === 0
    || Buffer.byteLength(result.reason, "utf8") > 500) return null;
  return result;
}

function parseJson(value, label) {
  try { return JSON.parse(value); } catch { fail(`${label} response is not complete JSON`); }
}

function runGh(args, { cwd, env, spawnSyncImpl }) {
  const result = spawnSyncImpl("gh", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0 || result.signal) {
    fail(`GitHub evidence query failed for ${args[1] ?? args[0]}`);
  }
  return String(result.stdout ?? "");
}

function flattenPaginatedCommentResponse(raw) {
  const parsed = parseJson(raw, "issue-comment snapshot");
  // gh api --paginate --slurp returns an array of page arrays. A direct array is
  // accepted for test/provider surfaces that already materialize one full page.
  const pages = Array.isArray(parsed) && parsed.every(Array.isArray) ? parsed : [parsed];
  if (pages.length === 0 || pages.some((page) => !Array.isArray(page))) fail("issue-comment pagination is incomplete");
  return pages.flat();
}

function requireCompleteIssueComments({ repositorySlug, prNumber, cwd, env, spawnSyncImpl }) {
  const raw = runGh(["api", `repos/${repositorySlug}/issues/${prNumber}/comments`, "--paginate", "--slurp"], {
    cwd, env, spawnSyncImpl,
  });
  return flattenPaginatedCommentResponse(raw);
}

function requirePermission({ repositorySlug, login, cwd, env, spawnSyncImpl }) {
  const raw = runGh(["api", `repos/${repositorySlug}/collaborators/${login}/permission`], {
    cwd, env, spawnSyncImpl,
  });
  const response = parseJson(raw, "repository-permission");
  const permission = response?.permission;
  if (!ALLOWED_PERMISSIONS.has(permission)) fail("approver lacks current repository write permission");
  return permission;
}

function requireUneditedComment({ comment, cwd, env, spawnSyncImpl }) {
  if (typeof comment.node_id !== "string" || comment.node_id === "") fail("approval comment node id is missing");
  const query = "query($id: ID!) { node(id: $id) { ... on IssueComment { lastEditedAt userContentEdits(first: 100) { pageInfo { hasNextPage } nodes { id } } } } }";
  const raw = runGh(["api", "graphql", "-f", `query=${query}`, "-F", `id=${comment.node_id}`], {
    cwd, env, spawnSyncImpl,
  });
  const response = parseJson(raw, "approval-edit-metadata");
  const node = response?.data?.node;
  if (!node || !Object.hasOwn(node, "lastEditedAt") || node.lastEditedAt !== null
    || !Array.isArray(node.userContentEdits?.nodes)
    || node.userContentEdits.nodes.length !== 0
    || node.userContentEdits.pageInfo?.hasNextPage !== false) {
    fail("approval comment is edited or edit history is incomplete");
  }
  return { last_edited_at: node.lastEditedAt, user_content_edits_count: 0 };
}

// An approval older than the retention window is neither a candidate nor counted as a duplicate:
// the dispatch that consumed it may already have been reclaimed, so its age is what keeps it from
// being used again. An unreadable timestamp stays in the list so the later checks fail closed.
function approvalExpired(comment, now) {
  const createdAt = Date.parse(comment?.created_at);
  return Number.isFinite(createdAt) && now - createdAt > LINEAGE_APPROVAL_MAX_AGE_MS;
}

/** Resolve exactly one complete, current, unedited, repository-authorized approval. */
export function resolveSecondReviewLineageApproval({
  repositorySlug,
  prNumber,
  sourceState,
  oldHead,
  newHead,
  oldDispatchId,
  action,
  consumedCommentIds = [],
  now = Date.now(),
  cwd = process.cwd(),
  env = process.env,
  spawnSyncImpl = spawnSync,
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repositorySlug ?? ""))
    || !/^[1-9][0-9]*$/.test(String(prNumber ?? ""))) fail("repository or PR identity is invalid");
  const comments = requireCompleteIssueComments({ repositorySlug, prNumber, cwd, env, spawnSyncImpl });
  const consumed = new Set(consumedCommentIds);
  const approvals = comments.filter((comment) => !consumed.has(String(comment?.id ?? ""))
    && !approvalExpired(comment, now)
    && typeof comment?.body === "string"
    && comment.body.includes(LINEAGE_APPROVAL_MARKER));
  const candidates = approvals.map((comment) => ({ comment, fields: parseApprovalBody(comment.body) }))
    .filter(({ fields }) => fields !== null);
  const exact = candidates.filter(({ fields }) => (Array.isArray(action) ? action.includes(fields.action) : fields.action === action)
    && fields.source_state === sourceState
    && fields.pr === String(prNumber)
    && fields.old_head.toLowerCase() === String(oldHead).toLowerCase()
    && fields.new_head.toLowerCase() === String(newHead).toLowerCase()
    && fields.old_dispatch_id === oldDispatchId);
  if (exact.length !== 1 || approvals.length !== 1) fail("approval is missing, duplicated, conflicting, or does not match this lineage");
  const { comment, fields } = exact[0];
  const author = comment?.user?.login;
  if (!Number.isSafeInteger(comment?.id) || comment.id <= 0
    || comment.html_url !== `https://github.com/${repositorySlug}/pull/${prNumber}#issuecomment-${comment.id}`
    || typeof author !== "string"
    || author !== fields.granted_by
    || !ALLOWED_ASSOCIATIONS.has(comment.author_association)
    || typeof comment.created_at !== "string"
    || typeof comment.updated_at !== "string"
    || comment.created_at !== comment.updated_at) {
    fail("approval source, author, association, or timestamps are invalid");
  }
  const permission = requirePermission({ repositorySlug, login: author, cwd, env, spawnSyncImpl });
  const editMetadata = requireUneditedComment({ comment, cwd, env, spawnSyncImpl });
  const receipt = {
    schema: LINEAGE_APPROVAL_RECEIPT_SCHEMA,
    repository_slug: repositorySlug,
    pr_number: String(prNumber),
    source_state: fields.source_state,
    old_head_ref_oid: fields.old_head.toLowerCase(),
    new_head_ref_oid: fields.new_head.toLowerCase(),
    old_dispatch_id: fields.old_dispatch_id,
    action: fields.action,
    approval_comment_id: String(comment.id),
    approval_comment_url: comment.html_url,
    approver_login: author,
    author_association: comment.author_association,
    repository_permission: permission,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    ...editMetadata,
    comment_body_sha256: createHash("sha256").update(comment.body, "utf8").digest("hex"),
  };
  return { comments, comment, fields, receipt };
}
