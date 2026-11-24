import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync as nativeSpawnSync } from "node:child_process";
import { promises as fs, writeFileSync } from "node:fs";
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
import { ensureGitHooksPath, resolveAbsoluteHooksPath } from "../hooks/lib/git-utils.mjs";
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
      const targetStats = await fs.stat(entrySrc).catch(() => null);
      await createPortableTestSymlink(
        linkTarget,
        entryDst,
        targetStats?.isDirectory() ? "directory" : "file"
      );
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
  // to the catalog root itself (not a per-skill link).
  for (const discoveryDir of [".agents/skills", ".claude/skills"]) {
    const targetPath = path.join(sourceRootDir, ...discoveryDir.split("/"), "devpro");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await createPortableTestSymlink("../../.devpro/agent-skills", targetPath, "directory");
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
  const env = {
    ...fixtureGitEnv(cwd || process.cwd()),
    ...extraEnv,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: cwd ? path.join(cwd, ".git", "fixture-global-config") : "",
  };
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
      const targetStats = await fs.stat(entrySrc).catch(() => null);
      await createPortableTestSymlink(
        linkTarget,
        entryDst,
        targetStats?.isDirectory() ? "directory" : "file"
      );
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
    await createPortableTestSymlink(
      "../../.devpro/agent-skills/devpro-reviews/dp-second-reviewer",
      artifactPath,
      "directory"
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
async function withFakeTty(answerLine, fn, { beforePrompt } = {}) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  const fakeStdin = new Readable({ read() {} });
  let promptStarted = false;
  Object.defineProperty(fakeStdin, "isTTY", {
    configurable: true,
    get() {
      if (!promptStarted) {
        promptStarted = true;
        beforePrompt?.();
      }
      return true;
    },
  });
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

async function runUninstallInProcess(consumerRoot, options = {}, extraEnv = {}) {
  return withFixtureGitEnv(consumerRoot, () => withEnv(
    {
      [TEST_SYNC_SOURCE_ROOT_ENV]: uninstallSourceRoot,
      ...extraEnv,
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
    syncedSnapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-uninstall-snapshot-"));
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

  for (const label of [".claude/settings.json", ".codex/hooks.json", ".cursor/hooks.json"]) {
    it(`apply rejects ${label} corrupted after planning instead of replacing it`, async () => {
      const local = await resetSyncedConsumer();
      const target = path.join(local.tmpDir, label);
      const raw = '{"hooks":';
      let corruptedAfterPlan = false;
      await assert.rejects(
        withFakeTty("y\n", () => runUninstallInProcess(local.tmpDir), {
          beforePrompt() {
            writeFileSync(target, raw);
            corruptedAfterPlan = true;
          },
        }),
        (error) => /Invalid JSON/i.test(error.message)
          && error.message.includes(label)
          && error.message.includes("re-run --uninstall with the same options"),
      );
      assert.equal(corruptedAfterPlan, true, "the mutation must occur after the plan was read");
      assert.equal(await fs.readFile(target, "utf8"), raw);
    });
  }

  it("dry-run prints A/B/C/D removal lists and makes zero changes", async () => {
    const local = await resetSyncedConsumer();

    const statusBefore = spawnSync("git", ["status", "--porcelain"], {
      cwd: local.tmpDir,
      encoding: "utf8",
    }).stdout;
    const agentsMdExistedBefore = await fs
      .access(path.join(local.tmpDir, "AGENTS.md"))
      .then(() => true)
      .catch(() => false);
    const gitignoreBefore = await readFileOrEmptyLocal(path.join(local.tmpDir, ".gitignore"));

    const stdout = await runUninstallInProcess(local.tmpDir, { dryRun: true });

    assert.match(stdout, /\[dry-run\] would remove/i);
    // A/B/C/D four categories must all be represented in the preview.
    assert.match(stdout, /AGENTS\.md/, "A-class static file removal must be listed");
    // .claude/commands is no longer a CLAUDE_SYNC_SUBDIRS entry (commands
    // removed, see D5/T18); B-class directory removal is now proven against
    // .claude/agents instead, which remains a synced+brought-in subdir.
    assert.match(stdout, /\.claude[\\/]agents/, "B-class directory removal must be listed");
    assert.match(
      stdout,
      /devpro-agent-rules managed (?:begin|block)/i,
      "C-class .gitignore managed block removal must be listed"
    );
    assert.match(
      stdout,
      /submodule|core\.hooksPath/i,
      "D-class submodule/hooksPath removal must be listed"
    );

    const statusAfter = spawnSync("git", ["status", "--porcelain"], {
      cwd: local.tmpDir,
      encoding: "utf8",
    }).stdout;
    assert.equal(statusAfter, statusBefore, "dry-run must not change git status");

    const agentsMdExistedAfter = await fs
      .access(path.join(local.tmpDir, "AGENTS.md"))
      .then(() => true)
      .catch(() => false);
    assert.equal(agentsMdExistedAfter, agentsMdExistedBefore, "dry-run must not delete AGENTS.md");

    const gitignoreAfter = await readFileOrEmptyLocal(path.join(local.tmpDir, ".gitignore"));
    assert.equal(gitignoreAfter, gitignoreBefore, "dry-run must not modify .gitignore");
  });

  // The five `it()` blocks below (source-brought-vs-extras, A-class removal,
  // .gitignore reversal, .gitignore behavior-pinning, settings.json hooks
  // reversal) each independently exercised runUninstall()'s A/B/C-class
  // removal via their OWN `git init` + `--sync` + `--uninstall --yes` spawns.
  // Every one of those apply spawns walks the full fixture tree (~400+ files)
  // and re-pays the same fixed cost for orthogonal assertions on disjoint
  // paths (.claude/agents/**, AGENTS.md/CLAUDE.md/GEMINI.md/.windsurfrules/
  // statusline.cjs, .gitignore, .claude/settings.json). None of the five
  // preconditions touch the same file, so they are combined into ONE shared
  // fixture (`before()`) that applies all five preconditions and runs
  // `--uninstall --yes` exactly once; each `it()` below still performs
  // exactly the assertions its standalone predecessor made, just against the
  // shared post-apply state instead of re-spawning --uninstall itself. Test
  // count is unchanged (still 5 `it()`s); only the spawn count collapses
  // from 5 apply runs to 1.
  describe("apply combined A/B/C-class removal (shared fixture)", () => {
    let local;
    let consumerExtra;
    let sourceBroughtFile;
    const aClassRelPaths = [
      "AGENTS.md",
      "CLAUDE.md",
      "GEMINI.md",
      ".windsurfrules",
      path.join(".claude", "statusline.cjs"),
    ];
    let gitignorePath;
    let sourceHookKey;
    let settingsPath;
    let applyResult;

    before(async () => {
      local = await resetSyncedConsumer();

      gitignorePath = path.join(local.tmpDir, ".gitignore");
      const cleanGitignore = await fs.readFile(gitignorePath, "utf8");
      await fs.writeFile(gitignorePath, `consumer-local/\n.env.local\n${cleanGitignore}`);

      // --- precondition: source-brought file vs. consumer extra ---
      // .claude/commands is no longer a CLAUDE_SYNC_SUBDIRS entry (commands
      // removed, see D5/T18), so it can no longer serve as the "source-brought
      // vs. consumer extra" fixture pair; .claude/agents remains a synced
      // subdir and plays that role instead.
      consumerExtra = path.join(local.tmpDir, ".claude", "agents", "my-custom.md");
      await fs.mkdir(path.dirname(consumerExtra), { recursive: true });
      await fs.writeFile(consumerExtra, "# consumer-owned agent\n");
      sourceBroughtFile = path.join(local.tmpDir, ".claude", "agents", "dp-analyst.md");
      const sourceBroughtExistedBefore = await fs
        .access(sourceBroughtFile)
        .then(() => true)
        .catch(() => false);
      assert.ok(sourceBroughtExistedBefore, "precondition: source-brought file must exist after --sync");

      // --- precondition: five A-class static/root files exist ---
      for (const relPath of aClassRelPaths) {
        const existedBefore = await fs
          .access(path.join(local.tmpDir, relPath))
          .then(() => true)
          .catch(() => false);
        assert.ok(existedBefore, `precondition: ${relPath} must exist after --sync`);
      }

      // --- precondition: .gitignore managed block present ---
      const syncedGitignore = await fs.readFile(gitignorePath, "utf8");
      assert.match(syncedGitignore, new RegExp(GITIGNORE_MANAGED_BEGIN), "precondition: managed block present after --sync");

      // --- precondition (behavior-pinning): manually re-add a
      // baseline-colliding line OUTSIDE the managed block, simulating a user
      // edit that bypasses --sync's own dedup. See the original test's
      // comment (preserved below on the `it()`) for full rationale.
      const beginIdx = syncedGitignore.indexOf(GITIGNORE_MANAGED_BEGIN);
      const endIdx = syncedGitignore.indexOf("devpro-agent-rules managed end");
      const outsideBlockTextBefore =
        syncedGitignore.slice(0, beginIdx) +
        syncedGitignore.slice(endIdx + "devpro-agent-rules managed end".length);
      assert.doesNotMatch(
        outsideBlockTextBefore,
        /^node_modules\/$/m,
        "precondition: no outside-block node_modules/ line already present after a normal --sync"
      );
      await fs.writeFile(gitignorePath, syncedGitignore + "node_modules/\n");

      // --- precondition: settings.json consumer-owned hook event + top-level key ---
      settingsPath = path.join(local.tmpDir, ".claude", "settings.json");
      const settingsBefore = JSON.parse(await fs.readFile(settingsPath, "utf8"));
      sourceHookKey = Object.keys(settingsBefore.hooks ?? {})[0];
      assert.ok(sourceHookKey, "precondition: source settings.json must define at least one hook event");
      settingsBefore.hooks.ConsumerOnlyEvent = [
        { hooks: [{ type: "command", command: "consumer-only" }] },
      ];
      settingsBefore.consumerLocalKey = { foo: "bar" };
      await fs.writeFile(settingsPath, JSON.stringify(settingsBefore, null, 2) + "\n");

      // --- single shared apply spawn for all five assertion groups below ---
      applyResult = {
        exitCode: 0,
        stdout: await runUninstallInProcess(local.tmpDir, { yes: true }),
        stderr: "",
      };
    });

    after(async () => {
      // resetSyncedConsumer() reuses syncedCtx.tmpDir; the outer after()
      // owns cleanup.
    });

    it("apply removes source-brought files but preserves consumer extras", async () => {
      assert.equal(applyResult.exitCode, 0, `apply uninstall should exit 0; stderr=${applyResult.stderr}`);

      const sourceBroughtExistsAfter = await fs
        .access(sourceBroughtFile)
        .then(() => true)
        .catch(() => false);
      assert.equal(sourceBroughtExistsAfter, false, "source-brought file must be removed by apply");

      const consumerExtraExistsAfter = await fs
        .access(consumerExtra)
        .then(() => true)
        .catch(() => false);
      assert.ok(consumerExtraExistsAfter, "consumer-owned extra file must be preserved");
      assert.equal(
        await fs.readFile(consumerExtra, "utf8"),
        "# consumer-owned agent\n",
        "consumer-owned extra content must be untouched"
      );
    });

    it("apply removes all five A-class static/root files", async () => {
      assert.equal(applyResult.exitCode, 0, `apply uninstall should exit 0; stderr=${applyResult.stderr}`);

      for (const relPath of aClassRelPaths) {
        const existsAfter = await fs
          .access(path.join(local.tmpDir, relPath))
          .then(() => true)
          .catch(() => false);
        assert.equal(existsAfter, false, `${relPath} must be removed by apply`);
      }
    });

    it("apply reverses the .gitignore managed block while keeping consumer lines", async () => {
      assert.equal(applyResult.exitCode, 0, `apply uninstall should exit 0; stderr=${applyResult.stderr}`);

      const content = await fs.readFile(gitignorePath, "utf8");
      assert.doesNotMatch(content, new RegExp(GITIGNORE_MANAGED_BEGIN), "managed begin marker must be gone");
      assert.doesNotMatch(content, new RegExp(GITIGNORE_MANAGED_END), "managed end marker must be gone");
      assert.match(content, /^consumer-local\/$/m, "consumer-local non-managed line must survive");
      assert.match(content, /^\.env\.local$/m, "consumer-local non-managed line must survive");
    });

    // Behavior-pinning regression test (not a bug fix): reverseGitignoreManagedBlock()
    // deliberately removes ANY line outside the managed block whose trimmed
    // value matches a source baseline entry (e.g. "node_modules/"), not just
    // the managed block itself. Rationale: during normal --sync,
    // mergeGitignoreManagedBlock() already dedups baseline-colliding lines out
    // of the outside-block area (see "does not duplicate baseline entries
    // already scattered in .gitignore" above), so this situation never arises
    // from a normal sync/uninstall round trip. This test pins the boundary
    // behavior for the case where a user manually re-adds a baseline-colliding
    // line outside the block AFTER --sync (bypassing the merge's dedup) and
    // then runs --uninstall: that manually-added line is treated the same as
    // managed content and is removed, not preserved as a "consumer-local"
    // line. If this behavior ever needs to change, this test must be
    // deliberately updated, not silently broken.
    it("apply removes a manually-added outside-block line that collides with the source gitignore baseline (behavior pinning)", async () => {
      assert.equal(applyResult.exitCode, 0, `apply uninstall should exit 0; stderr=${applyResult.stderr}`);

      const content = await fs.readFile(gitignorePath, "utf8");
      assert.doesNotMatch(
        content,
        /^node_modules\/$/m,
        "manually-added outside-block baseline-colliding line must be removed by --uninstall (current pinned behavior)"
      );
    });

    it("apply removes source hook event keys from settings.json while preserving consumer keys", async () => {
      assert.equal(applyResult.exitCode, 0, `apply uninstall should exit 0; stderr=${applyResult.stderr}`);

      const settingsAfter = JSON.parse(await fs.readFile(settingsPath, "utf8"));
      assert.ok(
        !Object.prototype.hasOwnProperty.call(settingsAfter.hooks ?? {}, sourceHookKey),
        `source hook event key ${sourceHookKey} must be removed`
      );
      assert.deepEqual(
        settingsAfter.hooks.ConsumerOnlyEvent,
        [{ hooks: [{ type: "command", command: "consumer-only" }] }],
        "consumer-owned hook event key must be preserved"
      );
      assert.deepEqual(
        settingsAfter.consumerLocalKey,
        { foo: "bar" },
        "consumer-owned top-level key must be preserved"
      );
    });
  });

  it("aborts without touching any file when non-TTY and --yes is not supplied", async () => {
    const local = await resetSyncedConsumer();

    const statusBefore = spawnSync("git", ["status", "--porcelain"], {
      cwd: local.tmpDir,
      encoding: "utf8",
    }).stdout;
    const agentsMdExistedBefore = await fs
      .access(path.join(local.tmpDir, "AGENTS.md"))
      .then(() => true)
      .catch(() => false);

    const { exitCode, stderr } = run(local.syncScript, "--uninstall", {
      cwd: local.tmpDir,
      testSourceRoot: uninstallSourceRoot,
    });

    assert.notEqual(exitCode, 0, "non-TTY apply without --yes must not exit 0");
    assert.match(stderr, /--yes/, "must prompt the user that --yes is required");

    const statusAfter = spawnSync("git", ["status", "--porcelain"], {
      cwd: local.tmpDir,
      encoding: "utf8",
    }).stdout;
    assert.equal(statusAfter, statusBefore, "aborted uninstall must not change git status");

    const agentsMdExistedAfter = await fs
      .access(path.join(local.tmpDir, "AGENTS.md"))
      .then(() => true)
      .catch(() => false);
    assert.equal(agentsMdExistedAfter, agentsMdExistedBefore, "aborted uninstall must not delete AGENTS.md");
  });

  it("rejects --sync combined with --uninstall as a named flag conflict", async () => {
    await withConsumerRepo(async (local) => {
      const { exitCode, stderr } = run(local.syncScript, "--sync --uninstall", { cwd: local.tmpDir });
      assert.notEqual(exitCode, 0, "--sync + --uninstall must not exit 0");
      assert.match(stderr, /--sync/);
      assert.match(stderr, /--uninstall/);
    });
  });

  it("never reads or writes global rc/config files outside the consumer repo", async () => {
    const local = await resetSyncedConsumer();

    const homeDir = path.join(local.tmpDir, "fake-home");
    const binDir = path.join(local.tmpDir, "bin");
    await fs.mkdir(homeDir, { recursive: true });
    await createFakeCommand(binDir, "claude");
    await createFakeCommand(binDir, "codex");

    const zshrcPath = path.join(homeDir, ".zshrc");
    const bashrcPath = path.join(homeDir, ".bashrc");
    const codexConfigPath = path.join(homeDir, ".codex", "config.toml");

    await runUninstallInProcess(local.tmpDir, { yes: true }, autoCompactEnv(homeDir, binDir));

    for (const globalPath of [zshrcPath, bashrcPath, codexConfigPath]) {
      const existsAfter = await fs.access(globalPath).then(() => true).catch(() => false);
      assert.equal(existsAfter, false, `${globalPath} must not be created/touched by --uninstall`);
    }
  });

  it("apply unsets core.hooksPath when it points at our own hooks-git dir", async () => {
    await withConsumerRepo(async (local) => {
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: local.tmpDir, encoding: "utf8" });
      run(local.syncScript, "--sync", {
        cwd: local.tmpDir,
        timeout: HOOKS_PATH_GIT_TIMEOUT_MS,
      });
      const hooksPathSetup = ensureGitHooksPath({ cwd: local.tmpDir });
      assert.equal(hooksPathSetup.outcome, "repaired", "devpro:change setup must configure our hooks path");

      const before = spawnSync("git", ["config", "--get", "core.hooksPath"], {
        cwd: local.tmpDir,
        encoding: "utf8",
      }).stdout.trim();
      assert.ok(before, "precondition: --sync must have configured core.hooksPath");

      const { exitCode, stderr, stdout } = run(local.syncScript, "--uninstall --yes", {
        cwd: local.tmpDir,
        timeout: HOOKS_PATH_GIT_TIMEOUT_MS,
      });
      assert.equal(exitCode, 0, `apply uninstall should exit 0; stderr=${stderr}`);
      assert.match(stdout, /Unset core\.hooksPath/);

      const after = spawnSync("git", ["config", "--get", "core.hooksPath"], {
        cwd: local.tmpDir,
        encoding: "utf8",
      });
      assert.notEqual(after.status, 0, "core.hooksPath must be unset (git config --get exits non-zero)");
      assert.equal(after.stdout.trim(), "");
    });
  });

  // [Scenario: consumer-adoption-tooling :: Rules sync, check and uninstall leave the stale file untouched]
  for (const rel of [
    ".devpro/cross-model-skip-paths.local",
    ".devpro/pre-pr-checks.local",
    ".devpro/second-review-rules.local",
    ".devpro/pre-pr-checks.local.md",
    ".devpro/second-review-rules.local.md",
  ]) {
    it(`apply leaves ${rel} byte-for-byte`, async () => {
      const local = await resetSyncedConsumer();
      const stale = path.join(local.tmpDir, ...rel.split("/"));
      const unique = "# consumer file\ndocs/**\n";
      await fs.mkdir(path.dirname(stale), { recursive: true });
      await fs.writeFile(stale, unique);

      await runUninstallInProcess(local.tmpDir, { yes: true });

      assert.equal(await fs.readFile(stale, "utf8"), unique);
    });
  }

  it("apply preserves core.hooksPath when it points at a non-our value", async () => {
    const local = await resetSyncedConsumer();

    const consumerOwnedHooksPath = "/some/consumer-owned/hooks-dir";
    spawnSync("git", ["config", "core.hooksPath", consumerOwnedHooksPath], {
      cwd: local.tmpDir,
      encoding: "utf8",
    });

    const stdout = await runUninstallInProcess(local.tmpDir, { yes: true });
    assert.doesNotMatch(stdout, /Unset core\.hooksPath/);

    const after = spawnSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: local.tmpDir,
      encoding: "utf8",
    });
    assert.equal(after.status, 0, "non-our core.hooksPath must be left in place");
    assert.equal(after.stdout.trim(), consumerOwnedHooksPath);
  });

  it("apply unsets a matching core.hooksPath via argv-based git (success path unaffected by the strict conversion)", async () => {
    const local = await resetSyncedConsumer();

    const ourHooksPath = resolveAbsoluteHooksPath(local.tmpDir);
    assert.ok(ourHooksPath, "precondition: our absolute hooksPath must resolve for this repo");
    spawnSync("git", ["config", "core.hooksPath", ourHooksPath], {
      cwd: local.tmpDir,
      encoding: "utf8",
    });

    const stdout = await runUninstallInProcess(local.tmpDir, { yes: true });
    assert.match(stdout, /Unset core\.hooksPath/);

    const after = spawnSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: local.tmpDir,
      encoding: "utf8",
    });
    assert.notEqual(after.status, 0, "our core.hooksPath must be unset (no value left)");
  });

  // I4 regression: `git config --unset core.hooksPath` now runs through the
  // strict, argv-based runGitStrict (throws on non-zero exit) instead of the
  // fail-open runGit (swallows errors, returns ""). Before the fix, a failed
  // unset was silently ignored and the CLI printed a false "Unset
  // core.hooksPath" success plus continued to remove every other artifact
  // class — this test proves the failure now propagates and aborts the run
  // instead of being misreported as success.
  it("apply propagates a failed core.hooksPath unset instead of reporting false success", async () => {
    await withConsumerRepo(async (local) => {
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: local.tmpDir, encoding: "utf8" });
      run(local.syncScript, "--sync", { cwd: local.tmpDir });

      const ourHooksPath = resolveAbsoluteHooksPath(local.tmpDir);
      assert.ok(ourHooksPath, "precondition: our absolute hooksPath must resolve for this repo");
      spawnSync("git", ["config", "core.hooksPath", ourHooksPath], {
        cwd: local.tmpDir,
        encoding: "utf8",
      });

      // Force `git config --unset` to fail with a stale lock path. ACL/owner
      // changes are not portable: Windows may still permit writes to a
      // chmod-style read-only directory, while a real config.lock collision
      // deterministically blocks Git on both hosts.
      const gitDir = path.join(local.tmpDir, ".git");
      const configLockPath = path.join(gitDir, "config.lock");
      await fs.writeFile(configLockPath, "held by portability fixture\n");
      try {
        const { exitCode, stderr, stdout } = run(local.syncScript, "--uninstall --yes", { cwd: local.tmpDir });
        assert.notEqual(exitCode, 0, "a failed core.hooksPath unset must abort with a non-zero exit");
        assert.doesNotMatch(
          stdout,
          /Unset core\.hooksPath/,
          "must not print a false success message when the underlying git command failed"
        );
        assert.match(stderr, /hooksPath|exit|git|Command failed/i, `stderr should surface the git failure; got: ${stderr}`);
      } finally {
        await fs.rm(configLockPath, { force: true });
      }
    });
  });

  it("apply deregisters the .devpro-agent-rules submodule and leaves .gitmodules without residue", async () => {
    const ctx = await createConsumerRepoWithSubmodule();
    try {
      const { exitCode, stderr, stdout } = run(ctx.syncScript, "--uninstall --yes", { cwd: ctx.tmpDir });
      assert.equal(exitCode, 0, `apply uninstall should exit 0; stderr=${stderr}`);
      assert.match(stdout, /Deregistered submodule \.devpro-agent-rules/);

      const submoduleDirExists = await fs
        .access(path.join(ctx.tmpDir, ".devpro-agent-rules"))
        .then(() => true)
        .catch(() => false);
      assert.equal(submoduleDirExists, false, "submodule working-tree dir must be removed");

      const gitmodulesExists = await fs
        .access(path.join(ctx.tmpDir, ".gitmodules"))
        .then(() => true)
        .catch(() => false);
      if (gitmodulesExists) {
        const gitmodulesContent = await fs.readFile(path.join(ctx.tmpDir, ".gitmodules"), "utf8");
        assert.doesNotMatch(
          gitmodulesContent,
          /devpro-agent-rules/,
          ".gitmodules must have no residue referencing the deregistered submodule"
        );
      }

      // git status is expected to show staged deletions for both the
      // submodule gitlink and .gitmodules (that IS the deregistration) —
      // assert there is no leftover MODIFIED/UNTRACKED .gitmodules stub
      // (which would indicate a residual empty-but-still-present section),
      // rather than asserting the path string is absent from the output.
      const statusAfter = spawnSync("git", ["status", "--porcelain"], {
        cwd: ctx.tmpDir,
        encoding: "utf8",
      }).stdout;
      const statusLines = statusAfter.split("\n").filter(Boolean);
      for (const line of statusLines) {
        if (line.includes(".gitmodules") || line.includes("devpro-agent-rules")) {
          assert.match(
            line,
            /^D\s/,
            `unexpected non-deletion status line for submodule cleanup: "${line}"`
          );
        }
      }
    } finally {
      await cleanupConsumerRepoWithSubmodule(ctx);
    }
  });
// ---------------------------------------------------------------------------

});
