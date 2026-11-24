import { it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  STATIC_FILES,
  SYNC_DIRS,
  run,
  withConsumerRepo,
} from "./lib/sync-agent-rules-harness.mjs";
import {
  buildIgnoredRelPaths,
  normalizeSymlinkTargetSeparators,
} from "../sync-agent-rules.mjs";

it("full-source sync delivers byte-equal files with a reachable release invariant owner", async (t) => {
  await withConsumerRepo(async (ctx) => {
    run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir });
    // Resolve the release invariant from installed rules, without a business spec.
    const glossary = await fs.readFile(path.join(ctx.tmpDir, '.devpro/agent-rules/branch-terminology-glossary.md'), 'utf8');
    const pointer = glossary.match(/^ordinary finite-subset 的 `release ⊆ main`[^\n]*`(\.devpro\/agent-rules\/release-step-1-7\.md)` §Step 2 補充：merge 衝突處理原則「不變式」；MUST 讀取該 rule owner/m);
    assert.ok(pointer, 'installed glossary must point to the distributed rule owner');
    assert.ok(SYNC_DIRS.some(({ relPath }) => pointer[1].startsWith(`${relPath}/`)), 'owner must be in the production delivery manifest');
    const owner = await fs.readFile(path.join(ctx.tmpDir, pointer[1]), 'utf8');
    assert.equal(owner, await fs.readFile(path.join(ctx.submod, pointer[1]), 'utf8'), 'installed owner must equal source bytes');
    const heading = '**Step 2 補充：merge 衝突處理原則**';
    assert.equal(owner.split(heading).length - 1, 1, 'installed owner heading must be unique');
    const section = owner.split(heading)[1].split('\n## ')[0];
    const body = section.split('\n').filter(line => line.startsWith('> **不變式**：'));
    assert.equal(body.length, 1, 'installed invariant must be unique');
    assert.match(body[0], /可部署內容 MUST 來自核准 whole-branch units[^\n]*lawful assembly merge OID[^\n]*MUST NOT 引入未核准 release-only patch／revert／conflict-resolution tree[^\n]*single-round[^\n]*不新增 parallel context 停點/);
    await assert.rejects(fs.stat(path.join(ctx.tmpDir, 'openspec/specs/openspec-flow/spec.md')), { code: 'ENOENT' }, 'consumer business root has no source canonical capability');
    t.diagnostic('consumer --sync: glossary resolves byte-equal Step2 operative owner; business canonical absent');
    for (const { relPath } of STATIC_FILES) {
      const source = await fs.readFile(path.join(ctx.submod, relPath), "utf8");
      const target = await fs.readFile(path.join(ctx.tmpDir, relPath), "utf8");
      assert.equal(target, source, `${relPath} should be byte-equal`);
    }
    for (const { relPath } of SYNC_DIRS) {
      const srcDir = path.join(ctx.submod, relPath);
      const ignoredRelPaths = buildIgnoredRelPaths(relPath);
      async function walkCheck(s, tBase) {
        const entries = await fs.readdir(s, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          const sp = path.join(s, entry.name);
          const tp = path.join(tBase, entry.name);
          const rel = path.relative(ctx.submod, sp);
          const relFromSyncRoot = path.relative(srcDir, sp).split(path.sep).join("/");
          // Match production walkSourceFiles: ignore by sync-root-relative path only
          // (not bare entry.name). Root `.opencode/package.json` is ignored; nested
          // source-owned `.opencode/plugins/package.json` must still be compared.
          if (ignoredRelPaths.has(relFromSyncRoot)) {
            continue; // Same exclusions as syncDir/checkDir (buildIgnoredRelPaths).
          }
          if (rel === path.join(".github", "workflows")) {
            continue; // Consumer repo owns workflow files.
          }
          if (rel === path.join(".devpro", "scripts", "hooks", "state")) {
            continue; // Gitignored runtime hook state, excluded from sync (buildIgnoredRelPaths).
          }
          if (entry.isSymbolicLink()) {
            const sourceLinkTarget = await fs.readlink(sp);
            const targetStats = await fs.lstat(tp).catch(() => null);
            assert.equal(
              targetStats?.isSymbolicLink(),
              true,
              `${rel} should be recreated as a symlink, not a materialized copy`
            );
            const targetLinkTarget = await fs.readlink(tp);
            assert.equal(
              normalizeSymlinkTargetSeparators(targetLinkTarget),
              normalizeSymlinkTargetSeparators(sourceLinkTarget),
              `${rel} symlink target should be separator-normalized equal`
            );
          } else if (entry.isDirectory()) {
            await walkCheck(sp, tp);
          } else {
            const sc = await fs.readFile(sp, "utf8");
            const tc = await fs.readFile(tp, "utf8");
            if (rel === path.join(".codex", "hooks.json")) {
              continue; // .codex/hooks.json is merged per event, not byte-copied.
            }
            if (rel === path.join(".cursor", "hooks.json")) {
              continue; // .cursor/hooks.json is merged per event, not byte-copied.
            }
            assert.equal(tc, sc, `${rel} should be byte-equal`);
          }
        }
      }
      await walkCheck(srcDir, path.join(ctx.tmpDir, relPath));
    }
  }, { fullSubmod: true });
});
