// A post-PR marker written by a hub session for another repository's PR carries that repository's slug. The Stop
// hook's snapshot verifies the returned PR URL, then compares a previously reviewed head in that repository.
import "./lib/portable-command-shims.cjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SECOND_REVIEW_STICKY_MARKER } from "../hooks/lib/second-review-sticky-authority.mjs";
import { __testSnapshotFromGhData as snapshotFromGhData } from "../hooks/post-pr-completion-check.mjs";

const root = mkdtempSync(path.join(tmpdir(), "post-pr-slug-"));
after(() => rmSync(root, { recursive: true, force: true }));
const trace = path.join(root, "gh-args.txt");
// A Node stub (not /bin/sh) so portable-command-shims can run it on native Windows as well.
writeFileSync(
  path.join(root, "gh"),
  `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(trace)}, process.argv.slice(2).join(" ") + "\\n");\nprocess.exit(1);\n`,
  { mode: 0o755 },
);

const REVIEWED = "b".repeat(40);
const HEAD = "c".repeat(40);
const REPOSITORY = "github.com/example-org/plain-app";
const PR_URL = `https://${REPOSITORY}/pull/5`;
const sticky = [
  SECOND_REVIEW_STICKY_MARKER,
  "## Cross-Model Second Opinion Review",
  "",
  "verdict: PASS",
  `last_reviewed_sha: ${REVIEWED}`,
  "dispatch_id: dispatch-slug-test",
  "reason: Bounded review completed for the requested scope.",
  "Rules: v7.17.3 · Tool: Claude Code · Model: claude-test",
].join("\n");

function compareCalls(url, expectedComparisonRepo) {
  rmSync(trace, { force: true });
  const saved = process.env.PATH;
  process.env.PATH = `${root}${path.delimiter}${saved}`;
  try {
    snapshotFromGhData({
      number: 5, url, state: "OPEN", headRefName: "chore/x", headRefOid: HEAD,
      comments: [{ body: sticky, id: "S1" }],
    }, { filesAvailable: false, expectedComparisonRepo });
  } finally {
    process.env.PATH = saved;
  }
  return existsSync(trace) ? readFileSync(trace, "utf8").split("\n").filter((line) => line.includes("/compare/")) : [];
}

test("the fresh-equivalent compare uses the verified PR URL with or without a matching marker repository", () => {
  for (const expectedComparisonRepo of [REPOSITORY, undefined]) {
    const calls = compareCalls(PR_URL, expectedComparisonRepo);
    assert.ok(calls.length > 0, "a stale sticky with a verified PR URL must be compared");
    assert.ok(calls.every((line) => line.includes(`repos/example-org/plain-app/compare/${REVIEWED}...${HEAD}`)), calls.join("\n"));
  }
});

test("a missing, unsupported, or mismatched PR URL cannot authorize a compare", () => {
  assert.deepEqual(compareCalls(undefined, REPOSITORY), []);
  assert.deepEqual(compareCalls("https://enterprise.example/example-org/plain-app/pull/5"), []);
  assert.deepEqual(compareCalls(PR_URL, "github.com/example-org/other-app"), []);
});
