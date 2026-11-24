#!/usr/bin/env node
/**
 * git-native pre-push hook implementation — protected update and deletion guard
 *
 * Entry point: adjacent extensionless `pre-push` POSIX wrapper.
 *
 * Layer: git hook (invoked by `git push`), NOT a PreToolUse mechanical gate.
 *   PreToolUse gates (pre-tool-gate.mjs) intercept AI tool calls via JSON payloads.
 *   This implementation intercepts git push operations at the git protocol layer.
 *   These are completely separate layers; this hook does NOT violate
 *   pre-tool-mechanical-gates spec §"MUST NOT maintain a branch/worktree deletion parser"
 *   because that constraint applies to PreToolUse handlers only.
 *
 * Detection method (T1-proven, git 2.50.1, 2026-06-05):
 *   git feeds pre-push hooks via stdin, one line per ref being pushed:
 *     <local-ref> <local-sha> <remote-ref> <remote-sha>
 *   For branch deletion pushes (`git push origin --delete <branch>`), git sends:
 *     (delete) 0000000000000000000000000000000000000000 refs/heads/<name> <remote-sha>
 *   The local-sha is all-zeros (40 × '0') when the operation is a deletion.
 *   For normal pushes, local-sha is a real commit SHA.
 *
 *   Detection: local-sha matches /^0+$/ (all-zero, compatible with both SHA-1 and SHA-256).
 *   We parse the structured ref/sha fields only — no shell command text parsing.
 *
 * Protected non-deletion mode:
 *   Complete stdin is classified before the hook decides. Non-deletion updates
 *   to the exact remote refs `refs/heads/main` and `refs/heads/production` reject
 *   the whole batch and direct the operator to the pull-request path. This hook
 *   is a local first line of defense, not remote branch protection.
 *   The local-only review/ namespace also rejects non-deletion source or
 *   destination refs, including renamed sources and HEAD in a review checkout.
 *
 * Production tag ancestry mode:
 *   A created or updated `refs/tags/production-*` must peel to a commit that is
 *   an ancestor of the local remote-tracking `refs/remotes/<remote>/production`.
 *   <remote> is `origin` when that remote exists; otherwise the pushed remote
 *   when git's first argument names a configured remote. One failing tag
 *   rejects the whole batch. A missing tracking ref rejects the batch as
 *   "production target absent". The hook never fetches: a stale tracking ref can
 *   only reject a valid tag (fetch, then push again), never accept an invalid one.
 *   Tags git does not send (already on the remote, unchanged) are not checked.
 *
 * Deletion advisory mode (accident-prevention, NOT hard wall):
 *   On detecting a deletion, this hook exits non-zero (fail-stop) to prevent
 *   accidental remote branch deletion. The advisory message explains compliant
 *   remote cleanup paths (`prune-merged-local.mjs --include-remote --exec` for
 *   production-shipped; `--include-unshipped-mainline --include-remote --exec`
 *   for verified main-contained ∩ ¬prod) and the intentional bypass
 *   (`git push --no-verify`, not an official production-lag workflow).
 */

import { createInterface } from "node:readline";

const ZERO_SHA_RE = /^0+$/;
const DELETE_PREFIX = "(delete)";
const PROTECTED_REMOTE_REFS = ["refs/heads/main", "refs/heads/production"];
// A literal on purpose, not an import of hooks/lib/branch-naming.mjs: this hook
// must keep deciding when it is the only file present (a partial install, a
// copied hook, a linked worktree without the lib tree). Loading the lib made an
// ordinary push fail with "Cannot find module". The grep suite locks this value
// to the lib export so the two cannot drift.
const LOCAL_REVIEW_BRANCH_PREFIX = "review/";
// Same reason (literal, no lib import); locked to isProtectedBaseBranch by
// branch-deletion-paths.test.mjs. Only used to pick the per-branch advisory.
const PROTECTED_BRANCH_NAMES = ["main", "master", "production", "integration"];
const RELEASE_BRANCH_PREFIX = "release/";
const PRODUCTION_TAG_REF_PREFIX = "refs/tags/production-";

// Same result as advisoryBranchArg in lib/prune-argv.mjs, inlined for the same
// no-lib reason as above (branch-deletion-paths.test.mjs locks the two together):
// plain names bare; others POSIX single-quoted; on Windows null, because the
// pasting shell is unknown and cmd / PowerShell quoting conflict.
function shellArg(value) {
  if (/^[A-Za-z0-9._\/-]+$/.test(value)) return value;
  if (process.platform === 'win32') return null;
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function perBranchDeletionAdvice(branch) {
  if (PROTECTED_BRANCH_NAMES.includes(branch)) {
    return `  - ${branch}: protected branch; there is no deletion path`;
  }
  if (branch.startsWith(RELEASE_BRANCH_PREFIX)) {
    return `  - ${branch}: a shipped release branch is removed by the batch commands above; an abandoned one is intentionally retained (git-branch-hygiene.md)`;
  }
  const arg = shellArg(branch);
  if (arg === null) {
    return `  - ${branch}: the name has shell-special characters; quote it for your shell and run prune-merged-local.mjs --force-delete <that branch> --include-remote`;
  }
  return `  node .devpro/scripts/prune-merged-local.mjs --force-delete ${arg} --include-remote`;
}

async function readStdinLines() {
  const lines = [];
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) lines.push(trimmed);
  }
  return lines;
}

function parseRefLine(line) {
  // git pre-push stdin format: <local-ref> <local-sha> <remote-ref> <remote-sha>
  // Deletion lines may have a leading "(delete) " prefix (observed in git 2.50.1).
  // When the prefix is present, the line has the form:
  //   (delete) <local-sha> <remote-ref> <remote-sha>   (4 tokens, local-ref is absent)
  // Without prefix:
  //   <local-ref> <local-sha> <remote-ref> <remote-sha>  (4 tokens)
  //
  // We normalise by stripping the "(delete)" token so we always have:
  //   [local-sha, remote-ref, remote-sha]  or  [local-ref, local-sha, remote-ref, remote-sha]
  const parts = line.split(/\s+/);

  // Check if the first token is the "(delete)" marker
  if (parts[0] === DELETE_PREFIX) {
    // Deletion form: (delete) <local-sha> <remote-ref> <remote-sha>
    // parts: ["(delete)", local-sha, remote-ref, remote-sha]
    if (parts.length < 4) return null;
    const [, localSha, remoteRef] = parts;
    return { localRef: DELETE_PREFIX, localSha, remoteRef };
  }

  // Normal form: <local-ref> <local-sha> <remote-ref> <remote-sha>
  if (parts.length < 4) return null;
  const [localRef, localSha, remoteRef] = parts;
  return { localRef, localSha, remoteRef };
}

function extractBranchName(remoteRef) {
  // refs/heads/<name> → <name>
  const prefix = "refs/heads/";
  if (remoteRef.startsWith(prefix)) {
    return remoteRef.slice(prefix.length);
  }
  return remoteRef;
}

/**
 * Each pushed production tag must peel to a commit already on production, as
 * last fetched. Returns null when every tag passes, otherwise the rejection text.
 * The pushed remote argument is never printed unless it is a configured remote
 * name: a push by URL passes the URL, which may carry credentials.
 */
async function productionTagRejection(tagUpdates) {
  if (tagUpdates.length === 0) return null;
  const { spawnSync } = await import("node:child_process");
  const git = (args) => spawnSync("git", args, { encoding: "utf8" });
  const listed = git(["remote"]);
  const remotes = listed.status === 0 ? listed.stdout.split("\n").map((name) => name.trim()).filter(Boolean) : [];
  const pushed = process.argv[2] || "";
  const remote = remotes.includes("origin") ? "origin" : remotes.includes(pushed) ? pushed : null;
  if (remote === null) {
    return [
      "pre-push: production target absent: no remote named origin, and the push target is not a configured remote",
      "Blocked tag(s):",
      ...tagUpdates.map(({ tag }) => `  - ${tag}`),
      "A production tag is checked against <remote>/production. Push through a configured remote after fetching it.",
      "Boundary: this local hook is not remote protection; a missing installation or git push --no-verify can skip it and is not an approved release bypass.",
      "",
    ].join("\n");
  }
  const productionRef = `refs/remotes/${remote}/production`;
  const recovery = [
    "Required path: merge the release branch into production through a PR, then tag the exact",
    "merge commit and push only the tag (release-step-1-7.md Step 6). A release with no repo",
    `change tags a commit that is already on ${remote}/production.`,
    `This hook does not fetch. If production moved after your last fetch, run git fetch ${remote}, then push again.`,
    "Boundary: this local hook is not remote protection; a missing installation or git push --no-verify can skip it and is not an approved release bypass.",
    "",
  ];

  const target = git(["rev-parse", "--verify", "--quiet", `${productionRef}^{commit}`]);
  if (target.status !== 0) {
    return [
      `pre-push: production target absent: ${productionRef} does not exist in this clone`,
      "Blocked tag(s):",
      ...tagUpdates.map(({ tag }) => `  - ${tag}`),
      `A production tag can only be checked against ${remote}/production. Fetch it with git fetch ${remote};`,
      "if the remote has no production branch, repository administration must create it first.",
      ...recovery,
    ].join("\n");
  }

  const blocked = [];
  for (const { tag, sha } of tagUpdates) {
    const peeled = git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
    if (peeled.status !== 0) {
      blocked.push(`  - ${tag}: ${sha.slice(0, 12)} does not resolve to a commit`);
      continue;
    }
    const commit = peeled.stdout.trim();
    if (git(["merge-base", "--is-ancestor", commit, productionRef]).status !== 0) {
      blocked.push(`  - ${tag}: ${commit.slice(0, 12)} is not on ${remote}/production`);
    }
  }
  if (blocked.length === 0) return null;
  return [
    `pre-push: production tag must point at a commit on ${remote}/production`,
    "Blocked tag(s):",
    ...blocked,
    ...recovery,
  ].join("\n");
}

/**
 * Release back-merge ledger (openspec enforce-release-back-merge-completion D2).
 * Runs only on the already-decided exit-0 path. The recorder is loaded lazily
 * inside its own error boundary (no static import, no output, no network): a
 * load or write failure must never turn an allowed push into a rejected one,
 * so nothing here may reach main().catch below. The string pre-check keeps
 * pushes without a production-* tag from loading anything.
 */
async function recordProductionTagPush(lines) {
  try {
    if (!lines.some((line) => line.includes(" refs/tags/production-"))) return;
    const recorderUrl = new URL("../hooks/lib/release-back-merge-state.mjs", import.meta.url).href;
    const { recordProductionTagPush: record } = await import(recorderUrl);
    record({ lines, remote: process.argv[2], cwd: process.cwd() });
  } catch {
    // swallowed on purpose
  }
}

async function main() {
  const lines = await readStdinLines();
  const reviewRefPrefix = `refs/heads/${LOCAL_REVIEW_BRANCH_PREFIX}`;
  const deletedBranches = [];
  const protectedRemoteRefs = new Set();
  const localReviewUpdates = [];
  const productionTagUpdates = [];
  let currentBranch;

  for (const line of lines) {
    const parsed = parseRefLine(line);
    if (!parsed) continue;

    const { localRef, localSha, remoteRef } = parsed;
    if (ZERO_SHA_RE.test(localSha)) {
      deletedBranches.push(extractBranchName(remoteRef));
      continue;
    }

    // Git supplies the actual refspec, including renamed destinations. HEAD or
    // revision expressions need the checkout branch; explicit ordinary refs do not.
    if (!localRef.startsWith("refs/") && currentBranch === undefined) {
      const { spawnSync } = await import("node:child_process");
      const result = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" });
      currentBranch = result.status === 0 ? result.stdout.trim() : "";
    }
    if (localRef.startsWith(reviewRefPrefix) || remoteRef.startsWith(reviewRefPrefix)
        || (!localRef.startsWith("refs/") && currentBranch?.startsWith(LOCAL_REVIEW_BRANCH_PREFIX))) {
      localReviewUpdates.push(`${localRef} -> ${remoteRef}`);
    }

    if (PROTECTED_REMOTE_REFS.includes(remoteRef)) {
      protectedRemoteRefs.add(remoteRef);
    }
    if (remoteRef.startsWith(PRODUCTION_TAG_REF_PREFIX)) {
      productionTagUpdates.push({ tag: remoteRef.slice("refs/tags/".length), sha: localSha });
    }
  }

  if (localReviewUpdates.length > 0) {
    process.stderr.write(`pre-push: local review branches are 僅本機; publishing is prohibited.\n${localReviewUpdates.join("\n")}\nUse a normal work branch for changes that need a PR.\n`);
    process.exit(1);
  }

  if (protectedRemoteRefs.size > 0) {
    const blockedRefs = PROTECTED_REMOTE_REFS
      .filter((remoteRef) => protectedRemoteRefs.has(remoteRef))
      .map((remoteRef) => `  - ${remoteRef}`)
      .join("\n");

    process.stderr.write(
      [
        "pre-push: protected branch update requires PR",
        "Blocked remote ref(s):",
        blockedRefs,
        "Required path: push the work/release branch, then open a PR to the protected target.",
        "Boundary: this local hook is not remote protection; a missing installation or git push --no-verify can skip it and is not an approved release bypass.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  const tagRejection = await productionTagRejection(productionTagUpdates);
  if (tagRejection) {
    process.stderr.write(tagRejection);
    process.exit(1);
  }

  if (deletedBranches.length === 0) {
    // No protected updates or deletions detected — pass through silently
    await recordProductionTagPush(lines);
    process.exit(0);
  }

  // Controlled bypass for CANONICAL cleanup paths only (issue #947 / #2726):
  // `prune-merged-local.mjs --include-remote --exec` (and the stronger
  // `--include-unshipped-mainline --include-remote --exec` consent path), plus
  // `prune-rules-lane.mjs --include-remote --exec` for Rules Lane products,
  // are the compliant cleanup flows this hook's own advisory recommends — their
  // remote phases run `git push origin --delete` for branches they have already
  // authorized, which would otherwise be blocked here, leaving only `--no-verify`.
  // Those scripts set `DEVPRO_PRUNE_REMOTE_DELETE=1` on EXACTLY that remote-delete
  // invocation, and this hook honors that one marker. This is NOT a wildcard
  // bypass: it is scoped to the audited prune scripts, requires the marker to be
  // EXACTLY "1", and a RAW `git push origin --delete` (no marker) still hard-blocks
  // below.
  // `prune-merged-local.mjs --force-delete <b> --include-remote` sets the same marker
  // for one named non-release branch, after it refused branches a batch path owns,
  // and deletes under `--force-with-lease`; plain `--force-delete` stays local-only.
  if (process.env.DEVPRO_PRUNE_REMOTE_DELETE === "1") {
    process.exit(0);
  }

  // Deletion(s) detected — print advisory and block
  const branchList = deletedBranches.map((b) => `  - ${b}`).join("\n");

  process.stderr.write(
    [
      "",
      "╔══════════════════════════════════════════════════════════════╗",
      "║  pre-push: remote branch deletion detected (accident guard)  ║",
      "╚══════════════════════════════════════════════════════════════╝",
      "",
      `Detected remote branch deletion(s) for:`,
      branchList,
      "",
      "This push was blocked as an accident-prevention measure.",
      "Remote branch deletion bypasses the compliant cleanup flow.",
      "",
      "Compliant remote-delete paths:",
      "  node .devpro/scripts/prune-merged-local.mjs            # dry-run: preview",
      "  node .devpro/scripts/prune-merged-local.mjs --exec     # delete production-shipped local/worktree refs only",
      "  node .devpro/scripts/prune-merged-local.mjs --include-remote --exec",
      "  node .devpro/scripts/prune-merged-local.mjs --include-subsumed --include-remote --exec",
      "  node .devpro/scripts/prune-merged-local.mjs --include-unshipped-mainline --include-remote --exec",
      "  node .devpro/scripts/prune-rules-lane.mjs              # dry-run: Rules Lane products only",
      "  node .devpro/scripts/prune-rules-lane.mjs --include-remote --exec",
      "",
      "The --include-remote --exec flow verifies each remote branch is merged into",
      "production before deleting the remote ref, and logs every operation.",
      "--include-subsumed also covers branches whose patches reached production via a squash.",
      "For verified main-contained ∩ not-yet-production tips (non-rules),",
      "use --include-unshipped-mainline --include-remote --exec (stronger consent).",
      "For rules/* / release/rules-* after lane completion, use prune-rules-lane.mjs.",
      "",
      "For a branch no batch command covers (abandoned, squash-merged before release, leaked review/):",
      ...deletedBranches.map(perBranchDeletionAdvice),
      "  (--force-delete <branch> --include-remote deletes the local ref and origin/<branch>",
      "   under an OID lease; it refuses branches already merged into main or shipped,",
      "   which the batch commands above own. Without --include-remote it is local-only.",
      "   Commits only on that branch are lost on both sides, so run it only for a branch",
      "   the user named. It also removes the branch's linked worktree; it",
      "   refuses one with uncommitted or untracked changes.)",
      "",
      "Intentional bypass (if you know what you are doing — NOT the official",
      "production-lag / pre-first-release cleanup path):",
      "  git push --no-verify",
      "",
      "This is not a hard prohibition — it is accident-prevention.",
      "Use --no-verify only when you intentionally need to delete without a prune script.",
      "",
    ].join("\n")
  );

  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`pre-push hook error: ${err.message}\n`);
  process.exit(1);
});
