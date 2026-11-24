// Gate 4 writes these markers. The workflow query and Stop hook use the same
// storage and parser. An unreadable marker has no proven target and only expires.
//
// A marker is in one of three states: it records its repository (`repo`); it records that the writer could not prove one
// (`repo_unknown: true`, #3704 r2 F2): the Stop hook still reminds it, nothing clears it, and it expires; or, written by
// an earlier release, it records neither and belongs to the repository of the session checkout (PR #3703 r10).

import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isRepoKey, repoKeyToken } from "./repo-key.mjs";
import { defaultRepoStateDir } from "./repo-state-identity.mjs";

const PR_NUMBER_RE = /^[1-9]\d{0,8}$/;

export function postmergeStateDir(cwd = process.cwd()) {
  return process.env.DEVPRO_POSTMERGE_STATE_DIR || defaultRepoStateDir("devpro-postmerge-state", cwd);
}

function removeIfPresent(file) {
  try { unlinkSync(file); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

// Only the short filesystem mutation is locked. Unique contender names let
// concurrent callers remove a dead owner's lock without touching a new owner.
function withMarkerMutation(file, mutate) {
  const dir = path.dirname(file);
  const key = createHash("sha256").update(path.basename(file)).digest("hex");
  const prefix = `.postmerge-${key}.lock-`;
  const owner = `${prefix}${process.pid}-${randomUUID()}`;
  const lock = path.join(dir, owner);
  const wait = new Int32Array(new SharedArrayBuffer(4));
  function busy(except) {
    for (const name of readdirSync(dir)) {
      if (name === except || !name.startsWith(prefix)) continue;
      const pid = /^([1-9]\d*)-[a-f0-9-]{36}$/.exec(name.slice(prefix.length))?.[1];
      if (!pid) continue;
      try { process.kill(Number(pid), 0); }
      catch (error) {
        if (error.code !== "ESRCH") return true;
        removeIfPresent(path.join(dir, name));
        continue;
      }
      return true;
    }
    return false;
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!busy()) {
      writeFileSync(lock, "", { flag: "wx", mode: 0o600 });
      try { if (!busy(owner)) return mutate(); }
      finally { removeIfPresent(lock); }
    }
    Atomics.wait(wait, 0, 0, 15);
  }
  throw new Error("post-merge marker is busy");
}

export function writePostmergeMarkerFile(file, text) {
  withMarkerMutation(file, () => {
    const candidate = path.join(path.dirname(file), `.postmerge-${randomUUID()}.tmp`);
    try {
      writeFileSync(candidate, text, { flag: "wx", mode: 0o600 });
      renameSync(candidate, file);
    } finally {
      removeIfPresent(candidate);
    }
  });
}

export function readPostmergeMarkerSnapshot(file) {
  try {
    const stat = lstatSync(file, { bigint: true });
    if (!stat.isFile()) return null;
    const text = readFileSync(file, "utf8");
    const after = lstatSync(file, { bigint: true });
    if (stat.ino !== after.ino || stat.dev !== after.dev || stat.ctimeNs !== after.ctimeNs) return null;
    return { file, text, stat };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function clearPostmergeMarkerSnapshot(snapshot) {
  return withMarkerMutation(snapshot.file, () => {
    const current = readPostmergeMarkerSnapshot(snapshot.file);
    if (!current || current.text !== snapshot.text || current.stat.ino !== snapshot.stat.ino ||
        current.stat.dev !== snapshot.stat.dev || current.stat.ctimeNs !== snapshot.stat.ctimeNs) return false;
    unlinkSync(snapshot.file);
    return true;
  });
}

export function expirePostmergeMarker(file, cutoff) {
  withMarkerMutation(file, () => {
    try {
      if (lstatSync(file).mtimeMs < cutoff) unlinkSync(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  });
}

// "push" / "merge" for a marker file name, else "".
export function postmergeMarkerKind(fileName) {
  return /\.(push|merge)$/.exec(String(fileName ?? ""))?.[1] ?? "";
}

// The file name of a marker. A merge of a known repository and PR is named after both; any other marker is named after
// its repository token (or `unknown` without one) and a digest of the repository and the branch, so two repositories, or
// two branches that differ only in characters a file name cannot hold, never share a name, and the length stays bounded
// whatever the branch. "" when the marker has neither a PR nor a branch to be named by.
export function postmergeMarkerName(kind, { branch = "", repo = "", prNumber = "" } = {}) {
  const token = repoKeyToken(repo);
  if (token && kind === "merge" && PR_NUMBER_RE.test(String(prNumber))) return `${token}#${prNumber}.merge`;
  if (!branch) return "";
  const digest = createHash("sha256").update(`${repo}\n${branch}`).digest("hex").slice(0, 32);
  return `${token || "unknown"}__${digest}.${kind}`;
}

// The marker in `text` (the content of the file `fileName`), or null when it is not a marker of the kind its file name
// says: not a JSON object, another kind, no branch (a merge of a known repository and PR may lack one: its head branch
// was not reported), a `repo` that is not a lowercase github.com repository key, or both a `repo` and `repo_unknown`.
export function parsePostmergeMarker(text, fileName) {
  const fileKind = postmergeMarkerKind(fileName);
  if (!fileKind) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const kind = String(parsed.kind || "").trim();
  const branch = String(parsed.branch || parsed.headRefName || "").trim();
  const prNumber = String(parsed.prNumber || "").trim();
  // The writer records a key as repoKey returns it, lowercase; any other spelling is not a marker it wrote (#3704 r6 F6).
  let repo = "";
  if (parsed.repo !== undefined) {
    if (!isRepoKey(parsed.repo)) return null;
    repo = parsed.repo;
  }
  const repoUnknown = parsed.repo_unknown === true;
  if (parsed.repo_unknown !== undefined && (!repoUnknown || parsed.repo !== undefined)) return null;
  if (kind !== fileKind) return null;
  if (!branch && !(kind === "merge" && repo && PR_NUMBER_RE.test(prNumber))) return null;
  return {
    branch,
    headRefName: String(parsed.headRefName || branch).trim(),
    baseRefName: String(parsed.baseRefName || "").trim(),
    kind,
    prNumber,
    repo,
    repoUnknown,
    sessionId: String(parsed.sessionId || "").trim(),
  };
}
