/**
 * Behavioral tests for run-codex-primary-review-operator.mjs (R7 dogfood).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSafeIdentifier,
  posixSingleQuote,
  buildCodexExecRecipe,
  evaluatePreflight,
  validateUiSmokeFields,
  validateQaSectionsNonEmpty,
  findPoisonedTlDirectReceipts,
  evaluateAncestorOfTipCurrency,
  isAllowedPostSmokeDeltaPath,
  CHANGE_ID_RE,
  TASK_NAME_RE,
} from "../run-codex-primary-review-operator.mjs";
import { CHANGE_ID_SHAPE } from "../lib/durable-fs.mjs";
import { writeRegressionHeadRecord, readRegressionHeadRecord } from "../lib/regression-head-record.mjs";

const PASS_SUITE_EVIDENCE = { status: "pass", fail: 0, digest_sha256: "c".repeat(64) };
test("posixSingleQuote neutralizes dollar-paren, backticks, and embedded quotes", () => {
  const dirty = `$(rm -rf /)\`id\`; echo 'x'`;
  const quoted = posixSingleQuote(dirty);
  assert.equal(quoted, `'$(rm -rf /)\`id\`; echo '\\''x'\\'''`);
});

test("operator identifier shapes match canonical admission CHANGE_ID_SHAPE and CODEX_REVIEWER_TASK_NAME", () => {
  assert.equal(CHANGE_ID_RE, CHANGE_ID_SHAPE);
  const admissionSrc = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../hooks/lib/admission-record.mjs"),
    "utf8",
  );
  assert.match(
    admissionSrc,
    /const CODEX_REVIEWER_TASK_NAME = \/\^\[a-z0-9\]\[a-z0-9_\]\{0,99\}\$\/u;/,
  );
  assert.equal(TASK_NAME_RE.source, "^[a-z0-9][a-z0-9_]{0,99}$");
  assert.equal(TASK_NAME_RE.flags, "u");
});

test("assertSafeIdentifier rejects newlines and shell metacharacters in task/change", () => {
  assert.equal(assertSafeIdentifier("task-name", "ok_name_1", TASK_NAME_RE).ok, true);
  assert.equal(assertSafeIdentifier("task-name", "bad\nname", TASK_NAME_RE).ok, false);
  assert.equal(assertSafeIdentifier("change", "fix;rm", CHANGE_ID_RE).ok, false);
});

test("assertSafeIdentifier matches admission: reject hyphenated/uppercase/overlength task and overlength change", () => {
  assert.equal(assertSafeIdentifier("task-name", "ok_name-1", TASK_NAME_RE).ok, false, "hyphen");
  assert.equal(assertSafeIdentifier("task-name", "Ok_name", TASK_NAME_RE).ok, false, "uppercase");
  assert.equal(assertSafeIdentifier("task-name", `a${"b".repeat(100)}`, TASK_NAME_RE).ok, false, "task overlength 101");
  assert.equal(assertSafeIdentifier("task-name", `a${"b".repeat(99)}`, TASK_NAME_RE).ok, true, "task max 100");
  assert.equal(assertSafeIdentifier("change", `a${"b".repeat(100)}`, CHANGE_ID_RE).ok, false, "change overlength 101");
  assert.equal(assertSafeIdentifier("change", `a${"b".repeat(99)}`, CHANGE_ID_RE).ok, true, "change max 100");
  assert.equal(assertSafeIdentifier("change", "fix-resolved-main-origin-authority", CHANGE_ID_RE).ok, true);
});

test("buildCodexExecRecipe uses POSIX single quotes for all path slots", () => {
  const recipe = buildCodexExecRecipe({
    cwd: `/tmp/proj$(evil)`,
    handoffPath: `/tmp/handoff\`id\`.md`,
    outPath: `/tmp/out.txt`,
    logPath: `/tmp/log.txt`,
    tmpdir: `/tmp/td`,
    taskName: "task_ok",
  });
  assert.match(recipe, /cd '\/tmp\/proj\$\(evil\)'/);
  assert.doesNotMatch(recipe, /cd "\/tmp\/proj\$\(evil\)"/);
});

test("validateUiSmokeFields requires legal done|waived+|N/A+ and matching head", () => {
  assert.equal(validateUiSmokeFields("### UI smoke\n- ui smoke: done\n").ok, false);
  // SSOT testing-and-qa.md §UI smoke: N/A+why is legal on `ui smoke:` only; the head value domain is `<sha>`.
  assert.equal(
    validateUiSmokeFields("### UI smoke\n- ui smoke: N/A+no UI\n- ui smoke head: abcdef0\n").ok,
    true,
  );
  assert.equal(validateUiSmokeFields("### UI smoke\n- ui smoke: n/a+x\n- ui smoke head: abcdef0\n").ok, false);
  for (const smokeVal of ["done", "waived+reason", "N/A+no UI"]) {
    const naHead = validateUiSmokeFields(`### UI smoke\n- ui smoke: ${smokeVal}\n- ui smoke head: N/A+same why\n`);
    assert.equal(naHead.ok, false, `ui smoke: ${smokeVal} must not accept an N/A+why head`);
    assert.equal(naHead.code, "qa-ui-smoke-head-sha-required");
  }
  assert.equal(
    validateUiSmokeFields(
      "### UI smoke\n- ui smoke: done\n- ui smoke head: abcdef0\n",
      "abcdef0123456789abcdef0123456789abcdef01",
    ).ok,
    true,
  );
  assert.equal(
    validateUiSmokeFields(
      "### UI smoke\n- ui smoke: done\n- ui smoke head: deadbee\n",
      "abcdef0123456789abcdef0123456789abcdef01",
    ).ok,
    false,
  );
  // Ancestor-of-tip currency (non-cyclic with clean-tree seal): reported SHA need not equal tip.
  assert.equal(
    validateUiSmokeFields(
      "### UI smoke\n- ui smoke: done\n- ui smoke head: 1111111111111111111111111111111111111111\n",
      "2222222222222222222222222222222222222222",
      { isAncestor: () => ({ ok: true, reason: "stub" }) },
    ).ok,
    true,
  );
  assert.equal(
    validateUiSmokeFields(
      "### UI smoke\n- ui smoke: done\n- ui smoke head: 1111111111111111111111111111111111111111\n",
      "2222222222222222222222222222222222222222",
      { isAncestor: () => ({ ok: false, reason: "delta-includes-ui-or-code" }) },
    ).ok,
    false,
  );
});

test("isAllowedPostSmokeDeltaPath allows non-UI defaults and rejects UI surfaces", () => {
  assert.equal(isAllowedPostSmokeDeltaPath(".devpro/scripts/x.mjs"), true);
  assert.equal(isAllowedPostSmokeDeltaPath("openspec/changes/a/qa-test-scope.md"), true);
  assert.equal(isAllowedPostSmokeDeltaPath("src/App.tsx"), false);
  assert.equal(isAllowedPostSmokeDeltaPath("Views/Home/Index.cshtml"), false);
  // Allow-prefix must not mask UI extensions (Codex sticky finding).
  assert.equal(isAllowedPostSmokeDeltaPath(".devpro/scripts/ui.tsx"), false);
  assert.equal(isAllowedPostSmokeDeltaPath("docs/site.css"), false);
  assert.equal(isAllowedPostSmokeDeltaPath(".devpro/agent-skills/foo/bar.vue"), false);
});

test("evaluateAncestorOfTipCurrency requires on-branch strict descendant and non-UI delta", () => {
  const originMain = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const branchBase = "cccccccccccccccccccccccccccccccccccccccc";
  const reported = "dddddddddddddddddddddddddddddddddddddddd";
  const tip = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const okGit = (_cwd, args) => {
    if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
      // allow branchBase->reported and reported->tip
      if (args[2] === reported && args[3] === tip) return "";
      if (args[2] === branchBase && args[3] === reported) return "";
      throw new Error("not ancestor");
    }
    if (args[0] === "merge-base") return branchBase;
    if (args[0] === "rev-parse") return reported;
    if (args[0] === "diff") return ".devpro/scripts/run-codex-primary-review-operator.mjs\nnotes/qa.json";
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  assert.equal(
    evaluateAncestorOfTipCurrency({
      gitOps: okGit,
      cwd: "/tmp",
      reported,
      tip,
      originMain,
    }).ok,
    true,
  );
  // Pre-branch ancestor (reported equals branch base) → fail
  assert.equal(
    evaluateAncestorOfTipCurrency({
      gitOps: (_cwd, args) => {
        if (args[0] === "merge-base" && args[1] === "--is-ancestor") return "";
        if (args[0] === "merge-base") return branchBase;
        if (args[0] === "rev-parse") return branchBase;
        if (args[0] === "diff") return "";
        throw new Error("stop");
      },
      cwd: "/tmp",
      reported: branchBase,
      tip,
      originMain,
    }).ok,
    false,
  );
  // Delta includes UI path → fail
  assert.equal(
    evaluateAncestorOfTipCurrency({
      gitOps: (_cwd, args) => {
        if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
          if (args[2] === reported && args[3] === tip) return "";
          if (args[2] === branchBase && args[3] === reported) return "";
          throw new Error("not ancestor");
        }
        if (args[0] === "merge-base") return branchBase;
        if (args[0] === "rev-parse") return reported;
        if (args[0] === "diff") return "src/App.tsx";
        throw new Error("stop");
      },
      cwd: "/tmp",
      reported,
      tip,
      originMain,
    }).reason,
    "delta-includes-ui-or-code",
  );
});

test("validateQaSectionsNonEmpty rejects headings-only sections", () => {
  assert.equal(validateQaSectionsNonEmpty("### 1)\n### 2)\n### 3)\n### 4)\n### 5)\n### 6)\n").ok, false);
  assert.equal(
    validateQaSectionsNonEmpty("### 1)\nbody\n### 2)\nb\n### 3)\nc\n### 4)\nd\n### 5)\ne\n### 6)\nf\n").ok,
    true,
  );
  assert.equal(validateQaSectionsNonEmpty("### 1) title-only\n### 2) t\n### 3) t\n### 4) t\n### 5) t\n### 6) t\n").ok, false);
  // Real QA shape: empty numbered sections then ### UI smoke at index 0 of the slice.
  assert.equal(
    validateQaSectionsNonEmpty("### 1)\n### 2)\n### 3)\n### 4)\n### 5)\n### 6)\n### UI smoke\n- ui smoke: N/A+x\n").ok,
    false,
  );
});

test("findPoisonedTlDirectReceipts detects unquarantined tl-direct receipts", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rmoa-notes-"));
  try {
    writeFileSync(
      path.join(root, "review-demo-change-receipt-r1-deadbeef.json"),
      JSON.stringify({ executor_attribution: "tl-direct" }),
    );
    assert.deepEqual(findPoisonedTlDirectReceipts(root, "demo-change"), [
      "review-demo-change-receipt-r1-deadbeef.json",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findPoisonedTlDirectReceipts fail-closed when notes root is missing", () => {
  assert.throws(
    () => findPoisonedTlDirectReceipts("/tmp/rmoa-notes-does-not-exist-xyz", "demo-change"),
    (err) => err?.code === "notes-root-missing",
  );
});

test("evaluatePreflight fails closed when --notes-root path is missing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rmoa-notes-missing-"));
  try {
    const change = "fix-resolved-main-origin-authority";
    const changeDir = path.join(root, "openspec/changes", change);
    mkdirSync(changeDir, { recursive: true });
    mkdirSync(path.join(root, "notes"), { recursive: true });
    writeFileSync(
      path.join(changeDir, "proposal.md"),
      "---\nrisk_classes: [none]\n---\n\n## Section 2: Touch\n\n| 檔案 | 類別 | 動作 | Requirement |\n|---|---|---|---|\n| `a.mjs` | code | modify | R1 |\n\n## Next\n",
    );
    writeQa(changeDir);
    writeFileSync(
      path.join(root, "notes", `qa-regression-head-${change}.json`),
      JSON.stringify({ change, head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }) + "\n",
    );
    const result = evaluatePreflight({
      cwd: root,
      change,
      notesRoot: path.join(root, "notes-does-not-exist"),
      frozenOriginMain: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      nowOriginMain: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      gitOps: (_cwd, args) => {
        if (args[0] === "rev-parse") return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        if (args[0] === "fetch") return "";
        if (args[0] === "show-ref") return "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        if (args[0] === "status") return "";
        if (args[0] === "diff") {
          assert.equal(args[2], "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb...aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
          return "a.mjs";
        }
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "notes-root-missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evaluatePreflight Touch⊇diff uses verified originMain SHA range (not bare origin/main)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rmoa-touch-sha-"));
  try {
    const change = "fix-resolved-main-origin-authority";
    const changeDir = path.join(root, "openspec/changes", change);
    mkdirSync(changeDir, { recursive: true });
    mkdirSync(path.join(root, "notes"), { recursive: true });
    writeFileSync(
      path.join(changeDir, "proposal.md"),
      "---\nrisk_classes: [none]\n---\n\n## Section 2: Touch\n\n| 檔案 | 類別 | 動作 | Requirement |\n|---|---|---|---|\n| `a.mjs` | code | modify | R1 |\n\n## Next\n",
    );
    writeQa(changeDir);
    writeFileSync(
      path.join(root, "notes", `qa-regression-head-${change}.json`),
      JSON.stringify({ change, head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }) + "\n",
    );
    let seenDiffRange = null;
    const result = evaluatePreflight({
      cwd: root,
      change,
      notesRoot: path.join(root, "notes"),
      frozenOriginMain: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      nowOriginMain: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      gitOps: (_cwd, args) => {
        if (args[0] === "rev-parse") return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        if (args[0] === "fetch") return "";
        if (args[0] === "show-ref") return "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        if (args[0] === "status") return "";
        if (args[0] === "diff") {
          seenDiffRange = args[2];
          return "a.mjs";
        }
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
    });
    assert.equal(result.ok, true);
    assert.equal(
      seenDiffRange,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb...aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    assert.doesNotMatch(seenDiffRange, /origin\/main/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evaluatePreflight scans all candidate notes roots for poisoned tl-direct", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rmoa-multi-notes-"));
  try {
    const change = "fix-resolved-main-origin-authority";
    const work = path.join(root, "work");
    const changeDir = path.join(work, "openspec/changes", change);
    mkdirSync(changeDir, { recursive: true });
    const notesWork = path.join(work, "notes");
    const notesParent = path.join(root, "notes"); // candidate #2 relative to cwd=work
    mkdirSync(notesWork, { recursive: true });
    mkdirSync(notesParent, { recursive: true });
    writeFileSync(
      path.join(changeDir, "proposal.md"),
      "---\nrisk_classes: [none]\n---\n\n## Section 2: Touch\n\n| 檔案 | 類別 | 動作 | Requirement |\n|---|---|---|---|\n| `a.mjs` | code | modify | R1 |\n\n## Next\n",
    );
    writeQa(changeDir);
    writeFileSync(
      path.join(notesWork, `qa-regression-head-${change}.json`),
      JSON.stringify({ change, head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }) + "\n",
    );
    // Poison only in parent notes candidate (second candidate when cwd=work).
    writeFileSync(
      path.join(notesParent, `review-${change}-receipt-r9-deadbeef.json`),
      JSON.stringify({ executor_attribution: "tl-direct" }),
    );
    const result = evaluatePreflight({
      cwd: work,
      change,
      notesRoot: null,
      frozenOriginMain: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      nowOriginMain: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      gitOps: (_cwd, args) => {
        if (args[0] === "rev-parse") return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        if (args[0] === "fetch") return "";
        if (args[0] === "show-ref") return "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        if (args[0] === "status") return "";
        if (args[0] === "diff") return "a.mjs";
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "poisoned-tl-direct-unquarantined");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeQa(changeDir, smokeHead = "aaaaaaa") {
  writeFileSync(
    path.join(changeDir, "qa-test-scope.md"),
    [
      "### 1) a",
      "body1",
      "### 2) b",
      "body2",
      "### 3) c",
      "body3",
      "### 4) d",
      "body4",
      "### 5) e",
      "body5",
      "### 6) f",
      "body6",
      "### UI smoke",
      "- ui smoke: N/A+no UI",
      `- ui smoke head: ${smokeHead}`,
      "",
    ].join("\n"),
  );
}

test("evaluatePreflight fails closed with touch-incomplete when Touch omits a diff path", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rmoa-preflight-"));
  try {
    const change = "fix-resolved-main-origin-authority";
    const changeDir = path.join(root, "openspec/changes", change);
    mkdirSync(changeDir, { recursive: true });
    mkdirSync(path.join(root, "notes"), { recursive: true });
    writeFileSync(
      path.join(changeDir, "proposal.md"),
      [
        "---",
        "risk_classes: [state/invariant]",
        "---",
        "",
        "## Section 2: Touch",
        "",
        "| 檔案 | 類別 | 動作 | Requirement |",
        "|---|---|---|---|",
        "| `.devpro/scripts/lib/review-remediation-evidence-core.mjs` | code | modify | R1 |",
        "",
        "## Section 3: Tasks",
        "",
      ].join("\n"),
    );
    writeQa(changeDir);
    writeFileSync(
      path.join(root, "notes", `qa-regression-head-${change}.json`),
      JSON.stringify({ change, head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }) + "\n",
    );
    const result = evaluatePreflight({
      cwd: root,
      change,
      notesRoot: path.join(root, "notes"),
      frozenOriginMain: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      nowOriginMain: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      gitOps: (_cwd, args) => {
        if (args[0] === "rev-parse") return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        if (args[0] === "fetch") return "";
        if (args[0] === "show-ref") return "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        if (args[0] === "status") return "";
        if (args[0] === "diff") {
          return [
            ".devpro/scripts/lib/review-remediation-evidence-core.mjs",
            ".devpro/scripts/evil-new.mjs",
          ].join("\n");
        }
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "touch-incomplete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evaluatePreflight fails when frozen origin/main advanced", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rmoa-tip-"));
  try {
    const change = "fix-resolved-main-origin-authority";
    const changeDir = path.join(root, "openspec/changes", change);
    mkdirSync(changeDir, { recursive: true });
    mkdirSync(path.join(root, "notes"), { recursive: true });
    writeFileSync(
      path.join(changeDir, "proposal.md"),
      "---\nrisk_classes: [none]\n---\n\n## Section 2: Touch\n\n| 檔案 | 類別 | 動作 | Requirement |\n|---|---|---|---|\n| `a.mjs` | code | modify | R1 |\n\n## Next\n",
    );
    writeQa(changeDir);
    writeFileSync(
      path.join(root, "notes", `qa-regression-head-${change}.json`),
      JSON.stringify({ change, head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }) + "\n",
    );
    const result = evaluatePreflight({
      cwd: root,
      change,
      notesRoot: path.join(root, "notes"),
      frozenOriginMain: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      nowOriginMain: "cccccccccccccccccccccccccccccccccccccccc",
      gitOps: (_cwd, args) => {
        if (args[0] === "rev-parse") return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        if (args[0] === "fetch") return "";
        if (args[0] === "show-ref") return "cccccccccccccccccccccccccccccccccccccccc";
        if (args[0] === "status") return "";
        if (args[0] === "merge-base") return "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        // Gate B: main tip delta intersects Touch/branch-diff on a.mjs.
        if (args[0] === "diff" && args.includes("--name-status")) {
          const range = args.find((a) => a.includes(".."));
          if (range && range.startsWith("bbbbbbbb")) return "M\ta.mjs\n";
          if (range && range.includes("aaaaaaaa")) return "M\ta.mjs\n";
          return "M\ta.mjs\n";
        }
        if (args[0] === "diff") return "a.mjs";
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "origin-main-advanced");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D7-3 tip advanced + empty intersect is update-freeze-only (not rebase hard-block)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rmoa-tip-a-not-b-"));
  try {
    const change = "fix-resolved-main-origin-authority";
    const changeDir = path.join(root, "openspec/changes", change);
    mkdirSync(changeDir, { recursive: true });
    mkdirSync(path.join(root, "notes"), { recursive: true });
    writeFileSync(
      path.join(changeDir, "proposal.md"),
      "---\nrisk_classes: [none]\n---\n\n## Section 2: Touch\n\n| 檔案 | 類別 | 動作 | Requirement |\n|---|---|---|---|\n| `a.mjs` | code | modify | R1 |\n\n## Next\n",
    );
    writeQa(changeDir);
    writeFileSync(
      path.join(root, "notes", `qa-regression-head-${change}.json`),
      JSON.stringify({ change, head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }) + "\n",
    );
    const frozen = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const originMain = "cccccccccccccccccccccccccccccccccccccccc";
    const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const result = evaluatePreflight({
      cwd: root,
      change,
      notesRoot: path.join(root, "notes"),
      frozenOriginMain: frozen,
      nowOriginMain: originMain,
      gitOps: (_cwd, args) => {
        if (args[0] === "rev-parse") return head;
        if (args[0] === "fetch") return "";
        if (args[0] === "show-ref") return originMain;
        if (args[0] === "status") return "";
        if (args[0] === "merge-base") return frozen;
        if (args[0] === "diff" && args.includes("--name-status")) {
          const range = args.find((a) => typeof a === "string" && a.includes(".."));
          // freeze..new-tip: unrelated docs on main; branch range: our Touch file only.
          if (range === `${frozen}..${originMain}`) return "M\tdocs/unrelated.md\n";
          if (range === `${frozen}..${head}` || range?.endsWith(`..${head}`)) return "M\ta.mjs\n";
          return "M\ta.mjs\n";
        }
        if (args[0] === "diff") return "a.mjs";
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
    });
    assert.notEqual(result.code, "origin-main-advanced");
    assert.equal(result.ok, true);
    const tipFreeze = result.checks.find((c) => c.id === "tip-freeze-match");
    assert.ok(tipFreeze);
    assert.equal(tipFreeze.ok, true);
    assert.equal(tipFreeze.update_freeze_only, true);
    assert.equal(tipFreeze.recommended_frozen_origin_main, originMain);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D7-4 tip advanced + intersect still origin-main-advanced", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rmoa-tip-a-and-b-"));
  try {
    const change = "fix-resolved-main-origin-authority";
    const changeDir = path.join(root, "openspec/changes", change);
    mkdirSync(changeDir, { recursive: true });
    mkdirSync(path.join(root, "notes"), { recursive: true });
    writeFileSync(
      path.join(changeDir, "proposal.md"),
      "---\nrisk_classes: [none]\n---\n\n## Section 2: Touch\n\n| 檔案 | 類別 | 動作 | Requirement |\n|---|---|---|---|\n| `a.mjs` | code | modify | R1 |\n\n## Next\n",
    );
    writeQa(changeDir);
    writeFileSync(
      path.join(root, "notes", `qa-regression-head-${change}.json`),
      JSON.stringify({ change, head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }) + "\n",
    );
    const frozen = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const originMain = "cccccccccccccccccccccccccccccccccccccccc";
    const result = evaluatePreflight({
      cwd: root,
      change,
      notesRoot: path.join(root, "notes"),
      frozenOriginMain: frozen,
      nowOriginMain: originMain,
      gitOps: (_cwd, args) => {
        if (args[0] === "rev-parse") return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        if (args[0] === "fetch") return "";
        if (args[0] === "show-ref") return originMain;
        if (args[0] === "status") return "";
        if (args[0] === "merge-base") return frozen;
        if (args[0] === "diff" && args.includes("--name-status")) {
          return "M\ta.mjs\n";
        }
        if (args[0] === "diff") return "a.mjs";
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "origin-main-advanced");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D7-5 Gate B rename-aware: main renames Touch source into docs/ still intersects", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rmoa-tip-rename-b-"));
  try {
    const change = "fix-resolved-main-origin-authority";
    const changeDir = path.join(root, "openspec/changes", change);
    mkdirSync(changeDir, { recursive: true });
    mkdirSync(path.join(root, "notes"), { recursive: true });
    writeFileSync(
      path.join(changeDir, "proposal.md"),
      "---\nrisk_classes: [none]\n---\n\n## Section 2: Touch\n\n| 檔案 | 類別 | 動作 | Requirement |\n|---|---|---|---|\n| `.devpro/scripts/task.mjs` | code | modify | R1 |\n\n## Next\n",
    );
    writeQa(changeDir);
    writeFileSync(
      path.join(root, "notes", `qa-regression-head-${change}.json`),
      JSON.stringify({ change, head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }) + "\n",
    );
    const frozen = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const originMain = "cccccccccccccccccccccccccccccccccccccccc";
    const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const result = evaluatePreflight({
      cwd: root,
      change,
      notesRoot: path.join(root, "notes"),
      frozenOriginMain: frozen,
      nowOriginMain: originMain,
      gitOps: (_cwd, args) => {
        if (args[0] === "rev-parse") return head;
        if (args[0] === "fetch") return "";
        if (args[0] === "show-ref") return originMain;
        if (args[0] === "status") return "";
        if (args[0] === "merge-base") return frozen;
        if (args[0] === "diff" && args.includes("--name-status")) {
          const range = args.find((a) => typeof a === "string" && a.includes(".."));
          // Destination-only name-only would miss Touch; rename-aware must keep source.
          if (range === `${frozen}..${originMain}`) {
            return "R100\t.devpro/scripts/task.mjs\tdocs/task.md\n";
          }
          if (range?.endsWith(`..${head}`)) return "M\t.devpro/scripts/task.mjs\n";
          return "M\t.devpro/scripts/task.mjs\n";
        }
        if (args[0] === "diff") return ".devpro/scripts/task.mjs";
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "origin-main-advanced");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evaluatePreflight requires --frozen-origin-main", () => {
  const result = evaluatePreflight({
    cwd: "/tmp/unused",
    change: "fix-resolved-main-origin-authority",
    frozenOriginMain: null,
    nowOriginMain: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    gitOps: (_cwd, args) => {
      if (args[0] === "rev-parse") return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      if (args[0] === "fetch") return "";
      if (args[0] === "show-ref") return "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      if (args[0] === "status") return "";
      throw new Error("stop");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "frozen-origin-main-required");
});

// #2623 / D2 / F5 — real-git evaluatePreflight coverage for R6 bookkeeping tip-move.
// Unit coverage already exists in regression-head-record.test.mjs; this binds the
// operator entry. fetch is no-op'd because origin/main is pre-seeded via update-ref;
// all other gitOps + currency spawnSync use the same fixture cwd (not host).
const OPERATOR_REAL_GIT_CHANGE = "fix-evidence-archive-batch";

function isolatedOperatorGitRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "rmoa-realgit-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (args) => {
    const r = spawnSync(
      "git",
      ["-C", dir, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
      { encoding: "utf8", env },
    );
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr || r.stdout}`);
    return r.stdout.trim();
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "user.name", "Fixture"]);
  writeFileSync(path.join(dir, "README.md"), "fixture\n");
  writeFileSync(path.join(dir, ".gitignore"), "notes/\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "baseline"]);
  const originMain = git(["rev-parse", "HEAD"]);
  git(["update-ref", "refs/remotes/origin/main", originMain]);

  const changeDir = path.join(dir, "openspec/changes", OPERATOR_REAL_GIT_CHANGE);
  mkdirSync(changeDir, { recursive: true });
  writeFileSync(
    path.join(changeDir, "proposal.md"),
    [
      "---",
      "risk_classes: [none]",
      "---",
      "",
      "## Section 2: Touch",
      "",
      "| 檔案 | 類別 | 動作 | Requirement |",
      "|---|---|---|---|",
      "| `openspec/changes/fix-evidence-archive-batch/` | docs | modify | R3 |",
      "",
      "## Next",
      "",
    ].join("\n"),
  );
  git(["add", "."]);
  git(["commit", "-q", "-m", "seed proposal"]);
  // ui smoke head must be a <sha> on the branch (strictly after the branch base); qa-test-scope.md
  // cannot embed its own commit, so it points at the proposal commit (ancestor-of-tip currency).
  const smokeHead = git(["rev-parse", "HEAD"]);
  writeQa(changeDir, smokeHead);
  git(["add", "."]);
  git(["commit", "-q", "-m", "seed qa"]);
  const tested = git(["rev-parse", "HEAD"]);
  const written = writeRegressionHeadRecord({
    cwd: dir,
    change: OPERATOR_REAL_GIT_CHANGE,
    headSha: tested,
    branch: "main",
      suiteEvidence: PASS_SUITE_EVIDENCE,
    });
  assert.equal(written.status, "written");

  // Thin wrapper: only fetch is no-op (no network remote); every other call is
  // real git against `dir`. Currency still uses production spawnSync(-C cwd).
  const gitOps = (cwd, args) => {
    assert.equal(cwd, dir, "gitOps cwd must bind the fixture, not the host checkout");
    if (args[0] === "fetch") return "";
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...env,
        // Match isolated repo: ignore host hooks/signing when execFileSync is used.
      },
    }).trim();
  };

  return { dir, git, gitOps, originMain, tested, changeDir, env, smokeHead };
}

test("evaluatePreflight real-git bookkeeping tip-move keeps currency (coverage-add if already green on unit path)", () => {
  const { dir, git, gitOps, originMain, tested, changeDir, smokeHead } = isolatedOperatorGitRepo();
  try {
    writeFileSync(
      path.join(changeDir, "qa-test-scope.md"),
      [
        "### 1) a",
        "bookkeeping tip-move body",
        "### 2) b",
        "body2",
        "### 3) c",
        "body3",
        "### 4) d",
        "body4",
        "### 5) e",
        "body5",
        "### 6) f",
        "body6",
        "### UI smoke",
        "- ui smoke: N/A+no UI",
        `- ui smoke head: ${smokeHead}`,
        "",
      ].join("\n"),
    );
    git(["add", `openspec/changes/${OPERATOR_REAL_GIT_CHANGE}/qa-test-scope.md`]);
    git(["commit", "-q", "-m", "change-folder bookkeeping tip-move"]);
    const tip = git(["rev-parse", "HEAD"]);
    assert.notEqual(tested, tip);

    const result = evaluatePreflight({
      cwd: dir,
      change: OPERATOR_REAL_GIT_CHANGE,
      frozenOriginMain: originMain,
      nowOriginMain: originMain,
      notesRoot: path.join(dir, "notes"),
      gitOps,
    });
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    const currency = result.checks.find((c) => c.id === "regression-head-currency");
    assert.equal(currency?.ok, true);
    assert.equal(currency?.kind, "current-bookkeeping-tip-move");
    const read = readRegressionHeadRecord({ cwd: dir, change: OPERATOR_REAL_GIT_CHANGE });
    assert.equal(read.record.head_sha, tested);
    // Honest label: unit path already covered tip-move; this is operator coverage-add.
    assert.equal(typeof currency.kind, "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluatePreflight real-git non-bookkeeping scripts tip stays stale", () => {
  const { dir, git, gitOps, originMain, tested } = isolatedOperatorGitRepo();
  try {
    mkdirSync(path.join(dir, ".devpro/scripts"), { recursive: true });
    writeFileSync(path.join(dir, ".devpro/scripts/lib-helper.mjs"), "export const x = 1;\n");
    // Touch must cover the scripts path or preflight stops at touch-incomplete
    // before currency — mirror production Touch⊇diff then prove currency stale.
    writeFileSync(
      path.join(dir, "openspec/changes", OPERATOR_REAL_GIT_CHANGE, "proposal.md"),
      [
        "---",
        "risk_classes: [none]",
        "---",
        "",
        "## Section 2: Touch",
        "",
        "| 檔案 | 類別 | 動作 | Requirement |",
        "|---|---|---|---|",
        "| `.devpro/scripts/lib-helper.mjs` | code | modify | R4 |",
        "",
        "## Next",
        "",
      ].join("\n"),
    );
    git(["add", ".devpro/scripts/lib-helper.mjs", `openspec/changes/${OPERATOR_REAL_GIT_CHANGE}/proposal.md`]);
    git(["commit", "-q", "-m", "scripts delta"]);
    const tip = git(["rev-parse", "HEAD"]);
    assert.notEqual(tested, tip);

    const result = evaluatePreflight({
      cwd: dir,
      change: OPERATOR_REAL_GIT_CHANGE,
      frozenOriginMain: originMain,
      nowOriginMain: originMain,
      notesRoot: path.join(dir, "notes"),
      gitOps,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "regression-head-stale");
    const currency = result.checks.find((c) => c.id === "regression-head-currency");
    assert.equal(currency?.ok, false);
    assert.equal(currency?.kind, "stale");
    assert.equal(currency?.tested, tested);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
