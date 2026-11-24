/**
 * hook-pre-tool-gate-lite-scope.test.mjs
 *
 * Gate R1 (general-mode) and Gate SP (session-pending) behaviour for the
 * remove-second-review-disclosure-approval and
 * remove-second-review-disclosure-framework changes:
 *   - retired ledger items block through the shared
 *     `evaluateBatchApprovalLedgerIdentity` and the fix is removal-only
 *     (design.md D3, framework change D4);
 *   - the one-line untracked `openspec/changes/<change>/lite-scope.md` record is
 *     the lite carrier of the Step 0 batch conclusion (design.md D5).
 *
 * The gate is driven in-process through `evaluatePreToolUsePayload` (same
 * strategy as hook-pre-tool-gate.test.mjs) against throwaway git repos, so every
 * other write gate also sees the payload.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { evaluatePreToolUsePayload, PASS_THROUGH } from "../hooks/pre-tool-gate.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const tmpRoot = makeTempDir("pre-tool-gate-lite-scope-");
after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const PREFLIGHT_FIXTURE = [
  "# preflight",
  "",
  "<!-- branch-verb-whitelist:start -->",
  "- `add` — 新增功能",
  "- `fix` — 修 bug",
  "- `refactor` — 不變行為重整",
  "- `remove` — 移除",
  "- `migrate` — 切換技術棧",
  "- `update` — 同一依賴升新版",
  "- `docs` — 純文件",
  "- `amend` — 修規範既有 requirement",
  "- `strengthen` — 補既有規則漏洞",
  "- `wire` — 啟用既有設計",
  "- `clarify` — 澄清既有規則語意",
  "- `enforce` — 把既有規則上升為強制 gate",
  "<!-- branch-verb-whitelist:end -->",
  "",
  "<!-- rules-source-whitelist:start -->",
  "- `agent-rules` — devpro-agent-rules submodule（規範同步）",
  "<!-- rules-source-whitelist:end -->",
  "",
].join("\n");

let repoCounter = 0;

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

function setupRepo(branch) {
  const dir = path.join(tmpRoot, `repo-${repoCounter++}`);
  mkdirSync(path.join(dir, ".devpro/agent-rules"), { recursive: true });
  git(dir, ["init", "-q", "-b", branch]);
  git(dir, ["config", "user.email", "t@t.com"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(path.join(dir, "x"), "");
  writeFileSync(path.join(dir, ".devpro/agent-rules/preflight-checklist.md"), PREFLIGHT_FIXTURE);
  git(dir, ["add", "x"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function setupRepoWithWorktree(branch) {
  const repo = setupRepo("main");
  const wt = path.join(tmpRoot, `wt-${repoCounter++}`);
  git(repo, ["worktree", "add", "-q", "-b", branch, wt, "HEAD"]);
  return { repo, wt };
}

const MOCK_ENV_KEYS = [
  "CODEX_CI",
  "CODEX_THREAD_ID",
  "DEVPRO_SENTINEL_STATE_DIR",
  "PWD",
  "CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT",
  "CROSS_MODEL_MERGE_GATE_MOCK_BRANCH",
  "CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES",
  "DEVPRO_POSTMERGE_STATE_DIR",
  "DEVPRO_RECAP_PENDING_DIR",
];

// Returns the gate's block `reason` (string) or null when the write passes (no block, no advisory).
function gateVerdict(payload, cwd, branch) {
  const stateDirs = [makeTempDir("sentinel-"), makeTempDir("postmerge-"), makeTempDir("recap-")];
  const saved = Object.fromEntries(MOCK_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, {
      CODEX_CI: "",
      CODEX_THREAD_ID: "",
      DEVPRO_SENTINEL_STATE_DIR: stateDirs[0],
      PWD: cwd,
      CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({ comments: [], headRefOid: "a".repeat(40), headRefName: branch }),
      CROSS_MODEL_MERGE_GATE_MOCK_BRANCH: branch,
      CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: "",
      DEVPRO_POSTMERGE_STATE_DIR: stateDirs[1],
      DEVPRO_RECAP_PENDING_DIR: stateDirs[2],
    });
    const result = evaluatePreToolUsePayload({ ...payload, cwd });
    if (!result || result === PASS_THROUGH) return null;
    if (result.block) return result.reason;
    return null;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of stateDirs) rmSync(dir, { recursive: true, force: true });
  }
}

function implementationWrite(root) {
  return { tool_name: "Write", tool_input: { file_path: path.join(root, ".devpro/scripts/hooks/pre-tool-gate.mjs"), content: "implementation write\n" } };
}

function changeFile(root, changeName, name) {
  return path.join(root, "openspec", "changes", changeName, name);
}

function writeChangeFile(root, changeName, name, content) {
  const file = changeFile(root, changeName, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function writeSessionPendingClaim(root, changeName) {
  mkdirSync(path.join(root, "notes"), { recursive: true });
  writeFileSync(
    path.join(root, "notes", "session-pending.md"),
    [
      `- Formalize ${changeName}`,
      `  - claimed: ${changeName}`,
      `  - approval: 2026-10-05 user authorized batch approval through PR merge for ${changeName}`,
      "",
    ].join("\n"),
  );
}

function renderList(key, items, style) {
  if (style === "flow") return [`${key}: [${items.join(", ")}]`];
  return [`${key}:`, ...items.map((item) => `  - ${item}`)];
}

const LEGAL_COVERS = ["worktree", "local_commit", "first_push"];
const LEGAL_EXCLUDES = ["merge", "release"];

function ledgerBody(changeName, branch, { covers = LEGAL_COVERS, excludes = LEGAL_EXCLUDES, style = "block" } = {}) {
  return [
    "kind: same-change-dp-change-batch",
    `named_change: ${changeName}`,
    `branch: ${branch}`,
    "repo_scope: same-repo",
    ...renderList("covers", covers, style),
    ...renderList("excludes", excludes, style),
  ].join("\n");
}

function writeProposalMini(root, changeName, ledger) {
  return writeChangeFile(
    root,
    changeName,
    "proposal-mini.md",
    [`# Proposal: ${changeName}`, "", "## Why", "", "test fixture", "", "## Batch Approval Ledger", "", ledger.trim(), ""].join("\n"),
  );
}

const LITE_COVERS = "worktree,local_commit,pre_pr_gate,first_push,pr_create_update,workflow_watch,post_pr_completion_gate,scenario_walkthrough";
const LITE_EXCLUDES = "merge,release,destructive,secrets,cross_repo_write";

function liteLine(changeName, branch, { covers = LITE_COVERS, excludes = LITE_EXCLUDES } = {}) {
  return `kind=same-change-dp-change-batch; named_change=${changeName}; branch=${branch}; repo_scope=same-repo; covers=${covers}; excludes=${excludes}`;
}

function writeLiteRecord(root, changeName, content) {
  return writeChangeFile(root, changeName, "lite-scope.md", content);
}

// A fresh lite change (no proposal carrier) on feature/<name>; returns the repo and identity.
let nameCounter = 0;
function liteChange(prefix) {
  const changeName = `${prefix}-${nameCounter++}`;
  const branch = `feature/${changeName}`;
  return { changeName, branch, repo: setupRepo(branch) };
}

const RECORD_FIX_HINT = /照模板重寫該行，或刪除檔案回到逐步詢問/;

// ---------------------------------------------------------------------------
// Retired ledger items (Gate R1 and Gate SP share the identity check)
// ---------------------------------------------------------------------------

const LEGACY_TOKENS = [
  "same_repo_exact_pr_external_disclosure",
  "reviewer_sticky_write_back",
  "reviewer_owned_sticky_write_back",
  "external_disclosure",
];

function legacyReasonTokens(reason) {
  const match = /has retired ledger item\(s\) `([^`]+)` in `covers`\/`excludes`/.exec(reason);
  assert.ok(match, `reason must carry the retired-item diagnostic, got: ${reason}`);
  return match[1].split(", ");
}

function assertRetiredMessage(reason) {
  assert.ok(reason.includes("retired item; delete it"), reason);
  assert.match(reason, /retired/);
  assert.match(reason, /delete/);
  assert.doesNotMatch(reason, /adopt/i);
  assert.ok(!reason.includes("consumer-adoption.md"), reason);
}

function removeNamedItems(body, names) {
  return body.split("\n").flatMap((line) => {
    const block = /^[\t ]+-[\t ]+(\S.*?)[\t ]*$/.exec(line);
    if (block) return names.includes(block[1]) ? [] : [line];
    const flow = /^(covers|excludes):[\t ]*\[([^\]]*)\][\t ]*$/.exec(line);
    if (flow) {
      const kept = flow[2].split(",").map((entry) => entry.trim()).filter((entry) => entry && !names.includes(entry));
      return [`${flow[1]}: [${kept.join(", ")}]`];
    }
    return [line];
  }).join("\n");
}

function legacyProposal({ prefix, covers, excludes, style, claimed = false }) {
  const changeName = `${prefix}-${nameCounter++}`;
  const branch = `feature/${changeName}`;
  const repo = setupRepo(branch);
  if (claimed) writeSessionPendingClaim(repo, changeName);
  const body = ledgerBody(changeName, branch, { covers, excludes, style });
  const proposal = writeProposalMini(repo, changeName, body);
  return { changeName, branch, repo, body, proposal };
}

test("Legacy disclosure item in a block-style list blocks the write: Gate R1 names the item and tells the TL to delete just its `- <item>` line", () => {
  const { repo, branch } = legacyProposal({
    prefix: "r1-legacy-block",
    covers: ["worktree", "same_repo_exact_pr_external_disclosure", "local_commit"],
    style: "block",
  });
  const reason = gateVerdict(implementationWrite(repo), repo, branch);
  assert.ok(reason, "Gate R1 must block");
  assert.match(reason, /Gate R1 \(General-mode Batch Approval Ledger Prewrite\)/);
  assert.deepEqual(legacyReasonTokens(reason), ["same_repo_exact_pr_external_disclosure"]);
  assert.ok(reason.includes("delete just the `- <item>` lines"), reason);
  assert.ok(reason.includes("keep every other item"), reason);
});

test("Legacy disclosure item in a block-style list blocks the write: each of the four tokens blocks in a block-style covers or excludes list", () => {
  for (const token of LEGACY_TOKENS) {
    for (const key of ["covers", "excludes"]) {
      const lists = key === "covers"
        ? { covers: ["worktree", token, "local_commit"] }
        : { excludes: ["merge", token] };
      const { repo, branch } = legacyProposal({ prefix: "r1-legacy-block-each", ...lists, style: "block" });
      const reason = gateVerdict(implementationWrite(repo), repo, branch);
      assert.ok(reason, `${token} in block-style ${key} must block`);
      assert.deepEqual(legacyReasonTokens(reason), [token], `${token} in ${key}`);
    }
  }
});

test("Legacy disclosure item in a flow-style list blocks the write: a flow excludes naming external_disclosure is blocked and the TL is told to delete just that name", () => {
  const { repo, branch } = legacyProposal({
    prefix: "r1-legacy-flow",
    excludes: ["merge", "release", "external_disclosure"],
    style: "flow",
  });
  const reason = gateVerdict(implementationWrite(repo), repo, branch);
  assert.ok(reason, "Gate R1 must block");
  assert.deepEqual(legacyReasonTokens(reason), ["external_disclosure"]);
  assert.ok(reason.includes("flow list `[a, b]`: delete just those names inside the brackets, never the whole `covers`/`excludes` line"), reason);
});

test("Legacy disclosure item in a flow-style list blocks the write: a flow covers mixing legal actions with a legacy token blocks the same way", () => {
  const { repo, branch } = legacyProposal({
    prefix: "r1-legacy-flow-mixed",
    covers: ["worktree", "reviewer_sticky_write_back", "local_commit"],
    style: "flow",
  });
  const reason = gateVerdict(implementationWrite(repo), repo, branch);
  assert.ok(reason, "Gate R1 must block");
  assert.deepEqual(legacyReasonTokens(reason), ["reviewer_sticky_write_back"]);
});

test("Legacy disclosure token match ignores case and hyphens: a Reviewer-Sticky-Write-Back item is blocked and named as written", () => {
  const { repo, branch } = legacyProposal({
    prefix: "r1-legacy-case",
    covers: ["worktree", "Reviewer-Sticky-Write-Back", "local_commit"],
    style: "block",
  });
  const reason = gateVerdict(implementationWrite(repo), repo, branch);
  assert.ok(reason, "Gate R1 must block");
  assert.deepEqual(legacyReasonTokens(reason), ["Reviewer-Sticky-Write-Back"]);
  assert.ok(!reason.includes("reviewer_sticky_write_back"), "the normalized form must not replace the ledger's spelling");
});

test("Retired ledger item message says to delete it", () => {
  const { repo, branch } = legacyProposal({
    prefix: "r1-legacy-message",
    covers: ["worktree", "external_disclosure"],
    style: "block",
  });
  const reason = gateVerdict(implementationWrite(repo), repo, branch);
  assert.ok(reason, "Gate R1 must block");
  assertRetiredMessage(reason);
});

test("Retired ledger item message says to delete it: Gate SP carries the same diagnostic", () => {
  const { repo, branch } = legacyProposal({
    prefix: "sp-legacy-message",
    covers: ["worktree", "external_disclosure"],
    style: "block",
    claimed: true,
  });
  const reason = gateVerdict(implementationWrite(repo), repo, branch);
  assert.ok(reason, "Gate SP must block");
  assert.match(reason, /Gate SP \(Session Pending Batch Approval Ledger\)/);
  assertRetiredMessage(reason);
});

test("A retired item listed under excludes is reported as an earlier refusal in Gate R1 and Gate SP, and the fix stays removal-only", () => {
  for (const claimed of [false, true]) {
    const { repo, branch } = legacyProposal({
      prefix: "legacy-earlier-refusal",
      excludes: ["merge", "external_disclosure"],
      style: "block",
      claimed,
    });
    const reason = gateVerdict(implementationWrite(repo), repo, branch);
    assert.ok(reason, `claimed=${claimed}: must block`);
    assert.ok(reason.includes("`external_disclosure` was listed under `excludes`, an earlier explicit refusal"), reason);
    assert.ok(reason.includes("tell the user in the same reply"), reason);
    assert.ok(reason.includes("ordinary AGENTS.local.md rule"), reason);
    assert.ok(reason.includes("waiver path in code-review-cross-model.md §Merge Gate Enforcement"), reason);
    assert.ok(reason.includes("delete just the `- <item>` lines"), reason);
    assertRetiredMessage(reason);
  }
  // A covers-only retired item was never refused: no earlier-refusal notice.
  const { repo, branch } = legacyProposal({ prefix: "legacy-covers-only", covers: ["worktree", "external_disclosure"], style: "block" });
  assert.ok(!gateVerdict(implementationWrite(repo), repo, branch).includes("earlier explicit refusal"));
});

test("Removing only the named legacy items makes the ledger pass: block and flow, covers and excludes, Gate R1 passes once only the named items are removed and nothing else changes", () => {
  for (const style of ["block", "flow"]) {
    for (const key of ["covers", "excludes"]) {
      const token = key === "covers" ? "reviewer_owned_sticky_write_back" : "same_repo_exact_pr_external_disclosure";
      const lists = key === "covers"
        ? { covers: ["worktree", token, "local_commit", "first_push"] }
        : { excludes: ["merge", token, "release"] };
      const { repo, branch, body, proposal } = legacyProposal({ prefix: "r1-legacy-fix", ...lists, style });
      const reason = gateVerdict(implementationWrite(repo), repo, branch);
      assert.ok(reason, `${style} ${key}: must block before the fix`);
      const names = legacyReasonTokens(reason);
      assert.deepEqual(names, [token]);
      // The correction write itself is allowed: it lives under openspec/changes/<change>/.
      const fixedBody = removeNamedItems(body, names);
      const fixedPath = writeProposalMini(repo, path.basename(path.dirname(proposal)), fixedBody);
      assert.equal(gateVerdict(implementationWrite(repo), repo, branch), null, `${style} ${key}: must pass after removal`);
      const saved = readFileSync(fixedPath, "utf8");
      for (const kept of [...LEGAL_COVERS, ...LEGAL_EXCLUDES]) assert.ok(saved.includes(kept), `${kept} must remain`);
      assert.ok(!saved.includes(token), "the legacy item must be gone");
    }
  }
});

test("Removing only the named legacy items makes the ledger pass: a flow list that mixes legal actions with legacy tokens keeps its legal actions, in Gate R1 and Gate SP", () => {
  for (const claimed of [false, true]) {
    const { repo, branch, body, proposal } = legacyProposal({
      prefix: "legacy-fix-mixed",
      covers: ["worktree", "reviewer_sticky_write_back", "local_commit"],
      excludes: ["merge", "release", "external_disclosure"],
      style: "flow",
      claimed,
    });
    const reason = gateVerdict(implementationWrite(repo), repo, branch);
    assert.ok(reason, `claimed=${claimed}: must block`);
    const names = legacyReasonTokens(reason);
    assert.deepEqual(names, ["reviewer_sticky_write_back", "external_disclosure"]);
    const fixedBody = removeNamedItems(body, names);
    assert.match(fixedBody, /^covers: \[worktree, local_commit\]$/m);
    assert.match(fixedBody, /^excludes: \[merge, release\]$/m);
    writeProposalMini(repo, path.basename(path.dirname(proposal)), fixedBody);
    assert.equal(gateVerdict(implementationWrite(repo), repo, branch), null, `claimed=${claimed}: must pass after removal`);
  }
});

test("Legacy disclosure item blocks under a claimed batch approval: an excludes entry reviewer_owned_sticky_write_back blocks and the reason carries the shared diagnostic", () => {
  const { repo, branch } = legacyProposal({
    prefix: "sp-legacy-claimed",
    excludes: ["merge", "reviewer_owned_sticky_write_back"],
    style: "block",
    claimed: true,
  });
  const reason = gateVerdict(implementationWrite(repo), repo, branch);
  assert.ok(reason, "Gate SP must block");
  assert.match(reason, /Gate SP \(Session Pending Batch Approval Ledger\)/);
  assert.deepEqual(legacyReasonTokens(reason), ["reviewer_owned_sticky_write_back"]);
  assert.ok(reason.includes("delete just the `- <item>` lines"), reason);
});

// ---------------------------------------------------------------------------
// Lite scope record — Gate R1 (no session-pending claim)
// ---------------------------------------------------------------------------

test("No proposal and no lite record passes", () => {
  const { repo, branch } = liteChange("r1-no-record");
  assert.equal(gateVerdict(implementationWrite(repo), repo, branch), null);
});

test("Matching lite record passes without a proposal", () => {
  const { changeName, branch, repo } = liteChange("r1-match");
  writeLiteRecord(repo, changeName, `${liteLine(changeName, branch)}\n`);
  assert.equal(gateVerdict(implementationWrite(repo), repo, branch), null);
});

test("Matching lite record passes without a proposal: CRLF line ending and no trailing newline are tolerated", () => {
  for (const ending of ["\r\n", ""]) {
    const { changeName, branch, repo } = liteChange("r1-match-ending");
    writeLiteRecord(repo, changeName, `${liteLine(changeName, branch)}${ending}`);
    assert.equal(gateVerdict(implementationWrite(repo), repo, branch), null, JSON.stringify(ending));
  }
});

test("Mismatched lite record blocks the write", () => {
  const { changeName, branch, repo } = liteChange("r1-mismatch");
  writeLiteRecord(repo, changeName, `${liteLine(changeName, "feature/some-other-branch")}\n`);
  const reason = gateVerdict(implementationWrite(repo), repo, branch);
  assert.ok(reason, "Gate R1 must block a mismatched record");
  assert.match(reason, /Gate R1 \(General-mode Batch Approval Ledger Prewrite\)/);
  assert.ok(reason.includes(`openspec/changes/${changeName}/lite-scope.md`), reason);
  assert.match(reason, /branch/);
  assert.match(reason, RECORD_FIX_HINT);
  assert.ok(reason.includes("rewrite the line from the template or delete the file to return to stepwise confirmation"), reason);
});

test("Mismatched lite record blocks the write: a record for another change name blocks too", () => {
  const { changeName, branch, repo } = liteChange("r1-mismatch-name");
  writeLiteRecord(repo, changeName, `${liteLine("some-other-change", branch)}\n`);
  const reason = gateVerdict(implementationWrite(repo), repo, branch);
  assert.ok(reason, "Gate R1 must block");
  assert.match(reason, /named_change/);
  assert.match(reason, RECORD_FIX_HINT);
});

test("Malformed lite record blocks the write", () => {
  const second = liteChange("r1-malformed-second");
  writeLiteRecord(second.repo, second.changeName, `${liteLine(second.changeName, second.branch)}\nsecond line\n`);
  const secondReason = gateVerdict(implementationWrite(second.repo), second.repo, second.branch);
  assert.ok(secondReason, "a second line must block");
  assert.ok(secondReason.includes(`openspec/changes/${second.changeName}/lite-scope.md`), secondReason);
  assert.match(secondReason, RECORD_FIX_HINT);

  const empty = liteChange("r1-malformed-covers");
  writeLiteRecord(empty.repo, empty.changeName, `${liteLine(empty.changeName, empty.branch, { covers: "" })}\n`);
  const emptyReason = gateVerdict(implementationWrite(empty.repo), empty.repo, empty.branch);
  assert.ok(emptyReason, "an empty covers list must block");
  assert.match(emptyReason, /covers/);
  assert.match(emptyReason, RECORD_FIX_HINT);

  const legacy = liteChange("r1-malformed-legacy");
  writeLiteRecord(legacy.repo, legacy.changeName, `${liteLine(legacy.changeName, legacy.branch, { covers: `${LITE_COVERS},external_disclosure` })}\n`);
  const legacyReason = gateVerdict(implementationWrite(legacy.repo), legacy.repo, legacy.branch);
  assert.ok(legacyReason, "a legacy token in the record must block");
  assert.ok(legacyReason.includes("external_disclosure"), legacyReason);
});

test("Gate R1 blocks implementation writes on a broken record: mismatch and malformed block with the rewrite-or-delete message, while writes under openspec/changes/<change>/ stay allowed", () => {
  for (const [label, build] of [
    ["mismatch", (c, b) => `${liteLine(c, `${b}-other`)}\n`],
    ["malformed", (c, b) => `${liteLine(c, b)}\nextra\n`],
  ]) {
    const { changeName, branch, repo } = liteChange(`r1-broken-${label}`);
    const record = writeLiteRecord(repo, changeName, build(changeName, branch));
    const reason = gateVerdict(implementationWrite(repo), repo, branch);
    assert.ok(reason, `${label}: implementation write must block`);
    assert.match(reason, RECORD_FIX_HINT, label);
    // Repair/delete paths stay open: other files under the change folder and the record itself.
    const tasksWrite = { tool_name: "Write", tool_input: { file_path: changeFile(repo, changeName, "tasks.md"), content: "- [ ] T1\n" } };
    assert.equal(gateVerdict(tasksWrite, repo, branch), null, `${label}: tasks.md under the change folder must stay writable`);
    const recordWrite = { tool_name: "Write", tool_input: { file_path: record, content: `${liteLine(changeName, branch)}\n` } };
    assert.equal(gateVerdict(recordWrite, repo, branch), null, `${label}: the record itself must stay writable`);
  }
});

test("Lite record correction write passes", () => {
  for (const [label, content] of [
    ["mismatched", (c, b) => `${liteLine(c, `${b}-other`)}\n`],
    ["malformed", (c, b) => `${liteLine(c, b)}\nextra\n`],
  ]) {
    const { changeName, branch, repo } = liteChange(`r1-correction-${label}`);
    const record = writeLiteRecord(repo, changeName, content(changeName, branch));
    assert.ok(gateVerdict(implementationWrite(repo), repo, branch), `${label}: precondition — the broken record blocks implementation writes`);
    const rewrite = { tool_name: "Write", tool_input: { file_path: record, content: `${liteLine(changeName, branch)}\n` } };
    assert.equal(gateVerdict(rewrite, repo, branch), null, `${label}: rewriting the record must pass`);
    // Relative path form of the same correction.
    const relative = { tool_name: "Write", tool_input: { file_path: `openspec/changes/${changeName}/lite-scope.md`, content: `${liteLine(changeName, branch)}\n` } };
    assert.equal(gateVerdict(relative, repo, branch), null, `${label}: relative-path correction must pass`);
  }
});

test("Lite record correction write passes: with a claimed batch approval, Gate SP lets the record write through as well", () => {
  const { changeName, branch, repo } = liteChange("sp-correction");
  writeSessionPendingClaim(repo, changeName);
  const record = writeLiteRecord(repo, changeName, `${liteLine(changeName, branch)}\nextra\n`);
  assert.ok(gateVerdict(implementationWrite(repo), repo, branch), "precondition — the broken record blocks");
  const rewrite = { tool_name: "Write", tool_input: { file_path: record, content: `${liteLine(changeName, branch)}\n` } };
  assert.equal(gateVerdict(rewrite, repo, branch), null);
});

// ---------------------------------------------------------------------------
// Lite scope record — Gate SP (claimed session-pending batch approval)
// ---------------------------------------------------------------------------

test("Matching lite record satisfies a claimed batch approval", () => {
  const { changeName, branch, repo } = liteChange("sp-match");
  writeSessionPendingClaim(repo, changeName);
  writeLiteRecord(repo, changeName, `${liteLine(changeName, branch)}\n`);
  assert.equal(gateVerdict(implementationWrite(repo), repo, branch), null);
});

test("Claimed batch approval without a matching carrier names both carriers", () => {
  const variants = [
    ["missing record", () => null],
    ["branch differs from the current branch", (c, b) => `${liteLine(c, `${b}-other`)}\n`],
    ["second line", (c, b) => `${liteLine(c, b)}\nsecond line\n`],
  ];
  for (const [label, content] of variants) {
    const { changeName, branch, repo } = liteChange("sp-no-carrier");
    writeSessionPendingClaim(repo, changeName);
    const text = content(changeName, branch);
    if (text !== null) writeLiteRecord(repo, changeName, text);
    const reason = gateVerdict(implementationWrite(repo), repo, branch);
    assert.ok(reason, `${label}: Gate SP must block`);
    assert.match(reason, /Gate SP \(Session Pending Batch Approval Ledger\)/, label);
    assert.ok(reason.includes("## Batch Approval Ledger"), `${label}: must name the full ledger carrier: ${reason}`);
    assert.ok(reason.includes("proposal"), `${label}: must name the proposal carrier: ${reason}`);
    assert.ok(reason.includes(`openspec/changes/${changeName}/lite-scope.md`), `${label}: must name the lite record carrier: ${reason}`);
  }
});

test("Gate SP accepts a matching record when no proposal carrier exists", () => {
  const match = liteChange("sp-accept-match");
  writeSessionPendingClaim(match.repo, match.changeName);
  writeLiteRecord(match.repo, match.changeName, `${liteLine(match.changeName, match.branch)}\n`);
  assert.equal(gateVerdict(implementationWrite(match.repo), match.repo, match.branch), null, "a match record must pass");

  for (const [label, content] of [
    ["missing", null],
    ["mismatched", (c, b) => `${liteLine(c, `${b}-other`)}\n`],
    ["malformed", (c, b) => `${liteLine(c, b)}\nsecond line\n`],
  ]) {
    const { changeName, branch, repo } = liteChange(`sp-accept-${label}`);
    writeSessionPendingClaim(repo, changeName);
    if (content) writeLiteRecord(repo, changeName, content(changeName, branch));
    const reason = gateVerdict(implementationWrite(repo), repo, branch);
    assert.ok(reason, `${label}: Gate SP must block`);
    assert.ok(reason.includes("## Batch Approval Ledger"), `${label}: ${reason}`);
    assert.ok(reason.includes(`openspec/changes/${changeName}/lite-scope.md`), `${label}: ${reason}`);
  }
});

test("Lite batch conclusion is recorded in the lite scope record: Gate R1 and Gate SP both accept a match record as the lite carrier, with and without a claimed batch approval", () => {
  for (const claimed of [false, true]) {
    const { changeName, branch, repo } = liteChange(`lite-conclusion-${claimed}`);
    if (claimed) writeSessionPendingClaim(repo, changeName);
    writeLiteRecord(repo, changeName, `${liteLine(changeName, branch)}\n`);
    assert.equal(gateVerdict(implementationWrite(repo), repo, branch), null, `claimed=${claimed}`);
  }
  // Stepwise at lite rigor records nothing, and Gate R1 does not demand a record.
  const stepwise = liteChange("lite-conclusion-stepwise");
  assert.equal(gateVerdict(implementationWrite(stepwise.repo), stepwise.repo, stepwise.branch), null);
});

test("Lite record is read from the linked worktree", () => {
  const changeName = `lite-linked-${nameCounter++}`;
  const branch = `feature/${changeName}`;
  const { repo, wt } = setupRepoWithWorktree(branch);
  writeSessionPendingClaim(repo, changeName);
  // The record exists only in the linked worktree (it is gitignored, never committed).
  writeLiteRecord(wt, changeName, `${liteLine(changeName, branch)}\n`);
  assert.equal(gateVerdict(implementationWrite(wt), wt, branch), null, "a record in the linked worktree must satisfy the gate");
});

test("Lite record is read from the linked worktree: a record only in the main checkout does not satisfy a write made from the linked worktree", () => {
  const changeName = `lite-linked-main-only-${nameCounter++}`;
  const branch = `feature/${changeName}`;
  const { repo, wt } = setupRepoWithWorktree(branch);
  writeSessionPendingClaim(repo, changeName);
  writeLiteRecord(repo, changeName, `${liteLine(changeName, branch)}\n`);
  const reason = gateVerdict(implementationWrite(wt), wt, branch);
  assert.ok(reason, "the main checkout's record must not be read for a worktree write");
  assert.ok(reason.includes(`openspec/changes/${changeName}/lite-scope.md`), reason);
});

test("Lite record is read from the linked worktree: Gate R1 judges the worktree's own record without a claim", () => {
  const changeName = `lite-linked-r1-${nameCounter++}`;
  const branch = `feature/${changeName}`;
  const { wt } = setupRepoWithWorktree(branch);
  writeLiteRecord(wt, changeName, `${liteLine(changeName, `${branch}-other`)}\n`);
  const reason = gateVerdict(implementationWrite(wt), wt, branch);
  assert.ok(reason, "a mismatched record in the linked worktree must block");
  assert.match(reason, RECORD_FIX_HINT);
});

test("Gate R1 reads only the record file: a symlinked or directory lite-scope.md blocks instead of being followed", () => {
  const link = liteChange("r1-symlink");
  const target = path.join(link.repo, "valid-record.txt");
  writeFileSync(target, `${liteLine(link.changeName, link.branch)}\n`);
  mkdirSync(path.join(link.repo, "openspec", "changes", link.changeName), { recursive: true });
  symlinkSync(target, changeFile(link.repo, link.changeName, "lite-scope.md"));
  const reason = gateVerdict(implementationWrite(link.repo), link.repo, link.branch);
  assert.ok(reason, "a symlinked record must not authorize");
  assert.match(reason, RECORD_FIX_HINT);

  const dir = liteChange("r1-directory");
  mkdirSync(changeFile(dir.repo, dir.changeName, "lite-scope.md"), { recursive: true });
  const dirReason = gateVerdict(implementationWrite(dir.repo), dir.repo, dir.branch);
  assert.ok(dirReason, "a directory named lite-scope.md must not authorize");
  assert.match(dirReason, RECORD_FIX_HINT);
});

// ---------------------------------------------------------------------------
// Gate SP archived-change variant (amend-gate-forgery-rule-for-batch-scope-records, design D6)
// ---------------------------------------------------------------------------

const ARCHIVED_TITLE = "Archived change with a claimed batch approval points to pre-merge re-archive";

function archiveDir(root, changeName, date = "2026-10-05") {
  return path.join(root, "openspec", "changes", "archive", `${date}-${changeName}`);
}

function writeArchivedChange(root, changeName, { date = "2026-10-05", file = "proposal.md", dirName } = {}) {
  const dir = dirName ? path.join(root, "openspec", "changes", "archive", dirName) : archiveDir(root, changeName, date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), `# Proposal: ${changeName}\n`);
  return dir;
}

// A claimed change whose active folder is gone and whose archive folder exists.
function archivedChange(prefix, archiveOptions) {
  const change = liteChange(prefix);
  writeSessionPendingClaim(change.repo, change.changeName);
  writeArchivedChange(change.repo, change.changeName, archiveOptions);
  return change;
}

function archivedReason(change) {
  const reason = gateVerdict(implementationWrite(change.repo), change.repo, change.branch);
  assert.ok(reason, "Gate SP must still block the write");
  return reason;
}

function archivedWrite(change, file, folder = archiveDir(change.repo, change.changeName)) {
  const payload = implementationWrite(change.repo, change.branch);
  payload.tool_input.file_path = path.join(folder, file);
  return gateVerdict(payload, change.repo, change.branch);
}

for (const file of ['proposal.md', 'proposal-mini.md', 'tasks.md', 'decisions.md', 'qa-test-scope.md']) {
  test(`Gate SP permits exact archived bookkeeping carrier ${file}`, () => {
    const change = archivedChange('sp-bookkeeping-allowed');
    assert.equal(archivedWrite(change, file), null);
    assert.ok(archivedReason(change), 'implementation still needs a matching active carrier');
  });
}

test('Gate SP archive allowance is exact, unique, and only for inactive changes', () => {
  const change = archivedChange('sp-bookkeeping-bounds');
  for (const file of ['specs/example/spec.md', 'design.md', 'tasks.md/child', 'nested/tasks.md', 'tasks.md.bak']) {
    assert.ok(archivedWrite(change, file), file);
  }
  assert.ok(archivedWrite(change, 'tasks.md', archiveDir(change.repo, change.changeName + '-extra')));
  writeArchivedChange(change.repo, change.changeName, { date: '2026-10-06' });
  assert.ok(archivedWrite(change, 'tasks.md'), 'ambiguous archives remain blocked');
  const active = archivedChange('sp-bookkeeping-active');
  mkdirSync(path.join(active.repo, 'openspec', 'changes', active.changeName), { recursive: true });
  assert.ok(archivedWrite(active, 'tasks.md'), 'active folder wins over an old archive');
});

test(`${ARCHIVED_TITLE}: the write is still blocked by Gate SP, for proposal.md and proposal-mini.md archives alike`, () => {
  for (const file of ["proposal.md", "proposal-mini.md"]) {
    const change = archivedChange(`sp-archived-block-${file.replace(/\W/g, "")}`, { file });
    const reason = archivedReason(change);
    assert.match(reason, /Gate SP \(Session Pending Batch Approval Ledger\)/, file);
    assert.ok(reason.includes(`openspec/changes/archive/2026-10-05-${change.changeName}`), `${file}: must name the archive dir: ${reason}`);
  }
});

test(`${ARCHIVED_TITLE}: a matching lite record on top of the archive still passes`, () => {
  const change = archivedChange("sp-archived-match");
  writeLiteRecord(change.repo, change.changeName, `${liteLine(change.changeName, change.branch)}\n`);
  assert.equal(gateVerdict(implementationWrite(change.repo), change.repo, change.branch), null);
});

test(`${ARCHIVED_TITLE}: the reason points to the pre-merge re-archive path, the admission-records backup, and the neutral note for a new change reusing the name`, () => {
  const change = archivedChange("sp-archived-reason");
  const reason = archivedReason(change);
  assert.ok(reason.includes("Pre-merge Archive Re-do"), reason);
  assert.ok(reason.includes("openspec-archive-principles.md"), reason);
  assert.ok(reason.includes("admission-records"), reason);
  // Neutral note: a new change that reuses the name builds the active proposal instead of reverting the old archive.
  assert.ok(reason.includes("同名"), reason);
  assert.ok(reason.includes(`openspec/changes/${change.changeName}/proposal.md`), reason);
  assert.ok(reason.includes("## Batch Approval Ledger"), reason);
});

test(`${ARCHIVED_TITLE}: the reason does not recommend or template lite-scope.md and does not claim post-archive bookkeeping writes are allowed`, () => {
  const change = archivedChange("sp-archived-no-lite");
  const reason = archivedReason(change);
  assert.ok(!reason.includes("lite-scope.md"), reason);
  assert.ok(!reason.includes("kind=same-change-dp-change-batch"), "must not carry the lite record template");
  assert.ok(!reason.includes("LITE_RECORD_TEMPLATE"), reason);
  assert.ok(!reason.includes("（含 `lite-scope.md`）"), "must not carry the current closing sentence");
  assert.ok(!reason.includes("可先寫／修正再進行非 OpenSpec repo write"), "must not carry the current closing sentence");
  // Honest disclosure: the gate verdict is unchanged and archive-path writes are still blocked (known gap).
  assert.match(reason, /仍會擋|仍被擋/, reason);
});

// The re-archive path is scoped to non-bookkeeping edits; post-archive bookkeeping edits get their own
// exact allowed carrier paths (no re-archive, no lite record); the wording must not depend
// on the source repo's gitignored session-pending entry.
function assertArchivedBookkeepingGuidance(reason) {
  assert.match(reason, /非記帳[^\n]*走 pre-merge re-archive/, "re-archive must be scoped to non-bookkeeping edits");
  assert.ok(reason.includes("post-pr-completion-gate.md"), "must point to the Post-archive repair landing SSOT");
  assert.ok(reason.includes("Post-archive 修復落點"), "must name the Post-archive repair landing section");
  assert.ok(reason.includes("唯一同名封存目錄根下"), "must limit the allowance to a unique archive");
  assert.ok(reason.includes("其他路徑或不唯一的封存仍會擋"), "must retain all other blocks");
  assert.ok(!reason.includes("已追蹤於"), "allowance wording must not rely on a source-repo-only session-pending entry");
  assert.match(reason, /不要為此 re-archive/, "bookkeeping edits must not trigger re-archive");
  assert.match(reason, /停下回報/, "bookkeeping next step is to stop and report");
  assert.match(reason, /不要為此寫 lite 紀錄/, "must not point at a lite record for bookkeeping edits");
}

test(`${ARCHIVED_TITLE}: re-archive is scoped to non-bookkeeping edits and post-archive bookkeeping edits get an exact carrier allowance`, () => {
  const change = archivedChange("sp-archived-bookkeeping");
  assertArchivedBookkeepingGuidance(archivedReason(change));
});

test(`${ARCHIVED_TITLE}: mutating the unique-archive clause or the non-bookkeeping scoping turns the guidance check red`, () => {
  const change = archivedChange("sp-archived-bookkeeping-mutation");
  const reason = archivedReason(change);
  assertArchivedBookkeepingGuidance(reason);
  const mutations = {
    "unique archive clause removed": reason.split("唯一同名封存目錄根下").join(""),
    "non-bookkeeping scoping removed": reason.split("非記帳").join(""),
    "stop-and-report removed": reason.split("停下回報").join(""),
    "post-pr-completion-gate pointer removed": reason.split("post-pr-completion-gate.md").join(""),
  };
  for (const [name, mutated] of Object.entries(mutations)) {
    assert.notEqual(mutated, reason, `${name}: mutation must change the message`);
    assert.throws(() => assertArchivedBookkeepingGuidance(mutated), assert.AssertionError, name);
  }
});

test(`${ARCHIVED_TITLE}: a name-collision archive <date>-<change>-extra does not select the archived variant`, () => {
  const change = liteChange("sp-archived-extra");
  writeSessionPendingClaim(change.repo, change.changeName);
  writeArchivedChange(change.repo, change.changeName, { dirName: `2026-10-05-${change.changeName}-extra` });
  const reason = archivedReason(change);
  assert.ok(!reason.includes("Pre-merge Archive Re-do"), reason);
  assert.ok(reason.includes(`openspec/changes/${change.changeName}/lite-scope.md`), reason);

  // A prefixed name (<junk><date>-<change>) is not an archive of this change either.
  const prefixed = liteChange("sp-archived-prefixed");
  writeSessionPendingClaim(prefixed.repo, prefixed.changeName);
  writeArchivedChange(prefixed.repo, prefixed.changeName, { dirName: `x2026-10-05-${prefixed.changeName}` });
  const prefixedReason = archivedReason(prefixed);
  assert.ok(!prefixedReason.includes("Pre-merge Archive Re-do"), prefixedReason);
});

test(`${ARCHIVED_TITLE}: an exact archive next to a name-collision archive lists only the exact one`, () => {
  const change = archivedChange("sp-archived-extra-mixed");
  writeArchivedChange(change.repo, change.changeName, { dirName: `2026-10-06-${change.changeName}-extra` });
  const reason = archivedReason(change);
  assert.ok(reason.includes("Pre-merge Archive Re-do"), reason);
  assert.ok(reason.includes(`2026-10-05-${change.changeName}`), reason);
  assert.ok(!reason.includes(`${change.changeName}-extra`), reason);
});

test(`${ARCHIVED_TITLE}: an archive folder without proposal.md or proposal-mini.md does not select the archived variant`, () => {
  const change = archivedChange("sp-archived-no-proposal", { file: "tasks.md" });
  const reason = archivedReason(change);
  assert.ok(!reason.includes("Pre-merge Archive Re-do"), reason);
  assert.ok(reason.includes(`openspec/changes/${change.changeName}/lite-scope.md`), reason);
});

test(`${ARCHIVED_TITLE}: an older same-name archive next to an existing active folder keeps the current message naming lite-scope.md`, () => {
  const change = archivedChange("sp-archived-reused");
  // A new change reusing the name: active folder exists (no proposal yet).
  writeChangeFile(change.repo, change.changeName, "meeting-notes.md", "# notes\n");
  const reason = archivedReason(change);
  assert.ok(!reason.includes("Pre-merge Archive Re-do"), reason);
  assert.ok(reason.includes(`openspec/changes/${change.changeName}/lite-scope.md`), reason);
  assert.ok(reason.includes("## Batch Approval Ledger"), reason);
});

test(`${ARCHIVED_TITLE}: multiple archives of the same name are all listed`, () => {
  const change = archivedChange("sp-archived-multi");
  writeArchivedChange(change.repo, change.changeName, { date: "2026-09-01", file: "proposal-mini.md" });
  const reason = archivedReason(change);
  assert.ok(reason.includes("Pre-merge Archive Re-do"), reason);
  assert.ok(reason.includes(`openspec/changes/archive/2026-09-01-${change.changeName}`), reason);
  assert.ok(reason.includes(`openspec/changes/archive/2026-10-05-${change.changeName}`), reason);
});

test(`${ARCHIVED_TITLE}: a read error on the archive directory or the active folder keeps the current message`, () => {
  // openspec/changes/archive is a file, so listing it fails (ENOTDIR).
  const archiveFile = liteChange("sp-archived-read-error-archive");
  writeSessionPendingClaim(archiveFile.repo, archiveFile.changeName);
  mkdirSync(path.join(archiveFile.repo, "openspec", "changes"), { recursive: true });
  writeFileSync(path.join(archiveFile.repo, "openspec", "changes", "archive"), "not a directory\n");
  const archiveReason = archivedReason(archiveFile);
  assert.ok(!archiveReason.includes("Pre-merge Archive Re-do"), archiveReason);
  assert.ok(archiveReason.includes(`openspec/changes/${archiveFile.changeName}/lite-scope.md`), archiveReason);

  // The active folder path is a self-referencing symlink, so its state cannot be read (ELOOP).
  const activeLoop = archivedChange("sp-archived-read-error-active");
  const activePath = path.join(activeLoop.repo, "openspec", "changes", activeLoop.changeName);
  symlinkSync(activePath, activePath);
  const activeReason = archivedReason(activeLoop);
  assert.ok(!activeReason.includes("Pre-merge Archive Re-do"), activeReason);
  assert.ok(activeReason.includes(`openspec/changes/${activeLoop.changeName}/lite-scope.md`), activeReason);
});

// ---------------------------------------------------------------------------
// Malformed-record repair hint (#3661): the blocked writer is told where the plan
// content belongs, so repair does not require guessing or dropping the write-up.
// ---------------------------------------------------------------------------

test("a malformed lite record names plan.md as the home for plan content", () => {
  const { changeName, branch, repo } = liteChange("r1-malformed-plan-hint");
  writeLiteRecord(repo, changeName, `${liteLine(changeName, branch)}\n\n## 改法\n- step\n`);
  const reason = gateVerdict(implementationWrite(repo), repo, branch);
  assert.ok(reason, "a multi-line record must block");
  assert.match(reason, /must be exactly one line/);
  assert.match(reason, /改放同一 change 目錄的 `plan\.md`/, reason);
});

test("the lite workflow carrier states the one-line record and the plan.md split", () => {
  const skill = readFileSync(
    path.resolve(import.meta.dirname, "../../agent-skills/devpro-workflows/change/SKILL.md"),
    "utf8"
  );
  assert.match(
    skill,
    /`lite-scope\.md` 只放那一行，計畫另放 `plan\.md`/,
    "the change skill must name the plan.md split next to the one-line template"
  );
  assert.match(skill, /Gate R1 對多行／空行判 `malformed`/);
});
