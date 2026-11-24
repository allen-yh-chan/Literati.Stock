/**
 * post-commit-advisory.mjs
 *
 * PostToolUse recovery for commit-time advisories that PreToolUse cannot run
 * when static cwd resolution fails (issue #2366 — worktree `cd … && git commit`).
 *
 * After a successful `git commit`, resolves the actual repo via
 * `git rev-parse --show-toplevel` with fallbacks (commandCwdForGitMatch, cd
 * targets, git worktree list) and re-runs:
 *   - attribution version-equality on HEAD commit message (warn-only)
 *   - EOF detection on files in HEAD (warn-only — cannot re-stage)
 *
 * Fail-open: unresolved cwd emits a named advisory, never throws.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  commandCwdForGitMatch,
  resolveHostFilesystemPath,
  shellTokenValue,
  UNRESOLVABLE_CWD,
} from "./hook-command-context.mjs";
import {
  anchoredVerbIndex,
  CMD_POSITION_ANCHOR,
  commandSegmentText,
  GIT_GLOBAL_OPT,
  isMatchInCommandSegment,
  segmentCommand,
} from "./shell-context.mjs";
import { getRepoRoot, readAgentsMdVersion, runGit } from "./git-utils.mjs";
import { isSourceDestination, resetDestinationIdentityCache } from "./operation-target.mjs";
import {
  compareVersions,
  extractVersionFromFooter,
} from "./version-helpers.mjs";
import { isDirtyPerGuard } from "../../normalize-eof.mjs";

const GIT_WITH_C = `git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*`;
const GIT_COMMIT_RE = new RegExp(`${CMD_POSITION_ANCHOR}${GIT_WITH_C}commit\\b`);

const GATE2B_VERSION_LABEL = "Commit attribution gate (version-equality)";
const GATE3_POST_LABEL = "Commit-time EOF post-commit detection";

const VERSION_MISMATCH_REMEDY =
  "更新 commit message footer 至 AGENTS.md 真實版號，或確認 AGENTS.md 已為最新版本";
const EOF_POST_REMEDY =
  "手動修正已 commit 檔案的 EOF 空行（PostToolUse 無法 re-stage；下次 commit 前請先 normalize）";
const REPO_UNRESOLVED_REMEDY =
  "確認 `-C`/`cd` 目標是存在的 git worktree；若持續發生請回報 hook cwd 解析問題";

function gateCommandSegmentText(cmd) {
  return commandSegmentText(cmd);
}

function gitVerbIndex(match) {
  return anchoredVerbIndex(match);
}

function safeSegmentCommand(cmd) {
  try {
    return segmentCommand(cmd);
  } catch {
    return null;
  }
}

// Same positive-identity judgement as pre-tool-gate.mjs (hooks/lib/operation-target.mjs): one carrier, no second copy.
const isSourceRepo = isSourceDestination;

function attributionFooterPresent(text) {
  const cleaned = text
    .trimEnd()
    .replace(/\n[A-Z][A-Z0-9_]*\n\)?["']?$/, "")
    .trimEnd();
  const tail = cleaned.slice(-240);
  return (
    /Rules:\s*v[\d.]+[^\n]*?Tool:\s*\S[^\n]*?Model:\s*\S[^\n]*$/.test(tail) ||
    /Rules:\s*v[\d.]+[^\n]*?Model:\s*\S[^\n]*\s+\/\s+\S[^\n]*$/.test(tail)
  );
}

function sanitizeAdvisoryCwd(cwd) {
  if (!cwd || typeof cwd !== "string" || cwd === UNRESOLVABLE_CWD) return "(unresolved)";
  return path.basename(cwd) || "(unresolved)";
}

/** Strip control chars from paths before embedding in advisory text (log injection). */
function sanitizeFilenameForAdvisory(file) {
  return String(file || "").replace(/[\x00-\x1f\x7f]/g, "?");
}

function formatRecoveryAdvisory(gateLabel, cwd, reasonToken, consequence, remedy) {
  return `${gateLabel} effective-scope: post-commit recovery cwd=${sanitizeAdvisoryCwd(cwd)} reason=${reasonToken}. ${consequence} ${remedy}。`;
}

export function isSuccessfulGitCommitCommand(cmd) {
  const cmdText = gateCommandSegmentText(cmd);
  const match = GIT_COMMIT_RE.exec(cmdText);
  if (!match) return false;
  if (/--no-edit\b/.test(cmdText)) return false;
  const segs = safeSegmentCommand(cmdText);
  if (segs && !isMatchInCommandSegment(gitVerbIndex(match), segs)) return false;
  return true;
}

function collectCdTargetsBeforeIndex(cmd, beforeIndex, baseCwd) {
  const targets = [];
  const prefix = cmd.slice(0, Math.max(0, beforeIndex));
  const cdRe = /(?:^|[\s;|&(])(?:builtin\s+|command\s+)?\\?cd\s+("[^"]+"|'[^']+'|\S+)/g;
  let running = baseCwd;
  for (const match of prefix.matchAll(cdRe)) {
    const raw = match[1];
    if (!raw || /[$`\\~]/.test(raw)) continue;
    const target = shellTokenValue(raw);
    if (!target || target === "-") continue;
    running = resolveHostFilesystemPath(
      path.isAbsolute(target) ? target : path.resolve(running, target)
    );
    targets.push(running);
  }
  return targets;
}

function collectGitCTargets(cmdText) {
  const targets = [];
  for (const match of cmdText.matchAll(/(?:^|\s)-C\s+("[^"]+"|'[^']+'|\S+)/g)) {
    const raw = match[1];
    if (!raw || /[$`\\~]/.test(raw)) continue;
    targets.push(shellTokenValue(raw));
  }
  return targets;
}

function listLinkedWorktreePaths(baseCwd) {
  const out = runGit("worktree list --porcelain", { cwd: baseCwd, timeout: 2000 });
  if (!out) return [];
  const paths = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length).trim());
  }
  return paths;
}

function headMatchesHint(cwd, commitHashHint) {
  if (!commitHashHint) return true;
  const head = runGit("rev-parse HEAD", { cwd, timeout: 2000 });
  if (!head) return false;
  return head.startsWith(commitHashHint) || commitHashHint.startsWith(head);
}

/**
 * Resolve the git worktree directory where the commit landed.
 * Returns absolute cwd inside the repo, or "" when unresolvable (fail-open).
 */
export function resolvePostCommitRepoCwd(cmd, baseCwd, commitHashHint = "") {
  const cmdText = gateCommandSegmentText(cmd);
  const commitMatch = GIT_COMMIT_RE.exec(cmdText);
  if (!commitMatch) return "";

  const commandCandidates = [];
  const worktreeCandidates = [];
  const seen = new Set();
  function addCommandCandidate(raw) {
    if (!raw || typeof raw !== "string") return;
    const resolved = resolveHostFilesystemPath(
      path.isAbsolute(raw) ? raw : path.resolve(baseCwd || process.cwd(), raw)
    );
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    commandCandidates.push(resolved);
  }
  function addWorktreeCandidate(raw) {
    if (!raw || typeof raw !== "string") return;
    const resolved = resolveHostFilesystemPath(
      path.isAbsolute(raw) ? raw : path.resolve(baseCwd || process.cwd(), raw)
    );
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    worktreeCandidates.push(resolved);
  }

  if (baseCwd) addCommandCandidate(baseCwd);

  const preResolved = commandCwdForGitMatch(
    cmdText,
    commitMatch[0],
    baseCwd,
    gitVerbIndex(commitMatch)
  );
  if (preResolved && preResolved !== UNRESOLVABLE_CWD) addCommandCandidate(preResolved);

  for (const target of collectCdTargetsBeforeIndex(cmdText, gitVerbIndex(commitMatch), baseCwd)) {
    addCommandCandidate(target);
  }
  for (const target of collectGitCTargets(commitMatch[0])) {
    addCommandCandidate(target);
  }

  const seed = baseCwd || process.cwd();
  if (getRepoRoot(seed)) {
    for (const wt of listLinkedWorktreePaths(seed)) addWorktreeCandidate(wt);
  }

  const allCandidates = [...commandCandidates, ...worktreeCandidates];

  if (commitHashHint) {
    for (const cwd of allCandidates) {
      if (getRepoRoot(cwd) && headMatchesHint(cwd, commitHashHint)) return cwd;
    }
  }

  for (let i = commandCandidates.length - 1; i >= 0; i -= 1) {
    const cwd = commandCandidates[i];
    if (getRepoRoot(cwd)) return cwd;
  }

  for (let i = worktreeCandidates.length - 1; i >= 0; i -= 1) {
    const cwd = worktreeCandidates[i];
    if (getRepoRoot(cwd)) return cwd;
  }

  for (const cwd of allCandidates) {
    const top = runGit("rev-parse --show-toplevel", { cwd, timeout: 2000 });
    if (top) return cwd;
  }

  return "";
}

function readHeadCommitMessage(repoCwd) {
  return runGit('log -1 --format=%B', { cwd: repoCwd, timeout: 2000 });
}

function checkPostCommitVersionEquality(repoCwd) {
  const repoRoot = getRepoRoot(repoCwd);
  if (!repoRoot) {
    return formatRecoveryAdvisory(
      GATE2B_VERSION_LABEL,
      repoCwd,
      "repo-root-unresolved",
      "PostToolUse 無法回讀 commit repo root，版號相等性未驗證。",
      REPO_UNRESOLVED_REMEDY
    );
  }

  const message = readHeadCommitMessage(repoCwd);
  if (!message) {
    return formatRecoveryAdvisory(
      GATE2B_VERSION_LABEL,
      repoCwd,
      "probe-failed",
      "PostToolUse 無法讀取 HEAD commit message，版號相等性未驗證。",
      "手動核對 commit footer 與 AGENTS.md 版本是否一致"
    );
  }

  if (!attributionFooterPresent(message)) return null;

  const footerVer = extractVersionFromFooter(message);
  if (footerVer === null) return null;

  const agentsVer = readAgentsMdVersion(repoRoot);
  if (agentsVer === null) {
    return formatRecoveryAdvisory(
      GATE2B_VERSION_LABEL,
      repoCwd,
      "version-layer-skipped",
      "PreToolUse 略過版號相等性；PostToolUse 仍無法讀取 AGENTS.md 版本。",
      "手動核對 commit footer 宣告的 Rules 版號與目標 repo AGENTS.md 版本是否一致"
    );
  }

  if (compareVersions(footerVer, agentsVer) !== 0) {
    return formatRecoveryAdvisory(
      GATE2B_VERSION_LABEL,
      repoCwd,
      "version-mismatch",
      `HEAD commit footer 宣告 Rules: v${footerVer}，但 AGENTS.md 版本：${agentsVer}（release-integrity 風險；commit 已成立，僅 warn）。`,
      VERSION_MISMATCH_REMEDY
    );
  }

  return null;
}

function listHeadCommitTextFiles(repoCwd) {
  const out = spawnSync(
    "git",
    ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"],
    { cwd: repoCwd, encoding: "utf8", timeout: 2000 }
  );
  if (out.status !== 0 || !out.stdout) return { files: [], probeFailed: true };

  const files = out.stdout
    .split("\0")
    .filter(Boolean)
    .filter((file) => {
      const numstat = spawnSync("git", ["show", `HEAD:${file}`], {
        cwd: repoCwd,
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 2000,
      });
      if (numstat.status !== 0) return false;
      const buf = numstat.stdout;
      return buf && !buf.includes(0);
    });

  return { files, probeFailed: false };
}

function checkPostCommitEofDetection(repoCwd) {
  if (!isSourceRepo(repoCwd)) return null;

  const { files, probeFailed } = listHeadCommitTextFiles(repoCwd);
  if (probeFailed) {
    return formatRecoveryAdvisory(
      GATE3_POST_LABEL,
      repoCwd,
      "probe-failed",
      "PostToolUse 無法列舉 HEAD commit 檔案，EOF 未檢查。",
      EOF_POST_REMEDY
    );
  }

  const dirty = [];
  for (const file of files) {
    const show = spawnSync("git", ["show", `HEAD:${file}`], {
      cwd: repoCwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 2000,
    });
    if (show.status !== 0) continue;
    if (isDirtyPerGuard(show.stdout)) dirty.push(file);
  }

  if (dirty.length === 0) return null;

  return formatRecoveryAdvisory(
    GATE3_POST_LABEL,
    repoCwd,
    "eof-dirty-committed",
    `HEAD commit 含 EOF 空行檔案：${dirty.map(sanitizeFilenameForAdvisory).join(", ")}（已 commit，無法 re-stage）。`,
    EOF_POST_REMEDY
  );
}

/**
 * Run post-commit recovered advisories for a successful git commit command.
 *
 * @param {string} cmd
 * @param {string} baseCwd
 * @param {{ commitHashHint?: string }} [opts]
 * @returns {{ advisories: string[] } | null}
 */
export function runPostCommitCommitAdvisories(cmd, baseCwd, opts = {}) {
  if (!isSuccessfulGitCommitCommand(cmd)) return null;
  resetDestinationIdentityCache();

  const commitHashHint = opts.commitHashHint || "";
  const repoCwd = resolvePostCommitRepoCwd(cmd, baseCwd, commitHashHint);
  if (!repoCwd) {
    return {
      advisories: [
        formatRecoveryAdvisory(
          "Post-commit commit advisory recovery",
          baseCwd,
          "repo-root-unresolved",
          "PreToolUse 與 PostToolUse 皆無法解析 commit 目標 repo，EOF／版號防線未執行。",
          REPO_UNRESOLVED_REMEDY
        ),
      ],
    };
  }

  const parts = [];
  const version = checkPostCommitVersionEquality(repoCwd);
  if (version) parts.push(version);
  const eof = checkPostCommitEofDetection(repoCwd);
  if (eof) parts.push(eof);

  if (parts.length === 0) return null;
  return { advisories: parts };
}

export function extractCommitHashHintFromOutput(output) {
  const text = String(output || "");
  const bracket = /\[[^\]]+\s+([0-9a-f]{7,40})\]/i.exec(text);
  if (bracket) return bracket[1];
  const create = /\[(?:new branch|.*?)\s+([0-9a-f]{7,40})\]/i.exec(text);
  if (create) return create[1];
  const loose = /\b([0-9a-f]{7,40})\b/i.exec(text);
  return loose ? loose[1] : "";
}
