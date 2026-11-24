import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync as nativeSpawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import os from "node:os";
import { Readable } from "node:stream";
import {
  STATIC_FILES,
  SYNC_DIRS,
  LEGACY_SOURCE_WORKFLOW_FILES,
  LEGACY_SECOND_REVIEW_ARTIFACTS,
  LEGACY_RULE_GOVERNANCE_SKILL_ARTIFACTS,
  GITIGNORE_MANAGED_BEGIN,
  GITIGNORE_MANAGED_END,
  GITATTRIBUTES_MANAGED_BEGIN,
  GITATTRIBUTES_MANAGED_END,
  GITATTRIBUTES_MANAGED_ENTRIES,
  managedBlockRemediation,
  TEST_SYNC_SOURCE_ROOT_ENV,
  runCheck,
  runSync,
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

async function copyDir(src, dst) {
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

function run(script, args = "", { cwd, env: extraEnv = {}, input, timeout = 30_000, fullSubmodSource = runUsesFullSubmodSource, useTestSourceRoot = !fullSubmodSource } = {}) {
  const env = {
    ...fixtureGitEnv(cwd || process.cwd()),
    ...extraEnv,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: cwd ? path.join(cwd, ".git", "fixture-global-config") : "",
  };
  if (useTestSourceRoot) {
    env[TEST_SYNC_SOURCE_ROOT_ENV] = SOURCE_ROOT;
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

async function writeTextFile(root, relPath, content) {
  const targetPath = path.join(root, ...relPath.split("/"));
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content);
}

// .cursor/skills was retired as a managed discovery root (design D1 of
// remove-cursor-skill-discovery); the slim source only ever needs the two
// active discovery roots now (design D9 — no `discoveryDirs` override is
// needed once nothing in this file depends on a three-root source).
//
// design D1/D3 (refactor-agent-skills-entry) — discovery is now a single
// `devpro` entry per root resolving to the catalog root itself, not a
// per-skill link; the catalog also needs a refs root/manifest (design D2)
// and a plugin manifest (design D1) for buildManagedSkillInventory() to
// accept it at all.
async function createSlimManagedSource() {
  const discoveryDirs = [".agents/skills", ".claude/skills"];
  const sourceRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-check-slim-source-"));
  const managedSkills = [
    {
      relPath: ".devpro/agent-skills/devpro-reviews/second-review",
      skillBody: "# Second review\n",
    },
    {
      relPath: ".devpro/agent-skills/rules-authoring/rule-governance",
      skillBody: "# Rule governance\n",
    },
  ];

  await writeTextFile(sourceRootDir, "AGENTS.md", "# Slim AGENTS\n");
  await writeTextFile(sourceRootDir, "GEMINI.md", "# Slim Gemini\n");
  await writeTextFile(sourceRootDir, ".github/PULL_REQUEST_TEMPLATE.md", "# PR template\n");
  await writeTextFile(
    sourceRootDir,
    ".devpro/agent-rules/gitignore-alignment.md",
    [
      "<!-- devpro-gitignore-baseline begin -->",
      ".worktree/",
      "notes/",
      "<!-- devpro-gitignore-baseline end -->",
      "",
    ].join("\n")
  );
  await fs.mkdir(path.join(sourceRootDir, ".devpro/scripts/lib"), { recursive: true });
  await fs.copyFile(
    sourcePath(".devpro/scripts/lib/rule-token-budget.mjs"),
    path.join(sourceRootDir, ".devpro/scripts/lib/rule-token-budget.mjs")
  );
  await writeTextFile(
    sourceRootDir,
    ".claude/settings.json",
    JSON.stringify(
      {
        model: "test-model",
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "true" }] }] },
        statusLine: { type: "command", command: "echo ok" },
      },
      null,
      2
    ) + "\n"
  );
  await writeTextFile(
    sourceRootDir,
    ".codex/hooks.json",
    JSON.stringify(
      { hooks: { pre_tool_use: [{ command: "true" }] } },
      null,
      2
    ) + "\n"
  );
  await writeTextFile(
    sourceRootDir,
    ".cursor/hooks.json",
    JSON.stringify(
      { hooks: { pre_tool_use: [{ command: "true" }] } },
      null,
      2
    ) + "\n"
  );
  await writeTextFile(
    sourceRootDir,
    ".claude/agents/dp-second-reviewer.md",
    "# Second-reviewer agent\n"
  );
  await writeTextFile(
    sourceRootDir,
    ".codex/agents/dp-second-reviewer.toml",
    "name = \"dp-second-reviewer\"\n"
  );
  await writeTextFile(
    sourceRootDir,
    ".cursor/agents/dp-second-reviewer.md",
    "# Second-reviewer agent\n"
  );

  for (const skill of managedSkills) {
    await writeTextFile(sourceRootDir, `${skill.relPath}/SKILL.md`, skill.skillBody);
  }
  await writeTextFile(
    sourceRootDir,
    ".devpro/agent-skills/manifest.json",
    JSON.stringify(
      {
        groups: [
          {
            name: "devpro-reviews",
            skills: [{ path: managedSkills[0].relPath }],
          },
          {
            name: "rules-authoring",
            skills: [{ path: managedSkills[1].relPath }],
          },
        ],
      },
      null,
      2
    ) + "\n"
  );
  // design D1 — plugin manifest is a managed FILE output, not a skill
  // target; buildManagedSkillInventory() requires it to exist as a plain
  // file at the catalog root.
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

  // design D3 — discovery is a single `devpro` entry per root, resolving to
  // the catalog root itself (not a per-skill link).
  for (const discoveryDir of discoveryDirs) {
    await fs.mkdir(path.join(sourceRootDir, ...discoveryDir.split("/")), { recursive: true });
    await createPortableTestSymlink(
      "../../.devpro/agent-skills",
      path.join(sourceRootDir, ...discoveryDir.split("/"), "devpro"),
      "directory"
    );
  }

  return { sourceRoot: sourceRootDir };
}

async function copyDirRecursive(src, dst, { excludeTopLevelNames = new Set() } = {}) {
  await fs.mkdir(dst, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (excludeTopLevelNames.has(entry.name)) {
      continue;
    }
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

async function removeDirEntriesExcept(root, keepNames) {
  await fs.mkdir(root, { recursive: true });
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (keepNames.has(entry.name)) {
      continue;
    }
    await fs.rm(path.join(root, entry.name), { recursive: true, force: true });
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

async function createLegacyRuleGovernanceSkillArtifact(root, relPath) {
  const artifactPath = path.join(root, relPath);
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });

  if (relPath.startsWith(".devpro/agent-skills/rules-authoring/")) {
    await fs.mkdir(artifactPath, { recursive: true });
    await fs.writeFile(path.join(artifactPath, "SKILL.md"), `# legacy ${path.basename(relPath)} skill\n`);
    return;
  }

  if (relPath.includes("/skills/")) {
    const skillName = path.basename(relPath);
    await createPortableTestSymlink(
      `../../.devpro/agent-skills/rules-authoring/${skillName}`,
      artifactPath,
      "directory"
    );
    return;
  }

  throw new Error(`Unexpected legacy rule-governance artifact fixture path: ${relPath}`);
}

async function lstatExists(targetPath) {
  return fs.lstat(targetPath).then(() => true).catch(() => false);
}

// Fixed 20-name allowlist mirrored from design D2 / spec's
// `Sync Symlink Distribution` requirement. Kept as a local literal (an
// independent oracle) rather than importing sync-agent-rules.mjs's own
// `LEGACY_CURSOR_SKILL_DISCOVERY_ARTIFACTS` — the fixture proves the engine's
// list against a hand-copied source-of-truth, not against itself.
// legacy-skill-names:begin fixed-20-name-cursor-allowlist
const CURSOR_SKILL_DISCOVERY_ALLOWLIST = [
  "cmux-surface-comms",
  "dp-change",
  "dp-clarify",
  "dp-consumer-doctor",
  "dp-cross-review",
  "dp-init",
  "dp-knowledge-distill",
  "dp-knowledge-ingest",
  "dp-load-plan",
  "dp-pre-pr",
  "dp-recap-writer",
  "dp-release-runbook",
  "dp-rule-governance",
  "dp-second-review",
  "dp-second-review-dogfood",
  "dp-security-scan",
  "dp-setup-ci",
  "dp-sync-rules",
  "dp-workflows",
  "openspec-artifact-authoring",
];
// legacy-skill-names:end fixed-20-name-cursor-allowlist

/**
 * Creates one `.cursor/skills/<name>` legacy discovery artifact in one of
 * three residue shapes, so the prove-it test can assert `nodeExists`
 * (lstat-based, type-agnostic) catches all of them per the
 * `Retired Legacy Skill Discovery Links Are Pruned By Sync` scenario:
 *   - "symlink" (default): a live symlink, mirroring what --sync historically
 *     distributed.
 *   - "dangling": a symlink whose target does not exist.
 *   - "plain-file": a Git-backed plain-file residue variant (e.g. what a
 *     Windows consumer without symlink capability would have checked out at
 *     mode 120000; the fixture only needs a plain file node here since
 *     nodeExists() is type-agnostic).
 */
// legacy-skill-names:begin cursor-legacy-shipped-literal-target
async function createCursorSkillDiscoveryArtifact(root, name, variant = "symlink") {
  const artifactPath = path.join(root, ".cursor", "skills", name);
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  // Defensive/idempotent: clear any pre-existing node at this exact path
  // before writing the requested variant, so repeated calls (or a stray
  // leftover from a previous run) never collide with fs.symlink()'s EEXIST.
  await fs.rm(artifactPath, { recursive: true, force: true });

  // The fixture's target is a fixed pre-rename SSOT literal regardless of
  // `name`, mirroring a historically shipped `.cursor/skills/<name>` link
  // (design D5's frozen shipped-literal allowlist) — only the artifact's
  // own existence/removal matters to these prove-its, not what it points to.
  if (variant === "plain-file") {
    await fs.writeFile(artifactPath, "../../.devpro/agent-skills/devpro-reviews/dp-second-review\n");
    return;
  }

  const target =
    variant === "dangling"
      ? "../../.devpro/agent-skills/does-not-exist/" + name
      : "../../.devpro/agent-skills/devpro-reviews/dp-second-review";
  await createPortableTestSymlink(target, artifactPath, "directory");
}
// legacy-skill-names:end cursor-legacy-shipped-literal-target

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
    PATH: `${binDir}:${process.env.PATH}`,
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
  const originalWarn = console.warn;
  const originalError = console.error;
  const stdoutLines = [];
  const stderrLines = [];
  console.log = (...args) => { stdoutLines.push(args.join(" ")); };
  console.warn = (...args) => { stderrLines.push(args.join(" ")); };
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
      exitCode: 1,
      stdout: stdoutLines.join("\n"),
      stderr: [stderrLines.join("\n"), error.message].filter(Boolean).join("\n"),
    };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

async function runCheckInProcess(consumerRoot, { sourceRootOverride = SOURCE_ROOT } = {}) {
  return withFixtureGitEnv(consumerRoot, () => withEnv(
    {
      [TEST_SYNC_SOURCE_ROOT_ENV]: sourceRootOverride,
    },
    () => captureConsoleResult(() => runCheck(consumerRoot))
  ));
}

async function runSyncInProcess(consumerRoot, { sourceRootOverride = SOURCE_ROOT } = {}) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-check-auto-compact-home-"));
  const binDir = path.join(homeDir, "bin");
  await fs.mkdir(binDir, { recursive: true });
  try {
    return await withFixtureGitEnv(consumerRoot, () => withEnv(
      {
        [TEST_SYNC_SOURCE_ROOT_ENV]: sourceRootOverride,
        ...autoCompactEnv(homeDir, binDir),
      },
      () => captureConsoleResult(() => runSync(consumerRoot))
    ));
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// --check (split from sync-agent-rules.test.mjs for file-level parallelism)
// ---------------------------------------------------------------------------

describe("--check", () => {
  let ctx;
  let syncedConsumerSnapshotDir;
  let syncedSourceSnapshotDir;
  let slimCtx;
  let slimConsumerSnapshotDir;
  let slimSourceSnapshotDir;

  async function runCtxCheck() {
    return runCheckInProcess(ctx.tmpDir, { sourceRootOverride: ctx.submod });
  }

  async function runCtxSync() {
    return runSyncInProcess(ctx.tmpDir, { sourceRootOverride: ctx.submod });
  }

  async function runSlimCheck() {
    return runCheckInProcess(slimCtx.tmpDir, { sourceRootOverride: slimCtx.sourceRoot });
  }

  async function runSlimSync() {
    return runSyncInProcess(slimCtx.tmpDir, { sourceRootOverride: slimCtx.sourceRoot });
  }

  async function initializeConsumerIndex(consumerRoot) {
    const init = spawnSync("git", ["init", "--quiet"], { cwd: consumerRoot, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const addAll = spawnSync("git", ["add", "-A"], { cwd: consumerRoot, encoding: "utf8" });
    assert.equal(addAll.status, 0, addAll.stderr);
  }

  async function installCaseVariantConsumerTemplate(consumerRoot) {
    const canonicalPath = path.join(consumerRoot, ".github", "PULL_REQUEST_TEMPLATE.md");
    const consumerPath = path.join(consumerRoot, ".github", "pull_request_template.md");
    await fs.rm(canonicalPath, { force: true });
    await fs.writeFile(consumerPath, "# consumer-owned template\n");

    const removeCanonical = spawnSync(
      "git",
      ["update-index", "--force-remove", "--", ".github/PULL_REQUEST_TEMPLATE.md"],
      { cwd: consumerRoot, encoding: "utf8" }
    );
    assert.equal(removeCanonical.status, 0, removeCanonical.stderr);
    const addConsumerPath = spawnSync(
      "git",
      ["add", "--", ".github/pull_request_template.md"],
      { cwd: consumerRoot, encoding: "utf8" }
    );
    assert.equal(addConsumerPath.status, 0, addConsumerPath.stderr);
    return consumerPath;
  }

  before(async () => {
    runUsesFullSubmodSource = true;
    ctx = await createConsumerRepo({ fullSubmod: true });
    const sync = await runCtxSync();
    assert.equal(sync.exitCode, 0, sync.stderr);
    syncedConsumerSnapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-check-baseline-"));
    syncedSourceSnapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-check-source-baseline-"));
    await copyDirRecursive(ctx.tmpDir, syncedConsumerSnapshotDir, {
      excludeTopLevelNames: new Set([".devpro-agent-rules"]),
    });
    await copyDirRecursive(ctx.submod, syncedSourceSnapshotDir);

    const slimSource = await createSlimManagedSource();
    slimCtx = {
      tmpDir: await fs.mkdtemp(path.join(os.tmpdir(), "sync-check-slim-consumer-")),
      sourceRoot: slimSource.sourceRoot,
    };
    const slimSync = await runSlimSync();
    assert.equal(slimSync.exitCode, 0, slimSync.stderr);
    slimConsumerSnapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-check-slim-baseline-"));
    slimSourceSnapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-check-slim-source-baseline-"));
    await copyDirRecursive(slimCtx.tmpDir, slimConsumerSnapshotDir);
    await copyDirRecursive(slimCtx.sourceRoot, slimSourceSnapshotDir);
  });
  after(async () => {
    runUsesFullSubmodSource = false;
    await fs.rm(ctx.tmpDir, { recursive: true, force: true });
    await fs.rm(syncedConsumerSnapshotDir, { recursive: true, force: true });
    await fs.rm(syncedSourceSnapshotDir, { recursive: true, force: true });
    await fs.rm(slimCtx.tmpDir, { recursive: true, force: true });
    await fs.rm(slimCtx.sourceRoot, { recursive: true, force: true });
    await fs.rm(slimConsumerSnapshotDir, { recursive: true, force: true });
    await fs.rm(slimSourceSnapshotDir, { recursive: true, force: true });
  });

  async function resetSyncedConsumer() {
    await removeDirEntriesExcept(ctx.tmpDir, new Set([".devpro-agent-rules"]));
    await copyDirRecursive(syncedConsumerSnapshotDir, ctx.tmpDir);
  }

  async function restoreSubmoduleSource() {
    await fs.rm(ctx.submod, { recursive: true, force: true });
    await copyDirRecursive(syncedSourceSnapshotDir, ctx.submod);
  }

  async function resetSlimConsumer() {
    await removeDirEntriesExcept(slimCtx.tmpDir, new Set());
    await copyDirRecursive(slimConsumerSnapshotDir, slimCtx.tmpDir);
  }

  async function restoreSlimSource() {
    await fs.rm(slimCtx.sourceRoot, { recursive: true, force: true });
    await copyDirRecursive(slimSourceSnapshotDir, slimCtx.sourceRoot);
  }

  it("fails when AGENTS.md not yet synced", async () => {
    await withConsumerRepo(async (local) => {
      const { exitCode, stderr } = await runCheckInProcess(local.tmpDir);
      assert.equal(exitCode, 1);
      assert.match(stderr, /Out of sync|differs/);
    });
  });

  it("passes after sync", async () => {
    await resetSyncedConsumer();
    const { exitCode, stdout } = await runCtxCheck();
    assert.equal(exitCode, 0);
    assert.match(stdout, /All derived files are in sync/);
  });

  it("installs and loads the shared production token policy in a consumer", async () => {
    await resetSlimConsumer();
    const installedPath = path.join(slimCtx.tmpDir, ".devpro/scripts/lib/rule-token-budget.mjs");
    const installed = await import(`${pathToFileURL(installedPath).href}?consumer=${Date.now()}`);
    const carrier = ".devpro/agent-rules/consumer-carrier.md";
    const result = installed.measureRuleTokenBudget({
      cwd: slimCtx.tmpDir,
      manifest: {
        state: "known-nonempty",
        entries: [{ status: "M", oldPath: "", newPath: carrier, probe: "unstaged" }],
      },
      readFile: () => Buffer.from("consumer final bytes\n"),
    });

    assert.equal(typeof installed.measureRuleTokenBudget, "function");
    assert.equal(result.files[0].path, carrier);
    assert.equal(result.files[0].reason, "none");
    assert.equal(result.verdict, "pass");
  });

  it("fails when .gitignore managed block is missing", async () => {
    await resetSlimConsumer();
    await fs.writeFile(path.join(slimCtx.tmpDir, ".gitignore"), "consumer-local/\n");

    const { exitCode, stderr } = await runSlimCheck();
    assert.equal(exitCode, 1);
    assert.match(stderr, /\.gitignore is missing devpro-agent-rules managed block/);
    assert.match(stderr, /--sync/);
  });

  it("fails when .gitignore managed block drifts", async () => {
    await resetSlimConsumer();
    const gitignorePath = path.join(slimCtx.tmpDir, ".gitignore");
    const content = await fs.readFile(gitignorePath, "utf8");
    await fs.writeFile(gitignorePath, content.replace(".worktree/", ".worktree-drift/\n"));

    const { exitCode, stderr } = await runSlimCheck();
    assert.equal(exitCode, 1);
    assert.match(stderr, /\.gitignore managed block differs/);
    assert.match(stderr, /gitignore-alignment\.md/);
    assert.match(stderr, /--sync/);
  });

  it("fails when .gitignore has duplicate managed entries outside the block", async () => {
    await resetSlimConsumer();
    const gitignorePath = path.join(slimCtx.tmpDir, ".gitignore");
    await fs.appendFile(gitignorePath, "\nnotes/\n");

    const { exitCode, stderr } = await runSlimCheck();
    assert.equal(exitCode, 1);
    assert.match(stderr, /\.gitignore has duplicate managed entries outside the block/);
    assert.match(stderr, /notes\//);
    assert.match(stderr, /--sync/);
  });

  it("fails when .gitignore managed block has malformed markers", async (t) => {
    const cases = [
      {
        name: "missing end marker",
        transform: (content) => content.replace(`${GITIGNORE_MANAGED_END}\n`, ""),
        pattern: /\.gitignore managed block is missing end marker/,
        manualPattern: /Manually add the missing managed-block end marker/,
      },
      {
        name: "orphan end marker",
        transform: (content) => `${GITIGNORE_MANAGED_END}\n${content}`,
        pattern: /\.gitignore managed end marker has no begin marker/,
        manualPattern: /Manually delete the orphan managed-block end marker/,
      },
      {
        name: "nested begin marker",
        transform: (content) =>
          content.replace(`${GITIGNORE_MANAGED_BEGIN}\n`, `${GITIGNORE_MANAGED_BEGIN}\n${GITIGNORE_MANAGED_BEGIN}\n`),
        pattern: /\.gitignore has nested managed block markers/,
        manualPattern: /Manually delete the extra inner managed-block begin marker/,
      },
    ];

    for (const entry of cases) {
      await t.test(entry.name, async () => {
        await resetSlimConsumer();
        const gitignorePath = path.join(slimCtx.tmpDir, ".gitignore");
        const content = await fs.readFile(gitignorePath, "utf8");
        await fs.writeFile(gitignorePath, entry.transform(content));

        const { exitCode, stderr } = await runSlimCheck();
        assert.equal(exitCode, 1);
        assert.match(stderr, entry.pattern);
        assert.doesNotMatch(stderr, /Run sync-agent-rules\.mjs --sync\./);
        assert.match(stderr, entry.manualPattern);
      });
    }
  });

  it("managedBlockRemediation falls to a generic manual instruction for a drift string outside the allowlist", () => {
    const hypothetical = "this drift shape does not exist yet";
    const remediation = managedBlockRemediation(hypothetical);
    assert.doesNotMatch(remediation, /Run sync-agent-rules\.mjs --sync\./);
    assert.match(remediation, /Manually inspect and resolve this drift/);
  });

  it("passes when .gitignore managed block is canonical and local entries exist", async () => {
    await resetSlimConsumer();
    const gitignorePath = path.join(slimCtx.tmpDir, ".gitignore");
    // Use a genuine consumer-local entry. `node_modules/` is now in the
    // Devpro-managed baseline, so it folds INTO the managed block and is no
    // longer a "local entry" — using it here would not exercise the
    // canonical-block + local-entry coexistence this test name claims.
    await fs.writeFile(gitignorePath, "coverage-local/\n");
    await runSlimSync();

    const { exitCode, stdout, stderr } = await runSlimCheck();
    assert.equal(exitCode, 0, stderr);
    assert.match(stdout, /All derived files are in sync/);
  });

  it("fails when .gitattributes managed block is missing", async () => {
    await resetSlimConsumer();
    await fs.writeFile(path.join(slimCtx.tmpDir, ".gitattributes"), "*.png binary\n");

    const { exitCode, stderr } = await runSlimCheck();
    assert.equal(exitCode, 1);
    assert.match(stderr, /\.gitattributes is missing devpro-agent-rules gitattributes managed block/);
    assert.match(stderr, /--sync/);
  });

  it("fails when .gitattributes managed block drifts", async () => {
    await resetSlimConsumer();
    const attributesPath = path.join(slimCtx.tmpDir, ".gitattributes");
    const content = await fs.readFile(attributesPath, "utf8");
    await fs.writeFile(attributesPath, content.replace(".gitignore text eol=lf", ".gitignore text=auto"));

    const { exitCode, stderr } = await runSlimCheck();
    assert.equal(exitCode, 1);
    assert.match(stderr, /\.gitattributes managed block differs/);
    assert.match(stderr, /--sync/);
  });

  it("fails when .gitattributes managed block was checked out with CRLF", async () => {
    await resetSlimConsumer();
    const attributesPath = path.join(slimCtx.tmpDir, ".gitattributes");
    const content = await fs.readFile(attributesPath, "utf8");
    await fs.writeFile(attributesPath, content.replace(/\n/g, "\r\n"));

    const { exitCode, stderr } = await runSlimCheck();
    assert.equal(exitCode, 1);
    assert.match(stderr, /\.gitattributes managed block differs/);
    assert.match(stderr, /--sync/);
  });

  it("fails when .gitattributes has duplicate managed entries outside the block", async () => {
    await resetSlimConsumer();
    const attributesPath = path.join(slimCtx.tmpDir, ".gitattributes");
    await fs.appendFile(attributesPath, `\n${GITATTRIBUTES_MANAGED_ENTRIES[0]}\n`);

    const { exitCode, stderr } = await runSlimCheck();
    assert.equal(exitCode, 1);
    assert.match(stderr, /\.gitattributes has duplicate managed entries outside the block/);
    assert.match(stderr, /\.devpro\/scripts\/hooks-git\/\*/);
    assert.match(stderr, /--sync/);
  });

  it("fails when .gitattributes managed block has malformed markers", async (t) => {
    const canonical = [
      GITATTRIBUTES_MANAGED_BEGIN,
      ...GITATTRIBUTES_MANAGED_ENTRIES,
      GITATTRIBUTES_MANAGED_END,
    ].join("\n") + "\n";
    const cases = [
      {
        name: "missing end marker",
        content: `${GITATTRIBUTES_MANAGED_BEGIN}\n${GITATTRIBUTES_MANAGED_ENTRIES.join("\n")}\n`,
        pattern: /\.gitattributes managed block is missing end marker/,
        expectSync: false,
        manualPattern: /Manually add the missing managed-block end marker/,
      },
      {
        name: "orphan end marker",
        content: `${GITATTRIBUTES_MANAGED_END}\n${canonical}`,
        pattern: /\.gitattributes managed end marker has no begin marker/,
        expectSync: false,
        manualPattern: /Manually delete the orphan managed-block end marker/,
      },
      {
        name: "nested begin marker",
        content: `${GITATTRIBUTES_MANAGED_BEGIN}\n${GITATTRIBUTES_MANAGED_BEGIN}\n${GITATTRIBUTES_MANAGED_ENTRIES[0]}\n${GITATTRIBUTES_MANAGED_END}\n`,
        pattern: /\.gitattributes has nested managed block markers/,
        expectSync: false,
        manualPattern: /Manually delete the extra inner managed-block begin marker/,
      },
      {
        name: "multiple managed blocks",
        content: `${canonical}\n${canonical}`,
        pattern: /\.gitattributes has multiple devpro-agent-rules gitattributes managed blocks/,
        expectSync: true,
      },
      {
        name: "post-block content",
        content: `${canonical}*.png binary\n`,
        pattern: /\.gitattributes managed block is not terminal/,
        expectSync: true,
      },
    ];

    for (const entry of cases) {
      await t.test(entry.name, async () => {
        await resetSlimConsumer();
        const attributesPath = path.join(slimCtx.tmpDir, ".gitattributes");
        await fs.writeFile(attributesPath, entry.content);

        const { exitCode, stderr } = await runSlimCheck();
        assert.equal(exitCode, 1);
        assert.match(stderr, entry.pattern);
        if (entry.expectSync) {
          assert.match(stderr, /--sync/);
        } else {
          assert.doesNotMatch(stderr, /Run sync-agent-rules\.mjs --sync\./);
          assert.match(stderr, entry.manualPattern);
        }
      });
    }
  });

  it("passes when .gitattributes managed block is canonical and local entries exist", async () => {
    await resetSlimConsumer();
    const attributesPath = path.join(slimCtx.tmpDir, ".gitattributes");
    await fs.writeFile(attributesPath, "*.png binary\n");
    await runSlimSync();

    const content = await fs.readFile(attributesPath, "utf8");
    assert.match(content, /^\*\.png binary$/m);
    assert.match(content, new RegExp(GITATTRIBUTES_MANAGED_BEGIN));
    assert.match(content, new RegExp(GITATTRIBUTES_MANAGED_END));
    for (const entry of GITATTRIBUTES_MANAGED_ENTRIES) {
      assert.equal(countGitignoreEntry(content, entry), 1);
    }

    const { exitCode, stdout, stderr } = await runSlimCheck();
    assert.equal(exitCode, 0, stderr);
    assert.match(stdout, /All derived files are in sync/);
  });

  it("repairs a CRLF .gitattributes managed block before --check", async () => {
    await resetSlimConsumer();
    const attributesPath = path.join(slimCtx.tmpDir, ".gitattributes");
    const content = await fs.readFile(attributesPath, "utf8");
    await fs.writeFile(attributesPath, content.replace(/\n/g, "\r\n"));

    await runSlimSync();
    const repaired = await fs.readFile(attributesPath, "utf8");
    const canonical = [
      GITATTRIBUTES_MANAGED_BEGIN,
      ...GITATTRIBUTES_MANAGED_ENTRIES,
      GITATTRIBUTES_MANAGED_END,
    ].join("\n") + "\n";
    assert.ok(repaired.endsWith(canonical), "sync must rewrite the managed block with LF bytes");

    const { exitCode, stdout, stderr } = await runSlimCheck();
    assert.equal(exitCode, 0, stderr);
    assert.match(stdout, /All derived files are in sync/);
  });

  it("prunes legacy source-managed workflows on --sync", async () => {
    await resetSlimConsumer();
    const legacyWorkflow = path.join(slimCtx.tmpDir, ".github", "workflows", "hook-tests.yml");
    await fs.mkdir(path.dirname(legacyWorkflow), { recursive: true });
    await fs.writeFile(legacyWorkflow, "name: legacy source workflow\n");

    try {
      const { exitCode, stderr } = await runSlimSync();
      assert.equal(exitCode, 0);
      const stillExists = await fs.access(legacyWorkflow).then(() => true).catch(() => false);
      assert.equal(stillExists, false, "legacy workflow must be removed by --sync");
      // The workflow-prune deletion is announced as a loud console.warn (not
      // console.log) — see pruneLegacySourceWorkflows()'s accepted-risk note
      // — so the "Removed legacy" declaration lands on stderr, not stdout.
      assert.match(stderr, /Removed legacy/);
      assert.match(stderr, /hook-tests\.yml/);

      const check = await runSlimCheck();
      assert.equal(check.exitCode, 0, check.stderr);
    } finally {
      await fs.rm(legacyWorkflow, { force: true });
    }
  });

  it("prunes a consumer file colliding with a reserved workflow name (accepted risk, documented)", async () => {
    // This test LOCKS IN a deliberate accepted-risk decision, it does not
    // guard against a bug: LEGACY_SOURCE_WORKFLOW_FILES detection is by
    // filename only (no provenance/content check). The five names in that
    // list are reserved devpro-owned workflow names — the cross-runtime-parity
    // spec documents that consumers MUST NOT create their own file under one
    // of these exact names. If a consumer repo does so anyway, --sync WILL
    // delete it on the next run, same as genuine source-managed residue. The
    // only consumer-facing safeguard is the loud console.warn (asserted via
    // stderr below) pointing at git-restore recovery.
    await resetSlimConsumer();
    const collidingPath = path.join(slimCtx.tmpDir, ".github", "workflows", "hook-tests.yml");
    await fs.mkdir(path.dirname(collidingPath), { recursive: true });
    await fs.writeFile(collidingPath, "name: my own consumer workflow\n");

    try {
      const { exitCode, stderr } = await runSlimSync();
      assert.equal(exitCode, 0);
      const stillExists = await fs.access(collidingPath).then(() => true).catch(() => false);
      assert.equal(
        stillExists,
        false,
        "a consumer file under a reserved workflow name is pruned by design (accepted risk)"
      );
      assert.match(stderr, /Removed legacy/);
      assert.match(stderr, /reserved devpro-owned name/);
    } finally {
      await fs.rm(collidingPath, { force: true });
    }
  });

  // -------------------------------------------------------------------------
  // checkLegacySourceWorkflows (T6/T7, enforce-sync-prune-verification R3)
  // Same independent read-only --check backstop as checkLegacyConsumerCommands,
  // but for the fixed LEGACY_SOURCE_WORKFLOW_FILES allowlist. Shares the SSOT
  // constant with pruneLegacySourceWorkflows() rather than duplicating it.
  // -------------------------------------------------------------------------

  it("fails --check when legacy source-managed workflow residue is present (read-only backstop)", async () => {
    await resetSlimConsumer();
    const [firstLegacyRelPath] = LEGACY_SOURCE_WORKFLOW_FILES;
    const legacyWorkflow = path.join(slimCtx.tmpDir, firstLegacyRelPath);
    await fs.mkdir(path.dirname(legacyWorkflow), { recursive: true });
    await fs.writeFile(legacyWorkflow, "name: legacy source workflow residue\n");

    try {
      const { exitCode, stderr } = await runSlimCheck();
      assert.equal(exitCode, 1, "residue present must fail --check");
      assert.match(stderr, /Out of sync/);

      // Read-only: --check must never delete the residue itself.
      const stillExists = await fs.access(legacyWorkflow).then(() => true).catch(() => false);
      assert.equal(stillExists, true, "--check must not delete legacy workflow residue; it only reports");
    } finally {
      await fs.rm(legacyWorkflow, { force: true });
    }
  });

  it("passes --check when no legacy source-managed workflow residue is present", async () => {
    await resetSlimConsumer();
    for (const relPath of LEGACY_SOURCE_WORKFLOW_FILES) {
      const stillExists = await fs.access(path.join(slimCtx.tmpDir, relPath)).then(() => true).catch(() => false);
      assert.equal(stillExists, false, `precondition: ${relPath} should not exist after a clean sync`);
    }

    const { exitCode, stderr } = await runSlimCheck();
    assert.equal(exitCode, 0, `--check must pass when residue is absent; stderr=${stderr}`);
  });

  it("prunes legacy source-managed dp-second-reviewer skill artifacts on --sync", async () => {
    await resetSlimConsumer();

    for (const relPath of LEGACY_SECOND_REVIEW_ARTIFACTS) {
      await createLegacySecondReviewArtifact(slimCtx.tmpDir, relPath);
    }

    try {
      const { exitCode, stderr } = await runSlimSync();
      assert.equal(exitCode, 0);
      assert.match(stderr, /Removed legacy source-managed second-review artifact/);
      assert.match(stderr, /dp-second-reviewer/);

      for (const relPath of LEGACY_SECOND_REVIEW_ARTIFACTS) {
        const stillExists = await lstatExists(path.join(slimCtx.tmpDir, relPath));
        assert.equal(stillExists, false, `${relPath} must be removed by --sync`);
      }

      for (const relPath of [
        ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
        ".claude/agents/dp-second-reviewer.md",
        ".codex/agents/dp-second-reviewer.toml",
        ".cursor/agents/dp-second-reviewer.md",
      ]) {
        const existsAfterSync = await fs.access(path.join(slimCtx.tmpDir, relPath)).then(() => true).catch(() => false);
        assert.equal(existsAfterSync, true, `${relPath} must exist after the rename sync`);
      }
      // design D3 — discovery is a single `devpro` entry per root, not a
      // per-skill link; `devpro:second-review` was never distributed as its
      // own discovery link under the 2-entry topology (neither
      // .cursor/skills, which is a retired discovery root, nor the two
      // active roots).
      for (const discoveryPath of [
        [".cursor", "skills", "second-review"],
        [".agents", "skills", "second-review"],
        [".claude", "skills", "second-review"],
      ]) {
        assert.equal(
          await lstatExists(path.join(slimCtx.tmpDir, ...discoveryPath)),
          false,
          `${discoveryPath.join("/")} must not exist — discovery is the single 'devpro' entry, not a per-skill link`
        );
      }

      const check = await runSlimCheck();
      assert.equal(check.exitCode, 0, check.stderr);
    } finally {
      for (const relPath of LEGACY_SECOND_REVIEW_ARTIFACTS) {
        await fs.rm(path.join(slimCtx.tmpDir, relPath), { recursive: true, force: true });
      }
    }
  });

  it("fails --check when legacy dp-second-reviewer residue is present (read-only backstop)", async () => {
    await resetSlimConsumer();
    const [firstLegacyRelPath] = LEGACY_SECOND_REVIEW_ARTIFACTS;
    const legacyArtifact = path.join(slimCtx.tmpDir, firstLegacyRelPath);
    await createLegacySecondReviewArtifact(slimCtx.tmpDir, firstLegacyRelPath);

    try {
      const { exitCode, stderr } = await runSlimCheck();
      assert.equal(exitCode, 1, "dp-second-reviewer residue present must fail --check");
      assert.match(stderr, /legacy dp-second-reviewer artifact residue present/);

      const stillExists = await lstatExists(legacyArtifact);
      assert.equal(stillExists, true, "--check must not delete legacy dp-second-reviewer residue");
    } finally {
      await fs.rm(legacyArtifact, { recursive: true, force: true });
    }
  });

  it("prunes legacy source-managed rule-governance split skill artifacts on --sync", async () => {
    await resetSlimConsumer();

    for (const relPath of LEGACY_RULE_GOVERNANCE_SKILL_ARTIFACTS) {
      await createLegacyRuleGovernanceSkillArtifact(slimCtx.tmpDir, relPath);
    }

    try {
      const { exitCode, stderr } = await runSlimSync();
      assert.equal(exitCode, 0);
      assert.match(stderr, /Removed legacy source-managed rule-governance artifact/);
      assert.match(stderr, /dp-rule-audit/);
      assert.match(stderr, /dp-convergence-loop/);

      for (const relPath of LEGACY_RULE_GOVERNANCE_SKILL_ARTIFACTS) {
        const stillExists = await lstatExists(path.join(slimCtx.tmpDir, relPath));
        assert.equal(stillExists, false, `${relPath} must be removed by --sync`);
      }

      for (const relPath of [".devpro/agent-skills/rules-authoring/rule-governance/SKILL.md"]) {
        const existsAfterSync = await fs.access(path.join(slimCtx.tmpDir, relPath)).then(() => true).catch(() => false);
        assert.equal(existsAfterSync, true, `${relPath} must exist after the consolidation sync`);
      }
      // design D3 — discovery is a single `devpro` entry per root, not a
      // per-skill link; `devpro:rule-governance` was never distributed as its
      // own discovery link under the 2-entry topology.
      for (const discoveryPath of [
        [".cursor", "skills", "rule-governance"],
        [".agents", "skills", "rule-governance"],
        [".claude", "skills", "rule-governance"],
      ]) {
        assert.equal(
          await lstatExists(path.join(slimCtx.tmpDir, ...discoveryPath)),
          false,
          `${discoveryPath.join("/")} must not exist — discovery is the single 'devpro' entry, not a per-skill link`
        );
      }

      const check = await runSlimCheck();
      assert.equal(check.exitCode, 0, check.stderr);
    } finally {
      for (const relPath of LEGACY_RULE_GOVERNANCE_SKILL_ARTIFACTS) {
        await fs.rm(path.join(slimCtx.tmpDir, relPath), { recursive: true, force: true });
      }
    }
  });

  it("fails --check when legacy rule-governance split skill residue is present (read-only backstop)", async () => {
    await resetSlimConsumer();
    const [firstLegacyRelPath] = LEGACY_RULE_GOVERNANCE_SKILL_ARTIFACTS;
    const legacyArtifact = path.join(slimCtx.tmpDir, firstLegacyRelPath);
    await createLegacyRuleGovernanceSkillArtifact(slimCtx.tmpDir, firstLegacyRelPath);

    try {
      const { exitCode, stderr } = await runSlimCheck();
      assert.equal(exitCode, 1, "legacy rule-governance residue present must fail --check");
      assert.match(stderr, /legacy rule-governance split skill artifact residue present/);

      const stillExists = await lstatExists(legacyArtifact);
      assert.equal(stillExists, true, "--check must not delete legacy rule-governance residue");
    } finally {
      await fs.rm(legacyArtifact, { recursive: true, force: true });
    }
  });

  describe("cursor skill discovery retirement", () => {
    // slimCtx/createSlimManagedSource() is a two-root source by default
    // (design D1/D9 — .cursor/skills is a retired discovery root), so these
    // prove-it tests reuse the shared slimCtx/resetSlimConsumer/runSlimSync/
    // runSlimCheck fixture directly, same as the rest of this suite.
    it("Retired Legacy Skill Discovery Links Are Pruned By Sync", async () => {
      await resetSlimConsumer();

      const nonAllowlistedRelPath = path.join(".cursor", "skills", "my-own-skill");
      const nonAllowlistedAbsPath = path.join(slimCtx.tmpDir, nonAllowlistedRelPath);
      await fs.mkdir(path.dirname(nonAllowlistedAbsPath), { recursive: true });
      await fs.writeFile(nonAllowlistedAbsPath, "consumer-owned, not on the allowlist\n");

      const consumerRulesAbsPath = path.join(slimCtx.tmpDir, ".cursor", "rules", "consumer-owned.mdc");
      await fs.mkdir(path.dirname(consumerRulesAbsPath), { recursive: true });
      await fs.writeFile(consumerRulesAbsPath, "# consumer-owned cursor rule\n");

      const agentsAbsPath = path.join(slimCtx.tmpDir, ".cursor", "agents", "dp-second-reviewer.md");
      const hooksAbsPath = path.join(slimCtx.tmpDir, ".cursor", "hooks.json");

      // legacy-skill-names:begin dangling-name-pick
      const danglingName = "dp-workflows";  // picks a name from CURSOR_SKILL_DISCOVERY_ALLOWLIST (legacy)
      // legacy-skill-names:end dangling-name-pick -- danglingName picked from the legacy .cursor allowlist
      const plainFileName = "cmux-surface-comms";
      try {
        for (const name of CURSOR_SKILL_DISCOVERY_ALLOWLIST) {
          const variant = name === danglingName ? "dangling" : name === plainFileName ? "plain-file" : "symlink";
          await createCursorSkillDiscoveryArtifact(slimCtx.tmpDir, name, variant);
        }

        const first = await runSlimSync();
        assert.equal(first.exitCode, 0, first.stderr);
        for (const name of CURSOR_SKILL_DISCOVERY_ALLOWLIST) {
          assert.match(
            first.stderr,
            new RegExp(
              `Removed legacy source-managed cursor skill discovery artifact: \\.cursor/skills/${name}(?![\\w-])`
            ),
            `--sync must warn about removing .cursor/skills/${name}`
          );
        }

        for (const name of CURSOR_SKILL_DISCOVERY_ALLOWLIST) {
          const stillExists = await lstatExists(path.join(slimCtx.tmpDir, ".cursor", "skills", name));
          assert.equal(stillExists, false, `.cursor/skills/${name} must be removed by --sync`);
        }

        assert.equal(
          await lstatExists(nonAllowlistedAbsPath),
          true,
          "consumer-owned non-allowlisted .cursor/skills entry must remain"
        );
        assert.equal(
          await fs.readFile(nonAllowlistedAbsPath, "utf8"),
          "consumer-owned, not on the allowlist\n",
          "consumer-owned non-allowlisted .cursor/skills entry content must be untouched"
        );
        assert.equal(
          await fs.readFile(consumerRulesAbsPath, "utf8"),
          "# consumer-owned cursor rule\n",
          ".cursor/rules content must be untouched"
        );
        assert.equal(await lstatExists(agentsAbsPath), true, ".cursor/agents must remain");
        assert.equal(await lstatExists(hooksAbsPath), true, ".cursor/hooks.json must remain");

        const second = await runSlimSync();
        assert.equal(second.exitCode, 0, second.stderr);
        assert.doesNotMatch(
          second.stderr,
          /Removed legacy source-managed cursor skill discovery artifact/,
          "a second --sync must emit no retired .cursor/skills discovery warning"
        );

        const check = await runSlimCheck();
        assert.equal(check.exitCode, 0, check.stderr);
      } finally {
        for (const name of CURSOR_SKILL_DISCOVERY_ALLOWLIST) {
          await fs.rm(path.join(slimCtx.tmpDir, ".cursor", "skills", name), { recursive: true, force: true });
        }
        await fs.rm(nonAllowlistedAbsPath, { recursive: true, force: true });
        await fs.rm(consumerRulesAbsPath, { recursive: true, force: true });
      }
    });

    it("Individual Legacy Removal Failure Is Warned And Skipped", async () => {
      await resetSlimConsumer();

      // legacy-skill-names:begin failing-name-pick
      const failingName = "dp-knowledge-distill";  // picks a name from CURSOR_SKILL_DISCOVERY_ALLOWLIST (legacy)
      // legacy-skill-names:end failing-name-pick -- failingName picked from the legacy .cursor allowlist
      const failingAbsPath = path.join(slimCtx.tmpDir, ".cursor", "skills", failingName);
      const realRm = fs.rm;
      try {
        for (const name of CURSOR_SKILL_DISCOVERY_ALLOWLIST) {
          await createCursorSkillDiscoveryArtifact(slimCtx.tmpDir, name);
        }

        // In-process fault injection, mirroring the spawned NODE_OPTIONS
        // preload used by sync-agent-rules.test.mjs: runSync is invoked in
        // this process, so patching the shared node:fs promises object makes
        // exactly one allowlisted removal throw while every other fs.rm call
        // — including the remaining 19 prunes — still runs for real.
        fs.rm = async (target, ...args) => {
          const normalized = String(target).replaceAll("\\", "/");
          if (normalized.endsWith(`/.cursor/skills/${failingName}`)) {
            const error = new Error("forced legacy discovery removal fault");
            error.code = "EPERM";
            throw error;
          }
          return realRm(target, ...args);
        };

        const sync = await runSlimSync();
        assert.equal(sync.exitCode, 0, sync.stderr);
        assert.match(
          sync.stderr,
          new RegExp(
            `Failed to prune legacy cursor skill discovery artifact \\.cursor/skills/${failingName}: forced legacy discovery removal fault — skipping, sync continues\\.`
          )
        );

        assert.equal(
          await lstatExists(failingAbsPath),
          true,
          "the failed allowlisted path must remain in place"
        );
        for (const name of CURSOR_SKILL_DISCOVERY_ALLOWLIST) {
          if (name === failingName) continue;
          assert.equal(
            await lstatExists(path.join(slimCtx.tmpDir, ".cursor", "skills", name)),
            false,
            `--sync must still prune .cursor/skills/${name} after one removal failure`
          );
        }

        fs.rm = realRm;

        const check = await runSlimCheck();
        assert.equal(check.exitCode, 1, "remaining allowlisted residue must fail --check");
        assert.match(
          check.stderr,
          /legacy \.cursor\/skills discovery artifact residue present\. Run --sync\./
        );
      } finally {
        fs.rm = realRm;
        for (const name of CURSOR_SKILL_DISCOVERY_ALLOWLIST) {
          await fs.rm(path.join(slimCtx.tmpDir, ".cursor", "skills", name), { recursive: true, force: true });
        }
      }
    });

    it("Retired Legacy Skill Discovery Residue Fails Check", async () => {
      await resetSlimConsumer();

      // Canonical .gitignore precondition (D4): resetSlimConsumer() restores
      // the snapshot taken right after the baseline --sync, so the managed
      // block is already canonical here — the residue check below must fail
      // on its own, not because of unrelated gitignore drift.
      const gitignoreBefore = await fs.readFile(path.join(slimCtx.tmpDir, ".gitignore"), "utf8");
      const baselineCheck = await runSlimCheck();
      assert.equal(baselineCheck.exitCode, 0, "precondition: .gitignore managed block must already be canonical");

      // legacy-skill-names:begin residue-name-pick
      const residueName = "dp-clarify";  // picks a name from CURSOR_SKILL_DISCOVERY_ALLOWLIST (legacy)
      // legacy-skill-names:end residue-name-pick -- residueName picked from the legacy .cursor allowlist
      const residueAbsPath = path.join(slimCtx.tmpDir, ".cursor", "skills", residueName);
      await createCursorSkillDiscoveryArtifact(slimCtx.tmpDir, residueName, "dangling");

      try {
        const { exitCode, stderr } = await runSlimCheck();
        assert.equal(exitCode, 1, "cursor skill discovery residue present must fail --check");
        assert.match(stderr, /legacy \.cursor\/skills discovery artifact residue present\. Run --sync\./);

        const stillExists = await lstatExists(residueAbsPath);
        assert.equal(stillExists, true, "--check must not delete cursor skill discovery residue");
        assert.equal(
          await fs.readFile(path.join(slimCtx.tmpDir, ".gitignore"), "utf8"),
          gitignoreBefore,
          "--check must not modify .gitignore"
        );
      } finally {
        await fs.rm(residueAbsPath, { recursive: true, force: true });
      }
    });

    it("Fresh Consumer Sync Creates No Legacy Skill Discovery Root", async () => {
      const freshConsumerDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-check-fresh-consumer-"));
      try {
        const { exitCode, stderr } = await runSyncInProcess(freshConsumerDir, {
          sourceRootOverride: slimCtx.sourceRoot,
        });
        assert.equal(exitCode, 0, stderr);

        assert.equal(
          await lstatExists(path.join(freshConsumerDir, ".cursor", "skills")),
          false,
          ".cursor/skills must not be created by a fresh --sync"
        );

        // design D3 — discovery is a single `devpro` entry per root
        // resolving to the catalog root itself, not a per-skill link.
        for (const discoveryDir of [".agents/skills", ".claude/skills"]) {
          const entryPath = path.join(freshConsumerDir, ...discoveryDir.split("/"), "devpro");
          assert.equal(
            await lstatExists(entryPath),
            true,
            `${discoveryDir}/devpro must hold the source-owned managed discovery entry`
          );
        }
        for (const skillName of ["second-review", "rule-governance"]) {
          const skillMdPath = path.join(
            freshConsumerDir,
            ".devpro",
            "agent-skills",
            skillName === "second-review" ? "devpro-reviews" : "rules-authoring",
            skillName,
            "SKILL.md"
          );
          assert.equal(
            await lstatExists(skillMdPath),
            true,
            `${skillMdPath} must exist in the synced catalog`
          );
        }
      } finally {
        await fs.rm(freshConsumerDir, { recursive: true, force: true });
      }
    });
  });

  it("fails when a tool rule file drifts from source", async () => {
    await resetSlimConsumer();
    const drifted = path.join(slimCtx.tmpDir, "GEMINI.md");
    await fs.writeFile(drifted, "tampered content\n");

    const { exitCode, stderr } = await runSlimCheck();
    assert.equal(exitCode, 1);
    assert.match(stderr, /GEMINI\.md differs/);
  });

  it("does not check .claude/commands for drift (commands removed from CLAUDE_SYNC_SUBDIRS); a consumer-owned commands file outside the dp/ namespace is ignored", async () => {
    await resetSlimConsumer();
    // A consumer's OWN command, in its own namespace (not the devpro-managed
    // `dp/` one). With commands out of CLAUDE_SYNC_SUBDIRS, --check must not
    // parity-check it, and the legacy-command gate only scans `dp/`, so this
    // consumer-owned extra must pass untouched.
    const consumerOwned = path.join(slimCtx.tmpDir, ".claude", "commands", "my-team", "custom.md");
    await fs.mkdir(path.dirname(consumerOwned), { recursive: true });
    await fs.writeFile(consumerOwned, "# consumer-owned, no source counterpart\nTAMPERED\n");

    const { exitCode, stderr } = await runSlimCheck();
    assert.equal(exitCode, 0, `--check must not flag a consumer-owned .claude/commands extra as drift; stderr=${stderr}`);
    assert.doesNotMatch(stderr, /\.claude\/commands\/my-team\/custom\.md differs/);
  });

  it("prunes legacy consumer .claude/commands/dp/* on --sync, including the now-empty dp/ directory itself", async () => {
    await resetSlimConsumer();
    const dpDir = path.join(slimCtx.tmpDir, ".claude", "commands", "dp");
    const legacyCommand = path.join(dpDir, "change.md");
    await fs.mkdir(dpDir, { recursive: true });
    await fs.writeFile(legacyCommand, "# legacy source-managed command, must be removed by explicit approval\n");

    try {
      const { exitCode, stdout } = await runSlimSync();
      assert.equal(exitCode, 0);
      const stillExists = await fs.access(legacyCommand).then(() => true).catch(() => false);
      assert.equal(stillExists, false, "legacy command must be removed by --sync");
      assert.match(stdout, /Removed legacy/);
      assert.match(stdout, /change\.md/);

      // Once every file under dp/ is pruned, the now-empty directory itself
      // must also be removed (not just left behind as an empty husk).
      const dpDirStillExists = await fs.access(dpDir).then(() => true).catch(() => false);
      assert.equal(dpDirStillExists, false, "now-empty .claude/commands/dp/ directory must itself be removed");

      const check = await runSlimCheck();
      assert.equal(check.exitCode, 0, check.stderr);
    } finally {
      await fs.rm(path.join(slimCtx.tmpDir, ".claude", "commands"), { recursive: true, force: true });
    }
  });

  it("conservatively leaves an unexpected subdirectory under dp/ alone instead of recursively deleting it", async () => {
    await resetSlimConsumer();
    const dpDir = path.join(slimCtx.tmpDir, ".claude", "commands", "dp");
    // Residue is assumed to be flat files directly under dp/. An unexpected
    // subdirectory (not a file entry) must be conservatively skipped rather
    // than recursively deleted — this exercises the `!entry.isFile()` branch.
    const nestedDir = path.join(dpDir, "unexpected-subdir");
    const nestedFile = path.join(nestedDir, "keep-me.md");
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(nestedFile, "# not a flat legacy command file, must be left alone\n");

    try {
      const { exitCode, stdout } = await runSlimSync();
      assert.equal(exitCode, 0);
      const nestedFileStillExists = await fs.access(nestedFile).then(() => true).catch(() => false);
      assert.equal(nestedFileStillExists, true, "an unexpected subdirectory under dp/ must not be recursively deleted");
      assert.doesNotMatch(stdout, /unexpected-subdir/, "the conservatively-skipped subdirectory must not be announced as removed");

      // Because the subdirectory remains, dp/ is not empty, so the
      // final empty-dir removal step must not fire either.
      const dpDirStillExists = await fs.access(dpDir).then(() => true).catch(() => false);
      assert.equal(dpDirStillExists, true, "dp/ must not be removed while a non-file entry still remains under it");
    } finally {
      await fs.rm(path.join(slimCtx.tmpDir, ".claude", "commands"), { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // checkLegacyConsumerCommands (T4/T5, enforce-sync-prune-verification R2)
  // --check must fail-closed on .claude/commands/dp/ residue as an
  // independent, read-only backstop — regardless of why --sync's own prune
  // didn't run (older root-path script, bug, etc). It must never delete.
  // -------------------------------------------------------------------------

  it("fails --check when legacy .claude/commands/dp/ residue is present (read-only backstop)", async () => {
    await resetSlimConsumer();
    const dpDir = path.join(slimCtx.tmpDir, ".claude", "commands", "dp");
    const legacyCommand = path.join(dpDir, "change.md");
    await fs.mkdir(dpDir, { recursive: true });
    await fs.writeFile(legacyCommand, "# legacy source-managed command residue\n");

    try {
      const { exitCode, stderr } = await runSlimCheck();
      assert.equal(exitCode, 1, "residue present must fail --check");
      assert.match(stderr, /Out of sync/);
      assert.match(stderr, /\.claude\/commands\/dp\//);

      // Read-only: --check must never delete the residue itself.
      const stillExists = await fs.access(legacyCommand).then(() => true).catch(() => false);
      assert.equal(stillExists, true, "--check must not delete legacy residue; it only reports");
    } finally {
      await fs.rm(path.join(slimCtx.tmpDir, ".claude", "commands"), { recursive: true, force: true });
    }
  });

  it("passes --check when no legacy .claude/commands/dp/ residue is present", async () => {
    await resetSlimConsumer();
    const dpDir = path.join(slimCtx.tmpDir, ".claude", "commands", "dp");
    const dpDirExists = await fs.access(dpDir).then(() => true).catch(() => false);
    assert.equal(dpDirExists, false, "precondition: no dp/ residue should exist after a clean sync");

    const { exitCode, stderr } = await runSlimCheck();
    assert.equal(exitCode, 0, `--check must pass when residue is absent; stderr=${stderr}`);
  });

  it("warns and continues --sync when the legacy dp/ command directory cannot be read (best-effort, not fatal)", async () => {
    if (process.platform !== "win32" && process.getuid && process.getuid() === 0) {
      // Running as root bypasses POSIX permission bits entirely — chmod-based
      // failure simulation would be a no-op and the assertion below would be
      // unreachable, so skip rather than produce a false pass/fail signal.
      return;
    }
    await resetSlimConsumer();
    const dpDir = path.join(slimCtx.tmpDir, ".claude", "commands", "dp");
    if (process.platform === "win32") {
      // Native Win32 has no portable POSIX mode-bit denial. A file occupying
      // the retired directory path makes readdir fail with ENOTDIR while
      // exercising the same best-effort catch branch.
      await fs.mkdir(path.dirname(dpDir), { recursive: true });
      await fs.writeFile(dpDir, "legacy directory sentinel\n");
    } else {
      await fs.mkdir(dpDir, { recursive: true });
      await fs.writeFile(path.join(dpDir, "change.md"), "# legacy source-managed command\n");
    }

    if (process.platform !== "win32") {
      // Strip read+execute from dp/ itself so fs.readdir(dpDir) throws EACCES,
      // without touching permissions on ctx.tmpDir's other sync targets — this
      // proves the best-effort contract: the readdir failure must be warned
      // and swallowed, not propagate and abort the rest of --sync.
      await fs.chmod(dpDir, 0o000);
    }
    try {
      const { exitCode, stderr } = await runSlimSync();
      assert.equal(exitCode, 0, "a readdir failure on the legacy dp/ directory must not abort --sync");
      assert.match(stderr, /Failed to read legacy command directory/);
      assert.match(stderr, /skipping, sync continues/);
    } finally {
      if (process.platform !== "win32") await fs.chmod(dpDir, 0o755);
      await fs.rm(path.join(slimCtx.tmpDir, ".claude", "commands"), { recursive: true, force: true });
    }
  });

  it("fails when a .claude/agents/*.md file drifts from source", async () => {
    await resetSlimConsumer();
    const sourceAgentsDir = path.join(slimCtx.sourceRoot, ".claude", "agents");
    const hasSourceAgents = await fs.access(sourceAgentsDir).then(() => true).catch(() => false);
    if (!hasSourceAgents) return;

    const firstAgent = (await fs.readdir(sourceAgentsDir)).find((n) => n.endsWith(".md"));
    assert.ok(firstAgent, "source must have at least one agent .md for this test");
    const drifted = path.join(slimCtx.tmpDir, ".claude", "agents", firstAgent);
    await fs.appendFile(drifted, "\nTAMPERED\n");

    const { exitCode, stderr } = await runSlimCheck();
    assert.equal(exitCode, 1);
    assert.match(stderr, new RegExp(`\\.claude/agents/${firstAgent.replace(/\./g, "\\.")} differs`));
  });

  it("fails when a .devpro/agent-skills file drifts from source", async () => {
    await resetSlimConsumer();
    const drifted = path.join(slimCtx.tmpDir, ".devpro", "agent-skills", "devpro-reviews", "second-review", "SKILL.md");
    await fs.appendFile(drifted, "\nTAMPERED\n");

    const { exitCode, stderr } = await runSlimCheck();
    assert.equal(exitCode, 1);
    assert.match(
      stderr,
      /\.devpro[\\/]agent-skills[\\/]devpro-reviews[\\/]second-review[\\/]SKILL\.md differs/
    );
  });

  it("--check passes when source settings.json has no model key", async () => {
    await resetSlimConsumer();
    const settingsSrc = path.join(slimCtx.sourceRoot, ".claude", "settings.json");
    const sourceData = JSON.parse(await fs.readFile(settingsSrc, "utf8"));
    try {
      // Ensure source has no model key
      delete sourceData.model;
      await fs.writeFile(settingsSrc, JSON.stringify(sourceData, null, 2) + "\n");

      await runSlimSync();

      // Consumer may have any model value — check must still pass (exit 0)
      const settingsPath = path.join(slimCtx.tmpDir, ".claude", "settings.json");
      const data = JSON.parse(await fs.readFile(settingsPath, "utf8"));
      data.model = "whatever-consumer-model";
      await fs.writeFile(settingsPath, JSON.stringify(data, null, 2) + "\n");

      const { exitCode } = await runSlimCheck();
      assert.equal(exitCode, 0,
        "--check must exit 0 when source has no model, regardless of consumer model value");
    } finally {
      await restoreSlimSource();
    }
  });

  it("fails when .claude/settings.json hooks drift from source", async () => {
    await resetSlimConsumer();
    const settingsPath = path.join(slimCtx.tmpDir, ".claude", "settings.json");
    const data = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    const firstHookKey = Object.keys(data.hooks ?? {})[0];
    assert.ok(firstHookKey, "source settings.json must define at least one hook for this test");
    data.hooks[firstHookKey] = "TAMPERED";
    await fs.writeFile(settingsPath, JSON.stringify(data, null, 2) + "\n");

    const { exitCode, stderr } = await runSlimCheck();
    assert.equal(exitCode, 1);
    assert.match(stderr, new RegExp(`\\.claude/settings\\.json hooks\\.${firstHookKey} differs`));
  });

  it("fails when .codex/hooks.json source hook event drifts", async () => {
    await resetSlimConsumer();
    const hooksPath = path.join(slimCtx.tmpDir, ".codex", "hooks.json");
    const data = JSON.parse(await fs.readFile(hooksPath, "utf8"));
    const firstHookKey = Object.keys(data.hooks ?? {})[0];
    assert.ok(firstHookKey, "source .codex/hooks.json must define at least one hook");
    data.hooks[firstHookKey] = "TAMPERED";
    await fs.writeFile(hooksPath, JSON.stringify(data, null, 2) + "\n");

    const { exitCode, stderr } = await runSlimCheck();
    assert.equal(exitCode, 1);
    assert.match(stderr, new RegExp(`\\.codex/hooks\\.json hooks\\.${firstHookKey} differs`));
  });

  it("fails when .cursor/hooks.json source hook event drifts", async () => {
    await resetSlimConsumer();
    const hooksPath = path.join(slimCtx.tmpDir, ".cursor", "hooks.json");
    const data = JSON.parse(await fs.readFile(hooksPath, "utf8"));
    const firstHookKey = Object.keys(data.hooks ?? {})[0];
    assert.ok(firstHookKey, "source .cursor/hooks.json must define at least one hook");
    data.hooks[firstHookKey] = "TAMPERED";
    await fs.writeFile(hooksPath, JSON.stringify(data, null, 2) + "\n");

    const { exitCode, stderr } = await runSlimCheck();
    assert.equal(exitCode, 1);
    assert.match(stderr, new RegExp(`\\.cursor/hooks\\.json hooks\\.${firstHookKey} differs`));
  });

  it("ignores consumer-added keys in .codex/hooks.json", async () => {
    await resetSlimConsumer();
    const hooksPath = path.join(slimCtx.tmpDir, ".codex", "hooks.json");
    const data = JSON.parse(await fs.readFile(hooksPath, "utf8"));
    data.consumerLocalKey = { foo: "bar" };
    data.hooks.ConsumerOnly = [{ hooks: [{ type: "command", command: "consumer-only" }] }];
    await fs.writeFile(hooksPath, JSON.stringify(data, null, 2) + "\n");

    const { exitCode } = await runSlimCheck();
    assert.equal(exitCode, 0, "consumer-only Codex hooks keys must not trigger drift");
  });

  it("ignores consumer-added keys in .cursor/hooks.json", async () => {
    await resetSlimConsumer();
    const hooksPath = path.join(slimCtx.tmpDir, ".cursor", "hooks.json");
    const data = JSON.parse(await fs.readFile(hooksPath, "utf8"));
    data.consumerLocalKey = { foo: "bar" };
    data.hooks.ConsumerOnly = [{ hooks: [{ type: "command", command: "consumer-only" }] }];
    await fs.writeFile(hooksPath, JSON.stringify(data, null, 2) + "\n");

    const { exitCode } = await runSlimCheck();
    assert.equal(exitCode, 0, "consumer-only Cursor hooks keys must not trigger drift");
  });

  it("ignores consumer-added keys in .claude/settings.json (only source hooks must match)", async () => {
    await resetSlimConsumer();
    const settingsPath = path.join(slimCtx.tmpDir, ".claude", "settings.json");
    const data = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    data.consumerLocalKey = { foo: "bar" };
    await fs.writeFile(settingsPath, JSON.stringify(data, null, 2) + "\n");

    const { exitCode } = await runSlimCheck();
    assert.equal(exitCode, 0, "consumer-only settings keys must not trigger drift");
  });

  it("fails when .github/PULL_REQUEST_TEMPLATE.md drifts from source", async () => {
    await resetSlimConsumer();
    const drifted = path.join(slimCtx.tmpDir, ".github", "PULL_REQUEST_TEMPLATE.md");
    await fs.appendFile(drifted, "\nTAMPERED\n");

    const { exitCode, stderr } = await runSlimCheck();
    assert.equal(exitCode, 1);
    assert.match(stderr, /PULL_REQUEST_TEMPLATE\.md differs/);
  });

  it("fails --check on a tracked case-variant consumer path", async () => {
    await resetSlimConsumer();
    await initializeConsumerIndex(slimCtx.tmpDir);
    await installCaseVariantConsumerTemplate(slimCtx.tmpDir);

    const { exitCode, stderr } = await runSlimCheck();
    assert.equal(exitCode, 1);
    assert.match(stderr, /case-insensitive managed-path collision/i);
    assert.match(stderr, /\.github\/PULL_REQUEST_TEMPLATE\.md/);
    assert.match(stderr, /\.github\/pull_request_template\.md/);
  });

  it("fails --sync before changing AGENTS.md or the case-variant consumer file", async () => {
    await resetSlimConsumer();
    await initializeConsumerIndex(slimCtx.tmpDir);
    const consumerPath = await installCaseVariantConsumerTemplate(slimCtx.tmpDir);
    const consumerBytes = await fs.readFile(consumerPath);
    const staleAgents = Buffer.from("consumer AGENTS content that sync must not replace\n");
    const agentsPath = path.join(slimCtx.tmpDir, "AGENTS.md");
    await fs.writeFile(agentsPath, staleAgents);

    const { exitCode, stderr } = await runSlimSync();
    assert.equal(exitCode, 1);
    assert.match(stderr, /case-insensitive managed-path collision/i);
    assert.deepEqual(await fs.readFile(consumerPath), consumerBytes);
    assert.deepEqual(await fs.readFile(agentsPath), staleAgents);
    const githubEntries = await fs.readdir(path.join(slimCtx.tmpDir, ".github"));
    assert.equal(
      githubEntries.includes("PULL_REQUEST_TEMPLATE.md"),
      false,
      "sync must stop before creating the differently-cased managed path"
    );
  });

  it("checks case variants for legacy files and paths nested under legacy output roots", async () => {
    await resetSlimConsumer();
    const legacyWorkflow = LEGACY_SOURCE_WORKFLOW_FILES[0];
    const workflowParts = legacyWorkflow.split("/");
    const workflowName = workflowParts.pop();
    const workflowVariant = [...workflowName];
    const workflowLetter = workflowVariant.findIndex((character) => /[a-z]/i.test(character));
    workflowVariant[workflowLetter] = workflowVariant[workflowLetter].toUpperCase();
    const trackedWorkflow = path.join(slimCtx.tmpDir, ...workflowParts, workflowVariant.join(""));
    await fs.mkdir(path.dirname(trackedWorkflow), { recursive: true });
    await fs.writeFile(trackedWorkflow, "consumer-owned legacy workflow\n");

    const legacySkillRoot = ".agents/skills/dp-second-reviewer";
    const consumerLegacySkillRoot = path.join(slimCtx.tmpDir, legacySkillRoot);
    await fs.rm(consumerLegacySkillRoot, { recursive: true, force: true });
    const trackedLegacySkill = path.join(
      slimCtx.tmpDir,
      ".agents/skills/DP-second-reviewer/README.md"
    );
    await fs.mkdir(path.dirname(trackedLegacySkill), { recursive: true });
    await fs.writeFile(trackedLegacySkill, "consumer-owned legacy skill\n");

    await initializeConsumerIndex(slimCtx.tmpDir);
    const { exitCode, stderr } = await runSlimCheck();

    assert.equal(exitCode, 1);
    assert.match(stderr, /case-insensitive managed-path collision/i);
    assert.match(stderr, /source-managed: \.github\/workflows\/compliance-telemetry\.yml/);
    assert.match(stderr, /tracked consumer: \.github\/workflows\/Compliance-telemetry\.yml/);
    assert.match(stderr, /source-managed: \.agents\/skills\/dp-second-reviewer/);
    assert.match(stderr, /tracked consumer: \.agents\/skills\/DP-second-reviewer\/README\.md/);
  });

  it("does not flag an exact managed path or an unrelated consumer-local path", async () => {
    await resetSlimConsumer();
    await initializeConsumerIndex(slimCtx.tmpDir);
    const extraPath = path.join(slimCtx.tmpDir, ".github", "consumer-template.md");
    await fs.writeFile(extraPath, "# consumer-local\n");
    const addExtra = spawnSync("git", ["add", "--", ".github/consumer-template.md"], {
      cwd: slimCtx.tmpDir,
      encoding: "utf8",
    });
    assert.equal(addExtra.status, 0, addExtra.stderr);

    const { exitCode, stderr } = await runSlimCheck();
    assert.equal(exitCode, 0, stderr);
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
