/**
 * Cooperative-only wording-stability guard for the active-delegation
 * interruption lifecycle. It does not enforce runtime TL behavior.
 * Polarity-sensitive clauses use same-physical-line compound regexes so
 * unrelated tokens cannot preserve GREEN after an operative line is removed.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

function readBody(relativePath) {
  const raw = readFileSync(repoPath(relativePath), "utf8");
  const frontmatter = raw.match(/^---\n[\s\S]*?\n---\n/);
  return frontmatter ? raw.slice(frontmatter[0].length) : raw;
}

const targets = {
  entry: readBody(".devpro/agent-rules/model-delegation.md"),
  briefing: readBody(".devpro/agent-rules/model-delegation-briefing.md"),
  // The Active Delegation Interruption Gate moved verbatim to this on-demand sibling;
  // dispatch completeness stays in briefing. The architect clock and design-reviewer clauses
  // are read from the entry leaf and the handoff leaf, which the briefing points to.
  lifecycle: readBody(".devpro/agent-rules/model-delegation-active-lifecycle.md"),
  delegationRules: readBody(".devpro/agent-rules/model-delegation-delegation-rules.md"),
  handoff: readBody(".devpro/agent-rules/multi-agent-handoff.md"),
  platformContract: readBody(".devpro/agent-rules/platform-adapter-contract.md"),
  codexAdapter: readBody(".devpro/agent-rules/platform-adapters/codex.md"),
  openspecFallback: readBody(".devpro/agent-rules/openspec-flow-fallback.md"),
  // dp-architect dispatch schema moved to the full-rigor reference (SKILL.md keeps a pointer line).
  dpChangeSkill: readBody(".devpro/agent-skills/devpro-workflows/change/references/full-analysis-and-design.md"),
  architectAgent: readBody(".claude/agents/dp-architect.md"),
  capabilitySpec: readBody("openspec/specs/subagent-behavioral-contract/spec.md"),
  proposal: readBody(
    "openspec/changes/archive/2026-07-14-strengthen-delegation-interruption-gate/proposal-mini.md",
  ),
};

const OPERATIVE_ANCHORS = [
  {
    name: "entry active-lifecycle route",
    target: "entry",
    rx: /active delegation lifecycle[^\n]*MUST[^\n]*`model-delegation-active-lifecycle\.md`/,
  },
  {
    name: "briefing routes post-dispatch lifecycle to the sibling leaf",
    target: "briefing",
    rx: /^> Load-chain（委派後）：[^\n]*中斷[^\n]*Subagent Artifact Landing Verification[^\n]*`model-delegation-active-lifecycle\.md`[^\n]*MUST 先讀/m,
  },
  {
    name: "lifecycle heading",
    target: "lifecycle",
    rx: /^### Active Delegation Interruption Gate$/m,
  },
  {
    name: "cooperative-only enforcement classification",
    target: "lifecycle",
    rx: /cooperative-only, weak enforcement.*cross-runtime hooks.*cannot reliably observe.*TL-side interrupt decisions.*grep\/mutation guard.*wording.*not runtime interruption behavior/,
  },
  {
    name: "no-file is not stall and landing verification is completion-only",
    target: "lifecycle",
    rx: /Active evidence[^\n]*checkpoint[^\n]*handoff[^\n]*done[^\n]*MUST NOT[^\n]*no landed files[^\n]*stall[^\n]*Artifact Landing Verification[^\n]*MUST[^\n]*only[^\n]*those claims/,
  },
  {
    name: "no invented deadline or TL-selected poll window",
    target: "lifecycle",
    rx: /Observation contract.*MUST NOT.*invent.*deadline.*first_artifact_deadline.*delivery checkpoint.*poll.*observation cadence.*Neither alone proves stall.*MUST.*task-stall.*heartbeat boundary.*user.*briefing.*runtime contract.*TL-selected.*MUST NOT.*qualify/,
  },
  {
    name: "artifact dispatch completeness is immutable",
    target: "briefing",
    rx: /Dispatch completeness[^\n]*MUST fail closed before spawn[^\n]*original briefing[^\n]*claimed_artifact_paths[^\n]*first_artifact_deadline[^\n]*post-dispatch follow-up[^\n]*MUST NOT retroactively cure/,
  },
  {
    name: "claimed artifact paths have one active writer",
    target: "handoff",
    rx: /Single-writer lease[^\n]*exact or ancestor\/descendant overlap[^\n]*MUST have at most one active write owner[^\n]*retry[^\n]*replacement[^\n]*second architect[^\n]*MUST NOT grant authority[^\n]*running[^\n]*progress[^\n]*ETA[^\n]*MUST NOT be reassigned/,
  },
  {
    name: "ownership transfer needs authority and inactive old owner",
    target: "lifecycle",
    rx: /Ownership transfer[^\n]*MAY occur only[^\n]*explicit user replacement[^\n]*valid interruption evidence[^\n]*old owner[^\n]*terminal or lawfully interrupted[^\n]*confirmed inactive[^\n]*otherwise MUST fail closed/,
  },
  {
    name: "read-only reviewer never acquires write authority",
    target: "lifecycle",
    rx: /Read-only reviewer exception[^\n]*explicitly no-write[^\n]*MUST NOT claim overlapping artifact paths[^\n]*MUST NOT patch[^\n]*MUST NOT acquire write authority/,
  },
  {
    name: "progress or ETA suppresses repeated pings",
    target: "lifecycle",
    rx: /Progress suppression[^\n]*progress[^\n]*ETA[^\n]*MUST[^\n]*reset[^\n]*missed delivery checkpoint[^\n]*at most one focused status\/rebrief[^\n]*MUST NOT[^\n]*repeated status[^\n]*stated next window[^\n]*configured checkpoint/,
  },
  {
    name: "interrupt allowlist and verified-stall evidence",
    target: "lifecycle",
    rx: /Interruption allowlist[^\n]*MAY interrupt[^\n]*only[^\n]*user cancellation[^\n]*safety[^\n]*scope violation[^\n]*terminal runtime[^\n]*tool failure[^\n]*verified stall[^\n]*MUST[^\n]*one status request[^\n]*no response[^\n]*activity[^\n]*heartbeat[^\n]*not `running`[^\n]*MUST[^\n]*record[^\n]*actual interruption reason/,
  },
  {
    name: "no observation contract fails closed",
    target: "lifecycle",
    rx: /No-contract fail-closed[^\n]*no observation-window contract[^\n]*silence[^\n]*no landed files[^\n]*MUST NOT[^\n]*verified stall[^\n]*MUST[^\n]*continue waiting[^\n]*explicit user direction[^\n]*runtime evidence[^\n]*terminal failure/,
  },
  {
    name: "TL-caused interruption recovers before fallback",
    target: "lifecycle",
    rx: /TL-caused recovery[^\n]*MUST NOT[^\n]*unavailable[^\n]*fallback[^\n]*MUST[^\n]*resume[^\n]*rebrief[^\n]*valid landed checkpoint/,
  },
  {
    name: "R3 valid multi-artifact checkpoint",
    target: "lifecycle",
    rx: /R3 checkpoint[^\n]*MUST[^\n]*natural boundary[^\n]*internally valid[^\n]*cross-carrier consistent[^\n]*complete requirement\/scenario blocks[^\n]*canonical\/delta consistency[^\n]*structural\/strict validation[^\n]*MUST[^\n]*report progress[^\n]*defer landing/,
  },
  {
    name: "devpro:change architect immutable dispatch schema",
    target: "dpChangeSkill",
    rx: /dp-architect dispatch schema[^\n]*`claimed_artifact_paths`[^\n]*openspec\/changes\/<change>\/proposal\.md[^\n]*openspec\/changes\/<change>\/design\.md[^\n]*`first_artifact_deadline:\s*30m_total`[^\n]*`writer_lease:\s*single`[^\n]*`completion_mode:\s*callback`[^\n]*`completion_channel:\s*runtime completion callback\/event`/i,
  },
  {
    name: "architect total clock is accepted-dispatch based and non-resettable",
    target: "entry",
    rx: /dp-architect[^\n]*accepted dispatch[^\n]*30m_total[^\n]*MUST NOT[^\n]*reset or extend[^\n]*activity[^\n]*heartbeat[^\n]*status[^\n]*poll[^\n]*message[^\n]*focused rebrief[^\n]*neither[^\n]*idle timeout[^\n]*nor[^\n]*total task timeout/i,
  },
  {
    name: "architect deadline miss rebriefs same writer without second-writer authority",
    target: "handoff",
    rx: /artifact_landing_deadline_missed[^\n]*actual state callback[^\n]*exactly one[^\n]*focused rebrief[^\n]*same writer[^\n]*MUST NOT[^\n]*second writer[^\n]*takeover[^\n]*TL fallback/i,
  },
  {
    name: "architect takeover revokes old lease before ownership transfer",
    target: "handoff",
    rx: /dp-architect takeover[^\n]*explicit user replacement[^\n]*independently sufficient terminal\/interruption evidence[^\n]*MUST[^\n]*revoke[^\n]*original writer lease[^\n]*after revocation[^\n]*MUST[^\n]*confirm[^\n]*inactive[^\n]*only then[^\n]*never before[^\n]*ownership-transfer record[^\n]*missing or reordered steps[^\n]*MUST FAIL CLOSED/i,
  },
  {
    name: "architect design reviewer is no-write and no-claim",
    target: "handoff",
    rx: /independent design reviewer[^\n]*MAY coexist[^\n]*only[^\n]*no-write[^\n]*no-claim[^\n]*MUST NOT[^\n]*(?:writer lease|write authority)/i,
  },
  {
    name: "dp-architect action point accepts either valid proposal or design under one lease",
    target: "architectAgent",
    rx: /dp-architect first-artifact action point[^\n]*`writer_lease:\s*single`[^\n]*exact[^\n]*proposal\.md[^\n]*design\.md[^\n]*internally valid[^\n]*either[^\n]*satisfies[^\n]*30m_total/i,
  },
  ...[
    ["entry fallback", "entry"],
    ["delegation-rules fallback", "delegationRules"],
    ["handoff fallback", "handoff"],
    ["platform-contract fallback", "platformContract"],
    ["Codex adapter fallback", "codexAdapter"],
    ["OpenSpec-flow fallback", "openspecFallback"],
  ].map(([name, target]) => ({
    name: `${name} excludes poll cadence and TL-caused interruption`,
    target,
    rx: /TL-selected wait\/poll timeout.*MUST NOT.*runtime terminal timeout.*TL-caused interruption.*MUST NOT.*call failure.*trigger fallback.*MUST.*recovery path.*`model-delegation-active-lifecycle\.md`/,
  })),
  {
    name: "capability spec does not overclaim enforcement",
    target: "capabilitySpec",
    rx: /This requirement is `\[cooperative-only, weak enforcement\]`.*cross-runtime hooks.*do not expose.*TL-side interrupt-decision event.*Grep\/mutation tests.*MUST NOT.*runtime behavioral enforcement/,
  },
  {
    name: "capability spec preserves dispatch-time provenance and single-writer ownership",
    target: "capabilitySpec",
    rx: /original artifact-producing briefing MUST contain.*claimed_artifact_paths.*first_artifact_deadline.*before dispatch.*post-dispatch message MUST NOT retroactively cure.*overlapping claimed paths MUST have at most one active write owner/,
  },
  {
    name: "proposal change summary preserves verified-stall boundary",
    target: "proposal",
    rx: /No-file and poll timeout cannot prove stall.*task-stall or heartbeat boundary.*user.*briefing.*runtime contract.*no runtime `running` evidence/,
  },
  {
    name: "proposal target state preserves complete verified-stall evidence",
    target: "proposal",
    rx: /verified stall requires.*task-stall or heartbeat observation window.*user.*briefing.*runtime contract.*no response\/activity.*no runtime `running` evidence/,
  },
  {
    name: "proposal parity rationale matches adapter synchronization",
    target: "proposal",
    rx: /Cross-runtime parity \| N\/A: Codex adapter only synchronizes the shared fallback contract; no Codex-exclusive or CLI behavior change\./,
  },
];

test("delegation interruption lifecycle exposes every operative anchor", () => {
  const missing = OPERATIVE_ANCHORS.filter(({ target, rx }) => !rx.test(targets[target])).map(
    ({ name }) => name,
  );
  assert.deepEqual(missing, [], `missing operative anchors: ${missing.join(", ")}`);
});

test("operative-anchor registry is unique and deleting its line turns the guard red", () => {
  for (const { name, target, rx } of OPERATIVE_ANCHORS) {
    const lines = targets[target].split("\n");
    const hitIndexes = lines.flatMap((line, index) => (rx.test(line) ? [index] : []));
    assert.equal(hitIndexes.length, 1, `anchor "${name}" matched ${hitIndexes.length} lines; expected 1`);

    const mutant = lines.filter((_, index) => index !== hitIndexes[0]).join("\n");
    assert.ok(!rx.test(mutant), `anchor "${name}" stayed GREEN after deleting its operative line`);
  }
});
