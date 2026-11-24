/**
 * Copy-site consistency for the already-live backfill rule: the same "non-urgent already-live
 * backfill needs normal OpenSpec/pre-flight first" sentence lives on 19 lines across the rule
 * corpus and the consumer hotfix scenario. Each copy MUST end with one fixed pointer so a lite
 * reader reaches `release-already-live-backfill.md` §2 instead of a contradicting requirement.
 *
 * The unit of inspection is the copy line, not the file: `preflight-checklist.md` carries two
 * copies and `scenario-d-consumer-repo-hotfix.md` carries twelve, so a file-level check would pass
 * when one of them lacks the pointer. A discovery scan keeps the registry honest: a new copy that
 * is not in the registry, or a registry entry that no longer matches, turns the test red.
 * Regex blind spots (the same rule restated in other words) stay cooperative-only.
 *
 * Mutation replay below removes one pointer in memory and requires the audit to name that exact site.
 *
 * `[Req: R4, R6]`
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readSourceFile as read } from "./lib/read.mjs";
import { SOURCE_ROOT } from "./lib/source-root.mjs";
import { repoPath } from "./lib/repo-root.mjs";

// Design D5: the one pointer literal. Defined here once; every copy line ends with it.
const POINTER = "（rigor lite 的 OpenSpec／pre-flight／archive 要求改依 `release-already-live-backfill.md` §2）";

// Discovery regex (design D5). Case-insensitive: scenario-d has a capitalised "Non-urgent" copy.
const DISCOVERY = /(non-urgent|非緊急)[^\n]*(already-live|backfill|回填)|not independently urgent/i;

const POLICY = ".devpro/agent-rules/release-hotfix-carrier-policy.md";
const LANE = ".devpro/agent-rules/release-hotfix-carrier-lane.md";
const ARCHIVE = ".devpro/agent-rules/openspec-archive-principles.md";
const FLOW = ".devpro/agent-rules/openspec-flow.md";
const PREFLIGHT = ".devpro/agent-rules/preflight-checklist.md";
const PR_TEMPLATE = ".devpro/agent-rules/git-pr-template-and-merge.md";
const SCENARIO = "scenarios/scenario-d-consumer-repo-hotfix.md";

// Registry: file plus the start of the copy line. The anchor is the first words of the pre-change line,
// so it survives tail-appended pointers and inserted lines.
const REGISTRY = [
  [POLICY, "A non-urgent already-live backfill："],
  [LANE, "**Rollback 與 already-live backfill**"],
  [ARCHIVE, "- **independently urgent hotfix 補件（24h）**"],
  [FLOW, "> **Archive**：freeze 後、首次 push/PR 前同分支完成"],
  [PREFLIGHT, "所有需建 OpenSpec change 的分支。"],
  [PREFLIGHT, "- checklist 全部通過（或 A 類點 1-2"],
  [PR_TEMPLATE, "- archive: done（`openspec/specs/<name>/`）。Only an independently urgent"],
  [SCENARIO, "- [ ] A non-urgent already-live backfill reuses"],
  [SCENARIO, "### Phase 2: dp-analyst Pre-flight"],
  [SCENARIO, "- [ ] Non-urgent already-live backfill 必須"],
  [SCENARIO, "- [ ] 緊急修復 Proposal 可簡化"],
  [SCENARIO, "- [ ] PR 描述：緊急修復可將 OpenSpec"],
  [SCENARIO, "### Phase 7: 緊急修復事後補 OpenSpec"],
  [SCENARIO, "- [ ] 僅 independently urgent repair 需要走本 Phase"],
  [SCENARIO, "- [ ] **不應**跳過 pre-flight 點 1-4"],
  [SCENARIO, "- [ ] 緊急修復 **不應**超過 24h"],
  [SCENARIO, "1. **~~緊急 Hotfix 無 lite pre-flight~~**"],
  [SCENARIO, "2. **~~dp-analyst + dp-architect MUST 義務~~**"],
  [SCENARIO, "- 緊急修復的 OpenSpec 24h 內補齊"],
];

const label = ([file, anchor]) => `${file} «${anchor}»`;

// Audit one file's text against its registry entries: every entry must resolve to exactly one line that
// still matches the discovery regex and ends with the pointer.
function auditFile(file, text) {
  const lines = text.split("\n");
  const failures = [];
  for (const entry of REGISTRY.filter(([f]) => f === file)) {
    const hits = lines.filter((l) => l.startsWith(entry[1]));
    if (hits.length !== 1) {
      failures.push(`${label(entry)}: expected exactly one line, found ${hits.length}`);
      continue;
    }
    if (!DISCOVERY.test(hits[0])) failures.push(`${label(entry)}: line no longer matches the discovery regex`);
    if (!hits[0].trimEnd().endsWith(POINTER)) failures.push(`${label(entry)}: missing the pointer at the end of the line`);
  }
  return failures;
}

// Scope for the discovery scan: rules, skills and scenarios (walked on disk, symlinks skipped so a linked
// catalog is not read twice) plus READMEs at the repo root and inside those trees. Archives, notes, docs,
// refs, openspec artifacts, tests and the new leaf itself are outside the scope.
const SCAN_ROOTS = [".devpro/agent-rules", ".devpro/agent-skills", "scenarios"];

function walk(rel) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(`${SOURCE_ROOT}/${rel}`, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const child = `${rel}/${entry.name}`;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...walk(child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

function discoverableFiles() {
  const rootReadmes = readdirSync(SOURCE_ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && /^README[^/]*$/i.test(e.name))
    .map((e) => e.name);
  return [...SCAN_ROOTS.flatMap(walk), ...rootReadmes].filter(
    (f) => !/\.test\.mjs$/.test(f) && f !== ".devpro/agent-rules/release-already-live-backfill.md",
  );
}

function discoverCopies() {
  const found = [];
  for (const file of discoverableFiles()) {
    let text;
    try {
      text = readFileSync(`${SOURCE_ROOT}/${file}`, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) if (DISCOVERY.test(line)) found.push([file, line]);
  }
  return found;
}

test("the registry lists 19 copy sites", () => {
  assert.equal(REGISTRY.length, 19);
  assert.equal(new Set(REGISTRY.map(label)).size, 19, "no duplicate registry entries");
});

test("every registered copy line ends with the one fixed pointer (per site, not per file)", () => {
  const failures = [...new Set(REGISTRY.map(([f]) => f))].flatMap((file) => auditFile(file, read(file)));
  assert.deepEqual(failures, []);
});

test("registry and discovery scan agree: no unregistered copy, no stale registry entry", () => {
  const found = discoverCopies();
  const unmatchedLines = found.filter(([file, line]) => !REGISTRY.some(([f, a]) => f === file && line.startsWith(a)));
  assert.deepEqual(
    unmatchedLines.map(([file, line]) => `${file}: ${line.slice(0, 60)}`),
    [],
    "a copy line found by the discovery regex is not in the registry; add it and its pointer",
  );
  const unmatchedEntries = REGISTRY.filter(([f, a]) => !found.some(([file, line]) => file === f && line.startsWith(a)));
  assert.deepEqual(unmatchedEntries.map(label), [], "a registry entry no longer matches a discovered copy line");
  assert.equal(found.length, REGISTRY.length);
});

test("mutation replay: dropping one pointer in preflight-checklist.md fails exactly that site", () => {
  const text = read(PREFLIGHT);
  assert.deepEqual(auditFile(PREFLIGHT, text), [], "baseline must pass first");
  const target = REGISTRY.find(([f, a]) => f === PREFLIGHT && a.startsWith("- checklist 全部通過"));
  const mutated = text
    .split("\n")
    .map((l) => (l.startsWith(target[1]) ? l.split(POINTER).join("").trimEnd() : l))
    .join("\n");
  const failures = auditFile(PREFLIGHT, mutated);
  assert.equal(failures.length, 1, "the other copy in the same file must stay green");
  assert.match(failures[0], /checklist 全部通過/);
});

test("mutation replay: dropping one pointer in scenario-d fails exactly that site", () => {
  const text = read(SCENARIO);
  assert.deepEqual(auditFile(SCENARIO, text), [], "baseline must pass first");
  const target = REGISTRY.find(([f, a]) => f === SCENARIO && a.startsWith("- [ ] 僅 independently urgent repair"));
  const mutated = text
    .split("\n")
    .map((l) => (l.startsWith(target[1]) ? l.split(POINTER).join("").trimEnd() : l))
    .join("\n");
  const failures = auditFile(SCENARIO, mutated);
  assert.equal(failures.length, 1, "the eleven other copies in the same file must stay green");
  assert.match(failures[0], /僅 independently urgent repair/);
});

// ---------------------------------------------------------------------------
// Policy owns the precedence: the original sentence stays, the owner clause and the pointer follow.
// ---------------------------------------------------------------------------
const POLICY_ORIGINAL =
  "A non-urgent already-live backfill：**source／consumer 同構**——MUST complete normal OpenSpec/pre-flight before implementation；hotfix prefix alone MUST NOT authorize freeze-break；組裝後仍至少 smoke / at least smoke。Urgency-only OpenSpec deferral and lite pre-flight remain limited to independently urgent repairs.";

test("policy: original sentence token sequence is unchanged and the owner clause precedes the pointer", () => {
  const line = read(POLICY).split("\n").find((l) => l.startsWith("A non-urgent already-live backfill："));
  assert.ok(line, "the policy copy line exists");
  assert.ok(line.startsWith(POLICY_ORIGINAL), "tail-append only: the original sentence is a prefix of the line");
  const clause = line.slice(POLICY_ORIGINAL.length);
  assert.ok(clause.trimEnd().endsWith(POINTER));
  const owner = clause.slice(0, clause.lastIndexOf(POINTER));
  // The clause names what lite replaces (OpenSpec, pre-flight, archive, PR reference) and the timing rules.
  for (const re of [/rigor lite/, /PR body/, /OpenSpec/, /pre-flight/, /archive/, /PR 引用/, /non-urgent[^\n]*實作前/, /independently urgent[^\n]*24h/, /urgency-only/]) {
    assert.match(owner, re, `owner clause must mention ${re}`);
  }
  // The operating steps (which commit carries the fields, when they move into the PR body) have one normative owner: leaf §2.
  assert.doesNotMatch(owner, /第一個 commit|commit 的 message|原文轉入/, "policy keeps precedence and timing only; the how lives in the leaf");
});

test("lite walk-through: the pointer target replaces each of the four requirement kinds the copies demand", () => {
  const leaf = read(".devpro/agent-rules/release-already-live-backfill.md");
  const liteLine = leaf.split("\n").find((l) => l.startsWith("- **lite**"));
  assert.ok(liteLine, "leaf §2 has a lite line");
  for (const kind of ["OpenSpec", "pre-flight", "archive", "PR 引用"]) {
    assert.ok(liteLine.includes(kind), `lite replaces ${kind}`);
  }
  assert.match(liteLine, /不建 proposal/);
  // The checklist copies that ask for an archive or an OpenSpec reference all carry the pointer.
  for (const file of [ARCHIVE, FLOW, PR_TEMPLATE, PREFLIGHT, SCENARIO]) {
    assert.ok(read(file).includes(POINTER), `${file} points a lite reader at §2`);
  }
});

test("scenario-d carries a lite variant checklist item without touching existing items", () => {
  const text = read(SCENARIO);
  const item = text.split("\n").find((l) => /^- \[ \] Lite 回補/.test(l));
  assert.ok(item, "a «Lite 回補» checklist item exists");
  assert.ok(item.includes("PR body"));
  assert.match(item, /第一個 commit 的 message/, "the pre-implementation carrier is named");
  assert.ok(item.includes("`release-already-live-backfill.md` §2"));
  assert.ok(!DISCOVERY.test(item), "the added item must not become a twentieth copy line");
});

// ---------------------------------------------------------------------------
// Owner sites: the lines that send a post-cutover direct merge to §3 and the post-merge archive exception to §3.4.
// They are not copy lines, so the registry above does not cover them; each is checked on its own line.
// ---------------------------------------------------------------------------
const LEAF_REF = "`release-already-live-backfill.md`";
const OWNER_SITES = [
  [POLICY, "**Cutover／grandfather**", `${LEAF_REF} §3`],
  [LANE, "只適用於「本 repo cutover 前", `${LEAF_REF} §3`],
  [ARCHIVE, "- merge後禁補首次archive", `${LEAF_REF} §3.4`],
  [ARCHIVE, "- **independently urgent hotfix 補件（24h）**", `${LEAF_REF} §3.4`],
];
const ownerLabel = ([file, anchor]) => `${file} «${anchor}»`;

function auditOwnerSites(file, text) {
  const lines = text.split("\n");
  const failures = [];
  for (const site of OWNER_SITES.filter(([f]) => f === file)) {
    const hits = lines.filter((l) => l.startsWith(site[1]));
    if (hits.length !== 1) failures.push(`${ownerLabel(site)}: expected exactly one line, found ${hits.length}`);
    else if (!hits[0].includes(site[2])) failures.push(`${ownerLabel(site)}: missing ${site[2]}`);
  }
  return failures;
}

test("owner sites: the cutover, Grandfathered and post-merge archive lines point at the leaf section", () => {
  const failures = [...new Set(OWNER_SITES.map(([f]) => f))].flatMap((file) => auditOwnerSites(file, read(file)));
  assert.deepEqual(failures, []);
  assert.equal(OWNER_SITES.length, 4);
});

test("mutation replay: dropping one owner pointer fails exactly that site", () => {
  for (const site of OWNER_SITES) {
    const [file, anchor, snippet] = site;
    const text = read(file);
    assert.deepEqual(auditOwnerSites(file, text), [], `${file}: baseline must pass first`);
    const mutated = text
      .split("\n")
      .map((l) => (l.startsWith(anchor) ? l.split(snippet).join("") : l))
      .join("\n");
    const failures = auditOwnerSites(file, mutated);
    assert.equal(failures.length, 1, `${ownerLabel(site)}: exactly that site fails`);
    assert.ok(failures[0].startsWith(ownerLabel(site)));
  }
});

// ---------------------------------------------------------------------------
// Canonical spec: the Already-Live scenario mirrors the delta line (lint-delta-body-canonical-wrap).
// ---------------------------------------------------------------------------
const LITE_SPEC_LINE =
  "- **AND** under rigor `lite` the record carrier is the PR-body fixed fields defined by `Already-Live Backfill Record Shape`, which replace the OpenSpec, pre-flight, archive and pull-request-reference requirements for that backfill; this is not an urgency-only OpenSpec deferral, and unless the repair is independently urgent (which keeps the existing 24-hour completion rule) the fields MUST be prepared before implementation starts, in the message of the first commit on the branch, and carried verbatim into the PR body when the pull request is opened";

test("canonical Already-Live scenario carries the lite line, identical to the active delta while it exists", () => {
  const canonical = read("openspec/specs/openspec-flow/spec.md");
  const scenarioStart = canonical.indexOf("#### Scenario: Already-Live Production Backfill Uses Hotfix Lane");
  assert.ok(scenarioStart >= 0);
  const next = canonical.indexOf("\n#### ", scenarioStart + 1);
  const scenario = canonical.slice(scenarioStart, next < 0 ? undefined : next);
  assert.ok(scenario.split("\n").includes(LITE_SPEC_LINE), "canonical scenario has the lite line verbatim");
  const deltaPath = repoPath("openspec/changes/add-already-live-backfill-record/specs/openspec-flow/spec.md");
  if (existsSync(deltaPath)) {
    assert.ok(readFileSync(deltaPath, "utf8").split("\n").includes(LITE_SPEC_LINE), "the active delta mirrors the same line");
  }
});
