/**
 * proposal-change-path.test.mjs
 *
 * Unit table for `lib/proposal-change-path.mjs` (#3333): the broad "is this a proposal
 * path" question and the strict "which change owns it" question the chore-A exemption and
 * the sticky handoff builder share.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  changeNameFromProposalPath,
  isProposalPath,
} from "../lib/proposal-change-path.mjs";

const PROPOSAL_CASES = [
  ["active proposal.md", "openspec/changes/foo/proposal.md", true, "foo"],
  ["active proposal-mini.md", "openspec/changes/foo/proposal-mini.md", true, "foo"],
  ["dated archive proposal.md", "openspec/changes/archive/2026-10-20-foo/proposal.md", true, "foo"],
  ["dated archive proposal-mini.md", "openspec/changes/archive/2026-10-20-foo/proposal-mini.md", true, "foo"],
  // Broad shape matches, but the owning change cannot be recovered -> name null.
  ["undated archive folder", "openspec/changes/archive/foo/proposal.md", true, null],
  ["malformed archive date", "openspec/changes/archive/2026-1-2-foo/proposal.md", true, null],
  // Not proposal paths at all.
  ["tasks.md", "openspec/changes/foo/tasks.md", false, null],
  ["lite-scope.md", "openspec/changes/foo/lite-scope.md", false, null],
  ["nested deeper than a change folder", "openspec/changes/foo/specs/proposal.md", false, null],
  ["proposal in another tree", "docs/proposal.md", false, null],
  ["proposal.md.bak", "openspec/changes/foo/proposal.md.bak", false, null],
  ["proposal-other.md", "openspec/changes/foo/proposal-other.md", false, null],
  ["canonical spec", "openspec/specs/foo/spec.md", false, null],
];

for (const [label, filePath, isProposal, changeName] of PROPOSAL_CASES) {
  test(`PCP: ${label} -> isProposalPath=${isProposal}, changeName=${changeName}`, () => {
    assert.equal(isProposalPath(filePath), isProposal);
    assert.equal(changeNameFromProposalPath(filePath), changeName);
  });
}

test("PCP: a change name is only reported for a path isProposalPath accepts", () => {
  for (const [, filePath] of PROPOSAL_CASES) {
    if (changeNameFromProposalPath(filePath) !== null) {
      assert.equal(isProposalPath(filePath), true, filePath);
    }
  }
});

test("PCP: non-string input is neither a proposal path nor owned by a change", () => {
  for (const value of [undefined, null, 42, {}, []]) {
    assert.equal(isProposalPath(value), false);
    assert.equal(changeNameFromProposalPath(value), null);
  }
});
