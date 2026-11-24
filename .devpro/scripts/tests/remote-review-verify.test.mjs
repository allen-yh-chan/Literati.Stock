import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { REMOTE_REVIEW_EXECUTOR, verifyRemoteResult } from "../lib/remote-review-client.mjs";

// Pure verification of a bridge `result` payload against the local record. `runGit` is a stub:
// no repository, no network, no ssh.
const REQUEST_ID = "rr-0123456789abcdef";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const ROOT = "c".repeat(40);
const REPO_ROOT = "/repo";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const IDENTITY = { cli: "opencode", version: "1.18.31", session_id: "ses_fake0001", provider_id: "deepseek", model_id: "deepseek-v4-pro" };

function record(mode = "ordinary-primary") {
  return {
    request_id: REQUEST_ID,
    repo_id: "demo-repo",
    role: mode === "ordinary-primary" ? "dp-reviewer" : "dp-second-reviewer",
    mode,
    target: { kind: "commits", base: BASE, head: HEAD },
    repo_binding: { root_commits: [ROOT] },
    local_head: HEAD,
  };
}

function assessmentSection(assessments, { target = HEAD, dispatch = REQUEST_ID } = {}) {
  return "## Guarantee Assessment\n```json\n"
    + JSON.stringify({ schema: "devpro.review-guarantee-assessment/v1", reviewed_target: target, dispatch_id: dispatch, assessments })
    + "\n```\n";
}

const withinCeiling = (id) => ({
  finding_id: id,
  guarantee_ceiling: "cooperative review; mechanical shape checks",
  classification: "within-ceiling",
  rationale: "bounded by the review ceiling",
});

function primaryReport({ verdict, findings = [], assessment }) {
  const lines = ["## 六軸審查", "", "### 軸 1: 正確性"];
  for (const { severity, id } of findings) {
    lines.push(`- **[${severity}]** \`[finding_id:${id}] [observation_hash_sha256:${"a".repeat(64)}]\` 發現說明`);
  }
  lines.push("", "## 總判定", `**${verdict}**`, "");
  if (assessment !== undefined) lines.push(assessment);
  return lines.join("\n");
}

function payloadFor(rec, reportText, { identity = IDENTITY, extraFiles = {}, mutateMeta, mutateFiles } = {}) {
  const report = Buffer.from(reportText, "utf8");
  const files = { "report.md": report, ...Object.fromEntries(Object.entries(extraFiles).map(([k, v]) => [k, Buffer.from(v)])) };
  const meta = {
    request_id: rec.request_id, repo_id: rec.repo_id, role: rec.role, mode: rec.mode, target: rec.target,
    reviewer: identity,
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { sha256: sha256(bytes), bytes: bytes.length }])),
  };
  mutateMeta?.(meta);
  const body = {
    request_id: rec.request_id,
    status: "succeeded",
    result: meta,
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { sha256: sha256(bytes), bytes: bytes.length, base64: bytes.toString("base64") }])),
  };
  mutateFiles?.(body.files);
  return body;
}

function cleanGit({ head = HEAD, dirty = "" } = {}) {
  return (args) => {
    if (args[0] === "rev-parse") return { status: 0, stdout: `${head}\n`, stderr: "" };
    if (args[0] === "status") return { status: 0, stdout: dirty, stderr: "" };
    return { status: 1, stdout: "", stderr: "" };
  };
}

function verify(rec, payload, runGit = cleanGit()) {
  return verifyRemoteResult({ payload, record: rec, repoRoot: REPO_ROOT, runGit });
}

test("ordinary-primary: finished, partial and blocked reports pass the existing readers and stay unsealed", () => {
  const rec = record();
  const finished = verify(rec, payloadFor(rec, primaryReport({ verdict: "finished", assessment: assessmentSection([]) })));
  assert.equal(finished.status, "finished");
  assert.equal(finished.classification, "remote_review_completed");
  assert.equal(finished.executor, REMOTE_REVIEW_EXECUTOR);
  assert.equal(finished.sealed_admission, false);
  assert.deepEqual(finished.reviewer, IDENTITY);
  assert.equal(finished.reviewed_target, HEAD);

  const partial = verify(rec, payloadFor(rec, primaryReport({
    verdict: "partial",
    findings: [{ severity: "Important", id: "F-1" }],
    assessment: assessmentSection([withinCeiling("F-1")]),
  })));
  assert.equal(partial.status, "partial");
  assert.deepEqual(partial.finding_ids, ["F-1"]);

  const blocked = verify(rec, payloadFor(rec, primaryReport({ verdict: "blocked", findings: [{ severity: "Critical", id: "F-9" }] })));
  assert.equal(blocked.status, "blocked", "a blocked review keeps its verdict even without a usable assessment");
  assert.equal(blocked.guarantee_assessment, null);
});

test("ordinary-primary: a verdict that contradicts its findings or a missing/foreign assessment is rejected", () => {
  const rec = record();
  const cases = [
    [primaryReport({ verdict: "finished", findings: [{ severity: "Critical", id: "F-1" }], assessment: assessmentSection([]) }), "remote_report_contract_invalid"],
    ["Looks good. PASS\n", "remote_report_contract_invalid"],
    [primaryReport({ verdict: "finished" }), "remote_assessment_invalid"],
    [primaryReport({ verdict: "finished", assessment: assessmentSection([], { target: "d".repeat(40) }) }), "remote_assessment_invalid"],
    [primaryReport({ verdict: "finished", assessment: assessmentSection([], { dispatch: "another-dispatch" }) }), "remote_assessment_invalid"],
  ];
  for (const [text, classification] of cases) {
    const out = verify(rec, payloadFor(rec, text));
    assert.equal(out.status, "failed");
    assert.equal(out.classification, classification, text.slice(0, 40));
    assert.equal(out.sealed_admission, false);
  }
});

test("audit-only: needs a Guarantee Assessment bound to this head and request; there is no verdict", () => {
  const rec = record("audit-only");
  const ok = verify(rec, payloadFor(rec, `## Findings\nnone\n\n${assessmentSection([])}`));
  assert.equal(ok.status, "completed");
  assert.equal(ok.classification, "remote_audit_completed");
  assert.equal(ok.verdict, null);
  assert.equal(ok.sealed_admission, false);
  assert.equal(verify(rec, payloadFor(rec, "## Findings\nnone\n")).classification, "remote_assessment_invalid");
  assert.equal(verify(rec, payloadFor(rec, assessmentSection([], { target: "e".repeat(40) }))).classification, "remote_assessment_invalid");
});

test("a result that does not match the submitted request or the OpenCode-only route is invalid", () => {
  const rec = record();
  const good = primaryReport({ verdict: "finished", assessment: assessmentSection([]) });
  const mismatches = {
    "other request id": (meta) => { meta.request_id = "rr-ffffffffffffffff"; },
    "other head": (meta) => { meta.target = { ...meta.target, head: "f".repeat(40) }; },
    "other role": (meta) => { meta.role = "dp-second-reviewer"; },
    "other mode": (meta) => { meta.mode = "audit-only"; },
    "other repo": (meta) => { meta.repo_id = "another-repo"; },
    "claude reviewer": (meta) => { meta.reviewer = { ...IDENTITY, cli: "claude" }; },
    "missing session": (meta) => { meta.reviewer = { ...IDENTITY, session_id: "" }; },
  };
  for (const [label, mutateMeta] of Object.entries(mismatches)) {
    const out = verify(rec, payloadFor(rec, good, { mutateMeta }));
    assert.equal(out.classification, "remote_result_invalid", label);
  }
  const wrongTop = payloadFor(rec, good);
  wrongTop.request_id = "rr-ffffffffffffffff";
  assert.equal(verify(rec, wrongTop).classification, "remote_result_invalid");
  const notSucceeded = payloadFor(rec, good);
  notSucceeded.status = "failed";
  assert.equal(verify(rec, notSucceeded).classification, "remote_result_invalid");
});

test("returned bytes must match their digests, and listed files must all be present and unchanged", () => {
  const rec = record();
  const good = primaryReport({ verdict: "finished", assessment: assessmentSection([]) });
  const tamperedReport = verify(rec, payloadFor(rec, good, {
    mutateFiles(files) { files["report.md"].base64 = Buffer.from("PASS".padEnd(files["report.md"].bytes, "x")).toString("base64"); },
  }));
  assert.equal(tamperedReport.classification, "remote_result_invalid");

  const unsafe = verify(rec, payloadFor(rec, good, {
    mutateFiles(files) { files["../escape.txt"] = files["report.md"]; },
  }));
  assert.equal(unsafe.classification, "remote_result_invalid");

  const missingListed = verify(rec, payloadFor(rec, good, {
    extraFiles: { "events.ndjson": "{}\n" },
    mutateFiles(files) { delete files["events.ndjson"]; },
  }));
  assert.equal(missingListed.classification, "remote_result_invalid");

  const metaDisagrees = verify(rec, payloadFor(rec, good, {
    extraFiles: { "events.ndjson": "{}\n" },
    mutateMeta(meta) { meta.files["events.ndjson"].sha256 = "0".repeat(64); },
  }));
  assert.equal(metaDisagrees.classification, "remote_result_invalid");

  const noReport = payloadFor(rec, good);
  delete noReport.files["report.md"];
  assert.equal(verify(rec, noReport).classification, "remote_result_invalid");
});

test("a moved HEAD or dirty tracked files after submission means the report no longer describes this repository", () => {
  const rec = record();
  const payload = payloadFor(rec, primaryReport({ verdict: "finished", assessment: assessmentSection([]) }));
  assert.equal(verify(rec, payload, cleanGit({ head: "9".repeat(40) })).classification, "remote_target_changed");
  assert.equal(verify(rec, payload, cleanGit({ dirty: " M file.txt\n" })).classification, "remote_target_changed");
  assert.equal(verify(rec, payload).status, "finished");
});

test("the receipt never carries the report body or any base64 payload", () => {
  const rec = record();
  const out = verify(rec, payloadFor(rec, primaryReport({ verdict: "finished", assessment: assessmentSection([]) })));
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes("六軸審查"));
  assert.ok(!/base64/iu.test(serialized));
  assert.equal(out.report_sha256.length, 64);
});

test("key order in the returned target is not significant (the bridge serializes with sorted keys)", () => {
  const rec = record();
  const payload = payloadFor(rec, primaryReport({ verdict: "finished", assessment: assessmentSection([]) }), {
    mutateMeta(meta) { meta.target = { kind: meta.target.kind, head: meta.target.head, base: meta.target.base }; },
  });
  assert.deepEqual(Object.keys(payload.result.target), ["kind", "head", "base"]);
  assert.equal(verify(rec, payload).status, "finished");
});

// The creator code is known only from the submit answer, so the receipt copies it from the local record. It is
// never a verification input: a record from before the Gateway signed anything has none, and that must not fail.
test("the receipt carries the creator_ref recorded at submit; a record without one gets null and still verifies", () => {
  const report = () => primaryReport({ verdict: "finished", assessment: assessmentSection([]) });
  const recorded = { ...record(), creator_ref: "31d9f7bc0fad336c" };
  const withCode = verify(recorded, payloadFor(recorded, report()));
  assert.equal(withCode.status, "finished");
  assert.equal(withCode.creator_ref, "31d9f7bc0fad336c");

  const legacy = record(); // written before creator_ref existed
  const without = verify(legacy, payloadFor(legacy, report()));
  assert.equal(without.status, "finished");
  assert.equal(without.creator_ref, null);

  const unrecorded = { ...record(), creator_ref: null };
  assert.equal(verify(unrecorded, payloadFor(unrecorded, report())).creator_ref, null);
});

test("a creator_ref that is not a 16-hex code is never copied into a receipt", () => {
  for (const bad of ["31D9F7BC0FAD336C", "user", 12, { id: "user" }, "31d9f7bc0fad336c\n"]) {
    const rec = { ...record(), creator_ref: bad };
    const out = verify(rec, payloadFor(rec, primaryReport({ verdict: "finished", assessment: assessmentSection([]) })));
    assert.equal(out.status, "finished", JSON.stringify(bad));
    assert.equal(out.creator_ref, null, JSON.stringify(bad));
  }
});

test("the audit-only receipt carries the creator_ref too", () => {
  const rec = { ...record("audit-only"), creator_ref: "d395850cf90b81a5" };
  const out = verify(rec, payloadFor(rec, "advisory\n" + assessmentSection([])));
  assert.equal(out.status, "completed");
  assert.equal(out.creator_ref, "d395850cf90b81a5");
});
