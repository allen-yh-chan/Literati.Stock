import assert from "node:assert/strict";
import test from "node:test";
import { canonicalReviewerCliRecipe, assertCanonicalReviewerCliRecipe } from "../second-reviewer-cli-recipe-contract.mjs";
import { repoPath } from "./lib/repo-root.mjs";
import { runLinkedIssueRead } from "../read-second-review-linked-issue.mjs";

const context = {
  reviewer_family: "claude", mode: "pr-sticky", linked_issue_context: "issue_read_required",
  repository_slug: "devpro-tw/devpro-agent-rules", claude_selected_effort: "xhigh",
};

test("linked issue permission binds the helper to the packet repository", () => {
  const recipe = canonicalReviewerCliRecipe(context);
  const args = recipe.required_invocation_args;
  const allowed = args[args.indexOf("--allowedTools") + 1];
  assert.ok(allowed.includes(`Bash(node ${repoPath(".devpro/scripts/read-second-review-linked-issue.mjs")} ${context.repository_slug}:*)`));
  assert.ok(!allowed.includes("Bash(gh issue view:*"));
  const tampered = structuredClone(recipe);
  tampered.required_invocation_args[tampered.required_invocation_args.indexOf("--allowedTools") + 1] = allowed.replace(context.repository_slug, "other/repo");
  assert.throws(() => assertCanonicalReviewerCliRecipe({ ...context, reviewer_cli_recipe: tampered }), /required_invocation_args must exactly match/);
});

test("required linked issue recipe refuses an absent or malformed repository before spawn", () => {
  for (const repository_slug of [undefined, "", "other/repo --repo stolen/repo", "other/*", "other/repo;echo x"]) {
    assert.throws(() => canonicalReviewerCliRecipe({ ...context, repository_slug }), /repository_slug must be owner\/repo/);
  }
});

test("issue reader constructs a single explicit repo and cannot inherit an alternate GH_REPO", () => {
  const calls = [];
  const result = runLinkedIssueRead([context.repository_slug, "3140"], {
    env: { GH_REPO: "other/repo" },
    spawnSyncImpl: (...args) => { calls.push(args); return { status: 0, stdout: "{}" }; },
  });
  assert.equal(result.status, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], ["issue", "view", "3140", "--repo", context.repository_slug, "--json", "number,title,state,body,labels,comments"]);
  assert.equal(calls[0][2].env.GH_REPO, context.repository_slug);
  assert.equal(calls[0][2].shell, undefined);
});

test("issue reader rejects URLs, alternate repos, flags and extra arguments before gh", () => {
  let calls = 0;
  for (const argv of [
    [context.repository_slug], [context.repository_slug, "0"], [context.repository_slug, "-1"],
    [context.repository_slug, "other/repo#1"], [context.repository_slug, "https://github.com/other/repo/issues/1"],
    [context.repository_slug, "1", "--repo", "other/repo"], [context.repository_slug, "--repo=other/repo"],
    [context.repository_slug, "1", "--web"], [context.repository_slug, "1;echo x"],
    ["other/repo --repo stolen/repo", "1"],
  ]) assert.throws(() => runLinkedIssueRead(argv, { spawnSyncImpl: () => { calls++; } }), /linked_issue_read_invalid/);
  assert.equal(calls, 0);
});

test("Codex injected-env recipe stays byte-identical regardless of linked-issue repository", () => {
  for (const reviewer_family of ["codex", "openai-codex"]) {
    const codex = { reviewer_family, mode: "pr-sticky", neutral_cwd_path: "/tmp/devpro-neutral", linked_issue_context: "issue_read_required" };
    assert.deepEqual(canonicalReviewerCliRecipe({ ...codex, repository_slug: context.repository_slug }), canonicalReviewerCliRecipe({ ...codex, repository_slug: "other/repo" }));
  }
});
