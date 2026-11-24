import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath, SOURCE_ROOT } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";



function readChangeArtifact(relPath) {
  const activePath = path.join(SOURCE_ROOT, "openspec/changes/add-knowledge-distill-workflow", relPath);
  if (existsSync(activePath)) return readFileSync(activePath, "utf8");

  const archiveRoot = repoPath("openspec/changes/archive");
  if (!existsSync(archiveRoot)) throw new Error(`change artifact not found: ${relPath}`);
  const archived = readdirSync(archiveRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith("-add-knowledge-distill-workflow"))
    .map((entry) => entry.name)
    .sort()
    .at(-1);
  if (!archived) throw new Error(`change artifact not found: ${relPath}`);
  return readFileSync(path.join(archiveRoot, archived, relPath), "utf8");
}

function literalRe(phrase) {
  return new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

test("knowledge distillation rule defines the ingest/digest/distill boundary", () => {
  const rule = read(".devpro/agent-rules/knowledge-distillation.md");
  for (const phrase of [
    "Distillation Ledger",
    "`ingest`",
    "`digest`",
    "`distill`",
    "Invocation Defaults",
    "蒸餾 <URL/path>",
    "Compress, Do Not Summarize",
    "Preserve Single Interpretation",
    "壓到多重解讀（失真）即為 regression",
    "單一解讀優先於字數",
    "Self-Distill Safeguards",
    "Persist Deferred Work",
    "session-pending-lifecycle.md",
    "handoff-grade pending",
    "external KB",
    "knowledge-digest.md",
    "rule-ingest-methodology.md",
  ]) {
    assert.match(rule, literalRe(phrase));
  }
});

test("repeated mistakes choose structural repair before more instructions", () => {
  const rule = read(".devpro/agent-rules/knowledge-distillation.md");
  const section = rule.split("### Structural Repair Before Instructions\n")[1]?.split("\n## ")[0] ?? "";
  assert.match(section, /結構／單一 owner／推導 → 型別 → 可執行檢查 → 行為測試 → 判斷文字/);
  assert.match(section, /MUST 證明真實歷史錯法被拒絕，且合法操作仍通過/);
  assert.match(section, /MUST NOT 只加文字提醒/);
  assert.match(read(".devpro/agent-rules/rule-self-evolution.md"), /why_not_hack[^\n]*knowledge-distillation\.md[^\n]*Structural Repair/);
});

test("deferred distillation pending is handoff-grade, not a one-line reminder", () => {
  const lifecycle = read(".devpro/agent-rules/session-pending-lifecycle.md");
  for (const phrase of [
    "Handoff-grade 暫存",
    "session compact/clear",
    "一句提醒或只有 URL 不合格",
    "使用者意圖",
    "source/target",
    "目前階段",
    "已做證據",
    "候選 output",
    "下一個決策",
    "來源身分與可信度",
    "verdict 或 draft ledger",
    "候選 carrier",
    "verification idea",
    "exclusion / anti-drift note",
  ]) {
    assert.match(lifecycle, literalRe(phrase));
  }
});

test("distillation routes from AGENTS and README", () => {
  assert.match(read("AGENTS.md"), /knowledge-distillation\.md/);
  assert.match(read("README.md"), /knowledge-distillation\.md/);
});

test("ingest and digest hand off to distillation without owning its schema", () => {
  assert.match(read(".devpro/agent-rules/rule-ingest-methodology.md"), /knowledge-distillation\.md/);
  assert.match(read(".devpro/agent-rules/knowledge-digest.md"), /Distillation Ledger/);
  assert.match(read(".devpro/agent-skills/rules-authoring/knowledge-ingest/SKILL.md"), /knowledge-distillation\.md/);
});

test("knowledge-distill skill is route-back-only and discoverable", () => {
  const skill = read(".devpro/agent-skills/rules-authoring/knowledge-distill/SKILL.md");
  for (const phrase of [
    "name: knowledge-distill",
    "使用時機",
    "Policy SSOT",
    "One-line calls are enough",
    "rule-ingest-methodology.md",
    "knowledge-digest.md",
    "knowledge-distillation.md",
    "Distillation Ledger",
  ]) {
    assert.match(skill, literalRe(phrase));
  }

  const manifest = read(".devpro/agent-skills/manifest.json");
  assert.match(manifest, /"name": "knowledge-distill"/);

  // design D3 (refactor-agent-skills-entry) — discovery is the single
  // `devpro` entry per root, resolving to the catalog root itself, not a
  // per-skill link.
  const catalogRealpath = path.join(realpathSync(REPO_ROOT), ".devpro", "agent-skills");
  for (const dir of [".agents/skills", ".claude/skills"]) {
    assert.deepEqual(
      readdirSync(path.join(REPO_ROOT, dir)),
      ["devpro"],
      `${dir} must hold only the 'devpro' entry, not a per-skill link`
    );
    const entry = path.join(REPO_ROOT, dir, "devpro");
    assert.equal(lstatSync(entry).isSymbolicLink(), true, `${dir}/devpro must be a symlink`);
    assert.equal(realpathSync(entry), catalogRealpath, `${dir}/devpro must resolve to the catalog root itself`);
    const skillMdViaEntry = path.join(entry, "rules-authoring", "knowledge-distill", "SKILL.md");
    assert.equal(
      existsSync(skillMdViaEntry),
      true,
      `knowledge-distill must be discoverable via ${dir}/devpro/rules-authoring/knowledge-distill/SKILL.md`
    );
  }
});

test("openspec digest carries distillation ledger evidence", () => {
  const digest = readChangeArtifact("knowledge-digest.md");
  for (const phrase of [
    "Ingest-Mapping Ledger",
    "Knowledge Digest",
    "Distillation Ledger",
    "No fine-tuning/model-training workflow",
    "No policy mini-SSOT in skill",
  ]) {
    assert.match(digest, literalRe(phrase));
  }
});

test("rule-ingest-methodology requires verbatim verification of exact identifiers against raw sources", () => {
  const ingest = read(".devpro/agent-rules/rule-ingest-methodology.md");
  assert.match(ingest, /\*\*Exact identifier 核對（MUST）\*\*[^\n]*逐字核對[^\n]*raw 文件 curl＋grep[^\n]*WebFetch／摘要模型的輸出只是線索、不是證據/);
  // The clause belongs to the source-credibility section, before the Ingest-Mapping Ledger.
  assert.ok(
    ingest.indexOf("Exact identifier 核對") > ingest.indexOf("### 來源可信度分層") &&
      ingest.indexOf("Exact identifier 核對") < ingest.indexOf("### Ingest-Mapping Ledger"),
    "exact-identifier clause must sit inside §來源可信度分層",
  );
});
