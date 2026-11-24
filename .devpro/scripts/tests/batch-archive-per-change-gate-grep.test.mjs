/**
 * batch-archive-per-change-gate-grep.test.mjs
 *
 * Locks issue #2430: batch backlog archive must rerun pre-pr-archive-gate
 * after each archive commit via --mid-batch (skip (a), keep (i)); final
 * unflagged gate; a single end-of-batch sweep is forbidden.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const norm = (s) => s.replace(/\/\*\*/g, "\u0000GLOB").replace(/\*\*/g, "").replace(/\u0000GLOB/g, "/**");
const read = (rel) => norm(readFileSync(path.join(ROOT, rel), "utf8"));
const lines = (rel) => read(rel).split("\n");
const only = (rel, re) => {
  const hits = lines(rel).filter((l) => re.test(l));
  assert.equal(hits.length, 1, `${rel}: expected exactly one line matching ${re}, got ${hits.length}`);
  return hits[0];
};

const PRINCIPLES = ".devpro/agent-rules/openspec-archive-principles.md";
// 第三點六步段 lives in the pre-pr full-rigor reference (SKILL.md points there).
const PRE_PR = ".devpro/agent-skills/devpro-workflows/pre-pr/references/full-review-and-archive.md";
const GATE = ".devpro/scripts/pre-pr-archive-gate.mjs";

test("Gate (i) batch MUST use --mid-batch then final unflagged; MUST NOT end-of-batch sweep", () => {
  const line = only(PRINCIPLES, /批次 backlog archive MUST 逐步重跑 gate/);
  assert.match(line, /pre-pr-archive-gate\.mjs --mid-batch/, "mid-batch flag");
  assert.match(line, /跳過 \(a\)、仍跑 \(i\)/, "skips (a), keeps (i)");
  assert.match(line, /最後一個改跑無旗標完整 gate/, "final unflagged");
  assert.match(line, /MUST NOT 整批完才總掃/, "forbids end-of-batch sweep");
  assert.match(line, /MUST NOT 中途跑無旗標/, "forbids unflagged mid-batch");
  assert.match(line, /#2430/, "issue citation");
});

test("devpro:pre-pr Step 3.6 pointer: --mid-batch then final unflagged", () => {
  const line = only(PRE_PR, /批次 backlog archive/);
  assert.match(line, /--mid-batch/, "mid-batch flag");
  assert.match(line, /跳過 \(a\)、仍跑 \(i\)/, "skips (a), keeps (i)");
  assert.match(line, /最後一個改跑無旗標完整 gate/, "final unflagged");
  assert.match(line, /MUST NOT 整批做完才單次總掃/, "forbids end-of-batch sweep");
  assert.match(line, /openspec-archive-principles\.md.*Gate \(i\)/, "SSOT pointer");
});

test("pre-pr-archive-gate.mjs parses --mid-batch and skips check (a) only", () => {
  const body = read(GATE);
  assert.match(body, /arg === '--mid-batch'/, "CLI parses --mid-batch");
  assert.match(body, /!midBatch/, "check (a) gated by !midBatch");
  assert.match(body, /--mid-batch skipped check \(a\)/, "stdout discloses skip");
});
