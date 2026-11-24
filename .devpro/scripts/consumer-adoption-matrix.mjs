#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDir, "../..");

const SOURCE_MAINTAINER_ONLY = new Set([
  "agent-skill-governance.md",
  "agents-md-maintenance.md",
  "design-core.md",
  "knowledge-digest.md",
  "proposal-template.md",
  "rule-audit-playbook.md",
  "rule-design-principles.md",
  "rule-file-template.md",
  "rule-ingest-methodology.md",
  "rules-consistency-checklist.md",
  "token-budget-precheck.md",
]);

const CONSUMER_OWNED = new Set([
  "consumer-adoption.md",
  "consumer-failure-playbook.md",
  "consumer-hook-file-maintenance.md",
  "consumer-uninstall.md",
  "openspec-flow-consumer.md",
]);

const CONSUMER_LITE = new Set([
  "ai-autonomy.md",
  "ambiguity-scoring.md",
  "branch-terminology-glossary.md",
  "chore-classification.md",
  "consumer-adoption.md",
  "consumer-failure-playbook.md",
  "consumer-hook-file-maintenance.md",
  "consumer-uninstall.md",
  "environment-setup-nvm-nodejs-openspec.md",
  "environment-class2-checks.md",
  "git-branch-and-pr-flow.md",
  "git-branch-hygiene.md",
  "git-branch-naming-and-anchor.md",
  "git-branch-no-tag-ancestry-evidence.md",
  "git-branch-production-ancestry-repair.md",
  "git-pr-template-and-merge.md",
  "git-workflow-tracking.md",
  "gitignore-alignment.md",
  "openspec-archive-principles.md",
  "openspec-branch-routing.md",
  "openspec-flow-consumer.md",
  "openspec-flow-fallback.md",
  "openspec-flow.md",
  "openspec-quality-advanced-patterns.md",
  "openspec-quality-and-formats.md",
  "openspec-quality-doc-formats.md",
  "openspec-scope-change.md",
  "openspec-spec-delta-pitfalls.md",
  "openspec-step-1-to-9.md",
  "platform-adapter-contract.md",
  "platform-adapters/claude-code.md",
  "platform-adapters/codex.md",
  "platform-adapters/copilot.md",
  "platform-adapters/cursor.md",
  "platform-adapters/gemini.md",
  "post-intervention-recovery-gate.md",
  "preflight-checklist.md",
  "pr-review-evidence-verification.md",
  "requirement-count-ratchet-internals.md",
  "second-review-external-evaluator.md",
  "release-hotfix-carrier-policy.md",
  "release-milestone-assignment.md",
  "release-verification-commands.md",
  "release-sit-uat-pat-prod.md",
  "rule-load-ledger-internals.md",
  "rules-flow-production-continuation.md",
  "rules-flow-rollback.md",
  "rules-flow-routing.md",
  "rules-flow.md",
  "security-coding.md",
  "test-suite-cadence.md",
  "testing-and-qa.md",
  "third-party-packages-licensing.md",
  "token-frugal-io.md",
  "troubleshooting.md",
]);

export const SUPPORTED_PROFILES = [
  "consumer-lite",
  "consumer-full",
  "source-maintainer",
];

export const ENFORCEMENT_BUCKETS = [
  { key: "hard-gate", title: "Hard Gate" },
  { key: "advisory", title: "Advisory" },
  { key: "doctrine", title: "Doctrine" },
];

const HARD_GATE_MARKERS = [
  "pre-tool-gate.mjs",
  "gh-footer-gate.mjs",
  "pre-pr-archive-gate.mjs",
  "post-pr-completion-check.mjs",
  "recap-check.mjs",
  "sync-agent-rules.mjs --check",
  "hard-block",
  "fail closed",
  "fail-closed",
];

const ADVISORY_MARKERS = [
  "advisory",
  "warn-only",
  "soft nudge",
  "fail-open",
  "警告",
];

const COMMAND_CARRIERS = new Set([
  "--check",
  "openspec validate",
]);

function normalizeRelPath(filePath) {
  return filePath.split(path.sep).join("/");
}

async function collectMarkdownFiles(dir, base = dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectMarkdownFiles(fullPath, base));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(normalizeRelPath(path.relative(base, fullPath)));
    }
  }
  return files.sort();
}

async function collectMjsBasenames(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      names.push(...await collectMjsBasenames(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".mjs")) {
      names.push(entry.name);
    }
  }
  return names;
}

function audienceFor(relPath) {
  if (SOURCE_MAINTAINER_ONLY.has(relPath)) return "source-maintainer";
  if (CONSUMER_OWNED.has(relPath)) return "consumer-owned";
  return "shared";
}

function profilesFor(relPath, audience) {
  if (audience === "source-maintainer") return ["source-maintainer"];

  const profiles = [];
  if (CONSUMER_LITE.has(relPath)) profiles.push("consumer-lite");
  profiles.push("consumer-full", "source-maintainer");
  return profiles;
}

function enforcementFor(content, carriers) {
  const enforcement = [];
  if (HARD_GATE_MARKERS.some((marker) => content.includes(marker)) && carriers.length > 0) {
    enforcement.push("hard-gate");
  }
  if (ADVISORY_MARKERS.some((marker) => content.includes(marker))) {
    enforcement.push("advisory");
  }
  if (content.includes("cooperative-only") || enforcement.length === 0) {
    enforcement.push("doctrine");
  }
  return enforcement;
}

export async function discoverKnownCarriers(repoRoot = defaultRepoRoot) {
  const scriptsDir = path.join(repoRoot, ".devpro", "scripts");
  const names = await collectMjsBasenames(scriptsDir);
  return new Set([...names, ...COMMAND_CARRIERS]);
}

function addCarrierIfKnown(carriers, carrier, knownCarriers) {
  if (knownCarriers.has(carrier)) carriers.add(carrier);
}

function carrierSummary(content, knownCarriers) {
  const carriers = new Set();
  for (const match of content.matchAll(/[`'"]?([A-Za-z0-9_.-]+\.mjs)[`'"]?/g)) {
    const carrier = match[1];
    if (!carrier.startsWith(".")) addCarrierIfKnown(carriers, carrier, knownCarriers);
  }
  if (content.includes("openspec validate")) addCarrierIfKnown(carriers, "openspec validate", knownCarriers);
  if (content.includes("--check")) addCarrierIfKnown(carriers, "--check", knownCarriers);
  return [...carriers].sort().slice(0, 8);
}

export async function discoverRuleLeaves(repoRoot = defaultRepoRoot) {
  const rulesDir = path.join(repoRoot, ".devpro", "agent-rules");
  return collectMarkdownFiles(rulesDir);
}

export async function generateMatrix(repoRoot = defaultRepoRoot) {
  const rulesDir = path.join(repoRoot, ".devpro", "agent-rules");
  const leaves = await discoverRuleLeaves(repoRoot);
  const knownCarriers = await discoverKnownCarriers(repoRoot);
  const matrix = [];

  for (const relPath of leaves) {
    const content = await fs.readFile(path.join(rulesDir, relPath), "utf8");
    const audience = audienceFor(relPath);
    const carriers = carrierSummary(content, knownCarriers);
    matrix.push({
      path: relPath,
      audience,
      profiles: profilesFor(relPath, audience),
      enforcement: enforcementFor(content, carriers),
      carriers,
    });
  }

  return matrix;
}

export function validateMatrix(matrix, leaves, options = {}) {
  const knownCarriers = options.knownCarriers;
  const errors = [];
  const paths = matrix.map((entry) => entry.path);
  const uniquePaths = new Set(paths);

  if (uniquePaths.size !== paths.length) {
    errors.push("matrix contains duplicate paths");
  }

  for (const leaf of leaves) {
    if (!uniquePaths.has(leaf)) errors.push(`missing matrix entry: ${leaf}`);
  }

  for (const entry of matrix) {
    if (!entry.audience) errors.push(`${entry.path}: missing audience`);
    if (!Array.isArray(entry.profiles) || entry.profiles.length === 0) {
      errors.push(`${entry.path}: missing profiles`);
    }
    if (!Array.isArray(entry.enforcement) || entry.enforcement.length === 0) {
      errors.push(`${entry.path}: missing enforcement`);
    }
    const unsupported = entry.enforcement.filter(
      (bucket) => !ENFORCEMENT_BUCKETS.some((known) => known.key === bucket)
    );
    if (unsupported.length > 0) {
      errors.push(`${entry.path}: unsupported enforcement bucket(s): ${unsupported.join(", ")}`);
    }
    if (entry.enforcement.includes("hard-gate") && (!Array.isArray(entry.carriers) || entry.carriers.length === 0)) {
      errors.push(`${entry.path}: hard-gate enforcement requires at least one carrier`);
    }
    if (knownCarriers) {
      const unknownCarriers = (entry.carriers || []).filter((carrier) => !knownCarriers.has(carrier));
      for (const carrier of unknownCarriers) {
        errors.push(`${entry.path}: unknown generated carrier: ${carrier}`);
      }
    }
  }

  const byPath = new Map(matrix.map((entry) => [entry.path, entry]));
  const required = [
    ["ai-autonomy.md", "profiles", "consumer-lite"],
    ["consumer-adoption.md", "audience", "consumer-owned"],
    ["consumer-failure-playbook.md", "audience", "consumer-owned"],
    ["consumer-failure-playbook.md", "profiles", "consumer-lite"],
    ["openspec-flow-consumer.md", "audience", "consumer-owned"],
    ["rule-design-principles.md", "audience", "source-maintainer"],
  ];

  for (const [file, field, expected] of required) {
    const entry = byPath.get(file);
    if (!entry) {
      errors.push(`required classification missing entry: ${file}`);
      continue;
    }
    if (Array.isArray(entry[field])) {
      if (!entry[field].includes(expected)) {
        errors.push(`${file}: ${field} must include ${expected}`);
      }
    } else if (entry[field] !== expected) {
      errors.push(`${file}: ${field} must be ${expected}`);
    }
  }

  return errors;
}

function countBy(entries, valueForEntry) {
  const counts = {};
  for (const entry of entries) {
    const values = valueForEntry(entry);
    for (const value of Array.isArray(values) ? values : [values]) {
      counts[value] = (counts[value] || 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

export function buildSummary(matrix, profile) {
  const entries = profile ? buildProfileView(matrix, profile).entries : matrix;
  const enforcementCounts = {};
  for (const { key } of ENFORCEMENT_BUCKETS) enforcementCounts[key] = 0;
  for (const entry of entries) {
    for (const bucket of entry.enforcement) {
      enforcementCounts[bucket] = (enforcementCounts[bucket] || 0) + 1;
    }
  }

  return {
    profile: profile || "all",
    totalEntries: entries.length,
    enforcementAssignments: Object.values(enforcementCounts).reduce((sum, count) => sum + count, 0),
    enforcementCounts,
    audienceCounts: countBy(entries, (entry) => entry.audience),
    carrierBearingEntries: entries.filter((entry) => entry.carriers.length > 0).length,
  };
}

function formatCountRows(counts) {
  const rows = Object.entries(counts).map(([name, count]) => `| ${name} | ${count} |`);
  return ["| Name | Count |", "|---|---:|", ...rows].join("\n");
}

export function formatSummaryMarkdown(matrix, profile) {
  const summary = buildSummary(matrix, profile);
  return [
    `# Consumer Adoption Summary: \`${summary.profile}\``,
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Total entries | ${summary.totalEntries} |`,
    `| Enforcement assignments | ${summary.enforcementAssignments} |`,
    `| Entries with carriers | ${summary.carrierBearingEntries} |`,
    "",
    "## Enforcement",
    "",
    formatCountRows(summary.enforcementCounts),
    "",
    "## Audience",
    "",
    formatCountRows(summary.audienceCounts),
  ].join("\n");
}

export function formatMarkdown(matrix) {
  const header = "| Leaf | Audience | Profiles | Enforcement | Carriers |\n|---|---|---|---|---|";
  const rows = matrix.map((entry) =>
    `| \`${entry.path}\` | ${entry.audience} | ${entry.profiles.join(", ")} | ` +
    `${entry.enforcement.join(", ")} | ${entry.carriers.join(", ") || "N/A"} |`
  );
  return [header, ...rows].join("\n");
}

export function profileEntries(matrix, profile) {
  return matrix.filter((entry) => entry.profiles.includes(profile));
}

export function buildProfileView(matrix, profile) {
  if (!SUPPORTED_PROFILES.includes(profile)) {
    throw new Error(`unknown profile: ${profile}`);
  }
  const entries = profileEntries(matrix, profile);
  if (entries.length === 0) {
    throw new Error(`profile contains no entries: ${profile}`);
  }
  return { profile, entries };
}

export function formatProfileMarkdown(matrix, profile) {
  const view = buildProfileView(matrix, profile);
  return [`# Consumer Adoption Profile: \`${view.profile}\``, "", formatMarkdown(view.entries)].join("\n");
}

export function formatAgentsMdArtifact(matrix, profile) {
  const view = buildProfileView(matrix, profile);
  const summary = buildSummary(matrix, profile);
  const header = "| Leaf | Audience | Enforcement | Carriers |\n|---|---|---|---|";
  const rows = view.entries.map((entry) =>
    `| \`${entry.path}\` | ${entry.audience} | ${entry.enforcement.join(", ")} | ` +
    `${entry.carriers.join(", ") || "N/A"} |`
  );

  return [
    `# AGENTS profile: ${view.profile}`,
    "",
    `Generated from \`consumer-adoption-matrix.mjs --profile ${view.profile} --agents-md\`. Do not hand-maintain this artifact.`,
    "",
    "## Purpose",
    "",
    "Use this generated compact profile first for consumer AI onboarding.",
    "",
    "## Operating Contract",
    "",
    "- Start from root `AGENTS.md` Core Contract when it exists in the consumer repo.",
    "- Load leaf rules on demand when the active task explicitly needs that rule domain.",
    "- Do not copy the full rule corpus into a second prompt.",
    "- Use `consumer-full` or `source-maintainer` only with a documented reason.",
    "- Track loaded rule bytes with `rule-load-ledger.mjs`; do not re-read unchanged leaves in the same session.",
    "- Run `node .devpro/scripts/consumer-adoption-matrix.mjs --check` and `node .devpro/scripts/devpro-doctor.mjs` for adoption health.",
    "",
    "## Summary",
    "",
    `- Total entries: ${summary.totalEntries}`,
    `- Entries with carriers: ${summary.carrierBearingEntries}`,
    `- Hard Gate entries: ${summary.enforcementCounts["hard-gate"]}`,
    `- Advisory entries: ${summary.enforcementCounts.advisory}`,
    `- Doctrine entries: ${summary.enforcementCounts.doctrine}`,
    "",
    "## Profile Leaves",
    "",
    header,
    ...rows,
  ].join("\n");
}

export function buildEnforcementMap(matrix, profile) {
  const entries = profile ? buildProfileView(matrix, profile).entries : matrix;
  const buckets = Object.fromEntries(ENFORCEMENT_BUCKETS.map(({ key }) => [key, []]));

  for (const entry of entries) {
    for (const bucket of entry.enforcement) {
      if (buckets[bucket]) buckets[bucket].push(entry);
    }
  }

  for (const entriesForBucket of Object.values(buckets)) {
    entriesForBucket.sort((left, right) => left.path.localeCompare(right.path));
  }

  return {
    profile: profile || "all",
    buckets,
  };
}

function formatEnforcementRows(entries) {
  if (entries.length === 0) return "_No entries._";
  const header = "| Leaf | Audience | Profiles | Carriers |\n|---|---|---|---|";
  const rows = entries.map((entry) =>
    `| \`${entry.path}\` | ${entry.audience} | ${entry.profiles.join(", ")} | ` +
    `${entry.carriers.join(", ") || "N/A"} |`
  );
  return [header, ...rows].join("\n");
}

export function formatEnforcementMapMarkdown(matrix, profile) {
  const view = buildEnforcementMap(matrix, profile);
  const lines = [
    `# Consumer Adoption Enforcement Map: \`${view.profile}\``,
    "",
    "Hard Gate = mechanically blocked or checked by a named carrier.",
    "Advisory = warning, nudge, or fail-open guidance.",
    "Doctrine = cooperative process or reviewer judgment without a hard block.",
  ];

  for (const { key, title } of ENFORCEMENT_BUCKETS) {
    lines.push("", `## ${title}`, "", formatEnforcementRows(view.buckets[key]));
  }

  return lines.join("\n");
}

function parseArgs(args) {
  const options = {
    json: false,
    check: false,
    enforcementMap: false,
    summary: false,
    agentsMd: false,
    help: false,
    profile: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--check") {
      options.check = true;
      continue;
    }
    if (arg === "--enforcement-map") {
      options.enforcementMap = true;
      continue;
    }
    if (arg === "--summary") {
      options.summary = true;
      continue;
    }
    if (arg === "--agents-md") {
      options.agentsMd = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--profile") {
      options.profile = args[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  if (options.profile === undefined && args.includes("--profile")) {
    throw new Error("missing profile name");
  }
  if (options.summary && options.enforcementMap) {
    throw new Error("cannot combine --summary with --enforcement-map");
  }
  if (options.agentsMd && !options.profile) {
    throw new Error("--agents-md requires --profile");
  }
  if (options.agentsMd && (options.json || options.enforcementMap || options.summary || options.check)) {
    throw new Error("cannot combine --agents-md with --json, --check, --summary, or --enforcement-map");
  }

  return options;
}

async function main() {
  const { json, check, enforcementMap, summary, agentsMd, help, profile } = parseArgs(process.argv.slice(2));

  if (help) {
    console.log(
      "Usage: node .devpro/scripts/consumer-adoption-matrix.mjs [--json|--check] " +
      "[--profile <consumer-lite|consumer-full|source-maintainer>] [--enforcement-map|--summary|--agents-md]"
    );
    return;
  }

  const matrix = await generateMatrix(defaultRepoRoot);
  const leaves = await discoverRuleLeaves(defaultRepoRoot);
  const knownCarriers = await discoverKnownCarriers(defaultRepoRoot);
  const profileView = profile ? buildProfileView(matrix, profile) : undefined;
  const enforcementView = enforcementMap ? buildEnforcementMap(matrix, profile) : undefined;
  const summaryView = summary ? buildSummary(matrix, profile) : undefined;

  if (check) {
    const errors = validateMatrix(matrix, leaves, { knownCarriers });
    if (errors.length > 0) {
      for (const error of errors) console.error(error);
      process.exitCode = 1;
      return;
    }
    console.log(`consumer adoption matrix: ${matrix.length} rule leaves covered`);
    return;
  }

  if (agentsMd) {
    console.log(formatAgentsMdArtifact(matrix, profile));
    return;
  }

  if (summary) {
    if (json) {
      console.log(JSON.stringify({ generatedAt: new Date(0).toISOString(), summary: summaryView }, null, 2));
      return;
    }

    console.log(formatSummaryMarkdown(matrix, profile));
    return;
  }

  if (profile) {
    if (enforcementMap) {
      if (json) {
        console.log(JSON.stringify({ generatedAt: new Date(0).toISOString(), ...enforcementView }, null, 2));
        return;
      }

      console.log(formatEnforcementMapMarkdown(matrix, profile));
      return;
    }

    if (json) {
      console.log(JSON.stringify({ generatedAt: new Date(0).toISOString(), ...profileView }, null, 2));
      return;
    }

    console.log(formatProfileMarkdown(matrix, profile));
    return;
  }

  if (json) {
    if (enforcementMap) {
      console.log(JSON.stringify({ generatedAt: new Date(0).toISOString(), ...enforcementView }, null, 2));
      return;
    }

    console.log(JSON.stringify({ generatedAt: new Date(0).toISOString(), matrix }, null, 2));
    return;
  }

  if (enforcementMap) {
    console.log(formatEnforcementMapMarkdown(matrix));
    return;
  }

  console.log(formatMarkdown(matrix));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
