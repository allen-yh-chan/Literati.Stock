/**
 * strengthen-second-review-audit-convergence-grep.test.mjs
 *
 * Locks the audit-only second-review convergence anchors landed by
 * `strengthen-second-review-audit-convergence` (design.md D3 "anchor 字面與
 * test 形狀") across the four carriers that materialize the caller-side
 * round-cap / stop-condition / ledger / failure-classification contract:
 *   - .devpro/agent-skills/devpro-workflows/change/references/full-analysis-and-design.md   (orchestrator, R1/R3/R4/R5; moved out of change/SKILL.md)
 *   - .devpro/agent-rules/openspec-step-1-to-9.md                (R1/R2 mirror)
 *   - .devpro/agent-skills/devpro-reviews/second-review/SKILL.md (executor, R2/R3/R5/R7)
 *   - .devpro/agent-rules/second-review-control-evidence.md      (R6 terminal classification)
 *
 * Test-shape rules applied (design.md D3, tasks.md T6):
 *   1. `audit round cap 6` — bidirectional set equality over the exact 3-file
 *      projection (scope limited to .devpro/agent-rules/** + .devpro/agent-skills/**)
 *      + same-physical-line compound regex binding the cap literal to the
 *      "停下交回使用者" polarity token (design D3 point 1: MUST NOT decouple
 *      into two independent includes()).
 *   2. `audit findings ledger` — bidirectional set equality over the exact
 *      2-file projection (structural-existence axis, no polarity binding).
 *   3. `host_session_limit_stop` — same-line compound regex covering both
 *      "session-limit" and "usage-limit" wording plus the forbidden-retry
 *      phrase "等 reset 後自動續跑" (R6, Important-2).
 *   4. R2 three-element same-line compound regex (`Critical = 0` / 相對
 *      ledger 無新增 finding / Important 不強制清零) independently asserted
 *      per carrier (Important-2).
 *   5. FR-7 structural assertion: the surface-neutral 窄掃義務 clause's
 *      nearest enclosing heading MUST be exactly `### audit-only`, and the
 *      clause line itself MUST NOT name any single `target` enum value — the
 *      negative list MUST cover all 5 enum values, not 4 (design D3 point 8;
 *      a literal-existence check on "local diff" would be a no-op because it
 *      already matched pre-change at second-review/SKILL.md:3,131).
 *   6. Bidirectional negation: `audit round cap 6` MUST NOT leak into
 *      `ambiguity-scoring.md`; `working cap 3` / `absolute max 4` (that leaf's
 *      own clarification-round cap literals) MUST NOT leak into the four
 *      carriers landed by this change (C-3 / RK-4 anti-collision).
 *   7. R5 same-line compound regex binding the narrow-scan literal "只掃改動
 *      carrier" to its MUST-NOT-full-surface-rereview polarity token, per
 *      carrier, over the exact 2-carrier projection where the clause
 *      currently lands (`change/references/full-analysis-and-design.md`, `second-review/SKILL.md`).
 *      `openspec-step-1-to-9.md` mirrors only the round-cap/stop-condition
 *      outcome contract (points 1/4), not R5's scan-construction mechanics,
 *      so it is deliberately excluded from this projection. The two
 *      carriers phrase the forbidding clause differently ("MUST NOT 對全
 *      surface 重新審查" vs "MUST NOT 全 surface 重審"), so the compound
 *      keys on the shared "MUST NOT" ... "全 surface" sub-sequence rather
 *      than either carrier's full clause string (proposal.md R8, Important-2).
 *   8. Every assertion below keys on the complete literal (never the shared
 *      substring `cap 3`) and never uses compensating alternation (`A|B`
 *      passing on either side alone).
 *
 * Mutation audit (design D3 point 5 / tasks.md T6 point 8) is a verification
 * method exercised once against the real carriers during authoring — not a
 * permanent artifact of this file. See the implementation report for the
 * per-point delete → red → restore → green evidence log.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";


// The orchestrator round-cap / ledger / narrow-scan clauses moved from change/SKILL.md into the
// full-rigor reference (SKILL.md keeps a pointer line). CHANGE_SKILL names the physical carrier
// of those clauses; CHANGE_SKILL_MD is only used where absence must also cover SKILL.md.
const CHANGE_SKILL = ".devpro/agent-skills/devpro-workflows/change/references/full-analysis-and-design.md";
const CHANGE_SKILL_MD = ".devpro/agent-skills/devpro-workflows/change/SKILL.md";
const STEP19 = ".devpro/agent-rules/openspec-step-1-to-9.md";
const SECOND_REVIEW_SKILL = ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md";
const CONTROL_EVIDENCE = ".devpro/agent-rules/second-review-control-evidence.md";
const AMBIGUITY_SCORING = ".devpro/agent-rules/ambiguity-scoring.md";

const ROUND_CAP_CARRIERS = [CHANGE_SKILL, STEP19, SECOND_REVIEW_SKILL];
const LEDGER_CARRIERS = [CHANGE_SKILL, SECOND_REVIEW_SKILL];
const FOUR_NEW_CARRIERS = [CHANGE_SKILL, STEP19, SECOND_REVIEW_SKILL, CONTROL_EVIDENCE];
// Same file pair as LEDGER_CARRIERS by coincidence — named separately because
// R5's narrow-scan clause is a distinct concern from the findings-ledger
// literal Point 2 asserts. openspec-step-1-to-9.md deliberately has no R5
// copy (see docblock point 7).
const NARROW_SCAN_CARRIERS = [CHANGE_SKILL, SECOND_REVIEW_SKILL];


// Recursive file walker restricted to the two roots design.md D3 point 3
// names as the set-equality scope — deliberately excludes openspec/** so an
// archive-phase path flip on the spec side (delta vs canonical) can never
// perturb this collection.
function listAllFiles(rootRel) {
  const rootAbs = repoPath(rootRel);
  const out = [];
  function walk(dirAbs) {
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        out.push(path.relative(REPO_ROOT, abs).split(path.sep).join("/"));
      }
    }
  }
  walk(rootAbs);
  return out;
}

const SCOPE_ROOTS = [".devpro/agent-rules", ".devpro/agent-skills"];
const SCOPE_FILES = SCOPE_ROOTS.flatMap((root) => listAllFiles(root));

function literalHitSet(literal) {
  return SCOPE_FILES.filter((relPath) => read(relPath).includes(literal)).sort();
}

// Same-physical-line compound binding: `[^\n]*` cannot cross a newline, so a
// RegExp built this way only matches when every token co-occurs on one
// physical line — the design D3 point 1 requirement (MUST NOT decouple into
// independent whole-file includes() calls that could be satisfied by tokens
// on unrelated lines).
function sameLineAll(tokens) {
  return new RegExp(tokens.join("[^\\n]*"));
}

// --- Point 1: `audit round cap 6` — 3-element bidirectional set equality ---
test("audit round cap 6 — 命中檔案集合雙向等於 3 元素預期集合（scope: agent-rules + agent-skills）", () => {
  const expected = [...ROUND_CAP_CARRIERS].sort();
  assert.deepEqual(literalHitSet("audit round cap 6"), expected);
});

for (const carrier of ROUND_CAP_CARRIERS) {
  test(`audit round cap 6 — ${carrier} 同一實體行含「停下交回使用者」polarity token`, () => {
    const compound = sameLineAll(["audit round cap 6", "停下交回使用者"]);
    assert.match(read(carrier), compound);
  });
}

// --- Point 2: `audit findings ledger` — 2-element bidirectional set equality ---
test("audit findings ledger — 命中檔案集合雙向等於 2 元素預期集合（scope: agent-rules + agent-skills）", () => {
  const expected = [...LEDGER_CARRIERS].sort();
  assert.deepEqual(literalHitSet("audit findings ledger"), expected);
});

// --- Point 3: `host_session_limit_stop` — same-line dual-wording + mandatory stop-and-report action + forbidden-retry compound ---
test("host_session_limit_stop — 同一實體行同時涵蓋 session-limit／usage-limit、強制停止上報動作「MUST即刻停止並上報使用者」與禁重試片語「等 reset 後自動續跑」", () => {
  const compound = sameLineAll([
    "host_session_limit_stop",
    "session-limit",
    "usage-limit",
    "MUST即刻停止並上報使用者",
    "等 reset 後自動續跑",
  ]);
  assert.match(read(CONTROL_EVIDENCE), compound);
});

// --- Point 4: R2 三要素同行複合斷言，於 3 個 carrier 各自命中 ---
for (const carrier of ROUND_CAP_CARRIERS) {
  test(`R2 三要素同行複合斷言 — ${carrier}（Critical = 0 ／ 相對 ledger 無新增 finding ／ Important 不強制清零）`, () => {
    const compound = sameLineAll(["Critical = 0", "相對 ledger 無新增 finding", "Important 不強制清零"]);
    assert.match(read(carrier), compound);
  });
}

// --- Point 7: R5 窄掃同行複合斷言，於 2 個承載 carrier 各自命中（Important-2） ---
for (const carrier of NARROW_SCAN_CARRIERS) {
  test(`R5 窄掃同行複合斷言 — ${carrier}（只掃改動 carrier ／ MUST NOT ... 全 surface 重審／重新審查）`, () => {
    const compound = sameLineAll(["只掃改動 carrier", "MUST NOT", "全 surface"]);
    assert.match(read(carrier), compound);
  });
}

// --- Point 5: FR-7 結構斷言（surface-neutral 窄掃義務 clause under ### audit-only） ---
test("FR-7 結構斷言 — 窄掃義務 clause 的最近上層 heading 恰為 ### audit-only，且條款行不含任一單一 target 名（負向清單涵蓋全 5 值）", () => {
  const lines = read(SECOND_REVIEW_SKILL).split("\n");
  const headingIdx = lines.findIndex((line) => line.trim() === "### audit-only");
  assert.notEqual(headingIdx, -1, "`### audit-only` heading not found in second-review/SKILL.md");

  let nextHeadingIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i])) {
      nextHeadingIdx = i;
      break;
    }
  }
  const sectionLines = lines.slice(headingIdx + 1, nextHeadingIdx);

  const clauseMarker = "窄掃義務（caller obligation，涵蓋本節管轄之全部 target 類型）";
  const clauseLine = sectionLines.find((line) => line.includes(clauseMarker));
  assert.ok(
    clauseLine,
    "窄掃義務 clause not found nested directly under the `### audit-only` heading section",
  );

  // MUST cover all 5 target enum values, not 4 — omitting `bounded artifact`
  // would let a clause that names it escape detection (design D3 point 8).
  const TARGET_ENUM = ["design", "local diff", "spec", "rule change", "bounded artifact"];
  assert.equal(TARGET_ENUM.length, 5, "target enum negative list MUST enumerate all 5 values");
  for (const targetName of TARGET_ENUM) {
    assert.ok(
      !clauseLine.includes(targetName),
      `FR-7 clause line MUST NOT name a single target: "${targetName}"`,
    );
  }
});

// --- Point 6: 雙向否定斷言（C-3 / RK-4 反撞名） ---
test("audit round cap 6 — MUST NOT 出現在 ambiguity-scoring.md", () => {
  assert.ok(!read(AMBIGUITY_SCORING).includes("audit round cap 6"));
});

test("working cap 3 / absolute max 4 — MUST NOT 出現在本 change 新增的四個 carrier 檔案", () => {
  // change/SKILL.md joins the absence scan because the orchestrator text now sits in the reference.
  for (const carrier of [...FOUR_NEW_CARRIERS, CHANGE_SKILL_MD]) {
    const body = read(carrier);
    assert.ok(!body.includes("working cap 3"), `${carrier} MUST NOT contain "working cap 3"`);
    assert.ok(!body.includes("absolute max 4"), `${carrier} MUST NOT contain "absolute max 4"`);
  }
});

// --- Point 8: ledger 自由文字欄位 redaction 範圍同行複合斷言（negative case：窄化回 description-only 會使此測試變紅）---
test("ledger free-text field redaction — 同一實體行同時涵蓋 carrier／description／disposition 三欄、MUST NOT 與絕對使用者路徑 leak-class token", () => {
  const compound = sameLineAll(["`carrier`／`description`／`disposition`", "MUST NOT", "絕對使用者路徑"]);
  assert.match(read(SECOND_REVIEW_SKILL), compound);
});
