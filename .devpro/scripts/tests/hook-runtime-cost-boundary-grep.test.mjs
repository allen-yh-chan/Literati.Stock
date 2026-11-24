/**
 * hook-runtime-cost-boundary-grep.test.mjs
 *
 * Locks design-core.md §8 "Hook Runtime Cost Boundary" anchors so a future
 * edit cannot silently drop the reminder-vs-gate hook network-cost standard,
 * and mechanically enforces its "reminder hooks MUST NOT make network calls
 * in their every-turn path" rule against the current REMINDER_HOOKS surface:
 *   (A) design-core.md §8 section-heading + polarity-sensitive compound
 *       anchors (reminder MUST NOT + 網路呼叫 same physical line; gate MUST +
 *       5s + fail-open same physical line; 提案前自問 anchor).
 *   (B) REMINDER_HOOKS allowlist zero-live-network-graphql scan: none of the
 *       reminder-path files may contain a *live* `gh api graphql` call in
 *       their every-turn path.
 *
 * ── Guard 強度邊界（設計取捨，非缺陷）──────────────────────────────
 * 本 guard 不泛掃「無 timeout 呼叫」——`runShell`/`execSync`（見
 * `.devpro/scripts/hooks/lib/git-utils.mjs`）不帶 timeout 選項是全 hooks 共用
 * helper，泛掃會 100% false-positive 誤傷大量合法 bounded 呼叫（例如
 * `runGit` 讀本地 git 狀態本來就不需要 network timeout）。故本 guard 只鎖
 * 「提醒類 allowlist 檔的 `gh api graphql`（已知曾在 recap-utils.mjs 引發
 * F6/F7 #471/#472 timeout 的窄形狀）」；gate 類 hook 的「每個網路呼叫都要有
 * 5s timeout」屬 grep-guard 極限外的規範，靠 §8 標準文字 + code review
 * cooperative carrier 承載，本檔不試圖機械證明。marker-GC 的
 * `gh pr list --limit N`（D-B3 選項 1 保留、`recap-check.mjs` /
 * `recap-utils.mjs` 的 `execFileCapture` 現有呼叫）屬合法 gate-ish 網路探測、
 * 非本檔射程。
 *
 * `gh api graphql` 這個 phrase 本身在三個 reminder hook 檔
 * （`user-prompt-gate.mjs` / `recap-check.mjs` / `session-start.mjs`）內仍會
 * 出現——但那是包在 markdown code-span（反引號）內、輸出給呼叫端 AI 看的
 * **指示文字**（"Next AI action: 直接用 `gh api graphql` 建立 Discussion…"），
 * 提醒 AI 自己動手執行，不是 hook 自身每輪路徑執行的網路 I/O。真正違規的
 * live-call 形狀（例如 `execSync("... gh api graphql ...")` /
 * `runShell(\`gh api graphql ...\`)`）phrase 前面不會緊貼反引號（前面是
 * 引號、空白、或 `(`）。故掃描規則採「該 phrase 出現位置前一字元若不是
 * 反引號 `` ` `` 才算違規」（逐行 `/(^|[^`])gh api graphql/`），刻意排除
 * 反引號包裹的指示形。這是 grep 近似：若有人刻意把真 live call 硬寫進反引號
 * 字串常量內（例如 `execSync(\`gh api graphql ...\`)` 這種 phrase 前一字元
 * 恰好也是反引號的邊界案例）可規避本 guard，屬已知 grep-guard 極限，靠
 * code review 承載。
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");

const designCorePath = resolve(repoRoot, ".devpro/agent-rules/design-core.md");
const designCoreContent = readFileSync(designCorePath, "utf8");

// REMINDER_HOOKS: reminder-class hook files whose every-turn path MUST NOT
// make live network calls (per design-core §8). recap-utils.mjs is the
// shared lib consumed by the other three hooks (user-prompt-gate.mjs
// UserPromptSubmit, recap-check.mjs Stop, session-start.mjs SessionStart).
const REMINDER_HOOKS = [
  ".devpro/scripts/hooks/user-prompt-gate.mjs",
  ".devpro/scripts/hooks/recap-check.mjs",
  ".devpro/scripts/hooks/session-start.mjs",
  ".devpro/scripts/hooks/lib/recap-utils.mjs",
];

// Live-call shape: `gh api graphql` NOT immediately preceded by a backtick.
// Backtick-preceded occurrences are markdown code-span instructional text
// ("Next AI action: 直接用 `gh api graphql` 建立 Discussion…") aimed at the
// calling AI, not a hook-executed network call.
const LIVE_GRAPHQL_CALL_RE = /(^|[^`])gh api graphql/;

test("design-core.md §8 Hook Runtime Cost Boundary 段標題存在", () => {
  assert.ok(
    designCoreContent.includes("### 8. Hook Runtime Cost Boundary"),
    "design-core.md 期望含 §8 段標題「### 8. Hook Runtime Cost Boundary」，未找到 — hook 網路成本邊界標準可能被移除或改名"
  );
});

test("提醒類錨點：MUST NOT + 網路呼叫 同一物理行（polarity-sensitive compound）", () => {
  // Compound：`MUST NOT`、`網路呼叫` 必須同一物理行，禁 cross-file / 拆兩個
  // 獨立 includes——否則規則被反轉成「提醒類可以發網路呼叫」時，`MUST NOT`
  // 仍可能由 §8 其他句（如 gate 類段落中提及的其他 MUST NOT）供應，造成偽陽。
  const reminderMustNotClause = /MUST NOT[^\n]*網路呼叫|網路呼叫[^\n]*MUST NOT/;
  assert.ok(
    reminderMustNotClause.test(designCoreContent),
    "期望「**MUST NOT**：提醒類 hook 的每輪路徑發任何網路呼叫」同一物理行綁定，未找到 — 若提醒類零網路規則被反轉或拆到不同行，guard 會偽陽放行"
  );
});

test("gate 類錨點：MUST + 5s + fail-open 同一物理行（polarity-sensitive compound）", () => {
  // Compound：`MUST`、`5s`、`fail-open` 三者必須同一物理行。
  const gateMustClause = /MUST[^\n]*5s[^\n]*fail-open|MUST[^\n]*fail-open[^\n]*5s/;
  assert.ok(
    gateMustClause.test(designCoreContent),
    "期望「**MUST**：gate 類 hook 的每個網路呼叫帶固定 per-call timeout（寫死 5s）+ fail-open」三者同一物理行綁定，未找到 — 若 gate 類 5s/fail-open 要求被弱化或拆到不同行，guard 會偽陽放行"
  );
});

test("提案前自問錨點：含「提醒還是 gate」判準句", () => {
  assert.ok(
    designCoreContent.includes("提醒還是 gate"),
    "期望 §8「提案前自問」含「這 hook 是**提醒還是 gate**？」判準句，未找到 — 落地前自問的分類判準可能被移除"
  );
});

test("REMINDER_HOOKS 各檔零 live gh api graphql 呼叫", () => {
  for (const relPath of REMINDER_HOOKS) {
    const content = readFileSync(resolve(repoRoot, relPath), "utf8");
    const lines = content.split("\n");
    const violatingLines = [];
    lines.forEach((line, idx) => {
      if (LIVE_GRAPHQL_CALL_RE.test(line)) {
        violatingLines.push(`L${idx + 1}: ${line.trim()}`);
      }
    });
    assert.equal(
      violatingLines.length,
      0,
      `${relPath} 期望零 live \`gh api graphql\` 呼叫（reminder hook 每輪路徑 MUST NOT 碰網路，per design-core §8），但找到:\n${violatingLines.join("\n")}\n` +
        `— 若這是刻意加的 live 呼叫，違反 §8 提醒類零網路規則，應改為 local marker/fs 訊號`
    );
  }
});

test("network guard accepts quoted instruction and rejects actual live-call text", () => {
  // Permanent two-way fixtures remain useful after reminder text moves into
  // scoped detail files; startup and compact reminders need no GraphQL prose.
  assert.equal(LIVE_GRAPHQL_CALL_RE.test('Next AI action: 直接用 `gh api graphql` 建立 Discussion。'), false);
  assert.equal(LIVE_GRAPHQL_CALL_RE.test('execSync("gh api graphql --field query=...")'), true);
});
