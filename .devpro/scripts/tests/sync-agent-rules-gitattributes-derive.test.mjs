/**
 * Prove-it for fix-consumer-whitespace-gitattributes-sync (D1–D5 / P1–P5).
 * Scenario titles match openspec delta rules-flow ADDED requirements exactly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deriveGitattributesManagedEntries,
  GITATTRIBUTES_MANAGED_ENTRIES,
  GITATTRIBUTES_MANAGED_BEGIN,
  GITATTRIBUTES_MANAGED_END,
  mergeGitattributesManagedBlock,
  validateGitattributesManagedBlock,
} from "../sync-agent-rules.mjs";
import { checkRangeWhitespace } from "../hooks/lib/whitespace-gate.mjs";
import {
  countGitignoreEntry,
  run,
  sourceRoot,
  withConsumerRepo,
} from "./lib/sync-agent-rules-harness.mjs";

const FIXTURE_REL =
  ".devpro/scripts/tests/fixtures/d30-post-hoc-r11-reviewer-output.md";
const FIXTURE_WHITESPACE_ENTRY = `${FIXTURE_REL} whitespace=-trailing-space`;
const ANTI_PATTERNS_REL = ".devpro/agent-rules/anti-patterns-design.md";
const ANTI_PATTERNS_WHITESPACE_ENTRY = `${ANTI_PATTERNS_REL} whitespace=-trailing-space`;

const LF_BASELINE_SOURCE = [
  ".devpro/scripts/hooks-git/* text eol=lf",
  ".gitignore text eol=lf",
  ".gitattributes text eol=lf",
  ".claude/settings.json text eol=lf",
  ".codex/hooks.json text eol=lf",
  ".cursor/hooks.json text eol=lf",
  ".opencode/plugins/devpro-hooks.js text eol=lf",
].join("\n");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "gitattributes-derive-test",
  GIT_AUTHOR_EMAIL: "gitattributes-derive-test@example.com",
  GIT_COMMITTER_NAME: "gitattributes-derive-test",
  GIT_COMMITTER_EMAIL: "gitattributes-derive-test@example.com",
};

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function managedBody(content) {
  const begin = content.indexOf(GITATTRIBUTES_MANAGED_BEGIN);
  const end = content.indexOf(GITATTRIBUTES_MANAGED_END);
  assert.ok(begin !== -1 && end !== -1 && end > begin);
  return content.slice(begin, end + GITATTRIBUTES_MANAGED_END.length);
}

async function withWhitespaceGateRepo(relPath, fileBytes, attributesLines, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gitattributes-ws-gate-"));
  try {
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "core.autocrlf", "false"]);
    await fs.writeFile(path.join(dir, "README.md"), "base\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "base"]);

    const abs = path.join(dir, ...relPath.split("/"));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, fileBytes);
    if (attributesLines.length > 0) {
      await fs.writeFile(path.join(dir, ".gitattributes"), `${attributesLines.join("\n")}\n`);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "fixture"]);
    // Two-dot range against resolved SHAs: avoids flaky three-dot merge-base /
    // ambient GIT_DIR pollution treating the range as an invalid symmetric diff.
    const baseSha = git(dir, ["rev-parse", "HEAD~1"]).trim();
    const headSha = git(dir, ["rev-parse", "HEAD"]).trim();
    return await fn(dir, `${baseSha}..${headSha}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("gitattributes managed whitespace derive", () => {
  it("LF baseline constant stays seven text eol=lf entries locked to source paths", async () => {
    assert.equal(GITATTRIBUTES_MANAGED_ENTRIES.length, 7);
    const sourceAttrs = await fs.readFile(path.join(sourceRoot, ".gitattributes"), "utf8");
    for (const entry of GITATTRIBUTES_MANAGED_ENTRIES) {
      assert.match(entry, / text eol=lf$/);
      assert.match(sourceAttrs, new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    }
  });

  it("Sync Managed Block Includes Source Fixture Whitespace Exception", async () => {
    const sourceAttrs = await fs.readFile(path.join(sourceRoot, ".gitattributes"), "utf8");
    assert.match(sourceAttrs, new RegExp(`^${FIXTURE_WHITESPACE_ENTRY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));

    const derived = deriveGitattributesManagedEntries(sourceAttrs);
    assert.ok(derived.includes(FIXTURE_WHITESPACE_ENTRY));
    assert.deepEqual(derived.slice(0, 7), [...GITATTRIBUTES_MANAGED_ENTRIES]);

    await withConsumerRepo(async (local) => {
      const { exitCode, stderr } = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.equal(exitCode, 0, stderr);
      const content = await fs.readFile(path.join(local.tmpDir, ".gitattributes"), "utf8");
      assert.equal(countGitignoreEntry(content, FIXTURE_WHITESPACE_ENTRY), 1);
      assert.match(managedBody(content), /whitespace=-trailing-space/);
    });

    const fixtureBytes = await fs.readFile(path.join(sourceRoot, FIXTURE_REL));
    await withWhitespaceGateRepo(FIXTURE_REL, fixtureBytes, [], (dir, range) => {
      const without = checkRangeWhitespace(range, dir);
      assert.equal(without.error, undefined, `without attrs must be whitespace finding, not infra: ${without.error}`);
      assert.equal(without.status, 2, "without attrs, intentional trailing space must trip gate (git exit 2)");
      assert.equal(without.ok, false, "without attrs, intentional trailing space must trip gate");
    });
    await withWhitespaceGateRepo(FIXTURE_REL, fixtureBytes, [FIXTURE_WHITESPACE_ENTRY], (dir, range) => {
      const ranged = checkRangeWhitespace(range, dir);
      assert.equal(ranged.error, undefined, `fixture with attrs infra error: ${ranged.error}`);
      assert.equal(ranged.ok, true, `fixture with attrs must not false-red: ${ranged.output}`);
    });
  });

  it("Sync Managed Block Includes Anti-Patterns Hard-Break Whitespace Exception", async () => {
    const sourceAttrs = await fs.readFile(path.join(sourceRoot, ".gitattributes"), "utf8");
    assert.match(
      sourceAttrs,
      new RegExp(`^${ANTI_PATTERNS_WHITESPACE_ENTRY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m")
    );

    const antiPath = path.join(sourceRoot, ANTI_PATTERNS_REL);
    const lines = (await fs.readFile(antiPath, "utf8")).split("\n");
    // 1-based line 38 → index 37
    assert.ok(lines[37].endsWith("  "), "line 38 must retain two trailing U+0020");

    const derived = deriveGitattributesManagedEntries(sourceAttrs);
    assert.ok(derived.includes(ANTI_PATTERNS_WHITESPACE_ENTRY));

    await withConsumerRepo(async (local) => {
      const { exitCode, stderr } = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.equal(exitCode, 0, stderr);
      const content = await fs.readFile(path.join(local.tmpDir, ".gitattributes"), "utf8");
      assert.equal(countGitignoreEntry(content, ANTI_PATTERNS_WHITESPACE_ENTRY), 1);
    });

    const antiBytes = await fs.readFile(antiPath);
    await withWhitespaceGateRepo(ANTI_PATTERNS_REL, antiBytes, [], (dir, range) => {
      const without = checkRangeWhitespace(range, dir);
      assert.equal(without.error, undefined, `without attrs must be whitespace finding, not infra: ${without.error}`);
      assert.equal(without.status, 2, "without attrs, :38 hard-break must trip gate (git exit 2)");
      assert.equal(without.ok, false, "without attrs, :38 hard-break must trip gate");
    });
    await withWhitespaceGateRepo(ANTI_PATTERNS_REL, antiBytes, [ANTI_PATTERNS_WHITESPACE_ENTRY], (dir, range) => {
      const ranged = checkRangeWhitespace(range, dir);
      assert.equal(ranged.error, undefined, `anti-patterns with attrs infra error: ${ranged.error}`);
      assert.equal(ranged.ok, true, `anti-patterns :38 with attrs must not false-red: ${ranged.output}`);
    });
  });

  it("Derive Picks Up A New Source Whitespace Exception Without Hand-Editing The Eol List", () => {
    const extra = ".devpro/agent-rules/example-future.md whitespace=-trailing-space";
    const sourceText = `${LF_BASELINE_SOURCE}\n${FIXTURE_WHITESPACE_ENTRY}\n${extra}\n`;
    const derived = deriveGitattributesManagedEntries(sourceText);
    assert.ok(derived.includes(extra));
    assert.deepEqual(derived.slice(0, 7), [...GITATTRIBUTES_MANAGED_ENTRIES]);
    assert.equal(
      GITATTRIBUTES_MANAGED_ENTRIES.includes(extra),
      false,
      "new whitespace exception must not require hand-append to LF eol constant"
    );
  });

  it("Unrelated Local-Only Attributes Stay Outside Managed Block", () => {
    const sourceText = [
      LF_BASELINE_SOURCE,
      FIXTURE_WHITESPACE_ENTRY,
      "*.png binary",
      "docs/** linguist-documentation",
      "",
    ].join("\n");
    const derived = deriveGitattributesManagedEntries(sourceText);
    assert.equal(derived.some((e) => e.includes("binary")), false);
    assert.equal(derived.some((e) => e.includes("linguist")), false);
    assert.ok(derived.includes(FIXTURE_WHITESPACE_ENTRY));

    const merged = mergeGitattributesManagedBlock(
      ["*.png binary\n", ".husky/* text eol=lf\n"].join(""),
      derived
    );
    assert.match(merged, /^\*\.png binary$/m);
    assert.match(merged, /^\.husky\/\* text eol=lf$/m);
    const body = managedBody(merged);
    assert.doesNotMatch(body, /\*\.png/);
    assert.doesNotMatch(body, /\.husky\//);
    assert.doesNotMatch(body, /linguist/);
    assert.match(body, new RegExp(FIXTURE_WHITESPACE_ENTRY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("Mixed Attribute Line Emits Only Whitespace Token", () => {
    const mixed =
      ".devpro/agent-rules/mixed.md text eol=lf diff=csharp whitespace=-trailing-space filter=lfs";
    const derived = deriveGitattributesManagedEntries(`${LF_BASELINE_SOURCE}\n${mixed}\n`);
    const expected = ".devpro/agent-rules/mixed.md whitespace=-trailing-space";
    assert.ok(derived.includes(expected));
    assert.equal(derived.some((e) => e.includes("diff=")), false);
    assert.equal(derived.some((e) => e.includes("filter=")), false);
    assert.equal(
      derived.filter((e) => e.startsWith(".devpro/agent-rules/mixed.md ")).length,
      1
    );
    assert.equal(derived.find((e) => e.startsWith(".devpro/agent-rules/mixed.md ")), expected);
  });

  it("Global Or Over-Wide Whitespace Pattern Fail Closed", () => {
    assert.throws(
      () =>
        deriveGitattributesManagedEntries(
          `${LF_BASELINE_SOURCE}\n* whitespace=-trailing-space\n`
        ),
      /fail-closed|over-wide|\*/i
    );
    assert.throws(
      () =>
        deriveGitattributesManagedEntries(
          `${LF_BASELINE_SOURCE}\n*.md whitespace=-trailing-space\n`
        ),
      /fail-closed|over-wide/i
    );

    const withMacro = `${LF_BASELINE_SOURCE}\n[attr]myattr whitespace=-trailing-space\n${FIXTURE_WHITESPACE_ENTRY}\n`;
    const derived = deriveGitattributesManagedEntries(withMacro);
    assert.equal(derived.some((e) => e.includes("[attr]")), false);
    assert.ok(derived.includes(FIXTURE_WHITESPACE_ENTRY));
  });

  it("Check Fails When Derived Whitespace Exceptions Drift", async () => {
    await withConsumerRepo(async (local) => {
      const syncOk = run(local.syncScript, "--sync", { cwd: local.tmpDir });
      assert.equal(syncOk.exitCode, 0, syncOk.stderr);

      const attributesPath = path.join(local.tmpDir, ".gitattributes");
      let content = await fs.readFile(attributesPath, "utf8");
      assert.ok(content.includes(FIXTURE_WHITESPACE_ENTRY));

      content = content.replace(`${FIXTURE_WHITESPACE_ENTRY}\n`, "");
      await fs.writeFile(attributesPath, content);

      const check = run(local.syncScript, "--check", { cwd: local.tmpDir });
      assert.notEqual(check.exitCode, 0);
      assert.match(check.stderr, /\.gitattributes managed block differs|Out of sync/i);
      assert.match(check.stderr, /--sync/);
    });
  });

  it("Guidance Forbids Hand-Editing Synced Files For Whitespace", async () => {
    const alignment = await fs.readFile(
      path.join(sourceRoot, ".devpro/agent-rules/gitattributes-alignment.md"),
      "utf8"
    );
    const release = await fs.readFile(
      path.join(sourceRoot, ".devpro/agent-rules/release-sit-uat-pat-prod.md"),
      "utf8"
    );
    assert.match(alignment, /MUST NOT.*hand-edit|hand-edit.*synced|\.devpro/i);
    assert.match(alignment, /rerun.*--sync|report.*source/i);
    assert.match(
      alignment,
      /derive|source.*\.gitattributes/i,
      "alignment must describe derive contract, not hand SSOT table as runtime authority"
    );
    assert.doesNotMatch(
      alignment,
      /This file is the single source of truth for Devpro-managed consumer repo `\.gitattributes` LF checkout protection entries/
    );

    const guidanceCorpus = `${alignment}\n${release}`;
    assert.match(
      guidanceCorpus,
      /MUST NOT[\s\S]{0,200}hand-edit[\s\S]{0,120}synced[\s\S]{0,80}\.devpro|hand-edit synced `?\.devpro/i
    );
    assert.match(guidanceCorpus, /rerun[^\n]*--sync|report[^\n]*source/i);
  });

  it("derive is deterministic: baseline order then sorted whitespace paths; last-wins per path", () => {
    const sourceText = [
      LF_BASELINE_SOURCE,
      "z-path.md whitespace=-trailing-space",
      "a-path.md whitespace=-trailing-space",
      "a-path.md whitespace=-blank-at-eol",
      "",
    ].join("\n");
    const derived = deriveGitattributesManagedEntries(sourceText);
    assert.deepEqual(derived.slice(0, 7), [...GITATTRIBUTES_MANAGED_ENTRIES]);
    const ws = derived.slice(7);
    assert.deepEqual(ws, [
      "a-path.md whitespace=-blank-at-eol",
      "z-path.md whitespace=-trailing-space",
    ]);

    const canonical = [
      GITATTRIBUTES_MANAGED_BEGIN,
      ...derived,
      GITATTRIBUTES_MANAGED_END,
    ].join("\n");
    assert.equal(validateGitattributesManagedBlock(`${canonical}\n`, derived), "");
  });
});
