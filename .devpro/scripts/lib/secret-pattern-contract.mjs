/**
 * Pure executable bounded secret lexical contract (design.md D8).
 *
 * Frozen pattern set for the external packet scrub. Every source is a
 * bounded-quantifier regex (no unbounded `+`/`*` on a character class that
 * could backtrack catastrophically against adversarial input) so a linear
 * scan over a single string stays linear. Keep this leaf dependency-free so
 * every runtime adapter can import it, matching lib/pii-pattern-contract.mjs.
 *
 * This is a last-line-of-defense scrub, not an allowlist of every secret
 * shape that exists — unknown formats can still slip through (design.md
 * D14, a named residual risk). It is a pattern match, so it does not guarantee that no proprietary code is sent.
 */

const PEM_PRIVATE_KEY_SOURCE = String.raw`-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----`;
const GITHUB_TOKEN_SOURCE = String.raw`\bgh[pousr]_[A-Za-z0-9]{20,255}\b`;
const GITHUB_FINE_GRAINED_TOKEN_SOURCE = String.raw`\bgithub_pat_[A-Za-z0-9_]{20,255}\b`;
const AWS_ACCESS_KEY_ID_SOURCE = String.raw`\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[0-9A-Z]{16}\b`;
const SLACK_TOKEN_SOURCE = String.raw`\bxox[baprs]-[0-9A-Za-z-]{10,72}\b`;
// Bounded whitespace runs (not `\s*`/`\s+`): a header has at most a few
// spaces/tabs between tokens, and bounding it keeps every quantifier in this
// module upper-bounded, not just the wide classes.
const AUTHORIZATION_BEARER_HEADER_SOURCE = String.raw`\bAuthorization:[ \t]{0,8}Bearer[ \t]{1,8}[A-Za-z0-9._~+/=-]{10,2048}`;
const AI_PROVIDER_API_KEY_SOURCE = String.raw`\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{10,200}\b`;
const GOOGLE_API_KEY_SOURCE = String.raw`\bAIza[0-9A-Za-z_-]{35}\b`;
const JWT_SOURCE = String.raw`\beyJ[A-Za-z0-9_-]{5,1024}\.eyJ[A-Za-z0-9_-]{5,1024}\.[A-Za-z0-9_-]{5,1024}\b`;

export const SECRET_PEM_PRIVATE_KEY_RE = new RegExp(PEM_PRIVATE_KEY_SOURCE, "g");
export const SECRET_GITHUB_TOKEN_RE = new RegExp(GITHUB_TOKEN_SOURCE, "g");
export const SECRET_GITHUB_FINE_GRAINED_TOKEN_RE = new RegExp(GITHUB_FINE_GRAINED_TOKEN_SOURCE, "g");
export const SECRET_AWS_ACCESS_KEY_ID_RE = new RegExp(AWS_ACCESS_KEY_ID_SOURCE, "g");
export const SECRET_SLACK_TOKEN_RE = new RegExp(SLACK_TOKEN_SOURCE, "g");
export const SECRET_AUTHORIZATION_BEARER_HEADER_RE = new RegExp(AUTHORIZATION_BEARER_HEADER_SOURCE, "gi");
export const SECRET_AI_PROVIDER_API_KEY_RE = new RegExp(AI_PROVIDER_API_KEY_SOURCE, "g");
export const SECRET_GOOGLE_API_KEY_RE = new RegExp(GOOGLE_API_KEY_SOURCE, "g");
export const SECRET_JWT_RE = new RegExp(JWT_SOURCE, "g");

// Category id -> [source, flags]. A single string longer than this is not
// linearly scanned by any of the sources above (defense in depth alongside
// the bounded quantifiers themselves).
export const SECRET_PATTERN_MAX_SCAN_BYTES = 262_144;

const PATTERN_SOURCES = Object.freeze({
  pem_private_key: [PEM_PRIVATE_KEY_SOURCE, "g"],
  github_token: [GITHUB_TOKEN_SOURCE, "g"],
  github_fine_grained_token: [GITHUB_FINE_GRAINED_TOKEN_SOURCE, "g"],
  aws_access_key_id: [AWS_ACCESS_KEY_ID_SOURCE, "g"],
  slack_token: [SLACK_TOKEN_SOURCE, "g"],
  authorization_bearer_header: [AUTHORIZATION_BEARER_HEADER_SOURCE, "gi"],
  ai_provider_api_key: [AI_PROVIDER_API_KEY_SOURCE, "g"],
  google_api_key: [GOOGLE_API_KEY_SOURCE, "g"],
  jwt: [JWT_SOURCE, "g"],
});

const VALID_CATEGORIES = new Set(Object.keys(PATTERN_SOURCES));

export function isValidSecretHitResult(value) {
  if (!Array.isArray(value)) return false;
  return value.every((hit) => {
    if (!hit || typeof hit !== "object" || Array.isArray(hit)) return false;
    if (Object.getPrototypeOf(hit) !== Object.prototype) return false;
    if (Object.keys(hit).sort().join("\0") !== "category\0match") return false;
    if (typeof hit.match !== "string" || hit.match.length === 0) return false;
    return VALID_CATEGORIES.has(hit.category);
  });
}

/**
 * Return bounded secret hits for a single string. Never throws on adversarial
 * input; each source scan is capped by SECRET_PATTERN_MAX_SCAN_BYTES so a
 * caller scanning many small leaves cannot be forced into a large linear
 * scan by a single oversized string (the caller truncation is a hint, not a
 * silent skip: an over-max string still gets scanned up to the cap).
 */
export function findSecretHits(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const bounded = text.length > SECRET_PATTERN_MAX_SCAN_BYTES
    ? text.slice(0, SECRET_PATTERN_MAX_SCAN_BYTES)
    : text;
  const hits = [];
  for (const [category, [source, flags]] of Object.entries(PATTERN_SOURCES)) {
    const matcher = new RegExp(source, flags);
    for (const match of bounded.matchAll(matcher)) {
      hits.push({ category, match: match[0] });
    }
  }
  if (!isValidSecretHitResult(hits)) {
    throw new Error("secret classifier produced an invalid bounded result");
  }
  return hits;
}
