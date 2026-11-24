#!/usr/bin/env node
/**
 * read-second-review-sticky-comment.mjs
 *
 * Read-only sticky / PR-comment GET helper. Replaces reviewer-facing raw
 * `gh api` for exact-comment read-back so Claude --allowedTools need not
 * expose unrestricted `Bash(gh api:*)` (which also permits POST/PATCH body
 * writes).
 *
 * Usage:
 *   node read-second-review-sticky-comment.mjs get <owner/repo> <comment_id> [--jq <expr>]
 *   node read-second-review-sticky-comment.mjs list <owner/repo> <issue_or_pr_number> [--jq <expr>]
 *
 * Only GET is performed. POST/PATCH/PUT/DELETE are rejected.
 */

import { reviewGithubSpawnSync as spawnSync } from "./lib/second-review-github-transport.mjs";
import path from "node:path";
import { SECOND_REVIEW_COMMENT_QUIET_JQ } from "./lib/second-review-comment-fields.mjs";
import { fileURLToPath } from "node:url";
import { isDirectCliInvocation } from "./lib/cli-entry.mjs";

export const STICKY_READ_QUIET_JQ = SECOND_REVIEW_COMMENT_QUIET_JQ;

const REPO_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_ID_RE = /^[1-9][0-9]*$/;

function fail(message, classification = "sticky_comment_read_invalid") {
  const payload = { ok: false, classification, error: message };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
  return payload;
}

function parseArgs(argv) {
  const args = [...argv];
  let jq = STICKY_READ_QUIET_JQ;
  const jqIndex = args.indexOf("--jq");
  if (jqIndex !== -1) {
    jq = args[jqIndex + 1];
    if (typeof jq !== "string" || jq.length === 0) {
      throw Object.assign(new Error("--jq requires a non-empty expression"), {
        classification: "sticky_comment_read_invalid",
      });
    }
    args.splice(jqIndex, 2);
  }
  const [action, repositorySlug, id] = args;
  return { action, repositorySlug, id, jq, rest: args.slice(3) };
}

/**
 * @param {{
 *   action: string,
 *   repositorySlug: string,
 *   id: string,
 *   jq?: string,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   spawnSyncImpl?: typeof spawnSync,
 * }} args
 */
export function runStickyCommentRead({
  action,
  repositorySlug,
  id,
  jq = STICKY_READ_QUIET_JQ,
  cwd = process.cwd(),
  env = process.env,
  spawnSyncImpl = spawnSync,
}) {
  if (action !== "get" && action !== "list") {
    throw Object.assign(new Error("action must be get|list"), {
      classification: "sticky_comment_read_invalid",
    });
  }
  if (typeof repositorySlug !== "string" || !REPO_SLUG_RE.test(repositorySlug)) {
    throw Object.assign(new Error("repository_slug must be owner/repo"), {
      classification: "sticky_comment_read_invalid",
    });
  }
  if (typeof id !== "string" || !POSITIVE_ID_RE.test(id)) {
    throw Object.assign(new Error("comment/issue id must be a positive decimal"), {
      classification: "sticky_comment_read_invalid",
    });
  }
  if (typeof jq !== "string" || jq.length === 0) {
    throw Object.assign(new Error("jq expression is required"), {
      classification: "sticky_comment_read_invalid",
    });
  }

  const endpoint = action === "get"
    ? `repos/${repositorySlug}/issues/comments/${id}`
    : `repos/${repositorySlug}/issues/${id}/comments`;

  const gh = spawnSyncImpl("gh", [
    "api",
    endpoint,
    "--method",
    "GET",
    "--jq",
    jq,
  ], {
    cwd,
    env: {
      ...env,
      GH_REPO: repositorySlug,
    },
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
    timeout: 30000,
  });

  if (gh.status !== 0) {
    return {
      status: gh.status === null ? 1 : gh.status,
      result: {
        ok: false,
        classification: "sticky_comment_read_gh_failed",
        error: gh.error?.message ?? "gh api GET failed",
        stderr_tail: String(gh.stderr ?? "").slice(-1000),
      },
      gh,
    };
  }

  const stdout = String(gh.stdout ?? "");
  return {
    status: 0,
    result: {
      ok: true,
      classification: "sticky_comment_read_ok",
      action,
      stdout,
    },
    gh,
  };
}

export function main(argv = process.argv.slice(2), options = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    fail(error.message, error.classification ?? "sticky_comment_read_invalid");
    return 1;
  }
  if (parsed.rest.length > 0) {
    fail("unexpected arguments after action/repo/id");
    return 1;
  }
  if (!parsed.action || !parsed.repositorySlug || !parsed.id) {
    fail("usage: read-second-review-sticky-comment.mjs get|list <owner/repo> <id> [--jq <expr>]");
    return 1;
  }

  let outcome;
  try {
    outcome = runStickyCommentRead({
      action: parsed.action,
      repositorySlug: parsed.repositorySlug,
      id: parsed.id,
      jq: parsed.jq,
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      spawnSyncImpl: options.spawnSyncImpl ?? spawnSync,
    });
  } catch (error) {
    fail(error.message, error.classification ?? "sticky_comment_read_invalid");
    return 1;
  }

  if (outcome.status !== 0) {
    process.stderr.write(`${JSON.stringify(outcome.result)}\n`);
    process.exitCode = 1;
    return 1;
  }
  if (outcome.result.stdout) {
    process.stdout.write(
      outcome.result.stdout.endsWith("\n")
        ? outcome.result.stdout
        : `${outcome.result.stdout}\n`,
    );
  }
  process.exitCode = 0;
  return 0;
}

if (isDirectCliInvocation(import.meta.url) || (
  process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)) {
  main();
}
