/**
 * Guarantee ceiling (cooperative-only).
 *
 * Locks: the SQL keyword casing convention in `database-conventions.md`, the
 * lowercase SQL example in `security-coding.md`, and the axis-2 review sub-check.
 * Does NOT prove: that agents follow the locked wording, that a paraphrase with
 * the same meaning is handled correctly, or that the meaning around an intact
 * anchor has not been inverted. Deleting an anchor fails this file; inverting the
 * meaning around an intact anchor does not. Review owns that half.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";
import { readSpecWithDelta } from "./lib/spec-delta-reader.mjs";

const changeName = "add-sql-casing-convention";

function assertIncludes(body, phrases) {
  for (const phrase of phrases) {
    assert.ok(body.includes(phrase), `missing phrase: ${phrase}`);
  }
}

test("database-conventions.md carries the SQL keyword casing convention", () => {
  const conventions = read(".devpro/agent-rules/database-conventions.md");
  assertIncludes(conventions, [
    "SQL 關鍵字大小寫慣例",
    "@@ROWCOUNT",
    "host language",
    "使用者明確指定",
  ]);
});

test("casing convention scope covers host-language embedded SQL and prose exception covers clause keywords", () => {
  const conventions = read(".devpro/agent-rules/database-conventions.md");
  const scopeLine = conventions
    .split("\n")
    .find((l) => l.includes("SQL script 與 fenced SQL 範例中的關鍵字"));
  assert.ok(scopeLine, "casing rule line not found on a single line");
  assert.ok(scopeLine.includes("host language"), "host-language scope not on the casing rule line");

  const exceptionLine = conventions.split("\n").find((l) => l.includes("不受本慣例約束"));
  assert.ok(exceptionLine, "prose exception line not found");
  assert.ok(
    exceptionLine.includes("IF NOT EXISTS"),
    "clause-keyword prose exception (IF NOT EXISTS) missing from exception line",
  );
});

test("security-coding.md SQL injection example uses lowercase keywords", () => {
  const securityCoding = read(".devpro/agent-rules/security-coding.md");
  assertIncludes(securityCoding, [
    "select * from Users where Name",
    "select * from Users where Name = @Name",
  ]);
  assert.ok(
    !securityCoding.includes('$"SELECT * FROM Users'),
    "uppercase SQL keyword example should have been replaced",
  );
});

test("軸 2 carries the SQL Keyword Casing Convention sub-check", () => {
  const checklist = read(".devpro/agent-rules/code-review-checklist.md");
  assertIncludes(checklist, [
    "SQL Keyword Casing Convention sub-check",
    "database-conventions.md",
    "cooperative-only",
  ]);
});

test("sub-check phrase, Suggestion grade, and cooperative-only marker are single-line grep-matchable", () => {
  const checklist = read(".devpro/agent-rules/code-review-checklist.md");
  const subCheckLine = checklist
    .split("\n")
    .find((l) => l.includes("SQL Keyword Casing Convention sub-check"));
  assert.ok(subCheckLine, "sub-check line not found on a single line");
  assert.ok(subCheckLine.includes("標 **Suggestion**"), "Suggestion grade not on the sub-check line");
  assert.ok(subCheckLine.includes("無 mechanical hook gate"), "cooperative-only marker not on the sub-check line");
  assertIncludes(subCheckLine, ["dp-reviewer", "devpro:second-review"]);
});

test("capability spec delta carries the SQL Keyword Casing Convention requirement", () => {
  const checklistSpec = readSpecWithDelta("code-review-checklist", { changeName });
  assertIncludes(checklistSpec, [
    "SQL Keyword Casing Convention Sub-check",
    "cooperative-only",
    "no mechanical hook gate enforces it",
    "devpro:second-review",
    "SHALL flag the casing deviation as **Suggestion**",
  ]);
});

test("spec delta exercises the host-language-embedded-SQL trigger arm with its own scenario", () => {
  const checklistSpec = readSpecWithDelta("code-review-checklist", { changeName });
  assertIncludes(checklistSpec, [
    "Host-language string literal embedding SQL is in scope",
    "reviewer SHALL NOT treat this trigger arm as out of scope merely because the SQL is embedded in host-language code",
  ]);
});

test("SQL script file scope is not asymmetrically globbed across carriers", () => {
  const conventions = read(".devpro/agent-rules/database-conventions.md");
  const checklist = read(".devpro/agent-rules/code-review-checklist.md");
  const checklistSpec = readSpecWithDelta("code-review-checklist", { changeName });
  for (const [label, body] of [
    ["database-conventions.md", conventions],
    ["code-review-checklist.md", checklist],
    ["code-review-checklist spec delta", checklistSpec],
  ]) {
    assert.ok(!body.includes("sql/**/*.sql"), `${label} should not hard-code a glob the SSOT doesn't use`);
  }
});
