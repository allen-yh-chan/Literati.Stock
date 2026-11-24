/**
 * Single-source judgments over `openspec/changes/**\/proposal*.md` paths, shared by
 * the chore-A exemption classifiers (`hooks/pre-tool-gate.mjs`) and the PR sticky
 * handoff builder (`build-pr-sticky-handoff.mjs`) so the two sides cannot drift.
 *
 * Deliberately dependency-free (no imports), like `derive-change-name-from-branch.mjs`:
 * test fixtures that copy a script into an isolated tree only need to bring this one
 * leaf file along.
 */

// Broad shape: ANY proposal.md / proposal-mini.md under an active change folder or under
// `archive/` (dated or not). This is the "is this path a proposal" question the chore-A
// exemption has always asked; it stays broad so an odd archive layout never reads as "no proposal".
const PROPOSAL_PATH_RE = /^openspec\/changes\/(archive\/)?[^/]+\/proposal(-mini)?\.md$/;

// Strict shape: the change name is recoverable. An active folder is `<change>`; an archived
// folder is `archive/<YYYY-MM-DD>-<change>`. An undated archive folder does NOT match, so its
// owner is unknown (callers treat unknown as "counts as proposal evidence", i.e. fail closed).
const PROPOSAL_CHANGE_NAME_RE =
  /^openspec\/changes\/(?:archive\/\d{4}-\d{2}-\d{2}-)?([^/]+)\/proposal(?:-mini)?\.md$/;

export function isProposalPath(filePath) {
  return typeof filePath === "string" && PROPOSAL_PATH_RE.test(filePath);
}

/**
 * The change a proposal path belongs to, or `null` when the path is not a proposal path or
 * its owning change cannot be told apart (undated archive folder).
 */
export function changeNameFromProposalPath(filePath) {
  if (typeof filePath !== "string") return null;
  const match = filePath.match(PROPOSAL_CHANGE_NAME_RE);
  return match ? match[1] : null;
}
