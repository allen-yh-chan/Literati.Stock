import { spawnSync } from "node:child_process";
import path from "node:path";
import { REPO_ROOT, repoPath } from "./repo-root.mjs";

export function runCli(
  scriptRelOrAbs,
  args = [],
  { cwd = REPO_ROOT, env, input, timeoutMs = 30_000 } = {},
) {
  const scriptPath = path.isAbsolute(scriptRelOrAbs)
    ? scriptRelOrAbs
    : repoPath(scriptRelOrAbs);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    input,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}
