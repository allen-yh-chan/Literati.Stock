#!/usr/bin/env node
/**
 * Claude linked-issue reader. The canonical allowlist fixes the repository
 * argument before its trailing wildcard; this helper accepts exactly one
 * positive decimal issue argument and cannot forward repo overrides or URLs.
 * Usage: node read-second-review-linked-issue.mjs <owner/repo> <issue>
 */
import { reviewGithubSpawnSync as spawnSync } from "./lib/second-review-github-transport.mjs";
import { isDirectCliInvocation } from "./lib/cli-entry.mjs";

export function linkedIssueReadArgs(argv) {
  if (argv.length !== 2 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(argv[0]) || !/^[1-9][0-9]*$/.test(argv[1])) {
    throw new Error("linked_issue_read_invalid: expected exactly owner/repo and a positive decimal issue");
  }
  return ["issue", "view", argv[1], "--repo", argv[0], "--json", "number,title,state,body,labels,comments"];
}

export function runLinkedIssueRead(argv, { spawnSyncImpl = spawnSync, env = process.env } = {}) {
  const args = linkedIssueReadArgs(argv);
  return spawnSyncImpl("gh", args, {
    encoding: "utf8", timeout: 30000, maxBuffer: 5 * 1024 * 1024,
    env: { ...env, GH_REPO: argv[0] },
  });
}

if (isDirectCliInvocation(import.meta.url)) {
  try {
    const result = runLinkedIssueRead(process.argv.slice(2));
    if (result.error) throw result.error;
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exitCode = result.status ?? 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
