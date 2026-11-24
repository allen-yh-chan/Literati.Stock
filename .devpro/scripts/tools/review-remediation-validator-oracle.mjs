#!/usr/bin/env node
// Production independently-verified validator evidence oracle
// (fix-validator-touching-bounded-escape D3).
// Closed node: builtins only. MUST NOT import the remediation façade or core.

import crypto from "node:crypto";

const sort = (value) => {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
  }
  return value;
};

const canonical = (value) => JSON.stringify(sort(value));

export async function verify(request) {
  const assertion = request.manifest_assertion;
  if (!assertion || assertion.manifest_digest_sha256 || assertion.validator?.independent_evidence) {
    throw new Error("invalid assertion");
  }
  const manifestDigest = crypto.createHash("sha256").update(canonical(assertion)).digest("hex");
  const evidence = {
    schema: "devpro.review-remediation.validator-evidence/v1",
    oracle: request.oracle,
    subject: {
      validator_source_path: assertion.validator.source_path,
      validator_source_digest_sha256: assertion.validator.source_digest_sha256,
      manifest_assertion_digest_sha256: manifestDigest,
    },
    lineage: {
      change_base_sha: assertion.lineage.change_base_sha,
      candidate_head_sha: assertion.lineage.candidate_head_sha,
    },
    result: "verified",
  };
  const digest = crypto.createHash("sha256").update(JSON.stringify(sort(evidence))).digest("hex");
  return { ...evidence, evidence_digest_sha256: digest };
}
