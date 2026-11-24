/**
 * Grep anchors and a pure N1 model for the already-live backfill record leaf
 * (`release-already-live-backfill.md`): the record shape (§2), the direct-production
 * merge incident remediation (§3) and the rigor × urgency × merge-phase matrix (§4).
 * Scenario titles from `specs/openspec-flow/spec.md` of change
 * `add-already-live-backfill-record` appear verbatim in the test names so
 * `lint-delta-new-scenario-assertion-coverage` can find them.
 *
 * Copy-site pointers live in `already-live-backfill-copies-grep.test.mjs`.
 *
 * `[Req: R1, R3, R6]`
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import vm from "node:vm";
import { readSourceFile as read } from "./lib/read.mjs";

const LEAF_PATH = ".devpro/agent-rules/release-already-live-backfill.md";

// A missing leaf must fail each test on its own assertion (red), not crash the module load.
function tryRead(rel) {
  try {
    return read(rel);
  } catch {
    return "";
  }
}

const leaf = tryRead(LEAF_PATH);
const routing = read(".devpro/agent-rules/openspec-branch-routing.md");
const naming = read(".devpro/agent-rules/git-branch-naming-and-anchor.md");
const agents = read("AGENTS.md");

// Slice from a heading line to the next heading of the same or a higher level.
function slice(text, headingRe) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start < 0) return "";
  const level = lines[start].match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+) /);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

const s1 = slice(leaf, /^### §1 /);
const s2 = slice(leaf, /^### §2 /);
const s3 = slice(leaf, /^### §3 /);
const s4 = slice(leaf, /^### §4 /);
const exitCriteria = slice(leaf, /^## Exit Criteria$/);

// §3 numbered steps, keyed by their number.
function steps(section) {
  const out = {};
  let current = null;
  for (const line of section.split("\n")) {
    const m = line.match(/^(\d)\. (.*)$/);
    if (m) {
      current = m[1];
      out[current] = m[2];
    } else if (current && /^\s+\S/.test(line)) {
      out[current] += `\n${line}`;
    } else if (/^\S/.test(line)) {
      current = null;
    }
  }
  return out;
}
const step = steps(s3);

// ---------------------------------------------------------------------------
// Leaf anatomy
// ---------------------------------------------------------------------------
test("leaf exists with the six-section anatomy and §1–§4 in order", () => {
  assert.ok(leaf.length > 0, `${LEAF_PATH} must exist`);
  assert.match(leaf, /^name: release-already-live-backfill$/m);
  assert.match(leaf, /^description: .*觸發：/m, "description must carry the trigger");
  const sections = ["Overview", "When to Use", "Process", "Exit Criteria", "Common Rationalizations", "Verification"];
  let last = -1;
  for (const name of sections) {
    const at = leaf.search(new RegExp(`^## ${name}$`, "m"));
    assert.ok(at > last, `## ${name} must exist and follow the previous section`);
    last = at;
  }
  const marks = ["§1", "§2", "§3", "§4"].map((n) => leaf.search(new RegExp(`^### ${n} `, "m")));
  assert.ok(marks[0] >= 0 && marks.every((v, i) => i === 0 || v > marks[i - 1]), "### §1–§4 must exist in order");
});

test("positioning: incident remediation, not a release lane; no carrier, build once or provenance claimed", () => {
  assert.match(leaf, /事故補救/);
  assert.match(leaf, /不是[^\n]*(上線|release)[^\n]*lane/);
  assert.match(leaf, /不宣稱[^\n]*carrier[^\n]*build once[^\n]*provenance/);
  assert.ok(leaf.includes("事故補打，無 carrier、build once、provenance"), "the incident tag annotation literal must be present");
});

// hotfix-release-carrier-grep scans only its own LIVE_CARRIERS list, which does not include this leaf. Read the
// same OLD_WORDING list from that test's source so the leaf is held to the whole retired set, not a sample.
function retiredWording() {
  const src = read(".devpro/scripts/tests/hotfix-release-carrier-grep.test.mjs");
  const m = src.match(/const OLD_WORDING = (\[[\s\S]*?\n\]);/);
  assert.ok(m, "OLD_WORDING array literal must still exist in hotfix-release-carrier-grep.test.mjs");
  const list = vm.runInNewContext(m[1], {}, { timeout: 1000 });
  assert.ok(Array.isArray(list) && list.length >= 20, "OLD_WORDING must still list the retired phrases");
  assert.ok(list.every((p) => typeof p === "string" && p.length > 0));
  return list;
}

test("leaf avoids retired dual-lane wording, a restated backfill rule line and personal data", () => {
  assert.ok(leaf.length > 0, "an absent leaf must not pass the negative checks vacuously");
  for (const phrase of ["雙 PR", "雙合回", "hotfix bypass", "hotfix dual-PR", "成對雙 PR", ...retiredWording()]) {
    assert.ok(!leaf.includes(phrase), `leaf must not contain retired wording: ${phrase}`);
  }
  // release-promotion-flows-grep keeps the single operative line in the carrier policy; the leaf must not restate it.
  assert.doesNotMatch(leaf, /already-live backfill[^\n]*MUST[^\n]*OpenSpec/i);
  assert.doesNotMatch(leaf, /\/Users\//, "no user-profile path");
  assert.doesNotMatch(leaf, /[\w.+-]+@[\w-]+\.[\w.]+/, "no email address");
});

// ---------------------------------------------------------------------------
// §1 / §2 — record shape
// ---------------------------------------------------------------------------
test("Verified Evidence Minimum Gates The Record", () => {
  assert.match(s1, /部署檔或差異[^\n]*上線時間/, "evidence form 1: deployed file or diff with go-live time");
  assert.match(s1, /直接觀察[^\n]*方式[^\n]*時間/, "evidence form 2: direct observation recording method and time");
  assert.match(s1, /兩者皆無[^\n]*不得[^\n]*(先取得|補)/, "neither evidence form means the change does not proceed");
  assert.match(s1, /寫作時點與載體見 §2/, "the record timing and carrier rule is pointed to next to the evidence rule");
});

test("§1 names the branch prefix and the carrier lane for a verified backfill", () => {
  assert.match(s1, /`hotfix\/` 列[^\n]*最近 `production-\*` tag[^\n]*carrier lane/, "hotfix/ from the latest production-* tag via the carrier lane");
  assert.match(s1, /不走 Rule #2／#5 的 `bugfix\/`/, "both bugfix/ branches of the routing tree (Rule #2 unattributable, Rule #5 already on PROD) are excluded for a verified backfill");
});

test("Unknown Reason Is Recorded As Unknown", () => {
  assert.match(s2, /固定欄位[^\n]*來源[^\n]*Why[^\n]*客戶端已上線變更（observed）[^\n]*上線證據/);
  assert.ok(s2.includes("客戶未說明調整原因"));
  assert.match(s2, /客戶端已上線變更（observed）：<[^>\n]+>/, "per-item observed entry shape");
  assert.match(s2, /不得[^\n]*(編造|臆測|捏造)[^\n]*原因/, "SA must not invent a reason");
});

test("Lite Record Lives In The PR Body", () => {
  assert.match(
    s2,
    /lite[^\n]*PR body[^\n]*取代[^\n]*OpenSpec[^\n]*pre-flight[^\n]*archive[^\n]*PR 引用/,
    "lite carrier is the PR body and replaces OpenSpec, pre-flight, archive and PR reference requirements",
  );
  assert.match(s2, /lite[^\n]*不建 proposal/, "lite creates no proposal");
  assert.match(
    s2,
    /lite[^\n]*第一個 commit 的 message[^\n]*轉入 PR body[^\n]*cooperative/,
    "a PR does not exist before it is opened: the fields are prepared in the first commit message and carried into the PR body; the timing is cooperative",
  );
  assert.match(s2, /non-urgent[^\n]*實作前[^\n]*independently urgent[^\n]*24h/, "timing: before implementation unless independently urgent (24h)");
});

test("Full Record Uses Proposal-Mini And A Spec Delta", () => {
  assert.match(s2, /full[^\n]*proposal-mini\.md[^\n]*proposal\.md[^\n]*spec delta/);
  assert.match(s2, /B-mini[^\n]*不能新增 capability[^\n]*(full B|proposal\.md)/, "no covering canonical spec means full B");
  assert.match(s2, /spec delta[^\n]*只[^\n]*(現況|observed)/, "the delta states only the current observed behavior");
  assert.match(s2, /archive/, "the archive requirement applies under full");
});

test("Observed Behavior Needs A Named Acceptance", () => {
  assert.match(s2, /具名接受[^\n]*(SA|TL)/);
  assert.match(s2, /AI[^\n]*不得[^\n]*推論/, "an AI must not infer the acceptance");
  assert.match(s2, /deferred|不進 spec delta/, "an unaccepted behavior stays out of the spec delta");
});

// ---------------------------------------------------------------------------
// §3 — pure N1 model over small ref graphs
//
// The graph, route-selection and completion functions below are illustrative models. They restate N1 and the
// leaf's procedure in code, they do not call `hotfix-carrier-verify.mjs`, and they do not read the policy, so
// an assertion on the model alone cannot fail when the leaf or the verifier changes. What guards the leaf is
// the regex assertion beside each model. This change does not touch the verifier or the N1 text, which is why
// "N1(b) is not relaxed" holds by the diff, not by these models.
// ---------------------------------------------------------------------------
// production is a linear chain of commits (oldest first); tags map name -> commit.
// N1(a): the latest `production-*` tag (topological) is the anchor tag.
// N1(b): the `origin/production` tip equals the exact commit of the anchor tag.
const graph = (production, tags) => ({ production, tags });
const tip = (g) => g.production[g.production.length - 1];
function latestTag(g) {
  const at = (c) => g.production.indexOf(c);
  const tagged = Object.entries(g.tags).filter(([, c]) => at(c) >= 0);
  tagged.sort((x, y) => at(y[1]) - at(x[1]));
  return tagged.length ? tagged[0][0] : undefined;
}
function freshness(g, anchorTag) {
  return { a: latestTag(g) === anchorTag, b: anchorTag in g.tags && g.tags[anchorTag] === tip(g) };
}
// Returns the anchor commit a carrier (or a hotfix/revert branch) would be cut from; throws when N1 fails closed.
function cutFromLatestTag(g) {
  const anchor = latestTag(g);
  if (anchor === undefined) throw new Error("fail closed: no production tag");
  const f = freshness(g, anchor);
  if (!f.a || !f.b) throw new Error("fail closed: N1 freshness");
  return { anchor, commit: g.tags[anchor] };
}
// Leaf §3.1: tag the CURRENT production tip.
const tagIncident = (g, name, commit = tip(g)) => graph(g.production, { ...g.tags, [name]: commit });
const INCIDENT = "production-20261022";

test("Incident Merge Is The Production Tip", () => {
  const g = graph(["c0", "m1"], { "production-20261001": "c0" });
  assert.throws(() => cutFromLatestTag(g), /N1 freshness/, "untagged incident merge blocks every carrier through N1 freshness, not a missing tag");
  const fixed = tagIncident(g, INCIDENT);
  assert.deepEqual(freshness(fixed, INCIDENT), { a: true, b: true });
  assert.deepEqual(cutFromLatestTag(fixed), { anchor: INCIDENT, commit: "m1" });
  assert.match(step["1"] ?? "", /目前[^\n]*production tip/);
});

test("Production Advanced After The Incident Merge", () => {
  const g = graph(["c0", "m1", "p2"], { "production-20261001": "c0" });
  const onIncidentMerge = tagIncident(g, INCIDENT, "m1");
  assert.deepEqual(freshness(onIncidentMerge, INCIDENT), { a: true, b: false }, "tagging the old incident merge leaves N1(b) false");
  assert.throws(() => cutFromLatestTag(onIncidentMerge), /N1 freshness/, "a stale tip fails N1(b), not tag discovery");
  const onTip = tagIncident(g, INCIDENT);
  assert.deepEqual(cutFromLatestTag(onTip), { anchor: INCIDENT, commit: "p2" });
  assert.match(step["1"] ?? "", /不[^\n]*事故 merge/, "the leaf says not to tag the incident merge itself");
});

test("A repo with no production tag fails on tag discovery, which is a different class from N1 freshness", () => {
  const noTag = graph(["c0"], {});
  assert.throws(() => cutFromLatestTag(noTag), /no production tag/);
  assert.throws(() => cutFromLatestTag(noTag), (e) => !/N1 freshness/.test(e.message), "the two failure classes stay distinguishable");
});

test("Revert Is Chosen", () => {
  const g = tagIncident(graph(["c0", "m1", "p2"], { "production-20261001": "c0" }), INCIDENT);
  const revertBase = cutFromLatestTag(g);
  assert.equal(revertBase.anchor, INCIDENT, "hotfix/revert-* is cut from the incident tag");
  assert.equal(revertBase.commit, tip(g));
  assert.match(step["2"] ?? "", /hotfix\/revert-\*[^\n]*(事故 tag|該 tag)[^\n]*carrier lane/);
  assert.match(step["1"] ?? "", /(接受與回退|接受和回退)/, "step 1 applies to both accept and revert");
});

test("Skipping The Incident Tag Fails Closed", () => {
  const g = graph(["c0", "m1"], { "production-20261001": "c0" });
  // accept path (a later carrier) and revert path (a hotfix/revert-* carrier) both cut from the latest tag.
  for (const path of ["accept", "revert"]) {
    assert.throws(() => cutFromLatestTag(g), /N1 freshness/, `${path} path`);
  }
  assert.match(leaf, /N1\(b\)[^\n]*(不放寬|不定義例外)/, "the leaf states the freshness gate is not relaxed");
  assert.match(leaf, /hotfix\/\*[^\n]*(不得|MUST NOT)[^\n]*(直達|直接)[^\n]*production/);
});

test("§3 declares that step N is cited elsewhere as §3.N", () => {
  assert.match(s3, /步驟 N 在他處以 §3\.N 引用/, "referrers cite §3.4 for step 4; the leaf says so itself");
});

test("§3 steps run in the order tag → accept or revert → ancestry → records → incident note", () => {
  assert.deepEqual(Object.keys(step), ["1", "2", "3", "4", "5"]);
  assert.match(step["1"], /tag/);
  assert.match(step["2"], /接受[^\n]*回退|回退[^\n]*接受/);
  assert.match(step["3"], /git-branch-production-ancestry-repair\.md/);
  assert.match(step["4"], /補件|記錄/);
  assert.match(step["5"], /PR 編號[^\n]*合併方式/);
});

test("incident tag naming and Ask First", () => {
  assert.ok(step["1"]?.includes("production-YYYYMMDD[-<n>]"), "consumer tag format");
  assert.match(step["1"] ?? "", /release-hotfix-carrier-lane\.md[^\n]*(停下|交回)/, "SemVer source repo follows the lane version rule, else stop");
  assert.match(step["1"] ?? "", /Ask First/, "pushing the tag is Ask First");
});

// ---------------------------------------------------------------------------
// §3.3 — reconciliation route selection model
// ---------------------------------------------------------------------------
// The ancestry rule classifies first, then selects the route; no-op and fail closed precede route selection.
function reconcile({ tagIsAncestorOfMain, refValid, classification, backMergeFeasible }) {
  if (tagIsAncestorOfMain) return { route: "no-op", gateZero: true };
  if (!refValid) return { route: "fail-closed", gateZero: false };
  if (classification === "graph-only" && backMergeFeasible) return { route: "release-lane-back-merge", gateZero: true };
  return { route: "bounded-repair-merge", gateZero: true };
}

test("Tag Already Ancestral To Main Needs No Merge", () => {
  const r = reconcile({ tagIsAncestorOfMain: true, refValid: true, classification: "content-review-required", backMergeFeasible: false });
  assert.deepEqual(r, { route: "no-op", gateZero: true }, "no-op takes precedence over route selection");
  assert.match(step["3"] ?? "", /祖先[^\n]*no-op[^\n]*不[^\n]*repair branch/);
});

test("Non-Ancestral Tag Follows The Ancestry Route Selection", () => {
  assert.equal(reconcile({ tagIsAncestorOfMain: false, refValid: true, classification: "graph-only", backMergeFeasible: true }).route, "release-lane-back-merge");
  assert.equal(reconcile({ tagIsAncestorOfMain: false, refValid: true, classification: "graph-only", backMergeFeasible: false }).route, "bounded-repair-merge");
  assert.equal(reconcile({ tagIsAncestorOfMain: false, refValid: true, classification: "content-review-required", backMergeFeasible: false }).route, "bounded-repair-merge");
  const bad = reconcile({ tagIsAncestorOfMain: false, refValid: false, classification: "graph-only", backMergeFeasible: true });
  assert.deepEqual(bad, { route: "fail-closed", gateZero: false }, "invalid or ambiguous ref fails closed with no route");
  const text = step["3"] ?? "";
  assert.match(text, /graph-only[^\n]*back-merge/);
  assert.match(text, /bounded repair/);
  assert.match(text, /fail closed/);
  assert.match(text, /--require-main-ancestor/, "completion is the ancestry gate returning zero");
  assert.ok(text.indexOf("no-op") < text.indexOf("fail closed") && text.indexOf("fail closed") < text.indexOf("bounded repair"), "no-op, then fail closed, then route selection");
});

// ---------------------------------------------------------------------------
// §3.4 — completion criteria per rigor
// ---------------------------------------------------------------------------
const REQUIRED = { lite: ["prBodyFields", "qa"], full: ["proposal", "specDelta", "qa", "archive"] };
const complete = (rigor, have) => REQUIRED[rigor].every((k) => have.includes(k));

test("Lite Completion Needs The PR Body Record And QA Evidence", () => {
  assert.equal(complete("lite", ["prBodyFields", "qa"]), true);
  assert.equal(complete("lite", ["qa"]), false, "missing PR body fields");
  assert.equal(complete("lite", ["prBodyFields"]), false, "missing QA evidence");
  assert.match(step["4"] ?? "", /lite[^\n]*PR body[^\n]*QA/);
});

test("Full Completion Needs All Four Outputs", () => {
  const all = ["proposal", "specDelta", "qa", "archive"];
  assert.equal(complete("full", all), true);
  for (const missing of all) {
    assert.equal(complete("full", all.filter((k) => k !== missing)), false, `missing ${missing}`);
  }
  assert.match(step["4"] ?? "", /full[^\n]*(proposal-mini\.md|proposal\.md)[^\n]*spec delta[^\n]*QA[^\n]*archive/);
  assert.match(step["4"] ?? "", /缺[^\n]*(任何|任一)[^\n]*(不得|未完成)/);
});

// A reverted change has no accepted observed behavior, so the accept-path outputs do not apply.
const REVERT_REQUIRED = ["revertCarrierMerged", "incidentRecord"];
const revertComplete = (have) => REVERT_REQUIRED.every((k) => have.includes(k));

test("Revert Completion Needs The Carrier And The Incident Record", () => {
  assert.equal(revertComplete(["revertCarrierMerged", "incidentRecord"]), true);
  assert.equal(revertComplete(["incidentRecord"]), false, "revert carrier not merged");
  assert.equal(revertComplete(["revertCarrierMerged"]), false, "no incident record in the revert carrier PR body");
  const line = exitCriteria.split("\n").find((l) => l.startsWith("- 事故補救（回退）")) ?? "";
  assert.match(line, /事故 tag[^\n]*回退 carrier[^\n]*合併[^\n]*PR body[^\n]*事故記錄/);
  assert.match(line, /不要求步驟 3、4/);
  assert.doesNotMatch(line, /spec delta|archive/, "the revert line must not demand accept-path outputs");
  assert.match(step["2"] ?? "", /回退[^\n]*只做步驟 5[^\n]*不做步驟 3、4/);
  assert.match(step["5"] ?? "", /接受與回退都做/);
  const acceptLine = exitCriteria.split("\n").find((l) => l.startsWith("- 事故補救（接受）")) ?? "";
  assert.match(acceptLine, /--require-main-ancestor[^\n]*§3\.4/, "the accept line keeps the ancestry gate and the §3.4 outputs");
});

// F-10 (D16): where the supplements of an accepted incident land. Literal assertions on the
// leaf text; there is no mechanical gate behind this rule, so these pin the wording only.
test("Full Supplements Land On A Separate Supplement Pull Request", () => {
  const st4 = step["4"] ?? "";
  assert.match(st4, /事故 PR[^\n]*步驟 3[^\n]*`main`/, "step 4 defines the incident PR as the step 3 PR that brings the incident into main");
  assert.match(st4, /full[^\n]*獨立[^\n]*補件 PR/, "full supplements travel in a separate supplement PR");
  assert.match(st4, /`chore\/docs-<name>`[^\n]*自 anchor[^\n]*事故 tag/, "the supplement branch is chore/docs-<name> cut from the anchor, which is the incident tag");
  assert.doesNotMatch(st4, /`bugfix\/<name>`/, "no bugfix/ prefix: a docs-only supplement cannot carry the prove-it marker that bugfix/ branches require");
  assert.doesNotMatch(st4, /自 `main` 開/, "never cut from main: the base-unification rule bases chore/ on the anchor");
  assert.match(st4, /openspec-archive-principles\.md[^\n]*同形[^\n]*只差時限/, "urgent and non-urgent share the existing independently urgent supplement shape and differ only in the deadline");
  assert.match(st4, /帶[^\n]*全部 artifacts[^\n]*首次 archive/, "the supplement PR carries every artifact together with the first archive of the change");
  assert.match(st4, /不併入[^\n]*步驟 3[^\n]*repair 分支/, "never on the step 3 repair branch");
  const acceptLine = exitCriteria.split("\n").find((l) => l.startsWith("- 事故補救（接受）")) ?? "";
  assert.match(acceptLine, /事故 PR 的 PR body[^\n]*事故記錄/, "the accept exit line names the incident PR body");
});

test("Lite Record Rides The Incident Pull Request Or Hands Back", () => {
  const st4 = step["4"] ?? "";
  assert.match(st4, /lite[^\n]*事故 PR[^\n]*PR body/, "lite fields and QA evidence live in the incident PR body");
  assert.match(st4, /no-op[^\n]*full[^\n]*補件 PR[^\n]*事故 PR/, "step 3 no-op under full: the supplement PR is the incident PR");
  assert.match(st4, /no-op[^\n]*lite[^\n]*停下交回[^\n]*不自行造空 PR/, "step 3 no-op under lite: stop and hand back, never open an empty PR");
  assert.match(st4, /使用者指定的 PR 即視為事故 PR/, "the PR the user names after a lite hand-back is the incident PR");
  assert.match(step["5"] ?? "", /接受時[^\n]*事故 PR[^\n]*PR body/, "accepting: the incident record goes in the incident PR body");
  assert.match(step["5"] ?? "", /回退時寫在回退 carrier 的 PR body/, "reverting: unchanged, the revert carrier PR body");
});

test("Deferred Completion States Its Four Elements", () => {
  const text = step["4"] ?? "";
  assert.match(text, /前提[^\n]*時限[^\n]*責任人[^\n]*驗收輸出/);
  assert.match(text, /下一次 release carrier 組裝前/, "deadline is an event, not a day count");
  assert.match(text, /合併該 PR 的人/, "owner is the merger of the incident PR");
  assert.match(text, /non-urgent[^\n]*不適用[^\n]*24h/);
});

test("Independently Urgent Incident Keeps The 24-Hour Deadline", () => {
  const text = step["4"] ?? "";
  assert.match(text, /independently urgent[^\n]*24h/);
  assert.match(text, /輸出集合[^\n]*相同|相同[^\n]*輸出/, "same output set as a non-urgent change");
});

// ---------------------------------------------------------------------------
// §4 — rigor × urgency × merge phase matrix (8 cells)
// ---------------------------------------------------------------------------
const MATRIX = {
  "lite|non-urgent": { before: [/PR body/, /實作前/], after: [/PR body/, /QA/, /下一次 release carrier 組裝前/] },
  "lite|urgent": { before: [/PR body/, /24h/], after: [/PR body/, /QA/, /24h/] },
  "full|non-urgent": { before: [/proposal/, /spec delta/, /實作前/], after: [/proposal/, /spec delta/, /QA/, /archive/, /下一次 release carrier 組裝前/] },
  "full|urgent": { before: [/proposal/, /spec delta/, /24h/], after: [/proposal/, /spec delta/, /QA/, /archive/, /24h/] },
};

test("§4 merge-after column is scoped to acceptance and points a revert at §3", () => {
  const header = s4.split("\n").find((l) => /^\|\s*rigor\s*·\s*urgency\s*\|/.test(l));
  assert.ok(header, "§4 table header row");
  const after = header.split("|").map((c) => c.trim()).filter(Boolean)[2];
  assert.match(after, /接受時/, "merge-after outputs apply when the change is accepted");
  assert.match(after, /回退見 §3 步驟 2、5/, "a revert is routed to §3 steps 2 and 5, not to the spec delta and archive outputs");
});

test("§4 matrix has the 8 cells and each cell carries its required evidence", () => {
  const rows = s4.split("\n").filter((l) => /^\|\s*(lite|full)\s*·\s*(non-urgent|urgent)\s*\|/.test(l));
  assert.equal(rows.length, 4, "four rigor × urgency rows");
  let cells = 0;
  for (const row of rows) {
    const parts = row.split("|").map((c) => c.trim()).filter(Boolean);
    const [label, before, after] = parts;
    const key = label.replace(/\s*·\s*/, "|");
    assert.ok(MATRIX[key], `unexpected row ${label}`);
    for (const [phase, text] of [["before", before], ["after", after]]) {
      assert.ok(text && text.length > 0, `${key} ${phase} cell is empty`);
      cells += 1;
      for (const re of MATRIX[key][phase]) assert.match(text, re, `${key} ${phase} must match ${re}`);
    }
  }
  assert.equal(cells, 8);
});

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------
test("Customer-Side Already-Live Change Routes To The Backfill Record", () => {
  const front = routing.split("\n---\n")[0];
  assert.match(front, /回補/);
  assert.match(front, /同步已上線/);
  const pre = routing.split("\n").find((l) => l.includes("release-already-live-backfill.md") && /Rule #2/.test(l));
  assert.ok(pre, "routing must carry a pre-check line that sends customer-side already-live changes to the leaf, not Rule #2");
  assert.match(pre, /不走 Rule #2／#5 的 `bugfix\/`/, "routing and §1 cite the same two rules");
  // Rule numbering that hook-branch-routing-cite-gate relies on stays put.
  assert.match(routing, /^\| 4 \| tip 未被/m);
  assert.match(routing, /^\| 5 \| tip 已被/m);
  const prodRow = naming.split("\n").find((l) => l.includes("**最近 `production-*` tag（僅此）**"));
  assert.ok(prodRow?.includes("release-already-live-backfill.md"), "the naming production-tag row points at the leaf");
  assert.match(naming, /prefix 表示 promotion path\/state，非作者/, "the locked wording elsewhere in the naming rule stays");
  assert.ok(agents.includes("合 main；production 只經 release carrier"));
  assert.ok(!agents.includes("合main/production"), "AGENTS.md no longer reads like a direct merge into production");
  assert.match(agents, /回補/, "AGENTS.md carries the trigger word");
});

test("the leaf is referenced by at least one entry rule", () => {
  const referrers = [routing, naming, read(".devpro/agent-rules/release-hotfix-carrier-policy.md")].filter((t) =>
    t.includes("release-already-live-backfill.md"),
  );
  assert.ok(referrers.length >= 3, "routing, naming and the carrier policy all point at the leaf");
});
