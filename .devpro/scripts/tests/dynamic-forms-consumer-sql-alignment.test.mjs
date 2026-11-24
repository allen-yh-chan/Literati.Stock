import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const leaf = "dynamic-forms-consumer-sql-alignment.md";
const read = (file) => existsSync(repoPath(file)) ? readFileSync(repoPath(file), "utf8") : "";
const rule = read(`.devpro/agent-rules/${leaf}`);

// Text guards protect operative obligations, not semantic compliance or a live DB.
// Each compound binds polarity to its own physical line; deletion mutations below
// reject token supply from examples/other sections. No customer path/version oracle.
const invariants = [
  ["schema rather than folder inventory", /MUST[^\n]*schema\.table[^\n]*所有 SQL 目錄[^\n]*不得[^\n]*Forms 目錄/],
  ["tag-specific model against consumer DDL", /MUST[^\n]*目標 tag[^\n]*EF entities[^\n]*mappings[^\n]*consumer[^\n]*DDL/],
  ["empty diff cannot certify prerequisites", /MUST NOT[^\n]*空的 tag-to-tag SQL diff[^\n]*對齊證據/],
  ["immutable deployed history", /MUST NOT[^\n]*改寫[^\n]*已部署[^\n]*01[^\n]*重跑/],
  ["additive delivery provenance", /MUST[^\n]*additive[^\n]*idempotent[^\n]*prerequisite SQL[^\n]*provenance[^\n]*manifest[^\n]*verify/],
  ["trusted Cancelled check replacement", /MUST[^\n]*CHECK[^\n]*Cancelled[^\n]*explicit transaction[^\n]*with check[^\n]*is_disabled = 0[^\n]*is_not_trusted = 0[^\n]*post-verify/],
  ["asset set consistency", /MUST[^\n]*DLL[^\n]*_content[^\n]*入口資產[^\n]*cache version[^\n]*manifest[^\n]*同一目標版本/],
  ["DBA execution boundary", /MUST[^\n]*DBA[^\n]*DDL[^\n]*MUST NOT[^\n]*自動[^\n]*SQL[^\n]*production/],
];

test("vendor upgrade and schema errors discover the SQL audit before editing", () => {
  const rows = read("AGENTS.md").split("\n").filter((line) => line.startsWith("|") && line.includes(`\`${leaf}\``));
  assert.equal(rows.length, 1, "AGENTS must expose one DynamicForms SQL action-point row");
  assert.match(rows[0], /vendor bump[^\n]*DLL 升級[^\n]*SQL schema error/);
  assert.match(read(".devpro/agent-rules/database-conventions.md"), /DynamicForms[^\n]*vendor[^\n]*讀[^\n]*`dynamic-forms-consumer-sql-alignment\.md`/);
});

for (const [name, pattern] of invariants) {
  test(`SQL prerequisite contract: ${name}`, () => {
    assert.equal(rule.split("\n").filter((line) => pattern.test(line)).length, 1, name);
  });
}

test("operative obligations cannot disappear or lose their MUST polarity silently", () => {
  for (const [name, pattern] of invariants) {
    const lines = rule.split("\n");
    const index = lines.findIndex((line) => pattern.test(line));
    assert.notEqual(index, -1, `missing operative obligation: ${name}`);
    assert.equal(pattern.test(lines.filter((_, i) => i !== index).join("\n")), false, `deletion compensated: ${name}`);
    lines[index] = lines[index].replace(/MUST NOT|MUST/g, "MAY");
    assert.equal(pattern.test(lines.join("\n")), false, `polarity removal accepted: ${name}`);
  }
});

test("Forms/Workflows ownership cites the product ADR rather than inventing a source ADR", () => {
  assert.match(rule, /https:\/\/github\.com\/[^\s)]+\/Devpro\.MvcCore\.Base\/blob\/[^\s)]+\/docs\/adr\/002-forms-workflow-integration-contract\.md/);
  assert.match(rule, /Forms[^\n]*表單[^\n]*outbox[^\n]*Workflows[^\n]*流程[^\n]*approval[^\n]*task/);
});
