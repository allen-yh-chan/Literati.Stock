import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { probeGitCommonDir } from "./repo-state-identity.mjs";
import { GIT_GLOBAL_OPT, LOOSE_CMD_PREFIX, maskDataRegions, segmentCommand } from "./shell-context.mjs";

export const UNRESOLVABLE_CWD = "\0UNRESOLVABLE_CWD";

/**
 * Git Bash / MSYS POSIX drive path → Windows path (`/c/Users/x` → `C:\Users\x`).
 * Other forms are returned unchanged. Mapping is host-independent so tests can
 * lock the transform without a win32 runner.
 */
export function mapMsysDrivePath(p) {
  if (typeof p !== "string" || p === "") return p;
  const match = /^\/([A-Za-z])(\/.*)?$/.exec(p);
  if (!match) return p;
  const rest = (match[2] || "").replace(/\//g, path.win32.sep);
  return `${match[1].toUpperCase()}:${rest || path.win32.sep}`;
}

export function resolveHostFilesystemPath(p) {
  if (typeof p !== "string" || p === "") return p;
  try {
    if (existsSync(p) && statSync(p).isDirectory()) return p;
  } catch {
    /* try mapped form */
  }
  // `/c/...` is a Git-Bash spelling only on native Win32. On POSIX it is a
  // legitimate absolute path (and a test fixture may even create it), so
  // never reinterpret it as a Windows drive path at the shared resolver.
  const mapped = process.platform === "win32" ? mapMsysDrivePath(p) : p;
  if (mapped !== p) {
    try {
      if (existsSync(mapped) && statSync(mapped).isDirectory()) return mapped;
    } catch {
      return mapped;
    }
  }
  return p;
}

export function resolveSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    try {
      return path.join(realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return path.resolve(p);
    }
  }
}

export function shellTokenValue(token) {
  if (!token) return "";
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

// NOTE: no live caller after the cwd-provenance refactor — the cwd resolver uses
// `resolveToolInputCwd()` / `hasLegacyPayloadCwd()`. Kept as a generic helper; do
// not rebuild a second cwd alias scan on top of it.
export function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

// The probe and its per-process memo now live in ./repo-state-identity.mjs as
// the single shared common-dir probe (this used to carry its own duplicate
// cache; spawn census that motivated memoizing here: 729 of these across 252
// pre-tool-gate runs, 2.9x per process, identical answer, each a real
// fork+exec). Only the memo is shared — this call site keeps its own fail-open
// disposition of returning "" (SC3/R4), and its own resolveSafe post-processing
// so a symlinked or not-yet-existing path still yields a usable answer.
export function gitCommonDir(cwd) {
  try {
    const { commonDir } = probeGitCommonDir(resolveSafe(cwd));
    return commonDir ? resolveSafe(commonDir) : "";
  } catch {
    return "";
  }
}

function environmentPwdCwd() {
  const rawPwd = process.env.PWD;
  if (typeof rawPwd !== "string" || !rawPwd.trim()) return "";

  const rawCwd = rawPwd.trim();
  if (!path.isAbsolute(rawCwd)) return "";

  const cwd = resolveHostFilesystemPath(resolveSafe(rawCwd));
  if (!existsSync(cwd)) return "";

  const hookCommonDir = gitCommonDir(process.cwd());
  const pwdCommonDir = gitCommonDir(cwd);
  if (!hookCommonDir || hookCommonDir !== pwdCommonDir) return "";

  return cwd;
}

// Field-alias tables for the ONE shared cwd scan (design D1). Names are also
// the provenance tokens reported by `resolveToolInputCwd()`; keeping them here
// means the reported source and the value actually used cannot drift apart.
const TOOL_INPUT_CWD_FIELDS = ["cwd", "workdir", "working_dir", "workingDir"];
const TOOL_INPUT_WORKING_DIRECTORY_FIELDS = ["working_directory", "workingDirectory"];
const PAYLOAD_CWD_FIELDS = ["cwd", "workdir", "working_dir", "workingDir"];
const PAYLOAD_WORKING_DIRECTORY_FIELDS = ["working_directory", "workingDirectory"];
const PAYLOAD_CURRENT_CWD_FIELDS = ["current_working_directory", "currentWorkingDirectory"];

const CWD_FALLBACK_SOURCES = Object.freeze(["env.PWD", "process.cwd()"]);

/** True when `source` is a fallback token rather than a payload field name. */
export function isFallbackCwdSource(source) {
  return CWD_FALLBACK_SOURCES.includes(source);
}

function declaredCwdField(fields, container, prefix = "") {
  if (!container || typeof container !== "object") return null;
  for (const field of fields) {
    const value = container[field];
    if (typeof value === "string" && value.trim()) {
      return { value, key: `${prefix}${field}` };
    }
  }
  return null;
}

/**
 * Shared alias scan for tool／payload cwd fields (same key order as before the
 * provenance refactor). Returns `{ value, key }` — `key` is the provenance token
 * reported by `resolveToolInputCwd()` (`tool_input.<field>` for tool-input
 * fields, the bare `<field>` for top-level payload fields).
 * When `includeWorkingDirectory` is true, also reads `working_directory`／
 * `workingDirectory` (execution／hook-visible only — design D2).
 */
function declaredToolInputCwd(toolInput = {}, payload = {}, { includeWorkingDirectory = true } = {}) {
  return (
    declaredCwdField(TOOL_INPUT_CWD_FIELDS, toolInput, "tool_input.") ||
    (includeWorkingDirectory
      ? declaredCwdField(TOOL_INPUT_WORKING_DIRECTORY_FIELDS, toolInput, "tool_input.")
      : null) ||
    declaredCwdField(PAYLOAD_CWD_FIELDS, payload) ||
    (includeWorkingDirectory
      ? declaredCwdField(PAYLOAD_WORKING_DIRECTORY_FIELDS, payload)
      : null) ||
    declaredCwdField(PAYLOAD_CURRENT_CWD_FIELDS, payload) || { value: "", key: "" }
  );
}

/**
 * Resolve the base cwd AND its provenance from the same scan (design D1).
 * `cwd` is byte-identical to the historical `toolInputCwd()` return value;
 * `source` names the payload field that supplied it, or the fallback layer that
 * actually ran (`env.PWD` / `process.cwd()`).
 */
export function resolveToolInputCwd(
  toolInput = {},
  payload = {},
  { includeWorkingDirectory = true } = {}
) {
  const declared = declaredToolInputCwd(toolInput, payload, { includeWorkingDirectory });
  // Only probe the git-common-dir when no payload field supplied the cwd: the
  // probe spawns `git rev-parse` and this helper is on a hot path.
  const fallbackCwd = declared.value ? "" : environmentPwdCwd();
  const source = declared.value
    ? declared.key
    : fallbackCwd
      ? "env.PWD"
      : "process.cwd()";
  return {
    cwd: resolveHostFilesystemPath(declared.value || fallbackCwd || process.cwd()),
    source,
  };
}

export function toolInputCwd(toolInput = {}, payload = {}) {
  // `working_directory` / `workingDirectory` improve Task／hook-visible
  // **execution** cwd visibility. They are NOT binding authority — Cursor
  // admission binding still requires cwd-under-worktree or a verified
  // changeId → exact-one discovery (design D2). Use `toolInputBindingCwd`
  // for admission／spawn-context cwd.
  return resolveToolInputCwd(toolInput, payload, { includeWorkingDirectory: true }).cwd;
}

/**
 * Admission／binding-safe cwd: same alias list as `toolInputCwd` EXCEPT
 * `working_directory`／`workingDirectory` are omitted from both toolInput and
 * payload. Those fields are execution／hook-visible only (adapter §5b / D2) and
 * MUST NOT feed `evaluateAgentDispatch`／the shared `resolveAdmissionBinding`
 * rank-1 cwd-under-worktree binding.
 */
export function toolInputBindingCwd(toolInput = {}, payload = {}) {
  return resolveToolInputCwd(toolInput, payload, { includeWorkingDirectory: false }).cwd;
}

/**
 * True when the LEGACY payload cwd evidence set supplied a value (the ten keys
 * `origin/main` used: `tool_input.{cwd,workdir,working_dir,workingDir}`,
 * top-level `{cwd,workdir,working_dir,workingDir}` and
 * `{current_working_directory,currentWorkingDirectory}`).
 *
 * `working_directory` / `workingDirectory` are execution-cwd aliases that were
 * never protected-branch evidence. Callers that decide "payload supplied a cwd
 * vs. fell back to the hook process" MUST use this predicate so that adding those
 * aliases to the resolver cannot silently tighten or loosen an authorization
 * gate. Same alias tables as the shared scan — no second field list.
 */
export function hasLegacyPayloadCwd(toolInput = {}, payload = {}) {
  const declared = declaredToolInputCwd(toolInput, payload, { includeWorkingDirectory: false });
  return Boolean(declared.value);
}

function safeSegmentCommand(cmd) {
  try {
    return segmentCommand(cmd);
  } catch {
    return null;
  }
}

function unsafeLeadingCdTarget(rawToken) {
  const token = shellTokenValue(rawToken || "").trim();
  if (!token || token === "-") return true;
  const windowsPath = process.platform === "win32";
  return /[$`]/.test(rawToken || "") || /[$`]/.test(token) ||
    (!windowsPath && /\\/.test(rawToken || "")) ||
    (!windowsPath && /\\/.test(token)) || token.startsWith("~");
}

function unsafeCdTargetToken(rawToken) {
  if (unsafeLeadingCdTarget(rawToken)) return true;
  const token = shellTokenValue(rawToken || "").trim();
  if (token.startsWith("-")) return true;
  return /[*?[\]{}]/.test(token);
}

const SHELL_CONTROL_KEYWORDS_RE =
  /(?:^|[\s;])(?:if|then|elif|else|fi|for|while|until|do|done|case|esac|select|function|time|coproc)(?:$|[\s;(])/;
const CHDIR_PREFIX = `(?:(?:builtin|command)\\s+)?\\\\?`;
const CHDIR_VERBS = [
  { kind: "popd", verbRe: new RegExp(`^${CHDIR_PREFIX}popd(?:\\s|$)`) },
  { kind: "pushd", verbRe: new RegExp(`^${CHDIR_PREFIX}pushd(?:\\s|$)`) },
  { kind: "cd", verbRe: new RegExp(`^${CHDIR_PREFIX}cd(?:\\s|$)`) },
];
const CHDIR_VERB_STRIP_RE = new RegExp(`^${CHDIR_PREFIX}(?:cd|pushd|popd)\\s*`);
const ANY_CHDIR_AT_BOUNDARY_RE =
  new RegExp(`(?:^|[\\s;&|(\`])${CHDIR_PREFIX}(?:cd|pushd|popd)(?:\\s|$)`);

function classifyChdirStatement(codeHead) {
  for (const verb of CHDIR_VERBS) {
    if (verb.verbRe.test(codeHead)) return verb.kind;
  }
  return null;
}

// Opt-in (R15) rewrite of `code` ahead of the `[|&]` ambiguity check. Returns
// null when control flow still decides the cwd (`||`, a background `&`, a
// chdir verb inside a pipeline), else same-length text in which fd redirects
// are blanked and each pipeline `|` is a statement separator `;`. A pipe continues over the newlines that follow it
// (blank lines, comment-only lines, which are already blanked as data, and backslash continuations): the next line
// is still an element of the pipeline, so those newlines are blanked before the statements are split.
function toleratePipesAndRedirects(code) {
  const text = code
    .replace(/\|&/g, "| ")
    .replace(/\|(?:[ \t]*\\?\n)+/g, (run) => `|${" ".repeat(run.length - 1)}`)
    .replace(/\d*>&\d*-?/g, (m) => " ".repeat(m.length))
    .replace(/\d*<&\d*-?/g, (m) => " ".repeat(m.length))
    .replace(/&>>?/g, (m) => " ".repeat(m.length));
  const withoutAndAnd = text.replace(/&&/g, "  ");
  if (/\|\||&/.test(withoutAndAnd)) return null;
  if (!withoutAndAnd.includes("|")) return text;
  // A pipeline binds tighter than `&&`/`;`: judge elements per statement so a
  // flat `cd X &&` before the pipeline is not mistaken for a piped chdir.
  for (const statement of text.split(/&&|[;\n]+/)) {
    if (!statement.includes("|")) continue;
    if (statement.split("|").some((element) => ANY_CHDIR_AT_BOUNDARY_RE.test(element))) return null;
  }
  return text.replace(/\|/g, ";");
}

function effectiveCdCwd(command, baseCwd, beforeIndex = command.toString().length, evidence = null) {
  const cmd = command.toString();
  const limit = Math.max(0, Math.min(beforeIndex, cmd.length));
  const segs = safeSegmentCommand(cmd);
  let code = maskDataRegions(cmd, segs, limit);

  const cdNeutralized = code.replace(/&&/g, " ");
  const cdPresent = ANY_CHDIR_AT_BOUNDARY_RE.test(cdNeutralized);
  const ambiguous = () => {
    if (cdPresent && evidence) evidence.explicitChdir = true;
    return cdPresent ? UNRESOLVABLE_CWD : "";
  };
  // Opt-in (followLeadingSubshell): a command that opens with one ( … ) subshell holding the target, with no
  // other grouping before the target, runs that subshell's statements in order, so they are simulated as if
  // flat. Blanking the one "(" keeps every offset; nested, later or closed groups still fall to ambiguous below.
  let leadingSubshellOpen = -1;
  if (evidence?.followLeadingSubshell) {
    const opened = /^\s*\(/.exec(code);
    if (opened && !/[(){}`]/.test(code.slice(opened[0].length))) {
      leadingSubshellOpen = opened[0].length - 1;
      code = `${code.slice(0, leadingSubshellOpen)} ${code.slice(leadingSubshellOpen + 1)}`;
    }
  }
  if (/[(){}`]/.test(code)) return ambiguous();
  if (/\$\(/.test(code)) return ambiguous();
  if (SHELL_CONTROL_KEYWORDS_RE.test(code)) return ambiguous();
  if (/(?:^|[\s;])CDPATH=/.test(code)) return ambiguous();

  if (evidence?.tolerateRedirectsAndPipes) {
    const tolerated = toleratePipesAndRedirects(code);
    if (tolerated === null) return ambiguous();
    code = tolerated;
  }

  // Statement-boundary first (newline / `;`): within a statement, `&&` chains
  // may track cd/pushd/popd. Only pipes / bare `&` (and other control forms
  // above) stay UNRESOLVABLE — do NOT treat newline+`&&` mix as ambiguous.
  const withoutAndAnd = code.replace(/&&/g, "  ");
  if (/[|&]/.test(withoutAndAnd)) return ambiguous();

  const original = leadingSubshellOpen < 0
    ? cmd.slice(0, limit)
    : `${cmd.slice(0, leadingSubshellOpen)} ${cmd.slice(leadingSubshellOpen + 1, limit)}`;
  let running = baseCwd;
  let cursor = 0;
  const dirStack = [];
  // `baseIndependent`: the simulated cwd no longer depends on `baseCwd` because an absolute cd/pushd target
  // replaced it; relative targets keep whatever the previous statement established, and popd restores it with the
  // directory. Reported through `evidence.baseIndependent` so a caller can tell a cd that pins the cwd from one that
  // merely resolves against a guessed base.
  let baseIndependent = false;
  const independentStack = [];
  // Split on statement separators and on `&&` so statement-internal chdir
  // chains still update `running` left-to-right.
  const separators = /&&|[;\n]+/g;
  const applyStatement = (start, end) => {
    const codeStatement = code.slice(start, end).trim();
    if (!codeStatement) return "neutral";
    const originalStatement = original.slice(start, end).trim();
    const afterAssignments = originalStatement.replace(
      /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/,
      ""
    );
    const codeHead = codeStatement.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
    const kind = classifyChdirStatement(codeHead);
    if (kind === null) return "neutral";
    if (evidence) evidence.explicitChdir = true;
    const afterVerb = afterAssignments.replace(CHDIR_VERB_STRIP_RE, "");
    const operand = afterVerb.match(/^("[^"]+"|'[^']+'|\S+)/);
    const isRotation = operand && /^[+-]\d+$/.test(shellTokenValue(operand[1]));
    if (kind === "popd") {
      if (isRotation || dirStack.length === 0) return "fail";
      running = dirStack.pop();
      baseIndependent = independentStack.pop();
      return "ok";
    }
    if (!operand || isRotation || unsafeCdTargetToken(operand[1])) return "fail";
    const target = shellTokenValue(operand[1]);
    if (kind === "pushd") {
      dirStack.push(running);
      independentStack.push(baseIndependent);
    }
    if (path.isAbsolute(target)) baseIndependent = true;
    running = resolveHostFilesystemPath(
      path.isAbsolute(target) ? target : path.resolve(running, target)
    );
    if (evidence?.requireResolvedChdir) {
      try {
        if (!existsSync(running) || !statSync(running).isDirectory()) return "fail";
      } catch {
        return "fail";
      }
    }
    return "ok";
  };
  const applyRange = (start, end) =>
    applyStatement(start, end) === "fail" ? UNRESOLVABLE_CWD : null;

  let separator;
  while ((separator = separators.exec(code)) !== null) {
    const result = applyRange(cursor, separator.index);
    if (result) return result;
    cursor = separator.index + separator[0].length;
  }
  const lastResult = applyRange(cursor, code.length);
  if (lastResult) return lastResult;
  if (evidence) evidence.baseIndependent = baseIndependent;
  running = resolveHostFilesystemPath(running);
  const resolvedBase = resolveHostFilesystemPath(baseCwd);
  if (running === baseCwd || running === resolvedBase) return "";
  try {
    if (!existsSync(running) || !statSync(running).isDirectory()) return UNRESOLVABLE_CWD;
  } catch {
    return UNRESOLVABLE_CWD;
  }
  return running;
}

export function commandCwdAt(
  command,
  baseCwd,
  commandIndex,
  executable = "",
  { requireExplicitChdir = false, tolerateRedirectsAndPipes = false, followLeadingSubshell = false } = {}
) {
  const cmd = command.toString();
  const beforeIndex = Number.isInteger(commandIndex) ? commandIndex : cmd.length;
  const evidence = {
    explicitChdir: false,
    requireResolvedChdir: requireExplicitChdir,
    tolerateRedirectsAndPipes,
    followLeadingSubshell,
  };
  const simulated = effectiveCdCwd(cmd, baseCwd, beforeIndex, evidence);
  if (simulated === UNRESOLVABLE_CWD) return UNRESOLVABLE_CWD;
  if (requireExplicitChdir && !evidence.explicitChdir) return UNRESOLVABLE_CWD;
  const runningCwd = simulated || baseCwd;
  if (executable !== "git") return runningCwd;

  const invocation = cmd.slice(beforeIndex).match(
    new RegExp(`^(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*(?:\\S*\\/)?git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*`)
  )?.[0] || "";
  return cwdFromGitMatch(invocation, runningCwd);
}

export function commandCwd(command, baseCwd) {
  const cmd = command.toString();
  const match = cmd.match(
    new RegExp(
      `${LOOSE_CMD_PREFIX}(git|gh)\\s+(?:${GIT_GLOBAL_OPT}\\s+)*`,
      "d"
    )
  );
  if (!match) return commandCwdAt(cmd, baseCwd, cmd.length);
  // Capture indices identify the executable token itself. String search is unsafe:
  // a later `-C` path can also contain the text "git" or "gh".
  const commandIndex = match.indices[1][0];
  return commandCwdAt(cmd, baseCwd, commandIndex, match[1]);
}

function cwdFromGitMatch(matchText, baseCwd) {
  const cMatches = [...matchText.matchAll(/-C\s+("[^"]+"|'[^']+'|\S+)/g)];
  if (cMatches.length === 0) return baseCwd;
  const target = shellTokenValue(cMatches[cMatches.length - 1]?.[1]);
  const resolved = path.isAbsolute(target) ? target : path.resolve(baseCwd, target);
  return resolveHostFilesystemPath(resolved);
}

// `-C <dir>` changes the directory only as a git GLOBAL option, between `git` and the verb. After the verb the
// same letter belongs to the verb (`switch -C <branch>`, `commit -C <commit>`, `branch -C <old> <new>`). When
// the caller passes the index of its `git` token, the scan reads only the global-option run that starts there —
// the same token the caller matched, so a `git` inside an environment value cannot stand in for it. Without that
// index the whole match text is scanned, as before.
const GIT_GLOBAL_OPTION_RUN_AT_TOKEN_RE = new RegExp(`^git\\s+((?:${GIT_GLOBAL_OPT}(?:\\s+|$))*)`);

function gitGlobalOptionText(text, matchText, matchIndex) {
  if (Number.isInteger(matchIndex) && matchIndex >= 0) {
    const run = GIT_GLOBAL_OPTION_RUN_AT_TOKEN_RE.exec(text.slice(matchIndex));
    if (run) return run[1];
  }
  return matchText;
}

export function commandCwdForGitMatch(cmd, matchText, baseCwd, matchIndex = -1, evidence = null) {
  const text = cmd.toString();
  const beforeIndex = Number.isInteger(matchIndex) && matchIndex >= 0
    ? matchIndex
    : text.indexOf(matchText);
  const simulated = effectiveCdCwd(text, baseCwd, beforeIndex >= 0 ? beforeIndex : text.length, evidence);
  if (simulated === UNRESOLVABLE_CWD) return UNRESOLVABLE_CWD;
  const runningCwd = resolveHostFilesystemPath(simulated || baseCwd);
  if (/--git-dir\b|--work-tree\b/.test(matchText)) return UNRESOLVABLE_CWD;
  if (/(?:^|[\s;|&(])(?:GIT_DIR|GIT_WORK_TREE)=/.test(matchText)) return UNRESOLVABLE_CWD;

  const cMatches = [...gitGlobalOptionText(text, matchText, matchIndex).matchAll(/(?:^|\s)-C\s+("[^"]+"|'[^']+'|\S+)/g)];
  if (cMatches.length === 0) return runningCwd;
  let resolved = runningCwd;
  for (const match of cMatches) {
    const token = match[1];
    if (unsafeCdTargetToken(token)) return UNRESOLVABLE_CWD;
    const target = shellTokenValue(token);
    resolved = resolveHostFilesystemPath(
      path.isAbsolute(target) ? target : path.resolve(resolved, target)
    );
  }
  try {
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return UNRESOLVABLE_CWD;
  } catch {
    return UNRESOLVABLE_CWD;
  }
  return resolved;
}
