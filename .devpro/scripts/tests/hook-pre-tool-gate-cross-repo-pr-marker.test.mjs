/**
 * hook-pre-tool-gate-cross-repo-pr-marker.test.mjs
 *
 * Prove-it tests of openspec/changes/add-cross-repo-pr-scope-marker (design D9 #1-#16, #18). They run the real
 * PreToolUse hook (`pre-tool-gate.mjs`) against offline git fixtures:
 *
 *   parent (consumer, tracked pre-pr-checks file, origin owner/parent)
 *     vendor/target  submodule (origin owner/target)
 *   target-wt        linked worktree of that submodule, branch fix-x
 *   no-origin        `git init` checkout without a remote
 *   enterprise-self  checkout whose origin is enterprise.example/a/self
 *
 * Cross-repo PR writes are judged by the new gate `Cross-repo PR write gate`; every block assertion of that gate
 * matches that reason marker, so a block of today's Consumer pre-PR checks gate cannot satisfy it. An allow assertion
 * means the whole hook emitted no block. Cases that keep today's verdict (marker does not extend, same-repo, declared
 * checkout) are regression locks and are expected to pass before the implementation exists.
 *
 * Scenario titles follow `[Scenario: <capability> :: <bare title>] [WhenThen: 1]` (test-governance advisory mapping).
 */

import "./lib/git-location-isolated-env.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, "../hooks/pre-tool-gate.mjs");
const SCOPE_LIB = path.resolve(HERE, "../hooks/lib/cross-repo-pr-scope.mjs");

const GATE = /Cross-repo PR write gate/;
const CONSUMER_GATE = /^Consumer pre-PR checks gate: /;
const LEGACY_MISMATCH = /does not identify this local checkout/;
const BYPASS = /DEVPRO_HOOK_BYPASS/;

// Inherited values a developer shell could carry into the child hook; each test sets only what it needs.
const STRIPPED_ENV = [
  "GH_REPO",
  "GH_HOST",
  "DEVPRO_CROSS_REPO_PR",
  "DEVPRO_PR_CHECKOUT",
  "DEVPRO_REPO_SCOPE_APPROVED",
  "DEVPRO_HOOK_BYPASS",
];

const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "tester",
  GIT_AUTHOR_EMAIL: "tester.local",
  GIT_COMMITTER_NAME: "tester",
  GIT_COMMITTER_EMAIL: "tester.local",
};

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const FULL_SHA = "0".repeat(40);
const CHECKS_SHA = "1".repeat(40);
const DEV_LINE = `- DEV deploy-verify: HEAD ${FULL_SHA}; N/A: test fixture`;
const CHECKS_LINE = `- Consumer pre-PR checks: HEAD ${CHECKS_SHA}; all green`;

function prBody({ dev = true, checks = false } = {}) {
  return [
    "## OpenSpec",
    "- change: `openspec/changes/some-change/`",
    "",
    "## Test Evidence",
    "All tests pass.",
    ...(checks ? [CHECKS_LINE] : []),
    ...(dev ? [DEV_LINE] : []),
    "",
    "## Change Context",
    "- 改什麼：example landing",
    "- 目的：example purpose",
    "",
    "## Manual Test",
    "- N/A: rule-only grep change; no human UI path",
    "",
    "## Requirement Ledger Completion",
    "- disposition counts: implemented 1, partial 0, deferred 0, rejected 0, moved-to-issue 0",
    "- non-implemented rows: N/A",
    "",
    "## Scenario Walkthrough",
    "Hook fires on `gh pr create --body-file`.",
    "",
    "## Cost Circuit Breaker Overrides",
    "- N/A",
    "",
    "## 驗收證據",
    "- fixture",
    "",
    "Rules: v6.69.0 · Tool: Claude Code · Model: Sonnet 4.6",
    "",
  ].join("\n");
}

let fixture = null;
const fixtureRoot = makeTempDir("cross-repo-pr-marker-");
after(() => {
  try {
    rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {}
});

function initRepo(dir, branch) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", branch]);
  writeFileSync(path.join(dir, "f"), "initial\n");
  git(dir, ["add", "f"]);
  git(dir, ["commit", "-q", "--no-verify", "-m", "init"]);
  return dir;
}

// Built once and shared: the hook only reads these checkouts.
function fx() {
  if (fixture) return fixture;
  const targetSrc = initRepo(path.join(fixtureRoot, "target-src"), "main");
  const parent = initRepo(path.join(fixtureRoot, "parent"), "chore/check-body");
  git(parent, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", targetSrc, "vendor/target"]);
  // An applicable consumer: a tracked checks file makes the `Consumer pre-PR checks:` line mandatory for this checkout.
  mkdirSync(path.join(parent, ".devpro"), { recursive: true });
  writeFileSync(path.join(parent, ".devpro/pre-pr-checks.local.md"), "Run project checks.\n");
  git(parent, ["add", ".devpro"]);
  git(parent, ["commit", "-q", "--no-verify", "-m", "submodule and checks"]);
  // Origins are set only after the submodule add, and are never contacted: the gates read the configured URL.
  git(parent, ["remote", "add", "origin", "https://github.com/owner/parent.git"]);
  const submodule = path.join(parent, "vendor/target");
  git(submodule, ["remote", "set-url", "origin", "https://github.com/owner/target.git"]);
  const worktree = path.join(fixtureRoot, "target-wt-checkout");
  git(submodule, ["worktree", "add", "-q", "-b", "fix-x", worktree, "HEAD"]);
  const noOrigin = initRepo(path.join(fixtureRoot, "no-origin"), "chore/check-body");
  const enterprise = initRepo(path.join(fixtureRoot, "enterprise-self"), "chore/check-body");
  git(enterprise, ["remote", "add", "origin", "https://enterprise.example/a/self.git"]);
  // Consumer checkouts of owner/alias whose origin host is an SSH transport host, not the web host (review r2).
  const sshConsumer = (name, origin) => {
    const dir = initRepo(path.join(fixtureRoot, name), "chore/check-body");
    mkdirSync(path.join(dir, ".devpro"), { recursive: true });
    writeFileSync(path.join(dir, ".devpro/pre-pr-checks.local.md"), "Run project checks.\n");
    git(dir, ["add", ".devpro"]);
    git(dir, ["commit", "-q", "--no-verify", "-m", "checks"]);
    git(dir, ["remote", "add", "origin", origin]);
    return dir;
  };
  const sshAlias = sshConsumer("ssh-alias", "git@github-work:owner/alias.git");
  const ssh443 = sshConsumer("ssh-443", "ssh://git@ssh.github.com:443/owner/alias.git");
  const bodies = {};
  for (const [name, options] of [
    ["noChecks", {}],
    ["checks", { checks: true }],
    ["noDev", { dev: false }],
  ]) {
    bodies[name] = path.join(fixtureRoot, `body-${name}.md`);
    writeFileSync(bodies[name], prBody(options));
  }
  bodies.waiver = path.join(fixtureRoot, "body-waiver.md");
  writeFileSync(bodies.waiver, `## Test Evidence\n- DEV deploy-verify: HEAD ${"d".repeat(40)}; skipped per user decision: X\n`);
  fixture = { parent, submodule, worktree, noOrigin, enterprise, sshAlias, ssh443, bodies };
  return fixture;
}

function runHook(command, { cwd = fx().parent, env = {} } = {}) {
  const childEnv = { ...process.env, CODEX_CI: "", CODEX_THREAD_ID: "", DEVPRO_SENTINEL_STATE_DIR: makeTempDir("cross-repo-pr-sentinel-"), PWD: cwd };
  for (const key of STRIPPED_ENV) delete childEnv[key];
  const r = spawnSync("node", [HOOK], {
    cwd,
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command, cwd } }),
    encoding: "utf8",
    env: { ...childEnv, ...env },
  });
  let json = null;
  try {
    json = r.stdout && r.stdout.trim() ? JSON.parse(r.stdout) : null;
  } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const firstLine = (r) => String(r.json?.reason ?? "").split("\n")[0];

function assertBlocked(r, label) {
  assert.equal(r.json?.decision, "block", `${label}: expected a block, got ${r.stdout} ${r.stderr}`);
  assert.equal(typeof r.json.reason, "string", `${label}: a block carries a reason`);
  return r.json.reason;
}

// The new gate's block: its reason marker plus the repositories and fixes a writer needs.
function assertCrossRepoBlock(r, label) {
  const reason = assertBlocked(r, label);
  assert.match(reason, GATE, `${label}: the cross-repo PR write gate must be the one that blocks: ${reason}`);
  return reason;
}

function assertAllowed(r, label) {
  assert.equal(r.code, 0, `${label}: expected exit 0\nstderr: ${r.stderr}`);
  assert.notEqual(r.json?.decision, "block", `${label}: the whole hook must not block: ${JSON.stringify(r.json)}`);
}

function assertTwoLegalFixes(reason, target, label) {
  assert.match(reason, new RegExp(`DEVPRO_CROSS_REPO_PR=${target}`), `${label}: names the marker that authorizes ${target}`);
  assert.match(reason, /checkout/i, `${label}: names running inside the target checkout`);
  assert.doesNotMatch(reason, BYPASS, `${label}: never offers the bypass`);
}

const comment = (flags) => `gh pr comment 7 ${flags} --body hi`;
const edit = (flags) => `gh pr edit 7 ${flags} --title "chore: retitle"`;
const create = (flags, body = "noChecks") => `gh pr create --title "chore: x" ${flags} --body-file ${fx().bodies[body]}`;

test("fixture sanity: origins, branches and the applicable-consumer control", () => {
  const f = fx();
  assert.equal(git(f.parent, ["remote", "get-url", "origin"]), "https://github.com/owner/parent.git");
  assert.equal(git(f.worktree, ["remote", "get-url", "origin"]), "https://github.com/owner/target.git");
  assert.equal(git(f.worktree, ["branch", "--show-current"]), "fix-x");
  assert.equal(git(f.enterprise, ["remote", "get-url", "origin"]), "https://enterprise.example/a/self.git");
  assert.throws(() => git(f.noOrigin, ["remote", "get-url", "origin"]), "the no-origin checkout has no remote");
  // Same-repo create judges consumer evidence against the parent: without the checks line it blocks, with it it passes.
  const blocked = runHook(create("--head chore/check-body"));
  assert.equal(blocked.json?.decision, "block", blocked.stdout);
  assert.match(firstLine(blocked), CONSUMER_GATE);
  assertAllowed(runHook(create("--head chore/check-body", "checks")), "same-repo create with the checks line");
});

// ── Requirement: Cross-Repo PR Write Authorization Marker ───────────────────────────────────────────────────────

test("a cross-repo create refuses an unreadable checkout prefix before falling back to remote-only", () => {
  const marker = "DEVPRO_CROSS_REPO_PR=owner/target";
  const command = create("--repo owner/target --head fix-x");
  const unreadable = `${marker} DEVPRO_NOTE=$(printf '%s' $(true)) ${command}`;
  for (const input of [unreadable, `true && ${unreadable}`]) {
    const result = runHook(input);
    assert.equal(result.json?.decision, "block", result.stdout);
    assert.match(firstLine(result), /^PR checkout gate: cannot read the assignment prefix/);
  }
  assertAllowed(runHook(`${marker} DEVPRO_NOTE='DEVPRO_PR_CHECKOUT=/example' ${command}`), "a readable note is not a checkout declaration");
  assertAllowed(runHook("printf '%s' 'DEVPRO_PR_CHECKOUT=/example gh pr create'"), "a diagnostic string is not a create");
});

test("[Scenario: pre-tool-mechanical-gates :: Marker authorizes the named repository PR write] [WhenThen: 1] the marker allows create, edit and comment that write --repo for the named repository", () => {
  const marker = "DEVPRO_CROSS_REPO_PR=owner/target ";
  assertAllowed(runHook(`${marker}${create("--repo owner/target --head fix-x")}`), "marker create (body without the parent's checks line)");
  assertAllowed(runHook(`${marker}${create("-R owner/target --head fix-x")}`), "marker create -R");
  assertAllowed(runHook(`${marker}${edit("--repo owner/target")}`), "marker edit");
  assertAllowed(runHook(`${marker}${comment("--repo owner/target")}`), "marker comment");
  for (const flags of ["-R owner/target", "--repo=owner/target", "-Rowner/target"]) {
    assertAllowed(runHook(`${marker}${comment(flags)}`), `marker comment ${flags}`);
  }
  assertAllowed(runHook(`${marker}gh -R owner/target pr comment 7 --body hi`), "marker comment with a global -R before the subcommand");
  // The same writes without the marker are the cross-repo gate's block, never the legacy "not a local checkout" report.
  for (const [label, command] of [
    ["create", create("--repo owner/target --head fix-x")],
    ["edit", edit("--repo owner/target")],
    ["comment", comment("--repo owner/target")],
    ["global -R comment", "gh -R owner/target pr comment 7 --body hi"],
  ]) {
    const reason = assertCrossRepoBlock(runHook(command), `unmarked ${label}`);
    assert.doesNotMatch(reason, LEGACY_MISMATCH, label);
  }
});

test("[Scenario: pre-tool-mechanical-gates :: A PR URL selector is an explicit target] [WhenThen: 1] a PR URL names the target without --repo", () => {
  const marker = "DEVPRO_CROSS_REPO_PR=owner/target ";
  assertAllowed(runHook(`${marker}gh pr comment https://github.com/owner/target/pull/7 --body hi`), "marker comment by PR URL");
  assertAllowed(runHook(`${marker}gh pr edit https://github.com/owner/target/pull/7 --title "chore: retitle"`), "marker edit by PR URL");
  // Without the marker the URL is still read as the target: the block names the target repository, not the parent.
  const reason = assertCrossRepoBlock(runHook("gh pr comment https://github.com/owner/target/pull/7 --body hi"), "unmarked comment by PR URL");
  assert.match(reason, /owner\/target/);
  assertTwoLegalFixes(reason, "owner/target", "unmarked comment by PR URL");
});

test("[Scenario: pre-tool-mechanical-gates :: Disagreeing explicit targets block the write] [WhenThen: 1] values that disagree, or that a shell would expand, block as an ambiguous target", () => {
  const disagreeing = [
    "gh pr comment https://github.com/owner/target/pull/7 --repo c/third --body hi",
    "gh pr comment 7 -R owner/target -R c/third --body hi",
    "gh pr comment 7 -R owner/target --repo=c/third --body hi",
  ];
  for (const command of disagreeing) {
    for (const marker of ["", "DEVPRO_CROSS_REPO_PR=owner/target ", "DEVPRO_CROSS_REPO_PR=c/third "]) {
      const reason = assertCrossRepoBlock(runHook(`${marker}${command}`), `${marker}${command}`);
      assert.match(reason, /ambiguous/i, "the reason says the target is ambiguous");
      assert.match(reason, /single|only one|exactly one/i, "the reason asks for a single target");
    }
  }
  for (const flags of ['--repo "$TARGET_REPO"', "--repo=$(cat repo-name)", "-R $TARGET_REPO", "--repo `echo owner/target`"]) {
    const reason = assertCrossRepoBlock(runHook(`DEVPRO_CROSS_REPO_PR=owner/target ${comment(flags)}`), `shell-expanded ${flags}`);
    assert.match(reason, /literal/i, "the reason asks for a literal [HOST/]OWNER/REPO");
  }
  // Values that agree (same slug, case-insensitive) are one target.
  assertAllowed(runHook(`DEVPRO_CROSS_REPO_PR=owner/target ${comment("-R owner/target -R OWNER/Target")}`), "agreeing values are one target");
});

test("[Scenario: pre-tool-mechanical-gates :: A write without an explicit target is judged only when a marker asks for it] [WhenThen: 1] a marker payload that writes no target blocks, an unmarked one keeps its verdict", () => {
  for (const [label, command] of [
    ["comment", "gh pr comment 7 --body hi"],
    ["edit", 'gh pr edit 7 --title "chore: retitle"'],
  ]) {
    const reason = assertCrossRepoBlock(runHook(`DEVPRO_CROSS_REPO_PR=owner/target ${command}`), `marker ${label} without a target`);
    assert.match(reason, /--repo owner\/target/, "the reason asks for --repo <owner/repo>");
    assert.match(reason, /PR URL|pull\/|URL/i, "the reason offers a PR URL as the other way to name the target");
    assertAllowed(runHook(command), `unmarked ${label} without a target keeps today's verdict`);
  }
});

test("[Scenario: pre-tool-mechanical-gates :: A hostless marker matches the target by slug] [WhenThen: 1] a hostless marker allows a target that writes a host, without reading GH_HOST", () => {
  const command = comment("--repo enterprise.example/owner/target");
  assertAllowed(runHook(`DEVPRO_CROSS_REPO_PR=owner/target ${command}`), "hostless marker, host written in the target");
  assertAllowed(runHook(`DEVPRO_CROSS_REPO_PR=owner/target ${command}`, { env: { GH_HOST: "other.example" } }), "GH_HOST does not change the comparison");
  assertCrossRepoBlock(runHook(command), "the same write without a marker");
});

test("[Scenario: pre-tool-mechanical-gates :: A marker host requires the same written host in the target] [WhenThen: 1] a marker host must be written again in the target", () => {
  const marker = "DEVPRO_CROSS_REPO_PR=enterprise.example/owner/target ";
  const cases = [
    ["--repo owner/target", {}],
    ["--repo owner/target", { GH_HOST: "enterprise.example" }],
    ["--repo github.com/owner/target", {}],
  ];
  for (const [flags, env] of cases) {
    const label = `${flags} ${JSON.stringify(env)}`;
    const reason = assertCrossRepoBlock(runHook(`${marker}${comment(flags)}`, { env }), label);
    assert.match(reason, /--repo enterprise\.example\/owner\/target/, `${label}: asks for the host written in --repo`);
  }
  assertAllowed(runHook(`${marker}${comment("--repo enterprise.example/owner/target")}`), "host written in the target");
});

test("[Scenario: pre-tool-mechanical-gates :: A hostless target with the command checkout slug stays same-repo] [WhenThen: 1] a hostless target equal to the origin slug keeps its verdict (regression lock)", () => {
  const f = fx();
  assertAllowed(runHook(comment("--repo a/self"), { cwd: f.enterprise }), "hostless same-slug comment");
  assertAllowed(runHook(edit("--repo a/self"), { cwd: f.enterprise }), "hostless same-slug edit");
});

test("[Scenario: pre-tool-mechanical-gates :: A command checkout without an origin leaves an unmarked write unjudged] [WhenThen: 1] an origin-less checkout keeps the unmarked verdict and the marker allows the named repository", () => {
  const f = fx();
  assertAllowed(runHook(comment("--repo b/other"), { cwd: f.noOrigin }), "unmarked comment from an origin-less checkout");
  assertAllowed(runHook(`DEVPRO_CROSS_REPO_PR=b/other ${comment("--repo b/other")}`, { cwd: f.noOrigin }), "marker comment from an origin-less checkout");
});

test("[Scenario: pre-tool-mechanical-gates :: A command checkout without an origin leaves an unmarked write unjudged] [WhenThen: 1] a marker create from an origin-less checkout is allowed as remote-only", () => {
  const f = fx();
  const r = runHook(`DEVPRO_CROSS_REPO_PR=b/other ${create("--repo b/other --head chore/check-body")}`, { cwd: f.noOrigin });
  assertAllowed(r, "marker create from an origin-less checkout");
});

test("[Scenario: pre-tool-mechanical-gates :: Marker naming another repository still blocks] [WhenThen: 1] a marker for the command checkout repository does not authorize another repository", () => {
  for (const command of [comment("--repo owner/other"), edit("--repo owner/other"), create("--repo owner/other --head fix-x")]) {
    const reason = assertCrossRepoBlock(runHook(`DEVPRO_CROSS_REPO_PR=owner/parent ${command}`), command);
    assert.match(reason, /owner\/parent/, "names the checkout repository");
    assert.match(reason, /owner\/other/, "names the target repository");
    assertTwoLegalFixes(reason, "owner/other", command);
  }
});

test("[Scenario: pre-tool-mechanical-gates :: A cross-repo PR write without the marker blocks] [WhenThen: 1] create, edit and comment against another repository block with the two legal fixes", () => {
  for (const command of [
    create("--repo owner/other --head fix-x"),
    edit("--repo owner/other"),
    comment("--repo owner/other"),
  ]) {
    const reason = assertCrossRepoBlock(runHook(command), command);
    assert.match(reason, /owner\/other/);
    assertTwoLegalFixes(reason, "owner/other", command);
  }
});

test("[Scenario: pre-tool-mechanical-gates :: A cross-repo PR write without the marker blocks] [WhenThen: 1] an inherited GH_REPO is the explicit target when the command writes none", () => {
  const inherited = runHook("gh pr comment 7 --body hi", { env: { GH_REPO: "owner/other" } });
  const reason = assertCrossRepoBlock(inherited, "inherited GH_REPO=owner/other");
  assert.match(reason, /owner\/other/);
  assertTwoLegalFixes(reason, "owner/other", "inherited GH_REPO");
  // A written --repo wins over the inherited value, and a same-repo target keeps today's verdict.
  assertAllowed(runHook(comment("--repo owner/parent"), { env: { GH_REPO: "owner/other" } }), "written same-repo --repo with an inherited GH_REPO");
  assertAllowed(runHook(comment("--repo owner/parent")), "same-repo --repo without GH_REPO");
});

test("[Scenario: pre-tool-mechanical-gates :: Invalid marker values block instead of degrading to no marker] [WhenThen: 1] malformed, owner-only, URL, expansion and wildcard markers block", () => {
  const invalid = [
    "DEVPRO_CROSS_REPO_PR=devpro-agent-rules",
    "DEVPRO_CROSS_REPO_PR=devpro-tw",
    "DEVPRO_CROSS_REPO_PR=https://github.com/owner/target",
    "DEVPRO_CROSS_REPO_PR=$TARGET_REPO",
    "DEVPRO_CROSS_REPO_PR=${TARGET_REPO}",
    "DEVPRO_CROSS_REPO_PR=`echo owner/target`",
    "DEVPRO_CROSS_REPO_PR=$(echo owner/target)",
    "DEVPRO_CROSS_REPO_PR=*",
  ];
  for (const marker of invalid) {
    const reason = assertCrossRepoBlock(runHook(`${marker} ${comment("--repo owner/other")}`), marker);
    assert.match(reason, /DEVPRO_CROSS_REPO_PR/, `${marker}: the reason names the marker`);
    assert.match(reason, /invalid|malformed|literal/i, `${marker}: the reason says the marker value is the problem`);
    // The requirement blocks every create/edit/comment of the payload, so a same-repo write is blocked as well.
    assertCrossRepoBlock(runHook(`${marker} ${comment("--repo owner/parent")}`), `${marker} on a same-repo write`);
  }
});

test("[Scenario: pre-tool-mechanical-gates :: Invalid marker values block instead of degrading to no marker] [WhenThen: 1] several marker values must agree and * is not a repository", () => {
  const target = comment("--repo owner/target");
  assertCrossRepoBlock(runHook(`DEVPRO_CROSS_REPO_PR=owner/target DEVPRO_CROSS_REPO_PR=owner/other ${target}`), "two different values on one command");
  assertCrossRepoBlock(
    runHook(`DEVPRO_CROSS_REPO_PR=owner/target gh pr comment 7 --repo owner/target --body a && DEVPRO_CROSS_REPO_PR=owner/other gh pr comment 8 --repo owner/other --body b`),
    "two different values in two clauses",
  );
  assertAllowed(runHook(`DEVPRO_CROSS_REPO_PR=owner/target DEVPRO_CROSS_REPO_PR=owner/target ${target}`), "two equal values agree");
  // `DEVPRO_REPO_SCOPE_APPROVED=*` keeps its own meaning for a git write; a `*` PR marker is no repo-scope approval either way.
  assertAllowed(runHook(`DEVPRO_REPO_SCOPE_APPROVED=* git -C ${fx().worktree} add f`), "wildcard repo-scope approval keeps allowing the git write");
  const gitWrite = runHook(`DEVPRO_CROSS_REPO_PR=* git -C ${fx().worktree} add f`);
  assert.match(assertBlocked(gitWrite, "a * PR marker is not a repo-scope approval"), /Repo Scope Evidence Gate/);
});

test("[Scenario: pre-tool-mechanical-gates :: Marker authorization does not extend to git write or other gh surfaces] [WhenThen: 1] the marker keeps the verdict of git write, clone, merge, issue and api (regression lock)", () => {
  const f = fx();
  const marker = "DEVPRO_CROSS_REPO_PR=owner/target ";
  const gated = [
    ["git write into the target worktree", `git -C ${f.worktree} add f`, /Repo Scope Evidence Gate/],
    ["git clone", "git clone https://github.com/owner/target.git", /Repo Scope Evidence Gate/],
    ["gh repo clone", "gh repo clone owner/target", /Repo Scope Evidence Gate/],
    ["gh pr merge --squash", "gh pr merge 7 --repo owner/target --squash", /Merge strategy gate/],
  ];
  for (const [label, command, gate] of gated) {
    const marked = runHook(`${marker}${command}`);
    assert.match(assertBlocked(marked, `marker ${label}`), gate, `marker ${label}`);
    assert.doesNotMatch(marked.json.reason, GATE, `${label}: the marker is not a PR write authorization`);
    assert.match(assertBlocked(runHook(command), `unmarked ${label}`), gate, `unmarked ${label}`);
  }
  for (const [label, command] of [
    ["gh issue create", "gh issue create --repo owner/target --title x --body y"],
    ["gh api write", "gh api repos/owner/target/issues -X POST -f title=x"],
  ]) {
    assertAllowed(runHook(`${marker}${command}`), `marker ${label}`);
    assertAllowed(runHook(command), `unmarked ${label}`);
  }
  // A description edit that carries a per-PR waiver stays with the waiver edit gate; the marker does not relax it.
  const waiver = `gh pr edit 7 --repo owner/target --body-file ${f.bodies.waiver}`;
  const markedWaiver = runHook(`${marker}${waiver}`);
  assert.match(assertBlocked(markedWaiver, "marker waiver edit"), /Per-PR waiver edit gate/);
  assert.doesNotMatch(markedWaiver.json.reason, GATE, "the waiver edit gate, not the cross-repo gate, holds this edit");
});

test("[Scenario: pre-tool-mechanical-gates :: A marker inside quoted data or a heredoc authorizes nothing] [WhenThen: 1] a marker in a string, heredoc or comment is no marker", () => {
  const write = comment("--repo owner/target");
  const payloads = [
    `echo "DEVPRO_CROSS_REPO_PR=owner/target" && ${write}`,
    `echo 'DEVPRO_CROSS_REPO_PR=owner/target' && ${write}`,
    `cat <<'EOF'\nDEVPRO_CROSS_REPO_PR=owner/target\nEOF\n${write}`,
    `# DEVPRO_CROSS_REPO_PR=owner/target\n${write}`,
  ];
  for (const payload of payloads) {
    assertCrossRepoBlock(runHook(payload), payload);
  }
});

// ── Requirement: Consumer Pre-PR Checks Gate Treats An Undeclared Marker-Authorized Create As Remote-Only ──────────

test("[Scenario: pre-tool-mechanical-gates :: An undeclared marker-authorized create is remote-only] [WhenThen: 1] the parent's consumer evidence is not judged for a marker create", () => {
  // Control: the same body in a same-repo create is judged against the parent and blocked for the missing checks line.
  const control = runHook(create("--head chore/check-body"));
  assert.equal(control.json?.decision, "block", "the parent would block this body");
  assert.match(firstLine(control), CONSUMER_GATE);
  const marker = "DEVPRO_CROSS_REPO_PR=owner/target ";
  assertAllowed(runHook(`${marker}${create("--repo owner/target --head fix-x")}`), "marker create, body without the parent's checks line");
  assertAllowed(runHook(`${marker}${create("--repo owner/target --head fix-x", "noDev")}`), "marker create, body without a DEV line either");
  // Nothing is searched locally: the submodule worktree (branch fix-x) is not consulted, so a head that no local
  // worktree carries is just as acceptable.
  assertAllowed(runHook(`${marker}${create("--repo owner/target --head no-local-worktree-has-this")}`), "marker create with a head no checkout carries");
});

test("[Scenario: pre-tool-mechanical-gates :: A marker-authorized create must write its repository and head] [WhenThen: 1] a missing --head or a --repo that is only inherited blocks naming the missing piece", () => {
  const marker = "DEVPRO_CROSS_REPO_PR=owner/target ";
  const missingHead = runHook(`${marker}${create("--repo owner/target")}`);
  const headReason = assertBlocked(missingHead, "marker create without --head");
  assert.match(firstLine(missingHead), CONSUMER_GATE);
  assert.doesNotMatch(firstLine(missingHead), LEGACY_MISMATCH, "the block is about the missing head, not a checkout mismatch");
  assert.match(firstLine(missingHead), /literal/i);
  assert.match(firstLine(missingHead), /--head/);
  assert.match(headReason, /DEVPRO_PR_CHECKOUT=<absolute[- ]checkout>/);

  const inherited = runHook(`${marker}${create("--head fix-x")}`, { env: { GH_REPO: "owner/target" } });
  const repoReason = assertBlocked(inherited, "marker create with only an inherited GH_REPO");
  assert.match(firstLine(inherited), CONSUMER_GATE);
  assert.doesNotMatch(firstLine(inherited), LEGACY_MISMATCH, "the block is about the missing --repo, not a checkout mismatch");
  assert.match(firstLine(inherited), /literal/i);
  assert.match(firstLine(inherited), /--repo/);
  assert.match(repoReason, /DEVPRO_PR_CHECKOUT=<absolute[- ]checkout>/);

  // A command-local GH_REPO is no literal --repo either (already refused today; kept as a lock).
  const local = runHook(`${marker}GH_REPO=owner/target ${create("--head fix-x")}`);
  assert.match(firstLine(local), CONSUMER_GATE);
  assertBlocked(local, "marker create with a command-local GH_REPO");

  // A head that is not a literal branch name is not the authorized head.
  const dynamic = runHook(`${marker}${create('--repo owner/target --head "$BRANCH"')}`);
  assertBlocked(dynamic, "marker create with a non-literal head");
  assert.match(firstLine(dynamic), CONSUMER_GATE);
  assert.doesNotMatch(firstLine(dynamic), LEGACY_MISMATCH);
});

test("[Scenario: pre-tool-mechanical-gates :: A fork head is not authorized by the marker] [WhenThen: 1] an owner:branch head blocks with and without the marker", () => {
  const forkCreate = create("--repo owner/target --head contributor:branch");
  const marked = runHook(`DEVPRO_CROSS_REPO_PR=owner/target ${forkCreate}`);
  assertBlocked(marked, "marker create with a fork head");
  assert.match(firstLine(marked), CONSUMER_GATE);
  assert.doesNotMatch(firstLine(marked), LEGACY_MISMATCH, "the block names the fork head form");
  assert.match(firstLine(marked), /owner:branch/);
  assertBlocked(runHook(forkCreate), "the same create without the marker");
});

test("[Scenario: pre-tool-mechanical-gates :: A declared submodule worktree keeps the declared contract] [WhenThen: 1] a declared submodule worktree is judged the same with and without the marker (regression lock)", () => {
  const f = fx();
  const declared = (body) => `DEVPRO_PR_CHECKOUT=${f.worktree} ${create("--repo owner/target --head fix-x", body)}`;
  const marker = "DEVPRO_CROSS_REPO_PR=owner/target ";
  const plain = runHook(declared("noChecks"));
  const marked = runHook(`${marker}${declared("noChecks")}`);
  assertAllowed(plain, "declared worktree create");
  assertAllowed(marked, "declared worktree create with the marker");
  assert.equal(JSON.stringify(marked.json), JSON.stringify(plain.json), "the marker changes nothing for a declared checkout");
  // The checks run in the declared worktree: a body without the DEV line is blocked there, marker or not.
  const noDevPlain = runHook(declared("noDev"));
  const noDevMarked = runHook(`${marker}${declared("noDev")}`);
  assertBlocked(noDevPlain, "declared worktree create without a DEV line");
  assert.match(noDevPlain.json.reason, /DEV deploy-verify gate/);
  assert.doesNotMatch(noDevPlain.json.reason, /--head does not identify a checked-out local worktree/);
  assert.equal(noDevMarked.json?.reason, noDevPlain.json.reason, "the declared verdict is the same with the marker");
});

test("[Scenario: pre-tool-mechanical-gates :: The marker does not relax a declared checkout] [WhenThen: 1] a declared checkout whose origin is not --repo keeps blocking under the declared contract (regression lock)", () => {
  const f = fx();
  const r = runHook(`DEVPRO_CROSS_REPO_PR=other/repo DEVPRO_PR_CHECKOUT=${f.worktree} ${create("--repo other/repo --head fix-x")}`);
  const reason = assertBlocked(r, "declared checkout with a marker naming another repository");
  assert.match(firstLine(r), CONSUMER_GATE);
  assert.match(reason, LEGACY_MISMATCH, "the declared contract still requires --repo to name the checkout's origin");
  assert.doesNotMatch(reason, GATE, "the marker did not turn the write into a remote-only allowance");
});

test("[Scenario: pre-tool-mechanical-gates :: Same-repo behavior is unchanged] [WhenThen: 1] same-repo create, edit and comment keep today's verdicts (regression lock)", () => {
  const f = fx();
  // Create: judged against the parent, with or without a written same-repo --repo.
  assertAllowed(runHook(create("--head chore/check-body", "checks")), "same-repo create");
  assertAllowed(runHook(create("--repo owner/parent --head chore/check-body", "checks")), "same-repo create with --repo");
  const missingChecks = runHook(create("--repo owner/parent --head chore/check-body"));
  assertBlocked(missingChecks, "same-repo create without the checks line");
  assert.match(firstLine(missingChecks), CONSUMER_GATE);
  assert.doesNotMatch(missingChecks.json.reason, GATE);
  // Edit and comment: same-repo targets, written or not.
  for (const command of [comment("--repo owner/parent"), comment(""), edit("--repo owner/parent"), edit("")]) {
    assertAllowed(runHook(command), command);
  }
  // A declared write keeps requiring --repo of the checkout's origin, a literal --head and an absolute --body-file.
  const declaredNoRepo = runHook(`DEVPRO_PR_CHECKOUT=${f.worktree} ${create("--head fix-x")}`);
  assert.match(assertBlocked(declaredNoRepo, "declared without --repo"), /DEVPRO_PR_CHECKOUT also needs --repo\/-R/);
  const declaredNoHead = runHook(`DEVPRO_PR_CHECKOUT=${f.worktree} ${create("--repo owner/target")}`);
  assert.match(assertBlocked(declaredNoHead, "declared without --head"), /DEVPRO_PR_CHECKOUT also needs a literal --head/);
  const declaredRelative = runHook(`DEVPRO_PR_CHECKOUT=${f.worktree} gh pr create --title x --repo owner/target --head fix-x --body-file body.md`);
  assert.match(assertBlocked(declaredRelative, "declared with a relative --body-file"), /must be an absolute path/);
});

// ── Review r1 F-crpm-r1-01: a line continuation must not change which checkout a create declares ─────────────────
// The shell joins `\<newline>`, so `DEVPRO_PR_CHECKOUT=<dir> \<newline> gh pr create` declares the checkout. Today's
// clause scan of the consumer gate does not see that declaration; the expectations below are origin/main's verdicts
// for the same commands, so the marker changes nothing for a declared create in any layout.

const CONTINUATIONS = [["LF", "\\\n"], ["CRLF", "\\\r\n"]];

test("[Scenario: pre-tool-mechanical-gates :: A declared submodule worktree keeps the declared contract] [WhenThen: 1] a line continuation after the declaration is judged the same with and without the marker (regression lock)", () => {
  const f = fx();
  const marker = "DEVPRO_CROSS_REPO_PR=owner/target ";
  for (const [layout, sep] of CONTINUATIONS) {
    for (const body of ["noChecks", "noDev"]) {
      const declared = `DEVPRO_PR_CHECKOUT=${f.worktree} ${sep}${create("--repo owner/target --head fix-x", body)}`;
      const plain = runHook(declared);
      const marked = runHook(`${marker}${declared}`);
      const label = `${layout} continuation, ${body} body`;
      // origin/main blocks this layout in the consumer pre-PR checks gate: its clause scan does not see the declaration.
      assertBlocked(plain, `${label} without the marker`);
      assert.match(firstLine(plain), CONSUMER_GATE, `${label}: today's consumer gate verdict`);
      assert.match(plain.json.reason, LEGACY_MISMATCH, `${label}: today's reason`);
      assert.equal(JSON.stringify(marked.json), JSON.stringify(plain.json), `${label}: the marker changes nothing for a declared create`);
    }
  }
});

test("[Scenario: pre-tool-mechanical-gates :: An undeclared marker-authorized create is remote-only] [WhenThen: 1] a line continuation after the marker, also behind an earlier continued clause, keeps the remote-only allowance", () => {
  const marker = "DEVPRO_CROSS_REPO_PR=owner/target ";
  for (const [layout, sep] of CONTINUATIONS) {
    assertAllowed(runHook(`${marker}${sep}${create("--repo owner/target --head fix-x", "noDev")}`), `${layout} continuation after the marker`);
    assertAllowed(
      runHook(`echo a ${sep} b && ${marker}${sep}${create("--repo owner/target --head fix-x", "noDev")}`),
      `${layout} continuation in an earlier clause shifts no offset`,
    );
    assertCrossRepoBlock(runHook(`echo a ${sep} b && ${create("--repo owner/target --head fix-x")}`), `${layout}: without the marker it still blocks`);
  }
});

test("[Scenario: pre-tool-mechanical-gates :: A cross-repo PR write without the marker blocks] [WhenThen: 1] a backslash ending a quoted heredoc body is not a line continuation", () => {
  // Joining the body's last line onto the terminator would hide the comment behind the heredoc.
  const r = runHook(`cat <<'EOF' > /dev/null\nfoo \\\nEOF\n${comment("--repo owner/target")}`);
  assertTwoLegalFixes(assertCrossRepoBlock(r, "comment after a heredoc whose body ends with a backslash"), "owner/target", "heredoc");
});

test("[Scenario: pre-tool-mechanical-gates :: A PR URL selector is an explicit target] [WhenThen: 1] a PR URL after a line continuation is still the target", () => {
  const command = "gh pr comment \\\n https://github.com/owner/target/pull/7 --body hi";
  assertCrossRepoBlock(runHook(command), "continued PR URL without the marker");
  assertAllowed(runHook(`DEVPRO_CROSS_REPO_PR=owner/target ${command}`), "continued PR URL with the marker");
});

// ── D9 #18: the single-definition module reads only what the command writes ─────────────────────────────────────

// ── Review r2 F-crpm-r2-01: an scp or ssh origin carries the SSH transport host (an ~/.ssh/config alias, or
// ssh.github.com), not the web host a PR URL or a host-qualified --repo writes. The expectations are origin/main's
// verdicts for the same commands: own-repo edit and comment stay allowed, and a host-qualified own-repo create keeps
// the consumer gate's checkout mismatch with and without the marker, never the remote-only allowance.
test("[Scenario: pre-tool-mechanical-gates :: An SSH origin host is not compared with a written web host] [WhenThen: 1] own-repo edit and comment from an SSH alias or ssh.github.com origin keep their verdicts", () => {
  const f = fx();
  for (const cwd of [f.sshAlias, f.ssh443]) {
    for (const command of [
      "gh pr comment https://github.com/owner/alias/pull/7 --body hi",
      "gh pr edit https://github.com/owner/alias/pull/7 --title x",
      comment("--repo github.com/owner/alias"),
      comment("--repo owner/alias"),
    ]) {
      assertAllowed(runHook(command, { cwd }), `${path.basename(cwd)}: ${command}`);
      assertAllowed(runHook(`DEVPRO_CROSS_REPO_PR=owner/alias ${command}`, { cwd }), `${path.basename(cwd)}: marker ${command}`);
    }
    // A different repository is still judged from such a checkout.
    assertCrossRepoBlock(runHook(comment("--repo b/other"), { cwd }), `${path.basename(cwd)}: another repository`);
  }
});

test("[Scenario: pre-tool-mechanical-gates :: A marker create for the command checkout's own slug is not remote-only] [WhenThen: 1] a host-qualified own-slug create keeps the consumer gate verdict with and without the marker", () => {
  const f = fx();
  const cases = [
    [f.sshAlias, "owner/alias", "--repo github.com/owner/alias --head chore/check-body"],
    [f.ssh443, "owner/alias", "--repo github.com/owner/alias --head chore/check-body"],
    // An https origin on another host: same slug, written web host differs.
    [f.enterprise, "a/self", "--repo github.com/a/self --head chore/check-body"],
  ];
  for (const [cwd, slug, flags] of cases) {
    for (const body of ["noChecks", "noDev", "checks"]) {
      const label = `${path.basename(cwd)} ${body}`;
      const plain = runHook(create(flags, body), { cwd });
      const marked = runHook(`DEVPRO_CROSS_REPO_PR=${slug} ${create(flags, body)}`, { cwd });
      assertBlocked(plain, `${label} without the marker`);
      assertBlocked(marked, `${label} with the marker`);
      assert.match(firstLine(marked), CONSUMER_GATE, `${label}: the marker create is judged by the consumer gate`);
      assert.match(marked.json.reason, LEGACY_MISMATCH, `${label}: --repo does not identify this checkout`);
    }
  }
});

test("cross-repo-pr-scope.mjs never reads GH_HOST, gh configuration, worktree lists, branch queries or directory listings", () => {
  // No existsSync guard and no skip: until the module exists this read throws and the test fails.
  const source = readFileSync(SCOPE_LIB, "utf8");
  assert.ok(source.length > 0, "the module is not empty");
  assert.equal(
    source.match(/GH_HOST|hosts\.yml|worktree list|branch --show-current|readdir/g),
    null,
    "the target judgement reads only explicitly written values (design principle D3)",
  );
});

// ── Review r6 (codex second review, PR #3665, W10-pr-flag-position-gap) ─────────────────────────────────────────
// gh accepts --repo/-R after the verb, before `pr` (`gh -R <repo> pr <verb>`) and between `pr` and the verb
// (`gh pr -R <repo> <verb>`). The judgement must not depend on which of the three a writer picks.

const FLAG_POSITIONS = {
  "after the verb": (verb, repo, args) => `gh pr ${verb} ${args} --repo ${repo}`,
  "before pr": (verb, repo, args) => `gh -R ${repo} pr ${verb} ${args}`,
  "between pr and the verb": (verb, repo, args) => `gh pr -R ${repo} ${verb} ${args}`,
};
const NEW_FLAG_POSITIONS = ["before pr", "between pr and the verb"];
const verbArgs = (verb, head = "--head fix-x", body = "noChecks") => ({
  create: `--title "chore: x" ${head} --body-file ${fx().bodies[body]}`,
  edit: '7 --title "chore: retitle"',
  comment: "7 --body hi",
})[verb];

test("[Scenario: pre-tool-mechanical-gates :: Every target flag position is judged the same] [WhenThen: 1] create, edit and comment block without the marker and pass with it in all three flag positions", () => {
  const marker = "DEVPRO_CROSS_REPO_PR=owner/target ";
  for (const [position, write] of Object.entries(FLAG_POSITIONS)) {
    for (const verb of ["create", "edit", "comment"]) {
      const command = write(verb, "owner/target", verbArgs(verb));
      const label = `${verb} with --repo ${position}`;
      const reason = assertCrossRepoBlock(runHook(command), `unmarked ${label}`);
      assertTwoLegalFixes(reason, "owner/target", `unmarked ${label}`);
      assertAllowed(runHook(`${marker}${command}`), `marker ${label}`);
    }
  }
});

test("[Scenario: pre-tool-mechanical-gates :: Every target flag position is judged the same] [WhenThen: 1] values written in two positions that disagree block as an ambiguous target", () => {
  for (const command of [
    "gh -R owner/target pr -R owner/other comment 7 --body hi",
    "gh pr -R owner/target comment 7 --repo owner/other --body hi",
    "gh -R owner/target pr -R owner/other edit 7 --title \"chore: retitle\"",
  ]) {
    const reason = assertCrossRepoBlock(runHook(`DEVPRO_CROSS_REPO_PR=owner/target ${command}`), command);
    assert.match(reason, /ambiguous/, command);
  }
});

// ── fix-pre-verb-repo-flag-gates: the gates behind gh pr create|edit|merge read every flag position ───────────────
// Before this change a same-repo write with -R before the verb skipped the consumer pre-PR checks, the PR body
// template lint, the waiver edit gate and the cross-model merge gate. Each case runs the after-verb form as the
// reference (its block is asserted, so parity cannot pass vacuously) and requires the identical hook verdict in the
// two new positions.
const verdictOf = (r) => ({ code: r.code, decision: r.json?.decision ?? null, reason: r.json?.reason ?? null });
const MOCK_PR = JSON.stringify({
  number: 7, state: "OPEN", headRefName: "feature/add-x", headRefOid: "a".repeat(40), baseRefName: "main",
  isCrossRepository: false, comments: [], body: "",
});
// gh is never called: the PR view and its changed-file list both come from the merge gate mocks.
const MERGE_MOCKS = { CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: MOCK_PR, CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: "M\tsrc/x.mjs" };

test("[Scenario: pre-tool-mechanical-gates :: Same-repo behavior is unchanged] [WhenThen: 1] a same-repo create, edit, comment and merge get the after-verb verdict in every flag position", () => {
  const f = fx();
  const cases = [
    { verb: "create", args: `--title "chore: x" --head chore/check-body --body-file ${f.bodies.noChecks}`, blocks: CONSUMER_GATE },
    { verb: "create", args: `--title "chore: x" --head chore/check-body --body-file ${f.bodies.checks}` },
    { verb: "edit", args: `7 --body-file ${f.bodies.waiver}`, blocks: /waiver/i },
    { verb: "edit", args: '7 --title "chore: retitle"' },
    { verb: "comment", args: "7 --body hi" },
    { verb: "merge", args: "7 --merge", blocks: /Cross-Model Merge Gate/ },
  ];
  const env = MERGE_MOCKS;
  for (const { verb, args, blocks } of cases) {
    // A merge writes its repository in full (with the host); the other verbs are judged as before.
    const parent = verb === "merge" ? "github.com/owner/parent" : "owner/parent";
    const reference = runHook(FLAG_POSITIONS["after the verb"](verb, parent, args), { env });
    if (blocks) assert.match(assertBlocked(reference, `after-verb ${verb} ${args}`), blocks);
    else assertAllowed(reference, `after-verb ${verb} ${args}`);
    for (const position of NEW_FLAG_POSITIONS) {
      const r = runHook(FLAG_POSITIONS[position](verb, parent, args), { env });
      assert.deepEqual(verdictOf(r), verdictOf(reference), `${verb} ${args} with -R ${position}`);
    }
  }
});

test("[Scenario: pre-tool-mechanical-gates :: Same-repo behavior is unchanged] [WhenThen: 1] a merge looks its PR up in the repository written before the verb", () => {
  const traced = (command) => {
    const trace = path.join(makeTempDir("repo-flag-merge-trace-"), "trace.jsonl");
    const r = runHook(command, { env: { ...MERGE_MOCKS, CROSS_MODEL_MERGE_GATE_TRACE_REPO_FILE: trace } });
    let text = "";
    try { text = readFileSync(trace, "utf8"); } catch {}
    return { lookups: text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)), verdict: verdictOf(r) };
  };
  const repo = "github.com/owner/parent";
  const reference = traced(FLAG_POSITIONS["after the verb"]("merge", repo, "7 --merge"));
  // The lookup carries the host as written: a bare owner/parent here would mean the host was dropped.
  assert.ok(reference.lookups.length > 0, `after-verb merge looks its PR up: ${JSON.stringify(reference)}`);
  for (const entry of reference.lookups) assert.equal(entry.repo, repo, `every lookup names ${repo}: ${JSON.stringify(reference)}`);
  assert.ok(reference.lookups.some((entry) => entry.helper === "_runGhPrView" && entry.pr === "7"), `after-verb merge views PR 7: ${JSON.stringify(reference)}`);
  for (const position of NEW_FLAG_POSITIONS) {
    assert.deepEqual(traced(FLAG_POSITIONS[position]("merge", repo, "7 --merge")), reference, `merge of ${repo} with -R ${position}`);
  }
  // Another repository is read from every flag position too: each is the same cross-repo merge block, before any lookup.
  const other = traced(FLAG_POSITIONS["after the verb"]("merge", "github.com/owner/other", "7 --merge"));
  assert.equal(other.verdict.decision, "block", JSON.stringify(other));
  assert.match(other.verdict.reason, /^Cross-repo PR merge gate: this merges github\.com\/owner\/other, not the repository of this checkout/);
  assert.deepEqual(other.lookups, []);
  for (const position of NEW_FLAG_POSITIONS) {
    assert.deepEqual(traced(FLAG_POSITIONS[position]("merge", "github.com/owner/other", "7 --merge")), other, `merge of owner/other with -R ${position}`);
  }
});

test("[Scenario: pre-tool-mechanical-gates :: A marker-authorized create is checked in every flag position] [WhenThen: 1] a missing, non-literal or fork head blocks in the new flag positions", () => {
  const marker = "DEVPRO_CROSS_REPO_PR=owner/target ";
  for (const position of NEW_FLAG_POSITIONS) {
    const write = (head) => `${marker}${FLAG_POSITIONS[position]("create", "owner/target", verbArgs("create", head))}`;
    const missing = runHook(write(""));
    assertBlocked(missing, `marker create without --head, -R ${position}`);
    assert.match(firstLine(missing), CONSUMER_GATE, position);
    assert.match(firstLine(missing), /literal --head/, position);
    const dynamic = runHook(write('--head "$BRANCH"'));
    assertBlocked(dynamic, `marker create with a non-literal head, -R ${position}`);
    assert.match(firstLine(dynamic), /literal --head/, position);
    const fork = runHook(write("--head contributor:branch"));
    assertBlocked(fork, `marker create with a fork head, -R ${position}`);
    assert.match(firstLine(fork), /owner:branch/, position);
    // The parent's consumer evidence is still not judged for a passing one.
    assertAllowed(runHook(write("--head fix-x")), `marker create with a literal head, -R ${position}`);
  }
});

test("[Scenario: pre-tool-mechanical-gates :: A marker-authorized create is checked in every flag position] [WhenThen: 1] a declared checkout of another repository and an own-slug target keep the existing contracts in the new flag positions", () => {
  const f = fx();
  for (const position of NEW_FLAG_POSITIONS) {
    // The declared checkout is the parent, so --repo owner/target does not name its origin: blocked with or without the marker.
    const declared = `DEVPRO_PR_CHECKOUT=${f.parent} ${FLAG_POSITIONS[position]("create", "owner/target", verbArgs("create"))}`;
    const marked = runHook(`DEVPRO_CROSS_REPO_PR=owner/target ${declared}`);
    assertBlocked(marked, `marker + declared parent, -R ${position}`);
    assert.match(firstLine(marked), CONSUMER_GATE, position);
    assert.match(marked.json.reason, LEGACY_MISMATCH, position);
    // An own-slug target on another host is never remote-only.
    const ownSlug = FLAG_POSITIONS[position]("create", "github.com/a/self", verbArgs("create", "--head chore/check-body"));
    const ownMarked = runHook(`DEVPRO_CROSS_REPO_PR=a/self ${ownSlug}`, { cwd: f.enterprise });
    assertBlocked(ownMarked, `own-slug marker create, -R ${position}`);
    assert.match(firstLine(ownMarked), CONSUMER_GATE, position);
    assert.match(ownMarked.json.reason, LEGACY_MISMATCH, position);
  }
});
