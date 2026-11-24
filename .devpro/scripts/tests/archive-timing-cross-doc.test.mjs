import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";

const RULES_DIR = ".devpro/agent-rules";

async function read(relPath) {
  return fs.readFile(repoPath(relPath), "utf8");
}

// Per rule-anchor-guard-strength.md: polarity-sensitive clauses bind on ONE
// physical line via a compound regex (`[^\n]*`, no bare alternation), so a
// token-preserving reversal cannot pass on tokens supplied by unrelated lines.
// Counting the matching lines (rather than a bare assert.match) also pins
// 唯一命中 — a second copy drifting in is as red as the clause being deleted.
function operativeLines(content, pattern) {
  return content.split("\n").filter((line) => pattern.test(line));
}

function uniqueOperativeLineIndex(content, pattern, label) {
  const lines = content.split("\n");
  const indexes = lines.flatMap((line, index) => pattern.test(line) ? [index] : []);
  assert.equal(indexes.length, 1, `${label} operative line count=${indexes.length}`);
  return indexes[0];
}

function assertStrictlyIncreasingDistinct(positions, label) {
  assert.equal(new Set(positions).size, positions.length, `${label} positions must be distinct`);
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(positions[index - 1] < positions[index], `${label} position ${index - 1} must be strictly before ${index}`);
  }
}

const ARCHIVE_BOUND_TO_FIRST_COMMIT = /(?:archive[^\n]*首次\s*commit|首次\s*commit[^\n]*archive)/i;

function ruleLeafRelPaths() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        found.push(path.relative(REPO_ROOT, abs).split(path.sep).join("/"));
      }
    }
  };
  walk(repoPath(RULES_DIR));
  return found.sort();
}

function readFirst(relPaths) {
  for (const relPath of relPaths) {
    const fullPath = repoPath(relPath);
    if (existsSync(fullPath)) return readFileSync(fullPath, "utf8");
  }
  throw new Error(`none of the candidate files exist: ${relPaths.join(", ")}`);
}

describe("archive timing cross-doc anchors", () => {
  const anchors = [
    ".devpro/agent-rules/ai-autonomy.md",
    ".devpro/agent-rules/git-workflow-tracking.md",
    ".devpro/agent-rules/openspec-step-1-to-9.md",
  ];

  it("normal archive timing is spec freeze before first push/PR, not first commit", async () => {
    for (const relPath of anchors) {
      const content = await read(relPath);
      assert.match(content, /spec freeze/, `${relPath} must mention spec freeze`);
      assert.match(content, /首次 (?:push\/PR|push)/, `${relPath} must anchor archive before first push/PR`);
      assert.doesNotMatch(content, ARCHIVE_BOUND_TO_FIRST_COMMIT, `${relPath} must not bind archive to first commit`);
      assert.match(content, /merge 後.*(?:不再 archive|不得.*archive|不需要.*archive)/s, `${relPath} must forbid normal post-merge archive`);
    }
  });

  it("three OpenSpec carriers order review, sole-child archive commit, transition, then final suite", async () => {
    const carriers = new Map([
      [".devpro/agent-rules/openspec-step-1-to-9.md", {
        firstPush: /Archive[^\n]*spec freeze[^\n]*首次 (?:push\/PR|push)[^\n]*同 PR/i,
        recovery: /^### Post-merge Archive Recovery（漏 archive 補救）$/,
      }],
      [".devpro/agent-rules/openspec-flow.md", {
        firstPush: /Archive[^\n]*首次 (?:push\/PR|push)[^\n]*禁先 PR 後 archive/i,
        recovery: /Post-merge archive recovery[^\n]*openspec-step-1-to-9\.md/i,
      }],
      [".devpro/agent-rules/openspec-archive-principles.md", {
        firstPush: /首次 archive 時點[^\n]*首次 (?:push\/PR|push)[^\n]*禁止先開 PR/i,
        recovery: /Post-merge Recovery[^\n]*entry[^\n]*openspec-step-1-to-9\.md/i,
      }],
    ]);
    for (const [relPath, carrierPatterns] of carriers) {
      const content = await read(relPath);
      const positions = [
        uniqueOperativeLineIndex(content, /committed active HEAD[^\n]*(?:MUST|必須)[^\n]*primary full/i, `${relPath}: committed-active primary full`),
        uniqueOperativeLineIndex(content, /sole-child archive\/promote commit[^\n]*(?:同一次\s*push|same push)/i, `${relPath}: sole-child archive commit`),
        uniqueOperativeLineIndex(content, /valid transition[^\n]*MUST NOT[^\n]*second primary full/i, `${relPath}: transition preserves review coverage`),
        uniqueOperativeLineIndex(content, /final suite[^\n]*(?:--changed main|seal-final)/i, `${relPath}: final suite`),
      ];
      assertStrictlyIncreasingDistinct(positions, `${relPath}: review < archive commit < transition < final suite`);
      uniqueOperativeLineIndex(content, carrierPatterns.firstPush, `${relPath}: first push/PR`);
      uniqueOperativeLineIndex(content, carrierPatterns.recovery, `${relPath}: Post-merge Recovery pointer`);
      assert.doesNotMatch(content, ARCHIVE_BOUND_TO_FIRST_COMMIT, `${relPath} must not bind archive to first commit`);
    }
  });

  it("negative fixtures reject archive bound to first commit while first push/PR stays valid", () => {
    for (const invalid of [
      "archive 必須在首次 commit/push/PR 前完成",
      "首次 commit 之前先 archive",
    ]) assert.match(invalid, ARCHIVE_BOUND_TO_FIRST_COMMIT);
    for (const valid of [
      "archive 必須在首次 push/PR 前完成",
      "archive commit 可與 implementation commits 同一次 push",
    ]) assert.doesNotMatch(valid, ARCHIVE_BOUND_TO_FIRST_COMMIT);
  });

  it("position guard rejects same-line aliases and out-of-order action points", () => {
    assert.throws(() => assertStrictlyIncreasingDistinct([4, 8, 8, 12], "same-line fixture"), /distinct/);
    assert.throws(() => assertStrictlyIncreasingDistinct([4, 9, 7, 12], "order fixture"), /strictly before/);
    assert.doesNotThrow(() => assertStrictlyIncreasingDistinct([4, 8, 10, 12], "valid fixture"));
  });

  it("always-loaded reminder does not instruct archive after gh pr merge", async () => {
    const content = await read(".devpro/agent-rules/ai-autonomy.md");
    assert.doesNotMatch(content, /gh pr merge`? 後同 session 跑 archive/);
    assert.match(content, /Post-merge Archive Recovery/);
  });

  it("pre-merge requirement scope changes reuse same change and re-archive", async () => {
    const archivePrinciples = await read(".devpro/agent-rules/openspec-archive-principles.md");
    const archiveRedoUndo = await read(".devpro/agent-rules/openspec-archive-redo-undo.md");
    const spec = readFirst([
      "openspec/changes/strengthen-second-reviewer-idle-timeout/specs/openspec-flow/spec.md",
      "openspec/specs/openspec-flow/spec.md",
    ]);

    for (const [name, content] of new Map([
      ["openspec-archive-redo-undo.md", archiveRedoUndo],
      ["openspec-flow/spec.md", spec],
    ])) {
      assert.match(content, /requirement scope change/, `${name} must name requirement scope change`);
      assert.match(content, /scope-change/, `${name} must name the decisions trigger`);
      assert.match(content, /same branch\/change\/PR/, `${name} must reuse same branch/change/PR`);
      assert.match(content, /pre-merge re-archive/, `${name} must require pre-merge re-archive`);
    }
    assert.match(
      archivePrinciples,
      /^\*\*Pre-merge Archive Re-do \/ pre-merge re-archive\*\*.*same branch\/change\/PR/m,
      "entry routing line must keep the same branch/change/PR obligation of the Archive Principles requirement",
    );
    assert.ok(
      archivePrinciples.includes("MUST 先讀 `openspec-archive-redo-undo.md`"),
      "entry must send pre-merge re-archive readers to openspec-archive-redo-undo.md",
    );
  });
});

/**
 * 證據時序 (R1/R2) — strengthen-evidence-reverifiability.
 *
 * Both clauses share one invariant: 證據 MUST 能被事後獨立覆核. R1 is the
 * 「跑在非最終內容上」face, R2 the 「跑在 commit 之前」face. Losing either one
 * silently restores a green gate run that covered content the PR never shipped.
 */
describe("evidence re-verifiability 時序 anchors", () => {
  const ADVANCED = `${RULES_DIR}/openspec-quality-advanced-patterns.md`;
  const ENTRY = `${RULES_DIR}/openspec-archive-principles.md`; // de-bundle: Gate (i) pointer lives with Archive 原則 sibling
  // Deliberately 2-carrier: Archive 原則 sibling keeps the MUST sentence + 去向,
  // advanced-patterns keeps the mechanism (openspec-step-1-to-9 entry is under
  // AGENTS.md hot-trigger eager-load bound and only Load-chain-points here).
  // So this sentence is NOT a uniqueness anchor — the carrier SET is what gets
  // pinned, below.
  const ORDERING_MUST = "archive gate MUST 跑在 archive/promote 已 commit 之後";

  it("R1 binds 守門後又改 delta 到 MUST 重跑", async () => {
    const hits = operativeLines(
      await read(ADVANCED),
      /守門的通過只涵蓋它實際讀到的那份內容[^\n]*先前 exit 0 \*\*MUST NOT\*\* 充當最終證據[^\n]*\*\*MUST\*\* 重跑[^\n]*跑的那份是不是最終送出的那份/,
    );
    assert.equal(hits.length, 1, `${ADVANCED} 必須有且只有一行綁定 R1 重跑 MUST`);
  });

  it("R2 mechanism names both victims of the one ordering error", async () => {
    const hits = operativeLines(
      await read(ADVANCED),
      /archive gate MUST 跑在 archive\/promote 已 commit 之後[^\n]*同一個 ordering 錯誤有[^\n]*check \(i\)[^\n]*cadence \(f\)/,
    );
    assert.equal(
      hits.length,
      1,
      `${ADVANCED} 必須有且只有一行同時具名 check (i) 與 cadence (f)`,
    );
  });

  it("R2 entry-leaf pointer keeps the MUST and routes to the mechanism", async () => {
    const hits = operativeLines(
      await read(ENTRY),
      /archive gate MUST 跑在 archive\/promote 已 commit 之後[^\n]*未 commit 時本 check 與 cadence \(f\) 皆失效[^\n]*openspec-quality-advanced-patterns\.md/,
    );
    assert.equal(hits.length, 1, `${ENTRY} 的 Gate (i) pointer 必須唯一且帶去向`);
  });

  it("R2 ordering MUST is carried by exactly the pointer and the mechanism leaf", () => {
    // 雙向集合相等 (rule-anchor-guard-strength.md §插入軸): a superset check
    // would let a third drifting copy pass. 漏列 (pointer deleted) and 插入
    // (copy #3) both turn this red, and the diff names which leaf.
    const carriers = ruleLeafRelPaths().filter((relPath) =>
      readFileSync(repoPath(relPath), "utf8").includes(ORDERING_MUST),
    );
    assert.deepEqual(carriers, [ADVANCED, ENTRY].sort());
  });
});


it("persistence table archives at spec freeze before first push/PR", async () => {
  const content = await read(".devpro/agent-rules/rule-design-principles.md");
  const rows = content.split("\n").filter(line => line.startsWith("| 進行中 |"));
  assert.equal(rows.length, 1);
  assert.match(rows[0], /spec freeze[^\n]*首次 push\/PR 前 archive[^\n]*openspec-archive-principles\.md/);
  assert.doesNotMatch(rows[0], /merge[^\n]*release[^\n]*後 archive/);
});
