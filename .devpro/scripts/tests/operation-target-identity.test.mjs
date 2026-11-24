// destinationIdentity (hooks/lib/operation-target.mjs): the governance identity of the repository an operation writes
// to. `non-devpro` needs positive evidence read from the committed HEAD tree; anything else that cannot be proven stays
// `unknown`: no source-only check applies to it and no relaxation (the rules-lane carve-out) is granted to it.
import "./lib/portable-command-shims.cjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { destinationIdentity, probeDevproTracesAtHead, resetDestinationIdentityCache } from "../hooks/lib/operation-target.mjs";
import { evaluatePreToolUsePayload } from "../hooks/pre-tool-gate.mjs";
import { git, initRepo } from "./lib/git.mjs";
import { makeSourceIdentity, makeConsumerIdentity, makeNonDevproIdentity } from "./lib/identity-fixtures.mjs";

function repo(t, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "op-target-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  initRepo(dir, opts);
  return dir;
}

test("source fixture reads as source", (t) => {
  const dir = repo(t, { commit: true });
  makeSourceIdentity(dir);
  assert.equal(destinationIdentity(dir).identity, "source");
});

test("consumer fixture reads as consumer", (t) => {
  const dir = repo(t, { commit: true });
  makeConsumerIdentity(dir);
  assert.equal(destinationIdentity(dir).identity, "consumer");
});

test("source or consumer evidence without a committed HEAD stays unknown", (t) => {
  for (const make of [makeSourceIdentity, makeConsumerIdentity]) {
    const dir = repo(t);
    make(dir);
    const result = destinationIdentity(dir);
    assert.equal(result.identity, "unknown", make.name);
    assert.match(result.evidence, /no committed HEAD/);
  }
});

test("a missing or empty checkout path is unknown, never the process working directory", () => {
  // The process runs inside the rules source checkout, which itself reads as source.
  for (const input of [undefined, null, "", "   "]) {
    assert.equal(destinationIdentity(input).identity, "unknown", JSON.stringify(input));
  }
});

test("each hook evaluation sees the checkout as it is now, not a cached identity", (t) => {
  const dir = repo(t);
  makeNonDevproIdentity(dir);
  resetDestinationIdentityCache();
  assert.equal(destinationIdentity(dir).identity, "non-devpro");
  initFile(dir, ".devpro/scripts/x.mjs", "// x\n");
  evaluatePreToolUsePayload({ cwd: dir, tool_name: "Bash", tool_input: { command: "echo hi" } });
  assert.equal(destinationIdentity(dir).identity, "unknown");
});

test("a repository without devpro traces at HEAD reads as non-devpro", (t) => {
  const dir = repo(t);
  makeNonDevproIdentity(dir);
  assert.equal(destinationIdentity(dir).identity, "non-devpro");
});

test("non-devpro also holds without an origin", (t) => {
  const dir = repo(t);
  makeNonDevproIdentity(dir, { origin: "" });
  assert.equal(destinationIdentity(dir).identity, "non-devpro");
});

test("a bare git init (no commit) is unknown, not source", (t) => {
  const dir = repo(t);
  const result = destinationIdentity(dir);
  assert.equal(result.identity, "unknown");
  assert.match(result.evidence, /no committed HEAD/);
});

test("a committed .devpro/ directory keeps an unproven repository unknown", (t) => {
  const dir = repo(t);
  makeNonDevproIdentity(dir);
  initFile(dir, ".devpro/scripts/x.mjs", "// x\n");
  assert.equal(destinationIdentity(dir).identity, "unknown");
});

test("a committed .devpro-agent-rules/ directory alone proves a Devpro trace", (t) => {
  const dir = repo(t);
  makeNonDevproIdentity(dir);
  assert.equal(probeDevproTracesAtHead(dir), "confirmed-absent");
  initFile(dir, ".devpro-agent-rules/README.md", "installed rules\n");
  assert.equal(probeDevproTracesAtHead(dir), "present");
  assert.equal(destinationIdentity(dir).identity, "unknown");
});

test("a .gitmodules entry for the rules keeps the repository unknown", (t) => {
  const dir = repo(t);
  makeNonDevproIdentity(dir);
  initFile(dir, ".gitmodules", '[submodule ".devpro-agent-rules"]\n\tpath = .devpro-agent-rules\n\turl = https://github.com/devpro-tw/devpro-agent-rules.git\n');
  assert.equal(destinationIdentity(dir).identity, "unknown");
});

test("a rules .gitmodules entry is read with Git's config grammar: quoted values and inline comments", (t) => {
  for (const text of [
    '[submodule "rules"]\n\tpath = ".devpro-agent-rules" ; installed rules\n',
    '[submodule "rules"]\n\turl = "https://github.com/devpro-tw/devpro-agent-rules.git" # rules\n',
  ]) {
    const dir = repo(t);
    makeNonDevproIdentity(dir);
    initFile(dir, ".gitmodules", text);
    assert.equal(probeDevproTracesAtHead(dir), "present", text);
    assert.equal(destinationIdentity(dir).identity, "unknown", text);
  }
});

test("a rules submodule whose name has spaces and whose path is custom is still found by its URL", (t) => {
  const dir = repo(t);
  makeNonDevproIdentity(dir);
  initFile(dir, ".gitmodules", '[submodule "company rules"]\n\tpath = vendor/rules\n\turl = https://github.com/devpro-tw/devpro-agent-rules.git\n');
  assert.equal(destinationIdentity(dir).identity, "unknown");
  const control = repo(t);
  makeNonDevproIdentity(control);
  initFile(control, ".gitmodules", '[submodule "shared lib"]\n\tpath = vendor/lib\n\turl = https://github.com/example-org/lib.git\n');
  assert.equal(destinationIdentity(control).identity, "non-devpro");
});

test("a malformed committed .gitmodules is a read failure, not proof of absence", (t) => {
  const dir = repo(t);
  makeNonDevproIdentity(dir);
  initFile(dir, ".gitmodules", '[submodule "rules\n');
  const result = destinationIdentity(dir);
  assert.equal(result.identity, "unknown");
  assert.match(result.evidence, /read-failure/);
});

test("an unrelated .gitmodules does not block non-devpro", (t) => {
  const dir = repo(t);
  makeNonDevproIdentity(dir);
  initFile(dir, ".gitmodules", '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = https://github.com/example-org/lib.git\n');
  assert.equal(destinationIdentity(dir).identity, "non-devpro");
});

test("an AGENTS.md with a devpro version line keeps the repository unknown", (t) => {
  const dir = repo(t);
  makeNonDevproIdentity(dir);
  initFile(dir, "AGENTS.md", "# AI Agent 規範\n\n版本：7.17.3\n");
  assert.equal(destinationIdentity(dir).identity, "unknown");
});

test("a BOM-prefixed version line counts, a label and a number on separate lines do not", (t) => {
  const bom = repo(t);
  makeNonDevproIdentity(bom);
  initFile(bom, "AGENTS.md", "\uFEFF版本：7.17.3\n");
  assert.equal(destinationIdentity(bom).identity, "unknown");
  const split = repo(t);
  makeNonDevproIdentity(split);
  initFile(split, "AGENTS.md", "# Release notes\n\n版本：\n7.17.3\n");
  assert.equal(destinationIdentity(split).identity, "non-devpro");
});

test("a plain AGENTS.md does not block non-devpro", (t) => {
  const dir = repo(t);
  makeNonDevproIdentity(dir);
  initFile(dir, "AGENTS.md", "# Agents\n\nUse pnpm.\n");
  assert.equal(destinationIdentity(dir).identity, "non-devpro");
});

test("only the committed tree counts: an untracked .devpro/ does not make a repository devpro", (t) => {
  const dir = repo(t);
  makeNonDevproIdentity(dir);
  initFile(dir, ".devpro/scratch.md", "x\n", { commit: false });
  assert.equal(destinationIdentity(dir).identity, "non-devpro");
});

test("a path outside any git checkout is unknown", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "op-target-nogit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(destinationIdentity(dir).identity, "unknown");
});

function initFile(dir, rel, text, { commit = true } = {}) {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  if (!commit) return;
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-q", "-m", `add ${rel}`);
}

// classifyRepoIdentity reports a missing origin and an unreadable one with the same evidence; only a confirmed absence
// may become non-devpro. A PATH wrapper makes git fail on reading the origin only, while every other git call (HEAD,
// ls-tree) works as usual.
test("an origin that cannot be read keeps the repository unknown; a missing origin does not", (t) => {
  const absent = repo(t, { commit: true });
  makeNonDevproIdentity(absent);
  git(absent, "remote", "remove", "origin");
  const unreadable = repo(t, { commit: true });
  makeNonDevproIdentity(unreadable);
  const bin = mkdtempSync(path.join(tmpdir(), "op-target-git-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  // A Node wrapper (run through the portable command shims on Windows) that fails only the origin reads of `unreadable`.
  writeFileSync(path.join(bin, "git"), `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const args = process.argv.slice(2);
const joined = " " + args.join(" ") + " ";
if (joined.includes(${JSON.stringify(path.basename(unreadable))}) && (joined.includes(" get-url origin ") || joined.includes(" remote.origin.url "))) {
  process.stderr.write("fatal: simulated read error\\n");
  process.exit(128);
}
const env = { ...process.env, PATH: process.env.PATH.split(path.delimiter).filter((dir) => dir !== ${JSON.stringify(bin)}).join(path.delimiter) };
const run = spawnSync("git", args, { stdio: "inherit", env });
process.exit(run.status ?? 1);
`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  try {
    resetDestinationIdentityCache();
    assert.equal(destinationIdentity(absent).identity, "non-devpro");
    const result = destinationIdentity(unreadable);
    assert.equal(result.identity, "unknown", JSON.stringify(result));
    assert.match(result.evidence, /origin cannot be read/);
  } finally {
    process.env.PATH = saved;
    resetDestinationIdentityCache();
  }
});

test("a committed AGENTS.md symlink is not proof that the repository has no rules version line", { skip: process.platform === "win32" && "symlinks need privileges on Windows" }, (t) => {
  const dir = repo(t, { commit: true });
  makeNonDevproIdentity(dir);
  writeFileSync(path.join(dir, "rules.md"), "# AI Agent 規範\n\n版本：7.17.3\n");
  git(dir, "add", "rules.md");
  git(dir, "commit", "-q", "-m", "rules");
  git(dir, "rm", "-q", "--cached", "--ignore-unmatch", "AGENTS.md");
  rmSync(path.join(dir, "AGENTS.md"), { force: true });
  symlinkSync("rules.md", path.join(dir, "AGENTS.md"));
  git(dir, "add", "AGENTS.md");
  git(dir, "commit", "-q", "-m", "link");
  resetDestinationIdentityCache();
  const result = destinationIdentity(dir);
  assert.equal(result.identity, "unknown", JSON.stringify(result));
});

test("the HEAD probe reads one commit: every read names the commit it resolved first", (t) => {
  const dir = repo(t, { commit: true });
  const before = git(dir, "rev-parse", "HEAD").trim();
  mkdirSync(path.join(dir, ".devpro"));
  writeFileSync(path.join(dir, ".devpro", "marker.md"), "x\n");
  git(dir, "add", ".devpro");
  git(dir, "commit", "-q", "-m", "adopt");
  assert.equal(probeDevproTracesAtHead(dir, before), "confirmed-absent", "the given commit, not the moved HEAD");
  assert.equal(probeDevproTracesAtHead(dir), "present");
});
