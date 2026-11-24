import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// Existing gate assertions inspect their complete diagnostic text. Tests of
// transport size and foreign-session silence must call native spawnSync.
export function expandReminderDetailsOutput(stdout, cwd = process.cwd()) {
  try {
    const response = JSON.parse(stdout);
    for (const key of ["reason", "systemMessage"]) {
      const ref = String(response[key] || "").split("\n").find((line) => line.startsWith("Details: "));
      if (ref) response[key] = readFileSync(path.resolve(cwd, ref.slice("Details: ".length)), "utf8").trimEnd();
    }
    return JSON.stringify(response);
  } catch { return stdout; }
}

export function spawnWithReminderDetails(...args) {
  const run = spawnSync(...args);
  const options = args[2] || {};
  let cwd = options.cwd || process.cwd();
  try { cwd = JSON.parse(options.input)?.cwd || cwd; } catch {}
  run.stdout = expandReminderDetailsOutput(run.stdout, cwd);
  return run;
}
