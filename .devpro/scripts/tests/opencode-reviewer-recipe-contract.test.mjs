import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  OPENCODE_STICKY_BODY_FILE_NAME,
  ReviewerCliRecipeContractError,
  assertCanonicalReviewerCliRecipe,
  assertOpenCodeReviewerContext,
  assertReviewerModelSelection,
  canonicalReviewerCliRecipe,
  requestedKindForSelection,
  resolveSecondReviewerModel,
  reviewerWritableRootsFromRecipe,
} from "../second-reviewer-cli-recipe-contract.mjs";
import { OPENCODE_REVIEWER_MODEL_OVERRIDE_ENV } from "../lib/opencode-reviewer.mjs";
import { buildOpenCodeReviewerSection, readOpenCodeCliVersion } from "../lib/opencode-launch.mjs";
import { OPENCODE_FIXTURE_NEUTRAL_CWD, buildOpenCodeContext } from "./lib/opencode-context-fixture.mjs";

const neutralCwd = OPENCODE_FIXTURE_NEUTRAL_CWD;

function buildContext({ mutateScope, ...options } = {}) {
  return buildOpenCodeContext({ ...options, mutate: mutateScope });
}

function assertRecipeError(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ReviewerCliRecipeContractError, String(error));
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test("recipe: audit-only OpenCode run is stdin packet mode on an explicit agent and selector", () => {
  const context = buildContext();
  const recipe = canonicalReviewerCliRecipe(context);
  assert.equal(recipe.tool, "opencode");
  assert.deepEqual(recipe.required_invocation_args, [
    "run", "--standalone", "--format", "json",
    "--agent", "devpro-review-audit",
    "--model", "deepseek/deepseek-v4-pro#max",
  ]);
  assert.deepEqual(recipe.required_flags, ["--standalone", "--format", "--agent", "--model"]);
  // No absolute-path flag value, so the generic writable-root derivation grants nothing.
  assert.deepEqual(reviewerWritableRootsFromRecipe(recipe), []);
  assert.equal(recipe.auth_preflight.success_condition, "opencode_token_session_export");
  assert.equal(recipe.auth_preflight.timeout_ms, 60000);
  assert.equal(recipe.auth_preflight.raw_output_policy, "memory-only-do-not-persist");
  assert.deepEqual(recipe.auth_preflight.command.argv.slice(-4), [
    "--agent", "devpro-review-audit", "--model", "deepseek/deepseek-v4-pro#max",
  ]);
  assert.deepEqual(recipe.probe_commands.map((command) => command.argv), [
    ["--version"],
    ["run", "--help"],
    ["session", "export", "--help"],
  ]);
});

test("recipe: an OpenCode v1 CLI cannot be launched, so no v1 context is ever canonicalized", () => {
  assert.throws(() => buildContext({ generation: "v1" }), (error) => error.classification === "opencode_version_unsupported");
});

test("recipe: pr-sticky scope is the one body file plus the exact gated helpers", () => {
  const context = buildContext({ mode: "pr-sticky" });
  const scope = context.reviewer_opencode.launch_scope;
  assert.deepEqual(scope.writable_paths, [path.join(neutralCwd, OPENCODE_STICKY_BODY_FILE_NAME)]);
  assert.deepEqual(scope.readable_roots, []);
  assert.equal(scope.shell_commands.length, 2);
  assert.match(scope.shell_commands[0], /^node \/.*read-second-review-sticky-comment\.mjs$/);
  assert.match(scope.shell_commands[1], /^node \/.*write-second-review-sticky-gated\.mjs$/);
  assert.equal(canonicalReviewerCliRecipe(context).required_invocation_args.includes("devpro-review-sticky"), true);
});

test("recipe: linked issue read adds only gh pr view and the repo-bound helper", () => {
  const context = buildContext({ mode: "pr-sticky", linkedIssue: "issue_read_required" });
  const commands = context.reviewer_opencode.launch_scope.shell_commands;
  assert.ok(commands.includes("gh pr view"));
  assert.ok(commands.some((command) => /read-second-review-linked-issue\.mjs example-org\/example-repo$/.test(command)));
  assert.doesNotThrow(() => assertOpenCodeReviewerContext(context));
});

test("assert: a faithful sidecar recipe round-trips", () => {
  for (const mode of ["audit-only", "pr-sticky"]) {
    const context = buildContext({ mode });
    context.reviewer_cli_recipe = canonicalReviewerCliRecipe(context);
    assert.doesNotThrow(() => assertCanonicalReviewerCliRecipe(context), mode);
  }
});

test("assert: a widened launch scope cannot ride along with a recomputed-looking digest", () => {
  const widened = buildContext({
    mode: "pr-sticky",
    mutateScope(context) {
      context.reviewer_opencode.launch_scope.shell_commands.push("node /evil/exfiltrate.mjs");
    },
  });
  assertRecipeError(() => assertOpenCodeReviewerContext(widened), /launch_scope\.shell_commands/);

  const extraWrite = buildContext({
    mode: "pr-sticky",
    mutateScope(context) {
      context.reviewer_opencode.launch_scope.writable_paths.push("/etc/hosts");
    },
  });
  assertRecipeError(() => assertOpenCodeReviewerContext(extraWrite), /launch_scope\.writable_paths/);

  const readRoot = buildContext({
    mutateScope(context) {
      context.reviewer_opencode.launch_scope.readable_roots.push("/");
    },
  });
  assertRecipeError(() => assertOpenCodeReviewerContext(readRoot), /launch_scope\.readable_roots/);

  const staleDigest = buildContext({
    mutateScope(context) {
      context.reviewer_opencode.launch_scope.instruction_files.push({
        path: "/trusted/AGENTS.md",
        sha256: "a".repeat(64),
      });
    },
  });
  assertRecipeError(() => assertOpenCodeReviewerContext(staleDigest), /launch_config_sha256/);
});

test("assert: tool policy and agent name are fixed by the mode", () => {
  const wrongPolicy = buildContext({
    mutateScope(context) {
      context.reviewer_opencode.tool_policy = "pr-sticky";
      context.reviewer_opencode.agent_name = "devpro-review-sticky";
    },
  });
  assertRecipeError(() => assertOpenCodeReviewerContext(wrongPolicy), /tool_policy\/agent_name/);
});

test("assert: selection family must equal reviewer_family and the selection must be canonical", () => {
  const wrongFamily = buildContext();
  wrongFamily.reviewer_family = "claude";
  assert.throws(() => assertOpenCodeReviewerContext(wrongFamily), /selection family|reviewer_cli_family_mismatch|family/);

  const forged = buildContext({
    mutateScope(context) {
      context.reviewer_opencode.selection = { ...context.reviewer_opencode.selection, modelID: "DEEPSEEK-V4-PRO" };
    },
  });
  assertRecipeError(() => assertOpenCodeReviewerContext(forged));

  const drift = buildContext({
    mutateScope(context) {
      context.reviewer_opencode.cli_version = "2.0.24";
      context.reviewer_opencode.generation = "v1";
    },
  });
  assertRecipeError(() => assertOpenCodeReviewerContext(drift), /agree/);

  const extraKey = buildContext({
    mutateScope(context) {
      context.reviewer_opencode.unreviewed = true;
    },
  });
  assertRecipeError(() => assertOpenCodeReviewerContext(extraKey), /canonical keys/);
});

test("assert: the recipe must pin exactly the carried selector", () => {
  const context = buildContext();
  const recipe = canonicalReviewerCliRecipe(context);
  const swapped = structuredClone(recipe);
  swapped.required_invocation_args[swapped.required_invocation_args.indexOf("deepseek/deepseek-v4-pro#max")] = "deepseek/deepseek-flash";
  context.reviewer_cli_recipe = swapped;
  assertRecipeError(() => assertCanonicalReviewerCliRecipe(context), /--model/);

  const doubled = structuredClone(recipe);
  doubled.required_invocation_args.push("--model", "deepseek/deepseek-flash");
  context.reviewer_cli_recipe = doubled;
  assertRecipeError(() => assertCanonicalReviewerCliRecipe(context), /exactly one --model/);
});

test("selection: automatic and explicit models require replayable catalog evidence", () => {
  const probe = buildContext().reviewer_model_selection.probe;
  const resolved = resolveSecondReviewerModel("opencode", { NODE_ENV: "test" }, { openCodeModelProbe: () => probe });
  assert.equal(resolved.model, probe.selected_model);
  assert.equal(resolved.source, "built-in-default");
  assert.equal(resolved.kind, "exact-id");
  assert.deepEqual(resolved.probe, probe);
  const good = buildContext().reviewer_model_selection;
  assert.doesNotThrow(() => assertReviewerModelSelection(good, "opencode"));
  for (const bad of [
    { ...good, requested: "deepseek-v4-pro" },
    { ...good, requested: "deepseek/deepseek-v4-pro#fast" },
    { ...good, env_var: OPENCODE_REVIEWER_MODEL_OVERRIDE_ENV },
    { ...good, probe: undefined },
    { ...good, requested: "deepseek/deepseek-flash" },
  ]) assert.throws(() => assertReviewerModelSelection(bad, "opencode"));
  assert.throws(() => resolveSecondReviewerModel("opencode", { [OPENCODE_REVIEWER_MODEL_OVERRIDE_ENV]: "ollama/qwen2.5:14b" }), e => e.classification === "opencode_reviewer_family_unverified");
});

test("section builder: the renderer-side builder produces exactly the contract's own section", () => {
  for (const mode of ["audit-only", "pr-sticky"]) {
    const expected = buildContext({ mode, linkedIssue: mode === "pr-sticky" ? "issue_read_required" : "none" });
    const base = { ...expected };
    delete base.reviewer_opencode;
    const section = buildOpenCodeReviewerSection(base, {
      cliVersionText: "2.0.24\n",
      launchConfigPath: expected.reviewer_opencode.launch_config_path,
    });
    assert.deepEqual(section, expected.reviewer_opencode, mode);
    assert.doesNotThrow(() => assertOpenCodeReviewerContext({ ...base, reviewer_opencode: section }), mode);
  }
});

test("section builder: unsupported modes and unreadable versions fail before a section exists", () => {
  const base = { ...buildContext() };
  delete base.reviewer_opencode;
  const sectionFor = (mode) => buildOpenCodeReviewerSection({ ...base, mode }, { cliVersionText: "2.0.24", launchConfigPath: "/tmp/x.json" });
  // The same fixture is valid for both supported modes, so the refusal below can only be about the mode.
  for (const mode of ["audit-only", "pr-sticky"]) assert.equal(sectionFor(mode).cli_version, "2.0.24", mode);
  assert.throws(
    () => sectionFor("ordinary-primary"),
    (error) => error.classification === "reviewer_cli_recipe_invalid" && /mode must be audit-only or pr-sticky/.test(error.message)
  );
  assert.throws(
    () => buildOpenCodeReviewerSection(base, { cliVersionText: "9.9.9", launchConfigPath: "/tmp/x.json" }),
    (error) => error.classification === "opencode_version_unsupported"
  );
  assert.throws(
    () => readOpenCodeCliVersion({ spawn: () => ({ error: new Error("ENOENT"), status: null, stdout: "" }) }),
    (error) => error.classification === "opencode_cli_unavailable"
  );
  assert.equal(readOpenCodeCliVersion({ spawn: () => ({ status: 0, stdout: "2.0.24\n" }) }), "2.0.24\n");
});

test("version probe: a CLI that ignores SIGTERM is cut off at the probe's deadline instead of blocking past it", { skip: process.platform === "win32" && "a shebang script is not directly executable on Windows" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-version-probe-"));
  try {
    const pidFile = path.join(dir, "cli.pid");
    const fake = path.join(dir, "opencode");
    // POSIX sh rather than node: a node child's cold start can outlast a short deadline on a busy machine, which kills it
    // before it records its pid. The trap is installed before the pid is published (atomically, via mv), so "the pid file
    // exists" means the SIGTERM-ignoring child is really running.
    // Would only stop by itself after 4 s; a SIGKILL at the 1500 ms deadline must end it first. 400 ms was still too short
    // for sh to publish its pid while an OpenCode run and the integration tier shared the machine (2026-10-28).
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(fake, `#!/bin/sh\ntrap '' TERM\necho $$ > ${quote(`${pidFile}.tmp`)}\nmv ${quote(`${pidFile}.tmp`)} ${quote(pidFile)}\ni=0\nwhile [ "$i" -lt 4 ]; do sleep 1; i=$((i + 1)); done\n`);
    chmodSync(fake, 0o755);
    const started = Date.now();
    assert.throws(
      () => readOpenCodeCliVersion({ executable: fake, timeoutMs: 1500 }),
      (error) => error.classification === "opencode_cli_unavailable",
    );
    assert.ok(Date.now() - started < 3500, `the probe must stop at its deadline, took ${Date.now() - started} ms`);
    assert.ok(existsSync(pidFile), "the fake CLI did start");
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), (error) => error.code === "ESRCH", "no probe process may survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
