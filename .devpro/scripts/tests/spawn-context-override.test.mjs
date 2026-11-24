import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ISSUER_LOCK_STALE_MS,
  SPAWN_CONTEXT_OVERRIDE_TTL_MS,
  consumeSpawnContextOverride,
  cwdKeyForSpawnContextOverride,
  issueSpawnContextOverride,
} from "../hooks/lib/spawn-context-override.mjs";
import { parseSpawnContextOverrideArgs, runSpawnContextOverrideCli } from "../spawn-context-override.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "spawn-context-override-"));
  const cwd = path.join(root, "worktree");
  const stateDir = path.join(root, "state");
  mkdirSync(cwd);
  return { root, cwd, stateDir };
}

function activeRecordPath(cwd, stateDir) {
  return path.join(stateDir, `active-${cwdKeyForSpawnContextOverride(cwd)}`, "override.json");
}

function consumeInChild({ cwd, stateDir, nowMs }) {
  const moduleUrl = new URL("../hooks/lib/spawn-context-override.mjs", import.meta.url).href;
  const script = `import { consumeSpawnContextOverride } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(consumeSpawnContextOverride({ cwd: process.env.SPAWN_TEST_CWD, stateDir: process.env.SPAWN_TEST_STATE, nowMs: Number(process.env.SPAWN_TEST_NOW) })));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, SPAWN_TEST_CWD: cwd, SPAWN_TEST_STATE: stateDir, SPAWN_TEST_NOW: String(nowMs) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
}

test("issue then consume archives exactly once and never exposes raw cwd", () => {
  const { cwd, stateDir } = fixture();
  const now = 1_800_000_000_000;
  const issued = issueSpawnContextOverride({ cwd, stateDir, reason: "legacy parser needs all prior decisions", nowMs: now });
  assert.equal(issued.ok, true);
  assert.equal(issued.expires_at, new Date(now + SPAWN_CONTEXT_OVERRIDE_TTL_MS).toISOString());
  assert.doesNotMatch(JSON.stringify(issued), new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const first = consumeSpawnContextOverride({ cwd, stateDir, nowMs: now + 1 });
  const second = consumeSpawnContextOverride({ cwd, stateDir, nowMs: now + 2 });
  assert.deepEqual({ ok: first.ok, status: first.status }, { ok: true, status: "consumed" });
  assert.deepEqual({ ok: second.ok, status: second.status }, { ok: false, status: "missing" });
  const auditNames = readdirSync(path.join(stateDir, "audit"));
  assert.equal(auditNames.filter((name) => name.endsWith(".consumed")).length, 1);
  const record = JSON.parse(readFileSync(path.join(stateDir, "audit", auditNames[0], "override.json"), "utf8"));
  assert.equal(record.reason, "legacy parser needs all prior decisions");
  assert.equal(record.cwd_key, cwdKeyForSpawnContextOverride(cwd));
  assert.equal(record.created_at, new Date(now).toISOString());
  assert.equal(record.expires_at, new Date(now + SPAWN_CONTEXT_OVERRIDE_TTL_MS).toISOString());
  assert.equal("created_at_ms" in record, false);
  assert.equal("expires_at_ms" in record, false);
});

test("reason is single-line, non-empty, and bounded", () => {
  const { cwd, stateDir } = fixture();
  for (const reason of ["", "   ", "line one\nline two", "x".repeat(501)]) {
    const result = issueSpawnContextOverride({ cwd, stateDir, reason, nowMs: 1_800_000_000_000 });
    assert.equal(result.ok, false, `expected invalid reason: ${JSON.stringify(reason.slice(0, 20))}`);
    assert.equal(result.status, "invalid_reason");
  }
});

test("CLI accepts one reason argument and prints only bounded authority metadata", () => {
  assert.deepEqual(parseSpawnContextOverrideArgs(["--reason", "needed"]), { ok: true, reason: "needed" });
  for (const argv of [[], ["--reason"], ["--reason", "a", "--force"], ["--unknown", "x"]]) {
    assert.equal(parseSpawnContextOverrideArgs(argv).ok, false);
  }

  const { cwd, stateDir } = fixture();
  const result = runSpawnContextOverrideCli({
    argv: ["--reason", "bounded legacy comparison"],
    cwd,
    stateDir,
    nowMs: 1_800_000_000_000,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.message, /cwd_key=[0-9a-f]{12}/);
  assert.match(result.message, /expires_at=2027-01-15T08:10:00\.000Z/);
  assert.doesNotMatch(result.message, /bounded legacy comparison/);
  assert.doesNotMatch(result.message, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("unexpired active refuses overwrite, expired active is rejected then reissued", () => {
  const { cwd, stateDir } = fixture();
  const now = 1_800_000_000_000;
  assert.equal(issueSpawnContextOverride({ cwd, stateDir, reason: "first", nowMs: now }).ok, true);
  assert.equal(issueSpawnContextOverride({ cwd, stateDir, reason: "second", nowMs: now + 1 }).status, "active_exists");

  const reissued = issueSpawnContextOverride({
    cwd,
    stateDir,
    reason: "replacement after expiry",
    nowMs: now + SPAWN_CONTEXT_OVERRIDE_TTL_MS + 1,
  });
  assert.equal(reissued.ok, true);
  const auditNames = readdirSync(path.join(stateDir, "audit"));
  assert.equal(auditNames.some((name) => name.endsWith(".rejected")), true);
  assert.equal(consumeSpawnContextOverride({ cwd, stateDir, nowMs: now + SPAWN_CONTEXT_OVERRIDE_TTL_MS + 2 }).ok, true);
});

test("expired, malformed, and cwd-mismatched active records are rejected on consume", () => {
  for (const scenario of ["expired", "malformed", "cwd_mismatch"]) {
    const { cwd, stateDir } = fixture();
    const now = 1_800_000_000_000;
    assert.equal(issueSpawnContextOverride({ cwd, stateDir, reason: scenario, nowMs: now }).ok, true);
    if (scenario === "malformed") {
      writeFileSync(activeRecordPath(cwd, stateDir), "not-json\n");
    } else if (scenario === "cwd_mismatch") {
      const file = activeRecordPath(cwd, stateDir);
      const record = JSON.parse(readFileSync(file, "utf8"));
      record.cwd_key = "0".repeat(64);
      writeFileSync(file, `${JSON.stringify(record)}\n`);
    }
    const consumed = consumeSpawnContextOverride({
      cwd,
      stateDir,
      nowMs: scenario === "expired" ? now + SPAWN_CONTEXT_OVERRIDE_TTL_MS + 1 : now + 1,
    });
    assert.deepEqual(consumed, { ok: false, status: scenario });
    assert.equal(readdirSync(path.join(stateDir, "audit")).some((name) => name.endsWith(".rejected")), true);
  }
});

test("failed rejected-archive transition blocks later issuers instead of bypassing recovery", () => {
  const { cwd, stateDir } = fixture();
  const now = 1_800_000_000_000;
  assert.equal(issueSpawnContextOverride({ cwd, stateDir, reason: "first", nowMs: now }).ok, true);
  const record = JSON.parse(readFileSync(activeRecordPath(cwd, stateDir), "utf8"));
  const collision = path.join(stateDir, "audit", `${record.nonce}.rejected`);
  mkdirSync(collision, { recursive: true });
  writeFileSync(path.join(collision, "occupied"), "force rename failure");

  const failed = issueSpawnContextOverride({
    cwd,
    stateDir,
    reason: "replacement",
    nowMs: now + SPAWN_CONTEXT_OVERRIDE_TTL_MS + 1,
  });
  assert.equal(failed.status, "recovery_failed");
  const retry = issueSpawnContextOverride({
    cwd,
    stateDir,
    reason: "must remain blocked",
    nowMs: now + SPAWN_CONTEXT_OVERRIDE_TTL_MS + 2,
  });
  assert.deepEqual(retry, { ok: false, status: "recovery_pending" });
});

test("cwd identity mismatch cannot consume another worktree override", () => {
  const { root, cwd, stateDir } = fixture();
  const other = path.join(root, "other-worktree");
  mkdirSync(other);
  assert.equal(issueSpawnContextOverride({ cwd, stateDir, reason: "cwd bounded", nowMs: 1000 }).ok, true);
  assert.deepEqual(consumeSpawnContextOverride({ cwd: other, stateDir, nowMs: 1001 }), {
    ok: false,
    status: "missing",
  });
  assert.equal(consumeSpawnContextOverride({ cwd, stateDir, nowMs: 1002 }).ok, true);
});

test("concurrent consumers have exactly one durable winner", async () => {
  const { cwd, stateDir } = fixture();
  assert.equal(issueSpawnContextOverride({ cwd, stateDir, reason: "single consumer race", nowMs: 1000 }).ok, true);
  const results = await Promise.all([
    consumeInChild({ cwd, stateDir, nowMs: 1001 }),
    consumeInChild({ cwd, stateDir, nowMs: 1001 }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
  assert.equal(results.filter((result) => result.status === "missing").length, 1);
  const auditNames = readdirSync(path.join(stateDir, "audit"));
  assert.equal(auditNames.filter((name) => name.endsWith(".consumed")).length, 1);
});

test("nested cwd resolves to the same canonical worktree identity", () => {
  const { cwd, stateDir } = fixture();
  execFileSync("git", ["init", "--quiet", cwd]);
  const nested = path.join(cwd, "src", "nested");
  mkdirSync(nested, { recursive: true });

  assert.equal(issueSpawnContextOverride({ cwd, stateDir, reason: "worktree-scoped override", nowMs: 1000 }).ok, true);
  assert.equal(cwdKeyForSpawnContextOverride(nested), cwdKeyForSpawnContextOverride(cwd));
  assert.equal(consumeSpawnContextOverride({ cwd: nested, stateDir, nowMs: 1001 }).ok, true);
});

test("live issuer lock is not stolen; stale dead lock is reaped", () => {
  const { cwd, stateDir } = fixture();
  mkdirSync(stateDir, { recursive: true });
  const key = cwdKeyForSpawnContextOverride(cwd);
  const live = path.join(stateDir, `issuer-${key}.lock.live`);
  writeFileSync(live, JSON.stringify({ owner_pid: process.pid }));
  const blocked = issueSpawnContextOverride({ cwd, stateDir, reason: "blocked by live writer", nowMs: Date.now() });
  assert.equal(blocked.status, "issuer_busy");

  writeFileSync(live, JSON.stringify({ owner_pid: 99999999 }));
  const old = new Date(Date.now() - ISSUER_LOCK_STALE_MS - 1000);
  utimesSync(live, old, old);
  const issued = issueSpawnContextOverride({ cwd, stateDir, reason: "dead holder recovered", nowMs: Date.now() });
  assert.equal(issued.ok, true);
  assert.equal(readdirSync(stateDir).some((name) => name.endsWith(".lock.live")), false);
});

test("archive durability failure never allows full context", () => {
  const { cwd, stateDir } = fixture();
  assert.equal(issueSpawnContextOverride({ cwd, stateDir, reason: "fault injection", nowMs: 1000 }).ok, true);
  const consumed = consumeSpawnContextOverride({
    cwd,
    stateDir,
    nowMs: 1001,
    fsyncDirectoryFn() { throw new Error("synthetic fsync failure"); },
  });
  assert.equal(consumed.ok, false);
  assert.equal(consumed.status, "archive_failed");
});

test("issuer filesystem fault fails closed without publishing authority", () => {
  const { root, cwd } = fixture();
  const stateDir = path.join(root, "not-a-directory");
  writeFileSync(stateDir, "occupied");
  assert.deepEqual(issueSpawnContextOverride({ cwd, stateDir, reason: "must fail closed", nowMs: 1000 }), {
    ok: false,
    status: "write_failed",
  });
});
