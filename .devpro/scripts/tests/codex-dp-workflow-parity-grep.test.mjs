import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { repoPath } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";



const PRIMARY_COMMANDS = [
  "/devpro:init",
  "/devpro:setup-ci",
  "/devpro:security-scan",
  "/devpro:change",
  "/devpro:pre-pr",
  "/devpro:cross-review",
  "/devpro:sync-rules",
  "/devpro:load-plan",
];

// migrate-skill-architecture-to-dp-prefix: README no longer lists the abolished
// `/dp:*` colon-input command labels — it lists the hyphenated skill names that
// are the sole cross-runtime first-party entry point.
const PRIMARY_SKILLS = [
  "devpro:init",
  "devpro:setup-ci",
  "devpro:security-scan",
  "devpro:change",
  "devpro:pre-pr",
  "devpro:cross-review",
  "devpro:sync-rules",
  "devpro:load-plan",
];

test("Codex adapter documents implemented /dp skill parity, not manual-only support", () => {
  const codex = read(".devpro/agent-rules/platform-adapters/codex.md");
  assert.match(codex, /唯讀轉 .*workflow.*action 前載對應 Load-chain leaf\+gate/);
  assert.match(codex, /devpro:\*.*platform-adapters\/codex-workflow-capabilities\.md/);
  assert.match(codex, /Support\*\*: fully implemented via repo-scoped skill parity/);
  assert.match(codex, /not native Codex slash-command registration/);
  assert.match(codex, /\.devpro\/agent-skills\/devpro-workflows\/workflows\/SKILL\.md/);
  assert.match(codex, /\.agents\/skills\/devpro/);
  assert.match(codex, /`?\$devpro:workflows`? and natural-language workflow requests are supported/);
  assert.match(codex, /direct `\/dp:\*` input may be intercepted by Codex UI as an unrecognized command and may not reach the model/);
  assert.match(codex, /Custom Prompts.*deprecated/);
  assert.doesNotMatch(codex, /no Codex-specific user-invocable command manifest is defined/);
});

test("devpro:workflows skill is the Codex carrier for every primary /dp command", () => {
  const skill = read(".devpro/agent-skills/devpro-workflows/workflows/SKILL.md");
  assert.match(skill, /name: workflows/);
  assert.match(skill, /metadata:\n\s+user-invocable: true\n\s+argument-hint: "\/devpro:<command> \[args\]"/);
  assert.match(skill, /not native Codex slash-command registration/);
  assert.match(skill, /\$devpro:workflows\x60? and natural-language workflow requests are supported/);
  assert.match(skill, /direct `\/dp:\*` input may be intercepted by Codex UI as an unrecognized command and may not reach the model/);
  assert.match(skill, /Do not create or depend on `~\/\.codex\/prompts`/);
  assert.doesNotMatch(skill, /\/Users\//);
  for (const command of PRIMARY_COMMANDS) {
    assert.match(skill, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("devpro:workflows OpenAI interface metadata is covered by parity tests", () => {
  const openai = read(".devpro/agent-skills/devpro-workflows/workflows/agents/openai.yaml");
  assert.match(openai, /display_name: "Devpro DP Workflows"/);
  assert.match(openai, /short_description: "Run Devpro \/dp workflow equivalents in Codex\."/);
  assert.match(openai, /default_prompt: "Use \$devpro:workflows to run the requested Devpro workflow\."/);
});

test("README exposes Codex skill parity alongside Claude skill-based invocation", () => {
  const readme = read("README.md");
  assert.match(readme, /Devpro commands \/ skills/);
  // migrate-skill-architecture-to-dp-prefix: the `/dp:*` colon-input slash command
  // surface is abolished; Claude Code now invokes the same first-party workflow
  // through `/skill-name` (hyphenated) skill-based invocation.
  assert.match(readme, /Claude Code 以 `\/devpro:<name>` slash 或自然語言觸發同名 skill/);
  assert.match(readme, /Codex .*repo skill `\$devpro:workflows`，或以自然語言提出工作流請求/);
  assert.match(readme, /\$devpro:workflows/);
  assert.match(readme, /\.agents\/skills\/devpro/);
  assert.match(readme, /Custom Prompts .*deprecated/);
  assert.doesNotMatch(readme, /Codex 以 repo skill `\$devpro:workflows` 或 `\/dp:<command>` prompt intent 呼叫/);
  for (const command of PRIMARY_SKILLS) {
    assert.match(readme, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("Codex repo discovery path is a checked-in symlink to the source-managed skill", () => {
  const rel = ".agents/skills/devpro";
  const abs = repoPath(rel);
  assert.equal(existsSync(abs), true);
  assert.equal(lstatSync(abs).isSymbolicLink(), true);
  assert.equal(
    readlinkSync(abs).replaceAll("\\", "/"),
    "../../.devpro/agent-skills",
  );
});

test("explicit natural-language batch approval carries devpro:change command and parameter confirmation", () => {
  const gitFlow = read(".devpro/agent-rules/git-branch-and-pr-flow.md");
  const dpChangeSkill = read(".devpro/agent-skills/devpro-workflows/change/SKILL.md");
  assert.match(gitFlow, /明確自然語言 batch approval/);
  assert.match(gitFlow, /視同已確認 `\/devpro:change <change-name>` command \+ parameter/);
  assert.match(gitFlow, /whole `\/devpro:change` flow batch approval/);
  assert.match(gitFlow, /首次 `git push -u origin <branch>`/);
  assert.match(gitFlow, /`gh pr create` \/ PR body update/);
  assert.match(gitFlow, /approval evidence MUST.*named change \/ branch/);
  assert.match(gitFlow, /PR number.*head SHA.*不必/);
  assert.match(gitFlow, /same named change \+ same branch \+ PR creation\/update evidence/);
  assert.match(gitFlow, /不得再消耗一輪確認是否要開 change、push 或 create PR/);
  assert.match(gitFlow, /`merge` \/ release promote \/ tag push \/ destructive action/);
  assert.match(gitFlow, /Cross-repo write remains outside `\/devpro:change` batch approval and always requires separate explicit authorization/);
  assert.match(gitFlow, /devpro:change 開場必問 batch scope/);
  assert.match(gitFlow, /使用者不一定知道 `batch approval` 這個選項/);
  assert.match(gitFlow, /Cross-repo write 不列入預設\/推薦 batch scope/);
  assert.match(dpChangeSkill, /第零步：Batch Scope Confirmation/);
  assert.match(dpChangeSkill, /第一個 user-facing confirmation \/ clarification batch MUST 主動包含 batch scope 選項/);
  assert.match(dpChangeSkill, /視同已確認 `\/devpro:change <change-name>` command \+ parameter/);
  assert.match(dpChangeSkill, /不得再重問/);
  assert.match(dpChangeSkill, /Approval evidence MUST record the named change and branch/);
  assert.match(dpChangeSkill, /PR number\/head SHA need not exist/);
  assert.match(dpChangeSkill, /same named change, same branch, and PR creation\/update evidence/);
  assert.match(dpChangeSkill, /Cross-repo write remains outside `\/devpro:change` batch approval and always requires separate explicit authorization/);
  assert.match(dpChangeSkill, /取得選擇前不得執行第一個 git write/);
  assert.doesNotMatch(gitFlow, /ExternalDisclosureApproval/, "same-repo disclosure is no longer a batch scope item");
  assert.doesNotMatch(dpChangeSkill, /ExternalDisclosureApproval/, "same-repo disclosure is no longer a batch scope item");
  assert.doesNotMatch(gitFlow, /destructive action \/ cross-repo/);
  assert.doesNotMatch(dpChangeSkill, /merge\/release\/destructive\/cross-repo\/secrets/);
});

// Scenario: Host adapters dispatch same-repo second review directly
test("Host adapters dispatch same-repo second review directly", () => {
  const adapters = {
    "claude-code-cross-review.md": read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md"),
    "codex-host-cross-review.md": read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md"),
  };
  const anchors = [
    { name: "no devpro-defined per-PR ask, host prompt, or authorization command", re: /devpro 不逐 PR 詢問、不跳 host 權限窗、不跑授權指令/ },
    { name: "same-repo dispatch and sticky write-back proceed directly", re: /same-repo PR 的 reviewer packet dispatch 與 reviewer-owned sticky write-back 直接進行/ },
    { name: "execution-surface evidence stays separate from the cross-repo stop", re: /execution-surface evidence（host runner surface、approved prefix、tool allowlist）與 cross-repo 停點分開/ },
    { name: "cross-repo PR and cross-repo write still stop", re: /cross-repo PR（builder `pr_repository_mismatch`）與 cross-repo write 仍須另行明示授權並停下/ },
    { name: "consumer-added stop is an ordinary local rule", re: /consumer 在 `AGENTS\.local\.md` 自加的停點是一般 local rule，TL 照一般 local rule 處理，不是 devpro 定義的逐 PR 詢問/ },
  ];
  const check = (body, label) => {
    for (const { name, re } of anchors) assert.match(body, re, `${label}: missing anchor「${name}」`);
  };
  for (const [file, body] of Object.entries(adapters)) {
    check(body, file);
    // Each anchor is load-bearing: deleting its text turns the check red.
    for (const { name, re } of anchors) {
      const mutated = body.replace(new RegExp(re.source, "g"), "");
      assert.notEqual(mutated, body, `${file}: mutation for「${name}」must change the text`);
      assert.throws(() => check(mutated, file), `${file}: deleting「${name}」must turn the lock red`);
    }
  }

  // No platform adapter may make a consent step a precondition of same-repo dispatch.
  const dir = repoPath(".devpro/agent-rules/platform-adapters");
  const retired = [
    /ExternalDisclosureApproval/,
    /grant-lite-disclosure/,
    /resolve-cross-review-approval-context/,
    /--lite-(?:batch|explicit)-approval/,
    /lite batch grant/,
    /data-disclosure approval/,
    /resolver[- ](?:approved|approval)/,
    /採用即同意|採用告知|adoption-notice|Second-Review Disclosure Notice|disclosure_notice_|overlay 收緊/,
  ];
  const files = readdirSync(dir).filter((name) => name.endsWith(".md"));
  assert.ok(files.length >= 2, "platform-adapters directory must be non-empty");
  for (const name of files) {
    const body = readFileSync(path.join(dir, name), "utf8");
    for (const re of retired) assert.doesNotMatch(body, re, `platform-adapters/${name} must not revive ${re}`);
  }
});

// The Codex adapter embeds the Claude reviewer --system-prompt literal; it is a runtime payload, so it must
// stay byte-equal to the canonical recipe contract constant (the linked-issue sentence changed to same-repo only).
test("codex-host-cross-review embeds the current Claude reviewer system prompt", async () => {
  const { CLAUDE_REVIEWER_SYSTEM_PROMPT } = await import("../second-reviewer-cli-recipe-contract.mjs");
  const adapter = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  assert.ok(adapter.includes(`--system-prompt "${CLAUDE_REVIEWER_SYSTEM_PROMPT}"`), "adapter --system-prompt must equal CLAUDE_REVIEWER_SYSTEM_PROMPT");
  assert.ok(!adapter.includes("When linked_issue_context is issue_read_required, after the allowed"), "the pre-same-repo linked-issue sentence must be gone");
});
