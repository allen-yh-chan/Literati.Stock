/**
 * sync-agent-rules-harness.mjs
 *
 * Shared test harness for the sync-agent-rules.test.mjs family (split across
 * sibling *.test.mjs files to shorten the node --test integration-tier
 * critical path). Extracted from the pre-split sync-agent-rules.mjs family;
 * portability fixes intentionally keep the shared timeout default while
 * adding typed Win32 fixture links and isolated Git environments.
 *
 * Not itself a *.test.mjs file: excluded from test-suite-manifest.mjs /
 * lint-test-suite-manifest.mjs (which only scan disk for *.test.mjs).
 *
 * Mutable module state note: `runUsesFullSubmodSource` was a bare
 * module-level `let` in the pre-split single file, toggled by describe
 * block before()/after() hooks and read as run()'s default
 * `fullSubmodSource` option. A bare exported `let` cannot be mutated by an
 * importer (ES module bindings are live but read-only outside the
 * exporting module), so it is now private to this module with an explicit
 * setter/getter pair. Every describe block that mutates the flag continues
 * to call setRunUsesFullSubmodSource(...)/getRunUsesFullSubmodSource() the
 * same way the original file's before()/after() assigned/read the bare
 * variable — behavior is unchanged, only the mutation mechanism differs.
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { Readable } from "node:stream";
import {
  STATIC_FILES,
  SYNC_DIRS,
  LEGACY_SOURCE_WORKFLOW_FILES,
  LEGACY_SECOND_REVIEW_ARTIFACTS,
  GITIGNORE_MANAGED_BEGIN,
  GITIGNORE_MANAGED_END,
  GITATTRIBUTES_MANAGED_BEGIN,
  GITATTRIBUTES_MANAGED_END,
  GITATTRIBUTES_MANAGED_ENTRIES,
  TEST_SYNC_SOURCE_ROOT_ENV,
  SKILL_TARGET_ROOT,
  SKILL_REFS_ROOT,
  SKILL_ENTRY_NAME,
  SKILL_ENTRY_LINK_TARGET,
  runUninstall,
} from "../../sync-agent-rules.mjs";
import {
  maybeRepairClaudeAutoCompact,
  maybeRepairCodexAutoCompact,
} from "../../runtime-auto-compact-settings.mjs";
import { resolveSourceRoot } from "./source-root.mjs";

export {
  STATIC_FILES,
  SYNC_DIRS,
  LEGACY_SOURCE_WORKFLOW_FILES,
  LEGACY_SECOND_REVIEW_ARTIFACTS,
  GITIGNORE_MANAGED_BEGIN,
  GITIGNORE_MANAGED_END,
  GITATTRIBUTES_MANAGED_BEGIN,
  GITATTRIBUTES_MANAGED_END,
  GITATTRIBUTES_MANAGED_ENTRIES,
  TEST_SYNC_SOURCE_ROOT_ENV,
  SKILL_TARGET_ROOT,
  SKILL_REFS_ROOT,
  SKILL_ENTRY_NAME,
  SKILL_ENTRY_LINK_TARGET,
  maybeRepairClaudeAutoCompact,
  maybeRepairCodexAutoCompact,
  runUninstall,
};

export const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptDir, "../../../..");
export const sourceRoot = resolveSourceRoot(repoRoot);
// Full-suite parallelism can starve git-heavy hooksPath fixtures past the default CLI timeout.
export const HOOKS_PATH_GIT_TIMEOUT_MS = 120_000;

/** Return a fixture-local Git environment without inherited GIT_* knobs. */
export function fixtureGitEnv(cwd, overrides = {}) {
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

export function configureFixtureGit(cwd, { symlinks = true, overrides = {} } = {}) {
  const env = fixtureGitEnv(cwd, overrides);
  const config = (key, value) => {
    const result = spawnSync("git", ["config", key, value], {
      cwd,
      env,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`git config ${key} failed: ${result.stderr || result.stdout}`);
    }
  };
  config("core.autocrlf", "false");
  if (symlinks) config("core.symlinks", "true");
  return env;
}

async function createPortableTestSymlink(linkTarget, targetPath, kind = "directory") {
  if (process.platform === "win32") {
    await fs.symlink(linkTarget, targetPath, kind === "directory" ? "dir" : "file");
    return;
  }
  await fs.symlink(linkTarget, targetPath);
}

/**
 * When true, run() omits DEVPRO_TEST_SYNC_SOURCE_ROOT (full submod mirror is
 * the source). Private module state — mutate only via
 * setRunUsesFullSubmodSource(); read only via getRunUsesFullSubmodSource().
 * See file-header note: this replaces the original single-file bare
 * `let runUsesFullSubmodSource` now that describe blocks live in separate
 * modules and can no longer share a live mutable binding.
 */
let runUsesFullSubmodSource = false;

export function setRunUsesFullSubmodSource(value) {
  runUsesFullSubmodSource = value;
}

export function getRunUsesFullSubmodSource() {
  return runUsesFullSubmodSource;
}

export async function copySyncEntrypointLibs(destScriptsDir) {
  const libDest = path.join(destScriptsDir, "lib");
  await fs.mkdir(libDest, { recursive: true });
  for (const name of [
    "cli-entry.mjs",
    "prompt-session.mjs",
    "consumer-pre-pr-checks.mjs",
    "consumer-second-review-rules.mjs",
    "second-review-sticky-credential-gate.mjs",
    // design D5 (refactor-agent-skills-entry) — sync-agent-rules.mjs now
    // imports the frozen legacy-skill-entry allowlists/classifiers from
    // this sibling module; every fixture that spawns a copied
    // sync-agent-rules.mjs entrypoint (rather than pointing
    // DEVPRO_TEST_SYNC_SOURCE_ROOT at the real source root) needs it too.
    "legacy-skill-entry-artifacts.mjs",
  ]) {
    await fs.copyFile(
      path.join(sourceRoot, ".devpro", "scripts", "lib", name),
      path.join(libDest, name)
    );
  }
  // design D6 — sync-agent-rules.mjs also imports collectEntryTreeSkillSet
  // from its sibling lint-agent-skills.mjs (shared with the source-side
  // lint, not a second copy); copy it alongside the entrypoint for the
  // same reason as the lib/ modules above.
  await fs.copyFile(
    path.join(sourceRoot, ".devpro", "scripts", "lint-agent-skills.mjs"),
    path.join(destScriptsDir, "lint-agent-skills.mjs")
  );
}

export async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
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

function runGitOrThrow(cwd, args, input) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    env: fixtureGitEnv(cwd),
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function preservePlainDiscoveryGitEvidence(sourceRepo, copiedRoot, consumerRoot) {
  const plainLinks = [];
  for (const discoveryRoot of [".agents/skills", ".claude/skills"]) {
    const sourceDir = path.join(sourceRepo, ...discoveryRoot.split("/"));
    for (const entry of await fs.readdir(sourceDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile()) continue;
      const relPath = `${discoveryRoot}/${entry.name}`;
      const staged = runGitOrThrow(sourceRepo, ["ls-files", "--stage", "--", relPath]).trim();
      const match = staged.match(/^120000\s+([0-9a-f]+)\s+\d+\t(.+)$/);
      if (!match || match[2] !== relPath) continue;
      const sourceBytes = await fs.readFile(path.join(sourceRepo, ...relPath.split("/")));
      const blob = Buffer.from(
        spawnSync("git", ["cat-file", "-p", match[1]], {
          cwd: sourceRepo,
          env: fixtureGitEnv(sourceRepo),
        }).stdout ?? []
      );
      if (!sourceBytes.equals(blob)) {
        throw new Error(`plain discovery checkout ${relPath} differs from its Git 120000 blob`);
      }
      plainLinks.push({ relPath, blob });
    }
  }
  if (plainLinks.length === 0) return;

  runGitOrThrow(copiedRoot, ["init", "-q"]);
  configureFixtureGit(copiedRoot, { symlinks: true });
  runGitOrThrow(consumerRoot, ["init", "-q"]);
  configureFixtureGit(consumerRoot, { symlinks: true });
  for (const { relPath, blob } of plainLinks) {
    const sourceObjectId = runGitOrThrow(
      copiedRoot,
      ["hash-object", "-w", "--stdin"],
      blob
    ).trim();
    runGitOrThrow(copiedRoot, [
      "update-index",
      "--add",
      "--cacheinfo",
      `120000,${sourceObjectId},${relPath}`,
    ]);
    const consumerObjectId = runGitOrThrow(
      consumerRoot,
      ["hash-object", "-w", "--stdin"],
      blob
    ).trim();
    runGitOrThrow(consumerRoot, [
      "update-index",
      "--add",
      "--cacheinfo",
      `120000,${consumerObjectId},${relPath}`,
    ]);
  }
}

/**
 * Create a temp consumer repo with a bootstrap .devpro-agent-rules submodule.
 * @param {{ fullSubmod?: boolean }} opts
 *   fullSubmod=true — legacy mirror of STATIC_FILES + SYNC_DIRS into submod (mutate-source tests).
 *   fullSubmod=false (default) — slim bootstrap; run() points sync at real sourceRoot via test env.
 */
export async function createConsumerRepo({ fullSubmod = false } = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-test-"));
  const submod = path.join(tmpDir, ".devpro-agent-rules");

  await fs.mkdir(path.join(submod, ".devpro", "scripts"), { recursive: true });
  await fs.mkdir(path.join(submod, ".github"), { recursive: true });

  await fs.copyFile(
    path.join(sourceRoot, ".devpro", "scripts", "sync-agent-rules.mjs"),
    path.join(submod, ".devpro", "scripts", "sync-agent-rules.mjs")
  );
  await copySyncEntrypointLibs(path.join(submod, ".devpro", "scripts"));
  await copyDir(
    path.join(sourceRoot, ".devpro", "scripts", "hooks", "lib"),
    path.join(submod, ".devpro", "scripts", "hooks", "lib")
  );
  await fs.copyFile(
    path.join(sourceRoot, "AGENTS.md"),
    path.join(submod, "AGENTS.md")
  );

  if (fullSubmod) {
    for (const subdir of ["agents", "skills"]) {
      const claudeSubdirSrc = path.join(sourceRoot, ".claude", subdir);
      if (await fs.access(claudeSubdirSrc).then(() => true).catch(() => false)) {
        await copyDir(claudeSubdirSrc, path.join(submod, ".claude", subdir));
      }
    }

    const settingsSrc = path.join(sourceRoot, ".claude", "settings.json");
    if (await fs.access(settingsSrc).then(() => true).catch(() => false)) {
      await fs.copyFile(settingsSrc, path.join(submod, ".claude", "settings.json"));
    }
    for (const { relPath } of STATIC_FILES) {
      const src = path.join(sourceRoot, relPath);
      if (await fs.access(src).then(() => true).catch(() => false)) {
        const dst = path.join(submod, relPath);
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.copyFile(src, dst);
      }
    }
    for (const { relPath } of SYNC_DIRS) {
      const src = path.join(sourceRoot, relPath);
      if (await fs.access(src).then(() => true).catch(() => false)) {
        await copyDir(src, path.join(submod, relPath));
      }
    }
    await preservePlainDiscoveryGitEvidence(sourceRoot, submod, tmpDir);
  }

  const syncScript = path.join(submod, ".devpro", "scripts", "sync-agent-rules.mjs");
  return { tmpDir, submod, syncScript, fullSubmod };
}

export function run(script, args = "", { cwd, env: extraEnv = {}, input, timeout = 30_000, fullSubmodSource = runUsesFullSubmodSource, useTestSourceRoot = !fullSubmodSource, testSourceRoot = useTestSourceRoot ? sourceRoot : null } = {}) {
  const env = {
    ...fixtureGitEnv(cwd || process.cwd()),
    ...extraEnv,
    // Git-heavy consumer fixtures must not inherit the host's system/global
    // config. Keep the shared timeout unchanged; callers opt into a scoped
    // timeout only for a measured slow spawn.
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

export async function withConsumerRepo(fn, { fullSubmod = false } = {}) {
  const ctx = await createConsumerRepo({ fullSubmod });
  const prev = runUsesFullSubmodSource;
  runUsesFullSubmodSource = fullSubmod;
  try {
    return await fn(ctx);
  } finally {
    runUsesFullSubmodSource = prev;
    await removeTempTree(ctx.tmpDir);
  }
}

// Temp trees hold real git repositories (`.git/objects` written by helper git
// processes). Under the parallel integration tier on macOS a recursive remove
// can still see an entry appear while the last writer finishes and fail the
// whole file with ENOTEMPTY (release Build-once 2026-11-13 reproduced it from a
// linked worktree three times while the same tree passed in the main checkout).
// A bounded retry keeps the teardown from turning that race into a red suite.
const TEMP_TREE_REMOVE_RETRIES = 10;
const TEMP_TREE_REMOVE_RETRY_DELAY_MS = 100;

export async function removeTempTree(dir) {
  await fs.rm(dir, {
    recursive: true,
    force: true,
    maxRetries: TEMP_TREE_REMOVE_RETRIES,
    retryDelay: TEMP_TREE_REMOVE_RETRY_DELAY_MS,
  });
}

async function writeTextFile(root, relPath, content) {
  const targetPath = path.join(root, ...relPath.split("/"));
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content);
}

export async function createSlimSyncSource() {
  const slimSource = await fs.mkdtemp(path.join(os.tmpdir(), "sync-slim-source-"));
  // Post-2-entry-topology (design D1/D3): the fixture's single synthetic
  // skill lives under the catalog root, and BOTH discovery dirs carry only
  // the `devpro` entry — a symlink resolving to the catalog root itself,
  // not to any individual skill directory.
  const skillRelPath = `${SKILL_TARGET_ROOT}/devpro-workflows/workflows`;
  const discoveryTarget = SKILL_ENTRY_LINK_TARGET;

  await fs.copyFile(path.join(sourceRoot, "AGENTS.md"), path.join(slimSource, "AGENTS.md"));
  await writeTextFile(slimSource, "CLAUDE.md", "# Slim Claude\n");
  await writeTextFile(slimSource, "GEMINI.md", "# Slim Gemini\n");
  await writeTextFile(slimSource, ".windsurfrules", "# Slim Windsurf\n");
  await writeTextFile(slimSource, ".github/PULL_REQUEST_TEMPLATE.md", "# PR template\n");
  await writeTextFile(
    slimSource,
    ".devpro/agent-rules/gitignore-alignment.md",
    [
      "<!-- devpro-gitignore-baseline begin -->",
      ".worktree/",
      "notes/",
      "<!-- devpro-gitignore-baseline end -->",
      "",
    ].join("\n")
  );
  await fs.mkdir(path.join(slimSource, ".devpro", "scripts"), { recursive: true });
  await fs.copyFile(
    path.join(sourceRoot, ".devpro", "scripts", "sync-agent-rules.mjs"),
    path.join(slimSource, ".devpro", "scripts", "sync-agent-rules.mjs")
  );
  await copySyncEntrypointLibs(path.join(slimSource, ".devpro", "scripts"));
  await copyDir(
    path.join(sourceRoot, ".devpro", "scripts", "hooks", "lib"),
    path.join(slimSource, ".devpro", "scripts", "hooks", "lib")
  );
  await writeTextFile(
    slimSource,
    ".claude/settings.json",
    JSON.stringify({ model: "test-model", hooks: {}, statusLine: { type: "command", command: "echo ok" } }, null, 2) + "\n"
  );
  await writeTextFile(
    slimSource,
    ".codex/hooks.json",
    JSON.stringify({ hooks: { pre_tool_use: [{ command: "true" }] } }, null, 2) + "\n"
  );
  await writeTextFile(
    slimSource,
    ".cursor/hooks.json",
    JSON.stringify({ version: 1, hooks: { pre_tool_use: [{ command: "true" }] } }, null, 2) + "\n"
  );
  await writeTextFile(slimSource, `${skillRelPath}/SKILL.md`, "# Workflows\n");
  await writeTextFile(
    slimSource,
    `${SKILL_TARGET_ROOT}/manifest.json`,
    JSON.stringify(
      { name: "devpro-agent-skills", groups: [{ name: "devpro-workflows", skills: [{ path: skillRelPath }] }] },
      null,
      2
    ) + "\n"
  );
  await writeTextFile(
    slimSource,
    `${SKILL_TARGET_ROOT}/.claude-plugin/plugin.json`,
    JSON.stringify({ name: SKILL_ENTRY_NAME, description: "Slim fixture plugin manifest.", skills: ["./devpro-workflows"] }, null, 2) + "\n"
  );
  // buildManagedSkillInventory() reads the refs manifest unconditionally
  // (design D3.1) — an empty-groups refs manifest keeps this fixture's
  // second root a no-op without requiring every consumer of this fixture
  // to also stage refs skills.
  await writeTextFile(
    slimSource,
    `${SKILL_REFS_ROOT}/manifest.json`,
    JSON.stringify({ name: "devpro-agent-skill-refs", groups: [] }, null, 2) + "\n"
  );

  for (const discoveryDir of [".agents/skills", ".claude/skills"]) {
    await fs.mkdir(path.join(slimSource, ...discoveryDir.split("/")), { recursive: true });
      await createPortableTestSymlink(
        discoveryTarget,
        path.join(slimSource, ...discoveryDir.split("/"), SKILL_ENTRY_NAME),
        "directory"
      );
  }

  return { sourceRoot: slimSource, discoveryTarget, skillRelPath };
}

export async function withSlimSyncSource(callback) {
  const slim = await createSlimSyncSource();
  try {
    return await callback(slim);
  } finally {
    await removeTempTree(slim.sourceRoot);
  }
}

export async function copyDirRecursive(src, dst) {
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
export async function createConsumerRepoWithSubmodule() {
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
  await fs.mkdir(path.join(sourceRepoDir, ".devpro", "scripts"), { recursive: true });
  await fs.copyFile(
    path.join(sourceRoot, ".devpro", "scripts", "sync-agent-rules.mjs"),
    path.join(sourceRepoDir, ".devpro", "scripts", "sync-agent-rules.mjs")
  );
  await copySyncEntrypointLibs(path.join(sourceRepoDir, ".devpro", "scripts"));
  await copyDirRecursive(
    path.join(sourceRoot, ".devpro", "scripts", "hooks", "lib"),
    path.join(sourceRepoDir, ".devpro", "scripts", "hooks", "lib")
  );
  await fs.copyFile(
    path.join(sourceRoot, "AGENTS.md"),
    path.join(sourceRepoDir, "AGENTS.md")
  );
  // gitignoreBaselineEntries() reads the SSOT markers from this leaf on every
  // --sync/--check run; a full --sync (as opposed to the --uninstall-only
  // uses this fixture originally supported) needs it present or syncGitignore
  // throws "Invalid gitignore SSOT markers".
  await fs.mkdir(path.join(sourceRepoDir, ".devpro", "agent-rules"), { recursive: true });
  await fs.copyFile(
    path.join(sourceRoot, ".devpro", "agent-rules", "gitignore-alignment.md"),
    path.join(sourceRepoDir, ".devpro", "agent-rules", "gitignore-alignment.md")
  );
  const sourceRepoEnv = fixtureGitEnv(sourceRepoDir, authors);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: sourceRepoDir, env: sourceRepoEnv });
  configureFixtureGit(sourceRepoDir, { overrides: authors });
  spawnSync("git", ["add", "-A"], { cwd: sourceRepoDir, env: sourceRepoEnv });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: sourceRepoDir, env: sourceRepoEnv });

  const gitEnv = fixtureGitEnv(tmpDir, authors);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: tmpDir, env: gitEnv });
  configureFixtureGit(tmpDir, { overrides: authors });

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

export async function cleanupConsumerRepoWithSubmodule(ctx) {
  await removeTempTree(ctx.tmpDir);
  await removeTempTree(ctx.sourceRepoDir);
}

export function countGitignoreEntry(content, entry) {
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim() === entry).length;
}

export async function readFileOrEmptyLocal(targetPath) {
  try {
    return await fs.readFile(targetPath, "utf8");
  } catch {
    return "";
  }
}

export async function createFakeCommand(binDir, name) {
  const commandPath = path.join(binDir, process.platform === "win32" ? `${name}.cmd` : name);
  await fs.mkdir(binDir, { recursive: true });
  if (process.platform === "win32") {
    await fs.writeFile(commandPath, "@exit /b 0\r\n");
  } else {
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n");
    await fs.chmod(commandPath, 0o755);
  }
  return commandPath;
}

export async function createLegacySecondReviewArtifact(root, relPath) {
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

export async function lstatExists(targetPath) {
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
export async function createGitFlowFixture() {
  const local = await createConsumerRepo();
  const originDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-origin-"));
  const binDir = path.join(local.tmpDir, "git-flow-bin");
  const ghArgsFile = path.join(local.tmpDir, "gh-args.txt");
  const ghBodyCaptureFile = path.join(local.tmpDir, "gh-body-capture.txt");

  const authors = {
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com",
  };

  const originEnv = fixtureGitEnv(originDir, authors);
  const gitEnv = fixtureGitEnv(local.tmpDir, authors);
  spawnSync("git", ["init", "-q", "--bare"], { cwd: originDir, env: originEnv });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: local.tmpDir, env: gitEnv });
  configureFixtureGit(local.tmpDir, { overrides: authors });
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

export async function cleanupGitFlowFixture(ctx) {
  await removeTempTree(ctx.tmpDir);
  await removeTempTree(ctx.originDir);
}

export function gitFlowEnv(binDir) {
  return { PATH: `${binDir}:${process.env.PATH}` };
}

export function autoCompactEnv(homeDir, binDir) {
  return {
    HOME: homeDir,
    PATH: binDir,
    SHELL: "/bin/zsh",
  };
}

export async function withEnv(overrides, fn) {
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

export function fakePromptSession(answer) {
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
export async function withFakeTty(answerLine, fn) {
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

/**
 * Injectable `gh` executor for the add-sync-merge-policy-check RED tests
 * (`maybeRepairConsumerMergePolicy`'s `options.runGh` seam, design.md D2).
 * Dispatches purely on `args[0]`/`args[1]` (`repo view` / `repo edit`) so
 * tests never spawn a real `gh` process or write a PATH fixture script.
 *
 * `view`/`edit` may each be:
 *   - a plain spawnSync-shaped result object: `{ status, stdout, stderr }`
 *     or `{ error }` (mimics a spawnSync timeout/ENOENT failure), reused
 *     for every matching call; or
 *   - a function `(args, { cwd }) => result` for per-call variation.
 * Unmatched argv (neither `repo view` nor `repo edit`) returns a non-zero
 * failure result rather than throwing, so a test with a wrong/missing stub
 * still gets a diagnosable result instead of an unhandled rejection.
 *
 * `calls` collects every full argv array in call order for assertions like
 * DW-1's `--enable-merge-commit` / `--enable-squash-merge=false` ordering.
 */
export function fakeGhExecutor({ view, edit } = {}) {
  const calls = [];
  function runGh(args, options = {}) {
    calls.push(args);
    const [resource, action] = args;
    if (resource === "repo" && action === "view") {
      return typeof view === "function" ? view(args, options) : view;
    }
    if (resource === "repo" && action === "edit") {
      return typeof edit === "function" ? edit(args, options) : edit;
    }
    return { status: 1, stdout: "", stderr: `fakeGhExecutor: unhandled gh ${args.join(" ")}` };
  }
  return { runGh, calls };
}

export function captureConsole(fn) {
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
