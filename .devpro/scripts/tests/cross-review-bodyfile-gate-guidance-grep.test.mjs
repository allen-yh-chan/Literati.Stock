import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readRepoFile as read } from "./lib/read.mjs";



function assertContains(body, pattern, label) {
  assert.ok(pattern.test(body), `missing ${label}`);
}

test("Codex-host Claude sticky write-back uses the renderer-selected exact recipe", () => {
  const codexHost = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  const claude = read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md");
  const secondReview = read(".devpro/agent-skills/devpro-reviews/second-review/SKILL.md");
  const cliReference = read(".devpro/agent-skills/devpro-reviews/cross-review/references/cli-invocation.md");

  for (const body of [codexHost, claude]) {
    assert.match(body, /Canonical sticky body-file happy path|canonical happy path|first-choice sticky path/i);
    assert.match(body, /reviewer current neutral cwd|renderer-owned current neutral cwd|current-neutral-cwd body file/);
    // issue #1735: the ban is unconditional now — every "unless the exact recipe grants it"
    // branch was retired wording that this alternation would have kept alive silently.
    assert.match(body, /MUST NOT name (?:the main checkout|main-checkout notes\/tmp) as a reviewer-owned sticky\/body staging target/);
    assert.doesNotMatch(body, /MUST NOT mandate/);
    assert.doesNotMatch(body, /unreachable main checkout/);
    assert.doesNotMatch(body, /main[- ]checkout[^。.]*unless the exact/);
    assert.match(body, /<!-- cross-model-second-opinion:sticky -->/);
    assert.match(body, /bare `verdict:|verdict: PASS \| WARN \| CRITICAL \| UNAVAILABLE/);
    assert.match(body, /bare[\s\S]{0,80}`last_reviewed_sha:|last_reviewed_sha: <headRefOid>|last_reviewed_sha:`/);
    assert.match(body, /cross-model-second-opinion\.md/);
    assert.match(body, /sticky_write_exact_recipe/);
    assert.match(body, /renderer-selected|renderer-provided|renderer-emitted/);
    assert.match(body, /disposition-bound|disposition綁定|disposition.*exact recipe/i);
    assert.doesNotMatch(body, /gh pr comment <positive-decimal> --body-file/);
    assert.doesNotMatch(body, /<reviewer-body-file>/);
    assert.doesNotMatch(body, /gh (?:pr|api)[^`\n]*\$(?:GH_REPO|DEVPRO_REVIEW_PR_NUMBER)/);
    assert.match(body, /custom[\s-]*(?:sticky\s*)?markers?|自創 marker/);
    assert.match(body, /inline (?:multi-line )?`--body`|inline multi-line `--body`/);
    assert.match(body, /\.pr-body\.md/);
  }

  for (const body of [codexHost, claude, secondReview, cliReference]) {
    assert.match(body, /cross-model-second-opinion\.md/);
    assert.match(body, /sticky_write_exact_recipe/);
    assert.doesNotMatch(body, /Bash\(gh pr comment:\*\)/);
    assert.doesNotMatch(body, /<reviewer-body-file>/);
  }
});

test("shared and Cursor carriers do not reconstruct Claude sticky authority", () => {
  // The shared wrapper／attempt-lock contract moved verbatim to the dispatch-mechanics sibling.
  const crossModel = read(".devpro/agent-rules/code-review-cross-model-dispatch-mechanics.md");
  const cursor = read(".devpro/agent-rules/platform-adapters/cursor.md");

  assert.match(crossModel, /safe-mode family[\s\S]{0,480}sticky_write_exact_recipe/);
  assert.match(crossModel, /safe-mode family[\s\S]{0,480}(?:MUST NOT|不得)[\s\S]{0,160}(?:copy|複製|infer|推導|substitut|替換|reconstruct|重建)/i);
  // issue #1728: the shared carrier MUST keep the diff-reading live-read data-to-argv
  // carve-out (validated positive-decimal PR# → literal PR argv) that #1725 over-removed.
  // It coexists with the copy-free sticky-write hardening asserted above because the two
  // govern disjoint operations — live READ vs sticky WRITE — so both hold on this carrier.
  assert.match(crossModel, /safe-mode family[^\n]*canonical framed target[^\n]*positive decimal[^\n]*diff-reading live read[^\n]*literal PR argv/);

  assert.match(cursor, /bounded issue-comments snapshot|bounded.*snapshot/i);
  assert.match(cursor, /sticky_write_disposition/);
  assert.match(cursor, /sticky_write_exact_recipe/);
  assert.match(cursor, /Cursor[\s\S]{0,300}(?:MUST NOT|不得)[\s\S]{0,180}(?:marker|candidate|create\/update|action)/i);
  assert.doesNotMatch(cursor, /gh pr comment <PR#>/);
  assert.doesNotMatch(cursor, /repos\/\{owner\}\/\{repo\}/);
});

test("gh api sticky recipes use the validated repository in the endpoint without unsupported --repo", () => {
  const carriers = [
    ".devpro/agent-rules/code-review-cross-model.md",
    ".devpro/agent-rules/code-review-cross-model-dispatch-mechanics.md",
    ".devpro/agent-rules/platform-adapters/codex-host-cross-review.md",
    ".devpro/agent-rules/platform-adapters/claude-code-cross-review.md",
    ".devpro/agent-rules/platform-adapters/codex-host-cross-review-troubleshooting.md",
    "openspec/specs/openspec-flow/spec.md",
    "openspec/specs/cross-runtime-parity/spec.md",
    "openspec/changes/archive/2026-07-18-strengthen-control-plane-evidence/specs/openspec-flow/spec.md",
    "openspec/changes/archive/2026-07-18-strengthen-control-plane-evidence/specs/cross-runtime-parity/spec.md",
  ];

  for (const carrier of carriers) {
    assert.doesNotMatch(read(carrier), /`gh api[^`\n]*--repo\b/, `${carrier} must not pass --repo anywhere in a gh api command`);
  }
});

// The single-page `--json files` recipe is capped at 100 files; it must not come back.
const SINGLE_PAGE_FILES_RECIPE = /--json files\b/;

test("single-page files recipe marker catches the old recipe and spares valid fields", () => {
  assert.match("`gh pr view <pr> --json files,comments,headRefOid`", SINGLE_PAGE_FILES_RECIPE);
  assert.match("`gh pr view <pr> --json files`", SINGLE_PAGE_FILES_RECIPE);
  assert.doesNotMatch("`gh pr view <pr> --json comments,headRefOid,headRefName,baseRefName`", SINGLE_PAGE_FILES_RECIPE);
  assert.doesNotMatch("`gh pr view <pr> --json changedFiles`", SINGLE_PAGE_FILES_RECIPE);
});

test("release-step-1-7 touch-files recipe is paginated and count-checked, not the capped single page", () => {
  const body = read(".devpro/agent-rules/release-step-1-7.md");
  assert.doesNotMatch(body, SINGLE_PAGE_FILES_RECIPE);
  assert.match(body, /gh api 'repos\/\{owner\}\/\{repo\}\/pulls\/<n>\/files\?per_page=100' --paginate/);
  // zsh expands an unquoted `?` as a glob and fails before gh runs, so the unquoted form must not come back.
  assert.doesNotMatch(body, /gh api repos\/\{owner\}\/\{repo\}\/pulls\/<n>\/files\?/);
  assert.match(body, /MUST 等於 `gh pr view <n> --json changedFiles`，否則 fail closed/);
});

test("merge-gate dry-run probes document host surface for inner gh calls", () => {
  const codexHost = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  const flowSpec = read("openspec/specs/openspec-flow/spec.md");
  const paritySpec = read("openspec/specs/cross-runtime-parity/spec.md");

  for (const body of [codexHost, flowSpec, paritySpec]) {
    assert.match(body, /Merge gate dry-run|merge-gate dry-run|dry-run probes/i);
    assert.match(body, /checkCrossModelMergeGate/);
    assert.match(body, /spawnSync\("gh"|spawn `gh`|spawns `gh`|inner `gh`|內部會 `spawnSync/);
    assert.match(body, /non-sandbox \/ host runner surface|host\/non-sandbox|host runner/);
    assert.match(body, /api\.github\.com/);
    assert.match(body, /execution-surface fault/);
    assert.match(body, /direct `gh pr view`/);
    assert.doesNotMatch(body, SINGLE_PAGE_FILES_RECIPE);
    assert.match(body, /not (?:as )?stale|not sticky|不得判成 sticky|not stale sticky/i);
  }
});

test("focused sticky refresh is documented across rules and specs", () => {
  const crossModel =
    read(".devpro/agent-rules/code-review-cross-model.md") +
    "\n" +
    read(".devpro/agent-rules/code-review-cross-model-cli-contract.md");
  const codex = read(".devpro/agent-rules/platform-adapters/codex.md");
  const codexHost = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  const claude = read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md");
  const flowSpec = read("openspec/specs/openspec-flow/spec.md");
  const paritySpec = read("openspec/specs/cross-runtime-parity/spec.md");

  for (const [name, body] of [
    ["crossModel", crossModel],
    ["codex", codex],
    ["codexHost", codexHost],
    ["claude", claude],
    ["flowSpec", flowSpec],
    ["paritySpec", paritySpec],
  ]) {
    assertContains(body, /focused sticky-refresh/, `${name}: focused sticky-refresh`);
    assertContains(body, /stale `?verdict: PASS\|WARN`?|stale sticky with `verdict: PASS` or `verdict: WARN`|existing stale sticky with `verdict: PASS\|WARN`|stale `PASS\|WARN` sticky/, `${name}: stale PASS|WARN sticky`);
    assertContains(body, /narrow follow-up/, `${name}: narrow follow-up`);
    assertContains(body, /finding disposition/, `${name}: finding disposition`);
    assertContains(body, /test-only/, `${name}: test-only`);
    assertContains(body, /gate-evidence|gate evidence/, `${name}: gate evidence`);
    assertContains(body, /previous sticky\/verdict\/findings/, `${name}: previous sticky`);
    assertContains(body, /latest delta\/range/, `${name}: latest delta`);
    assertContains(body, /current head SHA/, `${name}: current head SHA`);
    assertContains(body, /current gate\/test evidence/, `${name}: gate evidence packet`);
    assertContains(body, /evaluate only (?:that )?delta|only.*delta|只評估 delta/, `${name}: delta-only review`);
    assertContains(body, /PATCH(?:es)? (?:the )?existing sticky|PATCH existing sticky/, `${name}: patch existing sticky`);
    assertContains(body, /focused packet (?:is )?insufficient|insufficient focused packets|focused packet 不足/, `${name}: focused insufficient fallback`);
    assertContains(body, /risk shape changed|changed risk shape|風險形狀改變/, `${name}: risk changed fallback`);
    assertContains(body, /same-shape broad rerun timeout\/error|同形狀 broad rerun timeout\/error/, `${name}: same-shape broad rerun timeout`);
    assertContains(body, /orchestration friction/, `${name}: orchestration friction`);
    assertContains(body, /not reviewer unavailable|不是.*reviewer unavailable|不得.*reviewer unavailable/, `${name}: not reviewer unavailable`);
  }
});

test("reverse Codex CLI reviewer path has focused sticky refresh parity", () => {
  const codex = read(".devpro/agent-rules/platform-adapters/codex.md");
  const paritySpec = read("openspec/specs/cross-runtime-parity/spec.md");

  for (const [name, body] of [
    ["codex", codex],
    ["paritySpec", paritySpec],
  ]) {
    assertContains(body, /Claude-host -> Codex CLI/, `${name}: reverse reviewer direction`);
    assertContains(body, /focused sticky-refresh/, `${name}: focused sticky-refresh`);
    assertContains(body, /PATCH(?:es)? (?:the )?existing sticky|PATCH existing sticky/, `${name}: patch existing sticky`);
    assertContains(body, /active adapter(?:'s| 的)? writer contract/, `${name}: active adapter writer contract`);
    assertContains(body, /orchestration friction/, `${name}: orchestration friction`);
    assertContains(body, /not reviewer unavailable|不得直接判 reviewer unavailable/, `${name}: not reviewer unavailable`);
  }
});
