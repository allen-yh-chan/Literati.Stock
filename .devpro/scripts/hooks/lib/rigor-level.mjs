/**
 * lib/rigor-level.mjs — SSOT for DEVPRO_AGENT_RULES_LEVEL precedence resolution
 * and hook/gate classification.
 *
 * Design: single source of truth shared by run-hook.mjs (Layer 1 / wrapper) and
 * pre-tool-gate.mjs (Layer 2 / gate-level filter) to prevent gate-id drift.
 *
 * Precedence (highest → lowest):
 *   1. env DEVPRO_AGENT_RULES_LEVEL
 *   2. consumer .devpro/rules.config (repo root, key=value format, key: agent_rules_level)
 *   3. built-in default: "lite"
 *
 * Valid values: "full" | "lite" | "off" (absent → lite; explicitly invalid → full)
 */

import { lstatSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VALID_LEVELS = new Set(["full", "lite", "off"]);

/**
 * Resolve the active rigor level.
 *
 * @param {object} opts
 * @param {string} [opts.cwd]  Override repo root lookup (mainly for tests).
 *                             If omitted, derives from this file's location
 *                             (hooks/lib → hooks → scripts → .devpro → repo-root).
 * @param {object} [opts.env]  Environment to read DEVPRO_AGENT_RULES_LEVEL from
 *                             (default process.env). Lets a caller that already
 *                             holds an injected env resolve the level from it.
 * @returns {"full"|"lite"|"off"}
 */
export function resolveRigorLevel({ cwd, env = process.env } = {}) {
  return resolveRigorSelection({ cwd, env }).level;
}

// Provenance distinguishes an explicit full preference from invalid-setting
// protection. The latter does not authorize an AI to start a full workflow.
export function resolveRigorSelection({ cwd, env = process.env } = {}) {
  // Layer 1: env. A SET-but-invalid env value is fail-closed to "full" (most
  // strict), NOT treated as unset — otherwise a typo'd env in a repo whose
  // .devpro/rules.config says "off"/"lite" would silently keep reduced rigor.
  // Only an UNSET (undefined / empty / whitespace-only) env falls through to
  // the config layer. (Honors the JSDoc contract: invalid → full.)
  const rawEnv = env.DEVPRO_AGENT_RULES_LEVEL;
  if (rawEnv != null && rawEnv.trim() !== "") {
    const envLevel = rawEnv.trim();
    return { level: VALID_LEVELS.has(envLevel) ? envLevel : "full", source: "environment", valid: VALID_LEVELS.has(envLevel) };
  }

  // Layer 2: .devpro/rules.config in the repo root. key=value format: each line
  // is "key=value"; blank lines and "#" comment lines are skipped; unknown keys
  // are ignored (forward-compat); looks for "agent_rules_level" key. If not
  // found → built-in lite; explicitly invalid/empty → protective full.
  const repoRoot = cwd || deriveRepoRoot();
  try {
    if (!repoRoot || !statSync(repoRoot).isDirectory()) throw new Error("unresolved repository");
  } catch {
    return { level: "full", source: "repository", valid: false };
  }
  const configPath = path.join(repoRoot, ".devpro", "rules.config");
  let present = false;
  try {
    lstatSync(configPath);
    present = true;
  } catch (error) {
    if (error?.code !== "ENOENT") return { level: "full", source: "config", valid: false };
  }
  if (present) {
    try {
      const token = parseConfigLevel(readFileSync(configPath, "utf8"));
      if (token !== null) return { level: VALID_LEVELS.has(token) ? token : "full", source: "config", valid: VALID_LEVELS.has(token) };
    } catch {
      return { level: "full", source: "config", valid: false };
    }
  }

  // Layer 3: built-in default
  return { level: "lite", source: "default", valid: true };
}

// This is a decision check, not an authorization receipt: userApproved must
// come from the user's actual instruction, never an AI-created scope record.
export function evaluateRigorUpgrade({ selection, reason = "", userApproved = false } = {}) {
  if (!selection || selection.valid !== true) return { allowed: false, reason: "repair-invalid-setting" };
  if (selection.level === "full") return { allowed: true, reason: "existing-explicit-full" };
  if (!String(reason).trim()) return { allowed: false, reason: "upgrade-reason-required" };
  if (userApproved !== true) return { allowed: false, reason: "user-approval-required" };
  return { allowed: true, reason: "reason-and-user-approval" };
}

/**
 * Extract the rigor-level value from raw `.devpro/rules.config` content.
 * Format: key=value pairs, one per line. Skips blank lines and `#`-prefixed
 * comment lines. Unknown keys are ignored (forward-compat). Returns the value
 * for the first `agent_rules_level` key (trimmed), or null if not found.
 * Duplicate `agent_rules_level=` declarations are first-match-wins; later
 * declarations are ignored by design rather than treated as overrides.
 * Lines without `=` (bare values) are not recognized — they have no key that
 * matches `agent_rules_level` and are ignored.
 * Value validity is left to the caller (`resolveRigorLevel` via VALID_LEVELS).
 * @param {string} raw
 * @returns {string|null}
 */
export function parseConfigLevel(raw) {
  for (const line of String(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue; // bare value — no key=value pair, skip
    const key = trimmed.slice(0, eqIdx).trim();
    if (key === "agent_rules_level") {
      return trimmed.slice(eqIdx + 1).trim();
    }
  }
  return null;
}

/**
 * Derive repo root from this file's location.
 * File lives at: <repo-root>/.devpro/scripts/hooks/lib/rigor-level.mjs
 * So go up 4 levels: lib → hooks → scripts → .devpro → repo-root
 */
function deriveRepoRoot() {
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(thisDir, "../../../..");
  } catch {
    return null;
  }
}

/**
 * The 5 baseline gate-ids that implement the 4 user-facing baseline checks and
 * MUST run at every rigor level (including "off").
 *
 * Four are fail-closed safety rails (protected-branch-write family + Gate P
 * openspec-doc-pii). The fifth, commit-attribution-brand-leak, is a fail-closed
 * COMPLIANCE gate: it blocks AI brand markers (e.g. "Co-Authored-By: Claude")
 * from entering irreversible git history. Per code-review-checklist.md it is a
 * security/compliance gate, so it stays live even at off (user-confirmed scope:
 * off downgrades workflow rigor, not compliance). force-push is intentionally
 * NOT baseline — destructive history rewrite is a risk the engineer owns when
 * they explicitly choose off.
 *
 * WARNING: Changing these IDs must be synchronized with the gate-id strings in
 * pre-tool-gate.mjs (BASH_BLOCKING_GATES, BASH_ADVISORY_GATES, WRITE_BLOCKING_GATES).
 * Drift between this list and the actual gate definitions will silently disable
 * the safety guarantee — any edit here MUST be accompanied by a matching edit to
 * the corresponding gate-id string in pre-tool-gate.mjs and vice versa. The
 * `BASELINE_GATE_IDS ⊆ ACTIVE_GATE_INVENTORY.id` cross-assertion in
 * rules-rigor-level.test.mjs mechanically catches rename drift.
 */
export const BASELINE_GATE_IDS = Object.freeze([
  "protected-branch-write",
  "protected-branch-uncertain-cwd",
  "protected-branch-file-write",
  "openspec-doc-pii",
  "commit-attribution-brand-leak",
]);

/**
 * Hook no-op policy for Layer 1 (run-hook.mjs wrapper).
 *
 * Each entry specifies at which rigor levels the hook runs vs. is skipped.
 * run-hook.mjs exits 0 without spawning the inner hook when the resolved level
 * is below the hook's minimum.
 *
 * Semantics:
 *   "always"  — run at full, lite, and off (baseline carriers + session-start)
 *   "lite"    — run at full and lite; skip (exit 0) at off
 *   "cross-repo-stop" — run at full and lite; at off, run only for an
 *                       outstanding cross-repository Stop obligation
 *   "full"    — run only at full; skip at lite and off
 *               Use for: advisory / soft-nudge hooks (most advisory hooks)
 *
 * Hooks NOT in this map are treated as "always" (fail-safe: unknown hook runs).
 *
 * NOTE: pre-tool-gate.mjs and post-tool-gate.mjs are deliberately "always" —
 * they carry baseline-check gates and must run at every level so that Layer 2
 * gate-level filtering can enforce baseline security. Do NOT change them to a
 * lower frequency.
 */
export const HOOK_NOOP_POLICY = Object.freeze({
  // Baseline carriers — always run (Layer 2 handles gate-level filtering inside)
  "pre-tool-gate.mjs": "always",
  "post-tool-gate.mjs": "always",
  // GitHub artifact provenance and brand-leak compliance stays live at every level.
  "gh-footer-gate.mjs": "always",
  // Harmless session-scoped state hook — always run
  "session-start.mjs": "always",
  // Advisory / soft-nudge hooks — run only at full; no-op at lite and off
  "commit-soft-nudge.mjs": "full",
  "recap-check.mjs": "full",
  "post-merge-check.mjs": "full",
  "session-pending-cleanup-check.mjs": "full",
  "user-prompt-gate.mjs": "full",
  "stop-handoff-cite.mjs": "full",
  "post-pr-completion-check.mjs": "cross-repo-stop",
  "release-back-merge-check.mjs": "cross-repo-stop",
});

/**
 * Determine whether a hook script should be skipped (no-op) at the given level.
 *
 * @param {string} scriptBasename  Basename of the hook script file.
 * @param {"full"|"lite"|"off"} level  Resolved rigor level.
 * @param {object} [options]
 * @param {boolean} [options.hasCrossRepoObligation] A read-only Stop probe found a cross-repository obligation.
 * @returns {boolean}  true → exit 0 without spawning; false → proceed normally.
 */
export function shouldNoOp(scriptBasename, level, { hasCrossRepoObligation = false } = {}) {
  if (level === "full") return false; // full: nothing is skipped

  const policy = HOOK_NOOP_POLICY[scriptBasename] ?? "always";

  if (level === "off") {
    return policy !== "always" && !(policy === "cross-repo-stop" && hasCrossRepoObligation);
  }

  if (level === "lite") {
    // lite: skip "full"-only hooks ("full" policy); "lite" and "always" still run
    return policy === "full";
  }

  return false;
}
