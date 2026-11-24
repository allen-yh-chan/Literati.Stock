/**
 * branch-naming.test.mjs
 *
 * Unit tests for .devpro/scripts/hooks/lib/branch-naming.mjs:
 *   - loadVerbWhitelist parses preflight-checklist.md marker block
 *   - parseBranchName / validateBranchName handle prefix + verb + bump exempt
 *   - extractBranchNameFromCommand covers git/gh branch-creating commands
 *   - fail-closed behavior: missing marker / empty list throws
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  loadVerbWhitelist,
  parseBranchName,
  validateBranchName,
  extractBranchNameFromCommand,
  extractAllBranchNamesFromCommand,
} from "../hooks/lib/branch-naming.mjs";
import * as branchNaming from "../hooks/lib/branch-naming.mjs";
import * as preToolGate from "../hooks/pre-tool-gate.mjs";

import {
  isConsumerSubsetReleaseBranchExempt,
} from "../hooks/pre-tool-gate.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

const FIXED_PROTECTED_BASES = ["main", "master", "production", "integration"];

test("local review branches accept only a positive PR number without granting a promotable prefix", () => {
  const verbs = loadVerbWhitelist(REPO_ROOT);
  for (const name of ["review/pr1", "review/pr41", "review/pr123456"]) {
    assert.deepEqual(validateBranchName(name, verbs, REPO_ROOT), { valid: true, exempt: "review" });
    assert.equal(parseBranchName(name).ok, false, "review must not enter the regular work-prefix set");
  }
  for (const name of ["review/pr0", "review/pr01", "review/pr-1", "review/pr41-extra", "review/foo", "review/pr41/nested"]) {
    assert.equal(validateBranchName(name, verbs, REPO_ROOT).valid, false, name);
  }
});

test("local review PR heads are blocked for every real create clause, including fork-qualified heads", () => {
  for (const cmd of [
    "gh pr create --head review/pr41 --base main",
    "gh pr create -H 'owner:review/pr41' --base main",
    "gh pr create --head=review/pr41 --base main",
    "gh pr create --head feature/add-example && gh pr create --head review/pr41",
  ]) {
    const result = preToolGate.checkLocalReviewPrCreate?.(cmd, REPO_ROOT);
    assert.equal(result?.block, true, cmd);
    assert.match(result.reason, /local.review|僅本機/i);
  }
});

// fix-pre-verb-repo-flag-gates: gh accepts -R before `pr` and between `pr` and the verb; the head of such a create is
// read and judged exactly as in the after-verb form.
test("a create with -R before the verb has its head read and judged as in the after-verb form", () => {
  for (const head of ["review/pr41", "feature/add-example"]) {
    const after = `gh pr create --head ${head} --base main -R owner/repo`;
    for (const cmd of [`gh -R owner/repo pr create --head ${head} --base main`, `gh pr -R owner/repo create --head ${head} --base main`]) {
      assert.deepEqual(extractAllBranchNamesFromCommand(cmd), extractAllBranchNamesFromCommand(after), cmd);
      assert.deepEqual(preToolGate.checkLocalReviewPrCreate?.(cmd, REPO_ROOT), preToolGate.checkLocalReviewPrCreate?.(after, REPO_ROOT), cmd);
    }
  }
  assert.deepEqual(extractAllBranchNamesFromCommand("gh pr create --head feature/add-example -R owner/repo"), ["feature/add-example"]);
  assert.equal(preToolGate.checkLocalReviewPrCreate?.("gh pr create --head review/pr41 -R owner/repo", REPO_ROOT)?.block, true);
});

test("local review PR-head guard ignores read-only commands, quoted examples and ordinary heads", () => {
  for (const cmd of [
    "gh pr view 41", "gh pr diff 41", "gh pr create --head feature/add-example",
    "echo 'gh pr create --head review/pr41'", "gh pr create --head feature/add-example --body 'review/pr41'",
  ]) {
    assert.equal(preToolGate.checkLocalReviewPrCreate?.(cmd, REPO_ROOT), null, cmd);
  }
});

test("local review implicit PR heads use the checkout at each create command", () => {
  const review = makeTempDir("local-review-head-");
  const ordinary = makeTempDir("ordinary-review-head-");
  try {
    for (const [cwd, branch] of [[review, "review/pr41"], [ordinary, "feature/add-example"]]) {
      const init = spawnSync("git", ["init", "-q", "-b", branch], { cwd, encoding: "utf8" });
      assert.equal(init.status, 0, init.stderr);
    }
    for (const cmd of ["gh pr create", `cd '${ordinary}' && gh pr create && cd '${review}' && gh pr create`]) {
      assert.equal(preToolGate.checkLocalReviewPrCreate?.(cmd, review)?.block, true, cmd);
    }
    assert.equal(preToolGate.checkLocalReviewPrCreate?.(`cd '${ordinary}' && gh pr create`, review), null);
  } finally {
    rmSync(review, { recursive: true, force: true });
    rmSync(ordinary, { recursive: true, force: true });
  }
});

test("local review PR-head restriction is registered and blocks the lite tool path", () => {
  const previous = process.env.DEVPRO_AGENT_RULES_LEVEL;
  try {
    process.env.DEVPRO_AGENT_RULES_LEVEL = "lite";
    const result = preToolGate.evaluatePreToolUsePayload({
      tool_name: "Shell",
      cwd: REPO_ROOT,
      tool_input: { command: "gh pr create --head review/pr41 --base main", workdir: REPO_ROOT },
    });
    assert.equal(result?.block, true);
    assert.match(result.reason, /local.review|僅本機/i);
  } finally {
    if (previous === undefined) delete process.env.DEVPRO_AGENT_RULES_LEVEL;
    else process.env.DEVPRO_AGENT_RULES_LEVEL = previous;
  }
});

test("local review worktree creation passes the lite tool path with its dedicated directory name", () => {
  const previous = process.env.DEVPRO_AGENT_RULES_LEVEL;
  try {
    process.env.DEVPRO_AGENT_RULES_LEVEL = "lite";
    const wt = path.join(REPO_ROOT, ".worktree", "pr41-review");
    const result = preToolGate.evaluatePreToolUsePayload({
      tool_name: "Shell", cwd: REPO_ROOT,
      tool_input: { command: `git worktree add -b review/pr41 '${wt}' HEAD`, workdir: REPO_ROOT },
    });
    assert.notEqual(result?.block, true, result?.reason);
  } finally {
    if (previous === undefined) delete process.env.DEVPRO_AGENT_RULES_LEVEL;
    else process.env.DEVPRO_AGENT_RULES_LEVEL = previous;
  }
});

test("protected-base predicate owns exactly the four fixed names", () => {
  for (const branch of FIXED_PROTECTED_BASES) {
    assert.equal(branchNaming.isProtectedBaseBranch(branch), true, branch);
  }
  for (const branch of ["release/x", "production-x", "Integration", "chore/x", ""]) {
    assert.equal(branchNaming.isProtectedBaseBranch(branch), false, branch);
  }
});

test("protected-base collection is module-private and cannot be mutated by consumers", () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(branchNaming, "PROTECTED_BASE_BRANCHES"),
    false,
    "consumers must receive only the predicate, never the mutable collection",
  );
  for (const [name, value] of Object.entries(branchNaming)) {
    assert.equal(
      /protected.*branch/i.test(name) && (value instanceof Set || Array.isArray(value)),
      false,
      `unexpected mutable protected-branch export: ${name}`,
    );
  }
});

function setupFakeRepo(preflightContent) {
  const dir = makeTempDir("branch-naming-test-");
  mkdirSync(path.join(dir, ".devpro/agent-rules"), { recursive: true });
  writeFileSync(path.join(dir, ".devpro/agent-rules/preflight-checklist.md"), preflightContent);
  return dir;
}

describe("rulesSyncBranchIdentity", () => {
  const rulesSourceMarker = [
    "<!-- rules-source-whitelist:start -->",
    "- `agent-rules`",
    "<!-- rules-source-whitelist:end -->",
    "",
  ].join("\n");

  test("canonical whitelisted rules branch returns source and SemVer suffix", () => {
    const repo = setupFakeRepo(rulesSourceMarker);
    try {
      assert.deepEqual(
        branchNaming.rulesSyncBranchIdentity("rules/agent-rules-v6.63.0", repo),
        {
          kind: "rules",
          branch: "rules/agent-rules-v6.63.0",
          source: "agent-rules",
          version: "6.63.0",
        }
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("canonical rules branch with unwhitelisted source is invalid, not generic", () => {
    const repo = setupFakeRepo(rulesSourceMarker);
    try {
      const identity = branchNaming.rulesSyncBranchIdentity("rules/other-v6.63.0", repo);
      assert.equal(identity.kind, "invalid");
      assert.equal(identity.branch, "rules/other-v6.63.0");
      assert.match(identity.reason, /not in whitelist/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("canonical rules branch with malformed whitelist markers is unresolved", () => {
    const repo = setupFakeRepo("<!-- rules-source-whitelist:start -->\n- `agent-rules`\n");
    try {
      const identity = branchNaming.rulesSyncBranchIdentity("rules/agent-rules-v6.63.0", repo);
      assert.equal(identity.kind, "unresolved");
      assert.match(identity.reason, /markers are missing or out of order/);

      const validation = branchNaming.validateRulesBranch("rules/agent-rules-v6.63.0", repo);
      assert.equal(validation.valid, false);
      assert.match(validation.reason, /markers are missing or out of order/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("malformed rules-like branch is invalid, not generic", () => {
    const identity = branchNaming.rulesSyncBranchIdentity("rules/agent-rules-6.63.0", REPO_ROOT);
    assert.equal(identity.kind, "invalid");
    assert.equal(identity.branch, "rules/agent-rules-6.63.0");
    assert.match(identity.reason, /rules\/<source>-v<X\.Y\.Z>/);
  });

  test("non-rules branch remains generic", () => {
    assert.deepEqual(
      branchNaming.rulesSyncBranchIdentity("bugfix/fix-footer", REPO_ROOT),
      { kind: "generic", branch: "bugfix/fix-footer" }
    );
  });

  test("RULES_SYNC_SEMVER_RE captures source and branch suffix version", () => {
    const match = "rules/agent-rules-v6.63.0".match(branchNaming.RULES_SYNC_SEMVER_RE);
    assert.equal(match?.[1], "agent-rules");
    assert.equal(match?.[2], "6.63.0");
  });
});

test("loadVerbWhitelist parses real preflight-checklist.md to 15 verbs", () => {
  const verbs = loadVerbWhitelist(REPO_ROOT);
  assert.equal(verbs.size, 15, `expected 15 verbs, got ${verbs.size}: ${[...verbs].join(",")}`);
  for (const expected of [
    "add", "fix", "refactor", "remove", "migrate", "update", "sync",
    "docs", "amend", "strengthen", "wire", "clarify", "enforce", "revert",
    "rationalize",
  ]) {
    assert.ok(verbs.has(expected), `missing verb \`${expected}\``);
  }
});

test("preflight checklist moves one-verb-one-scope body checks before devpro:change worktree creation", () => {
  const preflight = readFileSync(path.join(REPO_ROOT, ".devpro/agent-rules/preflight-checklist.md"), "utf8");

  assert.match(
    preflight,
    /devpro:change[\s\S]*Verb Whitelist Precheck[\s\S]*點 2 marker SSOT/,
    "devpro:change precheck must keep branch verb lookup pointed at preflight-checklist point 2 marker SSOT"
  );
  assert.match(
    preflight,
    /Verb Whitelist Precheck[\s\S]*(Chore Classification|anchor)[\s\S]*git worktree add[\s\S]*branch hook[\s\S]*gh pr create/,
    "scope-body validation must be ordered before classification, worktree creation, branch hook, and gh pr create"
  );
  assert.match(
    preflight,
    /<name>` scope body[\s\S]*-and-[\s\S]*一動詞一 scope violation/,
    "preflight must explicitly check branch <name> body for -and- and other one-verb-one-scope violations"
  );
  assert.match(
    preflight,
    /停下要求拆 change|改成單一概念 scope/,
    "scope-body violations must stop devpro:change before branch creation"
  );
});

test("loadVerbWhitelist throws when marker block missing", () => {
  const dir = setupFakeRepo("# preflight\n\n2. **動詞白名單** ... (no markers)\n");
  try {
    assert.throws(() => loadVerbWhitelist(dir), /marker block missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadVerbWhitelist throws when marker block parsed empty", () => {
  const dir = setupFakeRepo(
    "# preflight\n\n<!-- branch-verb-whitelist:start -->\n\n(no list items)\n\n<!-- branch-verb-whitelist:end -->\n"
  );
  try {
    assert.throws(() => loadVerbWhitelist(dir), /parsed empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadVerbWhitelist throws when end marker before start", () => {
  const dir = setupFakeRepo(
    "# preflight\n\n<!-- branch-verb-whitelist:end -->\n\n<!-- branch-verb-whitelist:start -->\n"
  );
  try {
    assert.throws(() => loadVerbWhitelist(dir), /missing|malformed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseBranchName handles standard prefix/verb-scope", () => {
  const r = parseBranchName("chore/clarify-readme");
  assert.equal(r.ok, true);
  assert.equal(r.prefix, "chore");
  assert.equal(r.body, "clarify-readme");
  assert.equal(r.verb, "clarify");
});

test("parseBranchName rejects unknown prefix and separates the two allowlists", () => {
  const r = parseBranchName("fix/foo");
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown prefix/);
  assert.match(r.reason, /prefix allowlist/);
  assert.match(r.reason, /prefix-layer exemptions: release\//);  // surface that release/ is allowed in specific formats
  assert.match(r.reason, /Whole-name exemptions .* are matched by whole-name literal comparison, not by the verb layer/);
  assert.match(r.reason, /verb allowlist is a separate layer/);
  assert.match(r.reason, /`docs`\/`fix`\/`wire` are verbs, not prefixes/);
});

test("branch rules state the prefix/verb two-layer contract", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const anchor = readFileSync(path.join(repoRoot, ".devpro/agent-rules/git-branch-naming-and-anchor.md"), "utf8");
  assert.match(anchor, /兩層白名單/u);
  assert.match(anchor, /`fix`／`docs`／`wire` 等是 verb，不是 prefix/u);
  const preflight = readFileSync(path.join(repoRoot, ".devpro/agent-rules/preflight-checklist.md"), "utf8");
  assert.match(preflight, /本區塊是 verb 白名單/u);
  assert.match(preflight, /`docs`／`fix`／`wire` 是 verb，不是 prefix/u);
  const preflightLine = preflight.split("\n").find((line) => line.startsWith("2. **動詞白名單**"));
  assert.match(preflightLine, /whole-name 逐字比對豁免（不是 verb 層豁免）/u);
  const briefing = readFileSync(path.join(repoRoot, ".devpro/agent-rules/model-delegation-briefing.md"), "utf8");
  assert.match(briefing, /`artifact_landing`：暫存與產物的落點依 `file-write-destinations\.md`/u);
  const handoff = readFileSync(path.join(repoRoot, ".devpro/agent-rules/multi-agent-handoff.md"), "utf8");
  assert.match(handoff, /暫存檔與產物 MUST 落在 `file-write-destinations\.md` 指定的落點/u);
  assert.match(handoff, /MUST NOT 寫 repo root/u);
  // The landing half is locked through the SSOT it points at, not by copying
  // the path list a third time.
  const destinations = readFileSync(path.join(repoRoot, ".devpro/agent-rules/file-write-destinations.md"), "utf8");
  assert.match(destinations, /notes\/tmp/u);
});

test("parseBranchName rejects malformed release/ with tailored message", () => {
  // release/ prefix not in PREFIXES set; falls here with release-specific guidance
  // (RELEASE_EXEMPTION_RE in validateBranchName catches valid forms before this).
  const r = parseBranchName("release/foo-bar");
  assert.equal(r.ok, false);
  assert.match(r.reason, /release\/ branch must match/);
  assert.match(r.reason, /release-sit-uat-pat-prod\.md/);
});

test("parseBranchName rejects missing slash", () => {
  const r = parseBranchName("clarify-readme");
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing prefix/);
});

test("validateBranchName accepts whitelist verb", () => {
  const verbs = new Set(["clarify", "enforce", "add"]);
  const r = validateBranchName("chore/clarify-readme", verbs);
  assert.equal(r.valid, true);
  assert.equal(r.verb, "clarify");
});

test("validateBranchName accepts rationalize via real marker-parsed whitelist (hook放行 rationalization cycle 分支名)", () => {
  const verbs = loadVerbWhitelist(REPO_ROOT);
  const r = validateBranchName("chore/rationalize-rules-cycle-5", verbs, REPO_ROOT);
  assert.equal(r.valid, true, `expected valid but got: ${r.reason}`);
  assert.equal(r.verb, "rationalize");
});

test("validateBranchName rejects non-whitelist verb", () => {
  const verbs = new Set(["clarify", "enforce"]);
  const r = validateBranchName("chore/cleanup-readme", verbs);
  assert.equal(r.valid, false);
  assert.match(r.reason, /verb `cleanup` not in whitelist/);
});

test("validateBranchName exempts bump branches", () => {
  const verbs = new Set([]); // even with empty whitelist
  const r = validateBranchName("chore/bump-v6.30.4", verbs);
  assert.equal(r.valid, true);
  assert.equal(r.exempt, "bump");
});

test("validateBranchName rejects bump pattern with non-numeric version", () => {
  const verbs = new Set(["fix"]);
  const r = validateBranchName("chore/bump-vX.Y.Z", verbs);
  // not bump-exempt; falls through to verb check; verb = "bump" not in whitelist
  assert.equal(r.valid, false);
  assert.match(r.reason, /verb `bump`/);
});

test("validateBranchName exempts release/v<X.Y.Z> (version-named release)", () => {
  const verbs = new Set([]);
  const r = validateBranchName("release/v6.38.1", verbs);
  assert.equal(r.valid, true);
  assert.equal(r.exempt, "release");
});

test("validateBranchName exempts release/<YYYYMMDD>-<shortSHA> (date+SHA snapshot)", () => {
  // Per release-sit-uat-pat-prod.md Step 2 canonical naming. shortSHA is 7-40 hex chars.
  const verbs = new Set([]);
  const r = validateBranchName("release/20260509-63968fb", verbs);
  assert.equal(r.valid, true);
  assert.equal(r.exempt, "release");
});

test("validateBranchName exempts release/<YYYYMMDD>-<shortSHA>-<n> (same-day suffix)", () => {
  // Per release-sit-uat-pat-prod.md Step 2 同天多次 -2、-3…
  const verbs = new Set([]);
  const r = validateBranchName("release/20260509-63968fb-2", verbs);
  assert.equal(r.valid, true);
  assert.equal(r.exempt, "release");
});

test("validateBranchName rejects release with malformed body (date only, no SHA)", () => {
  // Negative case: must enforce shortSHA presence to prevent typo aliasing.
  const verbs = new Set([]);
  const r = validateBranchName("release/20260509", verbs);
  assert.equal(r.valid, false);
});

test("validateBranchName exempts release/rules-<YYYYMMDD> (Rules Lane release)", () => {
  // Per release-sit-uat-pat-prod.md Rules Lane + README.md L133. rules submodule
  // promotion lane uses date-only naming (與 business release `release/<YYYYMMDD>-<sha>` 區隔).
  const verbs = new Set([]);
  const r = validateBranchName("release/rules-20260511", verbs);
  assert.equal(r.valid, true);
  assert.equal(r.exempt, "release");
});

test("validateBranchName exempts release/rules-<YYYYMMDD>-<n> (same-day Rules Lane release)", () => {
  const verbs = new Set([]);
  const r = validateBranchName("release/rules-20260511-2", verbs);
  assert.equal(r.valid, true);
  assert.equal(r.exempt, "release");
});

test("validateBranchName rejects release/rules- with short date (typo guard)", () => {
  // Negative case: rules-<YYYYMMDD> requires exactly 8 digits to prevent typo aliasing.
  const verbs = new Set([]);
  const r = validateBranchName("release/rules-2026051", verbs);
  assert.equal(r.valid, false);
});

test("validateBranchName accepts hotfix/revert-rules-<date> (DRIFT-4 SSOT alignment: rules-flow-rollback.md § Rollback SOP)", () => {
  // Per rules-flow.md L142,147 + release-sit-uat-pat-prod.md L321：
  // rules lane rollback uses `hotfix/revert-rules-<date>` 旁路。verb `revert` 需在白名單。
  const verbs = new Set(["add", "fix", "refactor", "revert"]);
  const r = validateBranchName("hotfix/revert-rules-20260511", verbs);
  assert.equal(r.valid, true);
  assert.equal(r.verb, "revert");
});

test("validateBranchName rejects hotfix/revert-... when revert verb absent from whitelist (regression guard for DRIFT-4)", () => {
  // Confirms gate behavior: if whitelist somehow loses `revert`, rollback path breaks.
  const verbs = new Set(["add", "fix"]);
  const r = validateBranchName("hotfix/revert-rules-20260511", verbs);
  assert.equal(r.valid, false);
});

test("RELEASE_EXEMPTION_RE SSOT alignment: every documented format in branch-naming.mjs comment block must validate", () => {
  // SSOT-driven guard: the comment block above RELEASE_EXEMPTION_RE in branch-naming.mjs
  // (lines starting with `// (N) `release/...`) is the authoritative list of formats
  // the regex must accept. This test parses that list and asserts each documented
  // template has a concrete example accepted by validateBranchName.
  //
  // Why this exists: when Rules Lane was wired (commits a33b7e0 SSOT + 8a0fe49 hook
  // 6 minutes apart), the hook author covered `rules/<source>-v<X.Y.Z>` work branch lane
  // via RULES_BRANCH_RE but missed `release/rules-<YYYYMMDD>` release branch lane
  // in RELEASE_EXEMPTION_RE — both are Rules Lane lifecycle but live in different
  // regex consts. This test prevents recurrence: if a future commit adds a (4)
  // entry to the comment block but forgets the alternation, this test fails.
  //
  // Maintenance: when you add a new `// (N) \`release/<template>\`` line above
  // RELEASE_EXEMPTION_RE, you MUST also add a {template: example} entry to the
  // `templateToExample` map below.
  const libPath = path.join(REPO_ROOT, ".devpro/scripts/hooks/lib/branch-naming.mjs");
  const libSrc = readFileSync(libPath, "utf8");

  // Parse SSOT comment block: lines like `// (1) \`release/v<X.Y.Z>\` — ...`
  const documented = [...libSrc.matchAll(/^\/\/ \(\d+\) `(release\/[^`]+)`/gm)].map(
    (m) => m[1]
  );
  assert.ok(
    documented.length >= 3,
    `expected ≥ 3 documented release formats in branch-naming.mjs SSOT comment block; found ${documented.length}`
  );

  const templateToExample = {
    "release/v<X.Y.Z>": "release/v6.42.0",
    "release/<YYYYMMDD>-<shortSHA>[-<n>]": "release/20260511-63968fb",
    "release/rules-<YYYYMMDD>[-<n>]": "release/rules-20260511-2",
  };

  for (const template of documented) {
    const example = templateToExample[template];
    assert.ok(
      example,
      `branch-naming.mjs SSOT comment documents format "${template}" but this test's templateToExample map has no example. Add a {"${template}": "<concrete-example>"} entry and verify RELEASE_EXEMPTION_RE accepts it.`
    );
    const r = validateBranchName(example, new Set([]), REPO_ROOT);
    assert.equal(
      r.valid,
      true,
      `RELEASE_EXEMPTION_RE rejects "${example}" despite SSOT comment documenting "${template}" — add the corresponding alternation to RELEASE_EXEMPTION_RE.`
    );
    assert.equal(r.exempt, "release");
  }
});

test("validateBranchName rejects feature with no verb-like body", () => {
  const verbs = new Set(["add"]);
  const r = validateBranchName("feature/", verbs);
  assert.equal(r.valid, false);
});

test("extractBranchNameFromCommand handles git checkout -b", () => {
  assert.equal(extractBranchNameFromCommand("git checkout -b feature/add-foo"), "feature/add-foo");
});

test("extractBranchNameFromCommand handles git switch -c", () => {
  assert.equal(extractBranchNameFromCommand("git switch -c chore/clarify-bar"), "chore/clarify-bar");
});

test("extractBranchNameFromCommand handles git branch -m", () => {
  assert.equal(
    extractBranchNameFromCommand("git branch -m chore/old chore/clarify-new"),
    "chore/clarify-new"
  );
  assert.equal(
    extractBranchNameFromCommand("git branch -m chore/clarify-new"),
    "chore/clarify-new"
  );
});

test("extractBranchNameFromCommand handles git worktree add -b", () => {
  assert.equal(
    extractBranchNameFromCommand("git worktree add .worktree/foo -b feature/add-foo origin/main"),
    "feature/add-foo"
  );
});

test("extractBranchNameFromCommand handles gh pr create --head", () => {
  assert.equal(
    extractBranchNameFromCommand("gh pr create --base main --head chore/enforce-x --title t"),
    "chore/enforce-x"
  );
});

test("extractBranchNameFromCommand handles gh pr create --head=value (equals form)", () => {
  assert.equal(
    extractBranchNameFromCommand("gh pr create --base main --head=chore/enforce-y --title t"),
    "chore/enforce-y"
  );
});

// issue #851/#848 round 7: the extraction patterns previously consumed only a
// leading `git -C <dir>`, so a branch create hidden behind any other git global
// option (`--no-pager`, `-P`, `--no-optional-locks`, …) was not surfaced to the
// branch-name validation / worktree-mandatory gates. Now generalized via the
// shared GIT_GLOBAL_OPT grammar (lib/shell-context.mjs).
test("extractBranchNameFromCommand handles a leading git global option before create", () => {
  assert.equal(extractBranchNameFromCommand("git --no-pager checkout -b feature/add-foo"), "feature/add-foo");
  assert.equal(extractBranchNameFromCommand("git -P switch -c chore/clarify-bar"), "chore/clarify-bar");
  assert.equal(extractBranchNameFromCommand("git --no-optional-locks branch newbr"), "newbr");
  assert.equal(extractBranchNameFromCommand("git --no-pager switch --create release/foo"), "release/foo");
  assert.equal(
    extractBranchNameFromCommand("git --no-pager worktree add .worktree/foo -b bugfix/x origin/main"),
    "bugfix/x"
  );
});

test("extractBranchNameFromCommand keeps list-mode / readonly suppression symmetric under a global option", () => {
  // generalizing the create patterns must NOT over-block: a global before a
  // list/readonly `git branch` still creates no branch → null.
  assert.equal(extractBranchNameFromCommand("git --no-pager branch"), null);
  assert.equal(extractBranchNameFromCommand("git --no-pager branch | head"), null);
  assert.equal(extractBranchNameFromCommand("git --no-pager branch --merged main"), null);
  assert.equal(extractBranchNameFromCommand("git -P branch --list"), null);
  assert.equal(extractBranchNameFromCommand("git --no-pager branch --show-current"), null);
});

test("extractBranchNameFromCommand returns null for shell variable expansion", () => {
  assert.equal(extractBranchNameFromCommand('git checkout -b "$BRANCH"'), null);
  assert.equal(extractBranchNameFromCommand("git checkout -b ${BRANCH}"), null);
  assert.equal(extractBranchNameFromCommand("git checkout -b $(echo foo)"), null);
});

test("extractBranchNameFromCommand returns null for non-branch-creating commands", () => {
  assert.equal(extractBranchNameFromCommand("git status"), null);
  assert.equal(extractBranchNameFromCommand("git checkout main"), null);
  assert.equal(extractBranchNameFromCommand("git branch --show-current"), null);
});

test("extractBranchNameFromCommand strips quotes around branch name", () => {
  assert.equal(extractBranchNameFromCommand('git checkout -b "feature/add-foo"'), "feature/add-foo");
  assert.equal(extractBranchNameFromCommand("git checkout -b 'chore/clarify-x'"), "chore/clarify-x");
});

// ── BN integration tests (T5, qa-test-scope.md BN1/BN2) ─────────────────

test("BN1: MSG=\"git checkout -b foo\" (quoted assignment) → extractBranchName returns null (no FP)", () => {
  // The git checkout is inside a quoted string (assignment value), not a real command.
  // segment-aware: match position falls in quoted-string segment → skip.
  const cmd = 'MSG="git checkout -b foo"';
  assert.equal(
    extractBranchNameFromCommand(cmd),
    null,
    `expected null (FP guard), cmd: ${JSON.stringify(cmd)}`
  );
});

test("BN2: echo \"git branch x\" && git branch real-branch → extractBranchName returns real-branch", () => {
  // Mixed real+quoted: the first git branch is inside a quoted string (FP),
  // the second git branch is a real command (should be detected).
  const cmd = 'echo "git branch x" && git branch real-branch';
  assert.equal(
    extractBranchNameFromCommand(cmd),
    "real-branch",
    `expected real-branch, cmd: ${JSON.stringify(cmd)}`
  );
});

// ── Prove-it tests (PT1–PT4): fix-branch-extractor-no-arg-and-metachar ──────

// PT1: Case A — no-arg list mode must return null
test("extractBranchNameFromCommand returns null for no-arg git branch (list mode)", () => {
  assert.equal(extractBranchNameFromCommand("git branch"), null);
});

// PT2: Case B — git branch followed by shell metachar must return null
test("extractBranchNameFromCommand returns null for git branch followed by shell metachar", () => {
  assert.equal(extractBranchNameFromCommand("git branch | head -20"), null);
  assert.equal(extractBranchNameFromCommand("git branch; echo done"), null);
  assert.equal(extractBranchNameFromCommand("git branch && pwd"), null);
  // Real-world reproduction (per meeting-notes):
  assert.equal(
    extractBranchNameFromCommand("git branch -d a b c; echo done; git branch | head -20"),
    null,
    "compound with no-arg list at tail must return null"
  );
  // Newline-separated command: `git branch\necho x` — NO_ARG_GIT_BRANCH_RE must treat \n as boundary
  assert.equal(
    extractBranchNameFromCommand("git branch\necho x"),
    null,
    "git branch followed by newline must return null (list mode, not branch creation)"
  );
});

test("extractBranchNameFromCommand returns null for git branch list mode with redirects", () => {
  assert.equal(extractBranchNameFromCommand("git branch 2>&1"), null);
  assert.equal(extractBranchNameFromCommand("git branch 2>/dev/null"), null);
  assert.equal(extractBranchNameFromCommand("git branch > branches.txt"), null);
  assert.equal(extractBranchNameFromCommand("git --no-pager branch 2>&1"), null);
});

// PT3: Regression guard — `-d` flag path must not be hit by NO_ARG regex
test("extractBranchNameFromCommand returns null for git branch -d <name> (delete is not creation)", () => {
  // -d/-D matches BRANCH_COMMAND_PATTERNS[2] (-m/--move/-M) negative lookahead
  // (?!-) in pattern[3] excludes flags. Delete should not be picked up as
  // branch creation regardless of fix.
  assert.equal(extractBranchNameFromCommand("git branch -d feature/old"), null);
  assert.equal(extractBranchNameFromCommand("git branch -D feature/old"), null);
});

// PT4: Regression guard — legitimate creation still returns correct name
test("extractBranchNameFromCommand still detects legitimate branch creation (regression guard)", () => {
  // Plain branch creation
  assert.equal(extractBranchNameFromCommand("git branch feature/add-foo"), "feature/add-foo");
  // With start-point
  assert.equal(extractBranchNameFromCommand("git branch feature/add-foo origin/main"), "feature/add-foo");
  // checkout -b path (BRANCH_COMMAND_PATTERNS[0], not affected by Option 2)
  assert.equal(extractBranchNameFromCommand("git checkout -b chore/foo"), "chore/foo");
});

// ── Prove-it tests (branch extraction read-only flag false positive fix) ──────
// RED phase: these tests fail before the fix is applied.
// Read-only flags (--contains, -l, --list, --merged, --no-merged) cause
// `git branch` to enter list/filter mode — no branch is created.
// Currently (pre-fix) pattern[3] `(?!-)` only blocks flags-as-first-token;
// when a valid branch name precedes the flag (`git branch main --contains sha`),
// `main` is captured as a false positive creation candidate.

describe("extractBranchNameFromCommand: read-only flag bypass", () => {
  test("--contains <sha> → null", () => {
    assert.strictEqual(extractBranchNameFromCommand("git branch main --contains 321d569"), null);
  });
  test("-l (list short) → null", () => {
    assert.strictEqual(extractBranchNameFromCommand("git branch main -l"), null);
  });
  test("--list → null", () => {
    assert.strictEqual(extractBranchNameFromCommand("git branch main --list"), null);
  });
  test("--merged → null", () => {
    assert.strictEqual(extractBranchNameFromCommand("git branch main --merged"), null);
  });
  test("--no-merged → null", () => {
    assert.strictEqual(extractBranchNameFromCommand("git branch main --no-merged"), null);
  });
  // Note: --show-current already returns null pre-fix (pattern[3] `(?!-)` blocks it
  // because `--show-current` is the first token after `git branch `).
  // This test documents the expected behaviour and passes in both RED and GREEN phases.
  test("--show-current → null (already correct pre-fix)", () => {
    assert.strictEqual(extractBranchNameFromCommand("git branch --show-current"), null);
  });
  // Note: flag-before-name ordering `--merged main` already returns null pre-fix
  // because `--merged` starts with `-` and is blocked by pattern[3] `(?!-)`.
  // This test documents the expected behaviour and passes in both RED and GREEN phases.
  test("flag-before-name ordering: --merged main → null (already correct pre-fix)", () => {
    assert.strictEqual(extractBranchNameFromCommand("git branch --merged main"), null);
  });
});

describe("extractBranchNameFromCommand: negative regression (read-only bypass must NOT swallow real ops)", () => {
  // Baseline: bare `git branch <invalid>` must still be detected as creation candidate.
  test("bare git branch <invalid> 仍抓出 candidate", () => {
    assert.strictEqual(extractBranchNameFromCommand("git branch invalid-name"), "invalid-name");
  });
  // Baseline: `git branch -d <name>` returns null pre-fix because pattern[3] `(?!-)`
  // blocks flags-as-first-token, and there is no delete-creation pattern.
  // The fix must NOT change this null return; -d is not a creation op.
  test("git branch -d <name> 走原 gate → 維持 null (delete is not creation)", () => {
    const result = extractBranchNameFromCommand("git branch -d main");
    assert.strictEqual(result, null, "destructive flag -d is not a creation op — must stay null before and after fix");
  });
  // Baseline: `git branch -m old new` returns `new` via pattern[2] (rename).
  // The fix must NOT change this; -m is already handled by a dedicated pattern.
  test("git branch -m old new 走原 gate → 維持回傳 new branch name", () => {
    const result = extractBranchNameFromCommand("git branch -m old new");
    assert.strictEqual(result, "new", "rename flag -m must continue to return new branch name after fix");
  });
});

// ── BN-style cross-command regression tests (anchor + segment filter fix) ───
// cross-ref: archive 2026-05-11-fix-branch-verb-gate-readonly-flags
// These four cases were bypass vectors before the READONLY_FLAG_RE anchor fix:
// the old global regex fired on quoted strings / cross-segment flags, causing
// the function to return null instead of the real branch name.

describe("extractBranchNameFromCommand: cross-command readonly-flag bypass regression", () => {
  test("BN1 regression: env var with --merged 不應 bypass 真實 git checkout -b", () => {
    // attacker / mis-typed cmd 在 env var 塞 --merged，後接真實分支創建
    const result = extractBranchNameFromCommand(
      'MSG="git branch --list test" && git checkout -b feature/add-foo'
    );
    assert.strictEqual(result, "feature/add-foo", "env var 內的 --list 不應讓真分支創建被誤跳過");
  });

  test("BN2 regression: quoted echo with --list 不應 bypass 後續 git branch", () => {
    const result = extractBranchNameFromCommand(
      'echo "git branch --list x" && git branch real-branch'
    );
    assert.strictEqual(result, "real-branch", "quoted echo 內的 --list 不應讓 git branch 真分支創建被誤跳過");
  });

  test("cross-command regression: gh pr create body 含 --merged 不應 bypass --head 抓取", () => {
    // gh pr create --head <branch> 也走 BRANCH_COMMAND_PATTERNS 的 gh pattern
    const result = extractBranchNameFromCommand(
      'gh pr create --base main --head badprefix/cleanup --body "see --merged refs"'
    );
    assert.strictEqual(result, "badprefix/cleanup", "--body 內的 --merged 不應讓 gh pr create --head 抓取被誤跳過");
  });

  test("chained commit regression: commit -m 含 merged 字串不應 bypass 後續 checkout -b", () => {
    const result = extractBranchNameFromCommand(
      'git commit -m "merged: see --merged log" && git checkout -b badprefix/cleanup-foo'
    );
    assert.strictEqual(result, "badprefix/cleanup-foo", "commit message 內的 --merged 不應讓 checkout -b 真分支創建被誤跳過");
  });
});

describe("extractBranchNameFromCommand: readonly-flag sub-cases (flag-before-name variants)", () => {
  test("-l 配 pattern arg → null", () => {
    assert.strictEqual(extractBranchNameFromCommand("git branch -l 'feature/*'"), null);
  });
  test("--list 配 pattern arg → null", () => {
    assert.strictEqual(extractBranchNameFromCommand("git branch --list 'feature/*'"), null);
  });
  test("--no-merged main flag-before-name → null", () => {
    assert.strictEqual(extractBranchNameFromCommand("git branch --no-merged main"), null);
  });
});

describe('extractBranchNameFromCommand: chained-segment regression (readonly + create in compound cmd)', () => {
  test('readonly --merged 後接 git checkout -b → 回 create candidate', () => {
    assert.strictEqual(
      extractBranchNameFromCommand('git branch --merged main && git checkout -b feature/y'),
      'feature/y',
      'readonly subcommand 在前不應吃掉後續 chained creation'
    );
  });
  test('readonly --list 後接 ; chained git checkout -b → 回 create candidate', () => {
    assert.strictEqual(
      extractBranchNameFromCommand('git branch --list ; git checkout -b feature/y'),
      'feature/y'
    );
  });
  test('git checkout -b 在前 + 後接 readonly --merged → 回 create candidate', () => {
    assert.strictEqual(
      extractBranchNameFromCommand('git checkout -b feature/y && git branch --merged main'),
      'feature/y'
    );
  });
});

describe("extractAllBranchNamesFromCommand (multi-occurrence, issue #899 finding (a))", () => {
  test("returns every command-position create in shell order", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand("git checkout -b feature/ok && git checkout -b zzz/bad"),
      ["feature/ok", "zzz/bad"]
    );
  });

  test("no-arg `git branch` in a sibling token does NOT mask a later create", () => {
    // The CRITICAL the PR #933 cross-model review caught: a list-mode git branch must
    // not abort the whole plural scan — only its own metachar-delimited range is skipped.
    assert.deepEqual(
      extractAllBranchNamesFromCommand("git branch && git checkout -b zzz/bad"),
      ["zzz/bad"]
    );
  });

  test("readonly-flag `git branch --merged` in a sibling token does NOT mask a later create", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand("git branch --merged && git checkout -b zzz/bad"),
      ["zzz/bad"]
    );
  });

  test("no-arg `git branch` on a PRIOR LINE does NOT mask a later create (newline separator)", () => {
    // Regression for the fail-OPEN where getMetacharSubcmdRanges split only on
    // `|;&()<>` and omitted \n/\r: a list-mode `git branch` range over-extended
    // across the newline and swallowed the next line's real create, so the
    // branch-verb whitelist gate (Gate 11) saw no names and failed OPEN.
    assert.deepEqual(
      extractAllBranchNamesFromCommand("git branch\ngit checkout -b zzz/bad"),
      ["zzz/bad"]
    );
  });

  test("readonly-flag `git branch --merged` on a PRIOR LINE does NOT mask a later create (newline separator)", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand("git branch --merged\ngit checkout -b zzz/bad"),
      ["zzz/bad"]
    );
  });

  test("CRLF separator behaves like newline (no-arg git branch does not mask a later create)", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand("git branch\r\ngit checkout -b zzz/bad"),
      ["zzz/bad"]
    );
  });

  test("results are sorted by source position across pattern families", () => {
    // worktree-add and checkout -b are matched by different BRANCH_COMMAND_PATTERNS;
    // the result MUST follow shell order, not pattern order.
    assert.deepEqual(
      extractAllBranchNamesFromCommand("git worktree add -b feature/wt /tmp/x && git checkout -b zzz/bad"),
      ["feature/wt", "zzz/bad"]
    );
  });

  test("pure no-arg / list-mode returns empty array", () => {
    assert.deepEqual(extractAllBranchNamesFromCommand("git branch"), []);
    assert.deepEqual(extractAllBranchNamesFromCommand("git branch | head"), []);
  });

  test("shell-expansion name is skipped, not aborted (later literal still surfaces)", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand("git checkout -b $BR && git checkout -b zzz/bad"),
      ["zzz/bad"]
    );
  });

  test("quoted occurrence is skipped (not a real command-position create)", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand('echo "git checkout -b feature/x" && git checkout -b zzz/bad'),
      ["zzz/bad"]
    );
  });
});

// ── N2 / N3 scope validation (issue #959 D1=N2+N3) ─────────────────────────
// prove-it phase: confirm gap (valid=true) before fix is applied.
// After fix these tests assert valid=false.

const REAL_VERBS = new Set([
  "add", "fix", "refactor", "remove", "migrate", "update", "sync",
  "docs", "amend", "strengthen", "wire", "clarify", "enforce", "revert",
]);

describe("N3 kebab-case validation", () => {
  test("N3 block: feature/add-FooBar (uppercase) → valid:false", () => {
    const r = validateBranchName("feature/add-FooBar", REAL_VERBS);
    assert.equal(r.valid, false, "uppercase body must be rejected by N3");
    assert.match(r.reason, /kebab-case/);
  });

  test("N3 block: feature/add-foo_bar (underscore) → valid:false", () => {
    const r = validateBranchName("feature/add-foo_bar", REAL_VERBS);
    assert.equal(r.valid, false, "underscore in body must be rejected by N3");
    assert.match(r.reason, /kebab-case/);
  });

  test("N3 pass: feature/add-foo-bar (valid kebab) → valid:true", () => {
    const r = validateBranchName("feature/add-foo-bar", REAL_VERBS);
    assert.equal(r.valid, true, "valid kebab-case must pass N3");
  });

  test("N3 pass: bugfix/fix-auth-token-refresh → valid:true", () => {
    const r = validateBranchName("bugfix/fix-auth-token-refresh", REAL_VERBS);
    assert.equal(r.valid, true, "valid kebab-case must pass N3");
  });

  test("N3 block: chore/enforce-Branch-Name (uppercase mid) → valid:false", () => {
    const r = validateBranchName("chore/enforce-Branch-Name", REAL_VERBS);
    assert.equal(r.valid, false, "uppercase anywhere in body must be rejected by N3");
    assert.match(r.reason, /kebab-case/);
  });
});

describe("N2 multi-verb validation", () => {
  // N2 now only blocks the explicit "-and-" connector; token==verb check has been
  // removed because whitelist verbs are also natural nouns in scope names.

  test("N2 block: feature/add-and-remove-x (-and- literal) → valid:false", () => {
    const r = validateBranchName("feature/add-and-remove-x", REAL_VERBS);
    assert.equal(r.valid, false, "-and- literal must be rejected by N2");
    assert.match(r.reason, /-and-/);
  });

  test("N2 pass: feature/add-export-retention (export/retention are not verbs) → valid:true", () => {
    const r = validateBranchName("feature/add-export-retention", REAL_VERBS);
    assert.equal(r.valid, true, "non-verb scope tokens must pass N2");
  });

  test("N2 pass: bugfix/fix-auth-session (auth/session are not verbs) → valid:true", () => {
    const r = validateBranchName("bugfix/fix-auth-session", REAL_VERBS);
    assert.equal(r.valid, true, "non-verb scope tokens must pass N2");
  });
});

// ── N2 noun-collision regression (issue #961 cross-model D1-N2 false-positive fix) ──
// Verbs in the whitelist are also common nouns used naturally in scope names.
// With token==verb check removed, all of these must now pass.
describe("N2 noun-collision regression: verb-shaped scope nouns must pass", () => {
  test("feature/add-update-checker (update = noun: thing that checks for updates) → valid:true", () => {
    const r = validateBranchName("feature/add-update-checker", REAL_VERBS);
    assert.equal(r.valid, true, "scope noun 'update' must not be blocked by N2");
  });

  test("feature/add-remove-button (remove = noun: a button labelled Remove) → valid:true", () => {
    const r = validateBranchName("feature/add-remove-button", REAL_VERBS);
    assert.equal(r.valid, true, "scope noun 'remove' must not be blocked by N2");
  });

  test("feature/add-sync-status (sync = noun: synchronisation status display) → valid:true", () => {
    const r = validateBranchName("feature/add-sync-status", REAL_VERBS);
    assert.equal(r.valid, true, "scope noun 'sync' must not be blocked by N2");
  });

  test("feature/add-docs-generator (docs = noun: documentation generator) → valid:true", () => {
    const r = validateBranchName("feature/add-docs-generator", REAL_VERBS);
    assert.equal(r.valid, true, "scope noun 'docs' must not be blocked by N2");
  });

  test("bugfix/fix-add-button-handler (add = noun in scope: handler for the Add button) → valid:true", () => {
    const r = validateBranchName("bugfix/fix-add-button-handler", REAL_VERBS);
    assert.equal(r.valid, true, "scope noun 'add' must not be blocked by N2");
  });

  test("feature/add-refactor-logger (refactor = noun in scope: logger refactoring tool) → valid:true", () => {
    const r = validateBranchName("feature/add-refactor-logger", REAL_VERBS);
    assert.equal(r.valid, true, "scope noun 'refactor' must not be blocked by N2 after fix");
  });
});

describe("N2/N3 regression: exempt branches must not be affected", () => {
  test("chore/bump-v6.30.4 still exempt (bump) → valid:true", () => {
    const r = validateBranchName("chore/bump-v6.30.4", REAL_VERBS);
    assert.equal(r.valid, true);
    assert.equal(r.exempt, "bump");
  });

  test("release/v6.30.4 still exempt (release) → valid:true", () => {
    const r = validateBranchName("release/v6.30.4", REAL_VERBS);
    assert.equal(r.valid, true);
    assert.equal(r.exempt, "release");
  });

  test("rules/ branch skips N2/N3 (validated by validateRulesBranch, not scope)", () => {
    // rules/ has its own validation path; N2/N3 must not interfere
    // Use REPO_ROOT so validateRulesBranch can check source whitelist
    const r = validateBranchName("rules/agent-rules-v6.39.0", REAL_VERBS, REPO_ROOT);
    // result depends on whether agent-rules is in whitelist, but must not be an N2/N3 block
    if (!r.valid) {
      assert.ok(!r.reason.includes("kebab-case"), "N3 must not fire for rules/ branches");
      assert.ok(!r.reason.includes("一動詞一 scope"), "N2 must not fire for rules/ branches");
    }
  });

  test("single-verb valid case: chore/clarify-readme → valid:true", () => {
    const r = validateBranchName("chore/clarify-readme", REAL_VERBS);
    assert.equal(r.valid, true);
    assert.equal(r.verb, "clarify");
  });

  test("hotfix/revert-rules-20260511 passes N2/N3 (rules-date is not a verb, no uppercase/underscore)", () => {
    const r = validateBranchName("hotfix/revert-rules-20260511", REAL_VERBS);
    assert.equal(r.valid, true);
  });
});

// ── N6: RELEASE_EXEMPTION_RE SHA length tightening (issue #959 N6) ──────────
// prove-it pattern: tests written BEFORE the fix is applied.
// Pre-fix: 8-hex is valid=true (gap). Post-fix: 8-hex must be valid=false.
// Canonical SHA length is 7 per `git rev-parse --short=7` (release-sit-uat-pat-prod.md L118).

describe("N6: RELEASE_EXEMPTION_RE SHA length must be exactly 7 hex chars", () => {
  test("N6-pass-7hex: release/20260608-abc1234 (7 hex) → valid:true exempt:release", () => {
    const r = validateBranchName("release/20260608-abc1234", new Set([]));
    assert.equal(r.valid, true, "7-hex SHA must be accepted (canonical --short=7)");
    assert.equal(r.exempt, "release");
  });

  test("N6-reject-8hex: release/20260608-abc12345 (8 hex) → valid:false (not exempt after fix)", () => {
    // PRE-FIX: this WILL FAIL because {7,40} currently accepts 8-hex (gap).
    // POST-FIX: 8-hex must be rejected because RELEASE_EXEMPTION_RE uses {7} exactly.
    const r = validateBranchName("release/20260608-abc12345", new Set([]));
    assert.equal(r.valid, false, "8-hex SHA must be rejected after SHA-length tightening to {7}");
  });

  test("N6-pass-ordinal: release/20260608-abc1234-2 (7 hex + ordinal) → valid:true exempt:release", () => {
    const r = validateBranchName("release/20260608-abc1234-2", new Set([]));
    assert.equal(r.valid, true, "7-hex with ordinal suffix must still be accepted");
    assert.equal(r.exempt, "release");
  });

  test("N6-pass-semver: release/v6.62.0 (SemVer lane) → valid:true exempt:release (unaffected)", () => {
    const r = validateBranchName("release/v6.62.0", new Set([]));
    assert.equal(r.valid, true, "SemVer release lane must not be affected by SHA-length change");
    assert.equal(r.exempt, "release");
  });

  test("N6-pass-rules: release/rules-20260608-2 (rules lane) → valid:true exempt:release (unaffected)", () => {
    const r = validateBranchName("release/rules-20260608-2", new Set([]));
    assert.equal(r.valid, true, "rules lane must not be affected by SHA-length change");
    assert.equal(r.exempt, "release");
  });
});

// ── Regression tests: fix-branch-verb-gate-noarg-offset (off-by-one index fix) ──
// Prove-it bugfix: TOKEN_ANCHOR-anchored patterns have match.index pointing at the
// leading separator char (e.g. `&` in `x && git branch`), not at the `git` verb.
// The no-create suppression range check MUST use the verb position (matchVerbIndex),
// not the raw match.index — otherwise `3 >= 4` is false and suppression fails.
// cross-ref: openspec/changes/fix-branch-verb-gate-noarg-offset/proposal.md

describe("fix-branch-verb-gate-noarg-offset: off-by-one no-create suppression (plural)", () => {
  // Must-suppress (false-positive guard): list-mode git branch preceded by other
  // commands MUST NOT capture the next-line command token as a branch name.
  test("x && git branch\\necho y → [] (no FP: next-line echo must not be captured)", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand("x && git branch\necho y"),
      [],
      "list-mode git branch with preceding cmd: next-line token must not be captured"
    );
  });

  test("echo \"\" && git branch\\necho x → []", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand('echo "" && git branch\necho x'),
      [],
      "list-mode git branch after echo with quoted arg: must not capture next-line token"
    );
  });

  test("full scenario: worktree list + git branch + git log → []", () => {
    const cmd = 'echo "a" && git worktree list && echo ""\necho "b" && git branch\necho "" && git log';
    assert.deepEqual(
      extractAllBranchNamesFromCommand(cmd),
      [],
      "multi-line: git branch on its own line must not capture surrounding commands"
    );
  });

  // Must-suppress (singular path)
  test("extractBranchNameFromCommand: x && git branch\\necho y → null", () => {
    assert.strictEqual(
      extractBranchNameFromCommand("x && git branch\necho y"),
      null,
      "singular: list-mode git branch with preceding cmd must return null"
    );
  });

  // Must-still-catch (over-suppress guard): real creates in the same or adjacent
  // commands must not be swallowed by the fix.
  test("x && git checkout -b zzz/bad → [zzz/bad] (real create still caught)", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand("x && git checkout -b zzz/bad"),
      ["zzz/bad"],
      "real checkout -b after separator-anchored position must still be captured"
    );
  });

  test("x && git branch\\ngit checkout -b feature/y → [feature/y] (next-line create still caught)", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand("x && git branch\ngit checkout -b feature/y"),
      ["feature/y"],
      "no-arg git branch on one line must not mask real create on next line"
    );
  });

  test("x && git branch newbranch → [newbranch] (same-segment name-bearing create still caught)", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand("x && git branch newbranch"),
      ["newbranch"],
      "git branch with explicit name (create) after separator must still be captured"
    );
  });

  test("git branch -m old newname → [newname] (rename still caught)", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand("git branch -m old newname"),
      ["newname"],
      "branch rename must not be affected by the fix"
    );
  });
});

// ── Regression tests: fix-cross-review-evidence-friction (issue #1085) ──
// Single-arg rename `git branch -m <new> && ...` was misparsed: the optional
// old-name group (`\S+\s+`) greedily consumed `<new>`, so the `(\S+)` capture
// landed on the trailing `&&` separator. The fix bounds both the optional
// old-name group and the capture with the `[^\s|;&()<>]+` stop-set (same as the
// `git branch <name>` / `worktree add -b` patterns) so the separator is never
// captured as a branch name. cross-ref: openspec spec.md §"Branch Name
// Extraction Ignores Shell Redirections" (single-arg rename compound scenario).
describe("branch -m single-arg rename in compound command (issue #1085)", () => {
  test("git branch -m <new> && ... → [<new>] not [&&]", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand("git branch -m feature/new-name && git commit -m x"),
      ["feature/new-name"],
      "single-arg rename must capture the new name, not the && separator"
    );
    assert.strictEqual(
      extractBranchNameFromCommand("git branch -m feature/new-name && git commit -m x"),
      "feature/new-name",
      "firstOnly extractor must also capture the new name, not &&"
    );
  });

  test("git branch -M main && ... → [main] not [&&]", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand("git branch -M main && git push"),
      ["main"],
      "-M single-arg rename must capture main, not the && separator"
    );
    assert.strictEqual(
      extractBranchNameFromCommand("git branch -M main && git push"),
      "main",
      "firstOnly -M extractor must capture main, not &&"
    );
  });

  test("git branch -m old new (two-arg) still resolves new", () => {
    assert.strictEqual(
      extractBranchNameFromCommand("git branch -m old new"),
      "new",
      "two-arg rename must still resolve the new name"
    );
    assert.strictEqual(
      extractBranchNameFromCommand("git branch -m old new && echo done"),
      "new",
      "two-arg rename followed by a separator must still resolve the new name"
    );
  });
});

// ── Regression tests: fix-noarg-list-range-attribution (glued-separator no-create range attribution) ──
// Prove-it bugfix: TOKEN_ANCHOR prefix in noCreateRe consumes the leading separator
// into match[0], so m.index points at the separator char (e.g. `\n` or `&` in `&&`),
// NOT at the git verb. When the separator IS the range-split character used by
// getMetacharSubcmdRanges, m.index falls in no range at all → range attribution is
// suppressed → the next-line first token is wrongly captured as a branch-create name.
// Fix: use matchVerbIndex(m) (symmetric with L393/L396 consumer-side, 0fb0d10),
// per openspec spec.md § "Command-Position Verb Matching". Issue #1028.
describe("fix-noarg-list-range-attribution: glued-separator no-create range attribution", () => {
  // T1: prove-it failing tests (RED before fix, GREEN after fix)
  // newline-glued: `\n` is the range-split char; m.index lands on `\n` (outside any
  // range) → range attribution miss → "echo" falsely captured as branch name
  test("newline-glued: echo a\\ngit branch\\necho b → [] (no FP: newline glued to git)", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand("echo a\ngit branch\necho b"),
      [],
      "newline-glued no-arg git branch: next-line token must not be captured"
    );
  });

  // &&-glued: `&` chars are range-split chars; m.index lands on first `&` of `&&`
  // (outside any range) → range attribution miss → "echo" falsely captured
  test("&&-glued: echo a&&git branch\\necho b → [] (no FP: && glued to git)", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand("echo a&&git branch\necho b"),
      [],
      "&&-glued no-arg git branch: next-line token must not be captured"
    );
  });

  // ;-glued / |-glued: same defect family (`;` and `|` are range-split chars too,
  // also FP'd pre-fix per implementation-phase verification) — same single-line fix
  // covers them; locked here so the family stays closed
  test(";-glued: echo a;git branch\\necho b → [] (no FP: ; glued to git)", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand("echo a;git branch\necho b"),
      [],
      ";-glued no-arg git branch: next-line token must not be captured"
    );
  });

  test("|-glued: echo a|git branch\\necho b → [] (no FP: | glued to git)", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand("echo a|git branch\necho b"),
      [],
      "|-glued no-arg git branch: next-line token must not be captured"
    );
  });

  // T1 control group: forms already GREEN before fix (lock against regression)
  // Space-separated `&&` (with space before git) passes pre-fix because m.index
  // lands on the space (inside the range), not on a range-split char.
  test("space-separated control: echo a && git branch --list\\necho b → []", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand("echo a && git branch --list\necho b"),
      [],
      "space-separated --list: must remain [] (control, pre-fix already green)"
    );
  });

  test("space-separated control: x && git branch\\necho y → []", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand("x && git branch\necho y"),
      [],
      "space-separated: must remain [] (control, pre-fix already green via existing fix-branch-verb-gate-noarg-offset)"
    );
  });

  // T1 singular path: extractBranchNameFromCommand uses early-return (L290), not affected
  test("singular: extractBranchNameFromCommand echo a\\ngit branch\\necho b → null", () => {
    assert.strictEqual(
      extractBranchNameFromCommand("echo a\ngit branch\necho b"),
      null,
      "singular path early-return must return null regardless of fix"
    );
  });

  // T3: over-suppress guards (exact-array): fix must NOT suppress real creates
  // Pre-fix: "echo a\ngit branch\ngit checkout -b feature/y" → ["git","feature/y"]
  // (spurious "git" token from next-line FP); post-fix: exactly ["feature/y"]
  test("over-suppress guard: echo a\\ngit branch\\ngit checkout -b feature/y → [feature/y] (no spurious git token)", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand("echo a\ngit branch\ngit checkout -b feature/y"),
      ["feature/y"],
      "fix must eliminate spurious 'git' token and retain real create feature/y"
    );
  });

  // &&-glued form: same-line &&, real create in adjacent segment still captured
  test("over-suppress guard: echo a&&git branch && git checkout -b feature/x → [feature/x]", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand("echo a&&git branch && git checkout -b feature/x"),
      ["feature/x"],
      "&&-glued no-arg list must not mask real create in same-line adjacent segment"
    );
  });

  // same-segment name-bearing create: glued prefix command must not affect create in same range
  test("over-suppress guard: echo a\\ngit branch newbranch → [newbranch] (same-range create)", () => {
    assert.deepEqual(
      extractAllBranchNamesFromCommand("echo a\ngit branch newbranch"),
      ["newbranch"],
      "glued prefix echo a must not suppress git branch newbranch (name-bearing = create)"
    );
  });
});

// ── T3: release regex SHA length cross-file drift guard (I2) ─────────────────
// SSOT: `isConsumerSubsetReleaseBranchExempt` (pre-tool-gate.mjs) and
// `RELEASE_EXEMPTION_RE` (branch-naming.mjs) must both use `[0-9a-f]{7}` for the
// date-SHA segment. These two regex copies are defined independently in two files
// and must stay in sync. If either drifts, this guard turns red.
//
// Three assertions:
//   (a) Behavioral: isConsumerSubsetReleaseBranchExempt("release/20260511-a1b2c3d") === true
//       (7-hex canonical branch must be accepted)
//   (b) Source: branch-naming.mjs RELEASE_EXEMPTION_RE date-SHA segment [0-9a-f]{N} → N === 7
//   (c) Source: pre-tool-gate.mjs isConsumerSubsetReleaseBranchExempt regex [0-9a-f]{N} → N === 7
//       and both N values are equal (cross-file drift check)
//
// Maintenance: if the canonical SHA length changes (e.g. `git rev-parse --short` changes),
// update the {N} in BOTH files together, then update the expected value here.
describe("T3: release regex SHA length cross-file drift guard (I2 SSOT)", () => {
  const branchNamingPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../hooks/lib/branch-naming.mjs"
  );
  const preToolGatePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../hooks/lib/github-merge-exemptions.mjs"
  );

  // (a) Behavioral: canonical 7-hex date-SHA branch must be accepted
  test("T3-behavior: isConsumerSubsetReleaseBranchExempt('release/20260511-a1b2c3d') === true (7-hex canonical)", () => {
    assert.equal(
      isConsumerSubsetReleaseBranchExempt("release/20260511-a1b2c3d"),
      true,
      "canonical 7-hex date-SHA release branch must be accepted by isConsumerSubsetReleaseBranchExempt"
    );
  });

  // (b) Source: branch-naming.mjs RELEASE_EXEMPTION_RE date-SHA segment length must be 7
  test("T3-source-branch-naming: RELEASE_EXEMPTION_RE [0-9a-f]{N} in branch-naming.mjs → N === 7", () => {
    const src = readFileSync(branchNamingPath, "utf8");
    // Find the RELEASE_EXEMPTION_RE definition line and extract [0-9a-f]{N} from it.
    // The date-SHA segment looks like: \d{8}-[0-9a-f]{7}
    const releaseReLines = src.split("\n").filter((l) => l.includes("RELEASE_EXEMPTION_RE"));
    const defLine = releaseReLines.find((l) => l.includes("=") && l.includes("[0-9a-f]"));
    assert.ok(
      defLine,
      "branch-naming.mjs must define RELEASE_EXEMPTION_RE containing [0-9a-f]{N}"
    );
    const m = defLine.match(/\[0-9a-f\]\{(\d+)\}/);
    assert.ok(
      m,
      `RELEASE_EXEMPTION_RE in branch-naming.mjs must contain [0-9a-f]{N}; found line: ${defLine}`
    );
    const N = parseInt(m[1], 10);
    assert.equal(
      N,
      7,
      `branch-naming.mjs RELEASE_EXEMPTION_RE SHA length must be 7, got ${N} — update BOTH files together if changing`
    );
  });

  // (c) Source: pre-tool-gate.mjs isConsumerSubsetReleaseBranchExempt regex length must be 7
  //     AND must equal the length in branch-naming.mjs (cross-file drift check)
  test("T3-source-pre-tool-gate: isConsumerSubsetReleaseBranchExempt [0-9a-f]{N} → N === 7 and equal to branch-naming.mjs", () => {
    const src = readFileSync(preToolGatePath, "utf8");
    // Find the isConsumerSubsetReleaseBranchExempt function body and extract [0-9a-f]{N}
    const lines = src.split("\n");
    const fnIdx = lines.findIndex((l) => l.includes("isConsumerSubsetReleaseBranchExempt") && l.includes("function"));
    assert.ok(
      fnIdx !== -1,
      "pre-tool-gate.mjs must define function isConsumerSubsetReleaseBranchExempt"
    );
    // Look in the function body (next ~3 lines) for the [0-9a-f]{N} pattern
    const bodySlice = lines.slice(fnIdx, fnIdx + 5).join("\n");
    const m = bodySlice.match(/\[0-9a-f\]\{(\d+)\}/);
    assert.ok(
      m,
      `isConsumerSubsetReleaseBranchExempt in pre-tool-gate.mjs must contain [0-9a-f]{N}; found: ${bodySlice}`
    );
    const N = parseInt(m[1], 10);
    assert.equal(
      N,
      7,
      `pre-tool-gate.mjs isConsumerSubsetReleaseBranchExempt SHA length must be 7, got ${N}`
    );

    // Cross-file equality check: extract from branch-naming.mjs and compare
    const bnSrc = readFileSync(branchNamingPath, "utf8");
    const bnDefLine = bnSrc.split("\n").find(
      (l) => l.includes("RELEASE_EXEMPTION_RE") && l.includes("=") && l.includes("[0-9a-f]")
    );
    const bnM = bnDefLine && bnDefLine.match(/\[0-9a-f\]\{(\d+)\}/);
    assert.ok(bnM, "branch-naming.mjs RELEASE_EXEMPTION_RE must also contain [0-9a-f]{N}");
    const bnN = parseInt(bnM[1], 10);
    assert.equal(
      N,
      bnN,
      `SHA length mismatch: pre-tool-gate.mjs isConsumerSubsetReleaseBranchExempt uses {${N}} but branch-naming.mjs RELEASE_EXEMPTION_RE uses {${bnN}} — drift detected, update both files together`
    );
  });
});

// The list-mode (`git branch` / `--list` / `--merged`) suppressors scan an env-assignment and path prefix in front of
// `git`. Those classes stop at a command separator, so a long space-free run of separators costs O(n), not a rescan
// to the end of the run at every separator.
describe("list-mode git branch detection: prefix scan is bounded by separators", () => {
  test("a prefix in front of a list-mode git branch still suppresses the branch-name check", () => {
    assert.strictEqual(extractBranchNameFromCommand("FOO=1 git branch --list"), null);
    assert.strictEqual(extractBranchNameFromCommand("A=1 B=2 /usr/bin/git branch --merged main"), null);
    assert.strictEqual(extractBranchNameFromCommand("true;git branch"), null);
  });

  test("a run of whitespace-separated assignments in front of git branch keeps its meaning", () => {
    const run = "A=1 B=2 C=3 ";
    assert.strictEqual(extractBranchNameFromCommand(`${run}git branch --list`), null);
    assert.strictEqual(extractBranchNameFromCommand(`${run}git branch`), null);
    assert.strictEqual(extractBranchNameFromCommand(`${run}git branch feature/x`), "feature/x");
    assert.strictEqual(extractBranchNameFromCommand(`${run}git branch --merged main && ${run}git checkout -b feature/y`), "feature/y");
    // a word glued to an assignment-looking tail is not an assignment: the verb after it is an argument-position list op
    assert.strictEqual(extractBranchNameFromCommand("echoA=1 git branch --list"), null);
  });

  test("a create after a prefix and a list-mode sibling still surfaces", () => {
    assert.strictEqual(extractBranchNameFromCommand("FOO=1 git branch feature/x"), "feature/x");
    assert.strictEqual(extractBranchNameFromCommand("git branch --list ; FOO=1 git checkout -b feature/y"), "feature/y");
  });

  for (const [label, unit] of [
    ["bare env assignments", ";X=1"],
    ["quote-masked env assignments", ";X=__QUOTED__"],
    ["&& separators", "&&a"],
    ["whitespace-separated env assignments", "X=1 "],
  ]) {
    test(`stays linear on a long run of ${label}`, () => {
      const cmd = unit.repeat(16000) + " git branch --list";
      const start = process.hrtime.bigint();
      extractBranchNameFromCommand(cmd);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      assert.ok(ms < 1000, `${label}: ${ms.toFixed(0)}ms is not linear`);
    });
  }
});
