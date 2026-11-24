import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, SOURCE_ROOT } from "./lib/repo-root.mjs";
import { ruleFilePaths, ruleFileLineCites } from "./lib/rule-file-line-cites.mjs";

// The pre-tool-mechanical-gates spec names the rule SECTION that owns a contract. A
// `<file>.md:<line>` cite goes stale on the next edit of the rule file: the conditional-leaf split
// of git-branch-naming-and-anchor.md moved every cited line. Three requirements cite that rule
// file; their cites are locked to `§<section> (` form, and each cited section must be a heading
// of the rule file.
//
// A second block (further down) covers every rule file: no line-number cite of a rule file in the
// spec or in hook sources, the section cites of three more requirements (Recap body, V2 tag, N6),
// and each hook cite bound to its own line.

const RULE_FILE = "git-branch-naming-and-anchor.md";
const spec = readFileSync(path.join(SOURCE_ROOT, "openspec/specs/pre-tool-mechanical-gates/spec.md"), "utf8");
const rule = readFileSync(path.join(REPO_ROOT, ".devpro/agent-rules", RULE_FILE), "utf8");

const CITING_REQUIREMENTS = [
  "Worktree Absolute Path Gate (Gate D)",
  "Worktree Mandatory For Branch Create Or Checkout (Gate W1)",
  "Three-Way Name Alignment (Gates W2a / W2b)",
];

function requirementBlock(text, name) {
  const lines = text.split("\n");
  const start = lines.indexOf(`### Requirement: ${name}`);
  assert.notEqual(start, -1, `requirement ${name}`);
  let end = start + 1;
  while (end < lines.length && !/^### Requirement:|^## /.test(lines[end])) end += 1;
  return lines.slice(start, end).join("\n");
}

// `anchor.md:<n>` covers both the full file name and the spec's old shorthand; a bare `:<n>` in
// backticks is the form the spec used for a second cite of the same file ("... + `:68`").
function lineNumberCites(text) {
  return text.match(/\banchor\.md\x60?:\d+(?:-\d+)?|\x60:\d+(?:-\d+)?\x60/g) ?? [];
}

// A section cite runs from `§` to the ` (` that opens its gloss.
function sectionCites(text) {
  return [...text.matchAll(/git-branch-naming-and-anchor\.md` §([^\n]*?) \(/g)].map((m) => m[1]);
}

// A cite may drop the heading's trailing full-width parenthetical ("Worktree 規範（per change，per branch）").
function citableSectionNames(ruleText) {
  const headings = ruleText.split("\n").filter((line) => /^#{2,4} /.test(line)).map((line) => line.replace(/^#+ /, ""));
  return new Set(headings.flatMap((heading) => [heading, heading.replace(/（[^（）]*）$/, "")]));
}

test("fixtures: line-number cites are caught and section cites are read whole", () => {
  assert.deepEqual(lineNumberCites("per `git-branch-naming-and-anchor.md:68` and anchor.md:66 exception"), [
    "anchor.md:68",
    "anchor.md:66",
  ]);
  assert.deepEqual(lineNumberCites("per `git-branch-naming-and-anchor.md` §Worktree 規範 (x) + `:68` (`路徑慣例`)"), ["`:68`"]);
  assert.deepEqual(lineNumberCites("per `git-branch-naming-and-anchor.md`:40-41"), ["anchor.md`:40-41"]);
  assert.deepEqual(lineNumberCites("per `git-branch-naming-and-anchor.md` §Worktree 規範 (路徑慣例), see anchor.md at 12:30"), []);
  assert.deepEqual(
    sectionCites("`git-branch-naming-and-anchor.md` §Worktree 規範 (a) + `git-branch-naming-and-anchor.md` §分支前綴對照表（唯一權威） (b)"),
    ["Worktree 規範", "分支前綴對照表（唯一權威）"]
  );
  assert.deepEqual(sectionCites("`git-branch-naming-and-anchor.md` §Worktree 守則 (a)"), ["Worktree 守則"]);
  const names = citableSectionNames("## Process\n### Worktree 規範（per change，per branch）\n### 分支前綴對照表（唯一權威）\n");
  assert.ok(names.has("Worktree 規範") && names.has("分支前綴對照表（唯一權威）") && names.has("分支前綴對照表"));
  assert.ok(!names.has("Worktree") && !names.has("Worktree 守則") && !names.has("分支"));
});

test("the rule file is not cited by line number anywhere in the spec", () => {
  assert.deepEqual(spec.match(/\banchor\.md\x60?:\d+(?:-\d+)?/g) ?? [], []);
  for (const name of CITING_REQUIREMENTS) {
    assert.deepEqual(lineNumberCites(requirementBlock(spec, name)), [], `line-number cites in ${name}`);
  }
});

test("the three requirements cite exactly these rule sections, each a real heading", () => {
  const cited = Object.fromEntries(CITING_REQUIREMENTS.map((name) => [name, sectionCites(requirementBlock(spec, name))]));
  assert.deepEqual(cited, {
    "Worktree Absolute Path Gate (Gate D)": ["Worktree 規範", "Worktree 規範"],
    "Worktree Mandatory For Branch Create Or Checkout (Gate W1)": ["Worktree 規範"],
    "Three-Way Name Alignment (Gates W2a / W2b)": ["分支前綴對照表（唯一權威）", "Worktree 規範"],
  });
  const names = citableSectionNames(rule);
  for (const section of new Set(Object.values(cited).flat())) {
    assert.ok(names.has(section), `§${section} is not a heading of ${RULE_FILE}`);
  }
});

// ── W1 is action-based: the requirement must not describe a prefix filter ─────
//
// The gate blocks every in-place branch create and every checkout of a non-mainline branch in
// the main worktree (behaviour locked in hook-pre-tool-gate-worktree-mandatory.test.mjs by the
// tests that block `git switch -c release/v1.0.0` and `git checkout release/v1.0.0` and pass
// `git checkout main`). The requirement text described a four-prefix
// filter with a release/ exemption for months after the gate dropped it; these are the phrases
// that text used.

const W1_REQUIREMENT = "Worktree Mandatory For Branch Create Or Checkout (Gate W1)";

function prefixFilterClaims(text) {
  return text.match(/starts with a worktree-mandatory prefix|branch prefix is \x60release\/\x60|release\/\* is exempt|Allow release branch in main worktree/g) ?? [];
}

test("fixtures: prefix-filter claims are caught, the action-based wording is not", () => {
  assert.deepEqual(
    prefixFilterClaims("when `<name>` starts with a worktree-mandatory prefix (`feature/`) … (a) the branch prefix is `release/`, (b)"),
    ["starts with a worktree-mandatory prefix", "branch prefix is `release/`"]
  );
  assert.deepEqual(prefixFilterClaims("#### Scenario: Allow release branch in main worktree\n(release/* is exempt)"), [
    "Allow release branch in main worktree",
    "release/* is exempt",
  ]);
  assert.deepEqual(prefixFilterClaims("no branch prefix is exempt (`feature/`, `release/`, `rules/`)\n#### Scenario: Block release branch in main worktree"), []);
});

test("the W1 requirement states the gate is action-based with no prefix exemption", () => {
  const block = requirementBlock(spec, W1_REQUIREMENT);
  assert.deepEqual(prefixFilterClaims(block), []);
  for (const phrase of [
    // Bound to the body sentence: the release scenario repeats the bare phrase.
    "W1 MUST NOT filter on the branch prefix, and no branch prefix is exempt (`feature/`",
    "in-place creation has no such exemption in W1",
    "remain the mandatory list used by Gates W2a / W2b; W1 does not use that list",
    "(`main`, `master`, `production`, `integration`) SHALL NOT fire W1",
    "#### Scenario: Block release branch in main worktree",
  ]) {
    assert.ok(block.includes(phrase), `W1 requirement must state: ${phrase}`);
  }
});

// The requirement once said it "does not cover the `-` shorthand" while the gate let `git checkout -`
// through. The gate now evaluates it as the branch it names (behaviour locked in
// hook-pre-tool-gate-worktree-mandatory.test.mjs, the W1X tests); the text must say so, must keep the
// fail-open case, and must scope `-C` to the git global options.

const SHORTHAND_EXCLUSION_PHRASES = ["written literally in the command", "does not cover the `-` shorthand"];

function shorthandExclusionClaims(text) {
  return SHORTHAND_EXCLUSION_PHRASES.filter((phrase) => text.includes(phrase));
}

test("fixtures: the shorthand exclusion is caught, the covering wording is not", () => {
  assert.deepEqual(
    shorthandExclusionClaims("W1 evaluates the branch argument written literally in the command; this requirement does not cover the `-` shorthand"),
    ["written literally in the command", "does not cover the `-` shorthand"]
  );
  assert.deepEqual(shorthandExclusionClaims("The previous-branch shorthands `-` and `@{-N}` … are evaluated as a checkout of the branch they name"), []);
});

test("the W1 requirement covers the previous-branch shorthand, verb-level -C, and path-shaped arguments", () => {
  const block = requirementBlock(spec, W1_REQUIREMENT);
  assert.deepEqual(shorthandExclusionClaims(block), []);
  for (const phrase of [
    "The previous-branch shorthands `-` and `@{-N}`",
    "are evaluated as a checkout of the branch they name in the effective command cwd when the hook runs",
    "when it is any other branch W1 SHALL block, with a reason that names the resolved branch",
    "W1 MUST NOT block on that occurrence, per `Mechanical-Gate Threat Model And Fail-Open On Uncertainty`",
    "`git checkout HEAD` names the commit already checked out and SHALL NOT fire W1",
    "when an option stands between `checkout` and `HEAD`",
    "when an option follows `HEAD` within the same simple command",
    "A git global option before the verb (`git -C <path> checkout HEAD`) is not such an option",
    "`HEAD` is evaluated like any other ref and W1 SHALL block",
    "a `-C` after the verb is the verb's own flag (`git switch -C <name>` force-creates `<name>`) and MUST NOT change the effective command cwd",
    "and the whole name for an unprefixed one",
    "W1 still blocks, and the block reason MUST show the restore form `git checkout -- <path>`",
    "the reason MUST NOT offer `git restore`",
    "#### Scenario: Verb-level -C does not hide a force-create from W1",
    "#### Scenario: Block previous-branch shorthand in main worktree",
    "#### Scenario: Leading cd to the main worktree does not hide the command from W1",
    "#### Scenario: Unprefixed name and path argument get a usable reason",
    "#### Scenario: Bare checkout of HEAD does not fire W1",
  ]) {
    assert.ok(block.includes(phrase), `W1 requirement must state: ${phrase}`);
  }
});

// ── No rule-file line-number cite anywhere in the spec or in hook sources ─────
//
// A line-number cite of a rule file goes stale on the next edit of that file. Three spec cites and
// eleven hook cites pointed at rule files by line (`release-sit-uat-pat-prod.md:310/379` in a
// 241-line file; `ai-autonomy.md:175-186` for a recipe that moved to session-recap.md;
// `rules-flow.md L125`). The spec and the hook sources now name the owning section; a rule-file
// line cite coming back in any listed form turns these tests red.

const HOOKS_DIR = path.join(REPO_ROOT, ".devpro/scripts/hooks");

function hookSourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return hookSourceFiles(full);
    return entry.name.endsWith(".mjs") ? [full] : [];
  });
}

// Headings with inline-code backticks removed, so `### \x60integration\x60 治理補充` is citable from a
// template literal as `§integration 治理補充`.
function ruleSectionNames(fileName) {
  return citableSectionNames(readFileSync(ruleFilePaths.get(fileName), "utf8").replaceAll("\x60", ""));
}

// handoff-cite-gate.mjs prints `ai-autonomy.md:14` as an example of the file:line cite FORM the
// gate accepts from the model; it is a format example, not a pointer the hook relies on.
const HOOK_LINE_CITE_ALLOWLIST = new Map([["lib/handoff-cite-gate.mjs", ["ai-autonomy.md:14"]]]);

test("fixtures: rule-file line cites are caught in each listed form, section cites and non-rule files are not", () => {
  assert.deepEqual(ruleFileLineCites("doc `release-sit-uat-pat-prod.md:310/379` and ai-autonomy.md:175-186"), [
    "release-sit-uat-pat-prod.md:310/379",
    "ai-autonomy.md:175-186",
  ]);
  assert.deepEqual(ruleFileLineCites("per `ai-autonomy.md`:85 exception"), ["ai-autonomy.md`:85"]);
  assert.deepEqual(ruleFileLineCites("rules-flow.md L125（version-named）; `release-sit-uat-pat-prod.md` L118. ai-autonomy.md#L14-L20"), [
    "rules-flow.md L125",
    "release-sit-uat-pat-prod.md` L118",
    "ai-autonomy.md#L14-L20",
  ]);
  // A rule file under platform-adapters/ counts too.
  assert.deepEqual(ruleFileLineCites("see claude-code.md L106 and codex.md:12"), ["claude-code.md L106", "codex.md:12"]);
  assert.deepEqual(
    ruleFileLineCites("rules-flow.md line 125; rules-flow.md lines 12-20; rules-flow.md (L125); rules-flow.md（L125）; rules-flow.md, L125; rules-flow.md:L125; rules-flow.md 第 125 行"),
    [
      "rules-flow.md line 125",
      "rules-flow.md lines 12-20",
      "rules-flow.md (L125",
      "rules-flow.md（L125",
      "rules-flow.md, L125",
      "rules-flow.md:L125",
      "rules-flow.md 第 125 行",
    ]
  );
  assert.deepEqual(ruleFileLineCites("per `release-rules-lane.md` §與業務 release 區隔; see design.md:225, README.md L133, AGENTS.md 第 3 行 and pre-tool-gate.mjs:864"), []);
  assert.deepEqual(ruleFileLineCites("rules-flow.md lineage 12; rules-flow.md (Lane 3); line 12 of rules-flow.md"), ["line 12 of rules-flow.md"]);
  assert.deepEqual(
    ruleFileLineCites("\x60session-recap.md\x60 §寫入方式 (title 格式段 :98); rules-flow.md, around line 12; codex.md 的第 3 行; lines 4-9 in \x60ai-autonomy.md\x60"),
    ["session-recap.md\x60 §寫入方式 (title 格式段 :98", "rules-flow.md, around line 12", "codex.md 的第 3 行", "lines 4-9 in \x60ai-autonomy.md"]
  );
  // Away from the name, a bare L<n> is a layer or lane label, a number inside a word or a clock time is
  // not a cite, a line number past the next .md name belongs to that name, and so does one on another line.
  assert.deepEqual(ruleFileLineCites("\x60ci-cd-integration-deployment.md\x60 — L6 CI/CD 詳細規範; rules-flow.md at 12:30 see pre-tool-gate.mjs:864"), []);
  assert.deepEqual(ruleFileLineCites("release-sit-uat-pat-prod.md Rules Lane（README.md L133, design.md :225）; rules-flow.md\nline 12"), []);
  assert.deepEqual(ruleFileLineCites("rules-flow.md " + "x".repeat(120) + " line 12"), []);
  assert.deepEqual(ruleFileLineCites("at ai-autonomy.md at 12:30; rules-flow.md Lane; rules-flow.md L1x"), []);
});

test("the spec cites no rule file by line number in any listed form", () => {
  assert.deepEqual(ruleFileLineCites(spec), []);
});

test("hook sources cite no rule file by line number in any listed form outside the named format example", () => {
  const found = new Map();
  for (const file of hookSourceFiles(HOOKS_DIR)) {
    const cites = ruleFileLineCites(readFileSync(file, "utf8"));
    if (cites.length > 0) found.set(path.relative(HOOKS_DIR, file).split(path.sep).join("/"), cites);
  }
  assert.deepEqual(Object.fromEntries(found), Object.fromEntries(HOOK_LINE_CITE_ALLOWLIST));
});

// Every `<rule>.md` §<section> ( cite of a requirement block, read whole up to the gloss.
function ruleSectionCites(text) {
  return [...text.matchAll(/\x60([A-Za-z0-9_-]+\.md)\x60 §([^\n]*?) \(/g)].map((m) => `${m[1]} §${m[2]}`);
}

test("the Recap body, V2 tag and N6 requirements cite exactly these rule sections, each a real heading", () => {
  const expected = {
    "gh-footer-gate.mjs Body File Extraction Subshell Form": ["session-recap.md §寫入方式"],
    "Production Tag Shape + Version Equality Gate": [
      "release-rules-lane.md §與業務 release 區隔",
      "release-step-1-7.md §Release 流程 step 1-7",
    ],
    "Branch Name Body Kebab-Case And One-Verb-One-Scope (N3 + N2)": ["release-step-1-7.md §Release 流程 step 1-7"],
  };
  const cited = Object.fromEntries(Object.keys(expected).map((name) => [name, ruleSectionCites(requirementBlock(spec, name))]));
  assert.deepEqual(cited, expected);
  for (const cite of new Set(Object.values(expected).flat())) {
    const [file, section] = cite.split(" §");
    assert.ok(ruleSectionNames(file).has(section), `§${section} is not a heading of ${file}`);
  }
});

// Each hook cite is bound to its own line: `marker` must select exactly one line of the hook file,
// and that line must carry `cite` followed by `after`. A cite repeated elsewhere in the file cannot
// stand in for a line that lost or changed its own.
const HOOK_SECTION_CITES = [
  ["pre-tool-gate.mjs", "integration 僅允許", "release-sit-uat-pat-prod.md", "integration 治理補充", "）"],
  ["pre-tool-gate.mjs", " * Rules (doc ", "release-rules-lane.md", "與業務 release 區隔", " for the rules lane;"],
  ["pre-tool-gate.mjs", " * Rules (doc ", "release-step-1-7.md", "Release 流程 step 1-7", " for the date lane):"],
  ["pre-tool-gate.mjs", "rules lane 規則（", "release-rules-lane.md", "與業務 release 區隔", "）："],
  ["pre-tool-gate.mjs", "subset lane 規則（", "release-step-1-7.md", "Release 流程 step 1-7", "）："],
  ["pre-tool-gate.mjs", "gh pr create canonical forms, per", "git-pr-template-and-merge.md", "Attribution footer", ") plus"],
  ["gh-footer-gate.mjs", "Mirrors pre-tool-gate.mjs::BODY_FILE_RE", "session-recap.md", "寫入方式", ""],
  ["lib/attribution-patterns.mjs", "gh body AND git commit message MUST reject all", "ai-autonomy.md", "行為邊界", " (Always),"],
  ["user-prompt-gate.mjs", "aligned with pre-tool-gate.mjs PROTECTED_BRANCHES", "ai-autonomy.md", "Never", " (protected-branch push ban)."],
  ["lib/branch-naming.mjs", "(1) \x60release/v<X.Y.Z>\x60", "rules-flow.md", "Source Repo Release", "（version-named）"],
  ["lib/handoff-cite-gate.mjs", "PR 已建立，待您 merge", "ai-autonomy.md", "Overview", "）"],
];

function boundHookCiteProblems(lines, marker, cite) {
  const hits = lines.filter((line) => line.includes(marker));
  if (hits.length !== 1) return [`marker "${marker}" selects ${hits.length} lines`];
  return hits[0].includes(cite) ? [] : [`line "${marker}" lacks "${cite}"`];
}

test("fixtures: a hook cite is bound to its own line", () => {
  const lines = ["// a (per x.md §One）", "// b (x.md §One）："];
  assert.deepEqual(boundHookCiteProblems(lines, "// b", "x.md §One）："), []);
  assert.deepEqual(boundHookCiteProblems(["// a (per x.md §One）", "// b (x.md §Two）："], "// b", "x.md §One）："), [
    'line "// b" lacks "x.md §One）："',
  ]);
  assert.deepEqual(boundHookCiteProblems(lines, "// b", "x.md §One 舊版）："), ['line "// b" lacks "x.md §One 舊版）："']);
  assert.deepEqual(boundHookCiteProblems(["// a (per x.md §One）"], "// b", "x.md §One）："), ['marker "// b" selects 0 lines']);
  assert.deepEqual(boundHookCiteProblems(lines, "x.md", "x.md §One"), ['marker "x.md" selects 2 lines']);
});

// One hook cite names a rule file without a section: the section heading of that adapter file carries
// a product name, which hook entrypoints may not contain (vendor-leak-regression.test.mjs).
const HOOK_FILE_ONLY_CITES = [["gh-footer-gate.mjs", "Child processes (including this hook) inherit it.", "claude-code-cross-review.md", ")."]];

test("the file-only hook cite stays on its own line and names a rule file", () => {
  for (const [hook, marker, file, after] of HOOK_FILE_ONLY_CITES) {
    const lines = readFileSync(path.join(HOOKS_DIR, hook), "utf8").split("\n");
    assert.deepEqual(boundHookCiteProblems(lines, marker, `// ${file}${after}`), [], `${hook}: ${marker}`);
    assert.ok(ruleFilePaths.has(file), `${file} is not a rule file`);
  }
});

test("each hook cite names its rule section on its own line, each a real heading", () => {
  for (const [hook, marker, file, section, after] of HOOK_SECTION_CITES) {
    const lines = readFileSync(path.join(HOOKS_DIR, hook), "utf8").split("\n");
    const cite = `${file} §${section}${after}`;
    assert.deepEqual(boundHookCiteProblems(lines, marker, cite), [], `${hook}: ${marker}`);
    if (after === "") {
      const line = lines.find((l) => l.includes(marker));
      assert.ok(line.endsWith(cite), `${hook}: "${marker}" must end with ${cite}`);
    }
    assert.ok(ruleSectionNames(file).has(section), `§${section} is not a heading of ${file}`);
  }
});
