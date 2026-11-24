#!/usr/bin/env node
/**
 * normalize-eof.mjs
 *
 * Remediation fixer for blank-line-at-EOF in promoted capability specs.
 *
 * Root cause this fixes: `openspec archive` promotes a change's spec delta into
 * `openspec/specs/<cap>/spec.md` without normalizing trailing newlines.  The
 * resulting spec can carry blank lines at EOF (LF `\n\n`, CRLF `\r\n\r\n`, or
 * whitespace-only trailing lines `\n \n`/`\n\t\n`).  The structural guard
 * `spec-eof-newline-grep.test.mjs` detects these; this script fixes them.
 *
 * EOF "dirty" shape definition — SSOT-locked to spec-eof-newline-grep.test.mjs:
 *   dirty if ANY of:
 *     (a) content.length === 0              — empty file
 *     (b) !content.endsWith("\n")           — missing final newline
 *     (c) lastLine (after stripping single trailing \r?\n$) is blank/whitespace — blank at EOF
 *   See isDirtyPerGuard() below; it is byte-for-byte equivalent to the guard assertions.
 *
 * Key correctness guarantee: isDirtyPerGuard() is used as the gatekeeper in
 * normalizeEofContent() — a file that is already clean per the guard (including
 * files with CRLF line endings whose final line is content) is returned unchanged.
 * Only guard-dirty files are normalized.  This prevents `\s*$` from silently
 * stripping `\r` from a guard-clean CRLF file.
 *
 * Usage:
 *   node normalize-eof.mjs [--fix|--check] [path...]
 *
 *   --fix   (default, applied when no flag or --fix is given)
 *           Normalize each target file in-place.  Prints "fixed: <path>" for
 *           every file that was actually changed.  Clean files are skipped
 *           silently.  Exits 0 always.  Idempotent.
 *
 *   --check Read-only mode.  Prints offender paths to stderr; exits 1 if any
 *           dirty file found, 0 if all clean.  Never writes.
 *
 *   path    Explicit file path(s).  When omitted, defaults to all
 *           openspec/specs/<cap>/spec.md files (same collection as the grep guard).
 *
 * Normalize logic (--fix, only applied when isDirtyPerGuard is true):
 *   content.replace(/\s*$/, "") + "\n"
 *   Strips ALL trailing whitespace characters (space, tab, \r, \n) then appends
 *   a single LF.  This collapses any combination of blank/whitespace trailing
 *   lines into a single clean "\n".  Middle-of-file whitespace is untouched
 *   because \s*$ is anchored to the very end of the string (JS RegExp \s*$ with
 *   no /m flag consumes only trailing characters after the last non-whitespace).
 *
 * Repo uses LF; normalize target is a single LF `\n`.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const repoRoot = path.resolve(scriptDir, "../..");
const specsDir = path.join(repoRoot, "openspec", "specs");

// ---------------------------------------------------------------------------
// isDirtyPerGuard — byte-for-byte re-implementation of the grep guard logic.
// SSOT-locked to spec-eof-newline-grep.test.mjs (see L60-87 of that file).
//
// Returns true (dirty) if the content would fail the structural guard:
//   (a) Empty file (guard: assert.ok(content.length > 0) → fail).
//   (b) Does not end with "\n" (POSIX trailing newline requirement).
//   (c) After stripping the single trailing \r?\n$, the remaining last line
//       is blank or whitespace-only — blank-at-EOF in any LF/CRLF/ws form.
//
// Returns false (clean) if all three conditions pass — content will NOT be
// modified by normalizeEofContent().
// ---------------------------------------------------------------------------
export function isDirtyPerGuard(content) {
  // (a) empty file
  if (content.length === 0) return true;
  // (b) missing final newline
  if (!content.endsWith("\n")) return true;
  // (c) blank/whitespace-only last line (mirrors guard L77-82)
  const withoutFinalNewline = content.replace(/\r?\n$/, "");
  const lastLine = withoutFinalNewline.slice(
    withoutFinalNewline.lastIndexOf("\n") + 1,
  );
  return !(lastLine.trim() !== "" || withoutFinalNewline === "");
}

// ---------------------------------------------------------------------------
// normalizeEofContent — pure function, exported for unit testing.
// Input:  raw file content string.
// Output: normalized content string (single trailing LF, no blank at EOF).
//
// Guard-clean files are returned unchanged (identity) — no byte is touched,
// including files with CRLF line endings whose last content line is non-blank.
// Guard-dirty files are normalized: strip all trailing whitespace then add "\n".
// Idempotent: calling twice on the same content yields the same result.
// ---------------------------------------------------------------------------
export function normalizeEofContent(content) {
  if (!isDirtyPerGuard(content)) return content;
  return content.replace(/\s*$/, "") + "\n";
}

// ---------------------------------------------------------------------------
// Collect default target paths (mirrors spec-eof-newline-grep.test.mjs).
// ---------------------------------------------------------------------------
function collectSpecFiles() {
  const out = [];
  try {
    for (const cap of readdirSync(specsDir)) {
      const specPath = path.join(specsDir, cap, "spec.md");
      try {
        if (statSync(specPath).isFile()) out.push(specPath);
      } catch {
        // capability dir without spec.md — skip
      }
    }
  } catch {
    // openspec/specs not found — return empty
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI entry point — only runs when invoked directly.
// ---------------------------------------------------------------------------
const isCLI = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isCLI) {
  const args = process.argv.slice(2);

  let mode = "fix"; // default
  const paths = [];

  for (const arg of args) {
    if (arg === "--fix") {
      mode = "fix";
    } else if (arg === "--check") {
      mode = "check";
    } else {
      paths.push(arg);
    }
  }

  const targets = paths.length > 0 ? paths : collectSpecFiles();

  if (targets.length === 0) {
    process.stderr.write(
      "normalize-eof: no target files found (openspec/specs/ may be empty or missing)\n",
    );
    process.exit(0);
  }

  let hasOffenders = false;

  for (const filePath of targets) {
    let content;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (err) {
      process.stderr.write(`normalize-eof: cannot read ${filePath}: ${err.message}\n`);
      continue;
    }

    const dirty = isDirtyPerGuard(content);

    if (mode === "check") {
      if (dirty) {
        hasOffenders = true;
        process.stderr.write(`${filePath}\n`);
      }
    } else {
      // fix mode
      if (dirty) {
        const normalized = normalizeEofContent(content);
        writeFileSync(filePath, normalized, { encoding: "utf8" });
        process.stdout.write(`fixed: ${filePath}\n`);
      }
      // clean files: silent no-op
    }
  }

  if (mode === "check" && hasOffenders) {
    process.exit(1);
  }

  process.exit(0);
}
