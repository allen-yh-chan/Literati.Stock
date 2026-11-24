import "./lib/isolated-control-evidence-state.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertStickyBodyCredentialFree,
  STICKY_CREDENTIAL_LITERAL_BLOCKED,
  STICKY_CREDENTIAL_LITERAL_DETECTED,
} from "../lib/second-review-sticky-credential-gate.mjs";
import {
  runGatedStickyWrite,
  STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA,
  stickyWriteResultBasename,
  assertSidecarPathAllowlisted,
  DEFAULT_GATED_WRITE_REPO_ROOT,
} from "../write-second-review-sticky-gated.mjs";
import { repoPath } from "./lib/repo-root.mjs";
import { __testReviewerClassification } from "../run-second-reviewer-projection.mjs";

test("successful sticky writer supplies a serialized completion accepted by the strict runner", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sticky-completion-"));
  try {
    const head = "a".repeat(40);
    const dispatch = "dispatch-completion-serialization";
    const url = "https://github.com/devpro/example/pull/123#issuecomment-456";
    const assessment = { schema: "devpro.review-guarantee-assessment/v1", reviewed_target: head, dispatch_id: dispatch, assessments: [] };
    const reason = 'Reviewed "quotes" and a literal \\n token.';
    const body = [
      "<!-- cross-model-second-opinion:sticky -->", "verdict: PASS",
      `last_reviewed_sha: ${head}`, `dispatch_id: ${dispatch}`, `reason: ${reason}`,
      "## Cross-Model Second Opinion Review", "No findings.",
      "## Guarantee Assessment", "```json", JSON.stringify(assessment), "```",
      "Rules: v7.8.1 · Tool: OpenCode · Model: deepseek-test", "",
    ].join("\n");
    const bodyPath = path.join(dir, "body.md");
    writeFileSync(bodyPath, body);
    const sidecarPath = writeTempSidecar(dir, {
      schema: STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA, disposition: "create",
      repository_slug: "devpro/example", pr_number: 123, body_file: bodyPath,
    });
    const { status, result } = runGatedStickyWrite({
      sidecarPath, cwd: dir, enforcePathAllowlist: false,
      spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify({ id: 456, html_url: url, body }) }),
    });
    assert.equal(status, 0);
    assert.equal(typeof result.completion_json, "string");
    const completion = JSON.parse(result.completion_json);
    assert.equal(completion.sticky_comment_url, url);
    assert.equal(completion.reviewer_model, "deepseek-test");
    assert.ok(completion.reason.startsWith(`${reason}\n\n## Guarantee Assessment\n`));
    const context = { mode: "pr-sticky", head_ref_oid: head, dispatch_id: dispatch, guarantee_assessment_required: true };
    assert.equal(__testReviewerClassification.parseCompletionObject(context, result.completion_json).status, "accepted");
    assert.equal(__testReviewerClassification.parseCompletionObject(context, `Done.\n\n${result.completion_json}`).status, "malformed");
    assert.equal(__testReviewerClassification.parseCompletionObject({ ...context, head_ref_oid: "b".repeat(40) }, result.completion_json).status, "stale");
    for (const changed of [
      { body: `${body}\n` },
      { html_url: "https://github.com/devpro/other/pull/123#issuecomment-456" },
      { id: 789 },
    ]) {
      const output = runGatedStickyWrite({
        sidecarPath, cwd: dir, enforcePathAllowlist: false,
        spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify({ id: 456, html_url: url, body, ...changed }) }),
      });
      assert.equal(output.status, 0, "a completed write must not become retryable");
      assert.equal(output.result.completion_json, undefined, "unbound response must not supply a completion");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SYNTH = "SYNTH_PWD_TEST_ONLY_9f3a";

function digestSidecar(payload) {
  const withoutDigest = { ...payload };
  delete withoutDigest.digest;
  return createHash("sha256")
    .update(JSON.stringify(withoutDigest), "utf8")
    .digest("hex");
}

/** Temp-dir sidecar for gate/behavior tests (skip path allowlist). */
function writeTempSidecar(dir, payload) {
  const withDigest = { ...payload, digest: digestSidecar(payload) };
  const sidecarPath = path.join(dir, "sticky-credential-gate-sidecar.json");
  writeFileSync(sidecarPath, `${JSON.stringify(withDigest)}\n`, "utf8");
  return sidecarPath;
}

test("a recorded Critical prevents a later window from publishing PASS or WARN", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sticky-critical-clamp-"));
  try {
    const bodyPath = path.join(dir, "body.md");
    const sidecarPath = writeTempSidecar(dir, {
      schema: STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA,
      disposition: "update", repository_slug: "devpro/example", pr_number: 1,
      comment_id: 42, dispatch_id: "critical-clamp", body_file: bodyPath,
      materialTexts: [], explicitDenyList: [], required_verdict: "CRITICAL",
    });
    for (const verdict of ["PASS", "WARN", "UNAVAILABLE", "CRITICAL"]) {
      writeFileSync(bodyPath, `verdict: ${verdict}\nreason: bounded review finding\n`);
      let writes = 0;
      const output = runGatedStickyWrite({
        sidecarPath, cwd: dir, enforcePathAllowlist: false,
        spawnSyncImpl: () => { writes += 1; return { status: 0, stdout: "{}" }; },
      });
      assert.equal(writes, verdict === "CRITICAL" ? 1 : 0);
      assert.equal(output.result.classification, verdict === "CRITICAL" ? "sticky_write_ok" : "sticky_required_verdict_mismatch");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T1 prove-it: synth credential literal is blocked before gh write", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sticky-cred-gate-"));
  const bodyPath = path.join(dir, "cross-model-second-opinion.md");
  writeFileSync(
    bodyPath,
    [
      "<!-- cross-model-second-opinion:sticky -->",
      "verdict: WARN",
      "last_reviewed_sha: abcdef0123456789abcdef0123456789abcdef01",
      "dispatch_id: dispatch-prove-it",
      `reason: observed Pwd=${SYNTH} in material`,
      "Rules: v6.94.0 · Tool: Claude Code · Model: test-model",
      "",
    ].join("\n"),
    "utf8",
  );
  const payload = {
    schema: STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA,
    disposition: "create",
    repository_slug: "devpro/example",
    pr_number: 1,
    dispatch_id: "dispatch-prove-it",
    body_file: bodyPath,
    materialTexts: [`Pwd=${SYNTH}`],
    explicitDenyList: [],
  };
  const sidecarPath = writeTempSidecar(dir, payload);

  let ghCalls = 0;
  const result = runGatedStickyWrite({
    sidecarPath,
    cwd: dir,
    enforcePathAllowlist: false,
    spawnSyncImpl: () => {
      ghCalls += 1;
      return { status: 0, stdout: "{}", stderr: "" };
    },
  });

  assert.equal(result.status, 1);
  assert.equal(ghCalls, 0, "gh must not be called when credential gate blocks");
  assert.equal(result.result.classification, STICKY_CREDENTIAL_LITERAL_BLOCKED);
  assert.equal(String(JSON.stringify(result.result)).includes(SYNTH), false);
  const resultPath = path.join(dir, stickyWriteResultBasename("dispatch-prove-it"));
  assert.equal(existsSync(resultPath), true);
  const written = JSON.parse(readFileSync(resultPath, "utf8"));
  assert.equal(written.ok, false);
  assert.equal(written.classification, STICKY_CREDENTIAL_LITERAL_BLOCKED);
  assert.equal(written.dispatch_id, "dispatch-prove-it");
  assert.equal(JSON.stringify(written).includes(SYNTH), false);
});

test("T1/T5 prove-it: body containing synth cannot pass post-write detected assert", () => {
  const body = `reason: Pwd=${SYNTH}`;
  const gate = assertStickyBodyCredentialFree(body, {
    classification: STICKY_CREDENTIAL_LITERAL_DETECTED,
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.classification, STICKY_CREDENTIAL_LITERAL_DETECTED);
});

test("PRIM-F1: missing digest fail-closed; arbitrary sidecar path rejected", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sticky-cred-digest-"));
  const bodyPath = path.join(dir, "body.md");
  writeFileSync(bodyPath, "safe reason\n", "utf8");
  const sidecarPath = path.join(dir, "sticky-credential-gate-missing-digest.json");
  writeFileSync(sidecarPath, `${JSON.stringify({
    schema: STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA,
    disposition: "create",
    repository_slug: "devpro/example",
    pr_number: 1,
    body_file: bodyPath,
    materialTexts: [],
    explicitDenyList: [],
  })}\n`, "utf8");

  const missingDigest = runGatedStickyWrite({
    sidecarPath,
    cwd: dir,
    enforcePathAllowlist: false,
    spawnSyncImpl: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  assert.equal(missingDigest.status, 1);
  assert.equal(missingDigest.result.classification, "sticky_credential_gate_sidecar_invalid");
  assert.match(missingDigest.result.error, /digest is required/);

  const arbitrary = path.join(dir, "not-allowlisted.json");
  writeFileSync(arbitrary, "{}\n", "utf8");
  assert.throws(
    () => assertSidecarPathAllowlisted(arbitrary, DEFAULT_GATED_WRITE_REPO_ROOT),
    /notes\/tmp|carrier/,
  );
});

test("PRIM-F2 prove-it: isolated synth literal blocked when material sidecar has Pwd= shape", () => {
  // Body is only the extracted secret value (no Pwd=). Body-only shape scan would
  // miss it; materialTexts from sidecar must still deny.
  const bodyOnly = SYNTH;
  assert.equal(assertStickyBodyCredentialFree(bodyOnly, { materialTexts: [] }).ok, true);
  const withMaterial = assertStickyBodyCredentialFree(bodyOnly, {
    materialTexts: [`Pwd=${SYNTH}`],
    classification: STICKY_CREDENTIAL_LITERAL_DETECTED,
  });
  assert.equal(withMaterial.ok, false);
  assert.equal(withMaterial.classification, STICKY_CREDENTIAL_LITERAL_DETECTED);
});

test("PRIM-F1 allowlist accepts notes/tmp sticky-credential-gate-*.json under repo", () => {
  const notesTmp = repoPath("notes/tmp");
  mkdirSync(notesTmp, { recursive: true });
  const sidecarPath = path.join(
    notesTmp,
    `sticky-credential-gate-dispatch-allowlist-prove-${process.pid}.json`,
  );
  const bodyPath = path.join(notesTmp, `body-allowlist-prove-${process.pid}.md`);
  writeFileSync(bodyPath, "safe reason without secrets\n", "utf8");
  const payload = {
    schema: STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA,
    disposition: "create",
    repository_slug: "devpro/example",
    pr_number: 1,
    dispatch_id: "dispatch-allowlist-prove",
    body_file: bodyPath,
    materialTexts: [],
    explicitDenyList: [],
  };
  writeFileSync(sidecarPath, `${JSON.stringify({ ...payload, digest: digestSidecar(payload) })}\n`, "utf8");
  try {
    assert.equal(assertSidecarPathAllowlisted(sidecarPath, DEFAULT_GATED_WRITE_REPO_ROOT), path.resolve(sidecarPath));
    let ghCalls = 0;
    const result = runGatedStickyWrite({
      sidecarPath,
      cwd: notesTmp,
      spawnSyncImpl: () => {
        ghCalls += 1;
        return { status: 0, stdout: "{\"id\":1}\n", stderr: "" };
      },
    });
    assert.equal(result.status, 0);
    assert.equal(ghCalls, 1);
  } finally {
    rmSync(sidecarPath, { force: true });
    rmSync(bodyPath, { force: true });
    rmSync(path.join(notesTmp, stickyWriteResultBasename("dispatch-allowlist-prove")), { force: true });
  }
});

test("PRIM-F18: successful gh write still returns status 0 when result-file write fails", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sticky-cred-f18-"));
  const bodyPath = path.join(dir, "cross-model-second-opinion.md");
  writeFileSync(bodyPath, "safe reason without secrets\n", "utf8");
  const payload = {
    schema: STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA,
    disposition: "create",
    repository_slug: "devpro/example",
    pr_number: 1,
    dispatch_id: "dispatch-f18-success",
    body_file: bodyPath,
    materialTexts: [],
    explicitDenyList: [],
  };
  const sidecarPath = writeTempSidecar(dir, payload);
  const resultPath = path.join(dir, stickyWriteResultBasename("dispatch-f18-success"));
  mkdirSync(resultPath, { recursive: true });

  let ghCalls = 0;
  const result = runGatedStickyWrite({
    sidecarPath,
    cwd: dir,
    enforcePathAllowlist: false,
    spawnSyncImpl: () => {
      ghCalls += 1;
      return { status: 0, stdout: "{\"id\":99}\n", stderr: "" };
    },
  });
  assert.equal(ghCalls, 1);
  assert.equal(result.status, 0);
  assert.equal(result.result.classification, "sticky_write_ok");
});

test("carrier sidecar outside notes/cross-review is rejected", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sticky-cred-carrier-"));
  const sidecarPath = path.join(dir, "sticky-credential-gate-sidecar.json");
  writeFileSync(path.join(dir, "observability-context.json"), "{}\n", "utf8");
  writeFileSync(sidecarPath, "{}\n", "utf8");
  assert.throws(
    () => assertSidecarPathAllowlisted(sidecarPath, DEFAULT_GATED_WRITE_REPO_ROOT),
    /notes\/cross-review/,
  );
});

test("credential_gate_mode shape-and-explicit-only still scans provided materialTexts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sticky-cred-mode-"));
  const bodyPath = path.join(dir, "cross-model-second-opinion.md");
  writeFileSync(bodyPath, `reason: leak ${SYNTH}\n`, "utf8");
  const payload = {
    schema: STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA,
    disposition: "create",
    repository_slug: "devpro/example",
    pr_number: 1,
    body_file: bodyPath,
    materialTexts: [`Pwd=${SYNTH}`],
    explicitDenyList: [],
    credential_gate_mode: "shape-and-explicit-only",
  };
  const sidecarPath = writeTempSidecar(dir, payload);
  let ghCalls = 0;
  const result = runGatedStickyWrite({
    sidecarPath,
    cwd: dir,
    enforcePathAllowlist: false,
    spawnSyncImpl: () => {
      ghCalls += 1;
      return { status: 0, stdout: "{\"id\":1}\n", stderr: "" };
    },
  });
  assert.equal(result.status, 1);
  assert.equal(ghCalls, 0);
  assert.equal(result.result.classification, STICKY_CREDENTIAL_LITERAL_BLOCKED);
});

test("credential_gate_mode shape-and-explicit-only allows write when materialTexts empty and body is clean", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sticky-cred-mode-empty-"));
  const bodyPath = path.join(dir, "cross-model-second-opinion.md");
  writeFileSync(bodyPath, "reason: no credential literals in narrative\n", "utf8");
  const payload = {
    schema: STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA,
    disposition: "create",
    repository_slug: "devpro/example",
    pr_number: 1,
    body_file: bodyPath,
    materialTexts: [],
    explicitDenyList: [],
    credential_gate_mode: "shape-and-explicit-only",
  };
  const sidecarPath = writeTempSidecar(dir, payload);
  let ghCalls = 0;
  const result = runGatedStickyWrite({
    sidecarPath,
    cwd: dir,
    enforcePathAllowlist: false,
    spawnSyncImpl: () => {
      ghCalls += 1;
      return { status: 0, stdout: "{\"id\":1}\n", stderr: "" };
    },
  });
  assert.equal(result.status, 0);
  assert.equal(ghCalls, 1);
});

test("blank lines after the footer are dropped before publishing, and nothing else changes", async () => {
  const { parseSecondReviewStickyAuthorityBody } = await import("../hooks/lib/second-review-sticky-authority.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "sticky-trailing-newlines-"));
  const bodyPath = path.join(dir, "cross-model-second-opinion.md");
  const body = "<!-- cross-model-second-opinion:sticky -->\nverdict: WARN\nlast_reviewed_sha: "
    + `${"a".repeat(40)}\ndispatch_id: dispatch-trailing\nreason: one finding.\n\nRules: v7.7.0 · Tool: OpenCode · Model: deepseek/deepseek-v4-pro`;
  const sidecarPath = writeTempSidecar(dir, {
    schema: STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA, disposition: "create",
    repository_slug: "devpro/example", pr_number: 1, body_file: bodyPath,
    materialTexts: [], explicitDenyList: [], credential_gate_mode: "shape-and-explicit-only",
  });
  try {
    for (const [ending, published] of [["\n\n", "\n"], ["\r\n\r\n\n", "\n"], ["\n", "\n"], ["", ""]]) {
      writeFileSync(bodyPath, `${body}${ending}`, "utf8");
      let sent = null;
      const result = runGatedStickyWrite({
        sidecarPath, cwd: dir, enforcePathAllowlist: false,
        spawnSyncImpl: (_binary, _args, options) => {
          sent = JSON.parse(options.input).body;
          return { status: 0, stdout: "{\"id\":1}\n", stderr: "" };
        },
      });
      assert.equal(result.status, 0);
      assert.equal(sent, `${body}${published}`);
      assert.deepEqual(parseSecondReviewStickyAuthorityBody(sent).contract_errors, []);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PRIM-F7/F17: paged deny-set includes non-final full-pages carrier content", async () => {
  const { collectCredentialGateMaterialTexts } = await import("../render-second-review-packet.mjs");
  const SYNTH_NON_FINAL = "SYNTH_PWD_TEST_ONLY_paged_nf_7a2c";
  const effectiveInput = {
    review_material: {
      pages: [{ index: 2, content: "final window is clean narrative only" }],
    },
  };
  const context = {
    __paged_full_pages_carrier: {
      pages: [
        { index: 1, content: `Pwd=${SYNTH_NON_FINAL}` },
        { index: 2, content: "final window is clean narrative only" },
      ],
    },
  };
  const texts = collectCredentialGateMaterialTexts(effectiveInput, context);
  assert.ok(texts.some((t) => t.includes(SYNTH_NON_FINAL)), "deny-set must include non-final page");
  const bodyOnlyFinalToken = `reason: leak ${SYNTH_NON_FINAL}`;
  const gate = assertStickyBodyCredentialFree(bodyOnlyFinalToken, {
    materialTexts: texts,
    classification: STICKY_CREDENTIAL_LITERAL_BLOCKED,
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.classification, STICKY_CREDENTIAL_LITERAL_BLOCKED);
});

// ---------------------------------------------------------------------------
// fix-external-evaluator-sticky-recipe T2 prove-it (RED; design.md D4, D9 item
// 2; tasks.md T2). runGatedStickyWrite currently requires an absolute
// sidecarPath unconditionally (assertSidecarPathAllowlisted throws "sidecar
// path must be absolute" before any allowlist/resolution logic runs). D4 adds
// a one-time resolution against an injected `cwd` at entry, after which the
// existing absolute-path allowlist/digest/read logic is unchanged. These
// fixtures never call process.chdir on the real process; they instead assert
// that `cwd`/`repoRoot` differ from the actual `process.cwd()` at test time,
// so acceptance can only pass if the resolution genuinely uses the injected
// `cwd` argument, never a `process.cwd()` fallback (NFR4).
// ---------------------------------------------------------------------------

test("Scenario: Relative sidecar resolves against the working directory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sticky-cred-relative-"));
  try {
    assert.notEqual(
      path.resolve(process.cwd()),
      path.resolve(root),
      "the injected cwd/repoRoot must differ from process.cwd() to exercise NFR4",
    );
    const cases = [
      {
        label: "carrier relative (notes/cross-review/<attempt>/…)",
        relDir: "notes/cross-review/second-review-relative-carrier",
        sidecarBasename: "sticky-credential-gate-sidecar.json",
        needsSibling: true,
        dispatchId: "dispatch-relative-carrier",
      },
      {
        label: "notes/tmp relative",
        relDir: "notes/tmp",
        sidecarBasename: "sticky-credential-gate-dispatch-relative-tmp.json",
        needsSibling: false,
        dispatchId: "dispatch-relative-tmp",
      },
    ];
    for (const testCase of cases) {
      const absDir = path.join(root, ...testCase.relDir.split("/"));
      mkdirSync(absDir, { recursive: true });
      if (testCase.needsSibling) {
        writeFileSync(path.join(absDir, "observability-context.json"), "{}\n", "utf8");
      }
      const bodyRelPath = `${testCase.relDir}/cross-model-second-opinion.md`;
      writeFileSync(path.join(root, ...bodyRelPath.split("/")), "safe reason without secrets\n", "utf8");
      const payload = {
        schema: STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA,
        disposition: "create",
        repository_slug: "devpro/example",
        pr_number: 1,
        dispatch_id: testCase.dispatchId,
        body_file: bodyRelPath,
        materialTexts: [],
        explicitDenyList: [],
      };
      writeFileSync(
        path.join(absDir, testCase.sidecarBasename),
        `${JSON.stringify({ ...payload, digest: digestSidecar(payload) })}\n`,
        "utf8",
      );
      const sidecarRelPath = `${testCase.relDir}/${testCase.sidecarBasename}`;

      const calls = [];
      const result = runGatedStickyWrite({
        sidecarPath: sidecarRelPath,
        cwd: root,
        repoRoot: root,
        spawnSyncImpl: (cmd, args, options) => {
          calls.push({ cmd, args, cwd: options?.cwd });
          return { status: 0, stdout: "{\"id\":1}\n", stderr: "" };
        },
      });

      assert.equal(result.status, 0, `${testCase.label}: ${JSON.stringify(result.result)}`);
      assert.equal(calls.length, 1, testCase.label);
      assert.equal(calls[0].args[1], "repos/devpro/example/issues/1/comments", testCase.label);
      assert.equal(calls[0].args[3], "POST", testCase.label);
      assert.equal(calls[0].cwd, root, `${testCase.label}: gh must run from the injected cwd, not process.cwd()`);
      const resultPath = path.join(absDir, stickyWriteResultBasename(testCase.dispatchId));
      assert.equal(existsSync(resultPath), true, `${testCase.label}: result file must sit beside the resolved sidecar`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Scenario: Relative sidecar outside the allowlist fails closed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sticky-cred-relative-denied-"));
  const otherRoot = mkdtempSync(path.join(tmpdir(), "sticky-cred-relative-other-root-"));
  function attempt(sidecarRelPath, { cwd = root, repoRoot = root } = {}) {
    let ghCalls = 0;
    const result = runGatedStickyWrite({
      sidecarPath: sidecarRelPath,
      cwd,
      repoRoot,
      spawnSyncImpl: () => {
        ghCalls += 1;
        return { status: 0, stdout: "{}", stderr: "" };
      },
    });
    return { result, ghCalls };
  }
  try {
    // 1. Resolved path lands outside both allowlisted shapes entirely.
    {
      const outsideDir = path.join(root, "not-allowlisted");
      mkdirSync(outsideDir, { recursive: true });
      const payload = {
        schema: STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA,
        disposition: "create",
        repository_slug: "devpro/example",
        pr_number: 1,
        dispatch_id: "dispatch-outside-allowlist",
        body_file: "body.md",
        materialTexts: [],
        explicitDenyList: [],
      };
      writeFileSync(
        path.join(outsideDir, "sticky-credential-gate-sidecar.json"),
        `${JSON.stringify({ ...payload, digest: digestSidecar(payload) })}\n`,
        "utf8",
      );
      const { result, ghCalls } = attempt("not-allowlisted/sticky-credential-gate-sidecar.json");
      assert.equal(result.status, 1, "outside allowlist");
      assert.equal(result.result.classification, "sticky_credential_gate_sidecar_invalid", "outside allowlist");
      assert.match(result.result.error, /notes\/cross-review/, "outside allowlist must name the carrier requirement");
      assert.equal(ghCalls, 0, "outside allowlist");
    }

    // 2. `..` traversal must not escape the notes/tmp allowlist boundary via
    // lexical resolution (path.resolve normalizes, then the prefix compare
    // rejects). Built with array#join, not path.join, so the literal ".."
    // segments survive into the string passed to runGatedStickyWrite.
    {
      const traversalRelPath = ["notes", "tmp", "..", "..", "sticky-credential-gate-traversal.json"].join("/");
      const { result, ghCalls } = attempt(traversalRelPath);
      assert.equal(result.status, 1, "traversal");
      assert.equal(result.result.classification, "sticky_credential_gate_sidecar_invalid", "traversal");
      assert.match(result.result.error, /must be under notes\/tmp/, "traversal must name the allowlist shape");
      assert.equal(ghCalls, 0, "traversal");
    }

    // 3. Carrier-relative sidecar missing its sibling observability-context.json.
    {
      const carrierDir = path.join(root, "notes", "cross-review", "second-review-missing-sibling");
      mkdirSync(carrierDir, { recursive: true });
      const payload = {
        schema: STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA,
        disposition: "create",
        repository_slug: "devpro/example",
        pr_number: 1,
        dispatch_id: "dispatch-missing-sibling",
        body_file: "cross-model-second-opinion.md",
        materialTexts: [],
        explicitDenyList: [],
      };
      writeFileSync(
        path.join(carrierDir, "sticky-credential-gate-sidecar.json"),
        `${JSON.stringify({ ...payload, digest: digestSidecar(payload) })}\n`,
        "utf8",
      );
      const { result, ghCalls } = attempt(
        "notes/cross-review/second-review-missing-sibling/sticky-credential-gate-sidecar.json",
      );
      assert.equal(result.status, 1, "missing sibling");
      assert.equal(result.result.classification, "sticky_credential_gate_sidecar_invalid", "missing sibling");
      assert.match(result.result.error, /sibling observability-context\.json/, "missing sibling must name the sibling requirement");
      assert.equal(ghCalls, 0, "missing sibling");
    }

    // 4. `repoRoot` names a different root than where the sidecar actually resides.
    {
      const carrierDir = path.join(root, "notes", "cross-review", "second-review-cross-root");
      mkdirSync(carrierDir, { recursive: true });
      writeFileSync(path.join(carrierDir, "observability-context.json"), "{}\n", "utf8");
      const payload = {
        schema: STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA,
        disposition: "create",
        repository_slug: "devpro/example",
        pr_number: 1,
        dispatch_id: "dispatch-cross-root",
        body_file: "cross-model-second-opinion.md",
        materialTexts: [],
        explicitDenyList: [],
      };
      writeFileSync(
        path.join(carrierDir, "sticky-credential-gate-sidecar.json"),
        `${JSON.stringify({ ...payload, digest: digestSidecar(payload) })}\n`,
        "utf8",
      );
      const { result, ghCalls } = attempt(
        "notes/cross-review/second-review-cross-root/sticky-credential-gate-sidecar.json",
        { cwd: root, repoRoot: otherRoot },
      );
      assert.equal(result.status, 1, "cross root");
      assert.equal(result.result.classification, "sticky_credential_gate_sidecar_invalid", "cross root");
      assert.match(result.result.error, /notes\/cross-review/, "cross root must name the carrier requirement");
      assert.equal(ghCalls, 0, "cross root");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
  }
});

test("prove-it: material account equal to the sealed repository owner does not block a sticky that names the repo", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sticky-cred-public-account-"));
  try {
    const bodyLines = (extra) => [
      "<!-- cross-model-second-opinion:sticky -->",
      "verdict: WARN",
      "last_reviewed_sha: abcdef0123456789abcdef0123456789abcdef01",
      "dispatch_id: dispatch-public-account",
      `reason: appsettings change in synthowner-tw/synthowner-app; see synthowner-agent-rules${extra}`,
      "",
      "Rules: v7.17.2 · Tool: Claude Code · Model: test-model",
      "",
    ].join("\n");
    const run = (body) => {
      const bodyPath = path.join(dir, "cross-model-second-opinion.md");
      writeFileSync(bodyPath, body, "utf8");
      const sidecarPath = writeTempSidecar(dir, {
        schema: STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA,
        disposition: "create",
        repository_slug: "synthowner-tw/synthowner-app",
        pr_number: 1,
        dispatch_id: "dispatch-public-account",
        body_file: bodyPath,
        materialTexts: [`"Default": "Server=db.example.internal;User Id=synthowner;Password=${SYNTH};"`],
        explicitDenyList: [],
      });
      let ghCalls = 0;
      const outcome = runGatedStickyWrite({
        sidecarPath, cwd: dir, enforcePathAllowlist: false,
        spawnSyncImpl: () => { ghCalls += 1; return { status: 0, stdout: "{}", stderr: "" }; },
      });
      return { outcome, ghCalls };
    };

    const allowed = run(bodyLines(""));
    assert.notEqual(allowed.outcome.result?.classification, STICKY_CREDENTIAL_LITERAL_BLOCKED);
    assert.equal(allowed.ghCalls, 1, "public account literal must not stop the gh write");

    const leaked = run(bodyLines(` (password ${SYNTH})`));
    assert.equal(leaked.outcome.status, 1);
    assert.equal(leaked.ghCalls, 0);
    assert.equal(leaked.outcome.result.classification, STICKY_CREDENTIAL_LITERAL_BLOCKED);
    assert.equal(leaked.outcome.result.matched_token_kind, "password");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
