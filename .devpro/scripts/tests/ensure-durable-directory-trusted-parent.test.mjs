/**
 * R5 prove-it: ensureDurableDirectory fail-fast when outside / missing trusted parent.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDurableDirectory } from "../hooks/lib/second-review-control-evidence.mjs";

describe("ensureDurableDirectory trustedParent (R5)", { concurrency: false }, () => {
  it("fails when target is outside trusted parent", async () => {
    const notes = await fs.mkdtemp(path.join(os.tmpdir(), "trusted-parent-"));
    const crossReview = path.join(notes, "cross-review");
    await fs.mkdir(crossReview);
    const outside = path.join(notes, "elsewhere", "carrier");
    assert.throws(
      () => ensureDurableDirectory(outside, 0o700, { trustedParent: crossReview }),
      (err) => /outside trusted parent/.test(String(err?.message ?? err))
    );
    await fs.rm(notes, { recursive: true, force: true });
  });

  it("fails when trusted parent and its parent are missing", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "trusted-missing-"));
    const missingParent = path.join(base, "no-notes", "cross-review");
    const target = path.join(missingParent, "attempt");
    assert.throws(
      () => ensureDurableDirectory(target, 0o700, { trustedParent: missingParent }),
      (err) => /trusted parent missing/.test(String(err?.message ?? err))
    );
    await fs.rm(base, { recursive: true, force: true });
  });

  it("creates under existing notes when cross-review is missing", async () => {
    const notes = await fs.mkdtemp(path.join(os.tmpdir(), "trusted-ok-"));
    const crossReview = path.join(notes, "cross-review");
    const attempt = path.join(crossReview, "attempt-1");
    const resolved = ensureDurableDirectory(attempt, 0o700, { trustedParent: crossReview });
    assert.equal(resolved, path.resolve(attempt));
    const st = await fs.stat(attempt);
    assert.ok(st.isDirectory());
    await fs.rm(notes, { recursive: true, force: true });
  });
});
