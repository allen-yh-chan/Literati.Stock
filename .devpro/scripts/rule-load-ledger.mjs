#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  advanceSessionRuleLoadLedgerEpoch,
  applySessionStartRuleLoadLedger,
  inspectSessionRuleLoadDuplicates,
  markSessionRuleLoadLedgerUnknown,
  recordSessionRuleLoads,
  resetSessionRuleLoadLedger,
  sessionRuleLoadLedgerStateFile,
} from "./hooks/lib/rule-load-session-ledger.mjs";
import { splitGfmTableRow } from "./lib/gfm-table.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDir, "../..");

export const BYTES_PER_TOKEN = 3.5;
export const DEFAULT_MAX_EAGER_REFS = 2;

export {
  advanceSessionRuleLoadLedgerEpoch,
  applySessionStartRuleLoadLedger,
  inspectSessionRuleLoadDuplicates,
  markSessionRuleLoadLedgerUnknown,
  recordSessionRuleLoads,
  resetSessionRuleLoadLedger,
  sessionRuleLoadLedgerStateFile,
};

export function estimateTokens(bytes) {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

function normalizeRelPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function wildcardPatternToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function extractAgentsIndexRows(markdown) {
  const section = markdown.match(/## 觸發式載入索引[\s\S]*?\n---/);
  if (!section) throw new Error("AGENTS.md must contain 觸發式載入索引 section");

  const sectionStartLine = markdown.slice(0, section.index).split("\n").length;
  const rows = [];
  const lines = section[0].split("\n");

  for (let offset = 0; offset < lines.length; offset += 1) {
    const line = lines[offset];
    if (!line.startsWith("|") || /^\|\s*-+/.test(line) || /^\|情境\|讀取\|$/.test(line)) {
      continue;
    }
    const cells = splitGfmTableRow(line).slice(1, -1);
    if (cells.length < 2) continue;
    const refs = [...cells[1].matchAll(/`([^`]+\.md|\S+\*\.md)`/g)].map((match) => match[1].trim());
    rows.push({
      line: sectionStartLine + offset,
      intent: cells[0].trim(),
      refs,
      raw: line,
    });
  }

  return rows;
}

export function resolveRuleRef(ref) {
  if (ref.includes("*")) {
    return { ref, relPath: normalizeRelPath(ref), resolvable: true, wildcard: true };
  }
  if (ref.startsWith(".devpro/agent-rules/")) {
    return {
      ref,
      relPath: normalizeRelPath(ref.slice(".devpro/agent-rules/".length)),
      resolvable: true,
      wildcard: false,
    };
  }
  if (!ref.includes("/")) {
    return { ref, relPath: ref, resolvable: true, wildcard: false };
  }
  if (ref.startsWith("platform-adapters/")) {
    return { ref, relPath: normalizeRelPath(ref), resolvable: true, wildcard: false };
  }
  return { ref, relPath: normalizeRelPath(ref), resolvable: false, wildcard: false };
}

export async function statRuleRef(repoRoot, ref) {
  const resolved = resolveRuleRef(ref);
  if (!resolved.resolvable || resolved.wildcard) {
    return { ...resolved, bytes: 0, tokens: 0, missing: true };
  }

  const fullPath = path.join(repoRoot, ".devpro", "agent-rules", resolved.relPath);
  try {
    const stat = await fs.stat(fullPath);
    return {
      ...resolved,
      bytes: stat.size,
      tokens: estimateTokens(stat.size),
      missing: false,
    };
  } catch {
    return { ...resolved, bytes: 0, tokens: 0, missing: true };
  }
}

async function expandWildcardRef(repoRoot, ref) {
  const resolved = resolveRuleRef(ref);
  if (!resolved.wildcard) return [resolved.relPath];

  const wildcardIndex = resolved.relPath.indexOf("*");
  const slashBeforeWildcard = resolved.relPath.lastIndexOf("/", wildcardIndex);
  const dirRel = slashBeforeWildcard === -1 ? "" : resolved.relPath.slice(0, slashBeforeWildcard);
  const filePattern = resolved.relPath.slice(slashBeforeWildcard + 1);
  const regex = wildcardPatternToRegex(filePattern);
  const dir = path.join(repoRoot, ".devpro", "agent-rules", dirRel);

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && regex.test(entry.name))
      .map((entry) => normalizeRelPath(path.join(dirRel, entry.name)))
      .sort();
  } catch {
    return [resolved.relPath];
  }
}

export async function buildRuleLoadLedger(refs, repoRoot = defaultRepoRoot) {
  const files = [];
  const expanded = [];
  for (const ref of refs) {
    expanded.push(...await expandWildcardRef(repoRoot, ref));
  }
  const normalizedRefs = unique(expanded);
  for (const ref of normalizedRefs) {
    files.push(await statRuleRef(repoRoot, ref));
  }

  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const totalTokens = files.reduce((sum, file) => sum + file.tokens, 0);
  return { files, totalBytes, totalTokens };
}

export async function analyzeAgentsIndex(repoRoot = defaultRepoRoot) {
  const agentsPath = path.join(repoRoot, "AGENTS.md");
  const markdown = await fs.readFile(agentsPath, "utf8");
  const rows = [];

  for (const row of extractAgentsIndexRows(markdown)) {
    const ledger = await buildRuleLoadLedger(row.refs, repoRoot);
    rows.push({
      ...row,
      eagerRefCount: row.refs.length,
      totalBytes: ledger.totalBytes,
      totalTokens: ledger.totalTokens,
      files: ledger.files,
    });
  }

  return rows;
}

export function findEagerLoadViolations(rows, maxEagerRefs = DEFAULT_MAX_EAGER_REFS) {
  return rows.filter((row) => row.eagerRefCount > maxEagerRefs);
}

export function formatLedgerMarkdown(ledger) {
  const lines = [
    "# Rule Load Ledger",
    "",
    "| File | Bytes | Tokens |",
    "|---|---:|---:|",
  ];
  for (const file of ledger.files) {
    const label = file.missing ? `${file.relPath} (missing)` : file.relPath;
    lines.push(`| \`${label}\` | ${file.bytes} | ${file.tokens} |`);
  }
  lines.push(`| **Total** | **${ledger.totalBytes}** | **${ledger.totalTokens}** |`);
  return lines.join("\n");
}

export function formatAgentsIndexMarkdown(rows) {
  const lines = [
    "# AGENTS Trigger Index Load Footprint",
    "",
    "| Line | Intent | Eager refs | Bytes | Tokens |",
    "|---:|---|---:|---:|---:|",
  ];
  for (const row of rows) {
    lines.push(`| ${row.line} | ${row.intent} | ${row.eagerRefCount} | ${row.totalBytes} | ${row.totalTokens} |`);
  }
  return lines.join("\n");
}

function parseArgs(args) {
  const options = {
    agentsIndex: false,
    checkAgentsIndex: false,
    json: false,
    maxEagerRefs: DEFAULT_MAX_EAGER_REFS,
    files: [],
    fromStdin: false,
    sessionRecord: false,
    sessionReset: false,
    sessionCompact: false,
    sessionId: "",
    stateFile: "",
    reason: "",
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--agents-index") {
      options.agentsIndex = true;
      continue;
    }
    if (arg === "--check-agents-index") {
      options.checkAgentsIndex = true;
      options.agentsIndex = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--from-stdin") {
      options.fromStdin = true;
      continue;
    }
    if (arg === "--session-record") {
      options.sessionRecord = true;
      continue;
    }
    if (arg === "--session-reset") {
      options.sessionReset = true;
      continue;
    }
    if (arg === "--session-compact") {
      options.sessionCompact = true;
      continue;
    }
    if (arg === "--session-id") {
      options.sessionId = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--state-file") {
      options.stateFile = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--reason") {
      options.reason = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--files") {
      options.files.push(...(args[index + 1] || "").split(",").map((value) => value.trim()));
      index += 1;
      continue;
    }
    if (arg === "--max-eager-refs") {
      options.maxEagerRefs = Number.parseInt(args[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  if (!Number.isInteger(options.maxEagerRefs) || options.maxEagerRefs < 1) {
    throw new Error("--max-eager-refs must be a positive integer");
  }
  if (options.agentsIndex && (options.files.length > 0 || options.fromStdin)) {
    throw new Error("cannot combine --agents-index with --files or --from-stdin");
  }
  if ((options.sessionReset || options.sessionCompact) && (options.agentsIndex || options.files.length > 0 || options.fromStdin || options.sessionRecord)) {
    throw new Error("cannot combine session lifecycle modes with other ledger modes");
  }
  if (options.sessionReset && options.sessionCompact) {
    throw new Error("cannot combine --session-reset with --session-compact");
  }
  if (options.sessionId && options.stateFile) {
    throw new Error("cannot combine --session-id with --state-file");
  }
  if (!options.agentsIndex && options.files.length === 0 && !options.fromStdin && !options.help) {
    if (!options.sessionReset && !options.sessionCompact) options.agentsIndex = true;
  }
  if (options.sessionRecord && options.agentsIndex) {
    throw new Error("--session-record requires --files or --from-stdin");
  }

  return options;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function printUsage() {
  console.log([
    "Usage: node .devpro/scripts/rule-load-ledger.mjs [--agents-index|--check-agents-index] [--json]",
    "       node .devpro/scripts/rule-load-ledger.mjs --files <rule.md[,rule2.md]> [--json]",
    "       node .devpro/scripts/rule-load-ledger.mjs --session-record --files <rule.md[,rule2.md]> (--session-id <id>|--state-file <path>) [--json]",
    "       node .devpro/scripts/rule-load-ledger.mjs --from-stdin [--json]",
    "       node .devpro/scripts/rule-load-ledger.mjs --session-reset --reason <why> (--session-id <id>|--state-file <path>) [--json]",
    "       node .devpro/scripts/rule-load-ledger.mjs --session-compact --reason <why> (--session-id <id>|--state-file <path>) [--json]",
  ].join("\n"));
}

function explicitSessionStateFile(options) {
  if (options.stateFile) return path.resolve(options.stateFile);
  if (options.sessionId) {
    return sessionRuleLoadLedgerStateFile(defaultRepoRoot, { sessionIdentity: options.sessionId });
  }
  throw new Error("session ledger target required: pass --session-id <id> or --state-file <path>");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  if (options.sessionReset) {
    const session = resetSessionRuleLoadLedger({
      stateFile: explicitSessionStateFile(options),
      reason: options.reason,
      actor: "cli",
      source: "manual",
      requireReason: true,
    });
    if (options.json) {
      console.log(JSON.stringify({ session }, null, 2));
      return;
    }
    console.log(`Session rule-load ledger reset: ${session.stateFile} (epoch ${session.contextEpoch})`);
    return;
  }

  if (options.sessionCompact) {
    const session = advanceSessionRuleLoadLedgerEpoch({
      stateFile: explicitSessionStateFile(options),
      reason: options.reason || "manual compact",
      actor: "cli",
      source: "manual",
    });
    if (options.json) {
      console.log(JSON.stringify({ session }, null, 2));
      return;
    }
    console.log(`Session rule-load ledger epoch advanced: ${session.stateFile} (epoch ${session.contextEpoch})`);
    return;
  }

  if (options.agentsIndex) {
    const rows = await analyzeAgentsIndex(defaultRepoRoot);
    const violations = findEagerLoadViolations(rows, options.maxEagerRefs);
    if (options.checkAgentsIndex && violations.length > 0) {
      for (const row of violations) {
        console.error(
          `AGENTS.md:${row.line}: trigger row loads ${row.eagerRefCount} refs; max ${options.maxEagerRefs}: ${row.intent}`
        );
      }
      process.exitCode = 1;
      return;
    }
    if (options.checkAgentsIndex && !options.json) {
      console.log(`AGENTS trigger index eager refs: all rows <= ${options.maxEagerRefs}`);
      return;
    }
    if (options.json) {
      console.log(JSON.stringify({ maxEagerRefs: options.maxEagerRefs, rows, violations }, null, 2));
      return;
    }
    console.log(formatAgentsIndexMarkdown(rows));
    return;
  }

  let refs = options.files;
  if (options.fromStdin) {
    const stdin = await readStdin();
    refs = stdin.split(/\s+/).map((value) => value.trim());
  }
  const ledger = await buildRuleLoadLedger(refs, defaultRepoRoot);
  if (options.sessionRecord) {
    const session = recordSessionRuleLoads(refs, {
      repoRoot: defaultRepoRoot,
      stateFile: explicitSessionStateFile(options),
    });
    if (options.json) {
      console.log(JSON.stringify({ ...ledger, session }, null, 2));
      return;
    }
    console.log(formatLedgerMarkdown(ledger));
    if (session.duplicates.length > 0) {
      console.log("");
      console.log(`Duplicate rule-load bytes: ${session.duplicateBytes}`);
      console.log(`Duplicate rule-load tokens est: ${session.duplicateTokens}`);
    }
    return;
  }
  if (options.json) {
    console.log(JSON.stringify(ledger, null, 2));
    return;
  }
  console.log(formatLedgerMarkdown(ledger));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
