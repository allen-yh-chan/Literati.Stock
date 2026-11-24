import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";

// #2858 (Medium): dp-assistant and dp-programmer each stated their prohibitions twice, once under
// "你不該做的事" and again under a "## 禁止事項" section, so a later edit to one list drifts from the
// other. One list remains in each file; the single clause that existed only in the second list is
// folded into the first. (dp-reviewer / dp-second-reviewer keep their "## 禁止事項" section: other
// tests slice on that heading.)

const read = (name) => readFileSync(path.join(REPO_ROOT, ".claude/agents", name), "utf8");
const assistant = read("dp-assistant.md");
const programmer = read("dp-programmer.md");

for (const [name, text] of [["dp-assistant.md", assistant], ["dp-programmer.md", programmer]]) {
  test(`${name}: prohibitions are stated once, under 你不該做的事`, () => {
    assert.ok(!text.includes("## 禁止事項"));
    assert.equal(text.split("\n").filter((line) => line.startsWith("### 你不該做的事")).length, 1);
  });

  test(`${name}: the post-result hand-back guidance still sits in the Communication Protocol, after the output format`, () => {
    const protocolAt = text.indexOf("## Communication Protocol");
    const handBackAt = text.indexOf("主 agent 收到結果後：");
    assert.ok(protocolAt >= 0 && handBackAt > protocolAt);
    const bugfixAt = text.indexOf("## Bugfix Prove-It Pattern");
    if (bugfixAt >= 0) assert.ok(handBackAt < bugfixAt, "hand-back guidance must not slide under the Prove-It section");
  });
}

test("dp-assistant keeps the PASS-needs-test-output clause, bound to the test-skipping prohibition", () => {
  const lines = assistant.split("\n").filter((line) => line.includes("測試輸出證據"));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^- \*\*禁止\*\*跳過測試失敗[^\n]*PASS 也要附測試輸出證據/);
});

test("dp-programmer keeps the project-settings clause, bound to the package prohibition", () => {
  const lines = programmer.split("\n").filter((line) => line.includes("改 project 設定"));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^- \*\*禁止\*\*加第三方套件[^\n]*改 project 設定[^\n]*`\.csproj`[^\n]*`package\.json`[^\n]*`\.sln`/);
});
