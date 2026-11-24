#!/usr/bin/env node
/**
 * repair-named-hook-eol.mjs
 *
 * Consent-gated, named-file CRLF→LF repair for consumer shell hooks.
 * Buffer/byte rewrite only; preserves mode.
 * Multi-file: **all-input prevalidation** before any write; if a later write
 * fails, earlier successful writes are reported as partial writes (no rollback).
 * Rejects symlink／non-file／lone CR／paths outside cwd or git root.
 *
 * Usage:
 *   node .devpro/scripts/repair-named-hook-eol.mjs \
 *     --file <path> [--file <path>...] --i-consent-rewrite-named-files
 */

import {
  readFileSync,
  writeFileSync,
  lstatSync,
  chmodSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONSENT_FLAG = "--i-consent-rewrite-named-files";

/** Test-only seam: invoked after successful writeFileSync, before chmodSync. */
export const __testHooks = {
  afterWriteBeforeChmod: null,
};

/**
 * Replace every CRLF (`\r\n`) with LF (`\n`) at the byte level.
 * Does not strip lone `\r`.
 * @param {Buffer} buf
 * @returns {Buffer}
 */
export function replaceCrlfWithLf(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError("replaceCrlfWithLf expects a Buffer");
  }
  const parts = [];
  let start = 0;
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) {
      if (i > start) parts.push(buf.subarray(start, i));
      parts.push(Buffer.from([0x0a]));
      start = i + 2;
      i++;
    }
  }
  if (start === 0) return Buffer.from(buf);
  if (start < buf.length) parts.push(buf.subarray(start));
  return Buffer.concat(parts);
}

/**
 * @param {string} cwd
 * @returns {string[]} absolute realpath roots that may contain target files
 */
function resolveAllowedRoots(cwd) {
  const roots = new Set();
  let cwdReal;
  try {
    cwdReal = realpathSync(cwd);
    roots.add(cwdReal);
  } catch {
    throw new Error(`cwd is not resolvable: ${cwd}`);
  }
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (top) roots.add(realpathSync(top));
  } catch {
    // non-git cwd: only process.cwd()／provided cwd realpath is allowed
  }
  return [...roots];
}

/**
 * @param {string} absPath realpath of a regular file
 * @param {string[]} roots
 */
function isPathInsideRoots(absPath, roots) {
  const normalized = path.resolve(absPath);
  for (const root of roots) {
    const rel = path.relative(root, normalized);
    if (rel === "") continue;
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return true;
  }
  return false;
}

/**
 * Validate + plan transform for one path. No writes.
 * @returns {{ absPath: string, original: Buffer, next: Buffer, mode: number, changed: boolean }}
 */
function planOne(filePath, { cwd, roots }) {
  const abs = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(cwd, filePath);

  let st;
  try {
    st = lstatSync(abs);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : "";
    throw new Error(`not readable or missing: ${filePath}${code ? ` (${code})` : ""}`);
  }

  if (st.isSymbolicLink()) {
    throw new Error(`refusing symlink: ${filePath}`);
  }
  if (!st.isFile()) {
    throw new Error(`not a regular file: ${filePath}`);
  }

  let realFile;
  try {
    realFile = realpathSync(abs);
  } catch (err) {
    throw new Error(`cannot realpath: ${filePath}: ${err.message || err}`);
  }

  if (!isPathInsideRoots(realFile, roots)) {
    throw new Error(
      `path outside allowed roots (cwd／git root): ${filePath}`
    );
  }

  const original = readFileSync(realFile);
  const next = replaceCrlfWithLf(original);
  if (next.includes(0x0d)) {
    throw new Error(
      `lone CR (\\r) remains after CRLF→LF transform; refuse: ${filePath}`
    );
  }

  return {
    absPath: realFile,
    original,
    next,
    mode: st.mode,
    changed: !original.equals(next),
  };
}

/**
 * Consent-gated named-file CRLF→LF repair.
 *
 * @param {string[]} files
 * @param {{ consent?: boolean, cwd?: string }} [opts]
 * @returns {{
 *   ok: boolean,
 *   exitCode: number,
 *   written: string[],
 *   planned: string[],
 *   error?: string,
 * }}
 */
export function repairNamedHookEol(files, opts = {}) {
  const consent = opts.consent === true;
  const cwd = opts.cwd ?? process.cwd();
  const written = [];

  if (!consent) {
    return {
      ok: false,
      exitCode: 1,
      written,
      planned: [],
      error: `missing consent flag ${CONSENT_FLAG}; zero writes`,
    };
  }

  if (!Array.isArray(files) || files.length === 0) {
    return {
      ok: false,
      exitCode: 1,
      written,
      planned: [],
      error: "at least one --file <path> is required; zero writes",
    };
  }

  let roots;
  try {
    roots = resolveAllowedRoots(cwd);
  } catch (err) {
    return {
      ok: false,
      exitCode: 1,
      written,
      planned: [],
      error: err.message || String(err),
    };
  }

  /** @type {ReturnType<typeof planOne>[]} */
  let plans;
  try {
    plans = files.map((f) => planOne(f, { cwd, roots }));
  } catch (err) {
    return {
      ok: false,
      exitCode: 1,
      written,
      planned: [],
      error: err.message || String(err),
    };
  }

  for (const plan of plans) {
    if (!plan.changed) continue;
    try {
      writeFileSync(plan.absPath, plan.next);
      // Content is rewritten; record before chmod so chmod failure still reports the path.
      written.push(plan.absPath);
      if (typeof __testHooks.afterWriteBeforeChmod === "function") {
        __testHooks.afterWriteBeforeChmod(plan);
      }
      // Preserve full mode bits (incl. exec) after write／umask.
      chmodSync(plan.absPath, plan.mode & 0o7777);
    } catch (err) {
      return {
        ok: false,
        exitCode: 1,
        written,
        planned: plans.map((p) => p.absPath),
        error: `write failed for ${plan.absPath}: ${err.message || err}; modified-or-possibly-modified: ${plan.absPath}; already written: ${
          written.length ? written.join(", ") : "(none)"
        }`,
      };
    }
  }

  return {
    ok: true,
    exitCode: 0,
    written,
    planned: plans.map((p) => p.absPath),
  };
}

/**
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{ files: string[], consent: boolean }}
 */
export function parseRepairNamedHookEolArgs(argv) {
  const files = [];
  let consent = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--file") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--file requires a path argument");
      }
      files.push(next);
      i++;
    } else if (arg === CONSENT_FLAG) {
      consent = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { files, consent };
}

function printUsage(stream = process.stderr) {
  stream.write(
    [
      "Usage:",
      `  node .devpro/scripts/repair-named-hook-eol.mjs --file <path> [--file <path>...] ${CONSENT_FLAG}`,
      "",
      "Requires one or more --file paths and the consent flag.",
      "Rewrites CRLF to LF at the byte level; refuses lone CR; preserves mode.",
      "All-input prevalidation: validate every path before any write;",
      "mid-write I/O failure reports already-rewritten paths (no multi-file rollback).",
      "",
    ].join("\n")
  );
}

export function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseRepairNamedHookEolArgs(argv);
  } catch (err) {
    printUsage();
    process.stderr.write(`${err.message || err}\n`);
    return 1;
  }

  if (!parsed.consent || parsed.files.length === 0) {
    printUsage();
    process.stderr.write(
      !parsed.consent
        ? `missing ${CONSENT_FLAG}; zero writes\n`
        : "at least one --file <path> is required; zero writes\n"
    );
    return 1;
  }

  const result = repairNamedHookEol(parsed.files, {
    consent: true,
    cwd: process.cwd(),
  });

  if (!result.ok) {
    process.stderr.write(`${result.error}\n`);
    if (result.written.length) {
      process.stderr.write(
        `partial writes before failure: ${result.written.join(", ")}\n`
      );
    }
    return result.exitCode || 1;
  }

  for (const p of result.written) {
    process.stdout.write(`repaired: ${p}\n`);
  }
  return 0;
}

const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  process.exitCode = main();
}
