/**
 * final-suite-profile.mjs
 *
 * One carrier for one decision: **which profile is the canonical final suite
 * of `seal-final` run under, and is the runner's stdout consistent with it**
 * (design D2/D3/D4 of fix-seal-final-consumer-na-suite-evidence).
 *
 * This module only combines existing oracles; it never writes files and never
 * spawns anything on its own (the one git probe goes through an injectable
 * `runGit`). Integration with the sealing core lives elsewhere.
 *
 * Diagnostics produced here carry only fixed strings and closed tokens. They
 * never echo runner output, `classifyRepoIdentity` evidence strings or
 * filesystem paths.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import {
  CONSUMER_PROFILE_NA_LINE,
  resolveConsumerRulesContext,
  selectTestSuiteRoute,
} from "../run-test-suite.mjs";
import { classifyRepoIdentity } from "./repo-identity.mjs";

export const FINAL_SUITE_RESULT_PASS = "pass";
export const FINAL_SUITE_RESULT_CONSUMER_NA = "not-applicable-consumer-profile";

// Paths that exist in the source checkout but are never distributed by the
// rules sync (managed set), so a genuine consumer does not carry them. Both are
// maintained corpora in different trees; either one present means "source".
export const SOURCE_ONLY_CORPUS_SENTINELS = Object.freeze([
  "openspec/specs/pre-tool-mechanical-gates/spec.md",
  "scenarios/scenario-m-consumer-repo-pre-pr-flow.md",
]);

// Closed `basis` vocabulary of `determineFinalSuiteProfile`.
export const FINAL_SUITE_PROFILE_BASES = Object.freeze([
  "consumer-direct",
  "runner-oracle-source",
  "consumer-submodule",
  "identity-source",
  "identity-unknown",
  "source-corpus-present",
  "oracle-error",
]);

// Closed `reason` vocabulary of `checkFinalSuiteOutput`.
export const FINAL_SUITE_OUTPUT_REASONS = Object.freeze([
  "invalid-route",
  "output-malformed",
  "stdout-not-utf8",
  "stderr-not-utf8",
  "consumer-na-output-mismatch",
  "source-route-reported-not-applicable",
]);

// Both the consumer variant and the smoke variant of the runner's N/A line
// start with this prefix.
export const SOURCE_MAINTAINER_NA_PREFIX = "[test-suite] source-maintainer checks: N/A";

/**
 * Is any source-only corpus sentinel present in the HEAD tree or the working
 * directory? Throws when the HEAD-tree probe cannot be trusted, so the caller
 * can fail closed instead of reading "no output" as "absent".
 */
export function probeSourceOnlyCorpus(repoRoot, { runGit = spawnSync, exists = existsSync } = {}) {
  const probe = runGit(
    "git",
    ["-C", repoRoot, "ls-tree", "--full-tree", "--name-only", "HEAD", "--", ...SOURCE_ONLY_CORPUS_SENTINELS],
    { encoding: "utf8" },
  );
  if (!probe || probe.error || probe.status !== 0 || typeof probe.stdout !== "string") {
    throw new Error("source-only corpus probe failed");
  }
  const inHeadTree = probe.stdout.split("\n").some((line) => SOURCE_ONLY_CORPUS_SENTINELS.includes(line));
  const inWorkingTree = SOURCE_ONLY_CORPUS_SENTINELS.some((sentinel) => exists(path.join(repoRoot, sentinel)));
  return { present: inHeadTree || inWorkingTree };
}

function sourceSuite(basis) {
  return { route: "source-suite", expectedResult: FINAL_SUITE_RESULT_PASS, basis };
}

/**
 * Four-condition conjunction (design D4). Only all four together yield
 * `consumer-na`; everything else, including any thrown or malformed oracle
 * answer, is the source route. Evaluation stops at the first failing
 * condition, so later oracles are not consulted.
 */
export function determineFinalSuiteProfile(repoRoot, {
  resolveContext = resolveConsumerRulesContext,
  selectRoute = selectTestSuiteRoute,
  classifyIdentity = classifyRepoIdentity,
  probeSourceCorpus = probeSourceOnlyCorpus,
} = {}) {
  try {
    // 1. runner oracle: direct consumer.
    const consumerContext = resolveContext(repoRoot);
    if (consumerContext === null || typeof consumerContext !== "object") return sourceSuite("oracle-error");
    if (consumerContext.profile !== "consumer") {
      return consumerContext.profile === "source"
        ? sourceSuite("runner-oracle-source")
        : sourceSuite("oracle-error");
    }
    if (consumerContext.mode === "submodule") return sourceSuite("consumer-submodule");
    if (consumerContext.mode !== "direct") return sourceSuite("oracle-error");

    // 2. the runner's own route function for the base the seal actually spawns.
    if (selectRoute({ changedBase: "main", consumerContext }) !== "consumer-na") {
      return sourceSuite("runner-oracle-source");
    }

    // 3. governance identity.
    const identity = classifyIdentity(repoRoot);
    if (identity === null || typeof identity !== "object") return sourceSuite("oracle-error");
    if (identity.identity === "source") return sourceSuite("identity-source");
    if (identity.identity === "unknown") return sourceSuite("identity-unknown");
    if (identity.identity !== "consumer") return sourceSuite("oracle-error");

    // 4. no source-only corpus in the HEAD tree or the working directory.
    const corpus = probeSourceCorpus(repoRoot);
    if (corpus === null || typeof corpus !== "object" || typeof corpus.present !== "boolean") {
      return sourceSuite("oracle-error");
    }
    if (corpus.present) return sourceSuite("source-corpus-present");

    return { route: "consumer-na", expectedResult: FINAL_SUITE_RESULT_CONSUMER_NA, basis: "consumer-direct" };
  } catch {
    return sourceSuite("oracle-error");
  }
}

function toBytes(value) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function decodeStrictUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Cross-check the runner's output against the determined route (design D3).
 * Pure; returns `{ ok: true }` or `{ ok: false, reason }` with a closed token.
 */
export function checkFinalSuiteOutput({ route, stdout, stderr } = {}) {
  if (route !== "consumer-na" && route !== "source-suite") return { ok: false, reason: "invalid-route" };
  const stdoutBytes = toBytes(stdout);
  const stderrBytes = toBytes(stderr);
  if (stdoutBytes === null || stderrBytes === null) return { ok: false, reason: "output-malformed" };
  const stdoutText = decodeStrictUtf8(stdoutBytes);
  if (stdoutText === null) return { ok: false, reason: "stdout-not-utf8" };
  if (decodeStrictUtf8(stderrBytes) === null) return { ok: false, reason: "stderr-not-utf8" };

  if (route === "consumer-na") {
    // Byte-exact: the constant plus a single LF, nothing else.
    return stdoutBytes.equals(Buffer.from(`${CONSUMER_PROFILE_NA_LINE}\n`, "utf8"))
      ? { ok: true }
      : { ok: false, reason: "consumer-na-output-mismatch" };
  }

  // source-suite: the runner's N/A wording must never be accepted as authority.
  if (stdoutText.split(/\r\n|\n|\r/).some((line) => line.startsWith(SOURCE_MAINTAINER_NA_PREFIX))) {
    return { ok: false, reason: "source-route-reported-not-applicable" };
  }
  return { ok: true };
}
