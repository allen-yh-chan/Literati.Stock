/** Shared review judgement. Adapters supply observations, never pass/fail assertions. */
import { SECOND_REVIEW_STICKY_MARKER, parseSecondReviewStickyAuthorityBody, selectExactSecondReviewStickyAuthority } from "./second-review-sticky-authority.mjs";
import { CROSS_MODEL_WAIVER_MARKER, evaluateCrossModelWaiverPathW, stickyAllowsCrossModelWaiverPathW } from "./second-review-waiver-authority.mjs";
import { evaluateFreshEquivalentEvidence } from "./fresh-equivalent-compare.mjs";
import { HOOK_BYPASS_HINT } from "./hook-bypass.mjs";

const STICKY_MAGIC_MARKER = SECOND_REVIEW_STICKY_MARKER;
const _isValidSha = (value) => /^[0-9a-f]{40}$/i.test(value);

// Issue #3574: a reviewer CLI that is authenticated but out of quota used to
// leave the TL reading the generic bypass hint as the way out. Name the
// sanctioned ladder instead, and say plainly that the bypass env prefix is not
// one of those routes.
const QUOTA_FALLBACK_HINT =
  "Reviewer CLI 無額度（`quota-unavailable`）不是本 gate 的解除條件：依 `code-review-cross-model.md` §失效 Fallback，先讓同家族 fallback 經正常 dispatch 產出 sticky（Path F），或由 host／wrapper 寫 `UNAVAILABLE` sticky 後走 Path U（fresh review／人類 reviewer 結論／合規 Path W waiver）。`DEVPRO_HOOK_BYPASS=1` 不是 sanctioned 解除路徑，只在使用者明示授權且該 PR 揭露未滿足 gate 與替代證據時作例外。";

export function evaluateSecondReviewEvidence({ prNumber, prData, compare, commentsRefetchedEmpty = false } = {}) {
  if (!prData || typeof prData !== "object") return { block: true, reason: "GitHub PR evidence is missing." };
  const prHeadRefName = typeof prData.headRefName === "string" ? prData.headRefName.trim() : "";
  const audits = [];
  const allComments = Array.isArray(prData.comments) ? prData.comments : [];
  const rawHeadForWaiver = typeof prData.headRefOid === "string" ? prData.headRefOid.trim() : "";

  // Path W is evaluated only for missing-sticky / UNAVAILABLE exits (never
  // before Path E). Ambiguous multi-waiver still fail-closed when Path W applies.
  const waiverPathW = evaluateCrossModelWaiverPathW(allComments, rawHeadForWaiver);

  const stickyAuthority = selectExactSecondReviewStickyAuthority(allComments);

  // Edge case: multiple sticky comments → fail-closed (per test case 11)
  // Path W MUST NOT override multi-sticky ambiguity.
  if (stickyAuthority.status === "ambiguous") {
    return {
      block: true,
      reason: `Cross-Model Merge Gate：PR #${prNumber} 上偵測到 ${stickyAuthority.candidate_count} 條含 magic marker \`${STICKY_MAGIC_MARKER}\` 的 sticky comment（預期最多 1 條）。\n\nfail-closed：請手動檢查 PR comments，移除重複 sticky comment 後再試。若確認為誤判，${HOOK_BYPASS_HINT}`,
    };
  }

  function tryPathWPass(stickyVerdict = "") {
    if (!stickyAllowsCrossModelWaiverPathW({
      status: stickyAuthority.status,
      stickyVerdict,
    })) {
      return null;
    }
    if (waiverPathW.status === "ambiguous") {
      return {
        block: true,
        reason: `Cross-Model Merge Gate (Path W)：PR #${prNumber} 上偵測到 ${waiverPathW.candidate_count} 條含 magic marker \`${CROSS_MODEL_WAIVER_MARKER}\` 的 waiver comment（預期最多 1 條）。\n\nfail-closed：請手動檢查 PR comments，移除重複 waiver 後再試。若確認為誤判，${HOOK_BYPASS_HINT}`,
      };
    }
    if (waiverPathW.status === "pass") {
      const audit = waiverPathW.audit || {};
      audits.push(
        `cross-model-path-w-pass pr=#${prNumber} comment_id=${audit.comment_id ?? ""} author=${audit.author_login || ""} association=${audit.author_association || ""} granted_by=${audit.granted_by || ""}`
      );
      return { pass: true };
    }
    return null;
  }

  function staleReadHint() {
    return commentsRefetchedEmpty
      ? "\n\n本關已用 REST 重讀一次 PR comments，仍未找到 waiver／sticky：若剛貼上 waiver／sticky，GitHub 可能還沒回傳；請稍候再試一次 merge，不要重貼同一份 comment（重貼會變成 multi-waiver ambiguous）。"
      : "";
  }

  function waiverFailHint() {
    if (waiverPathW.status === "stale") {
      return `\n\n偵測到 stale waiver（\`waived_head_sha: ${waiverPathW.waived_head_sha}\` ≠ headRefOid \`${rawHeadForWaiver}\`）——head 移動後須在對話重新問使用者是否豁免，再更新 waiver 的 \`waived_head_sha\`。`;
    }
    if (waiverPathW.status === "invalid") {
      return `\n\n偵測到 malformed waiver marker（\`${CROSS_MODEL_WAIVER_MARKER}\`）但 schema 不合規——不得當 Path W 放行。`;
    }
    if (waiverPathW.status === "unauthorized") {
      return `\n\n偵測到 unauthorized waiver（${waiverPathW.reason || "authorAssociation 非 OWNER|MEMBER|COLLABORATOR"}）——Path W 只接受 OWNER|MEMBER|COLLABORATOR 帳號發出的 waiver（AI 代貼時用的是使用者自己的 \`gh\` 登入）。`;
    }
    return "";
  }

  // Path B: branch non-exempt, sticky absent → Path W may clear; else block
  if (stickyAuthority.status === "missing") {
    const pathW = tryPathWPass("");
    if (pathW?.block) return pathW;
    if (pathW?.pass) return { block: false, audits, sticky: null };
    return {
      block: true,
      reason: `Cross-Model Merge Gate (Path B)：PR #${prNumber} 需要 cross-model review（分支 \`${prHeadRefName}\` 不在豁免清單），但尚無 sticky comment（magic marker \`${STICKY_MAGIC_MARKER}\`）。${waiverFailHint()}${staleReadHint()}\n\n請先執行 \`/devpro:cross-review ${prNumber}\` 取得 cross-model second opinion，或在對話問使用者是否豁免本 PR；使用者說要豁免後，以 OWNER|MEMBER|COLLABORATOR 帳號發佈合規 current-head Path W waiver comment（AI 可用使用者自己的 \`gh\` 登入代貼，\`reason:\` 引用使用者原話），再嘗試 merge。\n\n${QUOTA_FALLBACK_HINT}\n\n${HOOK_BYPASS_HINT}`,
    };
  }

  const sticky = stickyAuthority.authority;
  const stickyBody = typeof sticky.body === "string" ? sticky.body : "";
  const stickyUrl = typeof sticky.url === "string" ? sticky.url : "";

  // Path C: parse the complete marker/machine/provenance authority contract.
  const parsedSticky = parseSecondReviewStickyAuthorityBody(stickyBody);
  if (parsedSticky.status !== "valid") {
    const detail = parsedSticky.contract_errors.join(", ");
    return {
      block: true,
      reason: `Cross-Model Merge Gate (Path C)：PR #${prNumber} sticky comment 解析失敗 — ${detail}。\n\nfail-closed：請執行 \`/devpro:cross-review ${prNumber}\` 重新產生合法 sticky comment。\n\n${HOOK_BYPASS_HINT}`,
    };
  }
  const verdictResult = { found: true, verdict: parsedSticky.verdict };
  const shaResult = { found: true, sha: parsedSticky.last_reviewed_sha };

  // Path D: validate headRefOid is a full 40-char sha hex (C4 fix — fail-closed on falsy/invalid)
  const rawHeadRefOid = typeof prData.headRefOid === "string" ? prData.headRefOid.trim() : "";
  if (!_isValidSha(rawHeadRefOid)) {
    return {
      block: true,
      reason: `Cross-Model Merge Gate (Path D)：PR #${prNumber} 的 headRefOid 無效或缺少（值: "${rawHeadRefOid}"）。\n\nfail-closed：PR 資料不完整，無法驗證 review sha 是否為最新。請執行 \`/devpro:cross-review ${prNumber}\` 重新審查。\n\n${HOOK_BYPASS_HINT}`,
    };
  }

  // Path D: stale sha check
  if (shaResult.sha !== rawHeadRefOid) {
    // Path D′ carve-out (Option B, design.md D2/D12): the sticky's reviewed
    // sha no longer matches headRefOid, so this is a block by default — but if
    // `gh api compare/<last_reviewed_sha>...<headRefOid>` proves the diff touches
    // ONLY whitelisted bookkeeping paths (openspec/changes/**, notes/**), treat
    // it as fresh-equivalent and fall through to Path E/F instead of blocking.
    // Any compare uncertainty (offline, rate-limit, non-ancestor, truncated
    // files, non-whitelisted path) falls back to the original block — this is a
    // structural fail-closed guarantee (R4), not a conditional one.
    let fetched;
    try { fetched = compare?.(shaResult.sha, rawHeadRefOid); }
    catch { fetched = { ok: false, reason: "compare-unavailable" }; }
    const freshEquivalent = evaluateFreshEquivalentEvidence({
      lastReviewedSha: shaResult.sha,
      headRefOid: rawHeadRefOid,
      fetched,
    });
    if (!freshEquivalent.fresh_equivalent) {
      return {
        block: true,
        reason: `Cross-Model Merge Gate (Path D)：PR #${prNumber} sticky comment 的 \`last_reviewed_sha: ${shaResult.sha}\` 與當前 headRefOid \`${rawHeadRefOid}\` 不符（stale verdict）。Path D′ fresh-equivalent 判定：${freshEquivalent.reason}（非 whitelist-only，不套用 carve-out）。\n\n請先執行 \`/devpro:cross-review ${prNumber}\` re-run cross-model review 後再嘗試 merge。\n\n${HOOK_BYPASS_HINT}`,
      };
    }
    // fresh-equivalent: fall through to Path E/F below as if sha had matched.
  }

  const verdict = verdictResult.verdict;

  // Path E: CRITICAL verdict → block (Path W MUST NOT override)
  if (verdict === "CRITICAL") {
    const urlHint = stickyUrl ? ` 詳見 sticky comment：${stickyUrl}` : "";
    return {
      block: true,
      reason: `Cross-Model Merge Gate (Path E)：PR #${prNumber} cross-model review verdict 為 \`CRITICAL\`。${urlHint}\n\n請先解決 CRITICAL 問題後執行 \`/devpro:cross-review ${prNumber}\` 重新審查；PR comment 回應與 Path W waiver 都不是此 gate 的解除條件。\n\n若已確認可接受，${HOOK_BYPASS_HINT}`,
    };
  }

  // Path U: UNAVAILABLE → Path W may clear; else block (audit trail ≠ merge approval)
  if (verdict === "UNAVAILABLE") {
    const pathW = tryPathWPass("UNAVAILABLE");
    if (pathW?.block) return pathW;
    if (pathW?.pass) return { block: false, audits, sticky: null };
    const urlHint = stickyUrl ? ` 詳見 sticky comment：${stickyUrl}` : "";
    return {
      block: true,
      reason: `Cross-Model Merge Gate (Path U)：PR #${prNumber} cross-model review verdict 為 \`UNAVAILABLE\`。${urlHint}${waiverFailHint()}\n\nUNAVAILABLE is not merge approval；它只表示沒有取得 fresh independent reviewer result。請先重新執行 \`/devpro:cross-review ${prNumber}\`、取得人類 reviewer 明確結果，或在對話問使用者是否豁免本 PR；使用者說要豁免後，以 OWNER|MEMBER|COLLABORATOR 帳號發佈合規 current-head Path W waiver（AI 可代貼，\`reason:\` 引用使用者原話）。\n\n${QUOTA_FALLBACK_HINT}\n\n${HOOK_BYPASS_HINT}`,
    };
  }

  return { block: false, audits, sticky: parsedSticky };
}
