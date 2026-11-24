// cross-repo-pr-merge (pre-tool-gate.mjs) and storedOriginIdentity (hooks/lib/git-utils.mjs): a gh pr merge stands
// alone (no cd, subshell or other step) and writes its repository in full (PR URL or --repo HOST/OWNER/REPO), and one into another repository carries a DEVPRO_CROSS_REPO_PR marker and a DEVPRO_PR_CHECKOUT whose stored
// origin names that repository. Each denial asserts its own reason, next to an allowed control that differs in one
// part only, so a denial from an unrelated check cannot make a case pass.
import "./lib/git-location-isolated-env.mjs";
import "./lib/isolated-control-evidence-state.mjs";
import "./lib/portable-command-shims.cjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { makeTempDir } from "./lib/tmp.mjs";
import { checkCrossRepoPrMerge, _mergeEvidenceCwd, _mergeEvidenceBinding, _getPrChangedFileEntries, _refetchPrCommentsViaRest, _extractRepoFlag, mergeMarkerMetadata } from "../hooks/pre-tool-gate.mjs";
import { storedOriginIdentity, inheritedGitLocation } from "../hooks/lib/git-utils.mjs";
import { declaredPrCheckout } from "../hooks/lib/pr-checkout-declaration.mjs";
import { fetchCompareBody } from "../hooks/lib/fresh-equivalent-compare.mjs";

const root = realpathSync(makeTempDir("cross-repo-pr-merge-"));
after(() => rmSync(root, { recursive: true, force: true }));
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
// Every read in this file (storedOriginIdentity included) runs without the runner's global or system git
// configuration, so a URL rewrite there cannot change a result; a case that needs a rewrite injects its own (PR #3703 r4 F5).
Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
let counter = 0;

// A checkout whose origin stores `url` (no origin when url is null); `config` adds [key, value] pairs to its config.
function checkout(url, config = []) {
  const dir = path.join(root, `checkout ${counter++}`);
  mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir, env: GIT_ENV });
  if (url !== null) execFileSync("git", ["remote", "add", "origin", url], { cwd: dir, env: GIT_ENV });
  for (const [key, value] of config) execFileSync("git", ["config", key, value], { cwd: dir, env: GIT_ENV });
  return dir;
}

const HUB = checkout("https://github.com/owner/hub.git");
const TARGET = checkout("https://github.com/owner/target.git");
const MARKER = "DEVPRO_CROSS_REPO_PR=owner/target";
const CHECKOUT = `DEVPRO_PR_CHECKOUT="${TARGET}"`;
// The hub's own repository, written in full as every accepted merge writes it.
const OWN = "--repo github.com/owner/hub";

function judge(command, { cwd = HUB, env = {} } = {}) {
  const saved = Object.fromEntries(["GH_HOST", "GH_REPO", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", ...Object.keys(env)].map((key) => [key, process.env[key]]));
  delete process.env.GH_HOST;
  delete process.env.GH_REPO;
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, env);
  try {
    // No effectiveCwd: the merge runs in the hook's working directory, as when the runner has none.
    return checkCrossRepoPrMerge(command, cwd, undefined);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
const passes = (command, options) => assert.equal(judge(command, options), null, command);
function blocks(command, reason, options) {
  const result = judge(command, options);
  assert.equal(result?.block, true, `${command}: ${JSON.stringify(result)}`);
  assert.match(result.reason, /^Cross-repo PR merge gate: /, command);
  assert.match(result.reason, reason, command);
}

// ── storedOriginIdentity ──────────────────────────────────────────────────────────────────────────────────────────

test("storedOriginIdentity: https keeps its literal host; ssh binds only when written with github.com", () => {
  const read = (url, config) => storedOriginIdentity(checkout(url, config));
  assert.deepEqual(read("https://github.com/Owner/Repo.git"), { host: "github.com", slug: "owner/repo" });
  assert.deepEqual(read("https://user@ghe.example.com:8443/o/r"), { host: "ghe.example.com:8443", slug: "o/r" });
  assert.deepEqual(read("https://ghe.example.com:443/o/r"), { host: "ghe.example.com", slug: "o/r" });
  assert.deepEqual(read("git@github.com:o/r.git"), { host: "github.com", slug: "o/r" });
  assert.deepEqual(read("ssh://git@ssh.github.com:443/o/r.git"), { host: "github.com", slug: "o/r" });
  // The ssh.github.com alias holds for ssh only (r12 W1-02): an https URL keeps the host it writes.
  assert.deepEqual(read("https://ssh.github.com/o/r"), { host: "ssh.github.com", slug: "o/r" });
});

test("storedOriginIdentity: an ssh alias, a file URL, a local path, git:// and no origin bind nothing", () => {
  for (const url of ["git@work-alias:o/r.git", "ssh://git@ghe.example.com/o/r", "file:///srv/o/r", "file://github.com/o/r", "/srv/git/o/r", "git://github.com/o/r", null]) {
    assert.equal(storedOriginIdentity(checkout(url)), null, String(url));
  }
  assert.equal(storedOriginIdentity(path.join(root, "missing")), null);
  assert.equal(storedOriginIdentity(""), null);
});

test("storedOriginIdentity: an origin that git rewrites, pushes elsewhere or stores twice binds nothing (r12 W1-01, PR #3703 r2 F1, F2)", () => {
  const read = (url, config) => storedOriginIdentity(checkout(url, config));
  // `git remote get-url` prints github.com for both; the checkout fetches from somewhere other than the stored URL.
  assert.equal(read("https://mirror.example.com/owner/target.git", [["url.https://github.com/.insteadOf", "https://mirror.example.com/"]]), null);
  assert.equal(read("gh:owner/target", [["url.https://github.com/.insteadOf", "gh:"]]), null);
  assert.equal(read("https://github.com/owner/target.git", [["url.https://github.com/owner/other.pushInsteadOf", "https://github.com/owner/target"]]), null);
  assert.equal(read("https://github.com/owner/target.git", [["remote.origin.pushurl", "https://github.com/owner/other.git"]]), null);
  // A pushurl byte for byte equal to the origin URL changes nothing and binds as if unset (PR #3703 r7 W8-F3).
  assert.deepEqual(read("https://github.com/owner/target.git", [["remote.origin.pushurl", "https://github.com/owner/target.git"]]), { host: "github.com", slug: "owner/target" });
  assert.equal(read("https://github.com/owner/target.git", [["remote.origin.pushurl", "https://github.com/owner/target"]]), null);
  // Git fetches with the first of two stored URLs, while `git config --get` reads the last.
  const twice = checkout("https://github.com/owner/first.git");
  execFileSync("git", ["config", "--add", "remote.origin.url", "https://github.com/owner/target.git"], { cwd: twice, env: GIT_ENV });
  assert.equal(storedOriginIdentity(twice), null);
  assert.deepEqual(read("https://github.com/owner/target.git"), { host: "github.com", slug: "owner/target" });
});

test("storedOriginIdentity: an empty second value or surrounding whitespace binds nothing (PR #3703 r3 F5)", () => {
  const empty = checkout("https://github.com/owner/target.git");
  execFileSync("git", ["config", "--add", "remote.origin.url", ""], { cwd: empty, env: GIT_ENV });
  assert.equal(storedOriginIdentity(empty), null);
  assert.equal(storedOriginIdentity(checkout("https://github.com/owner/target.git ")), null);
  assert.equal(storedOriginIdentity(checkout(" https://github.com/owner/target.git")), null);
  assert.deepEqual(storedOriginIdentity(checkout("https://github.com/owner/target.git")), { host: "github.com", slug: "owner/target" });
});

test("an inherited GIT_DIR never makes another repository answer for a checkout, and a merge is judged only without one (PR #3703 r3 F2)", () => {
  const saved = Object.fromEntries(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"].map((key) => [key, process.env[key]]));
  try {
    process.env.GIT_DIR = path.join(TARGET, ".git");
    process.env.GIT_WORK_TREE = TARGET;
    assert.deepEqual(storedOriginIdentity(HUB), { host: "github.com", slug: "owner/hub" });
    assert.deepEqual(storedOriginIdentity(TARGET), { host: "github.com", slug: "owner/target" });
    // The later merge gates read the checkout through git too, so the merge itself is blocked, whatever it declares.
    for (const command of [`${MARKER} DEVPRO_PR_CHECKOUT="${HUB}" gh pr merge 5 --repo github.com/owner/target`, `gh pr merge 5 ${OWN}`]) {
      blocks(command, /the hook's environment sets GIT_DIR, which makes git read another repository/);
    }
    delete process.env.GIT_DIR;
    delete process.env.GIT_WORK_TREE;
    process.env.GIT_INDEX_FILE = path.join(TARGET, ".git", "index");
    blocks(`gh pr merge 5 ${OWN}`, /the hook's environment sets GIT_INDEX_FILE/);
    delete process.env.GIT_INDEX_FILE;
    passes(`gh pr merge 5 ${OWN}`);
    // A rewrite from the environment's configuration values is still seen: get-url differs, so nothing binds.
    Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url.https://github.com/owner/target.insteadOf", GIT_CONFIG_VALUE_0: "https://github.com/owner/hub" });
    assert.equal(storedOriginIdentity(HUB), null);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("storedOriginIdentity: plain http binds nothing, while https of the same repository binds (PR #3703 r1 F6)", () => {
  assert.equal(storedOriginIdentity(checkout("http://github.com/owner/target.git")), null);
  assert.equal(storedOriginIdentity(checkout("http://ghe.example.com:8080/o/r")), null);
  assert.deepEqual(storedOriginIdentity(checkout("https://github.com/owner/target.git")), { host: "github.com", slug: "owner/target" });
});

test("storedOriginIdentity: only the repository's own configuration counts; a linked worktree reads its repository (PR #3703 r1 F5)", () => {
  const globalConfig = path.join(root, "global-origin.gitconfig");
  writeFileSync(globalConfig, '[remote "origin"]\n\turl = https://github.com/owner/target.git\n');
  const bare = checkout(null);
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  try {
    // `git config --get` would read the global origin; the checkout has none of its own, so it binds nothing.
    assert.equal(execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd: bare, encoding: "utf8" }).trim(), "https://github.com/owner/target.git");
    assert.equal(storedOriginIdentity(bare), null);
    assert.equal(storedOriginIdentity(root), null, "a directory outside any repository");
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
  }
  const main = checkout("https://github.com/owner/target.git");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: main, env: GIT_ENV });
  const linked = path.join(root, `linked ${counter++}`);
  execFileSync("git", ["worktree", "add", "-q", "--detach", linked], { cwd: main, env: GIT_ENV });
  assert.deepEqual(storedOriginIdentity(linked), { host: "github.com", slug: "owner/target" });
});

// ── Standalone merges ─────────────────────────────────────────────────────────────────────────────────────────────

test("a merge in the session's own repository passes when it stands alone and writes its repository in full", () => {
  for (const command of [`gh pr merge 5 ${OWN} --merge`, "gh pr merge 5 -R github.com/owner/hub", "gh pr merge https://github.com/owner/hub/pull/5", "gh pr merge 5 --repo 'github.com/owner/hub'", `gh pr merge 5 ${OWN} --merge 2>&1`, `gh pr merge 5 ${OWN} --merge # note`, `gh pr merge 5 ${OWN} --merge > /dev/null 2>&1 &`, `DEVPRO_NOTE=x gh pr merge 5 ${OWN}`]) {
    passes(command);
  }
});

test("a merge that leaves its repository to gh is blocked: no target, a target without a host, an inherited GH_REPO (PR #3703 r2 F1, F3)", () => {
  for (const [command, env] of [["gh pr merge 5 --merge", {}], ["gh pr merge 5 --repo owner/hub", {}], ["gh pr merge 5", { GH_REPO: "github.com/owner/target" }], ["gh pr merge 5 --repo owner/hub", { GH_HOST: "github.com" }]]) {
    blocks(command, /write the repository of gh pr merge in full in the command/, { env });
  }
  // A command-local GH_REPO= never writes the repository: gh would read the whole shell word, which a word joining quoted
  // parts (app"-docs") makes another repository than its first part (PR #3703 r6 F1).
  for (const command of ["GH_REPO=owner/hub gh pr merge 5", "GH_REPO=github.com/owner/hub gh pr merge 5", 'GH_REPO="github.com/owner/hub"-docs gh pr merge 5']) {
    blocks(command, /GH_REPO= changes what gh reads/);
  }
  // A --repo or selector word that joins quoted parts or escapes a character is not read.
  for (const command of ['gh pr merge 5 --repo "github.com/owner/hub"-docs', String.raw`gh pr merge 5 --repo github.com/owner/hu\b`]) {
    blocks(command, /cannot be read literally/);
  }
  // The joined word reads as a valid PR URL, so only the join rule can block it; the same URL written plainly passes
  // (PR #3703 r7 W4-F2).
  for (const command of ['gh pr merge "https://github.com/owner/hub/pull/"5', String.raw`gh pr merge https://github.com/owner/hub/pull/\5`]) {
    blocks(command, /the PR of this merge cannot be read literally/);
  }
  passes("gh pr merge https://github.com/owner/hub/pull/5", { env: { GH_REPO: "github.com/owner/target" } });
  // A checkout without an origin of its own, or with one that only a global setting gives it, is no repository.
  blocks(`gh pr merge 5 ${OWN}`, /not the repository of this checkout/, { cwd: checkout(null) });
});

test("a merge names its PR literally, by number or URL: no selector, a branch or a variable is blocked (PR #3703 r4 F1)", () => {
  // Every later gate and the post-merge marker read the bound PR, never a checkout's current branch.
  for (const command of [`gh pr merge ${OWN} --merge`, `gh pr merge feature/x ${OWN}`, `gh pr merge "$PR" ${OWN}`, `DEVPRO_PR=5 gh pr merge "$DEVPRO_PR" ${OWN}`, `${MARKER} ${CHECKOUT} gh pr merge --repo github.com/owner/target --merge`]) {
    blocks(command, /name (?:the PR of this merge by its number or URL, written literally|it by number or URL)/);
  }
  passes(`gh pr merge "5" ${OWN}`);
  assert.deepEqual(_mergeEvidenceBinding(`gh pr merge 5 ${OWN} --subject "see https://github.com/owner/other/pull/9"`, HUB, undefined), { repo: "github.com/owner/hub", pr: "5" });
});

test("merge marker lookup keeps its bound repository host (PR #3703 r4 F3)", () => {
  assert.equal(_extractRepoFlag("gh pr checks 5 --repo github.com/owner/hub"), "github.com/owner/hub");
  assert.equal(_extractRepoFlag("gh pr checks 5 -R=ghe.example.com:8443/owner/hub"), "ghe.example.com:8443/owner/hub");
  assert.equal(_extractRepoFlag("gh pr checks 5 --repo owner/hub/extra"), null);
  const trace = path.join(root, `marker-trace ${counter++}.jsonl`);
  const saved = Object.fromEntries(["CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT", "CROSS_MODEL_MERGE_GATE_TRACE_REPO_FILE", "GH_HOST"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({ headRefName: "feature/x", baseRefName: "main" }), CROSS_MODEL_MERGE_GATE_TRACE_REPO_FILE: trace, GH_HOST: "ghe.example.com" });
  try {
    // A merge reads the PR and repository cross-repo-pr-merge bound, whatever else the command text holds.
    assert.equal(mergeMarkerMetadata("gh pr merge 5 --repo github.com/owner/hub", "fallback", HUB, { repo: "github.com/owner/hub", pr: "5" }).prNumber, "5");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const calls = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => [call.repo, call.pr]), [["github.com/owner/hub", "5"]]);
});

test("a checkout path with a space binds the same checkout double-quoted, single-quoted or backslash-escaped (PR #3703 r5 F3)", () => {
  assert.ok(TARGET.includes(" "), "the fixture checkout path has a space");
  // The unquoted form escapes every space and backslash, so a Windows path keeps its separators (PR #3703 r6 F4).
  const forms = [`"${TARGET}"`, `'${TARGET}'`, TARGET.replace(/[\\ ]/g, (c) => `\\${c}`)];
  for (const form of forms) {
    const command = `${MARKER} DEVPRO_PR_CHECKOUT=${form} gh pr merge 5 --repo github.com/owner/target --merge`;
    passes(command);
    assert.equal(_mergeEvidenceCwd(command, HUB, undefined), TARGET, form);
  }
  // A value with an escaped space or a quoted part never hides the merge from the gates behind it.
  blocks(`X=/a\\ b gh pr merge 5 ${OWN}`, /X= changes what gh reads/);
  blocks(`X=/a/"b c" gh pr merge 5 ${OWN}`, /X= changes what gh reads/);
});

test("one command merges one PR, even in the session's own repository", () => {
  blocks(`gh pr merge 5 ${OWN} --merge && gh pr merge 6 ${OWN} --merge`, /one command merges one PR/);
  passes(`gh pr merge 5 ${OWN} --merge`);
});

test("a step before the merge is blocked, with or without a written host (r12 W3-01, W2-01)", () => {
  const qualified = `${MARKER} ${CHECKOUT} gh pr merge 5 --repo github.com/owner/target --merge`;
  passes(qualified);
  for (const before of ["gh pr edit 5 --base release && ", "gh pr view 9 && ", "git fetch; ", "true\n"]) {
    blocks(`${before}${qualified}`, /another step comes before gh pr merge/);
  }
  blocks(`gh pr view 9 && gh pr merge 5 ${OWN} --merge`, /another step comes before gh pr merge/);
  // An assignment on its own line is another statement, not part of the merge (PR #3703 r2 F4).
  blocks(`DEVPRO_NOTE=x\ngh pr merge 5 ${OWN}`, /another step comes before gh pr merge/);
  blocks(`GH_REPO=github.com/owner/hub\ngh pr merge 5 ${OWN}`, /another step comes before gh pr merge/);
});

test("a step after the merge, a pipe included, is blocked", () => {
  for (const after of [" | tail -2", " && git pull", "; echo done", "\ngh pr view 5"]) {
    blocks(`gh pr merge 5 ${OWN} --merge${after}`, /another step follows gh pr merge/);
  }
});

test("a command substitution in the merge or its prefix is blocked; a single-quoted one is literal", () => {
  blocks(`gh pr merge 5 ${OWN} --subject "$(git log -1 --format=%s)"`, /runs a command substitution first/);
  blocks(`DEVPRO_NOTE="$(date)" gh pr merge 5 ${OWN} --merge`, /DEVPRO_NOTE= runs a command substitution first/);
  passes(`gh pr merge 5 ${OWN} --subject '$(not run)'`);
});

test("merge refuses unreadable assignment prefixes without inspecting their text for a checkout name", () => {
  const ownMerge = `gh pr merge 5 ${OWN}`;
  const unsupported = [
    `${CHECKOUT} DEVPRO_NOTE=$(printf '%s' x)`,
    "DEVPRO_NOTE=$(printf '%s' $(true))",
    "DEVPRO_NOTE=$'it\\'s' " + CHECKOUT,
    'DEVPRO_NOTE="${DEVPRO_NOTE:-"a value with DEVPRO_PR_CHECKOUT=/x"}"',
    "DEVPRO_NOTE=$(case a in a) printf '%s' DEVPRO_PR_CHECKOUT=/x;; esac)",
    "DEVPRO_PR_\\\nCHECKOUT=" + JSON.stringify(TARGET),
  ];
  for (const prefix of unsupported) {
    blocks(`${prefix} ${ownMerge}`, /cannot read the assignment prefix.*literal/i);
    blocks(`env ${prefix} ${ownMerge}`, /cannot read the assignment prefix.*literal/i);
    blocks(`DEVPRO_OUTER=x env ${prefix} ${ownMerge}`, /cannot read the assignment prefix.*literal/i);
    blocks(`true && ${prefix} ${ownMerge}`, /cannot read the assignment prefix.*literal/i);
  }
  const targetMerge = `${CHECKOUT} gh pr merge 5 --repo github.com/owner/target`;
  const continued = `${MARKER} \\\n${targetMerge}`;
  passes(continued);
  assert.equal(_mergeEvidenceCwd(continued, HUB), TARGET);
  blocks(`gh \\\npr merge 5 ${OWN}`, /write the gh pr merge invocation on one line/);
  blocks(`env DEVPRO_NOTE=x ${ownMerge}`, /another step comes before gh pr merge/);
  passes(`printf '%s' 'DEVPRO_PR_CHECKOUT=/x ${ownMerge}'`);
  passes(`DEVPRO_NOTE=$(printf '%s' x) printf '%s' ${ownMerge}`);
  passes(`DEVPRO_OUTER=x env DEVPRO_NOTE=y printf '%s' ${ownMerge}`);
  passes(`${ownMerge} # DEVPRO_PR_CHECKOUT=/x`);
});

test("an escaped backtick or dollar inside double quotes is literal; an unescaped one still runs (PR #3703 r1 F4)", () => {
  passes(`gh pr merge 5 ${OWN} --squash --subject "fix \\\`gate\\\` wording"`);
  passes(`gh pr merge 5 ${OWN} --subject "costs \\$(none)"`);
  passes(`gh pr merge 5 ${OWN} --subject "it's fine"`);
  blocks(`gh pr merge 5 ${OWN} --subject "fix \`id\`"`, /runs a command substitution first/);
  blocks(`gh pr merge 5 ${OWN} --subject "it's $(id)"`, /runs a command substitution first/);
  blocks(`DEVPRO_NOTE="a \\" $(id)" gh pr merge 5 ${OWN}`, /DEVPRO_NOTE= runs a command substitution first/);
});

test("a cd, a subshell or a group around the merge is another step, however its path is written (PR #3703 r3 F3, F4)", () => {
  // The merge runs in the hook's working directory; no path spelling (quoted, backslash-escaped spaces, a Windows
  // path) and no ( … ) or { … } around it changes that, so none of them is parsed.
  for (const command of [`cd "${HUB}" && gh pr merge 5 ${OWN} --merge`, `cd ${HUB.replaceAll(" ", "\\ ")} && gh pr merge 5 ${OWN}`, `cd "C:\\Repos\\hub" && gh pr merge 5 ${OWN}`, `( cd "${HUB}" && gh pr merge 5 ${OWN} )`, `(gh pr merge 5 ${OWN})`, `{ gh pr merge 5 ${OWN}; }`]) {
    const result = judge(command);
    assert.equal(result?.block, true, command);
    assert.match(result.reason, /another step (?:comes before|follows) gh pr merge; run gh pr merge as its own command from the checkout's working directory/, command);
  }
  // A redirect or background suffix after the group does not make it one command; the selector is valid, so only the
  // standalone rule can block it (PR #3703 r8 W4-F1).
  for (const command of [`(gh pr merge 5 ${OWN}) > merge.log`, `(gh pr merge 5 ${OWN}) &`]) {
    blocks(command, /another step (?:comes before|follows) gh pr merge; run gh pr merge as its own command/);
  }
});

test("an assignment other than DEVPRO_* before the merge is blocked, GH_REPO included (PR #3703 r6 F1)", () => {
  for (const name of ["GH_HOST", "GH_CONFIG_DIR", "HOME", "GH_REPO"]) {
    blocks(`${name}=x gh pr merge 5 ${OWN} --merge`, new RegExp(`${name}= changes what gh reads`));
  }
  passes(`DEVPRO_NOTE=x gh pr merge 5 ${OWN} --merge`);
});

// ── Merges into another repository ─────────────────────────────────────────────────────────────────────────────────

test("a merge into another repository needs the marker for it and a checkout of it, in front of that merge", () => {
  passes(`${MARKER} ${CHECKOUT} gh pr merge 5 --repo github.com/owner/target --merge`);
  passes(`${MARKER} ${CHECKOUT} gh pr merge https://github.com/owner/target/pull/5`);
  blocks(`${MARKER} ${CHECKOUT} GH_REPO=github.com/owner/target gh pr merge 5`, /GH_REPO= changes what gh reads/);
  blocks("gh pr merge 5 --repo github.com/owner/target --merge", /merges github\.com\/owner\/target, not the repository of this checkout\. Ask the user first/);
  blocks(`DEVPRO_CROSS_REPO_PR=owner/other ${CHECKOUT} gh pr merge 5 --repo github.com/owner/target`, /not the repository of this checkout/);
  blocks(`${MARKER} gh pr merge 5 --repo github.com/owner/target --merge`, /add DEVPRO_PR_CHECKOUT=/);
  // A marker in front of another step is not in front of the merge.
  blocks(`${MARKER} true && ${CHECKOUT} gh pr merge 5 --repo github.com/owner/target`, /another step comes before gh pr merge/);
});

test("a merge run from the target's own checkout is a same-repository merge there", () => {
  passes("gh pr merge 5 --repo github.com/owner/target --merge", { cwd: TARGET });
  assert.equal(_mergeEvidenceCwd("gh pr merge 5 --repo github.com/owner/target --merge", TARGET, undefined), TARGET);
});

test("the declared checkout must store the target as its origin: another repository, a mirror, a file URL or an ssh alias is refused", () => {
  const declared = (dir) => `${MARKER} DEVPRO_PR_CHECKOUT="${dir}" gh pr merge 5 --repo github.com/owner/target`;
  for (const url of ["https://github.com/owner/other.git", "https://ghe.example.com/owner/target.git", "file://github.com/owner/target", "git@work-alias:owner/target.git", "https://ssh.github.com/owner/target"]) {
    blocks(declared(checkout(url)), /is not a checkout of github\.com\/owner\/target/);
  }
  blocks(declared(checkout("https://mirror.example.com/owner/target.git", [["url.https://github.com/.insteadOf", "https://mirror.example.com/"]])), /is not a checkout of github\.com\/owner\/target/);
  passes(declared(checkout("git@github.com:owner/target.git")));
  passes(declared(checkout("ssh://git@ssh.github.com:443/owner/target.git")));
});

test("a same-repository merge with a declared checkout of another repository is refused", () => {
  blocks(`DEVPRO_PR_CHECKOUT="${TARGET}" gh pr merge 5 ${OWN} --merge`, /is not a checkout of github\.com\/owner\/hub/);
});

test("hosts: only github.com is merged, even from its own checkout; a written host is read as written (PR #3703 r3 F1)", () => {
  const ghe = checkout("https://ghe.example.com/owner/target.git");
  for (const [command, cwd] of [["gh pr merge 5 --repo ghe.example.com/owner/target", ghe], [`DEVPRO_CROSS_REPO_PR=ghe.example.com/owner/target DEVPRO_PR_CHECKOUT="${ghe}" gh pr merge 5 --repo ghe.example.com/owner/target`, HUB], ["gh pr merge https://ghe.example.com/owner/target/pull/5", ghe]]) {
    blocks(command, /github\.com repositories only/, { cwd });
  }
  // A written host is read as written, whatever GH_HOST the hook or the shell holds, and every later lookup names it.
  const command = `${MARKER} ${CHECKOUT} gh pr merge 5 --repo github.com/owner/target`;
  passes(command, { env: { GH_HOST: "ghe.example.com" } });
  assert.deepEqual(_mergeEvidenceBinding(command, HUB, undefined), { repo: "github.com/owner/target", pr: "5" });
  assert.deepEqual(_mergeEvidenceBinding(`gh pr merge https://github.com/Owner/Hub/pull/5`, HUB, undefined), { repo: "github.com/Owner/Hub", pr: "5" });
  assert.equal(_mergeEvidenceBinding("gh pr merge 5 --repo owner/hub", HUB, undefined), undefined);
});

test("the evidence lookups name the host of a HOST/OWNER/REPO repository to gh (PR #3703 r3 F1)", () => {
  const bin = path.join(root, `gh-stub ${counter++}`);
  mkdirSync(bin);
  const log = path.join(bin, "calls.log");
  // Prints one changed file and [] for every other list, and records each argv and its GH_REPO as one JSON line.
  writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, ghRepo: process.env.GH_REPO ?? null }) + "\\n");
if (argv.includes("changedFiles")) console.log("1");
else if (argv.some((arg) => arg.includes("/files"))) console.log('{"status":"modified","filename":"a"}');
else console.log("[]");
`);
  chmodSync(path.join(bin, "gh"), 0o755);
  const names = ["PATH", "GH_HOST", ...Object.keys(process.env).filter((key) => key.startsWith("CROSS_MODEL_MERGE_GATE_MOCK_") || key.startsWith("DEVPRO_POST_PR_GATE_MOCK_"))];
  const saved = Object.fromEntries(names.map((key) => [key, process.env[key]]));
  for (const key of names) if (key !== "PATH") delete process.env[key];
  process.env.PATH = [bin, path.dirname(process.execPath), saved.PATH].join(path.delimiter);
  process.env.GH_HOST = "ghe.example.com";
  try {
    const sha = (c) => c.repeat(40);
    fetchCompareBody({ lastReviewedSha: sha("a"), headRefOid: sha("b"), repoSlug: "owner/target", host: "github.com", cwd: HUB });
    _refetchPrCommentsViaRest("5", "github.com/owner/target", HUB);
    _getPrChangedFileEntries("5", HUB, "github.com/owner/target");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const records = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const calls = records.map((record) => record.argv);
  const apiCalls = calls.filter((argv) => argv[0] === "api");
  assert.equal(apiCalls.length, 3, JSON.stringify(calls));
  for (const argv of apiCalls) {
    assert.deepEqual(argv.slice(0, 3), ["api", "--hostname", "github.com"], JSON.stringify(argv));
    assert.ok(!argv.some((arg) => arg.includes("github.com/owner")), JSON.stringify(argv));
  }
  assert.ok(apiCalls.some((argv) => argv.includes(`repos/owner/target/compare/${"a".repeat(40)}...${"b".repeat(40)}`)));
  assert.ok(apiCalls.some((argv) => argv.includes("repos/owner/target/issues/5/comments")));
  // The changed-file list names PR #5 and gets the full repository through GH_REPO (PR #3703 r7 W4-F4).
  // The changed-file list names github.com and owner/target in its own arguments, and GH_REPO agrees (PR #3703 r8 W9-F3).
  const files = records.filter((record) => record.argv.some((arg) => /\/pulls\/5\/files\?per_page=100$/.test(arg)));
  assert.equal(files.length, 1, JSON.stringify(records));
  assert.deepEqual(files[0].argv.slice(0, 5), ["api", "--hostname", "github.com", "--paginate", "repos/owner/target/pulls/5/files?per_page=100"]);
  assert.equal(files[0].ghRepo, "github.com/owner/target");
  const view = calls.find((argv) => argv[0] === "pr");
  assert.deepEqual(view.slice(-2), ["--repo", "github.com/owner/target"]);
  // The changed-file count names PR #5 itself (PR #3703 r10 W5-F1).
  assert.deepEqual(view.slice(0, 3), ["pr", "view", "5"], JSON.stringify(view));
});

test("a working directory the hook cannot resolve leaves the merge checkout unresolved, which is blocked", () => {
  blocks(`gh pr merge 5 ${OWN} --merge`, /working directory this merge runs in cannot be resolved/, { cwd: "" });
});

test("a checkout without a readable origin is no repository: every written target is another repository", () => {
  const bare = checkout(null);
  blocks(`gh pr merge 5 ${OWN}`, /not the repository of this checkout/, { cwd: bare });
  blocks("gh pr merge 5 --repo github.com/owner/target", /not the repository of this checkout/, { cwd: bare });
});

test("the merge evidence gates read the bound target checkout, else the command checkout", () => {
  const command = `${MARKER} ${CHECKOUT} gh pr merge 5 --repo github.com/owner/target --merge`;
  assert.equal(_mergeEvidenceCwd(command, HUB, undefined), TARGET);
  assert.equal(_mergeEvidenceCwd(`gh pr merge 5 ${OWN} --merge`, HUB, undefined), HUB);
});

test("a fork checkout merges upstream only by writing it, with the marker and an upstream checkout (PR #3703 r1 F1)", () => {
  const fork = checkout("https://github.com/me/hub.git");
  execFileSync("git", ["remote", "add", "upstream", "https://github.com/owner/hub.git"], { cwd: fork, env: GIT_ENV });
  execFileSync("git", ["config", "remote.upstream.gh-resolved", "base"], { cwd: fork, env: GIT_ENV });
  const upstream = checkout("https://github.com/owner/hub.git");
  blocks("gh pr merge 5 --merge", /write the repository of gh pr merge in full/, { cwd: fork });
  passes("gh pr merge 5 --repo github.com/me/hub --merge", { cwd: fork });
  blocks(`gh pr merge 5 ${OWN} --merge`, /not the repository of this checkout/, { cwd: fork });
  const bound = `DEVPRO_CROSS_REPO_PR=owner/hub DEVPRO_PR_CHECKOUT="${upstream}" gh pr merge 5 ${OWN} --merge`;
  passes(bound, { cwd: fork });
  assert.equal(_mergeEvidenceCwd(bound, fork, undefined), upstream);
});

test("a command without a real gh pr merge is not judged", () => {
  for (const command of ["gh pr view 5", "echo 'gh pr merge 5'", "git merge main"]) passes(command);
});

test("declaredPrCheckout: a declaration repeated in front of a gh command is an error for every gate that reads it (PR #3703 r7 W1-F1)", () => {
  const twice = `DEVPRO_PR_CHECKOUT="${TARGET}" DEVPRO_PR_CHECKOUT="${HUB}" gh pr create --repo owner/target`;
  assert.match(declaredPrCheckout(twice, 0, twice.indexOf("gh pr")).error, /assigned more than once/);
  // An empty assignment counts too, in either order (PR #3703 r9 W2-F2).
  for (const command of [`DEVPRO_PR_CHECKOUT= DEVPRO_PR_CHECKOUT="${TARGET}" gh pr create --repo owner/target`, `DEVPRO_PR_CHECKOUT="${TARGET}" DEVPRO_PR_CHECKOUT= gh pr create --repo owner/target`, `DEVPRO_PR_CHECKOUT='' DEVPRO_PR_CHECKOUT="${TARGET}" gh pr create --repo owner/target`]) {
    assert.match(declaredPrCheckout(command, 0, command.indexOf("gh pr")).error, /assigned more than once/, command);
  }
  // Declaration-like text inside another assignment's quoted value is part of that value, not a second declaration
  // (PR #3703 r10 W2-F2).
  const quoted = `DEVPRO_NOTE="see DEVPRO_PR_CHECKOUT=/elsewhere" DEVPRO_PR_CHECKOUT="${TARGET}" gh pr create --repo owner/target`;
  assert.deepEqual(declaredPrCheckout(quoted, 0, quoted.indexOf("gh pr")), { cwd: TARGET });
  const empty = "DEVPRO_PR_CHECKOUT= gh pr create --repo owner/target";
  assert.match(declaredPrCheckout(empty, 0, empty.indexOf("gh pr")).error, /literal absolute path/);
  const once = `DEVPRO_PR_CHECKOUT="${TARGET}" gh pr create --repo owner/target`;
  assert.deepEqual(declaredPrCheckout(once, 0, once.indexOf("gh pr")), { cwd: TARGET });
  const env = `&& DEVPRO_NOTE=x env DEVPRO_PR_CHECKOUT="${TARGET}" /opt/bin/gh pr create --repo owner/target`;
  assert.deepEqual(declaredPrCheckout(env, 1, env.indexOf("gh pr")), { cwd: TARGET });
  const unread = `DEVPRO_PR_CHECKOUT="${TARGET}" DEVPRO_NOTE=$(printf '%s' x) gh pr create --repo owner/target`;
  assert.match(declaredPrCheckout(unread, 0, unread.indexOf("gh pr")).error, /cannot read the assignment prefix/);
});

test("the marker is read as the whole shell word: a joined or escaped value is never read (PR #3703 r8 W3-F1)", () => {
  // The shell assigns owner/target-x, owner/target and owner/targetx; the hook reads none of them.
  for (const marker of ['DEVPRO_CROSS_REPO_PR="owner/target"-x', String.raw`DEVPRO_CROSS_REPO_PR=owner/targe\t`, "DEVPRO_CROSS_REPO_PR='owner/target'x", 'DEVPRO_CROSS_REPO_PR="$REPO"']) {
    blocks(`${marker} ${CHECKOUT} gh pr merge 5 --repo github.com/owner/target`, /write DEVPRO_CROSS_REPO_PR as one plain word/);
  }
  for (const marker of ["DEVPRO_CROSS_REPO_PR=owner/target", 'DEVPRO_CROSS_REPO_PR="owner/target"', "DEVPRO_CROSS_REPO_PR='github.com/owner/target'"]) {
    passes(`${marker} ${CHECKOUT} gh pr merge 5 --repo github.com/owner/target`);
  }
});

test("a PR URL and a --repo naming different repositories are blocked; the same repository passes (PR #3703 r8 W9-F4)", () => {
  for (const command of [`gh pr merge https://github.com/owner/hub/pull/5 --repo github.com/owner/other`, `${MARKER} ${CHECKOUT} gh pr merge https://github.com/owner/target/pull/5 --repo github.com/owner/hub`]) {
    blocks(command, /the PR URL and --repo of this merge name different repositories/);
  }
  passes(`gh pr merge https://github.com/owner/hub/pull/5 ${OWN}`);
  passes("gh pr merge https://github.com/owner/hub/pull/5 -R github.com/owner/hub");
  // A --repo without a host beside the URL is never compared: gh would take its host from GH_HOST (PR #3703 r10 W3-F1).
  blocks("gh pr merge https://github.com/owner/hub/pull/5 -R owner/hub", /the --repo of this merge has no host/);
});

test("a quoted checkout path that holds GH_REPO= text is one word, while a real GH_REPO= assignment is still blocked (PR #3703 r8 W2-F3)", () => {
  const dir = path.join(root, `target GH_REPO=x ${counter++}`);
  mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir, env: GIT_ENV });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/target.git"], { cwd: dir, env: GIT_ENV });
  passes(`${MARKER} DEVPRO_PR_CHECKOUT="${dir}" gh pr merge 5 --repo github.com/owner/target`);
  blocks(`${MARKER} DEVPRO_PR_CHECKOUT="${dir}" GH_REPO=owner/target gh pr merge 5 --repo github.com/owner/target`, /GH_REPO= changes what gh reads/);
});

test("inheritedGitLocation: an empty value counts, and on Windows a name in any case counts (PR #3703 r8 W1-F1, W1-F2)", () => {
  assert.equal(inheritedGitLocation({ GIT_DIR: "" }, "darwin"), "GIT_DIR");
  assert.equal(inheritedGitLocation({ PATH: "/bin" }, "darwin"), null);
  assert.equal(inheritedGitLocation({ Git_Dir: "C:\\other\\.git" }, "win32"), "GIT_DIR");
  assert.equal(inheritedGitLocation({ Git_Dir: "/other/.git" }, "linux"), null, "POSIX names are case-sensitive and git reads GIT_DIR only");
});
