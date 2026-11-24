// Explicit test-only model discovery boundary; never invoke host reviewer CLIs.
export const modelProbeEvidence = {
  claude: {schema: "devpro-highest-tier-reviewer-model/v1", family: "claude", policy: "claude-highest-family-alias", selected_model: "claude-fable-99-0", requested_kind: "exact-id", candidates: [{selector: "fable", model: "claude-fable-99-0", classification: "compatible"}]},
  codex: {schema: "devpro-highest-tier-reviewer-model/v1", family: "codex", policy: "codex-capability-tier", selected_model: "gpt-6-astra", requested_kind: "exact-id", candidates: [{model: "gpt-6-astra", tier: "astra", generation: [6,0], xhigh: true}]},
};
export const modelProbeTestEnv = (env = {}) => ({...env, DEVPRO_ALLOW_MODEL_PROBE_STUB: "1", DEVPRO_SECOND_REVIEW_MODEL_PROBE_STUB: JSON.stringify(modelProbeEvidence)});
Object.assign(process.env, modelProbeTestEnv(process.env));
