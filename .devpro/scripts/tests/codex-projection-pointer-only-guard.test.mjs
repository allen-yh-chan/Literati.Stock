/**
 * codex-projection-pointer-only-guard.test.mjs
 *
 * T28 guard (strengthen-subagent-delegation-strategy, design Task 28): the
 * `.codex/agents/dp-*.toml` projections may become pointer-only ONLY when a
 * committed redacted fixture proves that codex-cli preloads the SKILL.md body
 * into the child context. The 2026-09-03 live probe fixture
 * (`codex-continuation-followup-task.json`, `preload.skill_body_in_child_context`)
 * says it does not: `[[skills.config]]` only affects the skills listing. While
 * that is the recorded evidence every projection MUST keep its bounded role
 * text (角色邊界 paragraph) inside `developer_instructions`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";

const FIXTURE = path.join(REPO_ROOT, ".devpro/scripts/tests/fixtures/session-usage-lineage/codex-continuation-followup-task.json");
const AGENTS_DIR = path.join(REPO_ROOT, ".codex/agents");

function developerInstructions(toml) {
  const match = /developer_instructions\s*=\s*"""([\s\S]*?)"""/u.exec(toml);
  return match ? match[1] : null;
}

describe("codex projection pointer-only guard (T28)", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const preloadProven = fixture?.preload?.skill_body_in_child_context === true;

  it("the committed fixture records whether skills.config preloads the SKILL.md body", () => {
    assert.equal(typeof fixture.preload.skill_body_in_child_context, "boolean");
    assert.equal(fixture.rollout_function_call_names.continuation, "followup_task");
  });

  it("without preload evidence every dp-*.toml keeps its bounded role text (not pointer-only)", (t) => {
    if (preloadProven) t.skip("preload proven by fixture; pointer-only projections are allowed");
    const files = readdirSync(AGENTS_DIR).filter((name) => /^dp-.*\.toml$/u.test(name));
    assert.ok(files.length >= 7, `expected the seven dp-* projections, saw ${files.length}`);
    for (const name of files) {
      const body = developerInstructions(readFileSync(path.join(AGENTS_DIR, name), "utf8"));
      assert.ok(body, `${name}: developer_instructions block missing`);
      const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
      assert.ok(lines.length >= 4, `${name}: developer_instructions collapsed to ${lines.length} line(s) — pointer-only is not allowed without preload evidence`);
      assert.ok(/角色邊界|Role boundary|Reviewer contract|reviewer/u.test(body), `${name}: bounded role text missing from developer_instructions`);
      assert.ok(!/\[\[skills\.config\]\]/u.test(readFileSync(path.join(AGENTS_DIR, name), "utf8")), `${name}: skills.config must not stand in for the role text`);
    }
  });
});
