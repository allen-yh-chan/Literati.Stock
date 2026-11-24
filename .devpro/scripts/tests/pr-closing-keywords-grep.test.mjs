import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const RULE = readFileSync(
  repoPath(".devpro/agent-rules/git-pr-template-and-merge.md"),
  "utf8",
);
const TEMPLATE = readFileSync(
  repoPath(".github/PULL_REQUEST_TEMPLATE.md"),
  "utf8",
);

describe("PR closing keywords multi-issue shape (#2735)", () => {
  test("rule forbids slash-joined Close #A / #B", () => {
    assert.match(
      RULE,
      /MUST NOT[^\n]*Close #12 \/ #34/,
      "git-pr-template-and-merge.md missing MUST NOT Close #12 / #34 anchor",
    );
  });

  test("rule forbids bare comma form Closes #12, #34 and teaches full-syntax comma", () => {
    assert.match(
      RULE,
      /MUST NOT[^\n]*Closes #12, #34/,
      "git-pr-template-and-merge.md missing MUST NOT Closes #12, #34 anchor",
    );
    assert.match(
      RULE,
      /Closes #12, closes #34/,
      "git-pr-template-and-merge.md missing allowed Closes #12, closes #34 example",
    );
    assert.doesNotMatch(
      RULE,
      /亦可使用 GitHub 接受的 comma 形（例 `Closes #12, #34`）/,
      "stale allowed example Closes #12, #34 must not remain",
    );
  });

  test("rule keeps one Fixes/Closes token per issue guidance", () => {
    assert.match(
      RULE,
      /每行一條 `Fixes #N`/,
      "git-pr-template-and-merge.md missing 每行一條 Fixes #N",
    );
    assert.match(
      RULE,
      /獨立 `KEYWORD #N` token/,
      "git-pr-template-and-merge.md missing 獨立 KEYWORD #N token",
    );
  });

  test("rule anti-rationalization covers slash join and bare comma", () => {
    assert.match(
      RULE,
      /「`Close #12 \/ #34` 比較省事/,
      "missing anti-rationalization row for slash-joined closing keywords",
    );
    assert.match(
      RULE,
      /「`Closes #12, #34` 是官方 comma 形」/,
      "missing anti-rationalization row for bare comma closing keywords",
    );
  });

  test("PR template documents Fixes/Closes block and forbids slash/bare-comma join", () => {
    assert.match(
      TEMPLATE,
      /## Fixes \/ Closes/,
      "PULL_REQUEST_TEMPLATE.md missing Fixes / Closes section",
    );
    assert.match(
      TEMPLATE,
      /MUST NOT: Close #12 \/ #34/,
      "PULL_REQUEST_TEMPLATE.md missing MUST NOT Close #12 / #34 hint",
    );
    assert.match(
      TEMPLATE,
      /Closes #12, closes #34/,
      "PULL_REQUEST_TEMPLATE.md missing allowed Closes #12, closes #34 hint",
    );
    assert.match(
      TEMPLATE,
      /Closes #12, #34/,
      "PULL_REQUEST_TEMPLATE.md missing MUST NOT Closes #12, #34 hint",
    );
  });
});
