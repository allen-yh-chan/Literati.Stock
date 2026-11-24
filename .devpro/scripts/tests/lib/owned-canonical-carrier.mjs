/**
 * Mutation-relocated owned canonical carrier for renderer-family test helpers.
 *
 * Production `--carrier-root` is a confirmation flag (mismatch fail-closed);
 * tests MUST relocate the renderer's `canonicalCarrierRoot` bind to an owned
 * temp path and pass that same path literal as `--carrier-root`.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const CANONICAL_CARRIER_ROOT_DECL =
  'const canonicalCarrierRoot = path.join(path.dirname(mainCheckoutNotesTmp), "cross-review");';

const RENDERER_DEP_LINKS = [
  "lib",
  "hooks",
  "validate-second-review-packet.mjs",
  "second-reviewer-cli-recipe-contract.mjs",
    "highest-tier-reviewer-model.mjs",
  "second-review-material-contract.mjs",
  "select-claude-second-reviewer-effort.mjs",
  "write-second-review-sticky-gated.mjs",
];

const preparedByFixture = new Map();

export function ownedCarrierRootFor(fixtureDir) {
  return path.join(fixtureDir, "owned-cross-review");
}

/**
 * Replace the production canonicalCarrierRoot declaration with an owned
 * absolute-path literal. Throws when the declaration is missing or duplicated
 * (F-1: mutation hit-count assert).
 */
export function relocateCanonicalCarrierRoot(source, ownedCarrierRoot) {
  assert.equal(
    typeof ownedCarrierRoot,
    "string",
    "ownedCarrierRoot must be a path string literal target",
  );
  assert.ok(ownedCarrierRoot.length > 0, "ownedCarrierRoot must be non-empty");
  const replacement = `const canonicalCarrierRoot = ${JSON.stringify(ownedCarrierRoot)};`;
  let hits = 0;
  const mutated = source.replaceAll(CANONICAL_CARRIER_ROOT_DECL, () => {
    hits += 1;
    return replacement;
  });
  if (hits !== 1) {
    throw new Error(
      `owned-canonical mutation expected exactly 1 hit for canonicalCarrierRoot decl, got ${hits}`,
    );
  }
  return mutated;
}

function ensureSymlink(target, dest) {
  try {
    const stat = lstatSync(dest);
    if (stat.isSymbolicLink() || stat.isDirectory() || stat.isFile()) return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  try {
    symlinkSync(target, dest);
  } catch (error) {
    // Race / dangling leftover: if something already occupies dest, leave it.
    if (error?.code === "EEXIST") return;
    throw error;
  }
}

/**
 * Prepare a mutated renderer copy under fixtureDir whose canonicalCarrierRoot
 * binds the owned path, and whose --carrier-root MUST be that same literal.
 */
export function prepareOwnedCanonicalRenderer({
  fixtureDir,
  repoRoot,
  rendererPath,
  ownedCarrierRoot: ownedCarrierRootOption,
  extraMutate = (source) => source,
  cache = true,
} = {}) {
  assert.ok(fixtureDir, "fixtureDir is required");
  assert.ok(repoRoot, "repoRoot is required");
  assert.ok(rendererPath, "rendererPath is required");

  const fixtureKey = path.resolve(fixtureDir);
  const cacheKey = ownedCarrierRootOption
    ? `${fixtureKey}::${path.resolve(ownedCarrierRootOption)}`
    : fixtureKey;
  if (cache && preparedByFixture.has(cacheKey)) {
    const cached = preparedByFixture.get(cacheKey);
    if (existsSync(cached.mutatedRendererPath)) return cached;
    preparedByFixture.delete(cacheKey);
  }

  const ownedCarrierRoot = ownedCarrierRootOption ?? ownedCarrierRootFor(fixtureDir);
  mkdirSync(ownedCarrierRoot, { recursive: true });

  const isolatedScriptDir = path.join(fixtureDir, "owned-canonical-scripts");
  mkdirSync(isolatedScriptDir, { recursive: true });
  const scriptsDir = path.join(repoRoot, ".devpro/scripts");

  for (const rel of RENDERER_DEP_LINKS) {
    ensureSymlink(path.join(scriptsDir, rel), path.join(isolatedScriptDir, rel));
  }

  const original = readFileSync(rendererPath, "utf8");
  let mutated = relocateCanonicalCarrierRoot(original, ownedCarrierRoot);
  mutated = extraMutate(mutated);
  // F-1: after extraMutate the owned literal must remain the bound value.
  const expectedBind = `const canonicalCarrierRoot = ${JSON.stringify(ownedCarrierRoot)};`;
  assert.ok(
    mutated.includes(expectedBind),
    "extraMutate must retain the owned canonicalCarrierRoot path literal bind",
  );
  const repoRootDecl = 'const repoRoot = path.resolve(rendererScriptDir, "../..");';
  let repoRootHits = 0;
  mutated = mutated.replaceAll(repoRootDecl, () => {
    repoRootHits += 1;
    return `const repoRoot = ${JSON.stringify(repoRoot)};`;
  });
  if (repoRootHits !== 1) {
    throw new Error(
      `owned-canonical mutation expected exactly 1 hit for repoRoot decl, got ${repoRootHits}`,
    );
  }

  const mutatedRendererPath = path.join(isolatedScriptDir, "render-second-review-packet.mjs");
  writeFileSync(mutatedRendererPath, mutated, "utf8");

  const prepared = {
    ownedCarrierRoot,
    /** Absolute owned path literal — MUST be passed as --carrier-root unchanged. */
    carrierRootArg: ownedCarrierRoot,
    mutatedRendererPath: realpathSync(mutatedRendererPath),
    isolatedScriptDir,
  };
  if (cache) preparedByFixture.set(cacheKey, prepared);
  return prepared;
}

export function clearOwnedCanonicalCache(fixtureDir) {
  if (fixtureDir == null) {
    preparedByFixture.clear();
    return;
  }
  const root = path.resolve(fixtureDir);
  for (const key of [...preparedByFixture.keys()]) {
    if (
      key === root
      || key.startsWith(`${root}${path.sep}`)
      || key.startsWith(`${root}::`)
    ) {
      preparedByFixture.delete(key);
    }
  }
}

export function assertAttemptUnderOwnedRoot(attemptOrPacketPath, ownedCarrierRoot) {
  const attemptDir = attemptOrPacketPath.endsWith("packet.md")
    || attemptOrPacketPath.endsWith(`${path.sep}packet.md`)
    ? path.dirname(attemptOrPacketPath)
    : attemptOrPacketPath;
  const resolvedAttempt = path.resolve(attemptDir);
  const resolvedOwned = path.resolve(ownedCarrierRoot);
  const relative = path.relative(resolvedOwned, resolvedAttempt);
  assert.ok(
    relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative),
    `attempt path ${resolvedAttempt} must resolve under owned root ${resolvedOwned}`,
  );
}

/**
 * F-2: refuse any test helper write that targets the live canonical root.
 * Production renderer + live is the original ban; owned helpers must also
 * never pass the live path as `--carrier-root`.
 */
export function assertNotLiveWrite(rendererPath, carrierRoot, liveCanonicalRoot, productionRendererPath) {
  const writingLive = path.resolve(carrierRoot) === path.resolve(liveCanonicalRoot);
  if (writingLive) {
    const usingProduction = path.resolve(rendererPath) === path.resolve(productionRendererPath);
    throw new Error(
      usingProduction
        ? "F-2: forbid unmutated production-renderer live-write; use prepareOwnedCanonicalRenderer"
        : "F-2: forbid live canonical carrier write from test helpers; pass owned carrierRootArg",
    );
  }
}
