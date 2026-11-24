import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { repoPath } from "./lib/repo-root.mjs";

const carriers = [
  ".devpro/agent-rules/ai-autonomy.md",
  ".devpro/agent-skills/devpro-workflows/change/SKILL.md",
  ".devpro/agent-rules/proposal-template.md",
];
const contract = /^.*full 中途改 stepwise[^\n]*TL MUST[^\n]*下一個原 covered write 前[^\n]*保留 `## Batch Approval Ledger` 標題[^\n]*整段 ledger 內容替換為 `N\/A: no batch approval selected`[^\n]*MUST NOT[^\n]*舊的 `kind`／`covers`[^\n]*逐步確認.*$/m;

for (const file of carriers) {
  const read = () => readFileSync(repoPath(file), "utf8");
  test(`${file}: full revocation replaces the whole body before any covered write`, () => assert.match(read(), contract));
  test(`${file}: deletion and polarity reversal of revocation are rejected`, () => {
    const content = read();
    assert.match(content, contract);
    assert.doesNotMatch(content.replace(contract, ""), contract);
    assert.doesNotMatch(content.replace(/TL MUST(?=[^\n]*下一個原 covered write 前)/g, "TL MAY"), contract);
    assert.doesNotMatch(content.replace("整段 ledger 內容替換為", "追加文字至"), contract);
  });
}

test("canonical flow and residual controls both include full revocation", () => {
  assert.match(readFileSync(repoPath("openspec/specs/openspec-flow/spec.md"), "utf8"), /### Requirement: Full Batch Approval Revocation Returns To Stepwise/);
  assert.match(readFileSync(repoPath(".devpro/agent-rules/design-core.md"), "utf8"), /full[^\n]*中途改 stepwise[^\n]*整段 ledger[^\n]*N\/A: no batch approval selected/);
  assert.match(readFileSync(repoPath("openspec/specs/design-core/spec.md"), "utf8"), /switching to stepwise replaces the entire full ledger body[^\n]*N\/A: no batch approval selected/);
});
