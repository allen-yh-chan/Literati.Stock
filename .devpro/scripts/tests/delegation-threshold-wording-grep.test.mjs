import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";

// #2858 (High 1): AGENTS.md §0.4 and model-delegation-delegation-rules.md say task shape (>=2 steps,
// >=2 files) is only a signal and never authorizes a spawn by itself; the executor comes from the
// decision order, and TL-direct is a normal outcome. Two rule files still carried the older
// "always delegate" wording. Absence of the old strings is a polarity check (includes, negated); the
// replacement wording is bound to its own physical line with a same-line compound regex.

const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), "utf8");
const rationalizations = read(".devpro/agent-rules/ai-autonomy-rationalizations.md");
const antiPatterns = read(".devpro/agent-rules/anti-patterns-behavioral.md");
const antiPatternsIndex = read(".devpro/agent-rules/anti-patterns-examples.md");
const linesOf = (text, needle) => text.split("\n").filter((line) => line.includes(needle));

test("the always-delegate wording is gone from both rule files", () => {
  assert.ok(!rationalizations.includes("≥2 步機械操作一律委派"));
  assert.ok(!rationalizations.includes("卻未委派 `dp-assistant`"));
  assert.ok(!rationalizations.includes("尚未輸出委派決策——立即停下委派"));
  assert.ok(!antiPatterns.includes("強制至少一個 dp-* 出現"));
});

test("rationalization row treats >=2 mechanical steps as a signal and defers to the decision order", () => {
  const rows = linesOf(rationalizations, "改 markdown 不用委派");
  assert.equal(rows.length, 1);
  assert.match(rows[0], /≥2 步機械操作是委派訊號[^\n]*不單獨授權 spawn[^\n]*Executor 決策序[^\n]*TL-direct/);
});

test("rationalization red flags ask for an executor decision, not a mandatory delegation", () => {
  const mechanical = linesOf(rationalizations, "TL 即將連續執行 ≥2 步機械性操作");
  assert.equal(mechanical.length, 1);
  assert.match(mechanical[0], /沒依 `model-delegation\.md` §Executor 決策序判定 executor/);
  const edits = linesOf(rationalizations, "TL 即將對 ≥2 個檔案執行 Edit/Write");
  assert.equal(edits.length, 1);
  assert.match(edits[0], /尚未輸出委派計畫[^\n]*dp-\* 或 TL 自己做/);
});

test("anti-patterns section 8 states the signal-not-mandate rule and allows TL-direct in the plan", () => {
  const lines = linesOf(antiPatterns, "task-shape 訊號");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /≥ ?2 步非判斷性是 task-shape 訊號[^\n]*不單獨授權 spawn[^\n]*Executor 決策序[^\n]*TL-direct[^\n]*不強制出現 dp-\*/);
});

// Second-review WARN on the first head: the section 8 heading and its cognition-root sentence still
// carried the premise that doing >=2 steps yourself is itself the failure. The heading text is also
// the index row in anti-patterns-examples.md, so both must move together.

const section8Start = antiPatterns.indexOf("### §8.");
const section8Next = antiPatterns.indexOf("\n### §9.", section8Start);
assert.ok(section8Start >= 0 && section8Next > section8Start, "section 8 bounds must exist");
const section8 = antiPatterns.slice(section8Start, section8Next);
const HEADING_TEXT = "委派失敗（沒做 executor 決策就自己做 ≥2 步）";

test("section 8 heading names the missing executor decision, and the index row carries the same text", () => {
  const [heading] = section8.split("\n");
  assert.equal(heading, `### §8. ${HEADING_TEXT}`);
  assert.ok(!antiPatterns.includes("委派失敗（TL 自己做 ≥2 步）"));
  const rows = antiPatternsIndex.split("\n").filter((line) => line.startsWith("| §8 |"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0], `| §8 | ${HEADING_TEXT} | \`anti-patterns-behavioral.md\` |`);
  assert.ok(!antiPatternsIndex.includes("委派失敗（TL 自己做 ≥2 步）"));
});

test("section 8 cognition-root sentence defers to the Executor decision order and no longer calls self-doing a violation", () => {
  const roots = section8.split("\n").filter((line) => line.startsWith("**認知根源**"));
  assert.equal(roots.length, 1);
  assert.ok(!roots[0].includes("自己做違反"));
  assert.match(roots[0], /沒做 executor 決策就自己動手[^\n]*Executor 決策序判定[^\n]*TL-direct 是合法結果[^\n]*Step 5 委派計畫/);
});
