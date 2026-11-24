#!/usr/bin/env node
/**
 * Read-only declared-binding pre-resolution helper
 * (strengthen-admission-binding-portability design D4.3 / T-3-2).
 *
 * Usage:
 *   node .devpro/scripts/resolve-admission-binding.mjs <change_id> \
 *     [--cwd <dir>] [--binding-root <abs>] [--json]
 *
 * The TL runs this BEFORE a declared-path dispatch and copies the output into
 * the brief: `change_id` and `execution_root` are the conditional declared-path
 * admission fields, and `execution_root` is exactly the realpath the spawn gate
 * compares against (`--json` prints the stable object; the default prints the
 * same five values as `key: value` lines).
 *
 * Contract:
 * - read-only: it resolves through the one shared `resolveAdmissionBinding`
 *   (same-common-dir exact-one `.worktree/<change_id>` selection) and writes no
 *   state, no record, no claim, and touches no network;
 * - exit 0 on success; a closed code (`{ "ok": false, "code": "<token>" }` on
 *   stdout) with a non-zero exit for every fault — the resolver's own stable
 *   tokens (`change-id-invalid`, `change-worktree-required`,
 *   `change-worktree-ambiguous`, `intent-scan-failed`,
 *   `intent-candidate-limit-exceeded`, `git-head-unavailable`,
 *   `binding-head-detached`, `binding-branch-protected`,
 *   `change-binding-mismatch`) plus `usage-invalid` here;
 * - `--binding-root <abs>` is an optional pre-resolution pin: when the pin does
 *   not realpath-equal the resolved binding root the helper fails closed with
 *   `binding-root-mismatch` and never lets the pin override the filesystem
 *   result.
 *
 * This helper is a consumer of the resolver, never a second resolver: the
 * declaration it feeds is the explicit A2 `change_id`, so a session whose cwd
 * already resolves a different `.worktree/<id>` fails closed with
 * `change-binding-mismatch` here exactly as it would at dispatch time.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { resolveAdmissionBinding } from "./hooks/lib/admission-record.mjs";
import { CHANGE_ID_SHAPE } from "./lib/durable-fs.mjs";

const USAGE = "Usage: node .devpro/scripts/resolve-admission-binding.mjs <change_id> [--cwd <dir>] [--binding-root <abs>] [--json]";

function emitFailure(code) {
  process.stdout.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = { changeId: null, cwd: process.cwd(), bindingRoot: null, json: false };
  const rest = [...argv];
  const changeId = rest.shift();
  if (typeof changeId !== "string" || changeId.length === 0) return { ok: false };
  parsed.changeId = changeId;
  while (rest.length > 0) {
    const flag = rest.shift();
    if (flag === "--json") {
      parsed.json = true;
      continue;
    }
    if (flag === "--cwd" || flag === "--binding-root") {
      const value = rest.shift();
      if (typeof value !== "string" || value.length === 0) return { ok: false };
      if (flag === "--cwd") parsed.cwd = value;
      else parsed.bindingRoot = value;
      continue;
    }
    return { ok: false };
  }
  return { ok: true, ...parsed };
}

function currentBranch(repoRoot) {
  const result = spawnSync("git", ["-C", repoRoot, "symbolic-ref", "--short", "-q", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const branch = String(result.stdout ?? "").trim();
  return branch.length > 0 ? branch : null;
}

function canonicalOrNull(target) {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${USAGE}\n`);
    return emitFailure("usage-invalid");
  }
  if (!CHANGE_ID_SHAPE.test(parsed.changeId)) return emitFailure("change-id-invalid");
  const binding = resolveAdmissionBinding({
    cwd: path.resolve(parsed.cwd),
    fields: { change_id: parsed.changeId },
  });
  if (!binding.ok) return emitFailure(binding.code);
  const executionRoot = binding.repoRoot;
  if (parsed.bindingRoot !== null) {
    const pinned = canonicalOrNull(path.resolve(parsed.bindingRoot));
    const resolved = canonicalOrNull(executionRoot);
    if (pinned === null || resolved === null || pinned !== resolved) return emitFailure("binding-root-mismatch");
  }
  const payload = {
    repoRoot: executionRoot,
    changeId: binding.changeId,
    headSha: binding.headSha,
    branch: currentBranch(executionRoot),
    execution_root: executionRoot,
  };
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  process.stdout.write([
    `repoRoot: ${payload.repoRoot}`,
    `changeId: ${payload.changeId}`,
    `headSha: ${payload.headSha}`,
    `branch: ${payload.branch ?? ""}`,
    `execution_root: ${payload.execution_root}`,
  ].join("\n") + "\n");
}

main(process.argv.slice(2));
