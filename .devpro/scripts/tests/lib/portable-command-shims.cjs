"use strict";

// Windows cannot directly spawn extensionless POSIX test doubles. In tests
// that opt in by importing this file, redirect only matching fixture files in
// PATH to Node or Git Bash. Production child-process behavior is untouched.
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");

const enabledKey = "DEVPRO_TEST_PORTABLE_COMMAND_SHIMS";
const shellKey = "DEVPRO_TEST_PORTABLE_SHELL_EXE";
const patchedKey = Symbol.for("devpro.test.portable-command-shims.patched");

function getEnvValue(env, name) {
  const key = Object.keys(env ?? {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function resolveNativeOnPath(name, env = process.env) {
  const pathValue = getEnvValue(env, "PATH");
  for (const entry of typeof pathValue === "string" ? pathValue.split(path.win32.delimiter) : []) {
    const directory = entry.replace(/^"|"$/gu, "");
    for (const suffix of [".exe", ".com"]) {
      const candidate = path.win32.join(directory, `${name}${suffix}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return null;
}

function resolveGitBash(env = process.env) {
  const pathValue = getEnvValue(env, "PATH");
  for (const name of ["bash", "sh"]) {
    const found = resolveNativeOnPath(name, env);
    if (found) return found;
  }

  const gitExe = resolveNativeOnPath("git", env);
  if (gitExe) {
    const gitRoot = path.win32.dirname(path.win32.dirname(gitExe));
    for (const relative of ["bin\\bash.exe", "usr\\bin\\bash.exe", "usr\\bin\\sh.exe"]) {
      const candidate = path.win32.join(gitRoot, relative);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`Git Bash shell executable not found for portable test command fixture (PATH entries: ${String(pathValue ?? "").split(path.win32.delimiter).length})`);
}

function fixtureScriptFor(command, env) {
  if (typeof command !== "string" || command.length === 0) return null;
  const direct = path.win32.isAbsolute(command)
    ? command
    : null;
  const name = path.win32.basename(command).replace(/\.(?:exe|com|cmd|bat)$/iu, "");
  const candidates = direct ? [direct] : [];
  if (direct && fs.existsSync(direct)) {
    candidates.push(path.win32.join(path.win32.dirname(direct), name));
  }
  if (!direct) {
    const pathValue = getEnvValue(env, "PATH");
    for (const entry of typeof pathValue === "string" ? pathValue.split(path.win32.delimiter) : []) {
      const directory = entry.replace(/^"|"$/gu, "");
      candidates.push(path.win32.join(directory, name));
    }
  }

  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      const firstLine = fs.readFileSync(candidate, { encoding: "utf8" }).slice(0, 160).split(/\r?\n/u, 1)[0];
      if (/^#!\s*\/usr\/bin\/env\s+node\b/u.test(firstLine)
        || /^#!\s*\/usr\/bin\/node\b/u.test(firstLine)) {
        return { path: candidate, kind: "node" };
      }
      if (/^#!\s*(?:\/bin\/(?:ba)?sh|\/usr\/bin\/env\s+(?:ba)?sh)\b/u.test(firstLine)) {
        return { path: candidate, kind: "shell" };
      }
    } catch {
      // Not a fixture script; try the next PATH entry.
    }
  }
  return null;
}

function normalizeSpawnArgs(args, options) {
  if (args === undefined || args === null) return { args: [], options: options ?? {} };
  if (Array.isArray(args)) return { args, options: options ?? {} };
  return { args: [], options: args };
}

function normalizeWin32Environment(options) {
  if (process.platform !== "win32"
    || !options?.env
    || typeof options.env !== "object"
    || Array.isArray(options.env)) return options;
  const env = {};
  for (const [key, value] of Object.entries(options.env)) {
    const existing = Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (existing !== undefined) delete env[existing];
    env[key] = value;
  }
  return { ...options, env };
}

function install() {
  if (process.platform !== "win32" || process.env[enabledKey] !== "1" || childProcess[patchedKey]) return;

  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  const originalExecFileSync = childProcess.execFileSync;
  const shellExe = process.env[shellKey] || resolveGitBash();

  childProcess.spawn = function portableSpawn(command, args, options) {
    const normalized = normalizeSpawnArgs(args, options);
    normalized.options = normalizeWin32Environment(normalized.options);
    const fixture = fixtureScriptFor(command, normalized.options.env ?? process.env);
    if (!fixture || normalized.options.shell === true) {
      return originalSpawn.call(this, command, normalized.args, normalized.options);
    }
    const executable = fixture.kind === "node" ? process.execPath : shellExe;
    return originalSpawn.call(this, executable, [fixture.path, ...normalized.args], normalized.options);
  };

  childProcess.spawnSync = function portableSpawnSync(command, args, options) {
    const normalized = normalizeSpawnArgs(args, options);
    normalized.options = normalizeWin32Environment(normalized.options);
    const fixture = fixtureScriptFor(command, normalized.options.env ?? process.env);
    if (!fixture || normalized.options.shell === true) {
      return originalSpawnSync.call(this, command, normalized.args, normalized.options);
    }
    const executable = fixture.kind === "node" ? process.execPath : shellExe;
    return originalSpawnSync.call(this, executable, [fixture.path, ...normalized.args], normalized.options);
  };

  childProcess.execFileSync = function portableExecFileSync(command, args, options) {
    const normalized = normalizeSpawnArgs(args, options);
    normalized.options = normalizeWin32Environment(normalized.options);
    const fixture = fixtureScriptFor(command, normalized.options.env ?? process.env);
    if (!fixture || normalized.options.shell === true) {
      return originalExecFileSync.call(this, command, normalized.args, normalized.options);
    }
    const executable = fixture.kind === "node" ? process.execPath : shellExe;
    return originalExecFileSync.call(
      this,
      executable,
      [fixture.path, ...normalized.args],
      normalized.options,
    );
  };

  Object.defineProperty(childProcess, patchedKey, { value: true });
  syncBuiltinESMExports();
}

function appendPreload(nodeOptions, preloadPath) {
  const portablePath = process.platform === "win32" ? preloadPath.replaceAll("\\", "/") : preloadPath;
  const normalizedPath = portablePath.toLowerCase();
  const existingOptions = String(nodeOptions ?? "");
  if (existingOptions.toLowerCase().replaceAll("\\", "/").includes(normalizedPath)) return existingOptions;
  const quotedPath = `"${portablePath.replaceAll('"', '\\"')}"`;
  const option = `--require ${quotedPath}`;
  return [String(nodeOptions ?? "").trim(), option].filter(Boolean).join(" ");
}

if (process.platform === "win32") {
  process.env[enabledKey] = "1";
  process.env[shellKey] ||= resolveGitBash();
  process.env.NODE_OPTIONS = appendPreload(process.env.NODE_OPTIONS, __filename);
  install();
}

module.exports = { appendPreload, install };
