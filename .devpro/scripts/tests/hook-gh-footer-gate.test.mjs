/**
 * hook-gh-footer-gate.test.mjs
 *
 * Unit tests for .devpro/scripts/hooks/gh-footer-gate.mjs.
 *
 * Test cases:
 *   1. 含 footer → exit 0
 *   2. 缺 footer → exit 1 + stderr Footer missing
 *   3. 非 write-back gh 命令 → exit 0 (pass-through)
 *   4. 非 gh 命令 → exit 0 (pass-through)
 *   5. gh api PATCH .../comments 含 footer → exit 0
 *   6. gh api PATCH .../comments 缺 footer → exit 1
 *   7. gh discussion comment heredoc 含 footer → exit 0
 *   8. malformed payload → exit 0 (don't block)
 *   9. gh pr create 含 footer → exit 0
 *  10. gh pr create 缺 footer → exit 1
 *  11. gh pr review --comment 含 footer → exit 0
 *  12. empty body → exit 1
 *  13. gh issue close --comment 含 footer → exit 0
 *  14. gh issue close --comment 缺 footer → exit 1
 *  15. gh pr ready --comment 缺 footer → exit 1
 *  16. gh release create --notes 缺 footer → exit 1
 *  17. gh pr edit --body 缺 footer → exit 1
 *  18. gh issue edit --body 缺 footer → exit 1
 *  19. gh pr review --approve --body 缺 footer → exit 1
 *  20. gh api POST .../comments 缺 footer → exit 1
 *  21. Footer Rules: v 但缺 Model: → exit 1
 *  22. Footer 在 body 開頭非末尾 → exit 1
 *  23. --notes-file 含 footer → exit 0
 *  24. --notes-file missing file → exit 1 (fail-closed D3)
 *  25. false positive: git log --grep="gh issue create --body x" → exit 0
 *  26. false positive: comment line "# gh issue create" → exit 0
 *  27. --body=value 等號形式含 footer → exit 0
 *  28. --body=value 等號形式缺 footer → exit 1
 *  29. --body-file /tmp/nonexistent → exit 1 (fail-closed D3)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync, execSync as _execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, writeFileSync, mkdirSync, rmSync as rmSyncFs, readFileSync } from "node:fs";
import os from "node:os";
import "./lib/owned-friction-log.mjs";
import { makeTempDir } from "./lib/tmp.mjs";
import { evaluateGhFooterGate } from "../hooks/gh-footer-gate.mjs";
import { assertStickyBodyCredentialFree } from "../lib/second-review-sticky-credential-gate.mjs";

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/gh-footer-gate.mjs"
);
const RUN_HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/run-hook.mjs"
);

function fixtureGitEnv(cwd, overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(cwd, ".git", "fixture-global-config"),
    ...overrides,
  };
}

function configureFixtureGit(cwd, overrides = {}) {
  const env = fixtureGitEnv(cwd, overrides);
  for (const [key, value] of [["core.autocrlf", "false"], ["core.symlinks", "true"]]) {
    const result = spawnSync("git", ["config", key, value], { cwd, env, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git config ${key} failed: ${result.stderr || result.stdout}`);
    }
  }
  return env;
}

function run(payload, env = {}) {
  let stdout = "";
  let stderr = "";
  const code = evaluateGhFooterGate({
    rawInput: JSON.stringify(payload),
    env: { ...process.env, CODEX_CI: "", CODEX_THREAD_ID: "", ...env },
    writeStdout: (chunk) => { stdout += chunk; },
    writeStderr: (chunk) => { stderr += chunk; },
  });
  let json = null;
  if (stdout.trim()) {
    try {
      json = JSON.parse(stdout);
    } catch {}
  }
  return { code, stderr, stdout, json };
}

function runCli(payload, env = {}) {
  const result = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CODEX_CI: "", CODEX_THREAD_ID: "", ...env },
  });
  let json = null;
  if (result.stdout && result.stdout.trim()) {
    try {
      json = JSON.parse(result.stdout);
    } catch {}
  }
  return { code: result.status, stderr: result.stderr, stdout: result.stdout, json };
}

function runHookArgs(args, env = {}) {
  const result = spawnSync("node", [HOOK, ...args], {
    encoding: "utf8",
    env: { ...process.env, CODEX_CI: "", CODEX_THREAD_ID: "", ...env },
  });
  return { code: result.status, stderr: result.stderr, stdout: result.stdout };
}

function runViaHookRunner(payload, env = {}) {
  const result = spawnSync("node", [RUN_HOOK, "PreToolUse", HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CODEX_CI: "", CODEX_THREAD_ID: "", ...env },
  });
  let json = null;
  if (result.stdout && result.stdout.trim()) {
    try {
      json = JSON.parse(result.stdout);
    } catch {}
  }
  return { code: result.status, stderr: result.stderr, stdout: result.stdout, json };
}

function scanBareCatchExitHazards(source) {
  // Keep this guard structural: token positions and brace pairs survive
  // formatting/line movement, while strings/comments/templates/regex literals
  // remain data. Include the whole try/catch span because a future bare-catch
  // edit must not hide a typed exit in either arm.
  const tokens = [];
  const isIdentifierStart = (ch) => /[A-Za-z_$]/.test(ch);
  const isIdentifierPart = (ch) => /[A-Za-z0-9_$]/.test(ch);
  const canStartRegexAfter = (token) => !token ||
    ["(", "{", "[", ",", ";", ":", "=", "!", "?", "&", "|", "+", "-", "*", "%", "~"].includes(token.value) ||
    ["return", "throw", "case", "delete", "void", "typeof", "instanceof", "in", "of", "yield", "await", "else", "do"].includes(token.value);

  for (let i = 0; i < source.length;) {
    const ch = source[i];
    if (i === 0 && source.startsWith('#!')) {
      i = source.indexOf('\n');
      if (i === -1) break;
      continue;
    }
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i + 2);
      if (i === -1) break;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '/' && canStartRegexAfter(tokens.at(-1))) {
      let inClass = false;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '/' && !inClass) {
          i += 1;
          while (/[A-Za-z]/.test(source[i] || '')) i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (isIdentifierStart(ch)) {
      const start = i;
      i += 1;
      while (isIdentifierPart(source[i] || '')) i += 1;
      tokens.push({ value: source.slice(start, i), start });
      continue;
    }
    if ('{}().[];,:.=!?&|+-*%~<>'.includes(ch)) tokens.push({ value: ch, start: i });
    i += 1;
  }

  const pairs = new Map();
  const stack = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (["{", "(", "["].includes(tokens[i].value)) stack.push(i);
    else if (["}", ")", "]"].includes(tokens[i].value)) {
      const opener = { "}": "{", ")": "(", "]": "[" }[tokens[i].value];
      const openerIndex = stack.at(-1);
      if (openerIndex !== undefined && tokens[openerIndex].value === opener) {
        stack.pop();
        pairs.set(openerIndex, i);
        pairs.set(i, openerIndex);
      }
    }
  }

  const hazards = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].value !== 'try' || tokens[i + 1]?.value !== '{') continue;
    const tryEnd = pairs.get(i + 1);
    if (tryEnd === undefined || tokens[tryEnd + 1]?.value !== 'catch') continue;
    let catchOpen = tryEnd + 1;
    const bareCatch = tokens[catchOpen + 1]?.value !== '(';
    if (!bareCatch) {
      const bindingEnd = pairs.get(catchOpen + 1);
      if (bindingEnd === undefined) continue;
      catchOpen = bindingEnd + 1;
    } else {
      catchOpen += 1;
    }
    if (!bareCatch || tokens[catchOpen]?.value !== '{') continue;
    const catchEnd = pairs.get(catchOpen);
    if (catchEnd === undefined) continue;
    for (let j = i + 2; j < catchEnd; j += 1) {
      if (tokens[j].value === 'exit' && tokens[j + 1]?.value === '(' && tokens[j - 1]?.value !== '.') {
        hazards.push({ start: tokens[j].start, tryStart: tokens[i].start, catchStart: tokens[catchOpen].start });
      }
    }
  }
  return hazards;
}

test('lexical guard detects only direct exit calls swallowed by bare catches', () => {
  const risky = `/* try { exit(1) } */ const text = "exit(2)"; const re = /try { exit(3) } catch {}/; function f() { try { try { exit(4); } catch (error) { throw error; } } catch {} }`;
  assert.equal(scanBareCatchExitHazards(risky).length, 1);
  assert.deepEqual(scanBareCatchExitHazards('function f() { try { exit(1); } catch (error) { throw error; } }'), []);
  assert.deepEqual(scanBareCatchExitHazards('function f() { try { exitAlias(1); obj.exit(2); } catch {} }'), []);
});

test('live hook source has no direct exit call inside a try with a bare catch', () => {
  const source = readFileSync(HOOK, 'utf8');
  assert.deepEqual(scanBareCatchExitHazards(source), []);
});

test("單行 footer → exit 0", () => {
  const payload = {
    tool_input: { command: 'gh issue create --body "test\nRules: v6.16.0 · Tool: test · Model: x"' },
  };
  const r = run(payload);
  assert.equal(r.code, 0);
  assert.deepEqual(r, runCli(payload), "in-process valid result must match the real CLI byte-for-byte");
});

test("multi-line footer (Rules/Tool/Model 拆三行) → exit 1", () => {
  const r = run({
    tool_input: { command: 'gh issue create --body "test\nRules: v6.16.0\nTool: test\nModel: x"' },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Footer missing/);
});

test("缺 footer → exit 1 + stderr Footer missing", () => {
  const payload = {
    tool_input: { command: 'gh issue create --body "test body without footer"' },
  };
  const r = run(payload);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Footer missing/);
  assert.deepEqual(r, runCli(payload), "in-process block result must match the real CLI byte-for-byte");
});

test("Codex 缺 footer → JSON block + exit 0", () => {
  const payload = { tool_input: { command: 'gh issue create --body "test body without footer"' } };
  const env = { CODEX_CI: "1" };
  const r = run(payload, env);
  const cli = runCli(payload, env);
  assert.equal(cli.code === null, false, `real CLI spawn failed: ${cli.stderr}`);
  assert.equal(r.code, 0);
  assert.equal(r.json?.decision, "block");
  assert.match(r.json?.reason || "", /Footer missing/);
  assert.deepEqual(r, cli, "in-process JSON block must match the real CLI byte-for-byte");
});

test("Claude JSON 缺 footer → JSON block + exit 0 and real CLI parity", () => {
  const payload = { tool_input: { command: 'gh issue create --body "test body without footer"' } };
  const env = { DEVPRO_HOOK_PROTOCOL: "json", DEVPRO_HOOK_HOST: "claude" };
  const r = run(payload, env);
  const cli = runCli(payload, env);
  assert.equal(cli.code === null, false, `real CLI spawn failed: ${cli.stderr}`);
  assert.equal(r.code, 0);
  assert.equal(r.json?.decision, "block");
  assert.match(r.json?.reason || "", /Footer missing/);
  assert.deepEqual(r, cli, "in-process Claude JSON block must match the real CLI byte-for-byte");
});

test("Codex host marker 缺 footer → JSON block + exit 0", () => {
  const r = run(
    { tool_input: { command: 'gh issue create --body "test body without footer"' } },
    { DEVPRO_HOOK_HOST: "codex" }
  );
  assert.equal(r.code, 0);
  assert.equal(r.json?.decision, "block");
  assert.match(r.json?.reason || "", /Footer missing/);
});

test("issue#1193 Codex tool_input.cmd 缺 footer → JSON block like tool_input.command", () => {
  const r = run(
    { tool_input: { cmd: 'gh issue create --body "test body without footer"' } },
    { CODEX_CI: "1" }
  );
  assert.equal(r.code, 0);
  assert.equal(r.json?.decision, "block");
  assert.match(r.json?.reason || "", /Footer missing/);
});

test("Claude hook runner 缺 footer → JSON block + exit 0 hard gate", () => {
  const frictionLog = path.join(os.tmpdir(), `gh-footer-friction-${process.pid}-${Date.now()}.log`);
  try {
    const r = runViaHookRunner({
      tool_input: { command: 'gh issue create --body "test body without footer"' },
    }, { DEVPRO_FRICTION_LOG: frictionLog, DEVPRO_AGENT_RULES_LEVEL: "full" });
    assert.equal(r.code, 0);
    assert.equal(r.json?.decision, "block");
    assert.match(r.json?.reason || "", /Footer missing/);
    assert.equal(r.stderr, "");
    assert.match(readFileSync(frictionLog, "utf8"), /Footer missing/);
  } finally {
    rmSyncFs(frictionLog, { force: true });
  }
});

test("非 write-back gh 命令 → exit 0 (pass-through)", () => {
  const r = run({ tool_input: { command: "gh issue list" } });
  assert.equal(r.code, 0);
});

test("非 gh 命令 → exit 0 (pass-through)", () => {
  const r = run({ tool_input: { command: "npm test" } });
  assert.equal(r.code, 0);
});

test("gh api PATCH .../comments 含 footer → exit 0", () => {
  const r = run({
    tool_input: {
      command:
        'gh api -X PATCH repos/foo/bar/issues/comments/123 -f body="text\nRules: v6.16.0 · Tool: test · Model: x"',
    },
  });
  assert.equal(r.code, 0);
});

test("gh api PATCH .../comments 缺 footer → exit 1", () => {
  const r = run({
    tool_input: {
      command:
        'gh api -X PATCH repos/foo/bar/issues/comments/123 -f body="text only"',
    },
  });
  assert.equal(r.code, 1);
});

test("gh discussion comment heredoc 含 footer → exit 0", () => {
  const heredoc = `gh discussion comment --body "$(cat <<'EOF'
content
Rules: v6.16.0 · Tool: test · Model: x
EOF
)"`;
  const r = run({ tool_input: { command: heredoc } });
  assert.equal(r.code, 0);
});

test("malformed payload → exit 0 (don't block)", () => {
  const result = spawnSync("node", [HOOK], {
    input: "not json",
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
});

test("malformed payload in strict mode → exit 2 with diagnostic", () => {
  const result = spawnSync("node", [HOOK, "--strict-exit"], {
    input: "not json",
    encoding: "utf8",
  });
  assert.notEqual(result.status, null, "real CLI must spawn for strict malformed-payload coverage");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid or missing hook JSON payload/);
});

test("unknown payload parsing exception is rethrown", () => {
  assert.throws(
    () => evaluateGhFooterGate({ rawInput: Symbol("not-json"), writeStdout() {}, writeStderr() {} }),
    TypeError,
  );
});

test("gh pr create 含 footer → exit 0", () => {
  const r = run({
    tool_input: {
      command: 'gh pr create --title "my PR" --body "description\nRules: v6.16.0 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 0);
});

test("gh pr create 缺 footer → exit 1 + stderr Footer missing", () => {
  const r = run({
    tool_input: {
      command: 'gh pr create --title "my PR" --body "description only"',
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Footer missing/);
});

test("gh pr review --comment 含 footer → exit 0", () => {
  const r = run({
    tool_input: {
      command: 'gh pr review 42 --comment --body "looks good\nRules: v6.16.0 · Tool: test · Model: x"',
    },
  });
  assert.equal(r.code, 0);
});

test("gh issue comment 含空 body → exit 1", () => {
  const r = run({
    tool_input: {
      command: 'gh issue comment 1 --body ""',
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Footer missing/);
});

test("gh issue close --comment 含 footer → exit 0", () => {
  const r = run({ tool_input: { command: 'gh issue close 123 --comment "fixed\nRules: v6.16.0 · Tool: test · Model: x"' }});
  assert.equal(r.code, 0);
});

test("gh issue close --comment 缺 footer → exit 1", () => {
  const r = run({ tool_input: { command: 'gh issue close 123 --comment "fixed"' }});
  assert.equal(r.code, 1);
});

test("gh pr ready --comment 缺 footer → exit 1", () => {
  const r = run({ tool_input: { command: 'gh pr ready 456 --comment "ready for review"' }});
  assert.equal(r.code, 1);
});

test("gh release create --notes 缺 footer → exit 1", () => {
  const r = run({ tool_input: { command: 'gh release create v1.0 --notes "release notes"' }});
  assert.equal(r.code, 1);
});

test("gh pr edit --body 缺 footer → exit 1", () => {
  const r = run({ tool_input: { command: 'gh pr edit 789 --body "updated"' }});
  assert.equal(r.code, 1);
});

test("gh issue edit --body 缺 footer → exit 1", () => {
  const r = run({ tool_input: { command: 'gh issue edit 999 --body "updated"' }});
  assert.equal(r.code, 1);
});

test("gh pr review --approve --body 缺 footer → exit 1", () => {
  const r = run({ tool_input: { command: 'gh pr review 100 --approve --body "lgtm"' }});
  assert.equal(r.code, 1);
});

test("gh api POST .../comments 缺 footer → exit 1", () => {
  const r = run({ tool_input: { command: 'gh api -X POST repos/foo/bar/issues/1/comments -f body="text"' }});
  assert.equal(r.code, 1);
});

test("Footer Rules: v 但缺 Model: → exit 1", () => {
  const r = run({ tool_input: { command: 'gh issue create --body "text\nRules: v6.16.0"' }});
  assert.equal(r.code, 1);
});

test("Footer 僅含 Model 不含 Tool → exit 1", () => {
  const r = run({ tool_input: { command: 'gh issue create --body "text\nRules: v6.16.0 · Model: GPT-5"' }});
  assert.equal(r.code, 1);
  // Rules: + Model: co-occur same-line but Tool field missing → case B
  assert.match(r.stderr, /Tool/);
});

test("Footer 在 body 開頭非末尾 → exit 1", () => {
  const r = run({ tool_input: { command: 'gh issue create --body "Rules: v6.16.0 Model: x\n... body content"' }});
  assert.equal(r.code, 1);
});

test("--notes-file 含 footer → exit 0", () => {
  const tmp = path.join(os.tmpdir(), "gh-footer-gate-test-notes.txt");
  writeFileSync(tmp, "release notes\nRules: v6.16.0 · Tool: claude-code · Model: claude-sonnet");
  const r = run({ tool_input: { command: `gh release create v1.0 --notes-file ${tmp}` }});
  assert.equal(r.code, 0);
});

test("--notes-file missing file → exit 1 (fail-closed D3)", () => {
  const r = run({ tool_input: { command: "gh release create v1.0 --notes-file /tmp/nonexistent-gh-footer-test-file" }});
  assert.equal(r.code, 1);
  assert.match(r.stderr, /fail-closed/);
});

test("false positive: git log --grep 含 gh 字串 → exit 0", () => {
  const r = run({ tool_input: { command: 'git log --grep="gh issue create --body x"' }});
  assert.equal(r.code, 0);
});

test("false positive: shell var assign 含 gh 字串 → exit 0", () => {
  const r = run({ tool_input: { command: 'MSG="gh issue create --body foo"; echo $MSG' }});
  assert.equal(r.code, 0);
});

test("command-position: unquoted env value containing gh before the executable still gates", () => {
  const r = run({
    tool_input: { command: 'ROUTE=gh-prefix gh issue create --body "missing footer"' },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Footer missing/);
});

// ── Data-region gh-write literal must not trigger the gate (segment-aware) ──
// Regression for the footer-gate false positives observed across PR #1085/#1087/#1088
// flows: a `gh ... --body-file <path>` / `-F body=@<path>` literal that lives only
// as DATA (quoted-string arg, heredoc body, or -F message-file content) was mis-read
// as a real write-back → the hook tried to read the literal path → `body source read
// failed` fail-closed. The literal paths below point at a non-existent file; the
// PRE-FIX gate read them and exited 1 (fail-closed). The segment-aware gate must
// exit 0 (pass through). cross-ref: openspec spec.md §"Footer Gate Write-Back
// Detection Is Command-Segment Aware".
const GHLIT = "/tmp/nonexistent-gh-footer-data-region-literal";

test("data-region: git commit -m 含 gh-write 字面（引號內）→ exit 0", () => {
  const r = run({ tool_input: { command: `git commit -m "see gh pr create --body-file ${GHLIT} for an example"` }});
  assert.equal(r.code, 0, `quoted gh-write literal must not trigger footer gate; stderr=${r.stderr}`);
});

test("data-region: cat > file <<EOF 含 gh-write 字面（heredoc body）→ exit 0", () => {
  const r = run({ tool_input: { command: `cat > /tmp/notes-xyz.txt <<EOF\ngh pr comment --body-file ${GHLIT}\nEOF` }});
  assert.equal(r.code, 0, `heredoc-body gh-write literal must not trigger footer gate; stderr=${r.stderr}`);
});

test("data-region: git commit -m 含 -F body=@ 字面（引號內）→ exit 0", () => {
  const r = run({ tool_input: { command: `git commit -m "reviewer uses gh api -X PATCH -F body=@${GHLIT} to write sticky"` }});
  assert.equal(r.code, 0, `quoted -F body=@ literal must not trigger footer gate; stderr=${r.stderr}`);
});

test("data-region: 多個 -m 之一含 gh-write 字面 → exit 0", () => {
  const r = run({ tool_input: { command: `git commit -m "subject" -m "body 提到 gh pr create --body-file ${GHLIT}" -m "Rules: v6.66.4 · Tool: x · Model: y"` }});
  assert.equal(r.code, 0, `gh-write literal in one of multiple -m must not trigger footer gate; stderr=${r.stderr}`);
});

// Positive guard: a GENUINE gh write-back with command-owned heredoc body still triggers.
test("genuine gh write-back heredoc body 缺 footer 仍 block（無回歸）", () => {
  const r = run({ tool_input: { command: `gh pr create --title t --body-file - <<EOF\nbody without footer\nEOF` }});
  assert.equal(r.code, 1, `real gh write-back with footerless heredoc body must still block; stderr=${r.stderr}`);
});

test("--body=value 等號形式含 footer → exit 0", () => {
  const r = run({ tool_input: { command: 'gh issue create --body="content\nRules: v6.16.0 · Tool: test · Model: x"' }});
  assert.equal(r.code, 0);
});

test("--body=value 等號形式缺 footer → exit 1", () => {
  const r = run({ tool_input: { command: 'gh issue create --body="content without footer"' }});
  assert.equal(r.code, 1);
});

test("--body-file /tmp/nonexistent → exit 1 (fail-closed D3)", () => {
  const r = run({ tool_input: { command: "gh issue create --body-file /tmp/nonexistent-gh-footer-test-body" }});
  assert.equal(r.code, 1);
  assert.match(r.stderr, /fail-closed/);
});

test("mixed --body 含 footer + --body-file missing → exit 1 (strict fail-closed)", () => {
  const r = run({
    tool_input: {
      command: 'gh issue create --body "valid Rules: v6.16.0 Model: x" --body-file /tmp/nonexistent-gh-mixed',
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /fail-closed/);
});

// ── subshell/變數展開的 --body-file 路徑：read-fail 通用引導（不限 runtime）──
// PreToolUse 在 shell 執行前讀檔，resolveBodyPath 拿到的是未展開字面（如
// `$(pwd)/notes/tmp/<unique>.md`），path.resolve 後找不到 → read-fail。本 session 建 PR #1163
// 時即在本 host（非 Codex）實地踩到。read-failed 通用 reason 須含「shell 展開路徑 →
// 改用字面絕對路徑」的成因 (d)，對所有 runtime 一致顯示（與 Codex-only diagnostic
// 後綴互補）。fail-closed（block）不變，只強化通用 reason 文字。

// 非 Codex runtime + $(pwd) 展開路徑 → block 且通用 reason 含 shell-展開/字面絕對路徑引導
test("subshell-path: 非 Codex + --body-file \"$(pwd)/notes/tmp/<unique>.md\" → block + reason 含字面絕對路徑引導", () => {
  const r = run(
    { tool_input: { command: 'gh pr create --title t --body-file "$(pwd)/notes/tmp/remove-gh-body-pr-body-1234.md"' } },
    { CODEX_CI: "", CODEX_THREAD_ID: "" }
  );
  assert.equal(r.code, 1, `subshell-path read-fail must fail-closed; stderr=${r.stderr}`);
  assert.match(r.stderr, /fail-closed/, `must remain fail-closed; stderr=${r.stderr}`);
  assert.match(
    r.stderr,
    /shell 展開|字面絕對路徑/,
    `read-fail reason must steer away from shell-expanded body-file paths toward a literal absolute path; stderr=${r.stderr}`
  );
});

// 回歸：absolute 字面路徑 read-fail 仍 block（成因 (d) 不取代既有 fail-closed）
test("subshell-path 回歸: 非 Codex + absolute literal missing → 仍 block (fail-closed 不變)", () => {
  const r = run(
    { tool_input: { command: "gh pr create --title t --body-file /tmp/nonexistent-gh-subshell-regress" } },
    { CODEX_CI: "", CODEX_THREAD_ID: "" }
  );
  assert.equal(r.code, 1);
  assert.match(r.stderr, /fail-closed/);
});

// ── issue #1158: Codex 缺 cwd + 相對 --body-file → read-failed block 附 Codex diagnostic ──
// Codex runtime 不送 cwd/workdir 至 hook payload；resolveBodyPath 退回 process.cwd()
// (= session-start main worktree) 解析相對路徑 → 檔案不存在 → read-failed block。
// 該 block reason 須對 Codex 缺 cwd 的真成因給針對性引導（改 main-checkout
// notes/tmp absolute path），而非只給泛用「先以獨立 Bash 寫入」訊息，否則 agent 在 Codex host
// 重複踩同一相對路徑。fail-closed 行為（block / decision）不變，只強化 reason 文字。
// Codex runtime 下 block 走 JSON { decision:"block", reason }（gh-footer-gate.mjs:73）。

// (a) Codex + payload 無 cwd + 相對 missing body-file → block 且 reason 含 main-checkout notes/tmp absolute 引導
// Fixture 用保證任何 cwd 皆不存在的相對檔名。**不可**用 `.pr-body.md`：在剛建過 PR
// 的 worktree root 該檔真的存在 → resolveBodyPath 解析得到 → 不 block → test 隨 cwd
// 狀態偽 fail（本 session 在 .worktree 內踩到此脆弱性）。相對路徑語意（觸發 Codex
// worktree-absolute 引導）與檔名無關，只要相對且解析後不存在即成立。
test("issue#1158 (a) Codex 缺 cwd + 相對 --body-file missing → block + reason 含 notes/tmp absolute 引導", () => {
  const r = run(
    { tool_input: { command: "gh pr create --title t --body-file .devpro-nonexistent-body-fixture.md" } },
    { CODEX_CI: "1" }
  );
  assert.equal(r.json?.decision, "block", `Codex runtime read-fail must JSON-block; stdout=${r.stdout}`);
  assert.match(r.json.reason, /notes\/tmp/, `reason must mention main-checkout notes/tmp path; reason=${r.json.reason}`);
  assert.match(
    r.json.reason,
    /絕對路徑|absolute/,
    `reason must steer Codex toward an absolute notes/tmp path; reason=${r.json.reason}`
  );
});

// (b) 非 Codex runtime 同命令 → block 但 reason 不含 Codex diagnostic（避免 over-fire）
test("issue#1158 (b) 非 Codex + 相對 --body-file missing → block 但 reason 不含 Codex 相對路徑 diagnostic", () => {
  const r = run(
    { tool_input: { command: "gh pr create --title t --body-file .devpro-nonexistent-body-fixture.md" } },
    { CODEX_CI: "", CODEX_THREAD_ID: "" }
  );
  assert.equal(r.code, 1, `non-Codex read-fail must still fail-closed; stderr=${r.stderr}`);
  assert.doesNotMatch(
    r.stderr,
    /Codex 缺 cwd/,
    `non-Codex read-fail must NOT carry the Codex cwd diagnostic; stderr=${r.stderr}`
  );
});

// (c) Codex + absolute path missing → block 但 reason 不含「相對路徑」diagnostic（成因非 cwd absence）
test("issue#1158 (c) Codex + absolute --body-file missing → block 但 reason 不含相對路徑 diagnostic", () => {
  const r = run(
    { tool_input: { command: "gh pr create --title t --body-file /tmp/nonexistent-gh-1158c" } },
    { CODEX_CI: "1" }
  );
  assert.equal(r.json?.decision, "block", `Codex runtime read-fail must JSON-block; stdout=${r.stdout}`);
  assert.doesNotMatch(
    r.json.reason,
    /Codex 缺 cwd/,
    `absolute-path read-fail is not a cwd-resolution cause; reason must not carry the diagnostic; reason=${r.json.reason}`
  );
});

// (d) Codex + payload 帶 cwd + 相對 missing → block 但 reason 不含 diagnostic（有 cwd 就非該成因）
test("issue#1158 (d) Codex + payload 帶 cwd + 相對 --body-file missing → block 但 reason 不含 cwd-absence diagnostic", () => {
  const r = run(
    { tool_input: { command: "gh pr create --title t --body-file notes/tmp/remove-gh-body-pr-body-1234.md", cwd: "/tmp" } },
    { CODEX_CI: "1" }
  );
  assert.equal(r.json?.decision, "block", `Codex runtime read-fail must JSON-block; stdout=${r.stdout}`);
  assert.doesNotMatch(
    r.json.reason,
    /Codex 缺 cwd/,
    `payload carried cwd, so cwd-absence is not the cause; reason must not carry the diagnostic; reason=${r.json.reason}`
  );
});

test("issue#1193 Codex + tool_input.workdir + relative notes/tmp body-file resolves from main-checkout workdir despite stale hook cwd", () => {
  const staleWorktree = makeTempRepo("# AI Agent\n\n版本：6.70.0\n");
  const mainCheckout = makeTempRepo("# AI Agent\n\n版本：6.70.0\n");
  try {
    mkdirSync(path.join(mainCheckout.dir, "notes", "tmp"), { recursive: true });
    writeFileSync(
      path.join(mainCheckout.dir, "notes", "tmp", "remove-gh-body-pr-body-1193a.md"),
      "## Summary\n- workdir body\n\nRules: v6.70.0 · Tool: codex · Model: gpt-5"
    );
    const result = spawnSync("node", [HOOK], {
      input: JSON.stringify({
        tool_input: {
          command: "gh pr create --title t --body-file notes/tmp/remove-gh-body-pr-body-1193a.md",
          workdir: mainCheckout.dir,
        },
      }),
      encoding: "utf8",
      cwd: staleWorktree.dir,
      env: { ...process.env, CODEX_CI: "1", CODEX_THREAD_ID: "" },
    });
    assert.equal(result.status, 0, `relative body-file should resolve from tool_input.workdir; stdout=${result.stdout}; stderr=${result.stderr}`);
    assert.equal(result.stdout, "");
  } finally {
    staleWorktree.cleanup();
    mainCheckout.cleanup();
  }
});

test("issue#1193 exact Codex exec payload: tool_input.cmd + main-checkout workdir + relative notes/tmp --body-file passes from stale hook cwd", () => {
  const staleWorktree = makeTempRepo("# AI Agent\n\n版本：6.70.0\n");
  const mainCheckout = makeTempRepo("# AI Agent\n\n版本：6.70.0\n");
  try {
    mkdirSync(path.join(mainCheckout.dir, "notes", "tmp"), { recursive: true });
    writeFileSync(
      path.join(mainCheckout.dir, "notes", "tmp", "remove-gh-body-pr-body-1193b.md"),
      "## Summary\n- exact Codex payload body\n\nRules: v6.70.0 · Tool: codex · Model: gpt-5"
    );
    const result = spawnSync("node", [HOOK], {
      input: JSON.stringify({
        tool_input: {
          cmd: "gh pr create --title t --body-file notes/tmp/remove-gh-body-pr-body-1193b.md",
          workdir: mainCheckout.dir,
        },
      }),
      encoding: "utf8",
      cwd: staleWorktree.dir,
      env: { ...process.env, CODEX_CI: "1", CODEX_THREAD_ID: "" },
    });
    assert.equal(result.status, 0, `exact Codex payload should pass; stdout=${result.stdout}; stderr=${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    staleWorktree.cleanup();
    mainCheckout.cleanup();
  }
});

test("issue#1193 Codex + top-level workdir + relative notes/tmp --body-file resolves from main-checkout workdir despite stale hook cwd", () => {
  const staleWorktree = makeTempRepo("# AI Agent\n\n版本：6.70.0\n");
  const mainCheckout = makeTempRepo("# AI Agent\n\n版本：6.70.0\n");
  try {
    mkdirSync(path.join(mainCheckout.dir, "notes", "tmp"), { recursive: true });
    writeFileSync(
      path.join(mainCheckout.dir, "notes", "tmp", "remove-gh-body-pr-body-1193c.md"),
      "## Summary\n- top-level workdir body\n\nRules: v6.70.0 · Tool: codex · Model: gpt-5"
    );
    const result = spawnSync("node", [HOOK], {
      input: JSON.stringify({
        tool_input: {
          command: "gh pr create --title t --body-file notes/tmp/remove-gh-body-pr-body-1193c.md",
        },
        workdir: mainCheckout.dir,
      }),
      encoding: "utf8",
      cwd: staleWorktree.dir,
      env: { ...process.env, CODEX_CI: "1", CODEX_THREAD_ID: "" },
    });
    assert.equal(result.status, 0, `relative body-file should resolve from top-level workdir; stdout=${result.stdout}; stderr=${result.stderr}`);
    assert.equal(result.stdout, "");
  } finally {
    staleWorktree.cleanup();
    mainCheckout.cleanup();
  }
});

// (e) Codex + cwd absent + 相對 body source 但 read-fail 成因是 size-cap（檔案存在但 >1MB）
// → block 但 reason 不含 cwd diagnostic：size 失敗的成因是大小、非 cwd resolution，
// diagnostic 建議「改 absolute path」對 size 問題 vacuous。spawn cwd 指到 tmp dir（使
// process.cwd() = 該 dir）、payload 不帶 cwd（cwd-absence 成立）、相對 oversized 檔名。
// 驗證 size-cap 分支不設 readFailedRelativePath（cross-review suggestion 精修）。
test("issue#1158 (e) Codex + cwd absent + 相對 oversized body（size-cap）→ block 但 reason 不含 cwd diagnostic", () => {
  const dir = makeTempDir("gh-footer-1158e-");
  try {
    writeFileSync(path.join(dir, "big.md"), "x".repeat(2 * 1024 * 1024)); // >1MB
    const result = spawnSync("node", [HOOK], {
      input: JSON.stringify({ tool_input: { command: "gh pr create -F body=@big.md --title t" } }),
      encoding: "utf8",
      cwd: dir,
      env: { ...process.env, CODEX_CI: "1", CODEX_THREAD_ID: "" },
    });
    let json = null;
    try { json = JSON.parse(result.stdout); } catch {}
    assert.equal(json?.decision, "block", `size-cap read-fail must JSON-block; stdout=${result.stdout}`);
    assert.doesNotMatch(
      json.reason,
      /Codex 缺 cwd/,
      `size-cap (file exists, too large) is not a cwd-resolution cause; reason must not carry the diagnostic; reason=${json.reason}`
    );
  } finally {
    rmSyncFs(dir, { recursive: true, force: true });
  }
});

test("含 attribution '🤖 Generated with [Claude Code]' before footer → exit 1 + stderr Attribution forbidden", () => {
  const r = run({
    tool_input: {
      command: 'gh issue create --body "fix bug\n\n🤖 Generated with [Claude Code]\n\nRules: v6.22.0 · Tool: Claude Code · Model: Opus 4.7"',
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Attribution forbidden/);
});

test("含 attribution '🤖 Generated with Claude' (no brackets) before footer → exit 1", () => {
  const r = run({
    tool_input: {
      command: 'gh issue create --body "x\n\n🤖 Generated with Claude\n\nRules: v6.22.0 · Tool: Claude Code · Model: Opus 4.7"',
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Attribution forbidden/);
});

test("含 attribution 'Co-Authored-By: Claude Opus 4.7' before footer → exit 1", () => {
  const r = run({
    tool_input: {
      command: 'gh pr create --title "PR" --body "summary\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>\n\nRules: v6.22.0 · Tool: Claude Code · Model: Opus 4.7"',
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Attribution forbidden/);
});

test("含 footer + 不含 attribution → exit 0 (regression baseline)", () => {
  const r = run({
    tool_input: {
      command: 'gh issue create --body "fix bug\n\nRules: v6.22.0 · Tool: Claude Code · Model: Opus 4.7"',
    },
  });
  assert.equal(r.code, 0);
});

test("gh api graphql -f body= 含 footer 不含 attribution → exit 0", () => {
  const r = run({
    tool_input: {
      command: `gh api graphql -f query='mutation{createDiscussion(input:{title:"x"}){discussion{url}}}' -f body="content\nRules: v6.22.0 · Tool: Claude Code · Model: Opus 4.7"`,
    },
  });
  assert.equal(r.code, 0);
});

test("legitimate 🤖 emoji not followed by 'Generated with' or 'Claude' → exit 0 (no false positive)", () => {
  const r = run({
    tool_input: {
      command: 'gh issue create --body "the 🤖 robot face emoji is unicode U+1F916\n\nRules: v6.22.0 · Tool: Claude Code · Model: Opus 4.7"',
    },
  });
  assert.equal(r.code, 0);
});

test("legacy 單行 'Rules ... Model: Claude Code / Opus 4.7' → exit 0", () => {
  const r = run({
    tool_input: {
      command: 'gh issue create --body "fix bug\n\nRules: v6.22.0 · Model: Claude Code / Opus 4.7"',
    },
  });
  assert.equal(r.code, 0);
});

test("legacy 多行 'Rules\\nModel: tool / model' → exit 1 (multi-line rejected)", () => {
  const r = run({
    tool_input: {
      command: 'gh issue create --body "fix bug\n\nRules: v6.22.0\nModel: Claude Code / Opus 4.7"',
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Footer missing/);
});

test("legacy multi-word Model + attribution before footer → exit 1 (Attribution forbidden)", () => {
  const r = run({
    tool_input: {
      command: 'gh pr create --body "fix bug\n\n🤖 Generated with [Claude Code]\n\nRules: v6.22.0 · Model: Claude Code / Opus 4.7"',
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Attribution forbidden/);
});

test("Rules+Model 同行寫在 body 中段（非 tail）→ exit 1 + Footer position reason", () => {
  // Rules: v6.34.5 · Tool: claude-code · Model: opus is in middle, body continues after
  const r = run({
    tool_input: {
      command: 'gh issue create --body "intro\nRules: v6.34.5 · Tool: claude-code · Model: opus\n\nbody continues after footer line"',
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /已偵測到 Rules: 字串/);
});

test("body 完全無 Rules: footer → exit 1 + Footer missing 完全不含 reason", () => {
  const r = run({
    tool_input: {
      command: 'gh issue create --body "this body has no attribution footer at all"',
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Footer missing:.*完全不含 Rules: footer/);
});

// ── GFG-1: inline DEVPRO_HOOK_BYPASS=1 bypass ───────────────────────────────
test("GFG-1: inline DEVPRO_HOOK_BYPASS=1 + missing footer → exit 0 (bypass)", () => {
  const r = run(
    { tool_input: { command: 'DEVPRO_HOOK_BYPASS=1 gh pr create --title "t" --body "no footer here"' } }
  );
  assert.equal(r.code, 0);
});

// ── GFG-2: -F body="$(cat <file>)" with valid footer ─────────────────────────
test('GFG-2: -F body="$(cat <file>)" with valid footer → exit 0', () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg2-${Date.now()}.md`);
  writeFileSync(tmp, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const r = run({ tool_input: { command: `gh pr create -F body="$(cat ${tmp})" --title t` } });
  assert.equal(r.code, 0);
});

// ── GFG-3: -F body=$(cat <file>) unquoted, footer missing → block ─────────────
test("GFG-3: -F body=$(cat <file>) unquoted, footer missing → exit 1", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg3-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({ tool_input: { command: `gh pr create -F body=$(cat ${tmp}) --title t` } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Footer missing/);
});

// ── GFG-4: -F body="$(cat <missing>)" → block (fail-closed) ──────────────────
test('GFG-4: -F body="$(cat <missing>)" missing file → exit 1 (fail-closed D3)', () => {
  const r = run({
    tool_input: {
      command: 'gh pr create -F body="$(cat /tmp/nonexistent-gh-footer-gate-gfg4)" --title t',
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /fail-closed/);
});

// ── GFG-5: oversized file → block ────────────────────────────────────────────
test("GFG-5: -F body=$(cat <oversized>) 2MB file → exit 1 (size cap)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg5-${Date.now()}.md`);
  // Write 2MB of content (over the 1MB limit)
  writeFileSync(tmp, "x".repeat(2 * 1024 * 1024));
  const r = run({ tool_input: { command: `gh pr create -F body=$(cat ${tmp}) --title t` } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /fail-closed/);
});

// ── GFG-6/7/8: forbidden attribution patterns (valid footer present) ──────────
test("GFG-6: 🤖 Generated with [Claude Code] in body (with valid footer) → exit 1 (Attribution forbidden)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg6-${Date.now()}.md`);
  writeFileSync(tmp, "desc\n\n🤖 Generated with [Claude Code]\n\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const r = run({ tool_input: { command: `gh pr create -F body="$(cat ${tmp})" --title t` } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Attribution forbidden/);
});

test("GFG-7: Generated with [Claude Code] (no emoji) in body (with valid footer) → exit 1 (Attribution forbidden)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg7-${Date.now()}.md`);
  writeFileSync(tmp, "desc\n\nGenerated with [Claude Code]\n\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const r = run({ tool_input: { command: `gh pr create -F body="$(cat ${tmp})" --title t` } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Attribution forbidden/);
});

test("GFG-8: Co-Authored-By: Claude in body (with valid footer) → exit 1 (Attribution forbidden)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg8-${Date.now()}.md`);
  writeFileSync(tmp, "desc\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>\n\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const r = run({ tool_input: { command: `gh pr create -F body="$(cat ${tmp})" --title t` } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Attribution forbidden/);
});

// ── GFG-8b: Co-authored-by: Cursor (issue #1913) → Attribution forbidden ─────
test("GFG-8b: Co-authored-by: Cursor <cursoragent@cursor.com> in --body (with valid footer) → exit 1 (Attribution forbidden)", () => {
  const r = run({
    tool_input: {
      command: 'gh pr create --title "PR" --body "summary\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\n\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Attribution forbidden/);
});

test("GFG-8b: Co-authored-by: Cursor <cursoragent@cursor.com> in --body-file (with valid footer) → exit 1 (Attribution forbidden)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg8b-cursor-${Date.now()}.md`);
  writeFileSync(tmp, "desc\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\n\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const r = run({ tool_input: { command: `gh pr create --body-file ${tmp} --title t` } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Attribution forbidden/);
});

// ── GFG-8c: human Co-Authored-By controls (Jane / Devin / Cody) → exit 0 ─────
test("GFG-8c: Co-Authored-By: Jane Doe <jane@example.com> in body (with valid footer) → exit 0", () => {
  const r = run({
    tool_input: {
      command: 'gh issue create --body "fix bug\n\nCo-Authored-By: Jane Doe <jane@example.com>\n\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 0);
});

test("GFG-8c: Co-Authored-By: Devin Smith <devin.smith@example.com> in body (with valid footer) → exit 0", () => {
  const r = run({
    tool_input: {
      command: 'gh issue create --body "fix bug\n\nCo-Authored-By: Devin Smith <devin.smith@example.com>\n\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 0);
});

test("GFG-8c: Co-Authored-By: Cody Lee <cody.lee@example.com> in body (with valid footer) → exit 0", () => {
  const r = run({
    tool_input: {
      command: 'gh issue create --body "fix bug\n\nCo-Authored-By: Cody Lee <cody.lee@example.com>\n\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 0);
});

// ── GFG-9: regression — --body-file <path> with valid footer → exit 0 ────────
test("GFG-9: regression --body-file <path> with valid footer → exit 0", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg9-${Date.now()}.md`);
  writeFileSync(tmp, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const r = run({ tool_input: { command: `gh pr create --body-file ${tmp} --title t` } });
  assert.equal(r.code, 0);
});

// ── GFG-10..19: GitHub CLI long field-flag parity ───────────────────────────
test("GFG-10: --raw-field body=<missing footer> → exit 1", () => {
  const r = run({
    tool_input: { command: 'gh pr create --raw-field body="description without footer" --title t' },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Footer missing/);
});

test("GFG-11: --raw-field body=<valid footer> → exit 0", () => {
  const r = run({
    tool_input: {
      command: 'gh pr create --raw-field body="description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet" --title t',
    },
  });
  assert.equal(r.code, 0);
});

test('GFG-11a: --raw-field "body=<missing footer>" → exit 1', () => {
  const r = run({
    tool_input: { command: 'gh pr create --raw-field "body=description without footer" --title t' },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Footer missing/);
});

test("GFG-11b: --raw-field 'body=<valid footer>' → exit 0", () => {
  const r = run({
    tool_input: {
      command: "gh pr create --raw-field 'body=description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet' --title t",
    },
  });
  assert.equal(r.code, 0);
});

test("GFG-12: --field body=@<file> without footer → exit 1", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg12-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({ tool_input: { command: `gh pr create --field body=@${tmp} --title t` } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Footer missing/);
});

test('GFG-12a: --field "body=@<file>" without footer → exit 1', () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg12a-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({ tool_input: { command: `gh pr create --field "body=@${tmp}" --title t` } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Footer missing/);
});

test("GFG-13: --field body=@<file> with valid footer → exit 0", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg13-${Date.now()}.md`);
  writeFileSync(tmp, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const r = run({ tool_input: { command: `gh pr create --field body=@${tmp} --title t` } });
  assert.equal(r.code, 0);
});

test('GFG-14: --field body="$(cat <file>)" with valid footer → exit 0', () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg14-${Date.now()}.md`);
  writeFileSync(tmp, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const r = run({
    tool_input: { command: `gh pr create --field body="$(cat ${tmp})" --title t` },
  });
  assert.equal(r.code, 0);
});

test("GFG-15: --field body=<unsupported typed value> → exit 1 (fail closed)", () => {
  const r = run({ tool_input: { command: "gh pr create --field body=description --title t" } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unsupported typed.*fail-closed/i);
});

test('GFG-15a: --field "body=<unsupported typed value>" → exit 1 (fail closed)', () => {
  const r = run({ tool_input: { command: 'gh pr create --field "body=description" --title t' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unsupported typed.*fail-closed/i);
});

test("GFG-16: --field body=@<missing file> → exit 1 (fail closed)", () => {
  const r = run({
    tool_input: {
      command: "gh pr create --field body=@/tmp/nonexistent-gh-footer-gate-gfg16 --title t",
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /fail-closed/);
});

test("GFG-17: long field literals in gh command data region → exit 0", () => {
  const r = run({
    tool_input: {
      command:
        'gh pr create --title "document --field body=@missing-example and --raw-field body=missing"',
    },
  });
  assert.equal(r.code, 0);
});

test("GFG-17a: quoted raw-field literal in gh command data region → exit 0", () => {
  const r = run({
    tool_input: {
      command:
        "gh pr create --title 'document --raw-field \"body=missing footer\" as example'",
    },
  });
  assert.equal(r.code, 0);
});

test("GFG-18: --field body=@<oversized file> → exit 1 (size cap)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg18-${Date.now()}.md`);
  writeFileSync(tmp, "x".repeat(2 * 1024 * 1024));
  const r = run({ tool_input: { command: `gh pr create --field body=@${tmp} --title t` } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /fail-closed/);
});

test("GFG-19: unsupported typed --field blocks even with a valid body carrier", () => {
  const r = run({
    tool_input: {
      command:
        'gh api graphql --raw-field body="description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet" --field body=typed-without-footer',
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unsupported typed.*fail-closed/i);
});

// ── GFG-20..26 (T6/T39/T40, R3): gh-subcommand-aware bare `-F <path>` alias ─
// gh's own `-F, --body-file <file>` (or `--notes-file` on release) short
// alias is bare `-F` on the write-back subcommands this hook recognizes
// (GH_BARE_F_SUBCOMMANDS — see that Set's doc comment in gh-footer-gate.mjs
// for the current 11-item membership and its derivation). This is a
// DIFFERENT semantic than `gh api`'s `-F, --field <key>=<value>` (which the
// hook already audits via F_FILE_ARG_RE/F_FILE_PRESENCE_RE). T6 proved the
// bare-path alias form was undetected (RED) and T7 fixed it for the
// original 8 subcommands; T39 (round-7 dp-reviewer I-1) extended the
// allow-list to also cover `pr review`/`pr merge` (GFG-24/25); T40 (round-8
// dp-reviewer C-1) added `pr revert` (GFG-25b) and, per round-8's I-B, added
// a completeness invariant (GFG-26) covering every declared member instead
// of only the subcommands each round's finding happened to name.
test("GFG-20 (T6 RED): gh pr create -F <path> missing footer → exit 1", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg20-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({ tool_input: { command: `gh pr create -F ${tmp} --title t` } });
  assert.equal(r.code, 1, `bare -F <path> on pr create MUST be audited; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Footer missing/);
});

test("GFG-21 (negative, stays green): gh api -F body=@<file> valid/missing footer unaffected", () => {
  const tmpValid = path.join(os.tmpdir(), `gh-footer-gate-gfg21-valid-${Date.now()}.md`);
  writeFileSync(tmpValid, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const rValid = run({ tool_input: { command: `gh api repos/o/r/issues -F body=@${tmpValid}` } });
  assert.equal(rValid.code, 0, `gh api -F body=@<valid> must stay exit 0; stderr=${rValid.stderr}`);

  const tmpMissing = path.join(os.tmpdir(), `gh-footer-gate-gfg21-missing-${Date.now()}.md`);
  writeFileSync(tmpMissing, "description without footer");
  const rMissing = run({ tool_input: { command: `gh api repos/o/r/issues -F body=@${tmpMissing}` } });
  assert.equal(rMissing.code, 1, `gh api -F body=@<missing> must stay exit 1; stderr=${rMissing.stderr}`);
  assert.match(rMissing.stderr, /Footer missing/);
});

test("Human review API command shape: strict footer preflight and credential detection are separate", (t) => {
  const dir = makeTempDir("human-review-footer-");
  t.after(() => rmSyncFs(dir, { recursive: true, force: true }));
  const bodyFile = path.join(dir, "draft.md");
  const version = "1.2.3";
  const repo = makeTempRepo(`# AI Agent\n\n版本：${version}\n`);
  t.after(repo.cleanup);
  const footer = `\nRules: v${version} · Tool: Codex · Model: GPT-6\n`;
  const args = ["--strict-exit", "--", "gh", "api", "--method", "POST", "repos/example-team/forms/pulls/42/reviews", "-f", "event=COMMENT", "-f", `commit_id=${"a".repeat(40)}`, "-F", `body=@${bodyFile}`];
  const validate = (body) => {
    writeFileSync(bodyFile, body);
    return evaluateGhFooterGate({ rawArgs: args, cwd: repo.dir, env: repo.env, writeStdout: () => {}, writeStderr: () => {} });
  };
  assert.equal(validate("draft without footer"), 1);
  assert.equal(validate("safe draft" + footer), 0);
  const fake = "pass" + "word=synthetic-fixture-not-a-real-secret" + footer;
  assert.equal(validate(fake), 0);
  assert.equal(assertStickyBodyCredentialFree(fake).ok, false);
});

test("GFG-22 (negative, stays green): gh api -F labels=bug is not a body-file surface", () => {
  const r = run({ tool_input: { command: "gh api repos/o/r/issues -F labels=bug" } });
  assert.equal(r.code, 0, `-F labels=bug must not be treated as a bare body-file path; stderr=${r.stderr}`);
});

test("GFG-23 (negative, stays green): DATA-region literal '-F <path>' in commit message is not audited", () => {
  const r = run({
    tool_input: { command: 'git commit -m "document gh pr create -F ./payload.txt usage"' },
  });
  assert.equal(r.code, 0, `DATA-region literal must not trigger the write-back gate; stderr=${r.stderr}`);
});

test("GFG-24 (T39, round-7 I-1): gh pr review --approve -F <path> missing footer → exit 1", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg24-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({ tool_input: { command: `gh pr review --approve -F ${tmp}` } });
  assert.equal(r.code, 1, `bare -F <path> on pr review MUST be audited; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Footer missing/);
});

test("GFG-25 (T39, round-7 I-1): gh pr merge --squash -F <path> missing footer → exit 1", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg25-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({ tool_input: { command: `gh pr merge --squash -F ${tmp}` } });
  assert.equal(r.code, 1, `bare -F <path> on pr merge MUST be audited; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Footer missing/);
});

test("GFG-25b (T40, round-8 C-1): gh pr revert -F <path> missing footer → exit 1", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg25b-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({ tool_input: { command: `gh pr revert 1 -F ${tmp}` } });
  assert.equal(r.code, 1, `bare -F <path> on pr revert MUST be audited; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Footer missing/);
});

// ── GFG-26 (T40, round-8 I-B): completeness invariant, not just named instances ──
// GFG-20/24/25/25b prove-it individual subcommands as each gap was found by a
// separate review round (T6, round-7 I-1, round-8 C-1) — exactly the pattern
// round 8's reviewer flagged as "locking instances, not an invariant": every
// prior round only exercised the subcommands its own finding named, so a gap
// in an untested member (or an as-yet-undiscovered one) could sit unnoticed
// indefinitely. This test instead (a) extracts the ACTUAL declared
// GH_BARE_F_SUBCOMMANDS Set from source and pins it against the canonical
// 11-item set this session mechanically derived from `gh 2.89.0 --help`
// (see the Set's own doc comment in gh-footer-gate.mjs for the exact
// regeneration recipe), so an accidental edit to the Set is caught even if
// no individual prove-it test names the changed entry; and (b) behaviorally
// exercises bare -F gating for EVERY declared member, not a hand-picked
// subset, so a future member added to the Set without matching detection
// logic (or a member whose gating silently breaks) fails here regardless of
// which entry it is.
const EXPECTED_GH_BARE_F_SUBCOMMANDS = [
  "pr create", "pr edit", "pr comment", "pr review", "pr merge", "pr revert",
  "issue create", "issue edit", "issue comment",
  "release create", "release edit",
];

function declaredGhBareFSubcommands() {
  const src = readFileSync(HOOK, "utf8");
  const m = src.match(/const GH_BARE_F_SUBCOMMANDS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m, "GH_BARE_F_SUBCOMMANDS Set literal not found in gh-footer-gate.mjs");
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.slice(1, -1));
}

test("GFG-26a: GH_BARE_F_SUBCOMMANDS matches the mechanically-derived gh 2.89.0 body/notes-file surface", () => {
  const declared = declaredGhBareFSubcommands();
  assert.deepEqual(
    [...declared].sort(),
    [...EXPECTED_GH_BARE_F_SUBCOMMANDS].sort(),
    "GH_BARE_F_SUBCOMMANDS drifted from the mechanically-derived surface — re-run the regeneration recipe in the Set's doc comment and update both this test and decisions.md"
  );
});

for (const subcommand of EXPECTED_GH_BARE_F_SUBCOMMANDS) {
  test(`GFG-26b: bare -F <path> missing footer → exit 1 for every declared member ("${subcommand}")`, () => {
    const tmp = path.join(
      os.tmpdir(),
      `gh-footer-gate-gfg26-${subcommand.replace(/\s+/g, "-")}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.md`
    );
    writeFileSync(tmp, "description without footer");
    const extraArg = { "pr edit": "789", "pr comment": "99", "pr revert": "1", "issue edit": "999", "issue comment": "1", "release create": "v1.0", "release edit": "v1.0" }[subcommand] ?? "";
    const r = run({ tool_input: { command: `gh ${subcommand} ${extraArg} -F ${tmp}`.replace(/\s+/g, " ").trim() } });
    assert.equal(r.code, 1, `bare -F <path> on "${subcommand}" MUST be audited; stdout=${r.stdout}; stderr=${r.stderr}`);
    assert.match(r.stderr, /Footer missing/);
  });
}

// ── GFG-27..31 (C-1, round 11): -b/-n/-t(--subject)/-T(--template) short-flag
// and new-surface detection, mirroring the GFG-20..26 bare -F alias pattern
// above. dp-reviewer round-11 C-1 found WRITEBACK_FLAG_RE completely lacked a
// short-flag alternation for -b/-n/-t/-T — an exploitable bypass across 11+ gh
// subcommands, including a genuine attribution-brand-leak repro via
// `pr merge -t`. Each Set below is mechanically re-derived from `gh <cmd>
// --help` (same method as GH_BARE_F_SUBCOMMANDS) and is deliberately
// independent from it, per the round-12 "全量根治修復" design decision.
const EXPECTED_BODY_SHORT_FLAG_SUBCOMMANDS = [
  "pr create", "pr edit", "pr comment", "pr review", "pr merge", "pr revert",
  "issue create", "issue edit", "issue comment",
];
const EXPECTED_NOTES_SHORT_FLAG_SUBCOMMANDS = ["release create", "release edit"];
const EXPECTED_SUBJECT_FLAG_SUBCOMMANDS = ["pr merge"];
const EXPECTED_TEMPLATE_FLAG_SUBCOMMANDS = ["pr create", "issue create"];

function declaredSubcommandSet(setName) {
  const src = readFileSync(HOOK, "utf8");
  const re = new RegExp(`const ${setName} = new Set\\(\\[([\\s\\S]*?)\\]\\);`);
  const m = src.match(re);
  assert.ok(m, `${setName} Set literal not found in gh-footer-gate.mjs`);
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.slice(1, -1));
}

test("GFG-27a: BODY_SHORT_FLAG_SUBCOMMANDS matches the mechanically-derived -b surface", () => {
  assert.deepEqual(
    [...declaredSubcommandSet("BODY_SHORT_FLAG_SUBCOMMANDS")].sort(),
    [...EXPECTED_BODY_SHORT_FLAG_SUBCOMMANDS].sort(),
    "BODY_SHORT_FLAG_SUBCOMMANDS drifted — re-run the gh --help enumeration and update both this test and decisions.md"
  );
});

test("GFG-27b: NOTES_SHORT_FLAG_SUBCOMMANDS matches the mechanically-derived -n surface", () => {
  assert.deepEqual(
    [...declaredSubcommandSet("NOTES_SHORT_FLAG_SUBCOMMANDS")].sort(),
    [...EXPECTED_NOTES_SHORT_FLAG_SUBCOMMANDS].sort(),
    "NOTES_SHORT_FLAG_SUBCOMMANDS drifted — re-run the gh --help enumeration and update both this test and decisions.md"
  );
});

test("GFG-27c: SUBJECT_FLAG_SUBCOMMANDS matches the mechanically-derived -t/--subject surface", () => {
  assert.deepEqual(
    [...declaredSubcommandSet("SUBJECT_FLAG_SUBCOMMANDS")].sort(),
    [...EXPECTED_SUBJECT_FLAG_SUBCOMMANDS].sort(),
    "SUBJECT_FLAG_SUBCOMMANDS drifted — re-run the gh --help enumeration and update both this test and decisions.md"
  );
});

test("GFG-27d: TEMPLATE_FLAG_SUBCOMMANDS matches the mechanically-derived -T/--template surface", () => {
  assert.deepEqual(
    [...declaredSubcommandSet("TEMPLATE_FLAG_SUBCOMMANDS")].sort(),
    [...EXPECTED_TEMPLATE_FLAG_SUBCOMMANDS].sort(),
    "TEMPLATE_FLAG_SUBCOMMANDS drifted — re-run the gh --help enumeration and update both this test and decisions.md"
  );
});

const SHORT_FLAG_EXTRA_ARG = {
  "pr edit": "789", "pr comment": "99", "pr revert": "1",
  "issue edit": "999", "issue comment": "1",
  "release create": "v1.0", "release edit": "v1.0",
};

// GFG-28: bare -b missing footer → exit 1 for every declared member.
for (const subcommand of EXPECTED_BODY_SHORT_FLAG_SUBCOMMANDS) {
  test(`GFG-28: bare -b "..." missing footer → exit 1 for every declared member ("${subcommand}")`, () => {
    const extraArg = SHORT_FLAG_EXTRA_ARG[subcommand] ?? "";
    const command = `gh ${subcommand} ${extraArg} -b "description without footer"`.replace(/\s+/g, " ").trim();
    const r = run({ tool_input: { command } });
    assert.equal(r.code, 1, `bare -b on "${subcommand}" MUST be audited; stdout=${r.stdout}; stderr=${r.stderr}`);
    assert.match(r.stderr, /Footer missing/);
  });
}

test('GFG-28b (control): bare -b "..." with valid footer → exit 0 (non-regression anchor)', () => {
  const r = run({
    tool_input: { command: 'gh pr create -b "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet" --title t' },
  });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
});

// GFG-29: bare -n missing footer → exit 1 for every declared member.
for (const subcommand of EXPECTED_NOTES_SHORT_FLAG_SUBCOMMANDS) {
  test(`GFG-29: bare -n "..." missing footer → exit 1 for every declared member ("${subcommand}")`, () => {
    const extraArg = SHORT_FLAG_EXTRA_ARG[subcommand] ?? "";
    const command = `gh ${subcommand} ${extraArg} -n "description without footer"`.replace(/\s+/g, " ").trim();
    const r = run({ tool_input: { command } });
    assert.equal(r.code, 1, `bare -n on "${subcommand}" MUST be audited; stdout=${r.stdout}; stderr=${r.stderr}`);
    assert.match(r.stderr, /Footer missing/);
  });
}

test('GFG-29b (control): bare -n "..." with valid footer → exit 0 (non-regression anchor)', () => {
  const r = run({
    tool_input: { command: 'gh release create v1.0 -n "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"' },
  });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
});

// GFG-32: round-12 Critical #1 regression — the -b/-n EXTRACTION added by
// round 11 was unconditional (no subcommand gate), so an unrelated -b/-n
// belonging to a natural sibling command in the same chain got appended
// into `body`. A short appended value (e.g. a branch name) merges harmlessly
// into hasFooter's trailing `[^\n]*$` Model-field capture and does NOT
// reproduce a block — the append must be long enough to push the footer's
// `Rules:` prefix outside the last-240-char tail window (confirmed empirically:
// grep patterns, cookie values, and other -n/-b arguments regularly run this
// long in practice). These prove the fix without weakening GFG-28/29's
// true-positive coverage: the write-back's OWN footer is valid; only a
// command chain's unrelated sibling -n/-b must now be ignored.
test('GFG-32a: gh pr create --body-file <valid footer> && grep -n "<260-char pattern>" f.txt → exit 0 (unrelated long -n must not append)', () => {
  const tmp = path.join(os.tmpdir(), "gh-footer-gate-test-gfg32a.txt");
  writeFileSync(tmp, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const longPattern = "a".repeat(260);
  const r = run({
    tool_input: { command: `gh pr create --body-file ${tmp} --title t && grep -n "${longPattern}" f.txt` },
  });
  assert.equal(
    r.code,
    0,
    `unrelated long grep -n pattern must not push the valid footer out of hasFooter's tail window; stdout=${r.stdout}; stderr=${r.stderr}`
  );
});

test('GFG-32b: gh pr comment 1 --body <valid footer> && curl -b "<long cookie>" url → exit 0 (unrelated long -b must not append)', () => {
  const longCookie = "sessionid=abc123def456".repeat(15);
  const r = run({
    tool_input: {
      command: `gh pr comment 1 --body "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet" && curl -b "${longCookie}" https://example.com`,
    },
  });
  assert.equal(
    r.code,
    0,
    `unrelated long curl -b cookie must not push the valid footer out of hasFooter's tail window; stdout=${r.stdout}; stderr=${r.stderr}`
  );
});

// GFG-30: -t/--subject — an entirely new surface. Bare presence (no --body/-b)
// must force the gate closed via the existing hasFooter('') default (mirrors
// the -T/--template design), proving the previously-undetected flag now
// triggers isGhWriteBack at all.
test('GFG-30a: gh pr merge -t "subject" (no body) → exit 1 (forces fail-closed default)', () => {
  const r = run({ tool_input: { command: 'gh pr merge 123 --squash -t "release subject"' } });
  assert.equal(r.code, 1, `bare -t MUST trigger the write-back gate; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Footer missing/);
});

test('GFG-30b: gh pr merge --subject "subject" (no body) → exit 1 (long-form parity)', () => {
  const r = run({ tool_input: { command: 'gh pr merge 123 --squash --subject "release subject"' } });
  assert.equal(r.code, 1, `bare --subject MUST trigger the write-back gate; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Footer missing/);
});

// GFG-30c: the round-11 C-1 repro — forbidden attribution hidden in -t, with
// an otherwise-VALID footer in -b, must still block. This is the exact bypass
// shape the reviewer demonstrated: an unaudited short flag leaking an
// attribution brand marker while the body's footer looks compliant.
test("GFG-30c (C-1 repro): forbidden attribution in -t subject, valid footer in -b → exit 1 (Attribution forbidden)", () => {
  const r = run({
    tool_input: {
      command: 'gh pr merge 123 --squash -t "Co-Authored-By: Claude" -b "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 1, `attribution hidden in -t MUST still block; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Attribution forbidden/);
});

test("GFG-30d (control): gh pr merge -t/-b both valid, no attribution → exit 0 (non-regression anchor)", () => {
  const r = run({
    tool_input: {
      command: 'gh pr merge 123 --squash -t "release subject" -b "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
});

// GFG-31: -T/--template — detection-only surface (no extraction). Bare
// presence (no --body/-b) must force the gate closed via hasFooter('').
test('GFG-31a: gh pr create -T <file> (no body) → exit 1 (forces fail-closed default)', () => {
  const r = run({ tool_input: { command: "gh pr create -T .github/PULL_REQUEST_TEMPLATE.md --title t" } });
  assert.equal(r.code, 1, `bare -T MUST trigger the write-back gate; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Footer missing/);
});

test('GFG-31b: gh issue create --template <name> (no body) → exit 1 (long-form parity)', () => {
  const r = run({ tool_input: { command: "gh issue create --template bug_report.md --title t" } });
  assert.equal(r.code, 1, `bare --template MUST trigger the write-back gate; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Footer missing/);
});

test("GFG-31c (control): gh pr create -T <file> --body <valid footer> → exit 0 (non-regression anchor)", () => {
  const r = run({
    tool_input: { command: 'gh pr create -T .github/PULL_REQUEST_TEMPLATE.md --body "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet" --title t' },
  });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
});

// GFG-33: dp-second-reviewer cross-model CRITICAL (PR #1895) — the round-11/12
// `-t`/`--subject` extraction (subjectMatch/subjectText) was never given the
// same treatment as bodyShortMatch/notesShortMatch: it required a QUOTED
// value (missing the unquoted attached/`=` forms SUBJECT_FLAG_DETECT_RE
// already treats as a write-back) AND it was unconditional (no subcommand
// gate), unlike the -b/-n fix in GFG-32. Two independent bugs, two fix
// halves, both proven here:
//   (a) bypass — an unquoted subject value was detected as a write-back but
//       never reached hasForbiddenAttribution, because subjectText stayed ''
//   (b) false-block — with no subcommand gate, an unrelated sibling command's
//       quoted -t could be captured into subjectText and block a valid
//       gh pr merge that carries no -t/--subject of its own
test("GFG-33a (CRITICAL repro): unquoted --subject=Co-Authored-By:Claude, valid footer in -b → exit 1 (Attribution forbidden)", () => {
  const r = run({
    tool_input: {
      command: 'gh pr merge 123 --squash --subject=Co-Authored-By:Claude -b "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 1, `unquoted --subject attribution MUST block; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Attribution forbidden/);
});

test('GFG-33b (CRITICAL repro, bare -t attached form): -tCo-Authored-By:Claude, valid footer in -b → exit 1 (Attribution forbidden)', () => {
  const r = run({
    tool_input: {
      command: 'gh pr merge 123 --squash -tCo-Authored-By:Claude -b "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 1, `unquoted bare -t attribution MUST block; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Attribution forbidden/);
});

test('GFG-33c (CRITICAL repro, false-block fix): docker build -t "<forbidden marker>" . && gh pr merge (no -t) --squash -b <valid footer> → exit 0', () => {
  const r = run({
    tool_input: {
      command: 'docker build -t "Co-Authored-By: Claude" . && gh pr merge 123 --squash -b "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(
    r.code,
    0,
    `unrelated sibling docker -t MUST NOT be captured into gh pr merge's subject (no subcommand match); stdout=${r.stdout}; stderr=${r.stderr}`
  );
});

test("GFG-33d (control): unquoted --subject=<benign attached value>, valid footer in -b → exit 0 (non-regression anchor)", () => {
  const r = run({
    tool_input: {
      command: 'gh pr merge 123 --squash --subject=release-2026-08 -b "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
});

// GFG-34: fixing GFG-33's false-block by subcommand-gating subjectMatch to
// SUBJECT_FLAG_SUBCOMMANDS (['pr merge']) would have silently reintroduced a
// DIFFERENT regression — round-13's decisions.md Suggestion (a) stop-loss
// explicitly predicted it: `-t`/`--title` is the same flag on `gh pr create`
// (PR title) as it is on `gh pr merge` (commit subject), and the pre-GFG-33
// unconditional extraction happened to ALSO scan PR-title attribution as a
// side effect. Confirmed empirically (stash/pop A-B test) before landing the
// fix: subcommand-gating alone flips `gh pr create -t "<marker>" --body
// <valid footer>` from block to silent pass. The fix instead gates
// subjectText extraction on isAnyGhInvocationMatch (any gh invocation, not a
// specific subcommand) — narrows command-membership like GFG-33c/d without
// narrowing which subcommands' `-t`/`--title` get scanned.
test("GFG-34a (regression, round-13 stop-loss prediction): gh pr create -t <forbidden marker> --body <valid footer> → exit 1 (Attribution forbidden; PR-title scan must not be silenced)", () => {
  const r = run({
    tool_input: {
      command: 'gh pr create -t "Co-Authored-By: Claude" --body "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 1, `gh pr create's -t/--title attribution scan MUST NOT be silenced; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Attribution forbidden/);
});

test('GFG-34b (false-block, reverse order): gh pr merge --squash -b <valid footer> && docker build -t "<forbidden marker>" . → exit 0', () => {
  const r = run({
    tool_input: {
      command: 'gh pr merge 123 --squash -b "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet" && docker build -t "Co-Authored-By: Claude" .',
    },
  });
  assert.equal(
    r.code,
    0,
    `unrelated sibling docker -t AFTER a completed gh invocation MUST NOT be captured into gh pr merge's subject; stdout=${r.stdout}; stderr=${r.stderr}`
  );
});

// GFG-35: dp-second-reviewer cross-model CRITICAL (PR #1895, round-16) — the
// same detection-vs-extraction asymmetry GFG-33 fixed for -t/--subject also
// existed on bodyShortMatch/notesShortMatch: BODY_SHORT_FLAG_DETECT_RE /
// NOTES_SHORT_FLAG_DETECT_RE (isGhWriteBack's "is this a write-back at all"
// check) end in a bare `\S`, matching quoted OR unquoted/attached/`=` forms,
// while BODY_SHORT_FLAG_ARG_RE / NOTES_SHORT_FLAG_ARG_RE (the extraction that
// feeds `body`, which hasFooter/hasForbiddenAttribution both scan) required a
// QUOTED value. A second, separately-quoted --body/--notes on the same
// command supplies a compliant footer while the unquoted -b/-n carries a
// forbidden attribution marker straight past the scan — an even more direct
// bypass than GFG-33's, since -b/-n content is normally scanned in-band with
// the footer itself rather than through a side channel.
test("GFG-35a (CRITICAL repro): unquoted -bCo-Authored-By:Claude alongside a separately-quoted valid --body footer → exit 1 (Attribution forbidden)", () => {
  const r = run({
    tool_input: {
      command: 'gh pr comment 1 -bCo-Authored-By:Claude --body "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 1, `unquoted -b attribution MUST block; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Attribution forbidden/);
});

test("GFG-35b (CRITICAL repro, equals form): -b=Co-Authored-By:Claude alongside a separately-quoted valid --body footer → exit 1 (Attribution forbidden)", () => {
  const r = run({
    tool_input: {
      command: 'gh pr comment 1 -b=Co-Authored-By:Claude --body "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 1, `unquoted -b= attribution MUST block; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Attribution forbidden/);
});

test("GFG-35c (CRITICAL repro): unquoted -nCo-Authored-By:Claude alongside a separately-quoted valid --notes footer (release create) → exit 1 (Attribution forbidden)", () => {
  const r = run({
    tool_input: {
      command: 'gh release create v1.0 -nCo-Authored-By:Claude --notes "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 1, `unquoted -n attribution MUST block; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Attribution forbidden/);
});

test("GFG-35d (control): unquoted -b<benign attached value> alongside a valid --body footer → exit 0 (non-regression anchor)", () => {
  const r = run({
    tool_input: {
      command: 'gh pr comment 1 -bfeature-flag-name --body "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
});

test('GFG-35e (false-block, unrelated sibling): curl -b "<forbidden marker>" url && gh pr comment 1 --body <valid footer> → exit 0', () => {
  const r = run({
    tool_input: {
      command: 'curl -b "Co-Authored-By: Claude" https://example.com && gh pr comment 1 --body "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(
    r.code,
    0,
    `unrelated sibling curl -b (not a gh invocation) MUST NOT be captured into gh pr comment's body; stdout=${r.stdout}; stderr=${r.stderr}`
  );
});

// ── GFG-36 (round-17): dp-second-reviewer cross-model CRITICAL (PR #1895) —
// continuation-shaped -b/-n/-t/-T bypass footer/attribution enforcement
// entirely ──────────────────────────────────────────────────────────────
// BODY_SHORT_FLAG_DETECT_RE, NOTES_SHORT_FLAG_DETECT_RE, SUBJECT_FLAG_DETECT_RE
// (`-t` branch), and TEMPLATE_FLAG_DETECT_RE (`-T` branch) all insert
// BARE_F_NOT_CONTINUATION between their separator and value. That lookahead
// was written to stop the BARE -F path alias from over-capturing a stray
// backslash as a bogus one-character path (T24 above) — but on these four
// surfaces there is no over-capture to prevent (none of them read a second
// file via safeRead), so the lookahead only makes a valid shell continuation
// (`-b \<newline>value`) fail to match at all. With no other recognized
// write-back flag on the invocation, isGhWriteBack() returns false for the
// WHOLE command — not "this one flag's content is unaudited", but "footer
// and attribution enforcement never runs at all". The same root cause also
// affects the bare -F path alias itself (T24 above, empirically confirmed by
// direct repro, not merely traced through the regex) — it was not named
// separately in the reviewer's finding only because it had not yet been
// traced back to BARE_F_NOT_CONTINUATION.
//
// The fix replaces `${BARE_F_SEP}${BARE_F_NOT_CONTINUATION}` with a new
// continuation-aware optional separator at all affected sites (this makes
// the surfaces genuinely SUPPORT continuation, like --body-file/--notes-file
// already do via FLAG_VALUE_SEP, rather than merely re-blocking it).
test("GFG-36a (RED, round-17): -b split across backslash-continuation, footer MISSING → must be RECOGNIZED and blocked (exit 1), not silently passed through", () => {
  const r = run({
    tool_input: {
      command: 'gh pr comment 1 -b \\\n  "description without any compliant footer at all"',
    },
  });
  assert.equal(
    r.code,
    1,
    `continuation-shaped -b must be recognized and its footerless value audited, not silently pass through unaudited; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("GFG-36b (round-17 support): -b split across backslash-continuation, VALID footer → exit 0 (genuine continuation support, not merely re-blocked)", () => {
  const r = run({
    tool_input: {
      command: 'gh pr comment 1 -b \\\n  "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
});

test("GFG-36c (RED, round-17): -n split across backslash-continuation (release create), footer MISSING → exit 1", () => {
  const r = run({
    tool_input: {
      command: 'gh release create v1.0 -n \\\n  "description without any compliant footer at all"',
    },
  });
  assert.equal(
    r.code,
    1,
    `continuation-shaped -n must be recognized and its footerless value audited; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("GFG-36d (round-17 support): -n split across backslash-continuation (release create), VALID footer → exit 0", () => {
  const r = run({
    tool_input: {
      command: 'gh release create v1.0 -n \\\n  "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
});

test("GFG-36e (RED, round-17): -t split across backslash-continuation (pr merge), forbidden attribution, valid -b footer → exit 1 (Attribution forbidden)", () => {
  const r = run({
    tool_input: {
      command:
        'gh pr merge 123 --squash -t \\\n  "Co-Authored-By: Claude" -b "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(
    r.code,
    1,
    `continuation-shaped -t attribution must still be scanned, not silently bypassed; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Attribution forbidden/);
});

test("GFG-36f (round-17 control): -t split across backslash-continuation (pr merge), benign subject, valid -b footer → exit 0 (non-regression anchor)", () => {
  const r = run({
    tool_input: {
      command:
        'gh pr merge 123 --squash -t \\\n  "release subject" -b "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
});

test("GFG-36g (RED, round-17): -T split across backslash-continuation (pr create), no --body at all → exit 1 (forces fail-closed empty-body default, not a silent pass)", () => {
  const r = run({
    tool_input: {
      command: 'gh pr create -T \\\n  .github/PULL_REQUEST_TEMPLATE.md --title t',
    },
  });
  assert.equal(
    r.code,
    1,
    `continuation-shaped -T must still be recognized as a write-back so the empty-body default fails closed; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("GFG-36h (round-17 control): -T split across backslash-continuation (pr create), alongside a valid --body footer → exit 0 (non-regression anchor)", () => {
  const r = run({
    tool_input: {
      command:
        'gh pr create -T \\\n  .github/PULL_REQUEST_TEMPLATE.md --body "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet" --title t',
    },
  });
  assert.equal(r.code, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
});

// ── GFG-37 (round-19/20): dp-second-reviewer cross-model CRITICAL (PR #1895,
// fault-recovery retry dispatch-4d3d7871) — a leading `-R`/`--repo` GLOBAL
// flag before the subcommand shifts ghSubcommandFrom's two-token window off
// the real subcommand (`gh --repo o/r pr create …` resolves the candidate to
// "--repo o/r", matching no allow-list entry), so isGhBareFAliasMatch and its
// four C-1 sibling predicates (isGhBodyShortFlagMatch/NotesShortFlagMatch/
// SubjectFlagMatch/TemplateFlagMatch — ALL FIVE subcommand-gated surfaces
// share this one resolution function) silently stand down when no other
// recognized long-form write-back flag is present on the invocation. This was
// the file's own documented "known, narrow residual" (see the comment above
// ghSubcommandFrom) — accepted at write time as "only costs a missed bare-F
// detection", which TL confirmed via direct `gh --help`/`gh pr create --help`
// probing and live repro against PR #1895 is wrong on two counts: `-R`/
// `--repo` is gh's one REAL inherited/global flag (confirmed identical
// INHERITED FLAGS block across `pr create`/`issue create`/`release create`
// --help), and the bypass silently skips footer/attribution enforcement for
// the WHOLE invocation on all five gated surfaces, not just bare -F.
//
// Fix: GH_GLOBAL_REPO_FLAG_RE strips a leading `-R`/`--repo` (spaced,
// attached, `=`-form, or continuation-split value — reusing the existing
// SHORT_FLAG_VALUE_SEP/FLAG_VALUE_SEP separators, so no new parsing idiom is
// introduced) from the front of ghSubcommandFrom's input before resolving the
// two-token subcommand window. Single shared function, so the fix applies to
// all five gated surfaces at once — the same "fix once, fixes all consumers"
// shape as SHORT_FLAG_VALUE_SEP itself (round-17).
test("GFG-37a (RED, round-19/20): gh --repo o/r pr create -F <footerless>, footer MISSING → must be RECOGNIZED and blocked (exit 1), not silently bypassed by the leading global flag", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg37a-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({
    tool_input: { command: `gh --repo owner/repo pr create -F ${tmp} --title t` },
  });
  assert.equal(
    r.code,
    1,
    `a leading --repo global flag must not shift the subcommand window off "pr create" and silently bypass bare -F detection; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

// fix-pre-verb-repo-flag-gates: gh also reads -R/--repo between the first subcommand word and the verb
// (`gh pr -R o/r create`). Left inside the two-token window it resolves the subcommand to "pr -R", so every
// subcommand-gated surface stood down: the same footerless body blocked after the verb and passed between the words.
for (const [label, command] of [
  ["bare -F create, spaced -R", (tmp) => `gh pr -R owner/repo create -F ${tmp} --title t`],
  ["bare -F create, attached -R", (tmp) => `gh pr -Rowner/repo create -F ${tmp} --title t`],
  ["bare -F create, --repo= and a leading global", (tmp) => `gh --repo owner/repo pr --repo=owner/repo create -F ${tmp} --title t`],
  ["-b edit, spaced --repo", (tmp) => `gh pr --repo owner/repo edit 7 -b ${tmp}`],
]) {
  test(`GFG-REPO-BETWEEN (${label}): a footerless body blocks exactly as with the flag after the verb`, () => {
    const tmp = path.join(os.tmpdir(), `gh-footer-gate-repo-between-${Date.now()}-${Math.random().toString(16).slice(2)}.md`);
    writeFileSync(tmp, "description without footer");
    const r = run({ tool_input: { command: command(tmp) } });
    assert.equal(r.code, 1, `-R between the subcommand words must not move the verb out of the window; stdout=${r.stdout}; stderr=${r.stderr}`);
    assert.match(r.stderr, /Footer missing/);
  });
}

test("GFG-REPO-BETWEEN (valid footer): a valid footer read past -R between the subcommand words passes", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-repo-between-ok-${Date.now()}.md`);
  writeFileSync(tmp, "description\nRules: v6.83.20 · Tool: claude-code · Model: claude-sonnet");
  const r = run({ tool_input: { command: `gh pr -R owner/repo create -F ${tmp} --title t` } });
  assert.equal(r.code, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
});

test("GFG-37b (round-19/20 support): gh --repo o/r pr create -F <path>, VALID footer → exit 0 (genuine recognition, not an unconditional re-block)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg37b-${Date.now()}.md`);
  writeFileSync(tmp, "description\nRules: v6.83.20 · Tool: claude-code · Model: claude-sonnet");
  const r = run({
    tool_input: { command: `gh --repo owner/repo pr create -F ${tmp} --title t` },
  });
  assert.equal(
    r.code,
    0,
    `a genuinely valid footer read past a leading --repo global flag must pass, proving real subcommand recognition rather than an unconditional re-block; stdout=${r.stdout}; stderr=${r.stderr}`
  );
});

test("GFG-37c (RED, round-19/20): gh -Rowner/repo pr create -F <footerless> (attached short form), footer MISSING → exit 1", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg37c-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({
    tool_input: { command: `gh -Rowner/repo pr create -F ${tmp} --title t` },
  });
  assert.equal(
    r.code,
    1,
    `the attached-form -R alias must be stripped identically to spaced --repo before subcommand resolution; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("GFG-37d (RED, round-19/20): gh --repo o/r pr edit -b <footerless> (BODY_SHORT_FLAG_SUBCOMMANDS surface, not bare -F), footer MISSING → exit 1 (proves the shared-function fix covers all five gated surfaces, not just bare -F)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg37d-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({
    tool_input: { command: `gh --repo owner/repo pr edit -b ${tmp}` },
  });
  assert.equal(
    r.code,
    1,
    `the -b short-flag surface shares ghSubcommandFrom with bare -F and must be recognized identically once a leading --repo is stripped; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("GFG-37e (control, round-19/20): gh --repo o/r pr create --body \"…footerless…\" (long-flag surface, never subcommand-gated) → still exit 1 unaffected by this fix either way", () => {
  const r = run({
    tool_input: { command: 'gh --repo owner/repo pr create --body "no footer here" --title t' },
  });
  assert.equal(r.code, 1, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Footer missing/);
});

test("GFG-37f (reverse-lock, round-19/20): gh pr create -F <footerless> with NO --repo at all → still exit 1 (baseline behavior unaffected by the global-flag-skip fix)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg37f-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({ tool_input: { command: `gh pr create -F ${tmp} --title t` } });
  assert.equal(r.code, 1, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Footer missing/);
});

test("GFG-37g (RED, round-19/20): gh --repo \\\\n<continuation>o/r pr create -F <footerless>, --repo VALUE split across backslash-continuation → still exit 1 (global-flag skip reuses the existing continuation-aware separators, not a new bypass shape)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg37g-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({
    tool_input: { command: `gh --repo \\\n  owner/repo pr create -F ${tmp} --title t` },
  });
  assert.equal(
    r.code,
    1,
    `a continuation-split --repo value must not compound with the global-flag skip to create a NEW bypass shape; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

// ── GFG-38 (round-22): dp-second-reviewer cross-model CRITICAL, fault-recovery
// re-review (PR #1895, dispatch-c395b2a2) — GH_GLOBAL_REPO_FLAG_RE's own two
// PLAIN token-boundary separators (`gh` to the flag, and the repo VALUE to
// the subcommand) were still bare `\s+`, unlike the flag-to-value join
// GFG-37g already covers. A backslash-newline landing on EITHER of those two
// boundaries (not the flag=value join) makes the whole regex fail to match,
// so the leading global flag is never stripped and ghSubcommandFrom's
// two-token window resolves to something like "--repo owner/repo" instead of
// the real subcommand — reopening the exact all-five-surfaces fail-open bug
// GFG-37 fixed, just via a different separator gap. Confirmed by direct
// repro on both positions (bare -F, footerless body: exit 0 before the fix).
// Fixed by deriving both separators from CONTINUATION_WS_SEP (the
// whitespace-or-continuation half of FLAG_VALUE_SEP, no `=` alternative —
// `=` is not valid shell syntax at a plain token boundary).
test("GFG-38a (RED, round-22): gh --repo o/r \\\\n<continuation>pr create -F <footerless>, continuation between the repo VALUE and the subcommand → exit 1 (not silently bypassed)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg38a-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({
    tool_input: { command: `gh --repo owner/repo \\\n  pr create -F ${tmp} --title t` },
  });
  assert.equal(
    r.code,
    1,
    `a continuation split between the --repo value and the subcommand must not bypass subcommand resolution; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("GFG-38b (round-22 support): gh --repo o/r \\\\n<continuation>pr create -F <path>, VALID footer → exit 0 (genuine recognition, not an unconditional re-block)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg38b-${Date.now()}.md`);
  writeFileSync(tmp, "description\nRules: v6.83.20 · Tool: claude-code · Model: claude-sonnet");
  const r = run({
    tool_input: { command: `gh --repo owner/repo \\\n  pr create -F ${tmp} --title t` },
  });
  assert.equal(
    r.code,
    0,
    `a genuinely valid footer read past this continuation split must pass; stdout=${r.stdout}; stderr=${r.stderr}`
  );
});

test("GFG-38c (RED, round-22): gh \\\\n<continuation>--repo o/r pr create -F <footerless>, continuation between `gh` and the flag → exit 1 (not silently bypassed)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg38c-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({
    tool_input: { command: `gh \\\n  --repo owner/repo pr create -F ${tmp} --title t` },
  });
  assert.equal(
    r.code,
    1,
    `a continuation split between "gh" and the --repo flag must not bypass subcommand resolution; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("GFG-38d (round-22 support): gh \\\\n<continuation>--repo o/r pr create -F <path>, VALID footer → exit 0 (genuine recognition, not an unconditional re-block)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg38d-${Date.now()}.md`);
  writeFileSync(tmp, "description\nRules: v6.83.20 · Tool: claude-code · Model: claude-sonnet");
  const r = run({
    tool_input: { command: `gh \\\n  --repo owner/repo pr create -F ${tmp} --title t` },
  });
  assert.equal(
    r.code,
    0,
    `a genuinely valid footer read past this continuation split must pass; stdout=${r.stdout}; stderr=${r.stderr}`
  );
});

test("GFG-38e (RED, round-22): gh --repo o/r \\\\n<continuation>pr edit -b <footerless> (BODY_SHORT_FLAG_SUBCOMMANDS surface, not bare -F), footer MISSING → exit 1 (proves the fix covers all five gated surfaces sharing ghSubcommandFrom, not just bare -F)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg38e-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({
    tool_input: { command: `gh --repo owner/repo \\\n  pr edit -b ${tmp}` },
  });
  assert.equal(
    r.code,
    1,
    `the -b short-flag surface shares ghSubcommandFrom with bare -F and must be recognized identically past this continuation split; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("GFG-38f (control, round-22): gh --repo o/r \\\\n<continuation>pr create --body \"…footerless…\" (long-flag surface, never subcommand-gated) → still exit 1 unaffected by this fix either way", () => {
  const r = run({
    tool_input: { command: 'gh --repo owner/repo \\\n  pr create --body "no footer here" --title t' },
  });
  assert.equal(r.code, 1, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Footer missing/);
});

// ── GFG-39 (round-23/24): dp-second-reviewer cross-model CRITICAL (PR #1895,
// round 23) — SHORT_FLAG_TEXT_VALUE's bare-value branch was
// `[^\s;&|()<>]+`: it stops at the FIRST excluded metacharacter, including
// `(`. An unquoted `--subject=$(printf 'Co-Authored-By: Claude')` is detected
// as a write-back by SUBJECT_FLAG_DETECT_RE (bare `\S` after `=`), but
// SUBJECT_ARG_RE's bare branch captured only the leading `$` before `(`
// stopped it — subjectText never contained the literal marker text sitting
// in cleartext inside the command-substitution argument, so
// hasForbiddenAttribution(subjectText) never saw it. Fix (two parts, same
// shape as ELIDING_RUN's existing "eliding construct" precedent for
// TOKEN-START recognition, now applied to VALUE-CONTENT capture):
//   (a) SHORT_FLAG_BARE_ATOM treats a non-nested `$(...)`, backtick-quoted,
//       or `${...}` span as ONE atom instead of stopping at its opening
//       char — closes the reported repro and two related but previously
//       unreported truncation bugs (backtick/`${...}` forms with internal
//       whitespace).
//   (b) failClosedIfUnextracted(SUBJECT_ARG_RE, SUBJECT_FLAG_DETECT_RE,
//       isAnyGhInvocationMatch) backstops what (a) cannot reach: nesting
//       beyond one level (e.g. `$(printf "$(echo ...)")`) or a value
//       starting with a genuine unelidable terminator (bare `(` right after
//       `=`) still fails to match at all — that now fails closed instead of
//       silently leaving subjectText ''.
// SHORT_FLAG_TEXT_VALUE is shared by BODY_SHORT_FLAG_ARG_RE/
// NOTES_SHORT_FLAG_ARG_RE too, so the same widening is exercised on -b/-n
// below (GFG-39h/i) to prove the false-block risk that widening a bare-value
// capture creates (round-12 Critical #1's 240-char tail-window class) does
// not regress ordinary usage.
test("GFG-39a (CRITICAL repro, round-23): --subject=$(printf 'Co-Authored-By: Claude'), valid footer in -b → exit 1 (Attribution forbidden)", () => {
  const r = run({
    tool_input: {
      command: `gh pr merge 123 --squash --subject=$(printf 'Co-Authored-By: Claude') -b "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"`,
    },
  });
  assert.equal(r.code, 1, `unquoted $(...) subject carrying a forbidden marker MUST block; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Attribution forbidden/);
});

test("GFG-39b (CRITICAL repro variant, round-23, backtick form): -t \\`echo Co-Authored-By: Claude\\`, valid footer in -b → exit 1 (Attribution forbidden)", () => {
  const r = run({
    tool_input: {
      command: 'gh pr merge 123 --squash -t `echo Co-Authored-By: Claude` -b "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 1, `unquoted backtick-substitution subject carrying a forbidden marker MUST block; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Attribution forbidden/);
});

test("GFG-39c (CRITICAL repro variant, round-23, brace-expansion form): --subject=${SUBJ:-'Co-Authored-By: Claude'}, valid footer in -b → exit 1 (Attribution forbidden)", () => {
  const r = run({
    tool_input: {
      command: `gh pr merge 123 --squash --subject=\${SUBJ:-'Co-Authored-By: Claude'} -b "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"`,
    },
  });
  assert.equal(r.code, 1, `unquoted \${...} subject carrying a forbidden marker MUST block; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Attribution forbidden/);
});

test("GFG-39d (RED, round-23/24 backstop, nested substitution beyond bounded depth): --subject=$(printf \"$(echo Co-Authored-By: Claude)\"), valid footer in -b → exit 1 fail-closed (extraction cannot fully parse nested $(...), backstop must not silently pass)", () => {
  const r = run({
    tool_input: {
      command: `gh pr merge 123 --squash --subject=$(printf "$(echo Co-Authored-By: Claude)") -b "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"`,
    },
  });
  assert.equal(
    r.code,
    1,
    `nested command-substitution beyond SHORT_FLAG_BARE_ATOM's one-level bound must fail closed (detected-but-unextracted), not silently pass; stdout=${r.stdout}; stderr=${r.stderr}`
  );
});

test("GFG-39e (RED, round-23/24 backstop, genuine unelidable terminator): --subject=(x), valid footer in -b → exit 1 fail-closed (bare `(` right after `=` cannot be extracted at all)", () => {
  const r = run({
    tool_input: {
      command: 'gh pr merge 123 --squash --subject=(x) -b "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(
    r.code,
    1,
    `a subject value starting with a genuine terminator must fail closed rather than silently default to empty subjectText; stdout=${r.stdout}; stderr=${r.stderr}`
  );
});

test("GFG-39f (control, round-23/24, non-regression): --subject with a plain quoted benign value, valid footer in -b → exit 0", () => {
  const r = run({
    tool_input: {
      command: 'gh pr merge 123 --squash --subject="Fix bug in parser" -b "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
});

test("GFG-39g (control, round-23/24, non-regression): --subject with a bare no-substitution benign value, valid footer in -b → exit 0", () => {
  const r = run({
    tool_input: {
      command: 'gh pr merge 123 --squash --subject=release-2026-08 -b "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
});

test("GFG-39h (control, round-23/24, false-block guard on shared fragment): gh pr edit -b $(cat CHANGELOG.md) alongside a separately-quoted valid --body footer → exit 0 (widened bare-value capture on the shared SHORT_FLAG_TEXT_VALUE fragment must not push a compliant trailing footer out of hasFooter's 240-char tail window for a realistic-length substitution)", () => {
  const r = run({
    tool_input: {
      command: 'gh pr edit 123 -b $(cat CHANGELOG.md) --body "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
});

test("GFG-39i (control, round-23/24, false-block guard, -n sibling): gh release create -n $(cat NOTES.md) alongside a separately-quoted valid --notes footer → exit 0 (same shared-fragment widening exercised on the -n surface)", () => {
  const r = run({
    tool_input: {
      command: 'gh release create v1.0 -n $(cat NOTES.md) --notes "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
});

// ── GFG-39j/k (round-24 continued): a TL advisor-tool follow-up
// verification (not a new dp-second-reviewer cross-model dispatch) found
// that GFG-39a-i's fix was still incomplete — (SHORT_FLAG_BARE_ATOM+) is a
// repetition, so an unresolvable `$`/backtick mid-value only stops the `+`
// early; it does not fail the atoms ALREADY captured before it. A value
// with any ordinary-character prefix before the unresolvable nested
// substitution (e.g. `x$(printf "$(echo ...)")`) still produced a
// non-empty, same-offset capture of just that prefix ("x"), which still
// satisfied failClosedIfUnextracted's offset-presence check — the round-23
// truncation bug reappearing one character deep, this time hidden behind
// an ordinary prefix instead of only at the very start of the value. Fix:
// SHORT_FLAG_TEXT_VALUE's bare branch now requires `(?=[\s;&|()<>]|$)`
// after the atom run, so an early-stopped `+` (caused by an unresolvable
// atom position) fails the lookahead and forces the whole alternative to
// fail rather than settle for the truncated prefix.
test("GFG-39j (RED, round-24 continued backstop, prefixed nested substitution beyond bounded depth): --subject=x$(printf \"$(echo Co-Authored-By: Claude)\"), valid footer in -b → exit 1 fail-closed (a one-character prefix before the unparseable nested $(...) must not let the truncated capture slip past the offset-presence backstop)", () => {
  const r = run({
    tool_input: {
      command: `gh pr merge 123 --squash --subject=x$(printf "$(echo Co-Authored-By: Claude)") -b "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"`,
    },
  });
  assert.equal(
    r.code,
    1,
    `a legitimate prefix before an unparseable nested command-substitution must not produce a truncated-but-non-empty capture that escapes the offset-presence backstop; stdout=${r.stdout}; stderr=${r.stderr}`
  );
});

test("GFG-39k (control, round-24 continued, non-regression): --subject=release-$(date +%Y), valid footer in -b → exit 0 (an ordinary prefix followed by a cleanly-resolvable single-level command-substitution must still extract fully and not fail-closed)", () => {
  const r = run({
    tool_input: {
      command: 'gh pr merge 123 --squash --subject=release-$(date +%Y) -b "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"',
    },
  });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
});

// ── T7 (R3): three write-back consumption sites must agree on the bare -F ──
// alias's subcommand allow-list (design.md D3 — a filter applied to one site
// and forgotten on the others is the "half-fix" failure mode this locks).
// Structural: the SAME named GH_BARE_F_SUBCOMMANDS allow-list backs
// isGhWriteBack, ghWriteBackOperations, and heredocOwnerIsGhWriteBack — a
// rename or a forked second allow-list would turn this red on at least one
// site. Paired with one behavioral case below proving all three actually
// fire together for a single payload (detection + operation boundary +
// heredoc ownership), not just that the same identifier appears near each.
test("T7: bare -F alias subcommand allow-list is the single named Set shared by all three consumption sites", () => {
  const src = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../hooks/gh-footer-gate.mjs"),
    "utf8"
  );
  const subcommandSetDefCount = (src.match(/const GH_BARE_F_SUBCOMMANDS = new Set\(/g) || []).length;
  assert.equal(subcommandSetDefCount, 1, "must define exactly one named bare -F alias subcommand allow-list");

  const collectHitsBody = extractNamedFunctionSource(src, "collectWritebackFlagHits");
  const analyzeBody = extractNamedFunctionSource(src, "analyzeGhWriteBack");
  assert.ok(collectHitsBody || analyzeBody, "shared writeback traversal helper not found");
  const traversalBody = `${analyzeBody || ""}\n${collectHitsBody || ""}`;
  assert.match(
    traversalBody,
    /isGhBareFAliasMatch\([^)]+\)/,
    "shared writeback traversal must gate the bare -F alias through isGhBareFAliasMatch (shared subcommand predicate)"
  );

  const isGhWriteBackBody = extractNamedFunctionSource(src, "isGhWriteBack");
  assert.ok(isGhWriteBackBody, "isGhWriteBack function body not found");
  assert.match(
    isGhWriteBackBody,
    /analyzeGhWriteBack\s*\(/,
    "isGhWriteBack must consume analyzeGhWriteBack (bare -F gated inside shared traversal)"
  );

  const ghWriteBackOperationsBody = extractNamedFunctionSource(src, "ghWriteBackOperations");
  assert.ok(ghWriteBackOperationsBody, "ghWriteBackOperations function body not found");
  assert.match(
    ghWriteBackOperationsBody,
    /analyzeGhWriteBack\s*\(/,
    "ghWriteBackOperations must consume analyzeGhWriteBack (bare -F gated inside shared traversal)"
  );

  const heredocOwnerBody = extractNamedFunctionSource(src, "heredocOwnerIsGhWriteBack");
  assert.ok(heredocOwnerBody, "heredocOwnerIsGhWriteBack function body not found");
  assert.match(
    heredocOwnerBody,
    /GH_BARE_F_SUBCOMMANDS\.has\(subcommand\)/,
    "heredocOwnerIsGhWriteBack must gate the bare -F alias through the SAME GH_BARE_F_SUBCOMMANDS allow-list (it cannot call isGhBareFAliasMatch directly — no shared absolute offsets with `command`)"
  );
});

test("T7 (behavioral): bare -F alias fires consistently across detection + operation boundary + owned heredoc, in one payload", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-t7-heredoc-${Date.now()}.md`);
  writeFileSync(tmp, "short body without an inline footer");
  // Single gh invocation: bare -F extraction (isGhWriteBack + ghWriteBackOperations
  // must both recognize it as a write-back operation) AND an owned heredoc whose
  // opener is part of the SAME run (heredocOwnerIsGhWriteBack must recognize the
  // owning run as a write-back too, via the same allow-list). Pre-T7 this command
  // was not even detected as a write-back at all (isGhWriteBack false) so this was
  // exit 0; post-T7 all three sites agree it is a write-back and the missing footer
  // (from BOTH the -F file and the heredoc body) blocks.
  const r = run({
    tool_input: {
      command: `gh pr create -F ${tmp} --title t <<EOF\nunrelated heredoc padding text unrelated heredoc padding text unrelated heredoc padding text unrelated heredoc padding text\nEOF`,
    },
  });
  assert.equal(
    r.code,
    1,
    `bare -F alias write-back with an owned heredoc must block on missing footer; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

// ── #2071 T1 prove-it: single structured writeback traversal SSOT ───────────
// Locks structure, not just shared predicates (T7). Dual six-surface matchAll
// loops in isGhWriteBack + ghWriteBackOperations must RED until T2 lands
// analyzeGhWriteBack; also bans .test/.exec on global DETECT_REs in the
// helper/consumers (heredoc *_TEST_RE twins remain allowed elsewhere).
const WRITEBACK_GLOBAL_DETECT_RES = [
  "WRITEBACK_FLAG_RE",
  "BARE_F_DETECT_RE",
  "BODY_SHORT_FLAG_DETECT_RE",
  "NOTES_SHORT_FLAG_DETECT_RE",
  "SUBJECT_FLAG_DETECT_RE",
  "TEMPLATE_FLAG_DETECT_RE",
];

function extractNamedFunctionSource(src, functionName) {
  const start = src.search(new RegExp(`function\\s+${functionName}\\s*\\(`));
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return end > start ? src.slice(start, end) : null;
}

test("T1/#2071 prove-it: isGhWriteBack and ghWriteBackOperations consume one shared analyzeGhWriteBack (no dual six-surface matchAll; no global DETECT .test/.exec)", () => {
  const src = readFileSync(HOOK, "utf8");
  const analyzeBody = extractNamedFunctionSource(src, "analyzeGhWriteBack");
  const collectHitsBody = extractNamedFunctionSource(src, "collectWritebackFlagHits");
  assert.ok(
    analyzeBody,
    "analyzeGhWriteBack shared analysis helper must exist (#2071 single structured traversal SSOT)"
  );
  // matchAll lives in collectWritebackFlagHits (owned by analyzeGhWriteBack).
  const helperBody = `${analyzeBody}\n${collectHitsBody || ""}`;
  assert.match(
    analyzeBody,
    /collectWritebackFlagHits\s*\(/,
    "analyzeGhWriteBack must call collectWritebackFlagHits for the six-surface scan"
  );

  const isGhWriteBackBody = extractNamedFunctionSource(src, "isGhWriteBack");
  const ghWriteBackOperationsBody = extractNamedFunctionSource(src, "ghWriteBackOperations");
  assert.ok(isGhWriteBackBody, "isGhWriteBack function body not found");
  assert.ok(ghWriteBackOperationsBody, "ghWriteBackOperations function body not found");

  assert.match(
    isGhWriteBackBody,
    /analyzeGhWriteBack\s*\(/,
    "isGhWriteBack must call analyzeGhWriteBack (membership derives from shared analysis)"
  );
  assert.match(
    ghWriteBackOperationsBody,
    /analyzeGhWriteBack\s*\(/,
    "ghWriteBackOperations must call analyzeGhWriteBack (operations derive from shared analysis)"
  );

  for (const reName of WRITEBACK_GLOBAL_DETECT_RES) {
    const matchAllRe = new RegExp(`matchAll\\(\\s*${reName}\\s*\\)`, "g");
    const inIs = (isGhWriteBackBody.match(matchAllRe) || []).length;
    const inOps = (ghWriteBackOperationsBody.match(matchAllRe) || []).length;
    const inHelper = (helperBody.match(matchAllRe) || []).length;
    const inFile = (src.match(matchAllRe) || []).length;
    assert.equal(
      inIs,
      0,
      `isGhWriteBack must not matchAll(${reName}) — surface scan lives only in shared traversal helper`
    );
    assert.equal(
      inOps,
      0,
      `ghWriteBackOperations must not matchAll(${reName}) — surface scan lives only in shared traversal helper`
    );
    assert.equal(
      inHelper,
      1,
      `shared traversal helper must matchAll(${reName}) exactly once (stable six-surface order)`
    );
    assert.ok(
      inFile <= 1,
      `file-wide matchAll(${reName}) must be ≤1 (got ${inFile}); dual-consumer copies are forbidden`
    );

    const testOrExecRe = new RegExp(`${reName}\\s*\\.(?:test|exec)\\s*\\(`);
    assert.doesNotMatch(
      helperBody,
      testOrExecRe,
      `shared traversal helper must not .test/.exec on global ${reName} (lastIndex leak; use matchAll or *_TEST_RE)`
    );
    assert.doesNotMatch(
      isGhWriteBackBody,
      testOrExecRe,
      `isGhWriteBack must not .test/.exec on global ${reName}`
    );
    assert.doesNotMatch(
      ghWriteBackOperationsBody,
      testOrExecRe,
      `ghWriteBackOperations must not .test/.exec on global ${reName}`
    );
  }
});

// ── #2071 T3 D8 behavioral regression / consumer parity ─────────────────────
// Membership ⇔ operations.length > 0 is locked in source (analyzeGhWriteBack
// consumers). Behavioral cases below fill matrix gaps: owner-bound parity edge,
// mixed surfaces, multi-gh ordering. Six-surface / quotes / heredoc / negative
// coverage remains in GFG-20..31, T7, T8-5, data-region GFG-17, etc.
test("T3/#2071 D8: isGhWriteBack membership is analyzeGhWriteBack(...).operations.length > 0", () => {
  const src = readFileSync(HOOK, "utf8");
  const isGhWriteBackBody = extractNamedFunctionSource(src, "isGhWriteBack");
  assert.ok(isGhWriteBackBody);
  assert.match(
    isGhWriteBackBody,
    /analyzeGhWriteBack\s*\([^)]*\)\s*\.\s*operations\s*\.\s*length\s*>\s*0/,
    "isGhWriteBack must derive membership from shared operations (not unbound hits)"
  );
  const opsBody = extractNamedFunctionSource(src, "ghWriteBackOperations");
  assert.match(
    opsBody,
    /analyzeGhWriteBack\s*\([^)]*\)\s*\.\s*operations/,
    "ghWriteBackOperations must return the same analysis.operations list"
  );
});

test("T3/#2071 D8 parity edge: writeback flag after && outside gh span must pass through (exit 0)", () => {
  // Pre-share isGhWriteBack could fire on any cmd-segment --body while any gh
  // existed, even when the flag was outside every ghWriteBackOperations span.
  const r = run({
    tool_input: {
      command: 'gh pr list && echo --body "not a gh write-back body"',
    },
  });
  assert.equal(
    r.code,
    0,
    `flag outside gh invocation span must not trip membership; stdout=${r.stdout}; stderr=${r.stderr}`
  );
});

test("T3/#2071 D8 mixed surfaces: --body + -T on one gh invocation, missing footer → exit 1", () => {
  const r = run({
    tool_input: {
      command: 'gh pr create -T bug_report.md --body "description without footer" --title t',
    },
  });
  assert.equal(r.code, 1, `mixed template+body writeback must still fail closed; stderr=${r.stderr}`);
  assert.match(r.stderr, /Footer missing/);
});

test("T3/#2071 D8 multi-gh ordering: first writeback valid, second missing footer → exit 1", () => {
  const good = path.join(os.tmpdir(), `gh-footer-d8-good-${Date.now()}.md`);
  const bad = path.join(os.tmpdir(), `gh-footer-d8-bad-${Date.now()}.md`);
  writeFileSync(good, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  writeFileSync(bad, "description without footer");
  const r = run({
    tool_input: {
      // Mirrors T8-5 multi-gh shape; kept under D8 name for matrix traceability.
      command: `gh pr create --body-file ${good} --title t && gh pr comment 1 --body-file ${bad}`,
    },
  });
  assert.equal(
    r.code,
    1,
    `second gh writeback must still be audited; stdout=${r.stdout}; stderr=${r.stderr}`
  );
});

// ── #2071 T4 heredoc inventory (substring-local; do not merge offsets) ───────
test("T4/#2071 heredoc inventory: substring-local *_TEST_RE retained; not absolute-offset helper", () => {
  const src = readFileSync(HOOK, "utf8");
  const heredocBody = extractNamedFunctionSource(src, "heredocOwnerIsGhWriteBack");
  assert.ok(heredocBody, "heredocOwnerIsGhWriteBack must exist");
  assert.match(src, /WRITEBACK_FLAG_TEST_RE/, "non-global WRITEBACK_FLAG_TEST_RE twin must remain");
  assert.match(src, /BARE_F_DETECT_TEST_RE/, "non-global BARE_F_DETECT_TEST_RE twin must remain");
  assert.match(
    heredocBody,
    /WRITEBACK_FLAG_TEST_RE\.test\(ownerRun\)/,
    "heredoc must probe ownerRun with *_TEST_RE (substring-local)"
  );
  assert.doesNotMatch(
    heredocBody,
    /collectWritebackFlagHits\s*\(|analyzeGhWriteBack\s*\(/,
    "heredoc must NOT call absolute-offset writeback analysis (coordinate systems differ)"
  );
  assert.doesNotMatch(
    heredocBody,
    /matchAll\s*\(\s*WRITEBACK_FLAG_RE\s*\)/,
    "heredoc must not matchAll global WRITEBACK_FLAG_RE over ownerRun/command"
  );
  assert.match(
    src,
    /DETECTION absolute-offset hits|substring-local/,
    "inventory cross-ref note must document intentional coordinate separation"
  );
});

// ── #2070 T5 reproducible bench (descriptive; bottleneck gate → no-op/defer) ─
const BENCH_WARMUP = 3;
const BENCH_SAMPLES = 15;
const BENCH_BODY_BYTES = 8192;

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

test("T5/#2070 bench: ≥8KiB body writeback reports p50/p95/helper_calls/surface_matchAll_passes; default no-op/defer", () => {
  const body = `${"x".repeat(BENCH_BODY_BYTES)}\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet`;
  const tmp = path.join(os.tmpdir(), `gh-footer-bench-body-${Date.now()}.md`);
  writeFileSync(tmp, body);
  assert.ok(Buffer.byteLength(body, "utf8") >= BENCH_BODY_BYTES);

  const payload = {
    tool_input: { command: `gh pr create --body-file ${tmp} --title bench-t5` },
  };
  const runOnce = () => {
    const statsPath = path.join(os.tmpdir(), `gh-footer-bench-stats-${Date.now()}-${Math.random()}.json`);
    const t0 = process.hrtime.bigint();
    const result = spawnSync("node", [HOOK], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_CI: "",
        CODEX_THREAD_ID: "",
        DEVPRO_GH_FOOTER_BENCH_STATS_PATH: statsPath,
      },
    });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    let stats = null;
    try {
      stats = JSON.parse(readFileSync(statsPath, "utf8"));
    } catch {
      stats = null;
    }
    try {
      rmSyncFs(statsPath, { force: true });
    } catch {}
    return { ms, code: result.status, stats };
  };

  for (let i = 0; i < BENCH_WARMUP; i++) runOnce();
  const samples = [];
  let lastStats = null;
  for (let i = 0; i < BENCH_SAMPLES; i++) {
    const sample = runOnce();
    assert.equal(sample.code, 0, `bench fixture must pass footer gate; code=${sample.code}`);
    assert.ok(sample.stats, "bench must dump traversal stats via DEVPRO_GH_FOOTER_BENCH_STATS_PATH");
    samples.push(sample.ms);
    lastStats = sample.stats;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  // Baseline: pre-share dual six-surface scan ≈ 2× surface passes (12). Shared
  // cached analysis → helper_calls=1, surface_matchAll_passes=6 per sample.
  const baselineSurfacePasses = 12;
  assert.equal(lastStats.helper_calls, 1, `expected one analyzeGhWriteBack miss per hook; got ${JSON.stringify(lastStats)}`);
  assert.equal(
    lastStats.surface_matchAll_passes,
    6,
    `expected six surface matchAll passes; got ${JSON.stringify(lastStats)}`
  );
  assert.ok(
    lastStats.surface_matchAll_passes < baselineSurfacePasses,
    "shared traversal must cut surface_matchAll_passes below dual-scan baseline"
  );

  // Budget: max(baseline_p95*1.5, 50ms). No in-repo pre-fix wall baseline is
  // stored; use the absolute 50ms floor as the wider default. Wall clock is
  // descriptive (not a hard CI fail). This change delivers share-only; record
  // mandatory no-op/defer (no skip-long-body / fail-open) whenever p95 ≤ budget,
  // and still defer further optimization in this PR even if a slow host exceeds
  // the floor — only surface-pass reduction is the #2071 structural win.
  const budgetMs = 50;
  const withinBudget = p95 <= budgetMs;
  const decision = "no-op/defer";

  console.log(
    JSON.stringify({
      bench: "#2070 gh-footer writeback traversal",
      process_version: lastStats.process_version || process.version,
      warmup: BENCH_WARMUP,
      samples: BENCH_SAMPLES,
      body_utf8_bytes: Buffer.byteLength(body, "utf8"),
      p50_ms: Number(p50.toFixed(3)),
      p95_ms: Number(p95.toFixed(3)),
      helper_calls: lastStats.helper_calls,
      surface_matchAll_passes: lastStats.surface_matchAll_passes,
      baseline_surface_passes: baselineSurfacePasses,
      budget_ms: budgetMs,
      within_budget: withinBudget,
      decision,
    })
  );
  assert.equal(
    decision,
    "no-op/defer",
    "no measured skip-long-body/fail-open optimization in this change"
  );
});

test("T5/#2070 non-gh PreToolUse: zero surface_matchAll_passes (ghPositions empty early-return)", () => {
  const statsPath = path.join(os.tmpdir(), `gh-footer-nongh-stats-${Date.now()}-${Math.random()}.json`);
  const result = spawnSync("node", [HOOK], {
    input: JSON.stringify({ tool_input: { command: "git status -sb" } }),
    encoding: "utf8",
    env: { ...process.env, DEVPRO_GH_FOOTER_BENCH_STATS_PATH: statsPath },
  });
  assert.equal(result.status, 0, `non-gh must pass-through; stderr=${result.stderr}`);
  const stats = JSON.parse(readFileSync(statsPath, "utf8"));
  assert.equal(stats.surface_matchAll_passes, 0, `non-gh must not pay six surface matchAlls; got ${JSON.stringify(stats)}`);
  assert.ok(stats.helper_calls >= 1, "analyzeGhWriteBack still runs for cache/stats");
});

// ── T8 (R4): `=`-form separator + occurrence completeness ──────────────────
// Every WRITEBACK_FLAG_RE / extraction / presence branch that currently only
// recognizes a WHITESPACE separator (`--flag value`) must also recognize the
// GitHub-CLI-legal `=`-form (`--flag=value`). Separately, `firstCmdMatch`-based
// extraction only ever reads the FIRST occurrence of a repeated flag or the
// first `gh` invocation in a chained compound command — later occurrences are
// silently unaudited. T9 fixes both; these cases prove the gaps first.
test("T8-1 (RED): --field=body=@<file> missing footer → exit 1", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-t8-1-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({ tool_input: { command: `gh pr create --field=body=@${tmp} --title t` } });
  assert.equal(r.code, 1, `equals-form --field must be audited like the whitespace form; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Footer missing/);
});

test("T8-2 (RED): -F=body=@<file> missing footer → exit 1", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-t8-2-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({ tool_input: { command: `gh pr create -F=body=@${tmp} --title t` } });
  assert.equal(r.code, 1, `equals-form -F must be audited like the whitespace form; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Footer missing/);
});

test("T8-3 (RED): -F=body=<unsupported typed value> → exit 1 (fail closed)", () => {
  const r = run({ tool_input: { command: "gh pr create -F=body=description --title t" } });
  assert.equal(r.code, 1, `equals-form unsupported typed value must fail closed like the whitespace form; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /unsupported typed.*fail-closed/i);
});

test("T8-3-control: -F body=<unsupported typed value> whitespace-form stays exit 1 (non-regression)", () => {
  const r = run({ tool_input: { command: "gh pr create -F body=description --title t" } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unsupported typed.*fail-closed/i);
});

test("T8-4 (RED): repeated --body-file in ONE invocation, second occurrence missing footer → exit 1", () => {
  const good = path.join(os.tmpdir(), `gh-footer-gate-t8-4-good-${Date.now()}.md`);
  const bad = path.join(os.tmpdir(), `gh-footer-gate-t8-4-bad-${Date.now()}.md`);
  writeFileSync(good, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  writeFileSync(bad, "description without footer");
  const r = run({
    tool_input: { command: `gh pr create --body-file ${good} --body-file ${bad} --title t` },
  });
  assert.equal(
    r.code,
    1,
    `EVERY --body-file occurrence must be audited, not just the first; stdout=${r.stdout}; stderr=${r.stderr}`
  );
});

test("T8-5 (RED): two chained gh invocations, second invocation's body-file missing footer → exit 1", () => {
  const good = path.join(os.tmpdir(), `gh-footer-gate-t8-5-good-${Date.now()}.md`);
  const bad = path.join(os.tmpdir(), `gh-footer-gate-t8-5-bad-${Date.now()}.md`);
  writeFileSync(good, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  writeFileSync(bad, "description without footer");
  const r = run({
    tool_input: {
      command: `gh pr create --body-file ${good} --title t && gh pr comment 1 --body-file ${bad}`,
    },
  });
  assert.equal(
    r.code,
    1,
    `second chained gh invocation's body-file source must be independently audited; stdout=${r.stdout}; stderr=${r.stderr}`
  );
});

test("T8-neg (stays green both before/after): two chained gh invocations, BOTH body-files valid → exit 0", () => {
  const good1 = path.join(os.tmpdir(), `gh-footer-gate-t8-neg-1-${Date.now()}.md`);
  const good2 = path.join(os.tmpdir(), `gh-footer-gate-t8-neg-2-${Date.now()}.md`);
  const footer = "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet";
  writeFileSync(good1, footer);
  writeFileSync(good2, footer);
  const r = run({
    tool_input: {
      command: `gh pr create --body-file ${good1} --title t && gh pr comment 1 --body-file ${good2}`,
    },
  });
  assert.equal(r.code, 0, `two independently-valid chained write-backs must not be over-blocked; stderr=${r.stderr}`);
});

test("T8-discriminator: reverse order (first invocation missing footer, second valid) → exit 1 for the RIGHT reason (per-occurrence audit, not merely reading only the first occurrence)", () => {
  const bad = path.join(os.tmpdir(), `gh-footer-gate-t8-disc-bad-${Date.now()}.md`);
  const good = path.join(os.tmpdir(), `gh-footer-gate-t8-disc-good-${Date.now()}.md`);
  writeFileSync(bad, "description without footer");
  writeFileSync(good, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const r = run({
    tool_input: {
      command: `gh pr create --body-file ${bad} --title t && gh pr comment 1 --body-file ${good}`,
    },
  });
  // Both a naive "concatenate everything" fix (D5 option (a), rejected) and a
  // correct per-occurrence audit (D5 option (c), chosen) block this — but for
  // different reasons. This case alone cannot distinguish the two; it exists
  // so T9's implementation is checked against BOTH orderings together with
  // T8-5, which option (a) would get right for the wrong reason (only ever
  // reading the first occurrence) while a genuine per-occurrence audit gets
  // right on its own terms.
  assert.equal(r.code, 1, `stderr=${r.stderr}`);
  assert.match(r.stderr, /Footer missing/);
});

test("T8-6 (RED): repeated --body-file occurrence has a valid footer but forbidden attribution → exit 1 (auditRepeatedFileSourceOccurrences attribution branch)", () => {
  const good = path.join(os.tmpdir(), `gh-footer-gate-t8-6-good-${Date.now()}.md`);
  const bad = path.join(os.tmpdir(), `gh-footer-gate-t8-6-bad-${Date.now()}.md`);
  writeFileSync(good, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  writeFileSync(
    bad,
    "desc\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>\n\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"
  );
  const r = run({
    tool_input: { command: `gh pr create --body-file ${good} --body-file ${bad} --title t` },
  });
  assert.equal(
    r.code,
    1,
    `a repeated occurrence's own attribution must be independently audited (T9(b)); stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Attribution forbidden/);
});

test("T8-7 (RED): repeated --body-file occurrence has its own Rules: version that mismatches AGENTS.md → exit 1 (auditRepeatedFileSourceOccurrences version-equality branch)", () => {
  // Uses the same pinned-fixture-repo pattern as the "strict-exit" version tests
  // above (makeTempRepo) so this is decoupled from the live AGENTS.md version —
  // set tool_input.cwd so the generic (non-rules) version-equality lane resolves
  // this fixture's AGENTS.md instead of the live one (D4/F3), then give the
  // REPEATED occurrence a footer version that mismatches it.
  const FIXTURE_VERSION = "6.0.0-test-fixture";
  const { dir: fixtureDir, cleanup } = makeTempRepo(`# AI Agent\n\n版本：${FIXTURE_VERSION}\n`);
  const good = path.join(os.tmpdir(), `gh-footer-gate-t8-7-good-${Date.now()}.md`);
  const bad = path.join(os.tmpdir(), `gh-footer-gate-t8-7-bad-${Date.now()}.md`);
  try {
    writeFileSync(good, `description\nRules: v${FIXTURE_VERSION} · Tool: claude-code · Model: claude-sonnet`);
    writeFileSync(bad, "description\nRules: v9.9.9 · Tool: claude-code · Model: claude-sonnet");
    const r = run({
      tool_input: {
        command: `gh pr create --body-file ${good} --body-file ${bad} --title t`,
        cwd: fixtureDir,
      },
    });
    assert.equal(
      r.code,
      1,
      `a repeated occurrence's own footer version must be independently checked against AGENTS.md (T9(b)/design.md D5); stdout=${r.stdout}; stderr=${r.stderr}`
    );
    assert.match(r.stderr, /Footer version mismatch/);
  } finally {
    cleanup();
  }
});

// ── T27 (Six-Axis Review remediation round 2, Critical #1): bare -F alias ──
// repeat-occurrence content-audit gap. auditRepeatedFileSourceOccurrences was
// wired to BODY_FILE_ARG_RE/NOTES_FILE_ARG_RE/F_FILE_ARG_RE (T8/T9 above) but
// not F_ALIAS_ARG_RE, so a SECOND bare -F occurrence — a second, independent
// `gh` invocation chained with `&&` — was never content-audited: its footer
// could be entirely missing, or it could carry a forbidden attribution
// marker, and the gate stayed exit 0. dp-reviewer proved this fail-open with
// a live probe against the equivalent `--body-file` shape (T8-5/T8-6), which
// already blocks — the bare -F alias was the one surface still open for this
// class. Fixed by adding a `matchFilter` parameter to
// auditRepeatedFileSourceOccurrences (mirroring failClosedIfUnextracted's
// parameter of the same name) and a 4th call site keyed on
// isGhBareFAliasMatch, applied BEFORE the `i = 1` slice so the audited
// "first occurrence" stays in sync with the extraction site's own
// `cmdMatches(F_ALIAS_ARG_RE).find(isGhBareFAliasMatch)` selection.
test("T27-1 (RED): chained bare -F, second occurrence missing footer → exit 1", () => {
  const good = path.join(os.tmpdir(), `gh-footer-gate-t27-1-good-${Date.now()}.md`);
  const bad = path.join(os.tmpdir(), `gh-footer-gate-t27-1-bad-${Date.now()}.md`);
  writeFileSync(good, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  writeFileSync(bad, "description without footer");
  const r = run({
    tool_input: { command: `gh issue comment 1 -F ${good} && gh issue comment 2 -F ${bad}` },
  });
  assert.equal(
    r.code,
    1,
    `second chained bare -F occurrence's content must be independently audited like the other three surfaces (T8-5's --body-file equivalent); stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("T27-2 (RED): chained bare -F, second occurrence has a valid footer but forbidden attribution → exit 1", () => {
  const good = path.join(os.tmpdir(), `gh-footer-gate-t27-2-good-${Date.now()}.md`);
  const bad = path.join(os.tmpdir(), `gh-footer-gate-t27-2-bad-${Date.now()}.md`);
  writeFileSync(good, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  writeFileSync(
    bad,
    "desc\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"
  );
  const r = run({
    tool_input: { command: `gh issue comment 1 -F ${good} && gh issue comment 2 -F ${bad}` },
  });
  assert.equal(
    r.code,
    1,
    `a repeated bare -F occurrence's own attribution must be independently audited (T8-6's --body-file equivalent); stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Attribution forbidden/);
});

test("T27-neg (stays green): chained bare -F, BOTH occurrences valid → exit 0", () => {
  const good1 = path.join(os.tmpdir(), `gh-footer-gate-t27-neg-1-${Date.now()}.md`);
  const good2 = path.join(os.tmpdir(), `gh-footer-gate-t27-neg-2-${Date.now()}.md`);
  const footer = "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet";
  writeFileSync(good1, footer);
  writeFileSync(good2, footer);
  const r = run({
    tool_input: { command: `gh issue comment 1 -F ${good1} && gh issue comment 2 -F ${good2}` },
  });
  assert.equal(r.code, 0, `two independently-valid chained bare -F write-backs must not be over-blocked; stderr=${r.stderr}`);
});

// ── T10 (R5): backslash line-continuation false-positive ───────────────────
// A realistic multi-line `gh` invocation style breaks the flag-to-value
// separator across a literal `\` + newline + indentation (e.g. `--body-file \`
// on one line, the indented path on the next). DETECTION's `\s+\S` branch
// accidentally matches (the `\S` after the whitespace run is the stray `\`
// itself), but EXTRACTION's separator only consumes a whitespace run, so
// BODY_PATH_ARG's bare-token alternative starts capturing AT the stray `\`
// and stops at the following newline — a bogus one-character "path" that
// fails to read, triggering a false-positive fail-closed block even though
// the real, valid-footer file sits right there on the next line.
test("T10-1 (RED): --body-file split across backslash-continuation, valid footer → must NOT be a false-positive block (exit 0)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-t10-1-${Date.now()}.md`);
  writeFileSync(tmp, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const r = run({
    tool_input: { command: `gh pr create --body-file \\\n  ${tmp} --title t` },
  });
  assert.equal(r.code, 0, `line-continuation must not false-positive block a valid footer; stdout=${r.stdout}; stderr=${r.stderr}`);
});

test("T10-1-control: --body-file single-line, valid footer → exit 0 (non-regression anchor)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-t10-1-control-${Date.now()}.md`);
  writeFileSync(tmp, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const r = run({ tool_input: { command: `gh pr create --body-file ${tmp} --title t` } });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
});

test("T10-2 (RED): --notes-file split across backslash-continuation, valid footer → must NOT be a false-positive block (exit 0)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-t10-2-${Date.now()}.md`);
  writeFileSync(tmp, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const r = run({
    tool_input: { command: `gh release create v1.0 --notes-file \\\n  ${tmp}` },
  });
  assert.equal(r.code, 0, `line-continuation must not false-positive block a valid footer; stdout=${r.stdout}; stderr=${r.stderr}`);
});

test("T10-2-control: --notes-file single-line, valid footer → exit 0 (non-regression anchor)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-t10-2-control-${Date.now()}.md`);
  writeFileSync(tmp, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const r = run({ tool_input: { command: `gh release create v1.0 --notes-file ${tmp}` } });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
});

test("T10-3 (RED): -F body=@<file> split across backslash-continuation, valid footer → must NOT be a false-positive block (exit 0)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-t10-3-${Date.now()}.md`);
  writeFileSync(tmp, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  // Continuation splits between the flag NAME and its whole `body=@<path>`
  // value — the same join point as --body-file/--notes-file above (the
  // FLAG_VALUE_SEP separator between `-F` and `body=`), not between `@` and
  // the path itself (a different, out-of-scope join point).
  const r = run({
    tool_input: { command: `gh api repos/o/r/issues -F \\\n  body=@${tmp}` },
  });
  assert.equal(r.code, 0, `line-continuation must not false-positive block a valid footer; stdout=${r.stdout}; stderr=${r.stderr}`);
});

test("T10-3-control: -F body=@<file> single-line, valid footer → exit 0 (non-regression anchor)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-t10-3-control-${Date.now()}.md`);
  writeFileSync(tmp, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const r = run({ tool_input: { command: `gh api repos/o/r/issues -F body=@${tmp}` } });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
});

// T11 reverse-lock: continuation-form must not become a NEW bypass. Fixing the
// false-positive must not weaken the two fail-closed guarantees it sits next
// to — a genuinely missing footer, or a genuinely nonexistent file, must still
// block exactly as the single-line form already does.
test("T11 reverse-lock: --body-file split across backslash-continuation but footer MISSING → still exit 1", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-t11-revlock-missing-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({
    tool_input: { command: `gh pr create --body-file \\\n  ${tmp} --title t` },
  });
  assert.equal(r.code, 1, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Footer missing/);
});

test("T11 reverse-lock: --body-file split across backslash-continuation but file does not exist → still exit 1", () => {
  const missing = path.join(os.tmpdir(), `gh-footer-gate-t11-revlock-nofile-${Date.now()}.md`);
  const r = run({
    tool_input: { command: `gh pr create --body-file \\\n  ${missing} --title t` },
  });
  assert.equal(r.code, 1, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /body source read failed/);
});

// -F/--field continuation is NOT merely an over-block like --body-file/
// --notes-file above: WRITEBACK_FLAG_RE's `-F`/`--field` branch requires the
// LITERAL text `body=` immediately after the separator, so pre-T11 (whitespace
// -only separator) a `-F \<newline>  body=@path` split does not match at all
// — isGhWriteBack returns false and the whole gate is skipped (exit 0)
// regardless of whether the footer is present. A valid-footer split case
// alone cannot distinguish "correctly checked and passed" from "silently
// bypassed"; this reverse-lock (missing footer, same split) proves T11 closes
// a genuine DETECTION bypass here, not only EXTRACTION's over-block.
test("T11 reverse-lock: -F body=@<file> split across backslash-continuation but footer MISSING → still exit 1 (not a silent detection bypass)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-t11-revlock-f-missing-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({
    tool_input: { command: `gh api repos/o/r/issues -F \\\n  body=@${tmp}` },
  });
  assert.equal(r.code, 1, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Footer missing/);
});

// ── T23 (Six-Axis Review remediation, Critical #1): cross-separator bare -F
// misattribution ─────────────────────────────────────────────────────────
// ghInvocationSubcommandAt() found the nearest PRECEDING command-position `gh`
// token as a candidate match's "owner", then resolved that owner's subcommand
// by slicing from the owner's own position all the way to the END OF THE
// WHOLE COMMAND STRING — not bounded to that owner's own shell invocation
// span. So a `-F` flag belonging to a completely different, later command
// chained with `&&` (e.g. `grep -F <pattern> <file>`) was misattributed to
// the earlier `gh` invocation's subcommand, and — when that earlier
// subcommand happens to be bare-F-alias-eligible (`pr create`, etc.) — the
// unrelated command's `-F` value was read as if it were the gh invocation's
// own body-file path, corrupting the footer-check body buffer or (as below)
// triggering a fail-closed "body source read failed" block on an otherwise
// clean, footer-valid, benign chained command.
test("T23 (RED): gh write-back followed by && <other command> -F must not misattribute the later command's -F to the gh invocation (exit 0)", () => {
  const r = run({
    tool_input: {
      command: `gh pr create --body "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet" && grep -F "some-pattern" /tmp/does-not-need-to-exist.txt`,
    },
  });
  assert.equal(
    r.code,
    0,
    `a footer-valid gh write-back chained with && to an unrelated command's -F flag must not be misattributed as the gh invocation's own bare-F alias path; stdout=${r.stdout}; stderr=${r.stderr}`
  );
});

test("T23-control: same && chain without any -F flag on the second command → exit 0 (isolates -F as the differentiator)", () => {
  const r = run({
    tool_input: {
      command: `gh pr create --body "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet" && grep "some-pattern" /tmp/does-not-need-to-exist.txt`,
    },
  });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
});

// ── T24 (round-17 fix, SUPERSEDES the Six-Axis Critical #2 disposition
// below): bare -F backslash-continuation must be RECOGNIZED and enforced,
// not pass through unaudited ────────────────────────────────────────────
// tasks.md T9(b)/T11 (Design Question 2/3) originally scoped backslash-
// continuation SUPPORT to the three pre-existing surfaces (--body-file/
// --notes-file/-F body=@) only, and deliberately left the bare `-F <path>`
// alias (an FR3-introduced surface) as "unrecognized, pass through" for a
// continuation-shaped value — accepted at the time because the alternative
// (BODY_PATH_ARG's bare-token alternative capturing the stray `\` as a bogus
// one-character path) was a false BLOCK, not a bypass, and closing it looked
// like trading one problem for another out-of-scope one.
//
// dp-second-reviewer round-17 (PR #1895) found the real consequence of that
// scoping decision: "unrecognized" does not mean "safely ignored" — it means
// isGhWriteBack() returns false for the WHOLE invocation whenever the only
// recognized flag is this continuation-shaped bare -F, skipping footer AND
// attribution enforcement entirely, not merely failing to extract one flag.
// Confirmed by direct repro (not just regex tracing): an identical footerless
// body via `-F /path` (one line) exits 1; the SAME body via `-F \<newline
// >path` exits 0 silently. This is the same bypass class the reviewer named
// for -b/-n/-t/-T (see GFG-36 below); -F was not separately named in the
// finding only because it had not yet been traced back to the shared root
// cause (BARE_F_NOT_CONTINUATION), not because it is exempt from it.
//
// The fix reuses the exact mechanism --body-file already has: a
// continuation-aware separator consumes the `\<newline>` pair as a unit, so
// BODY_PATH_ARG's bare-token alternative starts on the real path text, not
// the backslash. This surface now gains genuine continuation SUPPORT, not
// just a safe non-match — mirroring T10's fix for the three pre-existing
// surfaces.
test("T24-1 (reverse-lock, round-17): bare -F <path> split across backslash-continuation, footer MISSING → must now be RECOGNIZED and blocked (exit 1), not silently passed through", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-t24-1-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({
    tool_input: { command: `gh pr create -F \\\n  ${tmp} --title t` },
  });
  assert.equal(
    r.code,
    1,
    `continuation-shaped bare -F must now be recognized and its footerless body audited, not silently pass through unaudited; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("T24-1b (round-17 support): bare -F <path> split across backslash-continuation, VALID footer → exit 0 (genuine continuation support, not merely re-blocked)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-t24-1b-${Date.now()}.md`);
  writeFileSync(tmp, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const r = run({
    tool_input: { command: `gh pr create -F \\\n  ${tmp} --title t` },
  });
  assert.equal(
    r.code,
    0,
    `a genuinely valid footer read across the continuation-split bare -F path must pass, proving real continuation support rather than an unconditional re-block; stdout=${r.stdout}; stderr=${r.stderr}`
  );
});

test("T24-1c (reverse-lock, round-17): bare -F <path> split across backslash-continuation, file does not exist → exit 1 (fail-closed read failure, mirrors T11's --body-file reverse-lock)", () => {
  const missing = path.join(os.tmpdir(), `gh-footer-gate-t24-1c-nofile-${Date.now()}.md`);
  const r = run({
    tool_input: { command: `gh pr create -F \\\n  ${missing} --title t` },
  });
  assert.equal(r.code, 1, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /body source read failed/);
});

test("T24-2 (scope lock, still valid post-round-17): continuation-form bare -F alongside a recognized write-back flag, BOTH missing footer → still exit 1", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-t24-2-${Date.now()}.md`);
  writeFileSync(tmp, "unrelated file content, irrelevant to this invocation's own body, also no footer");
  const r = run({
    tool_input: { command: `gh pr create --body "no footer here" -F \\\n  ${tmp} --title t` },
  });
  assert.equal(
    r.code,
    1,
    `the co-occurring bare -F continuation is now independently audited too, and the invocation's --body flag remains audited either way; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("T24-control: bare -F <path>, single-line, valid footer → exit 0 (non-regression anchor for the continuation-aware separator)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-t24-control-${Date.now()}.md`);
  writeFileSync(tmp, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const r = run({ tool_input: { command: `gh pr create -F ${tmp} --title t` } });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
});

// ── T30 (Six-Axis Review remediation, round 3 Critical): shellInvocationEnd
// must treat a backslash line-continuation as part of the SAME invocation,
// not a hard boundary ───────────────────────────────────────────────────────
// shellInvocationEnd(start, hardEnd) scanned every character from `start`
// looking for the first `&&`/`||`/`;`/`\n`/`|`/`&`, with no distinction
// between a genuine command separator and a `\` + newline shell
// line-continuation. Two consumers share this exact helper:
//   (1) ghInvocationSubcommandAt() uses it to bound a candidate flag's owning
//       `gh` invocation before resolving which subcommand governs a bare `-F`
//       alias. A continuation BEFORE the `-F` flag itself (NOT between `-F`
//       and its value — that shape is T24's deliberately-unsupported one)
//       truncated the owner span short of the flag's position, so the flag
//       resolved to subcommand `''`, which is absent from
//       GH_BARE_F_SUBCOMMANDS — silently skipping the audit entirely (P16
//       probe: exit 0 on a missing-footer body; should have been exit 1).
//   (2) ghWriteBackOperations() — the sole feed for
//       rulesOperationVersionContext()'s release-integrity checks — uses the
//       identical helper to compute each `gh` invocation's {ghPos, end} span
//       for EVERY write-back flag, not just bare-F. The same truncation makes
//       it return an EMPTY operations array whenever a continuation precedes
//       the write-back flag, which silently downgrades a rules-branch
//       write-back from the strict rules-context check to the much weaker
//       generic version-equality check (T30-5 proves this concretely: an
//       otherwise-caught `--head` mismatch on a rules branch goes
//       undetected).
// The fix must live in shellInvocationEnd itself (the shared root cause), not
// a narrow patch inside ghInvocationSubcommandAt alone — a narrow fix would
// leave ghWriteBackOperations()/rulesOperationVersionContext() unfixed,
// exactly the "half-fix" this file's own comments repeatedly warn against.
test("T30-1 (RED): backslash-continuation BEFORE a bare -F alias must not hide the flag from its own gh invocation's subcommand resolution (exit 1, missing footer)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-t30-1-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({
    tool_input: { command: `gh pr create --title t \\\n  -F ${tmp}` },
  });
  assert.equal(
    r.code,
    1,
    `a continuation between --title and a bare -F alias in the SAME gh invocation must not truncate the invocation's owner span short of the flag — the flag must still resolve to subcommand "pr create" and be audited; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("T30-2 (control): backslash-continuation before --body-file (not the bare -F alias resolution path) is unaffected either way (exit 1, missing footer)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-t30-2-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({
    tool_input: { command: `gh pr create --title t \\\n  --body-file ${tmp}` },
  });
  assert.equal(
    r.code,
    1,
    `isolates the bug to the bare-F-alias subcommand-resolution path — --body-file's footer audit does not depend on ghInvocationSubcommandAt/ghWriteBackOperations at all, so this shape must already exit 1 before AND after the shellInvocationEnd fix; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("T30-3 (control): backslash-continuation AFTER a bare -F alias (flag+value uninterrupted; continuation on a later flag) is unaffected either way (exit 1, missing footer)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-t30-3-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({
    tool_input: { command: `gh pr create -F ${tmp} --title t \\\n  --foo bar` },
  });
  assert.equal(
    r.code,
    1,
    `isolates the bug to continuation-BEFORE-the-flag positioning — continuation on a later, unrelated flag must not affect an already-resolved earlier -F; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("T30-4 (control): a genuine bare newline (no backslash) between two independent gh invocations still acts as a hard boundary", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-t30-4-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({
    tool_input: {
      command: `gh pr create --title t\ngh issue comment 1 -F ${tmp}`,
    },
  });
  assert.equal(
    r.code,
    1,
    `the second, independent gh invocation's own bare -F alias must still be audited on its own subcommand ("issue comment") — a real newline with no preceding backslash must remain a hard invocation boundary, not be (mis)treated as a continuation; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("T30-5 (RED): ghWriteBackOperations()/rulesOperationVersionContext() must not silently fall back to the generic version check when a continuation precedes --body-file on a rules-branch write-back", () => {
  const { result, json } = runRulesOperation({
    head: "rules/agent-rules-v6.64.0",
    footerVersion: "6.62.0",
    continuationBeforeBodyFile: true,
  });
  assert.equal(
    json?.decision,
    "block",
    `a continuation between --head and --body-file must not truncate this gh invocation's operation span short of --body-file — ghWriteBackOperations() must still resolve this as a rules-context operation and catch the --head/current-branch mismatch, not silently fall through to the generic version-equality check (deliberately set to spuriously agree here: footerVersion 6.62.0 matches the main checkout's own AGENTS.md, which is what the generic fallback reads); result.status=${result.status} json=${JSON.stringify(json)}`
  );
  assert.match(json?.reason || "", /Rules operation context mismatch \(release-integrity\)/);
});

// heredocOwnerIsGhWriteBack() used to probe the SHARED global-flagged
// WRITEBACK_FLAG_RE/BARE_F_DETECT_RE directly via `.test()` (reset to
// lastIndex=0 immediately beforehand). A `.test()` match still leaves a
// non-zero `.lastIndex` on the shared object afterward, and
// ghWriteBackOperations()'s LATER matchAll() over the same object inherits
// that leftover offset as its scan-start position — so when the gh
// write-back command that owns a trailing same-run heredoc is the FIRST
// segment of the full command string (the exact position where the leaked
// offset from the ownerRun-relative match coincides with the offset in the
// full command), the matchAll() scan starting past that point finds
// nothing, and the rules-branch operation silently disappears from
// ghWriteBackOperations()'s result — falling through from the strict
// `--head`-mismatch release-integrity check to the much weaker generic
// version-equality check. `footerVersion` is set to 6.62.0 (the main
// checkout's own AGENTS.md) specifically so the generic fallback would
// spuriously agree if the strict check were skipped, isolating the
// observable difference to "did the strict check fire" — same technique as
// T30-5.
//
// This uses a standalone fixture (runUnquotedGhWriteBack), not the shared
// runRulesOperation() helper used by ~30 other tests in this file: the shared
// helper always wraps the command in a `cd '<wt>' &&` prefix and single-quotes
// both --title and the body-file path. Any of those quoted/prefixed segments
// shifts ownerRun's internal relative match offset away from the full
// command's absolute offset (segmentCommand excludes quoted segments from the
// 'command'-kind concatenation heredocOwnerIsGhWriteBack scans), which either
// masks the bug entirely or reproduces it only by coincidence for one flag
// shape and not the other (measured directly while first authoring these
// tests). Reproducing it deliberately and comparably for the --body-file and
// bare -F surfaces requires no `cd` prefix (rely on payload cwd instead) and
// no quoting anywhere in the constructed command, including the --title
// argument (hence an unquoted single-word title here, not "sync rules").
function runUnquotedGhWriteBack({ footerVersion, bareF = false }) {
  const main = makeTempRepo("# AI Agent\n\n版本：6.62.0\n");
  const gitEnv = fixtureGitEnv(main.dir);
  const wtParent = makeTempDir("gh-footer-rules-context-unquoted-");
  const wt = path.join(wtParent, "wt");
  const branch = "rules/agent-rules-v6.63.0";
  const claimedHead = "rules/agent-rules-v6.64.0"; // mismatched --head, same shape as T30-5
  try {
    mkdirSync(path.join(main.dir, ".devpro", "agent-rules"), { recursive: true });
    writeFileSync(
      path.join(main.dir, ".devpro", "agent-rules", "preflight-checklist.md"),
      "<!-- rules-source-whitelist:start -->\n- `agent-rules`\n<!-- rules-source-whitelist:end -->\n"
    );
    _execSync("git add .devpro/agent-rules/preflight-checklist.md", { cwd: main.dir, env: gitEnv });
    _execSync("git commit -q -m preflight", { cwd: main.dir, env: gitEnv });

    const add = spawnSync("git", ["worktree", "add", "-b", branch, wt, "HEAD"], {
      cwd: main.dir,
      encoding: "utf8",
      env: gitEnv,
    });
    assert.equal(add.status, 0, `worktree add failed: ${add.stderr}`);
    writeFileSync(path.join(wt, "AGENTS.md"), "# AI Agent\n\n版本：6.63.0\n");

    mkdirSync(path.join(main.dir, "notes", "tmp"), { recursive: true });
    const bodyFile = path.join(main.dir, "notes", "tmp", "rules-context-body.md");
    writeFileSync(
      bodyFile,
      `## Summary\n- sync delivered rules\n\nRules: v${footerVersion} · Tool: codex · Model: gpt-5`
    );

    const fileFlag = bareF ? "-F" : "--body-file";
    const command = `gh pr create --title sync-rules --head ${claimedHead} ${fileFlag} ${bodyFile} <<EOF\nirrelevant\nEOF`;
    const result = spawnSync("node", [HOOK], {
      input: JSON.stringify({ tool_input: { command }, cwd: wt }),
      encoding: "utf8",
      env: { ...gitEnv, CODEX_CI: "1", CODEX_THREAD_ID: "" },
    });
    let json = null;
    if (result.stdout && result.stdout.trim()) {
      try { json = JSON.parse(result.stdout); } catch {}
    }
    return { result, json };
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: main.dir, stdio: "ignore", env: gitEnv });
    main.cleanup();
    try { rmSyncFs(wtParent, { recursive: true, force: true }); } catch {}
  }
}

test("T30-6 (RED): a trailing same-run heredoc on the --body-file surface must not let ghWriteBackOperations() lose the rules-branch operation to the generic version check", () => {
  const { result, json } = runUnquotedGhWriteBack({ footerVersion: "6.62.0" });
  assert.equal(
    json?.decision,
    "block",
    `a trailing same-run heredoc on the gh write-back command must not truncate which occurrences ghWriteBackOperations() finds for this operation — it must still resolve this as a rules-context operation and catch the --head/current-branch mismatch, not silently fall through to the generic version-equality check; result.status=${result.status} json=${JSON.stringify(json)}`
  );
  assert.match(json?.reason || "", /Rules operation context mismatch \(release-integrity\)/);
});

// Same bug, same fix, the OTHER shared global (BARE_F_DETECT_RE) — the bare
// `-F <path>` alias surface is polluted independently of --body-file's
// WRITEBACK_FLAG_RE, so a --body-file-only regression test would not reach
// this branch of heredocOwnerIsGhWriteBack.
test("T30-7 (RED): a trailing same-run heredoc on the bare -F alias surface must not let ghWriteBackOperations() lose the rules-branch operation to the generic version check", () => {
  const { result, json } = runUnquotedGhWriteBack({ footerVersion: "6.62.0", bareF: true });
  assert.equal(
    json?.decision,
    "block",
    `a trailing same-run heredoc on the gh write-back command's bare -F alias must not truncate which occurrences ghWriteBackOperations() finds for this operation; result.status=${result.status} json=${JSON.stringify(json)}`
  );
  assert.match(json?.reason || "", /Rules operation context mismatch \(release-integrity\)/);
});

test("strict-exit: Codex gh pr comment --body-file missing footer → exit 1", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-strict-comment-${Date.now()}.md`);
  writeFileSync(tmp, "comment body without footer");
  const r = runHookArgs([
    "--strict-exit",
    "--",
    "gh",
    "pr",
    "comment",
    "3",
    "--body-file",
    tmp,
  ], { CODEX_CI: "1" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Footer missing/);
});

test("strict-exit: Codex gh pr edit --body-file missing footer → exit 1", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-strict-edit-${Date.now()}.md`);
  writeFileSync(tmp, "PR body without footer");
  const r = runHookArgs([
    "--strict-exit",
    "--",
    "gh",
    "pr",
    "edit",
    "3",
    "--body-file",
    tmp,
  ], { CODEX_THREAD_ID: "thread-test" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Footer missing/);
});

test("strict-exit: Codex gh pr comment --body-file valid footer → exit 0", () => {
  // Use a fixture repo with a pinned AGENTS.md version so this test is decoupled
  // from the live AGENTS.md version. The hook's --strict-exit/-- path falls back to
  // process.cwd() when no payload cwd is present; setting spawnSync `cwd` makes the
  // hook read the fixture AGENTS.md (pinned to FIXTURE_VERSION) instead of the live one.
  const FIXTURE_VERSION = "6.0.0-test-fixture";
  const { dir: fixtureDir, cleanup } = makeTempRepo(`# AI Agent\n\n版本：${FIXTURE_VERSION}\n`);
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-strict-valid-${Date.now()}.md`);
  writeFileSync(tmp, `comment body\nRules: v${FIXTURE_VERSION} · Tool: codex-cli · Model: GPT-5`);
  try {
    const result = spawnSync("node", [HOOK,
      "--strict-exit",
      "--",
      "gh",
      "pr",
      "comment",
      "3",
      "--body-file",
      tmp,
    ], {
      encoding: "utf8",
      cwd: fixtureDir,
      env: { ...process.env, CODEX_CI: "1", CODEX_THREAD_ID: "" },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /validation passed only/);
    assert.match(result.stderr, /did not execute `gh`/);
  } finally {
    cleanup();
  }
});

test("strict-exit: validator-only path does not execute nested gh", () => {
  const FIXTURE_VERSION = "6.0.0-test-fixture";
  const { dir: fixtureDir, cleanup } = makeTempRepo(`# AI Agent\n\n版本：${FIXTURE_VERSION}\n`);
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-strict-validator-${Date.now()}.md`);
  writeFileSync(tmp, `comment body\nRules: v${FIXTURE_VERSION} · Tool: codex-cli · Model: GPT-5`);
  try {
    const fakeBin = path.join(fixtureDir, "bin");
    mkdirSync(fakeBin);
    const sentinel = path.join(fixtureDir, "nested-gh-executed");
    const sentinelLiteral = sentinel.replace(/'/g, "'\\''");
    writeFileSync(
      path.join(fakeBin, "gh"),
      `#!/bin/sh\nprintf executed > '${sentinelLiteral}'\nexit 17\n`,
      { mode: 0o755 }
    );
    const result = spawnSync("node", [HOOK,
      "--strict-exit",
      "--",
      "gh",
      "pr",
      "comment",
      "3",
      "--body-file",
      tmp,
    ], {
      encoding: "utf8",
      cwd: fixtureDir,
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        CODEX_CI: "1",
        CODEX_THREAD_ID: "",
      },
    });
    assert.equal(result.status, 0);
    assert.equal(existsSync(sentinel), false);
    assert.match(result.stderr, /validation passed only/);
  } finally {
    cleanup();
  }
});

// ── T1: prove-it footer version-equality tests ────────────────────────────────

// Create a temp git repo with AGENTS.md for version-equality tests.
// Returns { dir, cleanup }.
function makeTempRepo(agentsMdContent) {
  const tmp = makeTempDir("gh-footer-ver-test-");
  const gitEnv = fixtureGitEnv(tmp, {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t.com",
  });
  _execSync("git init -q", { cwd: tmp, env: gitEnv });
  configureFixtureGit(tmp, gitEnv);
  _execSync('git config user.email "t@t.com"', { cwd: tmp, env: gitEnv });
  _execSync('git config user.name "t"', { cwd: tmp, env: gitEnv });
  writeFileSync(path.join(tmp, "AGENTS.md"), agentsMdContent);
  _execSync("git add AGENTS.md", { cwd: tmp, env: gitEnv });
  _execSync('git commit -q -m "init"', { cwd: tmp, env: gitEnv });
  return {
    dir: tmp,
    env: gitEnv,
    cleanup: () => { try { rmSyncFs(tmp, { recursive: true, force: true }); } catch {} },
  };
}

function runRulesOperation({
  branch = "rules/agent-rules-v6.63.0",
  worktreeVersion = "6.63.0",
  footerVersion = "6.63.0",
  head = branch,
  commandPrefix,
  withWhitelist = true,
  whitelistContent = "<!-- rules-source-whitelist:start -->\n- `agent-rules`\n<!-- rules-source-whitelist:end -->\n",
  withWorktreeAgents = true,
  includePayloadCwd = true,
  commandSuffix = "",
  compoundSecond = null,
  bodyText = null,
  continuationBeforeBodyFile = false,
  payloadCwd = null,
} = {}) {
  const main = makeTempRepo("# AI Agent\n\n版本：6.62.0\n");
  const gitEnv = main.env;
  const wtParent = makeTempDir("gh-footer-rules-context-");
  const wt = path.join(wtParent, "wt");
  let secondWt = null;
  try {
    if (withWhitelist) {
      mkdirSync(path.join(main.dir, ".devpro", "agent-rules"), { recursive: true });
      writeFileSync(
        path.join(main.dir, ".devpro", "agent-rules", "preflight-checklist.md"),
        whitelistContent
      );
      _execSync("git add .devpro/agent-rules/preflight-checklist.md", { cwd: main.dir, env: gitEnv });
      _execSync("git commit -q -m preflight", { cwd: main.dir, env: gitEnv });
    }
    const add = spawnSync("git", ["worktree", "add", "-b", branch, wt, "HEAD"], {
      cwd: main.dir,
      encoding: "utf8",
      env: gitEnv,
    });
    assert.equal(add.status, 0, `worktree add failed: ${add.stderr}`);
    if (withWorktreeAgents) {
      writeFileSync(path.join(wt, "AGENTS.md"), `# AI Agent\n\n版本：${worktreeVersion}\n`);
    } else {
      rmSyncFs(path.join(wt, "AGENTS.md"), { force: true });
    }
    mkdirSync(path.join(main.dir, "notes", "tmp"), { recursive: true });
    const bodyFile = path.join(main.dir, "notes", "tmp", "rules-context-body.md");
    writeFileSync(
      bodyFile,
      bodyText ?? `## Summary\n- sync delivered rules\n\nRules: v${footerVersion} · Tool: codex · Model: gpt-5`
    );
    const headArg = head === null ? "" : ` --head ${head}`;
    const prefix = typeof commandPrefix === "function"
      ? commandPrefix({ main, wt, wtParent })
      : (commandPrefix === undefined ? `cd '${wt}' &&` : commandPrefix);
    let compoundSuffix = commandSuffix;
    if (compoundSecond === "generic") {
      compoundSuffix += ` && cd '${main.dir}' && gh issue create --body-file '${bodyFile}'`;
    } else if (compoundSecond === "conflicting-rules") {
      secondWt = path.join(wtParent, "wt-second");
      const secondBranch = "rules/agent-rules-v6.64.0";
      const secondAdd = spawnSync("git", ["worktree", "add", "-b", secondBranch, secondWt, "HEAD"], {
        cwd: main.dir,
        encoding: "utf8",
        env: gitEnv,
      });
      assert.equal(secondAdd.status, 0, `second worktree add failed: ${secondAdd.stderr}`);
      writeFileSync(path.join(secondWt, "AGENTS.md"), "# AI Agent\n\n版本：6.64.0\n");
      compoundSuffix += ` && cd '${secondWt}' && gh issue create --head ${secondBranch} --body-file '${bodyFile}'`;
    } else if (compoundSecond?.startsWith("same-rules-")) {
      const secondBodyFile = path.join(main.dir, "notes", "tmp", "rules-context-second-body.md");
      const secondKind = compoundSecond.slice("same-rules-".length);
      const secondBody = {
        good: "second write-back\nRules: v6.63.0 · Tool: codex · Model: gpt-5",
        mismatch: "second write-back\nRules: v9.9.9 · Tool: codex · Model: gpt-5",
        missing: "second write-back without footer",
        malformed: "second write-back\nRules: v6..63.0 · Tool: codex · Model: gpt-5",
      }[secondKind];
      assert.ok(secondBody, `unsupported same-rules body kind: ${secondKind}`);
      writeFileSync(secondBodyFile, secondBody);
      compoundSuffix += ` && gh issue create --body-file '${secondBodyFile}'`;
    }
    const bodyFileToken = continuationBeforeBodyFile ? `\\\n  --body-file` : `--body-file`;
    const command = `${prefix} gh pr create --title "sync rules"${headArg} ${bodyFileToken} '${bodyFile}'${compoundSuffix}`;
    const payload = { tool_input: { command } };
    if (includePayloadCwd) {
      payload.cwd = typeof payloadCwd === "function"
        ? payloadCwd({ main, wt, wtParent })
        : (payloadCwd ?? wt);
    }
    const result = spawnSync("node", [HOOK], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...gitEnv, CODEX_CI: "1", CODEX_THREAD_ID: "" },
    });
    let json = null;
    if (result.stdout && result.stdout.trim()) {
      try { json = JSON.parse(result.stdout); } catch {}
    }
    return { result, json };
  } finally {
    if (secondWt) spawnSync("git", ["worktree", "remove", "--force", secondWt], { cwd: main.dir, stdio: "ignore", env: gitEnv });
    spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: main.dir, stdio: "ignore", env: gitEnv });
    main.cleanup();
    try { rmSyncFs(wtParent, { recursive: true, force: true }); } catch {}
  }
}

function assertRulesContextRemediation(reason) {
  assert.match(reason || "", /exact rules worktree/);
  assert.match(reason || "", /hook-visible `cd <abs-rules-worktree>`, workdir, or a command-local `DEVPRO_PR_CHECKOUT=<abs-rules-worktree>` prefix/);
  assert.match(reason || "", /canonical `--head rules\/<source>-v<X\.Y\.Z>`/);
}

// #3647: a host without a workdir parameter names the rules worktree with the same command-local
// DEVPRO_PR_CHECKOUT declaration the other gh pr create gates already honor, instead of a cd.
test("Scenario: A declared DEVPRO_PR_CHECKOUT names the rules worktree for the footer gate (no cd needed)", () => {
  const { result, json } = runRulesOperation({
    commandPrefix: ({ wt }) => `DEVPRO_PR_CHECKOUT='${wt}'`,
    payloadCwd: ({ main }) => main.dir,
  });
  assert.equal(json?.decision, undefined, JSON.stringify(json));
  assert.equal(result.status, 0, result.stderr);
});

test("Scenario: A declared DEVPRO_PR_CHECKOUT names the rules worktree for the footer gate (checks are not relaxed)", () => {
  const mismatch = runRulesOperation({
    worktreeVersion: "6.64.0",
    footerVersion: "6.64.0",
    commandPrefix: ({ wt }) => `DEVPRO_PR_CHECKOUT='${wt}'`,
    payloadCwd: ({ main }) => main.dir,
  });
  assert.equal(mismatch.json?.decision, "block", JSON.stringify(mismatch.json));
  assert.match(mismatch.json?.reason || "", /Rules operation context mismatch \(release-integrity\)/);

  const wrongHead = runRulesOperation({
    head: "rules/agent-rules-v6.64.0",
    commandPrefix: ({ wt }) => `DEVPRO_PR_CHECKOUT='${wt}'`,
    payloadCwd: ({ main }) => main.dir,
  });
  assert.equal(wrongHead.json?.decision, "block", JSON.stringify(wrongHead.json));
  assert.match(wrongHead.json?.reason || "", /does not equal current branch rules\/agent-rules-v6\.63\.0/);
});

test("Scenario: A declared DEVPRO_PR_CHECKOUT names the rules worktree for the footer gate (a bad declaration fails closed)", () => {
  for (const prefix of [
    () => "DEVPRO_PR_CHECKOUT=$RULES_WT",
    () => "DEVPRO_PR_CHECKOUT=relative/wt",
    ({ wtParent }) => `DEVPRO_PR_CHECKOUT='${wtParent}'`,
  ]) {
    const { json } = runRulesOperation({ commandPrefix: prefix, payloadCwd: ({ main }) => main.dir });
    assert.equal(json?.decision, "block", JSON.stringify(json));
    assert.match(json?.reason || "", /Rules operation context unresolved \(release-integrity\): DEVPRO_PR_CHECKOUT /);
    assertRulesContextRemediation(json?.reason);
  }
});

test("rules-context: canonical current rules branch without --head uses worktree AGENTS version", () => {
  const { result, json } = runRulesOperation({ head: null });
  assert.equal(json?.decision, undefined, JSON.stringify(json));
  assert.equal(result.status, 0, result.stderr);
});

test("rules-context: explicit --head must equal the operation current rules branch", () => {
  const { json } = runRulesOperation({ head: "rules/agent-rules-v6.64.0" });
  assert.equal(json?.decision, "block");
  assert.match(json?.reason || "", /Rules operation context mismatch \(release-integrity\)/);
});

test("rules-context: rules branch suffix must equal operation worktree AGENTS version", () => {
  const { json } = runRulesOperation({ worktreeVersion: "6.64.0", footerVersion: "6.64.0" });
  assert.equal(json?.decision, "block");
  assert.match(json?.reason || "", /Rules operation context mismatch \(release-integrity\)/);
});

test("rules-context: visible rules operation with unresolvable command cwd fails closed", () => {
  const { json } = runRulesOperation({ commandPrefix: "CDPATH=/tmp; cd relative;" });
  assert.equal(json?.decision, "block");
  assert.match(json?.reason || "", /Rules operation context unresolved \(release-integrity\)/);
  assertRulesContextRemediation(json?.reason);
});

// R16 (shared cwd arithmetic): a chdir inside parentheses or backticks makes the
// cwd at the gh position unresolvable, so a rules publication fails closed
// instead of being judged at the hook cwd. Scenario: A rules publication behind
// a parenthesized cd keeps its fail-closed contract.
test("Scenario: A rules publication behind a parenthesized cd keeps its fail-closed contract (hook cwd on a rules branch)", () => {
  const { json } = runRulesOperation({
    head: null,
    commandPrefix: ({ main }) => `(cd '${main.dir}' &&`,
    commandSuffix: " )",
  });
  assert.equal(json?.decision, "block", JSON.stringify(json));
  assert.match(json?.reason || "", /Rules operation context unresolved \(release-integrity\)/);
  assertRulesContextRemediation(json?.reason);
});

test("Scenario: A rules publication behind a parenthesized cd keeps its fail-closed contract (backtick cd)", () => {
  const { json } = runRulesOperation({
    head: null,
    commandPrefix: ({ main }) => `\`cd '${main.dir}'\` ;`,
  });
  assert.equal(json?.decision, "block", JSON.stringify(json));
  assert.match(json?.reason || "", /Rules operation context unresolved \(release-integrity\)/);
});

test("Scenario: A rules publication behind a parenthesized cd keeps its fail-closed contract (--head carries the rules signal)", () => {
  const { json } = runRulesOperation({
    branch: "feature/add-thing",
    head: "rules/agent-rules-v6.63.0",
    commandPrefix: ({ main }) => `(cd '${main.dir}' &&`,
    commandSuffix: " )",
  });
  assert.equal(json?.decision, "block", JSON.stringify(json));
  assert.match(json?.reason || "", /Rules operation context unresolved \(release-integrity\)/);
});

test("Scenario: A rules publication behind a parenthesized cd keeps its fail-closed contract (no rules signal is not blocked)", () => {
  // The session runs in the rules worktree (6.63.0), so the footer carries 6.63.0 — the anchor is the session repo,
  // not the checkout the command cd's into.
  const { result, json } = runRulesOperation({
    branch: "feature/add-thing",
    head: null,
    footerVersion: "6.63.0",
    commandPrefix: ({ main }) => `(cd '${main.dir}' &&`,
    commandSuffix: " )",
  });
  assert.equal(json?.decision, undefined, JSON.stringify(json));
  assert.equal(result.status, 0, result.stderr);
  const backtick = runRulesOperation({
    branch: "feature/add-thing",
    head: null,
    footerVersion: "6.63.0",
    commandPrefix: ({ main }) => `\`cd '${main.dir}'\` ;`,
  });
  assert.equal(backtick.json?.decision, undefined, JSON.stringify(backtick.json));
});

function toGitBashDrivePath(nativePath) {
  const parsed = path.win32.parse(nativePath);
  const drive = parsed.root.slice(0, 1).toLowerCase();
  const rest = nativePath.slice(parsed.root.length).replace(/\\/g, "/");
  return `/${drive}/${rest}`;
}

function rulesCwdForms({ main, wt }) {
  if (process.platform !== "win32") return [["posix", wt]];
  const native = path.win32.normalize(wt);
  return [
    ["backslash", native.replace(/\//g, "\\")],
    ["forward-slash", native.replace(/\\/g, "/")],
    ["git-bash", toGitBashDrivePath(native)],
    ["relative", path.relative(main.dir, wt)],
  ];
}

test("rules-context: gh-footer-gate consumer resolves native CWD spellings", () => {
  const probe = runRulesOperation({
    commandPrefix: ({ main, wt }) => `cd '${rulesCwdForms({ main, wt })[0][1]}' &&`,
    payloadCwd: ({ main }) => main.dir,
  });
  assert.equal(probe.result.status, 0, probe.result.stderr);

  // Re-run the actual hook consumer once per host spelling. Every form must
  // reach the same rules worktree branch/version check, not only the helper.
  for (const [label] of rulesCwdForms({ main: { dir: "" }, wt: "" })) {
    const { result, json } = runRulesOperation({
      commandPrefix: ({ main, wt }) => {
        const form = rulesCwdForms({ main, wt }).find(([name]) => name === label)?.[1];
        return `cd '${form}' &&`;
      },
      payloadCwd: ({ main }) => main.dir,
    });
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    assert.equal(json?.decision, undefined, `${label}: ${JSON.stringify(json)}`);
  }
});

test("rules-context: gh-footer-gate consumer rejects unrelated and cross-drive CWDs", () => {
  const unrelated = runRulesOperation({
    commandPrefix: ({ wtParent }) => {
      const unrelatedDir = path.join(wtParent, "unrelated");
      mkdirSync(unrelatedDir, { recursive: true });
      return `cd '${unrelatedDir}' &&`;
    },
    payloadCwd: ({ main }) => main.dir,
  });
  assert.equal(unrelated.json?.decision, "block", JSON.stringify(unrelated.json));
  assert.match(unrelated.json?.reason || "", /Rules operation context unresolved \(release-integrity\)/);

  if (process.platform === "win32") {
    const crossDrive = runRulesOperation({
      commandPrefix: ({ main }) => {
        const root = path.win32.parse(path.win32.normalize(main.dir)).root;
        const drive = root.slice(0, 1).toUpperCase();
        const otherDrive = drive === "C" ? "Z" : "C";
        return `cd '${otherDrive}:\\definitely-missing\\rules-worktree' &&`;
      },
      payloadCwd: ({ main }) => main.dir,
    });
    assert.equal(crossDrive.json?.decision, "block", JSON.stringify(crossDrive.json));
    assert.match(crossDrive.json?.reason || "", /Rules operation context unresolved \(release-integrity\)/);
  }
});

test("rules-context: duplicate --head keeps a visible rules candidate fail-closed", () => {
  const { json } = runRulesOperation({
    branch: "feature/add-thing",
    head: "rules/agent-rules-v6.63.0 --head feature/add-thing",
  });
  assert.equal(json?.decision, "block");
  assert.match(json?.reason || "", /Rules operation context mismatch \(release-integrity\)/);
});

test("rules-context: malformed current rules branch is rejected", () => {
  const { json } = runRulesOperation({ branch: "rules/agent-rules-v6.63", head: null });
  assert.equal(json?.decision, "block");
  assert.match(json?.reason || "", /Rules operation context mismatch \(release-integrity\)/);
});

test("rules-context: unwhitelisted rules source is rejected", () => {
  const { json } = runRulesOperation({ branch: "rules/other-v6.63.0", head: null });
  assert.equal(json?.decision, "block");
  assert.match(json?.reason || "", /Rules operation context mismatch \(release-integrity\)/);
});

test("rules-context: missing operation-worktree whitelist is unresolved", () => {
  const { json } = runRulesOperation({ withWhitelist: false, head: null });
  assert.equal(json?.decision, "block");
  assert.match(json?.reason || "", /Rules operation context unresolved \(release-integrity\)/);
});

for (const [label, whitelistContent] of [
  ["missing markers", "- `agent-rules`\n"],
  ["reversed markers", "<!-- rules-source-whitelist:end -->\n- `agent-rules`\n<!-- rules-source-whitelist:start -->\n"],
  ["empty marker block", "<!-- rules-source-whitelist:start -->\n<!-- rules-source-whitelist:end -->\n"],
]) {
  test(`rules-context: ${label} is unresolved rather than branch mismatch`, () => {
    const { json } = runRulesOperation({ whitelistContent, head: null });
    assert.equal(json?.decision, "block");
    assert.match(json?.reason || "", /Rules operation context unresolved \(release-integrity\)/);
    assertRulesContextRemediation(json?.reason);
  });
}

test("rules-context: missing operation-worktree AGENTS version is unresolved", () => {
  const { json } = runRulesOperation({ withWorktreeAgents: false, head: null });
  assert.equal(json?.decision, "block");
  assert.match(json?.reason || "", /Rules operation context unresolved \(release-integrity\)/);
});

test("rules-context: payload without cwd accepts literal absolute cd evidence", () => {
  const { result, json } = runRulesOperation({ includePayloadCwd: false, head: null });
  assert.equal(json?.decision, undefined, JSON.stringify(json));
  assert.equal(result.status, 0, result.stderr);
});

test("rules-context: payload without cwd and without literal cd remains unresolved", () => {
  const { json } = runRulesOperation({ includePayloadCwd: false, commandPrefix: "", head: "rules/agent-rules-v6.63.0" });
  assert.equal(json?.decision, "block");
  assert.match(json?.reason || "", /Rules operation context unresolved \(release-integrity\)/);
  assertRulesContextRemediation(json?.reason);
});

test("rules-context: payload without cwd rejects a missing absolute cd target", () => {
  const missing = path.join(os.tmpdir(), `missing-rules-worktree-${process.pid}-${Date.now()}`);
  const { json } = runRulesOperation({
    includePayloadCwd: false,
    commandPrefix: `cd '${missing}' &&`,
    head: "rules/agent-rules-v6.63.0",
  });
  assert.equal(json?.decision, "block");
  assert.match(json?.reason || "", /Rules operation context unresolved \(release-integrity\)/);
});

test("rules-context: later shell-command --head text does not activate rules lane", () => {
  const footer = "Rules: v6.62.0 · Tool: test · Model: x";
  const result = runInRepo(
    `gh issue create --body "${footer}"; echo --head rules/agent-rules-v6.63.0`,
    "版本：6.62.0\n"
  );
  assert.equal(result.json?.decision, undefined, JSON.stringify(result.json));
  assert.equal(result.code, 0, result.stderr);
});

test("#3437: generic footer mismatch keeps the writer on its own version and does not route it to the target repo", () => {
  // The 2026-10-28 hint routed the writer to -R so the footer could be compared with the target repo's version —
  // exactly the provenance inversion issue #3437 reports. The message must state the session anchor instead.
  const result = runInRepo(`gh issue create --body "Rules: v6.62.0 · Tool: test · Model: x"`, "版本：6.63.0\n");
  assert.equal(result.json?.decision, "block");
  const reason = result.json?.reason || "";
  assert.match(reason, /Footer version mismatch \(release-integrity\)/);
  assert.match(reason, /do not copy the target repository's version/);
  assert.doesNotMatch(reason, /name it with -R\/--repo/);
  assert.doesNotMatch(reason, /Update the footer to match the canonical AGENTS\.md version/);
});

test("rules-context: rules footer mismatch names delivered version, branch, and worktree", () => {
  const { json } = runRulesOperation({ footerVersion: "6.62.0", head: null });
  assert.equal(json?.decision, "block");
  assert.match(json?.reason || "", /Footer version mismatch \(release-integrity\)/);
  assert.match(json?.reason || "", /footer declares Rules: v6\.62\.0/);
  assert.match(json?.reason || "", /expected delivered Rules: v6\.63\.0/);
  assert.match(json?.reason || "", /operation branch rules\/agent-rules-v6\.63\.0/);
  assert.match(json?.reason || "", /worktree/);
});

test("rules-context: arbitrary third footer version names declared and delivered provenance", () => {
  const { json } = runRulesOperation({ footerVersion: "6.99.0" });
  assert.equal(json?.decision, "block");
  assert.match(json?.reason || "", /Footer version mismatch \(release-integrity\)/);
  assert.match(json?.reason || "", /footer declares Rules: v6\.99\.0/);
  assert.match(json?.reason || "", /expected delivered Rules: v6\.63\.0/);
  assert.match(json?.reason || "", /operation branch rules\/agent-rules-v6\.63\.0/);
  assert.match(json?.reason || "", /worktree/);
});

test("rules-context: malformed Rules version fails closed", () => {
  const { json } = runRulesOperation({
    bodyText: "sync delivered rules\nRules: v6..63.0 · Tool: codex · Model: gpt-5",
  });
  assert.equal(json?.decision, "block");
  assert.match(json?.reason || "", /Footer format mismatch|Footer version unresolved/);
});

test("rules-context: SemVer with an extra numeric segment fails closed instead of accepting its prefix", () => {
  const { json } = runRulesOperation({
    bodyText: "sync delivered rules\nRules: v6.63.0.1 · Tool: codex · Model: gpt-5",
  });
  assert.equal(json?.decision, "block");
  assert.match(json?.reason || "", /Footer version unresolved \(release-integrity\)/);
});

test("rules-context: malformed plus canonical Rules declarations fail closed", () => {
  const { json } = runRulesOperation({
    bodyText: "Rules: v6..63.0 · Tool: codex · Model: gpt-5\nRules: v6.63.0 · Tool: codex · Model: gpt-5",
  });
  assert.equal(json?.decision, "block");
  assert.match(json?.reason || "", /Footer version unresolved \(release-integrity\)/);
});

test("rules-context: multiple Rules version declarations are ambiguous and fail closed", () => {
  const { json } = runRulesOperation({
    bodyText: "Rules: v9.9.9 · Tool: codex · Model: gpt-5\nRules: v6.63.0 · Tool: codex · Model: gpt-5",
  });
  assert.equal(json?.decision, "block");
  assert.match(json?.reason || "", /Footer version unresolved \(release-integrity\)/);
});

for (const secondKind of ["mismatch", "missing", "malformed"]) {
  test(`rules-context: compound rules write-back with good then ${secondKind} body fails closed`, () => {
    const { json } = runRulesOperation({ compoundSecond: `same-rules-${secondKind}` });
    assert.equal(json?.decision, "block");
    assert.match(json?.reason || "", /multiple operations whose bodies cannot be bound independently/);
    assertRulesContextRemediation(json?.reason);
  });
}

test("rules-context: compound rules write-back also fails closed in bad-then-good order", () => {
  const { json } = runRulesOperation({
    bodyText: "first write-back\nRules: v9.9.9 · Tool: codex · Model: gpt-5",
    compoundSecond: "same-rules-good",
  });
  assert.equal(json?.decision, "block");
  assert.match(json?.reason || "", /multiple operations whose bodies cannot be bound independently/);
});

test("rules-context: compound rules plus generic write-backs are unresolved", () => {
  const { json } = runRulesOperation({ head: null, compoundSecond: "generic" });
  assert.equal(json?.decision, "block");
  assert.match(json?.reason || "", /Rules operation context unresolved \(release-integrity\)/);
});

test("rules-context: compound write-backs in conflicting rules worktrees are unresolved", () => {
  const { json } = runRulesOperation({ head: null, compoundSecond: "conflicting-rules" });
  assert.equal(json?.decision, "block");
  assert.match(json?.reason || "", /Rules operation context unresolved \(release-integrity\)/);
  assertRulesContextRemediation(json?.reason);
});

// Run gh-footer-gate hook with payload.cwd pointing to a git repo dir.
function runInRepo(command, agentsMdContent) {
  const { dir, env: gitEnv, cleanup } = makeTempRepo(agentsMdContent);
  try {
    const result = spawnSync("node", [HOOK], {
      input: JSON.stringify({
        tool_input: { command },
        cwd: dir,
      }),
      encoding: "utf8",
      env: { ...gitEnv, CODEX_CI: "1", CODEX_THREAD_ID: "" },
    });
    let json = null;
    if (result.stdout && result.stdout.trim()) {
      try { json = JSON.parse(result.stdout); } catch {}
    }
    return { code: result.status, stderr: result.stderr, stdout: result.stdout, json };
  } finally {
    cleanup();
  }
}

// T1(a): gh-body footer version mismatch → BLOCK
// footer says v6.99.0, AGENTS.md says 6.62.0 → must block
test("T1(a)-prove-it: gh body footer Rules: v6.99.0 vs AGENTS.md 6.62.0 → block (mismatch)", () => {
  const r = runInRepo(
    'gh issue create --body "test content\nRules: v6.99.0 · Tool: claude-code · Model: claude-sonnet"',
    "# AI Agent\n\n版本：6.62.0\n"
  );
  // Currently fails (hook doesn't do version check) → this is the prove-it red case
  assert.equal(r.json?.decision, "block", "version mismatch MUST block");
  assert.match(r.json?.reason || "", /mismatch|version|6\.99\.0|6\.62\.0/i, "reason must mention mismatch and versions");
});

// T1(a)-pass: gh-body footer version match → pass
test("T1(a)-regression: gh body footer Rules: v6.62.0 vs AGENTS.md 6.62.0 → pass (match)", () => {
  const r = runInRepo(
    'gh issue create --body "test content\nRules: v6.62.0 · Tool: claude-code · Model: claude-sonnet"',
    "# AI Agent\n\n版本：6.62.0\n"
  );
  // match version → must NOT block (exit 0)
  assert.equal(r.code, 0, "version match MUST pass (exit 0)");
});

test("T1(a)-body-file-repo-regression: main-checkout notes/tmp --body-file uses body file repo AGENTS.md → pass", () => {
  const main = makeTempRepo("# AI Agent\n\n版本：6.62.0\n");
  const gitEnv = main.env;
  const wtParent = makeTempDir("gh-footer-ver-wt-parent-");
  const wt = path.join(wtParent, "wt");
  try {
    const add = spawnSync("git", ["worktree", "add", "-b", "chore/bump-v6.63.0", wt, "HEAD"], {
      cwd: main.dir,
      encoding: "utf8",
      env: gitEnv,
    });
    assert.equal(add.status, 0, `worktree add failed: ${add.stderr}`);
    writeFileSync(path.join(wt, "AGENTS.md"), "# AI Agent\n\n版本：6.63.0\n");
    mkdirSync(path.join(main.dir, "notes", "tmp"), { recursive: true });
    const bodyFile = path.join(main.dir, "notes", "tmp", "remove-gh-body-pr-body-t1a.md");
    writeFileSync(
      bodyFile,
      "## Summary\n- bump rules\n\nRules: v6.62.0 · Tool: codex · Model: gpt-5"
    );

    const result = spawnSync("node", [HOOK], {
      input: JSON.stringify({
        tool_input: { command: `gh pr create --title "bump" --body-file ${bodyFile}` },
        cwd: wt,
      }),
      encoding: "utf8",
      env: { ...gitEnv, CODEX_CI: "1", CODEX_THREAD_ID: "" },
    });
    let json = null;
    if (result.stdout && result.stdout.trim()) {
      try { json = JSON.parse(result.stdout); } catch {}
    }
    assert.equal(
      json?.decision,
      undefined,
      `--body-file footer version MUST be checked against body file repo AGENTS.md, not hook cwd; got: ${JSON.stringify(json)}`
    );
    assert.equal(result.status, 0, `hook should pass; stderr: ${result.stderr}`);
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: main.dir, stdio: "ignore", env: gitEnv });
    main.cleanup();
    try { rmSyncFs(wtParent, { recursive: true, force: true }); } catch {}
  }
});

test("#2533: generic body-file footer matches origin/main tip even when workspace AGENTS.md is stale", () => {
  const main = makeTempRepo("# AI Agent\n\n版本：6.93.0\n");
  const gitEnv = main.env;
  try {
    _execSync("git branch -M main", { cwd: main.dir, env: gitEnv });
    _execSync("git update-ref refs/remotes/origin/main HEAD", { cwd: main.dir, env: gitEnv });
    _execSync("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", { cwd: main.dir, env: gitEnv });
    _execSync("git checkout -q -b develop", { cwd: main.dir, env: gitEnv });
    writeFileSync(path.join(main.dir, "AGENTS.md"), "# AI Agent\n\n版本：6.92.0\n");
    _execSync("git add AGENTS.md", { cwd: main.dir, env: gitEnv });
    _execSync('git commit -q -m "stale develop"', { cwd: main.dir, env: gitEnv });

    mkdirSync(path.join(main.dir, "notes", "tmp"), { recursive: true });
    const bodyFile = path.join(main.dir, "notes", "tmp", "footer-2533-canonical-tip.md");
    writeFileSync(
      bodyFile,
      "## Summary\n- comment with tip version\n\nRules: v6.93.0 · Tool: claude-code · Model: claude-opus"
    );

    const result = spawnSync("node", [HOOK], {
      input: JSON.stringify({
        tool_input: { command: `gh pr comment 1 --body-file '${bodyFile}'` },
        cwd: main.dir,
      }),
      encoding: "utf8",
      env: { ...gitEnv, CODEX_CI: "1", CODEX_THREAD_ID: "" },
    });
    let json = null;
    if (result.stdout && result.stdout.trim()) {
      try { json = JSON.parse(result.stdout); } catch {}
    }
    assert.equal(
      json?.decision,
      undefined,
      `#2533: footer v6.93.0 MUST pass against origin/main tip despite workspace 6.92.0; got: ${JSON.stringify(json)} stderr=${result.stderr}`
    );
    assert.equal(result.status, 0, `hook should pass; stderr: ${result.stderr}`);

    writeFileSync(
      bodyFile,
      "## Summary\n- stale workspace version only\n\nRules: v6.92.0 · Tool: claude-code · Model: claude-opus"
    );
    const mismatch = spawnSync("node", [HOOK], {
      input: JSON.stringify({
        tool_input: { command: `gh pr comment 1 --body-file '${bodyFile}'` },
        cwd: main.dir,
      }),
      encoding: "utf8",
      env: { ...gitEnv, CODEX_CI: "1", CODEX_THREAD_ID: "" },
    });
    let mismatchJson = null;
    if (mismatch.stdout && mismatch.stdout.trim()) {
      try { mismatchJson = JSON.parse(mismatch.stdout); } catch {}
    }
    assert.equal(mismatchJson?.decision, "block", "footer matching only stale workspace MUST block");
    assert.match(mismatchJson?.reason || mismatch.stderr || "", /Footer version mismatch/);
    assert.match(mismatchJson?.reason || mismatch.stderr || "", /anchor: ref:origin\/main/);
  } finally {
    main.cleanup();
  }
});

// ── #3437: the footer version anchor is the repo this session runs in, never the -R target ─────────────────────
// Fixture: <parent>/self is the hook cwd (AGENTS.md 6.102.0, origin a/self); an optional <parent>/other is a local
// checkout of the write-back target (AGENTS.md 6.103.0, origin b/other). The body file lives outside every repo
// unless a test says otherwise (the host scratchpad case from issue #3437).
function makeSessionAnchorFixture({ sibling = false } = {}) {
  const parent = makeTempDir("gh-footer-anchor-");
  const gitEnv = fixtureGitEnv(parent, {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t.com",
  });
  const initRepo = (name, version, remote) => {
    const dir = path.join(parent, name);
    mkdirSync(dir, { recursive: true });
    _execSync("git init -q", { cwd: dir, env: gitEnv });
    configureFixtureGit(dir, gitEnv);
    writeFileSync(path.join(dir, "AGENTS.md"), `# AI Agent\n\n版本：${version}\n`);
    _execSync("git add AGENTS.md", { cwd: dir, env: gitEnv });
    _execSync('git commit -q -m "init"', { cwd: dir, env: gitEnv });
    _execSync("git branch -M main", { cwd: dir, env: gitEnv });
    _execSync(`git remote add origin ${remote}`, { cwd: dir, env: gitEnv });
    _execSync("git update-ref refs/remotes/origin/main HEAD", { cwd: dir, env: gitEnv });
    _execSync("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", { cwd: dir, env: gitEnv });
    return dir;
  };
  const self = initRepo("self", "6.102.0", "https://github.com/a/self.git");
  const other = sibling ? initRepo("other", "6.103.0", "https://github.com/b/other.git") : null;
  const bodyDir = makeTempDir("gh-footer-anchor-body-");
  const writeBody = (dir, version) => {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `body-3437-${version}.md`);
    writeFileSync(file, `## Summary\n- cross-repo write-back\n\nRules: v${version} · Tool: claude-code · Model: claude-opus`);
    return file;
  };
  return {
    self,
    other,
    gitEnv,
    bodyDir,
    writeBody,
    // `cwd === undefined` omits the payload cwd on purpose (host without cwd / neutral reviewer cwd).
    runFrom(cwd, command, extraEnv = {}) {
      const toolInput = { command };
      if (cwd !== undefined) toolInput.cwd = cwd;
      const result = spawnSync("node", [HOOK], {
        input: JSON.stringify({ tool_input: toolInput }),
        encoding: "utf8",
        env: { ...gitEnv, CODEX_CI: "1", CODEX_THREAD_ID: "", ...extraEnv },
      });
      let json = null;
      if (result.stdout && result.stdout.trim()) {
        try { json = JSON.parse(result.stdout); } catch {}
      }
      return { code: result.status, stderr: result.stderr, json };
    },
    cleanup() {
      for (const dir of [parent, bodyDir]) {
        try { rmSyncFs(dir, { recursive: true, force: true }); } catch {}
      }
    },
  };
}

test("#3437: a consumer writing to the source repo with -R passes with its own footer version", () => {
  // The reported episode: a rules v7.4.1 consumer opened an issue in the source repo and the gate refused its own
  // version, forcing the writer to declare a version it never used.
  const fx = makeSessionAnchorFixture();
  try {
    const body = fx.writeBody(fx.bodyDir, "6.102.0");
    const forms = [
      `gh issue create -R b/other --title t --body-file '${body}'`,
      `gh issue create -Rb/other --title t --body-file '${body}'`,
      `gh issue create --repo b/other --title t --body-file '${body}'`,
      `gh issue create --repo=b/other --title t --body-file '${body}'`,
      `gh -R b/other issue create --title t --body-file '${body}'`,
      `gh api repos/b/other/issues -X POST -F body=@'${body}'`,
    ];
    for (const command of forms) {
      const r = fx.runFrom(fx.self, command);
      assert.equal(r.json?.decision, undefined, `${command} must be judged by the session repo version; got ${JSON.stringify(r.json)} ${r.stderr}`);
      assert.equal(r.code, 0, `${command}: ${r.stderr}`);
    }
  } finally {
    fx.cleanup();
  }
});

test("#3437: a local checkout of the -R target is not the version authority", () => {
  const fx = makeSessionAnchorFixture({ sibling: true });
  try {
    const command = (body) => `gh pr create -R b/other --title t --body-file '${body}'`;
    const own = fx.runFrom(fx.self, command(fx.writeBody(fx.bodyDir, "6.102.0")));
    assert.equal(own.json?.decision, undefined, `the session version must pass even when the target checkout declares 6.103.0; got ${JSON.stringify(own.json)} ${own.stderr}`);
    assert.equal(own.code, 0);

    const targetVersion = fx.runFrom(fx.self, command(fx.writeBody(fx.bodyDir, "6.103.0")));
    assert.equal(targetVersion.json?.decision, "block", "the target repo version is the wrong provenance for this session");
    const reason = targetVersion.json?.reason || targetVersion.stderr;
    assert.match(reason, /Footer version mismatch/);
    assert.match(reason, /AGENTS\.md 版本：6\.102\.0/);
    assert.match(reason, /anchor: ref:origin\/main/);
  } finally {
    fx.cleanup();
  }
});

test("#3437: the mismatch message keeps the writer on the version it used", () => {
  const fx = makeSessionAnchorFixture({ sibling: true });
  try {
    const r = fx.runFrom(fx.self, `gh pr create -R b/other --title t --body-file '${fx.writeBody(fx.bodyDir, "6.103.0")}'`);
    const reason = r.json?.reason || r.stderr;
    assert.match(reason, /do not copy the target repository's version/);
    assert.doesNotMatch(reason, /Update the footer to match the canonical AGENTS\.md version/, "the old instruction told the AI to declare a version it never used");
    assert.doesNotMatch(reason, /put the body file under the target repo/, "the body-file location is no longer the anchor");
  } finally {
    fx.cleanup();
  }
});

test("#3437: a body file inside the target repo does not switch the anchor", () => {
  const fx = makeSessionAnchorFixture({ sibling: true });
  try {
    const own = fx.writeBody(path.join(fx.other, "notes", "tmp"), "6.102.0");
    const ok = fx.runFrom(fx.self, `gh pr create -R b/other --title t --body-file '${own}'`);
    assert.equal(ok.json?.decision, undefined, `got ${JSON.stringify(ok.json)} ${ok.stderr}`);
    const target = fx.writeBody(path.join(fx.other, "notes", "tmp"), "6.103.0");
    const bad = fx.runFrom(fx.self, `gh pr create -R b/other --title t --body-file '${target}'`);
    assert.equal(bad.json?.decision, "block");
    assert.match(bad.json?.reason || bad.stderr, /AGENTS\.md 版本：6\.102\.0/);
  } finally {
    fx.cleanup();
  }
});

test("#3437: without a resolvable cwd the body-file repo is the fallback anchor", () => {
  const fx = makeSessionAnchorFixture();
  try {
    const own = fx.writeBody(path.join(fx.self, "notes", "tmp"), "6.102.0");
    const ok = fx.runFrom(undefined, `gh issue create -R b/other --title t --body-file '${own}'`);
    assert.equal(ok.json?.decision, undefined, `got ${JSON.stringify(ok.json)} ${ok.stderr}`);
    const stale = fx.writeBody(path.join(fx.self, "notes", "tmp"), "6.103.0");
    const bad = fx.runFrom(undefined, `gh issue create -R b/other --title t --body-file '${stale}'`);
    assert.equal(bad.json?.decision, "block");
    assert.match(bad.json?.reason || bad.stderr, /AGENTS\.md 版本：6\.102\.0/);
  } finally {
    fx.cleanup();
  }
});

test("#3437: -R does not weaken the other layers → a footerless body is still refused", () => {
  const fx = makeSessionAnchorFixture();
  try {
    const file = path.join(fx.bodyDir, "no-footer.md");
    writeFileSync(file, "## Summary\n- no footer at all\n");
    const r = fx.runFrom(fx.self, `gh pr create -R b/other --title t --body-file '${file}'`);
    assert.equal(r.json?.decision, "block");
    assert.match(r.json?.reason || r.stderr, /Footer missing/);
  } finally {
    fx.cleanup();
  }
});

test("#3437: a -R that only appears inside quoted body text is data, not the write-back target", () => {
  const fx = makeSessionAnchorFixture({ sibling: true });
  try {
    const body = "## Summary\n- run gh pr list -R b/other first\n\nRules: v6.103.0 · Tool: claude-code · Model: claude-opus";
    const r = fx.runFrom(fx.self, `gh pr comment 1 --body "${body}"`);
    assert.equal(r.json?.decision, "block", "no real -R → the session repo (6.102.0) gates the 6.103.0 footer");
    assert.match(r.json?.reason || r.stderr, /AGENTS\.md 版本：6\.102\.0/);
  } finally {
    fx.cleanup();
  }
});

test("#3437: one command writing to two repos keeps one anchor → the session version passes for both", () => {
  const fx = makeSessionAnchorFixture({ sibling: true });
  try {
    const body = fx.writeBody(fx.bodyDir, "6.102.0");
    const r = fx.runFrom(
      fx.self,
      `gh pr comment 1 -R a/self --body-file '${body}' && gh pr comment 2 -R b/other --body-file '${body}'`
    );
    assert.equal(r.json?.decision, undefined, `got ${JSON.stringify(r.json)} ${r.stderr}`);
    assert.equal(r.code, 0);
  } finally {
    fx.cleanup();
  }
});
test("rules-lane-main-old-worktree-new: delivered rules footer uses operation worktree version", () => {
  const main = makeTempRepo("# AI Agent\n\n版本：6.62.0\n");
  const gitEnv = main.env;
  const wtParent = makeTempDir("gh-footer-rules-wt-parent-");
  const wt = path.join(wtParent, "wt");
  const branch = "rules/agent-rules-v6.63.0";
  try {
    mkdirSync(path.join(main.dir, ".devpro", "agent-rules"), { recursive: true });
    writeFileSync(
      path.join(main.dir, ".devpro", "agent-rules", "preflight-checklist.md"),
      "<!-- rules-source-whitelist:start -->\n- `agent-rules`\n<!-- rules-source-whitelist:end -->\n"
    );
    _execSync("git add .devpro/agent-rules/preflight-checklist.md", { cwd: main.dir, env: gitEnv });
    _execSync("git commit -q -m preflight", { cwd: main.dir, env: gitEnv });

    const add = spawnSync("git", ["worktree", "add", "-b", branch, wt, "HEAD"], {
      cwd: main.dir,
      encoding: "utf8",
      env: gitEnv,
    });
    assert.equal(add.status, 0, `worktree add failed: ${add.stderr}`);
    writeFileSync(path.join(wt, "AGENTS.md"), "# AI Agent\n\n版本：6.63.0\n");

    mkdirSync(path.join(main.dir, "notes", "tmp"), { recursive: true });
    const bodyFile = path.join(main.dir, "notes", "tmp", "remove-gh-body-pr-body-rules-lane.md");
    writeFileSync(
      bodyFile,
      "## Summary\n- sync delivered rules\n\nRules: v6.63.0 · Tool: codex · Model: gpt-5"
    );

    const command = `cd '${wt}' && gh pr create --title "sync rules" --head ${branch} --body-file '${bodyFile}'`;
    const result = spawnSync("node", [HOOK], {
      input: JSON.stringify({
        tool_input: { command },
        cwd: wt,
      }),
      encoding: "utf8",
      env: { ...gitEnv, CODEX_CI: "1", CODEX_THREAD_ID: "" },
    });
    let json = null;
    if (result.stdout && result.stdout.trim()) {
      try { json = JSON.parse(result.stdout); } catch {}
    }

    assert.equal(
      json?.decision,
      undefined,
      `delivered rules footer MUST use operation worktree v6.63.0 instead of main/body-file repo v6.62.0; got: ${JSON.stringify(json)}`
    );
    assert.equal(result.status, 0, `hook should pass; stdout=${result.stdout}; stderr=${result.stderr}`);
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: main.dir, stdio: "ignore", env: gitEnv });
    main.cleanup();
    try { rmSyncFs(wtParent, { recursive: true, force: true }); } catch {}
  }
});

// T1(a)-fail-open: AGENTS.md missing in the git repo → must NOT block on version layer
test("T1(a)-fail-open: AGENTS.md missing → gh body not blocked (fail-open)", () => {
  // Create a git repo WITHOUT AGENTS.md
  const tmp = makeTempDir("gh-footer-ver-t1a-failopen-");
  const gitEnv = fixtureGitEnv(tmp, {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t.com",
  });
  try {
    _execSync("git init -q", { cwd: tmp, env: gitEnv });
    configureFixtureGit(tmp, gitEnv);
    _execSync('git config user.email "t@t.com"', { cwd: tmp, env: gitEnv });
    _execSync('git config user.name "t"', { cwd: tmp, env: gitEnv });
    writeFileSync(path.join(tmp, "README.md"), "no agents here");
    _execSync("git add README.md", { cwd: tmp, env: gitEnv });
    _execSync('git commit -q -m "init"', { cwd: tmp, env: gitEnv });

    const result = spawnSync("node", [HOOK], {
      input: JSON.stringify({
        tool_input: { command: 'gh issue create --body "test content\nRules: v6.99.0 · Tool: claude-code · Model: claude-sonnet"' },
        cwd: tmp,
      }),
      encoding: "utf8",
      env: { ...gitEnv, CODEX_CI: "1", CODEX_THREAD_ID: "" },
    });
    // AGENTS.md missing → version layer skipped → footer-present check passes → exit 0
    assert.equal(result.status, 0, "AGENTS.md missing MUST fail-open (not block on version layer)");
  } finally {
    try { rmSyncFs(tmp, { recursive: true, force: true }); } catch {}
  }
});

// T1(a)-fail-open: AGENTS.md unparseable → must NOT block on version mismatch
test("T1(a)-fail-open: AGENTS.md unparseable → gh body not blocked on version layer", () => {
  const r = runInRepo(
    'gh issue create --body "test content\nRules: v6.99.0 · Tool: claude-code · Model: claude-sonnet"',
    "no version line here at all\n"
  );
  // unparseable → null → fail-open → not blocked by version layer
  assert.equal(r.code, 0, "unparseable AGENTS.md version MUST fail-open");
});

// ── D6-F2: tool-brand sentence ban (prove-it pattern) ─────────────────────
// Block cases: whole-line brand-marker sentences
test("D6-F2-block: 'Made with Claude' whole-line brand marker → exit 1 (Attribution forbidden)", () => {
  const r = run({
    tool_input: {
      command: 'gh issue create --body "fix bug\n\nMade with Claude\n\nRules: v6.62.0 · Tool: Claude Code · Model: Opus 4.7"',
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Attribution forbidden/);
});

test("D6-F2-block: '🤖 Generated by Cursor' whole-line brand marker → exit 1 (Attribution forbidden)", () => {
  const r = run({
    tool_input: {
      command: 'gh issue create --body "fix bug\n\n🤖 Generated by Cursor\n\nRules: v6.62.0 · Tool: Claude Code · Model: Opus 4.7"',
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Attribution forbidden/);
});

test("D6-F2-block: 'Generated by Copilot' whole-line brand marker → exit 1 (Attribution forbidden)", () => {
  const r = run({
    tool_input: {
      command: 'gh pr create --title "PR" --body "summary\n\nGenerated by Copilot\n\nRules: v6.62.0 · Tool: Claude Code · Model: Opus 4.7"',
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Attribution forbidden/);
});

test("D6-F2-block: 'Made with Gemini' whole-line brand marker → exit 1 (Attribution forbidden)", () => {
  const r = run({
    tool_input: {
      command: 'gh issue comment 1 --body "text\n\nMade with Gemini\n\nRules: v6.62.0 · Tool: Claude Code · Model: Opus 4.7"',
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Attribution forbidden/);
});

// Not-block cases: natural prose containing the substring (regression guard)
test("D6-F2-not-block(natural prose): 'fix: handle files generated by the build' → NOT banned (mid-sentence)", () => {
  const r = run({
    tool_input: {
      command: 'gh issue create --body "fix: handle files generated by the build\n\nRules: v6.62.0 · Tool: Claude Code · Model: Opus 4.7"',
    },
  });
  assert.equal(r.code, 0, `natural prose 'generated by the build' MUST NOT be banned; got exit ${r.code}: ${r.stderr}`);
});

test("D6-F2-not-block(natural prose): 'feat: parser generated by codegen' → NOT banned (mid-sentence)", () => {
  const r = run({
    tool_input: {
      command: 'gh pr create --title "feat" --body "feat: parser generated by codegen\n\nRules: v6.62.0 · Tool: Claude Code · Model: Opus 4.7"',
    },
  });
  assert.equal(r.code, 0, `natural prose 'generated by codegen' MUST NOT be banned; got exit ${r.code}: ${r.stderr}`);
});

test("D6-F2-not-block(natural prose): 'made with care for edge cases' → NOT banned (lowercase non-brand)", () => {
  const r = run({
    tool_input: {
      command: 'gh issue create --body "made with care for edge cases\n\nRules: v6.62.0 · Tool: Claude Code · Model: Opus 4.7"',
    },
  });
  assert.equal(r.code, 0, `natural prose 'made with care' MUST NOT be banned; got exit ${r.code}: ${r.stderr}`);
});

test("D6-F2-not-block(natural prose): 'Generated by' alone with no capitalized brand → NOT banned", () => {
  const r = run({
    tool_input: {
      command: 'gh issue create --body "Generated by\n\nRules: v6.62.0 · Tool: Claude Code · Model: Opus 4.7"',
    },
  });
  assert.equal(r.code, 0, `'Generated by' alone (no brand word) MUST NOT be banned; got exit ${r.code}: ${r.stderr}`);
});

// ── D6-F2-over-block: documented precision tradeoff ──────────────────────────
// ACCEPTED TRADEOFF (per proposal D1/D2): F4/F5 patterns match any whole-line
// capitalized sentence of the form "Made with <CapWord>" or "Generated by
// <CapWord>", regardless of whether <CapWord> is an AI brand or a non-AI tool /
// library name. A sentence like "Made with <a capitalized tool name>" on its own
// whole line IS blocked — this is a known over-block that the proposal explicitly
// accepts because:
//   (a) AI commit messages rarely put such phrases as standalone footer lines, and
//   (b) precision-over-recall is the deliberate design choice (brand marker
//       convention = whole-line capitalized sentence).
// Guaranteed NOT to block: mid-sentence fragments, lowercase openers, or
// "<Verb> by/with" without a following capitalized word.
// If future work narrows the regex, this test MUST be updated consciously.
test("D6-F2-over-block(known tradeoff): 'Made with Hugo' whole-line → exit 1 (accepted precision over-block per D1/D2)", () => {
  // hasForbiddenAttribution returns true for this input — documented over-block.
  // "Hugo" is a capitalized non-AI tool name; the F4 pattern cannot distinguish
  // it from an AI brand marker. This is the precision-over-recall tradeoff
  // accepted in proposal D1/D2. The assertion INTENTIONALLY expects block=true.
  const r = run({
    tool_input: {
      command: 'gh issue create --body "fix bug\n\nMade with Hugo\n\nRules: v6.62.0 · Tool: Claude Code · Model: Opus 4.7"',
    },
  });
  assert.equal(r.code, 1, "KNOWN OVER-BLOCK: 'Made with Hugo' on its own line IS blocked by F4 (accepted tradeoff per D1/D2; update consciously if regex narrows)");
  assert.match(r.stderr, /Attribution forbidden/, "blocked with Attribution forbidden reason (expected over-block behavior)");
});

// ── D6-F2-hyphen: hyphenated/versioned brand name regression (cross-model) ────
// F4/F5 char class now includes hyphen [\w.\s-] to cover `<Tool>-<version>`
// style brand markers that AI naturally emits. These were SLIP cases before fix.
test("D6-F2-hyphen-block: 'Generated by GPT-4' whole-line versioned brand marker → exit 1 (Attribution forbidden)", () => {
  const r = run({
    tool_input: {
      command: 'gh issue create --body "fix bug\n\nGenerated by GPT-4\n\nRules: v6.62.0 · Tool: Claude Code · Model: Opus 4.7"',
    },
  });
  assert.equal(r.code, 1, "'Generated by GPT-4' whole-line versioned brand marker MUST block (F5 + hyphen fix); was SLIP before");
  assert.match(r.stderr, /Attribution forbidden/);
});

test("D6-F2-hyphen-block: 'Made with GPT-4.1' whole-line versioned brand marker → exit 1 (Attribution forbidden)", () => {
  const r = run({
    tool_input: {
      command: 'gh pr create --title "PR" --body "summary\n\nMade with GPT-4.1\n\nRules: v6.62.0 · Tool: Claude Code · Model: Opus 4.7"',
    },
  });
  assert.equal(r.code, 1, "'Made with GPT-4.1' whole-line versioned brand marker MUST block (F4 + hyphen fix); was SLIP before");
  assert.match(r.stderr, /Attribution forbidden/);
});

test("D6-F2-hyphen-block: 'Generated by Tool-Name' whole-line hyphenated brand marker → exit 1 (Attribution forbidden)", () => {
  const r = run({
    tool_input: {
      command: 'gh issue comment 1 --body "note\n\nGenerated by Tool-Name\n\nRules: v6.62.0 · Tool: Claude Code · Model: Opus 4.7"',
    },
  });
  assert.equal(r.code, 1, "'Generated by Tool-Name' whole-line hyphenated brand marker MUST block (F5 + hyphen fix)");
  assert.match(r.stderr, /Attribution forbidden/);
});

// ── CRR-1: reviewer-subprocess FS-isolation fail-open (D3 narrow exception) ──
// When hook process inherits DEVPRO_CROSS_MODEL_REVIEWER=1 (sanctioned reviewer
// subprocess env) and body source read fails (FS-isolation), hook SHALL fail-open
// (exit 0) instead of D3 fail-closed block.
// per decisions.md D1/D5 + code-review-checklist spec env contract.
test("CRR-1a: reviewer-env + --body-file missing → exit 0 (fail-open narrow exception)", () => {
  const r = run(
    { tool_input: { command: "gh pr comment 42 --body-file /tmp/nonexistent-gh-footer-crr1a" } },
    { DEVPRO_CROSS_MODEL_REVIEWER: "1" }
  );
  assert.equal(r.code, 0, "reviewer subprocess FS-isolation read-fail MUST fail-open (exit 0); hook not yet modified → expect RED");
});

// CRR-1b regression guard: no reviewer env → D3 fail-closed still applies
test("CRR-1b: no reviewer-env + --body-file missing → exit 1 (fail-closed D3, regression guard)", () => {
  const r = run(
    { tool_input: { command: "gh pr comment 42 --body-file /tmp/nonexistent-gh-footer-crr1b" } }
    // no DEVPRO_CROSS_MODEL_REVIEWER env
  );
  assert.equal(r.code, 1, "non-reviewer read-fail MUST remain fail-closed (D3)");
  assert.match(r.stderr, /fail-closed/, "D3 block reason must mention fail-closed");
});

// CRR-1c anti-bypass: reviewer-env + body-file present but footer missing → exit 1
// Proves fail-open is strictly bounded to the read-fail path; reviewer env does NOT
// bypass footer-missing, attribution, or version-equality checks.
test("CRR-1c: reviewer-env + --body-file present but footer missing → exit 1 (Footer missing)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-crr1c-${Date.now()}.md`);
  writeFileSync(tmp, "sticky comment body without any footer line");
  const r = run(
    { tool_input: { command: `gh pr comment 42 --body-file ${tmp}` } },
    { DEVPRO_CROSS_MODEL_REVIEWER: "1" }
  );
  assert.equal(r.code, 1, "reviewer env MUST NOT bypass footer-missing check (fail-open only covers read-fail)");
  assert.match(r.stderr, /Footer missing/, "must report Footer missing when body readable but footer absent");
});

// CRR-1d: reviewer-env strict-mix fail-open (intentional per D5: env-based, not command-mix-based)
//
// Design decision D5 (decisions.md): fail-open in reviewer subprocess is triggered by
// the DEVPRO_CROSS_MODEL_REVIEWER env flag, NOT by whether the command is a clean
// single-source or a strict-mix (--body + --body-file both present). The hook's
// reviewer-env branch short-circuits on ANY read-fail regardless of command shape.
//
// Contrast with normal session (no env): strict-mix --body <valid footer> +
// --body-file <missing> → exit 1 (covered by existing "mixed --body 含 footer +
// --body-file missing → exit 1 (strict fail-closed)" test at ~L318).
//
// This test locks that intentional asymmetry: same strict-mix command, different env,
// different outcome. Prevents future readers from misreading D5 as a bug.
// Ref: decisions.md D5, code-review-checklist spec output-discipline Scenario 7.
test("CRR-1d: reviewer-env strict-mix fail-open (intentional per D5: env-based, not command-mix-based) — --body <valid footer> + --body-file <missing> → exit 0", () => {
  const r = run(
    {
      tool_input: {
        command:
          'gh pr comment 99 --body "subject line\\n\\nRules: v6.66.1 · Tool: codex · Model: gpt-5.5" --body-file /tmp/nonexistent-gh-footer-crr1d',
      },
    },
    { DEVPRO_CROSS_MODEL_REVIEWER: "1" }
  );
  assert.equal(
    r.code,
    0,
    "reviewer subprocess strict-mix MUST fail-open (exit 0) — D5: env flag drives fail-open, not command shape; --body-file read-fail triggers FS-isolation path regardless of --body content"
  );
});

// ── T1 (缺陷 1 RED→GREEN): 無關 heredoc 不誤判 ────────────────────────────────
// Bug: heredocMatch (line 237) is the only body extractor NOT filtered by command-segment
// ownership. A compound command `gh pr create --body-file <valid-footer-file> && cat <<EOF
// <long no-footer text> EOF` causes the unrelated cat-heredoc body to be appended to the
// body buffer, pushing the valid footer beyond the 240-char tail window → false "Footer
// format mismatch" exit 1. The fix (T2) must make this exit 0.
//
// T1-RED: before the fix, this test MUST fail (exit 1 instead of expected 0).
// After the fix, this test MUST pass (exit 0 — gate does not misfire on unrelated heredoc).
test("T1-RED: 無關 heredoc 不誤判 — gh pr create --body-file <有 footer> && cat <<EOF <無 footer ≥240 字元> EOF → exit 0", () => {
  // Write a body file with a valid footer
  const bodyFile = path.join(os.tmpdir(), `gh-footer-gate-t1red-body-${Date.now()}.md`);
  writeFileSync(bodyFile, "## Summary\n- fix bug\n\nRules: v6.66.8 · Tool: Claude Code · Model: Sonnet 4.6");

  // The unrelated cat heredoc body is ≥240 chars with NO footer.
  // If heredocMatch is un-filtered, it appends this to body, pushing the valid footer
  // beyond the 240-char tail window → false "Footer format mismatch" / "Footer missing" exit 1.
  const noFooterLongText = "x".repeat(250);
  const command = `gh pr create --title "T1 RED test" --body-file ${bodyFile} && cat <<EOF\n${noFooterLongText}\nEOF`;

  const r = run({ tool_input: { command } });
  assert.equal(r.code, 0, `無關 heredoc 不誤判: gh pr create with valid --body-file followed by unrelated cat heredoc (no footer, ≥240 chars) MUST NOT block; got exit ${r.code}: ${r.stderr}`);
});

// T1-OWNED-HEREDOC-REGRESSION: genuine gh write-back with command-owned heredoc body
// missing footer must still block (owned-heredoc path must not be broken by T2 fix).
// This guards that the fix correctly distinguishes "heredoc owned by gh command" (should
// still be pulled into body buffer) vs "heredoc owned by unrelated command" (must not be).
// Shape mirrors existing line-334 test; added here as explicit regression guard for T1.
test("T1-owned-heredoc-regression: genuine gh write-back heredoc body 缺 footer 仍 block（T1 修後無回歸）", () => {
  // gh pr create --body-file - <<EOF: the heredoc IS the body source (owned by gh cmd).
  // This MUST still block after the T2 fix.
  const r = run({ tool_input: { command: `gh pr create --title t --body-file - <<EOF\nbody without footer owned heredoc\nEOF` } });
  assert.equal(r.code, 1, `genuine owned-heredoc body without footer MUST still block after T2 fix; got exit ${r.code}: ${r.stderr}`);
});

// ── W3C-footer: notes/tmp/ as new TL body destination for gh-footer-gate ────
// TL body files now live in notes/tmp/ of the main checkout (refactor-write-destinations-to-notes-tmp).
// The footer gate reads the file and validates footer — destination path is irrelevant to gate logic.
// These cases ensure the gate correctly passes/blocks based on footer presence, not path.
// FIXTURE_VERSION must match the fixture AGENTS.md to avoid version-equality block interference.

test("W3C-footer-pass: gh pr create --body-file <notes/tmp absolute path> with valid footer → exit 0", () => {
  // Use a fixture repo with pinned version to decouple from live AGENTS.md.
  const FIXTURE_VERSION = "6.78.1";
  const { dir: fixtureDir, cleanup } = makeTempRepo(`# AI Agent\n\n版本：${FIXTURE_VERSION}\n`);
  // Create notes/tmp directory and body file inside fixture repo.
  mkdirSync(path.join(fixtureDir, "notes", "tmp"), { recursive: true });
  const bodyFile = path.join(fixtureDir, "notes", "tmp", "remove-gh-body-pr-body-w3c-footer-pass.md");
  writeFileSync(
    bodyFile,
    `## Summary\n- add notes/tmp support\n\nRules: v${FIXTURE_VERSION} · Tool: Claude Code · Model: Sonnet 4.6`
  );
  try {
    const result = spawnSync("node", [HOOK], {
      input: JSON.stringify({
        tool_input: { command: `gh pr create --title t --body-file ${bodyFile}` },
        cwd: fixtureDir,
      }),
      encoding: "utf8",
      env: { ...process.env, CODEX_CI: "1", CODEX_THREAD_ID: "" },
    });
    assert.equal(
      result.status,
      0,
      `notes/tmp body file with valid footer MUST pass; stdout=${result.stdout}; stderr=${result.stderr}`
    );
  } finally {
    cleanup();
  }
});

test("W3C-footer-block: gh pr create --body-file <notes/tmp absolute path> without footer → block", () => {
  // Same setup but body file lacks footer — gate MUST block (footer missing).
  const FIXTURE_VERSION = "6.78.1";
  const { dir: fixtureDir, cleanup } = makeTempRepo(`# AI Agent\n\n版本：${FIXTURE_VERSION}\n`);
  mkdirSync(path.join(fixtureDir, "notes", "tmp"), { recursive: true });
  const bodyFile = path.join(fixtureDir, "notes", "tmp", "remove-gh-body-pr-body-w3c-footer-block.md");
  writeFileSync(
    bodyFile,
    "## Summary\n- add notes/tmp support\n\n(no footer here)"
  );
  try {
    const result = spawnSync("node", [HOOK], {
      input: JSON.stringify({
        tool_input: { command: `gh pr create --title t --body-file ${bodyFile}` },
        cwd: fixtureDir,
      }),
      encoding: "utf8",
      env: { ...process.env, CODEX_CI: "", CODEX_THREAD_ID: "" },
    });
    assert.equal(
      result.status,
      1,
      `notes/tmp body file without footer MUST block; stdout=${result.stdout}; stderr=${result.stderr}`
    );
    assert.match(result.stderr, /Footer missing/, `block reason must mention Footer missing; stderr=${result.stderr}`);
  } finally {
    cleanup();
  }
});

// ── B1 (round 9 Six-Axis Review Important finding): attached-form bare -F
// alias `-F<path>` (NO separator at all between the flag and its value) was
// invisible to detection ────────────────────────────────────────────────────
// BARE_F_DETECT_RE / F_ALIAS_ARG_RE / F_ALIAS_PRESENCE_RE all required an
// explicit `=` or whitespace between `-F` and its value (`(?:=|\s+)`, now the
// shared BARE_F_SEP fragment). gh, like any getopt/pflag-style CLI, also
// accepts a short flag with its value ATTACHED to the same argv token
// (`-F/path/to/file`, no separator) — that form never matched, so `gh pr
// create -F/path/to/body-without-footer.md` reached `gh` with NO footer
// audit at all: a genuine gate BYPASS, not merely a false positive
// (confirmed by repro against the pre-fix code: an identical footerless
// file blocked correctly via `-F <path>`, but passed silently via
// `-F<path>`). BARE_F_SEP was widened to make the separator optional,
// closing all three sites in one edit (AGENTS.md §0.10 — one duplicated fact
// fixed once, not three times).
test("B1 (RED): attached-form -F<path> (no separator) with MISSING footer must block (exit 1), not bypass", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-b1-nofooter-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({ tool_input: { command: `gh pr create --title t -F${tmp}` } });
  assert.equal(
    r.code,
    1,
    `attached-form -F<path> must be detected exactly like -F <path> and block on a missing footer, not silently bypass; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("B1-control: attached-form -F<path> (no separator) with VALID footer → exit 0 (non-regression anchor)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-b1-control-${Date.now()}.md`);
  writeFileSync(tmp, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const r = run({ tool_input: { command: `gh pr create --title t -F${tmp}` } });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
});

test("B1 reverse-lock: -F=body=@<file> typed-field equals-form must not regress into the bare-alias surface (exit 1, Footer missing — not a misleading read-failed block)", () => {
  // BARE_F_SEP's separator becoming optional gave the regex engine a SECOND
  // way to reach the shared BARE_F_NOT_TYPED_BODY lookahead for this exact
  // shape: backtracking to the empty alternative instead of consuming `=`,
  // landing the "not a typed-field body=" check one character too early (in
  // front of the `=` instead of in front of `body=`). Without the lookahead's
  // own `=?` this input would have regressed into being misread as the
  // bare-path alias, attempting to read a bogus path and reporting the wrong
  // (read-failed) reason instead of the correct footer-missing verdict.
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-b1-revlock-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({ tool_input: { command: `gh api repos/o/r/issues -F=body=@${tmp}` } });
  assert.equal(r.code, 1, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(
    r.stderr,
    /Footer missing/,
    `must resolve via the typed-field body=@ surface with the correct verdict, not the bare-path alias's read-failed message; stderr=${r.stderr}`
  );
});

// ── B2 (round 9 Six-Axis Review Important finding): a -F flag hijacked out
// of an unrelated $(...) subshell was misattributed to an outer gh
// invocation, corrupting write-back detection ──────────────────────────────
// ghInvocationSubcommandAt() resolved a candidate match's owning `gh`
// invocation by nearest-preceding command-position `gh` token, with no check
// for whether the match and that `gh` token share the same execution scope.
// shell-context.mjs's parseSegments recursively promotes $(...)/backtick
// inner content into flattened command-kind segments indistinguishable BY
// KIND from genuine top-level text, so a -F flag belonging to a completely
// unrelated command INSIDE a subshell (`$(grep -F feat notes.txt)`) was
// attributed to the OUTER `gh pr create` invocation. Confirmed by repro: `gh
// pr create --title $(grep -F feat notes.txt) --body-file <valid-footer
// path>` — a fully compliant write-back with a valid footer — was
// hard-blocked with "body source read failed" (D3), because the gate
// resolved the subshell's "-F feat" as the gh invocation's own bare-path
// alias and tried (and failed) to read a nonexistent file named "feat".
// Fixed by threading a `scope` id through parseSegments (a subshell's own
// opening offset becomes its promoted content's scope) and requiring
// ghInvocationSubcommandAt's owner search to match scope, not just
// precede-and-be-in-a-command-segment (see scopeIdAt, shell-context.mjs).
test("B2 (RED): -F inside an unrelated $(...) subshell must not be misattributed to the outer gh invocation's --body-file audit (exit 0, footer present and valid)", () => {
  const dir = makeTempDir("gh-footer-gate-b2-");
  const notesFile = path.join(dir, "notes.txt");
  writeFileSync(notesFile, "feat: something unrelated\n");
  const bodyFile = path.join(dir, "body-with-footer.md");
  writeFileSync(bodyFile, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  try {
    const r = run({
      tool_input: {
        command: `gh pr create --title $(grep -F feat ${notesFile}) --body-file ${bodyFile}`,
      },
    });
    assert.equal(
      r.code,
      0,
      `a -F flag inside an unrelated $(...) subshell must not be misattributed to the outer gh invocation's --body-file surface — the real --body-file has a valid footer and must pass; stdout=${r.stdout}; stderr=${r.stderr}`
    );
  } finally {
    rmSyncFs(dir, { recursive: true, force: true });
  }
});

test("B2 control: a GENUINE top-level bare -F <path> (no subshell) with a MISSING footer must still block (exit 1) — proves the scope fix does not disable real detection", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-b2-control-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({ tool_input: { command: `gh pr create --title t -F ${tmp}` } });
  assert.equal(r.code, 1, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Footer missing/);
});

// ── I-1 (round 10 Six-Axis Review Important finding): attached-form TYPED
// `-f`/`-F` field (`-Fbody=@<path>`, `-fbody=<text>` — NO separator at all
// between the flag and its `body=` value) was invisible to detection ───────
// WRITEBACK_FLAG_RE's `-f`/`-F` branches, F_FILE_ARG_RE/F_FILE_PRESENCE_RE,
// fBodyMatch, unsupportedTypedFieldMatch, and fSubshellMatch all required an
// explicit `=` or whitespace between the flag and `body=` (the old, still
// mandatory FLAG_VALUE_SEP). gh's typed `-F key=value` field, like its bare
// `-F <path>` alias (B1 above), also accepts the value ATTACHED to the same
// argv token with NO separator (`-Fbody=@x`, `-fbody=text`) — that form
// never matched any of the five sites, so it reached `gh` with NO write-back
// footer audit AND no raw-field body extraction into the attribution check:
// a genuine gate BYPASS (confirmed by repro against the pre-fix code — an
// identical footerless body blocked correctly via `-F body=@<path>` /
// `-f body="..."`, but passed silently via the attached form). Closed by a
// new TYPED_FIELD_SEP fragment (FLAG_VALUE_SEP's own value with the whole
// separator made optional, not a reuse of BARE_F_SEP — see the comment above
// TYPED_FIELD_SEP's definition for why those must stay separate constants),
// applied at all five call sites in one edit (AGENTS.md §0.10 — one
// duplicated fact fixed once, not five times).
test("I-1 (RED): attached-form -Fbody=@<file> (no separator) with MISSING footer must block (exit 1), not bypass", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-i1-nofooter-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({ tool_input: { command: `gh pr create --title t -Fbody=@${tmp}` } });
  assert.equal(
    r.code,
    1,
    `attached-form -Fbody=@<path> must be detected exactly like -F body=@<path> and block on a missing footer, not silently bypass; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("I-1-control: attached-form -Fbody=@<file> (no separator) with VALID footer → exit 0 (non-regression anchor)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-i1-control-${Date.now()}.md`);
  writeFileSync(tmp, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const r = run({ tool_input: { command: `gh pr create --title t -Fbody=@${tmp}` } });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
});

test("I-1b (RED): attached-form -fbody=<text> (raw-field, no separator) with MISSING footer must block (exit 1), not bypass", () => {
  const r = run({
    tool_input: { command: `gh pr create --title t -fbody=description-without-footer` },
  });
  assert.equal(
    r.code,
    1,
    `attached-form -fbody=<text> must be extracted into the audited body exactly like -f body="..."; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("I-1b-control: attached-form -fbody=<text> (raw-field, no separator) with VALID footer → exit 0 (non-regression anchor)", () => {
  const r = run({
    tool_input: {
      command: `gh pr create --title t "-fbody=description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"`,
    },
  });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
});

test("I-1c (RED): attached-form -Fbody=<unsupported typed value> (no separator, no @/$(cat…)) → exit 1 (fail closed)", () => {
  const r = run({ tool_input: { command: "gh pr create --title t -Fbody=plaintext-without-carrier" } });
  assert.equal(
    r.code,
    1,
    `attached-form unsupported typed -F body= value must fail closed exactly like the spaced/equals forms; stdout=${r.stdout}; stderr=${r.stderr}`
  );
});

test("I-1 reverse-lock: -F=body=@<file> equals-form (unaffected sibling shape) stays exit 1 on a missing footer — proves TYPED_FIELD_SEP did not disturb the existing equals-form path", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-i1-revlock-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({ tool_input: { command: `gh pr create --title t -F=body=@${tmp}` } });
  assert.equal(r.code, 1, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Footer missing/);
});

test("I-1 continuation preserved: -F body=@<file> split across backslash-continuation, valid footer → still exit 0 (TYPED_FIELD_SEP must not drop the T11 continuation grant)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-i1-cont-${Date.now()}.md`);
  writeFileSync(tmp, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const r = run({
    tool_input: { command: `gh api repos/o/r/issues -F \\\n  body=@${tmp}` },
  });
  assert.equal(r.code, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
});

// I-1d: fSubshellMatch (the -F/--field body=$(cat <path>) consumer, GFG-2/3
// above) was found still wired to the old mandatory FLAG_VALUE_SEP after the
// five sites above were fixed — same typed-field body= surface, same
// attached-form bypass class, just with a $(cat …) carrier instead of
// @path. Fixed to TYPED_FIELD_SEP alongside the other five for consistency
// (AGENTS.md §0.10).
test("I-1d (RED): attached-form -Fbody=$(cat <file>) (no separator) with MISSING footer must block (exit 1), not bypass", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-i1d-nofooter-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({ tool_input: { command: `gh pr create --title t -Fbody=$(cat ${tmp})` } });
  assert.equal(
    r.code,
    1,
    `attached-form -Fbody=$(cat <path>) must be detected exactly like -F body=$(cat <path>) and block on a missing footer, not silently bypass; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("I-1d-control: attached-form -Fbody=\"$(cat <file>)\" (no separator) with VALID footer → exit 0 (non-regression anchor)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-i1d-control-${Date.now()}.md`);
  writeFileSync(tmp, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const r = run({ tool_input: { command: `gh pr create --title t -Fbody="$(cat ${tmp})"` } });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
});

// I-1e/I-1f (round-11 remediation, documentation-accuracy finding): TYPED_FIELD_SEP
// sits between the flag NAME and `body=` identically on both the short-flag
// and long-flag branches of WRITEBACK_FLAG_RE / F_FILE_ARG_RE / fBodyMatch,
// with no flag-length-conditional gating — so the zero-width attached form
// also matches the LONG flag spelling (`--fieldbody=@<path>`,
// `--raw-fieldbody=<text>`), not only the short one exercised by I-1/I-1b
// above. `gh` itself has no such long-flag-with-no-separator syntax, so this
// is a benign accept-surface widening (pre-tool-mechanical-gates.md), not a
// sanctioned invocation form. These tests lock that the widening stays on the
// SAFE side — a footerless body on this shape still fails closed exactly as
// the short-flag form does — rather than silently reaching gh unaudited.
test("I-1e (RED): attached-form --fieldbody=@<file> (long flag, no separator) with MISSING footer must block (exit 1), not bypass", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-i1e-nofooter-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({ tool_input: { command: `gh pr create --title t --fieldbody=@${tmp}` } });
  assert.equal(
    r.code,
    1,
    `attached-form --fieldbody=@<path> must be detected exactly like -Fbody=@<path> and block on a missing footer, not silently bypass; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("I-1e-control: attached-form --fieldbody=@<file> (long flag, no separator) with VALID footer → exit 0 (non-regression anchor)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-i1e-control-${Date.now()}.md`);
  writeFileSync(tmp, "description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet");
  const r = run({ tool_input: { command: `gh pr create --title t --fieldbody=@${tmp}` } });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
});

test("I-1f (RED): attached-form --raw-fieldbody=<text> (long flag, no separator) with MISSING footer must block (exit 1), not bypass", () => {
  const r = run({
    tool_input: { command: `gh pr create --title t --raw-fieldbody=description-without-footer` },
  });
  assert.equal(
    r.code,
    1,
    `attached-form --raw-fieldbody=<text> must be extracted into the audited body exactly like --raw-field body="..."; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("I-1f-control: attached-form --raw-fieldbody=<text> (long flag, no separator) with VALID footer → exit 0 (non-regression anchor)", () => {
  const r = run({
    tool_input: {
      command: `gh pr create --title t "--raw-fieldbody=description\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet"`,
    },
  });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
});

// ── GFG-40 (round-26): dp-second-reviewer cross-model CRITICAL (PR #1895,
// dispatch-c2216e2f) — two new fail-open findings.
//
// Finding 1: shellInvocationEnd(start, hardEnd) scans forward from `start`
// for boundary chars (`&&`, `||`, `;`, `\n`, `|`, `&`), gating each candidate
// index only by inCmdSegment(index) (kind === "command"). It never checks
// scopeIdAt(index) against the scope of `start`. A $(...) / backtick
// subshell's content is flattened into "command"-kind segments but keeps a
// distinct non-null scope id — so a `;` INSIDE a nested subshell is wrongly
// treated as an outer invocation boundary, truncating the span
// ghInvocationSubcommandAt uses. A -F flag positioned after the subshell
// closes then falls outside the wrongly-shortened span and is never
// recognized as part of this gh invocation.
//
// Finding 2: ghSubcommandFrom() strips GH_GLOBAL_REPO_FLAG_RE via a single
// non-looped .exec() call. A SECOND leading --repo/-R occurrence survives
// stripping, so the plain two-token subcommand regex resolves to the
// still-present second `--repo owner/repo2` pair instead of the real
// subcommand — standing down all five subcommand-gated surfaces, the same
// failure class as round-20's original single-`--repo` bug, now recurring
// for the repeated-flag variant.
test("GFG-40a (RED, round-26): gh pr create --title $(printf x; printf y) -F <footerless>, `;` INSIDE the nested subshell must not be treated as an outer invocation boundary → exit 1, not silently bypassed", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg40a-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({
    tool_input: { command: `gh pr create --title $(printf x; printf y) -F ${tmp}` },
  });
  assert.equal(
    r.code,
    1,
    `a \`;\` inside a nested $(...) subshell must not truncate shellInvocationEnd's span and hide the trailing bare -F from detection; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("GFG-40b (control, round-26): gh pr create --title $(printf x) -F <footerless>, SAME shape but no nested separator → exit 1 (confirms the bug is specifically about a separator INSIDE the subshell, not the subshell itself)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg40b-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({
    tool_input: { command: `gh pr create --title $(printf x) -F ${tmp}` },
  });
  assert.equal(r.code, 1, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Footer missing/);
});

test("GFG-40c (RED, round-26, short-alias surface): gh pr edit --title $(printf x; printf y) -b <footerless> (BODY_SHORT_FLAG_SUBCOMMANDS surface, not bare -F) → exit 1 (proves the scope-blind shellInvocationEnd bug affects all subcommand-gated surfaces sharing it, not just bare -F)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg40c-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({
    tool_input: { command: `gh pr edit --title $(printf x; printf y) -b ${tmp}` },
  });
  assert.equal(
    r.code,
    1,
    `the -b short-flag surface shares shellInvocationEnd with bare -F and must be recognized identically; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("GFG-40d (RED, round-26): gh --repo owner/repo1 --repo owner/repo2 pr create -F <footerless>, a SECOND leading --repo occurrence must not survive stripping and corrupt subcommand resolution → exit 1, not silently bypassed", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg40d-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({
    tool_input: { command: `gh --repo owner/repo1 --repo owner/repo2 pr create -F ${tmp} --title t` },
  });
  assert.equal(
    r.code,
    1,
    `ghSubcommandFrom must loop-strip ALL leading --repo/-R occurrences, not just the first, so the real subcommand ("pr create") is resolved instead of the second --repo pair; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("GFG-40e (control, round-26): gh --repo owner/repo pr create -F <footerless>, SINGLE --repo occurrence (round-20's original fix) → still exit 1 (confirms the loop-strip fix does not regress the already-fixed single-flag case)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg40e-${Date.now()}.md`);
  writeFileSync(tmp, "description without footer");
  const r = run({
    tool_input: { command: `gh --repo owner/repo pr create -F ${tmp} --title t` },
  });
  assert.equal(r.code, 1, `stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Footer missing/);
});

test("GFG-40f (control, round-26): gh --repo owner/repo1 --repo owner/repo2 pr create -F <path>, VALID footer → exit 0 (genuine recognition after loop-strip, not an unconditional re-block)", () => {
  const tmp = path.join(os.tmpdir(), `gh-footer-gate-gfg40f-${Date.now()}.md`);
  writeFileSync(tmp, "description\nRules: v6.83.20 · Tool: claude-code · Model: claude-sonnet");
  const r = run({
    tool_input: { command: `gh --repo owner/repo1 --repo owner/repo2 pr create -F ${tmp} --title t` },
  });
  assert.equal(r.code, 0, `stdout=${r.stdout}; stderr=${r.stderr}`);
});

// ── #13 / 7.1 decoy-in-title (fix-gh-footer-gate-body-surface T1/T2) ─────
// fBodyMatch / fSubshellMatch (and unsupportedTypedFieldMatch) started at the
// flag alternative WITHOUT FLAG_TOKEN_START, so an unquoted bare token like
// `--title=hello-fbody=…` / `--title=hello-Fbody=$(cat …)` could match the
// `-fbody=` / `-Fbody=` substring INSIDE the title value and treat the decoy
// as a real body source — fail-open while the true --body stayed footerless.
test("T1-13a: --title=hello-fbody=<compact-footer-decoy> + footerless --body must block (exit 1), not treat the title substring as raw-field body", () => {
  const r = run({
    tool_input: {
      command:
        'gh pr create --title=hello-fbody=Rules:v6.83.20.Tool:x.Model:x --body "footerless body"',
    },
  });
  assert.equal(
    r.code,
    1,
    `decoy-in-title -fbody= substring must not be extracted as a body source; true footerless --body must fail closed; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

test("T1-13b: --title=hello-Fbody=$(cat <decoyWithFakeFooter>) + footerless --body must block (exit 1), not treat the title substring as field subshell body", () => {
  const decoy = path.join(os.tmpdir(), `gh-footer-gate-t1-13b-decoy-${Date.now()}.md`);
  writeFileSync(decoy, "decoy\nRules: v6.83.20 · Tool: x · Model: x");
  const r = run({
    tool_input: {
      command: `gh pr create --title=hello-Fbody=$(cat ${decoy}) --body "footerless body"`,
    },
  });
  assert.equal(
    r.code,
    1,
    `decoy-in-title -Fbody=$(cat …) substring must not be extracted as a body source; true footerless --body must fail closed; stdout=${r.stdout}; stderr=${r.stderr}`
  );
  assert.match(r.stderr, /Footer missing/);
});

// ── 6.2 hook-entry normalizeShellLineContinuations (T3/T4) ─────────────────
// Load the in-file helper without executing the CLI script (top-level side
// effects). Prove-it polarity: naive `/\\\r?\n/g` wrongly folds `\\\\`+newline.
function loadNormalizeShellLineContinuations() {
  const src = readFileSync(HOOK, "utf8");
  assert.match(
    src,
    /function normalizeShellLineContinuations\(raw\) \{/,
    "normalizeShellLineContinuations helper missing"
  );
  assert.doesNotMatch(
    src,
    /replace\(\s*\/\\\r\?\\n\/g\s*,\s*['"]{2}\s*\)/,
    "normalizeShellLineContinuations must not use unconditional /\\\\\\r?\\n/g → ''"
  );
  const start = src.indexOf("function normalizeShellLineContinuations(raw) {");
  assert.ok(start >= 0);
  let depth = 0;
  let end = -1;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > start, "could not slice normalizeShellLineContinuations body");
  const fnSrc = src.slice(start, end);
  assert.match(
    fnSrc,
    /\(\^\|\[\^\\\\\]\)\(\(\?:\\\\\\\\\)\*\)\\\\/,
    "helper must fold only odd trailing backslash before newline (not naive global)"
  );
  return new Function(`${fnSrc}; return normalizeShellLineContinuations;`)();
}

test("T3-6.2a: true continuation (single \\ + newline) folds", () => {
  const normalize = loadNormalizeShellLineContinuations();
  assert.equal(normalize("gh pr create \\\n  --body x"), "gh pr create   --body x");
  assert.equal(normalize("a\\\r\nb"), "ab");
});

test("T3-6.2b: lone \\ not followed by newline is unchanged", () => {
  const normalize = loadNormalizeShellLineContinuations();
  assert.equal(normalize("C:\\Users\\foo"), "C:\\Users\\foo");
  assert.equal(normalize("path\\"), "path\\");
});

test("T3-6.2c (WARN negative): \\\\ + newline MUST NOT fold — string still contains newline (naive /\\\\\\r?\\n/g wrongly folds)", () => {
  const input = "prefix\\\\\nsuffix"; // two backslashes, then newline
  const naive = input.replace(/\\\r?\n/g, "");
  assert.equal(
    naive.includes("\n"),
    false,
    "prove-it: naive global fold removes the newline between \\\\ and the next line"
  );
  const normalize = loadNormalizeShellLineContinuations();
  const out = normalize(input);
  assert.equal(
    out.includes("\n"),
    true,
    `odd-count-only fold must keep the newline after an even backslash run; got ${JSON.stringify(out)}`
  );
  assert.equal(out, input);
});
