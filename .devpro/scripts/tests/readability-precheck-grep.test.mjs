import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Structural-existence anchor lock (per rule-anchor-guard-strength.md 二分守則):
// every anchor below is a heading/label/cross-ref whose PRESENCE (not
// polarity) is load-bearing — reversal is meaningless for these strings, so
// direct `includes()` is sufficient per that leaf's guidance and no
// same-line compound regex is required. Each anchor string is verified
// unique to exactly one line in its file, and a mutation audit confirms
// removing that specific line (and only that line) flips the check red —
// converging per rule-anchor-guard-strength.md §驗證方法：mutation 審計.

const rulesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../agent-rules'
);

const tokenBudgetPrecheckPath = path.join(rulesDir, 'token-budget-precheck.md');
const tokenFrugalIoPath = path.join(rulesDir, 'token-frugal-io.md');

/** Anchors locked in token-budget-precheck.md — actual-carrier cooperative
 * readability review, cap governance, and the machine/non-machine verdict
 * boundary. Each `str` is asserted unique to one line of the file. */
const TOKEN_BUDGET_PRECHECK_ANCHORS = [
  {
    name: 'agents-hard-cap',
    str: '10500 byte（HARD cap；SOFT cap 6500）',
  },
  {
    name: 'load-bearing-over-compression',
    str: 'load-bearing 的 clarity > raw compression',
  },
  {
    name: 'minimum-cap-formula',
    str: '**最小必要 CAP 公式（SSOT）**',
  },
  {
    name: 'override-last-resort',
    str: '`cap/tier override` 才是 last resort',
  },
  {
    name: 'actual-carrier-cooperative-review',
    str: '**Actual-carrier cooperative readability review**',
  },
  {
    name: 'semantic-review-required',
    str: '`semanticReview=required`，review actual carrier',
  },
  {
    name: 'machine-verdict-boundary',
    str: 'Machine tooling MUST NOT produce semantic PASS/FAIL',
  },
  {
    name: 'no-manual-artifact',
    str: '不把答案抄進 proposal/manual artifact',
  },
];

/** Anchors locked in token-frugal-io.md — the cooperative-vs-mechanical
 * distinction and its cross-ref to token-budget-precheck.md (T3/D6). */
const TOKEN_FRUGAL_IO_ANCHORS = [
  {
    name: 'cooperative-label',
    str: '此為每次適用之 cooperative 紀律',
  },
  {
    name: 'mechanical-backstop-cross-ref',
    str: '另訂 ≥80% 機械 backstop，附加不取代',
  },
  {
    name: 'cap-mitigation-cross-ref',
    str: '調整最小必要 cap（mitigation 見 `token-budget-precheck.md`）',
  },
];

/** Split file body into lines (keep line-index alignment simple/consistent
 * with how the mutation audit reconstructs mutated content). */
function toLines(body) {
  return body.split('\n');
}

/**
 * For each anchor, assert:
 *  1. The anchor string occurs in the real file content (sanity/base case).
 *  2. Exactly one line contains it (uniqueness — required so the mutation
 *     step below tests a single, unambiguous operative line).
 *  3. Removing that line (and only that line) flips the anchor's presence
 *     check to false; removing any OTHER single line leaves it true (no
 *     other line supplies the same token — no compensatory anchor decay).
 */
function runAnchorLockSuite(label, filePath, anchors) {
  test(`${label}: anchors present in real file (base case)`, () => {
    const body = readFileSync(filePath, 'utf8');
    for (const { name, str } of anchors) {
      assert.ok(body.includes(str), `expected anchor "${name}" (${JSON.stringify(str)}) to be present`);
    }
  });

  test(`${label}: each anchor is unique to exactly one line`, () => {
    const body = readFileSync(filePath, 'utf8');
    const lines = toLines(body);
    for (const { name, str } of anchors) {
      const hitLines = lines.filter((l) => l.includes(str));
      assert.equal(
        hitLines.length, 1,
        `expected anchor "${name}" (${JSON.stringify(str)}) to occur on exactly 1 line, found ${hitLines.length}`
      );
    }
  });

  test(`${label}: mutation audit — deleting an anchor's own line flips it red; deleting any other line does not`, () => {
    const body = readFileSync(filePath, 'utf8');
    const lines = toLines(body);

    for (const { name, str } of anchors) {
      const ownLineIdx = lines.findIndex((l) => l.includes(str));
      assert.notEqual(ownLineIdx, -1, `anchor "${name}" not found on any line`);

      // Deleting the anchor's own line MUST flip the check to false.
      const withOwnLineRemoved = lines.filter((_, i) => i !== ownLineIdx).join('\n');
      assert.equal(
        withOwnLineRemoved.includes(str), false,
        `expected anchor "${name}" to be absent after removing its own line, but it was still found (compensated by another line)`
      );
    }

    // Deleting any OTHER single line must not remove any anchor's presence
    // (no anchor is accidentally supplied/duplicated by an unrelated line).
    for (let i = 0; i < lines.length; i++) {
      const mutated = lines.filter((_, idx) => idx !== i).join('\n');
      for (const { name, str } of anchors) {
        const ownLineIdx = lines.findIndex((l) => l.includes(str));
        if (i === ownLineIdx) continue; // already covered above
        assert.ok(
          mutated.includes(str),
          `removing unrelated line ${i} unexpectedly removed anchor "${name}" — anchor is not uniquely tied to its own line`
        );
      }
    }
  });
}

runAnchorLockSuite('token-budget-precheck.md', tokenBudgetPrecheckPath, TOKEN_BUDGET_PRECHECK_ANCHORS);
runAnchorLockSuite('token-frugal-io.md', tokenFrugalIoPath, TOKEN_FRUGAL_IO_ANCHORS);
