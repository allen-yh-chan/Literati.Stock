/**
 * hook-payload-sync.test.mjs
 *
 * 驗證 hook payload（session-start.mjs）維持 AGENTS.md SSOT pointer-only 行為。
 * AGENTS.md 為 source of truth；hook payload 不再 mirror 長段內容。
 *
 * 測試段落：
 *   - SessionStart JSON shape uses hookSpecificOutput.additionalContext
 *   - static msg contains a short AGENTS.md/load pointer
 *   - static msg does not duplicate AGENTS.md long sections / tables
 *   - dynamic recap and session-pending reminders are tested by session-start tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

/** SHA-256 of `const msg` / `const msgLean` array bodies at production-v6.93.0 (5224b991). */
const MSG_ARRAY_BODY_SHA256_V6930 =
  "15f9e74eb5909f32a74924e919d136c0e3ce9bbcc4087ce6e5f2da1194ced6cb";
const MSG_LEAN_ARRAY_BODY_SHA256_V6930 =
  "09724f38f8c66907a2cf85e734f8897a514e3fe6b82db6cc7a6ea285f029a07d";

const agentsMdPath = repoPath("AGENTS.md");
const hookPath = path.join(REPO_ROOT, ".devpro", "scripts", "hooks", "session-start.mjs");

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * 從 markdown 文字中提取 H3 section 內容。
 * 從 `### <anchor>` 開始，到下一個 H2（##）或 H3（###）或文件結尾為止。
 */
function extractH3Section(content, anchor) {
  const lines = content.split("\n");
  let inSection = false;
  const sectionLines = [];

  for (const line of lines) {
    if (!inSection) {
      if (line.startsWith("### ") && line.includes(anchor)) {
        inSection = true;
        sectionLines.push(line);
      }
    } else {
      // 遇到下一個 H2 或 H3 停止
      if (line.startsWith("## ") || line.startsWith("### ")) {
        break;
      }
      sectionLines.push(line);
    }
  }

  return sectionLines.join("\n");
}

/**
 * 從 markdown 文字中提取 H2 section 內容。
 * 從 `## <anchor>` 開始，到下一個 `---` 或 H2（##）或文件結尾為止。
 */
function extractH2Section(content, anchor) {
  const lines = content.split("\n");
  let inSection = false;
  const sectionLines = [];

  for (const line of lines) {
    if (!inSection) {
      if (line.startsWith("## ") && line.includes(anchor)) {
        inSection = true;
        sectionLines.push(line);
      }
    } else {
      // 遇到 --- 或下一個 H2 停止
      if (line.trim() === "---" || line.startsWith("## ")) {
        break;
      }
      sectionLines.push(line);
    }
  }

  return sectionLines.join("\n");
}

/**
 * 從 hook script 的 named const 陣列中提取 payload 字串。
 * 讀取 session-start.mjs，eval 其 pure-string-literal 陣列，取得 payload 文字。
 * @param {"msg"|"msgLite"|"msgLean"} name
 */
async function extractNamedHookPayload(name = "msg") {
  const content = await fs.readFile(hookPath, "utf8");
  const re = new RegExp(
    `const ${name} = \\[([\\s\\S]*?)\\]\\.join\\("\\\\n"\\)`
  );
  const msgMatch = content.match(re);
  if (!msgMatch) {
    throw new Error(`無法從 session-start.mjs 解析 ${name} 陣列`);
  }
  // 用 Function 安全求值陣列
  // SECURITY: only safe because session-start.mjs is source-controlled and
  // the matched substring is bounded by the regex above (must be inside
  // `const <name> = [...].join("\n")` literal). If hook script is ever changed
  // to contain function calls or template literals with side effects, this
  // sandbox is broken — escalate to JSON-serializable msg array form.
  const arrText = `[${msgMatch[1]}]`;
  // eslint-disable-next-line no-new-func
  const arr = new Function(`return ${arrText}`)();
  return arr.join("\n");
}

/** @returns {Promise<string>} full-level `const msg` payload */
async function extractHookPayload() {
  return extractNamedHookPayload("msg");
}

/** Extract raw array-body text (between `[` and `].join`) for byte-unchanged guards. */
async function extractNamedArrayBody(name) {
  const content = await fs.readFile(hookPath, "utf8");
  const re = new RegExp(
    `const ${name} = \\[([\\s\\S]*?)\\]\\.join\\("\\\\n"\\)`
  );
  const msgMatch = content.match(re);
  if (!msgMatch) {
    throw new Error(`無法從 session-start.mjs 解析 ${name} 陣列 body`);
  }
  return msgMatch[1];
}

function runSessionStart(extraEnv = {}) {
  const tmpRoot = makeTempDir("hook-payload-sync-");
  try {
    return spawnSync(process.execPath, [hookPath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_CI: "1",
        CODEX_THREAD_ID: "test-thread",
        DEVPRO_RECAP_PENDING_DIR: path.join(tmpRoot, "pending"),
        DEVPRO_RECAP_STATE_DIR: path.join(tmpRoot, "state"),
        ...extraEnv,
      },
    });
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function assertPointerOnlyPayload(hookPayload) {
  assert.match(
    hookPayload,
    /AGENTS\.md 是啟動規範 SSOT/,
    "hook payload must identify AGENTS.md as the startup SSOT"
  );
  assert.match(
    hookPayload,
    /先讀 AGENTS\.md 並輸出載入宣告/,
    "hook payload must tell a fresh session to load AGENTS.md and emit the load announcement"
  );
  assert.match(
    hookPayload,
    /動手前自檢、Intent 速查、輸出紀律與觸發式 leaf 索引/,
    "hook payload should name the AGENTS.md anchors without copying their bodies"
  );
  assert.match(
    hookPayload,
    /AGENTS\.md \+ stop-point-comms\.md/,
    "hook payload must point stop/handoff formatting to the AGENTS.md + stop-point-comms.md SSOT"
  );
  assert.match(
    hookPayload,
    /選項編號且末項開放/,
    "hook payload should preserve the numbered-option/open-last-item stop handoff pointer without copying the full rule body"
  );

  assert.doesNotMatch(
    hookPayload,
    /###\s*動手前十句自檢/,
    "hook payload must not duplicate the AGENTS.md full 動手前十句自檢 section"
  );
  assert.doesNotMatch(
    hookPayload,
    /\d+\.\s+\*\*追溯性\*\*|\d+\.\s+\*\*複雜度\*\*|\d+\.\s+\*\*假設\*\*/,
    "hook payload must not copy the numbered 動手前十句自檢 body"
  );
  assert.doesNotMatch(
    hookPayload,
    /\|意圖\/情境\|入口\||\|功能\|`openspec-flow\.md`\||\|審查 PR\|`code-review-checklist\.md`/,
    "hook payload must not duplicate the AGENTS.md Intent 速查 table"
  );
  assert.doesNotMatch(
    hookPayload,
    /###\s*輸出紀律|\*\*memory\*\*：可規範化內容沉澱為共享規範/,
    "hook payload must not duplicate the AGENTS.md 輸出紀律 section"
  );
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("hook-payload-sync", () => {
  it("Codex SessionStart output uses hookSpecificOutput.additionalContext", () => {
    const result = runSessionStart();

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);

    assert.equal(parsed.hookSpecificOutput?.hookEventName, "SessionStart");
    assert.equal(typeof parsed.hookSpecificOutput?.additionalContext, "string");
    assert.ok(parsed.hookSpecificOutput.additionalContext.length > 0);
    assert.equal(parsed.additional_context, undefined);
  });

  it("hook context stays within pointer-only byte budget (every-turn injection cost guard)", async () => {
    const hookPayload = await extractHookPayload();
    const byteLength = Buffer.byteLength(hookPayload, "utf8");
    const HOOK_PAYLOAD_BYTE_CAP = 1000;

    assert.ok(
      byteLength <= HOOK_PAYLOAD_BYTE_CAP,
      [
        `Hook payload byte length ${byteLength} exceeds ${HOOK_PAYLOAD_BYTE_CAP} byte cap.`,
        "Hook injects every conversation turn; keep static payload to a short AGENTS.md pointer.",
        "Do not copy AGENTS.md long sections or tables into session-start.mjs.",
        "See .devpro/agent-rules/rule-design-principles.md Token-First / usefulness first principle.",
      ].join("\n")
    );
  });

  it("AGENTS.md remains SSOT for long bootstrap sections", async () => {
    const agentsMd = await fs.readFile(agentsMdPath, "utf8");

    const selfCheckSection = extractH3Section(agentsMd, "動手前十句自檢");
    const intentSection = extractH2Section(agentsMd, "Intent 速查");

    assert.match(selfCheckSection, /追溯性/);
    assert.match(selfCheckSection, /複雜度/);
    assert.match(intentSection, /\|意圖\/情境\|入口\|/);
    assert.match(intentSection, /\|功能\|`openspec-flow\.md`\|/);
  });

  it("full/lite static hook payload is AGENTS.md pointer-only, not a long-section mirror", async () => {
    const [agentsMd, hookPayload] = await Promise.all([
      fs.readFile(agentsMdPath, "utf8"),
      extractHookPayload(),
    ]);

    assert.ok(
      extractH3Section(agentsMd, "動手前十句自檢").length > 0,
      "AGENTS.md should keep the full 動手前十句自檢 section as SSOT"
    );
    assert.ok(
      extractH2Section(agentsMd, "Intent 速查").length > 0,
      "AGENTS.md should keep the full Intent 速查 section as SSOT"
    );

    assertPointerOnlyPayload(hookPayload);
  });

  it("T5: const msg = [ literal still exists in session-start.mjs (new Function eval sandbox not broken)", async () => {
    const content = await fs.readFile(hookPath, "utf8");
    const msgMatch = content.match(/const msg = \[/);
    assert.ok(
      msgMatch,
      "session-start.mjs must still contain `const msg = [` literal; T5 msgLean must be a separate constant"
    );
  });

  it("T5: off level injects lean message (bytes < full msg bytes)", async () => {
    // Spawn session-start.mjs with DEVPRO_AGENT_RULES_LEVEL=off and compare
    // output size to the full msg payload.
    const fullPayload = await extractHookPayload();
    const fullBytes = Buffer.byteLength(fullPayload, "utf8");

    const result = runSessionStart({ DEVPRO_AGENT_RULES_LEVEL: "off" });

    assert.equal(result.status, 0, `session-start failed at level=off: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    const leanContext = parsed.hookSpecificOutput?.additionalContext ?? "";
    const leanBytes = Buffer.byteLength(leanContext, "utf8");

    assert.ok(
      leanBytes < fullBytes,
      `off level output (${leanBytes} bytes) must be smaller than full level (${fullBytes} bytes)`
    );
  });

  it("T5: off level message still contains load announcement equivalent", async () => {
    const result = runSessionStart({ DEVPRO_AGENT_RULES_LEVEL: "off" });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    const context = parsed.hookSpecificOutput?.additionalContext ?? "";

    // Must contain load announcement equivalent (載入宣告)
    assert.ok(
      context.includes("載入宣告") || context.includes("Devpro Agent Rules"),
      `off level message must contain load announcement equivalent; got: ${context.slice(0, 200)}`
    );
  });

  it("T5: full level message keeps AGENTS.md load pointer (not affected by level=off path)", async () => {
    const fullPayload = await extractHookPayload();
    assertPointerOnlyPayload(fullPayload);
  });

  it("hotfix #2519: const msgLite pure-string-literal exists (three-way selection)", async () => {
    const content = await fs.readFile(hookPath, "utf8");
    assert.match(
      content,
      /const msgLite = \[/,
      "session-start.mjs MUST define const msgLite for lite rigor advisory announce"
    );
    assert.match(
      content,
      /level === "off" \? msgLean : level === "lite" \|\| !selection\.valid \? msgLite : msg/,
      "main() MUST select off→msgLean / lite→msgLite / full→msg"
    );
    assert.doesNotMatch(
      content,
      /lite:\s*full msg/,
      "MUST NOT retain obsolete comment that lite uses full msg"
    );
  });

  it("hotfix #2519: msg and msgLean array bodies remain byte-unchanged vs production-v6.93.0", async () => {
    const curMsg = await extractNamedArrayBody("msg");
    const curLean = await extractNamedArrayBody("msgLean");
    assert.equal(
      createHash("sha256").update(curMsg, "utf8").digest("hex"),
      MSG_ARRAY_BODY_SHA256_V6930,
      "const msg array body MUST remain byte-unchanged vs production-v6.93.0"
    );
    assert.equal(
      createHash("sha256").update(curLean, "utf8").digest("hex"),
      MSG_LEAN_ARRAY_BODY_SHA256_V6930,
      "const msgLean array body MUST remain byte-unchanged vs production-v6.93.0"
    );
  });

  it("hotfix #2519: lite level injects msgLite announce (exemptions+retained) within caps", async () => {
    const msgLite = await extractNamedHookPayload("msgLite");
    const staticBytes = Buffer.byteLength(msgLite, "utf8");
    assert.ok(
      staticBytes <= 850,
      `msgLite static ${staticBytes}B exceeds 850B design target`
    );

    assert.match(msgLite, /AGENTS\.md/);
    assert.match(msgLite, /動手前自檢|Intent/);
    assert.match(msgLite, /level=lite/);
    assert.match(msgLite, /OpenSpec/);
    assert.match(msgLite, /pre-flight/);
    assert.match(msgLite, /六軸/);
    assert.match(msgLite, /simplify/);
    assert.match(msgLite, /Recap/);
    assert.match(msgLite, /multi-agent/);
    assert.match(msgLite, /advisory\/nudge/);
    assert.match(msgLite, /stop-handoff-cite/);
    assert.match(msgLite, /4 底線/);
    assert.match(msgLite, /測試綠燈/);
    assert.match(msgLite, /cooperative含SQL/);
    assert.match(msgLite, /post-pr-completion/);
    assert.match(msgLite, /P2 keep\/P3 degrade/);
    assert.match(msgLite, /cross-model-sticky-merge-review/);
    assert.match(msgLite, /BLOCK/);

    const result = runSessionStart({ DEVPRO_AGENT_RULES_LEVEL: "lite" });
    assert.equal(result.status, 0, `session-start failed at lite: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    const context = parsed.hookSpecificOutput?.additionalContext ?? "";
    assert.match(context, /level=lite/);
    assert.ok(
      Buffer.byteLength(context, "utf8") <= 1000,
      `lite live additionalContext ${Buffer.byteLength(context, "utf8")}B exceeds 1000B`
    );
    // Must not equal full msg payload
    const fullPayload = await extractHookPayload();
    assert.notEqual(context, fullPayload);
  });

  it("hotfix #2519: additionalContext ≤1000B across full/lite/off", () => {
    for (const level of ["full", "lite", "off"]) {
      const result = runSessionStart({ DEVPRO_AGENT_RULES_LEVEL: level });
      assert.equal(result.status, 0, `level=${level}: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      const context = parsed.hookSpecificOutput?.additionalContext ?? "";
      const bytes = Buffer.byteLength(context, "utf8");
      assert.ok(
        bytes <= 1000,
        `level=${level}: additionalContext ${bytes}B exceeds hook-payload-policy 1000B`
      );
    }
  });
});
