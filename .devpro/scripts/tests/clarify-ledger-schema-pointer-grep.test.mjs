/**
 * clarify-ledger-schema-pointer-grep.test.mjs
 *
 * B-mini chore clarify-ledger-schema-pointer (RULE-FEEDBACK from PR #1230):
 * `## Requirement Ledger` 欄位 schema 的 SSOT 已存在於 proposal-template.md，
 * 但 discoverability 不足——B-mini 作者熱路徑無指針、gate (m) 缺-table 錯誤訊息
 * 未印欄名，逼人逆向讀 pre-pr-archive-gate.mjs 才知 6 欄格式。
 *
 * 本 guard 鎖兩處接通指針：
 *   (a) openspec-quality-and-formats.md Exit Criteria 指向 proposal-template.md
 *   (b) pre-pr-archive-gate.mjs 缺-table 訊息印出 REQUIRED_LEDGER_COLUMNS 欄名
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
const QF = readFileSync(
  repoPath(".devpro/agent-rules/openspec-quality-and-formats.md"),
  "utf8",
);
const TEMPLATE = readFileSync(
  repoPath(".devpro/agent-rules/proposal-template.md"),
  "utf8",
);
const DOC_FORMATS = readFileSync(
  repoPath(".devpro/agent-rules/openspec-quality-doc-formats.md"),
  "utf8",
);
const GATE = readFileSync(
  repoPath(".devpro/scripts/pre-pr-archive-gate.mjs"),
  "utf8",
);

test("(a) B-mini Requirement Ledger Exit Criteria points to schema SSOT proposal-template.md", () => {
  // Exit Criteria #7 段：含 Requirement Ledger 且指向 proposal-template.md
  const exitBlock = QF.match(/## Exit Criteria[\s\S]{0,1200}/);
  assert.ok(exitBlock, "Exit Criteria section missing");
  assert.match(
    exitBlock[0],
    /Requirement Ledger/,
    "Exit Criteria must mention Requirement Ledger",
  );
  assert.match(
    exitBlock[0],
    /proposal-template\.md/,
    "Exit Criteria Requirement Ledger row must point to schema SSOT proposal-template.md",
  );
});

test("(b) gate (m) missing-table error message prints the required column names", () => {
  // 缺-table 分支（parseable markdown table 缺）訊息必須印 REQUIRED_LEDGER_COLUMNS，
  // 與同檔缺-ledger 分支（已印欄名）一致，免作者逆向找 schema。
  // Window 必須只涵蓋缺-table 分支自身（至該分支的 process.exit(1) 為止），
  // 不得跨到後面 missingColumns 邏輯（L1220）——否則抓到隔壁 REQUIRED_LEDGER_COLUMNS 假性 pass。
  const missingTableBlock = GATE.match(
    /缺 parseable markdown table[\s\S]*?process\.exit\(1\);/,
  );
  assert.ok(missingTableBlock, "missing-table error branch not found");
  assert.match(
    missingTableBlock[0],
    /REQUIRED_LEDGER_COLUMNS/,
    "missing-table message must interpolate REQUIRED_LEDGER_COLUMNS column names",
  );
});

test("regression guard: gate (m) parser invariants intact", () => {
  // 欄位契約仍在 gate；正式表格解析已移至三個 consumer 共用的 owner。
  assert.match(GATE, /const REQUIRED_LEDGER_COLUMNS = \[/, "REQUIRED_LEDGER_COLUMNS definition lost");
  assert.match(GATE, /const ACCEPTED_DISPOSITIONS = new Set\(\[/, "ACCEPTED_DISPOSITIONS definition lost");
  assert.match(GATE, /import \{ readRequirementLedger \} from '\.\/lib\/requirement-ledger\.mjs'/,
    "gate (m) must read the shared formal Ledger");
  assert.match(GATE, /const table = ledger\.table;/, "gate (m) must validate the selected formal table");
});

test("(c) Requirement Ledger authoring surfaces forbid range refs and bullet-list ledgers", () => {
  assert.match(TEMPLATE, /markdown table[\s\S]*bullet lists are not accepted/, "proposal-template must say Requirement Ledger is a markdown table, not bullets");
  assert.match(TEMPLATE, /\[Req: R1-R7\]/, "proposal-template must give the exact invalid range example");
  assert.match(QF, /Requirement Ledger exact ID[\s\S]*\[Req: R1-R7\]/, "openspec-quality-and-formats must warn that range refs are invalid");
  assert.match(DOC_FORMATS, /exact[\s`]*\[Req: R<N>\][\s\S]*\[Req: R1-R7\]/, "Requirement Ledger lifecycle must warn that range refs are invalid");
});

test("(d) gate (m) range-ref diagnostic names exact-ID remediation", () => {
  assert.match(GATE, /is a range/, "gate must identify [Req: R1-R7] as a range error");
  assert.match(GATE, /exact Requirement Ledger IDs/, "gate must tell authors to enumerate exact Requirement Ledger IDs");
  assert.match(GATE, /\[Req: R1-R7\]/, "gate diagnostic must show the invalid range shape");
});
