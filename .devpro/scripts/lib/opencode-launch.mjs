/**
 * opencode-launch.mjs
 *
 * File-system side of the OpenCode trusted launch profile. The pure derivation lives in
 * second-reviewer-cli-recipe-contract.mjs / lib/opencode-reviewer.mjs; this module only
 * writes the derived bytes and proves they were not changed on the way. The reviewer
 * process never reads a launch file that was not re-derived from the validated context
 * by the party that spawns it.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  OPENCODE_REVIEWER_CONTEXT_SCHEMA,
  assertOpenCodeReviewerContext,
  canonicalOpenCodeLaunchConfig,
  canonicalOpenCodeLaunchScope,
} from "../second-reviewer-cli-recipe-contract.mjs";
import {
  OPENCODE_TOOL_POLICIES,
  OpenCodeReviewerError,
  openCodeAgentNameForPolicy,
  openCodeSelectionFromRequested,
  parseOpenCodeVersion,
  serializeOpenCodeLaunchConfig,
  sha256OfBytes,
} from "./opencode-reviewer.mjs";
import { spawnSyncBounded } from "./reviewer-process-guard.mjs";

// The probe runs under a deadline the CLI cannot ignore (SIGKILL, own process group; see spawnSyncBounded).
// Raw `opencode --version` output. Callers feed it to buildOpenCodeReviewerSection, which
// is the only place that maps it to a generation; an absent or failing binary is the
// "unavailable" signal the CLI selection order keys on.
export function readOpenCodeCliVersion({ executable = "opencode", spawn = spawnSyncBounded, env = process.env, timeoutMs = 15000 } = {}) {
  const result = spawn(executable, ["--version"], { encoding: "utf8", timeout: timeoutMs, env });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    throw new OpenCodeReviewerError("opencode --version did not succeed", "opencode_cli_unavailable");
  }
  return result.stdout;
}

// Builds the sidecar `reviewer_opencode` section from values the renderer already holds.
// Every derived field (scope, launch digest) goes through the contract's own functions, so
// the section the runner later re-validates is the one the contract would produce itself.
export function buildOpenCodeReviewerSection(context, { cliVersionText, launchConfigPath, instructionFiles = [] }) {
  const version = parseOpenCodeVersion(cliVersionText);
  const requested = context?.reviewer_model_selection;
  const selection = openCodeSelectionFromRequested({ requested: requested?.requested, source: requested?.source, probe: requested?.probe });
  const toolPolicy = OPENCODE_TOOL_POLICIES[context?.mode];
  if (toolPolicy === undefined) {
    throw new OpenCodeReviewerError(
      `opencode reviewer does not support mode ${JSON.stringify(context?.mode)}`,
      "opencode_reviewer_invalid"
    );
  }
  const scope = canonicalOpenCodeLaunchScope(context);
  const section = {
    schema: OPENCODE_REVIEWER_CONTEXT_SCHEMA,
    cli_version: version.version,
    generation: version.generation,
    selection,
    tool_policy: toolPolicy,
    agent_name: openCodeAgentNameForPolicy(toolPolicy),
    launch_config_path: launchConfigPath,
    launch_config_sha256: "0".repeat(64),
    launch_scope: { instruction_files: instructionFiles, ...scope },
  };
  const config = canonicalOpenCodeLaunchConfig(
    { ...context, reviewer_opencode: section },
    scope,
    instructionFiles.map((entry) => entry.path)
  );
  section.launch_config_sha256 = sha256OfBytes(Buffer.from(serializeOpenCodeLaunchConfig(config), "utf8"));
  return section;
}

// Approved-revision instruction files (rules/skills the CLI loads itself) are recorded by
// digest at render time. A file that changed since is a different policy than the one the
// dispatch was approved with, so the launch stops instead of silently using it.
export function verifyOpenCodeInstructionFiles(context, { readFile = readFileSync } = {}) {
  const files = context?.reviewer_opencode?.launch_scope?.instruction_files ?? [];
  const verified = [];
  for (const entry of files) {
    let bytes;
    try {
      bytes = readFile(entry.path);
    } catch {
      throw new OpenCodeReviewerError(
        "an approved OpenCode instruction file is unreadable",
        "opencode_instruction_file_drift"
      );
    }
    const digest = sha256OfBytes(bytes);
    if (digest !== entry.sha256) {
      throw new OpenCodeReviewerError(
        "an approved OpenCode instruction file changed after the digest was recorded",
        "opencode_instruction_file_drift"
      );
    }
    verified.push({ path: entry.path, sha256: digest });
  }
  return verified;
}

// Re-derives the canonical launch config from the validated context, checks it against the
// digest the renderer recorded, writes it privately and reads it back. Returns the path the
// reviewer must be started with (via OPENCODE_CONFIG).
export function materializeOpenCodeLaunchConfig(context, options = {}) {
  const oc = assertOpenCodeReviewerContext(context, options);
  if (options.verifyInstructionFiles !== false) verifyOpenCodeInstructionFiles(context, options);
  const config = canonicalOpenCodeLaunchConfig(
    context,
    oc.launch_scope,
    oc.launch_scope.instruction_files.map((entry) => entry.path)
  );
  const bytes = Buffer.from(serializeOpenCodeLaunchConfig(config), "utf8");
  if (sha256OfBytes(bytes) !== oc.launch_config_sha256) {
    throw new OpenCodeReviewerError(
      "derived OpenCode launch config does not match the recorded digest",
      "opencode_launch_config_invalid"
    );
  }
  const target = oc.launch_config_path;
  const staging = `${target}.${process.pid}.tmp`;
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(staging, bytes, { mode: 0o600 });
  chmodSync(staging, 0o600);
  renameSync(staging, target);
  if (sha256OfBytes(readFileSync(target)) !== oc.launch_config_sha256) {
    throw new OpenCodeReviewerError(
      "OpenCode launch config read-back does not match the recorded digest",
      "opencode_launch_config_invalid"
    );
  }
  return { path: target, sha256: oc.launch_config_sha256 };
}
