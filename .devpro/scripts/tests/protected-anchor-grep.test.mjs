/**
 * protected-anchor-grep.test.mjs
 *
 * Advisory gate: detects silent removal of protected anchors from
 * .devpro/agent-rules/*.md files when the tests that depend on
 * those phrases are not simultaneously updated.
 *
 * Mechanism: Reverse-index (FR-B method 4).
 * SSOT = phrases asserted in existing .devpro/scripts/tests/*.test.mjs files
 * via REQUIRED arrays, .includes() calls, or assert.match() literal regexes.
 * A phrase is "protected" if some test asserts its presence in an agent-rules leaf.
 *
 * Violation requires ALL THREE conditions simultaneously:
 *   1. A protected phrase is removed from a .devpro/agent-rules/*.md leaf
 *      (present in diff removed lines).
 *   2. The grep-test file that depends on that phrase is NOT among the
 *      files modified in this diff.
 *   3. No commit message in the branch contains the "anchor-move:" marker.
 *
 * Exemption channels:
 *   - Add "anchor-move:" to any commit message in the branch, OR
 *   - Update the dependent grep-test file in the same diff.
 *
 * Soft-fail + override semantics (Q1 decision):
 *   Test fails with a message that explicitly names the exemption channels.
 *
 * Live mode (git available):
 *   - diff = git diff <merge-base with main>..HEAD
 *   - commits = git log <merge-base with main>..HEAD --format=%s%n%b
 * Fail-open: if git is unavailable / no main ref / diff is empty → skip (advisory).
 *
 * Pure function `detectAnchorRemovals` is fully deterministic and
 * accepts synthetic inputs for unit testing (no git dependency).
 */

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";

const testsDir = repoPath(".devpro/scripts/tests");
const agentRulesDir = repoPath(".devpro/agent-rules");

// ---------------------------------------------------------------------------
// Phrase extraction from grep-test source files
// ---------------------------------------------------------------------------

/**
 * Extract (phrase, leafBasename) pairs from a single *grep*.test.mjs source.
 *
 * Attribution strategy (post per-assertion convergence fix for issue #1034):
 *
 *   Scheme B (primary): Variable alias tracking.
 *     Parse `const <var> = <read-expr containing agent-rules/<leaf>.md>` to build
 *     var→leaf map. For each assertion (.includes() / assert.match() / REQUIRED),
 *     resolve the receiver variable (or the closest preceding read-call for REQUIRED)
 *     back to its leaf. This correctly attributes each phrase to the single leaf
 *     whose variable is the assertion target — eliminating cartesian cross-leaf errors.
 *
 *   Scheme A (fallback): readFile-call offset proximity.
 *     When receiver variable cannot be resolved via Scheme B (var not found in map,
 *     or intermediate variable without direct leaf binding), fall back to the
 *     agent-rules leaf whose read-call appears closest BEFORE the assertion in the
 *     source. This handles patterns like `content.includes(phrase)` in loops where
 *     the loop variable is not directly tracked.
 *     Only applied when exactly one candidate leaf is identifiable by proximity.
 *
 *   Safe drop (final fallback per D2): When neither Scheme B nor Scheme A can
 *     resolve the assertion to a unique leaf (e.g., 0 leaf bindings, or assertion
 *     is against stderr / template intermediate variables that do not correspond
 *     to any agent-rules leaf), the phrase is NOT attributed to any leaf.
 *     Rationale: In the observed corpus, unresolvable assertions are against
 *     incidental path-ref leaves (phrase is asserted on r.stderr / templateBody,
 *     not on agent-rules leaf content) — false-negative cost is 0.
 *     When new unresolvable patterns arise, extend Scheme B var tracking
 *     rather than relaxing the fallback to cartesian.
 *
 * Extraction targets three patterns:
 *
 * Pattern A — REQUIRED/REQUIRED_PHRASES array:
 *   const REQUIRED = ["phrase1", "phrase2", ...];
 *   Leaf resolved via Scheme B (nearest preceding var in varToLeaf map)
 *   or Scheme A (offset proximity), then safe drop if unresolvable.
 *   NOT byte-length filtered: REQUIRED arrays are author-curated and may contain
 *   short but semantically specific anchors (e.g. '禁止', 'main', 'master',
 *   'bugfix/') that are legitimate protected content markers.
 *
 * Pattern B — inline .includes("phrase"):
 *   VAR.includes("phrase") — VAR resolved via Scheme B → leaf.
 *   Minimum byte length: 8 (filters cross-file noise like "grep", "flow").
 *
 * Pattern C — assert.match(<var>, /<regex>/):
 *   assert.match(VAR, /literal phrase/) — VAR resolved via Scheme B → leaf.
 *   Only extracted when regex body contains NO metacharacters (conservative).
 *   assert.doesNotMatch() is never extracted (negative assertion).
 *   Minimum byte length: 8.
 *   Known limitation (P3-2): The regex `((?:[^/\\]|\\.)+)` uses `[^/\\]` which
 *   does not match newline characters. As a result, multi-line literal regexes
 *   (where the regex spans multiple source lines) are not extracted by Pattern C.
 *   This is recorded as a known limitation: repo survey found 0 pure-literal
 *   multi-line regexes (all multi-line assert.match regexes contain metacharacters
 *   and are already skipped by regexMetaRe); this is therefore NOT a current
 *   missed-extraction source. If multi-line literal regexes appear in future,
 *   extend Scheme B var tracking or add a dedicated multi-line literal extractor
 *   rather than modifying the [^/\\] pattern (which would break delimiter detection).
 *
 * Returns: Array of { phrase: string, leafBasename: string }
 */
function extractPhrasesFromTestSource(src) {
  const results = [];

  // ── Step 1: Collect all agent-rules leaf basenames and read-call offsets ──
  //
  // Matches multiple patterns for locating agent-rules leaf references:
  //   Pattern A: literal path containing "agent-rules/"
  //   Pattern B: path.join(<rulesVar>, "foo.md")
  //   Pattern C: resolve(<rulesVar>, "foo.md")
  //   Pattern D: readRule("foo.md") helper function

  const leafRe = /agent-rules[/\\]([a-z][a-z0-9_-]*\.md)/g;
  const joinRe =
    /path\.join\s*\(\s*\w*(?:[Rr]ules?|RULES|[Dd]ir)[A-Za-z_]*\s*,\s*["']([a-z][a-z0-9_-]*\.md)["']/g;
  const resolveRe =
    /resolve\s*\(\s*\w*(?:[Rr]ules?|RULES|[Dd]ir)[A-Za-z_]*\s*,\s*["']([a-z][a-z0-9_-]*\.md)["']/g;
  const readRuleRe = /readRule\s*\(\s*["']([a-z][a-z0-9_-]*\.md)["']/g;

  const targetLeaves = new Set();
  for (const m of src.matchAll(leafRe)) targetLeaves.add(m[1]);
  for (const m of src.matchAll(joinRe)) targetLeaves.add(m[1]);
  for (const m of src.matchAll(resolveRe)) targetLeaves.add(m[1]);
  for (const m of src.matchAll(readRuleRe)) targetLeaves.add(m[1]);

  if (targetLeaves.size === 0) {
    // No agent-rules files referenced — nothing to protect.
    return results;
  }

  // ── Step 2: Build var→leaf map (Scheme B variable alias tracking) ─────────
  //
  // Parse `const/let/var <VAR> = <expr containing agent-rules/<leaf>.md>`
  // to build varToLeaf: Map<string, string> (variable name → leaf basename).
  //
  // Handles read patterns:
  //   const VAR = readFileSync(".devpro/agent-rules/foo.md", "utf8")
  //   const VAR = read(".devpro/agent-rules/foo.md")
  //   const VAR = await fs.readFile(...".devpro/agent-rules/foo.md"...)
  //   const VAR = readFileSync(path.join(agentRulesDir, "foo.md"), ...)
  //   const VAR = readRule("foo.md")
  //
  // Strategy: for each `const/let/var VAR =` binding, scan the RHS for any
  // agent-rules leaf pattern (leafRe, joinRe, resolveRe, readRuleRe).
  // If exactly one leaf is found in the RHS, record VAR→leaf.
  // (Multiple leaves in a single RHS is rare / not expected in this corpus.)

  const varToLeaf = new Map();

  // Regex to capture variable bindings: `const/let/var VAR = <rest of assignment>`
  // We use a line-at-a-time approach: scan each statement ending in newline.
  // This handles both single-line assignments and common patterns.
  //
  // Match: `const|let|var <VAR> = ` on a line, then capture the rest of the statement.
  // We delimit statements approximately by `;` or newline (sufficient for this corpus).
  const varBindRe =
    /(?:^|\n)\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?([^;]*)/gm;

  for (const m of src.matchAll(varBindRe)) {
    const varName = m[1];
    const rhs = m[2];

    // Try to find an agent-rules leaf in the RHS using all leaf patterns.
    const rhsLeaves = new Set();
    for (const lm of rhs.matchAll(new RegExp(leafRe.source, "g")))
      rhsLeaves.add(lm[1]);
    for (const lm of rhs.matchAll(new RegExp(joinRe.source, "g")))
      rhsLeaves.add(lm[1]);
    for (const lm of rhs.matchAll(new RegExp(resolveRe.source, "g")))
      rhsLeaves.add(lm[1]);
    for (const lm of rhs.matchAll(new RegExp(readRuleRe.source, "g")))
      rhsLeaves.add(lm[1]);

    if (rhsLeaves.size === 1) {
      // Unique leaf in RHS — record the binding.
      varToLeaf.set(varName, [...rhsLeaves][0]);
    }
    // If 0 or >1 leaves in RHS, skip (do not map this variable).
  }

  // ── Step 3: Build offset-sorted list of (offset, leaf) for Scheme A ───────
  //
  // Scheme A: when Scheme B cannot resolve a receiver variable, fall back to
  // the agent-rules leaf whose read-call appears closest BEFORE the assertion
  // in source character offset. This handles loop patterns like:
  //   const content = readFileSync(ANTI_PATTERNS_PATH, "utf8");
  //   for (const phrase of REQUIRED) { assert.ok(content.includes(phrase)) }
  // where `content` is not directly bound via a leaf pattern in varToLeaf
  // (because ANTI_PATTERNS_PATH is a constant variable, not a literal path).
  //
  // Only valid when exactly one leaf is the closest candidate.

  // Collect all (offset, leaf) tuples for read-call occurrences.
  const readCallOffsets = []; // Array<{ offset: number, leaf: string }>

  // leafRe matches
  const leafReG = new RegExp(leafRe.source, "g");
  for (const m of src.matchAll(leafReG)) {
    readCallOffsets.push({ offset: m.index, leaf: m[1] });
  }
  // joinRe matches
  const joinReG = new RegExp(joinRe.source, "g");
  for (const m of src.matchAll(joinReG)) {
    readCallOffsets.push({ offset: m.index, leaf: m[1] });
  }
  // resolveRe matches
  const resolveReG = new RegExp(resolveRe.source, "g");
  for (const m of src.matchAll(resolveReG)) {
    readCallOffsets.push({ offset: m.index, leaf: m[1] });
  }
  // readRuleRe matches
  const readRuleReG = new RegExp(readRuleRe.source, "g");
  for (const m of src.matchAll(readRuleReG)) {
    readCallOffsets.push({ offset: m.index, leaf: m[1] });
  }
  readCallOffsets.sort((a, b) => a.offset - b.offset);

  /**
   * Scheme A: find the leaf whose read-call offset is closest before `assertOffset`.
   * Returns the leaf basename if exactly one leaf occupies the nearest position,
   * or null if 0 candidates or the nearest offset has >1 distinct leaf (ambiguous).
   *
   * Known limitation: when the receiver variable is bound to a non-agent-rules file
   * (e.g. a variable reading `.claude/commands/*.md`), Scheme B finds no leaf binding
   * and Scheme A falls back to the nearest agent-rules read-call, producing a
   * residual incidental ghost attribution. Corpus estimate: ~176 such ghosts,
   * all subsets of OLD ghost set (NEW-introduced=0), advisory soft-fail, no hard harm.
   * Root fix: extend Scheme B var tracking to non-leaf-read variables (see decisions.md D2).
   *
   * @param {number} assertOffset - source character offset of the assertion.
   */
  function schemeALeaf(assertOffset) {
    // Find the largest offset that is < assertOffset.
    let best = null;
    let bestOffset = -1;
    for (const { offset, leaf } of readCallOffsets) {
      if (offset < assertOffset && offset > bestOffset) {
        bestOffset = offset;
        best = leaf;
      } else if (offset < assertOffset && offset === bestOffset && leaf !== best) {
        // Two different leaves at the same offset — ambiguous, discard.
        best = null;
      }
    }
    return best; // null = unresolvable via Scheme A
  }

  /**
   * Resolve receiver variable to a leaf using Scheme B, then Scheme A, then safe drop.
   *
   * @param {string|null} receiverVar - variable name from the assertion receiver
   *   (e.g. "content" from `content.includes(...)`, or "leafA" from
   *   `assert.match(leafA, /.../)`, or null when no receiver var extracted).
   * @param {number} assertOffset - source character offset of the assertion.
   * @returns {string|null} leaf basename or null (safe drop).
   */
  function resolveLeaf(receiverVar, assertOffset) {
    // Scheme B: direct variable lookup.
    if (receiverVar !== null && varToLeaf.has(receiverVar)) {
      return varToLeaf.get(receiverVar);
    }

    // Scheme B intermediate var (NOT IMPLEMENTED): one-level var→var indirection
    // (e.g. `const body = ruleBody` where ruleBody → leaf) is not implemented here.
    // Corpus survey found 0 such patterns, so no implementation is needed.
    // If this pattern appears in future, extend varToLeaf population in Step 2
    // rather than adding runtime lookup logic here.
    // Note: varToLeaf uses last-write-wins for same variable name; if a variable is
    // reassigned to a different leaf, only the last binding is tracked (dormant
    // limitation — no current corpus hit).

    // Scheme A: offset-proximity fallback.
    const schemeAResult = schemeALeaf(assertOffset);
    if (schemeAResult !== null) {
      return schemeAResult;
    }

    // Safe drop (D2): attribution unresolvable — do not attribute to any leaf.
    // Per D2: in the observed corpus, unresolvable assertions are against incidental
    // path-ref leaves (phrase is asserted on r.stderr / templateBody, not on leaf
    // content). False-negative cost is 0. When new patterns arise, extend Scheme B
    // var tracking rather than relaxing the fallback to cartesian.
    return null;
  }

  // ── Step 4: Extract REQUIRED / REQUIRED_PHRASES array phrases ────────────
  //
  // Match: const REQUIRED = ["...", ...] or const REQUIRED_PHRASES = ["...", ...]
  // Leaf resolution: Scheme B (find the nearest VAR in varToLeaf that appears
  // before the REQUIRED declaration), then Scheme A (offset proximity), then safe drop.
  //
  // NOT byte-length filtered: REQUIRED arrays are author-curated protected anchors.

  const requiredArrayRe =
    /(?:const|let|var)\s+REQUIRED(?:_PHRASES)?\s*=\s*\[([^\]]*)\]/gs;
  for (const m of src.matchAll(requiredArrayRe)) {
    const arrayBody = m[1];
    const reqOffset = m.index;

    // Scheme B for REQUIRED: find the most-recently-declared var (before reqOffset)
    // that resolves to a leaf.
    let requiredLeaf = null;
    let bestVarOffset = -1;
    for (const vbm of src.matchAll(new RegExp(varBindRe.source, "gm"))) {
      if (vbm.index < reqOffset && vbm.index > bestVarOffset) {
        const candidateLeaf = varToLeaf.get(vbm[1]);
        if (candidateLeaf !== undefined) {
          bestVarOffset = vbm.index;
          requiredLeaf = candidateLeaf;
        }
      }
    }

    // Scheme A fallback if Scheme B didn't find a var.
    if (requiredLeaf === null) {
      requiredLeaf = schemeALeaf(reqOffset);
    }

    // Safe drop if still unresolved.
    if (requiredLeaf === null) continue;

    const strRe = /["']([^"'\\]+(?:\\.[^"'\\]*)*)["']/g;
    for (const sm of arrayBody.matchAll(strRe)) {
      const phrase = sm[1].replace(/\\n/g, "\n").replace(/\\t/g, "\t");
      results.push({ phrase, leafBasename: requiredLeaf });
    }
  }

  // ── Step 5: Extract .includes("phrase") calls ─────────────────────────────
  //
  // Pattern: <receiverExpr>.includes("phrase")
  // Receiver capture: extract the variable name immediately before `.includes(`.
  //   e.g. `leafA.includes("bounded retry")` → receiver = "leafA"
  //   e.g. `content.includes("phrase")` → receiver = "content"
  //   e.g. `.includes("phrase")` (no receiver) → receiver = null
  //
  // Minimum byte length: 8.
  // REQUIRED arrays (Pattern A) are intentionally NOT filtered — author-curated.

  // Extended regex: capture optional receiver variable before .includes(
  const includesRe =
    /(?:^|[^.\w])(\w+)?\.includes\(\s*["']([^"'\\]+(?:\\.[^"'\\]*)*)["']\s*\)/g;
  for (const m of src.matchAll(includesRe)) {
    const receiverVar = m[1] || null; // null if no receiver captured
    const phrase = m[2].replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    // Minimum byte length: 8 (filters cross-file noise like "grep", "flow", "phrase").
    if (Buffer.byteLength(phrase, "utf8") < 8) continue;

    const leaf = resolveLeaf(receiverVar, m.index);
    if (leaf === null) continue; // safe drop

    results.push({ phrase, leafBasename: leaf });
  }

  // ── Step 6: Extract assert.match(<var>, /literal/) phrases ───────────────
  //
  // Pattern: assert.match(<receiverVar>, /<regexBody>/)
  // Conservative: only extract when regex body has NO metacharacters.
  // assert.doesNotMatch() is never extracted (negative assertion).
  // Minimum byte length: 8.
  //
  // Known limitation (P3-2 / multi-line literal):
  //   `[^/\\]` in the regex pattern does NOT match newline characters.
  //   Therefore multi-line pure-literal regexes (body spanning multiple source
  //   lines) are not extracted by this pattern. This is a known limitation:
  //   repo survey confirmed 0 pure-literal multi-line regexes exist (all
  //   multi-line assert.match calls contain metacharacters and are already
  //   skipped by regexMetaRe below — they are NOT a current missed-extraction
  //   source). If such patterns appear in future, extend Scheme B var tracking
  //   or add a dedicated extractor; do not modify `[^/\\]` (it handles /
  //   delimiter detection).

  const assertMatchRe =
    /\bassert\.match\s*\(\s*(\w[\w.]*)\s*,\s*\/((?:[^/\\]|\\.)+)\/[a-z]*\s*\)/g;
  const regexMetaRe = /[\\.*+?()\[\]|^${}]/;
  for (const m of src.matchAll(assertMatchRe)) {
    const receiverVar = m[1].includes(".") ? null : m[1]; // skip `obj.prop` as var
    const regexBody = m[2];
    // Skip if regex contains any metacharacter (conservative).
    if (regexMetaRe.test(regexBody)) continue;
    // Minimum byte length: 8 (filters cross-file noise like "git", "PR").
    if (Buffer.byteLength(regexBody, "utf8") < 8) continue;

    const leaf = resolveLeaf(receiverVar, m.index);
    if (leaf === null) continue; // safe drop

    results.push({ phrase: regexBody, leafBasename: leaf });
  }

  return results;
}

/**
 * Build the reverse-index from all *.test.mjs files in testsDir.
 * FR-B widened: includes all .test.mjs files (not only *grep* named),
 * so assert.match() literal phrases in non-grep tests (e.g. sync-agent-rules)
 * are also indexed as protected anchors.
 *
 * Returns: Map<phrase, Array<{ testFile: string, leafBasename: string }>>
 *   where testFile is the basename of the test file.
 */
function buildTestPhraseIndex(dir) {
  const index = new Map();

  let entries;
  try {
    entries = readdirSync(dir).filter(
      (f) => f.endsWith(".test.mjs")
    );
  } catch {
    return index;
  }

  for (const entry of entries) {
    const filePath = path.join(dir, entry);
    let src;
    try {
      src = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const pairs = extractPhrasesFromTestSource(src);
    for (const { phrase, leafBasename } of pairs) {
      if (!index.has(phrase)) {
        index.set(phrase, []);
      }
      index.get(phrase).push({ testFile: entry, leafBasename });
    }
  }

  return index;
}

// ---------------------------------------------------------------------------
// Pure detection function (no git I/O)
// ---------------------------------------------------------------------------

/**
 * Detect silent removal of protected anchors.
 *
 * @param {object} params
 * @param {Map<string, {removedLines:string[], addedLines:string[]}>} params.ruleDiff
 *   - Rule-leaf basenames mapped to their own removed and added lines.
 * @param {Map<string, Array<{testFile:string, leafBasename:string}>>} params.testPhraseIndex
 *   - Reverse index: phrase → [{testFile, leafBasename}]
 * @param {string[]} params.modifiedFiles  - Files modified in this diff (basenames or relative paths).
 * @param {string[]} params.commitMessages - All commit messages in the branch.
 *
 * @returns {Array<{phrase:string, leaf:string, dependentTestFile:string}>}
 *   List of violations found (empty = no violations).
 */
function detectAnchorRemovals({
  ruleDiff,
  testPhraseIndex,
  modifiedFiles,
  commitMessages,
}) {
  // Condition 3: any commit message contains "anchor-move:" → global exemption.
  const hasAnchorMoveMarker = commitMessages.some((msg) =>
    msg.includes("anchor-move:")
  );
  if (hasAnchorMoveMarker) {
    return [];
  }

  const findings = [];
  const modifiedBasenames = new Set(
    modifiedFiles.map((f) => path.basename(f))
  );

  for (const [phrase, dependents] of testPhraseIndex) {
    for (const { testFile, leafBasename } of dependents) {
      // The dependent test guards this leaf. An addition or removal in another
      // leaf must neither mask this removal nor manufacture one here.
      const delta = ruleDiff.get(leafBasename);
      if (!delta?.removedLines.some((line) => line.includes(phrase))) continue;
      if (delta.addedLines.some((line) => line.includes(phrase))) continue;
      // Condition 2: the dependent grep-test is NOT updated in this diff.
      if (modifiedBasenames.has(testFile)) continue;

      // Condition 2 (leaf guard): only flag if the guarded leaf is among modified files.
      // (i.e., skip if the removal is in a different file than what this test guards.)
      //
      // P3-4 simplification: the original code checked BOTH:
      //   !modifiedBasenames.has(leafBasename) &&
      //   !modifiedFiles.some(f => f.endsWith(leafBasename))
      // The second condition (`endsWith`) is always covered by `modifiedBasenames.has`
      // because modifiedBasenames is built via `path.basename(f)` — which IS the basename,
      // the same value that `f.endsWith(leafBasename)` would match for all `f` values
      // (since leafBasename is always a bare filename with no path prefix).
      // Therefore `!modifiedFiles.some(f => f.endsWith(leafBasename))` is a strictly
      // redundant sub-condition and has been removed.
      //
      // Post-attribution-convergence role: after T2 Scheme B/A fix, leafBasename in
      // the reverse-index is always the leaf that ACTUALLY holds the phrase (no
      // cross-leaf cartesian ghost entries). This condition now purely implements
      // "do not flag a leaf that was not modified in this diff" — it no longer needs
      // to compensate for cross-leaf attribution errors (that responsibility has
      // moved to extraction). This is the condition's sole remaining semantic.
      if (!modifiedBasenames.has(leafBasename)) continue;

      findings.push({ phrase, leaf: leafBasename, dependentTestFile: testFile });
    }
  }

  // Deduplicate by phrase+leaf+testFile triplet.
  const seen = new Set();
  return findings.filter(({ phrase, leaf, dependentTestFile }) => {
    const key = `${phrase}|${leaf}|${dependentTestFile}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Live mode: git integration
// ---------------------------------------------------------------------------

function tryGetMergeBase() {
  try {
    return execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function parseRuleLeafDiff(diff) {
  const ruleDiff = new Map();
  let oldLeaf = null;
  let newLeaf = null;
  let inHunk = false;
  const append = (leaf, kind, text) => {
    if (!leaf) return;
    if (!ruleDiff.has(leaf)) ruleDiff.set(leaf, { removedLines: [], addedLines: [] });
    ruleDiff.get(leaf)[kind].push(text);
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      oldLeaf = newLeaf = null;
      inHunk = false;
    } else if (line.startsWith("@@ ")) {
      inHunk = true;
    } else if (!inHunk) {
      if (line.startsWith("--- ")) {
        oldLeaf = line.match(/^--- a\/\.devpro\/agent-rules\/([^/]+\.md)$/)?.[1] ?? null;
      } else if (line.startsWith("+++ ")) {
        newLeaf = line.match(/^\+\+\+ b\/\.devpro\/agent-rules\/([^/]+\.md)$/)?.[1] ?? null;
      }
    } else if (line.startsWith("-")) {
      append(oldLeaf, "removedLines", line.slice(1));
    } else if (line.startsWith("+")) {
      append(newLeaf, "addedLines", line.slice(1));
    }
  }
  return ruleDiff;
}

function tryGetRuleLeafDiff(mergeBase) {
  try {
    const diff = execFileSync(
      "git",
      ["diff", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--unified=0", mergeBase, "HEAD", "--", ".devpro/agent-rules/*.md"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    if (!diff.trim()) return null;
    return parseRuleLeafDiff(diff);
  } catch {
    return null;
  }
}

function tryGetModifiedFiles(mergeBase) {
  try {
    const output = execFileSync(
      "git",
      ["diff", "--name-only", mergeBase, "HEAD"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 8000,
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    return output.trim() ? output.trim().split("\n") : [];
  } catch {
    return null;
  }
}

function tryGetCommitMessages(mergeBase) {
  try {
    const output = execFileSync(
      "git",
      ["log", `${mergeBase}..HEAD`, "--format=%s%n%b"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 8000,
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    return output.trim() ? output.trim().split("\n") : [];
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// T4 + T5: Constructed unit tests for pure function (no git dependency)
// ---------------------------------------------------------------------------

describe("protected anchor detection — pure function (constructed cases)", () => {
  // Synthetic index entries for constructed cases.
  // Simulates: worktree-hygiene-grep.test.mjs asserts that
  // git-branch-hygiene.md contains "### Local Worktree Hygiene"
  // and "禁止自動移除".
  const syntheticIndex = new Map([
    [
      "### Local Worktree Hygiene",
      [
        {
          testFile: "worktree-hygiene-grep.test.mjs",
          leafBasename: "git-branch-hygiene.md",
        },
      ],
    ],
    [
      "禁止自動移除",
      [
        {
          testFile: "worktree-hygiene-grep.test.mjs",
          leafBasename: "git-branch-hygiene.md",
        },
      ],
    ],
    [
      "Post-merge Local Sync 序列",
      [
        {
          testFile: "post-merge-local-sync-grep.test.mjs",
          leafBasename: "git-workflow-tracking.md",
        },
      ],
    ],
  ]);

  // ── T4: Prove-it — removal without exemption MUST be detected ──────────

  test("T4: detects protected anchor removal when phrase removed + test not updated + no anchor-move marker", () => {
    // Constructed case: phrase "### Local Worktree Hygiene" is removed from
    // git-branch-hygiene.md, the dependent grep-test is NOT updated,
    // and no commit message has "anchor-move:".
    const findings = detectAnchorRemovals({
      ruleDiff: new Map([["git-branch-hygiene.md", { removedLines: ["### Local Worktree Hygiene"], addedLines: [] }]]),
      testPhraseIndex: syntheticIndex,
      modifiedFiles: ["git-branch-hygiene.md"],
      commitMessages: ["chore: compress git-branch-hygiene.md"],
    });

    assert.ok(
      findings.length > 0,
      "protected anchor removal was NOT detected — detectAnchorRemovals must flag " +
        "removal of '### Local Worktree Hygiene' when dependent test is not updated and no anchor-move: marker"
    );
    assert.ok(
      findings.some((f) => f.phrase === "### Local Worktree Hygiene"),
      "finding must name the removed protected anchor phrase"
    );
    assert.ok(
      findings.some((f) => f.dependentTestFile === "worktree-hygiene-grep.test.mjs"),
      "finding must name the dependent grep-test file"
    );
  });

  test("T4: detects multiple protected anchor removals in a single diff", () => {
    const findings = detectAnchorRemovals({
      ruleDiff: new Map([["git-branch-hygiene.md", { removedLines: ["### Local Worktree Hygiene", "禁止自動移除"], addedLines: [] }]]),
      testPhraseIndex: syntheticIndex,
      modifiedFiles: ["git-branch-hygiene.md"],
      commitMessages: ["chore: compress"],
    });

    assert.ok(
      findings.length >= 2,
      `expected ≥2 findings for two removed protected anchors, got ${findings.length}`
    );
  });

  test("T4: finding metadata contains leaf and dependentTestFile", () => {
    const findings = detectAnchorRemovals({
      ruleDiff: new Map([["git-workflow-tracking.md", { removedLines: ["Post-merge Local Sync 序列"], addedLines: [] }]]),
      testPhraseIndex: syntheticIndex,
      modifiedFiles: ["git-workflow-tracking.md"],
      commitMessages: ["chore: reword"],
    });

    assert.ok(findings.length > 0, "expected at least one finding");
    const f = findings[0];
    assert.ok(typeof f.phrase === "string", "finding.phrase must be a string");
    assert.ok(typeof f.leaf === "string", "finding.leaf must be a string");
    assert.ok(
      typeof f.dependentTestFile === "string",
      "finding.dependentTestFile must be a string"
    );
  });

  // ── T5: Exemption channel 1 — anchor-move: commit marker ───────────────

  test("T5: exemption via anchor-move: marker in commit message — no findings emitted", () => {
    // Legitimate wording correction: phrase removed but commit message
    // carries "anchor-move:" — must pass through without flagging.
    const findings = detectAnchorRemovals({
      ruleDiff: new Map([["git-branch-hygiene.md", { removedLines: ["### Local Worktree Hygiene"], addedLines: [] }]]),
      testPhraseIndex: syntheticIndex,
      modifiedFiles: ["git-branch-hygiene.md"],
      commitMessages: [
        "anchor-move: rename worktree hygiene section heading",
        "updated worktree-hygiene-grep.test.mjs phrase",
      ],
    });

    assert.strictEqual(
      findings.length,
      0,
      "anchor-move: commit marker must exempt all protected anchor removals — advisory must not block legitimate wording corrections"
    );
  });

  test("T5: anchor-move: marker anywhere in commit messages grants exemption (not only first line)", () => {
    const findings = detectAnchorRemovals({
      ruleDiff: new Map([["git-branch-hygiene.md", { removedLines: ["禁止自動移除"], addedLines: [] }]]),
      testPhraseIndex: syntheticIndex,
      modifiedFiles: ["git-branch-hygiene.md"],
      commitMessages: [
        "chore: update git-branch-hygiene rules",
        "anchor-move: moved 禁止自動移除 to new subsection",
      ],
    });

    assert.strictEqual(
      findings.length,
      0,
      "anchor-move: in any commit message (not only the first) must grant exemption"
    );
  });

  // ── T5: Exemption channel 2 — dependent test updated in same diff ───────

  test("T5: exemption via dependent test updated in same diff — no findings emitted", () => {
    // Legitimate wording correction: phrase removed but the dependent test
    // is updated in the same diff (modifiedFiles includes the test file).
    const findings = detectAnchorRemovals({
      ruleDiff: new Map([["git-branch-hygiene.md", { removedLines: ["### Local Worktree Hygiene"], addedLines: [] }]]),
      testPhraseIndex: syntheticIndex,
      modifiedFiles: [
        "git-branch-hygiene.md",
        "worktree-hygiene-grep.test.mjs",
      ],
      commitMessages: ["chore: rename worktree hygiene section"],
    });

    assert.strictEqual(
      findings.length,
      0,
      "updating the dependent grep-test in the same diff must exempt the protected anchor removal"
    );
  });

  test("T5: no false positive — phrase not removed means no finding", () => {
    const findings = detectAnchorRemovals({
      ruleDiff: new Map([["git-branch-hygiene.md", { removedLines: ["some unrelated line removed"], addedLines: [] }]]),
      testPhraseIndex: syntheticIndex,
      modifiedFiles: ["git-branch-hygiene.md"],
      commitMessages: ["chore: minor edit"],
    });

    assert.strictEqual(
      findings.length,
      0,
      "no protected phrase removed → no findings (must not emit false positive)"
    );
  });

  test("T5: no false positive — empty diff produces no findings", () => {
    const findings = detectAnchorRemovals({
      ruleDiff: new Map(),
      testPhraseIndex: syntheticIndex,
      modifiedFiles: [],
      commitMessages: [],
    });

    assert.strictEqual(
      findings.length,
      0,
      "empty diff must produce zero findings"
    );
  });

  test("T5: no false positive — phrase removed from unrelated file (not the guarded leaf)", () => {
    // The phrase "### Local Worktree Hygiene" is only protected in git-branch-hygiene.md.
    // If removed lines come from a diff of a different file, should NOT flag.
    const findings = detectAnchorRemovals({
      ruleDiff: new Map([["some-other-file.md", { removedLines: ["### Local Worktree Hygiene"], addedLines: [] }]]),
      testPhraseIndex: syntheticIndex,
      modifiedFiles: ["some-other-file.md"], // not git-branch-hygiene.md
      commitMessages: ["chore: edit"],
    });

    assert.strictEqual(
      findings.length,
      0,
      "phrase removed from non-guarded leaf must not produce a finding"
    );
  });

  // T1 (prove-it): #1034 end-to-end constructed scenario — extractPhrasesFromTestSource
  // builds the index from a multi-leaf test fixture, then detectAnchorRemovals is called
  // with X removed and Y modified (unrelated). The system must NOT flag Y.
  //
  // Pre-fix: FAILS because cartesian product assigns P to BOTH X and Y in the index,
  // causing detectAnchorRemovals to flag Y even though Y never held P.
  //
  // Post-fix (T2): PASSES because Scheme B var-alias tracking attributes P only to X,
  // so Y is not in the reverse-index for P and detectAnchorRemovals correctly skips Y.
  test("#1034 constructed scenario: P in X, X removes P, Y unrelated change, test unchanged — must NOT flag Y", () => {
    const leafX = "ai-autonomy.md";
    const leafY = "code-review-checklist.md";
    const phraseP = "bounded retry";
    const testFileName = "multi-leaf-example-grep.test.mjs";

    // Multi-leaf test source: leafA (=X) asserts phraseP, leafB (=Y) asserts different phrase.
    const multiLeafSrc = `
const leafA = readFileSync(".devpro/agent-rules/ai-autonomy.md", "utf8");
const leafB = readFileSync(".devpro/agent-rules/code-review-checklist.md", "utf8");
assert.ok(leafA.includes("bounded retry"), "missing in ai-autonomy");
assert.ok(leafB.includes("Trajectory sanity"), "missing in code-review-checklist");
`;

    // Build the index using extractPhrasesFromTestSource (the function under test).
    const pairs = extractPhrasesFromTestSource(multiLeafSrc);
    const index = new Map();
    for (const { phrase, leafBasename } of pairs) {
      if (!index.has(phrase)) index.set(phrase, []);
      index.get(phrase).push({ testFile: testFileName, leafBasename });
    }

    // Scenario: X (ai-autonomy.md) is modified to remove P ("bounded retry");
    // Y (code-review-checklist.md) has an unrelated edit; dependent test NOT updated.
    const findings = detectAnchorRemovals({
      ruleDiff: new Map([[leafX, { removedLines: [phraseP], addedLines: [] }]]),
      testPhraseIndex: index,
      modifiedFiles: [leafX, leafY],
      commitMessages: ["chore: update ai-autonomy rules"],
    });

    // Must flag leafX: P was truly removed from its guarded leaf.
    const xFinding = findings.find((f) => f.leaf === leafX);
    assert.ok(
      xFinding,
      `must flag leafX=${leafX}: P="${phraseP}" was removed from its guarded leaf and test not updated`
    );

    // MUST NOT flag leafY: P was never in leafY.
    const yFinding = findings.find((f) => f.leaf === leafY);
    assert.ok(
      !yFinding,
      `must NOT flag leafY=${leafY}: P="${phraseP}" was never in leafY (unrelated modification). ` +
        "Pre-fix this fails because cartesian product in extractPhrasesFromTestSource adds {P, leafY} " +
        "to the index — post-fix Scheme B var-alias tracking resolves phraseP only to leafX."
    );
  });

  test("T5: deduplication — same phrase+leaf+test triplet not reported twice", () => {
    // Construct an index with the same entry duplicated.
    const dupIndex = new Map([
      [
        "### Local Worktree Hygiene",
        [
          {
            testFile: "worktree-hygiene-grep.test.mjs",
            leafBasename: "git-branch-hygiene.md",
          },
          {
            testFile: "worktree-hygiene-grep.test.mjs",
            leafBasename: "git-branch-hygiene.md",
          },
        ],
      ],
    ]);

    const findings = detectAnchorRemovals({
      ruleDiff: new Map([["git-branch-hygiene.md", { removedLines: ["### Local Worktree Hygiene"], addedLines: [] }]]),
      testPhraseIndex: dupIndex,
      modifiedFiles: ["git-branch-hygiene.md"],
      commitMessages: ["chore: edit"],
    });

    assert.strictEqual(
      findings.length,
      1,
      "duplicate phrase+leaf+test triplets must be deduplicated to exactly 1 finding"
    );
  });

  // ── T3: added-line net-removal judgment ─────────────────────────────────
  // Bug: `detectAnchorRemovals` only checked removedLines — if a line containing
  // the protected phrase was rewritten (both removed and re-added), the function
  // reported a false-positive "removal" even though the phrase survived in addedLines.
  // Fix: phrase is a NET removal only if its guarded leaf removes it without re-adding it there.

  test("[T3-false-positive] same phrase in both removed AND added lines (rewrite) → no finding", () => {
    // Scenario: frontmatter line "Contains POSIX-only shell" reworded from
    // "14 組" to "16 組" — phrase "POSIX-only shell" survives in the added line.
    const phrase = "POSIX-only shell";
    const index = new Map([
      [
        phrase,
        [{ testFile: "posix-shell-grep.test.mjs", leafBasename: "git-branch-hygiene.md" }],
      ],
    ]);

    const findings = detectAnchorRemovals({
      ruleDiff: new Map([["git-branch-hygiene.md", { removedLines: [`Table covers 14 組 ${phrase} verbs`], addedLines: [`Table covers 16 組 ${phrase} verbs`] }]]),
      testPhraseIndex: index,
      modifiedFiles: ["git-branch-hygiene.md"],
      commitMessages: ["fix: update verb count"],
    });

    assert.strictEqual(
      findings.length,
      0,
      `[T3-false-positive] phrase "${phrase}" present in both removed and added lines is a REWRITE, not a removal — must produce zero findings`
    );
  });

  test("[T3-true-removal] phrase in removed lines but NOT in added lines → finding emitted", () => {
    // True removal: phrase is deleted and not re-added anywhere.
    const phrase = "禁止自動移除";
    const index = new Map([
      [
        phrase,
        [{ testFile: "worktree-hygiene-grep.test.mjs", leafBasename: "git-branch-hygiene.md" }],
      ],
    ]);

    const findings = detectAnchorRemovals({
      ruleDiff: new Map([["git-branch-hygiene.md", { removedLines: [phrase], addedLines: ["some unrelated new line"] }]]),
      testPhraseIndex: index,
      modifiedFiles: ["git-branch-hygiene.md"],
      commitMessages: ["chore: remove section"],
    });

    assert.ok(
      findings.length > 0,
      `[T3-true-removal] phrase "${phrase}" in removed but not in added lines MUST produce a finding`
    );
    assert.ok(
      findings.some((f) => f.phrase === phrase),
      `[T3-true-removal] finding must name phrase "${phrase}"`
    );
  });

  test("[T3-exemption] anchor-move: marker still exempts even when phrase only in removed lines", () => {
    const phrase = "### Local Worktree Hygiene";
    const index = new Map([
      [
        phrase,
        [{ testFile: "worktree-hygiene-grep.test.mjs", leafBasename: "git-branch-hygiene.md" }],
      ],
    ]);

    const findings = detectAnchorRemovals({
      ruleDiff: new Map([["git-branch-hygiene.md", { removedLines: [phrase], addedLines: [] }]]),
      testPhraseIndex: index,
      modifiedFiles: ["git-branch-hygiene.md"],
      commitMessages: ["anchor-move: rename worktree hygiene section"],
    });

    assert.strictEqual(
      findings.length,
      0,
      "[T3-exemption] anchor-move: marker must exempt all findings even with T3 fix active"
    );
  });
});

// ---------------------------------------------------------------------------
// Phrase extraction unit tests
// ---------------------------------------------------------------------------

describe("file-scoped protected anchor removals", () => {
  const phrase = "protected source anchor";
  const index = new Map([[phrase, [
    { testFile: "source-guard.test.mjs", leafBasename: "source.md" },
  ]]]);

  const crossFileDiff = [
    "diff --git a/.devpro/agent-rules/source.md b/.devpro/agent-rules/source.md",
    "--- a/.devpro/agent-rules/source.md", "+++ b/.devpro/agent-rules/source.md",
    "@@ -1 +0,0 @@", `-${phrase}`,
    "diff --git a/.devpro/agent-rules/target.md b/.devpro/agent-rules/target.md",
    "--- /dev/null", "+++ b/.devpro/agent-rules/target.md",
    "@@ -0,0 +1 @@", `+${phrase}`,
  ].join("\n");

  test("unified diff attribution carries a cross-file move into detection", () => {
    const ruleDiff = parseRuleLeafDiff(crossFileDiff);
    assert.deepEqual([...ruleDiff], [
      ["source.md", { removedLines: [phrase], addedLines: [] }],
      ["target.md", { removedLines: [], addedLines: [phrase] }],
    ]);
    assert.deepEqual(detectAnchorRemovals({
      ruleDiff, testPhraseIndex: index, modifiedFiles: ["source.md", "target.md"], commitMessages: [],
    }), [{ phrase, leaf: "source.md", dependentTestFile: "source-guard.test.mjs" }]);
  });

  test("deleted leaf removals retain the old path; non-rule files supply no anchors", () => {
    const diff = crossFileDiff.replace("+++ b/.devpro/agent-rules/source.md", "+++ /dev/null")
      + "\ndiff --git a/docs/source.md b/docs/source.md\n--- a/docs/source.md\n+++ b/docs/source.md\n@@ -0,0 +1 @@\n+unrelated";
    assert.deepEqual([...parseRuleLeafDiff(diff)], [
      ["source.md", { removedLines: [phrase], addedLines: [] }],
      ["target.md", { removedLines: [], addedLines: [phrase] }],
    ]);
  });

  test("header-shaped removed and added content stays in its hunk and cannot switch attribution", () => {
    const diff = [
      "diff --git a/.devpro/agent-rules/source.md b/.devpro/agent-rules/source.md",
      "--- a/.devpro/agent-rules/source.md", "+++ b/.devpro/agent-rules/source.md",
      "@@ -1,2 +1,2 @@", `-${phrase}`, "--- a/.devpro/agent-rules/target.md",
      "+++ b/.devpro/agent-rules/target.md", "+" + phrase,
    ].join("\n");
    const ruleDiff = parseRuleLeafDiff(diff);
    assert.deepEqual([...ruleDiff], [["source.md", {
      removedLines: [phrase, "-- a/.devpro/agent-rules/target.md"],
      addedLines: ["++ b/.devpro/agent-rules/target.md", phrase],
    }]]);
    assert.deepEqual(detectAnchorRemovals({
      ruleDiff, testPhraseIndex: index, modifiedFiles: ["source.md"], commitMessages: [],
    }), []);
  });

  for (const exemption of ["marker", "test-update"]) {
    test(`cross-file move retains the ${exemption} exemption`, () => {
      assert.deepEqual(detectAnchorRemovals({
        ruleDiff: parseRuleLeafDiff(crossFileDiff), testPhraseIndex: index,
        modifiedFiles: ["source.md", "target.md", ...(exemption === "test-update" ? ["source-guard.test.mjs"] : [])],
        commitMessages: exemption === "marker" ? ["anchor-move: explicitly repoint this anchor"] : [],
      }), []);
    });
  }

  test("adding the same phrase to another leaf cannot hide its source removal", () => {
    const findings = detectAnchorRemovals({
      ruleDiff: new Map([
        ["source.md", { removedLines: [phrase], addedLines: [] }],
        ["target.md", { removedLines: [], addedLines: [phrase] }],
      ]),
      testPhraseIndex: index,
      modifiedFiles: ["source.md", "target.md"],
      commitMessages: ["chore: move a paragraph"],
    });
    assert.deepEqual(findings, [{
      phrase, leaf: "source.md", dependentTestFile: "source-guard.test.mjs",
    }]);
  });

  test("a removal in another leaf cannot implicate an independently edited source", () => {
    const findings = detectAnchorRemovals({
      ruleDiff: new Map([
        ["source.md", { removedLines: ["unrelated"], addedLines: ["new wording"] }],
        ["target.md", { removedLines: [phrase], addedLines: [] }],
      ]),
      testPhraseIndex: index,
      modifiedFiles: ["source.md", "target.md"],
      commitMessages: ["chore: edit two leaves"],
    });
    assert.deepEqual(findings, []);
  });
});

describe("extractPhrasesFromTestSource — phrase extraction correctness", () => {
  test("extracts phrases from REQUIRED array pattern", () => {
    const src = `
import { readFileSync } from 'node:fs';
const ruleBody = readFileSync('.devpro/agent-rules/git-workflow-tracking.md', 'utf8');
const REQUIRED = [
  "Post-merge Local Sync",
  "必須主動同步",
];
for (const phrase of REQUIRED) {
  assert.ok(ruleBody.includes(phrase));
}
`;
    const pairs = extractPhrasesFromTestSource(src);
    const phrases = pairs.map((p) => p.phrase);
    assert.ok(
      phrases.includes("Post-merge Local Sync"),
      "must extract 'Post-merge Local Sync' from REQUIRED array"
    );
    assert.ok(
      phrases.includes("必須主動同步"),
      "must extract '必須主動同步' from REQUIRED array"
    );
  });

  test("extracts phrases from inline .includes() pattern", () => {
    const src = `
const ruleBody = readFileSync(path.join(rulesDir, "rule-design-principles.md"), "utf8");
assert.ok(ruleBody.includes("## Example Sanitization"), "missing heading");
assert.ok(ruleBody.includes("Canonical FORBIDDEN Regex Set"), "missing table");
`;
    const pairs = extractPhrasesFromTestSource(src);
    const phrases = pairs.map((p) => p.phrase);
    assert.ok(
      phrases.includes("## Example Sanitization"),
      "must extract '## Example Sanitization' from .includes() call"
    );
    assert.ok(
      phrases.includes("Canonical FORBIDDEN Regex Set"),
      "must extract 'Canonical FORBIDDEN Regex Set' from .includes() call"
    );
  });

  test("associates extracted phrases with the correct leaf basename", () => {
    const src = `
const content = readFileSync(".devpro/agent-rules/ai-autonomy-root-cause.md", "utf8");
assert.ok(content.includes("Root-Cause First"), "missing phrase");
`;
    const pairs = extractPhrasesFromTestSource(src);
    const match = pairs.find((p) => p.phrase === "Root-Cause First");
    assert.ok(match, "phrase 'Root-Cause First' must be extracted");
    assert.strictEqual(
      match.leafBasename,
      "ai-autonomy-root-cause.md",
      "phrase must be associated with ai-autonomy-root-cause.md"
    );
  });

  test("returns empty array when no agent-rules files are referenced", () => {
    const src = `
const content = readFileSync(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md", "utf8");
assert.ok(content.includes("必過"), "missing phrase");
`;
    const pairs = extractPhrasesFromTestSource(src);
    assert.strictEqual(
      pairs.length,
      0,
      "no agent-rules references → no protected anchor pairs"
    );
  });

  test("handles test files that reference multiple agent-rules leaves", () => {
    const src = `
const leafA = readFileSync(".devpro/agent-rules/ai-autonomy.md", "utf8");
const leafB = readFileSync(".devpro/agent-rules/code-review-checklist.md", "utf8");
assert.ok(leafA.includes("bounded retry"), "missing in ai-autonomy");
assert.ok(leafB.includes("Trajectory sanity"), "missing in code-review-checklist");
`;
    const pairs = extractPhrasesFromTestSource(src);
    const leaves = new Set(pairs.map((p) => p.leafBasename));
    assert.ok(leaves.has("ai-autonomy.md"), "must reference ai-autonomy.md");
    assert.ok(
      leaves.has("code-review-checklist.md"),
      "must reference code-review-checklist.md"
    );
  });

  // T1 (prove-it): per-assertion attribution — multi-leaf test must NOT attribute
  // phrase to non-asserting leaf (issue #1034).
  // Pre-fix: this test FAILS because the cartesian product produces cross-leaf
  // errors like {phrase:"bounded retry", leafBasename:"code-review-checklist.md"}.
  // Post-fix (T2): this test PASSES because per-assertion Scheme B var-alias
  // tracking resolves each phrase to only the leaf whose variable is the receiver.
  test("per-assertion attribution: multi-leaf test does not attribute phrase to non-asserting leaf", () => {
    const src = `
const leafA = readFileSync(".devpro/agent-rules/ai-autonomy.md", "utf8");
const leafB = readFileSync(".devpro/agent-rules/code-review-checklist.md", "utf8");
assert.ok(leafA.includes("bounded retry"), "missing in ai-autonomy");
assert.ok(leafB.includes("Trajectory sanity"), "missing in code-review-checklist");
`;
    const pairs = extractPhrasesFromTestSource(src);

    // "bounded retry" must be attributed to ai-autonomy.md only.
    const boundedRetryPairs = pairs.filter((p) => p.phrase === "bounded retry");
    assert.ok(
      boundedRetryPairs.length > 0,
      "'bounded retry' must be extracted (it is asserted via leafA which reads ai-autonomy.md)"
    );
    assert.ok(
      boundedRetryPairs.some((p) => p.leafBasename === "ai-autonomy.md"),
      "'bounded retry' must be attributed to ai-autonomy.md"
    );
    // Cross-leaf error: must NOT attribute "bounded retry" to code-review-checklist.md.
    assert.ok(
      !pairs.some(
        (p) =>
          p.phrase === "bounded retry" &&
          p.leafBasename === "code-review-checklist.md"
      ),
      "CROSS-LEAF ERROR: 'bounded retry' must NOT be attributed to code-review-checklist.md " +
        "(it is asserted on leafA=ai-autonomy.md, not leafB=code-review-checklist.md). " +
        "This fails pre-fix due to cartesian product; must pass after T2 per-assertion fix."
    );

    // "Trajectory sanity" must be attributed to code-review-checklist.md only.
    const trajectorySanityPairs = pairs.filter(
      (p) => p.phrase === "Trajectory sanity"
    );
    assert.ok(
      trajectorySanityPairs.length > 0,
      "'Trajectory sanity' must be extracted (it is asserted via leafB which reads code-review-checklist.md)"
    );
    assert.ok(
      trajectorySanityPairs.some(
        (p) => p.leafBasename === "code-review-checklist.md"
      ),
      "'Trajectory sanity' must be attributed to code-review-checklist.md"
    );
    // Cross-leaf error: must NOT attribute "Trajectory sanity" to ai-autonomy.md.
    assert.ok(
      !pairs.some(
        (p) =>
          p.phrase === "Trajectory sanity" &&
          p.leafBasename === "ai-autonomy.md"
      ),
      "CROSS-LEAF ERROR: 'Trajectory sanity' must NOT be attributed to ai-autonomy.md " +
        "(it is asserted on leafB=code-review-checklist.md, not leafA=ai-autonomy.md). " +
        "This fails pre-fix due to cartesian product; must pass after T2 per-assertion fix."
    );
  });

  test("short generic terms from .includes() are NOT indexed (≥8 byte threshold)", () => {
    // Short terms like "SHALL", "grep", "flow", "pushd" (all <8 bytes) that appear
    // in .includes() calls must NOT be indexed as protected anchors — they are
    // cross-file noise and would produce false positives when those terms happen
    // to be removed from any agent-rules file for unrelated reasons.
    // The ≥8 byte minimum applies to Pattern B (.includes()) only; Pattern A
    // (REQUIRED arrays) is intentionally left unfiltered (author-curated anchors).
    const src = `
const ruleBody = readFileSync(".devpro/agent-rules/git-branch-hygiene.md", "utf8");
// These short terms must NOT be indexed:
assert.ok(ruleBody.includes("SHALL"), "presence check");
assert.ok(ruleBody.includes("grep"), "tool check");
assert.ok(ruleBody.includes("flow"), "flow check");
assert.ok(ruleBody.includes("squash"), "squash check");
// This meaningful phrase (≥8 bytes) MUST be indexed:
assert.ok(ruleBody.includes("### Local Worktree Hygiene"), "heading present");
`;
    const pairs = extractPhrasesFromTestSource(src);
    const phrases = pairs.map((p) => p.phrase);

    // Short terms must be absent from the index.
    assert.ok(!phrases.includes("SHALL"), "'SHALL' (5 bytes) must NOT be indexed");
    assert.ok(!phrases.includes("grep"), "'grep' (4 bytes) must NOT be indexed");
    assert.ok(!phrases.includes("flow"), "'flow' (4 bytes) must NOT be indexed");
    assert.ok(!phrases.includes("squash"), "'squash' (6 bytes) must NOT be indexed");

    // Meaningful phrase must still be indexed.
    assert.ok(
      phrases.includes("### Local Worktree Hygiene"),
      "'### Local Worktree Hygiene' (≥8 bytes) must be indexed via .includes() extraction"
    );
  });

  // T4 (P3-3): 8-byte threshold behavior for CJK anchors.
  //
  // CJK characters are multi-byte in UTF-8 (each CJK char = 3 bytes).
  // The 8-byte threshold applies to .includes() (Pattern B) and assert.match() (Pattern C).
  // REQUIRED arrays (Pattern A) are NOT byte-filtered — author-curated, short CJK
  // phrases like "禁止" (6 bytes, 2 chars) are legitimate protected anchors.
  //
  // This test locks the 8-byte threshold behavior for short CJK anchors:
  //   - "禁" (3 bytes, 1 char):  filtered by .includes() threshold → NOT indexed
  //   - "禁止" (6 bytes, 2 chars): filtered by .includes() threshold → NOT indexed
  //     but REQUIRED array "禁止" IS indexed (REQUIRED exemption — Pattern A unfiltered)
  //   - "禁止自動移除" (21 bytes, 7 chars): ≥8 bytes → indexed via .includes()
  test("P3-3 CJK 8-byte threshold: short CJK .includes() filtered, REQUIRED exemption retained, long CJK preserved", () => {
    // 8-byte threshold: CJK .includes() anchors must be ≥8 bytes to be indexed.
    // "禁" = 3 bytes (filtered), "禁止" = 6 bytes (filtered), "禁止自動移除" = 21 bytes (retained).
    const src = `
const ruleBody = readFileSync(".devpro/agent-rules/ai-autonomy.md", "utf8");
// Short CJK via .includes() — must be filtered by 8-byte threshold:
assert.ok(ruleBody.includes("禁"), "single CJK char 3 bytes filtered");
assert.ok(ruleBody.includes("禁止"), "two CJK chars 6 bytes filtered");
// Long CJK via .includes() — must be retained (≥8 bytes):
assert.ok(ruleBody.includes("禁止自動移除"), "7-char CJK 21 bytes retained");
// Short CJK in REQUIRED array — must be retained (REQUIRED is not byte-filtered):
const REQUIRED = ["禁止"];
`;
    const pairs = extractPhrasesFromTestSource(src);
    const phrases = pairs.map((p) => p.phrase);

    // Short CJK .includes() — filtered (below 8-byte threshold).
    assert.ok(
      !phrases.includes("禁"),
      '"禁" (3 bytes) via .includes() must NOT be indexed — below 8-byte threshold'
    );
    // Precise check: "禁止" must NOT appear from .includes() (6 bytes < 8 threshold).
    // It MAY appear from REQUIRED array (exemption). Count should be exactly from REQUIRED.
    // Since we have only 1 leaf and "禁止" is in REQUIRED, it will appear once from REQUIRED.
    // The .includes("禁止") call is filtered, so there should be exactly 1 entry (from REQUIRED).
    const disallowedPhrases = pairs.filter((p) => p.phrase === "禁止");
    // REQUIRED yields 1 entry; .includes() should yield 0 (filtered).
    // We verify REQUIRED exemption: "禁止" is in REQUIRED → must be in index.
    assert.ok(
      disallowedPhrases.length >= 1,
      '"禁止" must be indexed via REQUIRED array exemption (Pattern A is not byte-filtered)'
    );

    // Long CJK .includes() — retained (≥8 bytes).
    assert.ok(
      phrases.includes("禁止自動移除"),
      '"禁止自動移除" (21 bytes, 7 CJK chars) via .includes() must be indexed — ≥8-byte threshold'
    );
  });
});

// ---------------------------------------------------------------------------
// Structural self-checks (advisory literals required per done-when 3)
// ---------------------------------------------------------------------------

describe("self-check: required advisory literals in this test file", () => {
  const selfSrc = readFileSync(
    path.join(testsDir, "protected-anchor-grep.test.mjs"),
    "utf8"
  );

  test("this test file contains 'protected anchor' literal", () => {
    assert.ok(
      selfSrc.includes("protected anchor"),
      "this file must contain literal 'protected anchor' (done-when 3 advisory anchor)"
    );
  });

  test("this test file contains 'anchor-move' literal", () => {
    assert.ok(
      selfSrc.includes("anchor-move"),
      "this file must contain literal 'anchor-move' (done-when 3 exemption marker)"
    );
  });
});

// ---------------------------------------------------------------------------
// Regression cases — 66a55f3 incident (FR-B widening, pattern C)
//
// Background: commit 66a55f3 silently removed the phrase
// "cherry-pick 該批 sync commit" from rules-flow.md without updating the
// dependent test (sync-agent-rules.test.mjs). The original filter
// `f.includes("grep")` excluded non-grep-named tests from the index, so the
// guard did not fire. These two cases lock down that regression path.
//
// Case 1 (pure-function layer): synthetic index, proves detectAnchorRemovals
//   flags the removal when the index includes a non-grep test entry.
// Case 2 (extraction layer): real sync-agent-rules.test.mjs source, proves
//   extractPhrasesFromTestSource returns the phrase via pattern C after
//   widening the filter to all *.test.mjs files.
// ---------------------------------------------------------------------------

describe("regression: 66a55f3 — silent removal of sync commit phrase (FR-B widening)", () => {
  // ── Case 1: pure-function layer ─────────────────────────────────────────
  test("pure-function: detectAnchorRemovals flags removal of sync commit SHA phrase from non-grep test", () => {
    // Synthetic index: simulates sync-agent-rules.test.mjs guarding rules-flow.md.
    // This reproduces the 66a55f3 scenario where a non-grep-named test was excluded
    // from the index because buildTestPhraseIndex filtered on f.includes("grep").
    const syntheticIndex66a = new Map([
      [
        "同一份 sync commit SHA",
        [
          {
            testFile: "sync-agent-rules.test.mjs",
            leafBasename: "rules-flow.md",
          },
        ],
      ],
    ]);

    const findings = detectAnchorRemovals({
      ruleDiff: new Map([["rules-flow.md", { removedLines: ["同一份 sync commit SHA"], addedLines: [] }]]),
      testPhraseIndex: syntheticIndex66a,
      modifiedFiles: ["rules-flow.md"],
      commitMessages: ["chore: compress rules-flow.md"],
    });

    assert.ok(
      findings.length > 0,
      "detectAnchorRemovals must flag removal of non-grep-test-guarded phrase " +
        "'同一份 sync commit SHA' — this proves the pure-function layer works " +
        "once the index includes non-grep test entries (66a55f3 regression)"
    );
    assert.ok(
      findings.some((f) => f.dependentTestFile === "sync-agent-rules.test.mjs"),
      "finding must name sync-agent-rules.test.mjs as the dependent test"
    );
    assert.ok(
      findings.some((f) => f.leaf === "rules-flow.md"),
      "finding must name rules-flow.md as the protected leaf"
    );
  });

  // ── Case 2: extraction layer (locks down pattern C + filter widening) ───
  test("extraction: extractPhrasesFromTestSource returns 'cherry-pick 該批 sync commit' from real sync-agent-rules.test.mjs source", () => {
    // This test reads the real sync-agent-rules*.test.mjs family source and runs
    // extractPhrasesFromTestSource against it. The phrase "cherry-pick 該批 sync commit"
    // (originally in sync-agent-rules.test.mjs, moved to a split sibling during
    // tier-runtime balancing) must appear in the result. If either:
    //   (a) buildTestPhraseIndex filter still excludes non-grep tests, OR
    //   (b) pattern C extraction is missing or broken,
    // this test will fail — locking down the 66a55f3 regression. The family is
    // scanned (not one hardcoded filename) so future long-pole splits of the
    // sync-agent-rules test file don't silently break this guard.
    const familyFiles = readdirSync(testsDir)
      .filter((f) => /^sync-agent-rules.*\.test\.mjs$/.test(f))
      .sort();
    const pairs = familyFiles.flatMap((f) =>
      extractPhrasesFromTestSource(readFileSync(path.join(testsDir, f), "utf8"))
    );

    const targetPhrase = "cherry-pick 該批 sync commit";
    const match = pairs.find(
      (p) =>
        p.phrase === targetPhrase && p.leafBasename === "rules-flow.md"
    );

    assert.ok(
      match,
      `extractPhrasesFromTestSource must return {phrase:"${targetPhrase}", leafBasename:"rules-flow.md"} ` +
        "from sync-agent-rules.test.mjs source via pattern C (assert.match literal extraction). " +
        "If this fails: either the filter still excludes non-grep tests (FR-B widening regression) " +
        "or pattern C extraction is missing/broken (66a55f3 incident replay)."
    );
  });
});

// ---------------------------------------------------------------------------
// Live mode: runs on actual git diff if git is available
// ---------------------------------------------------------------------------

test("live mode: protected anchor guard on current branch diff (advisory, fail-open)", async () => {
  const mergeBase = tryGetMergeBase();
  if (!mergeBase) {
    // Fail-open: git not available or no main ref.
    return;
  }

  const ruleDiff = tryGetRuleLeafDiff(mergeBase);
  if (!ruleDiff || ![...ruleDiff.values()].some((delta) => delta.removedLines.length > 0)) {
    // Empty diff → skip (no protected anchor removals possible).
    return;
  }

  const modifiedFiles = tryGetModifiedFiles(mergeBase);
  const commitMessages = tryGetCommitMessages(mergeBase);
  if (!modifiedFiles || !commitMessages) {
    // Git error → fail-open.
    return;
  }

  const testPhraseIndex = buildTestPhraseIndex(testsDir);
  if (testPhraseIndex.size === 0) {
    // No index built (tests dir unreadable) → fail-open.
    return;
  }

  const findings = detectAnchorRemovals({
    ruleDiff,
    testPhraseIndex,
    modifiedFiles,
    commitMessages,
  });

  assert.strictEqual(
    findings.length,
    0,
    [
      "",
      "ADVISORY: protected anchor removal detected without exemption.",
      "",
      "Removed protected phrases and their dependent tests:",
      ...findings.map(
        (f) =>
          `  • "${f.phrase}" (leaf: ${f.leaf}) — depended on by ${f.dependentTestFile}`
      ),
      "",
      "To exempt this change, use one of the following exemption channels:",
      "  1. Add 'anchor-move: <description>' to a commit message in this branch, OR",
      "  2. Update the dependent grep-test file(s) listed above in the same diff.",
      "",
      "This is a soft-fail advisory gate. Use the anchor-move: marker to leave",
      "an audit trail when intentionally rewording a protected anchor phrase.",
      "",
    ].join("\n")
  );
});

// ---------------------------------------------------------------------------
// Node-host portability recurrence guard
// ---------------------------------------------------------------------------

const PORTABILITY_SURFACES = [
  ".devpro/scripts/prune-merged-local.mjs",
  ".devpro/scripts/probe-second-reviewer-cli-recipe.mjs",
  ".devpro/scripts/render-second-review-packet.mjs",
  ".devpro/scripts/ack-second-reviewer-projection.mjs",
  ".devpro/scripts/run-second-reviewer-projection.mjs",
  ".devpro/scripts/compliance-telemetry.mjs",
  ".devpro/scripts/hooks/pre-tool-gate.mjs",
  ".devpro/scripts/tests/session-start-hookspath-install.test.mjs",
  ".devpro/scripts/tests/prune-merged-local-c.test.mjs",
  ".devpro/scripts/tests/probe-second-reviewer-cli-recipe.test.mjs",
  ".devpro/scripts/tests/empty-dependency-precheck-grep.test.mjs",
  ".devpro/scripts/tests/patch-id-utils.test.mjs",
  ".devpro/scripts/tests/protected-anchor-grep.test.mjs",
  ".devpro/scripts/tests/normalize-eof.test.mjs",
];

const PORTABILITY_PATTERNS = [
  ["module-url-pathname", /new URL\([^)]*import\.meta\.url[^)]*\)\.pathname/g],
  ["implicit-posix-shell", /(?:spawnSync\(\s*["'](?:ba)?sh["']|shell:\s*["']\/bin\/(?:ba)?sh["'])/g],
  ["shell-pipeline-cat", /const shellCommand\s*=.*\|\s*cat\b/g],
  ["host-posix-utility", /(?:execSync\(\s*`(?:cat|rm\s+-rf|test\s+-e|grep\s+-r)|spawnSync\(\s*["']grep["'])/g],
  ["shell-interpolated-git", /(?:execSync|sh)\(\s*`git[^`]*(?:\$\{|2>\/dev\/null|&&|\|\|)/g],
];

function findNodeHostPortabilityViolations(source, relativePath = "") {
  const scanSource = relativePath.endsWith("protected-anchor-grep.test.mjs")
    ? source.split("// Node-host portability recurrence guard", 1)[0]
    : source;
  return PORTABILITY_PATTERNS.flatMap(([kind, pattern]) =>
    [...scanSource.matchAll(pattern)]
      .map((match) => ({ kind, evidence: match[0] }))
      .filter(
        ({ evidence }) =>
          !(
            relativePath.endsWith("prune-merged-local.mjs") &&
            evidence.includes("git merge-base --is-ancestor")
          ),
      ),
  );
}

test("Node-host portability guard has narrow positive and negative controls", () => {
  const bad = [
    'const ROOT = new URL("../../..", import.meta.url).pathname;',
    'spawnSync("sh", ["-lc", command]);',
    'const shellCommand = command + " | cat";',
    'spawnSync("grep", ["-nH", needle]);',
    "execSync(`git branch -D ${branch}`);",
  ].join("\n");
  assert.deepEqual(
    new Set(findNodeHostPortabilityViolations(bad).map(({ kind }) => kind)),
    new Set(PORTABILITY_PATTERNS.map(([kind]) => kind)),
  );

  const allowed = [
    ["fixtures/shipped-wrapper.sh", "#!/bin/sh\nprintf '%s\\n' fixture"],
    ["reject.test.mjs", 'const rejection = "legacy carrier containing | cat is rejected";'],
    ["docs.test.mjs", 'const docs = "grep -rn is shown only as a documentation example";'],
    ["darwin.test.mjs", 'spawnSync("xcrun", ["--find", "git"]);'],
    [".devpro/scripts/prune-merged-local.mjs", 'execSync(`git merge-base --is-ancestor "${tip}" ${productionRef()}`);'],
    ["generic.test.mjs", 'execSync("git status --short", { encoding: "utf8" });'],
  ];
  assert.deepEqual(
    allowed.flatMap(([relativePath, source]) =>
      findNodeHostPortabilityViolations(source, relativePath),
    ),
    [],
  );
});

test("named Node-host executable surfaces contain no confirmed portability recurrence", () => {
  const findings = PORTABILITY_SURFACES.flatMap((relativePath) => {
    const source = readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
    return findNodeHostPortabilityViolations(source, relativePath).map((finding) => ({
      relativePath,
      ...finding,
    }));
  });

  assert.deepEqual(
    findings,
    [],
    `confirmed Node-host portability recurrence:\n${findings
      .map(({ relativePath, kind, evidence }) => `- ${relativePath} [${kind}] ${evidence}`)
      .join("\n")}`,
  );
});
