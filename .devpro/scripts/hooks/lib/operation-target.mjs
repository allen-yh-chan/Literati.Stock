/**
 * operation-target.mjs
 *
 * Which governance identity the repository an operation writes to has. A session started in one repository (the hub)
 * may write another one (the target) through `git -C`, `cd <target> &&`, `gh --repo` or an absolute file path; the
 * gates that depend on "is this the rules source" must ask about the target, never about the session repository.
 *
 * Identity classes:
 *   - source / consumer / unknown: `classifyRepoIdentity` (lib/repo-identity.mjs), unchanged.
 *   - non-devpro: added here, only on positive evidence. The repository is unknown to classifyRepoIdentity for lack of
 *     source/consumer evidence, AND its committed HEAD tree has no devpro trace (`.devpro/`, `.devpro-agent-rules`, a
 *     `.gitmodules` entry for the rules, an AGENTS.md rules version line). The working tree is never read, so an
 *     untracked scratch file does not change the answer.
 *   - Anything that cannot be proven (no commit yet, a read failure, a conflicting or unrecognized superproject)
 *     stays unknown: gates treat unknown as the strictest case and grant it no source-only relaxation. A checkout
 *     without a committed HEAD is unknown whatever else it carries, source and consumer evidence included.
 *
 * classifyRepoIdentity keeps its three return values: existing callers rely on "unknown = blocked".
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

import { checkoutRepoIdentity } from "../../lib/consumer-pre-pr-gate.mjs";
import { SEMVER_CORE } from "./version-helpers.mjs";

// classifyRepoIdentity evidence strings that only say "nothing positive was found"; a HEAD probe may turn these into
// non-devpro. Every other unknown (conflicting evidence, unrecognized superproject, failed superproject probe) stays.
const UPGRADABLE_UNKNOWN = new Set(["no positive source/consumer evidence", "origin probe failed"]);
const RULES_SUBMODULE_URL_RE = /(?:^|[/:])devpro-agent-rules(?:\.git)?\/?$/i;
// One line `版本：X.Y.Z` (an optional leading BOM; the label and the number on the same line).
const AGENTS_VERSION_RE = new RegExp(String.raw`^\uFEFF?版本：[ \t]*v?${SEMVER_CORE}`, "m");

// A partial clone must not fetch a missing object (or wait on the network) to answer: GIT_NO_LAZY_FETCH makes the
// read fail, and the timeout bounds any other stall; either is a read failure, which keeps the identity unknown.
const GIT_READ_TIMEOUT_MS = 10000;
const git = (root, args) =>
  spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: GIT_READ_TIMEOUT_MS, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } });

// "confirmed-absent" | "present" | "not-materialized" | "read-failure". HEAD is resolved once (or given as `commit`),
// and every read names that commit, so a HEAD that moves during the probe never mixes two trees.
export function probeDevproTracesAtHead(root, commit) {
  if (!commit) {
    const head = git(root, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
    if (head.error) return "read-failure";
    if (head.status !== 0) return "not-materialized";
    commit = head.stdout.trim();
  }
  const listed = git(root, ["ls-tree", "--name-only", commit, "--", ".devpro", ".devpro-agent-rules", ".gitmodules", "AGENTS.md"]);
  if (listed.error || listed.status !== 0) return "read-failure";
  const names = new Set(listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean));
  if (names.has(".devpro") || names.has(".devpro-agent-rules")) return "present";
  if (names.has(".gitmodules")) {
    const rules = committedRulesSubmodule(root, commit);
    if (rules !== "absent") return rules;
  }
  if (names.has("AGENTS.md")) {
    // A committed symlink shows only its target path, not the rules version line it may lead to: not proof of absence.
    const entry = git(root, ["ls-tree", commit, "--", "AGENTS.md"]);
    if (entry.error || entry.status !== 0 || !/^100(?:644|755) blob /.test(entry.stdout)) return "read-failure";
    const shown = git(root, ["show", `${commit}:AGENTS.md`]);
    if (shown.error || shown.status !== 0) return "read-failure";
    if (AGENTS_VERSION_RE.test(shown.stdout)) return "present";
  }
  return "confirmed-absent";
}

// Whether the committed .gitmodules declares the rules submodule, read with Git's own config grammar (quoted values,
// inline comments). git exits 1 both for "no such key" and for a malformed blob; only the latter writes stderr.
function committedRulesSubmodule(root, commit) {
  // -z: each record is "<key>\n<value>\0", so a subsection name with spaces stays inside the key.
  const read = git(root, ["config", "-z", "--blob", `${commit}:.gitmodules`, "--get-regexp", "^submodule\\..*\\.(path|url)$"]);
  if (read.error || (read.status !== 0 && (read.status !== 1 || read.stderr.trim()))) return "read-failure";
  for (const record of read.stdout.split("\0")) {
    const cut = record.indexOf("\n");
    if (cut < 0) continue;
    const key = record.slice(0, cut);
    const value = record.slice(cut + 1);
    if (key?.endsWith(".path") && value.replace(/\/+$/, "") === ".devpro-agent-rules") return "present";
    if (key?.endsWith(".url") && RULES_SUBMODULE_URL_RE.test(value)) return "present";
  }
  return "absent";
}

// Whether the checkout has no origin URL: `git config --get` exits 1 without output for a missing key and with another
// status (128 for a malformed config) or a message when it cannot read the configuration.
function originConfirmedAbsent(root) {
  const read = git(root, ["config", "--get", "remote.origin.url"]);
  return !read.error && read.status === 1 && !read.stderr.trim() && !read.stdout.trim();
}

const memo = new Map();

// Forget every memoised identity. Each hook entry point calls this before it evaluates one operation, so the cache
// lives for one evaluation: a reused process sees a changed HEAD, origin or adoption evidence on its next run.
export function resetDestinationIdentityCache() {
  memo.clear();
}

// { identity: "source"|"consumer"|"non-devpro"|"unknown", evidence, root? } of the checkout that contains `cwd`.
// Memoised on the resolved path until the next reset: one hook evaluation asks about the same checkout from several
// gates. A missing checkout is unknown; it never falls back to the process working directory.
export function destinationIdentity(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) return { identity: "unknown", evidence: "no checkout path" };
  const key = path.resolve(cwd);
  const known = memo.get(key);
  if (known) return known;
  const result = classify(key);
  memo.set(key, result);
  return result;
}

function classify(cwd) {
  const base = checkoutRepoIdentity(cwd);
  if (base.error) return { identity: "unknown", evidence: base.error };
  // Every identity needs a committed HEAD: before the first commit nothing about the repository is settled yet.
  const head = git(base.root, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  if (head.error || head.status !== 0) return { root: base.root, identity: "unknown", evidence: "no committed HEAD" };
  if (base.identity !== "unknown" || !UPGRADABLE_UNKNOWN.has(base.evidence)) return base;
  // classifyRepoIdentity reports a missing origin and an unreadable one alike; only a confirmed absence may upgrade.
  if (base.evidence === "origin probe failed" && !originConfirmedAbsent(base.root)) {
    return { root: base.root, identity: "unknown", evidence: "origin cannot be read" };
  }
  const probe = probeDevproTracesAtHead(base.root, head.stdout.trim());
  if (probe === "confirmed-absent") return { root: base.root, identity: "non-devpro", evidence: "committed HEAD tree has no devpro trace" };
  return { root: base.root, identity: "unknown", evidence: `${base.evidence}; HEAD probe ${probe}` };
}

export function isSourceDestination(cwd) {
  return destinationIdentity(cwd).identity === "source";
}
