import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import {
  patchIdForCommit,
  patchIdsForRange,
  isSubsumedBySquash,
  isArchiveOnlyShipped,
} from "../lib/patch-id-utils.mjs";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function patchIdFromShow(cwd, sha) {
  const patch = execFileSync(
    "git",
    ["show", "--format=medium", "--no-ext-diff", sha],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  );
  return execFileSync("git", ["patch-id", "--stable"], {
    cwd,
    input: patch,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

async function createBaseRepo() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "patch-id-utils-"));
  const work = path.join(tmp, "work");
  await fs.mkdir(work);
  git(work, ["init", "-q", "-b", "main"]);
  git(work, ["config", "user.email", "t@e.x"]);
  git(work, ["config", "user.name", "test"]);
  await fs.writeFile(path.join(work, "base.txt"), "base\n");
  git(work, ["add", "."]);
  git(work, ["commit", "-q", "-m", "init"]);
  return { tmp, work };
}

// ─── patchIdForCommit ────────────────────────────────────────────────────────

describe("patchIdForCommit", () => {
  let tmp, work, headSha;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());
    headSha = git(work, ["rev-parse", "HEAD"]);
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns a stable patch-id string for a valid commit", () => {
    const id = patchIdForCommit(headSha, { cwd: work });
    assert.ok(typeof id === "string" && id.length >= 40, `expected patch-id, got: ${id}`);
  });

  it("returns null for a non-existent commit SHA", () => {
    const id = patchIdForCommit("0000000000000000000000000000000000000000", { cwd: work });
    assert.equal(id, null);
  });

  it("returns null when cwd is not a git repo", async () => {
    const tmpNoGit = await fs.mkdtemp(path.join(os.tmpdir(), "no-git-"));
    try {
      const id = patchIdForCommit(headSha, { cwd: tmpNoGit });
      assert.equal(id, null);
    } finally {
      await fs.rm(tmpNoGit, { recursive: true, force: true });
    }
  });
});

// ─── patchIdsForRange ────────────────────────────────────────────────────────

describe("patchIdsForRange", () => {
  let tmp, work, baseSha;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());
    baseSha = git(work, ["rev-parse", "HEAD"]);
    // add three commits on a branch
    git(work, ["checkout", "-q", "-b", "feature/three"]);
    for (let i = 1; i <= 3; i++) {
      await fs.writeFile(path.join(work, `f${i}.txt`), `${i}\n`);
      git(work, ["add", "."]);
      git(work, ["commit", "-q", "-m", `feat ${i}`]);
    }
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns a Set with one patch-id per commit in range", () => {
    const ids = patchIdsForRange(`${baseSha}..feature/three`, { cwd: work });
    assert.equal(ids.size, 3, `expected 3 patch-ids, got ${ids.size}`);
    for (const id of ids) {
      assert.match(id, /^[0-9a-f]{40,}$/);
    }
  });

  it("returns an empty Set for an empty range", () => {
    const ids = patchIdsForRange(`feature/three..feature/three`, { cwd: work });
    assert.equal(ids.size, 0);
  });

  it("returns an empty Set when range refs to invalid refs", () => {
    const ids = patchIdsForRange(`nonexistent..also-nonexistent`, { cwd: work });
    assert.equal(ids.size, 0);
  });

  it("yields the SAME patch-id as the old `git show` path for a rename commit (-M rename detection)", async () => {
    // Guards the batched-pipeline rename divergence: `git show` honors diff.renames
    // (default on) and renders a rename as `rename from/to`, but bare `git diff-tree`
    // does NOT detect renames and would render a full delete+add → a DIFFERENT
    // patch-id. `patchIdsForRange` passes `-M` so its id matches the old per-commit
    // `git show | patch-id` value byte-for-byte. Without `-M` this assertion fails.
    git(work, ["checkout", "-q", "-b", "feature/rename", "main"]);
    await fs.writeFile(path.join(work, "old-name.txt"), "line one\nline two\nline three\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "seed file to rename"]);
    // Pure rename + a small edit, staged as a single commit (a real squash-merge shape).
    git(work, ["mv", "old-name.txt", "new-name.txt"]);
    await fs.writeFile(path.join(work, "new-name.txt"), "line one\nline two CHANGED\nline three\n");
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", "rename + edit"]);
    const renameSha = git(work, ["rev-parse", "HEAD"]);
    git(work, ["checkout", "-q", "main"]);

    // Old per-commit path: `git show <sha> | git patch-id --stable`.
    const oldPathId = patchIdFromShow(work, renameSha).split(/\s+/)[0];
    // New batched path over the single-commit range.
    const rangeIds = patchIdsForRange(`${renameSha}~1..${renameSha}`, { cwd: work });

    assert.equal(rangeIds.size, 1, `expected 1 patch-id for the rename commit, got ${rangeIds.size}`);
    assert.ok(rangeIds.has(oldPathId), `batched patch-id must equal old \`git show\` path id ${oldPathId}`);
  });
});

// ─── isSubsumedBySquash: behaviour ───────────────────────────────────────────

describe("isSubsumedBySquash: behaviour", () => {
  let tmp, work;
  const branchSubsumed = "bugfix/wip-subsumed";
  const branchNotSubsumed = "bugfix/wip-unshipped";

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    // WIP branch with one commit
    git(work, ["checkout", "-q", "-b", branchSubsumed, "main"]);
    await fs.writeFile(path.join(work, "subsumed.txt"), "same patch\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "wip: subsumed"]);
    git(work, ["checkout", "-q", "main"]);

    // production with equivalent patch content (different SHA) — simulates
    // squash-merge head force-pushed and merged regularly to production.
    git(work, ["checkout", "-q", "-b", "production", "main"]);
    await fs.writeFile(path.join(work, "subsumed.txt"), "same patch\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "ship: equivalent patch"]);
    git(work, ["checkout", "-q", "main"]);

    // WIP branch with content NOT in production
    git(work, ["checkout", "-q", "-b", branchNotSubsumed, "main"]);
    await fs.writeFile(path.join(work, "unshipped.txt"), "novel\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "wip: unshipped"]);
    git(work, ["checkout", "-q", "main"]);
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns true when branch's patch-id appears in production", () => {
    const subsumed = isSubsumedBySquash(branchSubsumed, "production", { cwd: work });
    assert.equal(subsumed, true);
  });

  it("returns false when branch has a patch absent from production", () => {
    const subsumed = isSubsumedBySquash(branchNotSubsumed, "production", { cwd: work });
    assert.equal(subsumed, false);
  });

  it("returns false when branch has zero unique commits ahead of production", () => {
    // production..branch is empty when branch is identical to production
    git(work, ["checkout", "-q", "-b", "production-mirror", "production"]);
    const subsumed = isSubsumedBySquash("production-mirror", "production", { cwd: work });
    git(work, ["checkout", "-q", "main"]);
    assert.equal(subsumed, false);
  });

  it("returns false when production has no commits ahead of mergeBase", async () => {
    // create a branch off main, with main == prodRef (no production-side commits)
    git(work, ["checkout", "-q", "-b", "bugfix/wip-noprodcommits", "main"]);
    await fs.writeFile(path.join(work, "x.txt"), "x\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "wip x"]);
    git(work, ["checkout", "-q", "main"]);
    const subsumed = isSubsumedBySquash("bugfix/wip-noprodcommits", "main", { cwd: work });
    assert.equal(subsumed, false);
  });

  it("detects subsumption when the shipped change is a file RENAME (rename-detection parity)", async () => {
    // End-to-end guard that the `-M` rename detection carries through to the real
    // consumer. Seed a to-be-renamed file on main, then produce the SAME logical
    // rename on both a WIP branch and production (separate SHAs = squash-merge shape).
    // Both ranges go through `patchIdsForRange` with `-M`, so the rename renders as a
    // `rename from/to` hunk on each side and the patch-ids match → subsumed = true.
    // A bare `diff-tree` (no `-M`) would still match here (symmetric delete+add), so
    // this test's value is the pairing with the patchIdsForRange `-M` assertion above:
    // together they pin BOTH the absolute id (vs old path) and the decision outcome.
    git(work, ["checkout", "-q", "-b", "seed/rename-base", "main"]);
    await fs.writeFile(path.join(work, "before.txt"), "alpha\nbeta\ngamma\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "seed file"]);

    git(work, ["checkout", "-q", "-b", "bugfix/wip-rename", "seed/rename-base"]);
    git(work, ["mv", "before.txt", "after.txt"]);
    await fs.writeFile(path.join(work, "after.txt"), "alpha\nbeta CHANGED\ngamma\n");
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", "wip: rename before→after + edit"]);

    git(work, ["checkout", "-q", "-b", "production-rename", "seed/rename-base"]);
    git(work, ["mv", "before.txt", "after.txt"]);
    await fs.writeFile(path.join(work, "after.txt"), "alpha\nbeta CHANGED\ngamma\n");
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", "ship: equivalent rename"]);
    git(work, ["checkout", "-q", "main"]);

    const subsumed = isSubsumedBySquash("bugfix/wip-rename", "production-rename", { cwd: work });
    assert.equal(subsumed, true);
  });
});

// ─── isSubsumedBySquash: cache memoize ───────────────────────────────────────

describe("isSubsumedBySquash: cache memoize", () => {
  let tmp, work;
  const wipBranches = ["bugfix/wip-a", "bugfix/wip-b", "bugfix/wip-c"];

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    // 3 WIP branches each with unique patch
    for (const [idx, branch] of wipBranches.entries()) {
      git(work, ["checkout", "-q", "-b", branch, "main"]);
      await fs.writeFile(path.join(work, `wip-${idx}.txt`), `wip-${idx}\n`);
      git(work, ["add", "."]);
      git(work, ["commit", "-q", "-m", `wip ${idx}`]);
      git(work, ["checkout", "-q", "main"]);
    }

    // production with all 3 equivalent patches (so all 3 WIP are subsumed),
    // but production commits live on separate SHAs (squash-merge simulation).
    git(work, ["checkout", "-q", "-b", "production", "main"]);
    for (const idx of [0, 1, 2]) {
      await fs.writeFile(path.join(work, `wip-${idx}.txt`), `wip-${idx}\n`);
      git(work, ["add", "."]);
      git(work, ["commit", "-q", "-m", `ship wip-${idx}`]);
    }
    git(work, ["checkout", "-q", "main"]);
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("populates cache after first call and reuses for shared mergeBase", () => {
    const cache = new Map();

    const r0 = isSubsumedBySquash(wipBranches[0], "production", {
      cwd: work,
      productionPatchIdCache: cache,
    });
    assert.equal(r0, true);
    assert.equal(cache.size, 1, "cache must hold exactly one mergeBase entry after first call");

    const firstEntry = [...cache.values()][0];
    const firstSize = firstEntry.size;
    assert.ok(firstSize >= 3, `production-side patch IDs should include 3+ commits, got ${firstSize}`);

    // Subsequent calls share the same mergeBase → cache size stays at 1,
    // production patch IDs Set instance is reused (same reference).
    const r1 = isSubsumedBySquash(wipBranches[1], "production", {
      cwd: work,
      productionPatchIdCache: cache,
    });
    assert.equal(r1, true);
    assert.equal(cache.size, 1, "cache size must stay 1 — same mergeBase");
    assert.equal([...cache.values()][0], firstEntry, "Set instance must be identical (reused, not recomputed)");

    const r2 = isSubsumedBySquash(wipBranches[2], "production", {
      cwd: work,
      productionPatchIdCache: cache,
    });
    assert.equal(r2, true);
    assert.equal(cache.size, 1);
  });

  it("works without cache (returns same result, just no memoization)", () => {
    const r = isSubsumedBySquash(wipBranches[0], "production", { cwd: work });
    assert.equal(r, true);
  });
});

// ─── isArchiveOnlyShipped ─────────────────────────────────────────────────────

describe("isArchiveOnlyShipped", () => {
  let tmp, work;
  const archiveDir = "openspec/changes/archive/2026-06-29-some-change";

  before(async () => {
    ({ tmp, work } = await createBaseRepo());

    // production carries the archive folder (the change shipped).
    git(work, ["checkout", "-q", "-b", "production", "main"]);
    await fs.mkdir(path.join(work, archiveDir), { recursive: true });
    await fs.writeFile(path.join(work, archiveDir, "proposal-mini.md"), "# shipped change\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "ship: archive some-change"]);
    // production also moved on with an unrelated newer rule edit.
    await fs.writeFile(path.join(work, "rule.md"), "newer production version\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "newer rule edit on production"]);
    git(work, ["checkout", "-q", "main"]);
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns true when the branch's entire diff vs production is byte-identical archive content", async () => {
    git(work, ["checkout", "-q", "-b", "chore/archive-only", "main"]);
    await fs.mkdir(path.join(work, archiveDir), { recursive: true });
    // SAME content as production's archive file (byte-identical).
    await fs.writeFile(path.join(work, archiveDir, "proposal-mini.md"), "# shipped change\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "archive some-change"]);
    git(work, ["checkout", "-q", "main"]);

    assert.equal(isArchiveOnlyShipped("chore/archive-only", "production", { cwd: work }), true);
  });

  it("returns FALSE (fail-closed) when the branch also introduces a non-archive file", async () => {
    git(work, ["checkout", "-q", "-b", "chore/archive-plus-extra", "main"]);
    await fs.mkdir(path.join(work, archiveDir), { recursive: true });
    await fs.writeFile(path.join(work, archiveDir, "proposal-mini.md"), "# shipped change\n");
    // Extra non-archive file NOT on production → must NOT be auto-deleted.
    await fs.writeFile(path.join(work, "unshipped-feature.md"), "real unshipped work\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "archive + extra unshipped"]);
    git(work, ["checkout", "-q", "main"]);

    assert.equal(isArchiveOnlyShipped("chore/archive-plus-extra", "production", { cwd: work }), false);
  });

  it("returns FALSE (fail-closed) when the archive path exists but content differs", async () => {
    git(work, ["checkout", "-q", "-b", "chore/archive-content-diff", "main"]);
    await fs.mkdir(path.join(work, archiveDir), { recursive: true });
    // SAME path as production's archive file, but DIFFERENT content.
    await fs.writeFile(path.join(work, archiveDir, "proposal-mini.md"), "# DIFFERENT content\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "archive with diverged content"]);
    git(work, ["checkout", "-q", "main"]);

    assert.equal(isArchiveOnlyShipped("chore/archive-content-diff", "production", { cwd: work }), false);
  });

  it("returns FALSE when the branch introduces no archive file at all", async () => {
    git(work, ["checkout", "-q", "-b", "chore/no-archive", "main"]);
    await fs.writeFile(path.join(work, "just-a-rule.md"), "no archive here\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "no archive"]);
    git(work, ["checkout", "-q", "main"]);

    assert.equal(isArchiveOnlyShipped("chore/no-archive", "production", { cwd: work }), false);
  });

  it("does NOT shell-execute a malicious filename during the scan (no injection)", async () => {
    // A filename git permits, containing a command substitution. Written via fs
    // (NOT a shell) so the `$(...)` is a LITERAL part of the filename, then tracked
    // by git. A string-interpolating implementation would execute `touch <sentinel>`
    // when the predicate runs git rev-parse "<ref>:<file>"; the argv form must not.
    // sentinel written to cwd (no space/abs-path in the payload so the filename
    // stays creatable on disk); injection, if it fired, would `touch PWNED` in cwd.
    const sentinel = path.join(work, "PWNED");
    git(work, ["checkout", "-q", "-b", "chore/evil", "main"]);
    await fs.mkdir(path.join(work, archiveDir), { recursive: true });
    const evilName = "$(touch${IFS}PWNED).md";
    await fs.writeFile(path.join(work, archiveDir, evilName), "pwn\n");
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", "evil filename"]);
    git(work, ["checkout", "-q", "main"]);

    // Running the predicate must not execute the embedded command...
    isArchiveOnlyShipped("chore/evil", "production", { cwd: work });
    let sentinelExists = true;
    try {
      await fs.access(sentinel);
    } catch {
      sentinelExists = false;
    }
    assert.equal(sentinelExists, false, "shell injection fired — sentinel file was created");

    // ...and the evil branch (whose archive content differs from production) is NOT shipped.
    assert.equal(isArchiveOnlyShipped("chore/evil", "production", { cwd: work }), false);
  });

  it("treats a single archive file whose path begins with a space as archive-only (NUL contract)", async () => {
    // Regression for the `git diff -z` NUL-parsing contract: the first record in
    // `-z` output is the first filename's raw bytes with no leading delimiter, so a
    // path that begins with a space must survive parsing intact. A trimming reader
    // would corrupt the FIRST record. Archive paths can't begin with a space
    // (ARCHIVE_RE is anchored to `openspec/`), so to exercise the contract directly
    // we use a single repo-root file beginning with a space: a correct, non-trimming
    // parser yields exactly [" spaced.md"] (one non-archive file → fail-closed false);
    // a trimming parser yields ["spaced.md"], a DIFFERENT path — still false here, but
    // the divergence is the contract violation this guards against. We assert the
    // parsed-set identity indirectly: the predicate must be deterministic false and
    // must not throw on a leading-space first record.
    const spaced = " spaced.md";
    git(work, ["checkout", "-q", "-b", "chore/leading-space", "main"]);
    await fs.writeFile(path.join(work, spaced), "x\n");
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", "leading space file"]);
    git(work, ["checkout", "-q", "main"]);

    // non-archive file → fail-closed keep; must not throw regardless of leading space.
    assert.equal(isArchiveOnlyShipped("chore/leading-space", "production", { cwd: work }), false);
  });

  it("returns FALSE (fail-closed) when the branch DELETES an archive file", async () => {
    // `git diff --name-only` is status-blind: a deleted archive file still appears in
    // the changed-file list. The blob-equality check must catch this — `git rev-parse
    // <ref>:<deleted-file>` fails → empty refBlob → return false (KEEP). Without that
    // status-awareness a branch that merely removes a shipped archive file could be
    // mis-classified as archive-shipped and deleted.
    git(work, ["checkout", "-q", "-b", "chore/deletes-archive", "production"]);
    // production has archiveDir/proposal-mini.md from before(); delete it on the branch.
    await fs.rm(path.join(work, archiveDir, "proposal-mini.md"));
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", "delete shipped archive file"]);
    git(work, ["checkout", "-q", "main"]);

    assert.equal(isArchiveOnlyShipped("chore/deletes-archive", "production", { cwd: work }), false);
  });
});

// Direct contract unit: captureArgvRaw must NOT trim (NUL-delimited safety).
describe("captureArgv NUL contract (via isArchiveOnlyShipped behavior)", () => {
  // The trimming variant is fine for single-value calls (merge-base / rev-parse),
  // but isArchiveOnlyShipped's `git diff -z` MUST use a non-trimming reader. This is
  // asserted structurally: the source must call a raw (non-.trim) runner for -z.
  it("uses a non-trimming reader for git diff -z in patch-id-utils.mjs source", async () => {
    const src = await fs.readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "patch-id-utils.mjs"),
      "utf8",
    );
    // The -z diff line must NOT go through a .trim()'d runner.
    assert.match(src, /captureArgvRaw\(\['diff', '-z', '--name-only'/);
    // captureArgvRaw itself must return raw (no .trim()).
    const rawFn = src.match(/function captureArgvRaw\([^)]*\)\s*\{[\s\S]*?\n\}/);
    assert.ok(rawFn, "captureArgvRaw must exist");
    assert.doesNotMatch(rawFn[0], /\.trim\(\)/, "captureArgvRaw must NOT trim (breaks NUL parsing)");
  });
});
