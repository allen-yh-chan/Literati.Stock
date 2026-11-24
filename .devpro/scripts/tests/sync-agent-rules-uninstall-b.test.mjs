import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync as nativeSpawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import {
  STATIC_FILES,
  SYNC_DIRS,
  LEGACY_SOURCE_WORKFLOW_FILES,
  LEGACY_SECOND_REVIEW_ARTIFACTS,
  GITIGNORE_MANAGED_BEGIN,
  GITIGNORE_MANAGED_END,
  TEST_SYNC_SOURCE_ROOT_ENV,
  runUninstall,
} from "../sync-agent-rules.mjs";
import {
  maybeRepairClaudeAutoCompact,
  maybeRepairCodexAutoCompact,
} from "../runtime-auto-compact-settings.mjs";
import { SOURCE_ROOT, sourcePath } from "./lib/source-root.mjs";
import { resolveAbsoluteHooksPath } from "../hooks/lib/git-utils.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";

// Full-suite parallelism can starve git-heavy hooksPath fixtures past the default CLI timeout.
const HOOKS_PATH_GIT_TIMEOUT_MS = 120_000;

const FIXTURE_GIT_OVERRIDE_KEYS = new Set([
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
  "GIT_ALLOW_PROTOCOL",
]);

function fixtureGitEnv(cwd, overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!key.startsWith("GIT_") || FIXTURE_GIT_OVERRIDE_KEYS.has(key)) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(cwd, ".git", "fixture-global-config"),
  };
}

function spawnSync(command, args = [], options = {}) {
  if (command !== "git") return nativeSpawnSync(command, args, options);
  const cwd = options.cwd || process.cwd();
  const env = fixtureGitEnv(cwd, options.env || {});
  const result = nativeSpawnSync(command, args, { ...options, env });
  if (args[0] === "init" && result.status === 0) {
    for (const [key, value] of [["core.autocrlf", "false"], ["core.symlinks", "true"]]) {
      nativeSpawnSync("git", ["config", key, value], { cwd, env, encoding: "utf8" });
    }
  }
  return result;
}

async function createPortableTestSymlink(linkTarget, targetPath, kind = "directory") {
  if (process.platform === "win32") {
    await fs.symlink(linkTarget, targetPath, kind === "directory" ? "dir" : "file");
    return;
  }
  await fs.symlink(linkTarget, targetPath);
}

/** When true, run() omits DEVPRO_TEST_SYNC_SOURCE_ROOT (full submod mirror is the source). */
let runUsesFullSubmodSource = false;
let uninstallSourceRoot = SOURCE_ROOT;

async function copyDir(src, dst, { excludeTopLevelNames = new Set() } = {}) {
  await fs.mkdir(dst, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (excludeTopLevelNames.has(entry.name)) {
      continue;
    }
    const entrySrc = path.join(src, entry.name);
    const entryDst = path.join(dst, entry.name);
    if (entry.isSymbolicLink()) {
      const linkTarget = await fs.readlink(entrySrc);
      await createPortableTestSymlink(linkTarget, entryDst);
    } else if (entry.isDirectory()) {
      await copyDir(entrySrc, entryDst);
    } else {
      await fs.copyFile(entrySrc, entryDst);
    }
  }
}

async function copySyncEntrypointLibs(destScriptsDir) {
  const libDest = path.join(destScriptsDir, "lib");
  await fs.mkdir(libDest, { recursive: true });
  // design D5/D6 (refactor-agent-skills-entry) — sync-agent-rules.mjs now
  // imports the frozen legacy-skill-entry allowlists/classifiers and
  // collectEntryTreeSkillSet from these sibling modules.
  for (const name of ["cli-entry.mjs", "prompt-session.mjs", "consumer-pre-pr-checks.mjs", "consumer-second-review-rules.mjs", "second-review-sticky-credential-gate.mjs", "legacy-skill-entry-artifacts.mjs"]) {
    await fs.copyFile(
      path.join(SOURCE_ROOT, ".devpro", "scripts", "lib", name),
      path.join(libDest, name)
    );
  }
  await fs.copyFile(
    path.join(SOURCE_ROOT, ".devpro", "scripts", "lint-agent-skills.mjs"),
    path.join(destScriptsDir, "lint-agent-skills.mjs")
  );
}

async function removeDirEntriesExcept(root, keepNames) {
  await fs.mkdir(root, { recursive: true });
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (keepNames.has(entry.name)) {
      continue;
    }
    await fs.rm(path.join(root, entry.name), { recursive: true, force: true });
  }
}

async function writeTextFile(root, relPath, content) {
  const targetPath = path.join(root, ...relPath.split("/"));
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content);
}

async function createSlimUninstallSource() {
  const sourceRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-uninstall-slim-source-"));
  const skillRel = ".devpro/agent-skills/devpro-workflows/workflows";

  await writeTextFile(sourceRootDir, "AGENTS.md", "# Slim AGENTS\n");
  await writeTextFile(sourceRootDir, "CLAUDE.md", "# Slim Claude\n");
  await writeTextFile(sourceRootDir, "GEMINI.md", "# Slim Gemini\n");
  await writeTextFile(sourceRootDir, ".windsurfrules", "# Slim Windsurf\n");
  await writeTextFile(sourceRootDir, ".claude/statusline.cjs", "module.exports = () => 'ok';\n");
  await writeTextFile(sourceRootDir, ".github/PULL_REQUEST_TEMPLATE.md", "# PR template\n");
  await writeTextFile(sourceRootDir, ".claude/agents/dp-analyst.md", "# Analyst\n");
  await writeTextFile(sourceRootDir, ".codex/agents/dp-second-reviewer.toml", "name = \"dp-second-reviewer\"\n");
  await writeTextFile(sourceRootDir, ".cursor/agents/dp-second-reviewer.md", "# Second reviewer\n");
  await writeTextFile(sourceRootDir, ".devpro/scripts/hooks-git/pre-push", "#!/bin/sh\nexit 0\n");
  await fs.chmod(path.join(sourceRootDir, ".devpro", "scripts", "hooks-git", "pre-push"), 0o755);
  await writeTextFile(
    sourceRootDir,
    ".devpro/agent-rules/gitignore-alignment.md",
    [
      "<!-- devpro-gitignore-baseline begin -->",
      ".worktree/",
      "notes/",
      "node_modules/",
      "packages/",
      ".devpro/scripts/hooks/state/",
      "<!-- devpro-gitignore-baseline end -->",
      "",
    ].join("\n")
  );
  await writeTextFile(
    sourceRootDir,
    ".claude/settings.json",
    JSON.stringify(
      {
        model: "test-model",
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "true" }] },
          ],
        },
        statusLine: { type: "command", command: "echo ok" },
      },
      null,
      2
    ) + "\n"
  );
  await writeTextFile(
    sourceRootDir,
    ".codex/hooks.json",
    JSON.stringify({ hooks: { pre_tool_use: [{ command: "true" }] } }, null, 2) + "\n"
  );
  await writeTextFile(
    sourceRootDir,
    ".cursor/hooks.json",
    JSON.stringify({ version: 1, hooks: { pre_tool_use: [{ command: "true" }] } }, null, 2) + "\n"
  );
  await writeTextFile(sourceRootDir, `${skillRel}/SKILL.md`, "# Workflows\n");
  await writeTextFile(
    sourceRootDir,
    ".devpro/agent-skills/manifest.json",
    JSON.stringify(
      {
        groups: [
          {
            name: "devpro-workflows",
            skills: [{ path: skillRel }],
          },
        ],
      },
      null,
      2
    ) + "\n"
  );
  // design D1 — plugin manifest is a managed FILE output at the catalog
  // root (not a skill target).
  await writeTextFile(
    sourceRootDir,
    ".devpro/agent-skills/.claude-plugin/plugin.json",
    JSON.stringify({ name: "devpro", description: "Slim fixture", skills: [] }, null, 2) + "\n"
  );
  // design D2 — refs root/manifest (empty; this fixture has no refs).
  await writeTextFile(
    sourceRootDir,
    ".devpro/agent-skills-refs/manifest.json",
    JSON.stringify({ name: "devpro-agent-skill-refs", groups: [] }, null, 2) + "\n"
  );

  // design D3 — discovery is a single `devpro` entry per root, resolving
  // to the catalog root itself (not a per-skill link). Individual tests in
  // legacy-skill-names:begin uninstall-leftover-symlink-name-prose
  // this file separately add a manual per-skill `dp-workflows` symlink
  // legacy-skill-names:end uninstall-leftover-symlink-name-prose
  // ALONGSIDE this entry on the consumer side to simulate leftover D-class
  // artifacts; the source fixture itself only ever ships the one entry.
  for (const discoveryDir of [".agents/skills", ".claude/skills"]) {
    const targetPath = path.join(sourceRootDir, ...discoveryDir.split("/"), "devpro");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await createPortableTestSymlink("../../.devpro/agent-skills", targetPath);
  }

  return sourceRootDir;
}

/**
 * Create a temp consumer repo with a bootstrap .devpro-agent-rules submodule.
 * @param {{ fullSubmod?: boolean }} opts
 *   fullSubmod=true — legacy mirror of STATIC_FILES + SYNC_DIRS into submod (mutate-source tests).
 *   fullSubmod=false (default) — slim bootstrap; run() points sync at real sourceRoot via test env.
 */
async function createConsumerRepo({ fullSubmod = false } = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-test-"));
  const submod = path.join(tmpDir, ".devpro-agent-rules");

  await fs.mkdir(path.join(submod, ".devpro", "scripts"), { recursive: true });
  await fs.mkdir(path.join(submod, ".github"), { recursive: true });

  await fs.copyFile(
    path.join(SOURCE_ROOT, ".devpro", "scripts", "sync-agent-rules.mjs"),
    path.join(submod, ".devpro", "scripts", "sync-agent-rules.mjs")
  );
  await copySyncEntrypointLibs(path.join(submod, ".devpro", "scripts"));
  await copyDir(
    path.join(SOURCE_ROOT, ".devpro", "scripts", "hooks", "lib"),
    path.join(submod, ".devpro", "scripts", "hooks", "lib")
  );
  await fs.copyFile(
    sourcePath("AGENTS.md"),
    path.join(submod, "AGENTS.md")
  );

  if (fullSubmod) {
    for (const subdir of ["agents", "skills"]) {
      const claudeSubdirSrc = path.join(SOURCE_ROOT, ".claude", subdir);
      if (await fs.access(claudeSubdirSrc).then(() => true).catch(() => false)) {
        await copyDir(claudeSubdirSrc, path.join(submod, ".claude", subdir));
      }
    }

    const settingsSrc = path.join(SOURCE_ROOT, ".claude", "settings.json");
    if (await fs.access(settingsSrc).then(() => true).catch(() => false)) {
      await fs.copyFile(settingsSrc, path.join(submod, ".claude", "settings.json"));
    }
    for (const { relPath } of STATIC_FILES) {
      const src = path.join(SOURCE_ROOT, relPath);
      if (await fs.access(src).then(() => true).catch(() => false)) {
        const dst = path.join(submod, relPath);
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.copyFile(src, dst);
      }
    }
    for (const { relPath } of SYNC_DIRS) {
      const src = path.join(SOURCE_ROOT, relPath);
      if (await fs.access(src).then(() => true).catch(() => false)) {
        await copyDir(src, path.join(submod, relPath));
      }
    }
  }

  const syncScript = path.join(submod, ".devpro", "scripts", "sync-agent-rules.mjs");
  return { tmpDir, submod, syncScript, fullSubmod };
}

function run(script, args = "", { cwd, env: extraEnv = {}, input, timeout = 30_000, fullSubmodSource = runUsesFullSubmodSource, useTestSourceRoot = !fullSubmodSource, testSourceRoot = useTestSourceRoot ? uninstallSourceRoot : null } = {}) {
  const env = { ...fixtureGitEnv(cwd || process.cwd()), ...extraEnv };
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = cwd ? path.join(cwd, ".git", "fixture-global-config") : "";
  if (testSourceRoot) {
    env[TEST_SYNC_SOURCE_ROOT_ENV] = testSourceRoot;
  } else {
    delete env[TEST_SYNC_SOURCE_ROOT_ENV];
  }
  const result = spawnSync(process.execPath, [script, ...args.split(/\s+/).filter(Boolean)], {
    encoding: "utf8",
    cwd,
    env,
    input,
    // 30s (was 10s): the git-heavy uninstall tests run --sync + real git
    // worktree/config ops; under full-suite parallel CPU contention a single
    // --sync can approach the old 10s ceiling, causing non-deterministic
    // SIGTERM kills. Per-call override still available for tighter cases.
    timeout,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status,
  };
}

async function withConsumerRepo(fn, { fullSubmod = false } = {}) {
  const ctx = await createConsumerRepo({ fullSubmod });
  const prev = runUsesFullSubmodSource;
  runUsesFullSubmodSource = fullSubmod;
  try {
    return await fn(ctx);
  } finally {
    runUsesFullSubmodSource = prev;
    await fs.rm(ctx.tmpDir, { recursive: true, force: true });
  }
}

async function copyDirRecursive(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const entrySrc = path.join(src, entry.name);
    const entryDst = path.join(dst, entry.name);
    if (entry.isSymbolicLink()) {
      // Preserve symlinks verbatim (same rationale as copyDir() above): a
      // relative link must keep its original target, never be materialized via
      // copyFile following it, so the fixture faithfully mirrors a git-cloned
      // tree. Its current call sites copy only `.devpro/scripts/hooks/lib`
      // (which holds no symlinks today), but keeping the two copy helpers
      // symmetric prevents a silent materialization if either is ever pointed
      // at a symlink-bearing tree.
      const linkTarget = await fs.readlink(entrySrc);
      await createPortableTestSymlink(linkTarget, entryDst);
    } else if (entry.isDirectory()) {
      await copyDirRecursive(entrySrc, entryDst);
    } else {
      await fs.copyFile(entrySrc, entryDst);
    }
  }
}

/**
 * T7 fixture — a standalone git repo (NOT createConsumerRepo()'s plain-copy
 * fixture, which already occupies `.devpro-agent-rules` as a plain directory
 * for bootstrap source-root resolution) with a REAL git submodule registered
 * at `.devpro-agent-rules` via `git submodule add` against a local throwaway
 * repo (`-c protocol.file.allow=always` permits the local `file://`-style
 * path) so applyDClassRemoval()'s `git submodule deinit` + `git rm` path has
 * real submodule state to act on. Falls back to a hand-written `.gitmodules`
 * (no real submodule wiring) if the sandbox disallows `git submodule add`
 * for local paths (defensive; not expected to trigger in this environment).
 */
async function createConsumerRepoWithSubmodule() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-submod-test-"));
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com",
  };

  // The submodule source repo must look like a minimal .devpro-agent-rules
  // checkout (AGENTS.md + .devpro/scripts/sync-agent-rules.mjs + its
  // hooks/lib/*.mjs runtime deps) so resolveCentralRoot()'s
  // hasSubmoduleSource check recognises the checked out .devpro-agent-rules
  // dir as the source root once submodule add clones it, AND the copied
  // sync-agent-rules.mjs entrypoint can resolve its own relative imports.
  const sourceRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-submod-src-"));
  await fs.mkdir(path.join(sourceRepoDir, ".devpro", "scripts"), { recursive: true });
  await fs.copyFile(
    path.join(SOURCE_ROOT, ".devpro", "scripts", "sync-agent-rules.mjs"),
    path.join(sourceRepoDir, ".devpro", "scripts", "sync-agent-rules.mjs")
  );
  await copySyncEntrypointLibs(path.join(sourceRepoDir, ".devpro", "scripts"));
  await copyDirRecursive(
    path.join(SOURCE_ROOT, ".devpro", "scripts", "hooks", "lib"),
    path.join(sourceRepoDir, ".devpro", "scripts", "hooks", "lib")
  );
  await fs.copyFile(
    sourcePath("AGENTS.md"),
    path.join(sourceRepoDir, "AGENTS.md")
  );
  // gitignoreBaselineEntries() reads the SSOT markers from this leaf on every
  // --sync/--check run; a full --sync (as opposed to the --uninstall-only
  // uses this fixture originally supported) needs it present or syncGitignore
  // throws "Invalid gitignore SSOT markers".
  await fs.mkdir(path.join(sourceRepoDir, ".devpro", "agent-rules"), { recursive: true });
  await fs.copyFile(
    path.join(SOURCE_ROOT, ".devpro", "agent-rules", "gitignore-alignment.md"),
    path.join(sourceRepoDir, ".devpro", "agent-rules", "gitignore-alignment.md")
  );
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: sourceRepoDir, env: gitEnv });
  spawnSync("git", ["add", "-A"], { cwd: sourceRepoDir, env: gitEnv });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: sourceRepoDir, env: gitEnv });

  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: tmpDir, env: gitEnv });

  const addResult = spawnSync(
    "git",
    ["-c", "protocol.file.allow=always", "submodule", "add", sourceRepoDir, ".devpro-agent-rules"],
    { cwd: tmpDir, env: gitEnv, encoding: "utf8" }
  );

  const usedRealSubmodule = addResult.status === 0;
  if (usedRealSubmodule) {
    spawnSync("git", ["commit", "-q", "-m", "add submodule"], { cwd: tmpDir, env: gitEnv });
  } else {
    // Fallback: hand-written .gitmodules + plain directory (no real
    // submodule wiring) — still enough for applyDClassRemoval()'s
    // deinit/rm calls to have a target, even though `git submodule deinit`
    // will be a no-op fail-open in this degraded fixture.
    await fs.mkdir(path.join(tmpDir, ".devpro-agent-rules", ".devpro", "scripts"), { recursive: true });
    await fs.copyFile(
      path.join(sourceRepoDir, ".devpro", "scripts", "sync-agent-rules.mjs"),
      path.join(tmpDir, ".devpro-agent-rules", ".devpro", "scripts", "sync-agent-rules.mjs")
    );
    await copySyncEntrypointLibs(path.join(tmpDir, ".devpro-agent-rules", ".devpro", "scripts"));
    await copyDirRecursive(
      path.join(sourceRepoDir, ".devpro", "scripts", "hooks", "lib"),
      path.join(tmpDir, ".devpro-agent-rules", ".devpro", "scripts", "hooks", "lib")
    );
    await fs.copyFile(
      path.join(sourceRepoDir, "AGENTS.md"),
      path.join(tmpDir, ".devpro-agent-rules", "AGENTS.md")
    );
    await fs.mkdir(path.join(tmpDir, ".devpro-agent-rules", ".devpro", "agent-rules"), { recursive: true });
    await fs.copyFile(
      path.join(sourceRepoDir, ".devpro", "agent-rules", "gitignore-alignment.md"),
      path.join(tmpDir, ".devpro-agent-rules", ".devpro", "agent-rules", "gitignore-alignment.md")
    );
    await fs.writeFile(
      path.join(tmpDir, ".gitmodules"),
      `[submodule ".devpro-agent-rules"]\n\tpath = .devpro-agent-rules\n\turl = ${sourceRepoDir}\n`
    );
    spawnSync("git", ["add", ".gitmodules"], { cwd: tmpDir, env: gitEnv });
    spawnSync("git", ["commit", "-q", "-m", "add fake submodule entry"], { cwd: tmpDir, env: gitEnv });
  }

  const syncScript = path.join(tmpDir, ".devpro-agent-rules", ".devpro", "scripts", "sync-agent-rules.mjs");
  return { tmpDir, sourceRepoDir, usedRealSubmodule, gitEnv, syncScript };
}

async function cleanupConsumerRepoWithSubmodule(ctx) {
  await fs.rm(ctx.tmpDir, { recursive: true, force: true });
  await fs.rm(ctx.sourceRepoDir, { recursive: true, force: true });
}

function countGitignoreEntry(content, entry) {
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim() === entry).length;
}

async function readFileOrEmptyLocal(targetPath) {
  try {
    return await fs.readFile(targetPath, "utf8");
  } catch {
    return "";
  }
}

async function createFakeCommand(binDir, name) {
  const commandPath = path.join(binDir, name);
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

async function createLegacySecondReviewArtifact(root, relPath) {
  const artifactPath = path.join(root, relPath);
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });

  if (relPath === ".devpro/agent-skills/devpro-reviews/dp-second-reviewer") {
    await fs.mkdir(artifactPath, { recursive: true });
    await fs.writeFile(path.join(artifactPath, "SKILL.md"), "# legacy dp-second-reviewer skill\n");
    return;
  }

  if (relPath.includes("/skills/")) {
    await fs.symlink(
      "../../.devpro/agent-skills/devpro-reviews/dp-second-reviewer",
      artifactPath
    );
    return;
  }

  throw new Error(`Unexpected legacy second-review artifact fixture path: ${relPath}`);
}

async function lstatExists(targetPath) {
  return fs.lstat(targetPath).then(() => true).catch(() => false);
}

/**
 * T9 fixture — a consumer repo with:
 *   - a real local bare repo as `origin` (so `git push -u origin ...` succeeds
 *     against a real ref transport with no network, rather than being faked)
 *   - a fake `gh` on PATH (via createFakeCommand) that echoes a fixed PR URL
 *     to stdout and records its argv to `ghArgsFile` for assertion — real
 *     `gh` would need network + auth, which this sandbox cannot provide, so
 *     only the `gh pr create` leg is faked; `git` itself is real throughout.
 *   - an initial commit on `main` so `--git-flow`'s `checkout -b` has a base.
 *
 * `binDir`'s fake `gh` is prepended to PATH by the caller via `run()`'s `env`
 * option; PATH is NOT overridden wholesale so the real `git` stays reachable.
 */
async function createGitFlowFixture() {
  const local = await createConsumerRepo();
  const originDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-origin-"));
  const binDir = path.join(local.tmpDir, "git-flow-bin");
  const ghArgsFile = path.join(local.tmpDir, "gh-args.txt");
  const ghBodyCaptureFile = path.join(local.tmpDir, "gh-body-capture.txt");

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com",
  };

  spawnSync("git", ["init", "-q", "--bare"], { cwd: originDir, env: gitEnv });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: local.tmpDir, env: gitEnv });
  spawnSync("git", ["remote", "add", "origin", originDir], { cwd: local.tmpDir, env: gitEnv });

  run(local.syncScript, "--sync", { cwd: local.tmpDir });

  spawnSync("git", ["add", "-A"], { cwd: local.tmpDir, env: gitEnv });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: local.tmpDir, env: gitEnv });
  spawnSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: local.tmpDir, env: gitEnv });

  await fs.mkdir(binDir, { recursive: true });
  const ghPath = path.join(binDir, "gh");
  // The real script deletes its --body-file temp file in a `finally` right
  // after invoking `gh`, so this fake copies the body content out to a
  // fixture-owned capture file BEFORE exiting, so the test can still inspect
  // it afterwards.
  await fs.writeFile(
    ghPath,
    "#!/bin/sh\n" +
      `echo "$@" >> "${ghArgsFile}"\n` +
      "prev=\"\"\n" +
      "for arg in \"$@\"; do\n" +
      '  if [ "$prev" = "--body-file" ]; then\n' +
      `    cp "$arg" "${ghBodyCaptureFile}"\n` +
      "  fi\n" +
      '  prev="$arg"\n' +
      "done\n" +
      'echo "https://github.com/devpro-tw/example/pull/1"\n' +
      "exit 0\n"
  );
  await fs.chmod(ghPath, 0o755);

  return { ...local, originDir, binDir, ghArgsFile, ghBodyCaptureFile, gitEnv };
}

async function cleanupGitFlowFixture(ctx) {
  await fs.rm(ctx.tmpDir, { recursive: true, force: true });
  await fs.rm(ctx.originDir, { recursive: true, force: true });
}

function gitFlowEnv(binDir) {
  return { PATH: `${binDir}:${process.env.PATH}` };
}

function autoCompactEnv(homeDir, binDir) {
  return {
    HOME: homeDir,
    PATH: binDir,
    SHELL: "/bin/zsh",
  };
}

async function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withFixtureGitEnv(cwd, fn) {
  const previous = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_")) {
      previous[key] = process.env[key];
      delete process.env[key];
    }
  }
  const env = fixtureGitEnv(cwd, {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t.com",
  });
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("GIT_")) process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("GIT_")) delete process.env[key];
    }
    for (const [key, value] of Object.entries(previous)) process.env[key] = value;
  }
}

function fakePromptSession(answer) {
  return {
    async ask() {
      return answer;
    },
    close() {},
  };
}

/**
 * T8 — in-process TTY-interaction simulation for runUninstall()'s
 * createPromptSession()/askYesNo() gate. runUninstall() has no injectable
 * promptSession parameter (it always calls the module-internal
 * createPromptSession(), which reads `process.stdin.isTTY` + wires a real
 * `node:readline/promises` interface against `process.stdin`), so this
 * helper temporarily replaces `process.stdin` with a fake Readable stream
 * whose `isTTY` is forced `true`, runs `fn()`, then feeds `answerLine`
 * (e.g. "n\n") into the stream so the pending `rl.question()` resolves.
 * `process.stdin`'s original property descriptor is restored in `finally`
 * regardless of outcome.
 *
 * @param {string} answerLine - raw line (with trailing \n) to feed as the
 *   simulated keystroke, e.g. "n\n" or "y\n"
 * @param {() => Promise<unknown>} fn - the in-process call to run against
 *   the faked TTY (typically a runUninstall(...) call)
 */
async function withFakeTty(answerLine, fn) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  const fakeStdin = new Readable({ read() {} });
  Object.defineProperty(fakeStdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });

  try {
    const resultPromise = fn();
    // Give createInterface()/rl.question() a tick to attach its listener
    // before the simulated keystroke arrives.
    await new Promise((resolve) => setImmediate(resolve));
    fakeStdin.push(answerLine);
    return await resultPromise;
  } finally {
    Object.defineProperty(process, "stdin", originalDescriptor);
  }
}

function captureConsole(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => { lines.push(args.join(" ")); };
  console.error = (...args) => { lines.push(args.join(" ")); };
  return (async () => {
    try {
      await fn();
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    return lines.join("\n");
  })();
}

async function runUninstallInProcess(consumerRoot, options = {}) {
  return withFixtureGitEnv(consumerRoot, () => withEnv(
    {
      [TEST_SYNC_SOURCE_ROOT_ENV]: uninstallSourceRoot,
    },
    () => captureConsole(() => runUninstall(consumerRoot, options))
  ));
}

// ---------------------------------------------------------------------------
// --uninstall (split from sync-agent-rules.test.mjs for file-level parallelism)
// ---------------------------------------------------------------------------

describe("--uninstall", () => {
  let syncedCtx;
  let syncedSnapshotDir;

  before(async () => {
    uninstallSourceRoot = await createSlimUninstallSource();
    syncedCtx = await createConsumerRepo();
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: syncedCtx.tmpDir, encoding: "utf8" });
    run(syncedCtx.syncScript, "--sync", {
      cwd: syncedCtx.tmpDir,
      testSourceRoot: uninstallSourceRoot,
    });
    syncedSnapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-uninstall-b-snapshot-"));
    await copyDir(syncedCtx.tmpDir, syncedSnapshotDir, {
      excludeTopLevelNames: new Set([".devpro-agent-rules"]),
    });
  });

  after(async () => {
    if (syncedCtx) {
      await fs.rm(syncedCtx.tmpDir, { recursive: true, force: true });
    }
    if (syncedSnapshotDir) {
      await fs.rm(syncedSnapshotDir, { recursive: true, force: true });
    }
    if (uninstallSourceRoot !== SOURCE_ROOT) {
      await fs.rm(uninstallSourceRoot, { recursive: true, force: true });
      uninstallSourceRoot = SOURCE_ROOT;
    }
  });

  async function resetSyncedConsumer() {
    await removeDirEntriesExcept(syncedCtx.tmpDir, new Set([".devpro-agent-rules"]));
    await copyDir(syncedSnapshotDir, syncedCtx.tmpDir);
    return syncedCtx;
  }

  // F-rase-pr-r1-10 (done_when 3): a migrated consumer's two `devpro`
  // entries are listed by dry-run and removed by apply; a consumer-owned
  // skill beside them is neither listed nor removed.
  it("dry-run lists AND apply removes a migrated consumer's two devpro entries, keeping its own skill", async () => {
    const local = await resetSyncedConsumer();
    const entryPaths = [
      path.join(local.tmpDir, ".agents", "skills", "devpro"),
      path.join(local.tmpDir, ".claude", "skills", "devpro"),
    ];
    for (const entryPath of entryPaths) {
      assert.equal((await fs.lstat(entryPath)).isSymbolicLink(), true, `${entryPath} must be installed by --sync`);
    }
    const ownSkillDir = path.join(local.tmpDir, ".claude", "skills", "own-consumer-skill");
    await fs.mkdir(ownSkillDir, { recursive: true });
    await fs.writeFile(path.join(ownSkillDir, "SKILL.md"), "# own consumer skill\n");

    const dryStdout = await runUninstallInProcess(local.tmpDir, { dryRun: true });
    assert.match(dryStdout, /\.agents[\\/]skills[\\/]devpro \(symlink\)/);
    assert.match(dryStdout, /\.claude[\\/]skills[\\/]devpro \(symlink\)/);
    assert.doesNotMatch(dryStdout, /own-consumer-skill/);

    const applyStdout = await runUninstallInProcess(local.tmpDir, { yes: true });
    assert.match(applyStdout, /Removed \.agents[\\/]skills[\\/]devpro\b/);
    assert.match(applyStdout, /Removed \.claude[\\/]skills[\\/]devpro\b/);
    assert.doesNotMatch(applyStdout, /own-consumer-skill/);
    for (const entryPath of entryPaths) {
      assert.equal(await fs.lstat(entryPath).catch(() => null), null, `${entryPath} must be removed by apply`);
    }
    assert.equal(await fs.readFile(path.join(ownSkillDir, "SKILL.md"), "utf8"), "# own consumer skill\n");
  });

  // legacy-skill-names:begin uninstall-leftover-per-skill-symlink-fixtures
  it("apply removes the .agents/skills/dp-workflows symlink", async () => {
    const local = await resetSyncedConsumer();

    // --sync (R1) already recreates this as a real symlink pointing into
    // the consumer's own .devpro/agent-skills tree; replace it with the
    // exact fixture shape this test wants to assert against, rather than
    // colliding with what --sync already placed there.
    const skillsDir = path.join(local.tmpDir, ".agents", "skills");
    const symlinkPath = path.join(skillsDir, "dp-workflows");
    await fs.rm(symlinkPath, { recursive: true, force: true });
    await fs.symlink(
      path.join(local.tmpDir, ".devpro", "agent-skills"),
      symlinkPath,
      "dir"
    );

    const stdout = await runUninstallInProcess(local.tmpDir, { yes: true });
    assert.match(stdout, /Removed \.agents[\\/]skills[\\/]dp-workflows/);

    const symlinkExistsAfter = await fs
      .lstat(symlinkPath)
      .then(() => true)
      .catch(() => false);
    assert.equal(symlinkExistsAfter, false, "the dp-workflows symlink must be removed");
  });

  it("apply does NOT remove a plain file at .agents/skills/dp-workflows (not our symlink)", async () => {
    const local = await resetSyncedConsumer();

    // Replace whatever --sync (R1) placed at this path (now a real
    // symlink) with a plain file, to exercise the "not our symlink" branch.
    const skillsDir = path.join(local.tmpDir, ".agents", "skills");
    const plainFilePath = path.join(skillsDir, "dp-workflows");
    await fs.rm(plainFilePath, { recursive: true, force: true });
    await fs.writeFile(plainFilePath, "consumer's own file");

    const stdout = await runUninstallInProcess(local.tmpDir, { yes: true });
    assert.doesNotMatch(
      stdout,
      /Removed \.agents[\\/]skills[\\/]dp-workflows/,
      "must not claim to have removed a consumer-owned plain file"
    );

    const contentAfter = await fs.readFile(plainFilePath, "utf8");
    assert.equal(contentAfter, "consumer's own file", "the consumer's plain file must survive untouched");
  });

  it("apply does NOT remove a plain directory at .agents/skills/dp-workflows (not our symlink)", async () => {
    const local = await resetSyncedConsumer();

    // Replace whatever --sync (R1) placed at this path (now a real
    // symlink) with a plain directory, to exercise the "not our symlink"
    // branch.
    const skillsDir = path.join(local.tmpDir, ".agents", "skills");
    const plainDirPath = path.join(skillsDir, "dp-workflows");
    await fs.rm(plainDirPath, { recursive: true, force: true });
    await fs.mkdir(plainDirPath, { recursive: true });
    const markerFilePath = path.join(plainDirPath, "marker.txt");
    await fs.writeFile(markerFilePath, "consumer's own directory");

    const stdout = await runUninstallInProcess(local.tmpDir, { yes: true });
    assert.doesNotMatch(
      stdout,
      /Removed \.agents[\\/]skills[\\/]dp-workflows/,
      "must not claim to have removed a consumer-owned plain directory"
    );

    const contentAfter = await fs.readFile(markerFilePath, "utf8");
    assert.equal(contentAfter, "consumer's own directory", "the consumer's plain directory must survive untouched");
  });

  // I2 regression: dry-run's skills-symlink classification must match apply's
  // (both use fs.lstat().isSymbolicLink()), so a plain file/dir at
  // .agents/skills/dp-workflows is never falsely listed as "would remove",
  // and a real symlink is always listed. Mirrors the three apply-side cases
  // directly above.
  it("dry-run does NOT list .agents/skills/dp-workflows when it is a plain file (not our symlink)", async () => {
    const local = await resetSyncedConsumer();

    // Replace whatever --sync (R1) placed at this path (now a real
    // symlink) with a plain file, to exercise the "not our symlink" branch.
    const skillsDir = path.join(local.tmpDir, ".agents", "skills");
    const plainFilePath = path.join(skillsDir, "dp-workflows");
    await fs.rm(plainFilePath, { recursive: true, force: true });
    await fs.writeFile(plainFilePath, "consumer's own file");

    const stdout = await runUninstallInProcess(local.tmpDir, { dryRun: true });
    assert.doesNotMatch(
      stdout,
      /\.agents[\\/]skills[\\/]dp-workflows \(symlink\)/,
      "dry-run must not classify a consumer-owned plain file as our symlink artifact"
    );
  });

  it("dry-run does NOT list .agents/skills/dp-workflows when it is a plain directory (not our symlink)", async () => {
    const local = await resetSyncedConsumer();

    // Replace whatever --sync (R1) placed at this path (now a real
    // symlink) with a plain directory, to exercise the "not our symlink"
    // branch.
    const skillsDir = path.join(local.tmpDir, ".agents", "skills");
    const plainDirPath = path.join(skillsDir, "dp-workflows");
    await fs.rm(plainDirPath, { recursive: true, force: true });
    await fs.mkdir(plainDirPath, { recursive: true });
    await fs.writeFile(path.join(plainDirPath, "marker.txt"), "consumer's own directory");

    const stdout = await runUninstallInProcess(local.tmpDir, { dryRun: true });
    assert.doesNotMatch(
      stdout,
      /\.agents[\\/]skills[\\/]dp-workflows \(symlink\)/,
      "dry-run must not classify a consumer-owned plain directory as our symlink artifact"
    );
  });

  it("dry-run DOES list .agents/skills/dp-workflows when it is a real symlink", async () => {
    const local = await resetSyncedConsumer();

    // --sync (R1) already recreates this as a real symlink; replace it
    // with the exact fixture shape this test wants to assert against.
    const skillsDir = path.join(local.tmpDir, ".agents", "skills");
    const symlinkPath = path.join(skillsDir, "dp-workflows");
    await fs.rm(symlinkPath, { recursive: true, force: true });
    await fs.symlink(
      path.join(local.tmpDir, ".devpro", "agent-skills"),
      symlinkPath,
      "dir"
    );

    const stdout = await runUninstallInProcess(local.tmpDir, { dryRun: true });
    assert.match(
      stdout,
      /\.agents[\\/]skills[\\/]dp-workflows \(symlink\)/,
      "dry-run must classify a real symlink as our symlink artifact"
    );
  });

  // I2 broken-symlink boundary regression (per PR #1456 cross-model catch):
  // fs.lstat().isSymbolicLink() returns true for a *broken* (dangling) symlink,
  // so a broken symlink at .agents/skills/dp-workflows is our removable stale
  // managed artifact — it MUST be listed by dry-run AND removed by apply, and
  // the two sides MUST agree (only a plain file/dir is left alone). This pins
  // the exact boundary the spec scenario "Dry-Run And Apply Agree On Skills
  // Symlink Type" now asserts, closing the earlier scenario-wording drift that
  // wrongly grouped broken symlinks with excluded plain files/dirs.
  it("dry-run lists AND apply removes a broken symlink at .agents/skills/dp-workflows (both sides agree)", async () => {
    const local = await resetSyncedConsumer();

    // --sync (R1) already recreates this as a real symlink; replace it
    // with a broken/dangling symlink to exercise this boundary case.
    const skillsDir = path.join(local.tmpDir, ".agents", "skills");
    const symlinkPath = path.join(skillsDir, "dp-workflows");
    await fs.rm(symlinkPath, { recursive: true, force: true });
    // Point at a target that does not exist, but still rooted under
    // .devpro/agent-skills/ (our own namespace) -> a broken/dangling
    // symlink whose stale target is still unambiguously "ours" per
    // collectDevproSkillSymlinks()'s path.resolve()-only resolution (no
    // existence check needed to classify it).
    await fs.symlink(
      path.join(local.tmpDir, ".devpro", "agent-skills", "devpro-workflows", "dp-workflows-stale"),
      symlinkPath,
      "dir"
    );

    // dry-run side: broken symlink MUST be listed as our artifact.
    const dryStdout = await runUninstallInProcess(local.tmpDir, { dryRun: true });
    assert.match(
      dryStdout,
      /\.agents[\\/]skills[\\/]dp-workflows \(symlink\)/,
      "dry-run must list a broken symlink (lstat().isSymbolicLink() === true) as our removable artifact"
    );

    // apply side: broken symlink MUST actually be removed, matching the preview.
    const applyStdout = await runUninstallInProcess(local.tmpDir, { yes: true });
    assert.match(applyStdout, /Removed \.agents[\\/]skills[\\/]dp-workflows/);

    const stillPresent = await fs
      .lstat(symlinkPath)
      .then(() => true)
      .catch(() => false);
    assert.equal(stillPresent, false, "the broken dp-workflows symlink must be removed by apply");
  });

  // Generalization regression: uninstall must not hard-code a single skill
  // name/discovery-dir — it must remove EVERY skill discovery symlink across
  // the active discovery roots (.agents/skills, .claude/skills) plus the
  // retired legacy .cursor/skills root (design D3 of
  // remove-cursor-skill-discovery: --sync no longer distributes into
  // .cursor/skills, but --uninstall keeps scanning it so a devpro-owned
  // symlink left over from before the retirement is still cleaned up), not
  // just .agents/skills/dp-workflows. Covers both dry-run's plan and apply's
  // actual removal, and pins that they agree. This is also the regression
  // guard for the `Uninstall Still Removes Devpro-Owned Legacy Skill
  // Discovery Symlinks` spec scenario (consumer-adoption-tooling).
  it("dry-run lists AND apply removes multiple skill discovery symlinks across active roots plus the legacy .cursor/skills root (Uninstall Still Removes Devpro-Owned Legacy Skill Discovery Symlinks)", async () => {
    const local = await resetSyncedConsumer();

    // design D3 (refactor-agent-skills-entry) — --sync now only ever
    // creates the single `devpro` entry, never a per-skill link, so this
    // test manually adds a leftover-style `dp-workflows` per-skill symlink
    // under `.agents/skills` (simulating a consumer that has not yet run
    // --sync against the current source and still holds one from before
    // the 2-entry migration) alongside two more of our own managed
    // symlinks under the other two discovery roots (.claude/skills, and
    // the retired legacy .cursor/skills root), pointing at a
    // plausible-looking (but non-existent, i.e. broken — irrelevant to
    // inclusion per the path.resolve()-only check) skill dir under this
    // consumer's own .devpro/agent-skills/ tree.
    const agentsSkillsDir = path.join(local.tmpDir, ".agents", "skills");
    const claudeSkillsDir = path.join(local.tmpDir, ".claude", "skills");
    const cursorSkillsDir = path.join(local.tmpDir, ".cursor", "skills");
    await fs.mkdir(agentsSkillsDir, { recursive: true });
    await fs.mkdir(claudeSkillsDir, { recursive: true });
    await fs.mkdir(cursorSkillsDir, { recursive: true });

    const agentsSymlinkPath = path.join(agentsSkillsDir, "dp-workflows");
    await fs.symlink(
      path.join(local.tmpDir, ".devpro", "agent-skills", "devpro-workflows", "dp-workflows"),
      agentsSymlinkPath,
      "dir"
    );
    const claudeSymlinkPath = path.join(claudeSkillsDir, "dp-extra-one");
    const cursorSymlinkPath = path.join(cursorSkillsDir, "dp-extra-two");
    await fs.symlink(
      path.join(local.tmpDir, ".devpro", "agent-skills", "devpro-workflows", "dp-extra-one"),
      claudeSymlinkPath,
      "dir"
    );
    await fs.symlink(
      path.join(local.tmpDir, ".devpro", "agent-skills", "devpro-workflows", "dp-extra-two"),
      cursorSymlinkPath,
      "dir"
    );

    // Scenario boundary clause (same file, both AND clauses): under the
    // legacy .cursor/skills root specifically — not just the active roots
    // covered by sibling tests — a consumer-authored symlink pointing
    // OUTSIDE .devpro/agent-skills/, and a plain file/directory, are NOT our
    // artifacts and MUST survive both dry-run's plan and apply's removal.
    const cursorForeignSymlinkPath = path.join(cursorSkillsDir, "dp-foreign");
    const cursorForeignTarget = await fs.mkdtemp(path.join(os.tmpdir(), "sync-uninstall-b-foreign-"));
    await fs.symlink(cursorForeignTarget, cursorForeignSymlinkPath, "dir");
    const cursorPlainFilePath = path.join(cursorSkillsDir, "dp-plain");
    await fs.writeFile(cursorPlainFilePath, "consumer-owned plain file, not a symlink\n");

    try {
      // dry-run: all three devpro-owned symlinks must be listed as our
      // removable artifacts; the two boundary nodes must NOT be listed.
      const dryStdout = await runUninstallInProcess(local.tmpDir, { dryRun: true });
      assert.match(dryStdout, /\.agents[\\/]skills[\\/]dp-workflows \(symlink\)/);
      assert.match(dryStdout, /\.claude[\\/]skills[\\/]dp-extra-one \(symlink\)/);
      assert.match(dryStdout, /\.cursor[\\/]skills[\\/]dp-extra-two \(symlink\)/);
      assert.doesNotMatch(dryStdout, /dp-foreign/);
      assert.doesNotMatch(dryStdout, /dp-plain/);

      // apply: all three devpro-owned symlinks must actually be removed.
      const applyStdout = await runUninstallInProcess(local.tmpDir, { yes: true });
      assert.match(applyStdout, /Removed \.agents[\\/]skills[\\/]dp-workflows/);
      assert.match(applyStdout, /Removed \.claude[\\/]skills[\\/]dp-extra-one/);
      assert.match(applyStdout, /Removed \.cursor[\\/]skills[\\/]dp-extra-two/);
      assert.doesNotMatch(applyStdout, /dp-foreign/);
      assert.doesNotMatch(applyStdout, /dp-plain/);

      for (const symlinkPath of [
        path.join(local.tmpDir, ".agents", "skills", "dp-workflows"),
        claudeSymlinkPath,
        cursorSymlinkPath,
      ]) {
        const stillPresent = await fs
          .lstat(symlinkPath)
          .then(() => true)
          .catch(() => false);
        assert.equal(stillPresent, false, `${symlinkPath} must be removed by apply`);
      }

      // Boundary nodes must survive apply untouched.
      assert.equal(
        await fs.readlink(cursorForeignSymlinkPath).catch(() => null),
        cursorForeignTarget,
        "a consumer-authored .cursor/skills symlink pointing outside .devpro/agent-skills/ must survive apply"
      );
      assert.equal(
        await fs.readFile(cursorPlainFilePath, "utf8").catch(() => null),
        "consumer-owned plain file, not a symlink\n",
        "a plain file under .cursor/skills must survive apply"
      );
    } finally {
      await fs.rm(cursorForeignTarget, { recursive: true, force: true });
    }
  });
  // legacy-skill-names:end uninstall-leftover-per-skill-symlink-fixtures

  // Generalization boundary: a consumer-authored symlink at one of the three
  // discovery dirs that points OUTSIDE this consumer's own
  // .devpro/agent-skills/ tree is not our artifact (e.g. a consumer's own
  // shared skill vendored from elsewhere) and MUST survive both dry-run's
  // plan and apply's removal untouched.
  it("does NOT list or remove a consumer-authored symlink pointing outside .devpro/agent-skills/", async () => {
    const local = await resetSyncedConsumer();

    const claudeSkillsDir = path.join(local.tmpDir, ".claude", "skills");
    await fs.mkdir(claudeSkillsDir, { recursive: true });
    const consumerOwnedTargetDir = path.join(local.tmpDir, "consumer-owned-skills", "my-skill");
    await fs.mkdir(consumerOwnedTargetDir, { recursive: true });
    const consumerSymlinkPath = path.join(claudeSkillsDir, "consumer-owned-skill");
    await fs.symlink(consumerOwnedTargetDir, consumerSymlinkPath, "dir");

    const dryStdout = await runUninstallInProcess(local.tmpDir, { dryRun: true });
    assert.doesNotMatch(
      dryStdout,
      /consumer-owned-skill \(symlink\)/,
      "dry-run must not classify a consumer-authored symlink pointing elsewhere as our artifact"
    );

    const applyStdout = await runUninstallInProcess(local.tmpDir, { yes: true });
    assert.doesNotMatch(
      applyStdout,
      /Removed .*consumer-owned-skill/,
      "must not claim to have removed a consumer-authored symlink pointing elsewhere"
    );

    const stillPresent = await fs
      .lstat(consumerSymlinkPath)
      .then(() => true)
      .catch(() => false);
    assert.equal(stillPresent, true, "the consumer-authored symlink must survive uninstall untouched");

    const resolvedTarget = await fs.readlink(consumerSymlinkPath);
    assert.equal(
      path.resolve(path.dirname(consumerSymlinkPath), resolvedTarget),
      consumerOwnedTargetDir,
      "the consumer-authored symlink's target must be unchanged"
    );
  });

  // design D9 (refactor-agent-skills-entry) negative case: a consumer-built
  // symlink literally NAMED `devpro` (the same basename `--sync` itself now
  // installs) that points OUTSIDE this consumer's own .devpro/agent-skills/
  // tree must still be excluded — collectDevproSkillSymlinks() classifies by
  // target confinement, never by basename, so sharing our reserved entry
  // name must not by itself cause collection.
  it("does NOT list or remove a consumer-authored `devpro`-named symlink pointing outside .devpro/agent-skills/", async () => {
    const local = await resetSyncedConsumer();

    const claudeSkillsDir = path.join(local.tmpDir, ".claude", "skills");
    await fs.rm(path.join(claudeSkillsDir, "devpro"), { recursive: true, force: true });
    const consumerOwnedTargetDir = path.join(local.tmpDir, "consumer-owned-skills", "devpro");
    await fs.mkdir(consumerOwnedTargetDir, { recursive: true });
    const consumerSymlinkPath = path.join(claudeSkillsDir, "devpro");
    await fs.symlink(consumerOwnedTargetDir, consumerSymlinkPath, "dir");

    const dryStdout = await runUninstallInProcess(local.tmpDir, { dryRun: true });
    assert.doesNotMatch(
      dryStdout,
      /\.claude[\\/]skills[\\/]devpro \(symlink\)/,
      "dry-run must not classify a devpro-named symlink pointing elsewhere as our artifact"
    );

    const applyStdout = await runUninstallInProcess(local.tmpDir, { yes: true });
    assert.doesNotMatch(
      applyStdout,
      /Removed \.claude[\\/]skills[\\/]devpro/,
      "must not claim to have removed a devpro-named symlink pointing elsewhere"
    );

    const stillPresent = await fs
      .lstat(consumerSymlinkPath)
      .then(() => true)
      .catch(() => false);
    assert.equal(stillPresent, true, "the devpro-named consumer-authored symlink must survive uninstall untouched");

    const resolvedTarget = await fs.readlink(consumerSymlinkPath);
    assert.equal(
      path.resolve(path.dirname(consumerSymlinkPath), resolvedTarget),
      consumerOwnedTargetDir,
      "the devpro-named consumer-authored symlink's target must be unchanged"
    );
  });

  it("aborts and touches nothing when the TTY confirmation is declined", async () => {
    await withConsumerRepo(async (local) => {
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: local.tmpDir, encoding: "utf8" });
      run(local.syncScript, "--sync", {
        cwd: local.tmpDir,
        testSourceRoot: uninstallSourceRoot,
      });

      const statusBefore = spawnSync("git", ["status", "--porcelain"], {
        cwd: local.tmpDir,
        encoding: "utf8",
      }).stdout;
      const agentsMdPath = path.join(local.tmpDir, "AGENTS.md");
      const agentsMdExistedBefore = await fs.access(agentsMdPath).then(() => true).catch(() => false);
      assert.ok(agentsMdExistedBefore, "precondition: AGENTS.md must exist after --sync");

      const output = await withFakeTty("n\n", () => runUninstallInProcess(local.tmpDir, {}));

      assert.match(output, /Aborted --uninstall \(no changes made\)\./);

      const statusAfter = spawnSync("git", ["status", "--porcelain"], {
        cwd: local.tmpDir,
        encoding: "utf8",
      }).stdout;
      assert.equal(statusAfter, statusBefore, "TTY-declined uninstall must not change git status");

      const agentsMdExistedAfter = await fs.access(agentsMdPath).then(() => true).catch(() => false);
      assert.ok(agentsMdExistedAfter, "TTY-declined uninstall must not delete AGENTS.md");
    });
  });

  it("proceeds with removal when the TTY confirmation is accepted", async () => {
    await withConsumerRepo(async (local) => {
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: local.tmpDir, encoding: "utf8" });
      run(local.syncScript, "--sync", {
        cwd: local.tmpDir,
        testSourceRoot: uninstallSourceRoot,
      });

      const agentsMdPath = path.join(local.tmpDir, "AGENTS.md");
      await withFakeTty("y\n", () => runUninstallInProcess(local.tmpDir, {}));

      const agentsMdExistedAfter = await fs.access(agentsMdPath).then(() => true).catch(() => false);
      assert.equal(agentsMdExistedAfter, false, "TTY-accepted uninstall must remove AGENTS.md");
    });
  });

// ---------------------------------------------------------------------------

});
