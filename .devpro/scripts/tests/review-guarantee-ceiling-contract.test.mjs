import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { reviewChecklistCriteriaLines } from "../lib/second-review-checklist.mjs";

// These checks cover transport of the owned criteria, not semantic completeness
// of the inventory or correctness of the TL/reviewer's classification.
const ruleUrl = new URL("../../agent-rules/review-guarantee-ceiling.md", import.meta.url);
const heading = "### Review Admission Checklist";
const endHeading = "### Verification Boundary";

test("the owned review-admission criteria reach the real renderer checklist once", () => {
  const rule = readFileSync(ruleUrl, "utf8");
  const from = rule.indexOf(`\n${heading}\n`);
  const to = rule.indexOf(`\n${endHeading}\n`, from + 1);
  assert.ok(from >= 0 && to > from);
  const owned = rule.slice(from + 1, to).trim();
  const criteria = reviewChecklistCriteriaLines().join("\n");
  assert.equal(criteria.split(owned).length - 1, 1);
  assert.equal(criteria.split(heading).length - 1, 1);
});

test("the packet contains one admission rule body with the canonical return condition", () => {
  const criteria = reviewChecklistCriteriaLines().join("\n");
  assert.equal(criteria.split("**Reviewer guarantee-ceiling design admission**").length - 1, 1);
  assert.match(criteria, /\*\*Reviewer guarantee-ceiling design admission\*\*[^\n]*變更宣稱導入[^\n]*缺任何一項 MUST 退回設計/u);
});

async function withInstallation(run) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "review-ceiling-install-")));
  const rules = path.join(root, "agent-rules");
  const lib = path.join(root, "scripts/lib");
  mkdirSync(rules, { recursive: true }); mkdirSync(lib, { recursive: true });
  try {
    for (const name of ["code-review-checklist.md", "code-review-cross-carrier.md", "code-review-cross-model.md", "review-guarantee-ceiling.md"]) {
      copyFileSync(new URL(`../../agent-rules/${name}`, import.meta.url), path.join(rules, name));
    }
    const target = path.join(lib, "second-review-checklist.mjs");
    copyFileSync(new URL("../lib/second-review-checklist.mjs", import.meta.url), target);
    await run({ rules, criteria: (await import(pathToFileURL(target).href)).reviewChecklistCriteriaLines });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const boundary of [heading, endHeading]) {
  test(`missing ${boundary} refuses the renderer checklist`, () => withInstallation(({ rules, criteria }) => {
    const target = path.join(rules, "review-guarantee-ceiling.md");
    writeFileSync(target, readFileSync(target, "utf8").replace(`\n${boundary}\n`, "\n### Broken boundary\n"));
    assert.throws(criteria, /second_review_checklist_section_missing: ### Review Admission Checklist \/ ### Verification Boundary/u);
  }));
}

test("LF and CRLF installations transport the same owned criteria and still reject missing boundaries", async () => {
  const expected = reviewChecklistCriteriaLines();
  await withInstallation(({ rules, criteria }) => {
    for (const name of ["code-review-checklist.md", "code-review-cross-carrier.md", "code-review-cross-model.md", "review-guarantee-ceiling.md"]) {
      const target = path.join(rules, name);
      writeFileSync(target, readFileSync(target, "utf8").replace(/\r?\n/g, "\r\n"));
    }
    assert.deepEqual(criteria(), expected);
    const target = path.join(rules, "review-guarantee-ceiling.md");
    const original = readFileSync(target, "utf8");
    for (const boundary of [heading, endHeading]) {
      const changed = original.replace(`\r\n${boundary}\r\n`, "\r\n### Broken boundary\r\n");
      assert.notEqual(changed, original);
      writeFileSync(target, changed);
      assert.throws(criteria, /second_review_checklist_section_missing: ### Review Admission Checklist \/ ### Verification Boundary/u);
    }
  });
});

test("missing rule refuses the renderer checklist", () => withInstallation(({ rules, criteria }) => {
  const missingRule = path.join(rules, "review-guarantee-ceiling.md");
  rmSync(missingRule);
  assert.throws(criteria, error => {
    assert.equal(error.code, "ENOENT");
    assert.equal(error.path, missingRule);
    return true;
  });
}));

test("design and review entry pointers resolve admission and output duties separately", () => {
  const rule = readFileSync(ruleUrl, "utf8");
  assert.match(rule, /^### Review Output Contract\r?$/m);
  const design = readFileSync(new URL("../../agent-rules/design-core.md", import.meta.url), "utf8");
  const hub = readFileSync(new URL("../../agent-rules/code-review-checklist.md", import.meta.url), "utf8");
  for (const entry of [design, hub]) {
    const pointer = entry.split("\n").find(line => line.includes("review-guarantee-ceiling.md") && line.includes("Review Admission Checklist"));
    assert.ok(pointer, "entry must identify the owned admission section");
    assert.match(pointer, /保證上限、finding 分類或必填輸出設計/);
    assert.match(pointer, /評估輸出.*Review Output Contract/);
  }
  assert.match(reviewChecklistCriteriaLines().join("\n"), /^### Review Output Contract$/m);
  assert.match(reviewChecklistCriteriaLines().join("\n"), /^- \*\*Assessment output（新 dispatch）\*\*：每個 finding 都要評估，無 findings 用空陣列。/m);
});

for (const eol of ["\n", "\r\n"]) for (const boundary of ["### Review Output Contract", "## Exit Criteria"]) {
  test(`missing owned output boundary refuses transport: ${JSON.stringify(eol)} ${boundary}`, () => withInstallation(({ rules, criteria }) => {
    const target = path.join(rules, "review-guarantee-ceiling.md");
    const expected = criteria();
    const original = readFileSync(target, "utf8").replace(/\r?\n/g, eol);
    const from = original.indexOf(`${eol}### Review Output Contract${eol}`);
    const to = original.indexOf(`${eol}## Exit Criteria${eol}`, from + 1);
    assert.ok(from >= 0 && to > from);
    const owned = original.slice(from + eol.length, to).replaceAll("\r\n", "\n").trim();
    writeFileSync(target, original);
    assert.deepEqual(criteria(), expected, "unmodified LF/CRLF fixture must succeed before boundary mutation");
    assert.ok(criteria().join("\n").includes(owned), "the entire owned output contract must reach the reader");
    const changed = original.replace(`${eol}${boundary}${eol}`, `${eol}### Broken output boundary${eol}`);
    assert.notEqual(changed, original);
    writeFileSync(target, changed);
    assert.throws(criteria, /second_review_checklist_section_missing: ### Review Output Contract \/ ## Exit Criteria/u);
  }));
}
