import "./lib/portable-command-shims.cjs";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execSync, execFileSync } from "node:child_process";
import { accessSync, constants, promises as fs, cpSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import os from "node:os";
import {
  parsePruneArgv,
  acceptsPrintedPruneArgv,
  advisoryBranchArg,
} from "../lib/prune-argv.mjs";
import * as pruneArgv from "../lib/prune-argv.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";
import { stripJsCommentSpans, JsCommentSpanScanError } from "../lib/js-comment-spans.mjs";

const pruneScript = path.join(REPO_ROOT, ".devpro", "scripts", "prune-merged-local.mjs");

// Split the argument string here instead of handing it to a shell: cmd.exe does not treat single quotes
// as quoting, so `commit -m 'release commit'` reaches Git as different arguments there.
const splitGitArgs = (args) =>
  (args.match(/'[^']*'|"[^"]*"|\S+/g) || []).map((token) => (/^(['"])[\s\S]*\1$/.test(token) ? token.slice(1, -1) : token));

function git(cwd, args) {
  return execFileSync("git", splitGitArgs(args), {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Argv-form git (shell-independent; required for metachar / Windows-portable fixtures). */
function gitArgv(cwd, args) {
  return execFileSync(resolveExecutable("git"), args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function resolveExecutable(command) {
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    const directory = entry.replace(/^"|"$/g, "");
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return realpathSync(candidate);
      } catch {
        // Keep searching PATH for an executable carrier.
      }
    }
  }
  throw new Error(`Cannot resolve executable from PATH: ${command}`);
}

/** One-shot git init + bare remote bootstrap (built once per test file). */
async function buildBaseRepoTemplate() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "prune-local-template-"));
  const bare = path.join(tmp, "remote.git");
  const work = path.join(tmp, "work");

  await fs.mkdir(work);
  git(work, "init -q -b main");
  git(work, "config user.email t@e.x");
  git(work, "config user.name test");

  await fs.writeFile(path.join(work, "a.txt"), "init\n");
  git(work, "add .");
  git(work, "commit -q -m 'init'");

  execSync(`git init -q --bare "${bare}"`);
  git(work, `remote add origin "${bare}"`);
  git(work, "push -q origin main");

  return { tmp, work, bare };
}

let baseRepoTemplatePromise;

async function ensureBaseRepoTemplate() {
  if (!baseRepoTemplatePromise) {
    baseRepoTemplatePromise = buildBaseRepoTemplate();
  }
  return baseRepoTemplatePromise;
}

/** Fresh bare remote + work repo cloned from the shared template (fast fs copy). */
async function createBaseRepo() {
  const template = await ensureBaseRepoTemplate();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "prune-local-"));
  const bare = path.join(tmp, "remote.git");
  const work = path.join(tmp, "work");

  cpSync(template.bare, bare, { recursive: true });
  cpSync(template.work, work, { recursive: true });
  git(work, `remote set-url origin "${bare}"`);

  return { tmp, work, bare };
}

async function installGitNetworkSentinel(tmp, { blockNetwork = true, failPrefix = "", failMutationTarget = "" } = {}) {
  const fakeBin = path.join(tmp, "fake-bin");
  const ledger = path.join(tmp, "git-ledger.jsonl");
  const realGit = resolveExecutable("git");
  await fs.mkdir(fakeBin);
  await fs.writeFile(ledger, "");
  const wrapper = path.join(fakeBin, "git");
  await fs.writeFile(wrapper, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const argv = process.argv.slice(2);
const commandArgv = argv[0] === "-c" && argv[1] === "core.longpaths=true" ? argv.slice(2) : argv;
appendFileSync(process.env.DEVPRO_GIT_LEDGER, JSON.stringify(argv) + "\\n");
if (process.env.DEVPRO_BLOCK_NETWORK === "1" && ["fetch", "ls-remote", "push"].includes(argv[0])) process.exit(91);
if (process.env.DEVPRO_FAIL_GIT_PREFIX && commandArgv.join(" ").startsWith(process.env.DEVPRO_FAIL_GIT_PREFIX)) process.exit(93);
if (process.env.DEVPRO_FAIL_MUTATION_TARGET && argv[0] === "branch" && ["-d", "-D"].includes(argv[1]) && argv[2] === process.env.DEVPRO_FAIL_MUTATION_TARGET) process.exit(94);
const r = spawnSync(${JSON.stringify(realGit)}, argv, { stdio: "inherit" });
process.exit(r.status ?? 92);
`);
  await fs.chmod(wrapper, 0o755);
  return {
    ledger,
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      DEVPRO_GIT_LEDGER: ledger,
      DEVPRO_BLOCK_NETWORK: blockNetwork ? "1" : "0",
      DEVPRO_FAIL_GIT_PREFIX: failPrefix,
      DEVPRO_FAIL_MUTATION_TARGET: failMutationTarget,
    },
  };
}

async function installProcessAndTransportSentinel(tmp) {
  const preload = path.join(tmp, "prune-process-transport-sentinel.mjs");
  const ledger = path.join(tmp, "process-transport-ledger.jsonl");
  await fs.writeFile(ledger, "");
  await fs.writeFile(preload, `
import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const ledger = process.env.DEVPRO_PROCESS_TRANSPORT_LEDGER;
const record = (entry) => appendFileSync(ledger, JSON.stringify(entry) + "\\n");
const childProcess = require("node:child_process");
for (const method of ["execFileSync", "execSync", "spawnSync", "execFile", "exec", "spawn", "fork"]) {
  const original = childProcess[method];
  if (typeof original !== "function") continue;
  childProcess[method] = function (...args) {
    record({
      kind: "child-process",
      method,
      file: String(args[0] ?? ""),
      args: Array.isArray(args[1]) ? args[1].map(String) : [],
    });
    return Reflect.apply(original, this, args);
  };
}

const blockedTransports = {
  "node:http": ["request", "get"],
  "node:https": ["request", "get"],
  "node:net": ["connect", "createConnection"],
  "node:tls": ["connect"],
  "node:dns": ["lookup", "resolve", "resolve4", "resolve6"],
  "node:dgram": ["createSocket"],
};
for (const [specifier, methods] of Object.entries(blockedTransports)) {
  const carrier = require(specifier);
  for (const method of methods) {
    if (typeof carrier[method] !== "function") continue;
    carrier[method] = function (...args) {
      record({ kind: "transport", carrier: specifier, method, operand: String(args[0] ?? "") });
      throw new Error("explicit local-only transport sentinel blocked " + specifier + "." + method);
    };
  }
  if (specifier === "node:dns" && carrier.promises) {
    for (const method of ["lookup", "resolve", "resolve4", "resolve6"]) {
      if (typeof carrier.promises[method] !== "function") continue;
      carrier.promises[method] = async function (...args) {
        record({ kind: "transport", carrier: "node:dns/promises", method, operand: String(args[0] ?? "") });
        throw new Error("explicit local-only transport sentinel blocked node:dns/promises." + method);
      };
    }
  }
}
if (typeof globalThis.fetch === "function") {
  globalThis.fetch = async function (...args) {
    record({ kind: "transport", carrier: "globalThis", method: "fetch", operand: String(args[0] ?? "") });
    throw new Error("explicit local-only transport sentinel blocked fetch");
  };
}
syncBuiltinESMExports();
`);
  const importOption = `--import=${pathToFileURL(preload).href}`;
  return {
    ledger,
    env: {
      ...process.env,
      DEVPRO_PROCESS_TRANSPORT_LEDGER: ledger,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, importOption].filter(Boolean).join(" "),
    },
  };
}

async function readJsonLines(file) {
  const text = await fs.readFile(file, "utf8");
  return text.trim() ? text.trim().split("\n").map(JSON.parse) : [];
}

// ─── Scenario 0: dry-run CLI contract ─────────────────────────────────────


describe("prune-merged-local: dry-run CLI contract", () => {
  let tmp, work;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("uses no-argument invocation as the dry-run scan", () => {
    const result = spawnSync("node", [pruneScript], { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /no production branch found/);
  });

  it("rejects --dry-run and points to the no-argument scan", () => {
    const result = spawnSync("node", [pruneScript, "--dry-run"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /Unsupported option: --dry-run/);
    assert.match(result.stderr, /Dry-run is the default no-argument mode/);
    assert.match(result.stderr, /^  node \.devpro\/scripts\/prune-merged-local\.mjs$/m);
    assert.match(result.stderr, /--include-subsumed/);
    assert.match(
      result.stderr,
      /--local-only --exec[^\n]*zero-network[^\n]*freshness unverified/i,
      "CLI help must explain explicit local-only zero-network and unverified remote freshness",
    );
  });

  it("rejects ambiguous local-only + include-remote scope", () => {
    const result = spawnSync("node", [pruneScript, "--local-only", "--include-remote"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /--local-only and --include-remote cannot be used together/);
  });
});

describe("prune-merged-local: ordered mutation failure boundary", () => {
  it("prove-it I1: aborts before every mutation when the worktree snapshot probe fails", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      gitArgv(work, ["branch", "production", "main"]);
      gitArgv(work, ["branch", "chore/snapshot-fail", "main"]);
      const sentinel = await installGitNetworkSentinel(tmp, {
        blockNetwork: false,
        failPrefix: "worktree list --porcelain",
      });
      const result = spawnSync("node", [pruneScript, "--exec"], {
        cwd: work,
        encoding: "utf8",
        env: sentinel.env,
      });
      assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /worktree snapshot probe-failed.*before mutation|probe-failed.*worktree snapshot.*before mutation/i,
      );
      const calls = await readJsonLines(sentinel.ledger);
      assert.deepEqual(
        calls.filter((argv) =>
          ((argv[0] === "worktree" && argv[1] === "remove") || (argv[0] === "-c" && argv[2] === "worktree" && argv[3] === "remove")) ||
          (argv[0] === "branch" && ["-d", "-D"].includes(argv[1])) ||
          argv[0] === "push"),
        [],
        `snapshot failure must precede all mutations: ${JSON.stringify(calls)}`,
      );
      assert.match(
        gitArgv(work, ["branch", "--list", "chore/snapshot-fail"]),
        /chore\/snapshot-fail/,
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("stops before branch deletion when linked-worktree removal fails", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      gitArgv(work, ["branch", "chore/worktree-fail", "main"]);
      const linked = path.join(tmp, "linked");
      gitArgv(work, ["worktree", "add", "-q", linked, "chore/worktree-fail"]);
      const sentinel = await installGitNetworkSentinel(tmp, {
        blockNetwork: false,
        failPrefix: "worktree remove",
      });
      const result = spawnSync("node", [pruneScript, "--force-delete", "chore/worktree-fail"], {
        cwd: work,
        encoding: "utf8",
        env: sentinel.env,
      });
      assert.equal(result.status, 1);
      assert.match(`${result.stdout}\n${result.stderr}`, /branch retained/);
      assert.match(`${result.stdout}\n${result.stderr}`, /no later mutations attempted/);
      assert.match(gitArgv(work, ["branch", "--list", "chore/worktree-fail"]), /chore\/worktree-fail/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("reports worktree removed and retained branch when branch mutation fails", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      gitArgv(work, ["branch", "chore/branch-fail", "main"]);
      const linked = path.join(tmp, "linked");
      gitArgv(work, ["worktree", "add", "-q", linked, "chore/branch-fail"]);
      const sentinel = await installGitNetworkSentinel(tmp, {
        blockNetwork: false,
        failPrefix: "branch -D chore/branch-fail",
      });
      const result = spawnSync("node", [pruneScript, "--force-delete", "chore/branch-fail"], {
        cwd: work,
        encoding: "utf8",
        env: sentinel.env,
      });
      assert.equal(result.status, 1);
      assert.match(`${result.stdout}\n${result.stderr}`, /worktree removed/);
      assert.match(`${result.stdout}\n${result.stderr}`, /branch retained/);
      assert.match(`${result.stdout}\n${result.stderr}`, /no later mutations attempted/);
      assert.match(gitArgv(work, ["branch", "--list", "chore/branch-fail"]), /chore\/branch-fail/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("prove-it I2: aborts the outer batch on the first branch -d failure without -D escalation", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      gitArgv(work, ["branch", "production", "main"]);
      gitArgv(work, ["push", "-q", "-u", "origin", "production"]);
      gitArgv(work, ["branch", "chore/a-first", "main"]);
      gitArgv(work, ["branch", "chore/z-later", "main"]);
      const linked = path.join(tmp, "linked-batch");
      gitArgv(work, ["worktree", "add", "-q", linked, "chore/a-first"]);
      const sentinel = await installGitNetworkSentinel(tmp, {
        blockNetwork: false,
        failPrefix: "branch -d chore/a-first",
      });
      const result = spawnSync("node", [pruneScript, "--exec"], {
        cwd: work,
        encoding: "utf8",
        env: sentinel.env,
      });
      assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /worktree removed/);
      assert.match(`${result.stdout}\n${result.stderr}`, /branch retained/);
      assert.match(`${result.stdout}\n${result.stderr}`, /no later mutations attempted/);
      const calls = await readJsonLines(sentinel.ledger);
      assert.deepEqual(
        calls.filter((argv) => argv[0] === "branch" && argv[1] === "-D" && argv[2] === "chore/a-first"),
        [],
        `a nonzero -d must not escalate to -D: ${JSON.stringify(calls)}`,
      );
      assert.deepEqual(
        calls.filter((argv) => argv[0] === "branch" && ["-d", "-D"].includes(argv[1]) && argv[2] === "chore/z-later"),
        [],
        `no later target may be touched: ${JSON.stringify(calls)}`,
      );
      assert.doesNotMatch(gitArgv(work, ["worktree", "list", "--porcelain"]), new RegExp(linked));
      assert.match(gitArgv(work, ["branch", "--list", "chore/a-first"]), /chore\/a-first/);
      assert.match(gitArgv(work, ["branch", "--list", "chore/z-later"]), /chore\/z-later/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

// ─── Scenario A: no production branch ──────────────────────────────────────

describe("prune-merged-local: no production branch", () => {
  let tmp, work, result;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());
    // create a branch that merged into main — but no production branch
    git(work, "checkout -q -b feature/no-prod");
    await fs.writeFile(path.join(work, "b.txt"), "feat\n");
    git(work, "add .");
    git(work, "commit -q -m 'feat: b'");
    git(work, "checkout -q main");
    git(work, "merge -q --no-ff feature/no-prod -m 'merge feature/no-prod'");
    git(work, "push -q origin main");
    // Both `it()`s below assert on disjoint aspects (stdout message vs.
    // absence of a `git branch -d` suggestion) of the SAME no-argument scan
    // over the SAME fixture state — one shared spawn instead of two.
    result = spawnSync("node", [pruneScript], { cwd: work, encoding: "utf8" });
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("exits 0 and reports no production branch found", () => {
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /no production branch found/);
  });

  it("does not print any git branch -d command", () => {
    assert.doesNotMatch(result.stdout, /git branch -d/);
  });
});

// ─── Scenario B: branch tip contained in latest prod tag ───────────────────

describe("prune-merged-local: branch tip in prod tag → listed as candidate", () => {
  let tmp, work, pruneResult;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    // create feature branch, merge it, tag production
    git(work, "checkout -q -b feature/shipped");
    await fs.writeFile(path.join(work, "feat.txt"), "shipped\n");
    git(work, "add .");
    git(work, "commit -q -m 'feat: shipped'");
    git(work, "checkout -q main");
    git(work, "merge -q --no-ff feature/shipped -m 'merge feature/shipped'");
    // tag PROD at this point (contains feature/shipped tip)
    git(work, "tag production-v1.0.0");
    git(work, "branch -f production");
    git(work, "push -q origin main");
    pruneResult = spawnSync(process.execPath, [pruneScript], { cwd: work, encoding: "utf8" });
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("lists feature/shipped as eligible for deletion", () => {
    assert.equal(pruneResult.status, 0, `stderr: ${pruneResult.stderr}`);
    assert.match(pruneResult.stdout, /feature\/shipped/);
  });

  it("prints git branch -d command with the candidate", () => {
    assert.match(pruneResult.stdout, /git branch -d feature\/shipped/);
  });

  it("prints effective scan scope and degraded production fallback", () => {
    assert.match(pruneResult.stdout, /Effective scan scope/);
    assert.match(pruneResult.stdout, /fetch: checked \(git fetch --prune\)/);
    assert.match(pruneResult.stdout, /production-ref: production \(fallback: origin\/production unavailable\)/);
    assert.match(pruneResult.stdout, /branch snapshot: checked, entries=\d+/);
    assert.match(pruneResult.stdout, /remote ref visibility: checked, refs=\d+/);
    assert.match(
      pruneResult.stdout,
      /worktree snapshot: checked, git-linked=\d+, fs-\.worktree=\d+, entries=\d+/,
    );
    assert.match(pruneResult.stdout, /degraded effective scope: production-ref fallback/);
  });

  it("does NOT auto-delete the branch", () => {
    // branch should still exist
    const branches = git(work, "branch --list feature/shipped");
    assert.ok(branches.includes("feature/shipped"), "branch must still exist after prune script");
  });
});

// ─── Scenario C: exclusions — current / main / production / release/* ──────

describe("prune-merged-local: exclusion rules", () => {
  let tmp, work, pruneResult;

  function shippedCandidateNames() {
    const match = pruneResult.stdout.match(
      /branch\(es\) confirmed shipped[^:]*:\n([\s\S]*?)(?=\n\s*(?:To delete|Remote refs|✅|ℹ️|⚠️|（|no branches|⚠️  dry-run))/,
    );
    return (match?.[1] ?? "")
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean);
  }

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    // Make main's current commit part of a prod tag + production branch
    git(work, "tag production-v1.0.0");
    git(work, "branch -f production");

    // release/* branch (now IS a valid candidate when ancestor of production)
    git(work, "checkout -q -b release/v1.0");
    git(work, "checkout -q main");

    // rules/* branch (now IS a valid candidate when ancestor of production)
    git(work, "checkout -q -b rules/agent-rules-v0.1.0");
    git(work, "checkout -q main");

    // feature branch (always a valid candidate)
    git(work, "checkout -q -b feature/add-foo");
    git(work, "checkout -q main");
    pruneResult = spawnSync(process.execPath, [pruneScript], { cwd: work, encoding: "utf8" });
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("canonical shipped selection excludes main and production while retaining an ordinary candidate", () => {
    assert.equal(pruneResult.status, 0, `stderr: ${pruneResult.stderr}`);
    const candidates = shippedCandidateNames();
    assert.ok(candidates.includes("feature/add-foo"), `ordinary candidate missing: ${candidates}`);
    assert.ok(!candidates.includes("main"), `main must not be selected: ${candidates}`);
    assert.ok(!candidates.includes("production"), `production must not be selected: ${candidates}`);
  });

  it("INCLUDES release/* branches that are ancestor of production (new rule)", () => {
    assert.match(pruneResult.stdout, /release\/v1\.0/,
      "release/* now treated like other shipped branches; ancestor-of-production check decides");
  });

  it("EXCLUDES rules/* from shipped candidate scan (owned by prune-rules-lane.mjs)", () => {
    const orphanIdx = pruneResult.stdout.search(/orphaned|untracked local-only|force-delete/i);
    const beforeAdvisory = orphanIdx === -1 ? pruneResult.stdout : pruneResult.stdout.slice(0, orphanIdx);
    assert.doesNotMatch(beforeAdvisory, /rules\/agent-rules-v0\.1\.0/,
      "rules/* must not appear in prune-merged-local shipped/unshipped candidate sections after #2726");
  });

  it("excludes current branch from candidate list", () => {
    // current branch is main — already tested by main exclusion
    // This test verifies output does not contain the current-checkout indicator
    assert.equal(pruneResult.status, 0, `stderr: ${pruneResult.stderr}`);
    // The current branch is main; it must not appear as candidate
    const candidateSection = pruneResult.stdout;
    assert.doesNotMatch(candidateSection, /^\s+main$/m);
  });

  it("includes feature/* branch when its tip is ancestor of production", () => {
    assert.match(pruneResult.stdout, /feature\/add-foo/);
  });
});

// ─── Scenario D: branch NOT in prod tag → not listed ──────────────────────

describe("prune-merged-local: branch tip NOT in prod tag → not listed", () => {
  let tmp, work, pruneResult;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    // tag PROD at initial commit
    git(work, "tag production-v1.0.0");
    git(work, "branch -f production");

    // create a new branch AFTER prod tag — tip is not contained in prod tag
    git(work, "checkout -q -b feature/post-prod");
    await fs.writeFile(path.join(work, "new.txt"), "new\n");
    git(work, "add .");
    git(work, "commit -q -m 'feat: post-prod'");
    git(work, "checkout -q main");
    git(work, "push -q origin main");
    pruneResult = spawnSync(process.execPath, [pruneScript], { cwd: work, encoding: "utf8" });
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("does not list feature/post-prod as a deletion candidate", () => {
    assert.equal(pruneResult.status, 0, `stderr: ${pruneResult.stderr}`);
    // feature/post-prod is never-pushed, so it now surfaces in the advisory
    // untracked-local-only block — but it must NOT be a deletion candidate
    // (no `git branch -d`, no orphaned/subsumed/archive-shipped label).
    const idx = pruneResult.stdout.search(/untracked local-only/i);
    const beforeAdvisory = idx === -1 ? pruneResult.stdout : pruneResult.stdout.slice(0, idx);
    assert.doesNotMatch(beforeAdvisory, /feature\/post-prod/,
      "never-pushed branch must not appear as a deletion candidate, only in the advisory block");
  });

  it("reports no deletion candidates but does surface the never-pushed ref as advisory", () => {
    // The only thing present is the never-pushed ref, which is advisory-only.
    assert.match(pruneResult.stdout, /untracked local-only/i);
    assert.match(pruneResult.stdout, /feature\/post-prod/);
  });
});

// ─── Scenario E: --keep CLI writes to deletable-keep ──────────────────────

describe("prune-merged-local: --keep adds branch to keep list", () => {
  let tmp, work;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("exits 0 after --keep <branch>", () => {
    const result = spawnSync("node", [pruneScript, "--keep", "feature/my-branch"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  });

  it("writes the branch name into .git/info/deletable-keep", async () => {
    const keepFile = path.join(work, ".git", "info", "deletable-keep");
    const content = await fs.readFile(keepFile, "utf8");
    assert.match(content, /feature\/my-branch/);
  });

  it("reports already-in-keep when called again with same branch", () => {
    const result = spawnSync("node", [pruneScript, "--keep", "feature/my-branch"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /已在 keep 清單中/);
  });
});

// ─── Scenario F: --keep-list shows keep list contents ─────────────────────

describe("prune-merged-local: --keep-list lists keep entries", () => {
  let tmp, work, result;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());
    // pre-populate keep list
    spawnSync("node", [pruneScript, "--keep", "feature/alpha", "feature/beta"], {
      cwd: work,
      encoding: "utf8",
    });
    // Both `it()`s below assert on disjoint facets (exit code vs. stdout
    // content) of the SAME --keep-list invocation — one shared spawn.
    result = spawnSync("node", [pruneScript, "--keep-list"], { cwd: work, encoding: "utf8" });
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("exits 0 for --keep-list", () => {
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  });

  it("--keep-list output contains all kept branch names", () => {
    assert.match(result.stdout, /feature\/alpha/);
    assert.match(result.stdout, /feature\/beta/);
  });
});

// ─── Scenario G: keep × local — kept local branch is skipped in scan ──────

describe("prune-merged-local: keep × local branch — kept branch skipped in scan", () => {
  let tmp, work, pruneResult;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    // feature/kept: merged and contained in prod tag, but in keep list
    git(work, "checkout -q -b feature/kept");
    await fs.writeFile(path.join(work, "kept.txt"), "kept\n");
    git(work, "add .");
    git(work, "commit -q -m 'feat: kept'");
    git(work, "checkout -q main");
    git(work, "merge -q --no-ff feature/kept -m 'merge feature/kept'");
    git(work, "tag production-v1.0.0");
    git(work, "branch -f production");
    git(work, "push -q origin main");

    // add feature/kept to keep list
    spawnSync(process.execPath, [pruneScript, "--keep", "feature/kept"], { cwd: work, encoding: "utf8" });
    pruneResult = spawnSync(process.execPath, [pruneScript], { cwd: work, encoding: "utf8" });
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("does not list feature/kept as local candidate even though tip is in prod tag", () => {
    assert.equal(pruneResult.status, 0, `stderr: ${pruneResult.stderr}`);
    assert.doesNotMatch(pruneResult.stdout, /feature\/kept/);
  });

  it("reports no branches eligible (only candidate was kept)", () => {
    assert.match(pruneResult.stdout, /no branches or worktrees eligible/);
  });
});

// ─── Scenario H: keep × remote — kept remote branch is skipped ────────────

describe("prune-merged-local: keep × remote branch — kept remote branch skipped", () => {
  let tmp, work;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    // feature/remote-kept: create on remote, merge into main, tag prod
    git(work, "checkout -q -b feature/remote-kept");
    await fs.writeFile(path.join(work, "rk.txt"), "rk\n");
    git(work, "add .");
    git(work, "commit -q -m 'feat: remote-kept'");
    git(work, "push -q origin feature/remote-kept");
    git(work, "checkout -q main");
    git(work, "merge -q --no-ff feature/remote-kept -m 'merge remote-kept'");
    git(work, "tag production-v1.0.0");
    git(work, "branch -f production");
    git(work, "push -q origin main");

    // delete local copy so only remote remains, then fetch
    git(work, "branch -q -D feature/remote-kept");
    git(work, "fetch -q origin");

    // add to keep list by short name
    spawnSync("node", [pruneScript, "--keep", "feature/remote-kept"], { cwd: work, encoding: "utf8" });
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("does not list remote feature/remote-kept as candidate", () => {
    const result = spawnSync("node", [pruneScript], { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /feature\/remote-kept/);
  });
});

// ─── Scenario I: keep × worktree — kept worktree branch is skipped ─────────

describe("prune-merged-local: keep × worktree — kept worktree branch skipped", () => {
  let tmp, work, wtPath;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    // create feature/wt-kept branch with a commit, tag prod at its tip directly
    // (so worktree's HEAD is contained in prod tag)
    git(work, "checkout -q -b feature/wt-kept");
    await fs.writeFile(path.join(work, "wt.txt"), "wt\n");
    git(work, "add .");
    git(work, "commit -q -m 'feat: wt-kept'");
    // tag prod directly at the feature tip — HEAD is now feature/wt-kept tip
    git(work, "tag production-v1.0.0");
    git(work, "branch -f production");
    git(work, "checkout -q main");

    // add a linked worktree for feature/wt-kept
    wtPath = path.join(tmp, "wt-kept-tree");
    git(work, `worktree add "${wtPath}" feature/wt-kept`);

    // add to keep list
    spawnSync("node", [pruneScript, "--keep", "feature/wt-kept"], { cwd: work, encoding: "utf8" });
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("does not list the worktree as candidate when its branch is in keep list", () => {
    const result = spawnSync("node", [pruneScript], { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    // worktree path or branch name must not appear as a worktree candidate
    assert.doesNotMatch(result.stdout, /wt-kept-tree/);
    assert.doesNotMatch(result.stdout, /git worktree remove.*wt-kept/);
  });
});

// ─── Scenario J: keep × orphan — kept orphan branch is skipped ────────────

describe("prune-merged-local: keep × orphan branch — kept orphan skipped", () => {
  let tmp, work;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    // Create + push feature/orphan-kept, configure tracking
    git(work, "checkout -q -b feature/orphan-kept");
    await fs.writeFile(path.join(work, "orp.txt"), "orp\n");
    git(work, "add .");
    git(work, "commit -q -m 'feat: orphan-kept'");
    git(work, "push -q origin feature/orphan-kept");
    // set up tracking config
    git(work, "branch --set-upstream-to=origin/feature/orphan-kept feature/orphan-kept");
    git(work, "checkout -q main");

    // tag prod at main
    git(work, "tag production-v1.0.0");
    git(work, "branch -f production");

    // delete the remote ref to create orphan state
    git(work, "push -q origin --delete feature/orphan-kept");
    git(work, "fetch -q --prune origin");

    // add to keep list
    spawnSync("node", [pruneScript, "--keep", "feature/orphan-kept"], { cwd: work, encoding: "utf8" });
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("does not list feature/orphan-kept as orphan candidate when in keep list", () => {
    const result = spawnSync("node", [pruneScript], { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /feature\/orphan-kept/);
  });
});

// ─── Scenario K: remote branch scanning ───────────────────────────────────

describe("prune-merged-local: remote branch scan → reports explicit remote-delete opt-in", () => {
  let tmp, work, pruneResult;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    // Push feature/remote-ship to origin, merge into main, tag prod
    git(work, "checkout -q -b feature/remote-ship");
    await fs.writeFile(path.join(work, "rs.txt"), "rs\n");
    git(work, "add .");
    git(work, "commit -q -m 'feat: remote-ship'");
    git(work, "push -q origin feature/remote-ship");
    git(work, "checkout -q main");
    git(work, "merge -q --no-ff feature/remote-ship -m 'merge remote-ship'");
    git(work, "tag production-v1.0.0");
    git(work, "branch -f production");
    git(work, "push -q origin main");

    // Remove local copy — remote still exists
    git(work, "branch -q -D feature/remote-ship");
    git(work, "fetch -q origin");
    pruneResult = spawnSync(process.execPath, [pruneScript], { cwd: work, encoding: "utf8" });
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("lists origin/feature/remote-ship as remote candidate", () => {
    assert.equal(pruneResult.status, 0, `stderr: ${pruneResult.stderr}`);
    assert.match(pruneResult.stdout, /remote branch/i);
    assert.match(pruneResult.stdout, /feature\/remote-ship/);
  });

  it("does not output a raw git push origin --delete command in dry-run output", () => {
    assert.doesNotMatch(pruneResult.stdout, /git push origin --delete feature\/remote-ship/);
  });

  it("points remote cleanup to --include-remote --exec", () => {
    assert.match(pruneResult.stdout, /--include-remote --exec/);
  });

  it("does NOT auto-delete the remote branch", () => {
    // verify remote ref still exists in local tracking
    const refs = execSync("git branch -r", { cwd: work, encoding: "utf8" });
    assert.match(refs, /origin\/feature\/remote-ship/);
  });
});

// ─── Scenario L: ancestor semantic — tag-only containment is NOT enough ────
//
// Setup: feature/orphan-tag has a production-* tag stuck directly on its tip
// but was NEVER merged into the production branch (simulating a stray tag /
// abandoned experiment). Under the new ancestor-of-production criterion this
// branch must NOT be detected as shipped — old tag-containment logic would
// have wrongly listed it.

describe("prune-merged-local: ancestor semantic — orphan-tagged branch not in production line is NOT a candidate", () => {
  let tmp, work;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    // Step 1: create feature/orphan-tag branch; tag production-v6.30.0 directly
    // at its tip WITHOUT merging into main / production. Stray-tag scenario.
    git(work, "checkout -q -b feature/orphan-tag");
    await fs.writeFile(path.join(work, "old.txt"), "old\n");
    git(work, "add .");
    git(work, "commit -q -m 'feat: stray-tagged'");
    git(work, "tag production-v6.30.0");
    git(work, "checkout -q main");

    // Step 2: main advances and is properly promoted to production with tag.
    await fs.writeFile(path.join(work, "next.txt"), "next\n");
    git(work, "add .");
    git(work, "commit -q -m 'chore: main advance for v6.30.1'");
    git(work, "tag production-v6.30.1");
    git(work, "branch -f production");

    git(work, "push -q origin main");
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("does NOT list feature/orphan-tag as shipped — tip is not ancestor of production branch", () => {
    const result = spawnSync("node", [pruneScript], { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    // feature/orphan-tag is never-pushed, so it surfaces in the advisory
    // untracked-local-only block — but the ancestor semantic still holds: it
    // must NOT be detected as a shipped deletion candidate above the advisory.
    const idx = result.stdout.search(/untracked local-only/i);
    const beforeAdvisory = idx === -1 ? result.stdout : result.stdout.slice(0, idx);
    assert.doesNotMatch(beforeAdvisory, /feature\/orphan-tag/,
      "Ancestor semantic: stray-tagged branches not actually merged into production must NOT be detected as shipped");
  });

  it("verifies the feature tip is genuinely NOT an ancestor of production", () => {
    const featureTip = git(work, "rev-parse feature/orphan-tag");
    const { status } = spawnSync(
      "git", ["merge-base", "--is-ancestor", featureTip, "production"],
      { cwd: work }
    );
    assert.notEqual(status, 0,
      "Prerequisite check: feature/orphan-tag tip must NOT be an ancestor of production");
  });
});

// ─── Scenario L: --exec mode deletes local candidates; remote is opt-in ───────

describe("prune-merged-local: --exec executes confirmed local deletes; remote requires opt-in", () => {
  let tmp, work;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    // feature/shipped: merged into main, push to origin, tagged
    git(work, "checkout -q -b feature/shipped");
    await fs.writeFile(path.join(work, "ship.txt"), "ship\n");
    git(work, "add .");
    git(work, "commit -q -m 'feat: ship'");
    git(work, "push -q -u origin feature/shipped");
    git(work, "checkout -q main");
    git(work, "merge -q --no-ff feature/shipped -m 'merge feature/shipped'");
    git(work, "tag production-v1.0.0");
    git(work, "branch -f production");
    git(work, "push -q origin main");
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("--exec deletes the local feature/shipped branch and skips remote deletion", () => {
    const result = spawnSync("node", [pruneScript, "--exec"], { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /EXECUTION MODE \/ USER APPROVAL REQUIRED/);
    assert.match(result.stdout, /local branches\/worktrees only/);
    assert.match(result.stdout, /executing: git branch -d/);
    assert.doesNotMatch(result.stdout, /executing: git push origin/);
    assert.match(result.stdout, /skipped 1 remote ref/);
    assert.match(result.stdout, /--exec 完成/);
    // Confirm local branch gone
    const localList = git(work, "branch --list feature/shipped");
    assert.equal(localList, "", "feature/shipped local should be deleted");
    const remoteRefs = git(work, "ls-remote --heads origin");
    assert.match(remoteRefs, /refs\/heads\/feature\/shipped/, "feature/shipped remote must survive default --exec");
  });

  it("--include-remote --exec deletes the confirmed remote feature/shipped branch", () => {
    const result = spawnSync("node", [pruneScript, "--include-remote", "--exec"], { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /executing: git push origin --force-with-lease=refs\/heads\/feature\/shipped:[0-9a-f]{40} :refs\/heads\/feature\/shipped/);
    assert.doesNotMatch(
      git(work, "ls-remote --heads origin"),
      /refs\/heads\/feature\/shipped/,
      "feature/shipped remote should be deleted only after --include-remote --exec",
    );
  });
});

describe("prune-merged-local: explicit --local-only --exec is accepted and skips remote deletion", () => {
  let tmp, work;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    git(work, "checkout -q -b feature/local-only-shipped");
    await fs.writeFile(path.join(work, "local-only.txt"), "ship\n");
    git(work, "add .");
    git(work, "commit -q -m 'feat: local-only shipped'");
    git(work, "push -q -u origin feature/local-only-shipped");
    git(work, "checkout -q main");
    git(work, "merge -q --no-ff feature/local-only-shipped -m 'merge local-only shipped'");
    git(work, "tag production-v1.0.0");
    git(work, "branch -f production");
    git(work, "push -q origin main");
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("--local-only --exec documents intent, deletes local candidates, and never deletes remote refs", () => {
    const result = spawnSync("node", [pruneScript, "--local-only", "--exec"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /Unknown option/);
    assert.match(result.stdout, /local branches\/worktrees only/);
    assert.match(result.stdout, /executing: git branch -d feature\/local-only-shipped/);
    assert.doesNotMatch(result.stdout, /executing: git push origin/);
    assert.match(result.stdout, /skipped 1 remote ref/);
    assert.equal(git(work, "branch --list feature/local-only-shipped"), "");
    assert.match(
      git(work, "ls-remote --heads origin"),
      /refs\/heads\/feature\/local-only-shipped/,
      "remote ref must survive explicit --local-only --exec",
    );
  });
});

describe("prune-merged-local: --exec refuses degraded fetch scope", () => {
  let tmp, work;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());
    git(work, `remote set-url origin "${path.join(tmp, "missing-remote.git")}"`);
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("fails closed before deletion when git fetch --prune fails", () => {
    const result = spawnSync("node", [pruneScript, "--exec"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /fetch failed; continuing in degraded dry-run scope/);
    assert.match(result.stdout, /Effective scan scope/);
    assert.match(result.stdout, /fetch: not checked/);
    assert.match(result.stdout, /degraded effective scope: fetch/);
    assert.match(result.stderr, /Refusing --exec because git fetch --prune failed/);
    assert.doesNotMatch(result.stdout, /executing: git branch -d/);
    assert.doesNotMatch(result.stdout, /executing: git push origin/);
  });
});

// ─── Scenario M: --force-delete validates and executes single-branch override ─

describe("prune-merged-local: --force-delete validation + execution", () => {
  let tmp, work;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());
    // chore/abandoned: never merged, no PROD tag containment
    git(work, "checkout -q -b chore/abandoned");
    await fs.writeFile(path.join(work, "abandoned.txt"), "x\n");
    git(work, "add .");
    git(work, "commit -q -m 'wip'");
    // pr-1331-review: non-five-prefix PR-review ref, also abandoned
    git(work, "checkout -q -b pr-1331-review main");
    await fs.writeFile(path.join(work, "pr-review.txt"), "x\n");
    git(work, "add .");
    git(work, "commit -q -m 'wip'");
    git(work, "checkout -q main");
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("rejects protected branch (main)", () => {
    const r = spawnSync("node", [pruneScript, "--force-delete", "main"], { cwd: work, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /受保護分支/);
  });

  it("rejects protected branch (master)", () => {
    const r = spawnSync("node", [pruneScript, "--force-delete", "master"], { cwd: work, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /受保護分支/);
  });

  it("rejects release/* prefix", () => {
    const r = spawnSync("node", [pruneScript, "--force-delete", "release/v1.0.0"], { cwd: work, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /受保護分支/);
  });

  it("rejects current checked-out branch", () => {
    // create + checkout a non-protected branch, then target it while checked out
    git(work, "checkout -q -b chore/current-target main");
    const r = spawnSync("node", [pruneScript, "--force-delete", "chore/current-target"], { cwd: work, encoding: "utf8" });
    git(work, "checkout -q main");
    git(work, "branch -D chore/current-target");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /當前 checked-out 分支不可刪除/);
  });

  it("warns but deletes a non-five-prefix ref (PR-review ref)", () => {
    const r = spawnSync("node", [pruneScript, "--force-delete", "pr-1331-review"], { cwd: work, encoding: "utf8" });
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    // not rejected on prefix grounds
    assert.doesNotMatch(r.stderr, /前綴必須為/);
    // visible non-standard-work-branch warning
    assert.match(r.stdout + r.stderr, /非標準工作分支/);
    // transparent metadata still printed
    assert.match(r.stdout, /tip SHA:/);
    assert.match(r.stdout, /已刪除：pr-1331-review/);
    assert.equal(git(work, "branch --list pr-1331-review"), "", "pr-1331-review should be deleted");
  });

  it("rejects non-existent branch", () => {
    const r = spawnSync("node", [pruneScript, "--force-delete", "chore/nonexistent"], { cwd: work, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /不存在於本地/);
  });

  it("does NOT print the non-standard warning when a non-five-prefix target is rejected (e.g. non-existent)", () => {
    // warning must come AFTER the current-branch + existence guards, so a
    // target that gets rejected never prints a contradictory "will-proceed" line
    const r = spawnSync("node", [pruneScript, "--force-delete", "pr-9999-nonexistent"], { cwd: work, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /不存在於本地/);
    assert.doesNotMatch(r.stdout + r.stderr, /非標準工作分支/);
  });

  it("deletes valid abandoned chore/ branch without the non-standard warning", () => {
    const r = spawnSync("node", [pruneScript, "--force-delete", "chore/abandoned"], { cwd: work, encoding: "utf8" });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /chore\/abandoned/);
    assert.match(r.stdout, /tip SHA:/);
    assert.match(r.stdout, /已刪除：chore\/abandoned/);
    // five-prefix work branch → no non-standard warning
    assert.doesNotMatch(r.stdout + r.stderr, /非標準工作分支/);
    // Confirm gone
    const localList = git(work, "branch --list chore/abandoned");
    assert.equal(localList, "", "chore/abandoned should be deleted");
  });
});

// ─── Scenario: #1957 allow-release + advisory alignment ─────────────────────

/** Unwrap a POSIX single-quoted advisory token (advisoryBranchArg never double-quotes). */
function unquoteShellToken(token) {
  if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) {
    return token.slice(1, -1).replace(/'\\''/g, "'");
  }
  return token;
}

function extractPrintedPruneArgvs(stdout) {
  const out = [];
  for (const line of stdout.split("\n")) {
    const idx = line.indexOf("prune-merged-local.mjs ");
    if (idx === -1) continue;
    // Only contract-check force-delete handoff lines (ignore --exec/--keep footer prose).
    if (!line.includes("--force-delete")) continue;
    let rest = line.slice(idx + "prune-merged-local.mjs ".length).trim();
    const hash = rest.indexOf(" #");
    if (hash !== -1) rest = rest.slice(0, hash).trim();
    if (!rest) continue;
    out.push(rest.split(/\s+/).map(unquoteShellToken));
  }
  return out;
}

describe("prune-argv: advisoryBranchArg round-trip", () => {
  it("a POSIX-quoted name round-trips through unquoteShellToken", () => {
    for (const branch of ["chore/meta$(id)", "a'b", 'chore/odd"quote%PATH%bang!']) {
      assert.equal(unquoteShellToken(advisoryBranchArg(branch, "darwin")), branch);
    }
  });
});

describe("prune-argv: parsePruneArgv companion flag", () => {
  it("rejects destructive printed argv for every fixed protected base", () => {
    for (const branch of ["main", "master", "production", "integration"]) {
      assert.equal(acceptsPrintedPruneArgv(["--force-delete", branch]), false, branch);
      assert.equal(
        acceptsPrintedPruneArgv(["--force-delete", "--allow-release", branch]),
        false,
        branch,
      );
    }
    assert.equal(acceptsPrintedPruneArgv(["--force-delete", "chore/ordinary"]), true);
    assert.equal(
      acceptsPrintedPruneArgv(["--force-delete", "--allow-release", "release/ordinary"]),
      true,
    );
  });

  it("exports the sole explicit-local-only Git argv authority", () => {
    const orphanPath = path.resolve(os.tmpdir(), "named orphan");
    assert.equal(pruneArgv.acceptsPrintedPruneArgv(["--remove-orphan", orphanPath]), true);
    for (const tokens of [["--remove-orphan", "relative"], ["--remove-orphan"], ["--remove-orphan", orphanPath, "--exec"], ["--local-only", "--remove-orphan", orphanPath]]) {
      assert.equal(pruneArgv.acceptsPrintedPruneArgv(tokens), false, tokens.join(" "));
    }
    assert.equal(typeof pruneArgv.classifyLocalOnlyGitArgv, "function");
    assert.equal(
      typeof pruneArgv.classifyLocalOnlyProcessInvocation,
      "function",
      "prove-it I4: authority must reject non-Git executable carriers",
    );
    assert.equal(typeof pruneArgv.localOnlyGitArgvExamples, "function");
    const prefixes = ["feature/", "bugfix/", "chore/", "hotfix/", "release/"];
    const branchSnapshot = [
      "for-each-ref",
      "--format=%(refname)%00%(refname:short)%00%(objectname)",
      ...prefixes.map((prefix) => `refs/heads/${prefix}`),
      ...prefixes.map((prefix) => `refs/remotes/origin/${prefix}`),
    ];
    for (const args of [
      ["rev-parse", "--git-dir"],
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      ["-C", path.resolve(os.tmpdir(), "local-only-cwd"), "rev-parse", "--path-format=absolute", "--git-common-dir"],
      ["rev-parse", "--verify", "origin/production"],
      ["rev-parse", "--verify", "refs/heads/chore/local^{commit}"],
      ["branch", "--list"],
      ["branch", "--show-current"],
      ["branch", "-r", "--list", "origin/*"],
      branchSnapshot,
      ["for-each-ref", "--format=%(refname:short)", "--merged", "origin/main", "refs/heads/"],
      ["merge-base", "--is-ancestor", "abc123", "production"],
      ["config", "--get-regexp", "^branch\\..*\\.remote$"],
      ["tag", "--contains", "abc123"],
      ["worktree", "list", "--porcelain"],
      ["worktree", "remove", "--force", path.resolve(os.tmpdir(), "linked-worktree")],
      ["-c", "core.longpaths=true", "worktree", "remove", "--force", path.resolve(os.tmpdir(), "linked-worktree")],
      ["branch", "-d", "chore/local"],
      ["branch", "-D", "chore/local"],
    ]) {
      assert.equal(pruneArgv.classifyLocalOnlyGitArgv(args).allowed, true, args.join(" "));
      assert.equal(
        pruneArgv.classifyLocalOnlyProcessInvocation("git", args).allowed,
        true,
        `Git invocation must be accepted: ${args.join(" ")}`,
      );
    }
    for (const args of [
      ["fetch", "--prune"],
      ["ls-remote", "--heads", "origin", "refs/heads/x"],
      ["push", "origin", "--delete", "x"],
      ["remote"],
      ["branch", "--list", "extra"],
      ["branch", "--show-current", "extra"],
      ["branch", "-D", "origin/chore/local"],
      ["for-each-ref", "--upload-pack=ssh", "refs/heads/"],
      [...branchSnapshot, "refs/heads/extra/"],
      ["merge-base", "--is-ancestor", "abc123", "--upload-pack=ssh"],
      ["rev-parse", "--verify", "https://example.invalid/repo"],
      ["worktree", "remove", "--force", "https://example.invalid/worktree"],
      ["-c", "core.longpaths=true", "fetch"],
      ["-c", "core.longpaths=false", "worktree", "remove", "--force", path.resolve(os.tmpdir(), "linked-worktree")],
      ["-c", "core.longpaths=true", "worktree", "remove", "--force", path.resolve(os.tmpdir(), "linked-worktree"), "--extra"],
      ["-c", "core.longpaths=true", "worktree", "remove", "--force", "https://example.invalid/worktree"],
      ["worktree", "remove", "--force", "\\\\server\\share\\worktree"],
      ["mystery", "x"],
    ]) {
      assert.equal(pruneArgv.classifyLocalOnlyGitArgv(args).allowed, false, args.join(" "));
    }
    for (const executable of ["node", "curl", resolveExecutable("git")]) {
      assert.equal(
        pruneArgv.classifyLocalOnlyProcessInvocation(executable, ["rev-parse", "--git-dir"]).allowed,
        false,
        `non-literal Git executable must be rejected: ${executable}`,
      );
    }
    assert.equal(pruneArgv.classifyLocalOnlyGitArgv("git status").allowed, false);
  });
  it("parses --include-unshipped-mainline into includeUnshippedMainline", () => {
    const off = parsePruneArgv(["--exec"]);
    assert.equal(off.includeUnshippedMainline, false);
    const on = parsePruneArgv([
      "--include-unshipped-mainline",
      "--include-remote",
      "--exec",
    ]);
    assert.equal(on.includeUnshippedMainline, true);
    assert.equal(on.includeRemote, true);
    assert.equal(on.exec, true);
    assert.equal(on.mode, undefined);
    assert.equal(on.validMode, true);
  });

  it("filters --allow-release before MODE (not a VALID_MODES entry)", () => {
    const p = parsePruneArgv(["--force-delete", "--allow-release", "release/x"]);
    assert.equal(p.mode, "--force-delete");
    assert.equal(p.allowRelease, true);
    assert.deepEqual(p.args, ["release/x"]);
    assert.equal(p.validMode, true);
  });

  it("accepts order swap --allow-release before --force-delete", () => {
    const p = parsePruneArgv(["--allow-release", "--force-delete", "release/x"]);
    assert.equal(p.mode, "--force-delete");
    assert.equal(p.allowRelease, true);
  });

  it("rejects doomed plain --force-delete release/* in printed-shape validator", () => {
    assert.equal(acceptsPrintedPruneArgv(["--force-delete", "release/rules-x"]), false);
  });

  it("accepts dual opt-in printed shape", () => {
    assert.equal(
      acceptsPrintedPruneArgv(["--force-delete", "--allow-release", "release/rules-x"]),
      true,
    );
  });

  it("rejects --allow-release on non-release target shape", () => {
    assert.equal(
      acceptsPrintedPruneArgv(["--force-delete", "--allow-release", "chore/x"]),
      false,
    );
  });

  it("rejects --allow-release paired with non-force-delete printed modes", () => {
    assert.equal(acceptsPrintedPruneArgv(["--allow-release"]), false);
    assert.equal(acceptsPrintedPruneArgv(["--keep-list", "--allow-release"]), false);
    assert.equal(acceptsPrintedPruneArgv(["--keep", "--allow-release", "release/x"]), false);
  });
});

describe("prune-merged-local: fixed protected-base runtime matrix", () => {
  for (const branch of ["main", "master", "production", "integration"]) {
    it(`rejects plain and --allow-release force-delete for ${branch} before mutation`, async () => {
      const { tmp, work } = await createBaseRepo();
      try {
        if (branch !== "main") gitArgv(work, ["branch", branch, "main"]);
        const sentinel = await installGitNetworkSentinel(tmp, { blockNetwork: false });
        for (const argv of [
          [pruneScript, "--force-delete", branch],
          [pruneScript, "--force-delete", "--allow-release", branch],
        ]) {
          const result = spawnSync("node", argv, {
            cwd: work,
            encoding: "utf8",
            env: sentinel.env,
          });
          assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
          assert.match(result.stderr, /受保護分支/);
        }
        assert.match(gitArgv(work, ["branch", "--list", branch]), new RegExp(branch));
        const calls = await readJsonLines(sentinel.ledger);
        assert.deepEqual(
          calls.filter((argv) =>
            ((argv[0] === "worktree" && argv[1] === "remove") || (argv[0] === "-c" && argv[2] === "worktree" && argv[3] === "remove")) ||
            (argv[0] === "branch" && ["-d", "-D"].includes(argv[1])) ||
            argv[0] === "push"),
          [],
          `protected ${branch} must have no destructive child argv`,
        );
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  }
});

describe("prune-merged-local: explicit local-only zero-network boundary", () => {
  it("censuses every reachable child-process and in-process transport carrier", async () => {
    const pending = [pruneScript];
    const sources = new Map();
    while (pending.length > 0) {
      const file = pending.pop();
      if (sources.has(file)) continue;
      const source = await fs.readFile(file, "utf8");
      sources.set(file, source);
      const importPattern = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1] ?? match[2];
        if (!specifier?.startsWith(".")) continue;
        const resolved = path.resolve(path.dirname(file), specifier);
        for (const candidate of [resolved, `${resolved}.mjs`, `${resolved}.js`]) {
          try {
            accessSync(candidate, constants.F_OK);
            pending.push(candidate);
            break;
          } catch {
            // Try the next supported local module suffix.
          }
        }
      }
    }

    const transportCarriers = [];
    const childProcessCarriers = [];
    const scannerRejects = [];
    for (const [file, rawSource] of sources) {
      const rel = path.relative(path.dirname(pruneScript), file).split(path.sep).join("/");
      let source;
      try {
        source = stripJsCommentSpans(rawSource);
      } catch (error) {
        if (!(error instanceof JsCommentSpanScanError)) throw error;
        // Named fail-closed skip: lexical residuals (e.g. complex templates) must
        // be enumerated — never silent. Carrier asserts below only see stripped sources.
        scannerRejects.push(rel);
        continue;
      }
      if (/["'](?:node:)?(?:http|https|net|tls|dns|dgram)["']|\bfetch\s*\(|\bWebSocket\s*\(/.test(source)) {
        transportCarriers.push(rel);
      }
      if (/["'](?:node:)?child_process["']/.test(source)) childProcessCarriers.push(rel);
    }
    assert.deepEqual(
      scannerRejects.sort(),
      ["hooks/lib/branch-naming.mjs"],
      "stripJsCommentSpans rejects for prune reachable graph must stay explicitly named",
    );
    assert.deepEqual(transportCarriers.sort(), [], "reachable source graph must have no in-process transport carrier");
    assert.deepEqual(
      childProcessCarriers.sort(),
      ["hooks/lib/repo-state-identity.mjs", "lib/patch-id-utils.mjs", "lib/prune-orphan.mjs", "prune-merged-local.mjs"],
      "child-process carrier census must be exact and current-tree-derived",
    );
    const orphanSource = sources.get(path.join(path.dirname(pruneScript), "lib", "prune-orphan.mjs"));
    assert.match(orphanSource, /if \(!allowNativeProbe\) throw new Error/);
    assert.match(orphanSource, /execFileSync\('powershell\.exe'/);
    const runtimeSource = sources.get(pruneScript);
    assert.match(runtimeSource, /allowNativeProbe: !LOCAL_ONLY/);
    assert.equal([...runtimeSource.matchAll(/\bexecFileSync\s*\(/g)].length, 2);
    assert.match(runtimeSource, /const EVALUATE_SUBSUMED = INCLUDE_SUBSUMED && !PARSED\.localOnly;/);
  });

  it("runtime sentinel permits only classified Git child argv and records no transport", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      gitArgv(work, ["branch", "production", "main"]);
      gitArgv(work, ["branch", "release/local-only-sentinel", "main"]);
      const sentinel = await installProcessAndTransportSentinel(tmp);
      const result = spawnSync(process.execPath, [pruneScript, "--local-only"], {
        cwd: work,
        encoding: "utf8",
        env: sentinel.env,
      });
      assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      const records = await readJsonLines(sentinel.ledger);
      assert.deepEqual(records.filter((record) => record.kind === "transport"), []);
      const childRecords = records.filter((record) => record.kind === "child-process");
      assert.ok(childRecords.length > 0, "sentinel must observe real child effects");
      const classifyProcessInvocation = pruneArgv.classifyLocalOnlyProcessInvocation;
      assert.equal(
        typeof classifyProcessInvocation,
        "function",
        "runtime effect verifier requires the process-level local-only authority",
      );
      for (const record of childRecords) {
        assert.equal(record.method, "execFileSync", JSON.stringify(record));
        assert.equal(
          classifyProcessInvocation(record.file, record.args).allowed,
          true,
          `unclassified child effect: ${JSON.stringify(record)}`,
        );
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("does not attempt fetch or any live remote query", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      gitArgv(work, ["branch", "production", "main"]);
      gitArgv(work, ["branch", "release/local-only-proof", "main"]);
      const sentinel = await installGitNetworkSentinel(tmp);
      const result = spawnSync("node", [pruneScript, "--local-only"], {
        cwd: work,
        encoding: "utf8",
        env: sentinel.env,
      });
      assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      const calls = (await fs.readFile(sentinel.ledger, "utf8"))
        .trim().split("\n").filter(Boolean).map(JSON.parse);
      for (const argv of calls) {
        assert.equal(
          pruneArgv.classifyLocalOnlyGitArgv(argv).allowed,
          true,
          `explicit local-only child argv must be classified: ${JSON.stringify(argv)}`,
        );
      }
      assert.deepEqual(
        calls.filter((argv) => ["fetch", "ls-remote", "push"].includes(argv[0])),
        [],
        `network-capable Git argv reached child process: ${JSON.stringify(calls)}`,
      );
      assert.match(result.stdout, /release evidence unverified/i);
      assert.doesNotMatch(result.stdout, /release evidence (?:verified-ineligible|probe-failed)/i);
      assert.doesNotMatch(result.stdout, /--force-delete --allow-release/);
      assert.match(result.stdout, /prune-merged-local\.mjs(?: --include-subsumed)?\s*$/m);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects local-only release dual opt-in before live proof or mutation", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      gitArgv(work, ["branch", "production", "main"]);
      gitArgv(work, ["branch", "release/local-only-delete", "main"]);
      const sentinel = await installGitNetworkSentinel(tmp);
      const result = spawnSync(
        "node",
        [pruneScript, "--local-only", "--force-delete", "--allow-release", "release/local-only-delete"],
        { cwd: work, encoding: "utf8", env: sentinel.env },
      );
      assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(result.stderr, /unverified/i);
      assert.match(result.stderr, /without `?--local-only`?|移除 --local-only/i);
      const calls = (await fs.readFile(sentinel.ledger, "utf8"))
        .trim().split("\n").filter(Boolean).map(JSON.parse);
      assert.deepEqual(
        calls.filter((argv) => ["fetch", "ls-remote", "push", "worktree"].includes(argv[0]) ||
          (argv[0] === "branch" && ["-d", "-D"].includes(argv[1]))),
        [],
      );
      assert.match(gitArgv(work, ["branch", "--list", "release/local-only-delete"]), /release\/local-only-delete/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("prune-merged-local: fresh release proof precedes mutation", () => {
  it("records live proof argv before the first destructive argv", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      gitArgv(work, ["branch", "production", "main"]);
      gitArgv(work, ["push", "-q", "-u", "origin", "production"]);
      gitArgv(work, ["branch", "release/fresh-proof", "main"]);
      const sentinel = await installGitNetworkSentinel(tmp, { blockNetwork: false });
      const result = spawnSync(
        "node",
        [pruneScript, "--force-delete", "--allow-release", "release/fresh-proof"],
        { cwd: work, encoding: "utf8", env: sentinel.env },
      );
      assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      const calls = (await fs.readFile(sentinel.ledger, "utf8"))
        .trim().split("\n").filter(Boolean).map(JSON.parse);
      const liveProof = calls.findIndex((argv) => argv[0] === "ls-remote");
      const mutation = calls.findIndex((argv) => argv[0] === "branch" && argv[1] === "-D");
      assert.ok(liveProof >= 0, JSON.stringify(calls));
      assert.ok(mutation > liveProof, JSON.stringify(calls));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("prune-merged-local: advisory never prints doomed --force-delete for release/*", () => {
  let tmp, work, dry;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());
    git(work, "checkout -q -b production");
    git(work, "push -q -u origin production");
    git(work, "checkout -q main");

    // mainline-contained abandoned local release (tip in origin/main, not production)
    git(work, "checkout -q -b release/abandoned");
    await fs.writeFile(path.join(work, "rules-abandoned.txt"), "ra\n");
    git(work, "add .");
    git(work, "commit -q -m 'release: abandoned local'");
    git(work, "checkout -q main");
    git(work, "merge -q --no-ff release/abandoned -m 'merge release into main'");
    git(work, "push -q origin main");

    // untracked release with tip nowhere (predicates fail → guidance only)
    git(work, "checkout -q -b release/wip-unmerged");
    await fs.writeFile(path.join(work, "wip-unmerged.txt"), "wip\n");
    git(work, "add .");
    git(work, "commit -q -m 'release: wip unmerged'");
    git(work, "checkout -q main");

    dry = spawnSync("node", [pruneScript], { cwd: work, encoding: "utf8" });
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("dry-run surfaces release refs without plain --force-delete release/ argv", () => {
    assert.equal(dry.status, 0, `stderr: ${dry.stderr}`);
    assert.match(dry.stdout, /release\/abandoned/);
    assert.match(dry.stdout, /release\/wip-unmerged/);
    assert.doesNotMatch(
      dry.stdout,
      /prune-merged-local\.mjs --force-delete release\//,
      "doomed single-flag --force-delete release/* must never be printed",
    );
  });

  it("prints copy-pastable --allow-release only when dry-run predicates already pass", () => {
    // A plain name is printed bare, so the same line works in every shell.
    assert.match(
      dry.stdout,
      /prune-merged-local\.mjs --force-delete --allow-release release\/abandoned$/m,
    );
    assert.doesNotMatch(
      dry.stdout,
      /prune-merged-local\.mjs --force-delete --allow-release ['"]?release\/wip-unmerged/,
    );
    assert.match(dry.stdout, /release evidence verified-ineligible/);
    assert.doesNotMatch(dry.stdout, /release evidence (?:unverified|probe-failed)/);
  });

  it("every printed prune argv passes shared shape validator", () => {
    const printed = extractPrintedPruneArgvs(dry.stdout);
    assert.ok(printed.length > 0, "expected at least one printed prune argv");
    for (const tokens of printed) {
      assert.equal(
        acceptsPrintedPruneArgv(tokens),
        true,
        `printed argv must pass validator: ${tokens.join(" ")}`,
      );
    }
  });

  it("--exec does not auto-delete advisory-bucket release/*", () => {
    const r = spawnSync("node", [pruneScript, "--exec"], { cwd: work, encoding: "utf8" });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(git(work, "branch --list release/abandoned"), /release\/abandoned/);
    assert.match(git(work, "branch --list release/wip-unmerged"), /release\/wip-unmerged/);
  });
});

describe("prune-merged-local: --force-delete --allow-release predicates", () => {
  it("plain --force-delete release/* still rejects", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      git(work, "checkout -q -b release/still-blocked");
      await fs.writeFile(path.join(work, "sb.txt"), "x\n");
      git(work, "add .");
      git(work, "commit -q -m 'wip'");
      git(work, "checkout -q main");
      const r = spawnSync("node", [pruneScript, "--force-delete", "release/still-blocked"], {
        cwd: work,
        encoding: "utf8",
      });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /受保護分支/);
      assert.match(git(work, "branch --list release/still-blocked"), /release\/still-blocked/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("allow-release success when live remotes lack same-name + no tracking + tip contained", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      git(work, "checkout -q -b production");
      git(work, "push -q -u origin production");
      git(work, "checkout -q main");
      git(work, "checkout -q -b release/rules-ok");
      await fs.writeFile(path.join(work, "ok.txt"), "ok\n");
      git(work, "add .");
      git(work, "commit -q -m 'release ok'");
      git(work, "checkout -q main");
      git(work, "merge -q --no-ff release/rules-ok -m 'merge ok'");
      git(work, "push -q origin main");

      const r = spawnSync(
        "node",
        [pruneScript, "--force-delete", "--allow-release", "release/rules-ok"],
        { cwd: work, encoding: "utf8" },
      );
      assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
      assert.match(r.stdout, /已刪除：release\/rules-ok/);
      assert.equal(git(work, "branch --list release/rules-ok"), "");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("same-name tag contained in mainline must not authorize deleting uncontained release branch tip", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      git(work, "checkout -q -b production");
      git(work, "push -q -u origin production");
      git(work, "checkout -q main");

      // Contained commit that will become the same-named tag tip.
      const containedSha = git(work, "rev-parse HEAD");
      git(work, `tag release/foo ${containedSha}`);

      // Divergent release branch tip NOT in production/main.
      git(work, "checkout -q -b release/foo");
      await fs.writeFile(path.join(work, "foo-wip.txt"), "uncontained\n");
      git(work, "add .");
      git(work, "commit -q -m 'release foo uncontained'");
      const branchTip = git(work, "rev-parse --verify refs/heads/release/foo^{commit}");
      git(work, "checkout -q main");

      // Ambiguous short name prefers the tag (contained); branch tip must stay uncontained.
      const shortNameTip = git(work, "rev-parse release/foo");
      assert.equal(shortNameTip, containedSha, "short-name rev-parse should prefer the contained tag");
      assert.notEqual(branchTip, containedSha);
      let branchContained = true;
      try {
        git(work, `merge-base --is-ancestor ${branchTip} origin/main`);
      } catch {
        branchContained = false;
      }
      assert.equal(branchContained, false, "branch tip must not be contained in origin/main");

      const dry = spawnSync("node", [pruneScript], { cwd: work, encoding: "utf8" });
      assert.equal(dry.status, 0, `stderr: ${dry.stderr}`);
      assert.doesNotMatch(
        dry.stdout,
        /prune-merged-local\.mjs --force-delete --allow-release ['"]?release\/foo['"]?/,
        "dry-run must not print allow-release when only the same-named tag is contained",
      );

      const r = spawnSync(
        "node",
        [pruneScript, "--force-delete", "--allow-release", "release/foo"],
        { cwd: work, encoding: "utf8" },
      );
      assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /allow-release 謂詞未通過|tip 不在/);
      assert.match(git(work, "branch --list release/foo"), /release\/foo/);
      assert.equal(
        git(work, "rev-parse --verify refs/heads/release/foo^{commit}"),
        branchTip,
        "uncontained release branch must remain",
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("allow-release success path still works when no conflicting same-name tag exists", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      git(work, "checkout -q -b production");
      git(work, "push -q -u origin production");
      git(work, "checkout -q main");
      git(work, "checkout -q -b release/no-tag-ok");
      await fs.writeFile(path.join(work, "ntag.txt"), "ok\n");
      git(work, "add .");
      git(work, "commit -q -m 'release no tag'");
      git(work, "checkout -q main");
      git(work, "merge -q --no-ff release/no-tag-ok -m 'merge no-tag'");
      git(work, "push -q origin main");

      // No tag named release/no-tag-ok — success must still delete the branch tip.
      assert.equal(git(work, "tag --list release/no-tag-ok"), "");

      const dry = spawnSync("node", [pruneScript], { cwd: work, encoding: "utf8" });
      assert.equal(dry.status, 0, `stderr: ${dry.stderr}`);
      assert.match(
        dry.stdout,
        /prune-merged-local\.mjs --force-delete --allow-release release\/no-tag-ok$/m,
      );

      const r = spawnSync(
        "node",
        [pruneScript, "--force-delete", "--allow-release", "release/no-tag-ok"],
        { cwd: work, encoding: "utf8" },
      );
      assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
      assert.match(r.stdout, /已刪除：release\/no-tag-ok/);
      assert.equal(git(work, "branch --list release/no-tag-ok"), "");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("(a) non-origin remote live has same-name → reject even if local remote-tracking absent", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      const otherBare = path.join(tmp, "other.git");
      execSync(`git init -q --bare "${otherBare}"`);
      git(work, `remote add other "${otherBare}"`);

      git(work, "checkout -q -b production");
      git(work, "push -q -u origin production");
      git(work, "checkout -q main");
      git(work, "checkout -q -b release/other-remote");
      await fs.writeFile(path.join(work, "or.txt"), "or\n");
      git(work, "add .");
      git(work, "commit -q -m 'release other'");
      // tip contained in mainline
      git(work, "checkout -q main");
      git(work, "merge -q --no-ff release/other-remote -m 'merge other'");
      git(work, "push -q origin main");
      // live same-name only on non-origin remote; drop any local remote-tracking for `other`
      git(work, `push -q other release/other-remote:release/other-remote`);
      try {
        git(work, "branch -dr other/release/other-remote");
      } catch {
        // already absent
      }
      assert.equal(
        git(work, "branch -r --list other/release/other-remote"),
        "",
        "local remote-tracking for other must be absent",
      );

      const r = spawnSync(
        "node",
        [pruneScript, "--force-delete", "--allow-release", "release/other-remote"],
        { cwd: work, encoding: "utf8" },
      );
      assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /allow-release 謂詞未通過|同名/);
      assert.match(git(work, "branch --list release/other-remote"), /release\/other-remote/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("(b) unreachable remote makes ls-remote fail → reject fail-closed", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      git(work, "checkout -q -b production");
      git(work, "push -q -u origin production");
      git(work, "checkout -q main");
      git(work, "checkout -q -b release/ls-fail");
      await fs.writeFile(path.join(work, "lf.txt"), "lf\n");
      git(work, "add .");
      git(work, "commit -q -m 'release ls-fail'");
      git(work, "checkout -q main");
      git(work, "merge -q --no-ff release/ls-fail -m 'merge ls-fail'");
      git(work, "push -q origin main");
      git(work, "remote add broken https://127.0.0.1:1/no-such-repo.git");

      const r = spawnSync(
        "node",
        [pruneScript, "--force-delete", "--allow-release", "release/ls-fail"],
        { cwd: work, encoding: "utf8" },
      );
      assert.equal(r.status, 1);
      assert.match(r.stderr, /allow-release 謂詞未通過|live 探測失敗|fail-closed/);
      assert.match(git(work, "branch --list release/ls-fail"), /release\/ls-fail/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("option-like remote name is not interpreted as git option; allow-release fail-closed", { skip: process.platform === "win32" ? "the fixture remote name embeds an absolute path, and a drive-letter path is not a valid Git remote name" : false }, async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      git(work, "checkout -q -b production");
      git(work, "push -q -u origin production");
      git(work, "checkout -q main");
      git(work, "checkout -q -b release/opt-remote");
      await fs.writeFile(path.join(work, "or-opt.txt"), "or\n");
      git(work, "add .");
      git(work, "commit -q -m 'release opt-remote'");
      git(work, "checkout -q main");
      git(work, "merge -q --no-ff release/opt-remote -m 'merge opt-remote'");
      git(work, "push -q origin main");

      // Without end-of-options / leading-dash reject, this remote NAME would be
      // parsed as `git ls-remote --heads --upload-pack=<script> …` and execute it.
      const marker = path.join(tmp, "upload-pack-invoked");
      const evilUploadPack = path.join(tmp, "evil-upload-pack.sh");
      await fs.writeFile(
        evilUploadPack,
        ["#!/bin/sh", `touch ${JSON.stringify(marker)}`, "exit 1", ""].join("\n"),
      );
      await fs.chmod(evilUploadPack, 0o755);
      const optionLikeRemote = `--upload-pack=${evilUploadPack}`;
      git(work, `remote add -- "${optionLikeRemote}" "${path.join(tmp, "nowhere.git")}"`);
      assert.match(git(work, "remote"), /--upload-pack=/);

      const src = await fs.readFile(pruneScript, "utf8");
      assert.match(
        src,
        /\['ls-remote', '--heads', '--', remote, wantRef\]/,
        "liveRemoteSameNameCheck must pass remotes after end-of-options `--`",
      );
      assert.match(
        src,
        /remote\.startsWith\('-'\)/,
        "liveRemoteSameNameCheck must fail-closed on option-like remote names",
      );

      const r = spawnSync(
        "node",
        [pruneScript, "--force-delete", "--allow-release", "release/opt-remote"],
        { cwd: work, encoding: "utf8" },
      );
      assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(
        r.stderr,
        /allow-release 謂詞未通過|option-like remote|live 探測失敗|fail-closed/,
      );
      assert.match(git(work, "branch --list release/opt-remote"), /release\/opt-remote/);
      await assert.rejects(
        () => fs.access(marker),
        (err) => err && err.code === "ENOENT",
        "upload-pack must not have been executed",
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("(d) local remote-tracking absent but live origin has same-name → reject (false-green guard)", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      git(work, "checkout -q -b production");
      git(work, "push -q -u origin production");
      git(work, "checkout -q main");
      git(work, "checkout -q -b release/live-present");
      await fs.writeFile(path.join(work, "lp.txt"), "lp\n");
      git(work, "add .");
      git(work, "commit -q -m 'release live'");
      git(work, "checkout -q main");
      git(work, "merge -q --no-ff release/live-present -m 'merge live'");
      git(work, "push -q origin main");
      // push branch to origin without -u, then drop local remote-tracking
      git(work, "push -q origin release/live-present:release/live-present");
      git(work, "branch -dr origin/release/live-present");
      assert.equal(
        git(work, "branch -r --list origin/release/live-present"),
        "",
        "local remote-tracking must be absent",
      );

      const r = spawnSync(
        "node",
        [pruneScript, "--force-delete", "--allow-release", "release/live-present"],
        { cwd: work, encoding: "utf8" },
      );
      assert.equal(r.status, 1);
      assert.match(r.stderr, /allow-release 謂詞未通過|同名/);
      assert.match(git(work, "branch --list release/live-present"), /release\/live-present/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("--allow-release on non-release target rejects", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      git(work, "checkout -q -b chore/not-release");
      await fs.writeFile(path.join(work, "nr.txt"), "nr\n");
      git(work, "add .");
      git(work, "commit -q -m 'chore'");
      git(work, "checkout -q main");
      const r = spawnSync(
        "node",
        [pruneScript, "--force-delete", "--allow-release", "chore/not-release"],
        { cwd: work, encoding: "utf8" },
      );
      assert.equal(r.status, 1);
      assert.match(r.stderr, /僅適用於 release\//);
      assert.match(git(work, "branch --list chore/not-release"), /chore\/not-release/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects allow-release when tracking remote is non-origin (not only origin)", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      const otherBare = path.join(tmp, "other.git");
      execSync(`git init -q --bare "${otherBare}"`);
      git(work, `remote add other "${otherBare}"`);

      git(work, "checkout -q -b production");
      git(work, "push -q -u origin production");
      git(work, "checkout -q main");
      git(work, "checkout -q -b release/track-other");
      await fs.writeFile(path.join(work, "to.txt"), "to\n");
      git(work, "add .");
      git(work, "commit -q -m 'release track-other'");
      git(work, "checkout -q main");
      git(work, "merge -q --no-ff release/track-other -m 'merge track-other'");
      git(work, "push -q origin main");
      // Tracking points at `other`, but other has no same-name heads ref.
      git(work, "config branch.release/track-other.remote other");
      git(work, "config branch.release/track-other.merge refs/heads/release/track-other");
      assert.equal(git(work, "config --get branch.release/track-other.remote"), "other");

      const r = spawnSync(
        "node",
        [pruneScript, "--force-delete", "--allow-release", "release/track-other"],
        { cwd: work, encoding: "utf8" },
      );
      assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /allow-release 謂詞未通過|remote tracking/);
      assert.match(git(work, "branch --list release/track-other"), /release\/track-other/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects allow-release when tracking remote is '.'", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      git(work, "checkout -q -b production");
      git(work, "push -q -u origin production");
      git(work, "checkout -q main");
      git(work, "checkout -q -b release/track-dot");
      await fs.writeFile(path.join(work, "td.txt"), "td\n");
      git(work, "add .");
      git(work, "commit -q -m 'release track-dot'");
      git(work, "checkout -q main");
      git(work, "merge -q --no-ff release/track-dot -m 'merge track-dot'");
      git(work, "push -q origin main");
      git(work, "config branch.release/track-dot.remote .");
      git(work, "config branch.release/track-dot.merge refs/heads/release/track-dot");
      assert.equal(git(work, "config --get branch.release/track-dot.remote"), ".");

      const r = spawnSync(
        "node",
        [pruneScript, "--force-delete", "--allow-release", "release/track-dot"],
        { cwd: work, encoding: "utf8" },
      );
      assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /allow-release 謂詞未通過|remote tracking/);
      assert.match(git(work, "branch --list release/track-dot"), /release\/track-dot/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects allow-release when tracking config probe fails (fail-closed, not empty-map)", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      git(work, "checkout -q -b production");
      git(work, "push -q -u origin production");
      git(work, "checkout -q main");
      git(work, "checkout -q -b release/track-probe-fail");
      await fs.writeFile(path.join(work, "tpf.txt"), "tpf\n");
      git(work, "add .");
      git(work, "commit -q -m 'release track-probe-fail'");
      git(work, "checkout -q main");
      git(work, "merge -q --no-ff release/track-probe-fail -m 'merge track-probe-fail'");
      git(work, "push -q origin main");

      const fakeBin = path.join(tmp, "fake-bin");
      await fs.mkdir(fakeBin);
      // A Node script, not a shell wrapper: on Windows a shell wrapper runs under Git Bash, which rewrites
      // some of the arguments it forwards.
      const fakeGit = path.join(fakeBin, "git");
      await fs.writeFile(
        fakeGit,
        `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "config" && args.includes("--get-regexp")) {
  process.stderr.write("fixture tracking config probe failed\\n");
  process.exit(128);
}
const result = spawnSync(process.env.DEVPRO_REAL_GIT, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
      );
      await fs.chmod(fakeGit, 0o755);

      const r = spawnSync(
        process.execPath,
        [pruneScript, "--force-delete", "--allow-release", "release/track-probe-fail"],
        {
          cwd: work,
          encoding: "utf8",
          env: {
            ...process.env,
            DEVPRO_REAL_GIT: resolveExecutable("git"),
            PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
          },
        },
      );
      assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(
        r.stderr,
        /allow-release 謂詞未通過|tracking.*探測失敗|fail-closed|config probe/i,
      );
      assert.match(r.stderr, /--allow-release evidence probe-failed/);
      assert.doesNotMatch(r.stderr, /--allow-release evidence (?:failed|verified-ineligible)/);
      assert.match(
        git(work, "branch --list release/track-probe-fail"),
        /release\/track-probe-fail/,
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects --allow-release outside --force-delete (scan/keep modes)", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      const scan = spawnSync("node", [pruneScript, "--allow-release"], {
        cwd: work,
        encoding: "utf8",
      });
      assert.equal(scan.status, 1, `stdout: ${scan.stdout}\nstderr: ${scan.stderr}`);
      assert.match(scan.stderr, /--allow-release/);
      assert.match(scan.stderr, /--force-delete/);

      const keepList = spawnSync("node", [pruneScript, "--keep-list", "--allow-release"], {
        cwd: work,
        encoding: "utf8",
      });
      assert.equal(keepList.status, 1, `stdout: ${keepList.stdout}\nstderr: ${keepList.stderr}`);
      assert.match(keepList.stderr, /--allow-release/);
      assert.match(keepList.stderr, /--force-delete/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("shell-quotes metacharacter branch names in executable force-delete advisory lines", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      git(work, "tag production-v1.0.0");
      git(work, "branch -f production");
      const branch = "chore/meta$(id)";
      // Argv-form: POSIX-quoted shell strings are not portable on Windows cmd.exe.
      gitArgv(work, ["checkout", "-q", "-b", branch]);
      await fs.writeFile(path.join(work, "meta.txt"), "meta\n");
      git(work, "add .");
      git(work, "commit -q -m 'chore meta'");
      git(work, "checkout -q main");

      const dry = spawnSync("node", [pruneScript], { cwd: work, encoding: "utf8" });
      assert.equal(dry.status, 0, `stderr: ${dry.stderr}`);
      assert.doesNotMatch(
        dry.stdout,
        /prune-merged-local\.mjs --force-delete chore\/meta\$\(id\)(?!['"])/,
        "unquoted metacharacter branch must not appear as executable argv",
      );
      const expectedArg = advisoryBranchArg(branch);
      if (expectedArg === null) {
        // Windows: no single spelling works in every shell, so only the name is printed.
        assert.match(dry.stdout, /分支名含 shell 特殊字元：依你的 shell 為分支名加引號，再以 --force-delete 執行 prune-merged-local\.mjs/);
        assert.ok(!extractPrintedPruneArgvs(dry.stdout).some((tokens) => tokens.includes(branch)));
        return;
      }
      assert.ok(
        dry.stdout.includes(`prune-merged-local.mjs --force-delete ${expectedArg}`),
        "executable advisory must POSIX-quote metacharacter branch names",
      );
      const printed = extractPrintedPruneArgvs(dry.stdout);
      const metaLine = printed.find((tokens) => tokens.includes(branch));
      assert.ok(metaLine, "expected printed force-delete argv for metachar branch");
      assert.equal(acceptsPrintedPruneArgv(metaLine), true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
