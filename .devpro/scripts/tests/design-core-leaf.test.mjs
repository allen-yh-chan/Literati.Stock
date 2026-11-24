import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { REPO_ROOT, SOURCE_ROOT } from "./lib/repo-root.mjs";

const filePath = path.join(REPO_ROOT, ".devpro", "agent-rules", "design-core.md");

async function readContent() {
  return await fs.readFile(filePath, "utf8");
}

describe("design-core leaf", () => {
  it("routes caller-first design and implementation feedback to one shared method", async () => {
    const method = await fs.readFile(path.join(REPO_ROOT, ".devpro/agent-rules/design-reasoning.md"), "utf8");
    for (const title of ["Working Model", "Historical Constraints", "Usage Before Shape", "Alternatives and Experiments", "Implementation Feedback"]) {
      assert.match(method, new RegExp(`^### ${title}$`, "m"));
    }
    assert.match(method, /MUST 先寫真實 caller 使用例，再推導資料、invariant、owner、型別與介面/);
    assert.match(method, /MUST NOT 以尚未實作的設計案例宣稱 feedback 已驗證/);
    assert.match(method, /預設 lite 時 MUST 以回覆／handoff 承載本方法，不因 B 分類要求/);
    for (const rel of ["AGENTS.md", "README.md", ".devpro/agent-rules/design-core.md", ".devpro/agent-rules/pre-implementation-over-design.md", ".devpro/agent-rules/design-template.md", ".devpro/agent-skills/devpro-workflows/change/SKILL.md", ".claude/agents/dp-architect.md", ".cursor/agents/dp-architect.md", ".codex/agents/dp-architect.toml", ".claude/agents/dp-programmer.md", ".cursor/agents/dp-programmer.md", ".codex/agents/dp-programmer.toml"]) {
      assert.match(await fs.readFile(path.join(REPO_ROOT, rel), "utf8"), /design-reasoning\.md/, rel);
    }
  });

  it("6-section H2 anatomy complete (grep -c '^## ' = 6)", async () => {
    const content = await readContent();
    const h2Count = (content.match(/^## /gm) || []).length;
    assert.equal(h2Count, 6, `expected 6 H2 sections, got ${h2Count}`);
  });

  it("Karpathy 4 principle names all present", async () => {
    const content = await readContent();
    const principles = [
      "寫程式前先思考",
      "簡潔優先",
      "精準修改",
      "目標驅動執行",
    ];
    const missing = principles.filter((p) => !content.includes(p));
    assert.equal(
      missing.length,
      0,
      `Karpathy principles missing: ${missing.join(", ")}`
    );
  });

  it("Token Efficiency section present (≥ 1 match)", async () => {
    const content = await readContent();
    const count = (content.match(/Token Efficiency/g) || []).length;
    assert.ok(count >= 1, `expected ≥ 1 occurrence of "Token Efficiency", got ${count}`);
  });

  it("外部能力查證 bullet present in §1 (含 make-vs-buy cross-ref)", async () => {
    const content = await readContent();
    // Co-location check: assert the cross-ref lives ON the 外部能力查證 bullet
    // line itself — NOT anywhere in the file. A whole-file includes() would
    // false-pass if some OTHER line happens to reference the same SSOT.
    const bulletLine = content
      .split("\n")
      .find((l) => l.includes("外部能力查證"));
    assert.ok(
      bulletLine,
      '外部能力查證 bullet 被刪除或關鍵詞改名——請確認 design-core.md §1 含「外部能力查證」'
    );
    // done_when #2: 新 bullet 必須 cross-ref make-vs-buy（第三方套件選型 SOP SSOT）
    assert.ok(
      bulletLine.includes("third-party-packages-licensing.md"),
      '外部能力查證 bullet 內的 make-vs-buy cross-ref 遺失——cross-ref 必須在同一條 bullet 上 (`third-party-packages-licensing.md`)'
    );
  });

  it("hook-injected reminders are agent-directed, not user-choice prompts", async () => {
    const content = await readContent();
    assert.match(
      content,
      /AI-injected hook reminders should tell the agent what it must do, not ask the user to choose\./,
      "design-core must carry the hook reminder boundary as a stable design anchor"
    );
    assert.match(
      content,
      /systemMessage[\s\S]*additionalContext[\s\S]*agent context/,
      "design-core must explain that hook reminders are agent context"
    );
    assert.match(
      content,
      /stop-point-comms\.md/,
      "design-core must route real user handoff prompts back to stop-point-comms.md"
    );
  });

  it("positive executable recipe principle is present", async () => {
    const content = await readContent();
    assert.match(content, /Positive Executable Recipe First/);
    assert.match(content, /dispatch-ready positive recipe/);
    assert.match(content, /exact command \/ flag \/ tool shape/);
    assert.match(content, /probe-backed recipe/);
    assert.match(content, /recipe_unresolved/);
    assert.match(content, /Negative constraints \/ blacklists/);
  });

  // PR #3243: a PowerShell exit-code rule written from docs and inference was broken three times, each by a case nobody had run.
  it("a rule that depends on shell runtime behavior needs a case table run on each supported shell", async () => {
    const content = await readContent();
    const runFirst =
      /^.*依賴 shell 或外部工具的執行期行為.*文件與推論不算 probe.*MUST 在每個宣稱支援的 shell 實機跑出情況表.*$/m;
    const untested = /^.*沒有實測的 shell 版本 MUST 明寫未驗證.*不得寫成已支援.*$/m;
    assert.match(content, runFirst);
    assert.match(content, untested);
    const lines = content.split("\n");
    assert.equal(lines.filter((line) => runFirst.test(line)).length, 1);
    assert.equal(lines.filter((line) => untested.test(line)).length, 1);
  });

  it("§10 environment-dependent gate effective scope is a stable design anchor", async () => {
    const content = await readContent();
    const lines = content.split("\n");

    // Structural anchor: the H3 itself, matched as a whole physical line so a
    // rename or demotion to plain text turns this red. §10 MUST stay an H3 —
    // the 6-H2 anatomy assertion above is what forbids promoting it to `## `.
    assert.ok(
      lines.includes("### 10. Environment-Dependent Gate Effective Scope"),
      "design-core §10 H3 標題被改名或刪除——請確認 `### 10. Environment-Dependent Gate Effective Scope` 仍在 `## Process` 底下"
    );

    // Keep ownership, observability, and foreign-context exclusion on the
    // positive MUST line; unrelated tokens elsewhere cannot satisfy it.
    const mustLine = lines.find((l) => /^- \*\*MUST\*\*：environment-dependent gate /.test(l));
    assert.ok(
      mustLine,
      "§10 的 MUST bullet 遺失或極性被翻轉"
    );
    assert.match(
      mustLine,
      /本 session 已擁有／明確接手.*effective scope、實際檢查數與期待位置可觀測.*其他 session.*不列入 hook 注入清單/,
      "§10 MUST bullet 必須同時界定 own scope、可觀測欄位與 foreign context 排除"
    );

    // Polarity-sensitive counterpart: the prohibition on letting the exit code
    // alone carry effective scope. Flipping `**MUST NOT**` to `**MUST**`
    // inverts the rule and turns this assertion red.
    const mustNotLine = lines.find((l) => /^- \*\*MUST NOT\*\*：用 exit code 單獨承載 effective scope/.test(l));
    assert.ok(
      mustNotLine,
      "§10 的 MUST NOT bullet 遺失或極性被翻轉——禁止用 exit code 單獨承載 effective scope"
    );
    assert.match(
      mustNotLine,
      /靜默 exit 0 當成已檢查的證據/,
      "§10 MUST NOT bullet 必須在同一行點名「靜默 exit 0 當成已檢查的證據」這個具體反例"
    );

    // The leaf-level instance this baseline generalizes from.
    assert.match(
      content,
      /post-pr-completion-gate\.md` §Execution Location/,
      "§10 必須指回承載具體條款的 leaf（post-pr-completion-gate.md §Execution Location）"
    );
  });

  it("cross-ref to existing 4 leaves (≥ 4 total hits)", async () => {
    const content = await readContent();
    const leaves = [
      "rule-design-principles.md",
      "code-simplification.md",
      "anti-patterns-examples.md",
      "testing-and-qa.md",
    ];
    let totalHits = 0;
    const missing = [];
    for (const leaf of leaves) {
      const hits = (content.split(leaf).length - 1);
      if (hits < 1) missing.push(leaf);
      totalHits += hits;
    }
    assert.equal(
      missing.length,
      0,
      `leaves with zero cross-ref hits: ${missing.join(", ")}`
    );
    assert.ok(
      totalHits >= 4,
      `expected ≥ 4 total leaf cross-ref hits, got ${totalHits}`
    );
  });
});

// EGM adoption: the only gate is the cold-read record check; semantics stay cooperative.
it("EGM design handoff and lens contracts have executable action points", async () => {
  const method = await fs.readFile(path.join(REPO_ROOT, ".devpro/agent-rules/design-reasoning.md"), "utf8");
  const lens = await fs.readFile(path.join(REPO_ROOT, ".devpro/agent-rules/ambiguity-scoring.md"), "utf8");
  assert.match(method, /^### Engineering Review Lenses$/m);
  assert.doesNotMatch(method, /### 冷讀：/);
  assert.match(lens, /檢查對象、結論、依據/);
  assert.doesNotMatch(lens, /各 ≥1 finding|強制 ≥1 finding|產出 ≥1 finding/);
  const spec = await fs.readFile(path.join(SOURCE_ROOT, "openspec/specs/ambiguity-scoring/spec.md"), "utf8");
  assert.doesNotMatch(spec, /Each lens MUST produce ≥1 finding/);
  assert.match(spec, /evidence-backed no-finding/);
});
