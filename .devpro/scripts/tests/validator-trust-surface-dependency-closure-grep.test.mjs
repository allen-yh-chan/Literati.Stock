import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoPath } from "./lib/repo-root.mjs";

const ROOTS = [
  ".devpro/scripts/review-remediation-evidence.mjs",
  ".devpro/scripts/lib/review-remediation-evidence-core.mjs",
];

// Derive expected membership from real production imports, independently of the
// runtime's explicit path inventory. Behavioral routing is exercised separately
// in review-remediation-evidence.test.mjs.
test("validator trust surface exactly covers the production static import closure", () => {
  const closure = new Set(ROOTS);
  for (const modulePath of closure) {
    const source = readFileSync(repoPath(modulePath), "utf8");
    const imports = /(?:^|[;\n])\s*(?:import\s+(?:[^"'()]*?\s+from\s+)?|export\s+[^"'()]*?\s+from\s+)(["'])([^"']+)\1/gm;
    for (const [, , specifier] of source.matchAll(imports)) {
      if (specifier.startsWith("node:")) continue;
      assert.ok(specifier.startsWith("."), `unexpected production import: ${specifier}`);
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(modulePath), specifier));
      assert.ok(!dependency.startsWith("../"), `dependency escapes repo: ${dependency}`);
      closure.add(dependency);
    }
  }
  const core = readFileSync(repoPath(ROOTS[1]), "utf8");
  const paths = core.match(/const VALIDATOR_TRUST_SURFACE_PATHS = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(paths, "runtime trust inventory must be explicit and discoverable");
  const roots = core.match(/const VALIDATOR_TRUST_SURFACE_ROOTS = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(roots, "canonical validator roots must be explicit");
  const declaredRoots = [...roots[1].matchAll(/"([^"\n]+)"/g)].map((match) => match[1]);
  assert.deepEqual(declaredRoots.sort(), [...ROOTS].sort(), "both canonical entrypoints must revoke dependency-only pre-existing trust");
  let inventory = paths[1];
  if (inventory.includes("...VALIDATOR_TRUST_SURFACE_ROOTS")) {
    inventory += roots[1];
  }
  const declared = [...inventory.matchAll(/"([^"\n]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(declared).size, declared.length, "runtime paths must not be duplicated");
  assert.deepEqual(declared.sort(), [...closure].sort());
});
