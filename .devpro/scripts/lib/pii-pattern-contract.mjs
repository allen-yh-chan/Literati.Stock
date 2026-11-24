/**
 * Pure executable PII lexical contract shared by Gate P and clarification.
 * Keep this leaf dependency-free so every runtime adapter can import it.
 */

const EMAIL_SOURCE = String.raw`\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b`;
const EMAIL_ALLOW_SOURCE = String.raw`@(?:example\.(?:com|org|net)|anthropic\.com)$`;
const UNIX_USERS_SOURCE = String.raw`\/Users\/[A-Za-z]`;
const UNIX_HOME_SOURCE = String.raw`\/home\/[A-Za-z]`;
const WINDOWS_USERS_SOURCE = String.raw`[A-Za-z]:[\\/]Users[\\/][A-Za-z]`;

export const PII_EMAIL_RE = new RegExp(EMAIL_SOURCE, "g");
export const PII_EMAIL_ALLOW_RE = new RegExp(EMAIL_ALLOW_SOURCE, "i");
export const PII_UNIX_USERS_RE = new RegExp(UNIX_USERS_SOURCE, "g");
export const PII_UNIX_HOME_RE = new RegExp(UNIX_HOME_SOURCE, "g");
export const PII_WINDOWS_USERS_RE = new RegExp(WINDOWS_USERS_SOURCE, "gi");

export const PLACEHOLDER_BY_TYPE = Object.freeze({
  email: "<user-email>",
  "unix-users-path": "<repo-root-abs>/... or /Users/<name>/...",
  "unix-home-path": "/home/<user>/...",
  "windows-users-path": String.raw`C:\Users\<name>\...`,
});

const VALID_TYPES = new Set(Object.keys(PLACEHOLDER_BY_TYPE));

function candidate(type, match) {
  return {
    start: match.index,
    end: match.index + match[0].length,
    hit: {
      type,
      match: match[0],
      placeholder: PLACEHOLDER_BY_TYPE[type],
    },
  };
}

function collect(text, source, flags, type) {
  const matcher = new RegExp(source, flags);
  return [...text.matchAll(matcher)].map((match) => candidate(type, match));
}

function overlaps(left, right) {
  return left.start < right.end && right.start < left.end;
}

export function isValidHitResult(value) {
  if (!Array.isArray(value)) return false;
  return value.every((hit) => {
    if (!hit || typeof hit !== "object" || Array.isArray(hit)) return false;
    if (Object.getPrototypeOf(hit) !== Object.prototype) return false;
    if (Object.keys(hit).sort().join("\0") !== "match\0placeholder\0type") return false;
    for (const key of ["type", "match", "placeholder"]) {
      if (!Object.prototype.propertyIsEnumerable.call(hit, key)) return false;
      if (typeof hit[key] !== "string" || hit[key].length === 0) return false;
    }
    return VALID_TYPES.has(hit.type) && PLACEHOLDER_BY_TYPE[hit.type] === hit.placeholder;
  });
}

/**
 * Return bounded presentation hits. Candidate spans are exact half-open
 * intervals; a Windows profile candidate owns every overlapping `/Users/`
 * candidate so one lexical occurrence is never double classified.
 */
export function findPIIHits(text) {
  if (typeof text !== "string" || text.length === 0) return [];

  const emailAllow = new RegExp(EMAIL_ALLOW_SOURCE, "i");
  const emails = collect(text, EMAIL_SOURCE, "g", "email")
    .filter(({ hit }) => !emailAllow.test(hit.match));
  const windows = collect(
    text,
    WINDOWS_USERS_SOURCE,
    "gi",
    "windows-users-path",
  );
  const unixUsers = collect(text, UNIX_USERS_SOURCE, "g", "unix-users-path")
    .filter((unixCandidate) => !windows.some((windowsCandidate) =>
      overlaps(unixCandidate, windowsCandidate)
    ));
  const unixHome = collect(text, UNIX_HOME_SOURCE, "g", "unix-home-path");

  const hits = [
    ...emails,
    ...unixUsers,
    ...unixHome,
    ...windows,
  ].map(({ hit }) => hit);

  if (!isValidHitResult(hits)) {
    throw new Error("PII classifier produced an invalid bounded result");
  }
  return hits;
}
