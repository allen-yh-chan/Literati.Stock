/**
 * strengthen-design-review-independence-grep.test.mjs
 *
 * Locks design-gate author≠reviewer independence wording (design.md D4 / D6)
 * on production carriers. Spec/delta bodies are excluded (openspec/**).
 *
 * Guard shape (rule-anchor-guard-strength.md):
 *   - polarity: same-physical-line compound regex binding
 *     `design-author identity` + `MUST NOT equal that design-author identity`
 *     (no decoupled includes; no compensating alternation)
 *   - carrier note: the design gate text moved from `change/SKILL.md` to
 *     `change/references/full-analysis-and-design.md`; line-level assertions read
 *     the full reading order (SKILL.md + reference), the set check expects the reference
 *   - set equality: `independent of the design author` hit files in
 *     `.devpro/agent-rules/**` + `.devpro/agent-skills/**` bidirectional-equal
 *     `{change/references/full-analysis-and-design.md, openspec-step-1-to-9.md}`
 *   - absence: writer-lease sentence does not contain the independence phrase
 *   - mutation: deleting the independence operative line turns polarity red
 *   - NFR-5: new clause doesNotMatch pinning a single vendor model literal
 *     as the only legal reviewer
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";
import { CHANGE_FULL_REFERENCE, readChangeSkillFullReadingOrder } from "./lib/change-skill.mjs";

const STEP19 = ".devpro/agent-rules/openspec-step-1-to-9.md";
const INDEPENDENCE_PHRASE = "independent of the design author";
const EXPECTED_INDEPENDENCE_CARRIERS = [CHANGE_FULL_REFERENCE, STEP19].sort();
const WRITER_LEASE_MARKER = "independent design reviewer MAY coexist only with explicit no-write/no-claim";
const POLARITY_RE = /design-author identity[^\n]*MUST NOT equal that design-author identity/;
const VENDOR_MODEL_LITERAL_RE = /\b(?:Opus|Sonnet|Haiku|GPT-4o?|o1-preview)\b/;
const ONLY_LEGAL_VENDOR_REVIEWER_RE =
  /only legal reviewer[^\n]*\b(?:Opus|Sonnet|Haiku|GPT-4o?|Claude Opus)\b|\b(?:Opus|Sonnet|Haiku|GPT-4o?|Claude Opus)\b[^\n]*only legal reviewer/i;

function listAllFiles(rootRel) {
  const rootAbs = repoPath(rootRel);
  const out = [];
  function walk(dirAbs) {
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        out.push(path.relative(REPO_ROOT, abs).split(path.sep).join("/"));
      }
    }
  }
  walk(rootAbs);
  return out;
}

const SCOPE_FILES = [".devpro/agent-rules", ".devpro/agent-skills"].flatMap((root) => listAllFiles(root));

function literalHitSet(literal) {
  return SCOPE_FILES.filter((relPath) => read(relPath).includes(literal)).sort();
}

function assertPolarity(skillBody) {
  assert.match(skillBody, POLARITY_RE);
}

function designGateSection(skillBody) {
  const start = skillBody.indexOf("**Design.md Second-Review Gate");
  assert.ok(start >= 0, "Design.md Second-Review Gate section missing");
  const rest = skillBody.slice(start);
  const next = rest.search(/\n若 `dp-analyst`/);
  return next >= 0 ? rest.slice(0, next) : rest;
}

function assertNfr5(section) {
  assert.doesNotMatch(section, VENDOR_MODEL_LITERAL_RE);
  assert.doesNotMatch(section, ONLY_LEGAL_VENDOR_REVIEWER_RE);
}

test("independent of the design author — 命中檔案集合雙向等於 {change/references/full-analysis-and-design.md, openspec-step-1-to-9.md}", () => {
  assert.deepEqual(literalHitSet(INDEPENDENCE_PHRASE), EXPECTED_INDEPENDENCE_CARRIERS);
});

test("insertion axis: extra carrier with independent of the design author is not the expected two-file set", () => {
  const injected = [...literalHitSet(INDEPENDENCE_PHRASE), ".devpro/agent-rules/ai-autonomy.md"].sort();
  assert.notDeepEqual(injected, EXPECTED_INDEPENDENCE_CARRIERS);
});

test("polarity: same physical line binds design-author identity and MUST NOT equal that design-author identity", () => {
  assertPolarity(readChangeSkillFullReadingOrder());
});

test("absence: writer-lease sentence does not contain independent of the design author", () => {
  const leaseLines = readChangeSkillFullReadingOrder()
    .split("\n")
    .filter((line) => line.includes(WRITER_LEASE_MARKER));
  assert.equal(leaseLines.length, 1, "expected exactly one writer-lease sentence in the devpro:change full reading order");
  assert.equal(
    leaseLines[0].includes(INDEPENDENCE_PHRASE),
    false,
    "writer-lease sentence must not contain independent of the design author",
  );
});

test("mutation: deleting the independence operative line turns the polarity assertion red", () => {
  const lines = readChangeSkillFullReadingOrder().split("\n");
  const idx = lines.findIndex((line) => POLARITY_RE.test(line));
  assert.notEqual(idx, -1, "independence operative line missing");
  const mutated = lines.filter((_, i) => i !== idx).join("\n");
  assert.throws(() => assertPolarity(mutated));
});

test("NFR-5: Design.md Second-Review Gate doesNotMatch pinning a single vendor model literal as the only legal reviewer", () => {
  assertNfr5(designGateSection(readChangeSkillFullReadingOrder()));
});

test("NFR-5 mutation: injecting only-legal vendor reviewer turns doesNotMatch red", () => {
  const section = designGateSection(readChangeSkillFullReadingOrder());
  const mutated = `${section}\nThe only legal reviewer is Claude Opus.`;
  assert.throws(() => assertNfr5(mutated));
});
