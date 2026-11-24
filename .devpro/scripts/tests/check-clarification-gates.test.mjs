/**
 * check-clarification-gates.test.mjs
 *
 * Integration negatives: CLI must block pre-analyst / seams-expansion when
 * clarification-contract validators fail (wired runtime path).
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";
import { computeSeamsContentFingerprint } from "../lib/clarification-contract.mjs";

const CLI = repoPath(".devpro/scripts/check-clarification-gates.mjs");

function runCli(mode, changeName, cwd) {
  return spawnSync(process.execPath, [CLI, mode, changeName], {
    cwd,
    encoding: "utf8",
  });
}

function writeFixture(root, changeName, notesBody) {
  const dir = path.join(root, "openspec", "changes", changeName);
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(root, ".devpro"), { recursive: true });
  writeFileSync(path.join(dir, "meeting-notes.md"), notesBody, "utf8");
}

const VALID_SEAMS = "mechanical grep for round policy";
const VALID_NOTES = `# notes

## Clarification State
- round: 1
- extension_used: false
- round4_completed: false
- cap_hit: false
- cap_resolution: none
- cap_resolution_provenance: none
- frontier: (empty)
- unresolved: (empty)
- decisions: D-ROUND batch≠question (provenance: user)
- shared_understanding: confirmed
- shared_understanding_provenance: user
- terminal: shared-understanding
- gaps_written: false

## Seams Confirmation
- seams: ${VALID_SEAMS}
- confirmed: true
- provenance: user
- bypass: none
- bypass_reason:
- seams_fingerprint: ${computeSeamsContentFingerprint(VALID_SEAMS)}
- reconfirm_required: false
- invalidation_reason: none
`;

test("pre-analyst CLI blocks when Clarification/Seams missing", () => {
  const root = makeTempDir("clar-gates-");
  try {
    writeFixture(root, "demo-change", "# notes only\n");
    const r = runCli("pre-analyst", "demo-change", root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /Clarification State|contract failed|missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-analyst CLI blocks cap-hit without resolution", () => {
  const root = makeTempDir("clar-gates-");
  try {
    const blocked = VALID_NOTES
      .replace("round: 1", "round: 3")
      .replace("cap_hit: false", "cap_hit: true")
      .replace("frontier: (empty)", "frontier: still open (provenance: user)")
      .replace("terminal: shared-understanding", "terminal: shared-understanding");
    writeFixture(root, "demo-change", blocked);
    const r = runCli("pre-analyst", "demo-change", root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /cap|analystDispatchGate|blocked|contract failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-analyst + seams-expansion CLI pass on valid fixture", () => {
  const root = makeTempDir("clar-gates-");
  try {
    writeFixture(root, "demo-change", VALID_NOTES);
    const pre = runCli("pre-analyst", "demo-change", root);
    assert.equal(pre.status, 0, pre.stderr + pre.stdout);
    const seams = runCli("seams-expansion", "demo-change", root);
    assert.equal(seams.status, 0, seams.stderr + seams.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seams-expansion CLI blocks empty seams + pending reconfirm", () => {
  const root = makeTempDir("clar-gates-");
  try {
    const emptySeams = VALID_NOTES
      .replace("seams: mechanical grep for round policy", "seams: (empty)")
      .replace("confirmed: true", "confirmed: false")
      .replace("reconfirm_required: false", "reconfirm_required: true")
      .replace("invalidation_reason: none", "invalidation_reason: frontier-change");
    writeFixture(root, "demo-change", emptySeams);
    const r = runCli("seams-expansion", "demo-change", root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /seams|blocked|non-empty|reconfirm|invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveMeetingNotes finds unique dated archive by bare name; ambiguous fails closed", async () => {
  const { resolveMeetingNotes } = await import(
    pathToFileURL(repoPath(".devpro/scripts/check-clarification-gates.mjs")).href
  );
  const root = makeTempDir("clar-arch-");
  try {
    mkdirSync(path.join(root, ".devpro"), { recursive: true });
    const archive = path.join(root, "openspec", "changes", "archive");
    const dated = path.join(archive, "2026-08-07-demo-change");
    mkdirSync(dated, { recursive: true });
    writeFileSync(path.join(dated, "meeting-notes.md"), VALID_NOTES, "utf8");

    const hit = resolveMeetingNotes(root, "demo-change");
    assert.equal(hit.error, null);
    assert.ok(hit.path.endsWith(path.join("2026-08-07-demo-change", "meeting-notes.md")));

    const dated2 = path.join(archive, "2026-08-06-demo-change");
    mkdirSync(dated2, { recursive: true });
    writeFileSync(path.join(dated2, "meeting-notes.md"), VALID_NOTES, "utf8");
    const amb = resolveMeetingNotes(root, "demo-change");
    assert.equal(amb.path, null);
    assert.match(amb.error, /ambiguous dated-archive/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveMeetingNotes rejects traversal/separators; ignores non-dated; counts candidates before notes filter", async () => {
  const { resolveMeetingNotes } = await import(
    pathToFileURL(repoPath(".devpro/scripts/check-clarification-gates.mjs")).href
  );
  const root = makeTempDir("clar-arch-safe-");
  try {
    mkdirSync(path.join(root, ".devpro"), { recursive: true });
    const archive = path.join(root, "openspec", "changes", "archive");
    mkdirSync(archive, { recursive: true });

    for (const bad of ["../etc", "foo/bar", "foo\\bar", "..", ".", ""]) {
      const r = resolveMeetingNotes(root, bad);
      assert.equal(r.path, null, bad);
      assert.match(r.error, /invalid change name/, bad);
    }

    // Non-dated *-name must not match bare-name fallback
    const legacy = path.join(archive, "legacy-demo-change");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "meeting-notes.md"), VALID_NOTES, "utf8");
    const noLegacy = resolveMeetingNotes(root, "demo-change");
    assert.equal(noLegacy.path, null);
    assert.match(noLegacy.error, /not found/);

    // Two dated dirs: one missing notes → still ambiguous (count before notes filter)
    const d1 = path.join(archive, "2026-08-07-demo-change");
    const d2 = path.join(archive, "2026-08-06-demo-change");
    mkdirSync(d1, { recursive: true });
    mkdirSync(d2, { recursive: true });
    writeFileSync(path.join(d1, "meeting-notes.md"), VALID_NOTES, "utf8");
    // d2 intentionally has no meeting-notes.md
    const ambMissing = resolveMeetingNotes(root, "demo-change");
    assert.equal(ambMissing.path, null);
    assert.match(ambMissing.error, /ambiguous dated-archive/);

    // Unique dated dir without notes → missing-notes fail-closed
    rmSync(d2, { recursive: true, force: true });
    rmSync(path.join(d1, "meeting-notes.md"), { force: true });
    const missing = resolveMeetingNotes(root, "demo-change");
    assert.equal(missing.path, null);
    assert.match(missing.error, /meeting-notes\.md missing in dated archive/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
