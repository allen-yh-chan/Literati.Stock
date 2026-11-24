import { consumeSpawnContextOverride } from "./spawn-context-override.mjs";
import {
  ADMISSION_ROLES,
  CODEX_REVIEWER_INTENT_ENTRY_MAX,
  CODEX_REVIEWER_WORKTREE_LIST_MAX,
  admitPreparedCodexReviewer,
  admissionHandoff,
  classifyAdmissionRoleClass,
  formatAdmissionFieldProblems,
  parseAdmissionFields,
  writeAdmissionRecord,
} from "./admission-record.mjs";

const CODEX_V2_SPAWN_TOOL = "collaborationspawn_agent";
// 2026-09-03 live fixture (codex-cli 0.152.1, tests/fixtures/spawn-context-payloads/
// codex-v2-opaque-message.json): the PreToolUse payload for collaborationspawn_agent
// carries agent_type / fork_turns / message / task_name, and `message` reaches the
// hook as an opaque Fernet-shaped token — the plaintext exists only inside the
// runtime. Such a carrier is unreadable, not "text with missing fields".
const CODEX_OPAQUE_MESSAGE_TOKEN = /^gAAAAA[A-Za-z0-9_-]{40,}={0,2}$/u;
export const CODEX_MESSAGE_OPAQUE_GAP = "codex-message-opaque";
export const CODEX_REGISTERED_ROLE_NO_RECORD_GAP = "codex-registered-role-no-record";
// A bound worktree that governs no change folder is the expected shape of a
// change-less change (chore-A, or a lite bugfix/hotfix that creates no change
// folder), not a governance gap: the record is absent by design, the dispatch
// passes, and nothing about the absent record weakens the findings it emits.
export const ADMISSION_CHANGE_DIR_ABSENT_ADVISORY = "Spawn Context Admission Gate: this worktree governs no openspec change folder (admission-records-dir-missing); this is the expected shape for a change-less change (chore-A or a lite bugfix/hotfix with no change folder) — the admission record is not written by design, the dispatch passes, its findings keep full review validity, and the gap surfaces only in lineage telemetry";
// design D5: an unresolved binding for every non-review role is the non-silent
// `binding-unresolved` advisory — no mint, no independence evidence, no block.
export const ADMISSION_BINDING_UNRESOLVED_ADVISORY = "Spawn Context Admission Gate: no change binding could be resolved for this dispatch (reason binding-unresolved); admission record not written — the lineage gap admission-records-unavailable applies, the dispatch passes as ordinary/advisory and MUST NOT be used as independence evidence";
const CODEX_V1_SPAWN_TOOLS = new Set(["spawn_agent", "Agent"]);
const CLAUDE_AGENT_TOOLS = new Set(["Agent", "Task"]);
// D34 continuation carriers. Claude: `SendMessage` (payload `to` / `message`;
// the `Agent` tool has no `resume` parameter). Codex: `followup_task` — the
// function name in the T27 live rollout fixture
// (tests/fixtures/session-usage-lineage/codex-continuation-followup-task.json);
// the `collaboration`-prefixed spelling applies the same dot-stripping the
// hook-visible `collaborationspawn_agent` token demonstrates for the
// model-visible `collaboration.spawn_agent`. No PreToolUse payload fixture
// exists for either Codex spelling, so that branch stays [cooperative-only].
export const CLAUDE_CONTINUATION_TOOLS = new Set(["SendMessage"]);
export const CODEX_CONTINUATION_TOOLS = new Set(["followup_task", "collaborationfollowup_task"]);

export const REGISTERED_AGENT_TOOLS = new Set([
  CODEX_V2_SPAWN_TOOL,
  ...CODEX_V1_SPAWN_TOOLS,
  ...CLAUDE_AGENT_TOOLS,
  ...CLAUDE_CONTINUATION_TOOLS,
  ...CODEX_CONTINUATION_TOOLS,
]);

export const SPAWN_CONTEXT_PASS_THROUGH = Symbol("spawn-context-pass-through");

// Both budget diagnostics are one line, name the exceeded budget and its limit, and point at the user-consented
// remediation; the limits come from the exported constants so no other file hard-codes 128 or 8192.
function preparedBudgetReason(reason) {
  if (reason === "intent-candidate-limit-exceeded") {
    return `intent-candidate-limit-exceeded: the same-common-dir worktree count (main checkout included) is above the enumeration budget of ${CODEX_REVIEWER_WORKTREE_LIST_MAX}; with the user's consent remove merged worktrees per git-branch-hygiene.md Local Worktree Hygiene, then reissue the reviewer intent`;
  }
  if (reason === "intent-entry-budget-exhausted") {
    return `intent-entry-budget-exhausted: the prepared-intent directories list more than ${CODEX_REVIEWER_INTENT_ENTRY_MAX} entries (about ${CODEX_REVIEWER_INTENT_ENTRY_MAX / 2} used or expired reviewer intents; a claimed intent counts twice); used intents accumulate until their worktree is removed — with the user's consent remove merged worktrees per git-branch-hygiene.md Local Worktree Hygiene, then reissue the reviewer intent`;
  }
  return null;
}

export function spawnContextBlock(reason, { bindingRoot } = {}) {
  const projectedReason = reason === "reviewer-change-worktree-required"
    ? "reviewer-change-worktree-required: ensure this session shares the Git common-dir with the prepared `.worktree/<change_id>` (or start a fresh Codex session rooted there), then reissue the reviewer intent"
    : preparedBudgetReason(reason) ?? reason;
  // design D3.3／D8.5: the resolved absolute binding root is operator-visible
  // (TL/model-visible) in a blocking message so a corrected dispatch can be
  // reissued, and it stays a single bounded line — never the record, telemetry,
  // or receipt payload.
  const bindingNote = typeof bindingRoot === "string" && bindingRoot.length > 0
    ? ` (resolved binding root: ${bindingRoot})`
    : "";
  return { block: true, reason: `Spawn Context Admission Gate: ${projectedReason}${bindingNote}` };
}

function consumeFullContextAuthority({ cwd, stateDir, nowMs }) {
  const consumed = consumeSpawnContextOverride({
    cwd,
    ...(stateDir ? { stateDir } : {}),
    ...(Number.isFinite(nowMs) ? { nowMs } : {}),
  });
  if (consumed.ok) return null;
  return spawnContextBlock(
    `full-context spawn requires a valid cwd-keyed one-shot override (${consumed.status}). ` +
    "Run `node .devpro/scripts/spawn-context-override.mjs --reason \"<why full history is necessary>\"`, then retry once."
  );
}

function evaluateCodexSpawnContext(toolName, toolInput, context) {
  if (CODEX_CONTINUATION_TOOLS.has(toolName)) return admitContinuationRecord(toolInput, context, "codex");
  const mode = evaluateCodexSpawnMode(toolName, toolInput, context);
  if (mode !== null) return mode;
  const agentType = typeof toolInput.agent_type === "string" ? toolInput.agent_type : null;
  if (agentType === "dp-reviewer") {
    const admitted = admitPreparedCodexReviewer({ cwd: context.cwd, toolInput });
    return admitted.ok
      ? { advisory: admissionHandoff(admitted) }
      : spawnContextBlock(admitted.code);
  }
  if (agentType !== null
    && !ADMISSION_ROLES.includes(agentType)
    && asciiCaseFold(agentType).includes("review")) {
    return spawnContextBlock("reviewer-agent-type-unsupported");
  }
  return admitCodexRecord(toolInput, context, codexHostContextMode(toolName, toolInput));
}

function asciiCaseFold(value) {
  return value.replace(/[A-Z]/gu, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}

// C-02: the host payload states how much parent context the child inherits, and
// `evaluateCodexSpawnMode` above has already proven the field is well shaped by
// the time this runs. Reading it a second time — instead of discarding it — is
// what lets the declared `instance_mode` be checked against observed reality.
// The mapping is the one `session-usage-lineage.mjs` already applies to the same
// field: `none` is a fresh root, `all` and any of `1..6` carry parent context, and
// an omitted v2 `fork_turns` took the full-context branch above, so it is fork too.
function codexHostContextMode(toolName, toolInput) {
  if (toolName === CODEX_V2_SPAWN_TOOL) {
    return toolInput.fork_turns === "none" ? "fresh" : "fork";
  }
  return toolInput.fork_context === true ? "fork" : "fresh";
}

// D6 (2.1a) Codex branch is [cooperative-only]: the host payload carries no
// agent-name field, so the six fields can only come from the message text.
// When the host hands the hook no text at all, the record cannot be written;
// the spawn passes without a record (the gap surfaces in telemetry as
// admission-records-unavailable / codex-role-carrier-unverified) instead of
// blocking every Codex spawn on an unverified payload shape; when text is
// present the six fields are enforced.
// F-r10-codex-advisory-echoes-unvalidated-agent-type: this advisory is the one
// place in this module that echoes a host-supplied value which is NOT a closed-set
// or registered token — a Codex custom agent name (live fixture: `dp-probe-preload`)
// is legitimately outside ADMISSION_ROLES, so reducing it to an enum would destroy
// the diagnostic. It is instead bounded: control characters collapse to spaces so
// the advisory stays one line, and the echo is capped, keeping the change's own
// external-disclosure risk class (no unbounded payload in block/telemetry text).
const CODEX_AGENT_TYPE_ECHO_MAX = 64;

function boundedAgentTypeEcho(agentType) {
  if (agentType === null) return "unknown";
  // Single-line telemetry: C0 + DEL + Unicode NEL/LS/PS (D1). Not the rest of C1/bidi/ZW*.
  const oneLine = agentType.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/gu, " ");
  if (oneLine.length <= CODEX_AGENT_TYPE_ECHO_MAX) return oneLine;
  let end = CODEX_AGENT_TYPE_ECHO_MAX;
  // Avoid splitting a surrogate pair at the UTF-16 unit cap (D3).
  const prev = oneLine.charCodeAt(end - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) end -= 1;
  return `${oneLine.slice(0, end)}…(truncated)`;
}

function admitCodexRecord(toolInput, context, hostContextMode) {
  const text = typeof toolInput.message === "string" ? toolInput.message : (typeof toolInput.prompt === "string" ? toolInput.prompt : null);
  const agentType = typeof toolInput.agent_type === "string" ? toolInput.agent_type : null;
  const isRegisteredRole = agentType !== null && ADMISSION_ROLES.includes(agentType);
  if (text === null) {
    // D4.1: registered generic roles must not silently pass without a record.
    // D4.2 opaque/no-text null applies only to non-named / non-prepared inputs.
    if (isRegisteredRole) {
      return {
        advisory: `Spawn Context Admission Gate: registered Codex agent_type=${boundedAgentTypeEcho(agentType)} requires a readable six-field message (${CODEX_REGISTERED_ROLE_NO_RECORD_GAP}); admission record not written`,
      };
    }
    return null; // no text carrier → no record; telemetry names admission-records-unavailable / codex-role-carrier-unverified
  }
  if (CODEX_OPAQUE_MESSAGE_TOKEN.test(text)) {
    // Opaque carrier: the six fields cannot be read, so no record is written and the
    // spawn is not blocked (D6 2.1a: the Codex branch never blocks on an unreadable
    // payload shape). Role binding stays cooperative-only; the gap surfaces in
    // telemetry as admission-records-unavailable / codex-role-carrier-unverified.
    // Registered roles still get a named advisory (D4.1), never a bare null.
    return { advisory: `Spawn Context Admission Gate: Codex delivered an opaque message carrier (${CODEX_MESSAGE_OPAQUE_GAP}; agent_type=${boundedAgentTypeEcho(agentType)}); admission record not written, role binding stays cooperative-only` };
  }
  const parsed = parseAdmissionFields(text);
  const problem = admissionProblem(parsed);
  if (problem) return spawnContextBlock(problem);
  // C-02: a record may declare more parent context than the host observed, never
  // less. Declaring `fresh` while the host handed the child parent turns would
  // record an independent root that is not one, and the receipt gate's
  // `assertAdmissionChainRootsToFresh` would then admit it as independent
  // evidence — the exact rejection Done When 6 relies on.
  if (hostContextMode === "fork" && parsed.fields.instance_mode === "fresh") {
    return spawnContextBlock("instance_mode: fresh contradicts the host payload: fork_turns/fork_context show this child inherits parent context, so the record must declare instance_mode: fork with a fork_reason");
  }
  // Host-carried agent_type (same live fixture): when it names a closed-set role the
  // declared role MUST match it and the binding becomes host-verified; a custom
  // agent name outside the closed set keeps the cooperative-only declaration.
  let roleBinding = "cooperative-only";
  if (agentType !== null && ADMISSION_ROLES.includes(agentType)) {
    if (parsed.fields.role !== agentType) return spawnContextBlock(`role ${parsed.fields.role} does not match the Codex agent_type ${agentType}`);
    roleBinding = "host-verified";
  }
  const written = writeAdmissionRecord({ cwd: context.cwd, host: "codex", prompt: text, fields: parsed.fields, roleBinding });
  return admissionOutcome(written, parsed.fields);
}

// D34: a continuation carrier continues an existing responsibility thread
// instead of opening one. Neither runtime's payload carries a role field — the
// Claude target `to` is a runtime-assigned agent id the hook cannot know at
// spawn time, and the Codex continuation payload carries only `message` and
// `target` — so role binding stays cooperative-only and the receipt gate
// verifies the `parent_record_id` chain back to the thread's fresh root instead.
//
// The declaration is opt-in by carrier, because these tools also carry ordinary
// messages: text without an `instance_mode:` line is not a governed
// continuation and passes without a record (the gap surfaces in telemetry, and
// an undeclared continuation still cannot seal a receipt). Once declared, the
// six fields plus `parent_record_id` are enforced exactly.
function admitContinuationRecord(toolInput, context, host) {
  const text = typeof toolInput.message === "string" ? toolInput.message : null;
  if (text === null) return null; // no text carrier → no record; telemetry names admission-records-unavailable
  if (CODEX_OPAQUE_MESSAGE_TOKEN.test(text)) {
    return { advisory: `Spawn Context Admission Gate: continuation carrier is opaque (${CODEX_MESSAGE_OPAQUE_GAP}); admission record not written, role binding stays cooperative-only` };
  }
  const parsed = parseAdmissionFields(text);
  if (parsed.fields.instance_mode === undefined) return null; // ordinary message, not a governed continuation
  // Round-3 review F-r3-continuation-declaration-false-positive: the trigger is a
  // line match anywhere in the bounded prefix, so a message that quotes a whole
  // fresh dispatch block, or that merely discusses the contract, would be blocked
  // as a malformed continuation. Neither carrier can actually start a fresh or
  // forked thread, so a non-`continue` mode is discussion, not a governed handoff,
  // and a single stray key is not a declaration. Both pass ungoverned; a real
  // continuation that skips the record still cannot seal a receipt.
  if (parsed.fields.instance_mode !== "continue") return null;
  if (Object.keys(parsed.fields).length < 2) return null;
  const problem = admissionProblem(parsed);
  if (problem) return spawnContextBlock(problem);
  const written = writeAdmissionRecord({ cwd: context.cwd, host, prompt: text, fields: parsed.fields, roleBinding: "cooperative-only" });
  return admissionOutcome(written, parsed.fields);
}

function evaluateCodexSpawnMode(toolName, toolInput, context) {
  const hasV2 = Object.prototype.hasOwnProperty.call(toolInput, "fork_turns");
  const hasV1 = Object.prototype.hasOwnProperty.call(toolInput, "fork_context");
  if (hasV1 && hasV2) return spawnContextBlock("ambiguous payload contains both fork_turns and fork_context");
  if (toolName === CODEX_V2_SPAWN_TOOL) {
    if (hasV1) return spawnContextBlock("Codex v2 tool received the v1 fork_context field");
    if (!hasV2 || toolInput.fork_turns === "all") return consumeFullContextAuthority(context);
    if (toolInput.fork_turns === "none") return null;
    if (typeof toolInput.fork_turns === "string" && /^[1-6]$/.test(toolInput.fork_turns)) return null;
    return spawnContextBlock("Codex v2 fork_turns must be `none` or a string integer from `1` through `6`; schema drift must be captured as a redacted fixture");
  }
  if (CODEX_V1_SPAWN_TOOLS.has(toolName)) {
    if (hasV2) return spawnContextBlock("Codex v1 tool received the v2 fork_turns field");
    if (!hasV1 || toolInput.fork_context === false) return null;
    if (toolInput.fork_context === true) return consumeFullContextAuthority(context);
    return spawnContextBlock("Codex v1 fork_context must be boolean when present");
  }
  return spawnContextBlock(`unsupported Codex agent tool token ${toolName}`);
}

function admissionProblem(parsed) {
  return formatAdmissionFieldProblems(parsed);
}

// D51: the three dispatch carriers share one outcome mapping. A change folder
// that is absent from both the active and the archive location is not a faulty
// one: a chore-A worktree governs no OpenSpec change at all, yet still has to
// dispatch dp-assistant, so it passes without a record and the gap surfaces in
// lineage telemetry as `admission-records-unavailable`. Every other write
// failure — including a folder that exists but is not a plain directory —
// keeps failing closed.
//
// The D51 pass is now reachable only after a binding was established (design
// D3.1): an unresolved binding is never the absent-folder shape. When no source
// resolved at all (`noDeclaration`), the declared role classifies the outcome
// (design D5): review／verify fail closed, every other registered role takes the
// non-silent `binding-unresolved` advisory without minting, and a declared
// continuation blocks for every role because it MUST attach to its parent
// record.
function admissionOutcome(written, fields = {}) {
  if (written.ok) {
    const advisories = Array.isArray(written.advisories) ? written.advisories : [];
    const suffix = advisories.length > 0 ? `; advisory: ${advisories.join(", ")}` : "";
    // The declared-path admission handoff (model-visible) also names the
    // resolved absolute binding root as one bounded note, so a corrected or
    // child-side dispatch can reach the exact worktree the record landed in.
    // The cwd fast path is exempt — there the environment itself proves the
    // root — and the note stays on the TL／model-visible surface only: the
    // record, telemetry, and receipt payloads never carry the absolute path
    // (T-3-6).
    const bindingNote = written.bindingPath === "declared" && typeof written.bindingRoot === "string" && written.bindingRoot.length > 0
      ? ` (resolved binding root: ${written.bindingRoot})`
      : "";
    return { advisory: `${admissionHandoff(written)}${bindingNote}${suffix}` };
  }
  if (written.code === "change-dir-absent") return { advisory: ADMISSION_CHANGE_DIR_ABSENT_ADVISORY };
  if (written.code === "change-worktree-required" && written.noDeclaration === true) {
    if (fields.instance_mode === "continue") {
      return spawnContextBlock(admissionWriteFailure("change-worktree-required"));
    }
    if (classifyAdmissionRoleClass(fields.role) === "review") {
      return spawnContextBlock(`${admissionWriteFailure("change-worktree-required")}${CHANGELESS_REVIEW_ROUTE_NOTE}`);
    }
    return { advisory: ADMISSION_BINDING_UNRESOLVED_ADVISORY };
  }
  return spawnContextBlock(admissionWriteFailure(written.code), { bindingRoot: written.bindingRoot });
}

// A review role with no declaration at all may be a change-less audit-only
// review (a direction or design check before any change exists). That shape
// is carried by the runner path, not by a subagent dispatch (design D5.3), so
// the block names it instead of leaving a throwaway worktree as the only
// visible way through.
const CHANGELESS_REVIEW_ROUTE_NOTE = "; if no change exists yet (a change-less audit-only review), do not create a worktree only to satisfy this gate — the TL runs the renderer-owned second-review runner directly instead of dispatching a subagent";

function admissionWriteFailure(code) {
  if (code === "change-worktree-required") return "admission record requires a resolved change binding (change-worktree-required): run the dispatch from the change worktree `.worktree/<change_id>`, or declare `change_id: <id>` (with `execution_root` from the read-only binding pre-resolution helper) and retry — a declared id that resolves no live same-common-dir worktree, and a `.worktree/<id>` cwd that is not a live linked worktree, fail closed here. The lookup covers only the session's own repository (same Git common-dir), so a change worktree of another repository is never bound: open a session in that repository and delegate from there (model-delegation.md)";
  if (code === "change-worktree-ambiguous") return "admission record change-worktree binding is ambiguous (change-worktree-ambiguous): more than one same-common-dir `.worktree/<change_id>` candidate matched the change_id lookup key (declared or scope-declared); refuse to mint exact-one";
  if (code === "admission-binding-inconsistent") return "admission record declaration sources disagree (admission-binding-inconsistent): the authoritative `change_id` field and the trusted `responsibility_id` change prefix derive different change ids — only read sources are compared, so align them (or drop one) and retry";
  if (code === "change-binding-mismatch") return "admission record cwd and declaration disagree (change-binding-mismatch): the spawn cwd resolves one `.worktree/<change_id>` while the declaration resolves another; neither side wins — run from the declared change worktree or correct the declaration, then retry";
  if (code === "change-id-invalid") return "admission record change_id is outside the change_id grammar ^[a-z0-9][a-z0-9-]{0,99}$ (change-id-invalid); fix the declared `change_id` and retry";
  if (code === "execution-root-required") return "a declared-path dispatch MUST carry `execution_root: <absolute binding worktree path>` (execution-root-required) for every role — run `node .devpro/scripts/resolve-admission-binding.mjs <change_id> --json` and add the returned `execution_root` (its `repoRoot`) to the brief, then retry; the cwd fast path (a real `.worktree/<change_id>` session cwd) is the only exemption";
  if (code === "execution-root-mismatch") return "the declared `execution_root` does not realpath-equal the resolved binding root (execution-root-mismatch): a relative path, a nonexistent path, or another worktree cannot substitute — re-run `node .devpro/scripts/resolve-admission-binding.mjs <change_id> --json` and use its exact `execution_root`, then retry";
  if (code === "change-id-mismatch") return "admission record changeId mismatch (change-id-mismatch): trusted responsibility_id changeId disagrees with evidence_scope／return_and_stop declared `.worktree/<id>`／`openspec/changes/<id>` segment(s); refuse to mint — scope segments are corroboration only";
  if (code === "intent-scan-failed") return "admission record worktree discovery failed closed (intent-scan-failed): porcelain -z incomplete, foreign common-dir, or scan fault — no partial exact-one";
  if (code === "intent-candidate-limit-exceeded") return `admission record worktree discovery exceeded the worktree enumeration budget (intent-candidate-limit-exceeded): the same-common-dir worktree count (main checkout included) is above ${CODEX_REVIEWER_WORKTREE_LIST_MAX} — with the user's consent remove merged worktrees per git-branch-hygiene.md Local Worktree Hygiene and retry; no partial exact-one`;
  if (code === "git-head-unavailable") return "admission record requires a resolvable 40-hex git HEAD on the binding worktree (git-head-unavailable); repair the worktree and retry";
  if (code === "binding-head-detached") return "admission record binding worktree is on a detached HEAD (binding-head-detached): check out the change branch `<prefix>/<change_id>` there and retry";
  if (code === "binding-branch-protected") return "admission record binding worktree is on a protected base branch (binding-branch-protected): a change binding MUST NOT sit on a protected base branch — check out the change branch there and retry";
  if (code === "admission-record-unsafe-value") return "admission record free-text fields (evidence_scope / return_and_stop / fork_reason) must not carry a user-home absolute path or a non-allowlisted email (admission-record-unsafe-value); the record is readable by anyone with the worktree and is quoted into PR bodies and receipts, so rewrite them repo-relative and redacted";
  if (code === "admission-records-dir-invalid") return "admission record directory is invalid (admission-records-dir-invalid): the change directory must already exist as a plain directory, either active at openspec/changes/<change_id> or archived at openspec/changes/archive/<date>-<change_id>, and admission-records/ must not be a symlink; the same code is also returned when that directory cannot be stat'ed or created (for example EACCES, ENOTDIR, a read-only filesystem), so also check permissions and the path type on the change directory";
  return `admission record could not be written durably (${code}); admission fails closed`;
}

// D2 / D3 Option A / D6 (2.1a): the fork carrier is `subagent_type: "fork"`
// (needs `fork_reason:` + six fields with instance_mode fork; role is a
// cooperative declaration because fork has no named projection). Named dp-*
// projections need the six fields and role === subagent_type (host-verified).
// Built-in types (Explore, general-purpose, Plan, …) are admitted without a
// record; `resume` is not a spawn mode any more (SendMessage continues a
// thread and is admitted by admitContinuationRecord) and
// CLAUDE_CODE_FORK_SUBAGENT is evidence only, never a branch.
//
// The declared-path resolution is the one shared `resolveAdmissionBinding`
// inside `writeAdmissionRecord` (design D9.4 守則 1): every host — Cursor
// included — passes the session cwd and the parsed fields, so the Cursor
// degraded wrapper is gone and the four hosts share one resolver and one code
// group. Cursor `working_directory` stays execution-only and NEVER feeds this
// binding (`toolInputBindingCwd` omits it).
function evaluateClaudeSpawnContext(toolName, toolInput, context, hostName = "claude-code") {
  if (CLAUDE_CONTINUATION_TOOLS.has(toolName)) return admitContinuationRecord(toolInput, context, hostName);
  if (!CLAUDE_AGENT_TOOLS.has(toolName)) return spawnContextBlock(`unsupported Claude agent tool token ${toolName}`);
  if (typeof toolInput.subagent_type !== "string" || !toolInput.subagent_type.trim()) return spawnContextBlock("Claude Agent payload requires subagent_type");
  const subagentType = toolInput.subagent_type.trim();
  const isFork = subagentType === "fork";
  const isNamedProjection = ADMISSION_ROLES.includes(subagentType);
  if (!isFork && !isNamedProjection) return null;
  const parsed = parseAdmissionFields(toolInput.prompt);
  const problem = admissionProblem(parsed);
  if (problem) return spawnContextBlock(problem);
  // Oversized `fork_reason` is already diagnosed above as oversize. Only a
  // truly absent (or empty) reason uses the non-empty fork_reason block.
  if (isFork && !parsed.fields.fork_reason) {
    return spawnContextBlock("Claude fork (subagent_type fork) requires a non-empty `fork_reason:` line within the first 8 KiB / 100 lines of the prompt; the reason is auditable, not authorization");
  }
  if (isFork) {
    if (parsed.fields.instance_mode !== "fork") return spawnContextBlock("Claude fork admission requires instance_mode: fork in the admission record");
  } else {
    if (parsed.fields.role !== subagentType) {
      return spawnContextBlock(`admission record role must equal subagent_type for a named projection (role binding host-verified); got role ${parsed.fields.role} for subagent_type ${subagentType}`);
    }
    if (parsed.fields.instance_mode !== "fresh") {
      return spawnContextBlock("a named projection spawn is always instance_mode: fresh (fork uses subagent_type fork; continue uses a continuation carrier — SendMessage / followup_task — on the existing thread, which is admitted with instance_mode: continue plus parent_record_id)");
    }
  }
  const written = writeAdmissionRecord({
    cwd: context.cwd,
    host: hostName,
    prompt: toolInput.prompt,
    fields: parsed.fields,
    roleBinding: isFork ? "cooperative-only" : "host-verified",
  });
  return admissionOutcome(written, parsed.fields);
}

export function evaluateAgentDispatch(toolName, toolInput, { host, cwd, stateDir, nowMs }) {
  if (!REGISTERED_AGENT_TOOLS.has(toolName)) return SPAWN_CONTEXT_PASS_THROUGH;
  if (host === "codex") return evaluateCodexSpawnContext(toolName, toolInput, { cwd, stateDir, nowMs });
  if (host === "claude-code") return evaluateClaudeSpawnContext(toolName, toolInput, { cwd });
  // OpenCode plugin maps `task` → PreToolUse tool_name Task; reuse Claude named-projection admission with host=opencode.
  if (host === "opencode" && CLAUDE_AGENT_TOOLS.has(toolName)) {
    return evaluateClaudeSpawnContext(toolName, toolInput, { cwd }, "opencode");
  }
  // Cursor maps subagent dispatch to PreToolUse tool_name Task; reuse the Claude
  // named-projection admission with host=cursor so runtime-agent receipts can bind
  // a host-verified admission record. Continuation tools stay pass-through — Cursor
  // has no governed SendMessage/followup carrier (see spawn-context tests).
  if (host === "cursor" && CLAUDE_AGENT_TOOLS.has(toolName)) {
    return evaluateClaudeSpawnContext(toolName, toolInput, { cwd }, "cursor");
  }
  if (host === "cursor" && CLAUDE_CONTINUATION_TOOLS.has(toolName)) return SPAWN_CONTEXT_PASS_THROUGH;
  if (!host) return spawnContextBlock("runtime host marker is missing; payload fields are not accepted as host authority");
  return spawnContextBlock(`agent tool ${toolName} is not valid for runtime host ${host}`);
}
