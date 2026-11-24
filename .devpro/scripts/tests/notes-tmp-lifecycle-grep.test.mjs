import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";



const destinations = read(".devpro/agent-rules/file-write-destinations.md");
const tokenFrugal = read(".devpro/agent-rules/token-frugal-io.md");
const branchHygiene = read(".devpro/agent-rules/git-branch-hygiene.md");
const releaseStep = read(".devpro/agent-rules/release-step-1-7.md");
const releaseFlow = read(".devpro/agent-rules/release-sit-uat-pat-prod.md");
const sessionRecap = read(".devpro/agent-rules/session-recap.md");
const sessionStart = read(".devpro/scripts/hooks/session-start.mjs");
const recapUtils = read(".devpro/scripts/hooks/lib/recap-utils.mjs");
const pruneNotesTmp = read(".devpro/scripts/prune-notes-tmp.mjs");

test("file-write destinations defines notes/tmp lifecycle and state prefix registry", () => {
  assert.match(destinations, /## `notes\/tmp\/` lifecycle/);
  assert.match(destinations, /## `notes\/tmp\/state\/` prefix registry/);
  assert.match(destinations, /prune-notes-tmp\.mjs/);
  assert.match(destinations, /60 分鐘/);
  assert.match(destinations, /--limit 0/);
  assert.match(destinations, /Stop hook \/ SessionStart/);
  assert.match(destinations, /`notes\/tmp\/state\/\*\*` 永遠/);

  for (const prefix of [
    "devpro-recap-state/",
    "devpro-recap-pending/",
    "devpro-recap-in-progress/",
    "devpro-recap-written/",
    "devpro-postmerge-state/",
    "devpro-post-pr-completion/",
    "devpro-post-pr-skipped-cleanup-probe/",
    "devpro-rule-load-ledger-state/",
  ]) {
    assert.match(destinations, new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("final and archive-transition logs stay inline and never regain a notes/tmp pathname lifecycle", () => {
  assert.match(
    destinations,
    /final(?:\s*\/\s*|\s+and\s+|／)archive-transition[^\n]*(?:suite|gate)[^\n]*logs?[^\n]*(?:只存在|only exist)[^\n]*v1[^\n]*inline record/i,
    "destination lifecycle must explicitly keep final/transition suite and gate logs inside existing v1 inline records",
  );
  assert.match(
    destinations,
    /(?:MUST NOT|不得)[^\n]*(?:standalone|獨立)[^\n]*(?:notes\/tmp|log (?:file|path)|pathname)/i,
    "destination lifecycle must explicitly forbid standalone notes/tmp log paths",
  );
  assert.doesNotMatch(
    destinations,
    /full-suite log 仍導向 `notes\/tmp`/,
    "removed standalone full-suite log guidance must not return",
  );
  assert.doesNotMatch(
    destinations,
    /上表第 3 列/,
    "notes/tmp lifecycle must not point at the nonexistent former full-suite row",
  );
});

test("post-pr skipped cleanup probe state prefix is registered with owner and TTL", () => {
  assert.match(destinations, /devpro-post-pr-skipped-cleanup-probe\/[\s\S]*post-pr-completion-check\.mjs/);
  assert.match(destinations, /devpro-post-pr-skipped-cleanup-probe\/[\s\S]*cleanup probe/);
  assert.match(destinations, /devpro-post-pr-skipped-cleanup-probe\/[\s\S]*60 分鐘/);
});

test("recap-written state prefix is registered as no-TTL local marker", () => {
  assert.match(destinations, /devpro-recap-written\/[\s\S]*no TTL/);
  assert.match(destinations, /devpro-recap-written\/[\s\S]*recap-written marker/);
  assert.match(destinations, /devpro-recap-written\/[\s\S]*manual\/state reset/);
  assert.match(recapUtils, /RECAP_WRITTEN_DIR/);
  assert.match(recapUtils, /defaultRepoStateDir\("devpro-recap-written"\)/);
});

test("legacy recap-pending TTL stays one day; scoped startup never consumes backlog", () => {
  assert.match(destinations, /\| `devpro-recap-pending\/`[^\n]*ownerless legacy marker[^\n]*legacy API retains 24h TTL[^\n]*new reminder evaluators leave it untouched/);
  assert.match(sessionRecap, /scoped 工作存於[^\n]*不靠 24h TTL 丟掉未完成義務[^\n]*legacy pending 的 24h TTL 僅是舊 carrier 相容介面[^\n]*不參與新 evaluator/);
  assert.match(recapUtils, /const RECAP_PENDING_TTL_MS = 24 \* 60 \* 60_000;/);
  assert.doesNotMatch(sessionStart, /await evaluateMergedRecapPending|buildRecapPendingSection/);
  assert.doesNotMatch(recapUtils, /7 \* 24 \* 60 \* 60_000/);
  assert.doesNotMatch(sessionStart, /最多 7 天內/);
});

test("branch and release hygiene trigger notes/tmp dry-run only at cleanup time", () => {
  assert.match(branchHygiene, /### Notes Tmp Hygiene/);
  assert.match(branchHygiene, /Release flow Step 6/);
  assert.match(branchHygiene, /node \.devpro\/scripts\/prune-notes-tmp\.mjs/);
  assert.match(branchHygiene, /--exec[\s\S]*使用者明確同意/);
  assert.match(branchHygiene, /Stop hook \/ SessionStart 不自動 prune/);

  assert.match(releaseStep, /prune-notes-tmp\.mjs/);
  assert.match(releaseStep, /Notes Tmp Hygiene/);
  assert.match(releaseFlow, /stale notes\/tmp/);
});

test("token-frugal output logs point to notes/tmp lifecycle instead of permanent retention", () => {
  assert.match(tokenFrugal, /notes\/tmp` log 是短期 scratch/);
  assert.match(tokenFrugal, /prune-notes-tmp\.mjs/);
  assert.match(tokenFrugal, /Lifecycle SSOT 見 `file-write-destinations\.md`/);
});

test("prune-notes-tmp script preserves state and defaults to dry-run", () => {
  assert.match(pruneNotesTmp, /Dry-run by default/);
  assert.match(pruneNotesTmp, /DEFAULT_MAX_AGE_MINUTES = 60/);
  assert.match(pruneNotesTmp, /DEFAULT_LIST_LIMIT = 50/);
  assert.match(pruneNotesTmp, /--limit/);
  assert.match(pruneNotesTmp, /--include-unknown/);
  assert.match(pruneNotesTmp, /rel === "state" \|\| rel\.startsWith\("state\/"\)/);
  assert.match(pruneNotesTmp, /Unsupported option: --dry-run/);
});

test("the reviewer-writable-root entry-count ceiling stays in lockstep between the rule leaf and the renderer, and notes/tmp is no longer inside that root", () => {
  // The classification string and the threshold live in two carriers (renderer, this
  // leaf). Whoever is deciding where to write a 600 KB full-suite log reads the leaf,
  // not the renderer source, so the redundancy is deliberate — this anchor is what
  // keeps it from drifting.
  const renderer = read(".devpro/scripts/render-second-review-packet.mjs");

  assert.match(renderer, /reviewer_writable_root_enumeration_overflow_risk/);
  assert.match(renderer, /maxReviewerWritableRootListingBytes = 32 \* 1024/);
  assert.match(destinations, /reviewer_writable_root_enumeration_overflow_risk/);
  assert.match(destinations, /32768 B/);
  // Burst cleanup goes through a --max-age-minutes 1 dry-run; --exec alone needs that dry-run's --as-of.
  assert.match(destinations, /`prune-notes-tmp\.mjs --max-age-minutes 1` dry-run/);
  assert.doesNotMatch(destinations, /--exec --max-age-minutes 1/);
  // issue #1735 fix: notes/tmp is no longer inside the reviewer-writable root because
  // the Codex recipe no longer grants `--add-dir`; the ceiling now only constrains the
  // reviewer's own per-dispatch neutral cwd. Reasserting notes/tmp membership here would
  // be exactly the regression this change removes.
  assert.match(destinations, /`notes\/tmp` 已不在此 root 內/);
  assert.match(destinations, /Codex recipe 不再持有 `--add-dir`/);
  // The ceiling moved roots; the single-file-read caveat did not stop being true. The renderer
  // still estimates one `ls -la` line, so a large file `cat`-ed inside the new root can still
  // latch the runner's 64-KiB bound. `code-review-checklist/spec.md` MUST-requires this SSOT to
  // state it, so dropping the sentence would be a spec violation nothing else catches.
  assert.match(destinations, /只涵蓋 top-level 列舉，不涵蓋單檔內容讀取/);

  // `--max-age-minutes 0` is rejected by the pruner, so the burst hint must say 1.
  assert.match(pruneNotesTmp, /Number\(raw\) <= 0/);
  assert.doesNotMatch(destinations, /--max-age-minutes 0/);
});
