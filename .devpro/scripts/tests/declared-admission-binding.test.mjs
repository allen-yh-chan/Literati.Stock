/**
 * Prove-it / regression matrix for strengthen-admission-binding-portability
 * T1–T4 (design D1／D2／D3／D5／D6): the declared binding resolver.
 *
 * Written before the implementation (T3／T4) so every case starts RED. The
 * matrix covers: A2／A1／A3 read order and only-read-source consistency,
 * main-rooted declared minting into the exact-one binding worktree, the
 * fail-closed code-per-cause negatives (0／≥2／scan fault／prunable exclusion／
 * detached／protected／cross-repo／A3 multi-id), the role classification for an
 * unresolved binding, and the operator-visible-but-never-persisted binding
 * root. Test titles use the delta scenario titles verbatim where this package
 * owns their assertion coverage.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  ADMISSION_FIELD_VALUE_MAX,
  ADMISSION_REVIEW_ROLES,
  ADMISSION_ROLES,
  classifyAdmissionRoleClass,
  formatAdmissionFieldProblems,
  parseAdmissionFields,
  resolveAdmissionBinding,
  resolveDeclaredChangeLookupKey,
  unsafeAdmissionField,
  writeAdmissionRecord,
} from "../hooks/lib/admission-record.mjs";
import { evaluateAgentDispatch, SPAWN_CONTEXT_PASS_THROUGH } from "../hooks/lib/spawn-context-admission.mjs";

const CHANGE = "strengthen-admission-binding-portability";
const CHANGE_A1 = "cursor-degraded-sibling-change";
const CHANGE_A3 = "scope-declared-change";
const CHANGE_TWIN = "ambiguous-twin-change";
const CHANGE_DETACHED = "detached-candidate-change";
const CHANGE_PROTECTED = "protected-candidate-change";
const CHANGE_ADVISORY_BRANCH = "advisory-branch-change";
const CHANGE_PRUNED = "pruned-candidate-change";
const CHANGE_CHORELESS = "declared-choreless-change";
const CHANGE_INVALID_DIR = "invalid-change-dir-change";
const PARENT_RECORD_ID = "586d4b24-0000-4000-8000-000000000000";

let shared;

function git(cwd, args) {
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

function addLinkedWorktree(rootDir, mainRoot, id, {
  branch = `chore/${id}`,
  detach = false,
  changeDir = "plain",
  nestedParent = null,
} = {}) {
  const parent = nestedParent ? path.join(mainRoot, nestedParent) : path.join(mainRoot, ".worktree");
  mkdirSync(parent, { recursive: true });
  const target = path.join(parent, id);
  if (detach) {
    git(mainRoot, ["worktree", "add", "-q", "--detach", target, "HEAD"]);
  } else {
    git(mainRoot, ["worktree", "add", "-q", "-b", branch, target, "HEAD"]);
  }
  writeFileSync(path.join(target, "tip.txt"), `${id} tip\n`);
  git(target, ["add", "tip.txt"]);
  git(target, ["commit", "-qm", `${id} tip`]);
  const changeDirPath = path.join(target, "openspec", "changes", id);
  if (changeDir === "plain") {
    mkdirSync(changeDirPath, { recursive: true });
    writeFileSync(path.join(changeDirPath, "tasks.md"), `# ${id}\n`);
  } else if (changeDir === "absent") {
    // The chore-A shape: the worktree governs no change folder at all.
    rmSync(changeDirPath, { recursive: true, force: true });
  } else if (changeDir === "symlink") {
    mkdirSync(path.dirname(changeDirPath), { recursive: true });
    const elsewhere = path.join(rootDir, `elsewhere-${id}`);
    mkdirSync(elsewhere, { recursive: true });
    rmSync(changeDirPath, { recursive: true, force: true });
    symlinkSync(elsewhere, changeDirPath, "dir");
  }
  return { root: realpathSync(target), tip: git(target, ["rev-parse", "HEAD"]) };
}

before(() => {
  const root = mkdtempSync(path.join(os.tmpdir(), "declared-binding-"));
  const mainRoot = path.join(root, "main");
  mkdirSync(mainRoot, { recursive: true });
  git(mainRoot, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(mainRoot, ".gitignore"), ".worktree/\n");
  const changeIds = [
    CHANGE, CHANGE_A1, CHANGE_A3, CHANGE_TWIN, CHANGE_DETACHED, CHANGE_PROTECTED,
    CHANGE_ADVISORY_BRANCH, CHANGE_PRUNED, CHANGE_CHORELESS, CHANGE_INVALID_DIR,
  ];
  for (const id of changeIds) {
    mkdirSync(path.join(mainRoot, "openspec", "changes", id), { recursive: true });
    writeFileSync(path.join(mainRoot, "openspec", "changes", id, "tasks.md"), `# ${id}\n`);
  }
  git(mainRoot, ["add", ".gitignore", "openspec"]);
  git(mainRoot, ["commit", "-qm", "fixture seed"]);
  const mainTip = git(mainRoot, ["rev-parse", "HEAD"]);

  const linked = {};
  for (const id of [CHANGE, CHANGE_A1, CHANGE_A3, CHANGE_TWIN, CHANGE_CHORELESS, CHANGE_INVALID_DIR]) {
    linked[id] = addLinkedWorktree(root, mainRoot, id, {
      changeDir: id === CHANGE_CHORELESS ? "absent" : (id === CHANGE_INVALID_DIR ? "symlink" : "plain"),
    });
  }
  linked[CHANGE_DETACHED] = addLinkedWorktree(root, mainRoot, CHANGE_DETACHED, { detach: true });
  linked[CHANGE_PROTECTED] = addLinkedWorktree(root, mainRoot, CHANGE_PROTECTED, { branch: "production" });
  linked[CHANGE_ADVISORY_BRANCH] = addLinkedWorktree(root, mainRoot, CHANGE_ADVISORY_BRANCH, { branch: "review-lane" });
  // ≥2 candidates for one declared key: two live linked worktrees whose path
  // segments both name CHANGE_TWIN, in the same common-dir.
  addLinkedWorktree(root, mainRoot, CHANGE_TWIN, { nestedParent: path.join("nested", ".worktree"), branch: `chore/${CHANGE_TWIN}-nested` });
  // Prunable candidate: directory removed, entry still enumerated by git.
  addLinkedWorktree(root, mainRoot, CHANGE_PRUNED);
  rmSync(path.join(mainRoot, ".worktree", CHANGE_PRUNED), { recursive: true, force: true });
  // Foreign repo with a same-name worktree (cross-repo common-dir case).
  const foreignMain = path.join(root, "foreign");
  mkdirSync(foreignMain, { recursive: true });
  git(foreignMain, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(foreignMain, "seed"), "foreign\n");
  git(foreignMain, ["add", "seed"]);
  git(foreignMain, ["commit", "-qm", "foreign seed"]);
  const foreignLinked = addLinkedWorktree(root, foreignMain, CHANGE);
  // Fake `.worktree/<id>` directory inside the main working tree while the real
  // linked worktree for the same id lives elsewhere (D1.6 accident convergence).
  const fakeDir = path.join(mainRoot, "local", ".worktree", CHANGE);
  mkdirSync(fakeDir, { recursive: true });

  shared = {
    root,
    mainRoot: realpathSync(mainRoot),
    mainTip,
    linked,
    foreignLinked,
    fakeDir: realpathSync(fakeDir),
    mainChangeDir: (id) => path.join(mainRoot, "openspec", "changes", id),
    linkedChangeDir: (id) => path.join(linked[id]?.root ?? "", "openspec", "changes", id),
  };
});

after(() => {
  if (shared) rmSync(shared.root, { recursive: true, force: true });
});

function recordsIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json"));
}

function recordsOf(id) {
  return recordsIn(path.join(shared.linked[id]?.root ?? "", "openspec", "changes", id, "admission-records"));
}

function mainRecordsOf(id) {
  return recordsIn(path.join(shared.mainChangeDir(id), "admission-records"));
}

function promptLines({
  role = "dp-programmer",
  responsibilityId = "primary-review",
  evidenceScope = "local diff only",
  returnAndStop = "report and stop",
  changeId = null,
  executionRoot = null,
  instanceMode = "fresh",
  parentRecordId = null,
} = {}) {
  const lines = [
    "objective: independent-judgment",
    `responsibility_id: ${responsibilityId}`,
    `instance_mode: ${instanceMode}`,
  ];
  if (parentRecordId) lines.push(`parent_record_id: ${parentRecordId}`);
  lines.push(`evidence_scope: ${evidenceScope}`);
  lines.push(`return_and_stop: ${returnAndStop}`);
  if (changeId) lines.push(`change_id: ${changeId}`);
  if (executionRoot) lines.push(`execution_root: ${executionRoot}`);
  lines.push(`role: ${role}`);
  return lines.join("\n");
}

function fieldsOf(prompt) {
  return parseAdmissionFields(prompt).fields;
}

function writeDeclared(prompt, { cwd = shared.mainRoot, host = "claude-code", roleBinding = "host-verified", hooks } = {}) {
  return writeAdmissionRecord({
    cwd,
    host,
    prompt,
    fields: fieldsOf(prompt),
    roleBinding,
    ...(hooks ? { hooks } : {}),
  });
}

function declaredPrompt({ changeId = CHANGE, executionRoot = null, ...rest } = {}) {
  return promptLines({
    ...rest,
    changeId,
    executionRoot: executionRoot ?? shared.linked[changeId]?.root ?? `/nonexistent/${changeId}`,
  });
}

// ── T1(a)–(c): main-rooted declared minting into the exact-one worktree ──

test("Declared Change Id Binds A Main-Rooted Dispatch To The Exact-One Worktree", () => {
  const beforeMain = mainRecordsOf(CHANGE);
  const beforeLinked = recordsOf(CHANGE);
  const prompt = declaredPrompt({ changeId: CHANGE, role: "dp-assistant" });
  const written = writeDeclared(prompt);
  assert.equal(written.ok, true, `expected declared mint, got ${written.code}`);
  const recordPath = path.join(shared.linkedChangeDir(CHANGE), "admission-records", `${written.record_id}.json`);
  assert.equal(existsSync(recordPath), true, "the record MUST land under the binding worktree change dir");
  const bytes = readFileSync(recordPath);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), written.digest);
  const record = JSON.parse(bytes.toString("utf8"));
  assert.equal(record.change_id, CHANGE);
  assert.equal(record.head_sha, shared.linked[CHANGE].tip, "head_sha MUST be the binding worktree HEAD");
  assert.notEqual(record.head_sha, shared.mainTip, "the main checkout HEAD MUST NOT be bound");
  assert.equal(record.role, "dp-assistant");
  assert.equal(Object.hasOwn(record, "execution_root"), false, "execution_root is an input contract, never persisted");
  assert.equal(bytes.toString("utf8").includes(shared.linked[CHANGE].root), false, "the record MUST NOT carry the absolute binding root");
  assert.deepEqual(mainRecordsOf(CHANGE), beforeMain, "the main checkout change dir MUST NOT gain a record");
  assert.equal(recordsOf(CHANGE).length, beforeLinked.length + 1);

  // A1 trusted responsibility_id prefix binds the same way (A2 absent).
  const beforeA1 = recordsOf(CHANGE_A1);
  const a1Simple = writeDeclared(promptLines({
    role: "dp-assistant",
    responsibilityId: `implement-${CHANGE_A1}`,
    evidenceScope: "tasks.md; design.md",
    executionRoot: shared.linked[CHANGE_A1].root,
  }));
  assert.equal(a1Simple.ok, true, `expected A1 declared mint, got ${a1Simple.code}`);
  assert.equal(recordsOf(CHANGE_A1).length, beforeA1.length + 1);
  assert.deepEqual(mainRecordsOf(CHANGE_A1), []);

  // Every supported host routes the shared declared resolver (parity).
  const hostCases = [
    ["claude-code", "Agent", { subagent_type: "dp-assistant", prompt }],
    ["opencode", "Task", { subagent_type: "dp-assistant", prompt }],
    ["cursor", "Task", { subagent_type: "dp-assistant", prompt }],
    ["codex", "collaborationspawn_agent", { agent_type: "dp-assistant", fork_turns: "none", message: prompt }],
  ];
  for (const [host, toolName, toolInput] of hostCases) {
    const result = evaluateAgentDispatch(toolName, toolInput, { host, cwd: shared.mainRoot });
    assert.notEqual(result, SPAWN_CONTEXT_PASS_THROUGH, `${host}: dispatch must be governed`);
    assert.equal(result.block, undefined, `${host}: ${JSON.stringify(result)}`);
    // Declared path: the admission handoff stays a single line and also names
    // the resolved absolute binding root (TL／model-visible); only the cwd fast
    // path is exempt from the note.
    const match = /^admission_record: ([0-9a-f-]{36}) sha256=([0-9a-f]{64}) \(resolved binding root: ([^\n]+)\)$/.exec(result.advisory ?? "");
    assert.ok(match, `${host}: expected the declared-path handoff with the resolved binding root`);
    assert.equal(match[3], shared.linked[CHANGE].root, `${host}: the handoff MUST name the resolved absolute binding root`);
    const recordPath = path.join(shared.linkedChangeDir(CHANGE), "admission-records", `${match[1]}.json`);
    assert.equal(existsSync(recordPath), true, `${host}: record must land in the binding worktree`);
    assert.equal(readFileSync(recordPath).toString("utf8").includes(shared.linked[CHANGE].root), false, `${host}: the record MUST NOT carry the absolute binding root`);
  }
  assert.deepEqual(mainRecordsOf(CHANGE), beforeMain, "no host may mint into the main checkout");
});

// ── T1(d): read order and only-read-source consistency ──

test("Declaration Read Order Is Closed And Only Read Sources Are Compared", () => {
  // A2 present is the authority, and A1 must agree when both are read.
  assert.deepEqual(
    resolveDeclaredChangeLookupKey({ change_id: CHANGE }),
    { ok: true, changeId: CHANGE, source: "change_id" },
  );
  assert.deepEqual(
    resolveDeclaredChangeLookupKey({ change_id: CHANGE, responsibility_id: `implement-${CHANGE}` }),
    { ok: true, changeId: CHANGE, source: "change_id" },
  );
  assert.deepEqual(
    resolveDeclaredChangeLookupKey({ change_id: CHANGE, responsibility_id: `implement-${CHANGE_A1}` }),
    { ok: false, code: "admission-binding-inconsistent" },
  );
  // A2 absent, A1 present → A1 is the key and A3 goes unread.
  assert.deepEqual(
    resolveDeclaredChangeLookupKey({ responsibility_id: `implement-${CHANGE_A1}` }),
    { ok: true, changeId: CHANGE_A1, source: "responsibility_id" },
  );
  assert.deepEqual(
    resolveDeclaredChangeLookupKey({
      responsibility_id: `implement-${CHANGE_A1}`,
      evidence_scope: `.worktree/${CHANGE_A3}/openspec/changes/${CHANGE_A3}/tasks.md`,
    }),
    { ok: true, changeId: CHANGE_A1, source: "responsibility_id" },
    "A3 MUST NOT be read when A1 derives the key",
  );
  // A2 present → A3 goes unread.
  assert.deepEqual(
    resolveDeclaredChangeLookupKey({
      change_id: CHANGE,
      evidence_scope: `.worktree/${CHANGE_A3}/openspec/changes/${CHANGE_A3}/tasks.md`,
    }),
    { ok: true, changeId: CHANGE, source: "change_id" },
    "A3 MUST NOT be read when A2 is present",
  );
  // A2／A1 absent, cwd resolves no fast-path id → A3 is the sole source.
  assert.deepEqual(
    resolveDeclaredChangeLookupKey({
      evidence_scope: `openspec/changes/${CHANGE_A3}/design.md`,
      return_and_stop: `.worktree/${CHANGE_A3}/tasks.md`,
    }, { cwdChangeId: null }),
    { ok: true, changeId: CHANGE_A3, source: "evidence_scope" },
  );
  // A cwd fast-path id suppresses A3 entirely (only A2／A1 are compared).
  assert.deepEqual(
    resolveDeclaredChangeLookupKey({
      evidence_scope: `openspec/changes/${CHANGE_A3}/design.md`,
    }, { cwdChangeId: CHANGE }),
    { ok: false, code: "change-worktree-required", noDeclaration: true },
    "A3 MUST NOT be read when the cwd fast path already resolves an id",
  );

  // Cross-model CM-2: A3 carriers are scanned per carrier with the segment
  // boundary at a path separator, a whitespace/backtick, or the carrier end —
  // the joined-buffer regex used to swallow newlines/backticks (0-id) and to
  // glue a carrier-final segment to the next carrier (missed ambiguity).
  const A3_ZERO = { ok: false, code: "change-worktree-required", noDeclaration: true };
  // 0-id: no segment anywhere.
  assert.deepEqual(
    resolveDeclaredChangeLookupKey({ evidence_scope: "local diff only", return_and_stop: "stop" }, { cwdChangeId: null }),
    A3_ZERO,
    "no A3 segment is equivalent to no declaration",
  );
  // backtick: a quoted segment still yields its id.
  assert.deepEqual(
    resolveDeclaredChangeLookupKey({ evidence_scope: "read `.worktree/backtick-change` first" }, { cwdChangeId: null }),
    { ok: true, changeId: "backtick-change", source: "evidence_scope" },
    "a backtick-quoted segment MUST NOT swallow the closing backtick",
  );
  // cross-line: a carrier-final segment followed by another carrier stays one
  // id, never one merged candidate.
  assert.deepEqual(
    resolveDeclaredChangeLookupKey({
      evidence_scope: "openspec/changes/cross-line-change",
      return_and_stop: "return findings and stop",
    }, { cwdChangeId: null }),
    { ok: true, changeId: "cross-line-change", source: "evidence_scope" },
    "a segment at a carrier boundary MUST NOT swallow the next carrier",
  );
  // 2-id: two distinct ids across the carriers stay ambiguous even when the
  // first segment sits at the first carrier's end.
  assert.deepEqual(
    resolveDeclaredChangeLookupKey({
      evidence_scope: "openspec/changes/first-distinct-change",
      return_and_stop: "openspec/changes/second-distinct-change",
    }, { cwdChangeId: null }),
    { ok: false, code: "change-worktree-ambiguous" },
    "a swallowed second segment MUST NOT hide the ambiguity",
  );
  // archive exclusion: an archive segment never counts, alone or otherwise.
  assert.deepEqual(
    resolveDeclaredChangeLookupKey({
      evidence_scope: "openspec/changes/archive/2024-01-01-some-change/tasks.md",
    }, { cwdChangeId: null }),
    A3_ZERO,
    "an archive segment MUST NOT become the A3 id",
  );
  assert.deepEqual(
    resolveDeclaredChangeLookupKey({
      evidence_scope: ".worktree/archive/tasks.md",
    }, { cwdChangeId: null }),
    A3_ZERO,
    "a `.worktree/archive` segment MUST NOT become the A3 id",
  );

  // Writer level: A2 inconsistent with A1 fails closed and mints nowhere.
  const beforeA = recordsOf(CHANGE);
  const beforeSibling = recordsOf(CHANGE_A1);
  const inconsistent = writeDeclared(promptLines({
    changeId: CHANGE,
    responsibilityId: `implement-${CHANGE_A1}`,
    executionRoot: shared.linked[CHANGE].root,
  }));
  assert.equal(inconsistent.ok, false);
  assert.equal(inconsistent.code, "admission-binding-inconsistent");
  assert.deepEqual(recordsOf(CHANGE), beforeA, "no partial mint under the A2 id");
  assert.deepEqual(recordsOf(CHANGE_A1), beforeSibling, "no partial mint under the A1 id");

  // Writer level: A2 wins over a scope segment naming another active change.
  const beforeScope = recordsOf(CHANGE_A3);
  const scoped = writeDeclared(declaredPrompt({
    changeId: CHANGE,
    evidenceScope: `.worktree/${CHANGE_A3}/openspec/changes/${CHANGE_A3}/tasks.md`,
  }));
  assert.equal(scoped.ok, true, `A3 must not be read when A2 is present, got ${scoped.code}`);
  assert.deepEqual(recordsOf(CHANGE_A3), beforeScope, "the A3 id MUST NOT be bound");

  // Writer level: A1 wins over a scope segment naming another active change.
  const scopedA1 = writeDeclared(promptLines({
    role: "dp-programmer",
    responsibilityId: `implement-${CHANGE_A1}`,
    evidenceScope: `.worktree/${CHANGE_A3}/openspec/changes/${CHANGE_A3}/tasks.md`,
    executionRoot: shared.linked[CHANGE_A1].root,
  }));
  assert.equal(scopedA1.ok, true, `A3 must not be read when A1 derives the key, got ${scopedA1.code}`);
  assert.deepEqual(recordsOf(CHANGE_A3), beforeScope);

  // Writer level: A3 alone binds the one distinct declared id.
  const beforeA3 = recordsOf(CHANGE_A3);
  const a3Only = writeDeclared(promptLines({
    role: "dp-programmer",
    evidenceScope: `openspec/changes/${CHANGE_A3}/design.md`,
    returnAndStop: `.worktree/${CHANGE_A3}/tasks.md`,
    executionRoot: shared.linked[CHANGE_A3].root,
  }));
  assert.equal(a3Only.ok, true, `expected A3-only bind, got ${a3Only.code}`);
  assert.equal(recordsOf(CHANGE_A3).length, beforeA3.length + 1);
  assert.equal(
    JSON.parse(readFileSync(path.join(shared.linkedChangeDir(CHANGE_A3), "admission-records", `${a3Only.record_id}.json`), "utf8")).change_id,
    CHANGE_A3,
  );

  // Writer level: a cwd fast-path id is not compared against A3.
  const afterA3 = recordsOf(CHANGE_A3);
  const beforeCwdFast = recordsOf(CHANGE);
  const cwdFast = writeDeclared(promptLines({
    role: "dp-programmer",
    evidenceScope: `openspec/changes/${CHANGE_A3}/design.md`,
  }), { cwd: shared.linked[CHANGE].root });
  assert.equal(cwdFast.ok, true, `cwd fast path must not read A3, got ${cwdFast.code}`);
  assert.equal(recordsOf(CHANGE).length, beforeCwdFast.length + 1);
  assert.deepEqual(recordsOf(CHANGE_A3), afterA3, "a cwd fast-path id must not be compared against unread A3 segments");
});

// ── T1(d)／T2: cwd × declaration disagreement ──

test("Cwd And Declaration Disagreement Fails Closed Without A Winning Side", () => {
  const beforeCwd = recordsOf(CHANGE);
  const beforeDeclared = recordsOf(CHANGE_A1);
  const mismatch = writeDeclared(declaredPrompt({ changeId: CHANGE_A1 }), { cwd: shared.linked[CHANGE].root });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "change-binding-mismatch");
  assert.deepEqual(recordsOf(CHANGE), beforeCwd, "the cwd side MUST NOT win");
  assert.deepEqual(recordsOf(CHANGE_A1), beforeDeclared, "the declared side MUST NOT win");
  assert.deepEqual(mainRecordsOf(CHANGE_A1), []);

  // Agreement binds the cwd worktree exactly once (no side steals the binding).
  const agreeing = writeDeclared(declaredPrompt({ changeId: CHANGE }), { cwd: shared.linked[CHANGE].root });
  assert.equal(agreeing.ok, true, `expected agreement mint, got ${agreeing.code}`);
  assert.equal(recordsOf(CHANGE).length, beforeCwd.length + 1);

  // A non-worktree cwd is not a competing source: the declaration is the only one.
  const mainRooted = writeDeclared(declaredPrompt({ changeId: CHANGE_A1 }));
  assert.equal(mainRooted.ok, true, `a plain cwd must not compete with the declaration, got ${mainRooted.code}`);
  assert.equal(recordsOf(CHANGE_A1).length, beforeDeclared.length + 1);
});

// ── T2: fail-closed negatives, one code per cause, zero partial mint ──

function bindingFor({ changeId = CHANGE, cwd = shared.mainRoot, fields, hooks } = {}) {
  return resolveAdmissionBinding({
    cwd,
    fields: fields ?? fieldsOf(declaredPrompt({ changeId })),
    ...(hooks ? { hooks } : {}),
  });
}

test("Declared Binding Faults Fail Closed With One Code Per Cause", () => {
  const snapshot = () => ({
    main: readdirSync(path.join(shared.mainRoot, "openspec", "changes")).length,
    linked: recordsOf(CHANGE).length + recordsOf(CHANGE_A1).length + recordsOf(CHANGE_A3).length,
  });
  const before = snapshot();

  // zero candidates for the declared key
  const zero = bindingFor({ changeId: "no-such-declared-change" });
  assert.equal(zero.ok, false);
  assert.equal(zero.code, "change-worktree-required");

  // two or more candidates for the declared key
  const twin = bindingFor({ changeId: CHANGE_TWIN });
  assert.equal(twin.ok, false);
  assert.equal(twin.code, "change-worktree-ambiguous");

  // truncated / unparseable porcelain
  const truncated = bindingFor({
    hooks: {
      git(cwd, args) {
        if (args[0] === "worktree" && args[1] === "list") return `worktree ${shared.linked[CHANGE].root}\0HEAD ${shared.linked[CHANGE].tip}`;
        return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
      },
    },
  });
  assert.equal(truncated.ok, false);
  assert.equal(truncated.code, "intent-scan-failed");

  // foreign common-dir candidate
  const foreign = bindingFor({
    hooks: {
      git(cwd, args) {
        if (args[0] === "worktree" && args[1] === "list") {
          return [
            `worktree ${shared.mainRoot}`, `HEAD ${shared.mainTip}`, "",
            `worktree ${shared.foreignLinked.root}`, `HEAD ${shared.foreignLinked.tip}`, "",
            "",
          ].join("\0");
        }
        return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
      },
    },
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.code, "intent-scan-failed");

  // enumeration above the worktree budget (128 entries, main checkout included)
  const overCap = bindingFor({
    hooks: {
      git(cwd, args) {
        if (args[0] === "worktree" && args[1] === "list") {
          return Array.from({ length: 129 }, () => `worktree ${shared.linked[CHANGE].root}\0HEAD ${shared.linked[CHANGE].tip}\0\0`).join("");
        }
        return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
      },
    },
  });
  assert.equal(overCap.ok, false);
  assert.equal(overCap.code, "intent-candidate-limit-exceeded");

  // no same common-dir at all (cross-repo session)
  const crossRepo = bindingFor({
    hooks: {
      git() { return null; },
    },
  });
  assert.equal(crossRepo.ok, false);
  assert.equal(crossRepo.code, "change-worktree-required");

  // a prunable candidate is excluded; broken exact-one keeps the closed code
  const pruned = bindingFor({ changeId: CHANGE_PRUNED });
  assert.equal(pruned.ok, false);
  assert.equal(pruned.code, "change-worktree-required");
  assert.equal(pruned.noDeclaration, undefined, "a declared but unresolvable id is not the advisory no-declaration shape");
  // …and the excluded prunable entry does not poison other declared keys.
  assert.equal(bindingFor({ changeId: CHANGE }).ok, true, "prunable exclusion must not fail the whole scan");

  // A3 alone, two distinct declared ids
  const a3Multi = bindingFor({
    fields: fieldsOf(promptLines({
      evidenceScope: `.worktree/${CHANGE_A1}/openspec/changes/${CHANGE_A3}/proposal.md`,
    })),
  });
  assert.equal(a3Multi.ok, false);
  assert.equal(a3Multi.code, "change-worktree-ambiguous");

  // detached binding candidate
  const detached = bindingFor({ changeId: CHANGE_DETACHED });
  assert.equal(detached.ok, false);
  assert.equal(detached.code, "binding-head-detached");
  assert.equal(detached.bindingRoot, shared.linked[CHANGE_DETACHED].root, "the resolved root stays operator-visible");

  // protected base branch candidate
  const protectedBranch = bindingFor({ changeId: CHANGE_PROTECTED });
  assert.equal(protectedBranch.ok, false);
  assert.equal(protectedBranch.code, "binding-branch-protected");
  assert.equal(protectedBranch.bindingRoot, shared.linked[CHANGE_PROTECTED].root);

  // writer level: every fault mints nowhere and never hands back a record
  for (const changeId of ["no-such-declared-change", CHANGE_TWIN, CHANGE_DETACHED, CHANGE_PROTECTED, CHANGE_PRUNED]) {
    const written = writeDeclared(declaredPrompt({ changeId, executionRoot: `/nonexistent/${changeId}` }));
    assert.equal(written.ok, false, `${changeId} must not mint`);
    assert.equal(typeof written.code, "string", `${changeId} needs a stable closed code`);
    assert.equal(Object.hasOwn(written, "record_id"), false);
  }
  const a3MultiWritten = writeDeclared(promptLines({
    evidenceScope: `.worktree/${CHANGE_A1}/openspec/changes/${CHANGE_A3}/proposal.md`,
  }));
  assert.equal(a3MultiWritten.ok, false);
  assert.equal(a3MultiWritten.code, "change-worktree-ambiguous");
  assert.deepEqual(snapshot(), before, "zero partial mint across the fault matrix");
});

// ── F-r2-1: the branch post-check is declared-path only; the fast path keeps its semantics ──

test("Cwd Fast Path Keeps Existing Semantics Without A Branch Post-Check", () => {
  // Behavior preservation: the cwd fast path predates this change and MUST NOT
  // regress. A spawn cwd inside a live linked worktree therefore still mints
  // when that worktree is on a detached HEAD or a protected base branch.
  for (const id of [CHANGE_DETACHED, CHANGE_PROTECTED]) {
    const before = recordsOf(id);
    const fast = writeDeclared(promptLines({ role: "dp-assistant" }), { cwd: shared.linked[id].root });
    assert.equal(fast.ok, true, `the cwd fast path must still mint for ${id}: ${fast.code}`);
    assert.equal(fast.bindingPath, "cwd-fast");
    assert.deepEqual(fast.advisories, [], "the fast path carries no branch advisory");
    const recordPath = path.join(shared.linkedChangeDir(id), "admission-records", `${fast.record_id}.json`);
    assert.equal(existsSync(recordPath), true, `the fast-path record must land under ${id}`);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(record.head_sha, shared.linked[id].tip, `the fast path binds the ${id} worktree HEAD`);
    assert.equal(recordsOf(id).length, before.length + 1);
  }

  const gate = evaluateAgentDispatch("Agent", {
    subagent_type: "dp-assistant",
    prompt: promptLines({ role: "dp-assistant" }),
  }, { host: "claude-code", cwd: shared.linked[CHANGE_DETACHED].root });
  assert.equal(gate.block, undefined, `a detached cwd fast-path dispatch stays admitted: ${JSON.stringify(gate)}`);
  assert.match(gate.advisory, /^admission_record: [0-9a-f-]{36} sha256=[0-9a-f]{64}$/);

  // The same worktrees resolved through a declaration keep failing closed with
  // the branch post-check codes: that check applies on the declared path only.
  const declaredCases = [
    [CHANGE_DETACHED, "binding-head-detached"],
    [CHANGE_PROTECTED, "binding-branch-protected"],
  ];
  for (const [id, code] of declaredCases) {
    const before = recordsOf(id);
    const declared = writeDeclared(declaredPrompt({ changeId: id, role: "dp-assistant" }));
    assert.equal(declared.ok, false, `${id} must fail closed on the declared path`);
    assert.equal(declared.code, code);
    assert.equal(declared.bindingRoot, shared.linked[id].root, "the resolved root stays operator-visible");
    assert.equal(recordsOf(id).length, before.length, "the declared-path failure mints nothing");
  }
});

test("declared branch convention mismatch stays a non-blocking closed advisory with an unchanged mint", () => {
  const written = writeDeclared(declaredPrompt({ changeId: CHANGE_ADVISORY_BRANCH, role: "dp-assistant" }));
  assert.equal(written.ok, true, `a non-convention branch must not block the mint: ${written.code}`);
  assert.deepEqual(written.advisories, ["binding-branch-convention-advisory"]);
  const recordPath = path.join(shared.linkedChangeDir(CHANGE_ADVISORY_BRANCH), "admission-records", `${written.record_id}.json`);
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  assert.equal(record.head_sha, shared.linked[CHANGE_ADVISORY_BRANCH].tip, "the advisory must not change head_sha");

  const gate = evaluateAgentDispatch("Agent", {
    subagent_type: "dp-assistant",
    prompt: declaredPrompt({ changeId: CHANGE_ADVISORY_BRANCH, role: "dp-assistant" }),
  }, { host: "claude-code", cwd: shared.mainRoot });
  assert.equal(gate.block, undefined, JSON.stringify(gate));
  assert.match(gate.advisory, /^admission_record: [0-9a-f-]{36} sha256=[0-9a-f]{64}/);
  assert.match(gate.advisory, /binding-branch-convention-advisory/, "the advisory must be non-silent");
  assert.equal(gate.advisory.includes("\n"), false);
  assert.equal(
    gate.advisory.includes(`(resolved binding root: ${shared.linked[CHANGE_ADVISORY_BRANCH].root})`),
    true,
    "the declared-path success handoff MUST name the resolved absolute binding root",
  );

  // The cwd fast path carries the environment as its own proof of the root and
  // stays path-free: the same success shape dispatched from inside the linked
  // worktree.
  const fastGate = evaluateAgentDispatch("Agent", {
    subagent_type: "dp-assistant",
    prompt: declaredPrompt({ changeId: CHANGE_ADVISORY_BRANCH, role: "dp-assistant" }),
  }, { host: "claude-code", cwd: shared.linked[CHANGE_ADVISORY_BRANCH].root });
  assert.equal(fastGate.block, undefined, JSON.stringify(fastGate));
  assert.match(fastGate.advisory, /^admission_record: [0-9a-f-]{36} sha256=[0-9a-f]{64}(?:; advisory: binding-branch-convention-advisory)?$/);
  assert.equal(fastGate.advisory.includes(shared.linked[CHANGE_ADVISORY_BRANCH].root), false, "the cwd fast-path success handoff stays path-free");
});

// ── T2／R5: declared ids never degrade to the change-folder-absent advisory ──

test("Declared Change Id With No Worktree Never Degrades To The Advisory Pass", () => {
  const beforeMain = mainRecordsOf("declared-no-worktree-change");
  // An advisory-class role must still block: the declared id is unresolvable,
  // not a change folder that is provably absent.
  const prompt = declaredPrompt({ changeId: "declared-no-worktree-change", role: "dp-assistant", executionRoot: "/nonexistent/declared-no-worktree-change" });
  const result = evaluateAgentDispatch("Agent", { subagent_type: "dp-assistant", prompt }, { host: "claude-code", cwd: shared.mainRoot });
  assert.equal(result.block, true, "a declared id with no worktree must not fall into the advisory pass");
  assert.match(result.reason, /change-worktree-required/);
  // #3556 item 4: a change worktree of another repository is not bound; the reason says where to delegate from.
  assert.match(result.reason, /only the session's own repository.*open a session in that repository/);
  assert.equal(/admission-records-dir-missing|binding-unresolved/.test(result.reason), false);

  // The change-folder-absent advisory applies only once a binding is established:
  // a declared id whose worktree exists but governs no change folder passes
  // without a record (the chore-A shape).
  const choreless = evaluateAgentDispatch("Agent", {
    subagent_type: "dp-assistant",
    prompt: declaredPrompt({ changeId: CHANGE_CHORELESS, role: "dp-assistant" }),
  }, { host: "claude-code", cwd: shared.mainRoot });
  assert.equal(choreless.block, undefined, `expected the D51 advisory pass, got ${JSON.stringify(choreless)}`);
  assert.match(choreless.advisory, /admission-records-dir-missing/);
  assert.equal(/admission_record: /.test(choreless.advisory), false, "no record id may be handed back");

  // An entry that exists but is not usable keeps failing closed, never advisory.
  const invalid = evaluateAgentDispatch("Agent", {
    subagent_type: "dp-assistant",
    prompt: declaredPrompt({ changeId: CHANGE_INVALID_DIR, role: "dp-assistant" }),
  }, { host: "claude-code", cwd: shared.mainRoot });
  assert.equal(invalid.block, true, "an existing-but-invalid change dir must block");
  assert.match(invalid.reason, /admission-records-dir-invalid/);
  assert.deepEqual(mainRecordsOf("declared-no-worktree-change"), beforeMain);
});

// The change-less advisory pass is not limited to the cwd fast path: a review role that declares a
// change-less worktree from the main checkout passes the same way (model-delegation.md, change-less
// change_id paragraph), while the same role with no declaration still fails closed.
test("Scenario: A Main-Checkout Review Dispatch With A Declared Change-Less Binding Passes", () => {
  const declared = evaluateAgentDispatch("Agent", {
    subagent_type: "dp-reviewer",
    prompt: declaredPrompt({ changeId: CHANGE_CHORELESS, role: "dp-reviewer" }),
  }, { host: "claude-code", cwd: shared.mainRoot });
  assert.equal(declared.block, undefined, `a declared change-less review dispatch must pass: ${JSON.stringify(declared)}`);
  assert.match(declared.advisory, /admission-records-dir-missing/);
  assert.equal(/admission_record: /.test(declared.advisory), false, "no record id may be handed back");

  const undeclared = evaluateAgentDispatch("Agent", {
    subagent_type: "dp-reviewer",
    prompt: promptLines({ role: "dp-reviewer" }),
  }, { host: "claude-code", cwd: shared.mainRoot });
  assert.equal(undeclared.block, true, "a review dispatch with no declaration from the main checkout must block");
  assert.match(undeclared.reason, /change-worktree-required/);
});

// ── T1(e)／T-3-3: role classification for an unresolved binding ──

test("Unresolved Binding Fails Closed For Review And Verify And Advises For Every Other Role", () => {
  const expectedClasses = Object.freeze({
    "dp-analyst": "advisory",
    "dp-architect": "advisory",
    "dp-reviewer": "review",
    "dp-second-reviewer": "review",
    "dp-programmer": "advisory",
    "dp-assistant": "advisory",
    "dp-explorer": "advisory",
  });
  assert.deepEqual(
    [...ADMISSION_ROLES].sort(),
    Object.keys(expectedClasses).sort(),
    "a newly registered dp-* role must be classified here or this covering assertion fails",
  );
  assert.deepEqual([...ADMISSION_REVIEW_ROLES].sort(), ["dp-reviewer", "dp-second-reviewer"]);
  for (const role of ADMISSION_ROLES) {
    assert.equal(
      classifyAdmissionRoleClass(role),
      expectedClasses[role],
      `${role} must fall in exactly one class`,
    );
  }

  const before = recordsOf(CHANGE);
  for (const role of ADMISSION_ROLES) {
    const prompt = promptLines({ role });
    const result = evaluateAgentDispatch("Agent", { subagent_type: role, prompt }, { host: "claude-code", cwd: shared.mainRoot });
    if (classifyAdmissionRoleClass(role) === "review") {
      assert.equal(result.block, true, `${role} must fail closed without a binding`);
      assert.match(result.reason, /change-worktree-required/);
      assert.match(result.reason, /change worktree/, "the block must name the worktree remedy");
      assert.match(result.reason, /change_id/, "the block must name the declare-change_id remedy");
      assert.match(result.reason, /no change exists yet/, "the block must name the change-less route");
      assert.match(result.reason, /do not create a worktree/, "the block must forbid a worktree made only to pass the gate");
      assert.match(result.reason, /runner directly/, "the block must point at the runner carrier");
    } else {
      assert.equal(result?.block, undefined, `${role} must pass as an advisory, got ${JSON.stringify(result)}`);
      assert.equal(typeof result.advisory, "string", `${role} advisory must be non-silent`);
      assert.match(result.advisory, /binding-unresolved/);
      assert.match(result.advisory, /admission-records-unavailable/);
      assert.equal(/admission_record: /.test(result.advisory), false, `${role} must not be handed a record`);
    }
  }
  assert.deepEqual(recordsOf(CHANGE), before, "the role-classified route never mints");

  // A declared continuation attaches to its parent record: every role blocks.
  const continuation = evaluateAgentDispatch("SendMessage", {
    message: promptLines({ role: "dp-programmer", instanceMode: "continue", parentRecordId: PARENT_RECORD_ID }),
  }, { host: "claude-code", cwd: shared.mainRoot });
  assert.equal(continuation.block, true, "a continuation without a binding must block for non-review roles too");
  assert.match(continuation.reason, /change-worktree-required/);
  assert.deepEqual(recordsOf(CHANGE), before);

  // The advisory class is exactly ADMISSION_ROLES minus the review set.
  const advisoryRoles = ADMISSION_ROLES.filter((role) => !ADMISSION_REVIEW_ROLES.includes(role));
  assert.equal(advisoryRoles.length > 0, true);
  for (const role of advisoryRoles) {
    assert.equal(classifyAdmissionRoleClass(role), "advisory", `${role} must be advisory`);
  }
});

// ── T4: operator visibility and the never-persisted boundary ──

test("Resolved Binding Root Is Operator-Visible But Never Persisted Into State", () => {
  // Fails closed after the binding was resolved: the blocked review dispatch
  // names the absolute binding root so the operator can correct and retry.
  const protectedPrompt = declaredPrompt({ changeId: CHANGE_PROTECTED, role: "dp-reviewer" });
  const blocked = evaluateAgentDispatch("Agent", { subagent_type: "dp-reviewer", prompt: protectedPrompt }, { host: "claude-code", cwd: shared.mainRoot });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /binding-branch-protected/);
  assert.equal(blocked.reason.includes(shared.linked[CHANGE_PROTECTED].root), true, "the resolved absolute binding root must be operator-visible");
  assert.equal(blocked.reason.includes("\n"), false, "the block stays a single bounded line");
  assert.equal(blocked.reason.includes("local diff only"), false, "no prompt content in the block");
  assert.equal(blocked.reason.includes(shared.fakeDir), false, "no raw cwd echo");

  // The same visibility holds for a post-binding directory fault.
  const invalidDir = evaluateAgentDispatch("Agent", {
    subagent_type: "dp-assistant",
    prompt: declaredPrompt({ changeId: CHANGE_INVALID_DIR, role: "dp-assistant" }),
  }, { host: "claude-code", cwd: shared.mainRoot });
  assert.equal(invalidDir.block, true);
  assert.equal(invalidDir.reason.includes(shared.linked[CHANGE_INVALID_DIR].root), true);

  // A successful declared mint persists no absolute binding root anywhere in
  // the record bytes; the declared-path handoff names it on the TL／model-visible
  // surface only (T-3-6 disclosure boundary).
  const written = writeDeclared(declaredPrompt({ changeId: CHANGE, role: "dp-assistant" }));
  assert.equal(written.ok, true, written.code);
  const recordPath = path.join(shared.linkedChangeDir(CHANGE), "admission-records", `${written.record_id}.json`);
  const recordText = readFileSync(recordPath, "utf8");
  assert.equal(recordText.includes(shared.linked[CHANGE].root), false);
  assert.equal(recordText.includes(shared.root), false, "no user-home/temp absolute path may be persisted");
  const success = evaluateAgentDispatch("Agent", {
    subagent_type: "dp-assistant",
    prompt: declaredPrompt({ changeId: CHANGE, role: "dp-assistant" }),
  }, { host: "claude-code", cwd: shared.mainRoot });
  const successMatch = /^admission_record: ([0-9a-f-]{36}) sha256=([0-9a-f]{64}) \(resolved binding root: ([^\n]+)\)$/.exec(success.advisory ?? "");
  assert.ok(successMatch, `expected the declared-path handoff, got ${success.advisory}`);
  assert.equal(successMatch[3], shared.linked[CHANGE].root, "the model-visible handoff MUST name the resolved absolute binding root");
});

// ── T3 parser: per-field limits and diagnoses for the two conditional fields ──

test("Change Id And Execution Root Carry Their Own Limits And Diagnoses", () => {
  const six = promptLines({ role: "dp-programmer" });
  assert.equal(ADMISSION_FIELD_VALUE_MAX.change_id, 500);
  assert.equal(ADMISSION_FIELD_VALUE_MAX.execution_root, 1024);

  const oversizeChangeId = parseAdmissionFields(`${six}\nchange_id: a${"b".repeat(500)}`);
  assert.deepEqual(oversizeChangeId.oversize, [{ field: "change_id", length: 501, max: 500 }]);
  assert.equal(oversizeChangeId.missing.includes("change_id"), false);
  const oversizeMessage = formatAdmissionFieldProblems(oversizeChangeId);
  assert.match(oversizeMessage, /change_id length=501 max=500/);
  assert.equal(/missing: .*change_id/.test(oversizeMessage), false);

  const badShape = parseAdmissionFields(`${six}\nchange_id: Bad_Shape`);
  assert.deepEqual(badShape.invalid, ["change_id"]);
  assert.match(formatAdmissionFieldProblems(badShape), /change_id shape invalid/);

  const oversizeRoot = parseAdmissionFields(`${six}\nexecution_root: /${"x".repeat(1024)}`);
  assert.deepEqual(oversizeRoot.oversize, [{ field: "execution_root", length: 1025, max: 1024 }]);
  assert.equal(oversizeRoot.missing.includes("execution_root"), false);
  assert.match(formatAdmissionFieldProblems(oversizeRoot), /execution_root length=1025 max=1024/);

  const emptyRoot = parseAdmissionFields(`${six}\nexecution_root:`);
  assert.deepEqual(emptyRoot.invalid, ["execution_root"]);
  assert.deepEqual(emptyRoot.missing, []);
  assert.match(formatAdmissionFieldProblems(emptyRoot), /execution_root/);
  assert.equal(/missing: /.test(formatAdmissionFieldProblems(emptyRoot)), false, "an empty value is a shape failure, never a missing-field claim");

  // execution_root is a path by definition and MUST NOT be a PII free-text field.
  assert.equal(unsafeAdmissionField({
    evidence_scope: "local diff",
    return_and_stop: "stop",
    fork_reason: "side task",
    execution_root: "/Users/someone/worktree",
  }), null);

  // Gate level: the bad-shape and oversize diagnoses surface through the block.
  const gateOversize = evaluateAgentDispatch("Agent", {
    subagent_type: "dp-programmer",
    prompt: `${six}\nchange_id: a${"b".repeat(500)}`,
  }, { host: "claude-code", cwd: shared.mainRoot });
  assert.equal(gateOversize.block, true);
  assert.match(gateOversize.reason, /change_id length=501 max=500/);
  const gateEmpty = evaluateAgentDispatch("Agent", {
    subagent_type: "dp-programmer",
    prompt: `${six}\nexecution_root:`,
  }, { host: "claude-code", cwd: shared.mainRoot });
  assert.equal(gateEmpty.block, true);
  assert.match(gateEmpty.reason, /execution_root/);
  assert.equal(/missing: /.test(gateEmpty.reason), false);
});

// ── D1.6 containment: subdirectory passes, fake directory fails closed ──

test("d1.6 containment: a worktree subdirectory cwd passes, a fake `.worktree/<id>` directory fails closed", () => {
  const subdirCwd = path.join(shared.linked[CHANGE].root, "openspec", "changes");
  const before = recordsOf(CHANGE);
  const subdir = writeDeclared(declaredPrompt({ changeId: CHANGE, role: "dp-assistant" }), { cwd: subdirCwd });
  assert.equal(subdir.ok, true, `a worktree subdirectory cwd must not fail closed: ${subdir.code}`);
  assert.equal(recordsOf(CHANGE).length, before.length + 1);

  const fake = resolveAdmissionBinding({
    cwd: shared.fakeDir,
    fields: fieldsOf(declaredPrompt({ changeId: CHANGE, role: "dp-assistant" })),
  });
  assert.equal(fake.ok, false);
  assert.equal(fake.code, "change-worktree-required");
  assert.equal(fake.bindingRoot, shared.linked[CHANGE].root, "the containment failure names the resolved candidate root");
});
