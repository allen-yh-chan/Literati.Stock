/**
 * hook-pre-tool-gate-submodule-gitlink.test.mjs
 *
 * Integration tests for the W1 (Worktree Mandatory For Branch Checkout)
 * submodule-pointer-update exception in pre-tool-gate.mjs.
 *
 * The exception: a registered submodule's working directory (its parent
 * `.gitmodules` carries the matching `path =` entry) may check out a tag or a
 * 40-hex commit without W1 blocking, because that checkout only moves the
 * gitlink (detached HEAD) and neither creates nor switches a branch. Branch
 * checkout/create, remote-tracking names, revspecs, unregistered paths and a
 * missing/unreadable parent `.gitmodules` keep the original block.
 *
 * Fixtures: one parent repo template (carries the worktree SoT, a `path =
 * .devpro-agent-rules` submodule added from a local repo, `plainsub/` and an
 * unregistered nested repo `vendor-rules/`) built once with
 * `protocol.file.allow=always` and reused through cpSync. Cases call the gate
 * in-process through evaluatePreToolUsePayload().
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, cpSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePreToolUsePayload, PASS_THROUGH } from "../hooks/pre-tool-gate.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const REAL_PREFLIGHT = readFileSync(
  path.resolve(SCRIPT_DIR, "../../agent-rules/preflight-checklist.md"),
  "utf8"
);
const REAL_ANCHOR_RULE = readFileSync(
  path.resolve(SCRIPT_DIR, "../../agent-rules/git-branch-naming-and-anchor.md"),
  "utf8"
);

// Tag shape kept out of the release-version namespace on purpose: these are
// fixture tags, never production metadata.
const SUBMODULE_TAG = "fixture-v9.9.9";
const SUBMODULE_BRANCH = "chore/sub-branch";
const DUAL_REF = "dual-ref";
const SUBMODULE_DIR = ".devpro-agent-rules";

const tmpRoot = makeTempDir("wt-submodule-gitlink-test-");
after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  }
  return r.stdout.trim();
}

function writeRuleFiles(dir) {
  mkdirSync(path.join(dir, ".devpro/agent-rules"), { recursive: true });
  writeFileSync(path.join(dir, ".devpro/agent-rules/preflight-checklist.md"), REAL_PREFLIGHT);
  writeFileSync(path.join(dir, ".devpro/agent-rules/git-branch-naming-and-anchor.md"), REAL_ANCHOR_RULE);
}

function initRepo(dir, branchName = "main") {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", branchName]);
  git(dir, ["config", "user.email", "t@t.com"]);
  git(dir, ["config", "user.name", "t"]);
}

// Sub repo: carries the worktree SoT (so W1 does not skip on the submodule's own
// root), a tag, a work branch, a tag/branch name collision, and a second commit
// whose 40-hex SHA is the pinned-commit fixture.
function buildSubTemplate() {
  const dir = path.join(tmpRoot, "template-sub");
  initRepo(dir);
  writeRuleFiles(dir);
  writeFileSync(path.join(dir, "sub.txt"), "one\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "sub init"]);
  git(dir, ["tag", SUBMODULE_TAG]);
  git(dir, ["tag", DUAL_REF]);
  git(dir, ["branch", DUAL_REF]);
  git(dir, ["checkout", "-q", "-b", SUBMODULE_BRANCH]);
  writeFileSync(path.join(dir, "sub.txt"), "two\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "sub work"]);
  const sha = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["checkout", "-q", SUBMODULE_TAG]);
  return { dir, sha };
}

// Parent repo: carries the worktree SoT + the same tag name (so a ref can be
// classified as pinned while the cwd still fails the submodule-path check),
// a registered submodule, a plain directory, and an unregistered nested repo.
function buildParentTemplate({ subRepoDir }) {
  const dir = path.join(tmpRoot, "template-parent");
  initRepo(dir);
  writeRuleFiles(dir);
  writeFileSync(path.join(dir, "README.md"), "parent\n");
  mkdirSync(path.join(dir, "plainsub"), { recursive: true });
  writeFileSync(path.join(dir, "plainsub", "file.txt"), "plain\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "parent init"]);
  git(dir, ["tag", SUBMODULE_TAG]);
  git(dir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", subRepoDir, SUBMODULE_DIR]);
  git(dir, ["commit", "-q", "-m", "add submodule"]);
  // Unregistered nested repository inside the parent working tree: it looks like
  // a checkout target and carries the SoT, but no `.gitmodules` entry registers it.
  const nested = path.join(dir, "vendor-rules");
  initRepo(nested);
  writeRuleFiles(nested);
  writeFileSync(path.join(nested, "n.txt"), "nested\n");
  git(nested, ["add", "-A"]);
  git(nested, ["commit", "-q", "-m", "nested init"]);
  git(nested, ["tag", SUBMODULE_TAG]);
  return { dir };
}

let parentTemplate;
let subSha;

function ensureTemplates() {
  if (parentTemplate) return { parentTemplate, subSha };
  const sub = buildSubTemplate();
  const parent = buildParentTemplate({ subRepoDir: sub.dir });
  parentTemplate = parent.dir;
  subSha = sub.sha;
  return { parentTemplate, subSha };
}

let counter = 0;

function setupRepo() {
  ensureTemplates();
  const dir = path.join(tmpRoot, `repo-${counter++}`);
  cpSync(parentTemplate, dir, { recursive: true });
  // A cwd below the registered path (not the registered path itself).
  mkdirSync(path.join(dir, SUBMODULE_DIR, "x/y"), { recursive: true });
  // `git submodule add` clones only the default branch locally; the tag/branch
  // name-collision case needs both refs inside the submodule's own refs.
  git(subPath(dir), ["branch", DUAL_REF]);
  return dir;
}

function subPath(dir) {
  return path.join(dir, SUBMODULE_DIR);
}

function gateResultToJson(result) {
  if (!result || result === PASS_THROUGH) return null;
  if (result.block) return { decision: "block", reason: result.reason };
  if (result.advisory) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: result.advisory,
      },
    };
  }
  return null;
}

function runHook(payload, { cwd, env = {} } = {}) {
  const saved = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const enriched = cwd ? { ...payload, cwd: payload.cwd || cwd } : payload;
    return { json: gateResultToJson(evaluatePreToolUsePayload(enriched)) };
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function runBash(command, cwd) {
  return runHook({ tool_name: "Bash", tool_input: { command } }, { cwd });
}

const SCOPED = `DEVPRO_REPO_SCOPE_APPROVED=${SUBMODULE_DIR}`;

// ── W1 submodule pointer update exception ─────────────────────────────────

// [Scenario: pre-tool-mechanical-gates :: Registered submodule tag checkout is not a branch checkout] [WhenThen: 1]
test("W1S1: Registered submodule tag checkout is not a branch checkout — short tag", () => {
  const dir = setupRepo();
  const r = runBash(`${SCOPED} git -C ${SUBMODULE_DIR} checkout -q ${SUBMODULE_TAG}`, dir);
  assert.notEqual(r.json?.decision, "block", `expected no block, got ${JSON.stringify(r.json)}`);
});

// [Scenario: pre-tool-mechanical-gates :: Registered submodule tag checkout is not a branch checkout] [WhenThen: 1]
test("W1S1: Registered submodule tag checkout is not a branch checkout — absolute -C and no git add in payload", () => {
  const dir = setupRepo();
  const command = `${SCOPED} git -C ${JSON.stringify(subPath(dir))} checkout -q ${SUBMODULE_TAG}`;
  assert.ok(!command.includes("git add"), "payload must not carry a git add step");
  const r = runBash(command, dir);
  assert.notEqual(r.json?.decision, "block", `expected no block, got ${JSON.stringify(r.json)}`);
});

// [Scenario: pre-tool-mechanical-gates :: Registered submodule tag checkout is not a branch checkout] [WhenThen: 1]
test("W1S1: Registered submodule tag checkout is not a branch checkout — tags/<ref> and refs/tags/<ref> forms", () => {
  const dir = setupRepo();
  for (const ref of [`tags/${SUBMODULE_TAG}`, `refs/tags/${SUBMODULE_TAG}`]) {
    const r = runBash(`${SCOPED} git -C ${SUBMODULE_DIR} checkout ${ref}`, dir);
    assert.notEqual(r.json?.decision, "block", `${ref} should not block, got ${JSON.stringify(r.json)}`);
  }
});

// [Scenario: pre-tool-mechanical-gates :: Registered submodule commit checkout is not a branch checkout] [WhenThen: 1]
test("W1S2: Registered submodule commit checkout is not a branch checkout — 40-hex sha", () => {
  const dir = setupRepo();
  const r = runBash(`${SCOPED} git -C ${SUBMODULE_DIR} checkout -q ${subSha}`, dir);
  assert.notEqual(r.json?.decision, "block", `expected no block, got ${JSON.stringify(r.json)}`);
});

// [Scenario: pre-tool-mechanical-gates :: Registered submodule commit checkout is not a branch checkout] [WhenThen: 1]
test("W1S2: Registered submodule commit checkout is not a branch checkout — --detach <tag>", () => {
  const dir = setupRepo();
  const r = runBash(`${SCOPED} git -C ${SUBMODULE_DIR} checkout --detach ${SUBMODULE_TAG}`, dir);
  assert.notEqual(r.json?.decision, "block", `expected no block, got ${JSON.stringify(r.json)}`);
});

// [Scenario: pre-tool-mechanical-gates :: Registered submodule commit checkout is not a branch checkout] [WhenThen: 1]
test("W1S2: Registered submodule commit checkout is not a branch checkout — sha shadowed by a local branch blocks", () => {
  const dir = setupRepo();
  // The branch veto runs before the 40-hex literal check: a local branch named
  // exactly like the SHA means `checkout <sha>` resolves to a branch.
  git(subPath(dir), ["branch", subSha]);
  const r = runBash(`${SCOPED} git -C ${SUBMODULE_DIR} checkout -q ${subSha}`, dir);
  assert.equal(r.json?.decision, "block", `expected block, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Checkout gate/);
});

// [Scenario: pre-tool-mechanical-gates :: Submodule branch checkout still blocks] [WhenThen: 1]
test("W1S3: Submodule branch checkout still blocks — existing branch", () => {
  const dir = setupRepo();
  const r = runBash(`${SCOPED} git -C ${SUBMODULE_DIR} checkout ${SUBMODULE_BRANCH}`, dir);
  assert.equal(r.json?.decision, "block", `expected block, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Checkout gate/);
});

// [Scenario: pre-tool-mechanical-gates :: Submodule branch checkout still blocks] [WhenThen: 1]
test("W1S3: Submodule branch checkout still blocks — switch -c hits the Create gate", () => {
  const dir = setupRepo();
  const r = runBash(`${SCOPED} git -C ${SUBMODULE_DIR} switch -c chore/add-thing`, dir);
  assert.equal(r.json?.decision, "block", `expected block, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Create gate/);
});

// [Scenario: pre-tool-mechanical-gates :: Submodule branch checkout still blocks] [WhenThen: 1]
test("W1S3: Submodule branch checkout still blocks — tag/branch name collision resolves to the branch", () => {
  const dir = setupRepo();
  const r = runBash(`${SCOPED} git -C ${SUBMODULE_DIR} checkout ${DUAL_REF}`, dir);
  assert.equal(r.json?.decision, "block", `expected block, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Checkout gate/);
});

// [Scenario: pre-tool-mechanical-gates :: Unregistered path keeps the W1 block] [WhenThen: 1]
test("W1S4: Unregistered path keeps the W1 block — ordinary nested repository", () => {
  const dir = setupRepo();
  const r = runBash(
    `DEVPRO_REPO_SCOPE_APPROVED=vendor-rules git -C vendor-rules checkout ${SUBMODULE_TAG}`,
    dir
  );
  assert.equal(r.json?.decision, "block", `expected block, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Checkout gate/);
});

// [Scenario: pre-tool-mechanical-gates :: Unregistered path keeps the W1 block] [WhenThen: 1]
test("W1S4: Unregistered path keeps the W1 block — plain directory inside the parent", () => {
  const dir = setupRepo();
  const r = runBash(`git -C plainsub checkout ${SUBMODULE_TAG}`, dir);
  assert.equal(r.json?.decision, "block", `expected block, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Checkout gate/);
});

// [Scenario: pre-tool-mechanical-gates :: Unregistered path keeps the W1 block] [WhenThen: 1]
test("W1S4: Unregistered path keeps the W1 block — cwd below a registered path is not that path", () => {
  const dir = setupRepo();
  const r = runBash(`${SCOPED} git -C ${SUBMODULE_DIR}/x/y checkout ${SUBMODULE_TAG}`, dir);
  assert.equal(r.json?.decision, "block", `expected block, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Checkout gate/);
});

// [Scenario: pre-tool-mechanical-gates :: Missing parent .gitmodules keeps the W1 block] [WhenThen: 1]
test("W1S5: Missing parent .gitmodules keeps the W1 block — .gitmodules removed", () => {
  const dir = setupRepo();
  rmSync(path.join(dir, ".gitmodules"));
  assert.equal(existsSync(path.join(dir, ".gitmodules")), false);
  const r = runBash(`${SCOPED} git -C ${SUBMODULE_DIR} checkout ${SUBMODULE_TAG}`, dir);
  assert.equal(r.json?.decision, "block", `expected block, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Checkout gate/);
});

// [Scenario: pre-tool-mechanical-gates :: Missing parent .gitmodules keeps the W1 block] [WhenThen: 1]
test("W1S5: Missing parent .gitmodules keeps the W1 block — no matching path entry", () => {
  const dir = setupRepo();
  writeFileSync(
    path.join(dir, ".gitmodules"),
    `[submodule "something-else"]\n\tpath = something-else\n\turl = ./somewhere\n`
  );
  const r = runBash(`${SCOPED} git -C ${SUBMODULE_DIR} checkout ${SUBMODULE_TAG}`, dir);
  assert.equal(r.json?.decision, "block", `expected block, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Checkout gate/);
});

// [Scenario: pre-tool-mechanical-gates :: Checkout block reason names the tag-or-sha form for submodule pointers] [WhenThen: 1]
test("W1S6: Checkout block reason names the tag-or-sha form for submodule pointers — non-pathspec exit", () => {
  const dir = setupRepo();
  const r = runBash("git checkout chore/add-foo", dir);
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /子模組指標更新請用 tag／sha/);
  assert.match(r.json.reason, /git worktree add "\$REPO_ROOT\/\.worktree\//);
  assert.match(r.json.reason, /git-branch-naming-and-anchor\.md §Worktree 規範/);
});

// [Scenario: pre-tool-mechanical-gates :: Checkout block reason names the tag-or-sha form for submodule pointers] [WhenThen: 1]
test("W1S6: Checkout block reason names the tag-or-sha form for submodule pointers — path-restore exit keeps its own reason", () => {
  const dir = setupRepo();
  const r = runBash("git checkout README.md", dir);
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /子模組指標更新請用 tag／sha/);
  assert.match(r.json.reason, /git checkout -- README\.md/);
  assert.doesNotMatch(r.json.reason, /git worktree add "\$REPO_ROOT\/\.worktree\/README\.md/);
});

// [Scenario: pre-tool-mechanical-gates :: Remote-tracking name and revspec still block in a registered submodule] [WhenThen: 1]
test("W1S7: Remote-tracking name and revspec still block in a registered submodule — origin/main", () => {
  const dir = setupRepo();
  const r = runBash(`${SCOPED} git -C ${SUBMODULE_DIR} checkout origin/main`, dir);
  assert.equal(r.json?.decision, "block", `expected block, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Checkout gate/);
});

// [Scenario: pre-tool-mechanical-gates :: Remote-tracking name and revspec still block in a registered submodule] [WhenThen: 1]
test("W1S7: Remote-tracking name and revspec still block in a registered submodule — <tag>^{commit} revspec", () => {
  const dir = setupRepo();
  const r = runBash(`${SCOPED} git -C ${SUBMODULE_DIR} checkout '${SUBMODULE_TAG}^{commit}'`, dir);
  assert.equal(r.json?.decision, "block", `expected block, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Checkout gate/);
});

// [Scenario: pre-tool-mechanical-gates :: Registered submodule tag checkout is not a branch checkout] [WhenThen: 1]
test("W1S1: Registered submodule tag checkout is not a branch checkout — subsection name with spaces and normalized path value", () => {
  const dir = setupRepo();
  // `git config -z` keeps a space-containing subsection unambiguous, and the
  // `./` + trailing-slash path value normalizes to the same registered path.
  writeFileSync(
    path.join(dir, ".gitmodules"),
    `[submodule "shared rules"]\n\tpath = ./${SUBMODULE_DIR}/\n\turl = ./somewhere\n`
  );
  const r = runBash(`${SCOPED} git -C ${SUBMODULE_DIR} checkout ${SUBMODULE_TAG}`, dir);
  assert.notEqual(r.json?.decision, "block", `expected no block, got ${JSON.stringify(r.json)}`);
});

// [Scenario: pre-tool-mechanical-gates :: Missing parent .gitmodules keeps the W1 block] [WhenThen: 1]
test("W1S5: Missing parent .gitmodules keeps the W1 block — escaping/absolute path entries are discarded", () => {
  const dir = setupRepo();
  writeFileSync(
    path.join(dir, ".gitmodules"),
    `[submodule "escape"]\n\tpath = ../escape\n[submodule "abs"]\n\tpath = /tmp/elsewhere\n`
  );
  const r = runBash(`${SCOPED} git -C ${SUBMODULE_DIR} checkout ${SUBMODULE_TAG}`, dir);
  assert.equal(r.json?.decision, "block", `expected block, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Checkout gate/);
});

// ── ref classification / submodule detection fail-closed extras ────────────

test("W1S-extra: --detach <branch> in a registered submodule still blocks", () => {
  const dir = setupRepo();
  const r = runBash(`${SCOPED} git -C ${SUBMODULE_DIR} checkout --detach ${SUBMODULE_BRANCH}`, dir);
  assert.equal(r.json?.decision, "block", `expected block, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Checkout gate/);
});

test("W1S-extra: refs/heads/<ref> form in a registered submodule still blocks", () => {
  const dir = setupRepo();
  const r = runBash(`${SCOPED} git -C ${SUBMODULE_DIR} checkout refs/heads/${SUBMODULE_BRANCH}`, dir);
  assert.equal(r.json?.decision, "block", `expected block, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Checkout gate/);
});

test("W1S-extra: nonexistent ref in a registered submodule still blocks (fail closed)", () => {
  const dir = setupRepo();
  const r = runBash(`${SCOPED} git -C ${SUBMODULE_DIR} checkout fixture-v0.0.0`, dir);
  assert.equal(r.json?.decision, "block", `expected block, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Checkout gate/);
});

test("W1S-extra: main repo root tag checkout still blocks (not a submodule pointer update)", () => {
  const dir = setupRepo();
  const r = runBash(`git checkout ${SUBMODULE_TAG}`, dir);
  assert.equal(r.json?.decision, "block", `expected block, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Checkout gate/);
});

test("W1S-extra: an earlier exempt checkout does not mask a later branch checkout", () => {
  const dir = setupRepo();
  const r = runBash(
    `${SCOPED} git -C ${SUBMODULE_DIR} checkout -q ${SUBMODULE_TAG} && git checkout chore/add-foo`,
    dir
  );
  assert.equal(r.json?.decision, "block", `expected block, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Checkout gate/);
});

test("W1S-extra: switch with a git global option still reaches the exception", () => {
  const repo = setupRepo();
  for (const command of [
    `DEVPRO_REPO_SCOPE_APPROVED=.devpro-agent-rules git -C .devpro-agent-rules switch ${SUBMODULE_TAG}`,
    `DEVPRO_REPO_SCOPE_APPROVED=.devpro-agent-rules git -C .devpro-agent-rules switch --detach ${SUBMODULE_TAG}`,
    `DEVPRO_REPO_SCOPE_APPROVED=.devpro-agent-rules git -c core.pager=cat -C .devpro-agent-rules switch ${SUBMODULE_TAG}`,
  ]) {
    const { json } = runHook({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    assert.notEqual(json?.decision, "block", `a plain switch to a tag must not be blocked: ${command}`);
  }
});

test("W1S-extra: a branch-create flag in the same simple command keeps the block", () => {
  const repo = setupRepo();
  const cases = [
    [`DEVPRO_REPO_SCOPE_APPROVED=.devpro-agent-rules git -C .devpro-agent-rules checkout ${SUBMODULE_TAG} -b made-after-ref`],
    [`DEVPRO_REPO_SCOPE_APPROVED=.devpro-agent-rules git -C .devpro-agent-rules switch ${SUBMODULE_TAG} -c made-after-switch`],
    [`DEVPRO_REPO_SCOPE_APPROVED=.devpro-agent-rules git -C .devpro-agent-rules checkout -q -b ${SUBMODULE_TAG}`],
    [`DEVPRO_REPO_SCOPE_APPROVED=.devpro-agent-rules git -C .devpro-agent-rules switch -q -c ${SUBMODULE_TAG}`],
  ];
  for (const [command] of cases) {
    const { json } = runHook({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    assert.equal(json?.decision, "block", `a create flag must keep the block: ${command}`);
    assert.match(
      String(json?.reason || ""),
      /Worktree Mandatory For Branch Checkout gate/,
      `the block must come from W1, not another gate: ${command}`
    );
  }
});

test("W1S-extra: attached create flags and substitution occurrences stay blocked", () => {
  const repo = setupRepo();
  const cases = [
    [`DEVPRO_REPO_SCOPE_APPROVED=.devpro-agent-rules git -C .devpro-agent-rules checkout ${SUBMODULE_TAG} -bmade`, true],
    [`DEVPRO_REPO_SCOPE_APPROVED=.devpro-agent-rules git -C .devpro-agent-rules switch ${SUBMODULE_TAG} -cswitchA`, true],
    [`DEVPRO_REPO_SCOPE_APPROVED=.devpro-agent-rules X=$(git -C .devpro-agent-rules checkout ${SUBMODULE_TAG} -bsubst)`, true],
    [`DEVPRO_REPO_SCOPE_APPROVED=.devpro-agent-rules git -C .devpro-agent-rules checkout ${SUBMODULE_TAG} -B kept`, true],
    [`DEVPRO_REPO_SCOPE_APPROVED=.devpro-agent-rules git -C .devpro-agent-rules switch ${SUBMODULE_TAG} -C keptswitch`, true],
    [`DEVPRO_REPO_SCOPE_APPROVED=.devpro-agent-rules git -C .devpro-agent-rules switch ${SUBMODULE_TAG} --create made`, true],
    [`DEVPRO_REPO_SCOPE_APPROVED=.devpro-agent-rules git -C .devpro-agent-rules switch ${SUBMODULE_TAG} --force-create forced`, true],
    // A flag before the ref is caught by the pre-existing create gates instead of W1;
    // the invariant is only that it never opens a branch.
    [`DEVPRO_REPO_SCOPE_APPROVED=.devpro-agent-rules git -C .devpro-agent-rules checkout --orphan newroot`, false],
  ];
  for (const [command, expectW1] of cases) {
    const { json } = runHook({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    assert.equal(json?.decision, "block", `a create flag must stay blocked: ${command}`);
    if (expectW1) {
      assert.match(
        String(json?.reason || ""),
        /Worktree Mandatory For Branch Checkout gate/,
        `the block must come from W1: ${command}`
      );
    }
  }
});

test("W1S-extra: a benign later command does not veto the submodule exception", () => {
  const repo = setupRepo();
  for (const command of [
    `DEVPRO_REPO_SCOPE_APPROVED=.devpro-agent-rules git -C .devpro-agent-rules checkout ${SUBMODULE_TAG} && grep -B 2 foo README.md`,
  ]) {
    const { json } = runHook({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    assert.notEqual(json?.decision, "block", `the exception must survive a benign later command: ${command}`);
  }
});

test("W1S-extra: combined short options that carry a create flag stay blocked", () => {
  const repo = setupRepo();
  for (const command of [
    `DEVPRO_REPO_SCOPE_APPROVED=.devpro-agent-rules git -C .devpro-agent-rules checkout ${SUBMODULE_TAG} -qb chore/created`,
    `DEVPRO_REPO_SCOPE_APPROVED=.devpro-agent-rules git -C .devpro-agent-rules checkout ${SUBMODULE_TAG} -qB chore/created`,
    `DEVPRO_REPO_SCOPE_APPROVED=.devpro-agent-rules git -C .devpro-agent-rules switch ${SUBMODULE_TAG} -qc chore/created`,
    `DEVPRO_REPO_SCOPE_APPROVED=.devpro-agent-rules git -C .devpro-agent-rules switch ${SUBMODULE_TAG} -qC chore/created`,
  ]) {
    const { json } = runHook({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    assert.equal(json?.decision, "block", `a combined create flag must stay blocked: ${command}`);
    assert.match(String(json?.reason || ""), /Worktree Mandatory For Branch Checkout gate/);
  }
});

test("W1S-extra: a qualified tag that collides with a same-named branch block is resolved by git's order", () => {
  const repo = setupRepo();
  const sub = subPath(repo);
  // A branch literally named `tags/<tag>` must win over the tag, exactly like git checkout does.
  git(sub, ["branch", `tags/${SUBMODULE_TAG}`]);
  const blocked = runHook(
    {
      tool_name: "Bash",
      tool_input: {
        command: `DEVPRO_REPO_SCOPE_APPROVED=.devpro-agent-rules git -C .devpro-agent-rules checkout tags/${SUBMODULE_TAG}`,
      },
    },
    { cwd: repo }
  );
  assert.equal(blocked.json?.decision, "block", "the branch named tags/<tag> must win");
  assert.match(String(blocked.json?.reason || ""), /Worktree Mandatory For Branch Checkout gate/);
});

test("W1S-extra: a create-flag looking comment after a tag checkout does not block", () => {
  const repo = setupRepo();
  const { json } = runHook(
    {
      tool_name: "Bash",
      tool_input: {
        command: `DEVPRO_REPO_SCOPE_APPROVED=.devpro-agent-rules git -C .devpro-agent-rules checkout ${SUBMODULE_TAG} # no -b: pointer update only`,
      },
    },
    { cwd: repo }
  );
  assert.notEqual(json?.decision, "block", "a comment is not argv");
});
