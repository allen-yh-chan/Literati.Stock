/**
 * reviewer-cli-fallback.mjs
 *
 * Pure decision for the LOCAL reviewer CLI chain. The existing candidates keep their order
 * (supplied by the caller from the primary_family policy); OpenCode is only the next
 * candidate after every earlier one was TRULY unavailable, or when it is selected explicitly.
 *
 * "Truly unavailable" is a closed set: the CLI could not be discovered, spawned or served by
 * its provider. A review that ran and produced findings, malformed evidence, a stale target,
 * a policy denial or a timeout is an outcome that stands -- it is never a reason to shop for
 * a friendlier reviewer. A failed host-surface probe is unavailable only when the probe's own
 * fault classifier allows a fallback (`may_fallback`: a host fault or a genuinely missing
 * binary); a sandbox-surface fault needs a host rerun first and a wrong-model probe never
 * sets the flag, so neither can trigger a fallback.
 */

import {
  CANONICAL_REVIEWER_CLIS,
  REVIEWER_FAMILY_GROUPS,
} from "../second-review-material-contract.mjs";

export const REVIEWER_CLI_UNAVAILABLE_CLASSIFICATIONS = Object.freeze(new Set([
  "tool_discovery_blocked",
  "reviewer_cli_spawn_failed",
  "claude_reviewer_provider_rate_limited",
  "claude_reviewer_authentication_failed",
]));

export const HOST_SURFACE_CLASSIFICATION = "reviewer_host_surface_unverified";
export const OPENCODE_FALLBACK_CLI = "opencode";
const OPENCODE_FAMILY_GROUP = REVIEWER_FAMILY_GROUPS.deepseek;
const KNOWN_FAMILY_GROUPS = new Set(Object.values(REVIEWER_FAMILY_GROUPS));

export function isReviewerCliUnavailable(classification, { mayFallback = false } = {}) {
  if (REVIEWER_CLI_UNAVAILABLE_CLASSIFICATIONS.has(classification)) return true;
  return classification === HOST_SURFACE_CLASSIFICATION && mayFallback === true;
}

function assertKnownCli(cli, label) {
  if (!CANONICAL_REVIEWER_CLIS.includes(cli)) {
    throw new TypeError(`${label} must be one of ${CANONICAL_REVIEWER_CLIS.join(", ")}`);
  }
}

/**
 * @param {object} input
 * @param {string[]} input.candidates   Existing ordered candidates (claude/codex), never empty.
 * @param {string} [input.primaryGroup] REVIEWER_FAMILY_GROUPS value of the primary family; a
 *   deepseek primary cannot use OpenCode as a different-family fallback.
 * @param {{cli: string, classification: string, mayFallback?: boolean}[]} [input.attempts]
 *   Terminal outcome per tried CLI; `mayFallback` is the probe result's `may_fallback`.
 * @param {string} [input.explicit]     User-selected CLI; bypasses the fallback chain.
 */
export function selectLocalReviewerCli({ candidates, primaryGroup, attempts = [], explicit } = {}) {
  if (explicit !== undefined) {
    assertKnownCli(explicit, "explicit reviewer cli");
    return { action: "dispatch", cli: explicit, via: "explicit" };
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new TypeError("candidates must be a non-empty ordered list");
  }
  candidates.forEach((cli) => assertKnownCli(cli, "candidate reviewer cli"));
  if (primaryGroup !== undefined && !KNOWN_FAMILY_GROUPS.has(primaryGroup)) {
    throw new TypeError(`primaryGroup must be one of ${[...KNOWN_FAMILY_GROUPS].join(", ")}`);
  }
  const outcomeByCli = new Map();
  for (const attempt of attempts) {
    assertKnownCli(attempt?.cli, "attempt cli");
    outcomeByCli.set(attempt.cli, attempt);
  }
  const chain = [...candidates];
  if (!chain.includes(OPENCODE_FALLBACK_CLI) && primaryGroup !== OPENCODE_FAMILY_GROUP) {
    chain.push(OPENCODE_FALLBACK_CLI);
  }
  for (const [index, cli] of chain.entries()) {
    if (!outcomeByCli.has(cli)) {
      return { action: "dispatch", cli, via: index < candidates.length ? "order" : "fallback" };
    }
    const { classification, mayFallback } = outcomeByCli.get(cli);
    if (!isReviewerCliUnavailable(classification, { mayFallback })) {
      return { action: "stop", reason: "outcome_stands", cli, classification };
    }
  }
  return { action: "stop", reason: "all_unavailable" };
}
