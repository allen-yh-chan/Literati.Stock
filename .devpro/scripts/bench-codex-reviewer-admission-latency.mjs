#!/usr/bin/env node
// Full hook-chain latency benchmark for the Codex reviewer admission scan, at the EXACT admissible boundary.
//
// One-off development tool: it is not on any hook path and not part of the canonical suite. Run it again whenever a change raises
// CODEX_REVIEWER_WORKTREE_LIST_MAX or CODEX_REVIEWER_INTENT_ENTRY_MAX (both in hooks/lib/admission-record.mjs), and record the numbers in
// that change's decisions.md. Rule (design-core.md section 8): with both budgets full at once, the SLOWEST of 5 runs must stay <= 18 s
// (one tenth of the launcher's 180 s fail-open limit, so a machine 10x slower is still inside it). Above that the constants must not be raised.
//
//   node .devpro/scripts/bench-codex-reviewer-admission-latency.mjs [--worktrees N] [--entries M] [--runs 5] [--limit-s 18]
//                                                                   [--scenarios baseline,typical,live,claimed,success] [--sp <scratch-dir>] | --self-test
//
//   --worktrees N   TOTAL `git worktree list` entries INCLUDING the main checkout (N-1 linked worktrees); default 128
//   --entries M     intent-directory listing entries summed over all intent directories at the moment of every scan; default 8192
//
// The two budget constants are rewritten to exactly N and M in a throwaway copy of the scripts, so the run sits ON the boundary (N and M
// pass, one more fails) and a `>=` slip in the product would fail the benchmark. A constant that is not found exactly once makes the
// benchmark exit 1 naming it.
// Every run (a) asserts the workload shape BEFORE the chain runs, measured independently of the code under test (`git worktree list
// --porcelain` and `readdir`, main included), and (b) asserts exit status, exact stdout, empty stderr and side effects AFTER it. A successful
// admission is verified by reading the persisted record back with the repo's own authority verifier. Any run that misses its expectation makes
// the whole benchmark exit 1: no numbers are trusted. POSIX only (the chain is launched through /bin/sh like .codex/hooks.json does).
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SP = opt("sp", os.tmpdir());
const TOTAL = Number(opt("worktrees", "128"));
const ENTRIES = Number(opt("entries", "8192"));
const RUNS = Number(opt("runs", "5"));
const LIMIT_S = Number(opt("limit-s", "18"));
const SCENARIOS = opt("scenarios", "baseline,typical,live,claimed,success").split(",");
const FAULT = opt("fault", "none"); // self-test only: injects a defect that the assertions must catch
const WORKTREE_CONSTANT = "CODEX_REVIEWER_WORKTREE_LIST_MAX";
const ENTRY_CONSTANT = "CODEX_REVIEWER_INTENT_ENTRY_MAX";

if (process.platform === "win32") {
  console.error("bench-codex-reviewer-admission-latency: POSIX only (/bin/sh hook launch); not measured on Windows");
  process.exit(2);
}

if (argv.includes("--self-test")) {
  // each defect is injected into a real (small) run in a child process; the benchmark must exit 1 for every one of them
  const child = (...extra) => spawnSync(process.execPath, [process.argv[1], "--sp", SP, "--worktrees", "4", "--entries", "12", "--runs", "1", "--scenarios", "success", ...extra], { encoding: "utf8" });
  const cases = [
    { name: "control (no defect)", args: [], expectExit: 0 },
    { name: "the persisted record is deleted after the chain ran", args: ["--fault", "delete-record"], expectExit: 1 },
    { name: "the persisted record has one byte flipped", args: ["--fault", "flip-record"], expectExit: 1 },
    { name: "the record's ready marker (.json.ok) is deleted", args: ["--fault", "delete-ok-marker"], expectExit: 1 },
    { name: "the records directory is read-only, so the hook cannot persist the record (real failure)", args: ["--fault", "readonly-records-dir"], expectExit: 1 },
    { name: "the workload has one worktree too many (inadmissible shape)", args: ["--fault", "extra-worktree"], expectExit: 1 },
    { name: "the workload has one intent-dir entry too many (inadmissible shape)", args: ["--fault", "extra-entry"], expectExit: 1 },
    { name: "a budget constant is not found exactly once (exit 1 naming it)", args: ["--fault", "missing-constant"], expectExit: 1, expectStderr: ENTRY_CONSTANT },
  ];
  let all = true;
  for (const c of cases) {
    const r = child(...c.args);
    const run = (r.stdout || "").split("\n").find((l) => l.startsWith("RUN "));
    const problems = run ? JSON.parse(run.slice(4)).problems : ["(no RUN line)"];
    const pass = r.status === c.expectExit && (!c.expectStderr || (r.stderr || "").includes(c.expectStderr));
    if (!pass) all = false;
    console.log(`${pass ? "PASS" : "FAIL"}  [${c.name}] benchmark exit=${r.status} (expected ${c.expectExit}) problems=${JSON.stringify(problems)}`);
  }
  console.log("SELFTEST", JSON.stringify({ cases: cases.length, all_pass: all }));
  process.exit(all ? 0 : 1);
}

const git = (cwd, ...a) => {
  const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const distribute = (total, k) => Array.from({ length: k }, (_, i) => Math.floor(total / k) + (i < total % k ? 1 : 0));

// `export const NAME = <number>;` must occur exactly once; the value is replaced, anything else fails loudly and names the constant.
function pinConstant(src, name, value) {
  const re = new RegExp(`^export const ${name} = [0-9_]+;$`, "gm");
  const hits = src.match(re) ?? [];
  if (hits.length !== 1) throw new Error(`budget constant ${name} not found exactly once (expected a line \`export const ${name} = <number>;\` in hooks/lib/admission-record.mjs, found ${hits.length})`);
  return src.replace(re, `export const ${name} = ${value};`);
}

console.log("ENV " + JSON.stringify({ platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, node: process.version, git: git(".", "--version"), worktrees_total: TOTAL, entries: ENTRIES, runs: RUNS, limit_s: LIMIT_S, load_avg_at_start: os.loadavg().map((x) => Math.round(x * 10) / 10) }));

const work = mkdtempSync(path.join(SP, "bench-admission-"));
const repo = path.join(work, "repo");
mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.email", "bench@example.invalid");
git(repo, "config", "user.name", "bench");
writeFileSync(path.join(repo, "README.md"), "x\n");
git(repo, "add", ".");
git(repo, "commit", "-q", "-m", "init");

// the real scripts (no tests, no live hook state), with only the two budget constants pinned to the measured boundary
cpSync(path.join(REPO, ".devpro/scripts"), path.join(repo, ".devpro/scripts"), {
  recursive: true,
  filter: (s) => !s.includes(`${path.sep}tests`) && !s.includes(path.join("hooks", "state")),
});
const modPath = path.join(repo, ".devpro/scripts/hooks/lib/admission-record.mjs");
try {
  let src = readFileSync(modPath, "utf8");
  src = pinConstant(src, WORKTREE_CONSTANT, TOTAL);
  src = pinConstant(src, FAULT === "missing-constant" ? `${ENTRY_CONSTANT}_ABSENT` : ENTRY_CONSTANT, ENTRIES);
  writeFileSync(modPath, src);
} catch (error) {
  console.error(`bench-codex-reviewer-admission-latency: ${error.message}`);
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}
const { issueCodexReviewerAdmission, verifyCodexReviewerAdmissionAuthority, admissionHandoff } = await import(pathToFileURL(modPath).href);

// the hook command is read from the real .codex/hooks.json (the spawn_agent PreToolUse handler), not retyped
const hookCommand = (() => {
  const j = JSON.parse(readFileSync(path.join(REPO, ".codex/hooks.json"), "utf8"));
  const g = j.hooks.PreToolUse.find((x) => /spawn_agent/.test(x.matcher || ""));
  return g.hooks[0].command;
})();

const requestFor = (id, head) => ({
  schema: "devpro.codex-reviewer-admission-request/v1", change_id: id, base_sha: head, head_sha: head,
  objective: "independent-judgment", responsibility_id: "primary-review", instance_mode: "fresh",
  evidence_scope: "local diff", return_and_stop: "return findings and stop", role: "dp-reviewer",
  agent_type: "dp-reviewer", task_name: "review_round", fork_turns: "none", context_mode: "fresh", ttl_seconds: 600,
});

// ---------------------------------------------------------------- workload construction
const wts = []; // { id, wt, changeDir, dir, baseId, baseText }
function addWorktree(i) {
  const id = `c${i}`;
  git(repo, "worktree", "add", "-q", "-b", `bugfix/${id}`, `.worktree/${id}`);
  const wt = path.join(repo, ".worktree", id);
  const changeDir = path.join(wt, "openspec", "changes", id);
  mkdirSync(changeDir, { recursive: true });
  const w = { id, wt, changeDir, dir: path.join(changeDir, "admission-records", "codex-reviewer-intents"), baseId: null, baseText: null };
  w.baseId = issue(w);
  w.baseText = readFileSync(path.join(w.dir, w.baseId + ".json"), "utf8");
  wts.push(w);
}
function issue(w) {
  const r = issueCodexReviewerAdmission({ cwd: w.wt, request: requestFor(w.id, git(w.wt, "rev-parse", "HEAD")) });
  if (!r.ok) throw new Error("issue failed " + JSON.stringify(r));
  return r.intent_id;
}
function ensureLinked(n) { while (wts.length < n) addWorktree(wts.length); }
const wipe = (w) => { for (const n of readdirSync(w.dir)) rmSync(path.join(w.dir, n), { recursive: true, force: true }); };
const putIntent = (w, id, text) => writeFileSync(path.join(w.dir, id + ".json"), text, { mode: 0o600 });
const liveCopy = (w) => { const id = randomUUID(); putIntent(w, id, w.baseText.replaceAll(w.baseId, id)); return id; };
const claimedPair = (w) => { const id = liveCopy(w); mkdirSync(path.join(w.dir, id + ".claim")); return id; }; // the scan only checks that the claim dir exists
const expiredCopy = (w) => { // an unclaimed intent whose window ended an hour ago (a dead entry, like the real repo's expired ones)
  const id = randomUUID();
  const j = JSON.parse(w.baseText);
  const past = Date.now() - 3600_000;
  putIntent(w, id, w.baseText.replaceAll(w.baseId, id).replace(j.issued_at, new Date(past).toISOString()).replace(j.expires_at, new Date(past + 600_000).toISOString()));
  return id;
};
function refreshBases() {
  for (const w of wts) { wipe(w); w.baseId = issue(w); w.baseText = readFileSync(path.join(w.dir, w.baseId + ".json"), "utf8"); }
}
function layoutLive(entries) { refreshBases(); const per = distribute(entries, wts.length); wts.forEach((w, i) => { wipe(w); for (let n = 0; n < per[i]; n += 1) liveCopy(w); }); }
function layoutClaimed(entries) {
  if (entries % 2) throw new Error("claimed layout needs an even entry count");
  refreshBases();
  const per = distribute(entries / 2, wts.length);
  wts.forEach((w, i) => { wipe(w); for (let n = 0; n < per[i]; n += 1) claimedPair(w); });
}
// success layout: every entry is dead (claimed pair) except one expired unclaimed intent (parity) and, per run, ONE live intent in wts[0]
function layoutSuccess(entries) {
  refreshBases();
  const dead = entries - 1; // the live intent is added per run
  const needExpired = dead % 2 === 1;
  const per = distribute((dead - (needExpired ? 1 : 0)) / 2, wts.length);
  wts.forEach((w, i) => { wipe(w); for (let n = 0; n < per[i]; n += 1) claimedPair(w); });
  if (needExpired) expiredCopy(wts[wts.length > 1 ? 1 : 0]);
}

// ---------------------------------------------------------------- independent measurements
const recordsDir = (w) => path.join(w.changeDir, "admission-records");
function shape() {
  // `git worktree list` counts the main checkout too: TOTAL is main + (TOTAL - 1) linked
  const worktrees_total = git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;
  let entries = 0; let claims = 0; let unclaimed = 0; let live = 0; let records = 0;
  const now = Date.now();
  for (const w of wts) {
    const names = readdirSync(w.dir);
    const set = new Set(names);
    entries += names.length;
    for (const n of names) {
      if (n.endsWith(".claim")) claims += 1;
      else if (n.endsWith(".json") && !set.has(n.slice(0, -5) + ".claim")) {
        unclaimed += 1;
        if (Date.parse(JSON.parse(readFileSync(path.join(w.dir, n), "utf8")).expires_at) > now) live += 1;
      }
    }
    records += readdirSync(recordsDir(w)).filter((n) => n.endsWith(".json")).length;
  }
  return { worktrees_total, entries, claims, unclaimed_json: unclaimed, live, records };
}
function chainRun(payload) {
  const t0 = performance.now();
  const res = spawnSync("/bin/sh", ["-c", hookCommand], { cwd: repo, input: JSON.stringify(payload), encoding: "utf8", timeout: 300_000 });
  return { ms: Math.round(performance.now() - t0), exit: res.status, signal: res.signal, error: res.error ? String(res.error.code ?? res.error.message) : null, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim() };
}
const spawnPayload = () => ({
  tool_name: "collaborationspawn_agent",
  tool_input: { agent_type: "dp-reviewer", fork_turns: "none", message: "gAAAAA" + "a".repeat(48), task_name: "review_round" },
  cwd: repo,
});
const readPayload = () => ({ tool_name: "Read", tool_input: { file_path: path.join(repo, "README.md") }, cwd: repo });

// ---------------------------------------------------------------- expectations (each returns a list of problems; empty = met)
const chainProblems = (o) => [
  ...(o.error || o.signal || o.exit !== 0 ? [`chain-status(exit=${o.exit},signal=${o.signal},error=${o.error})`] : []),
  ...(o.stderr !== "" ? ["stderr-not-empty"] : []),
];
const noStateChange = (b, a) => [...(a.claims !== b.claims ? ["claim-count-changed"] : []), ...(a.records !== b.records ? ["record-count-changed"] : [])];
const expectSilent = (o, b, a) => [...chainProblems(o), ...(o.stdout !== "" ? ["stdout-not-empty"] : []), ...noStateChange(b, a)];
const expectBlock = (code) => (o, b, a) => [
  ...chainProblems(o),
  ...(o.stdout !== JSON.stringify({ decision: "block", reason: `Spawn Context Admission Gate: ${code}` }) ? ["stdout-not-the-expected-block-json"] : []),
  ...noStateChange(b, a),
];
const HANDOFF = /^admission_record: ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) sha256=([0-9a-f]{64})$/;
function expectAdmitted(ctx) {
  return (o, b, a) => {
    const problems = [...chainProblems(o)];
    let message = null;
    try { const j = JSON.parse(o.stdout); if (Object.keys(j).join() !== "systemMessage") problems.push("stdout-has-unexpected-keys"); message = j.systemMessage; } catch { problems.push("stdout-not-json"); }
    const m = HANDOFF.exec(message ?? "");
    if (!m) problems.push("handoff-message-malformed");
    else {
      ctx.recordId = m[1];
      // the persisted record is read back with the repo's own authority verifier (record, ready marker, intent binding, claim)
      const v = verifyCodexReviewerAdmissionAuthority({ repoRoot: ctx.targetRoot, changeId: ctx.target.id, recordId: m[1] });
      if (!v.ok) problems.push(`record-authority-verification-failed(${v.code})`);
      else {
        if (admissionHandoff({ record_id: m[1], digest: v.admission.digest }) !== message) problems.push("handoff-does-not-match-persisted-record");
        if (v.intent_ref.intent_id !== ctx.issuedIntentId) problems.push("record-bound-to-a-different-intent");
      }
    }
    if (a.claims !== b.claims + 1) problems.push("claim-count-delta-not-1");
    if (a.records !== b.records + 1) problems.push("record-count-delta-not-1");
    return problems;
  };
}

// ---------------------------------------------------------------- runner
const results = [];
let allMet = true;
function scenario(label, want, { payload, expect, before = () => ({}), afterChain = () => {}, worst = false }) {
  const runs = [];
  for (let r = 1; r <= RUNS; r += 1) {
    const ctx = before(r);
    const pre = shape();
    const shapeProblems = Object.entries(want).filter(([k, v]) => pre[k] !== v).map(([k, v]) => `workload-shape-mismatch(${k}: have ${pre[k]}, want ${v})`);
    let out = null; let problems = shapeProblems; let post = pre;
    if (!shapeProblems.length) { // an inadmissible workload is never timed
      if (FAULT === "readonly-records-dir" && ctx?.target) chmodSync(recordsDir(ctx.target), 0o500);
      out = chainRun(payload());
      if (FAULT === "readonly-records-dir" && ctx?.target) chmodSync(recordsDir(ctx.target), 0o700);
      afterChain(out, ctx);
      post = shape();
      problems = expect(ctx ?? {})(out, pre, post);
    }
    const met = problems.length === 0;
    if (!met) allMet = false;
    const line = { scenario: label, run: r, ms: out?.ms ?? null, exit: out?.exit ?? null, stdout: out?.stdout.slice(0, 200) ?? null, stderr: out?.stderr.slice(0, 120) ?? null, before: pre, after: post, expectation_met: met, problems };
    runs.push(line);
    console.log("RUN " + JSON.stringify(line));
  }
  const ms = runs.map((x) => x.ms).filter((x) => x !== null);
  const summary = { scenario: label, worktrees_total: want.worktrees_total, entries: want.entries, runs: RUNS, ms_all: ms, ms_median: ms.length ? median(ms) : null, ms_max: ms.length ? Math.max(...ms) : null, expectation_met_all: runs.every((x) => x.expectation_met), worst };
  results.push(summary);
  console.log("SCENARIO " + JSON.stringify(summary));
}

if (SCENARIOS.includes("baseline")) { // fixed overhead: same chain, non-spawn tool; only main exists (no worktrees yet)
  scenario("BASELINE_non_spawn_tool", { worktrees_total: 1, entries: 0 }, { payload: readPayload, expect: () => expectSilent });
}
if (SCENARIOS.includes("typical") && TOTAL >= 32) { // a typical repo: 32 worktrees in total, 64 entries, all live
  ensureLinked(31);
  layoutLive(64);
  scenario("TYPICAL_32wt_64entries_all_live", { worktrees_total: 32, entries: 64, unclaimed_json: 64, live: 64 }, { payload: spawnPayload, expect: () => expectBlock("intent-ambiguous") });
}
ensureLinked(TOTAL - 1);
if (SCENARIOS.includes("live")) {
  layoutLive(ENTRIES);
  scenario(`WORST_${TOTAL}wt_${ENTRIES}entries_all_live`, { worktrees_total: TOTAL, entries: ENTRIES, unclaimed_json: ENTRIES, live: ENTRIES }, { payload: spawnPayload, expect: () => expectBlock("intent-ambiguous"), worst: true });
}
if (SCENARIOS.includes("claimed")) {
  layoutClaimed(ENTRIES);
  scenario(`WORST_${TOTAL}wt_${ENTRIES}entries_all_claimed`, { worktrees_total: TOTAL, entries: ENTRIES, unclaimed_json: 0, live: 0 }, { payload: spawnPayload, expect: () => expectBlock("intent-consumed"), worst: true });
}
if (SCENARIOS.includes("success")) {
  layoutSuccess(ENTRIES);
  const target = wts[0];
  const targetRoot = git(target.wt, "rev-parse", "--show-toplevel");
  let usedId = null;
  const expiredCount = (ENTRIES - 1) % 2 === 1 ? 1 : 0;
  scenario(`SUCCESS_${TOTAL}wt_${ENTRIES}entries_one_live`, { worktrees_total: TOTAL, entries: ENTRIES, unclaimed_json: 1 + expiredCount, live: 1 }, {
    payload: spawnPayload,
    worst: true,
    before: () => { // bring the workload back to the exact boundary: drop last run's consumed pair, then issue one fresh live intent
      if (usedId) { rmSync(path.join(target.dir, usedId + ".json")); rmSync(path.join(target.dir, usedId + ".claim"), { recursive: true }); }
      const issuedIntentId = issue(target);
      usedId = issuedIntentId;
      if (FAULT === "extra-worktree") git(repo, "worktree", "add", "-q", "-b", `bugfix/extra-${randomUUID().slice(0, 8)}`, path.join(work, `extra-${randomUUID().slice(0, 8)}`));
      if (FAULT === "extra-entry") writeFileSync(path.join(target.dir, "stray.txt"), "x");
      return { target, targetRoot, issuedIntentId };
    },
    afterChain: (out, ctx) => { // self-test defects applied to the persisted record after the chain ran
      const m = HANDOFF.exec((() => { try { return JSON.parse(out.stdout).systemMessage; } catch { return ""; } })() ?? "");
      if (!m) return;
      const file = path.join(recordsDir(ctx.target), `${m[1]}.json`);
      if (FAULT === "delete-record") unlinkSync(file);
      if (FAULT === "flip-record") { const b = readFileSync(file); b[Math.floor(b.length / 2)] ^= 0x01; writeFileSync(file, b); }
      if (FAULT === "delete-ok-marker") unlinkSync(`${file}.ok`);
    },
    expect: (ctx) => expectAdmitted(ctx),
  });
}

// the budget rule: only the both-budgets-full scenarios are held to it
const rule = results.filter((x) => x.worst).map((x) => ({ scenario: x.scenario, ms_max: x.ms_max, limit_ms: LIMIT_S * 1000, within_limit: x.ms_max !== null && x.ms_max <= LIMIT_S * 1000 }));
const ruleMet = rule.every((x) => x.within_limit);
console.log("RULE " + JSON.stringify({ slowest_of_runs_must_be_within_s: LIMIT_S, scenarios: rule, met: ruleMet }));
console.log("SUMMARY " + JSON.stringify({ runs_per_scenario: RUNS, all_expectations_met: allMet, rule_met: ruleMet, scenarios: results.map((x) => ({ s: x.scenario, median_ms: x.ms_median, max_ms: x.ms_max, met: x.expectation_met_all })) }));
rmSync(work, { recursive: true, force: true });
process.exit(allMet && ruleMet ? 0 : 1);
