import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSourceRoot } from "./lib/source-root.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDir, "../../..");
const repoRoot = resolveSourceRoot(defaultRepoRoot);
const scenariosDir = path.join(repoRoot, "scenarios");

const REQUIRED_SECTIONS = [
  "## Context",
  "## Preconditions",
  "## Rule Walkthrough",
  "## Negative Checks",
  "## Assertions",
  "## Pass Criteria",
];

async function getScenarioFiles() {
  const entries = await fs.readdir(scenariosDir);
  return entries
    .filter((f) => f.startsWith("scenario-") && f.endsWith(".md"))
    .sort();
}

function extractRuleRefs(content) {
  const refs = new Set();
  const pattern = /rule ref:.*?(\.devpro\/agent-rules\/[\w-]+\.md)/g;
  for (const match of content.matchAll(pattern)) {
    refs.add(match[1]);
  }
  return [...refs];
}

function extractAssertions(content) {
  const assertionsStart = content.indexOf("## Assertions");
  if (assertionsStart === -1) return [];
  const nextSection = content.indexOf(
    "\n## ",
    assertionsStart + "## Assertions".length
  );
  const block = content.slice(
    assertionsStart,
    nextSection > -1 ? nextSection : undefined
  );
  const results = [];
  const pattern = /^- `([^`]+)` contains (?:"([^"]+)"|`([^`]+)`)/gm;
  for (const match of block.matchAll(pattern)) {
    results.push({ file: match[1], expected: match[2] ?? match[3] });
  }
  return results;
}

describe("scenarios", () => {
  it("scenarios/ directory exists and has at least one scenario", async () => {
    const files = await getScenarioFiles();
    console.log(`[scenarios] found ${files.length} scenario files`);
    assert.ok(
      files.length > 0,
      "scenarios/ must contain at least one scenario-*.md file"
    );
  });

  it("each scenario has all required sections", async () => {
    const files = await getScenarioFiles();
    const missing = [];

    for (const file of files) {
      const content = await fs.readFile(path.join(scenariosDir, file), "utf8");
      for (const section of REQUIRED_SECTIONS) {
        if (!content.includes(section)) {
          missing.push(`${file}: missing "${section}"`);
        }
      }
    }

    if (missing.length > 0) {
      console.log("[scenarios] missing sections:\n  " + missing.join("\n  "));
    }
    assert.equal(
      missing.length,
      0,
      `Scenario files missing required sections:\n  ${missing.join("\n  ")}`
    );
  });

  it("each scenario has at least one checkbox in Rule Walkthrough", async () => {
    const files = await getScenarioFiles();
    const noChecks = [];

    for (const file of files) {
      const content = await fs.readFile(path.join(scenariosDir, file), "utf8");
      const walkthroughStart = content.indexOf("## Rule Walkthrough");
      const nextSection = content.indexOf(
        "\n## ",
        walkthroughStart + "## Rule Walkthrough".length
      );
      const walkthrough = content.slice(
        walkthroughStart,
        nextSection > -1 ? nextSection : undefined
      );
      if (!walkthrough.includes("- [ ]")) {
        noChecks.push(file);
      }
    }

    assert.equal(
      noChecks.length,
      0,
      `Scenarios without checkboxes in Rule Walkthrough: ${noChecks.join(", ")}`
    );
  });

  it("rule references point to existing .devpro/agent-rules/*.md files", async () => {
    const files = await getScenarioFiles();
    const broken = [];

    for (const file of files) {
      const content = await fs.readFile(path.join(scenariosDir, file), "utf8");
      const refs = extractRuleRefs(content);
      for (const ref of refs) {
        const fullPath = path.join(repoRoot, ref);
        try {
          await fs.access(fullPath);
        } catch {
          broken.push(`${file}: ${ref}`);
        }
      }
    }

    if (broken.length > 0) {
      console.log(
        "[scenarios] broken rule references:\n  " + broken.join("\n  ")
      );
    }
    assert.equal(
      broken.length,
      0,
      `Broken rule references in scenarios:\n  ${broken.join("\n  ")}`
    );
  });

  it("assertions in scenarios match actual rule file content", async () => {
    const files = await getScenarioFiles();
    const failures = [];
    let totalAssertions = 0;
    const fileCache = new Map();

    async function readCached(filePath) {
      if (!fileCache.has(filePath)) {
        fileCache.set(filePath, await fs.readFile(filePath, "utf8"));
      }
      return fileCache.get(filePath);
    }

    for (const file of files) {
      const content = await fs.readFile(path.join(scenariosDir, file), "utf8");
      const assertions = extractAssertions(content);
      totalAssertions += assertions.length;

      for (const { file: targetFile, expected } of assertions) {
        const fullPath = path.join(repoRoot, targetFile);
        try {
          const targetContent = await readCached(fullPath);
          if (!targetContent.includes(expected)) {
            failures.push(`${file}: "${expected}" not found in ${targetFile}`);
          }
        } catch {
          failures.push(`${file}: file not found: ${targetFile}`);
        }
      }
    }

    console.log(
      `[scenarios] verified ${totalAssertions} assertions across ${files.length} scenarios`
    );

    if (failures.length > 0) {
      console.log(
        "[scenarios] assertion failures:\n  " + failures.join("\n  ")
      );
    }
    assert.equal(
      failures.length,
      0,
      `Scenario assertions failed:\n  ${failures.join("\n  ")}`
    );
  });

  it("Compression resume reads the record instead of re-asking", async () => {
    const scenario = await fs.readFile(
      path.join(scenariosDir, "scenario-ai-consumer-repo-lite-batch-approval.md"),
      "utf8"
    );
    const walkthroughStart = scenario.indexOf("### L2:");
    assert.notEqual(walkthroughStart, -1, "the scenario carries the compression-resume walkthrough step");
    const nextStep = scenario.indexOf("\n### ", walkthroughStart + 1);
    const step = scenario.slice(walkthroughStart, nextStep > -1 ? nextStep : undefined);
    for (const fragment of [
      "session context 被壓縮或重啟",
      "讀 worktree 內 `openspec/changes/<change-name>/lite-scope.md`，不憑記憶、也不重問 batch",
      "命中 `excludes` 的動作（merge、release、destructive、secrets、cross-repo write）仍停下",
    ]) {
      assert.ok(step.includes(fragment), `compression-resume step must keep: ${fragment}`);
    }
    // The two carriers the step depends on say the same thing: read the file after compression, do not ask again.
    const skill = await fs.readFile(
      path.join(repoRoot, ".devpro/agent-skills/devpro-workflows/change/SKILL.md"),
      "utf8"
    );
    const resumeLine = skill.split("\n").filter((line) => line.includes("壓縮或重啟後"));
    assert.equal(resumeLine.length, 1, "the change skill lite section has exactly one compression-resume bullet");
    assert.match(resumeLine[0], /照讀此檔、不重問/);
    const autonomy = await fs.readFile(path.join(repoRoot, ".devpro/agent-rules/ai-autonomy.md"), "utf8");
    assert.ok(autonomy.includes("Matching Batch Approval Ledger = Ask First already satisfied"));
  });
});
