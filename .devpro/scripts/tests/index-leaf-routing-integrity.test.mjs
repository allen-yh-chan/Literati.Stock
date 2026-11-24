/**
 * index-leaf-routing-integrity.test.mjs
 *
 * Asserts that route-first index docs reference only existing leaves,
 * and every leaf is referenced from its index. Catches silent breakage
 * when a leaf is renamed/moved without updating the index.
 *
 * Indices and their expected leaves are declared statically below — adding
 * a new split index requires extending INDEX_LEAF_GROUPS.
 *
 * Migration note (add-first-batch-user-invocable-skills): the `/dp:*` command
 * content SSOT moved from `.claude/commands/dp/*.md` to cross-platform skills
 * under `.devpro/agent-skills/`. The index-leaf topology now lives inside the
 * `devpro:setup-ci` umbrella skill (SKILL.md + references/), so INDEX_LEAF_GROUPS
 * points at the skill, not the thinned command redirects.
 *
 * The security-scan group was intentionally dropped: the G3 `devpro:security-scan`
 * skill is a single SKILL.md + progressive-disclosure references (workflow-templates,
 * sarif-report-flags) — it does NOT use the index-leaf split topology (local / gha /
 * reporting are steps inside SKILL.md, not separate leaf files). Forcing an
 * index-leaf mapping there would be a false alignment.
 *
 * Command-index topology removed (migrate-skill-architecture-to-dp-prefix): the
 * `/dp:*` command surface is abolished — `.claude/commands/dp/` no longer exists,
 * so there is no router-only command leaf left to carry `disable-model-invocation` /
 * `user-invocable` frontmatter flags. Skill (`devpro:setup-ci`, `devpro:security-scan`) is
 * now the sole index/routing entry point; the former ROUTER_ONLY_LEAVES assertion
 * block (and its `router-only leaf visibility flags` describe) is removed rather
 * than repointed, because there is no replacement command-adjacent leaf — the
 * frontmatter contract it guarded belonged to the command file class, which no
 * longer exists.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

// Each leaf carries `path` (repo-relative, for the existence check) and `ref`
// (the skill-relative string the umbrella SKILL.md actually cites, e.g.
// `references/discovery-mode.md`), since a skill references its own leaves by
// a skill-relative path, not a repo-relative one.
const INDEX_LEAF_GROUPS = [
  {
    index: ".devpro/agent-skills/devpro-workflows/setup-ci/SKILL.md",
    leafDir: ".devpro/agent-skills/devpro-workflows/setup-ci",
    leaves: [
      { path: ".devpro/agent-skills/devpro-workflows/setup-ci/references/discovery-mode.md", ref: "references/discovery-mode.md" },
      { path: ".devpro/agent-skills/devpro-workflows/setup-ci/references/integration-component.md", ref: "references/integration-component.md" },
      { path: ".devpro/agent-skills/devpro-workflows/setup-ci/references/codeql-component.md", ref: "references/codeql-component.md" },
    ],
  },
];

async function readFile(relPath) {
  return fs.readFile(repoPath(relPath), "utf8");
}

async function fileExists(relPath) {
  try {
    await fs.access(repoPath(relPath));
    return true;
  } catch {
    return false;
  }
}

describe("index-leaf-routing-integrity", () => {
  for (const group of INDEX_LEAF_GROUPS) {
    describe(group.index, () => {
      it("references only existing leaves", async () => {
        const content = await readFile(group.index);
        for (const leaf of group.leaves) {
          assert.ok(
            await fileExists(leaf.path),
            `leaf 不存在但 index 引用：${leaf.path}（被 ${group.index} 引用）`,
          );
          assert.ok(
            content.includes(leaf.ref),
            `index ${group.index} 必須引用 leaf 路徑 ${leaf.ref}`,
          );
        }
      });

      it("does not reference unknown leaf paths", async () => {
        const content = await readFile(group.index);
        // The umbrella SKILL.md cites its leaves by skill-relative `references/<x>.md`.
        const leafPattern = /references\/[a-zA-Z0-9._-]+\.md/g;
        const registered = new Set(group.leaves.map((l) => l.ref));
        const referenced = new Set(content.match(leafPattern) ?? []);
        for (const ref of referenced) {
          assert.ok(
            registered.has(ref),
            `index ${group.index} 引用了未登記的 leaf 路徑：${ref}`,
          );
        }
      });
    });
  }
});
