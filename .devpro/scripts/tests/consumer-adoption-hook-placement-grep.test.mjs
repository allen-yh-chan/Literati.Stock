import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";

// #2793: a consumer-owned git hook has a legal home under hooks-git/ only when the
// source does not ship a hook of that name. The same-name case must point at the
// consumer's own core.hooksPath instead. The guidance is one physical line in the
// Executable-bit section, so its polarity (source-owned, not consumer-local) and its
// object (own hooksPath, chained deletion guard) are bound in one compound regex.

const doc = readFileSync(path.join(REPO_ROOT, ".devpro/agent-rules/consumer-hook-file-maintenance.md"), "utf8");
const heading = "### Executable-bit restoration (POSIX hook guard)";
const start = doc.indexOf(heading);
assert.ok(start >= 0, "Executable-bit restoration section must exist");
const rest = doc.slice(start + heading.length);
const next = rest.search(/\n### /);
const section = next === -1 ? rest : rest.slice(0, next);

test("same-name consumer hook guidance sits on one line of the Executable-bit section", () => {
  const lines = section.split("\n").filter((line) => line.includes("同名"));
  assert.equal(lines.length, 1, "exactly one line carries the same-name hook guidance");
  assert.match(
    lines[0],
    /同名[^\n]*git ls-files \.devpro\/scripts\/hooks-git[^\n]*source 擁有的 synced 檔[^\n]*不是 consumer-local[^\n]*`core\.hooksPath`[^\n]*chain deletion guard/,
  );
});
