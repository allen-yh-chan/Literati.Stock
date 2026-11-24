import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureCoreSymlinks } from "../hooks/lib/git-utils.mjs";
import { spawnSync as nativeSpawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CHECK_STEPS,
  SYNC_STEPS,
  createMissingGitSymlinkBlob,
  isManagedSkillSymlinkFallbackError,
  isPreferPlainCoreSymlinksState,
  mergeGitattributesManagedBlock,
  mergeGitignoreManagedBlock,
  normalizeSymlinkTargetSeparators,
  parseGitCheckIgnoreRecords,
  validateManagedSkillGitPersistence,
  SKILL_ENTRY_NAME,
  SKILL_ENTRY_LINK_TARGET,
} from "../sync-agent-rules.mjs";
import {
  STATIC_FILES,
  SYNC_DIRS,
  GITIGNORE_MANAGED_BEGIN,
  GITIGNORE_MANAGED_END,
  GITATTRIBUTES_MANAGED_BEGIN,
  GITATTRIBUTES_MANAGED_END,
  GITATTRIBUTES_MANAGED_ENTRIES,
  createConsumerRepo,
  run,
  withConsumerRepo,
  countGitignoreEntry,
  configureFixtureGit,
  fixtureGitEnv,
  setRunUsesFullSubmodSource,
} from "./lib/sync-agent-rules-harness.mjs";

const TEST_GITIGNORE_BASELINE_ENTRIES = [".worktree/", "notes/"];
const TEST_GITIGNORE_MANAGED_ENTRIES = [
  ...TEST_GITIGNORE_BASELINE_ENTRIES,
  "!/.devpro/",
];

async function createPortableTestSymlink(linkTarget, targetPath, kind = "directory") {
  if (process.platform === "win32") {
    await fs.symlink(linkTarget, targetPath, kind === "directory" ? "dir" : "file");
    return;
  }
  await fs.symlink(linkTarget, targetPath);
}

function spawnSync(command, args, options = {}) {
  if (command !== "git") return nativeSpawnSync(command, args, options);
  const cwd = options.cwd || process.cwd();
  const env = fixtureGitEnv(cwd);
  const explicitEnv = options.env || {};
  const allowedGitEnv = new Set([
    "GIT_AUTHOR_DATE",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_NAME",
    "GIT_COMMITTER_DATE",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_SSH_COMMAND",
    "GIT_TERMINAL_PROMPT",
  ]);
  for (const [key, value] of Object.entries(explicitEnv)) {
    if (!key.startsWith("GIT_") || allowedGitEnv.has(key)) env[key] = value;
  }
  const result = nativeSpawnSync(command, args, { ...options, env });
  if (result.status === 0 && args[0] === "init") {
    configureFixtureGit(cwd, { symlinks: true, overrides: env });
  }
  return result;
}

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`
  );
  return result.stdout;
}

function gitWithInput(cwd, args, input) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`
  );
  return result.stdout;
}

async function readGitLinkTarget(cwd, relPath) {
  const staged = git(cwd, ["ls-files", "--stage", "--", relPath]).trim();
  const match = staged.match(/^120000\s+([0-9a-f]+)\s+\d+\t(.+)$/);
  assert.ok(match, `${relPath} must have Git mode 120000 evidence`);
  assert.equal(match[2], relPath);
  const blob = git(cwd, ["cat-file", "-p", match[1]]);
  const nodePath = path.join(cwd, ...relPath.split("/"));
  const stats = await fs.lstat(nodePath);
  const physical = stats.isSymbolicLink()
    ? await fs.readlink(nodePath)
    : await fs.readFile(nodePath, "utf8");
  if (stats.isSymbolicLink()) {
    assert.equal(
      normalizeSymlinkTargetSeparators(physical),
      normalizeSymlinkTargetSeparators(blob),
      `${relPath} symlink target must match its 120000 blob after separator normalization`
    );
  } else {
    assert.equal(physical, blob, `${relPath} checkout bytes must match its 120000 blob`);
  }
  return blob;
}

async function readLinkLikeTarget(nodePath) {
  const stats = await fs.lstat(nodePath);
  return stats.isSymbolicLink()
    ? fs.readlink(nodePath)
    : fs.readFile(nodePath, "utf8");
}

async function materializeLinkOrPlain(nodePath, linkTarget) {
  await fs.rm(nodePath, { force: true });
  try {
    await createPortableTestSymlink(linkTarget, nodePath, "directory");
    return "symlink";
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) throw error;
    await fs.writeFile(nodePath, linkTarget);
    return "plain";
  }
}

async function withSlimManagedSkillSource(callback) {
  const slimSource = await fs.mkdtemp(path.join(os.tmpdir(), "sync-slim-source-"));
  // Post-2-entry-topology (design D1/D3): the fixture's synthetic catalog
  // skill still lives at its own group/name (release/release-runbook —
  // unrelated to discovery naming), but BOTH discovery dirs now carry only
  // the single `devpro` entry, resolving to the catalog root itself.
  const skillRel = ".devpro/agent-skills/release/release-runbook";
  const discoveryRel = `.agents/skills/${SKILL_ENTRY_NAME}`;
  const discoveryRels = [
    discoveryRel,
    `.claude/skills/${SKILL_ENTRY_NAME}`,
  ];
  const discoveryTarget = SKILL_ENTRY_LINK_TARGET;
  try {
    await fs.writeFile(path.join(slimSource, "AGENTS.md"), "# Slim AGENTS\n");
    await fs.mkdir(path.join(slimSource, ".devpro", "agent-rules"), { recursive: true });
    await fs.writeFile(
      path.join(slimSource, ".devpro", "agent-rules", "gitignore-alignment.md"),
      [
        "<!-- devpro-gitignore-baseline begin -->",
        ".worktree/",
        "notes/",
        "<!-- devpro-gitignore-baseline end -->",
        "",
      ].join("\n")
    );

    const skillPath = path.join(slimSource, ...skillRel.split("/"));
    await fs.mkdir(skillPath, { recursive: true });
    await fs.writeFile(path.join(skillPath, "SKILL.md"), "# Release runbook\n");
    await fs.writeFile(
      path.join(slimSource, ".devpro", "agent-skills", "manifest.json"),
      JSON.stringify(
        {
          groups: [
            {
              name: "release",
              skills: [{ path: skillRel }],
            },
          ],
        },
        null,
        2
      ) + "\n"
    );
    await fs.mkdir(path.join(slimSource, ".devpro", "agent-skills", ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(slimSource, ".devpro", "agent-skills", ".claude-plugin", "plugin.json"),
      JSON.stringify(
        { name: SKILL_ENTRY_NAME, description: "Slim fixture plugin manifest.", skills: ["./release"] },
        null,
        2
      ) + "\n"
    );
    // buildManagedSkillInventory() reads the refs manifest unconditionally
    // (design D3.1) — an empty-groups refs manifest keeps this fixture's
    // second catalog root a no-op.
    await fs.mkdir(path.join(slimSource, ".devpro", "agent-skills-refs"), { recursive: true });
    await fs.writeFile(
      path.join(slimSource, ".devpro", "agent-skills-refs", "manifest.json"),
      JSON.stringify({ name: "devpro-agent-skill-refs", groups: [] }, null, 2) + "\n"
    );

    for (const discoveryDir of [".agents/skills", ".claude/skills"]) {
      await fs.mkdir(path.join(slimSource, ...discoveryDir.split("/")), { recursive: true });
    }
    for (const rel of discoveryRels) {
      await createPortableTestSymlink(
        discoveryTarget,
        path.join(slimSource, ...rel.split("/")),
        "directory"
      );
    }

    git(slimSource, ["init", "-q", "-b", "main"]);
    git(slimSource, ["config", "user.name", "sync-test"]);
    git(slimSource, ["config", "user.email", "sync-test@example.invalid"]);
    git(slimSource, ["add", "-A"]);
    git(slimSource, ["commit", "-q", "-m", "seed slim managed skill source"]);

    return await callback({ sourceRoot: slimSource, discoveryRel, discoveryRels, discoveryTarget });
  } finally {
    await fs.rm(slimSource, { recursive: true, force: true });
  }
}

function setGitLinkEvidence(cwd, relPath, linkTarget) {
  const objectId = gitWithInput(cwd, ["hash-object", "-w", "--stdin"], linkTarget).trim();
  git(cwd, ["update-index", "--add", "--cacheinfo", `120000,${objectId},${relPath}`]);
}

function makeGitSymlinkSeedRunner(repoRoot, relPath, linkTargetBytes, overrides = {}) {
  const objectId = overrides.objectId ?? "a".repeat(40);
  let indexProbeCount = 0;
  return (cwd, args, options = {}) => {
    assert.equal(cwd, repoRoot, "Git symlink plumbing must stay at the requested consumer root");
    switch (args[0]) {
      case "rev-parse":
        return {
          status: overrides.rootStatus ?? 0,
          stdout: `${overrides.reportedRoot ?? repoRoot}\n`,
          stderr: overrides.rootStderr ?? "",
          error: overrides.rootError,
        };
      case "ls-files": {
        indexProbeCount += 1;
        const stdout = indexProbeCount === 1
          ? overrides.initialIndex ?? ""
          : overrides.readbackIndex ?? `120000 ${objectId} 0\t${relPath}\0`;
        return { status: 0, stdout, stderr: "" };
      }
      case "hash-object":
        assert.deepEqual(options.input, linkTargetBytes);
        return {
          status: overrides.hashStatus ?? 0,
          stdout: overrides.hashStdout ?? `${objectId}\n`,
          stderr: overrides.hashStderr ?? "",
          error: overrides.hashError,
        };
      case "update-index":
        return {
          status: overrides.updateStatus ?? 0,
          stdout: "",
          stderr: overrides.updateStderr ?? "",
          error: overrides.updateError,
        };
      case "cat-file":
        return {
          status: overrides.catFileStatus ?? 0,
          stdout: overrides.readbackBlob ?? linkTargetBytes,
          stderr: overrides.catFileStderr ?? Buffer.alloc(0),
          error: overrides.catFileError,
        };
      default:
        throw new Error(`Unexpected Git symlink seed command: ${args.join(" ")}`);
    }
  };
}

async function withGitSymlinkSeedRoot(callback) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sync-git-symlink-seed-"));
  try {
    await callback(repoRoot);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
}

describe("fresh Git symlink blob seeding", () => {
  const relPath = ".agents/skills/devpro";
  const linkTargetBytes = Buffer.from("../../.devpro/agent-skills/release/release-runbook");

  it("fails closed for a non-Git consumer root", async () => {
    await withGitSymlinkSeedRoot(async (repoRoot) => {
      const runner = makeGitSymlinkSeedRunner(repoRoot, relPath, linkTargetBytes, {
        rootStatus: 128,
        rootStderr: "fatal: not a git repository",
      });
      assert.throws(
        () => createMissingGitSymlinkBlob(repoRoot, relPath, linkTargetBytes, runner),
        /Git symlink evidence fault/
      );
    });
  });

  it("fails closed when Git reports a different top-level", async () => {
    await withGitSymlinkSeedRoot(async (repoRoot) => {
      const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sync-other-git-root-"));
      try {
        const runner = makeGitSymlinkSeedRunner(repoRoot, relPath, linkTargetBytes, {
          reportedRoot: otherRoot,
        });
        assert.throws(
          () => createMissingGitSymlinkBlob(repoRoot, relPath, linkTargetBytes, runner),
          /Git symlink evidence fault/
        );
      } finally {
        await fs.rm(otherRoot, { recursive: true, force: true });
      }
    });
  });

  it("refuses an existing mode 100644 index record", async () => {
    await withGitSymlinkSeedRoot(async (repoRoot) => {
      const runner = makeGitSymlinkSeedRunner(repoRoot, relPath, linkTargetBytes, {
        initialIndex: `100644 ${"b".repeat(40)} 0\t${relPath}\0`,
      });
      assert.throws(
        () => createMissingGitSymlinkBlob(repoRoot, relPath, linkTargetBytes, runner),
        /refusing to replace an existing/
      );
    });
  });

  it("refuses an existing conflicting mode 120000 index record", async () => {
    await withGitSymlinkSeedRoot(async (repoRoot) => {
      const runner = makeGitSymlinkSeedRunner(repoRoot, relPath, linkTargetBytes, {
        initialIndex: `120000 ${"b".repeat(40)} 0\t${relPath}\0`,
      });
      assert.throws(
        () => createMissingGitSymlinkBlob(repoRoot, relPath, linkTargetBytes, runner),
        /refusing to replace an existing/
      );
    });
  });

  it("fails closed when hash-object fails", async () => {
    await withGitSymlinkSeedRoot(async (repoRoot) => {
      const runner = makeGitSymlinkSeedRunner(repoRoot, relPath, linkTargetBytes, {
        hashStatus: 1,
        hashStderr: "injected hash-object fault",
      });
      assert.throws(
        () => createMissingGitSymlinkBlob(repoRoot, relPath, linkTargetBytes, runner),
        /injected hash-object fault/
      );
    });
  });

  it("fails closed when update-index fails", async () => {
    await withGitSymlinkSeedRoot(async (repoRoot) => {
      const runner = makeGitSymlinkSeedRunner(repoRoot, relPath, linkTargetBytes, {
        updateStatus: 1,
        updateStderr: "injected update-index fault",
      });
      assert.throws(
        () => createMissingGitSymlinkBlob(repoRoot, relPath, linkTargetBytes, runner),
        /injected update-index fault/
      );
    });
  });

  it("fails closed when read-back mode is not 120000", async () => {
    await withGitSymlinkSeedRoot(async (repoRoot) => {
      const runner = makeGitSymlinkSeedRunner(repoRoot, relPath, linkTargetBytes, {
        readbackIndex: `100644 ${"a".repeat(40)} 0\t${relPath}\0`,
      });
      assert.throws(
        () => createMissingGitSymlinkBlob(repoRoot, relPath, linkTargetBytes, runner),
        /persisted 120000 entry does not match/
      );
    });
  });

  it("fails closed when read-back blob bytes do not match", async () => {
    await withGitSymlinkSeedRoot(async (repoRoot) => {
      const runner = makeGitSymlinkSeedRunner(repoRoot, relPath, linkTargetBytes, {
        readbackBlob: Buffer.from("../../wrong-target"),
      });
      assert.throws(
        () => createMissingGitSymlinkBlob(repoRoot, relPath, linkTargetBytes, runner),
        /persisted 120000 entry does not match/
      );
    });
  });

  // PR #2886 cross-model WARN: the entry is already staged when read-back
  // fails, and the caller has not recorded it for rollback yet.
  it("removes the index entry it staged when read-back fails", async () => {
    await withGitSymlinkSeedRoot(async (repoRoot) => {
      const calls = [];
      const inner = makeGitSymlinkSeedRunner(repoRoot, relPath, linkTargetBytes, {
        readbackBlob: Buffer.from("../../wrong-target"),
      });
      const runner = (cwd, args, options) => {
        calls.push(args);
        return inner(cwd, args, options);
      };
      assert.throws(
        () => createMissingGitSymlinkBlob(repoRoot, relPath, linkTargetBytes, runner),
        /persisted 120000 entry does not match/
      );
      assert.deepEqual(
        calls.at(-1),
        ["update-index", "--force-remove", "--", relPath],
        "a failed read-back must unstage the entry this call added"
      );
    });
  });

  it("names the manual unstage step when removing the staged entry also fails", async () => {
    await withGitSymlinkSeedRoot(async (repoRoot) => {
      const inner = makeGitSymlinkSeedRunner(repoRoot, relPath, linkTargetBytes, {
        readbackBlob: Buffer.from("../../wrong-target"),
      });
      const runner = (cwd, args, options) => (args[1] === "--force-remove"
        ? { status: 1, stdout: "", stderr: "index.lock exists" }
        : inner(cwd, args, options));
      assert.throws(
        () => createMissingGitSymlinkBlob(repoRoot, relPath, linkTargetBytes, runner),
        (error) => /persisted 120000 entry does not match/.test(error.message)
          && error.message.includes("index.lock exists")
          && error.message.includes(`run: git update-index --force-remove -- ${relPath}`)
      );
    });
  });
});

// ---------------------------------------------------------------------------
// --sync
//
// This describe block was split into two sibling files (this file +
// sync-agent-rules-d.test.mjs) to shorten the node --test integration-tier
// critical path: the original single "--sync" describe held all 30 cases.
// Both halves share the same before()/after() fixture shape (each stands up
// its own createConsumerRepo({ fullSubmod: true }) via the shared harness
// module) — the fixture setup/teardown cost is duplicated across the two
// files, but each half now runs well under the original combined time.
// Continued in sync-agent-rules-d.test.mjs.
// ---------------------------------------------------------------------------
// Phase snapshots are intentionally shared only by these sequential assertions.
// State-transition cases below still execute their own real sync operation.
describe("--sync", { concurrency: false }, () => {
  let ctx;
  let initialSyncResult;
  let hooksPathBeforeSync;
  let hooksPathAfterSync;
  // Keep the initial result immutable as a baseline.  Mutation cases below
  // must own their sync result so test order cannot change their evidence.
  before(async () => {
    setRunUsesFullSubmodSource(true);
    ctx = await createConsumerRepo({ fullSubmod: true });
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: ctx.tmpDir, encoding: "utf8" });
    await fs.mkdir(path.join(ctx.tmpDir, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(ctx.tmpDir, ".claude", "settings.json"),
      JSON.stringify({ hooks: {} }, null, 2) + "\n"
    );
    hooksPathBeforeSync = spawnSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: ctx.tmpDir,
      encoding: "utf8",
    });
    initialSyncResult = Object.freeze(run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir }));
    hooksPathAfterSync = spawnSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: ctx.tmpDir,
      encoding: "utf8",
    });
  });
  after(async () => {
    setRunUsesFullSubmodSource(false);
    await fs.rm(ctx.tmpDir, { recursive: true, force: true });
  });

  it("syncs AGENTS.md to consumer root", () => {
    const { stdout, exitCode } = initialSyncResult;
    assert.equal(exitCode, 0);
    assert.match(stdout, /Synchronized AGENTS\.md/);
  });

  it("does not sync .claude/commands (commands removed; CLAUDE_SYNC_SUBDIRS no longer includes it) but syncs settings", () => {
    const { stdout } = initialSyncResult;
    assert.doesNotMatch(stdout, /Synchronized \.claude\/commands/);
    assert.match(stdout, /Synchronized \.claude\/settings\.json/);
  });

  it("syncs .claude/agents when source has agents dir", async () => {
    const sourceAgentsDir = path.join(ctx.submod, ".claude", "agents");
    const hasSourceAgents = await fs.access(sourceAgentsDir).then(() => true).catch(() => false);
    if (!hasSourceAgents) return;

    const { stdout, exitCode } = initialSyncResult;
    assert.equal(exitCode, 0);
    assert.match(stdout, /Synchronized \.claude\/agents\//);

    for (const entry of await fs.readdir(sourceAgentsDir)) {
      if (!entry.endsWith(".md")) continue;
      const sourceContent = await fs.readFile(path.join(sourceAgentsDir, entry), "utf8");
      const targetContent = await fs.readFile(
        path.join(ctx.tmpDir, ".claude", "agents", entry),
        "utf8"
      );
      assert.equal(targetContent, sourceContent, `${entry} should be byte-equal`);
    }
  });

  it("syncs .devpro/agent-skills for cross-runtime agents", async () => {
    const { stdout, exitCode } = initialSyncResult;
    assert.equal(exitCode, 0);
    assert.match(stdout, /Synchronized \.devpro\//);

    const rel = path.join(".devpro", "agent-skills-refs", "autonomous-ai-agents", "codex", "SKILL.md");
    const sourceContent = await fs.readFile(path.join(ctx.submod, rel), "utf8");
    const targetContent = await fs.readFile(path.join(ctx.tmpDir, rel), "utf8");
    assert.equal(targetContent, sourceContent, `${rel} should be byte-equal`);
  });

  it("raw sync does not configure clone-local core.hooksPath", () => {
    assert.equal(hooksPathBeforeSync.stdout.trim(), "", "precondition: hooksPath should be unset");

    const { stdout, exitCode, stderr } = initialSyncResult;

    assert.equal(exitCode, 0, `sync should exit 0; stderr=${stderr}`);
    assert.doesNotMatch(stdout, /Configured git core\.hooksPath = /);
    assert.equal(hooksPathAfterSync.stdout.trim(), "", "raw sync must leave clone-local hooksPath unset");
  });

  it("does not inject model key when source settings.json has no model", async () => {
    const settingsSrc = path.join(ctx.submod, ".claude", "settings.json");
    const sourceData = JSON.parse(await fs.readFile(settingsSrc, "utf8"));
    // Ensure source has no model key (this is the expected production state)
    delete sourceData.model;
    await fs.writeFile(settingsSrc, JSON.stringify(sourceData, null, 2) + "\n");

    const targetSettingsPath = path.join(ctx.tmpDir, ".claude", "settings.json");

    // case A: the initial sync already exercised a consumer with no model;
    // retain the assertion without spawning a redundant full sync.
    const afterA = JSON.parse(await fs.readFile(targetSettingsPath, "utf8"));
    assert.ok(!Object.prototype.hasOwnProperty.call(afterA, "model"),
      "initial sync must not inject model key when source has none (case A)");

    // case B: consumer has a pre-existing model — sync must not clear it
    const preB = { hooks: {}, model: "claude-consumer-choice" };
    await fs.writeFile(targetSettingsPath, JSON.stringify(preB, null, 2) + "\n");
    const syncResultAfterModelPreservation = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir });
    assert.equal(syncResultAfterModelPreservation.exitCode, 0, syncResultAfterModelPreservation.stderr);
    const afterB = JSON.parse(await fs.readFile(targetSettingsPath, "utf8"));
    assert.equal(afterB.model, "claude-consumer-choice",
      "sync must preserve consumer model when source has no model (case B)");
  });

  it("creates AGENTS.md identical to source", async () => {
    const syncResult = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir });
    assert.equal(syncResult.exitCode, 0, syncResult.stderr);
    const source = await fs.readFile(path.join(ctx.submod, "AGENTS.md"), "utf8");
    const target = await fs.readFile(path.join(ctx.tmpDir, "AGENTS.md"), "utf8");
    assert.equal(target, source);
  });

  it("syncs all static files and sync dirs", async () => {
    const syncResult = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir });
    const { stdout, exitCode } = syncResult;
    assert.equal(exitCode, 0);
    for (const { relPath } of STATIC_FILES) {
      assert.match(stdout, new RegExp(`Synchronized ${relPath.replace(/[/.]/g, "\\$&")}`));
      const exists = await fs.access(path.join(ctx.tmpDir, relPath))
        .then(() => true).catch(() => false);
      assert.ok(exists, `expected ${relPath} to exist`);
    }
    for (const { relPath } of SYNC_DIRS) {
      if (relPath === ".codex") {
        assert.match(stdout, /Synchronized \.codex\/hooks\.json/);
      } else if (relPath === ".cursor") {
        assert.match(stdout, /Synchronized \.cursor\/hooks\.json/);
      } else if (relPath === ".agents") {
        // .agents/ has no byte-copyable content of its own once the single
        // `devpro` discovery entry (design D3) is excluded from the
        // recursive sync — by this point in the shared ctx an earlier
        // subtest already ran --sync, so the entry-install transaction's
        // idempotent-skip (design D8 item 2) means this re-sync logs
        // nothing for it. Assert the entry directly instead of a
        // "Synchronized .agents/" log line.
        const devproEntry = await fs
          .lstat(path.join(ctx.tmpDir, ".agents", "skills", "devpro"))
          .catch(() => null);
        assert.ok(devproEntry, "expected .agents/skills/devpro to exist");
      } else {
        assert.match(stdout, new RegExp(`Synchronized ${relPath.replace(/[/.]/g, "\\$&")}/`));
      }
    }
  });

  it("creates missing .gitignore with the managed block", async () => {
    await withConsumerRepo(async (local) => {
      const gitignorePath = path.join(local.tmpDir, ".gitignore");
      await fs.rm(gitignorePath, { force: true });

      const { stdout, exitCode } = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.equal(exitCode, 0);
      assert.match(stdout, /Synchronized \.gitignore/);

      const content = await fs.readFile(gitignorePath, "utf8");
      assert.match(content, new RegExp(GITIGNORE_MANAGED_BEGIN));
      assert.match(content, new RegExp(GITIGNORE_MANAGED_END));
      assert.match(content, /^\.worktree\/$/m);
      assert.match(content, /^\.devpro\/scripts\/hooks\/state\/$/m);
      // Build artifacts belong to the Devpro-managed baseline.
      assert.match(content, /^node_modules\/$/m);
      assert.match(content, /^packages\/$/m);
    });
  });

  it("updates an existing .gitignore managed block", async () => {
    await withConsumerRepo(async (local) => {
      const gitignorePath = path.join(local.tmpDir, ".gitignore");
      await fs.writeFile(
        gitignorePath,
        [
          "consumer-local/",
          GITIGNORE_MANAGED_BEGIN,
          "old-devpro-entry/",
          GITIGNORE_MANAGED_END,
          "",
        ].join("\n")
      );

      const { exitCode } = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.equal(exitCode, 0);

      const content = await fs.readFile(gitignorePath, "utf8");
      assert.doesNotMatch(content, /old-devpro-entry/);
      assert.match(content, /^\.worktree\/$/m);
      assert.match(content, /^consumer-local\/$/m);
    });
  });

  it("preserves consumer-local .gitignore bytes outside the managed block", () => {
    const consumerOwned = "coverage-local/\r\n.env.local\nconsumer-tail/";
    const content = mergeGitignoreManagedBlock(
      [
        "coverage-local/\r\n",
        `${GITIGNORE_MANAGED_BEGIN}\r\nold-devpro-entry/\r\n${GITIGNORE_MANAGED_END}\r\n`,
        ".env.local\nconsumer-tail/",
      ].join(""),
      TEST_GITIGNORE_BASELINE_ENTRIES,
      TEST_GITIGNORE_MANAGED_ENTRIES
    );

    assert.equal(content.slice(0, consumerOwned.length), consumerOwned);
    assert.equal(content[consumerOwned.length], "\n");
    assert.match(content, /^coverage-local\/$/m);
    assert.match(content, /^\.env\.local$/m);
    assert.match(content, /^consumer-tail\/$/m);
    assert.match(content, new RegExp(GITIGNORE_MANAGED_BEGIN));
    assert.doesNotMatch(content, /old-devpro-entry/);
    assert.equal(
      mergeGitignoreManagedBlock(
        content,
        TEST_GITIGNORE_BASELINE_ENTRIES,
        TEST_GITIGNORE_MANAGED_ENTRIES
      ),
      content
    );
  });

  it("does not duplicate baseline entries already scattered in .gitignore", () => {
    const content = mergeGitignoreManagedBlock(
      ".worktree/\nnotes/\nconsumer-local/\n",
      TEST_GITIGNORE_BASELINE_ENTRIES,
      TEST_GITIGNORE_MANAGED_ENTRIES
    );

    assert.equal(countGitignoreEntry(content, ".worktree/"), 1);
    assert.equal(countGitignoreEntry(content, "notes/"), 1);
    assert.match(content, /^consumer-local\/$/m);
  });

  it("--check now catches an orphan .gitignore managed-block end marker", async () => {
    await withConsumerRepo(async (local) => {
      const syncResult = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.equal(syncResult.exitCode, 0, syncResult.stderr);

      const gitignorePath = path.join(local.tmpDir, ".gitignore");
      const content = await fs.readFile(gitignorePath, "utf8");
      await fs.writeFile(gitignorePath, `${GITIGNORE_MANAGED_END}\n${content}`);

      const { exitCode, stderr } = run(local.syncScript, "--check", { cwd: local.tmpDir });
      assert.notEqual(exitCode, 0);
      assert.match(stderr, /\.gitignore managed end marker has no begin marker/);
      assert.doesNotMatch(stderr, /Run sync-agent-rules\.mjs --sync\./);
    });
  });

  it("creates missing .gitattributes with the managed block", async () => {
    await withConsumerRepo(async (local) => {
      const attributesPath = path.join(local.tmpDir, ".gitattributes");
      await fs.rm(attributesPath, { force: true });

      const { stdout, exitCode } = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.equal(exitCode, 0);
      assert.match(stdout, /Synchronized \.gitattributes/);

      const content = await fs.readFile(attributesPath, "utf8");
      assert.match(content, new RegExp(GITATTRIBUTES_MANAGED_BEGIN));
      assert.match(content, new RegExp(GITATTRIBUTES_MANAGED_END));
      for (const entry of GITATTRIBUTES_MANAGED_ENTRIES) {
        assert.equal(countGitignoreEntry(content, entry), 1);
      }
    });
  });

  it("preserves consumer-local .gitattributes bytes outside the managed block", () => {
    const consumerOwned = "*.png binary\r\ndocs/** linguist-documentation";
    const content = mergeGitattributesManagedBlock(
      [
        "*.png binary\r\n",
        `${GITATTRIBUTES_MANAGED_BEGIN}\r\nold-devpro-entry text=auto\r\n${GITATTRIBUTES_MANAGED_END}\r\n`,
        "docs/** linguist-documentation",
      ].join("")
    );

    assert.equal(content.slice(0, consumerOwned.length), consumerOwned);
    assert.equal(content[consumerOwned.length], "\n");
    assert.match(content, /^\*\.png binary$/m);
    assert.match(content, /^docs\/\*\* linguist-documentation$/m);
    assert.doesNotMatch(content, /old-devpro-entry/);
    for (const entry of GITATTRIBUTES_MANAGED_ENTRIES) {
      assert.equal(countGitignoreEntry(content, entry), 1);
    }
    assert.equal(mergeGitattributesManagedBlock(content), content);
  });

  it("does not duplicate managed entries already scattered in .gitattributes", async () => {
    await withConsumerRepo(async (local) => {
      const attributesPath = path.join(local.tmpDir, ".gitattributes");
      await fs.writeFile(
        attributesPath,
        [
          GITATTRIBUTES_MANAGED_ENTRIES[0],
          "*.png binary",
          GITATTRIBUTES_MANAGED_ENTRIES[1],
          "",
        ].join("\n")
      );

      const { exitCode } = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.equal(exitCode, 0);

      const content = await fs.readFile(attributesPath, "utf8");
      assert.match(content, /^\*\.png binary$/m);
      for (const entry of GITATTRIBUTES_MANAGED_ENTRIES) {
        assert.equal(countGitignoreEntry(content, entry), 1);
      }
      assert.match(content, new RegExp(GITATTRIBUTES_MANAGED_BEGIN));
      assert.match(content, new RegExp(GITATTRIBUTES_MANAGED_END));
    });
  });

  describe("plain-checkout discovery link fallback", { concurrency: true }, () => {
    for (const symlinkErrorCode of ["EPERM", "EACCES", "ENOSYS"]) {
      it(`classifies ${symlinkErrorCode} and rejects its near-miss error code`, () => {
        assert.equal(isManagedSkillSymlinkFallbackError({ code: symlinkErrorCode }), true);
        assert.equal(isManagedSkillSymlinkFallbackError({ code: `${symlinkErrorCode}_OTHER` }), false);
      });
    }

    it("installs a new plain-checkout discovery link after representative EPERM", async () => {
      const symlinkErrorCode = "EPERM";
      await withSlimManagedSkillSource(async (slim) => withConsumerRepo(async (local) => {
        git(local.tmpDir, ["init", "-q", "-b", "main"]);
        git(local.tmpDir, ["config", "core.symlinks", "false"]);
        const link = slim.discoveryRel;
        const linkPath = path.join(local.tmpDir, ...link.split("/"));
        const expectedTarget = slim.discoveryTarget;
        assert.equal(
          git(local.tmpDir, ["ls-files", "--stage", "--", link]),
          "",
          "precondition: the new discovery path must not already exist in the consumer index"
        );

        const preloadPath = path.join(local.tmpDir, "force-discovery-symlink-error.mjs");
        await fs.writeFile(
          preloadPath,
          [
            'import { promises as fs } from "node:fs";',
            "const realSymlink = fs.symlink.bind(fs);",
            "fs.symlink = async (target, nodePath, ...args) => {",
            '  const normalized = String(nodePath).replaceAll("\\\\", "/");',
            '  if (/\\/\\.(?:agents|claude)\\/skills\\//.test(normalized)) {',
            '    const error = new Error("forced discovery symlink capability fault");',
            "    error.code = process.env.DEVPRO_TEST_SYMLINK_ERROR_CODE;",
            "    throw error;",
            "  }",
            "  return realSymlink(target, nodePath, ...args);",
            "};",
            "",
          ].join("\n")
        );

        const sync = run(local.syncScript, "--sync", {
          cwd: local.tmpDir,
          testSourceRoot: slim.sourceRoot,
          env: {
            DEVPRO_TEST_SYMLINK_ERROR_CODE: symlinkErrorCode,
            NODE_OPTIONS: [
              process.env.NODE_OPTIONS,
              `--import=${pathToFileURL(preloadPath).href}`,
            ].filter(Boolean).join(" "),
          },
        });
        assert.equal(sync.exitCode, 0, sync.stderr);

        const stats = await fs.lstat(linkPath);
        assert.ok(stats.isFile() && !stats.isSymbolicLink());
        assert.equal(await readGitLinkTarget(local.tmpDir, link), expectedTarget);
        assert.match(
          sync.stderr,
          /managed-skill-discovery-degraded/,
          "--sync must emit degrade advisory when discovery falls back to plain links"
        );
        assert.match(
          sync.stderr,
          /WARN: managed-skill-discovery-degraded: \d+ git-backed plain link\(s\)/
        );

        git(local.tmpDir, ["add", "-A"]);
        assert.equal(await readGitLinkTarget(local.tmpDir, link), expectedTarget);

        const check = run(local.syncScript, "--check", {
          cwd: local.tmpDir,
          testSourceRoot: slim.sourceRoot,
        });
        assert.equal(check.exitCode, 0, check.stderr);
        assert.match(
          check.stderr,
          /managed-skill-discovery-degraded/,
          "--check must warn on existing git-backed plain discovery links without failing"
        );
      }));
    });

    it("keeps matching plain discovery links when core.symlinks=false on a later --sync", async () => {
      await withSlimManagedSkillSource(async (slim) => withConsumerRepo(async (local) => {
        git(local.tmpDir, ["init", "-q", "-b", "main"]);
        git(local.tmpDir, ["config", "core.symlinks", "false"]);
        const link = slim.discoveryRel;
        const linkPath = path.join(local.tmpDir, ...link.split("/"));

        const preloadPath = path.join(local.tmpDir, "force-discovery-symlink-error.mjs");
        await fs.writeFile(
          preloadPath,
          [
            'import { promises as fs } from "node:fs";',
            "const realSymlink = fs.symlink.bind(fs);",
            "fs.symlink = async (target, nodePath, ...args) => {",
            '  const normalized = String(nodePath).replaceAll("\\\\", "/");',
            '  if (/\\/\\.(?:agents|claude)\\/skills\\//.test(normalized)) {',
            '    const error = new Error("forced discovery symlink capability fault");',
            "    error.code = process.env.DEVPRO_TEST_SYMLINK_ERROR_CODE;",
            "    throw error;",
            "  }",
            "  return realSymlink(target, nodePath, ...args);",
            "};",
            "",
          ].join("\n")
        );

        const degraded = run(local.syncScript, "--sync", {
          cwd: local.tmpDir,
          testSourceRoot: slim.sourceRoot,
          env: {
            DEVPRO_TEST_SYMLINK_ERROR_CODE: "EPERM",
            NODE_OPTIONS: [
              process.env.NODE_OPTIONS,
              `--import=${pathToFileURL(preloadPath).href}`,
            ].filter(Boolean).join(" "),
          },
        });
        assert.equal(degraded.exitCode, 0, degraded.stderr);
        assert.match(degraded.stderr, /Symlink creation failed for \.agents\/skills\/devpro \(EPERM\)/);
        assert.match(degraded.stderr, /directory permissions/);
        const degradedStats = await fs.lstat(linkPath);
        assert.ok(degradedStats.isFile() && !degradedStats.isSymbolicLink());
        assert.match(degraded.stderr, /managed-skill-discovery-degraded/);
        assert.match(
          degraded.stderr,
          /matching plain links are kept intentionally \(prefer-plain\)/
        );

        const later = run(local.syncScript, "--sync", {
          cwd: local.tmpDir,
          testSourceRoot: slim.sourceRoot,
        });
        assert.equal(later.exitCode, 0, later.stderr);
        const laterStats = await fs.lstat(linkPath);
        assert.ok(
          laterStats.isFile() && !laterStats.isSymbolicLink(),
          "matching plain discovery links must stay plain when core.symlinks=false even if host can symlink"
        );
        assert.match(later.stderr, /managed-skill-discovery-degraded/);
        assert.match(
          later.stderr,
          /matching plain links are kept intentionally \(prefer-plain\)/
        );

        const check = run(local.syncScript, "--check", {
          cwd: local.tmpDir,
          testSourceRoot: slim.sourceRoot,
        });
        assert.equal(check.exitCode, 0, check.stderr);
        assert.match(check.stderr, /managed-skill-discovery-degraded/);
        assert.match(
          check.stderr,
          /matching plain links are kept intentionally \(prefer-plain\)/,
          "--check must include prefer-plain policy note when core.symlinks=false"
        );
      }));
    });

    it("upgrades matching plain discovery links to symlinks on a later --sync when core.symlinks=true", async () => {
      await withSlimManagedSkillSource(async (slim) => withConsumerRepo(async (local) => {
        git(local.tmpDir, ["init", "-q", "-b", "main"]);
        git(local.tmpDir, ["config", "core.symlinks", "true"]);
        const link = slim.discoveryRel;
        const linkPath = path.join(local.tmpDir, ...link.split("/"));
        const expectedTarget = slim.discoveryTarget;

        const preloadPath = path.join(local.tmpDir, "force-discovery-symlink-error.mjs");
        await fs.writeFile(
          preloadPath,
          [
            'import { promises as fs } from "node:fs";',
            "const realSymlink = fs.symlink.bind(fs);",
            "fs.symlink = async (target, nodePath, ...args) => {",
            '  const normalized = String(nodePath).replaceAll("\\\\", "/");',
            '  if (/\\/\\.(?:agents|claude)\\/skills\\//.test(normalized)) {',
            '    const error = new Error("forced discovery symlink capability fault");',
            "    error.code = process.env.DEVPRO_TEST_SYMLINK_ERROR_CODE;",
            "    throw error;",
            "  }",
            "  return realSymlink(target, nodePath, ...args);",
            "};",
            "",
          ].join("\n")
        );

        const degraded = run(local.syncScript, "--sync", {
          cwd: local.tmpDir,
          testSourceRoot: slim.sourceRoot,
          env: {
            DEVPRO_TEST_SYMLINK_ERROR_CODE: "EPERM",
            NODE_OPTIONS: [
              process.env.NODE_OPTIONS,
              `--import=${pathToFileURL(preloadPath).href}`,
            ].filter(Boolean).join(" "),
          },
        });
        assert.equal(degraded.exitCode, 0, degraded.stderr);
        const degradedStats = await fs.lstat(linkPath);
        assert.ok(degradedStats.isFile() && !degradedStats.isSymbolicLink());
        assert.match(degraded.stderr, /managed-skill-discovery-degraded/);

        const upgraded = run(local.syncScript, "--sync", {
          cwd: local.tmpDir,
          testSourceRoot: slim.sourceRoot,
        });
        assert.equal(upgraded.exitCode, 0, upgraded.stderr);
        const upgradedStats = await fs.lstat(linkPath);
        assert.ok(
          upgradedStats.isSymbolicLink(),
          "matching plain discovery links must upgrade when core.symlinks=true and host symlink creation works"
        );
        assert.equal(
          normalizeSymlinkTargetSeparators(await fs.readlink(linkPath)),
          normalizeSymlinkTargetSeparators(expectedTarget)
        );
        assert.doesNotMatch(upgraded.stderr, /managed-skill-discovery-degraded/);
        assert.doesNotMatch(
          upgraded.stderr,
          /matching plain links are kept intentionally \(prefer-plain\)/
        );
      }));
    });

    it("maps core.symlinks unset to the representative true upgrade policy", () => {
      assert.equal(isPreferPlainCoreSymlinksState("unset"), false);
      assert.equal(
        isPreferPlainCoreSymlinksState("unset"),
        isPreferPlainCoreSymlinksState("true")
      );
    });

    it("restores matching plain blob before rethrow on non-enumerated symlink errors", async () => {
      await withSlimManagedSkillSource(async (slim) => withConsumerRepo(async (local) => {
        git(local.tmpDir, ["init", "-q", "-b", "main"]);
        git(local.tmpDir, ["config", "core.symlinks", "true"]);
        const link = slim.discoveryRel;
        const linkPath = path.join(local.tmpDir, ...link.split("/"));
        const expectedTarget = slim.discoveryTarget;

        const preloadPath = path.join(local.tmpDir, "force-discovery-symlink-error.mjs");
        await fs.writeFile(
          preloadPath,
          [
            'import { promises as fs } from "node:fs";',
            "const realSymlink = fs.symlink.bind(fs);",
            "fs.symlink = async (target, nodePath, ...args) => {",
            '  const normalized = String(nodePath).replaceAll("\\\\", "/");',
            '  if (/\\/\\.(?:agents|claude)\\/skills\\//.test(normalized)) {',
            '    const error = new Error("forced discovery symlink capability fault");',
            "    error.code = process.env.DEVPRO_TEST_SYMLINK_ERROR_CODE;",
            "    throw error;",
            "  }",
            "  return realSymlink(target, nodePath, ...args);",
            "};",
            "",
          ].join("\n")
        );

        const seed = run(local.syncScript, "--sync", {
          cwd: local.tmpDir,
          testSourceRoot: slim.sourceRoot,
          env: {
            DEVPRO_TEST_SYMLINK_ERROR_CODE: "EPERM",
            NODE_OPTIONS: [
              process.env.NODE_OPTIONS,
              `--import=${pathToFileURL(preloadPath).href}`,
            ].filter(Boolean).join(" "),
          },
        });
        assert.equal(seed.exitCode, 0, seed.stderr);
        assert.equal(await fs.readFile(linkPath, "utf8"), expectedTarget);

        const failed = run(local.syncScript, "--sync", {
          cwd: local.tmpDir,
          testSourceRoot: slim.sourceRoot,
          env: {
            DEVPRO_TEST_SYMLINK_ERROR_CODE: "EINVAL",
            NODE_OPTIONS: [
              process.env.NODE_OPTIONS,
              `--import=${pathToFileURL(preloadPath).href}`,
            ].filter(Boolean).join(" "),
          },
        });
        assert.notEqual(failed.exitCode, 0, "non-enumerated symlink errors must still fail the sync");
        const stats = await fs.lstat(linkPath);
        assert.ok(
          stats.isFile() && !stats.isSymbolicLink(),
          "recovery MUST restore expectedBlob before rethrow so the managed entry is not missing"
        );
        assert.equal(await fs.readFile(linkPath, "utf8"), expectedTarget);
      }));
    });
  });

  it("persists manifest-managed skill discovery through ordinary staging", async () => {
    await withSlimManagedSkillSource(async (slim) => withConsumerRepo(async (local) => {
      git(local.tmpDir, ["init", "-q", "-b", "main"]);
      git(local.tmpDir, ["config", "user.name", "sync-test"]);
      git(local.tmpDir, ["config", "user.email", "sync-test@example.invalid"]);
      const target = ".devpro/agent-skills/release/release-runbook/SKILL.md";
      const links = slim.discoveryRels;
      const linkTargets = new Map();
      await fs.writeFile(
        path.join(local.tmpDir, ".gitignore"),
        [
          "consumer-first/",
          "[Rr]elease/",
          GITIGNORE_MANAGED_BEGIN,
          "stale-managed-entry/",
          GITIGNORE_MANAGED_END,
          "consumer-last/",
          "",
        ].join("\n")
      );
      await fs.mkdir(path.join(local.tmpDir, "release"), { recursive: true });
      await fs.writeFile(path.join(local.tmpDir, "release", "build.bin"), "unmanaged\n");

      // Starting state mirrors a real consumer: discovery links already exist in
      // Git as 120000 entries, while the newly managed physical target is absent.
      // Seed the index with plumbing so the tree-mode contract is independent of
      // whether this host can materialize symlinks in its working tree.
      git(local.tmpDir, ["add", ".gitignore"]);
      for (const link of links) {
        const expectedTarget = await readGitLinkTarget(slim.sourceRoot, link);
        linkTargets.set(link, expectedTarget);
        const objectId = gitWithInput(local.tmpDir, ["hash-object", "-w", "--stdin"], expectedTarget).trim();
        git(local.tmpDir, ["update-index", "--add", "--cacheinfo", `120000,${objectId},${link}`]);
      }
      git(local.tmpDir, ["commit", "-q", "-m", "seed existing discovery links"]);

      const sync = run(local.syncScript, "--sync", {
        cwd: local.tmpDir,
        testSourceRoot: slim.sourceRoot,
      });
      assert.equal(sync.exitCode, 0, sync.stderr);
      assert.equal((sync.stdout.match(/1 check-ignore batch/g) ?? []).length, 1);

      const plainCheckoutLink = links[0];
      const plainCheckoutPath = path.join(local.tmpDir, ...plainCheckoutLink.split("/"));
      await fs.rm(plainCheckoutPath);
      await fs.writeFile(plainCheckoutPath, linkTargets.get(plainCheckoutLink));
      const plainCheckoutCheck = run(local.syncScript, "--check", {
        cwd: local.tmpDir,
        testSourceRoot: slim.sourceRoot,
      });
      assert.equal(
        plainCheckoutCheck.exitCode,
        0,
        "a byte-exact plain checkout is valid only because the index proves mode 120000"
      );
      await fs.writeFile(plainCheckoutPath, `${linkTargets.get(plainCheckoutLink)}\r\n`);
      const crlfCheckoutCheck = run(local.syncScript, "--check", {
        cwd: local.tmpDir,
        testSourceRoot: slim.sourceRoot,
      });
      assert.notEqual(crlfCheckoutCheck.exitCode, 0);
      assert.match(crlfCheckoutCheck.stderr, /observed file, expected symlink/);
      await materializeLinkOrPlain(plainCheckoutPath, linkTargets.get(plainCheckoutLink));

      const gitignore = await fs.readFile(path.join(local.tmpDir, ".gitignore"), "utf8");
      assert.ok(
        gitignore.indexOf("consumer-first/") < gitignore.indexOf("consumer-last/"),
        "consumer-owned lines must preserve relative order"
      );
      assert.ok(
        gitignore.trimEnd().endsWith(GITIGNORE_MANAGED_END),
        "managed block must be terminal"
      );
      for (const expected of [
        "!/.devpro/",
        "!/.devpro/agent-skills/",
        "!/.devpro/agent-skills/release/",
        "!/.devpro/agent-skills/release/release-runbook/",
        "!/.devpro/agent-skills/release/release-runbook/**",
        "!/.agents/",
        "!/.agents/skills/",
        "!/.agents/skills/devpro",
        "!/.claude/skills/devpro",
      ]) {
        assert.match(gitignore, new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
      }
      assert.doesNotMatch(gitignore, /^!\/release\/(?:\*\*)?$/m);
      // .cursor/skills is a retired discovery root (design D1 of
      // remove-cursor-skill-discovery): the inventory-derived ancestor
      // exception vanishes naturally once .cursor/skills is no longer a
      // SKILL_DISCOVERY_DIRS member — no migration code needed.
      assert.doesNotMatch(gitignore, /^!\/\.cursor\//m);

      const canonicalCheck = run(local.syncScript, "--check", {
        cwd: local.tmpDir,
        testSourceRoot: slim.sourceRoot,
      });
      assert.equal(canonicalCheck.exitCode, 0, canonicalCheck.stderr);
      assert.equal((canonicalCheck.stdout.match(/1 check-ignore batch/g) ?? []).length, 1);

      const gitignorePath = path.join(local.tmpDir, ".gitignore");
      await fs.writeFile(
        gitignorePath,
        gitignore.replace("!/.devpro/agent-skills/release/\n", "")
      );
      const missingAncestor = run(local.syncScript, "--check", {
        cwd: local.tmpDir,
        testSourceRoot: slim.sourceRoot,
      });
      assert.notEqual(missingAncestor.exitCode, 0);
      assert.match(missingAncestor.stderr, /\.gitignore managed block differs/);
      await fs.writeFile(gitignorePath, gitignore);

      await fs.appendFile(gitignorePath, "[Rr]elease/\n");
      const lateBroadIgnore = run(local.syncScript, "--check", {
        cwd: local.tmpDir,
        testSourceRoot: slim.sourceRoot,
      });
      assert.notEqual(lateBroadIgnore.exitCode, 0);
      assert.match(lateBroadIgnore.stderr, /\.gitignore managed block is not terminal/);
      await fs.writeFile(gitignorePath, gitignore);

      const unmanagedIgnore = spawnSync("git", ["check-ignore", "-v", "--no-index", "release/build.bin"], {
        cwd: local.tmpDir,
        encoding: "utf8",
      });
      assert.equal(unmanagedIgnore.status, 0);
      assert.match(unmanagedIgnore.stdout, /\[Rr\]elease\//);

      const targetIgnore = spawnSync("git", ["check-ignore", "-v", "--no-index", target], {
        cwd: local.tmpDir,
        encoding: "utf8",
      });
      assert.equal(targetIgnore.status, 0);
      assert.match(targetIgnore.stdout, /!\/\.devpro\/agent-skills\/release\/release-runbook\/\*\*/);

      const nestedIgnore = path.join(
        local.tmpDir,
        ".devpro",
        "agent-skills",
        "release",
        "release-runbook",
        ".gitignore"
      );
      await fs.writeFile(nestedIgnore, "SKILL.md\n");
      const positive = run(local.syncScript, "--check", {
        cwd: local.tmpDir,
        testSourceRoot: slim.sourceRoot,
      });
      assert.notEqual(positive.exitCode, 0);
      assert.match(positive.stderr, /release-runbook\/SKILL\.md/);
      assert.match(positive.stderr, /\.gitignore:1/);
      assert.match(positive.stderr, /pattern 'SKILL\.md'/);
      assert.match(positive.stderr, /do not use git add -f/);
      await fs.rm(nestedIgnore);

      await fs.rm(path.join(local.tmpDir, ...target.split("/")));
      const missing = run(local.syncScript, "--check", {
        cwd: local.tmpDir,
        testSourceRoot: slim.sourceRoot,
      });
      assert.notEqual(missing.exitCode, 0);
      assert.match(missing.stderr, /release-runbook\/SKILL\.md: observed missing/);
      const repaired = run(local.syncScript, "--sync", {
        cwd: local.tmpDir,
        testSourceRoot: slim.sourceRoot,
      });
      assert.equal(repaired.exitCode, 0, repaired.stderr);

      git(local.tmpDir, ["add", "-A"]);

      const staged = git(local.tmpDir, ["ls-files", "--stage", "--", target]);
      assert.match(
        staged,
        /^100644\s+[0-9a-f]+\s+0\t\.devpro\/agent-skills\/release\/release-runbook\/SKILL\.md$/m,
        `ordinary git add -A must stage ignored managed target ${target}`
      );
      git(local.tmpDir, ["commit", "-q", "-m", "sync managed skills"]);

      assert.match(git(local.tmpDir, ["ls-tree", "HEAD", "--", target]), /^100644\s+blob\s+/);
      assert.equal(git(local.tmpDir, ["ls-tree", "HEAD", "--", "release/build.bin"]), "");
      for (const link of links) {
        assert.match(git(local.tmpDir, ["ls-tree", "HEAD", "--", link]), /^120000\s+blob\s+/);
        assert.equal(git(local.tmpDir, ["cat-file", "-p", `HEAD:${link}`]), linkTargets.get(link));
      }

      const cloneParent = await fs.mkdtemp(path.join(os.tmpdir(), "sync-clean-clone-"));
      const cloneRoot = path.join(cloneParent, "clone");
      try {
        git(cloneParent, ["clone", "-q", local.tmpDir, cloneRoot]);
        assert.equal(
          await fs.readFile(path.join(cloneRoot, ...target.split("/")), "utf8"),
          await fs.readFile(path.join(local.tmpDir, ...target.split("/")), "utf8")
        );
        assert.equal(
          await fs.access(path.join(cloneRoot, "release", "build.bin")).then(() => true).catch(() => false),
          false
        );
        for (const link of links) {
          assert.match(git(cloneRoot, ["ls-tree", "HEAD", "--", link]), /^120000\s+blob\s+/);
          assert.equal(git(cloneRoot, ["cat-file", "-p", `HEAD:${link}`]), linkTargets.get(link));
          const cloneLink = path.join(cloneRoot, ...link.split("/"));
          const stats = await fs.lstat(cloneLink);
          if (stats.isSymbolicLink()) {
            assert.equal(
              normalizeSymlinkTargetSeparators(await fs.readlink(cloneLink)),
              normalizeSymlinkTargetSeparators(linkTargets.get(link))
            );
            assert.equal(
              await fs.realpath(cloneLink),
              await fs.realpath(path.join(cloneRoot, ".devpro", "agent-skills"))
            );
          } else {
            assert.equal(
              await fs.readFile(cloneLink, "utf8"),
              linkTargets.get(link),
              "non-symlink-capable checkout must retain the Git link blob as a plain file"
            );
          }
        }
      } finally {
        await fs.rm(cloneParent, { recursive: true, force: true });
      }
    }));
  });

  it("fails closed on malformed manifest or discovery inventory without synthesizing links", async () => {
    await withConsumerRepo(async (local) => {
      const manifestPath = path.join(local.submod, ".devpro", "agent-skills", "manifest.json");
      const originalManifest = await fs.readFile(manifestPath, "utf8");
      const releaseLinkRel = `.agents/skills/${SKILL_ENTRY_NAME}`;
      const releaseLink = path.join(local.submod, ...releaseLinkRel.split("/"));
      const originalLinkTarget = await readLinkLikeTarget(releaseLink);
      const sourceHasGit = spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: local.submod,
        encoding: "utf8",
      }).status === 0;

      const traversalManifest = JSON.parse(originalManifest);
      traversalManifest.groups[0].skills[0].path = ".devpro/agent-skills/../outside";
      await fs.writeFile(manifestPath, JSON.stringify(traversalManifest, null, 2) + "\n");
      const traversal = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.notEqual(traversal.exitCode, 0);
      assert.match(traversal.stderr, /groups\[0\]\.skills\[0\]\.path/);
      assert.match(traversal.stderr, /traversal/);

      const duplicateManifest = JSON.parse(originalManifest);
      duplicateManifest.groups[0].skills.push({ ...duplicateManifest.groups[0].skills[0] });
      await fs.writeFile(manifestPath, JSON.stringify(duplicateManifest, null, 2) + "\n");
      const duplicate = run(local.syncScript, "--check", { cwd: local.tmpDir });
      assert.notEqual(duplicate.exitCode, 0);
      assert.match(duplicate.stderr, /duplicate managed skill target/);

      const overlappingManifest = JSON.parse(originalManifest);
      const parentTarget = overlappingManifest.groups[0].skills[0].path;
      const nestedTarget = `${parentTarget}/nested-managed-skill`;
      const nestedTargetPath = path.join(local.submod, ...nestedTarget.split("/"));
      await fs.mkdir(nestedTargetPath, { recursive: true });
      await fs.writeFile(path.join(nestedTargetPath, "SKILL.md"), "# Nested managed skill\n");
      overlappingManifest.groups[0].skills.push({ path: nestedTarget });
      await fs.writeFile(manifestPath, JSON.stringify(overlappingManifest, null, 2) + "\n");
      const overlapping = run(local.syncScript, "--check", { cwd: local.tmpDir });
      assert.notEqual(overlapping.exitCode, 0);
      assert.match(overlapping.stderr, /duplicate output path/);
      assert.match(overlapping.stderr, new RegExp(nestedTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      await fs.rm(nestedTargetPath, { recursive: true, force: true });

      const ambiguousManifest = JSON.parse(originalManifest);
      ambiguousManifest.groups[0].skills[0].path = ".devpro\\agent-skills\\outside";
      await fs.writeFile(manifestPath, JSON.stringify(ambiguousManifest, null, 2) + "\n");
      const ambiguous = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.notEqual(ambiguous.exitCode, 0);
      assert.match(ambiguous.stderr, /cross-platform-ambiguous/);

      const colonManifest = JSON.parse(originalManifest);
      colonManifest.groups[0].skills[0].path = ".devpro/agent-skills/release:/outside";
      await fs.writeFile(manifestPath, JSON.stringify(colonManifest, null, 2) + "\n");
      const colon = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.notEqual(colon.exitCode, 0);
      assert.match(colon.stderr, /cross-platform-ambiguous/);

      const trailingDotManifest = JSON.parse(originalManifest);
      trailingDotManifest.groups[0].skills[0].path = ".devpro/agent-skills/release./outside";
      await fs.writeFile(manifestPath, JSON.stringify(trailingDotManifest, null, 2) + "\n");
      const trailingDot = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.notEqual(trailingDot.exitCode, 0);
      assert.match(trailingDot.stderr, /ends in a dot or space/);

      await fs.writeFile(manifestPath, originalManifest);
      await materializeLinkOrPlain(releaseLink, "../../outside");
      if (sourceHasGit) setGitLinkEvidence(local.submod, releaseLinkRel, "../../outside");
      const malformedLink = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.notEqual(malformedLink.exitCode, 0);
      assert.match(malformedLink.stderr, /\.agents\/skills\/devpro/);
      assert.match(malformedLink.stderr, /must equal/);

      await fs.rm(releaseLink);
      if (sourceHasGit) {
        git(local.submod, ["update-index", "--force-remove", "--", releaseLinkRel]);
      }

      // Source-side foreign entry beside (or instead of) the sole `devpro`
      // discovery entry: design D3's source-discovery-dir contract (see
      // buildManagedSkillInventory's readdir loop, `sync-agent-rules.mjs`)
      // rejects ANY entry other than `devpro` before it even checks whether
      // `devpro` itself is present — stricter than the retired per-skill
      // discovery-link model, which tolerated unrelated extras beside a
      // manifest-declared link.
      const directoryExtra = path.join(local.submod, ".agents", "skills", "consumer-extra");
      await fs.mkdir(directoryExtra, { recursive: true });
      await fs.writeFile(path.join(directoryExtra, "README.md"), "legitimate non-link extra\n");
      const foreignEntry = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.notEqual(foreignEntry.exitCode, 0);
      assert.match(foreignEntry.stderr, /only '\.agents\/skills\/devpro' is allowed/);
      await fs.rm(directoryExtra, { recursive: true, force: true });

      // Source-side `devpro` entry missing entirely (discovery dir otherwise
      // empty): buildManagedSkillInventory must fail closed rather than
      // synthesize the missing entry, and must not touch the consumer tree.
      const noLink = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.notEqual(noLink.exitCode, 0);
      assert.match(noLink.stderr, /missing or not a symlink\/Git-backed plain link/);
      assert.equal(
        await fs.lstat(path.join(local.tmpDir, ".agents", "skills", "devpro"))
          .then(() => true)
          .catch(() => false),
        false,
        "sync must not synthesize a missing source discovery entry"
      );

      await fs.writeFile(releaseLink, originalLinkTarget);
      const unprovenPlainSource = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.notEqual(unprovenPlainSource.exitCode, 0);
      assert.match(unprovenPlainSource.stderr, /plain file requires exact Git mode 120000 evidence/);

      git(local.submod, ["init", "-q"]);
      git(local.submod, ["config", "user.name", "sync-test"]);
      git(local.submod, ["config", "user.email", "sync-test@example.invalid"]);
      git(local.submod, ["add", "-A"]);
      setGitLinkEvidence(local.submod, releaseLinkRel, originalLinkTarget);
      git(local.submod, ["commit", "-q", "-m", "seed source link tree"]);
      assert.match(
        git(local.submod, ["ls-tree", "HEAD", "--", releaseLinkRel]),
        /^120000\s+blob\s+/
      );
      await fs.rm(releaseLink);
      await fs.writeFile(releaseLink, originalLinkTarget);
      const gitBackedPlainSource = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.equal(
        gitBackedPlainSource.exitCode,
        0,
        "a byte-exact source plain file backed by mode 120000 must remain discoverable"
      );
      assert.equal(
        await readLinkLikeTarget(
          path.join(local.tmpDir, ".agents", "skills", "devpro")
        ),
        originalLinkTarget
      );

      await fs.writeFile(releaseLink, `${originalLinkTarget}\r\n`);
      const transformedPlainSource = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.notEqual(transformedPlainSource.exitCode, 0);
      assert.match(transformedPlainSource.stderr, /plain checkout bytes differ from its Git 120000 blob/);
    }, { fullSubmod: true });
  });

});

describe("git check-ignore batch parser", () => {
  const expectedPaths = ["managed/a", "managed/b"];

  it("distinguishes an unescaped negation from a literal positive pattern", () => {
    const records = parseGitCheckIgnoreRecords({
      stdout: [
        ".gitignore", "1", "!/managed/a", "managed/a",
        ".gitignore", "2", "\\!managed-b", "managed/b", "",
      ].join("\0"),
      status: 0,
      expectedPaths,
    });
    assert.equal(records[0].isNegation, true);
    assert.equal(records[1].isNegation, false);
  });

  it("fails closed on missing, malformed, unknown, contradictory, or fault evidence", () => {
    assert.throws(
      () => parseGitCheckIgnoreRecords({ stdout: "", status: 0, expectedPaths }),
      /returned no records/
    );
    assert.throws(
      () => parseGitCheckIgnoreRecords({
        stdout: [".gitignore", "1", "!/managed/a", ""].join("\0"),
        status: 0,
        expectedPaths,
      }),
      /groups of 4/
    );
    assert.throws(
      () => parseGitCheckIgnoreRecords({
        stdout: [".gitignore", "1", "!/unknown", "unknown", ""].join("\0"),
        status: 0,
        expectedPaths,
      }),
      /unknown pathname/
    );
    const duplicate = [
      ".gitignore", "1", "!/managed/a", "managed/a",
      ".gitignore", "1", "!/managed/a", "managed/a", "",
    ].join("\0");
    assert.throws(
      () => parseGitCheckIgnoreRecords({ stdout: duplicate, status: 0, expectedPaths }),
      /contradictory duplicate/
    );
    assert.throws(
      () => parseGitCheckIgnoreRecords({ stdout: "", status: 2, expectedPaths }),
      /exited 2/
    );
    assert.deepEqual(
      parseGitCheckIgnoreRecords({ stdout: "", status: 1, expectedPaths }),
      []
    );
  });

  it("runs one all-path check-ignore batch in each sync and check pipeline", async () => {
    assert.equal(
      SYNC_STEPS.filter((step) => step.run === validateManagedSkillGitPersistence).length,
      1,
      "sync pipeline must invoke the shared persistence validator exactly once"
    );
    assert.equal(
      CHECK_STEPS.filter((step) => step.run === validateManagedSkillGitPersistence).length,
      1,
      "check pipeline must invoke the shared persistence validator exactly once"
    );

    const consumerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sync-batch-proof-"));
    const paths = ["managed/a", "managed/b", "managed/c"];
    try {
      for (const mode of ["sync", "check"]) {
        const calls = [];
        const gitPersistenceRunner = (_cwd, args, options = {}) => {
          calls.push({ args, input: options.input });
          if (args[0] === "rev-parse") {
            return { status: 0, stdout: `${consumerRoot}\n`, stderr: "" };
          }
          return { status: 1, stdout: "", stderr: "" };
        };
        await validateManagedSkillGitPersistence(consumerRoot, {
          managedSkillInventory: { outputs: paths.map((relPath) => ({ relPath })) },
          gitPersistenceRunner,
        });
        const batches = calls.filter(({ args }) => args[0] === "check-ignore");
        assert.equal(batches.length, 1, `${mode} must use one check-ignore process`);
        assert.deepEqual(
          batches[0].args,
          ["check-ignore", "-v", "-z", "--no-index", "--stdin"]
        );
        assert.equal(
          batches[0].input,
          `${paths.join("\0")}\0`,
          `${mode} must send every managed path in the same NUL-delimited batch`
        );
      }
    } finally {
      await fs.rm(consumerRoot, { recursive: true, force: true });
    }
  });

  it("allows missing Git only for a directory without Git control markers", async () => {
    const consumerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sync-missing-git-"));
    const gitPersistenceRunner = () => ({
      error: { code: "ENOENT", message: "spawnSync git ENOENT" },
    });
    const options = {
      managedSkillInventory: { outputs: [{ relPath: "managed/a" }] },
      gitPersistenceRunner,
    };
    try {
      await assert.doesNotReject(
        validateManagedSkillGitPersistence(consumerRoot, options),
        "a plain non-Git directory may retain filesystem-only compatibility"
      );
      await fs.mkdir(path.join(consumerRoot, ".git"));
      await assert.rejects(
        validateManagedSkillGitPersistence(consumerRoot, options),
        /Git persistence validator fault: spawnSync git ENOENT/,
        "a Git control marker must prevent silent downgrade to non-Git N/A"
      );
    } finally {
      await fs.rm(consumerRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Exec-bit preservation (issue #2486): sync must restore 100755 index mode
// for source-executable scripts so POSIX consumers run the pre-push deletion
// guard. Proves index-only restoration (independent of filesystem exec bit).
// ---------------------------------------------------------------------------
describe("--sync exec-bit preservation (issue #2486)", { concurrency: false }, () => {
  async function consumerExecMode(consumerRoot, relPath) {
    const staged = git(consumerRoot, ["ls-files", "--stage", "--", relPath]).trim();
    const match = staged.match(/^(\d{6})\s+([0-9a-f]+)\s+\d+\t(.+)$/);
    assert.ok(match, `expected a staged entry for ${relPath}, got: ${staged || "(empty)"}`);
    assert.equal(match[3], relPath);
    return match[1];
  }

  it("restores 100755 index mode and 0o755 working-tree mode for a source-executable file", async () => {
    await withConsumerRepo(async (ctx) => {
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: ctx.tmpDir, encoding: "utf8" });
      const result = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(
        await consumerExecMode(ctx.tmpDir, ".devpro/scripts/hooks-git/pre-push"),
        "100755",
        "source 100755 scripts must be restored to 100755 in the consumer index"
      );
      if (process.platform !== "win32") {
        const stat = await fs.stat(path.join(ctx.tmpDir, ".devpro/scripts/hooks-git/pre-push"));
        assert.equal(
          stat.mode & 0o111,
          0o111,
          "source 100755 scripts must be executable in the working tree (git runs hooks from the working-tree bit)"
        );
      }
    });
  });

  it("does not set 100755 for a source non-executable script", async () => {
    await withConsumerRepo(async (ctx) => {
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: ctx.tmpDir, encoding: "utf8" });
      const result = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir });
      assert.equal(result.exitCode, 0, result.stderr);
      const staged = git(ctx.tmpDir, ["ls-files", "--stage", "--", ".devpro/scripts/capture-command.mjs"]).trim();
      assert.doesNotMatch(
        staged,
        /^100755\s/,
        "non-executable source scripts must not be marked 100755"
      );
    });
  });

  it("survives a subsequent git add -A under core.fileMode=false (mode not wiped)", async () => {
    await withConsumerRepo(async (ctx) => {
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: ctx.tmpDir, encoding: "utf8" });
      spawnSync("git", ["config", "core.fileMode", "false"], { cwd: ctx.tmpDir, encoding: "utf8" });
      const result = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir });
      assert.equal(result.exitCode, 0, result.stderr);
      const addResult = spawnSync("git", ["add", "-A"], { cwd: ctx.tmpDir, encoding: "utf8" });
      assert.equal(addResult.status, 0, addResult.stderr);
      assert.equal(
        await consumerExecMode(ctx.tmpDir, ".devpro/scripts/hooks-git/pre-push"),
        "100755",
        "100755 must survive the rules-lane git add -A even under core.fileMode=false"
      );
    });
  });

  it("warns that a consumer-local 100755 extra is not sync drift (source does not track it)", async () => {
    await withConsumerRepo(async (ctx) => {
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: ctx.tmpDir, encoding: "utf8" });
      const extraRel = ".devpro/scripts/consumer-local-exec.sh";
      const extraPath = path.join(ctx.tmpDir, ...extraRel.split("/"));
      await fs.mkdir(path.dirname(extraPath), { recursive: true });
      await fs.writeFile(extraPath, "#!/bin/sh\necho hi\n");
      if (process.platform !== "win32") await fs.chmod(extraPath, 0o755);
      spawnSync("git", ["add", "-A"], { cwd: ctx.tmpDir, encoding: "utf8" });
      spawnSync("git", ["update-index", "--chmod=+x", "--", extraRel], { cwd: ctx.tmpDir, encoding: "utf8" });
      const result = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(
        result.stderr,
        /consumer-local/,
        "a synced consumer 100755 path the source does not track must be named consumer-local"
      );
      assert.doesNotMatch(
        result.stderr,
        /Run --sync to restore index mode/,
        "consumer-local extras must not be told to run --sync"
      );
    });
  });

  it("warns bidirectionally when a source-tracked path is 100755 in the consumer but not in the source", async () => {
    await withConsumerRepo(async (ctx) => {
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: ctx.tmpDir, encoding: "utf8" });
      const result = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir });
      assert.equal(result.exitCode, 0, result.stderr);
      // Source tracks this path, but as 100644 — a source-tracked extra stays drift.
      const extraRel = ".devpro/scripts/sync-agent-rules.mjs";
      spawnSync("git", ["update-index", "--add", "--chmod=+x", "--", extraRel], {
        cwd: ctx.tmpDir,
        encoding: "utf8",
      });
      const warnResult = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir });
      assert.equal(warnResult.exitCode, 0, warnResult.stderr);
      assert.match(
        warnResult.stderr,
        /tracked by the source but not marked 100755 there/,
        "a source-tracked consumer 100755 extra must be reported as sync drift"
      );
      assert.doesNotMatch(warnResult.stderr, /consumer-local/);
    });
  });
});


describe("startup symlink capability repair followed by real sync", () => {
  it("upgrades both matching plain checkouts without changing their tracked link topology", async () => {
    await withSlimManagedSkillSource(async (slim) => withConsumerRepo(async (local) => {
      git(local.tmpDir, ["init", "-q", "-b", "main"]);
      git(local.tmpDir, ["config", "core.symlinks", "false"]);
      for (const rel of slim.discoveryRels) {
        const node = path.join(local.tmpDir, ...rel.split("/"));
        await fs.mkdir(path.dirname(node), { recursive: true });
        setGitLinkEvidence(local.tmpDir, rel, slim.discoveryTarget);
        await fs.writeFile(node, slim.discoveryTarget);
      }
      const repaired = ensureCoreSymlinks({ cwd: local.tmpDir });
      assert.equal(repaired.outcome, "repaired", repaired.detail);
      assert.equal(git(local.tmpDir, ["config", "--get", "core.symlinks"]).trim(), "true");
      const sync = run(local.syncScript, "--sync", { cwd: local.tmpDir, testSourceRoot: slim.sourceRoot });
      assert.equal(sync.exitCode, 0, sync.stderr);
      for (const rel of slim.discoveryRels) {
        const node = path.join(local.tmpDir, ...rel.split("/"));
        assert.equal((await fs.lstat(node)).isSymbolicLink(), true);
        assert.equal(await fs.realpath(node), await fs.realpath(path.join(local.tmpDir, ".devpro/agent-skills")));
        assert.match(await fs.readFile(path.join(node, "release/release-runbook/SKILL.md"), "utf8"), /Release runbook/);
      }
      git(local.tmpDir, ["add", "-A"]);
      for (const rel of slim.discoveryRels) {
        assert.equal(await readGitLinkTarget(local.tmpDir, rel), slim.discoveryTarget);
      }
      const check = run(local.syncScript, "--check", { cwd: local.tmpDir, testSourceRoot: slim.sourceRoot });
      assert.equal(check.exitCode, 0, check.stderr);
      assert.doesNotMatch(check.stderr, /managed-skill-discovery-degraded/);
      assert.deepEqual((await fs.readdir(local.tmpDir)).filter((name) => name.startsWith(".devpro-symlink-probe-")), []);
    }));
  });
});
