/**
 * Guarantee ceiling (cooperative-only).
 *
 * Locks: the cross-review CLI skill invocation anchors, dispatch rules and
 * host-projection field sets across the skills, rule leaves and `AGENTS.md`
 * routing.
 * Does NOT prove: that agents follow the locked wording, that a paraphrase with
 * the same meaning is handled correctly, or that the meaning around an intact
 * anchor has not been inverted. Deleting an anchor fails this file; inverting the
 * meaning around an intact anchor does not. Review owns that half.
 */

import { MODEL_PROBE_TIMEOUT_CEILING_MS, CODEX_MODEL_PROBE_TIMEOUT_MS } from "../highest-tier-reviewer-model.mjs";
import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { readSecondReviewSkillWithHostRoutes } from "./lib/second-review-skill.mjs";
import { readRepoFile as read } from "./lib/read.mjs";

const fullManifestDispatchSource = read(".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md");

function assertFullManifestDispatchRule(text) {
  const step = text.split("## Step 3: dp-reviewer dispatch (Six-Axis Review)")[1]?.split("## Step 5.5.3")[0];
  assert.ok(step, "Step 3 action point exists");
  const rows = step.split("\n").filter((line) => line.startsWith("- **Manifest refs after classification**:"));
  assert.equal(rows.length, 1, "exactly one operative post-classification manifest rule");
  const row = rows[0];
  assert.match(row, /`route=full`.*`repair_delta_manifest_ref`.*`dependency_closure_manifest_ref`.*MUST be exact `null`/u);
  assert.match(row, /already sealed.*full_reopen_reason/u);
  assert.match(row, /before dispatch.*reviewer MUST echo both as `null` in `receipt_payload.scope`/u);
  assert.match(row, /`route=bounded`.*MUST carry both non-null sealed refs/u);
}

test("full dispatch drops sealed manifest refs after classification at the Step 3 action point", () => {
  assertFullManifestDispatchRule(fullManifestDispatchSource);
});

test("full dispatch manifest rule rejects deletion and reversed polarity mutations", () => {
  const row = fullManifestDispatchSource.split("\n").find((line) => line.startsWith("- **Manifest refs after classification**:"));
  assert.ok(row);
  for (const mutation of [
    fullManifestDispatchSource.replace(row, ""),
    fullManifestDispatchSource.replace(row, row.replace("MUST be exact", "MUST NOT be exact")),
    fullManifestDispatchSource.replace(row, row.replace("dependency_closure_manifest_ref", "obsolete_manifest_ref")),
    fullManifestDispatchSource.replace(row, row.replace("before dispatch", "after capture")),
    fullManifestDispatchSource.replace(row, row.replace("reviewer MUST echo", "reviewer MUST NOT echo")),
    fullManifestDispatchSource.replace(row, row.replace("MUST carry both non-null", "MUST carry both null")),
  ]) assert.throws(() => assertFullManifestDispatchRule(mutation));
});

const selectorModule = await import("../select-claude-second-reviewer-effort.mjs");

// S4：Guard 強度邊界 caveat（`rule-anchor-guard-strength.md` §錨點作用域守則第 2 條的具體
// 示範之一）。本檔多處用 `^literal`／`^literal$`（`m` flag）做行首／整行錨定（declarationLineRegex
// / fieldDeclarationRegex / DISPATCH_BLOCK_REGISTRY 的 `anchor` 等）。這類行錨定刻意
// fail-closed 在以下情境：
// - 縮排：目標行前加任何空白（如巢狀進 list item）即不再匹配行首 `^`。
// - 重寫：同語意但物理行结构改變（如把單行 `key: value` 拆成兩行）即不再匹配。
// - CRLF：檔案若混入 `\r\n`，`$`（`m` flag）在 `\r` 前而非行尾終止，可能造成尾界誤判。
// - 尾隨空白：目標行尾多一個空白字元，`^value$` 的整行精確比對即不再匹配。
// 以上任一情境下 guard 轉紅是設計選擇——寧可要求作者手動同步 anchor，也不建立更寬鬆的
// fuzzy-match 而重新引入本檔意圖消除的偽陽風險。
const secondReviewerFullSuiteNotDefaultPattern =
  /(?:(?:預設不得|MUST NOT|not default)[\s\S]{0,180}(?:full suite[\s\S]{0,100}budget gate|budget gate[\s\S]{0,100}full suite))|(?:(?:full suite[\s\S]{0,100}budget gate|budget gate[\s\S]{0,100}full suite)[\s\S]{0,180}(?:不得[\s\S]{0,40}預設|not default))/i;
// Polarity locks for #1890 gap: forbidding only full suite/budget must not leave
// `--changed main` / multi-gate as an implicit default under pr-sticky / sticky-refresh.
const secondReviewerChangedMainNotDefaultPattern =
  /(?:(?:預設不得|MUST NOT|not default|非預設|non-default)[\s\S]{0,240}(?:--changed main|changed_main_or_tier))|(?:(?:--changed main|changed_main_or_tier)[\s\S]{0,240}(?:預設不得|MUST NOT|not default|非預設|non-default|不是預設))/i;
const secondReviewerMultiGateNotDefaultPattern =
  /(?:(?:預設不得|MUST NOT|not default|非預設|non-default)[\s\S]{0,200}multi[- ]?gate)|(?:multi[- ]?gate[\s\S]{0,200}(?:預設不得|MUST NOT|not default|非預設|non-default|不是預設))/i;
const secondReviewerChangedMainNotScopedPattern =
  /(?:--changed main[\s\S]{0,140}(?:is not scoped|不是 scoped|≠ scoped|非 scoped)|(?:not scoped rerun))/i;
const secondReviewerScopedNarrowerThanSuitePattern =
  /(?:narrower than|窄於)[\s\S]{0,100}(?:change-scoped|change.?scoped)|scoped_rerun_narrower_than_change_scoped_suite/i;
const claudeBareCanonicalRecipePattern =
  /--bare[^\n]{0,240}MUST NOT[^\n]{0,120}canonical recipe|MUST NOT[^\n]{0,240}--bare[^\n]{0,120}canonical recipe/;
const claudeAllowedToolsVariadicPattern = /--allowedTools <tools\.\.\.>[^\n]{0,240}variadic/;


function readIfExists(relPath) {
  const fullPath = repoPath(relPath);
  return existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
}

// Runtime skill discovery dirs (.claude/skills, .agents/skills) must hold
// only the single `devpro` entry (design D3, refactor-agent-skills-entry),
// resolving to the catalog root itself — never a per-skill link; absence of
// the discovery dir itself is fine.
function assertSkillDiscoveryDirIsSymlinksOnly(dirRelPath) {
  const dirAbs = repoPath(dirRelPath);
  if (!existsSync(dirAbs)) return;
  const sourceRootAbs = path.join(REPO_ROOT, ".devpro", "agent-skills");
  assert.deepEqual(
    readdirSync(dirAbs),
    ["devpro"],
    `${dirRelPath} must hold only the 'devpro' entry, not a per-skill link`
  );
  const entryAbs = path.join(dirAbs, "devpro");
  assert.equal(lstatSync(entryAbs).isSymbolicLink(), true, `${dirRelPath}/devpro must be a symlink`);
  assert.equal(
    realpathSync(entryAbs),
    realpathSync(sourceRootAbs),
    `${dirRelPath}/devpro must resolve to the catalog root itself`
  );
}

function sourceLineContainingAll(source, fragments) {
  return source.split(/\r?\n/).find((line) =>
    fragments.every((fragment) => line.includes(fragment))
  );
}

function uniqueSourceLineContainingAll(source, fragments, label) {
  const matchingLines = source.split(/\r?\n/).filter((line) =>
    fragments.every((fragment) => line.includes(fragment))
  );
  assert.equal(
    matchingLines.length,
    1,
    `${label} must resolve to exactly one operative line; found ${matchingLines.length}`,
  );
  return matchingLines[0];
}

function parseRendererBudgetValue(line, pattern, label) {
  assert.equal(typeof line, "string", `${label} operative line must exist`);
  const match = line.match(pattern);
  assert.ok(match, `${label} operative line must expose a parseable millisecond value`);
  const value = Number(match[1]);
  assert.equal(Number.isSafeInteger(value) && value > 0, true, `${label} must be a positive integer`);
  return value;
}

function parseRendererOuterWaitContract({ secondReviewerSkill, cursorAdapter, codexHostAdapter }) {
  const commonLine = uniqueSourceLineContainingAll(secondReviewerSkill, [
    "All-family renderer outer wait action point",
    "outer margin",
  ], "common renderer contract");
  const cursorLine = uniqueSourceLineContainingAll(cursorAdapter, [
    "Cursor `Shell`",
    "block_until_ms",
    "background renderer",
  ], "Cursor renderer contract");
  const codexLine = uniqueSourceLineContainingAll(codexHostAdapter, [
    "Render and validate before dispatch",
    "All-family renderer",
    "host/session wait budget",
    "background the renderer",
  ], "Codex-host renderer contract");

  return {
    outerMarginMs: parseRendererBudgetValue(
      commonLine,
      /plus a `(\d+)ms` outer margin/,
      "common outer margin",
    ),
    outerFloors: [
      [
        "common devpro:second-review skill",
        parseRendererBudgetValue(
          commonLine,
          /outer wait action point[^\n]*at least `(\d+)ms`/,
          "common renderer outer floor",
        ),
      ],
      [
        "Cursor adapter",
        parseRendererBudgetValue(
          cursorLine,
          /block_until_ms` \*\*≥\s*(\d+)\*\*/,
          "Cursor renderer outer floor",
        ),
      ],
      [
        "Codex-host adapter",
        parseRendererBudgetValue(
          codexLine,
          /host\/session wait budget MUST be \*\*≥\s*(\d+)ms\*\*/,
          "Codex-host renderer outer floor",
        ),
      ],
    ],
  };
}

function readSelectorProbeTimeoutCeilings(moduleNamespace) {
  const exportNames = [
    "HELP_PROBE_TIMEOUT_CEILING_MS",
    "FUNCTIONAL_PROBE_TIMEOUT_CEILING_MS",
  ];
  const missingExports = exportNames.filter(
    (exportName) => !Object.hasOwn(moduleNamespace, exportName),
  );
  assert.deepEqual(
    missingExports,
    [],
    `renderer containment basis must come from selector exports: ${missingExports.join(", ")}`,
  );
  return {
    helpCeilingMs: moduleNamespace.HELP_PROBE_TIMEOUT_CEILING_MS,
    functionalCeilingMs: moduleNamespace.FUNCTIONAL_PROBE_TIMEOUT_CEILING_MS,
  };
}

function assertRendererOuterWaitContainment({
  helpCeilingMs,
  functionalCeilingMs,
  codexModelCeilingMs = CODEX_MODEL_PROBE_TIMEOUT_MS,
  outerMarginMs,
  outerFloors,
}) {
  for (const [label, value] of [
    ["Codex model ceiling", codexModelCeilingMs],
    ["help ceiling", helpCeilingMs],
    ["functional ceiling", functionalCeilingMs],
    ["outer margin", outerMarginMs],
  ]) {
    assert.equal(Number.isSafeInteger(value) && value > 0, true, `${label} must be a positive integer`);
  }
  const requiredOuterFloorMs = Math.max(
    MODEL_PROBE_TIMEOUT_CEILING_MS + helpCeilingMs + (2 * functionalCeilingMs),
    codexModelCeilingMs,
  ) + outerMarginMs;
  for (const [label, outerFloorMs] of outerFloors) {
    assert.equal(
      Number.isSafeInteger(outerFloorMs) && outerFloorMs >= requiredOuterFloorMs,
      true,
      `${label} outer floor ${outerFloorMs}ms under-contains selector path ${requiredOuterFloorMs}ms `
        + `(model ${MODEL_PROBE_TIMEOUT_CEILING_MS}ms + help ${helpCeilingMs}ms + 2 * functional ${functionalCeilingMs}ms + margin ${outerMarginMs}ms)`,
    );
  }
  return requiredOuterFloorMs;
}

function assertAnchorsInOrder(content, anchors, label) {
  let cursor = 0;
  for (const anchor of anchors) {
    const index = content.indexOf(anchor, cursor);
    assert.notEqual(index, -1, `${label} missing ordered anchor after byte ${cursor}: ${anchor}`);
    cursor = index + anchor.length;
  }
}

// D1：section-bounded 切割共用 helper。terminator = min(下一個同級或更高級 heading,
// 呼叫端傳入的同檔下一個 sibling anchor, EOF)。anchor 若非 markdown heading（level 0，
// 散文／粗體 anchor），其「同級」定義為**目前所在 heading 段落的 enclosing level**（I1）：
// 只有 level ≤ enclosing level 的 heading 才 terminate，同段落內部更深層的 heading（如
// 干擾用的 `#### 正確做法` 範例小節）不得把 slice 提前截斷。若 anchor 之前完全沒有 heading
// （enclosing level 為 null），沿用舊行為：任何 heading 皆 terminate。
// S2：`headingLevel` 逐行掃描不跳過 fenced code block 內容——若某 dispatch fence 內剛好有一行
// 以 `#` 開頭（如 shell 註解或 markdown 範例），會被誤判成 heading 而提前 terminate。此限制是
// 刻意 fail-closed，非疏漏：提早 terminate 只會讓下游 fenced-block 計數 `!== 1`（或 I1 情境下
// `!== 2`）觸發既有的 fail-closed 分支並回報明確錯誤，不會靜默放行錯誤內容；修正需要完整
// fence-aware 掃描器，超出本次 remediation 範圍，故只記錄限制、不展開實作。
function headingLevel(line) {
  const m = line.match(/^(#+)\s/);
  return m ? m[1].length : 0;
}

// I1：找 anchorStart 之前最近一個 heading 行的 level；若 anchor 之前完全沒有 heading，回傳
// null（呼叫端據此回退到「任何 heading 皆 terminate」）。
function enclosingHeadingLevel(source, anchorStart) {
  let level = null;
  for (const line of source.slice(0, anchorStart).split("\n")) {
    const lvl = headingLevel(line);
    if (lvl > 0) level = lvl;
  }
  return level;
}

function fencedBlockRanges(source) {
  const ranges = [];
  const fenceRe = /^```.*$/gm;
  let openStart = null;
  let match;
  while ((match = fenceRe.exec(source)) !== null) {
    const lineEnd = source.indexOf("\n", match.index);
    const fenceEnd = lineEnd === -1 ? source.length : lineEnd + 1;
    if (openStart === null) {
      openStart = match.index;
    } else {
      ranges.push([openStart, fenceEnd]);
      openStart = null;
    }
  }
  return ranges;
}

function indexInsideRanges(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function sliceSection(source, anchorRegex, siblingAnchorRegexes = []) {
  const anchorMatch = anchorRegex.exec(source);
  if (!anchorMatch) {
    throw new Error(`sliceSection: anchor 不匹配（${anchorRegex}）`);
  }
  const anchorStart = anchorMatch.index;
  const anchorLineEnd = source.indexOf("\n", anchorStart);
  const anchorLine = source.slice(anchorStart, anchorLineEnd === -1 ? source.length : anchorLineEnd);
  const anchorLevel = headingLevel(anchorLine);
  const enclosingLevel = anchorLevel === 0 ? enclosingHeadingLevel(source, anchorStart) : null;
  const bodyStart = anchorLineEnd === -1 ? source.length : anchorLineEnd + 1;

  let terminatorIndex = source.length;

  // 下一個同級或更高級 heading。anchorLevel === 0 時，「同級或更高級」改為
  // 「level ≤ enclosing level」（enclosing level 為 null 時退回任何 heading 皆 terminate）。
  // Fenced code block 內的 heading-like 行不是 markdown section boundary；若把它當邊界，
  // decoy fence 可以在真正 dispatch fence 前截斷 section，讓 fail-closed block count 失效。
  let insideFence = false;
  let cursor = bodyStart;
  for (const line of source.slice(bodyStart).split("\n")) {
    if (line.startsWith("```")) {
      insideFence = !insideFence;
    } else if (!insideFence) {
      const lvl = headingLevel(line);
      const terminates =
        anchorLevel === 0 ? enclosingLevel === null || lvl <= enclosingLevel : lvl <= anchorLevel;
      if (lvl > 0 && terminates) {
        terminatorIndex = Math.min(terminatorIndex, cursor);
        break;
      }
    }
    cursor += line.length + 1;
  }

  // 同檔下一個 registry sibling anchor（呼叫端傳入；只取落在 bodyStart 之後的匹配）。
  const fenceRanges = fencedBlockRanges(source);
  for (const siblingRegex of siblingAnchorRegexes) {
    const flags = siblingRegex.flags.includes("g") ? siblingRegex.flags : `${siblingRegex.flags}g`;
    const re = new RegExp(siblingRegex.source, flags);
    re.lastIndex = bodyStart;
    let siblingMatch;
    while ((siblingMatch = re.exec(source)) !== null) {
      if (siblingMatch.index >= terminatorIndex) break;
      if (siblingMatch.index >= bodyStart && !indexInsideRanges(siblingMatch.index, fenceRanges)) {
        terminatorIndex = siblingMatch.index;
        break;
      }
      if (re.lastIndex === siblingMatch.index) re.lastIndex += 1;
    }
  }

  return source.slice(anchorStart, terminatorIndex);
}

// I6：section 內 fenced block 抽取 — 主迴圈與 T1 prove-it 的「退化偵測」半邊 MUST 呼叫同一個
// 函式，而非各自重寫等價 regex；否則 prove-it 只驗證「自己重寫的邏輯」而非「main 迴圈實際會跑
// 到的程式碼路徑」，落地時兩者悄悄分岔也不會被 regression 抓到。
function fencedBlocksInSection(section) {
  return section.match(/```\n[\s\S]*?\n```/g) || [];
}

// D3：宣告行值與散文片語的 token 邊界 helper（T3）。
function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function declarationLineRegex(literal) {
  // 宣告行值（`key: value`）：整行精確比對（`^literal$`，`m` flag）——延長後綴（如
  // `claude` → `claude-legacy`）會因為行尾 `$` 而不再匹配，杜絕「照抄再加尾綴」的
  // dead-assertion 漏洞。
  return new RegExp(`^${escapeRegExp(literal)}$`, "m");
}

function fieldDeclarationRegex(field) {
  // 欄位宣告（僅鎖欄位名，值本身可變）：行首錨定（`^field`，`m` flag）——欄位名不得
  // 出現在同 block 的散文段落中被「代償」。
  return new RegExp(`^${escapeRegExp(field)}`, "m");
}

function phraseBoundaryRegex(phrase) {
  // 散文片語：尾界用 `(?![\w-])` 而非 `\b`——CJK 字元相鄰時 `\b` 不可靠。
  return new RegExp(`${escapeRegExp(phrase)}(?![\\w-])`);
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

function assertProjectionProbeAnchors(content, label) {
  const anchors = [
    "cli_probe_result_path",
    "reviewer_cli_recipe",
    "required_invocation_args",
    "--verbose",
    "required_activity_events",
    "cli-probe-result.json",
    "projection_bootstrap_script",
    "projection_bootstrap_command",
    "projection_runner_script",
    "projection_runner_command",
    "cwd-independent absolute",
    ".devpro/scripts/ack-second-reviewer-projection.mjs",
    ".devpro/scripts/run-second-reviewer-projection.mjs",
    "projection_handoff_validated",
    ".devpro/scripts/probe-second-reviewer-cli-recipe.mjs",
    "projection_cli_probe_started",
    "projection_cli_probe_result",
    "projection_cli_exited",
    "auth_preflight",
    "flags_supported",
    "reviewer_host_surface_unverified",
    "memory-only-do-not-persist",
    "required_flag_absent_in_host_help",
    "probe_evidence_unavailable",
    "probe_malformed",
    "recipe_parser_mismatch",
    "stale sticky",
    "projection_sticky_verification_started",
    "projection_sticky_verified",
    "projection_sticky_verification_failed",
  ];
  const missing = anchors.filter((anchor) => !content.includes(anchor));
  assert.deepEqual(missing, [], `${label} missing projection probe anchors: ${missing.join(", ")}`);
}

test("same-family fallback stays an explicit, disclosed path across builder, ticket and accept", () => {
  const policy = read(".devpro/agent-rules/code-review-cross-model.md");
  assert.match(policy, /--allow-same-family <change-specific why>/u);
  assert.match(policy, /same-family fallback: <why>` sticky reason lead/u);
  const ticketContract = read(".devpro/agent-rules/second-review-external-evaluator.md");
  assert.match(ticketContract, /--allow-same-family <why>/u);
  const builder = read(".devpro/scripts/build-pr-sticky-handoff.mjs");
  assert.match(builder, /--allow-same-family/u);
  assert.match(builder, /invalid_allow_same_family/u);
  const renderer = read(".devpro/scripts/render-second-review-packet.mjs");
  assert.match(renderer, /sameFamilyFallbackWhy\(input\?\.retry_context\) === null/u);
  assert.match(renderer, /sameFamilyDisclosure: sameFamilyFallbackDisclosure\(input\?\.retry_context\)/u);
  const accept = read(".devpro/scripts/accept-external-second-review.mjs");
  assert.match(accept, /stickyReasonRequiresSameFamilyFallback/u);
});

test("cross-review CLI skills exist with required invocation anchors", () => {
  const codexRel = ".devpro/agent-skills-refs/autonomous-ai-agents/codex/SKILL.md";
  const claudeRel = ".devpro/agent-skills-refs/autonomous-ai-agents/claude-code/SKILL.md";
  assert.ok(existsSync(repoPath(codexRel)), `${codexRel} missing`);
  assert.ok(existsSync(repoPath(claudeRel)), `${claudeRel} missing`);

  const codex = read(codexRel);
  assert.match(codex, /^name: codex/m);
  assert.match(codex, /codex exec/);
  assert.match(codex, /Always use `pty=true`/);
  assert.match(codex, /Git repo required/);
  assert.match(codex, /--full-auto/);
  assert.match(codex, /OPENAI_API_KEY|Codex OAuth/);

  const claude = read(claudeRel);
  assert.match(claude, /^name: claude-code/m);
  assert.match(claude, /Two Orchestration Modes/);
  assert.match(claude, /Print Mode \(`-p`\)/);
  assert.match(claude, /PTY Dialog Handling/);
  assert.match(claude, /--effort <level>/);
  assert.match(claude, /--allowedTools/);
  assert.match(claude, /--output-format json/);
  assert.match(claude, /--dangerously-skip-permissions/);
});

test("cross-review adapters define fixed CLI review invocations", () => {
  const farDistanceBareFixture = `--bare${" unrelated ".repeat(80)}MUST NOT be part of the canonical recipe`;
  const farDistanceAllowedToolsFixture = `--allowedTools <tools...>${" unrelated ".repeat(80)}variadic`;
  assert.match(farDistanceBareFixture, /--bare.*MUST NOT.*canonical recipe/s);
  assert.match(farDistanceAllowedToolsFixture, /--allowedTools <tools\.\.\.>[\s\S]*variadic/);
  assert.doesNotMatch(farDistanceBareFixture, claudeBareCanonicalRecipePattern);
  assert.doesNotMatch(farDistanceAllowedToolsFixture, claudeAllowedToolsVariadicPattern);

  const crossModel = read(".devpro/agent-rules/code-review-cross-model.md");
  assert.match(crossModel, /External Reviewer CLI Skill Contract/);

  const crossModelCliContract = read(".devpro/agent-rules/code-review-cross-model-cli-contract.md");
  assert.match(crossModelCliContract, /\.devpro\/agent-skills-refs\/autonomous-ai-agents\/<runtime>\/SKILL\.md/);
  assert.match(crossModelCliContract, /on-demand CLI 操作手冊/);
  assert.match(crossModelCliContract, /一般 session 不自動載入/);
  assert.match(crossModelCliContract, /adapter 是本 repo cross-review wrapper 的 SSOT/);
  assert.match(crossModelCliContract, /Hermes 已驗證的 CLI anti-hang rules/);
  assert.match(crossModelCliContract, /bounded timeout/);
  assert.match(crossModelCliContract, /activity heartbeat/);
  assert.match(crossModelCliContract, /progress events/);
  assert.match(crossModelCliContract, /PTY\/tmux/);

  const codexAdapter = read(".devpro/agent-rules/platform-adapters/codex.md");
  assert.match(codexAdapter, /Codex CLI Cross-Review Skill/);
  assert.match(codexAdapter, /Codex sandbox 禁用/);
  assert.match(codexAdapter, /MUST NOT 在 Codex sandbox 內執行/);
  assert.match(codexAdapter, /non-sandbox \/ host execution surface/);
  assert.match(codexAdapter, /這條同樣適用於 `gh` \/ GitHub remote `git` \/ `claude` 的 host-auth 模式/);
  assert.match(codexAdapter, /sandbox 內失敗不是憑證壞掉的證據/);
  assert.match(codexAdapter, /codex exec --json/);
  assert.match(codexAdapter, /model_reasoning_effort="xhigh"/);
  assert.match(codexAdapter, /Git repo required/);
  assert.match(codexAdapter, /Codex OAuth/);
  assert.match(codexAdapter, /pty=true/);
  assert.match(codexAdapter, /bounded timeout/);
  assert.match(codexAdapter, /stdout\/stderr evidence/);
  assert.match(codexAdapter, /not use `--full-auto`|不使用 `--full-auto`/);
  assert.match(codexAdapter, /Prefix: `claude -p --safe-mode --system-prompt <renderer-owned fixed prompt> --model <resolved> --effort (?:xhigh|max) --verbose --output-format stream-json`/);
  assertProjectionProbeAnchors(codexAdapter, "codex.md");

  const claudeAdapter = read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md");
  assert.match(claudeAdapter, /Claude Code CLI Cross-Review Skill/);
  assert.match(claudeAdapter, /Auth-required CLI surface boundary/);
  assert.match(claudeAdapter, /MUST run only on a non-sandbox \/ host runner surface/);
  assert.match(claudeAdapter, /MUST NOT add a sandbox-escalation wrapper/);
  assert.match(claudeAdapter, /Print Mode \(`-p`\)/);
  assert.match(claudeAdapter, /`audit-only` exact recipe[\s\S]{0,120}`--tools ""`[\s\S]{0,80}不得出現`--allowedTools`/);
  assert.match(claudeAdapter, /`pr-sticky` exact recipe[\s\S]{0,120}`--tools Write,Bash --allowedTools <renderer-owned scoped value>`/);
  assert.match(claudeAdapter, /--safe-mode[\s\S]{0,180}(?:CLAUDE\.md|plugins|MCP)/);
  assert.match(claudeAdapter, claudeBareCanonicalRecipePattern);
  assert.match(claudeAdapter, /stream-json/);
  assert.match(claudeAdapter, /include-partial-messages/);
  assert.match(claudeAdapter, /schema-valid|first .*verdict|第一個.*verdict/s);
  assert.match(claudeAdapter, /error_max_turns/);
  assert.match(claudeAdapter, /Quick Review \/ packet mode \+ sticky self-write mode/);
  assert.match(claudeAdapter, /bounded handoff inputs/);
  assert.match(claudeAdapter, /final reviewer packet/);
  assert.match(claudeAdapter, /Claude .*自行.*sticky|sticky self-write/s);
  // Footer Tool: token is SSOT-referenced (STICKY_PROVENANCE_TOOL_TOKENS), not
  // a hardcoded "Tool: Claude Code" literal, as of add-external-evaluator-
  // second-review D3 — see the dedicated SSOT-reference assertion below.
  assert.match(claudeAdapter, /Tool: <token>[\s\S]*actual model/);
  assert.match(claudeAdapter, /bounded PR self-write profile/);
  assert.ok(
    sourceLineContainingAll(claudeAdapter, [
      "cross-model-second-opinion.md",
      "sticky_write_exact_recipe",
      "final reviewer packet MUST forbid repo file writes",
    ]),
    "sticky self-write profile must keep the fixed body file, exact packet recipe, and repo-write ban on the same source line"
  );
  assert.match(claudeAdapter, /Write[\s\S]*current neutral cwd/);
  assert.match(claudeAdapter, /cross-model-second-opinion\.md/);
  assert.match(claudeAdapter, /sticky_write_exact_recipe/);
  assert.match(claudeAdapter, /forbid inline `--body`/);
  assert.match(claudeAdapter, claudeAllowedToolsVariadicPattern);
  assert.match(claudeAdapter, /Claude Code 2\.1\.209[\s\S]*native `--tools` and `--allowedTools` parsing/);
  assert.match(claudeAdapter, /claudeAllowedTools|write-second-review-sticky-gated\.mjs/);
  assert.match(claudeAdapter, /no raw `Bash\(gh api:\*\)`|MUST NOT include raw `Bash\(gh api:\*\)`/);
  assert.doesNotMatch(claudeAdapter, /--allowedTools "[^"\n]*gh pr comment/);
  assert.doesNotMatch(claudeAdapter, /Bash\(gh pr comment:\*\)/);
  assert.match(claudeAdapter, /`Bash\(command -v gh\)` only authorizes that exact availability probe/);
  assert.match(claudeAdapter, /Scoped `--allowedTools` values are permission-surface clamps only/);
  assert.match(claudeAdapter, /not shell grammar validation/);
  assert.match(claudeAdapter, /Task\/subagent delegation/);
  assert.match(claudeAdapter, /--disallowedTools[\s\S]*未知 deny-list|unknown deny-list/s);
  assert.match(claudeAdapter, /MultiEdit[\s\S]*matches no known tool/);
  assert.match(claudeAdapter, /正向 `--allowedTools` profile|positive `--allowedTools` profile/);
  assert.match(claudeAdapter, /stdin\/file-backed/);
  assert.match(claudeAdapter, /MUST NOT inline long reviewer packet/);
  assert.match(claudeAdapter, /allowlist flags[\s\S]*stdin\/file-backed packet carrier/s);
  assert.doesNotMatch(claudeAdapter, /--\s*"<review_packet>"/);
  assert.match(claudeAdapter, /Write failure handling/);
  assert.match(claudeAdapter, /新dispatch[\s\S]*producer\/recipe[\s\S]*完整列舉authority/);
  assert.match(claudeAdapter, /write-second-review-sticky-gated\.mjs|sticky_write_exact_recipe/);
  assert.match(claudeAdapter, /禁止 raw `gh api` POST\|PATCH `body=@`|NEVER raw `gh api` POST\|PATCH `body=@`/);
  assert.doesNotMatch(claudeAdapter, /0 則只執行一次 `gh api -X POST/);
  assert.match(claudeAdapter, /denied or failed (?:API operation|gated write)[\s\S]*MUST NOT try another create primitive/);
  assert.match(claudeAdapter, /sticky_write_exact_recipe[\s\S]{0,220}write-second-review-sticky-gated\.mjs|write-second-review-sticky-gated\.mjs[\s\S]{0,220}sticky_write_exact_recipe/);
  assert.doesNotMatch(claudeAdapter, /zero=one POST, one=one PATCH/);
  assert.doesNotMatch(
    claudeAdapter,
    /Bash side effects[\s\S]{0,120}`gh api`/,
    "reviewer self-write-back prose must not list raw gh api among allowed side effects",
  );
  assert.doesNotMatch(claudeAdapter, /gh pr comment <positive-decimal> --body-file/);
  assert.doesNotMatch(claudeAdapter, /<reviewer-body-file>/);
  assert.doesNotMatch(claudeAdapter, /gh (?:pr|api)[^`\n]*\$(?:GH_REPO|DEVPRO_REVIEW_PR_NUMBER)/);
  assert.doesNotMatch(claudeAdapter, /gh api --repo\b/);
  assert.match(claudeAdapter, /Canonical sticky body-file happy path[\s\S]*renderer-owned current neutral cwd/);
  assert.match(claudeAdapter, /heredoc[\s\S]*redirection[\s\S]*inline `--body`/);
  assert.match(claudeAdapter, /529 overloaded[\s\S]*provider transient/);
  assert.match(claudeAdapter, /git add[\s\S]*git commit[\s\S]*git push[\s\S]*gh pr merge/);
  assert.match(claudeAdapter, /current host .*不得代貼 findings|不代貼 `PASS \| WARN \| CRITICAL` findings/s);
  assert.match(claudeAdapter, /error_max_turns[\s\S]*不得只調 `--max-turns`/);
  assert.match(claudeAdapter, /stream-json|progress/);
  assert.match(claudeAdapter, /Deep Review \/ interactive mode/);
  assert.match(claudeAdapter, /tmux\/PTY/);
  assert.match(claudeAdapter, /bounded timeout/);
  assert.match(claudeAdapter, /stdout\/stderr evidence/);
  assert.match(claudeAdapter, /Projection wrapper observability/);
  assert.match(claudeAdapter, /cross-host MUST/);
  assert.match(claudeAdapter, /Codex-host -> `claude -p`[\s\S]*Claude-host -> `codex exec`/);
  assert.match(claudeAdapter, /reviewer_surface: host-non-sandbox-required/);
  assert.match(claudeAdapter, /runner_owner: adapter-host-runner/);
  assert.match(claudeAdapter, /sandbox_policy: auth-required-reviewer-cli-must-not-run-in-sandbox/);
  assert.match(claudeAdapter, /projection_runner_unavailable/);
  assert.match(claudeAdapter, /projection_observability_contract_missing/);
  assert.match(claudeAdapter, /projection_activity_stale/);
  assert.match(claudeAdapter, /projection_handoff_validated/);
  assert.match(claudeAdapter, /projection_cli_starting/);
  assert.match(claudeAdapter, /projection_cli_started/);
  assert.match(claudeAdapter, /samples every `60s`/);
  assertProjectionProbeAnchors(claudeAdapter, "claude-code-cross-review.md");
  assert.match(claudeAdapter, /Auth probe output hygiene/);
  assert.match(claudeAdapter, /raw auth status output/);
  assert.match(claudeAdapter, /email \/ org \/ account \/ login/);

  // Compatibility guard: the external non-interactive Claude reviewer recipe uses the
  // highest probe-backed compatible tier (`xhigh`|`max`) plus `--model <resolved>`. The general
  // CLI ceiling remains max; silent `--effort high` / omit-model fallback is forbidden.
  const codexHostCrossReview = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  const codexAdapterForClaudeCheck = read(".devpro/agent-rules/platform-adapters/codex.md");
  const crossReviewCliReference = read(".devpro/agent-skills/devpro-reviews/cross-review/references/cli-invocation.md");
  const scenarioS = read("scenarios/scenario-s-cross-model-reviewer.md");
  const claudeRecipeContract = read(".devpro/scripts/second-reviewer-cli-recipe-contract.mjs");
  assert.doesNotMatch(claudeRecipeContract, /"--effort",\s*"high"/,
    "Claude recipe contract MUST NOT hardcode --effort high");
  assert.match(claudeRecipeContract, /"--model"/,
    "Claude recipe contract MUST declare --model");
  assert.match(claudeRecipeContract, /SECOND_REVIEWER_MODEL_DEFAULTS[\s\S]{0,120}claude: Object\.freeze\(\{ model: CLAUDE_REVIEWER_HIGHEST_FAMILY,/,
    "Claude recipe contract MUST use the probe-resolved highest-tier model via the single centralized model-defaults source");
  assert.match(claudeRecipeContract, /xhigh/,
    "Claude recipe contract MUST support probe-selected xhigh");
  const codexRecipeSlice = claudeRecipeContract.slice(
    claudeRecipeContract.indexOf("function codexRecipe"),
    claudeRecipeContract.indexOf("export function canonicalReviewerCliRecipe"),
  );
  assert.doesNotMatch(codexRecipeSlice, /--effort|--model/,
    "Codex-as-reviewer recipe MUST NOT gain Claude effort/model flags");
  assert.match(codexHostCrossReview, /render-second-review-packet\.mjs[\s\S]{0,120}validate-second-review-packet\.mjs[\s\S]{0,240}claude -p/);
  assert.match(codexHostCrossReview, /Auth probe output hygiene/);
  assert.match(codexHostCrossReview, /Auth probe transcript hygiene/);
  assert.match(codexHostCrossReview, /raw auth status output/);
  assert.match(codexHostCrossReview, /redacted summary/);
  assert.match(codexHostCrossReview, /Positive recipe boundary/);
  assert.match(codexHostCrossReview, /--bare[\s\S]*--allowedTools/);
  assert.match(codexHostCrossReview, /write-second-review-sticky-gated\.mjs/);
  assert.match(codexHostCrossReview, /MUST NOT include raw `Bash\(gh api:\*\)`|no raw `Bash\(gh api:\*\)`/);
  assert.doesNotMatch(codexHostCrossReview, /Bash\(gh pr comment:\*\)/);
  assert.match(codexHostCrossReview, /`Bash\(command -v gh\)` authorizes that exact availability probe only/);
  assert.match(codexHostCrossReview, /Timeout-after-writeback rule/);
  assert.match(codexHostCrossReview, /transport\/finalization fault/);
  assert.match(codexHostCrossReview, /Do not remove[\s\S]*(?:30m|30-minute)[\s\S]*(?:no-total-timeout|no total timeout)/);
  assert.match(codexHostCrossReview, /projection_cli_liveness_sampled/);
  assert.match(codexHostCrossReview, /projection_cli_status_checkpoint/);
  assert.match(codexHostCrossReview, /15m[\s\S]{0,180}(?:auto-continue|automatically continue|自動續跑|繼續等待)/i);
  assert.match(codexHostCrossReview, /callback|process close/i);
  assert.match(codexHostCrossReview, /Canonical packet template contract[\s\S]{0,220}Canonical Reviewer Packet Template/);
  assert.match(codexHostCrossReview, /render-second-review-packet\.mjs[\s\S]{0,120}validate-second-review-packet\.mjs/);
  assert.match(codexHostCrossReview, /initial[\s\S]{0,80}focused-refresh[\s\S]{0,80}fault-recovery/);
  assert.match(codexHostCrossReview, /bounded handoff\/optional `retry_context`/);
  assert.match(codexHostCrossReview, /TL MUST NOT handwrite final prompt/);
  assert.match(codexHostCrossReview, /Dynamic strings[\s\S]{0,80}opaque untrusted evidence/);
  assert.match(codexHostCrossReview, /observability-context\.json[\s\S]{0,80}wrapper control plane/);
  assert.match(codexHostCrossReview, /Python\/heredoc\/pipes\/redirection\/loops/);
  assert.match(codexHostCrossReview, /Projection observability contract/);
  assert.match(codexHostCrossReview, /TL MUST run `\.devpro\/scripts\/render-second-review-packet\.mjs`[\s\S]{0,180}before `spawn_agent` \/ `Task`/);
  assert.match(codexHostCrossReview, /TL MUST pass exact `packet_path`, `observability_context_path`, `heartbeat_path`, `activity_log_path`, `stdout_log_path`, `stderr_log_path`, `cli_probe_result_path`, `projection_bootstrap_command`, `projection_runner_command`, and `tl_pre_dispatch_contract`/);
  assertAnchorsInOrder(codexHostCrossReview, [
    "**Render and validate before dispatch**",
    "TL MUST run `.devpro/scripts/render-second-review-packet.mjs`",
    "TL 在 dispatch 前讀 renderer-generated `<packet-dir>/observability-context.json`",
    "`projection_bootstrap_command`",
    "`projection_runner_command`",
    "TL 不手寫 sidecar 或 path",
  ], "codex-host pre-dispatch observability flow");
  assert.match(codexHostCrossReview, /projection_bootstrap_command[\s\S]{0,180}cwd-independent absolute/);
  assert.match(codexHostCrossReview, /cwd-independent absolute[\s\S]{0,160}ack-second-reviewer-projection\.mjs[\s\S]{0,120}observability_context_path/);
  assert.match(codexHostCrossReview, /tl_pre_dispatch_contract: tl-must-render-before-runtime-native-projection-spawn/);
  assert.match(codexHostCrossReview, /required_spawn_payload_fields/);
  assert.match(codexHostCrossReview, /reviewer-stdout\.ndjson/);
  assert.match(codexHostCrossReview, /reviewer_surface: host-non-sandbox-required/);
  assert.match(codexHostCrossReview, /runner_owner: adapter-host-runner/);
  assert.match(codexHostCrossReview, /sandbox_policy: auth-required-reviewer-cli-must-not-run-in-sandbox/);
  assert.match(codexHostCrossReview, /projection_runner_unavailable/);
  assert.match(codexHostCrossReview, /TL MUST NOT handwrite final prompt or observability paths/);
  assert.match(codexHostCrossReview, /projection_observability_contract_missing/);
  assert.match(codexHostCrossReview, /projection_activity_stale/);
  assert.match(codexHostCrossReview, /projection_handoff_validated/);
  assert.match(codexHostCrossReview, /projection_cli_starting/);
  assert.match(codexHostCrossReview, /projection_cli_started/);
  assert.match(codexHostCrossReview, /first 60s observation window/);
  assertProjectionProbeAnchors(codexHostCrossReview, "codex-host-cross-review.md");
  assert.match(claudeAdapter, /Canonical packet discipline[\s\S]{0,180}initial dispatch[\s\S]{0,180}focused sticky-refresh[\s\S]{0,180}fault recovery/);
  assert.match(claudeAdapter, /claude -p --safe-mode --system-prompt <renderer-owned fixed prompt> --model <resolved> --effort (?:xhigh|max)/,
    "claude-code-cross-review.md: external Claude reviewer recipe must use the probe-resolved highest-tier model + highest-compatible effort");
  assert.match(codexHostCrossReview, /claude -p --safe-mode --system-prompt <renderer-owned fixed prompt> --model <resolved> --effort (?:xhigh|max)/,
    "codex-host-cross-review.md: external Claude reviewer recipe must use the probe-resolved highest-tier model + highest-compatible effort");
  assert.match(codexAdapterForClaudeCheck, /claude -p --safe-mode --system-prompt <renderer-owned fixed prompt> --model <resolved> --effort (?:xhigh|max)/,
    "codex.md: external Claude reviewer recipe must use the probe-resolved highest-tier model + highest-compatible effort");
  assert.match(crossReviewCliReference, /claude -p[\s\S]{0,80}--safe-mode[\s\S]{0,80}--system-prompt[\s\S]{0,2400}--model <resolved>[\s\S]{0,80}--effort (?:xhigh|max)[\s\S]{0,220}--tools Write,Bash[\s\S]{0,240}--allowedTools/,
    "devpro:cross-review CLI reference: pr-sticky recipe must preserve safe-mode, fixed system prompt, resolved model, highest-compatible effort, and tool surface");
  assert.doesNotMatch(crossReviewCliReference, /canonical packet recipe does not use[^\n]*--tools/,
    "devpro:cross-review CLI reference must not contradict the canonical pr-sticky --tools surface");
  assert.match(codexHostCrossReview, /external Claude=`(?:xhigh\|max|highest-compatible)`|external Claude.*(?:xhigh|max).*<resolved>/i,
    "codex-host-cross-review.md: reasoning control must distinguish probe-backed Claude recipe from general ceiling");
  assert.match(scenarioS, /claude.*--effort (?:xhigh|max)/,
    "scenario-s-cross-model-reviewer.md: external Claude reviewer recipe must use highest-compatible effort");
  assert.doesNotMatch(claudeAdapter, /claude -p[^\n]*--effort high(?!est)/,
    "claude-code-cross-review.md must not hard-lock external Claude recipe to --effort high");
  assert.doesNotMatch(codexHostCrossReview, /claude -p[^\n]*--effort high(?!est)/,
    "codex-host-cross-review.md must not hard-lock external Claude recipe to --effort high");

  // Negative guard (codex side): the cross-model reviewer's codex CLI invocation must
  // use model_reasoning_effort="xhigh" (the cross-review recipe policy tier; the gpt-6
  // catalog additionally offers max/ultra, which this recipe does not adopt), not the lower high.
  // Covers the live SSOT specs so a spec edit back to high (the #1019/this-PR bug class)
  // is mechanically caught — both specs previously drifted to high while the adapter/impl
  // moved to xhigh.
  const crossRuntimeSpec = read("openspec/specs/cross-runtime-parity/spec.md");
  const subagentSpec = read("openspec/specs/subagent-behavioral-contract/spec.md");
  assert.doesNotMatch(crossRuntimeSpec, /model_reasoning_effort="high"/,
    'cross-runtime-parity/spec.md: codex cross-model reviewer must use model_reasoning_effort="xhigh", not "high"');
  assert.doesNotMatch(subagentSpec, /model_reasoning_effort="high"/,
    'subagent-behavioral-contract/spec.md: devpro:second-review codex invocation must use model_reasoning_effort="xhigh", not "high"');
  assert.match(crossRuntimeSpec, /--disallowedTools[\s\S]*unknown deny-list|未知 deny-list/s);
  assert.match(crossRuntimeSpec, /MultiEdit[\s\S]*Claude Code 2\.1\.185/);

  // cursor.md is a cross-model second reviewer invocation principle
  // (codex=xhigh / external claude=highest-compatible xhigh|max + resolved model); guard both CLI sides.
  const cursorMd = read(".devpro/agent-rules/platform-adapters/cursor.md");
  assert.match(cursorMd, /external Claude second-review recipe 使用 `--model <resolved>`.*`--effort (?:xhigh\|max)`|external Claude second-review recipe.*(?:xhigh|max).*<resolved>|--model <resolved>[\s\S]{0,80}--effort (?:xhigh|max)/,
    "cursor.md: external Claude reviewer must use the probe-resolved highest-tier model + highest-compatible effort");
  assert.doesNotMatch(cursorMd, /external Claude second-review recipe 使用 `--effort high`/,
    "cursor.md must not hard-lock external Claude recipe to --effort high");
  assert.doesNotMatch(cursorMd, /codex.*model_reasoning_effort="high"/,
    'cursor.md: codex cross-model reviewer must use model_reasoning_effort="xhigh", not "high"');

  // Neutral-cwd invocation contract: codex-cli-tooling.md §Cross-Review Skill must define
  // the five-element neutral-cwd launch contract (SSOT) to prevent auto-loading target
  // repo AGENTS.md into TL-orchestrator mode and hitting the ask-first gate.
  const codexTooling = read(".devpro/agent-rules/platform-adapters/codex-cli-tooling.md");
  assert.match(codexTooling, /--ignore-rules/,
    "codex-cli-tooling.md §Cross-Review Skill must document --ignore-rules flag");
  assert.match(codexTooling, /Canonical packet discipline[\s\S]{0,180}`devpro:second-review` Canonical Reviewer Packet Template/);
  assert.match(codexTooling, /structured handoff JSON[\s\S]{0,160}render-second-review-packet\.mjs/);
  assert.match(codexTooling, /bounded handoff\/optional `retry_context`/);
  assert.match(codexTooling, /--skip-git-repo-check/,
    "codex-cli-tooling.md §Cross-Review Skill must document --skip-git-repo-check flag");
  assert.match(codexTooling, /--output-schema/,
    "codex-cli-tooling.md §Cross-Review Skill must document --output-schema flag");
  assert.match(codexTooling, /-o <verdict-file>[\s\S]{0,80}--output-last-message <verdict-file>|--output-last-message <verdict-file>[\s\S]{0,80}-o <verdict-file>/,
    "codex-cli-tooling.md §Cross-Review Skill must document -o/--output-last-message canonical verdict capture");
  assert.match(codexTooling, /stdout redirection[\s\S]{0,180}not reliable verdict capture/i,
    "codex-cli-tooling.md must warn stdout redirection is not reliable verdict capture");
  assert.match(codexTooling, /When `codex exec` is owned by a `dp-second-reviewer` projection\/executor wrapper/);
  assert.match(codexTooling, /wrapper MUST expose renderer-generated TL-readable `observability_context` artifacts/);
  assert.match(codexTooling, /reviewer_surface: host-non-sandbox-required/);
  assert.match(codexTooling, /runner_owner: adapter-host-runner/);
  assert.match(codexTooling, /sandbox_policy: auth-required-reviewer-cli-must-not-run-in-sandbox/);
  assert.match(codexTooling, /projection_log_unavailable_by_runtime_api` is not a waiver/);
  assert.match(codexTooling, /projection_runner_unavailable/);
  assert.match(codexTooling, /projection_observability_contract_missing/);
  assert.match(codexTooling, /projection_handoff_validated/);
  assert.match(codexTooling, /projection_cli_starting/);
  assert.match(codexTooling, /projection_cli_started/);
  assert.match(codexTooling, /first 60s observation window/);
  assertProjectionProbeAnchors(codexTooling, "codex-cli-tooling.md");
  // Lock the NEW neutral-cwd contract specifically (the bare `-C ` already existed in the
  // pre-change hot-path sample, so it cannot lock the new form — require the contract heading).
  assert.match(codexTooling, /Neutral-CWD Launch Contract/,
    "codex-cli-tooling.md §Cross-Review Skill must document the Neutral-CWD Launch Contract");
  assert.match(codexTooling, /-C <neutral>|neutral cwd/i,
    "codex-cli-tooling.md §Cross-Review Skill must document neutral cwd (-C <neutral>)");
  assert.match(codexTooling, /不跑 shell|全部在 prompt|MUST NOT run.*shell|in-prompt-only/,
    "codex-cli-tooling.md §Cross-Review Skill must document in-prompt-only preamble");
  // Lock the CAUSAL MODEL, not just flag presence (per cross-model #1331): -C (neutral cwd)
  // is the AGENTS.md auto-load suppressor; --ignore-rules is execpolicy `.rules` only.
  // These RED if a future edit re-attributes AGENTS.md auto-load to --ignore-rules.
  assert.match(codexTooling, /-C[\s\S]{0,160}(AGENTS\.md|primary|project docs?)/i,
    "codex-cli-tooling.md must attribute AGENTS.md auto-load suppression to -C (neutral cwd)");
  assert.match(codexTooling, /Neutral cwd and target worktree are different concepts[\s\S]{0,260}(packet|prompt|diff|reference files)/,
    "codex-cli-tooling.md must distinguish neutral cwd from target worktree/repo context carriers");
  assert.match(codexTooling, /--ignore-rules[\s\S]{0,160}(execpolicy|\.rules)/i,
    "codex-cli-tooling.md must scope --ignore-rules to execpolicy `.rules` (not AGENTS.md)");
  // The in-prompt-only preamble's job is preventing the reviewer from running shell/test/build,
  // NOT suppressing AGENTS.md auto-load (that is -C). Lock the preamble rationale to shell/exec.
  assert.match(codexTooling, /(In-prompt-only preamble|preamble)[\s\S]{0,200}(shell|執行命令|test|build)/i,
    "codex-cli-tooling.md preamble rationale must be about preventing shell/test execution, not AGENTS.md");
});

test("cross-review flows reference the CLI skills", () => {
  const crossReview = read(".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md");
  // devpro:pre-pr 的 codex CLI skill 引用位於抽出的 dispatch block（references/），
  // 故拼接 SKILL.md + references/subagent-dispatch-blocks.md 後再比對（SSOT 遷移後
  // 檔案拆分的自然延伸，與 reviewer-issue-context-grep 同一修法）。
  const prePr = read(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md") + "\n" +
    read(".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md");
  // devpro:second-review host routes live in references/ (SKILL.md keeps a routing table);
  // the helper rebuilds the pre-split skill text so every assertion below sees the same bytes.
  const secondReviewerSkill = readSecondReviewSkillWithHostRoutes();
  const reviewer = read(".claude/agents/dp-second-reviewer.md");
  const codexReviewer = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  const cliInvocation = read(".devpro/agent-skills/devpro-reviews/cross-review/references/cli-invocation.md");
  const cursorAdapter = read(".devpro/agent-rules/platform-adapters/cursor.md");
  const crossModelRule = read(".devpro/agent-rules/code-review-cross-model.md");
  // The step-2 packet／control-binding contract moved verbatim to the dispatch-mechanics sibling.
  const crossModelMechanics = read(".devpro/agent-rules/code-review-cross-model-dispatch-mechanics.md");
  const fileWriteDestinations = read(".devpro/agent-rules/file-write-destinations.md");
  const codeReviewSpec = read("openspec/specs/code-review-checklist/spec.md");
  const packetControlBinding = sliceSection(
    crossModelMechanics,
    /^   - \*\*Packet 與 control binding\*\*：$/m,
    [/^   - \*\*Completion contract\*\*：$/m]
  );
  assert.match(
    packetControlBinding,
    /既有 embedded\/live rows=`devpro-second-review-data\/v4`[\s\S]{0,180}renderer-normalized paged row=`devpro-second-review-data\/v5`[\s\S]{0,180}`audit-only`[\s\S]{0,80}`devpro-second-review-data\/v3`/,
    "shared packet control binding must keep the finite v4 embedded/live, v5 renderer-paged, and v3 audit-only branches"
  );
  assert.doesNotMatch(
    packetControlBinding,
    /new `pr-sticky`只接受`devpro-second-review-data\/v4`/,
    "shared packet control binding must not regress to the old v4-only pr-sticky contract"
  );
  assert.match(codexReviewer, /Write[\s\S]*current neutral cwd body file/);
  assert.match(codexReviewer, /sticky_write_exact_recipe|write-second-review-sticky-gated\.mjs/);
  assert.match(codexReviewer, /禁止 raw `gh api` POST\|PATCH `body=@`|NEVER raw `gh api`/);
  assert.match(codexReviewer, /cross-model-second-opinion\.md/);
  assert.match(codexReviewer, /sticky_write_exact_recipe/);
  assert.doesNotMatch(codexReviewer, /--allowedTools "[^"\n]*gh pr comment/);
  assert.match(codexReviewer, /forbid inline `--body`/);
  assert.match(codexReviewer, /Executor-internal \/ projection-fallback `devpro:second-review` \/ `claude -p` adapter invocation recipe/);
  assert.match(codexReviewer, /render-second-review-packet\.mjs "\$HANDOFF_JSON" --carrier-root "\$CARRIER_ROOT"\)[\s\S]{0,120}validate-second-review-packet\.mjs "\$PACKET_FILE"/);
  assert.match(codexReviewer, /claude -p[\s\S]*--verbose[\s\S]*--output-format stream-json[\s\S]*--include-partial-messages/);
  assert.match(codexReviewer, /< "\$PACKET_FILE"/);
  assert.match(codexReviewer, /host\/outside auth\/session[\s\S]*sticky write-back[\s\S]*observed on the active runtime/);
  assert.match(crossReview, /Codex host 委派格式（projection-first/);
  assert.match(crossReview, /agent_type: "dp-second-reviewer"/);
  assert.match(crossReview, /不要接受 TL-authored final prompt\/packet/);

  for (const [label, content] of [
    ["codex-host-cross-review", codexReviewer],
    ["devpro:second-review", secondReviewerSkill],
    ["cli-invocation", cliInvocation],
  ]) {
    assert.match(content, /cross-model-second-opinion\.md/, `${label}: fixed Claude body-file name`);
    assert.match(content, /sticky_write_exact_recipe/, `${label}: packet exact recipe authority`);
    assert.doesNotMatch(content, /Bash\(gh pr comment:\*\)/, `${label}: no Claude gh pr comment permission`);
    assert.doesNotMatch(content, /<reviewer-body-file>/, `${label}: no body-file placeholder`);
  }

  assert.match(cursorAdapter, /bounded issue-comments snapshot|bounded.*snapshot/i);
  assert.match(cursorAdapter, /sticky_write_disposition/);
  assert.match(cursorAdapter, /sticky_write_exact_recipe/);
  assert.doesNotMatch(cursorAdapter, /gh pr comment <PR#>/);
  assert.doesNotMatch(cursorAdapter, /repos\/\{owner\}\/\{repo\}/);

  for (const content of [crossReview, prePr, secondReviewerSkill, reviewer]) {
    assert.match(content, /\.devpro\/agent-skills-refs\/autonomous-ai-agents\/codex\/SKILL\.md/);
  }
  assert.match(crossReview, /\.devpro\/agent-skills\/devpro-reviews\/second-review\/SKILL\.md/);
  assert.match(prePr, /\.devpro\/agent-skills\/devpro-reviews\/second-review\/SKILL\.md/);
  assert.match(crossReview, /approval_context: "none"/);
  assert.doesNotMatch(crossReview, /adoption-notice|採用告知|採用即同意|Second-Review Disclosure Notice|disclosure_notice_/);
  assert.match(crossReview, /approval_resolution: \{"status":"not-required"\}/);
  assert.doesNotMatch(crossReview, /ExternalDisclosureApproval|resolve-cross-review-approval-context|grant-lite-disclosure/);
  assert.match(secondReviewerSkill, /`mode`: `pr-sticky` or `audit-only`/);
  assert.match(secondReviewerSkill, /primary_family/);
  assert.match(secondReviewerSkill, /approval_context/);
  assert.match(secondReviewerSkill, /`approval_context`: `pr-sticky` mode MUST be exactly `none` \(any other value is rejected; rebuild the handoff with `build-pr-sticky-handoff\.mjs`\); `audit-only` uses `none`/);
  assert.doesNotMatch(secondReviewerSkill, /採用告知|採用即同意|Second-review disclosure/);
  assert.match(secondReviewerSkill, /`approval_resolution`: MUST be exactly `\{"status":"not-required"\}` in both modes; the retired `approved` shape is rejected/);
  assert.doesNotMatch(secondReviewerSkill, /ExternalDisclosureApproval|resolve-cross-review-approval-context/);
  const cliContract = read(".devpro/agent-rules/code-review-cross-model-cli-contract.md");
  assert.match(cliContract, /Packet `approval_context`／`approval_resolution`[^\n]*`none`[^\n]*`\{"status":"not-required"\}`/);
  assert.doesNotMatch(cliContract, /adoption-notice|採用告知|採用即同意/);
  assert.doesNotMatch(cliContract, /ExternalDisclosureApproval|resolve-cross-review-approval-context/);
  assert.match(secondReviewerSkill, /caller\/gate block/);
  assert.match(secondReviewerSkill, /Canonical Reviewer Packet Template/);
  assert.match(secondReviewerSkill, /structured handoff JSON[\s\S]{0,180}render-second-review-packet\.mjs/);
  assert.match(secondReviewerSkill, /Every initial dispatch[\s\S]{0,120}focused sticky-refresh[\s\S]{0,120}fault-recovery/);
  assert.match(secondReviewerSkill, /<main-checkout-root>\/notes\/cross-review\/<attempt_id>\//);
  assert.match(secondReviewerSkill, /fresh[\s\S]{0,120}<attempt_id>[\s\S]{0,160}MUST NOT overwrite, patch, delete, or reuse a prior attempt directory/);
  assert.match(secondReviewerSkill, /fresh `dispatch_id`[\s\S]{0,120}fresh `<main-checkout-root>\/notes\/cross-review\/<attempt_id>\/` carrier directory/);
  assert.match(secondReviewerSkill, /renderer-owned exact static reviewer duties \/ tool \/ write contract/);
  assert.match(secondReviewerSkill, /Content-Type: application\/json/);
  assert.match(secondReviewerSkill, /Content-Length: <canonical decimal UTF-8 byte length>/);
  assert.match(secondReviewerSkill, /pr-sticky schema_version "devpro-second-review-data\/v4"/);
  assert.match(secondReviewerSkill, /audit-only exact "devpro-second-review-data\/v3"/);
  assert.match(secondReviewerSkill, /renderer-owned exact completion contract/);
  assert.match(secondReviewerSkill, /review_material[\s\S]{0,180}bounded opaque JSON string/);
  assert.match(secondReviewerSkill, /prior CLI tool-result files[\s\S]{0,180}raw local log artifacts/);
  assert.match(secondReviewerSkill, /claude auth status --json/);
  assert.match(secondReviewerSkill, /codex login status/);
  assert.match(secondReviewerSkill, /Python\/heredoc\/pipes\/redirection\/loops/);
  for (const [label, content] of [
    ["second-review/SKILL.md", secondReviewerSkill],
    ["codex-host-cross-review.md", codexReviewer],
  ]) {
    assert.match(content, /runtime completion callback\/event/, `${label} must prefer runtime callback/event notification`);
    assert.match(
      content,
      /callback-capable runtime[\s\S]{0,260}MUST NOT[\s\S]{0,160}periodic polling/,
      `${label} must prohibit periodic polling when callbacks are available`
    );
  }
  assert.doesNotMatch(
    secondReviewerSkill,
    /TL polls projection lifecycle, artifact freshness, and PR sticky freshness every `60s`/,
    "devpro:second-review must not mandate unconditional projection polling"
  );
  assert.doesNotMatch(
    codexReviewer,
    /then polls projection lifecycle, artifact freshness, and PR sticky every 60s/,
    "Codex host adapter must not mandate unconditional projection polling"
  );
  assert.match(crossReview, /Packet template discipline/);
  assert.match(crossReview, /第一次 dispatch[\s\S]{0,100}focused sticky-refresh[\s\S]{0,100}fault recovery/);
  assert.match(crossReview, /fresh `<main-checkout-root>\/notes\/cross-review\/<attempt_id>\/` carrier directory/);
  assert.match(crossReview, /prior attempt directory[\s\S]{0,80}read-only lineage evidence/);
  assert.match(crossReview, /structured handoff JSON[\s\S]{0,160}render-second-review-packet\.mjs/);
  assert.match(crossReview, /TL MUST NOT hand-?write (?:a )?final prompt/);
  assert.match(crossReview, /For runtime-native projection dispatch, TL MUST run the renderer and validator before `spawn_agent` \/ `Task`/);
  assert.match(crossReview, /packet_path: <absolute renderer-generated packet file>/);
  assert.match(crossReview, /observability_context_path: <absolute renderer-generated observability-context\.json>/);
  assert.match(crossReview, /cli_probe_result_path: <absolute renderer-generated cli-probe-result\.json>/);
  assert.match(crossReview, /tl_pre_dispatch_contract: tl-must-render-before-runtime-native-projection-spawn/);
  assert.match(crossReview, /`projection_observability_contract_missing`[\s\S]{0,120}不得啟動 reviewer CLI/);
  assert.match(crossReview, /projection_handoff_validated/);
  assert.match(crossReview, /projection_cli_probe_started/);
  assert.match(crossReview, /projection_cli_probe_result/);
  assert.match(crossReview, /projection_cli_starting/);
  assert.match(crossReview, /projection_cli_started/);
  assert.match(crossReview, /first 60s observation window/);
  assertProjectionProbeAnchors(crossReview, "cross-review/SKILL.md");
  assert.match(crossReview, /optional `retry_context`/);
  assert.match(crossReview, /不得叫reviewer讀 transcript\/log/);
  assert.match(crossModelRule, /fresh `<main-checkout-root>\/notes\/cross-review\/<attempt_id>\/` carrier directory/);
  assert.match(crossModelRule, /prior attempt evidence/);
  assert.match(fileWriteDestinations, /<main-checkout-root>\/notes\/cross-review\/<attempt_id>\//);
  assert.match(fileWriteDestinations, /fresh `<attempt_id>`[\s\S]{0,180}prior attempt directory 是 lineage evidence/);
  assert.match(codeReviewSpec, /Requirement: Reviewer-Writable Root Carrier Exclusion/);
  assert.match(codeReviewSpec, /<attempt_id>[\s\S]{0,120}per dispatch attempt/);
  assert.match(codeReviewSpec, /Re-dispatch creates a fresh carrier directory/);
  assert.match(codeReviewSpec, /MUST NOT overwrite, patch, delete, or reuse the prior attempt/);
  for (const content of [secondReviewerSkill, reviewer, codexReviewer]) {
    assert.match(content, /reason:/);
    assert.match(content, /required for every `?pr-sticky`? output|`reason:` 為所有 `pr-sticky` output 必填|canonical[\s\S]{0,120}`verdict:`[\s\S]{0,120}`last_reviewed_sha:`[\s\S]{0,120}`dispatch_id:`[\s\S]{0,120}`reason:`/i);
  }
  assert.equal(
    existsSync(repoPath(".codex/agents/dp-second-reviewer.toml")),
    true,
    "Codex host may expose a thin devpro:second-review projection to the Claude reviewer chain"
  );
  assert.match(codexReviewer, /\.devpro\/agent-skills-refs\/autonomous-ai-agents\/claude-code\/SKILL\.md/);
  assert.match(codexReviewer, /`adapter-live-pr-reads` requiring PR diff MUST include `Bash\(gh pr diff:\*\)` in `--allowedTools`/);

  // The Claude projection consumes the canonical recipe sidecar instead of
  // carrying a second argv copy that can drift from the renderer contract.
  assert.match(reviewer, /codex-cli-tooling\.md/,
    "dp-second-reviewer.md must reference codex-cli-tooling.md as SSOT");
  assert.match(reviewer, /\.devpro\/scripts\/second-reviewer-cli-recipe-contract\.mjs/,
    "dp-second-reviewer.md must reference the canonical reviewer CLI recipe sidecar");
  assert.match(reviewer, /canonicalReviewerCliRecipe/,
    "dp-second-reviewer.md must name the shared canonical recipe function");
  assert.match(reviewer, /reviewer_cli_recipe\.required_invocation_args/,
    "dp-second-reviewer.md must consume renderer-owned required invocation args");
  assert.doesNotMatch(reviewer, /\["exec","--json","-C"/,
    "dp-second-reviewer.md must not duplicate the canonical Codex argv");
  assert.doesNotMatch(reviewer, /--output-schema/,
    "dp-second-reviewer.md must not add Codex output-schema flags");
});

test("All-family renderer outer wait budget is locked at all host action points", () => {
  const secondReviewerSkill = read(".devpro/agent-skills/devpro-reviews/second-review/SKILL.md");
  const cursorAdapter = read(".devpro/agent-rules/platform-adapters/cursor.md");
  const codexHostAdapter = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");

  const selectorCeilings = readSelectorProbeTimeoutCeilings(selectorModule);
  const rendererContract = parseRendererOuterWaitContract({
    secondReviewerSkill,
    cursorAdapter,
    codexHostAdapter,
  });
  assertRendererOuterWaitContainment({ ...selectorCeilings, ...rendererContract });

  assert.match(
    secondReviewerSkill,
    /All-family renderer outer wait action point[^\n]*all hosts[^\n]*330000ms[^\n]*90000ms[^\n]*30000ms[^\n]*90000ms[^\n]*90000ms[^\n]*300000ms[^\n]*30000ms[^\n]*MUST NOT[^\n]*background/,
    "common devpro:second-review skill must govern the >=330000ms renderer outer wait derivation and no-background rule for all hosts"
  );

  const cursorRendererShell = sliceSection(
    cursorAdapter,
    /^### TL renderer Shell（all families）$/m,
    [/^### 執行流程概要$/m]
  );
  assert.match(
    cursorRendererShell,
    /Cursor [^\n]*Shell[^\n]*block_until_ms[^\n]*≥ 330000[^\n]*MUST NOT[^\n]*background renderer/,
    "Cursor TL renderer Shell must block for at least 330000ms and must not background the renderer"
  );
  const staleCursorWaitControl = /block_until_ms[^\n]*(?:120000|180000)/;
  assert.match(
    "Cursor Shell: block_until_ms ≥ 120000.",
    staleCursorWaitControl,
    "stale-control guard fixture must reject the old 120000 minimum"
  );
  assert.match(
    "Cursor Shell: block_until_ms recommends 180000.",
    staleCursorWaitControl,
    "stale-control guard fixture must reject the old 180000 recommendation"
  );
  assert.doesNotMatch(
    "Cursor Shell: block_until_ms ≥ 330000.",
    staleCursorWaitControl,
    "stale-control guard fixture must allow the canonical 330000 minimum"
  );
  assert.doesNotMatch(
    cursorRendererShell,
    staleCursorWaitControl,
    "Cursor TL renderer Shell must reject the stale 120000/180000 control values"
  );

  assert.match(
    codexHostAdapter,
    /Render and validate before dispatch[^\n]*All-family renderer[^\n]*host\/session wait budget[^\n]*≥ 330000ms[^\n]*MUST NOT[^\n]*background/,
    "Codex-host canonical render step must reserve >=330000ms host/session wait budget and forbid background rendering"
  );
});

test("renderer containment helper rejects raised-ceiling and lowered-floor fixtures", () => {
  const fixtures = [
    {
      name: "Codex catalog ceiling increases without a matching outer floor",
      contract: {helpCeilingMs: 30000, functionalCeilingMs: 90000, codexModelCeilingMs: 330001,
        outerMarginMs: 30000, outerFloors: [["Codex ceiling fixture", 330000]]},
      requiredOuterFloorMs: 360001,
    },
    {
      name: "functional ceiling increases without a matching outer floor",
      contract: {
        helpCeilingMs: 30000,
        functionalCeilingMs: 90001,
        outerMarginMs: 30000,
        outerFloors: [["raised-ceiling fixture", 330000]],
      },
      requiredOuterFloorMs: 330002,
    },
    {
      name: "outer floor drops below the derived requirement",
      contract: {
        helpCeilingMs: 30000,
        functionalCeilingMs: 90000,
        outerMarginMs: 30000,
        outerFloors: [["lowered-floor fixture", 329999]],
      },
      requiredOuterFloorMs: 330000,
    },
  ];

  for (const { name, contract, requiredOuterFloorMs } of fixtures) {
    assert.throws(
      () => assertRendererOuterWaitContainment(contract),
      (error) => {
        assert.match(error.message, /under-contains selector path/);
        assert.match(error.message, new RegExp(`${requiredOuterFloorMs}ms`));
        return true;
      },
      name,
    );
  }
});

// cross-review/SKILL.md repeats dispatch mechanics that also live in second-review/SKILL.md and the
// host adapters on purpose: this and the other carrier-map tests require each copy, and spec
// cross-runtime-parity names the skill's host blocks and builder entry. Collapsing the SKILL copy
// means dropping it from these maps or a spec delta, not a dedup (refactor-review-skill-duplicates).
test("focused-range evidence capability stays aligned across active policy carriers", () => {
  const carriers = new Map([
    ["second-review/SKILL.md", read(".devpro/agent-skills/devpro-reviews/second-review/SKILL.md")],
    ["cross-review/SKILL.md", read(".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md")],
    // The scope evidence gate moved verbatim from code-review-cross-model.md to this sibling.
    ["code-review-cross-model-dispatch-mechanics.md", read(".devpro/agent-rules/code-review-cross-model-dispatch-mechanics.md")],
    ["second-review-control-evidence.md", read(".devpro/agent-rules/second-review-control-evidence.md")],
    ["claude-code-cross-review.md", read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md")],
    ["codex-host-cross-review.md", read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md")],
    ["codex-cli-tooling.md", read(".devpro/agent-rules/platform-adapters/codex-cli-tooling.md")],
  ]);
  const exactAnchors = [
    "devpro-second-review-data/v5",
    "devpro-second-review-data/v4",
    "devpro-second-review-data/v3",
    "full-pr",
    "commit-range",
    "scope-bound-embedded-complete-diff-v1",
    "embedded-complete-diff-v1",
    "full-pr-bounded-live-reads-v1",
    "gh-pr-bounded-live-v1",
    "commit-range-exact-compare-v1",
    "gh-api-exact-compare-v1",
    "gh api 'repos/{owner}/{repo}/compare/<base>...<head>'",
    "review_material_scope_unresolvable",
    "spawn_or_probe_failure",
    "permission_denials",
  ];

  // boundary-aware 比對（`(?<![\w-])` + `(?![\w-])`）：要求 anchor 有「獨立出現」，而非
  // 僅作為另一個更長 anchor 的字面子字串出現。三個短 anchor（`full-pr` / `commit-range` /
  // `embedded-complete-diff-v1`）分別是同陣列長 anchor（`full-pr-bounded-live-reads-v1` /
  // `commit-range-exact-compare-v1` / `scope-bound-embedded-complete-diff-v1`）的純字面
  // 子字串——裸 `String.prototype.includes()` 會被長 anchor 死代償，使短 anchor 的斷言
  // 永遠無法獨立轉紅（長 anchor 在同一 carrier 內存在即恆真）。live carriers、scenario/spec
  // carriers、T4 mutation 審計都必須呼叫同一個 helper，避免測試 helper 與實際 call-site 分岔。
  function boundedAnchorRegex(anchor) {
    return new RegExp(`(?<![\\w-])${escapeRegExp(anchor)}(?![\\w-])`);
  }

  function assertFocusedRangeAnchors(content, anchors, label) {
    for (const anchor of anchors) {
      assert.ok(
        boundedAnchorRegex(anchor).test(content),
        `${label} must carry exact focused-range anchor with an independent (boundary-safe) occurrence: ${anchor}`
      );
    }
  }

  for (const [name, content] of carriers) {
    assertFocusedRangeAnchors(content, exactAnchors, name);
    assert.match(
      content,
      /fresh[\s\S]{0,100}dispatch[\s\S]{0,160}packet[\s\S]{0,100}proof[\s\S]{0,100}recipe[\s\S]{0,100}probe/i,
      `${name} must require fresh dispatch/packet/proof/recipe/probe recovery`,
    );
    assert.match(
      content,
      /typed[\s\S]{0,80}`?permission_denials`?[\s\S]{0,120}fatal precedence/i,
      `${name} must preserve typed permission_denials fatal precedence`,
    );
  }

  const scenarioS = read("scenarios/scenario-s-cross-model-reviewer.md");
  const canonicalSpecs = [
    read("openspec/specs/code-review-checklist/spec.md"),
    read("openspec/specs/cross-runtime-parity/spec.md"),
  ];
  assertFocusedRangeAnchors(scenarioS, exactAnchors, "Scenario S");
  for (const canonical of canonicalSpecs) {
    assertFocusedRangeAnchors(canonical, exactAnchors, "canonical spec");
  }

  const projectionSchemaAnchors = [
    "devpro-second-review-data/v5",
    "devpro-second-review-data/v4",
    "devpro-second-review-data/v3",
  ];
  const projectionCarriers = new Map([
    [".claude/agents/dp-second-reviewer.md", read(".claude/agents/dp-second-reviewer.md")],
    [".cursor/agents/dp-second-reviewer.md", read(".cursor/agents/dp-second-reviewer.md")],
    [".codex/agents/dp-second-reviewer.toml", read(".codex/agents/dp-second-reviewer.toml")],
  ]);
  for (const [name, content] of projectionCarriers) {
    assertFocusedRangeAnchors(content, projectionSchemaAnchors, name);
    assert.doesNotMatch(
      content,
      /devpro-second-review-data\/v2/,
      `${name} must not frame legacy schema v2 as a current packet contract`
    );
  }
  assert.throws(
    () => assertFocusedRangeAnchors(
      "synthetic projection mentions only devpro-second-review-data/v4 here.",
      projectionSchemaAnchors,
      "T4 projection schema subset"
    ),
    /must carry exact focused-range anchor/,
    "schema-only projection subset must fail closed when v5/v3 are absent"
  );

  // ---- T4：exactAnchors 陣列內部「互相包含」掃描（O(n²)，boundary-aware）----
  // 上面每個 carrier 的正向斷言已改用 `boundedAnchorRegex`——它要求「獨立出現」而非「作為
  // 子字串出現」，故 `full-pr` / `commit-range` / `embedded-complete-diff-v1` 三個短 anchor
  // 的斷言，在 carrier 只寫出長 anchor、從未寫出獨立短 anchor 時會先行轉紅（三個短 anchor
  // 不再被同陣列的長 anchor 死代償）。本掃描檢查的是另一件事：同一 exactAnchors 集合內是否
  // 仍有任兩元素互為 boundary-safe 子字串——`isBoundarySafeSubstring(a, b)` 對「a 只是 b 的
  // 字面前綴」回傳 false（b 在 a 之後多出的字元落在 `[\w-]` 內，尾界檢查失敗），故現行三對
  // 短/長 anchor 不會被本掃描標記為互相包含；只有真正「一個 anchor 的完整字面加邊界後仍是
  // 另一個的獨立子字串」時才會命中，那才是無法被上方正向斷言獨立驗證的結構性死斷言。
  function isBoundarySafeSubstring(needle, haystack) {
    return boundedAnchorRegex(needle).test(haystack);
  }

  const containedPairs = [];
  for (const a of exactAnchors) {
    for (const b of exactAnchors) {
      if (a === b) continue;
      if (isBoundarySafeSubstring(a, b)) containedPairs.push(`"${a}" ⊂ "${b}"`);
    }
  }
  assert.deepEqual(
    containedPairs,
    [],
    `exactAnchors 陣列內有 anchor 互為（boundary-safe）子字串，該類斷言可能被同集合內的其他 anchor 死代償：\n- ${containedPairs.join("\n- ")}`
  );

  // ---- T4 mutation 審計（合成 carrier，非讀 repo 檔）----
  // 證明上面的 boundary-aware 比對不是恆真：對三個曾經死斷言的短 anchor，各造一組合成
  // carrier —— (a) 只含長 anchor、不含獨立短 anchor，boundary-aware 比對必須 FAIL（機械
  // 證明「短 anchor 的斷言不再被長 anchor 死代償」）；(b) 額外含獨立短 anchor，
  // boundary-aware 比對必須 PASS（機械證明「有獨立出現時仍能正確通過」，不是恆假）。任一
  // 方向錯誤都代表有人把比對又改回裸 `includes()` 或改壞了邊界 regex。
  const T4_MUTATION_PAIRS = [
    ["full-pr", "full-pr-bounded-live-reads-v1"],
    ["commit-range", "commit-range-exact-compare-v1"],
    ["embedded-complete-diff-v1", "scope-bound-embedded-complete-diff-v1"],
  ];
  for (const [shortAnchor, longAnchor] of T4_MUTATION_PAIRS) {
    const longAnchorOnlyCarrier = `synthetic carrier mentions only ${longAnchor} here.`;
    assert.throws(
      () => assertFocusedRangeAnchors(
        longAnchorOnlyCarrier,
        [shortAnchor],
        `T4 mutation 審計：合成 carrier 只含 "${longAnchor}"（不含獨立 "${shortAnchor}"）`
      ),
      /must carry exact focused-range anchor/,
      `T4 mutation 審計：合成 carrier 只含 "${longAnchor}"（不含獨立 "${shortAnchor}"）時，` +
        `boundary-aware 比對必須 FAIL——否則短 anchor 的斷言仍被長 anchor 死代償`
    );
    const independentShortAnchorCarrier = `synthetic carrier mentions ${shortAnchor} separately, and also ${longAnchor} here.`;
    assert.doesNotThrow(
      () => assertFocusedRangeAnchors(
        independentShortAnchorCarrier,
        [shortAnchor],
        `T4 mutation 審計：合成 carrier 含獨立出現的 "${shortAnchor}"`
      ),
      `T4 mutation 審計：合成 carrier 含獨立出現的 "${shortAnchor}" 時，boundary-aware 比對必須 PASS`
    );
  }
});

test("reviewer-transport carrier binding routes codex-family reviewers to embedded-diff across carriers", () => {
  // Issue #1725 reopen (R7): a codex/openai reviewer dispatched via `codex exec --json`
  // embeds complete per-command output on one telemetry line, so a live-read carrier
  // overflows the runner 64-KiB complete-line bound. Every carrier that documents carrier
  // selection MUST bind such reviewers to embedded-diff and keep the live-read carrier for
  // Claude stream-json reviewers only. These anchors RED if a future edit deletes the
  // binding or flips its direction (forcing Claude to embed, or admitting codex on live).
  const carriers = new Map([
    // The reviewer transport carrier gate moved verbatim from code-review-cross-model.md to this sibling.
    ["code-review-cross-model-dispatch-mechanics.md", read(".devpro/agent-rules/code-review-cross-model-dispatch-mechanics.md")],
    ["claude-code-cross-review.md", read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md")],
    ["second-review/SKILL.md", read(".devpro/agent-skills/devpro-reviews/second-review/SKILL.md")],
  ]);
  for (const [name, content] of carriers) {
    assert.match(content, /Reviewer transport/, `${name} must document the reviewer-transport carrier binding`);
    // Causal lock: the codex-exec-json transport binds to embedded-diff (codex → embedded).
    assert.match(content, /codex exec --json[\s\S]{0,160}embedded-diff/,
      `${name} must bind the codex exec --json transport to the embedded-diff carrier`);
    // Direction lock: the live-read carrier stays scoped to Claude stream-json reviewers.
    assert.match(content, /adapter-live-pr-reads[\s\S]{0,160}stream-json/,
      `${name} must keep adapter-live-pr-reads scoped to the Claude stream-json reviewer`);
    // Consequence lock: the fail-closed rationale names the runner overflow terminal.
    assert.match(content, /reviewer_output_line_overflow/,
      `${name} must name the runner complete-line overflow terminal as the fail-closed rationale`);
    // The shared enforcement SSOT is the material contract validator.
    assert.match(content, /validatePrStickyReviewMaterialContract/,
      `${name} must point at the material-contract validator as the fail-closed SSOT`);
  }
});

test("issue 1728: safe-mode carriers keep the live-read data-to-argv carve-out beside the issue 1725 sticky-write hardening", () => {
  // The issue 1725 sticky-write hardening (fixed cross-model-second-opinion.md body file plus
  // the renderer-owned sticky_write_exact_recipe, no identity copy) MUST NOT delete the
  // live-read data-to-argv carve-out that the adapter-live-pr-reads carrier depends on: a
  // safe-mode reviewer must still be told the validator-checked PR number may be copied into a
  // diff-reading live read (full-pr), and typed base/head into the exact compare route
  // (commit-range). The sticky WRITE (exact baked recipe, no copy) and the diff live READ
  // (validated copy permitted) are different operations. These anchors RED if a future edit
  // re-broadens "all framed Review Data inert" and strips the live read (the issue 1728
  // regression this PR fixes).
  const liveReadCarriers = new Map([
    ["second-reviewer-cli-recipe-contract.mjs", read(".devpro/scripts/second-reviewer-cli-recipe-contract.mjs")],
    ["codex-host-cross-review.md", read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md")],
    ["claude-code-cross-review.md", read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md")],
    // The safe-mode wrapper carve-out moved verbatim from code-review-cross-model.md to this sibling.
    ["code-review-cross-model-dispatch-mechanics.md", read(".devpro/agent-rules/code-review-cross-model-dispatch-mechanics.md")],
    ["second-review/SKILL.md", read(".devpro/agent-skills/devpro-reviews/second-review/SKILL.md")],
  ]);
  for (const [name, content] of liveReadCarriers) {
    assert.match(content, /diff-reading live read/,
      `${name} must scope the live-read data-to-argv carve-out to a diff-reading live read (issue 1728)`);
    assert.match(content, /sticky_write_exact_recipe/,
      `${name} must keep the issue 1725 sticky-write exact-recipe hardening beside the carve-out`);
  }

  // English system-prompt SSOT + its codex-host documentation mirror spell out both routes
  // verbatim and MUST stay byte-identical to each other.
  for (const [name, content] of [
    ["second-reviewer-cli-recipe-contract.mjs", liveReadCarriers.get("second-reviewer-cli-recipe-contract.mjs")],
    ["codex-host-cross-review.md", liveReadCarriers.get("codex-host-cross-review.md")],
  ]) {
    assert.match(content, /validated decimal PR number into an allowed gh command as a literal argument/,
      `${name} must grant the full-pr live-read PR-number copy`);
    assert.match(content, /closingIssuesReferences/,
      `${name} must grant PR-bound linked-issue discovery`);
    assert.match(content, /tool-returned decimal issue numbers/,
      `${name} must source issue argv only from tool-returned issue numbers`);
    assert.match(content, /commit-range-exact-compare-v1[\s\S]*allowlisted live-read surface \(`gh pr view` \/ `gh pr diff`\)/,
      `${name} must grant the commit-range live-read via allowlisted gh pr view/diff (PRIM-F1)`);
    assert.doesNotMatch(content, /fixed gh api 'repos\/\{owner\}\/\{repo\}\/compare/,
      `${name} must not restore raw gh api compare after PRIM-F1 allowlist removal`);
  }

  // Chinese adapter/skill carriers keep the PR number copyable as a literal PR argument.
  for (const [name, content] of [
    ["claude-code-cross-review.md", liveReadCarriers.get("claude-code-cross-review.md")],
    ["code-review-cross-model-dispatch-mechanics.md", liveReadCarriers.get("code-review-cross-model-dispatch-mechanics.md")],
    ["second-review/SKILL.md", liveReadCarriers.get("second-review/SKILL.md")],
  ]) {
    assert.match(content, /literal PR arg(?:ument|v)/,
      `${name} must keep the validated PR number copyable as a literal PR argument (issue 1728)`);
    assert.match(content, /closingIssuesReferences/,
      `${name} must bind issue discovery to the validated PR route`);
    assert.match(content, /tool-returned/,
      `${name} must keep issue argv sourced from tool-returned issue numbers`);
  }
});

test("second-review packet prompts carry test execution policy", () => {
  const carriers = new Map([
    // The packet `## 測試執行政策` duty moved verbatim from code-review-cross-model.md to this sibling.
    ["code-review-cross-model-dispatch-mechanics.md", read(".devpro/agent-rules/code-review-cross-model-dispatch-mechanics.md")],
    ["pr-review-evidence-verification.md", read(".devpro/agent-rules/pr-review-evidence-verification.md")],
    ["codex-host-cross-review.md", read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md")],
    ["claude-code-cross-review.md", read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md")],
    ["cross-review/SKILL.md", read(".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md")],
    ["second-review/SKILL.md", read(".devpro/agent-skills/devpro-reviews/second-review/SKILL.md")],
  ]);

  for (const [name, content] of carriers) {
    assert.match(content, /`## 測試執行政策`|## 測試執行政策/,
      `${name} must carry the reviewer packet test execution policy anchor`);
    assert.match(content, /primary validation evidence|primary test evidence/,
      `${name} must tell the second reviewer to confirm primary test evidence`);
    assert.match(content, secondReviewerFullSuiteNotDefaultPattern,
      `${name} must say full suite and budget gate are not default second-review actions`);
    assert.match(content, secondReviewerChangedMainNotDefaultPattern,
      `${name} must say --changed main / tier suite is not a default second-review action`);
    assert.match(content, secondReviewerMultiGateNotDefaultPattern,
      `${name} must say multi-gate insurance rerun is not a default second-review action`);
    assert.match(content, secondReviewerChangedMainNotScopedPattern,
      `${name} must carry the negative example that --changed main is not scoped rerun`);
    assert.match(content, secondReviewerScopedNarrowerThanSuitePattern,
      `${name} must require scoped rerun to be narrower than the change-scoped suite`);
    assert.match(content, /scoped[\s\S]{0,220}(疑慮|doubt|specific finding|具體 finding)|(疑慮|doubt|specific finding|具體 finding)[\s\S]{0,220}scoped/,
      `${name} must reserve test reruns for scoped concrete doubts/findings`);
  }

  const packetPrefixSource = read(".devpro/scripts/validate-second-review-packet.mjs");
  assert.match(packetPrefixSource, /changed_main_or_tier_suite_default: no/,
    "secondReviewPacketStaticPrefix must declare changed_main_or_tier_suite_default: no");
  assert.match(packetPrefixSource, /multi_gate_rerun_default: no/,
    "secondReviewPacketStaticPrefix must declare multi_gate_rerun_default: no");
  assert.match(
    packetPrefixSource,
    /scoped_rerun_allowed_only_for: missing_contradictory_suspicious_primary_evidence_or_specific_finding/,
    "secondReviewPacketStaticPrefix must narrow scoped_rerun_allowed_only_for beyond evidence-backed focused verification"
  );
  assert.match(packetPrefixSource, /scoped_rerun_narrower_than_change_scoped_suite: yes/,
    "secondReviewPacketStaticPrefix must require scoped_rerun_narrower_than_change_scoped_suite: yes");
  assert.match(
    packetPrefixSource,
    /negative_example: node \.devpro\/scripts\/run-test-suite\.mjs --changed main is not scoped rerun/,
    "secondReviewPacketStaticPrefix must include --changed main is not scoped rerun negative example"
  );
  assert.match(
    packetPrefixSource,
    /pr_integration_evidence_scope: complete_unit_tier_plus_integration_tests_added_or_modified_by_this_pr_including_shard_wrappers/,
    "secondReviewPacketStaticPrefix must declare pr_integration_evidence_scope"
  );
  assert.match(
    packetPrefixSource,
    /other_integration_evidence_absence_is_finding: no/,
    "secondReviewPacketStaticPrefix must declare other_integration_evidence_absence_is_finding: no"
  );
  assert.match(
    packetPrefixSource,
    /full_integration_suite_owner: dp_rule_governance_and_release/,
    "secondReviewPacketStaticPrefix must declare full_integration_suite_owner: dp_rule_governance_and_release"
  );
  assert.doesNotMatch(
    packetPrefixSource,
    /scoped_rerun_allowed_only_for: evidence-backed focused verification/,
    "secondReviewPacketStaticPrefix must not keep the over-broad evidence-backed focused verification allowlist"
  );

  const codexHost = carriers.get("codex-host-cross-review.md");
  const claude = carriers.get("claude-code-cross-review.md");
  for (const [name, content] of [
    ["codex-host-cross-review.md", codexHost],
    ["claude-code-cross-review.md", claude],
  ]) {
    assert.match(content, /focused sticky-refresh[\s\S]{0,240}(latest delta|current gate\/test evidence|只評估)/,
      `${name} must keep focused sticky-refresh constrained to delta and current evidence`);
    assert.match(content, /default[\s\S]{0,240}allowlist[\s\S]{0,240}(MUST NOT|不得)[\s\S]{0,180}(Node\/npm|full-suite|budget)/i,
      `${name} default allowlist must not include broad test/budget commands`);
    assert.match(content, /permission_denials[\s\S]{0,220}(不得宣稱|MUST NOT claim|not claim)/,
      `${name} must prevent sticky overclaiming denied optional verification`);
  }
});

test("Scenario: Second Reviewer Scopes Integration Evidence To This PR", () => {
  const evidenceLeaf = read(".devpro/agent-rules/pr-review-evidence-verification.md");
  const suiteCadence = read(".devpro/agent-rules/test-suite-cadence.md");
  assert.match(
    evidenceLeaf,
    /PR-stage integration 證據範圍/,
    "pr-review-evidence-verification.md missing PR-stage integration evidence scope rule"
  );
  assert.match(
    evidenceLeaf,
    /範圍定義 SSOT：`test-suite-cadence\.md`「PR-stage integration 證據範圍」/,
    "pr-review-evidence-verification.md must pointer scope definition to test-suite-cadence.md SSOT bullet"
  );
  assert.match(
    evidenceLeaf,
    /本 PR 新增或修改的 integration tests[\s\S]{0,80}仍須有全綠 primary evidence/,
    "pr-review-evidence-verification.md must require green primary evidence for this PR's own integration tests"
  );
  assert.match(
    evidenceLeaf,
    /其他 integration tests[\s\S]{0,120}MUST NOT[\s\S]{0,20}列為 finding/,
    "pr-review-evidence-verification.md must state other integration evidence absence MUST NOT be a finding"
  );
  assert.match(
    suiteCadence,
    /PR-stage integration 證據範圍[\s\S]{0,200}其他 integration tests[\s\S]{0,200}MUST NOT[\s\S]{0,20}列為 finding/,
    "test-suite-cadence.md SSOT bullet must define the PR-stage integration evidence scope"
  );
});

test("cross-review.md When to Use contains reverse-guardrail clause", () => {
  const crossReview = read(".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md");
  // Section-scoped check (D1 shared sliceSection): the guardrail must live INSIDE
  // the `## When to Use` section, not anywhere in the file. Slice from the
  // When-to-Use heading to the next same-or-higher-level heading — otherwise the
  // keyword could drift to another section and still false-pass.
  let section;
  try {
    section = sliceSection(crossReview, /## When to Use/, []);
  } catch {
    section = null;
  }
  assert.ok(section, "cross-review.md 缺少 `## When to Use` 段（或其後缺下一個同級或更高級 heading 段界）");
  assert.ok(
    section.includes("反向護欄"),
    "cross-review.md `## When to Use` 段內缺少「反向護欄」關鍵詞：該條款可能被刪除、改名、或移出 When to Use 段，請恢復",
  );
});

test("Codex-host dispatch message template role-scopes callback-waiting to the dispatching TL and forbids transfer to the projection", () => {
  const crossReview = read(".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md");
  // The Codex-host `spawn_agent({ agent_type: "dp-second-reviewer", message: ... })` block is
  // sent verbatim as the projection's own inbound instructions — a reader with no other
  // context. A subject-less "callback-capable runtime MUST NOT poll" sentence inside that
  // block reads as self-referential to the projection (Fault B's original inducement),
  // even though every other maintained `dp-second-reviewer` carrier (SKILL.md:89,
  // `.claude/agents/dp-second-reviewer.md`, `.codex/agents/dp-second-reviewer.toml`) already
  // role-scopes the identical clause to the dispatching TL and states the licence does not
  // transfer to the projection. This test targets ONLY the fenced dispatch-message content
  // (not the file as a whole) so it cannot false-pass on the correctly TL-scoped prose at
  // `cross-review/SKILL.md:74`, which sits outside the fence and already names "TL" as
  // the subject.
  const dispatchBlockMatch = crossReview.match(/Codex host 委派格式[\s\S]*?```\n([\s\S]*?)\n```/);
  assert.ok(
    dispatchBlockMatch,
    "cross-review/SKILL.md: could not locate the fenced Codex-host `spawn_agent` dispatch message block"
  );
  const dispatchBlock = dispatchBlockMatch[1];

  assert.match(
    dispatchBlock,
    /dispatching TL[\s\S]{0,30}waits[\s\S]{0,30}callback/,
    "Codex-host dispatch message MUST name the dispatching TL as the subject that waits the callback/event " +
      "(mirrors second-review/SKILL.md:89-90); an unscoped sentence lets the projection reader treat itself " +
      "as the callback-capable runtime that must stop polling and just end its turn"
  );
  assert.match(
    dispatchBlock,
    /callback-waiting[\s\S]{0,40}不得[\s\S]{0,30}轉移給本 projection[\s\S]{0,160}return gate 的擁有者/,
    "Codex-host dispatch message MUST state that the callback-waiting licence does not transfer to the " +
      "projection as licence to background `projection_runner_command` and end its turn, and that the " +
      "projection remains the owner of its own return gate"
  );
  assert.doesNotMatch(
    dispatchBlock,
    /只有 callback event 或\s*\n?\s*reviewer process close 可作 terminal completion signal/,
    "Codex-host dispatch message MUST NOT claim callback event or reviewer process close alone is a terminal " +
      "completion signal — that reads as licence to skip reading the projection's own attempt_id terminal " +
      "events in activity_log_path before returning any verdict (R8 Terminal-Evidence Return Gate)"
  );
});

test("Claude safe-mode sticky carriers require one quoted API authority path with no blind-create fallback", () => {
  const carriers = new Map([
    ["shared rule", read(".devpro/agent-rules/code-review-cross-model-cli-contract.md")],
    ["Codex-host adapter", read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md")],
    ["Claude reviewer adapter", read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md")],
    ["second-review skill", read(".devpro/agent-skills/devpro-reviews/second-review/SKILL.md")],
  ]);

  for (const [name, content] of carriers) {
    assert.match(content, /complete canonical marker candidate set/, `${name} must require complete pre-write enumeration`);
    assert.match(content, /zero=create, one=update|sticky_write_exact_recipe/, `${name} must pin the 0\/1 authority writes`);
    assert.match(content, /more-than-one or unresolved count\/id=blocked with no write|more-than-one\/unresolved=no-write/, `${name} must fail closed on ambiguous authority`);
    assert.match(content, /write-second-review-sticky-gated\.mjs|sticky_write_exact_recipe/, `${name} must pin gated sticky write path`);
    assert.doesNotMatch(content, /zero=one POST, one=one PATCH/, `${name} must not retain legacy POST\/PATCH authority mapping`);
    assert.match(content, /MUST NOT try another create primitive/, `${name} must forbid fallback creation`);
  }

  for (const [name, content] of [...carriers].slice(1, 3)) {
    assert.doesNotMatch(content, /--allowedTools "[^"\n]*gh pr comment/, `${name} must not allow blind gh pr comment creation`);
  }
});

test(".devpro/agent-skills is synced and .claude/.agents skills are symlink discovery", () => {
  assert.match(read(".devpro/scripts/tests/multi-runtime-parity.test.mjs"), /\.devpro\/agent-skills/);
  assertSkillDiscoveryDirIsSymlinksOnly(".claude/skills");
  assertSkillDiscoveryDirIsSymlinksOnly(".agents/skills");
  assert.equal(existsSync(repoPath("skills")), false, "root skills/ must not be used");
});

test("cross-review pass skip exempt results bridge to ready next step", () => {
  const crossReview = read(".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md");
  const prePr = read(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md");
  const postPrGate = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const checklist = read(".devpro/agent-rules/code-review-checklist.md");
  const checklistSpec = readIfExists(
    "openspec/changes/strengthen-second-reviewer-idle-timeout/specs/code-review-checklist/spec.md",
  ) || read("openspec/specs/code-review-checklist/spec.md");

  for (const [name, content] of new Map([
    ["cross-review/SKILL.md", crossReview],
    ["pre-pr/SKILL.md", prePr],
    ["post-pr-completion-gate.md", postPrGate],
    ["code-review-checklist.md", checklist],
    ["code-review-checklist spec", checklistSpec],
  ])) {
    assert.match(content, /Ready Response Next-Step Contract/, `${name} must cite ready contract`);
    assert.match(content, /PASS\/WARN|PASS\|WARN|PASS[\s\S]{0,80}WARN/, `${name} must mention PASS/WARN`);
    assert.match(content, /skip\/exempt|skip[\s\S]{0,80}exempt/, `${name} must mention skip/exempt`);
    assert.match(content, /CurrentIntent/, `${name} must carry CurrentIntent`);
    assert.match(content, /NextAction/, `${name} must carry NextAction`);
    assert.match(content, /AskFirstPending/, `${name} must carry AskFirstPending`);
  }

  for (const [name, content] of new Map([
    ["cross-review/SKILL.md", crossReview],
    ["pre-pr/SKILL.md", prePr],
    ["code-review-checklist.md", checklist],
  ])) {
    assert.match(content, /post-pr-completion-gate\.md/, `${name} must point to post-pr gate SSOT`);
    assert.match(content, /owner|Owner:/, `${name} must identify owner`);
    assert.match(content, /next action|Next step:|下一/, `${name} must identify next action`);
  }
});

// ── Guard 強度邊界（per `rule-anchor-guard-strength.md`）──────────────────────────
// 本 guard 只鎖三件事：render-first handoff 欄位「存在」、dispatch identity「可解析」、
// first-executable-action 句「極性未被反轉」。它**無法**鎖欄位**值**的語意正確性
// （`packet_path: <隨手編的路徑>` 照樣過）——那是 token-presence grep 的根本極限
// （見該 leaf §根本極限），防線是 cross-model / 人審，不是在此再加 includes。
//
// 三條實作紀律，改動本段前務必先讀：
// 1. **必須 block-isolated 才能斷言**：`cross-review/SKILL.md` 同檔內的 Codex block 帶滿
//    全部 10 個欄位、L71 prose 也逐一列出同組欄位名。任何整檔 `content.includes(<欄位>)`
//    都會被它們代償而**永遠偽綠**——這正是本 bug 六個月未被發現的機制。故每個 block 先以
//    isolation regex 切出子字串再斷言；isolation 失配 MUST 先紅，禁 optional chaining 靜默略過。
// 2. **禁 alternation**：10 個欄位各自一條獨立檢查。合併成 `/(packet_path|heartbeat_path|…)/`
//    會讓任一欄位單獨滿足即整組 pass，是該 leaf 明文禁止的代償式寫法。
// 3. **polarity 用 `[^\n]{0,20}` 相鄰性上限，不得放寬為 `[\s\S]`**：B1/B3 的 payload 現為多行
//    template literal，故 `[^\n]` 是**實際生效**的「同一物理行」約束，而非恆真退化；`{0,20}`
//    在其上另加相鄰性上限，防極性詞與受詞由同一行的遠端供給。把該句折行會誤紅＝fail-closed，
//    屬預期行為，正解是把句子重排回單行而非放寬 regex。若確需放寬，MUST 三處同步改並更新本 caveat。
//
// 選配欄位 `reviewer_cli_recipe.required_invocation_args` 刻意**不**納入 10 條必填：它是
// sidecar MUST expose 而非 renderer `requiredSpawnPayloadFields` 成員，鎖成 required 會與
// `render-second-review-packet.mjs` 的 SSOT 漂移。
//
// 收斂判準（mutation 審計）：本 test 收集所有問題後一次 assert，故「刪任一 operative 行」
// 對應「problems 恰多一筆」，與逐條 assert 的「恰一條轉紅」等價且可一次看到全部缺口。

// SSOT: `render-second-review-packet.mjs` 的 9 個 `requiredSpawnPayloadFields`
// + `openspec/specs/cross-runtime-parity/spec.md` 的第 10 個 `tl_pre_dispatch_contract`
// （第 10 個以完整常值斷言——該值本身就是契約 token，寫錯值等同沒帶）。
//
// 每個 token 都綁**宣告形式**（尾隨冒號），不是裸 token：這幾個名字在同一個 block 的散文段
// 也會出現（例如 `projection_runner_command` 出現在 first-executable-action 句、
// `observability_context_path` 出現在 probe 指令示例），裸 token 會讓「欄位宣告行被刪掉」
// 被同 block 的散文代償而不轉紅——mutation 審計正是用來抓這種 block 內代償。
const RENDER_FIRST_HANDOFF_FIELDS = [
  "packet_path:",
  "observability_context_path:",
  "heartbeat_path:",
  "activity_log_path:",
  "stdout_log_path:",
  "stderr_log_path:",
  "cli_probe_result_path:",
  "projection_bootstrap_command:",
  "projection_runner_command:",
  "tl_pre_dispatch_contract: tl-must-render-before-runtime-native-projection-spawn",
];

// polarity-sensitive：「必須先執行」可被 token-preserving 反轉為「不必先執行」，
// 故極性詞與受詞必須綁在同一個 bounded window 內（紀律 3）。
const FIRST_EXECUTABLE_ACTION_POLARITY =
  /第一個 executable action[^\n]{0,20}必須先執行[^\n]{0,20}projection_runner_command/;

// Claude host 與 Codex host 的四處實質差異（照抄對方值會製造新的 runtime 缺陷）：
// `review_material_carrier` Claude 只能 embedded-diff——Claude-host reviewer 走
// `codex exec --json`，live read 會撐爆 runner 的 64 KiB line bound
// （`platform-adapters/claude-code-cross-review.md`）；`--verbose` 是 Codex-host-Claude
// 專屬 flag；sticky writer 是 Codex-family（Claude host）／Claude-family（Codex host）。
// D5：單一雙向 `HOST_DIFF_MATRIX` 取代兩個單向常數——對每一列，Claude 側斷言「含 claude
// 值」＋「不含 codex 值」，Codex 側對稱斷言，讓「照抄對方值」在兩側都轉紅。正向措辭刻意
// 固定為單一 canonical 形式而非 alternation：即使同義詞在語境上等價，alternation 仍會讓
// 其中一半被靜默改寫而不轉紅。`claude: null` 代表該列在 Claude 側無正向值可斷言（僅禁止）。
const HOST_DIFF_MATRIX = [
  { name: "primary_family", kind: "declaration", claude: "primary_family: claude", codex: "primary_family: openai-codex" },
  {
    name: "review_material_carrier",
    kind: "declaration",
    claude: "review_material_carrier: embedded-diff",
    codex: "review_material_carrier: embedded-diff | adapter-live-pr-reads",
  },
  {
    name: "sticky-writer-family",
    kind: "phrase",
    claude: "adapter-designated Codex-family reviewer",
    codex: "Claude-family reviewer",
  },
  { name: "--verbose", kind: "phrase", claude: null, codex: "--verbose" },
];

// completion JSON 回傳 caveat（B1/B2/B3 三側須集合相等，C2）：禁在 completion JSON 帶 local
// path 或 raw evidence——沿用 `second-review-control-evidence.md:86` 同一字面「禁 local
// path/raw evidence」（R9）。completion JSON 本身只回五欄位 sticky_comment_url/verdict/
// last_reviewed_sha/reviewer_model/reason（`openspec/specs/cross-runtime-parity/spec.md`
// 「The exact completion object MUST contain only...」段）——這與 second-review-control-
// evidence.md:86 描述的「Handoff 顯示欄位」（class/responsibility/denied class/provenance/
// confidence/matcher/capsule-integrity-prefix/next step）是不同概念；三份 carrier 先前誤把
// 「只回 class/summary/provenance」寫進 completion JSON 段落（把兩個概念混為一談），已訂正為
// 準確的五欄位字面。
const COMPLETION_JSON_CAVEAT = "completion JSON 禁 local path/raw evidence";

const CROSS_REVIEW_SKILL = ".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md";
const PRE_PR_DISPATCH_BLOCKS =
  ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md";
// dp-analyst / dp-architect dispatch blocks (第五步 / 第六步) live in the full-rigor reference.
const CHANGE_FULL_REFERENCE = ".devpro/agent-skills/devpro-workflows/change/references/full-analysis-and-design.md";

// B1/B3 是修正對象；B2 納入以防**反向**漂移（Codex block 被削弱）；B4/B5/B6 不經 projection
// wrapper，故只驗 identity——納入它們是為了讓「dispatch block 的 target 必須在該 host 的 agent
// registry 解得開」涵蓋 repo 內**現存全部** TL-facing dispatch worked example，而非只鎖修正對象。
// 本 registry 是**人工維護**的，無 discovery 機制：新增 dispatch worked example 時 MUST 一併登錄，
// 否則該 block 不受任何斷言保護。此清單經 `grep -rn 'Agent({\|spawn_agent(' .devpro` 窮盡確認。
// `anchor` 只鎖 anchor 那一行；section 邊界一律由共用 `sliceSection`（D1）以
// 「下一個同級或更高級 heading／同檔下一個 sibling anchor／EOF」取 min 決定，
// 不再由每條 entry 各自寫 lazy fence regex（那樣會被干擾 fence 誘導，見 T1 prove-it）。
// S1：全部 6 個 anchor 皆加 `^`（`m` flag）行首錨定——散文/heading anchor 若只裸比對片語，
// 未來若同檔別處（如範例、anti-example 段）出現同一片語的非 anchor 出現，會被錯誤取用成
// section 起點；標題型（`##`）與粗體型（`**`）anchor 額外連同各自的 heading/bold 前綴一起
// 錨在行首，確保只命中真正的 heading／bold 宣告行，不命中散文段落內同字面的引用。
const DISPATCH_BLOCK_REGISTRY = [
  {
    id: "B1 (Claude host / devpro:cross-review)",
    file: CROSS_REVIEW_SKILL,
    anchor: /^Claude Code host 委派格式/m,
    projectionRoute: true,
    hostFamily: "claude",
  },
  {
    id: "B2 (Codex host / devpro:cross-review)",
    file: CROSS_REVIEW_SKILL,
    anchor: /^Codex host 委派格式/m,
    projectionRoute: true,
    hostFamily: "codex",
  },
  {
    id: "B3 (Claude host / subagent-dispatch-blocks Step 5.5.3)",
    file: PRE_PR_DISPATCH_BLOCKS,
    anchor: /^## Step 5\.5\.3:/m,
    projectionRoute: true,
    hostFamily: "claude",
  },
  {
    id: "B4 (dp-reviewer / subagent-dispatch-blocks Step 3)",
    file: PRE_PR_DISPATCH_BLOCKS,
    anchor: /^## Step 3:/m,
    projectionRoute: false,
    hostFamily: null,
  },
  {
    id: "B5 (dp-analyst / devpro:change 第五步)",
    file: CHANGE_FULL_REFERENCE,
    anchor: /^\*\*第五步：呼叫 `dp-analyst`/m,
    projectionRoute: false,
    hostFamily: null,
  },
  {
    id: "B6 (dp-architect / devpro:change 第六步)",
    file: CHANGE_FULL_REFERENCE,
    anchor: /^\*\*第六步：呼叫 `dp-architect`/m,
    projectionRoute: false,
    hostFamily: null,
  },
];

// identity 用**解析式**而非字面比對：`includes('subagent_type: "dp-second-reviewer"')` 只鎖住
// 本次改成的那個字面值，任何 block 改用另一個錯名時完全不設防。解析式把規則寫成「registry 內
// 每個 dispatch block 的 target 都必須解得開」（涵蓋範圍受上方人工維護的 registry 界定），
// 並順帶鎖住 agent registry 檔未被刪。
function resolveDispatchIdentity(blockId, body, problems) {
  const claudeTarget = body.match(/\bsubagent_type:\s*"([^"]+)"/);
  const codexTarget = body.match(/\bagent_type:\s*"([^"]+)"/);
  const target = claudeTarget ?? codexTarget;
  if (!target) {
    problems.push(`${blockId}: dispatch block 內找不到 subagent_type / agent_type`);
    return;
  }

  const name = target[1];
  const registryRelPath = claudeTarget
    ? path.join(".claude", "agents", `${name}.md`)
    : path.join(".codex", "agents", `${name}.toml`);
  const registryAbsPath = repoPath(registryRelPath);
  if (!existsSync(registryAbsPath)) {
    problems.push(
      `${blockId}: dispatch target "${name}" 在 host agent registry 解不開——${registryRelPath} 不存在。` +
        `（常見成因：把 skill 名當 agent 名。skill 名見 .devpro/agent-skills/manifest.json，` +
        `agent 名見該 registry 檔的 name 宣告。）`
    );
    return;
  }

  const registrySource = readFileSync(registryAbsPath, "utf8");
  const declaredName = claudeTarget
    ? registrySource.match(/^name:\s*(\S+)/m)
    : registrySource.match(/^name\s*=\s*"?([^"\n]+?)"?\s*$/m);
  if (!declaredName) {
    problems.push(`${blockId}: ${registryRelPath} 缺可解析的 name 宣告`);
    return;
  }
  if (declaredName[1] !== name) {
    problems.push(
      `${blockId}: dispatch target "${name}" 與 ${registryRelPath} 宣告的 name "${declaredName[1]}" 不符`
    );
  }
}

function auditRenderFirstHandoff(blockId, body, problems) {
  for (const field of RENDER_FIRST_HANDOFF_FIELDS) {
    // I2：field 若是完整 "key: value" 宣告（不以裸 `:` 結尾——即值本身就是契約 token，如第
    // 10 個 `tl_pre_dispatch_contract: ...`），MUST 用整行精確比對（declarationLineRegex，
    // `^value$`）而非僅行首錨定的 fieldDeclarationRegex（`^field`）——後者只鎖字面前綴，值被
    // 延長後綴（如接 `-v2`）仍會偽陽通過，等同沒鎖住這個值本身。純欄位名宣告（值可變）仍用
    // fieldDeclarationRegex。
    const isFullDeclaration = !field.endsWith(":");
    const regex = isFullDeclaration ? declarationLineRegex(field) : fieldDeclarationRegex(field);
    if (regex.test(body)) continue;
    problems.push(
      `${blockId}: projection-route dispatch block 缺 render-first handoff 欄位 \`${field}\`。` +
        `TL 照抄此範例會被 projection wrapper 以 projection_observability_contract_missing 擋下。`
    );
  }
  if (!FIRST_EXECUTABLE_ACTION_POLARITY.test(body)) {
    problems.push(
      `${blockId}: 缺（或極性被反轉）「第一個 executable action 必須先執行 ` +
        `projection_runner_command」句——極性詞與受詞必須落在同一 bounded window 內`
    );
  }
}

// D5：雙向矩陣稽核——對每一列，`hostFamily` 側斷言「含己方值」＋「不含對方值」，
// 讓「照抄對方 host 值」在**兩側**都轉紅（取代舊版只鎖 Claude 單向）。`ownValue`/`otherValue`
// 任一為 null 代表該側無正向值可斷言（`--verbose` 列 Claude 側只禁止、不要求）。
// forbidden 側同樣升為 D3 的有邊界形式（宣告行用行錨定、片語用尾界），限定在該欄位的宣告
// 位置比對，避免（如 `review_material_carrier` 的 Codex 合法值含 `embedded-diff` 子字串）
// 跨語境誤報。
function auditHostDiffMatrix(blockId, body, hostFamily, problems) {
  const otherFamily = hostFamily === "claude" ? "codex" : "claude";
  for (const row of HOST_DIFF_MATRIX) {
    const regexFor = (value) => (row.kind === "declaration" ? declarationLineRegex(value) : phraseBoundaryRegex(value));
    const ownValue = row[hostFamily];
    const otherValue = row[otherFamily];
    if (ownValue !== null && !regexFor(ownValue).test(body)) {
      problems.push(`${blockId}: ${hostFamily} host block 缺 host-specific 值 \`${ownValue}\`（欄位 ${row.name}）`);
    }
    if (otherValue !== null && otherValue !== ownValue && regexFor(otherValue).test(body)) {
      problems.push(
        `${blockId}: ${hostFamily} host block 出現 ${otherFamily}-host 專屬值 \`${otherValue}\`` +
          `（欄位 ${row.name}，照抄對方範例的徵兆）`
      );
    }
  }
}

// R7：B1 缺 `projection_cli_probe_started` / `projection_cli_probe_result` 兩個 probe 事件名
// （B2 已有；依 TL Q2 定案擴及 B3）。
const PROBE_EVENT_NAMES = ["projection_cli_probe_started", "projection_cli_probe_result"];

function auditProbeEventNames(blockId, body, problems) {
  // S5：改用 phraseBoundaryRegex（尾界 `(?![\w-])`）取代裸 `includes()`——事件名若被
  // 延長成他名的前綴（如未來新增 `projection_cli_probe_started_v2`）不得偽陽撐綠。
  for (const eventName of PROBE_EVENT_NAMES) {
    if (phraseBoundaryRegex(eventName).test(body)) continue;
    problems.push(`${blockId}: host-tagged dispatch block 缺 probe 事件名 \`${eventName}\`（R7）`);
  }
}

function auditCompletionJsonCaveat(blockId, body, problems) {
  // S5：同上，caveat 全句用尾界比對，避免未來被延長措辭偽陽代償。
  if (phraseBoundaryRegex(COMPLETION_JSON_CAVEAT).test(body)) return;
  problems.push(
    `${blockId}: host-tagged dispatch block completion JSON 段缺「${COMPLETION_JSON_CAVEAT}」caveat（R9）`
  );
}

// D5 host-neutral 集合相等：對每個 host-tagged projection-route body 取 `^[a-z_][a-z_0-9.]*:`
// 的欄位名集合，扣除矩陣列出的 host-specific 欄位（僅 declaration kind——phrase kind 不是
// 欄位宣告）後，MUST 兩兩相等。`routing_context` 判為「鍵存在＝host-neutral、條目內容＝
// host-specific」——鍵名本身不在矩陣內，故落在此集合相等檢查範圍。
// I3：B1（devpro:cross-review Claude host）／B2（devpro:cross-review Codex host）／B3
// （subagent-dispatch-blocks Step 5.5.3，TL-facing 的同一契約第二份 Claude host 手工副本）
// 是同一 dispatch 契約的三份手工投影，只驗 B1/B2 會漏掉 B3 單獨漂移（第 4 條「同契約多投影
// 集合相等」須涵蓋**全部**現存投影，非任兩份）。改接受 `Map<label, body>` 並做全兩兩比較，
// 使新增第 4 份投影時只需擴充呼叫端的 Map，不需再改本函式簽章。
function extractFieldNames(body) {
  const names = new Set();
  const regex = /^([a-z_][a-z_0-9.]*):/gm;
  let match;
  while ((match = regex.exec(body))) names.add(match[1]);
  return names;
}

function auditHostNeutralFieldSet(bodiesByLabel, problems) {
  const hostSpecificFieldNames = new Set(
    HOST_DIFF_MATRIX.filter((row) => row.kind === "declaration").map((row) => row.name)
  );
  const fieldSetsByLabel = new Map(
    [...bodiesByLabel].map(([label, body]) => [
      label,
      new Set([...extractFieldNames(body)].filter((f) => !hostSpecificFieldNames.has(f))),
    ])
  );
  const labels = [...fieldSetsByLabel.keys()];
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const labelA = labels[i];
      const labelB = labels[j];
      const setA = fieldSetsByLabel.get(labelA);
      const setB = fieldSetsByLabel.get(labelB);
      const onlyInA = [...setA].filter((f) => !setB.has(f));
      const onlyInB = [...setB].filter((f) => !setA.has(f));
      if (onlyInA.length > 0) {
        problems.push(`${labelA}/${labelB} host-neutral 欄位集合不相等：只在 ${labelA} 出現 ${onlyInA.join(", ")}`);
      }
      if (onlyInB.length > 0) {
        problems.push(`${labelA}/${labelB} host-neutral 欄位集合不相等：只在 ${labelB} 出現 ${onlyInB.join(", ")}`);
      }
    }
  }
}

test("every maintained host dispatch block carries a resolvable identity, and every projection-route block carries the full render-first handoff contract", () => {
  const problems = [];
  const sourceCache = new Map();
  const hostNeutralProjectionBodies = new Map();

  for (const block of DISPATCH_BLOCK_REGISTRY) {
    if (!sourceCache.has(block.file)) sourceCache.set(block.file, read(block.file));
    const source = sourceCache.get(block.file);
    // sibling anchor＝同檔其他 registry entry 的 anchor（順序無關，sliceSection 只取
    // bodyStart 之後最近的一個），讓 level-0（散文／粗體）anchor 不會吃到隔壁 block。
    const siblingAnchors = DISPATCH_BLOCK_REGISTRY.filter(
      (other) => other !== block && other.file === block.file
    ).map((other) => other.anchor);

    let section;
    try {
      section = sliceSection(source, block.anchor, siblingAnchors);
    } catch (err) {
      // anchor 失配 MUST 先紅：否則後續斷言會在 undefined 上噴無關錯誤，
      // 或（更糟）若寫成 optional chaining 就靜默略過整個 block。
      problems.push(
        `${block.id}: 在 ${block.file} 找不到 anchor（${err.message}，多半是 anchor 標題被改寫` +
          `——請同步更新 DISPATCH_BLOCK_REGISTRY，勿刪斷言）`
      );
      continue;
    }

    const fences = fencedBlocksInSection(section);
    if (fences.length !== 1) {
      const anchorMatch = block.anchor.exec(source);
      const startLine = lineNumberAt(source, anchorMatch.index);
      const endLine = lineNumberAt(source, anchorMatch.index + section.length);
      problems.push(
        `${block.id}: section 內 fenced block 數 = ${fences.length}（應恰好 1，行範圍 ${startLine}-${endLine}）。` +
          `多半是干擾 fence 混入該 section，或 anchor／sibling anchor 未同步更新——請勿刪斷言`
      );
      continue;
    }
    const body = fences[0].match(/```\n([\s\S]*?)\n```/)[1];

    resolveDispatchIdentity(block.id, body, problems);
    if (block.projectionRoute) auditRenderFirstHandoff(block.id, body, problems);
    if (block.hostFamily) {
      auditHostDiffMatrix(block.id, body, block.hostFamily, problems);
      auditProbeEventNames(block.id, body, problems);
      auditCompletionJsonCaveat(block.id, body, problems);
    }
    // I3：B1/B2/B3 是同一 dispatch 契約的三份手工投影（B3 為 subagent-dispatch-blocks
    // Step 5.5.3，供 devpro:pre-pr 呼叫，語意上等同 B1 的 TL-facing 副本）；三者皆納入
    // host-neutral 欄位集合相等掃描，而非只驗 B1/B2。
    if (block.id.startsWith("B1 ")) hostNeutralProjectionBodies.set("B1", body);
    if (block.id.startsWith("B2 ")) hostNeutralProjectionBodies.set("B2", body);
    if (block.id.startsWith("B3 ")) hostNeutralProjectionBodies.set("B3", body);
  }

  if (hostNeutralProjectionBodies.size >= 2) {
    auditHostNeutralFieldSet(hostNeutralProjectionBodies, problems);
  }

  assert.equal(
    problems.length,
    0,
    `host dispatch block 契約違規 ${problems.length} 項：\n- ${problems.join("\n- ")}`
  );

  // ---- T1 prove-it（committed-regression 三段式，in-memory mutants only）----
  // 每組分兩半，且兩半互相獨立、不得互相代償：
  // 1) 前提失效 — 凍結重現「舊／寬鬆形式」判斷邏輯（不呼叫任何會被 T2/T3 改寫的
  //    production 函式／常數），機械證明它對 mutant 偽陽。此半邊獨立於 T2/T3 是否已
  //    落地，理論上永遠綠（凍結快照，不隨後續重構變動）。
  // 2) 退化偵測 — 呼叫將由 T2/T3 落地的嚴格 production 邏輯，斷言它正確攔截同一個
  //    mutant。T2/T3 之前預期紅（`sliceSection` 尚未定義／host 差異比對仍用寬鬆
  //    `includes`）；T2/T3 落地後轉綠且應永遠保持綠——嚴禁為了提早轉綠而放寬。

  function spliceAfterAnchorLine(source, anchorRegex, insertText) {
    const match = anchorRegex.exec(source);
    if (!match) throw new Error(`spliceAfterAnchorLine: anchor 不匹配（${anchorRegex}）`);
    const lineEnd = source.indexOf("\n", match.index);
    const insertAt = lineEnd === -1 ? source.length : lineEnd + 1;
    return source.slice(0, insertAt) + insertText + source.slice(insertAt);
  }

  const b1Entry = DISPATCH_BLOCK_REGISTRY.find((entry) => entry.id.startsWith("B1 "));
  const b2Entry = DISPATCH_BLOCK_REGISTRY.find((entry) => entry.id.startsWith("B2 "));
  const b5Entry = DISPATCH_BLOCK_REGISTRY.find((entry) => entry.id.startsWith("B5 "));
  const b6Entry = DISPATCH_BLOCK_REGISTRY.find((entry) => entry.id.startsWith("B6 "));

  // (a)(b) A1 型：干擾 fence 插在 anchor 之後、真實 dispatch fence 之前。舊 lazy-fence
  // isolation（`anchor[\s\S]*?```\n([\s\S]*?)\n```）遇到此排列會被誘導，lazy 匹配到
  // 「第一個」fence-open/fence-close 配對，也就是干擾 fence，而非真正的 dispatch block。
  // S7：mutant 不再手寫合成字面，改用 real-file read + splice——直接對 B1／B5 的真實檔案
  // 內容，在真實 anchor 行之後插入一個干擾 fence（真實 fence 保持原位不動），讓 mutant 與
  // production 讀到的檔案內容同源，而非另建一份與 registry 脫鉤的獨立字面。
  const decoyDispatchBlock = (targetIdentity) => [
    "干擾範例（勿照抄，僅供 A1 prove-it 使用）：",
    "",
    "```",
    `subagent_type: "${targetIdentity}"`,
    "```",
    "",
  ].join("\n");

  function anchorLine(source, anchorRegex) {
    const match = anchorRegex.exec(source);
    if (!match) throw new Error(`anchorLine: anchor 不匹配（${anchorRegex}）`);
    const lineEnd = source.indexOf("\n", match.index);
    return source.slice(match.index, lineEnd === -1 ? source.length : lineEnd);
  }

  const sectionTerminatingDecoyBlock = (targetIdentity, siblingAnchorLine) => [
    "干擾範例（勿照抄，僅供 S1 prove-it 使用）：",
    "",
    "```",
    `subagent_type: "${targetIdentity}"`,
    siblingAnchorLine,
    "```",
    "",
  ].join("\n");

  const A1_FIXTURES = [
    ["A1 projection-route", read(CROSS_REVIEW_SKILL), b1Entry.anchor, [b2Entry.anchor], "dp-second-reviewer"],
    ["A1 identity-only", read(CHANGE_FULL_REFERENCE), b5Entry.anchor, [b6Entry.anchor], "dp-analyst"],
  ];

  for (const [label, realSource, anchorRegex, _siblingAnchors, targetIdentity] of A1_FIXTURES) {
    // 前提失效：凍結重現現行 DISPATCH_BLOCK_REGISTRY 的 lazy-fence isolation 寫法（把真實
    // anchor 的 regex source 併入凍結 pattern，不呼叫 production `sliceSection` 本身，避免
    // T2 改寫 isolation 邏輯後這半邊失真）。
    const mutant = spliceAfterAnchorLine(realSource, anchorRegex, decoyDispatchBlock(targetIdentity));
    const legacyIsolation = new RegExp(
      `${anchorRegex.source}[\\s\\S]*?\`\`\`\\n([\\s\\S]*?)\\n\`\`\``,
      anchorRegex.flags
    );
    const legacyMatch = mutant.match(legacyIsolation);
    assert.ok(legacyMatch, `${label} prove-it: legacy lazy-fence isolation 應可匹配（前提 setup）`);
    assert.ok(
      legacyMatch[1].includes(`subagent_type: "${targetIdentity}"`),
      `${label} prove-it 前提失效：legacy lazy-fence isolation 對干擾 fence 偽陽——` +
        `機械證明舊形式會誤取干擾 block 而非真正 dispatch block`
    );
    const legacyProblems = [];
    resolveDispatchIdentity(`${label} legacy decoy`, legacyMatch[1], legacyProblems);
    assert.deepEqual(
      legacyProblems,
      [],
      `${label} prove-it 前提失效：registry-valid decoy 應足以讓 legacy identity resolution 偽陽`
    );
  }

  const t1RegressionProblems = [];
  for (const [label, realSource, anchorRegex, siblingAnchors, targetIdentity] of A1_FIXTURES) {
    const mutant = spliceAfterAnchorLine(realSource, anchorRegex, decoyDispatchBlock(targetIdentity));
    try {
      const section = sliceSection(mutant, anchorRegex, siblingAnchors);
      const fences = fencedBlocksInSection(section);
      // 退化偵測轉綠條件：section-bounded 切割須正確同時含干擾與正式兩個 fenced block
      // （fences.length === 2），如此主迴圈的「fenced block 數 !== 1 即 fail closed」
      // 才會被此 mutant 觸發、正確回報「fenced block 數 = 2」。
      if (fences.length !== 2) {
        t1RegressionProblems.push(
          `${label} prove-it 退化偵測：section-bounded 切割應偵測到 2 個 fenced block（干擾 + ` +
            `正式）才能觸發主迴圈的 fail closed 檢查，實際 fenced block 數 = ${fences.length}（待 T2 落地）`
        );
      }
    } catch (err) {
      t1RegressionProblems.push(`${label} prove-it 退化偵測未達成：${err.message}（待 T2 落地）`);
    }
  }

  // (s) S1 型：干擾 fence 內含下一個 registry sibling anchor 的文字。舊 lazy-fence
  // isolation 仍會吃到 registry-valid decoy；而未避開 fenced block 的 sibling anchor scanner
  // 會把 section 截在 decoy fence 中途，讓主迴圈看不到「干擾 + 正式」兩個 fence。
  const S1_SOURCE = read(CROSS_REVIEW_SKILL);
  const S1_DECOY_BLOCK = sectionTerminatingDecoyBlock(
    "dp-second-reviewer",
    anchorLine(S1_SOURCE, b2Entry.anchor)
  );
  const s1Mutant = spliceAfterAnchorLine(S1_SOURCE, b1Entry.anchor, S1_DECOY_BLOCK);
  const s1LegacyIsolation = new RegExp(
    `${b1Entry.anchor.source}[\\s\\S]*?\`\`\`\\n([\\s\\S]*?)\\n\`\`\``,
    b1Entry.anchor.flags
  );
  const s1LegacyMatch = s1Mutant.match(s1LegacyIsolation);
  assert.ok(s1LegacyMatch, "S1 prove-it: legacy lazy-fence isolation 應可匹配 section-terminating decoy");
  const s1LegacyProblems = [];
  resolveDispatchIdentity("S1 legacy section-terminating decoy", s1LegacyMatch[1], s1LegacyProblems);
  assert.deepEqual(
    s1LegacyProblems,
    [],
    "S1 prove-it 前提失效：含 sibling anchor 文字的 decoy 仍須 registry-valid，才能證明 legacy 偽陽"
  );
  try {
    const fixedS1Section = sliceSection(s1Mutant, b1Entry.anchor, [b2Entry.anchor]);
    const fixedS1Fences = fencedBlocksInSection(fixedS1Section);
    if (fixedS1Fences.length !== 2) {
      t1RegressionProblems.push(
        `S1 prove-it 退化偵測：section-bounded 切割應忽略 fenced block 內的 sibling anchor，` +
          `偵測到 2 個 fenced block（干擾 + 真正 B1），實際 fenced block 數 = ${fixedS1Fences.length}`
      );
    }
  } catch (err) {
    t1RegressionProblems.push(`S1 prove-it 退化偵測未達成：${err.message}`);
  }

  // (d) I1 型：level-0（散文／粗體）anchor 的 heading-termination bug——真實 B5 file 內容
  // （S7：real-file splice，非合成字面），在 anchor 行之後、真正 dispatch fence 之前插入一個
  // 比 enclosing heading（`## Process`，level 2）更深的干擾 `#### ` heading + 干擾 fence。
  // 舊邏輯「level 0 anchor 遇任何 heading 皆 terminate」會在插入點就把 section 截斷（連干擾
  // fence 都碰不到），新邏輯（I1：只在 level ≤ enclosing level 才 terminate）應正確跨過干擾
  // heading，取到「干擾 fence + 真正 B5 fence」共 2 個。
  function legacySliceSectionAnyHeadingTerminates(source, anchorRegex) {
    // 前提失效：凍結重現修復前的 sliceSection level-0 分支（任何 heading 皆 terminate），
    // 不呼叫現行（已修復）production `sliceSection`，避免此半邊隨修復失真。
    const anchorMatch = anchorRegex.exec(source);
    const anchorStart = anchorMatch.index;
    const anchorLineEnd = source.indexOf("\n", anchorStart);
    const bodyStart = anchorLineEnd === -1 ? source.length : anchorLineEnd + 1;
    let terminatorIndex = source.length;
    let cursor = bodyStart;
    for (const line of source.slice(bodyStart).split("\n")) {
      const lvl = headingLevel(line);
      if (lvl > 0) {
        terminatorIndex = Math.min(terminatorIndex, cursor);
        break;
      }
      cursor += line.length + 1;
    }
    return source.slice(anchorStart, terminatorIndex);
  }

  const I1_DECOY_BLOCK = [
    "#### 正確做法（decoy，勿照抄，僅供 I1 prove-it 使用）",
    "",
    "```",
    'subagent_type: "decoy-agent"',
    "```",
    "",
  ].join("\n");
  const i1Mutant = spliceAfterAnchorLine(read(CHANGE_FULL_REFERENCE), b5Entry.anchor, I1_DECOY_BLOCK);

  const legacyI1Section = legacySliceSectionAnyHeadingTerminates(i1Mutant, b5Entry.anchor);
  assert.notEqual(
    fencedBlocksInSection(legacyI1Section).length,
    2,
    "I1 prove-it 前提失效：舊邏輯（level-0 anchor 遇任何 heading 皆 terminate）應在插入點就把" +
      " section 截斷，連干擾 fence 都取不到（fences.length !== 2），機械證明舊形式會漏掉真正的" +
      " dispatch fence"
  );

  try {
    const fixedI1Section = sliceSection(i1Mutant, b5Entry.anchor, [b6Entry.anchor]);
    const fixedI1Fences = fencedBlocksInSection(fixedI1Section);
    if (fixedI1Fences.length !== 2) {
      t1RegressionProblems.push(
        `I1 prove-it 退化偵測：修復後的 sliceSection 應正確跨過比 enclosing level 更深的干擾` +
          ` heading，偵測到 2 個 fenced block（干擾 + 真正 B5），實際 fenced block 數 = ` +
          `${fixedI1Fences.length}`
      );
    }
  } catch (err) {
    t1RegressionProblems.push(`I1 prove-it 退化偵測未達成：${err.message}`);
  }

  // (c) A2 三值型：`HOST_DIFF_MATRIX` Claude 側三個 required 值各自延長後綴（宣告行值後綴接
  // 非邊界字元；散文片語後綴接連字號），令寬鬆 `includes()` 偽陽但嚴格邊界形式應偵測為
  // 「值不符」。使用最小自建 body（不含其餘欄位），避免其他斷言（render-first 等）干擾。
  const A2_MUTANT_BODY = [
    'subagent_type: "dp-cross-reviewer"',
    "primary_family: claude-legacy",
    "review_material_carrier: embedded-diffusion",
    "pr-sticky mode 由 adapter-designated Codex-family reviewer-emeritus 自行寫入",
  ].join("\n");

  // 前提失效：凍結重現現行寬鬆 `includes()` 判斷（直接寫死三個延長後綴前的原始字面值，
  // 不引用 HOST_DIFF_MATRIX／不呼叫 auditHostDiffMatrix，避免 T3/T5 改寫該常數/函式後
  // 這半邊失真）。
  for (const value of [
    "primary_family: claude",
    "review_material_carrier: embedded-diff",
    "adapter-designated Codex-family reviewer",
  ]) {
    assert.ok(
      A2_MUTANT_BODY.includes(value),
      `A2 prove-it 前提失效：寬鬆 includes() 應對延長後綴的值偽陽——${value}`
    );
  }

  // 退化偵測：呼叫真正的 production 函式。S6：不只驗總筆數（`length === 3` 無法區分「3 個
  // 正確缺失」與「同一欄位重複回報 3 次＋另兩欄位漏檢」），改為逐欄位斷言——HOST_DIFF_MATRIX
  // 中 `claude` 側非 null 的三列（`primary_family`／`review_material_carrier`／
  // `sticky-writer-family`）皆須各自被回報恰好一筆缺失，且不得有其他非預期欄位混入。
  const a2Problems = [];
  auditHostDiffMatrix("A2 prove-it", A2_MUTANT_BODY, "claude", a2Problems);
  const A2_EXPECTED_FIELD_NAMES = HOST_DIFF_MATRIX.filter((row) => row.claude !== null).map((row) => row.name);
  for (const fieldName of A2_EXPECTED_FIELD_NAMES) {
    const matches = a2Problems.filter((p) => p.includes(`（欄位 ${fieldName}）`));
    if (matches.length !== 1) {
      t1RegressionProblems.push(
        `A2 prove-it 退化偵測：auditHostDiffMatrix 應對欄位 ${fieldName} 的延長後綴值恰好回報 1 筆` +
          `缺失，實際 ${matches.length} 筆（待 T3 落地行錨定／尾界比對）`
      );
    }
  }
  if (a2Problems.length !== A2_EXPECTED_FIELD_NAMES.length) {
    t1RegressionProblems.push(
      `A2 prove-it 退化偵測：auditHostDiffMatrix 總回報筆數應恰為 ${A2_EXPECTED_FIELD_NAMES.length}` +
        `（每個延長後綴值各一筆，無其他非預期欄位），實際 ${a2Problems.length} 筆：` +
        `${JSON.stringify(a2Problems)}`
    );
  }

  assert.equal(
    t1RegressionProblems.length,
    0,
    `T1 prove-it 退化偵測尚未全數轉綠（T2/T3 落地前為預期紅）：\n- ${t1RegressionProblems.join("\n- ")}`
  );
});

// ── T9 (add-external-evaluator-second-review): footer Tool: token SSOT + ──
// executor selection / gemini family-group anchors. Three cross-review
// adapters and cli-invocation.md must no longer hardcode the `Claude Code`
// footer token literal; they must instead point at the closed-set SSOT so a
// future host addition to STICKY_PROVENANCE_TOOL_TOKENS does not leave a
// stale hardcoded copy silently out of sync (D3).
test("cross-review footer Tool: token is SSOT-referenced, not hardcoded, in the three adapters + cli-invocation", () => {
  const claudeAdapter = read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md");
  const codexReviewer = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  const troubleshooting = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review-troubleshooting.md");
  const cliInvocation = read(".devpro/agent-skills/devpro-reviews/cross-review/references/cli-invocation.md");

  for (const [label, body] of [
    ["claude-code-cross-review", claudeAdapter],
    ["codex-host-cross-review", codexReviewer],
    ["codex-host-cross-review-troubleshooting", troubleshooting],
    ["cli-invocation", cliInvocation],
  ]) {
    assert.doesNotMatch(body, /Tool: Claude Code/, `${label}: footer MUST NOT hardcode the Claude Code token literal`);
    assert.match(body, /STICKY_PROVENANCE_TOOL_TOKENS/, `${label}: footer MUST reference the closed-set SSOT`);
  }
  assert.doesNotMatch(cliInvocation, /Tool: <Claude Code\|Codex>/, "cli-invocation.md MUST NOT hardcode the two-host alternation literal");

  // Structural: the SSOT constant itself still lives where these files point.
  const stickyAuthority = read(".devpro/scripts/hooks/lib/second-review-sticky-authority.mjs");
  assert.match(stickyAuthority, /export const STICKY_PROVENANCE_TOOL_TOKENS/);
});

// External evaluator executor-selection entry + Gemini family-group scoping
// in the devpro:second-review skill (D12 §Skills). Structural-existence anchors
// only — reversal of "gemini has no runner recipe" would be a semantic flip
// caught by cross-model review, not a grep guard's job (rule-anchor-guard-
// strength.md §根本極限).
test("devpro:second-review skill documents the external-evaluator executor and gemini family-group scoping", () => {
  const skill = read(".devpro/agent-skills/devpro-reviews/second-review/SKILL.md");

  assert.match(skill, /## Executor Selection/);
  assert.match(skill, /executor_kind/);
  assert.match(skill, /accept-external-second-review\.mjs <packet-dir>/);
  assert.match(skill, /--void-external-dispatch <packet-dir>/);
  assert.match(skill, /"external-evaluator"/);
  assert.match(skill, /REVIEWER_FAMILY_GROUPS/);
  assert.match(skill, /cross_model_family_unprovable/);
  assert.match(skill, /cross_model_family_same/);

  // Polarity-sensitive, same physical line: gemini's lack of a runner recipe
  // and its external-only reachability must stay bound together — splitting
  // "no runner recipe" onto one line and "external-only" onto another would
  // let either half be silently dropped without this guard noticing.
  const skillLines = skill.split("\n");
  const geminiLine = skillLines.find((l) => /reviewer_family: "gemini"/.test(l));
  assert.ok(geminiLine, "gemini reviewer_family 說明行遺失");
  assert.match(geminiLine, /無 runner CLI recipe/, "gemini 行須明示無 runner CLI recipe");
  assert.match(geminiLine, /只能經[\s\S]*external-evaluator/, "gemini 行須明示只能經 external-evaluator 路徑");
});

// Four dp-second-reviewer projections carry the same isomorphic scope
// sentence (D12: "runtime 載入的內容面，非載入機制" — multi-runtime-parity
// stays untouched; this is a content-carrier assertion, not a path/symlink
// one).
test("all four dp-second-reviewer projections declare runner-only projection scope", () => {
  const projections = [
    [".claude/agents/dp-second-reviewer.md", read(".claude/agents/dp-second-reviewer.md")],
    [".codex/agents/dp-second-reviewer.toml", read(".codex/agents/dp-second-reviewer.toml")],
    [".cursor/agents/dp-second-reviewer.md", read(".cursor/agents/dp-second-reviewer.md")],
    [".opencode/agent/dp-second-reviewer.md", read(".opencode/agent/dp-second-reviewer.md")],
  ];
  for (const [label, body] of projections) {
    assert.match(
      body,
      /本 projection 只轄 runner 路徑；external evaluator 走審查單＋收據/,
      `${label}: 缺 runner-only projection scope 同構句`
    );
  }
});

// F-aeesr-r5-01: cross-runtime-parity "Every adapter describes the
// external-evaluator ticket, accept, and void path with the SSOT footer" —
// each host adapter entry (and the four projections the requirement names as
// the Claude Code carrier) must expose issue, accept, void, and the footer SSOT.
test("every host adapter and dp-second-reviewer projection exposes the external-evaluator issue, accept, and void commands", () => {
  const carriers = [
    ".devpro/agent-rules/platform-adapters/claude-code-cross-review.md",
    ".devpro/agent-rules/platform-adapters/codex-host-cross-review.md",
    ".devpro/agent-rules/platform-adapters/cursor.md",
    ".devpro/agent-rules/platform-adapters/opencode.md",
    ".devpro/agent-rules/platform-adapters/copilot.md",
    ".devpro/agent-rules/platform-adapters/gemini.md",
    ".claude/agents/dp-second-reviewer.md",
    ".codex/agents/dp-second-reviewer.toml",
    ".cursor/agents/dp-second-reviewer.md",
    ".opencode/agent/dp-second-reviewer.md",
  ];
  for (const path of carriers) {
    const body = read(path);
    assert.match(body, /external evaluator|External Evaluator/, `${path}: 缺 external evaluator 入口`);
    assert.match(body, /accept-external-second-review\.mjs <packet-dir>/, `${path}: 缺 accept 指令`);
    assert.match(body, /--void-external-dispatch <packet-dir>/, `${path}: 缺作廢指令`);
    assert.match(body, /STICKY_PROVENANCE_TOOL_TOKENS/, `${path}: 缺 footer token SSOT 引用`);
  }
});

// Post-PR disposition detail stays in its action-triggered canonical leaf;
// the always-loaded Codex adapter retains only the discoverable trigger.
test("codex.md routes post-PR detail to its cold gate leaf", () => {
  const codex = read(".devpro/agent-rules/platform-adapters/codex.md");
  const gate = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const trigger = codex.split("\n").find((l) => l.includes("PR create/update 後"));
  assert.ok(trigger, "codex.md first-command matrix PR trigger 遺失");
  assert.match(trigger, /post-pr-completion-gate\.md/);
  assert.match(trigger, /無後續 gh 亦同/);
  assert.match(trigger, /complete\/ready\/merge 前重驗/);
  assert.match(gate, /External marker disposition/);
  assert.match(gate, /clear_policy/);
  assert.doesNotMatch(codex, /External-evaluator marker 不適用上句的 PASS 捷徑與 WARN receipt chain/);
});

// F-aeesr-r7-01: every rule sentence that narrows external-marker clearance to
// the accepted receipt must keep the gate's clear_policy exception (MERGED or
// cross-model exempt), or it contradicts resolveExternalMarkerDisposition.
test("external-marker clearance sentences in control-evidence and post-PR gate rules keep the clear_policy exception", () => {
  const control = read(".devpro/agent-rules/second-review-control-evidence.md");
  const lifecycleZero = control.split("\n").find((l) => /^0\. External marker/.test(l));
  assert.ok(lifecycleZero, "second-review-control-evidence.md §4 第 0 條遺失");
  assert.match(lifecycleZero, /只有 `clear_policy`（`MERGED` 或 cross-model exempt）或 slot `accepted`/);
  const exitLine = control.split("\n").find((l) => /runner marker的authoritative PASS可直接形成/.test(l));
  assert.ok(exitLine, "second-review-control-evidence.md Exit Criteria 行遺失");
  assert.match(exitLine, /external marker除 `clear_policy`（`MERGED` 或 cross-model exempt）外只憑§3\.1 accepted closure收據清除/);
  const gate = read(".devpro/agent-rules/post-pr-completion-gate.md");
  const gateExit = gate.split("\n").find((l) => /^- Cross-model exempt；或authoritative `PASS`/.test(l));
  assert.ok(gateExit, "post-pr-completion-gate.md Exit 行遺失");
  assert.match(gateExit, /external-evaluator marker 除 `clear_policy`（`MERGED` 或 cross-model exempt）外只憑 External marker disposition 的 `clear_verified`/);
  for (const [file, body] of [["second-review-control-evidence.md", control], ["post-pr-completion-gate.md", gate]]) {
    assert.doesNotMatch(body, /只有 slot `accepted`/, `${file}: 殘留排除 clear_policy 的「只有 slot accepted」句`);
    assert.doesNotMatch(body, /external(-evaluator)? marker ?只憑/, `${file}: 殘留未帶 clear_policy 例外的「只憑」句`);
  }
});

// F-aeesr-r1-10: IDE/manual adapters must carry ceiling semantics, not an
// unbounded "highest tier" sentence (the `xhigh.*max` scan missed this wording).
test("cursor and gemini adapters bound reviewer tier by reviewer_effort_ceiling", () => {
  for (const file of [
    ".devpro/agent-rules/platform-adapters/cursor.md",
    ".devpro/agent-rules/platform-adapters/gemini.md",
  ]) {
    const body = read(file);
    assert.match(body, /`reviewer_effort_ceiling`[^\n]*缺省 `xhigh`/, `${file}: 缺 reviewer_effort_ceiling 缺省 xhigh 語意`);
    for (const line of body.split("\n")) {
      if (/最高(相容 )?(reasoning )?tier/.test(line)) {
        assert.match(line, /reviewer_effort_ceiling/, `${file}: 「最高 tier」句未受 ceiling 約束：${line.slice(0, 80)}`);
      }
    }
  }
});

test("Scenario: Ordinary effort changes preserve the cross-review ceiling", () => {
  const codexEffort = read(".devpro/agent-rules/platform-adapters/codex-effort-tiers.md");
  assert.match(codexEffort, /cross-review recipe 政策固定 xhigh/);
  assert.match(codexEffort, /high.*max.*仍 fail-closed/);
});

// strengthen-review-threat-model-severity R1/R2/R4: the class-one severity ceiling and the
// F-9 carve-out must stay aligned across every carrier a reviewer or TL reads, so a one-sided
// edit (packet updated while the rule leaf goes stale, or vice versa) fails closed.
test("class-one severity ceiling and F-9 carve-out stay aligned across reviewer carriers", () => {
  const carriers = new Map([
    ["code-review-cross-model.md", read(".devpro/agent-rules/code-review-cross-model.md")],
    ["second-review/SKILL.md", read(".devpro/agent-skills/devpro-reviews/second-review/SKILL.md")],
    [
      "subagent-dispatch-blocks.md",
      read(".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md"),
    ],
    ["cursor.md", read(".devpro/agent-rules/platform-adapters/cursor.md")],
  ]);
  for (const [name, content] of carriers) {
    assert.match(content, /adversarial bypass narrative/, `${name}: 缺共用核心片語 adversarial bypass narrative`);
    assert.match(content, /at most a Suggestion/, `${name}: 缺 severity ceiling 片語 at most a Suggestion`);
    assert.match(content, /F-9/, `${name}: 缺 F-9 carve-out`);
    assert.ok(
      content.includes(
        "A governance object listed in neither §11 table is classified by its nature: one that protects product security or compliance output is class two and MUST NOT receive this ceiling"
      ),
      `${name}: 未明定 §11 兩表皆未列的對象依性質判定、保護產品安全或合規產出者不套用 ceiling`
    );
  }
  for (const [name, content] of [
    ["code-review-cross-model.md", carriers.get("code-review-cross-model.md")],
    ["cursor.md", carriers.get("cursor.md")],
  ]) {
    assert.match(content, /branch-and-worktree-placement/, `${name}: 缺 class-one 具名例`);
  }
  const packet = read(".devpro/scripts/validate-second-review-packet.mjs");
  assert.match(
    packet,
    /class-one gate's adversarial bypass narrative is at most a Suggestion/,
    "packet static duties 須帶連續 class-one ceiling 錨句"
  );
  assert.match(
    packet,
    /gates and reviews guard against the AI's accidental mistakes in normal work/,
    "packet static duties 須帶 accident-only 原則（取代舊 F-9 carve-out 句）"
  );
  assert.ok(
    packet.includes(
      "A governance object listed in neither §11 table is classified by its nature: one that protects product security or compliance output is class two and MUST NOT receive this ceiling"
    ),
    "packet static duties 須明定 §11 兩表皆未列的對象依性質判定、保護產品安全或合規產出者不套用 ceiling"
  );
});

// amend-evidence-forgery-scope T1: the F-9 criterion (ordinary-command forgery stays CRITICAL,
// deliberate obfuscation on a class-one gate is at most a Suggestion, over-blocking an ordinary
// command is a defect) rides on the SAME line as the class-one ceiling in every Markdown carrier,
// so a reader of any one carrier cannot see the ceiling without the boundary. Anchors A1–A9 are
// shared verbatim with the packet static duty (design.md D3).
const FORGERY_BOUNDARY_ANCHORS = {
  A1: "a forgery the AI can produce with an ordinary command remains CRITICAL",
  A2: "a form the AI would naturally produce in normal work",
  // amend-gate-threat-model-to-accident-only: A3/A6/A8 re-targeted to the accident-only wording; A10 carries the
  // class-one limit that A3's old "on a class-one gate" prefix used to carry.
  A3: "a form reachable only through deliberate obfuscation is at most a Suggestion",
  A4: "a class-one gate blocking an ordinary command the current rules already allow is equally a defect",
  A5: "these named forms are examples, not a closed list",
  A6: "a reviewer MUST NOT demand such blocking to close a deliberate-forgery or deliberate-obfuscation gap",
  A7: "decided by that gate's own contract, not by this severity rule",
  A8: "gates and reviews guard against the AI's accidental mistakes in normal work, not deliberate forgery or deliberate bypass (design-core §11 principle), and class-two objects are the only exception and stay adversarial",
  A9: "when the packet does not show that allowance, state the evidence limitation and required follow-up instead of demanding the block",
  A10: "severity follows whether normal work would accidentally produce a wrong record",
};
const UNLISTED_OBJECT_SENTENCE =
  "A governance object listed in neither §11 table is classified by its nature: one that protects product security or compliance output is class two and MUST NOT receive this ceiling";
const ROUTINE_CLIENT_QUALIFIER = "限該情境下並非例行做法者";

function severityLineOf(content) {
  return content.split("\n").filter((line) => line.includes("adversarial bypass narrative"));
}

function severityLine(content, name) {
  const lines = severityLineOf(content);
  assert.equal(
    lines.length,
    1,
    `${name}: 含 adversarial bypass narrative 的行必須恰 1 行（同行＝同 bullet），實際 ${lines.length}`
  );
  return lines[0];
}

// Predicate shared by the carrier guard and its mutant proof: true only when the single severity
// line carries every required fragment.
function severityLineAligned(content, fragments) {
  const lines = severityLineOf(content);
  return lines.length === 1 && fragments.every((fragment) => lines[0].includes(fragment));
}

const SEVERITY_LINE_COMMON_FRAGMENTS = [
  "at most a Suggestion",
  "F-9",
  FORGERY_BOUNDARY_ANCHORS.A8,
  UNLISTED_OBJECT_SENTENCE,
  FORGERY_BOUNDARY_ANCHORS.A1,
  FORGERY_BOUNDARY_ANCHORS.A2,
  FORGERY_BOUNDARY_ANCHORS.A3,
  FORGERY_BOUNDARY_ANCHORS.A4,
];
const SEVERITY_LINE_FULL_FRAGMENTS = [
  ...SEVERITY_LINE_COMMON_FRAGMENTS,
  FORGERY_BOUNDARY_ANCHORS.A5,
  FORGERY_BOUNDARY_ANCHORS.A6,
  FORGERY_BOUNDARY_ANCHORS.A7,
  FORGERY_BOUNDARY_ANCHORS.A9,
  FORGERY_BOUNDARY_ANCHORS.A10,
  "heredoc",
  "--body-file",
  ROUTINE_CLIENT_QUALIFIER,
];

test("F-9 boundary anchors stay on the same severity line in every reviewer carrier", () => {
  const carriers = [
    ["code-review-cross-model.md", ".devpro/agent-rules/code-review-cross-model.md", SEVERITY_LINE_FULL_FRAGMENTS],
    ["second-review/SKILL.md", ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md", SEVERITY_LINE_FULL_FRAGMENTS],
    [
      "subagent-dispatch-blocks.md",
      ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md",
      SEVERITY_LINE_FULL_FRAGMENTS,
    ],
    ["cursor.md", ".devpro/agent-rules/platform-adapters/cursor.md", SEVERITY_LINE_COMMON_FRAGMENTS],
  ];
  for (const [name, relPath, fragments] of carriers) {
    const line = severityLine(read(relPath), name);
    for (const fragment of fragments) {
      assert.ok(line.includes(fragment), `${name}: 同一行缺 ${JSON.stringify(fragment)}`);
    }
  }
  const packet = read(".devpro/scripts/validate-second-review-packet.mjs");
  for (const [id, anchor] of Object.entries(FORGERY_BOUNDARY_ANCHORS)) {
    assert.ok(packet.includes(anchor), `packet static duties 缺 ${id} 錨句 ${JSON.stringify(anchor)}`);
  }
});

test("F-9 boundary severity-line predicate is mutant-proof against split, drop, and downgrade edits", () => {
  const control = read(".devpro/agent-rules/code-review-cross-model.md");
  const line = severityLine(control, "code-review-cross-model.md");
  assert.equal(severityLineAligned(control, SEVERITY_LINE_FULL_FRAGMENTS), true, "control must satisfy the predicate");

  const mutate = (fn) => {
    const mutatedLine = fn(line);
    assert.notEqual(mutatedLine, line, "mutation fixture must change the severity line");
    return control.replace(line, mutatedLine);
  };
  const mutants = [
    ["line split before the symmetric clause", (l) => l.replace("對稱：", "\n對稱：")],
    ["deliberate-obfuscation bound removed", (l) => l.replace(FORGERY_BOUNDARY_ANCHORS.A3, "")],
    ["ordinary-command forgery downgraded", (l) => l.replace(FORGERY_BOUNDARY_ANCHORS.A1, "a forgery the AI can produce with an ordinary command is at most a Suggestion")],
    ["accident-only principle dropped", (l) => l.replace(FORGERY_BOUNDARY_ANCHORS.A8, "")],
    ["class-one accident criterion removed", (l) => l.replace(FORGERY_BOUNDARY_ANCHORS.A10, "")],
    ["over-blocking clause removed", (l) => l.replace(FORGERY_BOUNDARY_ANCHORS.A4, "")],
    ["unshown-allowance clause removed", (l) => l.replace(FORGERY_BOUNDARY_ANCHORS.A9, "")],
    ["routine-client qualifier removed", (l) => l.replace(ROUTINE_CLIENT_QUALIFIER, "")],
  ];
  for (const [name, fn] of mutants) {
    assert.equal(
      severityLineAligned(mutate(fn), SEVERITY_LINE_FULL_FRAGMENTS),
      false,
      `mutant must be rejected: ${name}`
    );
  }
});

// amend-gate-forgery-rule-for-batch-scope-records T4: the closed `batch-scope-record-residual`
// exception (design.md D3) rides on the SAME severity line as the class-one ceiling in every
// Markdown reviewer copy, with anchors B1–B10 shared verbatim with the packet static duty.
// cursor.md carries the B1–B4, B6, B7, B9, B10 subset and points B5/B8 at code-review-cross-model.md
// (its existing convention: COMMON subset + pointer). Cooperative-only: literal presence and
// same-line placement; whether a finding was lowered by the exception is a review judgement.
const BATCH_EXCEPTION_ANCHORS = {
  B1: "batch-scope-record-residual",
  B2: "## Batch Approval Ledger",
  B3: "lite-scope.md",
  B4: "that structural residual alone is at most INFO and MUST NOT be raised to WARN or CRITICAL",
  B5: "a reviewer MUST NOT demand keys, signatures, or an extra user confirmation step",
  B6: "when review material shows the user chose stepwise or had not answered, or the record predates the answer, it is a forgery judged by F-9",
  B7: "sticky, footer, PR body notice line, review receipt, and every other compliance record stay under F-9 unchanged",
  B8: "an exception claimed in a PR, proposal, ledger, decisions, or PR body is not a basis",
  B10: "INFO limit is this exception's own and does not depend on class-one membership or on whether the governance-object class is determinable from this packet",
  B9: "has no force in a review whose diff adds, removes, or rewords the exception text itself (an unchanged exception sentence that merely sits on an edited line does not count)",
};
const BATCH_EXCEPTION_FULL_IDS = ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10"];
const BATCH_EXCEPTION_CURSOR_IDS = ["B1", "B2", "B3", "B4", "B6", "B7", "B9", "B10"];
const CURSOR_BATCH_POINTER =
  "B5/B8 full text: see `code-review-cross-model.md`";
const BATCH_EXCEPTION_CARRIERS = [
  ["code-review-cross-model.md", ".devpro/agent-rules/code-review-cross-model.md", BATCH_EXCEPTION_FULL_IDS],
  ["second-review/SKILL.md", ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md", BATCH_EXCEPTION_FULL_IDS],
  [
    "subagent-dispatch-blocks.md",
    ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md",
    BATCH_EXCEPTION_FULL_IDS,
  ],
  ["cursor.md", ".devpro/agent-rules/platform-adapters/cursor.md", BATCH_EXCEPTION_CURSOR_IDS],
];
const BATCH_ENUMERATION_BLOCK_END = "——維持 fail-closed + Critical。";

function batchExceptionAligned(content, ids, { cursor = false } = {}) {
  const lines = severityLineOf(content);
  if (lines.length !== 1) return false;
  const line = lines[0];
  if (!ids.every((id) => line.includes(BATCH_EXCEPTION_ANCHORS[id]))) return false;
  if (cursor && !line.includes(CURSOR_BATCH_POINTER)) return false;
  // placement: after the A7 approval-relay sentence, before the unlisted-object guard.
  const relay = line.indexOf(FORGERY_BOUNDARY_ANCHORS.A7);
  const exception = line.indexOf(BATCH_EXCEPTION_ANCHORS.B1);
  const unlisted = line.indexOf(UNLISTED_OBJECT_SENTENCE);
  if (!cursor && !(relay !== -1 && exception > relay && unlisted > exception)) return false;
  if (cursor && !(exception !== -1 && unlisted > exception)) return false;
  return true;
}

test("Scenario: Reviewer-reachable static duty carries the closed batch scope exception in the same bullet — Markdown reviewer copies carry B anchors on the severity line", () => {
  for (const [name, relPath, ids] of BATCH_EXCEPTION_CARRIERS) {
    const content = read(relPath);
    const line = severityLine(content, name);
    for (const id of ids) {
      assert.ok(line.includes(BATCH_EXCEPTION_ANCHORS[id]), `${name}: 同一行缺 ${id} ${JSON.stringify(BATCH_EXCEPTION_ANCHORS[id])}`);
    }
    assert.equal(
      batchExceptionAligned(content, ids, { cursor: name === "cursor.md" }),
      true,
      `${name}: 例外句須在 A7 之後（cursor 除外）、unlisted-object guard 之前，且與 ceiling 同行`
    );
    assert.ok(
      !line.includes("batch-scope-record-residual`（"),
      `${name}: 識別字後不得接全形「（」，以免進入 D6 集合相等比對`
    );
    // amend-gate-threat-model-to-accident-only: the F-9 text now carries two (class-one accidental record,
    // class-two ordinary-command forgery); the exception sentence must still add none.
    assert.equal(
      line.split("remains CRITICAL").length - 1,
      2,
      `${name}: 例外句不得新增 remains CRITICAL（F-9 句已有兩個：class-one 不小心紀錄、class-two 普通指令偽造）`
    );
  }
  assert.ok(
    read(".devpro/agent-rules/platform-adapters/cursor.md").includes(CURSOR_BATCH_POINTER),
    "cursor.md: B5/B8 須指向 code-review-cross-model.md"
  );
});

test("Scenario: Reviewer-reachable static duty carries the closed batch scope exception in the same bullet — full copies say the record is judged by F-9 as if the exception did not exist", () => {
  for (const [name, relPath, ids] of BATCH_EXCEPTION_CARRIERS) {
    if (!ids.includes("B9")) continue;
    assert.ok(
      severityLine(read(relPath), name).includes("judged by F-9 as if the exception did not exist"),
      `${name}: 同行須說明 B9 觸發後批次範圍紀錄依 F-9 判定`
    );
  }
});

test("Scenario: Reviewer-reachable static duty carries the closed batch scope exception in the same bullet — packet source carries B1–B10 and the exception stays off the enumeration block", () => {
  const packet = read(".devpro/scripts/validate-second-review-packet.mjs");
  for (const id of BATCH_EXCEPTION_FULL_IDS) {
    assert.ok(packet.includes(BATCH_EXCEPTION_ANCHORS[id]), `packet static duties 缺 ${id} 錨句 ${JSON.stringify(BATCH_EXCEPTION_ANCHORS[id])}`);
  }
  const dispatch = read(".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md");
  const blockEnd = dispatch.indexOf(BATCH_ENUMERATION_BLOCK_END);
  assert.notEqual(blockEnd, -1, "subagent-dispatch-blocks.md: 缺 ENUMERATION_BLOCK_END 界標");
  const exceptionAt = dispatch.indexOf(BATCH_EXCEPTION_ANCHORS.B1);
  assert.ok(
    exceptionAt > blockEnd + BATCH_ENUMERATION_BLOCK_END.length,
    "subagent-dispatch-blocks.md: 例外句須放在 ENUMERATION_BLOCK_END 之後的 Severity 對齊行內"
  );
  assert.equal(
    severityLine(dispatch, "subagent-dispatch-blocks.md").includes(BATCH_EXCEPTION_ANCHORS.B1),
    true
  );
});

test("Scenario: The batch scope exception does not lower other forged compliance records — Markdown copies keep other records, contradicting evidence, and self-claims under F-9", () => {
  for (const [name, relPath, ids] of BATCH_EXCEPTION_CARRIERS) {
    const line = severityLine(read(relPath), name);
    for (const id of ["B6", "B7"]) {
      assert.ok(line.includes(BATCH_EXCEPTION_ANCHORS[id]), `${name}: 同一行缺 ${id}`);
    }
    // the ordinary-command forgery stays CRITICAL on the same line (A1), so the exception cannot be read without it.
    assert.ok(line.includes(FORGERY_BOUNDARY_ANCHORS.A1), `${name}: 同一行缺 A1，例外不得脫離普通指令偽造仍 CRITICAL`);
    if (ids.includes("B8")) {
      assert.ok(line.includes(BATCH_EXCEPTION_ANCHORS.B8), `${name}: 同一行缺 B8（PR 內自稱例外不構成依據）`);
    }
  }
});

test("batch scope exception Markdown predicate is mutant-proof against split, drop, extension, and relocation edits", () => {
  const control = read(".devpro/agent-rules/code-review-cross-model.md");
  const line = severityLine(control, "code-review-cross-model.md");
  assert.equal(batchExceptionAligned(control, BATCH_EXCEPTION_FULL_IDS), true, "control must satisfy the predicate");
  const mutate = (fn) => {
    const mutatedLine = fn(line);
    assert.notEqual(mutatedLine, line, "mutation fixture must change the severity line");
    return control.replace(line, mutatedLine);
  };
  const mutants = [
    ["exception split onto its own line", (l) => l.replace(BATCH_EXCEPTION_ANCHORS.B1, `\n${BATCH_EXCEPTION_ANCHORS.B1}`)],
    ["B4 rewritten to allow CRITICAL", (l) => l.replace(BATCH_EXCEPTION_ANCHORS.B4, "that structural residual may be raised to CRITICAL")],
    ["B5 deleted", (l) => l.replace(BATCH_EXCEPTION_ANCHORS.B5, "a reviewer may ask for more")],
    ["B6 deleted", (l) => l.replace(BATCH_EXCEPTION_ANCHORS.B6, "the record is always accepted")],
    ["B7 deleted", (l) => l.replace(BATCH_EXCEPTION_ANCHORS.B7, "other records are handled elsewhere")],
    ["B8 deleted", (l) => l.replace(BATCH_EXCEPTION_ANCHORS.B8, "a claimed exception is welcome")],
    ["B9 deleted", (l) => l.replace(BATCH_EXCEPTION_ANCHORS.B9, "applies in every review")],
    ["B10 deleted", (l) => l.replace(BATCH_EXCEPTION_ANCHORS.B10, "limit follows the class-one ceiling")],
    [
      "exception relocated after the unlisted-object guard",
      (l) => {
        const start = l.indexOf(BATCH_EXCEPTION_ANCHORS.B1);
        const unlisted = l.indexOf(UNLISTED_OBJECT_SENTENCE);
        return l.slice(0, start) + l.slice(unlisted) + " " + l.slice(start, unlisted);
      },
    ],
  ];
  for (const [name, fn] of mutants) {
    assert.equal(
      batchExceptionAligned(mutate(fn), BATCH_EXCEPTION_FULL_IDS),
      false,
      `mutant must be rejected: ${name}`
    );
  }
});

// Exact-count predicate shared by the carrier guard and its mutant proof
// (test-governance ADDED requirement: per-line guards must not vacuously pass).
function countCarrierLines(text, pattern) {
  return (text.match(pattern) ?? []).length;
}

// fix-second-review-override-visibility R3/R4, superseded by
// fix-second-review-loop-friction R1/R4 (issue coverage: Scenario "Handoff
// contract carriers name the enforced fields"): the four handoff contract
// carriers must document the enforced fields the renderer/validator require —
// change_name (cost-advisory change binding; also the round-override
// disclosure binding derived from the live PR head branch when absent),
// page_window_max_pages, the primary_verdict five-value enum, and pr_number as
// a string — and the devpro:second-review contract must state the single unlock
// (`DEVPRO_REVIEW_ROUND_OVERRIDE`) for extending pr-sticky review rounds, and
// that the cost override does not extend rounds. Before the original fix the
// three copy-execute projections lacked change_name / page_window_max_pages
// and taught `primary_verdict: <summary or none>`; before this change they
// claimed two locks were "independent" (a phrase now retracted — see the
// RETIRED_DOUBLE_UNLOCK_PHRASE regression guard below; this comment
// deliberately does not spell the retired phrase out contiguously, since an
// S7 repo-wide grep for it treats any live carrier hit as a regression).
test("Scenario: Handoff contract carriers name the enforced fields", () => {
  const secondReviewSkill = read(".devpro/agent-skills/devpro-reviews/second-review/SKILL.md");
  const crossReviewSkill = read(".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md");
  const dispatchBlocks = read(".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md");

  assert.match(
    secondReviewSkill,
    /- `change_name` \(string; the cost-advisory change binding; for round-override disclosure it MUST equal the change derived from the live PR head branch, which is used when `change_name` is absent\)/,
    "devpro:second-review Inputs must document change_name with the cross-runtime-parity canonical field description",
  );
  assert.match(secondReviewSkill, /- `page_window_max_pages`: /, "devpro:second-review Inputs must document page_window_max_pages");
  assert.match(
    secondReviewSkill,
    /- `primary_verdict`: enum `none` \| `PASS` \| `WARN` \| `CRITICAL` \| `UNAVAILABLE`/,
    "devpro:second-review Inputs must document the primary_verdict enum",
  );
  assert.match(secondReviewSkill, /`pr_number`: string form/, "devpro:second-review Inputs must document pr_number as a string");
  assert.match(
    secondReviewSkill,
    /`DEVPRO_REVIEW_ROUND_OVERRIDE` is the sole unlock for extending pr-sticky review rounds[^\n]*`<PR#>:<n>` applies across repositories and `OWNER\/REPO#<PR#>:<n>` scopes it to one repository/,
    "devpro:second-review must name the single unlock for extending pr-sticky review rounds",
  );
  assert.match(
    secondReviewSkill,
    /the cost circuit breaker has no blocking round threshold, so `DEVPRO_COST_BUDGET_OVERRIDE` does not extend review rounds/,
    "devpro:second-review must state the cost override does not extend rounds",
  );
  // Built from parts, not a contiguous literal: this file is itself a live
  // carrier under the S7 repo-wide grep for the retired phrase (proposal.md
  // Section 1 item 5), so spelling it out contiguously here would make this
  // regression guard trip that same grep.
  const RETIRED_DOUBLE_UNLOCK_PHRASE = ["Two", "independent", "unlocks"].join(" ");
  assert.doesNotMatch(
    secondReviewSkill,
    new RegExp(RETIRED_DOUBLE_UNLOCK_PHRASE),
    "regression guard: devpro:second-review MUST NOT reintroduce the retracted double-unlock claim",
  );

  // B1 (Claude host) and B2 (Codex host) share the devpro:cross-review carrier.
  // Exact counts (not only per-line checks): a deleted line must fail here
  // instead of vacuously passing the loop below.
  assert.equal(
    countCarrierLines(crossReviewSkill, /^change_name:/gm),
    2,
    "both devpro:cross-review host blocks must carry change_name",
  );
  assert.equal(
    countCarrierLines(crossReviewSkill, /^page_window_max_pages:/gm),
    2,
    "both devpro:cross-review host blocks must carry page_window_max_pages",
  );
  assert.equal(countCarrierLines(crossReviewSkill, /^primary_verdict:/gm), 2, "both devpro:cross-review host blocks must carry primary_verdict");
  assert.equal(countCarrierLines(crossReviewSkill, /^pr_number:/gm), 2, "both devpro:cross-review host blocks must carry pr_number");
  // The change_name field description must match the cross-runtime-parity
  // canonical wording on every carrier (TL requirement, tasks.md T9), and
  // MUST NOT reintroduce the retired "required when DEVPRO_COST_BUDGET_OVERRIDE
  // is used" clause -- the renderer no longer resolves that env at all.
  const CHANGE_NAME_CANONICAL_PHRASE =
    "the cost-advisory change binding; for round-override disclosure it MUST equal the change derived from the live PR head branch, which is used when";
  for (const line of crossReviewSkill.split("\n")) {
    if (/^change_name:/.test(line)) {
      assert.ok(
        line.includes(CHANGE_NAME_CANONICAL_PHRASE),
        `devpro:cross-review change_name must use the canonical cross-runtime-parity field description: ${line}`,
      );
      assert.ok(
        !line.includes("DEVPRO_COST_BUDGET_OVERRIDE"),
        `devpro:cross-review change_name description MUST NOT name the retired cost-override requirement: ${line}`,
      );
    }
    if (/^primary_verdict:/.test(line)) {
      assert.match(line, /none \| PASS \| WARN \| CRITICAL \| UNAVAILABLE/, `devpro:cross-review primary_verdict must be the enum: ${line}`);
    }
    if (/^pr_number:/.test(line)) {
      assert.match(line, /\(string\)/, `devpro:cross-review pr_number must document the string form: ${line}`);
    }
  }

  // B3 (Step 5.5.3 copy-execute block).
  assert.equal(countCarrierLines(dispatchBlocks, /^change_name:/gm), 1, "Step 5.5.3 block must carry change_name");
  assert.equal(countCarrierLines(dispatchBlocks, /^page_window_max_pages:/gm), 1, "Step 5.5.3 block must carry page_window_max_pages");
  for (const line of dispatchBlocks.split("\n")) {
    if (/^change_name:/.test(line)) {
      assert.ok(
        line.includes(CHANGE_NAME_CANONICAL_PHRASE),
        `subagent-dispatch-blocks.md change_name must use the canonical cross-runtime-parity field description: ${line}`,
      );
      assert.ok(
        !line.includes("DEVPRO_COST_BUDGET_OVERRIDE"),
        `subagent-dispatch-blocks.md change_name description MUST NOT name the retired cost-override requirement: ${line}`,
      );
    }
  }
  assert.match(dispatchBlocks, /^primary_verdict: <none \| PASS \| WARN \| CRITICAL \| UNAVAILABLE>/m);
  assert.match(dispatchBlocks, /^pr_number: <# \(string\)>/m);
});

// test-governance ADDED requirement, Scenario "Deleted carrier line fails the
// guard": the exact-count predicate the carrier guard uses must detect a
// deleted guarded line, so the guard cannot vacuously pass.
test("Scenario: Deleted carrier line fails the guard", () => {
  const crossReviewSkill = read(".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md");
  assert.equal(countCarrierLines(crossReviewSkill, /^primary_verdict:/gm), 2);
  const oneLineDeleted = crossReviewSkill.replace(/^primary_verdict:.*\n/m, "");
  assert.equal(
    countCarrierLines(oneLineDeleted, /^primary_verdict:/gm),
    1,
    "deleting one guarded line must change the exact count so the guard fails",
  );
});

// add-second-reviewer-runner-permission D10/D1-D6: the Claude Code host's
// `projection_runner_command` carrier is repo-root-relative (not
// cwd-independent absolute like every other host). Carriers describing the
// Claude Code host MUST name the relative-form anchors; carriers describing
// only the Codex host MUST NOT gain the Claude-only `repo-root-relative`
// anchor (locks Q3: non-Claude host prose stays unconditionally absolute).
test("Claude Code host runner carrier prose names the repo-root-relative anchors; Codex host carriers do not", () => {
  const claudeHostCarriers = new Map([
    [".claude/agents/dp-second-reviewer.md", read(".claude/agents/dp-second-reviewer.md")],
    [
      "claude-code-cross-review.md",
      read(".devpro/agent-rules/platform-adapters/claude-code-cross-review.md"),
    ],
    ["codex-cli-tooling.md", read(".devpro/agent-rules/platform-adapters/codex-cli-tooling.md")],
  ]);
  for (const [name, content] of claudeHostCarriers) {
    assert.match(
      content,
      /repo-root-relative/,
      `${name} must name the Claude Code host's repo-root-relative runner carrier`,
    );
    assert.match(
      content,
      /node \.devpro\/scripts\/run-second-reviewer-projection\.mjs/,
      `${name} must carry the exact relative-form runner command token`,
    );
    assert.match(
      content,
      /projection_runner_cwd_not_repo_root/,
      `${name} must name the runner self-check failure reason for the relative carrier`,
    );
  }

  const codexHostCarriers = new Map([
    [
      "codex-host-cross-review.md",
      read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md"),
    ],
    ["codex.md", read(".devpro/agent-rules/platform-adapters/codex.md")],
    [".codex/agents/dp-second-reviewer.toml", read(".codex/agents/dp-second-reviewer.toml")],
  ]);
  for (const [name, content] of codexHostCarriers) {
    assert.doesNotMatch(
      content,
      /repo-root-relative/,
      `${name} describes only the Codex host, which keeps the unconditional absolute carrier — it must not gain the Claude-only repo-root-relative anchor`,
    );
  }
});

// Step 5.5.2 stays host-agnostic: no hardcoded single-family reviewer CLI.
function extractStep552(content) {
  const startMatch = content.match(/#### Step 5\.5\.2:[^\n]*\n/);
  assert.ok(startMatch, "pre-pr/SKILL.md must contain a '#### Step 5.5.2:' heading");
  const startIdx = startMatch.index + startMatch[0].length;
  const rest = content.slice(startIdx);
  const nextHeadingMatch = rest.match(/\n#### Step /);
  return nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest;
}

describe("Step 5.5.2 host-agnostic reviewer wording", () => {
  const segment = extractStep552(read(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md"));

  describe("Step 5.5.2 template MUST NOT hardcode a single-family reviewer CLI", () => {
    for (const literal of ["codex CLI", "claude CLI"]) {
      it(`does not contain the literal "${literal}"`, () => {
        assert.doesNotMatch(
          segment,
          new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          `違規：Step 5.5.2 段含寫死字面「${literal}」；cross-model reviewer 由 primary_family 反推（host-derived），不是固定 CLI。`,
        );
      });
    }

    it("uses host-agnostic wording and points at the SSOT and the host adapter", () => {
      assert.match(segment, /外部模型服務|different-family/);
      assert.match(segment, /code-review-cross-model\.md/);
      assert.match(segment, /platform-adapters\/<host>\.md/);
    });

    it("mutation fixture: reinjected single-family CLI literal is caught by doesNotMatch (RED proof)", () => {
      assert.match(segment, /外部模型服務/, "mutation fixture anchor 「外部模型服務」 must exist in the segment");
      const mutated = segment.replace(/外部模型服務/, "外部模型服務（如 codex CLI）");
      assert.notEqual(mutated, segment, "mutation fixture must actually change the segment text");
      assert.throws(() => assert.doesNotMatch(mutated, /codex CLI/));
    });
  });

  // Every anchor must match; then deleting what each anchor matches must turn the check red,
  // so a vacuous or drifted anchor cannot pass unnoticed.
  function lockStep552Anchors(label, text, anchors) {
    const check = (body) => {
      for (const { name, re } of anchors) assert.match(body, re, `${label}: missing anchor「${name}」`);
    };
    check(text);
    for (const { name, re } of anchors) {
      const mutated = text.replace(new RegExp(re.source, re.flags.replace("g", "")), "");
      assert.notEqual(mutated, text, `${label}: mutation for「${name}」must change the text`);
      assert.throws(() => check(mutated), `${label}: deleting「${name}」must turn the lock red`);
    }
  }

  it("Step 5.5.2 dispatches same-repo second review without asking, prompting, or running a grant command", () => {
    lockStep552Anchors("Step 5.5.2", segment, [
      { name: "no per-PR ask, host prompt, or grant command", re: /不問使用者、不跳 host 權限窗、不跑授權指令/ },
    ]);

    const retiredTokens = [
      /AskUserQuestion/,
      /grant-lite-disclosure/,
      /resolve-cross-review-approval-context/,
      /--lite-(?:batch|explicit)-approval/,
      /是否核准外部揭露/,
    ];
    const injections = [
      "AskUserQuestion 詢問使用者",
      "grant-lite-disclosure",
      "resolve-cross-review-approval-context",
      "--lite-batch-approval",
      "--lite-explicit-approval",
      "是否核准外部揭露？",
    ];
    for (const retired of retiredTokens) {
      assert.doesNotMatch(segment, retired, `Step 5.5.2 must not revive the retired grant or question token ${retired}`);
    }
    // Mutation: each retired token injected into the segment is caught by the matching doesNotMatch.
    for (const injected of injections) {
      const mutated = `${segment}\n${injected}`;
      assert.notEqual(mutated, segment, "mutation must change the segment text");
      assert.throws(
        () => {
          for (const retired of retiredTokens) assert.doesNotMatch(mutated, retired);
        },
        `injecting「${injected}」must turn the retired-token check red`,
      );
    }
  });

  it("Step 5.5.2 keeps the Ask First stop list for cross-repo PR, merge, release, destructive, secrets and cross-repo write", () => {
    const bullet = segment.split("\n").find((line) => line.startsWith("- **仍停下**"));
    assert.ok(bullet, "Step 5.5.2 must contain the '- **仍停下**' bullet");
    lockStep552Anchors("Step 5.5.2 仍停下 bullet", bullet, [
      { name: "cross-repo PR refused by the builder as pr_repository_mismatch", re: /cross-repo PR（builder `pr_repository_mismatch`）/ },
      { name: "merge stays Ask First", re: /、merge、/ },
      { name: "release stays Ask First", re: /、release、/ },
      { name: "destructive stays Ask First", re: /、destructive、/ },
      { name: "secrets stay Ask First", re: /、secrets、/ },
      { name: "cross-repo write stays Ask First", re: /、cross-repo write 仍 Ask First/ },
    ]);
  });
});

// amend-gate-forgery-rule-for-waiver-records (T3): the closed `per-pr-waiver-record-residual`
// exception (design.md D7, D10) rides on the SAME severity line as the class-one ceiling and the
// batch exception in the three full Markdown reviewer copies, AFTER the class-determinability guard
// and BEFORE the closing "only decides scope and severity" sentence, with anchors W1–W15 shared
// verbatim with the packet static duty. cursor.md carries the W1 subset plus a pointer to
// code-review-cross-model.md (its existing convention: COMMON subset + pointer). Cooperative-only:
// literal presence and same-line placement; whether a finding was lowered is a review judgement.
// The batch anchors above are not touched; this block only ADDS.
const WAIVER_ANCHORS = {
  W1: "per-pr-waiver-record-residual",
  W2: "A second closed, user-ruled residual exception, separate from the batch one and not drawn from it by analogy, applies",
  W3: "reflects a real user waiver",
  W3a: "DEV deploy-verify:",
  W3b: "Consumer pre-PR checks:",
  W3c: "skipped per user decision:",
  W4: "compare that line with the record made when the user answered and block a missing or mismatched record",
  W5: "judge this from the review material or the gate's own contract or code at the reviewed head, and when neither shows such a check, state the evidence limitation and judge the line by F-9 as if this exception did not exist",
  W6: "the residual alone is capped at INFO and MUST NOT be raised to WARN or CRITICAL",
  W7: "a reviewer MUST NOT ask for keys, signatures, or any extra user confirmation step",
  W8: "this INFO cap belongs to the waiver exception itself, whatever the class-one membership and whether or not the governance-object class can be determined",
  W9: "the record predates the answer, the AI inferred the waiver, the record contradicts the answer, the line does not match the record, or the record belongs to another pull request",
  W10: "a waiver holds for that pull request only",
  W11: "It does not cover sticky, footer, the PR body notice line about outside review, review receipt, batch scope record, a Scenario Walkthrough status line, a stop-point confirmation such as",
  W12: "a claim of it inside a PR, proposal, decisions file, waiver record, or PR body is not a basis",
  W13: "the batch exception's closing words limit only the batch exception",
  W14: "It has no force in a review whose diff adds, removes, or rewords this waiver exception's own text (an unchanged sentence of it that only sits on an edited line is not such an edit)",
  W15: "a repository that receives it through a rules sync gets its force from the first review after that sync merges",
};
const WAIVER_FULL_IDS = Object.keys(WAIVER_ANCHORS);
// Per carrier: the class-determinability guard that ends the base text, and the first word of the
// closing sentence that must still follow the waiver sentence.
const WAIVER_CARRIERS = [
  [
    "code-review-cross-model.md",
    ".devpro/agent-rules/code-review-cross-model.md",
    "class 無法由當前 packet 判定時 MUST NOT 套用此 ceiling。",
    "本條只決定",
  ],
  [
    "second-review/SKILL.md",
    ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
    "class 無法由當前 packet 判定時 MUST NOT 套用此 ceiling。",
    "本條只決定",
  ],
  [
    "subagent-dispatch-blocks.md",
    ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md",
    "class 不可由本 packet 判定時不得套用此 ceiling。",
    "本條只決定",
  ],
];
const CURSOR_WAIVER_START = " Per-PR waiver records:";
const CURSOR_WAIVER_POINTER = "(full text: see `code-review-cross-model.md`)";

function waiverAligned(content, guard, closing) {
  const lines = severityLineOf(content);
  if (lines.length !== 1) return false;
  const line = lines[0];
  if (!WAIVER_FULL_IDS.every((id) => line.includes(WAIVER_ANCHORS[id]))) return false;
  const guardAt = line.indexOf(guard);
  const unlisted = line.indexOf(UNLISTED_OBJECT_SENTENCE);
  const waiver = line.indexOf(WAIVER_ANCHORS.W2);
  const closingAt = line.indexOf(closing, waiver);
  // placement: after the unlisted-object sentence and the class-determinability guard, before the closing sentence.
  if (!(guardAt !== -1 && unlisted !== -1 && waiver >= guardAt + guard.length && waiver > unlisted && closingAt > waiver)) return false;
  // `remains CRITICAL` count stays at the F-9 text's two (amend-gate-threat-model-to-accident-only), so the waiver sentence adds none.
  return line.split("remains CRITICAL").length - 1 === 2;
}

test("Scenario: Reviewer-reachable static duty carries the closed per-PR waiver exception in the same bullet — Markdown reviewer copies carry W anchors on the severity line after the class guards", () => {
  for (const [name, relPath, guard, closing] of WAIVER_CARRIERS) {
    const content = read(relPath);
    const line = severityLine(content, name);
    for (const id of WAIVER_FULL_IDS) {
      assert.ok(line.includes(WAIVER_ANCHORS[id]), `${name}: 同一行缺 ${id} ${JSON.stringify(WAIVER_ANCHORS[id])}`);
    }
    assert.equal(waiverAligned(content, guard, closing), true, `${name}: waiver 例外句須在 class guard 之後、收尾句之前，且與 ceiling 同行`);
    assert.equal(line.split("remains CRITICAL").length - 1, 2, `${name}: waiver 例外句不得新增 remains CRITICAL（F-9 句已有兩個）`);
  }
});

test("Scenario: Reviewer-reachable static duty carries the closed per-PR waiver exception in the same bullet — cursor.md carries the identifier and points at code-review-cross-model.md", () => {
  const line = severityLine(read(".devpro/agent-rules/platform-adapters/cursor.md"), "cursor.md");
  const at = line.indexOf(CURSOR_WAIVER_START);
  assert.notEqual(at, -1, "cursor.md: 缺 Per-PR waiver records 指向子集");
  const subset = line.slice(at);
  assert.ok(subset.includes(WAIVER_ANCHORS.W1), "cursor.md: waiver 指向子集須帶 W1");
  assert.ok(subset.includes(WAIVER_ANCHORS.W3c), "cursor.md: waiver 指向子集須點名 skipped per user decision:");
  assert.ok(subset.includes(CURSOR_WAIVER_POINTER), "cursor.md: waiver 指向子集須指向 code-review-cross-model.md");
  assert.equal(line.split("remains CRITICAL").length - 1, 2, "cursor.md: 指向子集不得新增 remains CRITICAL（F-9 句已有兩個）");
});

test("Scenario: Reviewer-reachable static duty carries the closed per-PR waiver exception in the same bullet — packet source carries W1–W15", () => {
  const packet = read(".devpro/scripts/validate-second-review-packet.mjs");
  for (const id of WAIVER_FULL_IDS) {
    assert.ok(packet.includes(WAIVER_ANCHORS[id]), `packet static duties 缺 ${id} 錨句 ${JSON.stringify(WAIVER_ANCHORS[id])}`);
  }
});

test("Scenario: The per-PR waiver exception does not lower other forged compliance records — Markdown copies keep other records, contradicting evidence and self-claims under F-9", () => {
  for (const [name, relPath] of WAIVER_CARRIERS) {
    const line = severityLine(read(relPath), name);
    for (const id of ["W9", "W11", "W12", "W13"]) {
      assert.ok(line.includes(WAIVER_ANCHORS[id]), `${name}: 同一行缺 ${id}`);
    }
    assert.ok(line.includes(FORGERY_BOUNDARY_ANCHORS.A1), `${name}: 同一行缺 A1，例外不得脫離普通指令偽造仍 CRITICAL`);
  }
});

test("per-PR waiver exception Markdown predicate is mutant-proof against split, drop and relocation edits", () => {
  const [name, relPath, guard, closing] = WAIVER_CARRIERS[0];
  const control = read(relPath);
  const line = severityLine(control, name);
  assert.equal(waiverAligned(control, guard, closing), true, "control must satisfy the predicate");
  const mutate = (fn) => {
    const mutatedLine = fn(line);
    assert.notEqual(mutatedLine, line, "mutation fixture must change the severity line");
    return control.replace(line, mutatedLine);
  };
  const mutants = [
    ["waiver exception split onto its own line", (l) => l.replace(WAIVER_ANCHORS.W2, `\n${WAIVER_ANCHORS.W2}`)],
    ["W4 deleted", (l) => l.replace(WAIVER_ANCHORS.W4, "compare nothing")],
    ["W14 deleted", (l) => l.replace(WAIVER_ANCHORS.W14, "It applies in every review")],
    [
      "waiver exception relocated before the unlisted-object guard",
      (l) => {
        const start = l.indexOf(WAIVER_ANCHORS.W2);
        const closingAt = l.indexOf(closing, start);
        const sentence = l.slice(start, closingAt);
        const without = l.slice(0, start) + l.slice(closingAt);
        return without.replace(UNLISTED_OBJECT_SENTENCE, `${sentence}${UNLISTED_OBJECT_SENTENCE}`);
      },
    ],
  ];
  for (const [mutantName, fn] of mutants) {
    assert.equal(waiverAligned(mutate(fn), guard, closing), false, `mutant must be rejected: ${mutantName}`);
  }
});
