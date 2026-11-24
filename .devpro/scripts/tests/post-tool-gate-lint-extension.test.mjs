import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const hook = path.resolve(scriptDir, "../hooks/post-tool-gate.mjs");
const tmpRoot = makeTempDir("post-tool-lint-test-");

after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

function runEditPayload(file) {
  return spawnSync("node", [hook], {
    input: JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: file, cwd: tmpRoot },
      tool_response: { exit_code: 0 },
    }),
    encoding: "utf8",
  });
}

const invalidCases = [
  ["bad.sh", "if then\n"],
  ["bad.json", "{\n"],
  ["bad.mjs", "export const = ;\n"],
  ["bad.py", "def broken(:\n"],
];

for (const [name, content] of invalidCases) {
  test(`PostToolUse syntax validation warns but fail-opens for ${name}`, () => {
    const file = path.join(tmpRoot, name);
    writeFileSync(file, content);

    const result = runEditPayload(file);

    assert.equal(result.status, 0, `hook must fail-open; stderr: ${result.stderr}`);
    assert.match(
      result.stderr,
      /post-tool-gate syntax validation failed \(fail-open\):/,
      "invalid syntax should be reported as a fail-open warning",
    );
  });
}
