// Issue #3525: a reviewer finding's claimed trigger condition / reachable path
// is a hypothesis; the TL verifies it (caller trace or reproduction) before
// relaying it, rating severity, or opening a fix branch, and labels it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSourceFile as read } from "./lib/read.mjs";

const LEAF = ".devpro/agent-rules/pr-review-evidence-verification.md";

function section(content, heading) {
  const start = content.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `missing section: ${heading}`);
  const end = content.indexOf("\n## ", start + 4);
  return content.slice(start, end === -1 ? undefined : end);
}

test("reviewer trigger claims are hypotheses that must be verified before use", () => {
  const body = section(read(LEAF), "Reviewer Finding 的觸發條件");
  assert.match(body, /觸發條件與可達路徑同樣是 \*\*hypothesis\*\*/);
  assert.match(body, /轉述給使用者、據以定嚴重度、或據以開修正分支之前，MUST 先驗證觸發條件/);
  assert.match(body, /往上追實際 caller 直到入口，或實際重現/);
  assert.match(body, /`觸發條件：已驗證（<呼叫路徑或重現指令>）` 或 `觸發條件：未驗證`/);
  assert.match(body, /標「未驗證」的 finding MUST NOT 據以定嚴重度或開修正分支/);
  assert.match(body, /依實際路徑重定嚴重度，並告訴使用者原說法與差異/);
});

test("the rule is reachable from the leaf triggers and the review checklist", () => {
  const leaf = read(LEAF);
  const frontmatter = leaf.slice(0, leaf.indexOf("\n---", 4));
  assert.match(frontmatter, /轉述 reviewer（含跨模型第二意見）finding 的觸發條件/);
  assert.match(section(leaf, "When to Use"), /見 §Reviewer Finding 的觸發條件/);
  assert.match(section(leaf, "Exit Criteria"), /`觸發條件：已驗證（…）` 或 `觸發條件：未驗證`/);
  assert.match(
    read(".devpro/agent-rules/code-review-checklist.md"),
    /\*\*Load-chain\*\*：Evidence claim／reviewer finding 觸發條件→`pr-review-evidence-verification\.md`/,
  );
});
