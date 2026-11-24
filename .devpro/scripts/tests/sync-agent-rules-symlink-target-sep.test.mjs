/**
 * Host-neutral prove-it / regression for Windows symlink target separator
 * equality (#1935 / fix-windows-symlink-target-sep).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeSymlinkTargetSeparators,
  isMalformedRelativeSymlinkTarget,
} from "../sync-agent-rules.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const scriptsRoot = path.resolve(scriptDir, "..");
const syncAgentRulesPath = path.join(scriptsRoot, "sync-agent-rules.mjs");

const WINDOWS_STYLE_OBSERVED = "..\\..\\.devpro\\agent-skills\\devpro-workflows\\workflows";
const POSIX_EXPECTED = "../../.devpro/agent-skills/devpro-workflows/workflows";
const SEPARATOR_WARN_NOTE =
  "True symlinks must not fail solely because readlink returns '\\' vs '/'; separator-normalized target checks apply after this fix.";

describe("normalizeSymlinkTargetSeparators helper", () => {
  it("converts backslash segments to forward slash", () => {
    assert.equal(normalizeSymlinkTargetSeparators("a\\b"), "a/b");
  });

  it("is a no-op for forward-slash-only targets", () => {
    assert.equal(normalizeSymlinkTargetSeparators("a/b"), "a/b");
  });

  it("normalizes mixed separators", () => {
    assert.equal(normalizeSymlinkTargetSeparators("a\\b/c"), "a/b/c");
  });

  it("rejects null/non-string instead of coercing to the literal 'null'", () => {
    assert.throws(() => normalizeSymlinkTargetSeparators(null), /got null/);
    assert.throws(() => normalizeSymlinkTargetSeparators(undefined), /got undefined/);
    assert.notEqual(
      (() => {
        try {
          return normalizeSymlinkTargetSeparators(null);
        } catch {
          return Symbol("threw");
        }
      })(),
      "null"
    );
    assert.equal(normalizeSymlinkTargetSeparators("null"), "null");
  });
});

describe("prove-it: raw !== vs separator-normalized equality", () => {
  it("raw Windows-style observed target fails strict !== against POSIX expected", () => {
    assert.notEqual(
      WINDOWS_STYLE_OBSERVED,
      POSIX_EXPECTED,
      "precondition: raw backslash target must !== forward-slash expected (old validate/checkDir bug)"
    );
  });

  it("normalized observed equals normalized expected", () => {
    assert.equal(
      normalizeSymlinkTargetSeparators(WINDOWS_STYLE_OBSERVED),
      normalizeSymlinkTargetSeparators(POSIX_EXPECTED)
    );
    assert.equal(
      normalizeSymlinkTargetSeparators(WINDOWS_STYLE_OBSERVED),
      POSIX_EXPECTED
    );
  });
});

describe("discovery malformed gate (separator-normalized)", () => {
  it("accepts relative targets that differ only by backslash separators", () => {
    assert.equal(isMalformedRelativeSymlinkTarget(WINDOWS_STYLE_OBSERVED), false);
    assert.equal(isMalformedRelativeSymlinkTarget("a\\b\\c"), false);
  });

  it("rejects win32 absolute, root-relative, UNC/device, empty, and NUL/CRLF", () => {
    for (const target of [
      "C:\\Users\\x",
      "\\root-relative\\x",
      "\\\\server\\share\\x",
      "\\\\?\\C:\\device\\x",
      "",
      "a\\b\0c",
      "a\\b\nc",
      "a\\b\rc",
      null,
      undefined,
    ]) {
      assert.equal(isMalformedRelativeSymlinkTarget(target), true, target);
    }
  });

  it("rejects drive-relative targets on Win32 but preserves POSIX relative names", () => {
    assert.equal(
      isMalformedRelativeSymlinkTarget("C:relative\\x"),
      process.platform === "win32",
      "drive-relative spelling is unsafe only when interpreted by native Win32"
    );
  });
});

describe("production mjs scan lock (FR5)", () => {
  it("locks readlink producers and bans raw strict equality / discovery includes(\\\\ )", async () => {
    const productionMjs = [];
    async function walk(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "tests" || entry.name === "node_modules") continue;
          await walk(abs);
          continue;
        }
        if (!entry.name.endsWith(".mjs") || entry.name.endsWith(".test.mjs")) continue;
        productionMjs.push(abs);
      }
    }
    await walk(scriptsRoot);

    const withReadlink = productionMjs
      .filter((abs) => {
        // sync read below; filter via sync content check in loop
        return true;
      });

    const readlinkFiles = [];
    for (const abs of withReadlink) {
      const text = await fs.readFile(abs, "utf8");
      if (/\breadlink\b/.test(text)) {
        readlinkFiles.push(path.relative(scriptsRoot, abs).split(path.sep).join("/"));
      }
    }
    assert.deepEqual(
      readlinkFiles.sort(),
      // design D5 (refactor-agent-skills-entry) — lib/legacy-skill-entry-
      // artifacts.mjs's classifyLegacySkillEntryLink() also reads legacy
      // per-skill discovery link literals via fs.readlink.
      ["lib/legacy-skill-entry-artifacts.mjs", "lint-agent-skills.mjs", "sync-agent-rules.mjs"].sort(),
      "production .mjs with readlink must remain only sync-agent-rules + lint-agent-skills + legacy-skill-entry-artifacts"
    );

    const syncSource = await fs.readFile(syncAgentRulesPath, "utf8");

    assert.equal(
      syncSource.includes("linkTarget !== output.linkTarget"),
      false,
      "validateManagedSkillFilesystem must not raw-compare linkTarget !== output.linkTarget"
    );
    assert.equal(
      syncSource.includes("sourceLinkTarget !== targetLinkTarget"),
      false,
      "checkDir must not raw-compare sourceLinkTarget !== targetLinkTarget"
    );

    // Standalone discovery malformed check must not reject solely via includes("\\").
    assert.equal(
      /linkTarget\.includes\("\\\\"\)/.test(syncSource),
      false,
      'discovery must not use standalone linkTarget.includes("\\\\") as malformed gate'
    );

    // Both equality sites must wrap with normalizeSymlinkTargetSeparators.
    assert.match(
      syncSource,
      /normalizeSymlinkTargetSeparators\(\s*linkTarget\s*\)\s*!==\s*normalizeSymlinkTargetSeparators\(\s*output\.linkTarget\s*\)/
    );
    assert.match(
      syncSource,
      /normalizeSymlinkTargetSeparators\(\s*sourceLinkTarget\s*\)\s*!==\s*normalizeSymlinkTargetSeparators\(\s*targetLinkTarget\s*\)/
    );
  });

  it("WARN carries managed-skill-discovery-degraded token and D6 separator note", async () => {
    const syncSource = await fs.readFile(syncAgentRulesPath, "utf8");
    assert.match(syncSource, /managed-skill-discovery-degraded/);
    assert.match(
      syncSource,
      /Prefer OS symlink creation \(Windows: Developer Mode\)/
    );
    assert.match(
      syncSource,
      /True symlinks must not fail solely because readlink returns/
    );
    assert.match(
      syncSource,
      /separator-normalized target checks apply after this fix\./
    );
    // Lock the runtime D6 separator sentence (what stderr shows after JS escapes).
    assert.equal(
      SEPARATOR_WARN_NOTE.includes("readlink returns '\\' vs '/'"),
      true
    );
    assert.equal(
      SEPARATOR_WARN_NOTE.endsWith("separator-normalized target checks apply after this fix."),
      true
    );
  });
});
