/**
 * opencode-skill-discovery.test.mjs
 *
 * T6 / R9 (refactor-agent-skills-entry D11): OpenCode V2 discovers skills via
 * `ctx.skill.transform` (D18) by walking the `.devpro/agent-skills/manifest.json`
 * catalog — the same 2-entry topology's SSOT the `.agents/skills/devpro` /
 * `.claude/skills/devpro` symlinks resolve to — and MUST NOT ship source-owned
 * `.opencode/skills`, `OPENCODE.md`, or `.opencode/command/`.
 *
 * V2 `debug` has no skill subcommand (V2-Q7: `debug` = agents|config|paths)
 * and headless debug invocations do not activate plugin effects — skill discovery
 * is asserted through the bridge harness (real default-export `setup(ctx)` with a
 * fake ctx), not a CLI probe. The catalog manifest is read-only for the plugin.
 *
 * Registration ids are the catalog's bare names (no `dp-` prefix, no
 * `devpro:` namespace; the D12 host probe confirmed OpenCode lists and invokes
 * catalog skills by bare id). Every `editor.add` payload MUST mirror the host `Skill.Info` required
 * keys exactly (lesson from archived `fix-opencode-skill-add-path`: a fake ctx
 * MUST NOT be more permissive than the host), and one skill's registration
 * failure MUST NOT stop the rest of the catalog from registering (NFR8).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { git } from "./lib/git.mjs";
import {
  JsCommentSpanScanError,
  stripJsCommentSpans,
} from "../lib/js-comment-spans.mjs";

const PLUGIN = repoPath(".opencode/plugins/devpro-hooks.js");
const CATALOG_MANIFEST_REL = ".devpro/agent-skills/manifest.json";

/**
 * Flatten the catalog manifest into `{ id, skillPath }` entries. `id` is the
 * bare catalog name (equal to the SSOT dir basename and frontmatter `name`
 * per the D1–D4 three-lock invariant) — never `dp-`-prefixed.
 */
function readCatalogSkills() {
  const manifest = JSON.parse(readFileSync(repoPath(CATALOG_MANIFEST_REL), "utf8"));
  const entries = [];
  for (const group of manifest.groups ?? []) {
    for (const skill of group.skills ?? []) {
      entries.push({
        id: skill.name,
        skillPath: path.join(repoPath(skill.path), "SKILL.md"),
      });
    }
  }
  return entries;
}

// ── Skill-registration contract guard (rule-anchor-guard-strength.md) ─────
//
// - value set: bidirectional equality (missing OR extra key reds, naming it)
// - forbidden side: permanent positive/negative fixtures in this file
// - scope: bounded `editor.add(` blocks; unterminated block fails closed;
//   comments stripped via the shared lexical stripper (`js-comment-spans`).
const REGISTRATION_KEYS = Object.freeze(["content", "description", "id", "name", "path"]);
const LOCATION_KEY_RE = /(?<![\w.$-])location\s*:/u;
const LOCATION_SHORTHAND_RE = /(?<![\w.$-])location(?![\w$:-])/u;

/** Blank string-literal bodies so key scanning only sees code (quotes stay). */
function blankStringLiterals(code) {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < code.length) {
        const inner = code[i];
        if (inner === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        if (inner === quote) {
          out += quote;
          i += 1;
          break;
        }
        if (inner === "\n" && quote !== "`") {
          throw new Error("string literal spans a newline (unbalanced source)");
        }
        out += " ";
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Matching `)` for the call opening at `openIdx`; string-aware (comments pre-stripped). */
function findCallClose(code, openIdx) {
  let depth = 0;
  let i = openIdx;
  let quote = null;
  while (i < code.length) {
    const ch = code[i];
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Extract `editor.add(...)` payload blocks with lexical scope (guard-strength
 * §scope rule 1): comments stripped first, then balanced-paren scanning so a
 * `});` inside a comment or string can never truncate the block early.
 * Unterminated block → `{ ok: false }` (fail closed, index reported).
 */
function findEditorAddBlocks(source) {
  // Fast path: carriers without the call site are never comment-stripped, so
  // non-JS files (markdown fences, templates) cannot trip the lexical stripper.
  if (!source.includes("editor.add(")) return { ok: true, blocks: [] };
  let code;
  try {
    code = stripJsCommentSpans(source);
  } catch (err) {
    if (!(err instanceof JsCommentSpanScanError)) throw err;
    return { ok: false, reason: `comment scan failed: ${err.message}` };
  }
  const blocks = [];
  let from = 0;
  for (;;) {
    const start = code.indexOf("editor.add(", from);
    if (start < 0) return { ok: true, blocks };
    const close = findCallClose(code, start + "editor.add".length);
    if (close < 0) {
      return { ok: false, reason: `unterminated editor.add( block at index ${start}` };
    }
    blocks.push(code.slice(start, close + 1));
    from = close + 1;
  }
}

/** `location` property/shorthand residue in payload code (comments/strings excluded). */
function findLocationResidue(source) {
  const scan = findEditorAddBlocks(source);
  if (!scan.ok) return scan;
  const hits = [];
  for (const block of scan.blocks) {
    let code;
    try {
      code = blankStringLiterals(block);
    } catch (err) {
      return { ok: false, reason: `string scan failed: ${err.message}` };
    }
    const match = code.match(LOCATION_KEY_RE) || code.match(LOCATION_SHORTHAND_RE);
    if (match) hits.push(match[0]);
  }
  return { ok: true, hits };
}

/** Bounded polling wait — deterministic settling for fire-and-forget promises. */
async function waitFor(predicate, { timeoutMs = 1000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

const FORBIDDEN = [
  "OPENCODE.md",
  ".opencode/skills",
  ".opencode/skill",
  ".opencode/command",
  ".opencode/commands",
];

/** Event stream that never yields — no timers/handles, abort is not required. */
function neverEndingStream() {
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () => new Promise(() => {}),
  };
}

/** Minimal fake V2 ctx covering the five registration surfaces of setup(). */
function makeFakeCtx({ directory }) {
  const registrations = {
    evaluate: null,
    prompt: null,
    executeAfter: null,
    skillTransform: null,
  };
  const ctx = {
    app: { version: "fake-test" },
    location: { directory },
    options: {},
    permission: {
      hook(name, fn) {
        if (name === "evaluate") registrations.evaluate = fn;
      },
    },
    session: {
      hook(name, fn) {
        if (name === "prompt") registrations.prompt = fn;
      },
      get: async ({ sessionID }) => ({
        location: { directory },
        projectID: "prj_test",
      }),
      synthetic: async () => {},
      prompt: async () => {},
    },
    tool: {
      hook(name, fn) {
        if (name === "execute.after") registrations.executeAfter = fn;
      },
    },
    skill: {
      transform: async (fn) => {
        registrations.skillTransform = fn;
      },
    },
    event: {
      subscribe: () => neverEndingStream(),
    },
  };
  return { ctx, registrations };
}

describe("OpenCode skill discovery (T6 re-anchor: catalog manifest, V2 ctx.skill.transform)", () => {
  it(".agents/skills is the 2-entry topology's sole devpro symlink into the catalog root", () => {
    const skillsDir = repoPath(".agents/skills");
    assert.equal(existsSync(skillsDir), true, "missing .agents/skills");
    const entries = readdirSync(skillsDir);
    assert.deepEqual(
      entries,
      ["devpro"],
      ".agents/skills must expose exactly one entry: devpro (D1–D4 2-entry topology)"
    );
    const entryPath = path.join(skillsDir, "devpro");
    assert.equal(
      lstatSync(entryPath).isSymbolicLink(),
      true,
      ".agents/skills/devpro must be a symlink"
    );
    assert.equal(
      realpathSync(entryPath),
      realpathSync(repoPath(".devpro/agent-skills")),
      ".agents/skills/devpro must resolve to the .devpro/agent-skills catalog root"
    );
  });

  it("source tree forbids .opencode/skills, OPENCODE.md, and source-owned .opencode/command", () => {
    for (const rel of FORBIDDEN) {
      assert.equal(
        existsSync(repoPath(rel)),
        false,
        `forbidden OpenCode skill/command carrier must not exist: ${rel}`
      );
    }
  });

  it("ctx.skill.transform registers the manifest catalog via editor.add (bridge harness)", async () => {
    const mod = await import(`${pathToFileURL(PLUGIN).href}?skill=${Date.now()}`);
    const { ctx, registrations } = makeFakeCtx({ directory: repoPath(".") });
    const dispose = await mod.default.setup(ctx);
    try {
      assert.equal(
        typeof registrations.skillTransform,
        "function",
        "setup must register ctx.skill.transform"
      );
      // Expected registry = the catalog manifest enumeration (same source the
      // plugin reads — the plugin MUST NOT maintain a second content tree).
      const expected = readCatalogSkills().filter((e) => existsSync(e.skillPath));
      // Cross-check against the SKILL.md files on disk (an independent source)
      // instead of a hardcoded count, so adding a skill does not break this
      // test while an empty or truncated enumeration still does.
      const onDisk = readdirSync(repoPath(".devpro/agent-skills"), {
        recursive: true,
      }).filter((rel) => path.basename(rel) === "SKILL.md");
      assert.ok(onDisk.length > 0, "catalog tree must contain SKILL.md files");
      assert.equal(
        expected.length,
        onDisk.length,
        `catalog manifest enumeration (${expected.length}) must cover every SKILL.md on disk (${onDisk.length})`
      );
      const added = [];
      await registrations.skillTransform({
        // Host-schema-mirroring fake editor (fix-opencode-skill-add-path
        // lesson): reject exactly like the real host `Skill.Info` decoder
        // would on a missing/non-string required key — a fake ctx MUST NOT
        // be more permissive than the host.
        add: (entry) => {
          for (const key of REGISTRATION_KEYS) {
            if (typeof entry?.[key] !== "string") {
              throw new Error(`SchemaError(Missing key at ["${key}"])`);
            }
          }
          added.push(entry);
        },
      });
      assert.equal(
        added.length,
        expected.length,
        `editor.add list must equal the catalog manifest enumeration (got ${added.length}, expected ${expected.length})`
      );
      // Registered id set == the 20 catalog skill names — bare names, no
      // `dp-` prefix (D11).
      assert.deepEqual(
        added.map((a) => a.id).sort(),
        expected.map((e) => e.id).sort(),
        "registered id set must equal the catalog manifest id set"
      );
      for (const { id, skillPath } of expected) {
        const entry = added.find((a) => a.id === id);
        assert.ok(entry, `editor.add must register ${id}`);
        assert.equal(
          entry.path,
          skillPath,
          `${id} path must be the SSOT file (OpenCode v2.0.11 Skill.Info required key)`
        );
        // Host Skill.Info key set — bidirectional equality: a missing key AND an
        // extra/legacy key (e.g. `location`) both red here, naming the difference.
        const actualKeys = Object.keys(entry).sort();
        assert.deepEqual(
          actualKeys,
          [...REGISTRATION_KEYS].sort(),
          `${id} editor.add payload key set drifted: got [${actualKeys.join(", ")}], expected [${[...REGISTRATION_KEYS].sort().join(", ")}]`
        );
        assert.equal(
          entry.content,
          readFileSync(skillPath, "utf8"),
          `${id} content must be read from the SSOT file`
        );
        assert.ok(String(entry.name).length > 0, `${id} name from frontmatter`);
        assert.ok(String(entry.description).length > 0, `${id} description from frontmatter`);
      }
      // name/description come from the SKILL.md frontmatter (SSOT file); bare
      // catalog id — no dp- prefix (D11).
      const init = added.find((a) => a.id === "init");
      assert.ok(init, "init must be registered");
      assert.equal(init.name, "init");
      assert.match(String(init.description), /環境初始化 workflow/);
      assert.doesNotMatch(
        String(init.description),
        /^"/,
        "YAML quotes must be stripped from frontmatter values"
      );
      // The four other registration surfaces stay wired (setup completeness).
      assert.equal(typeof registrations.evaluate, "function");
      assert.equal(typeof registrations.prompt, "function");
      assert.equal(typeof registrations.executeAfter, "function");
    } finally {
      await dispose();
    }
  });

  it("a single editor.add failure (missing required key) does not stop the rest of the catalog from registering", async () => {
    const mod = await import(`${pathToFileURL(PLUGIN).href}?skill-partial-fail=${Date.now()}`);
    const { ctx, registrations } = makeFakeCtx({ directory: repoPath(".") });
    const dispose = await mod.default.setup(ctx);
    try {
      const catalog = readCatalogSkills().filter((e) => existsSync(e.skillPath));
      // Mid-list target (not first/last) so the guard cannot pass by accident
      // of iteration order (e.g. an early-return that only skips the head).
      const poisoned = catalog.find((e) => e.id === "pre-pr");
      assert.ok(poisoned, "fixture assumption: pre-pr is in the catalog");
      const added = [];
      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (...args) => {
        warnings.push(args.map(String).join(" "));
      };
      try {
        // Simulate the real host rejecting one skill's registration (schema
        // decode failure) — the plugin, not this fake, must isolate it.
        await assert.doesNotReject(
          // async wrapper (not a bare arrow): guarantees a Promise is always
          // returned to doesNotReject AND catches a synchronous throw from
          // inside skillTransform — a bare `() => fn()` cannot do either when
          // `fn` is itself a plain (non-async) function (advisor F1 lesson).
          async () =>
            registrations.skillTransform({
              add: (entry) => {
                if (entry.id === poisoned.id) {
                  throw new Error(`SchemaError(Missing key at ["path"]) for ${entry.id}`);
                }
                added.push(entry);
              },
            }),
          "a single editor.add failure must not reject the whole ctx.skill.transform call"
        );
      } finally {
        console.warn = originalWarn;
      }
      assert.equal(
        added.length,
        catalog.length - 1,
        "every catalog skill except the poisoned one must still register"
      );
      assert.ok(
        !added.some((a) => a.id === poisoned.id),
        `${poisoned.id} must not appear in the registered set (its editor.add threw)`
      );
      assert.ok(
        warnings.some((line) => line.includes(poisoned.id)),
        `expected a visible console.warn naming ${poisoned.id}, got: ${JSON.stringify(warnings)}`
      );
    } finally {
      await dispose();
    }
  });

  it("skill registration failure is visible (no silent swallow) when ctx.skill.transform rejects", async () => {
    const mod = await import(`${pathToFileURL(PLUGIN).href}?skill-fail=${Date.now()}`);
    const { ctx } = makeFakeCtx({ directory: repoPath(".") });
    ctx.skill = {
      transform: async () => {
        throw new Error("transform registration failed");
      },
    };
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => {
      errors.push(args.map(String).join(" "));
    };
    let dispose;
    try {
      dispose = await mod.default.setup(ctx);
      // registerSkills() is fire-and-forget inside start(); poll (bounded) so
      // additional async I/O cannot race a single macrotask wait (S2, PR #2768).
      const seen = await waitFor(() =>
        errors.some((line) => line.includes("skill registration failed"))
      );
      assert.ok(
        seen,
        `expected a visible console.error on transform failure, got: ${JSON.stringify(errors)}`
      );
    } finally {
      console.error = originalError;
      if (dispose) await dispose();
    }
  });

  it("skill.transform skips (not fails) when the catalog manifest is absent (consumer not synced)", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "opencode-skill-nosync-"));
    try {
      const mod = await import(`${pathToFileURL(PLUGIN).href}?skill-nosync=${Date.now()}`);
      const { ctx, registrations } = makeFakeCtx({ directory: tmp });
      const dispose = await mod.default.setup(ctx);
      try {
        assert.equal(typeof registrations.skillTransform, "function");
        const added = [];
        await assert.doesNotReject(
          async () =>
            registrations.skillTransform({
              add: (entry) => {
                added.push(entry);
              },
            }),
          "no manifest.json → no editor.add calls, not a rejected transform"
        );
        assert.equal(added.length, 0, "no manifest.json → no editor.add calls");
      } finally {
        await dispose();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skill.transform skips (not fails) when the catalog manifest is malformed JSON (D11: parse failure returns, no throw)", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "opencode-skill-badmanifest-"));
    try {
      mkdirSync(path.join(tmp, ".devpro", "agent-skills"), { recursive: true });
      writeFileSync(
        path.join(tmp, ".devpro", "agent-skills", "manifest.json"),
        "{ not valid json",
        "utf8"
      );
      const mod = await import(`${pathToFileURL(PLUGIN).href}?skill-badmanifest=${Date.now()}`);
      const { ctx, registrations } = makeFakeCtx({ directory: tmp });
      const dispose = await mod.default.setup(ctx);
      try {
        assert.equal(typeof registrations.skillTransform, "function");
        const added = [];
        await assert.doesNotReject(
          async () =>
            registrations.skillTransform({
              add: (entry) => {
                added.push(entry);
              },
            }),
          "an unparseable manifest.json must return, not throw (D11)"
        );
        assert.equal(added.length, 0, "malformed manifest.json → no editor.add calls");
      } finally {
        await dispose();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("waitFor helper: resolves on flip and times out deterministically", async () => {
    let calls = 0;
    const flipped = await waitFor(() => ++calls >= 3, { timeoutMs: 500, stepMs: 1 });
    assert.equal(flipped, true);
    const timedOut = await waitFor(() => false, { timeoutMs: 20, stepMs: 1 });
    assert.equal(timedOut, false);
  });

  it("skill-registration contract: bounded plugin source lock (path property, no location key)", () => {
    const source = readFileSync(PLUGIN, "utf8");
    const startMarker = "async function registerSkills()";
    assert.equal(source.split(startMarker).length - 1, 1, "registerSkills section must be unique");
    const start = source.indexOf(startMarker);
    const end = source.indexOf("\n  // ──", start);
    assert.ok(end > start, "registerSkills section terminator missing");
    const section = source.slice(start, end);
    let code;
    try {
      code = stripJsCommentSpans(section);
    } catch (err) {
      throw new Error(`comment scan failed for registerSkills section: ${err.message}`);
    }
    assert.match(
      code,
      /(?<![\w.$-])path\s*:\s*skillPath(?![\w$])/u,
      "registerSkills must declare path: skillPath"
    );
    assert.equal(
      LOCATION_KEY_RE.test(code) || LOCATION_SHORTHAND_RE.test(code),
      false,
      "registerSkills must not declare a location payload key"
    );
  });

  it("skill-registration contract: repo-wide editor.add payloads carry no location key", () => {
    const tracked = git(REPO_ROOT, "ls-files", "-z").split("\0").filter(Boolean);
    // Named, frozen exclusion set (not a growing denylist): change artifacts
    // (incl. this change's own prose + archived frozen trees) and this file's
    // fixtures. The set is asserted below so it cannot silently grow.
    const SCAN_EXCLUSION = Object.freeze([
      "openspec/changes/",
      ".devpro/scripts/tests/opencode-skill-discovery.test.mjs",
    ]);
    // Filter-side shrinkage tripwires (F-sdfb-r1-02 / #2778 S1): the equality
    // below proves "no silent skip past the filters"; the .md/.mjs sentinels
    // keep a whole carrier class from vanishing, the frozen exclusion-set
    // assertion stops exclusion widening, and this self-scaling floor (50% of
    // the post-exclusion, pre-extension population) trips a catastrophic
    // extension-filter narrowing while tolerating legitimate repo shrinkage.
    // The floor is asserted BEFORE the class sentinels so a class-loss mutation
    // resolves the relative-floor branch (F-srg-r1-03); the sentinels still
    // cover class loss that keeps the total above the floor.
    const CARRIER_EXT_RE = /\.(?:js|mjs|cjs|ts|md)$/u;
    const inScope = tracked.filter(
      (rel) => !SCAN_EXCLUSION.some((entry) => rel === entry || rel.startsWith(entry))
    );
    const eligible = inScope.filter((rel) => CARRIER_EXT_RE.test(rel));
    const relativeFloor = Math.floor(inScope.length * 0.5);
    assert.ok(
      eligible.length >= relativeFloor,
      `eligible corpus unexpectedly small: ${eligible.length} < ${relativeFloor} (50% of ${inScope.length} in-scope carriers)`
    );
    assert.ok(eligible.some((rel) => rel.endsWith(".md")), "eligible corpus must include .md carriers");
    assert.ok(eligible.some((rel) => rel.endsWith(".mjs")), "eligible corpus must include .mjs carriers");
    const scanned = [];
    const hits = [];
    for (const rel of eligible) {
      let text;
      try {
        text = readFileSync(repoPath(rel), "utf8");
      } catch (err) {
        hits.push(`${rel}: unreadable text carrier (${err.message})`);
        continue;
      }
      scanned.push(rel);
      const result = findLocationResidue(text);
      if (!result.ok) hits.push(`${rel}: ${result.reason}`);
      else if (result.hits.length > 0) hits.push(`${rel}: ${result.hits.join(", ")}`);
    }
    assert.ok(
      scanned.includes(".opencode/plugins/devpro-hooks.js"),
      "plugin carrier must be inside the scan corpus"
    );
    const pluginBlocks = findEditorAddBlocks(readFileSync(PLUGIN, "utf8"));
    assert.equal(pluginBlocks.ok, true, "plugin source must stay lexically scannable");
    assert.ok(
      pluginBlocks.blocks.length >= 1,
      "plugin must yield at least one editor.add( payload block; a renamed call site must not silently degrade the scan to a no-op"
    );
    assert.deepEqual(
      scanned,
      eligible,
      "scan must cover every eligible tracked carrier (silent skips are fail-closed)"
    );
    assert.deepEqual(
      hits,
      [],
      `editor.add payload location residue (scanned ${scanned.length} files):\n${hits.join("\n")}`
    );
    assert.deepEqual(
      [...SCAN_EXCLUSION].sort(),
      [".devpro/scripts/tests/opencode-skill-discovery.test.mjs", "openspec/changes/"].sort(),
      "scan exclusion set is frozen; changing it requires explicit review"
    );
  });

  it("skill-registration contract: detector fixtures (positive/negative/fail-closed)", () => {
    const open = ["editor", ".add("].join("");
    const key = ["location", ":"].join("");
    const shorthand = ["location", ""].join("");
    // positives: property key and shorthand inside a payload block
    assert.equal(findLocationResidue(`${open}{ id, ${key} skillPath, content });`).hits.length, 1);
    assert.equal(findLocationResidue(`${open}{ id, ${shorthand}, content });`).hits.length, 1);
    // positives: lexical extraction must not truncate on comment/string `});`
    assert.equal(
      findLocationResidue(`${open}{ id, // note });\n${key} skillPath, content });`).hits.length,
      1
    );
    assert.equal(
      findLocationResidue(`${open}{ id, content: "});", ${key} skillPath });`).hits.length,
      1
    );
    // negatives: member access / object literal outside blocks are not scanned
    assert.deepEqual(
      findLocationResidue("ctx.location.directory; const x = { location: { directory } };").hits,
      []
    );
    assert.deepEqual(findLocationResidue(`${open}{ id, path: skillPath, content });`).hits, []);
    // negative: in-block token boundary (`.location` member access must not flag;
    // widening the lookbehind reds here)
    assert.deepEqual(
      findLocationResidue(`${open}{ id, path: ctx.location.directory, content });`).hits,
      []
    );
    // negative: comment-only occurrence inside a block
    assert.deepEqual(findLocationResidue(`${open}{ id, // ${key} legacy\n content });`).hits, []);
    // negative: key literal inside a string value is not a payload key
    assert.deepEqual(
      findLocationResidue(`${open}{ id, path: "${key} literal", content });`).hits,
      []
    );
    // fail closed: unterminated block
    assert.equal(findLocationResidue(`${open}{ id,`).ok, false);
    // fail closed: string left open inside a block
    assert.equal(findLocationResidue(`${open}{ id, content: "unterminated })`).ok, false);
  });
});
