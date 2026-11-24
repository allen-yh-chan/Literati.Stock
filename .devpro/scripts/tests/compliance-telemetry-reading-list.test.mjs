/**
 * compliance-telemetry-reading-list.test.mjs
 *
 * Unit tests for compliance-telemetry.mjs --reading-list mode.
 *
 * Test cases:
 *   1. parseAgentReadingList — 5 subagent 各抽出非空清單
 *   2. 下界斷言：3 個 subagent 必含特定檔
 *   3. Reference integrity：每抽出檔在 .devpro/agent-rules/ 實際存在
 *   4. Mutex flag CLI test（--reading-list + --days exit 2）
 *   5. Reading-list mode CLI test（exit 0 + markdown header + 5 subagent names）
 */

import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";

const scriptPath = repoPath(".devpro/scripts/compliance-telemetry.mjs");

test("compliance telemetry converts import.meta.url with fileURLToPath", async () => {
  const source = await fs.readFile(scriptPath, "utf8");
  assert.doesNotMatch(source, /new URL\(import\.meta\.url\)\.pathname/);
  assert.match(source, /fileURLToPath\(import\.meta\.url\)/);
});

// Import the exported functions from the script under test
const { parseAgentReadingList, analyzeSubagentReadingList } = await import(pathToFileURL(scriptPath).href);

const SUBAGENTS = [
  "dp-analyst",
  "dp-architect",
  "dp-reviewer",
  "dp-programmer",
  "dp-assistant",
];

// Helper: read agent file content
async function readAgentContent(name) {
  const agentPath = path.join(REPO_ROOT, `.claude/agents/${name}.md`);
  return fs.readFile(agentPath, "utf8");
}

// ---------------------------------------------------------------------------
// Test 1: parseAgentReadingList — 5 subagent 各抽出非空清單
// ---------------------------------------------------------------------------

describe("parseAgentReadingList — 5 subagent 各抽出非空清單", () => {
  it("dp-analyst reading list 含 ≥ 1 個檔", async () => {
    const content = await readAgentContent("dp-analyst");
    const files = parseAgentReadingList(content);
    assert.ok(files.length >= 1, `dp-analyst: expected ≥ 1 file, got ${files.length}`);
  });

  it("dp-architect reading list 含 ≥ 1 個檔", async () => {
    const content = await readAgentContent("dp-architect");
    const files = parseAgentReadingList(content);
    assert.ok(files.length >= 1, `dp-architect: expected ≥ 1 file, got ${files.length}`);
  });

  it("dp-reviewer reading list 含 ≥ 1 個檔", async () => {
    const content = await readAgentContent("dp-reviewer");
    const files = parseAgentReadingList(content);
    assert.ok(files.length >= 1, `dp-reviewer: expected ≥ 1 file, got ${files.length}`);
  });

  it("dp-programmer reading list 為空（無正式 reading list 段，strict mode）", async () => {
    const content = await readAgentContent("dp-programmer");
    const files = parseAgentReadingList(content);
    assert.deepEqual(files, [], `dp-programmer 無讀取以下規則檔案段，應返回空 array（strict mode），got [${files.join(", ")}]`);
  });

  it("dp-assistant parseAgentReadingList 返回 array（不崩潰；此 agent 無 reading list）", async () => {
    const content = await readAgentContent("dp-assistant");
    const files = parseAgentReadingList(content);
    assert.ok(Array.isArray(files), "parseAgentReadingList should return an array");
    // dp-assistant is a mechanical executor agent with no rule reading list
    assert.equal(files.length, 0, `dp-assistant should have 0 reading list files, got ${files.length}`);
  });
});

// ---------------------------------------------------------------------------
// Test 2: 下界斷言：3 個 subagent 必含特定檔
// ---------------------------------------------------------------------------

describe("下界斷言：特定 subagent 必含指定規則檔", () => {
  it("dp-analyst reading list 含 preflight-checklist.md", async () => {
    const content = await readAgentContent("dp-analyst");
    const files = parseAgentReadingList(content);
    assert.ok(
      files.includes("preflight-checklist.md"),
      `dp-analyst files: [${files.join(", ")}] — expected preflight-checklist.md`
    );
  });

  it("dp-architect reading list 含 openspec-flow.md", async () => {
    const content = await readAgentContent("dp-architect");
    const files = parseAgentReadingList(content);
    assert.ok(
      files.includes("openspec-flow.md"),
      `dp-architect files: [${files.join(", ")}] — expected openspec-flow.md`
    );
  });

  it("dp-reviewer reading list 含 code-review-checklist.md", async () => {
    const content = await readAgentContent("dp-reviewer");
    const files = parseAgentReadingList(content);
    assert.ok(
      files.includes("code-review-checklist.md"),
      `dp-reviewer files: [${files.join(", ")}] — expected code-review-checklist.md`
    );
  });
});

// ---------------------------------------------------------------------------
// Test 3: Reference integrity：每抽出檔在 .devpro/agent-rules/ 實際存在
// ---------------------------------------------------------------------------

describe("Reference integrity：抽出檔在 .devpro/agent-rules/ 實際存在", () => {
  for (const name of SUBAGENTS) {
    it(`${name}: 所有 reading list 檔案存在於磁碟`, async () => {
      const content = await readAgentContent(name);
      const files = parseAgentReadingList(content);
      const missing = files.filter(
        (f) => !existsSync(path.join(REPO_ROOT, ".devpro/agent-rules", f))
      );
      assert.deepEqual(
        missing,
        [],
        `${name}: missing files — [${missing.join(", ")}]`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Test 4: Mutex flag CLI test
// ---------------------------------------------------------------------------

describe("Mutex flag CLI test", () => {
  it("--reading-list + --days exit 2 且 stderr 含 'mutually exclusive'", () => {
    const result = spawnSync(
      "node",
      [scriptPath, "--reading-list", "--days", "30"],
      { encoding: "utf8" }
    );
    assert.equal(
      result.status,
      2,
      `expected exit 2, got ${result.status}. stderr: ${result.stderr}`
    );
    assert.ok(
      result.stderr.includes("mutually exclusive"),
      `stderr does not contain "mutually exclusive": ${result.stderr}`
    );
  });

  it("--reading-list + --limit exit 2 且 stderr 含 'mutually exclusive'", () => {
    const result = spawnSync(
      "node",
      [scriptPath, "--reading-list", "--limit", "10"],
      { encoding: "utf8" }
    );
    assert.equal(
      result.status,
      2,
      `expected exit 2, got ${result.status}. stderr: ${result.stderr}`
    );
    assert.ok(
      result.stderr.includes("mutually exclusive"),
      `stderr does not contain "mutually exclusive": ${result.stderr}`
    );
  });

  it("--reading-list + --days=30 (= form) exit 2 且 stderr 含 'mutually exclusive'", () => {
    const result = spawnSync(
      "node",
      [scriptPath, "--reading-list", "--days=30"],
      { encoding: "utf8" }
    );
    assert.equal(
      result.status,
      2,
      `expected exit 2, got ${result.status}. stderr: ${result.stderr}`
    );
    assert.match(result.stderr, /mutually exclusive/);
  });

  it("--reading-list + --limit=10 (= form) exit 2 且 stderr 含 'mutually exclusive'", () => {
    const result = spawnSync(
      "node",
      [scriptPath, "--reading-list", "--limit=10"],
      { encoding: "utf8" }
    );
    assert.equal(
      result.status,
      2,
      `expected exit 2, got ${result.status}. stderr: ${result.stderr}`
    );
    assert.match(result.stderr, /mutually exclusive/);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Reading-list mode CLI test
// ---------------------------------------------------------------------------

describe("Reading-list mode CLI test", () => {
  it("module import does not execute live PR telemetry", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(pathToFileURL(scriptPath).href)}); console.log("import-ok");`,
      ],
      { encoding: "utf8" }
    );
    assert.equal(
      result.status,
      0,
      `expected import exit 0, got ${result.status}. stderr: ${result.stderr}`
    );
    assert.equal(result.stdout.trim(), "import-ok");
    assert.equal(result.stderr, "");
  });

  it("--reading-list exit 0, stdout 含 H1 header 和 5 subagent 名稱", () => {
    const result = spawnSync("node", [scriptPath, "--reading-list"], {
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      0,
      `expected exit 0, got ${result.status}. stderr: ${result.stderr}`
    );

    const stdout = result.stdout;

    assert.ok(
      stdout.includes("# Subagent Reading List Footprint Telemetry"),
      `stdout missing H1 header. stdout starts: ${stdout.slice(0, 200)}`
    );
    assert.match(stdout, /\| File \| Bytes \| Tokens \|/);
    assert.match(stdout, /\| Subagent \| Total Bytes \| Total Tokens \|/);

    for (const name of SUBAGENTS) {
      assert.ok(
        stdout.includes(name),
        `stdout missing subagent name "${name}"`
      );
    }
  });
});
