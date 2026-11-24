/**
 * hook-post-merge-check.test.mjs
 *
 * Unit tests for .devpro/scripts/hooks/post-merge-check.mjs (Stop hook).
 *
 * Test cases:
 *   1. No marker dir → exit 0, no output
 *   2. Empty marker dir → exit 0, no output
 *   3. Fresh marker (<30s) → no reminder
 *   4. Aged marker (>30s) → emit systemMessage with branch/kind
 *   5. Stale marker (>1h) → auto-deleted, no reminder
 *   6. Multiple markers, mixed ages → emit only for aged ones
 *   7. Branch with slash → un-sanitize correctly in reminder
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync, mkdirSync, existsSync, utimesSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/post-merge-check.mjs"
);

const tmpRoot = makeTempDir("post-merge-check-test-");

after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

function run(markerDir, { forceWorkflows, notesDir, env = {}, cwd } = {}) {
  // Default forceWorkflows="1": these tests exercise the emit/age/sanitize logic,
  // which is gated behind "repo has workflows". The source repo itself has no
  // .github/workflows, so without this override every emit assertion would be
  // suppressed by the R2 no-workflow guard. The dedicated no-workflow test passes
  // forceWorkflows="0" to assert the skip. Pass forceWorkflows=null to exercise
  // real workflow discovery without injecting the override. (fix-stop-hook-noise R2/R6)
  // notesDir: when set, injects DEVPRO_NOTES_DIR so the hook reads session-pending
  // from the specified temp dir instead of the git worktree's notes/ folder.
  const workflowOverride = forceWorkflows === undefined ? "1" : forceWorkflows;
  const runEnv = {
    ...process.env,
    ...(workflowOverride !== null ? { DEVPRO_POSTMERGE_FORCE_WORKFLOWS: workflowOverride } : {}),
    ...(markerDir ? { DEVPRO_POSTMERGE_STATE_DIR: markerDir } : {}),
    ...(notesDir !== undefined ? { DEVPRO_NOTES_DIR: notesDir } : {}),
    ...env,
  };
  const result = spawnSync("node", [HOOK], {
    encoding: "utf8",
    env: runEnv,
    ...(cwd ? { cwd } : {}),
  });
  let parsed = null;
  if (result.stdout && result.stdout.trim()) {
    try {
      parsed = JSON.parse(result.stdout);
    } catch {}
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json: parsed };
}

let counter = 0;
function newDir() {
  return path.join(tmpRoot, `dir-${counter++}`);
}

function markerBranchFromName(name) {
  const dotIdx = name.lastIndexOf(".");
  const raw = dotIdx === -1 ? name : name.slice(0, dotIdx);
  return raw.replace(/_/g, "/");
}

function markerKindFromName(name) {
  const dotIdx = name.lastIndexOf(".");
  return dotIdx === -1 ? "" : name.slice(dotIdx + 1);
}

function writeMarkerWithAge(markerDir, name, ageMs, data = {}) {
  mkdirSync(markerDir, { recursive: true });
  const p = path.join(markerDir, name);
  const branch = data.branch || markerBranchFromName(name);
  const kind = data.kind || markerKindFromName(name);
  writeFileSync(
    p,
    JSON.stringify(
      {
        branch,
        headRefName: data.headRefName || branch,
        baseRefName: data.baseRefName || "",
        kind,
        prNumber: data.prNumber || "",
        ...(data.repo !== undefined ? { repo: data.repo } : {}),
        sessionId: data.sessionId || "",
        createdAt: data.createdAt || new Date(Date.now() - ageMs).toISOString(),
      },
      null,
      2
    )
  );
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(p, t, t);
  return p;
}

function writeLegacyMarkerWithAge(markerDir, name, ageMs) {
  mkdirSync(markerDir, { recursive: true });
  const p = path.join(markerDir, name);
  writeFileSync(p, String(Date.now() - ageMs));
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(p, t, t);
  return p;
}

test("No marker dir → exit 0, no output", () => {
  const r = run(path.join(tmpRoot, "nonexistent"));
  assert.equal(r.code, 0);
  assert.equal(r.json, null);
});

test("Empty marker dir → exit 0, no output", () => {
  const dir = newDir();
  mkdirSync(dir, { recursive: true });
  const r = run(dir);
  assert.equal(r.code, 0);
  assert.equal(r.json, null);
});

test("Fresh marker (<30s) → no reminder", () => {
  const dir = newDir();
  writeMarkerWithAge(dir, "feature_foo.push", 5_000); // 5s old
  const r = run(dir);
  assert.equal(r.code, 0);
  assert.equal(r.json, null);
});

test("Aged marker (>30s) → emit systemMessage", () => {
  const dir = newDir();
  writeMarkerWithAge(dir, "feature_foo.push", 45_000); // 45s old
  const r = run(dir);
  assert.equal(r.code, 0);
  // R4: compact 訊息——核心為 Post-merge 前綴 + branch(kind) + 追蹤動作指向。
  // 不再內聯 state dir 路徑 / 30s-1h 尾註等背景說明。
  assert.match(r.json?.systemMessage || "", /Post-merge/);
  assert.match(r.json?.systemMessage || "", /feature\/foo\(push\)/);
  assert.match(r.json?.systemMessage || "", /track-postmerge-workflows\.mjs/);
  assert.match(r.json?.systemMessage || "", /git-workflow-tracking\.md/);
});

test("Stale marker (>1h) → auto-deleted, no reminder", () => {
  const dir = newDir();
  const file = writeMarkerWithAge(dir, "feature_old.push", 3_700_000); // 1h+ old
  assert.ok(existsSync(file), "marker should exist before");
  const r = run(dir);
  assert.equal(r.code, 0);
  assert.equal(r.json, null);
  assert.equal(existsSync(file), false, "stale marker should be auto-deleted");
});

test("Multiple markers, mixed ages → reminder only for aged", () => {
  const dir = newDir();
  writeMarkerWithAge(dir, "feature_a.push", 5_000); // fresh
  writeMarkerWithAge(dir, "feature_b.merge", 60_000); // aged
  writeMarkerWithAge(dir, "feature_c.push", 100_000); // aged
  const r = run(dir);
  const msg = r.json?.systemMessage || "";
  assert.match(msg, /feature\/b/);
  assert.match(msg, /feature\/c/);
  assert.doesNotMatch(msg, /feature\/a/, "fresh marker should not appear");
});

test("Branch with slash → un-sanitized correctly", () => {
  const dir = newDir();
  writeMarkerWithAge(dir, "bugfix_my-branch.merge", 45_000);
  const r = run(dir);
  assert.match(r.json?.systemMessage || "", /bugfix\/my-branch/);
  assert.match(r.json?.systemMessage || "", /merge/);
});

// A marker the hook cannot read belongs to no known repository: no reminder, and it stays until it is stale
// (PR #3703 r11 W2-F2; fix-cross-repo-state-keys).
test("Legacy timestamp marker → no reminder, kept until stale, then deleted", () => {
  const dir = newDir();
  const file = writeLegacyMarkerWithAge(dir, "feature_legacy.merge", 45_000);
  const r = run(dir);
  assert.equal(r.code, 0);
  assert.equal(r.json, null);
  assert.equal(existsSync(file), true, "an unreadable marker is not deleted before it is stale");
  const stale = writeLegacyMarkerWithAge(dir, "feature_old-legacy.merge", 3_700_000);
  run(dir);
  assert.equal(existsSync(stale), false, "a stale unreadable marker is deleted");
});

test("Push and merge kinds rendered correctly", () => {
  const dir = newDir();
  writeMarkerWithAge(dir, "feature_p.push", 45_000);
  writeMarkerWithAge(dir, "feature_m.merge", 45_000);
  const r = run(dir);
  const msg = r.json?.systemMessage || "";
  // R4: compact 格式 branch(kind)。
  assert.match(msg, /feature\/p\(push\)/);
  assert.match(msg, /feature\/m\(merge\)/);
});

// R2/R6: 無 workflow 的 repo（forceWorkflows="0"）→ 即使有 aged marker 也不 emit
// （已清過期 marker，但追蹤 workflow 無意義）。這是 source repo 不再被 post-merge
// reminder 洗版的回歸守門。
// 調整：不設 notesDir（或給無 session-pending items 的 dir），維持「完全無輸出」斷言。
// 如此才能獨立測「無 workflow → 無 workflow 提醒」，不被 session-pending 干擾。
test("No workflows in repo → skip emit even with aged marker", () => {
  const dir = newDir();
  const emptyNotesDir = newDir();
  mkdirSync(emptyNotesDir, { recursive: true });
  writeMarkerWithAge(dir, "feature_x.merge", 45_000);
  const r = run(dir, { forceWorkflows: "0", notesDir: emptyNotesDir });
  assert.equal(r.code, 0, "should exit 0");
  assert.equal(r.stdout.trim(), "", "no systemMessage when repo has no workflows and no session-pending");
});

test("#1746: workflow discovery resolves git root when hook runs from subdir", () => {
  const repo = newDir();
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, encoding: "utf8" });
  const workflowDir = path.join(repo, ".github", "workflows");
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(
    path.join(workflowDir, "ci.yml"),
    "name: ci\non: [push]\njobs:\n  noop:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n"
  );
  const subdir = path.join(repo, "nested", "cwd");
  mkdirSync(subdir, { recursive: true });

  const markerDir = newDir();
  const emptyNotesDir = newDir();
  mkdirSync(emptyNotesDir, { recursive: true });
  writeMarkerWithAge(markerDir, "feature_sub.push", 45_000);

  const r = run(markerDir, { forceWorkflows: null, cwd: subdir, notesDir: emptyNotesDir });
  const msg = r.json?.systemMessage || "";
  assert.match(msg, /Post-merge/);
  assert.match(msg, /feature\/sub\(push\)/);
  assert.match(msg, /track-postmerge-workflows\.mjs/);
});

test("#1746: workflow discovery failure emits not-checked advisory", () => {
  const cwd = newDir();
  mkdirSync(cwd, { recursive: true });
  const markerDir = newDir();
  const emptyNotesDir = newDir();
  mkdirSync(emptyNotesDir, { recursive: true });
  writeMarkerWithAge(markerDir, "feature_unknown.push", 45_000);

  const r = run(markerDir, { forceWorkflows: null, cwd, notesDir: emptyNotesDir });
  const msg = r.json?.systemMessage || "";
  assert.match(msg, /workflow discovery not checked/i);
  assert.match(msg, /pending marker count=1/);
  assert.match(msg, /git root unresolved/);
  assert.doesNotMatch(msg, /track-postmerge-workflows\.mjs/);
});

// R4: emit 訊息維持精簡（單行；不再是多段條列）。回歸守門，防再膨脹回半畫面。
// 此 case 不設 notesDir，sessionPendingCount=0，只有 workflow-watch 段（1 行）。
test("Reminder message stays compact (single line)", () => {
  const dir = newDir();
  const emptyNotesDir = newDir();
  mkdirSync(emptyNotesDir, { recursive: true });
  writeMarkerWithAge(dir, "feature_c.merge", 45_000);
  const r = run(dir, { notesDir: emptyNotesDir });
  const msg = r.json?.systemMessage || "";
  const lineCount = msg.split("\n").filter((l) => l.trim()).length;
  assert.ok(lineCount <= 2, `message should be ≤2 non-empty lines, got ${lineCount}:\n${msg}`);
});

// --- Session-pending 提醒測試 ---

// TS1: merge + session-pending items → 兩段都 emit（workflow + session-pending）
test("TS1: merge + session-pending items → emit both workflow and session-pending reminders", () => {
  const dir = newDir();
  const notesDir = newDir();
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(path.join(notesDir, "session-pending.md"), "# Pending\n- item one\n- item two\n");
  writeMarkerWithAge(dir, "feature_x.merge", 45_000, { sessionId: "session-ts1" });
  const r = run(dir, { forceWorkflows: "1", notesDir, env: { CODEX_THREAD_ID: "session-ts1" } });
  assert.equal(r.code, 0);
  const msg = r.json?.systemMessage || "";
  assert.match(msg, /session-pending/, "should mention session-pending");
  assert.match(msg, /2/, "should include count of pending items");
  assert.match(msg, /merge/, "should mention merge");
  assert.match(msg, /AI action reminder \(not a user prompt\)/);
  assert.match(msg, /Next AI action/);
  assert.doesNotMatch(msg, /要不要/);
});

// TS2: 無 workflow 仍發 session-pending（繞過 R2）
test("TS2: no workflow → still emits session-pending reminder (bypasses R2)", () => {
  const dir = newDir();
  const notesDir = newDir();
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(path.join(notesDir, "session-pending.md"), "- task alpha\n- task beta\n");
  writeMarkerWithAge(dir, "feature_x.merge", 45_000, { sessionId: "session-ts2" });
  const r = run(dir, { forceWorkflows: "0", notesDir, env: { CODEX_THREAD_ID: "session-ts2" } });
  assert.equal(r.code, 0);
  const msg = r.json?.systemMessage || "";
  assert.ok(msg.trim().length > 0, "should emit something even without workflows");
  assert.match(msg, /session-pending/, "should contain session-pending reminder");
  assert.match(msg, /AI action reminder \(not a user prompt\)/);
  assert.doesNotMatch(msg, /要不要/);
  // workflow-watch 段不應出現（R2 skip）
  assert.doesNotMatch(msg, /track-postmerge-workflows\.mjs/, "workflow-watch line should not appear");
});

// TS3: push-only 不觸發 session-pending
test("TS3: push-only marker → no session-pending reminder (merge kind required)", () => {
  const dir = newDir();
  const notesDir = newDir();
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(path.join(notesDir, "session-pending.md"), "- waiting task\n");
  writeMarkerWithAge(dir, "feature_x.push", 45_000);
  const r = run(dir, { forceWorkflows: "0", notesDir });
  assert.equal(r.code, 0);
  const msg = r.stdout.trim();
  // forceWorkflows="0" → workflow 段 skip；push-only → session-pending 不觸發
  // 整體應無輸出
  assert.equal(msg, "", "push-only should not trigger session-pending reminder");
});

// TS4: session-pending.md 存在但無 list-item → 不誤報
test("TS4: session-pending.md with no list items → no session-pending reminder", () => {
  const dir = newDir();
  const notesDir = newDir();
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(path.join(notesDir, "session-pending.md"), "# Session Pending\n\nNo items yet.\n");
  writeMarkerWithAge(dir, "feature_x.merge", 45_000);
  const r = run(dir, { forceWorkflows: "0", notesDir });
  assert.equal(r.code, 0);
  const msg = r.stdout.trim();
  // forceWorkflows="0" + no list items → nothing emitted
  assert.equal(msg, "", "no output when session-pending.md has no list items");
});

// TS5: session-pending.md 不存在 → fail-open，不 crash，workflow 提醒正常運作
test("TS5: session-pending.md missing → fail-open, workflow reminder still works", () => {
  const dir = newDir();
  const notesDir = newDir();
  mkdirSync(notesDir, { recursive: true });
  // 不寫 session-pending.md
  writeMarkerWithAge(dir, "feature_x.merge", 45_000);
  const r = run(dir, { forceWorkflows: "1", notesDir });
  assert.equal(r.code, 0, "should not crash");
  const msg = r.json?.systemMessage || "";
  assert.match(msg, /Post-merge|track-postmerge-workflows\.mjs/, "workflow reminder should still fire");
  assert.doesNotMatch(msg, /session-pending/, "no session-pending line when file is missing");
});

// TS6: unrelated branch/session merge marker 不觸發 session-pending
test("TS6: unrelated merge marker → no session-pending reminder", () => {
  const dir = newDir();
  const notesDir = newDir();
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(path.join(notesDir, "session-pending.md"), "- waiting task\n");
  writeMarkerWithAge(dir, "feature_other.merge", 45_000, { sessionId: "old-session" });
  const r = run(dir, {
    forceWorkflows: "0",
    notesDir,
    env: { CODEX_THREAD_ID: "current-session" },
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "", "unrelated marker must not trigger session-pending");
});

// TS7: current-session PR merge marker still applies when merged from another checkout branch
test("TS7: current-session merge marker → emits even when current branch differs", () => {
  const dir = newDir();
  const notesDir = newDir();
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(path.join(notesDir, "session-pending.md"), "- waiting task\n");
  writeMarkerWithAge(dir, "chore_pr-head.merge", 45_000, {
    branch: "chore/pr-head",
    prNumber: "1345",
    sessionId: "current-session",
  });
  const r = run(dir, {
    forceWorkflows: "0",
    notesDir,
    env: { CODEX_THREAD_ID: "current-session" },
  });
  assert.equal(r.code, 0);
  assert.match(r.json?.systemMessage || "", /session-pending/);
});

// --- Completion-side nudge tests (strengthen-session-pending-completion-nudge) ---

// TC1: merged branch matches a claimed entry → completion nudge naming the entry,
// instructing full deletion, citing session-pending-lifecycle.md.
test("TC1: merged branch matching claimed entry → emits completion delete nudge", () => {
  const dir = newDir();
  const notesDir = newDir();
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(
    path.join(notesDir, "session-pending.md"),
    "- Fix widget rendering bug\n  claimed: strengthen-session-pending-completion-nudge\n"
  );
  writeMarkerWithAge(dir, "chore_strengthen-session-pending-completion-nudge.merge", 45_000, {
    branch: "chore/strengthen-session-pending-completion-nudge",
    sessionId: "session-tc1",
  });
  const r = run(dir, {
    forceWorkflows: "0",
    notesDir,
    env: { CODEX_THREAD_ID: "session-tc1" },
  });
  assert.equal(r.code, 0);
  const msg = r.json?.systemMessage || "";
  assert.match(
    msg,
    /strengthen-session-pending-completion-nudge/,
    "should name the claimed change entry"
  );
  assert.match(msg, /整條刪除/, "should instruct full-entry deletion");
  assert.match(
    msg,
    /session-pending-lifecycle/,
    "should cite session-pending-lifecycle.md"
  );
});

// TC2: no claimed entry resolves to the merged branch → generic count reminder unchanged,
// no completion nudge emitted.
test("TC2: no matching claimed entry → generic reminder only, no completion nudge", () => {
  const dir = newDir();
  const notesDir = newDir();
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(
    path.join(notesDir, "session-pending.md"),
    "- Some other pending task\n  claimed: unrelated-change\n"
  );
  writeMarkerWithAge(dir, "chore_x.merge", 45_000, {
    branch: "chore/x",
    sessionId: "session-tc2",
  });
  const r = run(dir, {
    forceWorkflows: "0",
    notesDir,
    env: { CODEX_THREAD_ID: "session-tc2" },
  });
  assert.equal(r.code, 0);
  const msg = r.json?.systemMessage || "";
  assert.match(msg, /session-pending/, "generic reminder should still fire");
  assert.doesNotMatch(msg, /整條刪除/, "no completion nudge when no claimed entry matches");
  assert.doesNotMatch(
    msg,
    /unrelated-change/,
    "unrelated claimed change name must not appear"
  );
});

// ── Post-merge Local Sync reminder (git-workflow-tracking.md §Post-merge Local Sync) ─────────────────────────────
// `gh pr merge` lands the merge commit on the remote only; the main checkout's local `main` stays behind until it
// is pulled. The Stop hook checks that locally (no fetch, no gh): the PR's merge commit is on local `main` or it is not.

function gitIn(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeMainCheckout({ mergedPr = null } = {}) {
  const dir = newDir();
  mkdirSync(dir, { recursive: true });
  gitIn(dir, ["init", "-q", "-b", "main"]);
  gitIn(dir, ["config", "user.email", "t@example.invalid"]);
  gitIn(dir, ["config", "user.name", "t"]);
  gitIn(dir, ["config", "commit.gpgsign", "false"]);
  gitIn(dir, ["commit", "-q", "--allow-empty", "-m", "initial"]);
  if (mergedPr !== null) {
    gitIn(dir, ["commit", "-q", "--allow-empty", "-m", `Merge pull request #${mergedPr} from devpro-tw/feature/x`]);
  }
  return dir;
}

// Markers default to a `main`-target merge (the case the reminder is for); a test overrides baseRefName to change it.
function runSync(mainDir, markerName, markerData, { sessionEnv = "session-sync" } = {}) {
  const markerDir = newDir();
  writeMarkerWithAge(markerDir, markerName, 45_000, { baseRefName: "main", ...markerData });
  return run(markerDir, {
    forceWorkflows: "0",
    notesDir: newDir(),
    cwd: mainDir,
    env: { CODEX_THREAD_ID: sessionEnv, DEVPRO_POST_PR_COMPLETION_SESSION_ID: sessionEnv },
  });
}

test("Local Sync: a merged PR whose merge commit is not on local main gets a sync reminder naming the main checkout", () => {
  const mainDir = makeMainCheckout();
  const r = runSync(mainDir, "feature_x.merge", { branch: "feature/x", prNumber: "123", sessionId: "session-sync" });
  assert.equal(r.code, 0);
  const msg = r.json?.systemMessage || "";
  assert.match(msg, /Post-merge Local Sync/);
  assert.match(msg, /PR #123/);
  // The hook reports the resolved main checkout root (macOS tmpdir is a symlink: /var → /private/var).
  const resolved = realpathSync(mainDir);
  assert.ok(msg.includes(`git -C ${resolved} pull --ff-only origin main`), `must name the main checkout form: ${msg}`);
  assert.match(msg, /log main\.\.origin\/main --oneline/);
});

test("Local Sync: no reminder once the PR's merge commit is on local main", () => {
  const mainDir = makeMainCheckout({ mergedPr: 123 });
  const r = runSync(mainDir, "feature_x.merge", { branch: "feature/x", prNumber: "123", sessionId: "session-sync" });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.json?.systemMessage || "", /Post-merge Local Sync/);
});

test("Local Sync: another PR's merge commit does not count, in either prefix direction (#12 vs #123)", () => {
  const shorter = makeMainCheckout({ mergedPr: 12 });
  const r1 = runSync(shorter, "feature_x.merge", { branch: "feature/x", prNumber: "123", sessionId: "session-sync" });
  assert.match(r1.json?.systemMessage || "", /Post-merge Local Sync.*PR #123/s);
  // The reverse is the one a missing delimiter after the number would get wrong: #123 on main must not satisfy #12.
  const longer = makeMainCheckout({ mergedPr: 123 });
  const r2 = runSync(longer, "feature_x.merge", { branch: "feature/x", prNumber: "12", sessionId: "session-sync" });
  assert.match(r2.json?.systemMessage || "", /Post-merge Local Sync.*PR #12（/s);
});

test("Local Sync: a merge marker without a PR number cannot be checked, so it says nothing about sync", () => {
  const mainDir = makeMainCheckout();
  const r = runSync(mainDir, "feature_x.merge", { branch: "feature/x", prNumber: "", sessionId: "session-sync" });
  assert.doesNotMatch(r.json?.systemMessage || "", /Post-merge Local Sync/);
});

test("Local Sync: from a linked worktree the reminder names the main checkout, not the worktree, and clears after the pull", () => {
  const mainDir = makeMainCheckout();
  const worktreeDir = newDir();
  gitIn(mainDir, ["worktree", "add", "-q", "-b", "feature/x", worktreeDir]);
  const mainRoot = realpathSync(mainDir);
  const marker = { branch: "feature/x", prNumber: "123", sessionId: "session-sync" };

  const before = runSync(worktreeDir, "feature_x.merge", marker);
  const msg = before.json?.systemMessage || "";
  assert.ok(msg.includes(`git -C ${mainRoot} pull --ff-only origin main`), `must target the main checkout: ${msg}`);
  assert.ok(!msg.includes(`git -C ${realpathSync(worktreeDir)} pull`), "must not tell the worktree to pull main");

  // What the pull would bring: the merge commit lands on the main checkout's `main`.
  gitIn(mainDir, ["commit", "-q", "--allow-empty", "-m", "Merge pull request #123 from devpro-tw/feature/x"]);
  const after = runSync(worktreeDir, "feature_x.merge", marker);
  assert.doesNotMatch(after.json?.systemMessage || "", /Post-merge Local Sync/);
});

test("Local Sync: a commit that only mentions the PR (a revert of its merge) is not the merge commit", () => {
  const mainDir = makeMainCheckout();
  gitIn(mainDir, ["commit", "-q", "--allow-empty", "-m", 'Revert "Merge pull request #123 from devpro-tw/feature/x"']);
  const r = runSync(mainDir, "feature_x.merge", { branch: "feature/x", prNumber: "123", sessionId: "session-sync" });
  assert.match(r.json?.systemMessage || "", /Post-merge Local Sync.*PR #123/s);
});

test("Local Sync: a merge into production or a release branch is never on local main, so it stays silent", () => {
  const mainDir = makeMainCheckout();
  for (const baseRefName of ["production", "release/v6.99.0"]) {
    const r = runSync(mainDir, "feature_x.merge", { branch: "feature/x", prNumber: "123", sessionId: "session-sync", baseRefName });
    assert.doesNotMatch(r.json?.systemMessage || "", /Post-merge Local Sync/, `${baseRefName} target must not remind`);
  }
});

test("Local Sync: a marker that does not record its merge target cannot be judged, so it says nothing", () => {
  const mainDir = makeMainCheckout();
  const r = runSync(mainDir, "feature_x.merge", { branch: "feature/x", prNumber: "123", sessionId: "session-sync", baseRefName: undefined });
  assert.doesNotMatch(r.json?.systemMessage || "", /Post-merge Local Sync/);
});

test("Local Sync: a push marker is not a merge and does not trigger the sync reminder", () => {
  const mainDir = makeMainCheckout();
  const r = runSync(mainDir, "feature_x.push", { branch: "feature/x", prNumber: "123", sessionId: "session-sync" });
  assert.doesNotMatch(r.json?.systemMessage || "", /Post-merge Local Sync/);
});

test("Local Sync: a merge made by another session is not this session's to sync", () => {
  const mainDir = makeMainCheckout();
  const r = runSync(mainDir, "feature_x.merge", { branch: "feature/x", prNumber: "123", sessionId: "someone-else" });
  assert.doesNotMatch(r.json?.systemMessage || "", /Post-merge Local Sync/);
});

test("Local Sync: a repository without a local main says nothing instead of guessing", () => {
  const dir = newDir();
  mkdirSync(dir, { recursive: true });
  gitIn(dir, ["init", "-q", "-b", "trunk"]);
  gitIn(dir, ["config", "user.email", "t@example.invalid"]);
  gitIn(dir, ["config", "user.name", "t"]);
  gitIn(dir, ["config", "commit.gpgsign", "false"]);
  gitIn(dir, ["commit", "-q", "--allow-empty", "-m", "initial"]);
  const r = runSync(dir, "feature_x.merge", { branch: "feature/x", prNumber: "123", sessionId: "session-sync" });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.json?.systemMessage || "", /Post-merge Local Sync/);
});

// ── Repository-keyed markers (fix-cross-repo-state-keys) ──────────────────────────────────────────────────────────

function makeHubCheckout() {
  const dir = makeMainCheckout();
  gitIn(dir, ["remote", "add", "origin", "https://github.com/owner/hub.git"]);
  return dir;
}

test("Repo keys: a merge of another repository is named with its repository and PR, and never gets the local-main sync reminder", () => {
  const hub = makeHubCheckout();
  const r = runSync(hub, "github.com+owner+target#5.merge", { branch: "feature/x", prNumber: "5", repo: "github.com/owner/target", sessionId: "session-sync" }, {});
  assert.equal(r.code, 0);
  const msg = r.json?.systemMessage || "";
  assert.doesNotMatch(msg, /Post-merge Local Sync/, "another repository's merge commit is never on this checkout's main");
  const markerDir = newDir();
  writeMarkerWithAge(markerDir, "github.com+owner+target#5.merge", 45_000, { branch: "feature/x", prNumber: "5", repo: "github.com/owner/target" });
  const named = run(markerDir, { cwd: hub, notesDir: newDir() });
  assert.match(named.json?.systemMessage || "", /github\.com\/owner\/target#5 feature\/x\(merge\)/);
  assert.match(named.json?.systemMessage || "", /--repo github\.com\/OWNER\/REPO/);
});

test("Repo keys: a merge of the session checkout's own repository still gets the local-main sync reminder", () => {
  const hub = makeHubCheckout();
  const r = runSync(hub, "github.com+owner+hub#123.merge", { branch: "feature/x", prNumber: "123", repo: "github.com/owner/hub", sessionId: "session-sync" });
  assert.match(r.json?.systemMessage || "", /Post-merge Local Sync.*PR #123/s);
});

test("Repo keys: a merge marker whose head branch was not found keeps its repository and PR and is still reminded (PR #3703 r11 W3-F2)", () => {
  const hub = makeHubCheckout();
  const markerDir = newDir();
  mkdirSync(markerDir, { recursive: true });
  const p = path.join(markerDir, "github.com+owner+target#5.merge");
  writeFileSync(p, JSON.stringify({ branch: "", headRefName: "", baseRefName: "", kind: "merge", prNumber: "5", repo: "github.com/owner/target" }));
  const t = (Date.now() - 45_000) / 1000;
  utimesSync(p, t, t);
  const r = run(markerDir, { cwd: hub, notesDir: newDir() });
  assert.match(r.json?.systemMessage || "", /github\.com\/owner\/target#5\(merge\)/);
  assert.ok(existsSync(p));
});

test("Repo keys: the session's own merge marker names its PR, also when its head branch was not found (#3704 r6 F4)", () => {
  const hub = makeHubCheckout();
  const markerDir = newDir();
  mkdirSync(markerDir, { recursive: true });
  const noHead = path.join(markerDir, "github.com+owner+hub#7.merge");
  writeFileSync(noHead, JSON.stringify({ branch: "", headRefName: "", baseRefName: "", kind: "merge", prNumber: "7", repo: "github.com/owner/hub" }));
  const t = (Date.now() - 45_000) / 1000;
  utimesSync(noHead, t, t);
  writeMarkerWithAge(markerDir, "github.com+owner+hub#8.merge", 45_000, { branch: "feature/y", prNumber: "8", repo: "github.com/owner/hub" });
  const message = run(markerDir, { cwd: hub, notesDir: newDir() }).json?.systemMessage || "";
  assert.match(message, /(?<![\w/])#7\(merge\)/);
  assert.match(message, /#8 feature\/y\(merge\)/);
});

test("Repo keys: a marker whose repository is not written in lowercase is not a marker the hook wrote (#3704 r6 F6)", async () => {
  const { parsePostmergeMarker } = await import("../hooks/lib/postmerge-marker.mjs");
  const marker = (repo) => JSON.stringify({ kind: "merge", branch: "", prNumber: "5", repo });
  assert.equal(parsePostmergeMarker(marker("github.com/owner/target"), "github.com+owner+target#5.merge")?.repo, "github.com/owner/target");
  for (const repo of ["github.com/Owner/Target", "GitHub.com/owner/target"]) {
    assert.equal(parsePostmergeMarker(marker(repo), "github.com+owner+target#5.merge"), null, repo);
  }
});

test("Repo keys: another repository's merge of a branch named like the current branch is not this session's to report", () => {
  const hub = makeHubCheckout();
  const notesDir = newDir();
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(path.join(notesDir, "session-pending.md"), "# Pending\n- item one\n");
  const markerDir = newDir();
  // The hub checkout is on main; a merge of another repository's `main` head is not the hub's.
  writeMarkerWithAge(markerDir, "github.com+owner+target#5.merge", 45_000, { branch: "main", prNumber: "5", repo: "github.com/owner/target", sessionId: "other-session" });
  const r = run(markerDir, { cwd: hub, notesDir, forceWorkflows: "0", env: { CODEX_THREAD_ID: "this-session", DEVPRO_POST_PR_COMPLETION_SESSION_ID: "this-session" } });
  assert.doesNotMatch(r.json?.systemMessage || "", /session-pending/);
  const own = newDir();
  writeMarkerWithAge(own, "main.merge", 45_000, { branch: "main", prNumber: "5", sessionId: "other-session" });
  const control = run(own, { cwd: hub, notesDir, forceWorkflows: "0", env: { CODEX_THREAD_ID: "this-session", DEVPRO_POST_PR_COMPLETION_SESSION_ID: "this-session" } });
  assert.match(control.json?.systemMessage || "", /session-pending/, "the same marker of the hub's own repository is reported");
});

// #3704 r1 F4 (user decision Q1-1): the session checkout's .github/workflows says nothing about another repository, so
// another repository's marker is always reminded, while the hub's own marker still follows the hub's workflows.
test("Repo keys: another repository's marker is reminded from a hub without workflows; the hub's own is not", () => {
  const hub = makeHubCheckout();
  const markerDir = newDir();
  writeMarkerWithAge(markerDir, "github.com+owner+target#5.merge", 45_000, { branch: "feature/x", prNumber: "5", baseRefName: "main", repo: "github.com/owner/target" });
  writeMarkerWithAge(markerDir, "feature_own.push", 45_000, { branch: "feature/own" });
  const r = run(markerDir, { cwd: hub, notesDir: newDir(), forceWorkflows: "0" });
  const msg = r.json?.systemMessage || "";
  assert.match(msg, /github\.com\/owner\/target#5 feature\/x\(merge\)/);
  assert.doesNotMatch(msg, /feature\/own/, "the hub's own marker follows the hub's workflows");
  assert.doesNotMatch(msg, /Post-merge Local Sync/);
});

// #3704 r1 F4: when the session checkout's own repository cannot be read, no marker is known to be another repository's.
test("Repo keys: without a readable session origin a marker that records a repository is not treated as another's", () => {
  const mainDir = makeMainCheckout();
  const r = runSync(mainDir, "github.com+owner+target#123.merge", { branch: "feature/x", prNumber: "123", repo: "github.com/owner/target", sessionId: "session-sync" });
  const msg = r.json?.systemMessage || "";
  assert.match(msg, /Post-merge Local Sync.*PR #123/s);
  assert.doesNotMatch(msg, /github\.com\/owner\/target#123/);
});

// #3704 r2 F2 (user decision Q1-1): a merge marker whose writer could not prove its repository is reminded as of an
// unknown repository from a hub without workflows, never counts as the hub's, and stays until it expires.
// fix-unknown-push-reminder-repeat: a push marker of an unknown repository (written by #3704) is not reminded, since no
// query clears it; it is removed once it is stale.
test("Repo keys: a repo_unknown merge marker is reminded as of an unknown repository; a repo_unknown push marker is not", () => {
  const hub = makeHubCheckout();
  const markerDir = newDir();
  mkdirSync(markerDir, { recursive: true });
  const merge = path.join(markerDir, "unknown__fedcba9876543210fedcba9876543210.merge");
  writeFileSync(merge, JSON.stringify({ branch: "feature/m", headRefName: "feature/m", baseRefName: "", kind: "merge", prNumber: "", repo_unknown: true }));
  const p = path.join(markerDir, "unknown__0123456789abcdef0123456789abcdef.push");
  writeFileSync(p, JSON.stringify({ branch: "feature/x", headRefName: "feature/x", baseRefName: "", kind: "push", prNumber: "", repo_unknown: true }));
  const t = (Date.now() - 45_000) / 1000;
  utimesSync(merge, t, t);
  utimesSync(p, t, t);
  for (const forceWorkflows of ["0", "1"]) {
    const msg = run(markerDir, { cwd: hub, notesDir: newDir(), forceWorkflows }).json?.systemMessage || "";
    assert.match(msg, /repo 不明 feature\/m\(merge\)/, `workflows=${forceWorkflows}`);
    assert.match(msg, /1 小時後自動到期/);
    assert.doesNotMatch(msg, /feature\/x/, `workflows=${forceWorkflows}: an unknown push is not reminded`);
  }
  assert.ok(existsSync(p), "an unknown push marker stays until it is stale");
  const stale = (Date.now() - 61 * 60_000) / 1000;
  utimesSync(p, stale, stale);
  run(markerDir, { cwd: hub, notesDir: newDir() });
  assert.ok(!existsSync(p), "a stale unknown push marker is removed");
  // A marker that says both repo and repo_unknown is unreadable: not reminded, kept until stale.
  writeFileSync(p, JSON.stringify({ branch: "feature/x", kind: "push", repo: "github.com/owner/hub", repo_unknown: true }));
  utimesSync(p, t, t);
  assert.doesNotMatch(run(markerDir, { cwd: hub, notesDir: newDir() }).json?.systemMessage || "", /feature\/x/);
  assert.ok(existsSync(p));
});
