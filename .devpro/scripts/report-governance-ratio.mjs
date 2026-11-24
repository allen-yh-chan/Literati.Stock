#!/usr/bin/env node
/**
 * report-governance-ratio.mjs
 *
 * Report-only governance-ratio observation surface (capability: rule-self-evolution,
 * requirement "Governance Ratio Observation"). It tallies the governance-vs-dev-work
 * ratio and trend of archived changes so a maintainer can eyeball self-maintenance
 * load before starting a self-evolution / convergence loop.
 *
 * CONTRACT (SSOT: openspec/specs/rule-self-evolution/spec.md):
 *   - report-only: it MUST NOT gate advancement and MUST NOT exit non-zero to block
 *     on any ratio/threshold. This is NOT a blocking numeric-ratio gate or dashboard.
 *     A normal run ALWAYS exits 0 regardless of the observed ratio value. (Only a genuine
 *     programming crash may surface a non-zero exit — that is a bug, never a ratio gate.)
 *   - path-based rule-leaf taxonomy: each archived change is bucketed by the rule-leaves
 *     it touched. Leaves in the explicit DEV_WORK_LEAVES allowlist => dev-work; every
 *     other touched leaf => governance (default-to-governance). Touched leaves split
 *     evenly between the two => governance, per the Governance Budget Stop-Loss
 *     default-to-governance tie-breaker. A change touching no classifiable rule-leaf is
 *     surfaced in a separate `unclassified` bucket, never silently forced into either.
 *
 * EXTRACTION SOURCE (pinned):
 *   The touched-leaf signal is read from each archived change's `## Touch`-family section
 *   (proposal.md preferred, else proposal-mini.md): the backtick-quoted paths listed there,
 *   filtered to filenames that resolve to a real leaf under .devpro/agent-rules/. A negated-touch
 *   H2 heading (English "Don't Touch" / "Non-Touch" / "Not Touched") is NOT a collection section;
 *   and within a collection section an inline "don't touch" / "non-touch" / 不動 · 不碰 marker
 *   stops collection, so explicitly-not-touched files are excluded either way.
 *
 * DIRECTIONAL / LEAF-SCOPED CAVEAT:
 *   A large share of governance work lands on NON-leaf carriers (skills / hooks / specs /
 *   scripts / AGENTS.md) which carry no rule-leaf path; those changes fall into the
 *   `unclassified` bucket. So the governance ratio here is a leaf-scoped directional
 *   indicator, not a total-load truth. The unclassified bucket + two denominators
 *   (classified-only and all-changes) keep that blind spot visible rather than silent.
 *   Folding non-leaf-carrier signal in is a deferred follow-up.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROPOSAL_CARRIERS } from "./lib/proposal-carriers.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const LEAF_DIR = path.join(REPO_ROOT, ".devpro/agent-rules");
const DEFAULT_ARCHIVE_DIR = "openspec/changes/archive";

/**
 * Explicit, editable dev-work-leaf allowlist. A leaf here means "this leaf predominantly
 * guides code / SQL / API / test / branch output" — the syntactic/semantic content of
 * shipped artifacts (the canonical Governance Budget Stop-Loss dev-work categories).
 * Everything NOT listed (including process/tooling leaves such as ci-*,
 * third-party-packages-licensing, security-scanning, codeql-execution, and every
 * rules/process/meta leaf) defaults to governance, per the default-to-governance bias.
 * Keep this list conservative and auditable: add a leaf only when it unambiguously
 * governs code/SQL/API/test/branch OUTPUT, not process.
 */
export const DEV_WORK_LEAVES = new Set([
  // code output
  "csharp-style-and-dry.md",
  "code-simplification.md",
  "anti-patterns-examples.md",
  "pre-implementation-over-design.md",
  "project-structure-sln-and-folders.md",
  "frontend-session.md",
  "security-coding.md",
  "observability-capabilities.md",
  // SQL output
  "database-conventions.md",
  // API output
  "api-design-http-semantics.md",
  // test output
  "testing-and-qa.md",
  "test-suite-cadence.md",
  "test-performance-patterns.md",
  // branch output (the developer-emitted branch/anchor artifact). The canonical
  // Governance Budget Stop-Loss dev-work definition lists "branch output"; only the
  // branch-naming/anchor leaf directly governs that artifact. The other git-branch-*
  // leaves (pr-flow, hygiene, terminology, openspec-branch-routing) are process/meta
  // and stay governance by the default-to-governance bias.
  "git-branch-naming-and-anchor.md",
]);

/** Load the set of real rule-leaf filenames under .devpro/agent-rules/. */
function loadLeafSet() {
  const set = new Set();
  if (!existsSync(LEAF_DIR)) return set;
  for (const entry of readdirSync(LEAF_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) set.add(entry.name);
  }
  return set;
}

const H2 = /^##\s+/;
const TOUCH_HEADING = /^##\s+.*\btouch\b/i;
// A heading that LEADS with a negated-touch phrase (Don't Touch / Non-Touch / Not Touched) is a
// not-touched section, not a collection section — it still matches TOUCH_HEADING via the bare
// "touch" word, so it must be excluded explicitly. A combined "## Touch / Don't Touch" heading
// leads with the positive "Touch" and stays a collection section, stopping at its inline marker.
const NEGATED_TOUCH_HEADING = /^##\s+(?:don.{0,3}t\s*touch|non-?touch|not\s+touch)/i;
const DONT_TOUCH_MARKER = /(don.{0,3}t\s*touch|non-touch|不動|不碰)/i;
const BACKTICK_TOKEN = /`([^`]+)`/g;
// leaf reference: `.../agent-rules/<leaf>.md` or a bare lowercase `<leaf>.md`
const AGENT_RULES_LEAF = /(?:^|\/)agent-rules\/([a-z0-9][a-z0-9-]*\.md)$/;
const BARE_LEAF = /^([a-z0-9][a-z0-9-]*\.md)$/;

/**
 * Extract the touched rule-leaf filenames from a proposal's `## Touch`-family section.
 * @param {string} content proposal.md / proposal-mini.md text
 * @param {Set<string>} leafSet real leaf filenames under .devpro/agent-rules/
 * @returns {Set<string>} touched leaf filenames (subset of leafSet)
 */
export function extractTouchedLeaves(content, leafSet) {
  const lines = content.split(/\r?\n/);
  const touched = new Set();
  let inTouch = false;

  for (const line of lines) {
    if (H2.test(line)) {
      // Enter the Touch section on a touch-positive heading that does not LEAD with a
      // negated-touch phrase (Don't Touch / Non-Touch / Not Touched); any other H2 ends collection.
      inTouch = TOUCH_HEADING.test(line) && !NEGATED_TOUCH_HEADING.test(line);
      continue;
    }
    if (!inTouch) continue;
    // Stop at the first don't-touch marker inside the section (it and everything
    // after it in this section lists explicitly-not-touched files).
    if (DONT_TOUCH_MARKER.test(line)) {
      inTouch = false;
      continue;
    }
    for (const m of line.matchAll(BACKTICK_TOKEN)) {
      const token = m[1].trim();
      let leaf = null;
      const am = token.match(AGENT_RULES_LEAF);
      if (am) leaf = am[1];
      else if (BARE_LEAF.test(token)) leaf = token;
      if (leaf && leafSet.has(leaf)) touched.add(leaf);
    }
  }
  return touched;
}

/**
 * Classify a change from its touched leaves.
 * @returns {"governance"|"dev-work"|"unclassified"}
 */
export function classify(touchedLeaves) {
  if (touchedLeaves.size === 0) return "unclassified";
  let dev = 0;
  let gov = 0;
  for (const leaf of touchedLeaves) {
    if (DEV_WORK_LEAVES.has(leaf)) dev += 1;
    else gov += 1;
  }
  if (dev > gov) return "dev-work";
  // gov > dev, or a dev/gov tie => governance (default-to-governance tie-breaker)
  return "governance";
}

/** Month key `YYYY-MM` from a `YYYY-MM-DD-<name>` archive folder, else "unknown". */
export function monthOf(folderName) {
  const m = folderName.match(/^(\d{4})-(\d{2})-\d{2}-/);
  return m ? `${m[1]}-${m[2]}` : "unknown";
}

/** Read the proposal text for one archive change folder (proposal.md preferred). */
function readProposal(changeDir) {
  for (const name of PROPOSAL_CARRIERS) {
    const p = path.join(changeDir, name);
    if (existsSync(p)) {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return "";
      }
    }
  }
  return "";
}

/**
 * Scan an archive directory and produce the observation tally.
 * @param {string} archiveDir absolute or repo-relative archive dir
 * @param {Set<string>} leafSet
 */
export function scanArchive(archiveDir, leafSet) {
  const absArchive = path.isAbsolute(archiveDir)
    ? archiveDir
    : path.join(REPO_ROOT, archiveDir);

  const buckets = { governance: 0, "dev-work": 0, unclassified: 0 };
  /** @type {Map<string, {governance:number,"dev-work":number,unclassified:number}>} */
  const byMonth = new Map();
  let scanned = 0;

  if (!existsSync(absArchive)) {
    return { buckets, byMonth, scanned, archiveDir: absArchive };
  }

  for (const entry of readdirSync(absArchive, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const changeDir = path.join(absArchive, entry.name);
    // guard: skip anything unreadable
    try {
      if (!statSync(changeDir).isDirectory()) continue;
    } catch {
      continue;
    }
    scanned += 1;
    const content = readProposal(changeDir);
    const touched = content ? extractTouchedLeaves(content, leafSet) : new Set();
    const bucket = classify(touched);
    buckets[bucket] += 1;

    const month = monthOf(entry.name);
    if (!byMonth.has(month)) {
      byMonth.set(month, { governance: 0, "dev-work": 0, unclassified: 0 });
    }
    byMonth.get(month)[bucket] += 1;
  }

  return { buckets, byMonth, scanned, archiveDir: absArchive };
}

function pct(n, d) {
  if (!d) return "0.0%";
  return `${((n / d) * 100).toFixed(1)}%`;
}

/** Render the report string (pure — no I/O — so tests can assert on it too). */
export function renderReport({ buckets, byMonth, scanned, archiveDir }) {
  const gov = buckets.governance;
  const dev = buckets["dev-work"];
  const unc = buckets.unclassified;
  const classified = gov + dev;

  const lines = [];
  lines.push("Governance Ratio Observation (report-only, leaf-scoped / directional)");
  lines.push("=====================================================================");
  lines.push(
    'Extraction source: each archived change\'s "## Touch" section backtick paths,',
  );
  lines.push(
    "filtered to rule-leaves under .devpro/agent-rules/ (see script header).",
  );
  lines.push(
    `Taxonomy: path-based rule-leaf; DEV_WORK_LEAVES allowlist (${DEV_WORK_LEAVES.size} leaves) => dev-work,`,
  );
  lines.push(
    "all other touched leaves => governance (default-to-governance tie-breaker).",
  );
  lines.push("");
  lines.push(`Archive dir: ${archiveDir}`);
  lines.push(`Changes scanned: ${scanned}`);
  lines.push("");
  lines.push("Buckets:");
  lines.push(`  governance   : ${gov}  (${pct(gov, scanned)} of total)`);
  lines.push(`  dev-work     : ${dev}  (${pct(dev, scanned)} of total)`);
  lines.push(
    `  unclassified : ${unc}  (${pct(unc, scanned)} of total)  [no classifiable rule-leaf in Touch]`,
  );
  lines.push("");
  lines.push("Governance ratio:");
  lines.push(
    `  governance / (governance + dev-work) : ${pct(gov, classified)}   (classified-only denominator)`,
  );
  lines.push(
    `  governance / total                   : ${pct(gov, scanned)}   (all-changes denominator)`,
  );
  lines.push("");
  lines.push("Monthly trend (gov / dev / unclassified | gov-share of classified):");
  const months = [...byMonth.keys()].sort();
  for (const month of months) {
    const b = byMonth.get(month);
    const c = b.governance + b["dev-work"];
    lines.push(
      `  ${month} : ${b.governance} / ${b["dev-work"]} / ${b.unclassified} | ${pct(b.governance, c)}`,
    );
  }
  lines.push("");
  lines.push(
    "NOTE: leaf-scoped directional indicator only. Governance work often lands on non-leaf",
  );
  lines.push(
    "carriers (skills/hooks/specs/scripts/AGENTS.md) that carry no rule-leaf path and fall into",
  );
  lines.push(
    "`unclassified`, so these ratios understate total governance load. Report-only: this NEVER",
  );
  lines.push("gates advancement regardless of the observed ratio value.");
  return lines.join("\n");
}

function parseArgs(argv) {
  const opts = { archiveDir: DEFAULT_ARCHIVE_DIR, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--archive-dir") opts.archiveDir = argv[++i];
    else if (a.startsWith("--archive-dir=")) opts.archiveDir = a.slice("--archive-dir=".length);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      "Usage: node .devpro/scripts/report-governance-ratio.mjs [--archive-dir <path>]\n" +
        "Report-only governance-ratio observation over archived changes. Always exits 0.",
    );
    process.exit(0);
  }
  if (typeof opts.archiveDir !== "string" || opts.archiveDir === "") {
    // Usage error (e.g. `--archive-dir` given with no following path), NOT a ratio
    // gate: exit 2 is a bad-invocation signal, distinct from the always-0 report run.
    console.error("Error: --archive-dir requires a path value.");
    process.exit(2);
  }
  const leafSet = loadLeafSet();
  const tally = scanArchive(opts.archiveDir, leafSet);
  console.log(renderReport(tally));
  // report-only: never gate advancement on the observed ratio.
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
