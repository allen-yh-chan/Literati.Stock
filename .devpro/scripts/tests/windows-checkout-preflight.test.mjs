import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import path from "node:path";
import {
  evaluateWindowsCheckoutPreflight,
  isCanonicalSourceRepoRoot,
  WINDOWS_CHECKOUT_PREFLIGHT_PATHS,
} from "../windows-checkout-preflight.mjs";
import * as preflightModule from "../windows-checkout-preflight.mjs";

const repoRoot = "/fixture/repo";

function makeGit({ symlinks = "true", autocrlf = "false", mode = "120000" } = {}) {
  return (args) => {
    if (args[0] === "config" && args.includes("core.symlinks")) {
      return { status: 0, stdout: `${symlinks}\n`, stderr: "" };
    }
    if (args[0] === "config" && args.includes("core.autocrlf")) {
      return { status: 0, stdout: `${autocrlf}\n`, stderr: "" };
    }
    if (args[0] === "ls-files") {
      return {
        status: 0,
        stdout: `${mode} deadbeef 0\t${WINDOWS_CHECKOUT_PREFLIGHT_PATHS.symlink}\n`,
        stderr: "",
      };
    }
    throw new Error(`unexpected git args: ${args.join(" ")}`);
  };
}

function validFs({
  target = path.join(repoRoot, ".devpro/agent-skills/devpro-workflows/pre-pr"),
  bytes = Buffer.from("#!/usr/bin/env node\n"),
} = {}) {
  return {
    exists: () => true,
    lstat: () => ({ isSymbolicLink: () => true }),
    realpath: () => target,
    readFile: () => bytes,
  };
}

describe("windows checkout preflight", () => {
  test("recognizes only a source checkout for runner gating", () => {
    assert.equal(
      isCanonicalSourceRepoRoot(repoRoot, { exists: () => true }),
      true,
    );
    const seen = [];
    assert.equal(
      isCanonicalSourceRepoRoot(repoRoot, {
        exists: (candidate) => {
          seen.push(candidate);
          return candidate.endsWith("sync-agent-rules.mjs");
        },
      }),
      false,
    );
    assert.equal(seen.length, 2);
  });

  test("Scenario: POSIX Runs Common Checks Without Windows Git Probes", () => {
    const result = evaluateWindowsCheckoutPreflight({
      repoRoot,
      platform: "linux",
      runGit: makeGit(),
      ...validFs(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.equal(result.checks.some((check) => check.name.startsWith("git-config:")), false);
    assert.equal(result.checks.every((check) => check.ok), true);
  });

  test("Scenario: Corrected Native-Windows Checkout Passes Preflight Before Selected Tiers", () => {
    const result = evaluateWindowsCheckoutPreflight({
      repoRoot,
      platform: "win32",
      runGit: makeGit(),
      ...validFs(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.equal(result.checks.every((check) => check.ok), true);
  });

  test("fails closed when effective Git checkout settings are wrong", () => {
    const result = evaluateWindowsCheckoutPreflight({
      repoRoot,
      platform: "win32",
      runGit: makeGit({ symlinks: "false", autocrlf: "true" }),
      ...validFs(),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.checks.filter((check) => !check.ok).map((check) => check.name),
      ["git-config:core.symlinks", "git-config:core.autocrlf"],
    );
    assert.match(result.fixCommands.join("\n"), /core\.symlinks true/);
    assert.match(result.fixCommands.join("\n"), /core\.autocrlf false/);
  });

  test("fails closed when a tracked link materializes as an ordinary file", () => {
    const result = evaluateWindowsCheckoutPreflight({
      repoRoot,
      platform: "win32",
      runGit: makeGit(),
      ...validFs(),
      lstat: () => ({ isSymbolicLink: () => false }),
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.checks.find((check) => check.name === "worktree:tracked-symlink").ok,
      false,
    );
  });

  test("fails closed on CRLF in the LF-controlled sentinel", () => {
    const result = evaluateWindowsCheckoutPreflight({
      repoRoot,
      platform: "win32",
      runGit: makeGit(),
      ...validFs({ bytes: Buffer.from("#!/usr/bin/env node\r\n") }),
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.checks.find((check) => check.name === "worktree:lf-controlled-file").ok,
      false,
    );
  });

  test("fails closed when the tracked link resolves outside the checkout", () => {
    const result = evaluateWindowsCheckoutPreflight({
      repoRoot,
      platform: "win32",
      runGit: makeGit(),
      ...validFs({ target: "/other/repo/target" }),
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.checks.find((check) => check.name === "worktree:symlink-target").ok,
      false,
    );
  });

  test("fails a POSIX common checkout check without probing Windows Git settings", () => {
    const gitCalls = [];
    const result = evaluateWindowsCheckoutPreflight({
      repoRoot,
      platform: "linux",
      runGit: (args) => {
        gitCalls.push(args);
        return makeGit()(args);
      },
      ...validFs({ target: "/outside/repo/target" }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.checks.some((check) => check.name.startsWith("git-config:")), false);
    assert.equal(gitCalls.some((args) => args[0] === "config"), false);
  });

  test("Scenario: Explicit Synthetic Root Is The Only Preflight N-A Path", () => {
    const classifyCheckoutRoot = preflightModule.classifyCheckoutRoot;
    assert.equal(typeof classifyCheckoutRoot, "function");
    const synthetic = classifyCheckoutRoot({
      repoRoot,
      runnerRepoRoot: "/fixture/source",
      explicitRoot: true,
      exists: (candidate) => candidate.endsWith(".devpro-synthetic-test-root"),
      lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
      readFile: () => Buffer.from("devpro-test-fixture-v1"),
    });
    assert.equal(synthetic, "synthetic");

    const invalidMarker = classifyCheckoutRoot({
      repoRoot,
      runnerRepoRoot: "/fixture/source",
      explicitRoot: true,
      exists: (candidate) => candidate.endsWith(".devpro-synthetic-test-root"),
      lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
      readFile: () => Buffer.from("devpro-test-fixture-v1\n"),
    });
    assert.equal(invalidMarker, "ambiguous");
  });

  test("Scenario: Source Root Missing A Required Marker Fails Closed", () => {
    const classifyCheckoutRoot = preflightModule.classifyCheckoutRoot;
    assert.equal(typeof classifyCheckoutRoot, "function");
    const classification = classifyCheckoutRoot({
      repoRoot,
      runnerRepoRoot: "/fixture/source",
      explicitRoot: true,
      exists: (candidate) => candidate.endsWith("sync-agent-rules.mjs"),
      readFile: () => Buffer.alloc(0),
    });
    assert.equal(classification, "source");
  });

  test("Scenario: Link Parent Or Target Escape Fails Closed", () => {
    const symlinkPath = path.join(repoRoot, ...WINDOWS_CHECKOUT_PREFLIGHT_PATHS.symlink.split("/"));
    const parentPath = path.dirname(symlinkPath);
    const result = evaluateWindowsCheckoutPreflight({
      repoRoot,
      platform: "linux",
      runGit: makeGit(),
      lstat: () => ({ isSymbolicLink: () => true }),
      realpath: (candidate) => {
        if (candidate === parentPath) return "/outside/repo/.agents/skills";
        if (candidate === symlinkPath) return path.join(repoRoot, "inside-target");
        throw new Error(`unexpected realpath path: ${candidate}`);
      },
      readFile: () => Buffer.from("#!/usr/bin/env node\n"),
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.checks.find((check) => check.name === "worktree:symlink-parent").ok,
      false,
    );
  });

  test("Scenario: Unset Core Autocrlf Uses Git Default On Windows", () => {
    const result = evaluateWindowsCheckoutPreflight({
      repoRoot,
      platform: "win32",
      runGit: (args) => {
        if (args.includes("core.symlinks")) return { status: 0, stdout: "true\n", stderr: "" };
        if (args.includes("core.autocrlf")) return { status: 1, stdout: "", stderr: "" };
        if (args[0] === "ls-files") {
          return {
            status: 0,
            stdout: `120000 deadbeef 0\t${WINDOWS_CHECKOUT_PREFLIGHT_PATHS.symlink}\n`,
            stderr: "",
          };
        }
        throw new Error(`unexpected git args: ${args.join(" ")}`);
      },
      ...validFs(),
    });
    assert.equal(result.ok, true);
    assert.equal(
      result.checks.find((check) => check.name === "git-config:core.autocrlf").detail,
      "unset; using Git default false",
    );
  });

  test("Scenario: Git Boolean Aliases Normalize To Required Windows Values", () => {
    const seen = [];
    const result = evaluateWindowsCheckoutPreflight({
      repoRoot,
      platform: "win32",
      runGit: (args) => {
        seen.push(args);
        if (args.includes("core.symlinks")) {
          return {
            status: 0,
            stdout: args.includes("--type=bool") ? "true\n" : "yes\n",
            stderr: "",
          };
        }
        if (args.includes("core.autocrlf")) {
          return {
            status: 0,
            stdout: args.includes("--type=bool") ? "false\n" : "no\n",
            stderr: "",
          };
        }
        if (args[0] === "ls-files") {
          return {
            status: 0,
            stdout: `120000 deadbeef 0\t${WINDOWS_CHECKOUT_PREFLIGHT_PATHS.symlink}\n`,
            stderr: "",
          };
        }
        throw new Error(`unexpected git args: ${args.join(" ")}`);
      },
      ...validFs(),
    });
    assert.equal(result.ok, true);
    assert.equal(seen.filter((args) => args.includes("--type=bool")).length, 2);

    const malformed = evaluateWindowsCheckoutPreflight({
      repoRoot,
      platform: "win32",
      runGit: (args) => {
        if (args.includes("core.symlinks")) {
          return {
            status: 128,
            stdout: "",
            stderr: "fatal: bad boolean config value 'sometimes'",
          };
        }
        if (args.includes("core.autocrlf")) {
          return { status: 0, stdout: "false\n", stderr: "" };
        }
        if (args[0] === "ls-files") {
          return {
            status: 0,
            stdout: `120000 deadbeef 0\t${WINDOWS_CHECKOUT_PREFLIGHT_PATHS.symlink}\n`,
            stderr: "",
          };
        }
        throw new Error(`unexpected git args: ${args.join(" ")}`);
      },
      ...validFs(),
    });
    assert.equal(malformed.ok, false);
    assert.deepEqual(
      malformed.checks.filter((check) => !check.ok).map((check) => check.name),
      ["git-config:core.symlinks"],
    );
  });

  test("Scenario: Unset Core Symlinks Fails Closed On Windows", () => {
    const result = evaluateWindowsCheckoutPreflight({
      repoRoot,
      platform: "win32",
      runGit: (args) => {
        if (args.includes("core.symlinks")) return { status: 1, stdout: "", stderr: "" };
        if (args.includes("core.autocrlf")) return { status: 0, stdout: "false\n", stderr: "" };
        if (args[0] === "ls-files") {
          return {
            status: 0,
            stdout: `120000 deadbeef 0\t${WINDOWS_CHECKOUT_PREFLIGHT_PATHS.symlink}\n`,
            stderr: "",
          };
        }
        throw new Error(`unexpected git args: ${args.join(" ")}`);
      },
      ...validFs(),
    });
    assert.equal(result.ok, false);
    assert.match(result.fixCommands.join("\n"), /core\.symlinks true/);
  });
});
