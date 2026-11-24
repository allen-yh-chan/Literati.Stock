#!/usr/bin/env node
/**
 * hotfix-carrier-verify.mjs
 *
 * Recipe-layer verifier for the hotfix release-carrier lane
 * (openspec/changes/enforce-hotfix-release-carrier design.md D4–D6, D14).
 *
 * Six subcommands, each a fail-closed predicate check against a read-only
 * GitHub PR record (never operator-transcribed JSON) AND, for all but
 * merge-target, git topology:
 *
 *   freshness    --anchor-tag <T> --anchor-commit <sha> [--remote <name>]
 *   pre-merge    --pr <n> --carrier <b> --approved-tip <sha> --base-ref-oid <sha> --merge-base <sha>
 *   merge-proof  --kind hotfix|bump --pr <n> --carrier <b> --anchor-commit <sha>
 *                [--approved-tip <sha> --base-ref-oid <sha>] [--shape merge|ff]
 *   pre-promote  --carrier <b> (--body-file <f> | --production-pr <n>)
 *   post-promote --tag <T> --carrier <b> --carrier-sha <sha> --anchor-commit <sha>
 *                --production-pr <n> --provenance-sha256 <64hex> [--shape merge|ff] [--back-merge-pr <m>]
 *   merge-target --pr <n> --carrier <b> --base production|main
 *
 * Output: single JSON object `{ok, status, subcommand, checks:[{id,ok,detail}], reason}`.
 * Exit 0 = all predicates hold. Exit 1 = a predicate failed (fail closed on content/
 * topology/GitHub-record mismatch). Exit 2 = usage/environment error (bad flag, git
 * < 2.40, `gh` failure, unresolvable ref/SHA, marker missing) — also fail closed.
 *
 * GitHub access is an injectable `ghRunner({prNumber, fields, cwd}) -> object` plus
 * `ghPermissionRunner({login, cwd}) -> "admin"|"write"|"read"|"none"` (review-binding
 * author trust). The CLI's default runners shell out to the real `gh` binary. There is NO env-based
 * "skip GitHub" switch — every referenced PR is always cross-checked (design D4 F-1-1).
 *
 * Every subcommand that reads a remote-tracking ref (`origin/<carrier>`,
 * `origin/production`, `origin/main`) fetches it first by default
 * (`git fetch origin --prune --tags`) — a stale local tracking ref must not
 * make a moved base/tip look current (F-ehrc-r1-06). There is NO CLI flag to
 * skip this fetch (N46) — fixture/test isolation goes exclusively through
 * `run()`'s `options.skipFetch`, which is never inferred or defaulted on and
 * has no argv-level spelling.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const isMain = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);

export const HEX40_RE = /^[0-9a-f]{40}$/i;
export const MIN_GIT_VERSION = [2, 40, 0];

// Per-lane split of branch-naming.mjs RELEASE_EXEMPTION_RE (SSOT); keep the
// three alternatives byte-aligned with it, including rules `-1` never being legal.
const SOURCE_CARRIER_RE = /^release\/v\d+\.\d+\.\d+$/;
const CONSUMER_CARRIER_RE = /^release\/\d{8}-[0-9a-f]{7}(?:-\d+)?$/;
const RULES_CARRIER_RE = /^release\/rules-\d{8}(?:-(?:[2-9]|[1-9]\d+))?$/;
const RULES_TAG_RE = /^production-\d{8}-rules(?:-\d+)?$/;
const BUILT_AT_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
// N45: each comma-separated provenance `gates` entry MUST be `<name>=pass`.
const GATE_ENTRY_RE = /^[A-Za-z0-9._-]+=pass$/;
const PRODUCTION_REF = "production";
const VALID_LANES = new Set(["source", "consumer", "consumer-rules"]);

const RELEASE_LEAF_REL = ".devpro/agent-rules/release-sit-uat-pat-prod.md";
const MARKER_START = "<!-- version-metadata-files:start -->";
const MARKER_END = "<!-- version-metadata-files:end -->";

export const USAGE = `用法：
  node .devpro/scripts/hotfix-carrier-verify.mjs freshness --anchor-tag <T> --anchor-commit <sha> [--remote <name>]
  node .devpro/scripts/hotfix-carrier-verify.mjs pre-merge --pr <n> --carrier <b> --approved-tip <sha> --base-ref-oid <sha> --merge-base <sha>
  node .devpro/scripts/hotfix-carrier-verify.mjs merge-proof --kind hotfix|bump --pr <n> --carrier <b> --anchor-commit <sha> [--approved-tip <sha> --base-ref-oid <sha>] [--shape merge|ff]
  node .devpro/scripts/hotfix-carrier-verify.mjs pre-promote --carrier <b> (--body-file <f> | --production-pr <n>)
  node .devpro/scripts/hotfix-carrier-verify.mjs post-promote --tag <T> --carrier <b> --carrier-sha <sha> --anchor-commit <sha> --production-pr <n> --provenance-sha256 <64hex> [--shape merge|ff] [--back-merge-pr <m>]
  node .devpro/scripts/hotfix-carrier-verify.mjs merge-target --pr <n> --carrier <b> --base production|main`;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class VerifyExit extends Error {
  constructor(exitCode, reason, checks = []) {
    super(reason);
    this.exitCode = exitCode;
    this.checks = checks;
  }
}

function envError(cl, message) {
  throw new VerifyExit(2, message, cl ? cl.checks : []);
}

function makeChecklist() {
  const checks = [];
  return {
    checks,
    require(id, ok, detail, exitCode = 1) {
      checks.push({ id, ok, detail });
      if (!ok) throw new VerifyExit(exitCode, detail, checks);
    },
    pass(id, detail) {
      checks.push({ id, ok: true, detail });
    },
  };
}

function mergeInnerVerifyExit(cl, err) {
  if (err instanceof VerifyExit) {
    cl.checks.push(...err.checks);
    throw new VerifyExit(err.exitCode, err.message, cl.checks);
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Git plumbing (array-argv spawnSync; explicit cwd; never process.cwd()/chdir)
// ---------------------------------------------------------------------------

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitOut(cwd, args) {
  const r = git(cwd, args);
  return r.status === 0 ? r.stdout.trim() : null;
}

export function resolveSha(cwd, ref) {
  const out = gitOut(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  return out && HEX40_RE.test(out) ? out.toLowerCase() : null;
}

function treeOf(cwd, ref) {
  const out = gitOut(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{tree}`]);
  return out && HEX40_RE.test(out) ? out.toLowerCase() : null;
}

function parentsOf(cwd, sha) {
  const out = gitOut(cwd, ["rev-list", "-1", "--parents", sha]);
  if (out == null) return null;
  const parts = out.split(/\s+/).filter(Boolean);
  return parts.slice(1);
}

function firstParentList(cwd, ref) {
  const out = gitOut(cwd, ["rev-list", "--first-parent", ref]);
  if (out === null) return null;
  return out ? out.split("\n") : [];
}

function firstParentChainBetween(cwd, fromExclusiveRef, toInclusiveRef) {
  const out = gitOut(cwd, ["rev-list", "--first-parent", "--reverse", `${fromExclusiveRef}..${toInclusiveRef}`]);
  if (out === null) return null;
  return out ? out.split("\n") : [];
}

function isAncestor(cwd, ancestor, descendant) {
  const r = git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null;
}

function mergeTreeSpawn(cwd, args) {
  return git(cwd, ["merge-tree", "--write-tree", ...args]);
}

/**
 * Recompute a merge with `git merge-tree --write-tree` and require it to be
 * clean AND equal to `expectedTreeSha`. Pushes TWO check ids: `<idPrefix>.clean`
 * (exit 1 on real conflict — the merge commit resolved conflicts inside itself)
 * and `<idPrefix>.tree-eq` (exit 1 when the recompute is clean but disagrees
 * with the merge commit's actual tree — a content-discarding strategy such as
 * `-s ours`). Distinguishing the two lets tests assert the specific check id.
 */
function requireCleanMergeTree(cl, cwd, idPrefix, refA, refB, expectedTreeSha, { extraArgs = [], conflictHint = "" } = {}) {
  const mt = mergeTreeSpawn(cwd, [...extraArgs, refA, refB]);
  if (mt.status === 1) {
    cl.require(`${idPrefix}.clean`, false, `merge-tree ${refA} ${refB} produced conflicts (non-clean merge)${conflictHint}`);
  }
  if (mt.status !== 0) envError(cl, `merge-tree ${refA} ${refB} errored (status ${mt.status}): ${(mt.stderr || "").trim()}`);
  cl.pass(`${idPrefix}.clean`, "merge-tree recompute is clean");
  const resultTree = (mt.stdout || "").trim().split("\n")[0];
  if (!HEX40_RE.test(resultTree || "")) envError(cl, `merge-tree ${refA} ${refB} produced unexpected output`);
  if (!expectedTreeSha) envError(cl, `cannot resolve expected tree for ${idPrefix}`);
  cl.require(`${idPrefix}.tree-eq`, eqHex(resultTree, expectedTreeSha), `merge-tree result ${resultTree} != expected tree ${expectedTreeSha} (content-discarding merge strategy or altered content)`);
}

// ---------------------------------------------------------------------------
// git version gate (D4 round 2: merge-tree --write-tree >= 2.38, --merge-base >= 2.40)
// ---------------------------------------------------------------------------

export function parseGitVersion(text) {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text || "");
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

function versionAtLeast(v, min) {
  for (let i = 0; i < min.length; i++) {
    const a = v[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

export function checkGitVersion(gitVersionText) {
  const parsed = parseGitVersion(gitVersionText);
  if (!parsed) return { ok: false, reason: `unparseable git version output: ${JSON.stringify(gitVersionText)}` };
  if (!versionAtLeast(parsed, MIN_GIT_VERSION)) {
    return { ok: false, reason: `git ${parsed.join(".")} < required ${MIN_GIT_VERSION.join(".")}` };
  }
  return { ok: true };
}

function getGitVersionText(cwd) {
  const r = git(cwd, ["version"]);
  if (r.error || r.status !== 0) return "";
  return r.stdout || "";
}

// ---------------------------------------------------------------------------
// hotfix-carrier-provenance block parsing (design D5)
// ---------------------------------------------------------------------------

const PROVENANCE_FENCE_RE = /```hotfix-carrier-provenance\n([\s\S]*?)\n```/g;
const REQUIRED_PROVENANCE_KEYS = [
  "lane", "anchor_tag", "anchor_commit", "carrier", "carrier_sha", "bump", "artifact_id", "built_at", "gates",
];

function parseKeyValueTokens(rest) {
  const out = {};
  for (const token of rest.trim().split(/\s+/).filter(Boolean)) {
    const eq = token.indexOf("=");
    if (eq === -1) throw new VerifyExit(1, `unparseable provenance token: ${JSON.stringify(token)}`);
    out[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return out;
}

function parseUnitLine(rest) {
  const kv = parseKeyValueTokens(rest);
  for (const req of ["pr", "approved_tip", "base_ref_oid", "merge_base_sha", "mc", "shape"]) {
    if (!(req in kv)) throw new VerifyExit(1, `unit= line missing key: ${req}`);
  }
  if (kv.shape !== "merge" && kv.shape !== "ff") throw new VerifyExit(1, `unit= shape must be merge|ff, got ${JSON.stringify(kv.shape)}`);
  for (const hexKey of ["approved_tip", "base_ref_oid", "merge_base_sha", "mc"]) {
    if (!HEX40_RE.test(kv[hexKey] || "")) throw new VerifyExit(1, `unit= ${hexKey} not 40-hex: ${JSON.stringify(kv[hexKey])}`);
  }
  if (kv.reverts !== undefined && !HEX40_RE.test(kv.reverts)) {
    throw new VerifyExit(1, `unit= reverts not 40-hex: ${JSON.stringify(kv.reverts)}`);
  }
  return kv;
}

function parseBumpField(rest) {
  const trimmed = rest.trim();
  if (trimmed === "N/A") return "N/A";
  const kv = parseKeyValueTokens(trimmed);
  for (const req of ["pr", "head", "mc"]) {
    if (!(req in kv)) throw new VerifyExit(1, `bump= line missing key: ${req}`);
  }
  for (const hexKey of ["head", "mc"]) {
    if (!HEX40_RE.test(kv[hexKey] || "")) throw new VerifyExit(1, `bump= ${hexKey} not 40-hex: ${JSON.stringify(kv[hexKey])}`);
  }
  return kv;
}

/**
 * Parse the (unique) `hotfix-carrier-provenance` fenced block out of a PR body.
 * Throws `VerifyExit(1, ...)` — a malformed/missing/duplicated block is a
 * predicate failure (N17), not a usage error.
 */
export function parseProvenanceBlock(body) {
  // GitHub's web editor may store the PR body with CRLF line endings.
  const text = typeof body === "string" ? body.replace(/\r\n?/g, "\n") : "";
  const matches = [...text.matchAll(PROVENANCE_FENCE_RE)];
  if (matches.length === 0) throw new VerifyExit(1, "hotfix-carrier-provenance block missing");
  if (matches.length > 1) throw new VerifyExit(1, "duplicate hotfix-carrier-provenance block");
  const block = matches[0][1];
  const record = { units: [] };
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) throw new VerifyExit(1, `unparseable provenance line: ${JSON.stringify(line)}`);
    const [, key, rest] = kv;
    if (key === "unit") {
      record.units.push(parseUnitLine(rest));
      continue;
    }
    if (key in record) throw new VerifyExit(1, `duplicate provenance key: ${key}`);
    record[key] = rest.trim();
  }
  for (const required of REQUIRED_PROVENANCE_KEYS) {
    if (!(required in record)) throw new VerifyExit(1, `missing provenance key: ${required}`);
  }
  if (!VALID_LANES.has(record.lane)) throw new VerifyExit(1, `invalid lane: ${JSON.stringify(record.lane)}`);
  if (!HEX40_RE.test(record.anchor_commit)) throw new VerifyExit(1, "anchor_commit not 40-hex");
  if (!HEX40_RE.test(record.carrier_sha)) throw new VerifyExit(1, "carrier_sha not 40-hex");
  record.anchor_commit = record.anchor_commit.toLowerCase();
  record.carrier_sha = record.carrier_sha.toLowerCase();
  record.bump = parseBumpField(record.bump);
  if (record.units.length === 0) throw new VerifyExit(1, "no unit= lines in hotfix-carrier-provenance block");
  return record;
}

/**
 * sha256 of the (unique) provenance block's normalized content -- CRLF/CR
 * line endings folded to LF, each line trimmed, blank lines removed, joined by "\n" -- so edits
 * outside the block (template sections, footer) never change it while any
 * edit to a block value (artifact_id, carrier_sha, ...) always does.
 * `pre-promote` reports it; `post-promote` requires the production PR body
 * to still hash to it (mutable-artifact-provenance). Returns null unless the
 * body carries exactly one block.
 */
export function provenanceDigest(body) {
  const text = typeof body === "string" ? body.replace(/\r\n?/g, "\n") : "";
  const matches = [...text.matchAll(PROVENANCE_FENCE_RE)];
  if (matches.length !== 1) return null;
  const normalized = matches[0][1].split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function parseProvenanceBlockChecked(cl, body) {
  try {
    const record = parseProvenanceBlock(body);
    cl.pass("pre-promote.provenance-block-parsed", "exactly one well-formed hotfix-carrier-provenance block");
    return record;
  } catch (err) {
    if (err instanceof VerifyExit) {
      cl.checks.push({ id: "pre-promote.provenance-block-parsed", ok: false, detail: err.message });
      throw new VerifyExit(err.exitCode, err.message, cl.checks);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// version-metadata-files SSOT marker loader (design D14)
// ---------------------------------------------------------------------------

/**
 * Load the `version-metadata-files` marker block from
 * `<repoRoot>/.devpro/agent-rules/release-sit-uat-pat-prod.md`. No hardcoded
 * fallback list exists — a missing file, missing/out-of-order markers, an
 * unparseable line, a `*` glob outside the basename-prefix position, or an
 * empty parsed list all fail closed with exit 2 (usage/environment error).
 */
export function loadVersionMetadataFiles(repoRoot) {
  const filePath = path.join(repoRoot, RELEASE_LEAF_REL);
  let md;
  try {
    md = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new VerifyExit(2, `cannot read ${RELEASE_LEAF_REL}: ${err.message}`);
  }
  const start = md.indexOf(MARKER_START);
  const end = md.indexOf(MARKER_END);
  if (start === -1 || end === -1 || end <= start) {
    throw new VerifyExit(2, `version-metadata-files marker missing/malformed in ${RELEASE_LEAF_REL}`);
  }
  const block = md.slice(start + MARKER_START.length, end);
  const patterns = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^-\s+`([^`]+)`/);
    if (!m) throw new VerifyExit(2, `version-metadata-files marker block has unparseable line: ${JSON.stringify(line)}`);
    const pattern = m[1];
    const starIdx = pattern.indexOf("*");
    if (starIdx !== -1 && (starIdx !== 0 || pattern.slice(1).includes("*"))) {
      throw new VerifyExit(2, `version-metadata-files pattern uses '*' outside a basename-prefix glob: ${pattern}`);
    }
    patterns.push({ pattern, sourceOnly: /source-only/.test(line) });
  }
  if (patterns.length === 0) {
    throw new VerifyExit(2, `version-metadata-files marker block parsed empty in ${RELEASE_LEAF_REL}`);
  }
  return patterns;
}

function matchesGlobBasename(basename, pattern) {
  if (pattern.startsWith("*")) return basename.endsWith(pattern.slice(1));
  return basename === pattern;
}

function treeHasVersionFile(cwd, ref, patterns) {
  const out = gitOut(cwd, ["ls-tree", "-r", "--name-only", ref]);
  if (out === null) return null;
  const paths = out ? out.split("\n") : [];
  const applicable = patterns.filter((p) => !p.sourceOnly);
  return paths.some((p) => {
    const base = p.split("/").pop();
    return applicable.some((pat) => matchesGlobBasename(base, pat.pattern));
  });
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function eqHex(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function arraysEqualHex(a, b) {
  if (a.length !== b.length) return false;
  return a.every((x, i) => eqHex(x, b[i]));
}

export function laneMatchesCarrier(lane, carrier) {
  if (lane === "source") return SOURCE_CARRIER_RE.test(carrier);
  if (lane === "consumer") return CONSUMER_CARRIER_RE.test(carrier);
  if (lane === "consumer-rules") return RULES_CARRIER_RE.test(carrier);
  return false;
}

function sourceVersionFromCarrier(carrier) {
  const m = carrier.match(/^release\/v(\d+\.\d+\.\d+)$/);
  return m ? m[1] : null;
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) throw new VerifyExit(2, `unexpected positional argument: ${a}`);
    // N46: `--no-fetch` (and `--no-fetch=...`) is not a supported CLI flag.
    // Every subcommand always fetches remote refs before checking them;
    // fixture/test isolation goes exclusively through run()'s `skipFetch`
    // option, which has no argv-level spelling and is never inferred.
    if (a === "--no-fetch" || a.startsWith("--no-fetch=")) {
      throw new VerifyExit(2, `--no-fetch is not a supported flag; every subcommand always fetches remote refs before checking them (fixture/test isolation goes through run()'s skipFetch option, not a CLI flag)`);
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(0, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = args[i + 1];
    if (next === undefined) throw new VerifyExit(2, `missing value for ${a}`);
    out[a] = next;
    i += 1;
  }
  return out;
}

function requireStrArg(opts, name) {
  const v = opts[name];
  if (typeof v !== "string" || v.length === 0) throw new VerifyExit(2, `missing/invalid ${name}`);
  return v;
}

function requireIntArg(opts, name) {
  const v = requireStrArg(opts, name);
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new VerifyExit(2, `${name} must be a positive integer, got ${JSON.stringify(v)}`);
  return n;
}

function requireHexArg(opts, name) {
  const v = requireStrArg(opts, name);
  if (!HEX40_RE.test(v)) throw new VerifyExit(2, `${name} must be a 40-hex SHA, got ${JSON.stringify(v)}`);
  return v.toLowerCase();
}

function optionalHexArg(opts, name) {
  if (!(name in opts)) return null;
  return requireHexArg(opts, name);
}

// ---------------------------------------------------------------------------
// GitHub PR read (single injectable ghRunner; no env skip switch)
// ---------------------------------------------------------------------------

function defaultGhRunner({ prNumber, fields, cwd }) {
  const result = spawnSync("gh", ["pr", "view", String(prNumber), "--json", fields.join(",")], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`gh spawn failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`gh pr view ${prNumber} exited ${result.status}: ${(result.stderr || "").trim()}`);
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`gh pr view ${prNumber} returned invalid JSON: ${err.message}`);
  }
}

function defaultGhPermissionRunner({ login, cwd }) {
  const result = spawnSync("gh", ["api", `repos/{owner}/{repo}/collaborators/${login}/permission`, "--jq", ".permission"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`gh spawn failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`gh api collaborators/${login}/permission exited ${result.status}: ${(result.stderr || "").trim()}`);
  return (result.stdout || "").trim();
}

function ghPrView(ghRunner, cwd, prNumber, fields) {
  let raw;
  try {
    raw = ghRunner({ prNumber, fields, cwd });
  } catch (err) {
    throw new VerifyExit(2, `gh pr view ${prNumber} failed: ${err.message}`);
  }
  if (raw == null || typeof raw !== "object") throw new VerifyExit(2, `gh pr view ${prNumber} returned a non-object`);
  for (const f of fields) {
    if (!(f in raw)) throw new VerifyExit(2, `gh pr view ${prNumber} response missing field: ${f}`);
  }
  return raw;
}

const PR_VIEW_FIELDS = ["number", "state", "mergedAt", "headRefName", "headRefOid", "baseRefName", "mergeCommit"];
const PR_VIEW_FIELDS_WITH_BODY = [...PR_VIEW_FIELDS, "body"];

// ---------------------------------------------------------------------------
// review-binding (D5 / N44): TL leaves a single-line `hotfix-review-binding:
// head=<40hex> base_ref_oid=<40hex> merge_base_sha=<40hex>` comment on the
// hotfix PR at review time. `pre-merge`, `merge-proof --kind hotfix`, and
// `pre-promote` (per unit) read it from the PR's own `comments` -- never
// trusting a caller-supplied base -- and require exactly one binding whose
// `head` equals the approved tip in scope.
//
// Only a trusted, immutable comment counts (hotfix-review-binding-forgery):
// its author (`author.login`) holds write access to the repository -- GitHub's
// collaborator permission is `admin` or `write` (`maintain` reports as
// `write`); `authorAssociation` alone is NOT used, since MEMBER/COLLABORATOR
// can be read-only -- it was never edited (`includesCreatedEdit === false`),
// and, once the PR is merged, it was created no later than `mergedAt`. Any
// other binding line is ignored, so an account without write access can
// neither supply nor block the review record. Missing fields or a failed
// permission lookup fail closed (the comment is ignored). The PR author is
// not excluded: in single-maintainer repos the TL and the PR author are the
// same account (design D18 addendum).
// ---------------------------------------------------------------------------

const TRUSTED_BINDING_PERMISSIONS = new Set(["admin", "write"]);

function bindingCommentUntrustedReason(comment, mergedAtBound, lookupPermission) {
  if (comment.includesCreatedEdit !== false) return "edited after posting";
  if (mergedAtBound !== undefined) {
    const created = Date.parse(comment.createdAt);
    const merged = Date.parse(mergedAtBound);
    if (!Number.isFinite(created) || !Number.isFinite(merged) || created > merged) return "posted after the merge";
  }
  const login = comment.author && typeof comment.author.login === "string" ? comment.author.login : "";
  if (!login) return "author unknown";
  const permission = lookupPermission(login);
  if (permission === null) return "author permission lookup failed";
  if (!TRUSTED_BINDING_PERMISSIONS.has(permission)) return "author without write access";
  return null;
}

const REVIEW_BINDING_RE = /^hotfix-review-binding:\s+head=([0-9a-f]{40})\s+base_ref_oid=([0-9a-f]{40})\s+merge_base_sha=([0-9a-f]{40})\s*$/i;

function parseReviewBindings(comments) {
  const out = [];
  for (const c of comments) {
    const body = c && typeof c.body === "string" ? c.body : "";
    for (const rawLine of body.split("\n")) {
      const m = REVIEW_BINDING_RE.exec(rawLine.trim());
      if (m) out.push({ head: m[1].toLowerCase(), base_ref_oid: m[2].toLowerCase(), merge_base_sha: m[3].toLowerCase(), comment: c });
    }
  }
  return out;
}

/**
 * Collaborator permission for `login`, memoized per run; null when the
 * lookup fails (the caller treats that comment as untrusted).
 */
function lookupCollaboratorPermission(ctx, login) {
  if (!ctx.permissionCache.has(login)) {
    let permission = null;
    try {
      const raw = ctx.ghPermissionRunner({ login, cwd: ctx.cwd });
      permission = typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : null;
    } catch {
      permission = null;
    }
    ctx.permissionCache.set(login, permission);
  }
  return ctx.permissionCache.get(login);
}

/**
 * Resolve the (unique) trusted review binding whose `head` equals
 * `approvedTip`, pushing `<idPrefix>-present` and `<idPrefix>-unique` checks.
 * `mergedAtBound` is the PR's `mergedAt` for a merged PR (bindings created
 * after it are ignored) and `undefined` for an open PR. A `comments` field
 * that is missing or not an array is a structural GitHub-record defect
 * (exit 2), mirroring `ghPrView`'s missing-field behavior.
 */
function findReviewBinding(cl, ctx, idPrefix, comments, approvedTip, mergedAtBound) {
  if (!Array.isArray(comments)) envError(cl, `${idPrefix}: PR comments field is not an array (cannot read hotfix-review-binding)`);
  const seen = [];
  const ignored = [];
  for (const b of parseReviewBindings(comments)) {
    if (!eqHex(b.head, approvedTip)) continue;
    const untrusted = bindingCommentUntrustedReason(b.comment, mergedAtBound, (login) => lookupCollaboratorPermission(ctx, login));
    if (untrusted) {
      ignored.push(untrusted);
      continue;
    }
    if (!seen.some((u) => eqHex(u.base_ref_oid, b.base_ref_oid) && eqHex(u.merge_base_sha, b.merge_base_sha))) seen.push(b);
  }
  const ignoredNote = ignored.length ? ` (ignored ${ignored.length} untrusted binding(s): ${[...new Set(ignored)].join(", ")})` : "";
  cl.require(`${idPrefix}-present`, seen.length >= 1, `no trusted hotfix-review-binding comment found for head=${approvedTip}${ignoredNote}`);
  cl.require(`${idPrefix}-unique`, seen.length === 1, `${seen.length} conflicting hotfix-review-binding value(s) found for head=${approvedTip}`);
  return seen[0];
}

// ---------------------------------------------------------------------------
// remote freshness (F-ehrc-r1-06): every subcommand that reads a
// remote-tracking ref (`origin/<carrier>`, `origin/production`,
// `origin/main`) MUST fetch it first, or a stale local tracking ref can make
// a genuinely out-of-date base/tip look current. `ctx.skipFetch` exists ONLY
// for fixture/test isolation (via run()'s `options.skipFetch`); it is never
// inferred or defaulted on and has no CLI flag (N46).
// ---------------------------------------------------------------------------

function fetchOriginUnlessSkipped(cl, cwd, ctx, remote = "origin") {
  if (ctx.skipFetch) return;
  const fetchResult = git(cwd, ["fetch", remote, "--prune", "--tags"]);
  if (fetchResult.status !== 0) envError(cl, `git fetch ${remote} --prune --tags failed: ${(fetchResult.stderr || "").trim()}`);
}

// ---------------------------------------------------------------------------
// remote tag existence/peel (N43): a `production-*` tag resolved locally
// MUST also exist identically on the remote — a tag that lives only in the
// operator's local clone (or that the remote peels to a different commit)
// MUST NOT be accepted as the anchor or the promoted tag. This runs
// unconditionally (even under `ctx.skipFetch`), since it is a targeted
// `git ls-remote` for one ref, not the broad `git fetch --tags` above.
// ---------------------------------------------------------------------------

function resolveRemoteTagSha(cwd, remote, tagName) {
  // Passing ONLY `refs/tags/<T>` (no wildcard) makes `ls-remote` match the
  // exact advertised ref and never surface the peeled `^{}` line for an
  // annotated tag -- the peeled line is a SEPARATE advertised ref that must
  // be requested by its own exact pattern too (verified empirically; `git
  // ls-remote --tags <remote> refs/tags/<T>` alone drops it).
  const r = git(cwd, ["ls-remote", "--tags", remote, `refs/tags/${tagName}`, `refs/tags/${tagName}^{}`]);
  if (r.status !== 0) {
    return { error: (r.stderr || "").trim() || `git ls-remote --tags ${remote} refs/tags/${tagName} exited ${r.status}` };
  }
  const lines = (r.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
  let plain = null;
  let peeled = null;
  for (const line of lines) {
    const [sha, ref] = line.split(/\s+/);
    // An annotated tag's `^{}` line is the peeled (dereferenced) commit --
    // prefer it over the tag-object SHA on the plain line.
    if (ref === `refs/tags/${tagName}^{}`) peeled = sha;
    else if (ref === `refs/tags/${tagName}`) plain = sha;
  }
  const sha = peeled ?? plain;
  return { sha: sha && HEX40_RE.test(sha) ? sha.toLowerCase() : null };
}

/**
 * Names of the remote tags matching `refs/tags/<glob>` whose peeled commit
 * (the `^{}` line for an annotated tag, else the plain line) equals `sha`.
 */
function listRemoteTagsPeelingTo(cwd, remote, glob, sha) {
  const r = git(cwd, ["ls-remote", "--tags", remote, `refs/tags/${glob}`]);
  if (r.status !== 0) {
    return { error: (r.stderr || "").trim() || `git ls-remote --tags ${remote} refs/tags/${glob} exited ${r.status}` };
  }
  const plain = new Map();
  const peeled = new Map();
  for (const line of (r.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [oid, ref] = line.split(/\s+/);
    if (!ref || !ref.startsWith("refs/tags/")) continue;
    const name = ref.slice("refs/tags/".length);
    if (name.endsWith("^{}")) peeled.set(name.slice(0, -3), oid);
    else plain.set(name, oid);
  }
  const names = [];
  for (const [name, oid] of plain) {
    if (eqHex(peeled.get(name) ?? oid, sha)) names.push(name);
  }
  return { names };
}

// ---------------------------------------------------------------------------
// subcommand: freshness
// ---------------------------------------------------------------------------

function cmdFreshness(args, ctx) {
  const { cwd } = ctx;
  const opts = parseArgs(args);
  const anchorTag = requireStrArg(opts, "--anchor-tag");
  const anchorCommit = requireHexArg(opts, "--anchor-commit");
  const remote = opts["--remote"] || "origin";
  const cl = makeChecklist();

  fetchOriginUnlessSkipped(cl, cwd, ctx, remote);

  // F-ehrc-r1-10: --anchor-tag MUST name an actual `refs/tags/production-*`
  // tag -- a branch (or other ref) name must not silently resolve via git's
  // generic rev-parse ref-type fallback, or the "ANCHOR_TAG is immutable"
  // guarantee below is checking the wrong kind of ref entirely.
  cl.require(
    "freshness.anchor-tag-is-production-tag",
    /^production-/.test(anchorTag),
    `--anchor-tag ${JSON.stringify(anchorTag)} does not start with "production-" (must name a production-* tag, not a branch or other ref)`,
  );

  const tagSha = resolveSha(cwd, `refs/tags/${anchorTag}`);
  if (!tagSha) envError(cl, `cannot resolve refs/tags/${anchorTag}`);
  cl.require(
    "freshness.anchor-tag-unchanged",
    eqHex(tagSha, anchorCommit),
    `anchor tag ${anchorTag} resolves to ${tagSha}, expected --anchor-commit ${anchorCommit}`,
  );

  const unmergedOut = gitOut(cwd, ["tag", "--list", "production-*", "--no-merged", anchorCommit]);
  if (unmergedOut === null) envError(cl, "git tag --list 'production-*' --no-merged <anchor> failed");
  cl.require(
    "freshness.no-unmerged-production-tags",
    unmergedOut === "",
    // D6 next step: a divergent-history tag or a stale locally-cached tag
    // deleted on the remote both fail (a) closed -- there is no lock
    // exception. Re-fetch (dropping deleted remote tags) and rerun, or
    // re-cut the carrier from the latest production-* tag.
    `production-* tag(s) exist that are not ancestors of anchor_commit: ${unmergedOut} (D6: run \`git fetch --prune --prune-tags\` then rerun freshness, or re-cut the carrier from the latest production-* tag)`,
  );

  const originProdSha = resolveSha(cwd, `${remote}/${PRODUCTION_REF}`);
  if (!originProdSha) envError(cl, `cannot resolve ${remote}/${PRODUCTION_REF}`);
  cl.require(
    "freshness.origin-production-matches-anchor",
    eqHex(originProdSha, anchorCommit),
    `${remote}/${PRODUCTION_REF} is at ${originProdSha}, expected anchor_commit ${anchorCommit}`,
  );

  // N43: the anchor tag MUST also exist identically on the remote -- a tag
  // that lives only in the operator's local clone must not be accepted.
  const remoteAnchorTag = resolveRemoteTagSha(cwd, remote, anchorTag);
  if (remoteAnchorTag.error) envError(cl, `git ls-remote --tags ${remote} refs/tags/${anchorTag} failed: ${remoteAnchorTag.error}`);
  cl.require(
    "freshness.anchor-tag-on-remote",
    eqHex(remoteAnchorTag.sha, tagSha),
    `refs/tags/${anchorTag} on remote ${remote} resolves to ${remoteAnchorTag.sha ?? "(absent)"}, expected ${tagSha} (a tag existing only in a local clone MUST NOT be accepted as the anchor)`,
  );

  return cl.checks;
}

// ---------------------------------------------------------------------------
// subcommand: pre-merge
// ---------------------------------------------------------------------------

function cmdPreMerge(args, ctx) {
  const { cwd, ghRunner } = ctx;
  const opts = parseArgs(args);
  const pr = requireIntArg(opts, "--pr");
  const carrier = requireStrArg(opts, "--carrier");
  const approvedTip = requireHexArg(opts, "--approved-tip");
  const baseRefOid = requireHexArg(opts, "--base-ref-oid");
  const mergeBase = requireHexArg(opts, "--merge-base");
  const cl = makeChecklist();

  fetchOriginUnlessSkipped(cl, cwd, ctx);

  const prData = ghPrView(ghRunner, cwd, pr, ["number", "state", "headRefName", "headRefOid", "baseRefName", "comments"]);
  cl.require("pre-merge.gh-state-open", prData.state === "OPEN", `PR #${pr} state is ${JSON.stringify(prData.state)}, expected OPEN`);
  cl.require("pre-merge.gh-head-shape", /^hotfix\//.test(prData.headRefName || ""), `PR #${pr} headRefName ${JSON.stringify(prData.headRefName)} does not match ^hotfix/`);
  cl.require("pre-merge.gh-head-oid", eqHex(prData.headRefOid, approvedTip), `PR #${pr} headRefOid ${prData.headRefOid} != --approved-tip ${approvedTip}`);
  cl.require("pre-merge.gh-base", prData.baseRefName === carrier, `PR #${pr} baseRefName ${JSON.stringify(prData.baseRefName)} != --carrier ${carrier}`);

  const carrierTip = resolveSha(cwd, `origin/${carrier}`);
  if (!carrierTip) envError(cl, `cannot resolve origin/${carrier}`);
  cl.require("pre-merge.git-carrier-tip", eqHex(carrierTip, baseRefOid), `origin/${carrier} tip ${carrierTip} != --base-ref-oid ${baseRefOid}`);

  const mb = gitOut(cwd, ["merge-base", `origin/${carrier}`, approvedTip]);
  if (mb === null || !HEX40_RE.test(mb)) envError(cl, `git merge-base origin/${carrier} ${approvedTip} failed`);
  cl.require("pre-merge.git-merge-base", eqHex(mb, mergeBase), `merge-base ${mb} != --merge-base ${mergeBase}`);

  // N44: review-time binding pins the carrier base the hotfix was approved
  // against -- read from the PR's own comments, never trust the caller.
  const binding = findReviewBinding(cl, ctx, "pre-merge.review-binding", prData.comments, approvedTip, undefined);
  cl.require("pre-merge.review-binding-base-ref-oid", eqHex(binding.base_ref_oid, baseRefOid), `hotfix-review-binding base_ref_oid ${binding.base_ref_oid} != --base-ref-oid ${baseRefOid} (carrier base moved since review)`);
  cl.require("pre-merge.review-binding-merge-base", eqHex(binding.merge_base_sha, mergeBase), `hotfix-review-binding merge_base_sha ${binding.merge_base_sha} != --merge-base ${mergeBase}`);

  return cl.checks;
}

// ---------------------------------------------------------------------------
// subcommand: merge-proof
// ---------------------------------------------------------------------------

function cmdMergeProof(args, ctx) {
  const { cwd, ghRunner } = ctx;
  const opts = parseArgs(args);
  const kind = requireStrArg(opts, "--kind");
  if (kind !== "hotfix" && kind !== "bump") throw new VerifyExit(2, `--kind must be hotfix|bump, got ${JSON.stringify(kind)}`);
  const pr = requireIntArg(opts, "--pr");
  const carrier = requireStrArg(opts, "--carrier");
  const anchorCommit = requireHexArg(opts, "--anchor-commit");
  const approvedTip = optionalHexArg(opts, "--approved-tip");
  const baseRefOid = optionalHexArg(opts, "--base-ref-oid");
  const shape = opts["--shape"] || "merge";
  if (shape !== "merge" && shape !== "ff") throw new VerifyExit(2, `--shape must be merge|ff, got ${JSON.stringify(shape)}`);
  if (shape === "ff" && kind !== "hotfix") throw new VerifyExit(2, "--shape ff is only valid for --kind hotfix");
  if (shape === "ff" && !approvedTip) throw new VerifyExit(2, "--shape ff requires --approved-tip");

  const cl = makeChecklist();
  fetchOriginUnlessSkipped(cl, cwd, ctx);
  // N44: only a --kind hotfix call carrying both --approved-tip and
  // --base-ref-oid ever needs the review-binding comment; a bare topology
  // check (neither flag) or --kind bump never reads/requires it.
  const needsReviewBinding = kind === "hotfix" && Boolean(approvedTip) && Boolean(baseRefOid);
  const prData = ghPrView(ghRunner, cwd, pr, needsReviewBinding ? [...PR_VIEW_FIELDS, "comments"] : PR_VIEW_FIELDS);

  cl.require(
    "merge-proof.gh-state-merged",
    prData.state === "MERGED" && Boolean(prData.mergedAt),
    `PR #${pr} state=${JSON.stringify(prData.state)} mergedAt=${JSON.stringify(prData.mergedAt)}, expected MERGED with mergedAt`,
  );

  const headShapeRe = kind === "hotfix" ? /^hotfix\// : /^chore\/bump-v\d+\.\d+\.\d+$/;
  cl.require("merge-proof.gh-head-shape", headShapeRe.test(prData.headRefName || ""), `PR #${pr} headRefName ${JSON.stringify(prData.headRefName)} does not match expected ${kind} shape`);
  cl.require("merge-proof.gh-base", prData.baseRefName === carrier, `PR #${pr} baseRefName ${JSON.stringify(prData.baseRefName)} != --carrier ${carrier}`);

  if (!prData.mergeCommit || !prData.mergeCommit.oid) envError(cl, `PR #${pr} mergeCommit.oid missing (GitHub record)`);
  const mc = String(prData.mergeCommit.oid).toLowerCase();
  if (!HEX40_RE.test(mc)) envError(cl, `PR #${pr} mergeCommit.oid not 40-hex: ${mc}`);

  if (shape === "ff") {
    // A ff merge has no mc^2 to tie back to the PR head, so bind the GitHub
    // PR head to the reviewed tip directly (D19, F-ehrc-p2-01); the merge
    // shape gets the same guarantee from merge-proof.git-mc-parent2-eq-head.
    cl.require("merge-proof.gh-head-oid-eq-approved-tip", eqHex(prData.headRefOid, approvedTip), `PR #${pr} headRefOid ${prData.headRefOid} != --approved-tip ${approvedTip} for ff shape`);
    cl.require("merge-proof.git-shape-ff-eq-tip", eqHex(mc, approvedTip), `mergeCommit.oid ${mc} != --approved-tip ${approvedTip} for ff shape`);
    // D4 Merge 內容完整性 table (hotfix unit, shape ff): base_ref_oid MUST be
    // an ancestor of approved_tip, or a fast-forward could "ff" straight
    // past a sibling unit's base without the merge-shape parent1 check ever
    // running (F-ehrc-r1-14).
    const ffAncestorOk = Boolean(baseRefOid) && isAncestor(cwd, baseRefOid, approvedTip) === true;
    cl.require(
      "merge-proof.git-shape-ff-base-ref-oid-ancestor",
      ffAncestorOk,
      baseRefOid
        ? `--base-ref-oid ${baseRefOid} is not an ancestor of --approved-tip ${approvedTip} for ff shape`
        : "--shape ff requires --base-ref-oid (an ancestor of --approved-tip)",
    );
  } else {
    const parents = parentsOf(cwd, mc);
    if (parents == null) envError(cl, `cannot resolve parents of merge commit ${mc}`);
    cl.require("merge-proof.git-mc-two-parents", parents.length === 2, `merge commit ${mc} has ${parents.length} parent(s), expected 2`);
    const [p1, p2] = parents;
    cl.require("merge-proof.git-mc-parent2-eq-head", eqHex(p2, prData.headRefOid), `mc^2 ${p2} != GitHub headRefOid ${prData.headRefOid}`);
    if (kind === "hotfix") {
      if (approvedTip) cl.require("merge-proof.git-mc-parent2-eq-approved-tip", eqHex(p2, approvedTip), `mc^2 ${p2} != --approved-tip ${approvedTip}`);
      if (baseRefOid) cl.require("merge-proof.git-mc-parent1-eq-base-ref-oid", eqHex(p1, baseRefOid), `mc^1 ${p1} != --base-ref-oid ${baseRefOid} (sibling merge-in or out-of-order)`);
    } else {
      cl.require("merge-proof.git-mc-parent1-eq-anchor", eqHex(p1, anchorCommit), `mc^1 ${p1} != --anchor-commit ${anchorCommit} (not bump-first)`);
    }
    const mcTree = treeOf(cwd, mc);
    requireCleanMergeTree(cl, cwd, "merge-proof.content-integrity", p1, p2, mcTree);
  }

  const fpList = firstParentList(cwd, `origin/${carrier}`);
  if (fpList === null) envError(cl, `cannot resolve origin/${carrier} first-parent chain`);
  cl.require("merge-proof.git-mc-on-carrier-first-parent-chain", fpList.includes(mc), `merge commit ${mc} not on origin/${carrier} first-parent chain`);

  if (needsReviewBinding) {
    // N44: review-time binding pins the carrier base the hotfix was
    // approved against -- read from the PR's own comments.
    const binding = findReviewBinding(cl, ctx, "merge-proof.review-binding", prData.comments, approvedTip, prData.mergedAt ?? null);
    cl.require("merge-proof.review-binding-base-ref-oid", eqHex(binding.base_ref_oid, baseRefOid), `hotfix-review-binding base_ref_oid ${binding.base_ref_oid} != --base-ref-oid ${baseRefOid} (carrier base moved since review)`);
  }

  return cl.checks;
}

// ---------------------------------------------------------------------------
// subcommand: pre-promote
// ---------------------------------------------------------------------------

function verifyBumpProvenance(cl, cwd, ghRunner, carrier, record) {
  const bump = record.bump;
  const prNum = Number(bump.pr);
  if (!Number.isInteger(prNum) || prNum <= 0) throw new VerifyExit(1, `bump= pr not a positive integer: ${JSON.stringify(bump.pr)}`);
  const prData = ghPrView(ghRunner, cwd, prNum, PR_VIEW_FIELDS);

  cl.require(
    "pre-promote.bump-gh-state-merged",
    prData.state === "MERGED" && Boolean(prData.mergedAt),
    `bump PR #${prNum} state=${JSON.stringify(prData.state)} mergedAt=${JSON.stringify(prData.mergedAt)}, expected MERGED`,
  );
  const headRe = record.lane === "source"
    ? new RegExp(`^chore/bump-v${(sourceVersionFromCarrier(carrier) || "\\d+\\.\\d+\\.\\d+").replace(/\./g, "\\.")}$`)
    : /^chore\/bump-v\d+\.\d+\.\d+$/;
  cl.require("pre-promote.bump-gh-head-shape", headRe.test(prData.headRefName || ""), `bump PR #${prNum} headRefName ${JSON.stringify(prData.headRefName)} does not match expected shape`);
  cl.require("pre-promote.bump-gh-base", prData.baseRefName === carrier, `bump PR #${prNum} baseRefName ${JSON.stringify(prData.baseRefName)} != carrier ${carrier}`);
  cl.require("pre-promote.bump-gh-head-oid", eqHex(prData.headRefOid, bump.head), `bump PR #${prNum} headRefOid ${prData.headRefOid} != recorded head=${bump.head}`);
  if (!prData.mergeCommit || !prData.mergeCommit.oid) envError(cl, `bump PR #${prNum} mergeCommit.oid missing`);
  cl.require("pre-promote.bump-gh-mc", eqHex(prData.mergeCommit.oid, bump.mc), `bump PR #${prNum} mergeCommit.oid ${prData.mergeCommit.oid} != recorded mc=${bump.mc}`);

  const parents = parentsOf(cwd, bump.mc);
  if (!parents) envError(cl, `cannot resolve parents of bump mc ${bump.mc}`);
  cl.require("pre-promote.bump-git-two-parents", parents.length === 2, `bump mc ${bump.mc} has ${parents.length} parent(s), expected 2 (direct carrier commit cannot masquerade as a bump)`);
  cl.require("pre-promote.bump-git-parent2-eq-head", eqHex(parents[1], bump.head), `bump mc^2 ${parents[1]} != recorded head=${bump.head}`);
  // Implied today by chain-anchored-at-anchor-commit + chain-matches-record
  // under fail-fast; kept so the named D4 bump-first condition survives a reorder.
  cl.require("pre-promote.bump-git-parent1-eq-anchor", eqHex(parents[0], record.anchor_commit), `bump mc^1 ${parents[0]} != anchor_commit ${record.anchor_commit} (not bump-first)`);

  const mcTree = treeOf(cwd, bump.mc);
  requireCleanMergeTree(cl, cwd, "pre-promote.bump-content-integrity", parents[0], parents[1], mcTree);
}

function verifyRevertShape(cl, cwd, record, unit) {
  const M = unit.reverts;
  cl.require("pre-promote.revert-reverts-present", Boolean(M) && HEX40_RE.test(M || ""), "unit missing/invalid reverts= (required to claim bump: N/A on consumer-rules)");

  const mParents = parentsOf(cwd, M);
  if (!mParents) envError(cl, `cannot resolve parents of reverts= ${M}`);
  cl.require("pre-promote.revert-M-two-parents", mParents.length === 2, `reverts= ${M} is not a 2-parent merge commit`);

  const fpProd = firstParentList(cwd, "origin/production");
  if (fpProd === null) envError(cl, "cannot resolve origin/production first-parent chain");
  cl.require("pre-promote.revert-M-on-production-first-parent", fpProd.includes(M), `reverts= ${M} is not on origin/production first-parent chain`);

  const ancestorOk = M === record.anchor_commit || isAncestor(cwd, M, record.anchor_commit) === true;
  // Implied today by freshness (b) + revert-M-on-production-first-parent;
  // kept so the named D14 condition survives a change to either.
  cl.require("pre-promote.revert-M-ancestor-of-anchor", ancestorOk, `reverts= ${M} is not an ancestor of (or equal to) anchor_commit ${record.anchor_commit}`);

  // rules-revert-local-tag-forgery (N43 parity): the rules tag MUST be one
  // published on the remote and peel to M -- a tag that exists only in the
  // operator's clone cannot make a plain production merge look rules-lane.
  const remoteRulesTags = listRemoteTagsPeelingTo(cwd, "origin", "production-*", M);
  if (remoteRulesTags.error) envError(cl, `git ls-remote --tags origin refs/tags/production-* failed: ${remoteRulesTags.error}`);
  const hasRulesTag = remoteRulesTags.names.some((t) => RULES_TAG_RE.test(t));
  cl.require("pre-promote.revert-M-has-rules-tag", hasRulesTag, `reverts= ${M} has no production-<date>-rules[-n] tag on remote origin (must revert a published rules-lane production merge; a local-only tag is not accepted)`);

  const unitParents = parentsOf(cwd, unit.approved_tip);
  if (!unitParents) envError(cl, `cannot resolve parents of approved_tip ${unit.approved_tip}`);
  cl.require("pre-promote.revert-unit-one-parent", unitParents.length === 1, `approved_tip ${unit.approved_tip} is not a single-commit unit`);
  cl.require("pre-promote.revert-unit-parent-eq-anchor", eqHex(unitParents[0], record.anchor_commit), `approved_tip^1 ${unitParents[0]} != anchor_commit ${record.anchor_commit} (unit must sit directly on anchor)`);

  const approvedTipTree = treeOf(cwd, unit.approved_tip);
  requireCleanMergeTree(cl, cwd, "pre-promote.revert-shape", record.anchor_commit, mParents[0], approvedTipTree, {
    extraArgs: [`--merge-base=${M}`],
  });
}

function verifyUnitProvenance(cl, ctx, carrier, record, unit, previousMc) {
  const { cwd, ghRunner } = ctx;
  const prNum = Number(unit.pr);
  if (!Number.isInteger(prNum) || prNum <= 0) throw new VerifyExit(1, `unit= pr not a positive integer: ${JSON.stringify(unit.pr)}`);
  const prData = ghPrView(ghRunner, cwd, prNum, [...PR_VIEW_FIELDS, "comments"]);

  cl.require(
    "pre-promote.unit-gh-state-merged",
    prData.state === "MERGED" && Boolean(prData.mergedAt),
    `unit PR #${prNum} state=${JSON.stringify(prData.state)} mergedAt=${JSON.stringify(prData.mergedAt)}, expected MERGED`,
  );
  const headShapeRe = record.lane === "consumer-rules" ? /^hotfix\/revert-rules-/ : /^hotfix\//;
  cl.require("pre-promote.unit-gh-head-shape", headShapeRe.test(prData.headRefName || ""), `unit PR #${prNum} headRefName ${JSON.stringify(prData.headRefName)} does not match required shape`);
  cl.require("pre-promote.unit-gh-head-oid", eqHex(prData.headRefOid, unit.approved_tip), `unit PR #${prNum} headRefOid ${prData.headRefOid} != recorded approved_tip=${unit.approved_tip}`);
  cl.require("pre-promote.unit-gh-base", prData.baseRefName === carrier, `unit PR #${prNum} baseRefName ${JSON.stringify(prData.baseRefName)} != carrier ${carrier}`);
  if (!prData.mergeCommit || !prData.mergeCommit.oid) envError(cl, `unit PR #${prNum} mergeCommit.oid missing`);
  cl.require("pre-promote.unit-gh-mc", eqHex(prData.mergeCommit.oid, unit.mc), `unit PR #${prNum} mergeCommit.oid ${prData.mergeCommit.oid} != recorded mc=${unit.mc}`);

  if (unit.shape === "ff") {
    cl.require("pre-promote.unit-shape-ff", eqHex(unit.mc, unit.approved_tip), `ff shape requires mc ${unit.mc} == approved_tip ${unit.approved_tip}`);
    // D4 Merge 內容完整性 table (hotfix unit, shape ff): base_ref_oid MUST
    // be an ancestor of approved_tip (F-ehrc-r1-14; parseUnitLine already
    // requires base_ref_oid to be present, so there is no "cannot get it"
    // escape here the way there might be for merge-proof's optional flag).
    cl.require(
      "pre-promote.unit-shape-ff-base-ref-oid-ancestor",
      isAncestor(cwd, unit.base_ref_oid, unit.approved_tip) === true,
      `ff shape requires base_ref_oid ${unit.base_ref_oid} to be an ancestor of approved_tip ${unit.approved_tip}`,
    );
    // hotfix-ff-stale-base: a fast-forward moves the carrier from the
    // preceding chain point straight to approved_tip, so the base the unit
    // was reviewed against MUST be that chain point -- an older ancestor
    // means the review never saw the units merged in between.
    cl.require(
      "pre-promote.unit-shape-ff-base-ref-oid-eq-previous-mc",
      eqHex(unit.base_ref_oid, previousMc),
      `ff shape requires base_ref_oid ${unit.base_ref_oid} == previous chain point ${previousMc} (stale review base)`,
    );
  } else {
    const parents = parentsOf(cwd, unit.mc);
    if (!parents) envError(cl, `cannot resolve parents of unit mc ${unit.mc}`);
    cl.require("pre-promote.unit-two-parents", parents.length === 2, `unit mc ${unit.mc} has ${parents.length} parent(s), expected 2`);
    cl.require("pre-promote.unit-parent2-eq-approved-tip", eqHex(parents[1], unit.approved_tip), `unit mc^2 ${parents[1]} != approved_tip ${unit.approved_tip}`);
    cl.require("pre-promote.unit-parent1-eq-base-ref-oid", eqHex(parents[0], unit.base_ref_oid), `unit mc^1 ${parents[0]} != base_ref_oid ${unit.base_ref_oid}`);
    cl.require("pre-promote.unit-parent1-eq-previous-mc", eqHex(parents[0], previousMc), `unit mc^1 ${parents[0]} != previous chain point ${previousMc} (sibling merge-in or out-of-order)`);
    const mcTree = treeOf(cwd, unit.mc);
    requireCleanMergeTree(cl, cwd, "pre-promote.unit-content-integrity", parents[0], parents[1], mcTree);
  }

  if (record.lane === "consumer-rules" && record.bump === "N/A") {
    verifyRevertShape(cl, cwd, record, unit);
  }

  // N44: each unit's approved_tip/base_ref_oid/merge_base_sha MUST equal the
  // review binding recorded on that unit PR at review time.
  const binding = findReviewBinding(cl, ctx, "pre-promote.unit-review-binding", prData.comments, unit.approved_tip, prData.mergedAt ?? null);
  cl.require("pre-promote.unit-review-binding-base-ref-oid", eqHex(binding.base_ref_oid, unit.base_ref_oid), `unit PR #${prNum} hotfix-review-binding base_ref_oid ${binding.base_ref_oid} != recorded base_ref_oid=${unit.base_ref_oid}`);
  cl.require("pre-promote.unit-review-binding-merge-base", eqHex(binding.merge_base_sha, unit.merge_base_sha), `unit PR #${prNum} hotfix-review-binding merge_base_sha ${binding.merge_base_sha} != recorded merge_base_sha=${unit.merge_base_sha}`);
}

function checkBumpNaApplicability(cl, cwd, record, ctx) {
  if (record.lane === "source") {
    cl.require("pre-promote.bump-na-source-forbidden", false, "lane=source MUST always bump; bump: N/A is never accepted");
    return;
  }
  if (record.lane === "consumer") {
    const patterns = loadVersionMetadataFiles(getRepoRootLazy(ctx));
    const anchorHas = treeHasVersionFile(cwd, record.anchor_commit, patterns);
    if (anchorHas === null) envError(cl, `cannot list tree at anchor_commit ${record.anchor_commit}`);
    const carrierHas = treeHasVersionFile(cwd, record.carrier_sha, patterns);
    if (carrierHas === null) envError(cl, `cannot list tree at carrier_sha ${record.carrier_sha}`);
    cl.require(
      "pre-promote.bump-na-consumer-no-version-files",
      !anchorHas && !carrierHas,
      `consumer bump: N/A requires no version-metadata-files match in anchor or carrier tree (anchor:${anchorHas} carrier:${carrierHas})`,
    );
    return;
  }
  // lane === "consumer-rules": revert-shape per unit is checked from verifyUnitProvenance.
}

function getRepoRootLazy(ctx) {
  if (ctx.repoRoot) return ctx.repoRoot;
  const r = git(ctx.cwd, ["rev-parse", "--show-toplevel"]);
  if (r.status !== 0) throw new VerifyExit(2, `cannot resolve repo root from cwd ${ctx.cwd}: ${(r.stderr || "").trim()}`);
  ctx.repoRoot = r.stdout.trim();
  return ctx.repoRoot;
}

function cmdPrePromote(args, ctx) {
  const { cwd, ghRunner } = ctx;
  const opts = parseArgs(args);
  const carrier = requireStrArg(opts, "--carrier");
  const bodyFile = opts["--body-file"];
  const productionPr = opts["--production-pr"];
  if (!bodyFile && !productionPr) throw new VerifyExit(2, "one of --body-file or --production-pr is required");
  if (bodyFile && productionPr) throw new VerifyExit(2, "--body-file and --production-pr are mutually exclusive");

  const cl = makeChecklist();

  let body;
  let prData = null;
  let prNum = null;
  if (bodyFile) {
    try {
      body = readFileSync(path.resolve(cwd, bodyFile), "utf8");
    } catch (err) {
      envError(cl, `cannot read --body-file ${bodyFile}: ${err.message}`);
    }
  } else {
    prNum = Number(productionPr);
    if (!Number.isInteger(prNum) || prNum <= 0) throw new VerifyExit(2, `--production-pr must be a positive integer, got ${JSON.stringify(productionPr)}`);
    prData = ghPrView(ghRunner, cwd, prNum, PR_VIEW_FIELDS_WITH_BODY);
    body = prData.body || "";
  }

  const record = parseProvenanceBlockChecked(cl, body);

  // D5 / proposal Risk Classes (write): artifact_id/built_at/gates/carrier
  // are keys parseProvenanceBlock only checks for PRESENCE (F-ehrc-r1-07) --
  // their content is validated here, where --carrier is in scope.
  cl.require("pre-promote.provenance-artifact-id-nonempty", record.artifact_id.trim().length > 0, `provenance artifact_id is empty`);
  cl.require("pre-promote.provenance-built-at-utc-z", BUILT_AT_UTC_RE.test(record.built_at), `provenance built_at ${JSON.stringify(record.built_at)} is not a UTC instant ending in Z (expected YYYY-MM-DDTHH:MM:SS[.fff]Z)`);
  cl.require("pre-promote.provenance-gates-nonempty", record.gates.trim().length > 0, `provenance gates is empty`);
  // N45: every comma-separated gates entry MUST be `<name>=pass`, and the
  // set MUST include `smoke=pass`.
  const gateEntries = record.gates.split(",").map((s) => s.trim());
  const gatesFormatOk = gateEntries.every((e) => GATE_ENTRY_RE.test(e));
  cl.require("pre-promote.provenance-gates-format", gatesFormatOk, `provenance gates ${JSON.stringify(record.gates)} has an entry not matching <name>=pass`);
  cl.require("pre-promote.provenance-gates-smoke", gateEntries.includes("smoke=pass"), `provenance gates ${JSON.stringify(record.gates)} has no smoke=pass entry`);
  cl.require("pre-promote.provenance-carrier-matches", record.carrier === carrier, `provenance carrier ${JSON.stringify(record.carrier)} != --carrier ${carrier}`);

  cl.require("pre-promote.lane-carrier-naming", laneMatchesCarrier(record.lane, carrier), `lane ${record.lane} does not match carrier naming ${carrier}`);

  fetchOriginUnlessSkipped(cl, cwd, ctx);

  const carrierTip = resolveSha(cwd, `origin/${carrier}`);
  if (!carrierTip) envError(cl, `cannot resolve origin/${carrier}`);
  cl.require("pre-promote.carrier-sha-matches-tip", eqHex(carrierTip, record.carrier_sha), `origin/${carrier} tip ${carrierTip} != block carrier_sha ${record.carrier_sha}`);

  if (prData) {
    cl.require("pre-promote.production-pr-state-open", prData.state === "OPEN", `production PR #${prNum} state ${JSON.stringify(prData.state)}, expected OPEN`);
    cl.require("pre-promote.production-pr-head", prData.headRefName === carrier, `production PR #${prNum} head ${JSON.stringify(prData.headRefName)} != carrier ${carrier}`);
    cl.require("pre-promote.production-pr-head-oid", eqHex(prData.headRefOid, record.carrier_sha), `production PR #${prNum} headRefOid ${prData.headRefOid} != carrier_sha ${record.carrier_sha}`);
    cl.require("pre-promote.production-pr-base", prData.baseRefName === "production", `production PR #${prNum} base ${JSON.stringify(prData.baseRefName)} != production`);
  }

  try {
    // Real promotion gate MUST always fetch (D6: no exceptions). `ctx`
    // (including `ctx.skipFetch`) is shared with this whole `run()` call, so
    // fixture/test isolation flows through unchanged without re-deriving a
    // CLI-flag-shaped forward.
    const innerArgs = ["--anchor-tag", record.anchor_tag, "--anchor-commit", record.anchor_commit];
    const freshnessChecks = cmdFreshness(innerArgs, ctx);
    cl.checks.push(...freshnessChecks);
  } catch (err) {
    mergeInnerVerifyExit(cl, err);
  }

  const chain = firstParentChainBetween(cwd, record.anchor_commit, record.carrier_sha);
  if (chain === null) envError(cl, `cannot walk first-parent chain from anchor_commit ${record.anchor_commit} to carrier_sha ${record.carrier_sha}`);
  if (chain.length === 0) {
    cl.require("pre-promote.chain-nonempty", false, "no commits between anchor_commit and carrier_sha, but the provenance block requires at least one unit");
  } else {
    const oldestParents = parentsOf(cwd, chain[0]);
    if (!oldestParents) envError(cl, `cannot resolve parents of oldest chain commit ${chain[0]}`);
    cl.require("pre-promote.chain-anchored-at-anchor-commit", eqHex(oldestParents[0], record.anchor_commit), `oldest chain commit ${chain[0]} ^1 = ${oldestParents[0]}, expected anchor_commit ${record.anchor_commit} (anchor is not an ancestor / carrier not cut from latest tag)`);
  }
  const expectedChain = [];
  if (record.bump !== "N/A") expectedChain.push(record.bump.mc);
  for (const unit of record.units) expectedChain.push(unit.mc);
  cl.require(
    "pre-promote.chain-matches-record",
    arraysEqualHex(chain, expectedChain),
    `carrier first-parent chain [${chain.join(",")}] != recorded MC sequence [${expectedChain.join(",")}] (missing/extra/out-of-order commit)`,
  );

  if (record.bump === "N/A") {
    checkBumpNaApplicability(cl, cwd, record, ctx);
  } else {
    verifyBumpProvenance(cl, cwd, ghRunner, carrier, record);
  }

  let previousMc = record.bump === "N/A" ? record.anchor_commit : record.bump.mc;
  for (const unit of record.units) {
    verifyUnitProvenance(cl, ctx, carrier, record, unit, previousMc);
    previousMc = unit.mc;
  }

  // mutable-artifact-provenance: report the block digest -- only once every
  // check above passed, so a failed pre-promote never yields a digest the
  // recipe could carry on with -- for post-promote's --provenance-sha256.
  cl.pass("pre-promote.provenance-sha256", provenanceDigest(body));
  return cl.checks;
}

// ---------------------------------------------------------------------------
// subcommand: post-promote
// ---------------------------------------------------------------------------

function cmdPostPromote(args, ctx) {
  const { cwd, ghRunner } = ctx;
  const opts = parseArgs(args);
  const tag = requireStrArg(opts, "--tag");
  const carrier = requireStrArg(opts, "--carrier");
  const carrierSha = requireHexArg(opts, "--carrier-sha");
  const anchorCommit = requireHexArg(opts, "--anchor-commit");
  const productionPr = requireIntArg(opts, "--production-pr");
  const provenanceSha256 = requireStrArg(opts, "--provenance-sha256");
  if (!/^[0-9a-f]{64}$/i.test(provenanceSha256)) throw new VerifyExit(2, `--provenance-sha256 must be 64-hex (pre-promote's pre-promote.provenance-sha256 detail), got ${JSON.stringify(provenanceSha256)}`);
  const shape = opts["--shape"] || "merge";
  if (shape !== "merge" && shape !== "ff") throw new VerifyExit(2, `--shape must be merge|ff, got ${JSON.stringify(shape)}`);
  const backMergePr = opts["--back-merge-pr"];

  const cl = makeChecklist();
  fetchOriginUnlessSkipped(cl, cwd, ctx);

  const prData = ghPrView(ghRunner, cwd, productionPr, PR_VIEW_FIELDS_WITH_BODY);
  cl.require("post-promote.production-pr-state-merged", prData.state === "MERGED" && Boolean(prData.mergedAt), `production PR #${productionPr} state=${JSON.stringify(prData.state)} mergedAt=${JSON.stringify(prData.mergedAt)}, expected MERGED`);
  cl.require("post-promote.production-pr-head", prData.headRefName === carrier, `production PR #${productionPr} head ${JSON.stringify(prData.headRefName)} != carrier ${carrier}`);
  cl.require("post-promote.production-pr-head-oid", eqHex(prData.headRefOid, carrierSha), `production PR #${productionPr} headRefOid ${prData.headRefOid} != carrier_sha ${carrierSha}`);
  cl.require("post-promote.production-pr-base", prData.baseRefName === "production", `production PR #${productionPr} base ${JSON.stringify(prData.baseRefName)} != production`);

  // F-ehrc-r1-10: --tag MUST name an actual `refs/tags/production-*` tag,
  // not a branch or other ref that happens to resolve via git's generic
  // ref-type fallback.
  cl.require(
    "post-promote.tag-is-production-tag",
    /^production-/.test(tag),
    `--tag ${JSON.stringify(tag)} does not start with "production-" (must name a production-* tag, not a branch or other ref)`,
  );

  const mergeSha = resolveSha(cwd, `refs/tags/${tag}`);
  if (!mergeSha) envError(cl, `cannot resolve refs/tags/${tag}`);
  if (!prData.mergeCommit || !prData.mergeCommit.oid) envError(cl, `production PR #${productionPr} mergeCommit.oid missing`);
  cl.require("post-promote.production-pr-mc-eq-tag", eqHex(prData.mergeCommit.oid, mergeSha), `production PR #${productionPr} mergeCommit.oid ${prData.mergeCommit.oid} != tag ${tag} commit ${mergeSha}`);

  const fpProd = firstParentList(cwd, "origin/production");
  if (fpProd === null) envError(cl, "cannot resolve origin/production first-parent chain");
  cl.require("post-promote.merge-sha-on-production-first-parent", fpProd.includes(mergeSha), `MERGE_SHA ${mergeSha} not on origin/production first-parent chain`);

  if (shape === "ff") {
    cl.require("post-promote.ff-eq-carrier-sha", eqHex(mergeSha, carrierSha), `ff shape requires MERGE_SHA ${mergeSha} == carrier_sha ${carrierSha}`);
  } else {
    const parents = parentsOf(cwd, mergeSha);
    if (!parents) envError(cl, `cannot resolve parents of MERGE_SHA ${mergeSha}`);
    cl.require("post-promote.merge-two-parents", parents.length === 2, `MERGE_SHA ${mergeSha} has ${parents.length} parent(s), expected 2`);
    cl.require("post-promote.merge-parent1-eq-anchor", eqHex(parents[0], anchorCommit), `MERGE_SHA^1 ${parents[0]} != anchor_commit ${anchorCommit} (production advanced mid-promotion)`);
    cl.require("post-promote.merge-parent2-eq-carrier-sha", eqHex(parents[1], carrierSha), `MERGE_SHA^2 ${parents[1]} != carrier_sha ${carrierSha}`);
    const carrierTree = treeOf(cwd, carrierSha);
    if (!carrierTree) envError(cl, `cannot resolve tree of carrier_sha ${carrierSha}`);
    // Sanity: anchor and carrier_sha must be cleanly mergeable in principle
    // (mostly always true once parent1/parent2 above are verified — this
    // catches a genuinely divergent anchor/carrier pairing).
    const mt = mergeTreeSpawn(cwd, [parents[0], parents[1]]);
    if (mt.status === 1) {
      cl.require("post-promote.production-content-integrity.clean", false, `merge-tree ${parents[0]} ${parents[1]} produced conflicts`);
    }
    if (mt.status !== 0) envError(cl, `merge-tree ${parents[0]} ${parents[1]} errored (status ${mt.status}): ${(mt.stderr || "").trim()}`);
    cl.pass("post-promote.production-content-integrity.clean", "merge-tree recompute is clean");
    // The decisive check: the ACTUAL production merge commit's own tree MUST
    // equal the carrier's tree — a content-discarding strategy (e.g. `-s
    // ours`) or an altered merge commit fails this even when parent topology
    // and GitHub state both look correct.
    const mergeShaTree = treeOf(cwd, mergeSha);
    if (!mergeShaTree) envError(cl, `cannot resolve tree of MERGE_SHA ${mergeSha}`);
    cl.require(
      "post-promote.production-content-integrity.tree-eq",
      eqHex(mergeShaTree, carrierTree),
      `MERGE_SHA tree ${mergeShaTree} != carrier_sha tree ${carrierTree} (content-discarding production merge)`,
    );
  }

  const carrierTip = resolveSha(cwd, `origin/${carrier}`);
  if (carrierTip && !eqHex(carrierTip, carrierSha)) {
    // 5c ("carrier advanced past MERGE_SHA -> the tag tree MUST still equal
    // the recorded carrier_sha tree") is enforced by the check below plus
    // the merge/ff content-integrity checks above, not by a separate tree
    // comparison here: once carrier-advanced-eq-merge-sha establishes
    // MERGE_SHA == origin/<carrier> tip, `tag`'s tree IS MERGE_SHA's tree
    // (the tag points at MERGE_SHA -- see production-pr-mc-eq-tag above),
    // and MERGE_SHA's tree was already proven == carrier_sha's tree by
    // production-content-integrity.tree-eq (merge shape) or ff-eq-carrier-sha
    // (ff shape). A separate `tag^{tree} == carrier_sha^{tree}` check here
    // can never be the first check to fail given the two above, so it was
    // removed rather than kept as untestable dead code (F-ehrc-r1-03).
    cl.require("post-promote.carrier-advanced-eq-merge-sha", eqHex(carrierTip, mergeSha), `origin/${carrier} has advanced to ${carrierTip}; MUST equal MERGE_SHA ${mergeSha} (5c) when it no longer equals carrier_sha`);
  }

  // N43: the promoted tag MUST also exist identically on the remote -- a
  // tag that lives only in the operator's local clone must not be accepted.
  const remoteTag = resolveRemoteTagSha(cwd, "origin", tag);
  if (remoteTag.error) envError(cl, `git ls-remote --tags origin refs/tags/${tag} failed: ${remoteTag.error}`);
  cl.require(
    "post-promote.tag-on-remote",
    eqHex(remoteTag.sha, mergeSha),
    `refs/tags/${tag} on remote origin resolves to ${remoteTag.sha ?? "(absent)"}, expected ${mergeSha} (a tag existing only in a local clone MUST NOT be accepted as promoted)`,
  );

  // mutable-artifact-provenance: the production PR body is editable, so the
  // provenance block pre-promote verified MUST still be the one on record --
  // same digest (artifact_id/gates/units unchanged) and bound to this
  // carrier/carrier_sha/anchor_commit.
  const digestNow = provenanceDigest(prData.body);
  cl.require("post-promote.provenance-block-present", digestNow !== null, `production PR #${productionPr} body has no single hotfix-carrier-provenance block`);
  cl.require(
    "post-promote.provenance-sha256-unchanged",
    eqHex(digestNow, provenanceSha256),
    `production PR #${productionPr} provenance block digest ${digestNow} != --provenance-sha256 ${provenanceSha256} (block edited after pre-promote)`,
  );
  let record;
  try {
    record = parseProvenanceBlock(prData.body);
  } catch (err) {
    if (!(err instanceof VerifyExit)) throw err;
    cl.require("post-promote.provenance-block-parsed", false, err.message);
  }
  cl.require("post-promote.provenance-carrier", record.carrier === carrier, `provenance carrier ${JSON.stringify(record.carrier)} != --carrier ${carrier}`);
  cl.require("post-promote.provenance-carrier-sha", eqHex(record.carrier_sha, carrierSha), `provenance carrier_sha ${record.carrier_sha} != --carrier-sha ${carrierSha}`);
  cl.require("post-promote.provenance-anchor-commit", eqHex(record.anchor_commit, anchorCommit), `provenance anchor_commit ${record.anchor_commit} != --anchor-commit ${anchorCommit}`);

  if (backMergePr) {
    const bmNum = Number(backMergePr);
    if (!Number.isInteger(bmNum) || bmNum <= 0) throw new VerifyExit(2, `--back-merge-pr must be a positive integer, got ${JSON.stringify(backMergePr)}`);
    const bmData = ghPrView(ghRunner, cwd, bmNum, PR_VIEW_FIELDS);
    cl.require("post-promote.back-merge-state-merged", bmData.state === "MERGED" && Boolean(bmData.mergedAt), `back-merge PR #${bmNum} state=${JSON.stringify(bmData.state)} mergedAt=${JSON.stringify(bmData.mergedAt)}, expected MERGED (an OPEN back-merge PR MUST NOT be treated as completing Step 6A)`);
    cl.require("post-promote.back-merge-head", bmData.headRefName === carrier, `back-merge PR #${bmNum} head ${JSON.stringify(bmData.headRefName)} != carrier ${carrier}`);
    cl.require("post-promote.back-merge-base", bmData.baseRefName === "main", `back-merge PR #${bmNum} base ${JSON.stringify(bmData.baseRefName)} != main`);
    cl.require("post-promote.back-merge-head-oid-eq-merge-sha", eqHex(bmData.headRefOid, mergeSha), `back-merge PR #${bmNum} headRefOid ${bmData.headRefOid} != synced carrier tip (MERGE_SHA) ${mergeSha}`);
    if (!bmData.mergeCommit || !bmData.mergeCommit.oid) envError(cl, `back-merge PR #${bmNum} mergeCommit.oid missing`);
    const BM = String(bmData.mergeCommit.oid).toLowerCase();

    const fpMain = firstParentList(cwd, "origin/main");
    if (fpMain === null) envError(cl, "cannot resolve origin/main first-parent chain");
    cl.require("post-promote.back-merge-BM-on-main-first-parent", fpMain.includes(BM), `back-merge commit ${BM} is not on origin/main first-parent chain`);

    const bmParents = parentsOf(cwd, BM);
    if (!bmParents) envError(cl, `cannot resolve parents of back-merge commit ${BM}`);
    cl.require("post-promote.back-merge-BM-two-parents", bmParents.length === 2, `back-merge commit ${BM} has ${bmParents.length} parent(s), expected 2`);
    cl.require("post-promote.back-merge-BM-parent2-eq-merge-sha", eqHex(bmParents[1], mergeSha), `BM^2 ${bmParents[1]} != synced carrier tip (MERGE_SHA) ${mergeSha}`);

    const bmTree = treeOf(cwd, BM);
    requireCleanMergeTree(cl, cwd, "post-promote.back-merge-content-integrity", bmParents[0], bmParents[1], bmTree, {
      conflictHint: " — resolve via detect-branch-base.mjs --reconciliation-status (content-review-required); do not resolve on the carrier or back-merge head",
    });
  }

  return cl.checks;
}

// ---------------------------------------------------------------------------
// subcommand: merge-target
// ---------------------------------------------------------------------------

// The cross-model merge gate cannot read a shell variable, so each Step 7
// `gh pr merge` names its PR literally. `--match-head-commit` pins only the
// head SHA, which the carrier's production PR and back-merge PR share, so this
// check binds the literal number to the carrier PR for one base before the
// merge. headRefName omits the head repository, so a fork can open a PR with
// the same branch name, base and even commit; GitHub keeps at most one open PR
// per head repository branch and base, so only a same-repository open PR with
// head == carrier and base == --base is the PR the merge may name.
const MERGE_TARGET_BASES = new Set([PRODUCTION_REF, "main"]);

function cmdMergeTarget(args, ctx) {
  const { cwd, ghRunner } = ctx;
  const opts = parseArgs(args);
  const pr = requireIntArg(opts, "--pr");
  const carrier = requireStrArg(opts, "--carrier");
  const base = requireStrArg(opts, "--base");
  if (!MERGE_TARGET_BASES.has(base)) throw new VerifyExit(2, `--base must be production|main, got ${JSON.stringify(base)}`);
  const cl = makeChecklist();

  const prData = ghPrView(ghRunner, cwd, pr, ["state", "isCrossRepository", "headRefName", "baseRefName"]);
  cl.require("merge-target.state-open", prData.state === "OPEN", `PR #${pr} state ${JSON.stringify(prData.state)}, expected OPEN`);
  cl.require("merge-target.same-repository", prData.isCrossRepository === false, `PR #${pr} isCrossRepository ${JSON.stringify(prData.isCrossRepository)}, expected false (the carrier lives in this repository; a fork PR can reuse its branch name)`);
  cl.require("merge-target.head", prData.headRefName === carrier, `PR #${pr} head ${JSON.stringify(prData.headRefName)} != carrier ${carrier}`);
  cl.require("merge-target.base", prData.baseRefName === base, `PR #${pr} base ${JSON.stringify(prData.baseRefName)} != ${base}`);

  return cl.checks;
}

// ---------------------------------------------------------------------------
// run() — pure entry point (isMain wrapper is the only process.exit* site)
// ---------------------------------------------------------------------------

const SUBCOMMANDS = {
  freshness: cmdFreshness,
  "pre-merge": cmdPreMerge,
  "merge-proof": cmdMergeProof,
  "pre-promote": cmdPrePromote,
  "post-promote": cmdPostPromote,
  "merge-target": cmdMergeTarget,
};

/**
 * @param {string[]} argv - subcommand + flags (NOT including `node script.mjs`)
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {(req:{prNumber:number,fields:string[],cwd:string})=>object} [options.ghRunner]
 * @param {(req:{login:string,cwd:string})=>string} [options.ghPermissionRunner] - collaborator
 *   permission (`admin`/`write`/`read`/`none`) of a review-binding comment author
 * @param {string} [options.gitVersionText] - override for `git version` output (tests)
 * @param {string} [options.repoRoot] - override repo root (skip `rev-parse --show-toplevel`)
 * @param {boolean} [options.skipFetch] - fixture/test isolation ONLY; skips the
 *   broad `git fetch <remote> --prune --tags` every subcommand otherwise runs
 *   before reading a remote-tracking ref. Never inferred/defaulted on, and has
 *   no CLI-flag spelling (N46). Does NOT skip the narrower N43 `git ls-remote`
 *   tag-existence/peel check, which always runs.
 * @returns {{exitCode:number, result:object}}
 */
export function run(argv, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const ghRunner = options.ghRunner ?? defaultGhRunner;

  if (argv.length === 0) {
    return { exitCode: 2, result: { ok: false, status: "error", subcommand: null, checks: [], reason: "missing subcommand", usage: USAGE } };
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { exitCode: 0, result: { ok: true, status: "help", subcommand: null, checks: [], usage: USAGE } };
  }

  const subcommand = argv[0];
  const args = argv.slice(1);
  const handler = SUBCOMMANDS[subcommand];
  if (!handler) {
    return { exitCode: 2, result: { ok: false, status: "error", subcommand, checks: [], reason: `unknown subcommand: ${subcommand}`, usage: USAGE } };
  }

  const gitVersionText = options.gitVersionText ?? getGitVersionText(cwd);
  const versionCheck = checkGitVersion(gitVersionText);
  if (!versionCheck.ok) {
    return {
      exitCode: 2,
      result: { ok: false, status: "error", subcommand, checks: [{ id: "git-version", ok: false, detail: versionCheck.reason }], reason: versionCheck.reason },
    };
  }

  const ghPermissionRunner = options.ghPermissionRunner ?? defaultGhPermissionRunner;
  const ctx = { cwd, ghRunner, ghPermissionRunner, permissionCache: new Map(), repoRoot: options.repoRoot ?? null, skipFetch: Boolean(options.skipFetch) };

  try {
    const checks = handler(args, ctx);
    return { exitCode: 0, result: { ok: true, status: "pass", subcommand, checks: [{ id: "git-version", ok: true, detail: gitVersionText.trim() }, ...checks] } };
  } catch (err) {
    if (err instanceof VerifyExit) {
      return {
        exitCode: err.exitCode,
        result: {
          ok: false,
          status: err.exitCode === 2 ? "error" : "fail",
          subcommand,
          checks: [{ id: "git-version", ok: true, detail: gitVersionText.trim() }, ...err.checks],
          reason: err.message,
        },
      };
    }
    return { exitCode: 2, result: { ok: false, status: "error", subcommand, checks: [], reason: `unexpected error: ${err.message}` } };
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (isMain) {
  const { exitCode, result } = run(process.argv.slice(2), { cwd: process.cwd() });
  if (result.status === "help" || result.status === "error" && result.subcommand === null && result.reason === "missing subcommand") {
    console.log(result.usage);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  process.exitCode = exitCode;
}
