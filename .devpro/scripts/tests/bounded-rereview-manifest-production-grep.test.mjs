/**
 * Locks fix-review-dispatch-gaps R1: `code-review-checklist.md` carries an
 * operator-grade `### Bounded Rereview Manifest Production` section whose
 * designated anchors stay literally bound to `review-remediation-evidence-core.mjs`
 * and the `review-remediation-evidence.mjs` CLI facade.
 *
 * The RED-first capture for this guard lives in
 * `openspec/changes/fix-review-dispatch-gaps/tasks.md` (T1); this file is the
 * drift alarm for the guidance<->core pair, not a proof that no semantic
 * rewrite happened (see `rule-anchor-guard-strength.md` — token presence cannot
 * disprove an inverted meaning; adversarial rewrites stay with review).
 *
 * Insertion axis (D3 bullet 5): every closed value set is compared as a SET
 * against a deterministic anchor in core source, both directions, so a value
 * added to either side alone goes red with the offending value named.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const CHECKLIST = ".devpro/agent-rules/code-review-checklist.md";
const CORE = ".devpro/scripts/lib/review-remediation-evidence-core.mjs";
const CLI = ".devpro/scripts/review-remediation-evidence.mjs";
const DISPATCH =
  ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md";
const SKILL = ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md";

const SECTION_HEADING = "### Bounded Rereview Manifest Production";

// D3 bullet 2: designated structural anchors. Bullet 3 additionally requires
// each of these tokens to still exist in core or CLI source, so a core rename
// (e.g. the CLI verb `seal-manifest`) turns this guard red instead of leaving
// the guidance silently stale.
const ANCHOR_TOKENS = [
  "devpro.review-remediation.manifest/v1",
  "repair-delta",
  "dependency-closure",
  "canonicalJsonV1",
  "manifest_digest_sha256",
  "root_digest_sha256",
  "change_base_sha",
  "surface_base_sha",
  "candidate_head_sha",
  "seal-manifest",
  "verify-manifest",
  "coverage",
  "dependency_edges",
  "exceptions",
];

function checklist() {
  return readFileSync(repoPath(CHECKLIST), "utf8");
}

/**
 * Bounded-unique isolation for the production section: exactly one heading at
 * line start, slice ends at the next `\n### ` (or EOF). A second heading would
 * make every downstream assertion ambiguous, so the count is reported instead
 * of silently taking the first hit (`rule-anchor-guard-strength.md` 第 1 條).
 */
function manifestProductionSection(content) {
  const matches = [...content.matchAll(/^### Bounded Rereview Manifest Production\s*$/gm)];
  assert.equal(
    matches.length,
    1,
    `Bounded Rereview Manifest Production isolation fail closed: heading count=${matches.length} (expected 1); positions=${matches.map((match) => match.index).join(",") || "none"}`,
  );
  const start = matches[0].index;
  const after = content.slice(start + matches[0][0].length);
  const terminator = after.search(/\n### /);
  return terminator === -1
    ? content.slice(start)
    : content.slice(start, start + matches[0][0].length + terminator);
}

function coreSource() {
  return readFileSync(repoPath(CORE), "utf8");
}

function cliSource() {
  return readFileSync(repoPath(CLI), "utf8");
}

function exactlyOne(source, regex, label) {
  const matches = [...source.matchAll(regex)];
  assert.equal(matches.length, 1, `expected exactly one ${label} (found ${matches.length})`);
  return matches[0];
}

function coreManifestSchema(source) {
  return exactlyOne(source, /const REVIEW_MANIFEST_SCHEMA = "([^"]+)";/g, "core REVIEW_MANIFEST_SCHEMA literal")[1];
}

function coreSetLiteral(source, name) {
  const block = exactlyOne(
    source,
    new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`, "g"),
    `core ${name} set literal`,
  )[1];
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
}

function coreValidatorProvenanceEnum(source) {
  const literal = exactlyOne(
    source,
    /\[("(?:[^"]+)"(?:,\s*"(?:[^"]+)")*)\]\.includes\(manifest\.validator\.provenance\)/g,
    "core validator provenance enum literal",
  )[1];
  return JSON.parse(`[${literal}]`).sort();
}

function coreHashLiterals(source) {
  const match = exactlyOne(
    source,
    /manifest\.hash\.algorithm !== "([^"]+)"\s*\|\|\s*manifest\.hash\.canonicalization !== "([^"]+)"/g,
    "core hash contract literal comparison",
  );
  return { algorithm: match[1], canonicalization: match[2] };
}

function coreManifestPathTemplate(source) {
  const template = exactlyOne(
    source,
    /function manifestFileName\(changeId, purpose, roundNumber\) \{\s*\n\s*return `([^`]+)`;/g,
    "core manifestFileName return template",
  )[1];
  return template
    .replace("${changeId}", "<change>")
    .replace("${purpose}", "<purpose>")
    .replace("${roundNumber}", "<N>");
}

function cliCommandLiterals(source) {
  const block = exactlyOne(
    source,
    /const CLI_COMMANDS = new Map\(\[([\s\S]*?)\]\);/g,
    "CLI_COMMANDS map literal",
  )[1];
  return [...block.matchAll(/\[\s*"([^"]+)",/g)].map((match) => match[1]);
}

/**
 * Doc-side closed-set declaration, same single-physical-line shape the existing
 * severity enum check uses: `<label>` 的 exact enum 是 `a | b | c`.
 */
function docEnumDeclaration(section, label) {
  const marker = `\`${label}\` 的 exact enum 是 \``;
  const lines = section.split("\n").filter((line) => line.includes(marker));
  assert.equal(
    lines.length,
    1,
    `expected exactly one ${label} enum declaration line in the production section (found ${lines.length})`,
  );
  const after = lines[0].slice(lines[0].indexOf(marker) + marker.length);
  const closing = after.indexOf("`");
  assert.ok(closing > 0, `${label} enum declaration line is not backtick-closed`);
  return [...new Set(
    after.slice(0, closing).split("|").map((token) => token.trim()).filter((token) => token.length > 0),
  )].sort();
}

function assertSetEqual(actual, expected, label) {
  const missing = expected.filter((value) => !actual.includes(value));
  const extra = actual.filter((value) => !expected.includes(value));
  assert.deepEqual(
    actual,
    expected,
    `${label} must be bidirectionally set-equal (missing=${missing.join(",") || "none"}; unexpected=${extra.join(",") || "none"})`,
  );
}

function dispatchStep3Slice() {
  const content = readFileSync(repoPath(DISPATCH), "utf8");
  const heading = "## Step 3: dp-reviewer dispatch (Six-Axis Review)";
  const start = content.indexOf(heading);
  assert.ok(start >= 0, "subagent-dispatch-blocks.md Step 3 heading missing");
  const after = content.slice(start + heading.length);
  const terminator = after.search(/\n## /);
  return terminator === -1 ? content.slice(start) : content.slice(start, start + heading.length + terminator);
}

test("production section is bounded-unique in code-review-checklist.md", () => {
  const section = manifestProductionSection(checklist());
  assert.ok(
    section.includes(SECTION_HEADING),
    "production section slice must start at its own heading",
  );
});

test("designated structural anchors are all present in the production section", () => {
  const section = manifestProductionSection(checklist());
  for (const token of ANCHOR_TOKENS) {
    assert.ok(section.includes(token), `production section is missing designated anchor token: ${token}`);
  }
});

test("every anchor token still exists in core or CLI source (literal drift binding, per token)", () => {
  const section = manifestProductionSection(checklist());
  const core = coreSource();
  const cli = cliSource();
  const drifted = ANCHOR_TOKENS.filter((token) => !core.includes(token) && !cli.includes(token));
  assert.deepEqual(
    drifted,
    [],
    `anchor tokens no longer present in core or CLI source (guidance would silently describe a renamed/removed carrier): ${drifted.join(", ")}`,
  );
  assert.ok(section.length > 0);
});

test("production section schema literal equals core REVIEW_MANIFEST_SCHEMA", () => {
  const section = manifestProductionSection(checklist());
  const schema = coreManifestSchema(coreSource());
  const occurrences = [...section.matchAll(/devpro\.review-remediation\.manifest\/v[0-9]+/g)].map((match) => match[0]);
  assert.equal(
    occurrences.length,
    1,
    `production section must name the manifest schema exactly once (found ${occurrences.length}: ${occurrences.join(", ") || "none"})`,
  );
  assert.equal(occurrences[0], schema, "production section schema literal must equal core REVIEW_MANIFEST_SCHEMA");
});

test("CLI_COMMANDS carries seal-manifest/verify-manifest and the section names the same literals", () => {
  const section = manifestProductionSection(checklist());
  const commands = cliCommandLiterals(cliSource());
  for (const verb of ["seal-manifest", "verify-manifest"]) {
    assert.ok(
      commands.includes(verb),
      `CLI_COMMANDS map no longer registers the ${verb} command (guidance verb would be stale)`,
    );
    assert.ok(section.includes(verb), `production section must name the CLI verb ${verb}`);
  }
});

test("production section keeps the gate-neutrality polarity on one physical line", () => {
  const section = manifestProductionSection(checklist());
  assert.match(
    section,
    /MUST NOT[^\n]*放寬或收窄[^\n]*(?:gate|判準)/,
    "production section must carry the gate-neutrality polarity sentence (single physical line: MUST NOT ... 放寬或收窄 ... gate/判準)",
  );
});

test("dispatch Step 3 points at the production section and the lineage pointer target resolves", () => {
  assert.ok(
    dispatchStep3Slice().includes("Bounded Rereview Manifest Production"),
    "subagent-dispatch-blocks.md Step 3 must point at the production section (fixture-only guidance is the gap this change closes)",
  );
  const section = manifestProductionSection(checklist());
  assert.ok(
    section.includes("pre-pr/SKILL.md"),
    "production section must name the lineage SSOT pointer target (`pre-pr/SKILL.md` §manifest lineage) instead of restating the surface_base_sha equality",
  );
  const skillLines = readFileSync(repoPath(SKILL), "utf8")
    .split("\n")
    .filter((line) => line.includes("**manifest lineage**"));
  assert.equal(
    skillLines.length,
    1,
    `expected exactly one SKILL.md manifest lineage line (pointer target; found ${skillLines.length})`,
  );
  assert.ok(skillLines[0].includes("surface_base_sha"), "SKILL.md lineage line must define the surface_base_sha equality");
  assert.ok(skillLines[0].includes("lineage.head_sha"), "SKILL.md lineage line must name the predecessor lineage.head_sha");
});

test("result and validator provenance enums are bidirectionally set-equal to core", () => {
  const section = manifestProductionSection(checklist());
  const core = coreSource();
  assertSetEqual(
    docEnumDeclaration(section, "result"),
    coreSetLiteral(core, "MANIFEST_RESULTS"),
    "production section result enum vs core MANIFEST_RESULTS",
  );
  assertSetEqual(
    docEnumDeclaration(section, "validator.provenance"),
    coreValidatorProvenanceEnum(core),
    "production section validator provenance enum vs core provenance literal",
  );
});

test("manifest purposes and dependency edge kinds are bidirectionally set-equal to core", () => {
  const section = manifestProductionSection(checklist());
  const core = coreSource();
  assertSetEqual(
    docEnumDeclaration(section, "purpose"),
    coreSetLiteral(core, "MANIFEST_PURPOSES"),
    "production section purpose enum vs core MANIFEST_PURPOSES",
  );
  assertSetEqual(
    docEnumDeclaration(section, "dependency_edges[].kind"),
    coreSetLiteral(core, "EDGE_KINDS"),
    "production section dependency edge kind enum vs core EDGE_KINDS",
  );
});

test("hash literals are bidirectionally equal to core's hash contract", () => {
  const section = manifestProductionSection(checklist());
  const marker = "`hash` 的 exact 值：";
  const lines = section.split("\n").filter((line) => line.includes(marker));
  assert.equal(lines.length, 1, `expected exactly one hash literal declaration line (found ${lines.length})`);
  const after = lines[0].slice(lines[0].indexOf(marker) + marker.length);
  const declared = {};
  for (const pair of after.matchAll(/`([a-z]+)`＝`([^`]+)`/g)) declared[pair[1]] = pair[2];
  const coreHash = coreHashLiterals(coreSource());
  assertSetEqual(Object.keys(declared).sort(), ["algorithm", "canonicalization"], "hash declaration keys");
  assert.equal(declared.algorithm, coreHash.algorithm, "hash.algorithm literal must equal core's");
  assert.equal(declared.canonicalization, coreHash.canonicalization, "hash.canonicalization literal must equal core's");
});

test("sealed manifest path template matches core manifestFileName", () => {
  const section = manifestProductionSection(checklist());
  const coreTemplate = coreManifestPathTemplate(coreSource());
  assert.ok(
    section.includes(`notes/${coreTemplate}`),
    `production section must state the sealed carrier path notes/${coreTemplate} (derived from core manifestFileName + the notes root)`,
  );
  assert.ok(
    section.includes(`\`${coreTemplate}\``),
    `production section must state the ref.path form \`${coreTemplate}\` (notes-root-relative, no notes/ prefix — core refOwnedByChange compares ref.path === manifestFileName)`,
  );
  assert.match(
    coreSource(),
    /ref\.path === filePattern/,
    "core refOwnedByChange must still compare ref.path against the notes-root-relative file name — the section's no-`notes/`-prefix claim would silently invert if that equality became prefix-tolerant",
  );
});

// ── Scenario bindings for openspec/changes/fix-review-dispatch-gaps/
//    specs/code-review-checklist/spec.md (lint-delta-new-scenario-assertion-coverage).

test("Scenario: Operator produces a compliant manifest from guidance alone", () => {
  const section = manifestProductionSection(checklist());
  for (const token of [
    "seal-manifest --request",
    "verify-manifest --request",
    "sha256Hex(canonicalJsonV1(entries))",
    "canonical-json-v1",
    "candidate_head_sha",
  ]) {
    assert.ok(section.includes(token), `operator-grade step or digest layer missing from the production section: ${token}`);
  }
});

test("Scenario: Guidance drift from core fails mechanically", () => {
  const section = manifestProductionSection(checklist());
  const core = coreSource();
  // Negative control: a one-token mutation of the declared edge-kind set must be
  // caught by the same set-equality that binds the section to core, so the guard
  // is a drift alarm rather than a re-implementation of validateManifestRecord.
  const mutated = section.replace("`import | reference", "`imports | reference");
  assert.notEqual(
    mutated,
    section,
    "mutation-probe target not found; keep the dependency_edges[].kind enum line shape stable",
  );
  assert.throws(
    () => assertSetEqual(
      docEnumDeclaration(mutated, "dependency_edges[].kind"),
      coreSetLiteral(core, "EDGE_KINDS"),
      "mutation probe: drifted kind set vs core EDGE_KINDS",
    ),
    /bidirectionally set-equal/,
    "a drifted closed value set must fail the bidirectional set-equality binding",
  );
});

test("Scenario: Guidance does not widen any gate", () => {
  const section = manifestProductionSection(checklist());
  assert.match(
    section,
    /MUST NOT[^\n]*放寬或收窄[^\n]*(?:gate|判準)/,
    "the gate-neutrality polarity sentence must stay on one physical line",
  );
  // Bounded negative probe, not a semantic proof (guard limits per
  // rule-anchor-guard-strength.md): a widening instruction would have to name
  // one of these closed tokens.
  for (const token of ["--force", "bypass", "略過驗證"]) {
    assert.ok(!section.includes(token), `production section must not carry a gate-widening token: ${token}`);
  }
});
