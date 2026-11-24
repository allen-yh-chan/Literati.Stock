import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";

function readOptional(relPath) {
  const fullPath = repoPath(relPath);
  return existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
}

describe("Codex-host Claude cross-review mode-specific packet default", () => {
  it("dogfood skill projections pin exact observed Claude init tool sets", () => {
    for (const skillPath of [
      ".devpro/agent-skills/devpro-reviews/second-review-dogfood/SKILL.md",
      ".devpro/agent-skills/devpro-reviews/second-review-dogfood/SKILL.md",
      ".devpro/agent-skills/devpro-reviews/second-review-dogfood/SKILL.md",
    ]) {
      const content = read(skillPath);
      assert.match(content, /exactly `StructuredOutput` for `audit-only`/);
      assert.match(content, /exactly `Bash`, `StructuredOutput`, and `Write` for `pr-sticky`/);
      assert.doesNotMatch(content, /`\[\]` for `audit-only`/);
      assert.doesNotMatch(content, /exactly `Write` and `Bash` for `pr-sticky`/);
    }
  });

  it("trusted v5 control rule and canonical skill preserve the frozen contract", () => {
    const rule = read(".devpro/agent-rules/second-review-control-evidence.md");
    const skill = read(".devpro/agent-skills/devpro-reviews/second-review/SKILL.md");
    const renderer = read(".devpro/scripts/render-second-review-packet.mjs");
    const materialContract = read(".devpro/scripts/second-review-material-contract.mjs");

    for (const content of [rule, skill]) {
      assert.match(content, /byte-exact[^\n]*`claude`[^\n]*`codex`[^\n]*`openai-codex`/i);
      assert.match(content, /`reviewer_family_invalid`/);
      assert.match(content, /`A = D = M`/);
      assert.match(content, /byte-exact raw Git diff/i);
      assert.match(content, /`devpro-second-review-paged-full-pages\/v2`/);
      assert.match(content, /`reviewer_dispatch_identity_collision`/);
      assert.match(content, /`review_material_full_carrier_binding_invalid`/);
      for (const reason of [
        "missing",
        "malformed_or_noncanonical",
        "root_or_basename_substitution",
        "identity_mismatch",
        "permission_invalid",
        "lifetime_invalid",
        "page_or_digest_mismatch",
      ]) {
        assert.ok(content.includes(`\`${reason}\``));
      }
      assert.match(content, /active-window|active pages/i);
      assert.match(content, /v4[^\n]*(?:7-carrier|7個carrier|7個)/i);
      assert.match(content, /v5[^\n]*(?:8個carrier|共8個|8個|eighth)/i);
    }

    assert.match(rule, /`SECOND_REVIEW_GIT_RAW_DIFF_FLAGS`/);
    for (const flag of [
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--binary",
      "--full-index",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--unified=3",
      "--diff-algorithm=myers",
      "--no-indent-heuristic",
      "--submodule=short",
      "--find-renames",
      "--find-copies-harder",
    ]) {
      assert.ok(skill.includes(flag), `missing canonical raw-diff flag ${flag}`);
    }

    assert.doesNotMatch(rule, /pr-sticky execution只接受 `devpro-second-review-data\/v4`/);
    assert.doesNotMatch(renderer, /authoritativeChangedSetResolver|isClaudeReviewerFamily/);
    assert.match(
      materialContract,
      /CANONICAL_REVIEWER_FAMILY_TOKENS\s*=\s*Object\.freeze\(\s*Object\.keys\(canonicalReviewerFamilies\)/s,
    );
  });
  it("Codex-host adapter requires exact Claude tool profiles without altering Codex", () => {
    const content = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
    const recipe = content.match(/```bash\n([\s\S]*?)```/)?.[1] ?? "";
    assert.match(content, /Claude Code tool profile：Both modes MUST use exact `--safe-mode` once[，]?隔離[^\n]{0,160}(?:CLAUDE\.md|plugins|MCP)/);
    assert.match(content, /exact-once `--system-prompt`[^\n]{0,240}(?:cwd|environment|git)[^\n]{0,160}(?:bootstrap|探查)/i);
    assert.match(content, /audit-only[\s\S]{0,400}--tools ""[\s\S]{0,400}(?:omit|無|no)[\s\S]{0,160}--allowedTools/i);
    assert.match(content, /pr-sticky[\s\S]{0,400}--tools Write,Bash[\s\S]{0,300}scoped[\s\S]{0,160}--allowedTools/i);
    assert.match(content, /audit-only=exactly `StructuredOutput`；pr-sticky=exactly `Bash`、`StructuredOutput`、and `Write`/);
    assert.match(content, /Codex exact current argv.*不變/);
    assert.match(content, /--bare[\s\S]{0,200}MUST NOT[\s\S]{0,200}canonical recipe|MUST NOT[\s\S]{0,200}--bare[\s\S]{0,200}canonical recipe/);
    assert.match(content, /Task\/subagent delegation/);
    assert.match(content, /UNAVAILABLE/);
    assert.match(content, /Canonical `devpro:second-review` \/ `claude -p` adapter invocation recipe/);
    assert.match(recipe, /claude -p[\s\S]{0,160}--system-prompt[\s\S]{0,5000}--tools Write,Bash[\s\S]{0,160}--allowedTools[\s\S]{0,400}write-second-review-sticky-gated\.mjs[\s\S]{0,200}< "\$PACKET_FILE"/);
    assert.doesNotMatch(recipe, /--bare/);
    assert.match(content, /dispatch-ready evidence[\s\S]{0,160}probe JSON[\s\S]{0,80}validated packet file/);
    assert.match(content, /required_flag_absent_in_host_help[\s\S]{0,140}recipe_unresolved/);
  });

  it("Codex-host adapter keeps reviewer streams out of user-visible transcript", () => {
    const content = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
    assert.match(content, /reviewer NDJSON\/stdout\/stderr is a log artifact/);
    assert.match(content, /compact status\/progress/);
    assert.match(content, /final schema summary/);
    assert.match(content, /sticky URL[\s\S]{0,160}verdict[\s\S]{0,160}last_reviewed_sha[\s\S]{0,160}reviewer_model[\s\S]{0,160}reason/);
    assert.match(content, /raw provider[\s\S]{0,120}stdout\/stderr sidecars/);
    assert.match(content, /activity[、,][\s\S]{0,80}heartbeat[、,][\s\S]{0,120}MUST NOT copy raw preview or excerpt/);
    assert.doesNotMatch(content, /raw stream excerpts[\s\S]{0,120}invocation debugging/);
  });

  it("Codex-host sandbox auth false negatives require host rerun before fallback", () => {
    const codexHost = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
    const shared = read(".devpro/agent-rules/code-review-cross-model.md");
    const spec = read("openspec/specs/cross-runtime-parity/spec.md");
    const combined = [codexHost, shared, spec].join("\n");

    assert.match(codexHost, /require_escalated/);
    assert.match(combined, /Not logged in/);
    assert.match(combined, /apiKeySource:?["`]?none[\s\S]{0,100}(?:neutral|中性)/);
    assert.match(combined, /sandbox-surface-fault/);
    assert.match(combined, /host-rerun|host rerun/);
    assert.match(combined, /host-surface evidence/);
    assert.match(combined, /MUST NOT[\s\S]{0,240}unavailable/);
    assert.match(combined, /fallback[\s\S]{0,300}UNAVAILABLE[\s\S]{0,300}host-surface evidence/);
  });

  it("Claude Code adapter documents exact mode-specific flags and no Task delegation", () => {
    const content = read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md");
    assert.match(content, /Claude common argv.*-p --safe-mode --system-prompt <renderer-owned fixed prompt> --model <resolved> --effort (?:xhigh|max) --verbose/);
    assert.doesNotMatch(content, /Claude common argv.*--effort high/);
    assert.match(content, /兩種 mode 都用`--safe-mode`隔離customizations/);
    assert.match(content, /`--system-prompt`[^\n]{0,240}(?:cwd|environment|git)[^\n]{0,160}(?:bootstrap|探查)/i);
    assert.match(content, /audit-only[\s\S]{0,400}--tools ""[\s\S]{0,400}(?:不得有|無|no)[\s\S]{0,160}--allowedTools/i);
    assert.match(content, /pr-sticky[\s\S]{0,400}--tools Write,Bash[\s\S]{0,400}--allowedTools/i);
    assert.match(content, /audit-only=exactly `StructuredOutput`，pr-sticky=exactly `Bash`、`StructuredOutput`、and `Write`/);
    assert.match(content, /Codex exact current argv.*不變/);
    assert.match(content, /--bare[\s\S]{0,200}MUST NOT[\s\S]{0,200}canonical recipe|MUST NOT[\s\S]{0,200}--bare[\s\S]{0,200}canonical recipe/);
    assert.match(content, /Task\/subagent delegation/);
    assert.match(content, /wrapper (?:MUST )?(?:first )?enumerate[\s\S]{0,260}sticky_write_disposition/i);
    assert.match(content, /Reviewer MUST NOT search, scan, find, or re-resolve marker candidates/);
    assert.doesNotMatch(content, /Claude 產出[^。]*完整列舉 canonical marker candidates/);
    assert.doesNotMatch(content, /寫入前必須完整列舉 canonical marker candidates/);
  });

  it("shared checklist delegates exact family recipes without cross-family argv mutation", () => {
    const content = read(".devpro/agent-rules/code-review-cross-model.md");
    // The invocation／tool-surface contract moved verbatim to the dispatch-mechanics sibling.
    const mechanics = read(".devpro/agent-rules/code-review-cross-model-dispatch-mechanics.md");
    assert.match(mechanics, /exact family\/mode recipe/);
    assert.match(mechanics, /shared helper.*不得把一個family的flags套到另一個family/);
    assert.match(mechanics, /不得新增、刪除、重排或改寫adapter-preserved argv/);
    assert.match(content, /reviewer-safe data plane/);
    assert.match(content, /wrapper-only sidecar/);
  });

  it("Claude packet mode uses positive tool profile and applies the common liveness timeline", () => {
    const codexHost = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
    const claude = read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md");
    const shared = read(".devpro/agent-rules/code-review-cross-model.md");
    const cliContract = read(".devpro/agent-rules/code-review-cross-model-cli-contract.md");
    // Text moved out of code-review-cross-model.md stays inside the negative checks below.
    const dispatchMechanics = read(".devpro/agent-rules/code-review-cross-model-dispatch-mechanics.md");
    const parityDelta = readOptional(
      "openspec/changes/strengthen-codex-claude-cross-review-invocation/specs/cross-runtime-parity/spec.md"
    );
    const flowDelta = readOptional(
      "openspec/changes/strengthen-codex-claude-cross-review-invocation/specs/openspec-flow/spec.md"
    );
    const combined = [codexHost, claude, shared, cliContract, dispatchMechanics, parityDelta, flowDelta].join("\n");

    assert.match(combined, /Positive tool profile|positive tool profile/i);
    assert.match(combined, /--bare[\s\S]{0,200}MUST NOT[\s\S]{0,200}canonical recipe|MUST NOT[\s\S]{0,200}--bare[\s\S]{0,200}canonical recipe/);
    assert.match(combined, /--allowedTools[\s\S]{0,500}write-second-review-sticky-gated\.mjs/);
    assert.match(combined, /MUST NOT include raw `Bash\(gh api:\*\)`/);
    assert.doesNotMatch(combined, /--allowedTools "[^"\n]*gh pr comment/);
    assert.match(combined, /complete canonical marker candidate set/);
    assert.match(combined, /zero=create, one=update|sticky_write_exact_recipe/);
    assert.match(combined, /write-second-review-sticky-gated\.mjs|read-second-review-sticky-comment\.mjs/);
    assert.doesNotMatch(combined, /zero=one POST, one=one PATCH/);
    assert.match(combined, /MUST NOT try another create primitive/);
    assert.match(combined, /exact `command -v gh`/);
    assert.match(combined, /MUST NOT carry arguments, operators, pipes, redirects, substitutions, or another command/);
    assert.match(combined, /permission-surface clamps only/);
    assert.match(combined, /not shell grammar validation/);
    assert.match(combined, /Task\/subagent delegation/);
    assert.match(combined, /Timeout-after-(?:writeback|sticky)|timeout after reviewer write-back|transport\/finalization fault/i);
    assert.match(combined, /fresh (?:parseable )?`?verdict: PASS \| WARN`?|fresh `PASS \| WARN`|fresh marker \+ `verdict: PASS \| WARN`/);
    assert.match(combined, /last_reviewed_sha == headRefOid/);
    assert.match(combined, /60s[\s\S]{0,220}15m|15m[\s\S]{0,220}60s|60-second[\s\S]{0,260}15-minute/);
    assert.match(combined, /15m[\s\S]{0,220}(?:status checkpoint|狀態 checkpoint|狀態檢查點)/i);
    assert.match(combined, /30m|30-minute|30 分鐘/);
    assert.match(combined, /(?:auto-continue|automatically continue|自動續跑|繼續等待)/i);
    assert.match(combined, /callback|process close/i);
    assert.match(combined, /(?:不得|MUST NOT)[^\n]{0,180}(?:使用者授權|user authorization)/i);
    assert.match(combined, /Do not (?:remove|switch)[\s\S]{0,200}(?:30m|30-minute)[\s\S]{0,200}(?:no-total-timeout|no total timeout)/i);
  });

  it("code-review-checklist spec carries family clamp and invocation-preservation scenario", () => {
    const canonical = read("openspec/specs/code-review-checklist/spec.md");
    const issue1714Archive = [
      "proposal.md",
      "design.md",
      "brd.md",
      "specs/code-review-checklist/spec.md",
    ].map((suffix) => read(`openspec/changes/archive/2026-07-19-fix-consumer-source-corpus-routing/${suffix}`)).join("\n");
    const externalReviewerPacketMode = canonical
      .split("### Requirement: External Reviewer Packet Mode")[1]
      ?.split("\n### Requirement:")[0];
    const currentDelta = readOptional(
      "openspec/changes/fix-second-reviewer-control-plane-recursion/specs/code-review-checklist/spec.md"
    );
    const activeDelta = readOptional(
      "openspec/changes/fix-codex-cross-review-safe-mode/specs/code-review-checklist/spec.md"
    );
    const archivedDelta = readOptional(
      "openspec/changes/archive/2026-06-16-fix-codex-cross-review-safe-mode/specs/code-review-checklist/spec.md"
    );
    const historicalText = [activeDelta, archivedDelta].join("\n");

    assert.match([canonical, currentDelta].join("\n"), /Reviewer packet mode clamps one family and preserves the other invocation/);
    assert.match([canonical, currentDelta].join("\n"), /Both Claude modes MUST use exact-once `--safe-mode`/);
    assert.match(canonical, /exact-once `--system-prompt`[^\n]{0,260}CLAUDE_REVIEWER_SYSTEM_PROMPT/);
    assert.match(canonical, /current directory, environment variables, git state, shell configuration, and host metadata MUST NOT be inspected/);
    assert.match(canonical, /instructions, ordering, stop conditions, branches, evidence, and completion contract MUST NOT be summarized, compressed, or rewritten/);
    assert.match(externalReviewerPacketMode, /gated-CLI|gated sticky-write|sticky_write_exact_recipe|write-second-review-sticky-gated/);
    assert.match(externalReviewerPacketMode, /read-second-review-sticky-comment\.mjs|sticky_write_readback_recipe/);
    assert.doesNotMatch(externalReviewerPacketMode, /gh pr comment/);
    assert.match([canonical, issue1714Archive].join("\n"), /adapter-designated trusted control plane SHALL enumerate/);
    assert.match(issue1714Archive, /sticky_write_disposition/);
    assert.doesNotMatch([canonical, issue1714Archive].join("\n"), /writer SHALL enumerate comments bearing the magic marker/);
    assert.doesNotMatch(issue1714Archive, /Claude safe-mode reviewer在寫入前列舉|Reviewer寫入前[^。]*列舉/);
    assert.match(canonical, /Claude MUST use its exact mode-specific native tool boundary/);
    assert.match(canonical, /Codex MUST use the exact renderer-owned `required_invocation_args` array, a 13-element argv with no `--add-dir` element/);
    assert.match(historicalText, /Task`\/subagent delegation|Task\/subagent delegation/);
    assert.match(historicalText, /fix-codex-cross-review-safe-mode delta-only anchor/);
    assert.doesNotMatch(canonical, /fix-codex-cross-review-safe-mode delta-only anchor/);
  });
});
