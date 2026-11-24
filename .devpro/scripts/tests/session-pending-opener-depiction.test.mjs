/**
 * Governance carriers must not depict a session-pending item opener as a
 * column-0 `- ` / `* ` bullet.
 *
 * Why this exists (fix-session-pending-item-parse rounds 1 and 2): the change
 * moved the item-opener convention to `## ` H2 and shipped a blocking write
 * gate for it, then twice shipped a *carrier enumeration* that was wrong. r1
 * missed `.devpro/agent-rules/session-recap.md` entirely; r2 fixed that
 * instance but asserted "there are three such carriers", which review falsified
 * again. Enumerating by hand is the defect — a carrier that teaches the old
 * shape makes an agent write an item that the preceding `## ` section absorbs
 * (it stops being independently claimable) and that Gate NS then refuses.
 *
 * The decidable core: never inspect prose. `design.md` D7 C2 established that
 * no purely syntactic rule separates a real item opener from an evidence line
 * in running text — that undecidability is the whole reason the migration had
 * to be hand-classified. But a *depiction* is different: it lives inside a
 * fenced block or an inline code span, so its boundaries are explicit. Inside
 * those boundaries a column-0 bullet next to a session-pending-only field token
 * is unambiguously a template for an item opener.
 *
 * What this does NOT reach, stated here so the spec and this file cannot drift
 * apart (r3 finding F-SPI-14): only the FIRST non-blank line of a fence is
 * treated as the opener, so an old-shape item sitting after a correct one in
 * the same block is invisible; a block whose first line is a comment is
 * likewise missed; and a template carrying none of the tokens below is not
 * recognised as a depiction at all. Widening to every line inside a fence is
 * deliberately rejected — it would flag the negative examples a governance
 * carrier legitimately writes. This is a regression guard on the template form
 * that actually mints items, not a proof of universal absence.
 *
 * Scope is the two trees an agent actually reads at the moment it acts.
 * `openspec/specs/**` is deliberately out: canonical specs state requirements
 * rather than hand an agent a template, and the one occurrence there
 * (`output-discipline/spec.md`, a `MUST NOT` clause depicting an item that
 * should not exist at all) is a negative example, not an instruction — see
 * `decisions.md` D12.
 *
 * One carrier is reached by rendering rather than by the file scan (r3 finding
 * F-SPI-17): Gate N's runtime advisory hands the author a fenced item template,
 * and it lives in `.devpro/scripts/`, outside `TREES`. Adding that tree would
 * not find it either — in source the template is escaped template-literal
 * fragments that `FENCE` cannot match, so the violating shape exists only after
 * rendering. Widening `TREES` would therefore buy false assurance, the same
 * trade F-SPI-14 refused. The last test below renders the advisory and runs the
 * detector on the output, which holds regardless of how the string is built.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TREES = [".devpro/agent-rules", ".devpro/agent-skills"];

/**
 * Tokens that only ever appear in a session-pending item. `decided:` and
 * `unresolved:` are deliberately absent: meeting-notes Clarification State uses
 * them too, and including them made an `ambiguity-scoring.md` schema block read
 * as a pending capsule.
 */
const PENDING_ONLY_TOKENS = Object.freeze([
  "待追蹤",
  "建議落點",
  "clarify_stage:",
  "promote_ready:",
  "缺輸入:",
]);

const FENCE = /^[\t ]*(?:```|~~~)/;
const COLUMN_ZERO_BULLET = /^[-*] /;

function markdownFilesUnder(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) markdownFilesUnder(full, out);
    else if (full.endsWith(".md")) out.push(full);
  }
  return out;
}

function depictsPendingItem(text) {
  return PENDING_ONLY_TOKENS.some((token) => text.includes(token));
}

/**
 * Returns one entry per depiction whose opener is a column-0 bullet.
 * Exported shape: `{ file, line, kind, text }`.
 */
export function findColumnZeroOpenerDepictions(relPath, content) {
  const lines = content.split("\n");
  const violations = [];

  let fenceStart = -1;
  let fenceBody = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      if (fenceStart < 0) {
        fenceStart = i;
        fenceBody = [];
        continue;
      }
      if (depictsPendingItem(fenceBody.join("\n"))) {
        const opener = fenceBody.find((candidate) => candidate.trim() !== "");
        if (opener !== undefined && COLUMN_ZERO_BULLET.test(opener)) {
          violations.push({ file: relPath, line: fenceStart + 2, kind: "fence", text: opener });
        }
      }
      fenceStart = -1;
      continue;
    }
    if (fenceStart >= 0) {
      fenceBody.push(line);
      continue;
    }
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const span = match[1];
      if (COLUMN_ZERO_BULLET.test(span) && depictsPendingItem(span)) {
        violations.push({ file: relPath, line: i + 1, kind: "span", text: span });
      }
    }
  }

  return violations;
}

test("no governance carrier depicts a session-pending item opener as a column-0 bullet", () => {
  const violations = [];
  for (const tree of TREES) {
    for (const file of markdownFilesUnder(path.join(REPO_ROOT, tree))) {
      const rel = path.relative(REPO_ROOT, file);
      violations.push(...findColumnZeroOpenerDepictions(rel, readFileSync(file, "utf8")));
    }
  }

  assert.deepEqual(
    violations,
    [],
    "a governance carrier still shows a session-pending item opening with `- ` / `* `; " +
      "such an item is absorbed by the preceding `## ` section and refused by Gate NS. " +
      "Rewrite the depiction with a `## ` opener and indented continuation lines:\n" +
      violations.map((v) => `  ${v.file}:${v.line} [${v.kind}] ${v.text}`).join("\n"),
  );
});

test("the detector fires on both shapes a carrier can use", () => {
  const span = findColumnZeroOpenerDepictions(
    "fixture.md",
    "AI MUST record the gap (format: `- 待追蹤：<gap>；建議落點：<file>`).\n",
  );
  assert.equal(span.length, 1, "an inline code span depicting a column-0 opener must be caught");
  assert.equal(span[0].kind, "span");

  const fence = findColumnZeroOpenerDepictions(
    "fixture.md",
    ["```markdown", "- [ ] <intent one-liner>", "  - clarify_stage: explore", "```", ""].join("\n"),
  );
  assert.equal(fence.length, 1, "a fenced template whose opener is a column-0 bullet must be caught");
  assert.equal(fence[0].kind, "fence");
});

test("the detector does not fire on the shapes this change moved carriers to", () => {
  const spanFixed = findColumnZeroOpenerDepictions(
    "fixture.md",
    "opener 為 `## 待追蹤：<gap>`，續行縮排為 `  - 建議落點：<file>`。\n",
  );
  assert.deepEqual(spanFixed, [], "an H2 opener with an indented continuation must pass");

  const fenceFixed = findColumnZeroOpenerDepictions(
    "fixture.md",
    ["```markdown", "## <intent one-liner>", "  - clarify_stage: explore", "```", ""].join("\n"),
  );
  assert.deepEqual(fenceFixed, [], "a fenced template with an H2 opener must pass");
});

test("the detector ignores blocks that only share meeting-notes field names", () => {
  const clarificationState = findColumnZeroOpenerDepictions(
    "fixture.md",
    ["```", "- decided: ...", "- unresolved: ≤20 lines; each ≤200 chars", "```", ""].join("\n"),
  );
  assert.deepEqual(
    clarificationState,
    [],
    "`decided:` / `unresolved:` are shared with meeting-notes Clarification State and MUST NOT " +
      "make a schema block read as a pending capsule",
  );
});

test("Gate N's rendered advisory does not itself depict the old opener", async () => {
  const gate = await import("../hooks/pre-tool-gate.mjs");

  // A block missing all three disposition fields, so the advisory fires.
  const advisory = gate.checkNotesDisposition({
    toolName: "Write",
    filePath: "notes/session-pending.md",
    toolInput: {
      content: ["# Session Pending", "", "- **【New item】**", "  - observed gap: x", ""].join("\n"),
    },
    baseCwd: "/nowhere",
    readFile: () => null,
  });
  assert.ok(advisory?.advisory, "the fixture must actually trigger Gate N");

  assert.deepEqual(
    findColumnZeroOpenerDepictions("<gate-n rendered advisory>", advisory.advisory),
    [],
    "Gate N's remediation template must not teach the shape Gate NS blocks",
  );

  // Positive control on the exact shape this replaced, so the assertion above
  // cannot pass merely because the detector stopped reaching rendered strings.
  const oldShape = [
    "三欄範本：",
    "```",
    "- <議題描述>",
    "  缺輸入: <缺少的具名輸入>",
    "  trigger: <何時重議>",
    "  carrier: <誰追蹤>",
    "```",
  ].join("\n");
  assert.equal(
    findColumnZeroOpenerDepictions("<pre-fix advisory>", oldShape).length,
    1,
    "the detector must still fire on the pre-fix template shape",
  );
});
