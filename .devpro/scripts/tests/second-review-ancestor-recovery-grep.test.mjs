// #3172: authoring guards for the TL recovery recipe, not restoration authority.
// The behavioral positive/negative fixture remains in hook-post-pr-completion.test.mjs:
// "lineage lifetime gate retains markers for missing, corrupt and retiring ancestors with safe diagnostics".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const read = (file) => readFileSync(repoPath(file), "utf8");
const recovery = ".devpro/agent-rules/second-review-ancestor-recovery.md";

test("missing/corrupt ancestor action loads the recovery recipe without routing other faults into restoration", () => {
  const entry = read(".devpro/agent-rules/second-review-control-evidence.md");
  const section = entry.split("### 3.4 Component retirement and recovery\n")[1]?.split("\n### 4.")[0];
  assert.ok(section);
  assert.match(section, /Missing\/corrupt current\/ancestor[^\n]*`predecessor_reservation_missing`[^\n]*MUST 先讀 `second-review-ancestor-recovery\.md`/);
  assert.match(section, /鎖競爭／binding mismatch 保留原分類，不附 restoration 指引/);
  assert.match(section, /觸發：[^\n]*reader\/writer\/gate[^\n]*`dispatch_evidence_retiring`[^\n]*`retirement_recovery_required`/);
  assert.match(read(".devpro/agent-rules/post-pr-completion-gate.md"), /^Load-chain（current／ancestor 缺損或既有 lineage 的 predecessor 缺失時）：MUST 讀 `second-review-ancestor-recovery\.md`；正常 review 不載入。$/m);
});

test("TL investigation records the bound root, original evidence inventory and responsible next action", () => {
  const body = read(recovery);
  const section = body.split("### 1. 調查紀錄\n")[1]?.split("\n### 2.")[0];
  assert.ok(section);
  for (const field of ["resolved_root", "repository_slug", "pr_number", "head_ref_oid", "expected_dispatch_id", "missing_dispatch_id", "previous_dispatch_id", "searched_sources", "original_provenance", "verification", "status", "owner", "next_action"]) {
    assert.match(section, new RegExp(`(?<![\\w])${field}(?![\\w])`));
  }
  assert.match(section, /紀錄 MUST NOT 成為 receipt、closure 或 marker-clear authority/);
  assert.match(section, /MUST 保留原 marker 與現存 evidence/);
});

test("restoration requires verified original bytes and the original gate, while retirement uses its existing owner", () => {
  const body = read(recovery);
  const section = body.split("### 2. 可還原\n")[1]?.split("\n### 3.")[0];
  assert.ok(section);
  assert.match(section, /MUST 驗證來源為原始 immutable evidence[^\n]*獨立保存的 hash／length[^\n]*不得用候選檔自己算出的 hash 當原始來源證明/);
  assert.match(section, /MUST 先停止相關 writer／cleanup owner[^\n]*既有 lock[^\n]*root／marker binding/);
  assert.match(section, /MUST 只還原已核准 root 的原始 regular-file bytes[^\n]*不得重新序列化、改 ID 或重建 receipt/);
  assert.match(section, /MUST 重跑原先被擋的 gate[^\n]*原 gate 的成功結果[^\n]*才可記 `restored-and-gate-passed`/);
  assert.match(body, /retiring[^\n]*MUST 回到[^\n]*cleanupOwnedControlEvidence/);
  assert.match(body, /corrupt retirement authority[^\n]*MUST 保留 authority/);
});

test("unrecoverable evidence ends blocked with an owner and escalation, never a synthetic successor", () => {
  const body = read(recovery);
  const section = body.split("### 3. 不可還原／尚不可驗證\n")[1]?.split("\n## ")[0];
  assert.ok(section);
  assert.match(section, /MUST 記 `blocked-escalated`[^\n]*已查來源[^\n]*缺失或不可驗原因[^\n]*owner[^\n]*next_action/);
  assert.match(section, /MUST 保留 blocked marker[^\n]*現存 evidence/);
  assert.match(section, /MUST NOT 刪 marker、捏造 receipt、略過 ancestor、移除 `previous_dispatch_id` 或以 fresh successor 當成恢復/);
  assert.match(section, /新 marker transition／closure authority MUST 另案取得[^\n]*獨立審查[^\n]*負面測試/);
});

test("canonical predecessor diagnostic distinguishes new lineage from an outstanding ancestor obligation", () => {
  const spec = read("openspec/specs/cross-runtime-parity/spec.md");
  const section = spec.split("### Requirement: Missing Direct Predecessor Reservation Names Cause And Next Step\n")[1]?.split("\n### Requirement:")[0];
  assert.ok(section);
  assert.match(section, /Only a new lineage with no pending marker or ancestor obligation MAY omit `previous_dispatch_id`/);
  assert.match(section, /MUST NOT delete a marker, synthesize a receipt, skip an ancestor, or treat a fresh successor as restoration/);
  assert.ok(section.includes("Scenario: Verified original restoration completes the original gate"));
  assert.ok(section.includes("Scenario: Unrecoverable ancestor remains blocked with an explicit escalation"));
  assert.doesNotMatch(section, /names only the prior same-head render|when the predecessor is truly absent re-render/);
});

test("copy-executed restoration verification references a registered fixture instead of silently skipping all tests", () => {
  const commands = [...read(recovery).matchAll(/node --test --test-name-pattern='([^']+)' (\.devpro\/scripts\/tests\/[\w.-]+\.mjs)/g)];
  assert.equal(commands.length, 1);
  const [, name, file] = commands[0];
  assert.ok(read(file).includes(`nodeTest("${name}",`), `documented fixture is not registered: ${name}`);
});

test("every handoff template preserves an outstanding predecessor across head changes", () => {
  const expected = "previous_dispatch_id: <omit on first dispatch only with no pending marker/ancestor obligation; else direct predecessor dispatch_id for same-head retry or approved cross-head successor, including when CLI was not invoked but pending marker advanced>";
  for (const [file, count] of [
    [".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md", 2],
    [".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md", 1],
  ]) {
    const lines = read(file).split("\n").filter((line) => line.startsWith("previous_dispatch_id:"));
    assert.equal(lines.length, count, file);
    assert.deepEqual(lines, Array(count).fill(expected), file);
  }
});
