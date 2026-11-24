import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./lib/tmp.mjs";

// A consumer clone that did not run the rules sync (cloud routine, teammate, second machine) keeps `.devpro-agent-rules` at an old
// commit after `git pull`; `git submodule status` then starts with `+`. The doctor already reports it, but only when somebody runs
// it, so the stale rules were found by chance (#2904). SessionStart now adds one short cue that points at the doctor. The cue is
// bounded by the 1000-byte SessionStart payload budget (hook-payload-policy): the worst fixed composition is the full-level base
// message (850) + the AGENTS.local.md pointer (50) + this cue (50) = 950, so the cue stays at 50 bytes and carries no command; the
// doctor owns the wording of the fix.

const HOOK = fileURLToPath(new URL("../hooks/session-start.mjs", import.meta.url));
const LIB = new URL("../hooks/lib/submodule-drift.mjs", import.meta.url).href;
const CUE = "\n---\n.devpro-agent-rules 未對齊：devpro-doctor";
const SUBMODULE_STATUS_PATH = ".devpro-agent-rules";
const PAYLOAD_BUDGET_BYTES = 1000;

const tmpRoot = makeTempDir("session-start-submodule-drift-");
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

let counter = 0;
const caseDir = (name) => {
  const dir = path.join(tmpRoot, `${name}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "protocol.file.allow",
  GIT_CONFIG_VALUE_0: "always",
};

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
}

// A consumer-shaped repo: a real `.devpro-agent-rules` submodule recorded at one commit.
function consumerRepo(name) {
  const root = caseDir(name);
  const rules = path.join(root, "rules-source");
  const consumer = path.join(root, "consumer");
  mkdirSync(rules, { recursive: true });
  mkdirSync(consumer, { recursive: true });
  git(rules, "init", "-q", "-b", "main");
  writeFileSync(path.join(rules, "AGENTS.md"), "# rules\n");
  git(rules, "add", "AGENTS.md");
  git(rules, "commit", "-qm", "rules v1");
  git(consumer, "init", "-q", "-b", "main");
  git(consumer, "submodule", "add", "-q", rules, SUBMODULE_STATUS_PATH);
  git(consumer, "commit", "-qm", "consumer with rules submodule");
  return consumer;
}

// Not through git(): its trim() would eat the leading space that marks an aligned checkout.
const submoduleStatusPrefix = (consumer) =>
  execFileSync("git", ["submodule", "status", SUBMODULE_STATUS_PATH], { cwd: consumer, encoding: "utf8", env: GIT_ENV }).charAt(0);

function sessionStart(cwd, level) {
  const stateRoot = caseDir("state");
  const result = spawnSync("node", [HOOK], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_CI: "",
      CODEX_THREAD_ID: "",
      DEVPRO_AGENT_RULES_LEVEL: level,
      DEVPRO_RECAP_PENDING_DIR: path.join(stateRoot, "pending"),
      DEVPRO_RECAP_STATE_DIR: path.join(stateRoot, "recap"),
      DEVPRO_RUNTIME_CONSENT_HOME: path.join(stateRoot, "home"),
      DEVPRO_RUNTIME_CONSENT_ACK: "",
    },
  });
  assert.equal(result.status, 0, `session-start failed at ${level}: ${result.stderr}`);
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
}

const LEVELS = ["full", "lite", "off"];

test("SessionStart cues the doctor when the submodule checkout differs from the recorded pointer (+)", () => {
  for (const level of LEVELS) {
    const consumer = consumerRepo(`plus-${level}`);
    // A commit inside the submodule moves its checkout off the gitlink the consumer recorded: the state a `git pull` leaves behind.
    git(path.join(consumer, SUBMODULE_STATUS_PATH), "commit", "-q", "--allow-empty", "-m", "moved off the recorded pointer");
    assert.equal(submoduleStatusPrefix(consumer), "+", "fixture precondition");
    const context = sessionStart(consumer, level);
    assert.ok(context.includes(CUE), `level=${level}: ${JSON.stringify(context.slice(-120))}`);
    assert.ok(
      Buffer.byteLength(context, "utf8") <= PAYLOAD_BUDGET_BYTES,
      `level=${level}: additionalContext ${Buffer.byteLength(context, "utf8")}B exceeds hook-payload-policy ${PAYLOAD_BUDGET_BYTES}B`,
    );
  }
});

test("SessionStart cues the doctor when the submodule was never initialised (-)", () => {
  const consumer = consumerRepo("uninitialised");
  git(consumer, "submodule", "deinit", "-q", "-f", SUBMODULE_STATUS_PATH);
  assert.equal(submoduleStatusPrefix(consumer), "-", "fixture precondition");
  assert.ok(sessionStart(consumer, "full").includes(CUE));
});

test("SessionStart stays silent about the submodule when it is aligned", () => {
  for (const level of LEVELS) {
    const consumer = consumerRepo(`aligned-${level}`);
    assert.equal(submoduleStatusPrefix(consumer), " ", "fixture precondition");
    const context = sessionStart(consumer, level);
    assert.equal(context.includes(CUE), false, `level=${level}`);
    assert.equal(context.includes(".devpro-agent-rules"), false, `level=${level}: no submodule mention when aligned`);
  }
});

test("SessionStart stays silent in a repo that does not declare the rules submodule", () => {
  const plain = caseDir("plain-repo");
  git(plain, "init", "-q", "-b", "main");
  writeFileSync(path.join(plain, "seed"), "seed\n");
  git(plain, "add", "seed");
  git(plain, "commit", "-qm", "seed");
  assert.equal(sessionStart(plain, "full").includes(CUE), false);
});

test("SessionStart keeps the AGENTS.local.md pointer next to the cue within the payload budget", () => {
  for (const level of LEVELS) {
    const consumer = consumerRepo(`overlay-and-drift-${level}`);
    writeFileSync(path.join(consumer, "AGENTS.local.md"), "# local\n");
    git(path.join(consumer, SUBMODULE_STATUS_PATH), "commit", "-q", "--allow-empty", "-m", "moved off the recorded pointer");
    const context = sessionStart(consumer, level);
    assert.ok(context.includes(CUE), `level=${level}: the cue is not displaced by the overlay pointer`);
    assert.match(context, /AGENTS\.local\.md：additive-only；source wins/, `level=${level}`);
    // The worst fixed composition: base message + overlay pointer + drift cue (full: 850 + 50 + 50).
    assert.ok(
      Buffer.byteLength(context, "utf8") <= PAYLOAD_BUDGET_BYTES,
      `level=${level}: overlay+drift additionalContext ${Buffer.byteLength(context, "utf8")}B exceeds hook-payload-policy ${PAYLOAD_BUDGET_BYTES}B`,
    );
  }
});

test("the cue fits the payload headroom and carries no command", async () => {
  const lib = await import(LIB);
  assert.equal(lib.SUBMODULE_DRIFT_CUE, CUE);
  assert.ok(Buffer.byteLength(CUE, "utf8") <= 50, `cue is ${Buffer.byteLength(CUE, "utf8")}B; the worst-case headroom (full base + overlay + cue under ${PAYLOAD_BUDGET_BYTES}B) is 50B`);
  assert.equal(/git submodule|--init/.test(CUE), false, "the fix command lives in devpro-doctor, not in the SessionStart payload");
});

function stubRunner(result, calls = []) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (result instanceof Error) throw result;
    return result;
  };
}

function declaredRepo(extra = "") {
  const root = caseDir("declared");
  writeFileSync(path.join(root, ".gitmodules"), `[submodule ".devpro-agent-rules"]\n\tpath = .devpro-agent-rules\n\turl = ../rules\n${extra}`);
  return root;
}

test("readSubmoduleDriftMarker reports +, - and U and nothing for an aligned checkout", async () => {
  const { readSubmoduleDriftMarker } = await import(LIB);
  const root = declaredRepo();
  for (const [stdout, expected] of [
    ["+0123456789abcdef0123456789abcdef01234567 .devpro-agent-rules (v1)\n", "+"],
    ["-0123456789abcdef0123456789abcdef01234567 .devpro-agent-rules\n", "-"],
    ["U0000000000000000000000000000000000000000 .devpro-agent-rules\n", "U"],
    [" 0123456789abcdef0123456789abcdef01234567 .devpro-agent-rules (v1)\n", null],
    ["", null],
  ]) {
    assert.equal(readSubmoduleDriftMarker(root, stubRunner({ status: 0, stdout })), expected, JSON.stringify(stdout));
  }
});

test("readSubmoduleDriftMarker runs one bounded local git call for exactly the rules submodule", async () => {
  const { readSubmoduleDriftMarker } = await import(LIB);
  const root = declaredRepo();
  const calls = [];
  readSubmoduleDriftMarker(root, stubRunner({ status: 0, stdout: " 0123 .devpro-agent-rules\n" }, calls));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "git");
  assert.deepEqual(calls[0].args, ["-C", root, "submodule", "status", SUBMODULE_STATUS_PATH]);
  assert.ok(Number.isInteger(calls[0].options.timeout) && calls[0].options.timeout > 0 && calls[0].options.timeout <= 5000);
});

test("readSubmoduleDriftMarker fails open on a git error, a failed status, or a thrown runner", async () => {
  const { readSubmoduleDriftMarker } = await import(LIB);
  const root = declaredRepo();
  assert.equal(readSubmoduleDriftMarker(root, stubRunner({ status: 128, stdout: "+abc .devpro-agent-rules\n" })), null);
  assert.equal(readSubmoduleDriftMarker(root, stubRunner({ status: 0, stdout: "+abc .devpro-agent-rules\n", error: new Error("ETIMEDOUT") })), null);
  assert.equal(readSubmoduleDriftMarker(root, stubRunner(new Error("spawn git ENOENT"))), null);
});

test("readSubmoduleDriftMarker does not call git when the rules submodule is not declared", async () => {
  const { readSubmoduleDriftMarker } = await import(LIB);
  const calls = [];
  const runner = stubRunner({ status: 0, stdout: "+abc .devpro-agent-rules\n" }, calls);
  assert.equal(readSubmoduleDriftMarker(caseDir("no-gitmodules"), runner), null);
  const other = caseDir("other-submodule");
  writeFileSync(path.join(other, ".gitmodules"), '[submodule "vendor/x"]\n\tpath = vendor/x\n\turl = ../x\n');
  assert.equal(readSubmoduleDriftMarker(other, runner), null);
  assert.equal(calls.length, 0, "a repo without the declaration pays no git spawn at session start");
});
