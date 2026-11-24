// Regression guard for the 6 rule-consistency conflicts fixed in
// change `fix-rule-consistency-conflicts`. Each block pins the corrected wording
// (positive) and forbids the stale/contradictory wording (negative) so the
// conflicts cannot silently re-drift. These were previously unguarded — which is
// exactly why README count / AGENTS cap unit / anchor base table drifted.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { sourcePath } from "./lib/source-root.mjs";
import { readSourceFile as read } from "./lib/read.mjs";



const ANCHOR = ".devpro/agent-rules/git-branch-naming-and-anchor.md";
// On-demand leaves split out of ANCHOR; negative scans over ANCHOR cover them too.
const ANCHOR_LEAVES = [
  ".devpro/agent-rules/git-branch-no-tag-ancestry-evidence.md",
  ".devpro/agent-rules/git-branch-production-ancestry-repair.md",
];

// #4 — destructive cleanup command must carry the consent guard.
test("anchor cleanup command carries the user-consent guard", () => {
  const md = read(ANCHOR);
  // locate the 清理 line
  const line = md.split("\n").find((l) => l.startsWith("**清理**"));
  assert.ok(line, "must find the **清理** cleanup line in anchor doc");
  assert.match(line, /使用者(明示)?同意/, "cleanup must require explicit user consent");
  assert.match(line, /prune-merged-local\.mjs/, "cleanup must route to the canonical entrypoint");
  // negative: must not present a copy-pasteable destructive one-liner. A runnable
  // `git branch -d … && git worktree remove …` chain in the rule body invites an
  // agent to partial-extract and execute it, bypassing the consent step.
  assert.doesNotMatch(
    line,
    /git (branch -d|worktree remove)[^\n]*&&[^\n]*git (branch -d|worktree remove)/,
    "cleanup line must not contain a runnable &&-chained destructive one-liner"
  );
});

// #2 — rules-branch base table cell must fail closed on production/main divergence.
test("rules-branch base row requires exact-tag ancestry and classification before repair", () => {
  const md = read(ANCHOR);
  const row = md.split("\n").find((l) => l.includes("| 規範同步 |"));
  assert.ok(row, "must find the 規範同步 (rules) table row");
  assert.match(
    row,
    /exact production tag.*candidate `origin\/main` ancestor/,
    "rules base row must require the exact production tag to be a candidate-main ancestor"
  );
  assert.match(row, /divergence.*reconciliation classification/, "rules base row must route divergence to classification first");
  assert.match(
    row,
    /分類完成前不得宣告 bounded repair/,
    "rules base row must not declare bounded repair before classification",
  );
  assert.match(
    row,
    /禁止用 `origin\/main` fallback/,
    "rules base row must forbid origin/main fallback for an ordinary sync"
  );
  // Negative with teeth against the real legacy wording from the table row.
  for (const text of [md, ...ANCHOR_LEAVES.map((rel) => read(rel))]) {
    assert.doesNotMatch(
      text,
      /isMainAncestor=false[^\n]*用 `origin\/main`/,
      "rules base contract must not restore the legacy isMainAncestor=false → origin/main fallback"
    );
  }
});

test("promotable branch startup ancestry gate classifies before repair", () => {
  const md = read(ANCHOR);
  const step = md.split("\n").find((l) => l.startsWith("3. **新建可促進單位分支前先驗 production ancestry**"));
  assert.ok(step, "must find the startup production ancestry gate step");
  assert.match(step, /--require-main-ancestor/, "startup gate must run the exact ancestry gate");
  // Densified (#1872): exit-0 no-op is implied by「非 0 才 --reconciliation-status」;
  // keep mechanical anchors that still appear on the same numbered step line.
  assert.match(step, /非 0 才 `--reconciliation-status`/, "startup gate failure must classify via reconciliation-status");
  assert.match(step, /禁 fallback `origin\/main`/, "startup gate must forbid origin/main fallback");
  assert.match(step, /pre-first-release|ancestry gate: N\/A/, "startup gate must name no-tag / pre-first-release paths");
});

// #2b — rules-flow operational guidance must not reintroduce the exact
// divergence fallback that the canonical anchor contract forbids.
test("rules-flow rejects origin/main fallback when production ancestry diverges", () => {
  const md = read(".devpro/agent-rules/rules-flow.md");
  const step4 = md.split("\n").find((line) => line.startsWith("4. Base"));

  assert.ok(step4, "must find Dedicated Rules Branch step 4");
  assert.match(step4, /\.isMainAncestor=false/, "step 4 must name the mechanical divergence signal");
  assert.match(step4, /fail closed/i, "step 4 must fail closed on production/main divergence");
  assert.match(step4, /reconciliation classification/, "step 4 must route divergence to classification first");
  assert.match(
    step4,
    /分類完成前不得宣告 bounded repair/,
    "step 4 must not declare bounded repair before classification",
  );
  assert.match(
    step4,
    /禁止用 `origin\/main` fallback/,
    "step 4 must explicitly forbid origin/main fallback",
  );

  const staleOperationalLines = md
    .split("\n")
    .filter(
      (line) =>
        /Base（default = anchor[^\n]*override → `origin\/main`/.test(line) ||
        /\.isMainAncestor=false[^\n]*必用 `origin\/main`/.test(line),
    );
  assert.deepEqual(
    staleOperationalLines,
    [],
    `rules-flow must remove the legacy operational origin/main override:\n${staleOperationalLines.join("\n")}`,
  );

  const staleRationaleLines = md
    .split("\n")
    .filter(
      (line) =>
        /何時必須 override 到 `origin\/main`/.test(line) ||
        /step 4[^\n]*直接判用 `origin\/main`/.test(line),
    );
  assert.deepEqual(
    staleRationaleLines,
    [],
    `rules-flow must remove the legacy rationale for origin/main fallback:\n${staleRationaleLines.join("\n")}`,
  );
});

// #2c — the canonical capability spec is a contract carrier too. It must not
// preserve the pre-#1663 base override after the operational rule fails closed.
test("anchor-detection canonical spec requires classification before repair instead of origin/main override", () => {
  const md = read("openspec/specs/anchor-detection/spec.md");

  assert.match(
    md,
    /Consumer rules-lane ancestry precondition/,
    "canonical anchor-detection must name the rules-lane ancestry precondition",
  );
  assert.match(
    md,
    /ordinary rules synchronization MUST fail closed and run reconciliation classification before any bounded repair branch/,
    "canonical anchor-detection must route ancestry divergence to classification before repair",
  );
  assert.match(
    md,
    /MUST NOT override the PR base to `origin\/main` to bypass the divergence/,
    "canonical anchor-detection must forbid the legacy origin/main override",
  );
  assert.doesNotMatch(
    md,
    /Consumer rules-lane PR base override|PR base MUST be `origin\/main`|Rules Branch Base Table Surfaces Origin-Main Override/,
    "canonical anchor-detection must remove the stale origin/main override contract",
  );
});

// #2d — release-rules-lane still needs one defensive note for already-existing
// main-based branches, but that note must not become ordinary routing authority.
test("release rules lane limits main-based recovery to historical branches", () => {
  const md = read(".devpro/agent-rules/release-rules-lane.md");
  const line = md
    .split("\n")
    .find((candidate) => candidate.includes("main-based rules 分支") && candidate.includes("Step 4"));

  assert.ok(line, "release rules lane must retain the main-based Step 4 defensive note");
  assert.match(
    line,
    /修復前既有／歷史.*defensive recovery/,
    "main-based Step 4 must be scoped to historical defensive recovery",
  );
  assert.match(
    line,
    /ordinary routing.*MUST fail closed.*reconciliation classification.*不得宣告 bounded repair/,
    "ordinary routing must fail closed and classify before repair",
  );
  assert.match(
    line,
    /禁止用 `origin\/main` bypass divergence/,
    "ordinary routing must not use origin/main to bypass divergence",
  );
});

// #3 — both hotfix no-tag fallback spots must be investigate-first, not flat.
test("hotfix no-tag fallback is investigate-first in both anchor spots", () => {
  const md = read(ANCHOR);
  // Prose lines that degrade the no-production-tag case to bugfix.
  // Match a line that mentions a `production-*` tag absence AND a `bugfix/` degrade.
  const degradeLines = md
    .split("\n")
    .filter((l) => /(無|若無).{0,8}`production-\*/.test(l) && /`bugfix\//.test(l));
  assert.ok(
    degradeLines.length >= 2,
    `expected >=2 hotfix no-tag degrade prose lines, found ${degradeLines.length}`
  );
  for (const l of degradeLines) {
    // each must be investigate-first (先排除 ... 才降級) AND/OR point to the authority
    assert.match(
      l,
      /先排除/,
      `hotfix degrade line must state investigate-first (先排除...才降級): ${l.slice(0, 50)}…`
    );
    assert.match(
      l,
      /release-sit-uat-pat-prod\.md/,
      `hotfix degrade line must point to authoritative rule: ${l.slice(0, 50)}…`
    );
  }
});

// #3b — the anchor-detection spec names a broader scope (routing tables, AGENTS.md;
// the former `/dp:*` command surface is abolished, per migrate-skill-architecture-to-dp-prefix).
// Across ALL those summary surfaces, any "no production tag → bugfix" line MUST
// carry an investigate-first cue (先排除) OR a pointer to the authoritative rule.
// A bare flat form would be self-contradicted by the spec.
test("no-tag→bugfix summaries carry pointer/precondition across named scope", () => {
  const scopeFiles = [
    ".devpro/agent-rules/git-branch-naming-and-anchor.md",
    ...ANCHOR_LEAVES,
    ".devpro/agent-rules/openspec-step-1-to-9.md",
    ".devpro/agent-rules/openspec-branch-routing.md",
    "AGENTS.md",
  ];
  const offenders = [];
  for (const rel of scopeFiles) {
    read(rel)
      .split("\n")
      .forEach((l, i) => {
        const isNoTagBugfix = /(無|若無)\s*tag|(無|若無).{0,8}`production-\*/.test(l) && /`?bugfix/.test(l);
        if (!isNoTagBugfix) return;
        const guarded = /先排除|release-sit-uat-pat-prod\.md/.test(l);
        if (!guarded) offenders.push(`${rel}:${i + 1}  ${l.trim().slice(0, 70)}`);
      });
  }
  assert.equal(
    offenders.length,
    0,
    `no-tag→bugfix lines must carry 先排除 or a release-sit-uat-pat-prod.md pointer:\n${offenders.join("\n")}`
  );
});

// #5 — README preflight count must match the 9-item checklist file.
test("README preflight count says 9 points, not 8", () => {
  const readme = read("README.md");
  assert.doesNotMatch(readme, /pre-flight 8 點/, "README must not say 'pre-flight 8 點'");
  assert.match(readme, /pre-flight 9 點/, "README must say 'pre-flight 9 點'");
  // cross-check: the checklist file actually has 9 numbered items
  const checklist = read(".devpro/agent-rules/preflight-checklist.md");
  const nums = [...checklist.matchAll(/^(\d+)\.\s+\*\*/gm)].map((m) => Number(m[1]));
  assert.ok(nums.includes(9), "preflight-checklist.md must contain a numbered item 9");
  assert.ok(!nums.includes(10), "preflight-checklist.md must not exceed 9 numbered items");
});

// #5b — no active scenario or README may state the pre-flight checklist as an
// "8-point" *count* (whack-a-mole guard). The checklist has 9 items. This scans
// ALL scenarios + README and catches the count forms (pre-flight 8 點 / 完整 8 點 /
// 全 8 點 / 8 點全部 / 8 點必過 / 4 點 vs 8 點) while deliberately NOT flagging
// item-index references like 「第 8 點」 or ranges like 「點 1-2」「點 5-9」.
test("no active scenario/README states pre-flight as an 8-point count", () => {
  // count-of-checklist patterns: an "8 點" that means "the whole 8-item checklist".
  const COUNT_8 = /(pre-flight\s*8\s*點|完整\s*8\s*點|全\s*8\s*點|8\s*點\s*全部|8\s*點\s*必過|vs\s*8\s*點)/;
  const scenariosDir = sourcePath("scenarios");
  const targets = [
    "README.md",
    ...readdirSync(scenariosDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => path.join("scenarios", f)),
  ];
  const offenders = [];
  for (const rel of targets) {
    const lines = read(rel).split("\n");
    lines.forEach((line, i) => {
      if (COUNT_8.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 70)}`);
    });
  }
  assert.equal(
    offenders.length,
    0,
    `pre-flight checklist is 9 items; these state an 8-point count:\n${offenders.join("\n")}`
  );
});

// #6 — AGENTS.md hard cap is expressed in bytes (10500), not a phantom 350-line cap.
// HARD cap raised 6500 → 7000 in clarify-agents-md-entry-anchors, 7000 → 7190
// in amend-output-language-zh, 7190 → 7550 in strengthen-preflight-self-check,
// 7550 → 7650 in strengthen-current-state-delta-gate, 7650 → 8750 in
// strengthen-token-waste-controls, then 8750 → 10500 in
// amend-agents-md-hard-cap (agents-md-size.test.mjs SSOT).
test("agents-md-maintenance hard cap is bytes, no 350-line hard cap", () => {
  const md = read(".devpro/agent-rules/agents-md-maintenance.md");
  assert.doesNotMatch(md, /硬上限 350 行/, "must not state a 350-line hard cap");
  assert.match(md, /硬上限 \*\*10500 bytes\*\*|硬上限 10500 bytes/, "must keep the 10500-byte hard cap");
  // the Exit Criteria size check must reference bytes
  assert.match(md, /wc -c AGENTS\.md/, "Exit Criteria must verify byte size (wc -c)");
});

// #6b — token-budget-precheck.md estimate table cap column must align with true SSOT:
// HARD cap = 10500, SOFT cap = 6500. Must NOT present 6500 as the sole HARD cap.
test("token-budget-precheck AGENTS.md cap row aligns with SSOT (HARD=10500, not 6500)", () => {
  const md = read(".devpro/agent-rules/token-budget-precheck.md");
  // Must contain 10500 as the HARD cap value
  assert.match(
    md,
    /10500/,
    "token-budget-precheck must reference 10500 (true HARD cap per agents-md-size.test.mjs)"
  );
  // Cap table row (pipe-table), not prose that may contain "over-cap" / "cap remediation"
  const agentsRow = md
    .split("\n")
    .find((l) => l.includes("|") && l.includes("AGENTS.md") && /10500|HARD/.test(l));
  assert.ok(agentsRow, "must find an AGENTS.md cap table row in token-budget-precheck.md");
  assert.match(
    agentsRow,
    /10500/,
    `AGENTS.md cap row must contain 10500 (HARD cap), got: ${agentsRow}`
  );
  assert.doesNotMatch(
    agentsRow,
    /6500 byte（HARD cap）/,
    "AGENTS.md cap row must not label 6500 as the sole HARD cap"
  );
});

// #6c — design-core.md agents-md-size reference must cite the true HARD cap (10500), not 6500.
test("design-core agents-md-size hard cap reference is 10500, not 6500", () => {
  const md = read(".devpro/agent-rules/design-core.md");
  // Locate the line that mentions agents-md-size.test.mjs and hard cap
  const capLine = md.split("\n").find(
    (l) => l.includes("agents-md-size.test.mjs") && /hard cap|byte/i.test(l)
  );
  assert.ok(capLine, "must find agents-md-size.test.mjs cap reference line in design-core.md");
  assert.match(
    capLine,
    /10500/,
    `agents-md-size hard cap line must reference 10500 (true HARD cap), got: ${capLine}`
  );
  assert.doesNotMatch(
    capLine,
    /6500 byte hard cap/,
    "agents-md-size line must not state '6500 byte hard cap'"
  );
});

test("token efficiency guidance prioritizes useful clarity over raw cap compression", () => {
  const agentsMaintenance = read(".devpro/agent-rules/agents-md-maintenance.md");
  const designCore = read(".devpro/agent-rules/design-core.md");
  const tokenPrecheck = read(".devpro/agent-rules/token-budget-precheck.md");
  const ruleDesignPrinciples = read(".devpro/agent-rules/rule-design-principles.md");

  for (const [name, md] of [
    ["agents-md-maintenance.md", agentsMaintenance],
    ["design-core.md", designCore],
    ["token-budget-precheck.md", tokenPrecheck],
    ["rule-design-principles.md", ruleDesignPrinciples],
  ]) {
    assert.match(md, /load-bearing/, `${name} must name load-bearing clarity`);
    assert.match(md, /clarity|可理解|可執行/, `${name} must protect readability/actionability`);
    assert.match(md, /低訊息密度|無用/, `${name} must target useless/low-information text first`);
  }

  assert.match(designCore, /User value \/ usefulness 是最終裁判/, "design-core must not make token cost the final judge");
  assert.match(tokenPrecheck, /mitigation options/, "token-budget-precheck must frame over-cap handling as mitigation options");
  assert.match(tokenPrecheck, /調整 cap \/ per-file override/, "token-budget-precheck must allow justified cap raises");
  assert.match(
    ruleDesignPrinciples,
    /只能在同等可讀、可執行、load-bearing 的選項間選 lower-total-cost/,
    "rule-design-principles must subordinate lower token cost to usefulness"
  );
});

// #6d — rule-audit-playbook.md cadence condition 3 must label 6500 as SOFT cap (not HARD cap).
// 6300 is the alert threshold (200 buffer before SOFT cap 6500); it must not change.
// Both derived from SSOT raise 6000/6500 → 6500/7000 in clarify-agents-md-entry-anchors.
test("rule-audit-playbook cadence condition 3 labels 6500 as SOFT cap, not HARD cap", () => {
  const md = read(".devpro/agent-rules/rule-audit-playbook.md");
  // cadence condition 3: the line containing 6300 (the alert threshold)
  const cadenceLine = md.split("\n").find((l) => l.includes("6300"));
  assert.ok(cadenceLine, "must find the cadence 6300 threshold line in rule-audit-playbook.md");
  // 6300 must be present (locked by rule-design-principles-meta-rule.test.mjs)
  assert.match(cadenceLine, /6300/, "6300 alert threshold must remain unchanged");
  // Must NOT label 6500 as HARD cap on that line
  assert.doesNotMatch(
    cadenceLine,
    /HARD cap 6500/,
    "cadence condition 3 must not label 6500 as HARD cap (it is the SOFT cap)"
  );
  // Must label 6500 as SOFT cap
  assert.match(
    cadenceLine,
    /SOFT cap 6500/,
    "cadence condition 3 must label 6500 as SOFT cap (true HARD cap is 10500)"
  );
});
