/**
 * Executable contract for the shared bounded secret-pattern classifier
 * (design.md D8). Fixtures use only placeholder samples — no real secret
 * material — per proposal.md's PII/secret residual-risk note.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  findSecretHits,
  isValidSecretHitResult,
  SECRET_PATTERN_MAX_SCAN_BYTES,
} from "../lib/secret-pattern-contract.mjs";

function categoriesOf(text) {
  return findSecretHits(text).map((hit) => hit.category).sort();
}

test("D8: PEM private key header is detected", () => {
  const text = "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIExample\nafter";
  assert.deepEqual(categoriesOf(text), ["pem_private_key"]);
});

test("D8: GitHub token prefixes are detected (ghp_/gho_/ghu_/ghs_/ghr_)", () => {
  for (const prefix of ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]) {
    const token = `${prefix}${"a".repeat(36)}`;
    assert.deepEqual(categoriesOf(`token=${token}`), ["github_token"], prefix);
  }
});

test("D8: GitHub fine-grained PAT prefix is detected", () => {
  const token = `github_pat_${"A".repeat(22)}_${"b".repeat(59)}`;
  assert.deepEqual(categoriesOf(token), ["github_fine_grained_token"]);
});

test("D8: AWS access key id is detected", () => {
  const keyId = `AKIA${"Q".repeat(16)}`;
  assert.deepEqual(categoriesOf(`key: ${keyId}`), ["aws_access_key_id"]);
});

test("D8: Slack token is detected", () => {
  const token = "xoxb-1234567890-abcdefghijklmnop";
  assert.deepEqual(categoriesOf(token), ["slack_token"]);
});

test("D8: Authorization Bearer header is detected", () => {
  const header = `Authorization: Bearer ${"x".repeat(24)}`;
  assert.deepEqual(categoriesOf(header), ["authorization_bearer_header"]);
});

test("D8: AI provider API key prefixes are detected (sk-/sk-ant-/sk-proj-)", () => {
  for (const prefix of ["sk-", "sk-ant-", "sk-proj-"]) {
    const key = `${prefix}${"a1B2".repeat(6)}`;
    assert.deepEqual(categoriesOf(key), ["ai_provider_api_key"], prefix);
  }
});

test("D8: Google API key is detected", () => {
  const key = `AIza${"S".repeat(35)}`;
  assert.deepEqual(categoriesOf(key), ["google_api_key"]);
});

test("D8: three-segment JWT is detected", () => {
  const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U`;
  assert.deepEqual(categoriesOf(jwt), ["jwt"]);
});

test("D8: ordinary review prose does not false-positive", () => {
  const text = "This PR refactors the render pipeline and adds a unit test for the new branch; verdict PASS, no security-sensitive change.";
  assert.deepEqual(findSecretHits(text), []);
});

test("D8: every pattern source contains only upper-bounded quantifiers (no bare *, +, or open-ended {n,})", async () => {
  // Regression guard for the "量詞有上界" design requirement, checked over the
  // whole source string (not just quantifiers glued to a class) — a bare `+`
  // or `*` anywhere, or a `{n,}` with no upper bound, is disallowed. Bracket
  // expressions are stripped first so a literal `+`/`*` inside a character
  // class (e.g. the `+` in `[A-Za-z0-9._~+/=-]`) is not mistaken for a
  // quantifier.
  const mod = await import("../lib/secret-pattern-contract.mjs");
  const regexes = [
    mod.SECRET_PEM_PRIVATE_KEY_RE,
    mod.SECRET_GITHUB_TOKEN_RE,
    mod.SECRET_GITHUB_FINE_GRAINED_TOKEN_RE,
    mod.SECRET_AWS_ACCESS_KEY_ID_RE,
    mod.SECRET_SLACK_TOKEN_RE,
    mod.SECRET_AUTHORIZATION_BEARER_HEADER_RE,
    mod.SECRET_AI_PROVIDER_API_KEY_RE,
    mod.SECRET_GOOGLE_API_KEY_RE,
    mod.SECRET_JWT_RE,
  ];
  const stripCharacterClasses = (source) => source.replace(/\[(?:\\.|[^\]\\])*\]/g, "[]");
  const bareStarOrPlus = /[*+]/;
  const openEndedBound = /\{\d+,\}/;
  for (const re of regexes) {
    const stripped = stripCharacterClasses(re.source);
    assert.equal(
      bareStarOrPlus.test(stripped),
      false,
      `pattern must not use a bare * or + quantifier outside a character class: ${re.source}`,
    );
    assert.equal(
      openEndedBound.test(stripped),
      false,
      `pattern must not use an open-ended {n,} quantifier: ${re.source}`,
    );
  }
});

test("D8: findSecretHits result shape is exact {category, match} pairs", () => {
  const hits = findSecretHits(`AKIA${"Q".repeat(16)}`);
  assert.equal(isValidSecretHitResult(hits), true);
  assert.deepEqual(Object.keys(hits[0]).sort(), ["category", "match"]);
});

test("D8: non-string input degrades to no hits, never throws", () => {
  assert.deepEqual(findSecretHits(undefined), []);
  assert.deepEqual(findSecretHits(null), []);
  assert.deepEqual(findSecretHits(""), []);
});

test("D8: over-max-length strings are bounded, not unbounded-scanned", () => {
  const padding = "a".repeat(SECRET_PATTERN_MAX_SCAN_BYTES + 1000);
  const text = `${padding}AKIA${"Q".repeat(16)}`;
  // The token sits beyond the scan cap, so it is not found — proving the cap
  // is real (a linear scan bound), not merely documented.
  assert.deepEqual(categoriesOf(text), []);
});
