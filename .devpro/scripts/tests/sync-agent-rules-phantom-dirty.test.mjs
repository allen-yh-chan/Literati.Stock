/**
 * Prove-it for #2063 Windows sync phantom dirty cure:
 * - seven managed `.gitattributes` LF entries (incl. three runtime JSON + OpenCode plugin)
 * - physical-byte skip-write on the three JSON writers
 * - local-only `core.autocrlf=true` fixture (never mutate global)
 *
 * F1: set local autocrlf BEFORE materializing/checkout of the three JSON paths.
 * F2: intentional semantic drift → rewrite + `--check` FAIL; repair → PASS.
 * F3: helper only treats ENOENT as missing; other read errors propagate.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  GITATTRIBUTES_MANAGED_BEGIN,
  GITATTRIBUTES_MANAGED_END,
  GITATTRIBUTES_MANAGED_ENTRIES,
  countGitignoreEntry,
  run,
  sourceRoot,
  withConsumerRepo,
} from "./lib/sync-agent-rules-harness.mjs";

const RUNTIME_JSON_PATHS = [
  ".claude/settings.json",
  ".codex/hooks.json",
  ".cursor/hooks.json",
];

const RUNTIME_JSON_LF_ENTRIES = RUNTIME_JSON_PATHS.map(
  (relPath) => `${relPath} text eol=lf`
);

const EXPECTED_MANAGED_ENTRIES = [
  ".devpro/scripts/hooks-git/* text eol=lf",
  ".gitignore text eol=lf",
  ".gitattributes text eol=lf",
  ...RUNTIME_JSON_LF_ENTRIES,
  ".opencode/plugins/devpro-hooks.js text eol=lf",
];

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "phantom-dirty-test",
  GIT_AUTHOR_EMAIL: "phantom-dirty-test@example.com",
  GIT_COMMITTER_NAME: "phantom-dirty-test",
  GIT_COMMITTER_EMAIL: "phantom-dirty-test@example.com",
};

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: GIT_ENV,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`
    );
  }
  return (result.stdout || "").trimEnd();
}

function gitConfigGet(cwd, key, { global: isGlobal = false } = {}) {
  const args = isGlobal
    ? ["config", "--global", "--get", key]
    : ["config", "--local", "--get", key];
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: GIT_ENV,
  });
  if (result.status === 0) return (result.stdout || "").trim();
  if (result.status === 1) return null; // unset
  throw new Error(
    `git config get ${key} failed: ${result.stderr || result.stdout}`
  );
}

function readGlobalAutocrlf() {
  // Use a throwaway cwd; --global does not need a repo, but spawn needs cwd.
  return gitConfigGet(process.cwd(), "core.autocrlf", { global: true });
}

async function sleepMs(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Windows sync phantom dirty cure (#2063)", () => {
  it("SSOT managed entries include the three runtime JSON LF lines (seven total)", () => {
    assert.deepEqual(
      [...GITATTRIBUTES_MANAGED_ENTRIES],
      EXPECTED_MANAGED_ENTRIES
    );
    for (const entry of RUNTIME_JSON_LF_ENTRIES) {
      assert.ok(
        GITATTRIBUTES_MANAGED_ENTRIES.includes(entry),
        `missing managed entry: ${entry}`
      );
    }
  });

  it("source .gitattributes and gitattributes-alignment.md pin the seven LF entries", async () => {
    const sourceAttrs = await fs.readFile(
      path.join(sourceRoot, ".gitattributes"),
      "utf8"
    );
    const alignment = await fs.readFile(
      path.join(sourceRoot, ".devpro", "agent-rules", "gitattributes-alignment.md"),
      "utf8"
    );
    for (const entry of EXPECTED_MANAGED_ENTRIES) {
      assert.match(sourceAttrs, new RegExp(`^${escapeRegExp(entry)}$`, "m"));
      assert.match(alignment, new RegExp(escapeRegExp(entry)));
    }
    assert.doesNotMatch(alignment, /three managed paths/);
    assert.doesNotMatch(alignment, /these three paths/);
  });

  it("local autocrlf fixture: seven LF entries, second sync skip-write, drift check timing, no global mutate", async () => {
    const globalBefore = readGlobalAutocrlf();

    await withConsumerRepo(async (local) => {
      // F1: init + local autocrlf BEFORE any materialize/checkout of the three JSON.
      git(local.tmpDir, ["init", "-q", "-b", "main"]);
      git(local.tmpDir, ["config", "core.autocrlf", "true"]);
      assert.equal(gitConfigGet(local.tmpDir, "core.autocrlf"), "true");
      assert.equal(readGlobalAutocrlf(), globalBefore, "must not mutate global autocrlf");

      const firstSync = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.equal(firstSync.exitCode, 0, firstSync.stderr);

      const attributesPath = path.join(local.tmpDir, ".gitattributes");
      const attributes = await fs.readFile(attributesPath, "utf8");
      assert.match(attributes, new RegExp(GITATTRIBUTES_MANAGED_BEGIN));
      assert.match(attributes, new RegExp(GITATTRIBUTES_MANAGED_END));
      for (const entry of EXPECTED_MANAGED_ENTRIES) {
        assert.equal(
          countGitignoreEntry(attributes, entry),
          1,
          `expected exactly one managed entry: ${entry}`
        );
      }

      for (const relPath of RUNTIME_JSON_PATHS) {
        const abs = path.join(local.tmpDir, ...relPath.split("/"));
        await fs.access(abs);
      }

      git(local.tmpDir, ["add", "-A"]);
      git(local.tmpDir, ["commit", "-q", "-m", "post-first-sync"]);

      const bytesBefore = {};
      const mtimeBefore = {};
      for (const relPath of RUNTIME_JSON_PATHS) {
        const abs = path.join(local.tmpDir, ...relPath.split("/"));
        bytesBefore[relPath] = await fs.readFile(abs);
        mtimeBefore[relPath] = (await fs.stat(abs)).mtimeMs;
      }

      // Ensure mtime resolution can observe a skip vs rewrite.
      await sleepMs(20);

      const secondSync = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.equal(secondSync.exitCode, 0, secondSync.stderr);

      for (const relPath of RUNTIME_JSON_PATHS) {
        const abs = path.join(local.tmpDir, ...relPath.split("/"));
        const bytesAfter = await fs.readFile(abs);
        const mtimeAfter = (await fs.stat(abs)).mtimeMs;
        assert.deepEqual(
          bytesAfter,
          bytesBefore[relPath],
          `${relPath} physical bytes must be unchanged on second sync`
        );
        assert.equal(
          mtimeAfter,
          mtimeBefore[relPath],
          `${relPath} must skip rewrite when physical bytes are equal (mtime unchanged)`
        );
      }

      const statusAfterSecond = git(local.tmpDir, ["status", "--porcelain", "--", ...RUNTIME_JSON_PATHS]);
      assert.equal(
        statusAfterSecond,
        "",
        `runtime JSON should be git-clean after second sync when possible; got:\n${statusAfterSecond}`
      );

      const checkClean = run(local.syncScript, "--check", { cwd: local.tmpDir });
      assert.equal(checkClean.exitCode, 0, checkClean.stderr);

      // F2: intentional semantic drift → rewrite + --check FAIL; repair → PASS.
      // Corrupt a source-owned field that --check enforces (statusLine; extras are allowed).
      const settingsPath = path.join(local.tmpDir, ".claude", "settings.json");
      const drifted = JSON.parse(await fs.readFile(settingsPath, "utf8"));
      const originalStatusLine = drifted.statusLine;
      assert.ok(originalStatusLine, "precondition: source settings must have statusLine for drift prove-it");
      drifted.statusLine = {
        type: "command",
        command: "echo intentionally-wrong-statusline-for-phantom-dirty-prove-it",
      };
      await fs.writeFile(
        settingsPath,
        `${JSON.stringify(drifted, null, 2)}\n`
      );

      const checkDrift = run(local.syncScript, "--check", { cwd: local.tmpDir });
      assert.notEqual(
        checkDrift.exitCode,
        0,
        "--check must FAIL on intentional semantic drift (scope unchanged; no phantom detector)"
      );

      const bytesBeforeRepair = await fs.readFile(settingsPath);
      const repairSync = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.equal(repairSync.exitCode, 0, repairSync.stderr);
      const bytesAfterRepair = await fs.readFile(settingsPath);
      assert.notDeepEqual(
        bytesAfterRepair,
        bytesBeforeRepair,
        "semantic drift must still cause a rewrite"
      );
      const repaired = JSON.parse(bytesAfterRepair.toString("utf8"));
      assert.deepEqual(repaired.statusLine, originalStatusLine);
      assert.notEqual(
        repaired.statusLine?.command,
        "echo intentionally-wrong-statusline-for-phantom-dirty-prove-it"
      );

      const checkRepaired = run(local.syncScript, "--check", { cwd: local.tmpDir });
      assert.equal(checkRepaired.exitCode, 0, checkRepaired.stderr);

      assert.equal(readGlobalAutocrlf(), globalBefore, "must not mutate global autocrlf");
      assert.equal(gitConfigGet(local.tmpDir, "core.autocrlf"), "true");
    });

    assert.equal(readGlobalAutocrlf(), globalBefore, "must not mutate global autocrlf");
  });

  it("#2259 migration: CRLF JSON first, then eol=lf, first sync skips rewrite", async () => {
    const globalBefore = readGlobalAutocrlf();
    await withConsumerRepo(async (local) => {
      git(local.tmpDir, ["init", "-q", "-b", "main"]);
      git(local.tmpDir, ["config", "core.autocrlf", "true"]);

      const firstSync = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.equal(firstSync.exitCode, 0, firstSync.stderr);

      const attributesPath = path.join(local.tmpDir, ".gitattributes");
      let attributes = await fs.readFile(attributesPath, "utf8");
      for (const entry of RUNTIME_JSON_LF_ENTRIES) {
        attributes = attributes.replaceAll(`${entry}\n`, "");
      }
      await fs.writeFile(attributesPath, attributes);

      for (const relPath of RUNTIME_JSON_PATHS) {
        const abs = path.join(local.tmpDir, ...relPath.split("/"));
        const lf = (await fs.readFile(abs)).toString("utf8").replace(/\r\n/g, "\n");
        await fs.writeFile(abs, lf.replace(/\n/g, "\r\n"));
      }

      git(local.tmpDir, ["add", "-A"]);
      git(local.tmpDir, ["commit", "-q", "-m", "crlf-json-without-eol-lf"]);

      attributes = await fs.readFile(attributesPath, "utf8");
      const begin = attributes.indexOf(GITATTRIBUTES_MANAGED_BEGIN);
      const insertAt = begin >= 0
        ? attributes.indexOf("\n", begin) + 1
        : attributes.length;
      const injected = `${RUNTIME_JSON_LF_ENTRIES.join("\n")}\n`;
      attributes = attributes.slice(0, insertAt) + injected + attributes.slice(insertAt);
      await fs.writeFile(attributesPath, attributes);
      git(local.tmpDir, ["add", "--", ".gitattributes"]);
      git(local.tmpDir, ["commit", "-q", "-m", "apply-json-eol-lf"]);

      git(local.tmpDir, ["status", "--porcelain", "--", ...RUNTIME_JSON_PATHS]);

      for (const relPath of RUNTIME_JSON_PATHS) {
        const abs = path.join(local.tmpDir, ...relPath.split("/"));
        const indexBlob = git(local.tmpDir, ["show", `:${relPath}`]);
        const headBlob = git(local.tmpDir, ["show", `HEAD:${relPath}`]);
        const disk = await fs.readFile(abs);
        assert.equal(indexBlob.includes("\r"), false, `index-probe ${relPath}`);
        assert.equal(headBlob.includes("\r"), false, `head-probe ${relPath}`);
        assert.ok(disk.includes(0x0d), `wt-crlf ${relPath}`);
        const attrsNow = await fs.readFile(attributesPath, "utf8");
        assert.ok(attrsNow.includes(`${relPath} text eol=lf`), `attrs ${relPath}`);
      }
      const prePorcelain = git(local.tmpDir, ["status", "--porcelain", "--", ...RUNTIME_JSON_PATHS]);
      assert.equal(prePorcelain, "", `pre-sync porcelain: ${prePorcelain}`);

      const bytesBefore = {};
      for (const relPath of RUNTIME_JSON_PATHS) {
        bytesBefore[relPath] = await fs.readFile(
          path.join(local.tmpDir, ...relPath.split("/"))
        );
      }

      spawnSync("git", ["update-index", "--really-refresh", "--", ...RUNTIME_JSON_PATHS], {
        cwd: local.tmpDir,
        encoding: "utf8",
        env: GIT_ENV,
      });
      git(local.tmpDir, ["status", "--porcelain", "--", ...RUNTIME_JSON_PATHS]);

      const secondSync = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.equal(secondSync.exitCode, 0, secondSync.stderr);

      for (const relPath of RUNTIME_JSON_PATHS) {
        const after = await fs.readFile(path.join(local.tmpDir, ...relPath.split("/")));
        assert.deepEqual(after, bytesBefore[relPath], `${relPath} must skip`);
      }
      const postPorcelain = git(local.tmpDir, ["status", "--porcelain", "--", ...RUNTIME_JSON_PATHS]);
      assert.equal(postPorcelain, "", postPorcelain);
      assert.equal(run(local.syncScript, "--check", { cwd: local.tmpDir }).exitCode, 0);
      assert.equal(readGlobalAutocrlf(), globalBefore);
    });
    assert.equal(readGlobalAutocrlf(), globalBefore);
  });

  it("writeFileUnlessSameBytes D7: non-git write, tracked-clean skip, untracked write, M write, staged skip", async () => {
    const { writeFileUnlessSameBytes, resetWriteFileGitProbeMemo } = await import(
      "../sync-agent-rules.mjs"
    );
    const lf = Buffer.from('{"ok":true}\n', "utf8");
    const crlf = Buffer.from('{"ok":true}\r\n', "utf8");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "d7-write-unless-"));
    try {
      resetWriteFileGitProbeMemo();
      const nonGit = path.join(tmp, "payload.json");
      await fs.writeFile(nonGit, crlf);
      await writeFileUnlessSameBytes(nonGit, lf);
      assert.deepEqual(await fs.readFile(nonGit), lf);

      const repo = path.join(tmp, "repo");
      await fs.mkdir(path.join(repo, ".claude"), { recursive: true });
      git(repo, ["init", "-q", "-b", "main"]);
      git(repo, ["config", "core.autocrlf", "false"]);
      const tracked = path.join(repo, ".claude", "settings.json");

      await fs.writeFile(tracked, crlf);
      git(repo, ["add", "--", ".claude/settings.json"]);
      git(repo, ["commit", "-q", "-m", "tracked-clean"]);
      resetWriteFileGitProbeMemo();
      await writeFileUnlessSameBytes(tracked, lf);
      assert.deepEqual(await fs.readFile(tracked), crlf, "tracked-clean skip");

      const untracked = path.join(repo, ".claude", "other.json");
      await fs.writeFile(untracked, crlf);
      resetWriteFileGitProbeMemo();
      await writeFileUnlessSameBytes(untracked, lf);
      assert.deepEqual(await fs.readFile(untracked), lf, "untracked write");

      await fs.writeFile(tracked, lf);
      git(repo, ["add", "--", ".claude/settings.json"]);
      git(repo, ["commit", "-q", "-m", "lf"]);
      await fs.writeFile(tracked, crlf);
      resetWriteFileGitProbeMemo();
      const errLines = [];
      const origErr = console.error;
      console.error = (...args) => {
        errLines.push(args.map(String).join(" "));
        origErr(...args);
      };
      try {
        await writeFileUnlessSameBytes(tracked, lf);
      } finally {
        console.error = origErr;
      }
      assert.deepEqual(await fs.readFile(tracked), lf, " M write");
      assert.match(errLines.join("\n"), /xy: M/);

      const extra = path.join(repo, "zzz-rename.txt");
      await fs.writeFile(extra, "x\n");
      git(repo, ["add", "--", "zzz-rename.txt"]);
      git(repo, ["commit", "-q", "-m", "extra"]);
      git(repo, ["mv", "zzz-rename.txt", "zzz-renamed.txt"]);
      await fs.writeFile(tracked, crlf);
      git(repo, ["add", "--", ".claude/settings.json"]);
      resetWriteFileGitProbeMemo();
      await writeFileUnlessSameBytes(tracked, lf);
      assert.deepEqual(await fs.readFile(tracked), crlf, "M  skip with sibling rename in porcelain -z");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("writeFileUnlessSameBytes D7: rename destination is R and writes", async () => {
    const { writeFileUnlessSameBytes, resetWriteFileGitProbeMemo } = await import(
      "../sync-agent-rules.mjs"
    );
    const lf = Buffer.from('{"ok":true}\n', "utf8");
    const crlf = Buffer.from('{"ok":true}\r\n', "utf8");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "d7-rename-dest-"));
    try {
      const repo = path.join(tmp, "repo");
      await fs.mkdir(path.join(repo, ".claude"), { recursive: true });
      git(repo, ["init", "-q", "-b", "main"]);
      git(repo, ["config", "core.autocrlf", "false"]);
      const fromJson = path.join(repo, ".claude", "from.json");
      const dest = path.join(repo, ".claude", "settings.json");
      await fs.writeFile(fromJson, crlf);
      git(repo, ["add", "--", ".claude/from.json"]);
      git(repo, ["commit", "-q", "-m", "from"]);
      git(repo, ["mv", ".claude/from.json", ".claude/settings.json"]);
      resetWriteFileGitProbeMemo();
      await writeFileUnlessSameBytes(dest, lf);
      assert.deepEqual(await fs.readFile(dest), lf, "rename destination must write, not skip as clean");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("porcelainXyByPath keys rename destination and fail-closes malformed -z", async () => {
    const { porcelainXyByPath } = await import("../sync-agent-rules.mjs");
    const rename = porcelainXyByPath("R  .claude/settings.json\0.claude/from.json\0");
    assert.equal(rename.get(".claude/settings.json"), "R ");
    assert.equal(rename.has(".claude/from.json"), false);
    assert.equal(porcelainXyByPath("R .claude/settings.json\0"), null);
    assert.equal(porcelainXyByPath("R  .claude/settings.json"), null);
  });

  it("writeFileUnlessSameBytes D7: nested consumer root skips all three tracked JSON", async () => {
    const { writeFileUnlessSameBytes, resetWriteFileGitProbeMemo } = await import(
      "../sync-agent-rules.mjs"
    );
    const lf = Buffer.from('{"ok":true}\n', "utf8");
    const crlf = Buffer.from('{"ok":true}\r\n', "utf8");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "d7-nested-consumer-"));
    try {
      const repo = path.join(tmp, "outer");
      const consumer = path.join(repo, "app");
      await fs.mkdir(repo, { recursive: true });
      git(repo, ["init", "-q", "-b", "main"]);
      git(repo, ["config", "core.autocrlf", "false"]);
      const tracked = [];
      for (const rel of RUNTIME_JSON_PATHS) {
        const abs = path.join(consumer, ...rel.split("/"));
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, crlf);
        tracked.push(abs);
        git(repo, ["add", "--", path.posix.join("app", rel)]);
      }
      git(repo, ["commit", "-q", "-m", "nested-tracked"]);
      resetWriteFileGitProbeMemo();
      for (const abs of tracked) {
        await writeFileUnlessSameBytes(abs, lf);
        assert.deepEqual(await fs.readFile(abs), crlf, `${abs} nested skip`);
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("writeFileUnlessSameBytes: equal skip, ENOENT write, other read errors propagate", async () => {
    const { writeFileUnlessSameBytes } = await import("../sync-agent-rules.mjs");
    assert.equal(typeof writeFileUnlessSameBytes, "function");

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "write-unless-same-"));
    try {
      const target = path.join(tmp, "payload.json");
      const payload = Buffer.from('{"ok":true}\n', "utf8");

      await writeFileUnlessSameBytes(target, payload);
      assert.deepEqual(await fs.readFile(target), payload);

      const mtime1 = (await fs.stat(target)).mtimeMs;
      await sleepMs(20);
      await writeFileUnlessSameBytes(target, Buffer.from(payload));
      assert.equal((await fs.stat(target)).mtimeMs, mtime1);

      const drifted = Buffer.from('{"ok":false}\n', "utf8");
      await writeFileUnlessSameBytes(target, drifted);
      assert.deepEqual(await fs.readFile(target), drifted);

      const blockedDir = path.join(tmp, "blocked-as-file");
      await fs.writeFile(blockedDir, "not-a-dir\n");
      const nested = path.join(blockedDir, "child.json");
      const expectedCode = process.platform === "win32" ? "ENOENT" : "ENOTDIR";
      await assert.rejects(
        () => writeFileUnlessSameBytes(nested, payload),
        (err) => {
          // The platform contract is intentionally exact: POSIX reports
          // ENOTDIR for a child below a regular file; native Windows reports
          // ENOENT for the same blocked path.
          return err?.code === expectedCode;
        }
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
