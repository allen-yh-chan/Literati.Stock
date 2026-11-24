/**
 * hook-release-back-merge-check.test.mjs
 *
 * Behaviour tests for the release back-merge completion mechanism
 * (openspec change enforce-release-back-merge-completion):
 *   pre-push ledger  ->  PostToolUse binding (post-tool-gate.mjs)
 *                    ->  Stop gate (release-back-merge-check.mjs)
 *
 * Fixture: a bare origin, clone A (core.hooksPath -> this repo's hooks-git, the
 * conversation's clone) and clone B (only used to merge production into main on
 * the origin). Real `git push` runs the real pre-push hook; PostToolUse and Stop
 * payloads are fed to the real hook scripts as child processes, in the Codex
 * shape (plain-text tool_response, no exit_code; Stop carries
 * last_assistant_message / stop_hook_active) and the Claude Code shape (object
 * tool_response; Stop carries only transcript_path in the real nested
 * `message.role` form).
 *
 * Every spec scenario title is a test name: `Scenario: <title>`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";
import { envWithoutHostMarkers } from "./lib/host-session-env.mjs";

const HOOKS_GIT_DIR = repoPath(".devpro/scripts/hooks-git");
const PRE_PUSH_JS = repoPath(".devpro/scripts/hooks-git/pre-push.mjs");
const POST_TOOL = repoPath(".devpro/scripts/hooks/post-tool-gate.mjs");
const STOP_HOOK = repoPath(".devpro/scripts/hooks/release-back-merge-check.mjs");
const STATE_LIB = repoPath(".devpro/scripts/hooks/lib/release-back-merge-state.mjs");
const RUN_HOOK = repoPath(".devpro/scripts/hooks/run-hook.mjs");

const TAG = "production-v6.98.0";
const TAG2 = "production-v6.99.0";
const ZERO_SHA = "0".repeat(40);
const NO_SHIM = process.platform === "win32" ? "POSIX shell shim is not available on win32" : false;
const NO_HOOK_EXEC = process.platform === "win32" ? "bare-repo hook files need POSIX modes" : false;

const roots = [];
process.on("exit", () => {
  for (const dir of roots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

// ── git / env helpers ──────────────────────────────────────────────────────

function baseEnv(extra = {}) {
  const env = envWithoutHostMarkers(process.env);
  for (const key of [
    "DEVPRO_AGENT_RULES_LEVEL",
    "DEVPRO_HOOK_BYPASS",
    "DEVPRO_RELEASE_BACK_MERGE_STATE_DIR",
    "DEVPRO_RELEASE_BACK_MERGE_BUDGET_MS",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_SSH_COMMAND",
  ]) {
    delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    // Git for Windows accepts its POSIX null path, not Node's device namespace.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    ...extra,
  };
}

function git(cwd, args, env = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: baseEnv(env) });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return (result.stdout || "").trim();
}

function tryGit(cwd, args, env = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: baseEnv(env) });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function writeCommit(cwd, file, message) {
  writeFileSync(path.join(cwd, file), `${message}\n`);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/**
 * Fixture: bare origin seeded with `main`, clone A (conversation clone, with the
 * pre-push hook unless `hooks:false`), clone B (merges production on the origin).
 * Clone A carries one local commit P (not on origin main) tagged `TAG`; P is
 * already on origin production (as a production PR merge would leave it), so the
 * pre-push production tag ancestry check accepts the tag.
 */
function makeFixture({ hooks = true, isolatedState = false } = {}) {
  const root = makeTempDir("rbmfx-");
  roots.push(root);
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const a = path.join(root, "a");
  const b = path.join(root, "b");
  const stateDir = path.join(root, "state");
  git(root, ["init", "-q", "--bare", "-b", "main", origin]);
  mkdirSync(seed);
  git(seed, ["init", "-q", "-b", "main"]);
  writeCommit(seed, "README.md", "seed");
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "-q", "origin", "main"]);
  git(root, ["clone", "-q", origin, a]);
  git(root, ["clone", "-q", origin, b]);
  if (hooks) git(a, ["config", "core.hooksPath", HOOKS_GIT_DIR]);
  const releaseSha = writeCommit(a, "release.txt", "release content");
  git(a, ["tag", "-a", "-m", "release", TAG, releaseSha]);
  const fx = { root, origin, a, b, stateDir, releaseSha, shimDir: null };
  shipToProduction(fx, releaseSha);
  fx.env = (extra = {}) => baseEnv({ DEVPRO_RELEASE_BACK_MERGE_STATE_DIR: stateDir, ...extra });
  if (isolatedState) {
    // No state-dir override: every repo derives its own state directory, as in real use.
    fx.stateDir = derivedStateDir(a);
    fx.env = (extra = {}) => baseEnv(extra);
  }
  return fx;
}

/** Put SHA on origin production and refresh clone A's tracking ref (fixture setup, not under test). */
function shipToProduction(fx, sha) {
  git(fx.a, ["push", "--no-verify", "-q", "--force", "origin", `${sha}:refs/heads/production`]);
  git(fx.a, ["fetch", "-q", "origin"]);
}

/** The state directory a repo derives for itself (no env override). */
function derivedStateDir(repoRoot) {
  return path.join(realpathSync(repoRoot), "notes", "tmp", "state", "devpro-release-back-merge");
}

/** A plain repo where "the conversation started" (not the repo that gets pushed). */
function makeSessionRepo(fx) {
  const session = path.join(fx.root, "session");
  mkdirSync(session);
  git(session, ["init", "-q", "-b", "main"]);
  writeCommit(session, "s.txt", "session start");
  return { dir: session, stateDir: derivedStateDir(session) };
}

function pushTag(fx, tag = TAG, { remote = "origin", extraArgs = [], env = {} } = {}) {
  return spawnSync("git", ["push", ...extraArgs, remote, tag], {
    cwd: fx.a,
    encoding: "utf8",
    env: fx.env(env),
    timeout: 60_000,
  });
}

/** Clone B merges the production tag into main on the origin. */
function mergeProductionOnOrigin(fx, tag = TAG) {
  git(fx.b, ["fetch", "-q", "--no-tags", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
  git(fx.b, ["merge", "-q", "--no-ff", "-m", "back-merge production", tag]);
  git(fx.b, ["push", "-q", "origin", "main"]);
}

function originMainSha(fx) {
  return git(fx.origin, ["rev-parse", "refs/heads/main"]);
}

// ── state-dir readers ──────────────────────────────────────────────────────

function filesWithPrefix(fx, prefix) {
  if (!existsSync(fx.stateDir)) return [];
  return readdirSync(fx.stateDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => path.join(fx.stateDir, name));
}
const ledgerFiles = (fx) => filesWithPrefix(fx, "pushed-");
const pendingFiles = (fx) => filesWithPrefix(fx, "pending-");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const ledgers = (fx) => ledgerFiles(fx).map(readJson);
const pendings = (fx) => pendingFiles(fx).map(readJson);
function trace(fx) {
  const file = path.join(fx.stateDir, "trace.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
const traceReasons = (fx) => trace(fx).map((entry) => entry.reason);
const candidateTags = (fx) => pendings(fx).flatMap((p) => p.candidates.map((c) => c.tag));

// ── hook runners ───────────────────────────────────────────────────────────

function postToolPayload(shape, { command, sessionId, cwd, exitCode = 0 }) {
  const common = {
    session_id: sessionId,
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command },
  };
  if (shape === "codex") {
    return {
      ...common,
      turn_id: "turn-1",
      transcript_path: null,
      model: "gpt-test",
      permission_mode: "default",
      tool_response: "To origin.git\n * [new tag]         production -> production\n",
      tool_use_id: "call-1",
    };
  }
  return {
    ...common,
    tool_response: { stdout: "pushed", stderr: "", interrupted: false, exit_code: exitCode },
  };
}

function runPostTool(fx, shape, { command, sessionId = "sess-A", env = {}, cwd = fx.a, exitCode, viaWrapper = false } = {}) {
  const payload = postToolPayload(shape, { command, sessionId, cwd, exitCode });
  if (sessionId === null) delete payload.session_id;
  const args = viaWrapper ? [RUN_HOOK, "PostToolUse", POST_TOOL, "--host=codex"] : [POST_TOOL];
  const result = spawnSync(process.execPath, args, {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: fx.env(env),
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function transcriptWith(fx, text) {
  const file = path.join(fx.root, `transcript-${Math.random().toString(16).slice(2)}.jsonl`);
  const lines = [
    { type: "user", message: { role: "user", content: "release it" } },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git push" } }] },
    },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } },
  ];
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

function stopPayload(fx, shape, { sessionId = "sess-A", message = "done", stopHookActive = false, cwd = fx.a } = {}) {
  if (shape === "codex") {
    return {
      session_id: sessionId,
      turn_id: "turn-2",
      transcript_path: null,
      cwd,
      hook_event_name: "Stop",
      model: "gpt-test",
      permission_mode: "default",
      stop_hook_active: stopHookActive,
      last_assistant_message: message,
    };
  }
  return {
    session_id: sessionId,
    transcript_path: transcriptWith(fx, message),
    cwd,
    hook_event_name: "Stop",
    stop_hook_active: stopHookActive,
  };
}

function parseJsonLine(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * A block is `{"decision":"block","reason"}` on stdout with exit 0. Measured on real hosts
 * (Codex 0.159.3, Claude Code 2.1.287): both continue the turn for exit 0 + JSON, also
 * through the run-hook wrapper; Codex ignores exit 2 or exit 1 with only a stdout JSON.
 */
function assertBlocked(result, message = "") {
  assert.equal(result.status, 0, `${message} stderr=${result.stderr}`);
  assert.equal(result.json?.decision, "block", `${message} stdout=${result.stdout}`);
  assert.ok(String(result.json?.reason ?? "").length > 0, `${message} block reason present`);
}

/** Not blocked: exit 0 and no `decision:"block"` on stdout (a systemMessage-only reminder is a release). */
function assertReleased(result, message = "") {
  assert.equal(result.status, 0, `${message} stderr=${result.stderr}`);
  assert.notEqual(result.json?.decision, "block", `${message} stdout=${result.stdout}`);
}

function runStop(fx, shape, opts = {}) {
  const { env = {}, rawPayload, timeoutMs = 120_000, viaRunner = null } = opts;
  const payload = rawPayload ?? stopPayload(fx, shape, opts);
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const args = viaRunner
    ? [RUN_HOOK, viaRunner.event, ".devpro/scripts/hooks/release-back-merge-check.mjs", `--host=${viaRunner.host}`]
    : [STOP_HOOK];
  const started = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: opts.cwd ?? fx.a,
    input,
    encoding: "utf8",
    env: fx.env(env),
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    json: parseJsonLine(result.stdout || ""),
    elapsedMs: Date.now() - started,
  };
}

/** Push TAG (real pre-push) and bind it to `sessionId` through PostToolUse. */
function pushAndBind(fx, shape, { sessionId = "sess-A", tag = TAG, remote = "origin", command } = {}) {
  const push = pushTag(fx, tag, { remote });
  assert.equal(push.status, 0, `git push failed: ${push.stderr}`);
  const bound = runPostTool(fx, shape, { command: command ?? `git push ${remote} ${tag}`, sessionId });
  assert.equal(bound.status, 0, bound.stderr);
  assert.equal(bound.stdout, "");
  return bound;
}

/** A `git` shim on PATH: logs ls-remote/fetch, can slow ls-remote, can fail fetch. */
function installGitShim(fx) {
  if (fx.shimDir) return fx.shimDir;
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const shimDir = path.join(fx.root, "shim");
  mkdirSync(shimDir);
  const script = [
    "#!/bin/sh",
    'for a in "$@"; do',
    '  case "$a" in',
    "    ls-remote)",
    '      [ -n "$SHIM_LOG" ] && echo ls-remote >> "$SHIM_LOG"',
    '      [ -n "$SHIM_LS_SLEEP" ] && exec sleep "$SHIM_LS_SLEEP"',
    "      ;;",
    "    fetch)",
    '      [ -n "$SHIM_LOG" ] && echo fetch >> "$SHIM_LOG"',
    '      if [ -n "$SHIM_FETCH_FAIL" ]; then echo "shim: fetch failed" >&2; exit 128; fi',
    "      ;;",
    "  esac",
    "done",
    `exec "${realGit}" "$@"`,
    "",
  ].join("\n");
  const shimPath = path.join(shimDir, "git");
  writeFileSync(shimPath, script);
  chmodSync(shimPath, 0o755);
  fx.shimDir = shimDir;
  fx.shimLog = path.join(fx.root, "shim.log");
  return shimDir;
}
const shimEnv = (fx, extra = {}) => ({
  PATH: `${installGitShim(fx)}${path.delimiter}${process.env.PATH}`,
  SHIM_LOG: fx.shimLog,
  ...extra,
});
const shimLog = (fx) => (fx.shimLog && existsSync(fx.shimLog) ? readFileSync(fx.shimLog, "utf8").trim().split("\n") : []);

const BACK_MERGE_HANDOFF = [
  "Back-merge 還沒做：production 要合回 main，需要你核准。",
  "為什麼停：合進 main 是 Ask First。",
  "要你做什麼（回數字）：",
  "1. 是，我開 PR 完成 Step 6A",
  "2. 否，先停著",
  "3. 其他",
].join("\n");

const SHAPES = ["codex", "claude"];

// ── R1: pre-push ledger ───────────────────────────────────────────────────

test("Scenario: Pre-push records created or updated production tags only", () => {
  const fx = makeFixture();
  git(fx.a, ["tag", "-a", "-m", "not production", "v1.0.0", fx.releaseSha]);
  git(fx.a, ["checkout", "-q", "-b", "feature/x"]);
  const push = spawnSync("git", ["push", "origin", TAG, "v1.0.0", "feature/x"], {
    cwd: fx.a,
    encoding: "utf8",
    env: fx.env(),
  });
  assert.equal(push.status, 0, push.stderr);
  assert.equal(push.stdout, "", "recording must not add stdout");
  assert.doesNotMatch(push.stderr, /pre-push|release-back-merge|ledger/i, "recording must not add stderr");

  const entries = ledgers(fx);
  assert.equal(entries.length, 1, "one ledger entry for the push");
  const [entry] = entries;
  assert.equal(entry.schema, "devpro-release-back-merge-push/v1");
  assert.equal(entry.remote, "origin");
  assert.deepEqual(
    entry.refs.map((r) => r.tag),
    [TAG],
    "only the production tag is listed (not v1.0.0, not the branch)",
  );
  assert.equal(entry.refs[0].local_sha, git(fx.a, ["rev-parse", TAG]));
  assert.equal(entry.refs[0].remote_old_sha, ZERO_SHA);
  assert.ok(Number.isFinite(Date.parse(entry.created_at)));

  // Updated tag: force-move the tag, remote_old_sha is the previous origin value.
  const previous = entry.refs[0].local_sha;
  const newer = writeCommit(fx.a, "release2.txt", "second release");
  shipToProduction(fx, newer);
  git(fx.a, ["tag", "-f", "-a", "-m", "release2", TAG, newer]);
  const forced = spawnSync("git", ["push", "--force", "origin", TAG], { cwd: fx.a, encoding: "utf8", env: fx.env() });
  assert.equal(forced.status, 0, forced.stderr);
  const updated = ledgers(fx).find((l) => l.refs[0].remote_old_sha === previous);
  assert.ok(updated, "updated tag entry carries the old remote SHA");
  assert.equal(updated.refs[0].local_sha, git(fx.a, ["rev-parse", TAG]));
});

test("Scenario: Push of unchanged old tags writes no ledger entry", () => {
  const fx = makeFixture();
  assert.equal(pushTag(fx).status, 0);
  for (const file of ledgerFiles(fx)) rmSync(file);

  git(fx.a, ["tag", "-a", "-m", "next", TAG2, fx.releaseSha]);
  const all = spawnSync("git", ["push", "origin", "--tags"], { cwd: fx.a, encoding: "utf8", env: fx.env() });
  assert.equal(all.status, 0, all.stderr);
  const named = ledgers(fx).flatMap((l) => l.refs.map((r) => r.tag));
  assert.deepEqual(named, [TAG2], "--tags must list only the tag git actually sends, not the unchanged old one");

  for (const file of ledgerFiles(fx)) rmSync(file);
  const again = pushTag(fx, TAG);
  assert.equal(again.status, 0);
  assert.equal(ledgerFiles(fx).length, 0, "an explicit push of an unchanged tag writes no ledger entry");
  const allAgain = spawnSync("git", ["push", "origin", "--tags"], { cwd: fx.a, encoding: "utf8", env: fx.env() });
  assert.equal(allAgain.status, 0);
  assert.equal(ledgerFiles(fx).length, 0, "--tags with nothing changed writes no ledger entry");
});

test("Scenario: Ordinary push stays silent", () => {
  const fx = makeFixture();
  git(fx.a, ["checkout", "-q", "-b", "feature/y"]);
  writeCommit(fx.a, "y.txt", "y");
  const push = spawnSync("git", ["push", "origin", "feature/y"], { cwd: fx.a, encoding: "utf8", env: fx.env() });
  assert.equal(push.status, 0, push.stderr);
  assert.doesNotMatch(push.stderr, /pre-push|release-back-merge|ledger/i);
  assert.equal(ledgerFiles(fx).length, 0);

  // Direct hook run: exit zero, no output at all, nothing written.
  const direct = spawnSync(process.execPath, [PRE_PUSH_JS, "origin", "file:///x"], {
    input: `refs/heads/feature/y ${fx.releaseSha} refs/heads/feature/y ${ZERO_SHA}\n`,
    encoding: "utf8",
    env: fx.env(),
  });
  assert.equal(direct.status, 0);
  assert.equal(direct.stdout, "");
  assert.equal(direct.stderr, "");
  assert.equal(existsSync(fx.stateDir), false, "no state directory is created for an ordinary push");
});

test("Scenario: Recorder failure never blocks a push", () => {
  // Run inside clone A with its real release commit so the ancestry check passes
  // and only the recorder failure is under test.
  const fx = makeFixture();
  const stdin = `refs/tags/${TAG} ${fx.releaseSha} refs/tags/${TAG} ${ZERO_SHA}\n`;

  // (a) recorder module missing: a copy of pre-push.mjs with no sibling lib.
  const lone = makeTempDir("rbmnolib-");
  roots.push(lone);
  mkdirSync(path.join(lone, "hooks-git"));
  copyFileSync(PRE_PUSH_JS, path.join(lone, "hooks-git", "pre-push.mjs"));
  const missing = spawnSync(process.execPath, [path.join(lone, "hooks-git", "pre-push.mjs"), "origin", "x"], {
    cwd: fx.a,
    input: stdin,
    encoding: "utf8",
    env: baseEnv({ DEVPRO_RELEASE_BACK_MERGE_STATE_DIR: path.join(lone, "state") }),
  });
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.stdout, "");
  assert.equal(missing.stderr, "");

  // (b) recorder module throws while loading.
  const broken = makeTempDir("rbmbroken-");
  roots.push(broken);
  mkdirSync(path.join(broken, "hooks-git"));
  mkdirSync(path.join(broken, "hooks", "lib"), { recursive: true });
  copyFileSync(PRE_PUSH_JS, path.join(broken, "hooks-git", "pre-push.mjs"));
  writeFileSync(path.join(broken, "hooks", "lib", "release-back-merge-state.mjs"), 'throw new Error("boom");\n');
  const loadFail = spawnSync(process.execPath, [path.join(broken, "hooks-git", "pre-push.mjs"), "origin", "x"], {
    cwd: fx.a,
    input: stdin,
    encoding: "utf8",
    env: baseEnv({ DEVPRO_RELEASE_BACK_MERGE_STATE_DIR: path.join(broken, "state") }),
  });
  assert.equal(loadFail.status, 0, loadFail.stderr);
  assert.equal(loadFail.stdout, "");
  assert.equal(loadFail.stderr, "");

  // (c) state dir cannot be created (its parent is a regular file); real git push.
  const blocker = path.join(fx.root, "not-a-dir");
  writeFileSync(blocker, "file");
  const push = spawnSync("git", ["push", "origin", TAG], {
    cwd: fx.a,
    encoding: "utf8",
    env: fx.env({ DEVPRO_RELEASE_BACK_MERGE_STATE_DIR: path.join(blocker, "sub") }),
  });
  assert.equal(push.status, 0, push.stderr);
  assert.equal(push.stdout, "");
  assert.doesNotMatch(push.stderr, /pre-push|release-back-merge|ledger|ENOTDIR/i);
  assert.equal(git(fx.origin, ["rev-parse", `refs/tags/${TAG}`]), git(fx.a, ["rev-parse", TAG]), "the push itself still happened");
});

test("pre-push writes no ledger at rigor level off, and keeps its protected-branch rejection", () => {
  const fx = makeFixture();
  const off = pushTag(fx, TAG, { env: { DEVPRO_AGENT_RULES_LEVEL: "off" } });
  assert.equal(off.status, 0, off.stderr);
  assert.equal(ledgerFiles(fx).length, 0);

  const protectedPush = spawnSync(process.execPath, [PRE_PUSH_JS, "origin", "x"], {
    input: `refs/heads/main ${fx.releaseSha} refs/heads/main ${ZERO_SHA}\nrefs/tags/${TAG} ${fx.releaseSha} refs/tags/${TAG} ${ZERO_SHA}\n`,
    encoding: "utf8",
    env: fx.env(),
  });
  assert.equal(protectedPush.status, 1);
  assert.equal(ledgerFiles(fx).length, 0, "a rejected push records nothing");
});

test("pre-push ignores a malformed production tag name and a tag deletion", () => {
  const fx = makeFixture();
  const lines = [
    `refs/tags/production-bad ${fx.releaseSha} refs/tags/production-bad ${ZERO_SHA}`,
    `refs/tags/production-v1.2 ${fx.releaseSha} refs/tags/production-v1.2 ${ZERO_SHA}`,
    `(delete) ${ZERO_SHA} refs/tags/${TAG} ${fx.releaseSha}`,
    `refs/heads/production-v6.98.0 ${fx.releaseSha} refs/heads/production-v6.98.0 ${ZERO_SHA}`,
  ];
  const direct = spawnSync(process.execPath, [PRE_PUSH_JS, "origin", "x"], {
    cwd: fx.a,
    input: lines.join("\n") + "\n",
    encoding: "utf8",
    env: fx.env(),
  });
  assert.equal(direct.status, 1, "the deletion line is still rejected by the existing guard");
  const ok = spawnSync(process.execPath, [PRE_PUSH_JS, "origin", "x"], {
    cwd: fx.a,
    input: lines.filter((line) => !line.startsWith("(delete)")).join("\n") + "\n",
    encoding: "utf8",
    env: fx.env(),
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ledgerFiles(fx).length, 0, "only valid production-* tag refs are recorded");
});

// ── R2: PostToolUse binding ───────────────────────────────────────────────

test("Scenario: Binding happens only at a push call", () => {
  for (const shape of SHAPES) {
    const fx = makeFixture();
    assert.equal(pushTag(fx).status, 0);
    assert.equal(ledgerFiles(fx).length, 1);

    for (const command of ["git status", `echo "git push origin ${TAG}"`, `git log --oneline # git push`]) {
      const result = runPostTool(fx, shape, { command });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(pendingFiles(fx).length, 0, `${shape}: "${command}" must not claim the ledger`);
      assert.equal(ledgerFiles(fx).length, 1, `${shape}: ledger stays unclaimed`);
    }
    const stop = runStop(fx, shape);
    assertReleased(stop, `${shape}: a conversation that never pushed is not blocked`);
    assert.equal(stop.stdout, "");
  }
});

test("Scenario: PostToolUse records without judging success", () => {
  for (const shape of SHAPES) {
    const fx = makeFixture();
    assert.equal(pushTag(fx).status, 0);
    const sha = git(fx.a, ["rev-parse", TAG]);
    // Claude shape carries exit_code 1: it must still bind (success is judged at Stop).
    const result = runPostTool(fx, shape, { command: `git push origin ${TAG}`, exitCode: 1 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");

    assert.equal(ledgerFiles(fx).length, 0, "the ledger entry is consumed by the claim");
    const records = pendings(fx);
    assert.equal(records.length, 1);
    assert.equal(records[0].schema, "devpro-release-back-merge-pending/v1");
    assert.equal(records[0].session_id, "sess-A");
    assert.deepEqual(records[0].candidates, [{ tag: TAG, remote: "origin", expected_sha: sha }]);
    assert.equal(records[0].blocks.count, 0);
    assert.equal(records[0].deferred, null);
    assert.ok(Number.isFinite(Date.parse(records[0].recorded_at)));
    assert.ok(traceReasons(fx).includes("recorded") || trace(fx).some((e) => e.event === "recorded"));
    assert.ok(
      !JSON.stringify(trace(fx)).includes("sess-A"),
      "the trace stores a hashed session key, never the raw session id",
    );
  }
});

test("a compound push command with a leading cd and env prefix still binds", () => {
  const fx = makeFixture();
  assert.equal(pushTag(fx).status, 0);
  const result = runPostTool(fx, "codex", { command: `cd ${fx.a} && GIT_TERMINAL_PROMPT=0 git -c color.ui=never push origin ${TAG}` });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(candidateTags(fx), [TAG]);
});

test("binding respects the 10 minute window, the session hint and a missing session id", () => {
  // Older than 10 minutes: not claimed.
  const stale = makeFixture();
  assert.equal(pushTag(stale).status, 0);
  const [file] = ledgerFiles(stale);
  const entry = readJson(file);
  entry.created_at = new Date(Date.now() - 11 * 60_000).toISOString();
  writeFileSync(file, JSON.stringify(entry));
  runPostTool(stale, "codex", { command: `git push origin ${TAG}` });
  assert.equal(pendingFiles(stale).length, 0);
  assert.equal(ledgerFiles(stale).length, 1);

  // Ledger hinted at another conversation: not claimed. Hinted at this one: claimed.
  const hinted = makeFixture();
  assert.equal(pushTag(hinted, TAG, { env: { CODEX_THREAD_ID: "other-thread" } }).status, 0);
  assert.equal(ledgers(hinted)[0].session_hint, "other-thread");
  runPostTool(hinted, "codex", { command: `git push origin ${TAG}`, sessionId: "sess-A" });
  assert.equal(pendingFiles(hinted).length, 0, "another conversation's ledger is not claimed");
  runPostTool(hinted, "codex", { command: `git push origin ${TAG}`, sessionId: "other-thread" });
  assert.equal(pendings(hinted)[0].session_id, "other-thread");

  // No session id at all: no claim, a session-unbound trace.
  const unbound = makeFixture();
  assert.equal(pushTag(unbound).status, 0);
  const result = runPostTool(unbound, "codex", { command: `git push origin ${TAG}`, sessionId: null });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(pendingFiles(unbound).length, 0);
  assert.equal(ledgerFiles(unbound).length, 1);
  assert.ok(traceReasons(unbound).includes("session-unbound"));
});

test("two simultaneous push calls claim one ledger entry exactly once", async () => {
  const fx = makeFixture();
  assert.equal(pushTag(fx).status, 0);
  const payload = JSON.stringify(postToolPayload("codex", { command: `git push origin ${TAG}`, sessionId: "sess-A", cwd: fx.a }));
  const runOne = () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [POST_TOOL], { cwd: fx.a, env: fx.env(), stdio: ["pipe", "pipe", "pipe"] });
      child.on("close", resolve);
      child.stdin.end(payload);
    });
  await Promise.all([runOne(), runOne()]);
  assert.equal(ledgerFiles(fx).length, 0);
  assert.deepEqual(candidateTags(fx), [TAG], "the tag is recorded once, not twice");
});

test("Scenario: Clone without the pre-push hook records nothing", () => {
  for (const shape of SHAPES) {
    const fx = makeFixture({ hooks: false });
    const push = pushTag(fx);
    assert.equal(push.status, 0, push.stderr);
    const result = runPostTool(fx, shape, { command: `git push origin ${TAG}` });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(ledgerFiles(fx).length, 0, "no ledger without the hook");
    assert.equal(pendingFiles(fx).length, 0, "no pending record from the command text");
    const stop = runStop(fx, shape);
    assertReleased(stop, "the mechanism is not in effect, Stop passes");
    assert.equal(stop.stdout, "");
  }
});

test("Scenario: Push to an unconfigured remote records nothing", () => {
  for (const shape of SHAPES) {
    const fx = makeFixture();
    const push = pushTag(fx, TAG, { remote: "nowhere" });
    assert.notEqual(push.status, 0, "git fails before running pre-push");
    assert.equal(ledgerFiles(fx).length, 0);
    const result = runPostTool(fx, shape, { command: `git push nowhere ${TAG}` });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(pendingFiles(fx).length, 0);
    assert.equal(ledgerFiles(fx).length, 0);
  }
});

// ── R3: Stop gate ─────────────────────────────────────────────────────────

test("Scenario: Unmerged pushed tag blocks the turn", () => {
  for (const shape of SHAPES) {
    const fx = makeFixture();
    pushAndBind(fx, shape);
    const stop = runStop(fx, shape);
    assertBlocked(stop, `${shape}: ${stop.stderr}`);
    assert.equal(stop.json?.decision, "block");
    assert.match(stop.json.reason, /Step 6A/);
    assert.match(stop.json.reason, /release-step-1-7\.md/);
    assert.match(stop.json.reason, /Ask First/);
    assert.match(stop.json.reason, /Step 1.*graph-only.*否則未經使用者授權不得自行合併/, "names the one exception and keeps the default");
    assert.ok(stop.json.reason.includes(TAG), "names the tag");
    assert.ok(stop.json.reason.includes(originMainSha(fx)), "names the origin main SHA used for the check");
    assert.match(stop.json.reason, /BackMergeDeferredByUser:/, "explains the deferral label");
    const [record] = pendings(fx);
    assert.equal(record.blocks.count, 1);
    assert.ok(trace(fx).some((e) => e.event === "blocked"));
  }
});

test("Scenario: Merge on the remote clears the record", () => {
  for (const shape of SHAPES) {
    const fx = makeFixture();
    pushAndBind(fx, shape);
    mergeProductionOnOrigin(fx);
    const staleLocalMain = tryGit(fx.a, ["rev-parse", "--verify", "refs/remotes/origin/main"]).stdout.trim();
    assert.notEqual(staleLocalMain, originMainSha(fx), "clone A's origin/main is stale before Stop, so Stop must fetch");

    const stop = runStop(fx, shape);
    assertReleased(stop, `${shape}: ${stop.stdout} ${stop.stderr}`);
    assert.equal(stop.stdout.includes('"block"'), false);
    assert.equal(pendingFiles(fx).length, 0, "record deleted once the judge exits 0");
    assert.ok(trace(fx).some((e) => e.event === "cleared" && e.reason === "main-ancestor-confirmed"));
    assert.equal(
      tryGit(fx.a, ["rev-parse", "--verify", "refs/remotes/origin/main"]).stdout.trim(),
      originMainSha(fx),
      "Stop fetched main into the remote-tracking ref",
    );
    assert.equal(
      tryGit(fx.a, ["tag", "-l", "production-*"]).stdout.trim(),
      TAG,
      "Stop fetched only main: no other tags were pulled in",
    );
  }
});

test("Scenario: Qualified handoff releases and unqualified still blocks", () => {
  for (const shape of SHAPES) {
    const qualified = makeFixture();
    pushAndBind(qualified, shape);
    const released = runStop(qualified, shape, { message: BACK_MERGE_HANDOFF });
    assertReleased(released, `${shape}: ${released.stdout}`);
    assert.equal(released.stdout.includes('"block"'), false);
    assert.equal(pendingFiles(qualified).length, 1, "a qualified handoff keeps the record");
    assert.ok(trace(qualified).some((e) => e.event === "released" && e.reason === "qualified-handoff"));
    // Next turn without a handoff is checked again and blocks.
    const next = runStop(qualified, shape, { message: "done" });
    assertBlocked(next);

    const noMention = makeFixture();
    pushAndBind(noMention, shape);
    const a = runStop(noMention, shape, { message: "請選擇：\n1. 是\n2. 否\n3. 其他" });
    assertBlocked(a, `${shape}: numbered options without a back-merge mention still block`);

    const noOptions = makeFixture();
    pushAndBind(noOptions, shape);
    const b = runStop(noOptions, shape, { message: "Back-merge 還沒做，等你處理。" });
    assertBlocked(b, `${shape}: a mention without numbered options still blocks`);

    const closedLast = makeFixture();
    pushAndBind(closedLast, shape);
    const c = runStop(closedLast, shape, { message: "Back-merge 要做嗎？\n1. 是\n2. 否" });
    assertBlocked(c, `${shape}: options with a closed last option still block`);
  }
});

test("Scenario: User deferral releases with a trace", () => {
  const fx = makeFixture();
  pushAndBind(fx, "codex");
  // An empty or "none" value is not a deferral.
  const none = runStop(fx, "codex", { message: "BackMergeDeferredByUser: none" });
  assertBlocked(none);

  const summary = "使用者說這週先不合回 main，等下週 release 再處理";
  const deferred = runStop(fx, "codex", { message: `等你確認。\nBackMergeDeferredByUser: ${summary}` });
  assertReleased(deferred, deferred.stdout);
  assert.equal(deferred.stdout.includes('"block"'), false);
  const [record] = pendings(fx);
  assert.equal(record.deferred.summary, summary);
  assert.ok(Number.isFinite(Date.parse(record.deferred.at)));
  assert.ok(trace(fx).some((e) => e.event === "released" && e.reason === "user-deferred"));

  // A later turn without the label is still released, and the record is kept.
  const later = runStop(fx, "codex", { message: "all good" });
  assertReleased(later);
  assert.equal(pendingFiles(fx).length, 1);
  assert.ok(traceReasons(fx).filter((r) => r === "user-deferred").length >= 2);

  // Claude shape (transcript) and a summary longer than 200 characters is truncated.
  const long = makeFixture();
  pushAndBind(long, "claude");
  const text = "x".repeat(500);
  const result = runStop(long, "claude", { message: `BackMergeDeferredByUser: ${text}` });
  assertReleased(result, result.stdout);
  assert.equal(pendings(long)[0].deferred.summary.length, 200);
});

test("Scenario: Unreachable remote releases unverified", () => {
  for (const shape of SHAPES) {
    const fx = makeFixture();
    pushAndBind(fx, shape);
    git(fx.a, ["remote", "set-url", "origin", path.join(fx.root, "does-not-exist.git")]);
    const stop = runStop(fx, shape);
    assertReleased(stop, `${shape}: ${stop.stdout} ${stop.stderr}`);
    assert.equal(stop.stdout.includes('"block"'), false);
    assert.equal(pendingFiles(fx).length, 1, "a failed query never removes the record");
    assert.deepEqual(candidateTags(fx), [TAG]);
    assert.ok(trace(fx).some((e) => e.event === "released" && e.reason === "origin-unverified"));
    assert.equal(traceReasons(fx).includes("tag-not-on-origin"), false);
    assert.match(stop.json?.systemMessage ?? "", /未驗證|unverified/i, "the release is announced as unverified");
  }
});

test("Scenario: Unreachable remote releases unverified (fetch fails after a good ls-remote)", { skip: NO_SHIM }, () => {
  const fx = makeFixture();
  pushAndBind(fx, "codex");
  mergeProductionOnOrigin(fx);
  const stop = runStop(fx, "codex", { env: shimEnv(fx, { SHIM_FETCH_FAIL: "1" }) });
  assertReleased(stop, `${stop.stdout} ${stop.stderr}`);
  assert.equal(pendingFiles(fx).length, 1, "a failed fetch keeps the record");
  assert.ok(trace(fx).some((e) => e.event === "released" && e.reason === "origin-unverified"));
  assert.ok(shimLog(fx).includes("fetch"));
});

test("Scenario: Remote that disappears after a valid push is unverified, not cleared", () => {
  for (const shape of SHAPES) {
    const fx = makeFixture();
    pushAndBind(fx, shape);
    git(fx.a, ["remote", "remove", "origin"]);
    const stop = runStop(fx, shape);
    assertReleased(stop, `${shape}: ${stop.stdout} ${stop.stderr}`);
    assert.equal(pendingFiles(fx).length, 1, "the record is kept");
    assert.ok(trace(fx).some((e) => e.event === "released" && e.reason === "origin-unverified"));
    assert.equal(traceReasons(fx).includes("tag-not-on-origin"), false, "never recorded as tag-not-on-origin");
    assert.equal(traceReasons(fx).includes("cleared"), false);
  }
});

test("Scenario: Stop verification shares one bounded budget", { skip: NO_SHIM }, () => {
  const fx = makeFixture();
  const mirror1 = path.join(fx.root, "mirror1.git");
  const mirror2 = path.join(fx.root, "mirror2.git");
  for (const dir of [mirror1, mirror2]) git(fx.root, ["clone", "-q", "--bare", fx.origin, dir]);
  git(fx.a, ["remote", "add", "mirror1", mirror1]);
  git(fx.a, ["remote", "add", "mirror2", mirror2]);
  for (const remote of ["origin", "mirror1", "mirror2"]) assert.equal(pushTag(fx, TAG, { remote }).status, 0);
  assert.equal(ledgerFiles(fx).length, 3);
  const bound = runPostTool(fx, "codex", {
    command: `git push origin ${TAG} && git push mirror1 ${TAG} && git push mirror2 ${TAG}`,
  });
  assert.equal(bound.status, 0, bound.stderr);
  assert.equal(candidateTags(fx).length, 3, "three candidates across three remotes");

  // Each ls-remote hangs 30s with a 10s own limit: three of them would take 30s.
  const stop = runStop(fx, "codex", {
    env: shimEnv(fx, { SHIM_LS_SLEEP: "30", DEVPRO_RELEASE_BACK_MERGE_BUDGET_MS: "2500" }),
    timeoutMs: 60_000,
  });
  assertReleased(stop, `${stop.stdout} ${stop.stderr}`);
  assert.ok(stop.elapsedMs < 9_000, `the single budget bounds the whole Stop run (took ${stop.elapsedMs}ms)`);
  assert.ok(
    trace(fx).some((e) => e.event === "released" && e.reason === "origin-unverified" && e.detail === "budget-exceeded"),
    "trace names budget-exceeded",
  );
  assert.equal(candidateTags(fx).length, 3, "unverified records are kept");
});

test("Scenario: Loop guard and block cap release with a trace", () => {
  const fx = makeFixture();
  pushAndBind(fx, "codex");
  assertBlocked(runStop(fx, "codex"), "first Stop blocks");
  assert.equal(pendings(fx)[0].blocks.count, 1);

  // Codex continues after a block; the second Stop has stop_hook_active=true.
  const loop = runStop(fx, "codex", { stopHookActive: true });
  assertReleased(loop, `${loop.stdout}`);
  assert.equal(loop.stdout.includes('"block"'), false);
  assert.ok(trace(fx).some((e) => e.event === "released" && e.reason === "loop-guard-degraded"));
  assert.equal(pendings(fx)[0].blocks.count, 1, "a loop-guard release neither blocks nor clears");
  assert.match(loop.json?.systemMessage ?? "", /back-merge|Step 6A|未完成/i);

  // A later separate turn (flag false) blocks a second time, the third is capped.
  assertBlocked(runStop(fx, "claude"), "second hard block inside the window");
  assert.equal(pendings(fx)[0].blocks.count, 2);
  const capped = runStop(fx, "claude");
  assertReleased(capped, capped.stdout);
  assert.ok(trace(fx).some((e) => e.event === "released" && e.reason === "block-cap-degraded"));
  assert.equal(pendingFiles(fx).length, 1, "the cap releases without clearing");

  // The window is 30 minutes: age it and the gate blocks again from a fresh count.
  const [file] = pendingFiles(fx);
  const record = readJson(file);
  const old = new Date(Date.now() - 31 * 60_000).toISOString();
  record.blocks = { count: 2, window_started_at: old, last_blocked_at: old };
  writeFileSync(file, JSON.stringify(record));
  const afterWindow = runStop(fx, "codex", { stopHookActive: true });
  assertBlocked(afterWindow, "stop_hook_active alone does not release when no block happened in 30 minutes");
  assert.equal(pendings(fx)[0].blocks.count, 1);
});

test("Scenario: Failed push or missing remote tag clears the record", { skip: NO_HOOK_EXEC }, () => {
  for (const shape of SHAPES) {
    // Remote rejects the tag (pre-receive); client pre-push already ran and recorded it.
    const fx = makeFixture();
    const hook = path.join(fx.origin, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    const push = pushTag(fx);
    assert.notEqual(push.status, 0, "the remote rejected the push");
    assert.equal(ledgerFiles(fx).length, 1, "pre-push recorded it before the push failed");
    const bound = runPostTool(fx, shape, { command: `git push origin ${TAG}`, exitCode: 1 });
    assert.equal(bound.status, 0, bound.stderr);
    assert.deepEqual(candidateTags(fx), [TAG]);

    const stop = runStop(fx, shape);
    assertReleased(stop, `${shape}: ${stop.stdout} ${stop.stderr}`);
    assert.equal(stop.stdout.includes('"block"'), false);
    assert.equal(pendingFiles(fx).length, 0, "tag absent on a reachable origin: record removed");
    assert.ok(trace(fx).some((e) => e.event === "cleared" && e.reason === "tag-not-on-origin"));
  }

  // Origin holds a different value than the recorded SHA.
  const moved = makeFixture();
  pushAndBind(moved, "codex");
  const newer = writeCommit(moved.a, "other.txt", "other");
  shipToProduction(moved, newer);
  git(moved.a, ["tag", "-f", "-a", "-m", "moved", TAG, newer]);
  assert.equal(spawnSync("git", ["push", "--force", "origin", TAG], { cwd: moved.a, encoding: "utf8", env: moved.env() }).status, 0);
  const stop = runStop(moved, "codex");
  assertReleased(stop, `${stop.stdout} ${stop.stderr}`);
  assert.equal(pendingFiles(moved).length, 0, "a different value on origin removes the candidate");
  assert.ok(trace(moved).some((e) => e.event === "cleared" && e.reason === "tag-not-on-origin"));
});

test("Scenario: Other conversations are unaffected", { skip: NO_SHIM }, () => {
  for (const shape of SHAPES) {
    const fx = makeFixture();
    pushAndBind(fx, shape, { sessionId: "sess-A" });
    const other = runStop(fx, shape, { sessionId: "sess-B", env: shimEnv(fx) });
    assertReleased(other, other.stderr);
    assert.equal(other.stdout, "");
    assert.deepEqual(shimLog(fx), [], "no network query for another conversation's record");
    assert.equal(pendingFiles(fx).length, 1);

    const own = runStop(fx, shape, { sessionId: "sess-A", env: shimEnv(fx) });
    assertBlocked(own, "the owning conversation is still blocked");
    assert.ok(shimLog(fx).includes("ls-remote"));
  }
});

test("a pending record with broken JSON, an unknown schema or a foreign session never throws out of Stop", () => {
  const fx = makeFixture();
  pushAndBind(fx, "codex");
  mkdirSync(fx.stateDir, { recursive: true });
  writeFileSync(path.join(fx.stateDir, "pending-broken-1-aaaaaaaa.json"), "{not json");
  writeFileSync(path.join(fx.stateDir, "pending-weird-2-bbbbbbbb.json"), JSON.stringify({ schema: "other/v9", session_id: "sess-A" }));
  const stop = runStop(fx, "codex");
  assertBlocked(stop, `${stop.stderr}`);
  assert.equal(stop.json?.decision, "block", "the readable record still blocks");
  assert.ok(trace(fx).some((e) => e.event === "error" && e.reason === "record-unreadable"));

  // Invalid stdin, no session id, empty payload: fail open, silent.
  for (const rawPayload of ["{not json", "", "{}", JSON.stringify({ cwd: fx.a })]) {
    const result = runStop(fx, "codex", { rawPayload });
    assertReleased(result, `payload ${JSON.stringify(rawPayload)}: ${result.stderr}`);
    assert.equal(result.stdout, "");
  }
});

test("expiry only garbage-collects: ledgers after 24 hours, pending records after 14 days", () => {
  const fx = makeFixture();
  mkdirSync(fx.stateDir, { recursive: true });
  const day = 24 * 60 * 60_000;
  const ledger = (ageMs, name) =>
    writeFileSync(
      path.join(fx.stateDir, name),
      JSON.stringify({
        schema: "devpro-release-back-merge-push/v1",
        created_at: new Date(Date.now() - ageMs).toISOString(),
        remote: "origin",
        refs: [{ tag: TAG, local_sha: "a".repeat(40), remote_old_sha: ZERO_SHA }],
        session_hint: "",
      }),
    );
  const pending = (ageMs, name, sessionId) =>
    writeFileSync(
      path.join(fx.stateDir, name),
      JSON.stringify({
        schema: "devpro-release-back-merge-pending/v1",
        session_id: sessionId,
        recorded_at: new Date(Date.now() - ageMs).toISOString(),
        candidates: [{ tag: TAG, remote: "origin", expected_sha: "a".repeat(40) }],
        blocks: { count: 0, window_started_at: null, last_blocked_at: null },
        deferred: null,
        reminded_at: null,
      }),
    );
  ledger(25 * 60 * 60_000, "pushed-1-aaaaaaa1.json");
  ledger(2 * 60 * 60_000, "pushed-2-aaaaaaa2.json");
  pending(15 * day, "pending-old-1-bbbbbbb1.json", "someone-else");
  pending(13 * day, "pending-new-2-bbbbbbb2.json", "someone-else");

  const stop = runStop(fx, "codex", { sessionId: "sess-no-record" });
  assertReleased(stop, stop.stderr);
  assert.deepEqual(ledgerFiles(fx).map((f) => path.basename(f)), ["pushed-2-aaaaaaa2.json"]);
  assert.deepEqual(pendingFiles(fx).map((f) => path.basename(f)), ["pending-new-2-bbbbbbb2.json"]);
  assert.equal(trace(fx).filter((e) => e.event === "expired").length, 2);
});

test("trace.jsonl keeps only its latter half once it passes 256 KiB, and stores no raw session id", async () => {
  const fx = makeFixture();
  mkdirSync(fx.stateDir, { recursive: true });
  const lib = await import(pathToFileURL(STATE_LIB).href);
  const file = path.join(fx.stateDir, "trace.jsonl");
  const filler = JSON.stringify({ ts: "t", session_key: "k", event: "expired", reason: "filler", tags: [], pad: "p".repeat(900) });
  writeFileSync(file, `${filler}\n`.repeat(400));
  assert.ok(statSync(file).size > 256 * 1024);
  lib.appendTrace(fx.stateDir, { sessionId: "sess-A", event: "recorded", reason: "recorded", tags: [TAG] });
  const size = statSync(file).size;
  assert.ok(size <= 256 * 1024, `trace trimmed to <= 256KiB (got ${size})`);
  assert.ok(size > 64 * 1024, "only the first half was dropped");
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.equal(JSON.parse(lines.at(-1)).reason, "recorded", "the new line survives");
  assert.ok(lines.every((line) => JSON.parse(line)), "no half line is left behind");
  assert.equal(readFileSync(file, "utf8").includes("sess-A"), false);
});

// ── R7: registration and payload-shape parity ─────────────────────────────

function registeredStopScripts(relPath, key) {
  const parsed = JSON.parse(readFileSync(repoPath(relPath), "utf8"));
  const commands = [];
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value && typeof value === "object") {
      if (typeof value.command === "string") commands.push(value.command);
      Object.values(value).forEach(walk);
    }
  };
  walk(parsed.hooks[key]);
  return commands;
}

test("Scenario: Claude Code and Codex register the gate", async () => {
  for (const [file, key, host] of [
    [".claude/settings.json", "Stop", "claude-code"],
    [".codex/hooks.json", "Stop", "codex"],
  ]) {
    const commands = registeredStopScripts(file, key).filter((c) => c.includes("release-back-merge-check.mjs"));
    assert.equal(commands.length, 1, `${file} registers the gate exactly once in Stop`);
    assert.match(commands[0], new RegExp(`Stop \\.devpro/scripts/hooks/release-back-merge-check\\.mjs --host=${host}$`));
    assert.match(commands[0], /run-hook\.mjs/, "through the shared wrapper");
  }
  const runner = readFileSync(RUN_HOOK, "utf8");
  const allowlist = runner.match(/STOP_PAYLOAD_HOOKS\s*=\s*new Set\(\[([^\]]*)\]\)/s);
  assert.ok(allowlist && allowlist[1].includes('"release-back-merge-check.mjs"'), "STOP_PAYLOAD_HOOKS forwards the Stop payload");
  const { HOOK_NOOP_POLICY, shouldNoOp } = await import(pathToFileURL(repoPath(".devpro/scripts/hooks/lib/rigor-level.mjs")).href);
  assert.equal(HOOK_NOOP_POLICY["release-back-merge-check.mjs"], "cross-repo-stop");
  assert.equal(shouldNoOp("release-back-merge-check.mjs", "lite"), false);
  assert.equal(shouldNoOp("release-back-merge-check.mjs", "off"), true);
});

test("Scenario: Codex and Claude Code payload shapes behave the same", () => {
  const outcomes = {};
  for (const shape of SHAPES) {
    const fx = makeFixture();
    pushAndBind(fx, shape);
    const blocked = runStop(fx, shape);
    mergeProductionOnOrigin(fx);
    const released = runStop(fx, shape);
    outcomes[shape] = {
      blockedStatus: blocked.status,
      blockedDecision: blocked.json?.decision,
      blockedReasonHasStep6A: /Step 6A/.test(blocked.json?.reason ?? ""),
      releasedStatus: released.status,
      releasedStdout: released.stdout,
      recordsLeft: pendingFiles(fx).length,
    };
  }
  assert.deepEqual(outcomes.codex, outcomes.claude);
  assert.equal(outcomes.codex.blockedStatus, 0, "a block is signalled by stdout JSON with exit 0, which both hosts honor through the wrapper");
  assert.equal(outcomes.codex.blockedDecision, "block");
  assert.equal(outcomes.codex.releasedStatus, 0);
  assert.equal(outcomes.codex.recordsLeft, 0);
});

test("through the run-hook wrapper the block decision reaches stdout (Codex and Claude Code hosts)", () => {
  for (const [shape, host] of [["codex", "codex"], ["claude", "claude-code"]]) {
    const fx = makeFixture();
    pushAndBind(fx, shape);
    const stop = runStop(fx, shape, { viaRunner: { event: "Stop", host } });
    assertBlocked(stop, `${host} via run-hook wrapper`);
    assert.match(stop.json.reason, /Step 6A/);
  }
});

test("Scenario: Registration for the host without a post-tool hook is a parity no-op", { skip: NO_SHIM }, () => {
  const commands = registeredStopScripts(".cursor/hooks.json", "stop").filter((c) => c.includes("release-back-merge-check.mjs"));
  assert.equal(commands.length, 1, ".cursor/hooks.json stop registers the gate");
  assert.match(commands[0], /stop \.devpro\/scripts\/hooks\/release-back-merge-check\.mjs --host=cursor$/);

  // A record bound to a Claude/Codex conversation exists; a Cursor stop payload
  // (conversation_id, no session_id, no postToolUse binding) finds nothing for it.
  const fx = makeFixture();
  pushAndBind(fx, "codex");
  const cursorPayload = { conversation_id: "cursor-conv-1", status: "completed", loop_count: 0, hook_event_name: "stop", workspace_roots: [fx.a] };
  const result = runStop(fx, "codex", { rawPayload: cursorPayload, env: shimEnv(fx), viaRunner: { event: "stop", host: "cursor" } });
  assertReleased(result, `${result.stdout} ${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.deepEqual(shimLog(fx), [], "no network access from the Cursor registration");
  assert.equal(pendingFiles(fx).length, 1, "the other conversation's record is untouched");
});

// ── cross-clone sessions and the origin/main completion target ────────────

const sessionKeyOf = (sessionId) => createHash("sha256").update(sessionId).digest("hex").slice(0, 16);

test("hub off checks only this session's linked release back-merge obligation", () => {
  const fx = makeFixture({ isolatedState: true });
  const hub = makeSessionRepo(fx);
  mkdirSync(path.join(hub.dir, ".devpro"));
  writeFileSync(path.join(hub.dir, ".devpro", "rules.config"), "agent_rules_level=off\n");
  assert.equal(pushTag(fx).status, 0);
  assert.equal(runPostTool(fx, "codex", { command: `cd ${fx.a} && git push origin ${TAG}`, cwd: hub.dir, viaWrapper: true }).status, 0);
  assert.deepEqual(candidateTags(fx), [TAG]);
  const second = makeFixture({ isolatedState: true });
  assert.equal(pushTag(second).status, 0);
  assert.equal(runPostTool(second, "codex", { command: `cd ${second.a} && git push origin ${TAG}`, cwd: hub.dir, viaWrapper: true }).status, 0);
  assert.deepEqual(candidateTags(second), [TAG]);
  assert.equal(filesWithPrefix(hub, "repos-").length, 1);
  const own = path.join(hub.stateDir, "pending-local.json");
  writeFileSync(own, JSON.stringify({ ...pendings(fx)[0], candidates: [{ tag: "production-v9.9.9", remote: "origin" }] }));
  const opts = {
    cwd: hub.dir, viaRunner: { event: "Stop", host: "codex" },
    rawPayload: { session_id: "sess-A", cwd: fx.a },
  };
  const blocked = runStop(fx, "codex", opts);
  assertBlocked(blocked);
  const targetLabel = (target) => `${TAG}（repo ${path.relative(realpathSync(hub.dir), realpathSync(target.a))}）`;
  assert.ok(blocked.json.reason.includes(targetLabel(fx)));
  assert.ok(blocked.json.reason.includes(targetLabel(second)));
  assert.doesNotMatch(blocked.json.reason, /production-v9\.9\.9/);
  assert.equal(existsSync(own), true);

  mergeProductionOnOrigin(fx);
  const stillPending = runStop(fx, "codex", opts);
  assertBlocked(stillPending);
  assert.ok(stillPending.json.reason.includes(targetLabel(second)));
  assert.ok(!stillPending.json.reason.includes(targetLabel(fx)));
  assert.equal(pendingFiles(fx).length, 0);
  assert.deepEqual(candidateTags(second), [TAG]);
  assert.equal(filesWithPrefix(hub, "repos-").length, 1);
  mergeProductionOnOrigin(second);
  assert.equal(runStop(fx, "codex", opts).stdout, "");
  assert.equal(pendingFiles(second).length, 0);
  assert.equal(filesWithPrefix(hub, "repos-").length, 0);
  assert.equal(existsSync(own), true);
  assert.equal(runStop(fx, "codex", opts).stdout, "");
});

test("Scenario: Push from a different clone than the session start is still enforced", () => {
  for (const shape of SHAPES) {
    const fx = makeFixture({ isolatedState: true });
    const session = makeSessionRepo(fx);
    assert.equal(pushTag(fx).status, 0);
    const bound = runPostTool(fx, shape, { command: `cd ${fx.a} && git push origin ${TAG}`, cwd: session.dir });
    assert.equal(bound.status, 0, bound.stderr);
    assert.deepEqual(candidateTags(fx), [TAG], "the pending record lives in the pushed repo's state dir");
    const links = filesWithPrefix(session, "repos-");
    assert.equal(links.length, 1, "the session start repo holds a link to the pushed repo");
    const link = readJson(links[0]);
    assert.equal(link.schema, "devpro-release-back-merge-repos/v1");
    assert.equal(link.session_id, "sess-A");
    assert.deepEqual(link.repos, [realpathSync(fx.a)]);

    const blocked = runStop(fx, shape, { cwd: session.dir });
    assertBlocked(blocked, `${shape}: unmerged tag pushed from another clone`);
    assert.match(blocked.json.reason, /Step 6A/);
    assert.equal(pendings(fx)[0].blocks.count, 1);

    mergeProductionOnOrigin(fx);
    const released = runStop(fx, shape, { cwd: session.dir });
    assertReleased(released, `${shape}: after the origin merge`);
    assert.equal(pendingFiles(fx).length, 0, "record cleared in the pushed repo");
    assert.equal(filesWithPrefix(session, "repos-").length, 0, "link removed once the linked repo has no pending record");
  }
});

test("a session link to a missing path or a broken link file is skipped with a link-unreadable trace", () => {
  const fx = makeFixture({ isolatedState: true });
  const session = makeSessionRepo(fx);
  mkdirSync(session.stateDir, { recursive: true });
  const key = sessionKeyOf("sess-A");
  writeFileSync(
    path.join(session.stateDir, `repos-${key}.json`),
    JSON.stringify({
      schema: "devpro-release-back-merge-repos/v1",
      session_id: "sess-A",
      updated_at: new Date().toISOString(),
      repos: [path.join(fx.root, "gone"), fx.root],
    }),
  );
  const result = runStop(fx, "codex", { cwd: session.dir });
  assertReleased(result);
  assert.equal(trace(session).filter((e) => e.reason === "link-unreadable").length, 2, "missing path and non-repo path");

  writeFileSync(path.join(session.stateDir, `repos-${key}.json`), "{not json");
  const broken = runStop(fx, "codex", { cwd: session.dir });
  assertReleased(broken);
  assert.ok(trace(session).filter((e) => e.reason === "link-unreadable").length >= 3);
});

test("a stale session link is removed and an expired link file is garbage-collected", () => {
  const fx = makeFixture({ isolatedState: true });
  const session = makeSessionRepo(fx);
  mkdirSync(session.stateDir, { recursive: true });
  const key = sessionKeyOf("sess-A");
  const linkFile = path.join(session.stateDir, `repos-${key}.json`);
  writeFileSync(
    linkFile,
    JSON.stringify({ schema: "devpro-release-back-merge-repos/v1", session_id: "sess-A", updated_at: new Date().toISOString(), repos: [fx.a] }),
  );
  assertReleased(runStop(fx, "codex", { cwd: session.dir }));
  assert.equal(existsSync(linkFile), false, "a linked repo without a pending record for this session drops the link");

  const old = path.join(session.stateDir, `repos-${sessionKeyOf("someone")}.json`);
  writeFileSync(
    old,
    JSON.stringify({
      schema: "devpro-release-back-merge-repos/v1",
      session_id: "someone",
      updated_at: new Date(Date.now() - 15 * 24 * 60 * 60_000).toISOString(),
      repos: [fx.a],
    }),
  );
  assertReleased(runStop(fx, "codex", { cwd: session.dir }));
  assert.equal(existsSync(old), false, "links expire with the 14 day pending TTL");
});

/** Origin plus a mirror whose main already contains the production tag's commit. */
function addMirrorWithTagInMain(fx) {
  const mirror = path.join(fx.root, "mirror.git");
  git(fx.root, ["clone", "-q", "--bare", fx.origin, mirror]);
  git(fx.a, ["remote", "add", "mirror", mirror]);
  git(fx.b, ["remote", "add", "mirror", mirror]);
  git(fx.b, ["fetch", "-q", "--no-tags", fx.a, `refs/tags/${TAG}:refs/tags/${TAG}`]);
  git(fx.b, ["merge", "-q", "--no-ff", "-m", "back-merge production", TAG]);
  git(fx.b, ["push", "-q", "mirror", "main"]);
  return mirror;
}

test("Scenario: Mirror main containing the tag does not complete Step 6A", () => {
  for (const shape of SHAPES) {
    const fx = makeFixture();
    addMirrorWithTagInMain(fx);
    pushAndBind(fx, shape, { remote: "mirror" });
    assert.deepEqual(pendings(fx)[0].candidates.map((c) => c.remote), ["mirror"]);

    const blocked = runStop(fx, shape);
    assertBlocked(blocked, `${shape}: mirror main contains the tag but origin main does not`);
    assert.equal(pendingFiles(fx).length, 1, "the record is kept");
    assert.ok(blocked.json.reason.includes(originMainSha(fx)), "the check used origin main");

    git(fx.b, ["push", "-q", "origin", "main"]);
    const released = runStop(fx, shape);
    assertReleased(released, `${shape}: after origin main contains the tag`);
    assert.equal(pendingFiles(fx).length, 0);
    assert.ok(trace(fx).some((e) => e.event === "cleared" && e.reason === "main-ancestor-confirmed"));
  }
});

test("without a remote named origin the pushed remote's main is the completion target", () => {
  const fx = makeFixture();
  git(fx.a, ["remote", "rename", "origin", "upstream"]);
  pushAndBind(fx, "codex", { remote: "upstream" });
  assertBlocked(runStop(fx, "codex"));
  mergeProductionOnOrigin(fx);
  assertReleased(runStop(fx, "codex"));
  assert.equal(pendingFiles(fx).length, 0);
});

test("origin main is queried and fetched once per Stop even when two remotes are verified", { skip: NO_SHIM }, () => {
  const fx = makeFixture();
  addMirrorWithTagInMain(fx);
  for (const remote of ["origin", "mirror"]) assert.equal(pushTag(fx, TAG, { remote }).status, 0);
  const bound = runPostTool(fx, "codex", { command: `git push origin ${TAG} && git push mirror ${TAG}` });
  assert.equal(bound.status, 0, bound.stderr);
  assert.equal(candidateTags(fx).length, 2);
  const stop = runStop(fx, "codex", { env: shimEnv(fx) });
  assertBlocked(stop);
  const log = shimLog(fx);
  assert.equal(log.filter((entry) => entry === "fetch").length, 1, `one fetch of origin main (${log.join(",")})`);
  assert.equal(log.filter((entry) => entry === "ls-remote").length, 2, "one tag query per pushed remote, no second main query");
});
