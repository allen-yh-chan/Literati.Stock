/**
 * Guarantee ceiling (cooperative-only).
 *
 * Locks: the wording of `frontend-ui-layout.md` plus its `AGENTS.md` and
 * checklist routing literals.
 * Does NOT prove: that agents follow the locked wording, that a paraphrase with
 * the same meaning is handled correctly, or that the meaning around an intact
 * anchor has not been inverted. Deleting an anchor fails this file; inverting the
 * meaning around an intact anchor does not. Review owns that half.
 *
 * Cooperative-only wording-stability guard for frontend-ui-layout.md
 * plus AGENTS / checklist routing literals for pending #23/#24/#45.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

function stripFrontmatter(raw) {
  const frontmatter = raw.match(/^---\n[\s\S]*?\n---\n/);
  return frontmatter ? raw.slice(frontmatter[0].length) : raw;
}

function readBody(relativePath) {
  return stripFrontmatter(readFileSync(repoPath(relativePath), "utf8"));
}

const LEAF = ".devpro/agent-rules/frontend-ui-layout.md";
const AGENTS = "AGENTS.md";
const CHECKLIST = ".devpro/agent-rules/code-review-checklist.md";

const targets = {
  leaf: readBody(LEAF),
  agents: readFileSync(repoPath(AGENTS), "utf8"),
  checklist: readBody(CHECKLIST),
};

const OPERATIVE_ANCHORS = [
  {
    name: "leaf wireframe MUST before impl",
    target: "leaf",
    rx: /實作[^\n]*開始前，\*\*MUST\*\* 先用 wireframe/,
  },
  {
    name: "leaf wireframe approved token",
    target: "leaf",
    rx: /整項錨定符合：`ui-wireframe: approved \(provenance: user\)`/,
  },
  {
    name: "leaf MUST NOT block dp-analyst",
    target: "leaf",
    rx: /\*\*MUST NOT\*\* 用本閘阻擋 `dp-analyst`/,
  },
  {
    name: "leaf UI orphan MUST NOT",
    target: "leaf",
    rx: /\*\*MUST NOT\*\* 出現因排版[^\n]*單一可見字元独占一行/,
  },
  {
    name: "leaf CJK continuation length MUST NOT",
    target: "leaf",
    rx: /下一行 \*\*MUST NOT\*\* 只剩一或兩個字/,
  },
  {
    name: "leaf CJK continuation symbol MUST NOT",
    target: "leaf",
    rx: /下一行 \*\*MUST NOT\*\* 以「符號」開頭/,
  },
  {
    name: "leaf CJK symbol closed set glyphs",
    target: "leaf",
    rx: /破折號／省略號字形（`—` `──` `…` `⋯`）/,
  },
  {
    name: "leaf design-present MUST NOT block",
    target: "leaf",
    rx: /需求\*\*已\*\*附明確設計稿／mock／已核准視覺規格時：\*\*MUST NOT\*\* 要求 `ui-wireframe: approved \(provenance: user\)`/,
  },
  {
    name: "leaf Enforcement Metadata",
    target: "leaf",
    rx: /### Enforcement Metadata[\s\S]*?cooperative-only/,
  },
  {
    name: "AGENTS routes 先發後至 to security-coding",
    target: "agents",
    rx: /先發後至\/後發先至\/名單切換\|`security-coding\.md`/,
  },
  {
    name: "AGENTS routes wireframe to frontend-ui-layout",
    target: "agents",
    rx: /wireframe\/孤立換行\/中文硬折行\/單一字換行\|`frontend-ui-layout\.md`/,
  },
  {
    name: "checklist AJAX 後發先至 hook",
    target: "checklist",
    rx: /AJAX\/fetch 後發先至（cooperative-only）/,
  },
  {
    name: "checklist UI layout wireframe hook",
    target: "checklist",
    rx: /UI layout／wireframe（cooperative-only）/,
  },
];

for (const anchor of OPERATIVE_ANCHORS) {
  test(`frontend-ui-layout guard: ${anchor.name}`, () => {
    const body = targets[anchor.target];
    assert.match(body, anchor.rx, `missing operative anchor: ${anchor.name}`);
  });
}

test("frontend-ui-layout guard: mutation-localization meta", () => {
  for (const anchor of OPERATIVE_ANCHORS) {
    const body = targets[anchor.target];
    const match = body.match(anchor.rx);
    assert.ok(match, `precondition fail: ${anchor.name}`);
    const mutated = body.replace(match[0], "");
    assert.equal(
      anchor.rx.test(mutated),
      false,
      `anchor not localized (still matches after delete): ${anchor.name}`,
    );
  }
});
