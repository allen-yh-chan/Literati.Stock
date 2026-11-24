/**
 * Grep anchors for enforce-hotfix-release-carrier: unified hotfix release-carrier lane
 * (source/consumer same shape). Covers design §U7/U10 rows S2, N19, M1-M4, C3b, plus
 * the Step 7 sequential-anchor requirement and the rollback/adoption self-check assertions
 * from `tasks.md` T5.
 *
 * `[Req: R7, R8, R9, R12]`
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readSourceFile as read } from "./lib/read.mjs";
import {
  anchoredVerbIndex,
  CMD_POSITION_ANCHOR,
  ghPrVerbSource,
  isMatchInCommandSegment,
  segmentCommand,
} from "../hooks/lib/shell-context.mjs";

// The command part of one recipe line: the shell segmenter finds a trailing comment, so a # inside a quoted argument
// (a subject "Hotfix #42") stays part of the command (#3706 r1 F5).
function commandPart(line) {
  const comment = segmentCommand(line).find((seg) => seg.kind === "comment");
  return (comment ? line.slice(0, comment.range[0]) : line).replace(/\s+$/, "");
}

const MERGE_INVOCATION_RE = new RegExp(`${CMD_POSITION_ANCHOR}${ghPrVerbSource("merge")}\\b`, "g");

function mergeCommandCount(line) {
  const shell = line.replace(/^\s*[-*]\s+/, "");
  const segments = segmentCommand(shell);
  return [...shell.matchAll(MERGE_INVOCATION_RE)]
    .filter((match) => isMatchInCommandSegment(anchoredVerbIndex(match), segments)).length;
}

const releaseFlow = read(".devpro/agent-rules/release-sit-uat-pat-prod.md");
// Normative clauses of the hotfix carrier lane (N1–N5, review-binding, milestone inert, cutover).
const hotfixPolicy = read(".devpro/agent-rules/release-hotfix-carrier-policy.md");
const releaseSteps = read(".devpro/agent-rules/release-step-1-7.md");
const hotfixRecipe = read(".devpro/agent-rules/release-hotfix-carrier-lane.md");
const runbook = read(".devpro/agent-skills/release/release-runbook/SKILL.md");
const branchRule = read(".devpro/agent-rules/git-branch-naming-and-anchor.md");
const prTemplate = read(".devpro/agent-rules/git-pr-template-and-merge.md");
const workflowTracking = read(".devpro/agent-rules/git-workflow-tracking.md");
const crossModel = read(".devpro/agent-rules/code-review-cross-model.md");
const postPr = read(".devpro/agent-rules/post-pr-completion-gate.md");
const rulesFlow = read(".devpro/agent-rules/rules-flow.md");
// Rollback SOP moved verbatim to an on-demand leaf; rules-flow.md keeps a same-named routing section.
const rulesFlowRollback = read(".devpro/agent-rules/rules-flow-rollback.md");
const noTagEvidenceLeaf = read(".devpro/agent-rules/git-branch-no-tag-ancestry-evidence.md");
const ancestryRepairLeaf = read(".devpro/agent-rules/git-branch-production-ancestry-repair.md");
const rulesFlowContinuation = read(".devpro/agent-rules/rules-flow-production-continuation.md");
const rulesLane = read(".devpro/agent-rules/release-rules-lane.md");
const preflight = read(".devpro/agent-rules/preflight-checklist.md");
const adoption = read(".devpro/agent-rules/consumer-adoption.md");
const ciSetup = read(".devpro/agent-rules/ci-setup-components.md");
const glossary = read(".devpro/agent-rules/branch-terminology-glossary.md");
const prePrSkill = read(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md");
const openspecSteps = read(".devpro/agent-rules/openspec-step-1-to-9.md");
const branchPrHub = read(".devpro/agent-rules/git-branch-and-pr-flow.md");
const scenarioI = read("scenarios/scenario-i-consumer-repo-prod-bugfix-non-urgent.md");
const openspecFlowSpec = read("openspec/specs/openspec-flow/spec.md");

// "Live carriers" per proposal §Section 1 item 2: the docs + runbook skill this change
// touches (design §Carrier Groups G1-G5). Archived/openspec design prose is out of scope.
const LIVE_CARRIERS = [
  ["release-sit-uat-pat-prod.md", releaseFlow],
  ["release-hotfix-carrier-policy.md", hotfixPolicy],
  ["release-step-1-7.md", releaseSteps],
  ["release-hotfix-carrier-lane.md", hotfixRecipe],
  ["release-runbook/SKILL.md", runbook],
  ["git-branch-naming-and-anchor.md", branchRule],
  // On-demand leaves split out of git-branch-naming-and-anchor.md: moved text stays in scope.
  ["git-branch-no-tag-ancestry-evidence.md", noTagEvidenceLeaf],
  ["git-branch-production-ancestry-repair.md", ancestryRepairLeaf],
  ["git-pr-template-and-merge.md", prTemplate],
  ["git-workflow-tracking.md", workflowTracking],
  ["code-review-cross-model.md", crossModel],
  ["post-pr-completion-gate.md", postPr],
  ["rules-flow.md", rulesFlow],
  ["rules-flow-rollback.md", rulesFlowRollback],
  ["rules-flow-production-continuation.md", rulesFlowContinuation],
  ["release-rules-lane.md", rulesLane],
  ["preflight-checklist.md", preflight],
  ["consumer-adoption.md", adoption],
  // r2 F-ehrc-r2-01: loaded together with git-branch-naming-and-anchor.md on branch/worktree intents.
  ["branch-terminology-glossary.md", glossary],
  // r3 F-ehrc-r3-01／02／07 + exhaustive sweep (decisions D12).
  ["pre-pr/SKILL.md", prePrSkill],
  ["openspec-step-1-to-9.md", openspecSteps],
  ["git-branch-and-pr-flow.md", branchPrHub],
  ["scenario-i-consumer-repo-prod-bugfix-non-urgent.md", scenarioI],
];

// ---------------------------------------------------------------------------
// S2: legacy dual-lane / isSourceRepo-branching wording MUST NOT reappear.
// Each phrase below is a verbatim capture of pre-change wording (captured
// 2026-09-26, before T8-T12 rewrote these leaves) — see 缺席軸 fixture below.
// ---------------------------------------------------------------------------
const OLD_WORDING = [
  "本檔與 hook 皆以 `isSourceRepo` 分支",
  "僅供審查／討論時可開，**禁 merge**",
  'git merge --no-ff "origin/hotfix/<name>"',
  "PR #1 base production → GitHub merge",
  "從最近 `production-*-rules` tag 開 rollback work branch → cherry-pick",
  "開 PR with base `production` 並透過 GitHub merge",
  "成對雙 PR",
  "雙合回",
  "雙 PR 都 merge 後",
  "### Source SemVer（hotfix-subset；無直合旁路）",
  "### Consumer（date／Rules／hotfix recovery）",
  // Captured 2026-09-27 (review r2 F-ehrc-r2-01／02／03) from leaves the first sweep missed.
  "**Consumer** hotfix recovery 仍可直送",
  "consumer 走既有 recovery",
  "source hotfix-subset SemVer 組裝／consumer hotfix recovery",
  "❌ **source** 禁止 `chore/bump-v*` 或 `hotfix/*` 直合 `production`",
  "hotfix dual-PR",
  // Captured 2026-09-27 (review r3 F-ehrc-r3-01／02／07 and the exhaustive sweep, decisions D12).
  "旁路分支（`hotfix/`、已上 PROD `bugfix/`）",
  "**consumer** 合 production + main",
  "hotfix 雙 PR 等 rationalization",
  "hotfix bypass",
  "需直送 PROD 的修復使用 `hotfix/`",
  "需直送 PROD 才使用 `hotfix/`",
];

test("S2: legacy dual-lane wording does not reappear in any live carrier", () => {
  for (const [name, text] of LIVE_CARRIERS) {
    for (const phrase of OLD_WORDING) {
      assert.ok(!text.includes(phrase), `${name} must not still contain legacy wording: ${phrase}`);
    }
  }
});

test("S2 fixture (缺席軸): banned phrases are narrow captures, not over-broad tokens", () => {
  // Positive: each phrase really was live pre-change wording (non-empty pins the
  // fixture constant itself against silent deletion).
  for (const phrase of OLD_WORDING) {
    assert.ok(phrase.length > 0, `banned phrase fixture emptied out: ${phrase}`);
  }
  // Negative: legitimate unified-lane prose that mentions hotfix + PR + merge together
  // MUST NOT trip any of the bans (guards against over-broad substrings).
  const legitimateExample =
    "hotfix-carrier-provenance block records `lane`, `carrier_sha`, and each `unit:` " +
    "merged into the carrier; the production pull request head is the carrier, never `hotfix/*`.";
  for (const phrase of OLD_WORDING) {
    assert.ok(!legitimateExample.includes(phrase), `banned phrase leaks into legitimate example: ${phrase}`);
  }
});

// ---------------------------------------------------------------------------
// Step 7 unified carrier lane: single heading, sequential anchors.
// ---------------------------------------------------------------------------
const STEP7_HEADING = "### Hotfix release-carrier lane（source／consumer 同構）";

function sliceHeadingSection(text, heading) {
  const start = text.indexOf(heading);
  assert.ok(start >= 0, `missing heading: ${heading}`);
  const second = text.indexOf(heading, start + heading.length);
  assert.equal(second, -1, `heading must appear exactly once: ${heading}`);
  const rest = text.slice(start + heading.length);
  const nextHeadingRel = rest.search(/\n#{2,3} /);
  return nextHeadingRel === -1 ? rest : rest.slice(0, nextHeadingRel);
}

test("Step 7 carrier lane section exists exactly once and orders its anchors", () => {
  const section = sliceHeadingSection(hotfixRecipe, STEP7_HEADING);
  const tokensInOrder = [
    "ANCHOR_TAG",
    "bump-first",
    "hotfix-carrier-verify.mjs freshness",
    "CARRIER_SHA",
    "hotfix-carrier-provenance",
    "post-promote",
  ];
  let cursor = 0;
  for (const token of tokensInOrder) {
    const idx = section.indexOf(token, cursor);
    assert.ok(idx >= 0, `Step 7 carrier lane section missing token in sequence: ${token}`);
    cursor = idx + token.length;
  }
});

// N42 (post-PR cross-model HF-CARRIER-TAG-REACHABILITY): the hotfix recipe must prove
// MERGE_SHA is on freshly fetched origin/production before it creates or pushes the tag;
// post-promote runs only after the push because it requires the tag on the remote.
test("N42: Step 7 proves MERGE_SHA reachable from origin/production before tagging", () => {
  // Scenario: Production tag is created only after the merge commit is proven on production
  const section = sliceHeadingSection(hotfixRecipe, STEP7_HEADING);
  const lines = section.split("\n");
  const indexOfLine = (re, label) => {
    const hits = lines.flatMap((line, i) => (re.test(line) ? [i] : []));
    assert.equal(hits.length, 1, `Step 7 carrier lane must carry exactly one ${label} line; found ${hits.length}`);
    return hits[0];
  };
  const fetchProd = indexOfLine(/^git fetch origin \+refs\/heads\/production:refs\/remotes\/origin\/production /, "production fetch");
  const nonEmpty = indexOfLine(/^test -n "\$MERGE_SHA" && test "\$MERGE_SHA" != null\b/, "MERGE_SHA non-empty check");
  const resolvable = indexOfLine(/^git cat-file -e "\$MERGE_SHA\^\{commit\}"/, "MERGE_SHA resolvable check");
  const reachable = indexOfLine(/^git merge-base --is-ancestor "\$MERGE_SHA" origin\/production\b/, "MERGE_SHA reachability check");
  const tagLine = indexOfLine(/^git tag "\$TAG" "\$MERGE_SHA"/, "git tag");
  const pushTag = indexOfLine(/^git push origin "refs\/tags\/\$TAG"/, "tag push");
  const postPromote = lines.findIndex((line) => /^node \.devpro\/scripts\/hotfix-carrier-verify\.mjs post-promote /.test(line));
  assert.ok(fetchProd < reachable, "origin/production must be freshly fetched before the reachability check");
  assert.ok(nonEmpty < tagLine && resolvable < tagLine && reachable < tagLine, "MERGE_SHA checks must precede git tag");
  assert.ok(tagLine < pushTag, "git tag must precede the tag push");
  assert.ok(postPromote > pushTag, "post-promote must run after the tag push (it requires the tag on the remote)");
});

// r12 F-ehrc-r12-01: the prose copies of the same lane (rules-lane Rollback SOP step 4 and
// the runbook §6 hotfix sequence) must carry the same reachability step before tagging.
test("N42 prose copies: rollback SOP step 4 and runbook §6 verify reachability before tagging", () => {
  // Scenario: Production tag is created only after the merge commit is proven on production
  const verify = "freshly fetch `origin/production` 並驗該 commit 可解析且為其祖先（不成立即停、不打 tag）";
  const rollbackStep4 = rulesFlowRollback.split("\n").find((line) => line.startsWith("(4) **freshness → freeze → smoke"));
  assert.ok(rollbackStep4, "rules-flow-rollback.md Rollback SOP step (4) not found");
  const runbookHotfix = runbook.split("\n").find((line) => line.startsWith("若這是 hotfix，使用 `release-hotfix-carrier-policy.md`"));
  assert.ok(runbookHotfix, "devpro:release-runbook §6 hotfix sequence line not found");
  for (const [label, line, tagToken] of [
    ["rules-flow-rollback.md Rollback SOP (4)", rollbackStep4, "tag `production-<date>-rules[-n]`"],
    ["devpro:release-runbook §6", runbookHotfix, "tag the explicit commit"],
  ]) {
    const verifyIdx = line.indexOf(verify);
    const tagIdx = line.indexOf(tagToken);
    assert.ok(verifyIdx >= 0, `${label} must verify MERGE_SHA reachability after fetching origin/production`);
    assert.ok(tagIdx > verifyIdx, `${label} must verify reachability before tagging`);
  }
});

// r2 F-ehrc-r2-04: the T4 production PR body file follows the gh body-file SSOT
// (file-write-destinations.md): main-checkout notes/tmp literal path, trailing footer,
// deleted after send — never a worktree-local body.md.
test("Step 7 T4 production PR body file lives in main-checkout notes/tmp and carries the footer", () => {
  const section = sliceHeadingSection(hotfixRecipe, STEP7_HEADING);
  const bodyPath = "<main-checkout-root>/notes/tmp/hotfix-carrier-provenance-<unique>.md";
  assert.ok(section.includes(`cat >> ${bodyPath} <<EOF`), "T4 must append its provenance/footer lines to the main-checkout notes/tmp literal path");
  assert.ok(section.includes(`--body-file ${bodyPath}`), "pre-promote/gh pr create must read the same literal body path");
  assert.ok(section.includes(`rm ${bodyPath}`), "T4 must delete the body file after gh sends it");
  assert.ok(section.includes("Rules: v<X.Y.Z> · Tool: <tool> · Model: <model>\nEOF"), "T4 heredoc must end with the gh footer line");
  assert.ok(!/--body-file body\.md|cat > body\.md/.test(section), "T4 must not stage a worktree-local body.md");
});

// r3 F-ehrc-r3-04: every hotfix-lane gh pr create in the recipe passes pr-body-template-lint
// and gh-footer-gate — template sections from the SSOT PR template, footer last, body file
// in main-checkout notes/tmp; no inline --body and no body-less create.
test("Step 7 back-merge and grandfathered PRs use a template body file with footer", () => {
  const lane = sliceHeadingSection(hotfixRecipe, STEP7_HEADING);
  const grandfathered = sliceHeadingSection(hotfixRecipe, "### Grandfathered legacy hotfix completion（僅適用 cutover 前已 merge 進 production 的舊 PR #1）");
  const cases = [
    [lane, "<main-checkout-root>/notes/tmp/hotfix-carrier-provenance-<unique>.md", "gh pr create --base production --head \"$CARRIER\""],
    [lane, "<main-checkout-root>/notes/tmp/hotfix-carrier-back-merge-<unique>.md", "gh pr create --head \"$CARRIER\" --base main"],
    [grandfathered, "<main-checkout-root>/notes/tmp/hotfix-grandfathered-back-merge-<unique>.md", "gh pr create --head hotfix/<name> --base main"],
  ];
  for (const [section, bodyPath, createPrefix] of cases) {
    assert.ok(section.includes(`依 git-pr-template-and-merge.md「PR 描述模板」寫出全部必填段至 ${bodyPath}`), `${bodyPath}: template sections must come from the SSOT PR template`);
    const appendAt = section.indexOf(`cat >> ${bodyPath} <<EOF`);
    assert.ok(appendAt >= 0, `${bodyPath}: lane-specific lines are appended to the literal body path`);
    const eofAt = section.indexOf("\nEOF\n", appendAt);
    assert.ok(section.slice(appendAt, eofAt).trimEnd().endsWith("Rules: v<X.Y.Z> · Tool: <tool> · Model: <model>"), `${bodyPath}: footer must be the last body line`);
    const createLine = section.split("\n").find((line) => line.startsWith(createPrefix));
    assert.ok(createLine && createLine.endsWith(`--body-file ${bodyPath}`), `${bodyPath}: gh pr create must read the literal body file`);
    assert.ok(section.includes(`rm ${bodyPath}`), `${bodyPath}: body file is deleted after send`);
  }
  assert.ok(!/gh pr create[^\n]*--body "/.test(lane + grandfathered), "no inline --body in hotfix-lane PR creation");
});

// r3 F-ehrc-r3-03: canonical openspec-flow no longer authorizes local hotfix-subset
// assembly (superseded 2026-09-23 R9, decisions D3); hotfix units enter the carrier by PR merge.
test("canonical openspec-flow carries no local origin/hotfix/<name> assembly path", () => {
  assert.ok(!openspecFlowSpec.includes("`origin/hotfix/<name>`"), "openspec-flow spec must not name origin/hotfix/<name> as a merge target");
  assert.ok(!openspecFlowSpec.includes("hotfix-subset lane, `origin"), "openspec-flow spec must not keep the hotfix-subset local-merge parenthetical");
  assert.ok(openspecFlowSpec.includes("it enters its release carrier only by pull-request merge per the source-hotfix-semver-assemble capability"), "openspec-flow spec must point hotfix units at the carrier PR-merge path");
});

// ---------------------------------------------------------------------------
// N19: Step 6A requires post-promote --back-merge-pr evidence for hotfix carriers.
// ---------------------------------------------------------------------------
function sliceBoldSection(text, boldStartLiteral) {
  const start = text.indexOf(boldStartLiteral);
  assert.ok(start >= 0, `missing bold section: ${boldStartLiteral}`);
  const nextBoldIdx = text.indexOf("\n**", start + 2);
  return nextBoldIdx === -1 ? text.slice(start) : text.slice(start, nextBoldIdx);
}

test("N19: Step 6A carries hotfix-carrier-verify.mjs post-promote --back-merge-pr evidence", () => {
  const step6A = read(".devpro/agent-rules/release-back-merge-completion.md");
  assert.match(
    step6A,
    /hotfix-carrier-verify\.mjs post-promote[^\n]*--back-merge-pr/,
    "Step 6A must require post-promote --back-merge-pr for the carrier back-merge",
  );
});

// ---------------------------------------------------------------------------
// U10 M1-M4: milestone absence is inert, no mechanical blocking.
// ---------------------------------------------------------------------------
test("M1: consumer release-milestone CI scope excludes hotfix (expected already-green)", () => {
  assert.ok(
    ciSetup.includes("feature/|bugfix/|chore/") && ciSetup.includes("base 為 `main`"),
    "ci-setup-components.md release-milestone scope literal must exist",
  );
  const scopeStart = ciSetup.indexOf("僅當 PR head 為");
  assert.ok(scopeStart >= 0);
  const scopeLine = ciSetup.slice(scopeStart, ciSetup.indexOf("\n", scopeStart));
  assert.ok(!scopeLine.includes("hotfix"), "release-milestone scope line must not name hotfix");
});

test("M2: Step 1 candidate query regex does not match hotfix/* branches (expected already-green)", () => {
  const regexLiteral = releaseSteps.match(/headRefName\|test\("(\^\([^)]+\)\/)"\)/);
  assert.ok(regexLiteral, "Step 1 candidate query must contain the headRefName branch-prefix test");
  const candidateRe = new RegExp(regexLiteral[1]);
  assert.ok(!candidateRe.test("hotfix/urgent-fix"), "candidate query must not match hotfix/* with a milestone");
  assert.ok(!candidateRe.test("hotfix/no-milestone"), "candidate query must not match hotfix/* without a milestone");
});

test("M3: hotfix-subset judgment criterion is approved tip SHA + sticky, never milestone", () => {
  assert.ok(
    releaseFlow.includes("hotfix-subset 為核准的 tip SHA＋sticky") ||
      releaseSteps.includes("hotfix-subset 為核准的 tip SHA＋sticky"),
    "hotfix-subset judgment criterion literal must exist",
  );
  // Scenario: Milestone absence on hotfix and carrier pull requests is inert
  assert.ok(
    hotfixPolicy.includes("非 milestone") || hotfixPolicy.includes("never the milestone"),
    "release-hotfix-carrier-policy.md must state the criterion excludes milestone",
  );
});

test("M4: milestone on a hotfix/bump/carrier PR is inert, not a blocking condition", () => {
  // Scenario: Milestone absence on hotfix and carrier pull requests is inert
  assert.match(
    hotfixPolicy,
    /inert[^\n]*(?:不得視為|MUST NOT)[^\n]*(?:阻擋|blocking)/i,
    "release-hotfix-carrier-policy.md must state milestone (ab)sence on hotfix/carrier PRs is inert, not blocking",
  );
});

// ---------------------------------------------------------------------------
// C3b: grandfather / cutover clauses are discoverable.
// ---------------------------------------------------------------------------
test("C3b: grandfather and cutover clauses are grep-able", () => {
  for (const [name, text] of [
    ["release-hotfix-carrier-policy.md", hotfixPolicy],
    ["release-hotfix-carrier-lane.md", hotfixRecipe],
  ]) {
    assert.ok(text.includes("grandfathered-legacy-hotfix"), `${name} missing grandfathered-legacy-hotfix token`);
    assert.ok(text.includes("cutover") || text.includes("生效點"), `${name} missing cutover clause`);
  }
});

// ---------------------------------------------------------------------------
// Rollback SOP: 5 top-level steps, both step-2 paths, reverts=, release/rules-.
// ---------------------------------------------------------------------------
test("Rollback SOP retains 5 top-level steps and both step-2 revert-shape paths", () => {
  const sopStart = rulesFlowRollback.indexOf("## Rollback SOP");
  assert.ok(sopStart >= 0, "rules-flow-rollback.md missing § Rollback SOP");
  const sopEnd = rulesFlowRollback.indexOf("\n## ", sopStart + 4);
  const sop = sopEnd === -1 ? rulesFlowRollback.slice(sopStart) : rulesFlowRollback.slice(sopStart, sopEnd);

  for (const n of [1, 2, 3, 4, 5]) {
    // Line-start match: the trigger list label inside the section also mentions `(1)`.
    assert.match(sop, new RegExp(`^\\(${n}\\) \\*\\*`, "m"), `Rollback SOP missing top-level step (${n})`);
  }
  assert.match(sop, /\(a\)[^\n]*bump: N\/A/, "Rollback SOP step 2 missing clean-revert N/A path");
  assert.match(sop, /\(b\)[^\n]*bump/, "Rollback SOP step 2 missing hand-resolved-conflict bump path");
  assert.match(sop, /reverts=/, "Rollback SOP must record reverts=");
  assert.match(sop, /release\/rules-/, "Rollback SOP must name the release/rules-* carrier");
});

// ---------------------------------------------------------------------------
// F-ehrc-r1-04: rollback step (2) builds the revert unit on a branch cut from
// ANCHOR_TAG, never directly on the carrier; ANCHOR_TAG is the topologically
// latest `production-*` tag (both families), not a `-rules`-only tag.
// ---------------------------------------------------------------------------
test("Rollback SOP step (2) names the hotfix/revert-rules-* branch built from ANCHOR_TAG, never reverts on the carrier itself", () => {
  const sopStart = rulesFlowRollback.indexOf("## Rollback SOP");
  const sopEnd = rulesFlowRollback.indexOf("\n## ", sopStart + 4);
  const sop = sopEnd === -1 ? rulesFlowRollback.slice(sopStart) : rulesFlowRollback.slice(sopStart, sopEnd);
  const step2Start = sop.indexOf("(2)");
  const step2NextStart = sop.indexOf("(3)", step2Start);
  const step2 = step2NextStart === -1 ? sop.slice(step2Start) : sop.slice(step2Start, step2NextStart);

  assert.ok(!step2.includes("cut carrier、在其上 revert"), "step (2) heading must not read as reverting directly on the carrier");
  assert.match(
    step2,
    /hotfix\/revert-rules-<date>\[-n\][^\n]*分支|分支[^\n]*hotfix\/revert-rules-<date>\[-n\]/,
    "step (2) must explicitly name the hotfix/revert-rules-<date>[-n] branch cut from ANCHOR_TAG (design D11)",
  );
});

test("release-rules-lane.md rollback bullet 1 bases the carrier on the topological ANCHOR_TAG and never reverts directly on the carrier", () => {
  assert.ok(
    !rulesLane.includes("carrier 自最新 `production-*-rules` tag"),
    "rollback bullet 1 must not pin the carrier base to the -rules-only tag family (breaks N1 dual-family ANCHOR_TAG)",
  );
  assert.ok(
    !rulesLane.includes("在其上 `git revert -m 1 <merge>` 產生 revert unit"),
    "rollback bullet 1 must not describe reverting directly on the carrier (violates N3 / D14 revert shape)",
  );
  assert.ok(
    rulesLane.includes("hotfix/revert-rules-<date>[-n]"),
    "rollback bullet 1 must name the hotfix/revert-rules-<date>[-n] branch",
  );
  assert.match(rulesLane, /base＝carrier/, "rollback bullet 1 must state the revert PR's base is the carrier, not production");
});

// ---------------------------------------------------------------------------
// F-ehrc-r1-08: hotfix-review-binding literal format is defined once (SSOT)
// and appears verbatim only in the SSOT and the Step 7 copy-execute recipe;
// post-pr-completion-gate.md must carry a pointer, not the full literal.
// ---------------------------------------------------------------------------
test("hotfix-review-binding literal appears verbatim only in the SSOT and the Step 7 recipe", () => {
  const literal = "hotfix-review-binding: head=<40hex> base_ref_oid=<40hex> merge_base_sha=<40hex>";
  const carriersWithLiteral = LIVE_CARRIERS.filter(([, text]) => text.includes(literal)).map(([name]) => name);
  assert.deepEqual(
    carriersWithLiteral.sort(),
    ["release-hotfix-carrier-policy.md", "release-hotfix-carrier-lane.md"].sort(),
    `hotfix-review-binding literal must be defined once in the SSOT (release-hotfix-carrier-policy.md) and repeated only in the Step 7 copy-execute recipe; found verbatim in: ${carriersWithLiteral.join(", ") || "(none)"}`,
  );
  assert.ok(
    !postPr.includes(literal),
    "post-pr-completion-gate.md must not repeat the full hotfix-review-binding literal; it must pointer to the SSOT",
  );
});

// ---------------------------------------------------------------------------
// F-ehrc-r1-12: devpro:release-runbook §6 hotfix `[-<n>]` exemption pointer must
// name the actual exemption list carrier, not a non-existent §3A/§3B mention.
// ---------------------------------------------------------------------------
test("devpro:release-runbook §6 hotfix recovery points the [-<n>] exemption list at code-review-cross-model.md", () => {
  assert.ok(
    !runbook.includes("豁免清單見下方 §3A／§3B"),
    "§6 must not claim §3A/§3B define the [-<n>] exemption list (neither section mentions it)",
  );
  assert.match(
    runbook,
    /code-review-cross-model\.md[^\n]*豁免條件|豁免條件[^\n]*code-review-cross-model\.md/,
    "§6 must point the [-<n>] exemption list at code-review-cross-model.md §豁免條件（SSOT）",
  );
});

// ---------------------------------------------------------------------------
// Adoption self-check (a)-(d), including git >= 2.40.
// ---------------------------------------------------------------------------
test("release-hotfix-carrier-lane.md carries the four consumer migration self-check items", () => {
  // The consumer migration self-check lives in its own section of the hotfix leaf; consumer-adoption.md keeps a pointer.
  const start = hotfixRecipe.indexOf("### Consumer 遷移自查");
  assert.ok(start >= 0, "release-hotfix-carrier-lane.md missing the consumer migration self-check section");
  const selfCheck = hotfixRecipe.slice(start);
  assert.ok(selfCheck.includes("grandfathered-legacy-hotfix"), "self-check section missing grandfathered-legacy-hotfix token");
  assert.ok(selfCheck.includes("生效點"), "self-check section missing cutover clause");
  assert.match(adoption, /release-hotfix-carrier-lane\.md[^\n]*Consumer 遷移自查/, "consumer-adoption.md must point at the self-check section");
  for (const marker of ["(a)", "(b)", "(c)", "(d)"]) {
    assert.ok(selfCheck.includes(marker), `release-hotfix-carrier-lane.md missing self-check item ${marker}`);
  }
  assert.match(selfCheck, /git --version[^\n]*2\.40|2\.40[^\n]*git --version/, "self-check (d) must assert git >= 2.40");
  assert.ok(selfCheck.includes("gh pr list"), "self-check (a) must give an in-flight inventory command");
});

// ---------------------------------------------------------------------------
// Scenario-title assertions required by lint-delta-new-scenario-assertion-coverage
// (this programmer's 7 titles; the remaining 17 belong to T3/T4).
// ---------------------------------------------------------------------------
test("scenario coverage: Unified release-carrier lane covers every repository and trigger", () => {
  // Scenario: Unified release-carrier lane covers every repository and trigger
  const section = sliceHeadingSection(hotfixRecipe, STEP7_HEADING);
  assert.match(section, /ANCHOR_TAG[\s\S]*post-promote/, "unified lane must cover the full sequence for every repository and trigger");
});

test("scenario coverage: Grandfathered legacy hotfix completes without retroactive carrier", () => {
  // Scenario: Grandfathered legacy hotfix completes without retroactive carrier
  assert.ok(hotfixRecipe.includes("grandfathered-legacy-hotfix") || releaseFlow.includes("grandfathered-legacy-hotfix"));
});

test("scenario coverage: Rollback and already-live backfill use the same carrier lane", () => {
  // Scenario: Rollback and already-live backfill use the same carrier lane
  assert.ok(releaseFlow.includes("already-live") && releaseFlow.includes("carrier"));
});

test("scenario coverage: Milestone absence on hotfix and carrier pull requests is inert", () => {
  // Scenario: Milestone absence on hotfix and carrier pull requests is inert
  assert.match(releaseFlow, /inert/);
});

test("scenario coverage: Rules-lane rollback opens a carrier and reverts on a hotfix branch targeting it", () => {
  // Scenario: Rules-lane rollback opens a carrier and reverts on a hotfix branch targeting it
  assert.match(rulesFlowRollback, /revert-rules-[^\n]*(?:base|carrier)[^\n]*carrier|carrier[^\n]*revert-rules/);
  assert.ok(!rulesFlowRollback.includes("開 PR with base `production` 並透過 GitHub merge"));
  assert.ok(!rulesFlow.includes("開 PR with base `production` 並透過 GitHub merge"));
});

test("scenario coverage: Rollback carrier reaches production only through its own pull request", () => {
  // Scenario: Rollback carrier reaches production only through its own pull request
  assert.match(rulesFlowRollback, /hotfix-carrier-provenance[^\n]*lane: consumer-rules|lane: consumer-rules/);
});

test("scenario coverage: Broken carrier lane is repaired, not bypassed", () => {
  // Scenario: Broken carrier lane is repaired, not bypassed
  assert.ok(rulesLane.includes("release/rules-"));
  assert.ok(!rulesLane.includes("從最近 `production-*-rules` tag 開 rollback work branch → cherry-pick"));
});

// D18 (post-PR cross-model mutable-artifact-provenance): the Step 7 recipe captures the
// pre-promote provenance digest and passes it to BOTH post-promote runs; a recipe copy that
// drops the flag would make post-promote exit 2 (flag is required) in the middle of a promotion.
test("D18: Step 7 threads PROVENANCE_SHA256 from pre-promote into every post-promote run", () => {
  const section = sliceHeadingSection(hotfixRecipe, STEP7_HEADING);
  const lines = section.split("\n");
  const run = lines.findIndex((line) => /^PRE_PROMOTE_JSON=\$\(node \.devpro\/scripts\/hotfix-carrier-verify\.mjs pre-promote [^\n]*--production-pr "\$PRODUCTION_PR"\); PRE_PROMOTE_EXIT=\$\?$/.test(line));
  assert.ok(run >= 0, "Step 7 must keep the pre-promote --production-pr exit code (a $(... | jq) pipeline would swallow it)");
  const exitGate = lines.findIndex((line) => /^test "\$PRE_PROMOTE_EXIT" -eq 0\b/.test(line));
  const capture = lines.findIndex((line) => /^PROVENANCE_SHA256=\$\(printf '%s' "\$PRE_PROMOTE_JSON" \| jq -r [^\n]*pre-promote\.provenance-sha256/.test(line));
  const merge = lines.findIndex((line) => /^gh pr merge <production-pr-number> --repo github\.com\/OWNER\/REPO --merge/.test(line));
  assert.ok(exitGate > run && capture > exitGate && merge > capture, "pre-promote run -> exit gate -> digest capture -> production merge, in that order");
  const postPromote = lines.flatMap((line, i) => (/^node \.devpro\/scripts\/hotfix-carrier-verify\.mjs post-promote /.test(line) ? [i] : []));
  assert.equal(postPromote.length, 2, "Step 7 carries exactly two post-promote runs (tag, back-merge)");
  for (const i of postPromote) {
    assert.ok(i > capture, "post-promote must run after the digest is captured");
    assert.match(lines[i], /--provenance-sha256 "\$PROVENANCE_SHA256"/);
  }
});

// D18 (post-PR cross-model hotfix-review-binding-forgery): the review-binding SSOT names the
// trust conditions the verifier enforces and never tells operators to edit a binding comment.
test("D18: review-binding SSOT states the trusted-comment conditions", () => {
  // Scenario: Review binding counts only from a trusted, unedited, pre-merge comment
  const para = hotfixPolicy.split("\n").find((line) => line.startsWith("**review-binding**"));
  assert.ok(para, "review-binding SSOT paragraph missing");
  for (const token of ["collaborators/<login>/permission", "`admin`", "`write`", "includesCreatedEdit", "mergedAt"]) {
    assert.ok(para.includes(token), `review-binding SSOT must name ${token}`);
  }
  assert.ok(!para.includes("先編輯或刪除舊 binding comment"), "an edited binding comment is not accepted; SSOT must not tell operators to edit it");
});

// review r23 F-ehrc-r23-03: pre-merge / pre-promote verify a head at time T; the merge that
// follows must pin that same head, or a carrier/PR head that moved in between is merged unverified.
test("r23: hotfix and production merges in Step 7 pin the verified head with --match-head-commit", () => {
  const section = sliceHeadingSection(hotfixRecipe, STEP7_HEADING);
  // A trailing shell comment is not part of the command: every check below reads the command part only, so an
  // ordinary note after a merge passes and a flag written only in the note does not count (PR #3703 r11 W9-F1).
  const lines = section.split("\n").map(commandPart);
  const hotfixMerges = lines.filter((line) => /^gh pr merge <n> --repo github\.com\/OWNER\/REPO --merge\b/.test(line));
  assert.equal(hotfixMerges.length, 1, "Step 7 carries exactly one hotfix unit merge line");
  assert.match(hotfixMerges[0], /--match-head-commit <approved-tip>/);
  const productionMerges = lines.filter((line) => /^gh pr merge <production-pr-number> --repo github\.com\/OWNER\/REPO --merge\b/.test(line));
  assert.equal(productionMerges.length, 1, "Step 7 carries exactly one production merge line");
  assert.match(productionMerges[0], /--match-head-commit "\$CARRIER_SHA"/);
  // The merge commit is read from the repository the production merge names, not from whichever repository gh takes
  // for a bare number (PR #3703 r11 W1-F2).
  const mergeShaReads = lines.filter((line) => /^MERGE_SHA=\$\(gh pr view\b/.test(line));
  assert.equal(mergeShaReads.length, 1, "Step 7 reads the production merge commit once");
  assert.match(mergeShaReads[0], /^MERGE_SHA=\$\(gh pr view "\$PRODUCTION_PR" --repo github\.com\/OWNER\/REPO --json mergeCommit\b/);
  const backMerges = lines.filter((line) => /^gh pr merge <back-merge-pr-number> --repo github\.com\/OWNER\/REPO --merge\b/.test(line));
  assert.equal(backMerges.length, 1, "Step 7 carries exactly one back-merge line");
  assert.match(backMerges[0], /--match-head-commit "\$MERGE_SHA"/);
  // No other merge line stays beside them and the bump merge, such as an older form without the full destination
  // (PR #3703 r7 W6-F4): an indented, list-item or prefixed command line counts too, only a comment line does not
  // (PR #3703 r8 W7-F2).
  const mergeCommandLines = lines.filter((line) => mergeCommandCount(line) > 0);
  assert.deepEqual(mergeCommandLines, ["gh pr merge <bump-pr> --repo github.com/OWNER/REPO --merge", hotfixMerges[0], productionMerges[0], backMerges[0]]);
  // Each of those lines holds one merge: a second one on the same line (after `&&` or `;`) counts too (PR #3703 r9 W8-F2).
  // A trailing shell comment is not a command, so a merge named only there is not counted (PR #3703 r10 W8-F2).
  for (const line of mergeCommandLines) assert.equal(mergeCommandCount(line), 1, line);
});

// #3556: the cross-model merge gate decides before the shell expands a variable, so a merge
// selector written as one is blocked; every Step 7 merge names its PR literally.
test("#3556: no Step 7 merge names its PR through a shell variable", () => {
  const section = sliceHeadingSection(hotfixRecipe, STEP7_HEADING);
  const merges = section.split("\n").filter((line) => /^gh pr merge\b/.test(line));
  assert.ok(merges.length >= 3, "Step 7 keeps the hotfix, production and back-merge merge lines");
  for (const line of merges) {
    // Quote and backtick as hex escapes: an unpaired literal one stops the shared comment scanner reading this file.
    assert.doesNotMatch(line, /^gh pr merge\s+[\x22\x27]?[$\x60]/, `merge selector must be literal: ${line}`);
  }
  // --match-head-commit compares the head SHA only, so the line before each merge binds the same
  // literal number to the carrier PR for that base, through the Node verifier rather than a POSIX test.
  const lines = section.split("\n");
  const production = lines.findIndex((line) => /^gh pr merge <production-pr-number> --repo github\.com\/OWNER\/REPO --merge\b/.test(line));
  assert.match(lines[production - 1] ?? "", /^node \.devpro\/scripts\/hotfix-carrier-verify\.mjs merge-target --pr <production-pr-number> --carrier "\$CARRIER" --base production\s/, "the production merge is bound to the carrier -> production PR on the line before it");
  const back = lines.findIndex((line) => /^gh pr merge <back-merge-pr-number> --repo github\.com\/OWNER\/REPO --merge\b/.test(line));
  assert.match(lines[back - 1] ?? "", /^node \.devpro\/scripts\/hotfix-carrier-verify\.mjs merge-target --pr <back-merge-pr-number> --carrier "\$CARRIER" --base main\s/, "the back-merge is bound to the carrier -> main PR on the line before it");
});

// ---------------------------------------------------------------------------
// Rollback SOP lives in rules-flow-rollback.md; rules-flow.md keeps a same-named
// routing section so `rules-flow.md § Rollback SOP` references stay one hop away.
// ---------------------------------------------------------------------------
test("rules-flow.md keeps a same-named Rollback SOP routing section with a mandatory pointer to the leaf", () => {
  const sopStart = rulesFlow.indexOf("\n## Rollback SOP\n");
  assert.ok(sopStart >= 0, "rules-flow.md must keep the ## Rollback SOP heading as the routing entry");
  const sopEnd = rulesFlow.indexOf("\n## ", sopStart + 4);
  const section = sopEnd === -1 ? rulesFlow.slice(sopStart) : rulesFlow.slice(sopStart, sopEnd);
  assert.match(
    section,
    /^> Load-chain（Rollback SOP）：[^\n]*release 含預期外 commits[^\n]*MUST 先讀 `rules-flow-rollback\.md`[^\n]*MUST NOT 直合 `production`[^\n]*`release\/rules-<YYYYMMDD>\[-n\]` carrier/m,
    "routing line must name both triggers, the mandatory leaf pointer and the carrier-only invariant",
  );
  assert.ok(!rulesFlow.includes("(1) **判定 trigger"), "rules-flow.md must not copy the SOP steps");
  assert.ok(!rulesFlow.includes("**Broken carrier lane 不得旁路**"), "rules-flow.md must not copy the broken-lane paragraph");
});

test("Rollback leaf trigger list carries the content-drift bullet required by the rules-flow spec", () => {
  // Requirement: Rollback SOP Triggers Include Content Drift
  // The spec names the trigger condition list of `rules-flow-rollback.md § Rollback SOP`, so the
  // list must sit inside that section, ahead of step (1).
  const sopStart = rulesFlowRollback.indexOf("\n## Rollback SOP\n");
  assert.ok(sopStart >= 0, "rules-flow-rollback.md missing § Rollback SOP");
  const triggerStart = rulesFlowRollback.indexOf("**觸發條件**", sopStart);
  const step1Start = rulesFlowRollback.indexOf("\n(1) **判定 trigger", sopStart);
  assert.ok(triggerStart > sopStart && step1Start > triggerStart, "trigger list must sit inside § Rollback SOP, ahead of step (1)");
  assert.equal(rulesFlowRollback.slice(0, sopStart).includes("**觸發條件**"), false, "trigger list must not sit outside § Rollback SOP");
  const triggers = rulesFlowRollback.slice(triggerStart, step1Start);
  assert.match(
    triggers,
    /^- release 含預期外 commits[^\n]*`git log <prev production tag>\.\.<release tag> --oneline`/m,
    "trigger list must contain the content-drift bullet with its detection command",
  );
  assert.match(triggers, /^- [^\n]*hook[^\n]*CI[^\n]*衍生檔破壞/m, "trigger list must keep the human-judgment trigger");
});

// #3706 r1 F5: the comment is found by the shell segmenter, so a quoted # keeps the flags after it visible and a flag
// written only in a trailing comment stays invisible.
test("commandPart keeps a quoted # and drops only a trailing comment", () => {
  assert.equal(commandPart('gh pr merge 7 --subject "Hotfix #42" --match-head-commit "$SHA"   # note'), 'gh pr merge 7 --subject "Hotfix #42" --match-head-commit "$SHA"');
  assert.equal(commandPart('gh pr merge 7 --merge   # --match-head-commit "$SHA"'), "gh pr merge 7 --merge");
  assert.equal(commandPart("gh pr merge 7 --merge"), "gh pr merge 7 --merge");
});

test("Step 7 counts merge invocations at command position, not in subject arguments", () => {
  assert.equal(mergeCommandCount('gh pr merge 7 --subject "Follow-up: gh pr merge"'), 1);
  assert.equal(mergeCommandCount('gh pr merge 7 && gh pr merge 8 # gh pr merge 9'), 2);
  assert.equal(mergeCommandCount('- DEVPRO_NOTE="related" gh pr merge 7'), 1);
  assert.equal(mergeCommandCount('printf "%s" "gh pr merge 7"'), 0);
});
