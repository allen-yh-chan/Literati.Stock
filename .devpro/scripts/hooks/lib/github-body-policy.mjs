import { SEMVER_CORE } from "./version-helpers.mjs";
import { hasForbiddenAttribution } from "./attribution-patterns.mjs";
import { LINEAGE_APPROVAL_MARKER } from "./second-review-lineage-approval.mjs";
import { SECOND_REVIEW_STICKY_MARKER } from "./second-review-sticky-authority.mjs";

export function hasGithubProvenanceFooter(body) {
  if (typeof body !== "string") return false;
  const tail = body.trimEnd().slice(-240);
  const rulesVersion = `Rules:\\s*v${SEMVER_CORE}`;
  return new RegExp(`${rulesVersion}[^\\n]*?Tool:\\s*\\S[^\\n]*?Model:\\s*\\S[^\\n]*$`).test(tail)
    || new RegExp(`${rulesVersion}[^\\n]*?Model:\\s*\\S[^\\n]*\\s+\\/\\s+\\S[^\\n]*$`).test(tail);
}

// Rules version of the trailing footer line accepted above; null without one or with two versions on that line.
// Footer examples quoted earlier in the text are not the footer.
export function githubProvenanceFooterVersion(body) {
  if (!hasGithubProvenanceFooter(body)) return null;
  const versions = [...body.trimEnd().split("\n").at(-1).matchAll(new RegExp(`Rules:\\s*v(${SEMVER_CORE})`, "g"))];
  return versions.length === 1 ? versions[0][1] : null;
}

export function evaluateGithubBody(body) {
  if (typeof body !== "string") return { allowed: false, reasonCode: "body_required" };
  // Generic MCP comments have no dispatch-bound gated-writer credential scan or
  // independent evaluator proof. Keep that route closed until both are provided.
  if (body.includes(SECOND_REVIEW_STICKY_MARKER)) return { allowed: false, reasonCode: "reviewer_writer_required" };
  // A Path W waiver may be posted by the AI after the user says so in the
  // conversation (design-core section 11); lineage approval stays a human decision.
  if (body.includes(LINEAGE_APPROVAL_MARKER)) {
    return { allowed: false, reasonCode: "human_decision_required" };
  }
  if (!hasGithubProvenanceFooter(body)) return { allowed: false, reasonCode: "provenance_footer_required" };
  if (hasForbiddenAttribution(body)) return { allowed: false, reasonCode: "forbidden_attribution" };
  return { allowed: true, reasonCode: "body_valid" };
}

// Commit footer presence keeps the native gate's advisory severity. The common
// forbidden-marker owner remains attribution-patterns.mjs, including human trailers.
export function evaluateGithubCommitMessage(message) {
  if (typeof message !== 'string' || !message.trim()) return {allowed:false,reasonCode:'commit_message_required'};
  if (hasForbiddenAttribution(message)) return {allowed:false,reasonCode:'forbidden_attribution'};
  return hasGithubProvenanceFooter(message) ? {allowed:true} : {allowed:true,advisory:'commit_provenance_footer_required'};
}
