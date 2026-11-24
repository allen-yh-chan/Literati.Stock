/**
 * dp-architect-template-alignment.test.mjs
 *
 * Regression guard for issue #761: lock dp-architect.md's "Proposal 最小結構"
 * section to the hook-enforced heading names (pre-pr-archive-gate.mjs gates
 * c/d/g), while locking proposal token prose out of the architect contract.
 *
 * If anyone trims a heading or N/A keyword from dp-architect.md, this test
 * fails — preventing silent drift back to the issue #761 state where every
 * PR hit archive-gate failures.
 *
 * REQUIRED locks:
 *   - SSOT pointer to proposal-template.md
 *   - Hook-enforced proposal headings: Why / What Changes / Issue Anchor
 *     Verification / conditional File-Role Ledger / Dedup Audit
 *     三步結果
 *   - Negative guards: proposal token estimates and readability evidence stay
 *     absent because the gate measures actual carriers directly.
 *
 * Also guards issue #1681: design.md required-heading SSOT cross-carrier
 * drift between pre-pr-archive-gate.mjs's `DESIGN_MD_REQUIRED_HEADINGS`
 * constant (check q) and design-template.md's "Hook-enforced required
 * headings" declaration line. Both sides are extracted independently from
 * the real files and compared via deepEqual — no hardcoded referee set —
 * so drift in either direction fails RED (Change A / PR #1679 lesson).
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { readChangeSkillFullReadingOrder } from "./lib/change-skill.mjs";

const agentPath = repoPath(".claude/agents/dp-architect.md");
const templatePath = repoPath(".devpro/agent-rules/proposal-template.md");

const agentBody = readFileSync(agentPath, "utf8");
const templateBody = readFileSync(templatePath, "utf8");
// dp-architect dispatch block and lease/deadline text moved into the full-rigor reference.
const dpChangeSkillBody = readChangeSkillFullReadingOrder();

function extractArchitectDispatchBlock(src) {
  const marker = 'subagent_type: "dp-architect"';
  const markerIndex = src.indexOf(marker);
  if (markerIndex === -1) return null;
  const start = src.lastIndexOf("Agent({", markerIndex);
  const end = src.indexOf("\n})", markerIndex);
  if (start === -1 || end === -1) return null;
  return src.slice(start, end + 3);
}

function occurrenceCount(src, literal) {
  return src.split(literal).length - 1;
}

// ── Required: SSOT pointer ─────────────────────────────────────────────────

test("dp-architect.md Required Rules references proposal-template.md as SSOT", () => {
  assert.ok(
    /\.devpro\/agent-rules\/proposal-template\.md/.test(agentBody),
    "dp-architect.md must list proposal-template.md in Required Rules (issue #761 root cause: SSOT pointer missing)"
  );
});

// ── Required: hook-enforced heading names byte-for-byte ────────────────────

const HOOK_ENFORCED_HEADINGS = [
  "## Why",                            // gate c
  "## What Changes",                   // gate c
  "## Issue Anchor Verification",      // gate d
  "## File-Role Ledger",               // gate g
  "## Dedup Audit 三步結果",            // gate g
];

for (const heading of HOOK_ENFORCED_HEADINGS) {
  test(`dp-architect.md mentions hook-enforced heading: ${heading}`, () => {
    assert.ok(
      agentBody.includes(heading),
      `dp-architect.md must reference \`${heading}\` (byte-for-byte) so produced proposals pass pre-pr-archive-gate.mjs regex /^${heading.replace(/ /g, "\\ ")}\\s*$/m`
    );
  });

  test(`proposal-template.md has hook-enforced heading: ${heading}`, () => {
    assert.ok(
      templateBody.includes(heading),
      `proposal-template.md SSOT must contain \`${heading}\` (sanity check; if this fails, the SSOT itself drifted)`
    );
  });
}

// ── Required: grep evidence pattern hint for gate d Issue Anchor Verification ──

test("dp-architect.md hints at grep evidence pattern for Issue Anchor Verification (gate d)", () => {
  // Hook checks: anchorSection.includes("grep") || /:\d+/.test(anchorSection)
  // dp-architect must teach this pattern to be produced in the proposal.
  const hasGrepHint = /grep/.test(agentBody);
  assert.ok(
    hasGrepHint,
    "dp-architect.md must mention `grep` keyword in the context of Issue Anchor Verification so produced proposals contain grep evidence (gate d hook check)"
  );
});

// ── Required: ledger ID MUST be R<N> format (issue #1173 root cause) ──────────

test("proposal-template.md states Requirement Ledger ID 必須為 `R<N>` format constraint", () => {
  assert.ok(
    templateBody.includes("ID 必須為 `R<N>`"),
    "proposal-template.md must contain the anchor phrase `ID 必須為 \\`R<N>\\`` in the Requirement Ledger section (issue #1173: U1/U2 IDs rejected by (m) gate; SSOT must declare the format explicitly)"
  );
});

// ── Negative: must NOT have the original drift symptom ─────────────────────

test("architect and proposal template keep token measurement/evidence out of proposal prose", () => {
  for (const body of [agentBody, templateBody]) {
    assert.doesNotMatch(body, /^##\s+(?:Section\s+\d+:\s+)?Token Budget(?: Pre-)?Check\s*$/m);
    assert.doesNotMatch(body, /^##\s+Readability Precheck\s*$/m);
    assert.doesNotMatch(body, /Math\.ceil\(\(estimated(?:Tokens|Bytes)/);
  }
  assert.match(agentBody, /Actual-carrier token check/);
  assert.match(agentBody, />=80%.*semantic review/);
});

// ── issue #1681: design.md required-heading SSOT cross-carrier drift guard ──
// Locks pre-pr-archive-gate.mjs DESIGN_MD_REQUIRED_HEADINGS (check q) ↔ every
// load-bearing carrier of the hook-enforced required-heading set:
//   (1) design-template.md line 18 `Hook-enforced required headings` declaration
//   (2) the same file's `## Exit Criteria` restatement
//   (3) openspec-quality-doc-formats.md's `### design.md` bullet enumeration
//       (design-template.md's Cross-References names this file a
//       "design.md 格式定義段", so its enumeration is a load-bearing
//       authoritative declaration, not a mere prose pointer).
// Independent extraction + deepEqual IS the lock (no hardcoded referee set);
// every extracted carrier is compared against the gate constant, so a
// single-carrier drift in any direction fails RED. Documentation-only mentions
// (gate comments, step-1-to-9 prose+pointer, dp-architect.md inline pointer,
// design-format test fixtures, recap heading structure) are enumerated with
// exclusion rationale in the change's Cross-Carrier Exhaustiveness ledger.

const gatePath = repoPath(".devpro/scripts/pre-pr-archive-gate.mjs");
const designTemplatePath = repoPath(".devpro/agent-rules/design-template.md");
const gateBody = readFileSync(gatePath, "utf8");
const designTemplateBody = readFileSync(designTemplatePath, "utf8");

function extractGateHeadings(src) {
  const m = src.match(/const\s+DESIGN_MD_REQUIRED_HEADINGS\s*=\s*\[([^\]]*)\]/);
  if (!m) return null;
  const tokens = [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((g) => g[1] ?? g[2]);
  return tokens.length ? tokens : null; // null (not []) on empty — uniform with the other three extractors
}

function templateHookLine(src) {
  return src.split("\n").find((l) => l.includes("Hook-enforced required headings")) ?? null;
}

function extractTemplateHookHeadings(src) {
  const line = templateHookLine(src);
  if (!line) return null;
  const after = line.split("Hook-enforced required headings")[1] ?? "";
  const scoped = after.split("。")[0]; // 只取 hook-enforced 段，排除句號後的 recommended
  const tokens = [...scoped.matchAll(/`(##[^`]+)`/g)].map((g) => g[1].trim());
  // null (not []) on empty — consistent with the other three extractors so the
  // `!== null` + `.length > 0` anchor tests uniformly catch anchor/extraction
  // drift; returning [] here would pass the `!== null` sanity check on a
  // present-but-empty line.
  return tokens.length ? tokens : null;
}

// Second in-file template carrier: the `## Exit Criteria` bullet that restates
// the same hook-enforced heading set (issue #1681 review — the same-file third
// copy must not drift silently either). Scope extraction to the Exit Criteria
// section so the count word and prose phrasing may change freely; only the
// backtick `## X` tokens inside that section are the locked declaration.
// Constraint: this section must restate ONLY the hook-enforced set — if a
// future edit adds another backtick `## X` here (e.g. a recommended heading),
// extraction over-matches and set-equality goes RED (fail-closed, never
// silent-green); the fix is to keep this section restating only the hook set.
function exitCriteriaSectionBounds(src) {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => /^##\s+Exit Criteria\s*$/.test(l));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s+/.test(l));
  if (end === -1) end = lines.length;
  return { lines, start, end };
}

function extractTemplateExitCriteriaHeadings(src) {
  const bounds = exitCriteriaSectionBounds(src);
  if (!bounds) return null;
  const section = bounds.lines.slice(bounds.start + 1, bounds.end).join("\n");
  const tokens = [...section.matchAll(/`(##[^`]+)`/g)].map((g) => g[1].trim());
  return tokens.length ? tokens : null;
}

// Fourth carrier: openspec-quality-doc-formats.md's `### design.md` section
// independently enumerates the hook-enforced required headings as a bullet
// list (issue #1681 review). Extraction is SECTION-SCOPED to `### design.md`
// (bounds = that header down to the next `#`/`##`/`###` heading): find the
// "hook-enforced required headings" anchor INSIDE that section, then collect the
// contiguous bullet block directly under it, stopping at the first non-bullet
// line — so the separate "recommended（非 hook-enforced）" bullet list below is
// never captured, and re-wording that boundary label cannot pull recommended
// headings into the locked set. Binding to the section (not a file-wide phrase
// match) makes a disappeared carrier fail CLOSED: deleting or renaming the
// `### design.md` header returns null → the non-empty anchor test goes RED,
// instead of silently matching the orphaned prose phrase and reporting the
// correct set while the authoritative section is gone (issue #1681 round 2).
const docFormatsPath = repoPath(".devpro/agent-rules/openspec-quality-doc-formats.md");
const docFormatsBody = readFileSync(docFormatsPath, "utf8");

function designMdSectionBounds(src) {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => /^###\s+design\.md\s*$/.test(l));
  if (start === -1) return null;
  // Section ends at the next heading of level 1–3 (`# `/`## `/`### `); a deeper
  // `#### ` child does not close it. Mirrors exitCriteriaSectionBounds's idiom.
  let end = lines.findIndex((l, i) => i > start && /^#{1,3}\s+/.test(l));
  if (end === -1) end = lines.length;
  return { lines, start, end };
}

function extractDocFormatsHookHeadings(src) {
  const bounds = designMdSectionBounds(src);
  if (!bounds) return null; // no `### design.md` section → fail closed
  const { lines, start, end } = bounds;
  const anchorIdx = lines.findIndex(
    (l, i) => i > start && i < end && l.includes("hook-enforced required headings")
  );
  if (anchorIdx === -1) return null;
  const tokens = [];
  let started = false;
  for (let i = anchorIdx + 1; i < end; i++) {
    const isBullet = /^\s*-\s+/.test(lines[i]);
    if (isBullet) {
      started = true;
      tokens.push(...[...lines[i].matchAll(/`(##[^`]+)`/g)].map((g) => g[1].trim()));
    } else if (started) {
      break;
    }
  }
  return tokens.length ? tokens : null;
}

test("pre-pr-archive-gate.mjs DESIGN_MD_REQUIRED_HEADINGS extraction anchor exists and is non-empty", () => {
  const headings = extractGateHeadings(gateBody);
  assert.ok(headings !== null, "extractGateHeadings must find the DESIGN_MD_REQUIRED_HEADINGS array literal in pre-pr-archive-gate.mjs (anchor drift?)");
  assert.ok(headings.length > 0, "DESIGN_MD_REQUIRED_HEADINGS must not be empty (extraction silently returned an empty set)");
});

test("design-template.md Hook-enforced required headings extraction anchor exists and is non-empty", () => {
  const headings = extractTemplateHookHeadings(designTemplateBody);
  assert.ok(headings !== null, "extractTemplateHookHeadings must find the 'Hook-enforced required headings' line in design-template.md (anchor drift?)");
  assert.ok(headings.length > 0, "Hook-enforced required headings segment must not be empty (extraction silently returned an empty set)");
});

test("design.md required-heading set is identical between pre-pr-archive-gate.mjs and design-template.md (bidirectional lock)", () => {
  const gateHeadings = extractGateHeadings(gateBody);
  const templateHeadings = extractTemplateHookHeadings(designTemplateBody);
  assert.deepEqual(
    [...gateHeadings].sort(),
    [...templateHeadings].sort(),
    `design.md required-heading sets diverged: gate=${JSON.stringify(gateHeadings)} vs template=${JSON.stringify(templateHeadings)} (issue #1681 SSOT cross-carrier drift)`
  );
});

test("gate-side drift (extra heading added to DESIGN_MD_REQUIRED_HEADINGS without template sync) breaks the lock", () => {
  const mutatedGateBody = gateBody.replace(
    "const DESIGN_MD_REQUIRED_HEADINGS = ['## Context', '## Decisions'];",
    "const DESIGN_MD_REQUIRED_HEADINGS = ['## Context', '## Decisions', '## Goals'];"
  );
  assert.notEqual(mutatedGateBody, gateBody, "mutation anchor string not found in gateBody — update anchor to match real file");
  const mutatedGateHeadings = extractGateHeadings(mutatedGateBody);
  const templateHeadings = extractTemplateHookHeadings(designTemplateBody);
  assert.notDeepEqual(
    [...mutatedGateHeadings].sort(),
    [...templateHeadings].sort(),
    "gate-side heading addition must be detected as drift against the unchanged template set"
  );
});

test("template-side drift (heading removed from Hook-enforced required headings line without gate sync) breaks the lock", () => {
  const originalLine = templateHookLine(designTemplateBody);
  assert.ok(originalLine !== null, "could not locate the Hook-enforced required headings line to mutate");
  const mutatedLine = originalLine.replace("`## Decisions`", "");
  assert.notEqual(mutatedLine, originalLine, "mutation anchor `## Decisions` not found on the Hook-enforced required headings line — update anchor to match real file");
  const mutatedDesignTemplateBody = designTemplateBody.replace(originalLine, mutatedLine);
  const gateHeadings = extractGateHeadings(gateBody);
  const mutatedTemplateHeadings = extractTemplateHookHeadings(mutatedDesignTemplateBody);
  assert.notDeepEqual(
    [...gateHeadings].sort(),
    [...mutatedTemplateHeadings].sort(),
    "template-side heading removal must be detected as drift against the unchanged gate set"
  );
});

test("design-template.md Exit Criteria hook-enforced restatement extraction anchor exists and is non-empty", () => {
  const headings = extractTemplateExitCriteriaHeadings(designTemplateBody);
  assert.ok(headings !== null, "extractTemplateExitCriteriaHeadings must find the '## Exit Criteria' section with backtick `## X` tokens in design-template.md (anchor drift?)");
  assert.ok(headings.length > 0, "Exit Criteria hook-enforced restatement must not be empty (extraction silently returned an empty set)");
});

test("design.md required-heading set is identical between pre-pr-archive-gate.mjs and the design-template.md Exit Criteria restatement (same-file third-carrier lock)", () => {
  const gateHeadings = extractGateHeadings(gateBody);
  const exitHeadings = extractTemplateExitCriteriaHeadings(designTemplateBody);
  assert.deepEqual(
    [...gateHeadings].sort(),
    [...exitHeadings].sort(),
    `design.md required-heading sets diverged: gate=${JSON.stringify(gateHeadings)} vs template Exit Criteria=${JSON.stringify(exitHeadings)} (issue #1681 same-file third-carrier drift)`
  );
});

test("Exit-Criteria-side drift (heading removed from the design-template.md Exit Criteria restatement without gate sync) breaks the lock", () => {
  const bounds = exitCriteriaSectionBounds(designTemplateBody);
  assert.ok(bounds !== null, "could not locate the '## Exit Criteria' section to mutate");
  // Mutate ONLY within the Exit Criteria section so line 18's declaration stays
  // intact — the first `## Decisions` occurrence in the file is line 18, so a
  // file-wide replace would mutate the wrong carrier.
  const mutatedLines = bounds.lines.map((l, i) =>
    i > bounds.start && i < bounds.end ? l.replace("`## Decisions`", "") : l
  );
  const mutatedDesignTemplateBody = mutatedLines.join("\n");
  assert.notEqual(mutatedDesignTemplateBody, designTemplateBody, "mutation anchor `## Decisions` not found within the Exit Criteria section — update anchor to match real file");
  const gateHeadings = extractGateHeadings(gateBody);
  const mutatedExitHeadings = extractTemplateExitCriteriaHeadings(mutatedDesignTemplateBody);
  assert.notDeepEqual(
    [...gateHeadings].sort(),
    [...mutatedExitHeadings].sort(),
    "Exit Criteria heading removal must be detected as drift against the unchanged gate set"
  );
});

test("openspec-quality-doc-formats.md design.md hook-enforced heading enumeration extraction anchor exists and is non-empty", () => {
  const headings = extractDocFormatsHookHeadings(docFormatsBody);
  assert.ok(headings !== null, "extractDocFormatsHookHeadings must find the 'hook-enforced required headings' bullet block in openspec-quality-doc-formats.md (anchor drift?)");
  assert.ok(headings.length > 0, "doc-formats hook-enforced heading enumeration must not be empty (extraction silently returned an empty set)");
});

test("design.md required-heading set is identical between pre-pr-archive-gate.mjs and the openspec-quality-doc-formats.md enumeration (fourth-carrier lock)", () => {
  const gateHeadings = extractGateHeadings(gateBody);
  const docHeadings = extractDocFormatsHookHeadings(docFormatsBody);
  assert.deepEqual(
    [...gateHeadings].sort(),
    [...docHeadings].sort(),
    `design.md required-heading sets diverged: gate=${JSON.stringify(gateHeadings)} vs doc-formats=${JSON.stringify(docHeadings)} (issue #1681 doc-formats cross-carrier drift)`
  );
});

test("doc-formats-side drift (heading removed from the openspec-quality-doc-formats.md enumeration without gate sync) breaks the lock", () => {
  // `- `## Decisions`` occurs once in the file (the hook-enforced bullet); the
  // recommended list below contains no `## Decisions`, so this bullet-scoped
  // replace unambiguously targets the locked enumeration.
  const mutatedDocFormatsBody = docFormatsBody.replace("- `## Decisions`", "");
  assert.notEqual(mutatedDocFormatsBody, docFormatsBody, "mutation anchor '- `## Decisions`' bullet not found in openspec-quality-doc-formats.md — update anchor to match real file");
  const gateHeadings = extractGateHeadings(gateBody);
  const mutatedDocHeadings = extractDocFormatsHookHeadings(mutatedDocFormatsBody);
  assert.notDeepEqual(
    [...gateHeadings].sort(),
    [...mutatedDocHeadings].sort(),
    "doc-formats-side heading removal must be detected as drift against the unchanged gate set"
  );
});

test("doc-formats carrier removal (`### design.md` section header renamed/deleted) makes extraction fail closed", () => {
  // issue #1681 round 2: the enumeration is authoritative ONLY inside the
  // `### design.md` section. Renaming/deleting that header must make extraction
  // return null → the non-empty anchor test above goes RED, rather than silently
  // matching the orphaned `hook-enforced required headings` prose phrase
  // elsewhere and reporting the correct set while the carrier is gone. Against
  // the pre-fix file-wide phrase match this asserted array (not null), so this
  // test reddens on the exact soundness gap the reviewer flagged.
  const mutatedDocFormatsBody = docFormatsBody.replace(/^###\s+design\.md\s*$/m, "### design-md (renamed)");
  assert.notEqual(mutatedDocFormatsBody, docFormatsBody, "mutation anchor `### design.md` section header not found in openspec-quality-doc-formats.md — update anchor to match real file");
  const mutatedDocHeadings = extractDocFormatsHookHeadings(mutatedDocFormatsBody);
  assert.equal(
    mutatedDocHeadings,
    null,
    "renaming/deleting the `### design.md` section header must make doc-formats extraction fail closed (null), so a disappeared carrier reddens the non-empty anchor assertion instead of silently passing with the orphaned prose phrase"
  );
});

// ── strengthen-control-plane-evidence R8: architect lease/deadline contract ──

test("devpro:change architect dispatch carries the exact immutable path/lease/deadline/callback schema", () => {
  const block = extractArchitectDispatchBlock(dpChangeSkillBody);
  assert.ok(block !== null, "devpro:change skill must retain an Agent({ ... dp-architect ... }) dispatch block");

  const proposalPath = "openspec/changes/<change>/proposal.md";
  const designPath = "openspec/changes/<change>/design.md";
  assert.equal(
    occurrenceCount(block, proposalPath),
    1,
    `dp-architect dispatch must claim exact path ${proposalPath} exactly once`,
  );
  assert.equal(
    occurrenceCount(block, designPath),
    1,
    `dp-architect dispatch must claim exact path ${designPath} exactly once`,
  );

  for (const field of [
    "claimed_artifact_paths:",
    "first_artifact_deadline: 30m_total",
    "writer_lease: single",
    "completion_mode: callback",
    "completion_channel: runtime completion callback/event",
  ]) {
    assert.ok(block.includes(field), `dp-architect dispatch is missing immutable field: ${field}`);
  }
});

test("dp-architect action point makes either internally valid proposal.md or design.md satisfy the first checkpoint", () => {
  assert.match(
    agentBody,
    /dp-architect first-artifact action point[^\n]*`writer_lease:\s*single`[^\n]*exact[^\n]*proposal\.md[^\n]*design\.md[^\n]*internally valid[^\n]*either[^\n]*satisfies[^\n]*30m_total/i,
    "dp-architect.md must bind one writer lease to both exact target paths and accept either internally valid proposal or design",
  );
});

test("devpro:change defines 30m_total as accepted-dispatch total elapsed time that no activity signal can reset", () => {
  assert.match(
    dpChangeSkillBody,
    /dp-architect[^\n]*accepted dispatch[^\n]*30m_total[^\n]*MUST NOT[^\n]*reset or extend[^\n]*activity[^\n]*heartbeat[^\n]*status[^\n]*poll[^\n]*message[^\n]*focused rebrief[^\n]*neither[^\n]*idle timeout[^\n]*nor[^\n]*total task timeout/i,
    "30m_total must start at accepted dispatch, resist every listed reset signal, and remain distinct from idle/total-task timeouts",
  );
});

test("devpro:change deadline miss callbacks actual state and rebriefs exactly once to the same writer", () => {
  assert.match(
    dpChangeSkillBody,
    /artifact_landing_deadline_missed[^\n]*actual state callback[^\n]*exactly one[^\n]*focused rebrief[^\n]*same writer[^\n]*MUST NOT[^\n]*second writer[^\n]*takeover[^\n]*TL fallback/i,
    "deadline miss must stay with the original writer and must not manufacture writer/takeover/fallback authority",
  );
});

test("devpro:change takeover requires authorization then original-lease revocation/inactivity before ownership transfer", () => {
  assert.match(
    dpChangeSkillBody,
    /dp-architect takeover[^\n]*explicit user replacement[^\n]*independently sufficient terminal\/interruption evidence[^\n]*MUST[^\n]*revoke[^\n]*original writer lease[^\n]*after revocation[^\n]*MUST[^\n]*confirm[^\n]*inactive[^\n]*only then[^\n]*never before[^\n]*ownership-transfer record[^\n]*missing or reordered steps[^\n]*MUST FAIL CLOSED/i,
    "takeover order must be authorization -> original lease revoke/inactive -> new ownership-transfer record",
  );
});

test("devpro:change independent design reviewer is explicitly no-write/no-claim", () => {
  assert.match(
    dpChangeSkillBody,
    /independent design reviewer[^\n]*MAY coexist[^\n]*only[^\n]*no-write[^\n]*no-claim[^\n]*MUST NOT[^\n]*(?:writer lease|write authority)/i,
    "an optional design reviewer must remain outside proposal/design write ownership",
  );
});
