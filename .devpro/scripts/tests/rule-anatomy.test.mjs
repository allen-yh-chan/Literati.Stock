import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";

const rulesDir = path.join(REPO_ROOT, ".devpro", "agent-rules");
const hooksDir = path.join(REPO_ROOT, ".devpro", "scripts", "hooks");

// ── Standard six-section anatomy ────────────────────────────────────────────
// SSOT: rule-file-template.md Section 順序與 5W2H 對應表 row 3 allows either
// `## Process` or `## Rules` for the Who/How section. Section 3 is encoded as
// an alternation list; all other sections are exact strings.
const STANDARD_SECTIONS = [
  "Overview",
  "When to Use",
  ["Process", "Rules"], // Section 3: either header acceptable per template
  "Exit Criteria",
  "Common Rationalizations",
  "Verification",
];

function sectionPresent(content, section) {
  if (Array.isArray(section)) {
    return section.some((h) => new RegExp(`^## ${h}$`, "m").test(content));
  }
  return new RegExp(`^## ${section}$`, "m").test(content);
}

function sectionLabel(section) {
  return Array.isArray(section)
    ? section.map((h) => `## ${h}`).join(" or ")
    : `## ${section}`;
}

// Process-class content: numbered list (`1.`), bullet (`-`/`*`), or table (`|`).
// When a leaf opts into `## Rules`, the body of that section MUST contain at
// least one of these structures so `## Rules` isn't used as an empty placeholder
// (per rule-file-template.md §Process / Rules 格式規則).
function extractSectionBody(content, heading) {
  const startRe = new RegExp(`^## ${heading}\\s*\\n`, "m");
  const m = startRe.exec(content);
  if (!m) return null;
  const startIdx = m.index + m[0].length;
  const rest = content.slice(startIdx);
  const nextHeadingMatch = rest.match(/^## /m);
  return nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest;
}

function hasProcessClassContent(body) {
  if (!body) return false;
  return /^\s*\d+\.\s+/m.test(body) || /^\s*[-*]\s+/m.test(body) || /^\|/m.test(body);
}

// Pure validator used by the file-iterating `it()` block AND by fixture-driven
// unit tests. Returns null when the file does not opt into `## Rules`, the
// section name when it does and content is valid, or a failure message string.
function validateRulesSection(content, filename) {
  if (!/^## Rules$/m.test(content)) return null;
  const body = extractSectionBody(content, "Rules");
  if (!hasProcessClassContent(body)) {
    return `${filename}: "## Rules" section must contain Process-class content (numbered list / bullet / table) per rule-file-template.md`;
  }
  return null;
}

// ── Exception files with alternative headers (per D4) ────────────────────────
// Update this list whenever a rule file intentionally deviates from the
// standard six-section layout.
const EXCEPTION_FILES = {
  "csharp-style-and-dry.md": ["Overview", "When to Use", "Rules", "Examples", "Verification"],
  "project-structure-sln-and-folders.md": ["Overview", "When to Use", "Rules", "Examples", "Verification"],
  "anti-patterns-examples.md": ["Overview", "When to Use", "Process", "Exit Criteria", "Verification"],
  "preflight-checklist.md": ["When to Use", "Process", "Example"],
  "rule-file-template.md": ["Overview", "When to Use", "Exit Criteria", "Common Rationalizations"],
  "proposal-template.md": ["Overview", "When to Use", "Required Sections", "Exit Criteria", "Cross-References"],
  // T3 (amend-openspec-artifact-model): design-template.md is a sibling of
  // proposal-template.md, aligned in structure (Overview / When to Use /
  // Required Sections / Exit Criteria / Cross-References) but not the
  // standard 6-section H2 anatomy.
  "design-template.md": ["Overview", "When to Use", "Required Sections", "Exit Criteria", "Cross-References"],
  "branch-terminology-glossary.md": ["可促進單位 \\(Promotable Unit\\)", "Anchor", "Subset", "Discovery"],
  // Load-chain on-demand sibling leaves (rationalize-overbundled-entry-leaves T1):
  // These are pure content-move siblings of model-delegation.md. They hold moved
  // H3-level sections and do not follow the standard 6-section H2 anatomy.
  // Each has frontmatter + Load-chain back-reference + verbatim moved H3 content.
  "model-delegation-briefing.md": [],
  // Load-chain on-demand sibling of model-delegation-briefing.md: the Active Delegation
  // Interruption Gate and Subagent Artifact Landing Verification, moved verbatim.
  // Frontmatter + H1 + Load-chain back-reference.
  "model-delegation-active-lifecycle.md": [],
  "model-delegation-delegation-rules.md": [],
  "model-delegation-token-efficiency.md": [],
  // Load-chain on-demand sibling leaves (rationalize-overbundled-entry-leaves T2):
  // These are pure content-move siblings of openspec-quality-and-formats.md. They hold
  // moved H3-level sections and do not follow the standard 6-section H2 anatomy.
  // Each has frontmatter + Load-chain back-reference + verbatim moved H3 content.
  "openspec-quality-doc-formats.md": [],
  "openspec-quality-advanced-patterns.md": [],
  // Load-chain on-demand sibling leaf (rationalize-overbundled-entry-leaves T3):
  // Pure content-move sibling of openspec-flow-consumer.md. Holds the 3 moved H3
  // sections (Program Tracker Mode + Issue-first + Local-MD) and does not follow
  // the standard 6-section H2 anatomy.
  // Has frontmatter + Load-chain back-reference + verbatim moved H3 content.
  "program-tracker-mode.md": [],
  // Load-chain on-demand sibling leaf (strengthen-program-tracker-planning-state):
  // Newly-authored planning-state content, not moved from program-tracker-mode.md
  // (design.md D1: existing content is not relocated). Holds 5 H3 sections (既有
  // Program 的過渡 / Program 目的地 / 還講不清的部分 / 不做的部分 / 卡關關係與
  // 認領判定) and does not follow the standard 6-section H2 anatomy.
  // Has frontmatter + Load-chain back-reference.
  "program-planning-state.md": [],
  // Load-chain on-demand sibling leaves (rationalize-overbundled-entry-leaves T4):
  // These are pure content-move siblings of release-sit-uat-pat-prod.md. They hold
  // moved H3-level sections (step 1-7 execution recipe and Rules Lane consumer lane)
  // and do not follow the standard 6-section H2 anatomy.
  // Each has frontmatter + Load-chain back-reference + verbatim moved content.
  "release-step-1-7.md": [],
  "release-rules-lane.md": [],
  // Load-chain on-demand sibling of release-step-1-7.md: the Step 7 hotfix
  // release-carrier recipe and grandfathered completion, moved verbatim as H3
  // sections. Frontmatter + H1 + Load-chain back-reference + verbatim moved content.
  "release-hotfix-carrier-lane.md": [],
  // Load-chain on-demand sibling of release-step-1-7.md: the Step 6A command
  // blocks and routing bullets, moved verbatim. Frontmatter + H1 + Load-chain back-reference.
  "release-back-merge-completion.md": [],
  // Load-chain on-demand sibling of release-sit-uat-pat-prod.md: the hotfix carrier lane
  // normative clauses, moved verbatim. Frontmatter + H1 + Load-chain back-reference.
  "release-hotfix-carrier-policy.md": [],
  // Load-chain on-demand sibling of release-sit-uat-pat-prod.md: the branch-level milestone
  // assignment command block, moved verbatim. Frontmatter + H1 + Load-chain back-reference.
  "release-milestone-assignment.md": [],
  // Load-chain on-demand sibling of release-sit-uat-pat-prod.md: the post-release verification
  // command block, moved verbatim. Frontmatter + H1 + Load-chain back-reference.
  "release-verification-commands.md": [],
  // Load-chain on-demand sibling of post-pr-completion-gate.md: the Stop hook time budget and
  // execution-location details, moved verbatim. Frontmatter + H1 + Load-chain back-reference.
  "post-pr-stop-hook-runtime.md": [],
  // Load-chain on-demand sibling of post-pr-completion-gate.md: the non-PASS runner marker
  // branches, external marker disposition and lifecycle durability, moved verbatim.
  "post-pr-marker-disposition.md": [],
  // Load-chain on-demand sibling of post-pr-completion-gate.md: the WARN Decision Contract and
  // the post-archive carrier-repair evidence alignment (one relative reference rewritten).
  "post-pr-warn-repair.md": [],
  // Load-chain on-demand sibling of session-recap.md: the advanced Token 回顧 scenarios and the
  // structured claim field block, moved verbatim. Frontmatter + H1 + Load-chain back-reference.
  "session-recap-token-usage.md": [],
  // Load-chain on-demand sibling of environment-setup-nvm-nodejs-openspec.md: the per-stage
  // behaviour of the class 2 environment entry, moved verbatim.
  "environment-class2-checks.md": [],
  // Load-chain on-demand sibling of openspec-quality-and-formats.md: the recognition and
  // implementation boundaries of the requirement count ratchet gate, moved verbatim.
  "requirement-count-ratchet-internals.md": [],
  // Load-chain on-demand sibling of openspec-quality-and-formats.md: conditional spec delta
  // pitfalls, moved verbatim. Frontmatter + H1 + Load-chain back-reference.
  "openspec-spec-delta-pitfalls.md": [],
  // Load-chain on-demand sibling of openspec-quality-and-formats.md: scope change re-entry flow,
  // hard gate and stop-loss, moved verbatim. Frontmatter + H1 + Load-chain back-reference.
  "openspec-scope-change.md": [],
  // Load-chain on-demand sibling of openspec-archive-principles.md: pre-merge archive re-do,
  // the Undo-Archive Preserve Checklist and the check (h) exception, moved verbatim.
  // Frontmatter + H1 + Load-chain back-reference.
  "openspec-archive-redo-undo.md": [],
  // Load-chain on-demand sibling of troubleshooting.md: the Post-Intervention Exact-Case
  // Recovery Gate, moved verbatim. Frontmatter + H1 + Load-chain back-reference.
  "post-intervention-recovery-gate.md": [],
  // Load-chain on-demand siblings of rules-flow.md: the Rollback SOP and the post-merge
  // production continuation bullets, moved verbatim. Frontmatter + H1 + Load-chain back-reference.
  "rules-flow-rollback.md": [],
  "rules-flow-production-continuation.md": [],
  // Load-chain on-demand siblings of git-branch-naming-and-anchor.md: the two no-tag ancestry
  // evidence checklists and the Production ancestry repair body, moved verbatim (original
  // heading levels kept). Frontmatter + H1 + Load-chain back-reference.
  "git-branch-no-tag-ancestry-evidence.md": [],
  "git-branch-production-ancestry-repair.md": [],
  // Load-chain on-demand leaf of testing-and-qa.md: §Source Repo Test Runtime Budget
  // (test suite cadence SSOT), moved verbatim. Frontmatter + H1 + Load-chain back-reference.
  "test-suite-cadence.md": [],
  // Load-chain on-demand leaf of consumer-local-rules.md: §Consumer Pre-PR Checks (the
  // consumer pre-PR checks contract), moved verbatim together with its exit criterion,
  // rationalization rows and verification commands. Frontmatter + H1 + Load-chain back-reference.
  "consumer-pre-pr-checks.md": ["Exit Criteria", "Common Rationalizations", "Verification"],
  // Load-chain on-demand sibling of token-frugal-io.md: the session rule-load ledger
  // mechanics, moved verbatim. Frontmatter + H1 + Load-chain back-reference.
  "rule-load-ledger-internals.md": [],
  // Load-chain on-demand sibling of pr-review-evidence-verification.md: the External
  // Evaluator ticket path, moved verbatim. Frontmatter + H1 + Load-chain back-reference.
  "second-review-external-evaluator.md": [],
  // Load-chain on-demand siblings of consumer-adoption.md: the uninstall recipe and the
  // executable-bit section moved out verbatim.
  "consumer-uninstall.md": [],
  "consumer-hook-file-maintenance.md": [],
  // Load-chain on-demand sibling of release-step-1-7.md: the Step 1 補充 exception
  // path (tip mismatch), moved verbatim. Frontmatter + H1 + Load-chain back-reference.
  "release-unselected-commit-handling.md": [],
  // Load-chain on-demand sibling leaves (rationalize-overbundled-entry-leaves T5):
  // These are pure content-move siblings of anti-patterns-examples.md. They hold
  // moved H3-level sections (§1-§6 design anti-patterns and §7-§16 behavioral
  // anti-patterns) and do not follow the standard 6-section H2 anatomy.
  // Each has frontmatter + H1 heading + Load-chain back-reference + verbatim moved content.
  "anti-patterns-design.md": [],
  "anti-patterns-behavioral.md": [],
  // Load-chain on-demand sibling leaf (rationalize-overbundled-entry-leaves T6):
  // Pure content-move sibling of code-review-checklist.md. Holds the entire
  // Cross-Model 第二意見 H2 block (PGE principle, 豁免條件 SSOT, 執行流程,
  // External-CLI sandbox policy, 衝突仲裁, 失效 fallback, Merge Gate Enforcement,
  // Consumer 擴充). External Reviewer CLI Skill Contract moved out to
  // code-review-cross-model-cli-contract.md (strengthen-pr-1827-followups T2).
  // Has frontmatter + H1 heading + Load-chain back-reference + verbatim moved H3 content.
  "code-review-cross-model.md": [],
  // Load-chain on-demand sibling leaf (strengthen-pr-1827-followups T2):
  // Pure content-move sibling of code-review-cross-model.md. Holds the entire
  // External Reviewer CLI Skill Contract section (1->7 dispatch protocol +
  // timeout policy) moved out whole per design.md D4.
  // Has frontmatter + H1 heading + Load-chain back-reference + verbatim moved content.
  "code-review-cross-model-cli-contract.md": [],
  // Load-chain on-demand sibling leaves (refactor-openspec-rule-corpus-headroom):
  // Pure content-move siblings of openspec-step-1-to-9.md / code-review-checklist.md.
  "openspec-archive-principles.md": [],
  "code-review-cross-carrier.md": [],
  // refactor-ai-autonomy-debundle: ai-autonomy.md loses §Common Rationalizations and
  // §Verification (moved to siblings). Remaining sections: Overview / When to Use /
  // Process / Exit Criteria. Not the standard 6-section set.
  "ai-autonomy.md": ["Overview", "When to Use", "Process", "Exit Criteria"],
  // Load-chain on-demand sibling leaves (refactor-ai-autonomy-debundle):
  // Pure content-move siblings of ai-autonomy.md. They hold moved H2-level sections
  // and do not follow the standard 6-section H2 anatomy.
  // Each has frontmatter + Load-chain back-reference + verbatim moved content.
  "ai-autonomy-rationalizations.md": [],
  "ai-autonomy-root-cause.md": [],
  // Reference-style SSOT table: one destination table + 禁則 + enforcement + body file 紀律.
  // Not a standard 6-section leaf.
  "file-write-destinations.md": ["禁則", "Mechanical enforcement", "body file two-step 紀律（所有 gh body 寫入共用）"],
  // Sibling leaf (strengthen-rule-anchor-guard-authoring T4):
  // Authored as a sibling of rule-design-principles.md; branch-1 split applied at
  // creation (content is net-new in this change — rule-design-principles.md never
  // had a §Rule-Anchor Guard section to move out of; its diff is pure addition).
  // Holds the §Rule-Anchor Guard 強度守則 discipline (grep-guard fundamental limit +
  // polarity/structural two-way rule). rule-design-principles.md carries only a stub
  // pointer back-reference to it. Has frontmatter + H1 heading + Overview/When-to-Use
  // + discipline content; does not follow the standard 6-section H2 anatomy.
  "rule-anchor-guard-strength.md": [],
};

// ── Helpers ──────────────────────────────────────────────────────────────────
async function readContent(filename) {
  return await fs.readFile(path.join(rulesDir, filename), "utf8");
}

async function listRuleFiles() {
  const all = await fs.readdir(rulesDir);
  return all.filter((f) => f.endsWith(".md")).sort();
}

// ── Test suite ───────────────────────────────────────────────────────────────
describe("rule anatomy", () => {
  // ── Pre-existing: ai-autonomy.md four headings ─────────────────────────────
  describe("ai-autonomy.md", () => {
    it("has ## Overview", async () => {
      const content = await readContent("ai-autonomy.md");
      assert.ok(/^## Overview$/m.test(content), "missing ## Overview");
    });

    it("has ## When to Use", async () => {
      const content = await readContent("ai-autonomy.md");
      assert.ok(/^## When to Use$/m.test(content), "missing ## When to Use");
    });

    it("has ## Process", async () => {
      const content = await readContent("ai-autonomy.md");
      assert.ok(/^## Process$/m.test(content), "missing ## Process");
    });

    it("has ## Verification (now in sibling ai-autonomy-rationalizations.md)", async () => {
      const content = await readContent("ai-autonomy-rationalizations.md");
      assert.ok(/^## Verification$/m.test(content), "missing ## Verification in ai-autonomy-rationalizations.md");
    });
  });

  // ── Pre-existing: session-start.mjs must NOT duplicate Session 收尾 Gate ────
  // Anti-duplication invariant: hook payload must not contain Session 收尾 Gate
  // (intentionally removed in Task 2; full gate lives in agent-rules only)
  describe("session-start.mjs hook", () => {
    it("does not contain Session 收尾 Gate sentence (anti-duplication)", async () => {
      const content = await fs.readFile(
        path.join(hooksDir, "session-start.mjs"),
        "utf8"
      );
      assert.ok(
        !content.includes("Session 收尾 Gate"),
        "session-start.mjs must not duplicate the Session 收尾 Gate block (anti-duplication)"
      );
    });
  });

  // ── New: YAML frontmatter present in every rule file ──────────────────────
  it("each .devpro/agent-rules/*.md has YAML frontmatter", async () => {
    const files = await listRuleFiles();
    const failed = [];
    for (const f of files) {
      const content = await readContent(f);
      const dashCount = (content.match(/^---$/gm) || []).length;
      if (dashCount < 2) {
        failed.push(`${f}: --- count ${dashCount}`);
      }
    }
    assert.equal(
      failed.length,
      0,
      `Frontmatter check failed:\n  ${failed.join("\n  ")}`
    );
  });

  // Round-1 review of strengthen-subagent-delegation-strategy found a rule leaf
  // with a second YAML front matter + H1 pasted mid-file: the Edit glued `---`
  // onto the end of a sentence, so the `---` count check above and a
  // line-anchored `^---\nname:` match both stayed green (round-2 finding
  // F-r2-rule-anatomy-guard-not-prove-it). Counting `name:` and H1 lines is
  // insensitive to where the duplicate head was pasted. Fenced code blocks are
  // stripped first because rule-file-template.md quotes front matter as examples.
  const stripFences = (content) => content.replace(/^```[\s\S]*?^```[ \t]*$/gm, "");
  const countHeadMarkers = (content) => {
    const body = stripFences(content);
    return {
      name: (body.match(/^name: /gm) || []).length,
      h1: (body.match(/^# /gm) || []).length,
    };
  };

  it("each .devpro/agent-rules/*.md has exactly one front matter name and one H1 outside fenced code", async () => {
    const files = await listRuleFiles();
    const failed = [];
    for (const f of files) {
      const { name, h1 } = countHeadMarkers(await readContent(f));
      if (name !== 1 || h1 !== 1) failed.push(`${f}: name lines ${name}, H1 lines ${h1}`);
    }
    assert.equal(failed.length, 0, `Single head check failed:\n  ${failed.join("\n  ")}`);
  });

  it("head-marker guard fails on a duplicate head glued to a sentence end (round-1 shape)", () => {
    const head = "---\nname: sample-leaf\ndescription: sample\n---\n\n# Sample Leaf\n\n";
    const clean = `${head}Body sentence one.\n\n\`\`\`markdown\n---\nname: quoted-example\n---\n# Quoted\n\`\`\`\n`;
    assert.deepEqual(countHeadMarkers(clean), { name: 1, h1: 1 });
    const glued = `${head}Body sentence \`^[a-z0-9]{0,99}${head}Body continues.\n`;
    assert.deepEqual(countHeadMarkers(glued), { name: 2, h1: 2 });
    assert.equal((stripFences(glued).match(/^---\r?\nname: /gm) || []).length, 1, "line-anchored start match misses the glued head");
  });

  // ── New: standard files have all six sections ─────────────────────────────
  it(
    "standard files have 6 sections (Overview / When to Use / Process or Rules / Exit Criteria / Common Rationalizations / Verification)",
    async () => {
      const files = await listRuleFiles();
      const standardFiles = files.filter((f) => !(f in EXCEPTION_FILES));
      const failed = [];
      for (const f of standardFiles) {
        const content = await readContent(f);
        for (const section of STANDARD_SECTIONS) {
          if (!sectionPresent(content, section)) {
            failed.push(`${f}: missing "${sectionLabel(section)}"`);
          }
        }
      }
      assert.equal(
        failed.length,
        0,
        `Six-section check failed:\n  ${failed.join("\n  ")}`
      );
    }
  );

  // ── New: ## Rules section must contain Process-class content ───────────────
  // Per rule-file-template.md §Process / Rules 格式規則: leaves opting into
  // `## Rules` for Section 3 must include numbered list / bullet / table to
  // avoid using `## Rules` as an empty placeholder.
  it("standard files using `## Rules` have Process-class content in that section", async () => {
    const files = await listRuleFiles();
    const standardFiles = files.filter((f) => !(f in EXCEPTION_FILES));
    const failed = [];
    for (const f of standardFiles) {
      const content = await readContent(f);
      const result = validateRulesSection(content, f);
      if (result) failed.push(result);
    }
    assert.equal(
      failed.length,
      0,
      `Rules content check failed:\n  ${failed.join("\n  ")}`
    );
  });

  // ── New: exception files use their alternative headers ────────────────────
  it("exception files use alternative headers per D4", async () => {
    const failed = [];
    for (const [file, sections] of Object.entries(EXCEPTION_FILES)) {
      const content = await readContent(file);
      for (const section of sections) {
        const regex = new RegExp(`^## ${section}$`, "m");
        if (!regex.test(content)) {
          failed.push(`${file}: missing "## ${section}"`);
        }
      }
    }
    assert.equal(
      failed.length,
      0,
      `Exception headers check failed:\n  ${failed.join("\n  ")}`
    );
  });

  // ── New: anatomy summary / file-count guard ───────────────────────────────
  it("anatomy summary: root rule files partition into standard vs EXCEPTION_FILES", async () => {
    const files = await listRuleFiles();
    const standardCount = files.filter((f) => !(f in EXCEPTION_FILES)).length;
    const exceptionCount = files.filter((f) => f in EXCEPTION_FILES).length;
    console.log(
      `[rule-anatomy] ${files.length} files: ${standardCount} standard 6-section, ${exceptionCount} exceptions with alternative headers`
    );
    const missingExceptionFiles = Object.keys(EXCEPTION_FILES).filter(
      (f) => !files.includes(f)
    );
    assert.equal(
      missingExceptionFiles.length,
      0,
      `EXCEPTION_FILES references missing files:\n  ${missingExceptionFiles.join("\n  ")}`
    );
    assert.equal(
      files.length,
      standardCount + exceptionCount,
      `root .devpro/agent-rules/*.md must partition cleanly: total=${files.length} standard=${standardCount} exceptions=${exceptionCount}`
    );
    assert.equal(
      exceptionCount,
      Object.keys(EXCEPTION_FILES).length,
      `EXCEPTION_FILES key count (${Object.keys(EXCEPTION_FILES).length}) must match exception files present (${exceptionCount})`
    );
  });

  // ── Fixture-driven end-to-end: validateRulesSection on constructed leaves ──
  // Proves the full extractSectionBody + hasProcessClassContent integration
  // rejects empty / prose-only `## Rules` bodies and accepts structured ones,
  // independent of which files currently live in .devpro/agent-rules/.
  describe("validateRulesSection fixture-driven", () => {
    const FRONTMATTER = "---\nname: fake-leaf\ndescription: fixture\n---\n\n";
    const STANDARD_TAIL = "\n## Exit Criteria\n\n- done\n";

    it("returns null when file has no `## Rules` heading", () => {
      const content = FRONTMATTER + "## Process\n\n1. step\n" + STANDARD_TAIL;
      assert.equal(validateRulesSection(content, "fake.md"), null);
    });

    it("accepts `## Rules` body with numbered list", () => {
      const content =
        FRONTMATTER + "## Rules\n\n1. first\n2. second\n" + STANDARD_TAIL;
      assert.equal(validateRulesSection(content, "fake.md"), null);
    });

    it("accepts `## Rules` body with bullet list", () => {
      const content =
        FRONTMATTER + "## Rules\n\n- alpha\n- beta\n" + STANDARD_TAIL;
      assert.equal(validateRulesSection(content, "fake.md"), null);
    });

    it("accepts `## Rules` body with table", () => {
      const content =
        FRONTMATTER +
        "## Rules\n\n| col | val |\n| --- | --- |\n| a | 1 |\n" +
        STANDARD_TAIL;
      assert.equal(validateRulesSection(content, "fake.md"), null);
    });

    it("rejects empty `## Rules` body (heading only, then next H2)", () => {
      const content = FRONTMATTER + "## Rules\n\n" + STANDARD_TAIL;
      const result = validateRulesSection(content, "fake.md");
      assert.ok(result && result.includes('"## Rules" section must contain Process-class content'));
    });

    it("rejects prose-only `## Rules` body", () => {
      const content =
        FRONTMATTER +
        "## Rules\n\nThis is plain prose with no structure.\nAnother sentence.\n" +
        STANDARD_TAIL;
      const result = validateRulesSection(content, "fake.md");
      assert.ok(result && result.includes('"## Rules" section must contain Process-class content'));
    });

    it("handles `## Rules` as the last section (no trailing H2)", () => {
      // Bug surfaced by codex Important: ensure end-of-file boundary works
      // without relying on a sentinel `\Z` anchor (which is literal in JS).
      const contentValid = FRONTMATTER + "## Rules\n\n1. only step\n";
      assert.equal(validateRulesSection(contentValid, "fake.md"), null);

      const contentEmpty = FRONTMATTER + "## Rules\n\n";
      const result = validateRulesSection(contentEmpty, "fake.md");
      assert.ok(result && result.includes('"## Rules" section must contain Process-class content'));
    });
  });

  // ── Helper behavior: Process-class content detection ──────────────────────
  describe("hasProcessClassContent helper", () => {
    it("detects numbered list", () => {
      assert.ok(hasProcessClassContent("\n1. first\n2. second"));
    });
    it("detects bullet list (hyphen)", () => {
      assert.ok(hasProcessClassContent("\n- alpha\n- beta"));
    });
    it("detects bullet list (asterisk)", () => {
      assert.ok(hasProcessClassContent("\n* alpha\n* beta"));
    });
    it("detects markdown table", () => {
      assert.ok(hasProcessClassContent("\n| col | val |\n| --- | --- |"));
    });
    it("rejects prose-only body", () => {
      assert.ok(!hasProcessClassContent("\nThis is plain prose.\nNo structure here."));
    });
    it("rejects empty body", () => {
      assert.ok(!hasProcessClassContent(""));
    });
  });

  // ── New: trigger-decidability content anchors (strengthen-rule-trigger-decidability) ──
  // Targeted literal anchors, NOT a corpus-wide `## When to Use` content-shape
  // oracle (forbidden by design-core §Mechanical Tests Must Not Regex-Judge
  // Materiality; see design.md D4 for the full rationale). Each anchor locks
  // the operative wording of one named file's named section only.
  describe("trigger decidability content anchors", () => {
    it("openspec-quality-doc-formats.md §brd.md has the outcome-criterion contract", async () => {
      const content = await fs.readFile(
        path.join(rulesDir, "openspec-quality-doc-formats.md"),
        "utf8"
      );
      const m = content.match(/### brd\.md[\s\S]*?(?=\n### |$)/);
      assert.ok(m, "### brd.md section missing");
      assert.match(m[0], /outcome 判準/);
      assert.match(m[0], /MUST NOT 單獨構成驗收/);
      assert.match(m[0], /本條為 `cooperative-only`/);
    });

    it("rule-file-template.md §Section 順序與 5W2H 對應 has the trigger-decidability clause", async () => {
      const content = await readContent("rule-file-template.md");
      const m = content.match(
        /### Section 順序與 5W2H 對應[\s\S]*?(?=\n### |$)/
      );
      assert.ok(m, "### Section 順序與 5W2H 對應 section missing");
      assert.match(m[0], /目標行為尚未發生/);
      assert.match(m[0], /純 prose（非 bullet list）的段落不因格式非 bullet 而豁免本條/);
      assert.match(m[0], /合取式子句（含「且」等連接詞）整條視為單一判定單位/);
    });
  });
});
