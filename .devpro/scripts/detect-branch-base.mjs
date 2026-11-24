#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { VTAG_RE, PRODUCTION_DATE_RE, RULES_TAG_RE } from "./hooks/lib/tag-shapes.mjs";

const isMain = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);

const MODE = isMain ? process.argv[2] : undefined;
const ARGS = isMain ? process.argv.slice(3) : [];

const EXACT_REF_MODES = new Set(["--require-main-ancestor", "--reconciliation-status"]);

const runGitArgv = (args) =>
  spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const gitArgvSafe = (args) => {
  const result = runGitArgv(args);
  if (result.status !== 0) return "";
  return (result.stdout ?? "").trim();
};

const gitArgvOk = (args) => runGitArgv(args).status === 0;

function parseExactRefOptions(args) {
  const optionNames = new Set(["--production-ref", "--main-ref"]);
  const values = new Map();

  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    if (!optionNames.has(option)) {
      throw new Error(`Unknown option for exact-ref mode: ${JSON.stringify(option)}`);
    }
    if (values.has(option)) {
      throw new Error(`Duplicate option for exact-ref mode: ${option}`);
    }
    const value = args[index + 1];
    if (value === undefined || optionNames.has(value)) {
      throw new Error(`Missing value for exact-ref option: ${option}`);
    }
    values.set(option, value);
  }

  for (const option of optionNames) {
    if (!values.has(option)) {
      throw new Error(`Missing required exact-ref option: ${option}`);
    }
  }

  return {
    productionRef: values.get("--production-ref"),
    mainRef: values.get("--main-ref"),
  };
}

const RAW_OID_RE = /^[0-9a-f]{40,64}$/i;
const RELEASE_REF_FORMAT = "--format=%(refname:short)";

function stripOuterShellQuotes(value) {
  let normalized = value.trim();
  while (normalized.length >= 2) {
    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      normalized = normalized.slice(1, -1).trim();
      continue;
    }
    break;
  }
  return normalized;
}

export function normalizeReleaseBranchRecord(value, { remote = false } = {}) {
  const ref = stripOuterShellQuotes(value);
  if (!ref) return null;

  if (remote) {
    const shortRef = ref.replace(/^refs\/remotes\//, "");
    if (!shortRef.startsWith("origin/release/")) return null;
    return {
      name: shortRef.replace(/^origin\//, ""),
      ref: shortRef,
    };
  }

  const shortRef = ref.replace(/^refs\/heads\//, "");
  if (!shortRef.startsWith("release/")) return null;
  return {
    name: shortRef,
    ref: shortRef,
  };
}

function resolveCommitish(ref) {
  const result = runGitArgv([
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  const sha = result.stdout?.trim() ?? "";
  if (result.status !== 0 || !RAW_OID_RE.test(sha)) {
    return null;
  }
  return sha;
}

function exactRefExists(ref) {
  return runGitArgv(["show-ref", "--verify", "--quiet", ref]).status === 0;
}

function resolveExactCommit(ref) {
  if (RAW_OID_RE.test(ref)) {
    return resolveCommitish(ref);
  }

  if (ref.startsWith("refs/")) {
    return exactRefExists(ref) ? resolveCommitish(ref) : null;
  }

  const candidateRefs = [
    ref,
    `refs/${ref}`,
    `refs/tags/${ref}`,
    `refs/heads/${ref}`,
    `refs/remotes/${ref}`,
    `refs/remotes/${ref}/HEAD`,
  ].filter((candidate, index, candidates) => candidates.indexOf(candidate) === index);
  const matches = candidateRefs.filter(exactRefExists);

  if (matches.length > 1) {
    return null;
  }
  if (matches.length === 1) {
    return resolveCommitish(matches[0]);
  }

  return resolveCommitish(ref);
}

function mainAncestryStatus(productionSha, mainSha) {
  const result = runGitArgv(["merge-base", "--is-ancestor", productionSha, mainSha]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

// Exit only after stdout has drained: a piped stdout is asynchronous on some platforms, and
// process.exit() right after console.log drops what the pipe has not accepted yet (a 64 KiB cut).
// A reader that closes early (`| head`) raises EPIPE; that still exits with the original code, as before.
async function writeJsonAndExit(value, exitCode = 0) {
  process.stdout.on("error", error => {
    if (error?.code !== "EPIPE") throw error;
    process.exit(exitCode);
  });
  await new Promise(resolve => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`, resolve));
  process.exit(exitCode);
}

function writeExactRefResult(result, exitCode) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(exitCode);
}

function runExactRefMode(mode, args) {
  let refs;
  try {
    refs = parseExactRefOptions(args);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const productionSha = resolveExactCommit(refs.productionRef);
  const mainSha = resolveExactCommit(refs.mainRef);
  if (!productionSha || !mainSha) {
    console.error("Exact production/main refs must each resolve uniquely to a commit.");
    writeExactRefResult(
      {
        ...refs,
        isMainAncestor: null,
        classification: "invalid-ref",
      },
      1,
    );
  }

  const isMainAncestor = mainAncestryStatus(productionSha, mainSha);
  if (mode === "--require-main-ancestor") {
    const classification =
      isMainAncestor === true
        ? "main-ancestor-confirmed"
        : isMainAncestor === false
          ? "reconciliation-required"
          : "ancestry-undetermined";
    writeExactRefResult(
      {
        ...refs,
        productionSha,
        mainSha,
        isMainAncestor,
        classification,
      },
      isMainAncestor === true ? 0 : 1,
    );
  }

  if (isMainAncestor === true) {
    writeExactRefResult(
      {
        ...refs,
        productionSha,
        mainSha,
        isMainAncestor,
        classification: "main-ancestor-confirmed",
        reconciliationRequired: false,
        recommendedRoute: "no-op",
        resultingTree: null,
        mainTree: null,
      },
      0,
    );
  }

  if (isMainAncestor === null) {
    writeExactRefResult(
      {
        ...refs,
        productionSha,
        mainSha,
        isMainAncestor,
        classification: "ancestry-undetermined",
        reconciliationRequired: null,
        recommendedRoute: "fail-closed",
        resultingTree: null,
        mainTree: null,
      },
      1,
    );
  }

  const mergeTree = runGitArgv(["merge-tree", "--write-tree", mainSha, productionSha]);
  const resultingTree = mergeTree.status === 0 ? mergeTree.stdout.trim().split("\n")[0] : "";
  const mainTreeResult = runGitArgv([
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${mainSha}^{tree}`,
  ]);
  const mainTree = mainTreeResult.status === 0 ? mainTreeResult.stdout.trim() : "";
  const graphOnly =
    mergeTree.status === 0 &&
    /^[0-9a-f]{40,64}$/i.test(resultingTree) &&
    /^[0-9a-f]{40,64}$/i.test(mainTree) &&
    resultingTree === mainTree;
  const classification = graphOnly ? "graph-only" : "content-review-required";

  writeExactRefResult(
    {
      ...refs,
      productionSha,
      mainSha,
      isMainAncestor,
      classification,
      reconciliationRequired: true,
      recommendedRoute: graphOnly ? "release-lane-back-merge" : "production-ancestry-repair",
      resultingTree: resultingTree || null,
      mainTree: mainTree || null,
    },
    0,
  );
}

if (isMain && EXACT_REF_MODES.has(MODE)) {
  runExactRefMode(MODE, ARGS);
}

function parseRulesTag(tag) {
  const match = tag.match(RULES_TAG_RE);
  if (!match) return null;
  return {
    date: match[1],
    ordinal: match[2] ? Number(match[2]) : 1,
  };
}

function parseDateTag(tag) {
  const match = tag.match(PRODUCTION_DATE_RE);
  if (!match) return null;
  return {
    date: match[1],
    ordinal: match[2] ? Number(match[2]) : 1,
  };
}

/**
 * Extract YYYYMMDD date string from a production-* tag.
 * - production-YYYYMMDD-rules[-n] → returns YYYYMMDD from tag name
 * - production-YYYYMMDD[-n] → returns YYYYMMDD from tag name (consumer subset release per release-sit-uat-pat-prod.md Step 6)
 * - production-vX.Y.Z → returns YYYYMMDD from tag's committer date
 *   (git log -1 --format=%ci <tag>; per Q2, avoid git for-each-ref --sort=-creatordate)
 *
 * Returns null if extraction fails.
 *
 * @param {string} tag
 * @returns {string|null} 8-digit YYYYMMDD or null
 */
export function extractTagDate(tag) {
  // production-YYYYMMDD-rules[-n]
  const rulesTag = parseRulesTag(tag);
  if (rulesTag) return rulesTag.date;
  // production-YYYYMMDD[-n] (consumer subset release per release-sit-uat-pat-prod.md Step 6)
  const dateTag = parseDateTag(tag);
  if (dateTag) return dateTag.date;
  // production-vX.Y.Z → git log committer date
  const semverMatch = tag.match(/^production-v\d+\.\d+\.\d+$/);
  if (semverMatch) {
    const ci = gitArgvSafe(["log", "-1", "--format=%ci", tag]);
    // %ci = "YYYY-MM-DD HH:MM:SS +TZ"
    const dateMatch = ci.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (dateMatch) return `${dateMatch[1]}${dateMatch[2]}${dateMatch[3]}`;
  }
  return null;
}

/**
 * Compare two production-* tags for sorting (ascending, oldest first).
 *
 * Two-phase strategy:
 *   1. v-tag vs v-tag: SemVer tuple comparison (avoids same-day ordering bug
 *      when ≥2 v-tags share the same commit date, e.g. 10 tags on 2026-04-26).
 *   2. mixed or rules-rules: YYYYMMDD date comparison (extracted from tag name
 *      or git log committer date).
 *
 * Tags with no extractable date sort before dated tags; among themselves lexically.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareTags(a, b) {
  const va = a.match(VTAG_RE);
  const vb = b.match(VTAG_RE);
  const ra = parseRulesTag(a);
  const rb = parseRulesTag(b);
  const dta = parseDateTag(a);
  const dtb = parseDateTag(b);
  // v vs v: SemVer tuple (numeric, not lexical)
  if (va && vb) {
    for (let i = 1; i <= 3; i++) {
      if (+va[i] !== +vb[i]) return +va[i] - +vb[i];
    }
    return 0;
  }
  // rules vs rules: date first, then same-day release ordinal (unsuffixed = 1)
  if (ra && rb) {
    if (ra.date !== rb.date) return ra.date < rb.date ? -1 : 1;
    return ra.ordinal - rb.ordinal;
  }
  // date-tag vs date-tag: date first, then ordinal tiebreaker (mirrors rules pattern)
  if (dta && dtb) {
    if (dta.date !== dtb.date) return dta.date < dtb.date ? -1 : 1;
    return dta.ordinal - dtb.ordinal;
  }
  // mixed date-tag vs rules-tag same date → rules sorts first
  // (per release-sit-uat-pat-prod.md: rules sync 通常先於 prod cut on same day)
  if (dta && rb && dta.date === rb.date) return 1;   // a is date-tag → a after b (rules)
  if (ra && dtb && ra.date === dtb.date) return -1;  // a is rules-tag → a before b
  // mixed or rules-rules: fall back to YYYYMMDD
  const da = extractTagDate(a);
  const db = extractTagDate(b);
  if (da && db && da !== db) return da < db ? -1 : 1;
  if (da && !db) return 1;
  if (!da && db) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sort production-* tags oldest-first.
 *
 * v-tag pairs use SemVer tuple ordering to correctly handle same-day multi-tag
 * scenarios (Critical 1 fix). Cross-format and rules-rules pairs use YYYYMMDD.
 *
 * @param {string[]} tags
 * @returns {string[]}
 */
export function sortProductionTags(tags) {
  return [...tags].sort(compareTags);
}

const productionTags = () =>
  sortProductionTags(
    gitArgvSafe(["tag", "-l", "production-*"])
      .split("\n")
      .filter(Boolean)
  );

const releaseBranches = () => {
  const local = gitArgvSafe(["for-each-ref", RELEASE_REF_FORMAT, "refs/heads/release/"]);
  const remote = gitArgvSafe(["for-each-ref", RELEASE_REF_FORMAT, "refs/remotes/origin/release/"]);
  // Key by release name (no origin/ prefix) so sorting picks the newest version;
  // value is the ref form that actually resolves (prefer local, else remote tracking).
  const resolved = new Map();
  for (const r of remote.split("\n").filter(Boolean)) {
    const candidate = normalizeReleaseBranchRecord(r, { remote: true });
    if (candidate) resolved.set(candidate.name, candidate.ref);
  }
  for (const l of local.split("\n").filter(Boolean)) {
    const candidate = normalizeReleaseBranchRecord(l);
    if (candidate) resolved.set(candidate.name, candidate.ref);
  }
  return [...resolved.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, ref]) => ({ name, ref }));
};

const resolveMainRef = () => gitArgvOk(["rev-parse", "--verify", "main"]) ? "main" :
                         (gitArgvOk(["rev-parse", "--verify", "origin/main"]) ? "origin/main" : null);

const anchorMainAncestry = (sha) => {
  const mainRef = resolveMainRef();
  if (!mainRef || !sha) return {};
  return {
    mainRef,
    isMainAncestor: gitArgvOk(["merge-base", "--is-ancestor", sha, mainRef]),
  };
};

const hasContentDiff = (baseRef, headRef) => {
  const result = runGitArgv(["diff", "--quiet", baseRef, headRef]);
  // `git diff --quiet` exits 1 for real diffs. Other failures should fail open
  // so agents still see the main-tip warning instead of silently skipping it.
  return result.status !== 0;
};

const mainAheadCommits = (latest) => {
  const mainRef = resolveMainRef();
  if (!mainRef) return [];
  if (!hasContentDiff(latest, mainRef)) return [];
  const SEP = "\x1F"; // ASCII unit separator
  const RECSEP = "\x1E"; // ASCII record separator
  const log = gitArgvSafe([
    "log",
    `${latest}..${mainRef}`,
    "--reverse",
    `--pretty=format:%H${SEP}%s${RECSEP}`,
  ]);
  if (!log) return [];
  return log.split(RECSEP).map(r => r.trim()).filter(Boolean).map(rec => {
    const [sha, subject] = rec.split(SEP);
    return { sha, subject };
  });
};

const isStrictAncestor = (ancestorSha, descendantSha) => {
  // Strict = different commits AND merge-base --is-ancestor holds. Reflexive
  // (same sha) is excluded so a tag is never treated as its own ancestor.
  if (!ancestorSha || !descendantSha || ancestorSha === descendantSha) return false;
  return gitArgvOk(["merge-base", "--is-ancestor", ancestorSha, descendantSha]);
};

/**
 * issue #1628 topology guard. `sortProductionTags` orders tags by naming
 * convention only (coarse); that convention assumes a same-day plain date-tag
 * is newer than the same-day `-rules` tag. When that assumption is wrong — the
 * naming-latest tag points at a commit that is a strict ANCESTOR of another
 * candidate tag's commit — the naming-latest is not the real production tip.
 *
 * Post-check: if the naming-latest is a strict ancestor of one or more other
 * candidate tags, re-pick from that descendant set the topological tip (the one
 * no other set member descends past). A parallel fork (two descendants, neither
 * an ancestor of the other) is ambiguous → FAIL CLOSED to the naming-order-last
 * descendant (preserves the existing coarse ordering rather than guessing).
 * When the naming-latest has no descendant among the candidates (the normal
 * case, v-tag-only, or a single candidate) this is a no-op and returns it.
 *
 * @param {string[]} tags sorted oldest-first by sortProductionTags
 * @returns {string} the tag whose commit is the real production tip
 */
const topologyLatestTag = (tags) => {
  const namingLatest = tags[tags.length - 1];
  const latestSha = gitArgvSafe(["rev-list", "-n", "1", namingLatest]);
  if (!latestSha) return namingLatest;

  // Candidates the naming-latest is a strict ancestor of (real descendants).
  const descendants = [];
  for (const tag of tags) {
    if (tag === namingLatest) continue;
    const sha = gitArgvSafe(["rev-list", "-n", "1", tag]);
    if (isStrictAncestor(latestSha, sha)) descendants.push({ tag, sha });
  }
  if (descendants.length === 0) return namingLatest; // no-op: naming order stands

  // Pick the descendant no other descendant descends past (the topological tip).
  const tips = descendants.filter(
    (d) => !descendants.some((o) => o !== d && isStrictAncestor(d.sha, o.sha))
  );
  if (tips.length === 1) return tips[0].tag;
  // Parallel fork (multiple incomparable tips) → fail closed to naming-order-last
  // among the descendants (they already sit after namingLatest in naming order).
  for (let i = tags.length - 1; i >= 0; i--) {
    if (tips.some((t) => t.tag === tags[i])) return tags[i];
  }
  return namingLatest;
};

/** D2-style read-only export for `add-change-cost-circuit-breaker` task 5:
 * the meter-reset advisory needs the current anchor `.sha` freshly computed
 * on every `--budget-check` call (never a cached/checkpoint-stored value —
 * see `design.md` F-3-3). Safe to import: this function and everything it
 * calls (`gitArgvSafe`/`gitArgvOk`/`runGitArgv`) read `process.cwd()`
 * implicitly and have no top-level side effects gated behind `isMain`. */
export const resolveAnchor = () => {
  const tags = productionTags();
  if (tags.length > 0) {
    const latest = topologyLatestTag(tags);
    const sha = gitArgvSafe(["rev-list", "-n", "1", latest]);
    return { source: "production-tag", ref: latest, sha, ...anchorMainAncestry(sha), mainAheadCommits: mainAheadCommits(latest) };
  }
  const releases = releaseBranches();
  if (releases.length > 0) {
    const latest = releases[releases.length - 1];
    const mainRef = resolveMainRef();
    const sha = mainRef ? gitArgvSafe(["merge-base", latest.ref, mainRef]) : "";
    if (RAW_OID_RE.test(sha)) {
      return { source: "release-branch-base", ref: latest.name, sha, ...anchorMainAncestry(sha) };
    }
  }
  const sha = gitArgvSafe(["rev-parse", "main"]) ||
              gitArgvSafe(["rev-parse", "origin/main"]) ||
              gitArgvSafe(["rev-parse", "HEAD"]);
  return { source: "main", ref: "main", sha, ...anchorMainAncestry(sha) };
};

const parseLimit = (defaultLimit = 50) => {
  const idx = ARGS.indexOf("--limit");
  if (idx === -1) return defaultLimit;
  const value = ARGS[idx + 1];
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`Invalid --limit value: ${JSON.stringify(value)}. Must be a positive integer.`);
    process.exit(1);
  }
  return n;
};

if (isMain && MODE === "--main-tip") {
  const limit = parseLimit(50);
  const mainRef = resolveMainRef();
  if (!mainRef) {
    await writeJsonAndExit({ commits: [], totalCount: 0, truncated: false, limit }, 0);
  }
  const tags = productionTags();
  if (tags.length === 0) {
    await writeJsonAndExit({ commits: [], totalCount: 0, truncated: false, limit }, 0);
  }
  const latest = topologyLatestTag(tags);
  if (!hasContentDiff(latest, mainRef)) {
    await writeJsonAndExit({ commits: [], totalCount: 0, truncated: false, limit }, 0);
  }
  const SEP = "\x1F";
  const RECSEP = "\x1E";
  const log = gitArgvSafe([
    "log",
    `${latest}..${mainRef}`,
    "--reverse",
    `--pretty=format:%H${SEP}%s${SEP}%aI${RECSEP}`,
  ]);
  if (!log) {
    await writeJsonAndExit({ commits: [], totalCount: 0, truncated: false, limit }, 0);
  }
  const allCommits = log.split(RECSEP).map(r => r.trim()).filter(Boolean).map(rec => {
    const [sha, subject, authorDate] = rec.split(SEP);
    const filesTouched = gitArgvSafe([
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      sha,
    ]).split("\n").filter(Boolean);
    return { sha, subject, authorDate, filesTouched };
  });
  const totalCount = allCommits.length;
  const truncated = totalCount > limit;
  const commits = truncated ? allCommits.slice(-limit) : allCommits;
  await writeJsonAndExit({ commits, totalCount, truncated, limit }, 0);
}

if (isMain && MODE === "--anchor") {
  const a = resolveAnchor();
  await writeJsonAndExit(a, 0);
}

const touchDivergenceFiles = isMain && MODE === "--touch-divergence"
  ? ARGS.filter(a => !a.startsWith("--"))
  : [];
if (touchDivergenceFiles.length > 0) {
  const files = touchDivergenceFiles;
  const anchor = resolveAnchor();
  const anchorSha = anchor.sha;
  // 規則 body 契約是對 origin/main 比對；若 ref 不可解析（未 fetch / 純本地 repo），
  // 不可靜默回 all-clean（false-negative），必須報錯讓呼叫者知道「無法比較」而非「乾淨」。
  const mainRef = gitArgvOk(["rev-parse", "--verify", "origin/main"]) ? "origin/main" : null;
  if (!mainRef) {
    console.error("touch-divergence：origin/main 無法解析（請先 git fetch origin main）；無法判斷分歧，拒絕回報 all-clean。");
    process.exit(1);
  }
  // argv 形式（spawnSync 不經 shell），避免 file 含 ; / $() 等被 shell 評估。
  const fileResults = files.map(file => {
    const r = spawnSync("git", ["diff", `${anchorSha}..${mainRef}`, "--", file], { encoding: "utf8" });
    const diffOutput = r.status === 0 ? r.stdout.trim() : "";
    const lines = diffOutput ? diffOutput.split("\n").filter(Boolean).length : 0;
    return { file, divergedLines: lines, clean: lines === 0 };
  });
  await writeJsonAndExit({ anchor: { sha: anchorSha, source: anchor.source, ref: anchor.ref }, mainRef, files: fileResults }, 0);
}

if (isMain) {
  console.error(`用法：
  node .devpro/scripts/detect-branch-base.mjs --anchor                               # 印出當前 anchor（JSON）
  node .devpro/scripts/detect-branch-base.mjs --main-tip [--limit <N>]               # 列 main 領先 production-tag 的 commits（JSON object，預設 limit=50）
  node .devpro/scripts/detect-branch-base.mjs --touch-divergence <files...>          # 對 touch set 逐檔回報 anchor..origin/main 分歧（per-file JSON）
  node .devpro/scripts/detect-branch-base.mjs --require-main-ancestor --production-ref <ref> --main-ref <ref>
  node .devpro/scripts/detect-branch-base.mjs --reconciliation-status --production-ref <ref> --main-ref <ref>`);
  process.exit(1);
}
