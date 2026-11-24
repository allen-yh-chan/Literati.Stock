/**
 * clarify-release-subset-verification-command-grep.test.mjs
 *
 * B-mini chore clarify-release-subset-verification-command
 * (RULE-FEEDBACK from PR #1497 round-3 之殘留 (2)):
 * release-sit-uat-pat-prod.md §Verification 的 release⊆main 驗證指令 semantics 錯誤。
 * 先前 guard 只從 two-dot 修到 three-dot，但 finite release subset 不等於 current main：
 * main 可能含未核准單位，因此 current-main tree equality 只能用於 explicit full-main。
 * finite subset 的主要驗證必須是 structured approved-subset evidence。
 *
 * 本 guard 鎖：
 *   (a) §Verification 含 structured approved-subset evidence
 *   (b) §Verification 不再有舊 two-dot `git diff release/<v> main --stat` release⊆main 驗證行
 *   (c) §Verification 不把 `git diff main...release/<v> --stat` 當 finite subset 的主要 pass/fail
 *   (d) 註解拒斥 `--not main` 與 `git log main..release` 兩種拓撲判準
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
const ENTRY = readFileSync(
  repoPath(".devpro/agent-rules/release-sit-uat-pat-prod.md"),
  "utf8",
);
// The command block lives in the on-demand leaf; the entry keeps the section as a pointer.
const RELEASE = readFileSync(
  repoPath(".devpro/agent-rules/release-verification-commands.md"),
  "utf8",
);

// 只擷取 ## Verification 段（到下一個 ## 標題或檔尾），避免抓到 §148/§191 的散談 anchor。
// 停止界限只認行首 `## `（markdown H2）——不可用 `\n#`，否則會在 ```bash 區塊裡的
// `# 確認...` bash 註解提前截斷（曾誤截到只剩 3 行）。
function extractVerification(src) {
  const m = src.match(/## Verification[\s\S]*?(?=\n## |$)/);
  assert.ok(m, "## Verification section not found");
  return m[0];
}
const VERIFICATION = extractVerification(RELEASE);

test("(a) finite release subset 驗證用 structured approved-subset evidence", () => {
  for (const phrase of [
    "structured approved-subset evidence",
    "candidate subset list",
    "approved branches（核准快照",
    "git merge-base --is-ancestor <approved-sha> main",
    "git branch --contains <approved-sha> release/<YYYYMMDD>-<shortSHA>",
  ]) {
    assert.match(VERIFICATION, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `§Verification missing ${phrase}`);
  }
});

test("(b) 不再保留舊 two-dot symmetric `git diff release/<v> main --stat` release⊆main 驗證行", () => {
  // 舊指令：source 在前、main 在後、two-dot/space form —— 已被 three-dot 取代。
  // 只禁「行首可執行指令位置」的舊指令（`^` multiline）——不誤傷 (c) 註解裡 backtick-wrapped
  // 的 `勿用 ... git diff release/<v> main --stat` 反例引用（該引用前有前綴、非行首指令）。
  // `\S+` 涵蓋 `release/<YYYYMMDD>-<shortSHA>` 複合 placeholder（含 `-` 連字）。
  assert.doesNotMatch(
    VERIFICATION,
    /^git diff release\/\S+ main --stat/m,
    "§Verification 不得再有行首可執行的 two-dot `git diff release/<v> main --stat`（symmetric、必 false-positive）",
  );
});

test("(c) current-main tree equality 只屬 explicit full-main，不是 finite subset 主要驗證", () => {
  for (const phrase of [
    "approved subset = full-main",
    "selected main HEAD SHA",
    "git diff --stat <selected-main-sha> release/<YYYYMMDD>-<shortSHA>",
  ]) {
    assert.match(VERIFICATION, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `§Verification missing full-main phrase ${phrase}`);
  }
  assert.doesNotMatch(
    VERIFICATION,
    /^git diff main\.\.\.release\/\S+ --stat/m,
    "§Verification must not use current-main three-dot as a line-start primary command for finite subset",
  );
});

test("(d) 註解拒斥 --not main 與 git log main..release 兩種拓撲判準", () => {
  // 拒斥 --not main（PR #1497 既有）
  assert.match(
    VERIFICATION,
    /--not main/,
    "註解須保留拒斥 `git log release --not main` 拓撲判準",
  );
  // 拒斥 git log main..release（本 change 新增：release 的 no-ff merge commit 天生不在 main）
  assert.match(
    VERIFICATION,
    /git log main\.\.release/,
    "註解須新增拒斥 `git log main..release`（commit-level 拓撲判準、同 --not main false-positive）",
  );
  // 指明拓撲判準本質 + three-dot 內容判準為正解
  assert.match(
    VERIFICATION,
    /拓撲判準/,
    "註解須點明兩者皆 commit-level 拓撲判準",
  );
  assert.match(
    VERIFICATION,
    /structured approved-subset evidence/,
    "註解須指明 structured evidence 才是 finite subset 主要驗證",
  );
});

test("(e) regression: Verification 段其餘 SOP anchor 完好（未誤刪相鄰指令）", () => {
  assert.match(VERIFICATION, /git tag -l 'production-\*'/, "PROD tag 確認行遺失");
  assert.match(VERIFICATION, /git log release\/\S+ --oneline/, "release artifact SHA 確認行遺失");
  assert.match(VERIFICATION, /release ⊆ main/, "release⊆main 標題註解遺失");
});

test("(f) entry §Verification points at the leaf and keeps the finite-subset criterion", () => {
  const entry = extractVerification(ENTRY);
  assert.match(entry, /`release-verification-commands\.md`/, "entry §Verification must point at the command leaf");
  assert.match(entry, /structured approved-subset evidence/, "entry §Verification must keep the finite-subset primary criterion");
});


test('(g) finite content provenance preserves single assembly topology but rejects release-only content', () => {
  const glossary = readFileSync(repoPath('.devpro/agent-rules/branch-terminology-glossary.md'), 'utf8');
  function assertDefinitionPointer(content) {
    content = content.replace(/\r\n/g, '\n');
    const sections = [...content.matchAll(/^## Subset$/gm)];
    assert.equal(sections.length, 1, 'Subset section must be unique');
    const start = sections[0].index;
    const end = content.indexOf('\n## ', start + sections[0][0].length);
    const section = content.slice(start, end < 0 ? content.length : end);
    const definitions = [...section.matchAll(/^### 定義$/gm)];
    assert.equal(definitions.length, 1, 'Subset definition must be unique');
    const bodyStart = definitions[0].index + definitions[0][0].length;
    const bodyEnd = section.indexOf('\n### ', bodyStart);
    const definition = section.slice(bodyStart, bodyEnd < 0 ? section.length : bodyEnd).trim();
    const pointer = /^ordinary finite-subset 的 `release ⊆ main`[^\n]*`\.devpro\/agent-rules\/release-step-1-7\.md` §Step 2 補充：merge 衝突處理原則「不變式」；MUST 讀取該 rule owner[^\n]*不另持規範正文。$/m;
    assert.equal(definition.split('\n').filter(line => pointer.test(line)).length, 1, 'definition must have one authoritative invariant pointer');
    assert.match(definition, pointer);
    assert.doesNotMatch(definition, /可部署內容來自|可部署內容 MUST 來自|不授權未核准 release-only|topology clarification MUST NOT authorize/, 'Subset definition must not duplicate invariant body');
  }
  const input = glossary.replace(/\r\n/g, '\n');
  const mutations = [
      ['missing pointer', input.replace('`.devpro/agent-rules/release-step-1-7.md` §Step 2 補充：merge 衝突處理原則「不變式」', ''), /^definition must have one authoritative invariant pointer/],
      ['wrong owner', input.replace('§Step 2 補充：merge 衝突處理原則「不變式」', '§Step 1'), /^definition must have one authoritative invariant pointer/],
      ['duplicate definition', input.replace('## Subset\n\n### 定義\n', '## Subset\n\n### 定義\n\n### 定義\n'), /^Subset definition must be unique/],
      ['copied former glossary body', input.replace('不另持規範正文。', 'production baseline 外可部署內容來自已 regular-merge main 的核准 whole-branch units 與核准 lane bump；不另持規範正文。'), /^Subset definition must not duplicate invariant body/],
      ['copied Step2 body', input.replace('不另持規範正文。', 'ordinary finite-subset 的非 production baseline 可部署內容 MUST 來自核准 whole-branch units（已 regular-merge main）與核准 lane bump；不另持規範正文。'), /^Subset definition must not duplicate invariant body/],
      ['copied separate paragraph', input.replace('不另持規範正文。', '不另持規範正文。\n\nordinary finite-subset 的非 production baseline 可部署內容 MUST 來自核准 whole-branch units（已 regular-merge main）與核准 lane bump。'), /^Subset definition must not duplicate invariant body/],
  ];
  for (const [name, mutated] of mutations) assert.notEqual(mutated, input, `${name} must change the input`);
  for (const [eol, raw] of [['LF', input], ['CRLF', input.replace(/\n/g, '\r\n')]]) {
    assertDefinitionPointer(raw);
    for (const [name, mutated, message] of mutations) {
      const encodedMutation = eol === 'CRLF' ? mutated.replace(/\n/g, '\r\n') : mutated;
      assert.throws(() => assertDefinitionPointer(encodedMutation), { name: 'AssertionError', message }, `${eol}: ${name}`);
    }
  }
  // A counterexample is legitimate: only the Subset definition is pointer-only.
  assertDefinitionPointer(`${glossary}\n## Example\nproduction baseline 外可部署內容來自核准單位。\n`);
  const canonical = readFileSync(repoPath('openspec/specs/openspec-flow/spec.md'), 'utf8').replace(/\r\n/g, '\n');
  const owners = [...canonical.matchAll(/^### Requirement: Release Subset Of Main Invariant$/gm)];
  assert.equal(owners.length, 1, 'content-provenance owner must be unique');
  const start = owners[0].index;
  const end = canonical.indexOf('\n### Requirement: ', start + owners[0][0].length);
  const invariant = canonical.slice(start, end < 0 ? canonical.length : end);
  assert.match(invariant, /^For ordinary finite-subset releases,[^\n]*approved content provenance[^\n]*MUST come from approved whole-branch units regular-merged into main[^\n]*lawful release-local assembly merge MUST NOT be rejected solely[^\n]*topology clarification MUST NOT authorize unapproved release-only content/m);
  assert.match(invariant, /^Only these additional[^\n]*including single-round[^\n]*retain the existing structured-proof topology exception without acquiring a new parallel merge-context prerequisite/m);
  assert.doesNotMatch(glossary, /release 上每個 commit 必須可在 `main` 歷史追溯/);
  assert.match(VERIFICATION, /Content\/domain[^\n]*MUST[^\n]*ancestry[^\n]*MUST NOT[^\n]*功能/);
});


test('(h) Subset counterexample rejects conflict-resolution content, not lawful merge OID absence', () => {
  const glossary = readFileSync(repoPath('.devpro/agent-rules/branch-terminology-glossary.md'), 'utf8');
  const subset = glossary.match(/^## Subset[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1];
  assert.ok(subset, 'Subset section must exist');
  const pattern = /^直接在 `release\/\*` commit 解衝突[^\n]*MUST NOT[^\n]*核准來源[^\n]*content provenance[^\n]*merge OID[^\n]*不是/m;
  assert.equal(subset.split('\n').filter(line => pattern.test(line)).length, 1, 'counterexample guard must have one operative supplier');
  assert.match(subset, pattern);
  assert.doesNotMatch(subset, /會產生 main 歷史中不存在的 commit/);
  assert.match(subset, /release-step-1-7\.md[^\n]*Step 2[^\n]*不變式[^\n]*conflict abort/);
  assert.match(subset, /release-verification-commands\.md[^\n]*structured approved-subset evidence[^\n]*content provenance/);
  const mutated = subset.split('\n').filter(line => !pattern.test(line)).join('\n');
  assert.doesNotMatch(mutated, pattern);
});
