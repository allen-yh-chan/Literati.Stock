import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";

// #2858: a hard sentence cap and a "mandatory compression" label on progress updates and final
// summaries were written for chattier models. On a hard problem they cut the reasoning the user
// needs, and they leave long stretches with no user-visible progress. Keep the density guidance as a
// recommendation: lead with the conclusion, keep sentences short, compare options in a table only
// when the trade-off needs it. (The one-line Read justification in token-frugal-io.md Pre-Read Gate
// is required by the openspec-flow spec, so it is not touched here.)

const read = (file) => readFileSync(path.join(REPO_ROOT, file), "utf8");
const lineWith = (text, needle) => text.split("\n").filter((line) => line.includes(needle));

test("token-frugal-io: Caveman rules keep short sentences without a per-paragraph sentence cap", () => {
  const tfi = read(".devpro/agent-rules/token-frugal-io.md");
  assert.equal(tfi.includes("每段≤2句"), false, "per-paragraph two-sentence cap is back");
  const lines = lineWith(tfi, "Caveman rules");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /先結論；少形容；短句；長清單改表；引用只留最短 anchor；狀態更新用「動作\+證據\+下一步」/);
});

test("token-frugal-io: final / recap and progress update are recommended, not mandatory, compression", () => {
  const tfi = read(".devpro/agent-rules/token-frugal-io.md");
  assert.equal(tfi.includes("強制壓縮"), false, "mandatory compression label is back");
  for (const scene of ["final / recap", "progress update"]) {
    const rows = lineWith(tfi, `| ${scene} |`);
    assert.equal(rows.length, 1, `${scene} row`);
    assert.match(rows[0], /^\| .+ \| 建議壓縮 \|$/);
  }
});

test("token-frugal-io: the other compression rows are untouched", () => {
  const tfi = read(".devpro/agent-rules/token-frugal-io.md");
  assert.match(tfi, /^\| review findings \| 結構性壓縮 \|$/m);
  assert.match(tfi, /^\| design tradeoff \| 建議壓縮 \|$/m);
  assert.match(tfi, /^\| raw command \/ error \| 不適用 \|$/m);
});

test("ai-autonomy-rationalizations: the elaboration rebuttal has no sentence cap", () => {
  const text = read(".devpro/agent-rules/ai-autonomy-rationalizations.md");
  assert.equal(text.includes("≤3 句"), false, "three-sentence cap is back");
  const rows = lineWith(text, "「複雜決策需要展開鋪陳」");
  assert.equal(rows.length, 1);
  assert.match(rows[0], /推薦\/建議先給結論與關鍵理由；選項間取捨確實需要比較時才用 table；鋪陳是補充不是預設。/);
});
