// New test file (T3, change refactor-agent-skills-entry, Commit B): design
// D5-D9's legacy-skill-entry classification, exit-30 residue checks, and the
// entry-install transaction (precheck / idempotent-skip / rollback). Put in
// its own file rather than an existing one: an import error for the (at the
// time of writing, brand-new) `legacy-skill-entry-artifacts.mjs` module would
// have cancelled every case in a shared file (`cancelledByParent`), the same
// failure mode already observed and fixed for
// `sync-agent-rules-check.test.mjs` earlier in this change (missing refs
// manifest fixture cancelling all 45 subtests).
//
// Covers the 8 design-gate cases (a)-(h) listed in tasks.md T3, labeled
// (a)-(h) inline at their assertions:
//   (a) consumer self-built legacy link pointing elsewhere in the catalog
//   (b) semantically-equivalent-but-different literal
//   (c) trailing-slash literal
//   (d) symlink-form payload
//   (e) payload ancestor replaced by symlink
//   (f) precheck conflict before any entry is created
//   (g) precheck passes, then the second entry's install fails — rollback
//   (h) idempotent-skip on re-sync

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  classifyLegacySkillEntryLink,
  classifyLegacySkillPayloadFile,
  LEGACY_SKILL_ENTRY_LINKS,
  LEGACY_SKILL_PAYLOAD_FILES,
} from "../lib/legacy-skill-entry-artifacts.mjs";
import {
  repoRoot,
  createConsumerRepo,
  withConsumerRepo,
  withSlimSyncSource,
  run,
  withEnv,
  fixtureGitEnv,
  SKILL_TARGET_ROOT,
  TEST_SYNC_SOURCE_ROOT_ENV,
} from "./lib/sync-agent-rules-harness.mjs";
// design D6/D7/D8 scenario-assertion binding (T9): these two are
// called in-process (not via the CLI-spawn `run()` helper above) precisely
// so the tests below can inspect the thrown SkillEntryBlockedError's own
// `.reason`/`.exitCode` fields — the CLI catch in sync-agent-rules.mjs only
// ever prints `error.message` and `error.manualSteps`, never the `reason`
// token itself, so asserting the named reason honestly requires the direct
// import, not a stderr substring search.
import {
  runSync,
  runCheck,
  rollbackCreatedSkillEntries,
  LEGACY_CURSOR_SKILL_DISCOVERY_ARTIFACTS,
} from "../sync-agent-rules.mjs";

async function createPortableTestSymlink(linkTarget, targetPath, kind = "directory") {
  if (process.platform === "win32") {
    await fs.symlink(linkTarget, targetPath, kind === "directory" ? "dir" : "file");
    return;
  }
  await fs.symlink(linkTarget, targetPath);
}

async function withTempConsumerRoot(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-skill-entry-"));
  try {
    return await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** Fetch the real historical bytes for a frozen LEGACY_SKILL_PAYLOAD_FILES
 * blob id from this checkout's own Git object store (worktrees share the
 * object database with the main checkout, so these historical blobs — read
 * once, off-line, to freeze `legacy-skill-entry-artifacts.mjs` — remain
 * reachable here). Used to build a byte-exact "owned" fixture without
 * inventing content that could never actually match a frozen blob id. */
function readLegacyBlobBytes(blobId) {
  const result = spawnSync("git", ["cat-file", "-p", blobId], { cwd: repoRoot, encoding: null });
  assert.equal(result.status, 0, `git cat-file -p ${blobId} must succeed in this checkout's object store`);
  return result.stdout;
}

/** Batch form of readLegacyBlobBytes(): one `git cat-file --batch` spawn for
 * the whole frozen payload allowlist instead of one spawn per blob. */
function readLegacyBlobBytesBatch(blobIds) {
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    input: `${blobIds.join("\n")}\n`,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, "git cat-file --batch must succeed in this checkout's object store");
  const out = result.stdout;
  const bytes = new Map();
  let offset = 0;
  for (const blobId of blobIds) {
    const headerEnd = out.indexOf(0x0a, offset);
    const [oid, type, size] = out.subarray(offset, headerEnd).toString("utf8").split(" ");
    assert.equal(type, "blob", `frozen blob ${blobId} must be present (got: ${oid} ${type})`);
    const start = headerEnd + 1;
    bytes.set(blobId, out.subarray(start, start + Number(size)));
    offset = start + Number(size) + 1;
  }
  return bytes;
}

// legacy-skill-names:begin legacy-entry-link-payload-classification
const LINK_ENTRY = LEGACY_SKILL_ENTRY_LINKS.find((entry) => entry.path === ".agents/skills/dp-change");
assert.ok(LINK_ENTRY, "fixture precondition: .agents/skills/dp-change must be a frozen legacy entry link");
const SHIPPED_TARGET = LINK_ENTRY.shippedTargets[0];

const PAYLOAD_ENTRY = LEGACY_SKILL_PAYLOAD_FILES.find(
  (entry) => entry.path === ".devpro/agent-skills/devpro-workflows/dp-init/SKILL.md"
);
assert.ok(PAYLOAD_ENTRY, "fixture precondition: dp-init/SKILL.md must be a frozen legacy payload file");

// Windows stores a relative link target with backslashes even when it was created with
// forward slashes, so compare targets in one separator form.
const readLinkTarget = async (linkPath) => (await fs.readlink(linkPath)).split(path.sep).join("/");

describe("classifyLegacySkillEntryLink (design D5)", () => {
  it("returns absent when nothing exists at the path", async () => {
    await withTempConsumerRoot(async (root) => {
      assert.equal(await classifyLegacySkillEntryLink(root, LINK_ENTRY.path), "absent");
    });
  });

  it("returns owned for a literal, byte-exact shipped target (including when dangling)", async () => {
    await withTempConsumerRoot(async (root) => {
      const linkPath = path.join(root, ...LINK_ENTRY.path.split("/"));
      await fs.mkdir(path.dirname(linkPath), { recursive: true });
      await createPortableTestSymlink(SHIPPED_TARGET, linkPath);
      assert.equal(await classifyLegacySkillEntryLink(root, LINK_ENTRY.path), "owned");
      // D5 item 6: dangling links still classify by literal, not by whether
      // the target resolves — the shipped target here never exists in this
      // bare temp root, and the classification above already proves it.
    });
  });

  // (a) consumer self-built legacy link pointing elsewhere in the catalog:
  // same basename as the shipped literal, but a different catalog location.
  it("(a) returns not-owned for a consumer-built link pointing elsewhere in the catalog", async () => {
    await withTempConsumerRoot(async (root) => {
      const linkPath = path.join(root, ...LINK_ENTRY.path.split("/"));
      await fs.mkdir(path.dirname(linkPath), { recursive: true });
      await createPortableTestSymlink("../../.devpro/agent-skills/custom/dp-change", linkPath);
      assert.equal(await classifyLegacySkillEntryLink(root, LINK_ENTRY.path), "not-owned");
    });
  });

  // (b) semantically-equivalent-but-different literal: resolves to the same
  // place as SHIPPED_TARGET, but the literal bytes differ (extra "./").
  it("(b) returns not-owned for a semantically-equivalent-but-different literal", async () => {
    await withTempConsumerRoot(async (root) => {
      const linkPath = path.join(root, ...LINK_ENTRY.path.split("/"));
      await fs.mkdir(path.dirname(linkPath), { recursive: true });
      await createPortableTestSymlink(`./${SHIPPED_TARGET}`, linkPath);
      assert.equal(await classifyLegacySkillEntryLink(root, LINK_ENTRY.path), "not-owned");
    });
  });

  // (c) trailing-slash literal: same path, one extra trailing "/".
  it("(c) returns not-owned for a trailing-slash literal", async () => {
    await withTempConsumerRoot(async (root) => {
      const linkPath = path.join(root, ...LINK_ENTRY.path.split("/"));
      await fs.mkdir(path.dirname(linkPath), { recursive: true });
      await createPortableTestSymlink(`${SHIPPED_TARGET}/`, linkPath);
      assert.equal(await classifyLegacySkillEntryLink(root, LINK_ENTRY.path), "not-owned");
    });
  });

  // F-rase-pr-r1-01: absolute (junction-style) form of the shipped target.
  it("returns not-owned for an absolute-path form of the shipped target", async () => {
    await withTempConsumerRoot(async (root) => {
      const linkPath = path.join(root, ...LINK_ENTRY.path.split("/"));
      await fs.mkdir(path.dirname(linkPath), { recursive: true });
      await createPortableTestSymlink(path.resolve(path.dirname(linkPath), SHIPPED_TARGET), linkPath);
      assert.equal(await classifyLegacySkillEntryLink(root, LINK_ENTRY.path), "not-owned");
    });
  });

  // F-rase-pr-r1-01: prefer-plain checkout — a plain file whose bytes equal the
  // index's 120000 blob is the shipped link; without that record it is not.
  it("returns owned for a prefer-plain file backed by a matching 120000 index record, not-owned without it", async () => {
    await withTempConsumerRoot(async (root) => {
      await withFixtureGitEnv(root, async () => {
        const git = (args, input) => {
          const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", input });
          assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
          return result.stdout.trim();
        };
        git(["init", "-q"]);
        const linkPath = path.join(root, ...LINK_ENTRY.path.split("/"));
        await fs.mkdir(path.dirname(linkPath), { recursive: true });
        await fs.writeFile(linkPath, SHIPPED_TARGET);
        assert.equal(await classifyLegacySkillEntryLink(root, LINK_ENTRY.path), "not-owned");

        const oid = git(["hash-object", "-w", "--stdin"], SHIPPED_TARGET);
        git(["update-index", "--add", "--cacheinfo", `120000,${oid},${LINK_ENTRY.path}`]);
        assert.equal(await classifyLegacySkillEntryLink(root, LINK_ENTRY.path), "owned");
      });
    });
  });

  it("returns not-owned when an ancestor segment has been replaced by a symlink", async () => {
    await withTempConsumerRoot(async (root) => {
      const realElsewhere = path.join(root, "elsewhere");
      await fs.mkdir(realElsewhere, { recursive: true });
      await fs.mkdir(path.join(root, ".agents"), { recursive: true });
      await createPortableTestSymlink(path.join(root, "elsewhere"), path.join(root, ".agents", "skills"));
      // .agents/skills is now a symlink, not a real directory — the ancestor
      // chain to .agents/skills/dp-change is unsafe regardless of what (if
      // anything) sits at the final segment.
      assert.equal(await classifyLegacySkillEntryLink(root, LINK_ENTRY.path), "not-owned");
    });
  });
});

describe("classifyLegacySkillPayloadFile (design D5)", () => {
  it("returns absent when nothing exists at the path", async () => {
    await withTempConsumerRoot(async (root) => {
      assert.equal(await classifyLegacySkillPayloadFile(root, PAYLOAD_ENTRY.path), "absent");
    });
  });

  it("returns owned for byte-exact devpro-shipped content (and tolerates CRLF)", async () => {
    const shippedBytes = readLegacyBlobBytes(PAYLOAD_ENTRY.blobIds[0]);
    await withTempConsumerRoot(async (root) => {
      const filePath = path.join(root, ...PAYLOAD_ENTRY.path.split("/"));
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, shippedBytes);
      assert.equal(await classifyLegacySkillPayloadFile(root, PAYLOAD_ENTRY.path), "owned");

      const crlfBytes = Buffer.from(shippedBytes.toString("binary").replace(/\n/g, "\r\n"), "binary");
      await fs.writeFile(filePath, crlfBytes);
      assert.equal(
        await classifyLegacySkillPayloadFile(root, PAYLOAD_ENTRY.path),
        "owned",
        "CRLF-normalized bytes must still match the frozen blob id (Windows autocrlf tolerance)"
      );
    });
  });

  it("returns modified for consumer-edited content at a shipped path", async () => {
    await withTempConsumerRoot(async (root) => {
      const filePath = path.join(root, ...PAYLOAD_ENTRY.path.split("/"));
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "consumer edited this shipped file\n");
      assert.equal(await classifyLegacySkillPayloadFile(root, PAYLOAD_ENTRY.path), "modified");
    });
  });

  // (d) symlink-form payload: the reserved legacy path is a symlink, not a
  // regular file — must never be followed or hashed, regardless of target.
  it("(d) returns not-owned for a symlink at the payload path (never followed)", async () => {
    const shippedBytes = readLegacyBlobBytes(PAYLOAD_ENTRY.blobIds[0]);
    await withTempConsumerRoot(async (root) => {
      const realFile = path.join(root, "real-shipped-copy.md");
      await fs.writeFile(realFile, shippedBytes);
      const filePath = path.join(root, ...PAYLOAD_ENTRY.path.split("/"));
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await createPortableTestSymlink(realFile, filePath, "file");
      assert.equal(
        await classifyLegacySkillPayloadFile(root, PAYLOAD_ENTRY.path),
        "not-owned",
        "a symlink must classify not-owned even when its target's bytes are byte-exact shipped content"
      );
    });
  });

  // (e) payload ancestor replaced by symlink: an intermediate directory
  // segment on the path to the payload file is a symlink, not a real dir.
  it("(e) returns not-owned when a payload ancestor directory has been replaced by a symlink", async () => {
    const shippedBytes = readLegacyBlobBytes(PAYLOAD_ENTRY.blobIds[0]);
    await withTempConsumerRoot(async (root) => {
      const elsewhere = path.join(root, "elsewhere-payload-dir");
      await fs.mkdir(elsewhere, { recursive: true });
      await fs.writeFile(path.join(elsewhere, "SKILL.md"), shippedBytes);

      await fs.mkdir(path.join(root, ".devpro", "agent-skills", "devpro-workflows"), { recursive: true });
      await createPortableTestSymlink(
        elsewhere,
        path.join(root, ".devpro", "agent-skills", "devpro-workflows", "dp-init")
      );
      assert.equal(
        await classifyLegacySkillPayloadFile(root, PAYLOAD_ENTRY.path),
        "not-owned",
        "an ancestor symlink must fail closed to not-owned without inspecting the final node"
      );
    });
  });
});
// legacy-skill-names:end legacy-entry-link-payload-classification

describe("entry-install transaction (design D8)", () => {
  // (f) precheck conflict before any entry is created: BOTH discovery paths
  // are precheck'd before either is installed, so a conflict at the SECOND
  // path (alphabetically: .claude/skills/devpro) must block the FIRST
  // (.agents/skills/devpro) from ever being created.
  it("(f) refuses to install any entry when a precheck conflict exists at another entry's path", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withConsumerRepo(async (ctx) => {
        const collisionDir = path.join(ctx.tmpDir, ".claude", "skills", "devpro");
        await fs.mkdir(collisionDir, { recursive: true });
        const ownedFile = path.join(collisionDir, "consumer-owned.md");
        await fs.writeFile(ownedFile, "do not delete me");

        const { exitCode, stderr } = run(ctx.syncScript, "--sync", {
          cwd: ctx.tmpDir,
          testSourceRoot: slimSourceRoot,
        });
        assert.equal(exitCode, 30, `precheck conflict must exit 30 (SkillEntryBlockedError); stderr=${stderr}`);
        assert.match(stderr, /devpro/);

        const agentsEntry = await fs.lstat(path.join(ctx.tmpDir, ".agents", "skills", "devpro")).catch(() => null);
        assert.equal(
          agentsEntry,
          null,
          "no entry may be created anywhere once precheck finds a conflict at any entry's path"
        );
        const survived = await fs.readFile(ownedFile, "utf8");
        assert.equal(survived, "do not delete me", "the pre-existing conflict content must be untouched");
      });
    });
  });

  // (g) precheck passes for both entries, then the SECOND entry's actual
  // creation fails with a non-fallback error (EIO — EPERM/EACCES/ENOSYS are
  // the "prefer-plain" degrade lane, not the rollback lane). The FIRST
  // entry, already created this run, must be rolled back.
  it("(g) rolls back the first-created entry when the second entry's install fails (non-fallback error)", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withConsumerRepo(async (ctx) => {
        const preloadPath = path.join(ctx.tmpDir, "force-second-entry-eio.mjs");
        await fs.writeFile(
          preloadPath,
          [
            'import { promises as fs } from "node:fs";',
            "const realSymlink = fs.symlink.bind(fs);",
            "fs.symlink = async (target, nodePath, ...args) => {",
            '  const normalized = String(nodePath).replaceAll("\\\\", "/");',
            '  if (/\\/\\.claude\\/skills\\//.test(normalized)) {',
            '    const error = new Error("forced non-fallback discovery symlink fault");',
            '    error.code = "EIO";',
            "    throw error;",
            "  }",
            "  return realSymlink(target, nodePath, ...args);",
            "};",
            "",
          ].join("\n")
        );

        const { exitCode, stderr } = run(ctx.syncScript, "--sync", {
          cwd: ctx.tmpDir,
          testSourceRoot: slimSourceRoot,
          env: {
            NODE_OPTIONS: [
              process.env.NODE_OPTIONS,
              `--import=${pathToFileURL(preloadPath).href}`,
            ].filter(Boolean).join(" "),
          },
        });
        assert.equal(exitCode, 30, `second-entry install fault must exit 30; stderr=${stderr}`);
        assert.match(stderr, /\.claude\/skills\/devpro/);

        const agentsEntry = await fs.lstat(path.join(ctx.tmpDir, ".agents", "skills", "devpro")).catch(() => null);
        assert.equal(
          agentsEntry,
          null,
          "the first entry created this run must be rolled back once the second entry's install fails"
        );
        const claudeEntry = await fs.lstat(path.join(ctx.tmpDir, ".claude", "skills", "devpro")).catch(() => null);
        assert.equal(claudeEntry, null, "the second entry must never have been left half-installed");
      });
    });
  });

  // (g, literal case) design D8 item 4 names representative EPERM. EPERM is
  // itself a fallback code, so on a Git consumer root it degrades to a
  // plain-file link instead of failing — but on a non-Git consumer root
  // (the default withConsumerRepo fixture: no git init), the fallback
  // path's own Git-symlink-evidence plumbing throws its OWN error before
  // any fallback write happens. That failure must still roll back the
  // first-created entry and surface as exit 30, exactly like (g)'s EIO case.
  it("(g, EPERM) rolls back the first-created entry when the second entry's EPERM fallback plumbing itself fails on a non-Git root", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withConsumerRepo(async (ctx) => {
        const preloadPath = path.join(ctx.tmpDir, "force-second-entry-eperm.mjs");
        await fs.writeFile(
          preloadPath,
          [
            'import { promises as fs } from "node:fs";',
            "const realSymlink = fs.symlink.bind(fs);",
            "fs.symlink = async (target, nodePath, ...args) => {",
            '  const normalized = String(nodePath).replaceAll("\\\\", "/");',
            '  if (/\\/\\.claude\\/skills\\//.test(normalized)) {',
            '    const error = new Error("forced representative EPERM discovery symlink fault");',
            '    error.code = "EPERM";',
            "    throw error;",
            "  }",
            "  return realSymlink(target, nodePath, ...args);",
            "};",
            "",
          ].join("\n")
        );

        // withConsumerRepo's default fixture never runs `git init` on
        // ctx.tmpDir — the fallback path's createMissingGitSymlinkBlob()
        // must fault with "Git symlink evidence fault" on this non-Git root.
        const { exitCode, stderr } = run(ctx.syncScript, "--sync", {
          cwd: ctx.tmpDir,
          testSourceRoot: slimSourceRoot,
          env: {
            NODE_OPTIONS: [
              process.env.NODE_OPTIONS,
              `--import=${pathToFileURL(preloadPath).href}`,
            ].filter(Boolean).join(" "),
          },
        });
        assert.equal(exitCode, 30, `EPERM fallback-plumbing fault on a non-Git root must exit 30; stderr=${stderr}`);
        assert.match(stderr, /Git symlink evidence fault/);

        const agentsEntry = await fs.lstat(path.join(ctx.tmpDir, ".agents", "skills", "devpro")).catch(() => null);
        assert.equal(
          agentsEntry,
          null,
          "the first entry created this run must be rolled back even when the second entry's failure comes from the Git-evidence fallback plumbing, not the symlink call itself"
        );
      });
    });
  });

  // PR #2886 cross-model WARN: on a Git consumer root the EPERM fallback
  // stages a 120000 index entry before writing the plain file. When that
  // write fails, --sync must still leave no staged entry and no file. A real
  // write fault usually strikes after the file is created or truncated, so
  // the second case writes an empty file before throwing.
  for (const { label, partialWrite } of [
    { label: "before the file exists", partialWrite: false },
    { label: "after leaving an empty file", partialWrite: true },
  ]) {
    it(`(g, EPERM on Git) unstages the fallback index entry when the plain-file write fails ${label}`, async () => {
      await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
        await withConsumerRepo(async (ctx) => {
          const init = spawnSync("git", ["init", "-q"], {
            cwd: ctx.tmpDir,
            encoding: "utf8",
            env: fixtureGitEnv(ctx.tmpDir),
          });
          assert.equal(init.status, 0, `git init: ${init.stderr}`);
          const preloadPath = path.join(ctx.tmpDir, "force-claude-fallback-write-fault.mjs");
          await fs.writeFile(
            preloadPath,
            [
              'import { promises as fs } from "node:fs";',
              "const realSymlink = fs.symlink.bind(fs);",
              "const realWriteFile = fs.writeFile.bind(fs);",
              "const isClaudeEntry = (p) => /\\/\\.claude\\/skills\\/devpro$/.test(String(p).replaceAll(\"\\\\\", \"/\"));",
              "fs.symlink = async (target, nodePath, ...args) => {",
              "  if (isClaudeEntry(nodePath)) {",
              '    const error = new Error("forced EPERM discovery symlink fault");',
              '    error.code = "EPERM";',
              "    throw error;",
              "  }",
              "  return realSymlink(target, nodePath, ...args);",
              "};",
              "fs.writeFile = async (filePath, ...args) => {",
              "  if (isClaudeEntry(filePath)) {",
              ...(partialWrite ? ["    await realWriteFile(filePath, Buffer.alloc(0));"] : []),
              '    const error = new Error("forced fallback plain-file write fault");',
              '    error.code = "EIO";',
              "    throw error;",
              "  }",
              "  return realWriteFile(filePath, ...args);",
              "};",
              "",
            ].join("\n")
          );

          const { exitCode, stderr } = run(ctx.syncScript, "--sync", {
            cwd: ctx.tmpDir,
            testSourceRoot: slimSourceRoot,
            env: {
              NODE_OPTIONS: [
                process.env.NODE_OPTIONS,
                `--import=${pathToFileURL(preloadPath).href}`,
              ].filter(Boolean).join(" "),
            },
          });
          assert.equal(exitCode, 30, `fallback write fault must exit 30; stderr=${stderr}`);
          assert.match(stderr, /forced fallback plain-file write fault/);
          assert.match(stderr, /reason: legacy-skill-entry-residue/);
          assert.doesNotMatch(stderr, /rollback failed/, "a missing or partial fallback file is not a rollback failure");

          const staged = spawnSync("git", ["ls-files", "--stage", "--", ".claude/skills/devpro"], {
            cwd: ctx.tmpDir,
            encoding: "utf8",
            env: fixtureGitEnv(ctx.tmpDir),
          });
          assert.equal(staged.status, 0, staged.stderr);
          assert.equal(staged.stdout, "", "the 120000 entry staged by the fallback must be removed on rollback");
          const claudeEntry = await fs.lstat(path.join(ctx.tmpDir, ".claude", "skills", "devpro")).catch(() => null);
          assert.equal(claudeEntry, null, "no .claude entry may remain in the worktree");
          const agentsEntry = await fs.lstat(path.join(ctx.tmpDir, ".agents", "skills", "devpro")).catch(() => null);
          assert.equal(agentsEntry, null, "the first entry created this run must be rolled back");
        });
      });
    });
  }

  // (h) idempotent-skip on re-sync: once both entries exist correctly, a
  // later --sync must not unlink+recreate them (proven by identical inode
  // numbers before and after, not merely "still correct").
  it("(h) does not recreate already-correct entries on a later --sync (idempotent-skip)", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withConsumerRepo(async (ctx) => {
        const first = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(first.exitCode, 0, first.stderr);

        const agentsPath = path.join(ctx.tmpDir, ".agents", "skills", "devpro");
        const claudePath = path.join(ctx.tmpDir, ".claude", "skills", "devpro");
        const agentsBefore = await fs.lstat(agentsPath);
        const claudeBefore = await fs.lstat(claudePath);
        assert.equal(agentsBefore.isSymbolicLink(), true);
        assert.equal(claudeBefore.isSymbolicLink(), true);

        const second = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(second.exitCode, 0, second.stderr);

        const agentsAfter = await fs.lstat(agentsPath);
        const claudeAfter = await fs.lstat(claudePath);
        assert.equal(agentsAfter.isSymbolicLink(), true);
        assert.equal(claudeAfter.isSymbolicLink(), true);
        assert.equal(
          agentsAfter.ino,
          agentsBefore.ino,
          "an already-correct entry must not be unlinked+recreated on a later --sync"
        );
        assert.equal(
          claudeAfter.ino,
          claudeBefore.ino,
          "an already-correct entry must not be unlinked+recreated on a later --sync"
        );
      });
    });
  });
});

// legacy-skill-names:begin legacy-entry-residue-check-fixtures
describe("exit-30 residue checks (design D6/D7)", () => {
  it("checkLegacySkillEntryResidue reports an owned legacy per-skill link and --sync clears it", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withConsumerRepo(async (ctx) => {
        const seed = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(seed.exitCode, 0, seed.stderr);

        const legacyLinkPath = path.join(ctx.tmpDir, ...LINK_ENTRY.path.split("/"));
        await fs.mkdir(path.dirname(legacyLinkPath), { recursive: true });
        await createPortableTestSymlink(SHIPPED_TARGET, legacyLinkPath);

        const check = run(ctx.syncScript, "--check", { cwd: ctx.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(check.exitCode, 30, `owned legacy link residue must exit 30; stderr=${check.stderr}`);
        assert.match(check.stderr, /legacy skill entry residue present/);
        // T9 CLI reason finding: the CLI must print the named reason token on
        // stderr, not just the human-readable message — an operator
        // running --check should see `legacy-skill-entry-residue` by name.
        assert.match(check.stderr, /reason: legacy-skill-entry-residue/);
        assert.match(
          check.stderr,
          new RegExp(LINK_ENTRY.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          "manualSteps must now be printed (main()'s catch prints each error.manualSteps entry), naming the residue path"
        );
        assert.match(
          check.stderr,
          /Run --sync to remove it/,
          "an owned legacy link's manual step must use the owned wording"
        );

        const resync = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(resync.exitCode, 0, resync.stderr);
        const stillThere = await fs.lstat(legacyLinkPath).catch(() => null);
        assert.equal(stillThere, null, "--sync must prune the owned legacy link");

        const recheck = run(ctx.syncScript, "--check", { cwd: ctx.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(recheck.exitCode, 0, recheck.stderr);
      });
    });
  });

  it("checkLegacySkillEntryResidue keeps a not-owned collision at a reserved legacy name and warns, not deletes", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withConsumerRepo(async (ctx) => {
        const seed = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(seed.exitCode, 0, seed.stderr);

        const legacyLinkPath = path.join(ctx.tmpDir, ...LINK_ENTRY.path.split("/"));
        await fs.mkdir(path.dirname(legacyLinkPath), { recursive: true });
        await createPortableTestSymlink("../../.devpro/agent-skills/custom/dp-change", legacyLinkPath);

        const check = run(ctx.syncScript, "--check", { cwd: ctx.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(check.exitCode, 30, check.stderr);
        assert.match(
          check.stderr,
          /rename it away/,
          "a not-owned collision's manual step must use the not-owned wording, distinct from the owned case"
        );
        assert.doesNotMatch(
          check.stderr,
          /Run --sync to remove it/,
          "a not-owned collision must never get the owned-case wording"
        );

        const resync = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(resync.exitCode, 0, resync.stderr);
        assert.match(
          resync.stderr,
          new RegExp(`Keeping ${LINK_ENTRY.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
          "pruneLegacySkillEntryLinks must warn-and-keep a not-owned collision by name on --sync, not silently skip it"
        );
        const stats = await fs.lstat(legacyLinkPath).catch(() => null);
        assert.equal(
          stats?.isSymbolicLink(),
          true,
          "a not-owned collision at a reserved legacy name must survive --sync untouched"
        );
        assert.equal(await readLinkTarget(legacyLinkPath), "../../.devpro/agent-skills/custom/dp-change");
      });
    });
  });
});
// legacy-skill-names:end legacy-entry-residue-check-fixtures

// ---------------------------------------------------------------------------
// T9 delta-scenario binding (refactor-agent-skills-entry): the ten
// ADDED-scenario titles the OpenSpec delta lint flagged as unasserted.
// `runSyncInProcess`/`runCheckInProcess` call the real runSync()/runCheck()
// pipelines in-process (not via the CLI-spawn `run()` helper above)
// precisely so the tests below can inspect a thrown SkillEntryBlockedError's
// own `.reason`/`.exitCode` fields directly — the CLI catch in
// sync-agent-rules.mjs only ever prints `error.message` and
// `error.manualSteps`, never the `reason` token itself, so asserting the
// named reason honestly requires the direct import, not a stderr substring
// search. Console output is captured into ONE ordered array (both
// console.log and console.warn — unlike the harness's own captureConsole,
// which only intercepts log/error) so relative ordering between an
// install-side log line and a prune-side warn line is itself assertable
// (ordinary separate-stream CLI capture cannot interleave stdout/stderr).
// Git env is isolated the same way sync-agent-rules-check.test.mjs's
// withFixtureGitEnv does, so an in-process run never reads host git config.
function captureOrderedConsole(fn) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const lines = [];
  console.log = (...args) => { lines.push(args.join(" ")); };
  console.warn = (...args) => { lines.push(args.join(" ")); };
  return (async () => {
    try {
      return await fn();
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }
  })().then(
    (value) => ({ value, lines }),
    (error) => {
      error.consoleLines = lines;
      throw error;
    }
  );
}

async function withFixtureGitEnv(cwd, fn) {
  const previous = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_")) {
      previous[key] = process.env[key];
      delete process.env[key];
    }
  }
  const env = fixtureGitEnv(cwd);
  try {
    return await withEnv(
      Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("GIT_"))),
      fn
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function runSyncInProcess(consumerRoot, sourceRoot) {
  return withFixtureGitEnv(consumerRoot, () =>
    withEnv({ [TEST_SYNC_SOURCE_ROOT_ENV]: sourceRoot }, () => captureOrderedConsole(() => runSync(consumerRoot)))
  );
}

async function runCheckInProcess(consumerRoot, sourceRoot) {
  return withFixtureGitEnv(consumerRoot, () =>
    withEnv({ [TEST_SYNC_SOURCE_ROOT_ENV]: sourceRoot }, () => captureOrderedConsole(() => runCheck(consumerRoot)))
  );
}

describe("T9 delta-scenario binding", () => {
  it("Scenario: Owned legacy links and payload are pruned after the entries install", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withTempConsumerRoot(async (root) => {
        // GIVEN a consumer synced from a pre-rename release: seed the owned
        // legacy per-skill link and its owned legacy payload file BEFORE
        // this consumer has ever run --sync against the current (2-entry)
        // source.
        const legacyLinkPath = path.join(root, ...LINK_ENTRY.path.split("/"));
        await fs.mkdir(path.dirname(legacyLinkPath), { recursive: true });
        await createPortableTestSymlink(SHIPPED_TARGET, legacyLinkPath);

        const shippedPayloadBytes = readLegacyBlobBytes(PAYLOAD_ENTRY.blobIds[0]);
        const legacyPayloadPath = path.join(root, ...PAYLOAD_ENTRY.path.split("/"));
        await fs.mkdir(path.dirname(legacyPayloadPath), { recursive: true });
        await fs.writeFile(legacyPayloadPath, shippedPayloadBytes);

        // In-process (not CLI-spawn): a single ordered console-line array
        // (log + warn together) is the only way to prove relative ordering
        // between an install-side log line and a prune-side warn line —
        // separate stdout/stderr buffers from a spawned CLI cannot be
        // interleaved after the fact.
        const { lines } = await runSyncInProcess(root, slimSourceRoot);

        // THEN the two devpro entries were installed.
        const agentsEntry = await fs.lstat(path.join(root, ".agents", "skills", "devpro"));
        const claudeEntry = await fs.lstat(path.join(root, ".claude", "skills", "devpro"));
        assert.equal(agentsEntry.isSymbolicLink(), true);
        assert.equal(claudeEntry.isSymbolicLink(), true);

        // AND the owned legacy link was removed with a warning naming it,
        // AND that install happened strictly BEFORE the prune — not merely
        // as an unordered end-state coincidence.
        const installedIndex = lines.findIndex((line) => /^Synchronized \.agents\/skills\//.test(line));
        const linkPrunedIndex = lines.findIndex(
          (line) => line.includes("Removed legacy skill discovery link") && line.includes(LINK_ENTRY.path)
        );
        const payloadPrunedIndex = lines.findIndex(
          (line) => line.includes("Removed legacy skill payload file") && line.includes(PAYLOAD_ENTRY.path)
        );
        assert.notEqual(installedIndex, -1, "install-side log line must be present");
        assert.notEqual(linkPrunedIndex, -1, "legacy link prune warning naming the path must be present");
        assert.notEqual(payloadPrunedIndex, -1, "legacy payload prune warning naming the path must be present");
        assert.ok(installedIndex < linkPrunedIndex, "entries must install before the legacy link is pruned");
        assert.ok(installedIndex < payloadPrunedIndex, "entries must install before the legacy payload is pruned");

        assert.equal(await fs.lstat(legacyLinkPath).catch(() => null), null, "the owned legacy link must be removed");
        assert.equal(
          await fs.readFile(legacyPayloadPath).catch(() => null),
          null,
          "the owned legacy payload file must be removed"
        );
        assert.equal(
          await fs.lstat(path.dirname(legacyPayloadPath)).catch(() => null),
          null,
          "the now-emptied legacy payload directory must be removed non-recursively"
        );

        // AND a second --sync emits no legacy prune warning for these paths.
        const resync = await runSyncInProcess(root, slimSourceRoot);
        assert.equal(
          resync.lines.some((line) => line.includes("Removed legacy skill discovery link")),
          false
        );
        assert.equal(
          resync.lines.some((line) => line.includes("Removed legacy skill payload file")),
          false
        );
      });
    });
  });

  it("Scenario: Consumer-owned or modified legacy nodes are kept", async () => {
    // Derived, never a new literal for one of the 18 renamed skill names:
    // the first LEGACY_SKILL_PAYLOAD_FILES entry that is NOT a SKILL.md
    // (e.g. a references/*.md support file), so this fixture stays outside
    // the entry-tree-inventory walk's SKILL.md discovery entirely.
    const REFERENCE_PAYLOAD_ENTRY = LEGACY_SKILL_PAYLOAD_FILES.find((entry) => !entry.path.endsWith("SKILL.md"));
    assert.ok(REFERENCE_PAYLOAD_ENTRY, "fixture precondition: a non-SKILL.md legacy payload file must exist");
    const referenceSkillDirRel = REFERENCE_PAYLOAD_ENTRY.path.split("/").slice(0, -2).join("/");

    // A second, distinct "/references/" legacy skill dir (different from
    // REFERENCE_PAYLOAD_ENTRY's own skill dir, so the two disjuncts below
    // never seed conflicting states at the same path) — its skill-level
    // ancestor directory is what gets replaced by a symlink in disjunct 3.
    const ANCESTOR_PAYLOAD_ENTRY = LEGACY_SKILL_PAYLOAD_FILES.find(
      (entry) => entry.path.includes("/references/") && entry.path.split("/").slice(0, -2).join("/") !== referenceSkillDirRel
    );
    assert.ok(ANCESTOR_PAYLOAD_ENTRY, "fixture precondition: a second, distinct references/ legacy skill dir must exist");
    const ancestorSkillDirParts = ANCESTOR_PAYLOAD_ENTRY.path.split("/").slice(0, -2);

    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withConsumerRepo(async (ctx) => {
        // (1) A consumer-built link at a reserved legacy path, pointing
        // elsewhere in the catalog than its shipped literal target.
        const collisionLinkPath = path.join(ctx.tmpDir, ...LINK_ENTRY.path.split("/"));
        await fs.mkdir(path.dirname(collisionLinkPath), { recursive: true });
        const collisionTarget = `${path.posix.dirname(SHIPPED_TARGET)}/../custom-owner`;
        await createPortableTestSymlink(collisionTarget, collisionLinkPath);

        // (2) A legacy payload file whose bytes were modified by the
        // consumer.
        const modifiedPayloadPath = path.join(ctx.tmpDir, ...REFERENCE_PAYLOAD_ENTRY.path.split("/"));
        await fs.mkdir(path.dirname(modifiedPayloadPath), { recursive: true });
        await fs.writeFile(modifiedPayloadPath, "consumer edited this legacy payload file\n");

        // (3) A legacy payload path under an ancestor replaced by a
        // symbolic link — the ancestor points to a real directory living
        // ENTIRELY OUTSIDE the catalog (`outside-skill/`), containing an
        // empty `references/` subdir plus a sentinel file, so this proves
        // both "not followed" (the payload file inside is never read/
        // classified as if it were the legacy skill) and "not touched"
        // (pruneLegacySkillPayload()'s empty-directory cleanup must not
        // rmdir through the symlink and delete `outside-skill/references`).
        const outsideDir = path.join(ctx.tmpDir, "outside-skill");
        await fs.mkdir(path.join(outsideDir, "references"), { recursive: true });
        await fs.writeFile(path.join(outsideDir, "sentinel.txt"), "do not touch\n");
        const ancestorLinkPath = path.join(ctx.tmpDir, ...ancestorSkillDirParts);
        await fs.mkdir(path.dirname(ancestorLinkPath), { recursive: true });
        await createPortableTestSymlink(outsideDir, ancestorLinkPath);

        const sync = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(sync.exitCode, 0, sync.stderr);

        // THEN (1) must be kept and not followed.
        assert.match(
          sync.stderr,
          new RegExp(`Keeping ${LINK_ENTRY.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
          "a not-owned collision must be warned-and-kept, not silently skipped or followed"
        );
        const linkStat = await fs.lstat(collisionLinkPath);
        assert.equal(linkStat.isSymbolicLink(), true);
        assert.equal(
          await readLinkTarget(collisionLinkPath),
          collisionTarget,
          "the collision link's literal target must not be followed or rewritten"
        );

        // THEN (2) must be kept and not touched.
        assert.match(
          sync.stderr,
          new RegExp(`Keeping ${REFERENCE_PAYLOAD_ENTRY.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
          "a modified legacy payload file must be warned-and-kept"
        );
        const payloadAfter = await fs.readFile(modifiedPayloadPath, "utf8");
        assert.equal(
          payloadAfter,
          "consumer edited this legacy payload file\n",
          "the modified payload file's bytes must be left untouched"
        );

        // THEN (3) must be kept and not followed: the ancestor symlink
        // itself survives, and the real content it points to (entirely
        // outside the catalog) is never deleted.
        const ancestorStat = await fs.lstat(ancestorLinkPath);
        assert.equal(ancestorStat.isSymbolicLink(), true, "the ancestor symlink itself must not be replaced");
        assert.equal(await fs.readlink(ancestorLinkPath), outsideDir);
        assert.ok(
          await fs.lstat(path.join(outsideDir, "references")).catch(() => null),
          "an empty directory OUTSIDE the catalog, reachable only through the symlinked ancestor, must survive"
        );
        assert.ok(
          await fs.lstat(path.join(outsideDir, "sentinel.txt")).catch(() => null),
          "the sentinel file outside the catalog must survive"
        );
      });
    });
  });

  // F-rase-pr-r1-04: a modified legacy SKILL.md is kept by the prune, and the
  // end-of-sync inventory walk must then name the manual step the prune
  // itself gave — never "Run --sync", which would loop forever because the
  // next --sync keeps the same file again.
  it("Scenario: Modified legacy SKILL.md is kept and reported with a manual step", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withTempConsumerRoot(async (root) => {
        await runSyncInProcess(root, slimSourceRoot);
        const payloadPath = path.join(root, ...PAYLOAD_ENTRY.path.split("/"));
        const payloadDirRel = path.posix.dirname(PAYLOAD_ENTRY.path);
        await fs.mkdir(path.dirname(payloadPath), { recursive: true });
        await fs.writeFile(payloadPath, "consumer edited this legacy SKILL.md\n");

        async function syncFailure() {
          try {
            await runSyncInProcess(root, slimSourceRoot);
          } catch (error) {
            return error;
          }
          return null;
        }
        const first = await syncFailure();
        const second = await syncFailure();
        for (const caught of [first, second]) {
          assert.ok(caught, "--sync must fail closed while the modified legacy SKILL.md stays discoverable");
          assert.equal(caught.reason, "legacy-skill-entry-residue");
          assert.equal(caught.exitCode, 30);
          assert.ok(caught.paths.includes(payloadDirRel), "the offending legacy skill dir must be named");
          assert.doesNotMatch(caught.message, /Run --sync/, "a kept modified file must not tell the operator to rerun --sync");
          assert.ok(
            caught.manualSteps.every((step) => !/Run --sync/.test(step)),
            `no manual step may say Run --sync: ${caught.manualSteps.join(" | ")}`
          );
          assert.ok(
            caught.manualSteps.some((step) => step.includes(PAYLOAD_ENTRY.path) && /delete or move it manually/.test(step)),
            `the manual step must name the modified file and the manual action: ${caught.manualSteps.join(" | ")}`
          );
        }
        assert.deepEqual(second.manualSteps, first.manualSteps, "a rerun must report the same manual step, not a new one");
        assert.equal(await fs.readFile(payloadPath, "utf8"), "consumer edited this legacy SKILL.md\n");

        let checkError = null;
        try {
          await runCheckInProcess(root, slimSourceRoot);
        } catch (error) {
          checkError = error;
        }
        assert.ok(checkError, "--check must fail closed too");
        assert.equal(checkError.reason, "legacy-skill-entry-residue");
        assert.equal(checkError.exitCode, 30);
        assert.ok(
          checkError.manualSteps.some((step) => step.includes(PAYLOAD_ENTRY.path) && /delete or move it manually/.test(step))
        );
      });
    });
  });

  // F-rase-pr-r7-03: with a consumer skill inside the catalog alongside a
  // kept modified legacy SKILL.md, the reason is the mismatch one, but the
  // legacy file must still get its own manual step, never "move your own
  // skill", which would republish a stale devpro skill.
  it("Scenario: A kept legacy SKILL.md keeps its manual step when a consumer skill is also inside the catalog", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withTempConsumerRoot(async (root) => {
        await runSyncInProcess(root, slimSourceRoot);
        const payloadPath = path.join(root, ...PAYLOAD_ENTRY.path.split("/"));
        await fs.mkdir(path.dirname(payloadPath), { recursive: true });
        await fs.writeFile(payloadPath, "consumer edited this legacy SKILL.md\n");
        const ownRel = `${SKILL_TARGET_ROOT}/own-group/own-skill`;
        await fs.mkdir(path.join(root, ...ownRel.split("/")), { recursive: true });
        await fs.writeFile(path.join(root, ...ownRel.split("/"), "SKILL.md"), "# Own skill\n");

        let caught = null;
        try {
          await runSyncInProcess(root, slimSourceRoot);
        } catch (error) {
          caught = error;
        }
        assert.ok(caught, "--sync must fail closed");
        assert.equal(caught.reason, "skill-entry-inventory-mismatch");
        const legacyStep = caught.manualSteps.find((step) => step.includes(PAYLOAD_ENTRY.path));
        assert.ok(legacyStep, `the kept legacy file must be named: ${caught.manualSteps.join(" | ")}`);
        assert.match(legacyStep, /delete or move it manually/);
        assert.doesNotMatch(legacyStep, /Move your own skill/);
        assert.ok(
          caught.manualSteps.some((step) => step.includes(ownRel) && step.includes(".claude/skills/<own-name>")),
          `the consumer skill must get the move step: ${caught.manualSteps.join(" | ")}`
        );
        assert.doesNotMatch(caught.message, /Run --sync/);
      });
    });
  });

  // F-rase-pr-r1-01: done_when 2's production-v6.98.0-shaped consumer — every
  // frozen legacy link (both roots) plus the retired `.cursor/skills` links,
  // every frozen payload file at shipped bytes, and a consumer-owned skill
  // outside the catalog. All paths derive from the frozen allowlists.
  it("Scenario: A full pre-rename consumer migrates to the two entries and then passes --check", async () => {
    const payloadBytes = readLegacyBlobBytesBatch(LEGACY_SKILL_PAYLOAD_FILES.map((entry) => entry.blobIds[0]));
    const shippedTargetByName = new Map(
      LEGACY_SKILL_ENTRY_LINKS.map((entry) => [path.posix.basename(entry.path), entry.shippedTargets[0]])
    );
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withTempConsumerRoot(async (root) => {
        const seed = async (relPath, create) => {
          const abs = path.join(root, ...relPath.split("/"));
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await create(abs);
        };
        for (const entry of LEGACY_SKILL_ENTRY_LINKS) {
          await seed(entry.path, (abs) => createPortableTestSymlink(entry.shippedTargets[0], abs));
        }
        for (const relPath of LEGACY_CURSOR_SKILL_DISCOVERY_ARTIFACTS) {
          const target = shippedTargetByName.get(path.posix.basename(relPath));
          assert.ok(target, `fixture precondition: ${relPath} must share a name with a frozen legacy link`);
          await seed(relPath, (abs) => createPortableTestSymlink(target, abs));
        }
        for (const entry of LEGACY_SKILL_PAYLOAD_FILES) {
          await seed(entry.path, (abs) => fs.writeFile(abs, payloadBytes.get(entry.blobIds[0])));
        }
        const ownSkillRel = ".claude/skills/own-consumer-skill";
        await seed(`${ownSkillRel}/SKILL.md`, (abs) =>
          fs.writeFile(abs, "---\nname: own-consumer-skill\ndescription: consumer-owned fixture skill.\n---\n")
        );

        const { lines } = await runSyncInProcess(root, slimSourceRoot);

        for (const entry of LEGACY_SKILL_ENTRY_LINKS) {
          assert.equal(await fs.lstat(path.join(root, ...entry.path.split("/"))).catch(() => null), null, entry.path);
          assert.ok(
            lines.some((line) => line.includes("Removed legacy skill discovery link") && line.includes(entry.path)),
            `a warn must name the pruned link ${entry.path}`
          );
        }
        for (const relPath of LEGACY_CURSOR_SKILL_DISCOVERY_ARTIFACTS) {
          assert.equal(await fs.lstat(path.join(root, ...relPath.split("/"))).catch(() => null), null, relPath);
          assert.ok(lines.some((line) => line.includes("Removed legacy") && line.includes(relPath)), relPath);
        }
        for (const entry of LEGACY_SKILL_PAYLOAD_FILES) {
          assert.equal(await fs.lstat(path.join(root, ...entry.path.split("/"))).catch(() => null), null, entry.path);
          assert.ok(
            lines.some((line) => line.includes("Removed legacy skill payload file") && line.includes(entry.path)),
            `a warn must name the pruned payload ${entry.path}`
          );
        }
        assert.deepEqual((await fs.readdir(path.join(root, ".agents", "skills"))).sort(), ["devpro"]);
        assert.deepEqual((await fs.readdir(path.join(root, ".claude", "skills"))).sort(), ["devpro", "own-consumer-skill"]);
        assert.match(await fs.readFile(path.join(root, ...ownSkillRel.split("/"), "SKILL.md"), "utf8"), /own-consumer-skill/);

        await runCheckInProcess(root, slimSourceRoot);
      });
    });
  });

  // F-rase-pr-r1-01: the root-entrypoint --sync re-execs the submodule copy;
  // its named exit 30 must reach the operator, not collapse to 0 or 1.
  it("root-entrypoint --sync forwards the re-exec'd exit 30", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withConsumerRepo(async (ctx) => {
        const bootstrap = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(bootstrap.exitCode, 0, bootstrap.stderr);
        const ownSkillDir = path.join(ctx.tmpDir, ...SKILL_TARGET_ROOT.split("/"), "own-group", "own-skill");
        await fs.mkdir(ownSkillDir, { recursive: true });
        await fs.writeFile(path.join(ownSkillDir, "SKILL.md"), "# Own skill\n");

        const rootScript = path.join(ctx.tmpDir, ".devpro", "scripts", "sync-agent-rules.mjs");
        const result = run(rootScript, "--sync", { cwd: ctx.tmpDir, testSourceRoot: slimSourceRoot });
        assert.match(result.stdout, /Re-executing submodule script/);
        assert.equal(result.exitCode, 30, `re-exec must forward exit 30; stderr=${result.stderr}`);
        assert.match(result.stderr, /reason: skill-entry-inventory-mismatch/);
      });
    });
  });

  it("Scenario: Entry installation failure rolls back and blocks before prune", async () => {
    await withSlimSyncSource(async (slim) => {
      await withTempConsumerRoot(async (root) => {
        // A first, clean --sync installs both devpro entries correctly.
        await runSyncInProcess(root, slim.sourceRoot);
        const agentsPath = path.join(root, ".agents", "skills", "devpro");
        const claudePath = path.join(root, ".claude", "skills", "devpro");
        const agentsBefore = await fs.lstat(agentsPath);
        assert.equal(agentsBefore.isSymbolicLink(), true);

        // GIVEN "one devpro entry path already holds a non-managed node":
        // replace the SECOND entry with a consumer-owned collision, while
        // the FIRST entry stays exactly as the prior successful sync left
        // it — a "previously installed managed entry" this run must never
        // touch, since design D8 item 1 prechecks BOTH entries before
        // creating/changing either one.
        await fs.rm(claudePath, { recursive: true, force: true });
        await fs.writeFile(claudePath, "consumer-owned collision");

        // Seed legacy residue (both a link and a payload file) a completed
        // sync would otherwise prune, to prove the blocked run never
        // reaches either prune step.
        const legacyLinkPath = path.join(root, ...LINK_ENTRY.path.split("/"));
        await fs.mkdir(path.dirname(legacyLinkPath), { recursive: true });
        await createPortableTestSymlink(SHIPPED_TARGET, legacyLinkPath);

        const shippedPayloadBytes = readLegacyBlobBytes(PAYLOAD_ENTRY.blobIds[0]);
        const legacyPayloadPath = path.join(root, ...PAYLOAD_ENTRY.path.split("/"));
        await fs.mkdir(path.dirname(legacyPayloadPath), { recursive: true });
        await fs.writeFile(legacyPayloadPath, shippedPayloadBytes);

        let caught = null;
        try {
          await runSyncInProcess(root, slim.sourceRoot);
        } catch (error) {
          caught = error;
        }
        assert.ok(caught, "a precheck conflict at the second entry must block the second --sync");
        assert.equal(caught.reason, "legacy-skill-entry-residue");
        assert.equal(caught.exitCode, 30);

        // AND no entry created THIS run remains, and the previously
        // installed managed entry remains untouched (same inode).
        const agentsAfter = await fs.lstat(agentsPath);
        assert.equal(agentsAfter.isSymbolicLink(), true);
        assert.equal(
          agentsAfter.ino,
          agentsBefore.ino,
          "the previously installed managed entry must remain untouched by the blocked run"
        );
        const claudeStat = await fs.lstat(claudePath);
        assert.equal(claudeStat.isSymbolicLink(), false, "the conflicting node must be left exactly as it was");
        assert.equal(await fs.readFile(claudePath, "utf8"), "consumer-owned collision");

        // AND no legacy link or payload was pruned.
        assert.ok(
          await fs.lstat(legacyLinkPath).catch(() => null),
          "legacy link residue seeded before the blocked sync must survive — the prune steps never ran"
        );
        const payloadAfter = await fs.readFile(legacyPayloadPath).catch(() => null);
        assert.ok(
          payloadAfter && payloadAfter.equals(shippedPayloadBytes),
          "legacy payload residue seeded before the blocked sync must survive unchanged"
        );
      });
    });
  });

  // Supporting evidence for the titled S3 test above: that test's GIVEN
  // ("one devpro entry path already holds a non-managed node") blocks at
  // the precheck, before anything runs, so "the previously installed
  // managed entry remains untouched" holds trivially there. This covers
  // the scenario's OTHER given branch — "creating the second entry fails
  // after the precheck" — where .agents/skills/devpro is genuinely
  // "correct-symlink" (state SKIPPED, never pushed onto
  // context.createdSkillEntries) while .claude/skills/devpro's own
  // re-creation this run fails, so the untouched claim is non-trivial.
  it("keeps a previously-installed .agents entry untouched when the .claude entry's re-creation fails on a later --sync (non-fallback error)", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withConsumerRepo(async (ctx) => {
        const seed = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(seed.exitCode, 0, seed.stderr);

        const agentsPath = path.join(ctx.tmpDir, ".agents", "skills", "devpro");
        const claudePath = path.join(ctx.tmpDir, ".claude", "skills", "devpro");
        const agentsBefore = await fs.lstat(agentsPath);
        assert.equal(agentsBefore.isSymbolicLink(), true);

        // Remove ONLY the .claude entry so its state is "missing" (creation
        // attempted, can fail) while .agents stays "correct-symlink".
        await fs.rm(claudePath, { force: true });

        const legacyLinkPath = path.join(ctx.tmpDir, ...LINK_ENTRY.path.split("/"));
        await fs.mkdir(path.dirname(legacyLinkPath), { recursive: true });
        await createPortableTestSymlink(SHIPPED_TARGET, legacyLinkPath);
        const shippedPayloadBytes = readLegacyBlobBytes(PAYLOAD_ENTRY.blobIds[0]);
        const legacyPayloadPath = path.join(ctx.tmpDir, ...PAYLOAD_ENTRY.path.split("/"));
        await fs.mkdir(path.dirname(legacyPayloadPath), { recursive: true });
        await fs.writeFile(legacyPayloadPath, shippedPayloadBytes);

        const preloadPath = path.join(ctx.tmpDir, "force-claude-entry-eio.mjs");
        await fs.writeFile(
          preloadPath,
          [
            'import { promises as fs } from "node:fs";',
            "const realSymlink = fs.symlink.bind(fs);",
            "fs.symlink = async (target, nodePath, ...args) => {",
            '  const normalized = String(nodePath).replaceAll("\\\\", "/");',
            '  if (/\\/\\.claude\\/skills\\//.test(normalized)) {',
            '    const error = new Error("forced non-fallback discovery symlink fault");',
            '    error.code = "EIO";',
            "    throw error;",
            "  }",
            "  return realSymlink(target, nodePath, ...args);",
            "};",
            "",
          ].join("\n")
        );

        const { exitCode, stderr } = run(ctx.syncScript, "--sync", {
          cwd: ctx.tmpDir,
          testSourceRoot: slimSourceRoot,
          env: {
            NODE_OPTIONS: [
              process.env.NODE_OPTIONS,
              `--import=${pathToFileURL(preloadPath).href}`,
            ].filter(Boolean).join(" "),
          },
        });
        assert.equal(exitCode, 30, `re-creating the missing .claude entry must exit 30; stderr=${stderr}`);

        const agentsAfter = await fs.lstat(agentsPath);
        assert.equal(agentsAfter.isSymbolicLink(), true);
        assert.equal(
          agentsAfter.ino,
          agentsBefore.ino,
          "the previously installed .agents entry must remain untouched even though this run's failure happened after the precheck, not at it"
        );
        const claudeAfter = await fs.lstat(claudePath).catch(() => null);
        assert.equal(claudeAfter, null, "the .claude entry must never have been left half-installed");

        assert.ok(
          await fs.lstat(legacyLinkPath).catch(() => null),
          "legacy link residue must survive — the prune steps never ran"
        );
        const payloadAfter = await fs.readFile(legacyPayloadPath).catch(() => null);
        assert.ok(
          payloadAfter && payloadAfter.equals(shippedPayloadBytes),
          "legacy payload residue must survive unchanged"
        );
      });
    });
  });

  it("Scenario: Unsynced upgraded consumer gets the named residue exit", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withTempConsumerRoot(async (root) => {
        // GIVEN a consumer that updated its payload but still holds legacy
        // per-skill discovery links: run one real --sync first (so this is
        // a genuinely-migrated consumer, not a bare directory), then
        // simulate "hasn't run --sync against the upgraded source yet" by
        // removing BOTH devpro entries the prior sync installed. If
        // checkLegacySkillEntryResidue did not run FIRST in CHECK_STEPS
        // (ahead of validateManagedSkillFilesystem), this would instead
        // surface as a generic missing-managed-output Error (exit 1, no
        // `.reason`) rather than the named exit 30 this scenario requires.
        await runSyncInProcess(root, slimSourceRoot);
        await fs.rm(path.join(root, ".agents", "skills", "devpro"), { force: true });
        await fs.rm(path.join(root, ".claude", "skills", "devpro"), { force: true });

        const legacyLinkPath = path.join(root, ...LINK_ENTRY.path.split("/"));
        await fs.mkdir(path.dirname(legacyLinkPath), { recursive: true });
        await createPortableTestSymlink(SHIPPED_TARGET, legacyLinkPath);

        const shippedPayloadBytes = readLegacyBlobBytes(PAYLOAD_ENTRY.blobIds[0]);
        const payloadPath = path.join(root, ...PAYLOAD_ENTRY.path.split("/"));
        await fs.mkdir(path.dirname(payloadPath), { recursive: true });
        await fs.writeFile(payloadPath, shippedPayloadBytes);

        let caught = null;
        try {
          await runCheckInProcess(root, slimSourceRoot);
        } catch (error) {
          caught = error;
        }
        assert.ok(caught, "runCheck must throw when legacy residue is present, even with other real failures pending");
        assert.equal(caught.reason, "legacy-skill-entry-residue");
        assert.equal(caught.exitCode, 30);
        assert.deepEqual(
          [...caught.paths].sort(),
          [LINK_ENTRY.path, PAYLOAD_ENTRY.path].sort(),
          "every residue path must be named"
        );
        assert.match(
          caught.manualSteps[0],
          /Run --sync/,
          "the first manual step must be to run --sync"
        );

        // AND the check is read-only: nothing was deleted or modified.
        const linkStatAfter = await fs.lstat(legacyLinkPath);
        assert.equal(linkStatAfter.isSymbolicLink(), true);
        assert.equal(await readLinkTarget(legacyLinkPath), SHIPPED_TARGET);
        const payloadAfter = await fs.readFile(payloadPath);
        assert.ok(payloadAfter.equals(shippedPayloadBytes), "the seeded payload file must be unchanged");
      });
    });
  });

  it("Scenario: Clean migrated consumer passes", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withConsumerRepo(async (ctx) => {
        const sync = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(sync.exitCode, 0, sync.stderr);

        const check = run(ctx.syncScript, "--check", { cwd: ctx.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(check.exitCode, 0, check.stderr);
        assert.doesNotMatch(check.stderr, /legacy skill entry residue/);
      });
    });
  });

  it("Scenario: Consumer-authored skill inside the catalog is rejected", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withTempConsumerRoot(async (root) => {
        // A real, successfully-migrated consumer first (so the real
        // managedSkillInventory, not a made-up one, is what checkSkillEntryInventory
        // runs against through runCheck's own CHECK_STEPS pipeline).
        await runSyncInProcess(root, slimSourceRoot);

        const ownGroupRel = "own-group/own-skill";
        const ownSkillDir = path.join(root, ...SKILL_TARGET_ROOT.split("/"), ...ownGroupRel.split("/"));
        await fs.mkdir(ownSkillDir, { recursive: true });
        await fs.writeFile(path.join(ownSkillDir, "SKILL.md"), "# Own skill\n");

        let caught = null;
        try {
          await runCheckInProcess(root, slimSourceRoot);
        } catch (error) {
          caught = error;
        }
        assert.ok(caught, "runCheck must throw for a consumer-authored skill inside the catalog");
        assert.equal(caught.reason, "skill-entry-inventory-mismatch");
        assert.equal(caught.exitCode, 30);
        const ownRel = `${SKILL_TARGET_ROOT}/${ownGroupRel}`;
        assert.ok(caught.paths.includes(ownRel));
        assert.ok(
          caught.manualSteps.some(
            (step) => step.includes(ownRel) && step.includes(".claude/skills/<own-name>") && step.includes(".agents/skills/<own-name>")
          ),
          "the message must direct the operator to move it to a consumer-owned discovery entry"
        );
      });
    });
  });

  // T9 CLI reason finding (CLI-level, not in-process): the `reason` token
  // reaches an actual operator's terminal for BOTH exit-30 reasons, not
  // only the structured `.reason` field asserted above.
  it("--check prints the named reason token on stderr for a consumer-authored skill inside the catalog", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withConsumerRepo(async (ctx) => {
        const seed = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(seed.exitCode, 0, seed.stderr);

        const ownGroupRel = "own-group/own-skill";
        const ownSkillDir = path.join(ctx.tmpDir, ...SKILL_TARGET_ROOT.split("/"), ...ownGroupRel.split("/"));
        await fs.mkdir(ownSkillDir, { recursive: true });
        await fs.writeFile(path.join(ownSkillDir, "SKILL.md"), "# Own skill\n");

        const check = run(ctx.syncScript, "--check", { cwd: ctx.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(check.exitCode, 30, `consumer-authored catalog skill must exit 30; stderr=${check.stderr}`);
        assert.match(check.stderr, /reason: skill-entry-inventory-mismatch/);
      });
    });
  });

  it("Scenario: Consumer-owned discovery entries outside the catalog are preserved", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withConsumerRepo(async (ctx) => {
        const ownSkillDir = path.join(ctx.tmpDir, ".claude", "skills", "own-consumer-skill");
        await fs.mkdir(ownSkillDir, { recursive: true });
        await fs.writeFile(
          path.join(ownSkillDir, "SKILL.md"),
          "---\nname: own-consumer-skill\ndescription: consumer-owned fixture skill.\n---\n\n# Own consumer skill\n"
        );

        const sync = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(sync.exitCode, 0, sync.stderr);

        const afterSyncStat = await fs.lstat(ownSkillDir);
        assert.equal(afterSyncStat.isDirectory(), true, "the consumer-owned entry must remain a real directory");
        assert.match(await fs.readFile(path.join(ownSkillDir, "SKILL.md"), "utf8"), /own-consumer-skill/);

        const check = run(ctx.syncScript, "--check", { cwd: ctx.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(check.exitCode, 0, check.stderr);

        const afterCheckStat = await fs.lstat(ownSkillDir);
        assert.equal(afterCheckStat.isDirectory(), true, "the consumer-owned entry must remain untouched by --check too");
      });
    });
  });
});

// design D8 item 4: rollback removes an entry only while it still matches
// what this run created (link target or blob bytes); anything else is kept
// and reported as a manual step.
describe("rollbackCreatedSkillEntries re-verifies each entry before removing it", () => {
  const ENTRY_TARGET = "../../.devpro/agent-skills";

  it("removes a symlink whose target is unchanged and keeps one whose target changed", async () => {
    await withTempConsumerRoot(async (root) => {
      await fs.mkdir(path.join(root, ".agents", "skills"), { recursive: true });
      await fs.mkdir(path.join(root, ".claude", "skills"), { recursive: true });
      await createPortableTestSymlink(ENTRY_TARGET, path.join(root, ".agents", "skills", "devpro"));
      await createPortableTestSymlink("../../elsewhere", path.join(root, ".claude", "skills", "devpro"));
      const context = {
        createdSkillEntries: [
          { relPath: ".agents/skills/devpro", kind: "symlink", linkTarget: ENTRY_TARGET },
          { relPath: ".claude/skills/devpro", kind: "symlink", linkTarget: ENTRY_TARGET },
        ],
      };
      const failures = await rollbackCreatedSkillEntries(root, context);
      assert.deepEqual(failures, [
        ".claude/skills/devpro: link target changed since this run created it; left in place for manual inspection",
      ]);
      assert.equal(await fs.lstat(path.join(root, ".agents", "skills", "devpro")).catch(() => null), null);
      assert.equal(await readLinkTarget(path.join(root, ".claude", "skills", "devpro")), "../../elsewhere");
    });
  });

  it("removes a plain-blob entry whose bytes are unchanged and keeps one whose bytes changed", async () => {
    await withTempConsumerRoot(async (root) => {
      await fs.mkdir(path.join(root, ".agents", "skills"), { recursive: true });
      await fs.mkdir(path.join(root, ".claude", "skills"), { recursive: true });
      const bytes = Buffer.from(ENTRY_TARGET, "utf8");
      await fs.writeFile(path.join(root, ".agents", "skills", "devpro"), bytes);
      await fs.writeFile(path.join(root, ".claude", "skills", "devpro"), "consumer edit");
      const context = {
        createdSkillEntries: [
          { relPath: ".agents/skills/devpro", kind: "plain-blob", bytes, addedIndexEntry: false },
          { relPath: ".claude/skills/devpro", kind: "plain-blob", bytes, addedIndexEntry: false },
        ],
      };
      const failures = await rollbackCreatedSkillEntries(root, context);
      assert.deepEqual(failures, [
        ".claude/skills/devpro: content changed since this run created it; left in place for manual inspection",
      ]);
      assert.equal(await fs.lstat(path.join(root, ".agents", "skills", "devpro")).catch(() => null), null);
      assert.equal(await fs.readFile(path.join(root, ".claude", "skills", "devpro"), "utf8"), "consumer edit");
    });
  });

  // PR #2886 primary review r15: the index entry this run added is reverted
  // even when the node itself is kept for manual inspection.
  it("reverts an added index entry while keeping a node that is no longer this run's plain file", async () => {
    await withTempConsumerRoot(async (root) => {
      // Isolate Git env: both paths are real 120000 entries in this source
      // repo, so an inherited GIT_DIR/GIT_INDEX_FILE must not reach them.
      await withFixtureGitEnv(root, async () => {
        const git = (args, input) => {
          const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", input });
          assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
          return result.stdout;
        };
        git(["init", "-q"]);
        const bytes = Buffer.from(ENTRY_TARGET, "utf8");
        const objectId = git(["hash-object", "-w", "--stdin"], bytes).trim();
        for (const relPath of [".agents/skills/devpro", ".claude/skills/devpro"]) {
          git(["update-index", "--add", "--cacheinfo", `120000,${objectId},${relPath}`]);
        }
        await fs.mkdir(path.join(root, ".agents", "skills", "devpro"), { recursive: true });
        await fs.mkdir(path.join(root, ".claude", "skills"), { recursive: true });
        await fs.writeFile(path.join(root, ".claude", "skills", "devpro"), "consumer edit");
        const context = {
          createdSkillEntries: [
            { relPath: ".agents/skills/devpro", kind: "plain-blob", bytes, addedIndexEntry: true },
            { relPath: ".claude/skills/devpro", kind: "plain-blob", bytes, addedIndexEntry: true },
          ],
        };
        const failures = await rollbackCreatedSkillEntries(root, context);
        assert.deepEqual(failures, [
          ".claude/skills/devpro: content changed since this run created it; left in place for manual inspection",
          ".agents/skills/devpro: no longer a plain file at rollback time; left in place for manual inspection",
        ]);
        assert.equal(git(["ls-files", "--stage"]), "", "both 120000 entries this run added must be unstaged");
        assert.equal((await fs.lstat(path.join(root, ".agents", "skills", "devpro"))).isDirectory(), true);
        assert.equal(await fs.readFile(path.join(root, ".claude", "skills", "devpro"), "utf8"), "consumer edit");
      });
    });
  });

  // Primary review r19: a node that is missing, or whose parent is no longer
  // a directory, is already gone and needs no manual step.
  it("reports nothing for a plain-blob entry that is already gone (ENOENT or ENOTDIR)", async () => {
    await withTempConsumerRoot(async (root) => {
      await fs.mkdir(path.join(root, ".agents", "skills"), { recursive: true });
      await fs.mkdir(path.join(root, ".claude"), { recursive: true });
      await fs.writeFile(path.join(root, ".claude", "skills"), "not a directory");
      const bytes = Buffer.from(ENTRY_TARGET, "utf8");
      const failures = await rollbackCreatedSkillEntries(root, {
        createdSkillEntries: [
          { relPath: ".agents/skills/devpro", kind: "plain-blob", bytes, addedIndexEntry: false },
          { relPath: ".claude/skills/devpro", kind: "plain-blob", bytes, addedIndexEntry: false },
        ],
      });
      assert.deepEqual(failures, []);
    });
  });

  // PR #2886 cross-model round 2: a read or unlink error during rollback must
  // still revert the index entry this run added, and an lstat error must be
  // reported rather than read as "already gone" (primary review r18).
  // Permission bits are the fault; root and Windows ignore them, so the
  // cases are skipped there.
  const permissionFaultsUnsupported = process.platform === "win32" || process.getuid?.() === 0;
  for (const { label, lockPath, lockMode } of [
    { label: "inspecting", lockPath: (entryPath) => path.dirname(entryPath), lockMode: 0o600 },
    { label: "reading", lockPath: (entryPath) => entryPath, lockMode: 0o000 },
    { label: "unlinking", lockPath: (entryPath) => path.dirname(entryPath), lockMode: 0o555 },
  ]) {
    it(`reverts an added index entry when ${label} the fallback file fails`, { skip: permissionFaultsUnsupported }, async () => {
      await withTempConsumerRoot(async (root) => {
        await withFixtureGitEnv(root, async () => {
          const git = (args, input) => {
            const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", input });
            assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
            return result.stdout;
          };
          git(["init", "-q"]);
          const bytes = Buffer.from(ENTRY_TARGET, "utf8");
          const objectId = git(["hash-object", "-w", "--stdin"], bytes).trim();
          git(["update-index", "--add", "--cacheinfo", `120000,${objectId},.claude/skills/devpro`]);
          const entryPath = path.join(root, ".claude", "skills", "devpro");
          await fs.mkdir(path.dirname(entryPath), { recursive: true });
          await fs.writeFile(entryPath, bytes);
          const locked = lockPath(entryPath);
          const mode = (await fs.stat(locked)).mode & 0o777;
          await fs.chmod(locked, lockMode);
          try {
            const failures = await rollbackCreatedSkillEntries(root, {
              createdSkillEntries: [
                { relPath: ".claude/skills/devpro", kind: "plain-blob", bytes, addedIndexEntry: true },
              ],
            });
            assert.equal(failures.length, 1, failures.join("\n"));
            assert.match(failures[0], /^\.claude\/skills\/devpro: rollback failed \(.*\); remove it manually$/);
            assert.equal(git(["ls-files", "--stage"]), "", "the 120000 entry this run added must be unstaged");
          } finally {
            await fs.chmod(locked, mode);
          }
        });
      });
    });
  }
});
