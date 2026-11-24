import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";

/**
 * #2503 — shape-based OpenSpec path classification + narrowed trade-off.
 * Locks the cross-carrier anchors so feature/bugfix cannot silently
 * revert to prefix-forced full B, and so "任一 trade-off" cannot return.
 */

const chore = read(".devpro/agent-rules/chore-classification.md");
const skill = read(".devpro/agent-skills/devpro-workflows/change/SKILL.md");
const hub = read(".devpro/agent-rules/openspec-flow.md");
const authoring = read(
  ".devpro/agent-skills/openspec/openspec-artifact-authoring/SKILL.md",
);

test("chore-classification.md is shape-based across four prefixes", () => {
  assert.match(chore, /變更形狀分類（Change Classification）/);
  assert.match(chore, /分類維度是變更形狀，不是分支前綴/);
  for (const prefix of ["chore/", "feature/", "bugfix/", "hotfix/"]) {
    assert.ok(chore.includes(prefix), `expected applicability mention of ${prefix}`);
  }
});

test("devpro:change Step 2 routes four prefixes through judgment table", () => {
  assert.match(skill, /第二步：Change Classification Routing/);
  assert.match(skill, /chore \/ feature \/ bugfix \/ hotfix/);
  assert.doesNotMatch(
    skill,
    /^\s*- \*\*feature \/ bugfix \/ hotfix\*\* → 直接走完整第五步/m,
  );
});

test("hub and authoring skills do not force feature/bugfix to full artifact set", () => {
  assert.match(hub, /變更形狀 A vs B 判斷/);
  assert.doesNotMatch(
    hub,
    /除 `chore A`（純技術雜事，無可觀察行為變化）外，所有行為變更都必須走完整流程/,
  );
  assert.match(hub, /路徑深度由\*\*變更形狀\*\*決定|禁止\*\*把「行為變更」一律讀成 full B/);
  assert.doesNotMatch(authoring, /完整 feature\/bugfix 需要完整的 artifact set/);
  assert.match(authoring, /full B.*完整的 artifact set|完整的 artifact set.*full B/s);
});

test("branch-routing and step-1-to-9 continuation are shape-based (not prefix-forced full)", () => {
  const routing = read(".devpro/agent-rules/openspec-branch-routing.md");
  const steps = read(".devpro/agent-rules/openspec-step-1-to-9.md");
  assert.doesNotMatch(
    routing,
    /不跳過 dp-analyst \/ dp-architect \/ proposal \/ tasks \/ QA/,
  );
  assert.match(routing, /深度依 `chore-classification\.md` 形狀判定/);
  assert.doesNotMatch(
    steps,
    /Active OpenSpec continuation checkpoint（`feature\/\*` \/ `bugfix\/\*` \/ chore-B 必做/,
  );
  assert.match(steps, /形狀判為 \*\*B-mini／B\*\* 必做/);
  assert.doesNotMatch(
    steps,
    /`feature\/\*` \/ `bugfix\/\*` 缺 `proposal\*\.md` 是 missing OpenSpec evidence，不得視為 chore-A/,
  );
});

test("canonical or active delta carries Shape-Based OpenSpec Path Classification", () => {
  const spec = read("openspec/specs/openspec-flow/spec.md");
  let delta = "";
  try {
    delta = read(
      "openspec/changes/amend-change-shape-classification/specs/openspec-flow/spec.md",
    );
  } catch {
    try {
      delta = read(
        "openspec/changes/archive/2026-09-17-amend-change-shape-classification/specs/openspec-flow/spec.md",
      );
    } catch {
      // canonical only
    }
  }
  const combined = `${spec}\n${delta}`;
  assert.match(combined, /### Requirement: Shape-Based OpenSpec Path Classification/);
  assert.match(combined, /MUST NOT force `feature` \/ `bugfix` \/ `hotfix` onto the full path/);
  assert.match(combined, /Test-Carrier Or Naming Options Do Not Escalate Alone/);
});

test("historical any-trade-off escalation wording is gone from live judgment carriers", () => {
  assert.doesNotMatch(chore, /兩個以上選項（任一 trade-off）/);
  assert.doesNotMatch(chore, /無 trade-off 比較（單一方案，不比較選項）/);
});
