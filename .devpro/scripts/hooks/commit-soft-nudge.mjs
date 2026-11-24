#!/usr/bin/env node
/**
 * commit-soft-nudge.mjs — warn before non-exempt commits that will need cross-review.
 *
 * Soft advisory only:
 * - rules sync SemVer branches whitelisted by preflight-checklist.md stay silent
 * - all other `git commit` commands print one stderr nudge and exit 0
 */

import { readStdin } from "./lib/stdin.mjs";
import { spawnSync } from "node:child_process";
import { commandSegmentText, GIT_GLOBAL_OPT } from "./lib/shell-context.mjs";
import { isRulesSyncExemptFromCrossModel } from "./lib/branch-naming.mjs";

const NUDGE = "💡 此分支將需 cross-review；可先跑 `/devpro:cross-review` 預檢";

function commandHasGitCommit(command) {
  const commandOnly = commandSegmentText(command || "");
  return commandOnly.split(/[;&|()\n]+/).some((part) => {
    let s = part.trim();
    s = s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*/, "");
    s = s.replace(/^env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*/, "");
    s = s.replace(/^command\s+/, "");
    // Consume any leading git global option (not just -C) so `git --no-pager
    // commit` still triggers the nudge — same generalized grammar as the gates
    // (issue #851/#848 round 7).
    return new RegExp(`^(?:\\S*\\/)?git(?:\\s+${GIT_GLOBAL_OPT})*\\s+commit(?:\\s|$)`).test(s);
  });
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) return "";
  return (result.stdout || "").trim();
}

function repoRootFor(cwd) {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

function branchFor(repoRoot) {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
}

let payload = {};
try {
  const raw = await readStdin();
  payload = JSON.parse(raw || "{}");
} catch {
  process.exit(0);
}

const toolName = payload.tool_name || payload.toolName || "";
if (String(toolName).toLowerCase() !== "bash") process.exit(0);

const toolInput = payload.tool_input || payload.toolInput || {};
const command = toolInput.command || toolInput.cmd || "";
if (!commandHasGitCommit(command)) process.exit(0);

const baseCwd =
  toolInput.cwd ||
  toolInput.workdir ||
  toolInput.working_dir ||
  toolInput.workingDir ||
  payload.cwd ||
  payload.workdir ||
  payload.working_dir ||
  payload.workingDir ||
  process.cwd();

const repoRoot = repoRootFor(baseCwd);
if (!repoRoot) process.exit(0);

const branch = branchFor(repoRoot);
if (!branch || branch === "HEAD") process.exit(0);

try {
  if (isRulesSyncExemptFromCrossModel(branch, repoRoot)) process.exit(0);
} catch {
  // Soft advisory: whitelist parsing failure must not block the commit path.
}

process.stderr.write(`${NUDGE}\n`);
process.exit(0);
