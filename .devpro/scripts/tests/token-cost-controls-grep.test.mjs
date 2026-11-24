import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRepoFile as read } from "./lib/read.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));


// Read every `sync-agent-rules*.test.mjs` split-family file concatenated. The
// long-pole test file was split for tier-runtime balancing, so anchors that
// used to live in the single `sync-agent-rules.test.mjs` can now be in any
// sibling (`-d`, `-e`, …). Match against the family, not one hardcoded name,
// so future splits don't silently break this grep guard.
function readSyncTestFamily() {
  return readdirSync(scriptDir)
    .filter((f) => /^sync-agent-rules.*\.test\.mjs$/.test(f))
    .sort()
    .map((f) => readFileSync(path.join(scriptDir, f), "utf8"))
    .join("\n");
}

test("cross-review hot path requires focused sticky-refresh before broad exploration", () => {
  const crossModel = read(".devpro/agent-rules/code-review-cross-model.md");
  const codexHost = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  const openspecFlow = read("openspec/specs/openspec-flow/spec.md");
  const checklistSpec = read("openspec/specs/code-review-checklist/spec.md");

  for (const [name, body] of Object.entries({ crossModel, codexHost, openspecFlow, checklistSpec })) {
    assert.match(body, /focused sticky-refresh/, `${name}: focused sticky-refresh anchor missing`);
    assert.match(body, /MUST NOT[\s\S]{0,180}(broad repo exploration|broad exploration)/, `${name}: broad-first prohibition missing`);
  }
});

test("cross-model rationale and Codex-host troubleshooting live in cold siblings", () => {
  const crossModel = read(".devpro/agent-rules/code-review-cross-model.md");
  const rationale = read(".devpro/agent-rules/code-review-cross-model-rationale.md");
  const codexHost = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
  const troubleshooting = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review-troubleshooting.md");

  assert.match(crossModel, /code-review-cross-model-rationale\.md/);
  assert.doesNotMatch(crossModel, /### Why Cross-Model: PGE Principle/);
  assert.match(rationale, /Prompter[\s\S]*Generator[\s\S]*Evaluator/);
  assert.match(rationale, /Same-Family Blind Spots/);
  assert.match(rationale, /provider probe/);

  assert.match(codexHost, /codex-host-cross-review-troubleshooting\.md/);
  assert.doesNotMatch(codexHost, /2026-06-05 live probe/);
  assert.match(troubleshooting, /2026-06-05 live probe/);
  assert.match(troubleshooting, /error_max_turns/);
  assert.match(troubleshooting, /permission_denials/);
});

function contextHeadroomGateCarrier(body) {
  const start = body.indexOf("Context Headroom Gate");
  assert.notEqual(start, -1, "Context Headroom Gate heading/carrier missing");
  const fromHeading = body.slice(start);
  const cut = fromHeading.search(/\n(?:### Requirement:|Runtime auto-compact )/);
  return cut === -1 ? fromHeading : fromHeading.slice(0, cut);
}

function assertLiveHeadroomGate(name, body) {
  const gate = contextHeadroomGateCarrier(body);
  assert.match(gate, /Context Headroom Gate/, `${name}: Context Headroom Gate missing`);
  assert.match(gate, /total_usage_tokens/, `${name}: total_usage_tokens missing in Context Headroom Gate carrier`);
  assert.match(gate, /300,?000/, `${name}: live remind 300000 missing in Context Headroom Gate carrier`);
  assert.match(gate, /400,?000/, `${name}: live stop 400000 missing in Context Headroom Gate carrier`);
  assert.doesNotMatch(gate, /150,?000/, `${name}: old live remind 150000 still in Context Headroom Gate carrier`);
  assert.doesNotMatch(gate, /200,?000/, `${name}: old live stop 200000 still in Context Headroom Gate carrier`);
  assert.match(body, /compact|\/compact/, `${name}: compact guidance missing`);
  assert.match(body, /tasks\.md|proposal-mini\.md/, `${name}: OpenSpec continuation carrier missing`);
  assert.match(body, /notes\/session-pending\.md/, `${name}: session-pending carrier missing`);
}

test("Context Headroom Gate live thresholds are pinned in token-frugal-io", () => {
  assertLiveHeadroomGate("tokenFrugal", read(".devpro/agent-rules/token-frugal-io.md"));
});

test("R5/R6: token-frugal-io Context Headroom Gate is a superset (named field ∪ existing runtime-agnostic term)", () => {
  const gate = contextHeadroomGateCarrier(read(".devpro/agent-rules/token-frugal-io.md"));

  // Existing runtime-agnostic term MUST remain (D3/D4: it is the sole
  // cooperative-coverage source on Codex host where the named field is
  // structurally unavailable — see workflow-cost-controls Gate CH).
  assert.match(gate, /total_usage_tokens/, "existing runtime-agnostic usage-total term must remain");

  // Newly added named field (D3 bounded-tail reader) must be additive.
  assert.match(gate, /cache_read_input_tokens/, "named Gate CH field must be present as an addition");
  assert.match(gate, /Codex host `unavailable`/, "Codex-host non-availability of the named field must be disclosed (D4)");
  assert.match(gate, /pre-tool-gate\.mjs.{0,10}Gate CH/, "pointer to the Gate CH implementation carrier must be present");
});

test("F-d3f33f07: token-frugal-io Context Headroom Gate keeps the runtime-agnostic compact remedy and gate rationale", () => {
  const gate = contextHeadroomGateCarrier(read(".devpro/agent-rules/token-frugal-io.md"));

  // Runtime-agnostic remedy: the cooperative-side prose MUST NOT collapse to
  // a Claude-only `/compact` slash command -- the canonical output-discipline
  // delta's own Requirement/Scenario text says "hand off to compact ... or
  // the runtime's equivalent compact operation", and this leaf is the sole
  // cooperative-coverage source on Codex host (D3/D4), where `/compact` as a
  // literal slash command does not exist.
  assert.match(gate, /runtime 支援的 compact/, "runtime-agnostic compact remedy clause must remain (not Claude-only /compact)");

  // Gate rationale: the gate exists for BOTH cost and accuracy, not cost
  // alone -- losing this line lets a future edit silently narrow the gate's
  // justification to a pure cost argument.
  assert.match(gate, /成本與準確率雙重保護/, "gate rationale (cost + accuracy dual protection) must remain");
});

test("Context Headroom Gate live thresholds are pinned in output-discipline spec", () => {
  assertLiveHeadroomGate("outputSpec", read("openspec/specs/output-discipline/spec.md"));
});

test("compact auto-compact 400000 is pinned on named carriers not a bare numeral", () => {
  const tokenFrugal = read(".devpro/agent-rules/token-frugal-io.md");
  const runtimeSettingsScript = read(".devpro/scripts/runtime-auto-compact-settings.mjs");
  const outputSpec = read("openspec/specs/output-discipline/spec.md");
  const syncTestFamily = readSyncTestFamily();

  assert.match(runtimeSettingsScript, /CLAUDE_AUTO_COMPACT_WINDOW = 500000/);
  assert.match(runtimeSettingsScript, /CLAUDE_AUTO_COMPACT_PERCENT = 80/);
  assert.match(runtimeSettingsScript, /CLAUDE_AUTO_COMPACT_TARGET_TOKENS = 400000/);
  assert.match(runtimeSettingsScript, /CODEX_AUTO_COMPACT_LIMIT = 400000/);
  assert.match(runtimeSettingsScript, /windowValue === CLAUDE_AUTO_COMPACT_WINDOW/);
  assert.match(runtimeSettingsScript, /percentValue === CLAUDE_AUTO_COMPACT_PERCENT/);
  assert.match(runtimeSettingsScript, /limit === CODEX_AUTO_COMPACT_LIMIT/);
  assert.doesNotMatch(runtimeSettingsScript, /<= CLAUDE_AUTO_COMPACT_TARGET_TOKENS/);
  assert.doesNotMatch(runtimeSettingsScript, /<= CODEX_AUTO_COMPACT_LIMIT/);
  assert.doesNotMatch(runtimeSettingsScript, /CLAUDE_AUTO_COMPACT_WINDOW = 250000/);
  assert.doesNotMatch(runtimeSettingsScript, /CLAUDE_AUTO_COMPACT_TARGET_TOKENS = 200000/);
  assert.doesNotMatch(runtimeSettingsScript, /CODEX_AUTO_COMPACT_LIMIT = 96000/);
  assert.doesNotMatch(runtimeSettingsScript, /CODEX_AUTO_COMPACT_LIMIT = 200000/);
  assert.match(tokenFrugal, /model_auto_compact_token_limit = 400000/);
  assert.match(outputSpec, /model_auto_compact_token_limit = 400000/);
  assert.match(
    outputSpec,
    /has no `model_auto_compact_token_limit` or has `model_auto_compact_token_limit = 500000` or `model_auto_compact_token_limit = 200000` or `model_auto_compact_token_limit = 96000`/
  );
  assert.match(syncTestFamily, /model_auto_compact_token_limit = 400000/);
});

test("environment-setup auto-compact suitability covers missing high and low", () => {
  const envSetup = read(".devpro/agent-rules/environment-setup-nvm-nodejs-openspec.md");
  const envSpec = read("openspec/specs/environment-setup/spec.md");
  const runtimeSettingsScript = read(".devpro/scripts/runtime-auto-compact-settings.mjs");

  assert.match(runtimeSettingsScript, /missing or above or below the recommended target/);
  assert.match(runtimeSettingsScript, /WINDOW current=/);
  assert.match(runtimeSettingsScript, /recommended=\$\{CLAUDE_AUTO_COMPACT_WINDOW\}/);
  assert.match(runtimeSettingsScript, /recommended=\$\{CLAUDE_AUTO_COMPACT_PERCENT\}/);
  assert.match(runtimeSettingsScript, /recommended=\$\{CLAUDE_AUTO_COMPACT_TARGET_TOKENS\}/);
  assert.doesNotMatch(runtimeSettingsScript, /~\$\{CLAUDE_AUTO_COMPACT_TARGET_TOKENS\} tokens/);
  assert.doesNotMatch(
    runtimeSettingsScript,
    /WINDOW current=.*recommended=\$\{CLAUDE_AUTO_COMPACT_TARGET_TOKENS\}/
  );
  assert.match(runtimeSettingsScript, /current=unreadable recommended=\$\{CLAUDE_AUTO_COMPACT_WINDOW\}/);
  assert.match(runtimeSettingsScript, /current=unreadable recommended=\$\{CODEX_AUTO_COMPACT_LIMIT\}/);
  assert.match(envSpec, /missing or above or below the recommended target/);
  // The per-stage behaviour of the class 2 entry lives in the on-demand leaf.
  const class2Checks = read(".devpro/agent-rules/environment-class2-checks.md");
  assert.match(envSetup, /`environment-class2-checks\.md`/);
  assert.match(class2Checks, /缺設定/);
  assert.match(class2Checks, /高於/);
  assert.match(class2Checks, /低於/);
  for (const carrier of [envSetup, class2Checks]) assert.doesNotMatch(carrier, /不高於建議值/);
});
