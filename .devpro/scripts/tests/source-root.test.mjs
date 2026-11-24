import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSourceRoot } from "./lib/source-root.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";

test("resolveSourceRoot returns repo root in source repo", () => {
  assert.equal(resolveSourceRoot(REPO_ROOT), REPO_ROOT);
});

test("resolveSourceRoot returns .devpro-agent-rules in consumer-shaped repo", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "source-root-"));
  const sourceRoot = path.join(tmpDir, ".devpro-agent-rules");

  await fs.mkdir(path.join(sourceRoot, ".devpro", "scripts"), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, "AGENTS.md"), "rules\n");
  await fs.writeFile(path.join(sourceRoot, ".devpro", "scripts", "sync-agent-rules.mjs"), "\n");

  try {
    assert.equal(resolveSourceRoot(tmpDir), sourceRoot);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("source-only assertions can read source docs when consumer lacks source specs", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "source-root-docs-"));
  const sourceRoot = path.join(tmpDir, ".devpro-agent-rules");

  await fs.mkdir(path.join(sourceRoot, ".devpro", "scripts"), { recursive: true });
  await fs.mkdir(path.join(sourceRoot, "openspec", "specs", "rules-flow"), { recursive: true });
  await fs.writeFile(path.join(tmpDir, "README.md"), "consumer business readme\n");
  await fs.writeFile(path.join(sourceRoot, "AGENTS.md"), "rules\n");
  await fs.writeFile(path.join(sourceRoot, "README.md"), "source readme\n");
  await fs.writeFile(path.join(sourceRoot, ".devpro", "scripts", "sync-agent-rules.mjs"), "\n");
  await fs.writeFile(path.join(sourceRoot, "openspec", "specs", "rules-flow", "spec.md"), "source spec\n");

  try {
    const resolved = resolveSourceRoot(tmpDir);
    assert.equal(resolved, sourceRoot);
    assert.equal(await fs.readFile(path.join(resolved, "README.md"), "utf8"), "source readme\n");
    assert.equal(
      await fs.readFile(path.join(resolved, "openspec", "specs", "rules-flow", "spec.md"), "utf8"),
      "source spec\n",
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("source-only test entrypoints use the shared source-root resolver", async () => {
  const governanceTest = await fs.readFile(
    path.join(REPO_ROOT, ".devpro", "scripts", "tests", "agent-skill-governance.test.mjs"),
    "utf8",
  );
  const scenariosTest = await fs.readFile(
    path.join(REPO_ROOT, ".devpro", "scripts", "tests", "scenarios.test.mjs"),
    "utf8",
  );

  for (const [name, content] of [
    ["agent-skill-governance.test.mjs", governanceTest],
    ["scenarios.test.mjs", scenariosTest],
  ]) {
    assert.match(
      content,
      /import \{ resolveSourceRoot \} from "\.\/lib\/source-root\.mjs";/,
      `${name} must import the shared source-root resolver`,
    );
    assert.match(
      content,
      /const defaultRepoRoot = path\.resolve\(scriptDir, "\.\.\/\.\.\/\.\."\);/,
      `${name} must keep the script-location default root as input`,
    );
    assert.match(
      content,
      /const repoRoot = resolveSourceRoot\(defaultRepoRoot\);/,
      `${name} must resolve source root before reading source-only artifacts`,
    );
  }
});
