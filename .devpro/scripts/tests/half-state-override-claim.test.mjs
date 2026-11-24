// T14 (strengthen-subagent-delegation-strategy design D12 + D15): half-state
// single-use override exact-once claim protocol. Seven acceptance cases plus
// the D15 (F) negative / race set for the `override-ledger/` carrier, plus the
// round-3 (R1) durability case for the carrier's tracking status.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { repoPath } from "./lib/repo-root.mjs";
import { expectedNodeModeBits } from "./lib/expected-node-mode-bits.mjs";
import {
  HALF_STATE_OVERRIDE_CLAIM_SCHEMA,
  HALF_STATE_OVERRIDE_SCHEMA,
  claimHalfStateOverride,
  hasConsumedHalfStateOverrideClaim,
  halfStateOverrideStatus,
  issueHalfStateOverride,
  readHalfStateOverride,
} from "../lib/half-state-override.mjs";

const CHANGE = "strengthen-subagent-delegation-strategy";
const UUID = "3e1d0c9b-8a7f-4e6d-9c5b-4a3f2e1d0c9b";
const DISPATCH_A = "a".repeat(64);
const LIB_URL = pathToFileURL(repoPath(".devpro/scripts/lib/half-state-override.mjs")).href;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "half-state-override-"));
  const changeDir = path.join(root, "openspec", "changes", CHANGE);
  fs.mkdirSync(changeDir, { recursive: true });
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(elsewhere);
  return { root, changeDir, ledgerDir: path.join(changeDir, "override-ledger"), elsewhere };
}

function issue(f, extra = {}) {
  return issueHalfStateOverride({ repoRoot: f.root, changeId: CHANGE, responsibilityId: "primary-review", reason: "user: 授權一次 review continuation", ...extra });
}

function claim(f, overrideId, extra = {}) {
  return claimHalfStateOverride({ repoRoot: f.root, changeId: CHANGE, overrideId, responsibilityId: "primary-review", dispatchId: DISPATCH_A, budgetState: "at-or-above-half", ...extra });
}

function claimDirOf(f, overrideId) {
  return path.join(f.ledgerDir, `${overrideId}.claim`);
}

function claimInChild(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      `import { claimHalfStateOverride } from ${JSON.stringify(LIB_URL)}; process.stdout.write(JSON.stringify(claimHalfStateOverride(JSON.parse(process.env.CLAIM_INPUT))));`,
    ], { env: { ...process.env, CLAIM_INPUT: JSON.stringify(input) }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child exit ${code}: ${err}`))));
  });
}

test("(1) two concurrent claims of one override: exactly one wins and the proof carries the winner's dispatch_id", async () => {
  const f = fixture();
  const issued = issue(f);
  assert.equal(issued.ok, true, issued.code);
  const input = { repoRoot: f.root, changeId: CHANGE, overrideId: issued.override_id, responsibilityId: "primary-review", dispatchId: DISPATCH_A, budgetState: "at-or-above-half" };
  const results = await Promise.all([claimInChild(input), claimInChild(input)]);
  const winners = results.filter((r) => r.ok);
  const losers = results.filter((r) => !r.ok);
  assert.equal(winners.length, 1, JSON.stringify(results));
  assert.equal(losers.length, 1);
  assert.equal(losers[0].code, "already-claimed");
  assert.equal(Object.hasOwn(losers[0], "dispatch_id"), false, "a refused claim never returns a dispatch_id");
  const proof = JSON.parse(fs.readFileSync(path.join(claimDirOf(f, issued.override_id), "consumed.json"), "utf8"));
  assert.equal(proof.schema, HALF_STATE_OVERRIDE_CLAIM_SCHEMA);
  assert.equal(proof.dispatch_id, DISPATCH_A);
  assert.equal(halfStateOverrideStatus({ repoRoot: f.root, changeId: CHANGE, overrideId: issued.override_id }), "consumed");
});

test("(1b) consumed claim lookup binds responsibility and dispatch for post-cap receipt validation", () => {
  const f = fixture();
  const issued = issue(f);
  assert.equal(claim(f, issued.override_id).ok, true);
  const input = { repoRoot: f.root, changeId: CHANGE, responsibilityId: "primary-review", dispatchId: DISPATCH_A };
  assert.equal(hasConsumedHalfStateOverrideClaim(input), true);
  assert.equal(hasConsumedHalfStateOverrideClaim({ ...input, responsibilityId: "design-review" }), false);
  assert.equal(hasConsumedHalfStateOverrideClaim({ ...input, dispatchId: "b".repeat(64) }), false);
  fs.unlinkSync(path.join(claimDirOf(f, issued.override_id), "consumed.json"));
  assert.equal(hasConsumedHalfStateOverrideClaim(input), false, "a claim directory without durable proof cannot authorize a receipt");
});

test("(2) loser-before-write: a claim directory without consumed.json refuses every later claim", () => {
  const f = fixture();
  const issued = issue(f);
  fs.mkdirSync(claimDirOf(f, issued.override_id), { mode: 0o700 });
  const result = claim(f, issued.override_id);
  assert.deepEqual(result, { ok: false, code: "already-claimed" });
  assert.equal(fs.existsSync(path.join(claimDirOf(f, issued.override_id), "consumed.json")), false);
});

test("(3) loser-after-write with the same deterministic dispatch_id is still refused (no idempotent retry)", () => {
  const f = fixture();
  const issued = issue(f);
  const first = claim(f, issued.override_id);
  assert.equal(first.ok, true, first.code);
  const proofPath = path.join(claimDirOf(f, issued.override_id), "consumed.json");
  const before = fs.readFileSync(proofPath);
  const retry = claim(f, issued.override_id);
  assert.deepEqual(retry, { ok: false, code: "already-claimed" });
  assert.ok(fs.readFileSync(proofPath).equals(before), "the winner's proof is never rewritten");
  assert.equal(halfStateOverrideStatus({ repoRoot: f.root, changeId: CHANGE, overrideId: issued.override_id }), "consumed");
});

test("(4) claimed-incomplete (crash after claim) is refused and never taken over; recovery needs a new override", () => {
  const f = fixture();
  const issued = issue(f);
  const crashed = claim(f, issued.override_id, { hooks: { beforeOpen: () => { throw new Error("simulated crash before the proof write"); } } });
  assert.deepEqual(crashed, { ok: false, code: "consumed-write-failed" });
  assert.equal(halfStateOverrideStatus({ repoRoot: f.root, changeId: CHANGE, overrideId: issued.override_id }), "claimed-incomplete");
  const recovery = claim(f, issued.override_id);
  assert.deepEqual(recovery, { ok: false, code: "already-claimed" });
  assert.deepEqual(fs.readdirSync(claimDirOf(f, issued.override_id)), [], "the incomplete claim directory is audit trail, not a takeover slot");
  const fresh = issue(f);
  assert.equal(claim(f, fresh.override_id).ok, true, "a newly issued override authorizes exactly once more");
});

test("(5) responsibility_id mismatch refuses without touching the ledger", () => {
  const f = fixture();
  const issued = issue(f, { responsibilityId: "design-review" });
  const result = claim(f, issued.override_id);
  assert.deepEqual(result, { ok: false, code: "responsibility-mismatch" });
  assert.equal(fs.existsSync(claimDirOf(f, issued.override_id)), false);
  assert.equal(halfStateOverrideStatus({ repoRoot: f.root, changeId: CHANGE, overrideId: issued.override_id }), "issued");
});

test("(6) exhausted no longer refuses a claim; a malformed budget state or dispatch id still does", () => {
  const f = fixture();
  const issued = issue(f);
  // Rejected inputs come first deliberately: they must not consume, so the
  // exact-once assertions below still mean what they say.
  assert.deepEqual(claim(f, issued.override_id, { budgetState: "plenty" }), { ok: false, code: "budget-state-invalid" });
  assert.deepEqual(claim(f, issued.override_id, { dispatchId: "dispatch-1" }), { ok: false, code: "dispatch-id-invalid" });
  assert.equal(fs.existsSync(claimDirOf(f, issued.override_id)), false, "a rejected input never consumes");
  assert.equal(halfStateOverrideStatus({ repoRoot: f.root, changeId: CHANGE, overrideId: issued.override_id }), "issued");
  // `exhausted` used to return `budget-exhausted` here. `fix-zero-value-review
  // -rounds` R1/D19 demoted the three cumulative totals to advisory at every
  // consumer and D18 states the field has no routing effect left, so the
  // validation above is now all `budgetState` does. Keeping the refusal would
  // have been worse than redundant: the stall budget's handback (D6) is
  // reopened by exactly this override, so a chain that stalled while the
  // totals happened to be large would have had the user's own named
  // authorization refused for the reason the change exists to stop honoring.
  const claimed = claim(f, issued.override_id, { budgetState: "exhausted" });
  assert.equal(claimed.ok, true, "a large cumulative total no longer refuses a named override");
  assert.equal(halfStateOverrideStatus({ repoRoot: f.root, changeId: CHANGE, overrideId: issued.override_id }), "consumed");
  assert.deepEqual(
    claim(f, issued.override_id, { budgetState: "exhausted" }),
    { ok: false, code: "already-claimed" },
    "exact-once is untouched: what went away is the budget refusal, not the claim",
  );
});

test("(7) nothing but an issued override authorizes: unknown hints, unissued ids and malformed records are refused", () => {
  const f = fixture();
  fs.mkdirSync(f.ledgerDir, { mode: 0o700 });
  assert.deepEqual(claim(f, UUID, { batchApproval: true, approvalContext: "same-change-dp-change-batch" }), { ok: false, code: "override-unreadable" });
  assert.deepEqual(claim(f, undefined), { ok: false, code: "override-id-invalid" });
  fs.writeFileSync(path.join(f.ledgerDir, `${UUID}.json`), `${JSON.stringify({ schema: HALF_STATE_OVERRIDE_SCHEMA, override_id: UUID, responsibility_id: "primary-review", issued_by: "batch-approval", issued_at: new Date().toISOString(), scope: "review-dispatch", reason: "x" })}\n`);
  assert.deepEqual(claim(f, UUID), { ok: false, code: "override-malformed" }, "issued_by must be the user");
  assert.equal(fs.existsSync(claimDirOf(f, UUID)), false);
});

// --- D15 (F) negative / race set for override-ledger/ ---

test("(F1) issuing into a symlinked override-ledger/ is refused and nothing lands behind the link", () => {
  const f = fixture();
  fs.symlinkSync(f.elsewhere, f.ledgerDir, "dir");
  const result = issue(f);
  assert.deepEqual(result, { ok: false, code: "override-ledger-invalid" });
  assert.deepEqual(fs.readdirSync(f.elsewhere), []);
});

test("(F2) an existing target is EEXIST-refused and left byte-identical", () => {
  const f = fixture();
  fs.mkdirSync(f.ledgerDir, { mode: 0o700 });
  const target = path.join(f.ledgerDir, `${UUID}.json`);
  fs.writeFileSync(target, "{\"pre\":true}\n");
  const result = issue(f, { uuid: () => UUID });
  assert.deepEqual(result, { ok: false, code: "override-exists" });
  assert.equal(fs.readFileSync(target, "utf8"), "{\"pre\":true}\n");
});

test("(F3) a symlink at the target path is refused and its destination untouched", () => {
  const f = fixture();
  fs.mkdirSync(f.ledgerDir, { mode: 0o700 });
  const destination = path.join(f.elsewhere, "victim.json");
  fs.writeFileSync(destination, "victim\n");
  fs.symlinkSync(destination, path.join(f.ledgerDir, `${UUID}.json`), "file");
  const result = issue(f, { uuid: () => UUID });
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(destination, "utf8"), "victim\n");
});

test("(F4) parent swapped to a symlink between check and open is detected, the file unlinked, issue fails closed", () => {
  const f = fixture();
  fs.mkdirSync(f.ledgerDir, { mode: 0o700 });
  const beforeOpen = () => {
    fs.renameSync(f.ledgerDir, `${f.ledgerDir}.moved`);
    fs.symlinkSync(f.elsewhere, f.ledgerDir, "dir");
  };
  const result = issue(f, { uuid: () => UUID, hooks: { beforeOpen } });
  assert.equal(result.ok, false);
  assert.deepEqual(fs.readdirSync(f.elsewhere), [], "the file created behind the swapped parent must be unlinked");
  assert.deepEqual(fs.readdirSync(`${f.ledgerDir}.moved`), []);
});

test("(F5) reading a symlinked override is refused even when it points at a valid record", () => {
  const f = fixture();
  const issued = issue(f);
  const alias = "1b2f3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  fs.symlinkSync(path.join(f.ledgerDir, `${issued.override_id}.json`), path.join(f.ledgerDir, `${alias}.json`), "file");
  const direct = readHalfStateOverride({ repoRoot: f.root, changeId: CHANGE, overrideId: issued.override_id });
  assert.equal(direct.ok, true);
  assert.equal(direct.digest, issued.digest);
  assert.deepEqual(readHalfStateOverride({ repoRoot: f.root, changeId: CHANGE, overrideId: alias }), { ok: false, code: "override-unreadable" });
  assert.deepEqual(claim(f, alias), { ok: false, code: "override-unreadable" });
});

test("(F6) a non-regular file at the override path is refused; bad ids never touch the filesystem", () => {
  const f = fixture();
  fs.mkdirSync(f.ledgerDir, { mode: 0o700 });
  fs.mkdirSync(path.join(f.ledgerDir, `${UUID}.json`));
  assert.deepEqual(readHalfStateOverride({ repoRoot: f.root, changeId: CHANGE, overrideId: UUID }), { ok: false, code: "override-unreadable" });
  for (const overrideId of ["../../evil", "not-a-uuid", `${UUID}/x`, "3e1d0c9b-8a7f-1e6d-9c5b-4a3f2e1d0c9b"]) {
    assert.deepEqual(readHalfStateOverride({ repoRoot: f.root, changeId: CHANGE, overrideId }), { ok: false, code: "override-id-invalid" });
  }
  assert.deepEqual(readHalfStateOverride({ repoRoot: f.root, changeId: "../strengthen", overrideId: UUID }), { ok: false, code: "change-id-invalid" });
  assert.deepEqual(issue(f, { responsibilityId: "bad id/with slash" }), { ok: false, code: "responsibility-id-invalid" });
  assert.deepEqual(issue(f, { reason: "  " }), { ok: false, code: "reason-invalid" });
});

test("(F7) override and claim proof are fsynced with their full body before returning and request private POSIX modes", () => {
  const f = fixture();
  const seen = [];
  const fsyncFile = (fd) => { seen.push(fs.fstatSync(fd).size); };
  const issued = issue(f, { hooks: { fsyncFile } });
  assert.equal(issued.ok, true);
  const recordPath = path.join(f.ledgerDir, `${issued.override_id}.json`);
  assert.deepEqual(seen, [fs.readFileSync(recordPath).length]);
  assert.equal(fs.statSync(recordPath).mode & 0o777, expectedNodeModeBits(0o600));
  const seenClaim = [];
  const claimed = claim(f, issued.override_id, { hooks: { fsyncFile: (fd) => { seenClaim.push(fs.fstatSync(fd).size); } } });
  assert.equal(claimed.ok, true);
  const proofPath = path.join(claimDirOf(f, issued.override_id), "consumed.json");
  assert.deepEqual(seenClaim, [fs.readFileSync(proofPath).length]);
  assert.equal(fs.statSync(proofPath).mode & 0o777, expectedNodeModeBits(0o600));
  assert.equal(fs.statSync(claimDirOf(f, issued.override_id)).mode & 0o777, expectedNodeModeBits(0o700));
});

// (R1) round-3 review F-r3-override-claim-proof-untracked: the ledger JSON was
// tracked while its `.claim/` consumption proof was not, so a consumed override
// read as `issued` again on any fresh clone or `git clean -fd`. The consumption
// state cannot be made durable through Git either, because a claim taken during
// the final review round would have to be committed after the reviewed HEAD,
// which the archive transition forbids. Both carriers are therefore worktree-
// local: a clone sees no override at all and the user must re-issue (fail
// closed), instead of seeing a spent one as issued (fail open).
test("(R1) override ledger and admission records stay untracked and ignored, active and archived", () => {
  const root = repoPath(".");
  // `:(glob)` + a trailing `/**` is required: a wildcard pathspec that ends at a
  // directory name (`openspec/changes/*/override-ledger`) matches nothing, so the
  // naive form would pass while a tracked ledger file sat right there.
  const tracked = execFileSync("git", [
    "ls-files", "--",
    ":(glob)openspec/changes/**/override-ledger/**",
    ":(glob)openspec/changes/**/admission-records/**",
  ], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(tracked, "", `hook-written authorization carriers must stay untracked; tracked: ${tracked}`);
  for (const candidate of [
    `openspec/changes/${CHANGE}/override-ledger/${UUID}.json`,
    `openspec/changes/${CHANGE}/override-ledger/${UUID}.claim/consumed.json`,
    `openspec/changes/${CHANGE}/admission-records/${UUID}.json`,
    `openspec/changes/archive/2026-01-01-${CHANGE}/override-ledger/${UUID}.claim/consumed.json`,
    `openspec/changes/archive/2026-01-01-${CHANGE}/admission-records/${UUID}.json`,
  ]) {
    const probe = spawnSync("git", ["check-ignore", "-q", "--no-index", "--", candidate], { cwd: root });
    assert.equal(probe.status, 0, `${candidate} must be gitignored so it can never be committed`);
  }
});

// (R1b) the source repo's own `.gitignore` only protects this repo. Consumers
// receive the managed block from the `gitignore-alignment.md` baseline SSOT, so
// a pattern that lives in one carrier but not the other leaves every consumer
// committing its own override ledgers — the same fail-open (R1) closes here.
test("(R1b) the ignore patterns reach consumers through the managed-block baseline SSOT", () => {
  const baseline = fs.readFileSync(repoPath(".devpro/agent-rules/gitignore-alignment.md"), "utf8");
  const block = baseline.split("<!-- devpro-gitignore-baseline begin -->")[1]?.split("<!-- devpro-gitignore-baseline end -->")[0];
  assert.ok(block, "gitignore-alignment.md must carry the baseline marker block");
  const managed = fs.readFileSync(repoPath(".gitignore"), "utf8")
    .split("# devpro-agent-rules managed begin")[1]?.split("# devpro-agent-rules managed end")[0];
  assert.ok(managed, ".gitignore must carry the managed block");
  for (const pattern of [
    "openspec/changes/**/override-ledger/",
    "openspec/changes/**/admission-records/",
  ]) {
    // `**` is required: after `openspec archive` the carriers gain a directory
    // level, which a single-level `*` glob would stop matching.
    assert.ok(block.includes(pattern), `${pattern} must be in the consumer baseline SSOT`);
    assert.ok(managed.includes(pattern), `${pattern} must be in this repo's managed block`);
  }
});

// ── PR #2473 second cross-model round ──────────────────────────────────────
// C-05: `createExclusiveDurableFile` fsyncs the directory that HOLDS the file,
// never the directory that holds that directory's own mkdir entry. Both new
// carriers here are created with `mkdirSync`, so without an explicit parent
// fsync a crash can drop `override-ledger/` while `<override_id>.json` survives,
// or drop `<override_id>.claim/` while the override JSON survives — and the same
// override then authorizes a second dispatch, breaking R5 exact-once.
// I-01: containment was anchored at the change directory, so a symlink at
// `openspec/` or `openspec/changes/` escaped the repo with every leaf check
// still passing (D55 requires the walk to start at the repo root).

test("(C-05) issuing an override fsyncs the change directory that holds the new ledger mkdir entry", () => {
  const f = fixture();
  const dirs = [];
  const issued = issue(f, { hooks: { fsyncDir: (d) => dirs.push(d) } });
  assert.equal(issued.ok, true, `issue failed: ${issued.code ?? "ok"}`);
  assert.ok(dirs.includes(f.changeDir), `the parent of the new override-ledger/ must be fsynced; saw ${JSON.stringify(dirs)}`);
});

test("(C-05) claiming an override fsyncs the ledger directory that holds the claim mkdir entry", () => {
  const f = fixture();
  const issued = issue(f);
  assert.equal(issued.ok, true);
  const dirs = [];
  const claimed = claimHalfStateOverride({
    repoRoot: f.root,
    changeId: CHANGE,
    overrideId: issued.override_id,
    responsibilityId: "primary-review",
    dispatchId: DISPATCH_A,
    budgetState: "at-or-above-half",
    hooks: { fsyncDir: (d) => dirs.push(d) },
  });
  assert.equal(claimed.ok, true, `claim failed: ${claimed.code ?? "ok"}`);
  assert.ok(dirs.includes(f.ledgerDir), `the parent of the new <override_id>.claim/ must be fsynced; saw ${JSON.stringify(dirs)}`);
});

test("(I-01) a symlinked openspec/changes intermediate fails closed for issue, read, and claim", () => {
  const f = fixture();
  const issued = issue(f);
  assert.equal(issued.ok, true, "sanity: a plain tree issues");
  const changesDir = path.join(f.root, "openspec", "changes");
  const moved = path.join(f.elsewhere, "changes");
  fs.renameSync(changesDir, moved);
  fs.symlinkSync(moved, changesDir, "dir");
  assert.equal(fs.lstatSync(path.join(changesDir, CHANGE)).isDirectory(), true, "the leaf behind the link is a plain directory");
  assert.equal(issue(f).code, "override-ledger-invalid", "issuing through a symlinked intermediate must fail closed");
  assert.equal(readHalfStateOverride({ repoRoot: f.root, changeId: CHANGE, overrideId: issued.override_id }).ok, false, "reading through a symlinked intermediate must fail closed");
  const claimed = claimHalfStateOverride({
    repoRoot: f.root,
    changeId: CHANGE,
    overrideId: issued.override_id,
    responsibilityId: "primary-review",
    dispatchId: DISPATCH_A,
    budgetState: "at-or-above-half",
  });
  assert.equal(claimed.ok, false, "claiming through a symlinked intermediate must fail closed");
  assert.equal(fs.existsSync(path.join(moved, CHANGE, "override-ledger", `${issued.override_id}.claim`)), false, "no claim directory behind the link");
});

// refactor-agent-skills-entry D9: `openspec archive` moves override-ledger/ with
// the change folder, and pre-PR seal-final runs after archive. The read side
// follows the folder (same resolution as admission records); issue and claim
// stay active-only so an archived override never authorizes a new dispatch.
function archiveChange(f, changeId = CHANGE, name = `2026-09-27-${changeId}`) {
  const archiveRoot = path.join(f.root, "openspec", "changes", "archive");
  fs.mkdirSync(archiveRoot, { recursive: true });
  const archived = path.join(archiveRoot, name);
  fs.renameSync(path.join(f.root, "openspec", "changes", changeId), archived);
  return archived;
}

function snapshot(dir) {
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

test("(archive-1) a consumed claim still proves the override after the change folder is archived", () => {
  const f = fixture();
  const issued = issue(f);
  assert.equal(claim(f, issued.override_id).ok, true);
  archiveChange(f);
  const input = { repoRoot: f.root, changeId: CHANGE, responsibilityId: "primary-review", dispatchId: DISPATCH_A };
  assert.equal(hasConsumedHalfStateOverrideClaim(input), true, "seal-final after archive must still see the consumed claim");
  assert.equal(hasConsumedHalfStateOverrideClaim({ ...input, dispatchId: "b".repeat(64) }), false);
  assert.equal(halfStateOverrideStatus({ repoRoot: f.root, changeId: CHANGE, overrideId: issued.override_id }), "consumed");
  assert.equal(readHalfStateOverride({ repoRoot: f.root, changeId: CHANGE, overrideId: issued.override_id }).ok, true);
});

test("(archive-2) an active folder wins over an archived one, even when only the archive holds the claim", () => {
  const f = fixture();
  const issued = issue(f);
  assert.equal(claim(f, issued.override_id).ok, true);
  archiveChange(f);
  fs.mkdirSync(f.changeDir);
  const input = { repoRoot: f.root, changeId: CHANGE, responsibilityId: "primary-review", dispatchId: DISPATCH_A };
  assert.equal(hasConsumedHalfStateOverrideClaim(input), false);
  assert.equal(halfStateOverrideStatus({ repoRoot: f.root, changeId: CHANGE, overrideId: issued.override_id }), "missing");
});

test("(archive-3) a non-directory active entry fails closed instead of falling back to the archive", () => {
  const f = fixture();
  const issued = issue(f);
  assert.equal(claim(f, issued.override_id).ok, true);
  archiveChange(f);
  fs.writeFileSync(f.changeDir, "not a folder\n");
  const input = { repoRoot: f.root, changeId: CHANGE, responsibilityId: "primary-review", dispatchId: DISPATCH_A };
  assert.equal(hasConsumedHalfStateOverrideClaim(input), false);
  assert.equal(readHalfStateOverride({ repoRoot: f.root, changeId: CHANGE, overrideId: issued.override_id }).ok, false);
});

test("(archive-4) issue and claim never write into an archived change folder", () => {
  const f = fixture();
  const issued = issue(f);
  assert.equal(issued.ok, true);
  const archived = archiveChange(f);
  const before = snapshot(archived);
  assert.equal(issue(f).code, "override-ledger-invalid");
  assert.equal(claim(f, issued.override_id).ok, false, "an archived, unclaimed override must not authorize a new dispatch");
  assert.deepEqual(snapshot(archived), before, "nothing was written into the archived folder");
  assert.equal(fs.existsSync(f.changeDir), false, "no active folder was recreated");
  assert.equal(halfStateOverrideStatus({ repoRoot: f.root, changeId: CHANGE, overrideId: issued.override_id }), "issued");
});

test("(archive-5) another change id's archived folder is never selected", () => {
  const f = fixture();
  const issued = issue(f);
  assert.equal(claim(f, issued.override_id).ok, true);
  archiveChange(f, CHANGE, `2026-09-27-x-${CHANGE}`);
  const input = { repoRoot: f.root, changeId: CHANGE, responsibilityId: "primary-review", dispatchId: DISPATCH_A };
  assert.equal(hasConsumedHalfStateOverrideClaim(input), false, "the archive name must match the change id exactly, not as a suffix");
});
