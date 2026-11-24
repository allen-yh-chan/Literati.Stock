import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const carriers = [
  "AGENTS.md",
  ".devpro/agent-rules/ai-autonomy.md",
  ".devpro/agent-rules/model-delegation.md",
  ".devpro/agent-rules/model-delegation-delegation-rules.md",
  ".devpro/agent-rules/model-delegation-token-efficiency.md",
  ".devpro/agent-rules/multi-agent-handoff.md",
  ".devpro/agent-rules/platform-adapter-contract.md",
  ".devpro/agent-rules/platform-adapters/codex.md",
  "scenarios/scenario-j-consumer-repo-dp-assistant-delegation.md",
];

function read(file) {
  return readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
}

test("task shape remains an admission signal and never standalone spawn authority", () => {
  const forbidden = [
    /≥2[^\n]{0,80}(?:自動授權|automatic authorization)/i,
    /≥2[^\n]{0,80}(?:立即委派|MUST 委派)/,
    /Subagents start with an independent context/,
    /TL 只收摘要/,
  ];
  for (const file of carriers) {
    const content = read(file);
    for (const pattern of forbidden) {
      assert.equal(pattern.test(content), false, `${file}: forbidden shape/context assertion: ${pattern}`);
    }
  }

  assert.match(read("AGENTS.md"), /task-shape[^\n]*不單獨授權 spawn/);
  assert.match(read(".devpro/agent-rules/ai-autonomy.md"), /^(?=[^\n]*task-shape)(?=[^\n]*MUST[^\n]*admission)(?=[^\n]*不單獨授權 spawn).*$/m);
  assert.match(read(".devpro/agent-rules/model-delegation.md"), /只有[^\n]*bounded responsibility[^\n]*隔離效益[^\n]*才spawn/);
  assert.match(read(".devpro/agent-rules/platform-adapter-contract.md"), /admission[^\n]*通過[^\n]*automatic authorization/);
  assert.match(read("scenarios/scenario-j-consumer-repo-dp-assistant-delegation.md"), /task-shape[^\n]*不單獨授權spawn/);
});

test("runtime adapters require explicit minimum-sufficient context modes", () => {
  const codex = read(".devpro/agent-rules/platform-adapters/codex-workflow-capabilities.md");
  const claude = read(".devpro/agent-rules/platform-adapters/claude-code-capabilities.md");
  assert.match(codex, /^(?=[^\n]*fork_turns)(?=[^\n]*none)(?=[^\n]*1\.\.6)(?=[^\n]*all)(?=[^\n]*override).*$/m);
  assert.match(claude, /CLAUDE_CODE_FORK_SUBAGENT=1[^\n]*fork_reason:/);
});

// ── strengthen-admission-binding-portability (T11) ──────────────────────────
//
// Locks the delta scenario `Carrier Change Is Not An Enforcement Downgrade`
// (openspec/changes/strengthen-admission-binding-portability/specs/pre-tool-mechanical-gates/spec.md).
// The carrier moved from "session cwd must be the worktree" to "declared key +
// filesystem exact-one decides the binding". This test pins that the move did
// not shrink the fail-closed set: the new closed codes stay in the one shared
// resolver, review／verify keep failing closed without a binding, the one new
// token is a non-blocking advisory that never mints, and the declared
// `execution_root` stays an input contract that is never persisted.
//
// D8.4 projection-face evidence (T9): `.codex/agents/dp-reviewer.toml`,
// `.cursor/agents/dp-reviewer.md` and `.opencode/agent/dp-reviewer.md` carry no
// `receipt_payload` shape at all (zero grep hits for `execution_root_head` /
// `receipt_payload` / `reviewer_identity`), so no projection sync is owed and
// `subagent-behavioral-contracts.mjs` keeps its `["六軸"]` mustInclude set.

const ADMISSION_RECORD_MODULE = ".devpro/scripts/hooks/lib/admission-record.mjs";
const SPAWN_CONTEXT_MODULE = ".devpro/scripts/hooks/lib/spawn-context-admission.mjs";
const DECLARED_BINDING_HELPER = ".devpro/scripts/resolve-admission-binding.mjs";

test("Carrier Change Is Not An Enforcement Downgrade", () => {
  const record = read(ADMISSION_RECORD_MODULE);
  const spawn = read(SPAWN_CONTEXT_MODULE);
  const helper = read(DECLARED_BINDING_HELPER);

  // One code per cause in the shared resolver: the pre-change fail-closed set
  // plus the declared-path codes, none of them relaxed.
  for (const code of [
    "change-id-invalid",
    "change-worktree-required",
    "change-worktree-ambiguous",
    "intent-scan-failed",
    "intent-candidate-limit-exceeded",
    "git-head-unavailable",
    "change-binding-mismatch",
    "admission-binding-inconsistent",
    "binding-head-detached",
    "binding-branch-protected",
    "execution-root-required",
    "execution-root-mismatch",
  ]) {
    assert.ok(record.includes(code), `shared resolver must keep the fail-closed code ${code}`);
  }
  // The optional pre-resolution pin stays fail closed in the read-only helper.
  assert.match(helper, /emitFailure\("binding-root-mismatch"\)/);

  // Review／verify keep failing closed without a binding; every other role is
  // classified advisory instead.
  assert.match(record, /ADMISSION_REVIEW_ROLES = Object\.freeze\(\["dp-reviewer", "dp-second-reviewer"\]\)/);
  assert.match(spawn, /classifyAdmissionRoleClass\(fields\.role\) === "review"/);

  // The binding-unresolved advisory is non-silent, non-minting, and never
  // independence evidence.
  const advisory = spawn.match(/ADMISSION_BINDING_UNRESOLVED_ADVISORY = "([^"]+)"/u)?.[1] ?? "";
  assert.ok(advisory.includes("binding-unresolved"), "advisory must carry the closed reason token");
  assert.ok(advisory.includes("admission-records-unavailable"), "advisory must name the lineage gap");
  assert.equal(advisory.includes("admission_record:"), false, "the advisory MUST NOT mint a record");
  assert.match(advisory, /MUST NOT be used as independence evidence/);

  // The branch-convention token is the one new non-blocking advisory — pushed
  // into advisories, never into the blocking failure-code surface.
  assert.match(record, /advisories\.push\("binding-branch-convention-advisory"\)/);
  assert.equal(/code: "binding-branch-convention-advisory"/u.test(record), false);
  assert.equal(/binding-branch-convention-advisory[^\n]*fail closed/u.test(record), false);

  // `execution_root` is an input contract only: validated on the declared path,
  // never persisted into the record.
  assert.match(record, /declaredExecutionRootProblem\(binding\.repoRoot, fields\)/);
  assert.match(record, /never persisted into the record/);
});

// T11 retention record: the superseded corroboration helper is deliberately
// kept (not deleted) with its SUPERSEDED pointer to the closed read-order
// resolver, so a future cleanup cannot drop it silently.
test("superseded declaration read-order helper stays annotated for its shared resolver", () => {
  const record = read(ADMISSION_RECORD_MODULE);
  assert.match(record, /SUPERSEDED \(strengthen-admission-binding-portability design D1\)/);
  assert.match(record, /new code MUST use `resolveDeclaredChangeLookupKey`/);
});

test("replay coverage never launches an agent runtime", () => {
  const replay = read(".devpro/scripts/tests/hook-pre-tool-gate-spawn-context.test.mjs");
  assert.doesNotMatch(replay, /(?:collaboration\.)?spawn_agent\s*\(/);
  assert.doesNotMatch(replay, /collaborationspawn_agent\s*\(/);
});
