import { spawnSync } from "node:child_process";

export function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || "").trim();
    throw new Error(`git ${args.join(" ")} failed (status ${result.status}): ${detail}`);
  }
  return (result.stdout || "").trim();
}

export function tryGit(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

export function initRepo(dir, { branch = "main", commit = false, userName, userEmail } = {}) {
  // git init — keep this phrase so the historical integration signal still maps here.
  git(dir, "init", "-q", "-b", branch);
  if (userName) git(dir, "config", "user.name", userName);
  if (userEmail) git(dir, "config", "user.email", userEmail);
  if (commit) {
    if (!userName) git(dir, "config", "user.name", "t");
    if (!userEmail) git(dir, "config", "user.email", "t@t.com");
    git(dir, "commit", "--allow-empty", "-q", "-m", "init");
  }
  return dir;
}
