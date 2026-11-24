/**
 * changed-file-status.test.mjs
 *
 * Unit tables for `lib/changed-file-status.mjs` (#3333): status normalization across
 * GitHub REST, GitHub GraphQL and `git diff --name-status`, the `-z` parser, and the
 * `(files, statuses)` shaping the chore-A exemption consumes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHANGE_STATUS,
  normalizeChangeStatus,
  parseGitNameStatusZ,
  toExemptionInput,
} from "../lib/changed-file-status.mjs";

const NORMALIZE_CASES = [
  // GitHub REST
  ["modified", "modified"],
  ["added", "added"],
  ["removed", "removed"],
  ["renamed", "renamed"],
  ["copied", "copied"],
  ["changed", "changed"],
  ["unchanged", "unknown"],
  // GitHub GraphQL changeType
  ["MODIFIED", "modified"],
  ["ADDED", "added"],
  ["DELETED", "removed"],
  ["RENAMED", "renamed"],
  ["COPIED", "copied"],
  ["CHANGED", "changed"],
  // git name-status
  ["M", "modified"],
  ["A", "added"],
  ["D", "removed"],
  ["R100", "renamed"],
  ["R087", "renamed"],
  ["C75", "copied"],
  ["T", "changed"],
  // fail-closed spellings
  ["U", "unknown"],
  ["X", "unknown"],
  ["", "unknown"],
  ["M2x", "unknown"],
  ["modified-ish", "unknown"],
  [undefined, "unknown"],
  [null, "unknown"],
  [7, "unknown"],
];

for (const [raw, expected] of NORMALIZE_CASES) {
  test(`CFS: normalizeChangeStatus(${JSON.stringify(raw)}) -> ${expected}`, () => {
    assert.equal(normalizeChangeStatus(raw), expected);
  });
}

test("CFS: only the three spellings of an in-place edit normalize to modified", () => {
  const modified = NORMALIZE_CASES.filter(([, expected]) => expected === CHANGE_STATUS.MODIFIED);
  assert.deepEqual(modified.map(([raw]) => raw), ["modified", "MODIFIED", "M"]);
});

test("CFS: normalizeChangeStatus is idempotent on its own output", () => {
  for (const value of Object.values(CHANGE_STATUS)) {
    assert.equal(normalizeChangeStatus(value), value);
  }
});

test("CFS: parseGitNameStatusZ reads plain, rename and copy records", () => {
  const text = [
    "M", "a/one.md",
    "A", "two.md",
    "D", "gone.md",
    "R100", "old/name.md", "new/name.md",
    "C75", "src.md", "dup.md",
    "T", "mode.sh",
  ].join("\0") + "\0";
  assert.deepEqual(parseGitNameStatusZ(text), [
    { status: "modified", path: "a/one.md", previousPath: null },
    { status: "added", path: "two.md", previousPath: null },
    { status: "removed", path: "gone.md", previousPath: null },
    { status: "renamed", path: "new/name.md", previousPath: "old/name.md" },
    { status: "copied", path: "dup.md", previousPath: "src.md" },
    { status: "changed", path: "mode.sh", previousPath: null },
  ]);
});

test("CFS: parseGitNameStatusZ keeps paths with spaces and non-ASCII characters intact", () => {
  const text = ["M", "docs/my file 設計.md"].join("\0") + "\0";
  assert.deepEqual(parseGitNameStatusZ(text), [
    { status: "modified", path: "docs/my file 設計.md", previousPath: null },
  ]);
});

test("CFS: parseGitNameStatusZ of empty output is an empty list", () => {
  assert.deepEqual(parseGitNameStatusZ(""), []);
  assert.deepEqual(parseGitNameStatusZ(undefined), []);
});

test("CFS: parseGitNameStatusZ throws on a malformed record instead of guessing", () => {
  assert.throws(() => parseGitNameStatusZ("M\0"), /missing path/);
  assert.throws(() => parseGitNameStatusZ("R100\0only-old\0"), /missing path/);
  assert.throws(() => parseGitNameStatusZ("what\0path\0"), /malformed name-status record/);
  assert.throws(() => parseGitNameStatusZ("\0path\0"), /malformed name-status record/);
});

test("CFS: toExemptionInput normalizes raw statuses and keeps file order", () => {
  const { files, statuses } = toExemptionInput([
    { path: "a.md", status: "MODIFIED" },
    { path: "b.md", status: "added" },
    { path: "c.md", status: "D" },
  ]);
  assert.deepEqual(files, ["a.md", "b.md", "c.md"]);
  assert.ok(statuses instanceof Map);
  assert.deepEqual([...statuses], [
    ["a.md", "modified"],
    ["b.md", "added"],
    ["c.md", "removed"],
  ]);
});

test("CFS: toExemptionInput records a rename's SOURCE path as removed", () => {
  const { files, statuses } = toExemptionInput([
    {
      path: "docs/moved.md",
      status: "renamed",
      previousPath: "openspec/changes/foo/proposal.md",
    },
  ]);
  assert.deepEqual(files, ["docs/moved.md", "openspec/changes/foo/proposal.md"]);
  assert.equal(statuses.get("docs/moved.md"), "renamed");
  assert.equal(statuses.get("openspec/changes/foo/proposal.md"), "removed");
});

test("CFS: toExemptionInput does not invent a removal for a copy's source", () => {
  const { files, statuses } = toExemptionInput([
    { path: "dup.md", status: "copied", previousPath: "src.md" },
  ]);
  assert.deepEqual(files, ["dup.md"]);
  assert.equal(statuses.has("src.md"), false);
});

test("CFS: a non-modified status is never downgraded by a duplicate modified entry", () => {
  const first = toExemptionInput([
    { path: "x.md", status: "added" },
    { path: "x.md", status: "modified" },
  ]);
  assert.equal(first.statuses.get("x.md"), "added");
  assert.deepEqual(first.files, ["x.md"]);

  const second = toExemptionInput([
    { path: "x.md", status: "modified" },
    { path: "x.md", status: "removed" },
  ]);
  assert.equal(second.statuses.get("x.md"), "removed");
  assert.deepEqual(second.files, ["x.md"]);
});

test("CFS: an unrecognized status survives as unknown, never as modified", () => {
  const { statuses } = toExemptionInput([{ path: "x.md", status: "mystery" }]);
  assert.equal(statuses.get("x.md"), "unknown");
});

test("CFS: toExemptionInput tolerates empty and malformed input", () => {
  assert.deepEqual(toExemptionInput([]), { files: [], statuses: new Map() });
  assert.deepEqual(toExemptionInput(undefined), { files: [], statuses: new Map() });
  assert.deepEqual(toExemptionInput([null, {}, { path: "" }, { path: 3 }]), {
    files: [],
    statuses: new Map(),
  });
});
