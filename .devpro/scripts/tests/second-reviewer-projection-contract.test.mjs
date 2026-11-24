import "./lib/model-probe-fixture.mjs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  CLAUDE_REVIEWER_COMPLETION_JSON_SCHEMA_ARG,
  CLAUDE_REVIEWER_SYSTEM_PROMPT,
  SECOND_REVIEWER_MODEL_DEFAULTS,
  canonicalReviewerCliRecipe,
} from "../second-reviewer-cli-recipe-contract.mjs";

// Derived, never a second literal: the codex default model字面 lives only in
// SECOND_REVIEWER_MODEL_DEFAULTS so that changing it cannot leave this fence stale.
const CODEX_MODEL_ARG = `model="${SECOND_REVIEWER_MODEL_DEFAULTS.codex.model}"`;
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { readSecondReviewSkillWithHostRoutes } from "./lib/second-review-skill.mjs";
import { readRepoFile as read } from "./lib/read.mjs";

const TERMINAL_LEAF_GUARD =
  "DEVPRO_CROSS_MODEL_REVIEWER=1 is a terminal leaf; that process MUST NOT dispatch, probe, project, bootstrap, run any projection runner, or consume any wrapper sidecar.";

function readOptional(relPath) {
  const fullPath = repoPath(relPath);
  return existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
}

function assertIncludesAll(content, relPath, anchors) {
  const missing = anchors.filter((anchor) => !content.includes(anchor));
  assert.deepEqual(missing, [], `${relPath} missing route anchors: ${missing.join(", ")}`);
}

function assertAnchorsInOrder(content, relPath, anchors) {
  let cursor = 0;
  for (const anchor of anchors) {
    const index = content.indexOf(anchor, cursor);
    assert.notEqual(
      index,
      -1,
      `${relPath} missing ordered route anchor after byte ${cursor}: ${anchor}`
    );
    cursor = index + anchor.length;
  }
}

function assertTerminalLeafGuard(content, label) {
  const occurrenceCount = content.split(TERMINAL_LEAF_GUARD).length - 1;
  const matchingLines = content
    .split(/\r?\n/u)
    .filter((line) => line.includes(TERMINAL_LEAF_GUARD));
  assert.equal(
    occurrenceCount,
    1,
    `${label} must carry the complete terminal-leaf compound guard exactly once`,
  );
  assert.equal(
    matchingLines.length,
    1,
    `${label} must carry exactly one same-line terminal-leaf compound guard`,
  );
}

describe("second-reviewer projection contract", () => {
  it("projection wrappers consume the canonical Codex argv instead of copying it", () => {
    const neutralCwdPath = path.join(REPO_ROOT, "notes", "tmp", "neutral-reviewer-cwd");
    const args = canonicalReviewerCliRecipe({
      reviewer_family: "codex",
      mode: "audit-only",
      linked_issue_context: "none",
      neutral_cwd_path: neutralCwdPath,
    }).required_invocation_args;

    assert.deepEqual(
      args,
      [
        "exec",
        "--json",
        "-C",
        neutralCwdPath,
        "--ignore-rules",
        "--skip-git-repo-check",
        "-s",
        "workspace-write",
        "-c",
        "sandbox_workspace_write.network_access=true",
        "-c",
        'model_reasoning_effort="xhigh"',
        "-c",
        CODEX_MODEL_ARG,
        "-",
      ],
      "canonical Codex invocation must retain its exact ordered argv"
    );

    for (const relPath of [
      ".claude/agents/dp-second-reviewer.md",
      ".codex/agents/dp-second-reviewer.toml",
    ]) {
      const projection = read(relPath);
      assert.doesNotMatch(
        projection,
        /\["exec","--json","-C"/,
        `${relPath} must not copy the canonical Codex argv`
      );
    }
    assertIncludesAll(read(".claude/agents/dp-second-reviewer.md"), ".claude/agents/dp-second-reviewer.md", [
      ".devpro/scripts/second-reviewer-cli-recipe-contract.mjs",
      "canonicalReviewerCliRecipe",
      "reviewer_cli_recipe.required_invocation_args",
    ]);
  });

  it("canonical Codex invocation grants no repo-checkout writable root via --add-dir (issue #1735 regression fence)", () => {
    const neutralCwdPath = path.join(REPO_ROOT, "notes", "tmp", "neutral-reviewer-cwd");
    const args = canonicalReviewerCliRecipe({
      reviewer_family: "codex",
      mode: "audit-only",
      linked_issue_context: "none",
      neutral_cwd_path: neutralCwdPath,
    }).required_invocation_args;

    assert.ok(
      !args.includes("--add-dir"),
      `canonical Codex invocation must not grant a second writable root via --add-dir; got ${JSON.stringify(args)}`
    );
    assert.equal(
      args.length,
      15,
      `canonical Codex invocation must carry exactly 15 argv elements (network -c plus model_reasoning_effort -c plus model -c) with no --add-dir; got ${args.length}: ${JSON.stringify(args)}`
    );
    assert.equal(
      args[args.length - 1],
      "-",
      `canonical Codex invocation must end with the stdin marker "-"; got ${JSON.stringify(args)}`
    );
  });

  it("canonical Claude recipes pin exact mode-specific argv with the best selector and selected effort", () => {
    for (const effort of ["xhigh", "max"]) {
      const auditOnlyArgs = canonicalReviewerCliRecipe({
        reviewer_family: "claude",
        mode: "audit-only",
        linked_issue_context: "none",
      }, { selected_effort: effort }).required_invocation_args;
      const prStickyArgs = canonicalReviewerCliRecipe({
        reviewer_family: "claude",
        mode: "pr-sticky",
        linked_issue_context: "none",
      }, { selected_effort: effort }).required_invocation_args;

      assert.deepEqual(
        auditOnlyArgs,
        [
          "-p",
          "--safe-mode",
          "--system-prompt",
          CLAUDE_REVIEWER_SYSTEM_PROMPT,
          "--model",
          "fable",
          "--effort",
          effort,
          "--verbose",
          "--output-format",
          "stream-json",
          "--json-schema",
          CLAUDE_REVIEWER_COMPLETION_JSON_SCHEMA_ARG,
          "--include-partial-messages",
          "--include-hook-events",
          "--tools",
          "",
        ],
        `canonical Claude audit-only invocation must carry fable + ${effort}`
      );
      assert.deepEqual(
        prStickyArgs,
        [
          "-p",
          "--safe-mode",
          "--system-prompt",
          CLAUDE_REVIEWER_SYSTEM_PROMPT,
          "--model",
          "fable",
          "--effort",
          effort,
          "--verbose",
          "--output-format",
          "stream-json",
          "--json-schema",
          CLAUDE_REVIEWER_COMPLETION_JSON_SCHEMA_ARG,
          "--include-partial-messages",
          "--include-hook-events",
          "--tools",
          "Write,Bash",
          "--allowedTools",
          `Write,Bash(command -v gh),Bash(gh pr view:*),Bash(gh pr diff:*),Bash(node ${repoPath(".devpro/scripts/read-second-review-sticky-comment.mjs")}:*),Bash(node ${repoPath(".devpro/scripts/write-second-review-sticky-gated.mjs")}:*)`,
        ],
        `canonical Claude pr-sticky invocation must carry fable + ${effort}`
      );
      assert.doesNotMatch(JSON.stringify(auditOnlyArgs), /"--effort","high"/);
      assert.doesNotMatch(JSON.stringify(prStickyArgs), /"--effort","high"/);
    }
  });

  it("Codex-as-reviewer argv stays byte-stable (negative zero-regression)", () => {
    const neutralCwdPath = path.join(REPO_ROOT, "notes", "tmp", "neutral-reviewer-cwd");
    const before = [
      "exec",
      "--json",
      "-C",
      neutralCwdPath,
      "--ignore-rules",
      "--skip-git-repo-check",
      "-s",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-c",
      'model_reasoning_effort="xhigh"',
      "-c",
      CODEX_MODEL_ARG,
      "-",
    ];
    const args = canonicalReviewerCliRecipe({
      reviewer_family: "codex",
      mode: "audit-only",
      linked_issue_context: "none",
      neutral_cwd_path: neutralCwdPath,
    }).required_invocation_args;
    assert.deepEqual(args, before);
    assert.equal(args.includes("--effort"), false);
    assert.equal(args.includes("--model"), false);
  });

  it("canonical Claude recipes pin exact mode-specific argv", () => {
    const auditOnlyArgs = canonicalReviewerCliRecipe({
      reviewer_family: "claude",
      mode: "audit-only",
      linked_issue_context: "none",
    }, { selected_effort: "xhigh" }).required_invocation_args;
    const prStickyArgs = canonicalReviewerCliRecipe({
      reviewer_family: "claude",
      mode: "pr-sticky",
      linked_issue_context: "none",
    }, { selected_effort: "xhigh" }).required_invocation_args;

    assert.deepEqual(
      auditOnlyArgs,
      [
        "-p",
        "--safe-mode",
        "--system-prompt",
        CLAUDE_REVIEWER_SYSTEM_PROMPT,
        "--model",
        "fable",
        "--effort",
        "xhigh",
        "--verbose",
        "--output-format",
        "stream-json",
        "--json-schema",
        CLAUDE_REVIEWER_COMPLETION_JSON_SCHEMA_ARG,
        "--include-partial-messages",
        "--include-hook-events",
        "--tools",
        "",
      ],
      "canonical Claude audit-only invocation must retain its exact ordered safe-mode highest-effort argv"
    );
    assert.deepEqual(
      prStickyArgs,
      [
        "-p",
        "--safe-mode",
        "--system-prompt",
        CLAUDE_REVIEWER_SYSTEM_PROMPT,
        "--model",
        "fable",
        "--effort",
        "xhigh",
        "--verbose",
        "--output-format",
        "stream-json",
        "--json-schema",
        CLAUDE_REVIEWER_COMPLETION_JSON_SCHEMA_ARG,
        "--include-partial-messages",
        "--include-hook-events",
        "--tools",
        "Write,Bash",
        "--allowedTools",
        `Write,Bash(command -v gh),Bash(gh pr view:*),Bash(gh pr diff:*),Bash(node ${repoPath(".devpro/scripts/read-second-review-sticky-comment.mjs")}:*),Bash(node ${repoPath(".devpro/scripts/write-second-review-sticky-gated.mjs")}:*)`,
      ],
      "canonical Claude pr-sticky invocation must retain its exact ordered safe-mode highest-effort argv"
    );
  });

  it("canonical reviewer probe recipes use typed executable and argv carriers", () => {
    const claudeRecipe = canonicalReviewerCliRecipe({
      reviewer_family: "claude",
      mode: "audit-only",
      linked_issue_context: "none",
    }, { selected_effort: "xhigh" });
    const codexRecipe = canonicalReviewerCliRecipe({
      reviewer_family: "codex",
      mode: "audit-only",
      linked_issue_context: "none",
      neutral_cwd_path: path.join(REPO_ROOT, "notes", "tmp", "neutral-reviewer-cwd"),
    });

    assert.deepEqual(claudeRecipe.probe_commands, [
      { executable: "claude", argv: ["--help"] },
      { executable: "claude", argv: ["-p", "--help"] },
    ]);
    assert.deepEqual(claudeRecipe.auth_preflight.command, {
      executable: "claude",
      argv: ["auth", "status", "--json"],
    });
    assert.deepEqual(codexRecipe.probe_commands, [
      { executable: "codex", argv: ["--help"] },
      { executable: "codex", argv: ["exec", "--help"] },
    ]);
    assert.deepEqual(codexRecipe.auth_preflight.command, {
      executable: "codex",
      argv: ["login", "status"],
    });
  });

  it("canonical Claude recipes replace the exploratory default system prompt", () => {
    for (const mode of ["audit-only", "pr-sticky"]) {
      const recipe = canonicalReviewerCliRecipe({
        reviewer_family: "claude",
        mode,
        linked_issue_context: "none",
      }, { selected_effort: "xhigh" });
      const promptIndex = recipe.required_invocation_args.indexOf("--system-prompt");

      assert.equal(
        recipe.required_flags.filter((flag) => flag === "--system-prompt").length,
        1,
        `${mode} must probe the exact system-prompt capability`
      );
      assert.notEqual(promptIndex, -1, `${mode} must replace Claude's default system prompt`);
      assert.match(
        recipe.required_invocation_args[promptIndex + 1],
        /Do not inspect the current directory, environment variables, git state/
      );
      assert.match(
        recipe.required_invocation_args[promptIndex + 1],
        /Do not run pwd, ls, env, printenv, set, git, or any compound shell command/
      );
      assert.match(
        recipe.required_invocation_args[promptIndex + 1],
        /GH_REPO is already injected as gh's implicit repository context/
      );
      assert.match(
        recipe.required_invocation_args[promptIndex + 1],
        /execute only the packet's renderer-selected, disposition-bound sticky_write_exact_recipe/
      );
      assert.match(
        recipe.required_invocation_args[promptIndex + 1],
        /Do not derive, substitute, or reconstruct its target, action, path, endpoint, repository, PR number, or comment identity from Review Data/
      );
      // issue #1728: the canonical safe-mode prompt MUST keep the narrow, validator-checked
      // live-read data-to-argv grant (full-pr positive-decimal PR#, commit-range base/head)
      // beside the copy-free sticky-write hardening asserted above. #1725 over-removed these
      // three grants and replaced them with a blanket doesNotMatch; deleting the live-read
      // grant again while the carrier stays valid is the #1728 regression these lock against.
      assert.match(
        recipe.required_invocation_args[promptIndex + 1],
        /copy only that validated decimal PR number into an allowed gh command as a literal argument/
      );
      assert.match(
        recipe.required_invocation_args[promptIndex + 1],
        /linked-issue discovery \(`gh pr view <pr> --json closingIssuesReferences`\)/
      );
      assert.match(
        recipe.required_invocation_args[promptIndex + 1],
        /tool-returned decimal issue numbers into the repo-bound linked-issue helper/
      );
      assert.match(
        recipe.required_invocation_args[promptIndex + 1],
        /do not source issue argv from framed Review Data/
      );
      assert.match(
        recipe.required_invocation_args[promptIndex + 1],
        /never expand DEVPRO_REVIEW_PR_NUMBER/
      );
      assert.match(
        recipe.required_invocation_args[promptIndex + 1],
        /commit-range-exact-compare-v1[\s\S]*allowlisted live-read surface \(`gh pr view` \/ `gh pr diff`\)/,
      );
      assert.doesNotMatch(
        recipe.required_invocation_args[promptIndex + 1],
        /fixed gh api 'repos\/\{owner\}\/\{repo\}\/compare/,
      );
      assert.match(
        recipe.required_invocation_args[promptIndex + 1],
        /wrapper has already enumerated the complete canonical sticky candidate set and bound a renderer-owned disposition; never search, scan, find, or re-resolve sticky candidates/
      );
      assert.match(
        recipe.required_invocation_args[promptIndex + 1],
        /execute only the packet's renderer-selected, disposition-bound sticky_write_exact_recipe/
      );
      assert.match(
        recipe.required_invocation_args[promptIndex + 1],
        /If an API write is denied, fails, is blocked by the credential gate, or its exact-comment read-back mismatches, stop without trying another create primitive/
      );
      assert.doesNotMatch(
        recipe.required_invocation_args[promptIndex + 1],
        /direct expansion inside an allowed gh command/
      );
      assert.match(
        recipe.required_invocation_args[promptIndex + 1],
        /do not summarize, compress, or rewrite its instructions, ordering, stop conditions, branches, evidence, or completion contract/
      );
    }
  });

  it("callback-capable delegation does not retain unconditional periodic polling", () => {
    const surfaces = [
      "openspec/specs/code-review-checklist/spec.md",
      "openspec/changes/archive/2026-07-15-fix-second-reviewer-control-plane-recursion/specs/code-review-checklist/spec.md",
      "openspec/specs/cross-runtime-parity/spec.md",
      "openspec/changes/archive/2026-07-15-fix-second-reviewer-control-plane-recursion/specs/cross-runtime-parity/spec.md",
    ];
    for (const relPath of surfaces) {
      const content = read(relPath);
      assert.doesNotMatch(
        content,
        /first-60s activity, 60-second polling, 15-minute cap|TL MUST poll projection lifecycle[^\n]*every `60s`/,
        `${relPath} must scope polling to runtimes without callback/event support`
      );
      assert.match(content, /runtime (?:completion )?callback\/event/, `${relPath} must name the callback/event path`);
    }
    for (const relPath of [
      "openspec/specs/cross-runtime-parity/spec.md",
      "openspec/changes/archive/2026-07-15-fix-second-reviewer-control-plane-recursion/specs/cross-runtime-parity/spec.md",
    ]) {
      assert.match(
        read(relPath),
        /completion callback\/event[^\n]{0,220}MUST NOT use periodic polling or list-agents busy wait/,
        `${relPath} must use runtime callback/event notification when available`
      );
    }
  });

  it("Claude adapter mirrors the canonical exact ordered completion fields", () => {
    const canonical = read(".devpro/agent-skills/devpro-reviews/second-review/SKILL.md");
    const adapter = read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md");

    assert.match(
      canonical,
      /The exact compact completion JSON has `sticky_comment_url`、`verdict`、`last_reviewed_sha`、`reviewer_model`、and `reason` in that order\.[^\n]*`reason` is required for every verdict as a trimmed non-empty UTF-8 string of at most 8192 bytes\./,
      "devpro:second-review must retain the canonical five-field completion and reason contract"
    );
    assert.match(
      adapter,
      /Claude 完成後只回傳 exact ordered compact JSON（`sticky_comment_url`、`verdict`、`last_reviewed_sha`、`reviewer_model`、`reason`）[^\n]*`reason` MUST be a trimmed non-empty UTF-8 string of at most 8192 bytes/,
      "Claude adapter must mirror the exact ordered five-field completion and non-empty reason contract"
    );
  });

  it("Claude sticky happy path requires four bare dispatch-bound lines", () => {
    const canonical = read(".devpro/agent-skills/devpro-reviews/second-review/SKILL.md");
    const adapter = read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md");
    const canonicalSpecs = [
      read("openspec/specs/openspec-flow/spec.md"),
      read("openspec/specs/cross-runtime-parity/spec.md"),
    ].join("\n");

    assert.match(
      canonical,
      /verdict: PASS \| WARN \| CRITICAL \| UNAVAILABLE\r?\nlast_reviewed_sha: <head_ref_oid>\r?\ndispatch_id: <current_dispatch_id>\r?\nreason: <concise reason>/,
      "devpro:second-review must retain all four bare sticky schema lines"
    );
    assert.match(
      adapter,
      /V3 sticky action-point addendum：[^\n]*Canonical happy path and sticky-only retry MUST place bare `dispatch_id: <current dispatch_id>` after `last_reviewed_sha:` and before `reason:`/,
      "Claude sticky action points must preserve the current dispatch binding"
    );
    assert.match(
      canonicalSpecs,
      /static sticky template[^\n]*`dispatch_id: <current-dispatch-id>`/,
      "canonical OpenSpec specs must bind the static sticky template to the current dispatch"
    );
    assert.match(
      canonicalSpecs,
      /missing, stale, or mismatched current-dispatch evidence MUST fail closed/,
      "canonical OpenSpec specs must reject sticky evidence without current dispatch binding"
    );
  });

  it("Claude sticky schema self-check validates the bare bounded reason at its action point", () => {
    const adapter = read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md");

    assert.match(
      adapter,
      /Quick Review self-check MUST additionally match one bare `\^dispatch_id:[^\n]*require it to equal the renderer-reserved current dispatch/,
      "Claude sticky schema self-check must validate the reserved current dispatch"
    );
  });

  it("devpro:cross-review sticky verification validates the bare bounded reason at its action point", () => {
    const workflow = read(".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md");

    assertIncludesAll(workflow, ".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md", [
      "second-review-control-evidence.md",
      "blocked receipt",
      "current `dispatch_id`",
      "bounded non-empty `reason:`",
    ]);
    assertIncludesAll(workflow, ".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md", [
      "Post-PR exactly-one canonical current-head marker-matching `PASS`先保留consumer gate success",
      "later fault仍在`cli_exit.timed_out`保留transport/finalization診斷且不要求receipts",
      "`WARN`須無current fault與完整receipt chain",
    ]);
  });

  it("separates post-PR PASS authority from runner diagnostics and merge Path F", () => {
    const postPrGate = read(".devpro/agent-rules/post-pr-completion-gate.md");
    const mergeContract = read(".devpro/agent-rules/code-review-cross-model.md");
    const openspecFlow = read("openspec/specs/openspec-flow/spec.md");
    const checklistSpec = read("openspec/specs/code-review-checklist/spec.md");

    assertIncludesAll(postPrGate, ".devpro/agent-rules/post-pr-completion-gate.md", [
      "exactly one parseable canonical sticky：`verdict: PASS`、`last_reviewed_sha == headRefOid`、`dispatch_id == marker.expected_dispatch_id`",
      "Later same-dispatch tooling/orchestration fault仍保留為runner診斷",
      "不要求completion、fault-consumption、supersession或successor receipt",
    ]);
    assertIncludesAll(read(".devpro/agent-rules/post-pr-marker-disposition.md"), ".devpro/agent-rules/post-pr-marker-disposition.md", [
      "`WARN` 仍須無current fault",
    ]);
    assertIncludesAll(mergeContract, ".devpro/agent-rules/code-review-cross-model.md", [
      "actual merge hook Path F驗exactly one parseable canonical current-head sticky",
      "不消費post-PR marker expected dispatch、fault、completion、consumption、supersession或successor receipt",
      "shared negative fence拒絕known operator-disposed dispatch",
      "exactly one parseable canonical sticky `verdict: PASS | WARN` + `last_reviewed_sha == headRefOid`",
    ]);
    assertIncludesAll(openspecFlow, "openspec/specs/openspec-flow/spec.md", [
      "The Post-PR Completion Gate SHALL evaluate consumer authority separately from projection-runner terminal classification",
      "an exact-one parseable canonical sticky whose `verdict:` is `PASS`",
      "A later same-dispatch tooling/orchestration fault SHALL remain observable runner evidence",
      "`WARN` may satisfy post-PR readiness only through the existing no-current-fault and complete correctly bound completion/receipt-chain path",
      "This ordering SHALL NOT change merge-hook Path F",
    ]);
    assertIncludesAll(checklistSpec, "openspec/specs/code-review-checklist/spec.md", [
      "Projection-runner precedence in this requirement governs only terminal classification",
      "a later same-dispatch tooling/orchestration fault remains observable but does not require completion, consumption, supersession, or successor receipts",
      "Later runner fault remains observable without changing consumer authority",
    ]);

    assert.equal(
      mergeContract.includes("Path F：current-head `PASS | WARN`（sticky authority）且無 current allowlisted orchestration fault"),
      false,
      "mutation fence: merge Path F must not regain post-PR fault or receipt dependencies"
    );

    const timeoutAuthorityCarriers = [
      [
        ".devpro/agent-rules/platform-adapters/codex-cli-tooling.md",
        [
          "marker-bound exactly-one canonical current-head `PASS` preserves Post-PR completion",
          "`WARN` preserves Post-PR completion only with no current fault and a complete correctly bound completion/receipt chain",
        ],
      ],
      [
        ".devpro/agent-rules/platform-adapters/claude-code-cross-review.md",
        [
          "marker-bound exact-one current-head `PASS`優先",
          "Merge Path F獨立只驗exact-one current-head `PASS|WARN`，不讀local control evidence",
        ],
      ],
      [
        ".devpro/agent-rules/platform-adapters/codex.md",
        [
          "marker-bound exact-one current-head `PASS`優先",
          "Merge Path F獨立只驗exact-one current-head `PASS|WARN`，不讀local control evidence",
        ],
      ],
      [
        "openspec/specs/openspec-flow/spec.md",
        [
          "`WARN` SHALL satisfy Post-PR completion only through the existing no-current-fault and complete correctly bound completion/receipt-chain path",
          "Actual merge Path F remains independent and accepts exactly-one canonical current-head `PASS|WARN` without local marker, fault, completion, or receipt evidence",
        ],
      ],
      [
        "openspec/specs/cross-runtime-parity/spec.md",
        [
          "`WARN` SHALL still require no current fault and a complete correctly bound completion/receipt chain",
          "Actual merge Path F independently accepts exactly-one canonical current-head `PASS|WARN` without local marker, dispatch, fault, completion, or receipt evidence",
        ],
      ],
    ];

    for (const [path, anchors] of timeoutAuthorityCarriers) {
      const body = read(path);
      assertIncludesAll(body, path, anchors);
      assert.doesNotMatch(
        body,
        /fresh(?: current-head)? `PASS\s*\|\s*WARN`[^\n]*(?:satisf(?:y|ies)|preserves?|保留)[^\n]*(?:Post-PR completion|completion|(?:the )?gate(?: success)?|gate成功)/i,
        `${path}: timeout wording must not let WARN inherit authoritative-PASS fault override`
      );
    }

    const codexHostContract = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
    assertIncludesAll(codexHostContract, ".devpro/agent-rules/platform-adapters/codex-host-cross-review.md", [
      "actual merge Path F MUST NOT 讀取或依賴 local marker expected dispatch、fault、completion、consumption、supersession、successor 或 receipt state",
      "路徑 F（exactly one canonical `PASS|WARN` + matching current-head SHA）→ pass",
    ]);
    assert.doesNotMatch(
      codexHostContract,
      /路徑 F[^\n]*(?:matching SHA\/dispatch|無current fault|receipt chain)/,
      "Codex-host merge Path F must remain independent of post-PR local control evidence"
    );
  });

  it("Claude sticky-only retry preserves the canonical bare bounded reason at its action point", () => {
    const adapter = read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md");

    assert.match(
      adapter,
      /Canonical happy path and sticky-only retry MUST place bare `dispatch_id: <current dispatch_id>` after `last_reviewed_sha:` and before `reason:`/,
      "Claude sticky-only retry must preserve current dispatch binding and field order"
    );
  });

  it("aligns Claude and Codex on 60s samples, a 15m checkpoint, and a 30m hard cap", () => {
    const surfaces = [
      ".devpro/agent-rules/code-review-cross-model.md",
      ".devpro/agent-rules/pr-review-evidence-verification.md",
      ".devpro/agent-rules/platform-adapters/claude-code-cross-review.md",
      ".devpro/agent-rules/platform-adapters/codex-cli-tooling.md",
      ".devpro/agent-rules/platform-adapters/codex.md",
      ".devpro/agent-rules/platform-adapters/codex-host-cross-review.md",
      ".devpro/agent-rules/platform-adapters/codex-host-cross-review-troubleshooting.md",
      ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
      "openspec/specs/code-review-checklist/spec.md",
      "openspec/specs/cross-runtime-parity/spec.md",
      "openspec/specs/openspec-flow/spec.md",
      "openspec/changes/archive/2026-07-15-fix-second-reviewer-control-plane-recursion/specs/code-review-checklist/spec.md",
      "openspec/changes/archive/2026-07-15-fix-second-reviewer-control-plane-recursion/specs/cross-runtime-parity/spec.md",
      "openspec/changes/archive/2026-07-15-fix-second-reviewer-control-plane-recursion/specs/openspec-flow/spec.md",
    ];

    for (const relPath of surfaces) {
      // The dispatch-mechanics sibling joins the shared rule so the retired-vocabulary
      // negative checks still cover the text moved out of code-review-cross-model.md.
      const content = relPath === ".devpro/agent-rules/code-review-cross-model.md"
        ? read(relPath) + "\n" + read(".devpro/agent-rules/code-review-cross-model-cli-contract.md") + "\n" +
          read(".devpro/agent-rules/code-review-cross-model-dispatch-mechanics.md")
        : read(relPath);
      // A delta may retain retired wording only as the exact title of an
      // explicit REMOVED Requirement needed to migrate that title. Exclude
      // those historical disposition blocks from the active-contract scan.
      const activeContent = relPath.startsWith("openspec/changes/")
        ? content.replace(/^## REMOVED Requirements\r?\n[\s\S]*?(?=^## |$(?![\s\S]))/gm, "")
        : content;
      assert.match(content, /60s|60-second/, `${relPath} must carry the stream sample interval`);
      assert.match(content, /15m|15-minute/, `${relPath} must carry the status checkpoint`);
      assert.match(content, /30m|30-minute|30 分鐘/, `${relPath} must carry the total hard cap`);
      assert.match(content, /checkpoint|檢查點/, `${relPath} must classify 15m as a checkpoint`);
      assert.match(content, /callback|process close|程序關閉/i, `${relPath} must name the terminal event`);
      assert.doesNotMatch(
        content,
        /total hard cap `15m`|`15m` total hard cap|15-minute total hard cap/i,
        `${relPath} must not retain the old 15m total hard cap`
      );
      assert.doesNotMatch(
        activeContent,
        /idle-first|idle(?:-| )timeout|activity(?:-| )idle|stdout(?:\/stderr)?(?:-| )idle|reset[^\n。]{0,120}(?:activity )?idle/i,
        `${relPath} must not retain retired idle-timeout/reset-idle vocabulary`
      );
    }

    assert.match(
      read("openspec/changes/archive/2026-07-15-fix-second-reviewer-control-plane-recursion/specs/code-review-checklist/spec.md"),
      /^## REMOVED Requirements[\s\S]*^### Requirement: External reviewer wrappers use idle-first bounded timeout policy[\s\S]*^## MODIFIED Requirements[\s\S]*^### Requirement: External reviewer wrappers use bounded liveness checkpoint policy/m,
      "the retired title may survive only as an explicit remove/current-canonical migration"
    );

    const executableContract = [
      read(".devpro/agent-rules/code-review-cross-model.md"),
      read(".devpro/agent-rules/code-review-cross-model-cli-contract.md"),
      read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md"),
      read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md"),
      read("openspec/specs/code-review-checklist/spec.md"),
      read("openspec/specs/cross-runtime-parity/spec.md"),
    ].join("\n");
    assert.match(executableContract, /projection_cli_liveness_sampled/);
    assert.match(executableContract, /projection_cli_status_checkpoint/);
    assert.match(executableContract, /(?:不得|MUST NOT)[^\n]{0,200}(?:使用者授權|user authorization)/i);

    for (const relPath of [
      ".devpro/agent-rules/platform-adapters/claude-code-cross-review.md",
      ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
      "openspec/specs/code-review-checklist/spec.md",
      "openspec/specs/cross-runtime-parity/spec.md",
      "openspec/changes/archive/2026-07-15-fix-second-reviewer-control-plane-recursion/specs/code-review-checklist/spec.md",
      "openspec/changes/archive/2026-07-15-fix-second-reviewer-control-plane-recursion/specs/cross-runtime-parity/spec.md",
    ]) {
      assertIncludesAll(read(relPath), relPath, [
        "last_output_at",
        "idle_duration_ms",
        "process_started_at",
        "null",
      ]);
    }
    assertIncludesAll(
      read(".devpro/agent-rules/code-review-cross-model.md") + "\n" +
        read(".devpro/agent-rules/code-review-cross-model-cli-contract.md"),
      ".devpro/agent-rules/code-review-cross-model.md",
      ["second-review-control-evidence.md", "60s", "15m", "30m"]
    );
    assertIncludesAll(
      read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md"),
      ".devpro/agent-rules/platform-adapters/codex-host-cross-review.md",
      ["devpro:second-review", "second-review-control-evidence.md", "Direct runner liveness protocol"]
    );
  });

  it("bounds live lines and terminal evidence without whole-log classification", () => {
    const runner = read(".devpro/scripts/run-second-reviewer-projection.mjs");
    const runStart = runner.indexOf("function runReviewerCli");
    const runEnd = runner.indexOf("function recordCliExited", runStart);
    const classifyStart = runner.indexOf("function classifyCliExit");
    const classifyEnd = runner.indexOf("function pathsPayload", classifyStart);
    assert.ok(runStart >= 0 && runEnd > runStart, "runner body must remain discoverable");
    assert.ok(classifyStart >= 0 && classifyEnd > classifyStart, "classification body must remain discoverable");
    const runBody = runner.slice(runStart, runEnd);
    const classifyBody = runner.slice(classifyStart, classifyEnd);

    assert.match(runner, /maxReviewerOutputLineBytes = 64 \* 1024/);
    // stdout uses createReviewerOutputLineRouter (Claude thinking-aware); non-Claude
    // stdout still delegates to createBoundedLineAccumulator. Either path MUST feed
    // the same tool-surface + liveness observers from one line callback.
    assert.match(
      runBody,
      /stdout: createReviewerOutputLineRouter\([\s\S]*?inspectToolSurfaceLine\(line\.trim\(\)\);[\s\S]*?observeOutputLine\("stdout", line\);/,
      "one bounded stdout router must feed tool-surface and liveness observers"
    );
    assert.match(
      runner,
      /function createReviewerOutputLineRouter\([\s\S]*?return createBoundedLineAccumulator\(\{ onLine, onOverflow, maxBytes: genericMaxBytes \}\)/,
      "non-Claude stdout must still use the shared bounded line accumulator"
    );
    assert.doesNotMatch(runBody, /StringDecoder|stdoutLineBuffer|outputObservation/);
    assert.match(classifyBody, /extractBoundedTerminalEvidence\(context\)/);
    assert.doesNotMatch(
      classifyBody,
      /readFileSync\s*\(/,
      "end-of-run classification must not allocate whole reviewer logs"
    );
  });

  it("output-line overflow routing fails closed for both streams without family or tool-surface branching", () => {
    const runner = read(".devpro/scripts/run-second-reviewer-projection.mjs");
    const accumulatorsStart = runner.indexOf("const outputAccumulators = {");
    const accumulatorsEnd = runner.indexOf("function finishOutputAccumulators", accumulatorsStart);
    assert.ok(
      accumulatorsStart >= 0 && accumulatorsEnd > accumulatorsStart,
      "output accumulator wiring must remain discoverable"
    );
    const accumulatorsBody = runner.slice(accumulatorsStart, accumulatorsEnd);

    assert.match(
      accumulatorsBody,
      /stdout: createReviewerOutputLineRouter\([\s\S]*?onOverflow\(\{ maxBytes, \.\.\.diagnostic \}\) \{\s*failOutputLineLimit\("stdout", maxBytes, diagnostic\);\s*\}/,
      "stdout overflow must fail closed for every reviewer family"
    );
    assert.match(
      accumulatorsBody,
      /stderr: createBoundedLineAccumulator\([\s\S]*?onOverflow\(\) \{\s*failOutputLineLimit\("stderr"\);\s*\}/,
      "stderr overflow must fail closed for every reviewer family"
    );
    assert.doesNotMatch(
      accumulatorsBody,
      /requiresClaudeToolSurfaceEvidence|toolSurfaceCheck\.status|noteOutputLineTruncated|reviewer_output_line_truncated/,
      "overflow routing must not branch by reviewer family, tool-surface state, or truncate-and-continue state"
    );
    assert.doesNotMatch(
      runner,
      /\bsuppressed\b|outcome\s*===\s*["']truncate["']/,
      "the shared accumulator must not retain a dormant truncate-and-resume branch"
    );

    const activeDelta = "openspec/changes/strengthen-control-plane-evidence/specs/code-review-checklist/spec.md";
    const archiveRoot = repoPath("openspec/changes/archive");
    const archivedChangeNames = existsSync(archiveRoot)
      ? readdirSync(archiveRoot, { withFileTypes: true })
          .filter(
            (entry) =>
              entry.isDirectory() && entry.name.endsWith("-strengthen-control-plane-evidence")
          )
          .map((entry) => entry.name)
          .sort()
      : [];
    // Current SSOT is the promoted canonical scenario title (renamed from the
    // strengthen-control-plane-evidence delta wording). Keep the archived delta
    // as a fallback only when the active folder still exists for recovery.
    const canonicalSpec = "openspec/specs/code-review-checklist/spec.md";
    const scenarioTitleRe =
      /#### Scenario: (?:Every reviewer family and output stream fails closed at 65,537 bytes|Generic output and all stderr fail closed at 65,537 bytes)/;
    const specPaths = existsSync(repoPath(activeDelta))
      ? [activeDelta]
      : existsSync(repoPath(canonicalSpec))
        ? [canonicalSpec]
        : archivedChangeNames.length > 0
          ? [
              `openspec/changes/archive/${archivedChangeNames.at(-1)}/specs/code-review-checklist/spec.md`,
            ]
          : [];
    assert.ok(specPaths.length > 0, "overflow fail-closed scenario carrier must remain discoverable");
    for (const relPath of specPaths) {
      const content = read(relPath);
      assert.match(content, scenarioTitleRe);
      assert.match(content, /65,537 bytes/);
      assert.doesNotMatch(content, /reviewer_output_line_truncated|truncate-and-continue/);
    }

    const archiveRule = read(".devpro/agent-rules/openspec-archive-redo-undo.md");
    assert.match(archiveRule, /只供歷史資料補齊辨識、不是author workflow授權/);
    assert.match(archiveRule, /同commit canonical各自唯一/);
    assert.match(archiveRule, /任一失敗，MUST回落為archive-only/);
  });

  it("settles immediately when initial termination proves the reviewer transport is gone", () => {
    const runner = read(".devpro/scripts/run-second-reviewer-projection.mjs");
    const requestStart = runner.indexOf("function requestBoundedTermination");
    const requestEnd = runner.indexOf("function failToolSurface", requestStart);
    assert.ok(requestStart >= 0 && requestEnd > requestStart, "termination body must remain discoverable");
    const requestBody = runner.slice(requestStart, requestEnd);
    const cleanupCheck = requestBody.indexOf("reviewerTransportCleanupComplete(terminationResult)");
    const graceTimer = requestBody.indexOf("terminationGraceTimer = setTimeout");

    assert.ok(cleanupCheck >= 0, "termination must recognize already-cleared transport");
    assert.ok(graceTimer > cleanupCheck, "cleared transport must settle before scheduling grace escalation");
  });

  it("repo-external reviewer cwd does not expose cwd-relative local git or rg recipes", () => {
    const neutralCwdLocalReadRecipe = /(?:Bash\((?:git diff|git status|rg):\*\)|read-only\s+`?git diff`?\s*\/\s*`?git status`?\s*\/\s*`?rg`?)/i;
    for (const forbiddenExample of [
      "Bash(git diff:*)",
      "Bash(git status:*)",
      "Bash(rg:*)",
      "read-only `git diff` / `git status` / `rg`",
    ]) {
      assert.match(forbiddenExample, neutralCwdLocalReadRecipe);
    }
    for (const relPath of [
      ".devpro/agent-rules/platform-adapters/claude-code-cross-review.md",
      ".devpro/agent-rules/platform-adapters/codex-host-cross-review.md",
    ]) {
      const content = read(relPath);
      assert.doesNotMatch(content, neutralCwdLocalReadRecipe);
    }
  });

  it("common skill and runtime projections preserve the exact terminal-leaf boundary", () => {
    const relPaths = [
      ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
      ".claude/agents/dp-second-reviewer.md",
      ".codex/agents/dp-second-reviewer.toml",
      ".cursor/agents/dp-second-reviewer.md",
    ];

    for (const relPath of relPaths) {
      assertTerminalLeafGuard(read(relPath), relPath);
    }
  });

  it("terminal-leaf assertion rejects delete, duplicate, split-line, and weakened mutations", () => {
    const valid = `before\n${TERMINAL_LEAF_GUARD}\nafter`;
    const mutations = {
      delete: valid.replace(TERMINAL_LEAF_GUARD, ""),
      duplicate: valid.replace(TERMINAL_LEAF_GUARD, `${TERMINAL_LEAF_GUARD} ${TERMINAL_LEAF_GUARD}`),
      "split-line": valid.replace("probe, project", "probe,\nproject"),
      weakened: valid.replace("MUST NOT dispatch", "MUST dispatch"),
    };

    assertTerminalLeafGuard(valid, "valid fixture");
    for (const [mutation, content] of Object.entries(mutations)) {
      assert.throws(
        () => assertTerminalLeafGuard(content, mutation),
        assert.AssertionError,
        `${mutation} mutation must fail the terminal-leaf guard`,
      );
    }
  });

  it("shared rule and host adapters keep data/control-plane and recursion boundaries", () => {
    const surfaces = [
      ".devpro/agent-rules/code-review-cross-model.md",
      ".devpro/agent-rules/platform-adapters/claude-code-cross-review.md",
      ".devpro/agent-rules/platform-adapters/codex-host-cross-review.md",
    ];
    const anchors = [
      "reviewer-safe data plane",
      "wrapper-only sidecar",
      "repository_slug",
      "GH_REPO",
      "DEVPRO_REVIEW_PR_NUMBER",
    ];

    for (const relPath of surfaces) {
      // The shared rule keeps the data/control-plane naming anchor; its wrapper route
      // anchors moved verbatim to the dispatch-mechanics sibling, which must carry them.
      const shared = relPath === ".devpro/agent-rules/code-review-cross-model.md";
      assertIncludesAll(read(relPath), relPath, shared ? anchors.slice(0, 2) : anchors);
      if (shared) {
        const mechanics = ".devpro/agent-rules/code-review-cross-model-dispatch-mechanics.md";
        assertIncludesAll(read(mechanics), mechanics, anchors.slice(2));
      }
    }
    for (const relPath of [
      ".devpro/agent-rules/platform-adapters/claude-code-cross-review.md",
      ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
    ]) {
      assertIncludesAll(read(relPath), relPath, [
        "neutral_cwd_path",
        "projection_recursive_reentry",
        "projection_attempt_already_active",
      ]);
    }
    assertIncludesAll(
      read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md"),
      ".devpro/agent-rules/platform-adapters/codex-host-cross-review.md",
      ["devpro:second-review", "second-review-control-evidence.md"]
    );
  });

  it("Claude projection routes to the Codex reviewer chain", () => {
    const relPath = ".claude/agents/dp-second-reviewer.md";
    const content = read(relPath);

    assertIncludesAll(content, relPath, [
      ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
      "platform-adapters/claude-code.md",
      "platform-adapters/claude-code-cross-review.md",
      ".devpro/agent-skills-refs/autonomous-ai-agents/codex/SKILL.md",
      "platform-adapters/codex-cli-tooling.md",
      "codex exec --json",
      "same-family fallback",
      "cross-model-second-opinion:sticky",
      "verdict",
      "六軸",
    ]);
    assert.match(content, /Claude Code primary host|primary host.*Claude|本 Claude projection 預設 `claude`/);
  });

  it("Codex projection routes to the Claude reviewer chain", () => {
    const relPath = ".codex/agents/dp-second-reviewer.toml";
    const content = read(relPath);

    assertIncludesAll(content, relPath, [
      ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
      "platform-adapters/codex.md",
      "platform-adapters/codex-host-cross-review.md",
      ".devpro/agent-skills-refs/autonomous-ai-agents/claude-code/SKILL.md",
      "platform-adapters/claude-code-cross-review.md",
      "claude -p",
      "same-family fallback",
      "cross-model-second-opinion:sticky",
      "verdict",
      "六軸",
    ]);
    assert.match(
      content,
      /sandbox_mode = "danger-full-access"/,
      `${relPath} must run auth-required external reviewer CLI on a host/non-sandbox-capable surface`
    );
    assert.doesNotMatch(
      content,
      /default(?: reviewer)? (?:route|path)[^\n]*(?:codex exec|Codex reviewer|Codex-family)/i,
      `${relPath} must not make codex exec or Codex reviewer the default route`
    );
    assert.doesNotMatch(
      content,
      /(?:codex exec|Codex reviewer|Codex-family)[^\n]*default(?: reviewer)? (?:route|path)/i,
      `${relPath} must not make codex exec or Codex reviewer the default route`
    );
    assert.doesNotMatch(
      content,
      /\.claude\/agents\/dp-second-reviewer\.md/,
      `${relPath} must not route through the Claude projection`
    );
  });

  it("Cursor projection resolves primary_family before claiming cross-model diversity", () => {
    const relPath = ".cursor/agents/dp-second-reviewer.md";
    const content = read(relPath);

    assertIncludesAll(content, relPath, [
      ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
      "primary_family",
      "cross-model-second-opinion:sticky",
      "verdict",
      "六軸",
    ]);
    assert.match(
      content,
      /unknown|無法證明|cannot be proven/i,
      `${relPath} must cover unknown or unproven primary family`
    );
    assert.match(
      content,
      /不得.*宣稱 cross-model diversity|must not.*claim cross-model diversity/i,
      `${relPath} must not claim cross-model diversity for unresolved primary_family`
    );
    assert.doesNotMatch(
      content,
      /\.claude\/agents\/dp-second-reviewer\.md/,
      `${relPath} must not route through the Claude projection`
    );
  });

  it("Projection wrappers expose mandatory cross-host observability artifacts", () => {
    const hostRelPath = ".devpro/agent-rules/platform-adapters/codex-host-cross-review.md";
    const skillRelPath = ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md";
    const troubleshootingRelPath =
      ".devpro/agent-rules/platform-adapters/codex-host-cross-review-troubleshooting.md";
    const claudeCrossRelPath = ".devpro/agent-rules/platform-adapters/claude-code-cross-review.md";
    const codexToolingRelPath = ".devpro/agent-rules/platform-adapters/codex-cli-tooling.md";
    const claudeProjectionRelPath = ".claude/agents/dp-second-reviewer.md";
    const codexProjectionRelPath = ".codex/agents/dp-second-reviewer.toml";
    const rendererRelPath = ".devpro/scripts/render-second-review-packet.mjs";
    const recipeContractRelPath = ".devpro/scripts/second-reviewer-cli-recipe-contract.mjs";
    const host = read(hostRelPath);
    const skill = readSecondReviewSkillWithHostRoutes();
    const troubleshooting = read(troubleshootingRelPath);
    const claudeCross = read(claudeCrossRelPath);
    const codexTooling = read(codexToolingRelPath);
    const claudeProjection = read(claudeProjectionRelPath);
    const codexProjection = read(codexProjectionRelPath);
    const renderer = read(rendererRelPath);
    const recipeContract = read(recipeContractRelPath);
    const specText = [
      read("openspec/specs/code-review-checklist/spec.md"),
      read("openspec/specs/cross-runtime-parity/spec.md"),
      readOptional(
        "openspec/changes/strengthen-second-reviewer-idle-timeout/specs/code-review-checklist/spec.md"
      ),
      readOptional(
        "openspec/changes/strengthen-second-reviewer-idle-timeout/specs/cross-runtime-parity/spec.md"
      ),
      readOptional(
        "openspec/changes/add-second-reviewer-runner-permission/specs/cross-runtime-parity/spec.md"
      ),
    ].join("\n");
    const probeAndStickyAnchors = [
      "cli_probe_result_path",
      "projection_bootstrap_script",
      "projection_bootstrap_command",
      "projection_runner_script",
      "projection_runner_command",
      "cwd-independent absolute",
      ".devpro/scripts/ack-second-reviewer-projection.mjs",
      ".devpro/scripts/run-second-reviewer-projection.mjs",
      "exact `projection_runner_command`",
      "reviewer_cli_recipe",
      "required_invocation_args",
      "--verbose",
      "required_activity_events",
      "cli-probe-result.json",
      ".devpro/scripts/probe-second-reviewer-cli-recipe.mjs",
      "projection_cli_probe_started",
      "projection_cli_probe_result",
      "auth_preflight",
      "flags_supported",
      "reviewer_host_surface_unverified",
      "memory-only-do-not-persist",
      "required_flag_absent_in_host_help",
      "probe_evidence_unavailable",
      "probe_malformed",
      "probe_capture_suspect",
      "recipe_parser_mismatch",
      "projection_cli_liveness_sampled",
      "projection_cli_status_checkpoint",
      "projection_cli_exited",
      "stale sticky comments",
      "projection_sticky_verification_started",
      "projection_sticky_verified",
      "projection_sticky_verification_failed",
    ];
    const skillProbeAndStickyAnchors = probeAndStickyAnchors.filter(
      (anchor) =>
        ![
          "probe_evidence_unavailable",
          "probe_malformed",
          "probe_capture_suspect",
          "recipe_parser_mismatch",
          "stale sticky comments",
        ].includes(anchor)
    );

    assertIncludesAll(host, hostRelPath, [
      "Projection observability contract",
      "Projection observability protocol",
      "renderer-generated `<packet-dir>/observability-context.json`",
      "TL MUST run `.devpro/scripts/render-second-review-packet.mjs`",
      "before `spawn_agent` / `Task`",
      "packet_path",
      "observability_context_path",
      "tl_pre_dispatch_contract: tl-must-render-before-runtime-native-projection-spawn",
      "required_spawn_payload_fields",
      "projection_bootstrap_command",
      "projection_runner_command",
      "reviewer-stdout.ndjson",
      "heartbeat_interval_seconds: 60",
      "reviewer_surface: host-non-sandbox-required",
      "runner_owner: adapter-host-runner",
      "sandbox_policy: auth-required-reviewer-cli-must-not-run-in-sandbox",
      "projection_runner_unavailable",
      "projection_log_unavailable_by_runtime_api",
      "not a waiver for renderer-generated wrapper-owned artifacts",
      "projection_observability_contract_missing",
      "missing TL-side stdout/stderr MUST NOT be treated as reviewer inactivity",
      "activity_log_path",
      "stdout_log_path",
      "stderr_log_path",
      "projection_activity_stale",
      "Direct runner liveness protocol",
      "The sidecar is an untrusted carrier after render",
      "Bash(node <absolute-linked-issue-reader> <validated-repository-slug>:*)",
      "process-group `SIGKILL`",
      "stale-or-no-fresh-sticky-after-projection-observation-window",
      ...probeAndStickyAnchors,
    ]);
    assertAnchorsInOrder(host, hostRelPath, [
      "**Direct runner liveness protocol**",
      "1. **Bounded sampling**",
      "wrapper每`60s`記bounded liveness",
      "`15m`checkpoint",
      "`30m`final classify",
      "4. **Total window and termination**",
      "`15m`未terminal時記`projection_cli_status_checkpoint`並自動續跑",
      "`30m`在final verification/classification後自動停止",
    ]);

    assertIncludesAll(skill, skillRelPath, [
      "observability_context",
      "mandatory for every renderer-generated second-review packet",
      "packet_path",
      "observability_context_path",
      "tl_pre_dispatch_contract: tl-must-render-before-runtime-native-projection-spawn",
      "required_spawn_payload_fields",
      "projection_bootstrap_command",
      "projection_runner_command",
      "TL在 `spawn_agent` / `Task` 前完成 render+validate",
      "projection_log_visibility",
      "heartbeat_interval_seconds > 0 && <= 60",
      "reviewer_surface: host-non-sandbox-required",
      "runner_owner: adapter-host-runner",
      "sandbox_policy: auth-required-reviewer-cli-must-not-run-in-sandbox",
      "observability-context.json",
      "heartbeat.json",
      "reviewer-stdout.ndjson",
      "activity_log_path",
      "stdout_log_path",
      "stderr_log_path",
      "projection_log_unavailable_by_runtime_api",
      "does not waive renderer-generated wrapper-owned artifacts",
      "projection_runner_unavailable",
      "projection_observability_contract_missing",
      "projection_activity_stale",
      "missing TL-side stdout/stderr is not reviewer inactivity",
      "stale-or-no-fresh-sticky-after-projection-observation-window",
      "reviewer-side Python/heredoc/pipes/redirection/loops",
      "untrusted sidecar carrier after render",
      "Codex `audit-only` success is not inferred from exit 0",
      "only from the child `spawn` event",
      "process group where supported",
      ...skillProbeAndStickyAnchors,
    ]);
    assert.match(skill, /其他 probe evidence faults不得降級/);
    assert.match(skill, /stale sticky不算(?:write attempt| write attempt)/);

    assertIncludesAll(troubleshooting, troubleshootingRelPath, [
      "Projection Observability Faults",
      "projection_log_unavailable_by_runtime_api",
      "does not waive wrapper-owned artifact paths",
      "projection_observability_contract_missing",
      "projection_activity_stale",
      "Missing TL-side stdout/stderr MUST NOT be treated as reviewer inactivity",
      "Direct CLI fallback is allowed only after a documented reason",
    ]);

    assertIncludesAll(claudeCross, claudeCrossRelPath, [
      "Projection wrapper observability",
      "cross-host MUST",
      "Codex-host -> `claude -p`",
      "Claude-host -> `codex exec`",
      "renderer-generated TL-readable `observability_context`",
      "TL MUST run `.devpro/scripts/render-second-review-packet.mjs`",
      "before spawning the runtime-native projection",
      "packet_path",
      "observability_context_path",
      "tl_pre_dispatch_contract: tl-must-render-before-runtime-native-projection-spawn",
      "required_spawn_payload_fields",
      "projection_bootstrap_command",
      "projection_runner_command",
      "observability-context.json",
      "reviewer-stdout.ndjson",
      "reviewer_surface: host-non-sandbox-required",
      "runner_owner: adapter-host-runner",
      "sandbox_policy: auth-required-reviewer-cli-must-not-run-in-sandbox",
      "projection_runner_unavailable",
      "projection_observability_contract_missing",
      "projection_activity_stale",
      ...probeAndStickyAnchors,
    ]);

    assertIncludesAll(codexTooling, codexToolingRelPath, [
      "When `codex exec` is owned by a `dp-second-reviewer` projection/executor wrapper",
      "TL MUST render+validate before spawning the projection",
      "packet_path",
      "observability_context_path",
      "tl_pre_dispatch_contract: tl-must-render-before-runtime-native-projection-spawn",
      "required_spawn_payload_fields",
      "wrapper MUST expose renderer-generated TL-readable `observability_context` artifacts",
      "reviewer_surface: host-non-sandbox-required",
      "runner_owner: adapter-host-runner",
      "sandbox_policy: auth-required-reviewer-cli-must-not-run-in-sandbox",
      "projection_log_unavailable_by_runtime_api` is not a waiver",
      "projection_runner_unavailable",
      "projection_observability_contract_missing",
      "projection_handoff_validated",
      "exact `projection_runner_command`",
      "projection_cli_starting",
      "projection_cli_started",
      "projection_cli_exited",
      "first 60s observation window",
      "Projection sidecar is untrusted after render",
      "Codex `audit-only` exit 0 is successful only when JSONL contains",
      "process-group `SIGKILL`",
      ...probeAndStickyAnchors,
    ]);

    assertIncludesAll(claudeProjection, claudeProjectionRelPath, [
      "Projection Observability",
      "owns delegated reviewer CLI run",
      "observability-context.json",
      "packet_path",
      "observability_context_path",
      "tl_pre_dispatch_contract=tl-must-render-before-runtime-native-projection-spawn",
      "wrapper-owned `activity_log_path`",
      "reviewer_surface=host-non-sandbox-required",
      "runner_owner=adapter-host-runner",
      "sandbox_policy=auth-required-reviewer-cli-must-not-run-in-sandbox",
      "projection_runner_unavailable",
      "projection_observability_contract_missing",
      "projection_activity_stale",
      "projection_handoff_validated",
      "exact `projection_runner_command`",
      "projection_cli_starting",
      "projection_cli_started",
      "projection_cli_exited",
      "TL first 60s observation window",
      ...probeAndStickyAnchors,
    ]);

    assertIncludesAll(codexProjection, codexProjectionRelPath, [
      "Projection observability",
      "owns delegated reviewer CLI run",
      "observability-context.json",
      "packet_path",
      "observability_context_path",
      "tl_pre_dispatch_contract=tl-must-render-before-runtime-native-projection-spawn",
      "wrapper-owned activity_log_path",
      "reviewer_surface=host-non-sandbox-required",
      "runner_owner=adapter-host-runner",
      "sandbox_policy=auth-required-reviewer-cli-must-not-run-in-sandbox",
      "projection_runner_unavailable",
      "projection_observability_contract_missing",
      "projection_activity_stale",
      "projection_handoff_validated",
      "projection_cli_starting",
      "projection_cli_started",
      "projection_cli_exited",
      "TL first 60s observation window",
      ...probeAndStickyAnchors,
    ]);

    assertIncludesAll(renderer, rendererRelPath, [
      "observabilityContextFileName = \"observability-context.json\"",
      "observabilityHeartbeatFileName = \"heartbeat.json\"",
      "observabilityActivityFileName = \"projection-activity.ndjson\"",
      "observabilityStdoutFileName = \"reviewer-stdout.ndjson\"",
      "observabilityStderrFileName = \"reviewer-stderr.log\"",
      "observabilityCliProbeFileName = \"cli-probe-result.json\"",
      "projectionBootstrapScript = \".devpro/scripts/ack-second-reviewer-projection.mjs\"",
      "projectionBootstrapScriptPath",
      "projectionRunnerScript = PROJECTION_RUNNER_RELATIVE_SCRIPT_LITERAL",
      "projectionRunnerScriptPath",
      "selectReviewerCliRecipe",
      "canonicalReviewerCliRecipe",
      "requiredActivityEvents",
      "requiredReviewerSurface = \"host-non-sandbox-required\"",
      "requiredRunnerOwner = \"adapter-host-runner\"",
      "requiredSandboxPolicy = \"auth-required-reviewer-cli-must-not-run-in-sandbox\"",
      "tlPreDispatchContract = \"tl-must-render-before-runtime-native-projection-spawn\"",
      "requiredSpawnPayloadFields",
      "\"observability_context_path\"",
      "\"cli_probe_result_path\"",
      "\"projection_bootstrap_command\"",
      "\"projection_bootstrap_script\"",
      "\"projection_runner_command\"",
      "\"projection_runner_script\"",
      "\"reviewer_cli_recipe\"",
      "\"required_activity_events\"",
      "\"projection_cli_probe_started\"",
      "\"projection_cli_probe_result\"",
      "\"projection_cli_liveness_sampled\"",
      "\"projection_cli_status_checkpoint\"",
      "\"projection_cli_exited\"",
      "\"projection_sticky_verification_started\"",
      "rendererOwnedObservabilityPathFields",
      "publishCarriersWithLedger",
      "TL MUST NOT hand-author observability paths",
      "cwd-independent absolute path",
      "observability_context.heartbeat_interval_seconds must be > 0 and <= 60",
      "observability_context.reviewer_surface must be",
    ]);

    assertIncludesAll(recipeContract, recipeContractRelPath, [
      "SECOND_REVIEWER_CLI_PROBE_SCRIPT = \".devpro/scripts/probe-second-reviewer-cli-recipe.mjs\"",
      "canonicalReviewerCliRecipe",
      "assertCanonicalReviewerCliRecipe",
      "resolveCanonicalReviewerFamily",
      // The route is resolved once through resolveReviewerCli (family -> its verified CLI,
      // explicit reviewer_cli must agree) and every branch keys on that single value.
      "resolveReviewerCli(context?.reviewer_family, context?.reviewer_cli)",
      "cli === \"claude\"",
      "cli === \"opencode\"",
      "\"--effort\"",
      "\"--include-hook-events\"",
      "\"--allowedTools\"",
      "{ executable: \"codex\", argv: [\"--help\"] }",
      "{ executable: \"codex\", argv: [\"exec\", \"--help\"] }",
      "\"--ignore-rules\"",
      "\"--skip-git-repo-check\"",
      "\"workspace-write\"",
      "\"sandbox_workspace_write.network_access=true\"",
      "model_reasoning_effort=\"xhigh\"",
      "SECOND_REVIEWER_MODEL_DEFAULTS",
      "resolveSecondReviewerModel",
    ]);

    assert.match(specText, /Projection wrapper (?:exposes TL-readable activity artifact|activity artifact is required across hosts)/);
    assert.match(specText, /observability-context\.json/);
    assert.match(specText, /observability_context_path/);
    assert.match(specText, /tl-must-render-before-runtime-native-projection-spawn/);
    assert.match(specText, /required_spawn_payload_fields/);
    assert.match(specText, /before spawning the projection|before `spawn_agent`|before dispatch/);
    assert.match(specText, /reviewer-stdout\.ndjson/);
    assert.match(specText, /reviewer_surface: host-non-sandbox-required/);
    assert.match(specText, /runner_owner: adapter-host-runner/);
    assert.match(specText, /sandbox_policy: auth-required-reviewer-cli-must-not-run-in-sandbox/);
    assert.match(specText, /projection_runner_unavailable/);
    assert.match(specText, /artifact freshness, and PR sticky freshness every `60s`/);
    assert.match(specText, /projection_handoff_validated/);
    assert.match(specText, /projection_cli_starting/);
    assert.match(specText, /projection_cli_started/);
    assert.match(specText, /cli-probe-result\.json/);
    assert.match(specText, /cli_probe_result_path/);
    assert.match(specText, /projection_bootstrap_command/);
    assert.match(specText, /projection_runner_command/);
    assert.match(specText, /cwd-independent absolute path/);
    assert.match(specText, /on every host except the Claude Code host/);
    assert.match(
      specText,
      /### Requirement: Claude Code Host Projection Runner Uses Repo-Root-Relative Carrier/
    );
    assert.match(specText, /outside the repo\/worktree cwd/);
    assert.match(specText, /ack-second-reviewer-projection\.mjs/);
    assert.match(specText, /run-second-reviewer-projection\.mjs/);
    assert.match(specText, /exact `projection_runner_command`/);
    assert.match(specText, /reviewer_cli_recipe/);
    assert.match(specText, /required_activity_events/);
    assert.match(specText, /projection_cli_probe_started/);
    assert.match(specText, /projection_cli_probe_result/);
    assert.match(specText, /auth_preflight/);
    assert.match(specText, /flags_supported/);
    assert.match(specText, /reviewer_host_surface_unverified/);
    assert.match(specText, /memory-only-do-not-persist/);
    assert.match(specText, /required_flag_absent_in_host_help/);
    assert.match(specText, /probe_evidence_unavailable/);
    assert.match(specText, /probe_malformed/);
    assert.match(specText, /probe_capture_suspect/);
    assert.match(specText, /recipe_parser_mismatch/);
    assert.match(specText, /projection_cli_exited/);
    assert.match(specText, /stale sticky comments/);
    assert.match(specText, /projection_sticky_verification_started/);
    assert.match(specText, /projection_sticky_verified/);
    assert.match(specText, /projection_sticky_verification_failed/);
    assert.match(specText, /first 60s observation window/);
    assert.match(specText, /projection_activity_stale[\s\S]{0,120}(?:rather than wait|without waiting|stop\/fallback)/);
    assert.match(specText, /projection_log_unavailable_by_runtime_api/);
    assert.match(specText, /MUST NOT waive (?:the )?wrapper-owned artifact requirement|MUST NOT waive renderer-generated wrapper-owned artifacts/);
    assert.match(specText, /projection_observability_contract_missing/);
    assert.match(specText, /projection_activity_stale/);
    assert.match(specText, /missing TL-side stdout\/stderr MUST NOT be treated as reviewer inactivity/i);
    assert.match(specText, /TL direct CLI fallback MUST record/);
    assert.match(specText, /sidecar (?:SHALL be|is) untrusted after render/i);
    assert.match(specText, /renderer、ack、and runner/);
    assert.match(specText, /reviewer_cli_recipe_invalid/);
    assert.match(specText, /Codex `audit-only` exit 0/);
    assert.match(specText, /only after the child `spawn` event/);
    assert.match(specText, /process-group `SIGKILL`/);
  });

  it("keeps wrapper-local projection paths out of PR-visible fault summaries", () => {
    const skill = read(".devpro/agent-skills/devpro-reviews/second-review/SKILL.md");
    const spec = read("openspec/specs/cross-runtime-parity/spec.md");
    const controlEvidence = read(".devpro/agent-rules/second-review-control-evidence.md");
    const qaScopePath = "openspec/changes/archive/2026-07-22-fix-review-workflow-residuals/qa-test-scope.md";
    const qaScope = read(qaScopePath);

    for (const [relPath, content] of [
      [".devpro/agent-skills/devpro-reviews/second-review/SKILL.md", skill],
      ["openspec/specs/cross-runtime-parity/spec.md", spec],
    ]) {
      assertAnchorsInOrder(content, relPath, [
        "success-output contract only",
        "projection_wrapper_terminated_mid_run",
        "wrapper-local terminal control evidence",
        "activity_log_path",
        "PR/sticky/handoff/repo-visible summaries MUST NOT show raw local paths",
        "artifact key such as `activity_log`",
      ]);
    }

    assertAnchorsInOrder(
      controlEvidence,
      ".devpro/agent-rules/second-review-control-evidence.md",
      [
        "Wrapper-local terminal control evidence MAY carry raw `activity_log_path`",
        "projection_wrapper_terminated_mid_run",
        "PR/sticky/handoff/repo-visible summaries MUST omit raw local paths",
        "artifact key",
        "禁 local path/raw evidence",
      ]
    );

    assertIncludesAll(qaScope, qaScopePath, [
      "raw local paths 僅限 wrapper-local control-plane evidence",
      "PR/sticky/handoff/repo-visible summary",
      "classification、attempt_id、artifact key",
    ]);
  });

  it("keeps reviewer completion text opaque to terminal control classification", () => {
    const surfaces = [
      ".devpro/agent-rules/platform-adapters/codex-host-cross-review.md",
      ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
      "openspec/specs/cross-runtime-parity/spec.md",
      "openspec/changes/archive/2026-07-15-fix-second-reviewer-control-plane-recursion/specs/cross-runtime-parity/spec.md",
    ];

    for (const relPath of surfaces) {
      const content = read(relPath);
      assert.match(
        content,
        /completion [`']?(?:result|result[`']? \/ [`']?reason)[\s\S]{0,180}opaque/i,
        `${relPath} must keep reviewer completion result/reason in the data plane`
      );
      assert.match(
        content,
        /(?:(?:schema-valid|valid)(?=[\s\S]{0,600}(?:current-head|current reviewed SHA))(?=[\s\S]{0,600}(?:PASS\|WARN|PASS[`']?\s+or\s+[`']?WARN))[\s\S]{0,800}(?:authoritative|take precedence|優先|先於)[\s\S]{0,160}(?:pre-terminal|rate telemetry)|Accepted completion只可覆蓋既有rate telemetry|Accepted completion authority is rate-telemetry-only)/i,
        `${relPath} must make accepted exit-0 completion authoritative over rate telemetry`
      );
    }
    assert.match(
      read(".devpro/agent-rules/code-review-cross-model.md"),
      /host\/skill不得從reviewer content重推 control state/,
      "shared routing rule must preserve the opaque data/control boundary"
    );

    const providerSpecificSurfaces = [
      ".devpro/agent-rules/platform-adapters/codex-host-cross-review.md",
      "openspec/specs/cross-runtime-parity/spec.md",
      "openspec/changes/archive/2026-07-15-fix-second-reviewer-control-plane-recursion/specs/cross-runtime-parity/spec.md",
    ];

    for (const relPath of providerSpecificSurfaces) {
      const content = read(relPath);
      assert.match(
        content,
        /rate_limit_event\.rate_limit_info\.status/i,
        `${relPath} must name the canonical typed rate-status field`
      );
      assert.match(
        content,
        /allowed_warning[\s\S]{0,180}(?:informational|pre-terminal rate telemetry)/i,
        `${relPath} must record the observed informational warning status`
      );
      assert.match(
        content,
        /accepted[\s\S]{0,240}(?:MUST NOT|does not|不得)[\s\S]{0,120}(?:override|outrank|蓋掉|優先於)[\s\S]{0,120}(?:auth|authentication)/i,
        `${relPath} must keep accepted-completion authority narrower than authentication evidence`
      );
      assert.match(
        content,
        /Without an accepted completion, rejected or unknown non-informational rate evidence MUST retain provider-blocked precedence before (?:typed or unstructured|bounded) authentication evidence[.。]/,
        `${relPath} must preserve blocking rate precedence when no completion is accepted`
      );
    }

    for (const relPath of [
      "openspec/specs/cross-runtime-parity/spec.md",
      "openspec/changes/archive/2026-07-15-fix-second-reviewer-control-plane-recursion/specs/cross-runtime-parity/spec.md",
    ]) {
      const content = read(relPath);
      assert.match(content, /#### Scenario: Authentication evidence outranks accepted completion/);
      assert.match(content, /#### Scenario: Flat top-level rate status remains blocking/);
      assert.match(content, /#### Scenario: Blocking rate evidence precedes authentication without accepted completion/);
      assert.match(
        content,
        /Authentication evidence outranks accepted completion[\s\S]{0,900}claude_reviewer_authentication_failed/
      );
      assert.match(
        content,
        /Flat top-level rate status remains blocking[\s\S]{0,900}claude_reviewer_provider_rate_limited/
      );
      assert.match(
        content,
        /Blocking rate evidence precedes authentication without accepted completion[\s\S]{0,900}claude_reviewer_provider_rate_limited/
      );
    }
  });

  it("keeps the current QA evidence as one renderable Markdown table", () => {
    const qa = read("openspec/changes/archive/2026-07-15-fix-second-reviewer-control-plane-recursion/qa-test-scope.md");
    const currentEvidence = qa
      .split("## Current GREEN evidence (2026-07-15)")[1]
      ?.split("## Residual gates and callback paths")[0] ?? "";
    assert.notEqual(currentEvidence, "", "current GREEN evidence section must exist");
    const tableStart = currentEvidence.indexOf("| Gate | Current result | Persistent evidence |");
    const tableEnd = currentEvidence.indexOf("\n\nThe focused contract assertions", tableStart);
    assert.ok(tableStart >= 0 && tableEnd > tableStart, "current evidence table bounds must exist");
    const evidenceTable = currentEvidence.slice(tableStart, tableEnd);
    assert.doesNotMatch(
      evidenceTable,
      /\n\n\|[^\n]+\|/,
      "current evidence rows must not be detached from the Markdown table by a blank line"
    );
  });

  it("classifies bounded orchestration evidence before accepted completion after wrapper hard faults", () => {
    const runner = read(".devpro/scripts/run-second-reviewer-projection.mjs");
    const detectorStart = runner.indexOf("function classifyReviewerOrchestrationEvidence");
    const classifyStart = runner.indexOf("function classifyCliExit");
    const classifyEnd = runner.indexOf("function pathsPayload", classifyStart);
    assert.ok(detectorStart >= 0, "runner must expose one bounded orchestration-evidence classifier");
    assert.ok(classifyStart >= 0 && classifyEnd > classifyStart);
    const classifyBody = runner.slice(classifyStart, classifyEnd);

    assertIncludesAll(runner, ".devpro/scripts/run-second-reviewer-projection.mjs", [
      "reviewer_orchestration_permission_denied",
      "reviewer_orchestration_unknown",
      "permission_denials",
      "evidence_provenance",
      "evidence_confidence",
      "matcher_id",
      "redacted_excerpt",
      "provider_typed_event",
      "provider_candidate_unmatched",
    ]);
    const wrapperFaultIndex = classifyBody.indexOf("cliResult.fault_classification");
    const toolSurfaceIndex = classifyBody.indexOf("cliResult.tool_surface_check");
    const orchestrationIndex = classifyBody.indexOf("classifyReviewerOrchestrationEvidence");
    const acceptedIndex = classifyBody.indexOf('completion?.status === "accepted"');
    assert.ok(wrapperFaultIndex >= 0 && toolSurfaceIndex > wrapperFaultIndex);
    assert.ok(
      orchestrationIndex > toolSurfaceIndex,
      "orchestration evidence must not outrank existing wrapper hard faults"
    );
    assert.ok(
      acceptedIndex > orchestrationIndex,
      "confirmed or unknown orchestration evidence must override candidate completion and UNAVAILABLE"
    );
  });

  it("keeps orchestration evidence metadata bounded, redacted, and registry-driven", () => {
    const runner = read(".devpro/scripts/run-second-reviewer-projection.mjs");
    const detectorStart = runner.indexOf("function classifyReviewerOrchestrationEvidence");
    const detectorEnd = runner.indexOf("\nfunction ", detectorStart + 1);
    assert.ok(detectorStart >= 0 && detectorEnd > detectorStart);
    const detectorBody = runner.slice(detectorStart, detectorEnd);

    assert.match(runner, /APPROVED_EXACT_PERMISSION_DENIAL_MATCHERS|approvedExactPermissionDenialMatchers/);
    assert.match(runner, /(?:MAX_|max)[A-Za-z_]*EVIDENCE[A-Za-z_]*(?:=|:)\s*512|512[^\n]*redacted_excerpt/i);
    assert.match(detectorBody, /redact|sanitize/i);
    assert.doesNotMatch(
      detectorBody,
      /readFileSync\s*\(/,
      "orchestration classification must consume current bounded evidence, not whole logs"
    );
    assert.doesNotMatch(
      detectorBody,
      /completion\.(?:result|reason)|terminalResult\.(?:result|reason)/,
      "reviewer-authored completion text must remain opaque to orchestration matchers"
    );
  });

  // Scenario: Claim Must Be Published Before Reviewer Spawn
  it("revalidates sticky disposition before probe, claim, and reviewer spawn", () => {
    const runner = read(".devpro/scripts/run-second-reviewer-projection.mjs");
    const projectionStart = runner.indexOf("async function runProjection");
    const projectionEnd = runner.indexOf("async function main", projectionStart);
    assert.ok(projectionStart >= 0 && projectionEnd > projectionStart);
    const projectionBody = runner.slice(projectionStart, projectionEnd);
    const revalidateIndex = projectionBody.indexOf(
      "revalidateSecondReviewStickyWriteDisposition"
    );
    const probeIndex = projectionBody.indexOf("runProbe");
    const claimIndex = projectionBody.indexOf("claimDispatchInvocation");
    const spawnIndex = projectionBody.indexOf("runReviewerCli");

    assert.match(runner, /devpro-second-review-data\/v3/);
    assert.match(runner, /reviewer_dispatch_identity_collision/);
    assert.ok(
      revalidateIndex >= 0,
      "RED-4 runner must revalidate the renderer-owned sticky disposition"
    );
    assert.ok(
      probeIndex > revalidateIndex,
      "RED-4 sticky authority must fail closed before any reviewer capability probe"
    );
    assert.ok(probeIndex >= 0, "runner must establish probe-only failures before invocation claim");
    assert.ok(claimIndex > probeIndex, "probe-only failure must not acquire single-spawn authority");
    assert.ok(claimIndex >= 0, "runner must validate and exclusively claim renderer-owned reservation");
    assert.ok(spawnIndex > claimIndex, "single-invocation claim must complete before reviewer spawn");
    assert.doesNotMatch(
      projectionBody,
      /reserveDispatchRecord/,
      "runner must not create a second reservation directory and collide with the renderer"
    );
  });

  it("uses the shared disposition resolver and carries no reviewer-side marker-search fallback", () => {
    const runner = read(".devpro/scripts/run-second-reviewer-projection.mjs");
    const validator = read(".devpro/scripts/validate-second-review-packet.mjs");
    const stickyAuthority = read(
      ".devpro/scripts/hooks/lib/second-review-sticky-authority.mjs"
    );

    assert.match(
      stickyAuthority,
      /export function resolveSecondReviewStickyWriteDisposition\(snapshot,\s*\{\s*expectedDisposition/
    );
    assert.match(runner, /resolveSecondReviewStickyWriteDisposition/);
    assert.match(runner, /expectedDisposition:\s*spawnExpected/);
    assert.match(
      runner,
      /PAGE_WINDOW_STICKY_DEFERRED_CLASSIFICATION/,
      "pre-spawn must recognize deferred intermediate packet disposition",
    );
    assert.match(
      runner,
      /sticky_write_disposition_authorized/,
      "deferred intermediate must validate the authorized sidecar disposition",
    );
    assert.match(validator, /sticky_write_disposition_schema/);
    assert.match(validator, /sticky_write_action/);
    assert.match(validator, /MUST NOT[^\n"]*(?:search|scan|find)[^\n"]*marker/i);
    assert.match(validator, /MUST NOT[^\n"]*(?:fallback|switch)[^\n"]*(?:action|create|update|PATCH|POST)/i);
  });

  it("keeps validator module import free of Rules-version filesystem reads", () => {
    const validator = read(".devpro/scripts/validate-second-review-packet.mjs");

    assert.match(
      validator,
      /export function secondReviewRulesVersion\(repoRoot = validatorRepoRoot\)/
    );
    assert.doesNotMatch(
      validator,
      /^export const SECOND_REVIEW_RULES_VERSION\s*=\s*/m,
      "runner recursive reentry must be checked before any Rules-version filesystem read"
    );
  });

  it("binds fresh PR sticky verification to the current dispatch identity", () => {
    const runner = read(".devpro/scripts/run-second-reviewer-projection.mjs");
    const stickyAuthority = read(
      ".devpro/scripts/hooks/lib/second-review-sticky-authority.mjs"
    );
    const parseStart = runner.indexOf("function parseStickyBody");
    const parseEnd = runner.indexOf("function resolvePrNumber", parseStart);
    const verifyStart = runner.indexOf("function verifySticky", parseEnd);
    const verifyEnd = runner.indexOf("function verifyStickyFailClosed", verifyStart);
    assert.ok(parseStart >= 0 && parseEnd > parseStart);
    assert.ok(verifyStart >= 0 && verifyEnd > verifyStart);
    const parseBody = runner.slice(parseStart, parseEnd);
    const verifyBody = runner.slice(verifyStart, verifyEnd);

    assert.match(parseBody, /return parseSecondReviewStickyAuthorityBody\(body,/);
    assert.match(
      stickyAuthority,
      /export function parseSecondReviewStickyAuthorityBody/
    );
    assert.match(stickyAuthority, /exactMachineLines\(lines, "dispatch_id"\)/);
    assert.match(stickyAuthority, /sticky_dispatch_id_missing/);
    assert.match(stickyAuthority, /sticky_dispatch_id_invalid/);
    assert.match(verifyBody, /context\.dispatch_id/);
    assert.match(verifyBody, /dispatch_id/);
    assert.match(verifyBody, /stale|mismatch|current/i);
    assert.match(verifyBody, /sticky_patch_snapshot_stale/);
    assert.match(verifyBody, /lastLookRead/);
    assert.match(verifyBody, /patchStickyCommentBody/);
    assert.doesNotMatch(verifyBody, /If-Match/);
    assert.doesNotMatch(verifyBody, /If-Unmodified-Since/);
    const patchStart = runner.indexOf("function patchStickyCommentBody");
    assert.ok(patchStart >= 0 && patchStart < verifyStart);
    const patchBody = runner.slice(patchStart, verifyStart);
    assert.doesNotMatch(patchBody, /If-Match/);
    assert.doesNotMatch(patchBody, /If-Unmodified-Since/);
  });

  it("keeps the publication transaction schema exact at v3 across runtime and rule", () => {
    const renderer = read(".devpro/scripts/render-second-review-packet.mjs");
    const controlEvidence = read(".devpro/agent-rules/second-review-control-evidence.md");
    assert.match(
      renderer,
      /const publicationTransactionSchema = "devpro-second-review-publication-transaction\/v3";/,
    );
    assert.equal(
      (controlEvidence.match(/devpro-second-review-publication-transaction\/v3/g) ?? []).length,
      2,
      "both rule transaction anchors must name the runtime-final v3 schema",
    );
    assert.doesNotMatch(
      controlEvidence,
      /devpro-second-review-publication-transaction\/(?:v1|v2|v4)/,
      "the rule must not accept an older, newer, or dual transaction schema",
    );
  });
});
