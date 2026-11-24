import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConsumerSecondReviewRules } from "../build-pr-sticky-handoff.mjs";
import { CONSUMER_SECOND_REVIEW_RULES_REL } from "../lib/consumer-second-review-rules.mjs";

const cli = fileURLToPath(new URL("../read-pr-review-rules.mjs", import.meta.url));

function repository(t, rules = null) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pr-review-rules-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env };
  // Hook environments must not redirect fixture writes into the outer repository.
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = os.devNull;
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Review Fixture");
  git("config", "user.email", "review-fixture@example.invalid");
  mkdirSync(path.join(root, ".devpro"));
  writeFileSync(path.join(root, "content.txt"), "base\n");
  const setRules = (text) => {
    const file = path.join(root, CONSUMER_SECOND_REVIEW_RULES_REL);
    if (text === null) rmSync(file, { force: true });
    else writeFileSync(file, text);
  };
  if (rules !== null) setRules(rules);
  const commit = () => {
    git("add", "--all");
    git("-c", "core.hooksPath=" + os.devNull, "commit", "--quiet", "--allow-empty", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  return { root, env, git, setRules, commit, base: commit() };
}

function invoke(repo, base = repo.base, head = repo.base, extra = []) {
  return spawnSync(process.execPath, [cli, "--repo-root", repo.root, "--base", base, "--head", head, ...extra], {
    cwd: os.tmpdir(), env: repo.env, encoding: "utf8", timeout: 30000,
  });
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

function refusal(result, classification) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `${classification}\n`);
}

test("CLI uses recorded base rules through the shared reader despite a changed head and dirty worktree", (t) => {
  const repo = repository(t, "# base rules\nCheck caller authorization\n\nCheck encoding\n");
  repo.setRules("Different head criterion\n");
  const head = repo.commit();
  repo.setRules("Uncommitted worktree criterion\n");
  const snapshot = repo.git("status", "--porcelain=v1");
  const result = success(invoke(repo, repo.base, head));
  assert.deepEqual(result, {
    provenance: { base: repo.base, head, file: CONSUMER_SECOND_REVIEW_RULES_REL },
    markdown: "# base rules\nCheck caller authorization\n\nCheck encoding\n",
  });
  assert.equal(result.markdown, readConsumerSecondReviewRules({ prBaseSha: repo.base, headSha: head }, {
    cwd: repo.root,
    spawnSyncImpl: (command, args, options) => spawnSync(command, args, { ...options, env: repo.env }),
  }));
  assert.equal(repo.git("status", "--porcelain=v1"), snapshot);
});

test("head deletion does not erase recorded base rules", (t) => {
  const repo = repository(t, "Check caller behavior\n");
  repo.setRules(null);
  const head = repo.commit();
  assert.equal(success(invoke(repo, repo.base, head)).markdown, "Check caller behavior\n");
});

test("absence is empty in the target repo even if its worktree introduces a list", (t) => {
  const repo = repository(t);
  repo.setRules("Never read uncommitted rules\n");
  assert.deepEqual(success(invoke(repo)), {
    provenance: { base: repo.base, head: repo.base, file: CONSUMER_SECOND_REVIEW_RULES_REL }, markdown: "",
  });
});

test("an unsafe base file fails with classification only and no content disclosure", (t) => {
  const secret = "ghp_" + "a".repeat(36);
  const repo = repository(t, secret + "\n");
  const result = invoke(repo);
  refusal(result, "consumer_review_rules_invalid");
  assert.ok(!result.stderr.includes(secret));
});

test("a changed unsafe head is rejected even though the base file is valid", (t) => {
  const repo = repository(t, "Check authorization\n");
  repo.setRules("Check encoding\u0000\n");
  const head = repo.commit();
  refusal(invoke(repo, repo.base, head), "consumer_review_rules_invalid");
});

test("free-form markdown that older formats rejected is carried whole", (t) => {
  const markdown = [
    "# Review rules",
    "",
    "Rules: these are plain words in a free-form file.",
    "Tool: so is this line, and so is verdict: this one.",
    "",
    ...Array.from({ length: 40 }, (_, index) => `- Criterion ${index + 1}`),
    "",
  ].join("\n");
  const repo = repository(t, markdown);
  assert.equal(success(invoke(repo)).markdown, markdown);
});

test("a PII or secret pattern in the base file is refused with classification only", (t) => {
  const personalPath = `Do not paste ${["", "home", "alice", "notes"].join("/")} into a reply.\n`;
  const repo = repository(t, personalPath);
  const result = invoke(repo);
  refusal(result, "consumer_review_rules_invalid");
  assert.ok(!result.stderr.includes("alice"));
});

test("missing base commit is not reported as absent rules", (t) => {
  const repo = repository(t);
  refusal(invoke(repo, "f".repeat(40)), "source_read_failed");
});

test("missing head commit is not reported as absent rules", (t) => {
  const repo = repository(t);
  refusal(invoke(repo, repo.base, "f".repeat(40)), "source_read_failed");
});

test("invalid commit metadata is rejected by the shared reader", (t) => {
  const repo = repository(t);
  refusal(invoke(repo, "HEAD"), "source_read_failed");
  refusal(invoke(repo, repo.base, "HEAD"), "source_read_failed");
});

test("invalid arguments refuse without stdout or leaking paths", (t) => {
  const repo = repository(t);
  refusal(invoke(repo, repo.base, repo.base, ["--base", repo.base]), "invalid_cli_arguments");
  refusal(invoke(repo, repo.base, repo.base, ["--unknown", "secret-value"]), "invalid_cli_arguments");
  for (const args of [[], ["--repo-root"], ["--repo-root", repo.root, "--base", repo.base], ["--repo-root", "", "--base", repo.base, "--head", repo.base]]) {
    refusal(spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: repo.env }), "invalid_cli_arguments");
  }
});

test("repo-root must name the target repository top level", (t) => {
  const repo = repository(t);
  for (const root of [path.relative(os.tmpdir(), repo.root), path.join(repo.root, "missing"), path.join(repo.root, ".devpro"), os.tmpdir()]) {
    refusal(invoke({ ...repo, root }), "invalid_repo_root");
  }
});

test("ambient HEAD is not the reviewed PR head", (t) => {
  const repo = repository(t, "Recorded base criterion\n");
  repo.setRules("Reviewed head criterion\n");
  const head = repo.commit();
  repo.setRules("Unrelated ambient HEAD criterion\n");
  const ambient = repo.commit();
  assert.notEqual(repo.git("rev-parse", "HEAD"), head);
  assert.equal(success(invoke(repo, repo.base, head)).markdown, "Recorded base criterion\n");
  assert.equal(repo.git("rev-parse", "HEAD"), ambient);
});
