/**
 * structural-backstop-meta-grep.test.mjs
 *
 * Locks the accident-prevention backstop carrier meta-rule across three files.
 *
 * Root cause this guards: agents repeatedly did unauthorized destructive cleanup
 * (post-merge `git branch -d` + `git worktree remove` on a branch merged to main
 * but not shipped to PROD). Behavioral text was fixed N times and kept failing
 * because the error happens in a blind spot. The only validated-effective carrier
 * is a MECHANICAL gate built on a STRUCTURAL signal — and the wrong carrier
 * (PreToolUse command-intent regex, Gate 2g/11) was retired for monolith debt and
 * locked out by regression 450e1c2; remote delete moved to git-native pre-push
 * (49c7e62b). This test pins the meta-rule so it cannot silently weaken back into
 * "just add a regex gate" or pretend a mechanical backstop exists for local delete.
 *
 * Invariants locked:
 *   1. design-core.md §7  — structural-signal MUST / command-intent regex MUST NOT
 *                           + retired-gate "2g/11" codename (NON-citation form, so
 *                             rule-hook-cite-validity stays green) + 450e1c2 /
 *                             49c7e62b / pre-push anchors + 維護黑洞 + 提案前自問
 *   2. git-branch-hygiene.md — local branch -d/-D + worktree remove 無 git-native
 *                           攔截點 honest gap (git 不為本地刪除跑 hook);
 *                           behavioral + 具名同意 only; 不假裝 mechanical backstop
 *   3. pre-tool-mechanical-gates/spec.md — cross-cut Requirement title
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
function readRule(rel) {
  return readFileSync(repoPath(rel), "utf8");
}

function readFirst(paths) {
  for (const rel of paths) {
    const full = repoPath(rel);
    if (existsSync(full)) return readFileSync(full, "utf8");
  }
  throw new Error(`none of the candidate files exist: ${paths.join(", ")}`);
}

// Slice a markdown section by its heading until the next heading at the same-or-higher level.
function sliceSection(content, headingStartsWith) {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.startsWith(headingStartsWith));
  if (start === -1) return null;
  const startLevel = (lines[start].match(/^#+/) || ["#"])[0].length;
  const end = lines.findIndex((l, i) => {
    if (i <= start) return false;
    const m = l.match(/^(#+)\s/);
    return m && m[1].length <= startLevel;
  });
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

// ── 1. design-core.md §7 ──────────────────────────────────────────────────────
const designCore = readRule(".devpro/agent-rules/design-core.md");
const s7 = sliceSection(designCore, "### 7. Accident-Prevention Backstop Carrier");
const osExecutableSection = sliceSection(designCore, "### 9. OS-Level Executable Contract");

test("design-core.md §7 Accident-Prevention Backstop Carrier 段 存在", () => {
  assert.ok(
    s7,
    "找不到「### 7. Accident-Prevention Backstop Carrier」heading — meta-rule scaffold 已被移除",
  );
});

const S7_REQUIRED = [
  "結構化訊號",
  "PreToolUse",
  "command-intent",
  "MUST NOT",
  // Exact literal, NOT bare "MUST": bare "MUST" is a substring of "MUST NOT" and
  // of 4 other occurrences, so it would pass vacuously even if the positive bullet
  // were deleted. Pin the structural-signal positive obligation to its actual bullet.
  "**MUST**：建在結構化訊號",
  "2g/11", // retired-gate codename WITHOUT the live `Gate <id>` citation form
  "450e1c2",
  "49c7e62b",
  "pre-push",
  "維護黑洞",
  "結構化訊號還是 intent 猜測", // 提案前自問 SSOT phrasing
  "git-branch-hygiene.md", // cross-ref to local-delete honest gap
];

for (const phrase of S7_REQUIRED) {
  test(`design-core.md §7 必含 "${phrase}"`, () => {
    assert.ok(
      s7.includes(phrase),
      `meta-rule 退化：「${phrase}」 missing — accident-prevention carrier 不變量受損（structural-signal MUST / command-intent regex MUST NOT / Gate 2g·450e1c2·49c7e62b 錨點 / 提案前自問）。改規則文字前須同步更新本測試 phrase list`,
    );
  });
}

const S7_FORBIDDEN = [
  "改用 PreToolUse regex", // 不得回退成 intent-guessing carrier
  "command-intent regex 可作 backstop",
  // The retired gates are NOT in any hook; citing them in the live `Gate <id>`
  // form would break rule-hook-cite-validity.test.mjs (Direction A). The codename
  // MUST stay in the non-citation "2g/11" form. This guard pins that constraint.
  "Gate 2g",
  "Gate 11",
];

for (const phrase of S7_FORBIDDEN) {
  test(`design-core.md §7 禁含 "${phrase}"`, () => {
    assert.ok(
      !s7.includes(phrase),
      `meta-rule 反向退化：「${phrase}」 出現於 §7 — 該 phrase 等於把 carrier 退回 command-intent 猜測，違反退役錨點 450e1c2`,
    );
  });
}

test("design-core.md OS-level executable contract 段 存在", () => {
  assert.ok(
    osExecutableSection,
    "找不到「### 9. OS-Level Executable Contract」heading — source-managed script/hook 的 OS-level 可執行契約未被規範化",
  );
});

for (const phrase of [
  "OS-level executable contract",
  "Windows",
  "Git for Windows",
  "extensionless",
  "pre-push.mjs",
  "single source of truth",
  "line ending",
]) {
  test(`design-core.md OS-level executable contract 必含 "${phrase}"`, () => {
    assert.ok(
      osExecutableSection.includes(phrase),
      `OS-level executable contract 退化：「${phrase}」 missing — Git/runtime 入口必須同時滿足 OS 可執行與 implementation SSOT`,
    );
  });
}

// Lock the OS-level pre-push entrypoint contract on the CANONICAL promoted spec,
// NOT on the change-folder delta. The delta lives at
// openspec/changes/<name>/specs/... only while the change is active; once the
// change is archived (openspec archive), that path GOES AWAY and the requirement
// is promoted into openspec/specs/<cap>/spec.md. Pinning this guard to the active
// delta path rotted it into a false green: PR #1542 shipped without archiving, so
// the active folder lingered and this test "happened to" stay green; the F0.1
// recovery archive (PR #1615) removed the folder and exposed the ENOENT. Canonical
// is the durable SSOT (same convention as the pre-tool-mechanical-gates lock below),
// so it also catches a future promote that drops any of these phrases.
test("branch-hygiene-tooling canonical spec locks OS-level pre-push entrypoint contract", () => {
  const spec = readRule("openspec/specs/branch-hygiene-tooling/spec.md");
  for (const phrase of [
    "Git Hook Entrypoints Are OS-Level Portable",
    ".devpro/scripts/hooks-git/pre-push",
    ".devpro/scripts/hooks-git/pre-push.mjs",
    "extensioned implementation file",
    "extensionless",
    "wrapper",
    "eol=lf",
  ]) {
    assert.ok(spec.includes(phrase), `branch-hygiene canonical spec missing "${phrase}"`);
  }
  assert.equal(
    spec.includes("adjacent `.js` implementation file"),
    false,
    "canonical spec must not still require adjacent `.js` after the pre-push.mjs rename",
  );
});

// ── 2. git-branch-hygiene.md local-delete honest gap ─────────────────────────
const hygiene = readRule(".devpro/agent-rules/git-branch-hygiene.md");
const gapSection = sliceSection(hygiene, "### Local Delete 無 Git-Native 攔截點");

test("git-branch-hygiene.md Local Delete 無 Git-Native 攔截點 段 存在", () => {
  assert.ok(
    gapSection,
    "找不到「### Local Delete 無 Git-Native 攔截點」heading — local-delete 誠實 gap 記述已被移除",
  );
});

const GAP_REQUIRED = [
  "git worktree remove",
  "branch -d", // covers `git branch -d/-D`
  "無 git-native", // 無 git-native 攔截點
  "不為本地刪除跑", // git 不為本地刪除跑任何 hook
  "具名同意", // 具名同意才刪 (L85 already requires)
  "不假裝", // 不假裝有 mechanical backstop
  "450e1c2", // anchor: 不得用 PreToolUse regex 補洞
];

for (const phrase of GAP_REQUIRED) {
  test(`git-branch-hygiene.md local-delete gap 段 必含 "${phrase}"`, () => {
    assert.ok(
      gapSection.includes(phrase),
      `local-delete 誠實 gap 退化：「${phrase}」 missing — 此段必須誠實記載 local delete 無 git-native hook 點、只能 behavioral + 具名同意、不假裝 mechanical backstop`,
    );
  });
}

const GAP_FORBIDDEN = [
  "hook 機械擋住本地刪除", // 禁止假裝有 mechanical backstop
  "PreToolUse parser 擋住本地刪除",
  // Same live-citation guard as §7: retired gates must not appear in the
  // `Gate <id>` citation form anywhere in the agent-rules corpus.
  "Gate 2g",
  "Gate 11",
];

for (const phrase of GAP_FORBIDDEN) {
  test(`git-branch-hygiene.md local-delete gap 段 禁含 "${phrase}"`, () => {
    assert.ok(
      !gapSection.includes(phrase),
      `over-promise 退化：「${phrase}」 出現於段內 — 等於假裝有不存在的 mechanical backstop（git 不為本地刪除跑 hook）`,
    );
  });
}

// ── 3. pre-tool-mechanical-gates spec cross-cut Requirement ───────────────────
const spec = readRule("openspec/specs/pre-tool-mechanical-gates/spec.md");

test("spec 含 cross-cut Requirement title (structural signals, not command-intent)", () => {
  assert.ok(
    spec.includes(
      "### Requirement: Accident-Prevention Backstops Use Structural Signals, Not Command-Intent Parsing",
    ),
    "pre-tool-mechanical-gates spec 缺 cross-cut Requirement — meta-rule 的 capability invariant 已被移除",
  );
});

const SPEC_REQUIRED = [
  "structural signal", // structural-signal carrier obligation
  "MUST NOT", // command-intent parsing prohibition
  "450e1c2",
  "49c7e62b",
  "no git-native interception point", // local-delete honest gap in spec
];

for (const phrase of SPEC_REQUIRED) {
  test(`spec Requirement 段 必含 "${phrase}"`, () => {
    assert.ok(
      spec.includes(phrase),
      `spec invariant 退化：「${phrase}」 missing — cross-cut backstop carrier requirement 受損`,
    );
  });
}
