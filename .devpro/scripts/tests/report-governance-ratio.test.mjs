import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classify,
  extractTouchedLeaves,
  monthOf,
  DEV_WORK_LEAVES,
} from "../report-governance-ratio.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(scriptDir, "../report-governance-ratio.mjs");

// Real leaf names used by fixtures: one unambiguous governance leaf, one dev-work leaf.
const GOV_LEAF = "ai-autonomy.md";
const DEV_LEAF = "csharp-style-and-dry.md";

/**
 * Build a synthetic archive dir; `changes` is a list of {folder, touch[], dontTouch[]}.
 * Runs `fn(archiveDir)` and always cleans up.
 */
function withTempArchive(changes, fn) {
  const archiveDir = makeTempDir("gov-ratio-");
  try {
    for (const c of changes) {
      const dir = path.join(archiveDir, c.folder);
      mkdirSync(dir, { recursive: true });
      const body = ["## Touch", ""];
      for (const p of c.touch || []) body.push(`- \`${p}\``);
      if (c.dontTouch && c.dontTouch.length) {
        body.push("", "**Don't touch**:");
        for (const p of c.dontTouch) body.push(`- \`${p}\``);
      }
      body.push("");
      writeFileSync(path.join(dir, "proposal-mini.md"), body.join("\n"));
    }
    return fn(archiveDir);
  } finally {
    rmSync(archiveDir, { recursive: true, force: true });
  }
}

function run(archiveDir) {
  const args = [SCRIPT];
  if (archiveDir) args.push("--archive-dir", archiveDir);
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

function bucketCount(stdout, label) {
  // Matches the bucket lines only (e.g. "  governance   : 3"), not the ratio lines
  // ("governance / (governance + dev-work) : ...") which have "/" before the colon.
  const re = new RegExp(`^\\s+${label}\\s+:\\s+(\\d+)`, "m");
  const m = stdout.match(re);
  assert.ok(m, `expected a "${label}" bucket line in output`);
  return Number(m[1]);
}

test("taxonomy allowlist is a non-empty, inspectable data structure", () => {
  assert.ok(DEV_WORK_LEAVES instanceof Set);
  assert.ok(DEV_WORK_LEAVES.size > 0, "DEV_WORK_LEAVES must not be empty");
  assert.ok(DEV_WORK_LEAVES.has(DEV_LEAF));
  assert.ok(!DEV_WORK_LEAVES.has(GOV_LEAF));
});

// ---- Boundary fixtures: each MUST exit 0 (guards against a future `if ratio>X exit 1`) ----

test("all-governance boundary: exit 0 + all in governance bucket", () => {
  withTempArchive(
    [
      { folder: "2026-07-01-gov-a", touch: [`.devpro/agent-rules/${GOV_LEAF}`] },
      { folder: "2026-07-02-gov-b", touch: [`.devpro/agent-rules/${GOV_LEAF}`] },
      { folder: "2026-07-03-gov-c", touch: [`.devpro/agent-rules/${GOV_LEAF}`] },
    ],
    (dir) => {
      const r = run(dir);
      assert.equal(r.status, 0, "report-only surface MUST exit 0 (all-governance)");
      assert.equal(bucketCount(r.stdout, "governance"), 3);
      assert.equal(bucketCount(r.stdout, "dev-work"), 0);
      assert.equal(bucketCount(r.stdout, "unclassified"), 0);
    },
  );
});

test("all-dev-work boundary (0% governance): exit 0 + all in dev-work bucket", () => {
  withTempArchive(
    [
      { folder: "2026-07-01-dev-a", touch: [`.devpro/agent-rules/${DEV_LEAF}`] },
      { folder: "2026-07-02-dev-b", touch: [`.devpro/agent-rules/${DEV_LEAF}`] },
      { folder: "2026-07-03-dev-c", touch: [`.devpro/agent-rules/${DEV_LEAF}`] },
    ],
    (dir) => {
      const r = run(dir);
      assert.equal(r.status, 0, "report-only surface MUST exit 0 (all-dev-work, 0% gov)");
      assert.equal(bucketCount(r.stdout, "dev-work"), 3);
      assert.equal(bucketCount(r.stdout, "governance"), 0);
      assert.equal(bucketCount(r.stdout, "unclassified"), 0);
    },
  );
});

test("even gov/dev split boundary: exit 0 + defaults to governance", () => {
  withTempArchive(
    [
      {
        folder: "2026-07-01-tie-a",
        touch: [`.devpro/agent-rules/${GOV_LEAF}`, `.devpro/agent-rules/${DEV_LEAF}`],
      },
      {
        folder: "2026-07-02-tie-b",
        touch: [`.devpro/agent-rules/${GOV_LEAF}`, `.devpro/agent-rules/${DEV_LEAF}`],
      },
    ],
    (dir) => {
      const r = run(dir);
      assert.equal(r.status, 0, "report-only surface MUST exit 0 (tie)");
      assert.equal(bucketCount(r.stdout, "governance"), 2, "tie => default-to-governance");
      assert.equal(bucketCount(r.stdout, "dev-work"), 0);
      assert.equal(bucketCount(r.stdout, "unclassified"), 0);
    },
  );
});

test("no-leaf boundary: exit 0 + unclassified bucket (not forced into either)", () => {
  withTempArchive(
    [
      { folder: "2026-07-01-noleaf-a", touch: [".devpro/scripts/foo.mjs"] },
      { folder: "2026-07-02-noleaf-b", touch: [".claude/agents/dp-executor.md"] },
    ],
    (dir) => {
      const r = run(dir);
      assert.equal(r.status, 0, "report-only surface MUST exit 0 (no-leaf)");
      assert.equal(bucketCount(r.stdout, "unclassified"), 2);
      assert.equal(bucketCount(r.stdout, "governance"), 0);
      assert.equal(bucketCount(r.stdout, "dev-work"), 0);
    },
  );
});

test("empty archive: exit 0 + all buckets zero", () => {
  withTempArchive([], (dir) => {
    const r = run(dir);
    assert.equal(r.status, 0);
    assert.equal(bucketCount(r.stdout, "governance"), 0);
    assert.equal(bucketCount(r.stdout, "dev-work"), 0);
    assert.equal(bucketCount(r.stdout, "unclassified"), 0);
  });
});

test("usage error: trailing --archive-dir with no value exits 2 (not a ratio gate)", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--archive-dir"], { encoding: "utf8" });
  // Distinct from the always-0 report run: a bad invocation is a usage error (exit 2),
  // never silently a ratio gate and never a crash.
  assert.equal(r.status, 2, "missing --archive-dir value must be a usage error, not exit 0");
  assert.match(r.stderr, /--archive-dir requires a path value/);
});

// ---- Touch-extraction correctness (the pinned signal source) ----

test("extractTouchedLeaves reads Touch section, resolves both path forms", () => {
  const leafSet = new Set([GOV_LEAF, DEV_LEAF]);
  const content = [
    "# Change",
    "## Why",
    `noise \`${DEV_LEAF}\` outside the Touch section must be ignored`,
    "## Touch",
    `- \`.devpro/agent-rules/${GOV_LEAF}\``,
    `- \`agent-rules/${DEV_LEAF}\``, // legacy prefix form
    "- `.devpro/scripts/foo.mjs`", // non-leaf ignored
    "## Tasks",
    "- [ ] do it",
  ].join("\n");
  const leaves = extractTouchedLeaves(content, leafSet);
  assert.deepEqual([...leaves].sort(), [GOV_LEAF, DEV_LEAF].sort());
});

test("extractTouchedLeaves excludes files under a Don't touch marker", () => {
  const leafSet = new Set([GOV_LEAF, DEV_LEAF]);
  const content = [
    "## Touch / Don't Touch",
    `- **Touch**: \`.devpro/agent-rules/${GOV_LEAF}\``,
    `- **Don't touch**: \`.devpro/agent-rules/${DEV_LEAF}\``,
  ].join("\n");
  const leaves = extractTouchedLeaves(content, leafSet);
  assert.deepEqual([...leaves], [GOV_LEAF], "don't-touch leaf must be excluded");
});

test("extractTouchedLeaves treats a separate `## Non-Touch` H2 as not-touched, not touch-positive", () => {
  const leafSet = new Set([GOV_LEAF, DEV_LEAF]);
  // A `## Non-Touch` heading matches TOUCH_HEADING via the bare "touch" word; it MUST NOT be
  // treated as a collection section (the header contract says negated-touch markers stop
  // collection). Cross-model second-review WARN on PR #1821 caught this misbucketing.
  const content = [
    "## Touch",
    `- \`.devpro/agent-rules/${DEV_LEAF}\``,
    "## Non-Touch",
    `- \`.devpro/agent-rules/${GOV_LEAF}\``,
  ].join("\n");
  const leaves = extractTouchedLeaves(content, leafSet);
  assert.deepEqual([...leaves], [DEV_LEAF], "leaves under a separate Non-Touch section must be excluded");

  // A pure Non-Touch section alone collects nothing (no positive Touch section precedes it).
  const pureNonTouch = [`## Non-Touch`, `- \`.devpro/agent-rules/${GOV_LEAF}\``].join("\n");
  assert.equal(extractTouchedLeaves(pureNonTouch, leafSet).size, 0, "pure Non-Touch section collects nothing");

  // Regression guard: the combined `## Touch / Don't Touch` heading must STAY a collection
  // section (leads with the positive "Touch"), stopping at its inline don't-touch marker.
  const combined = [
    "## Touch / Don't Touch",
    `- **Touch**: \`.devpro/agent-rules/${DEV_LEAF}\``,
    `- **Don't touch**: \`.devpro/agent-rules/${GOV_LEAF}\``,
  ].join("\n");
  assert.deepEqual([...extractTouchedLeaves(combined, leafSet)], [DEV_LEAF], "combined heading stays a Touch section");
});

test("classify honors allowlist, tie-breaker, and unclassified", () => {
  assert.equal(classify(new Set()), "unclassified");
  assert.equal(classify(new Set([GOV_LEAF])), "governance");
  assert.equal(classify(new Set([DEV_LEAF])), "dev-work");
  assert.equal(classify(new Set([GOV_LEAF, DEV_LEAF])), "governance"); // tie => gov
});

test("monthOf parses date-prefixed folders, else unknown", () => {
  assert.equal(monthOf("2026-07-25-governance-budget-principle"), "2026-07");
  assert.equal(monthOf("no-date-here"), "unknown");
});

// ---- Live archive: report-only surface must run green over real history ----

test("live archive: exit 0 and emits buckets, ratio, and trend", () => {
  const r = run(); // default --archive-dir openspec/changes/archive
  assert.equal(r.status, 0, "live report-only surface MUST exit 0");
  assert.match(r.stdout, /Buckets:/);
  assert.match(r.stdout, /Governance ratio:/);
  assert.match(r.stdout, /Monthly trend/);
});
