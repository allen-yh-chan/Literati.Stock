import { spawnSync } from "node:child_process";

/** Local, current-user observation only. Broker credentials never enter this probe. */
export function classifyGhAuthentication(result, hostname = "github.com") {
  if (result?.error?.code === "ENOENT") return { installed: false, authentication: "not_logged_in" };
  const unknown = { installed: true, authentication: "unknown" };
  if (result?.error || result?.status !== 0) return unknown;
  let document;
  try { document = JSON.parse(result.stdout); } catch { return unknown; }
  const hosts = document?.hosts;
  if (!hosts || typeof hosts !== "object" || Array.isArray(hosts)) return unknown;
  const accounts = hosts[hostname];
  if (accounts === undefined || (Array.isArray(accounts) && accounts.length === 0)) {
    return { installed: true, authentication: "not_logged_in" };
  }
  if (!Array.isArray(accounts)) return unknown;
  const active = accounts.filter((account) => account?.active === true);
  if (active.length !== 1) return unknown;
  if (active[0].state === "success" && typeof active[0].login === "string" && active[0].login) {
    return { installed: true, authentication: "authenticated", account: active[0].login, hostname };
  }
  if (active[0].state === "failure") return { installed: true, authentication: "invalid" };
  return unknown;
}

export function probeGhAuthentication({ spawn = spawnSync, cwd = process.cwd(), hostname = "github.com", env = process.env } = {}) {
  try {
    return classifyGhAuthentication(spawn("gh", ["auth", "status", "--active", "--hostname", hostname, "--json", "hosts"], {
      cwd, env, encoding: "utf8", shell: false, timeout: 10_000, maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }), hostname);
  } catch { return { installed: true, authentication: "unknown" }; }
}

/** An error in an already chosen path is never permission to change identity. */
export function selectGithubRoute({ installed, authentication, targetPermission, outcome, failure, mcpAvailable = false } = {}) {
  if (targetPermission === "denied") return { route: "blocked", reason: "repository_permission_denied" };
  if (outcome === "unknown") return { route: "blocked", reason: "write_outcome_unknown" };
  if (failure) return { route: "blocked", reason: "selected_route_failed" };
  if (installed === true && authentication === "authenticated") return { route: "cli", reason: "gh_authenticated" };
  if (installed === false || (installed === true && authentication === "not_logged_in")) {
    return mcpAvailable
      ? { route: "mcp", reason: installed === false ? "gh_not_installed" : "gh_not_logged_in" }
      : { route: "blocked", reason: "mcp_unavailable" };
  }
  // Probe uncertainty precedes the operation; MCP still authorizes the original user independently.
  if (installed === true && authentication === "unknown" && mcpAvailable) {
    return { route: "mcp", reason: "gh_probe_unavailable" };
  }
  return { route: "blocked", reason: authentication === "invalid" ? "gh_authentication_invalid" : "gh_authentication_unknown" };
}
