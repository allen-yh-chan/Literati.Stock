import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify, buildLeafPattern } from "../report-leaf-references.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(scriptDir, "../report-leaf-references.mjs");

/**
 * Build a synthetic corpus:
 *   <root>/rules/*.md        the leaf corpus being classified
 *   <root>/docs/*.{md,mjs}   referencing files
 * Leaf bodies are minimal so leaves never accidentally reference each other; only the
 * explicit docs/ files (and any deliberate self-mention) create references.
 * Runs fn(root, rulesDir) and always cleans up.
 */
function withCorpus(fn) {
  const root = makeTempDir("leaf-ref-");
  try {
    const rules = path.join(root, "rules");
    const docs = path.join(root, "docs");
    mkdirSync(rules, { recursive: true });
    mkdirSync(docs, { recursive: true });

    // dead-leaf: 0 external refs; its own body mentions itself (self-ref MUST NOT count).
    writeFileSync(path.join(rules, "dead-leaf.md"), "# dead-leaf.md\nsee dead-leaf.md\n");
    // near-dead-leaf: 1 referencing file (docs/a.md).
    writeFileSync(path.join(rules, "near-dead-leaf.md"), "# near\n");
    // normal-leaf: 2 referencing files (docs/a.md + docs/b.mjs).
    writeFileSync(path.join(rules, "normal-leaf.md"), "# normal\n");
    // flow.md: 0 real refs — a longer `openspec-flow.md` appears in docs, and the shorter
    // `flow.md` MUST NOT match as its substring.
    writeFileSync(path.join(rules, "flow.md"), "# flow\n");
    // openspec-flow.md: 2 referencing files (docs/a.md + docs/c.md).
    writeFileSync(path.join(rules, "openspec-flow.md"), "# openspec-flow\n");

    // a.md mentions near-dead-leaf.md TWICE — the count is distinct referencing FILES, so
    // near-dead-leaf.md must still tally 1, not 2 (same-file double mention collapses).
    writeFileSync(
      path.join(docs, "a.md"),
      "refs `near-dead-leaf.md`, `normal-leaf.md`, and `openspec-flow.md`\n" +
        "and again `near-dead-leaf.md` in the same file\n",
    );
    writeFileSync(path.join(docs, "b.mjs"), "// touches normal-leaf.md\n");
    writeFileSync(path.join(docs, "c.md"), "see openspec-flow.md for routing\n");

    return fn(root, rules);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function run(extraArgs = []) {
  return spawnSync(process.execPath, [SCRIPT, ...extraArgs], { encoding: "utf8" });
}

/** Read a leaf's bucket + count from the per-leaf table line `<bucket>  <leaf>  (<n>)`. */
function leafRow(stdout, leaf) {
  const esc = leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*(dead|near-dead|normal)\\s+${esc}\\s+\\((\\d+)\\)`, "m");
  const m = stdout.match(re);
  assert.ok(m, `expected a per-leaf row for "${leaf}" in output`);
  return { bucket: m[1], count: Number(m[2]) };
}

function bucketCount(stdout, label) {
  const re = new RegExp(`^\\s+${label}\\s+:\\s+(\\d+)`, "m");
  const m = stdout.match(re);
  assert.ok(m, `expected a "${label}" bucket line in output`);
  return Number(m[1]);
}

// ---- Pure classifier: three tiers with a parametric dead-threshold ----

test("classify: default threshold 1 (dead=0, near-dead=1, normal>1)", () => {
  assert.equal(classify(0, 1), "dead");
  assert.equal(classify(1, 1), "near-dead");
  assert.equal(classify(2, 1), "normal");
});

test("classify: threshold 2 widens the near-dead band to 1..2 inclusive", () => {
  assert.equal(classify(0, 2), "dead");
  assert.equal(classify(1, 2), "near-dead");
  assert.equal(classify(2, 2), "near-dead");
  assert.equal(classify(3, 2), "normal");
});

test("classify: threshold 0 leaves no near-dead tier (0=dead, >=1=normal)", () => {
  assert.equal(classify(0, 0), "dead");
  assert.equal(classify(1, 0), "normal");
});

// ---- Reference pattern: physical filename mention with substring boundary ----

test("buildLeafPattern matches a bounded filename mention", () => {
  const re = buildLeafPattern("flow.md");
  assert.ok(re.test("see `flow.md` here"));
  assert.ok(re.test("at path .devpro/agent-rules/flow.md end"));
});

test("buildLeafPattern does NOT match a shorter name inside a longer filename", () => {
  const re = buildLeafPattern("flow.md");
  assert.ok(!re.test("openspec-flow.md"), "`flow.md` must not match inside `openspec-flow.md`");
  assert.ok(!re.test("flow.mdx"), "`flow.md` must not match `flow.mdx` (longer extension)");
  // Left-boundary excludes every filename-token char (letter/digit/._-), not just `-`:
  // `a.flow.md` / `a_flow.md` are DIFFERENT files and must not match `flow.md`.
  assert.ok(!re.test("a.flow.md"), "`.` left boundary: `flow.md` must not match inside `a.flow.md`");
  assert.ok(!re.test("a_flow.md"), "`_` left boundary: `flow.md` must not match inside `a_flow.md`");
});

// ---- Live CLI over synthetic corpus: classification + exit 0 at each threshold ----

test("default threshold 1: dead/near-dead/normal buckets + exit 0", () => {
  withCorpus((root, rules) => {
    const r = run(["--rules-dir", rules, "--corpus-root", root]);
    assert.equal(r.status, 0, "report-only surface MUST exit 0");
    assert.deepEqual(leafRow(r.stdout, "dead-leaf.md"), { bucket: "dead", count: 0 });
    assert.deepEqual(leafRow(r.stdout, "flow.md"), { bucket: "dead", count: 0 });
    assert.deepEqual(leafRow(r.stdout, "near-dead-leaf.md"), { bucket: "near-dead", count: 1 });
    assert.deepEqual(leafRow(r.stdout, "normal-leaf.md"), { bucket: "normal", count: 2 });
    assert.deepEqual(leafRow(r.stdout, "openspec-flow.md"), { bucket: "normal", count: 2 });
    assert.equal(bucketCount(r.stdout, "dead"), 2);
    assert.equal(bucketCount(r.stdout, "near-dead"), 1);
    assert.equal(bucketCount(r.stdout, "normal"), 2);
  });
});

test("threshold 2 moves the 2-ref leaves into near-dead; exit 0", () => {
  withCorpus((root, rules) => {
    const r = run(["--rules-dir", rules, "--corpus-root", root, "--dead-threshold", "2"]);
    assert.equal(r.status, 0);
    assert.equal(leafRow(r.stdout, "near-dead-leaf.md").bucket, "near-dead");
    assert.equal(leafRow(r.stdout, "normal-leaf.md").bucket, "near-dead", "2 refs now near-dead at threshold 2");
    assert.equal(leafRow(r.stdout, "openspec-flow.md").bucket, "near-dead");
    assert.equal(leafRow(r.stdout, "dead-leaf.md").bucket, "dead");
  });
});

test("threshold 0 collapses the near-dead tier (1-ref leaf becomes normal); exit 0", () => {
  withCorpus((root, rules) => {
    const r = run(["--rules-dir", rules, "--corpus-root", root, "--dead-threshold", "0"]);
    assert.equal(r.status, 0);
    assert.equal(leafRow(r.stdout, "dead-leaf.md").bucket, "dead");
    assert.equal(leafRow(r.stdout, "flow.md").bucket, "dead");
    assert.equal(leafRow(r.stdout, "near-dead-leaf.md").bucket, "normal", "1 ref is normal at threshold 0");
    assert.equal(bucketCount(r.stdout, "near-dead"), 0);
  });
});

test("count is distinct files, not mentions (near-dead-leaf mentioned twice in one file = 1)", () => {
  withCorpus((root, rules) => {
    const r = run(["--rules-dir", rules, "--corpus-root", root]);
    assert.equal(
      leafRow(r.stdout, "near-dead-leaf.md").count,
      1,
      "two mentions in the same file must count as one referencing file",
    );
  });
});

test("self-reference is excluded (dead-leaf mentions itself but stays dead)", () => {
  withCorpus((root, rules) => {
    const r = run(["--rules-dir", rules, "--corpus-root", root]);
    assert.deepEqual(
      leafRow(r.stdout, "dead-leaf.md"),
      { bucket: "dead", count: 0 },
      "a leaf's own self-mention must not count toward its reference total",
    );
  });
});

test("output is labelled report-only and leaf-scoped / directional", () => {
  withCorpus((root, rules) => {
    const r = run(["--rules-dir", rules, "--corpus-root", root]);
    assert.match(r.stdout, /report-only/i);
    assert.match(r.stdout, /directional/i);
  });
});

// ---- Usage errors: bad invocation is exit 2, distinct from the always-0 report ----

test("trailing --corpus-root with no value exits 2 (usage error, not a gate)", () => {
  const r = run(["--corpus-root"]);
  assert.equal(r.status, 2, "missing --corpus-root value must be a usage error");
  assert.match(r.stderr, /--corpus-root requires a path value/);
});

test("non-integer --dead-threshold exits 2 (usage error)", () => {
  const r = run(["--dead-threshold", "abc"]);
  assert.equal(r.status, 2, "non-integer --dead-threshold must be a usage error");
  assert.match(r.stderr, /--dead-threshold/);
});

// ---- Live repo: report-only surface must run green over the real leaf corpus ----

test("live repo: exit 0 and emits buckets over the real leaf corpus", () => {
  const r = run(); // defaults: --rules-dir .devpro/agent-rules, --corpus-root repo root
  assert.equal(r.status, 0, "live report-only surface MUST exit 0");
  assert.match(r.stdout, /Buckets:/);
  assert.match(r.stdout, /dead\s+:/);
});
