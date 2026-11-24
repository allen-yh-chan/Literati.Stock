/**
 * cross-repo-pr-scope.mjs
 *
 * Single definition of the `DEVPRO_CROSS_REPO_PR` marker and of the target judgement of `gh pr create`, `gh pr edit`
 * and `gh pr comment` (openspec change add-cross-repo-pr-scope-marker, design D1-D5, D8). The cross-repo PR write
 * gate and the consumer pre-PR checks gate both read `crossRepoPrAuthorization`, so one payload cannot be authorized
 * against one repository and judged against another.
 *
 * Design principle (D3): judge only the values the command writes out. This module never models how `gh` picks a
 * repository, a host or a head when the command leaves them out, and it never looks for a checkout on the machine; the
 * only local checkout it uses is the one the command declares with `DEVPRO_PR_CHECKOUT`.
 *
 * This module does not import pre-tool-gate.mjs, which runs its gate on import.
 */

import { spawnSync } from "node:child_process";

import { resolveGithubRepoIdentity } from "./git-utils.mjs";
import { UNRESOLVABLE_CWD, commandCwdAt } from "./hook-command-context.mjs";
import { declaredPrCheckout, isShellExpandedToken } from "./pr-checkout-declaration.mjs";
import {
  CMD_POSITION_ANCHOR,
  GH_PR_REPO_FLAGS_SOURCE,
  anchoredVerbIndex,
  findTopLevelSeparator,
  isMatchInCommandSegment,
  segmentCommand,
} from "./shell-context.mjs";

// ── Shared literals and small parsers (moved here from pre-tool-gate.mjs, behavior unchanged) ─────────────────────

export const PR_URL_SELECTOR_RE = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/;
export const GH_REPO_VALUE_RE = /^(?:([A-Za-z0-9.-]+(?::\d+)?)\/)?([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;
export const GH_ARGUMENT_TOKEN_RE = /(?:[^\s"']|"(?:[^"\\]|\\.)*"|'[^']*')+/g;
// A heredoc operator or a background `&` ends the arguments of a clause (a heredoc body is not on the command line).
export const SHELL_HEREDOC_TOKEN_RE = /^\d*<<(?!<)/;
export const REDIRECT_TOKEN_RE = /^(?:\d*[<>]|&>)/;
// A redirect operator written alone (`>`, `2>`, `>>`, `<`, `&>`): its target is the next token.
export const REDIRECT_OPERATOR_ONLY_RE = /^(?:\d*>>?|\d*<|&>>?)$/;
export const unquoteOnce = (token) => /^(["'])([\s\S]*)\1$/.exec(token)?.[2] ?? token;

// `isShellExpandedToken` is re-exported from `pr-checkout-declaration.mjs` (single parse for every gate, #3647):
// this module owns the marker and target judgement, not the `DEVPRO_PR_CHECKOUT` parse.
export { isShellExpandedToken, declaredPrCheckout };

// The target repository ({ host?, slug }) a literal `[HOST/]OWNER/REPO` value names, or null when it is not literal.
export function parseGhRepoValue(raw) {
  const value = unquoteOnce(String(raw ?? ""));
  if (!value || /[$`]/.test(value)) return null;
  const match = GH_REPO_VALUE_RE.exec(value);
  return match ? { host: match[1]?.toLowerCase(), slug: `${match[2]}/${match[3]}` } : null;
}

// Whether `target` ({ host?, slug }) is the `origin` repository `own` ({ host, slug }, null when unresolvable).
function originMatches(target, own) {
  return Boolean(own) && target.slug.toLowerCase() === own.slug && (!target.host || target.host === own.host);
}

// Whether the repository `target` ({ host?, slug }; null = this checkout) is the `origin` repository of `cwd`.
export function isLocalOriginTarget(target, cwd) {
  if (!target) return true;
  return originMatches(target, resolveGithubRepoIdentity(cwd));
}

// Flags of `gh pr edit` that consume the next token as their value, so a value is not read as the PR selector.
// Source of truth: `gh pr edit --help`.
export const GH_PR_EDIT_VALUE_TAKING_FLAGS = new Set([
  "--add-assignee", "--add-label", "--add-project", "--add-reviewer",
  "--base", "-B",
  "--body", "-b",
  "--body-file", "-F",
  "--milestone", "-m",
  "--remove-assignee", "--remove-label", "--remove-project", "--remove-reviewer",
  "--title", "-t",
  "--repo", "-R",
]);
// `gh pr comment --help`, `gh pr create --help`.
const GH_PR_COMMENT_VALUE_TAKING_FLAGS = new Set(["--body", "-b", "--body-file", "-F", "--repo", "-R"]);
const GH_PR_CREATE_VALUE_TAKING_FLAGS = new Set([
  "--assignee", "-a", "--base", "-B", "--body", "-b", "--body-file", "-F", "--head", "-H", "--label", "-l",
  "--milestone", "-m", "--project", "-p", "--reviewer", "-r", "--template", "-T", "--title", "-t", "--repo", "-R",
]);
const VALUE_TAKING_FLAGS = { create: GH_PR_CREATE_VALUE_TAKING_FLAGS, edit: GH_PR_EDIT_VALUE_TAKING_FLAGS, comment: GH_PR_COMMENT_VALUE_TAKING_FLAGS };

// ── Declared checkout of a `gh pr create` (moved here from pre-tool-gate.mjs, behavior unchanged) ─────────────────

// The cwd every gh pr create gate uses for the PR: a declared DEVPRO_PR_CHECKOUT, else the cwd at the gh position.
// `declared` is returned so the Consumer pre-PR checks gate can require the --repo/-R and --head that go with it.
export function prCreateCwd(cmd, baseCwd, prefixStart, verbIndex) {
  const declared = declaredPrCheckout(cmd, prefixStart, verbIndex);
  if (declared) return { cwd: declared.error ? UNRESOLVABLE_CWD : declared.cwd, declared };
  return { cwd: baseCwd ? commandCwdAt(cmd, baseCwd, verbIndex, "gh", { tolerateRedirectsAndPipes: true }) : "" };
}

// ── Marker ────────────────────────────────────────────────────────────────────────────────────────────────────────

function safeSegments(cmd) {
  try { return segmentCommand(cmd); } catch { return null; }
}

// The raw values of every `DEVPRO_CROSS_REPO_PR=` that sits in real command text (quoted data, heredoc bodies and
// comments are not). Same segment discipline as the repo-scope approval values.
export function crossRepoPrMarkerValues(cmd) {
  const text = String(cmd ?? "");
  if (!text.includes("DEVPRO_CROSS_REPO_PR=")) return [];
  const segs = safeSegments(text);
  const values = [];
  // The value is the whole shell word the shell assigns; only one plain word (or one whole quoted string) is read, and
  // any other word stays as written, which no repository value parses, so it is invalid (PR #3703 r8 W3-F1).
  for (const match of text.matchAll(/(^|[\s;|&(])DEVPRO_CROSS_REPO_PR=((?:"[^"]*"|'[^']*'|\\[^\n]|[^\s;|&()<>"'\\])*)/g)) {
    const markerIndex = (match.index ?? 0) + (match[1] || "").length;
    if (!isMatchInCommandSegment(markerIndex, segs)) continue;
    const word = match[2] || "";
    const whole = /^'([^']*)'$/.exec(word)?.[1] ?? /^"([^"\\]*)"$/.exec(word)?.[1];
    values.push(whole ?? (/["'\\]/.test(word) ? word : word.trim()));
  }
  return values;
}

// { state: "none" } | { state: "invalid", raw } | { state: "conflict", values } | { state: "valid", marker, raw }.
// An occurrence that is present but not a literal two-segment [HOST/]OWNER/REPO is invalid, never "no marker".
function classifyMarkers(cmd) {
  const raws = crossRepoPrMarkerValues(cmd);
  if (!raws.length) return { state: "none" };
  const parsed = raws.map((raw) => parseGhRepoValue(raw));
  const invalidAt = parsed.findIndex((marker) => marker === null);
  if (invalidAt >= 0) return { state: "invalid", raw: raws[invalidAt] };
  const keys = new Set(parsed.map((marker) => `${marker.host ?? ""}/${marker.slug.toLowerCase()}`));
  if (keys.size > 1) return { state: "conflict", values: raws };
  return { state: "valid", marker: parsed[0], raw: raws[0] };
}

// A marker matches a target when the slugs are equal and, when the marker writes a host, the target writes the same
// one. No host is ever read from the environment or the gh configuration.
export function markerMatchesTarget(marker, target) {
  if (!marker || !target) return false;
  if (marker.slug.toLowerCase() !== target.slug.toLowerCase()) return false;
  return !marker.host || marker.host === target.host;
}

// ── Clauses ───────────────────────────────────────────────────────────────────────────────────────────────────────

// `gh [-R <repo>]… pr [-R <repo>]… create|edit|comment`: gh takes `-R`/`--repo` before `pr`, between `pr` and the
// verb, and after the verb, and every position is read as a target value (review r6), so the judgement does not depend
// on where a writer puts the flag.
const GH_REPO_FLAGS_SOURCE = GH_PR_REPO_FLAGS_SOURCE;
const GH_PR_WRITE_RE = new RegExp(
  `${CMD_POSITION_ANCHOR}gh\\s+(?<globals>${GH_REPO_FLAGS_SOURCE})pr\\s+(?<between>${GH_REPO_FLAGS_SOURCE})(?<verb>create|edit|comment)\\b`,
  "gd"
);

// The PR selector (first positional token) and every literal --repo/-R value of the arguments in `text`, which starts
// at `textStart` of the command. A flag counts only when its token sits in a command segment, so text of a quoted
// string or heredoc body is never a target; a heredoc operator or a background `&` ends the arguments.
function scanArguments(text, textStart, segs, valueTaking, wantSelector) {
  const tokens = [...text.matchAll(GH_ARGUMENT_TOKEN_RE)];
  const repos = [];
  let selector;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i][0];
    if (SHELL_HEREDOC_TOKEN_RE.test(token) || token === "&") break;
    if (REDIRECT_TOKEN_RE.test(token)) {
      if (REDIRECT_OPERATOR_ONLY_RE.test(token) || /^\d*<<<$/.test(token)) i += 1;
      continue;
    }
    if (!token.startsWith("-")) {
      if (wantSelector) selector ??= token;
      continue;
    }
    if (!isMatchInCommandSegment(textStart + tokens[i].index, segs)) continue;
    const inline = /^(?:--repo|-R)=([\s\S]*)$/.exec(token) ?? /^-R([\s\S]+)$/.exec(token);
    if (inline) { repos.push(inline[1]); continue; }
    if (token === "--repo" || token === "-R") { repos.push(tokens[i + 1]?.[0] ?? ""); i += 1; continue; }
    if (!token.includes("=") && valueTaking.has(token)) i += 1;
  }
  return { selector, repos };
}

// Every real `gh pr create|edit|comment` clause of `cmd`, as
// { index, matchIndex, clause, verb, prefix, selector, repoValues, localGhRepo, flagsBeforeVerb }: `index` is the `gh`
// token, `prefix` the text from the command boundary to it, `repoValues` the raw literal --repo/-R values in command
// order (before `pr`, between `pr` and the verb, after the verb), `localGhRepo` the raw value of a command-local
// `GH_REPO=` in the prefix, and `flagsBeforeVerb` whether a --repo/-R sits before the verb (the plain `gh pr <verb>`
// form has none). A clause ends at the first top-level separator, comment, or `)` closing a subshell around it.
export function ghPrWriteClauses(cmd) {
  const text = String(cmd ?? "");
  if (!/\bgh\b/.test(text) || !/\bpr\s/.test(text) || !/\b(?:create|edit|comment)\b/.test(text)) return [];
  const segs = safeSegments(text);
  let masked = text;
  for (const seg of segs ?? []) {
    if (seg.kind !== "quoted-string") continue;
    const [from, to] = seg.range;
    masked = masked.slice(0, from) + "_".repeat(to - from) + masked.slice(to);
  }
  const clauses = [];
  for (const match of masked.matchAll(GH_PR_WRITE_RE)) {
    const index = anchoredVerbIndex(match);
    if (!isMatchInCommandSegment(index, segs)) continue;
    const verb = match.groups.verb;
    const start = match.index + match[0].length;
    let end = findTopLevelSeparator(text, start);
    const comment = (segs ?? []).find((seg) => seg.kind === "comment" && seg.range[0] >= start && seg.range[0] < end);
    if (comment) end = comment.range[0];
    for (let i = start, depth = 0; i < end; i += 1) {
      if (masked[i] === "(") depth += 1;
      else if (masked[i] === ")") { if (depth === 0) { end = i; break; } depth -= 1; }
    }
    const flagsOf = (group) => {
      const [from, to] = match.indices.groups[group];
      return scanArguments(text.slice(from, to), from, segs, new Set(), false).repos;
    };
    const globals = flagsOf("globals");
    const between = flagsOf("between");
    const args = scanArguments(text.slice(start, end), start, segs, VALUE_TAKING_FLAGS[verb], verb !== "create");
    const prefix = text.slice(match.index, index);
    const localGhRepo = [...prefix.matchAll(/(?:^|[\s;&|(])GH_REPO=("(?:[^"\\]|\\.)*"|'[^']*'|\S*)/g)].at(-1)?.[1];
    clauses.push({
      index,
      matchIndex: match.index,
      clause: text.slice(index, end),
      verb,
      prefix,
      selector: args.selector,
      repoValues: [...globals, ...between, ...args.repos],
      localGhRepo,
      flagsBeforeVerb: globals.length + between.length > 0,
    });
  }
  return clauses;
}

// ── Target ────────────────────────────────────────────────────────────────────────────────────────────────────────

// The explicit target of one clause `found` (from ghPrWriteClauses): { target: {host?, slug}|null, source, error? }.
// It reads the PR URL selector, every literal --repo/-R value and a command-local GH_REPO; only when the command
// writes none of them does an inherited GH_REPO count. `error` is { kind: "literal"|"ambiguous", values }: a value
// that is not a literal [HOST/]OWNER/REPO (a shell expansion included), or values that disagree on the slug or on a
// written host. `target: null` means the command writes no target, which this module does not try to guess.
export function resolveExplicitPrTarget(found) {
  const written = [];
  const url = found.selector === undefined ? null : PR_URL_SELECTOR_RE.exec(unquoteOnce(found.selector));
  if (url) {
    const literal = !/[$`]/.test(`${url[2]}${url[3]}`);
    written.push({ raw: url[0].replace(/\/pull\/\d+$/, "").replace(/^https?:\/\//, ""), source: "url", parsed: literal ? { host: url[1].toLowerCase(), slug: `${url[2]}/${url[3]}` } : null });
  }
  for (const raw of found.repoValues ?? []) written.push({ raw: unquoteOnce(raw), source: "flag", parsed: parseGhRepoValue(raw) });
  if (found.localGhRepo !== undefined) written.push({ raw: unquoteOnce(found.localGhRepo), source: "command-env", parsed: parseGhRepoValue(found.localGhRepo) });
  if (!written.length && process.env.GH_REPO) written.push({ raw: process.env.GH_REPO, source: "inherited-env", parsed: parseGhRepoValue(process.env.GH_REPO) });
  if (!written.length) return { target: null, source: "none" };

  const values = written.map((entry) => entry.raw);
  const sources = new Set(written.map((entry) => entry.source));
  const source = sources.size === 1 ? [...sources][0] : "mixed";
  if (written.some((entry) => entry.parsed === null)) return { target: null, source, error: { kind: "literal", values } };
  const slugs = new Set(written.map((entry) => entry.parsed.slug.toLowerCase()));
  const hosts = new Set(written.map((entry) => entry.parsed.host).filter(Boolean));
  if (slugs.size > 1 || hosts.size > 1) return { target: null, source, error: { kind: "ambiguous", values } };
  const host = written.find((entry) => entry.parsed.host)?.parsed.host;
  return { target: { host, slug: written[0].parsed.slug }, source };
}

// ── Authorization ─────────────────────────────────────────────────────────────────────────────────────────────────

const targetText = (target) => (target.host ? `${target.host}/${target.slug}` : target.slug);
const ownText = (own) => `${own.host}/${own.slug}`;
const SOURCE_TEXT = {
  url: "the PR URL",
  flag: "--repo/-R",
  "command-env": "a command-local GH_REPO",
  "inherited-env": "the inherited GH_REPO environment variable",
  mixed: "the values written in the command",
};

function invalidMarkerReason(markers, verb) {
  if (markers.state === "conflict") {
    return `Cross-repo PR write gate: the payload carries DEVPRO_CROSS_REPO_PR with different values (${markers.values.join(", ")}), so gh pr ${verb} cannot tell which repository is authorized. Write one value, \`DEVPRO_CROSS_REPO_PR=<owner/repo>\`, for the one repository this payload writes to.`;
  }
  return `Cross-repo PR write gate: the DEVPRO_CROSS_REPO_PR value is invalid, so gh pr ${verb} is blocked instead of treated as unmarked. The value must be a literal two-segment [HOST/]OWNER/REPO such as \`DEVPRO_CROSS_REPO_PR=owner/repo\`: no \`*\`, no URL, no owner-only or repository-only value, and no shell expansion ($VAR, \${VAR}, $(…), backticks), because the hook decides before the shell expands it.`;
}

function targetErrorReason(error, verb) {
  if (error.kind === "ambiguous") {
    return `Cross-repo PR write gate: the target repository of this gh pr ${verb} is ambiguous (written values: ${error.values.join(", ")}). Write a single target: exactly one --repo/-R value or a PR URL, not several that disagree.`;
  }
  return `Cross-repo PR write gate: the target repository of this gh pr ${verb} is not a literal [HOST/]OWNER/REPO; the hook decides before the shell expands it, so write the literal [HOST/]OWNER/REPO.`;
}

function crossRepoReason({ verb, target, source, own, markers, declared }) {
  const slug = target.slug;
  const where = own ? `a checkout of ${ownText(own)}` : "the current checkout";
  const markerNote = markers.state === "valid" && !markerMatchesTarget(markers.marker, target)
    ? ` The DEVPRO_CROSS_REPO_PR marker names ${targetText(markers.marker)}, which is not ${targetText(target)}.`
    : "";
  return [
    `Cross-repo PR write gate: gh pr ${verb} writes to ${targetText(target)} (from ${SOURCE_TEXT[source] ?? source}), but it runs in ${where}, and nothing authorizes a pull-request write to another repository.${markerNote}`,
    `Fix 1: put DEVPRO_CROSS_REPO_PR=${slug} in front of the command; it authorizes only gh pr create, edit and comment that write ${slug} as their target (a gh pr create also needs a literal --repo ${slug} and a literal --head <branch>; add DEVPRO_PR_CHECKOUT=<absolute checkout> when a local checkout of ${slug} should have its pre-PR evidence judged).`,
    `Fix 2: run the command inside a checkout of ${slug}.`,
    ...(declared && own ? [`The command declares DEVPRO_PR_CHECKOUT, and a marker does not relax a declared checkout: the declared checkout is ${own.slug}, so declare a checkout of ${slug} instead.`] : []),
  ].join("\n");
}

function hostMismatchReason({ verb, target, markers }) {
  const wanted = `${markers.marker.host}/${markers.marker.slug}`;
  return `Cross-repo PR write gate: DEVPRO_CROSS_REPO_PR names ${wanted}, but this gh pr ${verb} writes ${targetText(target)} without that host. The hook does not read a host from the environment or the gh configuration, so write the host in the target itself: --repo ${wanted} (or use a PR URL on ${markers.marker.host}).`;
}

function noTargetReason({ verb, markers }) {
  const wanted = targetText(markers.marker);
  return `Cross-repo PR write gate: DEVPRO_CROSS_REPO_PR=${markers.raw} only authorizes a pull-request write that writes its target, and this gh pr ${verb} writes none. Add --repo ${wanted} or use a PR URL (https://<host>/${markers.marker.slug}/pull/<number>); the hook does not guess which repository gh would pick.`;
}

// The command checkout of one clause: a declared DEVPRO_PR_CHECKOUT or else the cwd at the gh position for a create,
// the cwd at the gh position for an edit or a comment. `cwd` is null when it cannot be resolved before the shell runs.
function commandCheckoutOf(cmd, baseCwd, found) {
  if (!baseCwd) return { cwd: null };
  if (found.verb === "create") {
    const { cwd, declared } = prCreateCwd(cmd, baseCwd, found.matchIndex, found.index);
    return { cwd: !cwd || cwd === UNRESOLVABLE_CWD ? null : cwd, declared };
  }
  const cwd = commandCwdAt(cmd, baseCwd, found.index, "gh", { tolerateRedirectsAndPipes: true });
  return { cwd: !cwd || cwd === UNRESOLVABLE_CWD ? null : cwd };
}

// Whether `origin` of `cwd` is an http(s) URL. resolveGithubRepoIdentity reads the host of an scp or ssh origin from
// its transport (an ~/.ssh/config alias such as `github-work`, or `ssh.github.com`), which a web host written in a PR
// URL or a host-qualified --repo cannot be compared with. Read only when the slugs agree and the hosts do not.
function originIsWebUrl(cwd) {
  const r = spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" });
  return r.status === 0 && /^https?:\/\//i.test(String(r.stdout).trim());
}

function judgeClause(cmd, baseCwd, markers, found) {
  const entry = {
    index: found.index,
    matchIndex: found.matchIndex,
    flagsBeforeVerb: found.flagsBeforeVerb,
    clause: found.clause,
    verb: found.verb,
    repoValues: found.repoValues,
    localGhRepo: found.localGhRepo,
    target: null,
    source: "none",
    declared: null,
    commandCheckout: null,
    relation: "undetermined",
    ownSlug: false,
    markerScoped: false,
    authorized: false,
  };
  if (markers.state === "invalid" || markers.state === "conflict") {
    return { ...entry, blockReason: invalidMarkerReason(markers, found.verb) };
  }
  const resolved = resolveExplicitPrTarget(found);
  entry.source = resolved.source;
  if (resolved.error) return { ...entry, blockReason: targetErrorReason(resolved.error, found.verb) };
  const { target } = resolved;
  if (!target) {
    // The command writes no target: a marker asks for one, no marker keeps the existing verdict.
    return markers.state === "valid" ? { ...entry, blockReason: noTargetReason({ verb: found.verb, markers }) } : entry;
  }
  entry.target = target;
  entry.markerScoped = markers.state === "valid" && markerMatchesTarget(markers.marker, target);

  const { cwd, declared } = commandCheckoutOf(cmd, baseCwd, found);
  entry.declared = declared ?? null;
  if (cwd === null) {
    // An unresolvable command checkout is left to the existing gates.
    entry.relation = "unresolved";
    return entry;
  }
  entry.commandCheckout = cwd;
  const own = resolveGithubRepoIdentity(cwd);
  // `ownSlug`: the target names the command checkout's own repository slug. From an scp or ssh origin the hosts cannot
  // be compared, so such a write is undetermined and keeps its existing verdict (review r2). The consumer pre-PR checks
  // gate never makes an own-slug create remote-only, whatever the hosts: that pull request may belong to this checkout.
  entry.ownSlug = Boolean(own) && target.slug.toLowerCase() === own.slug;
  if (!own) entry.relation = "undetermined";
  else if (originMatches(target, own)) entry.relation = "same";
  else entry.relation = entry.ownSlug && !originIsWebUrl(cwd) ? "undetermined" : "cross";
  if (entry.relation === "same") return entry;

  if (entry.markerScoped) return { ...entry, authorized: true };
  if (entry.relation === "cross" && markers.state === "valid" && markers.marker.slug.toLowerCase() === target.slug.toLowerCase()) {
    return { ...entry, blockReason: hostMismatchReason({ verb: found.verb, target, markers }) };
  }
  // A cross-repo write is blocked; whether an origin-less checkout is cross-repo is undetermined and keeps its verdict.
  if (entry.relation === "cross") {
    return { ...entry, blockReason: crossRepoReason({ verb: found.verb, target, source: resolved.source, own, markers, declared: Boolean(declared && !declared.error) }) };
  }
  return entry;
}

// A backslash before a newline in real command text is a line continuation: the shell joins the two lines, so
// `DEVPRO_PR_CHECKOUT=<dir> \<newline> gh pr create …` declares the checkout of that gh. Each continuation becomes
// spaces of the same length, so every offset stays the raw command's offset (the consumer pre-PR checks gate matches
// its own clause to an entry by index). Quoted data, comments and heredoc bodies keep their backslashes: a quoted
// heredoc keeps `\` literally, and joining its last line onto the terminator would hide the commands behind it.
export function joinCommandLineContinuations(cmd, { betweenWordsOnly = false } = {}) {
  const text = String(cmd ?? "");
  if (!/\\\r?\n/.test(text)) return text;
  const segs = segmentCommand(text);
  return text.replace(/(^|[^\\])((?:\\\\)*)\\(\r?\n)/g, (match, lead, pairs, newline, offset) => {
    const at = offset + lead.length + pairs.length;
    if (betweenWordsOnly && (pairs || (at > 0 && !/\s/.test(lead) && !/\s/.test(text[at + 1 + newline.length] ?? "")))) return match;
    return isMatchInCommandSegment(at, segs) ? `${lead}${pairs}${" ".repeat(1 + newline.length)}` : match;
  });
}

const authorizationMemo = new Map();

// The judgement of every gh pr create/edit/comment clause of `cmd` run from `baseCwd`, as an array of
// { index, matchIndex, flagsBeforeVerb, clause, verb, target, source, repoValues, localGhRepo, declared, commandCheckout,
//   relation: same|cross|undetermined|unresolved, ownSlug, markerScoped, authorized, blockReason? } in command order. A payload without such a clause costs nothing; the
// command checkout's `origin` is read only for a clause that writes an explicit target. Memoised per process on
// the command and the base cwd, so every gate reads one result. Both gates in pre-tool-gate.mjs pass the raw command; line
// continuations are joined here, once, so they read the same declarations.
export function crossRepoPrAuthorization(cmd, baseCwd) {
  const raw = String(cmd ?? "");
  const key = `${raw}\0${baseCwd ?? ""}`;
  const known = authorizationMemo.get(key);
  if (known) return known;
  const text = joinCommandLineContinuations(raw);
  const clauses = ghPrWriteClauses(text);
  const markers = clauses.length ? classifyMarkers(text) : { state: "none" };
  const result = clauses.map((found) => judgeClause(text, baseCwd, markers, found));
  authorizationMemo.set(key, result);
  return result;
}
