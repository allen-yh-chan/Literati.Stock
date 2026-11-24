import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";

const currentArchiveChange = "2026-07-22-rationalize-session-pending-gaps";


function readFirst(paths) {
  for (const rel of paths) {
    const abs = repoPath(rel);
    if (existsSync(abs)) return readFileSync(abs, "utf8");
  }
  throw new Error(`none of these paths exist: ${paths.join(", ")}`);
}

function readCurrentArchiveSpec(capability) {
  return read(`openspec/changes/archive/${currentArchiveChange}/specs/${capability}/spec.md`);
}

function assertRetiredMainCheckoutStagingWordingAbsent(label, body) {
  for (const pattern of [
    /MUST NOT mandate/,
    /unreachable main checkout/,
    /main[- ]checkout[^。.]*unless the exact/,
    /main[- ]checkout notes\/tmp without/,
    /family-specific reachable staging/,
    /exact reviewer recipe grants/,
    /"--add-dir"/,
  ]) {
    assert.doesNotMatch(body, pattern, `${label} must not carry retired reviewer-staging wording`);
  }
}

// Reviewer sticky staging differs by family in basename only：both Codex and Claude
// safe-mode now stage in the reviewer's own current neutral cwd (issue #1735 fix removed
// the Codex `--add-dir` main-checkout grant). Both still forbid the target worktree.
test("reviewer sticky staging is family-reachable and not worktree-internal", () => {
  const crossModel = read(".devpro/agent-rules/code-review-cross-model.md") + "\n" +
    read(".devpro/agent-rules/code-review-cross-model-cli-contract.md") + "\n" +
    // the sticky body-file wrapper rule moved verbatim to the dispatch-mechanics sibling
    read(".devpro/agent-rules/code-review-cross-model-dispatch-mechanics.md");
  const codexHost = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  const claudeCode = read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md");
  const codexSpec = read("openspec/specs/code-review-checklist/spec.md");
  const paritySpec = read("openspec/specs/cross-runtime-parity/spec.md");
  const preToolSpec = readFirst([
    "openspec/changes/refactor-temp-writes-to-notes-tmp/specs/pre-tool-mechanical-gates/spec.md",
    "openspec/specs/pre-tool-mechanical-gates/spec.md",
  ]);
  const archiveFlowSpec = readCurrentArchiveSpec("openspec-flow");
  const archiveCodexSpec = readCurrentArchiveSpec("code-review-checklist");
  const archiveParitySpec = readCurrentArchiveSpec("cross-runtime-parity");
  const archivePreToolSpec = readCurrentArchiveSpec("pre-tool-mechanical-gates");

  // Shared/Claude-facing carriers MUST require a path reachable from the exact recipe.
  for (const body of [crossModel, codexHost, claudeCode]) {
    assert.match(
      body,
      // issue #1735: `family-specific reachable` was dropped from this alternation once the
      // last rule-leaf carrier of that wording went away — leaving it in would let the
      // retired per-family-path phrasing return without turning this fence red.
      /current neutral cwd|exact family recipe/,
      "rule file must reference the reviewer's own current neutral cwd as the staging destination"
    );
    // Must still forbid worktree-internal sticky body staging
    assert.match(body, /worktree-internal sticky body staging/);
    assert.match(body, /sticky body|body file/);
    assert.match(body, /stdin\/direct gh body/);
    assert.match(body, /repo write|repo file writes|repo\/git write/);
  }

  // Claude safe-mode must use its current neutral cwd and reject the main checkout as a reviewer-owned sticky/body staging target.
  assert.match(
    codexHost,
    /Write[\s\S]*current neutral cwd[\s\S]*worktree-internal sticky body staging/
  );
  assert.match(
    claudeCode,
    /Write[\s\S]*current neutral cwd[\s\S]*worktree-internal sticky body staging/
  );
  // issue #1735: the retired shape was a *conditional* ban ("unless the exact recipe grants
  // that path"). No recipe grants one any more, so the conditional is dead — and while the
  // alternation still carried it, it was the only branch these two files matched, i.e. the
  // fence mechanically required the retired wording to stay. One unconditional branch now,
  // plus a negative fence so the conditional cannot come back green.
  assert.match(codexHost, /MUST NOT name the main checkout as a reviewer-owned sticky\/body staging target/);
  assert.match(claudeCode, /MUST NOT name main-checkout notes\/tmp as a reviewer-owned sticky\/body staging target/);
  assert.doesNotMatch(codexHost, /MUST NOT mandate/);
  assert.doesNotMatch(claudeCode, /MUST NOT mandate/);
  assert.doesNotMatch(codexHost, /unreachable main checkout/);
  assert.doesNotMatch(claudeCode, /unreachable main checkout/);
  assert.doesNotMatch(codexHost, /main[- ]checkout[^。.]*unless the exact/);
  assert.doesNotMatch(claudeCode, /main[- ]checkout[^。.]*unless the exact/);
  // The Claude adapter carried the same retired conditional in a second wording
  // ("without an exact recipe grant"). Fencing only the "unless" phrasing left that copy
  // both alive and uncovered, so fence the phrasing too and positively lock its successor.
  assert.doesNotMatch(claudeCode, /main[- ]checkout notes\/tmp without/);
  assert.match(claudeCode, /MUST NOT name main-checkout notes\/tmp as a reviewer-owned sticky\/body staging target/);

  // Codex exact recipe no longer grants a main-checkout carrier via --add-dir
  // (issue #1735 regression fence): the literal grant must not reappear in the canonical spec.
  assert.doesNotMatch(codexSpec, /--add-dir <main-checkout notes\/tmp>/);
  assert.match(codexSpec, /a 13-element argv with no `--add-dir` element/);
  // Both canonical specs make the 13-element claim; locking only one left the other free to
  // drift. And both write the argv out as a JSON array literal, where a re-added grant would
  // read `"--add-dir","<main-checkout notes/tmp>"` — no space, so the prose-shaped fence
  // above never sees it. Fence the quoted element form in both specs as well.
  assert.match(paritySpec, /exact 13-element array with no `--add-dir` element/);
  assert.doesNotMatch(codexSpec, /"--add-dir"/);
  assert.doesNotMatch(paritySpec, /"--add-dir"/);

  // The same fact lives in a third carrier the rule-leaf sweep missed: the W3 carve comment
  // in the hook itself. It called main-checkout `notes/tmp` "the canonical reviewer-sticky
  // destination" two lines after the block above it says reviewer sticky must NOT stage
  // there — a maintainer reading the code got the opposite answer from the rule leaf.
  const preToolGate = read(".devpro/scripts/hooks/pre-tool-gate.mjs");
  assert.doesNotMatch(preToolGate, /canonical reviewer-sticky destination/);
  assert.match(preToolGate, /regression-compatibility surface/);

  // pre-tool-mechanical-gates spec: scenario title preserved, body inverted
  assert.match(preToolSpec, /Reviewer Sticky Staging Stays Out Of Worktree/);
  assert.match(preToolSpec, /documented reviewer subprocess sticky staging/);
  assert.match(preToolSpec, /MUST NOT use.*worktree-internal/);
  // issue #1735 regression fence: the two-branch rule (main-checkout notes/tmp when the exact
  // recipe grants it, otherwise neutral cwd) is retired — one destination for every family.
  assert.match(preToolSpec, /renderer-owned per-dispatch neutral cwd/);
  assert.match(preToolSpec, /no recipe may grant a main-checkout `notes\/tmp` staging path/);
  assert.doesNotMatch(preToolSpec, /family-specific reachable staging/);
  assert.doesNotMatch(preToolSpec, /exact reviewer recipe grants/);
  // stdin/direct gh body still documented
  assert.match(preToolSpec, /stdin\/direct gh body/);

  for (const [label, body] of [
    ["canonical code-review-checklist", codexSpec],
    ["canonical cross-runtime-parity", paritySpec],
    ["canonical pre-tool-mechanical-gates", preToolSpec],
    ["current archive openspec-flow", archiveFlowSpec],
    ["current archive code-review-checklist", archiveCodexSpec],
    ["current archive cross-runtime-parity", archiveParitySpec],
    ["current archive pre-tool-mechanical-gates", archivePreToolSpec],
  ]) {
    assertRetiredMainCheckoutStagingWordingAbsent(label, body);
  }
  assert.match(archiveFlowSpec, /reviewer-owned sticky\/body staging target/);
  assert.match(archiveParitySpec, /MUST NOT name the main checkout as a reviewer-owned sticky\/body staging target/);
  assert.match(archivePreToolSpec, /not a reviewer-owned sticky\/body staging target/);
});

test("Claude sticky refresh and shared API-only authority use current-neutral-cwd body files and Codex has no add-dir grant", () => {
  const crossModel = read(".devpro/agent-rules/code-review-cross-model.md") + "\n" +
    read(".devpro/agent-rules/code-review-cross-model-cli-contract.md") + "\n" +
    // the sticky body-file wrapper rule moved verbatim to the dispatch-mechanics sibling
    read(".devpro/agent-rules/code-review-cross-model-dispatch-mechanics.md");
  const codexHost = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  const claudeCode = read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md");
  const flowSpec = read("openspec/specs/openspec-flow/spec.md");
  const codexSpec = read("openspec/specs/code-review-checklist/spec.md");
  const paritySpec = read("openspec/specs/cross-runtime-parity/spec.md");
  const noMainCheckoutStagingPattern = /MUST NOT name (?:the main checkout|main-checkout notes\/tmp|any main-checkout body path) as a reviewer-owned sticky\/body staging target/;

  for (const body of [codexHost, claudeCode, flowSpec]) {
    assert.match(body, /current neutral cwd|current-neutral-cwd/);
    // same retired conditional, shared across the two adapters and the flow spec (issue #1735)
    assert.match(body, noMainCheckoutStagingPattern);
    assert.doesNotMatch(body, /MUST NOT mandate/);
    assert.doesNotMatch(body, /unreachable main checkout/);
    assert.doesNotMatch(body, /main[- ]checkout[^。.]*unless the exact/);
    assert.match(body, /target worktree-local `?notes\/tmp`?|target-worktree-local `?notes\/tmp`?|worktree-local `?notes\/tmp`?|target worktree-internal sticky body staging/);
    assert.match(body, /sticky-only/);
    assert.match(body, /sticky_write_exact_recipe|write-second-review-sticky-gated\.mjs|gated sticky write CLI/);
    assert.match(body, /禁止 raw `gh api` POST\|PATCH `body=@`|NEVER raw `gh api` POST\|PATCH `body=@`|NEVER raw `gh api`/);
  }

  const paragraphs = (body) => body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim());
  const sharedAuthority = paragraphs(crossModel)
    .find((paragraph) => /Safe-mode (?:API-only|gated-CLI) family/.test(paragraph));
  assert.ok(sharedAuthority, "shared gated sticky authority contract must remain documented");
  assert.match(sharedAuthority, /current neutral cwd body file/);
  assert.match(sharedAuthority, /完整列舉canonical marker candidates/);
  assert.match(sharedAuthority, /enumerate the complete canonical marker candidate set/);
  assert.match(sharedAuthority, /zero=create, one=update|sticky_write_exact_recipe/);
  assert.doesNotMatch(sharedAuthority, /zero=one POST, one=one PATCH/);
  assert.match(sharedAuthority, /more-than-one or unresolved count\/id=blocked with no write/);
  assert.match(sharedAuthority, /MUST NOT try another create primitive/);

  const successorAuthority = paragraphs(flowSpec)
    .find((paragraph) => paragraph.includes("focused sticky-refresh or separately authorized successor"));
  assert.ok(successorAuthority, "successors must retain the same sticky authority contract");
  assert.match(successorAuthority, /new lineage-bound dispatch/);
  assert.match(successorAuthority, /same current-neutral-cwd body-file and authority contract/);

  assert.doesNotMatch(codexSpec, /--add-dir <main-checkout notes\/tmp>/);
  assert.match(codexSpec, /a 13-element argv with no `--add-dir` element/);
  // Both canonical specs make the 13-element claim; locking only one left the other free to
  // drift. And both write the argv out as a JSON array literal, where a re-added grant would
  // read `"--add-dir","<main-checkout notes/tmp>"` — no space, so the prose-shaped fence
  // above never sees it. Fence the quoted element form in both specs as well.
  assert.match(paritySpec, /exact 13-element array with no `--add-dir` element/);
  assert.doesNotMatch(codexSpec, /"--add-dir"/);
  assert.doesNotMatch(paritySpec, /"--add-dir"/);
});

// The repo-containment precondition drifted one-way twice while this change was in review:
// the spec said "resolves inside the checkout" while the shipped renderer already rejected
// both directions. A one-way reading is worse than useless — it waves through `/` or `$HOME`
// (strictly more authority than the `<main-checkout>/notes/tmp` grant issue #1735 shipped)
// while still rejecting the smaller repo-internal root. Fence both carriers so either side
// regressing to one direction turns this red.
test("reviewer-writable-root repo containment stays two-way in both the spec and the renderer", () => {
  const codexSpec = read("openspec/specs/code-review-checklist/spec.md");
  const renderer = read(".devpro/scripts/render-second-review-packet.mjs");

  assert.match(codexSpec, /Containment MUST be evaluated in both directions/);
  assert.match(codexSpec, /or if the root contains either checkout/);
  assert.match(codexSpec, /neither resolves inside nor contains either checkout/);
  // the retired one-way scenario line, which asserted only that an outside root passes
  assert.doesNotMatch(codexSpec, /a reviewer-writable root outside the repository MUST NOT be rejected/);

  // Only the fail-closed condition is fenced here. Asserting the two `const` declarations
  // as well would false-red on a legitimate helper extraction while adding nothing: the
  // condition below already names both directions and is the line that decides the throw.
  // This one assertion deliberately duplicates render-second-review-packet.test.mjs:3119 —
  // co-locating it with the spec assertions above is the point, so a reader sees the spec
  // wording and the implementing line fail together rather than one at a time.
  assert.match(renderer, /if \(!rootIsInsideCheckout && !rootContainsCheckout\) continue;/);
});
