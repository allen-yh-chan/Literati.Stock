// Guard for R11 (Review Requirement Anchoring) across its four projections
// plus the receipt validator's core constant (the fifth carrier).
//
// 保證上限（MUST NOT 誇大）：
//   本 guard 鎖四件事——(1) 四個投影都存在且非空（sanity floor）；
//   (2) 每一處 `requirement_scope` 列舉的值集合**雙向**等於封閉三值且順序一致
//       （少一個、多一個未定義值、換序、換字都紅）；
//   (3) `code-review-checklist.md` 的五個逐字錨點各出現恰 1 次；
//   (4) receipt validator core 的 `REQUIREMENT_SCOPES` 字面恰一筆且與封閉三值依序相等
//       （第五載體：程式與四個投影的封閉集漂移在機械面現形）。
//   它 MUST NOT 被宣稱為「驗證每條 finding 的 requirement_scope 標註正確」——
//   那是 spec 的 A3（審查者三問）與 T2（TL 獨立複核）的判斷，機械面無從驗證。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const CLOSED_VALUES = ["in-scope", "out-of-requirement", "scope-unresolved"];

const CHECKLIST = ".devpro/agent-rules/code-review-checklist.md";
const FALLBACK = ".devpro/agent-rules/code-review-checklist-fallback.md";
// 用 source spelling（`.devpro/agent-skills/…`）而非 `.claude/skills/…` discovery symlink——
// Touch 表、done_when #6 與姊妹 guard `gate-threat-model-classification-grep.test.mjs` 都指這個路徑，
// 同一個載體在四處只該有一種寫法。
const DISPATCH =
  ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md";
const CORE = ".devpro/scripts/lib/review-remediation-evidence-core.mjs";
const CANONICAL = "openspec/specs/code-review-checklist/spec.md";
const ACTIVE_DELTA =
  "openspec/changes/strengthen-gate-threat-model-inheritance/specs/code-review-checklist/spec.md";

const REQUIREMENT_HEADING = "### Requirement: Review Requirement Anchoring";

function read(relPath) {
  return readFileSync(repoPath(relPath), "utf8");
}

// R11 的 normative SSOT 在 canonical spec；archive 之前它還只存在於 active delta。
// 兩者都沒有才是真缺口——本 resolver 讓 guard 跨 archive 前後都成立。
// archive 後 ACTIVE_DELTA 分支即為 dead path，可安全移除；留著只是為了本 change 自己
// 的 pre-archive 全綠要求，不是永久契約。
function resolveNormativeSpec() {
  for (const relPath of [CANONICAL, ACTIVE_DELTA]) {
    if (!existsSync(repoPath(relPath))) continue;
    const text = read(relPath);
    if (text.includes(REQUIREMENT_HEADING)) return { relPath, text };
  }
  assert.fail(
    `R11 normative SSOT 遺失：${CANONICAL} 與 ${ACTIVE_DELTA} 都找不到 ${JSON.stringify(REQUIREMENT_HEADING)}`
  );
}

// 抓「`in-scope` 後面接一串以 ／ 或 / 分隔的 backtick token」的每一處列舉，回傳其值序列。
// 無 backtick 的散文（例「恆 in-scope：…」）MUST NOT 觸發——避免未來散文誤紅。
function enumerations(text) {
  const pattern = /`in-scope`((?:\s*[／/]\s*`[a-z][a-z-]*`)+)/g;
  const found = [];
  for (const match of text.matchAll(pattern)) {
    const tail = match[1]
      .split(/[／/]/)
      .map((token) => token.replace(/`/g, "").trim())
      .filter((token) => token.length > 0);
    found.push(["in-scope", ...tail]);
  }
  return found;
}

const PROJECTIONS = [
  { label: "primary checklist leaf", relPath: CHECKLIST, floor: "Requirement anchoring（R11）" },
  { label: "TL fallback thin projection", relPath: FALLBACK, floor: "Requirement anchoring（R11）" },
  { label: "subagent dispatch self-contained form", relPath: DISPATCH, floor: "需求錨定（R11" },
];

test("R11 sanity floor: every projection exists, is non-empty, and carries its anchor", () => {
  for (const { label, relPath, floor } of PROJECTIONS) {
    const text = read(relPath);
    assert.ok(text.trim().length > 0, `${relPath}: ${label} 為空檔`);
    assert.ok(
      text.includes(floor),
      `${relPath}: ${label} 缺少 R11 段落錨點 ${JSON.stringify(floor)}`
    );
  }
  const spec = resolveNormativeSpec();
  assert.ok(
    spec.text.includes("**審查者側義務 A1–A5**") && spec.text.includes("**TL 側義務 T1–T5**"),
    `${spec.relPath}: R11 normative SSOT 缺少 A1–A5 或 T1–T5 義務段`
  );
});

// 四個投影 = 三個 rule/skill 載體 + 解析出的 normative spec（canonical 或 active delta）。
function allProjections() {
  const spec = resolveNormativeSpec();
  return [
    ...PROJECTIONS.map(({ relPath }) => ({ relPath, text: read(relPath) })),
    spec,
  ];
}

test("R11 requirement_scope enumeration is set-equal and ordered in every projection", () => {
  for (const { relPath, text } of allProjections()) {
    const found = enumerations(text);
    assert.ok(
      found.length > 0,
      `${relPath}: 找不到任何 requirement_scope 列舉——三個封閉值必須成組出現`
    );
    for (const [index, values] of found.entries()) {
      assert.deepEqual(
        values,
        CLOSED_VALUES,
        `${relPath}: 第 ${index + 1} 處 requirement_scope 列舉為 ${JSON.stringify(values)}，` +
          `與封閉三值 ${JSON.stringify(CLOSED_VALUES)} 不符（少值／多出未定義值／換序都不允許）`
      );
    }
  }
});

// 第五載體：core 的封閉集字面必須是單行、可 JSON.parse 的陣列（無尾逗號、雙引號），
// 這樣少值／多值／換序／換字都能在機械面現形，且不必執行 core 就能比對。
test("R11 core REQUIREMENT_SCOPES closed set is the fifth carrier and equals the closed three values in order", () => {
  const text = read(CORE);
  const matches = [...text.matchAll(/\bREQUIREMENT_SCOPES\s*=\s*Object\.freeze\(\s*(\[[^\]]*\])\s*\)/g)];
  assert.equal(
    matches.length,
    1,
    `${CORE}: 找不到恰一筆 REQUIREMENT_SCOPES = Object.freeze([...]) 字面（實得 ${matches.length} 筆）`,
  );
  assert.deepEqual(
    JSON.parse(matches[0][1]),
    CLOSED_VALUES,
    `${CORE}: REQUIREMENT_SCOPES 與封閉三值 ${JSON.stringify(CLOSED_VALUES)} 不符（少值／多值／換序／換字都不允許）`,
  );
});

test("enumerations ignores prose in-scope without backticks", () => {
  assert.deepEqual(
    enumerations("恆 in-scope：foo／bar 與 in-scope／out-of-requirement／scope-unresolved"),
    [],
    "prose or bare tokens must not count as closed enumerations",
  );
  assert.deepEqual(
    enumerations("`in-scope`／`out-of-requirement`／`scope-unresolved`"),
    [CLOSED_VALUES],
  );
});

test("R11 verbatim anchors appear exactly once in the primary checklist leaf", () => {
  const text = read(CHECKLIST);
  for (const anchor of [
    "本包目的＝",
    "無 referent 的標註無效",
    "原 severity 標註 MUST 原樣保留",
    "MUST 具名拒收",
    "審查者提出 ≠ 需求成立",
  ]) {
    const hits = text.split(anchor).length - 1;
    assert.equal(
      hits,
      1,
      `${CHECKLIST}: 逐字錨點 ${JSON.stringify(anchor)} 出現 ${hits} 次，應恰為 1 次`
    );
  }
});

test("R11 keeps the always-in-scope carve-out in every projection", () => {
  for (const { relPath, text } of allProjections()) {
    assert.ok(
      /overclaim/.test(text) && /spec↔code/.test(text),
      `${relPath}: 缺少恆 in-scope 例外（class-two 缺陷／overclaim／spec↔code 矛盾）——` +
        `少了它，R11 會變成規避真缺陷的出口`
    );
  }
});
