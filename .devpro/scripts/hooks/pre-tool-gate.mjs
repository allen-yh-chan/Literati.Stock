#!/usr/bin/env node
import { isSourceRepoReleaseBranchExempt, isConsumerSubsetReleaseBranchExempt, isRulesLaneReleaseBranchExempt, isChoreAProposalEvidence, isChoreAClassExempt, githubBranchExemptionReason, githubProductionCarrier } from "./lib/github-merge-exemptions.mjs";
/**
 * pre-tool-gate.mjs — PreToolUse hard gates
 *
 * 硬閘 / warn gate groups（per AGENTS.md §0 Never + git-workflow-tracking.md；
 * source naming 使用混合 numeric+letter ID；錯誤訊息引用 source ID）：
 *   1. Protected-branch gate：在 main/master/production/integration/release/* 上
 *      Edit/Write/MultiEdit + Bash(git commit|add|reset|stash|...) 直接 block。
 *   2. Force-push gate：git push --force / -f （無 --force-with-lease）一律 block。
 *   2b. Commit attribution gate：AI-authored git commit message 缺 Rules/Tool/Model footer
 *       emit advisory；forbidden attribution marker / unreadable message source 保持 block。
 *   2c. Merge strategy gate：`gh pr merge` 帶 --squash / --rebase HARD-BLOCK（release-integrity）
 *       （feature → main 規範禁 squash / rebase merge；stacked PR 等需明文核准）。
 *   2d. Upstream pollution gate：`git merge/pull main` 在非 main / master，與
 *       `git merge/pull integration` 在 `release/*`，一律 block（subset 污染）。
 *   2e. Hotfix base gate：`git checkout -b hotfix/<name> [<base>]` 與
 *       `git worktree add ... -b hotfix/<name> [<base>]` base 必須在 production-*
 *       tag；否則 block（避免帶入未上線 main commits 污染 production）。
 *   2f. Production PR-only release merge gate：`git merge release/<X>` 在
 *       `production` 上一律 block；merge mode 不構成 local-merge 例外。
 *   2g. Branch/worktree cleanup：不再由 PreToolUse 解析刪除命令；cleanup
 *       policy 由 `prune-merged-local.mjs`、`prune-rules-lane.mjs` 與
 *       git-branch-hygiene.md 管控。
 *   2h. Release/rules gate：source repo 禁建 `release/rules-*`；consumer repo
 *       `release/rules-*` 必須從 production-* tag 建。
 *   11. Branch verb whitelist gate：branch create / rename / PR head branch
 *       name 必須使用 preflight-checklist.md marker 內的白名單動詞。
 *   3. PR merge review gate：`gh pr merge` 由 cross-model sticky gate 與
 *      local-test merge evidence gate 驗證；legacy transcript evidence debt
 *      不再由 PreToolUse 解析。
 *   3a. Local-Test Gate Merge Evidence：source-repo `gh pr merge` 且 PR diff
 *      命中 code/規則載體時，須三種證據形任一成立：(1) exact-head receipt
 *      （`notes/qa-regression-head-*.json` 的 `head_sha == PR headRefOid`
 *      且 `suite_evidence.status==="pass"` / `fail===0`，change-agnostic）；
 *      (2) 同 change 的 bookkeeping tip-move receipt（ancestor 綁定、delta
 *      限 R6 bookkeeping allowlist，receipt 同樣須帶 pass／fail=0 的
 *      `suite_evidence`；只判 currency 不算 suite 證據）；(3) PR
 *      head 上同 change 的 seal-final FinalEvidenceRecord（由有界 child
 *      process 驗證，hook process 本身不讀紀錄）。change 由 PR headRefName
 *      經 `parseBranchName` 對應；皆不成立 → hard-block。
 *   3b. base=production block path：`gh pr merge` PR base=production 且 head 非合法
 *       release carrier（三 SSOT pattern）→ block；source 與 consumer 同構，
 *       hotfix/*、chore/bump-v* 皆不豁免（正交於 cross-model 審查軸）。
 *       baseRefName 缺失 → fail-open。create 面 `production-base-pr-create`：
 *       `gh pr create --base production` 以同一 predicate best-effort 早擋；
 *       非字面 head／base 無法解析 → fail-open，merge 面為權威 fail-closed 點。
 *   4. Post-merge tracking：偵測 gh pr merge → 寫 marker。
 *      track-postmerge-workflows.mjs 查詢成功後清 marker。
 *      由 post-merge-check.mjs (Stop hook) 讀 marker emit reminder。
 *   4b. Recap body lint gate：`gh api graphql ... createDiscussion(input:` 或
 *       `updateDiscussion(input:` 帶 `-F body=@<file>`（preferred）或
 *       legacy `-F body="$(cat <file>)"` 時，用
 *       recap-body-template-check.mjs 驗 body file 的 canonical H2 結構；
 *       違規 emit advisory（session-recap.md §Template（copy-paste-ready））。
 *   9. Version bump gate：在非 `chore/bump-v*` 分支上修 AGENTS.md `版本：<X.Y.Z>`
 *      line（透過 Edit / Write / MultiEdit）一律 block。版號 bump
 *      必須走獨立 PR。
 *   D. Worktree absolute path gate：`git worktree add <path>` 必須絕對路徑
 *      或 safe shell-expansion 形式（`$(git rev-parse --show-toplevel)/...` /
 *      `$(pwd)/...` / `$REPO_ROOT/...` with assignment）。SSOT:
 *      git-branch-naming-and-anchor.md §Worktree 規範「路徑慣例」的 `<repo-root-abs>` placeholder。
 *   D'. Worktree post-creation cd gate：`git worktree add` 成功後寫 sentinel；
 *       下個 Bash 必須 `cd` 進入該 worktree，否則 emit warn-only advisory
 *       (D8 first-iteration 不 block)；sentinel 24h TTL。
 *   W1. Mandatory worktree gate：main worktree 內禁止建立或 checkout/switch
 *       `feature/`、`bugfix/`、`chore/`、`hotfix/` 分支。
 *   W2. Three-way name alignment gate：worktree dir basename、branch segment、
 *       OpenSpec change folder 必須一致。
 *   W3. File tool body carrier target gate：Edit/Write/MultiEdit 寫入
 *       repo-root reviewer-sticky carrier `.cross-model-sticky-*` 時一律 block；
 *       reviewer sticky body file 必須走 reviewer 自己的 current neutral cwd
 *       （非 main-checkout `notes/tmp/`）；TL-authored body 仍走 main-checkout
 *       `notes/tmp/` body file（不綁 worktree 生命週期）。
 *   R. Repo Scope Evidence Gate：workspace-aware。跨 repo 讀取允許；在 active
 *      repo 內對不同 git common-dir 執行 write-class git / file write 時 block。
 *      `git clone` / `gh repo clone` 需 scoped approval marker。
 *   N. Notes Disposition Advisory gate：Edit/Write/MultiEdit 寫入
 *      notes/session-pending.md 時掃描 top-level list-item 區塊（`- ` 行 +
 *      縮排續行）是否含三欄 `缺輸入:`／`trigger:`／`carrier:`；缺欄 emit
 *      non-blocking additionalContext advisory。Edit/MultiEdit 有 old_string
 *      baseline 時掃描模擬後完整內容；無 baseline 時退回掃 new_string。
 *      fail-open：payload 解析失敗 / 刪除型 Edit / 他檔 → 靜默。
 *      per rule-design-principles.md §Workflow Persistence Layers disposition 條款。
 *
 * 軟提醒（非 block）：--no-verify、gh pr create 缺 --base/--draft、rm -rf。
 *
 * Help/introspection：`git` / `gh` help-only command segments (e.g. `gh pr merge --help`)
 * are stripped before gate matching; a later real command segment in the same Bash payload
 * is still evaluated.
 *
 * Bypass：inline Bash env-prefix DEVPRO_HOOK_BYPASS=1（使用者明示授權 / hook 誤判例外用）。
 *
 * Wired in host hooks.json：matcher 至少涵蓋 Bash|Shell（shell command tools）+ Edit + Write + MultiEdit。
 *
 * Output 規約：
 *   - block：JSON {decision:"block", reason}
 *   - 軟提醒（additionalContext host）：JSON {hookSpecificOutput:{hookEventName:"PreToolUse", additionalContext}}
 *   - 軟提醒（systemMessage host）：JSON {systemMessage}
 *   - 無事：empty stdout, exit 0
 *
 * 簡化策略（rule-design-principles.md §Token-First / usefulness first）：silent default —
 * 只在硬閘命中或軟提醒命中時 surface，其他狀況不噪音。
 */

import { readStdin } from "./lib/stdin.mjs";
import { controlEvidenceRoot, assertDispatchReviewAuthority } from "./lib/second-review-control-evidence.mjs";
import { execSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { escapeRegExp } from "../lib/primitives.mjs";
import { forEachMarkdownLine } from "../lib/markdown-fence-aware.mjs";
import {
  findSessionPendingShapeViolations,
  isPendingSectionHeading,
  parseListItemBlocks,
} from "../lib/session-pending-blocks.mjs";
import {
  evaluateBatchApprovalLedgerForSessionPendingPrewrite,
  evaluateBatchApprovalLedgerForGeneralModePrewrite,
  LEGACY_DISCLOSURE_ISSUE_PREFIX,
  readLiteScopeRecord,
} from "../lib/batch-approval-ledger.mjs";
import {
  UNRESOLVABLE_CWD,
  commandCwd,
  commandCwdAt,
  commandCwdForGitMatch,
  gitCommonDir,
  hasLegacyPayloadCwd,
  isFallbackCwdSource,
  resolveSafe,
  resolveToolInputCwd,
  shellTokenValue,
  toolInputBindingCwd,
  toolInputCwd,
} from "./lib/hook-command-context.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  markRecapCreationStartedForChange,
  recapRepositoryFromPrUrl,
  resolveRecapDiscussionIdentity,
} from "./lib/recap-utils.mjs";
import { resolveReminderSession } from "./lib/session-reminder.mjs";
import {
  getCurrentBranch,
  getRepoRoot,
  normalizeGitBashDrivePath,
  readAgentsMdVersion,
  resolveGithubOwnerRepo as _resolveGithubOwnerRepo,
  resolveGithubRepoIdentity,
  resolveMainWorktreeRoot,
  storedOriginIdentity,
  splitRepoArg,
  inheritedGitLocation,
} from "./lib/git-utils.mjs";
import {
  extractBranchNameFromCommand,
  extractAllBranchNamesFromCommand,
  readRulesSourceWhitelist,
  loadVerbWhitelist,
  parseBranchName,
  validateBranchName,
  isProtectedBaseBranch,
  LOCAL_REVIEW_BRANCH_PREFIX,
} from "./lib/branch-naming.mjs";
import { segmentCommand, commandSegmentText, isMatchInCommandSegment, GIT_GLOBAL_OPT, CMD_POSITION_ANCHOR, anchoredVerbIndex, maskDataRegions, GIT_GLOBAL_VALUE_OPTIONS, findTopLevelSeparator,
  ghPrVerbSource, ghPrPreVerbFlags, GH_PR_REPO_FLAGS_SOURCE, ENV_ASSIGNMENT_SOURCE, prefixAssignments,
} from "./lib/shell-context.mjs";
import {
  PR_URL_SELECTOR_RE,
  GH_ARGUMENT_TOKEN_RE,
  SHELL_HEREDOC_TOKEN_RE,
  REDIRECT_TOKEN_RE,
  REDIRECT_OPERATOR_ONLY_RE,
  GH_PR_EDIT_VALUE_TAKING_FLAGS,
  unquoteOnce,
  isShellExpandedToken,
  declaredPrCheckout,
  prCreateCwd,
  parseGhRepoValue,
  isLocalOriginTarget,
  crossRepoPrAuthorization,
  joinCommandLineContinuations,
} from "./lib/cross-repo-pr-scope.mjs";
import { UNREAD_CHECKOUT_PREFIX, unreadPrCheckoutPrefix } from "./lib/pr-checkout-declaration.mjs";
import { destinationIdentity, isSourceDestination, resetDestinationIdentityCache } from "./lib/operation-target.mjs";
import { hasForbiddenAttribution } from "./lib/attribution-patterns.mjs";
import { HOOK_BYPASS_HINT, hasInlineHookBypass } from "./lib/hook-bypass.mjs";
import { defaultMainCheckoutRoot } from "./lib/repo-state-identity.mjs";
import { isRepoKey, repoKey, repoKeyToken } from "./lib/repo-key.mjs";
import { postmergeMarkerName, postmergeStateDir, writePostmergeMarkerFile } from "./lib/postmerge-marker.mjs";
import { LINEAGE_APPROVAL_MARKER as POST_PR_LINEAGE_APPROVAL_MARKER } from "./lib/second-review-lineage-approval.mjs";
import {
  currentPostPrCompletionSessionId,
  postPrMergeObligation,
} from "./lib/post-pr-completion-state.mjs";
import { listReviewRoundSidecars } from "./lib/review-round-budget.mjs";
import { SEMVER_CORE, extractVersionFromLine, extractVersionFromBranch, extractVersionFromFooter, compareVersions, extractVersionFromTag } from "./lib/version-helpers.mjs";
import { isValidProductionTag, RULES_TAG_RE, PRODUCTION_DATE_RE } from "./lib/tag-shapes.mjs";
import { BASELINE_GATE_IDS } from "./lib/rigor-level.mjs";
import { consumerPrePrChecksState, consumerPrePrEvidenceError, consumerDevVerifyEvidenceError, perPrWaiverRecordError, DEV_GATE, checkoutRepoIdentity, hasPerPrWaiverPart, perPrWaiverMergeReason, perPrWaiverEditReason, isRulesLaneSyncPrHead } from "../lib/consumer-pre-pr-gate.mjs";
import { classifyHighOutput, highOutputBlockReason } from "./lib/high-output-command.mjs";
import { appendFrictionLog } from "./lib/friction-log.mjs";
import { checkRangeWhitespace } from "./lib/whitespace-gate.mjs";
import {
  CHORE_CODE_SIZE_LIMIT,
  CHORE_CODE_SIZE_NOT_CHECKED,
  CHORE_CODE_SIZE_NOT_CHECKED_REMEDY,
  classifyChain,
  classifyPushTarget,
  countCommitted,
  describeCountingBase,
  estimateChained,
  findUntouchedPaths,
  hasBranchSwitchVerb,
  readCommittedStatuses,
  readGitConfigList,
  remoteTrackingRefExists,
  resolveEffectiveRemote,
  resolveHeadSha,
  resolveMergeBase,
  topFiles,
} from "./lib/chore-code-size-gate.mjs";
import { deriveChangeNameFromBranch } from "../lib/derive-change-name-from-branch.mjs";
import { changeNameFromProposalPath, isProposalPath } from "../lib/proposal-change-path.mjs";
import { CHANGE_STATUS, normalizeChangeStatus, toExemptionInput } from "../lib/changed-file-status.mjs";
import { appendRuleLoadHostDiagnostic } from "./lib/rule-load-host-diagnostics.mjs";
import {
  REGISTERED_AGENT_TOOLS,
  SPAWN_CONTEXT_PASS_THROUGH,
  evaluateAgentDispatch,
  spawnContextBlock,
} from "./lib/spawn-context-admission.mjs";
import {
  SECOND_REVIEW_STICKY_MARKER,
  parseSecondReviewStickyAuthorityBody,
  selectExactSecondReviewStickyAuthority,
} from "./lib/second-review-sticky-authority.mjs";
import {
  CROSS_MODEL_WAIVER_MARKER,
  GH_PR_COMMENT_COMMAND_SOURCE,
  GH_PR_ISSUE_COMMENT_COMMAND_SOURCE,
  extractCrossModelWaiverCommentBodyFilePaths,
  evaluateCrossModelWaiverPathW,
  isGhPrIssueCommentCommand,
  stickyAllowsCrossModelWaiverPathW,
} from "./lib/second-review-waiver-authority.mjs";
import {
  DESIGN_COLD_READ_RECORD,
  DESIGN_COLD_READ_UNVERIFIED_LINE,
  designColdReadChangeNames,
  designColdReadStatusOf,
  firstLineOf,
  isDesignColdReadRecordReleased,
  isDesignColdReadReleasingStatus,
} from "./lib/design-cold-read-record.mjs";
import {
  extractSection,
  parseBulletFields,
  seamsExpansionAllowed,
  validateMeetingNotesClarificationContracts,
} from "../lib/clarification-contract.mjs";
import {
  PII_EMAIL_RE,
  PII_EMAIL_ALLOW_RE,
  PII_UNIX_USERS_RE,
  PII_UNIX_HOME_RE,
  PII_WINDOWS_USERS_RE,
  findPIIHits,
  isValidHitResult as isValidPIIHitResult,
} from "../lib/pii-pattern-contract.mjs";
import { isDirtyPerGuard, normalizeEofContent } from "../normalize-eof.mjs";
import {
  extractRuleLeafReadsFromBash,
  extractRuleLeafReadsFromPayload,
  formatDuplicateRuleLoadBlockReason,
  inspectSessionRuleLoadDuplicates,
  isReadToolName,
  isShellCommandToolName,
  readToolFilePath,
  recordSessionRuleLoads,
  sessionRuleLoadIdentity,
} from "./lib/rule-load-session-ledger.mjs";
import { fetchCompareBody } from "./lib/fresh-equivalent-compare.mjs";
import { isGithubWritePayload, githubHookDeny } from "./lib/github-mcp-tools.mjs";
import { evaluateSecondReviewEvidence } from "./lib/github-review-policy.mjs";
import { evaluateContextHeadroomGateFromCtx } from "./lib/context-headroom-gate.mjs";
import { isZeroDiffAncestryRepair, ZERO_DIFF_ANCESTRY_REPAIR_REASON } from "./lib/zero-diff-ancestry-repair.mjs";
import {
  evaluateLocalTestTipMoveReceipt,
  findAcceptableLocalTestReceipt,
  isValidChangeName,
  REGRESSION_HEAD_SHA_RE,
} from "../lib/regression-head-record.mjs";
import { runFinalEvidenceVerifierChild } from "./lib/final-evidence-merge-verifier.mjs";

// ── Worktree CD sentinel dir (Gate D' — T11) ─────────────────────────────
// Sentinel files: .devpro/scripts/hooks/state/pending-cd-<basename>
// Content: "<absPath>\n<epochMs>"  (2 lines)
// TTL: 1 day (86_400_000 ms)
// Gitignored: .devpro/scripts/hooks/state/
// Written by post-tool-gate.mjs (PostToolUse) after successful git worktree add.
// Read and cleared by pre-tool-gate.mjs (PreToolUse) on next Bash invocation.

const SENTINEL_TTL_MS = 86_400_000; // 1 day
const REPO_SCOPE_APPROVAL_TTL_MS = 600_000; // 10 minutes

function defaultSentinelDir() {
  // Co-located with this hook: .devpro/scripts/hooks/state/
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "state");
}

const SENTINEL_DIR =
  process.env.DEVPRO_SENTINEL_STATE_DIR || defaultSentinelDir();

function sentinelFilePath(wtBasename) {
  return path.join(SENTINEL_DIR, `pending-cd-to-worktree-${wtBasename}`);
}

function repoScopeApprovalFilePath(repoBasename, activeCommon) {
  const encoded = Buffer.from(`${activeCommon}\0${repoBasename}`, "utf8").toString("base64url");
  return path.join(SENTINEL_DIR, `repo-scope-approval-${encoded}`);
}

/** Write a pending-cd-to-worktree sentinel for the given absolute worktree path. */
function writePendingCdSentinel(absWtPath) {
  try {
    mkdirSync(SENTINEL_DIR, { recursive: true });
    const basename = path.basename(absWtPath);
    writeFileSync(sentinelFilePath(basename), `${absWtPath}\n${Date.now()}`);
  } catch (e) {
    process.stderr.write(
      `pre-tool-gate sentinel write failed: ${e.message}\n`
    );
  }
}

/** Read a sentinel file. Returns { absPath, epochMs } or null. */
function readPendingCdSentinel(filePath) {
  try {
    const content = readFileSync(filePath, "utf8").trim();
    const [line1, line2] = content.split("\n");
    const absPath = (line1 || "").trim();
    const epochMs = parseInt((line2 || "").trim(), 10);
    if (!absPath || isNaN(epochMs)) return null;
    return { absPath, epochMs };
  } catch {
    return null;
  }
}

/**
 * Scan sentinel dir for pending-cd-to-worktree-* files.
 * Deletes expired sentinels (TTL > 1 day).
 * Returns list of still-valid sentinels: Array<{ file, absPath, epochMs }>
 */
function scanPendingCdSentinels() {
  const valid = [];
  try {
    if (!existsSync(SENTINEL_DIR)) return valid;
    const files = readdirSync(SENTINEL_DIR).filter((f) =>
      f.startsWith("pending-cd-to-worktree-")
    );
    const now = Date.now();
    for (const file of files) {
      const full = path.join(SENTINEL_DIR, file);
      const parsed = readPendingCdSentinel(full);
      if (!parsed) {
        // Corrupt sentinel — remove
        try { unlinkSync(full); } catch { /* ignore */ }
        continue;
      }
      if (now - parsed.epochMs > SENTINEL_TTL_MS) {
        // Expired — remove
        try { unlinkSync(full); } catch { /* ignore */ }
        continue;
      }
      valid.push({ file: full, absPath: parsed.absPath, epochMs: parsed.epochMs });
    }
  } catch {
    /* fail-open: if scan fails, don't block workflow */
  }
  return valid;
}

/** Clear the sentinel for a given abs worktree path (e.g., after cd). */
function clearPendingCdSentinel(absWtPath) {
  try {
    const basename = path.basename(absWtPath);
    const file = sentinelFilePath(basename);
    if (existsSync(file)) unlinkSync(file);
  } catch { /* ignore */ }
}

function existingDirFor(p) {
  let cur = p;
  try {
    if (statSync(cur).isFile()) cur = path.dirname(cur);
  } catch {
    cur = path.dirname(cur);
  }
  while (cur && cur !== path.dirname(cur)) {
    if (existsSync(cur)) return cur;
    cur = path.dirname(cur);
  }
  return cur || process.cwd();
}

// ── Codex CWD diagnostic helpers (T2, issue #649) ─────────────────────────

/**
 * Returns true when NO legacy hook-visible payload field supplied the base cwd —
 * i.e. the gate is running on the hook fallback layer (or on an execution-cwd
 * alias that was never protected-branch evidence). Uses the same alias tables as
 * the shared scan, so there is no second field list to drift, and it keeps the
 * `origin/main` decision semantics byte-for-byte (proposal R3, design D3).
 */
function detectsCodexCwdAbsence(toolInput = {}, payload = {}) {
  try {
    return !hasLegacyPayloadCwd(toolInput, payload);
  } catch {
    return false;
  }
}

/**
 * Returns true when cmd contains an explicit `git -C <something>` token.
 * Per /\bgit\s+-C\s+\S+/ semantics.
 */
function hasExplicitGitCFlag(cmd) {
  try {
    // Quoted content is data, not argv: a `-C` inside a `-c` value
    // (`git -c core.pager="x -C y" add`) must not read as a real `-C`.
    // maskDataRegions masks only the segments it is given: without them the quoted
    // value stays in the text and its `-C` reads as a flag.
    const raw = typeof cmd === "string" ? cmd : String(cmd);
    const text = maskDataRegions(raw, safeSegmentCommand(raw));
    // Shell boundary characters glue onto the token (`true;git`, `a&&git`, `(git`),
    // and the executable may be path-qualified (`/usr/bin/git`). Split those apart
    // before locating the invocation, or a real `-C` would be missed.
    const tokens = text
      .replace(/[;|&()`{}]/gu, " ")
      .split(/\s+/u);
    // Accept a path-qualified executable (`/usr/bin/git`) but never an environment
    // assignment whose VALUE happens to end in `/git` (`X=a/git git ...`).
    const gitIndex = tokens.findIndex(
      (token) => token === "git" || (!token.includes("=") && /^\S*\/git$/u.test(token))
    );
    if (gitIndex === -1) return false;
    // `-C` is a git GLOBAL option: it may be preceded by other globals
    // (`git --no-pager -C <dir> add`). Walk the global-option run and stop at the
    // verb; a `-C` after the verb belongs to the verb, not to the cwd.
    const VALUE_GLOBALS = new Set(GIT_GLOBAL_VALUE_OPTIONS.filter((option) => option !== "-C"));
    for (let i = gitIndex + 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === "-C") return true;
      if (!token.startsWith("-")) return false;
      if (token.startsWith("--") && token.includes("=")) continue;
      if (VALUE_GLOBALS.has(token)) i += 1;
    }
    return false;
  } catch {
    return false;
  }
}

// Length-preserving "argv-level code" view of a command: data regions (quoted /
// heredoc / comment) AND command-substitution / subshell spans (`$( … )`,
// `` ` … ` ``, `( … )`) are blanked to spaces. A flag token (e.g. `--no-ff`) that
// survives this view is a DIRECT argument of the top-level command — one buried
// inside `-m "--no-ff"`, a `# --no-ff` comment, or a `$(true --no-ff)` substitution
// does NOT (issue #851/#848 cross-model rounds 11-12). Used by flag-exemption
// tests that must not be fooled by a flag-looking token in data/substitution.
function argvLevelCodeView(cmdStr, segs) {
  let out = maskDataRegions(cmdStr, segs);
  // Blank `$( … )`, `` ` … ` ``, and `( … )` spans (nesting-aware for parens).
  out = out.replace(/\$\([^)]*\)/g, (m) => " ".repeat(m.length));
  out = out.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
  // Remaining bare `( … )` subshells (depth-1; conservative single pass).
  out = out.replace(/\([^()]*\)/g, (m) => " ".repeat(m.length));
  return out;
}

// A `cd` target the resolver MUST refuse to interpret statically (→ fail closed).
// Extends unsafeLeadingCdTarget with shell-glob metacharacters and any token
// that begins with `-` (a `cd` option like -P/-L/-e/-@/--, not a directory).
// issue #848 cross-model round 4: `cd .work*` (glob → .worktree), `cd -P .`
// (option mis-parsed as path) were resolver fail-opens.
// Sequential shell-cwd simulator (issue #851/#848 cross-model rounds 1-4).
//
// Earlier designs matched literal command text (leading-cd regex, then an
// allowlist) and were bypassed four times because they never modeled how a real
// shell+git actually compute the cwd of a command. This simulator walks the
// payload prefix before the git match left-to-right, maintaining a RUNNING cwd,
// and resolves each `cd` against that running cwd — and FAILS CLOSED (returns
// "" → caller falls back to the protected base → block) the instant it meets
// anything whose runtime cwd effect it cannot statically prove:
//   - any non-unconditional / non-flat structure: `&&` and `||` are
//     exit-status-conditional (a cd guarded by them may not run — round 4 C3),
//     `|` pipe, background `&`, grouping `( ) { }`, cmd-subst `$( )` / backtick,
//     or a shell control keyword (skipped/looped/function bodies don't persist
//     cwd — rounds 2/3). Only `;` and newline (unconditional separators) are
//     accepted between statements.
//   - any `cd` whose target is not a plain literal path: glob, option (`-P`…),
//     `$VAR` / `$(…)` / backtick / `~` expansion (round 4 C6/C7).
//   - a `CDPATH=` assignment anywhere in the prefix (relative cd would resolve
//     against CDPATH, not the running cwd — round 4 C8).
// Data regions (quoted-string / heredoc / comment) are blanked first so their
// literal contents never count as code.
//
// Returns the running cwd (absolute) when the whole prefix is provably a flat,
// unconditional, literal `cd`/no-op sequence; otherwise "". Relative cd targets
// compose correctly because each resolves against the running cwd, not baseCwd
// (round 4 C1: `cd a/b; cd ..` → a, not baseCwd/..).
// Sentinel: the prefix contains a real `cd` whose destination the resolver
// CANNOT statically determine (e.g. `CDPATH=` is set, so a relative `cd` may
// land outside the running cwd — round 4 C8). Callers MUST treat this as "could
// be a protected branch" and block, NOT fall back to baseCwd (baseCwd may be a
// non-protected worktree while the real cd lands on main).
function branchForPath(filePath, baseCwd = process.cwd()) {
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(baseCwd, filePath);
  return getCurrentBranch(existingDirFor(absolute));
}

function gitRootForPath(filePath, baseCwd = process.cwd()) {
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(baseCwd, filePath);
  return getRepoRoot(existingDirFor(absolute));
}

function gitRootForCwd(cwd = process.cwd()) {
  return getRepoRoot(resolveSafe(cwd));
}

function isProtectedBranch(branch) {
  if (!branch) return false;
  if (isProtectedBaseBranch(branch)) return true;
  if (/^release\//.test(branch)) return true;
  return false;
}

function emitBlock(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  appendFrictionLog(reason);
  process.exit(0);
}

function isCodexRuntime() {
  return Boolean(
    process.env.CODEX_THREAD_ID ||
    process.env.CODEX_CI ||
    process.env.DEVPRO_HOOK_HOST === "codex"
  );
}

function emitContext(msg) {
  if (isCodexRuntime()) {
    process.stdout.write(JSON.stringify({ systemMessage: msg }));
    process.exit(0);
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: msg,
      },
    })
  );
  process.exit(0);
}

function asBlock(result) {
  return result?.block ? result : null;
}

function asAdvisory(result) {
  if (!result) return null;
  if (result.advisory) return result;
  if (result.block) return { advisory: result.reason };
  return null;
}

// ── fix-eof-gate-cwd-blind-spot: PreToolUse not-checked reason taxonomy ────
//
// Closed set of reason tokens for the "class B" (unexpected — MUST surface)
// not-checked outcomes across the six mechanical-gate families this change
// touches. "Class A" (expected-silent — applicability guards / deliberately
// unobservable states, e.g. `--no-edit`, a symlink/gitlink mode, a command
// that plainly is not a git commit/push) is NOT part of this set and those
// call sites continue to `return null` without an advisory — see each gate's
// own comments for its class A boundary. SSOT: `openspec/changes/
// fix-eof-gate-cwd-blind-spot/specs/pre-tool-mechanical-gates/spec.md` ADDED
// requirement "PreToolUse Not-Checked Reason Taxonomy And Chained-Payload
// Staleness Detection".
const NOT_CHECKED_REASONS = Object.freeze({
  STALE_INDEX_CHAINED_ADD: "stale-index-chained-add",
  STALE_HEAD_CHAINED_COMMIT: "stale-head-chained-commit",
  STAGED_SET_EMPTY: "staged-set-empty",
  CWD_PARSE_UNRESOLVABLE: "cwd-parse-unresolvable",
  CWD_NOT_A_GIT_WORKTREE: "cwd-not-a-git-worktree",
  BASE_CWD_ABSENT: "base-cwd-absent",
  PROBE_FAILED: "probe-failed",
  GATE_SCRIPT_ABSENT: "gate-script-absent",
  VERSION_LAYER_SKIPPED: "version-layer-skipped",
  REPO_ROOT_UNRESOLVED: "repo-root-unresolved",
  UNEXPECTED_ERROR: "unexpected-error",
});

// FR7: every class-B token maps to a concrete remediation instruction — a
// bare "checked=false" restates the problem without telling the reader what
// to do about it, which is exactly why the pre-existing advisory channel had
// already gone unheeded through 4 recurrences of the same EOF defect
// (brd.md R9).
const NOT_CHECKED_REMEDY = Object.freeze({
  [NOT_CHECKED_REASONS.STALE_INDEX_CHAINED_ADD]:
    "拆成兩個獨立 Bash 呼叫：先 `git add`，再 `git commit`，讓 gate 能讀到 add 之後的 index",
  [NOT_CHECKED_REASONS.STALE_HEAD_CHAINED_COMMIT]:
    "把 push 前的 `git commit` 與 `git push` 拆成兩個獨立 Bash 呼叫，push 時 HEAD 已含該 commit，whitespace 檢查才有完整 range",
  // Deliberately-silent taxonomy entry (see checkCommitEofRestage's
  // textFiles.length===0 branch): a non-chained empty staged set is class A
  // (git commit --amend/--allow-empty/-a/pathspec are all routine), so this
  // remedy string is never surfaced by formatNotCheckedAdvisory today — kept
  // for taxonomy completeness (T5) and to document the reasoning if a future
  // caller ever routes here.
  [NOT_CHECKED_REASONS.STAGED_SET_EMPTY]:
    "確認本次 commit 是否真的有 staged 內容；若透過 `git commit -a`/`--amend`/`--allow-empty` 依賴 deferred staging 或本就無需 staged 內容，這是預期落空，無需處理",
  [NOT_CHECKED_REASONS.CWD_PARSE_UNRESOLVABLE]:
    "gate 無法靜態解析本次 command 的有效 cwd（例如 `--git-dir`/`--work-tree`/`GIT_DIR=`、pipe／控流歧義、或不可靜態展開的 `cd` 目標）；改寫成可靜態追蹤的 `cd <abs>`／`git -C <abs>` 形狀，或拆成獨立 Bash 呼叫",
  [NOT_CHECKED_REASONS.CWD_NOT_A_GIT_WORKTREE]:
    "確認 `-C`/`cd` 目標路徑存在且是 git worktree（已解析到路徑，但該路徑不是 git worktree）",
  // Deliberately-defensive taxonomy entry (see checkCommitEofRestage's
  // `!baseCwd` branch): the only production call chain that reaches this
  // gate is main() → evaluatePreToolUsePayload() → checkBashCommand() →
  // runGateInventory()'s "commit-advisories" runner, and baseCwd there is
  // always exactly `toolInputCwd(toolInput, payload)`'s return value,
  // unmodified — never re-derived or overridden along the way. That
  // function's own fallback chain (`... || environmentPwdCwd() ||
  // process.cwd()`) always ends in a truthy `process.cwd()`, so this branch
  // cannot fire through that chain today (barring an unreproducible
  // mid-flight directory-deletion race). Kept for taxonomy completeness (T5)
  // and as defense-in-depth if a future caller ever invokes this gate with a
  // falsy baseCwd directly.
  [NOT_CHECKED_REASONS.BASE_CWD_ABSENT]:
    "重跑一次 Bash 呼叫，讓 host 帶入正常的 cwd（本次 payload 缺少可用 cwd）",
  [NOT_CHECKED_REASONS.PROBE_FAILED]:
    "手動跑對應的 git 檢查指令確認結果（gate 依賴的 git 子行程本次執行失敗）",
  [NOT_CHECKED_REASONS.GATE_SCRIPT_ABSENT]:
    "確認 `.devpro/scripts/pre-pr-archive-gate.mjs` 存在（consumer repo 尚未 sync 規範時常見）；若已存在請重跑 sync",
  [NOT_CHECKED_REASONS.VERSION_LAYER_SKIPPED]:
    "手動核對 commit footer 宣告的 Rules 版號與目標 repo AGENTS.md 版本是否一致",
  [NOT_CHECKED_REASONS.REPO_ROOT_UNRESOLVED]:
    "確認目前 cwd 位於一個 git repo 內（本次 payload 的 cwd 無法解析出 git repo root）",
  [NOT_CHECKED_REASONS.UNEXPECTED_ERROR]:
    "重跑一次；若持續發生請回報（gate 內部發生非預期例外，已 fail-open 不影響本次指令）",
});

// recordRuleLoadLedgerState / recordRuleLoadLedgerPayload's `skippedReason`
// values (cross-model WARN, PR #2305 finding 4): a DELIBERATELY SEPARATE,
// parallel taxonomy from NOT_CHECKED_REASONS above — not an incomplete
// migration. These two recorder functions are void, side-effect-only
// telemetry (design.md D7 / T12): they never return an advisory to any
// caller, and MUST route every skip through the PRE-EXISTING
// `appendRuleLoadHostDiagnostic` JSONL diagnostic channel's `skippedReason`
// string field, never through `formatNotCheckedAdvisory` or a new
// user-facing advisory channel — telemetry must never affect tool
// execution. Centralized here only so the two sibling functions cannot
// silently drift on the literal string values (was 8 duplicated
// occurrences across both functions before this fix).
const RECORDER_SKIP_REASONS = Object.freeze({
  NO_RULE_REFS: "recorder-no-rule-refs",
  REPO_ROOT_UNRESOLVED: "recorder-repo-root-unresolved",
  MISSING_SESSION_IDENTITY: "recorder-missing-session-identity",
  RECORDED: "recorder-recorded",
  UNEXPECTED_ERROR: "recorder-unexpected-error",
});

// D9 fixed field order: `<gate 名> effective-scope: checked=false cwd=<repo-
// relative 或 basename> reason=<token>. <一句話後果>. <補救指令>`. NFR6: cwd is
// ALWAYS reduced to a basename here — this is the only place the class-B
// advisories introduced by this change render a cwd, so sanitizing here is
// sufficient to keep a real absolute user path out of every advisory string.
function sanitizeAdvisoryCwd(cwd) {
  if (!cwd || typeof cwd !== "string" || cwd === UNRESOLVABLE_CWD) return "(unresolved)";
  return path.basename(cwd) || "(unresolved)";
}

// Single shared formatter — the ONLY place the class-B call sites this change
// touches render a not-checked advisory string (the push gate's pre-existing
// `…ScopeAdvisory` precedent is deliberately grandfathered — see design.md
// D9 — and keeps its own established shape). `grep -c "function
// formatNotCheckedAdvisory"` MUST stay 1 (D1 single-formatter requirement).
function formatNotCheckedAdvisory(gateLabel, cwd, reasonToken) {
  const remedy = NOT_CHECKED_REMEDY[reasonToken] || "請確認本次指令的執行環境後重試";
  return `${gateLabel} effective-scope: checked=false cwd=${sanitizeAdvisoryCwd(cwd)} reason=${reasonToken}. 本次未實際檢查，這道防線這次沒跑。${remedy}。`;
}

function writePostmergeMarker(branch, kind, { cwd = process.cwd(), prNumber = "", headRefName = "", baseRefName = "", repo = "" } = {}) {
  // cwd 不可靜態解析時 branch 帶 UNRESOLVABLE_CWD null-byte sentinel（fail-closed），
  // 身分不可靠，這筆 marker 不該寫。
  // marker 僅為 post-merge 狀態追蹤輔助，key 不可靠時 skip（fail-open，勿白跑注定失敗的寫入）。
  if (branch === UNRESOLVABLE_CWD) return;
  const name = postmergeMarkerName(kind, { branch, repo, prNumber });
  if (!name) return;
  try {
    const dir = postmergeStateDir(cwd);
    mkdirSync(dir, { recursive: true });
    writePostmergeMarkerFile(
      `${dir}/${name}`,
      JSON.stringify(
        {
          branch: branch || "",
          headRefName: headRefName || branch || "",
          // Merge target of the PR ("" when unknown). The Stop hook's Post-merge Local Sync reminder only applies to
          // `main` targets: a production / release merge commit is never on local `main`, so it must stay silent there.
          baseRefName: baseRefName || "",
          kind,
          prNumber: prNumber || "",
          // The lowercase HOST/OWNER/REPO of the PR (a merge) or of the remote the push writes to; when it cannot be
          // proven the marker says so, and is reminded but never cleared until it expires (#3704 r2 F1/F2, user
          // decision Q1-1). Only a marker of an earlier release records neither (PR #3703 r10).
          ...(isRepoKey(repo) ? { repo } : { repo_unknown: true }),
          sessionId: currentPostPrCompletionSessionId(),
          createdAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
  } catch (e) {
    // fail-open，不 block workflow，但 surface 給 ops 可 grep
    process.stderr.write(
      `pre-tool-gate marker write failed (${name}): ${e.message}\n`
    );
  }
}

// Release branch exemption helpers — composed of already-approved subset units.
// isSourceRepoReleaseBranchExempt is shared with the Broker GitHub gate.
// SSOT: shape must match branch-naming.mjs RELEASE_EXEMPTION_RE exactly (date +
// 7-hex shortSHA + optional `-<n>` same-day ordinal). Both regexes must be kept
// in sync — not just SHA length. Canonical length = 7 per `git rev-parse --short=7`
// (release-sit-uat-pat-prod.md). `-<n>` covers same-day re-release (e.g. a
// hotfix carrier landing the same day as an earlier ordinary release; V2
// `checkTagOrdinalReleaseBranchMatch` requires this branch shape for
// `production-<date>-<n>`, n≥2). If either side drifts, update both together.
// isConsumerSubsetReleaseBranchExempt is shared with the Broker GitHub gate.
// isRulesLaneReleaseBranchExempt is shared with the Broker GitHub gate.

const RULES_SYNC_COMMIT_SUBJECT_RE = /^chore: sync devpro-agent-rules \([0-9a-f]{7,40}\)$/;

function gitOutput(cwd, args) {
  try {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    return result.stdout.trim();
  } catch {
    return null;
  }
}

function nearestReachableProductionTag(cwd) {
  const out = gitOutput(cwd, ["tag", "--merged", "HEAD", "--list", "production-*"]);
  if (out === null) return null;
  const candidates = out
    .split("\n")
    .map((line) => line.trim())
    .filter((tag) => isValidProductionTag(tag));
  let best = null;
  for (const tag of candidates) {
    const countOut = gitOutput(cwd, ["rev-list", "--count", `${tag}..HEAD`]);
    const distance = Number.parseInt(countOut || "", 10);
    if (!Number.isFinite(distance)) continue;
    if (
      best === null ||
      distance < best.distance ||
      (distance === best.distance && tag > best.tag)
    ) {
      best = { tag, distance };
    }
  }
  return best?.tag || null;
}

function isCherryPickInProgress(cwd) {
  const gitPath = gitOutput(cwd, ["rev-parse", "--git-path", "CHERRY_PICK_HEAD"]);
  if (!gitPath) return false;
  const fullPath = path.isAbsolute(gitPath) ? gitPath : path.resolve(cwd, gitPath);
  return existsSync(fullPath);
}

function rulesLaneReleaseRangeState(cwd) {
  const tag = nearestReachableProductionTag(cwd);
  if (!tag) {
    return {
      tag: null,
      rangeIsEmpty: false,
      hasRulesSyncCommit: false,
      onlyRulesSyncCommits: false,
      cherryPickInProgress: false,
    };
  }

  const logOut = gitOutput(cwd, ["log", "--format=%s", `${tag}..HEAD`]);
  if (logOut === null) {
    return {
      tag,
      rangeIsEmpty: false,
      hasRulesSyncCommit: false,
      onlyRulesSyncCommits: false,
      cherryPickInProgress: false,
    };
  }
  const subjects = logOut.split("\n").map((line) => line.trim()).filter(Boolean);
  const rangeIsEmpty = subjects.length === 0;
  const hasRulesSyncCommit = subjects.some((subject) =>
    RULES_SYNC_COMMIT_SUBJECT_RE.test(subject)
  );
  const onlyRulesSyncCommits =
    subjects.length > 0 &&
    subjects.every((subject) => RULES_SYNC_COMMIT_SUBJECT_RE.test(subject));

  return {
    tag,
    rangeIsEmpty,
    hasRulesSyncCommit,
    onlyRulesSyncCommits,
    cherryPickInProgress: isCherryPickInProgress(cwd),
  };
}

function isCommitAmendSegment(segment) {
  return /(?:^|\s)--amend(?:\s|$)/.test(segment || "");
}

function unquoteShellToken(token) {
  return (token || "").replace(/^['"]|['"]$/g, "");
}

function isRulesSyncManagedPathspec(pathspec) {
  const value = unquoteShellToken(pathspec).replace(/\/+$/, "");
  if (
    [
      ".gitmodules",
      "AGENTS.md",
      "CLAUDE" + ".md",
      "GEMINI.md",
      ".windsurfrules",
      ".gitignore",
    ].includes(value)
  ) {
    return true;
  }
  return [
    ".devpro-agent-rules",
    ".devpro",
    ".claude",
    ".codex",
    ".cursor",
    ".github",
  ].some((prefix) => value === prefix || value.startsWith(`${prefix}/`));
}

function isScopedRulesLaneReleaseAddSegment(segment) {
  const addMatch = (segment || "").match(/\bgit\b[\s\S]*?\badd\b([\s\S]*)$/);
  if (!addMatch) return false;
  const firstClause = addMatch[1].split(/\s+(?:&&|\|\|)\s+|[;\n]/)[0] || "";
  const tokens = firstClause.trim().split(/\s+/).filter(Boolean);
  const pathspecs = tokens
    .filter((token) => token !== "--" && !token.startsWith("-"))
    .map(unquoteShellToken);
  return pathspecs.length > 0 && pathspecs.every(isRulesSyncManagedPathspec);
}

function isAllowedRulesLaneReleaseProtectedWrite({ branch, verb, matchedSegment, cwd }) {
  if (!isRulesLaneReleaseBranchExempt(branch)) return false;
  // A relaxation: only a positively identified consumer gets it (source, non-devpro and unknown do not).
  if (destinationIdentity(cwd).identity !== "consumer") return false;

  const state = rulesLaneReleaseRangeState(cwd);
  if (!state.tag) return false;

  if (verb === "add") {
    const scopedAdd = isScopedRulesLaneReleaseAddSegment(matchedSegment);
    return (
      scopedAdd &&
      (state.onlyRulesSyncCommits ||
        (state.rangeIsEmpty && state.cherryPickInProgress))
    );
  }
  if (verb === "commit") {
    return (
      isCommitAmendSegment(matchedSegment) &&
      state.hasRulesSyncCommit &&
      state.onlyRulesSyncCommits
    );
  }
  return false;
}

// Does one changed path count as THIS branch's proposal evidence (#3333)?
// A proposal path (active `openspec/changes/<name>/` or archived
// `openspec/changes/archive/<date>-<name>/`, the latter because /devpro:pre-pr
// Step 3.6 archives the proposal before PR creation) is evidence — i.e. it takes the
// PR out of the chore/ prefix lane — unless it belongs to ANOTHER change and was only modified in
// place, which is a documentation fix on a finished design, not new design work.
// Evidence (true) when: the owning change is the branch's own change; the owner cannot
// be told apart (undated archive folder); or the status is anything but in-place
// `modified` — added / removed / renamed / copied / type-changed / unknown, including a
// caller that supplied no status at all (`status` undefined), which keeps the
// pre-#3333 answer. A path that is not a proposal path is never evidence.
// isChoreAProposalEvidence is shared with the Broker GitHub gate.

// Chore prefix-lane exemption (D1 — chore/* + no proposal evidence).
// Mechanism: if PR head is chore/* and no changed path is proposal evidence for this
// change (see `isChoreAProposalEvidence`), use the prefix-lane exemption independently
// of A/B-mini/B shape. feature/* and bugfix/*
// proposal absence is missing OpenSpec evidence, not an exemption.
// `changedFiles` is the array returned by `_getPrChangedFiles`; `statuses` is an optional
// `Map<path, status>` from the same source (`toExemptionInput`). Without a Map every
// proposal path counts as evidence (fail closed).
// The historical isChoreAClassExempt name remains a caller/spec contract; it does
// not classify the change as shape A.
// isChoreAClassExempt is shared with the Broker GitHub gate.

/**
 * isCrossModelExempt(prHeadRefName, changedFiles, cwd, statuses, headSha, baseRefName)
 *
 * Centralized exemption check for cross-model merge gate.
 * Returns true if the PR should be exempt from cross-model review (Path A).
 *
 * Exemption order:
 *  1. chore/bump-v<X.Y.Z> — metadata-only version bump
 *  2. rules/<whitelisted-source>-v<X.Y.Z> — content already reviewed in source repo
 *  3. release/v<X.Y.Z> — source repo release branch (subset/full-main approval handled by release process)
 *  4. release/<YYYYMMDD>-<shortSHA> — consumer release subset (already approved)
 *  5. release/rules-<YYYYMMDD>[-<n>] — rules-lane release subset (already approved)
 *  6. Zero-diff production ancestry repair (bugfix/fix-production-ancestry-* into main or a release/rules-*
 *     carrier + complete, empty changed-file list + local head is a merge of an exact production-* tag; see
 *     lib/zero-diff-ancestry-repair.mjs). Needs `headSha` and `baseRefName`: a caller without the PR head or
 *     base never gets it.
 *  7. Chore/ prefix lane (chore/* + no proposal evidence for this change, per D1 / #3333),
 *     independent of A/B-mini/B shape classification
 *
 * NOTE: hotfix/<name> is intentionally NOT exempted (PROD repair high-risk).
 *
 * @param {string} prHeadRefName — PR head branch name
 * @param {string[]} changedFiles — array of changed file paths in the PR
 * @param {string} cwd — repo root (for isRulesSyncExemptFromCrossModel)
 * @param {Map<string,string>} [statuses] — optional path -> change status (see
 *   `isChoreAClassExempt`); omitted = every proposal path counts as evidence
 * @param {string} [headSha] — PR head commit, for the zero-diff ancestry repair check
 * @param {string} [baseRefName] — PR base branch name (no `origin/`), for the zero-diff ancestry repair check
 * @returns {boolean}
 */
function isCrossModelExempt(prHeadRefName, changedFiles, cwd, statuses, headSha, baseRefName) {
  // Branch-pattern exemptions (mechanical)
  if (branchPatternCrossModelExemptionReason(prHeadRefName, cwd)) return true;
  // Hotfix never exempt — high PROD risk demands cross-model review even when
  // diff shape would otherwise qualify for the chore/ prefix lane.
  if (/^hotfix\//.test(prHeadRefName || "")) return false;
  // A zero-diff ancestry repair has no content to review.
  if (isZeroDiffAncestryRepair({ headRefName: prHeadRefName, baseRefName, changedFiles, headSha, cwd })) return true;
  // Diff-shape exemption (chore/ prefix lane per D1; shape is independent)
  if (isChoreAClassExempt(prHeadRefName, changedFiles, statuses)) return true;
  return false;
}

function branchPatternCrossModelExemptionReason(prHeadRefName, cwd) {
  let rulesSources = [];
  try { rulesSources = [...readRulesSourceWhitelist(cwd)]; } catch {}
  return githubBranchExemptionReason(prHeadRefName, rulesSources);
}

/**
 * crossModelExemptionReason(prHeadRefName, changedFiles, cwd, statuses, headSha, baseRefName)
 *
 * Introspection sibling of isCrossModelExempt: returns a stable, human-readable
 * label for WHICH exemption fired (same precedence order), or null when the PR
 * is not exempt. Drives the non-silent exemption advisory in
 * checkCrossModelMergeGate — a merge that skips cross-model review MUST surface
 * a notice so the user knows the PR was not second-model reviewed, rather than a
 * silent pass (the gap that let an at-cap normative-rule edit merge unreviewed).
 *
 * Mirrors isCrossModelExempt branch order EXACTLY; any change to the exemption
 * precedence there must be reflected here (twin-gate alignment — both are guarded
 * by hook-pre-tool-gate-cross-model-default-on.test.mjs).
 *
 * @param {string} prHeadRefName
 * @param {string[]} changedFiles
 * @param {string} cwd
 * @param {Map<string,string>} [statuses] — same optional argument as `isCrossModelExempt`
 * @param {string} [headSha] — same optional argument as `isCrossModelExempt`
 * @param {string} [baseRefName] — same optional argument as `isCrossModelExempt`
 * @returns {string|null} exemption label, or null if not exempt
 */
function crossModelExemptionReason(prHeadRefName, changedFiles, cwd, statuses, headSha, baseRefName) {
  const branchReason = branchPatternCrossModelExemptionReason(prHeadRefName, cwd);
  if (branchReason) return branchReason;
  // Hotfix is never exempt — mirror isCrossModelExempt's early-false return.
  if (/^hotfix\//.test(prHeadRefName || "")) return null;
  if (isZeroDiffAncestryRepair({ headRefName: prHeadRefName, baseRefName, changedFiles, headSha, cwd })) return ZERO_DIFF_ANCESTRY_REPAIR_REASON;
  if (isChoreAClassExempt(prHeadRefName, changedFiles, statuses))
    return "diff-shape: chore/ 前綴車道（無本 change proposal*.md；他 change 僅 in-place 修改）";
  return null;
}

/**
 * isBaseProductionBlockExempt(headRefName)
 *
 * Exemption check for the base=production block path.
 * Returns true if the head branch is a legitimate route into production.
 *
 * Exempt (the 3 release SSOT helpers — source, consumer date-subset, rules-lane):
 *   - release/v<X.Y.Z>             — source repo release (isSourceRepoReleaseBranchExempt)
 *   - release/<YYYYMMDD>-<sha7>[-<n>] — consumer subset release (isConsumerSubsetReleaseBranchExempt)
 *   - release/rules-<YYYYMMDD>[-n] — rules-lane release (isRulesLaneReleaseBranchExempt)
 *
 * enforce-hotfix-release-carrier D1: hotfix／bump／revert all reach production ONLY
 * through a frozen release carrier — there is no direct route for any of them on
 * this axis, on ANY repo (source or consumer). A predicate that is a pure
 * function of headRefName (no repo-identity branch) keeps source and consumer
 * on the same base-production matrix (NFR-2) and keeps cross-repo `--repo`
 * evaluation consistent (no cwd to resolve against a different repo).
 * `chore/bump-v*` and `hotfix/*` (including `hotfix/revert-rules-*`) fall through
 * to the final `return false` — no branch-pattern is needed for them.
 *
 * IMPORTANT — semantic divergence from isCrossModelExempt (line ~985):
 *   - cross-model axis: hotfix/* is NEVER exempt (high-risk → demands review).
 *   - base-production block axis: hotfix/* is now ALSO never exempt (D1) — both
 *     axes converge to non-exempt for hotfix/*, but for different reasons (one is
 *     an authorization entry point, the other a review obligation). Kept as two
 *     separate functions — DO NOT merge them for DRY (see decisions.md).
 *
 * NOTE: bare /^release\// is intentionally NOT used here (C1). A pseudo-release
 * branch like "release/garbage" does not match any SSOT pattern → not exempt.
 *
 * @param {string} headRefName
 * @returns {boolean}
 */
function isBaseProductionBlockExempt(headRefName) {
  const h = typeof headRefName === "string" ? headRefName.trim() : "";
  return githubProductionCarrier(h);
}

/**
 * buildBaseProductionBlockReason(headRefName, surface, opts)
 *
 * Shared block-message builder for the base=production block path (D2 —
 * enforce-hotfix-release-carrier). Both surfaces (`gh pr create` and
 * `gh pr merge`) call this so the two matrices cannot drift in wording.
 *
 * Post-D1, `hotfix/*`（含 `hotfix/revert-*`）／`chore/bump-v*` have NO direct
 * production route on ANY repo (source or consumer) — the only legitimate
 * heads on this axis are the 3 release SSOT carriers themselves. This message
 * therefore:
 *   - MUST NOT list `hotfix/*` as a legitimate consumer production route (the
 *     stale wording this replaces did, incorrectly, per D1).
 *   - MUST direct the operator to the release-carrier lane (source
 *     `release/v*`; consumer `release/<YYYYMMDD>-<shortSHA>[-<n>]`;
 *     `release/rules-*`) — see `release-step-1-7.md` Step 7 "Hotfix
 *     release-carrier lane" / `release-sit-uat-pat-prod.md`.
 *   - MUST NOT suggest a hook bypass as a legitimate way to land such a
 *     branch directly on production — unlike every other block-gate message,
 *     this one deliberately does NOT append `HOOK_BYPASS_HINT`.
 *
 * @param {string} headRefName
 * @param {"create"|"merge"} surface
 * @param {{ prNumber?: string }} [opts]
 * @returns {string}
 */
function buildBaseProductionBlockReason(headRefName, surface, opts = {}) {
  const { prNumber } = opts;
  const surfaceLabel =
    surface === "create"
      ? `\`gh pr create\`${prNumber ? `（PR #${prNumber}）` : ""}`
      : `\`gh pr merge\`${prNumber ? ` PR #${prNumber}` : ""}`;
  return `Cross-Model Merge Gate (base=production block)：${surfaceLabel} base 為 production 且 head 分支 \`${headRefName}\` 非合法進 production 路徑（合法路徑僅 3 個 release SSOT carrier：source \`release/v*\`、consumer \`release/<date>-<sha>[-<n>]\`、\`release/rules-*\`）。\n\n\`hotfix/*\`／\`chore/bump-v*\`／\`hotfix/revert-*\`（source 與 consumer 一致，無例外）須改走 release-carrier lane 組裝——見 release-step-1-7.md Step 7「Hotfix release-carrier lane」／release-sit-uat-pat-prod.md。MUST NOT 以 hook bypass 合理化直合 production。`;
}

/**
 * 簡易 glob → RegExp 轉換（僅支援 `*` / `**` / `?` / 字面路徑）。
 * 不引入第三方套件（無 package.json）。
 *
 * double-star-slash 替換為 zero-or-more-dir token，使 double-star 也能 match 零層路徑
 * （直接子項），仿 pre-pr-body-template-check.mjs triggerGlobToRegex。
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegex(glob) {
  // Escape regex special chars (except *, ?, /)
  let re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // double-star-slash → token first（保留後面的 * 不被下一步消掉）
  re = re.replace(/\*\*\//g, "{{DS}}");
  // remaining `**` (not followed by /) → .*
  re = re.replace(/\*\*/g, ".*");
  // * → match anything except slash
  re = re.replace(/\*/g, "[^/]*");
  // ? → match single non-slash char
  re = re.replace(/\?/g, "[^/]");
  // Restore `**/` token → zero-or-more-dir pattern（match 零或多層目錄）
  re = re.replace(/\{\{DS\}\}/g, "(.*" + "/)?");
  return new RegExp(`^${re}$`);
}

// ── Cross-Model Merge Gate (T5) ───────────────────────────────────────────
//
// checkCrossModelMergeGate(cmd, cwd)
//
// Intercepts `gh pr merge <PR#>` and enforces the 6-path A-F logic:
//   Path A: branch matches exempt set → pass (chore/bump-v*, rules-sync, release/*, chore/ prefix lane)
//   Path B: branch non-exempt, sticky absent → fail-closed block
//   Path C: sticky present, verdict parse fail / enum invalid / sha missing → block
//   Path D: sticky present, last_reviewed_sha ≠ headRefOid → block
//   Path E: verdict CRITICAL → block (Path W MUST NOT override)
//   Path U: verdict UNAVAILABLE → Path W may clear; else block
//   Path W: exact-one authorized current-head waiver → pass only for missing sticky / UNAVAILABLE
//   Path F: verdict PASS | WARN → pass
//
// Security: PR# is validated as numeric before any subprocess spawn.
//
// Mock-friendly: env vars allow test injection without spawning real gh CLI:
//   CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT          — JSON for gh pr view --json comments,headRefOid,headRefName,baseRefName,state,body,isCrossRepository
//   CROSS_MODEL_MERGE_GATE_MOCK_BRANCH             — current branch name (legacy; kept for other gates)
//   CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES         — newline-separated changed file list (a line is a bare path, or `<status>\t<path>[\t<previous path>]`)
//   CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES_ERROR   — non-empty string → simulate _getPrChangedFiles failure
//   CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER  — PR# to return from _getCurrentBranchPrNumber fallback

const STICKY_MAGIC_MARKER = SECOND_REVIEW_STICKY_MARKER;
const VERDICT_VALID_VALUES = new Set(["PASS", "WARN", "CRITICAL", "UNAVAILABLE"]);

// Widened regex for cross-model gate: match ANY `gh pr merge ...` invocation
// (with optional env-var prefix / path prefix). The old narrow regex only matched
// `gh pr merge <digits>` and missed flag-only, URL, branch-name forms.
// Kept separate from the shell-gate GH_PR_MERGE_RE at line ~1000 (different scope).
// ghPrVerbSource admits a --repo/-R written before `pr` or between `pr` and the verb (fix-pre-verb-repo-flag-gates).
const CROSS_MODEL_GH_PR_MERGE_RE =
  new RegExp(CMD_POSITION_ANCHOR + ghPrVerbSource("merge") + "(?:\\s|$)");
// Keep old narrow regex for backward compat (exported, used by tests + other gates)
const GH_PR_MERGE_WITH_NUMBER_RE =
  new RegExp(CMD_POSITION_ANCHOR + ghPrVerbSource("merge") + "\\s+(\\d+)\\b");

/** Numeric PR# validator — guards against command injection */
function validatePrNumber(prStr) {
  return /^\d{1,8}$/.test(prStr || "") ? prStr : null;
}

/**
 * Extract --repo / -R flag value from a `gh pr merge ...` or `gh pr checks ...`
 * command string.
 * Handles four forms:
 *   --repo <owner/repo>    -R <owner/repo>
 *   --repo=<owner/repo>   -R=<owner/repo>
 *
 * Sanitization: value must match ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$
 * (no whitespace, no control chars, no extra slashes).
 *
 * Returns sanitized "owner/repo" string or null if not found / fails validation.
 */
function _extractRepoFlag(cmd) {
  // OWNER/REPO, or HOST/OWNER/REPO with its host kept, so every gh lookup names the host the command wrote (a host has a
  // dot, so owner/repo/extra is no repository); a caller that needs the slug splits it with splitRepoArg.
  const shape = (value) =>
    /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d+)?\/)?[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value) ? value : null;

  // A --repo/-R written before the verb counts too (fix-pre-verb-repo-flag-gates, fix-pre-verb-repo-flag-checks), in
  // command order. A merge clause wins over a checks clause wherever each sits, so the repo comes from the same clause
  // _extractPrNumber reads the PR number from.
  const remainderMatch = cmd.match(new RegExp(CMD_POSITION_ANCHOR + ghPrVerbSource("merge") + "(.*)"))
    ?? cmd.match(new RegExp(CMD_POSITION_ANCHOR + ghPrVerbSource("checks") + "(.*)"));
  if (!remainderMatch) return null;

  const rest = `${ghPrPreVerbFlags(remainderMatch[0])} ${remainderMatch[1] || ""}`;
  const tokens = rest.trim().split(/\s+/).filter(Boolean);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // Inline form: --repo=value or -R=value
    if ((t.startsWith("--repo=") || t.startsWith("-R="))) {
      const value = t.slice(t.indexOf("=") + 1);
      return shape(value);
    }

    // Space-separated form: --repo value or -R value
    if (t === "--repo" || t === "-R") {
      const next = tokens[i + 1];
      if (next === undefined) return null;
      return shape(next);
    }
  }

  return null;
}

/**
 * Run `gh pr view <prNumber> --json comments,headRefOid,headRefName,baseRefName,state,body,isCrossRepository` and return parsed JSON.
 * Test override: process.env.CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT
 *
 * @param {string} prNumber
 * @param {{ repo?: string, cwd?: string }} [opts={}]
 * Returns parsed object or null on error.
 */
function _runGhPrView(prNumber, opts = {}) {
  const mockOutput = process.env.CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT;
  if (typeof mockOutput === "string") {
    // File-based tracer: when CROSS_MODEL_MERGE_GATE_TRACE_REPO_FILE is set, append a JSONL entry
    // recording what repo value this helper received. Allows tests to verify --repo is forwarded.
    const traceFile = process.env.CROSS_MODEL_MERGE_GATE_TRACE_REPO_FILE;
    if (typeof traceFile === "string" && traceFile.length > 0) {
      try {
        appendFileSync(traceFile, JSON.stringify({ helper: "_runGhPrView", repo: String(opts.repo ?? ""), pr: String(prNumber ?? "") }) + "\n");
      } catch { /* ignore trace write errors */ }
    }
    try {
      return JSON.parse(mockOutput);
    } catch {
      return null;
    }
  }
  try {
    const fields = "comments,headRefOid,headRefName,baseRefName,state,body,isCrossRepository";
    const args = ["pr", "view", prNumber, "--json", opts.includeUrl ? `${fields},url` : fields];
    if (opts.repo && typeof opts.repo === "string" && opts.repo.length > 0) {
      args.push("--repo", opts.repo);
    }
    const spawnOpts = { encoding: "utf8" };
    if (opts.cwd && typeof opts.cwd === "string" && opts.cwd.length > 0) {
      spawnOpts.cwd = opts.cwd;
    }
    const result = spawnSync("gh", args, spawnOpts);
    if (result.status !== 0) return null;
    return JSON.parse(result.stdout || "{}");
  } catch {
    return null;
  }
}

/**
 * One bounded REST re-read of a PR's comments.
 *
 * `gh pr view --json comments` goes through GraphQL and can lag a comment that was
 * just created, so a waiver or sticky posted seconds ago reads as absent and Path B
 * reports "no sticky" (issue #3602). One REST issue-comments read after the write is
 * acknowledged closes that window without touching the happy path. Returns null when
 * the read is unavailable (no gh, non-zero exit, unparseable output, or a mocked pr
 * view without a mocked REST result), so the caller keeps its existing fail-closed
 * behaviour.
 *
 * @param {number|string} prNumber
 * @param {string} repoFlag - resolved owner/repo (empty → resolve from cwd)
 * @param {string} cwd
 * @returns {Array<object>|null}
 */

/**
 * Flatten slurped REST pages and map them to the gh-pr-view camelCase shape the
 * waiver/sticky parsers consume (`authorAssociation`, `author.login`, `url`).
 *
 * @param {Array<unknown>} pages
 * @returns {Array<object>}
 */
function _normaliseRestComments(pages) {
  const flat = pages.flatMap((page) => (Array.isArray(page) ? page : [page]));
  return flat.map((comment) => ({
    id: comment?.id,
    body: comment?.body,
    url: comment?.html_url,
    authorAssociation: comment?.author_association ?? comment?.authorAssociation,
    author: comment?.author ?? (typeof comment?.user?.login === "string" ? { login: comment.user.login } : undefined),
  }));
}

function _refetchPrCommentsViaRest(prNumber, repoFlag, cwd) {
  const mock = process.env.CROSS_MODEL_MERGE_GATE_MOCK_REST_COMMENTS;
  if (typeof mock === "string") {
    if (mock.length === 0) return null;
    try {
      const parsed = JSON.parse(mock);
      return Array.isArray(parsed) ? _normaliseRestComments(parsed) : null;
    } catch {
      return null;
    }
  }
  // A mocked pr view without a mocked REST result must not reach the network.
  if (typeof process.env.CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT === "string") return null;
  // A HOST/OWNER/REPO repoFlag names its host with --hostname, so gh never picks the host itself.
  const named = splitRepoArg(repoFlag);
  const slug = named ? named.slug : _resolveGithubOwnerRepo(cwd);
  if (typeof slug !== "string" || !slug.includes("/")) return null;
  const hostArgs = named?.host ? ["--hostname", named.host] : [];
  try {
    const spawnOpts = { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 10000 };
    if (cwd && typeof cwd === "string") spawnOpts.cwd = cwd;
    const result = spawnSync(
      "gh",
      ["api", ...hostArgs, `repos/${slug}/issues/${prNumber}/comments`, "--paginate", "--slurp"],
      spawnOpts
    );
    if (result.status !== 0) return null;
    const parsed = JSON.parse(result.stdout || "[]");
    // --slurp wraps every page (even a single page) in an outer array.
    return Array.isArray(parsed) ? _normaliseRestComments(parsed) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve current-branch PR number via `gh pr view --json number --jq .number`.
 * Test override: CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER.
 *   - Non-empty numeric string → return that PR# (validated).
 *   - Empty string → force null fallback (simulates "no PR for current branch"
 *     without invoking real gh CLI). This is required for C1-f fail-closed
 *     fallback testing in environments where the worktree IS associated with
 *     a real PR.
 *   - Env var unset → call real gh CLI.
 *
 * @param {{ repo?: string, cwd?: string }} [opts={}]
 * Returns validated PR# string or null on failure.
 */
function _getCurrentBranchPrNumber(opts = {}) {
  if (Object.prototype.hasOwnProperty.call(process.env, "CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER")) {
    const mock = process.env.CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER;
    if (typeof mock !== "string" || mock === "") return null;
    return validatePrNumber(mock) ? mock : null;
  }
  try {
    const args = ["pr", "view", "--json", "number", "--jq", ".number"];
    if (opts.repo && typeof opts.repo === "string" && opts.repo.length > 0) {
      args.push("--repo", opts.repo);
    }
    const spawnOpts = { encoding: "utf8" };
    if (opts.cwd && typeof opts.cwd === "string" && opts.cwd.length > 0) {
      spawnOpts.cwd = opts.cwd;
    }
    const result = spawnSync("gh", args, spawnOpts);
    if (result.status !== 0) return null;
    const num = (result.stdout || "").trim();
    return validatePrNumber(num) ? num : null;
  } catch {
    return null;
  }
}

/**
 * Get current branch — test override via CROSS_MODEL_MERGE_GATE_MOCK_BRANCH.
 */
function _getCrossModelBranch(cwd) {
  const mockBranch = process.env.CROSS_MODEL_MERGE_GATE_MOCK_BRANCH;
  if (typeof mockBranch === "string" && mockBranch) return mockBranch;
  return getCurrentBranch(cwd);
}

// Up to 3 callers per hook run (cross-model merge gate + local-test carrier
// gate + exemption advisory) × 2 gh calls each × 25s stays under run-hook's
// 180s hot-path cap, so a stalled gh call throws instead of run-hook silently
// letting the whole hook time out. A successful lookup is shared by the later
// callers (see _withPrChangedFilesMemo), so only failed lookups can reach that
// worst case.
const PR_CHANGED_FILES_GH_TIMEOUT_MS = 25000;
// GitHub's pull-request files endpoint returns at most this many files; a
// total past it cannot be proven complete, so fail closed before listing.
const PR_CHANGED_FILES_REST_LIST_LIMIT = 3000;

// Run-scoped memo of SUCCESSFUL `_getPrChangedFileEntries` results. The three callers
// above ask the same question inside one hook run, and each ask is a total check
// plus a paginated listing (one request per 100 files). The memo exists only
// while `_withPrChangedFilesMemo` is on the stack (evaluatePreToolUsePayload wraps
// one whole run in it), so nothing outlives the run and a direct caller outside a
// scope always reads gh. Failures are never stored: each caller still decides on
// its own fail-closed / fail-open handling and retries the fetch.
let activePrChangedFilesMemo = null;

/**
 * Share successful PR changed-file lookups between callers for the duration of
 * `fn`. A nested call joins the outer scope; the memo is dropped when the outermost
 * scope exits, including on throw.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function _withPrChangedFilesMemo(fn) {
  if (activePrChangedFilesMemo !== null) return fn();
  activePrChangedFilesMemo = new Map();
  try {
    return fn();
  } finally {
    activePrChangedFilesMemo = null;
  }
}

/**
 * Get the complete changed-file entries for a PR (paginated REST list checked
 * against the PR's changedFiles total). Each entry carries the file's change status
 * so the chore/ prefix-lane exemption can tell an in-place edit of another change's proposal
 * from a proposal that was added / removed / renamed (#3333).
 * Test overrides:
 *   CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES       — newline-separated entries (success path); a line is
 *                                                  `<path>` (status unknown) or `<status>\t<path>[\t<previous path>]`
 *   CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES_ERROR — non-empty string → simulate error (throws)
 *
 * @param {string} prNumber
 * @param {string} cwd
 * @param {string} [repo] — optional owner/repo for cross-repo merges
 * @throws {Error} on gh CLI failure, an incomplete list, an unparseable record, or error mock injection
 * @returns {{path: string, status: string, previousPath: string|null}[]}
 */
function _getPrChangedFileEntries(prNumber, cwd, repo) {
  // Simulate error for tests
  const mockError = process.env.CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES_ERROR;
  if (typeof mockError === "string" && mockError) {
    throw new Error(`mock: ${mockError}`);
  }

  const mockFiles = process.env.CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES;
  if (typeof mockFiles === "string") {
    // File-based tracer: when CROSS_MODEL_MERGE_GATE_TRACE_REPO_FILE is set, append a JSONL entry
    // recording what repo value this helper received. Allows tests to verify --repo is forwarded.
    const traceFile = process.env.CROSS_MODEL_MERGE_GATE_TRACE_REPO_FILE;
    if (typeof traceFile === "string" && traceFile.length > 0) {
      try {
        appendFileSync(traceFile, JSON.stringify({ helper: "_getPrChangedFiles", repo: String(repo ?? "") }) + "\n");
      } catch { /* ignore trace write errors */ }
    }
    return mockFiles
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [first, second, third] = line.split("\t");
        // A bare path has no status to read: unknown, so a proposal path stays evidence (fail closed).
        if (second === undefined) return { path: first, status: CHANGE_STATUS.UNKNOWN, previousPath: null };
        return { path: second, status: normalizeChangeStatus(first), previousPath: third || null };
      });
  }

  const hasRepo = typeof repo === "string" && repo.length > 0;
  // gh resolves `{owner}/{repo}` and the default repo from cwd when no --repo is
  // given, so cwd is part of what the answer depends on.
  const memoKey = JSON.stringify([String(prNumber), String(cwd ?? ""), hasRepo ? repo : ""]);
  const memoized = activePrChangedFilesMemo?.get(memoKey);
  if (memoized) return memoized.map((entry) => ({ ...entry }));

  // Step 1: read the PR's changedFiles total. `gh pr view --json files` alone
  // is capped by GitHub at the first 100 files — without an independent total
  // to check the list length against, a truncated list is silently mistaken
  // for a complete one (the bug this helper exists to close).
  const totalArgs = ["pr", "view", prNumber, "--json", "changedFiles", "--jq", ".changedFiles"];
  if (hasRepo) totalArgs.push("--repo", repo);
  const totalResult = spawnSync("gh", totalArgs, {
    encoding: "utf8",
    cwd,
    timeout: PR_CHANGED_FILES_GH_TIMEOUT_MS,
  });
  if (totalResult.error || totalResult.status !== 0) {
    throw new Error(
      `gh pr view changedFiles failed (exit ${totalResult.status}): ${totalResult.stderr || totalResult.error?.message || "(no stderr)"}`
    );
  }
  // Decimal digits only: Number() would read blank output as 0 (an empty list
  // then "matches" it) and accept hex/exponent forms.
  const totalText = (totalResult.stdout || "").trim();
  const total = /^(0|[1-9][0-9]*)$/.test(totalText) ? Number(totalText) : NaN;
  if (!Number.isSafeInteger(total)) {
    throw new Error(`gh pr view changedFiles returned a non-integer total: ${JSON.stringify(totalResult.stdout)}`);
  }
  if (total > PR_CHANGED_FILES_REST_LIST_LIMIT) {
    throw new Error(
      `PR #${prNumber} has ${total} changed files, above the ${PR_CHANGED_FILES_REST_LIST_LIMIT}-file gh api REST list limit; changed-file classification cannot proceed`
    );
  }

  // Step 2: fetch the complete list via the paginated REST endpoint (--paginate
  // follows every page at per_page=100). `gh api` has no --repo flag: a known repository is written into the path, with
  // --hostname when it writes a host, and is passed through GH_REPO as well (PR #3703 r8 W9-F3).
  const listRepo = hasRepo ? splitRepoArg(repo) : null;
  const listHost = listRepo?.host ?? null;
  const listArgs = [
    "api",
    ...(listHost ? ["--hostname", listHost] : []),
    "--paginate",
    `repos/${listRepo ? listRepo.slug : "{owner}/{repo}"}/pulls/${prNumber}/files?per_page=100`,
    "--jq",
    ".[] | {status, filename, previous_filename} | @json",
  ];
  const listEnv = hasRepo ? { ...process.env, GH_REPO: repo } : process.env;
  const listResult = spawnSync("gh", listArgs, {
    encoding: "utf8",
    cwd,
    env: listEnv,
    timeout: PR_CHANGED_FILES_GH_TIMEOUT_MS,
  });
  if (listResult.error || listResult.status !== 0) {
    throw new Error(
      `gh api pulls files failed (exit ${listResult.status}): ${listResult.stderr || listResult.error?.message || "(no stderr)"}`
    );
  }
  const entries = (listResult.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error(`gh api pulls files returned an unparseable record: ${JSON.stringify(line.slice(0, 120))}`);
      }
      if (!record || typeof record.filename !== "string" || record.filename === "") {
        throw new Error(`gh api pulls files returned a record without a filename: ${JSON.stringify(line.slice(0, 120))}`);
      }
      return {
        path: record.filename,
        status: normalizeChangeStatus(record.status),
        previousPath: typeof record.previous_filename === "string" && record.previous_filename !== "" ? record.previous_filename : null,
      };
    });
  if (entries.length !== total) {
    throw new Error(
      `gh api pulls files returned ${entries.length} files but gh pr view reported ${total} changedFiles — incomplete list`
    );
  }
  activePrChangedFilesMemo?.set(memoKey, entries.map((entry) => ({ ...entry })));
  return entries;
}

/**
 * Path-only view of `_getPrChangedFileEntries` (renamed files appear under their new
 * name only) for callers that classify by path alone, e.g. the local-test gate.
 *
 * @param {string} prNumber
 * @param {string} cwd
 * @param {string} [repo]
 * @throws {Error} as `_getPrChangedFileEntries`
 * @returns {string[]} — list of file paths changed in this PR
 */
function _getPrChangedFiles(prNumber, cwd, repo) {
  return _getPrChangedFileEntries(prNumber, cwd, repo).map((entry) => entry.path);
}

/**
 * Find all PR comment bodies that contain the sticky magic marker.
 *
 * @param {Array<{body: string, url: string, id: string}>} comments
 * @returns {Array<{body: string, url: string, id: string}>}
 */
function _extractStickyCommentBody(comments) {
  if (!Array.isArray(comments)) return [];
  return comments.filter((c) => {
    const body = typeof c.body === "string" ? c.body : "";
    return body.includes(STICKY_MAGIC_MARKER);
  });
}

/**
 * Parse one reserved sticky machine field. A repeated field is ambiguous even
 * when the values are identical, so callers receive no authoritative value.
 * Malformed repeated lines count as duplicates instead of being ignored.
 *
 * @param {string} body
 * @param {{ fieldName: string, pattern: RegExp, valueKey: string }} options
 * @returns {{ found: boolean, duplicate: boolean, [key: string]: unknown }}
 */
function _parseExactStickyMachineField(body, { fieldName, pattern, valueKey }) {
  const prefix = `${fieldName}:`;
  const fieldLines = String(body || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix));
  if (fieldLines.length !== 1) {
    return { found: false, duplicate: fieldLines.length > 1 };
  }

  const match = fieldLines[0].match(pattern);
  return match
    ? { found: true, duplicate: false, [valueKey]: match[1] }
    : { found: false, duplicate: false };
}

/**
 * Parse verdict from sticky comment body.
 * Looks for a line matching exactly: `verdict: PASS|WARN|CRITICAL|UNAVAILABLE`
 *
 * @param {string} body
 * @returns {{ found: boolean, duplicate: boolean, verdict?: string }}
 */
function _parseStickyVerdict(body) {
  return _parseExactStickyMachineField(body, {
    fieldName: "verdict",
    pattern: /^verdict:\s+(PASS|WARN|CRITICAL|UNAVAILABLE)\s*$/,
    valueKey: "verdict",
  });
}

/**
 * Parse last_reviewed_sha from sticky comment body.
 * Looks for a line matching: `last_reviewed_sha: <sha>`
 *
 * @param {string} body
 * @returns {{ found: boolean, duplicate: boolean, sha?: string }}
 */
function _parseStickyLastReviewedSha(body) {
  return _parseExactStickyMachineField(body, {
    fieldName: "last_reviewed_sha",
    pattern: /^last_reviewed_sha:\s+([a-f0-9]{7,40})\s*$/,
    valueKey: "sha",
  });
}

/** Validate sha is exactly 40 hex chars — guards against falsy/truncated headRefOid */
const VALID_SHA_RE = /^[a-f0-9]{40}$/;
function _isValidSha(s) {
  return typeof s === "string" && VALID_SHA_RE.test(s);
}

/**
 * Flags for `gh pr merge` that consume the *next* token as their value.
 * When the parser sees one of these flags (without inline `=`), it skips
 * both the flag token and the immediately-following value token so that a
 * digit value (e.g. `--body 123`) is not misidentified as the PR number.
 *
 * Short aliases come from `gh pr merge --help` output.
 * Maintenance: run `gh pr merge --help` and align this Set with every flag
 * listed as taking a value argument (the short alias column is the source of truth).
 */
const GH_PR_MERGE_VALUE_TAKING_FLAGS = new Set([
  "--body", "-b",
  "--body-file", "-F",
  "--subject", "-t",           // short alias per `gh pr merge --help`
  "--author-email", "-A",      // short alias per `gh pr merge --help`
  "--match-head-commit",
  "--repo", "-R",
]);

/**
 * Flags for `gh pr checks` that consume the *next* token as their value.
 * When the parser sees one of these flags (without inline `=`), it skips
 * both the flag token and the immediately-following value token so that a
 * digit value (e.g. `--interval 10`) is not misidentified as the PR number.
 *
 * Short aliases come from `gh pr checks --help` output.
 * Maintenance: run `gh pr checks --help` and align this Set with every flag
 * listed as taking a value argument (the short alias column is the source of truth).
 */
const GH_PR_CHECKS_VALUE_TAKING_FLAGS = new Set([
  "--interval", "-i",
  "--jq", "-q",
  "--json",
  "--template", "-t",
  "--repo", "-R",
]);

/**
 * Argv-aware scan of a `gh pr merge` / `gh pr checks` remainder for the first
 * pure-digit 1-8 token. Returns that PR# string, `null` if a digit token fails
 * validation, or `undefined` if no candidate was found (caller may fall through).
 */
function _firstArgvAwareDigitPrNumber(rest, valueTakingFlags) {
  const cut = findTopLevelSeparator(rest, 0);
  const bounded = rest.slice(0, cut);
  const tokens = bounded.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.startsWith("-")) {
      // Inline form `--flag=value` → only skip this one token
      if (t.includes("=")) {
        i += 1;
        continue;
      }
      // Value-taking flag → skip flag + following value token (two tokens)
      if (valueTakingFlags.has(t)) {
        i += 2;
        continue;
      }
      // Boolean flag → skip just this token
      i += 1;
      continue;
    }
    // Non-flag token: pure-digit 1-8 chars → this is the PR#
    if (/^\d{1,8}$/.test(t)) {
      return validatePrNumber(t) ? t : null;
    }
    // Non-digit, non-flag token (branch name, body text fragment, etc.) → skip
    i += 1;
  }
  return undefined;
}

/**
 * Extract PR# from a `gh pr merge ...` or `gh pr checks ...` command using ordered strategies:
 *   1. URL form — pull/<digits> (most precise; e.g. https://.../pull/123)
 *   2. Argv-aware positional digit: split cmd into tokens after "merge" or "checks",
 *      skip flag tokens (starting with "-") and their values, find the first
 *      token that is entirely 1-8 digits (regex ^\d{1,8}$).
 *      Value-taking flags (GH_PR_MERGE_VALUE_TAKING_FLAGS /
 *      GH_PR_CHECKS_VALUE_TAKING_FLAGS) consume the next token too so digit
 *      values like `--body 123` or `--interval 10` are not misread.
 *      This avoids mismatching branch names like "issue-42-fix" or body strings.
 *      Strategy 2 does not scan `gh run` argv (run id is not a PR#).
 *   3. Fallback: gh pr view (current branch) — via _getCurrentBranchPrNumber()
 * Returns validated PR# string or null if all strategies fail.
 */
function _extractPrNumber(cmd, opts = {}) {
  // Strategy 1: URL form (e.g. `gh pr merge https://.../pull/123`)
  const urlMatch = cmd.match(/\/pull\/(\d{1,8})\b/);
  if (urlMatch) return validatePrNumber(urlMatch[1]) ? urlMatch[1] : null;

  // Strategy 2: argv-aware positional digit
  // Locate "gh pr merge" or "gh pr checks" in the command, then tokenise the remainder.
  //
  // Concretely:
  //   gh pr merge --body 123 456           → skip "--body"+"123" → take 456 ✓
  //   gh pr merge --body=foo 456           → skip "--body=foo" (inline) → take 456 ✓
  //   gh pr merge --auto --merge 456       → skip "--auto", skip "--merge" (boolean) → take 456 ✓
  //   gh pr merge -R owner/repo 456        → skip "-R"+"owner/repo" → take 456 ✓
  //   gh pr merge --match-head-commit 1234567 456 → skip flag+1234567 → take 456 ✓
  //   gh pr merge --body "see #42" 9999    → tokens ["--body", '"see', '#42"', "9999"]
  //                                        → skip "--body"+(skip '"see' — not pure digit,
  //                                           but value-taking consumes only the FIRST next
  //                                           token, so '"see' is consumed) → '#42"' is
  //                                           not pure digit → 9999 matches ✓
  //   gh pr merge issue-42-fix             → not pure digit → fallback ✓
  //   gh pr merge release-2026-05          → not pure digit → fallback ✓
  //   gh pr checks --interval 10 2024      → skip "--interval"+"10" → take 2024 ✓
  //   gh run view 12345678                 → not scanned here → fallback ✓
  const mergeMatch = cmd.match(new RegExp(CMD_POSITION_ANCHOR + ghPrVerbSource("merge") + "(.*)"));
  if (mergeMatch) {
    const found = _firstArgvAwareDigitPrNumber(mergeMatch[1] || "", GH_PR_MERGE_VALUE_TAKING_FLAGS);
    if (found !== undefined) return found;
  }
  const checksMatch = cmd.match(new RegExp(CMD_POSITION_ANCHOR + ghPrVerbSource("checks") + "(.*)"));
  if (checksMatch) {
    const found = _firstArgvAwareDigitPrNumber(checksMatch[1] || "", GH_PR_CHECKS_VALUE_TAKING_FLAGS);
    if (found !== undefined) return found;
  }

  // Strategy 3: fallback — current branch PR# (no explicit identifier in cmd)
  // NOTE: --repo cross-repo case always provides an explicit PR#, so this fallback
  // is unlikely to be needed when opts.repo is set, but we pass opts through for completeness.
  return _getCurrentBranchPrNumber(opts);
}

/**
 * checkCrossModelMergeGate(cmd, cwd)
 *
 * Main gate function. Default-on: all PRs require cross-model review unless
 * the PR branch matches an explicit exempt set (Path A).
 * Returns null (pass) or { block: true, reason: string }.
 *
 * Path A: branch matches exempt set → pass (chore/bump-v*, rules-sync,
 *         release/v*, release/<date>-<sha>, release/rules-<date>, chore/ prefix lane)
 * Path B–F: branch non-exempt → sticky comment checks (unchanged)
 *
 * NOTE: prData must be fetched before exemption check (headRefName required).
 * Changed files are still fetched for chore/ prefix-lane detection (proposal-absent signal).
 *
 * @param {string} cmd — Bash command string
 * @param {string} cwd — working directory
 */
// The local post-PR obligations of PR `prNumber` of repository `repo` (a --repo value or repository key; default the
// checkout's), as { block, reason } or null (fix-post-pr-state-repo-keys).
function checkLocalMergeObligations(prNumber, cwd, repo = "") {
  const obligation = postPrMergeObligation({ cwd, prNumber, repo: repo || "" });
  return obligation ? { block: true, reason: obligation.reason } : null;
}

// The PR number or --repo/-R value of a real `gh pr merge` invocation written as a shell expansion, or null (#3556).
// Values of other value-taking flags (`--body "costs $5"`) are not PR selectors and are skipped.
function ghPrMergeShellExpandedSelector(cmd) {
  for (const found of _realGhPrClauses(cmd, GH_PR_MERGE_RE)) {
    const { selector, flagRepo } = _ghPrClauseArguments(found, "merge");
    const expanded = [selector, flagRepo].find(isShellExpandedToken);
    if (expanded) return expanded;
  }
  return null;
}

function checkCrossModelMergeGate(cmd, cwd, bound) {
  // Shell-aware: match the verb only inside a real command segment, never inside a
  // quoted string / heredoc body / comment. Without this, a `git commit -m "...gh
  // pr merge ..."` message, an `echo`/`node -e` arg, or any text that merely
  // mentions the verb false-positives this gate (the same shell-aware rule every
  // other gate follows — per `pre-tool-mechanical-gates` spec). `commandSegmentText`
  // collapses non-command spans to `__QUOTED__`, so PR#/repo-flag extraction below
  // (which locates "gh pr merge" then tokenises the remainder) also operates on the
  // command-only view and is unaffected for a genuine `gh pr merge <#>`.
  const cmdText = gateCommandSegmentText(cmd);
  // Only intercept `gh pr merge ...` in any form
  if (!CROSS_MODEL_GH_PR_MERGE_RE.test(cmdText)) return null;

  const expandedSelector = ghPrMergeShellExpandedSelector(cmd);
  if (expandedSelector) {
    return {
      block: true,
      reason: `Cross-Model Merge Gate：\`gh pr merge\` 的 PR 編號或 --repo/-R 寫成 shell 變數或命令替換（${expandedSelector}）。hook 在 shell 展開之前判定，看不到它的值，所以無法查 PR 資料。請改用字面值，例如 \`gh pr merge 123 --repo github.com/OWNER/REPO --merge\`。`,
    };
  }

  // The repository and PR cross-repo-pr-merge bound ({ repo: github.com/OWNER/REPO, pr }), else the --repo / -R flag
  // (issue #762) and the multi-strategy PR# extraction (C1 fix: widened from digits-only).
  const repoFlag = bound?.repo ?? _extractRepoFlag(cmdText);
  const prNumber = bound?.pr ?? _extractPrNumber(cmdText, { repo: repoFlag, cwd });
  if (!prNumber) {
    // Cannot determine PR# — fail-closed
    return {
      block: true,
      reason: `Cross-Model Merge Gate：無法判定 PR#（命令中無明確數字/URL，current-branch PR 解析也失敗）。\n\n請改用 \`gh pr merge <PR#> --repo github.com/OWNER/REPO\` 顯式形式，或確認 gh CLI 已認證且當前分支已關聯 PR。\n\n若確認為誤判，${HOOK_BYPASS_HINT}`,
    };
  }

  const obligation = checkLocalMergeObligations(prNumber, cwd, repoFlag);
  if (obligation) return obligation;

  // Fetch full PR data: comments + headRefOid + headRefName
  // The GitHub-recorded branch and production target precede diff-dependent exemptions.
  const prData = _runGhPrView(prNumber, { repo: repoFlag, cwd });
  if (!prData) {
    // gh CLI unavailable or error — fail-closed per NFR-2
    return {
      block: true,
      reason: `Cross-Model Merge Gate：無法取得 PR #${prNumber} 資料（gh pr view 失敗）。\n\nfail-closed: 請確認 gh CLI 已安裝且有 PR 存取權。若確認為誤判，${HOOK_BYPASS_HINT}`,
    };
  }

  // Derive prHeadRefName early (needed by both base-production block path and Path A below).
  const prHeadRefName = typeof prData.headRefName === "string" ? prData.headRefName.trim() : "";
  if (prHeadRefName.startsWith(LOCAL_REVIEW_BRANCH_PREFIX)) {
    return { block: true, reason: localReviewPrHeadBlockReason(prHeadRefName) };
  }

  // base-production block path (orthogonal to cross-model review axis):
  //   If PR base = "production" and head is not a legitimate production route
  //   (one of the 3 release SSOT patterns — D1: hotfix/*/chore/bump-v* are NEVER
  //   exempt on this axis on ANY repo), block unconditionally — this path must
  //   fire BEFORE Path A so that a chore/ prefix-lane diff shape (no proposal.md) cannot
  //   bypass the production-targeting check. Merge-time (this function) is the
  //   AUTHORITATIVE fail-closed enforcement for D2 — the sibling `gh pr create`
  //   gate (checkProductionBasePrCreate) is a best-effort early fail that can
  //   fail OPEN on a non-literal --head; this path reads the GitHub-recorded
  //   headRefName via `gh pr view` and cannot be fooled by shell variables.
  //
  //   fail-open (C3): if baseRefName is absent / non-string, do NOT block here;
  //   the PR falls through to the existing B–F sticky checks (cross-model axis
  //   is fail-closed and will catch non-exempt, sticky-absent PRs downstream).
  //   Blocking on missing baseRefName would produce false positives for base=main
  //   PRs when gh occasionally omits the field.
  const prBaseRefName = typeof prData.baseRefName === "string" ? prData.baseRefName.trim() : "";
  if (prBaseRefName === "production" && !isBaseProductionBlockExempt(prHeadRefName)) {
    return {
      block: true,
      reason: buildBaseProductionBlockReason(prHeadRefName, "merge", { prNumber }),
    };
  }

  // Branch-pattern exemptions need no files API; local obligations and the
  // production-target restriction above still apply before this return.
  if (branchPatternCrossModelExemptionReason(prHeadRefName, cwd)) return null;

  // Diff-shape exemption requires the complete changed-file list.
  let changedFiles;
  let changedStatuses;
  try {
    ({ files: changedFiles, statuses: changedStatuses } = toExemptionInput(
      _getPrChangedFileEntries(prNumber, cwd, repoFlag)
    ));
  } catch (err) {
    return {
      block: true,
      reason: `Cross-Model Merge Gate：unable to fetch PR changed files for #${prNumber}: ${err.message}\n\nfail-closed: 請確認 gh CLI 已安裝且有 PR 存取權。若確認為誤判，${HOOK_BYPASS_HINT}`,
    };
  }

  // Path A: unified exemption check — branch matches exempt set OR chore/ prefix lane → pass.
  // Uses PR headRefName (not local branch) for correctness (C3 fix preserved).
  // Returns null (silent) HERE so the blocking inventory does not short-circuit
  // the state-update + advisory inventories (marker writes, cross-model exemption
  // notice). Local-test evidence is a separate state-backed BLOCK gate that still
  // runs when sticky Path A passes.
  // The NON-SILENT exemption notice is emitted by a dedicated ADVISORY-bucket gate
  // (checkCrossModelExemptionNotice) that runs after state-updates — see
  // BASH_ADVISORY_GATES merge-advisories composite.
  if (isCrossModelExempt(prHeadRefName, changedFiles, cwd, changedStatuses, prData.headRefOid, prBaseRefName)) return null;

  // Issue #3602: a waiver or sticky posted seconds ago can be missing from the GraphQL
  // `gh pr view --json comments` snapshot. When neither marker is present, re-read the
  // PR comments once through the REST endpoint before Path B declares "no sticky".
  let commentsRefetchedEmpty = false;
  const commentsNow = Array.isArray(prData.comments) ? prData.comments : [];
  const WaiverLineMarker = CROSS_MODEL_WAIVER_MARKER;
  const hasReviewMarker = commentsNow.some(
    (comment) => typeof comment?.body === "string"
      && (comment.body.includes(STICKY_MAGIC_MARKER) || comment.body.trimStart().startsWith(WaiverLineMarker))
  );
  if (!hasReviewMarker) {
    const fresh = _refetchPrCommentsViaRest(prNumber, repoFlag, cwd);
    if (Array.isArray(fresh)) {
      // Union by id: the re-read may only widen the evidence set, never narrow it.
      // GraphQL ids are node ids while REST ids are numeric, so key on the stable
      // comment url (falling back to the body) instead of the id.
      const keyOf = (comment) => (typeof comment?.url === "string" && comment.url.length > 0 ? comment.url : comment?.body);
      const seen = new Set(commentsNow.map(keyOf));
      prData.comments = [...commentsNow, ...fresh.filter((comment) => !seen.has(keyOf(comment)))];
      const authority = prData.comments.some(
        (comment) => typeof comment?.body === "string" && comment.body.includes(WaiverLineMarker)
      ) || prData.comments.some(
        (comment) => typeof comment?.body === "string" && comment.body.includes(STICKY_MAGIC_MARKER)
      );
      commentsRefetchedEmpty = !authority;
    }
  }

  const review = evaluateSecondReviewEvidence({ prNumber, prData, commentsRefetchedEmpty,
    compare: (lastReviewedSha, headRefOid) => fetchCompareBody({ lastReviewedSha, headRefOid, repoSlug: splitRepoArg(repoFlag)?.slug ?? repoFlag, host: splitRepoArg(repoFlag)?.host, cwd }),
  });
  for (const audit of review.audits || []) appendFrictionLog(audit);
  if (review.block) return { block: true, reason: review.reason };
  if (!review.sticky) return null;
  const parsedSticky = review.sticky;
  // Negative fence only: an operator-disposed attempt never supplies admission.
  // Keep duplicate ambiguity and Critical precedence above; normal remote PASS
  // acquires no positive local completion-receipt requirement.
  try {
    assertDispatchReviewAuthority({ rootDir: controlEvidenceRoot(process.env, cwd),
      dispatchId: parsedSticky.dispatch_id, repositorySlug: splitRepoArg(repoFlag)?.slug || _resolveGithubOwnerRepo(cwd),
      prNumber, headRefOid: parsedSticky.last_reviewed_sha });
  } catch (error) {
    return { block: true, reason: `Cross-Model Merge Gate：operator disposition authority blocked: ${error.message}. Fresh full review is required.` };
  }
  // Path F: PASS | WARN → pass
  return null;
}

// ── Bash command checks ────────────────────────────────────────────────────

// Shell-context segment helpers (refactor-pre-tool-gate-shell-aware T4).
// safeSegmentCommand: wraps segmentCommand with fail-safe fallback.
// isMatchInCommandSegment: imported from shell-context.mjs (DRY helper).
function safeSegmentCommand(cmd) {
  try { return segmentCommand(cmd); } catch { return null; }
}

function shellStatementTokens(statement) {
  const tokens = [];
  const tokenRe = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g;
  for (const m of statement.matchAll(tokenRe)) tokens.push(shellTokenValue(m[1]));
  return tokens;
}

function commandBasename(token) {
  const value = shellTokenValue(token || "");
  return value.split(/[\\/]/).pop();
}

function firstExecutableTokenIndex(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (commandBasename(tokens[i]) === "env") {
    i++;
    while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || /^-[A-Za-z-]+/.test(tokens[i]))) i++;
  }
  return i;
}

// Value-taking flags whose NEXT token is consumed as the flag's value (so a
// `-h`/`--help` there is the VALUE, not a help request). git push and gh pr
// merge are the verbs that reach gateCommandSegmentText-based hard gates; this
// set covers their value-taking flags. Conservative by design: missing a flag
// here only risks over-stripping a genuine help statement (a read-only no-op),
// never under-gating a mutating command.
//
// The gh pr merge subgroup is spread in from GH_PR_MERGE_VALUE_TAKING_FLAGS (the
// SSOT used by PR-number extraction) so the two cannot drift; this set ADDS the
// git push value-taking flags on top. `--repo`/`-R` come from the spread.
const HELP_STRIP_VALUE_TAKING_FLAGS = new Set([
  // git push value-taking flags
  "--push-option", "-o",
  "--receive-pack", "--exec",
  "--force-with-lease", // optional value form `--force-with-lease=<ref>` uses `=`, but bare form may consume next
  // gh pr merge value-taking flags (SSOT: GH_PR_MERGE_VALUE_TAKING_FLAGS)
  ...GH_PR_MERGE_VALUE_TAKING_FLAGS,
]);

function isGitOrGhHelpStatement(statement) {
  const tokens = shellStatementTokens(statement);
  const i = firstExecutableTokenIndex(tokens);
  const executable = commandBasename(tokens[i]);
  if (executable !== "git" && executable !== "gh") return false;
  const args = tokens.slice(i + 1);
  if (args[0] === "help") return true;
  // Walk left-to-right, skipping the value token that follows a value-taking
  // flag. A `-h`/`--help` consumed as a flag VALUE does NOT make the statement
  // help-only — git/gh still run the mutating verb. Only an EFFECTIVE help flag
  // (one not in value position) marks the statement help-only. When uncertain,
  // we err toward NOT stripping (fail toward gate evaluation): an `=`-joined
  // value (`--push-option=-h`) is one token and never matched as a help flag.
  for (let k = 0; k < args.length; k++) {
    const arg = args[k];
    if (HELP_STRIP_VALUE_TAKING_FLAGS.has(arg)) {
      k++; // consume the next token as this flag's value, even if it is -h/--help
      continue;
    }
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

function stripHelpOnlyCommandStatements(codeText) {
  const parts = codeText.split(/(&&|\|\||[;|&\n])/);
  return parts.map((part) => {
    if (/^(?:&&|\|\||[;|&\n])$/.test(part)) return part;
    return isGitOrGhHelpStatement(part) ? " " : part;
  }).join("");
}

function gateCommandSegmentText(cmd) {
  return stripHelpOnlyCommandStatements(commandSegmentText(cmd));
}

/**
 * Returns the segment whose range contains matchIndex, or null if not found.
 * Used to scope diagnostic helpers to the violating segment rather than the
 * entire raw command (Finding 1, PR #661 review).
 *
 * @param {number} matchIndex — match.index from a regex match on cmd
 * @param {Array|null} segs   — result of safeSegmentCommand(cmd)
 * @returns {{ kind: string, text: string, range: [number,number] }|null}
 */
function segmentContaining(matchIndex, segs) {
  if (!segs) return null;
  for (const seg of segs) {
    if (matchIndex >= seg.range[0] && matchIndex < seg.range[1]) return seg;
  }
  return null;
}

function firstCommandSegmentMatch(cmd, regex, segs) {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const matcher = new RegExp(regex.source, flags);
  for (const match of cmd.matchAll(matcher)) {
    if (isMatchInCommandSegment(match.index, segs)) return match;
  }
  return null;
}

// Anchor 處理 (1) 行首 / 命令分隔符後 (2) 多個 env-var 前綴 (FOO=bar BAZ=qux)
// (3) 絕對路徑 (/usr/bin/git) — per dp-reviewer Important #1。
//
// NOTE (refactor-pre-tool-gate-shell-aware): gate functions now receive
// gateCommandSegmentText(cmd) instead of raw cmd — quoted strings, heredoc bodies,
// subshell content, and comments are stripped before regex test. TOKEN_ANCHOR
// path-prefix [^\s'"]* quote-exclusion is superseded by segment filtering
// (decisions.md D4) but is kept as defence-in-depth.
// Command-boundary anchor for git/gh verb matchers. The boundary set includes a
// backtick and `$(`-context so a git WRITE nested in command substitution /
// backticks is still detected (issue #851/#848 cross-model round 5: `` echo
// `git reset --hard` `` and `X=$(git commit …)` bypassed because backtick was
// not a boundary and the `VAR=value` env-assignment prefix greedily swallowed
// `$(git …`). A bare env-assignment value is bounded to stop at `$` and backtick so
// it cannot consume a substituted command's `git` token; a quoted value (`VAR="a b" git …`) is consumed whole.
// Optional leading `env [VAR=val ...]` passthrough: `env FOO=1 git commit` runs
// git DIRECTLY with extra env (git is a real, gate-visible command), so the
// git-verb gates MUST see through it exactly like a bare `VAR=val` prefix —
// otherwise `env FOO=1 git commit` on main escapes the protected-write gate
// (issue #851/#848 round 15). `env` as an INTERPRETER wrapper (`env … sh -c
// "git…"`) is still handled by Gate 1w; this only consumes the direct-git form.
// TOKEN_ANCHOR is now the shared CMD_POSITION_ANCHOR (lib/shell-context.mjs): a real
// command-position boundary that does NOT match a verb in argument position (`echo
// git push`). Kept as a local alias so the 10 downstream `${TOKEN_ANCHOR}` regexes and
// the surrounding comment block need no edits. See CMD_POSITION_ANCHOR for the
// rationale + the (corrected) safety note: for natural/executable commands it only
// narrows matching at argument position; the match sets are not a formal strict subset.
const TOKEN_ANCHOR = CMD_POSITION_ANCHOR;

// Absolute index of the `git`/`gh` token inside a TOKEN_ANCHOR-prefixed match.
// match.index points at the leading boundary char (which for a `$(`/backtick
// substitution is the subshell-marker segment, NOT a command segment), so the
// shell-aware `isMatchInCommandSegment` check must be applied at the VERB
// position, not at match.index (issue #851/#848 round 5: `echo \`git reset\``
// and `X=$(git commit …)` were skipped because the boundary char sat in a
// subshell segment). Falls back to match.index if the token isn't located.
function gitVerbIndex(match) {
  return anchoredVerbIndex(match);
}

// Position of the real command a verb regex (TOKEN_ANCHOR-prefixed) describes. The match runs on a copy in which every
// quoted string is replaced by filler of the same length, which keeps every coordinate equal to `cmd` and keeps text
// inside a quoted environment value (`VAR="ssh -C x" gh pr create`) out of the match. The `git`/`gh` token must sit in a
// command segment of the original (not in a comment or heredoc body).
// `matchText` keeps the masked text up to the verb (a quoted environment value is data: an `ssh -C` option or a
// `GIT_DIR=` spelled inside it must not read as a directory operand) and the ORIGINAL text from the verb on (so a quoted
// `-C "<path>"` operand keeps its text). Returns null when there is none.
function locateCommandPosition(cmd, segs, re) {
  const text = cmd.toString();
  let masked = text;
  for (const seg of segs ?? []) {
    if (seg.kind !== "quoted-string") continue;
    const [from, to] = seg.range;
    masked = masked.slice(0, from) + "_".repeat(to - from) + masked.slice(to);
  }
  for (const match of masked.matchAll(new RegExp(re.source, "g"))) {
    const verbIndex = gitVerbIndex(match);
    if (!isMatchInCommandSegment(verbIndex, segs)) continue;
    return {
      verbIndex,
      matchIndex: match.index,
      matchText: masked.slice(match.index, verbIndex) + text.slice(verbIndex, match.index + match[0].length),
    };
  }
  return null;
}

// GIT_GLOBAL_OPT (consume `git` plus ANY leading global option before the verb)
// is imported from lib/shell-context.mjs so the SAME generalized grammar feeds
// every git verb gate in this file AND the branch-name extraction in
// branch-naming.mjs (issue #851/#848 cross-model rounds 6-7 — enumerating a
// subset reopened the bypass on each new git global flag). `GIT_WITH_C` =
// `git ` + zero-or-more globals, used by the protected-write / attribution /
// force-push / repo-scope matchers; the hotfix / release-rules / in-place /
// worktree base gates below use the same `GIT_GLOBAL_OPT` fragment inline.
const GIT_WITH_C = `git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*`;
const GIT_COMMIT_RE = new RegExp(`${TOKEN_ANCHOR}${GIT_WITH_C}commit\\b`);
// Blocked verbs on protected branches: setup-for-commit / history-rewriting /
// destructive operations. NOT included (handled by narrower gates or preserved):
//   - merge: every definite local merge on production is handled by Gate 2f;
//     release assembly and other merge shapes on non-production branches stay
//     outside this broad protected-write matcher
//   - cherry-pick: legitimate for hotfix back-port / release subset
//   - revert: legitimate for production rollback (revert merge commit)
// (Gate 2f owns the PR-only release-promotion recovery diagnostic.)
const GIT_WRITE_VERBS_RE = new RegExp(
  `${TOKEN_ANCHOR}${GIT_WITH_C}(?:add|rm|mv|restore|reset|stash|rebase)\\b`
);
const GIT_PUSH_RE = new RegExp(`${TOKEN_ANCHOR}${GIT_WITH_C}push\\b`);

// ── fix-eof-gate-cwd-blind-spot D3: chained-payload staleness verb sets ────
//
// These answer a DIFFERENT question than `GIT_WRITE_VERBS_RE` above: "does
// this verb mutate the INDEX (or HEAD)", not "is this verb banned on a
// protected branch". MUST NOT reuse `GIT_WRITE_VERBS_RE` — it deliberately
// EXCLUDES merge/cherry-pick/rebase because those are legitimate release-flow
// operations on protected branches, but a chained `git merge && git push` or
// `git cherry-pick && git commit` absolutely DOES mutate index/HEAD before
// the trailing verb's PreToolUse-time read. Keeping two separate constants
// (rather than trying to derive one from the other) is intentional — a
// future edit to the protected-branch allowlist must NOT silently change
// chained-staleness detection, and vice versa.
//
// index-mutating (Gate 3, checkCommitEofRestage): every verb that can change
// the staged index.
//
// `apply` only counts with a STANDALONE `--cached`/`--index` token — bare
// `git apply` (or `git apply --check`/`--stat`/etc.) touches only the
// working tree, not the index, so requiring the flag avoids over-firing on
// the common working-tree-only patch-apply shape (cross-model WARN, PR
// #2305 finding 1). The flag MUST be preceded by whitespace and followed by
// whitespace/end/chain-break — round 2 of the same finding caught that an
// unanchored substring match (`--(?:cached|index)\b` with no left boundary)
// false-fires on a PATCH FILENAME that merely contains that substring, e.g.
// `git apply patch--cached.diff` (the filename, not a flag).
//
// `checkout` only counts in its pathspec form WITH an explicit tree-ish
// before `--` (`git checkout HEAD -- <path>`, `git checkout main -- <path>`)
// — that form copies the tree-ish's version of the file into the index.
// Bare `git checkout -- <path>` (no tree-ish) restores the working tree
// FROM the current index; it does not itself mutate the index, so it is
// intentionally excluded (same cross-model finding). A plain branch-switch
// `git checkout <branch>` (no `--` at all) is also excluded — it is
// unrelated to this pathspec-restore concern and would over-fire on the
// extremely common "switch branch, then commit" shape. The tree-ish check
// skips leading `-`-prefixed flags (`-q`, `-p`, `--ours`, etc.) before
// requiring a token that itself does NOT start with `-` — git ref names
// cannot begin with `-`, so a non-dash token in tree-ish position is
// unambiguously a tree-ish, not a flag.
const INDEX_MUTATING_VERB_RE = new RegExp(
  `${TOKEN_ANCHOR}${GIT_WITH_C}(?:add\\b|rm\\b|mv\\b|restore\\b|reset\\b|stash\\b|apply\\b(?:(?!&&|\\|\\||;).)*?\\s--(?:cached|index)(?=\\s|$|&&|\\|\\||;)|cherry-pick\\b|rebase\\b|merge\\b|checkout\\b(?:\\s+-\\S+)*\\s+(?!-)\\S(?:(?!&&|\\|\\||;).)*?--(?:\\s|$))`
);
// HEAD-mutating (push gate, evaluateCommittedDiffWhitespacePush): every verb
// that advances HEAD (or rewrites it) before a chained `git push` reads
// `origin/main...HEAD`.
const HEAD_MUTATING_VERB_RE = new RegExp(
  `${TOKEN_ANCHOR}${GIT_WITH_C}(?:commit\\b|merge\\b|cherry-pick\\b|rebase\\b|revert\\b|reset\\b|am\\b|pull\\b)`
);

/**
 * D3 single shared helper: "in the SAME payload, is there a state-mutating
 * git command positioned BEFORE the target verb's occurrence?" PreToolUse
 * fires before the Bash payload executes, so a mutating command positioned
 * earlier in the SAME payload has NOT run yet at evaluation time — the state
 * a gate reads (index for Gate 3, HEAD for the push gate) is stale relative
 * to what the payload is ABOUT to do.
 *
 * Mirrors the established shape of `chainEffectiveBranchBeforeOccurrence`
 * (below): prefix slice → `gateCommandSegmentText` → top-level `&&`/`||`/`;`
 * split → per-segment verb-regex test. Pure string parsing — zero spawn
 * (NFR5) — and the caller supplies BOTH the cmdText coordinate space and the
 * matching verb-position index, so this never mixes raw-cmd and cmdText
 * offsets (the exact bug class `:2790`-area comments warn about elsewhere in
 * this file).
 *
 * Known, deliberately-accepted residual (documented, not hidden): this is
 * TEXT-POSITION order, not EXECUTION order. `false && git add -A && git
 * commit` is judged "chained" even though the `&&` short-circuit means `git
 * add` never actually runs. The direction is fail-toward-visible (one extra
 * advisory), never fail-toward-block — getting this exactly right would
 * require real shell semantics evaluation, far outside this change's scope.
 *
 * Quote/heredoc/subshell safety (cross-model WARN, PR #2305 finding 2): the
 * `cmdText` this helper receives has ALREADY had every quoted-string and
 * heredoc-body segment replaced with an opaque `__QUOTED__` placeholder by
 * `commandSegmentText()` (subshell segment text is emptied entirely) before
 * either caller ever calls this helper — see `gateCommandSegmentText()` and
 * its `commandSegmentText()` dependency in `lib/shell-context.mjs`. This
 * helper re-applies `gateCommandSegmentText()` to the SLICED prefix as a
 * defense-in-depth no-op (already-opaque text has no quotes left to
 * process), not as the first line of quote-safety. The practical
 * consequence: a literal `&&`/`;`/`||`, or text that merely LOOKS like a
 * mutating verb (`git add`), inside a commit message or other quoted
 * argument does NOT cause a false segment split or a false verb match here
 * — e.g. `git commit -m "chained: git add && push"` is correctly judged
 * NOT chained, because the quoted message became `__QUOTED__` before this
 * helper's `.split(/(?:&&|\|\||;)/)` ever runs.
 *
 * @param {string} cmdText — already `gateCommandSegmentText()`-processed command text
 * @param {number} verbIndex — index (in cmdText's coordinate space) of the target verb's match
 * @param {RegExp} mutatingVerbRe — INDEX_MUTATING_VERB_RE or HEAD_MUTATING_VERB_RE
 * @returns {boolean}
 */
function hasPriorChainedMutatingCommand(cmdText, verbIndex, mutatingVerbRe) {
  if (!Number.isInteger(verbIndex) || verbIndex <= 0) return false;
  const prefix = gateCommandSegmentText(cmdText.slice(0, verbIndex));
  for (const seg of prefix.split(/(?:&&|\|\||;)/)) {
    if (seg.trim() && mutatingVerbRe.test(seg)) return true;
  }
  return false;
}

// 單一 git push clause 是否帶 dry-run 旗標：`--dry-run` 長旗標，或 standalone `-n`
// 短旗標（`-n` = `--dry-run` per `git push -h`）。只認 token 邊界的 `-n`，不誤傷含
// "-n" 的 branch/remote 名（如 `feature-name` / `main-nightly`）。
const PUSH_DRY_RUN_RE = /--dry-run\b|(?<=^|\s)-n(?=\s|$)/;
// 判斷整段 `cmd` 是否**只**含 dry-run push（無任何真 push clause），用來決定 push-family
// gate 是否豁免。語意為 **per-clause AND / any-real-push ⇒ 非 dry-run**：
//   - 偵測 scope 到 git push clause 而非整段 compound command——否則非-push clause 裡
//     自然出現的 `-n`（`grep -n`、`echo -n`、`git log -n`、`head -n`、`sort -n`）會讓真
//     push 被誤判為 dry-run（與 `checkForcePush` 同 pattern：`gitPushClauseSlices`，傳 raw
//     `cmd`——segs offset 為 raw-cmd index space）。
//   - **逐 clause 判斷、須全部為 dry-run 才回 true**：`join(" ")` 後單次 test 是 any-match
//     漏洞——`git push -n origin main && git push origin main`（先預演再真推的謹慎慣例）
//     會因第一個 clause 的 `-n` 讓**真** push 被判 dry-run，使 archive / committed-diff
//     whitespace 等 hard-block gate 被無聲跳過（fail-open on a release-integrity gate，
//     cross-model review 攔下的第二個 Critical）。故只要**任一** push clause 是真 push，
//     整段即非 dry-run（gate 須照跑）。
//   - fallback：`gitPushClauseSlices` 回空（segs null / 切不出 push clause，但上游
//     `GIT_PUSH_RE.test` 已判定含 push——罕見的 slicing 失敗）→ 對整段 cmd 單次 test。
//     此路徑無法逐 clause 拆，殘留與**修補前**相同的 any-match 曝險：整段任一處有
//     `-n`/`--dry-run` 即回 true → 對負判 predicate（`!isPushDryRun`）而言是 gate 的
//     fail-open。接受此窄邊界，因為 (a) 僅在 parser 對含 push 的 cmd 完全切不出 clause
//     時觸發，(b) 曝險不大於修補前既有行為，(c) multi-push-clause 的關鍵修正本就依賴
//     slicing 成功；正常路徑（slicing 成功）已逐 clause AND、無此洞。
function isPushDryRun(cmd) {
  const segs = safeSegmentCommand(cmd);
  const pushClauses = gitPushClauseSlices(cmd, segs);
  if (pushClauses.length === 0) return PUSH_DRY_RUN_RE.test(cmd);
  // 全部 push clause 皆 dry-run 才算 dry-run；任一真 push ⇒ 整段非 dry-run（gate 照跑）。
  return pushClauses.every((clause) => PUSH_DRY_RUN_RE.test(clause));
}
const GIT_PROTECTED_WRITE_RE = new RegExp(
  `${TOKEN_ANCHOR}${GIT_WITH_C}(commit|add|rm|mv|restore|reset|stash|rebase)\\b`,
  "g"
);
// Content-materialize forms that write an arbitrary tree's content into the CURRENT
// branch's working tree + index — distinct from the verbs above because the bare verb
// (`checkout` / `read-tree`) is NOT itself a protected-write (a plain `git checkout
// <branch>` / `git checkout -- <file>` / `git read-tree <sha>` is allowed). Only these
// specific shapes materialize FOREIGN content onto a protected branch:
//   - `git checkout <tree-ish> -- <pathspec>`  (overwrites pathspec from <tree-ish>)
//   - `git read-tree -u …`                      (-u writes the read tree to the worktree)
// This closes the gate gap by which a sub-worktree's tree got checked out into the main
// worktree (the in-session pollution mechanism). Capture group 1 = the verb, for reason
// text symmetry with GIT_PROTECTED_WRITE_RE.
// `checkout <tree-ish> -- <pathspec>`: one-or-more non-`--` argv tokens (the tree-ish,
// possibly preceded by options) then a standalone `--` then AT LEAST ONE pathspec token.
// The `(?!--\s|--$)` guards the first token so `git checkout -- file` (no tree-ish) does
// NOT match; the trailing `--\s+[^\s|;&]` requires a real pathspec after `--`, so
// `git checkout <tree> --` with NOTHING after `--` (a plain switch/detach, no content
// write) does NOT match. read-tree: any `read-tree` invocation in the same statement
// carrying `-u` (which writes the read tree into the working tree).
// CRITICAL (two crossing vectors, both closed):
// (1) the pre-`--` argv TOKENS use `[^\s|;&<>()]+`, NOT `\S+` — `\S+` would consume shell
//     command separators (`&&` `;` `|`) and grouping/redirect chars, crossing into a
//     later command's `-- <arg>` (`git checkout abc | grep -- foo`); and
// (2) the INTER-token / pre-`--` whitespace uses `[^\S\n\r]+` (horizontal whitespace:
//     space/tab), NOT `\s+` — because `\s` matches `\n`/`\r`, so a plain `\s+` between
//     tokens bridges a NEWLINE-separated command boundary and binds a later line's
//     `-- <arg>` (`git checkout main⏎git diff -- x`). A literal newline is a real command
//     separator; a tab is NOT (it is ordinary token whitespace, so `git checkout a⏎b`
//     splits but `git checkout a<TAB>b` is one command's args — tab stays included).
// Together these confine the checkout arm to a single shell command segment (PR #933
// cross-model rounds 5-6: confirmed in-scope false-positives on natural commands; round 6
// mirrors the same `\s`-covers-`\n` mistake closed in finding (b)'s CMD_POSITION_ANCHOR).
const GIT_CONTENT_MATERIALIZE_RE = new RegExp(
  `${TOKEN_ANCHOR}${GIT_WITH_C}(?:(checkout)\\b(?:[^\\S\\n\\r]+(?!--[^\\S\\n\\r]|--$)[^\\s|;&<>()]+)+[^\\S\\n\\r]+--[^\\S\\n\\r]+[^\\s|;&]|(read-tree)\\b[^|;&\\n]*[^\\S\\n\\r]-[A-Za-z]*u)`,
  "g"
);
const REPO_SCOPE_GIT_WRITE_RE = new RegExp(
  `${TOKEN_ANCHOR}${GIT_WITH_C}(commit|add|rm|mv|restore|reset|stash|rebase|push|merge|checkout|switch|worktree|branch|tag)\\b`,
  "g"
);
const REPO_SCOPE_GIT_CLONE_RE = new RegExp(
  `${TOKEN_ANCHOR}${GIT_WITH_C}clone\\b`,
  "g"
);
const REPO_SCOPE_GH_REPO_CLONE_RE = new RegExp(
  `${TOKEN_ANCHOR}gh\\s+repo\\s+clone\\b`,
  "g"
);
// gh reads --repo/-R before `pr`, between `pr` and the verb, and after the verb; every gate behind these three regexes
// sees the command in all three positions (fix-pre-verb-repo-flag-gates).
const GH_PR_MERGE_RE = new RegExp(`${TOKEN_ANCHOR}${ghPrVerbSource("merge")}\\b`);
// gh reads --repo/-R before `run`/`pr` and between `pr` and the verb as well (fix-pre-verb-repo-flag-checks).
const GH_PR_CREATE_RE = new RegExp(`${TOKEN_ANCHOR}${ghPrVerbSource("create")}\\b`);
const GH_PR_EDIT_RE = new RegExp(`${TOKEN_ANCHOR}${ghPrVerbSource("edit")}\\b`);
const PRE_CREATE_BRANCH_SWITCH_RE = /\bgit\s+(?:-\S+(?:\s+\S+)?\s+)*(?:checkout|switch)\b/;

// Where the real `gh pr create` of a command runs: its position and the cwd at that position. Every gate triggered by
// `gh pr create` reads the checkout from here, never from the gate runner's first `git`/`gh` position and never from a
// raw string search. `index` is -1 when the command cannot be located; `cwd` is UNRESOLVABLE_CWD when it cannot be
// resolved statically and "" when there is no base cwd to resolve against. Only this resolution tolerates file-descriptor
// redirects and chdir-free pipelines between a `cd` and the command (the shared default keeps them unresolved).
function ghPrCreateCheckout(cmd, baseCwd, segs = safeSegmentCommand(cmd)) {
  const located = locateCommandPosition(cmd, segs, GH_PR_CREATE_RE);
  if (!located) return { index: -1, cwd: UNRESOLVABLE_CWD };
  return { index: located.verbIndex, ...prCreateCwd(cmd, baseCwd, located.matchIndex, located.verbIndex) };
}

// gh has no `-C`, so a session in one repository names the local checkout of a PR for another repository with a
// command-local `DEVPRO_PR_CHECKOUT=<absolute path>` in front of that `gh pr create` (#3556); the parse lives in
// lib/pr-checkout-declaration.mjs so every gate reads it the same way.

// The DEVPRO_PR_CHECKOUT declared on the real `gh pr create` of a command, read the way the gates read it: null when
// absent, { cwd } for a literal absolute path to a git checkout, { error } otherwise. The post-PR marker records it
// as the PR's worktree (#3562).
export function declaredPrCreateCheckout(cmd) {
  const located = locateCommandPosition(cmd, safeSegmentCommand(cmd), GH_PR_CREATE_RE);
  return located ? declaredPrCheckout(cmd, located.matchIndex, located.verbIndex) : null;
}

// Manually scan `"$(...)"` subshell-quoted value, treating heredoc body as
// opaque. Returns the inner content (excluding outer `"..."` wrap) or null
// if not a `"$(` form. Used by extractFlagValues to handle commit messages
// whose body contains literal `"` chars (e.g., `\`grep "x"\``).
function extractSubshellQuotedValue(cmd, valueStart) {
  if (cmd[valueStart] !== '"' || cmd[valueStart + 1] !== "$" || cmd[valueStart + 2] !== "(") {
    return null;
  }
  // Scan from position after `"$(` tracking paren depth; skip heredoc bodies.
  let i = valueStart + 3;
  let depth = 1;
  while (i < cmd.length) {
    // Heredoc detection: `<<['"]?TAG['"]?` — body is opaque until `\nTAG\n` or EOF
    const heredocMatch = cmd.slice(i).match(/^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (heredocMatch) {
      const tag = heredocMatch[2];
      const tagRe = new RegExp(`\\n${tag}(?=\\s|$|\\))`);
      const bodyStart = i + heredocMatch[0].length;
      // Find next \nTAG (followed by \s or end or `)`)
      const tagSearch = cmd.slice(bodyStart);
      const tagEnd = tagSearch.search(tagRe);
      if (tagEnd !== -1) {
        // Skip past the heredoc body + TAG marker
        i = bodyStart + tagEnd + 1 + tag.length;
        continue;
      }
      // No matching TAG: heredoc unterminated, abort
      return null;
    }
    const ch = cmd[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        // Expect `"` immediately after to close the outer quote pair
        if (cmd[i + 1] === '"') {
          return cmd.slice(valueStart + 1, i + 1); // inner content with `$(...)` preserved
        }
        return null;
      }
    }
    i++;
  }
  return null;
}

function extractFlagValues(cmd, flagPattern) {
  // F2 fix (audit task #6): the simple regex `"([^"]*)"` truncates the value
  // at the first inner `"` — breaking commit messages whose body contains a
  // literal `"` (e.g., `git commit -m "$(cat <<'EOF' ... \`grep "x"\` ... EOF)"`
  // truncates at the first `"` inside the heredoc body, yielding a partial
  // value that loses the trailing `Rules:` footer → false-negative block.
  //
  // The segmenter (lib/shell-context.mjs::segmentCommand) has the same bug —
  // it doesn't treat `$(...)` content as opaque and breaks at inner `"`.
  // Workaround: for `-m "$(...)"` form specifically, manually scan with
  // paren-depth tracking + heredoc-tag awareness via
  // extractSubshellQuotedValue. Other forms (-m "plain" / -m 'plain' /
  // -m unquoted) fall through to the original simple regex which works
  // correctly when no `$(` subshell is present.
  const values = [];
  const segs = safeSegmentCommand(cmd);
  const flagOnlyRe = new RegExp(`(?:${flagPattern})(?:=|\\s+)`, "g");
  const valueRe = /^(?:"([^"]*)"|'([^']*)'|(\S+))/;
  for (const flagMatch of cmd.matchAll(flagOnlyRe)) {
    if (segs && !isMatchInCommandSegment(flagMatch.index, segs)) continue;
    const valueStart = flagMatch.index + flagMatch[0].length;

    // Special-case: `-m "$(...)"` subshell form with potentially embedded `"`
    // inside heredoc body. Manual paren-depth scan (segmenter is unreliable
    // for this form — embedded `"` breaks its quoted-string segment).
    const subshellValue = extractSubshellQuotedValue(cmd, valueStart);
    if (subshellValue !== null) {
      values.push(subshellValue);
      continue;
    }

    // Fallback: simple regex from valueStart (plain `-m "value"` / `-m 'value'` / `-m unquoted`).
    const tail = cmd.slice(valueStart);
    const m = valueRe.exec(tail);
    if (m) values.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return values;
}

// Single-line footer required: Rules + Tool + Model on one line at end of
// message. New format: `Rules: v<X.Y.Z> · Tool: <tool> · Model: <model>`.
// Legacy single-line: `Rules: v<X.Y.Z> ... Model: <tool> / <model>`.
function attributionFooterPresent(text) {
  // PreToolUse 收到 shell 展開前 literal 命令；當 AI 用 heredoc commit
  // `git commit -m "$(cat <<'EOF' ... EOF)"` 模板，footer 後會跟著 marker + `)"`
  // artifact，footer 物理位置被推離 240 字元 tail → false negative。
  // 剝 trailing heredoc artifact 後再驗 tail。約束：必須 \n 開頭 + 全大寫
  // marker + \n 結尾 + 可選 )/quote。風險邊界：body 結尾全大寫 token + 換行
  // 結尾才會誤剝（極罕見；hook-pre-tool-gate.test.mjs T4(iv) false-positive
  // case 守線）。SSOT: ai-autonomy.md §commit message 寫法（mechanical）.
  const cleaned = text.trimEnd()
    .replace(/\n[A-Z][A-Z0-9_]*\n\)?["']?$/, '')
    .trimEnd();
  const tail = cleaned.slice(-240);
  return (
    /Rules:\s*v[\d.]+[^\n]*?Tool:\s*\S[^\n]*?Model:\s*\S[^\n]*$/.test(tail) ||
    /Rules:\s*v[\d.]+[^\n]*?Model:\s*\S[^\n]*\s+\/\s+\S[^\n]*$/.test(tail)
  );
}

function buildHeredocVirtualFileMap(cmd, baseCwd) {
  try {
    const segs = safeSegmentCommand(cmd);
    if (!segs || segs.length === 0) return new Map();
    const map = new Map();
    const REDIRECT_PATH_RE =
      />>?\s*("[^"]+"|'[^']+'|(?!\$)\S+)\s+<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?|<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?\s+>>?\s*("[^"]+"|'[^']+'|(?!\$)\S+)/;
    for (let k = 0; k < segs.length; k++) {
      if (segs[k].kind !== "heredoc-body") continue;
      const preceding = [];
      if (k >= 1 && segs[k - 1].kind === "command") preceding.unshift(segs[k - 1].text);
      if (k >= 2 && segs[k - 2].kind === "command") preceding.unshift(segs[k - 2].text);
      if (preceding.length === 0) continue;
      const context = preceding.join("");
      const m = REDIRECT_PATH_RE.exec(context);
      if (!m) continue;
      const rawPath = m[1] ?? m[2];
      if (!rawPath) continue;
      const target = shellTokenValue(rawPath);
      const resolved = path.isAbsolute(target)
        ? target
        : path.resolve(baseCwd, target);
      // Ordering guard: reject if `git commit -F <resolved>` (or the raw token)
      // appears in the preceding context before the redirect match — that means
      // the commit runs before the heredoc write (reverse-order race).
      const beforeRedirect = context.slice(0, m.index);
      const escapedRaw = rawPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const escapedResolved = resolved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const commitBeforeRE = new RegExp(
        `(?:^|[\\s;|&(])(?:[^\\s'"]*\\/)?git(?:\\s+-C\\s+\\S+)*\\s+commit\\b[^\\n]*-F[\\s=](?:${escapedRaw}|${escapedResolved})`
      );
      if (commitBeforeRE.test(beforeRedirect)) continue;
      map.set(resolved, segs[k].text);
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Shared implementation for gitCommitClauseSlices and gitPushClauseSlices.
 *
 * Both slicers are identical except for the verb regex (GIT_COMMIT_RE vs
 * GIT_PUSH_RE). Factoring here ensures a single source for the invariant:
 *
 *   `cmd` MUST be the full raw command string (not the placeholder-shortened
 *   cmdText produced by gateCommandSegmentText). The `segs` array is built from
 *   raw cmd by safeSegmentCommand(cmd), so its element offsets live in the same
 *   raw-cmd index space as the regex match.index values. Passing cmdText here
 *   would misalign the two index spaces — matches in the shortened text fall on
 *   wrong positions in the segs array, causing isMatchInCommandSegment to return
 *   false for real verb tokens and silently drop their clauses.
 *
 * @param {string} cmd     — full ORIGINAL (raw) command string
 * @param {Array|null} segs — result of safeSegmentCommand(cmd)
 * @param {RegExp} verbRe  — verb pattern (GIT_COMMIT_RE or GIT_PUSH_RE)
 * @returns {string[]} array of clause sub-strings, one per verb occurrence
 */
function gitSubcommandClauseSlices(cmd, segs, verbRe) {
  const re = new RegExp(verbRe.source, "g");
  const slices = [];
  for (const match of cmd.matchAll(re)) {
    if (!isMatchInCommandSegment(gitVerbIndex(match), segs)) continue;
    const clauseStart = match.index;
    const clauseEnd = findTopLevelSeparator(cmd, match.index + match[0].length);
    slices.push(cmd.slice(clauseStart, clauseEnd));
  }
  return slices;
}

/**
 * Extract clause slices for each `git commit` occurrence in `cmd`.
 *
 * Clause scope (M1-M3):
 *   - Start: the `git commit` match index (must be in a command segment, per
 *            the `isMatchInCommandSegment` guard that filters out commit tokens
 *            appearing inside quoted strings or heredoc bodies).
 *   - End  : found by `findTopLevelSeparator` — a depth-tracking scan that
 *            correctly skips over quoted strings, `"$(…)"` subshells, heredocs,
 *            and backtick expansions (M1 architect constraint: a naive
 *            `indexOf("&&")` or reliance on the segmenter alone would mis-fire
 *            on inner `&&`/`|` inside a `"$(… && grep -F x …)"` subshell,
 *            truncating the clause and losing the footer → false-negative).
 *   - If no top-level separator is found after the match, the clause runs
 *     to the end of the string.
 *
 * Multiple commit clauses (e.g. `git commit … && git commit …`) are each
 * extracted independently and validated downstream as separate message units.
 *
 * Design choice — slice vs range parameters:
 *   A commit clause (`git commit -m "$(…heredoc…)"`) is self-contained: all
 *   heredoc and quoted structures are fully enclosed within the clause bounds.
 *   The clause-end scan via `findTopLevelSeparator` ensures we never cut
 *   inside a quoted region or subshell, so re-segmenting the slice yields a
 *   correct parse for `extractFlagValues`. Range parameters would require
 *   changing the `extractFlagValues` signature and introducing caller-side
 *   coupling; slice keeps the change local to this function.
 *
 * Known limitation (M3 — documented, not fixed):
 *   A `\` line-continuation spanning the clause boundary may cause the clause
 *   to end prematurely (the backslash-escape logic in `findTopLevelSeparator`
 *   skips `\` + the next char, so `\ ` (backslash-space) is consumed but
 *   `\` at end-of-line before a real `\n` continuation is also consumed —
 *   the following `\n` is then seen as a bare `\n` → separator). The
 *   consequence is fail-closed (shortened clause → flags may be missed →
 *   BLOCK), not a false-open. This form is extremely rare in agent output.
 *
 * @param {string} cmd  — full original command string
 * @param {Array|null} segs — result of safeSegmentCommand(cmd), used to
 *                            verify the commit match is at a command position
 * @returns {string[]} array of clause sub-strings, one per git commit occurrence
 */
function gitCommitClauseSlices(cmd, segs) {
  return gitSubcommandClauseSlices(cmd, segs, GIT_COMMIT_RE);
}

/**
 * Extract all commit messages (from -m/--message and -F/--file flags) from the
 * command, scoped to the git-commit clause(s) only.
 *
 * Scoping prevents flags from OTHER tools sharing the same flag letter
 * (grep -F, awk -F, grep -m) from being misread as commit message sources,
 * which caused fail-closed blocks on legitimate natural commands (the
 * "false-positive" class of bug this function addresses).
 *
 * @param {string} cmd
 * @param {string} baseCwd
 * @returns {{ readFailed: boolean, message: string, messages: string[] }}
 */
function gitCommitMessageFromCommand(cmd, baseCwd) {
  const vfMap = buildHeredocVirtualFileMap(cmd, baseCwd);
  const segs = safeSegmentCommand(cmd);
  const clauses = gitCommitClauseSlices(cmd, segs);
  // Fallback: if no commit clause was found (e.g. parser failure), fall through
  // to full-cmd scan so the gate stays fail-closed rather than silently skipping
  // attribution verification.
  const sources = clauses.length > 0 ? clauses : [cmd];
  const messages = [];
  for (const clause of sources) {
    let message = "";
    for (const value of extractFlagValues(clause, "-m|--message")) {
      message += `${value}\n\n`;
    }
    for (const filePath of extractFlagValues(clause, "-F|--file")) {
      // T2 fix: `-F -` means stdin. In a heredoc command like
      // `git commit -F - <<'EOF'\n<msg>\nEOF`, the message comes from the
      // heredoc body attached to this clause. Look for a heredoc-body segment
      // within the clause; if found, use its text. If not found, maintain
      // readFailed (fail-closed — unknown stdin source must not bypass attribution).
      if (filePath === "-") {
        const clauseSegs = safeSegmentCommand(clause);
        const heredocSeg = clauseSegs
          ? clauseSegs.find((s) => s.kind === "heredoc-body")
          : null;
        if (heredocSeg) {
          message += `${heredocSeg.text}\n\n`;
        } else {
          return { readFailed: true, message };
        }
        continue;
      }
      const resolved = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(baseCwd, filePath);
      if (vfMap.has(resolved)) {
        message += `${vfMap.get(resolved)}\n\n`;
        continue;
      }
      try {
        const stat = statSync(resolved);
        if (stat.size > 1024 * 1024) return { readFailed: true, message };
        message += `${readFileSync(resolved, "utf8")}\n\n`;
      } catch {
        return { readFailed: true, message };
      }
    }
    messages.push(message);
  }
  return { readFailed: false, message: messages.join("\n\n"), messages };
}

const READ_ONLY_STASH_SUBCOMMANDS = new Set(["list", "show"]);

function tokenAfterMatch(cmd, match) {
  const end = (match.index ?? 0) + match[0].length;
  const tail = cmd.slice(end);
  const m = tail.match(/^\s+("[^"]+"|'[^']+'|[^\s|&;<>()]+)/);
  if (!m) return "";
  return shellTokenValue(m[1] || "").trim();
}

function tailAfterMatch(cmd, match) {
  const end = (match.index ?? 0) + match[0].length;
  return cmd.slice(end).split(/[|&;]/, 1)[0] || "";
}

function isReadOnlyStashInvocation(cmd, match) {
  if (match?.[1] !== "stash") return false;
  const subcommand = tokenAfterMatch(cmd, match);
  return READ_ONLY_STASH_SUBCOMMANDS.has(subcommand);
}

function repoScopeApprovalValues(cmd) {
  const values = [];
  const segs = safeSegmentCommand(cmd.toString());
  const re = /(^|[\s;|&(])DEVPRO_REPO_SCOPE_APPROVED=("[^"]+"|'[^']+'|\S+)/g;
  for (const match of cmd.toString().matchAll(re)) {
    const markerIndex = (match.index ?? 0) + (match[1] || "").length;
    if (!isMatchInCommandSegment(markerIndex, segs)) continue;
    const value = shellTokenValue(match[2] || "").trim();
    if (value) values.push(value);
  }
  return values;
}

function hasAnyRepoScopeApproval(cmd) {
  return repoScopeApprovalValues(cmd).length > 0;
}

function repoScopeTargetRoot(targetCwd, baseCwd) {
  return gitRootForCwd(targetCwd) || gitRootForPath(targetCwd, baseCwd) || targetCwd;
}

// The repository name a marker approves, derived from the paths. A linked worktree's top level is its own
// directory (e.g. `.worktree/<change>`), so the name comes from the directory that holds the shared `.git` (#3508);
// other layouts keep the top-level basename.
function repoScopePathName(targetCwd, baseCwd) {
  const common = gitCommonDir(targetCwd);
  if (common && path.basename(common) === ".git") return path.basename(path.dirname(common));
  return path.basename(resolveSafe(repoScopeTargetRoot(targetCwd, baseCwd)));
}

// The repository name of the target checkout's `origin` (owner/target -> target): the URL git itself uses, so
// `url.<base>.insteadOf` applies. Null without a GitHub-shaped `origin`, which leaves the path-derived names alone.
// Memoised per process by resolved root; read only after a gate has resolved a target checkout.
const repoScopeOriginNames = new Map();
function repoScopeOriginName(targetCwd, baseCwd) {
  const root = resolveSafe(repoScopeTargetRoot(targetCwd, baseCwd));
  if (!repoScopeOriginNames.has(root)) {
    repoScopeOriginNames.set(root, resolveGithubRepoIdentity(root)?.slug.split("/")[1] ?? null);
  }
  return repoScopeOriginNames.get(root);
}

// The name a block reason reports: the origin repository name when it resolves, else the path-derived name.
function repoScopeTargetName(targetCwd, baseCwd) {
  return repoScopeOriginName(targetCwd, baseCwd) ?? repoScopePathName(targetCwd, baseCwd);
}

function hasRepoScopeApprovalFor(cmd, targetCwd, baseCwd) {
  const values = repoScopeApprovalValues(cmd);
  if (values.length === 0) return false;
  if (values.includes("*")) return true;

  // Today's three path-derived names plus the origin repository name, all compared exactly (design D7).
  const names = new Set([
    repoScopeOriginName(targetCwd, baseCwd),
    repoScopePathName(targetCwd, baseCwd),
    path.basename(resolveSafe(repoScopeTargetRoot(targetCwd, baseCwd))),
    path.basename(resolveSafe(targetCwd)),
  ].filter(Boolean));
  return values.some((value) => names.has(value));
}

function isValidRepoScopeApprovalName(value) {
  if (!value || value === "*" || value === "." || value === "..") return false;
  return !/[\\/]/.test(value);
}

function writeRepoScopeApproval(repoBasename, activeCommon) {
  if (!isValidRepoScopeApprovalName(repoBasename)) return;
  if (!activeCommon) return;
  try {
    mkdirSync(SENTINEL_DIR, { recursive: true });
    writeFileSync(
      repoScopeApprovalFilePath(repoBasename, activeCommon),
      `${activeCommon}\n${repoBasename}\n${Date.now()}`
    );
  } catch (e) {
    process.stderr.write(
      `pre-tool-gate repo-scope approval write failed (${repoBasename}): ${e.message}\n`
    );
  }
}

function readRepoScopeApproval(repoBasename, activeCommon) {
  if (!isValidRepoScopeApprovalName(repoBasename)) return null;
  if (!activeCommon) return null;
  const filePath = repoScopeApprovalFilePath(repoBasename, activeCommon);
  try {
    const content = readFileSync(filePath, "utf8").trim();
    const [line1, line2, line3] = content.split("\n");
    const storedCommon = (line1 || "").trim();
    const storedRepo = (line2 || "").trim();
    const epochMs = parseInt((line3 || "").trim(), 10);
    if (storedCommon !== activeCommon || storedRepo !== repoBasename || isNaN(epochMs)) {
      try { unlinkSync(filePath); } catch { /* ignore */ }
      return null;
    }
    if (Date.now() - epochMs > REPO_SCOPE_APPROVAL_TTL_MS) {
      try { unlinkSync(filePath); } catch { /* ignore */ }
      return null;
    }
    return { repoBasename: storedRepo, epochMs };
  } catch {
    return null;
  }
}

function hasRepoScopeStateApprovalFor(targetCwd, baseCwd) {
  const activeCommon = gitCommonDir(baseCwd);
  if (!activeCommon) return false;
  // Today's two path-derived names plus the origin repository name, all compared exactly (design D7).
  const names = new Set([
    repoScopeOriginName(targetCwd, baseCwd),
    repoScopePathName(targetCwd, baseCwd),
    path.basename(resolveSafe(repoScopeTargetRoot(targetCwd, baseCwd))),
  ].filter(Boolean));
  return [...names].some((name) => !!readRepoScopeApproval(name, activeCommon));
}

function updateRepoScopeApprovalState(cmd, baseCwd = process.cwd()) {
  const activeCommon = gitCommonDir(baseCwd);
  for (const value of repoScopeApprovalValues(cmd)) {
    writeRepoScopeApproval(value, activeCommon);
  }
}

function isRepoScopeGitWriteInvocation(cmd, match) {
  const verb = match?.[1] || "";
  if (!verb) return false;
  if (verb === "stash") return !isReadOnlyStashInvocation(cmd, match);
  if (verb === "worktree") {
    const subcommand = tokenAfterMatch(cmd, match);
    return subcommand !== "list";
  }
  if (verb === "branch") {
    const subcommand = tokenAfterMatch(cmd, match);
    if (!subcommand) return false; // plain `git branch` list is read-only
    const tail = tailAfterMatch(cmd, match);
    if (/\s(?:-[dDmMcC]\b|-[^-]\S*[dDmMcC]\S*|--(?:delete|move|copy|edit-description|set-upstream-to|unset-upstream)\b)/.test(tail)) {
      return true;
    }
    return !subcommand.startsWith("-");
  }
  if (verb === "tag") {
    const subcommand = tokenAfterMatch(cmd, match);
    if (!subcommand) return false; // plain `git tag` list is read-only
    const tail = tailAfterMatch(cmd, match);
    if (/\s(?:-[adfsu]\b|-[^-]\S*[adfsu]\S*|--(?:annotate|delete|force|sign|local-user|message|file)\b)/.test(tail)) {
      return true;
    }
    return !subcommand.startsWith("-");
  }
  return true;
}

function buildRepoScopeBlockReason(kind, detail) {
  const marker = "DEVPRO_REPO_SCOPE_APPROVED=<target-repo-basename>";
  const fileToolHint = kind === "cross-repo file write"
    ? `\n\nDedicated file tools cannot carry inline Bash env markers. To use Edit/Write/MultiEdit across repos, first run a short-lived Bash approval marker from the active repo, for example \`${marker} true\`, or cwd into the target repo; then retry Edit/Write/MultiEdit.`
    : "";
  return `Repo Scope Evidence Gate：偵測 ${kind}（${detail}），但目前 active repo 與目標 repo 不同，且未提供 scoped approval marker \`${marker}\`。\n\nWorkspace 內多 repo read-only inspection 允許；但在一個 repo 內找不到證據時，不得自行切到另一個 repo clone/branch/edit/commit。請先回報 target repo 的 negative evidence，取得使用者具名同意後再重跑，或把 cwd 切到使用者明確指定的 workspace/target repo。${fileToolHint}\n\n${HOOK_BYPASS_HINT}`;
}

function checkRepoScopeClone(cmd) {
  const segs = safeSegmentCommand(cmd);
  for (const re of [REPO_SCOPE_GIT_CLONE_RE, REPO_SCOPE_GH_REPO_CLONE_RE]) {
    re.lastIndex = 0;
    for (const match of cmd.matchAll(re)) {
      if (!isMatchInCommandSegment(match.index, segs)) continue;
      if (hasAnyRepoScopeApproval(cmd)) return null;
      return {
        block: true,
        reason: buildRepoScopeBlockReason("git clone / gh repo clone", match[0].trim()),
      };
    }
  }
  return null;
}

function checkRepoScopeGitWrite(cmd, baseCwd) {
  const activeCommon = gitCommonDir(baseCwd);
  if (!activeCommon) return null; // workspace cwd with no active repo is valid

  const segs = safeSegmentCommand(cmd);
  REPO_SCOPE_GIT_WRITE_RE.lastIndex = 0;
  for (const match of cmd.matchAll(REPO_SCOPE_GIT_WRITE_RE)) {
    if (!isMatchInCommandSegment(gitVerbIndex(match), segs)) continue;
    if (!isRepoScopeGitWriteInvocation(cmd, match)) continue;

    // Pass the VERB index (not match.index): CMD_POSITION_ANCHOR starts the match
    // at the boundary char (`a && git` → match.index points mid-`&&`), which would
    // truncate the cd-prefix and drop separators the cwd mix-detection relies on.
    const targetCwd = commandCwdForGitMatch(cmd, match[0], baseCwd, gitVerbIndex(match));
    const targetCommon = gitCommonDir(targetCwd);
    if (!targetCommon || targetCommon === activeCommon) continue;
    if (hasRepoScopeApprovalFor(cmd, targetCwd, baseCwd)) continue;

    return {
      block: true,
      reason: buildRepoScopeBlockReason(
        "cross-repo git write",
        `${match[0].trim()} targets ${repoScopeTargetName(targetCwd, baseCwd)}`
      ),
    };
  }
  return null;
}

function checkRepoScopeEvidence(cmd, baseCwd) {
  return checkRepoScopeClone(cmd) || checkRepoScopeGitWrite(cmd, baseCwd);
}

// Returns one of:
//   null                              — no git write, or write provably NOT on a
//                                       protected branch → allow silently.
//   { branch, verb, matchedSegment, matchText }  — DEFINITE protected write → block.
//   { uncertain: true, matchText, chdir, cwd }
//                                     — a git write whose target cwd/branch could
//                                       not be resolved → caller emits a NON-blocking
//                                       advisory and allows (fail-open-on-uncertainty,
//                                       per the accident-prevention threat model).
function protectedGitWriteViolation(cmd, baseCwd) {
  // Run regex on original cmd to preserve -C <path> info for CWD extraction.
  // Segment the cmd first; skip matches whose start position falls inside a
  // non-command segment (quoted-string, heredoc-body, comment) to eliminate FP.
  const segs = safeSegmentCommand(cmd);
  let uncertain = false;
  // First unresolvable match: feeds the advisory's cwd evidence line (resolved
  // stays the sentinel, never backfilled from the base cwd).
  let uncertainMatch = null;
  GIT_PROTECTED_WRITE_RE.lastIndex = 0;
  for (const match of cmd.matchAll(GIT_PROTECTED_WRITE_RE)) {
    // Check the segment at the git VERB position (not match.index, which may be a
    // `$(`/backtick boundary in a subshell-marker segment — round 5).
    if (!isMatchInCommandSegment(gitVerbIndex(match), segs)) continue;
    if (isReadOnlyStashInvocation(cmd, match)) continue;
    // VERB index, not match.index (CMD_POSITION_ANCHOR consumes the boundary char).
    // The evidence out-param only READS the resolver's own shell-aware chdir
    // detection (`explicitChdir`); it sets none of the resolver's options, so the
    // return value and the uncertainty disposition are unchanged (design D4).
    const cwdEvidence = {};
    const resolvedCwd = commandCwdForGitMatch(
      cmd,
      match[0],
      baseCwd,
      gitVerbIndex(match),
      cwdEvidence
    );
    // UNRESOLVABLE = the resolver could NOT statically determine the write's cwd
    // (ambiguous prefix / CDPATH+cd / --git-dir/--work-tree / pushd-rotation /
    // missing-dir, etc.). Per this gate's threat model — prevent ACCIDENTAL
    // protected-branch writes, NOT defeat a determined evader (who has the
    // sanctioned `DEVPRO_HOOK_BYPASS=1`) — an UNCERTAIN cwd MUST NOT hard-block
    // (a false block halts the whole workflow and kills dev throughput). We
    // record it as `uncertain` so the caller can emit a NON-blocking advisory,
    // and skip this match for the hard-block decision. Only a write whose cwd
    // resolves to a REAL protected branch is a definite violation → block.
    if (resolvedCwd === UNRESOLVABLE_CWD) {
      uncertain = true;
      uncertainMatch ??= { matchText: match[0], chdir: cwdEvidence.explicitChdir === true };
      continue;
    }
    const branch = getCurrentBranch(resolvedCwd);
    if (isProtectedBranch(branch)) {
      const seg = segmentContaining(match.index, segs);
      // matchedSegment: the command segment that contains the violating git verb.
      // Fail-safe: fall back to full cmd so downstream helpers always get a string.
      const matchedSegment = seg ? seg.text : cmd;
      // matchText: the exact text matched by GIT_PROTECTED_WRITE_RE (includes any
      // -C flag that is part of this specific git invocation, but NOT -C from
      // earlier unrelated git calls in a multi-statement command).
      const matchText = match[0];
      if (
        isAllowedRulesLaneReleaseProtectedWrite({
          branch,
          verb: match[1],
          matchedSegment,
          cwd: resolvedCwd,
        })
      ) {
        continue;
      }
      return { branch, verb: match[1], matchedSegment, matchText, matchIndex: match.index ?? 0, verbIndex: gitVerbIndex(match), cwd: resolvedCwd, chdir: cwdEvidence.explicitChdir === true };
    }
  }
  // Content-materialize forms (`git checkout <tree-ish> -- <pathspec>`, `git read-tree
  // -u …`): same per-occurrence cwd resolution + fail-open-on-uncertainty as above.
  GIT_CONTENT_MATERIALIZE_RE.lastIndex = 0;
  for (const match of cmd.matchAll(GIT_CONTENT_MATERIALIZE_RE)) {
    if (!isMatchInCommandSegment(gitVerbIndex(match), segs)) continue;
    const cwdEvidence = {};
    const resolvedCwd = commandCwdForGitMatch(
      cmd,
      match[0],
      baseCwd,
      gitVerbIndex(match),
      cwdEvidence
    );
    if (resolvedCwd === UNRESOLVABLE_CWD) {
      uncertain = true;
      uncertainMatch ??= { matchText: match[0], chdir: cwdEvidence.explicitChdir === true };
      continue;
    }
    const branch = getCurrentBranch(resolvedCwd);
    if (isProtectedBranch(branch)) {
      const seg = segmentContaining(match.index, segs);
      const matchedSegment = seg ? seg.text : cmd;
      // verb = checkout (group 1) or read-tree (group 2).
      const verb = match[1] || match[2];
      return { branch, verb, matchedSegment, matchText: match[0], matchIndex: match.index ?? 0, verbIndex: gitVerbIndex(match), contentMaterialize: true, cwd: resolvedCwd, chdir: cwdEvidence.explicitChdir === true };
    }
  }
  // No definite violation. If a git write had an unresolvable cwd, surface it as
  // uncertain (→ advisory) rather than blocking.
  return uncertain ? { uncertain: true, cwd: UNRESOLVABLE_CWD, ...uncertainMatch } : null;
}

/**
 * Design D2 — the ONE cwd evidence snapshot renderer: single line, fixed item
 * order, basename-only directories (the existing `sanitizeAdvisoryCwd()`
 * convention). `resolvedCwd` MUST be the per-match resolver value; the
 * unresolvable sentinel renders as `(unresolved)` and is NEVER backfilled from
 * the base cwd (BRD R7).
 */
function buildProtectedCwdEvidence({ source, baseCwd, resolvedCwd, chdir, gitC } = {}) {
  const sourceToken =
    typeof source === "string" && source.trim() ? source : "unknown";
  const clean = (value) => sanitizeAdvisoryCwd(value).replace(/[\u0000-\u001f\u007f]/gu, "");
  return (
    `Cwd evidence：source=${sourceToken}` +
    ` baseCwd=${clean(baseCwd)}` +
    ` resolved=${clean(resolvedCwd)}` +
    ` chdir=${chdir ? "yes" : "no"}` +
    ` gitC=${gitC ? "yes" : "no"}`
  );
}

/**
 * Design D3 — whole-assembly fail-open wrapper: any throw (provenance scan,
 * renderer, or a poisoned violation field) omits ONLY this line. Every block／
 * allow decision and every pre-existing sentence stays unchanged.
 */
function protectedCwdEvidenceLine({
  toolInput,
  payload,
  baseCwd,
  violation,
  matchText,
} = {}) {
  try {
    const resolved = resolveToolInputCwd(toolInput || {}, payload || {});
    // Invariant: the reported provenance must come from the SAME scan that
    // produced `baseCwd`. A caller that pairs a payload with a foreign baseCwd
    // would otherwise report a source that did not produce the settled cwd.
    const sameOrigin =
      typeof baseCwd !== "string" || baseCwd === "" || resolved.cwd === baseCwd;
    return {
      source: sameOrigin ? resolved.source : "unknown",
      line: buildProtectedCwdEvidence({
        source: sameOrigin ? resolved.source : "unknown",
        baseCwd,
        resolvedCwd: violation?.cwd,
        chdir: violation?.chdir === true,
        gitC: hasExplicitGitCFlag(matchText || ""),
      }),
    };
  } catch {
    return { source: "", line: "" };
  }
}

function protectedWorktreeRuleGuidance(verb = "write") {
  return (
    "依 .devpro/agent-rules/git-branch-naming-and-anchor.md § Worktree 規範，" +
    `若已有 linked worktree，請改用 \`git -C <abs-worktree> ${verb} ...\`（唯一建議的 git write 形；` +
    "帶 `cd` 前綴的寫法不再建議）；" +
    "`git add` 與 `git commit` MUST 分兩次 Bash 呼叫；" +
    "若目前真的在 main/production，請停止並切 worktree。"
  );
}

// A hook-visible `cd`/`pushd` is confirmed evidence only when it pins the write's cwd without the fallback `PWD`:
// an absolute target (possibly followed by relative ones) does; `cd sub` or `cd ../../x` does not, however many
// `..` hops it takes, because Codex's real cwd may be a deeper worktree that resolves it elsewhere. Reuses the
// resolver the violation itself came from, so quoted/heredoc/comment `cd` text and a `cd` after the write never count.
function chdirPinsCwdBeforeMatch(cmd, violation, baseCwd) {
  try {
    const verbIndex = violation?.verbIndex;
    if (!Number.isInteger(verbIndex) || typeof baseCwd !== "string" || baseCwd === "") return false;
    const evidence = { baseIndependent: false };
    const actual = commandCwdForGitMatch(cmd, violation.matchText, baseCwd, verbIndex, evidence);
    return actual !== UNRESOLVABLE_CWD && evidence.baseIndependent === true;
  } catch {
    return false;
  }
}

function isCodexFallbackOnlyProtectedEvidence(cmd, violation, opts = {}) {
  try {
    if (!isCodexRuntime()) return false;
    const { toolInput, payload } = opts;
    if (!detectsCodexCwdAbsence(toolInput || {}, payload || {})) return false;
    if (hasExplicitGitCFlag(violation?.matchText || "")) return false;
    if (opts.chdirPinned) return false;
    return true;
  } catch {
    return false;
  }
}

function buildFallbackOnlyProtectedAdvisory(violation, { evidenceLine = "", chdir = false, source = "" } = {}) {
  const verb = violation?.verb || "write";
  // `chdir=yes` only records that the matched prefix changes directory; it does
  // NOT pin the cwd (design D2 invariant), so the advisory must say so instead of
  // presenting the fallback PWD as confirmed protected-branch state (R7).
  const chdirClause = chdir
    ? "命令前綴見到 hook-visible chdir，但該 chdir 未固定目錄（`chdir=yes` 只表示 prefix 有換目錄，cwd 仍未被 pin）；"
    : "";
  const chdirAbsence = chdir ? "" : " 或 hook-visible `cd <path>`";
  // The base cwd may come from the hook fallback layer OR from an execution-cwd
  // alias that is not protected-branch evidence. Never claim "no payload field"
  // when the snapshot is about to name one (R7).
  const cwdClaim =
    source === "unknown"
      ? "但本次無法證明 base cwd 的來源與實際判定目錄同源，因此不背書任何 provenance"
      : !source || isFallbackCwdSource(source)
        ? "但本次沒有任何 legacy payload cwd/workdir 欄位提供 base cwd，只有 hook fallback 層指向保護分支"
        : `但本次 payload 只提供 execution-cwd alias（\`${source}\`），依既有語意不算 protected-branch 證據`;
  const evidenceBlock = evidenceLine ? `\n\n${evidenceLine}` : "";
  const sourcePointer = evidenceLine ? "（實際來源見下方快照）" : "";
  return (
    "⚠️ Protected-branch gate proof gap：偵測到 git 寫入命令，" +
    `${cwdClaim}${sourcePointer}；` +
    `命令本身也沒有 \`git -C <path>\`${chdirAbsence}，因此視為 fallback-only evidence，` +
    `${chdirClause}target branch/worktree could not be proven，不 hard-block。${protectedWorktreeRuleGuidance(verb)} ` +
    "Codex adapter 補充：.devpro/agent-rules/platform-adapters/codex.md § Protected-Branch git Write Rule。" +
    evidenceBlock
  );
}

// Gate 1: Protected-branch + git write commands
// opts.toolInput / opts.payload — passed from checkBashCommand for the shared cwd evidence snapshot
function checkProtectedBranch(cmd, baseCwd, opts = {}) {
  const violation = protectedGitWriteViolation(cmd, baseCwd);
  if (!violation) return null;
  // Uncertain (unresolvable cwd) → do NOT hard-block here; let the chain continue
  // and the advisory fallback (checkAdvisories) surface a non-blocking reminder.
  if (violation.uncertain) return null;
  const { branch, verb, matchedSegment, matchText } = violation;

  // ONE snapshot for every protected-branch message (three block exits + the
  // fallback-only advisory). Provenance comes from the same resolver that
  // produced the base cwd; `resolved` is the per-match resolver value.
  const cwdEvidence = protectedCwdEvidenceLine({
    toolInput: opts.toolInput,
    payload: opts.payload,
    baseCwd,
    violation,
    matchText,
  });
  const cwdEvidenceLine = cwdEvidence?.line || "";
  const cwdEvidenceBlock = cwdEvidenceLine ? `\n\n${cwdEvidenceLine}` : "";

  const chdirPinned = chdirPinsCwdBeforeMatch(cmd, violation, baseCwd);
  if (isCodexFallbackOnlyProtectedEvidence(cmd, violation, { ...opts, chdirPinned })) {
    return {
      advisory: buildFallbackOnlyProtectedAdvisory(violation, {
        evidenceLine: cwdEvidenceLine,
        chdir: violation.chdir === true,
        source: cwdEvidence?.source || "",
      }),
    };
  }

  if (verb === "commit") {
    return {
      block: true,
      reason: `Protected-branch gate：在 \`${branch}\` 上禁止 \`git commit\`。${protectedWorktreeRuleGuidance(verb)}\n\n若尚未建立 worktree，先用 \`git worktree add <repo-root-abs>/.worktree/<name> -b <prefix>/<name> <anchor-sha>\` 建 feature/bugfix/chore/hotfix branch（AGENTS.md §0 Never：「main 直接實作」），進入該 worktree 後再 commit。${cwdEvidenceBlock}`,
    };
  }
  if (violation.contentMaterialize) {
    return {
      block: true,
      reason: `Protected-branch gate (content-materialize)：在 \`${branch}\` 上禁止把任意 tree 內容物化進 working tree（\`git checkout <tree-ish> -- <pathspec>\` / \`git read-tree -u\`）。此類命令會用外來內容覆寫 protected branch 的 working tree+index。${protectedWorktreeRuleGuidance(verb)} 若尚未建立 worktree，先用 \`git worktree add <repo-root-abs>/.worktree/<name> -b <prefix>/<name> <anchor-sha>\`。${cwdEvidenceBlock}`,
    };
  }
  return {
    block: true,
    reason: `Protected-branch gate：在 \`${branch}\` 上禁止 git 寫入命令（add/rm/mv/restore/reset/stash/rebase）。${protectedWorktreeRuleGuidance(verb)} 若尚未建立 worktree，先用 \`git worktree add <repo-root-abs>/.worktree/<name> -b <prefix>/<name> <anchor-sha>\` 建 worktree（AGENTS.md §0 Never）。merge 不在此 broad list：Gate 2f 另擋所有 definite local production merge，非 production 的 release assembly merge 保持合法；cherry-pick/revert 維持既有 flow 邊界。${cwdEvidenceBlock}`,
  };
}

/**
 * Extract the git push clause slice(s) from `cmd`, analogous to
 * `gitCommitClauseSlices` for git commit. Each slice starts at a `git push`
 * match and ends at the next top-level command separator.
 *
 * Used by `checkForcePush` so that force-flag / force-refspec detection runs
 * ONLY on the push clause text — preventing flags from OTHER commands in the
 * same compound command (e.g. `rm -f`) from being mistaken for push force flags.
 *
 * force-detection regex三式（--force、-f、+refspec）不動；只換掉輸入文字來源。
 *
 * @param {string} cmd  — full original command string
 * @param {Array|null} segs — result of safeSegmentCommand(cmd)
 * @returns {string[]} array of push clause sub-strings
 */
function gitPushClauseSlices(cmd, segs) {
  return gitSubcommandClauseSlices(cmd, segs, GIT_PUSH_RE);
}

// Gate HO: High-Output Command Hard Gate — block a known high-output producer (full
// source test suite / `openspec validate --strict --all` / `gh run view --log` /
// reviewer stream-json) or a repo-wide raw `rg -n` when stdout is NOT redirected to a
// repo-external log. Enforces token-frugal-io.md §Command Output Hard Gate /
// output-discipline §High-Volume Command Transcript Discipline mechanically rather
// than by prose. Classification + escape hatch live in lib/high-output-command.mjs.
// Segment text (quoted strings / heredoc bodies / comments stripped) is passed so the
// command name inside an echo / quoted string does not false-positive.
function checkHighOutputRawCommand(cmd, cwd) {
  // Resolved lazily: only a statement that names an absolute capture-command helper
  // path pays for the git lookups.
  const resolveRepoLocalHelperPaths = () =>
    [getRepoRoot(cwd), resolveMainWorktreeRoot(cwd)]
      .filter(Boolean)
      .map((root) => `${root}/.devpro/scripts/capture-command.mjs`);
  const cls = classifyHighOutput(gateCommandSegmentText(cmd), cmd, { resolveRepoLocalHelperPaths });
  if (!cls.highOutput) return null;
  return { block: true, reason: highOutputBlockReason(cls) };
}

const LEDGER_LABEL = "Rule-load duplicate ledger gate";

// fix-eof-gate-cwd-blind-spot T12: `getRepoRoot()`'s fail-open sentinel on
// "not inside any git repo" is the EMPTY STRING `""` (git-utils.mjs
// runGit()'s failure return), never a JS `null` — and `path.join("", ...)`
// does NOT throw (it silently produces a wrong relative path), so an
// unresolved repoRoot does not, by itself, distinguish "a rule-leaf read was
// silently missed" from "this command never referenced a rule leaf at all"
// (confirmed empirically: firing unconditionally on `!repoRoot` regressed
// ~35 unrelated tests across attribution/no-verify/PR-body/dev-flow-checklist
// fixtures that use non-git-repo tmp cwds for reasons unrelated to rule
// loading — the exact `--amend`/`--allow-empty` noise lesson from Gate 3,
// applied here). This regex is the cheap, textual "does this command even
// LOOK LIKE an attempted rule-leaf read" gate: only a READ_COMMANDS-shaped
// verb followed by an `.md`-suffixed token is a plausible candidate; a
// canonical `.devpro/agent-rules/`-prefixed reference is UNAFFECTED by a
// wrong repoRoot (extractRuleLeafReadsFromBash resolves it via a repoRoot-
// independent shortcut branch), so `refs.length === 0` already rules those
// out — this regex only needs to catch the bare-relative/absolute shapes
// that a wrong repoRoot COULD have broken.
const MD_READ_ATTEMPT_RE = /(?:^|[;&|]\s*)\s*(?:cat|sed|nl|head|tail|less)\b[^;&|\n]*?\S+\.md\b/;

function checkDuplicateRuleLoadLedger(cmd, baseCwd, effectiveCwd = baseCwd, payload = {}) {
  const cwdForAdvisory = effectiveCwd || baseCwd;
  try {
    const repoRoot = gitRootForCwd(cwdForAdvisory);
    const refs = extractRuleLeafReadsFromBash(cmd, repoRoot);
    if (refs.length === 0) {
      if (!repoRoot && MD_READ_ATTEMPT_RE.test(gateCommandSegmentText(cmd))) {
        return { advisory: formatNotCheckedAdvisory(LEDGER_LABEL, cwdForAdvisory, NOT_CHECKED_REASONS.REPO_ROOT_UNRESOLVED) };
      }
      return null; // class A: no rule-leaf reference in this command
    }
    const sessionIdentity = sessionRuleLoadIdentity(payload);
    if (!sessionIdentity) return null; // class A: no session identity to key duplicates on
    const result = inspectSessionRuleLoadDuplicates(refs, { repoRoot, sessionIdentity, payload });
    const reason = formatDuplicateRuleLoadBlockReason(result);
    return reason ? { block: true, reason } : null;
  } catch {
    return { advisory: formatNotCheckedAdvisory(LEDGER_LABEL, cwdForAdvisory, NOT_CHECKED_REASONS.UNEXPECTED_ERROR) };
  }
}

function ruleLoadRepoRootForPayload(payload = {}, baseCwd = process.cwd(), effectiveCwd = baseCwd) {
  const filePath = readToolFilePath(payload);
  if (filePath) {
    try {
      return gitRootForPath(filePath, baseCwd);
    } catch {
      // Fall through to cwd resolution; telemetry must not block tool execution.
    }
  }
  return gitRootForCwd(effectiveCwd || baseCwd);
}

function checkDuplicateRuleLoadLedgerPayload(payload = {}, baseCwd = process.cwd(), effectiveCwd = baseCwd) {
  const cwdForAdvisory = effectiveCwd || baseCwd;
  try {
    const repoRoot = ruleLoadRepoRootForPayload(payload, baseCwd, effectiveCwd);
    const refs = extractRuleLeafReadsFromPayload(payload, repoRoot);
    if (refs.length === 0) {
      // Read-tool sibling of the Bash candidate check above: the file_path
      // itself ending in `.md` IS the plausible-candidate signal (no verb to
      // match against).
      if (!repoRoot && readToolFilePath(payload).endsWith(".md")) {
        return { advisory: formatNotCheckedAdvisory(LEDGER_LABEL, cwdForAdvisory, NOT_CHECKED_REASONS.REPO_ROOT_UNRESOLVED) };
      }
      return null; // class A
    }
    const sessionIdentity = sessionRuleLoadIdentity(payload);
    if (!sessionIdentity) return null; // class A
    const result = inspectSessionRuleLoadDuplicates(refs, { repoRoot, sessionIdentity, payload });
    const reason = formatDuplicateRuleLoadBlockReason(result);
    return reason ? { block: true, reason } : null;
  } catch {
    return { advisory: formatNotCheckedAdvisory(LEDGER_LABEL, cwdForAdvisory, NOT_CHECKED_REASONS.UNEXPECTED_ERROR) };
  }
}

// Gate 2: Force-push（一律 block，--force-with-lease 例外）
function checkForcePush(cmd) {
  const cmdText = gateCommandSegmentText(cmd);
  if (!GIT_PUSH_RE.test(cmdText)) return null;

  // Scope force detection to the git push clause(s) only, so that flags from
  // OTHER commands in a compound pipeline (e.g. `rm -f`, `grep -f`) are not
  // mistaken for push force flags (false-positive: T1 fix).
  // Fallback: if clause slicing fails (segs null / no push clause found in
  // segmented text), fall back to full cmdText — fail-closed, not fail-open.
  //
  // IMPORTANT: pass raw `cmd` (not `cmdText`) to gitPushClauseSlices. The segs
  // array is built from raw cmd by safeSegmentCommand(cmd), so its offsets are
  // in raw-cmd index space. cmdText is shortened by gateCommandSegmentText
  // (quoted strings replaced by __QUOTED__ placeholders), so match.index values
  // from cmdText.matchAll differ from the raw-cmd offsets in segs — the second
  // push in a compound like `git push origin a && echo "pad" && git push -f …`
  // lands at a cmdText offset that falls inside a quoted-string range in segs,
  // causing isMatchInCommandSegment to drop it, leaving only the benign clause
  // → force flag not detected → fail-closed broken. gitCommitClauseSlices has
  // always received raw cmd at its call site; this aligns gitPushClauseSlices
  // to the same invariant via the shared gitSubcommandClauseSlices helper.
  const segs = safeSegmentCommand(cmd);
  const pushClauses = gitPushClauseSlices(cmd, segs);
  const scanText = pushClauses.length > 0 ? pushClauses.join(" ") : cmdText;

  // `--force` (excluding the safe `--force-with-lease` / `--force-if-includes`
  // conditions) or `-f` (standalone OR clustered in a short-flag group like
  // `-fv`/`-vf`).
  const hasForceFlag =
    /--force(?!-with-lease|-if-includes)\b/.test(scanText) ||
    /(?<![\w-])-f(?![\w-])/.test(scanText) ||
    /(?<![\w-])-[a-eg-z]*f[a-z]*\b/.test(scanText); // clustered short flags incl. f
  // Force-via-refspec: a `+`-prefixed refspec (`git push origin +main`,
  // `+HEAD:main`, `+refs/heads/x:refs/heads/y`) is a forced update — the
  // idiomatic scriptable force, previously unmodeled (round-4 audit B 1a).
  // Match a `+` that begins a positional refspec token (after whitespace, not
  // part of an option value).
  const hasForceRefspec = /(?<![\w-])\+(?=[A-Za-z0-9_./-]*(?::|\s|$))[A-Za-z0-9_./@^~-]*(?::[A-Za-z0-9_./-]+)?/.test(
    scanText.replace(/--?[A-Za-z][\w-]*(?:=\S*)?/g, " ") // drop options first
  );
  if (!hasForceFlag && !hasForceRefspec) return null;
  return {
    block: true,
    reason:
      "Force-push gate：禁止 `git push --force` / `-f` / `+<refspec>`（強制更新）。請改用 `--force-with-lease` 並明文說明 rebase 原因（per `ai-autonomy.md` §Never「禁破壞性 merge ... 禁 force-push」）。",
  };
}

// SYNC: byte-aligned with gh-footer-gate.mjs RULES_MODEL_COOCCUR — distinguishes
// "footer malformed (Rules:+Model: present, wrong shape)" from "footer absent".
// Module-level so it is compiled once, not per commitMessages iteration.
const RULES_MODEL_COOCCUR = /Rules:\s*v[\d.]+[^\n]*?Model:/;

// Per-message arm of Gate 2b: forbidden-marker → footer-presence → version-equality,
// in that precedence. Returns the gate result for the first failing check, or null
// when the message passes. agentsVer is the resolved AGENTS.md version (or null →
// version-equality layer fails open per D5). Pulled out of checkCommitAttribution so
// the multi-commit loop only orchestrates iteration, not the per-message logic.
function validateCommitMessage(commitMessage, agentsVer) {
  // SYNC: 與 gh-footer-gate.mjs 共用 lib/attribution-patterns.mjs（F10 對稱）
  // Forbidden brand markers remain compliance hard-blocks even while missing
  // attribution footer is downgraded to advisory.
  if (hasForbiddenAttribution(commitMessage)) {
    return {
      block: true,
      reason: "Commit attribution gate：commit message 含禁止的 AI-generated/coauthor brand marker；請從 message 移除該行。Hook 與 gh-footer-gate.mjs 共用 `lib/attribution-patterns.mjs` 確保 byte-for-byte 對齊。",
    };
  }
  if (!attributionFooterPresent(commitMessage)) {
    const hasRulesAndModelAnywhere = RULES_MODEL_COOCCUR.test(commitMessage);
    return {
      advisory: hasRulesAndModelAnywhere
        ? "Commit attribution gate：已偵測到 Rules: 字串，但不符合單行 footer 格式。可能 (a) heredoc artifact 推離（改用 `git commit -F /tmp/<file>`）；(b) footer 寫在 message 中段而非結尾；(c) Tool 欄位缺失。footer 必須是最後一行 `Rules: v<X.Y.Z> · Tool: <tool> · Model: <model>`。"
        : "Commit attribution gate：commit message 完全不含 Rules: footer。請在 message 結尾補單行 `Rules: v<X.Y.Z> · Tool: <tool> · Model: <model>` per ai-autonomy.md「Always」段 attribution footer 規則。輸入方式（per 同段「Commit message 寫法」規則）：`git commit -F /tmp/<file>` 或 heredoc subshell `git commit -m \"$(cat <<'EOF' ... EOF)\"`。",
    };
  }
  const _commitFooterVer = extractVersionFromFooter(commitMessage);
  if (_commitFooterVer !== null && agentsVer !== null && compareVersions(_commitFooterVer, agentsVer) !== 0) {
    return {
      block: true,
      riskClass: "release-integrity",
      reason: `Commit attribution gate (version-mismatch / release-integrity)：commit message footer 宣告 Rules: v${_commitFooterVer}，但 AGENTS.md 版本：${agentsVer}。版號不符屬 release-integrity error（commit metadata 記錄錯誤規則版本）。請更新 footer 至 AGENTS.md 真實版號 v${agentsVer}，或確認 AGENTS.md 已為最新版本。`,
    };
  }
  return null;
}

const GATE2B_VERSION_LABEL = "Commit attribution gate (version-equality)";

// Gate 2b: AI-authored git commit messages must identify rules/tool/model.
function checkCommitAttribution(cmd, baseCwd) {
  const cmdText = gateCommandSegmentText(cmd);
  const commitMatch = GIT_COMMIT_RE.exec(cmdText);
  if (!commitMatch) return null;
  if (/--no-edit\b/.test(cmdText)) return null; // no newly-authored commit text

  let commitCwd = baseCwd;
  let commitVersionCwd = baseCwd;
  let cwdParseUnresolvable = false;
  if (baseCwd) {
    const resolved = commandCwdForGitMatch(
      cmdText,
      commitMatch[0],
      baseCwd,
      gitVerbIndex(commitMatch)
    );
    if (resolved === UNRESOLVABLE_CWD) {
      commitVersionCwd = null;
      cwdParseUnresolvable = true;
    } else if (resolved) {
      commitCwd = resolved;
      commitVersionCwd = resolved;
    }
  }

  const { readFailed, message, messages } = gitCommitMessageFromCommand(cmd, commitCwd);
  if (readFailed) {
    return {
      block: true,
      reason:
        "Commit attribution gate：commit message source read failed (missing file / size > 1MB) — blocked fail-closed because unreadable commit text could hide forbidden attribution markers.",
    };
  }
  const commitMessages = messages && messages.length > 0 ? messages : [message];
  // Footer is present and valid. Check version equality (release-integrity, F3).
  // Fail-open (D5): if the commit invocation cwd is absent/unresolvable,
  // repoRoot unresolvable, AGENTS.md missing or unparseable, or footer version
  // unparseable → null → skip equality layer. For `git -C <worktree>` and
  // hook-visible `cd <worktree> && git commit`, the commit cwd is the target
  // worktree, not the hook/base cwd.
  // This avoids false-blocking commits when AGENTS.md context is unavailable.
  const _commitRepoRoot = commitVersionCwd ? getRepoRoot(commitVersionCwd) : null;
  const _commitAgentsVer = (_commitRepoRoot && _commitRepoRoot.length > 0) ? readAgentsMdVersion(_commitRepoRoot) : null;
  // Each commit in a multi-commit invocation is validated independently; the first
  // failing arm short-circuits the whole gate (per-message logic in validateCommitMessage).
  for (const commitMessage of commitMessages) {
    const result = validateCommitMessage(commitMessage, _commitAgentsVer);
    if (result) return result;
  }
  // fix-eof-gate-cwd-blind-spot T11 (design.md D5): the version-equality layer
  // itself passed no message through validateCommitMessage's block/advisory
  // arms above, but if it was SKIPPED (repoRoot/AGENTS.md/version
  // unresolvable) while a footer declared a version, that declared version
  // was never actually verified against AGENTS.md — release-integrity data
  // going into commit metadata unchecked. Re-derive footer-presence/version
  // per message here (rather than threading this through
  // validateCommitMessage) so that function's block/advisory semantics stay
  // byte-for-byte unchanged (design.md:225 — MUST NOT alter checkCommitAttribution's
  // block semantics or asAdvisory's conversion contract).
  if (_commitAgentsVer === null) {
    for (const commitMessage of commitMessages) {
      if (attributionFooterPresent(commitMessage) && extractVersionFromFooter(commitMessage) !== null) {
        const reason = cwdParseUnresolvable
          ? NOT_CHECKED_REASONS.CWD_PARSE_UNRESOLVABLE
          : NOT_CHECKED_REASONS.VERSION_LAYER_SKIPPED;
        return { advisory: formatNotCheckedAdvisory(GATE2B_VERSION_LABEL, commitVersionCwd, reason) };
      }
    }
  }
  return null;
}

// Gate 3 (T3): Commit-Time EOF Normalize Re-stage Gate — `enforce-eof-normalize-
// at-commit`. Pushes the EOF blank-line-at-EOF self-heal that previously lived
// only in the pre-PR flow (`normalize-eof.mjs --fix`, `spec-eof-newline-grep`
// backstop) forward to the commit-time mechanical choke point: any STAGED text
// file that is EOF-dirty (per the SAME `isDirtyPerGuard()` SSOT the CLI fixer
// and grep guard use) is normalized and RE-STAGED — index-only, via
// `git update-index --cacheinfo` — never touching the working tree. This is a
// PASS-THROUGH advisory (never blocks): the commit proceeds with the cleaned
// staged content. Fail-open on ANY git/infra error (never let this gate's own
// failure block a commit — see `pre-tool-mechanical-gates`'s fail-open-on-
// uncertainty principle).
//
// Binary files are skipped (numstat `-\t-`); executable mode (100755) is
// preserved (mode read via `git ls-files --stage` before hash-object, re-applied
// via --cacheinfo); deleted files (no staged blob) are skipped.
//
// fix-eof-gate-cwd-blind-spot: this gate's staged-index read is a "class B"
// PreToolUse blind spot in two shapes — (1) a chained `git add -A && git
// commit` reads the index BEFORE `add` runs, and (2) `git -C <worktree>
// commit` / `cd <worktree> && git commit` must resolve the commit's ACTUAL
// cwd (not baseCwd). Both used to `return null` silently; every non-`--no-
// edit`/non-symlink-mode "did not check" exit now names a reason via
// `formatNotCheckedAdvisory` (T5/T8). See `GATE3_LABEL` uses below.
const GATE3_LABEL = "Commit-time EOF re-stage gate";

function checkCommitEofRestage(cmd, baseCwd) {
  try {
    const cmdText = gateCommandSegmentText(cmd);
    const commitMatch = GIT_COMMIT_RE.exec(cmdText);
    if (!commitMatch) return null; // class A: not a git commit invocation
    if (/--no-edit\b/.test(cmdText)) return null; // class A: applicability guard (D6) — no newly-authored commit text
    if (!baseCwd) {
      return { advisory: formatNotCheckedAdvisory(GATE3_LABEL, null, NOT_CHECKED_REASONS.BASE_CWD_ABSENT) };
    }

    // D2: resolve the commit's EFFECTIVE cwd the same way sibling
    // `checkCommitAttribution` does (mirrors `:2877-2889` there) — per-match,
    // in cmdText coordinate space, via the existing SSOT helper. Every
    // downstream git spawn in this function now targets THIS cwd, not
    // baseCwd, so `git -C <worktree> commit` / `cd <worktree> && git commit`
    // are checked (and re-staged) in the repo the commit actually targets.
    // The position is found on the quote-masked raw command, so a quoted `git -C "<dir with spaces>"` is read as the
    // shell reads it (PR #3703 r7 W3-F3); cmdText replaces each quoted string and loses that path.
    let commitCwd = baseCwd;
    const located = locateCommandPosition(cmd, safeSegmentCommand(cmd), GIT_COMMIT_RE);
    const resolved = located ? commandCwdForGitMatch(cmd, located.matchText, baseCwd, located.verbIndex) : UNRESOLVABLE_CWD;
    if (resolved === UNRESOLVABLE_CWD) {
      return { advisory: formatNotCheckedAdvisory(GATE3_LABEL, baseCwd, NOT_CHECKED_REASONS.CWD_PARSE_UNRESOLVABLE) };
    }
    if (resolved) commitCwd = resolved;

    if (!isSourceRepo(commitCwd)) return null; // class A: consumer repo — fail-open

    const numstatResult = spawnSync(
      "git",
      ["diff", "--cached", "--numstat", "-z"],
      { cwd: commitCwd, encoding: "utf8" }
    );
    if (numstatResult.status !== 0) {
      return { advisory: formatNotCheckedAdvisory(GATE3_LABEL, commitCwd, NOT_CHECKED_REASONS.PROBE_FAILED) };
    }
    const numstat = numstatResult.stdout || "";

    // `-z` emits NUL-delimited records. An ordinary record is
    // `<added>\t<deleted>\t<path>\0`; a rename/copy record is
    // `<added>\t<deleted>\t\0<src>\0<dst>\0` (the counts field ends with a
    // trailing tab and the two paths are the next two NUL fields). Inspect the
    // staged DESTINATION for renames (a rename may carry content edits), never
    // skip them on the ` => ` substring (which would also misfire on literal
    // filenames).
    const textFiles = [];
    const fields = numstat.split("\0");
    for (let i = 0; i < fields.length; i += 1) {
      const field = fields[i];
      if (!field) continue;
      const firstTab = field.indexOf("\t");
      if (firstTab === -1) continue;
      const secondTab = field.indexOf("\t", firstTab + 1);
      if (secondTab === -1) continue;
      const added = field.slice(0, firstTab);
      const deleted = field.slice(firstTab + 1, secondTab);
      let file;
      if (secondTab === field.length - 1) {
        // rename/copy header — destination is two NUL fields ahead.
        file = fields[i + 2];
        i += 2;
      } else {
        file = field.slice(secondTab + 1);
      }
      if (!file) continue;
      if (added === "-" && deleted === "-") continue; // binary — skip
      textFiles.push(file);
    }
    if (textFiles.length === 0) {
      // Only fire when the empty read is ATTRIBUTABLE to the PreToolUse
      // timing blind spot: a prior chained command in the SAME payload could
      // plausibly have staged content this gate cannot yet see (class B:
      // stale-index-chained-add). Absent that, a truly-empty staged set is
      // class A silent — and deliberately NOT narrowed to just `-a`/`--all`/
      // pathspec deferred-staging, because `git commit --amend -m "reword"`
      // and `git commit --allow-empty` are routine, CORRECT operations that
      // legitimately commit with nothing staged; naming every one of those
      // `staged-set-empty` would be a false positive against real usage, and
      // — since `runGateInventory` (:6392) keeps only the FIRST advisory
      // globally — a high-frequency zero-information Gate 3 advisory would
      // silently suppress the no-verify / PR-body / attribution advisories
      // that would otherwise have won that slot (R1's own named failure
      // mode: "advisory channel 被淹沒→被無視", the exact opposite of this
      // change's goal). `staged-set-empty` stays in the frozen taxonomy
      // (T5) as a documented, deliberately-silent state — not a dead token,
      // just one whose class-B trigger never legitimately fires from here.
      if (hasPriorChainedMutatingCommand(cmdText, gitVerbIndex(commitMatch), INDEX_MUTATING_VERB_RE)) {
        return { advisory: formatNotCheckedAdvisory(GATE3_LABEL, commitCwd, NOT_CHECKED_REASONS.STALE_INDEX_CHAINED_ADD) };
      }
      return null; // class A: empty index, non-chained (incl. -a/--amend/--allow-empty/pathspec)
    }

    const changedFiles = [];
    const probeFailures = [];
    for (const file of textFiles) {
      const showResult = spawnSync("git", ["show", `:${file}`], {
        cwd: commitCwd,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 64,
      });
      if (showResult.status !== 0) {
        probeFailures.push(file); // deleted / unreadable staged blob — named below, still fail-open (no block)
        continue;
      }
      const content = showResult.stdout;

      // Mode gate — MUST run before normalize. `git diff --numstat`'s `-\t-`
      // binary marker does NOT catch staged symlinks (mode 120000): a
      // symlink's blob is the raw link-target string (usually no trailing
      // newline), so numstat reports it as a normal text-like add
      // (`1\t0\tfile`) and it slips past the binary filter above. If we then
      // ran normalizeEofContent + re-staged it, we'd corrupt the symlink —
      // its blob would become the link target with an appended `\n`,
      // pointing at a nonexistent `<target>\n` filename. Gitlinks (mode
      // 160000, submodule entries) must not be touched either. Only regular
      // files (100644/100755) are eligible for EOF normalize; unresolved
      // mode is treated as ineligible too (fail-safe: better to skip a
      // normalize than corrupt a symlink/gitlink). Class A (NFR3): this is a
      // deliberate, precise whitelist, not an uncertainty gap.
      let mode = null;
      const stageResult = spawnSync("git", ["ls-files", "--stage", "--", file], {
        cwd: commitCwd,
        encoding: "utf8",
      });
      if (stageResult.status === 0 && stageResult.stdout) {
        const m = stageResult.stdout.match(/^(\d+)\s/);
        if (m) mode = m[1];
      }
      if (mode !== "100644" && mode !== "100755") continue; // symlink/gitlink/unresolved — skip

      if (!isDirtyPerGuard(content)) continue; // clean — no-op

      const normalized = normalizeEofContent(content);

      const hashResult = spawnSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: commitCwd,
        input: normalized,
        encoding: "utf8",
      });
      if (hashResult.status !== 0) {
        probeFailures.push(file); // hash-object failed — fail-open per-file, still named
        continue;
      }
      const blobHash = hashResult.stdout.trim();

      const cacheinfoResult = spawnSync(
        "git",
        ["update-index", "--cacheinfo", `${mode},${blobHash},${file}`],
        { cwd: commitCwd, encoding: "utf8" }
      );
      if (cacheinfoResult.status !== 0) {
        probeFailures.push(file); // re-stage failed — fail-open per-file, still named
        continue;
      }

      changedFiles.push(file);
    }

    if (changedFiles.length === 0) {
      // Per-file probe failures (show/hash-object/update-index) with no
      // successful re-stage at all → class B, named.
      if (probeFailures.length > 0) {
        return { advisory: formatNotCheckedAdvisory(GATE3_LABEL, commitCwd, NOT_CHECKED_REASONS.PROBE_FAILED) };
      }
      return null;
    }
    const successAdvisory = `已自動移除 staged EOF 空行並 re-stage：${changedFiles.join(", ")}（working tree 未更動）`;
    if (probeFailures.length > 0) {
      // Mixed outcome: some files succeeded, some probe-failed (cross-model
      // WARN, PR #2305 finding 3) — surface both instead of silently
      // dropping the probe-failed file names inside the success advisory.
      return {
        advisory: `${successAdvisory}；另有檔案 probe 失敗未 re-stage（reason=${NOT_CHECKED_REASONS.PROBE_FAILED}）：${probeFailures.join(", ")}`,
      };
    }
    return { advisory: successAdvisory };
  } catch {
    // Any unexpected git/infra error — fail-open (never block a commit on
    // this gate's own failure), but named per proposal.md's own grep evidence
    // table (`:3021` listed alongside the other four silent exits this
    // change targets) and D6's "其餘依 D1 formatter" accounting.
    return { advisory: formatNotCheckedAdvisory(GATE3_LABEL, baseCwd, NOT_CHECKED_REASONS.UNEXPECTED_ERROR) };
  }
}

/**
 * checkCommitAdvisories(cmd, baseCwd)
 *
 * Composite advisory gate for `git commit`. Runs the EOF re-stage gate FIRST
 * (unconditionally — its re-stage side effect must execute regardless of
 * which advisory ends up surfaced) then the attribution-footer advisory,
 * concatenating whichever fire.
 *
 * Why a composite instead of two sibling BASH_ADVISORY_GATES entries:
 * runGateInventory is first-truthy-wins, so two sibling advisory gates on the
 * same `git commit` would mutually suppress — whichever is ordered first
 * silently swallows the other (the exact `checkMergeAdvisories` L3731-3738
 * precedent this mirrors). A commit that is BOTH EOF-dirty AND missing the
 * attribution footer must surface both signals, not just one.
 *
 * Block-short-circuit invariant (by design, not a bug): when a step-1
 * BLOCKING gate (commit-attribution-brand-leak / version-mismatch) fires,
 * `checkBashCommand`'s dispatch never reaches this composite — the commit
 * does not proceed, so no re-stage side effect should run, and none does.
 *
 * @param {string} cmd
 * @param {string} baseCwd
 * @returns {{ advisory: string } | null}
 */
function checkCommitAdvisories(cmd, baseCwd) {
  const parts = [];
  const eof = checkCommitEofRestage(cmd, baseCwd);
  if (eof?.advisory) parts.push(eof.advisory);
  const footer = asAdvisory(checkCommitAttribution(cmd, baseCwd));
  if (footer?.advisory) parts.push(footer.advisory);
  if (parts.length === 0) return null;
  return { advisory: parts.join("\n\n---\n\n") };
}

// Gate 2f: production ingress is PR-only — any local `git merge` whose
// effective branch is definitely `production` is blocked, regardless of merge
// target or mode. The operator must push the relevant work/release branch and
// merge a GitHub PR whose base is `production`; the exact remote PR merge
// commit is then the only production-tag authority.
// `merge(?![\w-])` — match the `merge` subcommand but NOT `merge-base` (a
// read-only ancestry query): `\bmerge\b` alone matched the `merge` inside
// `merge-base` (the `-` is a non-word boundary), so `git merge-base ... release/X`
// was false-blocked as a release merge on production (hit during release v6.65.0).
const PRODUCTION_LOCAL_MERGE_RE =
  new RegExp(`${CMD_POSITION_ANCHOR}git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*merge(?![\\w-])[^;|&\\n]*`);

const PRODUCTION_LOCAL_MERGE_PR_ONLY_REASON =
  `production PR-only local merge gate：偵測 any local \`git merge\` 將更新 \`production\` → block。\`main\` 與 \`production\` 僅可由 PR merge 更新；merge target／mode（含 \`--no-ff\`）不構成例外。\n\nRequired path：push relevant work/release branch，開啟 base \`production\` 的 GitHub PR 並完成 merge；之後 freshly resolve and verify that PR 的 exact merge commit，再用該 explicit SHA 建立 production tag 並只 push tag ref。\n\n${HOOK_BYPASS_HINT}\n此本機 bypass 只描述 gate 能力邊界，不是核准的 release 路徑。`;

function checkProductionLocalMergeRequiresPr(cmd, branch, baseCwd) {
  // The branch this merge runs on MUST be resolved at the MERGE VERB's position,
  // not from the payload-level `branch` (which main() derives from the FIRST
  // git/gh token). Otherwise `git status ; true && cd <production> ; git merge
  // release/X` resolves the branch from the harmless leading `git status` cwd and
  // the gate misses the production merge (issue #851/#848 cross-model round 10).
  // When baseCwd is provided (the live hook path) we re-resolve per-verb; tests
  // that pass only (cmd, branch) keep the legacy payload-level behavior.
  const cmdStr = cmd.toString();
  const segs = safeSegmentCommand(cmd);
  let matched = false;
  let verbBranch = branch;
  for (const m of cmdStr.matchAll(new RegExp(PRODUCTION_LOCAL_MERGE_RE.source, "g"))) {
    if (!isMatchInCommandSegment(gitVerbIndex(m), segs)) continue;
    matched = true;
    if (baseCwd !== undefined) {
      const resolved = commandCwdForGitMatch(cmd, m[0], baseCwd, gitVerbIndex(m));
      // Fail-OPEN on uncertainty (accident-prevention threat model): if the
      // merge's cwd is unresolvable we do NOT block (a false block halts the
      // workflow); only a merge DEFINITELY on `production` is gated. issue
      // #851/#848 — reversed from the earlier UNRESOLVABLE→block stance.
      verbBranch = resolved === UNRESOLVABLE_CWD ? null : getCurrentBranch(resolved);
    }
    // Fire ONLY when the merge is definitely on `production`. Merge flags do
    // not create an exemption: no local production merge is a valid
    // promotion path, regardless of target ref class.
    if (verbBranch !== "production") continue;
    return {
      block: true,
      reason: PRODUCTION_LOCAL_MERGE_PR_ONLY_REASON,
    };
  }
  // Legacy path (no baseCwd, e.g. unit tests): fall back to the payload `branch`
  // + a segmented whole-command test. Fires only on a definite `production`
  // branch (fail-open on uncertainty, consistent with the per-verb path above).
  if (!matched && baseCwd === undefined && branch === "production") {
    const cmdText = gateCommandSegmentText(cmd);
    if (PRODUCTION_LOCAL_MERGE_RE.test(cmdText)) {
      return {
        block: true,
        reason: PRODUCTION_LOCAL_MERGE_PR_ONLY_REASON,
      };
    }
  }
  return null;
}

// Gate 2e: Hotfix base — `git checkout -b hotfix/<name> [<base>]` 與
// `git worktree add ... -b hotfix/<name> [<base>]` 必須以 production-* tag 為
// base。錯 anchor 帶入未上線 main commits → release subset 失敗 / 污染
// production（ai-autonomy.md / git-branch-naming-and-anchor.md：「hotfix 未從
// 最近 production-* tag 建」）。
//
// `<base>` 缺省 → HEAD；對 base 跑 `git tag --points-at <base> 'production-*'`
// 有 tag → pass，無 tag → block。bypass: inline DEVPRO_HOOK_BYPASS=1。
// Separator is `(?:\\s+|=)` to cover the equals form (`-b=hotfix/x`, `--create=hotfix/x`) — issue #851/#848 round 9.
const HOTFIX_CHECKOUT_RE =
  new RegExp(`${CMD_POSITION_ANCHOR}git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*checkout\\s+(?:-b|-B|--branch)(?:\\s+|=)(hotfix\\/\\S+)(?:\\s+(\\S+))?`);
// `git switch -c|-C|--create|--force-create hotfix/<name> [<base>]` (round-4
// audit B 6a — the hotfix gate previously covered only checkout/worktree).
const HOTFIX_SWITCH_RE =
  new RegExp(`${CMD_POSITION_ANCHOR}git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*switch\\s+(?:-c|-C|--create|--force-create)(?:\\s+|=)(hotfix\\/\\S+)(?:\\s+(\\S+))?`);
const HOTFIX_WORKTREE_RE =
  new RegExp(`${CMD_POSITION_ANCHOR}git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*worktree\\s+add\\s+\\S+\\s+(?:-b|-B|--branch)(?:\\s+|=)(hotfix\\/\\S+)(?:\\s+(\\S+))?`);

function hasProductionTagAt(ref, cwd) {
  const result = spawnSync("git", ["tag", "--points-at", ref, "production-*"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return !result.error && result.status === 0 && String(result.stdout ?? "").trim().length > 0;
}

/** True iff the repo has at least one local `production-*` tag (any tip). */
function hasAnyProductionTag(cwd) {
  const result = spawnSync("git", ["tag", "--list", "production-*"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return !result.error && result.status === 0 && String(result.stdout ?? "").trim().length > 0;
}

function resolveCommitSha(ref, cwd) {
  if (!ref) return null;
  const result = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return null;
  const sha = String(result.stdout ?? "").trim();
  return sha || null;
}

/**
 * First-rules-release production tip: only the remote-tracking `origin/production`.
 * A local-only `production` branch cannot prove that the GitHub PR target exists.
 * Missing remote target → null (fail closed; do NOT fall back to local production or main).
 */
function resolveFirstRulesReleaseProductionTip(cwd) {
  return resolveCommitSha("origin/production", cwd);
}

/**
 * Gate 2h narrow first-rules-release allowlist (fix-bootstrap-first-run-blockers D3):
 * zero `production-*` tags AND base SHA equals production tip SHA.
 * MUST NOT treat "zero tag → source main" as allow. Does NOT restore acknowledgement bypass.
 */
function isAllowedFirstRulesReleaseBase(base, cwd) {
  if (hasAnyProductionTag(cwd)) return false;
  const tipSha = resolveFirstRulesReleaseProductionTip(cwd);
  if (!tipSha) return false;
  const baseSha = resolveCommitSha(base, cwd);
  if (!baseSha) return false;
  return baseSha === tipSha;
}

function isReleaseRulesBaseAllowed(base, cwd) {
  if (hasProductionTagAt(base, cwd)) return true;
  return isAllowedFirstRulesReleaseBase(base, cwd);
}

// Whether the checkout that contains `cwd` is the rules source, by positive identity (hooks/lib/operation-target.mjs).
// A repository without .gitmodules is no longer assumed to be the source: a hub session writing another repository
// must apply source-only checks only when that target is the source.
function isSourceRepo(cwd) {
  return isSourceDestination(cwd);
}

function buildHotfixBaseBlockReason(branchName, base) {
  return `Hotfix base gate：\`${branchName}\` 的 base \`${base}\` 不在任何 \`production-*\` tag。hotfix 必須從最近 production-* tag 建（per AGENTS.md §0 Never + git-branch-naming-and-anchor.md），否則會帶入未上線 main commits、污染 production。\n\n建議：\`git fetch origin --tags\` 後 \`git checkout -b ${branchName} <最近 production-* tag>\`；無 tag 的 repo 退回 \`bugfix/\` flow。\n\n${HOOK_BYPASS_HINT}`;
}

function checkHotfixBaseFromProductionTag(cmd, baseCwd) {
  const cmdText = gateCommandSegmentText(cmd);
  let match = cmdText.match(HOTFIX_CHECKOUT_RE);
  if (match) {
    const branchName = match[1];
    const base = match[2] || "HEAD";
    if (!hasProductionTagAt(base, baseCwd)) {
      return { block: true, reason: buildHotfixBaseBlockReason(branchName, base) };
    }
  }
  match = cmdText.match(HOTFIX_SWITCH_RE);
  if (match) {
    const branchName = match[1];
    const base = match[2] || "HEAD";
    if (!hasProductionTagAt(base, baseCwd)) {
      return { block: true, reason: buildHotfixBaseBlockReason(branchName, base) };
    }
  }
  // worktree add: token-parse EVERY add (robust to `-b` before/after <path> +
  // `=` form; checks all occurrences, not just the first — a benign leading add
  // must not hide a later hotfix add; issue #851/#848 cross-model rounds 10+12).
  for (const { branch: branchName, base } of extractWorktreeAddCreates(cmdText)) {
    if (/^hotfix\//.test(branchName) && !hasProductionTagAt(base, baseCwd)) {
      return { block: true, reason: buildHotfixBaseBlockReason(branchName, base) };
    }
  }
  return null;
}

// Gate 2h: Release/rules source + base — `git checkout -b release/rules-<seg> [<base>]`、
// `git switch -c release/rules-<seg> [<base>]` 與
// `git worktree add <path> -b release/rules-<seg> [<base>]`：
//   1. source repo 禁建 release/rules-*；必須走 release/v<X.Y.Z> SemVer 軌。
//   2. consumer repo 必須以 production-* tag 為 base；錯 anchor 帶入未上線
//      main commits → release/rules merge 等同把 main 整包搬上線，污染
//      consumer production（per release-rules-lane.md）。
//   3. 窄首次例外（first-rules-release）：local 無任何 production-* tag 且
//      base SHA 等於 remote-tracking origin/production tip → allow。
//      local-only production 與任意 main 都不成立；不恢復 acknowledgement bypass。
//
// `<base>` 缺省 → HEAD；對 base 跑 `git tag --points-at <base> 'production-*'`
// 有 tag → pass；無 tag 時再檢查 first-rules-release allowlist；否則 block。
// source repo 一律先 block。bypass: inline DEVPRO_HOOK_BYPASS=1。
// Separator is `(?:\\s+|=)` to cover the equals form (`-b=release/rules-x`, `--create=release/rules-x`) — issue #851/#848 round 9.
const RELEASE_RULES_CHECKOUT_RE =
  new RegExp(`${CMD_POSITION_ANCHOR}git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*checkout\\s+(?:-b|-B|--branch)(?:\\s+|=)(release\\/rules-\\S+)(?:\\s+(\\S+))?`);
const RELEASE_RULES_SWITCH_RE =
  new RegExp(`${CMD_POSITION_ANCHOR}git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*switch\\s+(?:-c|-C|--create|--force-create)(?:\\s+|=)(release\\/rules-\\S+)(?:\\s+(\\S+))?`);
const RELEASE_RULES_WORKTREE_RE =
  new RegExp(`${CMD_POSITION_ANCHOR}git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*worktree\\s+add\\s+(?:"[^"]+"|'[^']+'|\\S+)\\s+(?:-b|-B|--branch)(?:\\s+|=)(release\\/rules-\\S+)(?:\\s+(\\S+))?`);

function buildReleaseRulesBaseBlockReason(branchName, base) {
  return (
    `Release/rules base gate：\`${branchName}\` 的 base \`${base}\` 不在任何 \`production-*\` tag，` +
    `且不符合零 tag 首發例外（base SHA 必須等於 remote \`origin/production\` tip；local \`production\` 與任意 main 都不成立）。` +
    `若 remote target 不存在，named blocker 為 \`production target absent\`，必須由流程外 repository administration 建立 protected、PR-capable target。` +
    `一般路徑：release/rules-* 必須從最近 production-* tag 建（per release-rules-lane.md）；` +
    `否則會帶入未上線 main commits、污染 consumer production。\n\n` +
    `建議：\n` +
    "```sh\n" +
    "ANCHOR_JSON=$(node .devpro/scripts/detect-branch-base.mjs --anchor)\n" +
    "TAG=$(printf '%s' \"$ANCHOR_JSON\" | jq -r 'select(.source==\"production-tag\") | .ref')\n" +
    "if [ -z \"$TAG\" ]; then\n" +
    "  # first-rules-release（零 production-* tag）：base=remote origin/production tip；禁 local/main fallback\n" +
    "  if git rev-parse --verify --quiet origin/production^{commit} >/dev/null; then TAG=origin/production\n" +
    "  else echo \"production target absent: repository administration must establish a protected, pull-request-capable production base\"; exit 1; fi\n" +
    "fi\n" +
    'SUFFIX="" # first rules release today; use -2, -3, ... for later same-day rules releases\n' +
    'git checkout -b "release/rules-$(date +%Y%m%d)$SUFFIX" "$TAG"\n' +
    "```\n\n" +
    `不恢復 acknowledgement bypass；有任一 production-* tag 時仍禁從 main／非 tag base 開 release/rules-*。\n\n` +
    HOOK_BYPASS_HINT
  );
}

function buildReleaseRulesSourceRepoBlockReason(branchName) {
  return (
    `Source repo release/rules gate：\`${branchName}\` 只適用 consumer repo 的 rules sync lane。` +
    `devpro-agent-rules source repo 上線必須走 SemVer 軌：\`release/v<X.Y.Z>\` → \`production-v<X.Y.Z>\`。` +
    `不得因「rules repo / rules change」字樣誤用 \`release/rules-*\`。\n\n` +
    `建議：\n` +
    "```sh\n" +
    "git checkout -b release/v<X.Y.Z> production-v<X.Y.Z-previous>\n" +
    "# finite subset: merge only the approved branches in the approved order\n" +
    "git merge --no-ff origin/<branch>\n" +
    "# full-main requires evidence: approved subset = full-main + selected main HEAD SHA\n" +
    "```\n\n" +
    HOOK_BYPASS_HINT
  );
}

function checkReleaseRulesBaseFromProductionTag(cmd, baseCwd) {
  const cmdText = gateCommandSegmentText(cmd);
  let match = cmdText.match(RELEASE_RULES_CHECKOUT_RE);
  if (match) {
    const branchName = match[1];
    const base = match[2] || "HEAD";
    if (isSourceRepo(baseCwd)) {
      return { block: true, reason: buildReleaseRulesSourceRepoBlockReason(branchName) };
    }
    if (!isReleaseRulesBaseAllowed(base, baseCwd)) {
      return { block: true, reason: buildReleaseRulesBaseBlockReason(branchName, base) };
    }
  }
  match = cmdText.match(RELEASE_RULES_SWITCH_RE);
  if (match) {
    const branchName = match[1];
    const base = match[2] || "HEAD";
    if (isSourceRepo(baseCwd)) {
      return { block: true, reason: buildReleaseRulesSourceRepoBlockReason(branchName) };
    }
    if (!isReleaseRulesBaseAllowed(base, baseCwd)) {
      return { block: true, reason: buildReleaseRulesBaseBlockReason(branchName, base) };
    }
  }
  // worktree add: token-parse EVERY add (robust to `-b` before/after <path> +
  // `=` form; all occurrences, not just first — issue #851/#848 rounds 10+12).
  for (const { branch: branchName, base } of extractWorktreeAddCreates(cmdText)) {
    if (/^release\/rules-/.test(branchName)) {
      if (isSourceRepo(baseCwd)) {
        return { block: true, reason: buildReleaseRulesSourceRepoBlockReason(branchName) };
      }
      if (!isReleaseRulesBaseAllowed(base, baseCwd)) {
        return { block: true, reason: buildReleaseRulesBaseBlockReason(branchName, base) };
      }
    }
  }
  return null;
}

// Gate 2d: Upstream pollution — block `git merge/pull main` 在非 main / master，
// 與 `git merge/pull integration` 在 `release/*`。違反會把 main / integration 上
// unrelated commits 帶進 subset / release subset，破壞 release 線
// `git merge <可促進單位>` 的乾淨挑選能力（ai-autonomy.md Never #5 + #6）。
//
// `git fetch origin main:main` 等非 merge/pull 命令不誤判；regex 對 git verb
// 嚴格 anchor，且只看同一段（split 不跨 `&&` / `;`）。
// 合法可 `merge main` 的 branch 類型：
//   - main / master：sync from origin (no-op pollution-wise)
//   - chore/bump-v*: legacy bump recovery allowance. The bump PR itself is
//     metadata-only; full validation happens after the release branch is
//     assembled with the approved change set.
//   - integration：optional DEV confidence gate receives current main.
//
// Source repo `release/v<X.Y.Z>` is a SemVer naming lane only; it is NOT an
// allowlist for whole-main release assembly. Finite releases merge only the
// approved branches (`origin/<branch>`); explicit full-main releases require
// approved subset evidence plus the documented hook-bypass path.
function isMainOrMaster(branch) {
  return branch === "main" || branch === "master";
}

function isRulesBranch(branch) {
  return /^rules\//.test(branch || "");
}

// Detect `git switch <X>` / `git checkout <X>` (literal branch arg, not a
// flag). Returns the target branch name or null. Used by chain-effective-
// branch analysis so that `git switch main && git pull main` is not flagged
// as upstream pollution (current branch at hook fire time is still the
// pre-switch branch, but the chain effectively pulls on main). Assignments in front of git are read as shell words, so
// an escaped space in a value does not hide the switch (PR #3703 r9 W2-F3).
const GIT_SWITCH_TARGET_RE =
  new RegExp(`^(?:${ENV_ASSIGNMENT_SOURCE})*(?:\\S*\\/)?git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*(?:switch|checkout)\\b(?:\\s+-(?:[A-Za-z]|-[A-Za-z-]+))*\\s+(?!-)([^\\s|&;]+)`);

// Resolve the virtual branch immediately before a specific merge/pull
// occurrence. This is stricter than payload-level chain checks: an allowed
// first `git merge main` must not mask a later `git switch release/v... &&
// git merge main` in the same Bash payload.
function chainEffectiveBranchBeforeOccurrence(cmdPrefix, currentBranch) {
  const cleanPrefix = gateCommandSegmentText(cmdPrefix || "");
  const segments = cleanPrefix.split(/(?:&&|\|\||;)/);
  let virtualBranch = currentBranch;
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    if (new RegExp(`^(?:${ENV_ASSIGNMENT_SOURCE})*cd\\b`).test(trimmed)) {
      virtualBranch = currentBranch;
      continue;
    }
    const switchMatch = trimmed.match(GIT_SWITCH_TARGET_RE);
    if (switchMatch) {
      virtualBranch = switchMatch[1];
    }
  }
  return virtualBranch;
}

function* mergePullSourceMatches(cmd, upstream) {
  const invocation = new RegExp(`${CMD_POSITION_ANCHOR}git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*(?:merge\\b(?!-)|pull\\b)`, "g");
  for (const match of cmd.matchAll(invocation)) {
    const start = match.index + match[0].length;
    const args = cmd.slice(start, findTopLevelSeparator(cmd, start));
    // Keep quoted refs, but consume option values as data. Composite tokens
    // also keep --message="words with spaces" together.
    const tokens = args.match(/(?:[^\s'"\\()]+|\\[\s\S]|"(?:[^"\\]|\\[\s\S])*"|'[^']*')+/g) ?? [];
    let valueNext = false;
    let positional = false;
    for (const raw of tokens) {
      const token = shellTokenValue(raw);
      if (valueNext) { valueNext = false; continue; }
      if (!positional && token === "--") { positional = true; continue; }
      if (!positional && /^(?:-m|--message|-F|--file|-s|--strategy|-X|--strategy-option|--into-name|--cleanup|--depth|--deepen|--shallow-since|--shallow-exclude|--negotiation-tip|-j|--jobs|--upload-pack|-o|--server-option|--filter|--refmap)$/.test(token)) {
        valueNext = true;
        continue;
      }
      if (!positional && token.startsWith("-")) continue;
      if (upstream.test(token)) { yield match; break; }
    }
  }
}

function checkUpstreamPollution(cmd, branch, baseCwd) {
  // The branch a merge/pull runs on MUST be resolved at THAT occurrence's verb
  // position, and EVERY merge/pull occurrence MUST be checked — a single
  // payload-level branch + first-match test let `git merge main ; cd <feature-wt>
  // ; git merge main` pass (the first merge on main is allowed and masked the
  // second; issue #851/#848 cross-model rounds 10+12). 2-arg test callers (no
  // baseCwd) keep the explicit `branch` for every occurrence.
  const cmdStr = cmd.toString();
  const segs = safeSegmentCommand(cmd);
  const branchAt = (m) => {
    if (baseCwd === undefined) return branch;
    const resolved = commandCwdForGitMatch(cmd, m[0], baseCwd, gitVerbIndex(m));
    return resolved === UNRESOLVABLE_CWD ? UNRESOLVABLE_CWD : getCurrentBranch(resolved);
  };
  const allowMergeMain = (b) =>
    isMainOrMaster(b) || isBumpBranch(b) || b === "integration";

  // ── merge/pull main: check EACH occurrence ──
  for (const m of mergePullSourceMatches(cmdStr, /^\+?(?:[^:]+\/)?main(?:$|[@~^:])/)) {
    if (!isMatchInCommandSegment(gitVerbIndex(m), segs)) continue;
    const b = branchAt(m);
    if (b === UNRESOLVABLE_CWD) continue; // fail-open on uncertain cwd (do NOT block)
    // Chain analysis: `git switch main && git pull main` is the canonical
    // switch-then-sync pattern; `git switch release/v... && git merge main`
    // must use release/v as the effective branch even when the hook fires from
    // main before the chain executes.
    const effectiveBranch = chainEffectiveBranchBeforeOccurrence(
      cmdStr.slice(0, gitVerbIndex(m)),
      b
    );
    if (allowMergeMain(effectiveBranch)) continue;
    if (!effectiveBranch) {
      return {
        block: true,
        reason: `Upstream pollution gate：無法從 payload 判定 branch（cwd 解析失敗）→ block。這不是「目前不在 main」，而是 hook 無法解析 \`cd\` / cwd 成可讀的 git worktree（常見於 Git Bash POSIX 路徑 \`/c/...\` 未被正規化）。請改用 Windows 路徑或 \`git switch main && git pull --ff-only origin main\`。\n\n${HOOK_BYPASS_HINT}`,
      };
    }
    if (isRulesBranch(effectiveBranch)) {
      return {
        block: true,
        reason: `Upstream pollution gate：偵測 \`git merge/pull ... main\` 在 rules branch (\`${effectiveBranch}\`) → block。consumer rules lane PR 補救禁止把 \`origin/main\` merge 進 \`rules/*\`，否則會把 main 其他 commits 混入同步分支。\n\nrules lane PR 補救：若 GitHub 顯示 PR DIRTY / CONFLICTING，保持工作樹乾淨，改用 rebase/recreate 到 \`origin/main\`，重跑 \`git submodule update --init --remote .devpro-agent-rules\`、\`node .devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs --sync\`、\`node .devpro/scripts/sync-agent-rules.mjs --check\`，再用 \`git push --force-with-lease\` 更新同一 PR branch（僅 rebase/recreate 後需要）。`,
      };
    }
    return {
      block: true,
      reason: `Upstream pollution gate：偵測 \`git merge/pull ... main\` 在非 main branch (\`${effectiveBranch}\`) → block。main 含其他 PR 的 commits，併入會污染本 branch 的 subset，release 階段 \`git merge <可促進單位>\` 將吃進不該吃的內容（ai-autonomy.md Never：「merge main → feature」）。source repo \`release/v<X.Y.Z>\` 只是 SemVer naming lane，預設也必須逐一 merge 核准分支清單裡的 approved branches（\`git merge --no-ff origin/<branch>\`）；whole-main release 需先有 approved subset = full-main、selected main HEAD SHA 與 explicit bypass evidence。\n\n如需同步 main：(1) 等對方 PR merge 後 rebase 自己的 branch；(2) 或 cherry-pick 需要的特定 commit；(3) 或先 \`git switch main\` 再 pull（同 Bash 內 \`git switch main && git pull --ff-only origin main\` chain 自動視為 main 上操作，不擋）。\n\n合法 merge main 場景：main 自身、\`chore/bump-v*\`（legacy bump recovery allowance；完整驗證在 release branch 組裝完成後）、\`integration\`（optional DEV confidence gate 合法接收 main）。\n\n${HOOK_BYPASS_HINT}`,
    };
  }

  // ── merge/pull integration: check EACH occurrence (integration is receive-
  // only-from-main; pulling FROM integration into any other branch pollutes). ──
  for (const m of mergePullSourceMatches(cmdStr, /^\+?(?:[^:]+\/)?integration(?:$|[@~^:])/)) {
    if (!isMatchInCommandSegment(gitVerbIndex(m), segs)) continue;
    const b = branchAt(m);
    if (b === UNRESOLVABLE_CWD) continue; // fail-open on uncertain cwd (do NOT block)
    const effectiveBranch = chainEffectiveBranchBeforeOccurrence(
      cmdStr.slice(0, gitVerbIndex(m)),
      b
    );
    if (effectiveBranch === "integration") continue;
    if (!effectiveBranch) {
      return {
        block: true,
        reason: `Upstream pollution gate：無法從 payload 判定 branch（cwd 解析失敗）→ block。這不是「目前不在 integration」，而是 hook 無法解析 \`cd\` / cwd。請改用 Windows 路徑或 \`git switch integration && git pull origin integration\`。\n\n${HOOK_BYPASS_HINT}`,
      };
    }
    return {
      block: true,
      reason: `Upstream pollution gate：偵測 \`git merge/pull ... integration\` 在 \`${effectiveBranch}\` → block。integration 僅允許 \`git merge main\` 接收（per release-sit-uat-pat-prod.md §integration 治理補充）；從 integration 拉出到任何其他分支（release / feature / bugfix / chore / hotfix）會混進其他單位整合內容（ai-autonomy.md Never：「merge integration → 任何非 integration 分支」）。\n\n例外：\`git switch integration && git pull origin integration\` chain 同 Bash 內視為 integration 上操作，不擋。\n\n${HOOK_BYPASS_HINT}`,
    };
  }

  return null;
}

// Gate 2c: Merge strategy — `gh pr merge --squash` / `--rebase` HARD-BLOCKS.
// 規範（git-pr-template-and-merge.md「合併策略」= merge 策略唯一規範來源）禁 squash /
// rebase merge into main 以保留可促進單位邊界。squash/rebase 壓扁/改寫該邊界 → release 線
// 無法以 `git merge <可促進單位>` 穩定納入 subset = release-integrity violation（disaster
// /release-integrity 級，per pre-tool-mechanical-gates Evidence-First），故 hard-block。
// 例外白名單空（git-pr-template-and-merge.md Exceptions）→ 等同無例外；唯一 escape 是
// inline `DEVPRO_HOOK_BYPASS=1`（main() 處理），並在 PR 描述記錄理由。
// 註：本 gate 與 cross-model sticky merge gate 互相獨立——sticky PASS/WARN 不放行 squash
// /rebase（兩個正交的 release gate）。issue #947 finding 3：由 advisory 恢復 hard-block。
function checkMergeStrategy(cmd) {
  const cmdText = gateCommandSegmentText(cmd);
  if (!GH_PR_MERGE_RE.test(cmdText)) return null;
  const hasSquash = /(?<![\w-])--squash\b/.test(cmdText);
  const hasRebase = /(?<![\w-])--rebase\b/.test(cmdText);
  if (!hasSquash && !hasRebase) return null;
  const flag = hasSquash ? "--squash" : "--rebase";
  return {
    block: true,
    reason: `Merge strategy gate：\`gh pr merge ${flag}\` 禁止——${hasSquash ? "squash" : "rebase"} merge 壓扁/改寫可促進單位邊界，破壞 release 線以 \`git merge <可促進單位>\` 納入 subset 的能力（git-pr-template-and-merge.md「合併策略」+ ai-autonomy.md Never）。\n\n改用 \`--merge\`（regular merge commit）。\n\n團隊明文例外（stacked PR 等）請用 \`DEVPRO_HOOK_BYPASS=1 gh pr merge ...\` 顯式 bypass 並在 PR 描述記錄理由。`,
  };
}

function normalizeHeadBranchName(branchName) {
  const raw = shellTokenValue(branchName || "").trim();
  if (!raw) return "";
  // `gh pr create --head owner:branch` is valid for forks. Local worktree
  // lookup can only use the branch portion.
  return raw.includes(":") ? raw.split(":").pop() : raw;
}

// D2 (enforce-hotfix-release-carrier): `--base`/`-B` and `--head`/`-H` value
// extraction for `gh pr create`, reusing the generic segment-aware flag-value
// scanner (extractFlagValues, above — already handles `"quoted"` / `'quoted'`
// / bare tokens and skips matches that fall inside a quoted-string/heredoc
// span). Last occurrence wins (mirrors how a real shell / gh CLI would treat a
// repeated flag). `null` = flag not present at all (distinct from an empty
// value), so callers can tell "not specified" (→ current-branch fallback for
// head) from "specified but unparseable" (→ fail open, per D2 point 4).
function extractGhPrCreateBaseValue(cmd) {
  const values = extractFlagValues(cmd, "--base|-B");
  return values.length > 0 ? values[values.length - 1] : null;
}

function extractGhPrCreateHeadValue(cmd) {
  const values = extractFlagValues(cmd, "--head|-H");
  return values.length > 0 ? values[values.length - 1] : null;
}

// A literal branch token contains no shell metacharacter that could expand at
// runtime to something other than its literal text. `$`/backtick covers
// `$VAR`, `${VAR}`, `$(...)`, and backtick command substitution — the same
// conservative test `containsShellExpansion` in lib/branch-naming.mjs uses
// (false negative > false positive: an ambiguous value is treated as
// non-literal, i.e. fails OPEN here rather than risk a wrong literal match).
function isLiteralHeadToken(value) {
  return typeof value === "string" && value.length > 0 && !/[$`]/.test(value);
}

function localReviewPrHeadBlockReason(head) {
  return `Local review branch \`${head}\` 僅本機驗證，禁止 push 或作為 PR head。需提交的修正請另開正常工作分支；review worktree 清理走具名 prune-merged-local.mjs --force-delete。`;
}

// Best-effort create-time check; the merge gate also checks GitHub's actual head.
// Each real create clause owns its flags and checkout, so an earlier ordinary
// create cannot mask a later review head. Quoted examples and heredocs are data.
function checkLocalReviewPrCreate(cmd, baseCwd, effectiveCwd = baseCwd) {
  const text = cmd.toString();
  const segs = safeSegmentCommand(text);
  for (const match of text.matchAll(new RegExp(GH_PR_CREATE_RE.source, "g"))) {
    const index = anchoredVerbIndex(match);
    if (!isMatchInCommandSegment(index, segs)) continue;
    const clause = text.slice(index, findTopLevelSeparator(text, match.index + match[0].length));
    const headRaw = extractGhPrCreateHeadValue(clause);
    let head;
    if (headRaw === null) {
      const cwd = baseCwd
        ? commandCwdAt(text, baseCwd, index, "gh", { tolerateRedirectsAndPipes: true })
        : effectiveCwd;
      if (!cwd || cwd === UNRESOLVABLE_CWD) continue;
      if (PRE_CREATE_BRANCH_SWITCH_RE.test(gateCommandSegmentText(text.slice(0, index)))) continue;
      head = getCurrentBranch(cwd) || "";
    } else {
      if (!isLiteralHeadToken(headRaw)) continue;
      head = normalizeHeadBranchName(headRaw);
    }
    if (head.startsWith(LOCAL_REVIEW_BRANCH_PREFIX)) {
      return { block: true, reason: localReviewPrHeadBlockReason(head) };
    }
  }
  return null;
}

/**
 * checkProductionBasePrCreate(cmd, baseCwd, effectiveCwd)
 *
 * D2 — create-time counterpart of the base=production block path inside
 * checkCrossModelMergeGate (merge-time Path BP). A `gh pr create` alone does
 * not change production — the actual promotion happens at `gh pr merge` —
 * so this gate is a best-effort EARLY fail using only shell-parseable
 * evidence; the merge-time gate (which reads the GitHub-recorded
 * `headRefName` via `gh pr view`) remains the AUTHORITATIVE fail-closed
 * enforcement for this axis (see design D2 Trade-off).
 *
 * Base resolution: `--base <v>` / `--base=<v>` / `-B <v>`. Not literally
 * `"production"` (including an unspecified base, which defaults to the repo
 * default branch, and any shell-expansion value that cannot string-equal the
 * literal `"production"`) → null (this gate does not apply).
 *
 * Head resolution: `--head <v>` / `--head=<v>` / `-H <v>` (normalizeHeadBranchName
 * handles the `owner:branch` fork form). Not specified → the current branch of the
 * checkout `gh pr create` itself runs in (`ghPrCreateCheckout`; gh CLI's own default). A non-literal head value (contains
 * `$`/backtick — e.g. the canonical production-PR recipe's
 * `--head "$RELEASE_BRANCH"`) → null (fail OPEN; see JSDoc above).
 *
 * `gh pr edit --base production` is NOT matched (GH_PR_CREATE_RE only matches
 * `gh pr create`) — retarget is an explicit Non-goal (design D2).
 *
 * @param {string} cmd
 * @param {string} baseCwd
 * @param {string} [effectiveCwd]
 * @returns {{block:true,reason:string}|null}
 */
function checkProductionBasePrCreate(cmd, baseCwd, effectiveCwd = baseCwd) {
  const cmdText = gateCommandSegmentText(cmd);
  if (!GH_PR_CREATE_RE.test(cmdText)) return null;

  const baseRaw = extractGhPrCreateBaseValue(cmd);
  const base = typeof baseRaw === "string" ? shellTokenValue(baseRaw).trim() : "";
  if (base !== "production") return null;

  const headRaw = extractGhPrCreateHeadValue(cmd);
  let head;
  if (headRaw === null) {
    // The head is the branch of the checkout `gh pr create` itself runs in. The current branch is untrustworthy
    // when that command cannot be located, its cwd is unresolvable, or an earlier checkout/switch in the same command
    // moves HEAD after PreToolUse reads it → fail open (design-core §11 axis B q2); merge stays authoritative.
    const checkout = ghPrCreateCheckout(cmd, baseCwd);
    if (checkout.index < 0 || checkout.cwd === UNRESOLVABLE_CWD) return null;
    if (checkout.index > 0 && PRE_CREATE_BRANCH_SWITCH_RE.test(cmd.slice(0, checkout.index))) return null;
    const cwd = checkout.cwd || effectiveCwd || baseCwd;
    head = getCurrentBranch(cwd) || "";
    if (!head) return null; // cannot resolve current branch → fail open
  } else {
    if (!isLiteralHeadToken(headRaw)) return null; // non-literal --head → fail open
    head = normalizeHeadBranchName(headRaw);
    if (!head) return null;
  }

  if (isBaseProductionBlockExempt(head)) return null;

  return {
    block: true,
    reason: buildBaseProductionBlockReason(head, "create"),
  };
}

const BRANCH_NAMING_RULE_REL = ".devpro/agent-rules/preflight-checklist.md";

function repoRootForBranchNamingRule(cwd) {
  const repoRoot = getRepoRoot(cwd);
  // Guard the empty-string fail-open: path.join("", REL) would be a RELATIVE
  // path that existsSync resolves against process.cwd() (a false positive). The
  // original try/catch returned null on git error — preserve that.
  if (!repoRoot) return null;
  return existsSync(path.join(repoRoot, BRANCH_NAMING_RULE_REL)) ? repoRoot : null;
}

const PROTECTED_BASE_BOOTSTRAP_BRANCHES = new Set(["production", "integration"]);

function isProtectedBaseBranchBootstrapCommand(cmd, branchName) {
  const branch = normalizeHeadBranchName(branchName);
  if (!PROTECTED_BASE_BOOTSTRAP_BRANCHES.has(branch)) return false;

  const branchLit = escapeRegexLiteral(branch);
  const gitBranchPrefix = `${CMD_POSITION_ANCHOR}git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*branch\\s+`;
  const commandBoundary = `(?=\\s|[;|&()<>\\n\\r]|$)`;
  const createFromMainRe = new RegExp(
    `${gitBranchPrefix}${branchLit}\\s+(?:main|origin\\/main)${commandBoundary}`
  );
  const trackRemoteRe = new RegExp(
    `${gitBranchPrefix}(?:--track|-t)\\s+${branchLit}\\s+origin\\/${branchLit}${commandBoundary}`
  );

  return createFromMainRe.test(cmd) || trackRemoteRe.test(cmd);
}

function checkBranchVerbWhitelist(cmd, baseCwd, effectiveCwd = baseCwd) {
  // extractAllBranchNamesFromCommand is already shell-aware: it preserves quoted
  // literal branch names but skips "$BRANCH" / command expansion. It returns EVERY
  // command-position branch-create name so a benign first create cannot mask a later
  // illegal one (e.g. `git checkout -b feature/ok && git checkout -b zzz/bad` — the
  // illegal `zzz` verb MUST still block). Issue #899 finding (a), applied to this gate.
  const rawBranchNames = extractAllBranchNamesFromCommand(cmd);
  if (!rawBranchNames || rawBranchNames.length === 0) return null;

  const candidateCwd =
    effectiveCwd && effectiveCwd !== UNRESOLVABLE_CWD
      ? effectiveCwd
      : commandCwd(cmd, baseCwd || process.cwd());
  if (!candidateCwd || candidateCwd === UNRESOLVABLE_CWD) return null;

  const repoRoot = repoRootForBranchNamingRule(resolveSafe(candidateCwd));
  if (!repoRoot) return null;

  let verbs;
  try {
    verbs = loadVerbWhitelist(repoRoot);
  } catch (e) {
    return {
      block: true,
      reason: `Branch Verb Whitelist gate：無法載入 branch 動詞白名單（${BRANCH_NAMING_RULE_REL} marker malformed）：${e.message}\n\n${HOOK_BYPASS_HINT}`,
    };
  }

  // Validate EVERY branch-create occurrence; block on the FIRST that fails.
  for (const rawBranchName of rawBranchNames) {
    const branchName = normalizeHeadBranchName(rawBranchName);
    if (!branchName) continue;
    if (isProtectedBaseBranchBootstrapCommand(cmd, branchName)) continue;
    const validation = validateBranchName(branchName, verbs, repoRoot);
    if (validation.valid) continue;
    return {
      block: true,
      reason: `Branch Verb Whitelist gate：branch \`${branchName}\` 不符合命名規則：${validation.reason}\n\n使用 \`<prefix>/<verb>-<scope>\`，verb 必須來自 ${BRANCH_NAMING_RULE_REL} 的 branch-verb-whitelist marker。若需新動詞，先改 marker 與對應測試；不得用 bypass 取代命名修正。\n\n${HOOK_BYPASS_HINT}`,
    };
  }
  return null;
}

function resolveWorktreePathForBranch(branchName, baseCwd) {
  const normalized = normalizeHeadBranchName(branchName);
  if (!normalized) return "";
  try {
    const out = execSync("git worktree list --porcelain", { cwd: baseCwd, encoding: "utf8" });
    const blocks = out.split(/\n\n+/).filter(Boolean);
    for (const block of blocks) {
      const lines = block.split("\n");
      const branchLine = lines.find((l) => l === `branch refs/heads/${normalized}`);
      if (!branchLine) continue;
      const wtLine = lines.find((l) => l.startsWith("worktree "));
      if (!wtLine) return "";
      return wtLine.slice("worktree ".length);
    }
  } catch {
    return "";
  }
  return "";
}

// Gate 3b: Archive-before-push/PR-create — spawns pre-pr-archive-gate.mjs (SSOT)
// Trigger: `git push` or `gh pr create`; fail-open if gate script is absent.
function resolveArchiveGateCwd(cmd, baseCwd, effectiveCwd) {
  const cmdText = gateCommandSegmentText(cmd);
  if (GH_PR_CREATE_RE.test(cmdText)) {
    const headBranch = extractBranchNameFromCommand(cmdText);
    const worktreePath = resolveWorktreePathForBranch(headBranch, baseCwd);
    if (worktreePath) return worktreePath;
    // No worktree named by the head: the checkout is the one gh pr create itself runs in.
    const checkout = ghPrCreateCheckout(cmd, baseCwd);
    if (checkout.index >= 0 && checkout.cwd && checkout.cwd !== UNRESOLVABLE_CWD) return checkout.cwd;
  }
  // commandCwd may now return the UNRESOLVABLE_CWD sentinel; the archive gate
  // needs a real directory to spawn in, so map the sentinel (and any falsy) to
  // baseCwd (issue #851/#848 round 9).
  const resolved = effectiveCwd || commandCwd(cmd, baseCwd);
  return resolved && resolved !== UNRESOLVABLE_CWD ? resolved : baseCwd;
}

const ARCHIVE_GATE_LABEL = "Archive-before-push gate";

/**
 * Best-effort PR# resolution for Gate 3b (WARN remediation for the
 * "carrier_class: code" cross-model finding: pre-pr-archive-gate.mjs's
 * compactness advisory previously never received a PR# to look up the
 * sidecar round_count denominator). `git push` / `gh pr create` command text
 * never carries an explicit PR# (only `gh pr merge`/`gh pr checks`/URL forms
 * do — strategies 1/2 of `_extractPrNumber`), so a naive resolve would always
 * fall through to strategy 3 (`_getCurrentBranchPrNumber`'s live `gh pr view`
 * lookup) — a network round-trip on the highest-frequency git operation, on
 * every push, even though the only thing that call's result feeds is an
 * advisory denominator lookup against a LOCAL sidecar file.
 *
 * Zero sidecars means there is no round_count for the advisory to report
 * regardless of which PR# we resolve, so the live lookup would be pure
 * waste — skip it.
 *
 * Exactly one sidecar is deliberately NOT trusted (round 5, 2026-08-31,
 * after round 2's ancestry-only check and round 3/4's ancestry+head_ref_name
 * check were each shown defeatable by a plausible real-world sequence — most
 * recently: an old PR merges, its branch is deleted, then a NEW branch is
 * created later with the SAME NAME, built on shared history that still
 * contains the old merge as an ancestor; both factors pass, so neither
 * distinguishes "this PR's own sidecar" from an old PR's leftover). No local
 * predicate can bind to "is this actually the current PR" without a live
 * lookup — that is a structural limit, not a missing check — and this value
 * is purely advisory (`printReviewLedgerCompactnessAdvisory` in
 * pre-pr-archive-gate.mjs: never blocks, silently degrades to
 * `round_count_unavailable` on any failure), so paying a live `gh pr view`
 * round-trip on every push to get it exactly right is not worth it.
 *
 * Only when local evidence is ambiguous (more than one PR has a
 * round-budget sidecar in this state dir — the live lookup is the only way
 * to disambiguate at all, trusted or not) does this fall through to the
 * live current-branch lookup, unchanged from before.
 *
 * MUST fail open: this is advisory-only plumbing for a downstream advisory
 * line, never a gate input. `_extractPrNumber` / `_getCurrentBranchPrNumber`
 * already catch every internal failure and return null, but this wrapper
 * adds a defensive outer catch anyway so a future change to either helper
 * cannot turn an advisory-plumbing failure into an archive-gate block.
 */
function resolveArchiveGatePrNumber(cmdText, archiveCwd) {
  try {
    const sidecars = listReviewRoundSidecars({ cwd: archiveCwd });
    if (sidecars.length <= 1) return null;
    const repoFlag = _extractRepoFlag(cmdText);
    return _extractPrNumber(cmdText, { repo: repoFlag, cwd: archiveCwd }) || null;
  } catch {
    return null;
  }
}

function checkArchiveBeforePushOrPRCreate(cmd, baseCwd, effectiveCwd = baseCwd) {
  const cmdText = gateCommandSegmentText(cmd);
  const isPush = GIT_PUSH_RE.test(cmdText) && !isPushDryRun(cmd);
  const isPRCreate = GH_PR_CREATE_RE.test(cmdText);
  if (!isPush && !isPRCreate) return null; // class A: not a push/pr-create
  const archiveCwd = resolveArchiveGateCwd(cmd, baseCwd, effectiveCwd);
  const gatePath = path.join(archiveCwd, ".devpro/scripts/pre-pr-archive-gate.mjs");
  // fix-eof-gate-cwd-blind-spot T10: `gate-script-absent` / `probe-failed` are
  // class B (unexpected — the caller couldn't tell "this repo hasn't synced
  // the gate script yet" from "the gate genuinely can't run right now"
  // without this signal) — but ONLY when the repo is otherwise devpro-managed
  // (has a `.devpro/` dir at all). A repo with NO `.devpro/` dir has never
  // been synced with ANY devpro tooling — the script's absence there is
  // structurally expected, not a sync gap, and this shape is pervasive across
  // this test suite's minimal bare-git fixtures (which exist to test
  // unrelated push/PR-create advisories, not the archive gate) — firing here
  // would be the same high-frequency, zero-information advisory problem as
  // `staged-set-empty` above, silently winning `runGateInventory`'s single
  // advisory slot ahead of those other gates. `status === 0` (gate ran and
  // passed) stays class A silent — that IS the expected/normal outcome, not
  // an uncertainty.
  if (!existsSync(path.join(archiveCwd, ".devpro"))) return null; // class A: not a devpro-managed repo
  if (!existsSync(gatePath)) {
    return { advisory: formatNotCheckedAdvisory(ARCHIVE_GATE_LABEL, archiveCwd, NOT_CHECKED_REASONS.GATE_SCRIPT_ABSENT) };
  }
  const archivePrNumber = resolveArchiveGatePrNumber(cmdText, archiveCwd);
  const gateArgs = archivePrNumber
    ? [gatePath, archiveCwd, "--pr", archivePrNumber]
    : [gatePath, archiveCwd];
  const r = spawnSync("node", gateArgs, { encoding: "utf8" });
  if (r.error) {
    return { advisory: formatNotCheckedAdvisory(ARCHIVE_GATE_LABEL, archiveCwd, NOT_CHECKED_REASONS.PROBE_FAILED) };
  }
  if (r.status === 0) return null; // class A: gate ran and passed
  const stderr = r.stderr || "";
  return {
    advisory:
      stderr +
      "\n\n（由 PreToolUse hook advisory 提醒；prompt 層 `/devpro:pre-pr` Step 3.6 archive 仍要求完成。B-mini 同樣適用——`openspec archive <name> -y` 對 proposal-mini.md only 仍會 move 到 archive/<date>-<name>/，不可 `archive: N/A` 自宣豁免。）\n\nPer PR #749 root cause audit；fix change: enforce-archive-gate-on-push-create.",
  };
}

// Gate: Committed-Diff Whitespace Push Gate — hard-blocks `git push` when the
// diff THIS push INTRODUCES vs `origin/main` (the 3-dot `origin/main...HEAD`
// range) contains a DEFINITE whitespace offender (trailing whitespace /
// space-before-tab / whitespace-at-EOF, the set `git diff --check` reports).
// Moves the whitespace defense FORWARD from release-time sweeps (`--range` for
// finite subsets, `--release-main <selected-main-sha>` only for explicit full-main releases) to the
// push choke point. Release-time checks remain terminal backstops, not the sole
// interception point.
//
// SCOPE — introduced-lines only, NOT full-file: the gate uses the 3-dot RANGE
// check (`origin/main...HEAD`), which flags only whitespace this push ADDS. It
// deliberately does NOT use the full-file `--changed-files` mode, because ~57
// committed files in this repo carry legacy trailing whitespace (many archived
// proposals intentionally use trailing-double-space markdown hard-breaks). A
// full-file gate would block ANY push that merely TOUCHES such a file, forcing
// unrelated legacy cleanup — a chronic false-block that violates the
// fail-open-on-cost principle. The stricter full-file / release-time sweep stays
// at the terminal backstop where a one-time full cleanup is appropriate. This
// gate's job is narrow and correct: stop NEW pollution from
// entering `main`. (Verified: this range check catches the #28ea1e21 pollution
// that caused the recurring release-time failures, while NOT blocking a push
// that only touches a legacy-dirty file without adding new whitespace.)
//
// Shares the SAME `git diff --check` core as `check-committed-diff-whitespace.mjs`
// via `hooks/lib/whitespace-gate.mjs` (a side-effect-free module) so the CLI
// and this hook cannot drift (per `pre-tool-mechanical-gates` spec).
//
// Design: fail-open on ANY infra uncertainty (same fail-open structure as
// `checkArchiveBeforePushOrPRCreate` / `checkUpstreamPollution`) — not a
// `git push` → null; `--dry-run` push → null; consumer repo (`!isSourceRepo`)
// → null; lib/spawn error → null. A DEFINITE introduced offender still
// hard-blocks — this is a repo-hygiene / release-integrity gate, not a
// protected-branch accident gate, so the `Mechanical-Gate Threat Model And
// Fail-Open On Uncertainty` fail-open principle applies only to the
// infra-uncertainty paths above.
//
// Worktree-aware, like the siblings: the check must run in the SAME repo the
// `git push` targets. A `cd <worktree> && git push` or `git -C <worktree> push`
// yields a distinct `effectiveCwd`, so the `origin/main...HEAD` range is
// evaluated in the pushing worktree — otherwise a worktree-based release
// assembly (the exact flow this gate targets) could silently miss introduced
// whitespace.
//
// Unresolvable-cwd → FAIL OPEN (not baseCwd): the entry point normalizes an
// UNRESOLVABLE effectiveCwd back to `baseCwd` for cwd-consumers but passes the
// `UNRESOLVABLE_CWD` sentinel as `branch` (see checkBashCommand caller). This
// gate can HARD-BLOCK, so it MUST NOT evaluate `origin/main...HEAD` against the
// substituted baseCwd — that could block a push the payload aimed at a DIFFERENT
// (unparseable) tree. So when `branch === UNRESOLVABLE_CWD`, fail open, honoring
// the spec's "unresolvable cwd → fail open" promise (unlike permissive
// directory-consuming gates that can safely trust the baseCwd substitution).
const COMMITTED_DIFF_WHITESPACE_RANGE = "origin/main...HEAD";

function committedDiffWhitespacePushNotChecked(reason, pushCwd = "") {
  return {
    applies: true,
    status: "not_checked",
    reason,
    pushCwd,
    range: COMMITTED_DIFF_WHITESPACE_RANGE,
  };
}

function evaluateCommittedDiffWhitespacePush(cmd, baseCwd, effectiveCwd = baseCwd, branch = null) {
  const cmdText = gateCommandSegmentText(cmd);
  const pushMatch = GIT_PUSH_RE.exec(cmdText);
  const isPush = Boolean(pushMatch) && !isPushDryRun(cmd);
  if (!isPush) return { applies: false }; // not a push, or a dry-run push

  // Genuinely unresolvable push cwd (ambiguous prefix hiding a `cd`) → fail open.
  if (branch === UNRESOLVABLE_CWD) {
    return committedDiffWhitespacePushNotChecked("effective cwd unresolved");
  }

  // Resolve the directory THIS push runs in (worktree-aware): the cwd at the position of the `git push` itself, found
  // on the quote-masked command (a quoted environment value in front of the push does not hide it), not the cwd of the
  // first `git`/`gh` command of the payload that the gate runner holds in effectiveCwd. A position that cannot be
  // found, or a cwd that cannot be resolved there, is not checked. Without a base cwd the runner's value is all there is.
  let resolvedCwd;
  if (baseCwd) {
    const located = locateCommandPosition(cmd, safeSegmentCommand(cmd), GIT_PUSH_RE);
    if (!located) return committedDiffWhitespacePushNotChecked("push position not located");
    resolvedCwd = commandCwdForGitMatch(cmd, located.matchText, baseCwd, located.verbIndex);
  } else {
    resolvedCwd = effectiveCwd || commandCwd(cmd, baseCwd);
  }
  if (!resolvedCwd || resolvedCwd === UNRESOLVABLE_CWD) {
    return committedDiffWhitespacePushNotChecked("effective cwd unresolved");
  }
  const pushCwd = resolvedCwd;

  if (!isSourceRepo(pushCwd)) {
    return {
      applies: true,
      status: "not_applicable",
      reason: "not source repo",
      pushCwd,
      range: COMMITTED_DIFF_WHITESPACE_RANGE,
    };
  }

  let result;
  try {
    // 3-dot range: only whitespace INTRODUCED by this push (vs the merge-base
    // with origin/main), not pre-existing legacy lines in touched files.
    result = checkRangeWhitespace(COMMITTED_DIFF_WHITESPACE_RANGE, pushCwd);
  } catch (err) {
    return committedDiffWhitespacePushNotChecked(
      `whitespace checker threw: ${err?.message || String(err)}`,
      pushCwd
    );
  }
  // ok=false + error set → infra uncertainty (base unresolvable / spawn error) → fail-open.
  // ok=false + no error → a DEFINITE whitespace offender in the introduced diff.
  if (!result) return committedDiffWhitespacePushNotChecked("whitespace checker returned no result", pushCwd);
  if (result.error) {
    return committedDiffWhitespacePushNotChecked(`git diff --check failed: ${result.error}`, pushCwd);
  }
  if (result.ok) {
    // D4 (fix-eof-gate-cwd-blind-spot): reclassify ONLY AFTER
    // `checkRangeWhitespace` has run and confirmed no offender in what it
    // could see — never short-circuit before it (that would silently delete
    // the hard block below for a chained payload whose range ALREADY
    // contains a real, previously-landed offender; see the T4 sentinel test).
    // A chained HEAD-mutating command positioned before this push in the SAME
    // payload (e.g. `git commit -m x && git push`) means the just-checked
    // `origin/main...HEAD` range was evaluated against a HEAD that has not
    // yet advanced to include what that chained command is about to commit —
    // `clean` here would be a false claim of "confirmed clean", not an honest
    // "didn't check".
    if (hasPriorChainedMutatingCommand(cmdText, gitVerbIndex(pushMatch), HEAD_MUTATING_VERB_RE)) {
      return committedDiffWhitespacePushNotChecked(NOT_CHECKED_REASONS.STALE_HEAD_CHAINED_COMMIT, pushCwd);
    }
    return { applies: true, status: "clean", pushCwd, range: COMMITTED_DIFF_WHITESPACE_RANGE };
  }

  return {
    applies: true,
    status: "offender",
    pushCwd,
    range: COMMITTED_DIFF_WHITESPACE_RANGE,
    output: result.output || "",
  };
}

function checkCommittedDiffWhitespacePush(cmd, baseCwd, effectiveCwd = baseCwd, branch = null) {
  const evaluation = evaluateCommittedDiffWhitespacePush(cmd, baseCwd, effectiveCwd, branch);
  if (evaluation.status !== "offender") return null;

  const offenderText = (evaluation.output || "").trimEnd();
  const reason =
    `Committed-diff whitespace push gate：本次 push 引入的 diff（\`origin/main...HEAD\`）含 whitespace 錯誤（trailing whitespace / space-before-tab / whitespace-at-EOF），已攔在 push 前（防線前移；release finite subset 用組裝後 \`--range\`，explicit full-main 才用 \`--release-main <selected-main-sha>\`，兩者都是 terminal backstop 而非唯一攔截點）：\n\n${offenderText}\n\n` +
    `修復：push 前先跑 \`git diff --check origin/main...HEAD\` 定位並修正；若是 markdown 用 trailing-double-space 做硬換行，改用 list 呈現以避免依賴行尾雙空白。\n\n${HOOK_BYPASS_HINT}`;
  return { block: true, reason };
}

function checkCommittedDiffWhitespacePushScopeAdvisory(cmd, baseCwd, effectiveCwd = baseCwd, branch = null) {
  const evaluation = evaluateCommittedDiffWhitespacePush(cmd, baseCwd, effectiveCwd, branch);
  if (evaluation.status !== "not_checked") return null;
  // FR7: the new stale-head-chained-commit reason gets a concrete remedy
  // sentence, same as every other class-B token this change introduces
  // (formatNotCheckedAdvisory's NOT_CHECKED_REMEDY map); the pre-existing
  // reason strings here (e.g. "effective cwd unresolved") predate this change
  // and keep their existing generic wording — no existing assertion depends
  // on this field being absent.
  const remedy =
    evaluation.reason === NOT_CHECKED_REASONS.STALE_HEAD_CHAINED_COMMIT
      ? ` ${NOT_CHECKED_REMEDY[NOT_CHECKED_REASONS.STALE_HEAD_CHAINED_COMMIT]}。`
      : "";
  return {
    advisory:
      // NFR6: cwd is reduced to a basename here (never the real absolute
      // path) — fixes the pre-existing `cwd=${evaluation.pushCwd}` output.
      `Committed-diff whitespace push gate effective-scope: checked=false ` +
      `range=\`${evaluation.range}\` cwd=${sanitizeAdvisoryCwd(evaluation.pushCwd)} ` +
      `reason=${evaluation.reason}. Push allowed; whitespace gate did not evaluate this push.${remedy}`,
  };
}

// ── Chore Code-Size Push Gate (chore-code-size-push) ───────────────────────
//
// Blocks a `git push` from a `chore/` lane branch (no proposal in the committed
// branch diff) whose non-test code changes exceed CHORE_CODE_SIZE_LIMIT lines
// against the merge-base with `origin/main`. Counting, path judgments and the
// push-target / remote / chain classifiers live in `hooks/lib/chore-code-size-gate.mjs`;
// the shell parsing (push clause, chained git commands, per-occurrence cwd) lives
// here because it depends on this file's segmenters.
//
// Threat model (`Mechanical-Gate Threat Model And Fail-Open On Uncertainty`):
// only a provable over-limit push blocks; every unprovable applicability
// condition fails open with a visible not-checked advisory using this gate's own
// closed reason set (`CHORE_CODE_SIZE_NOT_CHECKED`, deliberately NOT part of
// NOT_CHECKED_REASONS). `evaluate*` returns a status, `check*` blocks only on
// `over_limit`, and the scope advisory fires only on `not_checked`.
const CHORE_CODE_SIZE_BRANCH_RE = /^chore\//;
// Same pattern as `isCrossModelExempt` / `crossModelExemptionReason`
// (not shared so those bodies stay untouched).
const CHORE_CODE_SIZE_BUMP_BRANCH_RE = /^chore\/bump-v\d+\.\d+\.\d+$/;
const CHORE_CODE_SIZE_REDIRECT_TOKEN_RE = REDIRECT_TOKEN_RE;
const CHORE_CODE_SIZE_REDIRECT_OPERATOR_ONLY_RE = REDIRECT_OPERATOR_ONLY_RE;
function stripChoreCodeSizeRedirects(tokens) {
  const kept = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (!CHORE_CODE_SIZE_REDIRECT_TOKEN_RE.test(tokens[i])) {
      kept.push(tokens[i]);
    } else if (CHORE_CODE_SIZE_REDIRECT_OPERATOR_ONLY_RE.test(tokens[i])) {
      i += 1;
    }
  }
  return kept;
}
// One evaluation per payload ctx, shared by the blocking runner and the
// composite advisory runner.
const choreCodeSizeEvaluations = new WeakMap();

function choreCodeSizeNotChecked(reason, pushCwd = "") {
  return { applies: true, status: "not_checked", reason, pushCwd };
}

// The explicit remote of a push whose flags are already known to be target-neutral.
function explicitRemoteFromPushTokens(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === "-o") {
      i += 1;
      continue;
    }
    if (!tokens[i].startsWith("-")) return tokens[i];
  }
  return undefined;
}

// Every `git <verb>` command positioned before the push, in raw-cmd coordinates,
// in the shape `classifyChain` takes.
function choreCodeSizeChainCommands(cmd, segs, pushIndex, baseCwd, pushCwd, pushRepoRoot) {
  const verbRe = new RegExp(`${TOKEN_ANCHOR}${GIT_WITH_C}([A-Za-z][\\w-]*)`, "g");
  const commands = [];
  for (const match of cmd.matchAll(verbRe)) {
    const verbIndex = gitVerbIndex(match);
    if (verbIndex >= pushIndex) continue;
    if (!isMatchInCommandSegment(verbIndex, segs)) continue;
    const argsStart = match.index + match[0].length;
    const args = stripChoreCodeSizeRedirects(
      shellStatementTokens(cmd.slice(argsStart, findTopLevelSeparator(cmd, argsStart)))
    );
    const cwd = commandCwdForGitMatch(cmd, match[0], baseCwd, verbIndex);
    const sameCwd =
      cwd !== UNRESOLVABLE_CWD && (cwd === pushCwd || getRepoRoot(cwd) === pushRepoRoot);
    commands.push({ verb: match[1], args, sameCwd });
  }
  return commands;
}

function computeChoreCodeSizePush(cmd, baseCwd, effectiveCwd, branch) {
  const cmdText = gateCommandSegmentText(cmd);
  if (!GIT_PUSH_RE.test(cmdText) || isPushDryRun(cmd)) return { applies: false };
  const segs = safeSegmentCommand(cmd);
  const pushMatch = [...cmd.matchAll(new RegExp(GIT_PUSH_RE.source, "g"))].find((m) =>
    isMatchInCommandSegment(gitVerbIndex(m), segs)
  );
  if (!pushMatch) return { applies: false };

  // Step 2: the directory this push occurrence really runs in.
  const fallbackCwd = effectiveCwd && effectiveCwd !== UNRESOLVABLE_CWD ? effectiveCwd : baseCwd;
  if (branch === UNRESOLVABLE_CWD) {
    return choreCodeSizeNotChecked(CHORE_CODE_SIZE_NOT_CHECKED.CWD_UNRESOLVED, fallbackCwd);
  }
  const pushIndex = gitVerbIndex(pushMatch);
  const pushCwd = commandCwdForGitMatch(cmd, pushMatch[0], baseCwd, pushIndex);
  if (pushCwd === UNRESOLVABLE_CWD) {
    return choreCodeSizeNotChecked(CHORE_CODE_SIZE_NOT_CHECKED.CWD_UNRESOLVED, fallbackCwd);
  }
  const repoRoot = getRepoRoot(pushCwd);
  if (!repoRoot) {
    return choreCodeSizeNotChecked(CHORE_CODE_SIZE_NOT_CHECKED.CWD_UNRESOLVED, pushCwd);
  }

  // Steps 3-4: class A (silent) unless a source repo on a chore lane branch.
  const notApplicable = { applies: true, status: "not_applicable", pushCwd };
  if (!isSourceRepo(pushCwd)) return notApplicable;

  // Step 3.5: a branch switch before the push makes the current branch say
  // nothing about what is pushed, so it is checked before the branch test.
  if (hasBranchSwitchVerb(gateCommandSegmentText(cmd.slice(0, pushIndex)))) {
    return choreCodeSizeNotChecked(CHORE_CODE_SIZE_NOT_CHECKED.CHAINED_COMMAND_UNSUPPORTED, pushCwd);
  }
  const currentBranch = getCurrentBranch(pushCwd);
  if (
    !currentBranch ||
    !CHORE_CODE_SIZE_BRANCH_RE.test(currentBranch) ||
    CHORE_CODE_SIZE_BUMP_BRANCH_RE.test(currentBranch)
  ) {
    return notApplicable;
  }

  // Step 5: several push clauses cannot be tied to one branch.
  const clauses = gitPushClauseSlices(cmd, segs);
  if (clauses.length >= 2) {
    return choreCodeSizeNotChecked(CHORE_CODE_SIZE_NOT_CHECKED.PUSH_TARGET_UNPROVEN, pushCwd);
  }

  // Steps 6-7: does the push provably include the current branch?
  const configRead = readGitConfigList({ cwd: pushCwd });
  if (!configRead.ok) {
    return choreCodeSizeNotChecked(CHORE_CODE_SIZE_NOT_CHECKED.GIT_PROBE_FAILED, pushCwd);
  }
  const clause = clauses[0] || "";
  const clauseMatch = GIT_PUSH_RE.exec(clause);
  const tokens = stripChoreCodeSizeRedirects(
    shellStatementTokens(
      clauseMatch ? clause.slice(clauseMatch.index + clauseMatch[0].length) : ""
    )
  );
  const target = classifyPushTarget({ tokens, currentBranch, config: configRead.config });
  if (target.status !== "counts") {
    return choreCodeSizeNotChecked(CHORE_CODE_SIZE_NOT_CHECKED.PUSH_TARGET_UNPROVEN, pushCwd);
  }

  // Step 8: git commands chained before the push.
  const chain = classifyChain(
    choreCodeSizeChainCommands(cmd, segs, pushIndex, baseCwd, pushCwd, repoRoot)
  );
  if (chain.mode === "unsupported") {
    return choreCodeSizeNotChecked(CHORE_CODE_SIZE_NOT_CHECKED.CHAINED_COMMAND_UNSUPPORTED, pushCwd);
  }
  const chained = chain.mode === "chained-commit";

  // Step 9: counting base.
  const base = resolveMergeBase({ repoRoot });
  if (!base.ok) return choreCodeSizeNotChecked(base.reason, pushCwd);

  // Step 10: an amend on top of the merge-base rewrites the counting base.
  if (chained && chain.amend) {
    const head = resolveHeadSha({ repoRoot });
    if (!head.ok) return choreCodeSizeNotChecked(CHORE_CODE_SIZE_NOT_CHECKED.GIT_PROBE_FAILED, pushCwd);
    if (head.sha === base.mergeBase) {
      return choreCodeSizeNotChecked(CHORE_CODE_SIZE_NOT_CHECKED.AMEND_REWRITES_MERGE_BASE, pushCwd);
    }
  }

  // Steps 11-13: committed diff, proposal exemption, size.
  const committed = countCommitted({ repoRoot, mergeBase: base.mergeBase });
  if (!committed.ok) {
    return choreCodeSizeNotChecked(CHORE_CODE_SIZE_NOT_CHECKED.GIT_PROBE_FAILED, pushCwd);
  }
  // Same exemption input the merge gate uses (#3333): per-file statuses decide whether a
  // proposal path of ANOTHER change is only an in-place edit, so both gates classify alike.
  const statusRead = readCommittedStatuses({ repoRoot, mergeBase: base.mergeBase });
  if (!statusRead.ok) {
    return choreCodeSizeNotChecked(CHORE_CODE_SIZE_NOT_CHECKED.GIT_PROBE_FAILED, pushCwd);
  }
  const exemptionInput = toExemptionInput(statusRead.entries);
  if (!isChoreAClassExempt(currentBranch, exemptionInput.files, exemptionInput.statuses)) {
    if (!chained) return notApplicable;
    // Chained commit: a proposal is evidence only when it is committed and the
    // index and work tree still equal HEAD (design D7).
    const proposalPaths = exemptionInput.files.filter((f) =>
      isChoreAProposalEvidence(currentBranch, f, exemptionInput.statuses.get(f))
    );
    const untouched = findUntouchedPaths({ repoRoot, paths: proposalPaths });
    if (!untouched.ok) {
      return choreCodeSizeNotChecked(CHORE_CODE_SIZE_NOT_CHECKED.GIT_PROBE_FAILED, pushCwd);
    }
    if (untouched.untouched.length > 0) return notApplicable;
  }
  const counted = chained
    ? estimateChained({
        repoRoot,
        mergeBase: base.mergeBase,
        includeUntracked: chain.includeUntracked,
      })
    : committed;
  if (!counted.ok) {
    return choreCodeSizeNotChecked(CHORE_CODE_SIZE_NOT_CHECKED.GIT_PROBE_FAILED, pushCwd);
  }
  const mode = chained ? "chained-commit" : "plain";
  if (counted.total <= CHORE_CODE_SIZE_LIMIT) {
    return { applies: true, status: "within_limit", pushCwd, total: counted.total, mode };
  }
  const resolved = resolveEffectiveRemote({
    explicitRemote: explicitRemoteFromPushTokens(tokens),
    currentBranch,
    config: configRead.config,
  });
  return {
    applies: true,
    status: "over_limit",
    pushCwd,
    repoRoot,
    branch: currentBranch,
    mergeBase: base.mergeBase,
    remote: resolved.remote,
    total: counted.total,
    top: topFiles(counted.entries, 5),
    mode,
  };
}

function evaluateChoreCodeSizePush(cmd, baseCwd, effectiveCwd = baseCwd, branch = null, memoKey = null) {
  const memoable = memoKey !== null && typeof memoKey === "object";
  if (memoable && choreCodeSizeEvaluations.has(memoKey)) return choreCodeSizeEvaluations.get(memoKey);
  let evaluation;
  try {
    evaluation = computeChoreCodeSizePush(cmd, baseCwd, effectiveCwd, branch);
  } catch {
    // Unexpected exception: fail open, visibly.
    evaluation = choreCodeSizeNotChecked(
      CHORE_CODE_SIZE_NOT_CHECKED.GATE_ERROR,
      effectiveCwd && effectiveCwd !== UNRESOLVABLE_CWD ? effectiveCwd : baseCwd
    );
  }
  if (memoable) choreCodeSizeEvaluations.set(memoKey, evaluation);
  return evaluation;
}

function buildChoreCodeSizeBlockReason(evaluation) {
  const { branch, repoRoot, mergeBase, remote, total, top, mode } = evaluation;
  const chained = mode === "chained-commit";
  const change = deriveChangeNameFromBranch(branch);
  const counting = describeCountingBase({ repoRoot, mergeBase });
  const alreadyPushed = remote ? remoteTrackingRefExists({ repoRoot, remote, branch }) : false;
  const fileLines = top.map((e) => `  ${e.path}  +${e.added} -${e.deleted}`);
  const exitB = alreadyPushed
    ? `(b) 本分支已在 \`${remote}\` 上：不要改名重推；改開新分支＋新 PR，或走 (a)。`
    : `(b) 純重構、無行為變更：第一次 push 前執行 git branch -m ${branch} feature/${change} 再 push（形狀仍是 A、免 OpenSpec；PR 改走第二意見；僅限尚未 push 過）。`;
  return [
    `Chore code-size push gate：\`${branch}\` 沒有本 change 的 proposal，非測試程式碼新增加刪除共 ${total} 行，超過 chore/ 輕量車道上限 ${CHORE_CODE_SIZE_LIMIT} 行（計法見 chore-classification.md §計數定義）。`,
    `計數基準：origin/main ${counting.originMainShort ?? "(未知)"}（${counting.originMainDate ?? "日期未知"}），merge-base ${counting.mergeBaseShort ?? "(未知)"}${chained ? "；串 commit 估算" : ""}`,
    `前 ${top.length} 大檔案：`,
    ...fileLines,
    "擇一處理：",
    `(a) 有行為變更：在本分支補 openspec/changes/${change}/proposal-mini.md 或 proposal.md 並 commit 後再 push（形狀照 chore-classification.md 判斷表）。`,
    exitB,
    ...(chained
      ? [
          "",
          "此數字是串接 commit 的估算，通常會多算、少數情形（路徑限定 commit、部分 hunk 暫存／提交）也可能少算；把 commit 與 push 分開（兩次 Bash 呼叫）可得精確數字。proposal 只認已 commit 且未被改動的版本，要走 (a) 請先 commit proposal 再 push。",
        ]
      : []),
    "",
    "計數以本機 origin/main 為基準；若它過舊（分支含有比它新的 main 提交，或分支疊在尚未合併的分支上），會把別人的改動算進來——先單獨執行 `git fetch origin` 更新基準後重試；堆疊分支請改以 proposal 或 feature/ 前綴處理。",
    "",
    HOOK_BYPASS_HINT,
  ].join("\n");
}

function checkChoreCodeSizePush(cmd, baseCwd, effectiveCwd = baseCwd, branch = null, memoKey = null) {
  const evaluation = evaluateChoreCodeSizePush(cmd, baseCwd, effectiveCwd, branch, memoKey);
  if (evaluation.status !== "over_limit") return null;
  return { block: true, reason: buildChoreCodeSizeBlockReason(evaluation) };
}

function checkChoreCodeSizePushScopeAdvisory(cmd, baseCwd, effectiveCwd = baseCwd, branch = null, memoKey = null) {
  const evaluation = evaluateChoreCodeSizePush(cmd, baseCwd, effectiveCwd, branch, memoKey);
  if (evaluation.status !== "not_checked") return null;
  const remedy = CHORE_CODE_SIZE_NOT_CHECKED_REMEDY[evaluation.reason] || "";
  // `base-unresolved` names the range it tried (design-core "base 不可解").
  const attempted =
    evaluation.reason === CHORE_CODE_SIZE_NOT_CHECKED.BASE_UNRESOLVED ? " base=origin/main...HEAD" : "";
  return {
    advisory:
      `Chore code-size push gate effective-scope: checked=false ` +
      `cwd=${sanitizeAdvisoryCwd(evaluation.pushCwd)} reason=${evaluation.reason}${attempted}. ` +
      `Push allowed; chore 車道程式碼行數這次沒有檢查。${remedy}。`,
  };
}

function prCreateWorkflowAdvisory(cmdText) {
  if (!GH_PR_CREATE_RE.test(cmdText)) return null;
  const missingBaseHint =
    !/--base\s+\S/.test(cmdText) && !/--draft\b/.test(cmdText)
      ? "⚠️ `gh pr create` 未明指 `--base`。建議顯式指定 base branch（main / production / stacked PR base）。\n\n"
      : "";
  return (
    missingBaseHint +
    "⚠️ 對位 `dev-flow-checklist.md` 階段 3（pre-PR：前置檢／Testing-QA／簡化／Scenario Walkthrough／六軸審查／3.6 spec-freeze archive gate／3.7 openspec validate）與階段 4（PR：一次 push → 建 PR → CI watch 至終態並回報 → review threads）——確認兩階段對應項已完成再建 PR。"
  );
}

function gitPushWorkflowAdvisory(cmd, cmdText) {
  if (!GIT_PUSH_RE.test(cmdText) || isPushDryRun(cmd)) return null;
  return "⚠️ 對位 `dev-flow-checklist.md` 階段 3.6（spec-freeze archive 須在首次 push/PR 之前完成，非先 push 後補）與階段 4（PR：push 後建 PR → CI watch 至終態並回報 → review threads）——確認 archive 已在本次 push 前完成。";
}

function checkPushOrPrCreateAdvisories(cmd, baseCwd, effectiveCwd = baseCwd, branch = null, ctx = null) {
  const parts = [];
  const cmdText = gateCommandSegmentText(cmd);
  const whitespaceScope = checkCommittedDiffWhitespacePushScopeAdvisory(
    cmd,
    baseCwd,
    effectiveCwd,
    branch
  );
  if (whitespaceScope?.advisory) parts.push(whitespaceScope.advisory);

  const choreCodeSizeScope = checkChoreCodeSizePushScopeAdvisory(cmd, baseCwd, effectiveCwd, branch, ctx);
  if (choreCodeSizeScope?.advisory) parts.push(choreCodeSizeScope.advisory);

  const archiveGate = asAdvisory(checkArchiveBeforePushOrPRCreate(cmd, baseCwd, effectiveCwd));
  if (archiveGate?.advisory) parts.push(archiveGate.advisory);

  if (parts.length === 0) return null;

  const prWorkflow = prCreateWorkflowAdvisory(cmdText);
  if (prWorkflow) parts.push(prWorkflow);

  const pushWorkflow = gitPushWorkflowAdvisory(cmd, cmdText);
  if (pushWorkflow) parts.push(pushWorkflow);

  return { advisory: parts.join("\n\n---\n\n") };
}

// ── Local-Test Gate Merge Evidence ──────────────────────────────────────────
//
// checkLocalTestGateOnMerge(cmd, baseCwd, deps = {})
//
// Hard-block gate triggered by `gh pr merge <PR#>`. When the PR diff touches
// code/規範載體 files in a source repo, requires ONE of three acceptable
// local-test evidence forms bound to the PR headRefOid (design.md D1,
// fix-merge-gate-regression-currency):
//   (1) exact-head receipt — `findAcceptableLocalTestReceipt` unchanged:
//       a main-checkout `notes/qa-regression-head-*.json` whose `head_sha`
//       equals headRefOid and whose `suite_evidence` is
//       { status:"pass", fail:0, digest_sha256:<64hex> }. Change-agnostic
//       (D8) — checked FIRST so it stays cheap and change-mapping-independent.
//   (2) bookkeeping tip-move receipt — `evaluateLocalTestTipMoveReceipt`
//       (regression-head-record.mjs): the mapped change's receipt names an
//       ancestor of headRefOid whose delta to head is R6-bookkeeping-only,
//       and still carries merge-acceptable `suite_evidence`. A currency
//       judgement only (D7) — never suite evidence for the PR head itself.
//   (3) head-bound seal-final FinalEvidenceRecord — verified INSIDE a
//       bounded, shell-less child process (`runFinalEvidenceVerifierChild`,
//       hooks/lib/final-evidence-merge-verifier.mjs, design D4/D5). This hook
//       process itself never imports the evidence façade and never reads or
//       parses the record — any verifier failure (spawn error, timeout, heap
//       exhaustion, signal, non-zero exit, malformed/oversized output, a
//       verdict naming a different change or head, or a record over the
//       verifier byte budget) just makes form (3) not satisfied.
// Forms (2) and (3) both require the PR head branch to map to a change:
// `change = parseBranchName(headRefName).body`, requiring `isValidChangeName`
// (D2). When the mapping fails, forms (2)/(3) fail closed while form (1)
// remains sufficient (release/* branches, which never map, still merge via
// form (1) — required for release-merge compatibility, D8).
//
// Background: source CI workflows have been retired (removed in two stages:
// commit 4b093361, then 9977afb9 `remove-source-ci-workflows`). The local-test
// gate is the sole mechanical test enforcement path. Elevating from advisory
// to an operator-attested head-bound receipt raises the bar above verbal
// "suite is green" claims. Digests are still operator-supplied (not yet
// mechanically rebound to suite logs) — treat as attested evidence, not
// log-verified proof. A FinalEvidenceRecord digest is likewise a payload
// self-hash proving internal consistency, not provenance/a signature.
//
// Design: fail-open on missing PR# / diff-fetch error / cross-repo `--repo`
// (return null — no block). Invalid/missing headRefOid after carrier
// detection → hard-block (cannot verify evidence). Pure docs/change-folder /
// consumer .gitmodules → null. `deps.finalEvidenceVerifier` (`{ entry,
// budget }`) exists ONLY for in-process test injection into
// `runFinalEvidenceVerifierChild`; the dispatcher registration below always
// calls this function with exactly two arguments, so production always uses
// the real entry/budget (no env seam to redirect either).

/**
 * Glob patterns that identify code and spec-carrier files.
 * A PR diff matching ANY of these patterns triggers the local-test evidence gate.
 *
 * Exclusion of `openspec/changes/**` and other pure-docs paths is implicit:
 * none of those paths match the patterns below, so `.some()` returns false
 * and the gate is suppressed (no-wolf-cry for doc-only PRs).
 */
const CODE_CARRIER_GLOBS = [
  "**/*.mjs",
  "**/*.test.mjs",
  ".devpro/agent-rules/**/*.md",
  "openspec/specs/**/*.md",
  ".claude/agents/**/*.md",
  ".claude/commands/**/*.md",
  ".devpro/scripts/hooks/**",
];

/**
 * Evidence hard gate: block merge of a code/rule-carrier PR unless a
 * head-bound suite_evidence receipt records fail=0.
 *
 * @param {object} cmd   — raw tool input (same shape as other gate functions)
 * @param {string} baseCwd — base working directory
 * @returns {{ block: true, reason: string } | null}
 */
/**
 * True when `--repo`/`-R` names a different GitHub slug than cwd's origin.
 * (`_resolveGithubOwnerRepo` is the shared `git-utils.mjs` `resolveGithubOwnerRepo`.)
 * Missing origin slug with an explicit `--repo` also counts as cross-repo
 * (cannot prove same-repo receipt binding) → caller fail-opens.
 */
function _isCrossRepoLocalTestMergeTarget(repoFlag, cwd) {
  if (!repoFlag || typeof repoFlag !== "string") return false;
  const named = splitRepoArg(repoFlag);
  const local = _resolveGithubOwnerRepo(cwd);
  if (!local || !named || (named.host && named.host !== "github.com")) return true;
  return local.toLowerCase() !== named.slug.toLowerCase();
}

/**
 * Map a PR head branch to an OpenSpec change name (design D2):
 * `change = parseBranchName(headRefName).body`, requiring `isValidChangeName`.
 * Forms (2)/(3) need this mapping; form (1) (exact-head receipt) does not.
 *
 * @param {string} headRefName
 * @returns {{ change: string, reason: null } | { change: null, reason: string }}
 */
function _mapPrHeadBranchToChange(headRefName) {
  const name = typeof headRefName === "string" ? headRefName.trim() : "";
  if (!name) {
    return { change: null, reason: "PR headRefName 缺失" };
  }
  const parsed = parseBranchName(name);
  if (!parsed.ok) {
    return {
      change: null,
      reason: `headRefName \`${name}\` 無法辨識 branch prefix（${parsed.reason}）`,
    };
  }
  if (!isValidChangeName(parsed.body)) {
    return {
      change: null,
      reason: `headRefName \`${name}\` 的 body \`${parsed.body}\` 不是合法 change 名稱`,
    };
  }
  return { change: parsed.body, reason: null };
}

/**
 * Human-readable reason form (2) — bookkeeping tip-move — was not satisfied
 * (design D9). `tipMove` is `evaluateLocalTestTipMoveReceipt`'s return value,
 * or `null` when it never ran (unmapped change).
 */
function _describeTipMoveNotSatisfied(tipMove) {
  if (!tipMove) return "change 無法對應，未嘗試 bookkeeping tip-move receipt";
  const bits = [`kind=${tipMove.kind}`];
  if (tipMove.testedSha) bits.push(`tested sha \`${tipMove.testedSha}\``);
  if (Array.isArray(tipMove.blocked) && tipMove.blocked.length > 0) {
    bits.push(`非 bookkeeping delta path：${tipMove.blocked.slice(0, 5).join("、")}`);
  }
  if (tipMove.kind === "stale" && (!tipMove.blocked || tipMove.blocked.length === 0)) {
    bits.push("若本機缺 PR head object，請先 `git fetch origin <headRefName>` 再重試");
  }
  if (tipMove.kind === "not-bookkeeping-tip-move" && tipMove.verdictKind === "current") {
    bits.push("該 receipt 名字上等同 exact-head，但已由 (1) 判定 suite_evidence 不合格，tip-move 形不接受 kind: current");
  }
  return bits.join("；");
}

/**
 * Human-readable reason form (3) — head-bound FinalEvidenceRecord — was not
 * satisfied (design D9). `verifierResult` is `runFinalEvidenceVerifierChild`'s
 * return value, or `null` when it never ran (unmapped change).
 */
function _describeVerifierNotSatisfied(verifierResult) {
  if (!verifierResult) return "change 無法對應，未嘗試 FinalEvidenceRecord verifier";
  switch (verifierResult.failure_kind) {
    case "verifier-input-invalid":
      return `verifier 輸入無效（${verifierResult.reason}）`;
    case "verifier-timeout":
      return `verifier process 逾時（${verifierResult.timeoutMs}ms 內未完成）`;
    case "verifier-signal":
      return `verifier process 被訊號終止（${verifierResult.signal}）`;
    case "verifier-spawn-failed":
      return `verifier process 無法啟動（${verifierResult.reason}）`;
    case "verifier-output-overflow":
      return "verifier process 輸出超過上限";
    case "verifier-output-malformed":
      return "verifier process 輸出格式不符合嚴格 verdict schema（含 change／head 回聲不符）";
    case "verifier-exit-nonzero":
      return `verifier process 以非 0 結束（status=${verifierResult.status}）`;
    case "verifier-budget-exceeded":
      return (
        `FinalEvidenceRecord 超過 verifier byte budget（上限 ${verifierResult.maxRecordBytes} bytes）——` +
        `即使 seal-final 已封存該紀錄，也需改用 exact-head receipt 補救（見下方步驟 1、2），而非重跑 seal-final`
      );
    case "verifier-rejected":
      return `verifier 拒絕該紀錄（${verifierResult.reason}）`;
    default:
      return "找不到綁定該 head 的合法 FinalEvidenceRecord";
  }
}

/**
 * Assembles the `[Local-Test Gate]` block reason (design D9) once none of
 * the three evidence forms is satisfied.
 */
function _buildLocalTestGateBlockReason({ prNumber, headRefOid, change, mappingReason, tipMove, verifierResult }) {
  const changeLine = change
    ? `change=\`${change}\`（由 PR headRefName 對應）`
    : `無法由 headRefName 對應 change（${mappingReason}）`;
  return (
    `[Local-Test Gate] PR #${prNumber} diff 命中 code/規範載體檔案，但三種可接受的本機測試證據皆未成立。\n\n` +
    `可接受的證據形（任一即可）：\n` +
    `  (1) exact-head receipt：main-checkout \`notes/qa-regression-head-*.json\`，\`head_sha\` 等於 PR headRefOid \`${headRefOid}\` 且 \`suite_evidence.status==="pass"\`／\`fail===0\`（change-agnostic）。\n` +
    `  (2) 同 change 的 bookkeeping tip-move receipt：\`notes/qa-regression-head-<change>.json\` 綁定的 tested sha 是 PR head 的祖先，且 tested..head 只含 R6 bookkeeping allowlist 內的 delta、receipt 的 \`suite_evidence\` 為 pass／fail=0（僅判 currency，不是 PR head 的 suite 證據）。\n` +
    `  (3) PR head 上同 change 的 seal-final FinalEvidenceRecord：\`notes/review-<change>-final-evidence-${headRefOid}.json\`，經有界 verifier process 驗證通過。\n\n` +
    `對應結果：${changeLine}\n\n` +
    `(1) 未滿足：找不到綁定 head \`${headRefOid}\` 且 suite_evidence.status==="pass"／fail===0 的 operator-attested regression-head receipt。\n` +
    `(2) 未滿足：${_describeTipMoveNotSatisfied(tipMove)}\n` +
    `(3) 未滿足：${_describeVerifierNotSatisfied(verifierResult)}\n\n` +
    `補救：\n` +
    `  1. node .devpro/scripts/run-test-suite.mjs --changed main\n` +
    `  2. node .devpro/scripts/record-regression-head.mjs --change <name> --suite-status pass --suite-fail 0 --suite-digest <digest from suite log>\n` +
    `  3. 或依 \`/devpro:pre-pr\` §Post-Ledger Final Evidence Gate 在 PR head 執行 seal-final。\n\n` +
    `（receipt 寫入 main-checkout \`notes/qa-regression-head-<name>.json\`；head_sha 必須等於此 PR 的 headRefOid \`${headRefOid}\`。digest 為操作者自 suite log 抄錄之 attested 欄位，尚未機械對回 log；FinalEvidenceRecord digest 為 payload 自我雜湊，用以證明內部一致性，不是簽章、也不可宣稱不可偽造。）\n\n` +
    `背景：source CI workflows 已退役，local-test gate（三形任一）為唯一測試防線。\n\n` +
    `${HOOK_BYPASS_HINT}`
  );
}

function checkLocalTestGateOnMerge(cmd, baseCwd, deps = {}) {
  // Step 0: source-repo only (issue #1204). The remediation steers the agent to
  // `node .devpro/scripts/run-test-suite.mjs --changed main` — the source repo's
  // local test gate. In a consumer business repo (has .gitmodules)
  // that path is the rules submodule's own tests, NOT the consumer's tests
  // (e.g. `dotnet test`), so the gate is misleading there. CODE_CARRIER_GLOBS
  // includes `openspec/specs/**/*.md`, a legitimate consumer capability-spec
  // carrier, which is exactly what false-fired in consumer PR #384.
  if (!isSourceRepo(baseCwd)) return null;

  // Step 1: shell-aware command text
  const cmdText = gateCommandSegmentText(cmd);

  // Step 2: only intercept `gh pr merge ...`
  if (!GH_PR_MERGE_RE.test(cmdText)) return null;

  // Step 3: the repository and PR cross-repo-pr-merge bound, else the repo flag and PR# (fail-open if absent)
  const repoFlag = deps.bound?.repo ?? _extractRepoFlag(cmdText);
  const prNumber = deps.bound?.pr ?? _extractPrNumber(cmdText, { repo: repoFlag, cwd: baseCwd });
  if (!prNumber) return null; // fail-open: cannot determine PR#

  // Step 3b: cross-repo `--repo` → fail-open. Receipts live under *this* cwd's
  // main-checkout notes/ and cannot bind a foreign PR headRefOid.
  // A bound merge's evidence checkout is already that repository's checkout, so its receipt is always checked
  // (PR #3703 r7 W2-F2).
  if (!deps.bound && _isCrossRepoLocalTestMergeTarget(repoFlag, baseCwd)) return null;

  // Step 4: fetch changed files (fail-open on any error)
  let changedFiles;
  try {
    changedFiles = _getPrChangedFiles(prNumber, baseCwd, repoFlag);
  } catch {
    return null; // fail-open: diff fetch failed
  }

  return checkLocalTestEvidence({ prNumber, prData: _runGhPrView(prNumber, { repo: repoFlag, cwd: baseCwd }), changedFiles, baseCwd, deps });
}

function checkLocalTestEvidence({ prNumber, prData, changedFiles, baseCwd, deps = {} }) {
  if (!isSourceRepo(baseCwd)) return null;
  // Step 5: check if any changed file matches a code/spec-carrier glob.
  // Exclude node_modules/ paths — dependency files are never project carriers
  // (doc/code drift guard: CODE_CARRIER_GLOBS[0] = "**/*.mjs" must not fire on
  // node_modules/pkg/index.mjs; the glob has no negative-lookahead, so we apply
  // the exclusion here at the match site).
  const regexes = CODE_CARRIER_GLOBS.map(globToRegex);
  const hasCodeCarrier = changedFiles
    .filter((file) => !file.includes("node_modules/"))
    .some((file) => regexes.some((re) => re.test(file)));
  if (!hasCodeCarrier) return null; // pure docs / change-folder → no fire

  // Step 6: fetch PR head; invalid headRefOid → cannot verify evidence → block
  const headRefOid =
    typeof prData?.headRefOid === "string" ? prData.headRefOid.trim() : "";
  if (!REGRESSION_HEAD_SHA_RE.test(headRefOid)) {
    return {
      block: true,
      reason:
        `[Local-Test Gate] PR #${prNumber} headRefOid 無效或缺少（值: ${JSON.stringify(headRefOid)}），無法核對 local-test suite_evidence receipt。\n\n` +
        `請確認 gh CLI 可取得 PR head，或改用明確的 \`gh pr merge <PR#> --repo github.com/OWNER/REPO\` 後重試。\n\n` +
        `${HOOK_BYPASS_HINT}`,
    };
  }

  // Step 7a: exact-head receipt (form 1), unchanged and change-agnostic
  // (design D1/D8) — checked first so existing exact-head fixtures (T2b,
  // CMX-5) resolve before any git/child-process work, and release/* branches
  // (which never map to a change) still merge via this form.
  const found = findAcceptableLocalTestReceipt({ cwd: baseCwd, headSha: headRefOid });
  if (found.ok) return null;

  // Step 7b: map the PR head branch to a change (design D2). Forms (2)/(3)
  // fail closed together when this mapping fails; form (1) above is
  // unaffected.
  const prHeadRefName =
    typeof prData?.headRefName === "string" ? prData.headRefName.trim() : "";
  const { change, reason: mappingReason } = _mapPrHeadBranchToChange(prHeadRefName);

  let verifierResult = null;
  let tipMove = null;

  if (change) {
    // Step 7c: head-bound FinalEvidenceRecord (form 3), verified inside a
    // bounded child process (design D4/D5) — this hook process never reads
    // or parses the record itself.
    verifierResult = runFinalEvidenceVerifierChild({
      repoRoot: baseCwd,
      changeId: change,
      headSha: headRefOid,
      ...(deps.finalEvidenceVerifier || {}),
    });
    if (verifierResult.satisfied) return null;

    // Step 7d: bookkeeping tip-move receipt (form 2, design D3).
    tipMove = evaluateLocalTestTipMoveReceipt({ cwd: baseCwd, change, headSha: headRefOid });
    if (tipMove.ok) return null;
  }

  return {
    block: true,
    reason: _buildLocalTestGateBlockReason({
      prNumber,
      headRefOid,
      change,
      mappingReason,
      tipMove,
      verifierResult,
    }),
  };
}

/**
 * checkCrossModelExemptionNotice(cmd, cwd)
 *
 * ADVISORY companion to checkCrossModelMergeGate. When a `gh pr merge` targets a
 * PR that is cross-model EXEMPT, the blocking gate passes silently (returns null
 * so it does not short-circuit the state-update / advisory inventories). This
 * advisory then fires from the advisory inventory and emits a NON-BLOCKING notice
 * naming WHY the PR was exempt — so the user is always told the PR skipped
 * cross-model review (was not second-model reviewed) instead of a silent pass.
 *
 * Rationale: the diff-shape exemption (chore/* with no own proposal*.md) is a
 * coarse approximation. A PR that edits a normative rule / enforcement gate /
 * near-cap design leaf but happens to carry no proposal would otherwise merge
 * unreviewed AND unnoticed. This closes the transparency gap (not the exemption
 * itself — the exemption still passes; the user is just informed).
 *
 * Fail-open throughout (mirrors local-test carrier detection fail-open): any
 * extraction/fetch failure → null (no advisory). Non-exempt PRs → null (the
 * blocking gate handles them via sticky checks).
 *
 * @param {string} cmd
 * @param {string} cwd
 * @returns {{ advisory: string } | null}
 */
function checkCrossModelExemptionNotice(cmd, cwd, bound) {
  const cmdText = gateCommandSegmentText(cmd);
  if (!CROSS_MODEL_GH_PR_MERGE_RE.test(cmdText)) return null;

  const repoFlag = bound?.repo ?? _extractRepoFlag(cmdText);
  const prNumber = bound?.pr ?? _extractPrNumber(cmdText, { repo: repoFlag, cwd });
  if (!prNumber) return null; // fail-open: cannot determine PR#

  const prData = _runGhPrView(prNumber, { repo: repoFlag, cwd });
  if (!prData) return null; // fail-open: gh unavailable
  const prHeadRefName =
    typeof prData.headRefName === "string" ? prData.headRefName.trim() : "";

  // Only speak when the PR is actually exempt; non-exempt PRs are the blocking
  // gate's responsibility (sticky checks), not this advisory's.
  let reason = branchPatternCrossModelExemptionReason(prHeadRefName, cwd);
  if (!reason) {
    let exemptionInput;
    try {
      exemptionInput = toExemptionInput(_getPrChangedFileEntries(prNumber, cwd, repoFlag));
    } catch {
      return null; // fail-open: diff fetch failed
    }
    const prBaseRefName = typeof prData.baseRefName === "string" ? prData.baseRefName.trim() : "";
    reason = crossModelExemptionReason(prHeadRefName, exemptionInput.files, cwd, exemptionInput.statuses, prData.headRefOid, prBaseRefName);
  }
  if (!reason) return null;

  return {
    advisory: `Cross-Model Merge Gate：PR #${prNumber} 命中豁免，**未經第二模型 cross-model review**。\n\n豁免原因：${reason}\n\n此為非阻擋提醒——merge 可繼續。若此 PR 實質風險較高（例如改 normative 規範、enforcement gate、或近 cap 的設計守則），建議先手動 \`/devpro:cross-review ${prNumber}\` 補做第二意見再 merge。`,
  };
}

/**
 * checkMergeAdvisories(cmd, cwd)
 *
 * Composite advisory gate for `gh pr merge`. Currently only the cross-model
 * exemption notice (local-test was elevated to a state-backed BLOCK gate —
 * `local-test-merge-evidence` — and MUST NOT live here as advisory-only).
 *
 * Kept as a named composite so future non-blocking merge notices can concatenate
 * without re-opening first-truthy-wins suppression between sibling advisories.
 *
 * @param {string} cmd
 * @param {string} cwd
 * @returns {{ advisory: string } | null}
 */
function checkMergeAdvisories(cmd, cwd, bound) {
  const parts = [];
  const exemption = checkCrossModelExemptionNotice(cmd, cwd, bound);
  if (exemption?.advisory) parts.push(exemption.advisory);
  if (parts.length === 0) return null;
  return { advisory: parts.join("\n\n---\n\n") };
}

// Gate 4 records merge intent. Direct gh reads have no marker side effects.
export function mergeMarkerMetadata(cmdText, fallbackBranch, cwd, bound) {
  const repoFlag = bound?.repo ?? _extractRepoFlag(cmdText);
  const prNumber = bound?.pr ?? (_extractPrNumber(cmdText, { repo: repoFlag, cwd }) || "");
  // A bound merge never borrows the session branch from a different checkout.
  const fallback = bound ? "" : fallbackBranch;
  const prData = prNumber ? _runGhPrView(prNumber, { repo: repoFlag, cwd }) : null;
  const headRefName = typeof prData?.headRefName === "string" ? prData.headRefName.trim() : "";
  const baseRefName = typeof prData?.baseRefName === "string" ? prData.baseRefName.trim() : "";
  return {
    branch: headRefName || fallback,
    prNumber,
    headRefName: headRefName || fallback,
    baseRefName,
    repo: bound?.repo ?? "",
  };
}

export function recapMergedPr(cmd, cwd) {
  const clauses = _realGhPrClauses(cmd, GH_PR_MERGE_RE);
  if (clauses.length !== 1) return {error: 'the merge command does not select one PR'};
  const {prNumber, target, targetArg, error} = _resolvePrMergeTarget(clauses[0]);
  if (error || !prNumber) return {error: 'cannot verify the merge PR selector'};
  const view = _runGhPrView(prNumber, {repo: targetArg, cwd, includeUrl: true});
  if (view?.state !== 'MERGED') return null;
  const repo = recapRepositoryFromPrUrl(view.url, prNumber);
  const branch = typeof view.headRefName === 'string' ? view.headRefName.trim() : '';
  if (!branch || (!repo && (view.url || target)) ||
      (target && !_sameRepository(target, {host: 'github.com', slug: repo.slice('github.com/'.length)}))) {
    return {error: 'the confirmed merge does not match the repository and PR selector'};
  }
  return {branch, prNumber, repo};
}

// A push writes no post-merge marker (fix-unknown-push-reminder-repeat). Which repository and branches a push writes cannot
// be read from the command before it runs: options, expansions and an earlier step of the same command (a `git remote
// set-url`, a config change) all change it (#3704 r5). A marker of an unknown repository could only be reminded, never
// cleared by the CI query it asks for, so it told the agent nothing; tracking CI after a push is left to
// git-workflow-tracking.md. Recording the remote branches a push wrote is a later change.
// Markers are stored with the session (`stateCwd`, the hook's own working directory), never in the checkout a `cd` in the
// command moves to, so a hub session keeps the obligations of every repository it works on in one place
// (fix-cross-repo-state-keys). `commandCwd` is the checkout the command runs in.
function updateMarkers(cmd, branch, { stateCwd = process.cwd(), commandCwd: runCwd = stateCwd, bound } = {}) {
  const cmdText = gateCommandSegmentText(cmd);
  if (!GH_PR_MERGE_RE.test(cmdText)) return;
  // Read the PR using the checkout bound to the merge and keep the
  // marker in the session's state. Recap has its own outcome handling.
  const marker = mergeMarkerMetadata(cmdText, branch, bound?.evidenceCwd ?? runCwd, bound);
  writePostmergeMarker(marker.branch, "merge", {
    cwd: stateCwd,
    repo: marker.repo,
    prNumber: marker.prNumber,
    headRefName: marker.headRefName,
    baseRefName: marker.baseRefName,
  });
}

// Gate 4b — Recap body canonical structure lint ───────────────────────────
// Trigger: Bash tool + cmd contains createDiscussion(input: or updateDiscussion(input:
// Body file extraction: preferred `body=@<file>` plus legacy
// `body="$(cat <file>)"` and `body=$(cat <file>)`.
// Fail-open: if body file path cannot be extracted, do not block.
// Bypass: inline DEVPRO_HOOK_BYPASS=1 (handled in main() for Bash payloads).
const CREATE_OR_UPDATE_DISCUSSION_RE =
  /(?:createDiscussion|updateDiscussion)\(input:/;
const CREATE_DISCUSSION_RE = /createDiscussion\(input:/;
// Global variant for position-aware matching (matchAll) — used to confirm the
// mutation token appears OUTSIDE a heredoc-body / comment segment (i.e. it is a
// real gh-api argument, not file content being written by a `cat >`/`node`
// heredoc). Kept separate from the non-global `.test()` regex above to avoid
// shared-lastIndex statefulness.
const CREATE_OR_UPDATE_DISCUSSION_RE_G =
  /(?:createDiscussion|updateDiscussion)\(input:/g;

// Real `gh api` command verb at a command position (not inside a quoted string /
// heredoc body / comment). Used to gate Gate 4b: the createDiscussion /
// updateDiscussion trigger token ALWAYS lives inside a quoted GraphQL `-f query=`
// argument, so it cannot be segment-filtered directly (that would strip the
// legitimate signal — see PR #1183 cross-model). Instead we require the mutation
// token to co-occur with a real `gh api` verb in the command segment: a heredoc
// or `cat >`/`node` payload that merely CONTAINS `createDiscussion … gh api …`
// has no `gh api` at a command position, so the gate does not false-fire.
const GH_API_RE = new RegExp(`${CMD_POSITION_ANCHOR}gh\\s+api\\b`);

// Body file path from a gh body flag. Covers both flag spellings (`-F` and its
// long form `--field`) and both file-load forms (round-4 audit B 15a/15b):
//   - `body="$(cat <path>)"` / `body=$(cat <path>)`
//   - `body=@<path>` (gh's idiomatic @file form)
const BODY_FILE_RE =
  /(?:-F|--field)\s+body=(?:(?:"|')?\$\(cat\s+(\S+?)\)(?:"|')?|@("[^"]+"|'[^']+'|\S+))/;

// Title flag value from a gh title flag. Covers `-F title=<v>` and `--field title=<v>`.
// Captures the quoted or unquoted value (including values with spaces if quoted).
const TITLE_FLAG_RE =
  /(?:-F|--field)\s+title=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/;

function recapBodyFileFromCommand(cmd, cwd, segments) {
  const match = firstCommandSegmentMatch(cmd, BODY_FILE_RE, segments);
  if (!match) return '';
  const rawPath = match[1] || shellTokenValue(match[2] || '');
  return path.resolve(cwd, rawPath);
}

export function recapTitleFromCommand(cmd, segments = safeSegmentCommand(cmd)) {
  const match = firstCommandSegmentMatch(cmd, TITLE_FLAG_RE, segments);
  return shellTokenValue(match?.[1] || '').trim();
}

export function readRecapBodyFromCommand(cmd, cwd, segments = safeSegmentCommand(cmd)) {
  const file = recapBodyFileFromCommand(cmd, cwd, segments);
  if (file) return readFileSync(file, 'utf8');
  const bodyFlag = /(?:-F|-f|--field|--raw-field)\s+body=("(?:[^"\\]|\\.)*"|'[^']*'|\S*)/;
  const match = firstCommandSegmentMatch(cmd, bodyFlag, segments);
  if (!match && !firstCommandSegmentMatch(cmd, /(?:^|\s)--input(?:[=\s]|$)/, segments)) return '';
  const token = match?.[1];
  if (token === undefined || (!token.startsWith("'") && /[$`\\]/.test(token))) throw new Error('unreadable Recap body');
  const body = shellTokenValue(token);
  if (body.startsWith('@')) throw new Error('unreadable Recap body file');
  return body;
}

export function recapChangeNameFromCanonicalTitle(titleValue) {
  const match = titleValue.match(/^\[[^\]]+\] ([^\n\r]+) \d{4}-\d{2}-\d{2}$/);
  return match?.[1] || "";
}

function recapBodyLintScriptPath() {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../recap-body-template-check.mjs"
  );
}

function recapTitleCheckScriptPath() {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../recap-title-check.mjs"
  );
}

function checkRecapBodyLint(cmd, baseCwd, payload = {}) {
  // Only trigger on createDiscussion / updateDiscussion mutations. The mutation
  // token ALWAYS lives inside a quoted GraphQL `-f query='…createDiscussion…'`
  // argument, so it CANNOT be segment-filtered directly — gateCommandSegmentText
  // replaces the quoted query with __QUOTED__ and would strip the legitimate
  // signal on the canonical recap command (session-recap.md), silently disabling
  // the gate (PR #1183 cross-model false-negative). Three guards distinguish a
  // real recap mutation from text that merely mentions it:
  //   (1) the mutation token matches on the raw cmd (keeps the quoted-query
  //       trigger), AND
  //   (2) a real `gh api` verb is present at a command position (GH_API_RE over
  //       gateCommandSegmentText) — a `cat >`/`node` heredoc with no real gh api
  //       does not fire, AND
  //   (3) the mutation token appears OUTSIDE a heredoc-body / comment segment —
  //       i.e. it is a real gh-api argument (quoted-string or command), not file
  //       content being written. This closes the mixed-edge where the token sits
  //       in a heredoc body while an UNRELATED real `gh api` runs in the same
  //       compound command (PR #1183 cross-model Suggestion).
  // Path/title extraction below stays on the raw cmd so a body file argument
  // elsewhere in a compound command is still captured.
  if (!CREATE_OR_UPDATE_DISCUSSION_RE.test(cmd)) return null;
  if (!GH_API_RE.test(gateCommandSegmentText(cmd))) return null;
  const _recapSegs = safeSegmentCommand(cmd);
  let _mutationInArg = false;
  for (const _mt of cmd.matchAll(CREATE_OR_UPDATE_DISCUSSION_RE_G)) {
    const _seg = segmentContaining(_mt.index, _recapSegs);
    const _kind = _seg ? _seg.kind : "command";
    if (_kind !== "heredoc-body" && _kind !== "comment") { _mutationInArg = true; break; }
  }
  if (!_mutationInArg) return null;

  // Extract body file path from `-F/--field body="$(cat <file>)"` or `body=@<file>`.
  // Body text may itself document `-F body=@...`; only command-segment flags are
  // carriers.
  const bodyFilePath = recapBodyFileFromCommand(cmd, baseCwd, _recapSegs);
  let bodyAdvisory = null;
  if (bodyFilePath) {
    const result = spawnSync(
      "node",
      [recapBodyLintScriptPath(), "--body-file", bodyFilePath],
      { encoding: "utf8" }
    );
    if (result.status === 2) {
      bodyAdvisory = `Recap body file unreadable: ${bodyFilePath}`;
    } else if (result.status !== 0) {
      const lintStderr = (result.stderr || "").trim();
      bodyAdvisory =
        `Recap body lint gate: ${bodyFilePath} 違反 canonical 結構\n` +
        `${lintStderr}\n\n` +
        `per session-recap.md §Template（copy-paste-ready）`;
    }
  }

  // Title lint — only runs when body file was successfully extracted (recap signal reliable).
  // Fail-open: if title cannot be extracted or spawn fails for any reason except exit 1,
  // do not produce a title advisory (never block).
  let titleAdvisory = null;
  let identityAdvisory = null;
  const titleValue = recapTitleFromCommand(cmd, _recapSegs);
  if (titleValue && bodyFilePath) {
    const titleScript = recapTitleCheckScriptPath();
    const titleResult = spawnSync(
      "node",
      [titleScript, "--title", titleValue],
      { encoding: "utf8" }
    );
    if (titleResult.status === 1) {
      const titleStderr = (titleResult.stderr || "").trim();
      titleAdvisory =
        `Recap title format gate: title 不符 canonical 格式\n` +
        `${titleStderr}`;
    }
  }
  const changeName = recapChangeNameFromCanonicalTitle(titleValue);
  if (changeName && CREATE_DISCUSSION_RE.test(cmd)) {
    let body;
    try {
      body = readRecapBodyFromCommand(cmd, baseCwd, _recapSegs);
    } catch {
      identityAdvisory = 'Recap PR identity: cannot read the Discussion body. The pending Recap was kept.';
    }
    if (body) {
      const titlePr = titleValue.match(/\(PR #(\d+)/)?.[1];
      const identity = resolveRecapDiscussionIdentity(body, changeName, {titlePr});
      if (identity.error) identityAdvisory = `Recap PR identity: ${identity.error}. The pending Recap was kept.`;
      else markRecapCreationStartedForChange(changeName, {
        cwd: baseCwd, session: resolveReminderSession(payload), ...identity,
      });
    }
  }

  const parts = [bodyAdvisory, titleAdvisory, identityAdvisory].filter(Boolean);
  return parts.length ? { advisory: parts.join("\n\n") } : null;
}

// Gate 4c — PR body canonical structure lint ──────────────────────────────
// Trigger: Bash tool + cmd contains `gh pr create` (not view/merge/edit).
// Body file extraction: `--body-file <path>` / its short alias `-F <path>`
// (gh pr create canonical forms, per git-pr-template-and-merge.md §Attribution footer) plus
// BODY_FILE_RE (`gh api` raw-field form `-F body=@<file>` and
// `-F body="$(cat <file>)"`).
// The consumer evidence check runs first (lite/full) for every create clause.
// Generic template lint stays fail-open: inline `--body "<text>"` or any form whose file path cannot be
// extracted → return null (skip). Body file unreadable → unreadable advisory
// (non-blocking). Template / override-disclosure failure on body-file → BLOCK
// (early-fail at PR write; fix-silent-gate-skip R7).

// Flag regex for `gh pr create` body-file forms. `gh pr create` exposes the
// body file via the long flag `--body-file <path>` AND its official short alias
// `-F <path>` (`gh pr create --help`: `-F, --body-file file`). Both must be
// captured here. The negative lookahead `(?!\S*=)` excludes the `gh api` raw-
// field form `-F body=@<file>` / `-F title=<v>` (a `key=value` field, handled
// by BODY_FILE_RE) so a `-F <key>=<value>` argument is never mis-read as a bare
// body-file path. Bare `-F <path>` (no `=`) is the create shorthand and IS
// captured.
const PR_BODY_FILE_FLAG_RE =
  /(?:--body-file|-F)\s+(?!\S*=)("[^"]+"|'[^']+'|\S+)/;

function prBodyLintScriptPath() {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../pre-pr-body-template-check.mjs"
  );
}

// Two paths name the same directory (symlinks resolved); a path that cannot be resolved counts as different.
function samePhysicalDirectory(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

// The description a `gh pr create` / `gh pr edit` clause sets: `present` is true when the clause carries a body flag,
// `body` the text, or null when it cannot be read (stdin, expansion, unreadable file). `readCwd` resolves a relative body file.
function extractGhPrBodyArgument(clause, readCwd) {
  const fileValues = extractFlagValues(clause, "--body-file|-F");
  const inlineValues = extractFlagValues(clause, "--body|-b");
  let body = null;
  if (fileValues.length) {
    const raw = fileValues.at(-1);
    if (raw && raw !== "-" && !/[$`]/.test(raw)) {
      try { body = readFileSync(path.resolve(readCwd, raw), "utf8"); } catch { /* actionable block by the caller */ }
    }
  } else if (inlineValues.length) {
    // Existing extraction understands quoted literal strings; expanded body text
    // cannot be proven here and should use the supported body-file recipe.
    const token = firstCommandSegmentMatch(clause, /(?:--body|-b)(?:=|\s+)("[^"]*"|'[^']*'|\S+)/, safeSegmentCommand(clause));
    if (token && (token[1].startsWith("'") || !/[$`]/.test(token[1]))) body = inlineValues.at(-1);
  }
  return { present: fileValues.length > 0 || inlineValues.length > 0, body };
}

// Consumer evidence shares Gate 4c, including inline bodies. It never executes
// the consumer instructions or claims the summary proves they ran.
// The shell forms the shared cwd arithmetic resolves to the unresolvable sentinel (pre-tool-mechanical-gates (1)).
// A gh pr create or gh pr edit block for an unresolved checkout names them, so the writer does not suspect the path or
// branch (#3560).
const UNFOLLOWED_CD_FORMS = "the hook does not follow a cd inside ( … ), { … } or backticks, a cd to a shell variable or $( … ), or a cd before || or a background &";
// The waiver edit gate also follows a literal cd inside one leading ( … ) subshell that holds the gh pr edit.
const UNFOLLOWED_EDIT_CD_FORMS = "the hook follows a cd only at the top level or inside one leading ( … ) subshell that holds the gh pr edit; it does not follow a cd inside { … }, backticks, a nested or later ( … ), a cd to a shell variable or $( … ), or a cd before || or a background &";
const PR_CHECKOUT_RECIPE = "Use the intended local checkout: cd <checkout> && gh pr create --head <checked-out-branch> --body-file <absolute-body-file>, or without cd: DEVPRO_PR_CHECKOUT=<absolute-checkout> gh pr create --repo <owner/repo> --head <branch> --body-file <absolute-body-file>.";

function headRawOf(clause) {
  const raw = extractGhPrCreateHeadValue(clause);
  return raw === null ? null : shellTokenValue(raw).trim();
}

function checkConsumerPrBody(cmd, checkout) {
  const blocked = (detail) => ({ block: true, reason: `Consumer pre-PR checks gate: ${detail}\n${PR_CHECKOUT_RECIPE} Read consumer-pre-pr-checks.md and record the checks result in ## Test Evidence.` });
  if (checkout.declared?.error) return blocked(checkout.declared.error);
  if (checkout.index < 0 || !checkout.cwd || checkout.cwd === UNRESOLVABLE_CWD) {
    return blocked(`PR checkout cannot be resolved before the shell runs (${UNFOLLOWED_CD_FORMS}); do not validate a different checkout`);
  }
  let cwd = checkout.cwd;
  // Inspect only this create clause; flags on another command do not name this PR.
  const clause = cmd.slice(checkout.index, findTopLevelSeparator(cmd, checkout.index));
  const repos = extractFlagValues(clause, "--repo|-R");
  if (repos.some(isShellExpandedToken)) return blocked("--repo/-R is written as a shell variable or command substitution; the hook decides before the shell expands it, so write the literal owner/repo");
  const repo = repos.at(-1) ?? process.env.GH_REPO;
  // A repository override must identify this checkout before source exemption.
  const prefix = gateCommandSegmentText(cmd.slice(0, checkout.index));
  if (/\bGH_REPO\s*=/.test(gateCommandSegmentText(cmd.slice(checkout.prefixStart ?? 0, checkout.index)))) return blocked("command-local GH_REPO override cannot be bound to this checkout; use --repo <owner/repo>");
  // A create that DEVPRO_CROSS_REPO_PR authorizes and that declares no DEVPRO_PR_CHECKOUT is remote-only: the command
  // checkout is not the PR's repository, so nothing is judged against it. The repository and the head must be written
  // as literals, because the hook neither searches for a checkout of the target nor infers the head (design D5).
  // A declared checkout never takes this branch: the declared contract below applies to it with or without a marker.
  // The shared judgement joins line continuations, so it can see a declaration this clause scan cannot
  // (`DEVPRO_PR_CHECKOUT=<dir> \<newline> gh pr create`); either reader seeing one keeps the branch closed.
  // A target with the command checkout's own slug never takes it either, whatever the hosts: that pull request may
  // belong to this checkout, so its evidence stays judged here (review r2).
  const authorized = checkout.declared ? null : crossRepoPrAuthorization(cmd, checkout.baseCwd).find((entry) => entry.verb === "create" && entry.index === checkout.index && entry.authorized && !entry.declared && !entry.ownSlug);
  if (authorized) {
    if (authorized.repoValues.length === 0) return blocked("a create authorized by DEVPRO_CROSS_REPO_PR must write its repository as a literal --repo/-R <owner/repo>; an inherited or command-local GH_REPO is not read for it");
    const markerHead = headRawOf(clause);
    if (markerHead === null || !isLiteralHeadToken(markerHead)) return blocked("a create authorized by DEVPRO_CROSS_REPO_PR must write a literal --head <branch>; the hook does not infer the head from any checkout");
    if (markerHead.includes(":")) return blocked("--head owner:branch (a fork head) is not authorized by DEVPRO_CROSS_REPO_PR; use a branch of the target repository");
    return null;
  }
  // gh itself still runs in the session cwd: a declared checkout needs the repository and head that go with it (#3556).
  // An inherited GH_REPO does not count: the declared form names its repository in the command itself.
  if (checkout.declared && repos.length === 0) return blocked("DEVPRO_PR_CHECKOUT also needs --repo/-R <owner/repo> of that checkout; without it gh creates the PR in the repository of the session cwd");
  if (repo && (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo) ||
      repo.toLowerCase() !== _resolveGithubOwnerRepo(cwd)?.toLowerCase())) {
    return blocked("--repo/-R or GH_REPO does not identify this local checkout");
  }
  const head = headRawOf(clause);
  if (checkout.declared && (head === null || !isLiteralHeadToken(head))) return blocked("DEVPRO_PR_CHECKOUT also needs a literal --head <branch>; without it gh takes the branch of the session cwd");
  // gh reads a relative body file from the session cwd while the checks read the declared checkout, so they could see two files.
  if (checkout.declared && extractFlagValues(clause, "--body-file|-F").some((raw) => raw !== "-" && !path.isAbsolute(raw))) {
    return blocked("a --body-file with DEVPRO_PR_CHECKOUT must be an absolute path; gh reads a relative path from the session cwd, not from the declared checkout");
  }
  let state = consumerPrePrChecksState(cwd);
  // A declared checkout still has its --head verified below, also for a source repository.
  if (state.source && !checkout.declared) return null;
  const switched = PRE_CREATE_BRANCH_SWITCH_RE.test(prefix);
  if ((head !== null && !isLiteralHeadToken(head)) || switched) return blocked("PR head cannot be resolved before shell execution");
  if (head !== null) {
    const branch = spawnSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" });
    if (branch.status !== 0) return blocked("Git PR branch query failed");
    if (head !== branch.stdout.trim()) {
      // Resolve within this repository, never from the runner's unrelated cwd.
      const target = head.includes(":") ? "" : resolveWorktreePathForBranch(head, cwd);
      if (!target) return blocked("--head does not identify a checked-out local worktree; check out the intended branch first");
      cwd = target;
      state = consumerPrePrChecksState(cwd);
      if (state.source) return null;
    }
  }
  if (state.source) return null;
  if (state.error) return blocked(state.error);
  const blockedDev = (detail) => ({ block: true, reason: `DEV deploy-verify gate: ${detail}\nRepository identity: ${state.identity} (${state.evidence}); only a positive source identity is exempt, and unknown follows the consumer rules.\n${PR_CHECKOUT_RECIPE} Read pre-pr-dev-verification.md and record the DEV decision in ## Test Evidence.` });

  const { body } = extractGhPrBodyArgument(clause, checkout.cwd);
  if (state.applicable) {
    if (body === null) return blocked("applicable consumer body is unreadable or cannot be extracted");
    const error = consumerPrePrEvidenceError(body);
    if (error) return blocked(error);
  }
  // A rules-lane sync head needs no DEV line (#3529); the head is --head, else the branch checked out here.
  const prBranch = head ?? spawnSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).stdout?.trim();
  const rulesLane = isRulesLaneSyncPrHead(prBranch, checkoutRepoIdentity(cwd).root);
  if (!rulesLane) {
    if (body === null) return blockedDev("PR body is unreadable or cannot be extracted");
    const devError = consumerDevVerifyEvidenceError(body);
    if (devError) return blockedDev(devError);
  }
  if (body === null) return null;
  // Waiver parts are compared with the answer-time records of the final PR checkout.
  const waiver = perPrWaiverRecordError(body, cwd);
  if (waiver) return waiver.gate === DEV_GATE ? blockedDev(waiver.detail) : blocked(waiver.detail);
  return null;
}

// ── Per-PR waiver comparison at merge and at a description edit ─────────────
// `gh pr merge` compares the current PR description, and `gh pr edit` with a new body compares that body, with the
// answer-time records (lib/consumer-pre-pr-gate.mjs perPrWaiverRecordError). Both gates are state-backed inventory
// entries after the cross-model and local-test gates, so rigor `off` skips them; neither sits behind the exempt-branch
// returns of checkCrossModelMergeGate. A positive source checkout is exempt before any gh call.
// The literals and parsers shared with the cross-repo PR write gate (PR_URL_SELECTOR_RE, GH_REPO_VALUE_RE,
// GH_ARGUMENT_TOKEN_RE, unquoteOnce, SHELL_HEREDOC_TOKEN_RE, parseGhRepoValue, isLocalOriginTarget) live in
// lib/cross-repo-pr-scope.mjs. A heredoc operator or a background `&` ends the arguments of a clause (a heredoc body is not
// on the command line); other redirections are skipped with the shared redirect regexes, the reading the chore code-size
// gate uses, and a here-string `<<<` written apart skips its operand.

// Every real (unquoted, in a command segment) clause of `verbRe` in `cmd`, as { index, clause, prefix, assigned }. A
// clause ends at the first top-level separator, comment, or `)` closing a subshell around it. `assigned(name)` is the
// value of the last `name=` assignment before the clause that a separator ends (a prefix of the gh command is not one).
function _realGhPrClauses(cmd, verbRe) {
  const segs = safeSegmentCommand(cmd);
  let masked = cmd;
  for (const seg of segs ?? []) {
    if (seg.kind !== "quoted-string") continue;
    const [from, to] = seg.range;
    masked = masked.slice(0, from) + "_".repeat(to - from) + masked.slice(to);
  }
  const clauses = [];
  for (const match of masked.matchAll(new RegExp(verbRe.source, "g"))) {
    const index = anchoredVerbIndex(match);
    if (!isMatchInCommandSegment(index, segs)) continue;
    const start = match.index + match[0].length;
    let end = findTopLevelSeparator(cmd, start);
    const comment = (segs ?? []).find((seg) => seg.kind === "comment" && seg.range[0] >= start && seg.range[0] < end);
    if (comment) end = comment.range[0];
    for (let i = start, depth = 0; i < end; i++) {
      if (masked[i] === "(") depth += 1;
      else if (masked[i] === ")") { if (depth === 0) { end = i; break; } depth -= 1; }
    }
    const assigned = (name) => {
      let value;
      for (const m of cmd.slice(0, index).matchAll(new RegExp(`(^|[\\s;&|(])${name}=("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s;&|)]*)`, "g"))) {
        if (!isMatchInCommandSegment(m.index + m[1].length, segs)) continue;
        // A separator must follow the assignment: `NAME=12 gh pr merge "$NAME"` sets gh's environment, not the shell's $NAME.
        if (findTopLevelSeparator(cmd, m.index + m[0].length) < index) value = unquoteOnce(m[2]);
      }
      return value;
    };
    clauses.push({ index, clause: cmd.slice(index, end), prefix: cmd.slice(match.index, index), assigned });
  }
  return clauses;
}

// The PR selector and the --repo/-R value of one real `gh pr merge` or `gh pr edit` clause `found`, as written (unexpanded).
function _ghPrClauseArguments(found, verb = "merge") {
  const verbRe = new RegExp(`^\\S*${ghPrVerbSource("merge|edit|checks")}\\b`);
  const head = verbRe.exec(found.clause)?.[0] ?? "";
  const args = `${ghPrPreVerbFlags(head)} ${found.clause.slice(head.length)}`;
  const tokens = (args.match(GH_ARGUMENT_TOKEN_RE)) ?? [];
  const valueTaking = { edit: GH_PR_EDIT_VALUE_TAKING_FLAGS, checks: GH_PR_CHECKS_VALUE_TAKING_FLAGS }[verb] ?? GH_PR_MERGE_VALUE_TAKING_FLAGS;
  let selector;
  let flagRepo;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (SHELL_HEREDOC_TOKEN_RE.test(token) || token === "&") break;
    if (CHORE_CODE_SIZE_REDIRECT_TOKEN_RE.test(token)) {
      if (CHORE_CODE_SIZE_REDIRECT_OPERATOR_ONLY_RE.test(token) || /^\d*<<<$/.test(token)) i += 1;
      continue;
    }
    const inline = /^(--repo|-R)=([\s\S]*)$/.exec(token);
    if (inline) { flagRepo = inline[2]; continue; }
    if (token === "--repo" || token === "-R") { flagRepo = tokens[i + 1] ?? ""; i += 1; continue; }
    if (token.startsWith("-")) { if (!token.includes("=") && valueTaking.has(token)) i += 1; continue; }
    selector ??= token;
  }
  return { selector, flagRepo };
}

// One plain shell word, or one whole single- or double-quoted string, as its text; undefined for any other word (one that
// joins quoted parts, escapes a character or holds a quote), which the gates do not read. A `$` or backtick stays in the
// text: a caller reads it as a variable or rejects it, never as a literal repository or PR.
function _plainWord(word) {
  const text = /^'([^']*)'$/.exec(word)?.[1] ?? /^"([^"\\]*)"$/.exec(word)?.[1] ?? word;
  return /["'\\\s]/.test(text) ? undefined : text;
}
// A PR URL selector, read only from a plain word without an expansion.
const _prUrlSelector = (word) => (word && !/[$`]/.test(word) ? PR_URL_SELECTOR_RE.exec(word) : null);

// The repository `gh` would act on and the PR it names, for one real `gh pr merge` or `gh pr edit` clause `found`
// ({ clause, prefix, assigned } from _realGhPrClauses). Order (gh's own): PR URL selector, literal --repo/-R, the hook's
// GH_REPO; a command-local GH_REPO= is never read and blocks. Returns { target, targetArg, written, prNumber, branchSelector,
// selectorError, error }: `written` is true when the command itself names the repository (PR URL, --repo/-R), and `target` is null for
// this checkout's repository, `prNumber` the selector's number (URL or 1-8 digits) or undefined when there is none, and
// `branchSelector` the literal branch name a merge selects; an edit with another selector than a number or URL carries
// `selectorError`, which applies only when its new description is compared.
// Redirections (`2>&1`, `> file`, `&>/dev/null`, `<<< x`) are never the selector, and a heredoc or a background `&`
// ends the arguments. A `$NAME` selector names the PR whose number its last assignment before the clause gives literally.
function _resolvePrMergeTarget(found, verb = "merge") {
  const unreadable = { error: `the repository of this ${verb} cannot be read literally; use --repo [HOST/]OWNER/REPO.` };
  const { selector, flagRepo } = _ghPrClauseArguments(found, verb);
  // A command-local GH_REPO= is never read: gh takes the whole shell word, which can name another repository than any
  // part of it the hook reads (PR #3703 r6 F1).
  if (_prefixSetsGhRepo(found.prefix)) {
    return { error: `GH_REPO= in front of gh pr ${verb} is not read; write the repository as --repo github.com/OWNER/REPO or a PR URL instead.` };
  }
  let target = null;
  let prNumber;
  let branchSelector;
  // An edit reports a selector it cannot use as `selectorError` instead: the source exemption needs the repository and a
  // selector that cannot name another repository's PR, and the rest matters only when a waiver is compared.
  let selectorError;
  // A selector the hook cannot read literally (a joined or escaped word, a variable, a command substitution) can stand
  // for any PR, a PR URL of another repository included, so it never gets the source exemption (PR #3703 r9 W3-F1).
  let selectorUnread = false;
  // A selector is one plain word, or one whole quoted string: a word that joins quoted parts or escapes is never read,
  // so the hook and gh cannot read different PRs or repositories from it (PR #3703 r6).
  const plain = selector === undefined ? undefined : _plainWord(selector);
  const url = _prUrlSelector(plain);
  if (url) {
    target = { host: url[1].toLowerCase(), slug: `${url[2]}/${url[3]}` };
    prNumber = validatePrNumber(url[4]) ?? undefined;
    // A --repo beside the PR URL must name the same repository: the hook never picks one of two written destinations
    // (PR #3703 r8 W9-F4).
    if (flagRepo !== undefined) {
      const repo = _plainWord(flagRepo);
      const written = repo ? parseGhRepoValue(repo) : null;
      if (!written) return unreadable;
      // A --repo beside the URL is compared only when it writes its host: one without a host is gh's GH_HOST, which the
      // hook does not read (PR #3703 r10 W3-F1).
      if (!written.host) return { error: `the --repo of this ${verb} has no host; write the PR URL alone, or --repo HOST/OWNER/REPO naming the same repository: gh pr ${verb} https://github.com/OWNER/REPO/pull/<number>.` };
      if (!_sameRepository(written, target)) {
        return { error: `the PR URL and --repo of this ${verb} name different repositories; write one of them: gh pr ${verb} https://github.com/OWNER/REPO/pull/<number>.` };
      }
    }
  } else {
    if (selector !== undefined) {
      if (plain === undefined || /[$`]/.test(plain)) selectorUnread = true;
      let literal = plain ?? "";
      // A merge's `$NAME` reads the number its last assignment before the clause gives literally; an edit's never does:
      // it names its PR in the command itself (PR #3703 r6 F3).
      const variable = verb === "edit" ? null : /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))$/.exec(literal);
      const assigned = variable ? found.assigned?.(variable[1] ?? variable[2]) : undefined;
      if (assigned !== undefined && validatePrNumber(assigned)) literal = assigned;
      if (validatePrNumber(literal)) prNumber = literal;
      else if (verb === "edit") selectorError = "name the PR by number or URL when the new description carries a waiver: gh pr edit <number> --repo github.com/OWNER/REPO --body-file <absolute-body-file>.";
      else if (!literal || /[$`]/.test(literal)) return { error: "the PR of this merge cannot be read literally; name it by number or URL: gh pr merge <number> --repo github.com/OWNER/REPO." };
      else branchSelector = literal;
    }
    // Only a --repo/-R written as one plain word writes the repository; a GH_REPO= assignment is never read, so a merge
    // or a compared edit without --repo or a PR URL is blocked as unwritten (PR #3703 r6 F1).
    if (flagRepo !== undefined) {
      const repo = _plainWord(flagRepo);
      target = repo ? parseGhRepoValue(repo) : null;
      if (!target) return unreadable;
    } else if (process.env.GH_REPO) {
      target = parseGhRepoValue(process.env.GH_REPO);
      if (!target) return unreadable;
    }
  }
  // An edit that names no PR by number or URL never falls back to the PR of a checkout's current branch (PR #3703 r5 F1).
  if (verb === "edit" && prNumber === undefined && !selectorError) selectorError = "name the PR by number or URL when the new description carries a waiver: gh pr edit <number> --repo github.com/OWNER/REPO --body-file <absolute-body-file>.";
  const targetArg = target ? (target.host ? `${target.host}/${target.slug}` : target.slug) : undefined;
  const written = Boolean(url) || flagRepo !== undefined;
  // Whether the command writes a selector at all; an edit without one is gh's current-branch PR (PR #3703 r11 W10-F1).
  const selectorWritten = selector !== undefined;
  return { target, targetArg, written, prNumber, branchSelector, selectorError, selectorUnread, selectorWritten };
}

// ── Merge destination (fix-cross-repo-merge-destination) ─────────────────────────────────────────────────────────
// Closed rules: the gate reads only what the command writes literally and the URL a checkout stores for its origin.
// It never asks gh, ssh or the git configuration where a command would go, so whatever it cannot read literally is
// blocked with a form that it can read.

// Hosts are compared as written: a destination the gate accepts always writes its host.
const _targetHost = (target) => String(target.host || "github.com").toLowerCase();
const _sameRepository = (a, b) => Boolean(a && b) && a.slug.toLowerCase() === b.slug.toLowerCase() && _targetHost(a) === _targetHost(b);
// Why the destination of a gh pr merge/edit (`resolved`, from _resolvePrMergeTarget) is not written in full by the
// command itself, or null when it is: a PR URL, or a --repo/-R that names HOST/OWNER/REPO.
// Anything less leaves the choice to the GH_HOST, GH_REPO and git remotes of the shell that runs gh, which can differ
// from the hook's own environment, so the gate never infers it.
function _unwrittenDestination(resolved, verb) {
  if (resolved.target && resolved.written && resolved.target.host) return null;
  return `write the repository of gh pr ${verb} in full in the command: its PR URL, or --repo HOST/OWNER/REPO (for example --repo github.com/OWNER/REPO); without a host, or without a target, gh picks it from the shell's GH_HOST, GH_REPO or git remotes, which this hook does not read.`;
}
// Whether the command writes, in full, the repository whose URL the checkout cwd stores for its origin.
const _isOwnOrigin = (resolved, cwd, verb) =>
  !resolved.error && !_unwrittenDestination(resolved, verb) && _sameRepository(resolved.target, storedOriginIdentity(cwd));
// Whether `text` runs a command substitution (`$(…)`, a backtick, `<(…)`/`>(…)`) when the shell reads it: single quotes
// make everything literal, a backslash outside them makes the next character literal, and double quotes keep `$(` and
// backticks active.
function _hasCommandSubstitution(text) {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") { if (c === "'") quote = ""; continue; }
    if (c === "\\") { i++; continue; }
    if (c === "`" || (c === "$" && text[i + 1] === "(")) return true;
    if (quote === '"') { if (c === '"') quote = ""; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if ((c === "<" || c === ">") && text[i + 1] === "(") return true;
  }
  return false;
}
const _repositoryLabel = (target) => `${_targetHost(target)}/${target.slug}`;
// The value may be non-literal: the target reader then reports that it cannot read it.
// Assignments a gh pr merge/edit may carry: the devpro markers only, each written once.
const STANDALONE_PREFIX_NAME_RE = /^DEVPRO_\w+$/;
const _prefixAssignments = prefixAssignments;

// Whether the text in front of a gh command sets GH_REPO for it. An assignment the word reader cannot read (a value
// with `$(…)`, a backtick or a parenthesis) stops the reading, so the unread text is still searched as before: a
// GH_REPO= there counts too, while one inside a quoted value of a read assignment does not (PR #3703 r8 W2-F3).
function _prefixSetsGhRepo(prefix) {
  const { assignments, rest } = _prefixAssignments(prefix);
  return assignments.some(({ name }) => name === "GH_REPO") || /(?:^|[\s;&|(])GH_REPO=/.test(rest);
}

// Why the gh pr clause `found` (from _realGhPrClauses) is not the whole command, or null when it is: literal
// DEVPRO_* assignments (each name once), the gh command, then nothing but redirections, a background `&` and a comment. It runs
// in the working directory the hook is given, so no cd, subshell or group comes before it: a preceding command could
// change the directory, the PR, its base or the files a check reads before gh runs, a following one (a pipe included)
// runs while it does, and a command substitution inside it runs first.
function _standaloneGhPrClauseError(cmd, found, verb) {
  const form = `run gh pr ${verb} as its own command from the checkout's working directory, with no cd, ( … ) or other step: [DEVPRO_…=… ] gh pr ${verb} <number> --repo HOST/OWNER/REPO …`;
  // anchoredVerbIndex may stop before a path prefix of the gh binary; the verb match starts at `gh` or that path.
  const { assignments, rest } = _prefixAssignments(cmd.slice(0, found.index));
  const seen = new Set();
  for (const { name, text } of assignments) {
    if (!STANDALONE_PREFIX_NAME_RE.test(name)) return `${name}= changes what gh reads; write the target into the command instead and ${form}.`;
    if (_hasCommandSubstitution(text)) return `${name}= runs a command substitution first; ${form}.`;
    // The shell keeps the last of repeated assignments and a reader may take the first, so each name is written once
    // (PR #3703 r7 W3-F1).
    if (seen.has(name)) return `${name}= is assigned more than once in front of gh pr ${verb}; the shell keeps the last value, so write it once and ${form}.`;
    seen.add(name);
  }
  if (rest.trim()) return `another step comes before gh pr ${verb}; ${form}.`;
  const segs = safeSegmentCommand(cmd) ?? [];
  const end = found.index + found.clause.length;
  let after = cmd.slice(end);
  for (const seg of segs) {
    if (seg.kind !== "comment" || seg.range[0] < end) continue;
    after = after.slice(0, seg.range[0] - end) + " ".repeat(seg.range[1] - seg.range[0]) + after.slice(seg.range[1] - end);
  }
  if (after.trim()) return `another step follows gh pr ${verb} (a pipe included); ${form}.`;
  if (_hasCommandSubstitution(found.clause)) return `gh pr ${verb} runs a command substitution first; ${form}.`;
  return null;
}

// The merge-destination judgement of the one gh pr merge of `cmd`: { blockReason } or { evidenceCwd } (the checkout
// whose files every later merge gate reads), or null when the command merges nothing.
function _mergeDestination(raw, baseCwd, effectiveCwd) {
  const cmd = joinCommandLineContinuations(raw, { betweenWordsOnly: true });
  const block = (detail) => ({ blockReason: `Cross-repo PR merge gate: ${detail}` });
  if (/\bgh\s/.test(cmd) && unreadPrCheckoutPrefix(cmd, "merge")) return block(UNREAD_CHECKOUT_PREFIX);
  if (!CROSS_MODEL_GH_PR_MERGE_RE.test(gateCommandSegmentText(cmd))) return null;
  const clauses = _realGhPrClauses(cmd, GH_PR_MERGE_RE);
  if (!clauses.length) return null;
  if (clauses.length > 1) return block("one command merges one PR; run each gh pr merge as its own command.");
  const [found] = clauses;
  // Later gates receive the original command. A continuation in the invocation must not let them miss the merge
  // that destination resolution found; only continuations in its assignment prefix can be normalized here.
  if (raw !== cmd && !_realGhPrClauses(raw, GH_PR_MERGE_RE).some(({ index, clause }) => index === found.index && clause === found.clause)) {
    return block("write the gh pr merge invocation on one line so every gate can read the same PR and repository.");
  }
  const standalone = _standaloneGhPrClauseError(cmd, found, "merge");
  if (standalone) return block(standalone);
  // The marker is read as the whole shell word the shell assigns, and only as one plain word: a word that joins quoted
  // parts or escapes a character is never read, so the hook and the shell cannot read different repositories from it
  // (PR #3703 r8 W3-F1).
  const markerWord = _prefixAssignments(cmd.slice(0, found.index)).assignments.find(({ name }) => name === "DEVPRO_CROSS_REPO_PR")?.word;
  if (markerWord !== undefined && (!_plainWord(markerWord) || /[$`]/.test(_plainWord(markerWord)))) {
    return block("write DEVPRO_CROSS_REPO_PR as one plain word, DEVPRO_CROSS_REPO_PR=OWNER/REPO, with no quoted parts joined to it, escapes or expansions; the hook reads only such a word.");
  }
  const resolved = _resolvePrMergeTarget(found, "merge");
  if (resolved.error) return block(resolved.error);
  // Every later merge gate and the post-merge marker read the PR the merge names itself: a literal number or PR URL, so
  // no gate looks it up from a checkout's current branch (whose checkout may differ from the one gh runs in).
  const { selector } = _ghPrClauseArguments(found, "merge");
  const literalSelector = selector === undefined ? "" : unquoteOnce(selector);
  if (resolved.prNumber === undefined || !(validatePrNumber(literalSelector) || PR_URL_SELECTOR_RE.test(literalSelector))) {
    return block("name the PR of this merge by its number or URL, written literally: gh pr merge <number> --repo github.com/OWNER/REPO, or gh pr merge https://github.com/OWNER/REPO/pull/<number>; a branch name, a variable or no selector leaves the PR to gh.");
  }
  // Every later merge gate reads its checkout through git; an inherited GIT_DIR (or another repository-locating
  // variable) would make git answer for another repository, so the merge is judged only without one.
  const located = inheritedGitLocation();
  if (located) return block(_inheritedGitLocationReason(located, "merge"));
  // The merge stands alone, so it runs in the working directory the hook is given.
  const cwd = [effectiveCwd, baseCwd].find((dir) => dir && dir !== UNRESOLVABLE_CWD) ?? "";
  if (!cwd) return block("the working directory this merge runs in cannot be resolved; run gh pr merge from inside a checkout.");
  const unwritten = _unwrittenDestination(resolved, "merge");
  if (unwritten) return block(unwritten);
  const target = resolved.target;
  // Every later merge gate asks gh with this host named, and the review evidence names github.com repositories only.
  if (_targetHost(target) !== "github.com") {
    return block(`this merges ${_repositoryLabel(target)}; the merge gates read review and test evidence of github.com repositories only, so merge it outside this session or with a github.com target.`);
  }
  // The merge stands alone, so everything before it is its own assignments: the declaration is read from all of it, a
  // value with an escaped space included (PR #3703 r5 F3).
  const declared = declaredPrCheckout(cmd, 0, found.index);
  if (declared?.error) return block(declared.error);
  if (declared && !_sameRepository(target, storedOriginIdentity(declared.cwd))) {
    return block(`DEVPRO_PR_CHECKOUT ${declared.cwd} is not a checkout of ${_repositoryLabel(target)} (its origin must be one stored https URL, or ssh written with github.com, of that repository, which git fetches and pushes without a rewrite).`);
  }
  if (!_sameRepository(target, storedOriginIdentity(cwd))) {
    const label = `${target.host}/${target.slug}`;
    const approved = markerWord === undefined ? null : parseGhRepoValue(_plainWord(markerWord));
    if (!approved || !_sameRepository(approved, target)) {
      return block(`this merges ${_repositoryLabel(target)}, not the repository of this checkout. Ask the user first; after they approve this merge, put DEVPRO_CROSS_REPO_PR=${label} and DEVPRO_PR_CHECKOUT=<absolute path of a checkout of that repository> in front of this gh pr merge.`);
    }
    if (!declared) {
      return block(`this merges ${_repositoryLabel(target)}; add DEVPRO_PR_CHECKOUT=<absolute path of a checkout of that repository> in front of this gh pr merge so its review, test and waiver evidence is read there (its origin must be one stored https URL, or ssh written with github.com, of that repository, which git fetches and pushes without a rewrite).`);
    }
  }
  return { evidenceCwd: declared?.cwd ?? cwd, binding: { repo: `github.com/${target.slug}`, pr: resolved.prNumber } };
}

const _inheritedGitLocationReason = (name, verb) =>
  `the hook's environment sets ${name}, which makes git read another repository than the checkout this gh pr ${verb} runs in, so the gate cannot tell whose evidence it reads; unset ${name} in the environment the agent's hooks run in, then retry.`;

// One judgement per command: the gate and the evidence readers after it ask about the same payload.
let _mergeDestinationMemo = null;
function _memoMergeDestination(cmd, baseCwd, effectiveCwd) {
  const key = `${baseCwd}\0${effectiveCwd}\0${process.env.GH_REPO ?? ""}\0${process.env.GH_HOST ?? ""}\0${inheritedGitLocation() ?? ""}\0${cmd}`;
  if (_mergeDestinationMemo?.key !== key) _mergeDestinationMemo = { key, value: _mergeDestination(cmd, baseCwd, effectiveCwd) };
  return _mergeDestinationMemo.value;
}

function checkCrossRepoPrMerge(cmd, baseCwd, effectiveCwd) {
  const judged = _memoMergeDestination(cmd, baseCwd, effectiveCwd);
  return judged?.blockReason ? { block: true, reason: judged.blockReason } : null;
}

// The checkout every merge gate after cross-repo-pr-merge reads: the target checkout the gate bound, else the command
// cwd (a blocked merge never reaches them).
function _mergeEvidenceCwd(cmd, baseCwd, effectiveCwd) {
  return _memoMergeDestination(cmd, baseCwd, effectiveCwd)?.evidenceCwd ?? (effectiveCwd || commandCwd(cmd, baseCwd));
}
// The repository and PR every merge gate after cross-repo-pr-merge, and the post-merge marker, ask gh about:
// { repo: github.com/OWNER/REPO, pr }, so no lookup leaves the host, the repository or the PR to gh or to a checkout's
// current branch; undefined when the gate bound nothing.
function _mergeEvidenceBinding(cmd, baseCwd, effectiveCwd) {
  return _memoMergeDestination(cmd, baseCwd, effectiveCwd)?.binding;
}

// The binding plus the checkout the post-merge marker reads the PR from; undefined when the gate bound nothing.
function _mergeMarkerBinding(cmd, baseCwd, effectiveCwd) {
  const judged = _memoMergeDestination(cmd, baseCwd, effectiveCwd);
  return judged?.binding ? { ...judged.binding, evidenceCwd: judged.evidenceCwd } : undefined;
}

function checkPerPrWaiverOnMerge(cmd, cwd) {
  const cmdText = gateCommandSegmentText(cmd);
  if (!CROSS_MODEL_GH_PR_MERGE_RE.test(cmdText)) return null;
  const blocked = (detail) => ({ block: true, reason: `Per-PR waiver merge gate: ${detail}` });
  // A command may merge several PRs: every real merge clause is compared, and the first block blocks the command.
  const clauses = _realGhPrClauses(cmd, GH_PR_MERGE_RE);
  if (!clauses.length) return blocked("no gh pr merge command found");
  for (const found of clauses) {
    const result = _perPrWaiverMergeClause(found, cwd, blocked);
    if (result) return result;
  }
  return null;
}

function _perPrWaiverMergeClause(found, cwd, blocked) {
  const resolved = _resolvePrMergeTarget(found, "merge");
  if (resolved.error) return blocked(resolved.error);
  // A positive source checkout is exempt for a PR of its own origin only, before any gh call; a PR of another
  // repository is compared against that repository's records like any other.
  if (checkoutRepoIdentity(cwd).identity === "source" && _isOwnOrigin(resolved, cwd, "merge")) return null;
  // Only the merge clause's own selector names the PR: a /pull/N link in another clause never does.
  const { branchSelector } = resolved;
  // A merge without a selector is blocked before this gate (cross-repo-pr-merge), and here too: the PR of a checkout's
  // current branch is never read (PR #3703 r9 W3-F2).
  const prNumber = resolved.prNumber;
  if (!prNumber && branchSelector === undefined) return blocked("the PR of this merge cannot be resolved; name it by number or URL: gh pr merge <number> --repo github.com/OWNER/REPO.");
  const label = prNumber ? `PR #${prNumber}` : `the PR of branch ${branchSelector}`;
  const view = _runGhPrView(prNumber ?? branchSelector, { repo: resolved.targetArg, cwd });
  if (!view || !Object.hasOwn(view, "body") || (view.body !== null && typeof view.body !== "string")) {
    return blocked(`the description of ${label} cannot be read; check gh authentication and network, then retry the merge.`);
  }
  if (!hasPerPrWaiverPart(view.body)) return null;
  if (!prNumber) return blocked(`${label} carries a waiver; name the PR by number or URL so the comparison and the merge name the same PR: gh pr merge <number> --repo github.com/OWNER/REPO.`);
  // A merge without a target is this checkout's (cross-repo-pr-merge blocks it before this gate in the hook).
  if (resolved.target && !_sameRepository(resolved.target, storedOriginIdentity(cwd))) {
    return blocked(`PR #${prNumber} carries a waiver, but the merge selects ${resolved.targetArg}, which is not the repository of this checkout, so no answer-time record of this checkout can belong to it. Next step: run the merge from a local checkout of that repository, or replace the waiver with the actual status (gh pr edit).`);
  }
  if (typeof view.isCrossRepository !== "boolean") {
    return blocked(`PR #${prNumber} carries a waiver, but gh pr view returned no isCrossRepository field, so the gate cannot tell whether the PR head is in this repository. Next step: check gh authentication and version, then retry the merge.`);
  }
  const error = perPrWaiverRecordError(view.body, cwd, {}, { branch: view.headRefName, crossRepository: view.isCrossRepository });
  return error ? { block: true, reason: perPrWaiverMergeReason(error, prNumber, "gh pr edit") } : null;
}

// `gh pr edit` with a new description: each clause that sets a body is compared before the edit.
function checkPerPrWaiverOnEdit(cmd, baseCwd) {
  if (!GH_PR_EDIT_RE.test(gateCommandSegmentText(cmd))) return null;
  const blocked = (detail) => ({ block: true, reason: `Per-PR waiver edit gate: ${detail}` });
  for (const found of _realGhPrClauses(cmd, GH_PR_EDIT_RE)) {
    const { index, clause } = found;
    // An edit that sets no description (title, labels, ...) is not compared and reads nothing.
    if (!extractFlagValues(clause, "--body-file|-F").length && !extractFlagValues(clause, "--body|-b").length) continue;
    const cwd = baseCwd ? commandCwdAt(cmd, baseCwd, index, "gh", { tolerateRedirectsAndPipes: true, followLeadingSubshell: true }) : "";
    if (!cwd || cwd === UNRESOLVABLE_CWD) return blocked(`the checkout of this gh pr edit cannot be resolved before the shell runs (${UNFOLLOWED_EDIT_CD_FORMS}); run gh pr edit <number> --repo github.com/OWNER/REPO --body-file <absolute-body-file> as its own command from the PR checkout's working directory.`);
    // The file is read before the shell runs, so a step before or beside the edit could still change it: the edit
    // stands alone, for every repository (the source exemption below reads nothing, but the form is checked first).
    if (extractFlagValues(clause, "--body-file|-F").length) {
      const standalone = _standaloneGhPrClauseError(cmd, found, "edit");
      if (standalone) return blocked(standalone);
    }
    // The identity, origin and records below are read through git from this checkout only.
    const located = inheritedGitLocation();
    if (located) return blocked(_inheritedGitLocationReason(located, "edit"));
    const editTarget = _resolvePrMergeTarget(found, "edit");
    // A positive source checkout is exempt for a PR of its own origin only, written in full in the command, and only when
    // the selector cannot name another repository's PR: a number, its own PR URL or a literal branch name (PR #3703 r9
    // W3-F1). An edit without a selector is not exempt: gh edits its current-branch PR, which the command does not name
    // (PR #3703 r11 W10-F1).
    if (checkoutRepoIdentity(cwd).identity === "source" && editTarget.selectorWritten && !editTarget.selectorUnread && _isOwnOrigin(editTarget, cwd, "edit")) continue;
    const { body } = extractGhPrBodyArgument(clause, cwd);
    if (body === null) return blocked("the new description of this gh pr edit cannot be read; write it to a file and use gh pr edit <number> --repo github.com/OWNER/REPO --body-file <absolute-body-file>.");
    if (!hasPerPrWaiverPart(body)) continue;
    const resolved = _resolvePrMergeTarget(found, "edit");
    if (resolved.error) return blocked(resolved.error);
    if (resolved.selectorError) return blocked(resolved.selectorError);
    // The waiver is compared with this checkout's records only for a PR whose repository the command writes in full.
    const unwritten = _unwrittenDestination(resolved, "edit");
    if (unwritten) return blocked(`the new description carries a waiver; ${unwritten}`);
    // The checkout is bound by the URL it stores for its origin, as a merge's is (PR #3703 r6 F5).
    if (!_sameRepository(resolved.target, storedOriginIdentity(cwd))) {
      return blocked(`the new description carries a waiver, but the edit selects ${resolved.targetArg}, which is not the repository of this checkout, so no answer-time record of this checkout can belong to that PR. Next step: run gh pr edit from a local checkout of that repository, or replace the waiver with the actual status.`);
    }
    const { prNumber } = resolved;
    const view = _runGhPrView(prNumber, { repo: resolved.targetArg, cwd });
    if (!view) return blocked(`PR #${prNumber} cannot be read to find its head branch; check gh authentication and network, then retry the edit.`);
    if (typeof view.isCrossRepository !== "boolean") {
      return blocked(`PR #${prNumber} carries a waiver, but gh pr view returned no isCrossRepository field, so the gate cannot tell whether the PR head is in this repository. Next step: check gh authentication and version, then retry the edit.`);
    }
    const error = perPrWaiverRecordError(body, cwd, {}, { branch: view.headRefName, crossRepository: view.isCrossRepository });
    if (error) return { block: true, reason: perPrWaiverEditReason(error, prNumber) };
  }
  return null;
}

// Cross-repo PR write gate: a gh pr create/edit/comment whose explicit target is not the origin of the command
// checkout needs a DEVPRO_CROSS_REPO_PR marker for that repository (or must run in the target's checkout). The judgement,
// including every block reason, comes from lib/cross-repo-pr-scope.mjs; the consumer pre-PR checks gate reads the same
// result. A payload without a gh pr create/edit/comment clause costs nothing.
function checkCrossRepoPrWrite(cmd, baseCwd) {
  if (/\bgh\s/.test(cmd) && unreadPrCheckoutPrefix(joinCommandLineContinuations(cmd, { betweenWordsOnly: true }), "create")) {
    return { block: true, reason: `PR checkout gate: ${UNREAD_CHECKOUT_PREFIX}` };
  }
  for (const entry of crossRepoPrAuthorization(cmd, baseCwd)) {
    if (entry.blockReason) return { block: true, reason: entry.blockReason };
  }
  return null;
}

function checkPrBodyTemplateLint(cmd, baseCwd) {
  // Only trigger on `gh pr create` (scoped via gateCommandSegmentText segment filter — strips heredocs, quoted
  // strings, comments before matching). GH_PR_CREATE_RE finds a create wherever its --repo/-R sits (`gh -R <repo> pr
  // create`, `gh pr -R <repo> create`), so every create, marker-authorized or not, reaches the consumer pre-PR checks
  // and this lint (fix-pre-verb-repo-flag-gates).
  const cmdText = gateCommandSegmentText(cmd);
  if (!GH_PR_CREATE_RE.test(cmdText)) return null;

  const consumerSegs = safeSegmentCommand(cmd);
  let consumerCreates = 0;
  // Match quoted assignment prefixes with original coordinates, as ghPrCreateCheckout does.
  let consumerCommand = cmd;
  for (const seg of consumerSegs ?? []) {
    if (seg.kind !== "quoted-string") continue;
    const [from, to] = seg.range;
    consumerCommand = consumerCommand.slice(0, from) + "_".repeat(to - from) + consumerCommand.slice(to);
  }
  for (const match of consumerCommand.matchAll(new RegExp(GH_PR_CREATE_RE.source, "g"))) {
    const index = anchoredVerbIndex(match);
    if (!isMatchInCommandSegment(index, consumerSegs)) continue;
    consumerCreates += 1;
    const { cwd, declared } = prCreateCwd(cmd, baseCwd, match.index, index);
    const consumer = checkConsumerPrBody(cmd, { index, cwd, prefixStart: match.index, declared, baseCwd });
    if (consumer) return consumer;
  }
  if (!consumerCreates) return checkConsumerPrBody(cmd, { index: -1, cwd: UNRESOLVABLE_CWD });

  // Extract body file path: prefer --body-file <path> / -F <path> shorthand
  // (PR_BODY_FILE_FLAG_RE), then BODY_FILE_RE (`gh api` raw-field form
  // `-F body=@<file>` / `-F body="$(cat <file>)"`). Both are scanned on raw
  // cmd but accepted only when the match begins in a command segment, so file
  // arguments inside a compound command are still captured while quoted body
  // examples are ignored.
  let rawPath = null;
  const prSegs = safeSegmentCommand(cmd);

  const bodyFileMatch = firstCommandSegmentMatch(cmd, PR_BODY_FILE_FLAG_RE, prSegs);
  if (bodyFileMatch) {
    rawPath = shellTokenValue(bodyFileMatch[1] || "");
  } else {
    const bodyFMatch = firstCommandSegmentMatch(cmd, BODY_FILE_RE, prSegs);
    if (bodyFMatch) {
      // group 1 = $(cat <path>) form; group 2 = @<path> form (may be quoted).
      rawPath = bodyFMatch[1] || shellTokenValue(bodyFMatch[2] || "");
    }
  }

  // Fail-open: inline --body "<text>" or unextractable form.
  if (!rawPath) return null;

  const bodyFilePath = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(baseCwd, rawPath);

  const lintScript = prBodyLintScriptPath();
  const lintArgs = [lintScript, "--body-file", bodyFilePath];
  if (baseCwd) {
    lintArgs.push("--cwd", baseCwd);
    const branchResult = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: baseCwd,
      encoding: "utf8",
    });
    if (branchResult.status === 0) {
      const branch = (branchResult.stdout || "").trim();
      if (branch && branch !== "HEAD") {
        lintArgs.push("--branch", branch);
      }
    }
  }
  // Tell the lint which PR the body is for (design D5): the lint decides from the local branch and diff only
  // when they describe that PR. A literal --head / --base is passed through (same parsing as
  // checkProductionBasePrCreate); anything that is not literal, or a branch switch earlier in the same
  // command, is passed as unresolved and the lint fails open. No timeout on the spawn below: a timeout
  // would turn into status null, which this gate treats as a block.
  let targetUnresolved = false;
  // Where the real `gh pr create` starts and the cwd there (ghPrCreateCheckout): quoted environment values in front of
  // it do not hide it, and the same words in a quoted string, a comment, a heredoc body or an argument are not it. -1
  // when the command cannot be found, for example behind an environment value that is command substitution. A command
  // inside `$( ... )` is found, and its cwd is reported as unresolvable.
  const checkout = ghPrCreateCheckout(cmd, baseCwd, prSegs);
  const createIndex = checkout.index;
  const headRaw = extractGhPrCreateHeadValue(cmd);
  if (headRaw !== null) {
    if (isLiteralHeadToken(headRaw)) lintArgs.push("--pr-head", shellTokenValue(headRaw).trim());
    else targetUnresolved = true;
  } else if (createIndex > 0 && PRE_CREATE_BRANCH_SWITCH_RE.test(cmd.slice(0, createIndex))) {
    targetUnresolved = true;
  }
  const baseRaw = extractGhPrCreateBaseValue(cmd);
  if (baseRaw !== null) {
    if (isLiteralHeadToken(baseRaw)) lintArgs.push("--pr-base", shellTokenValue(baseRaw).trim());
    else targetUnresolved = true;
  }
  // The PR belongs to the checkout `gh pr create` itself runs in. A `cd` earlier in the command can change it, while
  // `git -C` before it cannot, so the cwd is computed at the gh position (not the first git command's, which is what
  // the gate runner's effectiveCwd holds). The evidence checks and the cost-override disclosure follow it (the lint
  // picks the PR head and checkout from --pr-head / --pr-cwd); --cwd / --branch above stay the session's.
  // A cwd that could not be resolved statically (a `cd` operand that is a variable or a missing directory, a group,
  // command substitution, a chdir in parentheses or backticks) is unresolved, never replaced by baseCwd; so is a command
  // that could not be located.
  if (baseCwd) {
    const prCwd = createIndex >= 0 ? checkout.cwd : UNRESOLVABLE_CWD;
    if (prCwd === UNRESOLVABLE_CWD) targetUnresolved = true;
    else if (prCwd && prCwd !== baseCwd && !samePhysicalDirectory(prCwd, baseCwd)) lintArgs.push("--pr-cwd", prCwd);
  }
  if (targetUnresolved) lintArgs.push("--pr-target-unresolved");
  const result = spawnSync("node", lintArgs, { encoding: "utf8", cwd: baseCwd || undefined });

  if (result.status === 2) {
    // Unreadable: emit advisory but never block.
    return { advisory: `PR body file unreadable: ${bodyFilePath}` };
  }
  if (result.status !== 0) {
    // exit 1: missing canonical template phrases, override disclosure mismatch, or (second review required)
    // an evidence-section / Change Context finding.
    // body-file path MUST block (early-fail at PR write); not advisory-only.
    const lintStderr = (result.stderr || "").trim();
    return {
      block: true,
      reason:
        `PR body template lint gate: ${bodyFilePath} failed the PR body check\n` +
        `${lintStderr}\n\n` +
        `per git-pr-template-and-merge.md PR body template / pre-pr-body-template-check.mjs\n\n` +
        `${HOOK_BYPASS_HINT}`,
    };
  }

  // exit 0 → pass.
  return null;
}

// Gate D (T10) — Worktree Absolute Path Gate ─────────────────────────────
// Block `git worktree add <path>` where path is relative and there is no
// explicit `cd <abs> &&` prefix that would anchor the cwd.
//
// Rationale: relative paths are interpreted against the current shell cwd,
// which can be stale/wrong inside AI sessions (PR #395 evidence of nested
// worktrees caused by cwd-sticky bugs). Require absolute paths, OR allow
// relative paths only when an explicit `cd /abs &&` prefix anchors the cwd
// deterministically (commandCwd extracts the anchored cwd in that case).
//
// Path resolution rule:
//   literal starts with '/' → absolute → pass
//   literal is relative AND command has explicit cd <abs> prefix → resolve
//     path.resolve(commandCwd, literal) → effectively absolute → pass
//   literal is relative AND no explicit cd prefix → cwd unknown → block
//
// Decision: D2 — block on detection.

// Match: git [flags] worktree add [flags] <path>
// Captures the path arg (first non-flag positional after 'worktree add').
// Handles: git worktree add <path>, git -C /x worktree add <path>,
//   cd /abs && git worktree add <path>, git worktree add -f <path>,
//   git worktree add -b <branch> <path>.
const WORKTREE_ADD_RE =
  new RegExp(`${CMD_POSITION_ANCHOR}git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*worktree\\s+add\\b`);

// `git worktree add [<options>] <path> [<commit-ish>]`: the number of tokens the
// option `tok` spans, or 0 when `tok` is not an option. Only -b/-B/--reason take a
// value; every other option is skipped alone, including ones never listed here such
// as --no-track, so a git option is never read as the <path> (#3507). The three
// argument readers below share this rule so their option lists cannot drift apart.
function worktreeAddOptionWidth(tok) {
  if (/^(?:-b|-B|--branch|--reason)$/.test(tok)) return 2;
  return tok.startsWith("-") ? 1 : 0;
}

/**
 * Extract the worktree <path> arg from a `git worktree add` command segment.
 * Returns null if not a worktree add command or path can't be determined.
 *
 * Grammar: git worktree add [-f] [--detach] [-b|-B <new-branch>] [--orphan]
 *          [--lock [--reason <string>]] <path> [<commit-ish>]
 * We skip flags and their values, then take the first non-flag token as <path>.
 */
function extractWorktreeAddPath(cmd) {
  // Anchor on a real `git [globals] worktree add` invocation at a command
  // boundary, NOT a bare `worktree add` substring — otherwise a non-git use of
  // the words inside echo/quoted text (e.g. `echo "retry worktree add with X" &&
  // git worktree add <path> -b …`) makes cmd.search() match the echo residue and
  // the first non-flag token after it ("with"/"from"/"now") is mis-read as the
  // <path>, false-blocking a legitimate aligned add (RULE-FEEDBACK regression;
  // mirrors the round-13 fix already in extractWorktreeAddCreates L3945 and the
  // command-position anchoring in extractBranchNameFromCommand).
  const s = cmd.toString();
  const m = new RegExp(WORKTREE_ADD_RE.source).exec(s);
  if (!m) return null;
  // The matched span ends at `worktree add`; slice from just after it.
  const after = s.slice(m.index + m[0].length);
  // Tokenise the remaining args (simple split; handles quoted tokens)
  const tokens = [];
  const tokenRe = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g;
  for (const m of after.matchAll(tokenRe)) tokens.push(m[1]);
  let i = 0;
  while (i < tokens.length) {
    const width = worktreeAddOptionWidth(tokens[i]);
    if (width === 0) return shellTokenValue(tokens[i]); // first non-option token is the <path>
    i += width;
  }
  return null;
}

// Gate D-local raw word scanner. This intentionally does not replace the
// shared extractor above: Gate D needs quote-completeness metadata only when
// the sanitized path is the opaque `__QUOTED__` placeholder. Ambiguous shell
// syntax stays untrusted instead of being decoded or evaluated.
function scanWorktreeAddRawWords(after) {
  const words = [];
  let i = 0;
  while (i < after.length) {
    while (/\s/.test(after[i] || "")) i++;
    if (i >= after.length || /[;|&<>]/.test(after[i])) break;

    const start = i;
    let quote = "";
    while (i < after.length) {
      const ch = after[i];
      if (quote === "'") {
        i++;
        if (ch === "'") quote = "";
        continue;
      }
      if (quote === '"') {
        if (ch === "\\" && i + 1 < after.length) {
          i += 2;
          continue;
        }
        i++;
        if (ch === '"') quote = "";
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        i++;
        continue;
      }
      if (/\s/.test(ch) || /[;|&<>]/.test(ch)) break;
      if (ch === "\\" && i + 1 < after.length) {
        i += 2;
        continue;
      }
      i++;
    }
    words.push({ raw: after.slice(start, i), quotesComplete: quote === "" });
    if (i < after.length && /[;|&<>]/.test(after[i])) break;
  }
  return words;
}

function rawStatementBoundsContaining(s, commandIndex, segs) {
  let start = 0;
  let end = s.length;
  for (let i = 0; i < commandIndex; i++) {
    if (/[;|&\n]/.test(s[i]) && isMatchInCommandSegment(i, segs)) start = i + 1;
  }
  for (let i = commandIndex; i < s.length; i++) {
    if (/[;|&\n]/.test(s[i]) && isMatchInCommandSegment(i, segs)) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function rawStatementContaining(s, commandIndex, segs) {
  const { start, end } = rawStatementBoundsContaining(s, commandIndex, segs);
  return s.slice(start, end);
}

function rawExecutableStatement(s, start, end, segs) {
  let codeEnd = end;
  for (const seg of segs || []) {
    if (seg.kind === "comment" && seg.range[0] >= start && seg.range[0] < codeEnd) {
      codeEnd = seg.range[0];
    }
  }
  return s.slice(start, codeEnd);
}

function precedingRawStatementSeparator(s, start) {
  const before = s.slice(0, start).replace(/[ \t\r]+$/, "");
  if (before.endsWith("&&")) return "&&";
  if (before.endsWith("||")) return "||";
  return before.slice(-1);
}

// Evidence reached through `&&` is safe only while the worktree invocation is
// in that same AND-chain: then the invocation cannot execute when the evidence
// statement was skipped. A later `;`, newline, pipe, OR, or background boundary
// breaks that implication and therefore clears the proof.
function evidenceExecutedWhenInvocationRuns(s, start, end, segs) {
  const preceding = precedingRawStatementSeparator(s, start);
  if (preceding !== "&&") {
    return preceding === "" || preceding === ";" || preceding === "\n";
  }

  for (let i = end; i < s.length; i++) {
    if (!/[;|&\n]/.test(s[i]) || !isMatchInCommandSegment(i, segs)) continue;
    if (
      s[i] === "&" &&
      s[i + 1] === "&" &&
      isMatchInCommandSegment(i + 1, segs)
    ) {
      i++;
      continue;
    }
    return false;
  }
  return true;
}

function gateDWorktreeAddRawMatches(s) {
  const segs = safeSegmentCommand(s);
  const flags = WORKTREE_ADD_RE.flags.includes("g")
    ? WORKTREE_ADD_RE.flags
    : `${WORKTREE_ADD_RE.flags}g`;
  const matcher = new RegExp(WORKTREE_ADD_RE.source, flags);
  const matches = [];
  for (const match of s.matchAll(matcher)) {
    const commandIndex = gitVerbIndex(match);
    if (!isMatchInCommandSegment(commandIndex, segs)) continue;
    const statement = rawStatementContaining(s, commandIndex, segs);
    if (isGitOrGhHelpStatement(commandSegmentText(statement))) continue;
    matches.push(match);
  }
  return matches;
}

function extractWorktreeAddRawPathWord(cmd, match = null) {
  const s = cmd.toString();
  const m = match ?? gateDWorktreeAddRawMatches(s)[0];
  if (!m) return null;
  const words = scanWorktreeAddRawWords(s.slice(m.index + m[0].length));
  let i = 0;
  while (i < words.length) {
    const width = worktreeAddOptionWidth(shellTokenValue(words[i].raw));
    if (width === 0) return words[i];
    i += width;
  }
  return null;
}

function trustedWorktreeQuotedLiteral(word) {
  if (!word || !word.quotesComplete) return null;
  const raw = word.raw;
  const quote = raw[0];
  if ((quote !== "'" && quote !== '"') || raw.length < 2) return null;

  const closingIndex = raw.indexOf(quote, 1);
  if (closingIndex !== raw.length - 1) return null; // broken or concatenated
  const body = raw.slice(1, -1);
  if (quote === "'") return body; // shell single quotes make the body literal

  // Decoding double-quote escapes or expansions would require shell
  // evaluation. Keep the trust boundary deliberately narrower than that.
  if (/[\\$`]/.test(body)) return null;
  return body;
}

// Token-parse the args of ONE `git worktree add` (the slice after a given
// `worktree add` occurrence) → { branch, base }. Robust to option order
// (`add -b <br> <path> <base>` AND `add <path> -b <br> <base>`) and the `=` form.
function parseOneWorktreeAdd(afterText) {
  const tokens = [];
  const tokenRe = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g;
  for (const m of afterText.matchAll(tokenRe)) {
    if (/^[;|&]/.test(m[1])) break; // stop at the next shell statement boundary
    tokens.push(m[1]);
  }
  let branch = null;
  const positionals = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (/^(?:-b|-B|--branch)=/.test(tok)) { branch = shellTokenValue(tok.replace(/^(?:-b|-B|--branch)=/, "")); i++; continue; }
    if (/^(?:-b|-B|--branch)$/.test(tok)) { branch = shellTokenValue(tokens[i + 1] || ""); i += 2; continue; }
    const width = worktreeAddOptionWidth(tok);
    if (width) { i += width; continue; }
    positionals.push(shellTokenValue(tok)); i++;
  }
  const base = positionals.length >= 2 ? positionals[1] : "HEAD";
  const wtPath = positionals.length >= 1 ? positionals[0] : null;
  return { branch, base, path: wtPath };
}

/**
 * Extract EVERY `git worktree add` branch-create in a command → array of
 * { branch, base }. A command can chain multiple worktree adds (`git worktree
 * add … ; git worktree add …`); the base gates MUST check each, not only the
 * first — a benign leading add otherwise hides a later gated one (issue
 * #851/#848 cross-model round 12). Entries with branch===null (no -b) are kept
 * out (no branch created → nothing for the base gates to check).
 * Robust to option order + `=` form (issue #851/#848 cross-model round 10).
 */
function extractWorktreeAddCreates(cmd) {
  const s = cmd.toString();
  const out = [];
  // Anchor on `git [globals] worktree add` (a real git invocation at a command
  // boundary), NOT a bare `worktree add` substring — otherwise a non-git use of
  // the words (`echo worktree add -b hotfix/x …`) false-blocks (issue #851/#848
  // round-13 regression). The leading-global span mirrors WORKTREE_ADD_RE.
  const RE = new RegExp(
    `${CMD_POSITION_ANCHOR}git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*worktree\\s+add\\b`,
    "g"
  );
  let m;
  while ((m = RE.exec(s)) !== null) {
    // Slice from just AFTER `worktree add` (the matched span ends there).
    const after = s.slice(m.index + m[0].length);
    const parsed = parseOneWorktreeAdd(after);
    if (parsed.branch) out.push(parsed);
  }
  return out;
}

/**
 * Extract the explicit absolute `cd` target that anchors `cmd`, if present —
 * i.e. `cd <abs-path> &&` or `cd <abs-path>;` at the start of the command.
 * Returns the absolute target string, or `null` if there is no such prefix
 * (missing `cd`, non-absolute target, or malformed token).
 */
function extractExplicitAbsCdTarget(cmd) {
  const m = cmd.match(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)/);
  if (!m) return null;
  const target = shellTokenValue(m[1]);
  return path.isAbsolute(target) ? target : null;
}

/**
 * Check if the command has an explicit `cd <abs-path> &&` or `cd <abs-path>;`
 * prefix that anchors the cwd deterministically.
 */
function hasExplicitAbsCdPrefix(cmd) {
  return extractExplicitAbsCdTarget(cmd) !== null;
}

/**
 * Resolve the latest executable `cd` statement before one worktree-add
 * invocation. Unsupported, relative, or dynamic later `cd` statements clear a
 * previously safe anchor so an earlier cwd cannot be reused as stale evidence.
 */
function extractLatestExplicitAbsCdTarget(invocationPrefix) {
  const s = invocationPrefix.toString();
  const segs = safeSegmentCommand(s);
  let latest = null;

  for (const match of s.matchAll(/\bcd\b/g)) {
    if (!isMatchInCommandSegment(match.index, segs)) continue;
    const { start, end } = rawStatementBoundsContaining(s, match.index, segs);
    const statement = rawExecutableStatement(s, start, end, segs);
    if (!/^\s*cd\b/.test(statement)) continue;

    // Only a completed statement proven to have run whenever the following
    // invocation runs is evidence. Ambiguous control flow stays fail closed.
    const separator = s.slice(end);
    if (
      !(separator.startsWith("&&") || separator.startsWith(";")) ||
      !evidenceExecutedWhenInvocationRuns(s, start, end, segs)
    ) {
      latest = null;
      continue;
    }

    const exact = statement.match(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*$/);
    if (!exact) {
      latest = null;
      continue;
    }
    const target = shellTokenValue(exact[1]);
    latest = path.isAbsolute(target) ? target : null;
  }

  return latest;
}

function escapeRegexLiteral(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function variableAssignedToSafeAbsolute(varName, invocationPrefix) {
  try {
    const s = invocationPrefix.toString();
    const segs = safeSegmentCommand(s);
    const valuePattern =
      `("[^"]*"|'[^']*'|\\$\\(\\s*(?:git\\s+rev-parse\\s+--show-toplevel|pwd)\\s*\\)|\\S+)`;
    const escapedName = escapeRegexLiteral(varName);
    const assignRe = new RegExp(`\\b${escapedName}=${valuePattern}`, "g");
    const assignmentValue =
      `(?:"[^"]*"|'[^']*'|\\$\\(\\s*(?:git\\s+rev-parse\\s+--show-toplevel|pwd)\\s*\\)|\\S+)`;
    const assignmentWord = `[A-Za-z_][A-Za-z0-9_]*=${assignmentValue}`;
    const assignmentOnlyRe = new RegExp(
      `^\\s*(?:export\\s+)?${assignmentWord}(?:\\s+${assignmentWord})*\\s*$`
    );
    const targetStartsStatementRe = new RegExp(`^\\s*(?:export\\s+)?${escapedName}=`);
    let latest = null;

    for (const m of s.matchAll(assignRe)) {
      if (!isMatchInCommandSegment(m.index, segs)) continue;
      const { start, end } = rawStatementBoundsContaining(s, m.index, segs);
      const statement = rawExecutableStatement(s, start, end, segs);
      if (!assignmentOnlyRe.test(statement)) {
        if (targetStartsStatementRe.test(statement)) latest = null;
        continue;
      }

      // The assignment must have executed before this invocation. Inline env
      // assignments, help text, `||`, pipes, and background jobs are not proof.
      const separator = s.slice(end);
      if (
        !(separator.startsWith("&&") || separator.startsWith(";") || separator.startsWith("\n")) ||
        !evidenceExecutedWhenInvocationRuns(s, start, end, segs)
      ) {
        latest = null;
        continue;
      }

      const value = shellTokenValue(m[1] || "");
      latest = path.isAbsolute(value) ||
        /^\$\(\s*(?:git\s+rev-parse\s+--show-toplevel|pwd)\s*\)$/.test(value);
    }
    return latest === true;
  } catch {
    return false;
  }
}

/**
 * Returns true if `token` (already quote-stripped by shellTokenValue) expands
 * to an absolute path via a known-safe shell substitution form.
 *
 * Safe forms:
 *   A: $(git rev-parse --show-toplevel)/<sub>
 *   B: $(pwd)/<sub>
 *   C: $VAR/<sub> or ${VAR}/<sub>  — only when VAR is assigned from a safe
 *      source earlier in the same executable invocation prefix.
 */
function looksAbsoluteAfterExpansion(token, invocationPrefix) {
  // Pattern A: $(git rev-parse --show-toplevel)/<sub>
  if (/^\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)\//.test(token)) return true;
  // Pattern B: $(pwd)/<sub>
  if (/^\$\(\s*pwd\s*\)\//.test(token)) return true;
  // Pattern C: $VAR/<sub> or ${VAR}/<sub> — only safe if executable evidence
  // before this invocation assigns VAR from a literal absolute path or a safe
  // cwd source.
  const varMatch = token.match(/^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})\//);
  if (varMatch) {
    const varName = varMatch[1] || varMatch[2];
    if (variableAssignedToSafeAbsolute(varName, invocationPrefix)) return true;
  }
  return false;
}

// Regex to detect safe $(…)/<sub> shell-expansion forms directly in the raw command text,
// in the position where the worktree path arg would appear after `worktree add`.
// This complements extractWorktreeAddPath which operates on segment-processed text
// and cannot reconstruct the original $(…) token after segmentation.
// Handles both unquoted and double-quoted forms:
//   $(git rev-parse --show-toplevel)/<sub>
//   "$(git rev-parse --show-toplevel)/<sub>"
//   $(pwd)/<sub>
//   "$(pwd)/<sub>"
const WORKTREE_ADD_SUBSHELL_EXPANSION_RE =
  /\bworktree\s+add\b(?:\s+(?:"[^"]*"|'[^']*'|-\S+|\S+))*?\s+"?\$\(\s*(?:git\s+rev-parse\s+--show-toplevel|pwd)\s*\)\//;

const WORKTREE_ADD_REPO_ROOT_EXPANSION_RE = new RegExp(
  `${CMD_POSITION_ANCHOR}git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*worktree\\s+add\\b[^;|&\\n]*["']?\\$(?:REPO_ROOT|\\{REPO_ROOT\\})\\/`,
  "g"
);

function hasSafeRepoRootWorktreeAdd(cmd) {
  const segs = segmentCommand(cmd);
  for (const m of cmd.matchAll(WORKTREE_ADD_REPO_ROOT_EXPANSION_RE)) {
    if (
      isMatchInCommandSegment(m.index, segs) &&
      (looksAbsoluteAfterExpansion("$REPO_ROOT/.worktree", cmd) ||
        looksAbsoluteAfterExpansion("${REPO_ROOT}/.worktree", cmd))
    ) {
      return true;
    }
  }
  return false;
}

// Literal `.worktree/` (or exact `.worktree` at end-of-token) suffix check,
// used for shell-expansion forms where the expansion prefix itself
// ($(...), $REPO_ROOT, etc.) cannot be statically resolved to a real path at
// hook-analysis time. We can only look at the literal text immediately AFTER
// the expansion prefix — if it doesn't literally start with `.worktree/`
// (or is exactly `.worktree`) there, we cannot confirm it lands under the
// convention, so the (already-tightened) expansion branches below must fail
// to match (falling through to the relative-path block path) rather than
// guess. This mirrors the "conservative: only literal
// `<expansion>/.worktree/...` passes" design decision (T1).
//
// Reverse-definition word-boundary check (T2, strengthen-worktree-gate-
// word-continuation): after scanning the leading path-char token, the
// character immediately following it (the "boundary character") is NOT
// treated as an unconditional token terminator. Only an ALLOWLIST of
// characters that are genuine shell word/command terminators — whitespace
// (space/tab/newline/CR), `;`, `|`, `&`, `<`, `>` — or end-of-string, cause
// the already-scanned prefix to be accepted for the `.worktree/` check
// below. Any OTHER boundary character (quotes `'`/`"`, backslash `\`,
// variable sigil `$`, backtick, parentheses, and any future/unconsidered
// metacharacter not in the terminator allowlist) is a word-CONTINUATION
// character: the shell keeps splicing text across it into the SAME word, so
// the scanned prefix is not a trustworthy complete token and the function
// returns `false` (fail-closed) rather than guessing. Listing terminators
// positively — instead of blacklisting continuation characters — means a
// newly-introduced shell metacharacter defaults to the safe "not a
// terminator → false" side and can never silently re-open the `.worktree/`
// escape this check exists to close.
function literalSuffixIsWorktree(suffix) {
  if (typeof suffix !== "string") return false;
  // Isolate the leading PATH token by taking only the run of characters that
  // can legitimately appear in an unquoted shell path argument. Callers may
  // pass the entire remaining command text after an expansion (subshell /
  // repoRoot branches slice raw cmd), so anything after the path — a space,
  // a quote, OR a shell metacharacter (`;`/`&`/`|`/`<`/`>`/`(`/`)`/backtick/
  // `#`/`$`/`\`/`*`/`?`/`!` …) — must terminate the token. A no-trailing-slash
  // terminal `..` glued to a metacharacter (`.worktree/..;rm`, `.worktree/..>x`)
  // is NOT collapsed by path.posix.normalize (only `..` + `/` or end-of-string
  // collapses), so without cutting at the metacharacter the escape (resolves to
  // the repo root) would slip past as a false allow. Whitelisting the safe path
  // charset (rather than blacklisting metacharacters) means a newly-considered
  // metacharacter can never silently re-open this gap.
  const tokenMatch = suffix.match(/^[A-Za-z0-9/._\-~@+=:%]*/);
  const token = tokenMatch ? tokenMatch[0] : "";
  // Reverse-definition boundary check: the character right after the scanned
  // token decides whether the token is a trustworthy complete word. Only the
  // allowlisted terminator set (whitespace/tab/newline/CR, `;`, `|`, `&`,
  // `<`, `>`) or end-of-string qualifies; everything else is a
  // word-continuation character (quote/backslash/`$`/backtick/paren/etc.)
  // and must fail closed — the scanned prefix cannot be trusted as the full
  // path because the shell would keep concatenating past this boundary.
  const boundaryChar = suffix.charAt(token.length);
  const isTerminator = boundaryChar === "" || /^[ \t\r\n;|&<>]$/.test(boundaryChar);
  if (!isTerminator) return false;
  if (!/^\.worktree(\/|$)/.test(token)) return false;
  // Reject `.worktree/../…` escapes: the literal-prefix check above only
  // confirms the token STARTS with `.worktree/`, but a `..` segment further
  // in (e.g. `.worktree/../.claude/worktrees/x`) resolves OUTSIDE `.worktree/`
  // once normalized. After stripping `.`/`..` segments, the token must
  // STILL be exactly `.worktree` or start with `.worktree/`.
  const normalized = path.posix.normalize(token);
  return normalized === ".worktree" || normalized.startsWith(".worktree/");
}

// True iff `token` is an expansion-prefixed token (e.g.
// `$REPO_ROOT/.worktree/foo`, `$(pwd)/.worktree/foo`) whose literal text
// AFTER the first `/` is `.worktree/` (or exactly `.worktree`). Used for the
// extracted-token branches ((1) looksAbsoluteAfterExpansion(wtPath,
// invocationPrefix) and (3) looksAbsoluteAfterExpansion(rawWtPath,
// invocationPrefix)) where extractWorktreeAddPath
// preserves the expansion token verbatim (Pattern C: $REPO_ROOT/${REPO_ROOT}).
function expansionTokenWorktreeSuffixMatches(token) {
  if (typeof token !== "string") return false;
  const slashIdx = token.indexOf("/");
  if (slashIdx === -1) return false;
  return literalSuffixIsWorktree(token.slice(slashIdx + 1));
}

// True iff `cmd` contains a `$(git rev-parse --show-toplevel)/` or `$(pwd)/`
// subshell-expansion form (optionally quoted) as the worktree-add path arg,
// where the LITERAL text immediately following the expansion is `.worktree/`
// (or exactly `.worktree`). Re-derives the match via
// WORKTREE_ADD_SUBSHELL_EXPANSION_RE so the suffix check inspects the actual
// raw command text rather than the (segment-mangled) extracted wtPath token
// — segmentation strips the `$(...)` wrapper before extractWorktreeAddPath
// ever sees it (see comment below), so the suffix must be read off the raw
// cmd string here instead.
function subshellExpansionWorktreeSuffixMatches(cmd) {
  const s = cmd.toString();
  const m = WORKTREE_ADD_SUBSHELL_EXPANSION_RE.exec(s);
  if (!m) return false;
  const suffix = s.slice(m.index + m[0].length);
  return literalSuffixIsWorktree(suffix);
}

// True iff `cmd` contains a `$REPO_ROOT/` or `${REPO_ROOT}/` worktree-add
// path arg (per WORKTREE_ADD_REPO_ROOT_EXPANSION_RE) where the LITERAL text
// immediately following is `.worktree/` (or exactly `.worktree`).
function repoRootExpansionWorktreeSuffixMatches(cmd) {
  const s = cmd.toString();
  WORKTREE_ADD_REPO_ROOT_EXPANSION_RE.lastIndex = 0;
  const m = WORKTREE_ADD_REPO_ROOT_EXPANSION_RE.exec(s);
  if (!m) return false;
  const suffix = s.slice(m.index + m[0].length);
  return literalSuffixIsWorktree(suffix);
}

// Resolve repo-root via `gitCommonDir` (handles both a plain repo's own
// `.git` and a linked worktree's `--git-common-dir` pointing at
// `<main-repo>/.git` — `path.dirname` of either yields the main repo root).
// Returns "" when resolution fails (non-git cwd, command failure) — callers
// MUST treat "" as fail-open (SC3/R4).
function resolveRepoRootForWorktreeGate(baseCwd) {
  const commonDir = gitCommonDir(baseCwd);
  if (!commonDir) return "";
  const root = path.dirname(commonDir);
  return root || "";
}

// Realpath-resolve `p`, walking up to the deepest EXISTING ancestor and
// re-appending the (possibly multi-segment) non-existent remainder — unlike
// `resolveSafe`, which only tolerates a single non-existent leaf level. A
// brand-new `git worktree add <target>` is, by definition, non-existent, and
// its parent `.worktree/` dir may ALSO not exist yet (first worktree in a
// repo), so two levels can be missing simultaneously.
function resolveDeepSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    const resolved = path.resolve(p);
    const segments = [];
    let cur = resolved;
    while (true) {
      try {
        return path.join(realpathSync(cur), ...segments);
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) return resolved; // reached filesystem root, give up
        segments.unshift(path.basename(cur));
        cur = parent;
      }
    }
  }
}

// True iff `absWtPath` (already absolute) resolves to a path under
// `<repoRoot>/.worktree/` (or IS exactly `<repoRoot>/.worktree`). Uses
// `path.sep`-bounded comparison (not a bare string startsWith) so a sibling
// directory whose name merely has repoRoot as a *string prefix* (e.g.
// `<repoRoot>-evil/.worktree/x`) is correctly rejected.
function isUnderRepoRootWorktreeDir(absWtPath, repoRoot) {
  if (!repoRoot) return false; // repo-root unresolved → caller fail-opens, not this fn
  // repoRoot is already realpath'd (via gitCommonDir → resolveSafe).
  // absWtPath must be realpath'd the same way for the comparison to be
  // meaningful when the OS temp dir (or another ancestor) is itself a
  // symlink (e.g. macOS /tmp → /private/tmp) — otherwise two paths that are
  // the SAME real directory would compare unequal as plain strings.
  const resolvedWt = resolveDeepSafe(absWtPath);
  const worktreeRoot = path.resolve(repoRoot, ".worktree");
  return resolvedWt === worktreeRoot || resolvedWt.startsWith(worktreeRoot + path.sep);
}

function checkWorktreeAbsolutePath(cmd, baseCwd) {
  // Keep the per-invocation decision body lexically inside the public Gate D
  // function so the existing containment/diagnostic grep lock still guards
  // every invocation while the outer loop checks all real adds in order.
  function checkOneWorktreeAbsolutePath(cmd, fullCmd, invocationPrefix, rawMatch, baseCwd) {
    const cmdText = gateCommandSegmentText(cmd);
    if (!WORKTREE_ADD_RE.test(cmdText)) return null;
    const wtPath = extractWorktreeAddPath(cmdText);
    if (!wtPath) return null; // can't parse path → fail-open
    const rawWtPath = extractWorktreeAddPath(cmd.toString());
    const rawPathWord = extractWorktreeAddRawPathWord(fullCmd, rawMatch);
    const trustedQuotedLiteral =
      wtPath === "__QUOTED__" ? trustedWorktreeQuotedLiteral(rawPathWord) : null;
    const decisionWtPath = trustedQuotedLiteral ?? wtPath;
    const rawPathStartsQuoted = rawPathWord && /^["']/.test(rawPathWord.raw);
    const hasUntrustedQuotedToken =
      trustedQuotedLiteral === null &&
      (wtPath === "__QUOTED__" || rawPathStartsQuoted);
    const displayWtPath = hasUntrustedQuotedToken
      ? "quoted/dynamic worktree path"
      : decisionWtPath;

    if (path.isAbsolute(decisionWtPath)) {
      // Already absolute — but MUST also live under <repo-root>/.worktree/
      // (SC1). If repo-root can't be resolved (non-git cwd / command
      // failure), fail-open — consistent with the gate's existing
      // `!wtPath → fail-open` posture (R4).
      // The worktree belongs to the repository git runs in: `git -C <dir>` or an explicit `cd` before it, not the
      // payload cwd (#3556). An unresolvable target keeps the payload cwd, as before.
      const gitCwd = commandCwdForGitMatch(fullCmd, rawMatch[0], baseCwd, gitVerbIndex(rawMatch));
      const repoRoot = resolveRepoRootForWorktreeGate(gitCwd === UNRESOLVABLE_CWD ? baseCwd : gitCwd);
      if (!repoRoot) return null; // fail-open: repo-root unresolvable
      // Git Bash spells C:\repo as /c/repo; on win32 map it before comparing
      // with the git-reported root (no-op elsewhere). Only the comparison
      // sees the mapped form — the block reason below keeps the typed path.
      if (isUnderRepoRootWorktreeDir(normalizeGitBashDrivePath(decisionWtPath), repoRoot)) return null; // pass
      return {
        block: true,
        reason:
          `Worktree Absolute Path Gate：路徑 ${displayWtPath} 不在 <repo-root>/.worktree/ 根層。git worktree add 路徑必須落在 <repo-root>/.worktree/<change-name>（規範根層慣例），如 /Users/<name>/Documents/Repos/<repo>/.worktree/<change-name>；不得用其他絕對路徑（如 .claude/worktrees/），避免 cwd 黏滯導致 nested worktree（PR #395 evidence）。`,
      };
    }

    // Two-stage shell-expansion check (covers different token-extraction paths):
    //
    //   (1) looksAbsoluteAfterExpansion(wtPath, invocationPrefix) —
    //       segment-extracted token form with statement-local temporal evidence
    //       Pattern A/B ($(...) forms): currently DEAD-BRANCH under existing
    //         commandSegmentText behaviour — segment strips $() so wtPath never
    //         retains the literal $(...) prefix. Kept for forward-compat: if
    //         extractWorktreeAddPath / segmentation later preserves single-token
    //         $() expansions, this branch starts hitting without code change.
    //       Pattern C ($REPO_ROOT/${REPO_ROOT}): HIT in current behaviour —
    //         segment passes variable refs through; this is the only effective
    //         match path for `REPO_ROOT=$(...) && git worktree add $REPO_ROOT/...`.
    //
    //   (2) WORKTREE_ADD_SUBSHELL_EXPANSION_RE.test(cmd) — raw-cmd regex fallback
    //       HIT in current behaviour for $() forms — covers `git worktree add
    //       $(git rev-parse --show-toplevel)/...` and `$(pwd)/...` (with optional
    //       outer quotes). This is the effective match path for D-P2/D-P3/D-P4.
    //
    // Both must remain: (1) for $REPO_ROOT, (2) for $() forms.
    //
    // Tightened (T1/R2): the expansion prefix cannot be statically resolved to
    // a real filesystem path at hook-analysis time — we can only inspect the
    // LITERAL text following the expansion. Each branch below now ALSO requires
    // a literal `.worktree/` suffix match before passing, so
    // `$(pwd)/.claude/worktrees/x` no longer free-rides through on "it's an
    // expansion" alone. Conservative by design: expansion forms whose literal
    // suffix does NOT contain `.worktree/` fall through to the relative-path
    // block path rather than being guessed as safe.
    if (looksAbsoluteAfterExpansion(wtPath, invocationPrefix) && expansionTokenWorktreeSuffixMatches(wtPath)) return null;
    if (hasSafeRepoRootWorktreeAdd(cmd) && repoRootExpansionWorktreeSuffixMatches(cmd)) return null;
    if (rawWtPath && looksAbsoluteAfterExpansion(rawWtPath, invocationPrefix) && expansionTokenWorktreeSuffixMatches(rawWtPath)) return null;
    if (WORKTREE_ADD_SUBSHELL_EXPANSION_RE.test(cmd) && subshellExpansionWorktreeSuffixMatches(cmd)) return null;

    // A quoted token that was not proven literal must not gain trust from the
    // placeholder's apparent relative value or an explicit-cd containment pass.
    if (hasUntrustedQuotedToken) {
      return {
        block: true,
        reason:
          `Worktree Absolute Path Gate：${displayWtPath} 無法靜態證明為完整且安全的 literal absolute path。git worktree add 路徑必須落在 <repo-root>/.worktree/<change-name>（規範根層慣例），如 /Users/<name>/Documents/Repos/<repo>/.worktree/<change-name>，避免 cwd 黏滯導致 nested worktree（PR #395 evidence）。`,
      };
    }

    // Relative path: check if an explicit abs cd prefix anchors the cwd.
    // The anchored cwd makes the effective (post-cd) absolute path
    // deterministic — but that effective path MUST STILL satisfy the SAME
    // `.worktree/` boundary invariant as the already-absolute branch above
    // (SC-abs-cd): otherwise `cd <repo-root> && git worktree add
    // .claude/worktrees/x` would silently bypass the invariant this gate
    // exists to enforce, purely by routing through an abs `cd` prefix instead
    // of a literal absolute worktree-add path.
    const cdTarget = extractLatestExplicitAbsCdTarget(invocationPrefix);
    if (cdTarget) {
      // Same win32 drive mapping as the literal branch. Unmapped, `/c/<repo>`
      // resolves to no repo root, so the fail-open below let any relative
      // path through a Git Bash `cd` anchor (#2841).
      const hostCdTarget = normalizeGitBashDrivePath(cdTarget);
      const effectiveAbs = path.resolve(hostCdTarget, decisionWtPath);
      const repoRoot = resolveRepoRootForWorktreeGate(hostCdTarget);
      if (!repoRoot) return null; // fail-open: repo-root unresolvable from cd anchor
      if (isUnderRepoRootWorktreeDir(effectiveAbs, repoRoot)) return null; // pass
      return {
        block: true,
        reason:
          `Worktree Absolute Path Gate：路徑 ${effectiveAbs} 不在 <repo-root>/.worktree/ 根層。git worktree add 路徑必須落在 <repo-root>/.worktree/<change-name>（規範根層慣例），如 /Users/<name>/Documents/Repos/<repo>/.worktree/<change-name>；不得用其他絕對路徑（如 .claude/worktrees/），避免 cwd 黏滯導致 nested worktree（PR #395 evidence）。`,
      };
    }

    // A path with a variable that none of the forms above accepted is not a
    // relative path; say what the gate can confirm instead (#3507).
    if (decisionWtPath.includes("$")) {
      return {
        block: true,
        reason:
          `Worktree Absolute Path Gate：路徑 ${displayWtPath} 含 shell 變數，hook 無法確認它展開後落在 <repo-root>/.worktree/（變數後面直接接字面 \`.worktree/<change-name>\` 才確認得了）。請改用字面絕對路徑（如 /Users/<name>/Documents/Repos/<repo>/.worktree/<change-name>）、\`$(git rev-parse --show-toplevel)/.worktree/<change-name>\`，或同一指令賦值的 \`$REPO_ROOT/.worktree/<change-name>\`（git-branch-naming-and-anchor.md §Worktree 規範）。`,
      };
    }

    // Relative path with no anchor → block
    return {
      block: true,
      reason:
        `Worktree Absolute Path Gate：路徑 ${displayWtPath} 為相對路徑，且無 explicit absolute cd 前綴可錨定 cwd。git worktree add 路徑必須落在 <repo-root>/.worktree/<change-name>（規範根層慣例），如 /Users/<name>/Documents/Repos/<repo>/.worktree/<change-name>，避免 cwd 黏滯導致 nested worktree（PR #395 evidence）。`,
    };
  }

  const fullCmd = cmd.toString();
  const segs = safeSegmentCommand(fullCmd);
  for (const rawMatch of gateDWorktreeAddRawMatches(fullCmd)) {
    const commandIndex = gitVerbIndex(rawMatch);
    const statement = rawStatementContaining(fullCmd, commandIndex, segs);
    const invocationPrefix = fullCmd.slice(0, commandIndex);
    const result = checkOneWorktreeAbsolutePath(statement, fullCmd, invocationPrefix, rawMatch, baseCwd);
    if (result) return result;
  }
  return null;
}

// Gate D' (T11) — Worktree Post-Creation CD Gate ─────────────────────────
// After PostToolUse writes a pending-cd-to-worktree sentinel, the NEXT
// Bash invocation (PreToolUse) checks whether the command begins with
// `cd <absWtPath>`. If not, emit a warn-only advisory (D8 first-iteration
// warn-only — no block).
//
// Sentinel lifecycle:
//   Written by: post-tool-gate.mjs PostToolUse (after git worktree add succeeds)
//   Cleared by: (a) this check when cd matches; (b) TTL expiry (scan here);
//               (c) session-start.mjs TTL sweep.
//
// Cross-runtime support:
//   - subagent CLI host: full support (PostToolUse writes sentinel + PreToolUse reads)
//   - CLI agent host:    full support (sync via runtime hooks config PostToolUse)
//   - Cursor:      PARTIAL — Cursor architecture lacks postToolUse event,
//                  sentinel write point unavailable. Gate D' degrades to no-op
//                  on Cursor. Acceptable per rule-design-principles.md 守則 1
//                  cross-runtime parity "best-effort" qualification: Cursor
//                  session token-context already smaller, statusline issue less
//                  acute. See Hook Event Coverage Matrix in rule-design-principles.md.

function pathsMatch(a, b) {
  if (!a || !b) return false;
  const normalize = (p) => {
    const abs = path.isAbsolute(p) ? p : path.resolve(p);
    return resolveSafe(abs).replace(/\/+$/, "");
  };
  return normalize(a) === normalize(b);
}

function checkPendingWorktreeCd(cmd, baseCwd = "") {
  const sentinels = scanPendingCdSentinels(); // also clears expired
  if (sentinels.length === 0) return null;

  // Check if this command is `cd <absWtPath>` (possibly followed by &&)
  // Match: cd /abs/path  OR  cd /abs/path && ...  OR  cd /abs/path; ...
  const cdMatch = cmd.match(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)/);
  const cdTarget = cdMatch ? shellTokenValue(cdMatch[1]) : null;
  const effectivePayloadCwd = baseCwd && path.isAbsolute(baseCwd) ? baseCwd : null;

  const matchedSentinels = [];
  const unmatchedSentinels = [];

  for (const s of sentinels) {
    const cdAbs = cdTarget && path.isAbsolute(cdTarget) ? cdTarget : null;
    // Match: either literal cd target or the effective tool cwd/workdir
    // already points at the pending worktree. The latter matters for Codex,
    // where the tool runner can execute inside a worktree while the Bash
    // command text itself does not contain `cd <worktree>`.
    const isMatch =
      (cdAbs !== null && pathsMatch(cdAbs, s.absPath)) ||
      (effectivePayloadCwd !== null && pathsMatch(effectivePayloadCwd, s.absPath));
    if (isMatch) {
      matchedSentinels.push(s);
    } else {
      unmatchedSentinels.push(s);
    }
  }

  // Clear matched sentinels
  for (const s of matchedSentinels) {
    clearPendingCdSentinel(s.absPath);
  }

  if (unmatchedSentinels.length === 0) return null;

  // Warn-only (D8): surface advisory for first unmatched sentinel
  const s = unmatchedSentinels[0];
  const wtPath = s.absPath;

  // ONE-SHOT: clear all unmatched sentinels after first warn (D8 semantics).
  // Prevents every subsequent Bash invocation from repeating the advisory;
  // user has received the warning once and that is sufficient.
  for (const u of unmatchedSentinels) {
    clearPendingCdSentinel(u.absPath);
  }

  return {
    advisory:
      `Worktree Post-Creation CD：偵測到 git worktree add ${wtPath} 後未 cd 進入該 worktree。AI 應 cd ${wtPath} 一次後續 Bash 自動繼承（持續 cwd），避免 statusline 誤導與後續 worktree add 黏滯 nested。Sentinel TTL 1 day。`,
  };
}

// 軟提醒（非 block）：safety + token-frugal nudges。基於 30-day telemetry
// （/tmp/token-telemetry.mjs）：實際 outliers 多屬「忘加 limit/filter」型，hard
// block ROI 低；本層用 advisory 提醒，trust AI 看到後自我修正。
function checkAdvisories(cmd, baseCwd, { toolInput, payload } = {}) {
  const cmdText = gateCommandSegmentText(cmd);
  // Uncertain protected-branch write (fail-open-on-uncertainty): a git write
  // whose target cwd/branch could not be statically resolved is NOT hard-blocked
  // (that would risk halting a legitimate workflow); surface a non-blocking
  // reminder instead. Only fires when no hard gate already blocked (advisory is
  // the chain's last step). issue #851/#848 — accident-prevention threat model.
  try {
    const v = protectedGitWriteViolation(cmd, baseCwd);
    if (v && v.uncertain) {
      // Same cwd evidence snapshot as the protected-branch block exits; the
      // wrapper is fail-open, so a failure omits only this line.
      const evidenceLine = protectedCwdEvidenceLine({
        toolInput,
        payload,
        baseCwd,
        violation: v,
        matchText: v.matchText,
      })?.line;
      return {
        advisory:
          "⚠️ 偵測到 git 寫入命令，但無法靜態判定其目標分支/目錄（命令含 `$()`/pipe/subshell、`pushd`/變數 `cd`、`--git-dir` 等不可解析形式）。若你正在 **保護分支（main/production/...）** 上，請改用 worktree（`git worktree add <repo-root>/.worktree/<name> -b <prefix>/<name>`）或 `git -C <worktree>` 後再寫入；確認無誤可忽略本提醒。" +
          (evidenceLine ? `\n\n${evidenceLine}` : ""),
      };
    }
  } catch { /* fail-open: advisory must never block */ }
  // Safety: --no-verify
  if (/git\s+commit[\s\S]*--no-verify\b/.test(cmdText)) {
    return {
      advisory:
        "⚠️ `git commit --no-verify` 跳過 pre-commit hook。除使用者明確要求外不應使用（per `ai-autonomy.md` §Never：禁跳過 hook 機制）。",
    };
  }
  // Safety + dev-flow-checklist nudge: gh pr create
  const prWorkflow = prCreateWorkflowAdvisory(cmdText);
  if (prWorkflow) {
    return { advisory: prWorkflow };
  }
  // Dev-flow-checklist nudge: git push（force-push 等 hard-block 已在更前面攔截，
  // 這裡只在無 hard-block 時才會被呼叫；--dry-run 不提醒）
  const pushWorkflow = gitPushWorkflowAdvisory(cmd, cmdText);
  if (pushWorkflow) {
    return { advisory: pushWorkflow };
  }
  // Token-frugal: git log 無 limit
  // 命中：純 `git log` 或 `git log <ref>` 不帶 -N / -<num> / --max-count / --oneline / -- path
  if (
    /(?:^|[\s;|&(])\s*git\s+log\b/.test(cmdText) &&
    !/--max-count\b|-\d+|--oneline\b|--stat\b|--name-only\b|--name-status\b|--\s+\S/.test(cmdText) &&
    !/\|\s*(?:head|tail)\s+-\d+/.test(cmdText)
  ) {
    return {
      advisory:
        "⚠️ `git log` 未加 `--max-count=<N>` / `-<N>` / `--oneline` 或 path filter。token-frugal-io.md 建議加 `-30 --oneline` 或 `| head -50` 限制輸出。",
    };
  }
  // Token-frugal: git diff 純 unbounded（無 path、無 --stat、無 --name-only、無 pipe head/tail）
  if (
    /(?:^|[\s;|&(])\s*git\s+diff\s*$|(?:^|[\s;|&(])\s*git\s+diff\s+(?:HEAD|main|production|origin\/\S+|\S+\.\.\S+)\s*$/m.test(
      cmdText.split(/[;|&]|&&/)[0].trim()
    )
  ) {
    return {
      advisory:
        "⚠️ `git diff` 未加 path filter / `--stat` / `--name-only`。大型 PR 可能輸出 >10KB；建議 `git diff --stat` 先看摘要、再針對檔案 `git diff -- <path>`。",
    };
  }
  // Token-frugal: gh repo view 缺 --json filter
  if (
    /(?:^|[\s;|&(])\s*gh\s+repo\s+view\b/.test(cmdText) &&
    !/--json\b/.test(cmdText)
  ) {
    return {
      advisory:
        "⚠️ `gh repo view` 未加 `--json <fields>` 篩選——預設輸出含 README 全文（可達 20KB+）。建議 `--json name,description,defaultBranchRef`。",
    };
  }
  // Token-frugal: gh api /readme 或 /contents/ 缺 --jq
  if (
    /(?:^|[\s;|&(])\s*gh\s+api\s+\S*(?:readme|contents\/)/.test(cmdText) &&
    !/--jq\b/.test(cmdText)
  ) {
    return {
      advisory:
        "⚠️ `gh api .../{readme,contents}` 未加 `--jq` 篩選——回傳含 base64 全文 + metadata（可達 50KB+）。建議 `--jq '.download_url'` 取連結後 `curl | head`。",
    };
  }
  return null;
}

// ── Gate W (T12-T14) — Worktree Mandatory + Three-Way Name Alignment ────
//
// W1  (Bash): block in-place branch creation or plain branch checkout/switch
//             of any branch when in main worktree (action-based, no prefix
//             filter; checkout of a protected mainline branch passes). Per
//             git-branch-naming-and-anchor.md §Worktree 規範「所有在主 worktree
//             開/切換分支…一律走 worktree，無前綴例外」.
// W2a (Bash): on `git worktree add <path> -b <prefix>/<name>`, verify
//             basename(<path>) === <name>. Per the same rule file: branch naming under
//             「分支前綴對照表」 and the path convention under 「Worktree 規範」.
// W2b (File): on Edit/Write to `openspec/changes/<X>/proposal*.md` while in
//             a sub-worktree, verify <X> === branch-name segment === worktree
//             dir basename. 3-way alignment per the same two sections.
// Bash gates accept inline DEVPRO_HOOK_BYPASS=1 bypass (handled in main()).
//
// Why these gates:
//   PR1 (PR #518) strengthened the rule wording cross-runtime; these gates add
//   mechanical teeth for hook-capable runtimes. Empirical
//   trigger: chore/improve-onboarding-detection-step-0 violated worktree
//   mandatory by `git switch -c` directly on main worktree.

const MANDATORY_PREFIX_RE = /^(?:feature|bugfix|chore|hotfix)\//;
// The create-flag→name separator is `(?:\s+|=)`, not `\s+`: the equals form
// (`switch --create=chore/x`, `checkout -b=chore/x`) creates a branch just like
// the space form and MUST be gated, mirroring extractBranchNameFromCommand's
// `(?:\s+|=)` and the `Branch Force-Create Verb Coverage` spec (issue #851/#848
// round 8 — the space-only form let a valid-named create escape W1).
const IN_PLACE_BRANCH_CREATE_RE =
  new RegExp(`${CMD_POSITION_ANCHOR}git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*(?:checkout\\s+(?:-[bB]|--orphan)|switch\\s+(?:-[cC]|--create|--force-create))(?:\\s+|=)(\\S+)`);
const IN_PLACE_BRANCH_CHECKOUT_RE =
  new RegExp(`${CMD_POSITION_ANCHOR}git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*(?<checkoutVerb>checkout|switch)\\b(?:\\s+-(?:[A-Za-z]|-[A-Za-z-]+))*\\s+(?<checkoutRef>-(?=[\\s|&;)]|$)|(?!-)[^\\s|&;]+)(?:\\s+(?<pathspecSep>--)(?=\\s|$))?`);
// `-` and `@{-N}` name "the branch checked out N switches ago". W1 resolves which branch that is and treats the
// checkout as a checkout of that branch (see previousBranchForShorthand).
const PREVIOUS_BRANCH_SHORTHAND_RE = /^(?:-|@\{-\d+\})$/;
const WORKTREE_RULE_REL = ".devpro/agent-rules/git-branch-naming-and-anchor.md";

function isInsideSubWorktree(absPath) {
  return absPath.includes(`${path.sep}.worktree${path.sep}`);
}

// Skip W gates entirely when the repo doesn't carry the worktree rule SoT
// (test fixtures, unrelated repos). Source repo + synced consumers carry it.
function repoHasWorktreeRule(cwd) {
  const repoRoot = getRepoRoot(cwd);
  // Guard the empty-string fail-open (see repoRootForBranchNamingRule): a "" root
  // would make path.join resolve relative to process.cwd() — return null instead.
  if (!repoRoot) return null;
  return existsSync(path.join(repoRoot, WORKTREE_RULE_REL)) ? repoRoot : null;
}

// Directory name for the suggested `.worktree/<segment>`: the part after the first slash for a
// `<prefix>/<segment>` name, the whole name when it has no prefix.
function worktreeSegmentForBranch(branchName) {
  return branchName.includes("/") ? branchName.split("/").slice(1).join("/") : branchName;
}

// Multi-occurrence: evaluate EVERY create occurrence, not just the first. A benign /
// exempt leading occurrence (e.g. one matched inside a non-command segment) MUST NOT
// mask a later real branch-create in a command segment. Mirrors checkGitProtectedWrite
// (every `git merge/pull main`, every `git worktree add` create, etc. per the
// `pre-tool-mechanical-gates` "check EVERY occurrence, not just the first" requirement).
// Issue #899 finding (a). Block on the FIRST occurrence that survives all exemptions.
function checkWorktreeMandatoryForBranchCreate(cmd, baseCwd) {
  const segs = safeSegmentCommand(cmd);
  for (const m of cmd.matchAll(new RegExp(IN_PLACE_BRANCH_CREATE_RE.source, "g"))) {
    // Segment check at the git VERB position (not m.index, which the CMD_POSITION_ANCHOR
    // boundary char may push onto a separator / subshell-marker segment).
    if (segs && !isMatchInCommandSegment(gitVerbIndex(m), segs)) continue;

    const branchName = m[1].replace(/^["']|["']$/g, "");

    // Allow if already inside a sub-worktree (.worktree/<x>/). The verb index is required: m[0] starts at the
    // boundary character, so without it a leading `cd <dir> &&` is cut mid-`&&`, reads as a background `&`,
    // and the cwd comes back unresolvable — which this gate skips on.
    const cwdAbs = resolveSafe(commandCwdForGitMatch(cmd, m[0], baseCwd || process.cwd(), gitVerbIndex(m)));
    if (isInsideSubWorktree(cwdAbs)) continue;

    // Only enforce in repos that carry the worktree SoT (skip unrelated repos / tests)
    if (!repoHasWorktreeRule(cwdAbs)) continue;

    const segment = worktreeSegmentForBranch(branchName);
    return {
      block: true,
      reason: `Worktree Mandatory For Branch Create gate：在主 worktree 偵測 \`${m[0].trim()}\`，所有開/切分支一律 worktree，無前綴例外（per git-branch-naming-and-anchor.md §Worktree 規範）。\n\n請改走：\n  REPO_ROOT=$(git rev-parse --show-toplevel)\n  git worktree add "$REPO_ROOT/.worktree/${segment}" -b ${branchName} <anchor>\n  cd "$REPO_ROOT/.worktree/${segment}"\n\n${HOOK_BYPASS_HINT}`,
    };
  }
  return null;
}

// The branch a previous-branch shorthand (`-`, `@{-N}`) names when the checkout at `m` runs, or null when the
// hook cannot tell.
function previousBranchForShorthand(cmd, m, shorthand, cwdAbs) {
  const before = cmd.toString().slice(0, gitVerbIndex(m));
  if (new RegExp(`${CMD_POSITION_ANCHOR}${GIT_WITH_C}(?:checkout|switch)\\b`).test(before)) return null;
  const ordinal = shorthand === "-" ? 1 : Number(shorthand.slice(3, -1));
  const name = gitOutput(cwdAbs, ["rev-parse", "--abbrev-ref", `@{-${ordinal}}`]);
  return name && !name.startsWith("@") ? name : null;
}

function isWorkingTreeOrTrackedPath(cwdAbs, token) {
  if (existsSync(path.resolve(cwdAbs, token))) return true;
  // A tracked file deleted from the working tree is the usual thing `git checkout <path>` restores.
  return Boolean(gitOutput(cwdAbs, ["--literal-pathspecs", "ls-files", "--", token]));
}

// `git checkout HEAD` with nothing but path arguments after it. An option between `checkout` and `HEAD`, or after
// `HEAD` up to the next separator, can make it leave the branch (`git checkout --detach HEAD`, `git checkout HEAD -b
// <name>`), so either keeps the normal evaluation. Git global options before the verb are not looked at.
function isBareHeadCheckout(cmd, m, ref) {
  if (ref !== "HEAD" || !/\bcheckout\s+HEAD$/.test(m[0])) return false;
  const rest = cmd.slice(m.index + m[0].length).split(/[;|&\n\r)]/, 1)[0];
  return !/(?:^|\s)-/.test(rest);
}

// A ref that names a pinned commit rather than a branch. `git checkout <tag>` / `git checkout <40-hex>` moves the
// HEAD of a detached worktree without creating or switching a branch. Branch-ness wins over everything else:
// `show-ref --verify --quiet refs/heads/<ref>` (and refs/remotes) is judged by EXIT CODE, so `core.warnAmbiguousRefs`
// cannot flip the verdict, and a 40-hex name that a local branch shadows stays a branch.
const SHA40_RE = /^[0-9a-f]{40}$/;

function gitRefExists(cwd, refPath) {
  try {
    const result = spawnSync("git", ["show-ref", "--verify", "--quiet", refPath], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

// `git checkout` accepts `x`, `heads/x`, `tags/x`, `refs/heads/x`, `refs/tags/x` and `refs/remotes/x`; build the ref
// paths from the same token so `tags/x` is not looked up as `refs/tags/tags/x`.
// `git checkout <name>` resolves a positional ref through: local branch `refs/heads/<name>`
// (a same-named tag loses), then the dwim chain `refs/<name>`, `refs/tags/<name>`,
// `refs/remotes/<name>`, `refs/remotes/<name>/HEAD`; a 40-hex literal detaches. The FIRST
// existing candidate is what the checkout actually uses, so the classifier follows that
// order instead of rewriting the token (review finding F1: with a branch `tags/v1`,
// `git checkout tags/v1` selects `refs/heads/tags/v1`, not the tag).
function checkoutRefCandidates(token) {
  if (token.startsWith("refs/")) {
    // A fully qualified token is still shadowed by a local branch of that literal name
    // (`refs/heads/refs/tags/v1`), which git checkout selects; the remote veto applies too.
    return [`refs/heads/${token}`, `refs/remotes/${token}`, token];
  }
  // Order: local branch veto, remote-tracking veto, then the `refs/<name>` dwim chain.
  return [
    `refs/heads/${token}`,
    `refs/remotes/${token}`,
    `refs/remotes/${token}/HEAD`,
    `refs/${token}`,
    `refs/tags/${token}`,
  ];
}

function isPinnedCommitRef(cwd, token) {
  // Verify existence (not only shape) so a token that names no ref at all keeps the normal
  // W1 evaluation; the classification then follows Git's own candidate order.
  for (const candidate of checkoutRefCandidates(token)) {
    if (!gitRefExists(cwd, candidate)) continue;
    if (candidate.startsWith("refs/tags/")) return true;
    return false; // refs/heads/…, refs/remotes/…, or any other existing ref: not a pinned pointer
  }
  return SHA40_RE.test(token);
}

// Parent `.gitmodules` `path =` values, read by Git's own config reader: `-z` separates records with NUL and splits
// key/value with a newline, so a subsection name containing spaces stays unambiguous, and git's config grammar
// (comments, quoted values, any key case) is honoured instead of a hand-rolled parser. Returns null when the file is
// missing, unreadable or unparsable — callers fail closed.
function registeredSubmodulePaths(parentRoot) {
  try {
    const result = spawnSync(
      "git",
      ["-C", parentRoot, "config", "-z", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    const registered = [];
    for (const record of result.stdout.split("\0")) {
      if (!record) continue;
      const newline = record.indexOf("\n");
      if (newline <= 0) continue;
      if (!/^submodule\..*\.path$/.test(record.slice(0, newline))) continue;
      // Keep the value exactly as git decoded it: leading/trailing spaces and names such as
      // `..rules` are legitimate path names (trim() / startsWith("..") would reject them).
      const raw = record.slice(newline + 1).replace(/\/+$/, "");
      if (!raw) continue;
      const normalized = path.posix.normalize(raw);
      // Only genuine traversal is dropped: the path itself, or a `..` SEGMENT.
      if (normalized === "." || normalized === "..") continue;
      if (normalized.split("/").some((segment) => segment === "..")) continue;
      if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) continue;
      registered.push(normalized);
    }
    return registered;
  } catch {
    return null;
  }
}

// A branch-creating flag anywhere in the SAME simple command makes the occurrence a branch create, whatever the
// positional ref is (`git checkout <tag> -b x`, `git switch <tag> -c x`). The create gates only catch the flag
// immediately after the verb, so the scoped submodule exception must refuse these forms itself.
// Short options may be COMBINED (`-qb <name>`, `-qB <name>`): git treats the `b`/`B` inside a
// combined short cluster as the create flag. Match any short cluster that contains the flag.
const CHECKOUT_CREATE_FLAG_RE = /(?:^|[\s;|&(])-[A-Za-z]*[bB][A-Za-z]*|(?:^|[\s;|&(])--orphan(?=[\s=]|$)/;
// `switch` uses -c/-C as its create flags, with or without an attached name; git's own
// global `-c`/`-C` sits BEFORE the verb and is therefore outside this slice.
const SWITCH_CREATE_FLAG_RE = /(?:^|[\s;|&(])-[A-Za-z]*[cC][A-Za-z]*|(?:^|[\s;|&(])(?:--create|--force-create)(?=[\s=]|$)/;

/**
 * The text of THIS simple command from its verb onward: quoted/heredoc data is masked
 * first, so a separator or flag inside a string cannot move the boundary, and the slice
 * stops at the next unquoted `;`, `&`, `|` or newline. Global options before the verb are
 * excluded by construction. Returns null when the verb cannot be located (fail closed:
 * the caller then treats the occurrence as a create).
 */
function simpleCommandFromVerb(cmd, match) {
  try {
    const text = String(cmd);
    const gitIdx = gitVerbIndex(match);
    if (!Number.isInteger(gitIdx) || gitIdx < 0) return null;
    const rest = text.slice(gitIdx);
    const maskedRest = maskDataRegions(rest, safeSegmentCommand(rest));
    const verbMatch = /\b(?:checkout|switch)\b/u.exec(maskedRest);
    if (!verbMatch) return null;
    const from = gitIdx + verbMatch.index;
    const tail = text.slice(from);
    const maskedTail = maskDataRegions(tail, safeSegmentCommand(tail));
    const sep = maskedTail.search(/[;|&\n]/u);
    // Return the MASKED slice: comments / quoted data are not argv, so a `-b` inside a
    // trailing comment or a quoted argument cannot read as a create flag.
    return sep === -1 ? maskedTail : maskedTail.slice(0, sep);
  } catch {
    return null;
  }
}

// Scoped W1 exception (submodule pointer update): the effective cwd IS a path registered by the parent repository's
// `.gitmodules` (a descendant is NOT that path) and the positional ref is a tag or a 40-hex commit. `git rev-parse
// --show-superproject-working-tree` is git's own answer for "where is this worktree's superproject"; an empty answer
// (not a registered/initialised submodule) or a failed step keeps the normal block.
function isRegisteredSubmodulePointerUpdate(cwdAbs, refToken) {
  // Ref classification first: a branch checkout never pays the superproject probe.
  if (!isPinnedCommitRef(cwdAbs, refToken)) return false;
  const parentRoot = gitOutput(cwdAbs, ["rev-parse", "--show-superproject-working-tree"]);
  if (!parentRoot) return false;
  const registered = registeredSubmodulePaths(parentRoot);
  if (!registered || registered.length === 0) return false;
  // Both sides realpath'd: absolute/relative `-C`, `./`, trailing slashes and symlinked roots compare as paths.
  const rel = path.relative(resolveSafe(parentRoot), resolveSafe(cwdAbs)).replaceAll("\\", "/");
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return registered.includes(rel);
}

// Multi-occurrence: see checkWorktreeMandatoryForBranchCreate. The masking vector this
// closes is concrete (issue #899 finding (a)): an exempt FIRST checkout — a protected
// mainline (`git checkout main`) or a pathspec restore (`git checkout <ref> --`) —
// masked a later real branch checkout under the single `.match()`. Evaluate every
// occurrence; block on the first that survives the pathspec / protected-mainline / cwd
// exemptions.
function checkWorktreeMandatoryForBranchCheckout(cmd, baseCwd) {
  const segs = safeSegmentCommand(cmd);
  for (const m of cmd.matchAll(new RegExp(IN_PLACE_BRANCH_CHECKOUT_RE.source, "g"))) {
    if (segs && !isMatchInCommandSegment(gitVerbIndex(m), segs)) continue;

    if (m.groups?.checkoutVerb === "checkout" && m.groups?.pathspecSep === "--") {
      continue;
    }

    const branchName = (m.groups?.checkoutRef || "").replace(/^["']|["']$/g, "");

    // Checkout to protected mainline (main/master/production/integration) is returning
    // to mainline, not opening a work branch — exempt from worktree mandate.
    if (isProtectedBaseBranch(branchName)) continue;
    // `HEAD` names the commit already checked out: a bare `git checkout HEAD [<path>…]` does not change the branch.
    if (isBareHeadCheckout(cmd, m, branchName)) continue;

    const cwdAbs = resolveSafe(commandCwdForGitMatch(cmd, m[0], baseCwd || process.cwd(), gitVerbIndex(m)));
    if (isInsideSubWorktree(cwdAbs)) continue;
    if (!repoHasWorktreeRule(cwdAbs)) continue;

    const detected = `Worktree Mandatory For Branch Checkout gate：在主 worktree 偵測 \`${m[0].trim()}\`，所有開/切分支一律 worktree，無前綴例外（per git-branch-naming-and-anchor.md §Worktree 規範）。子模組指標更新請用 tag／sha。`;
    let targetBranch = branchName;
    let shorthandNote = "";
    if (PREVIOUS_BRANCH_SHORTHAND_RE.test(branchName)) {
      // The shorthand is evaluated as the branch it names right now. When that cannot be told (no such reflog
      // entry, a detached previous checkout, or an earlier checkout/switch in this payload that will have moved
      // it by the time this one runs) the gate does not block: a class-one gate blocks only a definite violation.
      const previous = previousBranchForShorthand(cmd, m, branchName, cwdAbs);
      if (!previous || isProtectedBaseBranch(previous)) continue;
      targetBranch = previous;
      shorthandNote = `\n\n\`${branchName}\` 是「上一個分支」的簡寫，目前指向 \`${previous}\`。`;
    } else if (isWorkingTreeOrTrackedPath(cwdAbs, branchName)) {
      // Without `--` a positional argument is evaluated as a branch name (a file and a branch can share a name),
      // so a path still blocks; the reason says how to restore it instead of offering a worktree named after it.
      // `git restore` is not offered: the Protected-branch gate blocks it on a protected branch.
      return {
        block: true,
        reason: `${detected}\n\n\`${branchName}\` 也是這個 repo 裡的路徑；沒有 \`--\` 時它被當成分支名評估。\n\n要還原檔案請加上 \`--\`：\n  git checkout -- ${branchName}\n\n若它其實是分支名，既有分支也必須用 worktree：\n  REPO_ROOT=$(git rev-parse --show-toplevel)\n  git worktree add "$REPO_ROOT/.worktree/<name>" ${branchName}\n\n${HOOK_BYPASS_HINT}`,
      };
    }

    // Scoped exception for a submodule pointer update: a registered submodule's tag/commit checkout only moves the
    // gitlink (detached HEAD) — it creates and switches no branch, and the `git worktree add` template cannot produce
    // the tree the parent commit records. Evaluated AFTER the path check on purpose: a ref that is also an existing
    // path inside that submodule keeps the existing fail-closed path semantics.
    if (isRegisteredSubmodulePointerUpdate(cwdAbs, branchName)) {
      const afterVerb = simpleCommandFromVerb(cmd, m);
      const createFlagRe =
        m.groups?.checkoutVerb === "switch" ? SWITCH_CREATE_FLAG_RE : CHECKOUT_CREATE_FLAG_RE;
      if (afterVerb !== null && !createFlagRe.test(afterVerb)) continue;
    }

    const segment = worktreeSegmentForBranch(targetBranch);
    return {
      block: true,
      reason: `${detected}${shorthandNote}\n\n既有分支也必須用 worktree：\n  REPO_ROOT=$(git rev-parse --show-toplevel)\n  git worktree add "$REPO_ROOT/.worktree/${segment}" ${targetBranch}\n  cd "$REPO_ROOT/.worktree/${segment}"\n\n新分支請改用：\n  git worktree add "$REPO_ROOT/.worktree/${segment}" -b ${targetBranch} <anchor>\n\n${HOOK_BYPASS_HINT}`,
    };
  }
  return null;
}

function checkBranchNameAlignment(cmd, baseCwd) {
  const cwdAbs = resolveSafe(baseCwd || process.cwd());
  if (!repoHasWorktreeRule(cwdAbs)) return null;

  // Operate on segment-stripped text (quoted strings, heredoc bodies, subshell
  // content, comments removed) per lib NOTE — otherwise a `git worktree add … -b
  // chore/x` LITERAL inside a quoted arg or `git commit -F -` heredoc body is
  // mis-read as a real command. Single-value extraction (pre-#1298) only took the
  // first add so an in-string literal after a real `git commit` stayed latent;
  // the multi-occurrence iteration below would otherwise surface it as a
  // false-positive. CMD_POSITION_ANCHOR alone is insufficient because `&&` inside a
  // heredoc/quoted body still reads as a command boundary to the anchor.
  const cmdText = gateCommandSegmentText(cmd);

  // Multi-occurrence: a command chain can contain several `git worktree add`
  // invocations. A single-value extractor only checked the FIRST add, so a later
  // misaligned add was missed (RULE-FEEDBACK, dp-reviewer PR #1298). Mirror the
  // base-class gates (checkWorktreeBaseProduction) which iterate every add via
  // extractWorktreeAddCreates (issue #851/#848 round-12).
  for (const { path: wtPath, branch: branchName } of extractWorktreeAddCreates(cmdText)) {
    if (!wtPath || !branchName) continue;
    if (!MANDATORY_PREFIX_RE.test(branchName)) continue;

    const branchSegment = branchName.split("/").slice(1).join("/");

    // Fail-open guard: if wtPath contains the __QUOTED__ placeholder (produced by
    // gateCommandSegmentText when a quoted span like "$ROOT/.worktree/foo" is
    // collapsed) or a literal '$' (unexpanded shell variable), the basename cannot
    // be statically resolved. Gate MUST NOT block on an unresolvable basename —
    // doing so is a false positive.
    //
    // Live trigger 2026-06-28: `git worktree add "$ROOT/.worktree/fix-gate-n-foo" -b
    // chore/fix-gate-n-foo HEAD` → cmdText has __QUOTED__ in path position → basename
    // resolves to "__QUOTED__" ≠ "fix-gate-n-foo" → spurious block with misleading
    // remediation ("rename branch to <prefix>/__QUOTED__").
    //
    // Parallel: sibling base gate checkWorktreeAbsolutePath already does
    // `if (!wtPath) return null; // can't parse path → fail-open`.
    // Rule ref: git-branch-naming-and-anchor.md §Worktree 規範 (`<repo-root-abs>` 翻譯) points at the accepted
    // shell-expansion path forms ($(git rev-parse …) / $REPO_ROOT-assigned-same-cmd
    // / plain absolute); base Gate D separately adjudicates the $REPO_ROOT-vs-$ROOT
    // distinction. The basename simply cannot be statically resolved here once
    // a '$' or __QUOTED__ residue is present, so Three-Way — a cosmetic consistency
    // nudge, not a security boundary — must fail open rather than block on a
    // placeholder. "miss once on unresolvable path" >> "false-block a worktree add".
    if (wtPath.includes("__QUOTED__") || wtPath.includes("$")) continue;

    const wtAbs = path.isAbsolute(wtPath) ? wtPath : path.resolve(cwdAbs, wtPath);
    const wtBasename = path.basename(wtAbs);
    if (wtBasename === branchSegment) continue;

    return {
      block: true,
      reason: `Three-Way Name Alignment gate (worktree add)：worktree dir basename \`${wtBasename}\` ≠ branch name segment \`${branchSegment}\`（per git-branch-naming-and-anchor.md §分支前綴對照表（唯一權威） 的工作分支命名與 §Worktree 規範 的路徑慣例）。\n\n分支 \`${branchName}\` 對應 worktree dir 應為 \`.worktree/${branchSegment}\`，OpenSpec change folder 亦應為 \`${branchSegment}\`。三者必須一致。\n\n修法：把 worktree path 改為 \`.../.worktree/${branchSegment}\`，或把 branch name 改為 \`<prefix>/${wtBasename}\`。\n\n${HOOK_BYPASS_HINT}`,
    };
  }
  return null;
}

const CHANGE_PROPOSAL_PATH_RE = /openspec[\\/]changes[\\/]([^\\/]+)[\\/]proposal[^\\/]*\.md$/;

function checkChangeFolderAlignment({ toolName, filePath, baseCwd }) {
  if (!filePath) return null;
  const m = filePath.match(CHANGE_PROPOSAL_PATH_RE);
  if (!m) return null;
  const changeFolder = m[1];
  if (changeFolder === "archive") return null;

  const cwdAbs = resolveSafe(baseCwd || process.cwd());
  const targetAbs = path.isAbsolute(filePath) ? filePath : path.resolve(cwdAbs, filePath);
  const cwdRoot = repoHasWorktreeRule(cwdAbs);
  const targetRoot = gitRootForPath(filePath, cwdAbs);
  const cwdInSub = Boolean(cwdRoot) && path.basename(path.dirname(path.normalize(cwdRoot))) === ".worktree";
  const targetInSub = Boolean(targetRoot) && (
    path.basename(path.dirname(path.normalize(targetRoot))) === ".worktree"
    || targetAbs.includes(`${path.sep}.worktree${path.sep}`)
  );
  // Enforce when the session cwd OR the write target lives in a sub-worktree.
  // Prefer the write target's worktree when it is one; otherwise keep the cwd
  // worktree so a sub-worktree session writing into the main checkout still
  // aligns against the session's own branch/dir.
  if (!cwdInSub && !targetInSub) return null;
  const alignmentRoot = targetInSub ? targetRoot : cwdRoot;
  if (!alignmentRoot) return null;
  if (!repoHasWorktreeRule(alignmentRoot)) return null;

  const branch = getCurrentBranch(alignmentRoot);
  if (!branch || !MANDATORY_PREFIX_RE.test(branch)) return null;
  const branchSegment = branch.split("/").slice(1).join("/");
  const repoRootBasename = path.basename(alignmentRoot);

  if (changeFolder === branchSegment && changeFolder === repoRootBasename) {
    return null;
  }

  return {
    block: true,
    reason: `Three-Way Name Alignment gate (proposal write)：openspec change folder \`${changeFolder}\` 與 branch \`${branchSegment}\` 與 worktree dir basename \`${repoRootBasename}\` 不一致（per git-branch-naming-and-anchor.md §分支前綴對照表（唯一權威） 的工作分支命名與 §Worktree 規範 的路徑慣例）。\n\nbranch=\`${branch}\`、worktree=\`${repoRootBasename}\`、change=\`${changeFolder}\` 三者必須相同。\n\n此 gate 由 Edit/Write/MultiEdit 觸發，沒有 inline Bash bypass；修法是 rename change folder 對齊（\`mv openspec/changes/${changeFolder} openspec/changes/${branchSegment}\`），或 rename branch (\`git branch -m ${branch} <prefix>/${changeFolder}\`)，或 rename worktree dir。`,
  };
}

// ── Gate P — OpenSpec change-doc PII pre-write block ──────────────────────
//
// Per issue #706: prior PII防護倚賴 preflight-checklist.md 點 9 cooperative-only
// self-check + rule-design-principles.md §Example Sanitization SSOT (which
// itself declared "pre-pr-archive-gate.mjs 不做 mechanical PII 阻擋"). PR #704
// dp-reviewer round-1 caught 2 Critical PII in meeting-notes.md only after
// commit; sanitize then cost an extra commit polluting PR history.
//
// Gate P targets Edit/Write/MultiEdit on:
//   openspec/changes/<X>/(meeting-notes|brd|proposal|proposal-mini|tasks|qa-test-scope|decisions).md
// where <X> is NOT 'archive' (archived docs are immutable and out of scope).
//
// PII regex set is anchored on rule-design-principles.md §Canonical FORBIDDEN
// Regex Set. Unix segments stay case-sensitive; Windows accepts any ASCII
// drive, independent slash/backslash separators, and case-insensitive Users.
// Every profile form requires an ASCII username first character, so canonical
// `<name>` placeholders remain clean. Email allowlists the reserved example
// domains plus anthropic.com (commit footer noreply).
//
// Scans the FULL simulated post-write content (Edit/MultiEdit apply edits
// to current file in-memory; Write fully overrides) per codex C1. An Edit
// that rewrites PII → placeholder passes only when the resulting file is
// PII-clean as a whole; residual PII outside the edit window still blocks.
const OPENSPEC_DOC_PATH_RE =
  /openspec[\\/]changes[\\/]([^\\/]+)[\\/](meeting-notes|brd|proposal|proposal-mini|tasks|qa-test-scope|decisions)\.md$/;

function piiClassificationFailure(kind) {
  return {
    block: true,
    reason: `Gate P (OpenSpec doc PII)：classification-failure (${kind})；shared PII classifier 無法產生可信任的 bounded result，依 fail-closed contract 阻擋寫入。`,
  };
}

// Pure helper: simulate the post-write file content given the prior content
// + the tool payload. Per codex C1: scanning only new_string lets a Edit-
// elsewhere succeed when residual PII already lives outside the edit
// window. By simulating the full post-write content, the gate enforces
// "the file as a whole must be PII-clean after this write."
//
// Semantics match Edit / MultiEdit tools:
//   - Edit: first occurrence of old_string is replaced (unless replace_all)
//   - MultiEdit: edits apply sequentially; same per-edit semantics
//   - Write: priorContent is ignored — entire file is overwritten by content
//
// If old_string isn't present, the underlying tool will error; we leave the
// content unchanged (i.e. scan prior content) so the gate still surfaces
// pre-existing PII as a soft pressure to clean up.
function simulatePostWriteContent(toolName, toolInput, priorContent = "") {
  if (toolName === "Write") return toolInput.content || "";
  if (toolName === "Edit") {
    const oldStr = toolInput.old_string || "";
    const newStr = toolInput.new_string || "";
    if (!oldStr) return priorContent;
    if (toolInput.replace_all) {
      return priorContent.split(oldStr).join(newStr);
    }
    const idx = priorContent.indexOf(oldStr);
    if (idx === -1) return priorContent;
    return priorContent.slice(0, idx) + newStr + priorContent.slice(idx + oldStr.length);
  }
  if (toolName === "MultiEdit") {
    let content = priorContent;
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
    for (const e of edits) {
      const oldStr = e.old_string || "";
      const newStr = e.new_string || "";
      if (!oldStr) continue;
      if (e.replace_all) {
        content = content.split(oldStr).join(newStr);
      } else {
        const idx = content.indexOf(oldStr);
        if (idx !== -1) {
          content = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
        }
      }
    }
    return content;
  }
  return "";
}

// Test-overridable file reader. Production passes readFileSync; tests inject
// an in-memory map to avoid touching disk.
function defaultReadFileSafe(absPath) {
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return "";
  }
}

function checkOpenSpecDocPII({ toolName, filePath, toolInput, baseCwd, readFile = defaultReadFileSafe }) {
  if (!filePath) return null;
  const m = filePath.match(OPENSPEC_DOC_PATH_RE);
  if (!m) return null;
  const changeFolder = m[1];
  if (changeFolder === "archive") return null;

  // For Edit/MultiEdit, scan the simulated post-write content (per codex C1)
  // so residual PII outside the edit window doesn't bypass the gate. For
  // Write, priorContent is irrelevant — content fully overrides.
  let priorContent = "";
  if (toolName === "Edit" || toolName === "MultiEdit") {
    const abs = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(baseCwd || process.cwd(), filePath);
    priorContent = readFile(abs);
  }
  const payload = simulatePostWriteContent(toolName, toolInput, priorContent);
  let hits;
  try {
    hits = findPIIHits(payload);
  } catch {
    return piiClassificationFailure("exception");
  }
  if (!isValidPIIHitResult(hits)) {
    return piiClassificationFailure("invalid-result");
  }
  if (hits.length === 0) return null;

  const previewLimit = 5;
  const lines = hits.slice(0, previewLimit).map((h, i) =>
    `  ${i + 1}. [${h.type}] "${h.match}" → use placeholder "${h.placeholder}"`
  );
  const overflow = hits.length > previewLimit ? `\n  ...及其他 ${hits.length - previewLimit} 個 hit（總 ${hits.length}）` : "";

  return {
    block: true,
    reason: `Gate P (OpenSpec doc PII)：偵測寫入 \`${filePath}\` 含 PII (${hits.length} hit${hits.length > 1 ? "s" : ""})，違反 AGENTS.md §0 Never \`禁 email/路徑 入 repo\` + rule-design-principles.md §Example Sanitization Canonical FORBIDDEN Regex Set。

命中：
${lines.join("\n")}${overflow}

SSOT placeholder map：.devpro/agent-rules/rule-design-principles.md §Example Sanitization

此 gate 由 Edit/Write/MultiEdit 觸發 openspec/changes/<name>/{meeting-notes,brd,proposal,proposal-mini,tasks,qa-test-scope,decisions}.md 寫入；archive 路徑豁免。**檢查寫入後完整檔案內容**（Edit/MultiEdit 模擬 apply 後掃整檔；Write 全覆寫）— Edit 只有在整份檔案 PII-clean 時通過；residual PII 在 edit window 外仍會 block。修法：對照 placeholder map 修正所有命中後重試。`,
  };
}

const MEETING_NOTES_PATH_RE =
  /openspec\/changes\/([^/]+)\/meeting-notes\.md$/;

/**
 * When meeting-notes post-write content includes Clarification State AND Seams
 * Confirmation, enforce clarification-contract shape fail-closed.
 */
function checkClarificationMeetingNotesContract({
  toolName,
  filePath,
  toolInput,
  baseCwd,
  readFile = defaultReadFileSafe,
}) {
  if (!filePath) return null;
  const m = filePath.match(MEETING_NOTES_PATH_RE);
  if (!m || m[1] === "archive") return null;

  let priorContent = "";
  if (toolName === "Edit" || toolName === "MultiEdit") {
    const abs = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(baseCwd || process.cwd(), filePath);
    priorContent = readFile(abs);
  }
  const payload = simulatePostWriteContent(toolName, toolInput, priorContent);
  const hasClar = /(?:^|\n)## Clarification State\s*\n/.test(payload);
  const hasSeams = /(?:^|\n)## Seams Confirmation\s*\n/.test(payload);
  if (!hasClar || !hasSeams) return null;

  const result = validateMeetingNotesClarificationContracts(payload);
  if (result.ok) return null;
  return {
    block: true,
    reason: `Clarification/Seams contract gate：\`${filePath}\` 含 Clarification State + Seams Confirmation，但 clarification-contract 驗證失敗：\n${result.errors
      .slice(0, 8)
      .map((e) => `  - ${e}`)
      .join("\n")}${
      result.errors.length > 8 ? `\n  ...(+${result.errors.length - 8})` : ""
    }\n\nExecutable SSOT：.devpro/scripts/lib/clarification-contract.mjs；CLI：node .devpro/scripts/check-clarification-gates.mjs pre-analyst <change-name>`,
  };
}

/**
 * Seams-first: proposal*.md writes require sibling meeting-notes Seams Confirmation
 * to allow ledger/long-form expansion (seamsExpansionAllowed).
 */
function checkSeamsExpansionOnProposalWrite({
  toolName,
  filePath,
  baseCwd,
  readFile = defaultReadFileSafe,
}) {
  if (!filePath) return null;
  const m = filePath.match(CHANGE_PROPOSAL_PATH_RE);
  if (!m || m[1] === "archive") return null;
  const changeFolder = m[1];
  const cwdAbs = resolveSafe(baseCwd || process.cwd());
  // Single path derivation (design D1): the sibling is defined by the WRITE
  // TARGET's own directory (`path.resolve(cwdAbs, filePath)` → dirname), not by
  // rebuilding a path from the change-name match. Rebuilding dropped any target
  // prefix (e.g. `.worktree/<x>/`) and read the MAIN CHECKOUT's same-name change
  // folder → false block when a session rooted in the main checkout writes a
  // relative path into a linked worktree. `path.resolve` is the single semantic
  // here (pure string, zero I/O — the target may not exist yet); `resolveSafe`
  // stays reserved for cwd/repo-root resolution and is NOT applied to the target.
  const resolvedTarget = path.resolve(cwdAbs, filePath);
  const notesAbs = path.join(path.dirname(resolvedTarget), "meeting-notes.md");
  const notesBody = readFile(notesAbs);
  if (!notesBody) {
    return {
      block: true,
      reason: `Seams-first expansion gate：寫入 \`${filePath}\` 前找不到 sibling meeting-notes.md（\`${notesAbs}\`）。先寫 ## Seams Confirmation 並確認後再展開 proposal。CLI：node .devpro/scripts/check-clarification-gates.mjs seams-expansion ${changeFolder}`,
    };
  }
  const seams = extractSection(notesBody, "Seams Confirmation");
  if (!seams) {
    return {
      block: true,
      reason: `Seams-first expansion gate：\`${notesAbs}\` 缺少 ## Seams Confirmation。先鎖可觀測驗收面並經確認後再寫 proposal。CLI：node .devpro/scripts/check-clarification-gates.mjs seams-expansion ${changeFolder}`,
    };
  }
  const parsed = parseBulletFields(seams);
  if (parsed.errors.length > 0) {
    return {
      block: true,
      reason: `Seams-first expansion gate：Seams Confirmation parse fail-closed：\n${parsed.errors
        .slice(0, 6)
        .map((e) => `  - ${e}`)
        .join("\n")}`,
    };
  }
  const gate = seamsExpansionAllowed(parsed.fields);
  if (gate.allowed) return null;
  return {
    block: true,
    reason: `Seams-first expansion gate：seamsExpansionAllowed blocked — ${gate.reason}。修法：確認 seams（非空）／reconfirm／bypass 後重試。CLI：node .devpro/scripts/check-clarification-gates.mjs seams-expansion ${changeFolder}`,
  };
}

// Gate 1w: shell-wrapper git/gh bypass. `eval`/`sh -c`/`bash -c`/`zsh -c` (and
// `command`/`exec`-prefixed forms) take their command as a STRING ARGUMENT,
// which the segmenter classifies as a quoted-string (data) — so every other
// gate's verb regex, which is shell-aware and skips data segments, never sees
// the wrapped `git`/`gh` invocation. That lets `eval "git commit -m nofooter"`,
// `sh -c "git push --force"`, `bash -c "gh pr merge --squash"` etc. bypass the
// attribution / force-push / merge-strategy / protected-branch / cross-model
// gates wholesale (systematic finding, round-4 audit B). Rather than recursively
// re-parse the wrapped string (error-prone), block the wrapper when its string
// argument contains a `git`/`gh` token: wrapping git/gh in a shell -c string is
// not a pattern the workflow needs, and it is the canonical gate-evasion shape.
const SHELL_WRAPPER_RE =
  /(?:^|[\s;|&(])(?:command\s+|exec\s+)?(?:eval|(?:ba|z|da)?sh|env\s+\S+|xargs(?:\s+-\S+)*)\b/g;
function isReviewerToolAllowlistValue(cmd, segment, tailStart) {
  const prefix = cmd.slice(Math.max(0, tailStart), segment.range[0]);
  return /(?:^|\s)(?:--allowedTools|--allowed-tools|--tools)(?:\s+|=)\s*$/.test(prefix);
}
function checkShellWrapperGitBypass(cmd) {
  const segs = safeSegmentCommand(cmd);
  SHELL_WRAPPER_RE.lastIndex = 0;
  for (const m of cmd.matchAll(SHELL_WRAPPER_RE)) {
    if (!isMatchInCommandSegment(m.index, segs)) continue;
    // Inspect the remainder of this wrapper invocation for a quoted-string (or
    // here-string) argument containing a git/gh token. We scan the raw tail and
    // look for git/gh inside a quoted region that the segmenter marked as data.
    const tailStart = m.index + m[0].length;
    // Find this wrapper's argument span (up to the next unquoted separator).
    const sepRel = cmd.slice(tailStart).search(/(?:^|[^\\])[;\n]|\|\||&&/);
    const argEnd = sepRel === -1 ? cmd.length : tailStart + sepRel + 1;
    const gitTokenRe = /(?:^|[\s;|&("'`])(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\S*\/)?(?:git|gh)\b/;
    // (a) git/gh inside a quoted-string / heredoc argument (eval/sh -c/bash -c).
    for (const s of segs) {
      if (s.range[0] < tailStart || s.range[0] >= argEnd) continue;
      if (s.kind !== "quoted-string" && s.kind !== "heredoc-body") continue;
      // Reviewer tool allowlists are declarative permission profiles, not
      // shell command strings. `Bash(gh ...)` inside --allowedTools must not
      // trip the wrapper-bypass gate; actual `sh -c "git ..."` still does.
      if (isReviewerToolAllowlistValue(cmd, s, tailStart)) continue;
      if (gitTokenRe.test(s.text)) return shellWrapperBlock();
    }
    // (b) git/gh WRITE verb as a direct command-segment argument of a wrapper
    // that genuinely HIDES the verb from the other gates — `xargs git commit`
    // (git is xargs's argument list). NOT `env [VAR=val…] git <verb>`: there the
    // git command runs DIRECTLY and is fully visible to the protected-write /
    // force-push / etc. gates (which now see through a leading `env` prefix via
    // TOKEN_ANCHOR), so flagging it here was a false-positive on a natural
    // command (`env GIT_AUTHOR_DATE=… git commit`) — issue #851/#848 round 15.
    // `env … sh -c "git…"` (env wrapping an interpreter) is still caught: the
    // `sh` token is matched separately by SHELL_WRAPPER_RE and handled by (a).
    const wrapperIsEnv = /(?:^|[\s;|&(])(?:command\s+|exec\s+)?env\b/.test(m[0]);
    if (!wrapperIsEnv) {
      const argCode = maskDataRegions(cmd, segs, argEnd, tailStart);
      const directWriteRe =
        /(?:^|[\s])(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\S*\/)?(?:git\s+(?:-\S+\s+)*(?:commit|add|rm|mv|restore|reset|stash|rebase|push|merge|checkout|switch|worktree|branch|tag|clone)|gh\s+(?:pr|repo|api|release)\b)/;
      if (directWriteRe.test(" " + argCode)) return shellWrapperBlock();
    }
  }

  // (c) git/gh fed to a bare shell interpreter via stdin — a heredoc into
  // `sh`/`bash`/`zsh`/`dash` (`sh <<EOF ... git ... EOF`) or a pipe into one
  // (`echo "git ..." | sh`). These run git/gh without the verb appearing as a
  // gate-visible command, the same bypass class as (a)/(b). Conservative: only
  // fire when the COMMAND-SEGMENT text (data regions blanked — so `| sh` / `git`
  // appearing literally inside a quoted string or heredoc body, e.g. this very
  // commit message, do NOT trip it) BOTH pipes-into / heredocs-into a bare
  // interpreter AND contains a git/gh token.
  const codeOnly = gateCommandSegmentText(cmd);
  const interpreterSink =
    /\|\s*(?:command\s+|exec\s+)?(?:ba|z|da)?sh\b(?!\s+-)/.test(codeOnly) || // `... | sh`
    /(?:^|[\s;|&(])(?:command\s+|exec\s+)?(?:ba|z|da)?sh\s+<</.test(cmd); // `sh <<EOF` (heredoc operator is code)
  // For the heredoc form the git token lives in the heredoc BODY (data), so the
  // token check uses raw cmd; for the pipe form codeOnly already has it. Either
  // way require an interpreter sink first, so a git token alone never fires.
  if (interpreterSink && /(?:^|[\s;|&("'`])(?:\S*\/)?(?:git|gh)\b/.test(cmd)) {
    return shellWrapperBlock();
  }
  return null;
}
function shellWrapperBlock() {
  return {
    block: true,
    reason:
      `Shell-wrapper git/gh gate (1w)：偵測到 \`eval\`/\`sh -c\`/\`bash -c\`/\`xargs\`，或經 heredoc/pipe 餵給 \`sh\`/\`bash\` 的 \`git\`/\`gh\` 命令。` +
      `這些形式把命令當字串 / stdin，會繞過所有 PreToolUse gate（attribution / force-push / protected-branch / merge / cross-model 等）。` +
      `請直接執行 git/gh 命令（不要包在 -c 字串 / eval / xargs / heredoc / pipe-to-shell 內），讓 gate 能檢查。` +
      `若確有正當理由需 wrapper（罕見），取得使用者明示授權後在同一 Bash payload 放 \`DEVPRO_HOOK_BYPASS=1\`。`,
  };
}

// ── Gate: Production Tag Shape + Version Equality (N1 + V4) ─────────────
//
// Triggered on `git tag` write invocations where the tag name starts with
// `production-`. Two layers:
//
//   N1 — Shape validation (no fail-open, pure string):
//     tag name must match one of the three canonical shapes:
//       production-v<MAJOR>.<MINOR>.<PATCH>
//       production-<YYYYMMDD>[-ordinal≥2]
//       production-<YYYYMMDD>-rules[-ordinal≥2]
//     Malformed → block, reason lists the three valid shapes.
//
//   V4 — Version equality (three fail-open cases):
//     Only runs when tag name starts with `production-v` (SemVer lane).
//     Extracts tag version vs AGENTS.md version; mismatch → block
//     (release-integrity, both versions in reason).
//     Fail-open: AGENTS.md unreadable / version unparseable / tag version
//     null → skip V4, return null (not block).
//
// Tag name extraction handles two forms:
//   lightweight:  `git tag production-v6.62.0`
//   annotated:    `git tag -a production-v6.62.0 -m "msg"`
//
// Non-production-* tags are ignored (early return null).
// Uses REPO_SCOPE_GIT_WRITE_RE (already defined above) so match[1] captures
// the verb, ensuring isRepoScopeGitWriteInvocation(cmd, match) works correctly.

/**
 * Extract the tag name from a `git tag [flags] <name>` command tail.
 *
 * Handles annotated (-a/-s flag immediately followed by the name) and
 * lightweight (first non-flag, non-flag-value token) forms.
 *
 * Value-taking flags for `git tag`: -m, -F (message/file), -u (key-id),
 * -e (edit — no value), -a/-s/-f (annotate/sign/force — no value taken,
 * but -a and -s indicate annotated form).
 *
 * Strategy: split the tail into tokens, skip flags and their values,
 * return the first non-flag token as the tag name.
 *
 * @param {string} tail  — text from the end of the `git tag` match to EOC
 * @returns {string|null}
 */
function extractTagNameFromTail(tail) {
  // Tokenize the tail (same logic as shellStatementTokens but inline)
  const tokenRe = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g;
  const tokens = [];
  for (const m of tail.matchAll(tokenRe)) {
    tokens.push(shellTokenValue(m[1] || "").trim());
  }

  // Value-taking flags: their next token is consumed as the flag value.
  const VALUE_TAKING = new Set(["-m", "--message", "-F", "--file", "-u", "--local-user"]);
  // Stop-marker flag and its value
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!tok) { i++; continue; }
    if (tok === "--") {
      // End of flags; next token is the tag name
      i++;
      return tokens[i] || null;
    }
    if (VALUE_TAKING.has(tok)) {
      // Skip this flag and its value
      i += 2;
      continue;
    }
    if (tok.startsWith("-")) {
      // Short flag cluster (e.g. -af, -am) — skip; if it bundles a value-taking
      // flag like -m, the next token is consumed. Simplified: skip the flag token;
      // if the flag ends with a known value-taking letter without attached value,
      // also skip next.
      const hasBundledValue = /[mFu]$/.test(tok) && !tok.includes("=");
      i++;
      if (hasBundledValue) i++; // consume the value token
      continue;
    }
    // First non-flag token is the tag name
    return tok;
  }
  return null;
}

/**
 * listLocalReleaseBranches(cwd)
 *
 * Returns an array of local release branch names (e.g. ["release/rules-20260608-2"]).
 * Env override: DEVPRO_LOCAL_RELEASE_BRANCHES (comma-separated) for tests.
 * Special value "__UNAVAILABLE__" → simulates git failure → returns null (fail-open).
 * Production path: spawnSync git for-each-ref --format=%(refname:short) refs/heads/release.
 * Returns null on any git failure (fail-open).
 *
 * @param {string} cwd
 * @returns {string[]|null}
 */
function listLocalReleaseBranches(cwd) {
  const envOverride = process.env.DEVPRO_LOCAL_RELEASE_BRANCHES;
  if (envOverride !== undefined) {
    // Special sentinel → simulate git unavailability → fail-open
    if (envOverride === "__UNAVAILABLE__") return null;
    return envOverride
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // Production path: list stable ref names. `git branch --list` decorates a branch
  // checked out in a linked worktree with `+`, which is not part of the ref name.
  try {
    const result = spawnSync(
      "git",
      ["-C", cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads/release"],
      { encoding: "utf8" }
    );
    if (result.error || result.status !== 0) return null; // fail-open
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null; // fail-open
  }
}

/**
 * True when the same Bash payload creates a release branch matching `namePattern`.
 * V2 otherwise reads only the pre-call ref state, so the runbook's single-payload
 * `git branch release/... && git tag production-...` was blocked even though the
 * branch exists by the time the tag lands (issue #3601). The view is shell-aware
 * (`gateCommandSegmentText`), so a branch name quoted inside `git commit -m` or an
 * echo is never treated as a creation.
 *
 * @param {string} cmdText - raw payload command text
 * @param {string} namePattern - already-escaped branch-name pattern (no delimiters)
 * @returns {boolean}
 */
function payloadCreatesReleaseBranch(cmdText, namePattern) {
  if (typeof cmdText !== "string" || cmdText.length === 0) return false;
  const text = gateCommandSegmentText(cmdText);
  const re = new RegExp(
    CMD_POSITION_ANCHOR + String.raw`git\s+(?:branch\s+(?!-)|switch\s+(?:-[A-Za-z]+\s+)*(?:-[cC]|--create)\s+|checkout\s+(?:-[A-Za-z]+\s+)*-[bB]\s+|worktree\s+add\s+[^;&|\n]*?-[bB]\s+)` +
      namePattern +
      String.raw`(?![\w./-])`
  );
  return re.test(text);
}

/**
 * checkTagOrdinalReleaseBranchMatch(tagName, cwd)
 *
 * V2 gate: verifies that an ordinal-suffix production tag (n≥2) has a
 * corresponding local release branch.
 *
 * Rules (doc release-rules-lane.md §與業務 release 區隔 for the rules lane; release-step-1-7.md §Release 流程 step 1-7 for the date lane):
 *   - production-YYYYMMDD-rules-<n> (n≥2) → must have local release/rules-YYYYMMDD-<n> (exact)
 *   - production-YYYYMMDD-<n> (n≥2, non-rules) → must have local branch starting with
 *     release/YYYYMMDD- and ending with -<n> (shortSHA is variable)
 *   - No ordinal (first release) → V2 skip (no verify)
 *   - production-v* (SemVer) → caller already skips before calling this function
 *
 * Fail-open: if listLocalReleaseBranches returns null (git unavailable) → return null (no block).
 *
 * @param {string} tagName - already validated production-* tag name (N1 passed)
 * @param {string} cwd
 * @returns {{ block: true, reason: string }|null}
 */
// V2 only checks the name pairing; the pushed tag's target is checked by the
// git-native pre-push hook (hooks-git/pre-push.mjs).
const PRODUCTION_TAG_TARGET_NOTE =
  `分支只是命名對應，不代表 tag 可以打在 production 之外：tag 仍須打在 production PR 的 merge commit（剛 fetch 的 \`origin/production\` 上），` +
  `推送時 pre-push hook 會檢查。\n\n`;

function checkTagOrdinalReleaseBranchMatch(tagName, cwd, cmdText = "") {
  // ── rules lane: production-YYYYMMDD-rules[-<n>] ──
  const rulesMatch = RULES_TAG_RE.exec(tagName);
  if (rulesMatch) {
    const date = rulesMatch[1];    // YYYYMMDD
    const ordinal = rulesMatch[2]; // undefined if first release (no suffix)
    // V2 only applies to ordinal ≥2; first release → skip
    if (!ordinal) return null;

    const expectedBranch = `release/rules-${date}-${ordinal}`;
    const branches = listLocalReleaseBranches(cwd);
    if (branches === null) return null; // fail-open: git unavailable

    if (!branches.includes(expectedBranch) && !payloadCreatesReleaseBranch(cmdText, escapeRegExp(expectedBranch))) {
      return {
        block: true,
        reason:
          `Production Tag Ordinal-Branch Match Gate (V2)：tag \`${tagName}\` 的 ordinal suffix \`-${ordinal}\` ` +
          `要求本地存在對應分支 \`${expectedBranch}\`，但找不到。\n\n` +
          `rules lane 規則（release-rules-lane.md §與業務 release 區隔）：\n` +
          `  production-YYYYMMDD-rules-<n>（n≥2）→ 本地須有 \`release/rules-YYYYMMDD-<n>\`（精確 match）。\n\n` +
          `請先建立分支 \`${expectedBranch}\` 再打 tag，或確認 ordinal 是否有誤。\n\n` +
          PRODUCTION_TAG_TARGET_NOTE +
          HOOK_BYPASS_HINT,
      };
    }
    return null; // branch found → pass
  }

  // ── date lane: production-YYYYMMDD[-<n>] (non-rules) ──
  const dateMatch = PRODUCTION_DATE_RE.exec(tagName);
  if (dateMatch) {
    const date = dateMatch[1];    // YYYYMMDD
    const ordinal = dateMatch[2]; // undefined if first release (no suffix)
    // V2 only applies to ordinal ≥2; first release → skip
    if (!ordinal) return null;

    const prefix = `release/${date}-`;
    const suffix = `-${ordinal}`;
    const branches = listLocalReleaseBranches(cwd);
    if (branches === null) return null; // fail-open: git unavailable

    const found = branches.some(
      (b) => b.startsWith(prefix) && b.endsWith(suffix)
    );
    if (!found && !payloadCreatesReleaseBranch(cmdText, escapeRegExp(prefix) + `[A-Za-z0-9._-]+` + escapeRegExp(suffix))) {
      return {
        block: true,
        reason:
          `Production Tag Ordinal-Branch Match Gate (V2)：tag \`${tagName}\` 的 ordinal suffix \`-${ordinal}\` ` +
          `要求本地存在對應分支 \`release/${date}-<shortSHA>-${ordinal}\`（date 段 match + ordinal suffix -${ordinal} match），但找不到。\n\n` +
          `subset lane 規則（release-step-1-7.md §Release 流程 step 1-7）：\n` +
          `  production-YYYYMMDD-<n>（n≥2）→ 本地須有 \`release/YYYYMMDD-<shortSHA>-<n>\`（date prefix + ordinal suffix）。\n\n` +
          `請先建立分支 \`release/${date}-<shortSHA>-${ordinal}\` 再打 tag，或確認 ordinal 是否有誤。\n\n` +
          PRODUCTION_TAG_TARGET_NOTE +
          HOOK_BYPASS_HINT,
      };
    }
    return null; // branch found → pass
  }

  // Should not be reached (N1 already validated the tag name)
  return null;
}

function hasPriorSourceReleaseMergeInSamePayload(cmd, gitTagMatchIndex) {
  if (!Number.isInteger(gitTagMatchIndex) || gitTagMatchIndex <= 0) return false;
  const prefix = cmd.slice(0, gitTagMatchIndex);
  return /\bgit\b[\s\S]{0,160}?\bmerge\b[\s\S]{0,240}?\brelease\/(?:v(?:\d+\.\d+\.\d+|\$[A-Za-z_][A-Za-z0-9_]*)|\$[A-Za-z_][A-Za-z0-9_]*)\b/.test(prefix);
}

/**
 * checkProductionTagGate(cmd, baseCwd, effectiveCwd)
 *
 * Gate runner for N1 (shape) + V2 (ordinal-branch match) + V4 (version equality)
 * on `git tag` writes.
 *
 * Uses REPO_SCOPE_GIT_WRITE_RE (which captures the verb in group 1) so that
 * isRepoScopeGitWriteInvocation(cmd, match) can correctly identify tag writes.
 * Segment filtering via isMatchInCommandSegment guards against matching
 * `git tag` inside heredoc bodies or quoted strings.
 *
 * V4 reads AGENTS.md from the cwd the `git tag` command itself runs in (resolved at its position from a
 * `cd <worktree>` before it / `git -C` on it), falling back to `effectiveCwd` (the gate runner's cwd at its
 * first `git`/`gh` command) and then baseCwd when that cwd cannot be resolved, NOT the payload-level baseCwd:
 * a release tag is created in the PRODUCTION worktree (just-bumped AGENTS.md) while the
 * hook payload cwd is often the MAIN worktree (possibly stale pre-bump). Reading baseCwd
 * blocked a correct `production-v<X>` tag on a stale main-worktree version. Mirrors the
 * effectiveCwd plumbing of branch-verb-whitelist / archive gate and gh-footer-gate.mjs's
 * worktree-aware version source. Falls back to baseCwd when effectiveCwd is absent.
 *
 * @param {string} cmd
 * @param {string} baseCwd
 * @param {string} [effectiveCwd] — resolved worktree cwd of the tag command (V4 version source)
 * @returns {{ block: true, reason: string }|null}
 */
function checkProductionTagGate(cmd, baseCwd, effectiveCwd = baseCwd) {
  const segs = safeSegmentCommand(cmd);

  REPO_SCOPE_GIT_WRITE_RE.lastIndex = 0;
  for (const match of cmd.matchAll(REPO_SCOPE_GIT_WRITE_RE)) {
    // Only consider `git tag` matches
    if (match[1] !== "tag") continue;

    // Only consider matches in a code segment (not inside a heredoc / quoted string)
    if (segs && !isMatchInCommandSegment(gitVerbIndex(match), segs)) continue;

    // Confirm it is a write invocation (not `git tag -l`, `git tag --list`, etc.)
    if (!isRepoScopeGitWriteInvocation(cmd, match)) continue;

    // Extract the tag name from the tail after the `git tag` match
    const tail = tailAfterMatch(cmd, match);
    const tagName = extractTagNameFromTail(tail);

    // Only gate production-* tags
    if (!tagName || !tagName.startsWith("production-")) continue;

    // ── N1: Shape validation (no fail-open — pure string) ────────────────
    if (!isValidProductionTag(tagName)) {
      return {
        block: true,
        reason:
          `Production Tag Shape Gate (N1)：tag 名 \`${tagName}\` 不符合任何合法 production-* shape。` +
          `合法 shape 三種：\n` +
          `  1. \`production-v<MAJOR>.<MINOR>.<PATCH>\`（SemVer，source repo 上線 tag）\n` +
          `  2. \`production-<YYYYMMDD>[-<ordinal≥2>]\`（date-style，consumer subset release）\n` +
          `  3. \`production-<YYYYMMDD>-rules[-<ordinal≥2>]\`（rules sync，consumer rules lane）\n\n` +
          `Malformed tag 會進入 detect-branch-base.mjs 的 compareTags date-fallback 並混亂 anchor 排序（N1 mis-sort）。` +
          `請修正 tag 名後重跑。\n\n` +
          HOOK_BYPASS_HINT,
      };
    }

    // ── V2: Ordinal-suffix release-branch match gate ─────────────────────
    // Rules: production-YYYYMMDD-rules-<n> (n≥2) must have local release/rules-YYYYMMDD-<n>.
    //        production-YYYYMMDD-<n> (n≥2, non-rules) must have local release/YYYYMMDD-*-<n>.
    //        First release (no ordinal) and SemVer (production-v*) → skip V2.
    // Env override: DEVPRO_LOCAL_RELEASE_BRANCHES (comma-separated, for tests).
    // Fail-open: git branch unavailable / special value → no block.
    // The tag is created in the repo the `git tag` command runs in (`cd <repo>` before it / `git -C` on
    // it), which for a cross-repo release is not the payload baseCwd; its release branches decide V2.
    const tagCwd = baseCwd
      ? commandCwdForGitMatch(cmd, match[0], baseCwd, gitVerbIndex(match))
      : "";
    if (!tagName.startsWith("production-v")) {
      const branchCwd = tagCwd && tagCwd !== UNRESOLVABLE_CWD ? tagCwd : baseCwd;
      const v2Result = checkTagOrdinalReleaseBranchMatch(tagName, branchCwd, cmd);
      if (v2Result) return v2Result;
    }

    // ── V4: Version equality (only for production-v* tags) ───────────────
    if (!tagName.startsWith("production-v")) continue; // not a v-tag; V4 N/A

    // Fail-open #1: extract tag version (should succeed since N1 passed)
    const tagVersion = extractVersionFromTag(tagName);
    if (tagVersion == null) continue; // fail-open: cannot extract → skip V4

    // Fail-open #2: read AGENTS.md version from the worktree the `git tag` command runs in (resolved at its position:
    // `cd <prod-worktree>` before it, `git -C` on it), not the payload baseCwd and not the cwd of the first git/gh
    // command. When that cwd cannot be resolved, keep the previous resolution: the dispatcher already maps an
    // UNRESOLVABLE effectiveCwd back to baseCwd, and the explicit sentinel guard here mirrors the sibling
    // branch-verb-whitelist gate so a future direct caller cannot pass the sentinel string into getRepoRoot.
    const versionCwd =
      tagCwd && tagCwd !== UNRESOLVABLE_CWD
        ? tagCwd
        : effectiveCwd && effectiveCwd !== UNRESOLVABLE_CWD
          ? effectiveCwd
          : baseCwd;
    let agentsMdVersion = null;
    try {
      const repoRoot = getRepoRoot(versionCwd);
      if (!repoRoot) continue; // fail-open: no repo root
      agentsMdVersion = readAgentsMdVersion(repoRoot);
    } catch {
      continue; // fail-open: AGENTS.md unreadable
    }
    if (agentsMdVersion == null) continue; // fail-open: version unparseable

    // Version comparison
    if (compareVersions(tagVersion, agentsMdVersion) !== 0) {
      const compoundMergeTagHint = hasPriorSourceReleaseMergeInSamePayload(cmd, match.index)
        ? `\n\n偵測到同一 Bash payload 內可能先 merge \`release/v<X.Y.Z>\` 再 tag。PreToolUse 在 Bash 執行前檢查，因此只能看到本機 merge 前的 \`AGENTS.md\`。這不構成重跑本機 merge/tag 的理由：本機 production merge 已禁止；production 僅可由 PR 更新。Required path：push \`release/v<X.Y.Z>\`，開啟 base \`production\` 的 PR，完成 GitHub merge，resolve and freshly verify the exact merged production commit as \`MERGE_SHA\`，再以明確 target 執行 \`git tag production-v<X.Y.Z> "$MERGE_SHA"\`，最後只 push tag ref：\`git push origin refs/tags/production-v<X.Y.Z>\`。\n\n`
        : "";
      return {
        block: true,
        reason:
          `Production Tag Version-Equality Gate (V4)：tag 版號 \`${tagVersion}\` 與 AGENTS.md 版本 \`${agentsMdVersion}\` 不符。` +
          `production-v<X.Y.Z> tag 的版號必須與 \`AGENTS.md\` \`版本：<X.Y.Z>\` 完全一致（release-integrity）。` +
          `兩者不符會導致 tag metadata 記錄錯誤 rules 版號，破壞 release 溯源。\n\n` +
          `tag 版號：${tagVersion}　　AGENTS.md 版本：${agentsMdVersion}\n\n` +
          compoundMergeTagHint +
          `若 AGENTS.md 版號需要 bump，請先走 \`chore/bump-v<X.Y.Z>\` 流程。\n\n` +
          HOOK_BYPASS_HINT,
      };
    }
    // Versions match → allow (continue checking other matches in cmd)
  }

  return null;
}

const GATE_BUCKETS = Object.freeze({
  HARD: "hard",
  ADVISORY: "advisory",
  STATE_BACKED: "state-backed",
  STATE_UPDATE: "state-update",
  MOVED: "moved",
  DELETE: "delete",
});

const GATE_DECISIONS = Object.freeze({
  BLOCK: "block",
  ADVISORY: "advisory",
  STATE_UPDATE: "state-update",
});

const INVALID_BLOCKING_EVIDENCE = new Set([
  "raw-full-command-regex",
  "normative-workflow-debt",
]);

const BLOCKING_BUCKETS = new Set([
  GATE_BUCKETS.HARD,
  GATE_BUCKETS.STATE_BACKED,
]);

function validateGateInventory(gates) {
  const validBuckets = new Set(Object.values(GATE_BUCKETS));
  const validDecisions = new Set(Object.values(GATE_DECISIONS));

  for (const gate of gates) {
    for (const field of ["id", "bucket", "decision", "evidence", "risk", "runner"]) {
      if (!gate[field]) throw new Error(`Gate inventory entry missing ${field}`);
    }
    if (!validBuckets.has(gate.bucket)) {
      throw new Error(`Gate inventory entry ${gate.id} has invalid bucket ${gate.bucket}`);
    }
    if (!validDecisions.has(gate.decision)) {
      throw new Error(`Gate inventory entry ${gate.id} has invalid decision ${gate.decision}`);
    }
    if (typeof gate.runner !== "function") {
      throw new Error(`Gate inventory entry ${gate.id} runner must be a function`);
    }
    if (gate.decision === GATE_DECISIONS.BLOCK) {
      if (!BLOCKING_BUCKETS.has(gate.bucket)) {
        throw new Error(`Blocking gate ${gate.id} must be hard or state-backed`);
      }
      if (INVALID_BLOCKING_EVIDENCE.has(gate.evidence)) {
        throw new Error(`Blocking gate ${gate.id} cannot use ${gate.evidence} evidence`);
      }
    }
  }
  return gates;
}

function defineGateInventory(gates) {
  validateGateInventory(gates);
  return Object.freeze(gates.map((gate) => Object.freeze({ ...gate })));
}

/**
 * Resolve the active rigor level for Layer 2 gate filtering.
 * run-hook.mjs (Layer 1) already resolved and injected DEVPRO_AGENT_RULES_LEVEL;
 * we read it directly here rather than re-running the full resolution logic so
 * that pre-tool-gate.mjs remains runnable standalone (tests inject the env var).
 */
function resolvedGateLevel() {
  const v = process.env.DEVPRO_AGENT_RULES_LEVEL;
  if (v === "off" || v === "lite" || v === "full") return v;
  return "full";
}

/**
 * Determine whether a gate should be skipped at the current rigor level.
 *
 * Rules:
 *   full → never skip
 *   lite → skip advisory-bucket gates that are NOT in BASELINE_GATE_IDS
 *           (blocking workflow gates remain; only non-baseline advisory subset is skipped)
 *   off  → skip any gate whose id is NOT in BASELINE_GATE_IDS
 *
 * IMPORTANT: If you rename or remove a gate-id that is listed in BASELINE_GATE_IDS
 * (lib/rigor-level.mjs), you MUST update that constant as well, or the gate will be
 * unintentionally skipped when level=off. The reverse is also true: adding an id to
 * BASELINE_GATE_IDS that does not match any real gate-id is a silent no-op here.
 */
function shouldSkipGate(gateId, bucket, level) {
  if (level === "full") return false;
  const isBaseline = BASELINE_GATE_IDS.includes(gateId);
  if (isBaseline) return false; // baseline gates always run

  if (level === "off") return true; // off: skip all non-baseline

  // lite: skip non-baseline advisory gates; keep blocking/state-update gates
  if (level === "lite") {
    return bucket === GATE_BUCKETS.ADVISORY;
  }

  return false;
}

function runGateInventory(gates, ctx) {
  const level = resolvedGateLevel();
  let advisoryResult = null;
  for (const gate of gates) {
    if (shouldSkipGate(gate.id, gate.bucket, level)) continue;
    const result = gate.runner(ctx);
    if (!result) continue;
    if (result.block) return result;
    if (result.advisory && !advisoryResult) advisoryResult = result;
  }
  return advisoryResult;
}

function runStateUpdateInventory(gates, ctx) {
  const level = resolvedGateLevel();
  for (const gate of gates) {
    if (shouldSkipGate(gate.id, gate.bucket, level)) continue;
    gate.runner(ctx);
  }
}

// The operation text of a `gh api graphql` call is its `query` field (inline, or `query=@file`).
// Deciding "this is a mutation" from the whole command line would also match the word in a
// variable value or in a string literal of a read-only query, so only the operation text counts.
function extractGraphqlQueryTexts(raw, readFileSync) {
  const texts = [];
  const queryField = /(?:^|[\s"'])(?:-f|-F|--field|--raw-field)(?:=|\s+)(?:'query=([^']*)'|"query=((?:[^"\\]|\\.)*)"|query=(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)))/g;
  for (const match of raw.matchAll(queryField)) {
    const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "";
    if (value.startsWith("@")) {
      const source = value.slice(1);
      if (readFileSync && source && source !== "-") {
        try {
          texts.push(String(readFileSync(source, "utf8")));
        } catch {
          // unreadable query file: no operation text to classify here
        }
      }
      continue;
    }
    texts.push(value);
  }
  return texts;
}

function graphqlOperationWithoutStringsAndComments(text) {
  return String(text)
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/#[^\n]*/g, "");
}

// The strict variable and dynamic-body rules exist to certify the body of a top-level issue or PR
// comment, the carrier of a lineage approval. `addComment` is the only GraphQL mutation that creates
// one; a mutation outside that carrier, such as a Session Recap `createDiscussion`, a review-thread
// resolve, or a review-thread reply (which creates a review comment, not an issue or PR comment),
// carries ordinary variables.
function graphqlOperationCreatesComment(text) {
  const operation = graphqlOperationWithoutStringsAndComments(text);
  return /\bmutation\b/i.test(operation) && /\baddComment\b/i.test(operation);
}

function checkPostPrLineageApprovalCommentWriteGuard(cmd, io = {}) {
  const raw = typeof cmd === "string" ? cmd : "";
  if (!raw) return null;
  const command = gateCommandSegmentText(raw);
  const commentCommand = isGhPrIssueCommentCommand(command);
  const ghApi = /\bgh\s+api\b/i.test(command);
  const apiCommentRoute = /(?:repos\/[^\s/"']+\/[^\s/"']+|repositories\/[^\s/"']+)\/issues\/(?:comments(?:\/[^/?#\s"'`]+)?|[^/\n]+?\/comments(?:\/[^/?#\s"'`]+)?)(?=$|[?#\s"'`])/i.test(raw);
  const graphqlRoute = ghApi && /\bgraphql\b/i.test(command);
  const curlRoute = /\bcurl\b/i.test(command) && /api\.github\.com/i.test(raw) && apiCommentRoute;
  const namedClientRoute = /\b(?:octokit\s*\.\s*rest\s*\.\s*issues\s*\.(?:createComment|updateComment|deleteComment)|IssueComment\s*\.\s*delete\s*\()/i.test(raw);
  const commentWriter = commentCommand || (ghApi && apiCommentRoute) || graphqlRoute || curlRoute || namedClientRoute;
  if (!commentWriter) return null;

  const containsApprovalMarker = (value) => {
    const text = String(value ?? "");
    if (text.includes(POST_PR_LINEAGE_APPROVAL_MARKER)) return true;
    // GraphQL variables and API request bodies often escape angle brackets
    // before JSON encoding. Normalize one or more escaped backslashes too, so
    // a source that decodes to the approval marker cannot bypass this guard.
    const decoded = text
      .replace(/\\+u003c/gi, "<")
      .replace(/\\+u003e/gi, ">")
      .replace(/\\+x3c/gi, "<")
      .replace(/\\+x3e/gi, ">");
    return decoded.includes(POST_PR_LINEAGE_APPROVAL_MARKER);
  };

  const readFileSync = typeof io.readFileSync === "function" ? io.readFileSync : null;
  let approvalBody = containsApprovalMarker(raw);
  const bodyFiles = new Set(extractCrossModelWaiverCommentBodyFilePaths(raw));
  const curlBodyCommand = raw.replace(/\\\r?\n/g, " ");
  if (curlRoute) {
    for (const match of curlBodyCommand.matchAll(/(?:^|[\s"'])(?:(?:--json|--data(?:-binary|-raw|-urlencode)?)(?:=|\s+)|-d(?:=|\s+|(?=@)))(?:"([^"]+)"|'([^']+)'|(\S+))/gi)) {
      const candidate = match[1] || match[2] || match[3] || "";
      const source = candidate.startsWith("@") ? candidate.slice(1) : candidate;
      if (/^(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/i.test(source) || source.startsWith("<(")) {
        return { block: true, reason: "Lineage Approval Write Guard：PR comment body source 無法安全讀取，fail-closed 拒絕。" };
      }
      if (candidate.startsWith("@")) bodyFiles.add(source);
    }
  }
  const stdinBodySource = /(?:--input|--body-file|--body-path)(?:=|\s+)(?:"|')?@?(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)(?:"|')?(?:\s|$)/i.test(raw)
    || /(?:--field|--raw-field|-f|-F)(?:=|\s+)(?:["']?)(?:body|[A-Za-z_][A-Za-z0-9_]*)(?:=["']?@?(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)["']?)(?:\s|$)/i.test(raw);
  // The strict variable and dynamic-body rules exist to certify a comment mutation's body.
  // A read-only query (e.g. reviewThreads with owner/number variables) writes nothing, so it
  // must not be refused; a marker anywhere in the command or a readable body source is still
  // caught below.
  // With no readable `query` field to classify, fall back to the whole command (fail-closed).
  const graphqlQueryTexts = graphqlRoute ? extractGraphqlQueryTexts(raw, readFileSync) : [];
  const graphqlCommentMutation = graphqlRoute && (graphqlQueryTexts.length > 0
    ? graphqlQueryTexts.some(graphqlOperationCreatesComment)
    : /\bmutation\b/i.test(raw));
  // A GraphQL call that is not a comment mutation (a Session Recap `createDiscussion`, a read query)
  // has no comment body to certify, so an unreadable or stdin body source is not refused for it.
  const nonCommentGraphql = graphqlRoute && !graphqlCommentMutation
    && !commentCommand && !(ghApi && apiCommentRoute) && !curlRoute && !namedClientRoute;
  if (stdinBodySource && !nonCommentGraphql) {
    return { block: true, reason: "Lineage Approval Write Guard：PR comment body source 無法安全讀取，fail-closed 拒絕。" };
  }
  const graphqlNonBodyVariable = graphqlCommentMutation
    && /(?:^|\s)(?:-f|-F|--field|--raw-field)(?:=|\s+)["']?(?!query=|body=)[A-Za-z_][A-Za-z0-9_-]*=/i.test(raw);
  if (graphqlNonBodyVariable) {
    return { block: true, reason: "Lineage Approval Write Guard：GraphQL comment mutation 使用非 body 變數，fail-closed 拒絕。" };
  }
  const dynamicGraphqlBody = graphqlCommentMutation && /(?:\$\(|\x60|\$')/i.test(raw);
  if (dynamicGraphqlBody) {
    return { block: true, reason: "Lineage Approval Write Guard：dynamic GraphQL comment body 無法安全判定是否為 approval，fail-closed 拒絕。" };
  }
  if (readFileSync && graphqlRoute) {
    // `-F query=@file` / `-F var=@file`: a readable file carrying the marker is a comment
    // write; an unreadable one is not a declared body source, so it is not refused here.
    for (const match of raw.matchAll(/(?:^|[\s"'])(?:-F|--field)(?:=|\s+)["']?[A-Za-z_][A-Za-z0-9_-]*=@(?:"([^"]+)"|'([^']+)'|([^\s"']+))/g)) {
      const source = match[1] || match[2] || match[3] || "";
      if (!source || source === "-") continue;
      try {
        if (containsApprovalMarker(readFileSync(source, "utf8"))) approvalBody = true;
      } catch {
        // unreadable read-only query/variable file: not a certified body source
      }
    }
  }
  if (readFileSync) {
    for (const filePath of bodyFiles) {
      try {
        if (containsApprovalMarker(readFileSync(filePath, "utf8"))) approvalBody = true;
      } catch {
        // An unreadable declared body source cannot be certified as ordinary reviewer text.
        if (!nonCommentGraphql && (commentCommand || apiCommentRoute || graphqlRoute || curlRoute || namedClientRoute)) {
          if (isShellExpandedToken(filePath)) {
            // #3556: name the cause; the shell expands the path only after this hook has to read the file.
            return { block: true, reason: `Lineage Approval Write Guard：comment body file 路徑 ${filePath} 寫成 shell 變數或命令替換。hook 在 shell 展開之前就要讀檔，讀不到內容，所以 fail-closed 拒絕。請改用字面絕對路徑，例如 --body-file <main-checkout-root>/notes/tmp/<purpose>-<unique>.md。` };
          }
          return { block: true, reason: "Lineage Approval Write Guard：PR comment body source 無法讀取，fail-closed 拒絕。" };
        }
      }
    }
  } else if (bodyFiles.size > 0) {
    return { block: true, reason: "Lineage Approval Write Guard：PR comment body source 無法讀取，fail-closed 拒絕。" };
  }

  const methodDelete = /(?:--method(?:=|\s+)delete\b|-X\s*delete\b|-Xdelete\b)/i.test(raw);
  const methodPatch = /(?:--method(?:=|\s+)patch\b|-X\s*patch\b|-Xpatch\b)/i.test(raw);
  const deleteLast = new RegExp(`${GH_PR_ISSUE_COMMENT_COMMAND_SOURCE}[\\s\\S]*?--delete-last\\b`, "i").test(command);
  const editLast = new RegExp(`${GH_PR_COMMENT_COMMAND_SOURCE}[\\s\\S]*?--edit-last\\b`, "i").test(command);
  const graphqlDelete = graphqlRoute && /\bdeleteIssueComment\b/i.test(raw);
  const graphqlUpdate = graphqlRoute && /\bupdateIssueComment\b/i.test(raw);
  const namedClientEditOrDelete = namedClientRoute && /\b(?:updateComment|deleteComment|create_comment|edit\s*\(|delete\s*\()/i.test(raw);
  const apiDeleteOrEdit = apiCommentRoute && (methodDelete || methodPatch);
  const curlDelete = curlRoute && /(?:-X\s*delete\b|--request(?:=|\s+)delete\b)/i.test(raw);
  if (deleteLast || editLast || graphqlDelete || graphqlUpdate || apiDeleteOrEdit || curlDelete || namedClientEditOrDelete) {
    return { block: true, reason: "Lineage Approval Write Guard：agent 不得修改或刪除 PR comment；目標無法安全證明不是 lineage approval 時 fail-closed。" };
  }
  if (approvalBody) {
    return { block: true, reason: `Lineage Approval Write Guard：agent 不得建立含 ${POST_PR_LINEAGE_APPROVAL_MARKER} 的 PR comment。` };
  }

  const dynamicBody = /(?:--body(?:=|\s+)|(?:^|\s)(?:-f|-F|--field|--raw-field)\s+body=)(?:"?(?:\$\{?[A-Za-z_][A-Za-z0-9_]*|@-|<\(cat|\$\(|\x60))/i.test(raw)
    || (curlRoute && /(?:--json|--data(?:-binary|-raw|-urlencode)?|-d)(?:=|\s+)[^\n]*(?:\$\{?[A-Za-z_][A-Za-z0-9_]*|@-|<\(cat|\$\(|\x60)/i.test(curlBodyCommand));
  if (dynamicBody && (commentCommand || (ghApi && apiCommentRoute) || graphqlCommentMutation || curlRoute || namedClientRoute)) {
    return { block: true, reason: "Lineage Approval Write Guard：dynamic PR comment body 無法安全判定是否為 approval，fail-closed 拒絕。" };
  }
  return null;
}

const BASH_BLOCKING_GATES = defineGateInventory([
  {
    // Gate HO — token-waste invariant #1: raw high-output command (no repo-external
    // log redirect). Cheap pure-string classification; placed first so it short-circuits
    // before heavier state-backed gates. Escape hatch (redirect to /tmp/$TMPDIR) lives
    // in the classifier so legitimate captured forms pass.
    id: "high-output-raw-command",
    bucket: GATE_BUCKETS.HARD,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "tokenized-command-position",
    risk: "token-waste-transcript-flood",
    runner: ({ cmd, baseCwd }) => checkHighOutputRawCommand(cmd, baseCwd),
  },
  {
    id: "duplicate-rule-load-ledger",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "repo-state",
    risk: "token-waste-rule-reload",
    runner: ({ cmd, baseCwd, effectiveCwd, payload }) =>
      checkDuplicateRuleLoadLedger(cmd, baseCwd, effectiveCwd, payload),
  },
  {
    id: "shell-wrapper-git-gh-bypass",
    bucket: GATE_BUCKETS.HARD,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "tokenized-command-position",
    risk: "tool-surface-bypass",
    runner: ({ cmd }) => checkShellWrapperGitBypass(cmd),
  },
  {
    // Gate 2c — restored to hard block (issue #947 finding 3). squash/rebase merge into
    // main destroys the promotion-unit boundary the release line depends on
    // (release-integrity violation per Evidence-First). Independent of the cross-model
    // sticky merge gate; a sticky PASS/WARN does NOT release it.
    id: "merge-strategy",
    bucket: GATE_BUCKETS.HARD,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "tokenized-command-position",
    risk: "release-integrity",
    runner: ({ cmd }) => checkMergeStrategy(cmd),
  },
  {
    id: "repo-scope-evidence",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "repo-state",
    risk: "cross-repo-write",
    runner: ({ cmd, baseCwd }) => checkRepoScopeEvidence(cmd, baseCwd),
  },
  {
    id: "protected-branch-write",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "repo-state",
    risk: "protected-branch-write",
    runner: ({ protectedBranchResult }) =>
      protectedBranchResult?.block ? protectedBranchResult : null,
  },
  {
    id: "force-push",
    bucket: GATE_BUCKETS.HARD,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "tokenized-command-position",
    risk: "destructive-history-rewrite",
    runner: ({ cmd }) => checkForcePush(cmd),
  },
  {
    id: "commit-attribution-brand-leak",
    bucket: GATE_BUCKETS.HARD,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "commit-message-content",
    risk: "compliance-attribution",
    // asBlock passes {block:true, ...} through; filter out version-mismatch blocks so
    // that only brand-leak blocks (no riskClass / compliance-attribution) fire here.
    runner: ({ cmd, baseCwd }) => {
      const r = checkCommitAttribution(cmd, baseCwd);
      if (!r?.block || r?.riskClass === "release-integrity") return null;
      return asBlock(r);
    },
  },
  {
    id: "commit-attribution-version-mismatch",
    bucket: GATE_BUCKETS.HARD,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "commit-message-content",
    risk: "release-integrity",
    // Only fires on version-mismatch blocks (riskClass === "release-integrity").
    runner: ({ cmd, baseCwd }) => {
      const r = checkCommitAttribution(cmd, baseCwd);
      if (!r?.block || r?.riskClass !== "release-integrity") return null;
      return asBlock(r);
    },
  },
  {
    id: "upstream-pollution",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "repo-state",
    risk: "release-integrity",
    runner: ({ cmd, branch, baseCwd }) => checkUpstreamPollution(cmd, branch, baseCwd),
  },
  {
    id: "committed-diff-whitespace-push",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "repo-state",
    risk: "release-integrity",
    runner: ({ cmd, baseCwd, effectiveCwd, branch }) =>
      checkCommittedDiffWhitespacePush(cmd, baseCwd, effectiveCwd, branch),
  },
  {
    id: "chore-code-size-push",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "repo-state",
    risk: "review-integrity",
    // Block or null only: a not-checked notice rides the composite push advisory
    // (a blocking runner returning an advisory would short-circuit the dispatch).
    runner: (ctx) =>
      checkChoreCodeSizePush(ctx.cmd, ctx.baseCwd, ctx.effectiveCwd, ctx.branch, ctx),
  },
  {
    id: "hotfix-base-production-tag",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "repo-state",
    risk: "production-line-integrity",
    runner: ({ cmd, baseCwd }) => checkHotfixBaseFromProductionTag(cmd, baseCwd),
  },
  {
    id: "release-rules-base-production-tag",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "repo-state",
    risk: "consumer-rules-release-integrity",
    runner: ({ cmd, baseCwd }) => checkReleaseRulesBaseFromProductionTag(cmd, baseCwd),
  },
  {
    id: "production-tag-shape-version",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "repo-state",
    risk: "release-integrity",
    runner: ({ cmd, baseCwd, effectiveCwd }) =>
      checkProductionTagGate(cmd, baseCwd, effectiveCwd),
  },
  {
    id: "branch-verb-whitelist",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "repo-state",
    risk: "branch-naming-integrity",
    runner: ({ cmd, baseCwd, effectiveCwd }) =>
      checkBranchVerbWhitelist(cmd, baseCwd, effectiveCwd),
  },
  {
    id: "local-review-pr-head",
    bucket: GATE_BUCKETS.HARD,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "tokenized-command-position",
    risk: "local-review-publication",
    runner: ({ cmd, baseCwd, effectiveCwd }) => checkLocalReviewPrCreate(cmd, baseCwd, effectiveCwd),
  },
  {
    id: "worktree-mandatory-branch-create",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "repo-state",
    risk: "worktree-isolation",
    runner: ({ cmd, baseCwd }) => checkWorktreeMandatoryForBranchCreate(cmd, baseCwd),
  },
  {
    id: "worktree-mandatory-branch-checkout",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "repo-state",
    risk: "worktree-isolation",
    runner: ({ cmd, baseCwd }) => checkWorktreeMandatoryForBranchCheckout(cmd, baseCwd),
  },
  {
    id: "worktree-branch-name-alignment",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "repo-state",
    risk: "workflow-state-corruption",
    runner: ({ cmd, baseCwd }) => checkBranchNameAlignment(cmd, baseCwd),
  },
  {
    id: "post-pr-lineage-approval-comment-write",
    bucket: GATE_BUCKETS.HARD,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "tokenized-command-position",
    risk: "review-integrity",
    runner: ({ cmd }) => checkPostPrLineageApprovalCommentWriteGuard(cmd, { readFileSync }),
  },
  {
    // A gh pr merge stands alone, and one into another repository carries a DEVPRO_CROSS_REPO_PR marker and a
    // DEVPRO_PR_CHECKOUT of that repository (fix-cross-repo-merge-destination). Registered before every gate that reads
    // merge evidence, which then reads the checkout this gate bound.
    id: "cross-repo-pr-merge",
    bucket: GATE_BUCKETS.HARD,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "tokenized-command-position",
    risk: "cross-repo-write",
    runner: ({ cmd, baseCwd, effectiveCwd }) => checkCrossRepoPrMerge(cmd, baseCwd, effectiveCwd),
  },
  {
    id: "cross-model-sticky-merge-review",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "github-pr-state",
    risk: "review-integrity",
    runner: ({ cmd, baseCwd, effectiveCwd }) =>
      checkCrossModelMergeGate(cmd, _mergeEvidenceCwd(cmd, baseCwd, effectiveCwd), _mergeEvidenceBinding(cmd, baseCwd, effectiveCwd)),
  },
  {
    // D2 (enforce-hotfix-release-carrier): create-time counterpart of the
    // base=production block path above — a best-effort early fail using only
    // shell-parseable evidence (see checkProductionBasePrCreate JSDoc for why
    // this is HARD/tokenized-command-position, not STATE_BACKED/github-pr-state
    // like its merge-time sibling: it deliberately does NOT call `gh pr view`).
    // Registered immediately adjacent to cross-model-sticky-merge-review per
    // design D2 (same base-production axis, same message builder). Not in
    // lib/rigor-level.mjs BASELINE_GATE_IDS — rigor `off` skips it, matching the
    // merge-time sibling gate (also non-baseline).
    id: "production-base-pr-create",
    bucket: GATE_BUCKETS.HARD,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "tokenized-command-position",
    risk: "release-integrity",
    runner: ({ cmd, baseCwd, effectiveCwd }) =>
      checkProductionBasePrCreate(cmd, baseCwd, effectiveCwd),
  },
  {
    // Local-test merge evidence (enforce-local-test-merge-evidence): source-repo
    // code/rule-carrier `gh pr merge` hard-blocks unless one of three evidence
    // forms holds for PR headRefOid: (1) exact-head receipt, (2) same-change
    // bookkeeping tip-move receipt, or (3) head-bound seal-final
    // FinalEvidenceRecord verified in a bounded child (see the comment above
    // checkLocalTestGateOnMerge). Registered
    // after sticky so Path B sticky-absent still surfaces as cross-model block
    // (first-truthy short-circuit) in coexistence fixtures.
    id: "local-test-merge-evidence",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "github-pr-state",
    risk: "untested-merge",
    runner: ({ cmd, baseCwd, effectiveCwd }) =>
      checkLocalTestGateOnMerge(cmd, _mergeEvidenceCwd(cmd, baseCwd, effectiveCwd), { bound: _mergeEvidenceBinding(cmd, baseCwd, effectiveCwd) }),
  },
  {
    // Merge-time comparison of the PR description's waiver parts with the answer-time records (r2 of
    // fix-pre-pr-dev-verification-trigger). Its own entry, registered after local-test-merge-evidence so an earlier
    // block keeps its message; it does not sit behind the exempt-branch returns of the cross-model gate. Not a
    // baseline gate, so rigor `off` skips it; a positive source checkout is exempt inside the gate.
    id: "per-pr-waiver-merge-record",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "github-pr-state",
    risk: "pr-body-hygiene",
    runner: ({ cmd, baseCwd, effectiveCwd }) =>
      checkPerPrWaiverOnMerge(cmd, _mergeEvidenceCwd(cmd, baseCwd, effectiveCwd)),
  },
  {
    // Edit-time counterpart: `gh pr edit` with a new description is compared before the edit.
    id: "per-pr-waiver-edit-record",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "github-pr-state",
    risk: "pr-body-hygiene",
    runner: ({ cmd, baseCwd }) => checkPerPrWaiverOnEdit(cmd, baseCwd),
  },
  {
    // Cross-repo pull-request writes: the explicit target of gh pr create/edit/comment against the checkout the command
    // runs in, authorized only by a DEVPRO_CROSS_REPO_PR marker. Registered before pr-body-template-lint (whose runner
    // calls the consumer pre-PR checks gate) so a missing marker is reported with its two fixes first. Not a baseline
    // gate, so rigor `off` skips it. The waiver edit gate above is untouched: the marker does not relax it.
    id: "cross-repo-pr-write",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "tokenized-command-position",
    risk: "cross-repo-write",
    runner: ({ cmd, baseCwd }) => checkCrossRepoPrWrite(cmd, baseCwd),
  },
  {
    id: "production-release-no-ff",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "repo-state",
    risk: "production-release-integrity",
    runner: ({ cmd, branch, baseCwd }) => checkProductionLocalMergeRequiresPr(cmd, branch, baseCwd),
  },
  {
    id: "worktree-absolute-path",
    bucket: GATE_BUCKETS.HARD,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "tokenized-command-position",
    risk: "worktree-location-ambiguity",
    runner: ({ cmd, baseCwd }) => checkWorktreeAbsolutePath(cmd, baseCwd),
  },
  {
    // Gate CH: Context Headroom — task 9 (design.md D3/D5/D8/D12). Fires on
    // Bash invocations of render-second-review-packet.mjs / run-test-suite.mjs
    // (the other Gate CH trigger — Agent/Task dispatch fanout — is wired as a
    // separate matcher, not through this Bash-command table; task 11).
    // Deliberately appended LAST in this array: runGateInventory short-
    // circuits on the first block, so every earlier hard/state-backed block
    // gate above always gets first refusal — a cost advisory must never
    // shadow an existing block gate's message (D5).
    id: "context-headroom-circuit-breaker",
    bucket: GATE_BUCKETS.HARD,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "transcript-tail-read",
    risk: "context-window-exhaustion",
    runner: ({ cmd, effectiveCwd, baseCwd, payload }) =>
      evaluateContextHeadroomGateFromCtx({ cmd, effectiveCwd, baseCwd, payload }),
  },
]);

const BASH_STATE_UPDATE_GATES = defineGateInventory([
  {
    id: "repo-scope-approval-state",
    bucket: GATE_BUCKETS.STATE_UPDATE,
    decision: GATE_DECISIONS.STATE_UPDATE,
    evidence: "repo-state",
    risk: "cross-repo-write",
    runner: ({ cmd, baseCwd }) => updateRepoScopeApprovalState(cmd, baseCwd),
  },
  {
    id: "postmerge-marker-state",
    bucket: GATE_BUCKETS.STATE_UPDATE,
    decision: GATE_DECISIONS.STATE_UPDATE,
    evidence: "repo-state",
    risk: "merge-tracking",
    runner: ({ cmd, branch, baseCwd, effectiveCwd }) =>
      updateMarkers(cmd, branch, {
        stateCwd: baseCwd || process.cwd(),
        commandCwd: effectiveCwd || commandCwd(cmd, baseCwd),
        bound: _mergeMarkerBinding(cmd, baseCwd, effectiveCwd),
      }),
  },
  {
    id: "rule-load-ledger-state",
    bucket: GATE_BUCKETS.STATE_UPDATE,
    decision: GATE_DECISIONS.STATE_UPDATE,
    evidence: "repo-state",
    risk: "token-waste-duplicate-rule-load",
    runner: ({ cmd, baseCwd, effectiveCwd, payload }) =>
      recordRuleLoadLedgerState(cmd, baseCwd, effectiveCwd, payload),
  },
]);

const BASH_ADVISORY_GATES = defineGateInventory([
  {
    id: "pending-worktree-cd",
    bucket: GATE_BUCKETS.ADVISORY,
    decision: GATE_DECISIONS.ADVISORY,
    evidence: "repo-state",
    risk: "worktree-followthrough",
    runner: ({ cmd, baseCwd }) => checkPendingWorktreeCd(cmd, baseCwd),
  },
  {
    id: "protected-branch-uncertain-cwd",
    bucket: GATE_BUCKETS.ADVISORY,
    decision: GATE_DECISIONS.ADVISORY,
    evidence: "ambiguous-repo-state",
    risk: "protected-branch-write",
    runner: ({ protectedBranchResult }) =>
      protectedBranchResult?.advisory ? protectedBranchResult : null,
  },
  {
    // Composite `git commit` advisory: runs the EOF re-stage gate (T3,
    // `enforce-eof-normalize-at-commit`) FIRST — unconditionally, so its
    // index-only re-stage side effect always executes — then the
    // attribution-footer advisory, concatenating whichever fire. Single gate
    // (not two siblings) for the same reason as `merge-advisories`:
    // runGateInventory is first-truthy-wins, so sibling advisory gates on the
    // same commit would mutually suppress. See checkCommitAdvisories.
    id: "commit-advisories",
    bucket: GATE_BUCKETS.ADVISORY,
    decision: GATE_DECISIONS.ADVISORY,
    evidence: "commit-message-content",
    risk: "attribution-hygiene",
    runner: ({ cmd, baseCwd }) => checkCommitAdvisories(cmd, baseCwd),
  },
  {
    // Composite push/PR-create advisory: runs BOTH archive readiness and
    // whitespace effective-scope transparency, avoiding first-truthy suppression
    // when a push has more than one non-blocking follow-up.
    id: "archive-before-push-or-pr-create",
    bucket: GATE_BUCKETS.ADVISORY,
    decision: GATE_DECISIONS.ADVISORY,
    evidence: "external-script-state",
    risk: "openspec-archive-hygiene",
    runner: (ctx) =>
      checkPushOrPrCreateAdvisories(ctx.cmd, ctx.baseCwd, ctx.effectiveCwd, ctx.branch, ctx),
  },
  {
    // Composite `gh pr merge` advisory: cross-model exemption notice only.
    // Local-test evidence is a state-backed BLOCK gate (`local-test-merge-evidence`),
    // not an advisory. Kept composite so future merge notices can concatenate
    // without first-truthy-wins suppression (see checkMergeAdvisories +
    // code-review-cross-model.md §豁免條件 SSOT).
    id: "merge-advisories",
    bucket: GATE_BUCKETS.ADVISORY,
    decision: GATE_DECISIONS.ADVISORY,
    evidence: "github-pr-state",
    risk: "review-transparency",
    runner: ({ cmd, baseCwd, effectiveCwd }) =>
      checkMergeAdvisories(cmd, _mergeEvidenceCwd(cmd, baseCwd, effectiveCwd), _mergeEvidenceBinding(cmd, baseCwd, effectiveCwd)),
  },
  {
    id: "recap-body-lint",
    bucket: GATE_BUCKETS.ADVISORY,
    decision: GATE_DECISIONS.ADVISORY,
    evidence: "structured-payload-file",
    risk: "session-recap-hygiene",
    runner: ({ cmd, baseCwd, payload }) => asAdvisory(checkRecapBodyLint(cmd, baseCwd, payload)),
  },
  {
    id: "pr-body-template-lint",
    bucket: GATE_BUCKETS.HARD,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "structured-payload-file",
    risk: "pr-body-hygiene",
    runner: ({ cmd, baseCwd }) => checkPrBodyTemplateLint(cmd, baseCwd),
  },
  {
    id: "token-frugal-and-workflow-advisories",
    bucket: GATE_BUCKETS.ADVISORY,
    decision: GATE_DECISIONS.ADVISORY,
    evidence: "tokenized-command-position",
    risk: "workflow-hygiene",
    runner: ({ cmd, baseCwd, toolInput, payload }) => checkAdvisories(cmd, baseCwd, { toolInput, payload }),
  },
]);

// ── Gate N — Notes Disposition Advisory ────────────────────────────────────
//
// Advisory (non-blocking) gate that fires when an Edit/Write/MultiEdit writes
// to notes/session-pending.md and one or more top-level list-item blocks are
// missing the required disposition fields `缺輸入:` / `trigger:` / `carrier:`.
//
// A top-level list-item block = the `- ` line plus all immediately following
// lines indented with one or more spaces (continuation lines). Detection scope:
//   - Edit/MultiEdit: scan simulated final file content when old_string exists.
//   - Edit/MultiEdit fallback: scan new_string when no old_string baseline exists.
//   - Write: scan the entire content (conservative — no old baseline available).
//
// Fail-open: payload parse failure, deletion-only edits that leave no
// incomplete final entry, or writes targeting any file other than
// notes/session-pending.md are silently skipped.
//
// Error message shape: fact first (which block, which fields missing), then
// fix (canonical three-field template). Per rule-design-principles.md §Hook
// Error Message Shape.
//
// Disposition rule source: rule-design-principles.md §Workflow Persistence
// Layers — decision-ready 議題禁無要件 defer；實作成本非 defer 理由。

/** Normalize a file path and test whether it ends with notes/session-pending.md. */
function isSessionPendingPath(filePath) {
  if (!filePath) return false;
  const normalized = path.normalize(filePath).replace(/\\/g, "/");
  return normalized === "notes/session-pending.md" ||
    normalized.endsWith("/notes/session-pending.md");
}

const DISPOSITION_FIELDS = ["缺輸入:", "trigger:", "carrier:"];

/**
 * Return the missing disposition fields for a list-item block (array of lines).
 * Returns an empty array when all three fields are present.
 */
function missingDispositionFields(blockLines) {
  return DISPOSITION_FIELDS.filter((field) => {
    // Accept halfwidth `:` or fullwidth `：` after the field name only.
    const name = field.replace(/:$/, "");
    const declaration = new RegExp(`^[\t ]*(?:-[\t ]+)?${name}[:：]`);
    return !blockLines.some((line) => declaration.test(line));
  });
}

/**
 * Check one text snippet for list-item blocks missing disposition fields.
 * Returns an array of { blockIndex, blockPreview, missing } objects.
 * blockIndex is 1-based (for human-readable advisory messages).
 */
function scanDispositionInText(text) {
  const blocks = parseListItemBlocks(text);
  const findings = [];
  for (let i = 0; i < blocks.length; i++) {
    const missing = missingDispositionFields(blocks[i]);
    if (missing.length > 0) {
      const preview = blocks[i][0].slice(0, 60) + (blocks[i][0].length > 60 ? "…" : "");
      findings.push({ blockIndex: i + 1, blockPreview: preview, missing });
    }
  }
  return findings;
}

/**
 * Gate N: Notes Disposition Advisory.
 *
 * @param {{ toolName: string, filePath: string, toolInput: object, baseCwd?: string, readFile?: Function }} ctx
 * @returns {{ advisory: string } | null}
 */
function hasOldStringBaseline(edit) {
  return typeof edit?.old_string === "string" && edit.old_string.length > 0;
}

function readSessionPendingPriorContent(filePath, baseCwd, readFile) {
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(baseCwd || process.cwd(), filePath);
  return readFile(abs);
}

// ── Gate NS — Session-pending column-0 bullet shape ────────────────────────

/** Violating line TEXTS, so a pre-existing one can be cancelled by identity. */
function sessionPendingShapeViolationTexts(content) {
  const lines = String(content ?? "").split("\n");
  return findSessionPendingShapeViolations(content).map((n) => lines[n - 1]);
}

/**
 * Gate NS — block the column-0 `- ` / `* ` bullets THIS payload introduces into
 * a `notes/session-pending.md` that has adopted the `## ` convention.
 *
 * Introduced-only is the whole design. A column-0 bullet is absorbed into the
 * preceding section by both parsers, so a real item written that way silently
 * stops being claimable — worth blocking. But blocking on a violation the
 * author did not write would leave the file editable only through the tool that
 * just blocked it, and the one edit that must stay possible is precisely the
 * migration that removes the existing violations. So each violating line in the
 * final content is cancelled against one identical pre-existing counterpart
 * (multiset difference, which keeps duplicates honest); only the surplus is
 * treated as introduced. `Write` carries no baseline, so per the requirement it
 * conservatively treats every column-0 bullet in `content` as introduced.
 *
 * Separate gate from Gate N: this one blocks on shape, Gate N stays advisory on
 * disposition fields. Neither reads the other's verdict.
 *
 * Returns null (pass) or { block: true, reason: string }.
 */
function checkSessionPendingShape({
  toolName,
  filePath,
  toolInput,
  baseCwd,
  readFile = defaultReadFileSafe,
}) {
  try {
    if (!isSessionPendingPath(filePath)) return null;
    if (toolName !== "Edit" && toolName !== "Write" && toolName !== "MultiEdit") return null;
    const input = toolInput && typeof toolInput === "object" ? toolInput : null;
    if (!input) return null;

    let finalContent = null;
    let priorContent = "";
    let unreconstructableAddition = "";

    if (toolName === "Write") {
      if (typeof input.content !== "string") return null;
      finalContent = input.content;
    } else if (toolName === "Edit") {
      if (hasOldStringBaseline(input)) {
        priorContent = readSessionPendingPriorContent(filePath, baseCwd, readFile) || "";
        finalContent = simulatePostWriteContent(toolName, input, priorContent);
      } else {
        finalContent = typeof input.new_string === "string" ? input.new_string : null;
      }
    } else {
      const edits = Array.isArray(input.edits) ? input.edits : null;
      if (!edits) return null;
      const reconstructable = edits.filter(hasOldStringBaseline);
      if (reconstructable.length > 0) {
        priorContent = readSessionPendingPriorContent(filePath, baseCwd, readFile) || "";
        finalContent = simulatePostWriteContent(
          toolName,
          { ...input, edits: reconstructable },
          priorContent
        );
        // Simulation covers only the entries that carry an old_string baseline.
        // Gate N's sibling below does a second pass over the remainder so their
        // new_string is not silently dropped; mirror it here rather than leave
        // two gates in one file disagreeing about the same tool shape (r3
        // finding F-SPI-16). MultiEdit is atomic and an empty old_string makes
        // the tool error, so this is closing an asymmetry, not a live hole.
        unreconstructableAddition = edits
          .filter((edit) => !hasOldStringBaseline(edit))
          .map((edit) => (typeof edit?.new_string === "string" ? edit.new_string : ""))
          .join("\n");
      } else {
        finalContent = edits
          .map((edit) => (typeof edit?.new_string === "string" ? edit.new_string : ""))
          .join("\n");
      }
    }

    if (typeof finalContent !== "string") return null;
    if (unreconstructableAddition !== "") finalContent = `${finalContent}\n${unreconstructableAddition}`;

    const violations = findSessionPendingShapeViolations(finalContent);
    if (violations.length === 0) return null;

    const carried = new Map();
    for (const text of sessionPendingShapeViolationTexts(priorContent)) {
      carried.set(text, (carried.get(text) || 0) + 1);
    }
    const finalLines = finalContent.split("\n");
    const introduced = [];
    for (const lineNumber of violations) {
      const text = finalLines[lineNumber - 1];
      const remaining = carried.get(text) || 0;
      if (remaining > 0) {
        carried.set(text, remaining - 1);
        continue;
      }
      introduced.push(lineNumber);
    }
    if (introduced.length === 0) return null;

    const shown = introduced.slice(0, 20);
    const overflow = introduced.length - shown.length;
    const lineList = shown.join("、") + (overflow > 0 ? ` …（另 ${overflow} 行）` : "");

    return {
      block: true,
      reason:
        `Gate NS (Session-Pending Shape)：\`notes/session-pending.md\` 已採用 \`## \` 慣例，` +
        `但本次寫入新引入 ${introduced.length} 行頂格（column-0）的 \`- \` / \`* \` bullet。\n\n` +
        `命中行號（1-based，對掃描後的最終內容）：${lineList}\n\n` +
        `頂格 bullet 會被前一個 \`## \` section 吸收，該條目從此不是獨立可 claim 的單位——` +
        `這正是 #59–#92 集體隱形的成因。\n\n` +
        `清除方式二擇一：\n` +
        `  • 那是某個 pending 的證據／子項 → **縮排**（至少兩格）使其成為所屬條目的內容。\n` +
        `  • 那是一個獨立待辦 → 改寫為 \`## <編號>. <標題>\` heading。\n\n` +
        `全檔檢查：\`node .devpro/scripts/session-pending-claim.mjs check-shape\`\n` +
        `既存違規不會觸發本閘（只擋本次新引入的），故遷移用的編輯不會被自己擋住。`,
    };
  } catch {
    // fail-open: never block on gate error
    return null;
  }
}

function checkNotesDisposition({
  toolName,
  filePath,
  toolInput,
  baseCwd,
  readFile = defaultReadFileSafe,
}) {
  try {
    if (!isSessionPendingPath(filePath)) return null;
    if (toolName !== "Edit" && toolName !== "Write" && toolName !== "MultiEdit") return null;

    const allFindings = [];

    if (toolName === "Write") {
      const content = toolInput.content || "";
      const findings = scanDispositionInText(content);
      allFindings.push(...findings);
    } else if (toolName === "Edit") {
      let scanText = toolInput.new_string || "";
      if (hasOldStringBaseline(toolInput)) {
        const priorContent = readSessionPendingPriorContent(filePath, baseCwd, readFile);
        scanText = simulatePostWriteContent(toolName, toolInput, priorContent);
      }
      const findings = scanDispositionInText(scanText);
      allFindings.push(...findings);
    } else if (toolName === "MultiEdit") {
      const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
      const reconstructableEdits = edits.filter(hasOldStringBaseline);
      if (reconstructableEdits.length > 0) {
        const priorContent = readSessionPendingPriorContent(filePath, baseCwd, readFile);
        const finalContent = simulatePostWriteContent(
          toolName,
          { ...toolInput, edits: reconstructableEdits },
          priorContent
        );
        allFindings.push(...scanDispositionInText(finalContent));
      }
      for (const edit of edits.filter((e) => !hasOldStringBaseline(e))) {
        const findings = scanDispositionInText(edit.new_string || "");
        allFindings.push(...findings);
      }
    }

    if (allFindings.length === 0) return null;

    const lines = allFindings.map((f) =>
      `  • 條目 ${f.blockIndex}「${f.blockPreview}」缺欄：${f.missing.join("、")}`
    );

    return {
      advisory:
        `Gate N (Notes Disposition)：偵測 \`notes/session-pending.md\` 寫入含 ${allFindings.length} 個條目缺少必要 disposition 欄位。\n\n` +
        `命中：\n${lines.join("\n")}\n\n` +
        `decision-ready 議題當下議；實作成本不是 defer 理由（per rule-design-principles.md §Workflow Persistence Layers disposition 條款）。\n\n` +
        // Opener is `## `, not a column-0 bullet: a bullet here would be a
        // remediation template teaching the very shape Gate NS blocks 200
        // lines below, and an author who followed it would be stopped by this
        // same file (r3 finding F-SPI-17). Shape matches Gate NS's own
        // remediation sentence so the two messages cannot drift.
        `三欄範本：\n` +
        `\`\`\`\n` +
        `## <編號>. <議題描述>\n` +
        `  缺輸入: <缺少的具名輸入>\n` +
        `  trigger: <何時重議>\n` +
        `  carrier: <誰追蹤>\n` +
        `\`\`\``,
    };
  } catch {
    // fail-open: never block on gate error
    return null;
  }
}

// ── Gate SP — Session-pending batch approval ledger pre-write ──────────────

function activeChangeNameFromBranch(branch) {
  const match = String(branch || "").match(/^(?:feature|bugfix|hotfix|chore)\/(.+)$/);
  return match?.[1]?.trim() || "";
}

function mainCheckoutRootForCwd(cwd = process.cwd()) {
  try {
    return defaultMainCheckoutRoot(cwd);
  } catch {
    const repoRoot = gitRootForCwd(cwd);
    return repoRoot || resolveSafe(cwd);
  }
}

function sessionPendingPathForCwd(cwd = process.cwd()) {
  return path.join(mainCheckoutRootForCwd(cwd), "notes", "session-pending.md");
}

function parseNumberedSessionPendingBlocks(text) {
  if (!text) return [];
  const blocks = [];
  let current = null;
  const flush = () => {
    if (current) blocks.push(current);
    current = null;
  };

  for (const line of text.split("\n")) {
    if (/^\d+\.\s/.test(line)) {
      flush();
      current = [line];
    } else if (current && (line.trim() === "" || /^[\t ]+/.test(line))) {
      current.push(line);
    } else if (current && /^[-*]\s/.test(line)) {
      flush();
    } else if (current && line.trim() !== "") {
      flush();
    }
  }
  flush();
  return blocks;
}

function parseSessionPendingBlocksForClaim(text) {
  return [
    ...parseListItemBlocks(text),
    ...parseNumberedSessionPendingBlocks(text),
  ];
}

function sessionPendingBlockClaimsChange(blockLines, changeName) {
  const escaped = escapeRegExp(changeName);
  const block = blockLines.join("\n");
  return new RegExp(`^[\\t ]*(?:[-*][\\t ]*)?claimed:[\\t ]*${escaped}[\\t ]*$`, "mi")
    .test(block);
}

// Only an `approval:` sub-item outside code fences is an approval record
// (`session-pending-lifecycle.md` §批次授權紀錄). Headings and other bullets that
// mention these terms are topic text, e.g. an item that discusses approvals.
const SESSION_PENDING_APPROVAL_LINE = /^[\t ]*(?:[-*][\t ]*)?approval:/i;
const SESSION_PENDING_BATCH_APPROVAL_TERMS = /batch approval|批次授權|整批授權|授權.*PR merge|PR merge.*授權/i;

function sessionPendingBlockRecordsBatchApproval(blockLines, changeName) {
  if (!sessionPendingBlockClaimsChange(blockLines, changeName)) return false;
  let recorded = false;
  forEachMarkdownLine(blockLines.join("\n"), (line, _index, { inFence }) => {
    if (!inFence && SESSION_PENDING_APPROVAL_LINE.test(line) &&
        SESSION_PENDING_BATCH_APPROVAL_TERMS.test(line)) recorded = true;
  });
  return recorded;
}

function claimedSessionPendingBatchApprovalBlock(content, changeName) {
  for (const block of parseSessionPendingBlocksForClaim(content)) {
    if (sessionPendingBlockRecordsBatchApproval(block, changeName)) return block;
  }
  return null;
}

function normalizedRepoRelativePathWithCwdFallback(filePath, baseCwd = process.cwd()) {
  const rel = normalizedRepoRelativePath(filePath, baseCwd);
  if (rel) return rel;

  try {
    if (!filePath) return "";
    const repoRoot = gitRootForCwd(baseCwd);
    if (!repoRoot) return "";

    const absolute = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(baseCwd, filePath);
    const root = resolveSafe(repoRoot);
    const relative = path.relative(root, absolute);
    if (!relative || relative === "." || relative === "..") return "";
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return "";
    return relative.split(path.sep).join("/");
  } catch {
    return "";
  }
}

function isActiveOpenSpecChangeWrite(filePath, baseCwd, changeName) {
  const rel = normalizedRepoRelativePathWithCwdFallback(filePath, baseCwd);
  return rel === `openspec/changes/${changeName}` ||
    rel.startsWith(`openspec/changes/${changeName}/`);
}

function readActiveProposalForChange(repoRoot, changeName, readFile = defaultReadFileSafe) {
  const base = path.join(repoRoot, "openspec", "changes", changeName);
  const candidates = [
    path.join(base, "proposal-mini.md"),
    path.join(base, "proposal.md"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const content = readFile(candidate);
    if (content) return { path: candidate, content };
  }
  return { path: candidates[0], content: "" };
}

// Lite rigor writes no proposal; its Step 0 batch conclusion is the one-line
// untracked `openspec/changes/<change>/lite-scope.md` record. It is read from the
// same checkout root as the proposal (the linked worktree when implementing from
// one), because the record is gitignored and exists only there. Judged by file
// content only; no Bash command string is parsed.
function liteScopeRecordPath(changeName) {
  return `openspec/changes/${changeName}/lite-scope.md`;
}

const LITE_RECORD_TEMPLATE =
  "kind=same-change-dp-change-batch; named_change=<change-name>; branch=<branch>; repo_scope=same-repo; " +
  "covers=worktree,local_commit,pre_pr_gate,first_push,pr_create_update,workflow_watch,post_pr_completion_gate,scenario_walkthrough; " +
  "excludes=merge,release,destructive,secrets,cross_repo_write";

// Archived folders `openspec/changes/archive/<YYYY-MM-DD>-<changeName>/` that still hold a
// proposal carrier. Exact-name match only (`<date>-<changeName>-extra` is another change).
// Gate SP archive identity: any read error means "not archived".
function archivedChangeFoldersFor(repoRoot, changeName) {
  try {
    const archiveRoot = path.join(repoRoot, "openspec", "changes", "archive");
    const namePattern = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${escapeRegExp(changeName)}$`);
    const folders = [];
    for (const entry of readdirSync(archiveRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !namePattern.test(entry.name)) continue;
      const dir = path.join(archiveRoot, entry.name);
      if (existsSync(path.join(dir, "proposal.md")) || existsSync(path.join(dir, "proposal-mini.md"))) {
        folders.push(`openspec/changes/archive/${entry.name}`);
      }
    }
    return folders.sort();
  } catch {
    return [];
  }
}

// True only when the active change folder is definitely absent (ENOENT); other read errors are unknown.
function activeChangeFolderDefinitelyAbsent(repoRoot, changeName) {
  try {
    statSync(path.join(repoRoot, "openspec", "changes", changeName));
    return false;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

function archivedBatchApprovalReason(changeName, archivedFolders) {
  return (
    `Gate SP (Session Pending Batch Approval Ledger)：\`notes/session-pending.md\` 已 claim \`${changeName}\` 並記錄 batch approval，` +
    `但 active proposal 不存在，change 已封存於：\n` +
    archivedFolders.map((folder) => `  • \`${folder}\`\n`).join("") +
    `\n若要對這個已封存的 change 做非記帳類修改（例如 archived spec delta 的 body／scenario），走 pre-merge re-archive（\`openspec-archive-principles.md\` §Pre-merge Archive Re-do），順序：\n` +
    `  1. 先依 Undo-Archive Preserve Checklist 備份 gitignored 的 \`admission-records/\`；\n` +
    `  2. revert archive commit 還原 active 資料夾；若 archive commit 同時含實作，改走 active-missing continuation；\n` +
    `  3. 修改後重新 archive。\n\n` +
    `若這是用同名開的新 change、不是要改已封存的那個：先建 \`openspec/changes/${changeName}/proposal.md\` 並寫 \`## Batch Approval Ledger\`` +
    `（該目錄的寫入不受本閘限制），不要回頭 revert 舊封存。\n\n` +
    `若只是封存後的記帳類編輯（proposal／tasks／decisions／qa-test-scope；見 \`post-pr-completion-gate.md\` 的「Post-archive 修復落點」）：` +
    `不要為此 re-archive。本閘只放行 active 目錄確定不存在、且唯一同名封存目錄根下的 proposal.md／proposal-mini.md／tasks.md／decisions.md／qa-test-scope.md；其他路徑或不唯一的封存仍會擋，請停下回報使用者。` +
    `不要為此寫 lite 紀錄（lite 載體不適用於已封存的 full change）。`
  );
}

function checkSessionPendingBatchApprovalLedgerPrewrite({
  toolName,
  filePath,
  branch,
  baseCwd,
  readFile = defaultReadFileSafe,
}) {
  try {
    if (!filePath || !isFileWriteToolName(toolName)) return null;
    const activeBranch = branch || branchForPath(filePath, baseCwd);
    const changeName = activeChangeNameFromBranch(activeBranch);
    if (!changeName) return null;

    const rel = normalizedRepoRelativePathWithCwdFallback(filePath, baseCwd);
    if (!rel) return null;
    if (isActiveOpenSpecChangeWrite(filePath, baseCwd, changeName)) return null;
    if (isSessionPendingPath(rel)) return null;

    const pendingPath = sessionPendingPathForCwd(baseCwd);
    const pendingContent = readFile(pendingPath);
    const claimedBlock = claimedSessionPendingBatchApprovalBlock(pendingContent, changeName);
    if (!claimedBlock) return null;

    const repoRoot = gitRootForPath(filePath, baseCwd) || gitRootForCwd(baseCwd);
    if (!repoRoot) return null;
    const proposal = readActiveProposalForChange(repoRoot, changeName, readFile);
    if (!proposal.content) {
      // No proposal carrier (lite rigor): a matching lite scope record is the carrier.
      const record = readLiteScopeRecord(repoRoot, { changeName, branch: activeBranch });
      if (record.status === "match") return null;
      const archivedFolders = archivedChangeFoldersFor(repoRoot, changeName);
      if (archivedFolders.length > 0 && activeChangeFolderDefinitelyAbsent(repoRoot, changeName)) {
        // Match only the exact archived change and root bookkeeping carriers.
        // As with active artifact writes, this permits repairing the ledger;
        // implementation writes still require a matching active carrier.
        if (archivedFolders.length === 1 &&
            ["proposal.md", "proposal-mini.md", "tasks.md", "decisions.md", "qa-test-scope.md"]
              .some((file) => rel === `${archivedFolders[0]}/${file}`)) return null;
        return { block: true, reason: archivedBatchApprovalReason(changeName, archivedFolders) };
      }
      const recordPath = liteScopeRecordPath(changeName);
      const recordState = record.status === "missing" ? "不存在" : `為 \`${record.status}\`：${record.issue}`;
      return {
        block: true,
        reason:
          `Gate SP (Session Pending Batch Approval Ledger)：\`notes/session-pending.md\` 已 claim \`${changeName}\` 並記錄 batch approval，` +
          `但找不到可滿足它的載體。兩種載體擇一即可：\n` +
          `  • full：\`openspec/changes/${changeName}/proposal.md\`／\`proposal-mini.md\` 的 \`## Batch Approval Ledger\`（structured ledger），目前沒有 proposal。\n` +
          `  • lite（無 proposal）：單行未追蹤紀錄 \`${recordPath}\`，目前${recordState}。\n\n` +
          `lite 紀錄範本（欄位順序固定、一行、\`; \` 分隔、清單以 \`,\` 分隔無空白）：\n\`${LITE_RECORD_TEMPLATE}\`\n\n` +
          `只在使用者第零步選了 batch approval 之後才寫，寫入的同一輪回覆須貼出該行。` +
          `\`openspec/changes/${changeName}/\` 下的寫入（含 \`lite-scope.md\`）不受本閘限制，可先寫／修正再進行非 OpenSpec repo write。`,
      };
    }
    const issue = evaluateBatchApprovalLedgerForSessionPendingPrewrite(proposal.content, {
      changeName,
      branch: activeBranch,
    });
    if (!issue) return null;

    if (issue.startsWith(LEGACY_DISCLOSURE_ISSUE_PREFIX)) {
      return {
        block: true,
        reason:
          `Gate SP (Session Pending Batch Approval Ledger)：\`notes/session-pending.md\` 已 claim \`${changeName}\` 並記錄 batch approval，` +
          `但 active proposal/proposal-mini 的 \`Batch Approval Ledger\` ${issue}\n\n` +
          `修正 \`openspec/changes/${changeName}/proposal-mini.md\` 或 \`proposal.md\`（\`openspec/changes/${changeName}/\` 下的寫入不受本閘限制），再進行非 OpenSpec repo write。`,
      };
    }

    return {
      block: true,
      reason:
        `Gate SP (Session Pending Batch Approval Ledger)：\`notes/session-pending.md\` 已 claim \`${changeName}\` 並記錄 batch approval，但 active proposal/proposal-mini 的 \`Batch Approval Ledger\` ${issue}。\n\n` +
        `先寫／修正 \`openspec/changes/${changeName}/\`（meeting-notes／proposal／design；OpenSpec artifact writes under this path are allowed before／without waiting on claim）的 structured ledger，再進行非 OpenSpec repo write。合法 \`kind\` 僅 \`same-change-dp-change-batch\`；更窄的自訂範圍請用 \`excludes\` 表達，不要自訂 \`kind\` 值。`,
    };
  } catch {
    // fail-open: this gate blocks only when repo state and evidence are definite.
    return null;
  }
}

// ── Gate R1 — General-mode batch approval ledger pre-write ─────────────────
//
// Unlike Gate SP (which only fires once session-pending has claimed the
// change AND recorded a batch approval), this gate fires unconditionally for
// any `<type>/<change>` branch that has an active proposal: the Step-0
// conclusion (batch approval vs. stepwise) MUST be recorded in the ledger
// either way. Polarity is the opposite of Gate SP's: `N/A: no batch approval
// selected` is a legitimate Step-0 conclusion in general mode, so it PASSES
// here (design.md D3 "新一般模式 gate（R1）").
function checkGeneralModeBatchApprovalLedgerPrewrite({
  toolName,
  filePath,
  branch,
  baseCwd,
  readFile = defaultReadFileSafe,
}) {
  try {
    if (!filePath || !isFileWriteToolName(toolName)) return null;
    const activeBranch = branch || branchForPath(filePath, baseCwd);
    const changeName = activeChangeNameFromBranch(activeBranch);
    if (!changeName) return null;

    const rel = normalizedRepoRelativePathWithCwdFallback(filePath, baseCwd);
    if (!rel) return null;
    if (isActiveOpenSpecChangeWrite(filePath, baseCwd, changeName)) return null;
    if (isSessionPendingPath(rel)) return null;

    const repoRoot = gitRootForPath(filePath, baseCwd) || gitRootForCwd(baseCwd);
    if (!repoRoot) return null;
    const proposal = readActiveProposalForChange(repoRoot, changeName, readFile);
    if (!proposal.content) {
      // No proposal carrier: judge the lite scope record when one exists. `missing`
      // (pre-Step-0 phase, or a lite change that chose stepwise) stays exempt.
      const record = readLiteScopeRecord(repoRoot, { changeName, branch: activeBranch });
      if (record.status === "missing" || record.status === "match") return null;
      const recordPath = liteScopeRecordPath(changeName);
      return {
        block: true,
        reason:
          `Gate R1 (General-mode Batch Approval Ledger Prewrite)：分支 \`${activeBranch}\` 對應 change \`${changeName}\` 沒有 proposal/proposal-mini，` +
          `但 lite 範圍紀錄 \`${recordPath}\` 為 \`${record.status}\`：${record.issue}。壞掉的紀錄不會被當成已授權。\n\n` +
          `照模板重寫該行，或刪除檔案回到逐步詢問 (rewrite the line from the template or delete the file to return to stepwise confirmation)。\n` +
          `若你原本把計畫／證據寫在這一份裡，改放同一 change 目錄的 \`plan.md\`（\`lite-scope.md\` 只放那一行）。\n` +
          `模板（一行、欄位順序固定、\`; \` 分隔、清單以 \`,\` 分隔無空白）：\n\`${LITE_RECORD_TEMPLATE}\`\n\n` +
          `OpenSpec artifact writes under \`openspec/changes/${changeName}/\` are allowed for correction.`,
      };
    }

    const issue = evaluateBatchApprovalLedgerForGeneralModePrewrite(proposal.content, {
      changeName,
      branch: activeBranch,
    });
    if (!issue) return null;

    if (issue.startsWith(LEGACY_DISCLOSURE_ISSUE_PREFIX)) {
      return {
        block: true,
        reason:
          `Gate R1 (General-mode Batch Approval Ledger Prewrite)：分支 \`${activeBranch}\` 對應 active change \`${changeName}\`，` +
          `但 \`openspec/changes/${changeName}/\` 的 proposal/proposal-mini 的 \`Batch Approval Ledger\` ${issue}\n\n` +
          `先修正 \`openspec/changes/${changeName}/proposal-mini.md\` 或 \`proposal.md\` 再繼續此次 write。` +
          `OpenSpec artifact writes under \`openspec/changes/${changeName}/\` are allowed for correction.`,
      };
    }

    return {
      block: true,
      reason:
        `Gate R1 (General-mode Batch Approval Ledger Prewrite)：分支 \`${activeBranch}\` 對應 active change \`${changeName}\`，` +
        `但 \`openspec/changes/${changeName}/\` 的 proposal/proposal-mini 的 \`Batch Approval Ledger\` ${issue}。\n\n` +
        `第零步結論須落 ledger：選 stepwise 記 \`N/A: no batch approval selected\`；選 batch approval 則補齊結構化 ledger` +
        `（\`kind\`/\`named_change\`/\`branch\`/\`repo_scope\`/\`covers\`/\`excludes\`）。` +
        `合法 \`kind\` 僅 \`same-change-dp-change-batch\`；更窄的自訂範圍請用 \`excludes\` 表達，不要自訂 \`kind\` 值。` +
        `先修正 \`openspec/changes/${changeName}/proposal-mini.md\` 或 \`proposal.md\` 再繼續此次 write。` +
        `OpenSpec artifact writes under \`openspec/changes/${changeName}/\` are allowed for correction.`,
    };
  } catch {
    // fail-open: this gate blocks only when repo state and evidence are definite.
    return null;
  }
}

// Gate CR — Design Cold Read Prewrite. A change with a proposal and design.md
// needs its cold-read record before the first implementation write.
//
// The full shape is read from the change folder, not from the hook level: full
// named inside a session never reaches DEVPRO_AGENT_RULES_LEVEL, and lite writes
// no proposal, so the shape already excludes it.
//
// The status is read only from the record's physical first line, so the
// reader's text below it cannot release the gate. A releasing status counts
// only with the user's answer quoted on one `user-answer:` line, so a status
// written before the user answered does not release it, and with one `change:`
// line naming the branch's change, so a record copied from another change
// does not release it either.

function checkDesignColdReadPrewrite({
  toolName,
  filePath,
  branch,
  baseCwd,
  readFile = defaultReadFileSafe,
}) {
  try {
    if (!filePath || !isFileWriteToolName(toolName)) return null;
    const activeBranch = branch || branchForPath(filePath, baseCwd);
    const changeName = activeChangeNameFromBranch(activeBranch);
    if (!changeName) return null;

    const rel = normalizedRepoRelativePathWithCwdFallback(filePath, baseCwd);
    if (!rel) return null;
    if (isActiveOpenSpecChangeWrite(filePath, baseCwd, changeName)) return null;
    if (rel.startsWith("notes/")) return null;

    const repoRoot = gitRootForPath(filePath, baseCwd) || gitRootForCwd(baseCwd);
    if (!repoRoot) return null;
    const changeDir = path.join(repoRoot, "openspec", "changes", changeName);
    if (!existsSync(path.join(changeDir, "design.md"))) return null;
    if (!readActiveProposalForChange(repoRoot, changeName, readFile).content) return null;

    const content = readFile(path.join(changeDir, DESIGN_COLD_READ_RECORD));
    if (isDesignColdReadRecordReleased({ content, changeName })) {
      return null;
    }

    const firstLine = firstLineOf(content);
    const recordPath = `openspec/changes/${changeName}/${DESIGN_COLD_READ_RECORD}`;
    const confirmCommand = `node .devpro/scripts/confirm-design-cold-read.mjs ${changeName} --user-answer "<使用者原話>"`;
    const foreign = designColdReadChangeNames(content).find((name) => name !== changeName);
    if (isDesignColdReadReleasingStatus(firstLine) && foreign !== undefined) {
      return {
        block: true,
        reason:
          `Gate CR (Design Cold Read Prewrite)：\`${recordPath}\` 的 \`change:\` 寫的是 \`${foreign || "空白"}\`，不是本 change \`${changeName}\`，` +
          `可能是從別的 change 複製來的紀錄，還不能開始實作寫入。\n\n` +
          `讀者原文屬於那個 change，不要直接重跑確認指令：把第一行改回 \`status: pending\`，照 \`/devpro:change\` 的 Design Cold Read 段為本 change 重做冷讀，` +
          `再停下交使用者確認（batch approval 不涵蓋）。\n\n` +
          `OpenSpec artifact writes under \`openspec/changes/${changeName}/\` are allowed.`,
      };
    }
    if (isDesignColdReadReleasingStatus(firstLine)) {
      const unverified = designColdReadStatusOf(firstLine) === DESIGN_COLD_READ_UNVERIFIED_LINE;
      return {
        block: true,
        reason:
          `Gate CR (Design Cold Read Prewrite)：\`${recordPath}\` 第一行是放行狀態，但沒有恰好一行非空的 \`user-answer:\` 引用使用者的回答、沒有寫明本 change 的 \`change:\` 行，或仍是舊版帶 \`proof=\` 的簽章格式，還不能開始實作寫入。\n\n` +
          `先在對話問使用者確認（說明紀錄內容，改過就說改了什麼），使用者回答後由 AI 跑 ` +
          `\`${confirmCommand}${unverified ? " --unverified" : ""}\`，把使用者原話原樣帶入；使用者還沒回答時不得跑。\n` +
          `紀錄已有讀者原文與對照時不用重做冷讀；沒有就把第一行改回 \`status: pending\`，照 \`/devpro:change\` 的 Design Cold Read 段重做。\n\n` +
          `OpenSpec artifact writes under \`openspec/changes/${changeName}/\` are allowed.`,
      };
    }

    const finding = firstLine ? `第一行是 \`${firstLine}\`` : "不存在，或第一行是空的";
    return {
      block: true,
      reason:
        `Gate CR (Design Cold Read Prewrite)：分支 \`${activeBranch}\` 對應 change \`${changeName}\` 有 design.md，` +
        `但 \`${recordPath}\` ${finding}，還不能開始實作寫入。\n\n` +
        `依 \`design-reasoning.md\` §Design Cold Read and Implementation Handoff 與 \`/devpro:change\` 的 Design Cold Read 段做：` +
        `派 fresh 讀者冷讀，寫進這個檔（第一行 \`status: pending\`），逐欄對照使用者確認過的白話卡，` +
        `再停下交使用者確認（batch approval 不涵蓋）。使用者在對話回答後由 AI 跑 \`${confirmCommand}\`，把使用者原話原樣帶入；使用者還沒回答時不得跑。\n` +
        `沒有讀者可用或本規則上線前已開工時標「冷讀未驗證」，由使用者決定是否繼續；使用者接受後 AI 跑同一行並加 \`--unverified\`。\n\n` +
        `OpenSpec artifact writes under \`openspec/changes/${changeName}/\` are allowed.`,
    };
  } catch {
    // fail-open: this gate blocks only when repo state and evidence are definite.
    return null;
  }
}

const WRITE_BLOCKING_GATES = defineGateInventory([
  {
    id: "repo-scope-file-write",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "structured-payload-file-path",
    risk: "cross-repo-write",
    runner: ({ toolName, filePath, baseCwd }) =>
      checkRepoScopeFileWrite({ toolName, filePath, baseCwd }),
  },
  {
    id: "file-tool-body-carrier-target",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "structured-payload-file-path",
    risk: "worktree-target-corruption",
    runner: ({ toolName, filePath, baseCwd }) =>
      checkBodyCarrierTarget({ toolName, filePath, baseCwd }),
  },
  {
    id: "version-bump-non-bump-branch",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "structured-payload-file-content",
    risk: "release-version-integrity",
    runner: ({ toolName, filePath, payloadText, toolInput, branch, baseCwd }) =>
      checkVersionBumpInNonBumpBranch({
        toolName,
        filePath,
        payloadText,
        toolInput,
        branch,
        baseCwd,
      }),
  },
  {
    id: "openspec-change-folder-alignment",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "structured-payload-file-path",
    risk: "workflow-state-corruption",
    runner: ({ toolName, filePath, baseCwd }) =>
      checkChangeFolderAlignment({ toolName, filePath, baseCwd }),
  },
  {
    id: "openspec-doc-pii",
    bucket: GATE_BUCKETS.HARD,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "structured-payload-content-scan",
    risk: "privacy-compliance",
    runner: ({ toolName, filePath, toolInput, baseCwd }) =>
      checkOpenSpecDocPII({ toolName, filePath, toolInput, baseCwd }),
  },
  {
    id: "clarification-meeting-notes-contract",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "structured-payload-file-content",
    risk: "workflow-state-corruption",
    runner: ({ toolName, filePath, toolInput, baseCwd }) =>
      checkClarificationMeetingNotesContract({
        toolName,
        filePath,
        toolInput,
        baseCwd,
      }),
  },
  {
    id: "seams-expansion-on-proposal-write",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "repo-state",
    risk: "workflow-state-corruption",
    runner: ({ toolName, filePath, baseCwd }) =>
      checkSeamsExpansionOnProposalWrite({ toolName, filePath, baseCwd }),
  },
  {
    id: "session-pending-batch-ledger-prewrite",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "repo-state",
    risk: "workflow-state-corruption",
    runner: ({ toolName, filePath, branch, baseCwd }) =>
      checkSessionPendingBatchApprovalLedgerPrewrite({ toolName, filePath, branch, baseCwd }),
  },
  {
    id: "general-batch-approval-ledger-prewrite",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "repo-state",
    risk: "workflow-state-corruption",
    runner: ({ toolName, filePath, branch, baseCwd }) =>
      checkGeneralModeBatchApprovalLedgerPrewrite({ toolName, filePath, branch, baseCwd }),
  },
  {
    id: "design-cold-read-prewrite",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "repo-state",
    risk: "workflow-state-corruption",
    runner: ({ toolName, filePath, branch, baseCwd }) =>
      checkDesignColdReadPrewrite({ toolName, filePath, branch, baseCwd }),
  },
  {
    id: "protected-branch-file-write",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "structured-payload-file-path",
    risk: "protected-branch-write",
    runner: ({ toolName, filePath, baseCwd }) =>
      checkFileWrite({ toolName, filePath, baseCwd }),
  },
  {
    // Gate NS — Session-Pending Column-0 Bullet Shape. Blocks only what the
    // payload introduces, so the migration that removes existing violations is
    // never blocked by the violations it is removing. Ordered before Gate N so
    // a shape block short-circuits ahead of the disposition advisory; the two
    // are independent and neither reads the other's verdict.
    id: "session-pending-shape",
    bucket: GATE_BUCKETS.STATE_BACKED,
    decision: GATE_DECISIONS.BLOCK,
    evidence: "structured-payload-content-scan",
    risk: "pending-item-invisibility",
    runner: ({ toolName, filePath, toolInput, baseCwd }) =>
      checkSessionPendingShape({ toolName, filePath, toolInput, baseCwd }),
  },
  {
    // Gate N — Notes Disposition Advisory. Advisory only (non-blocking). Placed
    // last so all hard/state-backed blocking gates run first and short-circuit
    // before reaching this advisory.
    id: "notes-disposition-advisory",
    bucket: GATE_BUCKETS.ADVISORY,
    decision: GATE_DECISIONS.ADVISORY,
    evidence: "structured-payload-content-scan",
    risk: "disposition-hygiene",
    runner: ({ toolName, filePath, toolInput, baseCwd }) =>
      checkNotesDisposition({ toolName, filePath, toolInput, baseCwd }),
  },
]);

const RETIRED_PRE_TOOL_GATES = Object.freeze([
  Object.freeze({
    id: "legacy-transcript-merge-evidence",
    bucket: GATE_BUCKETS.MOVED,
    owner: "cross-model-sticky-merge-review",
    reason: "PR merge review is enforced by parseable PR sticky state.",
  }),
  Object.freeze({
    id: "cleanup-command-parser",
    bucket: GATE_BUCKETS.MOVED,
    owner: "prune-merged-local.mjs + prune-rules-lane.mjs",
    reason: "Cleanup policy needs production/subsumed/rules-lane state, not shell text inference.",
  }),
  Object.freeze({
    id: "legacy-sync-chore-regex",
    bucket: GATE_BUCKETS.DELETE,
    owner: "rules-flow.md",
    reason: "Retired branch naming is normative workflow guidance.",
  }),
]);

const ACTIVE_GATE_INVENTORY = Object.freeze([
  ...BASH_BLOCKING_GATES,
  ...BASH_STATE_UPDATE_GATES,
  ...BASH_ADVISORY_GATES,
  ...WRITE_BLOCKING_GATES,
]);

// Dispatcher：依序執行 hard/state-backed gates（block 短路）+ marker 更新 + advisory 兜底
function checkBashCommand({ command, branch, baseCwd, effectiveCwd, toolInput, payload }) {
  const cmd = command.toString();
  const ctx = {
    cmd,
    branch,
    baseCwd,
    effectiveCwd,
    toolInput,
    payload,
    protectedBranchResult: checkProtectedBranch(cmd, baseCwd, { toolInput, payload }),
  };
  const blockResult = runGateInventory(BASH_BLOCKING_GATES, ctx);
  if (blockResult) return blockResult;
  runStateUpdateInventory(BASH_STATE_UPDATE_GATES, ctx);
  return runGateInventory(BASH_ADVISORY_GATES, ctx);
}

function recordRuleLoadLedgerState(cmd, baseCwd, effectiveCwd = baseCwd, payload = {}) {
  let repoRoot;
  try {
    // fix-eof-gate-cwd-blind-spot F1 fix (round-1 dp-reviewer): mirror
    // checkDuplicateRuleLoadLedger's ordering — extraction MUST run before
    // any `!repoRoot` short-circuit, because normalizeRuleLeafRef has a
    // repoRoot-independent shortcut for canonical `.devpro/agent-rules/`-
    // prefixed refs (rule-load-session-ledger.mjs's normalizeRuleLeafRef).
    // An early `!repoRoot` return here would silently drop those refs from
    // duplicate recording even though extraction can resolve them fine —
    // reintroducing exactly the class of skip design.md D7 says this change
    // must not add.
    repoRoot = gitRootForCwd(effectiveCwd || baseCwd);
    const refs = extractRuleLeafReadsFromBash(cmd, repoRoot);
    if (refs.length === 0) {
      appendRuleLoadHostDiagnostic(payload, {
        repoRoot,
        source: "recorder",
        refs,
        skippedReason: repoRoot ? RECORDER_SKIP_REASONS.NO_RULE_REFS : RECORDER_SKIP_REASONS.REPO_ROOT_UNRESOLVED,
      });
      return;
    }
    const sessionIdentity = sessionRuleLoadIdentity(payload);
    if (!sessionIdentity) {
      appendRuleLoadHostDiagnostic(payload, {
        repoRoot,
        source: "recorder",
        refs,
        skippedReason: RECORDER_SKIP_REASONS.MISSING_SESSION_IDENTITY,
      });
      return;
    }
    const result = recordSessionRuleLoads(refs, { repoRoot, sessionIdentity, payload });
    appendRuleLoadHostDiagnostic(payload, {
      repoRoot,
      source: "recorder",
      refs,
      recordCount: result.records.length,
      duplicateCount: result.duplicates.length,
      skippedReason: RECORDER_SKIP_REASONS.RECORDED,
    });
  } catch {
    // fix-eof-gate-cwd-blind-spot T12 (design.md D7): fail-open — telemetry
    // must never affect tool execution — but the SKIP itself must now leave
    // a trace via the EXISTING appendRuleLoadHostDiagnostic channel (not a
    // new user-facing advisory channel), so a lost recorder write is at
    // least visible in the JSONL for later audit. The repo-root-unresolved
    // case is folded into the `refs.length === 0` branch above (F1 fix:
    // extraction always runs first), so reaching this catch means something
    // else genuinely threw (e.g. gitRootForCwd, extraction, or the record
    // call itself).
    try {
      appendRuleLoadHostDiagnostic(payload, {
        repoRoot: repoRoot ?? "",
        source: "recorder",
        refs: [],
        skippedReason: RECORDER_SKIP_REASONS.UNEXPECTED_ERROR,
      });
    } catch {
      // fail-open even for the diagnostic write itself
    }
  }
}

function recordRuleLoadLedgerPayload(payload = {}, baseCwd = process.cwd(), effectiveCwd = baseCwd) {
  let repoRoot;
  try {
    // fix-eof-gate-cwd-blind-spot F1 fix (round-1 dp-reviewer): same
    // ordering fix as recordRuleLoadLedgerState's sibling comment —
    // extraction MUST run before any `!repoRoot` short-circuit so canonical
    // `.devpro/agent-rules/`-prefixed refs (repoRoot-independent in
    // normalizeRuleLeafRef) are still recorded when repoRoot is unresolved.
    repoRoot = ruleLoadRepoRootForPayload(payload, baseCwd, effectiveCwd);
    const refs = extractRuleLeafReadsFromPayload(payload, repoRoot);
    if (refs.length === 0) {
      appendRuleLoadHostDiagnostic(payload, {
        repoRoot,
        source: "recorder",
        refs,
        skippedReason: repoRoot ? RECORDER_SKIP_REASONS.NO_RULE_REFS : RECORDER_SKIP_REASONS.REPO_ROOT_UNRESOLVED,
      });
      return;
    }
    const sessionIdentity = sessionRuleLoadIdentity(payload);
    if (!sessionIdentity) {
      appendRuleLoadHostDiagnostic(payload, {
        repoRoot,
        source: "recorder",
        refs,
        skippedReason: RECORDER_SKIP_REASONS.MISSING_SESSION_IDENTITY,
      });
      return;
    }
    const result = recordSessionRuleLoads(refs, { repoRoot, sessionIdentity, payload });
    appendRuleLoadHostDiagnostic(payload, {
      repoRoot,
      source: "recorder",
      refs,
      recordCount: result.records.length,
      duplicateCount: result.duplicates.length,
      skippedReason: RECORDER_SKIP_REASONS.RECORDED,
    });
  } catch {
    // fix-eof-gate-cwd-blind-spot T12 (design.md D7): 第四輪裁決併入
    // (recordRuleLoadLedgerPayload) — same telemetry-only treatment as its
    // recordRuleLoadLedgerState sibling. repo-root-unresolved is folded into
    // the `refs.length === 0` branch above (F1 fix); reaching this catch
    // means something else threw.
    try {
      appendRuleLoadHostDiagnostic(payload, {
        repoRoot: repoRoot ?? "",
        source: "recorder",
        refs: [],
        skippedReason: RECORDER_SKIP_REASONS.UNEXPECTED_ERROR,
      });
    } catch {
      // fail-open even for the diagnostic write itself
    }
  }
}

// ── File-write checks (Edit / Write / MultiEdit) ──────────────────────────

function isApplyPatchToolName(toolName) {
  return toolName === "functions.apply_patch";
}

function isFileWriteToolName(toolName) {
  return (
    toolName === "Edit" ||
    toolName === "Write" ||
    toolName === "MultiEdit" ||
    isApplyPatchToolName(toolName)
  );
}

function applyPatchTextFor(toolInput = {}, payload = {}) {
  if (typeof toolInput === "string") return toolInput;
  const candidates = [
    toolInput.patch,
    toolInput.patchText,
    toolInput.input,
    toolInput.content,
    toolInput.diff,
    payload.patch,
    payload.patchText,
  ];
  return candidates.map((value) => (typeof value === "string" ? value : "")).find(Boolean) || "";
}

function extractApplyPatchFilePaths(patchText) {
  const paths = [];
  for (const line of String(patchText || "").split(/\r?\n/)) {
    const match =
      line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/) ||
      line.match(/^\*\*\* Move to: (.+)$/);
    if (!match) continue;
    const filePath = match[1].trim();
    if (filePath) paths.push(filePath);
  }
  return paths;
}

function buildApplyPatchUnparseableBlockReason() {
  return "Protected-branch gate：無法解析 `functions.apply_patch` payload 的 target file path，因此 fail-closed。`apply_patch` 必須帶 `*** Add/Update/Delete File:` 或 `*** Move to:` path，且在 Codex 中修改 worktree 時必須使用 target worktree 絕對路徑。";
}

// Allow writes to paths OUTSIDE the repo (e.g. /tmp/*, $TMPDIR/*) even on
// protected branches — those writes don't modify repo content, so the
// "main 直接實作" rule doesn't apply. Only block writes that resolve
// underneath the current repo working tree.
// Also allow writes to gitignored paths (e.g. refs/, notes/, .worktree/, hook state)
// since those directories are local-only and not tracked by git.
function isGitIgnored(filePath, baseCwd = process.cwd()) {
  try {
    execSync("git check-ignore -q -- " + JSON.stringify(filePath), {
      cwd: baseCwd,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true; // exit 0 = ignored
  } catch {
    return false; // exit non-0 = not ignored
  }
}

function normalizedRepoRelativePath(filePath, baseCwd = process.cwd()) {
  if (!filePath) return "";
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(baseCwd, filePath);
  const repoRoot = gitRootForPath(absolute, baseCwd);
  if (!repoRoot) return "";
  const existingParent = existingDirFor(absolute);
  const resolvedParent = resolveSafe(existingParent);
  const remainingPath = path.relative(existingParent, absolute);
  const resolved = remainingPath
    ? path.join(resolvedParent, remainingPath)
    : resolvedParent;
  const root = resolveSafe(repoRoot);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) return "";
  return path.relative(root, resolved).split(path.sep).join("/");
}

function isBodyCarrierPath(filePath, baseCwd = process.cwd()) {
  const rel = normalizedRepoRelativePath(filePath, baseCwd);
  if (!rel) return false;
  // TL-authored body carrier names such as `.pr-body.md` are no longer gated
  // here: TL bodies now write to main-checkout `notes/tmp/`. Repo-root
  // reviewer-sticky carriers (`.cross-model-sticky-*`) are still gated in every
  // checkout; reviewer sticky must instead write its body file at reviewer's
  // own current neutral cwd (outside any checkout), not main-checkout `notes/tmp/`.
  //
  // The carve for residual and TL-authored reviewer-sticky files — main-checkout
  // `<repo-root>/notes/tmp/.cross-model-sticky-*` (gitignored, lifecycle-
  // independent; no reviewer recipe stages there any more, so this is a
  // regression-compatibility surface) — is achieved by this regex's anchoring, NOT by a separate
  // notes/tmp prefix check: `rel` for a notes/tmp file is
  // `notes/tmp/<sticky-name>`, which contains path separators and therefore does
  // not match `^\.cross-model-sticky-[^/]+` → falls through to `return false`
  // (allowed). A `.cross-model-sticky-*` written directly at any checkout repo
  // root (rel has no separator) is recognized as a carrier and blocked.
  if (!/^\.cross-model-sticky-[^/]+(?:\.md)?$/.test(rel)) return false;
  return true;
}

function checkBodyCarrierTarget({ toolName, filePath, baseCwd = process.cwd() }) {
  if (!filePath) return null;
  if (!isBodyCarrierPath(filePath, baseCwd)) return null;

  const branch = branchForPath(filePath, baseCwd) || "unknown";

  return {
    block: true,
    reason:
      `Body Carrier Target gate：禁止 \`${toolName}\` 寫入 reviewer-sticky carrier \`${filePath}\`（解析到 repo checkout branch \`${branch}\`）。\n\n` +
      `reviewer 的 cross-model sticky body（\`.cross-model-sticky-*\`）必須走 **reviewer 自己 current neutral cwd 的 body file**（repo 外、spawn 當下為空的暫存目錄，不綁 worktree 生命週期），禁用任何 worktree-internal repo 路徑——worktree-internal sticky 違反 lifecycle isolation（per code-review-cross-model.md / cross-runtime-parity reviewer self-write-back）。\n\n` +
      `注意：TL-authored body（PR/issue/comment/recap）同樣寫 main-checkout \`<repo-root>/notes/tmp/<purpose>-<unique>.md\`（basename 必須含 purpose 加 session/timestamp/PID/random suffix；per pre-tool-mechanical-gates §GitHub Body File Diagnostics）。`,
  };
}

function checkFileWrite({ toolName, filePath, baseCwd = process.cwd() }) {
  const branch = filePath
    ? branchForPath(filePath, baseCwd)
    : getCurrentBranch(baseCwd);
  if (!isProtectedBranch(branch)) return null;
  if (filePath) {
    // Resolve symlinks via realpath so macOS /tmp -> /private/tmp 與
    // /var/folders -> /private/var/folders 不會造成 prefix mismatch。
    // 對 Write 新檔場景：realpath 父目錄（必存在）再 join basename。
    const absolute = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(baseCwd, filePath);
    const resolved = resolveSafe(absolute);
    const repoRoot = resolveSafe(gitRootForPath(absolute, baseCwd) || baseCwd);
    if (!resolved.startsWith(repoRoot + path.sep) && resolved !== repoRoot) {
      return null; // outside repo — allow
    }
    if (isGitIgnored(absolute, existingDirFor(absolute))) {
      return null; // gitignored path — allow (refs/, notes/, .worktree/, etc.)
    }
  }
  return {
    block: true,
    reason: `Protected-branch gate：在 \`${branch}\` 上禁止 \`${toolName}\`（檔案寫入）到 repo 內路徑。先用 \`git worktree add <repo-root-abs>/.worktree/<name> -b <prefix>/<name> <anchor-sha>\` 建 feature/bugfix/chore/hotfix worktree（AGENTS.md §0 Never：「main 直接實作」）。\n\n此 gate 由 Edit/Write/MultiEdit/functions.apply_patch 觸發，沒有 inline Bash bypass；修法是切到正確 worktree / branch，或把暫存輸出寫到 repo 外。Codex \`apply_patch\` 沒有 workdir surface，修改 worktree 時必須在 patch header 使用 target worktree 絕對路徑。\n\n寫到 repo 外（\`/tmp\`、\`$TMPDIR\` 等）的暫存檔不受此 gate 約束。gitignored 目錄（\`refs/\`、\`notes/\`、\`.worktree/\` 等）同樣不受約束。`,
  };
}

function checkRepoScopeFileWrite({ toolName, filePath, baseCwd = process.cwd() }) {
  if (!filePath) return null;
  const activeCommon = gitCommonDir(baseCwd);
  if (!activeCommon) return null; // workspace cwd with no active repo is valid

  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(baseCwd, filePath);
  const targetCwd = existingDirFor(absolute);
  const targetCommon = gitCommonDir(targetCwd);
  if (!targetCommon || targetCommon === activeCommon) return null;
  if (hasRepoScopeStateApprovalFor(targetCwd, baseCwd)) return null;

  return {
    block: true,
    reason: buildRepoScopeBlockReason(
      "cross-repo file write",
      `${toolName} targets ${repoScopeTargetName(targetCwd, baseCwd)}`
    ),
  };
}

// Gate: AGENTS.md `版本：<X.Y.Z>` line edit on non-bump branch（issue #306）。
// 規範：版號 bump 必須走獨立 `chore/bump-v<X.Y.Z>` PR；feature/bugfix/chore B
// 不混 bump（AGENTS.md §0 Never）。
// 不用 line-anchor `^...` — 用 substring match 覆蓋 Edit / Write / MultiEdit
// 三條路徑且不易誤判（AGENTS.md 內的 `版本：<X.Y.Z>` 字面只用於版號，
// docs 引用通常寫「AGENTS v...」帶 v prefix，不會誤觸）。
//
// **實際格式**：AGENTS.md 第 3 行為 `版本：6.X.Y`（無 v prefix）；branch 名與
// tag 才用 `v` prefix（`chore/bump-v6.X.Y` / `production-v6.X.Y`）。issue #318
// 之前的版本誤含 `v` 導致 Gate 5 永遠不 fire。
// VERSION_LINE_RE removed — `版本：<SemVer>` pattern SSOT now in
// version-helpers.mjs; use extractVersionFromLine() for precise extraction.
// versionLinePresent() is a local presence-only test used as an early guard
// ("does this payload touch a 版本： line at all?"); it is NOT a third regex
// copy — it re-uses SEMVER_CORE from version-helpers so the digit pattern
// has a single authoritative source.
const _VERSION_PRESENCE_RE = new RegExp(`版本：${SEMVER_CORE}`);
function versionLinePresent(text) {
  return !!(text && _VERSION_PRESENCE_RE.test(text));
}

function isBumpBranch(branch) {
  return /^chore\/bump-v/.test(branch || "");
}

function isAgentsMdPath(filePath, baseCwd) {
  if (!filePath) return false;
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(baseCwd, filePath);
  const resolved = resolveSafe(absolute);
  const repoRoot = resolveSafe(gitRootForPath(absolute, baseCwd) || baseCwd);
  return resolved === path.join(repoRoot, "AGENTS.md");
}

function payloadTextFor(toolName, toolInput) {
  if (toolName === "Edit") {
    return [toolInput.old_string || "", toolInput.new_string || ""].join("\n");
  }
  if (toolName === "Write") {
    return toolInput.content || "";
  }
  if (toolName === "MultiEdit") {
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
    return edits
      .map((e) => `${e.old_string || ""}\n${e.new_string || ""}`)
      .join("\n");
  }
  return "";
}

// Extract the NEW (post-edit) version string from the payload.
// For Edit: only look at new_string; for Write/MultiEdit: full content.
// Returns the SemVer string (e.g. "6.63.0") or null.
function newVersionFromPayload(toolName, toolInput) {
  if (toolName === "Edit") {
    return extractVersionFromLine(toolInput.new_string || "");
  }
  if (toolName === "Write") {
    return extractVersionFromLine(toolInput.content || "");
  }
  if (toolName === "MultiEdit") {
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
    // Collect all new_strings; find the one touching a version line.
    const newTexts = edits.map((e) => e.new_string || "").join("\n");
    return extractVersionFromLine(newTexts);
  }
  return null;
}

function buildVersionBumpBlockReason(toolName, branch) {
  return `Version bump gate：偵測 \`${toolName}\` 對 AGENTS.md 修改觸及 \`版本：<X.Y.Z>\` line，當前 branch \`${branch || "(none)"}\` 不是 \`chore/bump-v*\`。版號 bump 必須走獨立 PR（AGENTS.md §0 Never：「feature/bugfix PR 混版號 bump」）。\n\n此 gate 由 Edit/Write/MultiEdit 觸發，沒有 inline Bash bypass；修法是先建立 \`chore/bump-v<X.Y.Z>\` 分支再改版號，或把版號變更從本次編輯中移除。`;
}

function buildVersionMismatchBlockReason(toolName, branchVersion, fileVersion) {
  return `Version bump gate：偵測 \`${toolName}\` 對 AGENTS.md 修改，分支版號 \`${branchVersion}\` != 編輯後 \`版本：${fileVersion}\`（不符）。分支名與 AGENTS.md 版號必須一致（per release-sit-uat-pat-prod.md §rule）。\n\n修法：把 AGENTS.md 版號改為 \`版本：${branchVersion}\`（與分支名一致），或建立正確版號的 \`chore/bump-v${fileVersion}\` 分支。`;
}

function checkVersionBumpInNonBumpBranch({
  toolName,
  filePath,
  payloadText,
  toolInput,
  branch,
  baseCwd,
}) {
  if (!filePath) return null;
  if (!isAgentsMdPath(filePath, baseCwd)) return null;

  if (isBumpBranch(branch)) {
    // Bump branch path: check equality between branch version and edited version.
    // Only fire if the payload actually touches a `版本：` line.
    if (!versionLinePresent(payloadText)) return null;
    // Extract the new version being written (from new_string / content only, not old).
    const fileVersion = newVersionFromPayload(toolName, toolInput || {});
    const branchVersion = extractVersionFromBranch(branch);
    // Fail-safe: if either is null (e.g. multi-match / ambiguous), pass (do not block).
    if (fileVersion === null || branchVersion === null) return null;
    if (fileVersion === branchVersion) return null; // Equal → pass
    return {
      block: true,
      reason: buildVersionMismatchBlockReason(toolName, branchVersion, fileVersion),
    };
  }

  // Non-bump branch: block any edit touching the `版本：` line.
  if (!versionLinePresent(payloadText)) return null;
  return { block: true, reason: buildVersionBumpBlockReason(toolName, branch) };
}

// ── Test exports (named exports for unit tests; not used in production path) ──
export {
  commandCwd,
  commandCwdAt,
  checkPostPrLineageApprovalCommentWriteGuard,
  toolInputBindingCwd,
  toolInputCwd,
  checkUpstreamPollution,
  // Protected-branch cwd evidence snapshot (design D2/D3) — renderer + fail-open wrapper
  buildProtectedCwdEvidence,
  protectedCwdEvidenceLine,
  // Gate D / D' exports for post-tool-gate.mjs and tests
  writePendingCdSentinel,
  scanPendingCdSentinels,
  clearPendingCdSentinel,
  extractWorktreeAddPath,
  looksAbsoluteAfterExpansion,
  checkWorktreeAbsolutePath,
  checkPendingWorktreeCd,
  SENTINEL_DIR,
  SENTINEL_TTL_MS,
  // Gate 2h exports for tests
  RELEASE_RULES_CHECKOUT_RE,
  RELEASE_RULES_SWITCH_RE,
  RELEASE_RULES_WORKTREE_RE,
  buildReleaseRulesBaseBlockReason,
  buildReleaseRulesSourceRepoBlockReason,
  checkReleaseRulesBaseFromProductionTag,
  hasProductionTagAt,
  hasAnyProductionTag,
  isAllowedFirstRulesReleaseBase,
  isReleaseRulesBaseAllowed,
  resolveFirstRulesReleaseProductionTip,
  isSourceRepo,
  // Glob helper (shared; used by the code-carrier evidence gate)
  globToRegex,
  // Cross-model branch exemption helpers
  isSourceRepoReleaseBranchExempt,
  isConsumerSubsetReleaseBranchExempt,
  isRulesLaneReleaseBranchExempt,
  isChoreAClassExempt,
  isChoreAProposalEvidence,
  isCrossModelExempt,
  crossModelExemptionReason,
  checkCrossModelExemptionNotice,
  checkMergeAdvisories,
  checkLocalTestGateOnMerge,
  checkLocalTestEvidence,
  checkLocalMergeObligations,
  checkPerPrWaiverOnMerge,
  checkPerPrWaiverOnEdit,
  _resolvePrMergeTarget,
  extractGhPrBodyArgument,
  isBaseProductionBlockExempt,
  buildBaseProductionBlockReason,
  checkProductionBasePrCreate,
  checkLocalReviewPrCreate,
  extractGhPrCreateBaseValue,
  extractGhPrCreateHeadValue,
  // Cross-model merge gate (T5)
  STICKY_MAGIC_MARKER,
  VERDICT_VALID_VALUES,
  GH_PR_MERGE_WITH_NUMBER_RE,
  GH_PR_MERGE_VALUE_TAKING_FLAGS,
  GH_PR_CHECKS_VALUE_TAKING_FLAGS,
  validatePrNumber,
  _runGhPrView,
  _getCrossModelBranch,
  _getPrChangedFiles,
  _getPrChangedFileEntries,
  _refetchPrCommentsViaRest,
  _withPrChangedFilesMemo,
  _resolveGithubOwnerRepo,
  _extractStickyCommentBody,
  _parseStickyVerdict,
  _parseStickyLastReviewedSha,
  _extractPrNumber,
  _extractRepoFlag,
  checkCrossModelMergeGate,
  // Gate P exports for tests (issue #706 — OpenSpec doc PII pre-write block)
  OPENSPEC_DOC_PATH_RE,
  PII_EMAIL_RE,
  PII_EMAIL_ALLOW_RE,
  PII_UNIX_USERS_RE,
  PII_UNIX_HOME_RE,
  PII_WINDOWS_USERS_RE,
  findPIIHits,
  simulatePostWriteContent,
  checkOpenSpecDocPII,
  GATE_BUCKETS,
  GATE_DECISIONS,
  validateGateInventory,
  ACTIVE_GATE_INVENTORY,
  BASH_BLOCKING_GATES,
  checkCrossRepoPrWrite,
  checkCrossRepoPrMerge,
  _mergeEvidenceCwd,
  _mergeEvidenceBinding,
  RETIRED_PRE_TOOL_GATES,
  // Production tag gate (N1 + V2 + V4) — named test exports
  checkProductionTagGate,
  checkTagOrdinalReleaseBranchMatch,
  listLocalReleaseBranches,
  extractTagNameFromTail,
  // Gate NS exports for tests (session-pending column-0 bullet shape)
  checkSessionPendingShape,
  // Gate N exports for tests (notes disposition advisory)
  isSessionPendingPath,
  parseListItemBlocks,
  missingDispositionFields,
  scanDispositionInText,
  checkNotesDisposition,
  DISPOSITION_FIELDS,
  // In-process dispatch seam for tests (perf refactor)
  evaluatePreToolUsePayload,
  PASS_THROUGH,
  // W3 Body Carrier gate exports for tests
  isBodyCarrierPath,
  checkBodyCarrierTarget,
  // input normalization fix exports for tests
  UNRESOLVABLE_CWD,
  writePostmergeMarker,
  isPushDryRun,
  // Gate 3 (T3) exports for tests — Commit-Time EOF Normalize Re-stage Gate
  checkCommitEofRestage,
  checkCommitAdvisories,
  checkCommitAttribution,
  // fix-eof-gate-cwd-blind-spot T12 exports for tests — rule-load ledger
  // 4 call points (the recorder functions' repo-root-unresolved catch
  // branch is structurally unreachable via the full hook flow, since the
  // sibling check function always preempts it on the same root cause — see
  // rule-load-session-ledger-hook.test.mjs T12 tests for why these are
  // exercised via direct import rather than spawnHook).
  checkDuplicateRuleLoadLedger,
  checkDuplicateRuleLoadLedgerPayload,
  recordRuleLoadLedgerState,
  recordRuleLoadLedgerPayload,
};

// ── Main ───────────────────────────────────────────────────────────────────

// Sentinel: payload tool is one this hook ignores (non-Bash/Edit/Write, or a
// Bash command that is empty or carries an inline bypass). main() treats this
// identically to "no gate result" (exit 0 silently); tests can distinguish it
// from an actual null gate result if they need to.
const PASS_THROUGH = Symbol("pre-tool-gate-pass-through");

// Pure dispatch core extracted from main() (per cross-model review: gives the
// test suite a clean in-process seam instead of spawning the whole hook). Takes
// a parsed PreToolUse payload, runs the same Bash / write-tool gate routing
// main() does, and returns the RAW gate result:
//   null          → ran a gate, nothing to report (pass)
//   {block,...}    → a gate blocked
//   {advisory,...} → a gate emitted an advisory
//   PASS_THROUGH   → tool not handled (would exit 0 without running any gate)
// It performs NO stdin read, NO process.exit, NO stdout emit — main() owns the
// process contract. Behavior is unchanged from the previous inline dispatch.
function evaluatePreToolUsePayloadBody(payload, options = {}) {
  const envelope = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const toolName = envelope.tool_name || envelope.toolName || "";
  const hasSnakeInput = Object.prototype.hasOwnProperty.call(envelope, "tool_input");
  const hasCamelInput = Object.prototype.hasOwnProperty.call(envelope, "toolInput");
  const rawToolInput = hasSnakeInput ? envelope.tool_input : envelope.toolInput;
  if (REGISTERED_AGENT_TOOLS.has(toolName)
    && (hasSnakeInput === hasCamelInput
      || rawToolInput === null
      || typeof rawToolInput !== "object"
      || Array.isArray(rawToolInput))) {
    return spawnContextBlock("registered agent payload requires exactly one plain-object tool_input shape");
  }
  const toolInput = rawToolInput && typeof rawToolInput === "object" && !Array.isArray(rawToolInput) ? rawToolInput : {};
  const baseCwd = toolInputCwd(toolInput, envelope);
  const host = Object.prototype.hasOwnProperty.call(options, "host")
    ? options.host
    : (process.env.DEVPRO_HOOK_HOST || "");
  // Admission／binding cwd MUST omit working_directory／workingDirectory
  // (execution-only; design D2 / adapter §5b). Shell／branch gates keep baseCwd.
  const agentResult = evaluateAgentDispatch(toolName, toolInput, {
    host,
    cwd: toolInputBindingCwd(toolInput, envelope),
    stateDir: options.spawnContextStateDir,
    nowMs: options.nowMs,
  });
  if (agentResult !== SPAWN_CONTEXT_PASS_THROUGH) return agentResult;
  const branchByCwd = new Map();
  const currentBranchFor = (cwd) => {
    if (branchByCwd.has(cwd)) return branchByCwd.get(cwd);
    const branch = getCurrentBranch(cwd);
    branchByCwd.set(cwd, branch);
    return branch;
  };
  const branch = currentBranchFor(baseCwd);

  if (isShellCommandToolName(toolName)) {
    const cmd = toolInput.command || toolInput.cmd || "";
    if (!cmd) return PASS_THROUGH;
    if (hasInlineHookBypass(cmd)) {
      if (CROSS_MODEL_GH_PR_MERGE_RE.test(gateCommandSegmentText(cmd))) {
        appendFrictionLog(
          "Cross-Model Merge Gate bypass: DEVPRO_HOOK_BYPASS=1 on gh pr merge"
        );
      }
      return PASS_THROUGH;
    }
    const effectiveCwdRaw = commandCwd(cmd, baseCwd);
    // When the cwd is UNRESOLVABLE (ambiguous prefix hiding a `cd`), keep a REAL
    // directory for cwd-consumers (→ baseCwd) but pass the sentinel as the
    // `branch` so branch-PARAMETER gates fail closed instead of trusting the
    // wrong (baseCwd) branch (issue #851/#848 round 9).
    const cwdUnresolvable = effectiveCwdRaw === UNRESOLVABLE_CWD;
    const effectiveCwd = cwdUnresolvable ? baseCwd : effectiveCwdRaw;
    return checkBashCommand({
      command: cmd,
      branch: cwdUnresolvable ? UNRESOLVABLE_CWD : currentBranchFor(effectiveCwd),
      baseCwd,
      effectiveCwd,
      toolInput,
      payload: envelope,
    });
  } else if (isReadToolName(toolName)) {
    const duplicate = checkDuplicateRuleLoadLedgerPayload(envelope, baseCwd, baseCwd);
    if (duplicate) return duplicate;
    recordRuleLoadLedgerPayload(envelope, baseCwd, baseCwd);
    return PASS_THROUGH;
  } else if (isFileWriteToolName(toolName)) {
    if (isApplyPatchToolName(toolName)) {
      const patchText = applyPatchTextFor(toolInput, envelope);
      const filePaths = extractApplyPatchFilePaths(patchText);
      if (filePaths.length === 0) {
        return { block: true, reason: buildApplyPatchUnparseableBlockReason() };
      }
      for (const filePath of filePaths) {
        const result = runGateInventory(WRITE_BLOCKING_GATES, {
          toolName,
          filePath,
          payloadText: patchText,
          branch: branchForPath(filePath, baseCwd),
          baseCwd,
          toolInput,
        });
        if (result) return result;
      }
      return null;
    }
    const filePath =
      toolInput.file_path ||
      toolInput.filePath ||
      "";
    const payloadText = payloadTextFor(toolName, toolInput);
    return runGateInventory(WRITE_BLOCKING_GATES, {
      toolName,
      filePath,
      payloadText,
      branch: filePath ? branchForPath(filePath, baseCwd) : branch,
      baseCwd,
      toolInput,
    });
  }
  return PASS_THROUGH;
}

// One evaluation is one hook run: gates that ask the same PR question share a
// successful answer for exactly that long (see _withPrChangedFilesMemo).
function evaluatePreToolUsePayload(payload, options = {}) {
  resetDestinationIdentityCache();
  _mergeDestinationMemo = null;
  return _withPrChangedFilesMemo(() => evaluatePreToolUsePayloadBody(payload, options));
}

let lastHookPayload;
async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    process.exit(0);
  }

  lastHookPayload = payload;
  const result = evaluatePreToolUsePayload(payload);

  if (!result || result === PASS_THROUGH) process.exit(0);
  if (result.block) emitBlock(result.reason);
  if (result.advisory) emitContext(result.advisory);
  process.exit(0);
}

// Guard: only invoke main() when this file is the direct entry point (not when
// imported as a module by tests). In ESM, `import.meta.url` matches the
// resolved `process.argv[1]` URL when run directly.
// Use pathToFileURL so a space-containing argv path still compares equal
// to import.meta.url (Windows drive letters and POSIX paths both normalize).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`pre-tool-gate hook error: ${err.message}\n`);
    if (isGithubWritePayload(lastHookPayload)) { process.stdout.write(JSON.stringify(githubHookDeny("GitHub gate failed; repair it before retrying."))); }
    process.exit(0);
  });
}
