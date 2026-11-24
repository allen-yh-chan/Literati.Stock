import { modelProbeTestEnv } from "./lib/model-probe-fixture.mjs";
import "./lib/portable-command-shims.cjs";
import { test } from "node:test";
import { resolveNativeExecutableOnPath } from "./lib/resolve-native-executable.mjs";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { REPO_ROOT } from "./lib/repo-root.mjs";
import { deriveMainCheckoutNotesTmp } from "../second-reviewer-cli-recipe-contract.mjs";
import { deriveChangeNameFromBranch } from "../lib/derive-change-name-from-branch.mjs";
import { CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES, CONSUMER_SECOND_REVIEW_RULES_REL } from "../lib/consumer-second-review-rules.mjs";
import { deriveAuthoritativeChangedSet, canonicalEmbeddedReviewMaterialProof, SECOND_REVIEW_EMBEDDED_MAX_BYTES, SECOND_REVIEW_CANONICAL_REPOSITORY_ROOT } from "../second-review-material-contract.mjs";
import {
  assertNotLiveWrite,
  clearOwnedCanonicalCache,
  ownedCarrierRootFor,
  prepareOwnedCanonicalRenderer,
} from "./lib/owned-canonical-carrier.mjs";
import { expectedNodeModeBits } from "./lib/expected-node-mode-bits.mjs";

// Keep renderer integration tests off the host Claude CLI; a host without it would otherwise fail effort selection.
process.env.DEVPRO_ALLOW_CLAUDE_EFFORT_STUB ??= "1";
process.env.DEVPRO_SECOND_REVIEW_CLAUDE_EFFORT_STUB ??= "xhigh";

const here = path.dirname(fileURLToPath(import.meta.url));
const builderPath = path.resolve(here, "../build-pr-sticky-handoff.mjs");
const keyOrder = JSON.parse(readFileSync(path.join(here, "fixtures/pr-sticky-handoff-key-order.json"), "utf8"));
const contractFixture = JSON.parse(readFileSync(path.join(here, "fixtures/pr-sticky-handoff-contract.json"), "utf8"));
const implemented = existsSync(builderPath);

// This first assertion is the deliberate T1 RED: the missing producer contract is
// the reason for failure; the test module and both tracked fixtures load normally.
test("Builder contract: a producer entry point exists before renderer handoff acceptance", async () => {
  assert.equal(implemented, true, "builder contract requires .devpro/scripts/build-pr-sticky-handoff.mjs");
  const builder = await import(pathToFileURL(builderPath));
  assert.equal(typeof builder.selectReviewerFamily, "function", "builder contract exports reviewer-family selection");
});

const assertBuilderPresent = () => assert.equal(implemented, true, "builder contract requires .devpro/scripts/build-pr-sticky-handoff.mjs");

test("Both runtimes expose the same user inputs and precedence", async () => {
  assertBuilderPresent();
  const { selectReviewerFamily } = await import(pathToFileURL(builderPath));
  const skill = readFileSync(path.resolve(REPO_ROOT, ".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md"), "utf8");
  const rule = readFileSync(path.resolve(REPO_ROOT, ".devpro/agent-rules/code-review-cross-model.md"), "utf8");
  const invocation = "node .devpro/scripts/build-pr-sticky-handoff.mjs <PR#> (--change <name> | --branch <branch>) --carrier-root <main-checkout-root>/notes/cross-review --primary-family <host-family> [--preferred-reviewer <family>]";
  for (const entrypoint of [skill, rule]) {
    assert.ok(entrypoint.includes(invocation));
    assert.ok(entrypoint.includes("Reviewer precedence is non-empty `$CROSS_MODEL_REVIEWER`, then the `--preferred-reviewer` value preselected by `/devpro:change`, then the different-family default"));
    assert.ok(entrypoint.includes("The active host alone injects the trusted `--primary-family` alias; do not ask the user to select it"));
    assert.ok(entrypoint.includes('rm -- "$HANDOFF_JSON"'));
  }
  assert.ok(skill.includes("The Codex adapter injects `codex`; the Claude Code adapter injects `claude`"));
  const sectionStart = rule.indexOf("### Initial handoff builder");
  const sectionEnd = rule.indexOf("\n### ", sectionStart + 1);
  assert.notEqual(sectionStart, -1, "shared rule must contain the initial builder contract");
  const sharedBuilderSection = rule.slice(sectionStart, sectionEnd === -1 ? undefined : sectionEnd);
  assert.doesNotMatch(sharedBuilderSection, /\bClaude\b|\bCodex\b/);
  // The builder refusal／boundary notes moved verbatim to the dispatch-mechanics sibling; they stay host-neutral.
  const mechanics = readFileSync(path.resolve(REPO_ROOT, ".devpro/agent-rules/code-review-cross-model-dispatch-mechanics.md"), "utf8");
  const mechanicsBuilderSections = mechanics.split("\n### ").filter((section) => section.startsWith("Initial handoff builder："));
  assert.equal(mechanicsBuilderSections.length, 2, "dispatch-mechanics sibling carries both moved builder sections");
  for (const section of mechanicsBuilderSections) assert.doesNotMatch(section, /\bClaude\b|\bCodex\b/);
  assert.equal(selectReviewerFamily({ primaryFamily: "codex" }), "claude");
  assert.equal(selectReviewerFamily({ primaryFamily: "claude" }), "codex");
  assert.throws(() => selectReviewerFamily({ primaryFamily: "codex", preferredReviewer: "codex" }), /same.family/i);
  assert.equal(selectReviewerFamily({ primaryFamily: "codex", envReviewer: "claude", preferredReviewer: "codex" }), "claude");
  assert.throws(() => selectReviewerFamily({ primaryFamily: "claude", envReviewer: "claude" }), /same.family/i);
  assert.throws(() => selectReviewerFamily({ primaryFamily: "codex", envReviewer: "codex" }), /same.family/i);
  assert.throws(() => selectReviewerFamily({ primaryFamily: "unsupported" }), /primary.family/i);
  assert.equal(selectReviewerFamily({ primaryFamily: "claude", preferredReviewer: "deepseek" }), "deepseek");
  assert.equal(selectReviewerFamily({ primaryFamily: "codex", envReviewer: "deepseek" }), "deepseek");
  assert.throws(() => selectReviewerFamily({ primaryFamily: "claude", envReviewer: "gemini" }), /reviewer family must be/);
  assert.throws(() => selectReviewerFamily({ primaryFamily: "claude", preferredReviewer: "opencode" }), /deepseek \(the OpenCode CLI\)/);
});

test("The OpenCode family is selectable by name on the builder command line", async () => {
  assertBuilderPresent();
  const { parseBuilderArgs } = await import(pathToFileURL(builderPath));
  const base = ["3431", "--branch", "bugfix/example", "--carrier-root", "/carrier", "--primary-family", "claude"];
  assert.equal(parseBuilderArgs([...base, "--preferred-reviewer", "deepseek"]).preferredReviewer, "deepseek");
  assert.throws(() => parseBuilderArgs([...base, "--preferred-reviewer", "gemini"]), /--preferred-reviewer must be/);
});

test("A deepseek primary can build a handoff and defaults to a different family", async () => {
  assertBuilderPresent();
  const { parseBuilderArgs, selectReviewerFamily } = await import(pathToFileURL(builderPath));
  const base = ["3431", "--branch", "bugfix/example", "--carrier-root", "/carrier"];
  assert.equal(parseBuilderArgs([...base, "--primary-family", "deepseek"]).primaryFamily, "deepseek");
  assert.equal(selectReviewerFamily({ primaryFamily: "deepseek" }), "codex", "the default reviewer must not be the primary family");
  assert.equal(selectReviewerFamily({ primaryFamily: "deepseek", preferredReviewer: "claude" }), "claude");
  assert.throws(() => selectReviewerFamily({ primaryFamily: "deepseek", preferredReviewer: "deepseek" }), /same-family/);
  assert.equal(
    selectReviewerFamily({ primaryFamily: "deepseek", preferredReviewer: "deepseek", allowSameFamily: "codex and claude CLIs are rate limited" }),
    "deepseek",
    "an explicit same-family fallback authorization reaches the OpenCode CLI family",
  );
  assert.throws(
    () => selectReviewerFamily({ primaryFamily: "deepseek", preferredReviewer: "claude", allowSameFamily: "no other provider available" }),
    /--allow-same-family applies only when/,
    "the flag is not a general-purpose escape hatch",
  );
  assert.equal(parseBuilderArgs([...base, "--primary-family", "unknown"]).primaryFamily, "unknown", "the documented unproven-host path must stay reachable");
  assert.equal(selectReviewerFamily({ primaryFamily: "unknown" }), "codex");
  assert.throws(() => parseBuilderArgs([...base, "--primary-family", "gemini"]), /--primary-family must be/);
});

test("--allow-same-family requires a change-specific why and owns the retry classification", async () => {
  assertBuilderPresent();
  const { parseBuilderArgs } = await import(pathToFileURL(builderPath));
  const base = ["3431", "--branch", "bugfix/example", "--carrier-root", "/carrier", "--primary-family", "deepseek", "--preferred-reviewer", "deepseek", "--external-evaluator", "OpenCode", "--lite"];
  assert.throws(() => parseBuilderArgs([...base, "--allow-same-family", "short"]), /at least 10 characters/);
  assert.throws(
    () => parseBuilderArgs([...base, "--allow-same-family", "different-family reviewer unavailable; same-family fallback authorized"]),
    /generic placeholder/,
  );
  for (const reserved of [
    "quota exhausted; Rules: v7.7.2",
    "quota exhausted; Tool: Codex",
    "quota exhausted; Model: gpt",
    "quota exhausted; <!-- cross-model-second-opinion:sticky -->",
    "quota exhausted\nsecond line",
  ]) {
    assert.throws(
      () => parseBuilderArgs([...base, "--allow-same-family", reserved]),
      /reserved sticky literal/,
      `reserved literal must be rejected: ${JSON.stringify(reserved)}`,
    );
  }
  assert.throws(
    () => parseBuilderArgs([
      ...base,
      "--allow-same-family", "codex and claude CLIs are rate limited",
      "--retry-classification", "same_family_fallback:other",
    ]),
    /cannot be combined with --retry-classification/,
  );
  // Lowercase tokens are not the reserved footer literals: they must pass.
  assert.equal(
    parseBuilderArgs([...base, "--allow-same-family", "quota note: rules: see chat, tool: internal"]).allowSameFamily,
    "quota note: rules: see chat, tool: internal",
  );
  // The retry path carries the same disclosure into the sticky reason.
  for (const reservedRetry of [
    "quota exhausted; Rules: v7.7.2",
    "quota exhausted; Tool: Codex",
    "quota exhausted; Model: gpt",
    "quota exhausted; <!-- cross-model-second-opinion:sticky -->",
    "quota exhausted\rsecond carriage-return line",
  ]) {
    assert.throws(
      () => parseBuilderArgs([
        "3431", "--branch", "bugfix/example", "--carrier-root", "/carrier", "--primary-family", "deepseek",
        "--attempt", "fault-recovery",
        "--retry-classification", "same_family_fallback:codex-cli-unavailable",
        "--retry-sticky-verification", reservedRetry,
      ]),
      /--retry-sticky-verification must not contain the reserved sticky literal/,
      `retry reserved literal must be rejected: ${JSON.stringify(reservedRetry)}`,
    );
  }
  const parsed = parseBuilderArgs([...base, "--allow-same-family", "codex and claude CLIs are rate limited"]);
  assert.equal(parsed.allowSameFamily, "codex and claude CLIs are rate limited");
  assert.equal(parsed.retryContext.classification, "same_family_fallback:codex and claude CLIs are rate limited");
  assert.equal(parsed.retryContext.sticky_verification, "codex and claude CLIs are rate limited");
});

test("The builder carries the attempt and retry_context, so a fault re-dispatch needs no hand-edited JSON", async () => {
  assertBuilderPresent();
  const { parseBuilderArgs } = await import(pathToFileURL(builderPath));
  const base = ["3431", "--branch", "bugfix/example", "--carrier-root", "/carrier", "--primary-family", "claude"];

  const initial = parseBuilderArgs(base);
  assert.equal(initial.attempt, "initial");
  assert.deepEqual(initial.retryContext, { classification: "none", sticky_verification: "not-needed" });

  const refresh = parseBuilderArgs([...base, "--attempt", "focused-sticky-refresh"]);
  assert.equal(refresh.attempt, "focused-sticky-refresh");

  const fault = parseBuilderArgs([
    ...base,
    "--attempt", "fault-recovery",
    "--retry-classification", "reviewer_completion_contract_invalid",
    "--retry-sticky-verification", "skipped",
  ]);
  assert.equal(fault.attempt, "fault-recovery");
  assert.deepEqual(Object.keys(fault.retryContext), ["classification", "sticky_verification"]);
  assert.deepEqual(fault.retryContext, { classification: "reviewer_completion_contract_invalid", sticky_verification: "skipped" });

  assert.throws(() => parseBuilderArgs([...base, "--attempt", "retry"]), /--attempt must be/);
  assert.throws(
    () => parseBuilderArgs([...base, "--attempt", "fault-recovery"]),
    (error) => error.classification === "invalid_retry_context" && /--retry-classification/.test(error.message),
    "a fault re-dispatch must name the fault and the sticky-verification state, not inherit the initial defaults"
  );
  assert.throws(
    () => parseBuilderArgs([...base, "--retry-classification", "reviewer_projection_fault"]),
    (error) => error.classification === "invalid_retry_context" && /non-initial attempt/.test(error.message),
    "retry fields on an initial attempt would be dead input"
  );
  assert.throws(
    () => parseBuilderArgs([...base, "--attempt", "focused-sticky-refresh", "--retry-sticky-verification", "skipped"]),
    (error) => error.classification === "invalid_retry_context" && /provided together/.test(error.message),
    "a half-filled retry_context would silently inherit the other default"
  );
});

test("Selector and renderer roots are uniquely bound using isolated roots", async () => {
  assertBuilderPresent();
  const { assertCanonicalCarrierRoot } = await import(pathToFileURL(builderPath));
  const temp = mkdtempSync(path.join(tmpdir(), "builder-root-alias-"));
  const rendererFixture = path.join(temp, "renderer-fixture");
  const rendererPath = path.resolve(here, "../render-second-review-packet.mjs");
  let prepared;
  try {
    const fakeRepo = path.join(temp, "repo");
    mkdirSync(fakeRepo);
    execFileSync("git", ["init", "-q"], { cwd: fakeRepo });
    const expected = path.join(fakeRepo, "notes", "cross-review");
    mkdirSync(expected, { recursive: true });
    const alias = path.join(temp, "canonical-link");
    symlinkSync(expected, alias, "dir");
    for (const candidate of [expected, `${expected}${path.sep}`, alias]) {
      assert.equal(assertCanonicalCarrierRoot(candidate, fakeRepo), candidate);
    }
    assert.throws(() => assertCanonicalCarrierRoot(temp, fakeRepo), /canonical carrier root/i);
    mkdirSync(rendererFixture);
    prepared = prepareOwnedCanonicalRenderer({ fixtureDir: rendererFixture, repoRoot: REPO_ROOT, rendererPath, ownedCarrierRoot: expected });
    assert.equal(prepared.carrierRootArg, expected, "the renderer and builder must receive the identical canonical carrier-root value");
    assertNotLiveWrite(prepared.mutatedRendererPath, prepared.carrierRootArg, path.join(path.dirname(deriveMainCheckoutNotesTmp(REPO_ROOT)), "cross-review"), rendererPath);
    const isolatedRenderer = await import(pathToFileURL(prepared.mutatedRendererPath).href);
    mkdirSync(path.join(temp, "control"), { recursive: true });
    const previousControlDir = process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR;
    const previousStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR = path.join(temp, "control");
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = path.join(temp, "state");
    try {
      assert.deepEqual(Object.keys(contractFixture), keyOrder);
      // The builder accepts the canonical root, its trailing-separator form and a symlink alias (asserted
      // above); the renderer must accept each of the same forms as --carrier-root, not only the bare one.
      for (const [formIndex, carrierRootForm] of [prepared.carrierRootArg, `${prepared.carrierRootArg}${path.sep}`, alias].entries()) {
        for (const [primary, reviewer] of [["openai-codex", "claude"], ["claude", "codex"]]) {
          const packet = isolatedRenderer.renderSecondReviewPacket({ ...contractFixture, primary_family: primary, reviewer_family: reviewer }, {
            carrierRootValue: carrierRootForm,
            env: {
              ...process.env,
              DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(temp, `control-${formIndex}-${primary}`),
              DEVPRO_POST_PR_COMPLETION_STATE_DIR: path.join(temp, `state-${formIndex}-${primary}`),
            },
          });
          assert.ok(packet, `renderer must accept carrier-root form #${formIndex} for ${primary} -> ${reviewer}`);
        }
      }
    } finally {
      if (previousControlDir === undefined) delete process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR;
      else process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR = previousControlDir;
      if (previousStateDir === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
      else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previousStateDir;
    }
  } finally {
    if (prepared) clearOwnedCanonicalCache(rendererFixture);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("Proposal is read from the PR head commit, not the worktree, and needs no approval ledger", async () => {
  assert.equal(implemented, true, "head-pinned proposal selection behavior is missing");
  const { readProposalAtHead } = await import(pathToFileURL(builderPath));
  const temp = mkdtempSync(path.join(tmpdir(), "proposal-head-bind-"));
  const git = (...args) => execFileSync("git", args, { cwd: temp, encoding: "utf8" }).trim();
  const headProposalPath = "openspec/changes/head-version/proposal.md";
  const headProposal = ["## Section 1: Target State (Done When)", "", "- HEAD-ONLY done when marker", "", "## Section 2: Notes", "head_evidence_marker: head-only", ""].join("\n");
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Synthetic Test");
    mkdirSync(path.dirname(path.join(temp, headProposalPath)), { recursive: true });
    writeFileSync(path.join(temp, headProposalPath), headProposal);
    git("add", headProposalPath);
    git("commit", "-qm", "synthetic PR head");
    const headSha = git("rev-parse", "HEAD");
    writeFileSync(path.join(temp, headProposalPath), headProposal.replace("head-only", "worktree-only").replace("HEAD-ONLY done when marker", "WORKTREE-ONLY done when marker"));
    mkdirSync(path.join(temp, "openspec/changes/worktree-decoy"), { recursive: true });
    writeFileSync(path.join(temp, "openspec/changes/worktree-decoy/proposal.md"), "worktree-only candidate");
    const result = readProposalAtHead({ repoRoot: temp, headSha, changeName: "head-version" });
    assert.equal(result.path, headProposalPath);
    assert.match(result.content, /head-only/);
    assert.doesNotMatch(result.content, /worktree-only/);
    assert.deepEqual(result.doneWhen, ["HEAD-ONLY done when marker"]);
    assert.equal(Object.hasOwn(result, "approvalEvidence"), false, "the proposal result carries no approval evidence");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("Builder reads a B-mini proposal-mini.md: done_when comes from its Target State", async () => {
  assert.equal(implemented, true, "head-pinned proposal selection behavior is missing");
  const { readProposalAtHead } = await import(pathToFileURL(builderPath));
  const temp = mkdtempSync(path.join(tmpdir(), "proposal-mini-head-bind-"));
  const git = (...args) => execFileSync("git", args, { cwd: temp, encoding: "utf8" }).trim();
  const miniPath = "openspec/changes/mini-version/proposal-mini.md";
  const mini = ["## Why", "", "synthetic", "", "## Target State", "", "- MINI done when one", "- MINI done when two", ""].join("\n");
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Synthetic Test");
    mkdirSync(path.dirname(path.join(temp, miniPath)), { recursive: true });
    writeFileSync(path.join(temp, miniPath), mini);
    git("add", miniPath);
    git("commit", "-qm", "synthetic B-mini PR head");
    const headSha = git("rev-parse", "HEAD");
    const result = readProposalAtHead({ repoRoot: temp, headSha, changeName: "mini-version" });
    assert.equal(result.path, miniPath);
    assert.deepEqual(result.doneWhen, ["MINI done when one", "MINI done when two"]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("Builder CLI binds a safe PR selector and rejects malformed arguments", async () => {
  assert.equal(implemented, true, "builder CLI grammar behavior is missing");
  const { parseBuilderArgs } = await import(pathToFileURL(builderPath));
  const valid = parseBuilderArgs(["4123", "--change", "synthetic-handoff-contract", "--carrier-root", "/tmp/carrier", "--primary-family", "codex"]);
  assert.equal(valid.prNumber, 4123);
  assert.equal(valid.primaryFamily, "codex");
  for (const argv of [
    ["0", "--change", "x", "--carrier-root", "/tmp/c", "--primary-family", "codex"],
    ["9007199254740992", "--change", "x", "--carrier-root", "/tmp/c", "--primary-family", "codex"],
    ["1.2", "--change", "x", "--carrier-root", "/tmp/c", "--primary-family", "codex"],
    ["1", "--change", "", "--carrier-root", "/tmp/c", "--primary-family", "codex"],
    ["1", "--change", "x", "--branch", "feature/x", "--carrier-root", "/tmp/c", "--primary-family", "codex"],
    ["1", "--change", "x", "--carrier-root", "/tmp/c", "--primary-family", "codex", "--wat"],
    ["1", "--change", "x", "--change", "x", "--carrier-root", "/tmp/c", "--primary-family", "codex"],
    ["1", "--change", "x", "--carrier-root", "/tmp/c"],
  ]) assert.throws(() => parseBuilderArgs(argv), /PR|selector|argument|family|flag|carrier|requires/i);
});

test("Live PR metadata uses gh-supported fields and proves same-repository binding", async () => {
  assert.equal(implemented, true, "live PR metadata binding behavior is missing");
  const { readPrMetadata } = await import(pathToFileURL(builderPath));
  const repositorySlug = "devpro-tw/devpro-agent-rules";
  const headSha = "a".repeat(40);
  const calls = [];
  const responses = [
    JSON.stringify({ nameWithOwner: repositorySlug }),
    JSON.stringify({
      number: 2894,
      headRefName: "feature/add-pr-sticky-handoff-builder",
      headRefOid: headSha,
      baseRefOid: "b".repeat(40),
      isCrossRepository: false,
      headRepository: { name: "devpro-agent-rules", nameWithOwner: repositorySlug },
      headRepositoryOwner: { login: "devpro-tw" },
      body: "approved PR body",
      title: "feature title",
      url: "https://github.com/devpro-tw/devpro-agent-rules/pull/2894",
      state: "OPEN",
      closingIssuesReferences: [{ number: 12, repository: { name: "devpro-agent-rules", owner: { login: "devpro-tw" } } }],
    }),
  ];
  const runImpl = (command, args) => {
    calls.push({ command, args });
    return responses.shift();
  };

  const result = readPrMetadata(2894, null, { runImpl });
  assert.equal(result.repository_slug, repositorySlug);
  assert.equal(result.head_sha, headSha);
  assert.equal(result.head_branch, "feature/add-pr-sticky-handoff-builder");
  assert.deepEqual(calls[0], { command: "gh", args: ["repo", "view", "--json", "nameWithOwner"] });
  assert.deepEqual(calls[1], {
    command: "gh",
    args: ["pr", "view", "2894", "--repo", repositorySlug, "--json", "number,headRefName,headRefOid,isCrossRepository,headRepository,headRepositoryOwner,body,title,url,state,baseRefOid,closingIssuesReferences"],
  });
  assert.equal(result.title, "feature title");
  assert.equal(result.closing_issue_count, 1, "GitHub's own closing references are counted for the linked-issue marker");

  const ownerNameResponses = [
    JSON.stringify({ nameWithOwner: repositorySlug }),
    JSON.stringify({
      number: 2894, headRefName: "feature/add-pr-sticky-handoff-builder", headRefOid: headSha,
      isCrossRepository: false, headRepository: { name: "devpro-agent-rules" },
      headRepositoryOwner: { login: "devpro-tw" }, body: "approved PR body",
    }),
  ];
  assert.equal(readPrMetadata(2894, null, { runImpl: () => ownerNameResponses.shift() }).repository_slug, repositorySlug,
    "owner/name metadata must bind the same-repository head when nameWithOwner is unavailable");

  const crossRepositoryResponses = [
    JSON.stringify({ nameWithOwner: repositorySlug }),
    JSON.stringify({
      number: 2894,
      headRefName: "feature/add-pr-sticky-handoff-builder",
      headRefOid: headSha,
      isCrossRepository: true,
      headRepository: { nameWithOwner: "contributor/fork" },
      body: "approved PR body",
    }),
  ];
  assert.throws(() => readPrMetadata(2894, null, { runImpl: (_command, _args) => crossRepositoryResponses.shift() }), /PR head must be in this repository/i);
  const contradictoryResponses = [
    JSON.stringify({ nameWithOwner: repositorySlug }),
    JSON.stringify({
      number: 2894, headRefName: "feature/add-pr-sticky-handoff-builder", headRefOid: headSha,
      isCrossRepository: false, headRepository: { name: "forked-repo", nameWithOwner: repositorySlug },
      headRepositoryOwner: { login: "contributor" }, body: "approved PR body",
    }),
  ];
  assert.throws(() => readPrMetadata(2894, null, { runImpl: (_command, _args) => contradictoryResponses.shift() }), /PR head must be in this repository/i);
  const invalidHeadRepositoryCases = [
    { label: "owner without name", headRepository: {}, headRepositoryOwner: { login: "devpro-tw" } },
    { label: "name without owner", headRepository: { name: "devpro-agent-rules" } },
    { label: "null owner login", headRepository: { name: "devpro-agent-rules" }, headRepositoryOwner: { login: null } },
    { label: "malformed nameWithOwner", headRepository: { nameWithOwner: "not-a-valid-repository-slug" } },
  ];
  for (const { label, ...headRepositoryMetadata } of invalidHeadRepositoryCases) {
    const responsesForInvalidShape = [
      JSON.stringify({ nameWithOwner: repositorySlug }),
      JSON.stringify({
        number: 2894,
        headRefName: "feature/add-pr-sticky-handoff-builder",
        headRefOid: headSha,
        isCrossRepository: false,
        body: "approved PR body",
        ...headRepositoryMetadata,
      }),
    ];
    assert.throws(
      () => readPrMetadata(2894, null, { runImpl: (_command, _args) => responsesForInvalidShape.shift() }),
      (error) => error?.classification === "pr_repository_mismatch",
      label,
    );
  }
});

test("PR metadata drift prevents output", async () => {
  assert.equal(implemented, true, "PR metadata stability check behavior is missing");
  const { assertPrMetadataStable } = await import(pathToFileURL(builderPath));
  const metadata = { number: 4123, repository_slug: "synthetic/example", head_branch: "feature/synthetic", head_sha: "a".repeat(40), body: "same body" };
  assert.doesNotThrow(() => assertPrMetadataStable(metadata, { ...metadata }));
  for (const changed of ["number", "repository_slug", "head_branch", "head_sha", "body"]) {
    assert.throws(() => assertPrMetadataStable(metadata, { ...metadata, [changed]: `${metadata[changed]}-changed` }), /metadata drift/i, changed);
  }
});

test("Diff, paths, and proof share one authoritative source", async () => {
  assert.equal(implemented, true, "canonical review material handoff behavior is missing");
  const { buildEmbeddedReviewMaterial } = await import(pathToFileURL(builderPath));
  const scope = { kind: "full-pr", pull_request_number: 4123, head_sha: "a".repeat(40) };
  const rawDiff = ["diff --git a/docs/guide.md b/docs/guide.md", "--- a/docs/guide.md", "+++ b/docs/guide.md", "@@ -1 +1 @@", "-old guide", "+clear guide", ""].join("\n");
  const expected = deriveAuthoritativeChangedSet(scope, {
    repositorySlug: "synthetic/example",
    spawnSyncImpl(command, args) {
      if (command === "git" && args[0] === "rev-parse") return { status: 0, stdout: `${SECOND_REVIEW_CANONICAL_REPOSITORY_ROOT}\n` };
      if (command === "gh") return { status: 0, stdout: JSON.stringify({ baseRefOid: "b".repeat(40), headRefOid: scope.head_sha }) };
      if (command === "git" && args[0] === "merge-base") return { status: 0, stdout: Buffer.from(`${"b".repeat(40)}\n`) };
      if (command === "git" && args.includes("--name-status")) return { status: 0, stdout: Buffer.from("M\0docs/guide.md\0") };
      if (command === "git" && args[0] === "diff") return { status: 0, stdout: Buffer.from(rawDiff) };
      return { status: 1, stdout: Buffer.alloc(0) };
    },
  });
  const result = buildEmbeddedReviewMaterial(scope, { repositorySlug: "synthetic/example", derive: () => expected });
  assert.equal(result.review_material, expected.raw_diff);
  assert.deepEqual(result.changed_files_or_touch_list, expected.paths);
  assert.deepEqual(result.review_material_proof, canonicalEmbeddedReviewMaterialProof(scope, expected.raw_diff));
});

test("Codex material remains embedded through paged rendering", async () => {
  assert.equal(implemented, true, "embedded material and paged renderer route behavior is missing");
  const { buildEmbeddedReviewMaterial } = await import(pathToFileURL(builderPath));
  const longDiff = contractFixture.review_material + ("+synthetic changed line\n").repeat(Math.ceil(SECOND_REVIEW_EMBEDDED_MAX_BYTES / 23));
  const scope = contractFixture.review_scope;
  const material = {
    review_material: longDiff,
    changed_files_or_touch_list: contractFixture.changed_files_or_touch_list,
    review_material_proof: canonicalEmbeddedReviewMaterialProof(scope, longDiff),
  };
  const temp = mkdtempSync(path.join(tmpdir(), "paged-render-stubs-"));
  const bin = path.join(temp, "bin"); mkdirSync(bin);
  const realGit = resolveNativeExecutableOnPath("git");
  writeFileSync(path.join(bin, "git"), `#!/usr/bin/env node\nconst {spawnSync}=require("node:child_process"); const a=process.argv.slice(2); if(a.join(" ")==="rev-parse --show-toplevel") process.stdout.write(${JSON.stringify(`${SECOND_REVIEW_CANONICAL_REPOSITORY_ROOT}\n`)}); else if(a[0]==="merge-base") process.stdout.write(${JSON.stringify(`${"b".repeat(40)}\n`)}); else if(a[0]==="diff"&&a.includes("--name-status")) process.stdout.write(Buffer.from("M\\0docs/guide.md\\0")); else if(a[0]==="diff") process.stdout.write(Buffer.from(${JSON.stringify(Buffer.from(longDiff).toString("base64"))},"base64")); else {const r=spawnSync(${JSON.stringify(realGit)},a,{stdio:"inherit"});process.exit(r.status||0);}` , { mode: 0o700 });
  writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({baseRefOid:${JSON.stringify("b".repeat(40))},headRefOid:${JSON.stringify(scope.head_sha)}}));`, { mode: 0o700 });
  const oldPath = process.env.PATH;
  const previousControlDir = process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR;
  const previousStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  try {
    process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
    const rendererPath = path.resolve(here, "../render-second-review-packet.mjs");
    const carrierRoot = ownedCarrierRootFor(temp);
    const prepared = prepareOwnedCanonicalRenderer({ fixtureDir: temp, repoRoot: REPO_ROOT, rendererPath, ownedCarrierRoot: carrierRoot });
    assertNotLiveWrite(prepared.mutatedRendererPath, prepared.carrierRootArg, path.join(path.dirname(deriveMainCheckoutNotesTmp(REPO_ROOT)), "cross-review"), rendererPath);
    const isolatedRenderer = await import(pathToFileURL(prepared.mutatedRendererPath).href);
    process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR = path.join(temp, "control");
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = path.join(temp, "state");
    for (const [primary, reviewer] of [["openai-codex", "claude"], ["claude", "codex"]]) {
      const handoff = { ...contractFixture, ...material, primary_family: primary, reviewer_family: reviewer, page_window_max_pages: 1 };
      const packet = isolatedRenderer.renderSecondReviewPacket(handoff, { carrierRootValue: prepared.carrierRootArg, env: { ...process.env, DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(temp, "control"), DEVPRO_POST_PR_COMPLETION_STATE_DIR: path.join(temp, "state") }, livePatchProbe: () => { throw new Error("must not use adapter-live-pr-reads"); } });
      assert.match(packet, /devpro-second-review-data\/v5/);
      assert.equal(handoff.review_material_carrier, "embedded-diff");
      assert.equal(handoff.review_material_capability, "scope-bound-embedded-complete-diff-v1");
    }
  } finally {
    process.env.PATH = oldPath;
    if (previousControlDir === undefined) delete process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR;
    else process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR = previousControlDir;
    if (previousStateDir === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previousStateDir;
    clearOwnedCanonicalCache(temp);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("Initial handoff binds evidence, snapshot, and material and refuses metadata drift before output", async () => {
  const { assertCanonicalCarrierRoot, buildPrStickyHandoff } = await import(pathToFileURL(builderPath));
  const proposalName = `synthetic-${Date.now()}`;
  const proposalPath = `openspec/changes/${proposalName}/proposal.md`;
  const proposalDirectory = `${path.posix.dirname(proposalPath)}/`;
  const headSha = "c".repeat(40);
  const branch = `feature/${proposalName}`;
  const proposal = { path: proposalPath, content: "head proposal blob", doneWhen: ["head state is carried"] };
  const body = ["## Change Context", "", "Clarify the synthetic\tbehavior", "Purpose: verify head-bound handoff", "", "## OpenSpec", "", `- change: \`${proposalDirectory}\``, "", "## Requirement Ledger Completion", "", "The author reports strict validation passed.", "", "## Test Evidence", "", "The author reports focused tests passed.", ""].join("\n");
  const rawDiff = contractFixture.review_material;
  const prNumber = 50000000 + Math.floor(Math.random() * 1000000);
  const temp = mkdtempSync(path.join(tmpdir(), "builder-handoff-root-"));
  const fakeRepo = path.join(temp, "repo");
  mkdirSync(fakeRepo);
  execFileSync("git", ["init", "-q"], { cwd: fakeRepo });
  const root = path.join(fakeRepo, "notes", "cross-review");
  mkdirSync(root, { recursive: true });
  const deps = (drift, badSnapshot = false, malformedComment = false, prBody = body) => {
    let read = 0;
    const metadata = { number: prNumber, repository_slug: "synthetic/example", head_branch: branch, head_sha: headSha, body: prBody };
    return {
      readPrMetadata: (requestedNumber) => { read += 1; const current = { ...metadata, number: requestedNumber }; return read === 2 && drift ? { ...current, body: `${body}changed` } : current; },
      readProposalAtHead: () => proposal,
      readConsumerSecondReviewRules: () => "",
      buildEmbeddedReviewMaterial: (scope) => ({ changed_files_or_touch_list: ["docs/guide.md"], review_material: rawDiff, review_material_proof: canonicalEmbeddedReviewMaterialProof(scope, rawDiff) }),
      liveStickyAuthoritySnapshot: ({ pr_number }) => ({ repository_slug: "synthetic/example", pr_number, completeness: { status: badSnapshot ? "failed" : "complete", pagination_exhausted: !badSnapshot, pages_fetched: 2 }, query_error: null, comments: malformedComment ? [{}] : [{ id: 9, body: "original synthetic comment", html_url: `https://github.com/synthetic/example/pull/${pr_number}#issuecomment-9`, node_id: "IC_kwDOsynthetic", updated_at: "2026-06-01T00:00:00Z" }] }),
      assertCanonicalCarrierRoot: (candidate, repoRoot) => {
        assert.equal(candidate, root);
        assert.equal(repoRoot, REPO_ROOT);
        return assertCanonicalCarrierRoot(candidate, fakeRepo);
      },
    };
  };
  const before = readdirSync(root).filter((name) => name.startsWith(`handoff-pr-${prNumber}-`));
  let outputPath;
  try {
    outputPath = await buildPrStickyHandoff({ argv: [String(prNumber), "--change", proposalName, "--carrier-root", root], primaryFamily: "codex", dependencies: deps(false) });
    const output = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(output.approval_context, "none");
    assert.deepEqual(output.approval_resolution, { status: "not-required" });
    assert.equal(output.change_name, proposalName);
    assert.doesNotMatch(JSON.stringify([output.approval_context, output.approval_resolution, output.done_when]), /worktree-only/i);
    assert.equal(output.primary_family, "openai-codex");
    assert.equal(output.reviewer_family, "claude");
    assert.equal(output.scope_summary, "Clarify the synthetic behavior Purpose: verify head-bound handoff");
    assert.doesNotMatch(output.scope_summary, /[\u0000-\u001f\u007f]/);
    assert.deepEqual(output.done_when, ["head state is carried"]);
    assert.equal(output.review_material, rawDiff);
    assert.equal(output.sticky_authority_snapshot.comments[0].body, "original synthetic comment");
    assert.equal((statSync(outputPath).mode & 0o777), expectedNodeModeBits(0o600));
    assert.equal(output.attempt, "initial");
    assert.deepEqual(output.retry_context, { classification: "none", sticky_verification: "not-needed" });
    const faultPath = await buildPrStickyHandoff({
      argv: [
        String(prNumber + 5), "--change", proposalName, "--carrier-root", root,
        "--attempt", "fault-recovery",
        "--retry-classification", "reviewer_completion_contract_invalid",
        "--retry-sticky-verification", "skipped",
      ],
      primaryFamily: "codex",
      dependencies: deps(false),
    });
    try {
      const fault = JSON.parse(readFileSync(faultPath, "utf8"));
      assert.equal(fault.attempt, "fault-recovery");
      assert.deepEqual(fault.retry_context, { classification: "reviewer_completion_contract_invalid", sticky_verification: "skipped" });
      assert.deepEqual(Object.keys(fault), Object.keys(output), "attempt/retry_context must not change the handoff key set");
    } finally {
      unlinkSync(faultPath);
    }
    const deepseekPath = await buildPrStickyHandoff({
      argv: [String(prNumber + 6), "--change", proposalName, "--carrier-root", root],
      primaryFamily: "deepseek",
      dependencies: deps(false),
    });
    try {
      const deepseek = JSON.parse(readFileSync(deepseekPath, "utf8"));
      assert.equal(deepseek.primary_family, "deepseek");
      assert.equal(deepseek.reviewer_family, "codex");
      assert.deepEqual(Object.keys(deepseek), Object.keys(output), "a deepseek primary must not change the handoff key set");
    } finally {
      unlinkSync(deepseekPath);
    }
    const unprovenPath = await buildPrStickyHandoff({
      argv: [String(prNumber + 7), "--change", proposalName, "--carrier-root", root],
      primaryFamily: "unknown",
      dependencies: deps(false),
    });
    try {
      const unproven = JSON.parse(readFileSync(unprovenPath, "utf8"));
      assert.equal(unproven.primary_family, "unknown");
      assert.equal(unproven.reviewer_family, "codex");
      assert.deepEqual(Object.keys(unproven), Object.keys(output), "an unknown primary must not change the handoff key set");
    } finally {
      unlinkSync(unprovenPath);
    }
    await assert.rejects(buildPrStickyHandoff({ argv: [String(prNumber + 1), "--change", proposalName, "--carrier-root", root], primaryFamily: "codex", dependencies: deps(true) }), /metadata drift/i);
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(`handoff-pr-${prNumber + 1}-`)), []);
    await assert.rejects(buildPrStickyHandoff({ argv: [String(prNumber + 2), "--change", proposalName, "--carrier-root", root], primaryFamily: "codex", dependencies: deps(false, true) }), /sticky comments snapshot is incomplete/i);
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(`handoff-pr-${prNumber + 2}-`)), []);
    await assert.rejects(buildPrStickyHandoff({ argv: [String(prNumber + 3), "--change", proposalName, "--carrier-root", root], primaryFamily: "codex", dependencies: deps(false, false, true) }), /sticky comments snapshot is incomplete/i);
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(`handoff-pr-${prNumber + 3}-`)), []);
    for (const [index, control] of ["\u0000", "\u007f"].entries()) {
      const invalidPrNumber = prNumber + 4 + index;
      const invalidBody = body.replace("Clarify the synthetic\tbehavior", `Clarify the synthetic${control}behavior`);
      await assert.rejects(buildPrStickyHandoff({ argv: [String(invalidPrNumber), "--change", proposalName, "--carrier-root", root], primaryFamily: "codex", dependencies: deps(false, false, false, invalidBody) }), /unsupported control characters/i);
      assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(`handoff-pr-${invalidPrNumber}-`)), []);
    }
  } finally { if (outputPath) unlinkSync(outputPath); rmSync(temp, { recursive: true, force: true }); }
});

test("Handoff output is ordered, exclusive, canonical JSON, and mode 0600", async () => {
  const { writeAtomicHandoff } = await import(pathToFileURL(builderPath));
  const root = mkdtempSync(path.join(tmpdir(), "handoff-output-"));
  try {
    const output = writeAtomicHandoff(root, 4123, contractFixture);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(output, "utf8"))), keyOrder);
    assert.equal(readFileSync(output, "utf8").endsWith("}\n"), true);
    assert.equal((statSync(output).mode & 0o777), expectedNodeModeBits(0o600));
    assert.equal(writeAtomicHandoff(root, 4123, contractFixture), output, "identical content reuses the same path");
    const changed = writeAtomicHandoff(root, 4123, { ...contractFixture, scope_summary: "Different synthetic content" });
    assert.notEqual(changed, output, "different content gets a distinct content-addressed path");
    assert.equal((statSync(changed).mode & 0o777), expectedNodeModeBits(0o600));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Handoff output refuses an existing content-addressed file that differs in content, or in mode on POSIX", async () => {
  const { writeAtomicHandoff } = await import(pathToFileURL(builderPath));
  const root = mkdtempSync(path.join(tmpdir(), "handoff-collision-"));
  try {
    const output = writeAtomicHandoff(root, 4123, contractFixture);
    const original = readFileSync(output, "utf8");
    // Windows has no POSIX mode bits to compare, so only the content half applies there.
    if (process.platform !== "win32") {
      chmodSync(output, 0o644);
      assert.throws(() => writeAtomicHandoff(root, 4123, contractFixture), { classification: "handoff_output_collision" });
      chmodSync(output, 0o600);
    }
    writeFileSync(output, `${original} `);
    assert.throws(() => writeAtomicHandoff(root, 4123, contractFixture), { classification: "handoff_output_collision" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Builder pre-checks the renderer length limits and names field, size and limit", async () => {
  const builder = await import(pathToFileURL(builderPath));
  const validator = await import(pathToFileURL(path.resolve(here, "../validate-second-review-packet.mjs")));
  assert.equal(typeof builder.assertHandoffWithinRendererLimits, "function", "builder must export the pre-check");
  // Single source: the builder reads the validator's limits, it does not keep its own copy.
  assert.deepEqual(builder.RENDERER_HANDOFF_LIMITS, {
    scopeSummaryMaxBytes: validator.SCOPE_SUMMARY_MAX_BYTES,
    doneWhenMaxItems: validator.DONE_WHEN_MAX_ITEMS,
    doneWhenItemMaxBytes: validator.DONE_WHEN_ITEM_MAX_BYTES,
  });
  const { scopeSummaryMaxBytes, doneWhenMaxItems, doneWhenItemMaxBytes } = builder.RENDERER_HANDOFF_LIMITS;
  // Boundaries pass: UTF-8 bytes (not characters) are what is counted.
  builder.assertHandoffWithinRendererLimits({ scopeSummary: "a".repeat(scopeSummaryMaxBytes), doneWhen: Array.from({ length: doneWhenMaxItems }, () => "b".repeat(doneWhenItemMaxBytes)) });
  const cjkOver = "漢".repeat(Math.floor(scopeSummaryMaxBytes / 3) + 1);
  assert.ok(cjkOver.length < scopeSummaryMaxBytes && Buffer.byteLength(cjkOver, "utf8") > scopeSummaryMaxBytes);
  const expectLimit = (input, pattern) => {
    let caught;
    try { builder.assertHandoffWithinRendererLimits(input); } catch (error) { caught = error; }
    assert.ok(caught, "over-limit input must be refused");
    assert.equal(caught.classification, "handoff_limit_exceeded");
    assert.match(caught.message, pattern);
  };
  expectLimit({ scopeSummary: "a".repeat(scopeSummaryMaxBytes + 1), doneWhen: ["ok"] }, /scope_summary is 4097 UTF-8 bytes; renderer limit is 4096/);
  expectLimit({ scopeSummary: cjkOver, doneWhen: ["ok"] }, /scope_summary is \d+ UTF-8 bytes; renderer limit is 4096.*Change Context/);
  expectLimit({ scopeSummary: "ok", doneWhen: Array.from({ length: doneWhenMaxItems + 1 }, () => "x") }, /done_when has 33 items; renderer limit is 32/);
  expectLimit({ scopeSummary: "ok", doneWhen: ["x", "y".repeat(doneWhenItemMaxBytes + 1)] }, /done_when\[1\] is 1025 UTF-8 bytes; renderer limit is 1024/);
});

test("Builder and validator share the scope_summary boundary", async () => {
  const builder = await import(pathToFileURL(builderPath));
  const validator = await import(pathToFileURL(path.resolve(here, "../validate-second-review-packet.mjs")));
  assert.equal(validator.SCOPE_SUMMARY_MAX_BYTES, 4096);
  assert.equal(builder.RENDERER_HANDOFF_LIMITS.scopeSummaryMaxBytes, 4096);
  // 4096 UTF-8 bytes pass; a CJK character is three bytes, so 1365 characters fit and 1366 do not.
  builder.assertHandoffWithinRendererLimits({ scopeSummary: "a".repeat(4096), doneWhen: ["ok"] });
  builder.assertHandoffWithinRendererLimits({ scopeSummary: "漢".repeat(1365), doneWhen: ["ok"] });
  for (const scopeSummary of ["a".repeat(4097), "漢".repeat(1366)]) {
    assert.throws(
      () => builder.assertHandoffWithinRendererLimits({ scopeSummary, doneWhen: ["ok"] }),
      (error) => error.classification === "handoff_limit_exceeded" && /renderer limit is 4096/.test(error.message),
    );
  }
  // done_when keeps its own, smaller limits.
  assert.equal(validator.DONE_WHEN_MAX_ITEMS, 32);
  assert.equal(validator.DONE_WHEN_ITEM_MAX_BYTES, 1024);
});

test("Over-long PR Change Context is refused by the builder before any handoff file is written", async () => {
  const { assertCanonicalCarrierRoot, buildPrStickyHandoff } = await import(pathToFileURL(builderPath));
  const proposalName = `synthetic-limit-${Date.now()}`;
  const proposalPath = `openspec/changes/${proposalName}/proposal.md`;
  const branch = `feature/${proposalName}`;
  const proposal = { path: proposalPath, content: "head proposal blob", doneWhen: ["head state is carried"] };
  const body = ["## Change Context", "", "x".repeat(4097), "", "## OpenSpec", "", `- change: \`openspec/changes/${proposalName}/\``, "", "## Requirement Ledger Completion", "", "The author reports strict validation passed.", "", "## Test Evidence", "", "The author reports focused tests passed.", ""].join("\n");
  const prNumber = 60000000 + Math.floor(Math.random() * 1000000);
  const temp = mkdtempSync(path.join(tmpdir(), "builder-limit-root-"));
  const fakeRepo = path.join(temp, "repo");
  mkdirSync(fakeRepo);
  execFileSync("git", ["init", "-q"], { cwd: fakeRepo });
  const root = path.join(fakeRepo, "notes", "cross-review");
  mkdirSync(root, { recursive: true });
  let liveReads = 0;
  const dependencies = {
    readPrMetadata: (requestedNumber) => ({ number: requestedNumber, repository_slug: "synthetic/example", head_branch: branch, head_sha: "d".repeat(40), body }),
    readProposalAtHead: () => proposal,
    readConsumerSecondReviewRules: () => "",
    buildEmbeddedReviewMaterial: () => { liveReads += 1; throw new Error("live material must not be read once the limit check failed"); },
    liveStickyAuthoritySnapshot: () => { liveReads += 1; throw new Error("live comments must not be read once the limit check failed"); },
    assertCanonicalCarrierRoot: (candidate) => assertCanonicalCarrierRoot(candidate, fakeRepo),
  };
  try {
    await assert.rejects(
      buildPrStickyHandoff({ argv: [String(prNumber), "--change", proposalName, "--carrier-root", root], primaryFamily: "codex", dependencies }),
      (error) => error.classification === "handoff_limit_exceeded" && /scope_summary is 4097 UTF-8 bytes; renderer limit is 4096/.test(error.message),
    );
    assert.equal(liveReads, 0, "the pre-check runs before the slow live reads");
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(`handoff-pr-${prNumber}-`)), []);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("Incomplete comments capture fails closed", async () => {
  const runner = await import("../run-second-reviewer-projection.mjs");
  assert.equal(typeof runner.liveStickyAuthoritySnapshot, "function", "shared raw sticky snapshot capture seam must be exported");
  const originalComments = [[{ id: 7, body: "first body", user: { login: "synthetic" } }], [{ id: 8, body: "second body", marker: [1, 2] }]];
  let capturedArgs;
  const result = runner.liveStickyAuthoritySnapshot({ repository_slug: "synthetic/example", pr_number: 4123 }, {
    spawnSync(command, args) {
      capturedArgs = [command, ...args];
      return { status: 0, stdout: JSON.stringify(originalComments), stderr: "" };
    },
  });
  assert.deepEqual(capturedArgs, ["gh", "api", "--paginate", "--slurp", "repos/synthetic/example/issues/4123/comments?per_page=100"]);
  assert.deepEqual(result.comments, originalComments.flat());
  assert.equal(result.completeness.status, "complete");
  assert.equal(result.completeness.pagination_exhausted, true);
  assert.equal(result.completeness.pages_fetched, 2);
  assert.equal(JSON.stringify(result.comments[0]), JSON.stringify(originalComments[0][0]));
  for (const response of [
    { status: 1, stdout: "", stderr: "gh failed" },
    { status: 0, stdout: "not-json", stderr: "" },
    { status: 0, stdout: JSON.stringify([]), stderr: "" },
    { status: 0, stdout: JSON.stringify([[], {}]), stderr: "" },
  ]) {
    const failed = runner.liveStickyAuthoritySnapshot({ repository_slug: "synthetic/example", pr_number: 4123 }, { spawnSync: () => response });
    assert.notEqual(failed.completeness.status, "complete");
  }
  const { assertCompleteStickySnapshot } = await import(pathToFileURL(builderPath));
  assert.throws(() => assertCompleteStickySnapshot({ ...result, completeness: { ...result.completeness, pagination_exhausted: false } }), /complete|pagination/i);
  const completeSnapshot = {
    ...result,
    repository_slug: "synthetic/example",
    pr_number: 4123,
    comments: [{ id: 7, body: "first body", html_url: "https://github.com/synthetic/example/pull/4123#issuecomment-7", node_id: "IC_kwDOsynthetic", updated_at: "2026-06-01T00:00:00Z" }],
  };
  assert.doesNotThrow(() => assertCompleteStickySnapshot(completeSnapshot));
  for (const comments of [[{}], [{ body: "body", id: 7, node_id: "IC_kwDOsynthetic", updated_at: "2026-06-01T00:00:00Z" }], [null]]) {
    assert.throws(() => assertCompleteStickySnapshot({ ...completeSnapshot, comments }), /complete|malformed/i);
  }
  const malformed = runner.liveStickyAuthoritySnapshot({ repository_slug: "synthetic/example", pr_number: 4123 }, { spawnSync: () => ({ status: 0, stdout: "{}", stderr: "" }) });
  assert.throws(() => assertCompleteStickySnapshot(malformed), /complete|malformed/i);
});

// fix-session-pending-residual-gaps: once a READY sticky exists the renderer refuses a
// full-pr scope, so the builder derives the narrowing base from that same sticky.
function readyStickySnapshot({ prNumber, reviewedSha, verdict = "PASS" }) {
  const body = [
    "<!-- cross-model-second-opinion:sticky -->",
    `verdict: ${verdict}`,
    `last_reviewed_sha: ${reviewedSha}`,
    "dispatch_id: dispatch-builder-scope-test",
    "reason: The bounded review completed for the requested scope.",
    "Rules: v6.83.10 · Tool: Claude Code · Model: claude-test",
  ].join("\n");
  return {
    repository_slug: "synthetic/example",
    pr_number: prNumber,
    completeness: { status: "complete", pagination_exhausted: true, pages_fetched: 1 },
    query_error: null,
    comments: [{
      id: 4242,
      node_id: "IC_kwDOExample123",
      html_url: `https://github.com/synthetic/example/pull/${prNumber}#issuecomment-4242`,
      body,
      updated_at: "2026-09-30T20:55:29Z",
    }],
  };
}

test("selectReviewScope narrows to the commits since the last READY review and falls back to the full PR with a reason", async () => {
  const { selectReviewScope } = await import(pathToFileURL(builderPath));
  const headSha = "c".repeat(40);
  const reviewedSha = "b".repeat(40);
  const common = { prNumber: 77, headSha };
  const full = { kind: "full-pr", pull_request_number: 77, head_sha: headSha };

  // No sticky at all: nothing was ever reviewed, so the full PR is the only legal scope and no reason is needed.
  const none = selectReviewScope({ ...common, stickySnapshot: { ...readyStickySnapshot({ prNumber: 77, reviewedSha }), comments: [] }, isAncestor: () => assert.fail("no ancestry probe without a baseline") });
  assert.deepEqual(none, { reviewScope: full });

  // READY PASS or WARN whose reviewed head is an ancestor: a commit-range from that sha.
  for (const verdict of ["PASS", "WARN"]) {
    const probes = [];
    const narrowed = selectReviewScope({
      ...common,
      stickySnapshot: readyStickySnapshot({ prNumber: 77, reviewedSha, verdict }),
      isAncestor: (base, head) => { probes.push([base, head]); return true; },
    });
    assert.deepEqual(narrowed, { reviewScope: { kind: "commit-range", base_sha: reviewedSha, head_sha: headSha } }, verdict);
    assert.deepEqual(probes, [[reviewedSha, headSha]]);
  }

  // A rebased head is not a clean extension: full PR with a reason the renderer accepts.
  const rebased = selectReviewScope({ ...common, stickySnapshot: readyStickySnapshot({ prNumber: 77, reviewedSha }), isAncestor: () => false });
  assert.deepEqual(rebased.reviewScope, full);
  assert.match(rebased.fullScopeReason, /^[\x20-\x7e]{8,200}$/);
  assert.match(rebased.fullScopeReason, /rebase/);

  // Re-reviewing the very head that was already reviewed cannot be a range.
  const same = selectReviewScope({ ...common, stickySnapshot: readyStickySnapshot({ prNumber: 77, reviewedSha: headSha }), isAncestor: () => assert.fail("same head needs no ancestry probe") });
  assert.deepEqual(same.reviewScope, full);
  assert.match(same.fullScopeReason, /^[\x20-\x7e]{8,200}$/);

  // A CRITICAL sticky is not a reviewed baseline.
  const critical = selectReviewScope({ ...common, stickySnapshot: readyStickySnapshot({ prNumber: 77, reviewedSha, verdict: "CRITICAL" }), isAncestor: () => assert.fail("CRITICAL is not a baseline") });
  assert.deepEqual(critical, { reviewScope: full });
});

test("isCommitAncestor is true only for a known ancestor commit", async () => {
  const { isCommitAncestor } = await import(pathToFileURL(builderPath));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const parent = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  assert.equal(isCommitAncestor(parent, head), true);
  assert.equal(isCommitAncestor(head, parent), false, "a descendant is not an ancestor");
  assert.equal(isCommitAncestor("0".repeat(40), head), false, "an unknown commit is not provable");
});

test("Builder narrows a re-review to a commit-range, and keeps full_scope_reason right after review_scope on the fallback", async () => {
  const { buildPrStickyHandoff, assertCanonicalCarrierRoot } = await import(pathToFileURL(builderPath));
  const proposalName = `synthetic-range-${Date.now()}`;
  const proposalPath = `openspec/changes/${proposalName}/proposal.md`;
  const proposalDirectory = `${path.posix.dirname(proposalPath)}/`;
  const headSha = "c".repeat(40);
  const reviewedSha = "b".repeat(40);
  const branch = `feature/${proposalName}`;
  const proposal = { path: proposalPath, content: "head proposal blob", doneWhen: ["head state is carried"] };
  const body = ["## Change Context", "", "Clarify the synthetic behavior", "Purpose: verify range narrowing", "", "## OpenSpec", "", `- change: \`${proposalDirectory}\``, "", "## Requirement Ledger Completion", "", "The author reports strict validation passed.", "", "## Test Evidence", "", "The author reports focused tests passed.", ""].join("\n");
  const rawDiff = contractFixture.review_material;
  const prNumber = 60000000 + Math.floor(Math.random() * 1000000);
  const temp = mkdtempSync(path.join(tmpdir(), "builder-range-root-"));
  const fakeRepo = path.join(temp, "repo");
  mkdirSync(fakeRepo);
  execFileSync("git", ["init", "-q"], { cwd: fakeRepo });
  const root = path.join(fakeRepo, "notes", "cross-review");
  mkdirSync(root, { recursive: true });
  const seenScopes = [];
  const deps = (ancestor) => ({
    readPrMetadata: (requestedNumber) => ({ number: requestedNumber, repository_slug: "synthetic/example", head_branch: branch, head_sha: headSha, body }),
    readProposalAtHead: () => proposal,
    readConsumerSecondReviewRules: () => "",
    buildEmbeddedReviewMaterial: (scope) => { seenScopes.push(scope); return { changed_files_or_touch_list: ["docs/guide.md"], review_material: rawDiff, review_material_proof: canonicalEmbeddedReviewMaterialProof(scope, rawDiff) }; },
    liveStickyAuthoritySnapshot: ({ pr_number }) => readyStickySnapshot({ prNumber: pr_number, reviewedSha }),
    isCommitAncestor: () => ancestor,
    assertCanonicalCarrierRoot: (candidate) => assertCanonicalCarrierRoot(candidate, fakeRepo),
  });
  const outputs = [];
  try {
    const narrowPath = await buildPrStickyHandoff({ argv: [String(prNumber), "--change", proposalName, "--carrier-root", root], primaryFamily: "codex", dependencies: deps(true) });
    outputs.push(narrowPath);
    const narrow = JSON.parse(readFileSync(narrowPath, "utf8"));
    assert.deepEqual(narrow.review_scope, { kind: "commit-range", base_sha: reviewedSha, head_sha: headSha });
    assert.equal(Object.hasOwn(narrow, "full_scope_reason"), false);
    assert.deepEqual(seenScopes.at(-1), narrow.review_scope, "material is derived for the narrowed scope, not the full PR");
    assert.deepEqual(Object.keys(narrow), keyOrder, "a narrowed handoff keeps the exact ordered key contract");

    const fallbackPath = await buildPrStickyHandoff({ argv: [String(prNumber + 1), "--change", proposalName, "--carrier-root", root], primaryFamily: "codex", dependencies: deps(false) });
    outputs.push(fallbackPath);
    const fallback = JSON.parse(readFileSync(fallbackPath, "utf8"));
    assert.equal(fallback.review_scope.kind, "full-pr");
    assert.match(fallback.full_scope_reason, /^[\x20-\x7e]{8,200}$/);
    const fallbackKeys = Object.keys(fallback);
    assert.equal(fallbackKeys[fallbackKeys.indexOf("review_scope") + 1], "full_scope_reason");
    assert.deepEqual(fallbackKeys.filter((key) => key !== "full_scope_reason"), keyOrder);
  } finally { for (const output of outputs) unlinkSync(output); rmSync(temp, { recursive: true, force: true }); }
});

// ---- Builder: identity-selected proposal, --lite, fixed approval fields -----------
// The builder takes no consent evidence: it never reads a grant, an approval ledger or the rigor level. Proposal
// selection runs against a real temp git repo whose HEAD stands in for the PR head, so a stubbed proposal cannot hide
// a ledger read; the PR metadata is stubbed (or routed through the real readPrMetadata for the cross-repository cases).
const SYNTHETIC_SLUG = "synthetic/example";
const LITE_BULLETS = ["first acceptance bullet is checked", "second acceptance bullet is checked"];
const DONE_WHEN_ITEMS = ["first done-when item", "second done-when item"];
const FIXED_APPROVAL_FIELDS = Object.freeze({ approval_context: "none", approval_resolution: { status: "not-required" } });

const proposalText = (items = DONE_WHEN_ITEMS, tail = "") => ["## Section 1: Target State (Done When)", "", ...items.map((item) => `- ${item}`), "", tail].join("\n");
const miniProposalText = (items = DONE_WHEN_ITEMS) => ["## Why", "", "synthetic", "", "## Target State", "", ...items.map((item) => `- ${item}`), ""].join("\n");

function prBodyFor({ change, openspec, acceptance = LITE_BULLETS.map((text) => `  - [x] ${text}`), changeContext = "- Synthetic change.\n- Purpose: verify the builder." } = {}) {
  const openspecLine = openspec ?? (change === undefined ? "- change: N/A: workflow=lite" : `- change: \`openspec/changes/${change}/\``);
  return [
    "## Change Context", changeContext, "",
    "## OpenSpec", openspecLine, "",
    "## Requirement Ledger Completion", "- disposition counts: N/A: synthetic", "",
    "## Test Evidence", "- Command: `node --test` on the synthetic fixture.", ...(acceptance === null ? [] : ["- **驗收證據**", ...acceptance]), "",
  ].join("\n");
}

// `files` and `body` take { change, branch, prNumber } so a scenario can name its own change. `headRepo` holds `files`
// committed at HEAD; the PR head SHA is that commit.
function makeScenario({ prefix = "feature", files = ({ change }) => ({ [`openspec/changes/${change}/proposal.md`]: proposalText() }), body = ({ change }) => prBodyFor({ change }), fork = false } = {}) {
  const prNumber = 70000000 + Math.floor(Math.random() * 1000000);
  const change = `synthetic-change-${prNumber}`;
  const branch = `${prefix}/${change}`;
  const context = { change, branch, prNumber };
  const temp = mkdtempSync(path.join(tmpdir(), "builder-handoff-root-"));
  const headRepo = path.join(temp, "head-repo");
  mkdirSync(headRepo);
  const git = (...args) => execFileSync("git", args, { cwd: headRepo, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Synthetic Test");
  writeFileSync(path.join(headRepo, "README.md"), "synthetic head\n");
  for (const [name, content] of Object.entries(files(context))) {
    mkdirSync(path.dirname(path.join(headRepo, name)), { recursive: true });
    writeFileSync(path.join(headRepo, name), content);
  }
  git("add", "-A");
  git("commit", "-qm", "synthetic PR head");
  const headSha = git("rev-parse", "HEAD");
  const fakeRepo = path.join(temp, "repo");
  mkdirSync(fakeRepo);
  execFileSync("git", ["init", "-q"], { cwd: fakeRepo });
  const root = path.join(fakeRepo, "notes", "cross-review");
  mkdirSync(root, { recursive: true });
  const scenario = { prNumber, change, branch, temp, root, fakeRepo, headSha, body: body(context), headBranch: branch, calls: { metadata: 0, readProposalAtHead: 0, findProposalPathsAtHead: 0, material: 0 } };
  const forkRun = (_command, args) => (args[0] === "repo"
    ? JSON.stringify({ nameWithOwner: SYNTHETIC_SLUG })
    : JSON.stringify({ number: prNumber, headRefName: scenario.headBranch, headRefOid: headSha, isCrossRepository: true, headRepository: { nameWithOwner: "contributor/fork" }, body: scenario.body }));
  scenario.dependencies = async () => {
    const builder = await import(pathToFileURL(builderPath));
    return {
      readPrMetadata: (requested, slug = null) => {
        scenario.calls.metadata += 1;
        if (fork) return builder.readPrMetadata(requested, slug, { runImpl: forkRun });
        return { number: requested, repository_slug: SYNTHETIC_SLUG, head_branch: scenario.headBranch, head_sha: headSha, body: scenario.body };
      },
      readProposalAtHead: (input) => { scenario.calls.readProposalAtHead += 1; return builder.readProposalAtHead({ ...input, repoRoot: headRepo }); },
      findProposalPathsAtHead: (input) => { scenario.calls.findProposalPathsAtHead += 1; return builder.findProposalPathsAtHead({ ...input, repoRoot: headRepo }); },
      readConsumerSecondReviewRules: () => "",
      buildEmbeddedReviewMaterial: (scope) => { scenario.calls.material += 1; return { changed_files_or_touch_list: ["docs/guide.md"], review_material: contractFixture.review_material, review_material_proof: canonicalEmbeddedReviewMaterialProof(scope, contractFixture.review_material) }; },
      liveStickyAuthoritySnapshot: ({ pr_number }) => ({ repository_slug: SYNTHETIC_SLUG, pr_number, completeness: { status: "complete", pagination_exhausted: true, pages_fetched: 1 }, query_error: null, comments: [] }),
      assertCanonicalCarrierRoot: (candidate) => builder.assertCanonicalCarrierRoot(candidate, fakeRepo),
    };
  };
  scenario.run = async ({ selector = ["--change", change], tail = [], env = {}, primaryFamily = "claude" } = {}) => {
    const { buildPrStickyHandoff } = await import(pathToFileURL(builderPath));
    return buildPrStickyHandoff({ argv: [String(prNumber), ...selector, "--carrier-root", root, ...tail], primaryFamily, env, dependencies: await scenario.dependencies() });
  };
  scenario.handoffFiles = () => readdirSync(root).filter((name) => name.startsWith(`handoff-pr-${prNumber}-`));
  scenario.cleanup = () => rmSync(temp, { recursive: true, force: true });
  return scenario;
}

const readHandoff = (outputPath) => JSON.parse(readFileSync(outputPath, "utf8"));
const FULL_RUN = Object.freeze({});
const LITE_RUN = (scenario) => ({ selector: ["--branch", scenario.branch], tail: ["--lite"] });

// Runs the scenario, expects a refusal with `classification`, and checks that no handoff file was written.
async function assertRefused(scenario, options, classification, label, pattern) {
  let caught;
  try { await scenario.run(options); } catch (error) { caught = error; }
  assert.ok(caught, `${label}: must be refused`);
  assert.equal(caught.classification, classification, `${label}: ${caught.message}`);
  if (pattern) assert.match(caught.message, pattern, label);
  assert.deepEqual(scenario.handoffFiles(), [], `${label}: no handoff file may be written`);
  return caught;
}

test("Builder writes the fixed approval fields on the full path and on the --lite path", async () => {
  for (const [label, makeOptions] of [["full path", () => FULL_RUN], ["lite path", LITE_RUN]]) {
    const lite = label === "lite path";
    const scenario = makeScenario({ files: lite ? () => ({}) : undefined, body: ({ change }) => prBodyFor({ change: lite ? undefined : change }) });
    try {
      const handoff = readHandoff(await scenario.run(makeOptions(scenario)));
      assert.equal(handoff.approval_context, FIXED_APPROVAL_FIELDS.approval_context, `${label}: approval_context`);
      assert.deepEqual(handoff.approval_resolution, FIXED_APPROVAL_FIELDS.approval_resolution, `${label}: approval_resolution is exactly {status: not-required}`);
      assert.deepEqual(Object.keys(handoff.approval_resolution), ["status"], `${label}: no extra approval_resolution key`);
      assert.deepEqual(Object.keys(handoff).filter((key) => key !== "full_scope_reason"), keyOrder, `${label}: the exact handoff key order is unchanged`);
      assert.doesNotMatch(JSON.stringify(handoff.approval_resolution), /approved|resolver|evidence_ref/, `${label}: no approval evidence rides in the resolution`);
      assert.equal(handoff.change_name, scenario.change, `${label}: change name`);
    } finally { scenario.cleanup(); }
  }
});

test("Lite handoff is built from checked acceptance evidence", async () => {
  const scenario = makeScenario({ prefix: "bugfix", files: () => ({}), body: () => prBodyFor() });
  try {
    // No rigor level in the environment (a conversation-declared lite session), and a full level must not matter either.
    for (const env of [{}, { DEVPRO_AGENT_RULES_LEVEL: "full" }]) {
      const outputPath = await scenario.run({ ...LITE_RUN(scenario), env });
      const handoff = readHandoff(outputPath);
      assert.equal((statSync(outputPath).mode & 0o777), expectedNodeModeBits(0o600));
      assert.deepEqual(handoff.done_when, LITE_BULLETS, "done_when lists the checked items in order");
      assert.equal(handoff.change_name, scenario.change, "the change name is derived from the live head branch");
      assert.equal(handoff.primary_family, "claude");
      assert.equal(handoff.reviewer_family, "codex");
      assert.match(handoff.primary_test_evidence, /node --test/);
      assert.equal(handoff.write_path, "none");
    }
    assert.equal(scenario.calls.readProposalAtHead, 0, "the lite path reads no proposal");
    assert.equal(existsSync(path.join(scenario.fakeRepo, "notes", "tmp")), false, "no grant directory or other state is created");
  } finally { scenario.cleanup(); }
});

test("Lite switch selector rules are enforced", async () => {
  const scenario = makeScenario({ files: () => ({}), body: () => prBodyFor() });
  try {
    for (const [label, selector, tail] of [
      ["--lite together with --change", ["--change", scenario.change], ["--lite"]],
      ["--lite together with --change and --branch", ["--change", scenario.change, "--branch", scenario.branch], ["--lite"]],
      ["--lite without any selector", [], ["--lite"]],
    ]) {
      await assertRefused(scenario, { selector, tail }, "invalid_selector", label);
    }
    assert.equal(scenario.calls.metadata, 0, "the selector rules refuse before any live read");
    const { parseBuilderArgs } = await import(pathToFileURL(builderPath));
    const base = ["9", "--branch", "bugfix/x", "--carrier-root", "r", "--primary-family", "claude"];
    assert.equal(parseBuilderArgs(base).lite, false);
    assert.equal(parseBuilderArgs([...base, "--lite"]).lite, true);
    const middle = parseBuilderArgs(["9", "--branch", "bugfix/x", "--lite", "--carrier-root", "r", "--primary-family", "claude"]);
    assert.equal(middle.lite, true);
    assert.equal(middle.carrierRoot, "r", "the switch must not swallow the next flag's value");
    assert.throws(() => parseBuilderArgs([...base, "--lite", "--lite"]), (error) => error.classification === "invalid_cli_arguments" && /duplicate builder flag/.test(error.message));
    assert.throws(() => parseBuilderArgs([...base, "--lite", "approved"]), /unknown builder flag: approved/, "a value after the switch is refused, never read as text");
    assert.throws(() => parseBuilderArgs(["9", "--change", "some-change", "--carrier-root", "r", "--primary-family", "claude", "--lite"]), (error) => error.classification === "invalid_selector");
  } finally { scenario.cleanup(); }
});

test("Lite path defers to a proposal at the PR head", async () => {
  const cases = [
    ["proposal.md", ({ change }) => ({ [`openspec/changes/${change}/proposal.md`]: proposalText() })],
    ["proposal-mini.md", ({ change }) => ({ [`openspec/changes/${change}/proposal-mini.md`]: miniProposalText() })],
    ["an archived proposal.md", ({ change }) => ({ [`openspec/changes/archive/2026-05-01-${change}/proposal.md`]: proposalText() })],
    ["an archived proposal-mini.md", ({ change }) => ({ [`openspec/changes/archive/2026-05-01-${change}/proposal-mini.md`]: miniProposalText() })],
  ];
  for (const [label, files] of cases) {
    const scenario = makeScenario({ files, body: () => prBodyFor() });
    try {
      const caught = await assertRefused(scenario, LITE_RUN(scenario), "lite_proposal_present", label);
      assert.ok(caught.message.includes(scenario.change), `${label}: the refusal names the change`);
    } finally { scenario.cleanup(); }
  }
  // A proposal for another change at the head does not block lite.
  const other = makeScenario({ files: () => ({ "openspec/changes/some-other-change/proposal.md": proposalText() }), body: () => prBodyFor() });
  try {
    assert.deepEqual(readHandoff(await other.run(LITE_RUN(other))).done_when, LITE_BULLETS);
  } finally { other.cleanup(); }
});

test("Missing or unchecked acceptance evidence is refused", async () => {
  const cases = [
    ["no 驗收證據 line at all", null],
    ["a 驗收證據 line with no checkbox item", []],
    ["an unchecked item", ["  - [ ] not yet done"]],
    ["a checked item and an unchecked item", ["  - [x] done item", "  - [ ] not yet done"]],
  ];
  for (const [label, acceptance] of cases) {
    const scenario = makeScenario({ files: () => ({}), body: () => prBodyFor({ acceptance }) });
    try { await assertRefused(scenario, LITE_RUN(scenario), "lite_acceptance_missing", label, /驗收證據/); }
    finally { scenario.cleanup(); }
  }
  // Checkbox items that sit before the 驗收證據 line are not acceptance evidence.
  const early = makeScenario({ files: () => ({}), body: () => prBodyFor().replace("- **驗收證據**", "- [x] earlier unrelated item\n- **驗收證據**").replace(/  - \[x\] .*\n/g, "") });
  try { await assertRefused(early, LITE_RUN(early), "lite_acceptance_missing", "only an item before the 驗收證據 line"); }
  finally { early.cleanup(); }
  const { parseLiteDoneWhen } = await import(pathToFileURL(builderPath));
  assert.deepEqual(parseLiteDoneWhen(prBodyFor()), LITE_BULLETS);
});

test("Removed lite approval switches are refused", async () => {
  const scenario = makeScenario({ files: () => ({}), body: () => prBodyFor() });
  try {
    const { parseBuilderArgs } = await import(pathToFileURL(builderPath));
    for (const flag of ["--lite-explicit-approval", "--lite-batch-approval"]) {
      assert.throws(
        () => parseBuilderArgs(["9", "--branch", "bugfix/x", "--carrier-root", "r", "--primary-family", "claude", flag]),
        (error) => error.classification === "invalid_cli_arguments" && error.message === `unknown builder flag: ${flag}`,
        flag,
      );
      await assertRefused(scenario, { selector: ["--branch", scenario.branch], tail: [flag] }, "invalid_cli_arguments", `${flag} without --lite`, /unknown builder flag/);
      await assertRefused(scenario, { selector: ["--branch", scenario.branch], tail: ["--lite", flag] }, "invalid_cli_arguments", `${flag} with --lite`, /unknown builder flag/);
    }
    assert.equal(scenario.calls.metadata, 0, "a removed switch is refused before any live read");
  } finally { scenario.cleanup(); }
  const source = readFileSync(builderPath, "utf8");
  assert.doesNotMatch(source, /lite_approval_|lite_batch_/, "the builder source contains no retired lite classification");
  assert.doesNotMatch(source, /lite-grant-store|resolve-cross-review-approval-context|rigor-level|ExternalDisclosureApproval/, "the builder source references no consent store, resolver or rigor level");
});

test("Stepwise full change with an N/A ledger yields a handoff", async () => {
  const ledgerWithoutDisclosure = ["## Batch Approval Ledger", "", "kind: same-change-dp-change-batch", "named_change: x", "branch: feature/x", "repo_scope: same-repo", "covers: [git-commit]", "excludes: []", ""].join("\n");
  const cases = [
    ["no ledger section", ({ change }) => ({ [`openspec/changes/${change}/proposal.md`]: proposalText() })],
    ["a ledger that is N/A", ({ change }) => ({ [`openspec/changes/${change}/proposal.md`]: proposalText(DONE_WHEN_ITEMS, "## Batch Approval Ledger\n\nN/A: stepwise, no batch approval.\n") })],
    ["a ledger that lists no disclosure item", ({ change }) => ({ [`openspec/changes/${change}/proposal.md`]: proposalText(DONE_WHEN_ITEMS, ledgerWithoutDisclosure) })],
  ];
  for (const [label, files] of cases) {
    for (const selectorFor of [(scenario) => ["--change", scenario.change], (scenario) => ["--branch", scenario.branch]]) {
      const scenario = makeScenario({ files });
      try {
        const handoff = readHandoff(await scenario.run({ selector: selectorFor(scenario) }));
        assert.deepEqual(handoff.done_when, DONE_WHEN_ITEMS, `${label}: done_when lists the proposal's Section 1 items`);
        assert.equal(handoff.change_name, scenario.change, label);
        assert.equal(handoff.approval_context, "none", label);
        assert.equal(existsSync(path.join(scenario.fakeRepo, "notes", "tmp")), false, `${label}: no lite record or grant is consulted or created`);
      } finally { scenario.cleanup(); }
    }
  }
  // B-mini: done_when comes from the Target State of proposal-mini.md.
  const mini = makeScenario({ prefix: "bugfix", files: ({ change }) => ({ [`openspec/changes/${change}/proposal-mini.md`]: miniProposalText(["mini item one", "mini item two"]) }), body: ({ change }) => prBodyFor({ change, openspec: `- change: \`openspec/changes/${change}/proposal-mini.md\`` }) });
  try {
    assert.deepEqual(readHandoff(await mini.run({ selector: ["--branch", mini.branch] })).done_when, ["mini item one", "mini item two"]);
  } finally { mini.cleanup(); }
  // Fork of the lifecycle: the proposal archived at the head is selected the same way.
  const archived = makeScenario({ files: ({ change }) => ({ [`openspec/changes/archive/2026-05-01-${change}/proposal.md`]: proposalText() }), body: ({ change }) => prBodyFor({ change, openspec: `- change: \`openspec/changes/archive/2026-05-01-${change}/\`` }) });
  try {
    assert.deepEqual(readHandoff(await archived.run()).done_when, DONE_WHEN_ITEMS);
  } finally { archived.cleanup(); }
});

test("Proposal candidates other than exactly one are refused", async () => {
  const cases = [
    ["no proposal for the change", () => ({})],
    ["a proposal for another change only", () => ({ "openspec/changes/some-other-change/proposal.md": proposalText() })],
    ["proposal.md and proposal-mini.md", ({ change }) => ({ [`openspec/changes/${change}/proposal.md`]: proposalText(), [`openspec/changes/${change}/proposal-mini.md`]: miniProposalText() })],
    ["an active and an archived proposal", ({ change }) => ({ [`openspec/changes/${change}/proposal.md`]: proposalText(), [`openspec/changes/archive/2026-05-01-${change}/proposal.md`]: proposalText() })],
  ];
  for (const [label, files] of cases) {
    for (const [selectorLabel, selectorFor] of [["--change", (scenario) => ["--change", scenario.change]], ["--branch", (scenario) => ["--branch", scenario.branch]]]) {
      const scenario = makeScenario({ files });
      try {
        const refusal = await assertRefused(scenario, { selector: selectorFor(scenario) }, "proposal_candidate_ambiguous", `${label} (${selectorLabel})`);
        // #3333: only "found 0" under --branch names the way out (--lite for a PR with no change of its own,
        // --change for a proposal under another name); every other shape keeps the bare refusal.
        const hintExpected = selectorLabel === "--branch" && /found 0$|found 0;/.test(refusal.message);
        if (hintExpected) {
          assert.match(refusal.message, new RegExp(`--lite --branch ${scenario.branch}`), `${label}: found 0 under --branch names --lite and the live branch`);
          assert.match(refusal.message, /--change <name>/, `${label}: found 0 under --branch names --change`);
        } else {
          assert.doesNotMatch(refusal.message, /--lite/, `${label} (${selectorLabel}): no --lite hint here`);
        }
      }
      finally { scenario.cleanup(); }
    }
  }
  // The hint is tied to the "found 0" cases above: both of them really are found 0.
  for (const files of [() => ({}), () => ({ "openspec/changes/some-other-change/proposal.md": proposalText() })]) {
    const scenario = makeScenario({ files });
    try {
      const refusal = await assertRefused(scenario, { selector: ["--branch", scenario.branch] }, "proposal_candidate_ambiguous", "found 0 under --branch");
      assert.match(refusal.message, /found 0; if this PR has no OpenSpec change of its own/);
    } finally { scenario.cleanup(); }
  }
  // A proposal without Section 1 Done When items is a different refusal.
  const noDoneWhen = makeScenario({ files: ({ change }) => ({ [`openspec/changes/${change}/proposal.md`]: "## Why\n\nsynthetic only\n" }) });
  try { await assertRefused(noDoneWhen, FULL_RUN, "proposal_evidence_missing", "a proposal without Done When"); }
  finally { noDoneWhen.cleanup(); }
});

test("OpenSpec section must name the matched proposal", async () => {
  const wrongNames = ["- change: N/A", ({ change }) => `- change: \`openspec/changes/${change}-other/\``, () => "- change: `openspec/changes/some-other-change/proposal.md`"];
  for (const openspec of wrongNames) {
    const scenario = makeScenario({ body: ({ change }) => prBodyFor({ change, openspec: typeof openspec === "function" ? openspec({ change }) : openspec }) });
    try { await assertRefused(scenario, FULL_RUN, "proposal_body_mismatch", `OpenSpec line ${JSON.stringify(typeof openspec === "function" ? "(computed)" : openspec)}`); }
    finally { scenario.cleanup(); }
  }
  // Naming the proposal path, or its directory, passes.
  for (const named of [({ change }) => `- change: \`openspec/changes/${change}/\``, ({ change }) => `- proposal: \`openspec/changes/${change}/proposal.md\``]) {
    const scenario = makeScenario({ body: ({ change }) => prBodyFor({ change, openspec: named({ change }) }) });
    try { assert.deepEqual(readHandoff(await scenario.run()).done_when, DONE_WHEN_ITEMS); }
    finally { scenario.cleanup(); }
  }
});

test("Branch selector must equal the live head branch", async () => {
  for (const [label, makeOptions, forLite] of [["full path", (scenario) => ({ selector: ["--branch", `${scenario.branch}-typo`] }), false], ["lite path", (scenario) => ({ selector: ["--branch", `${scenario.branch}-typo`], tail: ["--lite"] }), true]]) {
    const scenario = makeScenario({ files: forLite ? () => ({}) : undefined, body: ({ change }) => prBodyFor({ change: forLite ? undefined : change }) });
    try { await assertRefused(scenario, makeOptions(scenario), "invalid_selector", `${label}: --branch names another branch than the live head`, /does not equal --branch/); }
    finally { scenario.cleanup(); }
  }
  // The live head branch moved after the selector was typed: the selector no longer matches.
  const moved = makeScenario();
  try {
    moved.headBranch = "feature/some-other-branch";
    await assertRefused(moved, { selector: ["--branch", moved.branch] }, "invalid_selector", "the PR head branch moved");
  } finally { moved.cleanup(); }
  // The equal branch selects the proposal by the change name derived from the live head branch.
  const matching = makeScenario({ prefix: "bugfix" });
  try { assert.equal(readHandoff(await matching.run({ selector: ["--branch", matching.branch] })).change_name, matching.change); }
  finally { matching.cleanup(); }
});

// Scenario: Cross-repository pull request is refused
test("Cross-repository pull request is refused: pr_repository_mismatch goes to the user", async () => {
  for (const [label, makeOptions, forLite] of [["full path", () => FULL_RUN, false], ["lite path", LITE_RUN, true]]) {
    const scenario = makeScenario({ fork: true, files: forLite ? () => ({}) : undefined, body: ({ change }) => prBodyFor({ change: forLite ? undefined : change }) });
    try {
      await assertRefused(scenario, makeOptions(scenario), "pr_repository_mismatch", `${label}: a fork PR`, /PR head must be in this repository/);
      assert.equal(scenario.calls.material, 0, `${label}: refused before any review material is read`);
    } finally { scenario.cleanup(); }
  }
});

test("Same-repo PR handoff is built with no approval collaborator", async () => {
  const stepwise = makeScenario({ files: ({ change }) => ({ [`openspec/changes/${change}/proposal.md`]: proposalText(DONE_WHEN_ITEMS, "## Batch Approval Ledger\n\nN/A: stepwise.\n") }) });
  const lite = makeScenario({ prefix: "bugfix", files: () => ({}), body: () => prBodyFor() });
  try {
    for (const [label, scenario, options] of [["full path", stepwise, FULL_RUN], ["lite path", lite, LITE_RUN(lite)]]) {
      const dependencies = await scenario.dependencies();
      // Any consent-evidence collaborator would have to be injected here; the builder has none to call.
      for (const name of ["resolveApprovalThroughCli", "countMatchingLedgerProposals", "liteGrantDir", "runGh", "now"]) {
        dependencies[name] = () => { throw new Error(`${label}: the builder must not use ${name}`); };
      }
      const { buildPrStickyHandoff } = await import(pathToFileURL(builderPath));
      const outputPath = await buildPrStickyHandoff({ argv: [String(scenario.prNumber), ...(options.selector ?? ["--change", scenario.change]), "--carrier-root", scenario.root, ...(options.tail ?? [])], primaryFamily: "codex", env: modelProbeTestEnv(), dependencies });
      const handoff = readHandoff(outputPath);
      assert.equal(handoff.approval_context, "none", label);
      assert.deepEqual(handoff.approval_resolution, { status: "not-required" }, label);
      assert.equal(existsSync(path.join(scenario.fakeRepo, "notes", "tmp")), false, `${label}: no grant or lite record location is touched`);
    }
  } finally { stepwise.cleanup(); lite.cleanup(); }
});

test("Lite path keeps the renderer limit pre-checks and names the PR body as the done_when source", async () => {
  const over = makeScenario({ files: () => ({}), body: () => prBodyFor({ acceptance: [`  - [x] ${"y".repeat(1025)}`] }) });
  try { await assertRefused(over, LITE_RUN(over), "handoff_limit_exceeded", "an over-long 驗收證據 bullet", /done_when\[0\] is 1025 UTF-8 bytes; renderer limit is 1024.*PR body Test Evidence/); }
  finally { over.cleanup(); }
  const longContext = makeScenario({ files: () => ({}), body: () => prBodyFor({ changeContext: "x".repeat(4097) }) });
  try {
    await assertRefused(longContext, LITE_RUN(longContext), "handoff_limit_exceeded", "an over-long Change Context", /scope_summary is 4097 UTF-8 bytes; renderer limit is 4096/);
    assert.equal(longContext.calls.material, 0, "the limit check runs before the slow live reads");
  } finally { longContext.cleanup(); }
});

// ---- Characterization of the PR-body evidence and Change Context checks -------------------------
// These tests pin what the builder does today with the PR body sections, through the same
// dependency-injection harness as the handoff tests above. The four banned words are built by
// string joins so this file (and the PR text that cites test names) never carries them literally.
// Deliberate behavior change (strengthen-pre-pr-evidence-section-lint): the evidence limit moved from 4096 to 8192.
const CHARACTERIZATION_EVIDENCE_LIMIT = 8192;
const CHARACTERIZATION_SCOPE_LIMIT = 4096;
const CHARACTERIZATION_CHANGE = "synthetic-characterization";
const CHARACTERIZATION_CHANGE_DIR = `openspec/changes/${CHARACTERIZATION_CHANGE}/`;
const BANNED_WORDS = Object.freeze({
  one: ["TO", "DO"].join(""),
  two: ["TB", "D"].join(""),
  three: ["[fi", "ll"].join(""),
  four: ["place", "holder"].join(""),
});
const characterizationOpenspecLine = `- change: \`${CHARACTERIZATION_CHANGE_DIR}\``;

function characterizationBody({ changeContext = "Clarify the synthetic behavior and its purpose.", openspecExtra = "", ledger = "The author reports strict validation passed.", testEvidence = "The author reports focused tests passed." } = {}) {
  const openspec = openspecExtra === "" ? characterizationOpenspecLine : `${characterizationOpenspecLine}\n${openspecExtra}`;
  return ["## Change Context", "", changeContext, "", "## OpenSpec", "", openspec, "", "## Requirement Ledger Completion", "", ledger, "", "## Test Evidence", "", testEvidence, ""].join("\n");
}

// Runs the real builder with stubbed live reads. Resolves to { output } on success, or { error, calls } on refusal.
async function runBodyCharacterization(body) {
  const { assertCanonicalCarrierRoot, buildPrStickyHandoff } = await import(pathToFileURL(builderPath));
  const branch = `feature/${CHARACTERIZATION_CHANGE}`;
  const proposal = { path: `${CHARACTERIZATION_CHANGE_DIR}proposal.md`, content: "head proposal blob", doneWhen: ["head state is carried"] };
  const rawDiff = contractFixture.review_material;
  const prNumber = 70000000 + Math.floor(Math.random() * 1000000);
  const temp = mkdtempSync(path.join(tmpdir(), "builder-body-characterization-"));
  const fakeRepo = path.join(temp, "repo");
  mkdirSync(fakeRepo);
  execFileSync("git", ["init", "-q"], { cwd: fakeRepo });
  const root = path.join(fakeRepo, "notes", "cross-review");
  mkdirSync(root, { recursive: true });
  const calls = [];
  const dependencies = {
    readPrMetadata: (requestedNumber) => ({ number: requestedNumber, repository_slug: "synthetic/example", head_branch: branch, head_sha: "e".repeat(40), body }),
    readProposalAtHead: () => proposal,
    readConsumerSecondReviewRules: () => "",
    buildEmbeddedReviewMaterial: (scope) => { calls.push("material"); return { changed_files_or_touch_list: ["docs/guide.md"], review_material: rawDiff, review_material_proof: canonicalEmbeddedReviewMaterialProof(scope, rawDiff) }; },
    liveStickyAuthoritySnapshot: ({ pr_number }) => { calls.push("sticky"); return { repository_slug: "synthetic/example", pr_number, completeness: { status: "complete", pagination_exhausted: true, pages_fetched: 1 }, query_error: null, comments: [] }; },
    assertCanonicalCarrierRoot: (candidate) => assertCanonicalCarrierRoot(candidate, fakeRepo),
  };
  try {
    const outputPath = await buildPrStickyHandoff({ argv: [String(prNumber), "--change", CHARACTERIZATION_CHANGE, "--carrier-root", root], primaryFamily: "codex", dependencies });
    return { output: JSON.parse(readFileSync(outputPath, "utf8")), calls };
  } catch (error) {
    return { error, calls, handoffFiles: readdirSync(root).filter((name) => name.startsWith("handoff-pr-")) };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

// Deliberate behavior change: refusal messages now name the PR section (and bytes, limit or matched text)
// instead of the handoff field name inside one fixed sentence; the classification is unchanged.
const TEST_EVIDENCE_SECTION = /## Test Evidence/;
const VALIDATION_EVIDENCE_SECTION = /## OpenSpec \+ ## Requirement Ledger Completion/;
const expectEvidenceRefusal = (result, pattern) => {
  assert.ok(result.error, "the body must be refused");
  assert.equal(result.error.classification, "pr_evidence_invalid");
  if (pattern) assert.match(result.error.message, pattern);
  assert.deepEqual(result.handoffFiles, [], "no handoff file is written on refusal");
};

test("Characterization: the evidence sections pass the baseline body and carry their text verbatim into the handoff", async () => {
  const result = await runBodyCharacterization(characterizationBody());
  assert.equal(result.error, undefined);
  assert.equal(result.output.primary_test_evidence, "The author reports focused tests passed.");
  assert.equal(result.output.primary_validation_evidence, `${characterizationOpenspecLine}\n\nThe author reports strict validation passed.`);
});

test("Characterization: an empty Test Evidence section is refused as pr_evidence_invalid", async () => {
  expectEvidenceRefusal(await runBodyCharacterization(characterizationBody({ testEvidence: "" })), TEST_EVIDENCE_SECTION);
});

test("Characterization: an empty Requirement Ledger Completion section is skipped and OpenSpec alone carries the validation evidence", async () => {
  const result = await runBodyCharacterization(characterizationBody({ ledger: "" }));
  assert.equal(result.error, undefined);
  assert.equal(result.output.primary_validation_evidence, characterizationOpenspecLine);
});

test("Characterization: the Test Evidence byte limit counts UTF-8 bytes, so the limit passes and one more byte is refused", async () => {
  const atLimit = await runBodyCharacterization(characterizationBody({ testEvidence: "x".repeat(CHARACTERIZATION_EVIDENCE_LIMIT) }));
  assert.equal(atLimit.error, undefined);
  const overLimit = await runBodyCharacterization(characterizationBody({ testEvidence: "x".repeat(CHARACTERIZATION_EVIDENCE_LIMIT + 1) }));
  expectEvidenceRefusal(overLimit, new RegExp(`## Test Evidence: ${CHARACTERIZATION_EVIDENCE_LIMIT + 1} UTF-8 bytes; limit ${CHARACTERIZATION_EVIDENCE_LIMIT}`));
  // A CJK character is three bytes: floor(limit / 3) characters fit, one more does not.
  const cjkFit = "漢".repeat(Math.floor(CHARACTERIZATION_EVIDENCE_LIMIT / 3));
  const cjkOver = "漢".repeat(Math.floor(CHARACTERIZATION_EVIDENCE_LIMIT / 3) + 1);
  assert.ok(Buffer.byteLength(cjkFit, "utf8") <= CHARACTERIZATION_EVIDENCE_LIMIT && Buffer.byteLength(cjkOver, "utf8") > CHARACTERIZATION_EVIDENCE_LIMIT);
  assert.equal((await runBodyCharacterization(characterizationBody({ testEvidence: cjkFit }))).error, undefined);
  expectEvidenceRefusal(await runBodyCharacterization(characterizationBody({ testEvidence: cjkOver })), TEST_EVIDENCE_SECTION);
});

test("Characterization: the validation evidence limit counts the OpenSpec and Ledger sections trimmed and joined by one blank line", async () => {
  const joined = (ledger) => Buffer.byteLength([characterizationOpenspecLine, ledger].join("\n\n"), "utf8");
  const openspecBytes = Buffer.byteLength(characterizationOpenspecLine, "utf8");
  const ledgerAtLimit = "y".repeat(CHARACTERIZATION_EVIDENCE_LIMIT - openspecBytes - 2);
  assert.equal(joined(ledgerAtLimit), CHARACTERIZATION_EVIDENCE_LIMIT);
  assert.ok(Buffer.byteLength(ledgerAtLimit, "utf8") < CHARACTERIZATION_EVIDENCE_LIMIT, "each section alone is under the limit");
  assert.equal((await runBodyCharacterization(characterizationBody({ ledger: ledgerAtLimit }))).error, undefined);
  const ledgerOver = `${ledgerAtLimit}y`;
  assert.ok(Buffer.byteLength(ledgerOver, "utf8") < CHARACTERIZATION_EVIDENCE_LIMIT && joined(ledgerOver) === CHARACTERIZATION_EVIDENCE_LIMIT + 1);
  expectEvidenceRefusal(await runBodyCharacterization(characterizationBody({ ledger: ledgerOver })), VALIDATION_EVIDENCE_SECTION);
});

test("Characterization: the four banned words are refused in either evidence field, case-insensitively", async () => {
  for (const word of Object.values(BANNED_WORDS)) {
    for (const variant of [word, word.toLowerCase()]) {
      expectEvidenceRefusal(await runBodyCharacterization(characterizationBody({ testEvidence: `Result: ${variant} remains` })), TEST_EVIDENCE_SECTION);
      expectEvidenceRefusal(await runBodyCharacterization(characterizationBody({ ledger: `Validation: ${variant} remains` })), VALIDATION_EVIDENCE_SECTION);
    }
  }
});

test("Characterization: two of the banned words carry word boundaries and the other two match inside longer words", async () => {
  for (const word of [BANNED_WORDS.one, BANNED_WORDS.two]) {
    assert.equal((await runBodyCharacterization(characterizationBody({ testEvidence: `Result: ${word}S were closed` }))).error, undefined, `${word} inside a longer word is accepted`);
  }
  expectEvidenceRefusal(await runBodyCharacterization(characterizationBody({ testEvidence: `Result: x${BANNED_WORDS.four}x` })), TEST_EVIDENCE_SECTION);
  expectEvidenceRefusal(await runBodyCharacterization(characterizationBody({ testEvidence: `Result: x${BANNED_WORDS.three}x` })), TEST_EVIDENCE_SECTION);
});

test("Characterization: an angle-bracket field outside code is refused in either evidence field", async () => {
  expectEvidenceRefusal(await runBodyCharacterization(characterizationBody({ testEvidence: "Result: passed <n> checks" })), TEST_EVIDENCE_SECTION);
  expectEvidenceRefusal(await runBodyCharacterization(characterizationBody({ ledger: "Validation: implemented <n>" })), VALIDATION_EVIDENCE_SECTION);
  expectEvidenceRefusal(await runBodyCharacterization(characterizationBody({ testEvidence: "Result: passed <各 gate 輸出的範圍> checks" })), TEST_EVIDENCE_SECTION);
});

// Deliberate behavior change: the angle-bracket rule used to ignore code regions and refuse every field; the
// evidence sections now accept one ASCII identifier inside code (a command template) and still refuse the rest.
test("Characterization: a single identifier in code is accepted in the evidence fields, a spaced field in code is still refused", async () => {
  const tick = String.fromCharCode(96);
  const accepted = await runBodyCharacterization(characterizationBody({ testEvidence: `Result: ran ${tick}--changed <sha>${tick} and passed`, ledger: `Validation: ${tick}openspec/changes/archive/<name>${tick} exists` }));
  assert.equal(accepted.error, undefined);
  expectEvidenceRefusal(await runBodyCharacterization(characterizationBody({ testEvidence: `Result: ran ${tick}<passed X, failed 0>${tick}` })), TEST_EVIDENCE_SECTION);
  expectEvidenceRefusal(await runBodyCharacterization(characterizationBody({ testEvidence: `Result: ${tick}keep${tick} <n> outside` })), TEST_EVIDENCE_SECTION);
});

test("Characterization: the validation field is checked before the test field, and both only after the live reads", async () => {
  const bothBad = await runBodyCharacterization(characterizationBody({ ledger: `Validation: ${BANNED_WORDS.two}`, testEvidence: `Result: ${BANNED_WORDS.two}` }));
  expectEvidenceRefusal(bothBad, VALIDATION_EVIDENCE_SECTION);
  assert.doesNotMatch(bothBad.error.message, TEST_EVIDENCE_SECTION);
  assert.deepEqual(bothBad.calls, ["sticky", "material"], "evidence is checked after the sticky snapshot and review material reads");
});

test("Characterization: the Change Context is normalized to one line before it becomes scope_summary", async () => {
  const result = await runBodyCharacterization(characterizationBody({ changeContext: "- first item\n* second\titem\n\n+ third item" }));
  assert.equal(result.error, undefined);
  assert.equal(result.output.scope_summary, "first item second item third item");
});

test("Characterization: the scope_summary limit counts the normalized bytes, not the raw section", async () => {
  const atLimit = await runBodyCharacterization(characterizationBody({ changeContext: "a".repeat(CHARACTERIZATION_SCOPE_LIMIT) }));
  assert.equal(atLimit.error, undefined);
  const overLimit = await runBodyCharacterization(characterizationBody({ changeContext: "a".repeat(CHARACTERIZATION_SCOPE_LIMIT + 1) }));
  assert.equal(overLimit.error.classification, "handoff_limit_exceeded");
  assert.match(overLimit.error.message, new RegExp(`scope_summary is ${CHARACTERIZATION_SCOPE_LIMIT + 1} UTF-8 bytes; renderer limit is ${CHARACTERIZATION_SCOPE_LIMIT}`));
  assert.deepEqual(overLimit.calls, [], "the limit is checked before any live read");
  // Two bullet lines whose raw length is over the limit normalize to under it (markers and newlines shrink).
  const half = "a".repeat(Math.floor(CHARACTERIZATION_SCOPE_LIMIT / 2) - 1);
  const rawContext = `- ${half}\n- ${half}`;
  assert.ok(Buffer.byteLength(rawContext, "utf8") > CHARACTERIZATION_SCOPE_LIMIT);
  assert.equal((await runBodyCharacterization(characterizationBody({ changeContext: rawContext }))).error, undefined);
  // A CJK character is three bytes: 1365 characters fit and 1366 do not.
  assert.equal((await runBodyCharacterization(characterizationBody({ changeContext: "漢".repeat(1365) }))).error, undefined);
  const cjkOver = await runBodyCharacterization(characterizationBody({ changeContext: "漢".repeat(1366) }));
  assert.equal(cjkOver.error.classification, "handoff_limit_exceeded");
});

test("Characterization: an empty Change Context or one with unfilled wording is refused as pr_evidence_invalid before any live read", async () => {
  const refusals = [
    "",
    `Purpose: ${BANNED_WORDS.one}`,
    `Purpose: ${BANNED_WORDS.two}`,
    `Purpose: ${BANNED_WORDS.four}`,
    "Purpose: explain <why>",
    "Purpose: explain `<why>` in code",
  ];
  for (const changeContext of refusals) {
    const result = await runBodyCharacterization(characterizationBody({ changeContext }));
    // Deliberate behavior change: the empty and unfilled messages come from the shared formatter.
    expectEvidenceRefusal(result, /## Change Context: (empty or missing|unfilled template text)/);
    assert.deepEqual(result.calls, [], "the Change Context is checked before any live read");
  }
});

test("Characterization: the Change Context does not treat the bracketed fill marker as unfilled wording", async () => {
  const result = await runBodyCharacterization(characterizationBody({ changeContext: `Purpose: ${BANNED_WORDS.three} later` }));
  assert.equal(result.error, undefined);
});

test("Characterization: control characters in the Change Context are refused, and tabs are normalized to spaces", async () => {
  for (const control of ["\u0000", "\u0008", "\u000e", "\u001f", "\u007f"]) {
    const result = await runBodyCharacterization(characterizationBody({ changeContext: `Clarify${control}behavior` }));
    expectEvidenceRefusal(result, /unsupported control characters/);
    assert.deepEqual(result.calls, []);
  }
  const tabbed = await runBodyCharacterization(characterizationBody({ changeContext: "Clarify\tthe\tbehavior" }));
  assert.equal(tabbed.output.scope_summary, "Clarify the behavior");
});

// ---- Builder: --external-evaluator <tool> (External Evaluator handoff for a PR whose raw diff exceeds the embed cap) ----
// The external handoff is the standard handoff minus page_window_max_pages, with live-read material fields and the two
// trailing executor keys. It never reads the raw diff: the changed-file list comes from the injectable `listChangedFiles`.
const EXTERNAL_RUN = (tool = "Gemini CLI") => ({ tail: ["--external-evaluator", tool] });
const EXTERNAL_FILES = Object.freeze(["docs/guide.md", "src/large-change.mjs"]);

async function externalScenarioRun(scenario, options = {}, { listChangedFiles, dependencies = {} } = {}) {
  const seen = { scopes: [], material: 0 };
  const base = await scenario.dependencies();
  const merged = {
    ...base,
    buildEmbeddedReviewMaterial: () => { seen.material += 1; assert.fail("external mode must not read the raw diff"); },
    listChangedFiles: listChangedFiles ?? ((scope) => { seen.scopes.push(scope); return [...EXTERNAL_FILES]; }),
    ...dependencies,
  };
  const { buildPrStickyHandoff } = await import(pathToFileURL(builderPath));
  const outputPath = await buildPrStickyHandoff({
    argv: [String(scenario.prNumber), ...(options.selector ?? ["--change", scenario.change]), "--carrier-root", scenario.root, ...(options.tail ?? [])],
    primaryFamily: options.primaryFamily ?? "claude",
    env: options.env ?? {},
    dependencies: merged,
  });
  return { outputPath, seen };
}

test("External evaluator: the handoff carries live-read material fields, the file list and the two trailing executor keys", async () => {
  const scenario = makeScenario();
  const { canonicalAdapterRouteProof } = await import("../second-review-material-contract.mjs");
  try {
    const { outputPath, seen } = await externalScenarioRun(scenario, EXTERNAL_RUN("Gemini CLI"));
    const handoff = readHandoff(outputPath);
    const standardKeys = keyOrder.filter((key) => key !== "page_window_max_pages");
    assert.deepEqual(Object.keys(handoff), [...standardKeys, "executor_kind", "reviewer_tool"]);
    assert.equal(Object.hasOwn(handoff, "page_window_max_pages"), false);
    assert.equal(handoff.executor_kind, "external-evaluator");
    assert.equal(handoff.reviewer_tool, "Gemini CLI");
    assert.equal(handoff.review_material_carrier, "external-live-reads");
    assert.equal(handoff.review_material_capability, "full-pr-bounded-live-reads-v1");
    assert.deepEqual(handoff.review_scope, { kind: "full-pr", pull_request_number: scenario.prNumber, head_sha: scenario.headSha });
    assert.deepEqual(handoff.review_material_proof, canonicalAdapterRouteProof(handoff.review_scope));
    assert.equal(handoff.review_material, "");
    assert.deepEqual(handoff.changed_files_or_touch_list, [...EXTERNAL_FILES]);
    assert.deepEqual(seen.scopes, [handoff.review_scope], "the file list is derived for the selected review scope");
    assert.equal(seen.material, 0, "buildEmbeddedReviewMaterial is never called");
    assert.equal(handoff.mode, "pr-sticky");
    assert.deepEqual(handoff.done_when, DONE_WHEN_ITEMS);
    assert.equal(handoff.approval_context, "none");
    assert.equal((statSync(outputPath).mode & 0o777), expectedNodeModeBits(0o600));
  } finally { scenario.cleanup(); }
});

test("External evaluator: a commit-range scope uses the exact-compare capability and route proof, with full_scope_reason after review_scope", async () => {
  const scenario = makeScenario();
  const { canonicalAdapterRouteProof } = await import("../second-review-material-contract.mjs");
  const reviewedSha = "b".repeat(40);
  const stickySnapshot = (pr_number) => readyStickySnapshot({ prNumber: pr_number, reviewedSha });
  try {
    const narrow = await externalScenarioRun(scenario, EXTERNAL_RUN("Codex"), {
      dependencies: { liveStickyAuthoritySnapshot: ({ pr_number }) => stickySnapshot(pr_number), isCommitAncestor: () => true },
    });
    const range = readHandoff(narrow.outputPath);
    assert.deepEqual(range.review_scope, { kind: "commit-range", base_sha: reviewedSha, head_sha: scenario.headSha });
    assert.equal(range.review_material_capability, "commit-range-exact-compare-v1");
    assert.deepEqual(range.review_material_proof, canonicalAdapterRouteProof(range.review_scope));
    assert.equal(range.reviewer_tool, "Codex");
    assert.equal(Object.hasOwn(range, "page_window_max_pages"), false);

    const fallback = await externalScenarioRun(scenario, EXTERNAL_RUN("Codex"), {
      dependencies: { liveStickyAuthoritySnapshot: ({ pr_number }) => stickySnapshot(pr_number), isCommitAncestor: () => false },
    });
    const full = readHandoff(fallback.outputPath);
    const keys = Object.keys(full);
    assert.equal(keys[keys.indexOf("review_scope") + 1], "full_scope_reason");
    assert.deepEqual(keys.slice(-2), ["executor_kind", "reviewer_tool"]);
    assert.equal(full.review_material_capability, "full-pr-bounded-live-reads-v1");
  } finally { scenario.cleanup(); }
});

test("External evaluator: the renderer's handoff validation accepts the builder output", async () => {
  const scenario = makeScenario();
  const temp = mkdtempSync(path.join(tmpdir(), "builder-external-render-"));
  const saved = {
    control: process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR,
    state: process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR,
  };
  try {
    process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR = path.join(temp, "control-evidence");
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = path.join(temp, "state");
    const { getSecondReviewObservabilityContext } = await import(pathToFileURL(path.resolve(here, "../render-second-review-packet.mjs")).href);
    for (const [primaryFamily, tool] of [["claude", "Codex"], ["codex", "Claude Code"]]) {
      const { outputPath } = await externalScenarioRun(scenario, { ...EXTERNAL_RUN(tool), primaryFamily });
      const handoff = readHandoff(outputPath);
      const context = getSecondReviewObservabilityContext(handoff);
      assert.equal(context.executor_kind, "external-evaluator");
      assert.equal(context.reviewer_tool, tool);
    }
  } finally {
    for (const [name, value] of [["DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR", saved.control], ["DEVPRO_POST_PR_COMPLETION_STATE_DIR", saved.state]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(temp, { recursive: true, force: true });
    scenario.cleanup();
  }
});

test("External evaluator: an unknown tool token, a missing value and a duplicate flag are refused before any live read", async () => {
  const scenario = makeScenario();
  try {
    for (const [tail, pattern] of [
      [["--external-evaluator", "gemini"], /Claude Code, Codex, Gemini CLI/],
      [["--external-evaluator", "Unknown Tool"], /--external-evaluator/],
      [["--external-evaluator"], /requires a non-empty value/],
      [["--external-evaluator", "Codex", "--external-evaluator", "Codex"], /duplicate builder flag/],
    ]) {
      const calls = scenario.calls.metadata;
      let caught;
      try { await externalScenarioRun(scenario, { tail }); } catch (error) { caught = error; }
      assert.ok(caught, `${tail.join(" ")} must be refused`);
      assert.match(caught.message, pattern);
      assert.equal(scenario.calls.metadata, calls, "refused while parsing, before the PR metadata read");
      assert.deepEqual(scenario.handoffFiles(), []);
    }
    let caught;
    try { await externalScenarioRun(scenario, { tail: ["--external-evaluator", "gemini"] }); } catch (error) { caught = error; }
    assert.equal(caught.classification, "invalid_external_evaluator");
  } finally { scenario.cleanup(); }
});

test("External evaluator: --lite works with the flag, and an unusable file list is refused with review_material_unavailable", async () => {
  const scenario = makeScenario({ prefix: "bugfix", files: () => ({}), body: () => prBodyFor() });
  try {
    const { outputPath } = await externalScenarioRun(scenario, { selector: ["--branch", scenario.branch], tail: ["--lite", "--external-evaluator", "Gemini CLI"] });
    const handoff = readHandoff(outputPath);
    assert.deepEqual(handoff.done_when, LITE_BULLETS);
    assert.equal(handoff.review_material_carrier, "external-live-reads");
    assert.equal(scenario.calls.readProposalAtHead, 0);
    for (const bad of [null, [], ["a", "a"], [""]]) {
      let caught;
      try { await externalScenarioRun(scenario, { selector: ["--branch", scenario.branch], tail: ["--lite", "--external-evaluator", "Gemini CLI"] }, { listChangedFiles: () => bad }); } catch (error) { caught = error; }
      assert.ok(caught, `${JSON.stringify(bad)} must be refused`);
      assert.equal(caught.classification, "review_material_unavailable");
      // A proven-empty list is a zero-diff pull request: the refusal says so and never sends it back to --external-evaluator.
      if (Array.isArray(bad) && bad.length === 0) assert.match(caught.message, /^the pull request has no content diff against its base/);
      else assert.match(caught.message, /^changed file list could not be derived/);
    }
    assert.deepEqual(scenario.handoffFiles().length, 1, "only the one valid run wrote a handoff");
  } finally { scenario.cleanup(); }
});

test("External evaluator: the default file list reads git name-status for the bound base and head, and fails closed on a bad probe", async () => {
  const { listChangedFilesForScope } = await import(pathToFileURL(builderPath));
  const head = "c".repeat(40);
  const base = "b".repeat(40);
  const calls = [];
  const spawnSyncImpl = (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "rev-parse") return { status: 0, stdout: `${SECOND_REVIEW_CANONICAL_REPOSITORY_ROOT}\n` };
    if (command === "gh") return { status: 0, stdout: JSON.stringify({ baseRefOid: base, headRefOid: head }) };
    if (command === "git" && args[0] === "merge-base") return { status: 0, stdout: Buffer.from(`${base}\n`) };
    if (command === "git" && args.includes("--name-status")) return { status: 0, stdout: Buffer.from("M\0docs/guide.md\0A\0src/b.mjs\0") };
    return { status: 1, stdout: Buffer.alloc(0) };
  };
  const full = { kind: "full-pr", pull_request_number: 12, head_sha: head };
  assert.deepEqual(listChangedFilesForScope(full, { repositorySlug: "synthetic/example", spawnSyncImpl }), ["docs/guide.md", "src/b.mjs"]);
  assert.equal(calls.some((call) => call[0] === "git" && call[1] === "diff" && !call.includes("--name-status")), false, "the raw diff is never read");
  assert.deepEqual(listChangedFilesForScope({ kind: "commit-range", base_sha: base, head_sha: head }, { repositorySlug: "synthetic/example", spawnSyncImpl }), ["docs/guide.md", "src/b.mjs"]);
  const stale = (command, args) => (command === "gh" ? { status: 0, stdout: JSON.stringify({ baseRefOid: base, headRefOid: "d".repeat(40) }) } : spawnSyncImpl(command, args));
  assert.equal(listChangedFilesForScope(full, { repositorySlug: "synthetic/example", spawnSyncImpl: stale }), null, "a PR head that moved is not the bound head");
  const noNameStatus = (command, args) => (args.includes("--name-status") ? { status: 1, stdout: Buffer.alloc(0) } : spawnSyncImpl(command, args));
  assert.equal(listChangedFilesForScope(full, { repositorySlug: "synthetic/example", spawnSyncImpl: noNameStatus }), null);
  // An empty name-status output from a successful read is a proven-empty diff, never "unknown".
  const emptyNameStatus = (command, args) => (args.includes("--name-status") ? { status: 0, stdout: Buffer.alloc(0) } : spawnSyncImpl(command, args));
  assert.deepEqual(listChangedFilesForScope(full, { repositorySlug: "synthetic/example", spawnSyncImpl: emptyNameStatus }), []);
});

test("review_material_unavailable points at --external-evaluator and the External Evaluator rule, without changing the classification", async () => {
  const { buildEmbeddedReviewMaterial } = await import(pathToFileURL(builderPath));
  const scope = { kind: "full-pr", pull_request_number: 5, head_sha: "a".repeat(40) };
  let caught;
  try { buildEmbeddedReviewMaterial(scope, { repositorySlug: "synthetic/example", derive: () => null, listFiles: () => null }); } catch (error) { caught = error; }
  assert.ok(caught);
  assert.equal(caught.classification, "review_material_unavailable");
  assert.match(caught.message, /^authoritative PR review material could not be derived for the bound head/);
  assert.match(caught.message, /--external-evaluator <tool>/);
  assert.match(caught.message, /\.devpro\/agent-rules\/second-review-external-evaluator\.md/);
  assert.match(caught.message, /embed/i);
});

test("Scenario: A zero-diff pull request is refused with its own message, not the --external-evaluator advice", async () => {
  const { buildEmbeddedReviewMaterial, ZERO_DIFF_REVIEW_MATERIAL_MESSAGE } = await import(pathToFileURL(builderPath));
  const scope = { kind: "full-pr", pull_request_number: 5, head_sha: "a".repeat(40) };
  let caught;
  try { buildEmbeddedReviewMaterial(scope, { repositorySlug: "synthetic/example", derive: () => null, listFiles: () => [] }); } catch (error) { caught = error; }
  assert.ok(caught);
  assert.equal(caught.classification, "review_material_unavailable");
  assert.equal(caught.message.startsWith(ZERO_DIFF_REVIEW_MATERIAL_MESSAGE), true, caught.message);
  assert.doesNotMatch(caught.message, /re-run with --external-evaluator/);
  assert.match(caught.message, /bugfix\/fix-production-ancestry-\*/);
  assert.match(caught.message, /Path W/);
  assert.match(caught.message, /has no content diff against its base/);
  // The gates prove the exemption from local git objects; the message names the fetch that makes them readable.
  assert.ok(caught.message.includes("git fetch origin pull/<PR#>/head --tags"), caught.message);
  // A material derivation that succeeds never asks for the file list.
  let listed = 0;
  const material = buildEmbeddedReviewMaterial(scope, {
    repositorySlug: "synthetic/example",
    derive: () => ({ head_sha: scope.head_sha, paths: ["a.txt"], raw_diff: "diff --git a/a.txt b/a.txt\n" }),
    listFiles: () => { listed += 1; return []; },
  });
  assert.deepEqual(material.changed_files_or_touch_list, ["a.txt"]);
  assert.equal(listed, 0);
});

// ---- Consumer second-review rules (.devpro/second-review-rules.local.md) ---------------------------------
// The builder reads the markdown file from the pull request base commit recorded by GitHub (`pr_base_sha`), never from the
// working tree, the head or `review_scope.base_sha`. These fixtures build real temporary git repos so the fixed-argv
// git reads run for real; a recording spawnSync wrapper captures every argv the reader runs.
const RULES_REL = CONSUMER_SECOND_REVIEW_RULES_REL;
const NOT_WRITTEN = "No handoff was written by this run; do not render a review packet from an earlier handoff file.";
const KEEP = Symbol("keep the rules file as it is");

// `rules`: KEEP, null (no file), a string or Buffer (regular file), { symlink }, { dir: true } or { gitlink: sha }.
function applyRulesFile(dir, git, rules) {
  if (rules === KEEP) return;
  const target = path.join(dir, RULES_REL);
  git("rm", "-rq", "--cached", "--ignore-unmatch", "--", RULES_REL);
  rmSync(target, { recursive: true, force: true });
  if (rules === null) return;
  mkdirSync(path.dirname(target), { recursive: true });
  if (rules.gitlink !== undefined) { git("update-index", "--add", "--cacheinfo", `160000,${rules.gitlink},${RULES_REL}`); return; }
  if (rules.symlink !== undefined) symlinkSync(rules.symlink, target);
  else if (rules.dir) { mkdirSync(target); writeFileSync(path.join(target, "nested.txt"), "nested\n"); }
  else writeFileSync(target, rules);
  git("add", "-f", "--", RULES_REL);
}

// A throwaway repo whose commits each carry a fresh marker file, so every commit differs.
function newRulesRepo(parent, name = "rules-repo") {
  const dir = path.join(parent, name);
  mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Synthetic Test");
  git("config", "commit.gpgsign", "false");
  let counter = 0;
  const commit = (rules = KEEP, label = "synthetic commit") => {
    applyRulesFile(dir, git, rules);
    counter += 1;
    writeFileSync(path.join(dir, `marker-${name}.txt`), `${label} ${counter}\n`);
    git("add", "--", `marker-${name}.txt`);
    git("commit", "-qm", label);
    return git("rev-parse", "HEAD");
  };
  return { dir, git, commit };
}

const snapshotDirectory = (dir) => Object.fromEntries(readdirSync(dir).sort().map((name) => {
  const full = path.join(dir, name);
  return [name, { mode: statSync(full).mode & 0o777, bytes: readFileSync(full).toString("base64") }];
}));

// Builds a pull request over a temp repo. By default the history is base -> head (linear); `mid` adds a pull request
// commit between them (the commit-range review base); `topology(repo)` may return { prBaseSha, headSha, reviewedSha }
// for any other shape. `scenario.state.rulesCwd` may point the reader at another clone. Everything the builder reads
// besides the rules text is stubbed.
async function makeRulesScenario({ base = null, mid, head = KEEP, lite = false, scope = "full-pr", topology } = {}) {
  const builder = await import(pathToFileURL(builderPath));
  const prNumber = 80000000 + Math.floor(Math.random() * 1000000);
  const change = `synthetic-rules-${prNumber}`;
  const branch = `${lite ? "bugfix" : "feature"}/${change}`;
  const temp = mkdtempSync(path.join(tmpdir(), "builder-rules-root-"));
  const repo = newRulesRepo(temp);
  const shas = topology ? topology(repo) : (() => {
    const prBaseSha = repo.commit(base, "pull request base");
    const reviewedSha = mid === undefined ? undefined : repo.commit(mid, "pull request fix");
    return { prBaseSha, reviewedSha, headSha: repo.commit(head, "pull request head") };
  })();
  const fakeRepo = path.join(temp, "repo");
  mkdirSync(fakeRepo);
  execFileSync("git", ["init", "-q"], { cwd: fakeRepo });
  const root = path.join(fakeRepo, "notes", "cross-review");
  mkdirSync(root, { recursive: true });
  const scenario = {
    prNumber, change, branch, root, temp, repo,
    state: { ...shas },
    gitCalls: [],
    rulesInputs: [],
    metadataReads: 0,
    cleanup: () => rmSync(temp, { recursive: true, force: true }),
    handoffFiles: () => readdirSync(root).filter((name) => name.startsWith(`handoff-pr-${prNumber}-`)),
    snapshot: () => snapshotDirectory(root),
  };
  const body = lite ? prBodyFor() : prBodyFor({ change });
  const proposal = { path: `openspec/changes/${change}/proposal.md`, content: "head proposal blob", doneWhen: DONE_WHEN_ITEMS };
  const recorder = (command, args, options) => {
    scenario.gitCalls.push([command, ...args]);
    // A scenario may replace the answer of the merge-base query (several merge bases, or none).
    if (scenario.state.mergeBaseAnswer !== undefined && args[0] === "merge-base") return scenario.state.mergeBaseAnswer;
    return spawnSync(command, args, options);
  };
  scenario.dependencies = (overrides = {}) => {
    let readsInThisRun = 0;
    return {
      readPrMetadata: (requested) => {
        scenario.metadataReads += 1;
        readsInThisRun += 1;
        const record = Object.hasOwn(scenario.state, "baseRecord") ? scenario.state.baseRecord : scenario.state.prBaseSha;
        const finalRead = readsInThisRun === 2 && scenario.state.finalBaseRecord !== undefined;
        return { number: requested, repository_slug: SYNTHETIC_SLUG, head_branch: branch, head_sha: scenario.state.headSha, pr_base_sha: finalRead ? scenario.state.finalBaseRecord : record, body };
      },
      readProposalAtHead: () => proposal,
      findProposalPathsAtHead: () => [],
      buildEmbeddedReviewMaterial: (reviewScope) => ({ changed_files_or_touch_list: ["docs/guide.md"], review_material: contractFixture.review_material, review_material_proof: canonicalEmbeddedReviewMaterialProof(reviewScope, contractFixture.review_material) }),
      listChangedFiles: () => [...EXTERNAL_FILES],
      liveStickyAuthoritySnapshot: ({ pr_number }) => (scope === "commit-range"
        ? readyStickySnapshot({ prNumber: pr_number, reviewedSha: scenario.state.reviewedSha })
        : { repository_slug: SYNTHETIC_SLUG, pr_number, completeness: { status: "complete", pagination_exhausted: true, pages_fetched: 1 }, query_error: null, comments: [] }),
      isCommitAncestor: () => true,
      readConsumerSecondReviewRules: (input) => {
        scenario.rulesInputs.push(input);
        return builder.readConsumerSecondReviewRules(input, { cwd: scenario.state.rulesCwd ?? repo.dir, spawnSyncImpl: recorder });
      },
      assertCanonicalCarrierRoot: (candidate) => builder.assertCanonicalCarrierRoot(candidate, fakeRepo),
      ...overrides,
    };
  };
  scenario.argv = ({ tail = [] } = {}) => [String(prNumber), ...(lite ? ["--branch", branch, "--lite"] : ["--change", change]), "--carrier-root", root, ...tail];
  scenario.run = async ({ tail = [], dependencies = {}, primaryFamily = "claude" } = {}) => builder.buildPrStickyHandoff({ argv: scenario.argv({ tail }), primaryFamily, env: modelProbeTestEnv(), dependencies: scenario.dependencies(dependencies) });
  // The same run through the CLI mapping: { code, stdout, stderr } as the process would show them.
  scenario.cli = async ({ tail = [], dependencies = {}, primaryFamily = "claude" } = {}) => {
    const out = [];
    const err = [];
    const code = await builder.runBuilderCli({
      argv: scenario.argv({ tail }),
      build: ({ argv }) => builder.buildPrStickyHandoff({ argv, primaryFamily, env: modelProbeTestEnv(), dependencies: scenario.dependencies(dependencies) }),
      stdout: { write: (chunk) => out.push(String(chunk)) },
      stderr: { write: (chunk) => err.push(String(chunk)) },
    });
    return { code, stdout: out.join(""), stderr: err.join("") };
  };
  return scenario;
}

// A stopped run: the classification, a non-zero exit with empty stdout, and a carrier directory left exactly as it was.
async function assertStoppedRun(scenario, { classification, options = {}, endsWithSentence = true }) {
  const before = scenario.snapshot();
  let caught;
  try { await scenario.run(options); } catch (error) { caught = error; }
  assert.ok(caught, "the build must stop");
  assert.equal(caught.classification, classification, caught.message);
  if (endsWithSentence) assert.ok(caught.message.endsWith(NOT_WRITTEN), `the message ends with the fixed sentence: ${caught.message}`);
  assert.deepEqual(scenario.snapshot(), before, "a stopped run leaves the carrier directory as it was");
  const cli = await scenario.cli(options);
  assert.equal(cli.code, 1);
  assert.equal(cli.stdout, "", "a stopped run prints no handoff path");
  assert.equal(cli.stderr, `${caught.message}\n`);
  assert.deepEqual(scenario.snapshot(), before);
  assert.deepEqual(readdirSync(scenario.root).filter((name) => name.startsWith(".handoff-")), []);
  return caught;
}

test("runBuilderCli maps a successful build to exit code 0 and one stdout line holding the handoff path", async () => {
  const scenario = await makeRulesScenario();
  try {
    const { code, stdout, stderr } = await scenario.cli({ dependencies: { readConsumerSecondReviewRules: () => "" } });
    assert.equal(code, 0);
    assert.equal(stderr, "");
    assert.equal(stdout.endsWith("\n"), true);
    const lines = stdout.split("\n").filter((line) => line !== "");
    assert.equal(lines.length, 1, "stdout holds exactly one line");
    assert.equal(existsSync(lines[0]), true);
    assert.deepEqual(scenario.handoffFiles().map((name) => path.join(scenario.root, name)), lines);
  } finally { scenario.cleanup(); }
});

test("readPrMetadata normalizes baseRefOid to pr_base_sha, requests the documented gh fields and leaves the missing-record case alone", async () => {
  const { readPrMetadata, assertPrMetadataStable } = await import(pathToFileURL(builderPath));
  const slug = "devpro-tw/devpro-agent-rules";
  const response = (extra) => JSON.stringify({
    number: 2894, headRefName: "feature/x", headRefOid: "a".repeat(40), isCrossRepository: false,
    headRepository: { name: "devpro-agent-rules", nameWithOwner: slug }, headRepositoryOwner: { login: "devpro-tw" }, body: "body", ...extra,
  });
  const calls = [];
  const runImpl = (extra) => (command, args) => { calls.push([command, ...args]); return response(extra); };
  assert.equal(readPrMetadata(2894, slug, { runImpl: runImpl({ baseRefOid: "b".repeat(40) }) }).pr_base_sha, "b".repeat(40));
  // The gh field list is untouched: the base record is already requested, so no field is added.
  assert.equal(calls[0].at(-1), "number,headRefName,headRefOid,isCrossRepository,headRepository,headRepositoryOwner,body,title,url,state,baseRefOid,closingIssuesReferences");
  // A response without the field is not refused here; the reader that uses the value checks its format.
  const missing = readPrMetadata(2894, slug, { runImpl: runImpl({}) });
  assert.equal(missing.pr_base_sha, undefined);
  assert.equal(readPrMetadata(2894, slug, { runImpl: runImpl({ baseRefOid: "not-a-sha" }) }).pr_base_sha, "not-a-sha");
  // The stability check compares the base record, and an older stub without the field is not affected.
  const metadata = { number: 4123, repository_slug: "synthetic/example", head_branch: "feature/synthetic", head_sha: "a".repeat(40), body: "same body", pr_base_sha: "b".repeat(40) };
  assert.doesNotThrow(() => assertPrMetadataStable(metadata, { ...metadata }));
  assert.throws(() => assertPrMetadataStable(metadata, { ...metadata, pr_base_sha: "c".repeat(40) }), /metadata drift detected in pr_base_sha/);
  const { pr_base_sha: _omitted, ...withoutBase } = metadata;
  assert.doesNotThrow(() => assertPrMetadataStable(withoutBase, { ...withoutBase }));
});

test("A missing base record is not treated as no rules (the record is absent)", async () => {
  const scenario = await makeRulesScenario({ base: "rule one\n" });
  try {
    scenario.state.baseRecord = undefined;
    const caught = await assertStoppedRun(scenario, { classification: "source_read_failed" });
    assert.match(caught.message, /baseRefOid/);
    assert.deepEqual(scenario.gitCalls, [], "no git read is attempted without a valid base record");
    assert.equal(scenario.handoffFiles().length, 0);
  } finally { scenario.cleanup(); }
});

test("A missing base record is not treated as no rules (the record is not 40 lowercase hex)", async () => {
  const scenario = await makeRulesScenario({ base: "rule one\n" });
  try {
    for (const record of ["abc123", "A".repeat(40), "b".repeat(39), "b".repeat(41), `${"b".repeat(39)}g`, 12345, null]) {
      scenario.state.baseRecord = record;
      await assertStoppedRun(scenario, { classification: "source_read_failed" });
    }
    assert.deepEqual(scenario.gitCalls, [], "no git read is attempted without a valid base record");
  } finally { scenario.cleanup(); }
});

test("A changed base record prevents output", async () => {
  const scenario = await makeRulesScenario({ base: "Every handler logs the correlation id.\n" });
  try {
    scenario.state.finalBaseRecord = "c".repeat(40);
    await assertStoppedRun(scenario, { classification: "pr_metadata_drift", endsWithSentence: false });
    assert.equal(scenario.rulesInputs.length, 2, "the rules were read first in each of the two runs, then the final read drifted");
    assert.equal(scenario.metadataReads, 4, "each of the two runs read the metadata twice");
  } finally { scenario.cleanup(); }
});

test("A base record that stays the same and an older stub without the field build as before", async () => {
  const scenario = await makeRulesScenario();
  try {
    const dependencies = { readConsumerSecondReviewRules: () => "" };
    const handoff = readHandoff(await scenario.run({ dependencies }));
    assert.deepEqual(Object.keys(handoff).filter((key) => key !== "full_scope_reason"), keyOrder);
    const old = makeScenario();
    try { assert.deepEqual(Object.keys(readHandoff(await old.run())), keyOrder); } finally { old.cleanup(); }
  } finally { scenario.cleanup(); }
});

const withoutRulesStub = { readConsumerSecondReviewRules: () => "" };

test("Base commit rules reach the handoff as one unchanged string", async () => {
  const rules = "# Review rules of this repository\nEvery handler logs the correlation id.\n\n  Keep controllers thin.  \r\n";
  const scenario = await makeRulesScenario({ base: rules, head: "worktree and head only\n" });
  try {
    writeFileSync(path.join(scenario.repo.dir, RULES_REL), "working tree decoy\n");
    const handoff = readHandoff(await scenario.run());
    assert.equal(handoff.reviewer_constraints, rules, "the file text byte for byte, the heading line included, nothing trimmed");
    const keys = Object.keys(handoff);
    assert.equal(keys[keys.indexOf("done_when") + 1], "reviewer_constraints", "the key sits right after done_when");
    assert.deepEqual(keys.filter((key) => key !== "reviewer_constraints"), keyOrder);
    assert.deepEqual(scenario.rulesInputs, [{ prBaseSha: scenario.state.prBaseSha, headSha: scenario.state.headSha }]);
    // Fixed argv, no shell, no write: the three reads of the design plus the read-only head comparison.
    const { prBaseSha } = scenario.state;
    const blobOid = scenario.repo.git("rev-parse", `${prBaseSha}:${RULES_REL}`);
    assert.deepEqual(scenario.gitCalls[0], ["git", "cat-file", "-e", `${prBaseSha}^{commit}`]);
    assert.deepEqual(scenario.gitCalls[1], ["git", "ls-tree", "-z", prBaseSha, "--", RULES_REL]);
    assert.deepEqual(scenario.gitCalls[2], ["git", "cat-file", "blob", blobOid]);
    assert.ok(scenario.gitCalls.every((call) => call[0] === "git" && ["cat-file", "ls-tree", "merge-base"].includes(call[1])), JSON.stringify(scenario.gitCalls));
    assert.equal(scenario.gitCalls.flat().some((token) => token.includes("Every handler")), false, "rule text never reaches a command line");
  } finally { scenario.cleanup(); }
});

test("A pull request that deletes or edits the file is reviewed with the base version (the pull request deletes the file)", async () => {
  const scenario = await makeRulesScenario({ base: "base rule one\nbase rule two\n", head: null });
  try {
    assert.equal(readHandoff(await scenario.run()).reviewer_constraints, "base rule one\nbase rule two\n");
  } finally { scenario.cleanup(); }
});

test("A pull request that deletes or edits the file is reviewed with the base version (the pull request edits the text)", async () => {
  const scenario = await makeRulesScenario({ base: "base rule one\nbase rule two\n", head: "edited rule one\nbase rule two\nadded rule three\n" });
  try {
    assert.equal(readHandoff(await scenario.run()).reviewer_constraints, "base rule one\nbase rule two\n");
  } finally { scenario.cleanup(); }
});

test("Content added by the pull request is not applied to it (the pull request creates the file)", async () => {
  const scenario = await makeRulesScenario({ base: null, head: "rule created by the pull request\n" });
  try {
    const handoff = readHandoff(await scenario.run());
    assert.equal(scenario.rulesInputs.length, 1, "the reader ran against the recorded base");
    assert.equal(Object.hasOwn(handoff, "reviewer_constraints"), false);
    assert.deepEqual(Object.keys(handoff), keyOrder);
  } finally { scenario.cleanup(); }
});

test("Content added by the pull request is not applied to it (the pull request adds text)", async () => {
  const scenario = await makeRulesScenario({ base: "base rule\n", head: "base rule\nrule added by the pull request\n" });
  try {
    assert.equal(readHandoff(await scenario.run()).reviewer_constraints, "base rule\n");
  } finally { scenario.cleanup(); }
});

test("Commit-range re-review still reads the recorded base", async () => {
  const scenario = await makeRulesScenario({ base: "rule at the recorded base\n", mid: "rule inside the pull request\n", scope: "commit-range" });
  try {
    const handoff = readHandoff(await scenario.run());
    assert.deepEqual(handoff.review_scope, { kind: "commit-range", base_sha: scenario.state.reviewedSha, head_sha: scenario.state.headSha });
    assert.notEqual(scenario.state.reviewedSha, scenario.state.prBaseSha);
    assert.equal(handoff.reviewer_constraints, "rule at the recorded base\n");
    assert.equal(scenario.rulesInputs[0].prBaseSha, scenario.state.prBaseSha);
    assert.equal(scenario.gitCalls.flat().includes(scenario.state.reviewedSha), false, "the commit-range base is never used to read the rules");
  } finally { scenario.cleanup(); }
});

for (const scope of ["full-pr", "commit-range"]) {
  test(`No rules file leaves the handoff byte-identical (${scope} scope)`, async () => {
    const scenario = await makeRulesScenario({ base: null, mid: scope === "commit-range" ? null : undefined, scope });
    try {
      // The baseline is the same run with the empty-rules stub: that path adds nothing to the handoff.
      const expected = await scenario.run({ dependencies: withoutRulesStub });
      const actual = await scenario.run();
      assert.equal(scenario.rulesInputs.length, 1, "the real reader ran once, against the recorded base");
      assert.equal(actual, expected, "the content-addressed path is equal only when the bytes are equal");
      const handoff = readHandoff(actual);
      assert.equal(Object.hasOwn(handoff, "reviewer_constraints"), false);
      assert.deepEqual(Object.keys(handoff), keyOrder);
      assert.equal(handoff.review_scope.kind, scope);
      assert.equal(scenario.handoffFiles().length, 1);
    } finally { scenario.cleanup(); }
  });
}

test("A whitespace-only file is the same as no file", async () => {
  const scenario = await makeRulesScenario({ base: " \t\n\n   \r\n\t\n" });
  try {
    const expected = await scenario.run({ dependencies: withoutRulesStub });
    const actual = await scenario.run();
    assert.equal(scenario.rulesInputs.length, 1, "the real reader ran once, against the recorded base");
    assert.equal(actual, expected);
    assert.equal(Object.hasOwn(readHandoff(actual), "reviewer_constraints"), false);
  } finally { scenario.cleanup(); }
});

test("reviewer_constraints follows done_when, also after full_scope_reason, and an empty string adds no key", async () => {
  const scenario = await makeRulesScenario({ scope: "commit-range", mid: null });
  try {
    const text = "alpha rule\nbeta rule\n";
    const rules = { readConsumerSecondReviewRules: () => text };
    const narrow = readHandoff(await scenario.run({ dependencies: rules }));
    assert.equal(narrow.reviewer_constraints, text);
    assert.deepEqual(Object.keys(narrow).filter((key) => key !== "reviewer_constraints"), keyOrder);
    const fallback = readHandoff(await scenario.run({ dependencies: { ...rules, isCommitAncestor: () => false } }));
    const keys = Object.keys(fallback);
    assert.equal(keys[keys.indexOf("review_scope") + 1], "full_scope_reason");
    assert.equal(keys[keys.indexOf("done_when") + 1], "reviewer_constraints");
    const external = readHandoff(await scenario.run({ tail: ["--external-evaluator", "Gemini CLI"], dependencies: rules }));
    const externalKeys = Object.keys(external);
    assert.equal(externalKeys[externalKeys.indexOf("done_when") + 1], "reviewer_constraints");
    assert.deepEqual(externalKeys.slice(-2), ["executor_kind", "reviewer_tool"]);
    assert.equal(Object.hasOwn(readHandoff(await scenario.run({ dependencies: withoutRulesStub })), "reviewer_constraints"), false);
  } finally { scenario.cleanup(); }
});

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const RULES_PREFIX = (side) => new RegExp(`^consumer_review_rules_invalid: ${escapeRegExp(RULES_REL)} at ${side} commit [0-9a-f]{12}: `);
// Assembled at run time so this file holds no credential-shaped literal.
const SHAPED_CREDENTIAL = `Connect with ${"pass"}${"word"}=${"Sup3r"}${"S3cret"} first.`;
const INVALID_UTF8 = Buffer.from([0x72, 0x75, 0x6c, 0x65, 0xff, 0xfe, 0x0a]);
// Valid text of exactly `size` bytes: whole lines plus a dash tail.
const rulesOfSize = (size) => {
  const line = "Keep controllers thin.\n";
  const body = line.repeat(Math.floor(size / line.length));
  return `${body}${"-".repeat(size - body.length)}`;
};

// Builds the scenario, expects the consumer_review_rules_invalid stop on the given side, then runs `check`.
async function assertRulesInvalid(scenarioOptions, { side = "base", includes = [], excludes = [], check } = {}) {
  const scenario = await makeRulesScenario(scenarioOptions);
  try {
    const caught = await assertStoppedRun(scenario, { classification: "consumer_review_rules_invalid" });
    assert.match(caught.message, RULES_PREFIX(side));
    for (const fragment of includes) assert.ok(caught.message.includes(fragment), `the message names ${JSON.stringify(fragment)}: ${caught.message}`);
    for (const fragment of excludes) assert.ok(!caught.message.includes(fragment), `the message must not repeat ${JSON.stringify(fragment)}: ${caught.message}`);
    assert.equal(scenario.handoffFiles().length, 0);
    if (check) await check(caught, scenario);
    return caught;
  } finally { scenario.cleanup(); }
}

test("A file longer than the byte limit stops the build and exactly the limit builds", async () => {
  await assertRulesInvalid({ base: rulesOfSize(CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES + 1) }, {
    includes: ["too-large in the whole file", `${CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES + 1} bytes, limit ${CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES}`],
    excludes: ["Keep controllers thin"],
  });
  const exact = await makeRulesScenario({ base: rulesOfSize(CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES) });
  try {
    const { reviewer_constraints: text } = readHandoff(await exact.run());
    assert.equal(Buffer.byteLength(text), CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES, "nothing is shortened");
  } finally { exact.cleanup(); }
});

test("A whitespace-only file over the byte limit stops the build because the size check runs first", async () => {
  await assertRulesInvalid({ base: " ".repeat(CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES + 1) }, { includes: ["too-large"] });
});

test("Undecodable content stops the build (not UTF-8)", async () => {
  await assertRulesInvalid({ base: INVALID_UTF8 }, { includes: ["invalid-utf8 in the whole file"] });
});

test("Undecodable content stops the build (NUL byte)", async () => {
  await assertRulesInvalid({ base: "first rule\nzq9nulentry\u0000word\n" }, { includes: ["nul-byte in the whole file"], excludes: ["zq9nulentry"] });
});

test("A path that is not a regular file stops the build (symbolic link)", async () => {
  await assertRulesInvalid({ base: { symlink: "link-target.txt" } }, {
    includes: ["not-a-regular-file"],
    check: (_caught, scenario) => assert.equal(scenario.gitCalls.some((call) => call[1] === "cat-file" && call[2] === "blob"), false, "neither the link nor its target is read as a blob"),
  });
});

test("A path that is not a regular file stops the build (directory)", async () => {
  await assertRulesInvalid({ base: { dir: true } }, {
    includes: ["not-a-regular-file"],
    check: (_caught, scenario) => assert.equal(scenario.gitCalls.some((call) => call[1] === "cat-file" && call[2] === "blob"), false),
  });
});

test("A path that is not a regular file stops the build (submodule)", async () => {
  await assertRulesInvalid({ base: { gitlink: "1".repeat(40) } }, {
    includes: ["not-a-regular-file"],
    check: (_caught, scenario) => assert.equal(scenario.gitCalls.some((call) => call[1] === "cat-file" && call[2] === "blob"), false),
  });
});

test("Credential-shaped text stops the build and ordinary rules do not (credential-shaped text)", async () => {
  await assertRulesInvalid({ base: `Plain first rule.\n${SHAPED_CREDENTIAL}\n` }, {
    includes: ["credential-shape in the whole file"],
    excludes: [["Sup3r", "S3cret"].join("")],
  });
});

test("Credential-shaped text stops the build and ordinary rules do not (ordinary markdown)", async () => {
  const ordinary = "# Rules\n\n- Every handler logs the correlation id.\n- Prefer small functions; never swallow exceptions in OrderService.Handle().\n- 每個公開方法都要有單元測試。\n- Do not log the Authorization header.\n";
  const scenario = await makeRulesScenario({ base: ordinary });
  try { assert.equal(readHandoff(await scenario.run()).reviewer_constraints, ordinary); } finally { scenario.cleanup(); }
});

test("The message never repeats the file text", async () => {
  const sentinel = "zq9sentinelrulephrase";
  await assertRulesInvalid({ base: `Keep ${sentinel} private and connect with ${"pass"}${"word"}=${"Sup3r"}${"S3cret"} first.\n` }, {
    includes: ["credential-shape"],
    excludes: [sentinel, ["Sup3r", "S3cret"].join(""), "private"],
  });
});

test("A byte order mark does not stop the build and is not carried", async () => {
  const scenario = await makeRulesScenario({ base: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("first rule\nsecond rule\n", "utf8")]) });
  try {
    const { reviewer_constraints: text } = readHandoff(await scenario.run());
    assert.equal(text, "first rule\nsecond rule\n");
    assert.equal(text.charCodeAt(0), "f".charCodeAt(0), "the text does not start with the byte order mark");
  } finally { scenario.cleanup(); }
});

// A pull request branch forked from `forkRules`; the base branch then moves on to `baseRules`.
// The head keeps the rules file it was forked with unless `headRules` changes it.
function forkedTopology({ forkRules, baseRules, headRules = KEEP }) {
  return (repo) => {
    repo.commit(forkRules, "fork point");
    const mainBranch = repo.git("symbolic-ref", "--short", "HEAD");
    repo.git("checkout", "-q", "-b", "pr-branch");
    const headSha = repo.commit(headRules, "pull request head");
    repo.git("checkout", "-q", mainBranch);
    return { prBaseSha: repo.commit(baseRules, "base moved on"), headSha };
  };
}

test("A pull request that breaks the file is stopped in that pull request (the pull request edits it into a broken version)", async () => {
  await assertRulesInvalid({ base: "ordinary rule\n", head: "ordinary rule\nzq9headtext\u0000\n" }, {
    side: "head",
    includes: ["nul-byte", "fix the rules file in this pull request", "re-run the builder"],
    excludes: ["zq9headtext", "repository owner decides"],
    check: (caught, scenario) => {
      assert.ok(caught.message.includes(`head commit ${scenario.state.headSha.slice(0, 12)}`));
      assert.equal(caught.message.includes("base commit"), false);
    },
  });
});

test("A pull request that breaks the file is stopped in that pull request (the pull request creates a broken file)", async () => {
  await assertRulesInvalid({ base: null, head: Buffer.from([0x72, 0xff, 0xfe, 0x0a]) }, { side: "head", includes: ["invalid-utf8"] });
});

test("A pull request that breaks the file is stopped in that pull request (the pull request makes it too large)", async () => {
  await assertRulesInvalid({ base: "ordinary rule\n", head: rulesOfSize(CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES + 1) }, { side: "head", includes: ["too-large"] });
});

test("A pull request that breaks the file is stopped in that pull request (the pull request adds credential-shaped text)", async () => {
  await assertRulesInvalid({ base: "ordinary rule\n", head: `ordinary rule\n${SHAPED_CREDENTIAL}\n` }, { side: "head", includes: ["credential-shape"], excludes: [["Sup3r", "S3cret"].join("")] });
});

test("A pull request that breaks the file is stopped in that pull request (the pull request turns it into a symbolic link)", async () => {
  await assertRulesInvalid({ base: "ordinary rule\n", head: { symlink: "elsewhere.txt" } }, { side: "head", includes: ["not-a-regular-file"] });
});

test("A pull request that deletes the file is not stopped by the head check", async () => {
  const scenario = await makeRulesScenario({ base: "ordinary rule\n", head: null });
  try { assert.equal(readHandoff(await scenario.run()).reviewer_constraints, "ordinary rule\n"); } finally { scenario.cleanup(); }
});

test("A head version the pull request did not change is not validated (the merge base has the same version)", async () => {
  // The branch was forked with a version that is invalid today; the base branch has since moved on to a valid one.
  const scenario = await makeRulesScenario({ topology: forkedTopology({ forkRules: INVALID_UTF8, baseRules: "new valid rule\n" }) });
  try {
    const handoff = readHandoff(await scenario.run());
    assert.equal(handoff.reviewer_constraints, "new valid rule\n");
    const mergeBaseCall = scenario.gitCalls.find((call) => call[1] === "merge-base");
    assert.deepEqual(mergeBaseCall, ["git", "merge-base", "--all", scenario.state.prBaseSha, scenario.state.headSha]);
  } finally { scenario.cleanup(); }
});

for (const [label, answer] of [
  ["the merge base is not unique", { status: 0, stdout: Buffer.from(`${"a".repeat(40)}\n${"b".repeat(40)}\n`) }],
  ["no merge base can be computed", { status: 1, stdout: Buffer.alloc(0) }],
]) {
  test(`A head version the pull request did not change is not validated (${label}: the base record is compared with the head)`, async () => {
    const scenario = await makeRulesScenario({ topology: forkedTopology({ forkRules: INVALID_UTF8, baseRules: "new valid rule\n" }) });
    try {
      scenario.state.mergeBaseAnswer = answer;
      const caught = await assertStoppedRun(scenario, { classification: "consumer_review_rules_invalid" });
      assert.match(caught.message, RULES_PREFIX("head"));
      assert.ok(caught.message.includes("invalid-utf8"));
    } finally { scenario.cleanup(); }
  });
}

test("A head version the pull request did not change is not validated (the head file equals the base file)", async () => {
  const scenario = await makeRulesScenario({ base: "same valid rule\n", head: KEEP });
  try { assert.equal(readHandoff(await scenario.run()).reviewer_constraints, "same valid rule\n"); } finally { scenario.cleanup(); }
});

test("An invalid base version stops the pull request that fixes it", async () => {
  await assertRulesInvalid({ base: INVALID_UTF8, head: "repaired valid rule\n" }, {
    side: "base",
    includes: ["invalid-utf8", "repository owner decides", "Path W waiver", "chore/", "merged or rebased", "once the user has closed the old pull request"],
    excludes: ["head commit"],
    check: (caught, scenario) => {
      assert.ok(caught.message.includes(`base commit ${scenario.state.prBaseSha.slice(0, 12)}`), "the message prints the base commit it read");
      assert.equal(scenario.handoffFiles().length, 0, "the head version is not applied instead");
    },
  });
});

const EXTERNAL_TAIL = ["--external-evaluator", "Gemini CLI"];

test("External evaluator and lite handoffs carry the same rules", async () => {
  const rules = "# the list\nEvery handler logs the correlation id.\n\nKeep controllers thin.\n";
  const standard = await makeRulesScenario({ base: rules, head: "head only\n" });
  const lite = await makeRulesScenario({ base: rules, lite: true });
  try {
    assert.equal(readHandoff(await standard.run()).reviewer_constraints, rules);
    const external = readHandoff(await standard.run({ tail: EXTERNAL_TAIL }));
    assert.equal(external.reviewer_constraints, rules);
    assert.equal(external.executor_kind, "external-evaluator");
    assert.equal(readHandoff(await lite.run()).reviewer_constraints, rules);
    assert.equal(readHandoff(await lite.run({ tail: EXTERNAL_TAIL })).reviewer_constraints, rules);
  } finally { standard.cleanup(); lite.cleanup(); }
});

// Assembled at run time so this file holds no home-directory path, address or key literal.
const PATTERN_SAMPLES = [
  ["a personal path", `Do not paste ${["", "home", "alice", "notes"].join("/")} into a reply.`, "pii:unix-home-path", "alice"],
  ["a cloud access key id", `Reject ${"AKIA"}${"Q".repeat(16)} style ids.`, "secret:aws_access_key_id", `${"AKIA"}${"Q".repeat(16)}`],
];
// The three execution modes: the runner handoff, --lite and --external-evaluator.
const PATTERN_MODES = [
  ["runner", {}, {}],
  ["lite", { lite: true }, {}],
  ["external evaluator", {}, { tail: EXTERNAL_TAIL }],
];

async function assertPatternStop(scenarioOptions, runOptions, { side, line, category, leaked, mode }) {
  const scenario = await makeRulesScenario(scenarioOptions);
  try {
    const caught = await assertStoppedRun(scenario, { classification: "consumer_review_rules_invalid", options: runOptions });
    assert.match(caught.message, RULES_PREFIX(side), mode);
    for (const fragment of ["pii-or-secret-pattern", `line ${line}`, category]) assert.ok(caught.message.includes(fragment), `${mode} ${fragment}: ${caught.message}`);
    assert.equal(caught.message.includes(leaked), false, `${mode}: the matched text is not repeated`);
    assert.equal(caught.message.includes("Ordinary"), false, `${mode}: no other text of the file is repeated`);
    assert.deepEqual(scenario.handoffFiles(), [], `${mode}: no handoff is written`);
  } finally { scenario.cleanup(); }
}

for (const [label, text, category, leaked] of PATTERN_SAMPLES) {
  for (const [mode, scenarioOptions, runOptions] of PATTERN_MODES) {
    test(`A PII or secret pattern stops the handoff in every execution mode (${label}, ${mode})`, async () => {
      await assertPatternStop({ ...scenarioOptions, base: `Ordinary first rule.\nOrdinary second rule.\n${text}\nOrdinary fourth rule.\n` }, runOptions, { side: "base", line: 3, category, leaked, mode });
    });

    test(`A pull request that adds a PII or secret pattern is stopped in that pull request (${label}, ${mode})`, async () => {
      await assertPatternStop({ ...scenarioOptions, base: "Ordinary first rule.\n", head: `Ordinary first rule.\nOrdinary second rule.\n${text}\n` }, runOptions, { side: "head", line: 3, category, leaked, mode });
    });
  }
}

test("A PII or secret pattern in a head version the pull request did not change is not matched", async () => {
  const [, text] = PATTERN_SAMPLES[0];
  const scenario = await makeRulesScenario({ topology: forkedTopology({ forkRules: `${text}\n`, baseRules: "new valid rule\n" }) });
  try { assert.equal(readHandoff(await scenario.run()).reviewer_constraints, "new valid rule\n"); } finally { scenario.cleanup(); }
});

test("A file with an integrity problem is not pattern-matched", async () => {
  const [, text] = PATTERN_SAMPLES[0];
  const scenario = await makeRulesScenario({ base: `Ordinary first rule\u0000\n${text}\n` });
  try {
    const caught = await assertStoppedRun(scenario, { classification: "consumer_review_rules_invalid" });
    assert.ok(caught.message.includes("nul-byte"), caught.message);
    assert.equal(caught.message.includes("pii-or-secret-pattern"), false, "the integrity stop comes first; the patterns run only over a version that passed it");
  } finally { scenario.cleanup(); }
});

test("A problem code is listed at most five times, the rest is counted, and every code present is named", async () => {
  const [, text] = PATTERN_SAMPLES[0];
  await assertRulesInvalid({ base: `${Array.from({ length: 8 }, () => text).join("\n")}\n` }, {
    includes: ["(+3 more)", "pii-or-secret-pattern: review stops in every execution mode"],
    excludes: ["line 6"],
    check: (caught) => assert.equal(caught.message.split("pii-or-secret-pattern at line").length - 1, 5, caught.message),
  });
});

test("A stopped build leaves an earlier handoff untouched and prints no path", async () => {
  const scenario = await makeRulesScenario({ base: "Every handler logs the correlation id.\n" });
  try {
    const first = await scenario.cli();
    assert.equal(first.code, 0, first.stderr);
    const earlier = scenario.snapshot();
    assert.equal(Object.keys(earlier).length, 1, "the first run left one handoff");
    // The recorded base now holds an invalid version of the file.
    scenario.state.prBaseSha = scenario.repo.commit("now an invalid rule\u0000\n", "base becomes invalid");
    scenario.gitCalls.length = 0;
    const second = await scenario.cli();
    assert.equal(second.code, 1);
    assert.equal(second.stdout, "", "no handoff path is printed");
    assert.ok(second.stderr.includes("consumer_review_rules_invalid"));
    assert.ok(second.stderr.trimEnd().endsWith(NOT_WRITTEN));
    assert.deepEqual(scenario.snapshot(), earlier, "file names, bytes and modes are as they were, including the earlier handoff");
    assert.deepEqual(readdirSync(scenario.root).filter((name) => name.startsWith(".handoff-")), []);
    const caught = await assertStoppedRun(scenario, { classification: "consumer_review_rules_invalid" });
    assert.ok(caught.message.includes(scenario.state.prBaseSha.slice(0, 12)));
    assert.deepEqual(scenario.snapshot(), earlier);
  } finally { scenario.cleanup(); }
});

// Source repo: fork point A, a pull request branch A -> F1 -> F2, and a base branch that moved on to B afterwards (B is
// the recorded base and is not an ancestor of the head). The review clone has only the pull request branch.
function movedBaseTopology(repo) {
  repo.commit(null, "fork point");
  const mainBranch = repo.git("symbolic-ref", "--short", "HEAD");
  repo.git("checkout", "-q", "-b", "pr-branch");
  const reviewedSha = repo.commit(KEEP, "pull request first commit");
  const headSha = repo.commit(KEEP, "pull request head");
  repo.git("checkout", "-q", mainBranch);
  return { prBaseSha: repo.commit(null, "base moved on"), reviewedSha, headSha, mainBranch };
}

// A clone made over the git protocol (not a hardlinked copy), so the base-only commit really is absent from it.
function cloneWithoutBase(scenario) {
  const clone = path.join(scenario.temp, "review-clone");
  execFileSync("git", ["clone", "-q", "--no-local", "--single-branch", "--branch", "pr-branch", scenario.repo.dir, clone], { stdio: "ignore" });
  const hasBase = () => spawnSync("git", ["cat-file", "-e", `${scenario.state.prBaseSha}^{commit}`], { cwd: clone }).status === 0;
  assert.equal(hasBase(), false, "fixture precondition: the review clone lacks the recorded base commit");
  scenario.state.rulesCwd = clone;
  return { clone, hasBase };
}

test("Commit-range re-review stops when the recorded base commit is not local", async () => {
  const scenario = await makeRulesScenario({ topology: movedBaseTopology, scope: "commit-range" });
  try {
    cloneWithoutBase(scenario);
    const caught = await assertStoppedRun(scenario, { classification: "source_read_failed" });
    assert.ok(caught.message.includes(`git fetch origin ${scenario.state.prBaseSha}`), "the command carries the full 40-character commit id");
    assert.equal(scenario.state.prBaseSha.length, 40);
    assert.ok(caught.message.includes("re-run the builder"));
    assert.ok(caught.message.includes("merge the latest base branch into the pull request branch"));
    assert.ok(caught.message.endsWith(NOT_WRITTEN));
    assert.equal(scenario.gitCalls.some((call) => call.includes("fetch")), false, "the builder never fetches");
    assert.deepEqual(scenario.gitCalls[0], ["git", "cat-file", "-e", `${scenario.state.prBaseSha}^{commit}`]);
    assert.equal(scenario.handoffFiles().length, 0);
  } finally { scenario.cleanup(); }
});

test("Commit-range re-review is byte-identical once the recorded base commit is local", async () => {
  const scenario = await makeRulesScenario({ topology: movedBaseTopology, scope: "commit-range" });
  try {
    const { clone, hasBase } = cloneWithoutBase(scenario);
    // The fixture fetches the base branch from the source repository itself; the builder fetches nothing.
    execFileSync("git", ["fetch", "-q", scenario.repo.dir, scenario.state.mainBranch], { cwd: clone, stdio: "ignore" });
    assert.equal(hasBase(), true);
    const expected = await scenario.run({ dependencies: withoutRulesStub });
    const actual = await scenario.run();
    assert.equal(scenario.rulesInputs.length, 1, "the real reader ran against the clone");
    assert.equal(actual, expected, "equal content-addressed paths mean equal bytes");
    const handoff = readHandoff(actual);
    assert.equal(handoff.review_scope.kind, "commit-range");
    assert.equal(Object.hasOwn(handoff, "reviewer_constraints"), false);
    assert.deepEqual(Object.keys(handoff), keyOrder);
    assert.equal(scenario.gitCalls.some((call) => call.includes("fetch")), false);
  } finally { scenario.cleanup(); }
});

test("Full pull request scope keeps its existing stop when the recorded base commit is not local", async () => {
  const scenario = await makeRulesScenario({ topology: movedBaseTopology, scope: "full-pr" });
  const builder = await import(pathToFileURL(builderPath));
  try {
    cloneWithoutBase(scenario);
    // The real material step, with the derivation that cannot find the base commit.
    const dependencies = { buildEmbeddedReviewMaterial: (reviewScope, options) => builder.buildEmbeddedReviewMaterial(reviewScope, { ...options, derive: () => null, listFiles: () => null }) };
    const caught = await assertStoppedRun(scenario, { classification: "review_material_unavailable", options: { dependencies }, endsWithSentence: false });
    assert.match(caught.message, /^authoritative PR review material could not be derived for the bound head/);
    assert.deepEqual(scenario.rulesInputs, [], "the consumer rules are not read before that stop");
    assert.deepEqual(scenario.gitCalls, []);
  } finally { scenario.cleanup(); }
});

test("A failed git read of the rules stops the build with source_read_failed and is never treated as no rules", async () => {
  const { readConsumerSecondReviewRules } = await import(pathToFileURL(builderPath));
  const base = "b".repeat(40);
  const head = "c".repeat(40);
  const oid = "d".repeat(40);
  const ok = (stdout = "") => ({ status: 0, stdout: Buffer.from(stdout) });
  const entry = `100644 blob ${oid}\t${RULES_REL}\0`;
  const scripted = (overrides) => (command, args) => {
    assert.equal(command, "git");
    const key = args[0] === "cat-file" ? `cat-file ${args[1]}` : args[0];
    if (key in overrides) return overrides[key];
    return { "cat-file -e": ok(), "ls-tree": ok(entry), "cat-file blob": ok("a rule\n"), "merge-base": ok(`${base}\n`) }[key];
  };
  const input = { prBaseSha: base, headSha: head };
  assert.deepEqual(readConsumerSecondReviewRules(input, { cwd: "unused", spawnSyncImpl: scripted({}) }), "a rule\n");
  const failures = {
    "the tree listing fails": { "ls-tree": { status: 128, stdout: Buffer.alloc(0) } },
    "the tree listing cannot be parsed": { "ls-tree": ok("not a tree entry\0") },
    "the blob read fails": { "cat-file blob": { status: 128, stdout: Buffer.alloc(0) } },
    "the blob exceeds the output buffer": { "cat-file blob": { error: Object.assign(new Error("spawnSync git ENOBUFS"), { code: "ENOBUFS" }), status: null, stdout: Buffer.alloc(0) } },
    "git cannot run": { "cat-file -e": { error: Object.assign(new Error("spawnSync git ENOENT"), { code: "ENOENT" }), status: null, stdout: Buffer.alloc(0) } },
  };
  for (const [label, overrides] of Object.entries(failures)) {
    assert.throws(
      () => readConsumerSecondReviewRules(input, { cwd: "unused", spawnSyncImpl: scripted(overrides) }),
      (error) => error.classification === "source_read_failed" && error.message.startsWith("source_read_failed: ") && error.message.endsWith(NOT_WRITTEN),
      label,
    );
  }
  // A head that is not a commit id is refused the same way.
  assert.throws(() => readConsumerSecondReviewRules({ ...input, headSha: "short" }, { cwd: "unused", spawnSyncImpl: scripted({}) }), (error) => error.classification === "source_read_failed" && error.message.endsWith(NOT_WRITTEN));
});

// Scenario: Linked issue PR marks issue-read mode
test("Linked issue PR marks issue-read mode: deriveLinkedIssueContext reads closing keywords, explicit references, issue URLs, the title and GitHub's closing references", async () => {
  const { deriveLinkedIssueContext } = await import(pathToFileURL(builderPath));
  assert.equal(typeof deriveLinkedIssueContext, "function", "the builder must derive linked_issue_context from the PR");
  const marked = [
    ["closing keyword", { body: "Closes #12" }],
    ["lower-case closing keyword in a list", { body: "- fixes #12" }],
    ["cross-repository reference", { body: "Resolves devpro-tw/devpro-agent-rules#12" }],
    ["issue URL", { body: "See https://github.com/devpro-tw/devpro-agent-rules/issues/12 for context" }],
    ["related-issue wording with a number", { body: "Related to #7 (follow-up)" }],
    ["title reference", { title: "Fix the retry loop (#12)", body: "" }],
    ["reference after a fenced block", { body: "```\nx\n```\nCloses #12" }],
    ["GitHub closing reference without any text", { body: "", closingIssueCount: 1 }],
    ["PR comment", { body: "", comments: ["unrelated", "Tracked in #12"] }],
  ];
  for (const [label, input] of marked) assert.equal(deriveLinkedIssueContext(input), "issue_read_required", label);
  const unmarked = [
    ["empty PR", {}],
    ["no reference", { title: "Clarify the guide", body: "No issue here." }],
    ["reference only inside a fenced block", { body: "```\nCloses #12\n```" }],
    ["reference only inside inline code", { body: "write `#12` literally" }],
    ["reference only inside an HTML comment", { body: "<!-- Closes #12 -->" }],
    ["word character before the hash", { body: "C#12 is a language version" }],
    ["word character after the number", { body: "#12abc and #abc" }],
    ["markdown heading", { body: "# Heading" }],
    ["issue number zero", { body: "#0" }],
    ["pull request URL", { body: "https://github.com/devpro-tw/devpro-agent-rules/pull/12" }],
    ["zero GitHub closing references", { body: "", closingIssueCount: 0 }],
    ["comments without a reference", { body: "", comments: ["looks good", "`#12` is code here", "<!-- Closes #12 -->"] }],
    ["non-string comment entries", { body: "", comments: [null, 7, {}] }],
  ];
  for (const [label, input] of unmarked) assert.equal(deriveLinkedIssueContext(input), "none", label);
});

// Scenario: Linked issue PR marks issue-read mode
test("Linked issue PR marks issue-read mode: the built handoff carries issue_read_required only when the PR references an issue, and keeps the exact key order", async () => {
  const { buildPrStickyHandoff, assertCanonicalCarrierRoot } = await import(pathToFileURL(builderPath));
  const proposalName = `synthetic-linked-issue-${Date.now()}`;
  const proposalPath = `openspec/changes/${proposalName}/proposal.md`;
  const headSha = "c".repeat(40);
  const branch = `feature/${proposalName}`;
  const proposal = { path: proposalPath, content: "head proposal blob", doneWhen: ["head state is carried"] };
  const bodyWith = (extra) => ["## Change Context", "", "Clarify the synthetic behavior", "Purpose: verify the issue marker", "", "## OpenSpec", "", `- change: \`openspec/changes/${proposalName}/\``, "", "## Requirement Ledger Completion", "", "The author reports strict validation passed.", "", "## Test Evidence", "", `The author reports focused tests passed.${extra}`, ""].join("\n");
  const rawDiff = contractFixture.review_material;
  const prNumber = 60000000 + Math.floor(Math.random() * 1000000);
  const temp = mkdtempSync(path.join(tmpdir(), "builder-linked-issue-root-"));
  const fakeRepo = path.join(temp, "repo");
  mkdirSync(fakeRepo);
  execFileSync("git", ["init", "-q"], { cwd: fakeRepo });
  const root = path.join(fakeRepo, "notes", "cross-review");
  mkdirSync(root, { recursive: true });
  const deps = (metadata) => ({
    readPrMetadata: (requestedNumber) => ({ number: requestedNumber, repository_slug: "synthetic/example", head_branch: branch, head_sha: headSha, ...metadata }),
    readProposalAtHead: () => proposal,
    readConsumerSecondReviewRules: () => "",
    buildEmbeddedReviewMaterial: (scope) => ({ changed_files_or_touch_list: ["docs/guide.md"], review_material: rawDiff, review_material_proof: canonicalEmbeddedReviewMaterialProof(scope, rawDiff) }),
    liveStickyAuthoritySnapshot: ({ pr_number }) => readyStickySnapshot({ prNumber: pr_number, reviewedSha: headSha }),
    assertCanonicalCarrierRoot: (candidate) => assertCanonicalCarrierRoot(candidate, fakeRepo),
  });
  const outputs = [];
  const build = async (offset, metadata) => {
    const output = await buildPrStickyHandoff({ argv: [String(prNumber + offset), "--change", proposalName, "--carrier-root", root], primaryFamily: "codex", dependencies: deps(metadata) });
    outputs.push(output);
    return JSON.parse(readFileSync(output, "utf8"));
  };
  try {
    const plain = await build(0, { body: bodyWith("") });
    assert.equal(plain.linked_issue_context, "none");
    const linked = await build(1, { body: bodyWith("\n\nCloses #12") });
    assert.equal(linked.linked_issue_context, "issue_read_required");
    const sidebar = await build(2, { body: bodyWith(""), closing_issue_count: 1 });
    assert.equal(sidebar.linked_issue_context, "issue_read_required", "an issue linked through GitHub's own closing references is marked even when the text does not name it");
    const titled = await build(3, { body: bodyWith(""), title: "Fix the retry loop (#12)" });
    assert.equal(titled.linked_issue_context, "issue_read_required");
    const withComments = async (offset, extraComments, stickyReason) => {
      const output = await buildPrStickyHandoff({
        argv: [String(prNumber + offset), "--change", proposalName, "--carrier-root", root],
        primaryFamily: "codex",
        dependencies: {
          ...deps({ body: bodyWith("") }),
          liveStickyAuthoritySnapshot: ({ pr_number }) => {
            const snapshot = readyStickySnapshot({ prNumber: pr_number, reviewedSha: headSha });
            snapshot.comments[0].body = snapshot.comments[0].body.replace("The bounded review completed for the requested scope.", stickyReason);
            snapshot.comments.push(...extraComments.map((body, index) => ({ id: 9000 + index, node_id: `IC_extra${index}`, html_url: `https://github.com/synthetic/example/pull/${pr_number}#issuecomment-${9000 + index}`, body, updated_at: "2026-09-30T20:55:29Z" })));
            return snapshot;
          },
        },
      });
      outputs.push(output);
      return JSON.parse(readFileSync(output, "utf8"));
    };
    const commented = await withComments(4, ["Please also check #12"], "The bounded review completed for the requested scope.");
    assert.equal(commented.linked_issue_context, "issue_read_required", "a PR comment that names an issue is a source");
    const ownSticky = await withComments(5, ["looks fine"], "Compared with #12 and found no change.");
    assert.equal(ownSticky.linked_issue_context, "none", "the reviewer's own sticky comment is not an author reference and never marks the PR");
    for (const handoff of [plain, linked, sidebar, titled, commented, ownSticky]) {
      assert.deepEqual(Object.keys(handoff).filter((key) => key !== "full_scope_reason"), keyOrder, "the marker changes a value, never the ordered key contract");
      assert.ok(["none", "issue_read_required"].includes(handoff.linked_issue_context), "the field stays a mode token and never carries issue text");
    }
  } finally { for (const output of outputs) unlinkSync(output); rmSync(temp, { recursive: true, force: true }); }
});

test("PR metadata drift also covers the title and the GitHub closing references the linked-issue marker is derived from", async () => {
  const { assertPrMetadataStable } = await import(pathToFileURL(builderPath));
  const base = { number: 4123, repository_slug: "synthetic/example", head_branch: "feature/x", head_sha: "a".repeat(40), body: "b", pr_base_sha: "c".repeat(40), title: "t", closing_issue_count: 0 };
  assert.equal(assertPrMetadataStable(base, { ...base }), true);
  for (const changed of [{ title: "t2" }, { closing_issue_count: 1 }]) {
    assert.throws(() => assertPrMetadataStable(base, { ...base, ...changed }), (error) => error.classification === "pr_metadata_drift");
  }
});
