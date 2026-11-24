/**
 * Cross-model explicit user waiver authority (issue #2499).
 *
 * Canonical location: PR issue comment (not PR body).
 * Marker: <!-- devpro-cross-model-waiver --> (MUST be first physical line).
 * Exact-once bare fields: waived_head_sha / granted_by / reason.
 * Head binding: waived_head_sha MUST equal current headRefOid (full 40-hex; no Path D′).
 * Authorization: comment authorAssociation ∈ OWNER|MEMBER|COLLABORATOR.
 * Path W MUST NOT override sticky Path E (CRITICAL); only missing-sticky / UNAVAILABLE.
 *
 * Who posts: after the user says in the conversation to waive this PR's review,
 * the AI may post the comment through the user's own `gh` login, quoting the
 * user's words in `reason:`; the comment then carries the user's
 * authorAssociation. These checks guard against accidents (wrong head, wrong
 * PR, malformed fields), not deliberate forgery (design-core section 11).
 */

export const CROSS_MODEL_WAIVER_MARKER = "<!-- devpro-cross-model-waiver -->";

/**
 * GitHub CommentAuthorAssociation values accepted as Path W human authority.
 * This is the Path W allowlist, not a claim that MEMBER/COLLABORATOR always
 * imply repo write ACL on every GitHub plan.
 */
export const CROSS_MODEL_WAIVER_AUTHORIZED_ASSOCIATIONS = Object.freeze([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

// `gh` accepts the repository flag (and other options) between the command words, so a
// repo-qualified write (`gh -R o/r pr comment`, `gh pr -R o/r comment`) is the same comment
// write as `gh pr comment`. Every comment-write guard builds its command pattern from these
// sources so none of them keeps a stricter adjacency than the others.
const GH_COMMAND_OPTIONS = String.raw`(?:\s+(?:-R|--repo)\s+\S+|\s+-{1,2}[A-Za-z]\S*)*`;
export const GH_PR_ISSUE_COMMENT_COMMAND_SOURCE = String.raw`\bgh${GH_COMMAND_OPTIONS}\s+(?:pr|issue)${GH_COMMAND_OPTIONS}\s+comment\b`;
export const GH_PR_COMMENT_COMMAND_SOURCE = String.raw`\bgh${GH_COMMAND_OPTIONS}\s+pr${GH_COMMAND_OPTIONS}\s+comment\b`;

export function isGhPrIssueCommentCommand(text) {
  return new RegExp(GH_PR_ISSUE_COMMENT_COMMAND_SOURCE, "i").test(typeof text === "string" ? text : "");
}

function countLiteral(text, needle) {
  if (typeof text !== "string" || needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) return count;
    count += 1;
    from = idx + needle.length;
  }
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

/** First physical line equals the canonical waiver marker (same contract as parse). */
export function bodyStartsWithCrossModelWaiverMarker(body) {
  if (typeof body !== "string" || body.length === 0) return false;
  const firstLine = body.replace(/\r?\n$/, "").split(/\r?\n/, 1)[0];
  return firstLine === CROSS_MODEL_WAIVER_MARKER;
}

export function isAuthorizedCrossModelWaiverAssociation(authorAssociation) {
  return typeof authorAssociation === "string"
    && CROSS_MODEL_WAIVER_AUTHORIZED_ASSOCIATIONS.includes(authorAssociation.trim());
}

function commentAuthorLogin(comment) {
  const author = comment?.author;
  if (author !== null && typeof author === "object" && !Array.isArray(author)) {
    if (typeof author.login === "string" && author.login.trim()) return author.login.trim();
  }
  if (typeof comment?.author === "string" && comment.author.trim()) return comment.author.trim();
  return "";
}

function commentAuditFields(comment, parsed) {
  const association = typeof comment?.authorAssociation === "string"
    ? comment.authorAssociation.trim()
    : "";
  return {
    comment_id: comment?.id ?? null,
    comment_url: typeof comment?.url === "string" ? comment.url : "",
    author_login: commentAuthorLogin(comment),
    author_association: association,
    granted_by: parsed?.granted_by ?? null,
  };
}

/**
 * Parse a waiver authority body as one fail-closed contract.
 * Order: marker (first line) → waived_head_sha → granted_by → reason.
 */
export function parseCrossModelWaiverAuthorityBody(body) {
  const text = typeof body === "string" ? body : "";
  const content = text.replace(/\r?\n$/, "");
  const lines = content.split(/\r?\n/);
  const contractErrors = [];

  const markerCount = countLiteral(text, CROSS_MODEL_WAIVER_MARKER);
  const markerIndex = lines.findIndex((line) => line === CROSS_MODEL_WAIVER_MARKER);
  if (markerCount > 1) {
    contractErrors.push("waiver_marker_duplicate");
  } else if (markerCount === 0) {
    contractErrors.push("waiver_marker_missing");
  }
  if (markerIndex !== 0) contractErrors.push("waiver_marker_not_first_line");

  const shaLines = exactMachineLines(lines, "waived_head_sha");
  const grantedByLines = exactMachineLines(lines, "granted_by");
  const reasonLines = exactMachineLines(lines, "reason");

  // Full 40-char lowercase hex only — abbrev never equals headRefOid.
  const waivedHeadSha = shaLines.length === 1
    ? shaLines[0].line.match(/^waived_head_sha:\s+([a-f0-9]{40})\s*$/)?.[1] ?? null
    : null;
  const grantedBy = grantedByLines.length === 1
    ? grantedByLines[0].line.match(/^granted_by:\s+(\S(?:.*\S)?)\s*$/)?.[1] ?? null
    : null;
  const reason = reasonLines.length === 1
    ? reasonLines[0].line.match(/^reason:\s+(\S(?:.*\S)?)\s*$/)?.[1] ?? null
    : null;

  pushDuplicateOrInvalid(contractErrors, shaLines, {
    duplicateError: "waiver_waived_head_sha_duplicate",
    invalidError: shaLines.length === 0
      ? "waiver_waived_head_sha_missing"
      : "waiver_waived_head_sha_invalid",
    value: waivedHeadSha,
  });
  pushDuplicateOrInvalid(contractErrors, grantedByLines, {
    duplicateError: "waiver_granted_by_duplicate",
    invalidError: grantedByLines.length === 0
      ? "waiver_granted_by_missing"
      : "waiver_granted_by_invalid",
    value: grantedBy,
  });
  pushDuplicateOrInvalid(contractErrors, reasonLines, {
    duplicateError: "waiver_reason_duplicate",
    invalidError: reasonLines.length === 0
      ? "waiver_reason_missing"
      : "waiver_reason_invalid",
    value: reason,
  });

  const orderedIndexes = [
    markerIndex,
    shaLines.length === 1 ? shaLines[0].index : -1,
    grantedByLines.length === 1 ? grantedByLines[0].index : -1,
    reasonLines.length === 1 ? reasonLines[0].index : -1,
  ];
  if (
    orderedIndexes.every((index) => index >= 0)
    && orderedIndexes.some((index, position) => position > 0 && index <= orderedIndexes[position - 1])
  ) {
    contractErrors.push("waiver_authority_field_order_invalid");
  }

  return {
    status: contractErrors.length === 0 ? "valid" : "invalid",
    waived_head_sha: waivedHeadSha,
    granted_by: grantedBy,
    reason,
    contract_errors: [...new Set(contractErrors)],
  };
}

/**
 * Select exact-one waiver candidate. Marker MUST be the first physical line
 * (same as parse) — quoting the marker in prose MUST NOT become a candidate.
 */
export function selectExactCrossModelWaiverAuthority(comments) {
  const candidates = (Array.isArray(comments) ? comments : []).filter((comment) => (
    comment !== null
    && typeof comment === "object"
    && !Array.isArray(comment)
    && typeof comment.body === "string"
    && bodyStartsWithCrossModelWaiverMarker(comment.body)
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

/**
 * Whether sticky state allows Path W to clear merge / post-PR gates.
 * Path W MUST NOT override Path E (CRITICAL) or other sticky pass paths;
 * only missing sticky or UNAVAILABLE.
 *
 * @param {{ status: string, stickyVerdict?: string }} stickyContext
 */
export function stickyAllowsCrossModelWaiverPathW(stickyContext) {
  const status = stickyContext?.status;
  if (status === "missing") return true;
  if (status === "ambiguous") return false;
  if (status !== "selected") return false;
  const verdict = typeof stickyContext.stickyVerdict === "string"
    ? stickyContext.stickyVerdict.trim()
    : "";
  if (verdict === "CRITICAL") return false;
  return verdict === "UNAVAILABLE";
}

/**
 * Evaluate Path W: exact-one valid, authorized, head-bound waiver.
 * @returns {{ status: 'pass'|'missing'|'ambiguous'|'invalid'|'stale'|'unauthorized', ... }}
 */
export function evaluateCrossModelWaiverPathW(comments, headRefOid) {
  const selection = selectExactCrossModelWaiverAuthority(comments);
  if (selection.status === "missing") {
    return { status: "missing", candidate_count: 0 };
  }
  if (selection.status === "ambiguous") {
    return {
      status: "ambiguous",
      candidate_count: selection.candidate_count,
    };
  }

  const authority = selection.authority;
  const association = typeof authority.authorAssociation === "string"
    ? authority.authorAssociation.trim()
    : "";
  if (!isAuthorizedCrossModelWaiverAssociation(association)) {
    return {
      status: "unauthorized",
      candidate_count: 1,
      authority,
      audit: commentAuditFields(authority, null),
      reason: association
        ? `authorAssociation \`${association}\` is not OWNER|MEMBER|COLLABORATOR`
        : "authorAssociation missing (expected OWNER|MEMBER|COLLABORATOR)",
    };
  }

  const body = typeof authority.body === "string" ? authority.body : "";
  const parsed = parseCrossModelWaiverAuthorityBody(body);
  if (parsed.status !== "valid") {
    return {
      status: "invalid",
      candidate_count: 1,
      authority,
      parsed,
      audit: commentAuditFields(authority, parsed),
    };
  }

  const head = typeof headRefOid === "string" ? headRefOid.trim() : "";
  if (!head || parsed.waived_head_sha !== head) {
    return {
      status: "stale",
      candidate_count: 1,
      authority,
      parsed,
      waived_head_sha: parsed.waived_head_sha,
      headRefOid: head,
      audit: commentAuditFields(authority, parsed),
    };
  }

  return {
    status: "pass",
    candidate_count: 1,
    authority,
    parsed,
    audit: commentAuditFields(authority, parsed),
  };
}

/**
 * True when a bare `-F` / `--field` capture looks like gh key=value
 * (e.g. `body=@path`, `a=b`), not a filesystem path that merely contains `=`.
 */
function isGhFieldKeyValue(candidate) {
  const eq = candidate.indexOf("=");
  if (eq <= 0) return false;
  const key = candidate.slice(0, eq);
  return /^[A-Za-z_][\w.-]*$/.test(key);
}

/**
 * Stdin body-file residue only (`-`, optionally quote-wrapped). Do NOT treat
 * real hyphen-leading filenames (`-good.md`, `--input=-good.json`) as stdin.
 */
function isStdinBodyPathToken(candidate) {
  if (!candidate) return true;
  const unquoted = candidate.replace(/^["']|["']$/g, "");
  return unquoted === "-";
}

/**
 * Collect every body-bearing file path referenced by the command.
 * Scans ALL `--body-file`/`--body-path`/`--input` (space or `=`), bare
 * `-F/--field/--raw-field` body-file short forms (space, `=`, attached, and
 * combined bool shorthand like `-eF`), and `body=@…` field forms
 * (not only the first match). Stdin `-` is omitted (caller fail-closes).
 * Paths that contain `=` (e.g. `/tmp/a=bad.md`) are kept; `=` exclusion applies
 * only for `gh api` bare `-F`/`--field` key=value tokens — on `gh pr|issue
 * comment`, `-F` is always `--body-file` (including relative `a=bad.md`).
 */
export function extractCrossModelWaiverCommentBodyFilePaths(raw) {
  const cmd = typeof raw === "string" ? raw : "";
  const paths = [];
  const isPrIssueComment = isGhPrIssueCommentCommand(cmd);
  // Stdin `-` / attached `-F-` capture of `-` is omitted; caller fail-closes
  // when a body-file flag is present with no path. Hyphen-leading filenames
  // (`-good.md`) MUST still extract.
  const pushPath = (candidate) => {
    if (isStdinBodyPathToken(candidate)) return;
    paths.push(candidate);
  };
  // Bare `-F` / `--field` on `gh api` may capture key=value; skip those
  // (body=@ is separate). On pr/issue comment, `-F` is always a path.
  const pushBareFieldPath = (candidate) => {
    if (isStdinBodyPathToken(candidate)) return;
    if (!isPrIssueComment && isGhFieldKeyValue(candidate)) return;
    paths.push(candidate);
  };

  for (const match of cmd.matchAll(
    /(?:--body-file|--body-path)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/g
  )) {
    pushPath(match[1] || match[2] || match[3] || "");
  }

  // gh pr/issue comment: `-F` is short for `--body-file` (not key=value).
  // Accept: `-F path`, `-F=path`, `-Fpath`, and combined `-eF path` / `-eF=path` / `-eFpath`.
  // Skip key=value captures on gh api only; keep real paths that contain `=`.
  for (const match of cmd.matchAll(
    /(?:^|[\s"'])-[a-zA-Z]*F(?:=|\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))/g
  )) {
    pushBareFieldPath(match[1] || match[2] || match[3] || "");
  }

  for (const match of cmd.matchAll(
    /(?:^|[\s"'])(?:--field|--raw-field)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/g
  )) {
    pushBareFieldPath(match[1] || match[2] || match[3] || "");
  }

  for (const match of cmd.matchAll(/body=@(?:"([^"]+)"|'([^']+)'|(\S+))/g)) {
    pushPath(match[1] || match[2] || match[3] || "");
  }

  for (const match of cmd.matchAll(
    /(?:^|[\s"'])--input(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/g
  )) {
    pushPath(match[1] || match[2] || match[3] || "");
  }

  return [...new Set(paths.filter(Boolean))];
}
