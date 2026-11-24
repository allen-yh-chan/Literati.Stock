// D15 (F) negative / race tests for the spawn admission record carrier
// (strengthen-subagent-delegation-strategy design D15: identifier validation,
// (B) Create with O_EXCL|O_NOFOLLOW + same-inode proof + realpath(parent)
// recheck, (C) Read with O_NOFOLLOW + same-inode + prefix containment).
// Written before the implementation (TDD); each case must fail closed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectedNodeModeBits } from "./lib/expected-node-mode-bits.mjs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  claimAdmissionRecord,
  parseAdmissionFields,
  readAdmissionRecord,
  readAdmissionRecordClaim,
  resolveChangeIdFromCwd,
  writeAdmissionRecord,
} from "../hooks/lib/admission-record.mjs";
import { SOURCE_ROOT } from "./lib/repo-root.mjs";

const CHANGE = "strengthen-subagent-delegation-strategy";
const FIELDS = parseAdmissionFields([
  "objective: independent-judgment",
  "responsibility_id: d15-path-safety",
  "instance_mode: fresh",
  "evidence_scope: design.md §D15",
  "return_and_stop: result JSON; stop",
  "role: dp-reviewer",
].join("\n")).fields;
const UUID = "0f7c1c1e-6d0b-4b6e-9a3d-2f0a6c9b1d11";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function resolveActiveOrArchivedArtifact({ repoRoot, changeId, relativePath }) {
  const changesRoot = path.join(repoRoot, "openspec", "changes");
  const active = path.join(changesRoot, changeId, relativePath);
  const archiveRoot = path.join(changesRoot, "archive");
  const archived = fs.existsSync(archiveRoot)
    ? fs.readdirSync(archiveRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(`-${changeId}`))
      .map((entry) => path.join(archiveRoot, entry.name, relativePath))
      .filter((candidate) => fs.existsSync(candidate))
    : [];
  const candidates = [active, ...archived].filter((candidate) => fs.existsSync(candidate));
  assert.equal(candidates.length, 1, `exactly one active-or-archived artifact must resolve for ${changeId}`);
  return candidates[0];
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "admission-d15-"));
  const cwd = path.join(root, ".worktree", CHANGE);
  const changeDir = path.join(cwd, "openspec", "changes", CHANGE);
  fs.mkdirSync(changeDir, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  spawnSync("git", ["init", "-q"], { cwd, env });
  spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd, env });
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(elsewhere);
  return { root, cwd, changeDir, recordsDir: path.join(changeDir, "admission-records"), elsewhere };
}

function write(f, extra = {}) {
  return writeAdmissionRecord({ cwd: f.cwd, host: "claude-code", prompt: "p", fields: FIELDS, roleBinding: "host-verified", ...extra });
}

test("(1) create into a symlinked parent is rejected and nothing lands behind the link", () => {
  const f = fixture();
  fs.symlinkSync(f.elsewhere, f.recordsDir, "dir");
  const result = write(f);
  assert.equal(result.ok, false);
  assert.equal(result.code, "admission-records-dir-invalid");
  assert.deepEqual(fs.readdirSync(f.elsewhere), []);
});
test("(2) existing target is EEXIST-rejected and left byte-identical", () => {
  const f = fixture();
  fs.mkdirSync(f.recordsDir);
  const target = path.join(f.recordsDir, `${UUID}.json`);
  fs.writeFileSync(target, "{\"pre\":true}\n");
  const result = write(f, { uuid: () => UUID });
  assert.equal(result.ok, false);
  assert.equal(result.code, "admission-record-write-failed");
  assert.equal(fs.readFileSync(target, "utf8"), "{\"pre\":true}\n");
});

test("(3) a symlink at the target path is rejected by O_NOFOLLOW/O_EXCL and its destination is untouched", () => {
  const f = fixture();
  fs.mkdirSync(f.recordsDir);
  const victim = path.join(f.elsewhere, "victim.json");
  fs.writeFileSync(victim, "victim\n");
  fs.symlinkSync(victim, path.join(f.recordsDir, `${UUID}.json`), "file");
  const result = write(f, { uuid: () => UUID });
  assert.equal(result.ok, false);
  assert.equal(result.code, "admission-record-write-failed");
  assert.equal(fs.readFileSync(victim, "utf8"), "victim\n");
});

test("(4) parent swapped to a symlink between check and open is detected by the realpath recheck, file unlinked, admission fails closed", () => {
  const f = fixture();
  fs.mkdirSync(f.recordsDir);
  const beforeOpen = () => {
    fs.renameSync(f.recordsDir, `${f.recordsDir}.moved`);
    fs.symlinkSync(f.elsewhere, f.recordsDir, "dir");
  };
  const result = write(f, { uuid: () => UUID, hooks: { beforeOpen } });
  assert.equal(result.ok, false);
  assert.equal(result.code, "admission-record-write-failed");
  assert.deepEqual(fs.readdirSync(f.elsewhere), [], "the file created behind the swapped parent must be unlinked");
  assert.deepEqual(fs.readdirSync(`${f.recordsDir}.moved`), []);
});

test("(5) reading a symlinked record is rejected even when it points at a valid record", () => {
  const f = fixture();
  const written = write(f);
  assert.equal(written.ok, true);
  const alias = "1b2f3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  fs.symlinkSync(path.join(f.recordsDir, `${written.record_id}.json`), path.join(f.recordsDir, `${alias}.json`), "file");
  const direct = readAdmissionRecord({ repoRoot: f.cwd, changeId: CHANGE, recordId: written.record_id });
  assert.equal(direct.ok, true);
  assert.equal(direct.digest, written.digest);
  const viaLink = readAdmissionRecord({ repoRoot: f.cwd, changeId: CHANGE, recordId: alias });
  assert.equal(viaLink.ok, false);
  assert.equal(viaLink.code, "admission-record-unreadable");
});

test("(6) a non-regular file at the record path is rejected on read, and non-UUID / bad change ids never touch the filesystem", () => {
  const f = fixture();
  fs.mkdirSync(f.recordsDir);
  fs.mkdirSync(path.join(f.recordsDir, `${UUID}.json`));
  const dir = readAdmissionRecord({ repoRoot: f.cwd, changeId: CHANGE, recordId: UUID });
  assert.equal(dir.ok, false);
  assert.equal(dir.code, "admission-record-unreadable");
  for (const recordId of ["../../evil", "not-a-uuid", `${UUID}/x`, "0f7c1c1e-6d0b-1b6e-9a3d-2f0a6c9b1d11"]) {
    assert.deepEqual(readAdmissionRecord({ repoRoot: f.cwd, changeId: CHANGE, recordId }), { ok: false, code: "admission-record-id-invalid" });
  }
  assert.deepEqual(readAdmissionRecord({ repoRoot: f.cwd, changeId: "../strengthen", recordId: UUID }), { ok: false, code: "change-id-invalid" });
});

test("(7) the record is fsynced with its full body before writeAdmissionRecord returns", () => {
  const f = fixture();
  const seen = [];
  const fsyncFile = (fd) => { seen.push(fs.fstatSync(fd).size); };
  const result = write(f, { hooks: { fsyncFile } });
  assert.equal(result.ok, true);
  const body = fs.readFileSync(path.join(f.recordsDir, `${result.record_id}.json`));
  assert.deepEqual(seen, [body.length], "fsync must run exactly once, after the whole body was written");
  assert.equal(
    fs.statSync(path.join(f.recordsDir, `${result.record_id}.json`)).mode & 0o777,
    expectedNodeModeBits(0o600),
  );
});

test("(8) read and write both resolve the archived change folder after archive; symlinked archive entries never resolve", () => {
  const f = fixture();
  const written = write(f);
  assert.equal(written.ok, true);
  const archiveRoot = path.join(f.cwd, "openspec", "changes", "archive");
  fs.mkdirSync(archiveRoot);
  const archived = path.join(archiveRoot, `2026-09-03-${CHANGE}`);
  fs.renameSync(f.changeDir, archived);
  const read = readAdmissionRecord({ repoRoot: f.cwd, changeId: CHANGE, recordId: written.record_id });
  assert.equal(read.ok, true, read.code);
  assert.equal(read.digest, written.digest);
  assert.equal(read.record.record_id, written.record_id);
  // D50 supersedes D18 (iv)'s write-side active-only clause: pre-PR Step 5.5.3
  // dispatches dp-second-reviewer after `openspec archive`, so a write-side
  // that only knew the active folder failed closed on exactly the dispatch the
  // archive step hands off to.
  const late = write(f);
  assert.equal(late.ok, true, late.code);
  const lateFile = path.join(archived, "admission-records", `${late.record_id}.json`);
  assert.equal(fs.existsSync(lateFile), true, "the post-archive record lands in the archived folder");
  assert.equal(readAdmissionRecord({ repoRoot: f.cwd, changeId: CHANGE, recordId: late.record_id }).digest, late.digest);
  assert.equal(fs.existsSync(f.changeDir), false, "the writer must not recreate the active folder");
  const moved = path.join(f.elsewhere, "archived-copy");
  fs.renameSync(archived, moved);
  fs.symlinkSync(moved, archived, "dir");
  const viaLink = readAdmissionRecord({ repoRoot: f.cwd, changeId: CHANGE, recordId: written.record_id });
  assert.equal(viaLink.ok, false);
  assert.equal(viaLink.code, "admission-record-unreadable");
  // D51: the symlinked archive entry exists, so the writer keeps failing closed
  // rather than degrading into the absent-folder pass below.
  assert.equal(write(f).code, "admission-records-dir-invalid");
});

test("(9) an absent change folder is distinguished from a faulty one: absent passes without a record, existing-but-not-plain still blocks", () => {
  // D51: chore-A entry (a) never creates `openspec/changes/<change_id>/`, so the
  // writer reports `change-dir-absent` and the gate admits without a record. A
  // symlink at either location is a different verdict — collapsing the two would
  // let a planted link silence the gate instead of blocking it.
  const f = fixture();
  fs.rmSync(f.changeDir, { recursive: true });
  assert.equal(write(f).code, "change-dir-absent");
  fs.symlinkSync(f.elsewhere, f.changeDir, "dir");
  assert.equal(write(f).code, "admission-records-dir-invalid");
  fs.unlinkSync(f.changeDir);
  const archiveRoot = path.join(f.cwd, "openspec", "changes", "archive");
  fs.mkdirSync(archiveRoot);
  const archived = path.join(archiveRoot, `2026-09-04-${CHANGE}`);
  fs.symlinkSync(f.elsewhere, archived, "dir");
  assert.equal(write(f).code, "admission-records-dir-invalid", "a symlinked archive entry exists and must block");
  assert.deepEqual(fs.readdirSync(f.elsewhere), []);
  fs.unlinkSync(archived);
  assert.equal(write(f).code, "change-dir-absent", "removing the last entry returns to the absent verdict");
});

test("(9a) an invalid active entry blocks even when a valid archived change exists", () => {
  const f = fixture();
  const archiveRoot = path.join(f.cwd, "openspec", "changes", "archive");
  const archived = path.join(archiveRoot, `2026-09-04-${CHANGE}`);
  fs.mkdirSync(archiveRoot);
  fs.renameSync(f.changeDir, archived);
  fs.symlinkSync(f.elsewhere, f.changeDir, "dir");

  const result = write(f);
  assert.equal(result.ok, false);
  assert.equal(result.code, "admission-records-dir-invalid", "an existing invalid active carrier must not fall through to archive");
  assert.equal(fs.existsSync(path.join(archived, "admission-records")), false, "the blocked write must not land in the valid archive");
});

test("(9b) a non-directory active entry also blocks a valid archived change", () => {
  const f = fixture();
  const archiveRoot = path.join(f.cwd, "openspec", "changes", "archive");
  const archived = path.join(archiveRoot, `2026-09-04-${CHANGE}`);
  fs.mkdirSync(archiveRoot);
  fs.renameSync(f.changeDir, archived);
  fs.writeFileSync(f.changeDir, "not a directory\n");

  const result = write(f);
  assert.equal(result.ok, false);
  assert.equal(result.code, "admission-records-dir-invalid", "a non-directory active carrier must not fall through to archive");
  assert.equal(fs.existsSync(path.join(archived, "admission-records")), false, "the blocked write must not land in the valid archive");
});

test("(9c) canonical and delta contracts state active-invalid precedence without archive-fallback ambiguity", () => {
  const specs = [
    path.join(SOURCE_ROOT, "openspec/specs/pre-tool-mechanical-gates/spec.md"),
    resolveActiveOrArchivedArtifact({
      repoRoot: REPO_ROOT,
      changeId: "fix-zero-value-review-rounds",
      relativePath: "specs/pre-tool-mechanical-gates/spec.md",
    }),
  ];
  for (const specPath of specs) {
    const body = fs.readFileSync(specPath, "utf8");
    assert.match(body, /archive fallback is permitted only when the active entry is proven absent/i, `${specPath}: fallback requires proven absence`);
    assert.match(body, /an existing active entry that is not a plain directory MUST block without archive fallback/i, `${specPath}: invalid active entry has normative precedence`);
  }
});

test("(9d) self-change artifact resolution covers active, archived, missing, and ambiguous states before archive", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "self-change-artifact-"));
  const changeId = "self-change";
  const relativePath = "specs/example/spec.md";
  const active = path.join(repoRoot, "openspec", "changes", changeId, relativePath);
  fs.mkdirSync(path.dirname(active), { recursive: true });
  fs.writeFileSync(active, "active\n");
  assert.equal(resolveActiveOrArchivedArtifact({ repoRoot, changeId, relativePath }), active);

  const archiveDir = path.join(repoRoot, "openspec", "changes", "archive", `2026-09-10-${changeId}`);
  const archived = path.join(archiveDir, relativePath);
  fs.mkdirSync(path.dirname(archiveDir), { recursive: true });
  fs.renameSync(path.join(repoRoot, "openspec", "changes", changeId), archiveDir);
  assert.equal(resolveActiveOrArchivedArtifact({ repoRoot, changeId, relativePath }), archived);

  fs.mkdirSync(path.dirname(active), { recursive: true });
  fs.writeFileSync(active, "active-again\n");
  assert.throws(() => resolveActiveOrArchivedArtifact({ repoRoot, changeId, relativePath }), /exactly one active-or-archived artifact/);
  fs.rmSync(active);
  fs.rmSync(archived);
  assert.throws(() => resolveActiveOrArchivedArtifact({ repoRoot, changeId, relativePath }), /exactly one active-or-archived artifact/);
});

// Round-15 review F-r15-absent-verdict-swallows-non-enoent-lstat-and-readdir-faults:
// D51's pass hinges on "no entry at all at either location". A bare catch also
// swallows non-ENOENT inventory failures, which can turn uncertainty into a
// silent bypass. A regular file at the archive root is a deterministic
// cross-platform ENOTDIR fixture; using a file as an ancestor instead is not
// portable because Win32 may report ENOENT for a descendant below that file.
test("(10) a non-missing archive inventory fault blocks instead of proving absence", () => {
  const f = fixture();
  const changesRoot = path.join(f.cwd, "openspec", "changes");
  fs.rmSync(path.join(changesRoot, CHANGE), { recursive: true, force: true });
  const archiveRoot = path.join(changesRoot, "archive");
  fs.writeFileSync(archiveRoot, "not a directory\n");
  const result = write(f);
  assert.equal(result.ok, false);
  assert.notEqual(result.code, "change-dir-absent", "an unlistable archive is not proof of absence");
  assert.equal(result.code, "admission-records-dir-invalid");
  assert.equal(fs.readFileSync(archiveRoot, "utf8"), "not a directory\n", "the blocked path writes nothing");
});

// strengthen-admission-binding-portability T4 (design D3): a main-rooted
// dispatch that declares its `change_id` writes only under the exact-one
// binding worktree — the wire record path, `head_sha`, and the primary change
// dir all come from the filesystem exact-one selection, never from the spawn
// cwd's checkout.
test("(D3) a main-rooted declared dispatch writes only under the exact-one binding worktree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "admission-declared-binding-"));
  const mainRoot = path.join(root, "main");
  const linkedRoot = path.join(mainRoot, ".worktree", CHANGE);
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8", env });
  fs.mkdirSync(path.join(mainRoot, "openspec", "changes", CHANGE), { recursive: true });
  fs.writeFileSync(path.join(mainRoot, ".gitignore"), ".worktree/\n");
  fs.writeFileSync(path.join(mainRoot, "openspec", "changes", CHANGE, "tasks.md"), "# Fixture\n");
  git(mainRoot, ["init", "-q", "-b", "main"]);
  git(mainRoot, ["add", ".gitignore", `openspec/changes/${CHANGE}/tasks.md`]);
  git(mainRoot, ["commit", "-qm", "seed"]);
  fs.mkdirSync(path.dirname(linkedRoot), { recursive: true });
  git(mainRoot, ["worktree", "add", "-q", "-b", `chore/${CHANGE}`, linkedRoot, "HEAD"]);
  fs.writeFileSync(path.join(linkedRoot, "worktree-only"), "wt\n");
  git(linkedRoot, ["add", "worktree-only"]);
  git(linkedRoot, ["commit", "-qm", "worktree tip"]);
  const mainTip = git(mainRoot, ["rev-parse", "HEAD"]).stdout.trim();
  const linkedTip = git(linkedRoot, ["rev-parse", "HEAD"]).stdout.trim();
  assert.notEqual(mainTip, linkedTip, "the fixture tips must diverge");

  const prompt = [
    "objective: independent-judgment",
    "responsibility_id: d15-path-safety",
    "instance_mode: fresh",
    "evidence_scope: design.md §D3",
    "return_and_stop: result JSON; stop",
    `change_id: ${CHANGE}`,
    `execution_root: ${linkedRoot}`,
    "role: dp-reviewer",
  ].join("\n");
  const result = writeAdmissionRecord({
    cwd: mainRoot,
    host: "claude-code",
    prompt,
    fields: parseAdmissionFields(prompt).fields,
    roleBinding: "host-verified",
  });
  assert.equal(result.ok, true, result.code);
  const linkedRecords = path.join(linkedRoot, "openspec", "changes", CHANGE, "admission-records");
  const mainRecords = path.join(mainRoot, "openspec", "changes", CHANGE, "admission-records");
  assert.deepEqual(fs.readdirSync(linkedRecords), [`${result.record_id}.json`]);
  const record = JSON.parse(fs.readFileSync(path.join(linkedRecords, `${result.record_id}.json`), "utf8"));
  assert.equal(record.change_id, CHANGE);
  assert.equal(record.head_sha, linkedTip);
  assert.equal(record.head_sha !== mainTip, true, "the main checkout HEAD MUST NOT be bound");
  assert.equal(fs.existsSync(mainRecords), false, "the primary change dir MUST NOT gain a record");
  fs.rmSync(root, { recursive: true, force: true });
});

// Round-1 review F-r1-admission-cwd-separator-posix-only: native Windows cwd
// separators resolve the change id too (the pattern accepts `\` and `/`).
// C-05 (PR #2473 second cross-model round): the record file is fsynced by
// `createExclusiveDurableFile`, and so is `admission-records/` (the directory
// holding it) — but nothing fsynced `changeDir`, which holds that directory's
// own mkdir entry. After a crash the first record of a change could therefore
// outlive the directory it lives in. `claimAdmissionRecord` already gets this
// right (`fsyncDirectory(dir)` after its own mkdir), which is exactly why the
// helper cannot be assumed to do it for the caller.
test("(C-05) the first record into a change fsyncs the change directory holding the new admission-records mkdir entry", () => {
  const f = fixture();
  const dirs = [];
  const result = write(f, { hooks: { fsyncDir: (d) => dirs.push(d) } });
  assert.equal(result.ok, true, `write failed: ${result.code ?? "ok"}`);
  const real = dirs.map((d) => fs.realpathSync(d));
  assert.ok(real.includes(fs.realpathSync(f.changeDir)), `the parent of the new admission-records/ must be fsynced; saw ${JSON.stringify(real)}`);
});

test("(R1) resolveChangeIdFromCwd accepts backslash, Git Bash, and forward-slash Windows cwd shapes", () => {
  assert.equal(resolveChangeIdFromCwd(`C:\\repo\\.worktree\\${CHANGE}\\sub`), CHANGE);
  assert.equal(resolveChangeIdFromCwd(`C:/repo/.worktree/${CHANGE}`), CHANGE);
  assert.equal(resolveChangeIdFromCwd(`/c/repo/.worktree/${CHANGE}/openspec`), CHANGE);
  assert.equal(resolveChangeIdFromCwd("/repo/.worktree/../escape"), null);
  assert.equal(resolveChangeIdFromCwd("/repo/worktree/not-a-change"), null);
});

// Round-1 review F-r1-admission-record-freeform-value-unguarded: the record is
// readable by anyone with the worktree and is quoted into PR bodies and receipts,
// so TL-typed free-text values that carry a user-home absolute path or a
// non-allowlisted email fail closed before any write.
test("(R2) free-text fields carrying a user-home absolute path or email are rejected and nothing is written", () => {
  const f = fixture();
  const cases = [
    { evidence_scope: "/Users/someone/repo/.devpro/scripts/x.mjs" },
    { return_and_stop: "/home/someone/out.json; stop" },
    { fork_reason: "C:\\Users\\someone\\notes" },
    { evidence_scope: "ask someone@example.invalid for the log" },
  ];
  for (const override of cases) {
    const result = write(f, { fields: { ...FIELDS, ...override } });
    assert.equal(result.ok, false, JSON.stringify(override));
    assert.equal(result.code, "admission-record-unsafe-value");
    assert.equal(result.field, Object.keys(override)[0]);
  }
  assert.equal(fs.existsSync(f.recordsDir), false);
  const allowed = write(f, { fields: { ...FIELDS, evidence_scope: ".devpro/scripts/x.mjs:12; https://example.com/doc", return_and_stop: "contact tl@example.com; stop" } });
  assert.equal(allowed.ok, true);
});

test("(R3) parent_record_id is conditional on instance_mode: continue, and only continue records carry the key", () => {
  const declare = (lines) => parseAdmissionFields([
    "objective: independent-judgment",
    "responsibility_id: d34-continuation",
    "evidence_scope: design.md §D34",
    "return_and_stop: result JSON; stop",
    "role: dp-reviewer",
    ...lines,
  ].join("\n"));

  const ok = declare(["instance_mode: continue", `parent_record_id: ${UUID}`]);
  assert.deepEqual([ok.missing, ok.invalid], [[], []]);
  const missingParent = declare(["instance_mode: continue"]);
  assert.deepEqual([missingParent.missing, missingParent.invalid], [["parent_record_id"], []]);
  const freshWithParent = declare(["instance_mode: fresh", `parent_record_id: ${UUID}`]);
  assert.deepEqual([freshWithParent.missing, freshWithParent.invalid], [[], ["parent_record_id"]]);
  const badShape = declare(["instance_mode: continue", "parent_record_id: ../../etc/passwd"]);
  assert.deepEqual([badShape.missing, badShape.invalid], [[], ["parent_record_id"]]);

  const f = fixture();
  const continued = write(f, { fields: ok.fields, roleBinding: "cooperative-only" });
  assert.equal(continued.ok, true);
  const record = JSON.parse(fs.readFileSync(path.join(f.recordsDir, `${continued.record_id}.json`), "utf8"));
  assert.equal(record.parent_record_id, UUID);
  assert.equal(record.instance_mode, "continue");

  const freshFixture = fixture();
  const fresh = write(freshFixture);
  assert.equal(fresh.ok, true);
  const freshRecord = JSON.parse(fs.readFileSync(path.join(freshFixture.recordsDir, `${fresh.record_id}.json`), "utf8"));
  assert.equal(Object.hasOwn(freshRecord, "parent_record_id"), false, "a fresh record keeps its existing key shape");
});

// ── cross-model second review on PR #2473 (head 19bd611c), CRITICAL 1: the
// containment anchor was the change directory, so a symlinked intermediate
// component (openspec/, openspec/changes/, openspec/changes/archive/) escaped
// the repository while every leaf check still passed. Every path component
// from repoRoot MUST be verified without following symlinks, and that anchor
// MUST hold for create, read, claim, and release alike.
test("(11) a symlinked intermediate component (openspec/changes) never resolves: write, read, and claim all fail closed and nothing lands behind the link", () => {
  const f = fixture();
  const written = write(f);
  assert.equal(written.ok, true, "sanity: a plain tree admits");
  const changesDir = path.join(f.cwd, "openspec", "changes");
  const moved = path.join(f.elsewhere, "changes");
  fs.renameSync(changesDir, moved);
  fs.symlinkSync(moved, changesDir, "dir");
  assert.equal(fs.lstatSync(path.join(changesDir, CHANGE)).isDirectory(), true, "the leaf behind the link is a plain directory (leaf-only checks pass)");
  const before = fs.readdirSync(path.join(moved, CHANGE, "admission-records"));
  assert.equal(write(f).code, "admission-records-dir-invalid", "write through a symlinked intermediate must fail closed");
  assert.deepEqual(fs.readdirSync(path.join(moved, CHANGE, "admission-records")), before, "nothing landed behind the link");
  const read = readAdmissionRecord({ repoRoot: f.cwd, changeId: CHANGE, recordId: written.record_id });
  assert.equal(read.ok, false, "read through a symlinked intermediate must fail closed");
  const claim = claimAdmissionRecord({ repoRoot: f.cwd, changeId: CHANGE, recordId: written.record_id, claim: { round_number: 1, head_sha: "a".repeat(40), responsibility_id: "d15-path-safety", dispatch_id: "b".repeat(64) } });
  assert.equal(claim.ok, false, "claim through a symlinked intermediate must fail closed");
  assert.equal(fs.existsSync(path.join(moved, CHANGE, "admission-records", `${written.record_id}.claim`)), false, "no claim directory behind the link");
});

test("(12) a symlinked archive intermediate (openspec/changes/archive) never resolves either", () => {
  const f = fixture();
  fs.rmSync(f.changeDir, { recursive: true, force: true });
  const archiveRoot = path.join(f.cwd, "openspec", "changes", "archive");
  const movedArchive = path.join(f.elsewhere, "archive");
  fs.mkdirSync(path.join(movedArchive, `2026-01-01-${CHANGE}`), { recursive: true });
  fs.symlinkSync(movedArchive, archiveRoot, "dir");
  assert.equal(fs.lstatSync(path.join(archiveRoot, `2026-01-01-${CHANGE}`)).isDirectory(), true, "the archived leaf behind the link is a plain directory");
  assert.equal(write(f).code, "admission-records-dir-invalid", "archived write through a symlinked intermediate must fail closed");
  assert.equal(fs.existsSync(path.join(movedArchive, `2026-01-01-${CHANGE}`, "admission-records")), false, "nothing landed behind the archive link");
});

// C-03 (PR #2473 second cross-model round): test (12) only covers a symlinked
// archive that DOES hold a matching entry, where the leaf lstat still reports
// "present" and the writer fails closed. When the link points somewhere with no
// matching entry, `admissionChangeEntryExists` followed it with a bare
// `readdirSync`, read nothing, and reported proven absence — so the same planted
// link that test (12) blocks became a PASS-without-a-record here. Its sibling
// `resolveAdmissionChangeDir` rejects that tree (every candidate goes through
// `anchoredPlainDirectory`, which walks from repoRoot), so the two functions
// disagreed about one tree: the resolver refused to resolve while the prober
// called it absent. Done When 8 requires absence to be PROVEN; a symlinked
// carrier proves nothing.
test("(13) a symlinked archive root with no matching entry is unproven absence, not proven absence", () => {
  const f = fixture();
  fs.rmSync(f.changeDir, { recursive: true, force: true });
  const archiveRoot = path.join(f.cwd, "openspec", "changes", "archive");
  const movedArchive = path.join(f.elsewhere, "empty-archive");
  fs.mkdirSync(movedArchive, { recursive: true });
  fs.rmSync(archiveRoot, { recursive: true, force: true });
  fs.symlinkSync(movedArchive, archiveRoot, "dir");
  assert.equal(fs.readdirSync(archiveRoot).length, 0, "sanity: following the link reads an empty directory");
  assert.notEqual(write(f).code, "change-dir-absent", "a symlinked archive root is not proof that the change is absent");
});

// CRITICAL 2: the parser accepted the final line of the 8 KiB prefix even when
// the prompt continued past the bound, so a header field could be admitted as
// a truncated prefix of its real value. A line cut by the bound is not a line.
function promptWithLineStraddlingBound(lastLine, cutInsideAt) {
  const head = ["objective: independent-judgment", "responsibility_id: prompt-bound", "instance_mode: fresh", "evidence_scope: design.md", "role: dp-reviewer"].join("\n") + "\n";
  const padBytes = 8192 - Buffer.byteLength(head, "utf8") - 1 - cutInsideAt;
  assert.ok(padBytes > 0);
  const prefix = head + "#".repeat(padBytes) + "\n";
  assert.equal(Buffer.byteLength(prefix, "utf8") + cutInsideAt, 8192, "the bound falls inside the last line");
  return prefix + lastLine + "\nafter the bound: more prompt text\n";
}

test("(P1) a header line cut by the 8 KiB bound is not parsed: the field is reported missing, never admitted as a truncated value", () => {
  const prompt = promptWithLineStraddlingBound("return_and_stop: keep going and stop", 24);
  assert.ok(Buffer.byteLength(prompt, "utf8") > 8192);
  const parsed = parseAdmissionFields(prompt);
  assert.equal(parsed.fields.return_and_stop, undefined, "no truncated value");
  assert.deepEqual(parsed.missing, ["return_and_stop"]);
  assert.deepEqual(parsed.invalid, []);
});

test("(P2) a multibyte character split by the bound never reaches a field value", () => {
  const prompt = promptWithLineStraddlingBound("return_and_stop: 回報後停止", "return_and_stop: 回".length + 1);
  const parsed = parseAdmissionFields(prompt);
  assert.equal(parsed.fields.return_and_stop, undefined);
  for (const value of Object.values(parsed.fields)) assert.equal(value.includes("\uFFFD"), false, "no replacement character in any admitted value");
  assert.deepEqual(parsed.missing, ["return_and_stop"]);
});

test("(P3) a prompt within the bound, or one whose header ends before the bound, is admitted exactly as before", () => {
  const six = ["objective: independent-judgment", "responsibility_id: prompt-bound", "instance_mode: fresh", "evidence_scope: design.md", "return_and_stop: result JSON; stop", "role: dp-reviewer"].join("\n");
  const exact = six + "\n" + "#".repeat(8192 - Buffer.byteLength(six, "utf8") - 1);
  assert.equal(Buffer.byteLength(exact, "utf8"), 8192);
  assert.deepEqual(parseAdmissionFields(exact).missing, [], "exactly 8 KiB with a complete last line is admitted");
  const longTail = six + "\n" + "#".repeat(20000);
  assert.deepEqual(parseAdmissionFields(longTail).missing, [], "a long prompt whose header is complete before the bound is admitted");
  assert.equal(parseAdmissionFields(longTail).fields.role, "dp-reviewer");
});

test("(D42) an admission claim is durable before proof publication and remains consumed after proof failure", () => {
  const f = fixture();
  const written = write(f);
  assert.equal(written.ok, true);
  const events = [];
  const first = claimAdmissionRecord({
    repoRoot: f.cwd,
    changeId: CHANGE,
    recordId: written.record_id,
    claim: { round_number: 1, head_sha: "a".repeat(40), responsibility_id: "irreversible", dispatch_id: "b".repeat(64) },
    hooks: {
      fsyncDir: (dir) => events.push(`fsync:${path.basename(dir)}`),
      beforeOpen: () => { events.push("proof"); throw new Error("injected proof fault"); },
    },
  });
  assert.deepEqual(first, { ok: false, code: "admission-claim-write-failed" });
  assert.deepEqual(events, ["fsync:admission-records", "proof"], "the winning mkdir is parent-fsynced before proof publication starts");
  assert.equal(
    claimAdmissionRecord({
      repoRoot: f.cwd,
      changeId: CHANGE,
      recordId: written.record_id,
      claim: { round_number: 1, head_sha: "a".repeat(40), responsibility_id: "irreversible", dispatch_id: "b".repeat(64) },
    }).code,
    "admission-record-already-claimed",
    "proof failure cannot recycle an irreversible claim",
  );
});
