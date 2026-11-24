#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { readConsumerSecondReviewRules } from "./build-pr-sticky-handoff.mjs";
import { CONSUMER_SECOND_REVIEW_RULES_REL } from "./lib/consumer-second-review-rules.mjs";

function fail(classification) {
  const error = new Error(classification);
  error.classification = classification;
  throw error;
}

function parseArgs(argv) {
  const allowed = new Set(["--repo-root", "--base", "--head"]);
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!allowed.has(flag) || values.has(flag) || typeof value !== "string" || value.trim() === "" || value.startsWith("--") || value.includes("\0")) {
      fail("invalid_cli_arguments");
    }
    values.set(flag, value);
  }
  if (values.size !== allowed.size) fail("invalid_cli_arguments");
  return { root: values.get("--repo-root"), base: values.get("--base"), head: values.get("--head") };
}

function repositoryRoot(root) {
  // Never fall back to the tool installation repository or the caller's cwd.
  let resolved;
  try {
    if (!path.isAbsolute(root)) fail("invalid_repo_root");
    resolved = realpathSync(root);
    if (!statSync(resolved).isDirectory()) fail("invalid_repo_root");
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: resolved, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0 || realpathSync(result.stdout.trim()) !== resolved) fail("invalid_repo_root");
  } catch {
    fail("invalid_repo_root");
  }
  return resolved;
}

try {
  const { root, base, head } = parseArgs(process.argv.slice(2));
  const cwd = repositoryRoot(root);
  // The builder owns base/head SHA validation, head-change checks and redacted refusals for the rules file.
  const markdown = readConsumerSecondReviewRules({ prBaseSha: base, headSha: head }, { cwd });
  process.stdout.write(JSON.stringify({
    provenance: { base, head, file: CONSUMER_SECOND_REVIEW_RULES_REL },
    markdown,
  }) + "\n");
} catch (error) {
  const allowed = new Set(["invalid_cli_arguments", "invalid_repo_root", "source_read_failed", "consumer_review_rules_invalid"]);
  const classification = allowed.has(error?.classification) ? error.classification : "source_read_failed";
  // No rule text, repository path, raw Git error or stack reaches either output stream.
  process.stderr.write(`${classification}\n`);
  process.exitCode = 1;
}
