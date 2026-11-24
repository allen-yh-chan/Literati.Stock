import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { sourcePath } from "./lib/source-root.mjs";
import { readSourceFile as read } from "./lib/read.mjs";



function changeRelPath(changeName, fileName) {
  const activePath = path.join("openspec/changes", changeName, fileName);
  try {
    read(activePath);
    return activePath;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const archiveRoot = sourcePath("openspec/changes/archive");
  const archiveName = readdirSync(archiveRoot)
    .filter((entry) => entry.endsWith(`-${changeName}`))
    .sort()
    .at(-1);
  assert.ok(archiveName, `OpenSpec change not found in active or archive paths: ${changeName}`);
  return path.join("openspec/changes/archive", archiveName, fileName);
}

function assertAll(content, phrases, label) {
  for (const phrase of phrases) {
    assert.ok(content.includes(phrase), `${label} missing required phrase: ${phrase}`);
  }
}

// Enforcement-map rows whose claim is polarity-sensitive (enforced vs `cooperative-only`,
// format-when-present vs presence-gated) cannot be guarded by decoupled includes(): the
// polarity word and its subject would be satisfiable from unrelated lines. Per
// `rule-anchor-guard-strength.md`, bind both on one physical line, and require exactly one
// match so deleting the row turns this red instead of being covered by a sibling row.
function assertRowBound(content, anchors, label) {
  const lines = content.split("\n");
  for (const { name, regex } of anchors) {
    const hits = lines.filter((line) => regex.test(line));
    assert.equal(
      hits.length,
      1,
      `${label} row anchor "${name}" must bind exactly one physical line (matched ${hits.length})`,
    );
  }
}

function extractObservabilityRegistry(content) {
  const marker = "**Canonical adapter registry**";
  const start = content.indexOf(marker);
  assert.ok(start >= 0, "observability-capabilities.md missing canonical adapter registry");
  const end = content.indexOf("\n## ", start + marker.length);
  const section = content.slice(start, end === -1 ? undefined : end);
  return [...section.matchAll(/platform-adapters\/([a-z-]+)\.md/g)].map((match) => match[1]);
}

function extractVendorTestRegistry(content) {
  const match = content.match(/const canonicalAdapters = \[([\s\S]*?)\];/);
  assert.ok(match, "vendor-leak-regression.test.mjs missing canonicalAdapters registry");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

test("OpenSpec flow leaves name mandatory-clause enforcement carriers", () => {
  const flow = read(".devpro/agent-rules/openspec-flow.md");
  const fallback = read(".devpro/agent-rules/openspec-flow-fallback.md");
  const quality = read(".devpro/agent-rules/openspec-quality-and-formats.md");

  assertAll(
    flow,
    [
      "Mandatory Clause Enforcement Map",
      "Principle 6",
      "rule-feedback-openspec-routing-grep.test.mjs",
      "pre-pr-archive-gate.mjs",
      "hook-pre-tool-gate-worktree-mandatory.test.mjs",
      "cooperative-only",
    ],
    "openspec-flow.md",
  );

  assertAll(
    fallback,
    [
      "Mandatory Clause Enforcement Map",
      "platform-adapter-contract.md",
      "openspec-flow-fallback-verb-ssot.test.mjs",
      "pre-pr-archive-gate.mjs",
      "cooperative-only process boundary",
    ],
    "openspec-flow-fallback.md",
  );

  assertAll(
    quality,
    [
      "Mandatory Clause Enforcement Map",
      "pre-pr-archive-gate.mjs",
      "lint-modified-scenario-preservation.mjs",
      "Rule-feedback Surface Matrix",
      "cooperative-only reviewer/process enforcement",
    ],
    "openspec-quality-and-formats.md",
  );

  assertRowBound(
    quality,
    [
      {
        name: "meeting-notes presence is cooperative-only, not gate-enforced",
        regex: /meeting-notes[^\n]*cooperative-only[^\n]*無 hook\/gate 驗其存在/,
      },
      {
        name: "archive artifacts are format-when-present, never presence-gated",
        regex: /format-when-present[^\n]*不驗存在/,
      },
    ],
    "openspec-quality-and-formats.md",
  );
});

test("observability shared registry matches vendor coverage registry", () => {
  const observability = read(".devpro/agent-rules/observability-capabilities.md");
  const vendorTest = read(".devpro/scripts/tests/vendor-leak-regression.test.mjs");

  const observed = extractObservabilityRegistry(observability);
  const enforced = extractVendorTestRegistry(vendorTest);

  assert.deepEqual(observed, enforced);
  assert.equal(observed.length, 6);
});

test("Claude Code hook-unavailable fallback names enforcement boundary", () => {
  const claude = read(".devpro/agent-rules/platform-adapters/claude-code.md");

  assertAll(
    claude,
    [
      "Enforcement boundary",
      "hook-independent leaf + TL process",
      "`cooperative-only` enforcement",
      "openspec-flow-fallback.md",
      "code-review-checklist-fallback.md",
      "非 Claude Code hook 自動證明",
    ],
    "platform-adapters/claude-code.md",
  );
});

test("capability specs capture deferred-audit fixes", () => {
  const openspecFlow = read(
    changeRelPath("rationalize-deferred-audit-fixes", "specs/openspec-flow/spec.md"),
  );
  const crossRuntime = read(
    changeRelPath("rationalize-deferred-audit-fixes", "specs/cross-runtime-parity/spec.md"),
  );

  assertAll(
    openspecFlow,
    [
      "Requirement: Rule Leaf Mandatory Clause Enforcement Maps",
      "mechanical hook/gate/test carrier",
      "`cooperative-only` with rationale",
    ],
    "openspec-flow spec delta",
  );

  assertAll(
    crossRuntime,
    [
      "Requirement: Observability Canonical Adapter Registry Is Explicit",
      "Requirement: Platform Adapter Hook Fallback Boundaries Are Explicit",
      "vendor-leak-regression.test.mjs",
      "hook-independent fallback",
    ],
    "cross-runtime-parity spec delta",
  );
});
