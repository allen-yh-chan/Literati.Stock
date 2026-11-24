import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";



function digestPath() {
  const active = "openspec/changes/add-agent-reference-digest/skill-evaluation.md";
  if (existsSync(repoPath(active))) return active;

  const archiveRoot = repoPath("openspec/changes/archive");
  const match = readdirSync(archiveRoot)
    .filter((entry) => entry.endsWith("-add-agent-reference-digest"))
    .sort()
    .at(-1);
  assert.ok(match, "archived add-agent-reference-digest change missing");
  return `openspec/changes/archive/${match}/skill-evaluation.md`;
}

function literalRe(phrase) {
  return new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

// Bilingual use-when trigger wording matcher (same semantics as lint-agent-skills.mjs's
// SSOT detection regex, T5); accepts English "Use when" or Chinese 使用時機/當…時 wording.
const USE_WHEN_BILINGUAL_RE = /use when|使用時機|當[^。]*時/i;

// Runtime skill discovery dirs (.claude/skills, .agents/skills) must hold
// only the single `devpro` entry (design D3, refactor-agent-skills-entry),
// resolving to the catalog root itself — never a per-skill link; absence of
// the discovery dir itself is fine.
function assertSkillDiscoveryDirIsSymlinksOnly(dirRelPath) {
  const dirAbs = repoPath(dirRelPath);
  if (!existsSync(dirAbs)) return;
  const sourceRootAbs = path.join(REPO_ROOT, ".devpro", "agent-skills");
  assert.deepEqual(
    readdirSync(dirAbs),
    ["devpro"],
    `${dirRelPath} must hold only the 'devpro' entry, not a per-skill link`
  );
  const entryAbs = path.join(dirAbs, "devpro");
  assert.equal(lstatSync(entryAbs).isSymbolicLink(), true, `${dirRelPath}/devpro must be a symlink`);
  assert.equal(
    realpathSync(entryAbs),
    realpathSync(sourceRootAbs),
    `${dirRelPath}/devpro must resolve to the catalog root itself`
  );
}

test("agent reference digest covers the new refs and verdicts", () => {
  const digest = read(digestPath());
  for (const phrase of [
    "refs/agent-skills-main",
    "refs/design-doc-mermaid-main",
    "refs/ponytail-main",
    "adopt-rewrite",
    "keep-existing",
    "mine-only",
    "Knowledge Digest",
    "Ingest-Mapping Ledger",
  ]) {
    assert.match(digest, literalRe(phrase));
  }
});

test("agent reference digest records direct-copy exclusions", () => {
  const digest = read(digestPath());
  for (const phrase of [
    "No `refs/agent-skills-main/skills/**` copied",
    "No `refs/design-doc-mermaid-main/SKILL.md` copied",
    "No `refs/design-doc-mermaid-main/scripts/**` copied",
    "No `refs/ponytail-main/skills/**` copied",
    "No root `skills/`",
    "No `.claude/skills`",
    "No package/dependency changes",
  ]) {
    assert.match(digest, literalRe(phrase));
  }
  assert.equal(existsSync(repoPath("skills")), false);
  assertSkillDiscoveryDirIsSymlinksOnly(".claude/skills");
});

test("adopted digest anchors landed in Devpro SSOT files", () => {
  const skillGovernance = read(".devpro/agent-rules/agent-skill-governance.md");
  const openspecQuality = read(".devpro/agent-rules/openspec-quality-and-formats.md");
  // Diagram / Mermaid Evidence moved to sibling (rationalize-overbundled-entry-leaves T2)
  const openspecQualityAdvanced = read(".devpro/agent-rules/openspec-quality-advanced-patterns.md");
  const overDesign = read(".devpro/agent-rules/pre-implementation-over-design.md");
  const mermaidSkill = read(".devpro/agent-skills-refs/documentation/design-doc-mermaid/SKILL.md");
  assert.match(skillGovernance, /routing metadata/);
  assert.match(skillGovernance, /process summary/);
  assert.match(openspecQualityAdvanced, /Diagram \/ Mermaid Evidence/);
  assert.match(openspecQualityAdvanced, /Source-grounded/);
  assert.match(openspecQualityAdvanced, /Validate-before-finalize/);
  assert.match(openspecQualityAdvanced, /Readable contrast/);
  assert.match(openspecQuality, /Spec Implementation Carrier/);
  assert.match(openspecQuality, /spec-only requirement/);
  assert.match(mermaidSkill, /design-doc-mermaid/);
  assert.match(mermaidSkill, USE_WHEN_BILINGUAL_RE);
  assert.match(mermaidSkill, /Source-grounded/);
  assert.match(mermaidSkill, /Validate-before-finalize/);
  assert.match(mermaidSkill, /Readable contrast/);
  assert.match(mermaidSkill, /unvalidated/);
  assert.match(mermaidSkill, /No asset churn/);
  assert.match(overDesign, /Simplicity Ladder/);
  assert.match(overDesign, /Bounded Shortcut Evidence/);
});

test("adopted OpenSpec requirements name implementation carriers", () => {
  const spec = read("openspec/specs/reusable-skill-adoption/spec.md");
  const delta = read("openspec/changes/archive/2026-06-16-add-agent-reference-digest/specs/reusable-skill-adoption/spec.md");
  for (const content of [spec, delta]) {
    assert.match(content, /Spec Requirement Implementation Carrier/);
    assert.match(content, /Spec text alone MUST NOT be treated as implementation/);
    // live spec now uses the retired-refs-root path `.devpro/agent-skills-refs/...`;
    // the archived pre-migration delta still carries the old `.devpro/agent-skills/...`
    // root verbatim (frozen historical content, out of this sweep's scope).
    assert.match(content, /\.devpro\/agent-skills(?:-refs)?\/documentation\/design-doc-mermaid\/SKILL\.md/);
    assert.match(content, /Mermaid guidance has an agent skill carrier/);
  }
});

test("refs remain untracked reference material", () => {
  const tracked = execFileSync("git", ["ls-files", "refs"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(tracked.trim(), "", `refs files must not be tracked:\n${tracked}`);
});
