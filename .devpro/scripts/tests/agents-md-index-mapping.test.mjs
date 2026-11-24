import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  DEFAULT_MAX_EAGER_REFS,
  extractAgentsIndexRows,
  findEagerLoadViolations,
} from "../rule-load-ledger.mjs";
import { extractDeclaredLoadChainRefs } from "../lib/load-chain-declarations.mjs";
import { repoPath } from "./lib/repo-root.mjs";

const agentsPath = repoPath("AGENTS.md");
const rulesDir = repoPath(".devpro/agent-rules");

const EXEMPT_ROOT_LEAVES = new Set([
  "code-review-checklist-fallback.md",
  "openspec-flow-fallback.md",
]);

const LOAD_CHAIN_POSITIVE_CASES = [
  ["plain fullwidth colon", "Load-chain：see `foo-sibling.md`"],
  ["blockquote", "> Load-chain：see `foo-sibling.md`"],
  ["bold label", "**Load-chain**：see `foo-sibling.md`"],
  ["parenthetical qualifier", "> Load-chain（on-demand siblings）：see `foo-sibling.md`"],
  ["plain ASCII colon", "Load-chain: see `foo-sibling.md`"],
];

const LOAD_CHAIN_NEGATIVE_CASES = [
  ["ordinary prose", "See also `foo-sibling.md`"],
  ["mid-line label", "Routing note: Load-chain: see `foo-sibling.md`"],
  ["heading", "### Load-chain: see `foo-sibling.md`"],
  ["isolated target", "Example: `foo-sibling.md`"],
  ["next-line target", "Load-chain:\nsee `foo-sibling.md`"],
  ["fenced-code example", "```md\nLoad-chain: see `foo-sibling.md`\n```"],
  ["tilde-fenced example", "~~~md\nLoad-chain: see `foo-sibling.md`\n~~~"],
  ["short fence close", "````md\n```\nLoad-chain: see `foo-sibling.md`\n````"],
  ["HTML comment", "<!--\nLoad-chain: see `foo-sibling.md`\n-->"],
];

async function read(filePath) {
  return fs.readFile(filePath, "utf8");
}

async function rootRuleFiles() {
  const entries = await fs.readdir(rulesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
}

function extractIndexTable(markdown) {
  const section = markdown.match(/## 觸發式載入索引[\s\S]*?\n---/);
  assert.ok(section, "AGENTS.md must contain 觸發式載入索引 section");

  const lines = section[0]
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*-+/.test(line));
  assert.ok(lines.length > 1, "AGENTS.md index table must have data rows");
  return lines.slice(1);
}

function extractLeafRefs(indexRows) {
  const refs = [];
  for (const row of indexRows) {
    for (const match of row.matchAll(/`([^`]+\.md)`/g)) {
      refs.push(match[1].trim());
    }
  }
  return refs;
}

function resolveRootLeaf(ref) {
  if (ref.includes("*")) return null;
  if (ref.startsWith(".devpro/agent-rules/")) return path.basename(ref);
  if (!ref.includes("/")) return ref;
  return null;
}

async function expandOneHopCoverage(indexRows, readRuleLeaf) {
  const refs = extractLeafRefs(indexRows);
  const covered = new Set(refs.map(resolveRootLeaf).filter(Boolean));

  for (const leaf of [...covered]) {
    try {
      const content = await readRuleLeaf(leaf);
      for (const ref of extractDeclaredLoadChainRefs(content)) {
        const resolved = resolveRootLeaf(ref);
        if (resolved) covered.add(resolved);
      }
    } catch {
      // Phantom direct refs are checked independently by the corpus test.
    }
  }

  return covered;
}

describe("extractDeclaredLoadChainRefs", () => {
  it("accepts the supported declaration prefixes and returns raw same-line targets", () => {
    const cases = [
      ["leading whitespace", "  Load-chain: see `target.md`", ["target.md"]],
      ["single blockquote", "> Load-chain：see `target.md`", ["target.md"]],
      ["bold label", "**Load-chain**: see `target.md`", ["target.md"]],
      ["ASCII qualifier", "Load-chain (on-demand siblings): see `target.md`", ["target.md"]],
      ["fullwidth qualifier", "Load-chain（on-demand siblings）：see `target.md`", ["target.md"]],
      [
        "multiple same-line targets",
        "Load-chain：see `first.md` and `.devpro/agent-rules/second.md`",
        ["first.md", ".devpro/agent-rules/second.md"],
      ],
    ];

    for (const [name, markdown, expected] of cases) {
      assert.deepEqual(extractDeclaredLoadChainRefs(markdown), expected, name);
    }
  });

  it("rejects headings, prose, isolated mentions, and following-paragraph targets", () => {
    const cases = [
      ["heading", "### Load-chain: see `target.md`"],
      ["mid-line prose", "Routing note: Load-chain: see `target.md`"],
      ["isolated mention", "Load-chain"],
      ["next-paragraph ref", "Load-chain:\n\nSee `target.md`"],
      ["fenced-code example", "```md\nLoad-chain: see `target.md`\n```"],
      ["tilde-fenced example", "~~~md\nLoad-chain: see `target.md`\n~~~"],
      ["short fence close", "````md\n```\nLoad-chain: see `target.md`\n````"],
      ["HTML comment", "<!--\nLoad-chain: see `target.md`\n-->"],
      ["comment prefix", "<!-- example -->Load-chain: see `target.md`"],
      ["comment-split target", "Load-chain: see `tar<!-- example -->get.md`"],
    ];

    for (const [name, markdown] of cases) {
      assert.deepEqual(extractDeclaredLoadChainRefs(markdown), [], name);
    }
  });
});

describe("AGENTS.md trigger index mapping", () => {
  it("references only existing rule leaves or documented wildcard paths", async () => {
    const [agents, rootFiles] = await Promise.all([read(agentsPath), rootRuleFiles()]);
    const rootFileSet = new Set(rootFiles);
    const refs = extractLeafRefs(extractIndexTable(agents));

    const phantoms = [];
    for (const ref of refs) {
      if (ref === "platform-adapters/*.md") continue;
      const leaf = resolveRootLeaf(ref);
      if (!leaf) continue;
      if (!rootFileSet.has(leaf)) phantoms.push(ref);
    }

    assert.deepEqual(phantoms, [], `AGENTS.md has phantom rule leaf refs: ${phantoms.join(", ")}`);
  });

  it("covers every non-exempt root .devpro/agent-rules/*.md leaf at least once", async () => {
    const [agents, rootFiles] = await Promise.all([read(agentsPath), rootRuleFiles()]);
    const covered = await expandOneHopCoverage(
      extractIndexTable(agents),
      (leaf) => read(path.join(rulesDir, leaf))
    );

    const missing = rootFiles.filter(
      (file) => !EXEMPT_ROOT_LEAVES.has(file) && !covered.has(file)
    );

    assert.deepEqual(
      missing,
      [],
      `AGENTS.md trigger index missing root rule leaves: ${missing.join(", ")}`
    );
  });

  it("does not cover a sibling from an indexed leaf's ordinary prose mention", async () => {
    const covered = await expandOneHopCoverage(
      ["|fixture|`foo.md`|"],
      async (leaf) => {
        assert.equal(leaf, "foo.md");
        return "See also `foo-sibling.md`";
      }
    );

    assert.deepEqual(
      [...covered].sort(),
      ["foo.md"],
      "ordinary prose must not declare a one-hop Load-chain sibling"
    );
  });

  it("accepts every supported Load-chain declaration form", async () => {
    for (const [name, content] of LOAD_CHAIN_POSITIVE_CASES) {
      const covered = await expandOneHopCoverage(
        ["|fixture|`foo.md`|"],
        async () => content
      );

      assert.ok(covered.has("foo-sibling.md"), `${name} must declare the sibling`);
    }
  });

  it("never promotes an indirectly covered leaf into a second-hop anchor", async () => {
    const reads = [];
    const covered = await expandOneHopCoverage(
      ["|fixture|`foo.md`|"],
      async (leaf) => {
        reads.push(leaf);
        if (leaf === "foo.md") return "Load-chain: see `foo-sibling.md`";
        if (leaf === "foo-sibling.md") return "Load-chain: see `foo-grandchild.md`";
        return "";
      }
    );

    assert.deepEqual(reads, ["foo.md"], "only direct AGENTS entries may be expansion anchors");
    assert.equal(covered.has("foo-sibling.md"), true);
    assert.equal(covered.has("foo-grandchild.md"), false);
  });

  it("rejects non-declaration Load-chain and Markdown contexts", async () => {
    for (const [name, content] of LOAD_CHAIN_NEGATIVE_CASES) {
      const covered = await expandOneHopCoverage(
        ["|fixture|`foo.md`|"],
        async () => content
      );

      assert.equal(covered.has("foo-sibling.md"), false, `${name} must stay uncovered`);
    }
  });

  it("keeps trigger index eager-load fanout within budget", async () => {
    const agents = await read(agentsPath);
    const rows = extractAgentsIndexRows(agents);
    const violations = findEagerLoadViolations(
      rows.map((row) => ({ ...row, eagerRefCount: row.refs.length })),
      DEFAULT_MAX_EAGER_REFS
    );

    assert.deepEqual(
      violations.map((row) => `${row.line}:${row.intent}:${row.eagerRefCount}`),
      [],
      `AGENTS.md trigger index rows must eager-load <=${DEFAULT_MAX_EAGER_REFS} rule refs`
    );
  });

  it("does not eager-load wildcard rule refs from the trigger index", async () => {
    const agents = await read(agentsPath);
    const rows = extractAgentsIndexRows(agents);
    const wildcardRows = rows.filter((row) => row.refs.some((ref) => ref.includes("*")));

    assert.deepEqual(
      wildcardRows.map((row) => `${row.line}:${row.intent}:${row.refs.join(",")}`),
      [],
      "AGENTS.md trigger index must not eager-load wildcard rule refs"
    );
  });

  it("has a dedicated debugging/failure route entry pointing to troubleshooting.md", async () => {
    const agents = await read(agentsPath);
    const rows = extractIndexTable(agents);

    // troubleshooting.md must have its own debugging-context entry, not only the
    // Consumer-Program row. The trigger phrase was narrowed (index-tidy change)
    // from "Build/runtime/CI/測試失敗…" to "測試失敗、非預期行為、偵錯排查"; assert on
    // the stable debugging anchor (偵錯) rather than the removed Build/CI alias.
    const hasDebugRoute = rows.some(
      (row) =>
        /偵錯|失敗/.test(row) &&
        /troubleshooting\.md/.test(row)
    );

    assert.ok(
      hasDebugRoute,
      "AGENTS.md trigger index must have a dedicated 偵錯/失敗排查 entry pointing to troubleshooting.md (not just the Consumer-Program row)"
    );
  });

  it("keeps the 拆分 synonym on the doc split route entry", async () => {
    const agents = await read(agentsPath);
    const rows = extractIndexTable(agents);
    const docSplitRows = rows.filter((row) => /doc-split-and-dedup-sop\.md/.test(row));

    assert.equal(
      docSplitRows.length,
      1,
      "AGENTS.md trigger index must have exactly one doc-split-and-dedup-sop.md route entry"
    );
    assert.match(
      docSplitRows[0],
      /拆分/,
      "AGENTS.md doc split route entry must preserve the 拆分 synonym trigger"
    );
  });
});
