/**
 * review-receipt-carry-forward-grep.test.mjs
 *
 * Literal guard for scenario "Reviewer Carriers State The Composition Rule"
 * (change strengthen-review-receipt-carry-forward-compaction, design D8 item 10).
 *
 * The composition rule itself (what a successor receipt's `findings[]` MUST
 * include, what MAY be omitted, what MAY be carried again, how a carried
 * finding is reopened, that a full review reuses predecessor finding IDs, and
 * the code `predecessor-finding-omitted`) is cooperative at the reviewer and
 * TL carriers: the mechanical check lives in the receipt core, so only an anchor
 * keeps the prose from silently reverting to "carry every earlier finding".
 *
 * Guard shape (rule-anchor-guard-strength.md):
 *  - polarity-sensitive items bind every token to ONE physical line
 *    (`lineSatisfies`), so tokens from unrelated lines cannot substitute;
 *  - the `**Durable handoff**` check is scoped to the full-successor clause
 *    only (the text before the first `；bounded`), because the bounded clause
 *    on the same line already names open finding IDs;
 *  - every statement is scoped to the one carrier region that operatively
 *    states it (the dispatch template's primary-review prompt line is not the
 *    TL Prep step; the error code is bound to the operative line that also
 *    names the zero-publication routing), so a neighbouring sentence cannot
 *    stand in for a deleted one;
 *  - a real-carrier line-deletion audit (rule-anchor-guard-strength.md
 *    "mutation 審計") deletes every operative line in memory and requires
 *    exactly the statements that line supports to turn red;
 *  - the forbidden old wording (d) is guarded by a resident bidirectional
 *    fixture, and the check functions are proven by in-memory mutation probes
 *    over a synthetic compliant sample (probing the real carriers proves
 *    nothing while they are still unrewritten).
 *
 * Token contract for the carrier rewrite tasks (T7 reviewer carriers, T8 TL
 * carriers): every constant below is the exact literal (or, for `MUST(?! NOT)`,
 * the exact pattern) a carrier line MUST contain. The old-wording literals are assembled from fragments so this file
 * is not itself a grep hit for the forbidden text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSourceFile } from "./lib/read.mjs";

export const DISPATCH_TEMPLATE = ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md";
export const DP_REVIEWER = ".claude/agents/dp-reviewer.md";
export const PRE_PR_SKILL = ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md";
export const REVIEW_CHECKLIST = ".devpro/agent-rules/code-review-checklist.md";

export const CARRIERS = Object.freeze([DISPATCH_TEMPLATE, DP_REVIEWER, PRE_PR_SKILL, REVIEW_CHECKLIST]);

export const OMITTED_CODE = "predecessor-finding-omitted";

// The dispatch template holds the reviewer-facing primary-review prompt on ONE
// line and the TL Prep step on another. Both mention the rule, so statements
// about what the reviewer is told are bound to the prompt line, and the Prep
// statement to a line that is not a prompt line.
export const PROMPT_LINE_PREFIX = '  prompt: "objective: independent-judgment';
export const PRIMARY_REVIEW_PROMPT_MARKER = "responsibility_id: primary-review";

// (a) The four statements of the composition rule. A carrier states an item
// when ONE physical line (in the carrier's scope) contains every token of that item.
export const COMPOSITION_ITEMS = Object.freeze({
  // `MUST(?! NOT)`: "MUST NOT" must not supply the polarity of an inclusion duty.
  mustInclude: Object.freeze([/MUST(?! NOT)/u, "`findings[]`", "必帶集合"]),
  // The general omission sentence is the one that says "earlier closed"; the
  // scope-ruling exception sentence also says "MAY 省略" and "closed", so
  // neither bare token may stand for it.
  mayOmit: Object.freeze(["更早已 closed", "MAY 省略"]),
  mayCarryAgain: Object.freeze(["MAY 重帶"]),
  reopen: Object.freeze(["reopen", "state: open", "disposition: null"]),
});

// The error code is bound to the operative line that names it: the reviewer
// prompt only names the code; the other carriers also name the zero-publication
// result, and the TL carriers the no-hand-patching duty (the failure route). A
// parenthetical mention of the code elsewhere cannot stand in for that line.
export const OMITTED_CODE_TOKENS = Object.freeze({
  [DISPATCH_TEMPLATE]: Object.freeze([OMITTED_CODE]),
  [DP_REVIEWER]: Object.freeze([OMITTED_CODE, "零發布"]),
  [PRE_PR_SKILL]: Object.freeze([OMITTED_CODE, "零發布", "MUST NOT 手補"]),
  [REVIEW_CHECKLIST]: Object.freeze([OMITTED_CODE, "零發布", "MUST NOT 手補"]),
});
export const DEFAULT_CODE_TOKENS = Object.freeze([OMITTED_CODE, "零發布"]);

// (b) A full review reuses the predecessor's finding IDs. Both statements are
// full-round limited by the `full` token, so the same-round stable
// `finding_id` sentence already in dp-reviewer.md cannot satisfy them.
export const FULL_ROUND_ID_ITEMS = Object.freeze({
  reuse: Object.freeze(["full 輪", "沿用 predecessor", "`finding_id`"]),
  noReplacement: Object.freeze(["MUST NOT", "新 ID", "取代"]),
});

// The TL Prep step of the dispatch template: a successor round (full included)
// hands the reviewer previous_receipt_ref and the predecessor open_finding_ids.
export const DISPATCH_PREP_TOKENS = Object.freeze(["後繼輪", "previous_receipt_ref", "open_finding_ids"]);

// (c) The pre-PR skill `**Durable handoff**` line: the full successor clause
// is the text before the first bounded clause separator.
export const HANDOFF_LINE_PREFIX = "**Durable handoff**";
export const HANDOFF_BOUNDED_SEPARATOR = "；bounded";
export const HANDOFF_FULL_CLAUSE_TOKENS = Object.freeze(["previous_receipt_ref", "open_finding_ids"]);

// (d) Old wording that stated verbatim carry of every earlier finding as the
// current rule. Fragments are joined at runtime so no source line in this file
// contains the whole literal.
export const FORBIDDEN_OLD_WORDING = Object.freeze([
  ["predecessor observations", "cannot be shortened"].join(" "),
  ["predecessor finding", "verbatim"].join(" "),
  ["carried-forward", "finding history"].join(" "),
]);
// Files that can state the current rule or the CLI contract. The archive is
// history and is not listed.
export const FORBIDDEN_SCAN_FILES = Object.freeze([
  ...CARRIERS,
  ".devpro/scripts/review-remediation-evidence.mjs",
  ".devpro/scripts/lib/review-remediation-evidence-core.mjs",
  "openspec/specs/code-review-checklist/spec.md",
  "openspec/specs/subagent-behavioral-contract/spec.md",
]);

export function lineSatisfies(line, tokens) {
  return tokens.every((token) => (typeof token === "string" ? line.includes(token) : token.test(line)));
}

const isPromptLine = (line) => line.startsWith(PROMPT_LINE_PREFIX) && line.includes(PRIMARY_REVIEW_PROMPT_MARKER);

/** Indices (0-based) of the lines of `text` in `scope` that satisfy every token. */
export function supportLines(text, tokens, scope = "any") {
  const inScope = {
    any: () => true,
    promptLine: isPromptLine,
    nonPromptLine: (line) => !isPromptLine(line),
  }[scope];
  return text.split("\n").flatMap((line, index) => (inScope(line) && lineSatisfies(line, tokens) ? [index] : []));
}

export function textStatesItem(text, tokens, scope = "any") {
  return supportLines(text, tokens, scope).length > 0;
}

/** Names of the (a) items, the code, and the (b) items a carrier fails to state. */
export function missingCarrierStatements(text, { fullRoundIds, codeTokens = DEFAULT_CODE_TOKENS, scope = "any" }) {
  const missing = [];
  for (const [name, tokens] of Object.entries(COMPOSITION_ITEMS)) {
    if (!textStatesItem(text, tokens, scope)) missing.push(`composition:${name}`);
  }
  if (!textStatesItem(text, codeTokens, scope)) missing.push("code:predecessor-finding-omitted");
  if (fullRoundIds) {
    for (const [name, tokens] of Object.entries(FULL_ROUND_ID_ITEMS)) {
      if (!textStatesItem(text, tokens, scope)) missing.push(`full-round-id:${name}`);
    }
  }
  return missing;
}

/**
 * Every statement a real carrier must make, each with the operative lines that
 * support it. `support` returns 0-based line indices; a statement is stated when
 * it has at least one, and compensation-free when it has exactly one.
 */
export function carrierStatements(carrier) {
  const scope = carrier === DISPATCH_TEMPLATE ? "promptLine" : "any";
  const statements = [
    ...Object.entries(COMPOSITION_ITEMS).map(([name, tokens]) => ({ name: `composition:${name}`, support: (text) => supportLines(text, tokens, scope) })),
    { name: "code:predecessor-finding-omitted", support: (text) => supportLines(text, OMITTED_CODE_TOKENS[carrier], scope) },
    ...Object.entries(FULL_ROUND_ID_ITEMS).map(([name, tokens]) => ({ name: `full-round-id:${name}`, support: (text) => supportLines(text, tokens, scope) })),
  ];
  if (carrier === DISPATCH_TEMPLATE) {
    statements.push({ name: "prep:full-successor-handoff", support: (text) => supportLines(text, DISPATCH_PREP_TOKENS, "nonPromptLine") });
  }
  if (carrier === PRE_PR_SKILL) {
    statements.push({
      name: "handoff:full-clause",
      support: (text) => (handoffFullClauseMissing(text).length === 0
        ? text.split("\n").flatMap((line, index) => (line.startsWith(HANDOFF_LINE_PREFIX) ? [index] : []))
        : []),
    });
  }
  return statements;
}

/** The full-successor clause of the pre-PR skill Durable handoff line, or null. */
export function durableHandoffFullClause(skillText) {
  const lines = skillText.split("\n").filter((line) => line.startsWith(HANDOFF_LINE_PREFIX));
  if (lines.length !== 1) return { error: `expected exactly one ${HANDOFF_LINE_PREFIX} line, got ${lines.length}` };
  const separatorIndex = lines[0].indexOf(HANDOFF_BOUNDED_SEPARATOR);
  if (separatorIndex === -1) return { error: `the Durable handoff line lost its ${HANDOFF_BOUNDED_SEPARATOR} clause separator` };
  return { clause: lines[0].slice(0, separatorIndex) };
}

export function handoffFullClauseMissing(skillText) {
  const { clause, error } = durableHandoffFullClause(skillText);
  if (error !== undefined) return [error];
  return HANDOFF_FULL_CLAUSE_TOKENS.filter((token) => !clause.includes(token));
}

export function forbiddenWordingHits(text) {
  return FORBIDDEN_OLD_WORDING.filter((literal) => text.includes(literal));
}

// ---- synthetic compliant sample used by the probes -----------------------------------------

const COMPLIANT_COMPOSITION_LINES = Object.freeze({
  mustInclude: "- 後繼收據的 `findings[]` MUST 含 predecessor 的必帶集合與本輪新 finding。",
  mayOmit: "- 更早已 closed 的其他 finding MAY 省略，由 chain walk 逐張重驗。",
  mayCarryAgain: "- 省略的 finding 也 MAY 重帶，不會被拒絕。",
  reopen: "- 重帶時要 reopen 就把它寫成 state: open 並設 disposition: null。",
  code: `- 漏帶必帶 finding 時回 ${OMITTED_CODE}，零發布。`,
  fullReuse: "- full 輪 MUST 沿用 predecessor 必帶集合的 `finding_id`，不得改發新 ID。",
  fullNoReplace: "- MUST NOT 對同一件事另發新 ID 取代舊 ID（full 輪也一樣）。",
});

function compliantCarrier(overrides = {}) {
  const lines = { ...COMPLIANT_COMPOSITION_LINES, ...overrides };
  return Object.values(lines).filter((line) => line !== null).join("\n");
}

const COMPLIANT_HANDOFF_LINE =
  "**Durable handoff**：初次傳 review mode；full successor 另傳 `previous_receipt_ref` 與 predecessor `open_finding_ids`；bounded只傳receipt path+digest、exact finding_id、open finding IDs、fresh repair-delta。";

// The same-round sentence that already exists in dp-reviewer.md. It states the
// per-round stable finding_id rule, not the full-round predecessor-ID reuse rule.
const SAME_ROUND_STABLE_ID_SENTENCE =
  "每個非OK finding都須以同一stable `finding_id`出現在分類清單、`observation_hashes`與`receipt_payload.findings`；hash由helper重算驗證，不得用description／line fuzzy續接。";

// The scope-ruling exception sentence: it also says "MAY 省略" and "closed", but it is
// not the general omission sentence and must never stand in for it.
const SCOPE_RULING_EXCEPTION_SENTENCE =
  "TL scope ruling 關閉者〔`scope-unresolved`＋`tracked-follow-up`〕MAY 省略，其餘 Critical 都是 closed 後仍必帶。";

// ---- real-carrier guards (red until the carrier rewrite tasks land) ------------------------

test("Reviewer Carriers State The Composition Rule: (a) every carrier states the four composition statements and predecessor-finding-omitted on the operative line", () => {
  const failures = [];
  for (const carrier of CARRIERS) {
    const text = readSourceFile(carrier);
    const missing = carrierStatements(carrier)
      .filter(({ name }) => !name.startsWith("full-round-id:") && !name.startsWith("handoff:"))
      .filter(({ support }) => support(text).length === 0)
      .map(({ name }) => name);
    if (missing.length > 0) failures.push(`${carrier}: ${missing.join(", ")}`);
  }
  assert.deepEqual(failures, [], "carrier statements missing; every listed item needs one physical line holding all of its tokens");
});

test("Reviewer Carriers State The Composition Rule: (b) every carrier says a full round reuses the predecessor finding_id and may not replace it with a new ID", () => {
  const failures = [];
  for (const carrier of CARRIERS) {
    const text = readSourceFile(carrier);
    const missing = carrierStatements(carrier)
      .filter(({ name }) => name.startsWith("full-round-id:"))
      .filter(({ support }) => support(text).length === 0)
      .map(({ name }) => name);
    if (missing.length > 0) failures.push(`${carrier}: ${missing.join(", ")}`);
  }
  assert.deepEqual(failures, [], "full-round finding_id reuse statements missing");
});

test("Reviewer Carriers State The Composition Rule: (c) the pre-PR skill Durable handoff full clause passes previous_receipt_ref and open_finding_ids", () => {
  const missing = handoffFullClauseMissing(readSourceFile(PRE_PR_SKILL));
  assert.deepEqual(missing, [], "the full-successor clause of the Durable handoff line (text before the bounded clause) must name these tokens");
});

test("Reviewer Carriers State The Composition Rule: (d) the old verbatim carry-forward wording is gone from the live carriers, the CLI help and the canonical specs", () => {
  const hits = [];
  for (const file of FORBIDDEN_SCAN_FILES) {
    const found = forbiddenWordingHits(readSourceFile(file));
    if (found.length > 0) hits.push(`${file}: ${found.join(" | ")}`);
  }
  assert.deepEqual(hits, [], "old wording that presents verbatim carry of every earlier finding as the current rule must not remain");
});

// ---- guard self-proof: positive sample and mutation probes (in memory) -----------------------

test("Reviewer Carriers State The Composition Rule: the guard accepts a compliant synthetic carrier and handoff line", () => {
  assert.deepEqual(missingCarrierStatements(compliantCarrier(), { fullRoundIds: true }), []);
  assert.deepEqual(handoffFullClauseMissing(COMPLIANT_HANDOFF_LINE), []);
  assert.deepEqual(forbiddenWordingHits(compliantCarrier()), []);
});

test("Reviewer Carriers State The Composition Rule: mutation probe - deleting any one composition statement turns (a) red by exactly that name", () => {
  for (const [name, expected] of [
    ["mustInclude", "composition:mustInclude"],
    ["mayOmit", "composition:mayOmit"],
    ["mayCarryAgain", "composition:mayCarryAgain"],
    ["reopen", "composition:reopen"],
    ["code", "code:predecessor-finding-omitted"],
  ]) {
    const mutated = compliantCarrier({ [name]: null });
    assert.deepEqual(
      missingCarrierStatements(mutated, { fullRoundIds: false }).filter((entry) => !entry.startsWith("full-round-id:")),
      [expected],
      `deleting ${name} must turn exactly ${expected} red`,
    );
  }
  // A MUST NOT line is the opposite polarity and cannot state the inclusion duty.
  assert.ok(
    missingCarrierStatements(
      compliantCarrier({ mustInclude: "- 後繼收據的 `findings[]` MUST NOT 省去 predecessor 的必帶集合。" }),
      { fullRoundIds: false },
    ).includes("composition:mustInclude"),
    "MUST NOT cannot satisfy the inclusion item",
  );
  // Tokens split across lines do not satisfy a polarity item.
  const split = compliantCarrier({
    mustInclude: "- 後繼收據的 `findings[]` 含 predecessor 的必帶集合。",
    fullReuse: "- MUST 在別行出現。",
  });
  assert.ok(
    missingCarrierStatements(split, { fullRoundIds: false }).includes("composition:mustInclude"),
    "MUST on another physical line cannot supply the polarity token",
  );
});

test("Reviewer Carriers State The Composition Rule: mutation probe - deleting one carrier's full-round ID statement turns (b) red for that carrier only", () => {
  const compliant = compliantCarrier();
  const carriers = new Map(CARRIERS.map((carrier) => [carrier, compliant]));
  carriers.set(DP_REVIEWER, compliantCarrier({ fullReuse: null }));
  const failing = [...carriers]
    .filter(([, text]) => missingCarrierStatements(text, { fullRoundIds: true }).some((entry) => entry.startsWith("full-round-id:")))
    .map(([carrier]) => carrier);
  assert.deepEqual(failing, [DP_REVIEWER]);
  assert.deepEqual(
    missingCarrierStatements(compliantCarrier({ fullReuse: null }), { fullRoundIds: true }),
    ["full-round-id:reuse"],
  );
  assert.deepEqual(
    missingCarrierStatements(compliantCarrier({ fullNoReplace: null }), { fullRoundIds: true }),
    ["full-round-id:noReplacement"],
  );
});

test("Reviewer Carriers State The Composition Rule: the same-round stable finding_id sentence in dp-reviewer.md does not satisfy (b)", () => {
  assert.deepEqual(
    missingCarrierStatements(SAME_ROUND_STABLE_ID_SENTENCE, { fullRoundIds: true }).filter((entry) => entry.startsWith("full-round-id:")),
    ["full-round-id:reuse", "full-round-id:noReplacement"],
  );
});

test("Reviewer Carriers State The Composition Rule: mutation probe - dropping previous_receipt_ref or open_finding_ids from the full clause turns (c) red while the bounded clause keeps them", () => {
  const boundedClauseKeepsBoth = "；bounded只傳 `previous_receipt_ref` 的 receipt path+digest、`open_finding_ids`、fresh repair-delta。";
  for (const token of HANDOFF_FULL_CLAUSE_TOKENS) {
    const mutated = `${COMPLIANT_HANDOFF_LINE.slice(0, COMPLIANT_HANDOFF_LINE.indexOf(HANDOFF_BOUNDED_SEPARATOR)).replace(token, "REMOVED")}${boundedClauseKeepsBoth}`;
    assert.ok(mutated.includes(token), "the bounded clause still supplies the token on the same physical line");
    assert.deepEqual(handoffFullClauseMissing(mutated), [token], `the full clause alone decides: ${token}`);
  }
  assert.match(
    handoffFullClauseMissing("**Durable handoff**：初次傳 review mode，沒有 bounded 分隔。")[0],
    /lost its ；bounded clause separator/u,
    "a handoff line without the bounded separator fails closed instead of scanning the whole line",
  );
  assert.match(
    handoffFullClauseMissing("no handoff here")[0],
    /expected exactly one \*\*Durable handoff\*\* line, got 0/u,
  );
});

test("Reviewer Carriers State The Composition Rule: (d) bidirectional fixture - the old wording is detected and the new wording is not", () => {
  for (const literal of FORBIDDEN_OLD_WORDING) {
    assert.deepEqual(forbiddenWordingHits(`prefix ${literal} suffix`), [literal], "residue text must be detected");
  }
  for (const legitimate of [
    "the seal request carries the required carry-forward set and the round's own findings",
    "predecessor findings are carried by finding_id, never summarized",
    "carried findings keep their complete observation",
  ]) {
    assert.deepEqual(forbiddenWordingHits(legitimate), [], `legitimate wording must pass: ${legitimate}`);
  }
});

test("Reviewer Carriers State The Composition Rule: mutation probe - a neighbouring sentence cannot stand in for a deleted operative line", () => {
  // The scope-ruling exception sentence says "MAY 省略" and "closed" but is not the general omission sentence.
  assert.deepEqual(
    missingCarrierStatements(compliantCarrier({ mayOmit: SCOPE_RULING_EXCEPTION_SENTENCE }), { fullRoundIds: false })
      .filter((entry) => !entry.startsWith("full-round-id:")),
    ["composition:mayOmit"],
    "the scope-ruling exception sentence cannot supply the general omission statement",
  );
  // A parenthetical mention of the code is not the zero-publication operative line.
  assert.deepEqual(
    missingCarrierStatements(compliantCarrier({ code: `- 例外見上段（${OMITTED_CODE}）。` }), { fullRoundIds: false })
      .filter((entry) => !entry.startsWith("full-round-id:")),
    ["code:predecessor-finding-omitted"],
    "a bare mention of the code is not the operative line",
  );
  // TL carriers also need the no-hand-patching duty on the code line.
  assert.ok(
    !textStatesItem(`- 漏帶回 ${OMITTED_CODE}（零發布）。`, OMITTED_CODE_TOKENS[PRE_PR_SKILL]),
    "the TL carrier code line must also say the TL MUST NOT patch the payload by hand",
  );
  // Dispatch template: the TL Prep line cannot stand in for the reviewer-facing prompt line.
  const prompt = `${PROMPT_LINE_PREFIX}\\nresponsibility_id: primary-review\\nrole: dp-reviewer"`;
  const prepOnly = [prompt, compliantCarrier()].join("\n");
  assert.deepEqual(
    missingCarrierStatements(prepOnly, { fullRoundIds: true, scope: "promptLine" }).sort(),
    [...Object.keys(COMPOSITION_ITEMS).map((name) => `composition:${name}`), "code:predecessor-finding-omitted",
      ...Object.keys(FULL_ROUND_ID_ITEMS).map((name) => `full-round-id:${name}`)].sort(),
    "statements on a non-prompt line cannot satisfy the prompt-line scope",
  );
  const promptCarrying = `${PROMPT_LINE_PREFIX}\\nresponsibility_id: primary-review\\n${compliantCarrier().replaceAll("\n", " ")}"`;
  assert.deepEqual(missingCarrierStatements(promptCarrying, { fullRoundIds: true, scope: "promptLine" }), [], "the same statements on the prompt line satisfy it");
});

test("Reviewer Carriers State The Composition Rule: mutation audit over the real carriers - deleting any operative line turns exactly the statements that line supports red", () => {
  for (const carrier of CARRIERS) {
    const text = readSourceFile(carrier);
    const lines = text.split("\n");
    const statements = carrierStatements(carrier);
    const support = new Map(statements.map((statement) => [statement.name, statement.support(text)]));
    // Every statement is stated by exactly one operative line: more than one is a compensation hole.
    for (const [name, supporting] of support) {
      assert.equal(supporting.length, 1, `${carrier}: ${name} must be supported by exactly one line, got [${supporting.map((index) => index + 1).join(", ")}]`);
    }
    const operativeLines = new Set([...support.values()].flat());
    for (const index of operativeLines) {
      const mutated = lines.filter((_, lineIndex) => lineIndex !== index).join("\n");
      const expectedRed = statements.filter(({ name }) => support.get(name).includes(index)).map(({ name }) => name).sort();
      const actualRed = statements.filter(({ support: supportOf }) => supportOf(mutated).length === 0).map(({ name }) => name).sort();
      assert.deepEqual(actualRed, expectedRed, `${carrier}: deleting line ${index + 1} must turn exactly its own statements red`);
    }
  }
});
