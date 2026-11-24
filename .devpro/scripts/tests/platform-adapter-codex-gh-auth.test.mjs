import { it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sourcePath } from "./lib/source-root.mjs";

const codexAdapterPath = sourcePath(".devpro/agent-rules/platform-adapters/codex.md");
const claudeCodeAdapterPath = sourcePath(".devpro/agent-rules/platform-adapters/claude-code.md");
const cursorAdapterPath = sourcePath(".devpro/agent-rules/platform-adapters/cursor.md");
const copilotAdapterPath = sourcePath(".devpro/agent-rules/platform-adapters/copilot.md");
const geminiAdapterPath = sourcePath(".devpro/agent-rules/platform-adapters/gemini.md");
const aiAutonomyPath = sourcePath(".devpro/agent-rules/ai-autonomy.md");

it("Codex adapter distinguishes sandbox network failure from gh token invalid", async () => {
  const content = await fs.readFile(codexAdapterPath, "utf8");

  assert.match(content, /風險 D/);
  assert.match(content, /風險 G/);
  assert.match(content, /sandbox network/);
  assert.match(content, /gh auth status/);
  assert.match(content, /gh pr list --state merged/);
  assert.match(content, /compliance telemetry/);
  assert.match(content, /api\.github\.com/);
  assert.match(content, /network unavailable/);
  assert.match(content, /token invalid/);
  assert.match(content, /測試 regression/);
  assert.match(content, /sandbox 外/);
  assert.match(content, /GitHub connector/);
  assert.match(content, /不得只憑 sandbox 內 `gh auth status` 要求使用者重登/);
});

it("Codex adapter turns known risks into proactive first-command choices", async () => {
  const content = await fs.readFile(codexAdapterPath, "utf8");

  assert.match(content, /### Proactive First-Command Matrix/);
  assert.match(content, /第一個命令就必須改形/);
  assert.match(content, /Node 20-compatible PATH or explicit Node 20 invocation from the first attempt/);
  assert.match(content, /bash -lc shell switch risk/);
  assert.match(content, /source nvm first/);
  assert.match(content, /MUST NOT rely on ambient PATH after shell switch/);
  assert.match(content, /capture-command\.mjs --topic <topic> -- <cmd>/);
  assert.match(content, /approved non-sandbox \/ host command from the first release\/PR gate attempt/);
  assert.match(content, /approved prefix \/ `prefix_rule` \/ tool allowlist/);
  assert.match(content, /不.*代表該命令已在 non-sandbox \/ host surface 執行/);
  assert.match(content, /需要 host auth\/session\/network 的 CLI 模式/);
  assert.match(content, /MUST NOT 在 Codex sandbox 內跑第一個真實 invocation/);
  assert.match(content, /non-sandbox \/ host runner stdout\/stderr\/exit evidence/);
  assert.match(content, /MUST NOT 再附加 sandbox-escalation wrapper/);
  assert.match(content, /immediate literal `cd <path> && pwd && git rev-parse --abbrev-ref HEAD && git status --short --branch` evidence/);
  assert.match(content, /\| Protected-branch git write inside Codex worktree \|[^|\n]*command string itself carry worktree evidence:[^|\n]*`git -C <abs-worktree> \.\.\.`[^|\n]*separate Bash calls/);
  assert.match(content, /command string itself|命令字串本身/);
  assert.match(content, /`git -C <abs-worktree> \.\.\.`/);
  assert.doesNotMatch(content, /cd <abs-worktree> && git/);
  assert.match(content, /tool_input\.cwd` \/ `tool_input\.workdir`/);
  assert.match(content, /不得把「tool call UI 有 workdir」當成 hook 可見證據/);
  assert.match(content, /rediscover an already documented Codex adapter risk/);
});

it("Codex adapter forbids sandbox for host-auth CLI modes", async () => {
  const content = await fs.readFile(codexAdapterPath, "utf8");

  assert.match(content, /Host-auth\/session\/network CLI mode/);
  assert.match(content, /`git fetch\/pull\/push`/);
  assert.match(content, /`gh auth\/api\/pr comment\/pr edit`/);
  assert.match(content, /`claude auth status` \/ `claude -p`/);
  assert.match(content, /`codex exec`/);
  assert.match(content, /Codex sandbox cannot access usable keychain\/session\/OAuth\/network write-back auth/);
  assert.match(content, /sandbox 內最多跑 no-auth local probes/);
  assert.match(content, /`git status` \/ `git diff`/);
  assert.match(content, /full-access host surface/);
  assert.match(content, /approval\/sandbox 斷點/);
});

it("Codex-only first-command shapes stay out of shared agent rules", async () => {
  const root = sourcePath(".devpro/agent-rules");
  const offenders = [];

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      const rel = path.relative(root, full);
      if (rel === path.join("platform-adapters", "codex.md")) continue;
      const content = await fs.readFile(full, "utf8");
      for (const pattern of [
        "Node 20-compatible PATH or explicit Node 20 invocation from the first attempt",
        "approved non-sandbox / host command from the first release/PR gate attempt",
        "immediate literal `cd <path> && pwd && git rev-parse --abbrev-ref HEAD && git status --short --branch` evidence",
        "then make the git write command string itself carry worktree evidence",
      ]) {
        if (content.includes(pattern)) offenders.push(`${rel}: ${pattern}`);
      }
    }
  }

  await walk(root);
  assert.deepEqual(offenders, []);
});

it("Codex adapter routes GitHub through the shared CLI-first policy without exempting footer obligations", async () => {
  const codex = await fs.readFile(codexAdapterPath, "utf8");
  const aiAutonomy = await fs.readFile(aiAutonomyPath, "utf8");
  assert.match(codex, /tool-selection\.md/);
  assert.match(codex, /其他 connector 仍唯讀/);
  assert.match(codex, /未證明即停止受影響寫入/);
  assert.match(aiAutonomy, /必須由對應 host 的結構化參數 hook 與後端共用政策驗證/);
});

it("Codex adapter requires strict footer preflight for functions.exec_command body-file writes", async () => {
  const codex = await fs.readFile(codexAdapterPath, "utf8");

  assert.match(codex, /風險 K/);
  assert.match(codex, /functions\.exec_command/);
  assert.match(codex, /append the required footer/);
  assert.match(codex, /MUST NOT rely on repo hook auto-block/);
  assert.match(codex, /--strict-exit -- <gh command\.\.\.>/);
  assert.match(codex, /--body-file/);
  assert.match(codex, /CODEX_CI/);
  assert.match(codex, /CODEX_THREAD_ID/);
});

it("platform adapters document hook cwd assumptions or non-applicability", async () => {
  const codex = await fs.readFile(codexAdapterPath, "utf8");
  const claudeCode = await fs.readFile(claudeCodeAdapterPath, "utf8");
  const cursor = await fs.readFile(cursorAdapterPath, "utf8");
  const copilot = await fs.readFile(copilotAdapterPath, "utf8");
  const gemini = await fs.readFile(geminiAdapterPath, "utf8");

  for (const [name, content] of [
    ["codex", codex],
    ["claude-code", claudeCode],
    ["cursor", cursor],
  ]) {
    assert.match(content, /hook-visible cwd evidence/, `${name} must name hook-visible cwd evidence`);
    assert.match(content, /git -C <(?:abs-|)worktree/, `${name} must include a git -C worktree command shape`);
  }

  for (const [name, content] of [
    ["copilot", copilot],
    ["gemini", gemini],
  ]) {
    assert.match(content, /No repo PreToolUse hook surface is assumed/, `${name} must state hook surface non-applicability`);
    assert.match(content, /RuntimeCaps/, `${name} must tie future hook reliance to RuntimeCaps evidence`);
  }
});

it("Scenario: Read-only work does not eagerly load cold Codex recipes", async () => {
  const content = await fs.readFile(codexAdapterPath, "utf8");
  assert.match(content, /唯讀不載 GitHub-write／reviewer CLI／workflow capability／post-PR leaves/);
});

it("Scenario: Read-only discovery loads the named leaf before an action", async () => {
  const content = await fs.readFile(codexAdapterPath, "utf8");
  assert.match(content, /唯讀轉 GitHub-write／reviewer／workflow／post-PR action 前載對應 Load-chain leaf\+gate/);
});

it("Scenario: Class-two safety anchors remain in the active entry without proven gate coverage", async () => {
  const content = await fs.readFile(codexAdapterPath, "utf8");
  assert.match(content, /identity\/authorization.*PII\/secret\/credential\/attribution\/gate visibility/);
  assert.match(content, /同一 class-two mechanical gate 未證每次 action 覆蓋這些 anchors 前，不得移出/);
});

it("Scenario: PR creation triggers completion loading without another gh call", async () => {
  const content = await fs.readFile(codexAdapterPath, "utf8");
  assert.match(content, /PR create\/update 後 \| 載 post-pr-completion-gate\.md（無後續 gh 亦同）/);
  assert.match(content, /complete\/ready\/merge 前重驗/);
});
