#!/usr/bin/env node
/**
 * Issue a half-state single-use override (design D12). Run ONLY after the user
 * explicitly granted the override in this session; `--reason` MUST carry the
 * user's wording. The override is consumed exactly once by `classify-bounded`
 * (request fields `overrideId` + `responsibilityId` + `budgetState`).
 *
 *   node .devpro/scripts/issue-half-state-override.mjs --change <change_id> \
 *     --responsibility <responsibility_id> --reason "<user's words>" [--repo-root <path>]
 */
import { execFileSync } from "node:child_process";
import process from "node:process";
import { issueHalfStateOverride } from "./lib/half-state-override.mjs";

function parseArgs(argv) {
  const out = { repoRoot: null, change: null, responsibility: null, reason: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--change") { out.change = value; i += 1; }
    else if (key === "--responsibility") { out.responsibility = value; i += 1; }
    else if (key === "--reason") { out.reason = value; i += 1; }
    else if (key === "--repo-root") { out.repoRoot = value; i += 1; }
    else if (key === "--help" || key === "-h") { out.help = true; }
    else { throw new Error(`unknown argument: ${key}`); }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.change || !args.responsibility || !args.reason) {
    process.stdout.write("usage: issue-half-state-override.mjs --change <change_id> --responsibility <responsibility_id> --reason \"<user's words>\" [--repo-root <path>]\n");
    process.exit(args.help ? 0 : 2);
  }
  const repoRoot = args.repoRoot ?? execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const result = issueHalfStateOverride({ repoRoot, changeId: args.change, responsibilityId: args.responsibility, reason: args.reason });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}

main();
