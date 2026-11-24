import assert from "node:assert/strict";
import childProcess, { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CODEX_REVIEWER_ADMISSION_KEYS,
  CODEX_REVIEWER_RECOVERY_REQUEST_SCHEMA,
  CODEX_REVIEWER_REQUEST_SCHEMA,
  admitPreparedCodexReviewer,
  issueCodexReviewerAdmission,
  readBoundedRequestFile,
  recoverCodexReviewerAdmission,
  resolveExactOneChangeWorktreeBinding,
  validateAdmissionRecordV2,
  verifyCodexReviewerAdmissionAuthority,
} from "../hooks/lib/admission-record.mjs";
import { captureReviewerOutput } from "../review-remediation-evidence.mjs";
import { fsyncDirectory } from "../lib/durable-fs.mjs";
import { D30_CODES } from "../lib/review-remediation-evidence-core.mjs";

const SCRIPT = fileURLToPath(new URL("../issue-codex-reviewer-admission.mjs", import.meta.url));
const EVIDENCE_SCRIPT = fileURLToPath(new URL("../review-remediation-evidence.mjs", import.meta.url));
const ADMISSION_RECORD_URL = new URL("../hooks/lib/admission-record.mjs", import.meta.url).href;
const SHA = "1".repeat(40);

test("request transport keeps native read faults untyped only for the D30 opt-in", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "d30-request-read-fault-"));
  try {
    const requestPath = path.join(temporary, "request.json");
    writeFileSync(requestPath, "{}\n");
    for (const code of ["EIO", "ENOENT"]) {
      const fault = Object.assign(new Error(`private request ${code} sentinel`), { code });
      const readNoFollowFileHooks = { afterLstat() { throw fault; } };
      assert.throws(
        () => readBoundedRequestFile(requestPath, 64 * 1024, { propagateNativeFaults: true, readNoFollowFileHooks }),
        (error) => error === fault,
        `D30 opt-in preserves injected ${code}`,
      );
      assert.deepEqual(
        readBoundedRequestFile(requestPath, 64 * 1024, { readNoFollowFileHooks }),
        { ok: false, code: "request-unparseable" },
        `the default non-D30 contract still maps ${code} to request-unparseable`,
      );
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

let sharedRealWorktreeFixture;

function gitFixture(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  }).trim();
}

function canonicalGitCommonDir(cwd) {
  return realpathSync(path.resolve(cwd, gitFixture(cwd, ["rev-parse", "--git-common-dir"])));
}

before(() => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-reviewer-real-worktree-"));
  const mainRoot = path.join(root, "main");
  const linkedRoot = path.join(mainRoot, ".worktree", "review-fixture");
  mkdirSync(path.join(mainRoot, "openspec", "changes", "review-fixture"), { recursive: true });
  gitFixture(mainRoot, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(mainRoot, ".gitignore"), ".worktree/\n");
  writeFileSync(path.join(mainRoot, "seed"), "seed\n");
  writeFileSync(
    path.join(mainRoot, "openspec", "changes", "review-fixture", "tasks.md"),
    "# Fixture\n",
  );
  gitFixture(mainRoot, ["add", ".gitignore", "seed", "openspec/changes/review-fixture/tasks.md"]);
  gitFixture(mainRoot, ["commit", "-qm", "seed"]);
  mkdirSync(path.dirname(linkedRoot), { recursive: true });
  gitFixture(mainRoot, ["worktree", "add", "-q", "-b", "review-fixture-linked", linkedRoot, "HEAD"]);
  sharedRealWorktreeFixture = {
    root,
    mainRoot,
    linkedRoot,
    head: gitFixture(linkedRoot, ["rev-parse", "HEAD"]),
  };
});

after(() => {
  if (sharedRealWorktreeFixture) rmSync(sharedRealWorktreeFixture.root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-reviewer-admission-"));
  const cwd = path.join(root, "repo", ".worktree", "review-fixture");
  mkdirSync(path.join(cwd, "openspec", "changes", "review-fixture"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd });
  execFileSync("git", ["config", "user.name", "fixture"], { cwd });
  writeFileSync(path.join(cwd, "seed"), "seed\n");
  execFileSync("git", ["add", "seed"], { cwd });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  return { root, cwd, head };
}

function request(head, overrides = {}) {
  return {
    schema: CODEX_REVIEWER_REQUEST_SCHEMA,
    change_id: "review-fixture",
    base_sha: SHA,
    head_sha: head,
    objective: "independent-judgment",
    responsibility_id: "primary-review",
    instance_mode: "fresh",
    evidence_scope: "local diff",
    return_and_stop: "return findings and stop",
    role: "dp-reviewer",
    agent_type: "dp-reviewer",
    task_name: "review_round",
    fork_turns: "none",
    context_mode: "fresh",
    ttl_seconds: 600,
    ...overrides,
  };
}

function toolInput(overrides = {}) {
  return {
    agent_type: "dp-reviewer",
    task_name: "review_round",
    fork_turns: "none",
    message: "gAAAAA" + "a".repeat(48),
    ...overrides,
  };
}

function recoveryRequest(issued, overrides = {}) {
  return {
    schema: CODEX_REVIEWER_RECOVERY_REQUEST_SCHEMA,
    change_id: "review-fixture",
    intent_id: issued.intent_id,
    intent_sha256: issued.digest_sha256,
    ...overrides,
  };
}

function sharedAdmissionDir() {
  return path.join(
    sharedRealWorktreeFixture.linkedRoot,
    "openspec",
    "changes",
    "review-fixture",
    "admission-records",
  );
}

function clearSharedPreparedIntent(issued) {
  const intentDir = path.join(sharedAdmissionDir(), "codex-reviewer-intents");
  rmSync(path.join(intentDir, `${issued.intent_id}.json`), { force: true });
  rmSync(path.join(intentDir, `${issued.intent_id}.claim`), { recursive: true, force: true });
}

function sharedAdmissionRecordNames() {
  return readdirSync(sharedAdmissionDir())
    .filter((name) => /^[0-9a-f-]{36}\.json$/u.test(name))
    .sort();
}

function admitPreparedInChild(cwd, input) {
  const script = `import { admitPreparedCodexReviewer } from ${JSON.stringify(ADMISSION_RECORD_URL)}; process.stdout.write(JSON.stringify(admitPreparedCodexReviewer(JSON.parse(process.env.CODEX_ADMISSION_INPUT))));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: {
        ...process.env,
        CODEX_ADMISSION_INPUT: JSON.stringify({ cwd, toolInput: input }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(JSON.parse(stdout));
      else reject(new Error(`admission child exited ${code}: ${stderr}`));
    });
  });
}

function exercisePreclaimDrift({ mutate, restore = () => {} }) {
  const fixture = sharedRealWorktreeFixture;
  const issued = issueCodexReviewerAdmission({ cwd: fixture.linkedRoot, request: request(fixture.head) });
  assert.equal(issued.ok, true);
  const intentDir = path.join(sharedAdmissionDir(), "codex-reviewer-intents");
  const intentPath = path.join(intentDir, `${issued.intent_id}.json`);
  const intentBytes = readFileSync(intentPath);
  const beforeRecords = sharedAdmissionRecordNames();
  let mutated = false;
  try {
    const result = admitPreparedCodexReviewer({
      cwd: fixture.linkedRoot,
      toolInput: toolInput(),
      uuid: () => {
        mutated = true;
        mutate({ fixture, intentPath, intentBytes });
        return "11111111-1111-4111-8111-111111111111";
      },
    });
    const newRecords = sharedAdmissionRecordNames().filter((name) => !beforeRecords.includes(name));
    return {
      resultOk: result.ok,
      resultCode: result.code ?? null,
      claimExists: existsSync(path.join(intentDir, `${issued.intent_id}.claim`)),
      newRecordCount: newRecords.length,
    };
  } finally {
    for (const name of sharedAdmissionRecordNames().filter((entry) => !beforeRecords.includes(entry))) {
      rmSync(path.join(sharedAdmissionDir(), name), { force: true });
    }
    clearSharedPreparedIntent(issued);
    if (mutated) restore({ fixture });
  }
}

function exercisePostclaimFault({ recordId, hooksFor, restoreAuthority = () => {} }) {
  const fixture = sharedRealWorktreeFixture;
  const issued = issueCodexReviewerAdmission({ cwd: fixture.linkedRoot, request: request(fixture.head) });
  assert.equal(issued.ok, true);
  const intentDir = path.join(sharedAdmissionDir(), "codex-reviewer-intents");
  const intentPath = path.join(intentDir, `${issued.intent_id}.json`);
  const intentBytes = readFileSync(intentPath);
  const claimProofPath = path.join(intentDir, `${issued.intent_id}.claim`, "consumed.json");
  const recordPath = path.join(sharedAdmissionDir(), `${recordId}.json`);
  const stagingPath = path.join(sharedAdmissionDir(), `${recordId}.json.publishing`);
  const readyPath = path.join(sharedAdmissionDir(), `${recordId}.json.ok`);
  const state = {};
  let authorityRestored = false;
  try {
    const result = admitPreparedCodexReviewer({
      cwd: fixture.linkedRoot,
      toolInput: toolInput(),
      uuid: () => recordId,
      hooks: hooksFor({ fixture, intentPath, intentBytes, recordPath, stagingPath, readyPath, state }),
    });
    const claimConsumed = existsSync(claimProofPath);
    restoreAuthority({ fixture, intentPath, intentBytes, state });
    authorityRestored = true;
    const verified = verifyCodexReviewerAdmissionAuthority({
      repoRoot: fixture.linkedRoot,
      changeId: "review-fixture",
      recordId,
    });
    const retry = admitPreparedCodexReviewer({ cwd: fixture.linkedRoot, toolInput: toolInput() });
    return {
      result: { ok: result.ok, code: result.code ?? null },
      claimConsumed,
      recordExists: existsSync(recordPath),
      stagingExists: existsSync(stagingPath),
      readyExists: existsSync(readyPath),
      recordVerifies: verified.ok,
      retry,
    };
  } finally {
    if (!authorityRestored) restoreAuthority({ fixture, intentPath, intentBytes, state });
    rmSync(recordPath, { force: true });
    rmSync(stagingPath, { force: true });
    rmSync(readyPath, { force: true });
    clearSharedPreparedIntent(issued);
  }
}

test("main-rooted admission discovers exact-one linked-worktree prepared intent and publishes once", () => {
  const fixture = sharedRealWorktreeFixture;
  const issued = issueCodexReviewerAdmission({
    cwd: fixture.linkedRoot,
    request: request(fixture.head),
  });
  assert.equal(issued.ok, true);
  const before = sharedAdmissionRecordNames();
  try {
    assert.equal(
      canonicalGitCommonDir(fixture.mainRoot),
      canonicalGitCommonDir(fixture.linkedRoot),
    );
    const admitted = admitPreparedCodexReviewer({ cwd: fixture.mainRoot, toolInput: toolInput() });
    assert.equal(admitted.ok, true, admitted.code);
    assert.equal(typeof admitted.code, "undefined");
    const after = sharedAdmissionRecordNames();
    assert.deepEqual(after.filter((name) => !before.includes(name)), [`${admitted.record_id}.json`]);
    const record = JSON.parse(readFileSync(path.join(sharedAdmissionDir(), `${admitted.record_id}.json`), "utf8"));
    assert.equal(
      record.canonical_worktree_sha256,
      createHash("sha256").update(realpathSync(fixture.linkedRoot), "utf8").digest("hex"),
    );
    assert.equal(record.head_sha, fixture.head);
    assert.equal(
      /(?:\/(?:Users|home|private|tmp)\/|[A-Za-z]:[\\/])/u.test(JSON.stringify(admitted)),
      false,
      "admission result must not expose absolute paths",
    );
    assert.deepEqual(admitPreparedCodexReviewer({ cwd: fixture.mainRoot, toolInput: toolInput() }), {
      ok: false,
      code: "intent-consumed",
    });
  } finally {
    clearSharedPreparedIntent(issued);
  }
});

test("sibling linked-worktree session falls back to common-dir exact-one discovery", () => {
  const fixture = sharedRealWorktreeFixture;
  const otherLinked = path.join(fixture.mainRoot, ".worktree", "other-change");
  mkdirSync(path.join(fixture.mainRoot, "openspec", "changes", "other-change"), { recursive: true });
  writeFileSync(path.join(fixture.mainRoot, "openspec", "changes", "other-change", "tasks.md"), "# other\n");
  gitFixture(fixture.mainRoot, ["add", "openspec/changes/other-change/tasks.md"]);
  gitFixture(fixture.mainRoot, ["commit", "-qm", "other-change-folder"]);
  gitFixture(fixture.mainRoot, ["worktree", "add", "-q", "-b", "other-change-linked", otherLinked, "HEAD"]);
  const issued = issueCodexReviewerAdmission({ cwd: fixture.linkedRoot, request: request(fixture.head) });
  assert.equal(issued.ok, true);
  const before = sharedAdmissionRecordNames();
  try {
    assert.equal(
      canonicalGitCommonDir(otherLinked),
      canonicalGitCommonDir(fixture.linkedRoot),
    );
    const admitted = admitPreparedCodexReviewer({ cwd: otherLinked, toolInput: toolInput() });
    assert.equal(admitted.ok, true, admitted.code);
    const after = sharedAdmissionRecordNames();
    assert.deepEqual(after.filter((name) => !before.includes(name)), [`${admitted.record_id}.json`]);
    const record = JSON.parse(readFileSync(path.join(sharedAdmissionDir(), `${admitted.record_id}.json`), "utf8"));
    assert.equal(
      record.canonical_worktree_sha256,
      createHash("sha256").update(realpathSync(fixture.linkedRoot), "utf8").digest("hex"),
    );
    assert.deepEqual(admitPreparedCodexReviewer({ cwd: otherLinked, toolInput: toolInput() }), {
      ok: false,
      code: "intent-consumed",
    });
  } finally {
    clearSharedPreparedIntent(issued);
    for (const name of sharedAdmissionRecordNames().filter((entry) => !before.includes(entry))) {
      rmSync(path.join(sharedAdmissionDir(), name), { force: true });
      rmSync(path.join(sharedAdmissionDir(), `${name}.ok`), { force: true });
    }
    gitFixture(fixture.mainRoot, ["worktree", "remove", "-f", otherLinked]);
    gitFixture(fixture.mainRoot, ["branch", "-D", "other-change-linked"]);
  }
});

test("local consumed-only fast path falls through so sibling fresh intent admits", () => {
  const fixture = sharedRealWorktreeFixture;
  const otherLinked = path.join(fixture.mainRoot, ".worktree", "consumed-local-sibling");
  mkdirSync(path.join(fixture.mainRoot, "openspec", "changes", "consumed-local-sibling"), { recursive: true });
  writeFileSync(path.join(fixture.mainRoot, "openspec", "changes", "consumed-local-sibling", "tasks.md"), "# sibling\n");
  gitFixture(fixture.mainRoot, ["add", "openspec/changes/consumed-local-sibling/tasks.md"]);
  gitFixture(fixture.mainRoot, ["commit", "-qm", "consumed-local-sibling-folder"]);
  gitFixture(fixture.mainRoot, ["worktree", "add", "-q", "-b", "consumed-local-sibling-linked", otherLinked, "HEAD"]);
  const otherHead = gitFixture(otherLinked, ["rev-parse", "HEAD"]);
  const localIssued = issueCodexReviewerAdmission({
    cwd: otherLinked,
    request: {
      ...request(otherHead),
      change_id: "consumed-local-sibling",
    },
  });
  assert.equal(localIssued.ok, true, localIssued.code);
  let siblingIssued;
  try {
    const localAdmit = admitPreparedCodexReviewer({ cwd: otherLinked, toolInput: toolInput() });
    assert.equal(localAdmit.ok, true, localAdmit.code);
    siblingIssued = issueCodexReviewerAdmission({ cwd: fixture.linkedRoot, request: request(fixture.head) });
    assert.equal(siblingIssued.ok, true, siblingIssued.code);
    const before = sharedAdmissionRecordNames();
    const admitted = admitPreparedCodexReviewer({ cwd: otherLinked, toolInput: toolInput() });
    assert.equal(admitted.ok, true, admitted.code);
    assert.notEqual(admitted.record_id, localAdmit.record_id);
    assert.deepEqual(admitPreparedCodexReviewer({ cwd: otherLinked, toolInput: toolInput() }), {
      ok: false,
      code: "intent-consumed",
    });
    assert.deepEqual(
      sharedAdmissionRecordNames().filter((name) => !before.includes(name)),
      [`${admitted.record_id}.json`],
    );
  } finally {
    clearSharedPreparedIntent(localIssued);
    if (siblingIssued) clearSharedPreparedIntent(siblingIssued);
    if (existsSync(sharedAdmissionDir())) {
      for (const name of sharedAdmissionRecordNames()) {
        rmSync(path.join(sharedAdmissionDir(), name), { force: true });
        rmSync(path.join(sharedAdmissionDir(), `${name}.ok`), { force: true });
      }
    }
    const intentRoots = [
      path.join(otherLinked, "openspec", "changes", "consumed-local-sibling", "admission-records", "codex-reviewer-intents"),
      path.join(fixture.linkedRoot, "openspec", "changes", "review-fixture", "admission-records", "codex-reviewer-intents"),
    ];
    for (const intentDir of intentRoots) {
      if (!existsSync(intentDir)) continue;
      for (const name of readdirSync(intentDir)) {
        rmSync(path.join(intentDir, name), { recursive: true, force: true });
      }
    }
    gitFixture(fixture.mainRoot, ["worktree", "remove", "-f", otherLinked]);
    gitFixture(fixture.mainRoot, ["branch", "-D", "consumed-local-sibling-linked"]);
  }
});

test("sibling with proven-absent local changeDir falls through to common-dir exact-one", () => {
  const fixture = sharedRealWorktreeFixture;
  const absentLinked = path.join(fixture.mainRoot, ".worktree", "absent-local-change");
  // No openspec/changes/absent-local-change — proven local absence, not invalid entry.
  gitFixture(fixture.mainRoot, ["worktree", "add", "-q", "-b", "absent-local-change-linked", absentLinked, "HEAD"]);
  assert.equal(
    existsSync(path.join(absentLinked, "openspec", "changes", "absent-local-change")),
    false,
  );
  const issued = issueCodexReviewerAdmission({ cwd: fixture.linkedRoot, request: request(fixture.head) });
  assert.equal(issued.ok, true);
  const before = sharedAdmissionRecordNames();
  try {
    const admitted = admitPreparedCodexReviewer({ cwd: absentLinked, toolInput: toolInput() });
    assert.equal(admitted.ok, true, admitted.code);
    assert.deepEqual(
      sharedAdmissionRecordNames().filter((name) => !before.includes(name)),
      [`${admitted.record_id}.json`],
    );
  } finally {
    clearSharedPreparedIntent(issued);
    for (const name of sharedAdmissionRecordNames().filter((entry) => !before.includes(entry))) {
      rmSync(path.join(sharedAdmissionDir(), name), { force: true });
      rmSync(path.join(sharedAdmissionDir(), `${name}.ok`), { force: true });
    }
    gitFixture(fixture.mainRoot, ["worktree", "remove", "-f", absentLinked]);
    gitFixture(fixture.mainRoot, ["branch", "-D", "absent-local-change-linked"]);
  }
});

test("sibling with existing-invalid local changeDir stays fail-closed before discovery", () => {
  const fixture = sharedRealWorktreeFixture;
  const invalidLinked = path.join(fixture.mainRoot, ".worktree", "invalid-local-change");
  gitFixture(fixture.mainRoot, ["worktree", "add", "-q", "-b", "invalid-local-change-linked", invalidLinked, "HEAD"]);
  const changePath = path.join(invalidLinked, "openspec", "changes", "invalid-local-change");
  const elsewhere = path.join(fixture.root, "invalid-local-elsewhere");
  mkdirSync(path.dirname(changePath), { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  symlinkSync(elsewhere, changePath, "dir");
  const issued = issueCodexReviewerAdmission({ cwd: fixture.linkedRoot, request: request(fixture.head) });
  assert.equal(issued.ok, true);
  const before = sharedAdmissionRecordNames();
  try {
    assert.deepEqual(
      admitPreparedCodexReviewer({ cwd: invalidLinked, toolInput: toolInput() }),
      { ok: false, code: "artifact-parent-invalid" },
    );
    assert.deepEqual(sharedAdmissionRecordNames(), before);
  } finally {
    clearSharedPreparedIntent(issued);
    gitFixture(fixture.mainRoot, ["worktree", "remove", "-f", invalidLinked]);
    gitFixture(fixture.mainRoot, ["branch", "-D", "invalid-local-change-linked"]);
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("discovery fails closed when a candidate worktree has a distinct git-common-dir", () => {
  const fixture = sharedRealWorktreeFixture;
  const foreignRoot = mkdtempSync(path.join(os.tmpdir(), "codex-reviewer-foreign-common-"));
  const foreignMain = path.join(foreignRoot, "main");
  const foreignLinked = path.join(foreignMain, ".worktree", "foreign-change");
  mkdirSync(path.join(foreignMain, "openspec", "changes", "foreign-change"), { recursive: true });
  gitFixture(foreignMain, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(foreignMain, "seed"), "foreign\n");
  writeFileSync(path.join(foreignMain, "openspec", "changes", "foreign-change", "tasks.md"), "# foreign\n");
  gitFixture(foreignMain, ["add", "seed", "openspec/changes/foreign-change/tasks.md"]);
  gitFixture(foreignMain, ["commit", "-qm", "foreign-seed"]);
  mkdirSync(path.dirname(foreignLinked), { recursive: true });
  gitFixture(foreignMain, ["worktree", "add", "-q", "-b", "foreign-change-linked", foreignLinked, "HEAD"]);
  assert.notEqual(canonicalGitCommonDir(fixture.mainRoot), canonicalGitCommonDir(foreignLinked));

  const issued = issueCodexReviewerAdmission({ cwd: fixture.linkedRoot, request: request(fixture.head) });
  assert.equal(issued.ok, true);
  const before = sharedAdmissionRecordNames();
  const realList = spawnSync("git", ["worktree", "list", "--porcelain", "-z"], {
    cwd: fixture.mainRoot,
    encoding: "utf8",
  });
  assert.equal(realList.status, 0, realList.stderr);
  try {
    const result = admitPreparedCodexReviewer({
      cwd: fixture.mainRoot,
      toolInput: toolInput(),
      hooks: {
        git(cwd, args) {
          if (args[0] === "worktree" && args[1] === "list") {
            return `${realList.stdout}worktree ${foreignLinked}\0HEAD ${"a".repeat(40)}\0\0`;
          }
          return gitFixture(cwd, args);
        },
      },
    });
    assert.deepEqual(result, { ok: false, code: "intent-scan-failed" });
    assert.deepEqual(sharedAdmissionRecordNames(), before);
    assert.equal(existsSync(path.join(sharedAdmissionDir(), "codex-reviewer-intents", `${issued.intent_id}.claim`)), false);
  } finally {
    clearSharedPreparedIntent(issued);
    rmSync(foreignRoot, { recursive: true, force: true });
  }
});

test("consumed prepared intents are excluded so a fresh intent admits after prior success", () => {
  const fixture = sharedRealWorktreeFixture;
  const first = issueCodexReviewerAdmission({ cwd: fixture.linkedRoot, request: request(fixture.head) });
  assert.equal(first.ok, true);
  const before = sharedAdmissionRecordNames();
  try {
    const firstAdmit = admitPreparedCodexReviewer({ cwd: fixture.mainRoot, toolInput: toolInput() });
    assert.equal(firstAdmit.ok, true, firstAdmit.code);
    const second = issueCodexReviewerAdmission({ cwd: fixture.linkedRoot, request: request(fixture.head) });
    assert.equal(second.ok, true);
    const secondAdmit = admitPreparedCodexReviewer({ cwd: fixture.mainRoot, toolInput: toolInput() });
    assert.equal(secondAdmit.ok, true, secondAdmit.code);
    assert.notEqual(secondAdmit.record_id, firstAdmit.record_id);
    const after = sharedAdmissionRecordNames();
    assert.deepEqual(
      after.filter((name) => !before.includes(name)).sort(),
      [`${firstAdmit.record_id}.json`, `${secondAdmit.record_id}.json`].sort(),
    );
  } finally {
    for (const name of sharedAdmissionRecordNames().filter((entry) => !before.includes(entry))) {
      rmSync(path.join(sharedAdmissionDir(), name), { force: true });
      rmSync(path.join(sharedAdmissionDir(), `${name}.ok`), { force: true });
    }
    const intentDir = path.join(sharedAdmissionDir(), "codex-reviewer-intents");
    if (existsSync(intentDir)) {
      for (const name of readdirSync(intentDir)) {
        rmSync(path.join(intentDir, name), { recursive: true, force: true });
      }
    }
  }
});

test("main-rooted discovery fails closed for zero, multiple, stale, tamper, truncated list, budget, and candidate-read faults", () => {
  const fixture = sharedRealWorktreeFixture;
  const admissionDir = sharedAdmissionDir();
  const intentDir = path.join(admissionDir, "codex-reviewer-intents");
  const assertNoNewAuthority = (beforeRecords, issuedId = null) => {
    assert.deepEqual(sharedAdmissionRecordNames(), beforeRecords);
    if (issuedId) {
      assert.equal(existsSync(path.join(intentDir, `${issuedId}.claim`)), false);
      assert.equal(existsSync(path.join(admissionDir, `${issuedId}.json.ok`)), false);
    }
  };

  // zero live intents
  {
    const before = sharedAdmissionRecordNames();
    const result = admitPreparedCodexReviewer({ cwd: fixture.mainRoot, toolInput: toolInput() });
    assert.deepEqual(result, { ok: false, code: "intent-missing" });
    assertNoNewAuthority(before);
    assert.equal(existsSync(intentDir) ? readdirSync(intentDir).some((n) => n.endsWith(".claim")) : false, false);
  }

  // stale TTL
  {
    const before = sharedAdmissionRecordNames();
    const issued = issueCodexReviewerAdmission({
      cwd: fixture.linkedRoot,
      request: request(fixture.head, { ttl_seconds: 1 }),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    assert.equal(issued.ok, true);
    try {
      const result = admitPreparedCodexReviewer({
        cwd: fixture.mainRoot,
        toolInput: toolInput(),
        now: () => new Date("2026-01-01T00:10:01.000Z"),
      });
      assert.deepEqual(result, { ok: false, code: "intent-expired" });
      assertNoNewAuthority(before, issued.intent_id);
    } finally {
      clearSharedPreparedIntent(issued);
    }
  }

  // tamper bytes (trailing newline → noncanonical pretty JSON)
  {
    const before = sharedAdmissionRecordNames();
    const issued = issueCodexReviewerAdmission({ cwd: fixture.linkedRoot, request: request(fixture.head) });
    assert.equal(issued.ok, true);
    const intentPath = path.join(intentDir, `${issued.intent_id}.json`);
    const original = readFileSync(intentPath);
    try {
      writeFileSync(intentPath, Buffer.concat([original, Buffer.from("\n")]));
      const result = admitPreparedCodexReviewer({ cwd: fixture.mainRoot, toolInput: toolInput() });
      assert.deepEqual(result, { ok: false, code: "artifact-noncanonical" });
      assertNoNewAuthority(before, issued.intent_id);
    } finally {
      writeFileSync(intentPath, original);
      clearSharedPreparedIntent(issued);
    }
  }

  // malformed JSON candidate
  {
    const before = sharedAdmissionRecordNames();
    const issued = issueCodexReviewerAdmission({ cwd: fixture.linkedRoot, request: request(fixture.head) });
    assert.equal(issued.ok, true);
    const intentPath = path.join(intentDir, `${issued.intent_id}.json`);
    const original = readFileSync(intentPath);
    try {
      writeFileSync(intentPath, "{not-json\n");
      const result = admitPreparedCodexReviewer({ cwd: fixture.mainRoot, toolInput: toolInput() });
      assert.deepEqual(result, { ok: false, code: "artifact-unparseable" });
      assertNoNewAuthority(before, issued.intent_id);
    } finally {
      writeFileSync(intentPath, original);
      clearSharedPreparedIntent(issued);
    }
  }

  // invalid UTF-8 candidate
  {
    const before = sharedAdmissionRecordNames();
    const issued = issueCodexReviewerAdmission({ cwd: fixture.linkedRoot, request: request(fixture.head) });
    assert.equal(issued.ok, true);
    const intentPath = path.join(intentDir, `${issued.intent_id}.json`);
    const original = readFileSync(intentPath);
    try {
      writeFileSync(intentPath, Buffer.from([0x7b, 0xff, 0x7d, 0x0a]));
      const result = admitPreparedCodexReviewer({ cwd: fixture.mainRoot, toolInput: toolInput() });
      assert.deepEqual(result, { ok: false, code: "artifact-unparseable" });
      assertNoNewAuthority(before, issued.intent_id);
    } finally {
      writeFileSync(intentPath, original);
      clearSharedPreparedIntent(issued);
    }
  }

  // incomplete enumeration: invalid/unreadable change dir on a candidate fails the scan
  {
    const before = sharedAdmissionRecordNames();
    const issued = issueCodexReviewerAdmission({ cwd: fixture.linkedRoot, request: request(fixture.head) });
    assert.equal(issued.ok, true);
    const changePath = path.join(fixture.linkedRoot, "openspec", "changes", "review-fixture");
    const displaced = `${changePath}.displaced-invalid`;
    try {
      renameSync(changePath, displaced);
      symlinkSync(displaced, changePath, "dir");
      const result = admitPreparedCodexReviewer({ cwd: fixture.mainRoot, toolInput: toolInput() });
      assert.deepEqual(result, { ok: false, code: "intent-scan-failed" });
      assertNoNewAuthority(before, issued.intent_id);
    } finally {
      rmSync(changePath, { force: true });
      if (existsSync(displaced)) renameSync(displaced, changePath);
      clearSharedPreparedIntent(issued);
    }
  }

  // HEAD drift on linked worktree before claim
  {
    const before = sharedAdmissionRecordNames();
    const issued = issueCodexReviewerAdmission({ cwd: fixture.linkedRoot, request: request(fixture.head) });
    assert.equal(issued.ok, true);
    try {
      writeFileSync(path.join(fixture.linkedRoot, "drift-main-discovery"), "drift\n");
      gitFixture(fixture.linkedRoot, ["add", "drift-main-discovery"]);
      gitFixture(fixture.linkedRoot, ["commit", "-qm", "drift-main-discovery"]);
      const result = admitPreparedCodexReviewer({ cwd: fixture.mainRoot, toolInput: toolInput() });
      assert.deepEqual(result, { ok: false, code: "intent-tuple-mismatch" });
      assertNoNewAuthority(before, issued.intent_id);
    } finally {
      gitFixture(fixture.linkedRoot, ["reset", "--hard", fixture.head]);
      clearSharedPreparedIntent(issued);
    }
  }

  // multiple live intents across two linked worktrees
  {
    const before = sharedAdmissionRecordNames();
    const secondLinked = path.join(fixture.mainRoot, ".worktree", "review-fixture-b");
    mkdirSync(path.join(fixture.mainRoot, "openspec", "changes", "review-fixture-b"), { recursive: true });
    writeFileSync(path.join(fixture.mainRoot, "openspec", "changes", "review-fixture-b", "tasks.md"), "# B\n");
    gitFixture(fixture.mainRoot, ["add", "openspec/changes/review-fixture-b/tasks.md"]);
    gitFixture(fixture.mainRoot, ["commit", "-qm", "second-change-folder"]);
    const secondHead = gitFixture(fixture.mainRoot, ["rev-parse", "HEAD"]);
    gitFixture(fixture.mainRoot, ["worktree", "add", "-q", "-b", "review-fixture-b-linked", secondLinked, "HEAD"]);
    const first = issueCodexReviewerAdmission({ cwd: fixture.linkedRoot, request: request(fixture.head) });
    const second = issueCodexReviewerAdmission({
      cwd: secondLinked,
      request: request(secondHead, { change_id: "review-fixture-b" }),
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    try {
      const result = admitPreparedCodexReviewer({ cwd: fixture.mainRoot, toolInput: toolInput() });
      assert.deepEqual(result, { ok: false, code: "intent-ambiguous" });
      assertNoNewAuthority(before, first.intent_id);
    } finally {
      clearSharedPreparedIntent(first);
      rmSync(path.join(secondLinked, "openspec", "changes", "review-fixture-b", "admission-records"), {
        recursive: true,
        force: true,
      });
      gitFixture(fixture.mainRoot, ["worktree", "remove", "-f", secondLinked]);
      gitFixture(fixture.mainRoot, ["branch", "-D", "review-fixture-b-linked"]);
    }
  }

  // truncated / incomplete worktree list
  {
    const before = sharedAdmissionRecordNames();
    const issued = issueCodexReviewerAdmission({ cwd: fixture.linkedRoot, request: request(fixture.head) });
    assert.equal(issued.ok, true);
    try {
      const result = admitPreparedCodexReviewer({
        cwd: fixture.mainRoot,
        toolInput: toolInput(),
        hooks: {
          git(cwd, args) {
            if (args[0] === "worktree" && args[1] === "list") {
              return "worktree /tmp/incomplete-without-terminator";
            }
            return gitFixture(cwd, args);
          },
        },
      });
      assert.deepEqual(result, { ok: false, code: "intent-scan-failed" });
      assertNoNewAuthority(before, issued.intent_id);
    } finally {
      clearSharedPreparedIntent(issued);
    }
  }

  // 65 non-UUID `{}` decoys are no longer a budget event (only entries are budgeted, 8192): each is a fully
  // validated candidate, and the first one that is not a UUID-named intent fails closed with identifier-invalid
  {
    const before = sharedAdmissionRecordNames();
    const issued = issueCodexReviewerAdmission({ cwd: fixture.linkedRoot, request: request(fixture.head) });
    assert.equal(issued.ok, true);
    const decoys = [];
    try {
      for (let i = 0; i < 65; i += 1) {
        const name = `decoy-${String(i).padStart(2, "0")}.json`;
        const target = path.join(intentDir, name);
        writeFileSync(target, "{}\n");
        decoys.push(target);
      }
      const result = admitPreparedCodexReviewer({ cwd: fixture.mainRoot, toolInput: toolInput() });
      assert.deepEqual(result, { ok: false, code: "identifier-invalid" });
      assertNoNewAuthority(before, issued.intent_id);
    } finally {
      for (const decoy of decoys) rmSync(decoy, { force: true });
      clearSharedPreparedIntent(issued);
    }
  }

  // candidate-read I/O failure while uniqueness still undecided
  {
    const before = sharedAdmissionRecordNames();
    const issued = issueCodexReviewerAdmission({ cwd: fixture.linkedRoot, request: request(fixture.head) });
    assert.equal(issued.ok, true);
    try {
      const result = admitPreparedCodexReviewer({
        cwd: fixture.mainRoot,
        toolInput: toolInput(),
        hooks: {
          readdirIntentDir() {
            const error = new Error("EIO");
            error.code = "EIO";
            throw error;
          },
        },
      });
      assert.deepEqual(result, { ok: false, code: "intent-scan-failed" });
      assertNoNewAuthority(before, issued.intent_id);
    } finally {
      clearSharedPreparedIntent(issued);
    }
  }
});

test("linked-root admission succeeds once and binds the canonical linked-worktree digest", () => {
  const fixture = sharedRealWorktreeFixture;
  const issued = issueCodexReviewerAdmission({ cwd: fixture.linkedRoot, request: request(fixture.head) });
  assert.equal(issued.ok, true);
  const before = sharedAdmissionRecordNames();
  try {
    const admitted = admitPreparedCodexReviewer({ cwd: fixture.linkedRoot, toolInput: toolInput() });
    assert.equal(admitted.ok, true, admitted.code);
    const after = sharedAdmissionRecordNames();
    assert.deepEqual(after.filter((name) => !before.includes(name)), [`${admitted.record_id}.json`]);
    const record = JSON.parse(readFileSync(path.join(sharedAdmissionDir(), `${admitted.record_id}.json`), "utf8"));
    const expectedDigest = createHash("sha256").update(realpathSync(fixture.linkedRoot), "utf8").digest("hex");
    assert.equal(record.canonical_worktree_sha256, expectedDigest);
    assert.deepEqual(admitPreparedCodexReviewer({ cwd: fixture.linkedRoot, toolInput: toolInput() }), {
      ok: false,
      code: "intent-consumed",
    });
  } finally {
    clearSharedPreparedIntent(issued);
  }
});

test("two concurrent linked-root consumers produce exactly one admission winner", async () => {
  const fixture = sharedRealWorktreeFixture;
  const issued = issueCodexReviewerAdmission({ cwd: fixture.linkedRoot, request: request(fixture.head) });
  assert.equal(issued.ok, true);
  const before = sharedAdmissionRecordNames();
  try {
    const results = await Promise.all([
      admitPreparedInChild(fixture.linkedRoot, toolInput()),
      admitPreparedInChild(fixture.linkedRoot, toolInput()),
    ]);
    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);
    assert.equal(winners.length, 1, JSON.stringify(results));
    assert.deepEqual(losers, [{ ok: false, code: "intent-consumed" }]);
    const after = sharedAdmissionRecordNames();
    assert.deepEqual(after.filter((name) => !before.includes(name)), [`${winners[0].record_id}.json`]);
    const record = JSON.parse(readFileSync(path.join(sharedAdmissionDir(), `${winners[0].record_id}.json`), "utf8"));
    assert.equal(
      record.canonical_worktree_sha256,
      createHash("sha256").update(realpathSync(fixture.linkedRoot), "utf8").digest("hex"),
    );
  } finally {
    clearSharedPreparedIntent(issued);
  }
});

test("preclaim authority drift is rejected without consuming intent or publishing admission", () => {
  const fixture = sharedRealWorktreeFixture;
  const canonicalLinkedRootBefore = realpathSync(fixture.linkedRoot);
  const displacedLinkedRoot = `${fixture.linkedRoot}.preclaim-realpath-drift`;
  let headDriftSha;
  const observations = {
    head: exercisePreclaimDrift({
      mutate: () => {
        gitFixture(fixture.linkedRoot, ["commit", "--allow-empty", "-qm", "preclaim HEAD drift"]);
        headDriftSha = gitFixture(fixture.linkedRoot, ["rev-parse", "HEAD"]);
      },
      restore: () => { gitFixture(fixture.linkedRoot, ["update-ref", "HEAD", fixture.head, headDriftSha]); },
    }),
    realpath: exercisePreclaimDrift({
      mutate: () => {
        renameSync(fixture.linkedRoot, displacedLinkedRoot);
        symlinkSync(displacedLinkedRoot, fixture.linkedRoot, "dir");
      },
      restore: () => {
        rmSync(fixture.linkedRoot, { force: true });
        renameSync(displacedLinkedRoot, fixture.linkedRoot);
      },
    }),
    noncanonicalIntentBytes: exercisePreclaimDrift({
      mutate: ({ intentPath, intentBytes }) => {
        writeFileSync(intentPath, Buffer.concat([intentBytes, Buffer.from("\n")]));
      },
    }),
    canonicalIntentDigest: exercisePreclaimDrift({
      mutate: ({ intentPath, intentBytes }) => {
        const intent = JSON.parse(intentBytes.toString("utf8"));
        intent.evidence_scope = "changed canonical intent content";
        writeFileSync(intentPath, `${JSON.stringify(intent, null, 2)}\n`);
      },
    }),
  };
  assert.deepEqual({
    observations,
    fixtureHeadRestored: gitFixture(fixture.linkedRoot, ["rev-parse", "HEAD"]) === fixture.head,
    fixtureRealpathRestored: realpathSync(fixture.linkedRoot) === canonicalLinkedRootBefore,
  }, {
    observations: {
      head: { resultOk: false, resultCode: "intent-tuple-mismatch", claimExists: false, newRecordCount: 0 },
      realpath: { resultOk: false, resultCode: "intent-tuple-mismatch", claimExists: false, newRecordCount: 0 },
      noncanonicalIntentBytes: { resultOk: false, resultCode: "artifact-noncanonical", claimExists: false, newRecordCount: 0 },
      canonicalIntentDigest: { resultOk: false, resultCode: "intent-tuple-mismatch", claimExists: false, newRecordCount: 0 },
    },
    fixtureHeadRestored: true,
    fixtureRealpathRestored: true,
  });
});

test("postclaim admission commit point keeps hook outcome aligned with normal verification", async (t) => {
  await t.test("HEAD drift after claim returns the stable tuple rejection", () => {
    const observed = exercisePostclaimFault({
      recordId: "22222222-2222-4222-8222-222222222222",
      hooksFor: ({ fixture, state }) => ({
        afterClaim: () => {
          gitFixture(fixture.linkedRoot, ["commit", "--allow-empty", "-qm", "postclaim HEAD drift"]);
          state.driftHead = gitFixture(fixture.linkedRoot, ["rev-parse", "HEAD"]);
        },
      }),
      restoreAuthority: ({ fixture, state }) => {
        if (state.driftHead) {
          gitFixture(fixture.linkedRoot, ["update-ref", "HEAD", fixture.head, state.driftHead]);
          delete state.driftHead;
        }
      },
    });
    assert.deepEqual(observed, {
      result: { ok: false, code: "intent-tuple-mismatch" },
      claimConsumed: true,
      recordExists: false,
      stagingExists: false,
      readyExists: false,
      recordVerifies: false,
      retry: { ok: false, code: "intent-consumed" },
    });
  });

  await t.test("canonical intent content drift after claim returns the stable tuple rejection", () => {
    const observed = exercisePostclaimFault({
      recordId: "33333333-3333-4333-8333-333333333333",
      hooksFor: ({ intentPath, intentBytes }) => ({
        afterClaim: () => {
          const intent = JSON.parse(intentBytes.toString("utf8"));
          intent.evidence_scope = "postclaim canonical intent drift";
          writeFileSync(intentPath, `${JSON.stringify(intent, null, 2)}\n`);
        },
      }),
      restoreAuthority: ({ intentPath, intentBytes }) => { writeFileSync(intentPath, intentBytes); },
    });
    assert.deepEqual(observed, {
      result: { ok: false, code: "intent-tuple-mismatch" },
      claimConsumed: true,
      recordExists: false,
      stagingExists: false,
      readyExists: false,
      recordVerifies: false,
      retry: { ok: false, code: "intent-consumed" },
    });
  });

  await t.test("durable admission-record publication failure preserves the consumed claim", () => {
    let beforeOpenCount = 0;
    const observed = exercisePostclaimFault({
      recordId: "44444444-4444-4444-8444-444444444444",
      hooksFor: () => ({
        beforeOpen: () => {
          beforeOpenCount += 1;
          if (beforeOpenCount === 2) throw new Error("injected admission-record publication fault");
        },
      }),
    });
    assert.deepEqual(observed, {
      result: { ok: false, code: "admission-record-write-failed" },
      claimConsumed: true,
      recordExists: false,
      stagingExists: false,
      readyExists: false,
      recordVerifies: false,
      retry: { ok: false, code: "intent-consumed" },
    });
  });

  await t.test("pre-commit file fsync EIO stays consumed without a verifiable admission record", () => {
    let fsyncFileCount = 0;
    const observed = exercisePostclaimFault({
      recordId: "c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4",
      hooksFor: () => ({
        fsyncFile: (fd) => {
          fsyncFileCount += 1;
          // Claim consumed.json is the first exclusive durable write; the
          // admission record is the second. Fail before createExclusiveDurableFile
          // returns so the commit point is never reached.
          if (fsyncFileCount === 2) {
            const error = new Error("injected pre-commit admission-record fsync EIO");
            error.code = "EIO";
            throw error;
          }
          fsyncSync(fd);
        },
      }),
    });
    assert.deepEqual(observed, {
      result: { ok: false, code: "admission-record-write-failed" },
      claimConsumed: true,
      recordExists: false,
      stagingExists: false,
      readyExists: false,
      recordVerifies: false,
      retry: { ok: false, code: "intent-consumed" },
    });
  });

  await t.test("pre-commit close EIO after body stays consumed without a verifiable admission record", () => {
    let closeFileCount = 0;
    const observed = exercisePostclaimFault({
      recordId: "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4",
      hooksFor: () => ({
        closeFile: (fd) => {
          closeFileCount += 1;
          // Claim consumed.json is the first exclusive durable write; the
          // admission staging file is the second. Body+fsync already succeeded;
          // late close must not promote to `${recordId}.json` authority beside
          // admission-record-write-failed (staging leftover is non-authoritative).
          if (closeFileCount === 2) {
            const error = new Error("injected pre-commit admission-record close EIO");
            error.code = "EIO";
            throw error;
          }
          closeSync(fd);
        },
      }),
    });
    assert.deepEqual(observed, {
      result: { ok: false, code: "admission-record-write-failed" },
      claimConsumed: true,
      recordExists: false,
      stagingExists: false,
      readyExists: false,
      recordVerifies: false,
      retry: { ok: false, code: "intent-consumed" },
    });
  });

  await t.test("late close EIO with unlink failure leaves only non-authoritative staging", () => {
    let closeFileCount = 0;
    const observed = exercisePostclaimFault({
      recordId: "e4e4e4e4-e4e4-4e4e-8e4e-e4e4e4e4e4e4",
      hooksFor: () => ({
        closeFile: (fd) => {
          closeFileCount += 1;
          if (closeFileCount === 2) {
            const error = new Error("injected pre-commit admission-record close EIO");
            error.code = "EIO";
            throw error;
          }
          closeSync(fd);
        },
        unlinkAdmissionTarget: () => {
          const error = new Error("injected staging unlink failure");
          error.code = "EACCES";
          throw error;
        },
      }),
    });
    assert.deepEqual(observed, {
      result: { ok: false, code: "admission-record-write-failed" },
      claimConsumed: true,
      recordExists: false,
      stagingExists: true,
      readyExists: false,
      recordVerifies: false,
      retry: { ok: false, code: "intent-consumed" },
    });
  });

  await t.test("no-replace publish refuses an existing final path without deleting it", () => {
    const recordId = "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1";
    const preexisting = Buffer.from('{"preexisting":true}\n');
    const fixture = sharedRealWorktreeFixture;
    const issued = issueCodexReviewerAdmission({ cwd: fixture.linkedRoot, request: request(fixture.head) });
    assert.equal(issued.ok, true);
    const intentDir = path.join(sharedAdmissionDir(), "codex-reviewer-intents");
    const claimProofPath = path.join(intentDir, `${issued.intent_id}.claim`, "consumed.json");
    const recordPath = path.join(sharedAdmissionDir(), `${recordId}.json`);
    const stagingPath = path.join(sharedAdmissionDir(), `${recordId}.json.publishing`);
    try {
      writeFileSync(recordPath, preexisting);
      const result = admitPreparedCodexReviewer({
        cwd: fixture.linkedRoot,
        toolInput: toolInput(),
        uuid: () => recordId,
      });
      assert.deepEqual(
        {
          result: { ok: result.ok, code: result.code ?? null },
          claimConsumed: existsSync(claimProofPath),
          recordExists: existsSync(recordPath),
          stagingExists: existsSync(stagingPath),
          readyExists: existsSync(path.join(sharedAdmissionDir(), `${recordId}.json.ok`)),
          preexistingPreserved: readFileSync(recordPath).equals(preexisting),
          recordVerifies: verifyCodexReviewerAdmissionAuthority({
            repoRoot: fixture.linkedRoot,
            changeId: "review-fixture",
            recordId,
          }).ok,
          retry: admitPreparedCodexReviewer({ cwd: fixture.linkedRoot, toolInput: toolInput() }),
        },
        {
          result: { ok: false, code: "admission-record-write-failed" },
          claimConsumed: true,
          recordExists: true,
          stagingExists: false,
          readyExists: false,
          preexistingPreserved: true,
          recordVerifies: false,
          retry: { ok: false, code: "intent-consumed" },
        },
      );
    } finally {
      rmSync(recordPath, { force: true });
      rmSync(stagingPath, { force: true });
      rmSync(path.join(sharedAdmissionDir(), `${recordId}.json.ok`), { force: true });
      clearSharedPreparedIntent(issued);
    }
  });

  await t.test("link failure before ownership proof leaves preexisting final untouched", () => {
    const recordId = "f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2";
    const preexisting = Buffer.from('{"foreign":true}\n');
    const fixture = sharedRealWorktreeFixture;
    const issued = issueCodexReviewerAdmission({ cwd: fixture.linkedRoot, request: request(fixture.head) });
    assert.equal(issued.ok, true);
    const intentDir = path.join(sharedAdmissionDir(), "codex-reviewer-intents");
    const claimProofPath = path.join(intentDir, `${issued.intent_id}.claim`, "consumed.json");
    const recordPath = path.join(sharedAdmissionDir(), `${recordId}.json`);
    const stagingPath = path.join(sharedAdmissionDir(), `${recordId}.json.publishing`);
    try {
      writeFileSync(recordPath, preexisting);
      const result = admitPreparedCodexReviewer({
        cwd: fixture.linkedRoot,
        toolInput: toolInput(),
        uuid: () => recordId,
        hooks: {
          linkAdmissionTarget: () => {
            const error = new Error("injected exclusive link failure");
            error.code = "EIO";
            throw error;
          },
        },
      });
      assert.deepEqual(
        {
          result: { ok: result.ok, code: result.code ?? null },
          claimConsumed: existsSync(claimProofPath),
          recordExists: existsSync(recordPath),
          stagingExists: existsSync(stagingPath),
          readyExists: existsSync(path.join(sharedAdmissionDir(), `${recordId}.json.ok`)),
          preexistingPreserved: existsSync(recordPath) && readFileSync(recordPath).equals(preexisting),
          recordVerifies: verifyCodexReviewerAdmissionAuthority({
            repoRoot: fixture.linkedRoot,
            changeId: "review-fixture",
            recordId,
          }).ok,
          retry: admitPreparedCodexReviewer({ cwd: fixture.linkedRoot, toolInput: toolInput() }),
        },
        {
          result: { ok: false, code: "admission-record-write-failed" },
          claimConsumed: true,
          recordExists: true,
          stagingExists: false,
          readyExists: false,
          preexistingPreserved: true,
          recordVerifies: false,
          retry: { ok: false, code: "intent-consumed" },
        },
      );
    } finally {
      rmSync(recordPath, { force: true });
      rmSync(stagingPath, { force: true });
      rmSync(path.join(sharedAdmissionDir(), `${recordId}.json.ok`), { force: true });
      clearSharedPreparedIntent(issued);
    }
  });

  await t.test("final parent-fsync failure scrubs owned publication before commit", () => {
    let fsyncDirCount = 0;
    const observed = exercisePostclaimFault({
      recordId: "f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3",
      hooksFor: () => ({
        fsyncDir: (directory) => {
          fsyncDirCount += 1;
          // Claim directory durability is the first hooks.fsyncDir call; the
          // authoritative admission-record parent fsync is the commit-point call.
          if (fsyncDirCount === 1) return fsyncDirectory(directory);
          const error = new Error("injected final parent fsync EIO");
          error.code = "EIO";
          throw error;
        },
      }),
    });
    assert.deepEqual(observed, {
      result: { ok: false, code: "admission-record-write-failed" },
      claimConsumed: true,
      recordExists: false,
      stagingExists: false,
      readyExists: false,
      recordVerifies: false,
      retry: { ok: false, code: "intent-consumed" },
    });
  });

  await t.test("final parent-fsync failure with final unlink failure leaves unverifiable survivor", () => {
    let fsyncDirCount = 0;
    const observed = exercisePostclaimFault({
      recordId: "f4f4f4f4-f4f4-4f4f-8f4f-f4f4f4f4f4f4",
      hooksFor: ({ recordPath }) => ({
        fsyncDir: (directory) => {
          fsyncDirCount += 1;
          if (fsyncDirCount === 1) return fsyncDirectory(directory);
          const error = new Error("injected final parent fsync EIO");
          error.code = "EIO";
          throw error;
        },
        unlinkAdmissionTarget: (candidate) => {
          if (candidate === recordPath) {
            const error = new Error("injected final unlink failure");
            error.code = "EACCES";
            throw error;
          }
          unlinkSync(candidate);
        },
      }),
    });
    assert.equal(observed.result.ok, false);
    assert.equal(observed.result.code, "admission-record-write-failed");
    assert.equal(observed.claimConsumed, true);
    assert.equal(observed.readyExists, false);
    assert.equal(observed.recordVerifies, false);
    assert.deepEqual(observed.retry, { ok: false, code: "intent-consumed" });
  });

  await t.test("pre-commit cleanup observation failure without commit marker stays unverifiable", () => {
    let fsyncDirCount = 0;
    const observed = exercisePostclaimFault({
      recordId: "f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5",
      hooksFor: ({ recordPath }) => ({
        fsyncDir: (directory) => {
          fsyncDirCount += 1;
          if (fsyncDirCount === 1) return fsyncDirectory(directory);
          const error = new Error("injected final parent fsync EIO");
          error.code = "EIO";
          throw error;
        },
        unlinkAdmissionTarget: (candidate) => {
          if (candidate === recordPath) {
            const error = new Error("injected final unlink failure");
            error.code = "EACCES";
            throw error;
          }
          unlinkSync(candidate);
        },
        invalidateOwnedAdmissionTarget: () => {
          const error = new Error("injected invalidate failure");
          error.code = "EPERM";
          throw error;
        },
      }),
    });
    assert.equal(observed.result.ok, false);
    assert.equal(observed.result.code, "admission-record-write-failed");
    assert.equal(observed.claimConsumed, true);
    assert.equal(observed.readyExists, false);
    assert.equal(observed.recordVerifies, false);
    assert.deepEqual(observed.retry, { ok: false, code: "intent-consumed" });
  });

  await t.test("positively missing admission record blocks and fails normal verification", () => {
    const observed = exercisePostclaimFault({
      recordId: "55555555-5555-4555-8555-555555555555",
      hooksFor: ({ recordPath }) => ({
        beforeAdmissionReadback: () => { rmSync(recordPath, { force: true }); },
      }),
    });
    assert.deepEqual(observed, {
      result: { ok: false, code: "admission-record-readback-mismatch" },
      claimConsumed: true,
      recordExists: false,
      stagingExists: false,
      readyExists: true,
      recordVerifies: false,
      retry: { ok: false, code: "intent-consumed" },
    });
  });

  await t.test("positively mismatched admission record blocks and fails normal verification", () => {
    const observed = exercisePostclaimFault({
      recordId: "66666666-6666-4666-8666-666666666666",
      hooksFor: ({ recordPath }) => ({
        beforeAdmissionReadback: () => { writeFileSync(recordPath, "{}\n"); },
      }),
    });
    assert.deepEqual(observed, {
      result: { ok: false, code: "admission-record-readback-mismatch" },
      claimConsumed: true,
      recordExists: true,
      stagingExists: false,
      readyExists: true,
      recordVerifies: false,
      retry: { ok: false, code: "intent-consumed" },
    });
  });

  await t.test("positively unsafe admission record blocks and fails normal verification", () => {
    const observed = exercisePostclaimFault({
      recordId: "77777777-7777-4777-8777-777777777777",
      hooksFor: ({ intentPath, recordPath }) => ({
        beforeAdmissionReadback: () => {
          rmSync(recordPath, { force: true });
          symlinkSync(intentPath, recordPath);
        },
      }),
    });
    assert.deepEqual(observed, {
      result: { ok: false, code: "admission-record-readback-mismatch" },
      claimConsumed: true,
      recordExists: true,
      stagingExists: false,
      readyExists: true,
      recordVerifies: false,
      retry: { ok: false, code: "intent-consumed" },
    });
  });

  await t.test("transient post-publication read fault cannot block a valid admission", () => {
    const observed = exercisePostclaimFault({
      recordId: "88888888-8888-4888-8888-888888888888",
      hooksFor: () => ({
        readAdmissionRecord: () => {
          const error = new Error("injected transient readback observation fault");
          error.code = "EIO";
          throw error;
        },
      }),
    });
    assert.deepEqual(observed, {
      result: { ok: true, code: null },
      claimConsumed: true,
      recordExists: true,
      stagingExists: false,
      readyExists: true,
      recordVerifies: true,
      retry: { ok: false, code: "intent-consumed" },
    });
  });

  await t.test("permission denied post-publication readback is a transient observation fault", () => {
    for (const [recordId, code] of [
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "EACCES"],
      ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "EPERM"],
    ]) {
      const observed = exercisePostclaimFault({
        recordId,
        hooksFor: () => ({
          readAdmissionRecord: () => {
            const error = new Error(`injected ${code} readback fault`);
            error.code = code;
            throw error;
          },
        }),
      });
      assert.deepEqual(observed, {
        result: { ok: true, code: null },
        claimConsumed: true,
        recordExists: true,
        stagingExists: false,
        readyExists: true,
        recordVerifies: true,
        retry: { ok: false, code: "intent-consumed" },
      }, `${code} must not recreate split-brain when the verifier still accepts`);
    }
  });

  await t.test("transient post-publication diagnostic hook fault cannot block a valid admission", () => {
    const observed = exercisePostclaimFault({
      recordId: "99999999-9999-4999-8999-999999999999",
      hooksFor: () => ({
        beforeAdmissionReadback: () => {
          const error = new Error("injected diagnostic hook fault");
          error.code = "EIO";
          throw error;
        },
      }),
    });
    assert.deepEqual(observed, {
      result: { ok: true, code: null },
      claimConsumed: true,
      recordExists: true,
      stagingExists: false,
      readyExists: true,
      recordVerifies: true,
      retry: { ok: false, code: "intent-consumed" },
    });
  });
});

test("issue CLI writes canonical prepared intent and rejects duplicate/wrong-casing requests", () => {
  const { root, cwd, head } = fixture();
  try {
    const requestPath = path.join(root, "request.json");
    writeFileSync(requestPath, JSON.stringify(request(head)));
    const issued = spawnSync("node", [SCRIPT, "--request", requestPath], { cwd, encoding: "utf8" });
    assert.equal(issued.status, 0, issued.stderr);
    const result = JSON.parse(issued.stdout);
    assert.equal(result.ok, true);
    const bytes = readFileSync(path.join(cwd, result.path));
    assert.equal(bytes.at(-1), 0x0a);
    assert.equal(result.digest_sha256.length, 64);

    writeFileSync(requestPath, '{"schema":"x","schema":"y"}');
    const duplicate = spawnSync("node", [SCRIPT, "--request", requestPath], { cwd, encoding: "utf8" });
    assert.equal(duplicate.status, 1);
    assert.deepEqual(JSON.parse(duplicate.stdout), { ok: false, code: "request-unparseable" });

    writeFileSync(requestPath, JSON.stringify({ repoRoot: cwd, changeId: "review-fixture" }));
    const wrongCase = spawnSync("node", [SCRIPT, "--request", requestPath], { cwd, encoding: "utf8" });
    assert.equal(wrongCase.status, 1);
    assert.deepEqual(JSON.parse(wrongCase.stdout), { ok: false, code: "request-shape-invalid" });

    truncateSync(requestPath, 64 * 1024 + 1);
    const oversized = spawnSync("node", [SCRIPT, "--request", requestPath], { cwd, encoding: "utf8" });
    assert.equal(oversized.status, 1);
    assert.deepEqual(JSON.parse(oversized.stdout), { ok: false, code: "request-size-exceeded" });

    const symlinkTarget = path.join(root, "real-request.json");
    const symlinkRequest = path.join(root, "linked-request.json");
    writeFileSync(symlinkTarget, JSON.stringify(request(head, { task_name: "symlink_review" })));
    symlinkSync(symlinkTarget, symlinkRequest);
    const linked = spawnSync("node", [SCRIPT, "--request", symlinkRequest], { cwd, encoding: "utf8" });
    assert.equal(linked.status, 1);
    assert.deepEqual(JSON.parse(linked.stdout), { ok: false, code: "request-unparseable" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("plaintext and opaque named dp-reviewer use the same zero/one/many intent admission", async (t) => {
  for (const carrier of ["plaintext", "opaque"]) {
    await t.test(carrier, () => {
      const { root, cwd, head } = fixture();
      try {
        const input = toolInput({ message: carrier === "opaque" ? "gAAAAA" + "b".repeat(48) : "review bounded diff" });
        assert.equal(admitPreparedCodexReviewer({ cwd, toolInput: input }).code, "intent-missing");
        assert.equal(issueCodexReviewerAdmission({ cwd, request: request(head) }).ok, true);
        const admitted = admitPreparedCodexReviewer({ cwd, toolInput: input });
        assert.equal(admitted.ok, true);
        assert.deepEqual(Object.keys(admitted.record), CODEX_REVIEWER_ADMISSION_KEYS);
        assert.equal(validateAdmissionRecordV2(admitted.record).ok, true);
        assert.equal(admitPreparedCodexReviewer({ cwd, toolInput: input }).code, "intent-consumed");
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  const { root, cwd, head } = fixture();
  try {
    assert.equal(issueCodexReviewerAdmission({ cwd, request: request(head) }).ok, true);
    assert.equal(issueCodexReviewerAdmission({ cwd, request: request(head) }).ok, true);
    assert.equal(admitPreparedCodexReviewer({ cwd, toolInput: toolInput() }).code, "intent-ambiguous");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("spawn response loss recovers the exact claimed admission through the consumed intent", () => {
  const { root, cwd, head } = fixture();
  try {
    const issued = issueCodexReviewerAdmission({ cwd, request: request(head) });
    assert.equal(issued.ok, true);
    assert.deepEqual(
      recoverCodexReviewerAdmission({ cwd, request: recoveryRequest(issued) }),
      { ok: false, code: "authority-binding-mismatch" },
    );

    const admitted = admitPreparedCodexReviewer({ cwd, toolInput: toolInput() });
    assert.equal(admitted.ok, true);
    const recovered = recoverCodexReviewerAdmission({ cwd, request: recoveryRequest(issued) });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.intent_id, issued.intent_id);
    assert.equal(recovered.record_id, admitted.record_id);
    assert.equal(recovered.digest, admitted.digest);
    assert.equal(recovered.handoff, `admission_record: ${admitted.record_id} sha256=${admitted.digest}`);

    const requestPath = path.join(root, "recover.json");
    writeFileSync(requestPath, JSON.stringify(recoveryRequest(issued)));
    const cli = spawnSync("node", [SCRIPT, "--recover", requestPath], { cwd, encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).record_id, admitted.record_id);

    assert.deepEqual(
      recoverCodexReviewerAdmission({ cwd, request: recoveryRequest(issued, { intent_sha256: "0".repeat(64) }) }),
      { ok: false, code: "authority-binding-mismatch" },
    );
    writeFileSync(requestPath, '{"schema":"x","schema":"y"}');
    const duplicate = spawnSync("node", [SCRIPT, "--recover", requestPath], { cwd, encoding: "utf8" });
    assert.equal(duplicate.status, 1);
    assert.deepEqual(JSON.parse(duplicate.stdout), { ok: false, code: "request-unparseable" });

    writeFileSync(path.join(cwd, "drift"), "drift\n");
    execFileSync("git", ["add", "drift"], { cwd });
    execFileSync("git", ["commit", "-qm", "drift"], { cwd });
    assert.deepEqual(
      recoverCodexReviewerAdmission({ cwd, request: recoveryRequest(issued) }),
      { ok: false, code: "intent-tuple-mismatch" },
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The issuer CLI explains the two closed codes whose cause is usually the caller's cwd or a moved HEAD. stdout JSON and the exit
// code are the contract and never change; the hint is one stderr line, and success writes nothing to stderr.
const RECOVER_HINT_HEAD = "issue-codex-reviewer-admission: intent-tuple-mismatch — ";
const IDENTIFIER_HINT_HEAD = "issue-codex-reviewer-admission: identifier-invalid — ";

function plainGitRepoOutsideWorktreeDir(root) {
  const elsewhere = path.join(root, "main-checkout");
  mkdirSync(elsewhere, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: elsewhere });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: elsewhere });
  execFileSync("git", ["config", "user.name", "fixture"], { cwd: elsewhere });
  writeFileSync(path.join(elsewhere, "seed"), "seed\n");
  execFileSync("git", ["add", "seed"], { cwd: elsewhere });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: elsewhere });
  return elsewhere;
}

test("recover CLI explains intent-tuple-mismatch on stderr when the cwd is not the issuing worktree", () => {
  const { root, cwd, head } = fixture();
  try {
    const issued = issueCodexReviewerAdmission({ cwd, request: request(head) });
    assert.equal(issued.ok, true);
    assert.equal(admitPreparedCodexReviewer({ cwd, toolInput: toolInput() }).ok, true);
    const requestPath = path.join(root, "recover.json");
    writeFileSync(requestPath, JSON.stringify(recoveryRequest(issued)));

    const success = spawnSync("node", [SCRIPT, "--recover", requestPath], { cwd, encoding: "utf8" });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(success.stderr, "", "a successful recover writes nothing to stderr");

    const elsewhere = plainGitRepoOutsideWorktreeDir(root);
    const wrongCwd = spawnSync("node", [SCRIPT, "--recover", requestPath], { cwd: elsewhere, encoding: "utf8" });
    assert.equal(wrongCwd.status, 1);
    assert.deepEqual(JSON.parse(wrongCwd.stdout), { ok: false, code: "intent-tuple-mismatch" });
    assert.equal(wrongCwd.stderr.startsWith(RECOVER_HINT_HEAD), true, wrongCwd.stderr);
    assert.equal(wrongCwd.stderr.endsWith("\n"), true);
    assert.equal(wrongCwd.stderr.trimEnd().split("\n").length, 1, "the hint is exactly one stderr line");
    assert.match(wrongCwd.stderr, /same `\.worktree\/<change_id>` checkout the intent was issued from/);
    assert.match(wrongCwd.stderr, /`request\.change_id` must equal that change id/);
    assert.match(wrongCwd.stderr, /HEAD must still be the commit the intent was issued for/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recover CLI explains intent-tuple-mismatch on stderr when HEAD moved after the intent was issued", () => {
  const { root, cwd, head } = fixture();
  try {
    const issued = issueCodexReviewerAdmission({ cwd, request: request(head) });
    assert.equal(issued.ok, true);
    assert.equal(admitPreparedCodexReviewer({ cwd, toolInput: toolInput() }).ok, true);
    const requestPath = path.join(root, "recover.json");
    writeFileSync(requestPath, JSON.stringify(recoveryRequest(issued)));
    writeFileSync(path.join(cwd, "drift"), "drift\n");
    execFileSync("git", ["add", "drift"], { cwd });
    execFileSync("git", ["commit", "-qm", "drift"], { cwd });

    const drifted = spawnSync("node", [SCRIPT, "--recover", requestPath], { cwd, encoding: "utf8" });
    assert.equal(drifted.status, 1);
    assert.deepEqual(JSON.parse(drifted.stdout), { ok: false, code: "intent-tuple-mismatch" });
    assert.equal(drifted.stderr.startsWith(RECOVER_HINT_HEAD), true, drifted.stderr);
    assert.match(drifted.stderr, /HEAD must still be the commit the intent was issued for/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recover CLI keeps other failure codes free of the intent-tuple-mismatch hint", () => {
  const { root, cwd, head } = fixture();
  try {
    const issued = issueCodexReviewerAdmission({ cwd, request: request(head) });
    assert.equal(issued.ok, true);
    // Never admitted, so there is no claim: authority-binding-mismatch, which the tuple hint would mislabel.
    const requestPath = path.join(root, "recover.json");
    writeFileSync(requestPath, JSON.stringify(recoveryRequest(issued)));
    const unclaimed = spawnSync("node", [SCRIPT, "--recover", requestPath], { cwd, encoding: "utf8" });
    assert.equal(unclaimed.status, 1);
    assert.deepEqual(JSON.parse(unclaimed.stdout), { ok: false, code: "authority-binding-mismatch" });
    assert.equal(unclaimed.stderr, "");

    writeFileSync(requestPath, '{"schema":"x","schema":"y"}');
    const unparseable = spawnSync("node", [SCRIPT, "--recover", requestPath], { cwd, encoding: "utf8" });
    assert.deepEqual(JSON.parse(unparseable.stdout), { ok: false, code: "request-unparseable" });
    assert.equal(unparseable.stderr, "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("request CLI keeps its identifier-invalid hint and never prints the recover hint", async () => {
  const { root, cwd, head } = fixture();
  try {
    const requestPath = path.join(root, "request.json");
    writeFileSync(requestPath, JSON.stringify(request(head)));
    const elsewhere = plainGitRepoOutsideWorktreeDir(root);
    const wrongCwd = spawnSync("node", [SCRIPT, "--request", requestPath], { cwd: elsewhere, encoding: "utf8" });
    assert.equal(wrongCwd.status, 1);
    assert.deepEqual(JSON.parse(wrongCwd.stdout), { ok: false, code: "identifier-invalid" });
    assert.equal(wrongCwd.stderr.startsWith(IDENTIFIER_HINT_HEAD), true, wrongCwd.stderr);
    assert.match(wrongCwd.stderr, /the process cwd must be the target `\.worktree\/<change_id>` checkout/);
    assert.equal(wrongCwd.stderr.includes(RECOVER_HINT_HEAD), false);

    const { issuerFailureHint } = await import("../issue-codex-reviewer-admission.mjs");
    assert.equal(issuerFailureHint(["--request", requestPath], { ok: false, code: "intent-tuple-mismatch" }), null);
    assert.equal(issuerFailureHint(["--recover", requestPath], { ok: false, code: "intent-tuple-mismatch" })?.startsWith(RECOVER_HINT_HEAD), true);
    assert.equal(issuerFailureHint(["--recover", requestPath], { ok: true, intent_id: "x" }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("intent temporal and host tuple boundaries fail closed", async (t) => {
  for (const [name, issueNow, admitNow, mutation, code] of [
    ["host tuple", new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:01.000Z"), { task_name: "wrong_task" }, "intent-tuple-mismatch"],
    ["expired", new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:10:00.000Z"), {}, "intent-expired"],
    ["future skew", new Date("2026-01-01T00:01:00.000Z"), new Date("2026-01-01T00:00:00.000Z"), {}, "intent-future-skew"],
  ]) {
    await t.test(name, () => {
      const { root, cwd, head } = fixture();
      try {
        assert.equal(issueCodexReviewerAdmission({ cwd, request: request(head), now: () => issueNow }).ok, true);
        const result = admitPreparedCodexReviewer({ cwd, toolInput: toolInput(mutation), now: () => admitNow });
        assert.equal(result.code, code);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
});

test("TTL over 600 is rejected before an intent is written", () => {
  const { root, cwd, head } = fixture();
  try {
    assert.deepEqual(issueCodexReviewerAdmission({ cwd, request: request(head, { ttl_seconds: 601 }) }), { ok: false, code: "intent-ttl-exceeded" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("admission rejects impossible UTC intent timestamps and oversized intent artifacts", async (t) => {
  await t.test("impossible UTC calendar date", () => {
    const { root, cwd, head } = fixture();
    try {
      const issued = issueCodexReviewerAdmission({ cwd, request: request(head), now: () => new Date("2026-03-03T00:00:00.000Z") });
      const intentPath = path.join(cwd, issued.path);
      const intent = JSON.parse(readFileSync(intentPath, "utf8"));
      intent.issued_at = "2026-02-31T00:00:00.000Z";
      intent.expires_at = "2026-03-03T00:05:00.000Z";
      writeFileSync(intentPath, `${JSON.stringify(intent, null, 2)}\n`);
      assert.deepEqual(
        admitPreparedCodexReviewer({ cwd, toolInput: toolInput(), now: () => new Date("2026-03-03T00:01:00.000Z") }),
        { ok: false, code: "timestamp-invalid" },
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  await t.test("oversized prepared intent", () => {
    const { root, cwd, head } = fixture();
    try {
      const issued = issueCodexReviewerAdmission({ cwd, request: request(head) });
      truncateSync(path.join(cwd, issued.path), 64 * 1024 + 1);
      assert.deepEqual(admitPreparedCodexReviewer({ cwd, toolInput: toolInput() }), { ok: false, code: "artifact-size-exceeded" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test("intent claim mkdir is durable before proof publication and proof failure remains consumed", () => {
  const { root, cwd, head } = fixture();
  try {
    assert.equal(issueCodexReviewerAdmission({ cwd, request: request(head) }).ok, true);
    const events = [];
    const first = admitPreparedCodexReviewer({
      cwd,
      toolInput: toolInput(),
      hooks: {
        fsyncDir: (dir) => events.push(`fsync:${path.basename(dir)}`),
        beforeOpen: () => { events.push("proof"); throw new Error("injected proof fault"); },
      },
    });
    assert.deepEqual(first, { ok: false, code: "intent-claim-write-failed" });
    assert.deepEqual(events, ["fsync:codex-reviewer-intents", "proof"]);
    assert.equal(admitPreparedCodexReviewer({ cwd, toolInput: toolInput() }).code, "intent-consumed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("normal receipt authority re-reads the intent, irreversible claim, and admission-time temporal binding", async (t) => {
  const cases = [
    ["missing intent", ({ intentPath }) => rmSync(intentPath, { force: true })],
    ["missing claim", ({ claimDir }) => rmSync(claimDir, { recursive: true, force: true })],
    ["malformed claim", ({ claimPath }) => writeFileSync(claimPath, "{bad\n")],
    ["mismatched claim", ({ claimPath }) => {
      const claim = JSON.parse(readFileSync(claimPath, "utf8"));
      claim.record_id = "33333333-3333-4333-8333-333333333333";
      writeFileSync(claimPath, `${JSON.stringify(claim, null, 2)}\n`);
    }],
    ["admitted after expiry", ({ intentPath, recordPath, claimPath }) => {
      const intent = JSON.parse(readFileSync(intentPath, "utf8"));
      intent.expires_at = "2026-01-01T00:00:30.000Z";
      const intentBytes = Buffer.from(`${JSON.stringify(intent, null, 2)}\n`);
      writeFileSync(intentPath, intentBytes);
      const digest = createHash("sha256").update(intentBytes).digest("hex");
      const record = JSON.parse(readFileSync(recordPath, "utf8"));
      record.intent_sha256 = digest;
      writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
      const claim = JSON.parse(readFileSync(claimPath, "utf8"));
      claim.intent_sha256 = digest;
      writeFileSync(claimPath, `${JSON.stringify(claim, null, 2)}\n`);
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const { root, cwd, head } = fixture();
      try {
        const issued = issueCodexReviewerAdmission({ cwd, request: request(head), now: () => new Date("2026-01-01T00:00:00.000Z") });
        const admitted = admitPreparedCodexReviewer({ cwd, toolInput: toolInput(), now: () => new Date("2026-01-01T00:01:00.000Z") });
        assert.equal(issued.ok, true);
        assert.equal(admitted.ok, true);
        const admissionRoot = path.join(cwd, "openspec", "changes", "review-fixture", "admission-records");
        const intentPath = path.join(admissionRoot, "codex-reviewer-intents", `${issued.intent_id}.json`);
        const claimDir = path.join(admissionRoot, "codex-reviewer-intents", `${issued.intent_id}.claim`);
        const carrier = { intentPath, claimDir, claimPath: path.join(claimDir, "consumed.json"), recordPath: path.join(admissionRoot, `${admitted.record_id}.json`) };
        assert.equal(verifyCodexReviewerAdmissionAuthority({ repoRoot: cwd, changeId: "review-fixture", recordId: admitted.record_id }).ok, true);
        mutate(carrier);
        assert.deepEqual(
          verifyCodexReviewerAdmissionAuthority({ repoRoot: cwd, changeId: "review-fixture", recordId: admitted.record_id }),
          { ok: false, code: "authority-binding-mismatch" },
        );
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
});

test("raw reviewer output capture rejects noncanonical bytes before immutable publication", () => {
  const { root, cwd } = fixture();
  try {
    const payloadPath = path.join(cwd, "tool-result.bin");
    const raw = Buffer.from([0x00, 0xff, 0x0a, 0x7b, 0x7d]);
    writeFileSync(payloadPath, raw);
    const input = { repoRoot: cwd, changeId: "review-fixture", roundNumber: 1, dispatchId: "a".repeat(64), payloadPath };
    const target = path.join(cwd, "notes", `review-review-fixture-raw-r1-${"a".repeat(64)}.bin`);
    assert.throws(() => captureReviewerOutput(input), /raw-payload-invalid/);
    assert.equal(existsSync(target), false);
    assert.throws(() => captureReviewerOutput(input), /raw-payload-invalid/, "zero-publication rejection leaves the same request retryable");
    assert.equal(existsSync(target), false);
    truncateSync(payloadPath, 4 * 1024 * 1024 + 1);
    assert.throws(
      () => captureReviewerOutput({ ...input, dispatchId: "b".repeat(64) }),
      /raw-payload-size-exceeded/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("raw capture CLI parses only exact camelCase bounded duplicate-free request JSON", () => {
  const { root, cwd } = fixture();
  try {
    const payloadPath = path.join(cwd, "cli-tool-result.bin");
    const requestPath = path.join(cwd, "capture-request.json");
    writeFileSync(payloadPath, "raw cli output\n");
    const valid = { repoRoot: cwd, changeId: "review-fixture", roundNumber: 1, dispatchId: "b".repeat(64), payloadPath };
    writeFileSync(requestPath, JSON.stringify(valid));
    const captured = spawnSync("node", [EVIDENCE_SCRIPT, "capture-reviewer-output", "--request", requestPath], { cwd, encoding: "utf8" });
    assert.equal(captured.status, 1, captured.stderr);
    assert.deepEqual(JSON.parse(captured.stdout), {
      code: "raw-payload-invalid",
      detail: "Validate the captured reviewer payload and its dispatch tuple.",
      ok: false,
    }, "valid request shape reaches payload validation");

    writeFileSync(requestPath, JSON.stringify({ repo_root: cwd, change_id: "review-fixture", round_number: 1, dispatch_id: "b".repeat(64), payload_path: payloadPath }));
    const wrongCase = spawnSync("node", [EVIDENCE_SCRIPT, "capture-reviewer-output", "--request", requestPath], { cwd, encoding: "utf8" });
    assert.equal(wrongCase.status, 1);
    assert.deepEqual(JSON.parse(wrongCase.stdout), {
      code: "request-shape-invalid",
      detail: "Check the request file's command-specific shape and required fields.",
      ok: false,
    });

    writeFileSync(requestPath, '{"repoRoot":"x","repoRoot":"y"}');
    const duplicate = spawnSync("node", [EVIDENCE_SCRIPT, "capture-reviewer-output", "--request", requestPath], { cwd, encoding: "utf8" });
    assert.equal(duplicate.status, 1);
    assert.deepEqual(JSON.parse(duplicate.stdout), {
      code: "request-unparseable",
      detail: "Check the request file's command-specific shape and required fields.",
      ok: false,
    });

    truncateSync(requestPath, 64 * 1024 + 1);
    const oversize = spawnSync("node", [EVIDENCE_SCRIPT, "capture-reviewer-output", "--request", requestPath], { cwd, encoding: "utf8" });
    assert.equal(oversize.status, 1);
    assert.deepEqual(JSON.parse(oversize.stdout), {
      code: "request-size-exceeded",
      detail: "Check the request file's command-specific shape and required fields.",
      ok: false,
    });

    const realRequest = path.join(cwd, "real-capture-request.json");
    const linkedRequest = path.join(cwd, "linked-capture-request.json");
    writeFileSync(realRequest, JSON.stringify({ ...valid, dispatchId: "c".repeat(64) }));
    symlinkSync(realRequest, linkedRequest);
    const linked = spawnSync("node", [EVIDENCE_SCRIPT, "capture-reviewer-output", "--request", linkedRequest], { cwd, encoding: "utf8" });
    assert.equal(linked.status, 1);
    assert.deepEqual(JSON.parse(linked.stdout), {
      code: "request-unparseable",
      detail: "Check the request file's command-specific shape and required fields.",
      ok: false,
    });

    for (const [mutation, code] of [
      [{ repoRoot: "" }, "request-shape-invalid"],
      [{ changeId: "../unsafe" }, "identifier-invalid"],
      [{ roundNumber: 0 }, "request-shape-invalid"],
      [{ dispatchId: "not-a-digest" }, "digest-invalid"],
      [{ payloadPath: "" }, "request-shape-invalid"],
    ]) {
      writeFileSync(requestPath, JSON.stringify({ ...valid, ...mutation }));
      const invalid = spawnSync("node", [EVIDENCE_SCRIPT, "capture-reviewer-output", "--request", requestPath], { cwd, encoding: "utf8" });
      assert.equal(invalid.status, 1);
      assert.deepEqual(JSON.parse(invalid.stdout), {
        code,
        detail: "Check the request file's command-specific shape and required fields.",
        ok: false,
      });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("post-hoc CLI parsers reject reordered, wrong-case, and wrong-type requests", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "post-hoc-cli-shape-"));
  const ref = { path: "artifact.json", digest_sha256: "a".repeat(64) };
  const cases = [
    ["prepare-post-hoc-attestation", {
      repoRoot: root, changeId: "review-fixture", attestationId: "11111111-1111-4111-8111-111111111111",
      reviewedHeadSha: SHA, baseSha: SHA, dispatchId: "b".repeat(64), responsibilityId: "primary-review",
      reviewMode: "full", roundNumber: 4, riskShapeDigestSha256: "c".repeat(64), rawPayloadRef: ref,
      verdict: "finished", findings: [], openFindingIds: [], preparerId: "tl-preparer",
      eligibleReason: "codex-named-dp-reviewer-opaque-message-message-only-parser-v1", preparedAt: "2026-09-09T08:00:00.000Z",
    }, "preparerId"],
    ["record-post-hoc-authorization", {
      repoRoot: root, changeId: "review-fixture", authorizationId: "22222222-2222-4222-8222-222222222222",
      preparedRef: ref, authorizedBy: "repo-owner", authorizationText: "bounded", authorizedAt: "2026-09-09T08:05:00.000Z",
    }, "authorizedBy"],
    ["seal-post-hoc-attestation", {
      repoRoot: root, changeId: "review-fixture", preparedRef: ref, authorizationRef: ref,
      witnessId: "tl-witness", witnessedAt: "2026-09-09T08:10:00.000Z",
    }, "witnessId"],
    ["verify-post-hoc-attestation", {
      repoRoot: root, changeId: "review-fixture", attestationId: "11111111-1111-4111-8111-111111111111",
    }, "attestationId"],
  ];
  try {
    for (const [command, requestValue, typedKey] of cases) {
      await t.test(command, () => {
        const entries = Object.entries(requestValue);
        const malformed = [
          Object.fromEntries([...entries.slice(1), entries[0]]),
          Object.fromEntries(entries.map(([key, value], index) => [index === 0 ? "repo_root" : key, value])),
          { ...requestValue, [typedKey]: 1 },
        ];
        for (const value of malformed) {
          const requestPath = path.join(root, `${command}-${malformed.indexOf(value)}.json`);
          writeFileSync(requestPath, JSON.stringify(value));
          const result = spawnSync("node", [EVIDENCE_SCRIPT, command, "--request", requestPath], { encoding: "utf8" });
          assert.equal(result.status, 1, result.stderr);
          assert.deepEqual(JSON.parse(result.stdout), {
            ok: false,
            code: "request-shape-invalid",
            detail: "Check the request file's command-specific shape and required fields.",
          });
        }
        for (const [mutation, code] of [[{ repoRoot: "" }, "request-shape-invalid"], [{ changeId: "../unsafe" }, "identifier-invalid"]]) {
          const requestPath = path.join(root, `${command}-${code}.json`);
          writeFileSync(requestPath, JSON.stringify({ ...requestValue, ...mutation }));
          const result = spawnSync("node", [EVIDENCE_SCRIPT, command, "--request", requestPath], { encoding: "utf8" });
          assert.equal(result.status, 1, result.stderr);
          assert.deepEqual(JSON.parse(result.stdout), {
            code,
            detail: "Check the request file's command-specific shape and required fields.",
            ok: false,
          });
        }
      });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D30 stable-error ownership manifest has exactly one owner per code and names D42 plus remediation additions", () => {
  const beforeD42 = `
request-size-exceeded,request-unparseable,request-shape-invalid,
identifier-invalid,sha-invalid,digest-invalid,timestamp-invalid,
artifact-size-exceeded,artifact-unparseable,artifact-noncanonical,
artifact-ref-digest-mismatch,artifact-read-failed,artifact-write-failed,
artifact-readback-mismatch,artifact-parent-invalid,archive-scan-failed,
archive-candidate-limit-exceeded,archive-candidate-invalid,
archive-entry-case-mismatch,proposal-scan-failed,
proposal-carrier-case-mismatch,proposal-carrier-invalid,
proposal-carrier-ambiguous,artifact-class-unknown,intent-scan-failed,
intent-candidate-limit-exceeded,intent-missing,intent-ambiguous,
intent-tuple-mismatch,intent-future-skew,intent-expired,
intent-ttl-exceeded,intent-consumed,intent-claim-write-failed,
admission-record-write-failed,admission-record-readback-mismatch,
admission-record-consumed,admission-claim-write-failed,
reviewer-agent-type-unsupported,raw-payload-read-failed,
raw-payload-size-exceeded,raw-payload-collision,
raw-payload-digest-mismatch,open-finding-ids-noncanonical,
verdict-open-set-digest-mismatch,post-hoc-eligible-tuple-mismatch,
reviewed-head-after-cutoff,eligible-reason-invalid,authorization-stale,
authorization-binding-mismatch,authorization-consumed,
authorization-claim-write-failed,cooperative-identity-not-distinct,
attestation-binding-mismatch,attestation-consumed,
attestation-claim-write-failed,receipt-authority-missing,
receipt-authority-mixed,receipt-identity-authority-mismatch,
receipt-output-evidence-mismatch,receipt-payload-digest-mismatch,
receipt-ref-digest-mismatch,receipt-size-exceeded,receipt-unparseable,
receipt-noncanonical,receipt-path-schema-mismatch,receipt-path-collision,
receipt-publish-failed,receipt-readback-mismatch,receipt-authority-changed,
receipt-scan-failed,receipt-candidate-limit-exceeded,receipt-ambiguous,
legacy-receipt-seal-forbidden,legacy-receipt-not-independent,
unexpected-io-fault
  `.replace(/\s/gu, "").split(",");
  const remediationAdditions = [
    "receipt-not-committed",
    "reviewer-change-worktree-required",
    "raw-payload-invalid",
    "raw-payload-root-unavailable",
    "raw-payload-publication-denied",
    "raw-payload-publication-failed",
    "raw-payload-publication-partial",
    "raw-payload-publication-indeterminate",
    "raw-payload-existing-unsafe",
    "ordinary-review-not-independent",
  ];
  const current = [...beforeD42, ...remediationAdditions];
  const brdOwned = /^(?:archive-|proposal-|artifact-class-unknown)/u;
  const hookOwned = /^(?:reviewer-agent-type-unsupported)$/u;
  const evidenceOwned = /^(?:raw-payload-|open-finding-|verdict-open-set-|post-hoc-|reviewed-head-|eligible-reason-|authorization-|cooperative-|attestation-|receipt-|legacy-receipt-|ordinary-review-)/u;
  const ownerFor = (code) => brdOwned.test(code)
    ? "pre-pr-archive-gate-pre-review.test.mjs"
    : hookOwned.test(code)
      ? "hook-pre-tool-gate-spawn-context.test.mjs"
      : evidenceOwned.test(code)
        ? "review-remediation-evidence.test.mjs"
        : "codex-reviewer-admission.test.mjs";
  const manifest = current.map((code) => ({ code, owner: ownerFor(code) }));
  const D30_CODE_OWNERS = `
request-size-exceeded request-unparseable request-shape-invalid identifier-invalid sha-invalid digest-invalid timestamp-invalid
raw-payload-read-failed raw-payload-size-exceeded raw-payload-collision raw-payload-digest-mismatch raw-payload-invalid raw-payload-root-unavailable raw-payload-publication-denied raw-payload-publication-failed raw-payload-publication-partial raw-payload-publication-indeterminate raw-payload-existing-unsafe open-finding-ids-noncanonical verdict-open-set-digest-mismatch cooperative-identity-not-distinct ordinary-review-not-independent predecessor-finding-omitted
post-hoc-eligible-tuple-mismatch reviewed-head-after-cutoff eligible-reason-invalid authorization-stale authorization-binding-mismatch authorization-consumed authorization-claim-write-failed attestation-binding-mismatch attestation-consumed attestation-claim-write-failed post-hoc-evidence-invalid
receipt-output-evidence-mismatch receipt-payload-digest-mismatch receipt-ref-digest-mismatch receipt-size-exceeded receipt-unparseable receipt-noncanonical receipt-path-schema-mismatch receipt-path-collision receipt-publish-failed receipt-readback-mismatch receipt-scan-failed receipt-candidate-limit-exceeded receipt-ambiguous receipt-not-committed legacy-receipt-seal-forbidden legacy-receipt-not-independent receipt-authority-missing receipt-authority-mixed receipt-identity-authority-mismatch receipt-authority-changed admission-record-consumed admission-claim-write-failed intent-scan-failed intent-candidate-limit-exceeded binding-root-mismatch change-worktree-required change-worktree-ambiguous git-head-unavailable receipt-path-change-mismatch receipt-evidence-invalid receipt-authority-invalid
artifact-size-exceeded artifact-unparseable artifact-noncanonical artifact-ref-digest-mismatch artifact-read-failed artifact-write-failed artifact-readback-mismatch artifact-parent-invalid archive-scan-failed archive-candidate-limit-exceeded archive-candidate-invalid archive-entry-case-mismatch proposal-scan-failed proposal-carrier-case-mismatch proposal-carrier-invalid proposal-carrier-ambiguous artifact-class-unknown evidence-artifact-invalid unexpected-io-fault
`.trim().split(/\s+/u).map((code) => ({ code, owner: "review-remediation-evidence.test.mjs" }));
  assert.equal(beforeD42.length, 76, "reviewed pre-D42 closed set cardinality");
  assert.equal(new Set(beforeD42).size, beforeD42.length, "pre-D42 codes are unique");
  assert.deepEqual(
    current.filter((code) => !beforeD42.includes(code)),
    remediationAdditions,
  );
  assert.equal(new Set(manifest.map(({ code }) => code)).size, current.length, "each stable code has exactly one manifest row");
  for (const { code, owner } of manifest) {
    assert.match(code, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, code);
    assert.equal(existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), owner)), true, `${code}: owner exists`);
  }
  assert.equal(new Set(D30_CODE_OWNERS.map(({ code }) => code)).size, D30_CODE_OWNERS.length,
    "D30 owner manifest has one literal owner row per code");
  assert.deepEqual([...D30_CODES].sort(), D30_CODE_OWNERS.map(({ code }) => code).sort(),
    "runtime D30 catalog equals the complete reviewed owner manifest");
  assert.equal(typeof D30_CODES.add, "undefined", "the exported code catalog exposes no Set mutation methods");
  assert.equal(typeof D30_CODES.delete, "undefined", "the exported code catalog cannot delete codes");
  assert.equal(D30_CODES.has("unexpected-io-fault"), true, "the read-only view still supports membership checks");
  for (const { owner } of D30_CODE_OWNERS) {
    assert.equal(existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), owner)), true, `${owner}: D30 code owner exists`);
  }
});

// strengthen-review-receipt-carry-forward-compaction (design D6, D8 item 9): the explicit
// code `predecessor-finding-omitted` must be present exactly once in the runtime catalog, in
// the CLI code-to-detail map (group reviewer-payload-check) and in the owner manifest above.
// Scenario: Omitted carry-forward finding returns its explicit code with fixed payload detail
test("Omitted carry-forward finding returns its explicit code with fixed payload detail: the CLI detail map, the runtime catalog and the CLI self-check agree on predecessor-finding-omitted", () => {
  const code = "predecessor-finding-omitted";
  const source = readFileSync(EVIDENCE_SCRIPT, "utf8");
  // The pattern is assembled from strings: a regex literal holding backticks defeats the
  // comment-span scanner that shard discovery runs over this file.
  const tick = "\u0060";
  const assignPattern = new RegExp('assignCodes\\("([^"]+)", ' + tick + "([^" + tick + "]+)" + tick + "\\);", "gu");
  const mapped = [...source.matchAll(assignPattern)]
    .flatMap(([, detailKey, codes]) => codes.trim().split(/\s+/u).map((entry) => [entry, detailKey]));
  assert.deepEqual(
    mapped.filter(([entry]) => entry === code),
    [[code, "reviewer-payload-check"]],
    "the CLI detail map holds the code exactly once, under the reviewer-payload-check fixed detail",
  );
  assert.deepEqual(
    mapped.map(([entry]) => entry).sort(),
    [...D30_CODES].sort(),
    "the CLI detail map and the runtime D30 catalog hold the same codes",
  );
  const help = spawnSync(process.execPath, [EVIDENCE_SCRIPT, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, `the CLI self-check must accept the catalog: ${help.stderr}`);
  assert.match(help.stdout, new RegExp(code, "u"), "help names the code");
});

// fix-codex-reviewer-intent-candidate-cap T2 (prove-it): budgets, diagnostics and
// the local fast path contract for prepared Codex reviewer intents. The tests
// below build their own throwaway main + linked-worktree repositories so they
// never disturb the shared fixture used above.

test("Local Fast Path Prepared Intent Uniqueness: issuer run from the main checkout keeps stdout and exit code and adds one process-cwd stderr hint", () => {
  const fixture = sharedRealWorktreeFixture;
  const requestRoot = mkdtempSync(path.join(os.tmpdir(), "codex-reviewer-issuer-hint-"));
  try {
    const requestPath = path.join(requestRoot, "request.json");
    writeFileSync(requestPath, JSON.stringify(request(fixture.head)));
    const issued = spawnSync(process.execPath, [SCRIPT, "--request", requestPath], {
      cwd: fixture.mainRoot,
      encoding: "utf8",
    });
    assert.equal(issued.stdout, '{"ok":false,"code":"identifier-invalid"}\n', "stdout JSON stays byte-for-byte unchanged");
    assert.equal(issued.status, 1, "exit code stays 1");
    assert.match(issued.stderr, /process cwd/u, "stderr names the process-cwd requirement");
    assert.equal(issued.stderr.trim().split(/\r?\n/u).length, 1, "the hint is a single stderr line");
    assert.match(issued.stderr, /change_id/u, "the hint names the request.change_id requirement");
  } finally {
    rmSync(requestRoot, { recursive: true, force: true });
  }
});

const CAP_TARGET = "cap-target";
const CAP_SIBLING = "cap-sibling";
const CAP_IDS = [CAP_TARGET, CAP_SIBLING];
// Literal budgets on purpose: the tests pin the numbers themselves, not whatever a constant currently holds.
const WORKTREE_LIST_MAX = 128;
const INTENT_ENTRY_MAX = 8192;

// A throwaway main checkout with two linked change worktrees. Everything lives under one temp root so a test that
// (on an unfixed base) publishes authority still leaves nothing behind after cleanup().
function capFixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "codex-reviewer-cap-")));
  const mainRoot = path.join(root, "main");
  for (const id of CAP_IDS) {
    mkdirSync(path.join(mainRoot, "openspec", "changes", id), { recursive: true });
    writeFileSync(path.join(mainRoot, "openspec", "changes", id, "tasks.md"), `# ${id}\n`);
  }
  gitFixture(mainRoot, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(mainRoot, ".gitignore"), ".worktree/\n");
  writeFileSync(path.join(mainRoot, "seed"), "seed\n");
  gitFixture(mainRoot, ["add", "."]);
  gitFixture(mainRoot, ["commit", "-qm", "seed"]);
  const roots = {};
  for (const id of CAP_IDS) {
    const linked = path.join(mainRoot, ".worktree", id);
    mkdirSync(path.dirname(linked), { recursive: true });
    gitFixture(mainRoot, ["worktree", "add", "-q", "-b", `${id}-linked`, linked, "HEAD"]);
    roots[id] = realpathSync(linked);
  }
  return {
    root,
    mainRoot,
    roots,
    head: gitFixture(mainRoot, ["rev-parse", "HEAD"]),
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

function capAdmissionDir(fixture, id) {
  return path.join(fixture.roots[id], "openspec", "changes", id, "admission-records");
}

function capIntentDir(fixture, id) {
  return path.join(capAdmissionDir(fixture, id), "codex-reviewer-intents");
}

function issueCapIntent(fixture, id, overrides = {}, issueOptions = {}) {
  const issued = issueCodexReviewerAdmission({
    cwd: fixture.roots[id],
    request: request(fixture.head, { change_id: id, ...overrides }),
    ...issueOptions,
  });
  assert.equal(issued.ok, true, issued.code);
  return issued;
}

// One real issued intent plus byte-identical clones that differ only in intent_id (and the file name that must equal it).
function seedCapIntentSet(fixture, id, { count, claimed = false, expired = false }) {
  const issued = issueCapIntent(
    fixture,
    id,
    expired ? { ttl_seconds: 60 } : {},
    expired ? { now: () => new Date("2026-01-01T00:00:00.000Z") } : {},
  );
  const dir = capIntentDir(fixture, id);
  const template = readFileSync(path.join(dir, `${issued.intent_id}.json`), "utf8");
  if (claimed) mkdirSync(path.join(dir, `${issued.intent_id}.claim`));
  for (let i = 1; i < count; i += 1) {
    const intentId = randomUUID();
    writeFileSync(path.join(dir, `${intentId}.json`), template.replaceAll(issued.intent_id, intentId));
    if (claimed) mkdirSync(path.join(dir, `${intentId}.claim`));
  }
  return issued;
}

function writeCapFiller(dir, count) {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i += 1) writeFileSync(path.join(dir, `filler-${String(i).padStart(5, "0")}.txt`), "");
}

function dropCapFiller(dir) {
  rmSync(path.join(dir, "filler-00000.txt"), { force: true });
}

function clearCapIntentDirs(fixture) {
  for (const id of CAP_IDS) {
    const dir = capIntentDir(fixture, id);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

// Every record, ready marker and claim directory the two worktrees hold; a refusal must leave this unchanged (+0).
function capAuthoritySnapshot(fixture) {
  const snapshot = [];
  for (const id of CAP_IDS) {
    const admissionDir = capAdmissionDir(fixture, id);
    if (!existsSync(admissionDir)) continue;
    for (const entry of readdirSync(admissionDir)) {
      if (entry !== "codex-reviewer-intents") snapshot.push(`${id}/${entry}`);
    }
    const intentDir = capIntentDir(fixture, id);
    if (!existsSync(intentDir)) continue;
    for (const entry of readdirSync(intentDir)) {
      if (entry.endsWith(".claim")) snapshot.push(`${id}/intents/${entry}`);
    }
  }
  return snapshot.sort();
}

function capClaimCount(fixture, id) {
  const dir = capIntentDir(fixture, id);
  return existsSync(dir) ? readdirSync(dir).filter((entry) => entry.endsWith(".claim")).length : 0;
}

// Test-process wrapper around child_process.spawnSync("git", ...): logs every git call and, when asked, pads the
// `git worktree list --porcelain -z` output with duplicate main-checkout entries (a path without a `.worktree/`
// segment, so it stays a member of the list but never a candidate) or fails selected calls. No production seam,
// no environment variable; forwards everything else to the real git and is always restored.
function installGitShim({ padListTo, padPath, failWhen } = {}) {
  const original = childProcess.spawnSync;
  const calls = [];
  childProcess.spawnSync = function shimmedSpawnSync(file, args, options) {
    if (file !== "git" || !Array.isArray(args)) return original.apply(this, arguments);
    const cwd = String(options?.cwd ?? "");
    calls.push({ cwd, args: [...args] });
    if (failWhen?.(cwd, args)) {
      return { status: 1, signal: null, stdout: "", stderr: "", output: [null, "", ""], pid: 0, error: undefined };
    }
    const result = original.apply(this, arguments);
    if (padListTo !== undefined && args[0] === "worktree" && args[1] === "list" && result.status === 0) {
      const raw = String(result.stdout);
      const have = (raw.match(/\0\0/gu) ?? []).length;
      const padding = `worktree ${padPath}\0HEAD ${"a".repeat(40)}\0\0`.repeat(Math.max(0, padListTo - have));
      return { ...result, stdout: raw + padding };
    }
    return result;
  };
  syncBuiltinESMExports();
  return {
    calls,
    listCalls: () => calls.filter((call) => call.args[0] === "worktree" && call.args[1] === "list").length,
    restore() {
      childProcess.spawnSync = original;
      syncBuiltinESMExports();
    },
  };
}

// Compact verdict for assertions: a refusal that wrongly succeeds on an unfixed base must not dump the whole record.
function outcome(result) {
  return result.ok ? { ok: true } : { ok: false, code: result.code };
}

function admitFrom(cwd, hooks) {
  return admitPreparedCodexReviewer({ cwd, toolInput: toolInput(), ...(hooks ? { hooks } : {}) });
}

test("Common-Dir Exact-One Prepared Intent Discovery: the main checkout admits the one live target intent beside 65 claimed and 65 expired sibling intents", () => {
  const fixture = capFixture();
  try {
    seedCapIntentSet(fixture, CAP_SIBLING, { count: 65, claimed: true });
    seedCapIntentSet(fixture, CAP_SIBLING, { count: 65, expired: true });
    const live = issueCapIntent(fixture, CAP_TARGET);
    assert.equal(capClaimCount(fixture, CAP_SIBLING), 65, "fixture: 65 sibling intents are already claimed");
    const admitted = admitFrom(fixture.mainRoot);
    assert.equal(admitted.ok, true, `expected the live target intent to admit, got ${admitted.code}`);
    assert.equal(existsSync(path.join(capAdmissionDir(fixture, CAP_TARGET), `${admitted.record_id}.json`)), true, "the record is published in the target worktree");
    assert.equal(existsSync(path.join(capIntentDir(fixture, CAP_TARGET), `${live.intent_id}.claim`)), true, "the target intent is the one that was claimed");
    assert.equal(capClaimCount(fixture, CAP_SIBLING), 65, "no sibling intent was claimed or consumed");
  } finally {
    fixture.cleanup();
  }
});

test("Common-Dir Exact-One Prepared Intent Discovery: the worktree budget admits 128 listed entries and fails closed on 129 before any candidate is projected or listed", () => {
  const fixture = capFixture();
  try {
    issueCapIntent(fixture, CAP_TARGET);
    const before = capAuthoritySnapshot(fixture);

    const listed = [];
    const over = installGitShim({ padListTo: WORKTREE_LIST_MAX + 1, padPath: fixture.mainRoot });
    let overResult;
    try {
      overResult = admitFrom(fixture.mainRoot, {
        readdirIntentDir(dir) {
          listed.push(dir);
          return readdirSync(dir, { withFileTypes: true });
        },
      });
    } finally {
      over.restore();
    }
    assert.equal(over.listCalls(), 1, "the 129-entry list really came from git worktree list");
    assert.deepEqual(outcome(overResult), { ok: false, code: "intent-candidate-limit-exceeded" });
    assert.deepEqual(capAuthoritySnapshot(fixture), before, "zero new claim and zero new record");
    assert.deepEqual(listed, [], "no intent directory was listed once the worktree budget failed");
    const projected = over.calls.filter((call) => CAP_IDS.some((id) => call.cwd === fixture.roots[id]));
    assert.deepEqual(projected, [], "no candidate worktree was projected (no git call ran inside a linked worktree)");

    const exact = installGitShim({ padListTo: WORKTREE_LIST_MAX, padPath: fixture.mainRoot });
    let exactResult;
    try {
      exactResult = admitFrom(fixture.mainRoot);
    } finally {
      exact.restore();
    }
    assert.equal(exact.listCalls(), 1);
    assert.equal(exactResult.ok, true, `128 entries (main included) must still proceed, got ${exactResult.code}`);
  } finally {
    fixture.cleanup();
  }
});

test("Common-Dir Exact-One Prepared Intent Discovery: the generic exact-one change-worktree binding shares the same 128-entry worktree budget", () => {
  const fixture = capFixture();
  try {
    const exact = installGitShim({ padListTo: WORKTREE_LIST_MAX, padPath: fixture.mainRoot });
    let atLimit;
    try {
      atLimit = resolveExactOneChangeWorktreeBinding({ cwd: fixture.mainRoot, changeId: CAP_TARGET });
    } finally {
      exact.restore();
    }
    assert.equal(exact.listCalls(), 1);
    assert.equal(atLimit.ok, true, `128 entries must resolve the binding, got ${atLimit.code}`);
    assert.equal(atLimit.repoRoot, fixture.roots[CAP_TARGET]);

    const over = installGitShim({ padListTo: WORKTREE_LIST_MAX + 1, padPath: fixture.mainRoot });
    let overLimit;
    try {
      overLimit = resolveExactOneChangeWorktreeBinding({ cwd: fixture.mainRoot, changeId: CAP_TARGET });
    } finally {
      over.restore();
    }
    assert.equal(over.listCalls(), 1);
    assert.deepEqual(outcome(overLimit), { ok: false, code: "intent-candidate-limit-exceeded" });
  } finally {
    fixture.cleanup();
  }
});

test("Common-Dir Exact-One Prepared Intent Discovery: the entry budget sums every intent-directory entry across directories, admits 8192 and refuses 8193", () => {
  const fixture = capFixture();
  try {
    issueCapIntent(fixture, CAP_TARGET);
    // 1 live .json + 4000 filler in the target directory, 4192 filler in the sibling directory: 8193 entries in total.
    writeCapFiller(capIntentDir(fixture, CAP_TARGET), 4000);
    writeCapFiller(capIntentDir(fixture, CAP_SIBLING), INTENT_ENTRY_MAX - 4000);
    const before = capAuthoritySnapshot(fixture);
    const refused = admitFrom(fixture.mainRoot);
    assert.deepEqual(outcome(refused), { ok: false, code: "intent-entry-budget-exhausted" }, "8193 entries (any kind of entry counts) must fail closed");
    assert.deepEqual(capAuthoritySnapshot(fixture), before, "zero new claim and zero new record");

    dropCapFiller(capIntentDir(fixture, CAP_SIBLING));
    const admitted = admitFrom(fixture.mainRoot);
    assert.equal(admitted.ok, true, `8192 entries must still proceed, got ${admitted.code}`);
  } finally {
    fixture.cleanup();
  }
});

test("Common-Dir Exact-One Prepared Intent Discovery: a claimed intent counts as two entries toward the budget", () => {
  const fixture = capFixture();
  try {
    const claimed = issueCapIntent(fixture, CAP_TARGET);
    mkdirSync(path.join(capIntentDir(fixture, CAP_TARGET), `${claimed.intent_id}.claim`));
    issueCapIntent(fixture, CAP_TARGET);
    const dir = capIntentDir(fixture, CAP_TARGET);
    // claimed .json + .claim/ + live .json = 3 entries; 8190 filler makes 8193 (it would be 8192 if the claimed intent counted once).
    writeCapFiller(dir, INTENT_ENTRY_MAX - 2);
    const before = capAuthoritySnapshot(fixture);
    const refused = admitFrom(fixture.mainRoot);
    assert.deepEqual(outcome(refused), { ok: false, code: "intent-entry-budget-exhausted" });
    assert.deepEqual(capAuthoritySnapshot(fixture), before, "zero new claim and zero new record");

    dropCapFiller(dir);
    const admitted = admitFrom(fixture.mainRoot);
    assert.equal(admitted.ok, true, `exactly 8192 entries must still proceed, got ${admitted.code}`);
  } finally {
    fixture.cleanup();
  }
});

test("Common-Dir Exact-One Prepared Intent Discovery: the entry budget is judged over every listing before the first candidate is projected", () => {
  const fixture = capFixture();
  try {
    // The entry budget (summed over both directories) is judged before the first candidate is projected.
    issueCapIntent(fixture, CAP_TARGET);
    writeCapFiller(capIntentDir(fixture, CAP_TARGET), 4200);
    writeCapFiller(capIntentDir(fixture, CAP_SIBLING), 4200);
    const shim = installGitShim({
      failWhen: (cwd, args) => cwd === fixture.roots[CAP_TARGET] && args[0] === "rev-parse" && args[1] === "--show-toplevel",
    });
    let budgetFirst;
    try {
      budgetFirst = admitFrom(fixture.mainRoot);
    } finally {
      shim.restore();
    }
    assert.deepEqual(outcome(budgetFirst), { ok: false, code: "intent-entry-budget-exhausted" },
      "a candidate whose projection would fail (intent-scan-failed) must not pre-empt the budget verdict");
    assert.equal(
      shim.calls.some((call) => call.cwd === fixture.roots[CAP_TARGET] && call.args[1] === "--show-toplevel"),
      false,
      "no candidate was projected before the listing stage finished",
    );
  } finally {
    fixture.cleanup();
  }
});

// Stage two of discovery projects only candidates that have an intent directory. These two tests pin both directions of that
// rule inside the entry budget: a projection failure on a candidate that has an intent directory still fails closed, and a
// candidate with no intent directory is never projected, so it cannot hold a live intent and cannot veto an admission.
test("Common-Dir Exact-One Prepared Intent Discovery: a sibling that has an intent directory but cannot be projected fails closed and consumes nothing", () => {
  const fixture = capFixture();
  try {
    const live = issueCapIntent(fixture, CAP_TARGET);
    mkdirSync(capIntentDir(fixture, CAP_SIBLING), { recursive: true });
    const before = capAuthoritySnapshot(fixture);
    const shim = installGitShim({
      failWhen: (cwd, args) => cwd === fixture.roots[CAP_SIBLING] && args[0] === "rev-parse" && args[1] === "--show-toplevel",
    });
    let refused;
    try {
      refused = admitFrom(fixture.mainRoot);
    } finally {
      shim.restore();
    }
    assert.deepEqual(outcome(refused), { ok: false, code: "intent-scan-failed" },
      "one unprojectable candidate with an intent directory must fail the whole discovery, not be skipped");
    assert.deepEqual(capAuthoritySnapshot(fixture), before, "zero new claim and zero new record");
    assert.equal(existsSync(path.join(capIntentDir(fixture, CAP_TARGET), `${live.intent_id}.claim`)), false,
      "the target's live intent was not consumed by a refused discovery");
  } finally {
    fixture.cleanup();
  }
});

test("Common-Dir Exact-One Prepared Intent Discovery: a sibling with no intent directory is never projected and cannot block the target's live intent", () => {
  const fixture = capFixture();
  try {
    const live = issueCapIntent(fixture, CAP_TARGET);
    assert.equal(existsSync(capIntentDir(fixture, CAP_SIBLING)), false, "fixture: the sibling has no intent directory");
    const shim = installGitShim({
      failWhen: (cwd, args) => cwd === fixture.roots[CAP_SIBLING] && args[0] === "rev-parse" && args[1] === "--show-toplevel",
    });
    let admitted;
    try {
      admitted = admitFrom(fixture.mainRoot);
    } finally {
      shim.restore();
    }
    assert.equal(admitted.ok, true, `a sibling that holds no intent must not veto the target, got ${admitted.code}`);
    assert.equal(existsSync(path.join(capIntentDir(fixture, CAP_TARGET), `${live.intent_id}.claim`)), true, "the target intent was claimed");
    const projected = (id) => shim.calls.some((call) => call.cwd === fixture.roots[id] && call.args[0] === "rev-parse" && call.args[1] === "--show-toplevel");
    assert.equal(projected(CAP_TARGET), true, "control: the candidate that has an intent directory was projected (the shim sees this cwd form)");
    assert.equal(projected(CAP_SIBLING), false, "the candidate without an intent directory was never projected");
  } finally {
    fixture.cleanup();
  }
});

test("Common-Dir Exact-One Prepared Intent Discovery: a readdir fault in any directory is reported before a per-file failure in another, whichever worktree git lists first", () => {
  const fixture = capFixture();
  try {
    for (const [badFileIn, readdirFaultIn] of [[CAP_TARGET, CAP_SIBLING], [CAP_SIBLING, CAP_TARGET]]) {
      mkdirSync(capIntentDir(fixture, badFileIn), { recursive: true });
      mkdirSync(capIntentDir(fixture, readdirFaultIn), { recursive: true });
      writeFileSync(path.join(capIntentDir(fixture, badFileIn), "not-a-uuid.json"), "{}\n");
      const result = admitFrom(fixture.mainRoot, {
        readdirIntentDir(dir) {
          if (dir === capIntentDir(fixture, readdirFaultIn)) throw Object.assign(new Error("EIO"), { code: "EIO" });
          return readdirSync(dir, { withFileTypes: true });
        },
      });
      assert.deepEqual(outcome(result), { ok: false, code: "intent-scan-failed" },
        `bad file in ${badFileIn}, readdir fault in ${readdirFaultIn}: the listing error wins`);
      rmSync(path.join(capIntentDir(fixture, badFileIn), "not-a-uuid.json"), { force: true });
    }
  } finally {
    fixture.cleanup();
  }
});

test("Common-Dir Exact-One Prepared Intent Discovery: the local fast-path directory fails closed over the entry budget instead of falling back to global discovery", () => {
  const fixture = capFixture();
  try {
    issueCapIntent(fixture, CAP_SIBLING);
    writeCapFiller(capIntentDir(fixture, CAP_TARGET), INTENT_ENTRY_MAX + 1);
    const before = capAuthoritySnapshot(fixture);
    const result = admitFrom(fixture.roots[CAP_TARGET]);
    assert.deepEqual(outcome(result), { ok: false, code: "intent-entry-budget-exhausted" },
      "the sibling's live intent must not be reachable through a fall-back");
    assert.deepEqual(capAuthoritySnapshot(fixture), before, "zero new claim and zero new record");
  } finally {
    fixture.cleanup();
  }
});

test("Common-Dir Exact-One Prepared Intent Discovery: corrupt claimed entries stay intent-unreadable, a matching claimed intent stays intent-consumed, two live intents stay intent-ambiguous (characterization)", () => {
  const fixture = capFixture();
  try {
    const dir = capIntentDir(fixture, CAP_TARGET);

    // the claim marker of an intent is not a directory
    const brokenMarker = issueCapIntent(fixture, CAP_TARGET);
    writeFileSync(path.join(dir, `${brokenMarker.intent_id}.claim`), "not a claim directory\n");
    assert.deepEqual(outcome(admitFrom(fixture.mainRoot)), { ok: false, code: "intent-unreadable" });
    clearCapIntentDirs(fixture);

    // a claimed intent whose entry is not a regular file
    mkdirSync(dir, { recursive: true });
    const notAFile = randomUUID();
    mkdirSync(path.join(dir, `${notAFile}.json`));
    mkdirSync(path.join(dir, `${notAFile}.claim`));
    assert.deepEqual(outcome(admitFrom(fixture.mainRoot)), { ok: false, code: "intent-unreadable" });
    clearCapIntentDirs(fixture);

    // a claimed intent that matches the request and has no live sibling
    const consumed = issueCapIntent(fixture, CAP_TARGET);
    mkdirSync(path.join(dir, `${consumed.intent_id}.claim`));
    assert.deepEqual(outcome(admitFrom(fixture.mainRoot)), { ok: false, code: "intent-consumed" });
    clearCapIntentDirs(fixture);

    // two live matching intents
    issueCapIntent(fixture, CAP_TARGET);
    issueCapIntent(fixture, CAP_TARGET);
    const before = capAuthoritySnapshot(fixture);
    assert.deepEqual(outcome(admitFrom(fixture.mainRoot)), { ok: false, code: "intent-ambiguous" });
    assert.deepEqual(capAuthoritySnapshot(fixture), before);
  } finally {
    fixture.cleanup();
  }
});

test("Local Fast Path Prepared Intent Uniqueness: one local live intent admits without consuming a live sibling intent (characterization)", () => {
  const fixture = capFixture();
  try {
    issueCapIntent(fixture, CAP_TARGET);
    const sibling = issueCapIntent(fixture, CAP_SIBLING);
    const admitted = admitFrom(fixture.roots[CAP_TARGET]);
    assert.equal(admitted.ok, true, admitted.code);
    assert.equal(existsSync(path.join(capAdmissionDir(fixture, CAP_TARGET), `${admitted.record_id}.json`)), true, "the local intent admitted");
    assert.equal(existsSync(path.join(capIntentDir(fixture, CAP_SIBLING), `${sibling.intent_id}.claim`)), false, "the sibling intent was not claimed");
    assert.equal(existsSync(path.join(capIntentDir(fixture, CAP_SIBLING), `${sibling.intent_id}.json`)), true, "the sibling intent file is untouched");
    assert.equal(capClaimCount(fixture, CAP_SIBLING), 0);
  } finally {
    fixture.cleanup();
  }
});

test("Local Fast Path Prepared Intent Uniqueness: zero local live intents fall back to global discovery (characterization)", () => {
  const fixture = capFixture();
  try {
    const local = issueCapIntent(fixture, CAP_TARGET);
    mkdirSync(path.join(capIntentDir(fixture, CAP_TARGET), `${local.intent_id}.claim`));
    const sibling = issueCapIntent(fixture, CAP_SIBLING);
    const admitted = admitFrom(fixture.roots[CAP_TARGET]);
    assert.equal(admitted.ok, true, admitted.code);
    assert.equal(existsSync(path.join(capAdmissionDir(fixture, CAP_SIBLING), `${admitted.record_id}.json`)), true, "the record is published against the sibling worktree");
    assert.equal(existsSync(path.join(capIntentDir(fixture, CAP_SIBLING), `${sibling.intent_id}.claim`)), true, "the sibling intent was the one claimed");
  } finally {
    fixture.cleanup();
  }
});

test("Local Fast Path Prepared Intent Uniqueness: two local live intents fail closed with intent-ambiguous without falling back (characterization)", () => {
  const fixture = capFixture();
  try {
    issueCapIntent(fixture, CAP_TARGET);
    issueCapIntent(fixture, CAP_TARGET);
    issueCapIntent(fixture, CAP_SIBLING);
    const before = capAuthoritySnapshot(fixture);
    assert.deepEqual(outcome(admitFrom(fixture.roots[CAP_TARGET])), { ok: false, code: "intent-ambiguous" });
    assert.deepEqual(capAuthoritySnapshot(fixture), before, "the sibling's live intent stays unconsumed");
  } finally {
    fixture.cleanup();
  }
});
