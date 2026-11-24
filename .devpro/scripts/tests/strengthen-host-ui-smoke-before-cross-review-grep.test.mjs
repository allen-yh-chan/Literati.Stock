/**
 * strengthen-host-ui-smoke-before-cross-review-grep.test.mjs
 *
 * Per-file anchors for ui-smoke carriers (design D8 / F-2-3).
 * MUST NOT pass on a single repo-wide `ui smoke:` hit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";

const FILES = {
  qa: ".devpro/agent-rules/testing-and-qa.md",
  prePr: ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md",
  crossModel: ".devpro/agent-rules/code-review-cross-model.md",
  checklist: ".devpro/agent-rules/code-review-checklist.md",
  postPr: ".devpro/agent-rules/post-pr-completion-gate.md",
  step19: ".devpro/agent-rules/openspec-step-1-to-9.md",
  operator: ".devpro/scripts/run-codex-primary-review-operator.mjs",
};
const CARRIER_KEYS = ["qa", "prePr", "crossModel", "checklist", "postPr", "step19"];

const bodies = Object.fromEntries(
  Object.entries(FILES).map(([key, rel]) => [key, read(rel)]),
);

function assertHas(rel, body, needle, why) {
  assert.ok(
    body.includes(needle),
    `${rel} must contain ${JSON.stringify(needle)} — ${why}`,
  );
}

function assertMatch(rel, body, re, why) {
  assert.match(body, re, `${rel} must match ${re} — ${why}`);
}

test("per-file: testing-and-qa.md is ui-smoke SSOT", () => {
  const rel = FILES.qa;
  const body = bodies.qa;
  assertHas(rel, body, "ui smoke:", "template field literal");
  assertHas(rel, body, "ui smoke head:", "head binding for sticky currency");
  assertHas(rel, body, "done|waived+reason|N/A+why", "canonical enum documentation");
  assertMatch(rel, body, /ILLEGAL|未解析 \|/, "reject unresolved pipe as filled value");
  assertMatch(rel, body, /E2E: 無|無 E2E/, "E2E orthogonality carrier present");
  assertMatch(rel, body, /MUST NOT.*豁免|不得.*豁免/, "E2E must not exempt ui smoke");
  assertHas(rel, body, "Manual Test", "Manual Test ≠ ui smoke");
  assertMatch(rel, body, /MUST NOT.*替代|不得.*替代|≠ ui smoke/, "Manual Test must not substitute");
  assertHas(rel, body, "Playwright", "web self-verify");
  assertMatch(rel, body, /MUST NOT interrupt|screenshot/, "batch screenshot / no interrupt");
  assertHas(rel, body, "DesignerSelect", "general UI-control BEM example");
  assertMatch(rel, body, /單一.*BEM|single BEM|BEM token/, "single BEM token");
  assert.doesNotMatch(
    body,
    /^-+\s*host smoke:/m,
    "must not land host smoke: as a second field literal (ban mention OK)",
  );
  assert.match(
    body,
    /禁落地[`\s]*host smoke:|不得落地[`\s]*host smoke:/,
    "explicit ban of host smoke: second literal remains greppable",
  );
  assertMatch(
    rel,
    body,
    /MUST NOT.*N\/A\+why|不得.*N\/A\+why|值域\*\*僅\*\* `<sha>`/,
    "N/A+why must not be legal on ui smoke head",
  );
  assertHas(
    rel,
    body,
    "**僅** `ui smoke:` 非觸發時可用 `N/A+why`",
    "Exit Criteria: N/A+why scoped to ui smoke: only",
  );
});

test("per-file: devpro:pre-pr Step 1 ui-smoke gate", () => {
  const rel = FILES.prePr;
  const body = bodies.prePr;
  assertHas(rel, body, "ui smoke", "Step 1 gate wording");
  assertHas(rel, body, "ui smoke head:", "head gate");
  assertMatch(rel, body, /Step 1[\s\S]{0,2500}ui smoke/, "ui smoke appears under Step 1 vicinity");
  assertMatch(rel, body, /不得.*就緒|不得宣告|first PR/, "blocks pre-PR / first PR readiness");
  assertMatch(rel, body, /未解析 \||ILLEGAL/, "rejects unresolved pipe filled values");
  assertMatch(rel, body, /Playwright|screenshot|MUST NOT interrupt/, "web evidence / no interrupt");
  assertHas(rel, body, "testing-and-qa.md", "pointer back to SSOT");
});

test("per-file: code-review-cross-model FAIL CLOSED + head re-eval", () => {
  const rel = FILES.crossModel;
  const body = bodies.crossModel;
  assertHas(rel, body, "ui smoke", "sticky prerequisite");
  assertHas(rel, body, "FAIL CLOSED", "fail-closed sticky entry");
  assertHas(rel, body, "qa-test-scope", "points at qa-test-scope");
  assertMatch(rel, body, /ui smoke head:|不得繼承 stale|重評/, "head re-evaluation");
  assertMatch(rel, body, /MUST NOT dispatch|不得.*dispatch/, "must not dispatch without record");
  assert.ok(
    body.includes("checkCrossModelMergeGate") && body.includes("Path F"),
    "Path F / checkCrossModelMergeGate contract remains present (no retreat)",
  );
});

test("per-file: code-review-checklist pointer + BEM", () => {
  const rel = FILES.checklist;
  const body = bodies.checklist;
  assertHas(rel, body, "ui smoke", "Cross-Model pointer");
  assertHas(rel, body, "FAIL CLOSED", "sticky fail-closed pointer");
  assertHas(rel, body, "DesignerSelect", "BEM control example");
  assertMatch(rel, body, /單一.*BEM|BEM token/, "single BEM");
  assertMatch(rel, body, /一般 UI|非 Host-only/, "general UI framing");
});

test("per-file: post-pr-completion-gate pointer", () => {
  const rel = FILES.postPr;
  const body = bodies.postPr;
  assertHas(rel, body, "ui smoke", "pointer field");
  assertMatch(rel, body, /sticky\/ready|sticky／ready|不得把 sticky/, "must not treat sticky/ready complete without record");
  assertHas(rel, body, "code-review-cross-model.md", "pointer to FAIL CLOSED entry");
});

test("per-file: openspec-step-1-to-9 author hot-path pointer", () => {
  const rel = FILES.step19;
  const body = bodies.step19;
  assertHas(rel, body, "ui smoke:", "qa-test-scope author obligation");
  assertHas(rel, body, "ui smoke head:", "head field on author path");
  assertHas(rel, body, "testing-and-qa.md", "pointer to SSOT; no second definition");
});

test("ui smoke head rule matches committed QA currency", () => {
  assertMatch(
    FILES.qa,
    bodies.qa,
    /^- \*\*head currency\*\*：[^\n]*merge-base\(originMain, tip\)[^\n]*isAllowedPostSmokeDeltaPath[^\n]*$/m,
    "ancestor currency and allowed post-smoke paths belong in the SSOT",
  );
  for (const key of ["prePr", "crossModel", "checklist"]) {
    assertMatch(
      FILES[key],
      bodies[key],
      /^.*ui smoke head:[^\n]*testing-and-qa\.md[^\n]*§UI smoke[^\n]*$/m,
      "review entry must point to the SSOT currency rule",
    );
  }
  assertMatch(
    FILES.prePr,
    bodies.prePr,
    /^.*ui smoke head:[^\n]*head currency[^\n]*testing-and-qa\.md[^\n]*§UI smoke[^\n]*$/m,
    "pre-PR Step 1 must point to head currency, beyond the old generic SSOT pointer",
  );
  assert.doesNotMatch(
    bodies.prePr.replace("正文與 head currency SSOT", "正文 SSOT"),
    /^.*ui smoke head:[^\n]*head currency[^\n]*testing-and-qa\.md[^\n]*§UI smoke[^\n]*$/m,
    "the previous generic SSOT pointer must fail the currency-specific assertion",
  );
  for (const symbol of ["isAllowedPostSmokeDeltaPath", "evaluateAncestorOfTipCurrency"]) {
    assertMatch(FILES.operator, bodies.operator, new RegExp(`\\b${symbol}\\b`), "operator named by the SSOT must exist");
  }
  for (const key of ["prePr", "crossModel", "checklist"]) {
    assert.doesNotMatch(
      bodies[key],
      /與當前 head 不一致|與當前 tip 不一致|當前 `ui smoke head:`|擬 sticky head/,
      `${FILES[key]} must not restore the removed exact-head-only wording`,
    );
  }
});

test("polarity: removing any single-file ui smoke anchor fails that file check", () => {
  const probes = [
    { key: "qa", needle: "ui smoke:" },
    { key: "prePr", needle: "ui smoke" },
    { key: "crossModel", needle: "FAIL CLOSED" },
    { key: "checklist", needle: "ui smoke" },
    { key: "postPr", needle: "ui smoke" },
    { key: "step19", needle: "ui smoke:" },
  ];
  for (const { key, needle } of probes) {
    const mutated = bodies[key].split(needle).join("");
    assert.throws(
      () => assertHas(FILES[key], mutated, needle, "polarity: mutated body must fail assertHas"),
      /must contain/,
      `${FILES[key]} validator must reject body after stripping ${JSON.stringify(needle)}`,
    );
    assert.ok(
      bodies[key].includes(needle),
      `live ${FILES[key]} still has ${JSON.stringify(needle)} (guards vacuous polarity)`,
    );
  }
});

test("must not treat repo-wide single hit as sufficient (six carriers required)", () => {
  assert.ok(CARRIER_KEYS.every((key) => key in FILES), "every carrier key must map to a file");
  const hitCount = CARRIER_KEYS
    .filter((key) => bodies[key].includes("ui smoke")).length;
  assert.equal(CARRIER_KEYS.length, 6, "six carrier contracts are expected");
  assert.equal(hitCount, CARRIER_KEYS.length, "all carriers must independently contain ui smoke wording");
});
