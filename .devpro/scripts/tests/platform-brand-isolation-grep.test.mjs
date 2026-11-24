/**
 * platform-brand-isolation-grep.test.mjs
 *
 * Machine guard: the generic layer must not contain runtime brand strings.
 * Brand strings are restricted to per-runtime sink files at
 *   `.devpro/agent-rules/platform-adapters/<runtime>.md`
 *
 * After chore/refactor-platform-brand-isolation (PR #334) and
 * chore/strengthen-brand-isolation-multi-runtime (this change), the
 * brand isolation invariant covers five runtime brands:
 *   cursor / copilot / gemini / windsurf / opencode
 *
 * IDE-locked filename / path exceptions are handled by regex lookbehind
 * (`.cursor/`, `.windsurfrules`) or lookahead (`GEMINI.md`).
 *
 * EXCLUDED from scan:
 *   - `platform-adapters/<runtime>.md`     per-brand permitted sink
 *   - `openspec/changes/**`                forward-only archive, frozen
 *   - `README.md`                          display doc, out of scope
 *   - `.devpro/scripts/sync-agent-rules.mjs`  program code, path literals
 *   - `.devpro-agent-rules/`               submodule internals
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { SOURCE_ROOT, sourcePath } from "./lib/source-root.mjs";

// ---------------------------------------------------------------------------
// Brand registry — single source of truth for the invariant
// ---------------------------------------------------------------------------

const BRANDS = [
  {
    name: "cursor",
    // (?<![./\w]) — preceding char must NOT be `.`, `/`, or word char
    //   excludes `.cursor`, `.cursor/`, `platform-adapters/cursor.md`,
    //            `recursor`, `precursor`
    // (?!\w)      — trailing char must NOT be a word char
    //   excludes `cursors`, `cursorial`
    regex: /(?<![./\w])cursor(?!\w)/gi,
    sinkRelPath: ".devpro/agent-rules/platform-adapters/cursor.md",
  },
  {
    name: "copilot",
    regex: /(?<![./\w])copilot(?!\w)/gi,
    sinkRelPath: ".devpro/agent-rules/platform-adapters/copilot.md",
  },
  {
    name: "gemini",
    // (?!\.md|\w) — trailing char must NOT be `.md` (IDE-locked filename
    //   GEMINI.md from sync-agent-rules.mjs SYNC_DIRS literal) or word char
    regex: /(?<![./\w])gemini(?!\.md|\w)/gi,
    sinkRelPath: ".devpro/agent-rules/platform-adapters/gemini.md",
  },
  {
    name: "windsurf",
    // `.windsurfrules` IDE-locked filename is excluded by leading `.`
    // lookbehind (same mechanism as `.cursor/`)
    regex: /(?<![./\w])windsurf(?!\w)/gi,
    sinkRelPath: null, // no per-runtime adapter yet
  },
  {
    name: "opencode",
    regex: /(?<![./\w])opencode(?!\w)/gi,
    sinkRelPath: ".devpro/agent-rules/platform-adapters/opencode.md",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listFiles(dir, filter) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  const pred =
    typeof filter === "function" ? filter : (name) => name.endsWith(filter);
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...listFiles(full, filter));
    } else if (pred(entry)) {
      results.push(full);
    }
  }
  return results;
}

function findBrandHits(content, brand) {
  // Reset lastIndex (regex is global with /g flag)
  brand.regex.lastIndex = 0;
  const hits = [];
  let m;
  while ((m = brand.regex.exec(content)) !== null) {
    hits.push({ index: m.index, match: m[0] });
  }
  return hits;
}

function isBrandSink(absPath) {
  const sinks = BRANDS.map((b) => b.sinkRelPath).filter(Boolean);
  return sinks.some((sink) =>
    absPath.endsWith(sink.split("/").join(path.sep)),
  );
}

// ---------------------------------------------------------------------------
// Tests — real file scans (one container per scope, loop over brands inside)
// ---------------------------------------------------------------------------

test("AGENTS.md has no runtime brand string (5 brands)", () => {
  const txt = readFileSync(sourcePath("AGENTS.md"), "utf8");
  for (const brand of BRANDS) {
    const hits = findBrandHits(txt, brand);
    assert.deepStrictEqual(
      hits,
      [],
      `AGENTS.md must not contain "${brand.name}" brand string. Hits: ${JSON.stringify(hits)}`,
    );
  }
});

test(".devpro/agent-rules/**/*.md (excluding platform-adapters sinks) has no runtime brand string", () => {
  const files = listFiles(sourcePath(".devpro/agent-rules"), ".md").filter(
    (f) => !isBrandSink(f),
  );
  assert.ok(files.length > 0, "Expected at least one .md file in agent-rules");
  for (const file of files) {
    const txt = readFileSync(file, "utf8");
    for (const brand of BRANDS) {
      const hits = findBrandHits(txt, brand);
      assert.deepStrictEqual(
        hits,
        [],
        `${path.relative(SOURCE_ROOT, file)} must have no "${brand.name}" brand string. Hits: ${JSON.stringify(hits)}`,
      );
    }
  }
});

test("openspec/specs/**/spec.md has no runtime brand string (5 brands)", () => {
  const files = listFiles(
    sourcePath("openspec/specs"),
    (name) => name === "spec.md",
  );
  assert.ok(
    files.length > 0,
    "Expected at least one spec.md under openspec/specs",
  );
  for (const file of files) {
    const txt = readFileSync(file, "utf8");
    for (const brand of BRANDS) {
      const hits = findBrandHits(txt, brand);
      assert.deepStrictEqual(
        hits,
        [],
        `${path.relative(SOURCE_ROOT, file)} must have no "${brand.name}" brand string. Hits: ${JSON.stringify(hits)}`,
      );
    }
  }
});

test("platform-adapters/<brand>.md retains its own brand string (sole sink)", () => {
  for (const brand of BRANDS) {
    if (!brand.sinkRelPath) continue; // skip brands without adapter
    const txt = readFileSync(sourcePath(brand.sinkRelPath), "utf8");
    const hits = findBrandHits(txt, brand);
    assert.ok(
      hits.length > 0,
      `${brand.sinkRelPath} must contain "${brand.name}" brand strings — it is the sole permitted sink; if this fails the sink has been over-cleaned`,
    );
  }
});

// ---------------------------------------------------------------------------
// Tests — regex edge cases (self-test fixture for all 5 brands)
// ---------------------------------------------------------------------------

test("regex correctly handles edge cases (5 brands)", () => {
  const cursor = BRANDS.find((b) => b.name === "cursor");
  const copilot = BRANDS.find((b) => b.name === "copilot");
  const gemini = BRANDS.find((b) => b.name === "gemini");
  const windsurf = BRANDS.find((b) => b.name === "windsurf");
  const opencode = BRANDS.find((b) => b.name === "opencode");

  // --- cursor false-positive exclusions ---
  assert.strictEqual(findBrandHits(".cursor/hooks.json", cursor).length, 0);
  assert.strictEqual(findBrandHits(".cursor", cursor).length, 0);
  assert.strictEqual(findBrandHits(".cursor ", cursor).length, 0);
  assert.strictEqual(
    findBrandHits("platform-adapters/cursor.md", cursor).length,
    0,
  );
  assert.strictEqual(findBrandHits("recursor", cursor).length, 0);
  assert.strictEqual(findBrandHits("precursor", cursor).length, 0);
  assert.strictEqual(findBrandHits("cursors", cursor).length, 0);

  // --- gemini false-positive exclusions (IDE-locked filename) ---
  assert.strictEqual(
    findBrandHits("`GEMINI.md`", gemini).length,
    0,
    "GEMINI.md (IDE-locked filename) must not match",
  );
  assert.strictEqual(
    findBrandHits("git add ... GEMINI.md", gemini).length,
    0,
    "GEMINI.md in git add list must not match",
  );
  assert.strictEqual(
    findBrandHits("`gemini.md`", gemini).length,
    0,
    "gemini.md (lowercase filename) must not match",
  );

  // --- windsurf false-positive exclusions (IDE-locked filename) ---
  assert.strictEqual(
    findBrandHits(".windsurfrules", windsurf).length,
    0,
    ".windsurfrules (IDE-locked filename, dot-prefixed) must not match",
  );

  // --- copilot false-positive exclusions ---
  assert.strictEqual(findBrandHits("platform-adapters/copilot.md", copilot).length, 0);

  // --- true-positive brand strings (must match) ---
  assert.strictEqual(findBrandHits("Cursor PR #222", cursor).length, 1);
  assert.strictEqual(findBrandHits("Made with Cursor", cursor).length, 1);
  assert.strictEqual(findBrandHits("CURSOR", cursor).length, 1);
  assert.strictEqual(findBrandHits("[agent:cursor]", cursor).length, 1);

  assert.strictEqual(findBrandHits("GitHub Copilot", copilot).length, 1);
  assert.strictEqual(findBrandHits("Copilot suggested...", copilot).length, 1);
  assert.strictEqual(findBrandHits("[agent:copilot]", copilot).length, 1);

  assert.strictEqual(findBrandHits("Gemini CLI", gemini).length, 1);
  assert.strictEqual(findBrandHits("[agent:gemini]", gemini).length, 1);
  assert.strictEqual(
    findBrandHits("Gemini for code review", gemini).length,
    1,
    "Gemini followed by space (not .md) must match",
  );

  assert.strictEqual(findBrandHits("Windsurf IDE", windsurf).length, 1);
  assert.strictEqual(findBrandHits("[agent:windsurf]", windsurf).length, 1);

  assert.strictEqual(findBrandHits("OpenCode runtime", opencode).length, 1);
  assert.strictEqual(findBrandHits("[agent:opencode]", opencode).length, 1);
});
