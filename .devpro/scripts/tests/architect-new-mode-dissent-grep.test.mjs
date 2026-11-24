/**
 * architect-new-mode-dissent-grep.test.mjs
 *
 * Locks dp-architect new-mode dissent exit (design.md D4):
 *   - bounded unique Mode `new` JSON / Output vs Mode `update` JSON slices
 *   - bidirectional status-enum equality {finished, questions, failed}
 *   - polarity same-physical-line compound regex (no decoupled includes;
 *     no compensating alternation)
 *   - questions missing-input remains, separate from dissent asserts
 *   - devpro:change routing: valid failed+dissent vs malformed failed contract-error
 *     are mutually exclusive; questions route remains
 *   - fallback excludes JSON failed; runtime unavailable is the trigger
 *   - received JSON failed must not share miss / focused-rebrief condition
 *   - cursor / codex status declaration lines include failed, not token dissent
 *   - mutation: delete dissent-exit or malformed-failed line turns red
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";
import { readChangeSkillFullReadingOrder } from "./lib/change-skill.mjs";

const ARCHITECT = ".claude/agents/dp-architect.md";
const FALLBACK = ".devpro/agent-rules/openspec-flow-fallback.md";
const CURSOR_ARCHITECT = ".cursor/agents/dp-architect.md";
const CODEX_ARCHITECT = ".codex/agents/dp-architect.toml";

const NEW_MODE_STATUS = new Set(["finished", "questions", "failed"]);
const UPDATE_MODE_STATUS = new Set(["finished", "questions"]);
const STATUS_TOKEN_RE = /\b(finished|blocked|failed|questions|partial|dissent)\b/g;

const DISSENT_EXIT_RE = /failed[^\n]*dissent[^\n]*MUST NOT[^\n]*questions/;
const MUST_NOT_FINISHED_PROPOSAL_RE = /MUST NOT[^\n]*finished[^\n]*proposal/;
const QUESTIONS_MISSING_INPUT_RE = /change_path[^\n]*routing_context[^\n]*questions/;
const VALID_DISSENT_ROUTE_RE =
  /failed[^\n]*\+ 有效 `dissent`[^\n]*MUST 停，把 dissent 交回使用者/;
const MALFORMED_FAILED_ROUTE_RE =
  /failed[^\n]*契約錯誤[^\n]*payload 缺失[^\n]*MUST NOT[^\n]*dissent\.reasons/;
const QUESTIONS_ROUTE_RE = /待確認項|status:\s*`?questions`?/;
const JSON_FAILED_EXCLUDED_FROM_FALLBACK_RE =
  /JSON[^\n]*status:\s*`?failed`?[^\n]*(?:MUST NOT|排除)|排除[^\n]*JSON[^\n]*status:\s*`?failed`?/;
const RUNTIME_UNAVAILABLE_RE =
  /quota[^\n]*terminal 工具錯誤[^\n]*runtime-contract timeout/;
const FAILED_COMPLETES_LEASE_RE =
  /(?:任何|any) JSON[^\n]*failed[^\n]*(?:完成|completes)[^\n]*writer_lease/;
const FAILED_NOT_MISS_RE =
  /(?:received|已收到|任何 JSON)[^\n]*failed[^\n]*MUST NOT[^\n]*artifact_landing_deadline_missed/;
const CURSOR_STATUS_LINE_RE = /^只能使用：[^\n]+/m;
const CODEX_STATUS_LINE_RE = /^必要標準 terminal status 字串：[^\n]+/m;
const DISSENT_TOKEN_RE = /\bdissent\b/;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function headingLevel(line) {
  const m = line.match(/^(#+)\s/);
  return m ? m[1].length : 0;
}

function isolateHeadingSlice(content, heading, label) {
  const headingRe = new RegExp(`^${escapeRegExp(heading)}\\s*$`, "gm");
  const matches = [...content.matchAll(headingRe)];
  assert.equal(
    matches.length,
    1,
    `${label} isolation fail closed: slice count=${matches.length} (expected 1); heading="${heading}"; positions=${matches.map((m) => m.index).join(",") || "none"}`,
  );
  const start = matches[0].index;
  const nl = content.indexOf("\n", start);
  const startLine = content.slice(start, nl === -1 ? content.length : nl);
  const level = headingLevel(startLine);
  const bodyStart = nl === -1 ? content.length : nl + 1;
  let insideFence = false;
  let cursor = bodyStart;
  for (const line of content.slice(bodyStart).split("\n")) {
    if (line.startsWith("```")) {
      insideFence = !insideFence;
    } else if (!insideFence) {
      const lvl = headingLevel(line);
      if (lvl > 0 && lvl <= level) {
        return content.slice(start, cursor);
      }
    }
    cursor += line.length + 1;
  }
  return content.slice(start);
}

function uniqueJsonFence(section, label) {
  const fences = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)];
  assert.equal(
    fences.length,
    1,
    `${label} JSON fence fail closed: count=${fences.length} (expected 1)`,
  );
  return fences[0][1];
}

function statusTokensFromEnumString(enumString) {
  const tokens = [];
  STATUS_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = STATUS_TOKEN_RE.exec(enumString))) tokens.push(m[1]);
  return new Set(tokens);
}

function extractJsonStatusEnum(jsonBody, label) {
  const matches = [...jsonBody.matchAll(/"status"\s*:\s*"([^"]+)"/g)];
  assert.equal(
    matches.length,
    1,
    `${label} status field fail closed: count=${matches.length} (expected 1)`,
  );
  return statusTokensFromEnumString(matches[0][1]);
}

function assertSetEqual(actual, expected, label) {
  const missing = [...expected].filter((x) => !actual.has(x)).sort();
  const extra = [...actual].filter((x) => !expected.has(x)).sort();
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    `${label} status enum mismatch: missing=[${missing.join(", ")}] extra=[${extra.join(", ")}] actual=[${[...actual].sort().join(", ")}]`,
  );
}

function uniqueLine(content, regex, label) {
  const lines = content.split("\n").filter((line) => regex.test(line));
  assert.equal(
    lines.length,
    1,
    `${label} fail closed: matching line count=${lines.length} (expected 1)`,
  );
  return lines[0];
}

function isolateArchitectReportSection(skillBody) {
  const marker = "收到 architect 回報：";
  const matches = [];
  let from = 0;
  while (from < skillBody.length) {
    const idx = skillBody.indexOf(marker, from);
    if (idx === -1) break;
    matches.push(idx);
    from = idx + marker.length;
  }
  assert.equal(
    matches.length,
    1,
    `收到 architect 回報 isolation fail closed: slice count=${matches.length} (expected 1); positions=${matches.join(",") || "none"}`,
  );
  const start = matches[0];
  const rest = skillBody.slice(start);
  const term = rest.search(/\n\*\*Design\.md Second-Review Gate/);
  return term === -1 ? rest : rest.slice(0, term);
}

function isolateArchitectFallbackItem(fallbackBody) {
  const headingRe = /^2\. \*\*dp-architect 失敗 fallback\*\*[^\n]*/gm;
  const matches = [...fallbackBody.matchAll(headingRe)];
  assert.equal(
    matches.length,
    1,
    `dp-architect 失敗 fallback isolation fail closed: slice count=${matches.length} (expected 1)`,
  );
  const start = matches[0].index;
  const after = fallbackBody.slice(start + matches[0][0].length);
  const term = after.search(/\n3\. \*\*/);
  return term === -1
    ? fallbackBody.slice(start)
    : fallbackBody.slice(start, start + matches[0][0].length + term);
}

function uniqueModeNewOutputLine(outputSlice) {
  const lines = outputSlice.split("\n").filter((line) => /`mode=new`/.test(line));
  assert.equal(
    lines.length,
    1,
    `mode=new Output fail closed: line count=${lines.length} (expected 1)`,
  );
  return lines[0];
}

function extractOutputStatusEnum(line, label) {
  const m = line.match(/status:\s*([^，,]+)/);
  assert.ok(m, `${label} Output status enum missing`);
  return statusTokensFromEnumString(m[1]);
}

function assertNewModeEnum(architectBody) {
  const newSlice = isolateHeadingSlice(architectBody, "## Mode: new", "Mode new");
  const jsonEnum = extractJsonStatusEnum(uniqueJsonFence(newSlice, "Mode new"), "Mode new JSON");
  assertSetEqual(jsonEnum, NEW_MODE_STATUS, "Mode new JSON");
  const comm = isolateHeadingSlice(architectBody, "## Communication Protocol", "Communication Protocol");
  const output = isolateHeadingSlice(comm, "### Output（主 agent 期待）", "Output");
  const outputEnum = extractOutputStatusEnum(uniqueModeNewOutputLine(output), "mode=new Output");
  assertSetEqual(outputEnum, NEW_MODE_STATUS, "mode=new Output");
}

function assertUpdateModeEnum(architectBody) {
  const updateSlice = isolateHeadingSlice(architectBody, "## Mode: update", "Mode update");
  const jsonEnum = extractJsonStatusEnum(
    uniqueJsonFence(updateSlice, "Mode update"),
    "Mode update JSON",
  );
  assertSetEqual(jsonEnum, UPDATE_MODE_STATUS, "Mode update JSON");
  assert.equal(jsonEnum.has("failed"), false, "Mode update JSON MUST NOT include failed");
}

function assertDissentPolarity(architectBody) {
  uniqueLine(architectBody, DISSENT_EXIT_RE, "dissent-exit polarity");
  uniqueLine(architectBody, MUST_NOT_FINISHED_PROPOSAL_RE, "MUST NOT finished proposal polarity");
}

function assertValidDissentRoute(reportSection) {
  uniqueLine(reportSection, VALID_DISSENT_ROUTE_RE, "valid failed+dissent route");
}

function assertMalformedFailedRoute(reportSection) {
  uniqueLine(reportSection, MALFORMED_FAILED_ROUTE_RE, "malformed failed contract-error route");
}

test("bounded unique slices: Mode new JSON/Output vs Mode update JSON (hit count !== 1 fail closed)", () => {
  const architect = read(ARCHITECT);
  const newSlice = isolateHeadingSlice(architect, "## Mode: new", "Mode new");
  const updateSlice = isolateHeadingSlice(architect, "## Mode: update", "Mode update");
  uniqueJsonFence(newSlice, "Mode new");
  uniqueJsonFence(updateSlice, "Mode update");
  const comm = isolateHeadingSlice(architect, "## Communication Protocol", "Communication Protocol");
  isolateHeadingSlice(comm, "### Output（主 agent 期待）", "Output");
  uniqueModeNewOutputLine(isolateHeadingSlice(comm, "### Output（主 agent 期待）", "Output"));
  assert.equal(newSlice.includes("## Mode: update"), false, "Mode new slice leaked Mode update heading");
  assert.equal(updateSlice.includes("## Mode: new"), false, "Mode update slice leaked Mode new heading");
});

test("new-mode status enum bidirectional-equals {finished, questions, failed}", () => {
  assertNewModeEnum(read(ARCHITECT));
});

test("update-mode JSON status enum bidirectional-equals {finished, questions} without failed", () => {
  assertUpdateModeEnum(read(ARCHITECT));
});

test("insertion axis: adding sixth word dissent as a status enum value turns set equality red", () => {
  const architect = read(ARCHITECT);
  const newSlice = isolateHeadingSlice(architect, "## Mode: new", "Mode new");
  const json = uniqueJsonFence(newSlice, "Mode new");
  const mutated = json.replace(/"status"\s*:\s*"([^"]+)"/, (_m, vals) => `"status": "${vals} | dissent"`);
  assert.throws(() => {
    assertSetEqual(extractJsonStatusEnum(mutated, "injected dissent enum"), NEW_MODE_STATUS, "injected dissent");
  });
});

test("polarity: same physical line binds failed + dissent + MUST NOT … questions", () => {
  uniqueLine(read(ARCHITECT), DISSENT_EXIT_RE, "dissent-exit polarity");
});

test("polarity: same physical line binds MUST NOT … finished proposal", () => {
  uniqueLine(read(ARCHITECT), MUST_NOT_FINISHED_PROPOSAL_RE, "MUST NOT finished proposal polarity");
});

test("absence: questions missing-input (change_path / routing_context) remains separate from dissent asserts", () => {
  const architect = read(ARCHITECT);
  assert.match(architect, QUESTIONS_MISSING_INPUT_RE, "questions missing-input (change_path / routing_context) must remain");
  const missingInputLines = architect.split("\n").filter((line) => QUESTIONS_MISSING_INPUT_RE.test(line));
  assert.ok(missingInputLines.length >= 1, "questions missing-input line missing");
  for (const line of missingInputLines) {
    assert.equal(
      DISSENT_EXIT_RE.test(line),
      false,
      "questions missing-input line must not be the dissent-exit polarity line",
    );
  }
});

test("devpro:change 收到 architect 回報: valid failed+dissent+stop vs malformed failed contract-error are mutually exclusive; questions route remains", () => {
  const report = isolateArchitectReportSection(readChangeSkillFullReadingOrder());
  const validLine = uniqueLine(report, VALID_DISSENT_ROUTE_RE, "valid failed+dissent route");
  const malformedLine = uniqueLine(report, MALFORMED_FAILED_ROUTE_RE, "malformed failed contract-error route");
  assert.notEqual(validLine, malformedLine, "valid dissent and malformed failed must not be the same line");
  assert.equal(VALID_DISSENT_ROUTE_RE.test(malformedLine), false, "malformed line must not satisfy valid-dissent route");
  assert.equal(MALFORMED_FAILED_ROUTE_RE.test(validLine), false, "valid-dissent line must not satisfy malformed route");
  assert.match(report, QUESTIONS_ROUTE_RE, "questions route must remain in 收到 architect 回報");
});

test("fallback: JSON failed is not the architect-failure trigger; runtime unavailable remains", () => {
  const item = isolateArchitectFallbackItem(read(FALLBACK));
  assert.match(item, RUNTIME_UNAVAILABLE_RE, "dp-architect 失敗 fallback must trigger on runtime unavailable");
  assert.match(
    item,
    JSON_FAILED_EXCLUDED_FROM_FALLBACK_RE,
    "dp-architect 失敗 fallback must exclude JSON status: failed",
  );
});

test("lease: any received JSON failed must not share a condition with artifact_landing_deadline_missed / focused rebrief", () => {
  const architect = read(ARCHITECT);
  uniqueLine(architect, FAILED_COMPLETES_LEASE_RE, "JSON failed completes writer_lease");
  uniqueLine(architect, FAILED_NOT_MISS_RE, "received JSON failed MUST NOT be miss");
  const missShared = architect.split("\n").filter(
    (line) =>
      /\bfailed\b/.test(line) &&
      /artifact_landing_deadline_missed|focused rebrief/.test(line) &&
      !/MUST NOT|不得/.test(line),
  );
  assert.deepEqual(
    missShared,
    [],
    "JSON failed must not share a trigger condition with artifact_landing_deadline_missed / focused rebrief",
  );
});

test("projections: cursor 只能使用 and codex 必要標準 lines contain failed and not status token dissent", () => {
  const cursorLine = uniqueLine(read(CURSOR_ARCHITECT), CURSOR_STATUS_LINE_RE, "cursor 只能使用");
  assert.match(cursorLine, /\bfailed\b/, "cursor 只能使用 line must contain failed");
  assert.doesNotMatch(cursorLine, DISSENT_TOKEN_RE, "cursor status declaration must not contain token dissent");
  const codexLine = uniqueLine(read(CODEX_ARCHITECT), CODEX_STATUS_LINE_RE, "codex 必要標準");
  assert.match(codexLine, /\bfailed\b/, "codex 必要標準 line must contain failed");
  assert.doesNotMatch(codexLine, DISSENT_TOKEN_RE, "codex status declaration must not contain token dissent");
});

test("mutation: deleting the dissent-exit operative line turns the polarity assert red", () => {
  const lines = read(ARCHITECT).split("\n");
  const idx = lines.findIndex((line) => DISSENT_EXIT_RE.test(line));
  assert.notEqual(idx, -1, "dissent-exit operative line missing");
  const mutated = lines.filter((_, i) => i !== idx).join("\n");
  assert.throws(() => assertDissentPolarity(mutated));
});

test("mutation: deleting the malformed-failed contract-error line turns the corresponding assert red", () => {
  const skill = readChangeSkillFullReadingOrder();
  const report = isolateArchitectReportSection(skill);
  const reportLines = report.split("\n");
  const idx = reportLines.findIndex((line) => MALFORMED_FAILED_ROUTE_RE.test(line));
  assert.notEqual(idx, -1, "malformed-failed contract-error line missing");
  const mutatedReport = reportLines.filter((_, i) => i !== idx).join("\n");
  assert.throws(() => assertMalformedFailedRoute(mutatedReport));
  assertValidDissentRoute(mutatedReport);
});
