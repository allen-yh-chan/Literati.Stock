import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT, repoPath } from "./repo-root.mjs";
import { git, initRepo, tryGit } from "./git.mjs";

function stdinFromPayload(payload) {
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload ?? {});
}

export function runHook(
  hookRelOrAbs,
  payload,
  { cwd = REPO_ROOT, env, argv = [], timeoutMs = 30_000 } = {},
) {
  const hookPath = path.isAbsolute(hookRelOrAbs)
    ? hookRelOrAbs
    : repoPath(hookRelOrAbs);
  // A hook that blocks appends to DEVPRO_FRICTION_LOG; when that is unset friction-log.mjs falls back to
  // DEVPRO_SENTINEL_STATE_DIR/session-friction.log and then to the live hooks/state/session-friction.log.
  // A caller that builds its own env drops the value the suite runner injects, so when the effective env
  // carries none the helper owns a per-invocation temp log instead; that temp log also takes precedence over
  // a caller's DEVPRO_SENTINEL_STATE_DIR, so a test cannot read a friction log back from the sentinel dir.
  const effectiveEnv = env ?? process.env;
  const frictionDir = typeof effectiveEnv.DEVPRO_FRICTION_LOG === "string" && effectiveEnv.DEVPRO_FRICTION_LOG !== ""
    ? null
    : mkdtempSync(path.join(os.tmpdir(), "devpro-hook-friction-"));
  try {
    const result = spawnSync(process.execPath, [hookPath, ...argv], {
      cwd,
      env: frictionDir
        ? { ...effectiveEnv, DEVPRO_FRICTION_LOG: path.join(frictionDir, "session-friction.log") }
        : env,
      input: stdinFromPayload(payload),
      encoding: "utf8",
      timeout: timeoutMs,
    });
    return {
      status: result.status,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  } finally {
    if (frictionDir) rmSync(frictionDir, { recursive: true, force: true });
  }
}

export function advisoryText(result) {
  let json = result?.json;
  if (json == null && typeof result?.stdout === "string" && result.stdout.trim()) {
    try {
      json = JSON.parse(result.stdout);
    } catch {
      json = null;
    }
  }
  if (json == null && result && typeof result === "object" && !("stdout" in result)) {
    json = result;
  }
  return json?.hookSpecificOutput?.additionalContext || json?.systemMessage || "";
}

/**
 * Shared isolated-repo factory used by the pre-tool-gate suite.
 * Extracted and unit-tested; T8 did not wire it into the four pre-tool-gate
 * files because their setupRepo bodies were not byte-identical to this helper.
 */
export function createGateRepoFactory({ tmpRoot, writeFixture }) {
  let repoCounter = 0;
  const branchByCwd = new Map();
  const repoTemplateByKey = new Map();

  function rememberBranch(cwd, branchName) {
    branchByCwd.set(cwd, branchName);
  }

  function currentBranch(cwd) {
    if (branchByCwd.has(cwd)) return branchByCwd.get(cwd);
    const branch = tryGit(cwd, "branch", "--show-current").stdout.trim();
    if (branch) branchByCwd.set(cwd, branch);
    return branch;
  }

  function createRepoTemplate(branchName, { withCommit } = {}) {
    const key = `${withCommit ? "commit" : "branch"}:${branchName}`;
    if (repoTemplateByKey.has(key)) return repoTemplateByKey.get(key);

    const dir = path.join(tmpRoot, `template-${repoTemplateByKey.size}`);
    mkdirSync(dir, { recursive: true });
    initRepo(dir, {
      branch: branchName,
      userName: "t",
      userEmail: "t@t.com",
    });
    writeFileSync(path.join(dir, "x"), "");
    writeFixture(dir);
    if (withCommit) {
      git(dir, "add", "x");
      git(dir, "commit", "-q", "-m", "init");
    }
    repoTemplateByKey.set(key, dir);
    return dir;
  }

  function setupRepo(branchName, { withCommit = false } = {}) {
    const dir = path.join(tmpRoot, `repo-${repoCounter++}`);
    const template = createRepoTemplate(branchName, { withCommit });
    if (withCommit) {
      cpSync(template, dir, { recursive: true });
    } else {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, ".git"), `gitdir: ${path.join(template, ".git")}\n`);
      writeFileSync(path.join(dir, "x"), "");
      writeFixture(dir);
    }
    rememberBranch(dir, branchName);
    return dir;
  }

  return { setupRepo, currentBranch, rememberBranch, createRepoTemplate };
}
