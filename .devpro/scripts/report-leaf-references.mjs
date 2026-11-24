#!/usr/bin/env node
/**
 * report-leaf-references.mjs
 *
 * Report-only rule-leaf reference observation surface (capability: rule-self-evolution,
 * requirement "Rule Leaf Reference Observation"). For each rule-leaf under --rules-dir it
 * tallies how many DISTINCT live-corpus files physically reference that leaf by filename,
 * and buckets each leaf dead / near-dead / normal so a maintainer can eyeball which leaves
 * are unreferenced (dead — nothing routes to them) or barely referenced (near-dead) before
 * a self-evolution / consolidation loop. It surfaces deletion/merge candidates; it operationalizes
 * the Governance Budget Stop-Loss "delete an existing governance rule" pairing option.
 *
 * CONTRACT (SSOT: openspec/specs/rule-self-evolution/spec.md, "Rule Leaf Reference Observation"):
 *   - report-only: it MUST NOT gate advancement and MUST NOT exit non-zero to block on any
 *     dead / near-dead count. A normal run ALWAYS exits 0 regardless of how many leaves are
 *     dead. This is NOT a blocking threshold or gating dashboard. (Only a genuine programming
 *     crash, or a CLI usage error, may surface a non-zero exit — never a dead-count gate.)
 *   - reference = physical filename mention: the literal `<leaf>.md` filename appearing in a
 *     live-corpus file, bounded so a shorter filename does not spuriously match inside a
 *     longer one (`flow.md` must NOT match inside `openspec-flow.md`). The count is a DISTINCT
 *     referencing-file count, not a mention count.
 *   - exclusions: the leaf's OWN file (self-references do not count) and non-live locations
 *     (version-control internals, dependency dirs, per-change worktrees, and the archived-change
 *     history under openspec/changes/archive — archived proposals are history, not live routing).
 *   - three-tier parametric classification: dead = 0 referencing files; near-dead = 1..dead-threshold
 *     inclusive; normal = > dead-threshold. --dead-threshold is an explicit parameter defaulting to 1;
 *     --dead-threshold 0 collapses the near-dead tier (0 => dead, >=1 => normal).
 *
 * DIRECTIONAL / LEAF-SCOPED CAVEAT:
 *   This is a physical-filename-mention BREADTH count, not a semantic reachability proof. A leaf
 *   referenced only by its bare stem (no `.md`) or only in prose is counted as unreferenced here,
 *   so a "dead" verdict is a directional deletion CANDIDATE signal, not proof the leaf is unused.
 *   The report labels itself leaf-scoped / directional so that blind spot stays visible.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const DEFAULT_RULES_DIR = path.join(REPO_ROOT, ".devpro/agent-rules");
const DEFAULT_DEAD_THRESHOLD = 1;

// Live-corpus scan scope. Only text carriers that plausibly route to a leaf by filename.
const CORPUS_EXTENSIONS = new Set([".md", ".mjs", ".js"]);
// Directory basenames never part of the live corpus.
const EXCLUDED_DIR_NAMES = new Set([".git", ".worktree", "node_modules"]);
// Corpus-root-relative dir paths excluded because they are history, not live reachability.
const EXCLUDED_REL_DIRS = new Set(["openspec/changes/archive"]);

/**
 * Build a matcher for a physical `<leaf>` filename mention with left/right boundaries so a
 * shorter filename never matches inside a longer one (`flow.md` !~ `openspec-flow.md`).
 * Non-global so callers can safely reuse it with `.test()`.
 * @param {string} leaf leaf filename, e.g. "openspec-flow.md"
 * @returns {RegExp}
 */
export function buildLeafPattern(leaf) {
  const escaped = leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Left: preceding char must not be a filename token char (letter/digit/._-), so a longer
  // stem like `openspec-` before `flow.md` blocks the match. Right: following char must not be
  // a letter/digit, so `.md` is not counted as a prefix of `.mdx` / `.md5`.
  return new RegExp(`(?<![A-Za-z0-9._-])${escaped}(?![A-Za-z0-9])`);
}

/**
 * Classify a leaf from its distinct referencing-file count.
 * @param {number} refCount distinct referencing-file count
 * @param {number} deadThreshold near-dead upper bound (inclusive); dead = 0
 * @returns {"dead"|"near-dead"|"normal"}
 */
export function classify(refCount, deadThreshold) {
  if (refCount === 0) return "dead";
  if (refCount <= deadThreshold) return "near-dead";
  return "normal";
}

/** Load the leaf filenames (`*.md`) under rulesDir. */
function loadLeaves(rulesDir) {
  if (!existsSync(rulesDir)) return [];
  return readdirSync(rulesDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();
}

/**
 * Walk corpusRoot and return the absolute paths of every live-corpus file (allowed extension,
 * excluded dirs pruned).
 * @param {string} corpusRoot absolute corpus root
 * @returns {string[]}
 */
function collectCorpusFiles(corpusRoot) {
  const files = [];
  /** @param {string} dir @param {string} rel corpusRoot-relative posix path of dir */
  function walk(dir, rel) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (EXCLUDED_REL_DIRS.has(childRel)) continue;
        walk(path.join(dir, entry.name), childRel);
      } else if (entry.isFile()) {
        if (CORPUS_EXTENSIONS.has(path.extname(entry.name))) {
          files.push(path.join(dir, entry.name));
        }
      }
    }
  }
  walk(corpusRoot, "");
  return files;
}

/**
 * Scan the leaf corpus and count distinct referencing files per leaf.
 * @param {{rulesDir:string, corpusRoot:string, deadThreshold:number}} opts
 * @returns {{leaves: Array<{leaf:string, refCount:number, bucket:string}>,
 *            buckets: {dead:number, "near-dead":number, normal:number},
 *            rulesDir:string, corpusRoot:string, corpusFileCount:number, deadThreshold:number}}
 */
export function scanReferences({ rulesDir, corpusRoot, deadThreshold }) {
  const absRules = path.isAbsolute(rulesDir) ? rulesDir : path.join(REPO_ROOT, rulesDir);
  const absCorpus = path.isAbsolute(corpusRoot) ? corpusRoot : path.join(REPO_ROOT, corpusRoot);

  const leafNames = loadLeaves(absRules);
  const patterns = new Map(leafNames.map((leaf) => [leaf, buildLeafPattern(leaf)]));
  const counts = new Map(leafNames.map((leaf) => [leaf, 0]));
  // Absolute path of each leaf's own file, so a leaf's self-mention is excluded from its count.
  const ownFile = new Map(leafNames.map((leaf) => [leaf, path.join(absRules, leaf)]));

  const corpusFiles = collectCorpusFiles(absCorpus);
  for (const file of corpusFiles) {
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const leaf of leafNames) {
      if (file === ownFile.get(leaf)) continue; // self-reference excluded
      if (patterns.get(leaf).test(content)) {
        counts.set(leaf, counts.get(leaf) + 1);
      }
    }
  }

  const buckets = { dead: 0, "near-dead": 0, normal: 0 };
  const leaves = leafNames.map((leaf) => {
    const refCount = counts.get(leaf);
    const bucket = classify(refCount, deadThreshold);
    buckets[bucket] += 1;
    return { leaf, refCount, bucket };
  });
  // Surface deletion/consolidation candidates first: fewest refs first, then name.
  leaves.sort((a, b) => a.refCount - b.refCount || a.leaf.localeCompare(b.leaf));

  return {
    leaves,
    buckets,
    rulesDir: absRules,
    corpusRoot: absCorpus,
    corpusFileCount: corpusFiles.length,
    deadThreshold,
  };
}

/** Render the report string (pure — no I/O — so tests can assert on it too). */
export function renderReport(result) {
  const { leaves, buckets, rulesDir, corpusRoot, corpusFileCount, deadThreshold } = result;
  const lines = [];
  lines.push("Rule Leaf Reference Observation (report-only, leaf-scoped / directional)");
  lines.push("=======================================================================");
  lines.push(`Rules dir   : ${rulesDir}`);
  lines.push(`Corpus root : ${corpusRoot}`);
  lines.push(`Corpus files scanned : ${corpusFileCount}`);
  lines.push(`Leaves scanned       : ${leaves.length}`);
  lines.push(
    `Dead-threshold : ${deadThreshold}  (dead = 0 refs; near-dead = 1..${deadThreshold} inclusive; normal = > ${deadThreshold})`,
  );
  lines.push("");
  lines.push("Buckets:");
  lines.push(`  dead      : ${buckets.dead}`);
  lines.push(`  near-dead : ${buckets["near-dead"]}`);
  lines.push(`  normal    : ${buckets.normal}`);
  lines.push("");
  lines.push("Per-leaf (distinct referencing-file count; fewest first = deletion/merge candidates):");
  const width = leaves.reduce((w, l) => Math.max(w, l.leaf.length), 0);
  for (const { leaf, refCount, bucket } of leaves) {
    lines.push(`  ${bucket.padEnd(9)} ${leaf.padEnd(width)} (${refCount})`);
  }
  lines.push("");
  lines.push(
    "NOTE: leaf-scoped, DIRECTIONAL physical-filename-mention signal — a distinct-file breadth",
  );
  lines.push(
    "count of literal `<leaf>.md` mentions, NOT a semantic reachability proof. Bare-stem or",
  );
  lines.push(
    "prose-only references are uncounted, so a `dead` verdict is a deletion/merge CANDIDATE, not",
  );
  lines.push(
    "proof of disuse. Report-only: this NEVER gates advancement regardless of any dead count.",
  );
  return lines.join("\n");
}

/**
 * @param {string[]} argv process args after the script path
 * @returns {{rulesDir:string, corpusRoot:string, deadThreshold:number, help:boolean, error?:string}}
 */
export function parseArgs(argv) {
  const opts = {
    rulesDir: DEFAULT_RULES_DIR,
    corpusRoot: REPO_ROOT,
    deadThreshold: DEFAULT_DEAD_THRESHOLD,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      opts.help = true;
    } else if (a === "--rules-dir") {
      const v = argv[++i];
      if (typeof v !== "string" || v === "") return { ...opts, error: "--rules-dir requires a path value." };
      opts.rulesDir = v;
    } else if (a === "--corpus-root") {
      const v = argv[++i];
      if (typeof v !== "string" || v === "") return { ...opts, error: "--corpus-root requires a path value." };
      opts.corpusRoot = v;
    } else if (a === "--dead-threshold") {
      const v = argv[++i];
      if (typeof v !== "string" || !/^\d+$/.test(v)) {
        return { ...opts, error: "--dead-threshold requires a non-negative integer value." };
      }
      opts.deadThreshold = Number(v);
    } else {
      return { ...opts, error: `Unknown argument: ${a}` };
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      "Usage: node .devpro/scripts/report-leaf-references.mjs [--dead-threshold <N>] [--rules-dir <path>] [--corpus-root <path>]\n" +
        "Report-only rule-leaf reference observation. Buckets each leaf dead/near-dead/normal by\n" +
        "distinct referencing-file count. Always exits 0 (report-only); usage errors exit 2.",
    );
    process.exit(0);
  }
  if (opts.error) {
    // Usage error (bad invocation), NOT a dead-count gate: exit 2 is a bad-invocation signal,
    // distinct from the always-0 report run.
    console.error(`Error: ${opts.error}`);
    process.exit(2);
  }
  const result = scanReferences(opts);
  console.log(renderReport(result));
  // report-only: never gate advancement on any dead / near-dead count.
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
