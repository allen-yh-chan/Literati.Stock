import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath, SOURCE_ROOT } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";

const changeName = "strengthen-current-intent-after-go-merge";


function readProposalMini() {
  const activePath = path.join(SOURCE_ROOT, "openspec/changes", changeName, "proposal-mini.md");
  if (existsSync(activePath)) return readFileSync(activePath, "utf8");

  const archiveRoot = repoPath("openspec/changes/archive");
  const archivedDir = readdirSync(archiveRoot)
    .filter((name) => name.endsWith(`-${changeName}`))
    .sort()
    .at(-1);
  assert.ok(archivedDir, `missing active or archived proposal-mini for ${changeName}`);
  return readFileSync(path.join(archiveRoot, archivedDir, "proposal-mini.md"), "utf8");
}

const autonomy = read(".devpro/agent-rules/ai-autonomy.md");
const workflow = read(".devpro/agent-rules/git-workflow-tracking.md");
const proposal = readProposalMini();

test("ai-autonomy requires compact current-intent sanity check for terse continuation", () => {
  for (const phrase of [
    "CurrentIntent sanity check（terse continuation）",
    "resume / interruption",
    "`go` / `merge` / `continue`",
    "`CurrentIntent:",
    "`NextAction:",
    "`AskFirstPending:",
    "git/GitHub write-class follow-up",
    "不得用舊 pending cleanup / release / merge 記憶自行補完",
  ]) {
    assert.match(autonomy, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("post-PR handoff preserves continuation state for later short commands", () => {
  for (const phrase of [
    "Terse continuation handoff guard",
    "Post-PR created / post-merge / cleanup handoff",
    "`CurrentIntent` / `NextAction` / `AskFirstPending`",
    "`go` / `merge` / `continue`",
    "stale cleanup",
    "以最新使用者訊息為準",
  ]) {
    assert.match(workflow, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("proposal-mini captures issue-backed rule-feedback matrix and ledger", () => {
  for (const phrase of [
    "issue: #1154",
    "Rule-feedback B-mini",
    "## Rule-feedback Surface Matrix",
    "Rule leaf / adapter / hook / command",
    "Affected capability spec",
    "Cross-runtime parity spec",
    "Mechanical guard",
    "PR dependency wording",
    "## Requirement Ledger",
    "R1",
    "R2",
    "R3",
  ]) {
    assert.match(proposal, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
