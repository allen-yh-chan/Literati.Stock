#!/usr/bin/env node

import { accessSync, constants } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDirectCliInvocation } from "./lib/cli-entry.mjs";
import { askYesNo, createPromptSession } from "./lib/prompt-session.mjs";

const CLAUDE_AUTO_COMPACT_WINDOW = 500000;
const CLAUDE_AUTO_COMPACT_PERCENT = 80;
const CLAUDE_AUTO_COMPACT_TARGET_TOKENS = 400000;
const CODEX_AUTO_COMPACT_LIMIT = 400000;

function commandExists(commandName) {
  const pathValue = process.env.PATH || "";
  const pathEntries = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];

  for (const entry of pathEntries) {
    for (const ext of extensions) {
      try {
        accessSync(path.join(entry, commandName + ext), constants.X_OK);
        return true;
      } catch {
        // Try the next PATH entry / extension.
      }
    }
  }
  return false;
}

function shellBasename(shellPath) {
  return (shellPath || "").split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/i, "");
}

function claudeAutoCompactTargets(homeDir, env = process.env, platform = process.platform) {
  const shellName = shellBasename(env.SHELL);
  if (shellName === "bash") {
    return [{ path: path.join(homeDir, ".bashrc"), syntax: "posix", label: "~/.bashrc" }];
  }
  if (shellName === "zsh") {
    return [{ path: path.join(homeDir, ".zshrc"), syntax: "posix", label: "~/.zshrc" }];
  }
  if (platform === "win32") {
    return [
      {
        path: path.join(homeDir, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
        syntax: "powershell",
        label: "~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1",
      },
      {
        path: path.join(homeDir, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
        syntax: "powershell",
        label: "~/Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1",
      },
    ];
  }
  return [];
}

function parseShellEnvNumber(content, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=\\s*["']?(\\d+)["']?\\s*$`, "m"));
  return match ? Number(match[1]) : null;
}

function parsePowerShellEnvNumber(content, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`^\\s*\\$env:${escaped}\\s*=\\s*["']?(\\d+)["']?\\s*$`, "mi"));
  return match ? Number(match[1]) : null;
}

function findFirstTomlTableIndex(content) {
  const tableMatch = content.match(/^\s*\[.*\]\s*(?:#.*)?$/m);
  return tableMatch ? tableMatch.index : content.length;
}

function parseTopLevelTomlNumber(content, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rootSection = content.slice(0, findFirstTomlTableIndex(content));
  const match = rootSection.match(new RegExp(`^\\s*${escaped}\\s*=\\s*(\\d+)\\s*(?:#.*)?$`, "m"));
  return match ? Number(match[1]) : null;
}

function claudeSettingSuitable(content, syntax) {
  const parseNumber = syntax === "powershell" ? parsePowerShellEnvNumber : parseShellEnvNumber;
  const windowValue = parseNumber(content, "CLAUDE_CODE_AUTO_COMPACT_WINDOW");
  const percentValue = parseNumber(content, "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE");
  return windowValue === CLAUDE_AUTO_COMPACT_WINDOW && percentValue === CLAUDE_AUTO_COMPACT_PERCENT;
}

function codexSettingSuitable(content) {
  const limit = parseTopLevelTomlNumber(content, "model_auto_compact_token_limit");
  return limit === CODEX_AUTO_COMPACT_LIMIT;
}

function upsertShellExport(content, name, value) {
  const line = `export ${name}=${value}`;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=.*$`, "m");
  if (re.test(content)) {
    return content.replace(re, line);
  }
  const prefix = content && !content.endsWith("\n") ? content + "\n" : content;
  return `${prefix}${line}\n`;
}

function upsertPowerShellEnv(content, name, value) {
  const line = `$env:${name} = "${value}"`;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*\\$env:${escaped}\\s*=.*$`, "mi");
  if (re.test(content)) {
    return content.replace(re, line);
  }
  const prefix = content && !content.endsWith("\n") ? content + "\n" : content;
  return `${prefix}${line}\n`;
}

function formatTokenCount(value) {
  return value === null ? "missing" : String(value);
}

function claudeComparisonFields(content, syntax) {
  const parseNumber = syntax === "powershell" ? parsePowerShellEnvNumber : parseShellEnvNumber;
  const windowValue = parseNumber(content, "CLAUDE_CODE_AUTO_COMPACT_WINDOW");
  const percentValue = parseNumber(content, "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE");
  const effective = windowValue !== null && percentValue !== null
    ? Math.trunc((windowValue * percentValue) / 100)
    : null;
  return { windowValue, percentValue, effective };
}

function logClaudeAutoCompactComparison(states) {
  for (const state of states) {
    const current = claudeComparisonFields(state.current, state.syntax);
    console.log("Claude auto-compact comparison:");
    console.log(`  WINDOW current=${formatTokenCount(current.windowValue)} recommended=${CLAUDE_AUTO_COMPACT_WINDOW}`);
    console.log(`  PCT current=${formatTokenCount(current.percentValue)} recommended=${CLAUDE_AUTO_COMPACT_PERCENT}`);
    console.log(`  effective current=${formatTokenCount(current.effective)} recommended=${CLAUDE_AUTO_COMPACT_TARGET_TOKENS}`);
  }
}

function logClaudeUnreadableComparison() {
  console.log("Claude auto-compact comparison:");
  console.log(`  WINDOW current=unreadable recommended=${CLAUDE_AUTO_COMPACT_WINDOW}`);
  console.log(`  PCT current=unreadable recommended=${CLAUDE_AUTO_COMPACT_PERCENT}`);
  console.log(`  effective current=unreadable recommended=${CLAUDE_AUTO_COMPACT_TARGET_TOKENS}`);
}

function logClaudeRiskComparison({ readableStates = [], unreadableCount = 0, unsupported = false } = {}) {
  if (unsupported || readableStates.length === 0) {
    logClaudeUnreadableComparison();
    return;
  }
  logClaudeAutoCompactComparison(readableStates);
  if (unreadableCount > 0) {
    logClaudeUnreadableComparison();
  }
}

function logCodexAutoCompactComparison(content) {
  const limit = parseTopLevelTomlNumber(content, "model_auto_compact_token_limit");
  console.log("Codex auto-compact comparison:");
  console.log(`  model_auto_compact_token_limit current=${formatTokenCount(limit)} recommended=${CODEX_AUTO_COMPACT_LIMIT}`);
}

function logCodexUnreadableComparison() {
  console.log("Codex auto-compact comparison:");
  console.log(`  model_auto_compact_token_limit current=unreadable recommended=${CODEX_AUTO_COMPACT_LIMIT}`);
}

function upsertClaudeAutoCompactSetting(content, syntax) {
  if (syntax === "powershell") {
    let updated = upsertPowerShellEnv(content, "CLAUDE_CODE_AUTO_COMPACT_WINDOW", CLAUDE_AUTO_COMPACT_WINDOW);
    updated = upsertPowerShellEnv(updated, "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", CLAUDE_AUTO_COMPACT_PERCENT);
    return updated;
  }
  let updated = upsertShellExport(content, "CLAUDE_CODE_AUTO_COMPACT_WINDOW", CLAUDE_AUTO_COMPACT_WINDOW);
  updated = upsertShellExport(updated, "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", CLAUDE_AUTO_COMPACT_PERCENT);
  return updated;
}

function upsertTopLevelTomlNumber(content, key, value) {
  const line = `${key} = ${value}`;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tableIndex = findFirstTomlTableIndex(content);
  const rootSection = content.slice(0, tableIndex);
  const rest = content.slice(tableIndex);
  const re = new RegExp(`^\\s*${escaped}\\s*=.*$`, "m");
  if (re.test(rootSection)) {
    return rootSection.replace(re, line) + rest;
  }
  if (rest) {
    const prefix = rootSection && !rootSection.endsWith("\n") ? rootSection + "\n" : rootSection;
    const separator = prefix && !prefix.endsWith("\n\n") ? "\n" : "";
    return `${prefix}${line}\n${separator}${rest}`;
  }
  const prefix = content && !content.endsWith("\n") ? content + "\n" : content;
  return `${prefix}${line}\n`;
}

async function readPersonalConfig(filePath) {
  try {
    return { ok: true, content: await fs.readFile(filePath, "utf8") };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: true, content: "" };
    }
    return { ok: false, error };
  }
}

async function maybeRepairClaudeAutoCompact(promptSession, homeDir, options = {}) {
  if (!commandExists("claude")) {
    console.log("Claude Code runtime N/A (claude command not found); skipped auto-compact settings check.");
    return { check: "claude-auto-compact", execution: "skipped", outcome: "not-applicable", detail: "claude command not found" };
  }

  const targets = claudeAutoCompactTargets(homeDir, options.env, options.platform);
  if (targets.length === 0) {
    console.log("Skipped Claude Code auto-compact settings update (unsupported shell; supported: bash, zsh, Windows PowerShell).");
    logClaudeRiskComparison({ unsupported: true });
    return { check: "claude-auto-compact", execution: "skipped", outcome: "risk", detail: "unsupported shell" };
  }

  const states = [];
  let readFailureCount = 0;
  for (const target of targets) {
    const readResult = await readPersonalConfig(target.path);
    if (!readResult.ok) {
      readFailureCount += 1;
      console.log(`Skipped Claude Code auto-compact settings update for ${target.label} (cannot safely read file).`);
      continue;
    }
    states.push({
      ...target,
      current: readResult.content,
      suitable: claudeSettingSuitable(readResult.content, target.syntax),
    });
  }
  if (states.length === 0) {
    logClaudeRiskComparison({ unreadableCount: readFailureCount });
    return { check: "claude-auto-compact", execution: "skipped", outcome: "risk", detail: "personal config could not be read" };
  }
  const repairTargets = states.filter((state) => !state.suitable);
  if (repairTargets.length === 0) {
    console.log("Claude Code auto-compact settings already suitable.");
    if (readFailureCount > 0) {
      logClaudeRiskComparison({ readableStates: states, unreadableCount: readFailureCount });
      return {
        check: "claude-auto-compact",
        execution: "checked",
        outcome: "risk",
        detail: "readable runtime settings are suitable; one or more personal config states remain unknown",
      };
    }
    return { check: "claude-auto-compact", execution: "checked", outcome: "compliant", detail: "installed runtime settings are suitable" };
  }

  console.log("Claude Code auto-compact setting is missing or above or below the recommended target.");
  logClaudeRiskComparison({ readableStates: repairTargets, unreadableCount: readFailureCount });
  if (!promptSession) {
    console.log("Skipped Claude Code auto-compact settings update (non-interactive stdin).");
    console.log("To apply, run this check in a real TTY via devpro:change startup.");
    const unknownDetail = readFailureCount > 0 ? "; one or more personal config states remain unknown" : "";
    return { check: "claude-auto-compact", execution: "skipped", outcome: "risk", detail: `settings need repair; stdin is non-interactive${unknownDetail}` };
  }

  const shouldApply = await askYesNo(
    promptSession,
    `Apply recommended Claude Code settings to ${repairTargets.map((target) => target.label).join(", ")} ` +
      `(CLAUDE_CODE_AUTO_COMPACT_WINDOW=${CLAUDE_AUTO_COMPACT_WINDOW}, ` +
      `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${CLAUDE_AUTO_COMPACT_PERCENT})?`
  );
  if (!shouldApply) {
    console.log("Skipped Claude Code auto-compact settings update.");
    const unknownDetail = readFailureCount > 0 ? "; one or more personal config states remain unknown" : "";
    return { check: "claude-auto-compact", execution: "checked", outcome: "risk", detail: `settings need repair; user declined${unknownDetail}` };
  }

  for (const target of repairTargets) {
    const updated = upsertClaudeAutoCompactSetting(target.current, target.syntax);
    await fs.mkdir(path.dirname(target.path), { recursive: true });
    await fs.writeFile(target.path, updated);
    console.log(`Updated Claude Code auto-compact settings in ${target.label}`);
  }
  if (readFailureCount > 0) {
    return {
      check: "claude-auto-compact",
      execution: "checked",
      outcome: "risk",
      detail: "readable runtime settings updated; one or more personal config states remain unknown",
    };
  }
  return { check: "claude-auto-compact", execution: "checked", outcome: "repaired", detail: "installed runtime settings updated" };
}

async function maybeRepairCodexAutoCompact(promptSession, homeDir) {
  if (!commandExists("codex")) {
    console.log("Codex runtime N/A (codex command not found); skipped auto-compact settings check.");
    return { check: "codex-auto-compact", execution: "skipped", outcome: "not-applicable", detail: "codex command not found" };
  }

  const configPath = path.join(homeDir, ".codex", "config.toml");
  const readResult = await readPersonalConfig(configPath);
  if (!readResult.ok) {
    console.log("Skipped Codex auto-compact settings update (cannot safely read ~/.codex/config.toml).");
    logCodexUnreadableComparison();
    return { check: "codex-auto-compact", execution: "skipped", outcome: "risk", detail: "personal config could not be read" };
  }
  const current = readResult.content;
  if (codexSettingSuitable(current)) {
    console.log("Codex auto-compact settings already suitable.");
    return { check: "codex-auto-compact", execution: "checked", outcome: "compliant", detail: "installed runtime settings are suitable" };
  }

  console.log("Codex auto-compact setting is missing or above or below the recommended target.");
  logCodexAutoCompactComparison(current);
  if (!promptSession) {
    console.log("Skipped Codex auto-compact settings update (non-interactive stdin).");
    console.log("To apply, run this check in a real TTY via devpro:change startup.");
    return { check: "codex-auto-compact", execution: "skipped", outcome: "risk", detail: "settings need repair; stdin is non-interactive" };
  }

  const shouldApply = await askYesNo(
    promptSession,
    `Apply recommended Codex setting to ~/.codex/config.toml ` +
      `(model_auto_compact_token_limit = ${CODEX_AUTO_COMPACT_LIMIT})?`
  );
  if (!shouldApply) {
    console.log("Skipped Codex auto-compact settings update.");
    return { check: "codex-auto-compact", execution: "checked", outcome: "risk", detail: "settings need repair; user declined" };
  }

  const updated = upsertTopLevelTomlNumber(current, "model_auto_compact_token_limit", CODEX_AUTO_COMPACT_LIMIT);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, updated);
  console.log("Updated Codex auto-compact settings in ~/.codex/config.toml");
  return { check: "codex-auto-compact", execution: "checked", outcome: "repaired", detail: "installed runtime settings updated" };
}

async function runRuntimeAutoCompactRepair(label, repair) {
  try {
    return await repair();
  } catch (error) {
    console.warn(`Skipped ${label} auto-compact settings update: ${error.message}`);
    return {
      check: `${label.toLowerCase().replaceAll(" ", "-")}-auto-compact`,
      execution: "skipped",
      outcome: "risk",
      detail: "runtime settings check failed",
    };
  }
}

async function runAutoCompactDiagnostics(promptSession, homeDir) {
  const results = [];
  results.push(await runRuntimeAutoCompactRepair("Claude Code", () =>
    maybeRepairClaudeAutoCompact(promptSession, homeDir)
  ));
  results.push(await runRuntimeAutoCompactRepair("Codex", () =>
    maybeRepairCodexAutoCompact(promptSession, homeDir)
  ));
  return results;
}

async function repairRuntimeAutoCompactSettings() {
  const homeDir = os.homedir();
  const promptSession = await createPromptSession();
  try {
    return await runAutoCompactDiagnostics(promptSession, homeDir);
  } finally {
    promptSession?.close();
  }
}

if (isDirectCliInvocation(import.meta.url)) {
  repairRuntimeAutoCompactSettings().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export {
  claudeAutoCompactTargets,
  maybeRepairClaudeAutoCompact,
  maybeRepairCodexAutoCompact,
  repairRuntimeAutoCompactSettings,
  runAutoCompactDiagnostics,
};
