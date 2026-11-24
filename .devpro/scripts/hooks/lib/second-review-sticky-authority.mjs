import { sha256Hex as sha256, isPlainObject, isRepositorySlug } from "../../lib/primitives.mjs";

export const SECOND_REVIEW_STICKY_MARKER = "<!-- cross-model-second-opinion:sticky -->";
export const SECOND_REVIEW_STICKY_WRITE_DISPOSITION_SCHEMA =
  "devpro-second-review-sticky-write-disposition/v1";

// Test-only provenance used by hook mock snapshots. Keep runtime-specific
// identity in this library rather than leaking it into host-neutral entrypoints.
export const SECOND_REVIEW_STICKY_MOCK_PROVENANCE =
  "Rules: v1.0.0 · Tool: Claude Code · Model: claude-test";

const STICKY_VERDICTS = new Set(["PASS", "WARN", "CRITICAL", "UNAVAILABLE"]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function blockedDisposition(common, classification, reason) {
  return {
    ...common,
    action: "blocked",
    classification,
    reason: String(reason).slice(0, 512),
  };
}

export function normalizeSecondReviewStickyCandidate(comment, repositorySlug, prNumber) {
  if (!isPlainObject(comment) || typeof comment.body !== "string") {
    return { error: "sticky_candidate_shape_invalid" };
  }
  const url = typeof comment.html_url === "string" ? comment.html_url : comment.url;
  const match = typeof url === "string"
    ? url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)#issuecomment-([1-9][0-9]*)$/)
    : null;
  if (match === null) return { error: "sticky_candidate_url_invalid" };
  if (match[1] !== repositorySlug) return { error: "sticky_candidate_repository_mismatch" };
  if (Number(match[2]) !== prNumber) return { error: "sticky_candidate_pr_mismatch" };

  const urlId = Number(match[3]);
  const isRest = Number.isSafeInteger(comment.id) && comment.id > 0;
  const nodeId = isRest ? comment.node_id : comment.id;
  const updatedAt = isRest ? comment.updated_at : comment.updatedAt;
  if (isRest && comment.id !== urlId) return { error: "sticky_candidate_id_mismatch" };
  if (typeof nodeId !== "string" || nodeId.trim() === "") {
    return { error: "sticky_candidate_node_id_invalid" };
  }
  if (isRest && comment.graphql_id !== undefined && comment.graphql_id !== nodeId) {
    return { error: "sticky_candidate_node_id_mismatch" };
  }
  if (typeof updatedAt !== "string" || updatedAt.trim() === "") {
    return { error: "sticky_candidate_freshness_invalid" };
  }
  return {
    target: {
      id: urlId,
      url,
      node_id: nodeId,
      body_sha256: sha256(comment.body),
      updated_at: updatedAt,
    },
  };
}

function canonicalSnapshotDigestInput(snapshotObject) {
  const repositorySlug = snapshotObject.repository_slug;
  const prNumber = snapshotObject.pr_number;
  const comments = Array.isArray(snapshotObject.comments)
    ? snapshotObject.comments.map((comment) => {
        const normalized = normalizeSecondReviewStickyCandidate(
          comment,
          repositorySlug,
          prNumber
        );
        if (normalized.target) return normalized.target;
        if (!isPlainObject(comment)) {
          return { invalid_shape: typeof comment };
        }
        return {
          normalization_error: normalized.error,
          body_sha256: typeof comment.body === "string" ? sha256(comment.body) : null,
          id: Number.isSafeInteger(comment.id) ? comment.id : null,
          node_id: typeof comment.node_id === "string"
            ? comment.node_id
            : typeof comment.id === "string"
              ? comment.id
              : null,
          updated_at: typeof comment.updated_at === "string"
            ? comment.updated_at
            : typeof comment.updatedAt === "string"
              ? comment.updatedAt
              : null,
          url: typeof comment.html_url === "string"
            ? comment.html_url
            : typeof comment.url === "string"
              ? comment.url
              : null,
        };
      }).sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
    : snapshotObject.comments;
  const completeness = isPlainObject(snapshotObject.completeness)
    ? {
        status: snapshotObject.completeness.status ?? null,
        pagination_exhausted: snapshotObject.completeness.pagination_exhausted ?? null,
      }
    : snapshotObject.completeness;
  return {
    repository_slug: repositorySlug,
    pr_number: prNumber,
    completeness,
    query_error: snapshotObject.query_error ?? null,
    comments,
  };
}

function dispositionsMatch(actual, expected) {
  if (!isPlainObject(expected)) return false;
  const commonFields = [
    "schema",
    "repository_slug",
    "pr_number",
    "marker",
    "candidate_count",
    "snapshot_digest",
    "action",
  ];
  if (commonFields.some((field) => actual[field] !== expected[field])) return false;
  if (actual.action !== "update") return true;
  return stableJson(actual.target) === stableJson(expected.target);
}

export function resolveSecondReviewStickyWriteDisposition(snapshot, {
  expectedDisposition = null,
} = {}) {
  const snapshotObject = isPlainObject(snapshot) ? snapshot : {};
  const repositorySlug = snapshotObject.repository_slug;
  const prNumber = snapshotObject.pr_number;
  const comments = Array.isArray(snapshotObject.comments) ? snapshotObject.comments : [];
  const candidates = comments.filter((comment) => (
    isPlainObject(comment)
    && typeof comment.body === "string"
    && comment.body.includes(SECOND_REVIEW_STICKY_MARKER)
  ));
  const common = {
    schema: SECOND_REVIEW_STICKY_WRITE_DISPOSITION_SCHEMA,
    repository_slug: repositorySlug,
    pr_number: prNumber,
    marker: SECOND_REVIEW_STICKY_MARKER,
    candidate_count: candidates.length,
    snapshot_digest: sha256(stableJson(canonicalSnapshotDigestInput(snapshotObject))),
  };

  if (!isPlainObject(snapshot)) {
    return blockedDisposition(common, "sticky_snapshot_shape_invalid", "Sticky authority snapshot must be an object.");
  }
  if (!isRepositorySlug(repositorySlug)) {
    return blockedDisposition(common, "sticky_snapshot_repository_invalid", "Sticky authority snapshot repository is invalid.");
  }
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    return blockedDisposition(common, "sticky_snapshot_pr_invalid", "Sticky authority snapshot PR number is invalid.");
  }
  const completeness = snapshot.completeness;
  if (!isPlainObject(completeness)
    || completeness.status !== "complete"
    || completeness.pagination_exhausted !== true
    || !Number.isSafeInteger(completeness.pages_fetched)
    || completeness.pages_fetched < 1
    || snapshot.query_error !== null) {
    return blockedDisposition(common, "sticky_snapshot_incomplete", "Sticky authority query must be complete, successful, and pagination-exhausted.");
  }
  if (!Array.isArray(snapshot.comments)) {
    return blockedDisposition(common, "sticky_snapshot_comments_invalid", "Sticky authority snapshot comments must be an array.");
  }
  // Marker presence is UNDECIDABLE for an element that is not a plain object carrying a
  // verbatim string `body`: a summarized or derived field cannot prove the marker is absent.
  // The candidate filter above drops such an element silently, which makes "the handoff
  // snapshot is lossy" indistinguishable from "this PR really has no sticky". Both arms are
  // unsafe, so the check is deliberately whole-array rather than zero-candidate-only: with no
  // remaining candidate the caller would emit an executable `create` and add a SECOND canonical
  // marker; with exactly one remaining candidate it would emit `update` bound to the only
  // comment it can see, while the dropped element may itself be that second canonical sticky —
  // the state `sticky_authority_ambiguous` exists further down to refuse. Completeness is
  // therefore an element-level property, not only the pagination-level one proven above.
  if (!snapshot.comments.every((comment) => isPlainObject(comment) && typeof comment.body === "string")) {
    return blockedDisposition(common, "sticky_snapshot_comments_invalid", "Sticky authority snapshot comments must each be an object carrying a verbatim string body.");
  }
  if (!snapshot.comments.every((comment) => {
    const url = typeof comment.html_url === "string" ? comment.html_url : comment.url;
    const isRest = Number.isSafeInteger(comment.id) && comment.id > 0;
    const nodeId = isRest ? comment.node_id : comment.id;
    const updatedAt = isRest ? comment.updated_at : comment.updatedAt;
    return typeof url === "string"
      && url.trim() !== ""
      && (isRest || typeof comment.id === "string")
      && typeof nodeId === "string"
      && nodeId.trim() !== ""
      && typeof updatedAt === "string"
      && updatedAt.trim() !== "";
  })) {
    return blockedDisposition(
      common,
      "sticky_snapshot_comments_invalid",
      "Sticky authority snapshot comments must each carry body plus html_url/url, id, node_id, and updated_at identity fields."
    );
  }

  let disposition;
  if (candidates.length === 0) {
    disposition = { ...common, action: "create" };
  } else if (candidates.length > 1) {
    disposition = blockedDisposition(
      common,
      "sticky_authority_ambiguous",
      "More than one sticky authority candidate exists; no write action is safe."
    );
  } else {
    const normalized = normalizeSecondReviewStickyCandidate(
      candidates[0],
      repositorySlug,
      prNumber
    );
    if (normalized.error) {
      disposition = blockedDisposition(
        common,
        normalized.error,
        "The exact sticky authority target identity is malformed or outside the requested repository and PR."
      );
    } else {
      disposition = { ...common, action: "update", target: normalized.target };
    }
  }

  if (expectedDisposition !== null && !dispositionsMatch(disposition, expectedDisposition)) {
    return blockedDisposition(
      common,
      "sticky_write_disposition_drift",
      "Live sticky authority no longer matches the renderer-owned write disposition."
    );
  }
  return disposition;
}

// D3 SSOT: every host-runtime provenance footer token this parser (and therefore the
// merge gate, which calls it) accepts. Closed, frozen set — a token outside this list
// hard-blocks parsing rather than silently degrading. Runner-dispatched families
// (`claude`, `codex`, `openai-codex`) use the first two tokens; `Gemini CLI` is
// external-evaluator-only (D2) but shares this same footer-shape SSOT.
export const STICKY_PROVENANCE_TOOL_TOKENS = Object.freeze([
  "Claude Code",
  "Codex",
  "Gemini CLI",
  "OpenCode",
  "Cursor",
  "Copilot CLI",
]);

// The sticky body reserves these literals outside the machine-field lines. The
// reason-value guard and the duplicate-token counts below share this one list.
export const STICKY_RESERVED_REASON_LITERALS = Object.freeze(["Rules:", "Tool:", "Model:"]);

/**
 * The same-family `<why>` is injected into the sticky reason line, where the
 * canonical body contract reserves the marker and the footer tokens. Shared by
 * the builder, the renderer/accept gates and this parser so the layers cannot
 * drift.
 * @returns {string|null} the reserved literal kind, or null when the value is safe
 */
export function reservedStickyReasonLiteral(value) {
  if (typeof value !== "string") return null;
  if (/[\r\n]/u.test(value)) return "newline";
  if (value.includes(SECOND_REVIEW_STICKY_MARKER)) return "sticky marker";
  for (const token of STICKY_RESERVED_REASON_LITERALS) {
    if (value.includes(token)) return token;
  }
  return null;
}

// D3: cooperative (reviewer-supplied), not gate-enforced by this parser itself — the
// merge gate keeps validating `Model:` shape-only. Consumed by D4's TL accept helper to
// cross-check the sticky footer model identity against the dispatched reviewer_family.
export const MODEL_FAMILY_PATTERNS = Object.freeze({
  claude: /^claude/i,
  codex: /^(?:gpt|o[1-9]|codex)/i,
  "openai-codex": /^(?:gpt|o[1-9]|codex)/i,
  gemini: /^gemini/i,
  deepseek: /^deepseek/i,
});

function escapeRegExpLiteral(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STICKY_PROVENANCE_FOOTER_RE = new RegExp(
  "^Rules: v([0-9]+\\.[0-9]+\\.[0-9]+) · Tool: ("
    + STICKY_PROVENANCE_TOOL_TOKENS.map(escapeRegExpLiteral).join("|")
    + ") · Model: (\\S(?:.*\\S)?)$"
);

function countLiteral(text, literal) {
  if (literal === "") return 0;
  return text.split(literal).length - 1;
}

export function rewriteStickyProvenanceModel(body, streamIdentity) {
  const text = typeof body === "string" ? body : "";
  const trailing = text.match(/\r?\n$/)?.[0] ?? "";
  const content = trailing ? text.slice(0, -trailing.length) : text;
  const lines = content.split(/\r?\n/);
  const provenance = (lines.at(-1) ?? "").match(STICKY_PROVENANCE_FOOTER_RE);
  if (provenance === null) return text;
  lines[lines.length - 1] =
    `Rules: v${provenance[1]} · Tool: ${provenance[2]} · Model: ${streamIdentity}`;
  return `${lines.join("\n")}${trailing}`;
}

function exactMachineLines(lines, fieldName) {
  const prefix = `${fieldName}:`;
  return lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith(prefix));
}

function pushDuplicateOrInvalid(errors, occurrences, {
  duplicateError,
  invalidError,
  value,
}) {
  if (occurrences.length > 1) {
    errors.push(duplicateError);
  } else if (value === null) {
    errors.push(invalidError);
  }
}

/**
 * Parse the complete sticky authority body as one fail-closed contract.
 *
 * The marker, four machine fields, and three provenance carriers are reserved
 * authority tokens. Each must occur exactly once. Their canonical order is:
 * marker -> verdict -> last_reviewed_sha -> dispatch_id -> reason -> footer,
 * and the Rules/Tool/Model footer must be the final physical content line.
 *
 * `tracked_follow_up` (R6/D7) is NOT a reserved authority token: it is an
 * OPTIONAL single bare-line field (same `field:\s+text` shape as the
 * reserved fields) that MAY appear after `reason:` and before the footer.
 * Its absence is always `valid` — R-7 backward compatibility requires that a
 * sticky written before this field existed, or one that simply has nothing
 * to track, keeps parsing successfully.
 */
export function parseSecondReviewStickyAuthorityBody(body, {
  expectedRulesVersion = null,
  expectedReviewerTool = null,
  isReviewerModelInvalid = null,
} = {}) {
  const text = typeof body === "string" ? body : "";
  const content = text.replace(/\r?\n$/, "");
  const lines = content.split(/\r?\n/);
  const contractErrors = [];

  const markerCount = countLiteral(text, SECOND_REVIEW_STICKY_MARKER);
  const markerIndex = lines.findIndex((line) => line === SECOND_REVIEW_STICKY_MARKER);
  if (markerCount > 1) {
    contractErrors.push("sticky_marker_duplicate");
  } else if (markerCount === 0) {
    contractErrors.push("sticky_marker_missing");
  }
  if (markerIndex !== 0) contractErrors.push("sticky_marker_not_first_line");

  const verdictLines = exactMachineLines(lines, "verdict");
  const lastReviewedShaLines = exactMachineLines(lines, "last_reviewed_sha");
  const dispatchIdLines = exactMachineLines(lines, "dispatch_id");
  const reasonLines = exactMachineLines(lines, "reason");
  // R6/D7: optional, NOT a reserved authority token like the four above — its
  // absence is always `valid` (R-7 backward compatibility). Markdown
  // emphasis/code-span/bullet formatting around it still parse-fails when the
  // line is present, matching the bare-line schema every other machine field
  // uses.
  const trackedFollowUpLines = exactMachineLines(lines, "tracked_follow_up");

  const verdict = verdictLines.length === 1
    ? verdictLines[0].line.match(/^verdict:\s+(PASS|WARN|CRITICAL|UNAVAILABLE)\s*$/)?.[1] ?? null
    : null;
  const lastReviewedSha = lastReviewedShaLines.length === 1
    ? lastReviewedShaLines[0].line.match(/^last_reviewed_sha:\s+([a-f0-9]{7,40})\s*$/)?.[1] ?? null
    : null;
  const dispatchId = dispatchIdLines.length === 1
    ? dispatchIdLines[0].line.match(/^dispatch_id:\s+([\x21-\x7e]{1,128})\s*$/)?.[1] ?? null
    : null;
  const reason = reasonLines.length === 1
    ? reasonLines[0].line.match(/^reason:\s+(\S(?:.*\S)?)\s*$/)?.[1] ?? null
    : null;
  const trackedFollowUp = trackedFollowUpLines.length === 1
    ? trackedFollowUpLines[0].line.match(/^tracked_follow_up:\s+(\S(?:.*\S)?)\s*$/)?.[1] ?? null
    : null;

  pushDuplicateOrInvalid(contractErrors, verdictLines, {
    duplicateError: "sticky_verdict_duplicate",
    invalidError: "sticky_verdict_invalid",
    value: verdict,
  });
  pushDuplicateOrInvalid(contractErrors, lastReviewedShaLines, {
    duplicateError: "sticky_last_reviewed_sha_duplicate",
    invalidError: "sticky_last_reviewed_sha_missing",
    value: lastReviewedSha,
  });
  pushDuplicateOrInvalid(contractErrors, dispatchIdLines, {
    duplicateError: "sticky_dispatch_id_duplicate",
    invalidError: dispatchIdLines.length === 0
      ? "sticky_dispatch_id_missing"
      : "sticky_dispatch_id_invalid",
    value: dispatchId,
  });
  pushDuplicateOrInvalid(contractErrors, reasonLines, {
    duplicateError: "sticky_reason_duplicate",
    invalidError: "sticky_reason_missing",
    value: reason,
  });
  // Optional field: unlike the four reserved tokens above, ABSENCE (0
  // occurrences) is valid, not an error. Only a present-but-malformed or
  // duplicated line fails closed.
  if (trackedFollowUpLines.length > 1) {
    contractErrors.push("sticky_tracked_follow_up_duplicate");
  } else if (trackedFollowUpLines.length === 1 && trackedFollowUp === null) {
    contractErrors.push("sticky_tracked_follow_up_invalid");
  }

  const [rulesCount, toolCount, modelCount] = STICKY_RESERVED_REASON_LITERALS.map((token) => countLiteral(text, token));
  for (const token of STICKY_RESERVED_REASON_LITERALS) {
    if (countLiteral(text, token) > 1) {
      contractErrors.push(`sticky_${token.slice(0, -1).toLowerCase()}_duplicate`);
    }
  }

  const provenanceLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith("Rules:"));
  if (provenanceLines.length > 1) {
    contractErrors.push("sticky_provenance_footer_duplicate");
  }
  const finalLine = lines.at(-1) ?? "";
  const provenance = provenanceLines.length === 1
    && provenanceLines[0].index === lines.length - 1
    ? finalLine.match(STICKY_PROVENANCE_FOOTER_RE)
    : null;
  if (rulesCount !== 1 || toolCount !== 1 || modelCount !== 1 || provenance === null) {
    contractErrors.push("sticky_provenance_footer_missing_or_invalid");
  }

  const rulesVersion = provenance?.[1] ?? null;
  const reviewerTool = provenance?.[2] ?? null;
  const reviewerModel = provenance?.[3] ?? null;
  if (provenance !== null) {
    if (expectedRulesVersion !== null && rulesVersion !== expectedRulesVersion) {
      contractErrors.push("sticky_rules_version_mismatch");
    }
    if (expectedReviewerTool !== null && reviewerTool !== expectedReviewerTool) {
      contractErrors.push("sticky_reviewer_tool_mismatch");
    }
    if (typeof isReviewerModelInvalid === "function" && isReviewerModelInvalid(reviewerModel)) {
      contractErrors.push("sticky_reviewer_model_invalid");
    }
  }

  const orderedIndexes = [
    markerIndex,
    verdictLines.length === 1 ? verdictLines[0].index : -1,
    lastReviewedShaLines.length === 1 ? lastReviewedShaLines[0].index : -1,
    dispatchIdLines.length === 1 ? dispatchIdLines[0].index : -1,
    reasonLines.length === 1 ? reasonLines[0].index : -1,
    provenanceLines.length === 1 ? provenanceLines[0].index : -1,
  ];
  if (
    orderedIndexes.every((index) => index >= 0)
    && orderedIndexes.some((index, position) => position > 0 && index <= orderedIndexes[position - 1])
  ) {
    contractErrors.push("sticky_authority_field_order_invalid");
  }

  return {
    status: contractErrors.length === 0 ? "valid" : "invalid",
    verdict: verdict !== null && STICKY_VERDICTS.has(verdict) ? verdict : null,
    last_reviewed_sha: lastReviewedSha,
    dispatch_id: dispatchId,
    reason,
    tracked_follow_up: trackedFollowUp,
    rules_version: rulesVersion,
    reviewer_tool: reviewerTool,
    reviewer_model: reviewerModel,
    contract_errors: [...new Set(contractErrors)],
  };
}

export function selectExactSecondReviewStickyAuthority(comments) {
  const candidates = (Array.isArray(comments) ? comments : []).filter((comment) => (
    comment !== null
    && typeof comment === "object"
    && !Array.isArray(comment)
    && typeof comment.body === "string"
    && comment.body.includes(SECOND_REVIEW_STICKY_MARKER)
  ));

  if (candidates.length === 0) {
    return {
      status: "missing",
      authority: null,
      candidate_count: 0,
    };
  }
  if (candidates.length !== 1) {
    return {
      status: "ambiguous",
      authority: null,
      candidate_count: candidates.length,
    };
  }
  return {
    status: "selected",
    authority: candidates[0],
    candidate_count: 1,
  };
}

// The prior REVIEWED baseline of a PR: exactly one exact-update sticky whose body
// is a well-formed READY verdict (PASS or WARN) carrying a parseable
// `last_reviewed_sha`. The renderer (review-scope minimality gate) and the
// handoff builder (scope selection) both read it from the same complete
// issue-comments snapshot through this one function, so they cannot disagree
// about whether a baseline exists. Returns the parsed sticky, or null.
export function resolveReadyStickyBaseline(snapshot) {
  const disposition = resolveSecondReviewStickyWriteDisposition(snapshot);
  if (disposition.action !== "update") return null;
  const candidates = Array.isArray(snapshot?.comments)
    ? snapshot.comments.filter((comment) => (
      comment !== null
      && typeof comment === "object"
      && typeof comment.body === "string"
      && comment.body.includes(SECOND_REVIEW_STICKY_MARKER)
    ))
    : [];
  if (candidates.length !== 1) return null;
  const parsed = parseSecondReviewStickyAuthorityBody(candidates[0].body);
  if (parsed.status !== "valid") return null;
  if (parsed.verdict !== "PASS" && parsed.verdict !== "WARN") return null;
  if (typeof parsed.last_reviewed_sha !== "string" || parsed.last_reviewed_sha === "") return null;
  return parsed;
}
