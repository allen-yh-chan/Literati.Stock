import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import "./lib/owned-friction-log.mjs";
import { classifyHighOutput, highOutputBlockReason, __test } from "../hooks/lib/high-output-command.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";

const HOOK = path.join(REPO_ROOT, ".devpro", "scripts", "hooks", "pre-tool-gate.mjs");

// Spawn the real pre-tool-gate hook with a Bash payload; returns parsed decision.
function runHook(command, extra = {}) {
  const payload = {
    tool_name: "Bash",
    tool_input: { command },
    cwd: REPO_ROOT,
    ...extra,
  };
  const res = spawnSync("node", [HOOK, "PreToolUse", "--host=claude-code"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, DEVPRO_AGENT_RULES_LEVEL: "full" },
  });
  let json = null;
  if (res.stdout && res.stdout.trim()) {
    try {
      json = JSON.parse(res.stdout);
    } catch {
      // non-JSON stdout (advisory text) — leave json null
    }
  }
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

describe("Invariant 1: high-output raw-command classifier (lib)", () => {
  it("flags bare `node --test .devpro/scripts/tests/` as high-output", () => {
    const c = classifyHighOutput("node --test .devpro/scripts/tests/");
    assert.equal(c.highOutput, true);
    assert.equal(c.id, "source-test-suite");
    assert.equal(c.redirected, false);
  });

  it("flags `openspec validate --strict --all` in either flag order", () => {
    assert.equal(classifyHighOutput("openspec validate --strict --all").highOutput, true);
    assert.equal(classifyHighOutput("openspec validate --all --strict").highOutput, true);
  });

  it("flags `gh run view --log` and `--log-failed`", () => {
    assert.equal(classifyHighOutput("gh run view 123 --log").highOutput, true);
    assert.equal(classifyHighOutput("gh run view 123 --log-failed").highOutput, true);
  });

  it("flags `claude -p ... --output-format stream-json` reviewer stream", () => {
    assert.equal(
      classifyHighOutput('claude -p "review this" --output-format stream-json --verbose').highOutput,
      true
    );
  });

  it("does NOT flag a high-output command redirected to notes/tmp (escape hatch)", () => {
    const c = classifyHighOutput("node --test .devpro/scripts/tests/ > notes/tmp/devpro-test.log 2>&1");
    assert.equal(c.id, "source-test-suite", "still identifies the producer");
    assert.equal(c.redirected, true, "redirect detected");
    assert.equal(c.highOutput, false, "redirected → not blocked");
  });

  it("does NOT flag documented capture-command wrappers around high-output producers", () => {
    for (const command of [
      "node .devpro/scripts/capture-command.mjs --topic devpro-test -- node --test .devpro/scripts/tests/",
      "node .devpro/scripts/capture-command.mjs --topic devpro-test -- node --test .devpro/scripts/tests/ | cat",
      "node .devpro/scripts/capture-command.mjs --topic openspec -- openspec validate --strict --all",
      "node .devpro/scripts/capture-command.mjs --topic ci-log -- gh run view 123 --log",
      "/Users/agent/.nvm/versions/node/v20.19.0/bin/node .devpro/scripts/capture-command.mjs --topic devpro-test -- node --test .devpro/scripts/tests/",
    ]) {
      const c = classifyHighOutput(command);
      assert.equal(c.redirected, true, `${command} should be treated as captured`);
      assert.equal(c.highOutput, false, `${command} should not be blocked`);
    }
  });

  it("does not let malformed or non-leading capture-command mentions bypass high-output producers", () => {
    for (const command of [
      "node .devpro/scripts/capture-command.mjs --topic x node --test .devpro/scripts/tests/",
      "node .devpro/scripts/capture-command.mjs -- node --test .devpro/scripts/tests/",
      "node ./other/capture-command.mjs --topic x -- node --test .devpro/scripts/tests/",
      "echo node .devpro/scripts/capture-command.mjs --topic x -- node --test .devpro/scripts/tests/",
      "node --test .devpro/scripts/tests/ node .devpro/scripts/capture-command.mjs --topic x --",
      "node .devpro/scripts/capture-command.mjs --topic x -- echo ok | node --test .devpro/scripts/tests/",
      "node .devpro/scripts/capture-command.mjs --topic x -- echo ok | openspec validate --strict --all",
      "node .devpro/scripts/capture-command.mjs --topic x -- echo ok | gh run view 123 --log",
    ]) {
      const c = classifyHighOutput(command);
      assert.equal(c.highOutput, true, `${command} must still be blocked`);
      assert.equal(c.redirected, false, `${command} must not be treated as captured`);
    }
  });

  it("does NOT flag capture-command wrappers behind leading env assignments", () => {
    for (const command of [
      "PATH=/Users/agent/.nvm/versions/node/v20.19.0/bin:$PATH node .devpro/scripts/capture-command.mjs --topic openspec -- openspec validate --strict --all",
      "NODE_OPTIONS= PATH=/opt/node/bin:$PATH node .devpro/scripts/capture-command.mjs --topic devpro-test -- node --test .devpro/scripts/tests/",
      "PATH=/opt/node/bin:$PATH /opt/node/bin/node ./.devpro/scripts/capture-command.mjs --topic ci-log -- gh run view 123 --log",
    ]) {
      const c = classifyHighOutput(command);
      assert.equal(c.redirected, true, `${command} should be treated as captured`);
      assert.equal(c.highOutput, false, `${command} should not be blocked`);
    }
  });

  it("does NOT flag an absolute helper path the caller resolves as repo-local", () => {
    const repoLocal = [
      "/Users/agent/repo/.worktree/fix-x/.devpro/scripts/capture-command.mjs",
      "/Users/agent/repo/.devpro/scripts/capture-command.mjs",
    ];
    let lookups = 0;
    const options = {
      resolveRepoLocalHelperPaths: () => {
        lookups += 1;
        return repoLocal;
      },
    };
    for (const command of [
      "node /Users/agent/repo/.devpro/scripts/capture-command.mjs --topic openspec -- openspec validate --strict --all",
      "PATH=/opt/node/bin:$PATH /opt/node/bin/node /Users/agent/repo/.worktree/fix-x/.devpro/scripts/capture-command.mjs --topic ci-log -- gh run view 123 --log",
    ]) {
      const c = classifyHighOutput(command, command, options);
      assert.equal(c.redirected, true, `${command} should be treated as captured`);
      assert.equal(c.highOutput, false, `${command} should not be blocked`);
    }
    assert.equal(lookups, 2, "resolver runs once per absolute helper candidate");

    lookups = 0;
    classifyHighOutput(
      "node .devpro/scripts/capture-command.mjs --topic x -- openspec validate --strict --all",
      undefined,
      options
    );
    classifyHighOutput("openspec validate --strict --all", undefined, options);
    assert.equal(lookups, 0, "resolver must stay unused without an absolute helper candidate");
  });

  it("does NOT flag a drive-letter helper path the caller resolves as repo-local", () => {
    // The resolver returns native Windows paths; a Bash command names the same file with forward slashes.
    const options = {
      resolveRepoLocalHelperPaths: () => ["C:\\Users\\agent\\repo\\.devpro\\scripts\\capture-command.mjs"],
    };
    for (const command of [
      "node C:/Users/agent/repo/.devpro/scripts/capture-command.mjs --topic openspec -- openspec validate --strict --all",
      "node c:/users/agent/repo/.devpro/scripts/capture-command.mjs --topic openspec -- openspec validate --strict --all",
      "node C:/Users/agent/repo/.DEVPRO/Scripts/capture-command.mjs --topic openspec -- openspec validate --strict --all",
    ]) {
      const c = classifyHighOutput(command, command, options);
      assert.equal(c.redirected, true, `${command} should be treated as captured`);
      assert.equal(c.highOutput, false, `${command} should not be blocked`);
    }
    for (const command of [
      "node C:/Users/agent/other-repo/.devpro/scripts/capture-command.mjs --topic x -- node --test .devpro/scripts/tests/",
      "node D:/Users/agent/repo/.devpro/scripts/capture-command.mjs --topic x -- node --test .devpro/scripts/tests/",
      "node C:/Users/agent/repo/x/../.devpro/scripts/capture-command.mjs --topic x -- node --test .devpro/scripts/tests/",
    ]) {
      const c = classifyHighOutput(command, command, options);
      assert.equal(c.highOutput, true, `${command} must still be blocked`);
    }
    // A POSIX resolver answer stays case-sensitive.
    const posix = { resolveRepoLocalHelperPaths: () => ["/Users/agent/repo/.devpro/scripts/capture-command.mjs"] };
    const wrongCase = "node /users/agent/repo/.devpro/scripts/capture-command.mjs --topic x -- node --test .devpro/scripts/tests/";
    assert.equal(classifyHighOutput(wrongCase, wrongCase, posix).highOutput, true);
  });

  it("keeps blocking raw producers and look-alike helpers behind env assignments or absolute paths", () => {
    const options = {
      resolveRepoLocalHelperPaths: () => ["/Users/agent/repo/.devpro/scripts/capture-command.mjs"],
    };
    for (const command of [
      "PATH=/opt/node/bin:$PATH node --test .devpro/scripts/tests/",
      "PATH=/opt/node/bin:$PATH openspec validate --strict --all",
      "PATH=/opt/node/bin:$PATH echo node .devpro/scripts/capture-command.mjs --topic x -- node --test .devpro/scripts/tests/",
      "PATH=/opt/node/bin:$PATH node .devpro/scripts/capture-command.mjs --topic x -- echo ok | node --test .devpro/scripts/tests/",
      "node /Users/agent/other-repo/.devpro/scripts/capture-command.mjs --topic x -- node --test .devpro/scripts/tests/",
      "node /Users/agent/repo/other/capture-command.mjs --topic x -- node --test .devpro/scripts/tests/",
      "node /Users/agent/repo/x/../.devpro/scripts/capture-command.mjs --topic x -- node --test .devpro/scripts/tests/",
      "node repo/.devpro/scripts/capture-command.mjs --topic x -- node --test .devpro/scripts/tests/",
    ]) {
      const c = classifyHighOutput(command, command, options);
      assert.equal(c.highOutput, true, `${command} must still be blocked`);
      assert.equal(c.redirected, false, `${command} must not be treated as captured`);
    }
    const repoHelper = "node /Users/agent/repo/.devpro/scripts/capture-command.mjs --topic x -- node --test .devpro/scripts/tests/";
    assert.equal(classifyHighOutput(repoHelper).highOutput, true, "no resolver → absolute helper path is not exempt");
  });

  it("does NOT flag mktemp-into-var then redirect (documented portable pattern)", () => {
    const cmd =
      'repo_root=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)"); mkdir -p "$repo_root/notes/tmp"; log=$(mktemp "$repo_root/notes/tmp/devpro-test.XXXXXX"); node --test .devpro/scripts/tests/ >"$log" 2>&1';
    const c = classifyHighOutput(cmd);
    assert.equal(c.redirected, true);
    assert.equal(c.highOutput, false);
  });

  it("does NOT flag redirect into notes/tmp absolute path", () => {
    const c = classifyHighOutput("openspec validate --strict --all > /repo/notes/tmp/openspec-validate.log 2>&1");
    assert.equal(c.highOutput, false);
  });

  it("redirect to ANY file (incl repo-relative) discharges the gate — output left the transcript", () => {
    // Mechanical bar is "stdout not in transcript"; repo-external is preferred but a
    // bare-file redirect still means raw output does not flood the transcript.
    const c = classifyHighOutput("node --test .devpro/scripts/tests/ > out.txt 2>&1");
    assert.equal(c.redirected, true);
    assert.equal(c.highOutput, false);
  });

  it("stderr-only redirect (2>) does NOT discharge the gate (stdout still floods transcript)", () => {
    const c = classifyHighOutput("node --test .devpro/scripts/tests/ 2>err.log");
    assert.equal(c.redirected, false, "2> redirects only stderr; stdout still hits transcript");
    assert.equal(c.highOutput, true);
  });

  it("does NOT flag a SPECIFIC test file run (bounded output), only the directory-level full suite", () => {
    // Running one file or a name-pattern filter is tens of lines, not the full suite.
    assert.equal(
      classifyHighOutput("node --test .devpro/scripts/tests/high-output-command-gate.test.mjs").highOutput,
      false,
      "single .test.mjs file is bounded"
    );
    assert.equal(
      classifyHighOutput("node --test .devpro/scripts/tests/foo.test.mjs").highOutput,
      false
    );
    // The directory-level run IS flagged.
    assert.equal(classifyHighOutput("node --test .devpro/scripts/tests/").highOutput, true);
    assert.equal(classifyHighOutput("node --test .devpro/scripts/tests").highOutput, true);
  });

  it("flags repo-wide `rg -n <pattern>` with no path narrowing", () => {
    const c = classifyHighOutput("rg -n 'TODO'");
    assert.equal(c.highOutput, true);
    assert.equal(c.id, "repo-wide-rg");
  });

  it("does NOT flag rg with a narrowing pathspec", () => {
    assert.equal(classifyHighOutput("rg -n 'TODO' .devpro/agent-rules/").highOutput, false);
    assert.equal(classifyHighOutput("rg -n 'TODO' src/foo.mjs").highOutput, false);
  });

  it("flags broad multi-root rg even without max-count", () => {
    const c = classifyHighOutput("rg -n 'TODO' .devpro/agent-rules .devpro/scripts");
    assert.equal(c.highOutput, true);
    assert.equal(c.id, "repo-wide-rg");
    assert.equal(classifyHighOutput("rg -n 'TODO' .devpro/agent-rules/ .devpro/scripts/").highOutput, true);
    assert.equal(classifyHighOutput("rg -n 'TODO' .claude/agents .claude/commands").highOutput, true);
  });

  it("does NOT flag concrete-file multi-path rg", () => {
    assert.equal(classifyHighOutput("rg -n 'TODO' AGENTS.md README.md").highOutput, false);
    assert.equal(
      classifyHighOutput(
        "rg -n 'TODO' .devpro/scripts/hooks/lib/high-output-command.mjs .devpro/scripts/tests/high-output-command-gate.test.mjs"
      ).highOutput,
      false
    );
    assert.equal(classifyHighOutput("rg -n 'TODO' bin/tool scripts/run").highOutput, false);
    assert.equal(classifyHighOutput("rg -n -m 5 'TODO' bin/tool scripts/run").highOutput, false);
  });

  it("allows broad multi-root rg when output is redirected or bounded", () => {
    assert.equal(
      classifyHighOutput("rg -n 'TODO' .devpro/agent-rules .devpro/scripts > notes/tmp/rg.log").highOutput,
      false
    );
    assert.equal(
      classifyHighOutput("rg -n 'TODO' .devpro/agent-rules .devpro/scripts | head -50").highOutput,
      false
    );
    assert.equal(
      classifyHighOutput("rg -n 'TODO' .devpro/agent-rules .devpro/scripts | wc -l").highOutput,
      false
    );
  });

  it("does NOT flag rg discovery/sizing forms (-l, --count, --files)", () => {
    assert.equal(classifyHighOutput("rg -l 'TODO'").highOutput, false);
    assert.equal(classifyHighOutput("rg --count 'TODO'").highOutput, false);
    assert.equal(classifyHighOutput("rg --files").highOutput, false);
    assert.equal(classifyHighOutput("rg -l 'TODO' .devpro/agent-rules .devpro/scripts").highOutput, false);
    assert.equal(classifyHighOutput("rg --count 'TODO' .devpro/agent-rules .devpro/scripts").highOutput, false);
  });

  it("flags repo-wide rg with -m / --max-count because max-count is per-file", () => {
    assert.equal(classifyHighOutput("rg -n -m 5 'TODO'").highOutput, true);
    assert.equal(classifyHighOutput("rg -n --max-count 5 'TODO'").highOutput, true);
    assert.equal(classifyHighOutput("rg -n --max-count=5 TODO").highOutput, true);
  });

  it("does NOT flag rg with -m when narrowed to one pathspec", () => {
    assert.equal(
      classifyHighOutput("rg -n -m 5 'TODO' .devpro/agent-rules/token-frugal-io.md").highOutput,
      false
    );
    assert.equal(classifyHighOutput("rg -n --max-count 5 'TODO' src/foo.mjs").highOutput, false);
  });

  it("flags broad multi-path rg even when -m is present", () => {
    const c = classifyHighOutput("rg -n -m 20 'TODO' AGENTS.md .devpro README.md");
    assert.equal(c.highOutput, true);
    assert.equal(c.id, "repo-wide-rg");
  });

  it("flags rg with an unrelated --glob constraint", () => {
    assert.equal(classifyHighOutput("rg -n 'TODO' --glob '!archive'").highOutput, true);
  });

  it("C4: FLAGS repo-wide `rg -n -C 3 TODO` (context-flag value must not be read as a pathspec)", () => {
    // -C consumes `3`; `TODO` is the pattern; no real pathspec → repo-wide → flagged.
    assert.equal(classifyHighOutput("rg -n -C 3 TODO").highOutput, true);
    assert.equal(classifyHighOutput("rg -n -A 2 -B 2 ERROR").highOutput, true);
    assert.equal(classifyHighOutput("rg -n -e somePattern").highOutput, true);
  });

  it("C4: still NOT flagged when a real pathspec follows the context flag", () => {
    assert.equal(classifyHighOutput("rg -n -C 3 TODO src/").highOutput, false);
    assert.equal(classifyHighOutput("rg -n -C 3 TODO .devpro/agent-rules/foo.md").highOutput, false);
  });

  it("C4: =-joined flag value stays inline (does not consume the pattern)", () => {
    assert.equal(classifyHighOutput("rg -n --max-count=5 TODO").highOutput, true, "--max-count=5 is per-file, not a repo-wide bound");
    assert.equal(classifyHighOutput("rg -n -C3 TODO").highOutput, true, "-C3 inline; TODO is pattern; repo-wide");
  });

  it("does NOT flag a piped/stdin rg — bounded by upstream, not a repo traversal", () => {
    // `git status | rg …` / `cat f | rg …` scan only piped input, not the filesystem.
    assert.equal(classifyHighOutput("git status --short | rg '^\\?\\?'").highOutput, false);
    assert.equal(classifyHighOutput("cat file.log | rg -n 'ERROR'").highOutput, false);
    assert.equal(classifyHighOutput("foo | bar | rg -n 'x'").highOutput, false);
    // But a leading (non-piped) repo-wide rg is still flagged.
    assert.equal(classifyHighOutput("rg -n 'x'").highOutput, true);
  });

  it("ignores empty / non-matching commands", () => {
    assert.equal(classifyHighOutput("").highOutput, false);
    assert.equal(classifyHighOutput("git status --short").highOutput, false);
    assert.equal(classifyHighOutput("npm run build --silent").highOutput, false);
  });

  it("R2-4: per-statement — a raw producer in ANY statement is flagged (multi-invocation bypass closed)", () => {
    // A sizing flag / redirect in one statement must NOT mask a raw producer in another.
    assert.equal(classifyHighOutput("rg -l TODO; rg -n FIXME").highOutput, true, "second raw rg caught");
    assert.equal(classifyHighOutput("echo hi > out.txt; rg -n FIXME").highOutput, true, "redirect belongs to echo, not rg");
    assert.equal(classifyHighOutput("node --test .devpro/scripts/tests/ ; echo done").highOutput, true);
    assert.equal(classifyHighOutput("openspec validate --strict --all && echo done").highOutput, true);
  });

  it("R2-4: a redirect in the SAME statement as the producer still discharges it", () => {
    assert.equal(classifyHighOutput("node --test .devpro/scripts/tests/ >/tmp/x.log 2>&1; echo done").highOutput, false);
    assert.equal(classifyHighOutput("ls; rg -n FIXME >/tmp/out.log").highOutput, false);
  });

  it("R4-C1: `rg … .` / `./` (CWD = whole repo) is NOT treated as narrowed", () => {
    assert.equal(classifyHighOutput("rg -n TODO .").highOutput, true);
    assert.equal(classifyHighOutput("rg -n TODO ./").highOutput, true);
    // A real sub-path still narrows.
    assert.equal(classifyHighOutput("rg -n TODO ./src").highOutput, false);
  });

  it("incident: whole-tree rg with unrelated exclude globs is still broad", () => {
    const cmd = "rg -n TODO . --glob '!node_modules' --glob '!dist' --glob '!build'";
    const c = classifyHighOutput(cmd);
    assert.equal(c.highOutput, true);
    assert.equal(c.id, "repo-wide-rg");
  });

  it("allows whole-tree rg only when the repo forbidden paths are explicitly excluded", () => {
    const cmd = "rg -n TODO . --glob '!openspec/changes/archive' --glob '!.worktree' --glob '!refs'";
    assert.equal(classifyHighOutput(cmd).highOutput, false);
  });

  it("allows attached -g forbidden-path exclusions", () => {
    const cmd = "rg -n TODO . -g'!openspec/changes/archive' -g'!.worktree' -g'!refs'";
    assert.equal(classifyHighOutput(cmd).highOutput, false);
  });

  it("does NOT treat branch/path text containing rg as a ripgrep command", () => {
    const cmd =
      "git worktree add /repo/.worktree/fix-high-output-rg-glob-narrowing -b chore/fix-high-output-rg-glob-narrowing abc123";
    assert.equal(classifyHighOutput(cmd).highOutput, false);
  });

  it("R4-C2: a producer piped into a BOUNDING pager (| head/tail/wc) is not a flood", () => {
    assert.equal(classifyHighOutput("rg -n TODO | head -50").highOutput, false);
    assert.equal(classifyHighOutput("rg -n TODO | tail -20").highOutput, false);
    assert.equal(classifyHighOutput("rg -n TODO | wc -l").highOutput, false);
    assert.equal(classifyHighOutput("node --test .devpro/scripts/tests/ | head").highOutput, false);
    // A non-bounding downstream (cat/tee) still floods → flagged.
    assert.equal(classifyHighOutput("rg -n TODO | cat").highOutput, true);
    assert.equal(classifyHighOutput("rg -n TODO | tee /tmp/x").highOutput, true);
  });

  it("R3-C1: rg PRODUCING output to a downstream pipe (rg … | cat) is flagged (not narrowed)", () => {
    // A downstream command token after `|` must NOT be read as rg's narrowing pathspec.
    assert.equal(classifyHighOutput("rg -n TODO | cat").highOutput, true);
    assert.equal(classifyHighOutput("rg -n TODO | tee /tmp/x").highOutput, true);
    // (`| head` is a BOUNDING pager → not flagged; covered by the R4-C2 case above.)
    // rg CONSUMING a pipe (| before rg) stays exempt; a real pathspec before the pipe too.
    assert.equal(classifyHighOutput("git status | rg x").highOutput, false);
    assert.equal(classifyHighOutput("rg -n TODO src/ | cat").highOutput, false);
    assert.equal(classifyHighOutput("rg -l TODO | cat").highOutput, false);
  });

  it("R2-5: claude reviewer stream-json is flagged regardless of flag order", () => {
    assert.equal(classifyHighOutput('claude -p "x" --output-format stream-json').highOutput, true);
    assert.equal(classifyHighOutput('claude --output-format stream-json -p "x"').highOutput, true);
    assert.equal(classifyHighOutput('claude --print "x" --output-format stream-json').highOutput, true);
    // A plain claude invocation without the stream/verbose flag is not flagged.
    assert.equal(classifyHighOutput('claude -p "quick question"').highOutput, false);
  });

  it("attached -ePATTERN is recognized as the rg pattern (Important)", () => {
    // `rg -n -efoo` supplies the pattern via -e; still repo-wide → flagged, not skipped.
    assert.equal(classifyHighOutput("rg -n -efoo").highOutput, true);
    assert.equal(classifyHighOutput("rg -n -efoo src/").highOutput, false, "narrowed by src/");
  });

  it("does NOT false-positive when the command name appears only in a quoted echo", () => {
    // pre-tool-gate passes segment text with quoted strings stripped, but the lib must
    // also be reasonable on raw text: an echo of the phrase is not an invocation.
    // (Segment-stripping is verified via the hook integration test below.)
    const c = classifyHighOutput('echo "remember to run node --test .devpro/scripts/tests/ later"');
    // Raw text still contains the tokens; the hook strips the quoted region. Here we
    // assert the lib at least identifies the producer so the hook's stripping is what
    // prevents the false-positive (documented contract).
    assert.equal(c.id, "source-test-suite");
  });

  it("block reason names the producer and the temp-log pattern", () => {
    const reason = highOutputBlockReason({ id: "source-test-suite", label: "node --test ..." });
    assert.match(reason, /High-Output Command Hard Gate/);
    assert.match(reason, /notes\/tmp/);
    assert.match(reason, /capture-command\.mjs/);
    assert.doesNotMatch(reason, /\/tmp\/agent-out/);
    assert.match(reason, /mktemp/);
    assert.match(reason, /compact summary/);
    assert.match(reason, /log path/);
  });

  it("preferred-log target detector recognizes notes/tmp and rejects legacy temp sinks", () => {
    assert.equal(__test.isPreferredLogTarget("notes/tmp/devpro-test.log"), true);
    assert.equal(__test.isPreferredLogTarget("./notes/tmp/devpro-test.log"), true);
    assert.equal(__test.isPreferredLogTarget("/repo/notes/tmp/devpro-test.log"), true);
    assert.equal(__test.isPreferredLogTarget("/tmp/agent-out/x.log"), false);
    assert.equal(__test.isPreferredLogTarget("$TMPDIR/x"), false);
    assert.equal(__test.isPreferredLogTarget("out.txt"), false);
    assert.equal(
      __test.wrapsWithCaptureCommand(
        "node .devpro/scripts/capture-command.mjs --topic devpro-test -- node --test .devpro/scripts/tests/"
      ),
      true
    );
  });
});

describe("Invariant 1: pre-tool-gate hook integration (real spawn)", () => {
  it("BLOCKS bare full source test suite", () => {
    const r = runHook("node --test .devpro/scripts/tests/");
    assert.equal(r.code, 0, "hook exits 0 with JSON block decision");
    assert.ok(r.json, "must emit a JSON decision");
    assert.equal(r.json.decision, "block");
    assert.match(r.json.reason, /High-Output Command Hard Gate/);
  });

  it("ALLOWS the same command when redirected to notes/tmp", () => {
    const r = runHook(
      'mkdir -p notes/tmp; log=$(mktemp "notes/tmp/devpro-test.XXXXXX"); node --test .devpro/scripts/tests/ >"$log" 2>&1; rc=$?'
    );
    // Either no JSON (pass) or a non-high-output decision; must NOT be a high-output block.
    if (r.json && r.json.decision === "block") {
      assert.doesNotMatch(r.json.reason, /High-Output Command Hard Gate/, "redirected form must not trip the high-output gate");
    }
  });

  it("ALLOWS the same command when wrapped by capture-command", () => {
    const r = runHook("node .devpro/scripts/capture-command.mjs --topic devpro-test -- node --test .devpro/scripts/tests/");
    if (r.json && r.json.decision === "block") {
      assert.doesNotMatch(r.json.reason, /High-Output Command Hard Gate/, "capture-command wrapper must not trip the high-output gate");
    }
  });

  it("ALLOWS issue #1853 exact OpenSpec command when wrapped by capture-command", () => {
    const r = runHook(
      "node .devpro/scripts/capture-command.mjs --topic release-rules-20260728-openspec -- openspec validate --strict --all"
    );
    assert.equal(r.code, 0, "hook process must exit successfully");
    if (r.json && r.json.decision === "block") {
      assert.doesNotMatch(
        r.json.reason,
        /High-Output Command Hard Gate/,
        "issue #1853 exact OpenSpec capture command must not trip the high-output gate"
      );
    }
  });

  it("ALLOWS the capture-command wrapper behind a PATH assignment and an absolute repo helper path", () => {
    // Forward slashes: a backslash path pasted unquoted into a Bash command is not the same path.
    const helper = path.join(REPO_ROOT, ".devpro", "scripts", "capture-command.mjs").split(path.sep).join("/");
    for (const command of [
      `PATH="/opt/node/bin:$PATH" node ${helper} --topic openspec -- openspec validate --strict --all`,
      `PATH=/opt/node/bin:$PATH node .devpro/scripts/capture-command.mjs --topic openspec -- openspec validate --strict --all`,
    ]) {
      const r = runHook(command);
      assert.equal(r.code, 0, "hook process must exit successfully");
      if (r.json && r.json.decision === "block") {
        assert.doesNotMatch(r.json.reason, /High-Output Command Hard Gate/, `${command} must not trip the high-output gate`);
      }
    }
  });

  it("BLOCKS a raw producer behind a PATH assignment and another repo's absolute helper path", () => {
    for (const command of [
      'PATH="/opt/node/bin:$PATH" openspec validate --strict --all',
      "node /opt/elsewhere/.devpro/scripts/capture-command.mjs --topic openspec -- openspec validate --strict --all",
    ]) {
      const r = runHook(command);
      assert.equal(r.code, 0, "hook exits 0 with JSON decision");
      assert.ok(r.json, "must emit a JSON decision");
      assert.equal(r.json.decision, "block");
      assert.match(r.json.reason, /High-Output Command Hard Gate/);
    }
  });

  it("BLOCKS malformed capture-command wrapper shapes", () => {
    for (const command of [
      "node .devpro/scripts/capture-command.mjs --topic x node --test .devpro/scripts/tests/",
      "node .devpro/scripts/capture-command.mjs -- node --test .devpro/scripts/tests/",
      "node ./other/capture-command.mjs --topic x -- node --test .devpro/scripts/tests/",
      "node .devpro/scripts/capture-command.mjs --topic x -- echo ok | node --test .devpro/scripts/tests/",
    ]) {
      const r = runHook(command);
      assert.equal(r.code, 0, "hook exits 0 with JSON decision");
      assert.ok(r.json, "must emit a JSON decision");
      assert.equal(r.json.decision, "block");
      assert.match(r.json.reason, /High-Output Command Hard Gate/);
    }
  });

  it("does NOT block the high-output phrase inside a quoted echo (segment-aware)", () => {
    const r = runHook('echo "node --test .devpro/scripts/tests/ is slow"');
    if (r.json && r.json.decision === "block") {
      assert.doesNotMatch(r.json.reason, /High-Output Command Hard Gate/, "quoted-string occurrence must be stripped before matching");
    }
  });

  it("BLOCKS repo-wide rg -n with no narrowing (definite block, not conditional)", () => {
    const r = runHook("rg -n 'someUniquePattern'");
    assert.equal(r.code, 0, "hook exits 0 with JSON decision");
    assert.ok(r.json, "must emit a JSON decision (a block is required for raw repo-wide rg)");
    assert.equal(r.json.decision, "block");
    assert.match(r.json.reason, /High-Output Command Hard Gate/);
  });

  it("BLOCKS incident shape: whole-tree rg with unrelated exclude globs", () => {
    const r = runHook("rg -n 'someUniquePattern' . --glob '!node_modules' --glob '!dist' --glob '!build'");
    assert.equal(r.code, 0, "hook exits 0 with JSON decision");
    assert.ok(r.json, "must emit a JSON decision");
    assert.equal(r.json.decision, "block");
    assert.match(r.json.reason, /High-Output Command Hard Gate/);
  });

  it("does NOT block a narrowed rg -n <pattern> <path> through the real hook", () => {
    const r = runHook("rg -n 'someUniquePattern' .devpro/agent-rules/");
    if (r.json && r.json.decision === "block") {
      assert.doesNotMatch(r.json.reason, /High-Output Command Hard Gate/, "narrowed rg must not trip the high-output gate");
    }
  });

  it("BLOCKS broad multi-root rg through the real hook", () => {
    const r = runHook("rg -n 'someUniquePattern' .devpro/agent-rules .devpro/scripts");
    assert.equal(r.code, 0, "hook exits 0 with JSON decision");
    assert.ok(r.json, "must emit a JSON decision");
    assert.equal(r.json.decision, "block");
    assert.match(r.json.reason, /High-Output Command Hard Gate/);
  });

  it("does NOT block concrete-file multi-path rg through the real hook", () => {
    const r = runHook("rg -n 'someUniquePattern' AGENTS.md README.md");
    if (r.json && r.json.decision === "block") {
      assert.doesNotMatch(r.json.reason, /High-Output Command Hard Gate/, "concrete-file pathsets must not trip the high-output gate");
    }
  });

  it("does NOT block broad multi-root rg when redirected or bounded through the real hook", () => {
    for (const command of [
      "rg -n 'someUniquePattern' .devpro/agent-rules .devpro/scripts > notes/tmp/rg.log",
      "rg -n 'someUniquePattern' .devpro/agent-rules .devpro/scripts | head -50",
      "rg -n 'someUniquePattern' .devpro/agent-rules .devpro/scripts | wc -l",
    ]) {
      const r = runHook(command);
      if (r.json && r.json.decision === "block") {
        assert.doesNotMatch(r.json.reason, /High-Output Command Hard Gate/, `${command} must not trip the high-output gate`);
      }
    }
  });

  it("does NOT block whole-tree rg when repo forbidden paths are excluded", () => {
    const r = runHook("rg -n 'someUniquePattern' . --glob '!openspec/changes/archive' --glob '!.worktree' --glob '!refs'");
    if (r.json && r.json.decision === "block") {
      assert.doesNotMatch(r.json.reason, /High-Output Command Hard Gate/, "forbidden-path exclusions must discharge broad repo rg");
    }
  });

  it("does NOT block git commands whose branch/path text contains rg", () => {
    const r = runHook(
      "git status --short /repo/.worktree/fix-high-output-rg-glob-narrowing chore/fix-high-output-rg-glob-narrowing"
    );
    if (r.json && r.json.decision === "block") {
      assert.doesNotMatch(r.json.reason, /High-Output Command Hard Gate/, "branch/path text is not an rg command");
    }
  });

  it("BLOCKS repo-wide rg -m because max-count is per-file", () => {
    const r = runHook("rg -n -m 20 'someUniquePattern'");
    assert.equal(r.code, 0, "hook exits 0 with JSON decision");
    assert.ok(r.json, "must emit a JSON decision");
    assert.equal(r.json.decision, "block");
    assert.match(r.json.reason, /High-Output Command Hard Gate/);
  });

  it("BLOCKS broad multi-path rg -m through the real hook", () => {
    const r = runHook("rg -n -m 20 'someUniquePattern' AGENTS.md .devpro README.md");
    assert.equal(r.code, 0, "hook exits 0 with JSON decision");
    assert.ok(r.json, "must emit a JSON decision");
    assert.equal(r.json.decision, "block");
    assert.match(r.json.reason, /High-Output Command Hard Gate/);
  });

  it("does NOT block rg -m when narrowed to one path through the real hook", () => {
    const r = runHook("rg -n -m 5 'someUniquePattern' .devpro/agent-rules/token-frugal-io.md");
    if (r.json && r.json.decision === "block") {
      assert.doesNotMatch(r.json.reason, /High-Output Command Hard Gate/, "single-path rg -m must not trip the high-output gate");
    }
  });
});
