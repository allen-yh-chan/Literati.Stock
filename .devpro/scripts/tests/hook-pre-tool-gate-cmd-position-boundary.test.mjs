/**
 * hook-pre-tool-gate-cmd-position-boundary.test.mjs
 *
 * Command-position boundary regression for the git/gh verb gates.
 *
 * Bug: the shared command-boundary anchor used a bare-`\s` boundary class, so a
 * git/gh verb appearing as an ARGUMENT to another command (`echo git push --force`,
 * `echo gh pr merge 9999`) matched as if it were a real invocation → false-positive
 * block. The fix (`CMD_POSITION_ANCHOR` in lib/shell-context.mjs) only matches a real
 * command position (start / separator / grouping / command-introducing keyword).
 *
 * SAFETY PROPERTY: for NATURAL / EXECUTABLE commands the new boundary only narrows
 * matching at argument position (never at a real command position), so it introduces
 * no new false-positive. (It is not a formal strict subset — `{git` matches NEW not
 * OLD — but such new-only forms are non-executable; see shell-context.test.mjs.) The
 * only risk is a false-negative, which these Axis-A "must still surface" cases guard.
 *
 *   Axis A — real invocation across command positions → MUST STILL SURFACE (block/advisory by gate bucket)
 *   Axis B — verb as a bare arg to another command   → MUST NOW PASS  (the FP fix)
 *
 * Perf (test-performance-patterns.md pattern (c)): every case asserts pure
 * payload→decision output ({decision}/{reason}/advisory text) — no exit code,
 * no marker side effect, no git-state mutation (the hook only EVALUATES the
 * command; it never executes it). So cases call the exported
 * evaluatePreToolUsePayload() in-process. Two representative cases keep the
 * real spawn as this file's end-to-end integration signal:
 *   - Axis A [force-push] "bare" (block via real hook process + real stdout JSON)
 *   - CONTRAST protected-write $() form (block via real hook process)
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";
import { advisoryText } from "./lib/hook-harness.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(SCRIPT_DIR, "../hooks/pre-tool-gate.mjs");
const REAL_PREFLIGHT = readFileSync(
  path.resolve(SCRIPT_DIR, "../../agent-rules/preflight-checklist.md"),
  "utf8"
);

const tmpRoot = makeTempDir("cmd-position-gate-test-");
after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// The hook module freezes SENTINEL_DIR from DEVPRO_SENTINEL_STATE_DIR at
// module-load time, so the env MUST be pinned to an isolated dir BEFORE the
// dynamic import below — otherwise in-process evaluate calls would scan (and
// expire/clean) the REAL repo's sentinel state dir.
const INPROC_SENTINEL_DIR = path.join(tmpRoot, "inproc-sentinel-state");
const INPROC_POSTMERGE_DIR = path.join(tmpRoot, "inproc-postmerge-state");
mkdirSync(INPROC_SENTINEL_DIR, { recursive: true });
mkdirSync(INPROC_POSTMERGE_DIR, { recursive: true });
process.env.DEVPRO_SENTINEL_STATE_DIR = INPROC_SENTINEL_DIR;
const { evaluatePreToolUsePayload, PASS_THROUGH } = await import(
  "../hooks/pre-tool-gate.mjs"
);

// Pattern (a): the expensive git init + config + commit sequence (5 real git
// spawns) runs ONCE. No test mutates the fixture — the hook only EVALUATES
// each payload (never executes the command), and none of these commands carry
// repo-scope approval markers or worktree adds that write per-repo state — so
// ALL tests reuse the SAME instance directly (SSOT test-performance-patterns.md
// pattern (a): "case 之間用 cpSync 快速複製或直接 reuse").
let mainRepoTemplate = null;
function createMainRepoTemplate() {
  const dir = path.join(tmpRoot, "template-main");
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  mkdirSync(path.join(dir, ".devpro/agent-rules"), { recursive: true });
  writeFileSync(path.join(dir, ".devpro/agent-rules/preflight-checklist.md"), REAL_PREFLIGHT);
  writeFileSync(path.join(dir, "f.txt"), "x\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

// A repo on `main` (a protected branch) with the real preflight marker present,
// so force-push / attribution / merge-strategy / branch-verb gates engage.
function setupMainRepo() {
  if (!mainRepoTemplate) mainRepoTemplate = createMainRepoTemplate();
  return mainRepoTemplate;
}

function run(command, cwd, { nodeArgs = [], env = {} } = {}) {
  const tempSentinelDir = makeTempDir("sentinel-cmdpos-");
  const payload = { tool_name: "Bash", tool_input: { command, cwd } };
  const r = spawnSync("node", [...nodeArgs, HOOK], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      CODEX_CI: "",
      CODEX_THREAD_ID: "",
      DEVPRO_SENTINEL_STATE_DIR: tempSentinelDir,
      PWD: cwd,
      CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: "openspec/changes/cmd-position/proposal.md",
      CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({
        comments: [{
          body: "<!-- cross-model-second-opinion:sticky -->\nverdict: PASS\nlast_reviewed_sha: " + "a".repeat(40),
          url: "https://example.invalid/sticky",
        }],
        headRefOid: "a".repeat(40),
        headRefName: "feature/cmd-position",
      }),
    },
  });
  let json = null;
  try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch {}
  return { code: r.status, stdout: r.stdout, json };
}

// Command-position prefixes that MUST keep matching (real invocation). Each
// `%s` is replaced by the bare verb-invocation. Excludes pure `echo`/arg forms.
const POSITION_PREFIXES = [
  ["bare", (inv) => inv],
  ["after &&", (inv) => `true && ${inv}`],
  ["after ;", (inv) => `true ; ${inv}`],
  ["after ||", (inv) => `false || ${inv}`],
  ["subshell ()", (inv) => `(${inv})`],
  ["brace group", (inv) => `{ ${inv}; }`],
  ["env prefix", (inv) => `FOO=1 ${inv}`],
  ["env wrapper", (inv) => `env FOO=1 ${inv}`],
  ["keyword then", (inv) => `if true; then ${inv}; fi`],
  ["keyword do", (inv) => `while false; do ${inv}; done`],
  // Newline-separated keyword blocks — a NATURAL multiline form where the keyword is
  // separated from the block head by `\n` (not `;`). The keyword-predecessor class MUST
  // keep `\n`/`\r`; dropping them was an Axis-A false-negative regression caught by the
  // PR #933 cross-model review (issue #899 finding (b) over-narrowing).
  ["keyword then (newline)", (inv) => `if true\nthen ${inv}\nfi`],
  ["keyword do (newline)", (inv) => `while false\ndo ${inv}\ndone`],
];

// Arg-position forms that MUST NOT block (verb is an argument to another command).
//
// The keyword-prefixed forms (`echo then …`, `echo do …`) are issue #899 finding (b):
// a command-introducing keyword (`then`/`do`/…) sitting in ARGUMENT position (preceded
// by a bare space, not a real command separator) must NOT be treated as introducing a
// command. The fix tightens CMD_POSITION_ANCHOR so the keyword itself must sit at a
// command position (start / real separator); `then`/`do` after `echo ` is just an echo
// argument and must not arm the verb gate.
const ARG_FORMS = [
  ["echo", (inv) => `echo ${inv}`],
  ["printf", (inv) => `printf ${inv}`],
  ["then_branch (substring, not keyword)", (inv) => `then_branch ${inv}`],
  ["echo then (keyword in arg-position, #899b)", (inv) => `echo then ${inv}`],
  ["echo do (keyword in arg-position, #899b)", (inv) => `echo do ${inv}`],
];

// Each fixed gate: a verb-invocation that blocks DETERMINISTICALLY on a `main` repo
// (no PR/sticky mocking needed), + the reason regex. force-push (GIT_PUSH_RE, a
// TOKEN_ANCHOR inheritor) and merge-strategy (GH_PR_MERGE_RE, also TOKEN_ANCHOR)
// together exercise both the `git` and `gh` verb families through the shared
// boundary, which is the unit under test. The cross-model gate's identical
// boundary is covered by the SA-* cases in hook-pre-tool-gate-cross-model-merge,
// and the primitive itself by the canary in shell-context.test.mjs.
const GATES = [
  {
    name: "force-push",
    inv: "git push --force",
    reason: /Force-push gate/,
    bucket: "block",
  },
  {
    // Gate 2c is a HARD BLOCK as of issue #947 finding 3 (release-integrity);
    // it exercises the `gh` verb family through the shared boundary at block severity.
    name: "merge-strategy",
    inv: "gh pr merge 5 --squash",
    reason: /Merge strategy gate/,
    bucket: "block",
  },
];

for (const g of GATES) {
  // ── Axis A: real invocation across command positions → MUST STILL SURFACE ──
  for (const [label, wrap] of POSITION_PREFIXES) {
    test(`Axis A [${g.name}] still surfaces at command position: ${label}`, () => {
      const dir = setupMainRepo();
      const cmd = wrap(g.inv);
      const r = run(cmd, dir);
      if (g.bucket === "block") {
        assert.equal(
          r.json?.decision,
          "block",
          `[${g.name}] real invocation "${cmd}" MUST still block (false-negative guard); got: ${JSON.stringify(r.json)}`
        );
        assert.match(r.json.reason, g.reason, `[${g.name}] block reason mismatch for "${cmd}"`);
      } else {
        assert.notEqual(
          r.json?.decision,
          "block",
          `[${g.name}] real invocation "${cmd}" MUST advisory, not block; got: ${JSON.stringify(r.json)}`
        );
        assert.match(advisoryText(r.json), g.reason, `[${g.name}] advisory reason mismatch for "${cmd}"`);
      }
    });
  }

  // ── Axis B: verb as arg to another command → MUST NOW PASS ──
  for (const [label, wrap] of ARG_FORMS) {
    test(`Axis B [${g.name}] does not fire when verb is an arg: ${label}`, () => {
      const dir = setupMainRepo();
      const cmd = wrap(g.inv);
      const r = run(cmd, dir);
      // The verb-in-arg-position must not trigger THIS gate. (Another gate may
      // still legitimately block — assert this gate's reason is absent.)
      const reason = r.json?.reason || "";
      assert.ok(
        !g.reason.test(reason),
        `[${g.name}] arg-position "${cmd}" must NOT trigger this gate; got: ${JSON.stringify(r.json)}`
      );
    });
  }
}

// ── Quoted environment-value prefix on a raw-text gate ──────────────────────────────────────────
// `VAR="a b" git add x` runs git directly, like `VAR=1 git add x`. The protected-write gate reads the raw command at the
// verb position, so the shared anchor must read a quoted value in front of the verb as part of the command prefix,
// including a value that contains the word `git` (the verb is the first `git` OUTSIDE the quotes).
const QUOTED_ENV_PREFIXES = [
  ["double-quoted value", (inv) => `FOO="a b" ${inv}`],
  ["single-quoted value", (inv) => `FOO='a b' ${inv}`],
  ["env wrapper", (inv) => `env FOO="a b" ${inv}`],
  ["bare then quoted value", (inv) => `BAR=1 FOO="a b" ${inv}`],
  ["after &&", (inv) => `true && FOO="a b" ${inv}`],
  ["value containing the verb word", (inv) => `FOO="a git b" ${inv}`],
  ["value containing gh and git", (inv) => `FOO='run gh then git' ${inv}`],
];

for (const [label, wrap] of QUOTED_ENV_PREFIXES) {
  test(`Quoted env value [protected-write] still surfaces: ${label}`, () => {
    const dir = setupMainRepo();
    const cmd = wrap("git add x");
    const r = run(cmd, dir);
    assert.equal(
      r.json?.decision,
      "block",
      `"${cmd}" is a real git write on main and MUST block; got: ${JSON.stringify(r.json)}`
    );
    assert.match(r.json.reason, /Protected-branch gate/);
  });
}

for (const [label, wrap] of [
  ["echo before the assignment", (inv) => `echo FOO="a b" ${inv}`],
  ["assignment before echo", (inv) => `FOO="a b" echo ${inv}`],
]) {
  test(`Quoted env value [protected-write] does not fire when the verb is an arg: ${label}`, () => {
    const dir = setupMainRepo();
    const cmd = wrap("git add x");
    const r = run(cmd, dir);
    assert.ok(
      !/Protected-branch gate/.test(r.json?.reason || ""),
      `"${cmd}" has git only as an argument and must NOT trigger the protected-write gate; got: ${JSON.stringify(r.json)}`
    );
  });
}

// A command of tens of kilobytes made of repeated separators or quoted strings is judged in time linear in its length:
// the anchor's unquoted scan classes stop at a separator and the data-region masking is one pass. The git write at the
// end still gets its normal decision, so speed is not bought by skipping the gates.
const LONG_COMMAND_UNITS = [
  ["repeated bare env assignments", ";X=1"],
  ["repeated space-separated env assignments", "A=1 "],
  ["repeated && separators", "&&a"],
  ["repeated quoted strings", 'echo "a b" '],
  ["repeated subshell openers", "(a"],
];

// The bound is on the CPU time the hook process itself spends, read by a preload when it exits, not on wall time: a
// busy machine (the full integration run) stretches wall time several times over while CPU time stays put, so the
// bound holds the gate's own work to the spec ("well under a second for ~16000 repeats", start-up included) on any
// machine load.
const CPU_PRELOAD = path.join(tmpRoot, "cpu-time-preload.mjs");
writeFileSync(CPU_PRELOAD, [
  'import { writeFileSync } from "node:fs";',
  "const out = process.env.CPU_TIME_OUT;",
  "process.on(\"exit\", () => { const u = process.cpuUsage(); if (out) writeFileSync(out, String((u.user + u.system) / 1000)); });",
  "",
].join("\n"));
function hookCpuMs(command, cwd) {
  const out = path.join(makeTempDir("cpu-time-"), "ms");
  const r = run(command, cwd, { nodeArgs: ["--import", CPU_PRELOAD], env: { CPU_TIME_OUT: out } });
  return { r, ms: Number(readFileSync(out, "utf8")) };
}

for (const [label, unit] of LONG_COMMAND_UNITS) {
  test(`Long command [protected-write] is judged quickly and still blocks: ${label}`, () => {
    const dir = setupMainRepo();
    const cmd = `${unit.repeat(16000)} ; git add x`;
    const { r, ms } = hookCpuMs(cmd, dir);
    assert.equal(r.json?.decision, "block", `a git write on main after a long prefix MUST block; got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /Protected-branch gate/);
    assert.ok(ms < 1000, `${label}: the hook spent ${ms.toFixed(0)} ms of CPU on a ${cmd.length}-character command; not linear`);
  });
}

// ── KNOWN LIMITATION (documented in spec "Command-Position Verb Matching"): a verb
// wrapped in `$()` / backticks passed as an argument is NOT caught by gates that
// match on the commandSegmentText view (force-push, cross-model-merge), because that
// view collapses subshell spans to "". This is the adversarial-shell-equivalence
// carve-out (`echo $(git push --force)` is not a natural agent command). These tests
// PIN the current behavior so a future change to it is a conscious, reviewed decision.
test("KNOWN-LIMIT: echo $(git push --force) is not blocked by force-push gate (subshell-collapse)", () => {
  const dir = setupMainRepo();
  const r = run("echo $(git push --force)", dir);
  assert.ok(
    !/Force-push gate/.test(r.json?.reason || ""),
    `documented limitation: $()-wrapped force-push not caught; got: ${JSON.stringify(r.json)}`
  );
});

test("CONTRAST: protected-write gate STILL blocks its $() form (raw-cmd verb-position match)", () => {
  const dir = setupMainRepo();
  // git add inside $() on a protected branch — protected-write matches on raw cmd at
  // the verb position, so it still fires (the gate-consistency reference point).
  const r = run("echo $(git add x)", dir);
  assert.equal(
    r.json?.decision,
    "block",
    `protected-write must still block its $() form on a protected branch; got: ${JSON.stringify(r.json)}`
  );
  assert.match(r.json.reason, /Protected-branch gate/);
});

// A dynamic environment value in front of a real command leaves it at command position, through the same shared
// boundary, for both the `git` and `gh` verb families. Argument position stays unarmed.
for (const prefix of ["TOKEN=$(echo t) ", "TOKEN=`echo t` ", "TOKEN=$T ", "TOKEN=${T} "]) {
  for (const gate of GATES.filter((g) => g.bucket === "block")) {
    test(`${gate.name} fires behind the dynamic environment value ${prefix.trim()}`, () => {
      const r = run(`${prefix}${gate.inv}`, setupMainRepo());
      assert.equal(r.json?.decision, "block", JSON.stringify(r.json));
      assert.match(r.json.reason || "", gate.reason);
    });
  }
}

for (const cmd of ["echo FOO=$(date) git push --force", "echo $(date) git push --force"]) {
  test(`force-push stays unarmed in argument position: ${cmd}`, () => {
    const r = run(cmd, setupMainRepo());
    assert.notEqual(r.json?.decision, "block", JSON.stringify(r.json));
  });
}
