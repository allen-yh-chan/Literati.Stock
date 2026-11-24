import { createHash } from "node:crypto";

// One repository key for every obligation marker a hook stores (fix-cross-repo-state-keys).
//
// A hub session can work on two repositories that both have a PR #5 or a branch of the same name, so a marker is keyed
// by the repository and the PR (or branch), never by the number or the branch alone. The key is the lowercase
// `HOST/OWNER/REPO` of a github.com repository; the hooks read and write github.com repositories only, so any other
// host gives no key and the caller treats the marker's repository as unknown.

// An owner or repository is never `.` or `..` (a path component, #3704 r5 F3) and never starts with `-`; a repository
// never ends in `.git` (the clone URL's suffix, not the name). Anything else gives no key, so its marker is unknown.
const SEGMENT = "(?!\\.\\.?(?:/|$))(?!-)[A-Za-z0-9_.-]+";
const KEY_RE = new RegExp(`^github\\.com/${SEGMENT}/(?![A-Za-z0-9_.-]*\\.git$)${SEGMENT}$`);

// The key of a github.com repository ({ host, slug } as the repository readers return it), or "" for anything else.
export function repoKey(host, slug) {
  const key = `${String(host ?? "").toLowerCase()}/${String(slug ?? "").toLowerCase()}`;
  return KEY_RE.test(key) ? key : "";
}

// Whether `value` is a key repoKey would return.
export function isRepoKey(value) {
  return typeof value === "string" && KEY_RE.test(value) && value === value.toLowerCase();
}

// The file-name form of a key: `/` becomes `+`, which no host, owner or repository name holds, so two keys never share
// a token.
export function repoKeyToken(key) {
  return isRepoKey(key) ? key.replace(/\//g, "+") : "";
}

// State authorities also append a branch digest and lock suffix. Use a fixed-size repository token.
export function repoStateToken(value) {
  const key = repoName(value);
  return key ? createHash("sha256").update(key).digest("hex") : "";
}

// The key of the github.com repository a value names, `OWNER/REPO` or `github.com/OWNER/REPO`, or "" for anything else:
// another host, or a host with a port or userinfo (`user:secret@github.com`), names no key (fix-post-pr-state-repo-keys).
export function repoName(value) {
  const parts = String(value ?? "").trim().split("/");
  if (parts.length === 2) return repoKey("github.com", parts.join("/"));
  return parts.length === 3 ? repoKey(parts[0], `${parts[1]}/${parts[2]}`) : "";
}

// The `HOST/OWNER/REPO` of a pull request URL, or "".
export function prUrlRepo(url) {
  const m = matchPrUrl(url);
  return m ? `${m[1].toLowerCase()}/${m[2]}/${m[3]}` : "";
}

export function prUrlNumber(url) {
  return matchPrUrl(url)?.[4] || "";
}

function matchPrUrl(url) {
  return /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]|$)/i.exec(String(url ?? "").trim());
}
