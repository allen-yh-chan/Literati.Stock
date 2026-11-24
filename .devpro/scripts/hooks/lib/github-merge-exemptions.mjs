import { SEMVER_CORE } from "./version-helpers.mjs";
import { deriveChangeNameFromBranch } from "../../lib/derive-change-name-from-branch.mjs";
import { changeNameFromProposalPath, isProposalPath } from "../../lib/proposal-change-path.mjs";
import { CHANGE_STATUS, normalizeChangeStatus } from "../../lib/changed-file-status.mjs";

export function isSourceRepoReleaseBranchExempt(branch) {
  return /^release\/v\d+\.\d+\.\d+$/.test(branch || "");
}

export function isConsumerSubsetReleaseBranchExempt(branch) {
  return /^release\/\d{8}-[0-9a-f]{7}(?:-\d+)?$/.test(branch || "");
}

export function isRulesLaneReleaseBranchExempt(branch) {
  return /^release\/rules-\d{8}(-\d+)?$/.test(branch || "");
}

export function isChoreAProposalEvidence(prHeadRefName, filePath, status) {
  if (!isProposalPath(filePath)) return false;
  if (normalizeChangeStatus(status) !== CHANGE_STATUS.MODIFIED) return true;
  const owner = changeNameFromProposalPath(filePath);
  if (owner === null) return true;
  return owner === deriveChangeNameFromBranch(prHeadRefName);
}

export function isChoreAClassExempt(prHeadRefName, changedFiles, statuses) {
  if (!/^chore\//.test(prHeadRefName || "")) return false;
  if (!Array.isArray(changedFiles)) return false;
  const statusOf = statuses instanceof Map ? (f) => statuses.get(f) : () => undefined;
  const hasProposalEvidence = changedFiles.some((f) =>
    isChoreAProposalEvidence(prHeadRefName, f, statusOf(f))
  );
  return !hasProposalEvidence;
}

/** Sources are read by the adapter from the trusted rules configuration. */
export function githubBranchExemptionReason(branch, rulesSources = []) {
  if (/^chore\/bump-v\d+\.\d+\.\d+$/.test(branch || "")) return "branch-pattern: chore/bump-v<X.Y.Z>（metadata-only version bump）";
  const rules = String(branch || "").match(new RegExp(`^rules/([a-z][a-z0-9-]*)-v(${SEMVER_CORE})$`));
  if (rules && new Set(rulesSources).has(rules[1])) return "branch-pattern: rules/<whitelisted-source>-v<X.Y.Z>（已在 source repo cross-model 審過）";
  if (isSourceRepoReleaseBranchExempt(branch)) return "branch-pattern: release/v<X.Y.Z>（source repo release artifact，subset/full-main evidence handled by release process）";
  if (isConsumerSubsetReleaseBranchExempt(branch)) return "branch-pattern: release/<YYYYMMDD>-<shortSHA>（consumer release subset，已 approved）";
  if (isRulesLaneReleaseBranchExempt(branch)) return "branch-pattern: release/rules-<YYYYMMDD>（rules-lane release subset，已 approved）";
  return null;
}

export function githubProductionCarrier(branch) {
  return isSourceRepoReleaseBranchExempt(branch) || isConsumerSubsetReleaseBranchExempt(branch) || isRulesLaneReleaseBranchExempt(branch);
}
