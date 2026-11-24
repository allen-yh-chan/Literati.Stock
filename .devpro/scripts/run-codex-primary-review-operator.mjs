#!/usr/bin/env node
/**
 * Cursor→Codex primary independent-review operator entry (dogfood).
 *
 * Does NOT spawn reviewers itself. Fail-closed preflights + prints a
 * POSIX-single-quoted `codex exec` recipe (prefer argv-array spawn when
 * embedding in a host that can exec directly).
 *
 * Usage:
 *   node .devpro/scripts/run-codex-primary-review-operator.mjs --check-only \
 *     --change <id> --frozen-origin-main <40-hex> \
 *     [--handoff <path>] [--prev-receipt-ref <path>] [--notes-root <path>]
 *   node .devpro/scripts/run-codex-primary-review-operator.mjs --print-exec \
 *     --change <id> --frozen-origin-main <40-hex> --handoff <path> \
 *     [--prev-receipt-ref <path>] [--task-name <name>] [--notes-root <path>]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CHANGE_ID_SHAPE } from "./lib/durable-fs.mjs";
import {
  evaluateRegressionHeadCurrency,
  expandRenameAwareNameStatusPaths,
} from "./lib/regression-head-record.mjs";

/**
 * Identifier shapes MUST match admission authority:
 * - change: `CHANGE_ID_SHAPE` from durable-fs (shared import)
 * - task_name: exact same pattern as private `CODEX_REVIEWER_TASK_NAME` in
 *   hooks/lib/admission-record.mjs (not exported — keep byte-identical here; R5
 *   forbids admission-record behavior/diff for this change).
 */
const CHANGE_ID_RE = CHANGE_ID_SHAPE;
const TASK_NAME_RE = /^[a-z0-9][a-z0-9_]{0,99}$/u;

export { CHANGE_ID_RE, TASK_NAME_RE };

/** POSIX single-quote encode: ' -> '\''  (safe inside sh single quotes). */
export function posixSingleQuote(value) {
  if (typeof value !== "string") throw new Error("posixSingleQuote requires string");
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function assertSafeIdentifier(kind, value, re) {
  if (typeof value !== "string" || !re.test(value) || /[\r\n\0]/.test(value)) {
    return { ok: false, code: `${kind}-unsafe`, value };
  }
  return { ok: true, value };
}

function die(code, message, extra = {}) {
  const result = { ok: false, code, message, ...extra };
  process.stderr.write(`${message}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = typeof code === "number" ? code : 1;
  return result;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function parseArgs(argv) {
  const out = {
    checkOnly: false,
    printExec: false,
    change: null,
    handoff: null,
    prevReceiptRef: null,
    taskName: null,
    frozenOriginMain: null,
    notesRoot: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--check-only") out.checkOnly = true;
    else if (a === "--print-exec") out.printExec = true;
    else if (a === "--change") out.change = argv[++i];
    else if (a === "--handoff") out.handoff = argv[++i];
    else if (a === "--prev-receipt-ref") out.prevReceiptRef = argv[++i];
    else if (a === "--task-name") out.taskName = argv[++i];
    else if (a === "--frozen-origin-main") out.frozenOriginMain = argv[++i];
    else if (a === "--notes-root") out.notesRoot = argv[++i];
    else return { ok: false, error: `unknown-arg:${a}` };
  }
  if (!out.checkOnly && !out.printExec) return { ok: false, error: "mode-required" };
  if (!out.change) return { ok: false, error: "change-required" };
  if (out.printExec && !out.handoff) return { ok: false, error: "handoff-required-for-print-exec" };
  if (!out.frozenOriginMain) return { ok: false, error: "frozen-origin-main-required" };
  return { ok: true, ...out };
}

function parseRiskClasses(proposalText) {
  const m = proposalText.match(/^risk_classes:\s*\[([^\]]*)\]/m);
  if (!m) return { present: false, values: [] };
  const values = m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  return { present: true, values };
}

function extractTouchPaths(proposalText) {
  const touchMatch = proposalText.match(/## Section 2: Touch\n([\s\S]*?)(?=\n## )/);
  if (!touchMatch) return { ok: false, paths: [] };
  const paths = [];
  for (const line of touchMatch[1].split("\n")) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|/);
    if (m) paths.push(m[1]);
  }
  return { ok: paths.length > 0, paths };
}

const QA_SECTION_MARKERS = [
  "### 1)",
  "### 2)",
  "### 3)",
  "### 4)",
  "### 5)",
  "### 6)",
];

/**
 * Paths that may land after a done/waived ui-smoke SHA without invalidating smoke
 * (change-folder / notes bookkeeping, or default non-UI trigger surfaces).
 * UI-trigger extensions/dirs are checked FIRST (SSOT: testing-and-qa.md §UI smoke)
 * so allow-prefixes like `.devpro/scripts/` / `docs/` cannot mask `*.tsx` / `*.css`.
 */
export function isAllowedPostSmokeDeltaPath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  // Conservative UI-trigger denylist first — any hit fails closed for stale smoke.
  if (/\.(cshtml|razor|tsx|jsx|vue|css|scss)$/i.test(filePath)) return false;
  if (/(^|\/)(Views|Pages|wwwroot|components)\//i.test(filePath)) return false;
  if (filePath.startsWith("openspec/changes/") || filePath.startsWith("notes/")) return true;
  if (filePath.startsWith(".devpro/agent-rules/")) return true;
  if (filePath.startsWith(".devpro/agent-skills/")) return true;
  if (filePath.startsWith(".devpro/scripts/")) return true;
  if (filePath.startsWith("docs/") || filePath === "README.md" || filePath.startsWith("README.")) return true;
  if (/\.(ya?ml)$/i.test(filePath) && (filePath.startsWith(".github/") || filePath.includes("/workflows/"))) {
    return true;
  }
  // Remaining tracked paths (backend/code not in the non-UI defaults): fail closed.
  return false;
}

/**
 * Tight ancestor-of-tip currency for committed ui smoke head:
 * 1) reported is ancestor of tip
 * 2) reported is a strict descendant of merge-base(originMain, tip) (on-branch, not pre-branch)
 * 3) diff paths reported..tip ⊆ allowed post-smoke delta (bookkeeping / non-UI)
 */
export function evaluateAncestorOfTipCurrency({
  gitOps,
  cwd,
  reported,
  tip,
  originMain,
}) {
  try {
    gitOps(cwd, ["merge-base", "--is-ancestor", reported, tip]);
  } catch {
    return { ok: false, reason: "not-ancestor-of-tip" };
  }
  let branchBase;
  try {
    branchBase = gitOps(cwd, ["merge-base", originMain, tip]);
  } catch {
    return { ok: false, reason: "branch-base-unresolvable" };
  }
  try {
    gitOps(cwd, ["merge-base", "--is-ancestor", branchBase, reported]);
  } catch {
    return { ok: false, reason: "reported-not-on-branch" };
  }
  let reportedFull;
  try {
    reportedFull = gitOps(cwd, ["rev-parse", reported]);
  } catch {
    return { ok: false, reason: "reported-unresolvable" };
  }
  if (reportedFull.toLowerCase() === branchBase.toLowerCase()) {
    return { ok: false, reason: "reported-equals-branch-base" };
  }
  let deltaRaw = "";
  try {
    deltaRaw = gitOps(cwd, ["diff", "--name-only", `${reportedFull}..${tip}`]);
  } catch {
    return { ok: false, reason: "delta-unresolvable" };
  }
  const deltaPaths = deltaRaw ? deltaRaw.split("\n").filter(Boolean) : [];
  const blocked = deltaPaths.filter((p) => !isAllowedPostSmokeDeltaPath(p));
  if (blocked.length > 0) {
    return { ok: false, reason: "delta-includes-ui-or-code", blocked: blocked.slice(0, 20) };
  }
  return { ok: true, branch_base: branchBase, reported_full: reportedFull, delta_count: deltaPaths.length };
}

/**
 * UI smoke head currency (SSOT testing-and-qa.md §UI smoke: head value domain is `<sha>` only, N/A+why is never legal on the head):
 * - every `ui smoke:` value (done / waived+ / N/A+): head is ≥7 hex; exact tip prefix OR tight ancestor-of-tip (via isAncestor)
 *   so a committed qa-test-scope.md need not embed the seal commit's own SHA
 *   (non-cyclic with clean-tree + tip-green evidence policy).
 */
export function validateUiSmokeFields(qaText, currentHeadSha = null, { isAncestor = null } = {}) {
  const smoke = qaText.match(/^\s*-\s*ui smoke:\s*(.+)$/m);
  const smokeHead = qaText.match(/^\s*-\s*ui smoke head:\s*(.+)$/m);
  if (!smoke || !smokeHead) return { ok: false, code: "qa-ui-smoke-fields-missing" };
  const smokeVal = smoke[1].trim();
  const headVal = smokeHead[1].trim();
  if (!smokeVal || !headVal) return { ok: false, code: "qa-ui-smoke-empty" };
  if (smokeVal.includes("|") || headVal.includes("|")) return { ok: false, code: "qa-ui-smoke-template-residue" };
  const smokeOk = smokeVal === "done"
    || /^waived\+\S.*$/.test(smokeVal)
    || /^N\/A\+\S.*$/.test(smokeVal);
  if (!smokeOk) return { ok: false, code: "qa-ui-smoke-illegal-value" };
  if (!/^[0-9a-f]{7,40}$/i.test(headVal)) return { ok: false, code: "qa-ui-smoke-head-sha-required" };
  if (!currentHeadSha) {
    return { ok: true, smoke: smokeVal, smoke_head: headVal, currency: "unchecked" };
  }
  const full = currentHeadSha.toLowerCase();
  const reported = headVal.toLowerCase();
  const exactOrPrefix = full === reported || full.startsWith(reported);
  if (exactOrPrefix) {
    return { ok: true, smoke: smokeVal, smoke_head: headVal, currency: "exact-or-prefix" };
  }
  let ancestorOk = false;
  let ancestorDetail = null;
  if (typeof isAncestor === "function") {
    try {
      const result = isAncestor(reported, full);
      if (result === true) ancestorOk = true;
      else if (result && typeof result === "object" && result.ok === true) {
        ancestorOk = true;
        ancestorDetail = result;
      }
    } catch {
      ancestorOk = false;
    }
  }
  if (!ancestorOk) {
    return {
      ok: false,
      code: "qa-ui-smoke-head-mismatch",
      expected: currentHeadSha,
      actual: headVal,
      ...(ancestorDetail ? { ancestor: ancestorDetail } : {}),
    };
  }
  return {
    ok: true,
    smoke: smokeVal,
    smoke_head: headVal,
    currency: "ancestor-of-tip",
    ...(ancestorDetail ? { ancestor: ancestorDetail } : {}),
  };
}

/** Section body is content AFTER the heading line — titles alone do not count. */
export function validateQaSectionsNonEmpty(qaText) {
  const missing = [];
  for (const marker of QA_SECTION_MARKERS) {
    const start = qaText.indexOf(marker);
    if (start < 0) { missing.push(marker); continue; }
    const afterMarker = qaText.slice(start + marker.length);
    const eol = afterMarker.indexOf("\n");
    const afterHeadingLine = eol === -1 ? "" : afterMarker.slice(eol + 1);
    // Next ATX heading may start at index 0 (e.g. ### UI smoke immediately).
    let end = afterHeadingLine.length;
    if (afterHeadingLine.startsWith("### ")) end = 0;
    else {
      const next = afterHeadingLine.search(/\n### /);
      if (next !== -1) end = next;
    }
    const body = afterHeadingLine.slice(0, end).replace(/\s+/g, "");
    if (!body) missing.push(`${marker}:empty`);
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/** Fail if unquarantined tl-direct receipts for this change sit in notes root. */
export function findPoisonedTlDirectReceipts(notesRoot, changeId) {
  if (!notesRoot) return [];
  if (!existsSync(notesRoot)) {
    const err = new Error(`notes-root-missing:${notesRoot}`);
    err.code = "notes-root-missing";
    err.notes_root = notesRoot;
    throw err;
  }
  const prefix = `review-${changeId}-receipt-`;
  const hits = [];
  for (const name of readdirSync(notesRoot)) {
    if (!name.startsWith(prefix) || !name.endsWith(".json") || name.includes(".commit.")) continue;
    const full = path.join(notesRoot, name);
    let record;
    try { record = JSON.parse(readFileSync(full, "utf8")); } catch { continue; }
    const attribution = record?.executor_attribution
      ?? record?.reviewer_payload?.executor_attribution
      ?? record?.reviewer_payload?.reviewer_identity?.executor_kind
      ?? record?.reviewer_payload?.executor_kind
      ?? null;
    if (typeof attribution === "string" && /tl-direct/i.test(attribution)) hits.push(name);
  }
  return hits;
}

export function defaultNotesRootCandidates(cwd) {
  return [
    path.join(cwd, "notes"),
    path.join(path.dirname(cwd), "notes"),
    path.join(path.dirname(path.dirname(cwd)), "notes"),
  ];
}

export function evaluatePreflight({
  cwd,
  change,
  handoffPath = null,
  prevReceiptRef = null,
  taskName = null,
  frozenOriginMain = null,
  notesRoot = null,
  gitOps = git,
  nowOriginMain = null,
}) {
  const checks = [];
  const changeSafe = assertSafeIdentifier("change", change, CHANGE_ID_RE);
  if (!changeSafe.ok) return { ok: false, code: changeSafe.code, checks };

  const proposalPath = path.join(cwd, "openspec/changes", change, "proposal.md");
  const qaPath = path.join(cwd, "openspec/changes", change, "qa-test-scope.md");
  const decisionsPath = path.join(cwd, "openspec/changes", change, "decisions.md");
  const regressionPathCandidates = [
    path.join(cwd, "notes", `qa-regression-head-${change}.json`),
    path.join(path.dirname(cwd), "notes", `qa-regression-head-${change}.json`),
    path.join(path.dirname(path.dirname(cwd)), "notes", `qa-regression-head-${change}.json`),
  ];

  let head;
  let originMain;
  try {
    head = gitOps(cwd, ["rev-parse", "HEAD"]);
    gitOps(cwd, ["fetch", "origin", "main"]);
    originMain = nowOriginMain ?? gitOps(cwd, ["show-ref", "--verify", "--hash", "refs/remotes/origin/main"]);
  } catch (error) {
    return { ok: false, code: "git-preflight-failed", message: error.message, checks };
  }
  checks.push({ id: "tip-freeze-fetch", ok: true, origin_main: originMain, head });
  if (!frozenOriginMain) {
    checks.push({ id: "tip-freeze-match", ok: false, reason: "frozen-origin-main-required" });
    return { ok: false, code: "frozen-origin-main-required", checks };
  }
  if (!/^[0-9a-f]{40}$/.test(frozenOriginMain)) {
    checks.push({ id: "tip-freeze-match", ok: false, reason: "frozen-sha-malformed" });
    return { ok: false, code: "frozen-origin-main-malformed", checks };
  }
  if (frozenOriginMain !== originMain) {
    // Gate A: tip advanced relative to freeze. Gate B: rename-aware
    // freeze..new-tip ∩ (Touch ∪ branch-diff). Only A∧B hard-blocks.
    if (!existsSync(proposalPath)) {
      checks.push({
        id: "tip-freeze-match",
        ok: false,
        frozen: frozenOriginMain,
        current: originMain,
        reason: "missing-proposal-for-gate-b",
      });
      return { ok: false, code: "origin-main-advanced", checks };
    }
    let tipFreezeProposal;
    try {
      tipFreezeProposal = readFileSync(proposalPath, "utf8");
    } catch (error) {
      checks.push({
        id: "tip-freeze-match",
        ok: false,
        frozen: frozenOriginMain,
        current: originMain,
        reason: error.message,
      });
      return { ok: false, code: "origin-main-advanced", checks };
    }
    const tipFreezeTouch = extractTouchPaths(tipFreezeProposal);
    let mainDelta = [];
    let branchPaths = [];
    try {
      const mainRaw = gitOps(cwd, [
        "diff",
        "--name-status",
        "-M",
        `${frozenOriginMain}..${originMain}`,
      ]);
      mainDelta = expandRenameAwareNameStatusPaths(mainRaw);
      const branchBase = gitOps(cwd, ["merge-base", frozenOriginMain, head]);
      const branchRaw = gitOps(cwd, [
        "diff",
        "--name-status",
        "-M",
        `${branchBase}..${head}`,
      ]);
      branchPaths = expandRenameAwareNameStatusPaths(branchRaw);
    } catch (error) {
      checks.push({
        id: "tip-freeze-match",
        ok: false,
        frozen: frozenOriginMain,
        current: originMain,
        reason: error.message,
      });
      return { ok: false, code: "origin-main-advanced", checks };
    }
    const changePaths = new Set([...branchPaths, ...tipFreezeTouch.paths]);
    const intersect = mainDelta.filter((p) => changePaths.has(p));
    if (intersect.length > 0) {
      checks.push({
        id: "tip-freeze-match",
        ok: false,
        frozen: frozenOriginMain,
        current: originMain,
        intersect: intersect.slice(0, 20),
      });
      return { ok: false, code: "origin-main-advanced", checks };
    }
    checks.push({
      id: "tip-freeze-match",
      ok: true,
      update_freeze_only: true,
      recommended_frozen_origin_main: originMain,
      origin_main: originMain,
      frozen: frozenOriginMain,
    });
  } else {
    checks.push({ id: "tip-freeze-match", ok: true, origin_main: originMain });
  }

  const dirty = gitOps(cwd, ["status", "--porcelain"]);
  if (dirty) {
    checks.push({ id: "clean-tree", ok: false, detail: dirty.split("\n").slice(0, 8) });
    return { ok: false, code: "dirty-tree", checks };
  }
  checks.push({ id: "clean-tree", ok: true });

  if (!existsSync(proposalPath)) {
    return { ok: false, code: "missing-proposal", checks };
  }
  const proposal = readFileSync(proposalPath, "utf8");
  const risk = parseRiskClasses(proposal);
  const decisionsText = existsSync(decisionsPath) ? readFileSync(decisionsPath, "utf8") : "";
  const independenceRequired =
    (risk.present && !(risk.values.length === 1 && risk.values[0] === "none"))
    || /獨立判斷|requireIndependence|independent-judgment/i.test(decisionsText);
  checks.push({
    id: "independence-pre-gate",
    ok: true,
    independence_required: independenceRequired,
    risk_classes: risk.values,
    forbid_tl_direct_first: independenceRequired,
  });

  const touch = extractTouchPaths(proposal);
  if (!touch.ok) {
    checks.push({ id: "touch-section-present", ok: false });
    return { ok: false, code: "touch-missing", checks };
  }
  checks.push({ id: "touch-section-present", ok: true, path_count: touch.paths.length });

  let diffPaths = [];
  try {
    // Use verified originMain SHA (not bare origin/main...) so same-name
    // local tag/branch cannot shadow refs/remotes/origin/main.
    const raw = gitOps(cwd, ["diff", "--name-only", `${originMain}...${head}`]);
    diffPaths = raw ? raw.split("\n").filter(Boolean) : [];
  } catch (error) {
    return { ok: false, code: "diff-failed", message: error.message, checks };
  }
  const bookkeeping = (p) =>
    p.startsWith("openspec/changes/")
    || p.startsWith("notes/");
  const missingFromTouch = diffPaths.filter(
    (p) => !bookkeeping(p) && !touch.paths.some((t) => t === p || p.startsWith(`${t}/`)),
  );
  if (missingFromTouch.length > 0) {
    checks.push({ id: "touch-covers-diff", ok: false, missing: missingFromTouch.slice(0, 20) });
    return { ok: false, code: "touch-incomplete", checks, missingFromTouch };
  }
  checks.push({ id: "touch-covers-diff", ok: true, diff_count: diffPaths.length });

  if (!existsSync(qaPath)) {
    checks.push({ id: "qa-test-scope-present", ok: false });
    return { ok: false, code: "missing-qa", checks };
  }
  const qa = readFileSync(qaPath, "utf8");
  const missingQa = QA_SECTION_MARKERS.filter((m) => !qa.includes(m));
  if (missingQa.length > 0) {
    checks.push({ id: "qa-six-sections", ok: false, missing: missingQa });
    return { ok: false, code: "qa-sections-incomplete", checks };
  }
  const emptyQa = validateQaSectionsNonEmpty(qa);
  if (!emptyQa.ok) {
    checks.push({ id: "qa-six-sections-nonempty", ok: false, missing: emptyQa.missing });
    return { ok: false, code: "qa-sections-empty", checks };
  }
  const uiSmoke = validateUiSmokeFields(qa, head, {
    isAncestor: (reported, tip) => evaluateAncestorOfTipCurrency({
      gitOps,
      cwd,
      reported,
      tip,
      originMain,
    }),
  });
  if (!uiSmoke.ok) {
    checks.push({ id: "qa-ui-smoke-fields", ok: false, code: uiSmoke.code });
    return { ok: false, code: uiSmoke.code, checks };
  }
  checks.push({ id: "qa-six-sections", ok: true, ui_smoke: uiSmoke });

  // R6: consume shared currency verdict (exact-HEAD or bookkeeping tip-move).
  // Prefer an explicit notes candidate so fixture cwd/notes and worktree→main
  // notes both resolve; SSOT path math still lives in evaluateRegressionHeadCurrency.
  const regressionPath = regressionPathCandidates.find((p) => existsSync(p));
  const currency = evaluateRegressionHeadCurrency({
    cwd,
    change: changeSafe.value,
    currentHeadSha: head,
    ...(regressionPath
      ? { mainCheckoutRoot: path.dirname(path.dirname(regressionPath)) }
      : {}),
  });
  if (!currency.ok) {
    const code =
      currency.kind === "missing"
        ? "regression-head-missing"
        : currency.kind === "unusable"
          ? "regression-head-unparseable"
          : "regression-head-stale";
    checks.push({
      id: "regression-head-currency",
      ok: false,
      kind: currency.kind,
      tested: currency.testedSha,
      current: currency.currentSha,
      reason: currency.reason,
      path: currency.recordPath || regressionPath || null,
    });
    return { ok: false, code, checks };
  }
  checks.push({
    id: "regression-head-currency",
    ok: true,
    kind: currency.kind,
    path: currency.recordPath || regressionPath || null,
  });

  const candidateRoots = notesRoot
    ? [notesRoot]
    : defaultNotesRootCandidates(cwd);
  if (notesRoot && !existsSync(notesRoot)) {
    checks.push({ id: "poisoned-receipt-quarantine", ok: false, notes_root: notesRoot, reason: "notes-root-missing" });
    return { ok: false, code: "notes-root-missing", checks };
  }
  const existingRoots = candidateRoots.filter((root) => existsSync(root));
  if (existingRoots.length === 0) {
    checks.push({ id: "poisoned-receipt-quarantine", ok: true, notes_roots: [], skipped: true });
  } else {
    const poisoned = [];
    for (const root of existingRoots) {
      try {
        for (const hit of findPoisonedTlDirectReceipts(root, change)) {
          poisoned.push({ notes_root: root, file: hit });
        }
      } catch (error) {
        if (error?.code === "notes-root-missing") {
          checks.push({ id: "poisoned-receipt-quarantine", ok: false, notes_root: error.notes_root });
          return { ok: false, code: "notes-root-missing", checks };
        }
        throw error;
      }
    }
    if (poisoned.length > 0) {
      checks.push({
        id: "poisoned-receipt-quarantine",
        ok: false,
        hits: poisoned.slice(0, 10),
        notes_roots: existingRoots,
      });
      return { ok: false, code: "poisoned-tl-direct-unquarantined", checks };
    }
    checks.push({ id: "poisoned-receipt-quarantine", ok: true, notes_roots: existingRoots });
  }

  let lineage = null;
  if (prevReceiptRef) {
    if (!existsSync(prevReceiptRef)) {
      return { ok: false, code: "prev-receipt-missing", checks };
    }
    const digest = sha256File(prevReceiptRef);
    let payloadDigest = null;
    try {
      payloadDigest = JSON.parse(readFileSync(prevReceiptRef, "utf8")).receipt_digest_sha256 ?? null;
    } catch {
      payloadDigest = null;
    }
    const confused = payloadDigest != null && payloadDigest === digest;
    // File digest is authority; payload digest colliding with ref digest is rare but
    // still ok for initial_full — the cheat-sheet forbids using payload field as source.
    lineage = {
      receipt_ref_path: prevReceiptRef,
      receipt_ref_digest_sha256: digest,
      payload_receipt_digest_sha256: payloadDigest,
      cheat_sheet:
        "initial_full_receipt_digest_sha256 MUST equal receipt_ref_digest_sha256 (file bytes), NOT payload receipt_digest_sha256",
      assert_ok: typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest),
      payload_equals_ref_digest: confused,
    };
    if (!lineage.assert_ok) {
      checks.push({ id: "lineage-digest-cheat-sheet", ok: false, lineage });
      return { ok: false, code: "lineage-digest-invalid", checks, lineage };
    }
    checks.push({ id: "lineage-digest-cheat-sheet", ok: true, ...lineage });
  }

  if (handoffPath) {
    if (!existsSync(handoffPath)) return { ok: false, code: "handoff-missing", checks };
    const handoff = readFileSync(handoffPath, "utf8");
    if (!handoff.includes(head)) {
      checks.push({ id: "handoff-head-match", ok: false, expected: head });
      return { ok: false, code: "handoff-head-mismatch", checks };
    }
    if (!handoff.includes(originMain)) {
      checks.push({ id: "handoff-origin-main-match", ok: false, expected: originMain });
      return { ok: false, code: "handoff-origin-main-mismatch", checks };
    }
    checks.push({ id: "handoff-head-match", ok: true, head, origin_main: originMain });
    if (
      independenceRequired
      && /tl-direct/i.test(handoff)
      && !/MUST NOT[\s\S]{0,80}tl-direct|forbid[\s\S]{0,40}tl-direct/i.test(handoff)
    ) {
      checks.push({ id: "handoff-forbids-tl-direct", ok: false });
      return { ok: false, code: "handoff-allows-tl-direct", checks };
    }
    checks.push({ id: "handoff-size-bytes", ok: true, bytes: statSync(handoffPath).size });
  }

  if (taskName != null) {
    const taskSafe = assertSafeIdentifier("task-name", taskName, TASK_NAME_RE);
    if (!taskSafe.ok) {
      checks.push({ id: "task-name-safe", ok: false });
      return { ok: false, code: taskSafe.code, checks };
    }
    checks.push({ id: "task-name-safe", ok: true });
  }

  return {
    ok: true,
    change_id: change,
    head_sha: head,
    origin_main_tip: originMain,
    independence_required: independenceRequired,
    checks,
    lineage,
  };
}

export function buildCodexExecRecipe({ cwd, handoffPath, outPath, logPath, tmpdir, taskName }) {
  const q = posixSingleQuote;
  return [
    `cd ${q(cwd)}`,
    `export TMPDIR=${q(tmpdir)}`,
    `mkdir -p "$TMPDIR"`,
    "codex exec \\",
    `  --cd ${q(cwd)} \\`,
    "  -s danger-full-access \\",
    `  -c model_reasoning_effort="xhigh" \\`,
    "  --enable multi_agent \\",
    "  --json \\",
    `  -o ${q(outPath)} \\`,
    `  - < ${q(handoffPath)} \\`,
    `  > ${q(logPath)} 2>&1`,
    `# expected task_name hint: ${taskName}`,
    "# Prefer argv-array spawn when the host can exec without a shell.",
    "# Parent MAY pre-issue admission when notes root is outside the worktree sandbox.",
    "# after child returns: capture → build-receipt-request → seal-receipt → verify-receipt requireIndependence:true",
  ].join("\n");
}

export function runCodexPrimaryReviewOperator(argv, cwd = process.cwd()) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    return die(2, `usage error: ${parsed.error}`);
  }

  const preflight = evaluatePreflight({
    cwd,
    change: parsed.change,
    handoffPath: parsed.handoff,
    prevReceiptRef: parsed.prevReceiptRef,
    taskName: parsed.taskName,
    frozenOriginMain: parsed.frozenOriginMain,
    notesRoot: parsed.notesRoot,
  });
  if (!preflight.ok) {
    process.stdout.write(`${JSON.stringify(preflight, null, 2)}\n`);
    process.exitCode = 1;
    return preflight;
  }

  if (parsed.printExec) {
    const head = preflight.head_sha;
    const taskSafe = assertSafeIdentifier(
      "task-name",
      parsed.taskName
        || `primary_${parsed.change.replace(/[^a-z0-9]+/gi, "_").slice(0, 40)}_${head.slice(0, 10)}`,
      TASK_NAME_RE,
    );
    if (!taskSafe.ok) return die(1, `unsafe task name`, { code: taskSafe.code });
    const notesTmp = path.dirname(parsed.handoff);
    const outPath = path.join(notesTmp, `codex-primary-${parsed.change}-${head.slice(0, 10)}.last.txt`);
    const logPath = path.join(notesTmp, `codex-primary-${parsed.change}-${head.slice(0, 10)}.exec.log`);
    const tmpdir = process.env.TMPDIR && !process.env.TMPDIR.includes(`${path.sep}.worktree${path.sep}`)
      ? process.env.TMPDIR
      : "/tmp";
    const recipe = buildCodexExecRecipe({
      cwd,
      handoffPath: parsed.handoff,
      outPath,
      logPath,
      tmpdir: path.join(tmpdir, "devpro-codex-tmpdir"),
      taskName: taskSafe.value,
    });
    const result = {
      ...preflight,
      codex_exec_recipe: recipe,
      suggested_task_name: taskSafe.value,
      out_path: outPath,
      log_path: logPath,
      argv_array_preferred: [
        "codex",
        "exec",
        "--cd",
        cwd,
        "-s",
        "danger-full-access",
        "-c",
        'model_reasoning_effort="xhigh"',
        "--enable",
        "multi_agent",
        "--json",
        "-o",
        outPath,
        "-",
      ],
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write("\n--- codex exec recipe ---\n");
    process.stdout.write(`${recipe}\n`);
    return result;
  }

  process.stdout.write(`${JSON.stringify(preflight, null, 2)}\n`);
  return preflight;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCodexPrimaryReviewOperator(process.argv.slice(2));
}
