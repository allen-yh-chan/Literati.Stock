import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { sourcePath } from "./lib/source-root.mjs";
import { git } from "./lib/git.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const readme = readFileSync(sourcePath("README.md"), "utf8");
const branchRule = readFileSync(
  sourcePath(".devpro/agent-rules/git-branch-naming-and-anchor.md"),
  "utf8",
);
const evidenceLeaf = readFileSync(
  sourcePath(".devpro/agent-rules/git-branch-no-tag-ancestry-evidence.md"),
  "utf8",
);
// Forbidden probe mechanics must be absent from the entry and the evidence leaf alike.
const noTagRuleCorpus = `${branchRule}\n${evidenceLeaf}`;
const routingRule = readFileSync(
  sourcePath(".devpro/agent-rules/rules-flow-routing.md"),
  "utf8",
);
const releaseRulesLane = readFileSync(
  sourcePath(".devpro/agent-rules/release-rules-lane.md"),
  "utf8",
);
const fileWriteDestinations = readFileSync(
  sourcePath(".devpro/agent-rules/file-write-destinations.md"),
  "utf8",
);

function sectionBetween(start, end) {
  const startIndex = readme.indexOf(start);
  const endIndex = readme.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `README missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `README missing section end: ${end}`);
  return readme.slice(startIndex, endIndex);
}

const bootstrap = sectionBetween("### 首次導入／同步", "### 每次開新對話");
const sourceBranchStrategy = sectionBetween("## 分支策略（中心 repo 側）", "### Release 流程（release → production）");
const sourceRelease = sectionBetween("### Release 流程（release → production）", "## 維護指引");


const devproGitmodulesPathLinePattern =
  '^[[:space:]]*path[[:space:]]*=[[:space:]]*([.]devpro-agent-rules|"[.]devpro-agent-rules")[[:space:]]*$';

function devproHistoryProbes(cwd) {
  return {
    path: git(cwd, "log", "--all", "--format=%H", "--", ".devpro-agent-rules"),
    gitmodules: git(
      cwd,
      "log",
      "--all",
      "--format=%H",
      `-G${devproGitmodulesPathLinePattern}`,
      "--",
      ".gitmodules",
    ),
  };
}

function adoptDevproCarriers(repo) {
  mkdirSync(path.join(repo, ".devpro-agent-rules"), { recursive: true });
  writeFileSync(
    path.join(repo, ".gitmodules"),
    '[submodule ".devpro-agent-rules"]\n\tpath = ".devpro-agent-rules"\n\turl = https://example.invalid/devpro-agent-rules.git\n',
  );
  writeFileSync(path.join(repo, ".devpro-agent-rules", "carrier.txt"), "adopted\n");
  git(repo, "add", ".gitmodules", ".devpro-agent-rules/carrier.txt");
  git(repo, "commit", "-m", "adopt rules");
}

/** Joint four-item promotion blockers (item 3 ∪ 4(a) ∪ 4(b)) — not a message 4(c). */
function evalJointPromotionBlockers(cwd) {
  const localTags = git(cwd, "tag", "-l", "production-*");
  const remoteTags = git(cwd, "ls-remote", "--tags", "origin", "refs/tags/production-*");
  const releaseRefs = git(
    cwd,
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads/release/",
    "refs/remotes/origin/release/",
  );
  const hasProduction = spawnSync("git", ["rev-parse", "--verify", "refs/remotes/origin/production"], {
    cwd,
    encoding: "utf8",
  }).status === 0
    || spawnSync("git", ["rev-parse", "--verify", "refs/heads/production"], {
      cwd,
      encoding: "utf8",
    }).status === 0;

  let mainAheadOfProd = "0";
  if (hasProduction) {
    const mainRef =
      spawnSync("git", ["rev-parse", "--verify", "refs/remotes/origin/main"], {
        cwd,
        encoding: "utf8",
      }).status === 0
        ? "refs/remotes/origin/main"
        : "refs/heads/main";
    const prodRef =
      spawnSync("git", ["rev-parse", "--verify", "refs/remotes/origin/production"], {
        cwd,
        encoding: "utf8",
      }).status === 0
        ? "refs/remotes/origin/production"
        : "refs/heads/production";
    mainAheadOfProd = git(cwd, "rev-list", "--count", `${mainRef}..${prodRef}`);
  }

  const item3Fail = localTags !== "" || remoteTags !== "";
  const item4aFail = releaseRefs !== "";
  const item4bFail = hasProduction && mainAheadOfProd !== "0";
  return {
    pass: !(item3Fail || item4aFail || item4bFail),
    item3Fail,
    item4aFail,
    item4bFail,
    localTags,
    remoteTags,
    releaseRefs,
    mainAheadOfProd,
  };
}

test("README gates a legal latest consumer production tag before ordinary bootstrap", () => {
  assert.match(
    bootstrap,
    /--require-main-ancestor --production-ref <production-tag> --main-ref origin\/main/,
    "bootstrap must invoke the portable gate with the exact legal consumer production tag",
  );
  assert.match(bootstrap, /legal latest consumer production tag|合法 latest consumer production tag/);
  assert.match(bootstrap, /不得.*(?:fallback|退回).*`?origin\/main`?.*繼續.*(?:普通|normal)/);
});

test("README routes divergence to reconciliation classification before repair", () => {
  assert.match(bootstrap, /git-branch-naming-and-anchor\.md/);
  assert.match(bootstrap, /reconciliation classification/);
  assert.match(bootstrap, /--reconciliation-status/);
  assert.match(bootstrap, /分類完成前不得宣告/);
  assert.match(bootstrap, /bounded production-ancestry repair|bounded ancestry repair|有界.*ancestry repair/);
  assert.match(bootstrap, /bugfix\/fix-production-ancestry-<production-tag>/);
});

test("README records genuine no-tag first import as N/A without fabrication", () => {
  assert.match(bootstrap, /(?:genuine no-tag first import|真正.*無.*production tag)/);
  assert.match(bootstrap, /ancestry gate.*N\/A/);
  assert.match(bootstrap, /不得.*(?:fabricate|infer|捏造|推論).*production tag/);
  assert.match(bootstrap, /(?:gitlink|\.devpro-agent-rules).*(?:\.gitmodules|adoption evidence|導入證據)/s);
  assert.match(bootstrap, /local.*remote.*(?:合法|legal).*production tag.*(?:均無|都沒有)/s);
  assert.match(bootstrap, /已導入.*(?:缺失|缺少|找不到).*production tag.*停下.*(?:漏抓|誤刪|歷史)/s);
  assert.match(bootstrap, /不得.*(?:N\/A.*(?:bypass|繞過)|(?:bypass|繞過).*N\/A)/s);
  assert.match(bootstrap, /(?:reachable history|可達歷史).*(?:adoption evidence|導入證據)/s);
  assert.match(bootstrap, /unrelated.*\.gitmodules.*(?:不|not).*(?:adoption evidence|導入證據)/s);
  assert.match(bootstrap, /history (?:probe|scan).*(?:失敗|ambiguous|不明確).*(?:fail closed|停下)/s);
  assert.match(
    bootstrap,
    /is-shallow-repository.*literal `false`.*(?:接受|判定|accept).*(?:empty|無輸出).*history (?:probe|scan)/s,
  );
  assert.match(
    bootstrap,
    /literal `true`.*git fetch --unshallow origin.*(?:重驗|recheck).*literal `false`.*(?:重跑|rerun).*history (?:probe|scan)/s,
  );
  assert.match(
    bootstrap,
    /is-shallow-repository.*(?:失敗|其他|ambiguous|不明確).*(?:fail closed|停下)/s,
  );

  const fetchIndex = bootstrap.indexOf("git fetch origin --tags");
  const noTagIndex = bootstrap.indexOf("ancestry gate: N/A");
  assert.notEqual(fetchIndex, -1, "bootstrap must fetch tags before evaluating genuine no-tag");
  assert.ok(fetchIndex < noTagIndex, "genuine no-tag N/A must be evaluated only after fetching tags");
});

test("no-tag evidence leaf requires exact consumer first-import evidence", () => {
  const pathHistoryCommand = "`git log --all --format=%H -- .devpro-agent-rules`";
  const gitmodulesHistoryCommand =
    "`git log --all --format=%H -G'^[[:space:]]*path[[:space:]]*=[[:space:]]*([.]devpro-agent-rules|\"[.]devpro-agent-rules\")[[:space:]]*$' -- .gitmodules`";

  for (const evidence of [
    /git ls-tree origin\/main -- \.devpro-agent-rules/,
    /160000/,
    /git show origin\/main:\.gitmodules/,
    /git tag -l 'production-\*'/,
    /git ls-remote --tags origin 'refs\/tags\/production-\*'/,
  ]) {
    assert.match(evidenceLeaf, evidence);
  }
  assert.ok(evidenceLeaf.includes(pathHistoryCommand), "evidence leaf must probe only Devpro path history");
  assert.ok(
    evidenceLeaf.includes(gitmodulesHistoryCommand),
    "evidence leaf must use an exact, whitespace/quote-tolerant Devpro .gitmodules path-line probe",
  );
  assert.doesNotMatch(
    noTagRuleCorpus,
    /git log --all --format=%H -- \.gitmodules \.devpro-agent-rules/,
    "generic .gitmodules history must not count as Devpro adoption",
  );
  assert.match(evidenceLeaf, /只有.*(?:四項|全部).*證據.*(?:N\/A|genuine no-tag first import)/s);
  assert.match(evidenceLeaf, /history (?:probe|scan).*(?:失敗|ambiguous|不明確).*(?:fail closed|停下)/s);
  assert.match(evidenceLeaf, /已導入.*(?:缺失|缺少|找不到).*production tag.*(?:fail closed|停下)/s);
  assert.match(evidenceLeaf, /(?:N\/A.*(?:bypass|繞過)|(?:bypass|繞過).*N\/A)/s);
  assert.match(
    evidenceLeaf,
    /`git rev-parse --is-shallow-repository`.*literal `false`.*(?:接受|判定|accept).*(?:empty|無輸出).*history (?:probe|scan)/s,
  );
  assert.match(
    evidenceLeaf,
    /literal `true`.*`git fetch --unshallow origin`.*(?:重驗|recheck).*literal `false`.*(?:重跑|rerun).*(?:兩個|第 4、5 項).*history (?:probes|probe|scan)/s,
  );
  assert.match(
    evidenceLeaf,
    /is-shallow-repository.*(?:失敗|其他|ambiguous|不明確).*(?:fail closed|停下)/s,
  );
});

test("historical adoption blocks no-tag N/A after current carriers disappear", () => {
  const fixtureRoot = makeTempDir("devpro-historical-adoption-");
  const repo = path.join(fixtureRoot, "consumer");
  const remote = path.join(fixtureRoot, "origin.git");

  try {
    git(fixtureRoot, "init", "--bare", remote);
    git(fixtureRoot, "init", "-b", "main", repo);
    git(repo, "config", "user.name", "Devpro Test");
    git(repo, "config", "user.email", "devpro-test@example.invalid");

    mkdirSync(path.join(repo, ".devpro-agent-rules"));
    writeFileSync(
      path.join(repo, ".gitmodules"),
      '[submodule ".devpro-agent-rules"]\n\tpath  =  ".devpro-agent-rules"  \n\turl = https://example.invalid/devpro-agent-rules.git\n',
    );
    writeFileSync(path.join(repo, ".devpro-agent-rules", "carrier.txt"), "historical adoption\n");
    git(repo, "add", ".gitmodules", ".devpro-agent-rules/carrier.txt");
    git(repo, "commit", "-m", "adopt rules");

    rmSync(path.join(repo, ".gitmodules"));
    rmSync(path.join(repo, ".devpro-agent-rules"), { recursive: true });
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "remove current carriers");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "main");
    git(repo, "fetch", "origin", "--tags");

    assert.equal(git(repo, "ls-tree", "origin/main", "--", ".devpro-agent-rules"), "");
    assert.notEqual(
      spawnSync("git", ["show", "origin/main:.gitmodules"], { cwd: repo }).status,
      0,
      "current origin/main must no longer contain .gitmodules",
    );
    assert.equal(git(repo, "tag", "-l", "production-*"), "");
    assert.equal(git(repo, "ls-remote", "--tags", "origin", "refs/tags/production-*"), "");

    const historicalAdoption = devproHistoryProbes(repo);
    assert.notEqual(historicalAdoption.path, "", "Devpro path history must block no-tag N/A");
    assert.notEqual(
      historicalAdoption.gitmodules,
      "",
      "quoted Devpro .gitmodules path-line history must block no-tag N/A",
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("unrelated historical submodule remains eligible for genuine first-import N/A", () => {
  const fixtureRoot = makeTempDir("devpro-unrelated-submodule-");
  const repo = path.join(fixtureRoot, "consumer");
  const remote = path.join(fixtureRoot, "origin.git");

  try {
    git(fixtureRoot, "init", "--bare", remote);
    git(fixtureRoot, "init", "-b", "main", repo);
    git(repo, "config", "user.name", "Devpro Test");
    git(repo, "config", "user.email", "devpro-test@example.invalid");

    mkdirSync(path.join(repo, "vendor-unrelated"));
    writeFileSync(
      path.join(repo, ".gitmodules"),
      '[submodule "vendor-unrelated"]\n\tpath = "vendor-unrelated"\n\turl = https://example.invalid/vendor-unrelated.git\n',
    );
    writeFileSync(path.join(repo, "vendor-unrelated", "carrier.txt"), "unrelated submodule\n");
    git(repo, "add", ".gitmodules", "vendor-unrelated/carrier.txt");
    git(repo, "commit", "-m", "adopt unrelated submodule");

    rmSync(path.join(repo, ".gitmodules"));
    rmSync(path.join(repo, "vendor-unrelated"), { recursive: true });
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "remove unrelated submodule carriers");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "main");
    git(repo, "fetch", "origin", "--tags");

    assert.equal(git(repo, "ls-tree", "origin/main", "--", ".devpro-agent-rules"), "");
    assert.notEqual(spawnSync("git", ["show", "origin/main:.gitmodules"], { cwd: repo }).status, 0);
    assert.equal(git(repo, "tag", "-l", "production-*"), "");
    assert.equal(git(repo, "ls-remote", "--tags", "origin", "refs/tags/production-*"), "");
    assert.notEqual(
      git(repo, "log", "--all", "--format=%H", "--", ".gitmodules"),
      "",
      "fixture must contain generic .gitmodules history",
    );

    const devproHistory = devproHistoryProbes(repo);
    assert.equal(devproHistory.path, "", "unrelated history must not match the Devpro path probe");
    assert.equal(
      devproHistory.gitmodules,
      "",
      "unrelated .gitmodules history must not match the Devpro content probe",
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("shallow history cannot prove genuine first-import N/A", () => {
  const fixtureRoot = makeTempDir("devpro-shallow-history-");
  const seed = path.join(fixtureRoot, "seed");
  const shallow = path.join(fixtureRoot, "shallow-consumer");
  const remote = path.join(fixtureRoot, "origin.git");

  try {
    git(fixtureRoot, "init", "--bare", "--initial-branch=main", remote);
    git(fixtureRoot, "init", "-b", "main", seed);
    git(seed, "config", "user.name", "Devpro Test");
    git(seed, "config", "user.email", "devpro-test@example.invalid");

    mkdirSync(path.join(seed, ".devpro-agent-rules"));
    writeFileSync(
      path.join(seed, ".gitmodules"),
      '[submodule ".devpro-agent-rules"]\n\tpath = ".devpro-agent-rules"\n\turl = https://example.invalid/devpro-agent-rules.git\n',
    );
    writeFileSync(path.join(seed, ".devpro-agent-rules", "carrier.txt"), "historical adoption\n");
    git(seed, "add", ".gitmodules", ".devpro-agent-rules/carrier.txt");
    git(seed, "commit", "-m", "adopt rules before shallow boundary");

    rmSync(path.join(seed, ".gitmodules"));
    rmSync(path.join(seed, ".devpro-agent-rules"), { recursive: true });
    git(seed, "add", "-A");
    git(seed, "commit", "-m", "remove current carriers");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-u", "origin", "main");

    git(
      fixtureRoot,
      "clone",
      "--depth=1",
      "--branch",
      "main",
      pathToFileURL(remote).href,
      shallow,
    );

    assert.equal(git(shallow, "rev-parse", "--is-shallow-repository"), "true");
    assert.equal(git(shallow, "ls-tree", "origin/main", "--", ".devpro-agent-rules"), "");
    assert.notEqual(spawnSync("git", ["show", "origin/main:.gitmodules"], { cwd: shallow }).status, 0);
    assert.equal(git(shallow, "tag", "-l", "production-*"), "");
    assert.equal(git(shallow, "ls-remote", "--tags", "origin", "refs/tags/production-*"), "");

    const incompleteHistory = devproHistoryProbes(shallow);
    assert.equal(incompleteHistory.path, "", "shallow Devpro path history is deceptively empty");
    assert.equal(
      incompleteHistory.gitmodules,
      "",
      "shallow Devpro .gitmodules history is deceptively empty",
    );
    assert.notEqual(
      git(shallow, "rev-parse", "--is-shallow-repository"),
      "false",
      "empty probes cannot establish N/A while history is shallow",
    );

    git(shallow, "fetch", "--unshallow", "origin");
    assert.equal(git(shallow, "rev-parse", "--is-shallow-repository"), "false");

    const completeHistory = devproHistoryProbes(shallow);
    assert.notEqual(completeHistory.path, "", "unshallow must restore Devpro path history");
    assert.notEqual(
      completeHistory.gitmodules,
      "",
      "unshallow must restore Devpro .gitmodules path-line history",
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("README source release branch row delegates finite-subset base selection", () => {
  const releaseRow = sourceBranchStrategy
    .split("\n")
    .find((line) => line.includes("`release/v<X.Y.Z>`"));

  assert.ok(releaseRow, "README must retain the source release branch row");
  assert.doesNotMatch(releaseRow, /從\s*`?main`?\s*建立/);
  assert.match(releaseRow, /canonical.*(?:leaf|規則)/i);
  assert.match(releaseRow, /(?:finite|有限).*subset.*latest.*production-v\*/i);
  assert.match(releaseRow, /only approved.*(?:ref|SHA)|僅.*核准.*(?:ref|SHA)/i);
  assert.match(releaseRow, /(?:first-no-tag|首次無 tag).*(?:full-main).*(?:明示|explicit).*例外/i);
});

test("README source release routes exact promoted-tag completion to canonical leaves", () => {
  for (const leaf of ["release-rules-lane.md", "release-sit-uat-pat-prod.md"]) {
    assert.match(sourceRelease, new RegExp(leaf.replaceAll(".", "\\.")), `missing ${leaf}`);
  }
  assert.match(sourceRelease, /exact promoted tag|確切 promoted tag|本次 promoted tag/);
  assert.match(sourceRelease, /--require-main-ancestor/);
  assert.match(sourceRelease, /不得.*(?:tag.*checkout.*main|checkout.*main.*tag).*(?:完成|complete)/s);
});

test("README delegates production tag selection instead of copying its procedure", () => {
  assert.match(
    bootstrap,
    /git ls-remote --tags <source-url> 'production-v\*'/,
    "genuine first import must retain source production-v* SemVer discovery before leaves are readable",
  );
  assert.doesNotMatch(
    bootstrap,
    /git (?:tag|for-each-ref|ls-remote)[^\n]*production-(?!v\*)(?:<?YYYYMMDD>?|\d{8}|\.\.\.|\*)[^\n]*/,
    "bootstrap must delegate consumer date/rules production tag selection to canonical leaves",
  );
});

test("README delegates ancestry repair branch creation and merge mechanics", () => {
  assert.doesNotMatch(
    bootstrap,
    /git (?:checkout|switch|worktree add)[^\n]*fix-production-ancestry/,
    "bootstrap must not duplicate repair branch creation commands",
  );
  assert.doesNotMatch(
    bootstrap,
    /git merge[^\n]*(?:production-tag|production-v|production-\d)/,
    "bootstrap must not duplicate repair merge commands",
  );
});

test("README delegates source release mechanics to canonical leaves", () => {
  assert.doesNotMatch(
    sourceRelease,
    /git (?:checkout|switch|worktree add|merge|tag|push)[^\n]*(?:production|release\/)/,
    "source release entry must route instead of freezing release commands",
  );
});

test("README fails closed when the production PR target is absent", () => {
  assert.match(bootstrap, /production target absent/);
  assert.match(bootstrap, /repository administration[^\n]*(?:protected|受保護)[^\n]*(?:pull-request-capable|PR-capable|pull request)/i);
  assert.match(bootstrap, /(?:MUST NOT|不得)[^\n]*(?:create|建立|push|推送)[^\n]*(?:missing|缺少|不存在)[^\n]*production/i);
  assert.doesNotMatch(bootstrap, /^\s*git push -u origin production\s*$/m);
  assert.doesNotMatch(bootstrap, /^\s*git push origin main:production\s*$/m);
});

test("branch entry routes the no-tag N/A decision to the evidence leaf without copying it", () => {
  const pointers = branchRule
    .split("\n")
    .filter((line) => line.startsWith("> Load-chain（") && line.includes("git-branch-no-tag-ancestry-evidence.md"));
  assert.equal(pointers.length, 1, "entry must carry exactly one Load-chain line naming the evidence leaf");
  assert.match(
    pointers[0],
    /缺 tag 時 MUST 先讀 `git-branch-no-tag-ancestry-evidence\.md`[^\n]*MUST NOT 記錄 `ancestry gate: N\/A` 或 `ancestry gate: N\/A \(pre-first-release\)`[^\n]*fail closed/,
    "entry pointer must force the leaf read before either N/A recording phrase",
  );
  assert.match(
    branchRule,
    /缺 tag → Evaluation order：first-import 七項 → `ancestry gate: N\/A`；否則 pre-first-release 四項 → `ancestry gate: N\/A \(pre-first-release\)`；否則 fail closed/,
    "entry step 3 must keep the no-tag evaluation order",
  );
  for (const moved of [
    "git ls-tree origin/main -- .devpro-agent-rules",
    "**No promotion history：**",
    "#### Consumer genuine no-tag first import 證據",
    "#### Consumer adopted pre-first-release 證據",
  ]) {
    assert.ok(!branchRule.includes(moved), `entry must not keep a copy of moved evidence: ${moved}`);
    assert.ok(evidenceLeaf.includes(moved), `evidence leaf must carry: ${moved}`);
  }
});

test("four-state no-tag matrix: (a) first-import N/A remains distinct", () => {
  assert.match(
    evidenceLeaf,
    /genuine no-tag first import` 並記錄 `ancestry gate: N\/A`/,
    "first-import path must keep bare ancestry gate: N/A",
  );
  assert.doesNotMatch(
    noTagRuleCorpus,
    /genuine no-tag first import` 並記錄 `ancestry gate: N\/A \(pre-first-release\)`/,
    "first-import must not reuse the pre-first-release recording phrase",
  );
  assert.match(bootstrap, /(?:genuine no-tag first import|真正.*無.*production tag)/);
  assert.match(bootstrap, /ancestry gate: N\/A/);
});

test("four-state no-tag matrix: (b) adopted pre-first-release uses distinct recording phrase", () => {
  assert.match(evidenceLeaf, /adopted, pre-first-release/);
  assert.match(evidenceLeaf, /ancestry gate: N\/A \(pre-first-release\)/);
  assert.match(
    branchRule,
    /^# adopted, pre-first-release（四項證據）→ ancestry gate: N\/A \(pre-first-release\)$/m,
    "entry Worktree comment must keep the four-evidence pre-first-release outcome",
  );
  assert.match(
    evidenceLeaf,
    /四項全過才可判定；任一缺／ambiguous → fail closed/,
    "evidence leaf must require the full four-evidence set",
  );
  assert.doesNotMatch(evidenceLeaf, /notes\/pre-first-release-confirm\.md/,
    "ephemeral clones must not depend on a clone-local confirmation file");
  assert.match(evidenceLeaf, /MUST NOT[^\n]*確認檔[^\n]*config[^\n]*GitHub variable/);
  assert.match(
    bootstrap,
    /(?:adopted,? pre-first-release|pre-first-release|尚未第一次正式上 PROD)/,
    "README step 2a must cite-only acknowledge the second legal no-tag state",
  );
  assert.match(bootstrap, /四項 repository 證據以[^。；]*`git-branch-no-tag-ancestry-evidence\.md`[^。；]*為準/);
  assert.doesNotMatch(
    bootstrap,
    /git for-each-ref[^\n]*refs\/(?:heads|remotes\/origin)\/release\//,
    "README must not rewrite promotion-history probe mechanics",
  );
  assert.doesNotMatch(
    bootstrap,
    /confirmed:\s*true/,
    "README must not embed confirm-file schema mechanics",
  );
});

test("four-state no-tag matrix: (c) residual adopted missing-tag stays fail-closed", () => {
  assert.match(
    evidenceLeaf,
    /已導入.*(?:缺失|缺少|找不到).*production tag.*(?:fail closed|停下)/s,
  );
  assert.match(
    evidenceLeaf,
    /(?:不符合|非).*(?:pre-first-release|第二合法)|pre-first-release.*(?:不成立|缺一|任一).*(?:fail closed|停下)/s,
  );
  assert.match(
    bootstrap,
    /已導入.*(?:缺失|缺少|找不到).*production tag.*停下.*(?:漏抓|誤刪|歷史)/s,
  );
  assert.match(bootstrap, /不得.*(?:N\/A.*(?:bypass|繞過)|(?:bypass|繞過).*N\/A)/s);
  assert.match(
    routingRule,
    /abort: no production-\* tag/,
    "rules-flow-routing residual no-tag path must still abort",
  );
});

test("four-state no-tag matrix: (d) promote Step 2 first-rules-release; no acknowledgement bypass", () => {
  // G1 #2634: zero-tag path is first-rules-release (production tip), not sole hard abort
  // and not the pre-first-release acknowledgement N/A bypass.
  assert.match(
    releaseRulesLane,
    /# Step 2：有 tag → 用 TAG；零 tag → first-rules-release/,
  );
  assert.match(releaseRulesLane, /first-rules-release|FIRST_BASE/);
  assert.match(
    releaseRulesLane,
    /production target absent: repository administration must establish a protected, pull-request-capable production base/,
  );
  assert.doesNotMatch(
    releaseRulesLane,
    /\[ -z "\$TAG" \] && \{ echo "abort: no production-\* tag"; exit 1; \}/,
    "sole hard abort without first-rules-release branch must not remain",
  );
  // A grep guard cannot prove arbitrary prose semantics; retain explicit boundary plus
  // permanent violating/permitted fixtures for the formerly unguarded grant wording.
  // Literal release/promote substrings count except the pre-first-release marker itself;
  // no stemming: releasing/promoting/promotion lack those literal tokens.
  // Negation covers only the listed adjacent plain-text forms, not Markdown emphasis,
  // intervening words (不得以), 禁止/不能, or MUST NOT without following whitespace.
  const bypass = /^(?=[^\r\n]*pre-first-release)(?=[^\r\n]*N\/A)(?=[^\r\n]*(?:(?<!pre-first-)release|promote))(?=[^\r\n]*(?<!\bMUST[ \t]+NOT[ \t]+)(?:(?<!不)(?:允許|可|得)|\bmay\b(?![ \t]+not\b)|(?<!不得|不可|不允許)跳過))[^\r\n]*$/im;
  assert.doesNotMatch(releaseRulesLane, bypass);
  for (const grant of ["允許", "可", "得", "MAY", "may", "跳過"]) {
    for (const line of [`${grant} pre-first-release 用 N/A 直接 release`, `pre-first-release ${grant} 用 N/A 直接 release`]) {
      assert.match(line, bypass, `the guard must reject a ${grant} promotion bypass`);
    }
  }
  for (const line of [
    "MUST NOT 自動 release；pre-first-release 的 N/A 不豁免 release gates。",
    "不可因 pre-first-release 的 N/A 略過 release gates。",
    "pre-first-release 不得因 N/A 略過 release gates。",
    "pre-first-release MAY NOT use N/A to release。",
    "pre-first-release 不得跳過 N/A release gates。",
    "允許 pre-first-release 使用 N/A 作為同步完成紀錄。",
    "MUST NOT 跳過 pre-first-release N/A release gates。",
    "MUST NOT 允許 pre-first-release N/A 直接 release。",
    "不可跳過 pre-first-release N/A release gates。",
    "不允許跳過 pre-first-release N/A release gates。",
    "允許 pre-first-release 用 N/A releasing",
    "允許 pre-first-release 用 N/A promoting",
    "允許 pre-first-release 用 N/A promotion",
    "允許 pre-first-release\rN/A 直接 release",
    "允許 pre-first-release\nN/A 直接 release",
  ]) assert.doesNotMatch(line, bypass);
  for (const newline of ["\n", "\r\n"]) {
    assert.match(`header${newline}允許 pre-first-release 用 N/A 直接 release${newline}footer`, bypass,
      "the guard must detect a violation inside multiline LF/CRLF prose");
  }
  for (const line of [
    "允許 pre-first-release 用 N/A 跳過 release-gates",
    "pre-first-release 可用 N/A 直接 first-rules-release",
    "允許 pre-first-release 用 N/A released",
    "允許 pre-first-release 用 N/A promoted",
    "允許 pre-first-release 用 N/A auto-promote",
    "允許 pre-first-release 用 N/A autopromote",
  ]) assert.match(line, bypass);
  for (const newline of ["\n", "\r", "\r\n"]) {
    assert.match(`pre-first-release 用 N/A 直接 release may${newline}not`, bypass);
    assert.match(`MUST${newline}NOT 允許 pre-first-release 用 N/A 直接 release`, bypass);
    assert.match(`MUST NOT${newline}允許 pre-first-release 用 N/A 直接 release`, bypass);
    // Isolate each lookahead: only its required token is on the other line.
    for (const line of [
      `允許 用 N/A 直接 release${newline}pre-first-release`,
      `允許 pre-first-release 直接 release${newline}N/A`,
      `允許 pre-first-release 用 N/A${newline}release`,
      `pre-first-release 用 N/A 直接 release${newline}允許`,
    ]) assert.doesNotMatch(line, bypass);
  }
  assert.match(releaseRulesLane, /MUST NOT[^\n]*自動[^\n]*release recipe/);
});

test("rules-flow-routing continues on pre-first-release and skips AHEAD", () => {
  assert.match(routingRule, /pre-first-release/);
  assert.match(
    routingRule,
    /ancestry gate: N\/A \(pre-first-release\)/,
  );
  assert.match(
    routingRule,
    /(?:跳過|skip).*AHEAD|AHEAD.*(?:跳過|skip)/s,
  );
  assert.match(
    routingRule,
    /abort: no production-\* tag/,
    "non-pre-first-release missing tag must still abort",
  );
  // Empty-tag fence must expose PASS/FAIL dual path (not abort-only executable).
  assert.match(
    routingRule,
    /if pre_first_release_evidence_pass;[\s\S]*else[\s\S]*abort: no production-\* tag/,
    "empty-tag fence must have PASS branch before residual abort",
  );
  assert.match(
    routingRule,
    /else\s*\n\s*AHEAD=\$\(git rev-list --count/,
    "AHEAD computation must live only in the tagged (else) branch",
  );
});

test("pre-first-release has no clone-local confirmation registration", () => {
  assert.doesNotMatch(fileWriteDestinations, /pre-first-release-confirm|devpro-pre-first-release/);
});

test("production branch/tag matrix preserves released and anomalous states", () => {
  assert.match(evidenceLeaf, /\| 有 \| 有 \| 已正式發布[^\n]*正常 production lane/);
  assert.match(evidenceLeaf, /\| 有 \| 無 \|[^\n]*四項[^\n]*pre-first-release/);
  assert.match(evidenceLeaf, /\| 無 \| 無 \|[^\n]*first-import[^\n]*pre-first-release/);
  assert.match(evidenceLeaf, /\| 無 \| 有 \|[^\n]*production target absent[^\n]*MUST NOT[^\n]*pre-first-release/);
});

test("pre-first-release sync completes only after primary alignment", () => {
  const flow = readFileSync(sourcePath(".devpro/agent-rules/rules-flow.md"), "utf8");
  assert.match(flow, /close-out 成功後[^\n]*pre-first-release[^\n]*production continuation: N\/A[^\n]*同步完成/);
  assert.match(flow, /MUST NOT[^\n]*自動[^\n]*first-rules-release/);
  assert.match(flow, /第一個業務 release[^\n]*另行[^\n]*決定/);
});

test("pre-first-release item 4(c) is negative MAIN hard-gate ban + joint authority (not positive scanner)", () => {
  assert.match(
    evidenceLeaf,
    /for-each-ref.*release\/|`for-each-ref` 無 `release\/`/,
    "4(a) live release/ for-each-ref probe must remain",
  );
  assert.match(
    evidenceLeaf,
    /rev-list --count MAIN\.\.PROD/,
    "4(b) MAIN..PROD commit-count probe must remain",
  );
  assert.match(
    evidenceLeaf,
    /禁.*MAIN `--merges --grep='release\/'` hard evidence/,
    "4(c) must forbid MAIN --merges --grep='release/' as hard evidence",
  );
  assert.match(
    evidenceLeaf,
    /completed promote 考古權威＝item 3 `production-\*` 與 4\(a\)\/4\(b\) 聯合/,
    "completed-promote authority must be item 3 jointly with 4(a)/4(b)",
  );
  assert.match(
    evidenceLeaf,
    /不另設 message／MAIN\.\.PROD-merge sole 探針/,
    "leaf MUST forbid sole message or MAIN..PROD-merge 4(c) probes",
  );
  assert.doesNotMatch(
    noTagRuleCorpus,
    /`git log MAIN --merges --grep='release\/'` 無輸出/,
    "old MAIN --merges --grep='release/' positive hard gate must be gone",
  );
  assert.doesNotMatch(
    noTagRuleCorpus,
    /git rev-list --first-parent --merges MAIN\.\.PROD/,
    "retired MAIN..PROD rev-list 4(c) must be gone",
  );
  assert.doesNotMatch(
    noTagRuleCorpus,
    /git log --first-parent PROD --merges --grep='release\/'/,
    "D1' PROD --grep positive 4(c) must be gone",
  );
  assert.doesNotMatch(
    bootstrap,
    /git log --first-parent.*--merges --grep/,
    "README cite must stay free of 4(c) probe mechanics",
  );
  assert.doesNotMatch(
    bootstrap,
    /`git log MAIN --merges --grep='release\/'`/,
    "README must not embed the retired MAIN merge-message hard gate",
  );
});

test("RED (a) ACCEPT: MAIN release/ merge message must not block when 4(a)/4(b)/tags pass", () => {
  const fixtureRoot = makeTempDir("devpro-pfr-accept-main-release-msg-");
  const repo = path.join(fixtureRoot, "consumer");
  const remote = path.join(fixtureRoot, "origin.git");

  try {
    git(fixtureRoot, "init", "--bare", remote);
    git(fixtureRoot, "init", "-b", "main", repo);
    git(repo, "config", "user.name", "Devpro Test");
    git(repo, "config", "user.email", "devpro-test@example.invalid");
    adoptDevproCarriers(repo);

    writeFileSync(path.join(repo, "app.txt"), "base\n");
    git(repo, "add", "app.txt");
    git(repo, "commit", "-m", "base app");
    const baseSha = git(repo, "rev-parse", "HEAD");

    git(repo, "branch", "production", baseSha);

    git(repo, "checkout", "-b", "release/v1.0.0");
    writeFileSync(path.join(repo, "app.txt"), "release work\n");
    git(repo, "add", "app.txt");
    git(repo, "commit", "-m", "release work");

    git(repo, "checkout", "main");
    git(repo, "merge", "--no-ff", "release/v1.0.0", "-m", "Merge branch 'release/v1.0.0'");
    git(repo, "branch", "-D", "release/v1.0.0");

    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "main");
    git(repo, "push", "origin", "production");
    git(repo, "fetch", "origin", "--tags");

    assert.equal(git(repo, "rev-parse", "--is-shallow-repository"), "false");
    assert.equal(git(repo, "tag", "-l", "production-*"), "");
    assert.equal(git(repo, "ls-remote", "--tags", "origin", "refs/tags/production-*"), "");
    assert.equal(
      git(repo, "for-each-ref", "--format=%(refname)", "refs/heads/release/", "refs/remotes/origin/release/"),
      "",
      "4(a) live release/ refs must be absent",
    );
    assert.equal(
      git(repo, "rev-list", "--count", "refs/remotes/origin/main..refs/remotes/origin/production"),
      "0",
      "4(b) MAIN..PROD must be empty for ACCEPT",
    );

    const mainReleaseMerges = git(
      repo,
      "log",
      "refs/remotes/origin/main",
      "--merges",
      "--grep=release/",
      "--format=%H",
    );
    assert.notEqual(
      mainReleaseMerges,
      "",
      "fixture must retain MAIN release/ merge-message residue (former false positive)",
    );

    assert.match(
      evidenceLeaf,
      /禁.*MAIN `--merges --grep='release\/'` hard evidence/,
      "leaf forbids MAIN hard gate → must not block ACCEPT on message alone",
    );

    const joint = evalJointPromotionBlockers(repo);
    assert.equal(joint.pass, true, "joint item3/4a/4b must pass despite MAIN release/ message");
    assert.equal(joint.item3Fail, false);
    assert.equal(joint.item4aFail, false);
    assert.equal(joint.item4bFail, false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("RED (b) REJECT: true promote via joint tags/4a/4b — not message-only 4(c)", () => {
  const fixtureRoot = makeTempDir("devpro-pfr-reject-joint-promote-");
  const repo = path.join(fixtureRoot, "consumer");
  const remote = path.join(fixtureRoot, "origin.git");

  try {
    git(fixtureRoot, "init", "--bare", remote);
    git(fixtureRoot, "init", "-b", "main", repo);
    git(repo, "config", "user.name", "Devpro Test");
    git(repo, "config", "user.email", "devpro-test@example.invalid");
    adoptDevproCarriers(repo);

    writeFileSync(path.join(repo, "app.txt"), "base\n");
    git(repo, "add", "app.txt");
    git(repo, "commit", "-m", "base app");
    const baseSha = git(repo, "rev-parse", "HEAD");

    // True promote joint evidence: live release/ + production ahead of main + legal tag
    git(repo, "checkout", "-b", "release/v1.0.0");
    writeFileSync(path.join(repo, "app.txt"), "release work\n");
    git(repo, "add", "app.txt");
    git(repo, "commit", "-m", "release work");

    git(repo, "branch", "production", baseSha);
    git(repo, "checkout", "production");
    git(repo, "merge", "--no-ff", "release/v1.0.0", "-m", "Merge release/v1.0.0 into production");
    git(repo, "tag", "production-20260101");

    git(repo, "checkout", "main");
    // Keep MAIN behind production so MAIN..PROD > 0 (4(b) fail); leave release/ live (4(a) fail)
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "main");
    git(repo, "push", "origin", "production");
    git(repo, "push", "origin", "release/v1.0.0");
    git(repo, "push", "origin", "tag", "production-20260101");
    git(repo, "fetch", "origin", "--tags");

    assert.notEqual(
      git(repo, "for-each-ref", "--format=%(refname)", "refs/heads/release/", "refs/remotes/origin/release/"),
      "",
      "fixture must keep live release/ for joint 4(a) evidence",
    );
    assert.notEqual(
      git(repo, "rev-list", "--count", "refs/remotes/origin/main..refs/remotes/origin/production"),
      "0",
      "fixture must keep MAIN..PROD>0 for joint 4(b) evidence",
    );
    assert.notEqual(git(repo, "tag", "-l", "production-*"), "", "fixture must keep legal production-* for item 3");

    const joint = evalJointPromotionBlockers(repo);
    assert.equal(joint.pass, false, "four-item joint evidence must fail on true promote");
    assert.ok(
      joint.item3Fail || joint.item4aFail || joint.item4bFail,
      "reject basis must be item3 and/or 4(a) and/or 4(b) — not message-only 4(c)",
    );
    assert.doesNotMatch(
      noTagRuleCorpus,
      /git log --first-parent PROD --merges --grep='release\/'/,
      "reject must not depend on retired D1' message 4(c)",
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("RED (c) fail-closed: contradictory tags must not become N/A", () => {
  assert.match(
    evidenceLeaf,
    /(?:不一致|inconsist).*(?:fail closed|停下)|local／remote.*(?:fail closed|停下)/s,
    "contradictory local/remote tag evidence must stay fail-closed",
  );
  assert.match(
    evidenceLeaf,
    /任一缺／ambiguous → fail closed|任一缺.*ambiguous.*fail closed/,
  );

  const fixtureRoot = makeTempDir("devpro-pfr-fail-closed-");
  const repo = path.join(fixtureRoot, "consumer");
  const remote = path.join(fixtureRoot, "origin.git");

  try {
    git(fixtureRoot, "init", "--bare", remote);
    git(fixtureRoot, "init", "-b", "main", repo);
    git(repo, "config", "user.name", "Devpro Test");
    git(repo, "config", "user.email", "devpro-test@example.invalid");
    adoptDevproCarriers(repo);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "main");
    git(repo, "fetch", "origin", "--tags");

    // Local-only legal-looking tag without remote counterpart → inconsistent evidence
    git(repo, "tag", "production-20260101");
    assert.notEqual(git(repo, "tag", "-l", "production-*"), "");
    assert.equal(git(repo, "ls-remote", "--tags", "origin", "refs/tags/production-*"), "");

    const joint = evalJointPromotionBlockers(repo);
    assert.equal(joint.item3Fail, true, "local-only production-* must fail item 3 / joint blockers");
    assert.equal(joint.pass, false);
    assert.ok(
      joint.pass === false,
      "command/evidence contradiction must fail closed — must not record ancestry gate: N/A (pre-first-release)",
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("RED (d) boundary: four-item structure, no confirmation, explicit promote boundary, README cite-only", () => {
  assert.match(evidenceLeaf, /1\.\s*\*\*Adoption[：:]/);
  assert.match(evidenceLeaf, /2\.\s*\*\*Non-shallow[：:]/);
  assert.match(evidenceLeaf, /3\.\s*\*\*No legal tags[：:]/);
  assert.match(evidenceLeaf, /4\.\s*\*\*No promotion history[：:]/);
  assert.doesNotMatch(evidenceLeaf, /5\.\s*\*\*Confirm[：:]/);
  assert.doesNotMatch(evidenceLeaf, /notes\/pre-first-release-confirm\.md/);
  assert.match(evidenceLeaf, /ancestry gate: N\/A \(pre-first-release\)/);
  assert.match(releaseRulesLane, /first-rules-release|FIRST_BASE/);
  assert.match(
    releaseRulesLane,
    /production target absent: repository administration must establish a protected, pull-request-capable production base/,
  );
  assert.doesNotMatch(
    releaseRulesLane,
    /\[ -z "\$TAG" \] && \{ echo "abort: no production-\* tag"; exit 1; \}/,
  );
  assert.match(releaseRulesLane, /MUST NOT[^\n]*自動[^\n]*release recipe/);
  assert.doesNotMatch(
    bootstrap,
    /git log --first-parent PROD --merges --grep='release\/'/,
  );
  assert.doesNotMatch(
    bootstrap,
    /git rev-list --first-parent --merges MAIN\.\.PROD/,
  );
  assert.doesNotMatch(
    routingRule,
    /`git log MAIN --merges --grep='release\/'`/,
    "routing must not reintroduce MAIN merge-message hard gate",
  );
  assert.doesNotMatch(
    noTagRuleCorpus,
    /git log --first-parent PROD --merges --grep='release\/'/,
    "leaf boundary: no PROD --grep 4(c) positive probe",
  );
  assert.doesNotMatch(
    noTagRuleCorpus,
    /git rev-list --first-parent --merges MAIN\.\.PROD/,
    "leaf boundary: no MAIN..PROD-merge sole 4(c) probe",
  );
  assert.match(
    branchRule,
    /fetch into checked-out branch/,
    "must preserve fetch into checked-out branch phrase",
  );
});

// R1 F1/F2/F3: current canonical requirements must agree with the consumer entry.
test("canonical README routing qualifies the missing production blocker", () => {
  const spec = readFileSync(sourcePath("openspec/specs/rules-flow/spec.md"), "utf8");
  const section = spec.split(/### Requirement: README Rules Bootstrap Ancestry Routing\r?\n/)[1]?.split(/\r?\n### Requirement:/)[0];
  assert.ok(section, "canonical README routing requirement must exist");
  assert.match(section, /If a legal consumer production tag exists and `origin\/production` is absent[^\n]*SHALL stop/);
  assert.match(section, /Valid no-tag[^\n]*step 2a/);
});

test("canonical README routing has no retired confirmation mechanics", () => {
  const spec = readFileSync(sourcePath("openspec/specs/rules-flow/spec.md"), "utf8");
  const section = spec.split(/### Requirement: README Rules Bootstrap Ancestry Routing\r?\n/)[1]?.split(/\r?\n### Requirement:/)[0];
  assert.ok(section);
  assert.doesNotMatch(section, /confirm-file|pre-first-release-confirm/);
});

test("canonical sync scenarios cover failed no-tag evidence after close-out", () => {
  const spec = readFileSync(sourcePath("openspec/specs/rules-flow/spec.md"), "utf8");
  const section = spec.split(/#### Scenario: Invalid No-Tag Evidence Blocks Sync Completion\r?\n/)[1]?.split(/\r?\n#### Scenario:/)[0];
  assert.ok(section, "zero-tag history failures must have an explicit scenario");
  assert.match(section, /zero legal production tags/);
  assert.match(section, /both legal no-tag evidence sets fail/);
  assert.match(section, /named history blocker/);
  assert.match(section, /MUST NOT[^\n]*complete/);
});

// R2: verify referenced entry and transition evidence, independent of spec prose.
test("README step 2a supplies the no-tag evidence entry", () => {
  assert.match(readme, /^2a\. [^\r\n]*git-branch-no-tag-ancestry-evidence\.md[^\r\n]*adopted, pre-first-release[^\r\n]*四項/m);
});

test("known lost-tag and invalid-anchor states cannot use pre-first-release", () => {
  assert.match(evidenceLeaf, /已知曾上線／tag 遺失時 MUST 停下[^\r\n]*原 promoted commit[^\r\n]*禁 N\/A bypass/);
  assert.match(evidenceLeaf, /有 production tag 卻無合法 anchor／discovery 不明時 MUST 先報 anchor blocker[^\r\n]*MUST NOT 退回 pre-first-release/);
});

test("failed no-tag evidence scenario does not require an absent production branch", () => {
  for (const spec of [readFileSync(sourcePath("openspec/specs/rules-flow/spec.md"), "utf8"), readFileSync(sourcePath("openspec/specs/rules-flow/spec.md"), "utf8").replace(/\r?\n/g, "\r\n")]) {
    const section = spec.split(/#### Scenario: Invalid No-Tag Evidence Blocks Sync Completion\r?\n/)[1]?.split(/\r?\n#### Scenario:/)[0];
    assert.ok(section);
    assert.doesNotMatch(section, /production is absent|MAIN\.\.PROD > 0/);
    assert.match(section, /both legal no-tag evidence sets fail/);
  }
});

test("first adoption without production has an explicit aligned-main completion scenario", () => {
  const spec = readFileSync(sourcePath("openspec/specs/rules-flow/spec.md"), "utf8");
  const section = spec.split(/#### Scenario: First Adoption Without Production Completes At Aligned Main\r?\n/)[1]?.split(/\r?\n#### Scenario:/)[0];
  assert.ok(section);
  assert.match(section, /first Devpro adoption[^\r\n]*aligned/);
  assert.match(section, /non-shallow[^\r\n]*local and remote[^\r\n]*zero legal production tags[^\r\n]*no live release\/ refs[^\r\n]*remote production is absent/);
  assert.match(section, /evidence items MUST all pass/);
  assert.match(section, /sync MUST complete with `production continuation: N\/A \(pre-first-release\)`/);
});
