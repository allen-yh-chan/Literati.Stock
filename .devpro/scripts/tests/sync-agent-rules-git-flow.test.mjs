import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

function fixtureGitEnv(cwd, overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(cwd, ".git", "fixture-global-config"),
    ...overrides,
  };
}

function configureFixtureGit(cwd, overrides = {}) {
  const env = fixtureGitEnv(cwd, overrides);
  for (const [key, value] of [["core.autocrlf", "false"], ["core.symlinks", "true"]]) {
    const result = spawnSync("git", ["config", key, value], { cwd, env, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git config ${key} failed: ${result.stderr || result.stdout}`);
    }
  }
  return env;
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
let gitFlowSourceRoot = SOURCE_ROOT;

async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
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

async function writeTextFile(root, relPath, content) {
  const targetPath = path.join(root, ...relPath.split("/"));
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content);
}

async function createSlimGitFlowSource() {
  const sourceRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-git-flow-slim-source-"));
  const skillRel = ".devpro/agent-skills/devpro-workflows/workflows";

  await fs.copyFile(sourcePath("AGENTS.md"), path.join(sourceRootDir, "AGENTS.md"));
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

function run(script, args = "", { cwd, env: extraEnv = {}, input, timeout = 30_000, fullSubmodSource = runUsesFullSubmodSource, useTestSourceRoot = !fullSubmodSource, testSourceRoot = useTestSourceRoot ? gitFlowSourceRoot : null } = {}) {
  // Every spawned fixture command starts from a sanitized Git environment.
  // Callers may add explicit fixture values through `extraEnv`, but ambient
  // GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE (and sibling GIT_* selectors) from
  // the parent checkout must never redirect a temporary repo.
  const env = fixtureGitEnv(cwd, extraEnv);
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
  const authors = {
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
  const sourceGitEnv = fixtureGitEnv(sourceRepoDir, authors);
  const gitEnv = fixtureGitEnv(tmpDir, authors);
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
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: sourceRepoDir, env: sourceGitEnv });
  configureFixtureGit(sourceRepoDir, authors);
  spawnSync("git", ["add", "-A"], { cwd: sourceRepoDir, env: sourceGitEnv });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: sourceRepoDir, env: sourceGitEnv });

  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: tmpDir, env: gitEnv });
  configureFixtureGit(tmpDir, authors);

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
 *   - an in-process `ghRunner` seam that returns a fixed PR URL and records
 *     argv/body to fixture files — real `gh` would need network + auth, which
 *     this sandbox cannot provide; `git` itself is real throughout.
 *   - an initial commit on `main` so `--git-flow`'s `checkout -b` has a base.
 *
 * `binDir` remains available for CLI-path tests; the apply assertions use the
 * bounded runner seam so no shell-backed command shim is required on Windows.
 */
let gitFlowLocalSnapshotDir;

async function createGitFlowLocalSnapshot() {
  const local = await createConsumerRepo();
  const gitEnv = fixtureGitEnv(local.tmpDir, {
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com",
  });

  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: local.tmpDir, env: gitEnv });
  configureFixtureGit(local.tmpDir, {
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com",
  });
  run(local.syncScript, "--sync", { cwd: local.tmpDir });
  spawnSync("git", ["add", "-A"], { cwd: local.tmpDir, env: gitEnv });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: local.tmpDir, env: gitEnv });

  const snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-git-flow-snapshot-"));
  await copyDir(local.tmpDir, snapshotDir);
  await fs.rm(local.tmpDir, { recursive: true, force: true });
  return snapshotDir;
}

async function createGitFlowFixture({ withOrigin = true } = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-git-flow-"));
  await copyDir(gitFlowLocalSnapshotDir, tmpDir);

  const local = {
    tmpDir,
    submod: path.join(tmpDir, ".devpro-agent-rules"),
    syncScript: path.join(tmpDir, ".devpro-agent-rules", ".devpro", "scripts", "sync-agent-rules.mjs"),
    fullSubmod: false,
  };
  const originDir = withOrigin ? await fs.mkdtemp(path.join(os.tmpdir(), "sync-origin-")) : null;
  const binDir = path.join(local.tmpDir, "git-flow-bin");
  const ghArgsFile = path.join(local.tmpDir, "gh-args.txt");
  const ghBodyCaptureFile = path.join(local.tmpDir, "gh-body-capture.txt");

  const authors = {
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com",
  };
  const gitEnv = fixtureGitEnv(local.tmpDir, authors);
  const originEnv = originDir ? fixtureGitEnv(originDir, authors) : null;

  configureFixtureGit(local.tmpDir, authors);

  if (withOrigin) {
    spawnSync("git", ["init", "-q", "--bare"], { cwd: originDir, env: originEnv });
    configureFixtureGit(originDir, authors);
    spawnSync("git", ["remote", "add", "origin", originDir], { cwd: local.tmpDir, env: gitEnv });
    spawnSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: local.tmpDir, env: gitEnv });
  }

  await fs.mkdir(binDir, { recursive: true });
  // The in-process git-flow seam captures the gh argv/body without invoking a
  // shell-backed shim, so the production child_process boundary remains the
  // real direct `gh` executable path on every host.

  return { ...local, originDir, binDir, ghArgsFile, ghBodyCaptureFile, gitEnv };
}

async function cleanupGitFlowFixture(ctx) {
  await fs.rm(ctx.tmpDir, { recursive: true, force: true });
  if (ctx.originDir) {
    await fs.rm(ctx.originDir, { recursive: true, force: true });
  }
}

function gitFlowEnv(binDir) {
  return { PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}` };
}

async function installDefaultGhShim(ctx) {
  const ghPath = path.join(ctx.binDir, "gh");
  await fs.writeFile(
    ghPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ctx.ghArgsFile)}, args.join(" ") + "\\n");
const bodyIndex = args.indexOf("--body-file");
if (bodyIndex >= 0 && args[bodyIndex + 1]) {
  fs.copyFileSync(args[bodyIndex + 1], ${JSON.stringify(ctx.ghBodyCaptureFile)});
}
process.stdout.write("https://github.com/devpro-tw/example/pull/1\\n");
`
  );
  await fs.chmod(ghPath, 0o755);
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

async function captureConsoleResult(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  const stdoutLines = [];
  const stderrLines = [];
  console.log = (...args) => { stdoutLines.push(args.join(" ")); };
  console.error = (...args) => { stderrLines.push(args.join(" ")); };
  try {
    await fn();
    return {
      exitCode: 0,
      stdout: stdoutLines.join("\n"),
      stderr: stderrLines.join("\n"),
    };
  } catch (error) {
    return {
      exitCode: error?.status ?? 1,
      stdout: stdoutLines.join("\n"),
      stderr: [...stderrLines, error?.message ?? String(error)].filter(Boolean).join("\n"),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function runGitFlowUninstallInProcess(consumerRoot, { yes = true, env = {} } = {}) {
  return withFixtureGitEnv(consumerRoot, () => {
    const ghRunner = (command, args) => {
      assert.equal(command, "gh");
      appendFileSync(path.join(consumerRoot, "gh-args.txt"), `${args.join(" ")}\n`);
      const bodyIndex = args.indexOf("--body-file");
      if (bodyIndex >= 0 && args[bodyIndex + 1]) {
        copyFileSync(args[bodyIndex + 1], path.join(consumerRoot, "gh-body-capture.txt"));
      }
      return "https://github.com/devpro-tw/example/pull/1\n";
    };
    return withEnv(
      {
        [TEST_SYNC_SOURCE_ROOT_ENV]: gitFlowSourceRoot,
        ...env,
      },
      () => captureConsoleResult(() => runUninstall(consumerRoot, { yes, gitFlow: true, ghRunner }))
    );
  });
}

// ---------------------------------------------------------------------------
// --uninstall (split from sync-agent-rules.test.mjs for file-level parallelism)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// --uninstall --git-flow (split from sync-agent-rules-uninstall for parallelism)
// ---------------------------------------------------------------------------

// T9 — --git-flow branch/commit/push/PR orchestration. Uses a real local
// bare repo as `origin` (git push needs no network against a local bare
// repo); the `gh pr create` leg uses the bounded in-process runner seam — see
// createGitFlowFixture().
describe("--git-flow", () => {
  before(async () => {
    gitFlowSourceRoot = await createSlimGitFlowSource();
    gitFlowLocalSnapshotDir = await createGitFlowLocalSnapshot();
  });

  after(async () => {
    if (gitFlowLocalSnapshotDir) {
      await fs.rm(gitFlowLocalSnapshotDir, { recursive: true, force: true });
    }
    if (gitFlowSourceRoot !== SOURCE_ROOT) {
      await fs.rm(gitFlowSourceRoot, { recursive: true, force: true });
      gitFlowSourceRoot = SOURCE_ROOT;
    }
  });

  it("refuses to run on a protected/mainline branch and makes no commit", async () => {
    const ctx = await createGitFlowFixture({ withOrigin: false });
    try {
      const beforeLog = spawnSync("git", ["log", "--oneline"], {
        cwd: ctx.tmpDir,
        encoding: "utf8",
        env: ctx.gitEnv,
      }).stdout;

      const { exitCode, stdout, stderr } = await withEnv(
        {
          GIT_DIR: path.join(ctx.tmpDir, "ambient-git-dir-must-not-win"),
          GIT_WORK_TREE: path.join(ctx.tmpDir, "ambient-work-tree-must-not-win"),
          GIT_INDEX_FILE: path.join(ctx.tmpDir, "ambient-index-must-not-win"),
        },
        () => run(ctx.syncScript, "--uninstall --yes --git-flow", {
          cwd: ctx.tmpDir,
          env: gitFlowEnv(ctx.binDir),
        })
      );

      assert.notEqual(exitCode, 0, "--git-flow on main must not exit 0");
      assert.match(stdout + stderr, /protected|mainline/i, "must explain the refusal");
      assert.match(stdout + stderr, /main/, "refusal must name the current branch");

      const afterLog = spawnSync("git", ["log", "--oneline"], {
        cwd: ctx.tmpDir,
        encoding: "utf8",
        env: ctx.gitEnv,
      }).stdout;
      assert.equal(afterLog, beforeLog, "refused --git-flow must not create any commit");

      const ghArgsExists = await fs.access(ctx.ghArgsFile).then(() => true).catch(() => false);
      assert.equal(ghArgsExists, false, "refused --git-flow must never invoke gh");
    } finally {
      await cleanupGitFlowFixture(ctx);
    }
  });

  // The two `it()` blocks below (branch/commit/push/PR-URL mechanics vs.
  // PR body wording) previously each built their OWN createGitFlowFixture()
  // (real git init + bare origin + --sync copy of the ~400+ file fixture
  // tree) and ran their OWN `--uninstall --yes --git-flow` spawn, even
  // though both assert on non-overlapping aspects of the exact same
  // git-flow apply run. Combined into one shared fixture (`before()`) that
  // runs the apply once; each `it()` still performs exactly the assertions
  // its standalone predecessor made. Test count is unchanged (still 2
  // `it()`s); only the fixture-build + apply-spawn count collapses from 2
  // to 1.
  describe("apply commits, pushes, and opens a PR (shared fixture)", () => {
    let ctx;
    let applyResult;

    before(async () => {
      ctx = await createGitFlowFixture();
      spawnSync("git", ["checkout", "-q", "-b", "work/uninstall-test"], {
        cwd: ctx.tmpDir,
        env: ctx.gitEnv,
      });
      applyResult = await runGitFlowUninstallInProcess(ctx.tmpDir, {
        env: gitFlowEnv(ctx.binDir),
      });
    });

    after(async () => {
      await cleanupGitFlowFixture(ctx);
    });

    it("commits on a dedicated branch, pushes, and opens a PR on a non-protected branch", async () => {
      const { exitCode, stdout, stderr } = applyResult;
      assert.equal(exitCode, 0, `--git-flow apply should exit 0; stderr=${stderr}`);

      const branchCheck = spawnSync(
        "git",
        ["rev-parse", "--verify", "--quiet", "chore/remove-devpro-agent-rules"],
        { cwd: ctx.tmpDir, encoding: "utf8", env: ctx.gitEnv }
      );
      assert.equal(branchCheck.status, 0, "chore/remove-devpro-agent-rules branch must exist");

      const currentBranch = spawnSync("git", ["branch", "--show-current"], {
        cwd: ctx.tmpDir,
        encoding: "utf8",
        env: ctx.gitEnv,
      }).stdout.trim();
      assert.equal(currentBranch, "chore/remove-devpro-agent-rules");

      const commitMessage = spawnSync("git", ["log", "-1", "--pretty=%B"], {
        cwd: ctx.tmpDir,
        encoding: "utf8",
        env: ctx.gitEnv,
      }).stdout;
      assert.match(commitMessage, /chore: remove devpro-agent-rules governance rules/);
      // The footer version tracks AGENTS.md (the fixture copies sourceRoot/AGENTS.md
      // and the --git-flow footer reads `版本：X.Y.Z` from it). Read the canonical
      // version dynamically so a version bump does not require touching this
      // assertion — hardcoding a literal version made this test go stale on the
      // 6.82.0 bump (the footer read the live 6.82.0 while the assertion pinned 6.81.2).
      const canonicalAgents = await fs.readFile(sourcePath("AGENTS.md"), "utf8");
      const canonicalVersion = canonicalAgents.match(/版本：([0-9]+\.[0-9]+\.[0-9]+)/)?.[1];
      assert.ok(canonicalVersion, "AGENTS.md must declare a 版本：X.Y.Z");
      const footerLine = commitMessage.replace(/\n+$/, "").split("\n").at(-1) ?? "";
      const escapedVersion = canonicalVersion.replace(/\./g, "\\.");
      assert.match(
        footerLine,
        new RegExp(`^Rules: v${escapedVersion} · Tool: [^\\n]+ · Model: [^\\n]+$`)
      );
      assert.doesNotMatch(commitMessage, /Tool: Claude Code/);
      assert.doesNotMatch(commitMessage, /Model: Opus 4\.8/);
      const footerTokens = footerLine.match(/^Rules: .+ · Tool: (.+) · Model: (.+)$/);
      assert.ok(footerTokens, "footer line must expose Tool and Model tokens");
      assert.equal(footerTokens[1], "unknown");
      assert.equal(footerTokens[2], "unknown");

      const agentsMdExistsAfter = await fs
        .access(path.join(ctx.tmpDir, "AGENTS.md"))
        .then(() => true)
        .catch(() => false);
      assert.equal(agentsMdExistsAfter, false, "AGENTS.md must have been removed before the commit");

      const remoteBranchCheck = spawnSync(
        "git",
        ["ls-remote", "--heads", ctx.originDir, "chore/remove-devpro-agent-rules"],
        { cwd: ctx.tmpDir, encoding: "utf8" }
      );
      assert.match(
        remoteBranchCheck.stdout,
        /chore\/remove-devpro-agent-rules/,
        "the branch must have been pushed to origin"
      );

      assert.match(stdout, /https:\/\/github\.com\/devpro-tw\/example\/pull\/1/, "must print the PR URL");

      const ghArgs = await fs.readFile(ctx.ghArgsFile, "utf8");
      assert.match(ghArgs, /pr create/);
      assert.match(ghArgs, /chore: remove devpro-agent-rules governance rules/);
    });

    it("gh pr create body names all three irreversible warnings and defers merge to the human reviewer", async () => {
      assert.equal(applyResult.exitCode, 0, `--git-flow apply should exit 0; stderr=${applyResult.stderr}`);

      const ghArgs = await fs.readFile(ctx.ghArgsFile, "utf8");
      assert.match(ghArgs, /--body-file/, "PR body must be passed via --body-file");

      const bodyContent = await fs.readFile(ctx.ghBodyCaptureFile, "utf8").catch(() => "");
      assert.notEqual(bodyContent, "", "fake gh must have captured the --body-file content before it was cleaned up");

      assert.match(bodyContent, /core\.hooksPath/i, "PR body must mention core.hooksPath irreversibility");
      assert.match(bodyContent, /settings\.json|hooks\.json/i, "PR body must mention settings/hooks.json irreversibility");
      assert.match(bodyContent, /extras/i, "PR body must mention the directory-extras boundary irreversibility");
      assert.match(bodyContent, /never merges|does not merge|is left for a human/i, "PR body must defer merge to a human");

      // Keep the deterministic in-process seam above, but also exercise the
      // production default `execFileSync("gh", ...)` path through a spawned
      // CLI run. A POSIX executable shim is used here because the direct
      // invocation intentionally does not enable shell/PATHEXT lookup for a
      // Windows `.cmd` shim; native Windows coverage remains on the bounded
      // seam, while this assertion locks the real argv/body boundary.
      const directCtx = await createGitFlowFixture();
      try {
        spawnSync("git", ["checkout", "-q", "-b", "work/uninstall-test"], {
          cwd: directCtx.tmpDir,
          env: directCtx.gitEnv,
        });

        if (process.platform === "win32") {
          const productionSource = await fs.readFile(
            path.join(SOURCE_ROOT, ".devpro", "scripts", "sync-agent-rules.mjs"),
            "utf8"
          );
          assert.match(
            productionSource,
            /ghRunner\s*=\s*execFileSync/,
            "the default git-flow runner must stay on direct execFileSync without a shell"
          );
        } else {
          await installDefaultGhShim(directCtx);
          const directResult = run(
            directCtx.syncScript,
            "--uninstall --yes --git-flow",
            {
              cwd: directCtx.tmpDir,
              env: { ...directCtx.gitEnv, ...gitFlowEnv(directCtx.binDir) },
            }
          );
          assert.equal(
            directResult.exitCode,
            0,
            `spawned default gh path should exit 0; stderr=${directResult.stderr}`
          );
          assert.match(directResult.stdout, /https:\/\/github\.com\/devpro-tw\/example\/pull\/1/);

          const directArgs = await fs.readFile(directCtx.ghArgsFile, "utf8");
          assert.match(directArgs, /pr create/);
          assert.match(directArgs, /--body-file/);
          const directBody = await fs.readFile(directCtx.ghBodyCaptureFile, "utf8");
          assert.match(directBody, /core\.hooksPath/i);
        }
      } finally {
        await cleanupGitFlowFixture(directCtx);
      }
    });
  });

  it("does not push or call gh when the non-TTY apply gate itself requires --yes", async () => {
    const ctx = await createGitFlowFixture({ withOrigin: false });
    try {
      spawnSync("git", ["checkout", "-q", "-b", "work/uninstall-test"], {
        cwd: ctx.tmpDir,
        env: ctx.gitEnv,
      });
      const beforeLog = spawnSync("git", ["log", "--oneline"], {
        cwd: ctx.tmpDir,
        encoding: "utf8",
        env: ctx.gitEnv,
      }).stdout;

      const { exitCode, stdout, stderr } = await runGitFlowUninstallInProcess(ctx.tmpDir, {
        yes: false,
        env: gitFlowEnv(ctx.binDir),
      });

      assert.notEqual(exitCode, 0, "non-TTY --git-flow without --yes must not exit 0");
      assert.match(stderr, /--yes/, "must explain --yes is required");
      assert.doesNotMatch(stdout, /https:\/\/github\.com/, "must not have reached gh pr create");

      const ghArgsExists = await fs.access(ctx.ghArgsFile).then(() => true).catch(() => false);
      assert.equal(ghArgsExists, false, "gh must never be invoked when the apply gate itself rejects");

      const afterLog = spawnSync("git", ["log", "--oneline"], {
        cwd: ctx.tmpDir,
        encoding: "utf8",
        env: ctx.gitEnv,
      }).stdout;
      assert.equal(afterLog, beforeLog, "apply gate rejection must not create any commit");

      const branchCheck = spawnSync(
        "git",
        ["rev-parse", "--verify", "--quiet", "chore/remove-devpro-agent-rules"],
        { cwd: ctx.tmpDir, encoding: "utf8", env: ctx.gitEnv }
      );
      assert.notEqual(branchCheck.status, 0, "apply gate rejection must not create the git-flow branch");
    } finally {
      await cleanupGitFlowFixture(ctx);
    }
  });

  it("does not print false success when the push fails", async () => {
    const ctx = await createGitFlowFixture();
    try {
      spawnSync("git", ["checkout", "-q", "-b", "work/uninstall-test"], {
        cwd: ctx.tmpDir,
        env: ctx.gitEnv,
      });

      // Point origin at a bare repo that has since been deleted, so
      // `git push` fails against an unreachable/nonexistent remote path —
      // while `git checkout -b` and `git commit` (both local-only) still
      // succeed. This isolates the push failure from the earlier steps.
      await fs.rm(ctx.originDir, { recursive: true, force: true });

      const { exitCode, stdout } = await runGitFlowUninstallInProcess(ctx.tmpDir, {
        env: gitFlowEnv(ctx.binDir),
      });

      assert.notEqual(exitCode, 0, "a failed push must not exit 0");
      assert.doesNotMatch(stdout, /Pushed/, "must not print a false push-success line");
      assert.doesNotMatch(stdout, /https:\/\/github\.com/, "must not have reached gh pr create");

      const ghArgsExists = await fs.access(ctx.ghArgsFile).then(() => true).catch(() => false);
      assert.equal(ghArgsExists, false, "gh must never be invoked when the push itself failed");
    } finally {
      // originDir was already removed above; only clean up tmpDir.
      await fs.rm(ctx.tmpDir, { recursive: true, force: true });
    }
  });
});
