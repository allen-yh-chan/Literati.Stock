import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { SOURCE_ROOT, sourcePath } from "./lib/source-root.mjs";

const adapterGlob = ".devpro/agent-rules/platform-adapters";
const modelVersionPattern = /\b(Opus|Sonnet|Haiku)\s*[0-9.]+/;
const anchorPattern = /^> _Anchor:/;

function git(args) {
  return execFileSync("git", args, {
    cwd: SOURCE_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function changedAdapterLines() {
  const base = git(["merge-base", "HEAD", "production-v6.53.1"]);
  const diff = git([
    "diff",
    "--unified=0",
    "--no-ext-diff",
    base,
    "--",
    `${adapterGlob}/*.md`,
  ]);
  const changed = [];
  let currentFile = null;
  let newLine = 0;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/")) {
      currentFile = raw.slice("+++ b/".length);
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!currentFile || raw.startsWith("diff --git") || raw.startsWith("--- ")) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      changed.push({ file: currentFile, line: newLine, text: raw.slice(1) });
      newLine += 1;
      continue;
    }
    if (!raw.startsWith("-")) newLine += 1;
  }

  return changed;
}

test("new adapter model-version references have nearby anchor footnotes", () => {
  const failures = [];
  for (const hit of changedAdapterLines().filter((line) => modelVersionPattern.test(line.text))) {
    const fullPath = sourcePath(hit.file);
    const lines = readFileSync(fullPath, "utf8").split("\n");
    const start = Math.max(0, hit.line - 6);
    const end = Math.min(lines.length, hit.line + 5);
    const window = lines.slice(start, end);
    if (!window.some((line) => anchorPattern.test(line))) {
      failures.push(`${hit.file}:${hit.line}: ${hit.text}`);
    }
  }

  assert.deepEqual(
    failures,
    [],
    "New adapter lines containing concrete model versions must include `> _Anchor:` within +/-5 lines.",
  );
});
