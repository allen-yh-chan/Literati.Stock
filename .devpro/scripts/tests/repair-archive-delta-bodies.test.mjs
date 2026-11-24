import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repairArchiveDeltaBodies } from "../repair-archive-delta-bodies.mjs";
import { planArchiveDeltaBodyRepair, parseRequirementBodies, findUnmappedPromotionTitles } from "../lib/requirement-body-whitespace.mjs";

const body = "The system SHALL preserve the reviewed content.\n\n\n#### Scenario: Verified result\n- **WHEN** archive normalizes blanks\n- **THEN** the result stays reviewed";
const block = (title, text = body) => `### Requirement: ${title}\n\n${text}\n\n`;
const spec = text => `# Fixture\n\n## Purpose\n\nExercise archive repair.\n\n## Requirements\n\n${text}`;
const delta = (mode, title, text = body) => `## ${mode} Requirements\n\n${block(title, text)}`;
const collapsed = body.replace("\n\n\n", "\n\n");

for (const eol of ["\n", "\r\n"]) {
  test(`repair preserves BOM and physical bytes outside the selected body (${JSON.stringify(eol)})`, () => {
    const prefix = "\uFEFF# Fixture\r\n\n## Requirements\r\n\r\n### Requirement: Reviewed\r\n\r\n";
    const suffix = "\r\n\r\n### Requirement: Stable\n\nStable SHALL stay.\n\n";
    const before = prefix + collapsed.replaceAll("\n", eol) + suffix;
    const result = planArchiveDeltaBodyRepair({ deltaText: delta("MODIFIED", "Reviewed"), preCanonicalText: spec(block("Reviewed", "Old SHALL remain.") + block("Stable", "Stable SHALL stay.")), postCanonicalText: before, label: "cap" });
    assert.equal(result.text, prefix + body.replaceAll("\n", eol) + suffix);
    assert.deepEqual(result.repairs, [{ title: "Reviewed", mode: "MODIFIED" }]);
  });
}

test("MODIFIED internal blank runs restore the exact reviewed body", () => {
  const result = planArchiveDeltaBodyRepair({ deltaText: delta("MODIFIED", "Reviewed"), preCanonicalText: spec(block("Reviewed", "Old SHALL remain.")), postCanonicalText: spec(block("Reviewed", collapsed)), label: "cap" });
  assert.equal(result.text, spec(block("Reviewed")));
  assert.deepEqual(result.repairs, [{ title: "Reviewed", mode: "MODIFIED" }]);
  const expected = new Map([["Reviewed", body]]);
  const normalizedPost = new Map([["Reviewed", collapsed]]);
  assert.deepEqual(findUnmappedPromotionTitles({ expectedMap: expected, postMap: normalizedPost, deltaTitles: new Set(["Reviewed"]) }), ["Reviewed"], "the seal still rejects the unrepaired delta");
});

test("ADDED blank runs restore reviewed text in a new capability", () => {
  const result = planArchiveDeltaBodyRepair({ deltaText: delta("ADDED", "New"), preCanonicalText: "", postCanonicalText: spec(block("New", collapsed)), label: "new-cap" });
  assert.equal(result.text, spec(block("New")));
});

test("non-delta whitespace tolerance remains unchanged", () => {
  const before = spec(block("Reviewed", "Old SHALL remain.") + block("Stable"));
  const after = spec(block("Reviewed", collapsed) + block("Stable", collapsed));
  const result = planArchiveDeltaBodyRepair({ deltaText: delta("MODIFIED", "Reviewed"), preCanonicalText: before, postCanonicalText: after, label: "cap" });
  assert.equal(result.text, spec(block("Reviewed") + block("Stable", collapsed)));
});

for (const [name, changed] of [
  ["unreviewed token", collapsed.replace("SHALL", "MUST")],
  ["body BOM", collapsed.replace("reviewed", "\uFEFFreviewed")],
  ["indentation", collapsed.replace("#### Scenario", "  #### Scenario")],
  ["punctuation", collapsed.replace("content.", "content!")],
  ["trailing spaces", collapsed.replace("content.", "content.  ")],
]) {
  test(`${name} fails with the affected title`, () => {
    assert.throws(() => planArchiveDeltaBodyRepair({ deltaText: delta("MODIFIED", "Reviewed"), preCanonicalText: spec(block("Reviewed")), postCanonicalText: spec(block("Reviewed", changed)), label: "cap" }), /cap: MODIFIED promotion title\/body mismatch \(Reviewed\)/u);
  });
}

test("retained REMOVED requirements are refused", () => {
  assert.throws(() => planArchiveDeltaBodyRepair({ deltaText: delta("REMOVED", "Removed"), preCanonicalText: spec(block("Removed")), postCanonicalText: spec(block("Removed")), label: "cap" }), /REMOVED promotion title\/body mismatch \(Removed\)/u);
});

test("extra unmapped requirement is refused", () => {
  assert.throws(() => planArchiveDeltaBodyRepair({ deltaText: delta("ADDED", "New"), preCanonicalText: "", postCanonicalText: spec(block("New") + block("Unreviewed")), label: "cap" }), /unmapped promotion change \(Unreviewed\)/u);
});

test("CRLF and multiple repairs preserve parser body identities", () => {
  const result = planArchiveDeltaBodyRepair({ deltaText: delta("ADDED", "First") + delta("ADDED", "Second"), preCanonicalText: "", postCanonicalText: spec(block("First", collapsed) + block("Second", collapsed)).replaceAll("\n", "\r\n"), label: "cap" });
  assert.deepEqual(parseRequirementBodies(result.text, "cap").map(item => item.body), [body, body]);
});

function withFixture(run, { secondCapability = false, deltaBOM = false, structuralCanonicalBOM = false } = {}) {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "archive-body-repair-"));
  const git = args => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (relative, text) => {
    const target = path.join(repoRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  try {
    git(["init", "-q"]);
    git(["config", "user.name", "Fixture"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git(["checkout", "-b", "bugfix/fixture"]);
    const changeId = "repair-fixture";
    const activeRoot = `openspec/changes/${changeId}`;
    const archiveRoot = `openspec/changes/archive/2026-10-12-${changeId}`;
    write(`${activeRoot}/specs/one/spec.md`, (deltaBOM ? "\uFEFF" : "") + delta("MODIFIED", "Reviewed"));
    write("openspec/specs/one/spec.md", structuralCanonicalBOM ? "\uFEFF" + block("Reviewed", "Old SHALL remain.") : spec(block("Reviewed", "Old SHALL remain.")));
    if (secondCapability) {
      write(`${activeRoot}/specs/two/spec.md`, delta("ADDED", "Second"));
    }
    git(["add", "."]); git(["commit", "-qm", "reviewed fixture"]);
    const reviewedHeadSha = git(["rev-parse", "HEAD"]);
    mkdirSync(path.join(repoRoot, "openspec/changes/archive"));
    renameSync(path.join(repoRoot, activeRoot), path.join(repoRoot, archiveRoot));
    write("openspec/specs/one/spec.md", structuralCanonicalBOM ? "\uFEFF" + block("Reviewed", collapsed) : spec(block("Reviewed", collapsed)));
    if (secondCapability) write("openspec/specs/two/spec.md", spec(block("Second", collapsed.replace("SHALL", "MUST"))));
    run({ repoRoot, changeId, archiveRoot, reviewedHeadSha, git, write });
  } finally { rmSync(repoRoot, { recursive: true, force: true }); }
}

test("CLI preview leaves bytes intact; apply is idempotent and leaves HEAD unchanged", () => withFixture(context => {
  const { repoRoot, reviewedHeadSha, changeId, archiveRoot, git } = context;
  const canonical = path.join(repoRoot, "openspec/specs/one/spec.md");
  const cli = fileURLToPath(new URL("../repair-archive-delta-bodies.mjs", import.meta.url));
  const args = [cli, "--change", changeId, "--reviewed-head", reviewedHeadSha, "--archive-root", archiveRoot];
  const before = readFileSync(canonical);
  const preview = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8" });
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).repairs[0].title, "Reviewed");
  assert.deepEqual(readFileSync(canonical), before);
  const applied = spawnSync(process.execPath, [...args, "--apply"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(readFileSync(canonical, "utf8"), spec(block("Reviewed")));
  assert.deepEqual(repairArchiveDeltaBodies({ ...context, apply: true }).repairs, []);
  assert.equal(git(["rev-parse", "HEAD"]), reviewedHeadSha);
}));

test("semantic drift in a later capability prevents every repair write", () => withFixture(context => {
  const target = path.join(context.repoRoot, "openspec/specs/one/spec.md");
  const before = readFileSync(target);
  assert.throws(() => repairArchiveDeltaBodies({ ...context, apply: true }), /openspec\/specs\/two\/spec\.md: ADDED promotion title\/body mismatch \(Second\)/u);
  assert.deepEqual(readFileSync(target), before);
}, { secondCapability: true }));

test("changed archived delta is refused before writing canonical", () => withFixture(context => {
  const target = path.join(context.repoRoot, "openspec/specs/one/spec.md");
  const before = readFileSync(target);
  context.write(`${context.archiveRoot}/specs/one/spec.md`, delta("MODIFIED", "Reviewed", body.replace("SHALL", "MUST")));
  assert.throws(() => repairArchiveDeltaBodies({ ...context, apply: true }), /archived delta differs from reviewed bytes/u);
  assert.deepEqual(readFileSync(target), before);
}));

test("already committed archive cannot use the pre-commit repair", () => withFixture(context => {
  context.git(["add", "."]); context.git(["commit", "-qm", "archive fixture"]);
  assert.throws(() => repairArchiveDeltaBodies({ ...context, apply: true }), /repair must run before the archive commit at the reviewed HEAD/u);
}));

for (const branch of ["main", "master", "production", "integration", "release/v1.2.3"]) {
  test(`protected branch refuses repair writes: ${branch}`, () => withFixture(context => {
    context.git(["checkout", "-b", branch]);
    const target = path.join(context.repoRoot, "openspec/specs/one/spec.md");
    const before = readFileSync(target);
    assert.throws(() => repairArchiveDeltaBodies({ ...context, apply: true }), /repair cannot write on a protected branch/u);
    assert.deepEqual(readFileSync(target), before);
  }));
}

test("Git autocrlf checkout conversion preserves reviewed delta identity and canonical BOM", () => withFixture(context => {
  context.git(["config", "core.autocrlf", "true"]);
  const archived = `${context.archiveRoot}/specs/one/spec.md`;
  const canonical = path.join(context.repoRoot, "openspec/specs/one/spec.md");
  context.write(archived, delta("MODIFIED", "Reviewed").replaceAll("\n", "\r\n"));
  const prefix = "\uFEFF";
  writeFileSync(canonical, prefix + readFileSync(canonical, "utf8").replaceAll("\n", "\r\n"));
  const result = repairArchiveDeltaBodies({ ...context, apply: true });
  assert.equal(result.repairs.length, 1);
  assert.deepEqual(readFileSync(canonical), Buffer.from(prefix + spec(block("Reviewed")).replaceAll("\n", "\r\n")));
  const before = readFileSync(canonical);
  context.write(archived, delta("MODIFIED", "Reviewed", body.replace("SHALL", "MUST")).replaceAll("\n", "\r\n"));
  assert.throws(() => repairArchiveDeltaBodies({ ...context, apply: true }), /archived delta differs from reviewed bytes/u);
  assert.deepEqual(readFileSync(canonical), before);
}));

test("missing required CLI parameters print actionable usage before repository probing", () => {
  const cli = fileURLToPath(new URL("../repair-archive-delta-bodies.mjs", import.meta.url));
  for (const args of [[], ["--apply"], ["--change", "valid-name"], ["--reviewed-head", "a".repeat(40)]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: os.tmpdir(), encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^Usage: repair-archive-delta-bodies\.mjs --change <name> --reviewed-head <SHA> --archive-root /m);
    assert.doesNotMatch(result.stderr, /not a git repository|invalid change name|reviewed head must/);
  }
});

for (const options of [{ deltaBOM: true }, { structuralCanonicalBOM: true }, { deltaBOM: true, structuralCanonicalBOM: true }]) {
  test(`leading BOM before a structural heading stays readable: ${JSON.stringify(options)}`, () => withFixture(context => {
    const canonical = path.join(context.repoRoot, "openspec/specs/one/spec.md");
    const archived = path.join(context.repoRoot, context.archiveRoot, "specs/one/spec.md");
    const archivedBefore = readFileSync(archived);
    const result = repairArchiveDeltaBodies({ ...context, apply: true });
    assert.equal(result.repairs.length, 1);
    assert.equal(readFileSync(canonical, "utf8"), options.structuralCanonicalBOM ? "\uFEFF" + block("Reviewed") : spec(block("Reviewed")));
    assert.deepEqual(readFileSync(archived), archivedBefore);
    assert.equal(context.git(["rev-parse", "HEAD"]), context.reviewedHeadSha);
  }, options));
}

test("[Scenario: archive-tooling :: Post-merge recovery repairs against the reviewed delta blob] post-merge recovery accepts an ancestor reviewed head and still repairs the body", () => withFixture(context => {
  const { repoRoot, reviewedHeadSha, changeId, archiveRoot, git } = context;
  git(["add", "-A"]);
  git(["commit", "-qm", "archive move after merge"]);
  assert.notEqual(git(["rev-parse", "HEAD"]), reviewedHeadSha, "fixture must move HEAD past the reviewed commit");
  const cli = fileURLToPath(new URL("../repair-archive-delta-bodies.mjs", import.meta.url));
  const args = [cli, "--change", changeId, "--reviewed-head", reviewedHeadSha, "--archive-root", archiveRoot];
  const blocked = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8" });
  assert.notEqual(blocked.status, 0, "the pre-archive ordering guard must still hold without the recovery flag");
  assert.match(blocked.stderr, /repair must run before the archive commit at the reviewed HEAD/u);
  const recovered = spawnSync(process.execPath, [...args, "--recovery-archive-after-merge", "--apply"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(readFileSync(path.join(repoRoot, "openspec/specs/one/spec.md"), "utf8"), spec(block("Reviewed")));
  assert.deepEqual(repairArchiveDeltaBodies({ ...context, recoveryAfterMerge: true }).repairs, [], "a second recovery run is a no-op");
}));

test("[Scenario: archive-tooling :: Recovery refuses a non-ancestor or an archived delta with no reviewed counterpart] recovery refuses a reviewed head that is not an ancestor of HEAD", () => withFixture(context => {
  const { repoRoot, git } = context;
  git(["checkout", "-q", "--orphan", "unrelated-root"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "unrelated root"]);
  assert.throws(
    () => repairArchiveDeltaBodies({ ...context, recoveryAfterMerge: true }),
    /recovery requires the reviewed head to be an ancestor of HEAD/u
  );
}));

test("recovery refuses an archived delta whose capability has no reviewed counterpart", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "archive-body-counterpart-"));
  const git = args => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (relative, text) => {
    const target = path.join(repoRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  try {
    git(["init", "-q"]);
    git(["config", "user.name", "Fixture"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git(["checkout", "-b", "chore/fixture"]);
    write("openspec/specs/one/spec.md", spec(block("Reviewed", "Old SHALL remain.")));
    git(["add", "."]);
    git(["commit", "-qm", "before the change existed"]);
    const earlierHead = git(["rev-parse", "HEAD"]);
    const changeId = "repair-fixture";
    const activeRoot = `openspec/changes/${changeId}`;
    const archiveRoot = `openspec/changes/archive/2026-10-12-${changeId}`;
    write(`${activeRoot}/specs/one/spec.md`, delta("MODIFIED", "Reviewed"));
    git(["add", "."]);
    git(["commit", "-qm", "reviewed fixture"]);
    mkdirSync(path.join(repoRoot, "openspec/changes/archive"), { recursive: true });
    renameSync(path.join(repoRoot, activeRoot), path.join(repoRoot, archiveRoot));
    write("openspec/specs/one/spec.md", spec(block("Reviewed", collapsed)));
    assert.throws(
      () => repairArchiveDeltaBodies({ repoRoot, changeId, archiveRoot, reviewedHeadSha: earlierHead, recoveryAfterMerge: true }),
      /archived delta has no reviewed counterpart at the reviewed head: .*one\/spec\.md/u
    );
  } finally { rmSync(repoRoot, { recursive: true, force: true }); }
});

test("[Scenario: archive-tooling :: Missing reviewed object is reported as unavailable] recovery names a missing reviewed object instead of calling it a non-ancestor", () => withFixture(context => {
  const { repoRoot, changeId, archiveRoot } = context;
  const missing = "0".repeat(40);
  assert.throws(
    () => repairArchiveDeltaBodies({ repoRoot, changeId, archiveRoot, reviewedHeadSha: missing, recoveryAfterMerge: true }),
    /reviewed head is not available in this clone \(fetch or unshallow first\): 0{40}/u
  );
}));
