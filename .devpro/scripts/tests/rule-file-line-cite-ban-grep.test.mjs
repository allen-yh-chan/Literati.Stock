import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";
import { ruleFileLineCites } from "./lib/rule-file-line-cites.mjs";

// No scanned carrier cites a rule file by line number in a listed form (the forms are listed in
// lib/rule-file-line-cites.mjs; a line number on a different line from the file name is not caught).
// The same staleness was fixed three times (git-branch-naming-and-anchor.md cites in one spec, then
// the rest of that spec and the hooks, then eighteen cites in rule files, a skill, scripts, three
// other specs and a scenario); this scan covers every carrier those fixes touched, so the next one
// fails here instead of waiting to be found.
//
// Scanned: rule files, skills and skill refs, scripts (hooks included), capability specs, scenarios,
// the agent definitions of each host (.claude, .codex, .cursor, .opencode), .github, docs, and the
// root-level markdown files. Not scanned: test files (they hold fixtures of the banned forms),
// change folders under openspec/changes (dated records), docs/skill-evaluations (the same dated
// records, moved out of change folders: their quoted answers carry rule-file line cites verbatim and
// other records hold their sha256, so they stay byte-identical), runtime state, and the host hook and
// settings files outside the agent-definition folders.

const SCAN_ROOTS = [
  ".devpro/agent-rules",
  ".devpro/agent-skills",
  ".devpro/scripts",
  "openspec/specs",
  "scenarios",
  ".claude/agents",
  ".codex/agents",
  ".cursor/agents",
  ".cursor/rules",
  ".opencode/agent",
  ".devpro/agent-skills-refs",
  ".github",
  "docs",
];
// Skips are anchored to a path: a spec, skill or scenario folder that happens to be named "tests"
// or "state" stays in the scan.
const SKIP_PATHS = new Set([".devpro/scripts/tests", ".devpro/scripts/hooks/state", "docs/skill-evaluations"]);
const TEXT_EXTENSIONS = new Set([".md", ".mjs", ".cjs", ".js", ".json", ".yml", ".yaml", ".sh", ".toml"]);

function repoPath(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

function carrierFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || SKIP_PATHS.has(repoPath(full)) ? [] : carrierFiles(full);
    return entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name)) ? [full] : [];
  });
}

function scannedFiles() {
  const rootMarkdown = readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(REPO_ROOT, entry.name));
  return [...SCAN_ROOTS.flatMap((root) => carrierFiles(path.join(REPO_ROOT, root))), ...rootMarkdown];
}

// handoff-cite-gate.mjs prints `ai-autonomy.md:14` as an example of the file:line cite FORM the
// gate accepts from the model; it is a format example, not a pointer the hook relies on.
const LINE_CITE_ALLOWLIST = { ".devpro/scripts/hooks/lib/handoff-cite-gate.mjs": ["ai-autonomy.md:14"] };

test("the scan reaches every carrier kind it claims to cover", () => {
  const files = new Set(scannedFiles().map(repoPath));
  for (const expected of [
    ".devpro/agent-rules/ai-autonomy.md",
    ".devpro/agent-rules/platform-adapters/claude-code.md",
    ".devpro/agent-skills/devpro-workflows/change/SKILL.md",
    ".devpro/scripts/pre-pr-archive-gate.mjs",
    ".devpro/scripts/hooks/pre-tool-gate.mjs",
    ".devpro/scripts/hooks/lib/handoff-cite-gate.mjs",
    "openspec/specs/archive-tooling/spec.md",
    "scenarios/scenario-m-consumer-repo-pre-pr-flow.md",
    ".claude/agents/dp-reviewer.md",
    ".codex/agents/dp-reviewer.toml",
    ".cursor/agents/dp-reviewer.md",
    ".cursor/rules/devpro-policy.md",
    ".opencode/agent/dp-reviewer.md",
    ".github/copilot-instructions.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".devpro/agent-skills-refs/manifest.json",
    "docs/release-notes/pr-3217-capacity-lock-upgrade.md",
    "AGENTS.md",
  ]) {
    assert.ok(existsSync(path.join(REPO_ROOT, expected)), `${expected} must exist`);
    assert.ok(files.has(expected), `${expected} must be scanned`);
  }
  assert.ok(![...files].some((file) => file.startsWith(".devpro/scripts/tests/")), "test files are not scanned");
  assert.ok(![...files].some((file) => file.startsWith("openspec/changes/")), "change folders are not scanned");
  assert.ok(![...files].some((file) => file.startsWith("docs/skill-evaluations/")), "moved evaluation records are not scanned");
});

test("no scanned carrier cites a rule file by line number in a listed form outside the named format example", () => {
  const found = {};
  for (const file of scannedFiles()) {
    const cites = ruleFileLineCites(readFileSync(file, "utf8"));
    if (cites.length > 0) found[repoPath(file)] = cites;
  }
  assert.deepEqual(found, LINE_CITE_ALLOWLIST);
});
