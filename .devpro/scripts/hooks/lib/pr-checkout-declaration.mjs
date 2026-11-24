// A command-local `DEVPRO_PR_CHECKOUT=<absolute path>` in the environment prefix of a gh command names the PR's
// local checkout when the session cwd is elsewhere: gh has no `-C`, and some hosts have no workdir parameter (#3556).
// Every gate that honors the declaration reads it through this module, so the parse and its fail-closed errors stay
// identical across pre-tool-gate, post-tool-gate and the GitHub footer gate (#3647).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { normalizeGitBashDrivePath } from "./git-utils.mjs";
import {
  CMD_BOUNDARY,
  ENV_ASSIGNMENT_SOURCE,
  findTopLevelSeparator,
  ghPrVerbSource,
  isMatchInCommandSegment,
  prefixAssignments,
  scopeIdAt,
  segmentCommand,
} from "./shell-context.mjs";

export const UNREAD_CHECKOUT_PREFIX =
  "cannot read the assignment prefix of this gh command; put any required assignments on the gh command using literal values and write DEVPRO_PR_CHECKOUT as a literal absolute path when needed";

const ASSIGNMENT_START = new RegExp(`${CMD_BOUNDARY}(?<assignment>(?:env\\s+)?[A-Za-z_](?:\\w|\\\\\\r?\\n)*=)`, "gd");
const BOUNDARY_ONLY = new RegExp(`^${CMD_BOUNDARY}$`);
const GH_EXECUTABLE_DIRECTORY = /(?:^|(?<=\s))[^\s;|&({'"`]*\/$/;
const ASSIGNMENTS = `(?:${ENV_ASSIGNMENT_SOURCE})*`;
const OTHER_COMMAND = new RegExp(`^(${ASSIGNMENTS}(?:env\\s+${ASSIGNMENTS})?)(?!env(?:\\s|$))[-./\\w]+(?:\\s|$)`);
const PR_CANDIDATE = new RegExp(`(?:^|\\s)(?<bin>[^\\s;|&({'"\\x60]*\\/)?(?<gh>${ghPrVerbSource("merge|create")})\\b`, "gd");

function escapedLineBoundary(cmd, index) {
  if (cmd[index] !== "\n" && cmd[index] !== "\r") return false;
  const end = cmd[index - 1] === "\r" ? index - 1 : index;
  let start = end;
  while (cmd[start - 1] === "\\") start--;
  return (end - start) % 2 === 1;
}

// Recognize a PR command after an unreadable leading assignment when the command-position grammar cannot.
// A quoted gh token or one that follows a readable command head such as "printf" is data.
export function unreadPrCheckoutPrefix(cmd, verb) {
  const prefixes = [...cmd.matchAll(ASSIGNMENT_START)];
  if (!prefixes.length) return false;
  const segments = segmentCommand(cmd);
  const starts = prefixes
    .filter((match) => !escapedLineBoundary(cmd, match.index))
    .map((match) => match.indices.groups.assignment[0])
    .filter((index) => isMatchInCommandSegment(index, segments));
  if (!starts.length) return false;
  const assignmentByScope = new Map();
  let next = 0;
  for (const match of cmd.matchAll(PR_CANDIDATE)) {
    if (!match.groups.gh.endsWith(verb)) continue;
    const [index] = match.indices.groups.gh;
    if (!isMatchInCommandSegment(index, segments)) continue;
    while (next < starts.length && starts[next] < match.index) {
      const start = starts[next++];
      assignmentByScope.set(scopeIdAt(start, segments), start);
    }
    const start = assignmentByScope.get(scopeIdAt(index, segments));
    if (start === undefined) continue;
    const prefix = cmd.slice(start, match.index).replace(/^env\s+/, "");
    const unread = prefixAssignments(prefix.trimEnd()).rest.trim();
    const otherCommand = OTHER_COMMAND.exec(prefix);
    // The shared word grammar can stop at a nested parameter quote or a case arm's closing parenthesis. Neither
    // proves that the next word is an executable when the expansion still extends to the gh prefix.
    const closesSubstitution = /[)`]$/.test(unread);
    const parsedHeadMayBeInsideValue = otherCommand
      && (/\$\{[^}]*$/.test(otherCommand[1]) || (closesSubstitution && /\$\(/.test(otherCommand[1])));
    if (!unread || (otherCommand && !parsedHeadMayBeInsideValue)) continue;
    // A preceding shell step is diagnosed by the standalone gate. A closing substitution before gh can contain
    // separators of its own (for example a case arm); those cannot prove there was a preceding shell step.
    if (!closesSubstitution && findTopLevelSeparator(prefix, 0) < prefix.length) continue;
    return true;
  }
  return false;
}

// The value is one shell word: quoted parts, backslash-escaped characters (an escaped space included) and plain text,
// read the way the shell reads it, so a double-quoted and a backslash-escaped path name the same checkout (PR #3703 r5 F3).
// The declarations are the assignments the shared prefix parser reads in front of the command: an empty value counts
// toward a repeated declaration (PR #3703 r9 W2-F2), and declaration-like text inside another assignment's quoted value
// does not (PR #3703 r10 W2-F2).

// The text the shell gives one word: a backslash outside quotes keeps the next character, single quotes keep everything,
// and inside double quotes a backslash escapes only `"`, `\`, `$` and a backtick.
export function shellWordValue(word) {
  let out = "";
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (c === "\\") { out += word[i + 1] ?? ""; i++; continue; }
    if (c === "'") {
      // An unmatched quote keeps the rest of the word (PR #3703 r8 W1-F3); the declaration regex never passes one.
      const end = word.indexOf("'", i + 1);
      if (end < 0) { out += word.slice(i + 1); break; }
      out += word.slice(i + 1, end);
      i = end;
      continue;
    }
    if (c === '"') {
      for (i++; i < word.length && word[i] !== '"'; i++) {
        if (word[i] === "\\" && /["\\$`]/.test(word[i + 1] ?? "")) { out += word[i + 1]; i++; } else out += word[i];
      }
      continue;
    }
    out += c;
  }
  return out;
}

// The hook decides before the shell expands `$VAR`, `${VAR}`, `$(...)` or backticks, so it cannot read a value
// written that way. Single-quoted text stays literal in the shell, so it does not count (#3556).
export function isShellExpandedToken(token) {
  return typeof token === "string" && /[$`]/.test(token.replace(/'[^']*'/g, ""));
}

// Reads the declaration in `cmd.slice(prefixStart, verbIndex)`, the environment prefix of one gh command. Returns
// null when the prefix is absent, { cwd } for a literal absolute path to a git checkout, and { error } otherwise.
export function declaredPrCheckout(cmd, prefixStart, verbIndex) {
  const prefix = cmd.slice(prefixStart, verbIndex).replace(GH_EXECUTABLE_DIRECTORY, "");
  const inner = prefixAssignments(prefix);
  // A supported env prefix can itself have command-local assignments before it.
  const env = /(?:^|(?<=[\s;|&(`{]))env\s+$/.exec(inner.rest);
  const outer = env ? prefixAssignments(inner.rest.slice(0, env.index)) : { assignments: [], rest: inner.rest };
  if (!BOUNDARY_ONLY.test(outer.rest)) return { error: UNREAD_CHECKOUT_PREFIX };
  const matches = [...outer.assignments, ...inner.assignments].filter(({ name }) => name === "DEVPRO_PR_CHECKOUT");
  if (!matches.length) return null;
  // The shell keeps the last of repeated assignments, so a prefix that repeats the declaration names no one checkout
  // the hook can read (PR #3703 r7 W1-F1).
  if (matches.length > 1) {
    return { error: "DEVPRO_PR_CHECKOUT is assigned more than once in front of this gh command; the shell keeps the last value, so write it once" };
  }
  const [{ word }] = matches;
  const value = shellWordValue(word);
  if (isShellExpandedToken(word) || !path.isAbsolute(value)) {
    return { error: "DEVPRO_PR_CHECKOUT must be a literal absolute path to the PR's local checkout; the hook decides before the shell expands it" };
  }
  const cwd = normalizeGitBashDrivePath(value);
  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (root.error || root.status !== 0) return { error: `DEVPRO_PR_CHECKOUT ${value} is not a git checkout` };
  return { cwd };
}
