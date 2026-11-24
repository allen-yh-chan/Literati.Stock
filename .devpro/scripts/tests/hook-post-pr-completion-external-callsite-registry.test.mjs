// T6 (design.md D6, tasks.md T6 "callsite 登記表 grep-anchor" bullet):
// exhaustive registry of every `clearPostPrCompletionMarker` /
// `clearDispatchBoundMarker` / `verifyDispatchEvidenceAndAppendReceipts` call
// site in post-pr-completion-check.mjs, keyed by enclosing function/branch
// context (not line number) so line-shifting refactors don't false-positive.
// A genuinely NEW, unregistered call site — one the total-count check below
// cannot account for — turns this test red, per the task's own requirement
// ("未登記的新呼叫點 → 測試紅").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const SOURCE = readFileSync(repoPath(".devpro/scripts/hooks/post-pr-completion-check.mjs"), "utf8");

const CALLEE_RE = /\b(clearPostPrCompletionMarker|clearDispatchBoundMarker|clearUnboundMarker|verifyDispatchEvidenceAndAppendReceipts)\(/g;

// Anchors are exact source substrings (indexOf, not regex — call sites here
// include object-literal argument lists, and a regex re-escape of that text
// is more failure-prone than a literal compare). Each entry documents its D6
// reachability classification per tasks.md T6's own taxonomy:
//   - "branch-pattern exempt" = intentionally reachable for external markers
//     (trusted local policy, runs before the D6 branch point)
//   - "resolver" = the disposition (`resolveExternalMarkerDisposition` /
//     `finalizeExternalDispositionClear`) decides the clear itself
//   - "unreachable (external routed via D6 continue)" = branched away before
//     ever reaching this call, for an external marker
//   - "runner-only" = only ever invoked from a call site that is itself
//     unreachable for external markers
//   - "shared helper body" = not itself a decision point; reachable via both
//     resolver-decided and runner-only call sites
const REGISTRY = [
  {
    anchor: "return clearDispatchBoundMarker(marker, snapshot, process.cwd());",
    count: 1,
    classification:
      "verifyDispatchEvidenceAndAppendReceipts current-head-PASS shortcut — runner-only (the function itself is only invoked from call sites unreachable for external markers, see the two `runner-only` entries below)",
  },
  {
    anchor: 'return clearPostPrCompletionMarker({\n    cwd: process.cwd(),',
    count: 1,
    classification: "verifyDispatchEvidenceAndAppendReceipts success path — runner-only",
  },
  {
    anchor:
      'return clearPostPrCompletionMarker({\n    cwd,\n    prNumber: marker.prNumber || snapshot?.number || "",',
    count: 1,
    classification:
      "clearDispatchBoundMarker's own body — shared helper, not itself a decision point; reachable via both the resolver's finalizeExternalDispositionClear and the runner-only main() call sites",
  },
  {
    anchor: "? clearDispatchBoundMarker(marker, snapshot, cwd)",
    count: 1,
    classification: "finalizeExternalDispositionClear (resolver) — disposition decided",
  },
  {
    anchor: ": Boolean(clearPostPrCompletionMarker(clearArgs));",
    count: 1,
    classification: "finalizeExternalDispositionClear (resolver) — disposition decided",
  },
  {
    anchor: "if (!clearDispatchBoundMarker(marker, null, cwd)) stillPending.push(marker);",
    count: 1,
    classification:
      "main() isMarkerBranchPatternExempt early-return, dispatch-bound (pre-snapshot fetch) — intentionally reachable for external markers",
  },
  {
    anchor:
      "const cleared = clearUnboundMarker(marker, { cwd,",
    count: 1,
    classification:
      "main() isMarkerBranchPatternExempt early-return, unbound (pre-snapshot fetch) — intentionally reachable for external markers",
  },
  {
    anchor: "const canceled = clearPostPrCompletionMarker({",
    count: 1,
    classification: "main() owned verified CLOSED cancellation — reachable for external markers before review-completion disposition; cancellation is not a merge/review success",
  },
  {
    anchor: "const cleared = clearDispatchBoundMarker(marker, snapshot, cwd);",
    count: 1,
    classification:
      "clearMergedNeverStartedDispatchMarker (MERGED + never-started dispatch evidence) — runner-only; external markers continue via resolveExternalMarkerDisposition before this helper",
  },
  {
    anchor: "if (!(await verifyDispatchEvidenceAndAppendReceipts(marker, snapshot))) {",
    count: 1,
    classification:
      "main() MERGED self-heal, dispatch-bound — unreachable for external (branched away by the isExternalMarker(marker) `continue` above)",
  },
  {
    anchor: "try { if (clearPostPrCompletionMarker(clearArgs)) return true; } catch {}",
    count: 1,
    classification: "clearUnboundMarker — shared retirement helper, reached for external only under the pre-snapshot branch-pattern exemption",
  },
  {
    anchor: "if (!clearUnboundMarker(marker, clearArgs)) stillPending.push(marker);",
    count: 2,
    classification: "diff-shape exemption and fresh sticky — unreachable for external",
  },
  {
    anchor: "if (clearUnboundMarker(marker, clearArgs)) clearStopReviewRound",
    count: 1,
    classification: "MERGED self-heal — unreachable for external",
  },
  {
    anchor: "return clearUnboundMarker(marker, clearArgs);",
    count: 1,
    classification: "Path W waiver — unreachable for external",
  },
  {
    anchor: "if (!clearDispatchBoundMarker(marker, snapshot, cwd)) stillPending.push(marker);",
    count: 1,
    classification: "main() cross-model exempt, dispatch-bound — unreachable for external",
  },
  {
    anchor: "if (markerHasDispatchBinding(marker)) return Boolean(clearDispatchBoundMarker(marker, snapshot, cwd));",
    count: 1,
    classification:
      "clearMarkerOnFreshWaiver (Path W on open and merged PRs), dispatch-bound — runner-only; both main() call sites sit after the isExternalMarker(marker) `continue`",
  },
  {
    anchor: "if (clearDispatchBoundMarker(marker, snapshot, cwd)) continue;",
    count: 1,
    classification: "main() isAuthoritativeCurrentHeadPass shortcut — unreachable for external",
  },
  {
    anchor: "if (await verifyDispatchEvidenceAndAppendReceipts(marker, snapshot)) continue;",
    count: 1,
    classification: "main() fresh-sticky dispatch-bound verifier call — unreachable for external",
  },
];

function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

test("D6 callsite registry: every registered anchor still occurs exactly the expected number of times", () => {
  for (const { anchor, count, classification } of REGISTRY) {
    assert.equal(
      countOccurrences(SOURCE, anchor),
      count,
      `registered D6 callsite anchor drifted (expected ${count} occurrence(s)) — classification: ${classification}\nanchor: ${JSON.stringify(anchor)}`
    );
  }
});

test("D6 callsite registry: no unregistered clear/verify call site exists (total-count guard)", () => {
  const totalMatches = (SOURCE.match(CALLEE_RE) || []).length;
  // Three callees are defined here. The imported clearPostPrCompletionMarker contributes only calls.
  const DEFINITION_MATCHES = 3;
  const registeredTotal = REGISTRY.reduce((sum, { count }) => sum + count, 0);
  assert.equal(
    totalMatches - DEFINITION_MATCHES,
    registeredTotal,
    "an unregistered clearPostPrCompletionMarker/clearDispatchBoundMarker/verifyDispatchEvidenceAndAppendReceipts call site was added to post-pr-completion-check.mjs — register it in REGISTRY above with its D6 reachability classification (tasks.md T6 callsite-registry bullet)"
  );
});
