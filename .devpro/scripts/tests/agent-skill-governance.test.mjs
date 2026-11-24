import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSourceRoot } from "./lib/source-root.mjs";
import { readSourceFile as read } from "./lib/read.mjs";
import { collectEntryTreeSkillSet } from "../lint-agent-skills.mjs";
import { readPrePrSkillFullReadingOrder } from "./lib/pre-pr-skill.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDir, "../../..");
const repoRoot = resolveSourceRoot(defaultRepoRoot);
const lintScript = path.join(repoRoot, ".devpro", "scripts", "lint-agent-skills.mjs");

// Bilingual use-when trigger wording matcher (same semantics as lint-agent-skills.mjs's
// SSOT detection regex, T5); accepts English "Use when" or Chinese 使用時機/當…時 wording.
const USE_WHEN_BILINGUAL_RE = /use when|使用時機|當[^。]*時/i;

function runLint(args = []) {
  return execFileSync(process.execPath, [lintScript, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// design D1/D3 — each runtime skill discovery dir (.claude/skills,
// .agents/skills) must hold exactly one entry, named `devpro`, which is a
// symlink resolving to the catalog root ITSELF (not merely "under" it —
// the pre-2-entry-topology per-skill contract this superseded only
// required "under"). Absence of the discovery dir is fine (not every
// runtime dir is guaranteed to exist yet).
function assertSkillDiscoveryDirIsSymlinksOnly(dirRelPath) {
  const dirAbs = path.join(repoRoot, dirRelPath);
  if (!existsSync(dirAbs)) return;
  // realpath the root before the equality comparison, mirroring
  // lint-agent-skills.mjs and sync's canonicalization: realpathSync(entryAbs)
  // below resolves OS path aliases (macOS /tmp -> /private/tmp, symlinked
  // mounts), so the catalog root must be realpath'd too.
  const realRoot = realpathSync(repoRoot);
  const catalogRootAbs = path.join(realRoot, ".devpro", "agent-skills");
  const names = readdirSync(dirAbs);
  assert.deepEqual(names, ["devpro"], `${dirRelPath} must hold exactly the 'devpro' entry`);
  for (const name of names) {
    const entryAbs = path.join(dirAbs, name);
    const stat = lstatSync(entryAbs);
    assert.equal(stat.isSymbolicLink(), true, `${dirRelPath}/${name} must be a symlink`);
    const target = realpathSync(entryAbs);
    assert.equal(
      target,
      catalogRootAbs,
      `${dirRelPath}/${name} symlink must resolve to .devpro/agent-skills itself`
    );
  }
}

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

// amend-pr-integration-test-scope T12: the four rule-self-evolution ADDED scenarios bind the
// red-suite disposition policy that lives only in the test-suite-cadence.md leaf (design D7/C6).
// Slice §Source Repo Test Runtime Budget up to the next `### ` heading first, so a clause in some
// other section of the leaf cannot keep these assertions green.
function runtimeBudgetSection() {
  const lines = read(".devpro/agent-rules/test-suite-cadence.md").split("\n");
  const start = lines.findIndex((line) =>
    line.startsWith("### Source Repo Test Runtime Budget")
  );
  assert.notEqual(start, -1, "test-suite-cadence.md must carry §Source Repo Test Runtime Budget");
  const nextHeadingOffset = lines
    .slice(start + 1)
    .findIndex((line) => line.startsWith("### "));
  const end = nextHeadingOffset === -1 ? lines.length : start + 1 + nextHeadingOffset;
  return lines.slice(start, end).join("\n");
}

// The governance bullet is the one physical SSOT line carrying the full-suite step and the three
// red-suite dispositions; bind the scenario clauses to that single line
// (rule-anchor-guard-strength.md) instead of the section at large.
function governanceFullSuiteBullet() {
  const bullet = runtimeBudgetSection()
    .split("\n")
    .find((line) => line.includes("Governance 全量與紅燈處置"));
  assert.ok(
    bullet,
    "§Source Repo Test Runtime Budget must carry the governance full-suite/red-suite bullet"
  );
  return bullet;
}

describe("agent skill governance", () => {
  it("has rule, AGENTS routing, and README listing", () => {
    assert.ok(existsSync(path.join(repoRoot, ".devpro/agent-rules/agent-skill-governance.md")));
    assert.match(read("AGENTS.md"), /設計 rule\/hook\/cmd\/agent\/skill\|`design-core\.md`/);
    assert.match(read(".devpro/agent-rules/design-core.md"), /agent-skill-governance\.md/);
    assert.match(read("README.md"), /agent-skill-governance\.md/);
  });

  it("template documents required fields and progressive disclosure directories", () => {
    const template = read(".devpro/agent-skills-refs/templates/SKILL.md");
    assert.match(template, /^name:/m);
    assert.match(template, /^description:/m);
    assert.match(template, /Use when/);
    assert.match(template, /Routing metadata only/);
    assert.match(template, /Do not encode process steps/);
    assert.match(template, /references\//);
    assert.match(template, /scripts\//);
    assert.match(template, /assets\//);
  });

  it("rule keeps skill descriptions as routing metadata, not process summaries", () => {
    const rule = read(".devpro/agent-rules/agent-skill-governance.md");
    assert.match(rule, /routing metadata/);
    assert.match(rule, /process summary/);
    assert.match(rule, /workflow steps/);
    assert.match(rule, /mini-SSOT/);
  });

  it("locks first-party skill behavioral evaluation in the rule and active-or-canonical spec", () => {
    const rule = read(".devpro/agent-rules/agent-skill-governance.md");
    const activeSpec = "openspec/changes/strengthen-skill-behavioral-validation/specs/reusable-skill-adoption/spec.md";
    const canonicalSpec = "openspec/specs/reusable-skill-adoption/spec.md";
    const spec = read(existsSync(path.join(repoRoot, activeSpec)) ? activeSpec : canonicalSpec);

    for (const carrier of [rule, spec]) {
      assert.match(carrier, /Behavioral Evaluation Before Deployment|First-Party Skill Behavioral Evaluation Evidence/);
      assert.match(carrier, /no-guidance baseline/);
      assert.match(carrier, /deployed or current-version/);
      assert.match(carrier, /same scenario and expected behavior/);
      assert.match(carrier, /fresh context/);
      assert.match(carrier, /skill-evaluation\.md/);
      assert.match(carrier, /tested and untested runtime\/model families/);
      assert.match(carrier, /proceed.*narrow.*abandon/s);
      assert.match(carrier, /should-trigger.*should-not-trigger.*ambiguous-boundary/s);
      assert.match(carrier, /discipline/i);
      assert.match(carrier, /bypass/i);
      assert.match(carrier, /new or edge case/);
      assert.match(carrier, /retriev.*correct.*appl/is);
      assert.match(carrier, /all-runtime distribution and support.*MUST remain unchanged/s);
      assert.match(carrier, /runtime\/model-specific behavioral-?equivalence claim/);
      assert.match(carrier, /Missing authority or tooling.*limitation/s);
      assert.match(carrier, /fixed repetition/);
      assert.match(carrier, /single runtime harness/);
      assert.match(carrier, /external[- ]disclosure/);
      assert.match(carrier, /cooperative-only/);
      assert.match(carrier, /MUST NOT be represented as proof|not semantic proof/);
    }
  });

  it("bounds evaluation claims to exercised stages and preserves equivalent contracts (anchor guard only)", () => {
    const rule = read(".devpro/agent-rules/agent-skill-governance.md");
    const section = rule.split("### Behavioral Evaluation Before Deployment\n")[1].split("\n### ")[0];
    const anchors = [
      /Claims of an observed execution gap or comparative superiority MUST be narrowed to the actual baseline and treatment evidence\./,
      /An explicitly requested missing workflow contract MAY be standardized only with a mechanism-level gap, direct user value, an action point, and fresh-context verification\./,
      /If the existing contract is mechanism-equivalent, the author MUST keep it rather than add duplicate guidance\./,
      /An unexercised stage MUST be recorded as not exercised, not as equivalence, success, or evidence that the stage is unnecessary\./,
      /Evaluation inputs MUST hide scoring answers, sibling-arm results, and arm-identifying paths from the candidate\./,
    ];
    for (const anchor of anchors) {
      const lines = section.split("\n").filter(line => anchor.test(line));
      assert.equal(lines.length, 1, `one operative line must own ${anchor}`);
      assert.doesNotMatch(section.replace(lines[0], ""), anchor, "deleting the operative line must turn this anchor red");
    }
    assert.doesNotMatch(section, /If the baseline does not exhibit the claimed gap, the author MUST narrow or abandon the proposed guidance/);
  });

  it("rejects the historical blanket baseline veto without rejecting legitimate claim limits", () => {
    // Wording regression fixtures, not a semantic model-behavior oracle.
    const obsolete = /If the baseline does not exhibit the claimed gap, the author MUST narrow or abandon the proposed guidance/;
    assert.match("If the baseline does not exhibit the claimed gap, the author MUST narrow or abandon the proposed guidance instead of adding hypothetical rules.", obsolete);
    assert.doesNotMatch("Claims of an observed execution gap or comparative superiority MUST be narrowed to the actual baseline and treatment evidence.", obsolete);
    assert.doesNotMatch(read(".devpro/agent-rules/agent-skill-governance.md"), obsolete);
    assert.doesNotMatch(read("openspec/specs/reusable-skill-adoption/spec.md"), obsolete);
  });

  it("lint script passes the current repository", () => {
    const stdout = runLint();
    // Derive the count from the manifest so adding a skill does not require
    // editing this test; a lint that silently checks fewer skills still fails.
    const manifest = JSON.parse(read(".devpro/agent-skills/manifest.json"));
    const skillCount = manifest.groups.flatMap((group) => group.skills).length;
    assert.ok(skillCount > 0, "manifest must list at least one skill");
    assert.ok(
      stdout.includes(`Checked ${skillCount} skill(s)`),
      `lint must check all ${skillCount} manifest skills; got: ${stdout.trim().split("\n").pop()}`
    );
    assert.match(stdout, /0 warning\(s\)/);
    assert.match(stdout, /0 error\(s\)/);
  });

  it("pre-pr keeps its regression matrix in references/ and SKILL.md points at it", () => {
    // The matrix moved out so SKILL.md stays under the long-body cap; the pointer must
    // keep resolving and the matrix must not drift back into the body.
    const skill = read(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md");
    const reference = read(".devpro/agent-skills/devpro-workflows/pre-pr/references/regression-scenarios.md");
    assert.match(skill, /references\/regression-scenarios\.md/, "SKILL.md must point at the reference");
    assert.doesNotMatch(skill, /\| 流程類別 \| 觸發情境 \| 預期結果 \|/, "the matrix table must not be duplicated in SKILL.md");
    assert.match(reference, /\| 流程類別 \| 觸發情境 \| 預期結果 \|/, "the reference carries the matrix");
    for (const row of ["Normal", "Existing-File", "Error"]) {
      assert.match(reference, new RegExp(`\\| ${row} \\|`), `reference keeps the ${row} row`);
    }
  });

  it("manifest covers all non-template skill directories", () => {
    const manifest = JSON.parse(read(".devpro/agent-skills/manifest.json"));
    const paths = manifest.groups.flatMap((group) => group.skills.map((skill) => skill.path)).sort();
    assert.deepEqual(paths, [
      ".devpro/agent-skills/consumer/consumer-doctor",
      ".devpro/agent-skills/devops/iis-webapp-deploy",
      ".devpro/agent-skills/devpro-reviews/cross-review",
      ".devpro/agent-skills/devpro-reviews/pr-review",
      ".devpro/agent-skills/devpro-reviews/second-review",
      ".devpro/agent-skills/devpro-reviews/second-review-dogfood",
      ".devpro/agent-skills/devpro-workflows/change",
      ".devpro/agent-skills/devpro-workflows/clarify",
      ".devpro/agent-skills/devpro-workflows/cmux-surface-comms",
      ".devpro/agent-skills/devpro-workflows/herdr-pane-comms",
      ".devpro/agent-skills/devpro-workflows/init",
      ".devpro/agent-skills/devpro-workflows/load-plan",
      ".devpro/agent-skills/devpro-workflows/pre-pr",
      ".devpro/agent-skills/devpro-workflows/project-docs",
      ".devpro/agent-skills/devpro-workflows/project-verify",
      ".devpro/agent-skills/devpro-workflows/setup-ci",
      ".devpro/agent-skills/devpro-workflows/sync-rules",
      ".devpro/agent-skills/devpro-workflows/workflows",
      ".devpro/agent-skills/openspec/openspec-artifact-authoring",
      ".devpro/agent-skills/release/release-runbook",
      ".devpro/agent-skills/rules-authoring/knowledge-distill",
      ".devpro/agent-skills/rules-authoring/knowledge-ingest",
      ".devpro/agent-skills/rules-authoring/recap-writer",
      ".devpro/agent-skills/rules-authoring/rule-governance",
      ".devpro/agent-skills/security/security-scan",
    ]);
  });

  it("refs manifest covers the claude-code/codex/design-doc-mermaid refs, each rooted under agent-skills-refs/", () => {
    const manifest = JSON.parse(read(".devpro/agent-skills-refs/manifest.json"));
    const paths = manifest.groups.flatMap((group) => group.skills.map((skill) => skill.path)).sort();
    assert.deepEqual(paths, [
      ".devpro/agent-skills-refs/autonomous-ai-agents/claude-code",
      ".devpro/agent-skills-refs/autonomous-ai-agents/codex",
      ".devpro/agent-skills-refs/documentation/design-doc-mermaid",
    ]);
    for (const p of paths) {
      assert.ok(p.startsWith(".devpro/agent-skills-refs/"), `${p} must stay rooted under .devpro/agent-skills-refs/`);
    }
  });

  it("plugin manifest declares the devpro entry name and the catalog's 8 shipping groups", () => {
    const plugin = JSON.parse(read(".devpro/agent-skills/.claude-plugin/plugin.json"));
    assert.equal(plugin.name, "devpro");
    assert.equal(typeof plugin.description, "string");
    assert.ok(plugin.description.length > 0);
    assert.equal(Object.prototype.hasOwnProperty.call(plugin, "version"), false);
    assert.deepEqual(plugin.skills, [
      "./consumer",
      "./devops",
      "./devpro-reviews",
      "./devpro-workflows",
      "./openspec",
      "./release",
      "./rules-authoring",
      "./security",
    ]);
    for (const entry of plugin.skills) {
      assert.equal(entry.includes(".."), false, `${entry} must not contain ".."`);
      assert.equal(entry.startsWith("/"), false, `${entry} must not be an absolute path`);
    }
  });

  // design D1/D3 — the three locks: entry basename == plugin name == "devpro";
  // for every catalog skill, dir == frontmatter name == manifest name.
  it("Scenario: entry basename, plugin name, and discovery target all lock to devpro", () => {
    const plugin = JSON.parse(read(".devpro/agent-skills/.claude-plugin/plugin.json"));
    for (const rel of [".agents/skills/devpro", ".claude/skills/devpro"]) {
      const discovery = path.join(repoRoot, rel);
      assert.ok(lstatSync(discovery).isSymbolicLink(), `${rel} must be a symlink`);
      assert.equal(path.basename(rel), "devpro");
      assert.equal(plugin.name, "devpro");
      assert.equal(
        realpathSync(discovery),
        realpathSync(path.join(repoRoot, ".devpro/agent-skills")),
        `${rel} must resolve to the catalog root itself`
      );
    }
  });

  // design D1/D3 — the source repo's own discovery-entry-tree surface: each
  // runtime discovery dir holds exactly the one `devpro` entry tracked as a
  // real Git symlink (mode 120000), the plugin manifest exists and is
  // named `devpro`, and the catalog root carries no SKILL.md of its own.
  it("Scenario: Source exposes only the two devpro entries and the plugin manifest", () => {
    for (const dirRelPath of [".claude/skills", ".agents/skills"]) {
      const names = readdirSync(path.join(repoRoot, dirRelPath));
      assert.deepEqual(names, ["devpro"], `${dirRelPath} must hold exactly the devpro entry`);
      const lsFiles = execFileSync(
        "git",
        ["ls-files", "-s", `${dirRelPath}/devpro`],
        { cwd: repoRoot, encoding: "utf8" }
      ).trim();
      assert.match(lsFiles, /^120000 /, `${dirRelPath}/devpro must be tracked at mode 120000`);
    }
    const plugin = JSON.parse(read(".devpro/agent-skills/.claude-plugin/plugin.json"));
    assert.equal(plugin.name, "devpro");
    assert.equal(
      existsSync(path.join(repoRoot, ".devpro/agent-skills/SKILL.md")),
      false,
      "the catalog root must not contain a SKILL.md directly"
    );
  });

  // design D1/D4 — the three name locks (dir === frontmatter name ===
  // manifest name) plus the devpro:<name> qualified-name length cap,
  // checked for every current catalog skill. TL decision (t9-added-
  // scenario-fixes): the delta's THEN no longer names a "MUST NOT start
  // with dp-" clause, so this test binds the scenario title directly; the
  // extra `!startsWith("dp-")` assertion stays as a true, currently-passing
  // observation about the live catalog, not a new lock this test invents —
  // no `dp-` lint check was added to lint-agent-skills.mjs (out of scope).
  it("Scenario: Three name locks hold for every catalog skill", () => {
    const manifest = JSON.parse(read(".devpro/agent-skills/manifest.json"));
    const entries = manifest.groups.flatMap((group) => group.skills);
    // Cross-check against SKILL.md files on disk (an independent source)
    // instead of a hardcoded count: an unregistered or missing skill fails.
    const onDisk = readdirSync(path.join(repoRoot, ".devpro/agent-skills"), {
      recursive: true,
    }).filter((rel) => path.basename(rel) === "SKILL.md");
    assert.ok(onDisk.length > 0, "catalog tree must contain SKILL.md files");
    assert.equal(
      entries.length,
      onDisk.length,
      `manifest lists ${entries.length} skills but ${onDisk.length} SKILL.md files exist on disk`
    );
    for (const entry of entries) {
      const dirName = path.basename(entry.path);
      assert.equal(entry.name, dirName, `manifest name "${entry.name}" must equal directory "${dirName}"`);
      const skill = read(`${entry.path}/SKILL.md`);
      const frontmatterName = skill.match(/^name:\s*(.+)$/m)?.[1]?.trim();
      assert.equal(frontmatterName, dirName, `frontmatter name "${frontmatterName}" must equal directory "${dirName}"`);
      assert.equal(dirName.startsWith("dp-"), false, `catalog skill "${dirName}" must not start with "dp-"`);
      const qualifiedName = `devpro:${dirName}`;
      assert.ok(
        qualifiedName.length <= 64,
        `qualified name "${qualifiedName}" (${qualifiedName.length} chars) must stay within 64 chars`
      );
    }
  });

  // Negative fixtures proving lint-agent-skills.mjs actually fails closed on
  // two of the three name locks (the directory/frontmatter/manifest
  // equality lock, and the qualified-name length cap) rather than merely
  // observing that today's catalog skills happen to satisfy them.
  it("lint fails closed when a catalog skill's directory/frontmatter/manifest names disagree", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skill-lint-"));
    try {
      await writeFile(
        path.join(tmp, ".devpro/agent-skills/grp/example/SKILL.md"),
        `---\nname: mismatched-name\ndescription: "Example skill. Use when testing the equality name lock."\n---\n\n# Example\n`
      );
      await writeFile(
        path.join(tmp, ".devpro/agent-skills/manifest.json"),
        `{"name":"fixture","groups":[{"name":"grp","skills":[{"name":"example","path":".devpro/agent-skills/grp/example"}]}]}\n`
      );
      await writeFile(
        path.join(tmp, ".devpro/agent-skills/.claude-plugin/plugin.json"),
        `{"name":"devpro","description":"Fixture plugin manifest.","skills":["./grp"]}\n`
      );
      assert.throws(() => runLint(["--root", tmp]), /does not match directory/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // F-rase-pr-r1-08: the spec locks the entry's literal target, not only
  // what it resolves to — an absolute or dotted target must fail the lint.
  it("lint fails closed when a discovery entry's literal target is not ../../.devpro/agent-skills", async () => {
    for (const makeTarget of [(tmp) => path.join(tmp, ".devpro", "agent-skills"), () => "../../.devpro/./agent-skills"]) {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skill-lint-"));
      try {
        await writeFile(
          path.join(tmp, ".devpro/agent-skills/grp/example/SKILL.md"),
          `---\nname: example\ndescription: "Example skill. Use when testing the entry literal lock."\n---\n\n# Example\n`
        );
        await writeFile(
          path.join(tmp, ".devpro/agent-skills/manifest.json"),
          `{"name":"fixture","groups":[{"name":"grp","skills":[{"name":"example","path":".devpro/agent-skills/grp/example"}]}]}\n`
        );
        await writeFile(
          path.join(tmp, ".devpro/agent-skills/.claude-plugin/plugin.json"),
          `{"name":"devpro","description":"Fixture plugin manifest.","skills":["./grp"]}\n`
        );
        await fs.mkdir(path.join(tmp, ".claude", "skills"), { recursive: true });
        await fs.symlink(makeTarget(tmp), path.join(tmp, ".claude", "skills", "devpro"));
        assert.throws(() => runLint(["--root", tmp]), /literal target/);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    }
  });

  it("lint fails closed when a catalog skill's qualified name exceeds 64 characters", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skill-lint-"));
    try {
      const longName = `example-${"a".repeat(60)}`; // "devpro:" + name > 64 chars
      await writeFile(
        path.join(tmp, `.devpro/agent-skills/grp/${longName}/SKILL.md`),
        `---\nname: ${longName}\ndescription: "Example skill. Use when testing the length lock."\n---\n\n# Example\n`
      );
      await writeFile(
        path.join(tmp, ".devpro/agent-skills/manifest.json"),
        `{"name":"fixture","groups":[{"name":"grp","skills":[{"name":"${longName}","path":".devpro/agent-skills/grp/${longName}"}]}]}\n`
      );
      await writeFile(
        path.join(tmp, ".devpro/agent-skills/.claude-plugin/plugin.json"),
        `{"name":"devpro","description":"Fixture plugin manifest.","skills":["./grp"]}\n`
      );
      assert.throws(() => runLint(["--root", tmp]), /exceeds 64/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // design D6 — the manifest-coverage check (validateManifestSkills, plain
  // findSkillFiles() scan, no symlink-following) and the entry-tree walk
  // (collectEntryTreeSkillSet, which DOES follow directory symlinks) must
  // agree. A reference-manual-style SKILL.md living outside the catalog,
  // reachable only because a symlink inside the catalog root points at it,
  // is invisible to the plain scan but visible to the entry-tree walk —
  // exactly the asymmetry this scenario's fail-closed clause targets.
  it("Scenario: Entry tree inventory equals the catalog", async () => {
    // GIVEN the catalog manifest lists the shipping skills — WHEN the lint
    // walks the entry tree — THEN the collected set equals the catalog
    // manifest's skill paths, on the real live repository.
    const manifest = JSON.parse(read(".devpro/agent-skills/manifest.json"));
    const expectedSkillDirs = manifest.groups
      .flatMap((group) => group.skills)
      .map((skill) => path.posix.relative(".devpro/agent-skills", skill.path))
      .sort();
    const liveEntryTree = await collectEntryTreeSkillSet(path.join(repoRoot, ".devpro", "agent-skills"));
    assert.deepEqual(
      liveEntryTree.skillDirs.filter((rel) => rel !== "").sort(),
      expectedSkillDirs,
      "the entry-tree walk's collected SKILL.md set must equal the catalog manifest's skill paths"
    );

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skill-lint-"));
    try {
      await writeFile(
        path.join(tmp, ".devpro/agent-skills/grp/example/SKILL.md"),
        `---\nname: example\ndescription: "Example skill. Use when testing entry-tree coverage."\n---\n\n# Example\n`
      );
      await writeFile(
        path.join(tmp, ".devpro/agent-skills/manifest.json"),
        `{"name":"fixture","groups":[{"name":"grp","skills":[{"name":"example","path":".devpro/agent-skills/grp/example"}]}]}\n`
      );
      await writeFile(
        path.join(tmp, ".devpro/agent-skills/.claude-plugin/plugin.json"),
        `{"name":"devpro","description":"Fixture plugin manifest.","skills":["./grp"]}\n`
      );
      await writeFile(
        path.join(tmp, "reference-manuals/rogue/SKILL.md"),
        `---\nname: rogue\ndescription: "Reference manual. Use when proving entry-tree leakage."\n---\n\n# Rogue\n`
      );
      const rogueLinkTarget = path.join(tmp, "reference-manuals", "rogue");
      const rogueLinkPath = path.join(tmp, ".devpro/agent-skills/grp/rogue-link");
      if (process.platform === "win32") {
        await fs.symlink(rogueLinkTarget, rogueLinkPath, "dir");
      } else {
        await fs.symlink(rogueLinkTarget, rogueLinkPath);
      }

      assert.throws(() => runLint(["--root", tmp]), /entry tree skill set mismatch/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("dp-reviewer identity carrier declares the runtime-agent executor kind", () => {
    // `.claude/agents/dp-reviewer.md` is the source-owned identity carrier the
    // receipt chain binds `reviewer_identity.executor_kind` to; the primary
    // review's runtime attribution depends on this line staying `runtime-agent`.
    const DP_REVIEWER_IDENTITY_CARRIER = ".claude/agents/dp-reviewer.md";
    const carrier = read(DP_REVIEWER_IDENTITY_CARRIER);
    assert.ok(carrier.trim().length > 0, "dp-reviewer identity carrier must be non-empty");
    assert.match(carrier, /"role":\s*"dp-reviewer"/);
    assert.match(carrier, /"executor_kind":\s*"runtime-agent"/);
  });

  it("rule-governance consolidates audit and convergence skill discovery", () => {
    const manifest = JSON.parse(read(".devpro/agent-skills/manifest.json"));
    const skills = manifest.groups.flatMap((group) => group.skills);
    const skillNames = skills.map((skill) => skill.name);
    assert.equal(skillNames.filter((name) => name === "rule-governance").length, 1);
    assert.equal(skillNames.includes("dp-rule-audit"), false);
    assert.equal(skillNames.includes("dp-convergence-loop"), false);
    assert.equal(skillNames.includes("rule-audit"), false);
    assert.equal(skillNames.includes("convergence-loop"), false);

    const skill = read(".devpro/agent-skills/rules-authoring/rule-governance/SKILL.md");
    assert.match(skill, /1\. `audit-only`/);
    assert.match(skill, /2\. `split-dedup-review`/);
    assert.match(skill, /3\. `convergence-loop`/);
    assert.match(skill, /rule-audit-playbook\.md/);
    assert.match(skill, /doc-split-and-dedup-sop\.md/);
    assert.match(skill, /rule-design-principles\.md/);
    assert.match(skill, /rule-self-evolution\.md/);
    assert.match(skill, /multi-agent-handoff\.md/);
    assert.match(skill, /Repair only findings accepted|只修 accepted findings/);
    assert.match(skill, /accepted-finding-only/);
    assert.match(skill, /hard-trim-for-cap/);

    // wire-governance-observation-into-convergence-sweep: report-leaf-references.mjs is a
    // MANDATORY convergence sweep-lane mechanical entry, not an optional aside. The "dead
    // references and orphan routing" lane bullet must name the scan on the SAME line so the
    // wiring cannot be silently reverted to an ignorable aside a sweep skips. Contract:
    // rule-self-evolution spec, scenario reference-observation-wired-into-governance-convergence-sweep.
    assert.match(skill, /dead references and orphan routing[^\n]*report-leaf-references\.mjs/);
    // remove-token-budget-pr-gate T6: token budget / cap pressure is a MUST sweep lane
    // (audit-only + convergence), not an optional aside; repair stays accepted-finding-only.
    assert.match(skill, /token budget \/ cap pressure[^\n]*MUST/);
    assert.match(skill, /MUST.*include the token budget \/ cap pressure lane/);
    // Discovery pointer deliberately lives in this skill's own description (source-repo skill
    // list), NOT in consumer-synced AGENTS.md / rule leaves: the "rule self-evolution" (space
    // form, description-only) term lets a source-repo self-evolution / dead-leaf sweep find it.
    const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    assert.match(frontmatter, /^description:.*rule self-evolution.*$/m);
    // strengthen-rule-governance-pending-ingest: convergence consumes eligible session-pending
    // plus open [rule-feedback]; MUST NOT accepted-repair before claim-all + durable selection.
    assert.match(skill, /eligible session-pending|eligible pending/);
    assert.match(skill, /claim-all/);
    assert.match(skill, /Governance Batch Selection/);
    assert.match(skill, /MUST NOT.*accepted-repair|accepted-repair.*MUST NOT|未完成 claim-all/i);
    assert.match(skill, /First-batch exception|first-batch/i);
    assert.match(skill, /skeleton \+ .*Governance Batch Selection|骨架 \+ .*Governance Batch Selection/);

    // 2-entry topology（design D1/D3）：rule-governance 不再各自持有一條 discovery
    // symlink——唯一的 `devpro` entry 指回 catalog root，rule-governance 透過該 root
    // 可達；退役名（含舊 dp- 形與裸形）不得殘留為額外的 discovery 節點。
    for (const dirRelPath of [".agents/skills", ".claude/skills"]) {
      const devproEntry = path.join(repoRoot, dirRelPath, "devpro");
      assert.equal(lstatSync(devproEntry).isSymbolicLink(), true);
      assert.equal(
        realpathSync(path.join(devproEntry, "rules-authoring", "rule-governance", "SKILL.md")),
        realpathSync(path.join(repoRoot, ".devpro/agent-skills/rules-authoring/rule-governance/SKILL.md"))
      );
      for (const staleName of ["devpro:rule-governance", "dp-rule-audit", "rule-audit", "dp-convergence-loop", "convergence-loop"]) {
        assert.equal(existsSync(path.join(repoRoot, dirRelPath, staleName)), false);
      }
    }
  });

  // amend-pr-integration-test-scope T5/T12: every devpro:rule-governance mode must run the exhaustive
  // full suite before its mode-specific steps, with red-suite disposition policy left in the
  // test-suite-cadence.md leaf (SKILL only orchestrates + pointers, per design D7/C6). Renamed to
  // carry the delta scenario title; the leaf-side recording clause is asserted below.
  it("Scenario: Every governance mode starts with the full suite", () => {
    const skill = read(".devpro/agent-skills/rules-authoring/rule-governance/SKILL.md");
    assert.match(skill, /run-test-suite\.mjs --tier all/);

    const fullSuiteStepIndex = skill.indexOf("run-test-suite.mjs --tier all");
    const auditOnlyHeadingIndex = skill.indexOf("## Mode: audit-only");
    assert.ok(fullSuiteStepIndex >= 0, "full suite step must be present");
    assert.ok(auditOnlyHeadingIndex >= 0, "## Mode: audit-only heading must be present");
    assert.ok(
      fullSuiteStepIndex < auditOnlyHeadingIndex,
      "full suite step must appear before any mode-specific step (## Mode: audit-only)"
    );

    assert.match(skill, /test-suite-cadence\.md/);

    // AND: the run MUST record the tested HEAD SHA and the named log path — the policy
    // SSOT is the leaf's governance bullet, not the SKILL body (C6).
    assert.ok(
      governanceFullSuiteBullet().includes("記錄 HEAD SHA 與具名 log path"),
      "§Source Repo Test Runtime Budget governance bullet must require recording HEAD SHA and the named log path"
    );
  });

  // amend-pr-integration-test-scope T12: convergence-loop red-suite disposition — repaired in the
  // same round through the devpro:change / OpenSpec lane, never converged while the suite is red.
  it("Scenario: Convergence loop repairs a red full suite in the same round", () => {
    const bullet = governanceFullSuiteBullet();
    assert.ok(bullet.includes("convergence-loop"), "governance bullet must name convergence-loop");
    assert.ok(bullet.includes("同一輪"), "governance bullet must require the same-round repair");
    assert.ok(
      bullet.includes("修到全綠才繼續 sweep"),
      "governance bullet must require green before the sweep continues"
    );
    assert.ok(
      bullet.includes("`devpro:change`／OpenSpec lane"),
      "governance bullet must route the repair through the devpro:change / OpenSpec lane"
    );
  });

  // amend-pr-integration-test-scope T12: the two non-editing modes record each red result as a
  // finding (failing test names + log path) and route it to a repair lane instead of editing.
  it("Scenario: Non-editing modes route a red full suite as a finding", () => {
    const bullet = governanceFullSuiteBullet();
    for (const mode of ["audit-only", "split-dedup-review"]) {
      assert.ok(bullet.includes(mode), `governance bullet must name ${mode}`);
    }
    assert.ok(
      bullet.includes("不改檔"),
      "governance bullet must state these modes do not edit files"
    );
    assert.ok(bullet.includes("finding"), "governance bullet must record the red result as a finding");
    assert.ok(
      bullet.includes("失敗 test 名與 log path"),
      "finding content must name the failing tests and the log path"
    );
    assert.ok(bullet.includes("route"), "the finding must be routed to a repair lane");
  });

  // amend-pr-integration-test-scope T12: a consumer-repository full-suite run is recorded as N/A,
  // never as a red suite (the runner-side N/A routing is covered by
  // run-test-suite-consumer-routing.test.mjs).
  it("Scenario: Consumer repository records the full suite as N/A", () => {
    const bullet = governanceFullSuiteBullet();
    assert.ok(
      bullet.includes("source-maintainer checks: N/A"),
      "governance bullet must bind the runner's `source-maintainer checks: N/A` output"
    );
    assert.ok(
      bullet.includes("不算紅燈"),
      "the consumer N/A result must not be treated as a red suite"
    );
  });

  it("frontmatter extraction tolerates CRLF line endings", () => {
    const crlfSkill = [
      "---",
      "name: example-crlf",
      "description: Example skill for rule self-evolution CRLF prove-it.",
      "---",
      "",
      "# Example",
    ].join("\r\n");
    const frontmatter = crlfSkill.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    assert.ok(frontmatter.length > 0, "CRLF frontmatter must extract a non-empty body");
    assert.match(frontmatter, /^description:.*rule self-evolution.*$/m);
  });

  it("refs manifest declares upstream-copy warning exceptions explicitly", () => {
    const manifest = JSON.parse(read(".devpro/agent-skills-refs/manifest.json"));
    const skills = manifest.groups.flatMap((group) => group.skills);
    const upstreamSkills = skills.filter((skill) => skill.upstreamCopy === true);
    assert.deepEqual(upstreamSkills.map((skill) => skill.name).sort(), ["claude-code", "codex"]);
    for (const skill of upstreamSkills) {
      assert.equal(skill.upstreamCopy, true, `${skill.name} should declare upstreamCopy`);
      assert.deepEqual(
        [...skill.allowedWarnings].sort(),
        ["long-body", "missing-use-when"].sort(),
        `${skill.name} should declare exact warning classes`
      );
    }
    const mermaidSkill = skills.find((skill) => skill.name === "design-doc-mermaid");
    assert.ok(mermaidSkill, "design-doc-mermaid refs-manifest entry missing");
    assert.equal(mermaidSkill.upstreamCopy, undefined);
    assert.equal(mermaidSkill.allowedWarnings, undefined);

    const catalogManifest = JSON.parse(read(".devpro/agent-skills/manifest.json"));
    const catalogSkills = catalogManifest.groups.flatMap((group) => group.skills);
    const workflows = catalogSkills.find((skill) => skill.name === "workflows");
    assert.ok(workflows, "workflows catalog-manifest entry missing");
    assert.equal(workflows.upstreamCopy, undefined);
    assert.equal(workflows.allowedWarnings, undefined);
  });

  it("design-doc-mermaid is a first-party skill carrier, not an upstream copy", () => {
    const skill = read(".devpro/agent-skills-refs/documentation/design-doc-mermaid/SKILL.md");
    assert.match(skill, /name: design-doc-mermaid/);
    assert.match(skill, USE_WHEN_BILINGUAL_RE);
    assert.match(skill, /Source-grounded/);
    assert.match(skill, /Validate-before-finalize/);
    assert.match(skill, /Readable contrast/);
    assert.match(skill, /unvalidated/);
    assert.match(skill, /No asset churn/);
    assert.match(skill, /Do not copy `refs\/design-doc-mermaid-main\/SKILL\.md`/);
  });

  it("lint fails closed when manifest omits an actual skill", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skill-lint-"));
    try {
      await writeFile(
        path.join(tmp, ".devpro/agent-skills/group/example/SKILL.md"),
        `---\nname: example\ndescription: "Example skill. Use when testing manifest coverage."\n---\n\n# Example\n`
      );
      await writeFile(
        path.join(tmp, ".devpro/agent-skills/manifest.json"),
        `{"name":"fixture","groups":[{"name":"group","skills":[]}]}\n`
      );

      assert.throws(
        () => runLint(["--root", tmp]),
        /manifest: missing skill \.devpro\/agent-skills\/group\/example/
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("lint keeps undeclared Use when warnings visible", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skill-lint-"));
    try {
      await writeFile(
        path.join(tmp, ".devpro/agent-skills/group/example/SKILL.md"),
        `---\nname: example\ndescription: "Example skill without trigger wording."\n---\n\n# Example\n`
      );
      await writeFile(
        path.join(tmp, ".devpro/agent-skills/manifest.json"),
        `{"name":"fixture","groups":[{"name":"group","skills":[{"name":"example","path":".devpro/agent-skills/group/example"}]}]}\n`
      );
      await writeFile(
        path.join(tmp, ".devpro/agent-skills/.claude-plugin/plugin.json"),
        `{"name":"devpro","description":"Fixture plugin manifest.","skills":["./group"]}\n`
      );

      const stdout = runLint(["--root", tmp]);
      assert.match(stdout, /Checked 1 skill\(s\), 1 warning\(s\), 0 error\(s\)/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // TDD red (amend-output-language-zh T4): a Chinese use-when description should be
  // accepted once lint's use-when contract is bilingual (T5). Until T5 lands, lint only
  // recognizes English "use when", so this assertion is expected to fail (red).
  it("lint accepts Chinese use-when trigger wording without a warning", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skill-lint-"));
    try {
      await writeFile(
        path.join(tmp, ".devpro/agent-skills/group/example/SKILL.md"),
        `---\nname: example\ndescription: "範例技能。使用時機：當使用者需要驗證中文觸發詞是否被接受時。"\n---\n\n# Example\n`
      );
      await writeFile(
        path.join(tmp, ".devpro/agent-skills/manifest.json"),
        `{"name":"fixture","groups":[{"name":"group","skills":[{"name":"example","path":".devpro/agent-skills/group/example"}]}]}\n`
      );
      await writeFile(
        path.join(tmp, ".devpro/agent-skills/.claude-plugin/plugin.json"),
        `{"name":"devpro","description":"Fixture plugin manifest.","skills":["./group"]}\n`
      );

      const stdout = runLint(["--root", tmp]);
      assert.match(stdout, /Checked 1 skill\(s\), 0 warning\(s\), 0 error\(s\)/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // Negative guard symmetric to the bilingual widening (amend-output-language-zh cross-review
  // WARN, 軸4): a Chinese description with NO trigger wording must still emit missing-use-when.
  // Locks in that widening the contract to accept 使用時機/當…時 did not make arbitrary Chinese
  // text match — only the explicit trigger tokens do. The existing English no-trigger case above
  // does not exercise the Chinese path.
  it("lint keeps Chinese descriptions without a use-when trigger warned", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skill-lint-"));
    try {
      await writeFile(
        path.join(tmp, ".devpro/agent-skills/group/example/SKILL.md"),
        `---\nname: example\ndescription: "範例技能。用於驗證中文描述沒有觸發詞時仍會被標記。"\n---\n\n# Example\n`
      );
      await writeFile(
        path.join(tmp, ".devpro/agent-skills/manifest.json"),
        `{"name":"fixture","groups":[{"name":"group","skills":[{"name":"example","path":".devpro/agent-skills/group/example"}]}]}\n`
      );
      await writeFile(
        path.join(tmp, ".devpro/agent-skills/.claude-plugin/plugin.json"),
        `{"name":"devpro","description":"Fixture plugin manifest.","skills":["./group"]}\n`
      );

      const stdout = runLint(["--root", tmp]);
      assert.match(stdout, /Checked 1 skill\(s\), 1 warning\(s\), 0 error\(s\)/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("does not introduce root skills directories", () => {
    assert.equal(existsSync(path.join(repoRoot, "skills")), false, "root skills/ must not exist");
  });

  it("runtime skill discovery dirs hold only symlinks into .devpro/agent-skills/", () => {
    assertSkillDiscoveryDirIsSymlinksOnly(".claude/skills");
    assertSkillDiscoveryDirIsSymlinksOnly(".agents/skills");
  });

  // Renamed devpro:pre-pr -> pre-pr (design D10); the discovery mechanism itself
  // changed from a per-skill symlink to the shared `devpro` entry (design
  // D1/D3) resolving to the catalog root, through which pre-pr is reachable.
  it("Scenario: devpro:pre-pr runtime discovery paths are symlink projections of the SSOT", () => {
    const ssot = path.join(repoRoot, ".devpro/agent-skills/devpro-workflows/pre-pr");
    assert.ok(existsSync(path.join(ssot, "SKILL.md")), "pre-pr SSOT must exist");
    const catalogRoot = path.join(repoRoot, ".devpro/agent-skills");
    for (const rel of [".agents/skills/devpro", ".claude/skills/devpro"]) {
      const discovery = path.join(repoRoot, rel);
      assert.ok(lstatSync(discovery).isSymbolicLink(), `${rel} must be a symlink`);
      assert.equal(realpathSync(discovery), realpathSync(catalogRoot), `${rel} must resolve to the catalog root`);
      assert.ok(
        existsSync(path.join(discovery, "devpro-workflows", "pre-pr", "SKILL.md")),
        `${rel} must reach the pre-pr SSOT through the catalog root`
      );
    }
  });

  // enforce-openspec-authoring-feedforward (A)+(C): devpro:change must mandatory-load the
  // openspec-artifact-authoring skill before proposal/tasks/spec-delta content is written,
  // and the authoring skill body must carry the write-time feed-forward recipe for the two
  // most-repeated archive-gate format pitfalls (MODIFIED-delta body/canonical sync, Removed
  // Scenarios bare-title format). Anchors below must stay aligned with the proposal's
  // Target State grep strings.
  it("devpro:change SSOT mandatory-loads the openspec-artifact-authoring skill", () => {
    const skill = read(".devpro/agent-skills/devpro-workflows/change/SKILL.md");
    assert.match(skill, /openspec-artifact-authoring/);
    assert.match(skill, /必須載入|MUST load|mandatory/);
  });

  it("authoring skill feeds forward MODIFIED-delta body/canonical sync guidance", () => {
    const skill = read(".devpro/agent-skills/openspec/openspec-artifact-authoring/SKILL.md");
    assert.match(skill, /兩邊同步|逐行一致|同步 canonical/);
    assert.match(skill, /lint-delta-body-canonical-wrap/);
    assert.match(skill, /--base <change-base-ref>/);
    assert.match(skill, /HEAD\^/);
  });

  it("pre-PR and canonical flow require the immutable base-aware delta lint", () => {
    // 第三點六步段 lives in references/full-review-and-archive.md; read the full-rigor reading order.
    const prePr = readPrePrSkillFullReadingOrder();
    // Archive 原則 de-bundle：immutable wrap lint 正文在 sibling；entry 僅 Load-chain。
    const archivePrinciples = read(".devpro/agent-rules/openspec-archive-principles.md");
    for (const carrier of [prePr, archivePrinciples]) {
      assert.match(carrier, /lint-delta-body-canonical-wrap\.mjs openspec\/changes\/<name> --base <change-base-ref>/);
      assert.match(carrier, /immutable/);
      assert.match(carrier, /HEAD\^/);
    }
  });

  it("authoring skill feeds forward Removed Scenarios bare-title format", () => {
    const skill = read(".devpro/agent-skills/openspec/openspec-artifact-authoring/SKILL.md");
    assert.match(skill, /bare title|bare-title|單行/);
    assert.match(skill, /## Removed Scenarios/);
  });
});
