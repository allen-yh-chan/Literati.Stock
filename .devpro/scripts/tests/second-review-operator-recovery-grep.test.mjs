// refactor-second-review-operator-recovery: authoring guards for the split of the three
// operator-only recovery entries out of second-review-control-evidence.md. Behavior of
// each entry stays proven by the runner reconcile fixtures and the control-evidence
// suite; this file only locks where each piece of text lives and who points at it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";

const read = (file) => readFileSync(path.join(REPO_ROOT, file), "utf8");
const MAIN = ".devpro/agent-rules/second-review-control-evidence.md";
const RECOVERY = ".devpro/agent-rules/second-review-operator-recovery.md";

function section(text, heading, carrier) {
  const parts = text.split(`\n${heading}\n`);
  assert.equal(parts.length, 2, `${carrier} must contain exactly one ${heading}`);
  return parts[1].split(/\n#{2,3} /)[0];
}

const ENTRIES = [
  {
    heading: "### 2.1 Legacy diagnostic dispatch closure（operator-only）",
    mainHeading: "### 2.1 Legacy diagnostic dispatch closure（operator-only）",
    pointer: /^\*\*操作者關閉入口（僅 operator）\*\*：[^\n]*`second-review-operator-recovery\.md` §2\.1[^\n]*一般審查不讀。$/m,
    command: "--reconcile-legacy-diagnostic-scan <observability-context.json>",
  },
  {
    heading: "### Credential publication denial 的失敗終態恢復",
    mainHeading: "### Credential publication denial 的失敗終態恢復",
    pointer: /^\*\*操作者補收據入口（僅 operator）\*\*：[^\n]*`second-review-operator-recovery\.md` §Credential publication denial[^\n]*上段 receipt 映射在一般審查也生效。$/m,
    command: "--reconcile-credential-gate-terminal <observability-context.json>",
  },
  {
    heading: "### Interrupted runner 的 operator disposition",
    mainHeading: "## Interrupted runner 的 operator disposition",
    pointer: /^\*\*操作者放棄入口（僅 operator）\*\*：[^\n]*`operator_abandoned_interrupted_dispatch`[^\n]*`second-review-operator-recovery\.md` §Interrupted runner[^\n]*下段 authority fence 在一般審查也生效。$/m,
    command: "abandon-interrupted-second-review.mjs <observability-context.json> --dry-run",
  },
];

test("each operator-only entry keeps its heading and a load pointer in the control-evidence leaf", () => {
  const main = read(MAIN);
  for (const entry of ENTRIES) {
    const body = section(main, entry.mainHeading, MAIN);
    assert.match(body, entry.pointer, `${entry.mainHeading} must point full readers at the recovery leaf`);
    assert.ok(!main.includes(entry.command), `${MAIN} must not keep the moved operator command ${entry.command}`);
  }
});

test("normal-path contracts beside the moved entries stay in the control-evidence leaf", () => {
  const main = read(MAIN);
  const credential = section(main, "### Credential publication denial 的失敗終態恢復", MAIN);
  assert.match(credential, /^Runner 的 `sticky_credential_literal_blocked` \/ `sticky_credential_literal_detected` 只在 receipt 層映射為既有 `sticky_contract_invalid`/m);
  const interrupted = section(main, "## Interrupted runner 的 operator disposition", MAIN);
  assert.match(interrupted, /^Known disposed exact dispatch 的 sticky 無 admission authority：[^\n]*`assertDispatchReviewAuthority`[^\n]*無 disposition 時 fence 只需讀取權限、MUST NOT 取 capacity lock/m);
  assert.match(main, /`second-review-operator-recovery\.md` Interrupted runner契約的operator disposition（不宣稱closed）/);
});

test("the recovery leaf holds each entry command under its own section and stays operator-only", () => {
  const recovery = read(RECOVERY);
  assert.match(recovery, /^name: second-review-operator-recovery$/m);
  assert.match(recovery, /^三個只由操作者明示執行的恢復入口，hook、renderer、gate 或 scheduler 不得自動呼叫。/m);
  for (const entry of ENTRIES) {
    assert.ok(section(recovery, entry.heading, RECOVERY).includes(entry.command), `${entry.heading} must keep ${entry.command}`);
  }
  assert.match(recovery, /^- 成功輸出不寫 completion 或 sticky、不清 marker、不授予 PASS／WARN 或 merge readiness/m);
});

test("by-name references to the moved entries point at the recovery leaf", () => {
  const skill = read(".devpro/agent-skills/devpro-reviews/second-review/SKILL.md");
  assert.match(skill, /先依 `second-review-operator-recovery\.md` 的 legacy-only operator closure 關閉/);
  assert.match(skill, /依 `second-review-operator-recovery\.md` 的 Interrupted runner operator disposition 入口帶 `--confirm`／`--reason` 執行/);
  assert.match(read(".devpro/agent-rules/post-pr-completion-gate.md"), /既有 interrupted runner 可依 `second-review-operator-recovery\.md` 的 operator disposition 契約成為 fresh full-review predecessor/);
  assert.match(read(".devpro/agent-rules/post-pr-marker-disposition.md"), /另可依`second-review-operator-recovery\.md`接受獨立operator-disposed interrupted predecessor/);
  for (const file of [".devpro/agent-skills/devpro-reviews/second-review/SKILL.md", ".devpro/agent-rules/post-pr-completion-gate.md", ".devpro/agent-rules/post-pr-marker-disposition.md"]) {
    assert.doesNotMatch(read(file), /`second-review-control-evidence\.md`\s*的\s*(?:legacy-only operator closure|Interrupted runner operator disposition|operator disposition 契約)/, file);
  }
});
