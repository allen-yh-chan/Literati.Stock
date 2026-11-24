#!/usr/bin/env node
/**
 * post-tool-gate.mjs — PostToolUse hook
 *
 * Gate D' (T11) sentinel writer + post-PR completion marker:
 *   After `git worktree add <abs-path>` succeeds (PostToolUse, exit 0),
 *   write a pending-cd-to-worktree-<basename> sentinel so the next
 *   Bash invocation (PreToolUse in pre-tool-gate.mjs) can warn if the
 *   AI did not cd into the newly created worktree.
 *   After `gh pr create` succeeds, write a soft pending marker read by
 *   post-pr-completion-check.mjs Stop hook.
 *
 * Sentinel lifecycle:
 *   Written here:   PostToolUse after successful git worktree add
 *   Read & cleared: pre-tool-gate.mjs Gate D' check on next PreToolUse Bash
 *   TTL cleared:    session-start.mjs + Gate D' scan (1 day TTL)
 *
 * Output: empty stdout, exit 0 (PostToolUse hooks don't block tool execution).
 *
 * Bypass: inline Bash env-prefix DEVPRO_HOOK_BYPASS=1
 */

import { readStdin } from "./lib/stdin.mjs";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  writePendingCdSentinel,
  extractWorktreeAddPath,
  recapMergedPr,
  readRecapBodyFromCommand,
  recapChangeNameFromCanonicalTitle,
  recapTitleFromCommand,
  declaredPrCreateCheckout,
} from "./pre-tool-gate.mjs";
import { resolveReminderSession, recordReminderDiagnostic } from "./lib/session-reminder.mjs";
import { recapRepositoryFromPrUrl, recordRecapWork, resolveRecapDiscussionIdentity, writeRecapWrittenMarkerForChange } from "./lib/recap-utils.mjs";
import { segmentCommand, isMatchInCommandSegment, GIT_GLOBAL_OPT, LOOSE_CMD_PREFIX, ghPrVerbSource } from "./lib/shell-context.mjs";
import { hasInlineHookBypass } from "./lib/hook-bypass.mjs";
import { resolveGithubRepoIdentity, storedOriginIdentity } from "./lib/git-utils.mjs";
import { repoKey } from "./lib/repo-key.mjs";
import {
  extractPrNumberFromCreateOutput,
  writePostPrCompletionMarker,
} from "./lib/post-pr-completion-state.mjs";
import {
  isShellCommandToolName,
} from "./lib/rule-load-session-ledger.mjs";
import {
  extractCommitHashHintFromOutput,
  isSuccessfulGitCommitCommand,
  runPostCommitCommitAdvisories,
  resolvePostCommitRepoCwd,
} from "./lib/post-commit-advisory.mjs";

function toolInputCwd(toolInput = {}, payload = {}) {
  return (
    toolInput.cwd ||
    toolInput.workdir ||
    toolInput.working_dir ||
    toolInput.workingDirectory ||
    payload.cwd ||
    payload.workdir ||
    payload.working_dir ||
    payload.workingDirectory ||
    payload.current_working_directory ||
    payload.currentWorkingDirectory ||
    process.cwd()
  );
}

/**
 * commandCwd (local copy) — extract effective cwd from `cd <abs> &&` prefix.
 * We can't import the original commandCwd easily without circular dep concerns,
 * so replicate the `cd` extraction logic (the git -C case doesn't apply here
 * since we only care about where the worktree is created, not git -C).
 */
function shellTokenValue(token) {
  if (!token) return "";
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

function commandEffectiveCwd(command, baseCwd) {
  const cmd = command.toString();
  // Leading cd <abs> && or cd <abs>;
  const cdMatch = cmd.match(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)/);
  if (cdMatch) {
    const target = shellTokenValue(cdMatch[1]);
    return path.isAbsolute(target) ? target : path.resolve(baseCwd, target);
  }
  return baseCwd;
}

function isGhPrCreateCommand(cmd) { return isGhPrVerbCommand(cmd, 'create'); }

function isGhPrVerbCommand(cmd, verb) {
  // ghPrVerbSource admits a --repo/-R before `pr` or the verb (fix-pre-verb-repo-flag-gates).
  const re = new RegExp(`${LOOSE_CMD_PREFIX}${ghPrVerbSource(verb)}\\b`, 'g');
  const matches = [...cmd.matchAll(re)];
  if (matches.length === 0) return false;
  // EVERY `gh pr create` occurrence must be evaluated, not just the first
  // (cross-model finding): a compound `node .../gh-footer-gate.mjs --strict-exit
  // -- gh pr create ... && gh pr create ...` has a dry-run occurrence (after `--`)
  // AND a real one — first-match-only would classify the whole command as
  // gate-validation and miss the real create. A command is a real PR create if
  // ANY occurrence is a genuine create (not gate-validation, in a command segment).
  //
  // Gate self-validation forms are NOT real PR creates: the strict-exit footer
  // gate is invoked as `node .../gh-footer-gate.mjs --strict-exit -- gh pr create
  // ...`, where `gh pr create` after `--` is the COMMAND BEING VALIDATED (a
  // dry-run argument list), not an executed create. An occurrence is gate-validation
  // when the command runs the footer gate (or any `--strict-exit` gate) AND THAT
  // occurrence's `gh` sits after a `--` argument separator (`dashDashPos < ghPos`).
  const hasStrictGate = /gh-footer-gate|--strict-exit/.test(cmd);
  let segs = null;
  try {
    segs = segmentCommand(cmd);
  } catch {
    return true; // parse failure → over-detect (safe: at worst a spurious marker)
  }
  // A `--` separator only neutralizes a `gh pr create` that shares the SAME
  // command run as the gate invocation. The `--` position must be measured per
  // occurrence within the slice of command text BEFORE that occurrence but AFTER
  // the nearest run separator (`&&`, `||`, `;`, `|`, newline) — otherwise a `--`
  // belonging to an earlier dry-run run would wrongly neutralize a later real
  // create in `... -- gh pr create A && gh pr create B` (cross-model finding).
  for (const match of matches) {
    const ghPos = match.index + match[0].indexOf("gh");
    // text of the current run: from the last unconditional separator before
    // ghPos up to ghPos.
    const beforeGh = cmd.slice(0, ghPos);
    const lastSep = Math.max(
      beforeGh.lastIndexOf("&&"),
      beforeGh.lastIndexOf("||"),
      beforeGh.lastIndexOf(";"),
      beforeGh.lastIndexOf("|"),
      beforeGh.lastIndexOf("\n")
    );
    const runText = beforeGh.slice(lastSep + 1);
    const runHasDashDash = /(?:^|\s)--(?:\s|$)/.test(runText);
    const isGateValidation = hasStrictGate && runHasDashDash;
    if (isGateValidation) continue; // this occurrence is a dry-run; check the rest
    if (isMatchInCommandSegment(match.index, segs)) return true; // a real create
  }
  return false;
}

function isGhGraphqlCommand(cmd) {
  const re = /(?:^|[\s;|&(])(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\S*\/)?gh\s+api\s+graphql\b/g;
  const segments = segmentCommand(cmd);
  return [...cmd.matchAll(re)].some((match) => isMatchInCommandSegment(match.index, segments));
}

function toolResponseText(toolResponse = {}) {
  const strings = [];
  const seen = new Set();
  function collect(value, depth = 0) {
    if (depth > 4 || value == null) return;
    if (typeof value === "string") {
      if (!seen.has(value)) {
        seen.add(value);
        strings.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const item of Object.values(value)) collect(item, depth + 1);
    }
  }
  collect(toolResponse);
  return strings.join("\n");
}

export function toolResponseStdout(toolResponse = {}) {
  const strings = [];
  const seen = new Set();
  let found = false;

  function collect(value, depth = 0) {
    if (depth > 4 || value == null) return;
    if (typeof value === "string") {
      if (!seen.has(value)) {
        seen.add(value);
        strings.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const item of Object.values(value)) collect(item, depth + 1);
    }
  }

  function visit(value, depth = 0) {
    if (depth > 4 || value == null || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "stdout" || key === "stdoutText") {
        found = true;
        collect(item);
        continue;
      }
      visit(item, depth + 1);
    }
  }

  visit(toolResponse);
  return { found, text: strings.join("\n") };
}

function normalizeHeadBranch(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withoutQuotes = shellTokenValue(raw);
  const ownerSep = withoutQuotes.indexOf(":");
  return ownerSep === -1 ? withoutQuotes : withoutQuotes.slice(ownerSep + 1);
}

// A `gh pr create -R <other repo>` PR belongs to that repository: name it on the marker so the
// Stop hook looks the PR up there instead of resolving the number against this checkout's repository.
// A PR of the checkout's own repository (or one whose origin is unknown) keeps the unbound "".
function crossRepoPrSlug(url, cwd) {
  const m = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+/i);
  if (!m) return "";
  const own = resolveGithubRepoIdentity(cwd);
  if (!own) return "";
  const host = m[1].toLowerCase();
  const slug = `${m[2]}/${m[3]}`;
  if (host === own.host && slug.toLowerCase() === own.slug) return "";
  return host === "github.com" ? slug : `${host}/${slug}`;
}

function extractGhPrCreateHead(cmd) {
  const match = new RegExp(`${LOOSE_CMD_PREFIX}${ghPrVerbSource("create")}\\b([\\s\\S]*)`).exec(cmd);
  if (!match) return "";
  const tail = match[1] || "";
  const head = tail.match(/(?:^|\s)(?:--head(?:=|\s+)|-H\s+)("[^"]+"|'[^']+'|\S+)/);
  return head ? normalizeHeadBranch(head[1]) : "";
}

function currentBranch(cwd) {
  try {
    return execSync("git branch --show-current", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
  } catch {
    return "";
  }
}

function gitRootForCwd(cwd) {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim() || cwd;
  } catch {
    return cwd;
  }
}

function resolveEditedPath(toolInput = {}, cwd = process.cwd()) {
  const raw = toolInput.file_path || toolInput.filePath || toolInput.path || "";
  if (!raw || typeof raw !== "string") return "";
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

function syntaxCheckArgs(file) {
  const ext = path.extname(file);
  if (ext === ".json") {
    return [
      process.execPath,
      [
        "-e",
        "const fs=require('fs'); JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));",
        file,
      ],
    ];
  }
  if (ext === ".mjs") return [process.execPath, ["--check", file]];
  if (ext === ".py") return ["python3", ["-m", "py_compile", file]];
  if (ext === ".sh") return ["bash", ["-n", file]];
  return null;
}

function runEditTimeSyntaxValidation(file) {
  const check = syntaxCheckArgs(file);
  if (!check) return;
  if (!existsSync(file)) {
    process.stderr.write(`post-tool-gate syntax validation skipped: file not found ${file}\n`);
    return;
  }

  const [cmd, args] = check;
  try {
    execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
  } catch (err) {
    const detail = [err.stderr, err.stdout, err.message]
      .filter((v) => typeof v === "string" && v.trim())
      .join("\n")
      .trim();
    process.stderr.write(
      `post-tool-gate syntax validation failed (fail-open): ${file}` +
        (detail ? `\n${detail}\n` : "\n"),
    );
  }
}

/**
 * Attempt to resolve a shell-expansion worktree path directly from the raw
 * command string, without relying on token-based extraction.
 *
 * `extractWorktreeAddPath` tokenises on whitespace and returns a truncated
 * token like `$(git` when the path contains a subshell expansion. This helper
 * applies a direct regex to the raw `cmd` string to extract the full expansion.
 *
 * Handles (in position after `worktree add [flags]`):
 *   $(git rev-parse --show-toplevel)/<sub>
 *   "$(git rev-parse --show-toplevel)/<sub>"
 *   $(pwd)/<sub>
 *   "$(pwd)/<sub>"
 *
 * Returns the resolved absolute path string, or null if no recognised
 * expansion form is found or exec fails (fail-open: caller uses fallback).
 */
function canonicaliseWorktreePath(token, baseCwd) {
  try {
    // First try: token-based match (works if extractWorktreeAddPath captured the
    // full expansion, e.g. for future-proof single-token forms).
    let m = token.match(/^\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)(\/.*)$/);
    if (m) {
      const root = execSync('git rev-parse --show-toplevel', {
        cwd: baseCwd,
        encoding: 'utf8',
        timeout: 2000,
      }).trim();
      if (root && path.isAbsolute(root)) return root + m[1];
    }
    m = token.match(/^\$\(\s*pwd\s*\)(\/.*)$/);
    if (m) {
      return baseCwd + m[1]; // baseCwd is the effective cwd, equivalent to $(pwd)
    }
  } catch {
    // fall through to fail-open
  }
  return null; // unrecognized form / failed: caller falls back to existing logic
}

/**
 * Extract and canonicalise a shell-expansion worktree path directly from the
 * full raw command string. This is needed because extractWorktreeAddPath
 * tokenises on whitespace and returns a truncated token like `$(git` when the
 * path arg is a multi-word subshell expansion.
 *
 * Returns the resolved absolute path string, or null (caller uses fallback).
 */
function canonicaliseWorktreePathFromCmd(cmd, effectiveCwd) {
  // Pattern: worktree add [flags] "?$(git rev-parse --show-toplevel)/<sub>"?
  // or:      worktree add [flags] "?$(pwd)/<sub>"?
  // Flags we skip: -f, --detach, --lock, --no-lock, --checkout, --no-checkout,
  //   --guess-remote, --track, --orphan, --force, -b/-B <branch>, --reason <str>
  const afterAdd = cmd.match(/\bworktree\s+add\s+([\s\S]*)$/);
  if (!afterAdd) return null;

  const rest = afterAdd[1];

  // Try: $(git rev-parse --show-toplevel)/<sub>
  let m = rest.match(/"?\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)(\/[^"\s]*)"?/);
  if (m) {
    try {
      const root = execSync('git rev-parse --show-toplevel', {
        cwd: effectiveCwd,
        encoding: 'utf8',
        timeout: 2000,
      }).trim();
      if (root && path.isAbsolute(root)) return root + m[1];
    } catch {
      return null; // exec failed: fail-open
    }
  }

  // Try: $(pwd)/<sub>
  m = rest.match(/"?\$\(\s*pwd\s*\)(\/[^"\s]*)"?/);
  if (m) {
    return effectiveCwd + m[1];
  }

  return null;
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    process.exit(0);
  }

  const toolName = payload.tool_name || payload.toolName || "";
  const toolInput = payload.tool_input || payload.toolInput || {};
  // PostToolUse payload also includes tool_response / exit_code
  const toolResponse = payload.tool_response || payload.toolResponse || {};

  const baseCwd = toolInputCwd(toolInput, payload);

  // Check the tool response indicates success (exit 0 / no error in output).
  // Fail-open: when exit code is unavailable, assume success so soft reminder
  // markers are not silently skipped.
  const exitCode = toolResponse.exit_code ?? toolResponse.exitCode;
  const commandSucceeded = !(typeof exitCode === "number" && exitCode !== 0);

  if (["Edit", "Write", "MultiEdit"].includes(toolName)) {
    if (commandSucceeded) runEditTimeSyntaxValidation(resolveEditedPath(toolInput, baseCwd));
    process.exit(0);
  }

  // Shell-command marker handling below. Runtime payloads may report Bash or
  // functions.exec_command for command-running tools.
  if (!isShellCommandToolName(toolName)) process.exit(0);

  const cmd = toolInput.command || toolInput.cmd || "";
  if (!cmd) process.exit(0);
  if (hasInlineHookBypass(cmd)) process.exit(0);

  const effectiveCwd = commandEffectiveCwd(cmd, baseCwd);
  const session = resolveReminderSession(payload);
  const classification = payload.chore_classification || payload.choreClassification || '';

  // Release back-merge binding (openspec enforce-release-back-merge-completion
  // D2): at the end of a shell call that ran `git push`, claim the pre-push
  // ledger entries for this conversation. Deliberately independent of
  // commandSucceeded / exit_code (Codex has none and fires for failed pushes;
  // the Stop gate verifies origin). The substring check only avoids loading the
  // lib on unrelated commands; the segment-aware decision lives in the lib.
  if (/\bgit\b[\s\S]*\bpush\b/.test(cmd)) {
    try {
      const { bindReleaseBackMergeLedger } = await import("./lib/release-back-merge-state.mjs");
      bindReleaseBackMergeLedger({ command: cmd, payload, cwd: effectiveCwd, sessionCwd: baseCwd });
    } catch (err) {
      process.stderr.write(`post-tool-gate release back-merge binding failed (fail-open): ${err.message}\n`);
    }
  }

  if (commandSucceeded && isSuccessfulGitCommitCommand(cmd)) {
    try {
      const commitOutput = toolResponseText(toolResponse);
      const commitHashHint = extractCommitHashHintFromOutput(commitOutput);
      if (commitHashHint && !session) recordReminderDiagnostic({cwd:effectiveCwd,kind:'recap-post-tool-commit',reason:'missing-session-identity'});
      if (commitHashHint && session) {
        const repoCwd = resolvePostCommitRepoCwd(cmd, baseCwd, commitHashHint);
        if (repoCwd) {
          const origin = storedOriginIdentity(repoCwd);
          const repo = origin ? repoKey(origin.host, origin.slug) : '';
          recordRecapWork({ cwd: repo ? baseCwd : repoCwd, classificationCwd: repoCwd, branch: currentBranch(repoCwd), session, commit: commitHashHint, classification, repo });
        }
      }
      const recovered = runPostCommitCommitAdvisories(cmd, baseCwd, { commitHashHint });
      if (recovered?.advisories?.length) {
        for (const advisory of recovered.advisories) {
          process.stderr.write(`post-tool-gate post-commit advisory: ${advisory}\n`);
        }
      }
    } catch (err) {
      process.stderr.write(
        `post-tool-gate post-commit advisory failed (fail-open): ${err.message}\n`,
      );
    }
  }

  if (commandSucceeded && isGhPrCreateCommand(cmd)) {
    const output = toolResponseText(toolResponse);
    const prNumber = extractPrNumberFromCreateOutput(output);
    const url = (output.match(/https?:\/\/\S+\/pull\/\d+\b/) || [""])[0];
    const explicitHead = extractGhPrCreateHead(cmd);
    // A real `gh pr create` success emits the new PR number/url in its output.
    // When BOTH prNumber is empty AND the command carries no explicit `--head`,
    // there is no trackable PR identity — writing a marker keyed on the fallback
    // currentBranch() only produces an empty-prNumber marker that the Stop hook
    // then hard-blocks on, with no PR to cross-review. Skip the write in that case
    // (defense-in-depth alongside the isGhPrCreateCommand gate-validation exclusion).
    if (!prNumber) {
      // no trackable PR — do not write a spurious empty marker
    } else {
      try {
        if (!session) recordReminderDiagnostic({cwd:effectiveCwd,kind:'recap-post-tool-pr-create',reason:'missing-session-identity'});
        // Stop reads the session checkout's state. A declared checkout or a visible cd identifies where the PR
        // originated and where a legacy authority may still live.
        const declared = declaredPrCreateCheckout(cmd);
        writePostPrCompletionMarker({
          cwd: baseCwd,
          worktree: declared?.cwd || effectiveCwd,
          prNumber,
          branch: explicitHead || currentBranch(effectiveCwd),
          url,
          repositorySlug: crossRepoPrSlug(url, baseCwd),
          session,
        });
        const repo = recapRepositoryFromPrUrl(url, prNumber);
        if (url && !repo) process.stderr.write('Recap PR identity: cannot verify the created PR URL. Pending Recap state was kept.\n');
        else recordRecapWork({ cwd: repo ? baseCwd : effectiveCwd, classificationCwd: effectiveCwd, branch: explicitHead || currentBranch(effectiveCwd), session, prNumber, classification, repo });
      } catch (err) {
        process.stderr.write(`post-tool-gate post-pr marker write failed: ${err.message}\n`);
      }
    }
  }

  // Do not clear post-PR completion markers merely because a command/output
  // includes the sticky marker. Freshness requires PR headRefOid comparison,
  // so post-pr-completion-check.mjs performs the self-heal via `gh pr view`.

  // Completion facts require a successful tool result, not an outgoing command.
  if (commandSucceeded && exitCode === 0 && isGhPrVerbCommand(cmd, 'merge')) {
    if (!session) recordReminderDiagnostic({cwd:effectiveCwd,kind:'recap-post-tool-pr-merge',reason:'missing-session-identity'});
    else {
      const identity = recapMergedPr(cmd, effectiveCwd);
      if (identity?.error) process.stderr.write(`Recap PR identity: ${identity.error}. Pending Recap state was kept.\n`);
      else if (identity) recordRecapWork({ cwd: identity.repo ? baseCwd : effectiveCwd, classificationCwd: effectiveCwd, session, ...identity, merged: true, classification });
    }
  }
  if (session && commandSucceeded && isGhGraphqlCommand(cmd)) {
    let result;
    try { result = JSON.parse(toolResponseText(toolResponse)); } catch {}
    const discussion = result?.data?.createDiscussion?.discussion;
    if (!result?.errors?.length && (discussion?.id || discussion?.url)) {
      const title = recapTitleFromCommand(cmd);
      const changeName = recapChangeNameFromCanonicalTitle(title);
      if (changeName) {
        let identity;
        try {
          const body = discussion.body || readRecapBodyFromCommand(cmd, effectiveCwd);
          const titlePr = title.match(/\(PR #(\d+)/)?.[1];
          identity = resolveRecapDiscussionIdentity(body, changeName, {titlePr});
        } catch {
          identity = {error: 'cannot read the Discussion body'};
        }
        if (identity.error) process.stderr.write(`Recap PR identity: ${identity.error}. Pending Recap state was kept.\n`);
        else writeRecapWrittenMarkerForChange(changeName, identity.prNumber, {cwd: identity.repo ? baseCwd : effectiveCwd, session, repo: identity.repo});
      }
    }
  }

  // Check for git worktree add in the command. Use shell-aware filtering so
  // matches inside heredoc bodies / quoted strings / comments are skipped (per
  // spec/pre-tool-mechanical-gates "Bash command parsing within the hook SHALL
  // be shell-aware via lib/shell-context.mjs::segmentCommand"). Fail-safe: if
  // segmentation throws, treat the entire command as a single command segment.
  // `(?:${GIT_GLOBAL_OPT}\s+)*` consumes any leading git global option (not just
  // -C) so `git --no-pager worktree add` is still detected (issue #851/#848
  // round 7 — same generalized grammar as pre-tool-gate.mjs).
  const WORKTREE_ADD_RE = new RegExp(
    `${LOOSE_CMD_PREFIX}git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*worktree\\s+add\\b`
  );
  const wtMatch = WORKTREE_ADD_RE.exec(cmd);
  if (!wtMatch) process.exit(0);
  let segs = null;
  try { segs = segmentCommand(cmd); } catch {}
  if (segs && !isMatchInCommandSegment(wtMatch.index, segs)) process.exit(0);

  if (!commandSucceeded) process.exit(0);

  // Extract the worktree path
  const wtPathArg = extractWorktreeAddPath(cmd);
  if (!wtPathArg) process.exit(0);

  // Resolve the worktree abs path.
  // Try cmd-level canonicalisation first (handles multi-word $(…) expansions
  // that extractWorktreeAddPath cannot reconstruct from whitespace-split tokens),
  // then fall back to token-level canonicalisation, then path.resolve.
  const canonicalFromCmd = canonicaliseWorktreePathFromCmd(cmd, effectiveCwd);
  const canonical = canonicalFromCmd ?? canonicaliseWorktreePath(wtPathArg, effectiveCwd);
  const absWtPath = path.isAbsolute(wtPathArg)
    ? wtPathArg
    : canonical ?? path.resolve(effectiveCwd, wtPathArg);

  // Fail-open: if the resolved path still contains an unresolved shell
  // expansion, it is not a real filesystem path. canonicaliseWorktreePath* only
  // reconstruct `$(git rev-parse …)` and `$(pwd)` command-substitution forms; a
  // plain `$VAR` / `${VAR}` (e.g. the canonical
  // `git worktree add "$REPO_ROOT/.worktree/<name>"` from /devpro:change) survives
  // unresolved, and path.resolve() yields a bogus nested path like
  // `<cwd>/$REPO_ROOT/.worktree/<name>`. Writing a sentinel for that path emits
  // a misleading "未 cd 進入 worktree" advisory on the next Bash call (false
  // positive on a natural AI command). Skip the sentinel; the cwd-drift hint is
  // advisory only, so suppressing it here is safe (mirrors gh-footer-gate not
  // acting on unresolved `$(...)` / `$VAR` body-file paths).
  if (/\$\{?\w|\$\(/.test(absWtPath)) process.exit(0);

  // Fix A: if the SAME chained cmd already contains `cd <absWtPath>` after the
  // worktree add (canonical pattern: `git worktree add /abs/path -b ... && cd
  // /abs/path && ...`), the user has already cd'd into the new worktree; no
  // sentinel needed (otherwise the next Bash invocation gets a stale advisory
  // because its cwd is already the worktree path, not a literal `cd <path>`
  // prefix).
  const escapedPath = absWtPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cdSamePathRe = new RegExp(
    `(?:^|[\\s;|&(])cd\\s+(?:"${escapedPath}"|'${escapedPath}'|${escapedPath})(?:[\\s;|&)]|$)`
  );
  if (cdSamePathRe.test(cmd)) process.exit(0);

  writePendingCdSentinel(absWtPath);
  process.exit(0);
}

// Guard: only invoke main() when this file is the direct entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`post-tool-gate hook error: ${err.message}\n`);
    process.exit(0);
  });
}
