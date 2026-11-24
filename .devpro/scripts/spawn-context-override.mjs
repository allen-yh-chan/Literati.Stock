#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { issueSpawnContextOverride } from "./hooks/lib/spawn-context-override.mjs";

export function parseSpawnContextOverrideArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--reason") return { ok: false };
  return { ok: true, reason: argv[1] };
}

export function runSpawnContextOverrideCli({ argv = process.argv.slice(2), cwd = process.cwd(), stateDir, nowMs } = {}) {
  const parsed = parseSpawnContextOverrideArgs(argv);
  if (!parsed.ok) return { exitCode: 2, message: "Usage: spawn-context-override.mjs --reason <single-line reason>" };
  const result = issueSpawnContextOverride({
    cwd,
    reason: parsed.reason,
    ...(stateDir ? { stateDir } : {}),
    ...(Number.isFinite(nowMs) ? { nowMs } : {}),
  });
  if (!result.ok) return { exitCode: 1, message: `spawn context override not issued: ${result.status}` };
  return { exitCode: 0, message: `spawn context override issued for cwd_key=${result.cwd_key_prefix}; expires_at=${result.expires_at}; next: retry the full-context spawn once` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runSpawnContextOverrideCli();
  (result.exitCode === 0 ? process.stdout : process.stderr).write(`${result.message}\n`);
  process.exitCode = result.exitCode;
}
