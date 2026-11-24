import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
// Locks the session-pending lifecycle refactor+strengthen (PR
// strengthen-session-pending-claim-and-path-contract):
//   (1) two gaps surfaced by user questioning — no claim/in-progress marker (parallel
//       sessions grab the same item) + no single-path contract (AI in a linked worktree
//       using a relative `notes/session-pending.md` decouples; the dir is gitignored,
//       not checked out). Fix is rule-only (reuses repo-state-identity common-dir
//       resolution + git branch mutual-exclusion).
//   (2) the +2 rules pushed rule-design-principles.md ([core] hot-path) past its <6000
//       token headroom guard, so the session-pending operational lifecycle was extracted
//       to a new leaf `session-pending-lifecycle.md` (guard intent: saturate → extract,
//       not bump cap). These anchors live in the LEAF now; core keeps only a cross-ref.

const leaf = readFileSync(
  repoPath(".devpro/agent-rules/session-pending-lifecycle.md"),
  "utf8",
);
const rdp = readFileSync(
  repoPath(".devpro/agent-rules/rule-design-principles.md"),
  "utf8",
);
const sessionRecap = readFileSync(
  repoPath(".devpro/agent-rules/session-recap.md"),
  "utf8",
);
// The capsule template that actually carried the equivalent-heading allowance.
// `.claude/skills/devpro` is a symlink to this path, so this is the single
// real carrier, not one of two copies.
const clarifySkill = readFileSync(
  repoPath(".devpro/agent-skills/devpro-workflows/clarify/SKILL.md"),
  "utf8",
);

// Phrases matched as literal substrings (some contain regex metachars), escape first.
function literalRe(s) {
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

test("leaf defines single main-checkout-root path contract", () => {
  for (const phrase of [
    "單一路徑契約",
    "<main-checkout-root>/notes/session-pending.md",
    "git rev-parse --git-common-dir",
    "repo-state-identity.mjs",
    "禁用** worktree-relative",
    "worktree-local 幽靈檔",
  ]) {
    assert.match(leaf, literalRe(phrase));
  }
});

test("leaf defines event-based claim with no TTL", () => {
  for (const phrase of [
    "抽走處理要 claim",
    "claimed: <change-name>",
    "event-based 失效，no TTL",
    "不綁時間",
    "isConfirmedNonexistentBranch",
    "下個讀到的 session **清掉該 claim 重新開做",
    "git 同名分支互斥本身即第二層 claim",
  ]) {
    assert.match(leaf, literalRe(phrase));
  }
});

test("leaf defines conservative stale-lock takeover for claim helper", () => {
  for (const phrase of [
    "pid / timestamp metadata",
    "lock clearly stale",
    "pid 已不存在",
    "stale age",
    "pid live",
    "metadata 不可解析",
    "age 未達門檻",
    "could not acquire lock",
    "不得移除不確定 lock",
    "live / unproven lock 仍 fail-visible",
  ]) {
    assert.match(leaf, literalRe(phrase));
  }
});

test("leaf keeps valid in-flight claims out of default next-action options", () => {
  for (const phrase of [
    "in-flight handoff / next-action discipline",
    "預設只能回報為 `in-flight` / `FYI` / blocker",
    "不得**放進推薦 next-action、選項 1",
    "使用者明確要求接手該具名 item",
    "已 claimed 且有效的 item 要另列狀態",
    "不得與可抓的新待辦混排",
  ]) {
    assert.match(leaf, literalRe(phrase));
  }
});

test("leaf requires same-change handoff/status updates to stay under the original claimed item", () => {
  for (const phrase of [
    "不得為同一 change 的 PR / blocker / handoff / status 新增 sibling top-level pending item",
    "child handoff/status capsule",
    "原 claimed item",
  ]) {
    assert.match(leaf, literalRe(phrase));
  }
});

test("leaf clarifies '不留標記' scope (done-marker only, not claim)", () => {
  // The 不留標記 rule must explicitly scope itself to completion markers and
  // exempt the in-progress claim marker — otherwise claim contradicts it.
  // literalRe escapes the markdown `**` (raw `/不**.../` is an invalid regex).
  for (const phrase of [
    "只禁「已完成」軌跡標記",
    "不**禁上節的「處理中」",
    "並發協調 ≠ 完成軌跡",
  ]) {
    assert.match(leaf, literalRe(phrase));
  }
});

test("core rule-design-principles keeps only a cross-ref to the leaf (detail extracted)", () => {
  // Positive: the cross-ref pointer must exist in core.
  assert.match(
    rdp,
    literalRe("session-pending operational lifecycle"),
    "core must retain a cross-ref bullet pointing to the leaf",
  );
  assert.match(rdp, literalRe("session-pending-lifecycle.md"));
  // Negative: the moved operational detail must NOT remain in core (proves the
  // extraction actually happened — guards against accidental duplication that
  // would re-saturate the hot-path core file).
  assert.doesNotMatch(
    rdp,
    literalRe("claimed: <change-name>"),
    "claim detail must live in the leaf, not be duplicated in core",
  );
  assert.doesNotMatch(
    rdp,
    literalRe("worktree-local 幽靈檔"),
    "path-contract detail must live in the leaf, not be duplicated in core",
  );
  // The 三層 Workflow Persistence Layers concept stays in core (widely cited SSOT).
  assert.match(rdp, literalRe("Workflow Persistence Layers"));
});

test("session-recap mirrors leaf SSOT for path contract + claim (no detail dup)", () => {
  for (const phrase of [
    "路徑契約 + claim",
    "SSOT：`session-pending-lifecycle.md`",
    "claimed: <change-name>",
    "event-based，no TTL",
    "協調 ≠ 完成軌跡",
  ]) {
    assert.match(sessionRecap, literalRe(phrase));
  }
});

// The item-shape convention this leaf prescribes is carried in prose, not in a
// fenced template, so `session-pending-opener-depiction.test.mjs` (which only
// inspects depictions inside fences and code spans) cannot see it. Without the
// anchors below, one of the three carriers the spec delta names as a MUST would
// have no runnable check at all — the same "prose claim, no mechanical carrier"
// defect that cost this change two review rounds.
test("session-pending-lifecycle.md carries the H2 opener convention and its runnable checks", () => {
  for (const phrase of [
    // The convention itself, and the reason a column-0 bullet is not a mild
    // style preference: the item stops being independently claimable.
    "新條目 MUST 以 `## ` H2 開頭",
    "不是獨立可 claim 的單位",
    // The scope boundary that keeps a legacy-only consumer file working.
    "整份檔案都還沒採用 `## `",
    // The runnable whole-file check, named so a reader can verify a file
    // without reconstructing the criterion.
    "session-pending-claim.mjs check-shape",
    // The reverse verb, so a claim is not a one-way door.
    "release --item <N> --change <name>",
  ]) {
    assert.match(leaf, literalRe(phrase));
  }

  // Negative: the relaxation clause must not come back. It has to be read from
  // the file that actually carried it — `clarify/SKILL.md:54` said "等價
  // heading 可", and that allowance is what let the capsule template keep a
  // column-0 opener while still reading as compliant. Asserting its absence
  // from this leaf, which never contained the phrase, is a guard that cannot
  // fail on the regression it names (r3 finding F-SPI-13).
  assert.doesNotMatch(
    clarifySkill,
    literalRe("等價 heading 可"),
    "clarify/SKILL.md must not relax the H2 opener into an equivalent-heading allowance",
  );
  // Positive counterpart, so the pair cannot both pass on an empty read.
  assert.match(
    clarifySkill,
    literalRe("opener **MUST** 是 `## ` H2"),
    "clarify/SKILL.md must state the H2 opener as a MUST",
  );
});

test("derived carriers keep both Gate NS scope preconditions, not a bare claim", () => {
  // r3 finding F-SPI-15: both files had flattened the gate into an
  // unconditional "and Gate NS blocks it". The gate has two preconditions —
  // the file must already carry a `## ` (session-pending-blocks.mjs:249
  // returns empty otherwise), and only bullets this payload introduces are
  // blocked. The leaf states both; the derived carriers had dropped them, and
  // these two are exactly the files that sync into consumer repos where
  // legacy-only is the expected starting state. Restoring the wording without
  // a guard would repeat F-SPI-13's shape: a fix with nothing holding it.
  for (const [label, carrier] of [
    ["session-recap.md", sessionRecap],
    ["clarify/SKILL.md", clarifySkill],
  ]) {
    assert.match(
      carrier,
      literalRe("若該檔已出現任一 `## `"),
      `${label} must condition Gate NS on the file having adopted the H2 convention`,
    );
    assert.match(
      carrier,
      literalRe("本次新引入的頂格 bullet"),
      `${label} must scope Gate NS to newly introduced bullets`,
    );
    assert.match(
      carrier,
      literalRe("legacy-only 檔不在"),
      `${label} must state that a legacy-only file is outside the gate's reach`,
    );
  }
});
