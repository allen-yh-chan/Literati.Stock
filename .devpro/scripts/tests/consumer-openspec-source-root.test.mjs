// rules-flow.md "Consumer full Node suite diagnostic": source-only tests MUST
// resolve the source root through `.devpro-agent-rules` and MUST NOT expect a
// consumer-local `openspec/specs`. The OpenSpec corpus exists only in the
// source repository, so test helpers route `openspec/` paths to SOURCE_ROOT.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const LIB_DIR = repoPath(".devpro/scripts/tests/lib");
const tempRoots = [];
after(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

// Build a consumer-shaped tree: the test helpers sit under the consumer root,
// and the source repository is vendored at `.devpro-agent-rules`.
function makeConsumerTree() {
  // realpath: the helpers resolve their own location, which follows symlinks such as macOS /var.
  const root = realpathSync(makeTempDir("consumer-openspec-root-"));
  tempRoots.push(root);
  const consumerLib = path.join(root, ".devpro/scripts/tests/lib");
  mkdirSync(consumerLib, { recursive: true });
  for (const name of ["repo-root.mjs", "source-root.mjs", "read.mjs"]) {
    cpSync(path.join(LIB_DIR, name), path.join(consumerLib, name));
  }
  const source = path.join(root, ".devpro-agent-rules");
  mkdirSync(path.join(source, ".devpro/scripts"), { recursive: true });
  mkdirSync(path.join(source, "openspec/specs/demo"), { recursive: true });
  writeFileSync(path.join(source, "AGENTS.md"), "# source\n");
  writeFileSync(path.join(source, ".devpro/scripts/sync-agent-rules.mjs"), "\n");
  writeFileSync(path.join(source, "openspec/specs/demo/spec.md"), "source spec\n");
  writeFileSync(path.join(root, "AGENTS.md"), "# consumer\n");
  return { root, source, consumerLib };
}

function probe(consumerLib, body) {
  const repoRootUrl = pathToFileURL(path.join(consumerLib, "repo-root.mjs")).href;
  const sourceRootUrl = pathToFileURL(path.join(consumerLib, "source-root.mjs")).href;
  const readUrl = pathToFileURL(path.join(consumerLib, "read.mjs")).href;
  const script = `
    const rr = await import(${JSON.stringify(repoRootUrl)});
    const sr = await import(${JSON.stringify(sourceRootUrl)});
    const rd = await import(${JSON.stringify(readUrl)});
    ${body}
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("in a consumer, repoPath resolves the OpenSpec corpus through .devpro-agent-rules and everything else at the consumer root", () => {
  const { root, source, consumerLib } = makeConsumerTree();
  const out = probe(consumerLib, `
    console.log(JSON.stringify({
      repoRoot: rr.REPO_ROOT,
      sourceRoot: sr.SOURCE_ROOT,
      spec: rr.repoPath("openspec/specs/demo/spec.md"),
      corpus: rr.repoPath("openspec"),
      rule: rr.repoPath(".devpro/agent-rules/x.md"),
      lookalike: rr.repoPath("openspecx/a"),
      text: rd.readRepoFile("openspec/specs/demo/spec.md"),
    }));
  `);
  assert.equal(path.resolve(out.repoRoot), path.resolve(root));
  assert.equal(path.resolve(out.sourceRoot), path.resolve(source));
  assert.equal(out.spec, path.join(path.resolve(source), "openspec/specs/demo/spec.md"));
  assert.equal(out.corpus, path.join(path.resolve(source), "openspec"));
  assert.equal(out.rule, path.join(path.resolve(root), ".devpro/agent-rules/x.md"));
  assert.equal(out.lookalike, path.join(path.resolve(root), "openspecx/a"));
  assert.equal(out.text, "source spec\n");
});

test("source-root.mjs re-exports the single source-root definition from repo-root.mjs", () => {
  const { consumerLib } = makeConsumerTree();
  const out = probe(consumerLib, `
    console.log(JSON.stringify({
      same: sr.SOURCE_ROOT === rr.SOURCE_ROOT && sr.sourcePath === rr.sourcePath && sr.resolveSourceRoot === rr.resolveSourceRoot,
    }));
  `);
  assert.equal(out.same, true);
});

// The checkout root variable joined straight to an "openspec..." literal
// bypasses repoPath and breaks in a consumer. Use repoPath()/sourcePath() or
// SOURCE_ROOT instead. (Temp fixture repos named repoRoot/root are not checked:
// they build their own openspec tree on purpose.)
// (\x60 stands for a backtick so this regex keeps an even backtick count for
// the shard scanner.)
// Whole-file match (global) so a join split across lines is still caught; \s
// spans LF and CRLF line breaks.
const ROOT_JOINED_OPENSPEC = /\bREPO_ROOT\s*,\s*["'\x60]openspec\b/g;

function rootJoinedOpenspecLines(text) {
  return [...text.matchAll(ROOT_JOINED_OPENSPEC)].map((match) => text.slice(0, match.index).split("\n").length);
}

test("the REPO_ROOT-to-openspec scan catches same-line and multi-line joins (LF and CRLF)", () => {
  assert.deepEqual(rootJoinedOpenspecLines('path.join(REPO_ROOT, "openspec/specs/x/spec.md")'), [1]);
  assert.deepEqual(rootJoinedOpenspecLines('a\npath.join(\n  REPO_ROOT,\n  "openspec/changes/x",\n)'), [3]);
  assert.deepEqual(rootJoinedOpenspecLines("path.join(\r\n  REPO_ROOT,\r\n  'openspec', 'specs')"), [2]);
  assert.deepEqual(rootJoinedOpenspecLines('path.join(SOURCE_ROOT, "openspec/specs")\nrepoPath("openspec/specs")'), []);
});

test("no test joins REPO_ROOT directly to an OpenSpec corpus path", () => {
  const testsDir = repoPath(".devpro/scripts/tests");
  const offenders = [];
  for (const name of readdirSync(testsDir)) {
    // This file's own fixture strings above contain the pattern on purpose.
    if (!name.endsWith(".mjs") || name === path.basename(fileURLToPath(import.meta.url))) continue;
    for (const line of rootJoinedOpenspecLines(readFileSync(path.join(testsDir, name), "utf8"))) {
      offenders.push(`${name}:${line}`);
    }
  }
  assert.deepEqual(offenders, []);
});
