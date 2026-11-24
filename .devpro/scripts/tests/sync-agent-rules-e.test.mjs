import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import {
  STATIC_FILES,
  SYNC_DIRS,
  sourceRoot,
  createSlimSyncSource,
  createConsumerRepo,
  run,
  withConsumerRepo,
  withSlimSyncSource,
} from "./lib/sync-agent-rules-harness.mjs";
import {
  normalizeSymlinkTargetSeparators,
  RESERVED_CONSUMER_BASENAMES,
  computeUninstallPlan,
  TEST_SYNC_SOURCE_ROOT_ENV,
} from "../sync-agent-rules.mjs";
import {
  CONSUMER_PRE_PR_CHECKS_REL,
  CONSUMER_PRE_PR_CHECKS_BASENAME,
} from "../lib/consumer-pre-pr-checks.mjs";
import {
  CONSUMER_SECOND_REVIEW_RULES_REL,
  CONSUMER_SECOND_REVIEW_RULES_BASENAME,
} from "../lib/consumer-second-review-rules.mjs";

/** Applies the synced .gitignore text in a scratch repo; `git check-ignore` exit 0 = ignored, 1 = not ignored. */
async function gitIgnores(gitignoreText, rel) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "sync-gitignore-probe-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: scratch });
    await fs.writeFile(path.join(scratch, ".gitignore"), gitignoreText);
    const result = spawnSync("git", ["check-ignore", "-q", "--no-index", "--", rel], { cwd: scratch });
    assert.ok(result.status === 0 || result.status === 1, `git check-ignore failed: ${result.stderr}`);
    return result.status === 0;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function createPortableTestSymlink(linkTarget, targetPath, kind = "directory") {
  if (process.platform === "win32") {
    await fs.symlink(linkTarget, targetPath, kind === "directory" ? "dir" : "file");
    return;
  }
  await fs.symlink(linkTarget, targetPath);
}

/** Consumer-relative path for a reserved basename (rules.config lives under .devpro/). */
function consumerRelPathForReservedBasename(basename) {
  if (basename === "rules.config") return path.join(".devpro", "rules.config");
  if (basename === "AGENTS.local.md") return "AGENTS.local.md";
  if (basename === CONSUMER_PRE_PR_CHECKS_BASENAME) {
    return path.normalize(CONSUMER_PRE_PR_CHECKS_REL);
  }
  if (basename === CONSUMER_SECOND_REVIEW_RULES_BASENAME) {
    return path.normalize(CONSUMER_SECOND_REVIEW_RULES_REL);
  }
  throw new Error(`unexpected reserved basename: ${basename}`);
}

// ---------------------------------------------------------------------------
// sync symlink distribution
//
// R1: --sync must distribute source-tree symbolic links (skill discovery
// links under .agents/skills/, .claude/skills/) to the consumer repo as real
// symbolic links, not materialized plain files via
// fs.copyFile following the link. Prove-it fixture: createConsumerRepo()'s
// copyDir() now preserves symlinks into the fixture's `submod` source tree
// (see the isSymbolicLink() branch added above), so the source side of this
// test carries a real .agents/skills/devpro symlink exactly like the
// real devpro-agent-rules source repo does.
// ---------------------------------------------------------------------------

describe("sync symlink distribution", () => {
  let ctx;
  let slimSourceRoot;
  before(async () => {
    const slim = await createSlimSyncSource();
    slimSourceRoot = slim.sourceRoot;
    ctx = await createConsumerRepo();
  });
  after(async () => {
    await fs.rm(ctx.tmpDir, { recursive: true, force: true });
    await fs.rm(slimSourceRoot, { recursive: true, force: true });
  });

  it("recreates .agents/skills/devpro as a real symlink (not a materialized copy)", async () => {
    const sourceSymlinkPath = path.join(slimSourceRoot, ".agents", "skills", "devpro");
    const sourceIsSymlink = await fs
      .lstat(sourceSymlinkPath)
      .then((stats) => stats.isSymbolicLink())
      .catch(() => false);
    assert.equal(
      sourceIsSymlink,
      true,
      "fixture precondition: source .agents/skills/devpro must be a symlink"
    );
    const sourceLinkTarget = await fs.readlink(sourceSymlinkPath);

    const { exitCode, stderr } = run(ctx.syncScript, "--sync", {
      cwd: ctx.tmpDir,
      testSourceRoot: slimSourceRoot,
    });
    assert.equal(exitCode, 0, `sync should exit 0; stderr=${stderr}`);

    const consumerSymlinkPath = path.join(ctx.tmpDir, ".agents", "skills", "devpro");
    const consumerStats = await fs.lstat(consumerSymlinkPath).catch(() => null);
    assert.ok(consumerStats, "consumer .agents/skills/devpro must exist after --sync");
    assert.equal(
      consumerStats.isSymbolicLink(),
      true,
      "consumer .agents/skills/devpro must be a symlink, not a materialized plain file/dir"
    );

    const consumerLinkTarget = await fs.readlink(consumerSymlinkPath);
    assert.equal(
      normalizeSymlinkTargetSeparators(consumerLinkTarget),
      normalizeSymlinkTargetSeparators(sourceLinkTarget),
      "recreated link target must equal the source relative target (separator-normalized)"
    );

    const resolvedPath = path.resolve(path.dirname(consumerSymlinkPath), consumerLinkTarget);
    assert.equal(
      resolvedPath,
      path.join(ctx.tmpDir, ".devpro", "agent-skills"),
      "recreated link must resolve to the consumer's own .devpro/agent-skills catalog root"
    );
    const skillMdExists = await fs
      .access(path.join(resolvedPath, "devpro-workflows", "workflows", "SKILL.md"))
      .then(() => true)
      .catch(() => false);
    assert.equal(skillMdExists, true, "resolved catalog root must contain the fixture skill's SKILL.md");
  });

  it("preserves consumer-added extras alongside the synced skill symlink", async () => {
    const skillsDir = path.join(ctx.tmpDir, ".agents", "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    const consumerExtraPath = path.join(skillsDir, "consumer-only.txt");
    await fs.writeFile(consumerExtraPath, "consumer-owned, no source counterpart");

    const { exitCode, stderr } = run(ctx.syncScript, "--sync", {
      cwd: ctx.tmpDir,
      testSourceRoot: slimSourceRoot,
    });
    assert.equal(exitCode, 0, `sync should exit 0; stderr=${stderr}`);

    const extraContent = await fs.readFile(consumerExtraPath, "utf8");
    assert.equal(
      extraContent,
      "consumer-owned, no source counterpart",
      "consumer-only extra with no source-tree counterpart must survive --sync untouched"
    );

    const consumerSymlinkPath = path.join(skillsDir, "devpro");
    const consumerStats = await fs.lstat(consumerSymlinkPath).catch(() => null);
    assert.equal(
      consumerStats?.isSymbolicLink(),
      true,
      "the source-managed skill symlink must still be brought in alongside consumer extras"
    );
  });
});

// ---------------------------------------------------------------------------
// sync symlink distribution — install-side fail-closed guards
//
// The onSymlink recreation branch must be symmetric with the uninstall-side
// classifier (collectDevproSkillSymlinks / applyDClassRemoval): it must NEVER
// destroy consumer-owned content at a discovery path, and must NEVER distribute
// a source symlink whose target escapes the consumer's own .devpro/agent-skills/
// tree. Both guards fail closed (non-zero exit, no filesystem mutation at the
// conflicting node) rather than silently overwriting.
//
//   C1 (data loss): a consumer's own plain dir/file OR a foreign symlink already
//   sitting at .agents/skills/devpro must be left untouched; --sync must
//   refuse and surface a conflict, not fs.rm it.
//   C3 (path traversal): a source discovery symlink pointing outside
//   .devpro/agent-skills/ must not be recreated on the consumer side.
// ---------------------------------------------------------------------------

describe("sync symlink distribution — install-side fail-closed guards", () => {
  it("refuses to overwrite a consumer-owned plain directory at a discovery path (C1)", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      const ctx = await createConsumerRepo();
      try {
        // Consumer already owns a real directory (with content) exactly where the
        // source-managed skill symlink would land.
        const collisionDir = path.join(ctx.tmpDir, ".agents", "skills", "devpro");
        await fs.mkdir(collisionDir, { recursive: true });
        const ownedFile = path.join(collisionDir, "consumer-owned.md");
        await fs.writeFile(ownedFile, "do not delete me");

        const { exitCode, stderr } = run(ctx.syncScript, "--sync", {
          cwd: ctx.tmpDir,
          testSourceRoot: slimSourceRoot,
        });
        assert.notEqual(exitCode, 0, "sync must fail closed on a plain-dir collision, not silently overwrite");

        // The consumer's directory and its content must survive untouched.
        const stillDir = await fs.lstat(collisionDir).catch(() => null);
        assert.equal(stillDir?.isDirectory(), true, "consumer-owned directory must remain a directory");
        const survived = await fs.readFile(ownedFile, "utf8").catch(() => null);
        assert.equal(survived, "do not delete me", "consumer-owned file must not be deleted by --sync");
        assert.match(stderr, /devpro/, "error must name the conflicting discovery path");
      } finally {
        await fs.rm(ctx.tmpDir, { recursive: true, force: true });
      }
    });
  });

  it("refuses to overwrite a consumer-authored foreign symlink at a discovery path (C1)", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      const ctx = await createConsumerRepo();
      try {
        // Consumer owns a symlink at the discovery path that points somewhere of
        // their own choosing — NOT into .devpro/agent-skills/. It is not our
        // artifact and must be left alone.
        const skillsDir = path.join(ctx.tmpDir, ".agents", "skills");
        await fs.mkdir(skillsDir, { recursive: true });
        const foreignTargetDir = path.join(ctx.tmpDir, "consumer-elsewhere");
        await fs.mkdir(foreignTargetDir, { recursive: true });
        const linkPath = path.join(skillsDir, "devpro");
        const foreignRelTarget = path.relative(skillsDir, foreignTargetDir);
        await createPortableTestSymlink(foreignRelTarget, linkPath);

        const { exitCode, stderr } = run(ctx.syncScript, "--sync", {
          cwd: ctx.tmpDir,
          testSourceRoot: slimSourceRoot,
        });
        assert.notEqual(exitCode, 0, "sync must fail closed on a foreign-symlink collision");

        const stats = await fs.lstat(linkPath).catch(() => null);
        assert.equal(stats?.isSymbolicLink(), true, "consumer-authored symlink must remain a symlink");
        const stillTarget = await fs.readlink(linkPath);
        assert.equal(stillTarget, foreignRelTarget, "consumer symlink target must be untouched");
        assert.match(stderr, /devpro/, "error must name the conflicting discovery path");
      } finally {
        await fs.rm(ctx.tmpDir, { recursive: true, force: true });
      }
    });
  });

  it("refuses to distribute a source discovery symlink whose target escapes .devpro/agent-skills/ (C3)", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      const ctx = await createConsumerRepo();
      try {
        // Poison the SOURCE tree with a discovery symlink that resolves OUTSIDE
        // the consumer's own .devpro/agent-skills/ once installed. The install
        // primitive must refuse to recreate it rather than blindly copying the
        // escaping relative target.
        const sourceSkillsDir = path.join(slimSourceRoot, ".agents", "skills");
        await fs.mkdir(sourceSkillsDir, { recursive: true });
        const escapePath = path.join(sourceSkillsDir, "escape-skill");
        // ../../../../etc — far outside any .devpro/agent-skills/ prefix.
        await createPortableTestSymlink(
          path.join("..", "..", "..", "..", "etc"),
          escapePath
        ).catch(() => {});
        const madeEscape = await fs.lstat(escapePath).then((s) => s.isSymbolicLink()).catch(() => false);
        assert.equal(madeEscape, true, "fixture precondition: source escape symlink must exist");

        const { exitCode, stderr } = run(ctx.syncScript, "--sync", {
          cwd: ctx.tmpDir,
          testSourceRoot: slimSourceRoot,
        });
        assert.notEqual(exitCode, 0, "sync must fail closed on an escaping source symlink target");

        const consumerEscape = path.join(ctx.tmpDir, ".agents", "skills", "escape-skill");
        const landed = await fs.lstat(consumerEscape).catch(() => null);
        assert.equal(landed, null, "escaping source symlink must NOT be distributed to the consumer");
        assert.match(stderr, /escape-skill|agent-skills/, "error must explain the confinement violation");
      } finally {
        await fs.rm(ctx.tmpDir, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------------

describe("CLI", () => {
  let ctx;
  before(async () => {
    ctx = await createConsumerRepo();
  });
  after(async () => {
    await fs.rm(ctx.tmpDir, { recursive: true, force: true });
  });

  it("rejects unknown mode", () => {
    const { exitCode, stderr } = run(ctx.syncScript, "--bogus", { cwd: ctx.tmpDir });
    assert.equal(exitCode, 1);
    assert.match(stderr, /Usage/);
  });

  it("keeps README first-time setup on the submodule bootstrap entrypoint", async () => {
    const readme = await fs.readFile(path.join(sourceRoot, "README.md"), "utf8");
    const firstSetup = readme.slice(
      readme.indexOf("### 首次導入"),
      readme.indexOf("### 每次開新對話")
    );

    assert.match(firstSetup, /node \.devpro-agent-rules\/\.devpro\/scripts\/sync-agent-rules\.mjs --sync/);
    assert.doesNotMatch(firstSetup, /node \.devpro\/scripts\/sync-agent-rules\.mjs --sync/);
  });

  it("fails closed from source repo root instead of self-checking", () => {
    const { exitCode, stdout, stderr } = run(
      path.join(sourceRoot, ".devpro/scripts/sync-agent-rules.mjs"),
      "--check",
      { cwd: sourceRoot, useTestSourceRoot: false }
    );

    assert.equal(exitCode, 1);
    assert.doesNotMatch(stdout, /All derived files are in sync/);
    assert.match(stderr, /Cannot determine source root/);
    assert.match(stderr, /consumer repo root containing \.devpro-agent-rules/);
  });

  it("keeps README rules-sync prompt pragmatic and source-resolved", async () => {
    const readme = await fs.readFile(path.join(sourceRoot, "README.md"), "utf8");
    const firstSetup = readme.slice(
      readme.indexOf("### 首次導入"),
      readme.indexOf("### 每次開新對話")
    );

    assert.match(firstSetup, /git ls-remote <source-url> production/);
    assert.match(firstSetup, /git ls-remote --tags <source-url> 'production-v\*'/);
    assert.match(firstSetup, /source `production-v<X\.Y\.Z>` tag discovery 異常/);
    assert.doesNotMatch(firstSetup, /git ls-remote --tags <source-url> 'v\*'/);
    assert.doesNotMatch(firstSetup, /git ls-remote --tags <source-url> production-v\*/);
    assert.doesNotMatch(firstSetup, /git ls-remote --tags <source-url> v\*/);
    assert.match(firstSetup, /rules\/agent-rules-v<X\.Y\.Z>/);
    assert.match(firstSetup, /不要產生 date\+SHA branch/);
    assert.doesNotMatch(firstSetup, new RegExp(["任一必要指令", "非 0"].join("")));
    assert.match(firstSetup, /非 0 不是自動停點/);
    assert.match(firstSetup, /能明確判斷不破壞主原則/);
    assert.match(firstSetup, /繼續做到 PR ready/);
    assert.match(firstSetup, /只做 bootstrap/);
    assert.match(firstSetup, /不在 README 複寫/);
    assert.match(firstSetup, /\.devpro\/agent-rules\/rules-flow-routing\.md/);
    assert.match(firstSetup, /\.devpro\/agent-rules\/rules-flow\.md/);
    assert.match(firstSetup, /\.devpro\/agent-rules\/release-rules-lane\.md/);
    assert.match(firstSetup, /\.devpro\/agent-rules\/release-sit-uat-pat-prod\.md/);
    assert.match(firstSetup, /optional discovery/);
    assert.match(firstSetup, /absent\/skipped/);
    assert.match(firstSetup, /origin\/main` 是 mandatory ref/);
    assert.match(firstSetup, /origin\/master` 是 optional legacy discovery/);
    assert.match(firstSetup, /origin\/develop` 是 optional discovery/);
    assert.match(firstSetup, /git show-ref --verify --quiet refs\/remotes\/origin\/<branch>/);
    assert.match(firstSetup, /不得把 `git rev-parse --verify origin\/master` 這類 probe 的非 0 當作 fail gate/);
    assert.match(firstSetup, /existence-aware checks 驗證 `origin\/production` 與既有 `integration`/);
    assert.match(firstSetup, /remote `production` 已存在但 local tracking branch 不存在時，可執行 `git branch --track production origin\/production`/);
    assert.match(firstSetup, /`origin\/production` 不存在，MUST stop with named blocker `production target absent`/);
    assert.match(firstSetup, /MUST NOT create or push the missing protected production branch/);
    assert.match(firstSetup, /release\/sync automation 外的 repository administration 建立 protected, pull-request-capable production base/);
    assert.match(firstSetup, /`integration` 的既有 clone-local setup 不構成 production bootstrap 授權/);
    assert.doesNotMatch(firstSetup, /git branch production main/);
    assert.doesNotMatch(firstSetup, /git push -u origin production/);
    assert.match(firstSetup, /origin\/rules\/\*/);
    assert.match(firstSetup, /解析本次 `<rules-branch>`/);
    assert.match(firstSetup, /不得掃描或阻擋既有 `origin\/rules\/\*`/);
    assert.match(firstSetup, /直接使用 step 3 算出的 `<rules-branch>`/);
    assert.match(firstSetup, /不要在建分支前用 `git branch -r --list 'origin\/rules\/\*'`/);
    assert.match(firstSetup, /作為停下 gate/);
    assert.doesNotMatch(firstSetup, /不論 PR open\/merged 都停/);
    assert.doesNotMatch(firstSetup, /AI 不判斷 stale rules 分支是否可安全略過/);
    assert.doesNotMatch(firstSetup, new RegExp(["停下時必須列出", "每條命中分支"].join("")));
    assert.doesNotMatch(firstSetup, /唯一例外是使用者已確認進入 conflict-resolution mode/);
    assert.match(firstSetup, /merge\/rebase conflict/);
    assert.match(firstSetup, /可執行選項/);
    assert.match(firstSetup, /PR DIRTY \/ CONFLICTING 補救/);
    assert.match(firstSetup, /補救不在 README 複寫/);
    assert.match(firstSetup, /禁止 `git merge origin\/main` 進 `rules\/\*`/);
    assert.match(firstSetup, /PR branch 只服務 main review\/merge/);
    assert.match(firstSetup, /production rules release 另走 production tag 起點.*並只帶該批 sync commit/);
    assert.match(firstSetup, /submodule checkout drift/);
    assert.match(firstSetup, /AI 不自動從 `main` promote 或打 tag/);
    assert.match(firstSetup, /已導入 repo 先讀小檔/);
    assert.match(firstSetup, /anchor\/base、`\.gitmodules` tracking、sync\/check、commit message 規則以這兩個規則檔為準/);
    assert.doesNotMatch(firstSetup, /JSON 的 `sha`/);
    assert.doesNotMatch(firstSetup, /`origin\/main` 已 tracking `\.devpro-agent-rules` 但 `<anchor-sha>` 沒有 tracking/);
    assert.match(firstSetup, /git worktree add .+\-b <rules-branch> <base>/);
    assert.doesNotMatch(firstSetup, /git switch -c <rules-branch> <anchor>/);
    assert.match(firstSetup, /git ls-tree -d HEAD \.devpro-agent-rules/);
    assert.match(firstSetup, /git submodule add --force -b production <source-url> \.devpro-agent-rules/);
    assert.match(firstSetup, /同步命令/);
    assert.match(firstSetup, /首次導入在 `git worktree add` 後進入 worktree，再插入上述 `git submodule add`/);
    assert.match(
      firstSetup,
      /git worktree add .+\-b <rules-branch> <base>\s+cd .+\s+git submodule update --init --remote \.devpro-agent-rules\s+node \.devpro-agent-rules\/\.devpro\/scripts\/sync-agent-rules\.mjs --sync\s+node \.devpro\/scripts\/sync-agent-rules\.mjs --check/,
      "shared bootstrap/update path must use worktree add, update submodule, run submodule --sync, then root --check"
    );
    assert.doesNotMatch(firstSetup, /node <[^>]+> --sync/, "README must not document placeholder sync scripts");
    assert.match(firstSetup, /`--sync` 一律使用 submodule 內最新版 script/);
    assert.match(firstSetup, /`--check` 使用同步後的 root script/);
    assert.match(firstSetup, /root --sync is a fallback guard, not the standard workflow entrypoint/);
    assert.doesNotMatch(firstSetup, /node \.devpro\/scripts\/sync-agent-rules\.mjs --sync/);
    assert.doesNotMatch(firstSetup, /FIRST_TIME/, "README must not depend on an undefined FIRST_TIME flag");
    assert.match(firstSetup, /若 Step 5 判定為首次導入/);
    assert.match(firstSetup, /scope-filtered baseline audit/);
    assert.match(firstSetup, /commit subject 固定為 `chore: sync devpro-agent-rules \(<sha>\)`/);
    assert.match(firstSetup, /Rules: v<X\.Y\.Z> · Tool: <tool> · Model: <model>/);
    assert.match(firstSetup, /無須詢問使用者是否允許加 footer/);
    assert.match(firstSetup, /gh pr create --base main --title "chore: sync devpro-agent-rules" --body "首次導入或同步至最新版\s+Rules: v<X\.Y\.Z> · Tool: <tool> · Model: <model>"/);
    assert.match(firstSetup, /PR 建立後跑 smoke/);
    assert.match(firstSetup, /node \.devpro\/scripts\/sync-agent-rules\.mjs --check` 必須 pass/);
    assert.match(firstSetup, /gh pr checks <N>` 回 `no checks reported`/);
    assert.match(firstSetup, /gh run list --branch <rules-branch>` 為空/);
    assert.match(firstSetup, /mergeStateStatus=CLEAN/);
    assert.match(firstSetup, /mergeable=MERGEABLE/);
    assert.match(firstSetup, /statusCheckRollup=\[\]/);
    assert.match(firstSetup, /CI: N\/A — no workflow configured or triggered for rules sync/);
    assert.match(firstSetup, /不得只因 `gh pr checks` 非 0 停下/);
    assert.match(firstSetup, /git submodule update --init --remote \.devpro-agent-rules/);
    assert.doesNotMatch(firstSetup, /git submodule update --init \.devpro-agent-rules\s+git submodule update --init --remote \.devpro-agent-rules/);
  });

  it("documents rules-lane bootstrap when anchor predates submodule", async () => {
    const rulesFlow = await fs.readFile(path.join(sourceRoot, ".devpro/agent-rules/rules-flow.md"), "utf8");

    const worktreeAdd = 'git worktree add "$REPO_ROOT/.worktree/rules-<source>-v<X.Y.Z>" -b rules/<source>-v<X.Y.Z> <base>';
    const worktreeCd = 'cd "$REPO_ROOT/.worktree/rules-<source>-v<X.Y.Z>"';
    const routeProbe = "git ls-tree -d HEAD .devpro-agent-rules";

    assert.match(rulesFlow, /REPO_ROOT=\$\(git rev-parse --show-toplevel\)/);
    assert.notEqual(rulesFlow.indexOf(worktreeAdd), -1);
    assert.ok(
      rulesFlow.indexOf(worktreeCd) > rulesFlow.indexOf(worktreeAdd),
      "rules-flow must cd into the rules worktree immediately after worktree add"
    );
    assert.ok(
      rulesFlow.indexOf(routeProbe) > rulesFlow.indexOf(worktreeCd),
      "rules-flow route probe must run after cd into the rules worktree"
    );
    assert.match(rulesFlow, /git ls-tree -d HEAD \.devpro-agent-rules/);
    assert.match(rulesFlow, /legal production anchor/);
    assert.match(rulesFlow, /candidate main ancestor/);
    assert.match(rulesFlow, /MUST fail closed 並依 `release-rules-lane\.md` 先跑 reconciliation classification/);
    assert.match(rulesFlow, /分類完成前不得宣告 bounded repair/);
    assert.match(rulesFlow, /禁止用 `origin\/main` fallback/);
    assert.match(rulesFlow, /首導或 main\/anchor 未導入/);
    assert.match(rulesFlow, /git submodule add --force -b production <source-url> \.devpro-agent-rules/);
    assert.match(rulesFlow, /git submodule update --init --remote \.devpro-agent-rules/);
    assert.match(rulesFlow, /node \.devpro-agent-rules\/\.devpro\/scripts\/sync-agent-rules\.mjs --sync/);
    assert.match(rulesFlow, /root --sync is a fallback guard, not the standard workflow entrypoint/);
    assert.match(rulesFlow, /root path（`\.devpro\/scripts\/sync-agent-rules\.mjs`）執行 `--sync`/);
    assert.match(rulesFlow, /PR DIRTY \/ CONFLICTING 補救/);
    assert.match(rulesFlow, /禁止 `git merge origin\/main` 進 `rules\/\*`/);
    assert.match(rulesFlow, /PR branch 只服務 main review\/merge/);
    assert.match(rulesFlow, /production rules release 必須另從 consumer repo 最近 `production-\*` tag 建 `release\/rules-\*`/);
    assert.match(rulesFlow, /cherry-pick 該批 sync commit/);
    assert.match(rulesFlow, /禁止 rebase\/recreate 到 `origin\/main` 規避/);
    assert.match(rulesFlow, /--force-with-lease/);
    assert.doesNotMatch(rulesFlow, /node \.devpro\/scripts\/sync-agent-rules\.mjs --sync/);
    assert.match(rulesFlow, /unable to rmdir/);
    assert.match(rulesFlow, /清理前先問/);
    assert.match(rulesFlow, /`--check` 比對 consumer root 與 `\.devpro-agent-rules` source/);
    assert.match(rulesFlow, /source repo root 執行 `--sync` \/ `--check` 必須 fail closed/);
  });

  it("documents optional discovery probes and quoted shell patterns in rules-flow", async () => {
    const rulesFlow = await fs.readFile(path.join(sourceRoot, ".devpro/agent-rules/rules-flow.md"), "utf8");

    assert.match(rulesFlow, /Discovery probe 原則/);
    assert.match(rulesFlow, /mandatory 只有 `origin\/main`/);
    assert.match(rulesFlow, /origin\/master` \/ `origin\/develop` absent=skipped/);
    assert.match(rulesFlow, /optional ref 存在且違規/);
    assert.match(rulesFlow, /git ls-remote --tags <source-url> 'production-v\*'/);
    assert.doesNotMatch(rulesFlow, /git ls-remote --tags <source-url> 'v\*'/);
    assert.doesNotMatch(rulesFlow, /git ls-remote --tags <source-url> production-v\*/);
    assert.doesNotMatch(rulesFlow, /git ls-remote --tags <source-url> v\*/);
    assert.match(rulesFlow, /不以 `origin\/rules\/\*` 作前置 gate/);
    assert.match(rulesFlow, /用 expected SemVer branch/);
    assert.doesNotMatch(rulesFlow, /命中即停/);
    assert.match(rulesFlow, /CI N\/A 原則/);
    assert.match(rulesFlow, /consumer rules lane 的必要 smoke 是 `node \.devpro\/scripts\/sync-agent-rules\.mjs --check` pass/);
    assert.match(rulesFlow, /gh pr checks <N>` 回 `no checks reported`/);
    assert.match(rulesFlow, /statusCheckRollup=\[\]/);
    assert.match(rulesFlow, /CI: N\/A — no workflow configured or triggered for rules sync/);
    assert.match(rulesFlow, /不得只因 `gh pr checks` 非 0 停下/);
    assert.match(rulesFlow, /cross-platform-hook-commands\.test\.mjs/);
    assert.match(rulesFlow, /hook 腳本在 SYNC_DIRS/);
    assert.match(rulesFlow, /consumer 同 event custom hooks 會被覆蓋/);
    // The Rollback SOP (including the revert commit message format) moved verbatim to an on-demand leaf.
    const rulesFlowRollback = await fs.readFile(path.join(sourceRoot, ".devpro/agent-rules/rules-flow-rollback.md"), "utf8");
    assert.match(rulesFlowRollback, /Reverts <merge-sha> from consumer rules lane release\./);
    assert.match(rulesFlowRollback, /Reason: <具體原因>/);
    assert.match(rulesFlowRollback, /Action: 開新 rules\/agent-rules-v<X\.Y\.Z> 重做/);
    assert.match(rulesFlow, /Consumer full Node suite diagnostic/);
    assert.match(rulesFlow, /source-only tests MUST 透過 `\.devpro-agent-rules` 解析 source root/);
    assert.match(rulesFlow, /不得要求 consumer business `README\.md` 或 consumer-local `openspec\/specs`/);
  });

  it("guards against stale Cursor hook support wording", async () => {
    const targets = [
      "README.md",
      "openspec/specs/openspec-flow/spec.md",
      ".devpro/agent-rules/rules-flow.md",
    ];
    const stale = /Cursor (?:doesn't support|不支援).*UserPromptSubmit\/Stop|未 wire `UserPromptSubmit\/Stop`/;

    for (const target of targets) {
      const content = await fs.readFile(path.join(sourceRoot, target), "utf8");
      assert.doesNotMatch(content, stale, `${target} must not contain stale Cursor hook support wording`);
    }
  });
});

// ---------------------------------------------------------------------------
// --uninstall
// T1 (add-uninstall-mode): TDD skeleton — --uninstall/--dry-run/--yes/--git-flow
// are not implemented yet. Every case below is expected to FAIL until T2-T9
// land. Do not weaken these assertions to make them pass prematurely.
// ---------------------------------------------------------------------------

describe("wrong directory", () => {
  it("fails when not in consumer repo", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-bad-"));
    const { exitCode, stderr } = run(
      path.join(sourceRoot, ".devpro/scripts/sync-agent-rules.mjs"),
      "--sync",
      { cwd: tmpDir, useTestSourceRoot: false }
    );
    assert.equal(exitCode, 1);
    assert.match(stderr, /Cannot determine source root/);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// RESERVED_CONSUMER_BASENAMES exclusion guard
// T1/T2 (add-consumer-local-overlay): rules.config + AGENTS.local.md must never
// be owned by sync, reported as drift, or deleted by uninstall.
// ---------------------------------------------------------------------------

describe("RESERVED_CONSUMER_BASENAMES exclusion", () => {
  let reservedCtx;
  let reservedSourceRoot;

  before(async () => {
    const slim = await createSlimSyncSource();
    reservedSourceRoot = slim.sourceRoot;
    reservedCtx = await createConsumerRepo();
    const syncResult = run(reservedCtx.syncScript, "--sync", {
      cwd: reservedCtx.tmpDir,
      testSourceRoot: reservedSourceRoot,
    });
    assert.equal(syncResult.exitCode, 0, `shared --sync failed: ${syncResult.stderr}`);
  });

  after(async () => {
    await fs.rm(reservedCtx.tmpDir, { recursive: true, force: true });
    await fs.rm(reservedSourceRoot, { recursive: true, force: true });
  });

  it("exports frozen list with rules.config, AGENTS.local.md, and derived pre-PR checks and second-review rules basenames", () => {
    assert.deepEqual(
      [...RESERVED_CONSUMER_BASENAMES],
      [
        "rules.config",
        "AGENTS.local.md",
        "pre-pr-checks.local.md",
        "second-review-rules.local.md",
      ]
    );
    assert.ok(Object.isFrozen(RESERVED_CONSUMER_BASENAMES));
  });

  it("does not reserve the pre-markdown list names: they are plain consumer files that sync never touches", () => {
    for (const legacy of ["pre-pr-checks.local", "second-review-rules.local"]) {
      assert.ok(!RESERVED_CONSUMER_BASENAMES.includes(legacy), `${legacy} must not be reserved`);
    }
  });

  for (const basename of RESERVED_CONSUMER_BASENAMES) {
    it(`STATIC_FILES contains no entry whose basename is ${basename}`, () => {
      for (const { relPath } of STATIC_FILES) {
        assert.notEqual(
          path.basename(relPath),
          basename,
          `STATIC_FILES entry "${relPath}" must not have basename ${basename}`
        );
      }
    });

    it(`source SYNC_DIRS walk produces no file named ${basename}`, async () => {
      const found = [];
      for (const { relPath } of SYNC_DIRS) {
        const srcDir = path.join(sourceRoot, relPath);
        async function walkForReserved(dir) {
          const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
          for (const entry of entries) {
            if (entry.isDirectory()) {
              await walkForReserved(path.join(dir, entry.name));
            } else if (entry.name === basename) {
              found.push(path.join(dir, entry.name));
            }
          }
        }
        await walkForReserved(srcDir);
      }
      assert.deepEqual(
        found,
        [],
        `Source SYNC_DIRS must not contain any ${basename} file; found: ${found.join(", ")}`
      );
    });

    it(`consumer-local ${basename} survives --sync with same bytes and --check exit 0`, async () => {
      const relPath = consumerRelPathForReservedBasename(basename);
      const filePath = path.join(reservedCtx.tmpDir, relPath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const marker = `# consumer-local ${basename}\nunique-bytes-${basename}\n`;
      await fs.writeFile(filePath, marker);

      try {
        const checkResult = run(reservedCtx.syncScript, "--check", {
          cwd: reservedCtx.tmpDir,
          testSourceRoot: reservedSourceRoot,
        });
        assert.equal(
          checkResult.exitCode,
          0,
          `--check must exit 0 when consumer has local ${basename}; stderr: ${checkResult.stderr}`
        );

        const syncResult = run(reservedCtx.syncScript, "--sync", {
          cwd: reservedCtx.tmpDir,
          testSourceRoot: reservedSourceRoot,
        });
        assert.equal(syncResult.exitCode, 0, `second --sync failed: ${syncResult.stderr}`);

        const after = await fs.readFile(filePath, "utf8");
        assert.equal(after, marker, `consumer-local ${basename} bytes must be preserved by --sync`);
      } finally {
        await fs.rm(filePath, { force: true });
      }
    });
  }

  it("AGENTS.md whole-file copy/check target is literal AGENTS.md, not AGENTS.local.md", async () => {
    const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../sync-agent-rules.mjs");
    const src = await fs.readFile(scriptPath, "utf8");
    assert.match(
      src,
      /\[\.\.\.STATIC_FILES\.map\(\(\{ relPath \}\) => relPath\),\s*"AGENTS\.md"\]/
    );
    assert.match(src, /path\.join\(consumerRoot,\s*"AGENTS\.md"\)/);
    assert.doesNotMatch(src, /path\.join\(consumerRoot,\s*"AGENTS\.local\.md"\)/);
    assert.doesNotMatch(src, /"AGENTS\*"/);
    assert.doesNotMatch(
      src,
      /STATIC_FILES\.map\(\(\{ relPath \}\) => relPath\),\s*"AGENTS\.md",\s*"AGENTS\.local\.md"/
    );
  });

  it("uninstall plan/apply preserves AGENTS.local.md bytes", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withConsumerRepo(async (local) => {
        const syncResult = run(local.syncScript, "--sync", {
          cwd: local.tmpDir,
          testSourceRoot: slimSourceRoot,
        });
        assert.equal(syncResult.exitCode, 0, `--sync failed: ${syncResult.stderr}`);

        const overlayPath = path.join(local.tmpDir, "AGENTS.local.md");
        const marker = "# consumer overlay\npreserve-across-uninstall\n";
        await fs.writeFile(overlayPath, marker);

        const prev = process.env[TEST_SYNC_SOURCE_ROOT_ENV];
        process.env[TEST_SYNC_SOURCE_ROOT_ENV] = slimSourceRoot;
        let plan;
        try {
          plan = await computeUninstallPlan(local.tmpDir);
        } finally {
          if (prev === undefined) delete process.env[TEST_SYNC_SOURCE_ROOT_ENV];
          else process.env[TEST_SYNC_SOURCE_ROOT_ENV] = prev;
        }

        assert.ok(
          !plan.a.includes("AGENTS.local.md"),
          `plan.a must not list AGENTS.local.md: ${JSON.stringify(plan.a)}`
        );
        assert.ok(
          !plan.b.some((p) => p === "AGENTS.local.md" || path.basename(p) === "AGENTS.local.md"),
          `plan.b must not list AGENTS.local.md: ${JSON.stringify(plan.b)}`
        );

        const dryRun = run(local.syncScript, "--uninstall --dry-run", {
          cwd: local.tmpDir,
          testSourceRoot: slimSourceRoot,
        });
        assert.equal(dryRun.exitCode, 0, `--uninstall --dry-run failed: ${dryRun.stderr}`);
        assert.doesNotMatch(dryRun.stdout, /AGENTS\.local\.md/);
        assert.equal(await fs.readFile(overlayPath, "utf8"), marker);

        const apply = run(local.syncScript, "--uninstall --yes", {
          cwd: local.tmpDir,
          testSourceRoot: slimSourceRoot,
        });
        assert.equal(apply.exitCode, 0, `--uninstall --yes failed: ${apply.stderr}`);
        assert.equal(
          await fs.readFile(overlayPath, "utf8"),
          marker,
          "AGENTS.local.md must survive --uninstall apply with identical bytes"
        );
      });
    });
  });
});

// ---------------------------------------------------------------------------
// cross-runtime-parity delta (add-consumer-pre-pr-checks): the consumer pre-PR
// checks list is consumer-owned; sync/check/uninstall never own, drift-report,
// or delete it, and the managed gitignore never hides it.
// ---------------------------------------------------------------------------

describe("consumer pre-PR checks list reserved basename", () => {
  const listRel = path.normalize(CONSUMER_PRE_PR_CHECKS_REL);

  it("Source never ships the pre-PR checks basename", async () => {
    assert.ok(
      RESERVED_CONSUMER_BASENAMES.includes(CONSUMER_PRE_PR_CHECKS_BASENAME),
      "RESERVED_CONSUMER_BASENAMES must include the derived pre-PR checks basename"
    );
    assert.equal(
      path.posix.basename(CONSUMER_PRE_PR_CHECKS_REL),
      CONSUMER_PRE_PR_CHECKS_BASENAME
    );
    const found = [];
    for (const { relPath } of STATIC_FILES) {
      if (path.basename(relPath) === CONSUMER_PRE_PR_CHECKS_BASENAME) found.push(relPath);
    }
    async function walkForList(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory()) await walkForList(path.join(dir, entry.name));
        else if (entry.name === CONSUMER_PRE_PR_CHECKS_BASENAME) found.push(path.join(dir, entry.name));
      }
    }
    for (const { relPath } of SYNC_DIRS) await walkForList(path.join(sourceRoot, relPath));
    assert.deepEqual(found, [], `source must not ship ${CONSUMER_PRE_PR_CHECKS_BASENAME}`);
  });

  it("Sync preserves consumer pre-PR checks bytes: --sync and --check", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withConsumerRepo(async (local) => {
        const first = run(local.syncScript, "--sync", { cwd: local.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(first.exitCode, 0, `--sync failed: ${first.stderr}`);
        const listPath = path.join(local.tmpDir, listRel);
        const unique = "# consumer pre-PR checks\nunique-bytes-pre-pr-checks.local.md\n";
        await fs.mkdir(path.dirname(listPath), { recursive: true });
        await fs.writeFile(listPath, unique);

        const check = run(local.syncScript, "--check", { cwd: local.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(check.exitCode, 0, `--check must not report drift for the list; stderr: ${check.stderr}`);
        assert.doesNotMatch(check.stdout + check.stderr, /pre-pr-checks\.local(\.md)?/);
        assert.equal(await fs.readFile(listPath, "utf8"), unique, "--check must leave the list bytes");

        const second = run(local.syncScript, "--sync", { cwd: local.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(second.exitCode, 0, `second --sync failed: ${second.stderr}`);
        assert.equal(await fs.readFile(listPath, "utf8"), unique, "--sync must leave the list bytes");
        assert.ok(
          RESERVED_CONSUMER_BASENAMES.includes(CONSUMER_PRE_PR_CHECKS_BASENAME),
          "the list basename must be reserved"
        );
      });
    });
  });

  it("Sync preserves consumer pre-PR checks bytes: --uninstall", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withConsumerRepo(async (local) => {
        const first = run(local.syncScript, "--sync", { cwd: local.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(first.exitCode, 0, `--sync failed: ${first.stderr}`);
        const listPath = path.join(local.tmpDir, listRel);
        const unique = "# consumer pre-PR checks\nunique-bytes-pre-pr-checks.local.md\n";
        await fs.mkdir(path.dirname(listPath), { recursive: true });
        await fs.writeFile(listPath, unique);

        const prev = process.env[TEST_SYNC_SOURCE_ROOT_ENV];
        process.env[TEST_SYNC_SOURCE_ROOT_ENV] = slimSourceRoot;
        let plan;
        try {
          plan = await computeUninstallPlan(local.tmpDir);
        } finally {
          if (prev === undefined) delete process.env[TEST_SYNC_SOURCE_ROOT_ENV];
          else process.env[TEST_SYNC_SOURCE_ROOT_ENV] = prev;
        }
        const planned = [...plan.a, ...plan.b].map((p) => p.split(path.sep).join("/"));
        assert.ok(
          !planned.some((p) => p.endsWith(CONSUMER_PRE_PR_CHECKS_BASENAME)),
          `uninstall plan must not list the list: ${JSON.stringify(planned)}`
        );

        const dryRun = run(local.syncScript, "--uninstall --dry-run", { cwd: local.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(dryRun.exitCode, 0, `--uninstall --dry-run failed: ${dryRun.stderr}`);
        assert.doesNotMatch(dryRun.stdout, /pre-pr-checks\.local(\.md)?/);
        const apply = run(local.syncScript, "--uninstall --yes", { cwd: local.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(apply.exitCode, 0, `--uninstall --yes failed: ${apply.stderr}`);
        assert.equal(await fs.readFile(listPath, "utf8"), unique, "--uninstall must leave the list bytes");
      });
    });
  });

  it("A source-side file with the reserved basename is not carried to the consumer", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await fs.mkdir(path.join(slimSourceRoot, ".devpro"), { recursive: true });
      await fs.writeFile(path.join(slimSourceRoot, listRel), "SOURCE-OWNED-BYTES\n");
      await withConsumerRepo(async (local) => {
        const first = run(local.syncScript, "--sync", { cwd: local.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(first.exitCode, 0, `--sync failed: ${first.stderr}`);
        const listPath = path.join(local.tmpDir, listRel);
        await assert.rejects(fs.access(listPath), "consumer must not receive the source-side list");

        const unique = "# consumer pre-PR checks\nunique-bytes-pre-pr-checks.local.md\n";
        await fs.writeFile(listPath, unique);
        const second = run(local.syncScript, "--sync", { cwd: local.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(second.exitCode, 0, `second --sync failed: ${second.stderr}`);
        assert.equal(
          await fs.readFile(listPath, "utf8"),
          unique,
          "existing consumer list must keep its bytes against a same-named source file"
        );
      });
    });
  });

  it("Managed gitignore does not hide the list", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withConsumerRepo(async (local) => {
        const syncResult = run(local.syncScript, "--sync", { cwd: local.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(syncResult.exitCode, 0, `--sync failed: ${syncResult.stderr}`);
        const gi = await fs.readFile(path.join(local.tmpDir, ".gitignore"), "utf8");
        assert.doesNotMatch(gi, /pre-pr-checks\.local(\.md)?/);
        assert.doesNotMatch(gi, /(^|\n)\*\.local(\.md)?(\n|$)/);
        assert.equal(await gitIgnores(gi, ".devpro/pre-pr-checks.local.md"), false, "the managed block must not ignore the list");
      });
    });
  });
});

// ---------------------------------------------------------------------------
// cross-runtime-parity delta (add-consumer-second-review-rules): the consumer
// second-review rules file is consumer-owned; sync/check/uninstall never own,
// drift-report, or delete it, and the managed gitignore never hides it.
// ---------------------------------------------------------------------------

describe("consumer second-review rules file reserved basename", () => {
  const rulesRel = path.normalize(CONSUMER_SECOND_REVIEW_RULES_REL);
  const unique = "# consumer second-review rules\nunique-bytes-second-review-rules.local.md\n";

  it("Source never ships the second-review rules basename", async () => {
    assert.ok(
      RESERVED_CONSUMER_BASENAMES.includes(CONSUMER_SECOND_REVIEW_RULES_BASENAME),
      "RESERVED_CONSUMER_BASENAMES must include the derived second-review rules basename"
    );
    assert.equal(
      path.posix.basename(CONSUMER_SECOND_REVIEW_RULES_REL),
      CONSUMER_SECOND_REVIEW_RULES_BASENAME
    );
    const found = [];
    for (const { relPath } of STATIC_FILES) {
      if (path.basename(relPath) === CONSUMER_SECOND_REVIEW_RULES_BASENAME) found.push(relPath);
    }
    async function walkForRules(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory()) await walkForRules(path.join(dir, entry.name));
        else if (entry.name === CONSUMER_SECOND_REVIEW_RULES_BASENAME) found.push(path.join(dir, entry.name));
      }
    }
    for (const { relPath } of SYNC_DIRS) await walkForRules(path.join(sourceRoot, relPath));
    assert.deepEqual(found, [], `source must not ship ${CONSUMER_SECOND_REVIEW_RULES_BASENAME}`);
  });

  it("Sync preserves consumer second-review rules bytes: --sync", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withConsumerRepo(async (local) => {
        const first = run(local.syncScript, "--sync", { cwd: local.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(first.exitCode, 0, `--sync failed: ${first.stderr}`);
        const rulesPath = path.join(local.tmpDir, rulesRel);
        await fs.mkdir(path.dirname(rulesPath), { recursive: true });
        await fs.writeFile(rulesPath, unique);

        const second = run(local.syncScript, "--sync", { cwd: local.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(second.exitCode, 0, `second --sync failed: ${second.stderr}`);
        assert.equal(await fs.readFile(rulesPath, "utf8"), unique, "--sync must leave the rules file bytes");
      });
    });
  });

  it("Sync preserves consumer second-review rules bytes: --check", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withConsumerRepo(async (local) => {
        const first = run(local.syncScript, "--sync", { cwd: local.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(first.exitCode, 0, `--sync failed: ${first.stderr}`);
        const rulesPath = path.join(local.tmpDir, rulesRel);
        await fs.mkdir(path.dirname(rulesPath), { recursive: true });
        await fs.writeFile(rulesPath, unique);

        const check = run(local.syncScript, "--check", { cwd: local.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(check.exitCode, 0, `--check must not report drift for the rules file; stderr: ${check.stderr}`);
        assert.doesNotMatch(check.stdout + check.stderr, /second-review-rules\.local(\.md)?/);
        assert.equal(await fs.readFile(rulesPath, "utf8"), unique, "--check must leave the rules file bytes");
      });
    });
  });

  it("Sync preserves consumer second-review rules bytes: --uninstall", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withConsumerRepo(async (local) => {
        const first = run(local.syncScript, "--sync", { cwd: local.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(first.exitCode, 0, `--sync failed: ${first.stderr}`);
        const rulesPath = path.join(local.tmpDir, rulesRel);
        await fs.mkdir(path.dirname(rulesPath), { recursive: true });
        await fs.writeFile(rulesPath, unique);

        const prev = process.env[TEST_SYNC_SOURCE_ROOT_ENV];
        process.env[TEST_SYNC_SOURCE_ROOT_ENV] = slimSourceRoot;
        let plan;
        try {
          plan = await computeUninstallPlan(local.tmpDir);
        } finally {
          if (prev === undefined) delete process.env[TEST_SYNC_SOURCE_ROOT_ENV];
          else process.env[TEST_SYNC_SOURCE_ROOT_ENV] = prev;
        }
        const planned = [...plan.a, ...plan.b].map((p) => p.split(path.sep).join("/"));
        assert.ok(
          !planned.some((p) => p.endsWith(CONSUMER_SECOND_REVIEW_RULES_BASENAME)),
          `uninstall plan must not list the rules file: ${JSON.stringify(planned)}`
        );

        const dryRun = run(local.syncScript, "--uninstall --dry-run", { cwd: local.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(dryRun.exitCode, 0, `--uninstall --dry-run failed: ${dryRun.stderr}`);
        assert.doesNotMatch(dryRun.stdout, /second-review-rules\.local(\.md)?/);
        const apply = run(local.syncScript, "--uninstall --yes", { cwd: local.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(apply.exitCode, 0, `--uninstall --yes failed: ${apply.stderr}`);
        assert.equal(await fs.readFile(rulesPath, "utf8"), unique, "--uninstall must leave the rules file bytes");
      });
    });
  });

  it("A source-side second-review rules file is not carried to the consumer", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await fs.mkdir(path.join(slimSourceRoot, ".devpro"), { recursive: true });
      await fs.writeFile(path.join(slimSourceRoot, rulesRel), "SOURCE-OWNED-BYTES\n");
      await withConsumerRepo(async (local) => {
        const first = run(local.syncScript, "--sync", { cwd: local.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(first.exitCode, 0, `--sync failed: ${first.stderr}`);
        const rulesPath = path.join(local.tmpDir, rulesRel);
        await assert.rejects(fs.access(rulesPath), "consumer must not receive the source-side rules file");

        await fs.writeFile(rulesPath, unique);
        const second = run(local.syncScript, "--sync", { cwd: local.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(second.exitCode, 0, `second --sync failed: ${second.stderr}`);
        assert.equal(
          await fs.readFile(rulesPath, "utf8"),
          unique,
          "existing consumer rules file must keep its bytes against a same-named source file"
        );
      });
    });
  });

  it("Managed gitignore does not hide the rules file", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      await withConsumerRepo(async (local) => {
        const syncResult = run(local.syncScript, "--sync", { cwd: local.tmpDir, testSourceRoot: slimSourceRoot });
        assert.equal(syncResult.exitCode, 0, `--sync failed: ${syncResult.stderr}`);
        const gi = await fs.readFile(path.join(local.tmpDir, ".gitignore"), "utf8");
        assert.doesNotMatch(gi, /second-review-rules\.local(\.md)?/);
        assert.doesNotMatch(gi, /(^|\n)\*\.local(\.md)?(\n|$)/);
        assert.equal(await gitIgnores(gi, ".devpro/second-review-rules.local.md"), false, "the managed block must not ignore the rules file");
      });
    });
  });
});

// The consumer skip-paths extension was removed. A stale consumer copy is neither read
// nor reserved any more, but sync/check walk only source files, so nothing may delete or
// rewrite it; `devpro-doctor` is what tells the consumer to remove it. `--uninstall` is
// covered in sync-agent-rules-uninstall.test.mjs. Consumers sync from a git checkout of
// the source, which never tracks the file, so a consumer copy cannot be overwritten. The
// reserved-basename special case was dropped on purpose: an untracked copy planted in a
// source working tree would be synced like any other source file, outside this contract.
// [Scenario: consumer-adoption-tooling :: Rules sync, check and uninstall leave the stale file untouched]
describe("stale consumer .local files are left untouched", () => {
  it("the source tree itself never tracks the removed file, so sync can never overwrite a consumer copy", () => {
    const tracked = execFileSync("git", ["ls-files", "--", ".devpro/cross-model-skip-paths.local"], {
      cwd: sourceRoot,
      encoding: "utf8",
    });
    assert.equal(tracked, "");
  });

  // The two pre-markdown list files are renamed, not removed: they are ordinary consumer files now.
  for (const rel of [
    ".devpro/cross-model-skip-paths.local",
    ".devpro/pre-pr-checks.local",
    ".devpro/second-review-rules.local",
  ]) {
    it(`${rel} survives --sync and --check byte-for-byte`, async () => {
      await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
        await withConsumerRepo(async (local) => {
          const first = run(local.syncScript, "--sync", {
            cwd: local.tmpDir,
            testSourceRoot: slimSourceRoot,
          });
          assert.equal(first.exitCode, 0, `--sync failed: ${first.stderr}`);

          const filePath = path.join(local.tmpDir, ...rel.split("/"));
          const unique = "# stale consumer file\ndocs/**\n";
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, unique);

          const second = run(local.syncScript, "--sync", {
            cwd: local.tmpDir,
            testSourceRoot: slimSourceRoot,
          });
          assert.equal(second.exitCode, 0, `second --sync failed: ${second.stderr}`);
          assert.equal(await fs.readFile(filePath, "utf8"), unique);
          const check = run(local.syncScript, "--check", {
            cwd: local.tmpDir,
            testSourceRoot: slimSourceRoot,
          });
          assert.equal(check.exitCode, 0, `--check failed: ${check.stderr}`);
          assert.equal(await fs.readFile(filePath, "utf8"), unique);
        });
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Root-path re-exec (T1/T2, enforce-sync-prune-verification)
// A --sync invoked from the bootstrapped root .devpro/scripts entrypoint must
// transparently re-exec the submodule's own copy of the script, so the
// currently-executing (potentially stale) in-memory code never runs the
// --sync body itself. This closes the "root-path executes stale code and
// bypasses the newest prune logic" gap. Recursion guard: the submodule copy
// must never re-exec itself.
// ---------------------------------------------------------------------------

describe("root-path re-exec", () => {
  it("root entrypoint --sync re-execs the submodule script and forwards its output", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      const ctx = await createConsumerRepo();
      try {
        // Bootstrap once so the consumer root gets a copy of the (current,
        // re-exec-aware) submodule script at .devpro/scripts/sync-agent-rules.mjs.
        const bootstrap = run(ctx.syncScript, "--sync", {
          cwd: ctx.tmpDir,
          testSourceRoot: slimSourceRoot,
        });
        assert.equal(bootstrap.exitCode, 0, `bootstrap sync failed: ${bootstrap.stderr}`);

        const rootScript = path.join(ctx.tmpDir, ".devpro", "scripts", "sync-agent-rules.mjs");
        const { stdout, exitCode } = run(rootScript, "--sync", {
          cwd: ctx.tmpDir,
          testSourceRoot: slimSourceRoot,
        });

        assert.equal(exitCode, 0, `root-path --sync should re-exec and succeed; stdout=${stdout}`);
        assert.match(
          stdout,
          /Re-executing submodule script/,
          "root-path --sync must announce it is re-executing the submodule script"
        );
        // The re-exec'd submodule process's own stdout (consumerRoot=...) must
        // still surface via inherited stdio.
        assert.match(stdout, /consumerRoot=/);
      } finally {
        await fs.rm(ctx.tmpDir, { recursive: true, force: true });
      }
    });
  });

  it("submodule script itself does not re-exec (recursion guard)", async () => {
    await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
      const ctx = await createConsumerRepo();
      try {
        const { stdout, exitCode } = run(ctx.syncScript, "--sync", {
          cwd: ctx.tmpDir,
          testSourceRoot: slimSourceRoot,
        });

        assert.equal(exitCode, 0, `submodule --sync should succeed directly; stdout=${stdout}`);
        assert.doesNotMatch(
          stdout,
          /Re-executing submodule script/,
          "the submodule script itself must never re-exec (would recurse)"
        );
        assert.match(stdout, /consumerRoot=/);
      } finally {
        await fs.rm(ctx.tmpDir, { recursive: true, force: true });
      }
    });
  });
});
