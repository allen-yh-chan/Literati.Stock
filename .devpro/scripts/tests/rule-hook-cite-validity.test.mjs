/**
 * rule-hook-cite-validity.test.mjs
 *
 * Bidirectional cross-cite existence check between the rule corpus and the
 * hook/script corpus.  Hard-fail: every broken cite is listed with its
 * source file:line.
 *
 * Direction A (rule → script):
 *   - Scans .devpro/agent-rules/**‌/*.md + AGENTS.md
 *   - Extracts *.mjs tokens (bare filenames; template placeholders skipped)
 *   - Extracts Gate <id> identifiers
 *   - Each *.mjs basename must exist somewhere under .devpro/scripts/
 *   - Each Gate <id> literal must appear in at least one hook file
 *
 * Direction B (hook → rule):
 *   - Scans .devpro/scripts/hooks/**‌/*.mjs
 *   - Extracts *.md filename tokens that look like rule-file citations
 *   - Extracts <file>.md §<section> cites and verifies the section substring
 *     exists in the target rule file (case-insensitive)
 *   - <file>.md:<line> line-number cites: this file only verifies that the
 *     file exists. Hook sources may no longer cite a rule file by line number
 *     at all; pre-tool-gates-spec-rule-cites-grep.test.mjs fails on any such
 *     cite outside its named allowlist (one format example).
 *
 * Excluded paths: refs/, .worktree/, node_modules/, openspec/
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Walk a directory recursively and return absolute paths to files matching
 * the given predicate, skipping excluded subtrees.
 */
function walk(dir, predicate, excludeDirs = []) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!excludeDirs.includes(entry)) {
        results.push(...walk(full, predicate, excludeDirs));
      }
    } else if (predicate(entry)) {
      results.push(full);
    }
  }
  return results;
}

const EXCLUDED_DIRS = ["refs", ".worktree", "node_modules", "openspec"];

/** Collect all agent-rule .md files (incl. platform-adapters subdir). */
function collectRuleFiles() {
  const agentRulesDir = path.join(REPO_ROOT, ".devpro", "agent-rules");
  const files = walk(agentRulesDir, (f) => f.endsWith(".md"), EXCLUDED_DIRS);
  // Also include root AGENTS.md
  const agentsMd = repoPath("AGENTS.md");
  if (existsSync(agentsMd)) files.push(agentsMd);
  return files;
}

/** Collect all hook .mjs files. */
function collectHookFiles() {
  const hooksDir = path.join(REPO_ROOT, ".devpro", "scripts", "hooks");
  return walk(hooksDir, (f) => f.endsWith(".mjs"), EXCLUDED_DIRS);
}

/** Build basename → absolute-path index for every .mjs in .devpro/scripts/. */
function buildScriptIndex() {
  const scriptsDir = path.join(REPO_ROOT, ".devpro", "scripts");
  const all = walk(scriptsDir, (f) => f.endsWith(".mjs"), EXCLUDED_DIRS);
  const index = new Map();
  for (const p of all) {
    index.set(path.basename(p), p);
  }
  return index;
}

/** Build basename → absolute-path index for rule .md files + allowed root docs. */
function buildRuleIndex() {
  const files = collectRuleFiles();
  // Hooks may also cite common root-level docs
  const rootDocs = ["AGENTS.md", "CLAUDE.md", "README.md", "GEMINI.md"];
  for (const f of rootDocs) {
    const fp = repoPath(f);
    if (existsSync(fp)) files.push(fp);
  }
  const index = new Map();
  for (const p of files) {
    const base = path.basename(p);
    if (!index.has(base)) index.set(base, p);
  }
  return index;
}

/** Make a repo-relative display path for error messages. */
function rel(absPath) {
  return absPath.startsWith(REPO_ROOT + "/")
    ? absPath.slice(REPO_ROOT.length + 1)
    : absPath;
}

// ─── Direction A: rule → script ──────────────────────────────────────────────

/**
 * Token pattern: bare .mjs filename references in rule docs.
 *
 * Requires lowercase-initial token: all real script files use lowercase names;
 * uppercase-initial tokens like `X.test.mjs` are single-letter example
 * placeholders in explanatory text and must not be flagged.
 *
 * Uses \b (word boundary) so the match starts at the first letter of the
 * filename regardless of the preceding path separator.  For full-path
 * references like `node .devpro/scripts/lint-agent-skills.mjs`, \b anchors
 * at `l` (after `/`) and the full basename is captured.
 *
 * Post-extraction filter: skip tokens whose preceding character is `.` and
 * the character before THAT is either `*` or an uppercase letter.  This
 * suppresses two suffix-artifact patterns:
 *   - Glob tail:        `pre-pr-archive-gate*.test.mjs` → spurious `test.mjs`
 *   - Uppercase prefix: `X.test.mjs` in explanatory text → spurious `test.mjs`
 *
 * Tokens containing `<` are template placeholders and are skipped.
 */
const MJS_TOKEN_RE = /\b[a-z][A-Za-z0-9._-]*\.mjs/g;

/**
 * Gate ID pattern.
 *
 * Matches `Gate 2b`, `Gate D'`, `Gate P`, `Gate 11`, `Gate W1`, etc.
 * Negative lookahead `(?![A-Za-z])` prevents false positives from English
 * compound words: "Gate Enforcement", "Gate Default-Pass", "Gate Threat Model".
 *
 * ID formats:
 *   \d+[a-z]?   — numeric (2, 2b, 4, 4b, 11)
 *   [A-Z]\d?'?  — single uppercase letter with optional digit or apostrophe
 *                 (D, D', P, A, W1)
 */
// Known limitation: 只守備 single-letter/digit Gate id（[A-Z0-9] 開頭單 token）；多字母 id（如 Gate AB）不在範圍——現存 corpus 無此形態，未來新增多字母 gate id 時須同步擴充本 regex。
const GATE_RE = /\bGate\s+(\d+[a-z]?|[A-Z]\d?'?)(?![A-Za-z])/g;

function extractMjsTokens(line) {
  const tokens = [];
  for (const m of line.matchAll(MJS_TOKEN_RE)) {
    const token = m[0];
    if (token.includes("<")) continue; // template placeholder
    // Skip suffix artifacts where the token is the tail of a longer name:
    //   - Glob tail:        *.test.mjs  → char at index-2 is `*`
    //   - Uppercase prefix: X.test.mjs  → char at index-2 is uppercase letter
    //     (single-letter example placeholders like `X`, `Y` in explanatory text)
    // In both cases the preceding char at index-1 is `.`.
    if (m.index >= 1 && line[m.index - 1] === ".") {
      const pre2 = m.index >= 2 ? line[m.index - 2] : "";
      if (pre2 === "*" || /[A-Z]/.test(pre2)) continue;
    }
    tokens.push({ token, index: m.index });
  }
  return tokens;
}

function extractGateIds(content) {
  const ids = new Set();
  for (const m of content.matchAll(GATE_RE)) {
    ids.add(m[1]);
  }
  return ids;
}

test("Direction A — every *.mjs token in rule corpus resolves to a file in .devpro/scripts/", () => {
  const scriptIndex = buildScriptIndex();
  const ruleFiles = collectRuleFiles();
  const broken = [];

  for (const filePath of ruleFiles) {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      for (const { token } of extractMjsTokens(line)) {
        const basename = path.basename(token);
        if (!scriptIndex.has(basename)) {
          broken.push(`${rel(filePath)}:${lineIdx + 1} → missing script: ${basename}`);
        }
      }
    }
  }

  assert.deepEqual(
    broken,
    [],
    `Broken rule→script cites (${broken.length}):\n${broken.join("\n")}`,
  );
});

test("Direction A — every Gate <id> cited in rule corpus appears in hook corpus", () => {
  const ruleFiles = collectRuleFiles();
  const hookFiles = collectHookFiles();

  // Build hook gate id Set using extractGateIds (same GATE_RE) — precise set
  // membership replaces substring includes() to eliminate masking: e.g.
  // hookCorpus.includes("Gate D") would false-pass when only "Gate D'" is present.
  const hookCorpus = hookFiles
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const hookGateIds = extractGateIds(hookCorpus);

  // Collect all unique Gate IDs from rules with their first source location
  const gateSourceMap = new Map(); // id → "file:line"
  for (const filePath of ruleFiles) {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      for (const m of line.matchAll(GATE_RE)) {
        const id = m[1];
        if (!gateSourceMap.has(id)) {
          gateSourceMap.set(id, `${rel(filePath)}:${lineIdx + 1}`);
        }
      }
    }
  }

  const broken = [];
  for (const [id, source] of gateSourceMap) {
    if (!hookGateIds.has(id)) {
      broken.push(`${source} → Gate ${id} not found in any hook file`);
    }
  }

  assert.deepEqual(
    broken,
    [],
    `Gate IDs cited in rules but missing from hooks (${broken.length}):\n${broken.join("\n")}`,
  );
});

// ─── Unit: masking-elimination proof ─────────────────────────────────────────

test("Unit — extractGateIds set membership detects absence when short id is masked by superstring id", () => {
  // Regression guard for the substring-masking bug:
  //   hookCorpus.includes("Gate D") returns true when corpus only contains
  //   "Gate D'" because "D'" is a superstring of "D".  Similarly "Gate 1"
  //   is a substring of "Gate 11", "Gate 1w", etc.
  //
  // This test proves that extractGateIds + Set.has() is immune to masking:
  // a corpus that only contains "Gate D'" must NOT satisfy has("D").

  // Corpus with D' but no bare D
  const corpusWithDPrimeOnly = "// Gate D' check\nif (gateDP) { pass(); }";
  const ids = extractGateIds(corpusWithDPrimeOnly);
  assert.ok(ids.has("D'"), "extractGateIds should find D' in corpus");
  assert.ok(!ids.has("D"), "extractGateIds must NOT find bare D when only D' is present (masking check)");

  // Corpus with Gate 11 and Gate 1w but no bare Gate 1
  const corpusWithLongNumericOnly = "// Gate 11 passed\n// Gate 1w passed";
  const ids2 = extractGateIds(corpusWithLongNumericOnly);
  assert.ok(ids2.has("11"), "extractGateIds should find 11");
  assert.ok(ids2.has("1w"), "extractGateIds should find 1w");
  assert.ok(!ids2.has("1"), "extractGateIds must NOT find bare 1 when only 11/1w are present (masking check)");

  // Corpus with Gate 2b..2h but no bare Gate 2
  const corpusWithSuffixedOnly = "Gate 2b: ok\nGate 2c: ok\nGate 2d ok\nGate 2e ok\nGate 2f ok\nGate 2h ok";
  const ids3 = extractGateIds(corpusWithSuffixedOnly);
  assert.ok(ids3.has("2b"), "extractGateIds should find 2b");
  assert.ok(!ids3.has("2"), "extractGateIds must NOT find bare 2 when only 2b-2h are present (masking check)");
});

// ─── Direction B: hook → rule ────────────────────────────────────────────────

/**
 * .md filename pattern for the hook → rule direction.
 *
 * Uses \b (word boundary) so the match anchors at the first letter of the
 * filename regardless of the preceding path separator (`/`).  Full-path
 * references like `.devpro/agent-rules/session-recap.md` yield `session-recap.md`.
 *
 * Only lowercase-initial filenames are captured (all agent-rule files are
 * lowercase; uppercase-initial names like AGENTS.md are excluded because
 * AGENTS.md §-section cites are not mechanically verified by this test).
 *
 * Non-rule .md names that hooks legitimately reference but are NOT rule files:
 *   - spec.md, decisions.md   — openspec change/spec artifacts (generic names)
 *   - proposal.md             — openspec change proposal artifact
 *   - proposal-mini.md        — openspec mini-proposal artifact
 *   - meeting-notes.md        — openspec meeting notes artifact
 *   - qa-test-scope.md        — openspec QA bookkeeping artifact
 *   - design.md, brd.md       — openspec change design/BRD artifacts (generic
 *                               names, same class as proposal.md/decisions.md)
 *   - lite-scope.md           — untracked lite batch scope record read by Gate R1/SP
 *                               (openspec/changes/<change>/lite-scope.md); data, not a rule
 *   - comprehension.md        — design cold-read record read by Gate CR
 *                               (openspec/changes/<change>/comprehension.md); data, not a rule
 *   - session-pending.md      — runtime notes file (notes/session-pending.md)
 *   - dp-second-reviewer.md   — agent definition (.claude/agents/); not agent-rules
 *   - file.md                 — placeholder example in user-facing advisory text
 *   - good.md, bad.md         — generic placeholder example filenames used in hook
 *                               code comments to illustrate body-file flag parsing
 *                               (e.g. `--body-file good.md --body-file bad.md`,
 *                               `-good.md`, `a=bad.md`); never rule leaves
 *   - pr-body.md              — extracted from `.pr-body.md` dotfile example
 *                               (the leading `.` causes \b to anchor at `p`,
 *                               yielding `pr-body.md`; dotfile references are
 *                               never rule files)
 *
 * These are excluded via NON_RULE_MD_NAMES.
 */
const MD_TOKEN_RE = /\b[a-z][a-z0-9-]*\.md/g;

/**
 * Non-rule .md names that appear in hooks but are NOT agent-rule citations.
 */
const NON_RULE_MD_NAMES = new Set([
  // openspec artifact filenames (generic, appear under openspec/changes/<X>/)
  "spec.md",
  "decisions.md",
  "proposal.md",
  "proposal-mini.md",
  "meeting-notes.md",
  "tasks.md",
  "qa-test-scope.md",
  // openspec change design/BRD artifacts (generic names, same class as
  // proposal.md/decisions.md above)
  "design.md",
  "brd.md",
  // untracked lite batch scope record (openspec/changes/<change>/lite-scope.md)
  // that Gate R1/SP read — a data file, not a rule
  "lite-scope.md",
  // sibling plan/evidence artifact named by the Gate R1 repair hint
  // (openspec/changes/<change>/plan.md) — change data, not a rule leaf
  "plan.md",
  // design cold-read record (openspec/changes/<change>/comprehension.md)
  "comprehension.md",
  // runtime file (notes/session-pending.md) — not a rule
  "session-pending.md",
  // agent definition file (.claude/agents/) — not an agent-rule
  "dp-second-reviewer.md",
  // user-facing advisory placeholder example
  "file.md",
  // generic placeholder example filenames in hook code comments illustrating
  // body-file flag parsing (`--body-file good.md --body-file bad.md`,
  // `-good.md`, `a=bad.md`)
  "good.md",
  "bad.md",
  // extracted from `.pr-body.md` dotfile example (leading `.` causes \b to
  // anchor at `p`, yielding `pr-body.md`; see narrowing rationale in JSDoc above)
  "pr-body.md",
  // false positive from consumer overlay basename `AGENTS.local.md` (multi-dot:
  // \b anchors at `local`, yielding `local.md`; not a rule leaf)
  "local.md",
]);

/**
 * §<section> cite pattern inside hook files: `<file>.md §<section>`.
 *
 * Section name ends at the first whitespace, `)`, `）`, `,`, or `，`.
 * Captures only the first token of multi-word section names — sufficient for
 * substring existence verification.
 *
 * The `§` may be preceded by a space (` §`) or appear immediately after `.md`.
 * Files with uppercase-initial names (e.g. AGENTS.md) are excluded because
 * `[a-z]` anchors require a lowercase start.
 */
const SECTION_CITE_RE = /\b([a-z][a-z0-9/._-]*\.md)\s*§\s*([^\s()（），]+)/g;

/**
 * Line-number cite: `<file>.md:<line>`.
 *
 * Only file existence is verified here. Rule-file line cites in hook sources
 * are banned by pre-tool-gates-spec-rule-cites-grep.test.mjs (named allowlist:
 * the format example in lib/handoff-cite-gate.mjs); what still reaches this
 * check is that example and line cites of non-rule .md files.
 */
const LINE_CITE_RE = /\b([a-z][a-z0-9/._-]*\.md):(\d+)/g;

function extractMdTokens(line) {
  const tokens = [];
  for (const m of line.matchAll(MD_TOKEN_RE)) {
    const token = m[0];
    if (token.includes("<")) continue; // template placeholder
    if (NON_RULE_MD_NAMES.has(token)) continue;
    tokens.push({ token, index: m.index });
  }
  return tokens;
}

test("Direction B distinguishes the archived QA artifact from real or missing rule cites", () => {
  assert.deepEqual(extractMdTokens("qa-test-scope.md"), []);
  assert.deepEqual(extractMdTokens("post-pr-completion-gate.md missing-rule.md").map(({ token }) => token),
    ["post-pr-completion-gate.md", "missing-rule.md"]);
});

test("Direction B — every *.md token in hook corpus resolves to a rule file", () => {
  const ruleIndex = buildRuleIndex();
  const hookFiles = collectHookFiles();
  const broken = [];

  for (const filePath of hookFiles) {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      for (const { token } of extractMdTokens(line)) {
        const basename = path.basename(token);
        if (NON_RULE_MD_NAMES.has(basename)) continue;
        if (!ruleIndex.has(basename)) {
          broken.push(`${rel(filePath)}:${lineIdx + 1} → missing rule file: ${basename}`);
        }
      }
    }
  }

  assert.deepEqual(
    broken,
    [],
    `Broken hook→rule file cites (${broken.length}):\n${broken.join("\n")}`,
  );
});

test("Direction B — §<section> cites in hooks resolve to a matching substring in the target rule file", () => {
  const ruleIndex = buildRuleIndex();
  const hookFiles = collectHookFiles();
  const broken = [];

  for (const filePath of hookFiles) {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      for (const m of line.matchAll(SECTION_CITE_RE)) {
        const [, fileRef, section] = m;
        const basename = path.basename(fileRef);
        if (NON_RULE_MD_NAMES.has(basename)) continue;

        const targetPath = ruleIndex.get(basename);
        if (!targetPath) {
          // File existence already caught by the file-existence test; skip
          // here to avoid duplicate reports.
          continue;
        }
        const targetContent = readFileSync(targetPath, "utf8");
        // Case-insensitive substring match: hook cites sometimes differ in
        // capitalisation from the heading in the target file (e.g. hook uses
        // `§commit message 寫法` while the rule has `**Commit message 寫法**`).
        if (!targetContent.toLowerCase().includes(section.toLowerCase())) {
          broken.push(
            `${rel(filePath)}:${lineIdx + 1} → ${basename} §${section} (section not found)`,
          );
        }
      }
    }
  }

  assert.deepEqual(
    broken,
    [],
    `Broken §<section> cites (${broken.length}):\n${broken.join("\n")}`,
  );
});

test("Direction B — <file>.md:<line> cites in hooks resolve to existing rule files (line numbers not verified)", () => {
  // Line numbers are NOT validated here. Rule-file line cites are banned in hook
  // sources by pre-tool-gates-spec-rule-cites-grep.test.mjs; this check covers the
  // allowlisted format example. Only file existence is checked.
  const ruleIndex = buildRuleIndex();
  const hookFiles = collectHookFiles();
  const broken = [];

  for (const filePath of hookFiles) {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      for (const m of line.matchAll(LINE_CITE_RE)) {
        const [, fileRef] = m;
        const basename = path.basename(fileRef);
        if (NON_RULE_MD_NAMES.has(basename)) continue;
        if (!ruleIndex.has(basename)) {
          broken.push(
            `${rel(filePath)}:${lineIdx + 1} → missing rule file: ${basename} (from line-number cite)`,
          );
        }
      }
    }
  }

  assert.deepEqual(
    broken,
    [],
    `Broken <file>.md:<line> cites (${broken.length}):\n${broken.join("\n")}`,
  );
});
