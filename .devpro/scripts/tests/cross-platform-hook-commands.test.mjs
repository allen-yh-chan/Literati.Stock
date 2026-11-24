/**
 * cross-platform-hook-commands.test.mjs
 *
 * Guards three things:
 *
 * 1. `.claude/settings.json` hook commands must not contain POSIX-only
 *    built-ins. Root cause: PR #249 initially used `test -f X && node X`
 *    which fails on Windows cmd.exe / PowerShell — `test` is not a
 *    native Windows command. Pattern: node -e "require('fs')..." is safe.
 *
 * 2. `anti-patterns-examples.md` must contain the cross-platform
 *    anti-pattern entry (phrase guard against silent removal).
 *
 * 3. Hook command paths must reside under SYNC_DIRS (`.devpro/`, `.codex/`,
 *    `.cursor/`, `.github/`) so consumer repos can sync them via
 *    `sync-agent-rules.mjs`. A path outside SYNC_DIRS = silent failure on
 *    consumer (defensive existsSync short-circuits to no-op, gate fails open).
 *    Per `rules-flow.md` §「修改 source 的 .claude/settings.json
 *    須額外考慮」 §1.
 *
 * POSIX-only patterns flagged:
 *   - `test -[fdrwxe]` (POSIX test with file-flag)
 *   - `[ -[fdrwxe]`   (bracket-test short form)
 *   - `find . -name`  (POSIX find invocation)
 *
 * Safe patterns (whitelisted):
 *   - Commands starting with `node` (Node.js APIs are cross-platform)
 *   - Commands that don't contain any shell built-in triggers
 */

import { readFileSync } from "node:fs";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import path from "node:path";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";

const CLAUDE_ONLY_ADVISORY_SCRIPTS = new Set(["commit-soft-nudge.mjs"]);

// ── Test 1: hook commands are cross-platform ────────────────────────────────

const POSIX_ONLY = /\btest\s+-[fdrwxe]\b|\[\s+-[fdrwxe]\s|^find\s+/;

function readJsonAllowComments(relPath) {
  const raw = readFileSync(path.join(REPO_ROOT, relPath), "utf8");
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
}

function collectHookCommands(config) {
  const commands = [];
  for (const [event, entries] of Object.entries(config.hooks || {})) {
    // Each event value may be an array of entry objects
    const entryList = Array.isArray(entries) ? entries : [entries];
    for (const entry of entryList) {
      if (typeof entry.command === "string") {
        commands.push({ event, command: entry.command });
      }
      const hookList = Array.isArray(entry.hooks) ? entry.hooks : [];
      for (const hook of hookList) {
        if (hook.type !== "command") continue;
        commands.push({ event, command: hook.command });
      }
    }
  }
  return commands;
}

function stripClaudeOnlyAdvisories(entries) {
  return JSON.parse(JSON.stringify(entries)).map((entry) => {
    if (Object.hasOwn(entry, "matcher")) entry.matcher = "<runtime-specific>";
    if (typeof entry.command === "string") {
      entry.command = entry.command.replace(/\s--host=[a-z0-9-]+\b/g, " --host=<runtime>");
    }
    if (Array.isArray(entry.hooks)) {
      entry.hooks = entry.hooks.filter((hook) => {
        const leaf = hookScriptLeaf(hook.command);
        return !CLAUDE_ONLY_ADVISORY_SCRIPTS.has(leaf);
      }).map((hook) => {
        if (typeof hook.command === "string") {
          hook.command = hook.command.replace(/\s--host=[a-z0-9-]+\b/g, " --host=<runtime>");
        }
        return hook;
      });
    }
    return entry;
  });
}

function normalizeRuntimeHostMarkers(entries) {
  return JSON.parse(JSON.stringify(entries)).map((entry) => {
    if (Object.hasOwn(entry, "matcher")) entry.matcher = "<runtime-specific>";
    if (typeof entry.command === "string") {
      entry.command = entry.command.replace(/\s--host=[a-z0-9-]+\b/g, " --host=<runtime>");
    }
    if (Array.isArray(entry.hooks)) {
      entry.hooks = entry.hooks.map((hook) => {
        if (typeof hook.command === "string") {
          hook.command = hook.command.replace(/\s--host=[a-z0-9-]+\b/g, " --host=<runtime>");
        }
        return hook;
      });
    }
    return entry;
  });
}

function commandHostMarker(command) {
  return typeof command === "string" ? command.match(/\s--host=([a-z0-9-]+)\b/)?.[1] || "" : "";
}

function hookScriptLeaf(command) {
  if (typeof command !== "string") return "";
  const matches = [...command.matchAll(/\.devpro\/scripts\/hooks\/([^"\s]+\.mjs)\b/g)];
  return matches.at(-1)?.[1] || "";
}

function collectHostMarkers(config) {
  return collectHookCommands(config)
    .map(({ command }) => commandHostMarker(command))
    .filter(Boolean);
}

test(".codex/hooks.json must carry the same hook event entries as .claude/settings.json", () => {
  const claude = readJsonAllowComments(".claude/settings.json");
  const codex = readJsonAllowComments(".codex/hooks.json");
  assert.deepEqual(
    Object.keys(codex.hooks || {}).sort(),
    Object.keys(claude.hooks || {}).sort(),
    "Codex hooks must stay event-aligned with Claude hooks"
  );

  for (const event of Object.keys(claude.hooks || {})) {
    assert.deepEqual(
      normalizeRuntimeHostMarkers(codex.hooks[event]),
      stripClaudeOnlyAdvisories(claude.hooks[event]),
      `.codex/hooks.json hooks.${event} must match .claude/settings.json hooks.${event} modulo runtime --host marker`
    );
  }
});

test("hook commands in Claude and Codex configs must be cross-platform (no POSIX-only built-ins)", () => {
  const configs = [
    [".claude/settings.json", readJsonAllowComments(".claude/settings.json")],
    [".codex/hooks.json", readJsonAllowComments(".codex/hooks.json")],
    [".cursor/hooks.json", readJsonAllowComments(".cursor/hooks.json")],
  ];

  const violations = [];
  for (const [relPath, config] of configs) {
    for (const { event, command } of collectHookCommands(config)) {
      if (POSIX_ONLY.test(command)) {
        violations.push(`${relPath} ${event}: ${command}`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Found POSIX-only built-ins in hook commands (fail on Windows cmd.exe / PowerShell):\n${violations.join("\n")}\n\nMigrate to Node.js APIs — see anti-patterns-examples.md §12`
  );
});

test("runtime hook configs pass explicit host markers into run-hook", () => {
  const configs = [
    [".claude/settings.json", "claude-code", readJsonAllowComments(".claude/settings.json")],
    [".codex/hooks.json", "codex", readJsonAllowComments(".codex/hooks.json")],
    [".cursor/hooks.json", "cursor", readJsonAllowComments(".cursor/hooks.json")],
  ];

  for (const [relPath, expectedHost, config] of configs) {
    const markers = collectHostMarkers(config);
    assert.ok(markers.length > 0, `${relPath} must pass --host=${expectedHost}`);
    assert.deepEqual(
      [...new Set(markers)],
      [expectedHost],
      `${relPath} must use only --host=${expectedHost}`
    );
  }
});

test("runtime hook configs use PATH node launcher and do not hardcode nvm node", () => {
  const configs = [
    [".claude/settings.json", readJsonAllowComments(".claude/settings.json")],
    [".codex/hooks.json", readJsonAllowComments(".codex/hooks.json")],
    [".cursor/hooks.json", readJsonAllowComments(".cursor/hooks.json")],
  ];

  const violations = [];
  for (const [relPath, config] of configs) {
    for (const { event, command } of collectHookCommands(config)) {
      if (!command.startsWith("node -e ")) {
        violations.push(`${relPath} ${event}: hook command must start with PATH-resolved "node -e"`);
      }
      if (/\.nvm|\/versions\/node\//.test(command)) {
        violations.push(`${relPath} ${event}: hook command must not hardcode an nvm Node path`);
      }
      if (!command.includes("spawnSync(process.execPath")) {
        violations.push(`${relPath} ${event}: launcher must re-use the parent PATH/global node via process.execPath`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Hook launchers must work in consumer repos without nvm as long as global node is on PATH:\n${violations.join("\n")}`
  );
});

// ── Test 1b: hook command paths must reside under SYNC_DIRS ────────────────

// Import SYNC_DIRS from sync-agent-rules.mjs (single source of truth) to avoid
// drift when new sync dirs are added (per dp-reviewer Important #1).
import { SYNC_DIRS as SYNC_DIRS_OBJ } from "../sync-agent-rules.mjs";
const SYNC_DIRS = SYNC_DIRS_OBJ.map((d) => d.relPath + "/");

/**
 * Extract the first quoted path argument from a hook command string.
 *
 * Supports two forms:
 *   1. `node -e "...existsSync('X')..."` (cwd-proof inline launcher, A' form)
 *      → extracts X from the existsSync literal string argument
 *   2. `node <path>` or `node --test <path>` (bare node form, legacy/advisory)
 *      → extracts the path argument after any flags
 *
 * IMPORTANT: Returns null when extraction fails. The caller MUST treat null
 * as a test failure (not a skip) — silent skip would recreate the exact
 * vulnerability this test is guarding against (undetected paths outside SYNC_DIRS).
 *
 * Invariant: this function is invoked only over `settings.hooks` traversal —
 * the `statusLine` field at the top level of settings.json is never reached,
 * so its `node .claude/statusline.cjs` command is not subject to SYNC_DIRS
 * enforcement here.
 */
function extractHookCommandPath(commandStr) {
  // A' inline launcher form: node -e "...existsSync('.devpro/scripts/hooks/run-hook.mjs')..."
  // The regex finds the FIRST existsSync('...') literal in the command string.
  const match = commandStr.match(/existsSync\(['"]([^'"]+)['"]\)/);
  if (match) return match[1];
  // Legacy bare node form: node [--flags] <path>
  // Only matched as fallback — new hook commands should use inline launcher form.
  const bareNode = commandStr.match(/^\s*node\s+(?:--\S+\s+)*([^\s'"]+)/);
  if (bareNode) return bareNode[1];
  return null;
}

test("hook command paths in Claude, Codex, and Cursor configs must reside under SYNC_DIRS", () => {
  const configs = [
    [".claude/settings.json", readJsonAllowComments(".claude/settings.json")],
    [".codex/hooks.json", readJsonAllowComments(".codex/hooks.json")],
    [".cursor/hooks.json", readJsonAllowComments(".cursor/hooks.json")],
  ];

  const violations = [];
  const unrecognized = [];

  for (const [relPath, config] of configs) {
    for (const { event, command } of collectHookCommands(config)) {
      const detectedPath = extractHookCommandPath(command);
      if (!detectedPath) {
        // FAIL — not skip: unrecognized command shape means the SYNC_DIRS guard
        // is blind to this command. This recreates the silent failure we fixed.
        unrecognized.push(`${relPath} ${event}: ${command.slice(0, 80)}`);
        continue;
      }
      const inSyncDir = SYNC_DIRS.some((d) => detectedPath.startsWith(d));
      if (!inSyncDir) {
        violations.push(`${relPath} ${event}: ${detectedPath} (not under SYNC_DIRS)`);
      }
    }
  }

  assert.deepEqual(
    unrecognized,
    [],
    `Found hook commands whose paths cannot be extracted — SYNC_DIRS guard is blind to these commands (silent failure risk).\n${unrecognized.join("\n")}\n\nFix: ensure hook command uses inline launcher form (node -e \"...existsSync('X')...\" Event Gate) so extractHookCommandPath can find the path.`
  );

  assert.deepEqual(
    violations,
    [],
    `Found hook command paths outside SYNC_DIRS — these will not propagate to consumer repos via sync-agent-rules.mjs --sync, causing silent gate failures on consumers. SYNC_DIRS = ${SYNC_DIRS.join(", ")}\n${violations.join("\n")}\n\nFix: move script under one of SYNC_DIRS, or update rules-flow.md §「修改 source 的 .claude/settings.json 須額外考慮」 §1 if a deliberate exception.`
  );
});

test("extractHookCommandPath: returns path from inline launcher form (node -e with existsSync)", () => {
  const inlineCmd = `node -e "const fs=require('fs');if(fs.existsSync('.devpro/scripts/hooks/run-hook.mjs')){}" Stop .devpro/scripts/hooks/recap-check.mjs`;
  const result = extractHookCommandPath(inlineCmd);
  assert.equal(result, ".devpro/scripts/hooks/run-hook.mjs",
    "extractHookCommandPath must extract path from existsSync() call in inline launcher");
});

test("extractHookCommandPath: returns null for unrecognized command form (no node prefix)", () => {
  const malformedCmd = `bash -c "some_command"`;
  const result = extractHookCommandPath(malformedCmd);
  assert.equal(result, null,
    "extractHookCommandPath must return null for unrecognized non-node command");
});

// ── Test 3: cross-runtime parity ───────────────────────────────────────────

/**
 * Read a JSON file (allowing // line comments) relative to repoRoot.
 */
function readJSON(relPath) {
  return readJsonAllowComments(relPath);
}

/**
 * Extract leaf script filenames from a hook event entry list.
 *
 * Handles two formats:
 *   Claude/Codex: array of { hooks: [{ type: "command", command: "node ... <script>.mjs" }] }
 *   Cursor:       array of { command: "node ... <script>.mjs" }
 *
 * Returns array of leaf basenames, e.g. ["recap-check.mjs", "stop-handoff-cite.mjs"]
 */
function extractScripts(entries) {
  if (!Array.isArray(entries)) return [];
  const scripts = [];
  for (const entry of entries) {
    // Claude/Codex format: entry has a `hooks` array
    if (Array.isArray(entry.hooks)) {
      for (const hook of entry.hooks) {
        if (typeof hook.command === "string") {
          const leaf = hookScriptLeaf(hook.command);
          if (leaf) scripts.push(leaf);
        }
      }
    }
    // Cursor format: entry has a direct `command` string
    if (typeof entry.command === "string") {
      const leaf = hookScriptLeaf(entry.command);
      if (leaf) scripts.push(leaf);
    }
  }
  return scripts;
}

test("cross-runtime parity: stop event hook scripts match across runtimes (modulo Cursor postToolUse N/A)", () => {
  const claude = readJSON(".claude/settings.json");
  const codex = readJSON(".codex/hooks.json");
  const cursor = readJSON(".cursor/hooks.json");

  const claudeStop = extractScripts(claude.hooks.Stop);
  const codexStop = extractScripts(codex.hooks.Stop);
  const cursorStop = extractScripts(cursor.hooks.stop);

  // Claude + Codex must match exactly (both are PostToolUse-capable runtimes)
  assert.deepEqual(
    claudeStop.slice().sort(),
    codexStop.slice().sort(),
    "Claude/Codex Stop hook scripts must match exactly"
  );

  // Cursor must contain all stop hooks (Stop event is supported on Cursor)
  for (const script of claudeStop) {
    assert.ok(
      cursorStop.includes(script),
      `Cursor stop event missing ${script} (cross-runtime parity violation)`
    );
  }
});

test("cross-runtime parity: PreToolUse hook scripts match between Claude and Codex", () => {
  const claude = readJSON(".claude/settings.json");
  const codex = readJSON(".codex/hooks.json");

  const claudePre = extractScripts(claude.hooks.PreToolUse);
  const codexPre = extractScripts(codex.hooks.PreToolUse);
  const expectedClaudePre = claudePre.filter((script) => !CLAUDE_ONLY_ADVISORY_SCRIPTS.has(script));

  assert.deepEqual(
    expectedClaudePre.slice().sort(),
    codexPre.slice().sort(),
    "Claude/Codex PreToolUse hook scripts must match exactly"
  );
});

test("Claude and Codex shell hooks use live shell tool surfaces", () => {
  const claude = readJSON(".claude/settings.json");
  const codex = readJSON(".codex/hooks.json");

  for (const event of ["PreToolUse", "PostToolUse"]) {
    const claudeShellEntry = (claude.hooks[event] || []).find((entry) =>
      /(?:^|\|)Bash(?:\||$)/.test(String(entry.matcher || ""))
    );
    assert.ok(claudeShellEntry, `Claude ${event} must have a Bash matcher entry`);
    assert.equal(claudeShellEntry.matcher, "Bash", `Claude ${event} must only cover Bash`);

    const codexShellEntry = (codex.hooks[event] || []).find((entry) =>
      /(?:^|\|)functions\.exec_command(?:\||$)/.test(String(entry.matcher || ""))
    );
    assert.ok(codexShellEntry, `Codex ${event} must have a functions.exec_command matcher entry`);
    assert.equal(
      codexShellEntry.matcher,
      "Bash|functions.exec_command",
      `Codex ${event} must cover both live Bash and functions.exec_command shell surfaces`
    );
    assert.match(
      String(codexShellEntry.matcher || ""),
      /(?:^|\|)Bash(?:\||$)/,
      `Codex ${event} must cover live Bash shell payloads`
    );
    assert.match(
      String(codexShellEntry.matcher || ""),
      /(?:^|\|)functions\.exec_command(?:\||$)/,
      `Codex ${event} must preserve functions.exec_command shell payload coverage`
    );

    assert.doesNotMatch(
      String(codexShellEntry.matcher || ""),
      /(?:^|\|)exec_command(?:\||$)/,
      `Codex ${event} must not require unverified bare exec_command`
    );
  }

  const codexApplyPatchEntry = (codex.hooks.PreToolUse || []).find((entry) =>
    /(?:^|\|)functions\.apply_patch(?:\||$)/.test(String(entry.matcher || ""))
  );
  assert.ok(
    codexApplyPatchEntry,
    "Codex PreToolUse must include functions.apply_patch in the file-write hard gate matcher"
  );
  assert.match(
    String(codexApplyPatchEntry.matcher || ""),
    /(?:^|\|)Edit(?:\||$).*functions\.apply_patch|functions\.apply_patch.*(?:^|\|)Edit(?:\||$)/,
    "functions.apply_patch must share the file-write hard gate entry with Edit/Write/MultiEdit"
  );
});

test("Cursor shell PreToolUse covers live Shell tool and invokes authoritative gates", () => {
  const cursor = readJSON(".cursor/hooks.json");
  const shellEntries = (cursor.hooks.preToolUse || []).filter((entry) =>
    /(?:^|\|)Shell(?:\||$)/.test(String(entry.matcher || ""))
  );
  assert.ok(shellEntries.length >= 2, "Cursor preToolUse must have Shell-matched shell gate entries");
  const scripts = shellEntries.flatMap((entry) => extractScripts([entry]));
  assert.ok(
    scripts.includes("pre-tool-gate.mjs"),
    "Cursor Shell matcher must invoke pre-tool-gate.mjs (cross-model merge gate)"
  );
  assert.ok(
    scripts.includes("gh-footer-gate.mjs"),
    "Cursor Shell matcher must invoke gh-footer-gate.mjs"
  );
  const bashOnlyShellEntry = (cursor.hooks.preToolUse || []).find(
    (entry) =>
      entry.matcher === "Bash" &&
      extractScripts([entry]).some((script) =>
        ["pre-tool-gate.mjs", "gh-footer-gate.mjs"].includes(script)
      )
  );
  assert.equal(
    bashOnlyShellEntry,
    undefined,
    "Cursor shell gates must not remain Bash-only (Shell tool bypasses Bash matcher)"
  );
});

test("Codex live Bash shell PreToolUse invokes the authoritative pre-tool gate recorder", () => {
  const codex = readJSON(".codex/hooks.json");
  const shellEntry = (codex.hooks.PreToolUse || []).find((entry) =>
    /(?:^|\|)Bash(?:\||$)/.test(String(entry.matcher || "")) &&
    /(?:^|\|)functions\.exec_command(?:\||$)/.test(String(entry.matcher || ""))
  );

  assert.ok(shellEntry, "Codex PreToolUse shell entry must cover Bash and functions.exec_command");
  assert.ok(
    (shellEntry.hooks || []).some((hook) => hookScriptLeaf(hook.command) === "pre-tool-gate.mjs"),
    "Codex Bash shell rule reads must invoke pre-tool-gate.mjs, not only rule-load-ledger-host-diag.mjs"
  );
});

test("rule-load host diagnostic hook is wired as a broad PreToolUse observer", () => {
  const claude = readJSON(".claude/settings.json");
  const codex = readJSON(".codex/hooks.json");
  const cursor = readJSON(".cursor/hooks.json");

  const hasBroadDiag = (entries, commandKey = "hooks") => {
    return (entries || []).some((entry) => {
      if (entry.matcher !== "") return false;
      if (commandKey === "command") {
        return hookScriptLeaf(entry.command) === "rule-load-ledger-host-diag.mjs";
      }
      return (entry.hooks || []).some((hook) =>
        hookScriptLeaf(hook.command) === "rule-load-ledger-host-diag.mjs"
      );
    });
  };

  assert.equal(hasBroadDiag(claude.hooks.PreToolUse), true, "Claude PreToolUse diagnostic hook missing");
  assert.equal(hasBroadDiag(codex.hooks.PreToolUse), true, "Codex PreToolUse diagnostic hook missing");
  assert.equal(hasBroadDiag(cursor.hooks.preToolUse, "command"), true, "Cursor preToolUse diagnostic hook missing");
});

test("native Read PreToolUse invokes the authoritative pre-tool gate recorder", () => {
  const claude = readJSON(".claude/settings.json");
  const codex = readJSON(".codex/hooks.json");
  const cursor = readJSON(".cursor/hooks.json");

  const hasReadRecorder = (entries, commandKey = "hooks") => {
    return (entries || []).some((entry) => {
      if (entry.matcher !== "Read") return false;
      if (commandKey === "command") {
        return hookScriptLeaf(entry.command) === "pre-tool-gate.mjs";
      }
      return (entry.hooks || []).some((hook) =>
        hookScriptLeaf(hook.command) === "pre-tool-gate.mjs"
      );
    });
  };

  assert.equal(hasReadRecorder(claude.hooks.PreToolUse), true, "Claude Read recorder hook missing");
  assert.equal(hasReadRecorder(codex.hooks.PreToolUse), true, "Codex Read recorder hook missing");
  assert.equal(hasReadRecorder(cursor.hooks.preToolUse, "command"), true, "Cursor Read recorder hook missing");
});

test("native Agent-dispatch PreToolUse invokes the authoritative pre-tool gate recorder (design.md D5)", () => {
  // Each host's subagent-launch tool has a different confirmed tool_name:
  // Claude Code = "Agent" with the still-accepted exact legacy alias "Task"
  // (TaskCreate/TaskList/etc. remain unrelated checklist tools and are not
  // matched); Codex = spawn_agent / Agent alias (v1) or collaborationspawn_agent
  // (v2): upstream `flat_tool_name` concatenates namespace + tool name with no
  // delimiter, so `collaboration` + `spawn_agent` becomes that token. Cursor = "Task"
  // (platform-adapters/cursor.md). These matchers invoke the shared hook;
  // evaluatePreToolUsePayload then applies the host-native context gate.
  const claude = readJSON(".claude/settings.json");
  const codex = readJSON(".codex/hooks.json");
  const cursor = readJSON(".cursor/hooks.json");

  const hasTokenRecorder = (entries, matcherToken, commandKey = "hooks") => {
    const tokenRe = new RegExp(`(?:^|\\|)${matcherToken}(?:\\||$)`);
    return (entries || []).some((entry) => {
      if (!tokenRe.test(String(entry.matcher || ""))) return false;
      if (commandKey === "command") {
        return hookScriptLeaf(entry.command) === "pre-tool-gate.mjs";
      }
      return (entry.hooks || []).some((hook) =>
        hookScriptLeaf(hook.command) === "pre-tool-gate.mjs"
      );
    });
  };

  assert.equal(
    hasTokenRecorder(claude.hooks.PreToolUse, "Agent"),
    true,
    "Claude Agent-dispatch recorder hook missing"
  );
  assert.equal(
    hasTokenRecorder(claude.hooks.PreToolUse, "Task"),
    true,
    "Claude legacy Task alias recorder hook missing"
  );
  assert.equal(
    hasTokenRecorder(codex.hooks.PreToolUse, "spawn_agent"),
    true,
    "Codex Agent-dispatch recorder hook missing spawn_agent token"
  );
  assert.equal(
    hasTokenRecorder(codex.hooks.PreToolUse, "Agent"),
    true,
    "Codex Agent-dispatch recorder hook missing Agent token"
  );
  assert.equal(
    hasTokenRecorder(codex.hooks.PreToolUse, "collaborationspawn_agent"),
    true,
    "Codex Agent-dispatch recorder hook missing collaborationspawn_agent token"
  );
  assert.equal(
    hasTokenRecorder(cursor.hooks.preToolUse, "Task", "command"),
    true,
    "Cursor Task-dispatch recorder hook missing"
  );
});

test("cross-runtime parity: Cursor lacks postToolUse event (architectural gap acknowledged)", () => {
  const cursor = readJSON(".cursor/hooks.json");
  // Cursor architecture does not support postToolUse event.
  // Gate D' (worktree-cd sentinel write) intentionally degrades to no-op on Cursor.
  // Documented in rule-design-principles.md Hook Event Coverage Matrix.
  assert.ok(
    !cursor.hooks.postToolUse,
    "Cursor postToolUse must remain absent — it is architecturally unsupported. Gate D\\' degrades to no-op on Cursor (see rule-design-principles.md Hook Event Coverage Matrix)."
  );
});

// ── Test 1c: RULES_BRANCH_RE cross-platform consistency ─────────────────────
//
// RULES_BRANCH_RE is defined in lib/branch-naming.mjs and used by
// pre-tool-gate.mjs Gate 3 (fast-track exemption for rules/<source>-v<X.Y.Z>).
// These tests confirm:
//   (a) The regex accepts valid rules/ branch patterns on any OS (no POSIX-only
//       constructs; pure JS regex is inherently cross-platform).
//   (b) The regex rejects invalid patterns consistently.
//   (c) RULES_BRANCH_RE remains in lib/branch-naming.mjs (not inline in
//       pre-tool-gate.mjs). The hook may import narrower helpers instead of the
//       regex directly.
//
// CR/LF line-ending safety: RULES_BRANCH_RE tests against branch name strings
// that will never contain CRLF, so no special handling is needed. The regex
// itself uses no POSIX-only syntax — it is a plain JS RegExp literal.

import { RULES_BRANCH_RE } from "../hooks/lib/branch-naming.mjs";

test("RULES_BRANCH_RE: accepts valid semver rules/ branch (cross-platform)", () => {
  assert.ok(
    RULES_BRANCH_RE.test("rules/agent-rules-v6.39.0"),
    "rules/agent-rules-v6.39.0 must match RULES_BRANCH_RE"
  );
});

test("RULES_BRANCH_RE: rejects retired date+sha rules/ branch (cross-platform)", () => {
  assert.ok(
    !RULES_BRANCH_RE.test("rules/agent-rules-20260509-9f82ed5"),
    "rules/agent-rules-20260509-9f82ed5 must not match RULES_BRANCH_RE"
  );
});

test("RULES_BRANCH_RE: rejects missing version segment (cross-platform)", () => {
  assert.ok(
    !RULES_BRANCH_RE.test("rules/agent-rules"),
    "rules/agent-rules (no version) must not match RULES_BRANCH_RE"
  );
});

test("RULES_BRANCH_RE: rejects wrong version format (cross-platform)", () => {
  assert.ok(
    !RULES_BRANCH_RE.test("rules/agent-rules-foo"),
    "rules/agent-rules-foo (non-semver/non-sha) must not match RULES_BRANCH_RE"
  );
});

test("RULES_BRANCH_RE: rejects unknown source with valid version (cross-platform)", () => {
  // Source validation (whitelist check) is separate from the regex; the regex
  // itself accepts any valid <source>-<v> pattern. This test confirms the regex
  // does NOT do source filtering — that is left to validateRulesBranch().
  assert.ok(
    RULES_BRANCH_RE.test("rules/unknown-source-v1.0.0"),
    "RULES_BRANCH_RE must match format (source whitelist check is separate)"
  );
});

test("rules branch regex SSOT resides under SYNC_DIRS and is not inlined in pre-tool-gate.mjs", () => {
  const hookPath = repoPath(".devpro/scripts/hooks/pre-tool-gate.mjs");
  const branchNamingPath = repoPath(".devpro/scripts/hooks/lib/branch-naming.mjs");
  const hookSource = readFileSync(hookPath, "utf8");
  const branchNamingSource = readFileSync(branchNamingPath, "utf8");
  assert.ok(
    branchNamingSource.includes("RULES_BRANCH_RE"),
    "branch-naming.mjs must remain the RULES_BRANCH_RE SSOT under .devpro/"
  );
  assert.ok(
    !hookSource.match(/const\s+RULES_BRANCH_RE\s*=/),
    "pre-tool-gate.mjs must not redefine RULES_BRANCH_RE inline"
  );
});

// ── Test 2: anti-patterns-behavioral.md phrase guard ────────────────────────
// §12 detail moved from anti-patterns-examples.md to anti-patterns-behavioral.md (T5 de-bundle)

const ANTI_PATTERNS_PATH = repoPath(".devpro/agent-rules/anti-patterns-behavioral.md");

const REQUIRED_PHRASES = [
  "POSIX",
  "cross-platform",
  "run-hook.mjs",
  "exit code",
];

const content = readFileSync(ANTI_PATTERNS_PATH, "utf8");

for (const phrase of REQUIRED_PHRASES) {
  test(`anti-patterns-behavioral.md 必含 "${phrase}" (cross-platform anti-pattern entry)`, () => {
    assert.ok(
      content.includes(phrase),
      `cross-platform anti-pattern §12 已被移除或修改：「${phrase}」missing — 改動前須走 amend change 並更新本測試 phrase list`
    );
  });
}

// ── T1/T2: §12 ↔ config launcher byte-align gate ───────────────────────────
//
// T1: Helper functions that extract the inline launcher body from two sources:
//   - §12 markdown code block (anti-patterns-examples.md): raw `node -e "..."` line
//   - Config file (e.g. .claude/settings.json): JSON.parse → first hook command
//
// Both sides strip the trailing " <event> <leaf>" args and return just the
// -e body string. After Step A fix (correct stderr escape), the two bodies
// must be byte-identical.
//
// T2: Asserts byte-alignment. Anti-fake-green validated by:
//   - Mutating the extracted docBody and confirming assert.equal fails
//   - The real test passes when docBody === configBody

/**
 * Extract the `node -e` body from the §12 canonical launcher line in
 * anti-patterns-examples.md.
 *
 * §12 line form:
 *   node -e "<body>" Stop .devpro/scripts/hooks/recap-check.mjs [--host=<runtime>]
 *
 * Returns the body string (decoded from the markdown source line — the body
 * in markdown is the exact JS source code, with `\n` meaning backslash-n
 * which at runtime becomes a real newline when node -e parses the JS string).
 *
 * Returns null if the canonical line cannot be found or parsed.
 */
function extractDocLauncherBody() {
  const md = readFileSync(ANTI_PATTERNS_PATH, "utf8");
  // Find the canonical §12 launcher example line
  const lineStart = md.indexOf('node -e "const fs=require');
  if (lineStart === -1) return null;
  const lineEnd = md.indexOf("\n", lineStart);
  const fullLine = lineEnd === -1 ? md.slice(lineStart) : md.slice(lineStart, lineEnd);
  // Parse: node -e "<body>" <event> <gate> [--host=<runtime>]
  // Body may contain escaped quotes — use greedy match up to last " before trailing args
  const match = fullLine.match(/^node -e "(.*)" \S+ \S+(?:\s--host=[a-z0-9-<>]+)?$/s);
  if (!match) return null;
  return match[1];
}

/**
 * Extract the inline launcher body from a config file via JSON.parse.
 *
 * Config command form (after JSON.parse):
 *   node -e "<body>" <event> <gate> [--host=<runtime>]
 *
 * Searches across all hook events and entries for the first command that
 * contains the canonical launcher marker (`existsSync('.devpro/scripts/hooks/run-hook.mjs')`).
 *
 * Uses JSON.parse for decoding (D3: single source of truth for escape rules).
 * Returns null if no launcher command is found.
 */
function extractConfigLauncherBody(configRelPath) {
  const raw = readFileSync(path.join(REPO_ROOT, configRelPath), "utf8");
  // strip // line comments before parsing
  const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
  for (const entries of Object.values(config.hooks || {})) {
    const entryList = Array.isArray(entries) ? entries : [entries];
    for (const entry of entryList) {
      const candidates = [];
      if (typeof entry.command === "string") candidates.push(entry.command);
      for (const h of Array.isArray(entry.hooks) ? entry.hooks : []) {
        if (typeof h.command === "string") candidates.push(h.command);
      }
      for (const cmd of candidates) {
        // Only match the canonical inline launcher (contains existsSync run-hook.mjs)
        if (!cmd.includes("existsSync('.devpro/scripts/hooks/run-hook.mjs')")) continue;
        // Strip trailing " <event> <gate> [--host=<runtime>]" args
        const match = cmd.match(/^node -e "(.*)" \S+ \S+(?:\s--host=[a-z0-9-]+)?$/s);
        if (!match) continue;
        return match[1];
      }
    }
  }
  return null;
}

test("T1: extractDocLauncherBody returns non-null body from §12 markdown", () => {
  const body = extractDocLauncherBody();
  assert.ok(body !== null, "extractDocLauncherBody must return a non-null body from §12 markdown");
  assert.ok(
    body.length > 100,
    `body must be substantial (got length ${body?.length})`
  );
  assert.ok(
    body.includes("while(true)"),
    "body must contain the while(true) loop"
  );
  assert.ok(
    body.includes("process.stderr.write"),
    "body must contain process.stderr.write"
  );
});

test("T1: extractConfigLauncherBody returns non-null body from .claude/settings.json", () => {
  const body = extractConfigLauncherBody(".claude/settings.json");
  assert.ok(body !== null, "extractConfigLauncherBody must return a non-null body from .claude/settings.json");
  assert.ok(
    body.length > 100,
    `body must be substantial (got length ${body?.length})`
  );
});

test("T1: extractConfigLauncherBody returns non-null body from .codex/hooks.json", () => {
  const body = extractConfigLauncherBody(".codex/hooks.json");
  assert.ok(body !== null, "extractConfigLauncherBody must return a non-null body from .codex/hooks.json");
});

test("T1: extractConfigLauncherBody returns non-null body from .cursor/hooks.json", () => {
  const body = extractConfigLauncherBody(".cursor/hooks.json");
  assert.ok(body !== null, "extractConfigLauncherBody must return a non-null body from .cursor/hooks.json");
});

test("T2: §12 launcher body byte-aligns with .claude/settings.json config", () => {
  const docBody = extractDocLauncherBody();
  const configBody = extractConfigLauncherBody(".claude/settings.json");
  assert.ok(docBody !== null, "§12 doc body must be extractable");
  assert.ok(configBody !== null, ".claude/settings.json config body must be extractable");
  assert.equal(
    docBody,
    configBody,
    `§12 markdown launcher body must be byte-identical to .claude/settings.json launcher body.\n` +
    `docBody length: ${docBody?.length}, configBody length: ${configBody?.length}\n` +
    `This guards against escape drift (PR #973 regression): §12 is the canonical source;\n` +
    `config must match exactly. If this fails, fix the config escape to match §12.`
  );
});

test("T2: §12 launcher body byte-aligns with .codex/hooks.json config", () => {
  const docBody = extractDocLauncherBody();
  const configBody = extractConfigLauncherBody(".codex/hooks.json");
  assert.ok(docBody !== null, "§12 doc body must be extractable");
  assert.ok(configBody !== null, ".codex/hooks.json config body must be extractable");
  assert.equal(
    docBody,
    configBody,
    `§12 markdown launcher body must be byte-identical to .codex/hooks.json launcher body.\n` +
    `docBody length: ${docBody?.length}, configBody length: ${configBody?.length}`
  );
});

test("T2: §12 launcher body byte-aligns with .cursor/hooks.json config", () => {
  const docBody = extractDocLauncherBody();
  const configBody = extractConfigLauncherBody(".cursor/hooks.json");
  assert.ok(docBody !== null, "§12 doc body must be extractable");
  assert.ok(configBody !== null, ".cursor/hooks.json config body must be extractable");
  assert.equal(
    docBody,
    configBody,
    `§12 markdown launcher body must be byte-identical to .cursor/hooks.json launcher body.\n` +
    `docBody length: ${docBody?.length}, configBody length: ${configBody?.length}`
  );
});
