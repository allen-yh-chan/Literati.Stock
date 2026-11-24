/**
 * dp-change-core-symlinks-check.test.mjs
 *
 * Prove-it for ensureCoreSymlinks (#1956 / add-core-symlinks-clone-local-check):
 *   capable + not-true → repaired write true
 *   already-true → compliant no-op
 *   incapable → zero write
 *   write-fail → risk continue
 * Plus: raw sync MUST NOT argv-write core.symlinks true.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureCoreSymlinks, probeOsSymlinkCapability } from "../hooks/lib/git-utils.mjs";
import { repoPath } from "./lib/repo-root.mjs";

function makeRunGit({ getValue = "", getThrows = false, setThrows = false } = {}) {
  const calls = [];
  const runGit = (args) => {
    calls.push([...args]);
    if (args[0] === "config" && args[1] === "--get" && args[2] === "core.symlinks") {
      if (getThrows) {
        const err = new Error("discovery failed");
        throw err;
      }
      if (getValue === null) {
        // Simulate unset: git --get exits non-zero
        const err = new Error("unset");
        err.status = 1;
        throw err;
      }
      return String(getValue);
    }
    if (args[0] === "config" && args[1] === "core.symlinks" && args[2] === "true") {
      if (setThrows) throw new Error("write failed");
      return "";
    }
    throw new Error(`unexpected git argv: ${JSON.stringify(args)}`);
  };
  return { runGit, calls };
}

describe("ensureCoreSymlinks", () => {
  it("capable + not-true → repaired writes true (argv)", () => {
    const { runGit, calls } = makeRunGit({ getValue: null });
    const result = ensureCoreSymlinks({
      cwd: "/fake/repo",
      canCreateSymlink: () => true,
      runGit,
    });
    assert.deepEqual(result, {
      check: "core-symlinks",
      execution: "checked",
      outcome: "repaired",
      detail: "set core.symlinks true",
    });
    assert.ok(
      calls.some((args) =>
        args.length === 3 && args[0] === "config" && args[1] === "core.symlinks" && args[2] === "true"
      ),
      "must argv-write core.symlinks true"
    );
  });

  it("capable + false → repaired writes true", () => {
    const { runGit, calls } = makeRunGit({ getValue: "false" });
    const result = ensureCoreSymlinks({
      cwd: "/fake/repo",
      canCreateSymlink: () => true,
      runGit,
    });
    assert.equal(result.outcome, "repaired");
    assert.ok(calls.some((a) => a[1] === "core.symlinks" && a[2] === "true"));
  });

  it("already-true → compliant no-op (no set)", () => {
    const { runGit, calls } = makeRunGit({ getValue: "True" });
    const result = ensureCoreSymlinks({
      cwd: "/fake/repo",
      canCreateSymlink: () => true,
      runGit,
    });
    assert.deepEqual(result, {
      check: "core-symlinks",
      execution: "checked",
      outcome: "compliant",
      detail: "core.symlinks already true",
    });
    assert.equal(
      calls.filter((a) => a[0] === "config" && a[1] === "core.symlinks" && a[2] === "true").length,
      0,
      "must not rewrite when already true"
    );
  });

  it("incapable → zero write; risk (never repaired)", () => {
    const { runGit, calls } = makeRunGit({ getValue: "false" });
    const result = ensureCoreSymlinks({
      cwd: "/fake/repo",
      canCreateSymlink: () => false,
      runGit,
    });
    assert.equal(result.check, "core-symlinks");
    assert.equal(result.execution, "checked");
    assert.equal(result.outcome, "risk");
    assert.match(result.detail, /OS cannot create symlinks/i);
    assert.match(result.detail, /Developer Mode does not rewrite/i);
    assert.equal(calls.length, 0, "incapable must not invoke git config");
  });

  it("write-fail → risk continue (not repaired)", () => {
    const { runGit } = makeRunGit({ getValue: null, setThrows: true });
    const result = ensureCoreSymlinks({
      cwd: "/fake/repo",
      canCreateSymlink: () => true,
      runGit,
    });
    assert.equal(result.outcome, "risk");
    assert.match(result.detail, /write failed/i);
    assert.notEqual(result.outcome, "repaired");
  });

  it("get discovery crash → skipped/risk, no write", () => {
    const { runGit, calls } = makeRunGit({ getThrows: true });
    // Override: getThrows is for unexpected discovery failure after capability
    // Make get throw a non-status Error that we treat as discovery failure.
    // Actually makeRunGit getThrows throws Error without status — ensureCoreSymlinks
    // should distinguish unset (status 1) from discovery failure.
    // For this test we pass a runner that throws on --get without status.
    const result = ensureCoreSymlinks({
      cwd: "/fake/repo",
      canCreateSymlink: () => true,
      runGit,
    });
    assert.equal(result.execution, "skipped");
    assert.equal(result.outcome, "risk");
    assert.match(result.detail, /discovery failed/i);
    assert.equal(
      calls.filter((a) => a[1] === "core.symlinks" && a[2] === "true").length,
      0
    );
  });
});

describe("raw sync must not write class ② core.symlinks", () => {
  it("sync-agent-rules.mjs has no argv write of core.symlinks true", () => {
    const sync = readFileSync(
      repoPath(".devpro/scripts/sync-agent-rules.mjs"),
      "utf8"
    );
    assert.doesNotMatch(
      sync,
      /\[["']config["']\s*,\s*["']core\.symlinks["']\s*,\s*["']true["']\]/
    );
    assert.doesNotMatch(
      sync,
      /execFileSync\(\s*["']git["']\s*,\s*\[[^\]]*core\.symlinks[^\]]*true/
    );
    // Prefer-plain probe/WARN remain allowed.
    assert.match(sync, /probeCoreSymlinksState/);
  });
});


describe("directory symlink capability diagnostics", () => {
  it("probes a relative directory link inside the requested repository and cleans it", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "symlink-diagnostics-"));
    let observed = null;
    try {
      const result = probeOsSymlinkCapability({
        cwd,
        createSymlink(target, link, type) {
          observed = { target, link, type };
          symlinkSync(target, link, type);
          assert.equal(realpathSync(link), realpathSync(path.resolve(path.dirname(link), target)));
        },
      });
      assert.ok(observed, "probe must exercise the requested filesystem, not the system tmp filesystem");
      assert.equal(path.dirname(path.dirname(observed.link)), cwd);
      assert.equal(path.isAbsolute(observed.target), false);
      assert.equal(observed.type, "dir", "file symlink capability cannot prove directory discovery support");
      assert.equal(result.capable, true);
      assert.deepEqual(readdirSync(cwd), []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  for (const code of ["EPERM", "EACCES", "ENOSYS", "EIO"]) {
    it(`retains ${code} from directory link creation without leaking raw error text`, () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "symlink-diagnostics-"));
      try {
        const probe = probeOsSymlinkCapability({
          cwd,
          createSymlink() {
            const error = new Error("private-path-or-token-must-not-be-printed");
            error.code = code;
            throw error;
          },
        });
        assert.equal(probe.capable, false);
        assert.equal(probe.phase, "create");
        assert.equal(probe.errorCode, code);
        assert.doesNotMatch(JSON.stringify(probe), /private-path-or-token/);
        assert.deepEqual(readdirSync(cwd), []);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }

  it("reports a missing repository as preparation failure rather than OS incapability", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "symlink-diagnostics-"));
    try {
      const probe = probeOsSymlinkCapability({ cwd: path.join(cwd, "missing") });
      assert.equal(probe.capable, false);
      assert.equal(probe.phase, "prepare");
      assert.equal(probe.errorCode, "ENOENT");
      assert.deepEqual(readdirSync(cwd), []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not turn a failed structured capability result into a truthy config write", () => {
    const { runGit, calls } = makeRunGit({ getValue: "false" });
    let observedOptions;
    const result = ensureCoreSymlinks({
      cwd: "/fake/repo",
      canCreateSymlink(options) {
        observedOptions = options;
        return { capable: false, phase: "create", errorCode: "EPERM" };
      },
      runGit,
    });
    assert.equal(result.outcome, "risk");
    assert.deepEqual(calls, [], "an object containing capable=false must never authorize setting true");
    assert.equal(observedOptions.cwd, "/fake/repo");
    assert.match(result.detail, /EPERM/);
    assert.match(result.detail, /Developer Mode|symbolic link.*privilege/i);
  });

  it("keeps storage failures distinct from Windows privilege remediation", () => {
    const { runGit, calls } = makeRunGit();
    const result = ensureCoreSymlinks({
      canCreateSymlink: () => ({ capable: false, phase: "create", errorCode: "EIO" }),
      runGit,
    });
    assert.equal(result.outcome, "risk");
    assert.match(result.detail, /EIO/);
    assert.match(result.detail, /filesystem|storage/i);
    assert.doesNotMatch(result.detail, /Developer Mode/);
    assert.deepEqual(calls, []);
  });

  for (const [phase, code, advice, developerMode] of [
    ["create", "EPERM", /symbolic link privilege/i, true],
    ["create", "EACCES", /directory permissions/i, true],
    ["create", "ENOSYS", /support.*filesystem or share/i, false],
    ["create", "ENOTSUP", /support.*filesystem or share/i, false],
    ["create", "EOPNOTSUPP", /support.*filesystem or share/i, false],
    ["create", "EIO", /filesystem\/storage/i, false],
    ["verify", "EINVAL", /symlink target/i, false],
    ["prepare", "ENOENT", /repository existence.*write\/access permissions/i, false],
    ["cleanup", "EACCES", /cleanup failed.*named disposable/i, false],
  ]) {
    it(`guides ${phase}/${code} without unrelated privilege advice`, () => {
      const { runGit, calls } = makeRunGit();
      const result = ensureCoreSymlinks({
        canCreateSymlink: () => ({ capable: false, phase, errorCode: code }), runGit,
      });
      assert.equal(result.outcome, "risk");
      assert.match(result.detail, new RegExp(`${phase}: ${code}`));
      assert.match(result.detail, advice);
      if (developerMode) assert.match(result.detail, /Developer Mode does not rewrite/);
      else assert.doesNotMatch(result.detail, /Developer Mode/);
      assert.match(result.detail, /re-run devpro:change, then --sync/);
      assert.deepEqual(calls, []);
    });
  }

  it("does not write config when capability evidence is malformed", () => {
    const { runGit, calls } = makeRunGit();
    const result = ensureCoreSymlinks({ canCreateSymlink: () => ({ capable: "true" }), runGit });
    assert.equal(result.outcome, "risk");
    assert.equal(result.execution, "skipped");
    assert.deepEqual(calls, []);
  });
});


describe("directory symlink probe lifecycle", () => {
  it("refuses a creation callback that did not produce a directory symlink", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "symlink-diagnostics-"));
    try {
      const result = probeOsSymlinkCapability({ cwd, createSymlink() {} });
      assert.equal(result.capable, false);
      assert.equal(result.phase, "verify");
      assert.equal(result.errorCode, "ENOENT");
      assert.deepEqual(readdirSync(cwd), []);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("does not claim capability while cleanup leaves a probe directory behind", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "symlink-diagnostics-"));
    try {
      const result = probeOsSymlinkCapability({
        cwd,
        removeProbe() { throw Object.assign(new Error("private cleanup path"), { code: "EACCES" }); },
      });
      assert.equal(result.capable, false);
      assert.equal(result.phase, "cleanup");
      assert.equal(result.errorCode, "EACCES");
      assert.deepEqual(readdirSync(cwd), [result.probeDirectory]);
      assert.equal(path.isAbsolute(result.probeDirectory), false);
      assert.doesNotMatch(JSON.stringify(result), /private cleanup/);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("keeps the original create error when cleanup also fails", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "symlink-diagnostics-"));
    try {
      const result = probeOsSymlinkCapability({
        cwd,
        createSymlink() { throw Object.assign(new Error("create failure"), { code: "EPERM" }); },
        removeProbe() { throw Object.assign(new Error("cleanup failure"), { code: "EACCES" }); },
      });
      assert.equal(result.capable, false);
      assert.equal(result.phase, "create");
      assert.equal(result.errorCode, "EPERM");
      assert.equal(result.cleanupErrorCode, "EACCES");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
