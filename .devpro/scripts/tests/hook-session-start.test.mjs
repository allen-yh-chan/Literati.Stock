/**
 * hook-session-start.test.mjs
 *
 * Unit tests for .devpro/scripts/hooks/session-start.mjs.
 *
 * Test cases:
 *   1. No recap-pending markers → output 含 AGENTS.md SSOT pointer，不含 Recap 提醒區段
 *   2. recap-pending marker 存在 → output 含 AGENTS.md SSOT pointer AND Recap 提醒區段（含 branch）
 *   3. Codex env (CODEX_CI=1) → output 含 hookSpecificOutput.additionalContext，無 additional_context
 *   4. Claude env → output 含 hookSpecificOutput.additionalContext，無 additional_context
 *   5. Recap section 不影響 base msg（AGENTS.md pointer 仍存在）
 *   6. full/lite static payload 不複製 AGENTS.md 長段、Intent 表格或輸出紀律 bullets
 *   7. SessionStart 進場靜默：session-pending 有內容也不注入 #2 提醒（僅保留
 *      #1 record-a-gap 提示）——反向 guard，防止已移除的條件式 pending 注入被誤加回來
 *
 * 採子程序測試（spawnSync）以隔離 env + 驗證真實 hook 輸出。
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./lib/portable-command-shims.cjs";
import { makeTempDir } from "./lib/tmp.mjs";

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/session-start.mjs"
);

const tmpRoot = makeTempDir("session-start-test-");

after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

let counter = 0;
function freshDirs() {
  const root = path.join(tmpRoot, `case-${counter++}`);
  return {
    pending: path.join(root, "pending"),
    state: path.join(root, "state"),
    home: path.join(root, "home"),
  };
}

/**
 * Create a fake-bin dir with a `git` + `gh` shim, prepended to PATH so that
 * evaluateMergedRecapPending's isConfirmedNonexistentBranch probe sees the
 * marker's branch as EXISTING (and thus does NOT clear the pending marker).
 *
 * Without this, a recap-pending marker for a branch that does not actually
 * exist in the real repo (the test fixtures use throwaway names) is cleared by
 * the confirmed-nonexistent-branch cleanup (issue #960), so the Recap reminder
 * would never render. The fake `git branch --list <existing>` echoes the branch
 * name (→ "exists"); fake `gh` prints nothing (checkDiscussionExists fail-open
 * → false, so it does not pre-clear the marker either).
 *
 * @param {string} existingBranch - branch name the fake git reports as present
 * @returns {string} bin dir to prepend to PATH
 */
function makeBranchExistsBin(existingBranch) {
  const binDir = path.join(tmpRoot, `bin-${counter++}`);
  mkdirSync(binDir, { recursive: true });
  // fake git: only `branch --list <existingBranch>` echoes the name; anything
  // else prints nothing and exits 0 (harmless for this hook's code path).
  const gitShim = [
    "#!/bin/sh",
    'if [ "$1" = "branch" ] && [ "$2" = "--list" ]; then',
    `  if [ "$3" = ${JSON.stringify(existingBranch)} ]; then printf '%s\\n' ${JSON.stringify(`  ${existingBranch}`)}; fi`,
    "  exit 0",
    "fi",
    "exit 0",
  ].join("\n");
  const ghShim = "#!/bin/sh\nprintf ''\nexit 0\n";
  const gitPath = path.join(binDir, "git");
  const ghPath = path.join(binDir, "gh");
  writeFileSync(gitPath, gitShim, "utf8");
  writeFileSync(ghPath, ghShim, "utf8");
  chmodSync(gitPath, 0o755);
  chmodSync(ghPath, 0o755);
  return binDir;
}

function run({ env = {}, prepareDirs, pathPrefix, cwd } = {}) {
  const dirs = freshDirs();
  if (prepareDirs) prepareDirs(dirs);
  const PATH = pathPrefix
    ? `${pathPrefix}${path.delimiter}${process.env.PATH}`
    : process.env.PATH;
  const result = spawnSync("node", [HOOK], {
    encoding: "utf8",
    cwd,
    env: {
      ...process.env,
      DEVPRO_AGENT_RULES_LEVEL: "full",
      CODEX_CI: "",
      CODEX_THREAD_ID: "",
      DEVPRO_RECAP_PENDING_DIR: dirs.pending,
      DEVPRO_RECAP_STATE_DIR: dirs.state,
      DEVPRO_RUNTIME_CONSENT_HOME: dirs.home,
      DEVPRO_RUNTIME_CONSENT_ACK: "",
      ...env,
      PATH,
    },
  });
  let parsed = null;
  if (result.stdout && result.stdout.trim()) {
    try {
      parsed = JSON.parse(result.stdout);
    } catch {}
  }
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: parsed,
  };
}

function contextFrom(json) {
  return json.hookSpecificOutput?.additionalContext;
}

function assertBasePointer(context) {
  assert.match(context, /session-pending：待辦\/缺口當下處理不了/);
  assert.doesNotMatch(context, /\u52a0\u901f\u63d0\u9192/);
  assert.match(context, /notes\/session-pending\.md/);
  assert.match(context, /當下處理不了/);
  assert.match(context, /compact 隨時來不丟/);
  assert.match(context, /AGENTS\.md 是啟動規範 SSOT/);
  assert.match(context, /先讀 AGENTS\.md 並輸出載入宣告/);
  assert.match(context, /動手前自檢、Intent 速查、輸出紀律與觸發式 leaf 索引/);
  assert.match(context, /AGENTS\.md \+ stop-point-comms\.md/);
  assert.match(context, /為什麼停／要你做什麼／回了會怎樣/);
  assert.match(context, /選項編號且末項開放/);
}

function assertNoLongBootstrapDuplication(context) {
  assert.doesNotMatch(context, /\[CORRECTION\]/);
  assert.doesNotMatch(
    context,
    /###\s*動手前十句自檢|\d+\.\s+\*\*追溯性\*\*|\d+\.\s+\*\*複雜度\*\*/,
    "SessionStart static payload must not duplicate the full 動手前十句自檢 section"
  );
  assert.doesNotMatch(
    context,
    /\|意圖\/情境\|入口\||\|功能\|`openspec-flow\.md`\||\|審查 PR\|`code-review-checklist\.md`/,
    "SessionStart static payload must not duplicate the Intent 速查 table"
  );
  assert.doesNotMatch(
    context,
    /###\s*輸出紀律|\*\*memory\*\*：可規範化內容沉澱為共享規範/,
    "SessionStart static payload must not duplicate AGENTS.md 輸出紀律 bullets"
  );
}

test("No recap-pending markers → AGENTS.md pointer + session-pending reminder, no Recap 提醒", () => {
  const r = run();
  assert.equal(r.code, 0);
  assert.ok(r.json);
  const context = contextFrom(r.json);
  assertBasePointer(context);
  assertNoLongBootstrapDuplication(context);
  assert.doesNotMatch(context, /跨 session Recap 提醒/);
  assert.equal(r.json.additional_context, undefined);
});

test("legacy recap-pending marker exists → startup stays silent", () => {
  const branch = "feature/test-recap-cross-session";
  const r = run({
    // fake git reports the branch as existing so the confirmed-nonexistent
    // cleanup (issue #960) does NOT clear the marker before the reminder renders
    pathPrefix: makeBranchExistsBin(branch),
    prepareDirs: (dirs) => {
      mkdirSync(dirs.pending, { recursive: true });
      // sanitized form of feature/test-recap-cross-session
      writeFileSync(
        path.join(dirs.pending, "feature_test-recap-cross-session"),
        String(Date.now())
      );
    },
  });
  assert.equal(r.code, 0);
  assert.ok(r.json);
  const context = contextFrom(r.json);
  assertBasePointer(context); // base msg 仍在
  assertNoLongBootstrapDuplication(context);
  assert.doesNotMatch(context, /跨 session Recap 提醒|feature\/test-recap-cross-session/);
  assert.equal(r.json.additional_context, undefined);
});

test("Codex env (CODEX_CI=1) → 含 hookSpecificOutput.additionalContext", () => {
  const r = run({ env: { CODEX_CI: "1" } });
  assert.equal(r.code, 0);
  assert.ok(r.json);
  assert.equal(r.json.hookSpecificOutput?.hookEventName, "SessionStart");
  assert.ok(typeof contextFrom(r.json) === "string");
  assert.equal(r.json.additional_context, undefined);
});

test("Claude env (no Codex flags) → 含 hookSpecificOutput.additionalContext", () => {
  const r = run();
  assert.equal(r.code, 0);
  assert.ok(r.json);
  assert.equal(r.json.hookSpecificOutput?.hookEventName, "SessionStart");
  assert.ok(typeof contextFrom(r.json) === "string");
  assert.equal(r.json.additional_context, undefined);
});

test("Codex env + legacy recap-pending marker → no backlog injection", () => {
  const branch = "bugfix/codex-recap";
  const r = run({
    env: { CODEX_CI: "1" },
    // fake git reports the branch as existing so the confirmed-nonexistent
    // cleanup (issue #960) does NOT clear the marker before the reminder renders
    pathPrefix: makeBranchExistsBin(branch),
    prepareDirs: (dirs) => {
      mkdirSync(dirs.pending, { recursive: true });
      writeFileSync(
        path.join(dirs.pending, "bugfix_codex-recap"),
        String(Date.now())
      );
    },
  });
  assert.equal(r.code, 0);
  assert.doesNotMatch(contextFrom(r.json), /跨 session Recap 提醒|bugfix\/codex-recap/);
  assert.equal(r.json.additional_context, undefined);
});

test("Non-work-branch marker → 不出現在提醒區段（auto-cleared）", () => {
  const r = run({
    prepareDirs: (dirs) => {
      mkdirSync(dirs.pending, { recursive: true });
      // main 不是 work branch，evaluateMergedRecapPending 會自動清
      writeFileSync(path.join(dirs.pending, "main"), String(Date.now()));
    },
  });
  assert.equal(r.code, 0);
  assert.doesNotMatch(contextFrom(r.json), /跨 session Recap 提醒/);
  assert.equal(r.json.additional_context, undefined);
});

test("base SessionStart payload is pointer-only and does not mirror AGENTS.md long sections", () => {
  const r = run();
  assert.equal(r.code, 0);
  assert.ok(r.json, "hook 應輸出合法 JSON");
  const context = contextFrom(r.json);

  assertBasePointer(context);
  assertNoLongBootstrapDuplication(context);
});

test("SessionStart points loading declarations at the shared exact/family/unknown identity resolver", () => {
  const r = run();
  assert.equal(r.code, 0);
  assert.ok(r.json, "hook 應輸出合法 JSON");
  const context = contextFrom(r.json);

  assert.match(
    context,
    /(?:載入宣告|loading declaration)[^\n]*platform-adapter-contract\.md[^\n]*trusted exact[^\n]*(?:->|→|otherwise|否則)[^\n]*(?:trusted )?family(?:\/config alias)?[^\n]*(?:->|→|otherwise|否則)[^\n]*`?unknown`?/i,
    "SessionStart must point to the shared resolver and preserve exact → family → unknown order"
  );
  assert.match(
    context,
    /(?:footer|attribution|provenance)[^\n]*(?:reuse|共用|重用)[^\n]*(?:same resolved identity|同一次 resolved identity|相同 resolved identity)[^\n]*(?:MUST NOT|不得)[^\n]*(?:more specific|更具體)/i,
    "SessionStart must prevent footer/provenance from resolving a more-specific identity independently"
  );
});

test("SessionStart 進場靜默：session-pending 有內容也不注入 #2 提醒，僅保留 #1 record-a-gap 提示", () => {
  // 決策：SessionStart 常是使用者要開新 change 的起點，此刻注入「你有 N 條
  // 舊待辦」是時機錯配（干擾往前做）。pending 提醒的正確時機是離場（Stop
  // hook）與 merge 後（post-merge-check），非進場（Usability-First 時機維
  // 度）。原本存在的條件式注入（#2：`buildSessionPendingSection`）已刻意移
  // 除；本測試是反向 guard——即使 fixture 刻意提供「非空、含 list-item」的
  // session-pending.md（原本會觸發 #2 注入的條件），也必須確認 #2 不會被
  // 加回來，同時 #1（無條件 record-a-gap 提示，於 msg/msgLean 常數中）仍完整保留。
  const notesDir = path.join(tmpRoot, `notes-${counter++}`);
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(
    path.join(notesDir, "session-pending.md"),
    "# Session Pending\n\n- 待辦：完成 T2 實作\n- 待辦：跑測試確認全綠\n"
  );
  const r = run({ env: { DEVPRO_NOTES_DIR: notesDir } });
  assert.equal(r.code, 0);
  assert.ok(r.json, "hook 應輸出合法 JSON");
  const context = contextFrom(r.json);

  assert.doesNotMatch(
    context,
    /新 session：session-pending 待辦存在/,
    "#2（進場條件式 pending 提醒）已刻意移除：非空 session-pending.md 不應觸發此標題"
  );
  assert.doesNotMatch(
    context,
    /新 session 請先讀此檔/,
    "#2 已刻意移除：不應出現「新 session 請先讀此檔」文案"
  );
  assert.match(
    context,
    /session-pending：待辦\/缺口當下處理不了/,
    "#1（無條件 record-a-gap 提示）必須保留：防止移除 #2 時誤傷 #1，也防止 #2 被誤加回來"
  );
  assert.doesNotMatch(context, /\u52a0\u901f\u63d0\u9192/);
  // 內容洩漏 guard：#2 若以不同措辭被加回來（不含舊標題、直接 echo 待辦條目），
  // 只驗標題缺席會漏接。故額外斷言 fixture 自身的 pending item 內文不得出現在
  // payload——SessionStart pointer-only，永不複製 session-pending.md 的條目內容。
  assert.doesNotMatch(
    context,
    /完成 T2 實作|跑測試確認全綠/,
    "#2 已移除且 payload 為 pointer-only：session-pending.md 的條目內文不得被注入 payload（防不同措辭的 entry-time 注入繞過標題 guard）"
  );
});

// Prove-it (#2519): lite MUST announce level=lite / exemptions and MUST NOT
// equal full `msg`. On production tip without msgLite this assertion is RED.
test("lite rigor level → additionalContext announces level=lite exemptions (≠ full msg)", () => {
  const full = run({ env: { DEVPRO_AGENT_RULES_LEVEL: "full" } });
  assert.equal(full.code, 0, full.stderr);
  assert.ok(full.json);
  const fullContext = contextFrom(full.json);

  const lite = run({ env: { DEVPRO_AGENT_RULES_LEVEL: "lite" } });
  assert.equal(lite.code, 0, lite.stderr);
  assert.ok(lite.json);
  const liteContext = contextFrom(lite.json);

  assert.match(
    liteContext,
    /level=lite/,
    "lite SessionStart MUST announce level=lite (#2519 advisory announce gap)"
  );
  assert.match(
    liteContext,
    /AGENTS\.md/,
    "lite SessionStart MUST still identify AGENTS.md as SSOT (Pointer-Only Bootstrap)"
  );
  assert.match(
    liteContext,
    /OpenSpec/,
    "lite SessionStart MUST announce OpenSpec exemption semantics"
  );
  assert.match(
    liteContext,
    /免|exempt/i,
    "lite SessionStart MUST carry exemption wording"
  );
  // Retained gates (design D2) — prevent lite≈off misunderstanding.
  assert.match(liteContext, /4 底線|baseline/i);
  assert.match(liteContext, /測試綠燈/);
  assert.match(liteContext, /cooperative.*SQL|SQL/i);
  assert.match(liteContext, /post-pr-completion/);
  assert.match(liteContext, /P2 keep\/P3 degrade|P2 keep/);
  assert.match(
    liteContext,
    /cross-model-sticky-merge-review.*BLOCK|仍 BLOCK/
  );
  assert.ok(
    Buffer.byteLength(liteContext, "utf8") <= 1000,
    `lite additionalContext ${Buffer.byteLength(liteContext, "utf8")}B exceeds 1000B`
  );
  assert.notEqual(
    liteContext,
    fullContext,
    "lite additionalContext MUST NOT be byte-identical to full msg (#2519)"
  );
});

test("root AGENTS.local.md absent → no consumer local overlay section", () => {
  const cwd = path.join(tmpRoot, `overlay-absent-${counter++}`);
  mkdirSync(cwd, { recursive: true });
  const r = run({ cwd });
  assert.equal(r.code, 0);
  assert.ok(r.json);
  const context = contextFrom(r.json);
  assert.doesNotMatch(context, /### Consumer local overlay/);
  assert.doesNotMatch(context, /AGENTS\.local\.md/);
});

test("root AGENTS.local.md present → pointer-only overlay section (all rigor levels)", () => {
  for (const level of ["full", "lite", "off"]) {
    const cwd = path.join(tmpRoot, `overlay-present-${level}-${counter++}`);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      path.join(cwd, "AGENTS.local.md"),
      "# should never be injected into SessionStart payload\nSECRET_OVERLAY_BODY\n"
    );
    const r = run({
      cwd,
      env: { DEVPRO_AGENT_RULES_LEVEL: level },
    });
    assert.equal(r.code, 0, `level=${level}: ${r.stderr}`);
    assert.ok(r.json);
    const context = contextFrom(r.json);
    assert.match(context, /AGENTS\.local\.md/);
    assert.match(context, /additive-only/i);
    assert.match(context, /source wins/i);
    assert.ok(
      Buffer.byteLength(context, "utf8") <= 1000,
      `level=${level}: additionalContext ${Buffer.byteLength(context, "utf8")}B exceeds hook-payload-policy 1000B`
    );
    assert.doesNotMatch(
      context,
      /SECRET_OVERLAY_BODY/,
      "SessionStart must remain pointer-only; never inject AGENTS.local.md body"
    );
  }
});

test("nested cwd still detects repo-root AGENTS.local.md via getRepoRoot", () => {
  const repo = path.join(tmpRoot, `overlay-nested-${counter++}`);
  const nested = path.join(repo, "packages", "app");
  mkdirSync(nested, { recursive: true });
  writeFileSync(
    path.join(repo, "AGENTS.local.md"),
    "# root overlay\nSECRET_NESTED_OVERLAY_BODY\n"
  );
  const init = spawnSync("git", ["init", "--quiet"], {
    cwd: repo,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(init.status, 0, `git init: ${init.stderr}`);
  const r = run({ cwd: nested });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.json);
  const context = contextFrom(r.json);
  assert.match(
    context,
    /AGENTS\.local\.md/,
    "nested cwd must still append overlay pointer from git toplevel"
  );
  assert.match(context, /additive-only/i);
  assert.doesNotMatch(context, /SECRET_NESTED_OVERLAY_BODY/);
  assert.ok(Buffer.byteLength(context, "utf8") <= 1000);
});

// ── Runtime consent section removed (remove-claude-subagent-env-consent-expectation) ──
// SessionStart used to compare the user-local Claude / Codex settings with recommended
// subagent concurrency and nesting values and print a "Runtime consent" diff section.
// Those values are no longer recommended, so no home-directory shape may produce the
// section. `run()` still points DEVPRO_RUNTIME_CONSENT_HOME at the fresh home so a
// reintroduced checker behind the same variable would be caught here.

test("no runtime consent section: SessionStart never recommends user-local subagent settings", () => {
  const homes = {
    "claude settings without env": (dirs) => {
      mkdirSync(path.join(dirs.home, ".claude"), { recursive: true });
      writeFileSync(path.join(dirs.home, ".claude", "settings.json"), JSON.stringify({ env: {} }), "utf8");
    },
    "codex dir without [agents]": (dirs) => {
      mkdirSync(path.join(dirs.home, ".codex"), { recursive: true });
    },
    "claude settings unreadable": (dirs) => {
      mkdirSync(path.join(dirs.home, ".claude"), { recursive: true });
      writeFileSync(path.join(dirs.home, ".claude", "settings.json"), "{ not json", "utf8");
    },
  };
  for (const [label, prepareDirs] of Object.entries(homes)) {
    const r = run({ prepareDirs });
    assert.equal(r.code, 0, `${label}: ${r.stderr}`);
    const context = contextFrom(r.json);
    assert.doesNotMatch(context, /Runtime consent/, label);
    assert.doesNotMatch(
      context,
      /CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS|CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH|max_concurrent_threads_per_session|DEVPRO_RUNTIME_CONSENT_ACK/,
      label,
    );
  }
});

test("default startup is lite and full escalation requires reason plus explicit authorization", () => {
  const r = run({env: {DEVPRO_AGENT_RULES_LEVEL: ''}});
  assert.match(contextFrom(r.json), /level=lite/);
  assert.match(contextFrom(r.json), /B 形狀不等於 full/);
  assert.match(contextFrom(r.json), /rules-rigor-level\.md/);
  assert.match(contextFrom(r.json), /理由.*使用者明確同意/);
});

test("malformed rigor protects hooks without granting a full workflow", () => {
  const r = run({env: {DEVPRO_AGENT_RULES_LEVEL: 'ful'}});
  const context = contextFrom(r.json);
  assert.match(context, /level=lite/);
  assert.match(context, /hooks full.*修設定.*full 未授權/);
  assert.ok(Buffer.byteLength(context) + 100 <= 1000, 'retain overlay/drift headroom');
});


test('#3398 lite bootstrap retains Consumer Pre-PR Checks and pre-pr action from rigor matrix', () => {
  const r = run({ env: { DEVPRO_AGENT_RULES_LEVEL: 'lite' } });
  const context = contextFrom(r.json);
  assert.match(context, /保留 Consumer Pre-PR Checks[^\n]*開 PR 前仍須 \/devpro:pre-pr/);
  const matrix = readFileSync(path.resolve(path.dirname(HOOK), '../../agent-rules/rules-rigor-level.md'), 'utf8');
  assert.match(matrix, /^\| Consumer Pre-PR Checks[^\n]*\| 走 \| 走 \| 工程師自負 \|$/m);
  assert.ok(Buffer.byteLength(context) <= 850, 'leave room for all existing dynamic cues');
});
