/**
 * Locks post-intervention exact-case recovery across the shared rule, Cursor
 * hot path, and the cross-runtime-parity capability contract.
 *
 * Guard boundary: these assertions protect carrier-local wording and polarity;
 * runtime compliance remains cooperative-only and requires human review.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const CHANGE = "strengthen-cursor-recovery-verification";
const SHARED_PATH = ".devpro/agent-rules/post-intervention-recovery-gate.md";
const ENTRY_PATH = ".devpro/agent-rules/troubleshooting.md";
const CURSOR_PATH = ".devpro/agent-rules/platform-adapters/cursor.md";
const ACTIVE_SPEC_PATH = `openspec/changes/${CHANGE}/specs/cross-runtime-parity/spec.md`;
const CANONICAL_SPEC_PATH = "openspec/specs/cross-runtime-parity/spec.md";

const SHARED_HEADING = "### Post-Intervention Exact-Case Recovery Gate";
const CURSOR_HEADING = "### Turn-end Ledger-First Checklist（Cursor；每個 final / handoff 回覆前）";
const REQUIREMENT_HEADING = "### Requirement: Post-Intervention Exact-Case Recovery Verification";

function read(path) {
  return readFileSync(repoPath(path), "utf8");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sliceSection(content, heading) {
  const headingLine = new RegExp(`^${escapeRegex(heading)}$`, "gm");
  const matches = [...content.matchAll(headingLine)];
  assert.equal(matches.length, 1, `${heading} must occur exactly once; actual=${matches.length}`);

  const level = heading.match(/^#+/)?.[0].length;
  assert.ok(level, `invalid heading: ${heading}`);
  const start = matches[0].index;
  const rest = content.slice(start + heading.length);
  const boundary = new RegExp(`^#{1,${level}}\\s+`, "m").exec(rest);
  const end = boundary ? start + heading.length + boundary.index : content.length;
  return content.slice(start, end);
}

function assertOneLine(section, regex, label) {
  const hits = section.split("\n").filter((line) => regex.test(line));
  assert.equal(hits.length, 1, `${label} must match exactly one physical line; actual=${hits.length}`);
}

function assertSharedSection(section) {
  for (const field of ["exact_case", "user_visible_result", "post_request_stability", "recovery_status"]) {
    assertOneLine(section, new RegExp("^\\| `" + field + "` \\|"), `Recovery Verification field ${field}`);
  }

  assertOneLine(
    section,
    /\*\*Staleness\*\*[^\n]*每次新的 recovery intervention[^\n]*MUST[^\n]*先前 recovery evidence stale/,
    "new intervention stales prior recovery evidence",
  );
  assertOneLine(
    section,
    /\*\*Self-run boundary\*\*[^\n]*existing authority\/tool boundaries[^\n]*MUST[^\n]*自行重跑[^\n]*MUST NOT[^\n]*bypass Ask First\/Never/,
    "qualified self-run duty and safety boundary",
  );
  assertOneLine(
    section,
    /\*\*Recovered\/ready gate\*\*[^\n]*current original exact case[^\n]*user-visible result[^\n]*post-request stability[^\n]*MUST[^\n]*recovered\/ready/,
    "recovered/ready current-evidence gate",
  );
  assertOneLine(
    section,
    /\*\*Insufficient evidence\*\*[^\n]*PID[^\n]*listener[^\n]*port[^\n]*restart exit 0[^\n]*MUST NOT[^\n]*recovered\/ready/,
    "lower-level signals are insufficient",
  );
  assertOneLine(
    section,
    /\*\*Failure disposition\*\*[^\n]*failed[^\n]*MUST[^\n]*blocked[^\n]*unavailable[^\n]*MUST[^\n]*unverified/,
    "failed and unavailable disposition",
  );
  assertOneLine(
    section,
    /\*\*Non-evidence\*\*[^\n]*reminder[^\n]*承諾[^\n]*user retry[^\n]*MUST NOT[^\n]*current evidence/,
    "reminder promise and user retry are not current evidence",
  );
}

function assertCursorSection(section) {
  const recoveryStep = section.indexOf("0. **Recovery intervention gate**");
  const ledgerStep = section.indexOf("1. **讀 ledger carrier**");
  assert.ok(recoveryStep >= 0, "affected IDE recovery step 0 missing");
  assert.ok(ledgerStep >= 0, "affected IDE ledger step 1 missing");
  assert.ok(recoveryStep < ledgerStep, "affected IDE recovery step must precede ledger ownership");

  assertOneLine(
    section,
    /Recovery intervention gate[^\n]*`post-intervention-recovery-gate\.md`[^\n]*Post-Intervention Exact-Case Recovery Gate/,
    "affected IDE shared-rule pointer",
  );
  assertOneLine(
    section,
    /最近一次 recovery intervention[^\n]*仍沒有 current original exact-case result[^\n]*每個 final \/ handoff/,
    "affected IDE cross-turn missing-current-result trigger",
  );
  assertOneLine(
    section,
    /existing authority\/tool boundaries[^\n]*Cursor[^\n]*MUST[^\n]*自行重跑[^\n]*exact case/,
    "affected IDE qualified self-run action",
  );
  assertOneLine(
    section,
    /listener[^\n]*reminder[^\n]*承諾[^\n]*user retry[^\n]*MUST NOT[^\n]*替代/,
    "affected IDE substitute rejection",
  );
  assertOneLine(
    section,
    /failed[^\n]*crash[^\n]*final／handoff[^\n]*MUST[^\n]*investigating\/blocked[^\n]*MUST NOT[^\n]*recovered\/ready/,
    "affected IDE failed/crash terminal state",
  );
  assertOneLine(
    section,
    /existing authority\/tool boundaries[^\n]*unavailable[^\n]*final／handoff[^\n]*MUST[^\n]*blocked\/unverified[^\n]*MUST NOT[^\n]*recovered\/ready/,
    "affected IDE boundary-unavailable terminal state",
  );
  assertOneLine(
    section,
    /兩種 terminal disposition[^\n]*MUST[^\n]*alternate evidence[^\n]*missing evidence[^\n]*owner/,
    "affected IDE terminal handoff evidence",
  );
}

const SCENARIOS = [
  "Current original exact case succeeds",
  "Listener-only signal remains unverified",
  "Exact case still fails or crashes",
  "Exact case is unavailable within existing boundaries",
  "Affected IDE runtime adapter or handoff cannot replace verification",
  "Other runtime follows the shared recovery contract",
];

const SCENARIO_THEN_POLARITY = new Map([
  [
    "Current original exact case succeeds",
    /^- \*\*THEN\*\* the agent MUST record the current result and stability evidence and MAY report `recovered` or `ready` with that evidence$/,
  ],
  [
    "Listener-only signal remains unverified",
    /^- \*\*THEN\*\* the agent MUST keep the recovery `unverified` and MUST NOT report `recovered` or `ready`$/,
  ],
  [
    "Exact case still fails or crashes",
    /^- \*\*THEN\*\* the agent MUST return to `investigating` or `blocked` and MUST NOT substitute prior or listener-only evidence$/,
  ],
  [
    "Exact case is unavailable within existing boundaries",
    /^- \*\*THEN\*\* the agent MUST report `blocked` or `unverified`, name alternate evidence, missing evidence, and the next owner, and MUST NOT expand authority$/,
  ],
  [
    "Affected IDE runtime adapter or handoff cannot replace verification",
    /^- \*\*THEN\*\* the agent MUST execute the shared recovery gate before adapter-specific ledger ownership or handoff and MUST NOT report `recovered` or `ready`$/,
  ],
  [
    "Other runtime follows the shared recovery contract",
    /^- \*\*THEN\*\* the agent MUST apply the same current-result and post-request-stability gate without requiring runtime-specific tools$/,
  ],
]);

const SHARED_MUTATIONS = [
  {
    pattern: /(^\*\*Staleness\*\*.*$\n?)/m,
    replacement: "",
    label: "delete staleness line",
    expectedError: /new intervention stales prior recovery evidence/,
  },
  {
    pattern: /(^\*\*Staleness\*\*.*)MUST/m,
    replacement: "$1MAY",
    label: "soften staleness MUST to MAY",
    expectedError: /new intervention stales prior recovery evidence/,
  },
  {
    pattern: /existing authority\/tool boundaries/,
    replacement: "",
    label: "remove authority/tool qualifier",
    expectedError: /qualified self-run duty and safety boundary/,
  },
  {
    pattern: /MUST NOT[^\n]*bypass Ask First\/Never/,
    replacement: "MAY bypass Ask First/Never",
    label: "soften Ask First/Never prohibition",
    expectedError: /qualified self-run duty and safety boundary/,
  },
  {
    pattern: /(^\*\*Recovered\/ready gate\*\*.*$\n?)/m,
    replacement: "",
    label: "delete recovered/ready gate",
    expectedError: /recovered\/ready current-evidence gate/,
  },
  {
    pattern: /(^\*\*Insufficient evidence\*\*.*$\n?)/m,
    replacement: "",
    label: "delete lower-level rejection",
    expectedError: /lower-level signals are insufficient/,
  },
  {
    pattern: /(^\*\*Failure disposition\*\*.*$\n?)/m,
    replacement: "",
    label: "delete failed/unavailable disposition",
    expectedError: /failed and unavailable disposition/,
  },
];

const CURSOR_MUTATIONS = [
  {
    pattern: /(^0\. \*\*Recovery intervention gate\*\*.*$\n?)/m,
    replacement: "",
    label: "delete shared pointer",
    expectedError: /affected IDE recovery step 0 missing/,
  },
  {
    pattern: /(^\s+- 最近一次 recovery intervention.*$\n?)/m,
    replacement: "",
    label: "delete affected IDE cross-turn trigger",
    expectedError: /affected IDE cross-turn missing-current-result trigger/,
  },
  {
    pattern: /(^\s+- existing authority\/tool boundaries.*$\n?)/m,
    replacement: "",
    label: "delete affected IDE self-run action",
    expectedError: /affected IDE qualified self-run action/,
  },
  {
    pattern: /(^\s+- listener.*$\n?)/m,
    replacement: "",
    label: "delete affected IDE substitute rejection",
    expectedError: /affected IDE substitute rejection/,
  },
  {
    pattern: /(^\s+- exact case `failed`／`crash`.*\n^\s+- exact case.*`unavailable`.*\n^\s+- 兩種 terminal disposition.*$\n?)/m,
    replacement: "   - exact case `failed`／`crash` 或 `unavailable` 時，final／handoff MAY 宣稱 recovered/ready。\n",
    label: "weaken affected IDE terminal branches",
    expectedError: /affected IDE failed\/crash terminal state/,
  },
];

const SPEC_MUTATIONS = [
  {
    scenario: "Current original exact case succeeds",
    pattern: /the agent MUST record the current result and stability evidence and MAY report `recovered` or `ready` with that evidence/,
    replacement: "the agent MAY omit the current result and stability evidence and report `recovered` or `ready` without that evidence",
    label: "reverse success transition",
    expectedError: /Current original exact case succeeds THEN polarity/,
  },
  {
    scenario: "Listener-only signal remains unverified",
    pattern: /the agent MUST keep the recovery `unverified` and MUST NOT report `recovered` or `ready`/,
    replacement: "the agent MAY report `recovered` or `ready` from the lower-level signal",
    label: "allow listener-only recovery",
    expectedError: /Listener-only signal remains unverified THEN polarity/,
  },
  {
    scenario: "Exact case still fails or crashes",
    pattern: /the agent MUST return to `investigating` or `blocked` and MUST NOT substitute prior or listener-only evidence/,
    replacement: "the agent MAY report `recovered` using prior or listener-only evidence",
    label: "allow recovery after exact-case failure",
    expectedError: /Exact case still fails or crashes THEN polarity/,
  },
  {
    scenario: "Exact case is unavailable within existing boundaries",
    pattern: /the agent MUST report `blocked` or `unverified`, name alternate evidence, missing evidence, and the next owner, and MUST NOT expand authority/,
    replacement: "the agent MAY expand authority and report `recovered` without naming the missing evidence or next owner",
    label: "allow authority expansion when exact case is unavailable",
    expectedError: /Exact case is unavailable within existing boundaries THEN polarity/,
  },
  {
    scenario: "Affected IDE runtime adapter or handoff cannot replace verification",
    pattern: /the agent MUST execute the shared recovery gate before adapter-specific ledger ownership or handoff and MUST NOT report `recovered` or `ready`/,
    replacement: "the agent MAY skip the shared recovery gate before handoff and MAY report `recovered` or `ready`",
    label: "allow affected IDE runtime adapter or handoff to bypass verification",
    expectedError: /Affected IDE runtime adapter or handoff cannot replace verification THEN polarity/,
  },
  {
    scenario: "Other runtime follows the shared recovery contract",
    pattern: /the agent MUST apply the same current-result and post-request-stability gate without requiring runtime-specific tools/,
    replacement: "the agent MAY omit the shared gate or require runtime-specific tools",
    label: "weaken other-runtime shared-gate parity",
    expectedError: /Other runtime follows the shared recovery contract THEN polarity/,
  },
];

const ALL_MUTATIONS = [...SHARED_MUTATIONS, ...CURSOR_MUTATIONS, ...SPEC_MUTATIONS];

function assertSpecSection(section) {
  assertOneLine(section, /cooperative-only[^\n]*all runtimes/, "cooperative-only cross-runtime boundary");
  for (const scenario of SCENARIOS) {
    const scenarioHeading = `#### Scenario: ${scenario}`;
    const scenarioSlice = sliceSection(section, scenarioHeading);
    assertOneLine(scenarioSlice, /^- \*\*Initiator:\*\* \S/, `${scenario} Initiator`);
    assertOneLine(scenarioSlice, /^- \*\*Affected:\*\* \S/, `${scenario} Affected`);
    assertOneLine(scenarioSlice, SCENARIO_THEN_POLARITY.get(scenario), `${scenario} THEN polarity`);
  }
}

function mutate(section, pattern, replacement, label) {
  const mutated = section.replace(pattern, replacement);
  assert.notEqual(mutated, section, `${label} mutation must modify its target`);
  return mutated;
}

function currentSpecBody() {
  return existsSync(repoPath(ACTIVE_SPEC_PATH)) ? read(ACTIVE_SPEC_PATH) : read(CANONICAL_SPEC_PATH);
}

test("mutation seam rejects a non-matching pattern", () => {
  const section = "known mutation target";
  const label = "non-matching pattern";

  assert.throws(
    () => mutate(section, /absent mutation sentinel/, "replacement", label),
    {
      name: "AssertionError",
      code: "ERR_ASSERTION",
      operator: "notStrictEqual",
      message: `${label} mutation must modify its target`,
      actual: section,
      expected: section,
    },
    "a non-matching mutation must fail at the mutation seam",
  );
});

test("shared recovery gate has carrier-local current-evidence and terminal-state anchors", () => {
  assertSharedSection(sliceSection(read(SHARED_PATH), SHARED_HEADING));
});

test("debugging entry routes recovery interventions to the shared gate leaf without restating it", () => {
  const entry = read(ENTRY_PATH);
  assertOneLine(
    entry,
    /^> Load-chain（Post-Intervention Exact-Case Recovery Gate）：[^\n]*recovery intervention[^\n]*recovered／ready[^\n]*MUST 先讀並執行 `post-intervention-recovery-gate\.md`/,
    "entry recovery-gate routing line",
  );
  assert.ok(!entry.includes(SHARED_HEADING), "entry must not keep a second copy of the shared gate section");
  assert.ok(!/^\| `recovery_status` \|/m.test(entry), "entry must not restate the Recovery Verification table");
});

for (const { pattern, replacement, label, expectedError } of SHARED_MUTATIONS) {
  test(`shared mutation proof: ${label} turns helper red`, () => {
    const section = sliceSection(read(SHARED_PATH), SHARED_HEADING);
    const mutated = mutate(section, pattern, replacement, label);
    assert.throws(() => assertSharedSection(mutated), expectedError, `${label} must turn shared helper red`);
  });
}

test("affected IDE hot path runs the shared recovery action before ledger ownership", () => {
  assertCursorSection(sliceSection(read(CURSOR_PATH), CURSOR_HEADING));
});

for (const { pattern, replacement, label, expectedError } of CURSOR_MUTATIONS) {
  test(`affected IDE mutation proof: ${label} turns helper red`, () => {
    const section = sliceSection(read(CURSOR_PATH), CURSOR_HEADING);
    const mutated = mutate(section, pattern, replacement, label);
    assert.throws(() => assertCursorSection(mutated), expectedError, `${label} must turn affected IDE helper red`);
  });
}

test("active delta or archived canonical spec carries six recovery scenarios", () => {
  assertSpecSection(sliceSection(currentSpecBody(), REQUIREMENT_HEADING));
});

for (const { scenario, pattern, replacement, label, expectedError } of SPEC_MUTATIONS) {
  test(`spec mutation proof: ${label} turns helper red`, () => {
    const section = sliceSection(currentSpecBody(), REQUIREMENT_HEADING);
    const mutated = mutate(section, pattern, replacement, label);
    assert.throws(() => assertSpecSection(mutated), expectedError, `${label} must turn spec helper red`);
  });
}

test("mutation proofs reject incidental harness errors", () => {
  assert.equal(SHARED_MUTATIONS.length, 7, "shared mutation count");
  assert.equal(CURSOR_MUTATIONS.length, 5, "affected IDE mutation count");
  assert.equal(SPEC_MUTATIONS.length, 6, "spec mutation count");

  for (const { label, expectedError } of ALL_MUTATIONS) {
    let incidentalThrowWasAccepted = false;
    try {
      assert.throws(() => {
        throw new Error("incidental mutation harness failure");
      }, expectedError, `${label} incidental control`);
      incidentalThrowWasAccepted = true;
    } catch (error) {
      incidentalThrowWasAccepted = false;
      assert.equal(error?.code, "ERR_ASSERTION", `${label} incidental control must fail by assertion`);
      assert.equal(error.operator, "throws", `${label} incidental control must use assert.throws semantics`);
      assert.equal(
        error.actual?.message,
        "incidental mutation harness failure",
        `${label} incidental control must reject the fixed incidental error`,
      );
      assert.equal(error.expected, expectedError, `${label} incidental control must use its target matcher`);
    }
    assert.equal(
      incidentalThrowWasAccepted,
      false,
      `${label}: incidental throw was accepted; expected target ${expectedError}`,
    );
  }
});
