import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";



const CANONICAL_SPEC = "openspec/specs/token-budget-tooling/spec.md";
const SHIPPED_PARSER_TEST = ".devpro/scripts/tests/agents-md-index-mapping.test.mjs";
const ARCHIVED_BRD =
  "openspec/changes/archive/2026-07-19-strengthen-agent-index-loadchain-guard/brd.md";

// Guard 強度邊界（per `rule-anchor-guard-strength.md`）：
// 「heading 是否為合法 Load-chain 宣告」是 polarity-sensitive 錨點——反轉後仍合語法，
// 故每條正向斷言都用**單一** regex 把極性詞與受詞綁在**同一個連續結構單元**內：
// 同一物理行，或 Gherkin scenario 的相鄰 WHEN/THEN 對（canonical spec 的極性天生跨這兩行）。
// 禁止把極性與受詞拆成各自獨立的斷言（decoupled includes），也不使用 alternation 讓任一受詞代償；
// `[^\n]*` 限制每個片段不得跨行漂移，`operativeLines` 宣告該 anchor 涵蓋的行數供 mutation 審計核對。
// token-presence grep 無法擋「token 全留同一結構單元內的刻意語意反轉」，
// 該面向屬 cross-model 人審職責，非本 guard 能涵蓋。
const POSITIVE_ANCHORS = [
  {
    id: "canonical-heading-rejection-scenario-pair",
    file: CANONICAL_SPEC,
    pattern:
      /appears only in[^\n]*Markdown heading[^\n]*\n[^\n]*MUST NOT provide indirect trigger-index coverage/,
    operativeLines: 2,
  },
  {
    id: "shipped-parser-test-rejects-headings",
    file: SHIPPED_PARSER_TEST,
    pattern: /rejects[^\n]*headings/,
    operativeLines: 1,
  },
  {
    id: "archived-brd-legal-form-enumeration",
    file: ARCHIVED_BRD,
    pattern: /Load-chain[^\n]*合法 corpus evidence/,
    operativeLines: 1,
  },
  {
    id: "archived-brd-heading-superseded",
    file: ARCHIVED_BRD,
    pattern: /Markdown heading[^\n]*不是合法 Load-chain 宣告/,
    operativeLines: 1,
  },
];

test("heading non-declaration anchors survive in every protected carrier", () => {
  for (const anchor of POSITIVE_ANCHORS) {
    assert.match(read(anchor.file), anchor.pattern, `missing anchor: ${anchor.id}`);
  }
});

test("protected carriers span canonical spec, shipped parser test, and archived brd", () => {
  const carriers = new Set(POSITIVE_ANCHORS.map((anchor) => anchor.file));

  assert.ok(carriers.has(CANONICAL_SPEC));
  assert.ok(carriers.has(SHIPPED_PARSER_TEST));
  assert.ok(carriers.has(ARCHIVED_BRD));
});

test("archived brd never lists a heading form as legal FR4 corpus evidence", () => {
  const offending = read(ARCHIVED_BRD)
    .split("\n")
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => /heading/i.test(line) && /合法 corpus evidence/.test(line));

  assert.deepEqual(offending, [], "heading must not appear on a legal-corpus-evidence line");
});

// 收斂判準（mutation 審計）：逐行模擬刪除，重跑全部正向斷言。
// 每個斷言 MUST 恰好在其宣告的 operative 行被刪時轉紅——轉紅行數少於 `operativeLines`
// 代表有他行代償（洞）；多於 `operativeLines` 代表選的 token 組合非該結構單元獨有。
test("mutation audit: each positive anchor turns red on exactly its operative lines", () => {
  for (const anchor of POSITIVE_ANCHORS) {
    const lines = read(anchor.file).split("\n");
    const redLines = [];

    for (let index = 0; index < lines.length; index += 1) {
      const mutated = lines.slice(0, index).concat(lines.slice(index + 1)).join("\n");
      if (!anchor.pattern.test(mutated)) redLines.push(index + 1);
    }

    assert.equal(
      redLines.length,
      anchor.operativeLines,
      `${anchor.id} must bind exactly ${anchor.operativeLines} operative line(s), got [${redLines.join(", ")}]`,
    );
  }
});
