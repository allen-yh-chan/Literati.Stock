import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { SOURCE_ROOT, sourcePath } from "./lib/source-root.mjs";

const vendorLeakRe =
  /CLAUDE\.md|Claude Code|\bClaude\b|Anthropic|OpenAI|\bOpus\b|\bSonnet\b|\bHaiku\b/g;
const deferredTodoRe = /TODO.*(?:future PR|待 future)/g;
const supportLabelRe =
  /\*\*Support\*\*:\s*(?:官方確認|fully implemented|partial support,\s*[^\n]+|not applicable,\s*[^\n]+)/;

const canonicalAdapters = [
  "claude-code",
  "codex",
  "codex-host-cross-review",
  "copilot",
  "cursor",
  "gemini",
];

function read(relPath) {
  return readFileSync(sourcePath(relPath), "utf8");
}

function listFiles(dir, filter) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...listFiles(full, filter));
    } else if (filter(full)) {
      results.push(full);
    }
  }
  return results;
}

function collectMatches(file, regex) {
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");
  const hits = [];
  regex.lastIndex = 0;
  for (let i = 0; i < lines.length; i += 1) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(lines[i])) !== null) {
      hits.push(`${path.relative(SOURCE_ROOT, file)}:${i + 1}: ${match[0]}`);
    }
  }
  return hits;
}

function sharedRuleFiles() {
  const root = sourcePath(".devpro/agent-rules");
  const adapterDir = `${path.sep}platform-adapters${path.sep}`;
  return listFiles(root, (file) => file.endsWith(".md") && !file.includes(adapterDir));
}

function hookEntrypoints() {
  const hookDir = sourcePath(".devpro/scripts/hooks");
  return readdirSync(hookDir)
    .filter((entry) => entry.endsWith(".mjs"))
    .map((entry) => path.join(hookDir, entry));
}

function capabilityNames() {
  return [...read(".devpro/agent-rules/observability-capabilities.md").matchAll(
    /^### Capability: (.+)$/gm,
  )].map((match) => match[1].trim());
}

test("shared rules and hook entrypoints do not contain vendor/model leak markers", () => {
  const failures = [];
  for (const file of [...sharedRuleFiles(), ...hookEntrypoints()]) {
    failures.push(...collectMatches(file, vendorLeakRe));
  }

  assert.deepEqual(
    failures,
    [],
    "Vendor/model markers belong in platform adapters or hook libraries, not shared rules or hook entrypoints.",
  );
});

test("platform adapters do not carry deferred future TODO placeholders", () => {
  const adapterDir = sourcePath(".devpro/agent-rules/platform-adapters");
  const failures = [];
  for (const file of listFiles(adapterDir, (entry) => entry.endsWith(".md"))) {
    failures.push(...collectMatches(file, deferredTodoRe));
  }

  assert.deepEqual(
    failures,
    [],
    "Adapters must use support labels and fallback text instead of TODO future placeholders.",
  );
});

// claude-code adapter splits capabilities into a sibling file; read both as a logical unit.
function readAdapterContent(adapter) {
  const relPath = `.devpro/agent-rules/platform-adapters/${adapter}.md`;
  let content = read(relPath);
  if (adapter === "claude-code") {
    content += "\n" + read(".devpro/agent-rules/platform-adapters/claude-code-capabilities.md");
  }
  return content;
}

// Anchor on the capability's own heading, not its first literal mention: a pointer sentence
// (e.g. "see §<capability>") that precedes the heading must not move the Support-label window.
function locateCapabilitySection(content, capability) {
  const escaped = capability.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^#{2,4} (?:Capability: )?${escaped}\\s*$`, "m").exec(content);
  return heading ? content.slice(heading.index, heading.index + 700) : null;
}

test("locateCapabilitySection anchors on the heading, not the first mention", () => {
  const content = [
    "Intro: 見 §Load-Plan Capability 的說明。",
    "x".repeat(800),
    "### Load-Plan Capability",
    "",
    "**Support**: fully implemented via hooks.",
    "",
  ].join("\n");
  const section = locateCapabilitySection(content, "Load-Plan Capability");
  assert.ok(section?.startsWith("### Load-Plan Capability"), "section must start at the heading");
  assert.match(section, supportLabelRe);
  assert.equal(locateCapabilitySection("only a pointer: Load-Plan Capability\n", "Load-Plan Capability"), null);
  assert.ok(locateCapabilitySection("## Capability: Load-Plan Capability\n", "Load-Plan Capability"));
});

test("canonical adapters cover every observability capability with a support label", () => {
  const capabilities = capabilityNames();
  assert.ok(capabilities.length > 0, "No capabilities found in observability-capabilities.md");

  const failures = [];
  for (const adapter of canonicalAdapters) {
    const relPath = `.devpro/agent-rules/platform-adapters/${adapter}.md`;
    const content = readAdapterContent(adapter);
    for (const capability of capabilities) {
      const section = locateCapabilitySection(content, capability);
      if (section === null) {
        failures.push(`${relPath}: missing capability heading "${capability}"`);
        continue;
      }

      if (!supportLabelRe.test(section)) {
        failures.push(`${relPath}: "${capability}" missing allowed Support label`);
      }
    }
  }

  assert.deepEqual(
    failures,
    [],
    "Each canonical adapter must list every observability capability and one allowed Support label.",
  );
});
