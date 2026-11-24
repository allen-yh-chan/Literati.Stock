/**
 * skill-entry-rename-sweep-guard.test.mjs
 *
 * Guard for the mechanical rename sweep of the 2-entry skill topology
 * migration (design D10 / tasks.md T7-T8 of change
 * refactor-agent-skills-entry), which renamed the 18 `dp-*` skill
 * identifiers to their bare form across every live carrier; this guard
 * keeps the live tree free of stale-token residue.
 *
 * `scanLegacySkillTokens` is a pure exact-token scanner shared by the guard
 * and its own prove-it fixtures. Exemptions are NOT file-level — each one
 * binds to a specific `const`, a `legacy-skill-names:begin/end <id>` marker
 * section, or (for sealed, comment-free JSON receipt fixtures that cannot
 * carry markers) a whole-file `file-digest` anchor gated on the file's
 * current sha256 equaling a pinned value, with an exact expected per-token occurrence
 * count for that section. Anything outside a bound section, or any count
 * mismatch inside one, is a violation; an unresolvable anchor (missing
 * const, unpaired/duplicate marker) fails closed instead of silently
 * passing.
 *
 * Self-discipline: the ONLY place this file may contain an old name as a
 * literal substring is the `LEGACY_SKILL_NAMES` declaration below (which is
 * itself bound by NAMED_EXEMPTIONS' self-entry, mirroring how
 * `sync-agent-rules.mjs` and `legacy-skill-entry-artifacts.mjs` bind their
 * own frozen allowlists). Every other reference in this file — fixtures
 * included — is built at runtime from that array (or from a destructured
 * named binding to one of its elements), so the full-tree scan below never
 * sees a second literal copy of any old name in this file's own source
 * text.
 *
 * Scenario: a stale token outside any exempted section is a violation
 * Scenario: a token's count inside an exempted section must equal `expected`
 *   exactly — too many or too few both fail
 * Scenario: an unresolvable anchor (missing end marker, duplicate marker
 *   id, or a const that isn't found) fails closed rather than passing
 * Scenario: an old name in a file with no exemptions at all is a violation
 * Scenario: no live carrier (tracked files outside `openspec/changes/**`,
 *   symlink blobs excluded) contains a dangling old entry-path or
 *   retired-refs-root literal, backslash- and `./`-normalized
 * Scenario: every new-topology path literal in a live carrier outside
 *   `.devpro/scripts/tests/` names a tracked path (placeholder-aware)
 * Scenario: the frozen legacy-carrier constants that must keep the old
 *   names (so consumer residue can still be recognized and pruned) still
 *   hold them
 *
 * Teeth: the three live full-tree scans fail on any old-name token, old
 * entry path, or new-topology path that does not exist, left in a live
 * carrier outside the exemptions below (design D10).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";

// ---------------------------------------------------------------------------
// The 18 renamed identifiers (design D10). See the file-header note above:
// this array is the single literal source for every old name used anywhere
// in this file.
// ---------------------------------------------------------------------------
const LEGACY_SKILL_NAMES = Object.freeze([
  "dp-change",
  "dp-clarify",
  "dp-consumer-doctor",
  "dp-cross-review",
  "dp-init",
  "dp-knowledge-distill",
  "dp-knowledge-ingest",
  "dp-load-plan",
  "dp-pre-pr",
  "dp-recap-writer",
  "dp-release-runbook",
  "dp-rule-governance",
  "dp-second-review-dogfood",
  "dp-second-review",
  "dp-security-scan",
  "dp-setup-ci",
  "dp-sync-rules",
  "dp-workflows",
]);

// Named bindings to individual elements (positional destructure, NOT a new
// literal) so callers below can build per-token expectation maps and
// fixtures without re-typing any old name a second time.
const [
  CHANGE,
  CLARIFY,
  CONSUMER_DOCTOR,
  CROSS_REVIEW,
  INIT,
  KNOWLEDGE_DISTILL,
  KNOWLEDGE_INGEST,
  LOAD_PLAN,
  PRE_PR,
  RECAP_WRITER,
  RELEASE_RUNBOOK,
  RULE_GOVERNANCE,
  SECOND_REVIEW_DOGFOOD,
  SECOND_REVIEW,
  SECURITY_SCAN,
  SETUP_CI,
  SYNC_RULES,
  WORKFLOWS,
] = LEGACY_SKILL_NAMES;

// Two names whose SSOT directory keeps its name forever (only their
// per-skill discovery LINK retires under the 2-entry topology, design D5).
// Not part of the rename set, so NOT scanned by scanLegacySkillTokens; only
// used by the dangling entry-path check below.
const RETIRED_ENTRY_ONLY_NAMES = Object.freeze([
  "cmux-surface-comms",
  "openspec-artifact-authoring",
]);

// Longer names first (defense-in-depth; exact-token boundary matching below
// already makes containment impossible on its own, since a hyphen or
// alnum character immediately following a shorter renamed name fails the
// trailing boundary check, so it can never also consume a longer
// do-not-rename compound token that merely starts with it — see the
// "boundary containment" fixture below for a concrete pair).
const SCAN_ORDER = Object.freeze([...LEGACY_SKILL_NAMES].sort((a, b) => b.length - a.length));

function escapeForRegex(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Exact-token boundary: a match is only real if immediately preceded by
// start-of-text or a non-alnum/non-hyphen character, and immediately
// followed (zero-width lookahead, so the boundary character itself is
// never consumed and can double as the leading boundary of an adjacent
// match) by a non-alnum/non-hyphen character or end-of-text.
function buildTokenRegex(name) {
  return new RegExp(`(^|[^A-Za-z0-9-])(${escapeForRegex(name)})(?=[^A-Za-z0-9-]|$)`, "g");
}

function findTokenPositions(text, name) {
  const re = buildTokenRegex(name);
  const positions = [];
  let match;
  while ((match = re.exec(text))) {
    const pos = match.index + match[1].length;
    positions.push(pos);
    re.lastIndex = pos + name.length;
  }
  return positions;
}

/**
 * Finds the `{ start, end }` char range of `const <constName> = ...;` (an
 * optional `export ` prefix is fine — the search looks for `const NAME =`
 * anywhere) by bracket-depth scanning forward from the `=` until the
 * outermost `(`/`[`/`{` group closes, consuming a trailing `;` if present.
 * String literals are skipped so bracket-like characters inside path
 * strings never confuse the depth counter. Returns null if the const
 * declaration isn't found or its brackets never close.
 */
function findConstSectionRange(text, constName) {
  const declPattern = new RegExp(`\\bconst\\s+${escapeForRegex(constName)}\\s*=`);
  const match = declPattern.exec(text);
  if (!match) return null;
  const start = match.index;
  let i = match.index + match[0].length;
  let depth = 0;
  let opened = false;
  let inString = null;
  let escaped = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      opened = true;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (opened && depth === 0) {
        let end = i + 1;
        if (text[end] === ";") end += 1;
        return { start, end };
      }
      continue;
    }
    if (ch === ";" && !opened) {
      return { start, end: i + 1 };
    }
  }
  return null;
}

/**
 * Resolves a paired `legacy-skill-names:begin <id>` / `legacy-skill-names:end
 * <id>` marker section for `id` (comment syntax around the marker text is
 * irrelevant — JS/mjs line comments, HTML comments in markdown, etc. all
 * contain the same marker substring). Fails closed (returns `{ error }`,
 * never a section) on: no begin, more than one begin (duplicate id), no
 * end, more than one end, or an end that precedes its begin.
 */
function resolveMarkerSection(text, id) {
  const beginRe = /legacy-skill-names:begin\s+(\S+)/g;
  const endRe = /legacy-skill-names:end\s+(\S+)/g;
  const begins = [];
  const ends = [];
  let m;
  while ((m = beginRe.exec(text))) {
    if (m[1] === id) begins.push({ index: m.index, end: m.index + m[0].length });
  }
  while ((m = endRe.exec(text))) {
    if (m[1] === id) ends.push({ index: m.index, end: m.index + m[0].length });
  }
  if (begins.length === 0) return { error: "missing-begin" };
  if (begins.length > 1) return { error: "duplicate-id" };
  if (ends.length === 0) return { error: "missing-end" };
  if (ends.length > 1) return { error: "duplicate-id" };
  const [begin] = begins;
  const [end] = ends;
  if (end.index < begin.end) return { error: "unpaired" };
  return { start: begin.end, end: end.index };
}

function sha256Hex(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/**
 * Third anchor kind (design D10 item 3): exempts an entire sealed,
 * comment-free JSON receipt fixture whose bytes are digest-bound and MUST
 * NOT be edited to carry markers. The whole file is the section, but ONLY
 * while its current sha256 equals the pinned `sha256` — any edit (rename
 * sweep or otherwise) changes the digest and the anchor fails closed
 * (`digest-mismatch`), so its content falls through to the stale-token /
 * dangling-path scan exactly as if unexempted. `expected` counts are still
 * enforced against the whole-file section when the digest matches.
 */
function resolveFileDigestSection(text, anchor) {
  if (sha256Hex(text) !== anchor.sha256) return { error: "digest-mismatch" };
  return { start: 0, end: text.length };
}

function resolveAnchorSection(text, anchor) {
  if (anchor.kind === "const") {
    const range = findConstSectionRange(text, anchor.name);
    if (!range) return { error: "const-not-found" };
    return range;
  }
  if (anchor.kind === "marker") return resolveMarkerSection(text, anchor.id);
  if (anchor.kind === "file-digest") return resolveFileDigestSection(text, anchor);
  return { error: "unknown-anchor-kind" };
}

/**
 * Pure exact-token scanner (design D10, F-rase-r1-04). For every file,
 * resolves each exemption bound to that file's path into a char range
 * ("section"); an unresolvable anchor itself becomes a violation and
 * contributes NO section (fail closed — content that would have been
 * inside it is treated as unprotected, i.e. still scanned as stale). Then,
 * for each of the 18 legacy names, every occurrence is bucketed into
 * "inside section N" or "stale" (outside every section); a stale bucket
 * with count > 0 is a violation, and any section whose per-token count
 * differs from that section's `expected[token] ?? 0` (in either direction)
 * is a violation.
 */
export function scanLegacySkillTokens({ files, exemptions }) {
  const violations = [];
  for (const file of files) {
    const fileExemptions = exemptions.filter((exemption) => exemption.path === file.path);
    const sections = [];
    for (const exemption of fileExemptions) {
      const resolved = resolveAnchorSection(file.text, exemption.anchor);
      if (resolved.error) {
        violations.push({
          type: "anchor-error",
          path: file.path,
          anchor: exemption.anchor,
          reason: resolved.error,
        });
        continue;
      }
      sections.push({
        start: resolved.start,
        end: resolved.end,
        expected: exemption.expected ?? {},
        anchor: exemption.anchor,
      });
    }

    for (const name of SCAN_ORDER) {
      const positions = findTokenPositions(file.text, name);
      if (positions.length === 0) continue;
      let staleCount = 0;
      const perSectionCount = sections.map(() => 0);
      for (const pos of positions) {
        const sectionIndex = sections.findIndex((section) => pos >= section.start && pos < section.end);
        if (sectionIndex === -1) staleCount++;
        else perSectionCount[sectionIndex]++;
      }
      if (staleCount > 0) {
        violations.push({ type: "stale-token", path: file.path, token: name, count: staleCount });
      }
      sections.forEach((section, sectionIndex) => {
        const expectedCount = section.expected[name] ?? 0;
        const actualCount = perSectionCount[sectionIndex];
        if (actualCount !== expectedCount) {
          violations.push({
            type: "section-count-mismatch",
            path: file.path,
            token: name,
            count: actualCount,
            expected: expectedCount,
            anchor: section.anchor,
          });
        }
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// NAMED_EXEMPTIONS: real legacy carriers measured against their CURRENT
// exact counts (F-rase-r1-04). Each entry binds to one const/marker
// section: a carrier that must keep old names gets a
// `legacy-skill-names:begin/end` marker and an entry here with its exact
// count. The one exception is a sealed fixture that cannot carry a marker
// (a comment-free JSON receipt): it takes a whole-file `file-digest` entry
// that applies only while the file's sha256 equals the pinned value
// (design D10).
// ---------------------------------------------------------------------------
const SELF_PATH = ".devpro/scripts/tests/skill-entry-rename-sweep-guard.test.mjs";

const EXPECTED_ONE_EACH = Object.freeze(Object.fromEntries(LEGACY_SKILL_NAMES.map((name) => [name, 1])));
const EXPECTED_FOUR_EACH = Object.freeze(Object.fromEntries(LEGACY_SKILL_NAMES.map((name) => [name, 4])));
const EXPECTED_PAYLOAD_FILES_COUNTS = Object.freeze({
  [CHANGE]: 1,
  [CLARIFY]: 1,
  [CONSUMER_DOCTOR]: 1,
  [CROSS_REVIEW]: 3,
  [INIT]: 1,
  [KNOWLEDGE_DISTILL]: 1,
  [KNOWLEDGE_INGEST]: 1,
  [LOAD_PLAN]: 1,
  [PRE_PR]: 2,
  [RECAP_WRITER]: 1,
  [RELEASE_RUNBOOK]: 1,
  [RULE_GOVERNANCE]: 1,
  [SECOND_REVIEW_DOGFOOD]: 1,
  [SECOND_REVIEW]: 1,
  [SECURITY_SCAN]: 3,
  [SETUP_CI]: 4,
  [SYNC_RULES]: 1,
  [WORKFLOWS]: 2,
});

const NAMED_EXEMPTIONS = Object.freeze([
  {
    path: ".devpro/scripts/sync-agent-rules.mjs",
    anchor: { kind: "const", name: "LEGACY_CURSOR_SKILL_DISCOVERY_ARTIFACTS" },
    expected: EXPECTED_ONE_EACH,
    reason:
      "fixed 20-name `.cursor/skills/<name>` legacy allowlist (design D2) — one literal per old name, by construction",
  },
  {
    path: ".devpro/scripts/lib/legacy-skill-entry-artifacts.mjs",
    anchor: { kind: "const", name: "LEGACY_SKILL_ENTRY_LINKS" },
    expected: EXPECTED_FOUR_EACH,
    reason:
      "frozen shipped-literal allowlist for the 18 renamed per-skill discovery links (2 discovery roots x 2 tokens per path: the `.agents|.claude/skills/<name>` path segment itself, plus its `shippedTargets` literal)",
  },
  {
    path: ".devpro/scripts/lib/legacy-skill-entry-artifacts.mjs",
    anchor: { kind: "const", name: "LEGACY_SKILL_PAYLOAD_FILES" },
    expected: EXPECTED_PAYLOAD_FILES_COUNTS,
    reason:
      "frozen SSOT-payload path allowlist (design D5) — each `path` key is the historical (pre-rename) on-disk location consumer residue is checked against, so it MUST keep the old name",
  },
  {
    path: SELF_PATH,
    anchor: { kind: "const", name: "LEGACY_SKILL_NAMES" },
    expected: EXPECTED_ONE_EACH,
    reason: "this guard's own token list — the only place an old name may appear verbatim in this file",
  },
  {
    path: ".devpro/scripts/lib/legacy-skill-entry-artifacts.mjs",
    anchor: { kind: "marker", id: "legacy-payload-generator-doc" },
    expected: {},
    reason:
      "JSDoc reproduction command for LEGACY_SKILL_PAYLOAD_FILES (design D5) — documents the exact `git ls-tree` invocation against historical refs, so it must keep the retired `.devpro/agent-skills/(autonomous-ai-agents|documentation|templates)` refs-root literals it was generated against",
  },
  {
    path: ".devpro/scripts/tests/sync-agent-rules-check.test.mjs",
    anchor: { kind: "marker", id: "fixed-20-name-cursor-allowlist" },
    expected: EXPECTED_ONE_EACH,
    reason:
      "independent hand-copied 20-name oracle for the `.cursor/skills/<name>` legacy discovery allowlist (design D2/D10) — deliberately NOT imported from sync-agent-rules.mjs so the fixture proves the engine's list against a second source, not against itself",
  },
  {
    path: ".devpro/scripts/tests/sync-agent-rules-check.test.mjs",
    anchor: { kind: "marker", id: "cursor-legacy-shipped-literal-target" },
    expected: { [SECOND_REVIEW]: 2 },
    reason:
      "createCursorSkillDiscoveryArtifact()'s fixed SSOT-literal link target for `.cursor/skills/<name>` legacy artifacts (design D5) — mirrors a historically shipped pre-rename literal regardless of which allowlisted `name` the fixture is building",
  },
  {
    path: ".devpro/scripts/tests/sync-agent-rules-check.test.mjs",
    anchor: { kind: "marker", id: "dangling-name-pick" },
    expected: { [WORKFLOWS]: 1 },
    reason: "picks one member of the legacy .cursor/skills allowlist to exercise the dangling-symlink variant",
  },
  {
    path: ".devpro/scripts/tests/sync-agent-rules-check.test.mjs",
    anchor: { kind: "marker", id: "failing-name-pick" },
    expected: { [KNOWLEDGE_DISTILL]: 1 },
    reason: "picks one member of the legacy .cursor/skills allowlist to exercise the forced-removal-failure variant",
  },
  {
    path: ".devpro/scripts/tests/sync-agent-rules-check.test.mjs",
    anchor: { kind: "marker", id: "residue-name-pick" },
    expected: { [CLARIFY]: 1 },
    reason: "picks one member of the legacy .cursor/skills allowlist to exercise the residue-fails-check variant",
  },
  {
    path: ".devpro/scripts/tests/sync-agent-rules-legacy-skill-entry.test.mjs",
    anchor: { kind: "marker", id: "legacy-entry-link-payload-classification" },
    expected: { [CHANGE]: 4, [INIT]: 3 },
    reason:
      `classifyLegacySkillEntryLink/classifyLegacySkillPayloadFile prove-its (design D5) fixture against the frozen \`.agents/skills/${CHANGE}\` entry link and \`${INIT}/SKILL.md\` payload — models pre-migration shipped literals and consumer-built collisions, never the current catalog`,
  },
  {
    path: ".devpro/scripts/tests/sync-agent-rules-legacy-skill-entry.test.mjs",
    anchor: { kind: "marker", id: "legacy-entry-residue-check-fixtures" },
    expected: { [CHANGE]: 2 },
    reason:
      `exit-30 residue check prove-its (design D6/D7) reuse the same frozen \`.agents/skills/${CHANGE}\` entry link to seed owned/not-owned residue before/after --sync`,
  },
  {
    path: ".devpro/scripts/tests/sync-agent-rules-uninstall-b.test.mjs",
    anchor: { kind: "marker", id: "uninstall-leftover-symlink-name-prose" },
    expected: { [WORKFLOWS]: 1 },
    reason:
      "prose naming the example per-skill symlink name the tests below manually place — the slim source's own current skill was renamed to `workflows` in this same file's `skillRel`, but this leftover-artifact simulation deliberately keeps the pre-migration per-skill link name",
  },
  {
    path: ".devpro/scripts/tests/sync-agent-rules-uninstall-b.test.mjs",
    anchor: { kind: "marker", id: "uninstall-leftover-per-skill-symlink-fixtures" },
    expected: { [WORKFLOWS]: 33 },
    reason:
      `each test manually places a \`.agents/skills/${WORKFLOWS}\`-named symlink/plain-file/plain-dir alongside the current \`devpro\` entry to simulate a consumer that has not yet run --sync against the current source and still holds a per-skill link from before the 2-entry migration (design D3) — --uninstall's generic devpro-owned-symlink removal must still find and remove it regardless of name`,
  },
  {
    path: ".devpro/scripts/tests/diagnosis-go-reentry-grep.test.mjs",
    anchor: { kind: "marker", id: "diagnosis-go-reentry-archived-proposal-mini" },
    expected: { [CHANGE]: 1 },
    reason:
      "asserts against openspec/changes/archive/2026-07-14-strengthen-diagnosis-go-reentry/proposal-mini.md, which is never rewritten — the archived proposal-mini literally contains the pre-rename invocation form",
  },
  {
    path: ".devpro/scripts/tests/scenario-omission-disclosure-axis-grep.test.mjs",
    anchor: { kind: "marker", id: "scenario-omission-archived-spec-delta" },
    expected: { [SECOND_REVIEW]: 1 },
    reason:
      "asserts against openspec/changes/archive/2026-07-16-strengthen-scenario-omission-visibility/specs/code-review-checklist/spec.md, which is never rewritten — the archived requirement text literally names the pre-rename skill",
  },
  {
    path: ".devpro/scripts/tests/fixtures/d30-post-hoc-authority/review-fix-zero-value-review-rounds-receipt-r1.json",
    anchor: {
      kind: "file-digest",
      sha256: "50f00c453b655c037b5db91ac8a1109d57c573178661ad110946ec503d4f51cb",
    },
    expected: { [PRE_PR]: 2 },
    reason:
      "sealed digest-bound reviewer receipt fixture (r1) — a historical finding's own evidence text names the pre-rename SSOT path verbatim; the fixture is byte-exact reviewer output and cannot carry markers, so the whole file is exempt only while its sha256 matches this pinned value",
  },
  {
    path: ".devpro/scripts/tests/fixtures/d30-post-hoc-authority/review-fix-zero-value-review-rounds-receipt-r3.json",
    anchor: {
      kind: "file-digest",
      sha256: "ca22cb642fd9f6e3e0b6f7e93d66027d6ef3b6240b880128768fc3cbcb425337",
    },
    expected: { [PRE_PR]: 1 },
    reason:
      "sealed digest-bound reviewer receipt fixture (r3) — same pre-rename SSOT path reference carried forward from r1's evidence text; digest-bound for the same reason",
  },
]);

// ---------------------------------------------------------------------------
// Live-carrier collection shared by both live-tree describes below.
// ---------------------------------------------------------------------------
let cachedLiveCarrierFiles = null;

function collectLiveCarrierFiles() {
  if (cachedLiveCarrierFiles) return cachedLiveCarrierFiles;
  const raw = execFileSync("git", ["ls-files", "-s", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = [];
  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const mode = entry.slice(0, tab).split(" ")[0];
    const relPath = entry.slice(tab + 1);
    if (mode === "120000") continue; // symlink blob — never scanned as text
    if (relPath.startsWith("openspec/changes/")) continue; // staged work docs, not canonical carriers
    let text;
    try {
      text = readFileSync(repoPath(relPath), "utf8");
    } catch {
      continue; // unreadable / absent on disk despite being indexed — nothing to scan
    }
    if (text.includes("\u0000")) continue; // binary guard
    files.push({ path: relPath, text });
  }
  cachedLiveCarrierFiles = files;
  return files;
}

function topLevelDir(relPath) {
  const slash = relPath.indexOf("/");
  return slash === -1 ? relPath : relPath.slice(0, slash);
}

function summarizeByTopLevelDir(items, pathOf) {
  const byDir = {};
  for (const item of items) {
    const dir = topLevelDir(pathOf(item));
    byDir[dir] = (byDir[dir] ?? 0) + 1;
  }
  return byDir;
}

describe("scanLegacySkillTokens prove-it fixtures (synthetic; permanent)", () => {
  it("Scenario: stale token outside the exempted section fails", () => {
    const text =
      `const before = "unrelated header";\n` +
      `const FIXTURE_NAMES = [\n  "${CHANGE}",\n];\n` +
      `const after = "/${CHANGE} appears again here, outside the exempt section";\n`;
    const files = [{ path: "fixtures/case1.mjs", text }];
    const exemptions = [
      {
        path: "fixtures/case1.mjs",
        anchor: { kind: "const", name: "FIXTURE_NAMES" },
        expected: { [CHANGE]: 1 },
      },
    ];
    const violations = scanLegacySkillTokens({ files, exemptions });
    assert.deepEqual(violations, [{ type: "stale-token", path: "fixtures/case1.mjs", token: CHANGE, count: 1 }]);
  });

  it("Scenario: a count inside the exempted section that exceeds `expected` fails", () => {
    const text = `const FIXTURE_NAMES = [\n  "${CHANGE}",\n  "${CHANGE}",\n];\n`;
    const files = [{ path: "fixtures/case2.mjs", text }];
    const exemptions = [
      {
        path: "fixtures/case2.mjs",
        anchor: { kind: "const", name: "FIXTURE_NAMES" },
        expected: { [CHANGE]: 1 },
      },
    ];
    const violations = scanLegacySkillTokens({ files, exemptions });
    assert.deepEqual(violations, [
      {
        type: "section-count-mismatch",
        path: "fixtures/case2.mjs",
        token: CHANGE,
        count: 2,
        expected: 1,
        anchor: { kind: "const", name: "FIXTURE_NAMES" },
      },
    ]);
  });

  it("Scenario: an exact count inside the section, with none outside, passes", () => {
    const text = `const FIXTURE_NAMES = [\n  "${CHANGE}",\n  "${CLARIFY}",\n];\n`;
    const files = [{ path: "fixtures/case3.mjs", text }];
    const exemptions = [
      {
        path: "fixtures/case3.mjs",
        anchor: { kind: "const", name: "FIXTURE_NAMES" },
        expected: { [CHANGE]: 1, [CLARIFY]: 1 },
      },
    ];
    assert.deepEqual(scanLegacySkillTokens({ files, exemptions }), []);
  });

  it("Scenario: an unresolvable anchor fails closed (missing end marker, duplicate id, missing const)", () => {
    // missing end marker — the section never resolves, so the token inside
    // the unclosed region is ALSO reported stale (fail closed, not silently
    // exempted).
    const missingEndText = `// legacy-skill-names:begin case-missing-end\nconst x = "${CHANGE}";\n`;
    const missingEndViolations = scanLegacySkillTokens({
      files: [{ path: "fixtures/case4-missing-end.mjs", text: missingEndText }],
      exemptions: [
        {
          path: "fixtures/case4-missing-end.mjs",
          anchor: { kind: "marker", id: "case-missing-end" },
          expected: { [CHANGE]: 1 },
        },
      ],
    });
    assert.deepEqual(missingEndViolations, [
      {
        type: "anchor-error",
        path: "fixtures/case4-missing-end.mjs",
        anchor: { kind: "marker", id: "case-missing-end" },
        reason: "missing-end",
      },
      { type: "stale-token", path: "fixtures/case4-missing-end.mjs", token: CHANGE, count: 1 },
    ]);

    // duplicate marker id — two begin/end pairs claim the same id.
    const duplicateIdText =
      `// legacy-skill-names:begin case-dup\n"${CHANGE}"\n// legacy-skill-names:end case-dup\n` +
      `// legacy-skill-names:begin case-dup\n"unrelated"\n// legacy-skill-names:end case-dup\n`;
    const duplicateIdViolations = scanLegacySkillTokens({
      files: [{ path: "fixtures/case4-dup-id.mjs", text: duplicateIdText }],
      exemptions: [
        {
          path: "fixtures/case4-dup-id.mjs",
          anchor: { kind: "marker", id: "case-dup" },
          expected: { [CHANGE]: 1 },
        },
      ],
    });
    assert.deepEqual(duplicateIdViolations, [
      {
        type: "anchor-error",
        path: "fixtures/case4-dup-id.mjs",
        anchor: { kind: "marker", id: "case-dup" },
        reason: "duplicate-id",
      },
      { type: "stale-token", path: "fixtures/case4-dup-id.mjs", token: CHANGE, count: 1 },
    ]);

    // const name that doesn't exist anywhere in the file.
    const missingConstText = `const SOMETHING_ELSE = 1;\n`;
    const missingConstViolations = scanLegacySkillTokens({
      files: [{ path: "fixtures/case4-missing-const.mjs", text: missingConstText }],
      exemptions: [
        {
          path: "fixtures/case4-missing-const.mjs",
          anchor: { kind: "const", name: "DOES_NOT_EXIST" },
          expected: {},
        },
      ],
    });
    assert.deepEqual(missingConstViolations, [
      {
        type: "anchor-error",
        path: "fixtures/case4-missing-const.mjs",
        anchor: { kind: "const", name: "DOES_NOT_EXIST" },
        reason: "const-not-found",
      },
    ]);
  });

  it("Scenario: an old name in a file with no exemptions at all fails", () => {
    const text = `some prose mentioning ${CHANGE} exactly once, with no bound exemption for this path`;
    const files = [{ path: "fixtures/case5-non-exempt.mjs", text }];
    const violations = scanLegacySkillTokens({ files, exemptions: [] });
    assert.deepEqual(violations, [
      { type: "stale-token", path: "fixtures/case5-non-exempt.mjs", token: CHANGE, count: 1 },
    ]);
  });

  it("boundary containment: a shorter name never matches inside a longer compound token", () => {
    const text = `${SECOND_REVIEW_DOGFOOD} dp-second-reviewer ${SECOND_REVIEW}`;
    assert.deepEqual(findTokenPositions(text, SECOND_REVIEW), [text.lastIndexOf(SECOND_REVIEW)]);
    const changeText = `dp-change-batch dp-change-environment-checks ${CHANGE}`;
    assert.deepEqual(findTokenPositions(changeText, CHANGE), [changeText.lastIndexOf(CHANGE)]);
  });

  it("Scenario: a file-digest anchor exempts the whole file only while the digest matches", () => {
    const text = `{"sealed":"receipt","note":"${CHANGE}"}`;
    const files = [{ path: "fixtures/case6-digest.json", text }];
    const matchingExemptions = [
      {
        path: "fixtures/case6-digest.json",
        anchor: { kind: "file-digest", sha256: sha256Hex(text) },
        expected: { [CHANGE]: 1 },
      },
    ];
    assert.deepEqual(scanLegacySkillTokens({ files, exemptions: matchingExemptions }), []);

    // A single edited byte changes the digest; the anchor fails closed
    // (`digest-mismatch`) and the previously-exempt content falls through
    // to the ordinary stale-token scan, rather than silently passing.
    const editedText = `{"sealed":"receipt","note":"${CHANGE}","edited":true}`;
    const mismatchViolations = scanLegacySkillTokens({
      files: [{ path: "fixtures/case6-digest.json", text: editedText }],
      exemptions: matchingExemptions,
    });
    assert.deepEqual(mismatchViolations, [
      {
        type: "anchor-error",
        path: "fixtures/case6-digest.json",
        anchor: { kind: "file-digest", sha256: sha256Hex(text) },
        reason: "digest-mismatch",
      },
      { type: "stale-token", path: "fixtures/case6-digest.json", token: CHANGE, count: 1 },
    ]);

    // Digest matches, but `expected` for the section is wrong: counts are
    // still enforced against a matched file-digest section, not waived.
    const wrongExpectedExemptions = [
      {
        path: "fixtures/case6-digest.json",
        anchor: { kind: "file-digest", sha256: sha256Hex(text) },
        expected: { [CHANGE]: 2 },
      },
    ];
    const countMismatchViolations = scanLegacySkillTokens({ files, exemptions: wrongExpectedExemptions });
    assert.deepEqual(countMismatchViolations, [
      {
        type: "section-count-mismatch",
        path: "fixtures/case6-digest.json",
        token: CHANGE,
        count: 1,
        expected: 2,
        anchor: { kind: "file-digest", sha256: sha256Hex(text) },
      },
    ]);
  });
});

describe("live-carrier zero-residue scan (F-rase-r1-04 assertion 1)", () => {
  it("tracked files outside openspec/changes/** hold zero stale legacy-name residue outside bound exemption sections", () => {
    const files = collectLiveCarrierFiles();
    assert.ok(files.length > 500, `live-carrier inventory unexpectedly small: ${files.length}`);
    const violations = scanLegacySkillTokens({ files, exemptions: NAMED_EXEMPTIONS });
    if (violations.length > 0) {
      const byDir = summarizeByTopLevelDir(violations, (violation) => violation.path);
      const byType = summarizeByTopLevelDir(violations, (violation) => violation.type);
      // eslint-disable-next-line no-console -- diagnostic-only; assertion below carries the pass/fail signal
      console.error("stale-legacy-name violation count by top-level directory:", byDir);
      // eslint-disable-next-line no-console
      console.error("stale-legacy-name violation count by type:", byType);
    }
    assert.deepEqual(
      violations,
      [],
      `expected zero stale-legacy-name residue outside NAMED_EXEMPTIONS sections, found ${violations.length} violation(s) (see stderr breakdown above; fix each hit per design D10, or bind it with a NAMED_EXEMPTIONS entry)`
    );
  });
});

describe("dangling old entry-path / retired-refs-root literals (F-rase-r1-04 assertion 2)", () => {
  function buildEntryPathRegex(names) {
    const alternation = names.map(escapeForRegex).join("|");
    return new RegExp(String.raw`(?:\./)?\.(?:claude|agents)/skills/(?:${alternation})(?![A-Za-z0-9-])`, "g");
  }
  function buildSsotPathRegex(names) {
    const alternation = names.map(escapeForRegex).join("|");
    return new RegExp(String.raw`\.devpro/agent-skills/[a-z0-9][a-z0-9-]*/(?:${alternation})(?![A-Za-z0-9-])`, "g");
  }
  const RETIRED_REFS_ROOT_RE = /\.devpro\/agent-skills\/(?:autonomous-ai-agents|documentation|templates)\//g;
  const ALL_RETIRED_ENTRY_NAMES = Object.freeze([...LEGACY_SKILL_NAMES, ...RETIRED_ENTRY_ONLY_NAMES]);

  function resolveExemptSectionsFor(text, filePath) {
    const sections = [];
    for (const exemption of NAMED_EXEMPTIONS) {
      if (exemption.path !== filePath) continue;
      const resolved = resolveAnchorSection(text, exemption.anchor);
      if (!resolved.error) sections.push(resolved);
    }
    return sections;
  }

  it("no live carrier contains a dangling old entry-path or retired-refs-root literal", () => {
    const files = collectLiveCarrierFiles();
    const entryRe = buildEntryPathRegex(ALL_RETIRED_ENTRY_NAMES);
    const ssotRe = buildSsotPathRegex(LEGACY_SKILL_NAMES);
    const hits = [];
    for (const file of files) {
      // Backslash -> forward-slash is a 1-for-1 character swap (length- and
      // index-preserving), so exempt-section offsets computed on the
      // original text stay valid against this normalized copy.
      const normalized = file.text.split("\\").join("/");
      const sections = resolveExemptSectionsFor(file.text, file.path);
      for (const re of [entryRe, ssotRe, RETIRED_REFS_ROOT_RE]) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(normalized))) {
          if (sections.some((section) => match.index >= section.start && match.index < section.end)) continue;
          hits.push({ path: file.path, literal: match[0] });
        }
      }
    }
    if (hits.length > 0) {
      const byDir = summarizeByTopLevelDir(hits, (hit) => hit.path);
      // eslint-disable-next-line no-console
      console.error("dangling-path hit count by top-level directory:", byDir);
    }
    assert.deepEqual(
      hits,
      [],
      `expected zero dangling old entry-path/refs-root literals, found ${hits.length} (see stderr breakdown above; fix each hit per design D10, or bind it with a NAMED_EXEMPTIONS entry)`
    );
  });

  it("fixture: a normalized `./` + backslash entry-path literal is still caught", () => {
    const entryRe = buildEntryPathRegex(ALL_RETIRED_ENTRY_NAMES);
    entryRe.lastIndex = 0;
    assert.ok(entryRe.test(`.\\.claude\\skills\\${CHANGE}`.split("\\").join("/")));
  });
});

// ---------------------------------------------------------------------------
// Existence check for new-topology path literals (design D10 assertion 2).
// A literal rooted at the catalog, the refs root, or one of the two entries
// is cut before the first all-dots segment (`...`); the rest must be a
// tracked path or an ancestor dir of one. If a glob/placeholder character
// (`{`, `*`, `<`, `$`, `[`) follows a partial last segment, some child of
// that directory must start with it. The entries map onto the catalog root,
// so the check does not depend on symlinks being materialized.
// ---------------------------------------------------------------------------
const TOPOLOGY_PATH_RE =
  /(\.devpro\/agent-skills(?:-refs)?|\.(?:claude|agents)\/skills\/devpro)(?![A-Za-z0-9_-])((?:\/[A-Za-z0-9._-]+)*)(\/?)/g;
const PLACEHOLDER_CHARS = new Set(["{", "*", "<", "$", "["]);
const ENTRY_ROOTS = new Set([".claude/skills/devpro", ".agents/skills/devpro"]);
const CATALOG_ROOT = ".devpro/agent-skills";

export function buildTrackedPathSet(relPaths) {
  const set = new Set();
  for (const relPath of relPaths) {
    const parts = relPath.split("/");
    for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join("/"));
  }
  return set;
}

function topologyLiteralResolves(match, nextChar, trackedPaths) {
  const root = ENTRY_ROOTS.has(match[1]) ? CATALOG_ROOT : match[1];
  const segments = match[2].split("/").filter(Boolean);
  const dotsAt = segments.findIndex((segment) => /^\.+$/.test(segment));
  const truncated = dotsAt !== -1;
  const kept = truncated ? segments.slice(0, dotsAt) : segments;
  const partial = !truncated && match[3] === "" && kept.length > 0 && PLACEHOLDER_CHARS.has(nextChar);
  if (partial) {
    const dir = [root, ...kept.slice(0, -1)].join("/");
    const prefix = `${dir}/${kept.at(-1)}`;
    if (!trackedPaths.has(dir)) return false;
    for (const tracked of trackedPaths) if (tracked.startsWith(prefix)) return true;
    return false;
  }
  // Trailing sentence punctuation (`SKILL.md.`) is not part of the path.
  if (!truncated && kept.length > 0) kept[kept.length - 1] = kept.at(-1).replace(/\.+$/, "");
  return trackedPaths.has([root, ...kept].join("/"));
}

/**
 * Pure scanner shared by the live check and its prove-its. `exemptions`
 * (`{ path, anchor }`) cover sections that declare retired paths on
 * purpose; an unresolvable anchor is itself a violation. `literalExclusions`
 * (`{ path, literal, expected }`) are for carriers that cannot hold
 * markers; the literal's count in that file must equal `expected`.
 */
export function scanDanglingTopologyPaths({ files, trackedPaths, exemptions = [], literalExclusions = [] }) {
  const violations = [];
  for (const file of files) {
    const text = file.text.split("\\").join("/");
    const sections = [];
    for (const exemption of exemptions.filter((entry) => entry.path === file.path)) {
      const resolved = resolveAnchorSection(file.text, exemption.anchor);
      if (resolved.error) violations.push({ type: "anchor-error", path: file.path, anchor: exemption.anchor, reason: resolved.error });
      else sections.push(resolved);
    }
    const exclusions = literalExclusions.filter((entry) => entry.path === file.path);
    const excludedCounts = exclusions.map(() => 0);
    TOPOLOGY_PATH_RE.lastIndex = 0;
    let match;
    while ((match = TOPOLOGY_PATH_RE.exec(text))) {
      if (sections.some((section) => match.index >= section.start && match.index < section.end)) continue;
      if (topologyLiteralResolves(match, text[match.index + match[0].length] ?? "", trackedPaths)) continue;
      const exclusionIndex = exclusions.findIndex((entry) => entry.literal === match[0]);
      if (exclusionIndex !== -1) {
        excludedCounts[exclusionIndex]++;
        continue;
      }
      violations.push({ type: "dangling-path", path: file.path, literal: match[0] });
    }
    exclusions.forEach((entry, index) => {
      if (excludedCounts[index] !== entry.expected) {
        violations.push({ type: "exclusion-count-mismatch", path: file.path, literal: entry.literal, count: excludedCounts[index], expected: entry.expected });
      }
    });
  }
  return violations;
}

// Test files build synthetic trees, so their path literals describe fixtures,
// not this repo; a test that reads a real path fails on its own if the path
// is gone. The scan therefore stops at this directory.
const EXISTENCE_SCAN_EXCLUDED_DIR = ".devpro/scripts/tests/";

// Sections that list retired paths on purpose, beyond NAMED_EXEMPTIONS.
const EXISTENCE_ONLY_EXEMPTIONS = Object.freeze([
  {
    path: ".devpro/scripts/sync-agent-rules.mjs",
    anchor: { kind: "const", name: "LEGACY_SECOND_REVIEW_ARTIFACTS" },
    reason: "retired second-reviewer skill paths that --sync prunes",
  },
  {
    path: ".devpro/scripts/sync-agent-rules.mjs",
    anchor: { kind: "const", name: "LEGACY_RULE_GOVERNANCE_SKILL_ARTIFACTS" },
    reason: "retired rule-audit / convergence-loop skill paths that --sync prunes",
  },
]);

const EXISTENCE_LITERAL_EXCLUSIONS = Object.freeze([
  {
    path: "openspec/specs/reusable-skill-adoption/spec.md",
    literal: ".devpro/agent-skills/rules-authoring/dp-rule-audit",
    expected: 1,
    reason: "canonical requirement naming a retired path the prune allowlist must cover",
  },
  {
    path: "openspec/specs/reusable-skill-adoption/spec.md",
    literal: ".devpro/agent-skills/rules-authoring/dp-convergence-loop",
    expected: 1,
    reason: "canonical requirement naming a retired path the prune allowlist must cover",
  },
]);

let cachedTrackedPathSet = null;

function collectTrackedPathSet() {
  if (cachedTrackedPathSet) return cachedTrackedPathSet;
  const raw = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  cachedTrackedPathSet = buildTrackedPathSet(raw.split("\0").filter(Boolean));
  return cachedTrackedPathSet;
}

describe("new-topology path literals exist in the tree (design D10 assertion 2, existence)", () => {
  const TREE = buildTrackedPathSet([
    ".devpro/agent-skills/manifest.json",
    ".devpro/agent-skills/devpro-workflows/change/SKILL.md",
    ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md",
    ".devpro/agent-skills-refs/manifest.json",
  ]);
  const scan = (text, extra = {}) =>
    scanDanglingTopologyPaths({ files: [{ path: "doc.md", text }], trackedPaths: TREE, ...extra });

  it("Scenario: a brace form whose prefix matches no child fails", () => {
    assert.deepEqual(scan(`\`.devpro/agent-skills/devpro-workflows/${CHANGE.slice(0, 3)}{change,pre-pr}/SKILL.md\``), [
      { type: "dangling-path", path: "doc.md", literal: `.devpro/agent-skills/devpro-workflows/${CHANGE.slice(0, 3)}` },
    ]);
  });

  it("Scenario: existing paths, brace/placeholder forms, entry paths and `...` pass", () => {
    const text = [
      "`.devpro/agent-skills/devpro-workflows/{change,pre-pr}/SKILL.md`",
      "`.devpro/agent-skills/devpro-workflows/pre-{pr,x}`",
      "`.devpro/agent-skills/<group>/<name>/SKILL.md`",
      "`.devpro/agent-skills/.../SKILL.md`",
      "`.claude/skills/devpro/devpro-workflows/change/SKILL.md`",
      "see .agents/skills/devpro. and .devpro/agent-skills-refs/manifest.json.",
    ].join("\n");
    assert.deepEqual(scan(text), []);
  });

  it("Scenario: a missing path fails, and an entry path is checked against the catalog", () => {
    assert.deepEqual(scan("`.claude/skills/devpro/devpro-workflows/gone/SKILL.md`"), [
      { type: "dangling-path", path: "doc.md", literal: ".claude/skills/devpro/devpro-workflows/gone/SKILL.md" },
    ]);
  });

  it("Scenario: a literal exclusion must match its exact count", () => {
    const literal = ".devpro/agent-skills/gone";
    const literalExclusions = [{ path: "doc.md", literal, expected: 1 }];
    assert.deepEqual(scan(`${literal} and ${literal}`, { literalExclusions }), [
      { type: "exclusion-count-mismatch", path: "doc.md", literal, count: 2, expected: 1 },
    ]);
    assert.deepEqual(scan(`${literal}`, { literalExclusions }), []);
  });

  it("Scenario: a bound section is skipped, and an unresolvable anchor fails closed", () => {
    const text = "const RETIRED = [\n  \".devpro/agent-skills/gone\",\n];\n";
    assert.deepEqual(scan(text, { exemptions: [{ path: "doc.md", anchor: { kind: "const", name: "RETIRED" } }] }), []);
    assert.deepEqual(scan(text, { exemptions: [{ path: "doc.md", anchor: { kind: "const", name: "MISSING" } }] }), [
      { type: "anchor-error", path: "doc.md", anchor: { kind: "const", name: "MISSING" }, reason: "const-not-found" },
      { type: "dangling-path", path: "doc.md", literal: ".devpro/agent-skills/gone" },
    ]);
  });

  it("every new-topology path literal in a live carrier exists in the tracked tree", () => {
    const files = collectLiveCarrierFiles().filter((file) => !file.path.startsWith(EXISTENCE_SCAN_EXCLUDED_DIR));
    const violations = scanDanglingTopologyPaths({
      files,
      trackedPaths: collectTrackedPathSet(),
      exemptions: [...NAMED_EXEMPTIONS, ...EXISTENCE_ONLY_EXEMPTIONS],
      literalExclusions: EXISTENCE_LITERAL_EXCLUSIONS,
    });
    assert.deepEqual(
      violations,
      [],
      `expected every new-topology path literal to exist, found ${violations.length} violation(s) (fix each per design D10, or bind it with an exclusion above)`
    );
  });
});

describe("legacy carriers still hold their frozen old names (F-rase-r1-04 assertion 3; permanent, do-not-rename)", () => {
  it("sync-agent-rules.mjs's fixed legacy allowlists still contain the old names, unrenamed", () => {
    const syncText = readFileSync(repoPath(".devpro/scripts/sync-agent-rules.mjs"), "utf8");
    for (const constName of [
      "LEGACY_CURSOR_SKILL_DISCOVERY_ARTIFACTS",
      "LEGACY_SECOND_REVIEW_ARTIFACTS",
      "LEGACY_RULE_GOVERNANCE_SKILL_ARTIFACTS",
    ]) {
      assert.match(syncText, new RegExp(`const\\s+${constName}\\s*=`), `missing const ${constName}`);
    }
    assert.match(syncText, new RegExp(`"\\.cursor/skills/${CHANGE}"`));
    assert.match(syncText, new RegExp(`"\\.devpro/agent-skills/devpro-reviews/dp-second-reviewer"`));
  });

  it("legacy-skill-entry-artifacts.mjs's frozen consts still contain the old names, unrenamed", () => {
    const legacyText = readFileSync(repoPath(".devpro/scripts/lib/legacy-skill-entry-artifacts.mjs"), "utf8");
    for (const constName of ["LEGACY_SKILL_ENTRY_LINKS", "LEGACY_SKILL_PAYLOAD_FILES"]) {
      assert.match(legacyText, new RegExp(`const\\s+${constName}\\s*=`), `missing const ${constName}`);
    }
    assert.match(legacyText, new RegExp(`"\\.agents/skills/${CHANGE}"`));
    assert.match(legacyText, new RegExp(`"\\.claude/skills/${CHANGE}"`));
  });

  it("do-not-rename script/test file names still exist verbatim", () => {
    for (const relPath of [
      ".devpro/scripts/dp-change-environment-checks.mjs",
      ".devpro/scripts/tests/dp-change-batch-ledger-carry-forward-grep.test.mjs",
      ".devpro/scripts/tests/dp-change-step-structure.test.mjs",
      ".devpro/scripts/lib/legacy-skill-entry-artifacts.mjs",
    ]) {
      assert.ok(
        (() => {
          try {
            readFileSync(repoPath(relPath));
            return true;
          } catch {
            return false;
          }
        })(),
        `do-not-rename carrier missing: ${relPath}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Placeholder invocation forms (primary review r9 F-rase-pr-r9-02, r10
// F-rase-pr-r10-01). The exact-token scan above only knows the 18 concrete old
// names, so generic placeholders slipped through the sweep: a slash- or
// dollar-prefixed `dp-<…>` (a skill invocation form — agents are never invoked
// that way) and the `xxx` stand-in after `dp-`, bare or prefixed. A bare `dp-<…>` stays
// allowed: it names the old SSOT directories in legacy-artifact comments. A
// match must start the token (line start, whitespace, quote, bracket, or
// colon), so path segments such as `.claude/agents/dp-*.md` never count. Built from a string
// with the quote characters escaped: `stripJsCommentSpans` (shard discovery)
// has no regex-literal state, so a raw backtick in a regex literal would read
// as an unterminated template.
// ---------------------------------------------------------------------------
const PLACEHOLDER_INVOCATION_RE = new RegExp("(?<=^|[\\s\\u0060\\u0022\\u0027(（「：:])(?:[/$]dp-<[^>\\s]*>|[/$]?dp-xxx(?![\\w-]))", "gmu");

export function scanLegacyInvocationPlaceholders({ files, literalExclusions = [] }) {
  const violations = [];
  for (const file of files) {
    const exclusions = literalExclusions.filter((entry) => entry.path === file.path);
    const excludedCounts = exclusions.map(() => 0);
    for (const match of file.text.matchAll(PLACEHOLDER_INVOCATION_RE)) {
      const exclusionIndex = exclusions.findIndex((entry) => entry.literal === match[0]);
      if (exclusionIndex !== -1) {
        excludedCounts[exclusionIndex]++;
        continue;
      }
      violations.push({ type: "legacy-invocation-placeholder", path: file.path, literal: match[0] });
    }
    exclusions.forEach((entry, index) => {
      if (excludedCounts[index] !== entry.expected) {
        violations.push({ type: "exclusion-count-mismatch", path: file.path, literal: entry.literal, count: excludedCounts[index], expected: entry.expected });
      }
    });
  }
  return violations;
}

const SLASH_FORM = `/${"dp-"}<x>`;
const DOLLAR_FORM = `$${"dp-"}<x>`;

// The consumer upgrade note names the old invocation forms on purpose.
const PLACEHOLDER_LITERAL_EXCLUSIONS = Object.freeze([
  { path: ".devpro/agent-rules/rules-flow.md", literal: SLASH_FORM, expected: 1, reason: "upgrade note: old → new invocation form" },
  { path: ".devpro/agent-rules/rules-flow.md", literal: DOLLAR_FORM, expected: 1, reason: "upgrade note: old → new invocation form" },
]);

describe("legacy placeholder invocation forms (F-rase-pr-r9-02)", () => {
  const scan = (text, literalExclusions) =>
    scanLegacyInvocationPlaceholders({ files: [{ path: "doc.md", text }], literalExclusions });

  it("Scenario: a slash or dollar placeholder invocation is a violation", () => {
    const slashName = `/${"dp-"}<name>`;
    const dollarCommand = `$${"dp-"}<command>`;
    assert.deepEqual(scan(`建議透過 \`${slashName}\` 推進\nargument-hint: "${dollarCommand} [args]"`), [
      { type: "legacy-invocation-placeholder", path: "doc.md", literal: slashName },
      { type: "legacy-invocation-placeholder", path: "doc.md", literal: dollarCommand },
    ]);
  });

  it("Scenario: the xxx stand-in is a violation bare or prefixed", () => {
    const bare = `${"dp-"}xxx`;
    const slash = `/${"dp-"}xxx`;
    assert.deepEqual(scan(`名詞形 \`${bare}\`（或觸發指示 \`${slash}\`）`), [
      { type: "legacy-invocation-placeholder", path: "doc.md", literal: bare },
      { type: "legacy-invocation-placeholder", path: "doc.md", literal: slash },
    ]);
  });

  it("Scenario: agent paths, the new forms, and bare old SSOT dir placeholders pass", () => {
    const text = [
      `\`.claude/agents/${"dp-"}*.md\`、\`.opencode/agent/${"dp-"}<role>.md\`、\`.cursor/agents/${"dp-"}xxx.md\``,
      `\`${"dp-"}xxxl\``,
      "`/devpro:<name>`、`$devpro:<name>`",
      `the old \`${"dp-"}<x>\` SSOT dirs`,
    ].join("\n");
    assert.deepEqual(scan(text), []);
  });

  it("Scenario: a literal exclusion must match its exact count", () => {
    const literalExclusions = [{ path: "doc.md", literal: SLASH_FORM, expected: 1 }];
    assert.deepEqual(scan(`\`${SLASH_FORM}\``, literalExclusions), []);
    assert.deepEqual(scan("nothing here", literalExclusions), [
      { type: "exclusion-count-mismatch", path: "doc.md", literal: SLASH_FORM, count: 0, expected: 1 },
    ]);
  });

  it("no live carrier keeps a legacy placeholder invocation form", () => {
    const violations = scanLegacyInvocationPlaceholders({
      files: collectLiveCarrierFiles(),
      literalExclusions: PLACEHOLDER_LITERAL_EXCLUSIONS,
    });
    assert.deepEqual(violations, [], `expected zero legacy placeholder invocation forms, found ${violations.length} (use the devpro: form per design D10)`);
  });
});
