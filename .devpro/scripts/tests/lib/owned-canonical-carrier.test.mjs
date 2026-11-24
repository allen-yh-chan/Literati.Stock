import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath } from "./repo-root.mjs";
import { makeTempDir } from "./tmp.mjs";
import {
  CANONICAL_CARRIER_ROOT_DECL,
  assertAttemptUnderOwnedRoot,
  assertNotLiveWrite,
  clearOwnedCanonicalCache,
  ownedCarrierRootFor,
  prepareOwnedCanonicalRenderer,
  relocateCanonicalCarrierRoot,
} from "./owned-canonical-carrier.mjs";

test("relocateCanonicalCarrierRoot throws on no-op mutation (F-1)", () => {
  assert.throws(
    () => relocateCanonicalCarrierRoot("no canonical decl here", "/tmp/owned"),
    /expected exactly 1 hit/,
  );
});

test("relocateCanonicalCarrierRoot throws when declaration appears twice (F-1)", () => {
  const doubled = `${CANONICAL_CARRIER_ROOT_DECL}\n${CANONICAL_CARRIER_ROOT_DECL}`;
  assert.throws(
    () => relocateCanonicalCarrierRoot(doubled, "/tmp/owned"),
    /expected exactly 1 hit/,
  );
});

test("relocateCanonicalCarrierRoot binds the owned path literal exactly once", () => {
  const source = `prelude\n${CANONICAL_CARRIER_ROOT_DECL}\ntrailer\n`;
  const owned = path.join("/tmp", "owned-cross-review-fixture");
  const mutated = relocateCanonicalCarrierRoot(source, owned);
  assert.equal(
    mutated,
    `prelude\nconst canonicalCarrierRoot = ${JSON.stringify(owned)};\ntrailer\n`,
  );
  assert.equal(mutated.includes(CANONICAL_CARRIER_ROOT_DECL), false);
});

test("prepareOwnedCanonicalRenderer writes mutated copy under owned temp and keeps carrierRootArg literal", () => {
  const dir = makeTempDir("owned-canonical-prep-");
  try {
    clearOwnedCanonicalCache(dir);
    const rendererPath = repoPath(".devpro/scripts/render-second-review-packet.mjs");
    const prepared = prepareOwnedCanonicalRenderer({
      fixtureDir: dir,
      repoRoot: REPO_ROOT,
      rendererPath,
    });
    assert.equal(prepared.ownedCarrierRoot, ownedCarrierRootFor(dir));
    assert.equal(prepared.carrierRootArg, prepared.ownedCarrierRoot);
    assert.equal(
      prepared.carrierRootArg,
      path.join(dir, "owned-cross-review"),
      "--carrier-root must be the owned path literal",
    );
    const mutatedSource = readFileSync(prepared.mutatedRendererPath, "utf8");
    assert.ok(
      mutatedSource.includes(`const canonicalCarrierRoot = ${JSON.stringify(prepared.ownedCarrierRoot)};`),
    );
    assert.equal(mutatedSource.includes(CANONICAL_CARRIER_ROOT_DECL), false);
    assert.ok(
      mutatedSource.includes(`const repoRoot = ${JSON.stringify(REPO_ROOT)};`),
      "repoRoot decl must be rebound to the absolute repoRoot literal exactly once",
    );
    assert.equal(
      mutatedSource.includes('const repoRoot = path.resolve(rendererScriptDir, "../..");'),
      false,
    );
    assert.ok(prepared.mutatedRendererPath.includes(path.join(dir, "owned-canonical-scripts")));
  } finally {
    clearOwnedCanonicalCache(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepareOwnedCanonicalRenderer fails closed when repoRoot decl hit-count is not 1", () => {
  const dir = makeTempDir("owned-canonical-reporoot-hits-");
  try {
    clearOwnedCanonicalCache(dir);
    const rendererPath = repoPath(".devpro/scripts/render-second-review-packet.mjs");
    assert.throws(
      () =>
        prepareOwnedCanonicalRenderer({
          fixtureDir: dir,
          repoRoot: REPO_ROOT,
          rendererPath,
          extraMutate: (source) =>
            `${source}\nconst repoRoot = path.resolve(rendererScriptDir, "../..");\n`,
          cache: false,
        }),
      /expected exactly 1 hit for repoRoot decl/,
    );
  } finally {
    clearOwnedCanonicalCache(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assertAttemptUnderOwnedRoot accepts packet under owned root and rejects live path", () => {
  const dir = makeTempDir("owned-canonical-assert-");
  try {
    const owned = ownedCarrierRootFor(dir);
    const attempt = path.join(owned, "second-review-pr-123-fixture");
    mkdirSync(attempt, { recursive: true });
    writeFileSync(path.join(attempt, "packet.md"), "x");
    assertAttemptUnderOwnedRoot(path.join(attempt, "packet.md"), owned);
    assert.throws(
      () => assertAttemptUnderOwnedRoot("/tmp/not-under-owned/packet.md", owned),
      /must resolve under owned root/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assertNotLiveWrite forbids any live canonical carrier write (F-2)", () => {
  const production = repoPath(".devpro/scripts/render-second-review-packet.mjs");
  const live = path.join(REPO_ROOT, "notes", "cross-review");
  assert.throws(
    () => assertNotLiveWrite(production, live, live, production),
    /forbid unmutated production-renderer live-write/,
  );
  assert.throws(
    () => assertNotLiveWrite(path.join("/tmp", "mutated.mjs"), live, live, production),
    /forbid live canonical carrier write from test helpers/,
  );
  assert.doesNotThrow(() =>
    assertNotLiveWrite(path.join("/tmp", "mutated.mjs"), path.join("/tmp", "owned"), live, production),
  );
});
