import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSyncBounded } from "./reviewer-process-guard.mjs";
import { OpenCodeReviewerError, parseOpenCodeModelSelector } from "./opencode-reviewer.mjs";

const SCHEMA = "devpro-opencode-model-probe/v1";
export const OPENCODE_REVIEWER_EFFORT = "max";
export const OPENCODE_REVIEWER_EFFORT_ENV = "DEVPRO_SECOND_REVIEWER_EFFORT_OPENCODE";
const EFFORTS = ["low", "high", "xhigh", "max"];

function fail(message, classification = "opencode_reviewer_model_probe_unavailable") {
  throw new OpenCodeReviewerError(message, classification);
}

// DeepSeek's documented generation transition: V4.1 Flash exceeds V4 Pro.
// Within a generation Pro is the capability tier above Flash. Price, release date,
// picker order and the configured default never participate in this comparison.
// https://api-docs.deepseek.com/news/news260910/
function rank(candidate) {
  const parsed = parseOpenCodeModelSelector(candidate?.selector);
  if (parsed.providerID !== "deepseek") fail("unverified reviewer provider");
  const match = /^DeepSeek V(\d+)(?:\.(\d+))? (Pro|Flash)(?: (\d{4}))?$/.exec(candidate.name);
  if (!match) fail("unranked DeepSeek capability; update the documented ranking policy");
  const numbers = [match[1], match[2] ?? "0", match[4] ?? "0"].map(Number);
  if (!numbers.every(Number.isSafeInteger) || !Array.isArray(candidate.efforts)
    || candidate.efforts.some(e => !EFFORTS.includes(e))
    || new Set(candidate.efforts).size !== candidate.efforts.length) fail("malformed model capability evidence");
  return [numbers[0], numbers[1], match[3] === "Pro" ? 1 : 0, numbers[2]];
}

function compare(a, b) {
  const ar = rank(a), br = rank(b);
  for (let i = 0; i < ar.length; i++) if (ar[i] !== br[i]) return br[i] - ar[i];
  return 0;
}

function choose(candidates, { requested, effort }) {
  if (effort !== "max") fail("DeepSeek reviewer effort is fixed to native max", "opencode_reviewer_effort_unsupported");
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > 1000) fail("empty or oversized model catalog");
  const seen = new Set();
  for (const candidate of candidates) {
    rank(candidate);
    if (seen.has(candidate.selector)) fail("duplicate model catalog identity");
    seen.add(candidate.selector);
  }
  const ordered = [...candidates].sort(compare);
  let selected;
  if (requested !== undefined) {
    parseOpenCodeModelSelector(requested);
    selected = ordered.find(c => c.selector === requested);
    if (!selected) fail("explicit reviewer model is unavailable in the current catalog");
  } else {
    if (ordered[1] && compare(ordered[0], ordered[1]) === 0) fail("ambiguous highest capability model");
    selected = ordered[0];
  }
  if (!selected.efforts.includes(effort)) fail(`the ${requested === undefined ? "highest" : "explicit"} model does not support exact ${effort}; no effort remapping or lower-model fallback`, "opencode_reviewer_effort_unsupported");
  return {
    schema: SCHEMA,
    family: "opencode",
    policy: requested === undefined ? "deepseek-generation-capability" : "opencode-explicit-model",
    selected_model: selected.selector,
    selected_effort: effort,
    candidates: ordered,
  };
}

export function selectOpenCodeReviewerModel(rows, { requested, effort = OPENCODE_REVIEWER_EFFORT } = {}) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 1000) fail("empty or oversized model catalog");
  const candidates = rows.filter(row => row?.providerID === "deepseek" && row.enabled === true).map(row => {
    if (typeof row.id !== "string" || row.modelID !== row.id || row.status !== "active" || row.capabilities?.tools !== true
      || !Array.isArray(row.capabilities?.input) || !row.capabilities.input.includes("text")
      || !Array.isArray(row.capabilities?.output) || !row.capabilities.output.includes("text")
      || !Array.isArray(row.variants)) fail("malformed or remapped DeepSeek model capabilities");
    return {
      selector: `deepseek/${row.id}`,
      name: row.name,
      efforts: row.variants.filter(v => v && EFFORTS.includes(v.id) && v.settings?.reasoningEffort === v.id
        && v.body?.thinking?.type !== "disabled").map(v => v.id).sort(),
    };
  });
  return choose(candidates, { requested, effort });
}

export function assertOpenCodeModelProbe(probe, requested) {
  if (!probe || probe.schema !== SCHEMA || probe.family !== "opencode"
    || !["deepseek-generation-capability", "opencode-explicit-model"].includes(probe.policy)
    || probe.selected_effort !== "max") fail("missing or invalid model probe evidence");
  const replay = choose(probe.candidates, {
    requested: probe.policy === "opencode-explicit-model" ? requested : undefined,
    effort: probe.selected_effort,
  });
  if (requested !== replay.selected_model || JSON.stringify(probe) !== JSON.stringify(replay)) fail("model probe evidence does not replay to the selected model and effort");
  return probe;
}

// Inventory only: no prompt/reviewer session, raw settings or credentials persisted.
export function probeOpenCodeReviewerModel({ env = process.env, requested, effort = env[OPENCODE_REVIEWER_EFFORT_ENV] ?? OPENCODE_REVIEWER_EFFORT, spawn = spawnSyncBounded } = {}) {
  if (spawn !== spawnSyncBounded && env.NODE_ENV !== "test" && env.DEVPRO_ALLOW_MODEL_PROBE_STUB !== "1") fail("model probe injection is test-only");
  if (requested !== undefined) parseOpenCodeModelSelector(requested);
  if (effort !== "max") fail("DeepSeek reviewer effort is fixed to native max", "opencode_reviewer_effort_unsupported");
  const cwd = mkdtempSync(path.join(tmpdir(), "devpro-opencode-model-catalog-"));
  try {
    const result = spawn("opencode", ["api", "model.list", "--standalone"], {
      cwd, env, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") fail("OpenCode model catalog probe failed; no fallback");
    let data;
    try { data = JSON.parse(result.stdout).data; } catch { fail("malformed OpenCode model catalog response"); }
    return selectOpenCodeReviewerModel(data, { requested, effort });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
