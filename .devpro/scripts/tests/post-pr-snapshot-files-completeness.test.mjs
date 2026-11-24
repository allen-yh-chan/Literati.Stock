/**
 * post-pr-snapshot-files-completeness.test.mjs
 *
 * Locks the snapshot builder rule from "PR Changed-File Lists Are Complete
 * Before Classification": every post-PR snapshot source (the PR-number path
 * and the branch-lookup fallback) funnels through snapshotFromGhData, so the
 * builder alone decides whether `files` may be trusted.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { __testSnapshotFromGhData as snapshotFromGhData } from "../hooks/post-pr-completion-check.mjs";

const files = (n) => Array.from({ length: n }, (_, i) => ({ path: `docs/f${i}.md` }));
const base = { number: 1, state: "OPEN", headRefName: "chore/x", headRefOid: "a".repeat(40), comments: [] };

test("snapshot builder trusts files only when changedFiles equals their count", () => {
  const complete = snapshotFromGhData({ ...base, files: files(3), changedFiles: 3 });
  assert.equal(complete.filesAvailable, true);
  assert.equal(complete.files.length, 3);

  for (const [label, data] of [
    ["truncated list", { ...base, files: files(100), changedFiles: 433 }],
    ["missing total", { ...base, files: files(3) }],
    ["non-integer total", { ...base, files: files(3), changedFiles: "3" }],
  ]) {
    const snapshot = snapshotFromGhData(data);
    assert.equal(snapshot.filesAvailable, false, `${label} must be unavailable`);
    assert.deepEqual(snapshot.files, [], `${label} must not expose a partial list`);
  }
});

test("snapshot builder keeps files unavailable when the caller did not request them", () => {
  const snapshot = snapshotFromGhData({ ...base, files: files(3), changedFiles: 3 }, { filesAvailable: false });
  assert.equal(snapshot.filesAvailable, false);
  assert.deepEqual(snapshot.files, []);
});

test("snapshot builder carries each file's GraphQL changeType as a normalized status (#3333)", () => {
  const snapshot = snapshotFromGhData({
    ...base,
    files: [
      { path: "docs/edited.md", changeType: "MODIFIED" },
      { path: "docs/new.md", changeType: "ADDED" },
      { path: "docs/gone.md", changeType: "DELETED" },
      { path: "docs/moved.md", changeType: "RENAMED" },
      { path: "docs/odd.md", changeType: "SOMETHING_NEW" },
      { path: "docs/missing-type.md" },
    ],
    changedFiles: 6,
  });
  assert.equal(snapshot.filesAvailable, true);
  assert.deepEqual([...snapshot.fileStatuses], [
    ["docs/edited.md", "modified"],
    ["docs/new.md", "added"],
    ["docs/gone.md", "removed"],
    ["docs/moved.md", "renamed"],
    ["docs/odd.md", "unknown"],
    ["docs/missing-type.md", "unknown"],
  ]);
});

test("snapshot builder exposes no statuses when files are unavailable", () => {
  const snapshot = snapshotFromGhData({ ...base, files: files(3), changedFiles: 3 }, { filesAvailable: false });
  assert.equal(snapshot.fileStatuses.size, 0);
});
