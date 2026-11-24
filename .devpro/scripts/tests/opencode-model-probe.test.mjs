import assert from "node:assert/strict";
import test from "node:test";
import { selectOpenCodeReviewerModel, assertOpenCodeModelProbe, probeOpenCodeReviewerModel } from "../lib/opencode-model-probe.mjs";

const row = (id, name, efforts = ["low", "high", "max"]) => ({
  id, modelID: id, providerID: "deepseek", name, enabled: true, status: "active",
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: efforts.map(id => ({ id, settings: { reasoningEffort: id } })),
});
const catalog = () => [row("deepseek-v4-pro", "DeepSeek V4 Pro"), row("deepseek-flash", "DeepSeek V4.1 Flash 1017")];

test("DeepSeek defaults to native max and rejects conflicting effort before any CLI probe", () => {
  assert.equal(selectOpenCodeReviewerModel(catalog()).selected_effort, "max");
  for (const effort of ["low", "high", "xhigh", "", null]) {
    let called = false;
    assert.throws(() => probeOpenCodeReviewerModel({ env: { NODE_ENV: "test" }, effort,
      spawn: () => { called = true; throw new Error("must not spawn"); },
    }), e => e.classification === "opencode_reviewer_effort_unsupported");
    assert.equal(called, false);
  }
});

test("discovers the highest DeepSeek generation, then capability tier, independent of catalog order", () => {
  for (const rows of [catalog(), catalog().reverse()]) {
    const result = selectOpenCodeReviewerModel(rows, { effort: "max" });
    assert.equal(result.selected_model, "deepseek/deepseek-flash");
    assert.equal(result.selected_effort, "max");
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(assertOpenCodeModelProbe(result, result.selected_model), result);
  }
  const result = selectOpenCodeReviewerModel([...catalog(), row("next-pro", "DeepSeek V4.1 Pro")], { effort: "max" });
  assert.equal(result.selected_model, "deepseek/next-pro");
});

test("does not use price, picker order, date or an unranked model to assert highest capability", () => {
  assert.throws(() => selectOpenCodeReviewerModel([...catalog(), row("next", "DeepSeek Experimental")], { effort: "max" }), /unranked/);
  assert.throws(() => selectOpenCodeReviewerModel([...catalog(), row("other", "DeepSeek V4.1 Flash 1017")], { effort: "max" }), /ambiguous/);
});

test("missing effort on the highest model fails instead of selecting a lower model or silently mapping xhigh", () => {
  assert.throws(() => selectOpenCodeReviewerModel(catalog(), { effort: "xhigh" }), e => e.classification === "opencode_reviewer_effort_unsupported");
  const rows = catalog(); rows[1].variants = [{ id: "high", settings: { reasoningEffort: "high" } }];
  assert.throws(() => selectOpenCodeReviewerModel(rows, { effort: "max" }), /highest.*max/);
  rows[1].variants = [{ id: "max", settings: { reasoningEffort: "high" } }];
  assert.throws(() => selectOpenCodeReviewerModel(rows, { effort: "max" }), /highest.*max/);
});

test("explicit model override is checked against the catalog and still requires the requested effort", () => {
  const result = selectOpenCodeReviewerModel(catalog(), { requested: "deepseek/deepseek-v4-pro", effort: "max" });
  assert.equal(result.selected_model, "deepseek/deepseek-v4-pro");
  assert.equal(result.policy, "opencode-explicit-model");
  assert.throws(() => selectOpenCodeReviewerModel(catalog(), { requested: "deepseek/missing", effort: "max" }), /unavailable/);
  assert.throws(() => selectOpenCodeReviewerModel(catalog(), { requested: "", effort: "max" }), /selector/);
});

test("sanitized evidence is replayed rather than trusting a claimed selected model or effort", () => {
  const proof = selectOpenCodeReviewerModel(catalog(), { effort: "max" });
  assert.throws(() => assertOpenCodeModelProbe({ ...proof, selected_model: "deepseek/deepseek-v4-pro" }, "deepseek/deepseek-v4-pro"), /evidence/);
  assert.throws(() => assertOpenCodeModelProbe({ ...proof, selected_effort: "high" }, proof.selected_model), /evidence/);
  assert.throws(() => assertOpenCodeModelProbe(undefined, proof.selected_model), /evidence/);
  assert.throws(() => selectOpenCodeReviewerModel([], { effort: "max" }), /empty/);
});

test("bounded catalog probe removes credential-bearing fields and never persists raw provider output", () => {
  let call;
  const proof = probeOpenCodeReviewerModel({ env: { NODE_ENV: "test" }, effort: "max", spawn: (exe, argv, options) => {
    call = { exe, argv, options };
    return { status: 0, stdout: JSON.stringify({ data: catalog().map(x => ({ ...x, settings: { apiKey: "DO_NOT_PERSIST" } })) }) };
  } });
  assert.equal(call.exe, "opencode");
  assert.deepEqual(call.argv, ["api", "model.list", "--standalone"]);
  assert.ok(call.options.timeout <= 30000);
  assert.ok(!JSON.stringify(proof).includes("DO_NOT_PERSIST"));
  assert.throws(() => probeOpenCodeReviewerModel({ env: {}, spawn: () => ({ status: 0 }) }), /test-only/);
  assert.throws(() => probeOpenCodeReviewerModel({ env: { NODE_ENV: "test" }, spawn: () => ({ status: 1, stderr: "DO_NOT_PERSIST" }) }), e => !e.message.includes("DO_NOT_PERSIST"));
});
