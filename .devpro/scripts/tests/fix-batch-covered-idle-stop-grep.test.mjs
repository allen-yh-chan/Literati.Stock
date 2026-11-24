import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";



function selfCheckBody(leaf) {
  const m = leaf.match(
    /### Final-response self-check\n\n([\s\S]*?)(?=\n### )/,
  );
  assert.ok(m, "Final-response self-check section not found");
  return m[1];
}

function testsGreenExample(leaf) {
  const m = leaf.match(
    /單一確定動作 → 1\.是 2\.否 3\.其他[\s\S]*?(?=\n\*\*例：規則 5)/,
  );
  assert.ok(m, "tests-green 通吃範例 block not found");
  return m[0];
}

function currentIntentParagraph(autonomy) {
  const m = autonomy.match(
    /\*\*CurrentIntent sanity check[\s\S]*?(?=\n> Load-chain)/,
  );
  assert.ok(m, "CurrentIntent sanity check paragraph not found");
  return m[0];
}

function worktreeDoneParagraph(autonomy) {
  const m = autonomy.match(
    /worktree \/ change 已完成但尚未 commit[\s\S]*?(?=\n\n\*\*CurrentIntent)/,
  );
  assert.ok(m, "worktree-done Ask First paragraph not found");
  return m[0];
}

test("stop-point-comms Final-response self-check has Matching Ledger exception on same physical line", () => {
  const body = selfCheckBody(read(".devpro/agent-rules/stop-point-comms.md"));
  const line = body.split("\n").find((l) => /Matching Ledger/.test(l) && /MUST NOT/.test(l));
  assert.ok(line, "self-check missing Matching Ledger exception line");
  assert.match(
    line,
    /Matching Ledger[^\n]*covers[^\n]*MUST NOT[^\n]*編號選項|Matching Ledger[^\n]*覆蓋[^\n]*MUST NOT[^\n]*編號選項/,
    "self-check exception must bind Matching Ledger coverage to MUST NOT 編號選項 on one line",
  );
  assert.match(line, /ai-autonomy\.md/, "self-check exception must cite ai-autonomy.md SSOT");
});

test("stop-point-comms tests-green 通吃範例 has Matching Ledger exception", () => {
  const block = testsGreenExample(read(".devpro/agent-rules/stop-point-comms.md"));
  assert.match(
    block,
    /Matching Ledger[^\n]*覆蓋[^\n]*MUST NOT[^\n]*1\.是 2\.否 3\.其他|Matching Ledger 例外[^\n]*MUST NOT[^\n]*製造/,
    "通吃範例 must state matching-ledger exception against manufacturing 1.是 2.否 3.其他",
  );
});

test("stop-point-comms MUST NOT copy Matching Ledger YAML body", () => {
  const leaf = read(".devpro/agent-rules/stop-point-comms.md");
  assert.doesNotMatch(
    leaf,
    /kind:\s*same-change-dp-change-batch/,
    "presentation leaf must not copy the YAML ledger body",
  );
});

test("ai-autonomy CurrentIntent matching covered write MUST NOT ask; AskFirstPending=false", () => {
  const para = currentIntentParagraph(read(".devpro/agent-rules/ai-autonomy.md"));
  const line = para.split("\n").find((l) => /Matching Ledger/.test(l) && /MUST NOT/.test(l));
  assert.ok(line, "CurrentIntent missing Matching Ledger exception line");
  assert.match(
    line,
    /Matching Ledger[^\n]*MUST NOT[^\n]*問/,
    "CurrentIntent exception must bind Matching Ledger to MUST NOT 問 on one line",
  );
  assert.match(
    line,
    /AskFirstPending[^\n]*false/,
    "CurrentIntent exception must set AskFirstPending false on the same line",
  );
});

test("ai-autonomy worktree-done paragraph: ledger 已蓋則不是 blocker", () => {
  const para = worktreeDoneParagraph(read(".devpro/agent-rules/ai-autonomy.md"));
  assert.match(
    para,
    /ledger 已蓋則不是/,
    "worktree-done paragraph must say ledger 已蓋則不是 blocker",
  );
  const line = para.split("\n").find((l) => /ledger 已蓋則不是/.test(l));
  assert.ok(line, "ledger 已蓋則不是 must appear on a physical line");
  assert.match(
    line,
    /ledger 已蓋則不是[^\n]*blocker|ledger 已蓋則不是 user-owned/,
    "same line must deny user-owned git Ask First blocker when ledger covers",
  );
});

test("ai-autonomy Implementation-complete forbids pre-PR milestone idle-stop", () => {
  const autonomy = read(".devpro/agent-rules/ai-autonomy.md");
  assert.match(
    autonomy,
    /Implementation-complete → covered pre-PR/,
    "must name Implementation-complete → covered pre-PR clause",
  );
  const line = autonomy
    .split("\n")
    .find((l) => /Implementation-complete/.test(l) && /pre_pr_gate/.test(l));
  assert.ok(line, "Implementation-complete clause must bind pre_pr_gate on one physical line");
  assert.match(
    line,
    /MUST NOT|禁/,
    "same line must forbid re-asking / numbered milestone menu",
  );
  const rat = read(".devpro/agent-rules/ai-autonomy-rationalizations.md");
  assert.match(
    rat,
    /實作／tasks 做完了[^\n]*pre-PR|Implementation-complete → covered pre-PR/,
    "rationalizations must call out implementation-complete idle-stop excuse",
  );
});

test("matching-ledger idle-stop anchors FAIL when exception clauses are removed (negative)", () => {
  const comms = read(".devpro/agent-rules/stop-point-comms.md").replace(/Matching Ledger/g, "");
  const autonomy = read(".devpro/agent-rules/ai-autonomy.md")
    .replace(/Matching Ledger/g, "")
    .replace(/ledger 已蓋則不是/g, "")
    .replace(/Implementation-complete/g, "")
    .replace(/pre_pr_gate/g, "");
  assert.throws(() => {
    const body = selfCheckBody(comms);
    const line = body.split("\n").find((l) => /Matching Ledger/.test(l) && /MUST NOT/.test(l));
    assert.ok(line);
  }, "removing Matching Ledger from stop-point-comms must fail self-check assertion");
  assert.throws(() => {
    const para = currentIntentParagraph(autonomy);
    const line = para.split("\n").find((l) => /Matching Ledger/.test(l) && /MUST NOT/.test(l));
    assert.ok(line);
  }, "removing Matching Ledger from CurrentIntent must fail");
  assert.throws(() => {
    assert.match(worktreeDoneParagraph(autonomy), /ledger 已蓋則不是/);
  }, "removing ledger 已蓋則不是 must fail");
  assert.throws(() => {
    const line = autonomy
      .split("\n")
      .find((l) => /Implementation-complete/.test(l) && /pre_pr_gate/.test(l));
    assert.ok(line);
  }, "removing Implementation-complete/pre_pr_gate must fail");
});
