/**
 * enforce-scenario-merge-gate-path-consistency.test.mjs
 *
 * Mechanical guard for a C8-class bug: scenario-s-cross-model-reviewer.md's
 * merge-gate decision matrix labels each row with a `verdict`, a `路徑` (Path
 * A–F/U), and a `結果` (pass/block). These MUST stay consistent with the
 * canonical verdict→path→outcome mapping defined in code-review-cross-model.md
 * §Merge Gate Enforcement and enforced by pre-tool-gate.mjs::checkCrossModelMergeGate.
 *
 * Background: scenario-s C8 had silently mislabelled `verdict: UNAVAILABLE` as
 * `路徑 F → pass` for months; canonical + the hook both say Path U → block.
 * No mechanical guard locked the scenario's path/outcome to the verdict, so a
 * human walkthrough was the only thing that caught it. This guard closes that
 * gap: any verdict-bearing matrix row whose path/outcome diverges from the
 * canonical mapping fails the suite.
 *
 * Style reference: enforce-load-efficiency-self-check-grep.test.mjs
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const scenario = readFileSync(
  repoPath("scenarios/scenario-s-cross-model-reviewer.md"),
  "utf8"
);
const checklist = readFileSync(
  repoPath(".devpro/agent-rules/code-review-cross-model.md"),
  "utf8"
);

// Canonical verdict → { path, outcome } mapping (SSOT: code-review-cross-model.md
// §Merge Gate Enforcement, mirrored by pre-tool-gate.mjs). `outcome` is "pass"
// or "block". Only rows whose verdict matches one of these keys are checked;
// exemption / no-sticky / stale / parse-fail rows use other discriminators and
// are validated by their own keyword (see PATH_OUTCOME below).
const VERDICT_PATH = {
  PASS: { path: "F", outcome: "pass" },
  WARN: { path: "F", outcome: "pass" },
  CRITICAL: { path: "E", outcome: "block" },
  UNAVAILABLE: { path: "U", outcome: "block" },
};

// Path → expected outcome (independent of verdict), for self-consistency:
// every Path letter has a fixed pass/block polarity in the canonical gate.
const PATH_OUTCOME = {
  A: "pass",
  B: "block",
  C: "block",
  D: "block",
  E: "block",
  F: "pass",
  U: "block",
};

function parseMatrixRows() {
  const rows = [];
  for (const line of scenario.split("\n")) {
    const m = line.match(/^\|\s*(C\d+\w*)\s*\|(.+)\|\s*$/);
    if (!m) continue;
    const cells = m[2].split("|").map((c) => c.trim());
    // header layout: 豁免命中 | sticky | verdict | SHA | 豁免類型 | 路徑 | 結果
    // (id already stripped). So exempt=cells[0], sticky=cells[1],
    // verdict=cells[2], sha=cells[3], 路徑=cells[5], 結果=cells[6].
    if (cells.length < 7) continue;
    rows.push({
      id: m[1],
      exempt: cells[0],
      sticky: cells[1],
      verdict: cells[2],
      sha: cells[3],
      path: cells[5],
      outcome: cells[6],
    });
  }
  return rows;
}

// A row's path/outcome is determined by `verdict` ONLY when no higher-priority
// discriminator overrides it: not exempt (Path A), sticky present, SHA aligned
// (a stale SHA forces Path D regardless of verdict — see C7), and the row is not
// a degraded/meta row (verdict reads "依六軸" / path reads "視 verdict").
function verdictIsSoleDeterminant(r) {
  const yes = (c) => c === "是";
  const dash = (c) => c === "—" || c === "";
  if (yes(r.exempt)) return false; // exemption → Path A, not verdict-driven
  if (!yes(r.sticky)) return false; // no sticky → Path B
  if (!(yes(r.sha) || dash(r.sha))) return false; // stale → Path D
  if (/視|依|降級/.test(r.path + r.verdict + r.outcome)) return false; // meta row
  if (!Object.prototype.hasOwnProperty.call(VERDICT_PATH, r.verdict)) return false;
  return true;
}

test("scenario-s merge-gate matrix parses (sanity: ≥ 8 rows incl. C8)", () => {
  const rows = parseMatrixRows();
  assert.ok(rows.length >= 8, `expected ≥8 matrix rows, got ${rows.length}`);
  assert.ok(rows.some((r) => r.id === "C8"), "C8 row must be present");
});

test("every verdict-bearing row matches canonical verdict→path→outcome", () => {
  const rows = parseMatrixRows();
  const failures = [];
  for (const r of rows) {
    if (!verdictIsSoleDeterminant(r)) continue; // higher-priority discriminator
    const expect = VERDICT_PATH[r.verdict];
    // path cell may read "U" or "A 變體" etc. — take the leading path letter.
    const pathLetter = (r.path.match(/^[A-FU]/) || [])[0];
    if (pathLetter !== expect.path) {
      failures.push(
        `${r.id}: verdict ${r.verdict} → path 應為 ${expect.path}，實為 "${r.path}"`
      );
    }
    const outcomeIsBlock = /block|擋/.test(r.outcome);
    const outcomeIsPass = /pass|放行/.test(r.outcome);
    const want = expect.outcome === "block";
    if (want ? !outcomeIsBlock || outcomeIsPass : !outcomeIsPass || outcomeIsBlock) {
      failures.push(
        `${r.id}: verdict ${r.verdict} → 結果 應為 ${expect.outcome}，實為 "${r.outcome}"`
      );
    }
  }
  assert.equal(
    failures.length,
    0,
    `scenario-s 路徑/結果 與 canonical verdict 映射不一致:\n  ${failures.join("\n  ")}`
  );
});

test("every Path letter's outcome polarity is self-consistent", () => {
  const rows = parseMatrixRows();
  const failures = [];
  for (const r of rows) {
    // Skip degraded/meta rows whose outcome is not a plain pass/block
    // (e.g. C10 "sticky 標降級", path "A-F 視 verdict").
    if (/視|依|降級/.test(r.path + r.outcome)) continue;
    const pathLetter = (r.path.match(/^[A-FU]/) || [])[0];
    const expect = PATH_OUTCOME[pathLetter];
    if (!expect) continue; // "A 變體" leads with A → handled; unknown → skip
    const outcomeIsBlock = /block|擋/.test(r.outcome);
    const outcomeIsPass = /pass|放行/.test(r.outcome);
    if (expect === "block" ? !outcomeIsBlock : !outcomeIsPass) {
      failures.push(
        `${r.id}: path ${pathLetter} → 結果 應為 ${expect}，實為 "${r.outcome}"`
      );
    }
  }
  assert.equal(
    failures.length,
    0,
    `scenario-s 路徑→結果 polarity 不一致:\n  ${failures.join("\n  ")}`
  );
});

test("canonical checklist still defines Path U = UNAVAILABLE → block (SSOT anchor)", () => {
  // If the canonical mapping changes, this guard's VERDICT_PATH must be updated
  // in lockstep — assert the SSOT anchor exists so silent canonical drift trips.
  // Single-line anchor only: the canonical mapping line is `**Path U**：
  // `verdict: UNAVAILABLE` → block …`. A cross-段 `[\s\S]*?` alternative would
  // false-match unrelated Fallback prose ("verdict: UNAVAILABLE" … later
  // "block") and let the mapping line be deleted silently — defeating the
  // backstop. Lock to one line so deleting the Path U mapping actually trips.
  assert.ok(
    /Path U[^\n]*UNAVAILABLE[^\n]*block/.test(checklist),
    "code-review-cross-model.md §Merge Gate 必須仍以單行定義 Path U = UNAVAILABLE → block；若 canonical 改了，請同步本 guard 的 VERDICT_PATH"
  );
});
