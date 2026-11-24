import assert from "node:assert/strict";
import { test } from "node:test";

import { launcherNote, resolveLauncherTimeoutMs } from "../hooks/lib/stop-run-supervisor.mjs";

// launcherNote() is the clause that tells a reader why a Stop-hook block exists instead of the launcher's silent pass. It is spliced
// into three messages (the supervisor's hard-time-limit section, its could-not-complete section, and the hook's own time-budget block),
// and the number in it must be the limit the launcher really enforces, which a shorten-only DEVPRO_HOOK_TIMEOUT_MS can lower. Until
// this file nothing pinned either the sentence or the number.

function withLauncherTimeout(value, body) {
  const saved = process.env.DEVPRO_HOOK_TIMEOUT_MS;
  if (value === undefined) delete process.env.DEVPRO_HOOK_TIMEOUT_MS;
  else process.env.DEVPRO_HOOK_TIMEOUT_MS = value;
  try { return body(); } finally {
    if (saved === undefined) delete process.env.DEVPRO_HOOK_TIMEOUT_MS;
    else process.env.DEVPRO_HOOK_TIMEOUT_MS = saved;
  }
}

test("launcherNote states the default 180 s launcher limit in one exact sentence", () => {
  withLauncherTimeout(undefined, () => {
    assert.equal(resolveLauncherTimeoutMs(), 180_000);
    assert.equal(launcherNote(), "hook launcher 逾時〔上限 180 秒〕會直接放行");
  });
});

test("launcherNote follows a shorter DEVPRO_HOOK_TIMEOUT_MS and formats it as milliseconds, whole seconds or tenths of a second", () => {
  for (const [value, limit] of [
    ["60000", "60 秒"],
    ["2500", "2.5 秒"],
    ["999", "999 毫秒"],
    ["0.5", "1 毫秒"],
  ]) {
    withLauncherTimeout(value, () => {
      assert.equal(launcherNote(), `hook launcher 逾時〔上限 ${limit}〕會直接放行`, `DEVPRO_HOOK_TIMEOUT_MS=${value}`);
    });
  }
});

test("launcherNote never names a limit above 180 s or one the launcher would not use", () => {
  for (const value of ["999999", "abc", "0", "-5", ""]) {
    withLauncherTimeout(value, () => {
      assert.equal(launcherNote(), "hook launcher 逾時〔上限 180 秒〕會直接放行", `DEVPRO_HOOK_TIMEOUT_MS=${JSON.stringify(value)}`);
    });
  }
});

test("launcherNote reads the environment when called, not when the module loads", () => {
  const first = withLauncherTimeout("30000", () => launcherNote());
  const second = withLauncherTimeout("45000", () => launcherNote());
  assert.equal(first, "hook launcher 逾時〔上限 30 秒〕會直接放行");
  assert.equal(second, "hook launcher 逾時〔上限 45 秒〕會直接放行");
});
