import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoPath } from "./lib/repo-root.mjs";
import { readSecondReviewSkillWithHostRoutes } from "./lib/second-review-skill.mjs";
import { readRepoFile as read } from "./lib/read.mjs";



// Body of the one heading that equals `heading` exactly, up to the next heading of the same or a higher level.
function sliceSection(content, heading) {
  const lines = content.split("\n");
  const level = heading.match(/^#+/)[0].length;
  const start = lines.indexOf(heading);
  assert.ok(start >= 0 && lines.indexOf(heading, start + 1) < 0, `expected exactly one "${heading}" heading`);
  const next = lines.findIndex((line, index) => index > start && /^#+ /.test(line) && line.match(/^#+/)[0].length <= level);
  return lines.slice(start + 1, next < 0 ? lines.length : next).join("\n");
}

function readFirst(relPaths) {
  for (const relPath of relPaths) {
    const fullPath = repoPath(relPath);
    if (existsSync(fullPath)) return readFileSync(fullPath, "utf8");
  }
  throw new Error(`none of the candidate files exist: ${relPaths.join(", ")}`);
}

test("post-pr completion gate is discoverable from AGENTS and PR flow hub", () => {
  const agents = read("AGENTS.md");
  const hub = read(".devpro/agent-rules/git-branch-and-pr-flow.md");

  assert.match(agents, /post-pr-completion-gate\.md/);
  assert.match(agents, /PR 後 completion/);
  assert.match(hub, /post-pr-completion-gate\.md/);
  assert.match(hub, /workflow \+ cross-model \+ handoff/);
  assert.match(hub, /blocked\/ready handoff/);
  assert.match(hub, /post-PR created state/);
});

test("Claude pre-pr remains executor and references host-neutral checklist", () => {
  const prePr = read(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md");

  assert.match(prePr, /Step 5: Post-PR Workflow Watch/);
  assert.match(prePr, /Step 5\.5: Post-PR Cross-Model Review/);
  assert.match(prePr, /post-pr-completion-gate\.md/);
  assert.match(prePr, /非 Claude host 不會自動執行本檔/);
  assert.match(prePr, /不自動呼叫 reviewer/);
});

test("shared leaf preserves SSOT boundaries", () => {
  const leaf = read(".devpro/agent-rules/post-pr-completion-gate.md");

  assert.match(leaf, /git-workflow-tracking\.md/);
  assert.match(leaf, /code-review-checklist\.md/);
  assert.match(leaf, /platform-adapters\/<host>\.md/);
  assert.match(leaf, /Hook 不得自動呼叫 second reviewer/);
  assert.match(leaf, /checkCrossModelMergeGate/);
});

test("Host-Neutral Post-PR spec aligns non-FF marker recovery with approved lineage path", () => {
  const spec = read("openspec/specs/openspec-flow/spec.md");
  const start = spec.indexOf("### Requirement: Host-Neutral Post-PR Completion Gate");
  assert.notEqual(start, -1, "Host-Neutral Post-PR Completion Gate requirement must exist");
  const end = spec.indexOf("\n### Requirement:", start + 1);
  assert.notEqual(end, -1, "Host-Neutral Post-PR Completion Gate must have a bounded requirement section");
  const requirement = spec.slice(start, end);
  const transition = requirement.split("\n").find((line) => line.startsWith("When a pending marker is still bound to an older PR head,"));

  assert.ok(transition, "the marker handoff contract must remain in the Host-Neutral requirement");
  assert.match(transition, /verified fast-forward/);
  assert.match(transition, /exact per-lineage approval/u);
  assert.match(transition, /active marker.*clear obligation/u);
  assert.match(transition, /fresh current-head review/u);
  assert.match(transition, /unapproved.*fail closed/u);
  assert.doesNotMatch(transition, /non-fast-forward, backward, missing-object, or uncertain ancestry SHALL fail closed/u);
});

test("post-pr completion gate declares execution location and that exit 0 is not proof", () => {
  const leaf = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const devFlow = read(".devpro/agent-rules/dev-flow-checklist.md");
  const leafLines = leaf.split("\n");

  // Structural anchor: whole-line match so a rename or demotion turns red.
  assert.ok(
    leafLines.includes("### Execution Location"),
    "post-pr-completion-gate.md §Execution Location 被改名或刪除"
  );

  // Match the operative line and polarity, including selection before checks.
  const scopeMust = leafLines.find((l) => /^Stop gate MUST 先以穩定 runtime\/session ID/.test(l));
  assert.ok(scopeMust, "Stop gate MUST session selection line missing or polarity reversed");
  assert.match(scopeMust, /本 session 建立或明確接手的 PR，再驗 current-head sticky／receipt／lineage/);
  assert.match(scopeMust, /相同 branch、worktree 或 repo 不是 ownership 證據/);
  assert.match(scopeMust, /ID 缺失、無主 legacy marker、其他 session.*不自動提醒／阻擋.*不作 network probe 或清理/);
  assert.match(scopeMust, /exit 0.*不代表範圍外工作已驗證/);

  // Mainline checklist co-location: the stage-5 row that names this leaf must
  // itself carry the execution-location constraint — a whole-file check would
  // false-pass off any other `worktree` mention in the checklist.
  const devFlowRow = devFlow
    .split("\n")
    .find((l) => l.includes("`post-pr-completion-gate.md` 逐項核"));
  assert.ok(devFlowRow, "dev-flow-checklist.md 階段 5 的 post-pr-completion-gate 逐項核 row 遺失");
  assert.match(
    devFlowRow,
    /worktree/,
    "dev-flow-checklist.md 階段 5 row 必須在同一行帶執行位置對位（worktree）"
  );
});

test("post-pr completion gate is independent of PR creation tool path", () => {
  const leaf = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const spec = readFirst([
    "openspec/changes/strengthen-codex-github-write-gate/specs/openspec-flow/spec.md",
    "openspec/specs/openspec-flow/spec.md",
  ]);

  for (const body of [leaf, spec]) {
    assert.match(body, /PR creation path is not an exemption|PR creation path does not exempt sticky verification/);
    assert.match(body, /PR URL \/ number|PR URL or number/);
    assert.match(body, /sticky comment URL \+ `last_reviewed_sha`|sticky URL \+ `last_reviewed_sha`/);
    assert.match(body, /connector, CLI, app integration|connector、CLI、app integration/);
    assert.match(body, /future runtime|未來 runtime/);
    assert.match(body, /observable|可觀測/);
    assert.match(body, /fail-closed/);
  }
});

test("Codex generic publish flows are hard-gated by post-pr completion", () => {
  const codex = read(".devpro/agent-rules/platform-adapters/codex.md");
  const codexReviewer = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  const hub = read(".devpro/agent-rules/git-branch-and-pr-flow.md");
  const leaf = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const spec = readFirst([
    "openspec/changes/fix-codex-post-pr-cross-model-gate/specs/cross-runtime-parity/spec.md",
    "openspec/specs/cross-runtime-parity/spec.md",
  ]);

  for (const body of [codexReviewer, hub, leaf, spec]) {
    assert.match(body, /generic publish|generic GitHub publish/);
    assert.match(body, /commit push PR/);
    assert.match(body, /PR URL.*checks.*not completion|PR URL.*check polling.*not completion|PR URL\/check polling.*not completion/s);
  }
  assert.match(codex, /PR create\/update 後/);
  assert.match(codex, /URL\/polling≠completion/);

  for (const body of [codex, codexReviewer, hub, spec]) {
    assert.match(body, /post-pr-completion-gate\.md/);
  }

  for (const body of [codexReviewer, spec]) {
    assert.match(body, /verdict: PASS \| WARN|PASS \| WARN/);
    assert.match(body, /complete\/ready\/merge|completion, ready status, or proceeding to merge|ready, complete, or mergeable/);
  }
  const codexTrigger = codex.split("\n").find((line) => line.includes("| PR create/update 後 |"));
  assert.ok(codexTrigger, "Codex first-command matrix PR trigger row is missing");
  assert.match(codexTrigger, /post-pr-completion-gate\.md/);
  assert.match(codexTrigger, /無後續 gh 亦同/);
  assert.match(codexTrigger, /complete\/ready\/merge 前重驗/);
  assert.doesNotMatch(codex, /last_reviewed_sha == headRefOid/);
  for (const body of [codexReviewer, leaf, spec]) {
    assert.match(body, /last_reviewed_sha == headRefOid/);
  }
});

test("GitHub routing follows CLI-first policy and keeps post-PR obligations across transports", () => {
  for (const file of [".devpro/agent-rules/platform-adapters/codex.md", ".devpro/agent-rules/git-branch-and-pr-flow.md", "openspec/specs/cross-runtime-parity/spec.md"]) {
    assert.match(read(file), /tool-selection\.md/);
  }
  const hub = read(".devpro/agent-rules/git-branch-and-pr-flow.md");
  assert.match(hub, /post-pr-completion-gate\.md/);
  assert.match(hub, /connector\/CLI\/app integration\/generic GitHub publish differences are not an exemption/);
  assert.match(read(".devpro/agent-rules/ai-autonomy.md"), /未驗證的 connector 仍唯讀/);
});

test("cross-model review preserves reviewer-produced evidence and sticky write", () => {
  const leaf = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const checklist = read(".devpro/agent-rules/code-review-checklist.md") + "\n" +
    read(".devpro/agent-rules/code-review-cross-model.md");
  const codexReviewer = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  const prePr = read(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md") + "\n" +
    read(".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md");

  // Reviewer provenance / packet / self-write contract is owned by the leaf (and
  // adapter/checklist), not restated in the Stop hook message — the hook only
  // points at the leaf. Asserting these on the hook source forced its block
  // message to carry the full leaf rules verbatim (half-screen output).
  for (const body of [leaf, checklist, codexReviewer]) {
    assert.match(body, /reviewer-produced structured output|reviewer-produced findings|reviewer provenance/);
    assert.match(body, /bounded handoff inputs|final reviewer packet|review packet/);
    assert.match(body, /TL .*不得.*撰寫|TL .*不得.*改寫|TL 轉述不算完成/);
  }

  // Claude Code host still uses the host-aware devpro:second-review wrapper path.
  assert.match(prePr, /請自行讀取 PR metadata \/ diff \/ comments/);
  assert.match(prePr, /自行寫\/更新 sticky comment 至 PR/);
});

test("Step 5.5 permits marked same-family fallback when different-family reviewer is unavailable", () => {
  const modelDelegation = read(".devpro/agent-rules/model-delegation.md");
  // rationalize-overbundled-entry-leaves T1: MUST dispatch section (incl. "可用 same-family fallback")
  // moved from model-delegation.md to model-delegation-delegation-rules.md (on-demand sibling).
  const modelDelegationDelegationRules = read(".devpro/agent-rules/model-delegation-delegation-rules.md");
  const codexReviewer = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  const openspecFlow = read("openspec/specs/openspec-flow/spec.md");
  const secondReviewerSkill = readSecondReviewSkillWithHostRoutes();
  const claudeProjection = read(".claude/agents/dp-second-reviewer.md");
  const cursorProjection = read(".cursor/agents/dp-second-reviewer.md");
  const checklist = read(".devpro/agent-rules/code-review-checklist.md") + "\n" +
    read(".devpro/agent-rules/code-review-cross-model.md");
  const postPrGate = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const prePr = read(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md") + "\n" +
    read(".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md");

  for (const body of [codexReviewer, openspecFlow, secondReviewerSkill, claudeProjection]) {
    assert.match(body, /Codex (?:primary )?host|primary host .*Codex|TL\/primary host 已是 Codex/);
  }

  for (const body of [modelDelegation, codexReviewer, openspecFlow, secondReviewerSkill, claudeProjection]) {
    assert.match(body, /same-family fallback/);
    assert.match(body, /different-family|model family|Codex-family|other-family/);
    assert.match(body, /reason|provenance/);
  }

  assert.match(cursorProjection, /primary_family/);
  assert.match(cursorProjection, /cross-model-unverified/);
  assert.match(cursorProjection, /different[- ]family reviewer CLI/);
  assert.match(cursorProjection, /reason.*provenance/);

  for (const body of [modelDelegation, codexReviewer, secondReviewerSkill, claudeProjection, cursorProjection]) {
    assert.match(body, /second-review/);
  }

  assert.match(modelDelegationDelegationRules, /可用 same-family fallback/);
  assert.match(codexReviewer, /Claude.*CLI|claude CLI/);
  assert.match(codexReviewer, /MAY expose `.codex\/agents\/dp-second-reviewer\.toml` only as a thin projection/);
  assert.match(codexReviewer, /MUST NOT dispatch the projection as a Codex-family default reviewer route/);
  assert.equal(
    existsSync(repoPath(".codex/agents/dp-second-reviewer.toml")),
    true,
    "Codex host may expose a thin devpro:second-review projection to the Claude reviewer chain"
  );
  assert.match(openspecFlow, /adapter MAY use a same-family fallback reviewer/);

  for (const body of [checklist, postPrGate, prePr]) {
    assert.match(body, /same-family fallback/);
    assert.match(body, /reason\/provenance|reason.*provenance/);
  }
  assert.match(prePr, /codex CLI 不可用\/未授權.*same-family fallback/);
});

test("post-pr cross-model status is user-visible before and after review", () => {
  const leaf = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const codexReviewer = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");

  // The user-visible dispatch/result requirement is a rule the agent follows;
  // its SSOT is the leaf (+ adapter). The Stop hook need not restate it in its
  // block message — doing so was part of what bloated the message.
  for (const body of [leaf, codexReviewer]) {
    assert.match(body, /second reviewer 正在審核 PR/);
    assert.match(body, /verdict/);
    assert.match(body, /sticky URL/);
    assert.match(body, /last_reviewed_sha/);
  }

  assert.match(leaf, /user-visible dispatch/);
  assert.match(leaf, /user-visible result/);
  assert.match(leaf, /不得只說「PR 已建立」|不得只說「已 dispatch」/);
  assert.match(codexReviewer, /final \/ handoff/);
});

test("post-pr ready responses bridge pass skip exempt to next action", () => {
  const postPr = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const workflow = read(".devpro/agent-rules/git-workflow-tracking.md");
  const checklist = read(".devpro/agent-rules/code-review-checklist.md");
  const spec = readFirst([
    "openspec/changes/strengthen-second-reviewer-idle-timeout/specs/openspec-flow/spec.md",
    "openspec/specs/openspec-flow/spec.md",
  ]);

  for (const [name, body] of new Map([
    ["post-pr-completion-gate.md", postPr],
    ["git-workflow-tracking.md", workflow],
    ["code-review-checklist.md", checklist],
    ["openspec-flow/spec.md", spec],
  ])) {
    assert.match(body, /Ready Response Next-Step Contract/, `${name} must name the ready response contract`);
    assert.match(body, /PASS\/WARN|PASS\|WARN|PASS[\s\S]{0,80}WARN/, `${name} must treat PASS/WARN as non-terminal`);
    assert.match(body, /skip\/exempt|skip[\s\S]{0,80}exempt/, `${name} must treat skip/exempt as non-terminal`);
    assert.match(body, /CurrentIntent/, `${name} must carry CurrentIntent`);
    assert.match(body, /NextAction/, `${name} must carry NextAction`);
    assert.match(body, /AskFirstPending/, `${name} must carry AskFirstPending`);
    assert.match(body, /Owner:|owner|擁有/, `${name} must identify owner`);
    assert.match(body, /Next step:|next action|下一/, `${name} must identify next action`);
  }

  assert.doesNotMatch(checklist, /resolver-approved/, "the checklist no longer cites a resolver-approved approval_resolution");
});

test("ChangeContext is required on user-owned merge Ask First ready responses", () => {
  const leaf = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const workflow = read(".devpro/agent-rules/git-workflow-tracking.md");
  const canonical = read("openspec/specs/openspec-flow/spec.md");

  const readySection = leaf.slice(
    leaf.indexOf("### Ready Response Next-Step Contract"),
    leaf.indexOf("### Host/Hook Boundary")
  );
  assert.match(readySection, /ChangeContext/);
  assert.match(readySection, /ChangeContext:/);
  assert.match(readySection, /Owner:.*user|Owner.*＝user|Owner.*=user/s);
  assert.match(readySection, /merge authorization|merge Ask First/);
  assert.match(readySection, /PASS\|WARN|PASS\/WARN/);
  assert.match(readySection, /skip／exempt|skip\/exempt/);
  assert.match(readySection, /PR URL/);
  assert.match(readySection, /current-head|current head/);
  assert.match(readySection, /最多 5|≤5/);
  assert.match(readySection, /≤4 landing|4 landing/);
  assert.match(readySection, /feature／bugfix|feature\/bugfix/);
  assert.match(readySection, /residual WARN|殘留 WARN/);
  assert.match(readySection, /\bMUST\b/);
  assert.match(readySection, /\bSHOULD\b/);
  assert.match(readySection, /mechanical chore|MAY one-line/);
  assert.match(readySection, /MUST NOT.*(?:完整 )?PR body|禁.*PR body|貼完整 PR body/);
  assert.match(readySection, /Path F|checkCrossModelMergeGate/);
  assert.match(readySection, /不是.*merge-gate|不是.*Path F|MUST NOT substitute|不是.*替代/);
  assert.match(readySection, /白話/);
  assert.match(readySection, /改什麼/);
  assert.match(readySection, /目的是什麼/);
  assert.match(readySection, /file-first|檔案清單當標題/);

  // Pointer-only discoverability; no second ladder/cap/語態 body in workflow leaf.
  assert.match(workflow, /ChangeContext:/);
  assert.match(workflow, /post-pr-completion-gate\.md/);
  assert.doesNotMatch(workflow, /最多 5|≤4 landing|MAY one-line/);
  assert.doesNotMatch(workflow, /改什麼|目的是什麼|file-first/);

  for (const [name, body] of [
    ["canonical openspec-flow", canonical],
  ]) {
    assert.match(body, /Post-PR Ready Response Next-Step Contract/, `${name} must keep Ready Response requirement`);
    assert.match(body, /ChangeContext:/, `${name} must name ChangeContext:`);
    assert.match(body, /at most 5|≤5/, `${name} must lock bullet cap`);
    assert.match(body, /feature\/bugfix/, `${name} must lock MUST ladder for feature/bugfix`);
    assert.match(body, /MUST NOT paste the full PR body|MUST NOT.*full PR body/, `${name} must forbid PR-body paste`);
    assert.match(body, /current-head/, `${name} must require current-head briefing`);
    assert.match(body, /checkCrossModelMergeGate/, `${name} must name non-substitute merge gate`);
    assert.match(body, /Path F/, `${name} must name Path F non-substitute`);
    assert.match(body, /plain language|白話/, `${name} must lock plain-language tone`);
    assert.match(body, /改什麼/, `${name} must lock 改什麼 lead`);
    assert.match(body, /目的是什麼/, `${name} must lock 目的是什麼 second`);
    assert.match(body, /file-first|檔案清單當標題/, `${name} must forbid file-first headline`);
    assert.match(body, /ChangeContext Uses Plain Language Not File-First/, `${name} must keep plain-language scenario`);
    assert.match(body, /ChangeContext Leads With What Changed Then Purpose/, `${name} must keep change-then-purpose scenario`);
  }

  assert.match(canonical, /User-Owned Merge Authorization Includes ChangeContext/);
  assert.match(canonical, /Residual WARN ChangeContext Includes Risk Bullet/);
  assert.match(canonical, /Mechanical Chore Or Release May Use One-Line ChangeContext/);
  assert.match(canonical, /ChangeContext Does Not Substitute Merge Gate/);
  assert.match(canonical, /PASS WARN Requires Ready Handoff/);
  assert.match(canonical, /Skip Exempt Requires Ready Handoff/);
  assert.match(canonical, /User-Owned Merge Requires Numbered Options/);
  assert.match(canonical, /Authorized TL-Owned NextAction Continues/);
  assert.match(canonical, /Matching Ledger Forbids Idle-Stop At Sticky PASS/);
  assert.match(canonical, /ChangeContext Uses Plain Language Not File-First/);
  assert.match(canonical, /ChangeContext Leads With What Changed Then Purpose/);
});

test("post-pr cross-review dispatch happens after final base sync and forbids lineage-broken rewrites", () => {
  const leaf = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const hub = read(".devpro/agent-rules/git-branch-and-pr-flow.md");
  const crossModel = read(".devpro/agent-rules/code-review-cross-model.md");
  const checklist = read(".devpro/agent-rules/dev-flow-checklist.md");
  const prePr = read(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md");
  const crossReviewSkill = read(".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md");
  const spec = readFirst([
    "openspec/changes/fix-windows-consumer-bootstrap/specs/openspec-flow/spec.md",
    "openspec/specs/openspec-flow/spec.md",
  ]);

  for (const [name, body] of new Map([
    ["post-pr-completion-gate.md", leaf],
    ["git-branch-and-pr-flow.md", hub],
    ["code-review-cross-model.md", crossModel],
    ["dev-flow-checklist.md", checklist],
    ["pre-pr/SKILL.md", prePr],
    ["cross-review/SKILL.md", crossReviewSkill],
    ["openspec-flow/spec.md", spec],
  ])) {
    assert.match(body, /final base\/mergeability sync/, `${name} must require final base/mergeability sync before dispatch`);
    assert.match(body, /dispatch-bound/, `${name} must bind the rule to dispatch-bound sticky/marker evidence`);
    assert.match(body, /rebase/, `${name} must name rebase as a post-sticky head movement risk`);
    assert.match(body, /force-push/, `${name} must name force-push as a post-sticky head movement risk`);
    assert.match(body, /non-fast-forward/, `${name} must name non-fast-forward rewrite risk`);
    assert.match(body, /Ask First|ask for an explicit git strategy|明確 git strategy/, `${name} must route recovery through explicit git approval`);
  }

  for (const [name, body] of new Map([
    ["post-pr-completion-gate.md", leaf],
    ["git-branch-and-pr-flow.md", hub],
    ["code-review-cross-model.md", crossModel],
    ["dev-flow-checklist.md", checklist],
    ["cross-review/SKILL.md", crossReviewSkill],
    ["openspec-flow/spec.md", spec],
  ])) {
    assert.match(body, /last_reviewed_sha\s*==\s*headRefOid|last_reviewed_sha != headRefOid|last_reviewed_sha.*headRefOid/s, `${name} must require current-head sticky equality`);
    assert.match(body, /ancestor/, `${name} must mention ancestor only for lineage classification or recovery traceability`);
    assert.match(body, /recovery[- ]lineage|traceability|不能替代 current-head sticky|cannot satisfy merge readiness|not satisfy post-PR completion or merge readiness/s, `${name} must not let ancestor evidence satisfy readiness`);
    assert.match(body, /lineage-broken/, `${name} must classify non-descendant reviewed evidence as lineage-broken`);
    assert.match(body, /stale sha|stale/, `${name} must fail closed as stale evidence`);
  }
});

test("ledger completion and session close gates are owned by the post-pr leaf", () => {
  const leaf = read(".devpro/agent-rules/post-pr-completion-gate.md");

  // Requirement Ledger + Session-close are full gate items the agent must
  // satisfy; their SSOT is the leaf. The Stop hook points at the leaf for the
  // complete checklist rather than restating items 1–6 verbatim (which made the
  // block message half a screen long). Hook only carries the compact next-step
  // contract — asserted in the "blocked responses … next-step" test below.
  assert.match(leaf, /Requirement Ledger completion/);
  assert.match(leaf, /disposition counts/);
  assert.match(leaf, /owner \/ issue \/ next step/);
  assert.match(leaf, /Session close gates|Recap\/issue\/CI/);
  assert.match(leaf, /Recap.*Requirement Ledger Completion/s);
});

test("post-pr blocked responses include concrete owner action and unblock condition", () => {
  const postPr = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const stopHook = read(".devpro/scripts/hooks/post-pr-completion-check.mjs");
  const spec = readFirst([
    "openspec/changes/enforce-post-pr-blocked-next-step/specs/openspec-flow/spec.md",
    "openspec/specs/openspec-flow/spec.md",
  ]);

  for (const body of [postPr, spec]) {
    assert.match(body, /Post-PR Blocked Response Next-Step Contract|Blocked Response Next-Step Contract/);
    assert.match(body, /`Status:`|Status:/);
    assert.match(body, /`Blocker:`|Blocker:/);
    assert.match(body, /`Owner:`|Owner:/);
    assert.match(body, /`Next step:`|Next step:/);
    assert.match(body, /`Unblock condition:`|Unblock condition:/);
    assert.match(body, /\/devpro:cross-review <PR#>/);
    assert.match(body, /verdict: PASS/);
    assert.match(body, /last_reviewed_sha == headRefOid/);
    assert.match(body, /WARN.*(?:completion|receipt).*(?:no-current-fault|no current fault|無current fault)/s);
    assert.match(body, /不得.*ready.*complete.*mergeable|MUST NOT claim ready, complete, or mergeable/s);
    assert.match(body, /禁止只回|MUST NOT (?:answer|end the turn with) only/s);
    assert.match(body, /stop-point-comms\.md/);
    assert.match(body, /要你做什麼（回數字）/);
    assert.match(body, /`Status:` labels|`Status:`|Status:/);
    assert.match(body, /AskFirstPending|agent-facing hook text|agent-facing next step|hook\/systemMessage reminder/);
  }

  // The blocked-response contract names a TL owner by default; only a cross-repo PR (pr_repository_mismatch) hands it to the user.
  assert.match(postPr, /- `Owner:` 預設 TL\/reviewer；cross-repo PR（`pr_repository_mismatch`）時 owner=user/);
  assert.match(postPr, /- `Blocker:`[^\n]*cross-repo PR（user-owned）/);
  assert.doesNotMatch(postPr, /overlay 收緊|收緊的外送/);
  assert.doesNotMatch(postPr, /ExternalDisclosureApproval/);

  const handoffStopHook = read(".devpro/scripts/hooks/stop-handoff-cite.mjs");
  assert.match(handoffStopHook, /checkStopPointHandoffShape/);
  assert.match(handoffStopHook, /DEVPRO_DISABLE_STOP_POINT_HANDOFF_SHAPE_GATE/);

  assert.match(stopHook, /Agent-facing next step \(not a user prompt\):/);
  assert.match(stopHook, /const nextStepLines = \[[\s\S]*Agent-facing next step \(not a user prompt\):/);
  assert.match(stopHook, /Post-PR completion gate still pending[\s\S]*soft reminder[\s\S]*\.\.\.nextStepLines/);
  assert.match(stopHook, /hard-block[\s\S]*\.\.\.nextStepLines/);
  assert.match(stopHook, /Status: blocked/);
  assert.match(stopHook, /Owner: TL\/reviewer/);
  assert.doesNotMatch(stopHook, /Disclosure: same-repo PR|overlay 收緊外送/);
  assert.doesNotMatch(stopHook, /Approval requirement:/);
  assert.match(stopHook, /Next action:/);
  assert.match(stopHook, /\/devpro:cross-review <PR#>/);
  assert.match(stopHook, /Unblock condition:/);
  assert.match(stopHook, /ready \/ complete \/ mergeable/);
  assert.match(stopHook, /verdict: PASS/);
  assert.match(stopHook, /last_reviewed_sha == headRefOid/);
  assert.match(stopHook, /WARN.*completion receipt.*無 current fault/s);
});

test("final response gate requires parseable fresh sticky before ready/complete claim", () => {
  const leaf = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const codexReviewer = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  const prePr = read(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md");
  const stopHook = read(".devpro/scripts/hooks/post-pr-completion-check.mjs");
  const postTool = read(".devpro/scripts/hooks/post-tool-gate.mjs");

  for (const body of [leaf, codexReviewer, prePr]) {
    assert.match(body, /headRefOid/);
    assert.match(body, /last_reviewed_sha.*等於.*headRefOid|last_reviewed_sha == headRefOid/);
    assert.match(body, /PASS.*WARN/s);
    assert.match(body, /UNAVAILABLE.*blocked|UNAVAILABLE.*block|UNAVAILABLE.*不可宣告 ready|UNAVAILABLE.*不得宣告 ready/s);
    assert.match(body, /CRITICAL.*blocked|CRITICAL.*不可宣告 ready/s);
    assert.match(body, /stale sha|stale/);
    assert.match(body, /\/devpro:cross-review <PR#>/);
  }

  assert.match(stopHook, /resolveStickyFreshness/);
  assert.match(stopHook, /parseStickyVerdict/);
  assert.match(stopHook, /parseStickyLastReviewedSha/);
  assert.match(stopHook, /headRefOid/);
  assert.match(stopHook, /last_reviewed_sha === headRefOid/);
  assert.match(stopHook, /reviewedHeadRefOid/);
  assert.match(postTool, /Do not clear post-PR completion markers merely because/);
  assert.match(postTool, /Freshness requires PR headRefOid comparison/);
});

test("repeated post-pr visibility violations belong to the completion gate", () => {
  const leaf = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const workflow = read(".devpro/agent-rules/git-workflow-tracking.md");

  assert.match(leaf, /重複違反/);
  assert.match(leaf, /六軸 Critical/);
  assert.match(leaf, /completion gate 是交付契約/);
  assert.doesNotMatch(workflow, /重複違反 → 下次同類審查升級/);
  assert.doesNotMatch(workflow, /五軸 Critical/);
});

test("stop points require a next-step contract before the agent pauses", () => {
  const agents = read("AGENTS.md");
  const autonomy = read(".devpro/agent-rules/ai-autonomy.md");
  const workflow = read(".devpro/agent-rules/git-workflow-tracking.md");
  const postPr = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const sessionStart = read(".devpro/scripts/hooks/session-start.mjs");
  const spec = readFirst([
    "openspec/changes/rationalize-agents-readme-ssot/specs/openspec-flow/spec.md",
    "openspec/changes/enforce-next-step-on-stop/specs/openspec-flow/spec.md",
    "openspec/specs/openspec-flow/spec.md",
  ]);

  assert.match(agents, /next step/);
  assert.match(agents, /owner/);
  assert.match(sessionStart, /為什麼停／要你做什麼／回了會怎樣/);
  assert.match(sessionStart, /選項編號且末項開放/);

  for (const body of [autonomy, workflow, postPr]) {
    assert.match(body, /Stop-Point Next Step Contract/);
  }

  for (const body of [autonomy, spec]) {
    assert.match(body, /目前狀態|current state/);
    assert.match(body, /阻塞\/依賴|blocker or dependency/);
    assert.match(body, /下一個 AI-actionable step|next AI-actionable step/);
    assert.match(body, /owner/);
    assert.match(body, /continuation|continuing now|waiting/);
    assert.match(body, /unblock condition|具體輸入|外部狀態/);
    assert.match(body, /PR opened|PR creation or merge success alone|只回「PR opened」|只回「PR 已建立/s);
  }

  assert.match(autonomy, /`AskFirstPending` .*不得取代上述五項/);
  assert.match(autonomy, /Turn-end owner check/);
  assert.match(autonomy, /本 turn 結束後誰持球/);
  assert.match(autonomy, /agent-facing next step/);
  assert.match(autonomy, /worktree \/ change 已完成但尚未 commit \/ push \/ PR/);
  assert.match(autonomy, /不可只用 `AskFirstPending: git add\/commit\/push` footer 收尾/);
  assert.match(spec, /Adapter footer fields such as `AskFirstPending`/);
  assert.match(spec, /MUST NOT satisfy this contract by themselves/);
  assert.match(spec, /AskFirstPending Footer Does Not Substitute For Stop-Point Contract/);
  assert.match(spec, /only lists `AskFirstPending: git add\/commit\/push`/);
  assert.match(spec, /User-Owned Stop Point Requires Numbered Options/);
  assert.match(spec, /Non-User Owner Does Not Ask Again/);

  assert.match(workflow, /PR-specific specialization/);
  assert.match(postPr, /PR create \/ merge 場景的具體格式/);
});

test("second reviewer direct PR read/write runs outside sandbox when required", () => {
  const leaf = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const checklist = read(".devpro/agent-rules/code-review-checklist.md") + "\n" +
    read(".devpro/agent-rules/code-review-cross-model.md");
  const codexReviewer = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  const spec = readFirst([
    "openspec/changes/fix-claude-cross-review-max-turns/specs/openspec-flow/spec.md",
    "openspec/specs/openspec-flow/spec.md",
  ]);

  for (const body of [leaf, checklist, codexReviewer]) {
    assert.match(body, /sandbox 外|non-sandbox \/ host|non-sandbox\/host/);
    assert.match(body, /packet mode|review packet/);
    assert.match(body, /sandbox .*auth .*failure|auth failure|auth 失敗|auth\/session/);
  }

  assert.match(codexReviewer, /MUST NOT 在 Codex sandbox 內跑 `claude auth status` 或 `claude -p`/);
  assert.match(codexReviewer, /TL 不得在 sandbox 內跑 host-auth CLI 模式/);
  assert.match(codexReviewer, /`git fetch\/pull\/push`/);
  assert.match(codexReviewer, /`gh auth status` \/ `gh api` \/ `gh pr comment`/);
  assert.match(codexReviewer, /`claude auth status` \/ `claude -p`/);
  assert.match(codexReviewer, /TL 必須改走 non-sandbox \/ host runner/);
  assert.match(codexReviewer, /Claude Code CLI 需要 host-level auth\/session \+ bounded GitHub write-back surface/);
  assert.match(codexReviewer, /ReviewerSurface=host-outside/);
  assert.match(codexReviewer, /MUST NOT 再附加 sandbox-escalation wrapper/);
  assert.match(codexReviewer, /approval\/sandbox 斷點/);
  assert.match(codexReviewer, /approved prefix .*不算 host\/outside evidence|approved prefix .*不算 host surface evidence/s);
  assert.match(codexReviewer, /prefix_rule[\s\S]*不算 host\/outside evidence|prefix_rule[\s\S]*不算 host surface evidence/);
  assert.match(checklist, /prefix[\s\S]*(不等於|≠) host\/outside/);
  assert.match(leaf, /prefix[\s\S]*(不等於|≠) host\/outside/);
  assert.match(leaf, /host-auth CLI/);
  assert.match(leaf, /sandbox 只准 no-auth probes/);
  assert.match(leaf, /不得.*加 sandbox-escalation wrapper/);
  assert.match(spec, /Codex-host Claude packet mode SHALL require the Claude Code CLI to run outside the Codex sandbox/);
  assert.match(spec, /Host-auth\/session\/network CLI modes/);
  assert.match(spec, /non-sandbox \/ host runner surface/);
  assert.match(spec, /MUST NOT add a sandbox-escalation wrapper/);
  assert.match(spec, /Sandbox-only CLI auth failure SHALL NOT|sandbox-only CLI auth failure SHALL NOT/);
  // "TL must not author/rewrite reviewer findings" is a leaf-owned contract.
  // Previously asserted on the Stop hook message (restated verbatim there);
  // now bound to the leaf so the hook message can stay compact.
  assert.match(leaf, /TL 不得.*撰寫\/改寫\/補完 reviewer-produced findings|TL 不得.*撰寫.*reviewer-produced findings/);
});

test("Codex Claude second reviewer defaults to packet mode and self-write sticky", () => {
  const leaf = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const codex = read(".devpro/agent-rules/platform-adapters/codex.md");
  const codexReviewer = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  const claudeAdapter = read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md");
  const flowSpec = readFirst([
    "openspec/changes/fix-consumer-source-corpus-routing/specs/openspec-flow/spec.md",
    "openspec/changes/fix-claude-cross-review-max-turns/specs/openspec-flow/spec.md",
    "openspec/specs/openspec-flow/spec.md",
  ]);
  const paritySpec = readFirst([
    "openspec/changes/fix-consumer-source-corpus-routing/specs/cross-runtime-parity/spec.md",
    "openspec/changes/fix-claude-cross-review-max-turns/specs/cross-runtime-parity/spec.md",
    "openspec/specs/cross-runtime-parity/spec.md",
  ]);

  for (const body of [codex, codexReviewer, paritySpec]) {
    assert.match(body, /claude -p/);
    assert.match(body, /stream-json/);
    assert.match(body, /include-partial-messages/);
    assert.match(body, /schema-valid|first .*verdict|第一個.*verdict/s);
    assert.match(body, /error_max_turns/);
    assert.match(body, /review packet mode|packet mode/);
    assert.match(body, /self-write|自行.*sticky|Claude .*sticky/s);
  }

  for (const body of [codexReviewer, claudeAdapter, paritySpec]) {
    assert.match(body, /gh api/);
    assert.doesNotMatch(body, /--allowedTools "[^"\n]*Bash\(gh pr comment:\*\)/);
    assert.match(body, /bounded PR|bounded .*allowlist|PR read\/diff\/comment\/API/);
    assert.match(body, /repo write|repo file write/);
    assert.match(body, /git add[\s\S]*git commit[\s\S]*git push|commit \/ push \/ merge/s);
    assert.match(body, /Tool: Claude Code|Claude Code CLI (as the sticky writer|itself)/);
    assert.match(body, /actual model|actual Claude model|reviewer_model/);
    assert.match(body, /completion JSON|compact completion/);
  }

  assert.match(codexReviewer, /error_max_turns/);
  assert.match(codexReviewer, /requires approval/);
  assert.match(codexReviewer, /permission_denials|permission denial/);
  assert.match(codexReviewer, /不得只調 `--max-turns` 反覆重跑/);
  assert.match(codexReviewer, /不得把 Claude output 交由 TL 代貼|TL 只能驗證/s);

  for (const body of [codexReviewer, claudeAdapter, flowSpec, paritySpec]) {
    assert.match(body, /stdin\/file-backed|stdin or file-backed/);
    assert.match(body, /(?:allowlist flags|--allowedTools)[\s\S]*stdin\/file-backed|stdin\/file-backed[\s\S]*(?:allowlist flags|--allowedTools)/s);
    assert.match(body, /--allowedTools <tools\.\.\.>[\s\S]*variadic/);
    assert.match(body, /--bare/);
    assert.match(body, /Bash\(gh api:\*\)/);
    assert.match(body, /sticky_write_exact_recipe|write-second-review-sticky-gated\.mjs|gated sticky write CLI/);
    assert.match(body, /禁止 raw `gh api` POST\|PATCH `body=@`|NEVER raw `gh api` POST\|PATCH `body=@`|NEVER raw `gh api`/);
    assert.match(body, /exact zero|zero candidates|0 candidates|0 →|0 則/i);
    assert.match(body, /exact one|one candidate|1 candidate|1 →|candidate count=`1`|1 則/i);
    assert.match(body, /more than one|more-than-one|>1/);
    assert.match(body, /read-back|readback|exact-comment GET/i);
    assert.match(body, /block the current invocation|current invocation.*block|本次 invocation.*blocked/is);
    assert.match(body, /new lineage-bound dispatch|new dispatch|新 ?dispatch/i);
    assert.doesNotMatch(body, /gh (?:pr|api)[^`\n]*\$(?:GH_REPO|DEVPRO_REVIEW_PR_NUMBER)/);
    assert.doesNotMatch(body, /`gh api[^`\n]*--repo\b/);
    assert.match(body, /current neutral cwd|current-neutral-cwd body file/);
    assert.match(body, /heredoc[\s\S]*redirection[\s\S]*inline `--body`/);
  }

  for (const body of [codexReviewer, claudeAdapter, paritySpec]) {
    assert.match(body, /529 overloaded[\s\S]*provider transient/);
  }

  for (const body of [leaf, flowSpec]) {
    assert.match(body, /requires approval/);
    assert.match(body, /permission_denials/);
    assert.match(body, /error_max_turns/);
    assert.match(body, /invocation\/orchestration evidence|invocation\/orchestration|orchestration evidence/);
    assert.match(body, /不是 `UNAVAILABLE`|not CLI unavailable/);
  }
});

test("Codex does not mistake long silent Claude reviewer run for a hang", () => {
  const codexReviewer = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  const paritySpec = read("openspec/specs/cross-runtime-parity/spec.md");

  for (const body of [codexReviewer, paritySpec]) {
    assert.match(body, /no[- ]stdout/);
    assert.match(body, /child process/);
    assert.match(body, /final JSON/);
    assert.match(body, /health probe/);
    assert.match(body, /single-result|single-result packet/);
  }
});

test("external reviewer evidence keeps execution-surface evidence separate and the retired disclosure framework is gone", () => {
  // Rule and adapter carriers only. The canonical specs under openspec/specs are aligned in the archive step.
  const postPr = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const prEvidence = read(".devpro/agent-rules/pr-review-evidence-verification.md");
  const claude = read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md");
  const codexReviewer = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  const carriers = { postPr, prEvidence, claude, codexReviewer };

  for (const [name, body] of Object.entries(carriers)) {
    assert.doesNotMatch(body, /§Second-review disclosure|採用即同意|adoption notice|採用告知|External Reviewer Disclosure Boundary/, `${name} must not carry the retired disclosure framework`);
    for (const retired of [/ExternalDisclosureApproval/, /grant-lite-disclosure/, /resolve-cross-review-approval-context/, /data-disclosure approval/, /lite batch grant/]) {
      assert.doesNotMatch(body, retired, `${name} must not revive ${retired}`);
    }
  }
  for (const [name, body] of Object.entries({ prEvidence, claude, codexReviewer })) {
    assert.match(body, /execution-surface|ReviewerSurface=host-outside|outside execution surface|host outside/, `${name} must keep execution-surface evidence`);
  }

  const surface = sliceSection(prEvidence, "### External Reviewer Execution Surface");
  assert.match(surface, /`ReviewerSurface=host-outside`[^\n]*only proves the execution surface \(host runner, approved prefix, tool allowlist\)/);
  assert.doesNotMatch(surface, /disclosure|adoption|notice|cross-repo|外送/i, "the execution-surface section says nothing about content scope");

  assert.doesNotMatch(postPr, /^\d+\. \*\*External disclosure\*\*/m, "post-pr gate carries no External disclosure item");
  assert.match(postPr, /owner=TL\/reviewer|TL\/reviewer/);
});

test("Codex-host Claude reviewer packet defaults to stdin or file-backed input", () => {
  const claude = read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md");
  const codexReviewer = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  const flowSpec = read("openspec/specs/openspec-flow/spec.md");
  const paritySpec = read("openspec/specs/cross-runtime-parity/spec.md");

  for (const body of [claude, codexReviewer, flowSpec, paritySpec]) {
    assert.match(body, /stdin\/file-backed|stdin or file-backed/);
    assert.match(body, /MUST NOT inline|SHALL NOT inline|不得 inline|forbid inline/);
    assert.match(body, /long reviewer packet|長 reviewer packet|long packet/);
    assert.match(body, /hook.*prompt|prompt.*hook|PreToolUse.*prompt/s);
    assert.match(body, /`--input-file`.*probe|probe.*`--input-file`|do not assume `--input-file`/s);
    assert.doesNotMatch(body, /<short_review_packet>/);
    assert.doesNotMatch(body, /--\s*"<review_packet>"/);
  }
});

test("external reviewer CLI timeout is explicit and aligned across Claude and Codex", () => {
  const checklist = read(".devpro/agent-rules/code-review-checklist.md") + "\n" +
    read(".devpro/agent-rules/code-review-cross-model.md") + "\n" +
    read(".devpro/agent-rules/code-review-cross-model-cli-contract.md");
  const prEvidence = read(".devpro/agent-rules/pr-review-evidence-verification.md");
  const claude = read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md");
  const codex = read(".devpro/agent-rules/platform-adapters/codex.md");
  const codexReviewer = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  const promotedSpecs = read("openspec/specs/code-review-checklist/spec.md") + "\n" +
    read("openspec/specs/openspec-flow/spec.md");

  for (const body of [checklist, prEvidence, claude, codex, codexReviewer]) {
    assert.match(body, /60s/);
    assert.match(body, /15m/);
    assert.match(body, /30m|30-minute|30 分鐘/);
    assert.match(body, /checkpoint|檢查點/);
    assert.match(body, /callback|process close|程序關閉/i);
    assert.match(body, /streaming|progress|single-result|單次結果|單一結果/);
  }

  assert.match(checklist, /single-result mode|單次結果模式|單一結果模式/);
  assert.match(checklist, /MUST NOT.*no stdout|不得.*stdout.*判定.*hang|不得.*沉默.*hang/s);
  assert.match(checklist, /total hard cap.*30m|30m.*total hard cap|30-minute total hard cap/s);
  assert.match(checklist, /final-verify PR sticky|final sticky verification|verify PR sticky freshness before declaring timeout\/fallback|timeout\/fallback\/kill.*sticky/s);
  assert.match(claude, /single-result|單次結果|單一結果/);
  assert.match(codex, /streaming|progress|single-result|單次結果|單一結果/);
  assert.match(codexReviewer, /total hard cap `30m`/);
  assert.match(claude, /Quick Review \/ packet mode/);
  assert.match(claude, /Deep Review \/ interactive mode/);
  assert.match(codexReviewer, /Deep Review\/tmux/);
  assert.doesNotMatch(codexReviewer, /no-total-timeout as the remedy|no total timeout as the remedy/i);
  assert.match(promotedSpecs, /single-result[^\n]{0,220}(?:30m|30-minute)|(?:30m|30-minute)[^\n]{0,220}single-result/i);
  assert.doesNotMatch(
    [checklist, prEvidence, claude, codex, codexReviewer, promotedSpecs].join("\n"),
    /total hard cap `15m`|`15m` total hard cap|15-minute total hard cap/i
  );
  assert.doesNotMatch(promotedSpecs, /wall-clock cap|wall cap|wall-cap/);
});

test("Hermes-style reviewer liveness prefers activity heartbeat over stdout-only checks", () => {
  const checklist = read(".devpro/agent-rules/code-review-checklist.md") + "\n" +
    read(".devpro/agent-rules/code-review-cross-model.md") + "\n" +
    read(".devpro/agent-rules/code-review-cross-model-cli-contract.md");
  const postPr = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const claude = read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md");
  const codex = read(".devpro/agent-rules/platform-adapters/codex.md");
  const codexReviewer = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  const codeReviewSpec = read("openspec/specs/code-review-checklist/spec.md");
  const paritySpec = read("openspec/specs/cross-runtime-parity/spec.md");

  for (const body of [checklist, postPr, claude, codex, codexReviewer, codeReviewSpec, paritySpec]) {
    assert.match(body, /activity heartbeat|heartbeat/);
    assert.match(body, /structured progress|structured event|progress event|heartbeat 優先/);
    assert.match(body, /stdout.*fallback|fallback.*stdout|stdout 只作 fallback|stdout silence.*health probe/s);
  }

  assert.match(codeReviewSpec, /Progress-capable reviewer liveness uses activity evidence/);
});

test("single-result reviewer mode still monitors stdout stderr and process health", () => {
  const checklist = read(".devpro/agent-rules/code-review-checklist.md") + "\n" +
    read(".devpro/agent-rules/code-review-cross-model.md") + "\n" +
    read(".devpro/agent-rules/code-review-cross-model-cli-contract.md");
  const postPr = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const claude = read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md");
  const codex = read(".devpro/agent-rules/platform-adapters/codex.md");
  const codexReviewer = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  const codeReviewSpec = read("openspec/specs/code-review-checklist/spec.md");
  const paritySpec = read("openspec/specs/cross-runtime-parity/spec.md");

  for (const body of [checklist, postPr, claude, codex, codexReviewer, codeReviewSpec, paritySpec]) {
    assert.match(body, /stdout/);
    assert.match(body, /stderr/);
    assert.match(body, /child[- ]process|process lifecycle/);
    assert.match(body, /health probe|health probes/);
  }

  for (const body of [checklist, claude, codex, codexReviewer, codeReviewSpec, paritySpec]) {
    assert.match(body, /fail fast/);
    assert.match(body, /spawn|early.*exit|early-exit/);
  }

  assert.match(codeReviewSpec, /Concrete reviewer CLI faults fail fast/);
  assert.match(codexReviewer, /no stdout.*health probe|health probe.*no stdout/s);
});

test("external marker disposition is a single resolver with a non-accept-pointing retain path", () => {
  const leaf = read(".devpro/agent-rules/post-pr-completion-gate.md");

  // Structural: the disposition bullet and its three outcomes must all exist.
  assert.match(leaf, /\*\*External marker disposition\*\*/, "external marker disposition bullet 遺失");
  assert.match(leaf, /`clear_policy`/);
  assert.match(leaf, /`clear_verified`/);
  assert.match(leaf, /`retain`/);
  assert.match(leaf, /Stop gate MUST 先以穩定 runtime\/session ID 選定本 session 建立或明確接手的 PR/);
  assert.match(leaf, /相同 branch、worktree 或 repo 不是 ownership 證據/);
  assert.match(leaf, /其他 session 的 marker 只留診斷，不自動提醒／阻擋，也不作 network probe 或清理/);
  assert.match(leaf, /`post-pr-marker-disposition\.md` §External marker disposition/, "entry must point at the leaf holding the full disposition conditions");

  // The full disposition conditions and the blocked-message routing live in the on-demand leaf.
  const dispositionLeaf = read(".devpro/agent-rules/post-pr-marker-disposition.md");
  assert.match(dispositionLeaf, /accept-external-second-review\.mjs <packet-dir>/);
  const leafLines = leaf.split("\n");
  const dispositionLeafLines = dispositionLeaf.split("\n");
  const dispositionLine = dispositionLeafLines.find((line) => line.includes("**External marker disposition**"));
  assert.ok(dispositionLine, "External marker disposition line 遺失");
  assert.match(dispositionLine, /`clear_verified`（`readDispatchEvidenceStrict` 得 slot `accepted`＋external completion receipt/);
  assert.match(dispositionLine, /snapshot 當前 PR head＝record `head_ref_oid`＝receipt `sticky_last_reviewed_sha`＝當前 sticky `last_reviewed_sha` 四者相等/);
  assert.match(dispositionLine, /body sha256 相符、verdict∈PASS｜WARN、footer 相符/);
  assert.match(dispositionLine, /無 slot／accepted 缺收據 → 指令 `node \.devpro\/scripts\/accept-external-second-review\.mjs <packet-dir>`/);
  assert.match(dispositionLine, /已驗收但不符（含 head 不一致）、CRITICAL／UNAVAILABLE、voided → 指示重新發行審查單（不指向 accept）/);

  const finalBlockerLine = leafLines.find((line) => line.includes("final blocker"));
  assert.ok(finalBlockerLine, "final blocker line 遺失");
  assert.match(finalBlockerLine, /未 accept 的自寫 PASS 不通過/);
  assert.match(finalBlockerLine, /WARN 不要求 `process_close_observed`/);

  // Polarity-sensitive, same physical line: an already-accepted-but-mismatched /
  // CRITICAL / UNAVAILABLE / voided retain state MUST route to re-issuing a new
  // ticket, NOT to the accept helper — a silent flip ("指向 accept") would send
  // TL toward a command that can only ever re-confirm already_accepted.
  const reissueLine = dispositionLeafLines.find((l) => /重新發行審查單/.test(l));
  assert.ok(reissueLine, "重新發行審查單 分支行遺失");
  assert.match(
    reissueLine,
    /重新發行審查單（不指向 accept）/,
    "重新發行審查單分支必須在同一行明示不指向 accept helper"
  );
});

test("post-PR leaf preserves Path D′ bookkeeping and Path F merge-gate boundaries", () => {
  const leaf = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const crossModel = read(".devpro/agent-rules/code-review-cross-model.md");
  const leafLines = leaf.split("\n");
  const crossModelLines = crossModel.split("\n");

  const headMovementLine = leafLines.find((line) => line.includes("head movement ordering"));
  assert.ok(headMovementLine, "head movement ordering line 遺失");
  assert.match(headMovementLine, /whitelist-only bookkeeping diff 依 Path D′ 視同 fresh/);
  assert.match(headMovementLine, /fast-forward\/ancestor proof is traceability only, not marker-clear\/merge readiness/);

  const pathDPrimeLine = crossModelLines.find((line) => line.startsWith("- **Path D′"));
  assert.ok(pathDPrimeLine, "Path D′ definition 遺失");
  assert.match(pathDPrimeLine, /\*\*只\*\*觸及 `openspec\/changes\/\*\*` 與 `notes\/\*\*`/);
  assert.match(pathDPrimeLine, /路徑\*\*不含\*\* `specs` path segment/);
  assert.match(pathDPrimeLine, /任一檔在白名單外 → 回退 Path D block（fail closed/);

  const pathFLine = crossModelLines.find((line) => line.startsWith("- **Path F**"));
  assert.ok(pathFLine, "Path F definition 遺失");
  assert.match(pathFLine, /exactly one parseable canonical sticky `verdict: PASS \| WARN`/);
  assert.match(pathFLine, /`last_reviewed_sha == headRefOid`/);
  assert.match(pathFLine, /與post-PR marker\/fault\/receipt evidence獨立/);

  const changeContextLine = leafLines.find((line) => line.startsWith("`ChangeContext`"));
  assert.ok(changeContextLine, "ChangeContext contract line 遺失");
  assert.match(changeContextLine, /\*\*不是\*\* Path F／`checkCrossModelMergeGate`／merge-gate 替代/);
  const manualTestLine = leafLines.find((line) => line.startsWith("`ManualTest`"));
  assert.ok(manualTestLine, "ManualTest contract line 遺失");
  assert.match(manualTestLine, /\*\*不是\*\* Path F／merge-gate 替代/);
});

test("rule-feedback #2911 R2: post-PR leaf assertions stay bound to executable regressions", () => {
  const leaf = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const externalDispositionTests = read(".devpro/scripts/tests/hook-post-pr-completion-external-disposition.test.mjs");
  const acceptHelperTests = read(".devpro/scripts/tests/accept-external-second-review.test.mjs");
  const pathDPrimeTests = read(".devpro/scripts/tests/hook-post-pr-completion-path-d-prime.test.mjs");
  const mergeGateTests = read(".devpro/scripts/tests/hook-pre-tool-gate-cross-model-merge.test.mjs");

  const leafLines = leaf.split("\n");
  const dispositionLine = read(".devpro/agent-rules/post-pr-marker-disposition.md")
    .split("\n")
    .find((line) => line.includes("**External marker disposition**"));
  const finalBlockerLine = leafLines.find((line) => line.includes("- final blocker"));
  const freshnessLine = leafLines.find((line) => line.includes("Path D′ fresh-equivalent"));
  const mergeGateLine = leafLines.find((line) => line.includes("merge hard gate"));

  assert.ok(dispositionLine, "external marker disposition leaf assertion must remain discoverable");
  assert.match(dispositionLine, /`clear_verified`[\s\S]*slot `accepted`[\s\S]*external completion receipt/);
  assert.match(dispositionLine, /accept-external-second-review\.mjs <packet-dir>/);
  assert.match(dispositionLine, /重新發行審查單（不指向 accept）/);
  assert.ok(finalBlockerLine, "external evaluator final-blocker assertion must remain discoverable");
  assert.match(finalBlockerLine, /未 accept 的自寫 PASS 不通過/);
  assert.ok(freshnessLine, "post-PR leaf must retain its Path D′ freshness contract");
  assert.ok(mergeGateLine, "post-PR leaf must keep Path F as a separate merge gate");
  assert.match(mergeGateLine, /checkCrossModelMergeGate/);

  // Bind the leaf assertions to the existing behavior tests instead of
  // duplicating the clear, acceptance, Path D′, and Path F scenarios here.
  assert.match(externalDispositionTests, /EXT-DISPOSITION-3: accepted PASS receipt matching the live sticky clears the marker \(clear_verified\)/);
  assert.match(externalDispositionTests, /EXT-DISPOSITION-5: no closure slot yet retains the marker with an accept-helper Blocked message/);
  assert.match(externalDispositionTests, /EXT-DISPOSITION-13: accepted slot with a missing completion receipt retains/);
  assert.match(acceptHelperTests, /accept-external-second-review accepts a fresh create-disposition ticket/);
  assert.match(pathDPrimeTests, /PDPP-1 \(a′\): head advanced H1→H2 by a whitelist-only bookkeeping commit/);
  assert.match(mergeGateTests, /CM-8: Path F-PASS — verdict PASS \+ sha aligned → pass/);
  assert.match(mergeGateTests, /CM-9: Path F-WARN — verdict WARN \+ sha aligned → pass/);
});

test("Shared Gate point 6 aligns 回覆結尾 wording with the Blocked/Ready contract sections (T7/S5)", () => {
  const leaf = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const leafLines = leaf.split("\n");

  // Structural anchor: whole-line match on Shared Gate point 6 (Post-PR handoff)
  // so this stays bound to that specific line, not any other 結尾 mention.
  const postPrHandoffLine = leafLines.find((l) => /^6\. \*\*Post-PR handoff\*\*/.test(l));
  assert.ok(postPrHandoffLine, "Shared Gate 第 6 點（Post-PR handoff）行遺失");
  assert.match(
    postPrHandoffLine,
    /回覆結尾 MUST 依 `stop-point-comms\.md` 給/,
    "第 6 點須補回「結尾」二字，對齊 Ready/Blocked Response Next-Step Contract 既有措辭"
  );
});

test("every carrier that lists closed predecessors names the operator-slot recovery terminals the code accepts", async () => {
  const { TERMINAL_RECEIPT_OUTCOME_CLASSIFICATIONS } = await import(
    pathToFileURL(repoPath(".devpro/scripts/hooks/lib/second-review-control-evidence.mjs")).href
  );
  const operatorSlotTerminals = [
    ...TERMINAL_RECEIPT_OUTCOME_CLASSIFICATIONS.operator_abandonment,
    ...TERMINAL_RECEIPT_OUTCOME_CLASSIFICATIONS.stale_reservation_closure,
  ];
  assert.deepEqual(operatorSlotTerminals, ["operator_abandoned_pre_spawn", "stale_reservation_closed_pre_spawn"]);

  const rule = read(".devpro/agent-rules/second-review-control-evidence.md");
  for (const classification of operatorSlotTerminals) {
    assert.ok(rule.includes(`\`${classification}\``), `${classification} must be named by the control-evidence rule`);
  }
  assert.doesNotMatch(
    rule,
    /唯一操作者 recovery class/u,
    "operator recovery classes are two exclusive classes, so the rule must not call either one the only class",
  );
  assert.doesNotMatch(
    rule,
    /(?:^|\n)- PR #2927 stale recovery 另有/u,
    "the stale class is listed beside the operator class, not as an extra outside the enumeration",
  );

  // The five-form predecessor sentence must keep naming the operator-slot terminals as part of
  // the closed-terminal form, so a reader of any single carrier sees the same accepted set.
  const predecessorSentences = [
    [".devpro/agent-rules/second-review-control-evidence.md", /舊dispatch恰有一種可接續evidence[^\n]*/u],
    [".devpro/agent-rules/post-pr-marker-disposition.md", /lifecycle durability：cross-head只接受[^\n]*/u],
    [".devpro/agent-rules/code-review-checklist.md", /cross-head predecessor恰為[^\n]*/u],
  ];
  // The entry keeps the durability constraints that apply to every marker clear, PASS included.
  const entryDurability = read(".devpro/agent-rules/post-pr-completion-gate.md")
    .split("\n")
    .find((line) => line.includes("- lifecycle durability："));
  assert.ok(entryDurability, "post-pr-completion-gate.md must keep the marker-clear durability constraints");
  assert.match(entryDurability, /含 authoritative PASS 清理/u);
  assert.match(entryDurability, /fsync parent directory/u);
  assert.match(entryDurability, /bounded-stale 且 provably-dead/u);
  for (const [file, pattern] of predecessorSentences) {
    const match = read(file).match(pattern);
    assert.ok(match, `${file} must carry the closed predecessor enumeration`);
    assert.match(match[0], /operator slot|operator_abandoned_pre_spawn/u, `${file} must include the operator-slot recovery terminals in the closed-terminal form`);
  }
  for (const file of [
    "openspec/specs/openspec-flow/spec.md",
    "openspec/changes/archive/2026-10-01-fix-post-pr-marker-non-ff-rebind/specs/openspec-flow/spec.md",
  ]) {
    const spec = read(file);
    assert.match(spec, /closed-terminal including the two operator-slot recovery terminals/u, `${file} enumeration`);
    assert.match(spec, /closed-terminal receipt \(runner-owned or operator-slot recovery\)/u, `${file} scenario`);
    assert.match(spec, /`operator_abandoned_pre_spawn` or `stale_reservation_closed_pre_spawn`/u, `${file} allowlist`);
  }
});

test("post-pr gate: no External disclosure item or overlay stop, and the blocked response names a TL owner by default", () => {
  const gate = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const shared = sliceSection(gate, "### Shared Gate");
  assert.equal(shared.split("\n").some((line) => /^\d+\. \*\*External disclosure\*\*/.test(line)), false, "Shared Gate has no External disclosure item");
  for (const retired of ["採用即同意", "採用告知", "overlay", "告知行", "lite batch grant", "grant-lite-disclosure", "ExternalDisclosureApproval", "approval_resolution"]) {
    assert.equal(gate.includes(retired), false, `post-pr gate must not carry ${retired}`);
  }
  const numbers = shared.split("\n").map((line) => line.match(/^(\d+)\. \*\*/)?.[1]).filter(Boolean).map(Number);
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7], "Shared Gate items are numbered 1-7 without a gap");
  const ownerLine = gate.split("\n").find((line) => line.startsWith("- `Owner:`"));
  assert.ok(ownerLine, "Blocked Response Owner line exists");
  assert.match(ownerLine, /預設 TL\/reviewer/);
  assert.match(ownerLine, /pr_repository_mismatch/);
});
