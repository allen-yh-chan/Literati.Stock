#!/usr/bin/env node
/**
 * user-prompt-gate.mjs
 *
 * UserPromptSubmit hook：每輪 user 訊息後執行，分析 intent 與 git state，
 * 不一致時注入 warning 進 context；一致時靜默（避免每輪都燒 context）。
 *
 * Per GitHub issue #63 sub-item 3。Per .devpro/agent-rules/rule-design-principles.md
 * 守則 4 Token-First / usefulness first：silent default — 只在違規 surface 時 emit context。
 *
 * Input: stdin JSON with `prompt` field（UserPromptSubmit hook 格式）
 * Output: stdout JSON `{hookSpecificOutput: {hookEventName, additionalContext}}`
 *         不違規 → 空 output（exit 0）
 *
 * 偵測 intent：
 *   - PR/pull request/建 PR/create PR → pr-creation
 *   - release/deploy/promote/上線 → release
 *   - 新功能/新增/feat/實作/做 X → feature
 *   - 修 bug/fix/修正 → bugfix
 *
 * 偵測 state mismatch：
 *   - intent=feature/bugfix on main → 違規（必須建 feature/bugfix 分支）
 *   - intent=pr-creation 但 working tree dirty → 提醒 commit
 *   - intent=release on 非 release/* 分支 → 違規
 */

import { readStdin } from "./lib/stdin.mjs";
import { execSync } from "node:child_process";
import {
  evaluateRecapState,
  evaluateMergedRecapPending,
  buildRecapReminder,
} from "./lib/recap-utils.mjs";
import { resolveReminderSession, recordReminderDiagnostic } from "./lib/session-reminder.mjs";
import { isProtectedBaseBranch } from "./lib/branch-naming.mjs";

function shStr(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[，。！？!?,.；;：:、]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isRuntimeInjectedNotification(prompt) {
  return /^\s*<(?:task-notification|system-reminder)(?:\s|>|\/>)/i.test(prompt);
}

// Minimal "user 真離開" signals only (per chore wire-recap-hooks-trim-keywords D1).
// 中段轉移詞（先這樣/換題/暫停）已移除 — Stop hook 每輪 fire 已 cover 這些
// state-driven 場景；A 只負責 B 無法及時 catch 的「使用者明確結束 + 可能離開」case。
const SESSION_END_PATTERNS = [
  // 直接告別（B 沒下一輪可救的場景）
  /(^|\s)bye(\s|$)/i,
  /^(掰|掰掰|拜)$/,
  /(^|\s)(晚安|good night|gn)(\s|$)/i,
  // 取消 / drop session
  /^(算了|不做了|drop|cancel|abort)$/i,
];

function detectSessionEndIntent(prompt) {
  const n = normalize(prompt);
  return SESSION_END_PATTERNS.some((p) => p.test(n));
}

function detectIntent(prompt) {
  const intents = [];
  if (/\bPR\b|pull request|建 ?PR|create ?PR|push.*PR/i.test(prompt))
    intents.push("pr-creation");
  if (/release|deploy|promote|上線/i.test(prompt)) intents.push("release");
  if (/新功能|新增|feat\b|實作|做 [A-Z]|加上|加入/i.test(prompt))
    intents.push("feature");
  if (/修 ?bug|\bfix\b|修正|修復/i.test(prompt)) intents.push("bugfix");
  return intents;
}

function getGitState() {
  return {
    branch: shStr("git rev-parse --abbrev-ref HEAD"),
    statusPorcelain: shStr("git status --porcelain"),
    hasOpenSpecChange:
      shStr("ls -1 openspec/changes/ 2>/dev/null | grep -v archive | head -1") !== "",
  };
}

async function detectMismatches(intents, state, prompt) {
  const warnings = [];
  const branch = state.branch;
  // F8: cover all 5 protected branches (main/master/production/integration/release/*),
  // not just main/master — aligned with pre-tool-gate.mjs PROTECTED_BRANCHES + ai-autonomy.md §Never (protected-branch push ban).
  const isProtectedBranch =
    isProtectedBaseBranch(branch) ||
    /^release\//.test(branch);
  const isReleaseBranch = /^release\//.test(branch);

  // F9: dead-code regex `!/添加|增加.*文件/.test(state.branch)` removed (branch names
  // are kebab-case English; Chinese tokens never present → condition always true).
  // Warning now fires unconditionally on feature+protected.
  if (intents.includes("feature") && isProtectedBranch) {
    warnings.push(
      `Intent=feature but on '${branch}'. New features must be on feature/<name> from anchor (per /devpro:change). Run /devpro:change to start.`
    );
  }

  if (intents.includes("bugfix") && isProtectedBranch) {
    warnings.push(
      `Intent=bugfix but on '${branch}'. Bug fixes must be on bugfix/<name> from anchor (per Branch Routing decision tree).`
    );
  }

  if (intents.includes("release") && !isReleaseBranch && branch !== "main" && branch !== "master") {
    warnings.push(
      `Intent=release but on '${branch}'. Release flow runs on release/<version> branch (per release-sit-uat-pat-prod.md).`
    );
  }

  if (intents.includes("pr-creation") && state.statusPorcelain) {
    const lines = state.statusPorcelain.split("\n").filter((l) => l.trim());
    if (lines.length > 0) {
      warnings.push(
        `Intent=PR creation but working tree has ${lines.length} uncommitted change(s). Commit before /devpro:pre-pr.`
      );
    }
  }

  return warnings;
}

async function main() {
  let input = await readStdin({ timeoutMs: 1000 });
  let prompt = "";
  let payload = {};
  try {
    const parsed = JSON.parse(input || "{}");
    payload = parsed;
    prompt = parsed.prompt || parsed.user_message || "";
  } catch {
    prompt = input;
  }

  if (!prompt.trim()) {
    process.exit(0);
  }

  // Runtime callbacks are context, not new user intent. Skip both classifiers.
  if (isRuntimeInjectedNotification(prompt)) {
    process.exit(0);
  }

  const intents = detectIntent(prompt);
  const hasEndIntent = detectSessionEndIntent(prompt);
  const cwd = payload.cwd || process.cwd();
  const session = resolveReminderSession(payload);
  if (hasEndIntent && !session) recordReminderDiagnostic({cwd,kind:'recap-user-end',reason:'missing-session-identity'});
  const current = hasEndIntent ? await evaluateRecapState({cwd, session}) : {skip: true, pending: []};
  const merged = hasEndIntent ? await evaluateMergedRecapPending({cwd, session}) : {skip: true, pending: []};
  const recapReminder = buildRecapReminder({cwd, session, pending: [...(current.pending || []), ...(merged.pending || [])]});

  if (intents.length === 0 && !hasEndIntent) {
    process.exit(0);
  }

  const state = getGitState();
  const warnings = await detectMismatches(intents, state, prompt);


  if (warnings.length === 0 && !recapReminder) {
    // No violation — silent (per Token-First / usefulness first principle: avoid every-turn injection)
    process.exit(0);
  }

  const msg = [
    "### Intent / State 警示",
    "",
    `當前分支：\`${state.branch || "(none)"}\``,
    `偵測 intent：${intents.join(", ")}`,
    "",
    ...warnings.map((w) => `- ⚠️ ${w}`),
  ].join("\n");

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: [warnings.length ? msg : "", recapReminder].filter(Boolean).join("\n"),
      },
    })
  );
  process.exit(0);
}

main().catch((err) => {
  // On error, fail silently to avoid blocking workflow
  process.stderr.write(`user-prompt-gate hook error: ${err.message}\n`);
  process.exit(0);
});
