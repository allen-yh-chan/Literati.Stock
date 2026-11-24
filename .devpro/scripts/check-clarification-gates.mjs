#!/usr/bin/env node
/**
 * check-clarification-gates.mjs
 *
 * Runtime gate for pre-analyst dispatch and Seams-first proposal expansion.
 * Reads active (or archived) change meeting-notes.md and applies
 * clarification-contract.mjs validators.
 *
 * Usage:
 *   node .devpro/scripts/check-clarification-gates.mjs pre-analyst <change-name>
 *   node .devpro/scripts/check-clarification-gates.mjs seams-expansion <change-name>
 *
 * Exit 0 = allowed; non-zero = blocked (stdout/stderr explain).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  analystDispatchGate,
  extractSection,
  parseBulletFields,
  seamsExpansionAllowed,
  validateMeetingNotesClarificationContracts,
} from "./lib/clarification-contract.mjs";
import { findOpenspecRepoRoot } from "./lib/find-root.mjs";

const modulePath = fileURLToPath(import.meta.url);

function usage() {
  return [
    "Usage:",
    "  node .devpro/scripts/check-clarification-gates.mjs pre-analyst <change-name>",
    "  node .devpro/scripts/check-clarification-gates.mjs seams-expansion <change-name>",
  ].join("\n");
}

/** Bare/exact change folder token: no separators, no traversal, no absolute. */
const SAFE_CHANGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/** Dated archive folder: YYYY-MM-DD-<bare-name> */
const DATED_ARCHIVE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})-(.+)$/;

function invalidChangeNameError(changeName) {
  return {
    path: null,
    error: `invalid change name '${String(changeName ?? "")}': must be a single path segment (no separators/traversal)`,
  };
}

function isSafeChangeName(changeName) {
  return (
    typeof changeName === "string" &&
    SAFE_CHANGE_NAME_RE.test(changeName) &&
    !changeName.includes("..")
  );
}

/**
 * Resolve path under openspec/changes; reject escape outside that root.
 * @returns {string|null}
 */
function resolveUnderChanges(repoRoot, ...segments) {
  const changesRoot = path.resolve(repoRoot, "openspec", "changes");
  const full = path.resolve(changesRoot, ...segments);
  if (full !== changesRoot && !full.startsWith(changesRoot + path.sep)) {
    return null;
  }
  return full;
}

/**
 * Resolve meeting-notes for active change, exact archive folder, or unique
 * dated archive/<YYYY-MM-DD>-<bare-name>/. Ambiguous dated matches fail closed.
 * @returns {{ path: string|null, error: string|null }}
 */
function resolveMeetingNotes(repoRoot, changeName) {
  if (!isSafeChangeName(changeName)) return invalidChangeNameError(changeName);

  const active = resolveUnderChanges(
    repoRoot,
    changeName,
    "meeting-notes.md",
  );
  if (!active) return invalidChangeNameError(changeName);
  if (existsSync(active)) return { path: active, error: null };

  const archiveExact = resolveUnderChanges(
    repoRoot,
    "archive",
    changeName,
    "meeting-notes.md",
  );
  if (!archiveExact) return invalidChangeNameError(changeName);
  if (existsSync(archiveExact)) return { path: archiveExact, error: null };

  // Bare name → unique dated archive/<YYYY-MM-DD>-<bare-name>/ only
  const archiveRoot = resolveUnderChanges(repoRoot, "archive");
  if (archiveRoot && existsSync(archiveRoot)) {
    let entries = [];
    try {
      entries = readdirSync(archiveRoot, { withFileTypes: true });
    } catch {
      return {
        path: null,
        error: `unable to read archive directory for change '${changeName}'`,
      };
    }
    // Count ALL dated candidates before meeting-notes existence filter
    const candidates = entries.filter((e) => {
      if (!e.isDirectory()) return false;
      const m = DATED_ARCHIVE_PREFIX_RE.exec(e.name);
      return Boolean(m && m[2] === changeName);
    });
    if (candidates.length > 1) {
      return {
        path: null,
        error: `ambiguous dated-archive meeting-notes for '${changeName}' (${candidates.length} matches); pass exact archive folder name`,
      };
    }
    if (candidates.length === 1) {
      const notesPath = resolveUnderChanges(
        repoRoot,
        "archive",
        candidates[0].name,
        "meeting-notes.md",
      );
      if (!notesPath) return invalidChangeNameError(changeName);
      if (!existsSync(notesPath)) {
        return {
          path: null,
          error: `meeting-notes.md missing in dated archive '${candidates[0].name}' for change '${changeName}'`,
        };
      }
      return { path: notesPath, error: null };
    }
  }

  return {
    path: null,
    error: `meeting-notes.md not found for change '${changeName}' under openspec/changes/ (active or archive)`,
  };
}

function loadNotes(changeName) {
  const repoRoot = findOpenspecRepoRoot();
  const resolved = resolveMeetingNotes(repoRoot, changeName);
  if (!resolved.path) {
    return { ok: false, error: resolved.error };
  }
  return {
    ok: true,
    notesPath: resolved.path,
    body: readFileSync(resolved.path, "utf8"),
  };
}

function runPreAnalyst(changeName) {
  const loaded = loadNotes(changeName);
  if (!loaded.ok) {
    console.error(loaded.error);
    return 2;
  }
  const shape = validateMeetingNotesClarificationContracts(loaded.body);
  if (!shape.ok) {
    console.error(
      `check-clarification-gates pre-analyst: meeting-notes contract failed (${loaded.notesPath}):`,
    );
    for (const e of shape.errors) console.error(`  - ${e}`);
    return 1;
  }
  const clar = extractSection(loaded.body, "Clarification State");
  const parsed = parseBulletFields(clar);
  if (parsed.errors.length > 0) {
    console.error("check-clarification-gates pre-analyst: Clarification State parse failed:");
    for (const e of parsed.errors) console.error(`  - ${e}`);
    return 1;
  }
  const gate = analystDispatchGate(parsed.fields);
  if (!gate.allowed) {
    console.error(
      `check-clarification-gates pre-analyst: analystDispatchGate blocked: ${gate.reason}`,
    );
    return 1;
  }
  console.log(
    `check-clarification-gates pre-analyst: OK (${gate.reason}) — ${loaded.notesPath}`,
  );
  return 0;
}

function runSeamsExpansion(changeName) {
  const loaded = loadNotes(changeName);
  if (!loaded.ok) {
    console.error(loaded.error);
    return 2;
  }
  const seams = extractSection(loaded.body, "Seams Confirmation");
  if (!seams) {
    console.error(
      `check-clarification-gates seams-expansion: missing ## Seams Confirmation in ${loaded.notesPath}`,
    );
    return 1;
  }
  const parsed = parseBulletFields(seams);
  if (parsed.errors.length > 0) {
    console.error("check-clarification-gates seams-expansion: Seams Confirmation parse failed:");
    for (const e of parsed.errors) console.error(`  - ${e}`);
    return 1;
  }
  const gate = seamsExpansionAllowed(parsed.fields);
  if (!gate.allowed) {
    console.error(
      `check-clarification-gates seams-expansion: seamsExpansionAllowed blocked: ${gate.reason}`,
    );
    return 1;
  }
  console.log(
    `check-clarification-gates seams-expansion: OK (${gate.reason}) — ${loaded.notesPath}`,
  );
  return 0;
}

function main(argv = process.argv.slice(2)) {
  const [mode, changeName] = argv;
  if (!mode || !changeName || mode === "-h" || mode === "--help") {
    console.error(usage());
    return mode ? 2 : 2;
  }
  if (mode === "pre-analyst") return runPreAnalyst(changeName);
  if (mode === "seams-expansion") return runSeamsExpansion(changeName);
  console.error(`Unknown mode '${mode}'\n${usage()}`);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  process.exitCode = main();
}

export { main, runPreAnalyst, runSeamsExpansion, resolveMeetingNotes };
