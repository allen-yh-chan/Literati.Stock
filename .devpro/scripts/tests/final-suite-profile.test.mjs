/**
 * final-suite-profile.test.mjs
 *
 * Unit tier (design D12 of fix-seal-final-consumer-na-suite-evidence): every
 * case injects the oracles / the git runner, so nothing here runs git.
 *
 * Scenario: Not-Applicable Final Suite Evidence Requires The Helper's Consumer Determination
 * Scenario: Runner Output Must Match The Determined Route
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  FINAL_SUITE_OUTPUT_REASONS,
  FINAL_SUITE_PROFILE_BASES,
  FINAL_SUITE_RESULT_CONSUMER_NA,
  FINAL_SUITE_RESULT_PASS,
  SOURCE_MAINTAINER_NA_PREFIX,
  SOURCE_ONLY_CORPUS_SENTINELS,
  checkFinalSuiteOutput,
  determineFinalSuiteProfile,
  probeSourceOnlyCorpus,
} from "../lib/final-suite-profile.mjs";
import { CONSUMER_PROFILE_NA_LINE } from "../run-test-suite.mjs";
import { listSyncCommitPaths } from "../sync-agent-rules.mjs";
import { repoPath } from "./lib/repo-root.mjs";

const ROOT = "virtual-consumer-root";
const SMOKE_NA_LINE = "[test-suite] source-maintainer checks: N/A reason=consumer rules lane uses generated-file smoke; source-only corpus checks are not required";
const CONSUMER_NA_LITERAL = "[test-suite] source-maintainer checks: N/A reason=consumer repository profile; source-only corpus checks are not required";

// ---------------------------------------------------------------------------
// determineFinalSuiteProfile
// ---------------------------------------------------------------------------

// Injection set where all four conditions hold; each spy records its calls.
function consumerOracles(overrides = {}) {
  const calls = [];
  const oracles = {
    resolveContext: (root) => { calls.push(["resolveContext", root]); return { profile: "consumer", mode: "direct", consumerRoot: root }; },
    selectRoute: (input) => { calls.push(["selectRoute", input]); return "consumer-na"; },
    classifyIdentity: (root) => { calls.push(["classifyIdentity", root]); return { identity: "consumer", evidence: `unrecognized superproject PATH-LEAK-${root}` }; },
    probeSourceCorpus: (root) => { calls.push(["probeSourceCorpus", root]); return { present: false }; },
    ...overrides,
  };
  return { oracles, calls };
}

const callNames = (calls) => calls.map(([name]) => name);

// Scenario: Not-Applicable Final Suite Evidence Requires The Helper's Consumer Determination
test("final suite profile: all four conditions hold -> consumer-na with consumer-direct basis", () => {
  const { oracles, calls } = consumerOracles();
  const profile = determineFinalSuiteProfile(ROOT, oracles);
  assert.deepEqual(profile, {
    route: "consumer-na",
    expectedResult: FINAL_SUITE_RESULT_CONSUMER_NA,
    basis: "consumer-direct",
  });
  assert.equal(FINAL_SUITE_RESULT_CONSUMER_NA, "not-applicable-consumer-profile");
  assert.deepEqual(callNames(calls), ["resolveContext", "selectRoute", "classifyIdentity", "probeSourceCorpus"]);
  // The route function is asked about the exact base the seal spawns.
  assert.deepEqual(calls[1][1], {
    changedBase: "main",
    consumerContext: { profile: "consumer", mode: "direct", consumerRoot: ROOT },
  });
});

// Scenario: Not-Applicable Final Suite Evidence Requires The Helper's Consumer Determination
test("final suite profile: each failing condition falls to the source route with its own basis", () => {
  const cases = [
    ["runner oracle says source", { resolveContext: () => ({ profile: "source", mode: "direct" }) }, "runner-oracle-source"],
    ["runner oracle says source with a probe diagnostic", { resolveContext: () => ({ profile: "source", mode: "direct", diagnostic: "superproject probe failed" }) }, "runner-oracle-source"],
    ["consumer-owned rules submodule", { resolveContext: () => ({ profile: "consumer", mode: "submodule", consumerRoot: "x" }) }, "consumer-submodule"],
    ["runner route is not consumer-na", { selectRoute: () => "consumer-smoke" }, "runner-oracle-source"],
    ["runner route is source-suite", { selectRoute: () => "source-suite" }, "runner-oracle-source"],
    ["identity source", { classifyIdentity: () => ({ identity: "source" }) }, "identity-source"],
    ["identity unknown", { classifyIdentity: () => ({ identity: "unknown" }) }, "identity-unknown"],
    ["corpus present", { probeSourceCorpus: () => ({ present: true }) }, "source-corpus-present"],
  ];
  for (const [label, override, basis] of cases) {
    const { oracles } = consumerOracles(override);
    assert.deepEqual(
      determineFinalSuiteProfile(ROOT, oracles),
      { route: "source-suite", expectedResult: FINAL_SUITE_RESULT_PASS, basis },
      label,
    );
  }
  assert.equal(FINAL_SUITE_RESULT_PASS, "pass");
});

// Scenario: Not-Applicable Final Suite Evidence Requires The Helper's Consumer Determination
test("final suite profile: a thrown or malformed oracle answer is oracle-error on the source route", () => {
  const boom = () => { throw new Error("PATH-LEAK exploded"); };
  const cases = [
    ["resolveContext throws", { resolveContext: boom }],
    ["resolveContext returns null", { resolveContext: () => null }],
    ["resolveContext returns a non-object", { resolveContext: () => "consumer" }],
    ["resolveContext returns an unknown profile", { resolveContext: () => ({ profile: "weird", mode: "direct" }) }],
    ["resolveContext returns an unknown mode", { resolveContext: () => ({ profile: "consumer", mode: "weird" }) }],
    ["selectRoute throws", { selectRoute: boom }],
    ["classifyIdentity throws", { classifyIdentity: boom }],
    ["classifyIdentity returns null", { classifyIdentity: () => null }],
    ["classifyIdentity returns an unknown identity", { classifyIdentity: () => ({ identity: "weird" }) }],
    ["classifyIdentity returns no identity", { classifyIdentity: () => ({}) }],
    ["corpus probe throws", { probeSourceCorpus: boom }],
    ["corpus probe returns null", { probeSourceCorpus: () => null }],
    ["corpus probe returns a non-boolean present", { probeSourceCorpus: () => ({ present: "no" }) }],
    ["corpus probe returns no present", { probeSourceCorpus: () => ({}) }],
  ];
  for (const [label, override] of cases) {
    const { oracles } = consumerOracles(override);
    const profile = determineFinalSuiteProfile(ROOT, oracles);
    assert.deepEqual(profile, { route: "source-suite", expectedResult: FINAL_SUITE_RESULT_PASS, basis: "oracle-error" }, label);
    assert.equal(JSON.stringify(profile).includes("PATH-LEAK"), false, `${label}: no path leaks into the result`);
  }
});

// Scenario: Not-Applicable Final Suite Evidence Requires The Helper's Consumer Determination
test("final suite profile: forged-source injection (consumer-shaped signals + corpus present) is source; only the corpus flips it", () => {
  // Simulates a consumer-shaped .gitmodules, synced sentinels and a non-source
  // origin: conditions 1-3 all answer consumer.
  let forgedProbeCalls = 0;
  const forged = consumerOracles({ probeSourceCorpus: () => { forgedProbeCalls += 1; return { present: true }; } });
  assert.deepEqual(determineFinalSuiteProfile(ROOT, forged.oracles), {
    route: "source-suite",
    expectedResult: FINAL_SUITE_RESULT_PASS,
    basis: "source-corpus-present",
  });
  assert.deepEqual(callNames(forged.calls), ["resolveContext", "selectRoute", "classifyIdentity"]);
  assert.equal(forgedProbeCalls, 1, "conditions 1-3 answered consumer, so the corpus probe decided");

  // Same injection with only the corpus answer changed.
  const consumer = consumerOracles({ probeSourceCorpus: () => ({ present: false }) });
  assert.deepEqual(determineFinalSuiteProfile(ROOT, consumer.oracles), {
    route: "consumer-na",
    expectedResult: FINAL_SUITE_RESULT_CONSUMER_NA,
    basis: "consumer-direct",
  });
});

// Scenario: Not-Applicable Final Suite Evidence Requires The Helper's Consumer Determination
test("final suite profile: evaluation order stops at the first failing condition", () => {
  const forbidden = (name) => () => { throw new Error(`${name} must not be consulted`); };

  // Condition 1 fails: nothing after it is consulted.
  const c1 = consumerOracles({
    resolveContext: () => ({ profile: "source", mode: "direct" }),
    selectRoute: forbidden("selectRoute"),
    classifyIdentity: forbidden("classifyIdentity"),
    probeSourceCorpus: forbidden("probeSourceCorpus"),
  });
  assert.equal(determineFinalSuiteProfile(ROOT, c1.oracles).basis, "runner-oracle-source");

  // Submodule mode stops before the route function.
  const sub = consumerOracles({
    resolveContext: () => ({ profile: "consumer", mode: "submodule" }),
    selectRoute: forbidden("selectRoute"),
    classifyIdentity: forbidden("classifyIdentity"),
    probeSourceCorpus: forbidden("probeSourceCorpus"),
  });
  assert.equal(determineFinalSuiteProfile(ROOT, sub.oracles).basis, "consumer-submodule");

  // Condition 2 fails: identity and corpus are not consulted.
  const c2 = consumerOracles({
    selectRoute: () => "source-suite",
    classifyIdentity: forbidden("classifyIdentity"),
    probeSourceCorpus: forbidden("probeSourceCorpus"),
  });
  assert.equal(determineFinalSuiteProfile(ROOT, c2.oracles).basis, "runner-oracle-source");

  // Condition 3 fails: the corpus probe is not consulted, and identity wins
  // over a present corpus (unknown + corpus present -> identity-unknown).
  let probeCalls = 0;
  const c3 = consumerOracles({
    classifyIdentity: () => ({ identity: "unknown" }),
    probeSourceCorpus: () => { probeCalls += 1; return { present: true }; },
  });
  assert.equal(determineFinalSuiteProfile(ROOT, c3.oracles).basis, "identity-unknown");
  assert.equal(probeCalls, 0, "corpus probe is not called once identity failed");
  assert.deepEqual(callNames(c3.calls), ["resolveContext", "selectRoute"]);

  const c3src = consumerOracles({
    classifyIdentity: () => ({ identity: "source" }),
    probeSourceCorpus: forbidden("probeSourceCorpus"),
  });
  assert.equal(determineFinalSuiteProfile(ROOT, c3src.oracles).basis, "identity-source");
});

test("final suite profile: every basis token the module can return belongs to the closed vocabulary", () => {
  assert.deepEqual([...FINAL_SUITE_PROFILE_BASES].sort(), [
    "consumer-direct",
    "consumer-submodule",
    "identity-source",
    "identity-unknown",
    "oracle-error",
    "runner-oracle-source",
    "source-corpus-present",
  ]);
  assert.equal(Object.isFrozen(FINAL_SUITE_PROFILE_BASES), true);
});

// ---------------------------------------------------------------------------
// probeSourceOnlyCorpus
// ---------------------------------------------------------------------------

function runGitReturning(result) {
  const calls = [];
  const runGit = (...args) => { calls.push(args); return typeof result === "function" ? result() : result; };
  return { runGit, calls };
}
const noneExist = () => false;

// Scenario: Not-Applicable Final Suite Evidence Requires The Helper's Consumer Determination
test("probeSourceOnlyCorpus: HEAD-tree-only, working-tree-only and neither", () => {
  for (const sentinel of SOURCE_ONLY_CORPUS_SENTINELS) {
    const headOnly = runGitReturning({ status: 0, stdout: `${sentinel}\n` });
    assert.deepEqual(probeSourceOnlyCorpus(ROOT, { runGit: headOnly.runGit, exists: noneExist }), { present: true }, `HEAD tree: ${sentinel}`);

    const worktreeOnly = runGitReturning({ status: 0, stdout: "" });
    const seen = [];
    const exists = (candidate) => { seen.push(candidate); return candidate === path.join(ROOT, sentinel); };
    assert.deepEqual(probeSourceOnlyCorpus(ROOT, { runGit: worktreeOnly.runGit, exists }), { present: true }, `working tree: ${sentinel}`);
  }

  const neither = runGitReturning({ status: 0, stdout: "" });
  assert.deepEqual(probeSourceOnlyCorpus(ROOT, { runGit: neither.runGit, exists: noneExist }), { present: false });

  // Unrelated tree output (not an exact sentinel line) is not a hit.
  const unrelated = runGitReturning({ status: 0, stdout: "openspec/specs/pre-tool-mechanical-gates/spec.md.bak\nscenarios/other.md\n" });
  assert.deepEqual(probeSourceOnlyCorpus(ROOT, { runGit: unrelated.runGit, exists: noneExist }), { present: false });
});

// Scenario: Not-Applicable Final Suite Evidence Requires The Helper's Consumer Determination
test("probeSourceOnlyCorpus: the HEAD-tree probe runs one exact argv and the working tree is checked at the root", () => {
  const probe = runGitReturning({ status: 0, stdout: "" });
  const checked = [];
  probeSourceOnlyCorpus(ROOT, { runGit: probe.runGit, exists: (candidate) => { checked.push(candidate); return false; } });
  assert.equal(probe.calls.length, 1, "exactly one git invocation");
  const [command, argv, options] = probe.calls[0];
  assert.equal(command, "git");
  assert.deepEqual(argv, ["-C", ROOT, "ls-tree", "--full-tree", "--name-only", "HEAD", "--", ...SOURCE_ONLY_CORPUS_SENTINELS]);
  assert.equal(options.encoding, "utf8");
  assert.deepEqual(checked, SOURCE_ONLY_CORPUS_SENTINELS.map((sentinel) => path.join(ROOT, sentinel)));
});

// Scenario: Not-Applicable Final Suite Evidence Requires The Helper's Consumer Determination
test("probeSourceOnlyCorpus: an untrustworthy git probe throws, and the profile maps that to oracle-error", () => {
  const broken = [
    ["runGit throws", () => { throw new Error("spawn exploded"); }],
    ["spawn error", () => ({ error: new Error("ENOENT"), status: null, stdout: "" })],
    ["non-zero status", () => ({ status: 128, stdout: "" })],
    ["null status", () => ({ status: null, stdout: "" })],
    ["stdout is not a string", () => ({ status: 0, stdout: Buffer.from("x") })],
    ["stdout is missing", () => ({ status: 0 })],
    ["no result object", () => undefined],
  ];
  for (const [label, produce] of broken) {
    const { runGit } = runGitReturning(produce);
    // Even a working-tree hit must not paper over a broken HEAD probe.
    assert.throws(() => probeSourceOnlyCorpus(ROOT, { runGit, exists: () => true }), Error, label);

    const { oracles } = consumerOracles({
      probeSourceCorpus: (root) => probeSourceOnlyCorpus(root, { runGit, exists: noneExist }),
    });
    assert.deepEqual(
      determineFinalSuiteProfile(ROOT, oracles),
      { route: "source-suite", expectedResult: FINAL_SUITE_RESULT_PASS, basis: "oracle-error" },
      label,
    );
  }
});

// ---------------------------------------------------------------------------
// sentinel self-lock (reads files only)
// ---------------------------------------------------------------------------

// Scenario: Not-Applicable Final Suite Evidence Requires The Helper's Consumer Determination
test("source-only corpus sentinels: exist in this source checkout and sit outside the rules-sync managed set", () => {
  assert.equal(Object.isFrozen(SOURCE_ONLY_CORPUS_SENTINELS), true);
  assert.ok(SOURCE_ONLY_CORPUS_SENTINELS.length >= 2, "at least two sentinels in different trees");
  const managed = listSyncCommitPaths().map((entry) => entry.replace(/\/+$/u, ""));
  assert.ok(managed.length > 0, "listSyncCommitPaths must return the managed set");
  for (const sentinel of SOURCE_ONLY_CORPUS_SENTINELS) {
    assert.equal(existsSync(repoPath(sentinel)), true, `sentinel must exist in the source checkout: ${sentinel}`);
    for (const entry of managed) {
      assert.notEqual(sentinel, entry, `sentinel must not equal a managed path: ${sentinel}`);
      assert.equal(
        sentinel.startsWith(`${entry}/`),
        false,
        `sentinel must not sit under managed path ${entry}: ${sentinel}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// checkFinalSuiteOutput
// ---------------------------------------------------------------------------

const NA_BYTES = Buffer.from(`${CONSUMER_PROFILE_NA_LINE}\n`, "utf8");
const TIER_SUMMARY = [
  "[test-suite] tier=unit log=x digest_sha256=" + "a".repeat(64) + " tests=3 pass=3 fail=0 skipped=0",
  "[test-suite] tier=unit real=1s status=pass",
  "",
].join("\n");

function assertRejected(input, reason, label) {
  const result = checkFinalSuiteOutput(input);
  assert.deepEqual(result, { ok: false, reason }, label);
  assert.ok(FINAL_SUITE_OUTPUT_REASONS.includes(result.reason), `${label}: closed token`);
  assert.deepEqual(Object.keys(result).sort(), ["ok", "reason"], `${label}: nothing but the closed token`);
}

// Scenario: Runner Output Must Match The Determined Route
test("checkFinalSuiteOutput consumer-na: accepts exactly the runner constant plus LF", () => {
  assert.deepEqual(checkFinalSuiteOutput({ route: "consumer-na", stdout: NA_BYTES, stderr: Buffer.alloc(0) }), { ok: true });
  assert.deepEqual(checkFinalSuiteOutput({ route: "consumer-na", stdout: `${CONSUMER_PROFILE_NA_LINE}\n`, stderr: "" }), { ok: true });
  // stderr content is not part of the route decision, only its encoding.
  assert.deepEqual(
    checkFinalSuiteOutput({ route: "consumer-na", stdout: NA_BYTES, stderr: Buffer.from("(node:1) Warning: noise\n") }),
    { ok: true },
  );
});

// Scenario: Runner Output Must Match The Determined Route
test("checkFinalSuiteOutput consumer-na: any other stdout shape is rejected with the mismatch token", () => {
  const na = CONSUMER_PROFILE_NA_LINE;
  const shapes = [
    ["empty output", ""],
    ["missing trailing newline", na],
    ["CRLF line ending", `${na}\r\n`],
    ["extra line after", `${na}\n[test-suite] unexpected extra line\n`],
    ["extra line before", `[test-suite] preface\n${na}\n`],
    ["doubled line", `${na}\n${na}\n`],
    ["trailing blank line", `${na}\n\n`],
    ["leading space", ` ${na}\n`],
    ["trailing space", `${na} \n`],
    ["tier summary", TIER_SUMMARY],
    ["smoke N/A line alone", `${SMOKE_NA_LINE}\n`],
    ["smoke N/A line plus smoke summary", `${SMOKE_NA_LINE}\n[test-suite] smoke=submodule-init real=0.1s status=pass\n`],
    ["N/A line plus tier summary", `${na}\n${TIER_SUMMARY}`],
    ["different wording", "[test-suite] source-maintainer checks: N/A reason=other\n"],
    ["lowercase", `${na.toLowerCase()}\n`],
  ];
  for (const [label, stdout] of shapes) {
    assertRejected({ route: "consumer-na", stdout, stderr: "" }, "consumer-na-output-mismatch", label);
    assertRejected({ route: "consumer-na", stdout: Buffer.from(stdout, "utf8"), stderr: Buffer.alloc(0) }, "consumer-na-output-mismatch", `${label} (Buffer)`);
  }
});

// Scenario: Runner Output Must Match The Determined Route
test("checkFinalSuiteOutput: non-UTF-8 stdout or stderr and malformed inputs are rejected on both routes", () => {
  const bad = Buffer.from([0xff, 0xfe, 0x0a]);
  for (const route of ["consumer-na", "source-suite"]) {
    assertRejected({ route, stdout: bad, stderr: "" }, "stdout-not-utf8", `${route}: stdout`);
    assertRejected({ route, stdout: NA_BYTES, stderr: bad }, "stderr-not-utf8", `${route}: stderr`);
    assertRejected({ route, stdout: undefined, stderr: "" }, "output-malformed", `${route}: undefined stdout`);
    assertRejected({ route, stdout: "", stderr: null }, "output-malformed", `${route}: null stderr`);
    assertRejected({ route, stdout: 42, stderr: "" }, "output-malformed", `${route}: numeric stdout`);
  }
  // The consumer route stays byte-exact even when the extra bytes are valid UTF-8.
  assertRejected(
    { route: "consumer-na", stdout: Buffer.concat([NA_BYTES, Buffer.from("é")]), stderr: "" },
    "consumer-na-output-mismatch",
    "valid UTF-8 suffix",
  );
});

// Scenario: Runner Output Must Match The Determined Route
test("checkFinalSuiteOutput: an unknown route fails closed", () => {
  for (const route of [undefined, null, "", "consumer-smoke", "Consumer-NA", "source", 7]) {
    assertRejected({ route, stdout: NA_BYTES, stderr: "" }, "invalid-route", `route=${String(route)}`);
  }
  assert.deepEqual(checkFinalSuiteOutput(), { ok: false, reason: "invalid-route" });
});

// Scenario: Runner Output Must Match The Determined Route
test("checkFinalSuiteOutput source-suite: any source-maintainer N/A line fails closed before summary parsing", () => {
  const reason = "source-route-reported-not-applicable";
  const lines = [
    ["consumer variant alone", `${CONSUMER_PROFILE_NA_LINE}\n`],
    ["smoke variant alone", `${SMOKE_NA_LINE}\n`],
    ["consumer variant before a valid tier summary", `${CONSUMER_PROFILE_NA_LINE}\n${TIER_SUMMARY}`],
    ["smoke variant after a valid tier summary", `${TIER_SUMMARY}${SMOKE_NA_LINE}\n`],
    ["smoke variant plus smoke summary", `${SMOKE_NA_LINE}\n[test-suite] smoke=submodule-init real=0.1s status=pass\n`],
    ["no trailing newline", CONSUMER_PROFILE_NA_LINE],
    ["bare prefix", SOURCE_MAINTAINER_NA_PREFIX],
    ["CRLF separated", `[test-suite] tier=unit real=1s status=pass\r\n${CONSUMER_PROFILE_NA_LINE}\r\n`],
    ["bare CR separated", `x\r${CONSUMER_PROFILE_NA_LINE}\r`],
    ["variant with a different reason", "[test-suite] source-maintainer checks: N/A reason=anything\n"],
  ];
  for (const [label, stdout] of lines) {
    assertRejected({ route: "source-suite", stdout, stderr: "" }, reason, label);
  }
  // Only stdout counts: an N/A line on stderr is just logged text.
  assert.deepEqual(
    checkFinalSuiteOutput({ route: "source-suite", stdout: TIER_SUMMARY, stderr: `${CONSUMER_PROFILE_NA_LINE}\n` }),
    { ok: true },
  );
});

// Scenario: Runner Output Must Match The Determined Route
test("checkFinalSuiteOutput source-suite: ordinary tier output passes through to the summary parser", () => {
  assert.deepEqual(checkFinalSuiteOutput({ route: "source-suite", stdout: TIER_SUMMARY, stderr: "" }), { ok: true });
  assert.deepEqual(checkFinalSuiteOutput({ route: "source-suite", stdout: Buffer.from(TIER_SUMMARY), stderr: Buffer.alloc(0) }), { ok: true });
  // A mid-line mention is not an N/A line.
  assert.deepEqual(
    checkFinalSuiteOutput({ route: "source-suite", stdout: `note: ${SOURCE_MAINTAINER_NA_PREFIX} is quoted here\n${TIER_SUMMARY}`, stderr: "" }),
    { ok: true },
  );
  // Empty output is not rejected here; the existing summary parser owns that.
  assert.deepEqual(checkFinalSuiteOutput({ route: "source-suite", stdout: "", stderr: "" }), { ok: true });
});

// Scenario: Runner Output Must Match The Determined Route
test("checkFinalSuiteOutput: diagnostics never echo runner output", () => {
  const secret = "SECRET-RUNNER-OUTPUT";
  const results = [
    checkFinalSuiteOutput({ route: "consumer-na", stdout: `${secret}\n`, stderr: "" }),
    checkFinalSuiteOutput({ route: "source-suite", stdout: `${SOURCE_MAINTAINER_NA_PREFIX} ${secret}\n`, stderr: "" }),
    checkFinalSuiteOutput({ route: "consumer-na", stdout: NA_BYTES, stderr: Buffer.from([0xff]) }),
  ];
  for (const result of results) {
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
    assert.equal(JSON.stringify(result).includes("PATH-LEAK"), false);
  }
});

// ---------------------------------------------------------------------------
// N/A literal lock
// ---------------------------------------------------------------------------

// Scenario: Runner Output Must Match The Determined Route
test("N/A literal lock: the runner constant is the exact legacy wording and the prefix covers both variants", () => {
  assert.equal(CONSUMER_PROFILE_NA_LINE, CONSUMER_NA_LITERAL);
  assert.equal(CONSUMER_PROFILE_NA_LINE.startsWith(SOURCE_MAINTAINER_NA_PREFIX), true);
  assert.equal(SMOKE_NA_LINE.startsWith(SOURCE_MAINTAINER_NA_PREFIX), true);
  assert.equal(SOURCE_MAINTAINER_NA_PREFIX, "[test-suite] source-maintainer checks: N/A");
  assert.equal(CONSUMER_PROFILE_NA_LINE.includes("\n"), false);

  // The smoke variant is not exported by the runner; lock that its text still
  // lives there so the prefix keeps covering it, and that main() prints the
  // exported constant instead of a second copy of the consumer wording.
  const runnerSource = readFileSync(repoPath(".devpro/scripts/run-test-suite.mjs"), "utf8");
  assert.equal(runnerSource.includes(SMOKE_NA_LINE), true, "runner still prints the smoke N/A wording");
  assert.equal(runnerSource.split(CONSUMER_NA_LITERAL).length - 1, 1, "the consumer wording is defined exactly once in the runner");
  assert.match(runnerSource, /console\.log\(CONSUMER_PROFILE_NA_LINE\)/u);
});
