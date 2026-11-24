/**
 * Single-source branch -> change-name derivation (D12 F-2-3, extended by
 * `fix-second-review-loop-friction` D7 point 2 which requires the write side
 * — `render-second-review-packet.mjs`'s round-override disclosure planner —
 * and the read side — `post-pr-cost-circuit-breaker.mjs`'s
 * `evaluateOverrideDisclosure` — to apply the byte-identical predicate.
 *
 * Deliberately dependency-free (no imports): `render-second-review-packet.test.mjs`'s
 * `renderWithSourceMutation` fixture hand-enumerates every file the isolated
 * renderer copy needs, so a heavier host module here would force that
 * fixture to also copy this function's entire former host
 * (`post-pr-cost-circuit-breaker.mjs`) and that module's own transitive
 * imports (`review-remediation-evidence.mjs`, `clarification-contract.mjs`)
 * for a single leaf predicate that never needed them.
 */

// D12 F-2-3: the five branch-prefix namespaces `git-branch-naming-and-anchor.md`
// defines; the change name is whatever follows the FIRST matching
// `<prefix>/`. A branch matching none of these (or with no `/` at all) is
// returned unstripped — it will then fail CHANGE_NAME_GRAMMAR (contains `/`
// or otherwise isn't a bare kebab-case segment) and degrade to `unavailable`
// through the exact same path as a malformed stripped remainder (F-6-3
// unification: this function has no separate "no prefix matched" state).
const CHANGE_BRANCH_PREFIXES = ["feature", "bugfix", "chore", "hotfix", "rules"];

export function deriveChangeNameFromBranch(branch) {
  const raw = typeof branch === "string" ? branch : "";
  for (const prefix of CHANGE_BRANCH_PREFIXES) {
    const marker = `${prefix}/`;
    if (raw.startsWith(marker)) return raw.slice(marker.length);
  }
  return raw;
}
