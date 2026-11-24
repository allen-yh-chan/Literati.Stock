import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const runner = repoPath(".devpro/scripts/hooks/run-hook.mjs");
const runtimeHookConfigs = [
  ".claude/settings.json",
  ".codex/hooks.json",
  ".cursor/hooks.json",
];

function run(eventName, scriptPath, input = "") {
  return spawnSync(process.execPath, [runner, eventName, scriptPath], {
    encoding: "utf8",
    input,
    env: { ...process.env, DEVPRO_AGENT_RULES_LEVEL: "full" },
  });
}

function runWithArgs(args, input = "") {
  return spawnSync(process.execPath, [runner, ...args], {
    encoding: "utf8",
    input,
  });
}

function readRepoFile(relPath) {
  return readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

function collectCommands(value, commands = []) {
  if (!value || typeof value !== "object") return commands;
  if (typeof value.command === "string") commands.push(value.command);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") collectCommands(child, commands);
  }
  return commands;
}

function stopHookBasenamesFromConfig(relPath) {
  const parsed = JSON.parse(readRepoFile(relPath));
  const commands = collectCommands(parsed);
  return commands.flatMap((command) => {
    return [...command.matchAll(/\s(?:Stop|stop)\s+(\.devpro\/scripts\/hooks\/[^\s"]+\.mjs)(?=\s|$)/g)]
      .map((match) => path.basename(match[1]));
  });
}

function stopPayloadAllowlist() {
  const source = readRepoFile(".devpro/scripts/hooks/run-hook.mjs");
  const match = source.match(/STOP_PAYLOAD_HOOKS\s*=\s*new Set\(\[([^\]]*)\]\)/s);
  assert.ok(match, "run-hook.mjs must declare STOP_PAYLOAD_HOOKS as an explicit Set");
  return new Set([...match[1].matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1]));
}

function hookConsumesStdin(basename) {
  const source = readRepoFile(`.devpro/scripts/hooks/${basename}`);
  return /process\.stdin\b|readFileSync\(\s*["']\/dev\/stdin["']|from\s+["']\.\/lib\/stdin\.mjs["']/.test(source);
}

test("run-hook exits silently when target script is missing", () => {
  const result = run("Stop", ".devpro/scripts/hooks/missing.mjs");

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("run-hook forwards hook stdout and stdin", () => {
  const dir = makeTempDir("hook-runner-");
  try {
    const child = path.join(dir, "child.mjs");
    writeFileSync(child, "process.stdin.pipe(process.stdout);\n");

    const result = run("UserPromptSubmit", child, "{\"prompt\":\"hi\"}");

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "{\"prompt\":\"hi\"}");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run-hook forwards stdin for Cursor preToolUse events", () => {
  const dir = makeTempDir("hook-runner-");
  try {
    const child = path.join(dir, "child.mjs");
    writeFileSync(child, "process.stdin.pipe(process.stdout);\n");

    const result = run("preToolUse", child, "{\"tool\":\"Bash\"}");

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "{\"tool\":\"Bash\"}");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run-hook forwards stdin for Cursor beforeSubmitPrompt events", () => {
  const dir = makeTempDir("hook-runner-");
  try {
    const child = path.join(dir, "child.mjs");
    writeFileSync(child, "process.stdin.pipe(process.stdout);\n");

    const result = run("beforeSubmitPrompt", child, "{\"prompt\":\"hi\"}");

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "{\"prompt\":\"hi\"}");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run-hook does not pipe large stdin into Stop hooks that do not consume stdin", () => {
  const dir = makeTempDir("hook-runner-");
  try {
    const child = path.join(dir, "child.mjs");
    writeFileSync(child, "process.exit(0);\n");

    const result = run("Stop", child, "x".repeat(1024 * 1024 * 8));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run-hook does not pipe large stdin into Cursor stop hooks that do not consume stdin", () => {
  const dir = makeTempDir("hook-runner-");
  try {
    const child = path.join(dir, "child.mjs");
    writeFileSync(child, "process.exit(0);\n");

    const result = run("stop", child, "x".repeat(1024 * 1024 * 8));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run-hook still forwards stdin to Stop hooks that consume Stop payload", () => {
  const dir = makeTempDir("hook-runner-");
  try {
    const child = path.join(dir, "stop-handoff-cite.mjs");
    writeFileSync(child, "process.stdin.pipe(process.stdout);\n");

    const result = run("Stop", child, "{\"stop_hook_active\":true}");

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "{\"stop_hook_active\":true}");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run-hook forwards stdin to Cursor stop hooks that consume Stop payload", () => {
  const dir = makeTempDir("hook-runner-");
  try {
    const child = path.join(dir, "stop-handoff-cite.mjs");
    writeFileSync(child, "process.stdin.pipe(process.stdout);\n");

    const result = run("stop", child, "{\"stop_hook_active\":true}");

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "{\"stop_hook_active\":true}");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registered stdin-consuming Stop hooks are in the runner payload allowlist", () => {
  const registeredStopHooks = new Set(runtimeHookConfigs.flatMap(stopHookBasenamesFromConfig));
  const allowlist = stopPayloadAllowlist();
  const stdinConsumers = [...registeredStopHooks].filter(hookConsumesStdin).sort();
  const missing = stdinConsumers.filter((basename) => !allowlist.has(basename));

  assert.deepEqual(stdinConsumers, ["recap-check.mjs", "release-back-merge-check.mjs", "stop-handoff-cite.mjs"]);
  assert.deepEqual(missing, [], `missing STOP_PAYLOAD_HOOKS entries: ${missing.join(", ")}`);
});

test("run-hook marks child invocation as JSON hook protocol", () => {
  const dir = makeTempDir("hook-runner-");
  try {
    const child = path.join(dir, "child.mjs");
    writeFileSync(
      child,
      "process.stdout.write(JSON.stringify({ event: process.env.DEVPRO_HOOK_EVENT, protocol: process.env.DEVPRO_HOOK_PROTOCOL }));\n",
    );

    const result = run("PreToolUse", child);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.deepEqual(parsed, { event: "PreToolUse", protocol: "json" });
    assert.equal(result.stderr, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run-hook forwards runtime host marker to child hooks", () => {
  const dir = makeTempDir("hook-runner-");
  try {
    const child = path.join(dir, "child.mjs");
    writeFileSync(
      child,
      "process.stdout.write(JSON.stringify({ host: process.env.DEVPRO_HOOK_HOST || '' }));\n",
    );

    const result = runWithArgs(["PreToolUse", child, "--host=codex"]);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.deepEqual(parsed, { host: "codex" });
    assert.equal(result.stderr, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run-hook turns a Stop gate's exit 2 with a block decision on stdout into exit 0 (Codex ignores exit 2 plus stdout JSON, exit 0 plus JSON continues the turn)", () => {
  const dir = makeTempDir("hook-runner-");
  try {
    const child = path.join(dir, "child.mjs");
    writeFileSync(
      child,
      "process.stdout.write(JSON.stringify({ decision: 'block', reason: 'finish step 6A' })); process.exit(2);\n",
    );

    for (const eventName of ["Stop", "stop"]) {
      const result = run(eventName, child);
      assert.equal(result.status, 0, `${eventName}: ${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), { decision: "block", reason: "finish step 6A" });
      assert.equal(result.stderr, "");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run-hook keeps failing for exit 2 outside the Stop block-decision shape", () => {
  const dir = makeTempDir("hook-runner-");
  try {
    const blockJson = path.join(dir, "block-json.mjs");
    writeFileSync(
      blockJson,
      "process.stdout.write(JSON.stringify({ decision: 'block', reason: 'x' })); process.exit(2);\n",
    );
    const noJson = path.join(dir, "no-json.mjs");
    writeFileSync(noJson, "process.stderr.write('boom'); process.exit(2);\n");
    const otherDecision = path.join(dir, "other-decision.mjs");
    writeFileSync(
      otherDecision,
      "process.stdout.write(JSON.stringify({ decision: 'approve' })); process.exit(2);\n",
    );

    const preTool = run("PreToolUse", blockJson);
    assert.equal(preTool.status, 1, "only Stop events are remapped");
    assert.match(preTool.stderr, /failed with exit 2/);

    const plain = run("Stop", noJson);
    assert.equal(plain.status, 1, "exit 2 without a block decision is still a failure");
    assert.match(plain.stderr, /failed with exit 2/);

    const other = run("Stop", otherDecision);
    assert.equal(other.status, 1, "only decision:block is remapped");

    const exit1 = path.join(dir, "exit1.mjs");
    writeFileSync(
      exit1,
      "process.stdout.write(JSON.stringify({ decision: 'block', reason: 'x' })); process.exit(1);\n",
    );
    assert.equal(run("Stop", exit1).status, 1, "only exit 2 is remapped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run-hook reports child hook failures with event and script path", () => {
  const dir = makeTempDir("hook-runner-");
  try {
    const child = path.join(dir, "child.mjs");
    writeFileSync(child, "process.stderr.write('boom'); process.exit(7);\n");

    const result = run("Stop", child);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /boom/);
    assert.match(result.stderr, /hook Stop .*child\.mjs failed with exit 7/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run-hook bounds child runtime and fails open on timeout", () => {
  const dir = makeTempDir("hook-runner-");
  try {
    const child = path.join(dir, "child.mjs");
    writeFileSync(
      child,
      [
        "process.stdout.write('partial stdout');",
        "process.stderr.write('partial stderr');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );

    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [runner, "PostToolUse", child], {
      encoding: "utf8",
      input: "{\"tool\":\"Bash\"}",
      env: {
        ...process.env,
        DEVPRO_HOOK_TIMEOUT_MS: "50",
      },
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /timed out after 50ms; fail-open/);
    assert.doesNotMatch(result.stderr, /partial stderr/);
    assert.ok(elapsedMs < 2000, `hook timeout test took ${elapsedMs}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
