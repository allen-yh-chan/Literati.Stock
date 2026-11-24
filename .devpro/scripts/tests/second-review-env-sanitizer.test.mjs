import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  isIdentifiableCmuxExecutable,
  isIdentifiableCmuxPathEntry,
  nodeOptionsCarriesCmuxIdentity,
  sanitizeCmuxDispatchEnv,
} from "../lib/second-review-env-sanitizer.mjs";

const posix = { platform: "darwin" };
const win32 = { platform: "win32" };

function posixEnv(pathValue, nodeOptions) {
  const env = { PATH: pathValue };
  if (nodeOptions !== undefined) env.NODE_OPTIONS = nodeOptions;
  return env;
}

test("A1 posix PATH strips nested cmux-cli-shims entries", () => {
  const env = posixEnv("/tmp/cmux-cli-shims/u1:/usr/bin:/bin");
  const first = sanitizeCmuxDispatchEnv(env, posix);
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.deepEqual(first, {
    changed: true,
    removed_path_entry_count: 1,
    node_options_cleared: false,
  });

  const nested = posixEnv("/usr/bin:/private/var/folders/x/cmux-cli-shims/u2:/bin");
  const second = sanitizeCmuxDispatchEnv(nested, posix);
  assert.equal(nested.PATH, "/usr/bin:/bin");
  assert.equal(second.removed_path_entry_count, 1);
  assert.equal(isIdentifiableCmuxPathEntry("/tmp/cmux-cli-shims/u1"), true);
  assert.equal(isIdentifiableCmuxPathEntry("/private/var/folders/x/cmux-cli-shims/u2"), true);
});

test("A2 cmux.app resource-chain dirs are stripped; bare and unrelated names stay", () => {
  const env = posixEnv([
    "/Applications/cmux.app/Contents/Resources",
    "/Applications/cmux.app/Contents/Resources/app",
    "/Applications/cmux.app/Contents/Resources/bin",
    "/Applications/cmux.app/Contents/Resources/app/bin",
    "/x/cmux.app",
    "/x/cmux.app/Other",
    "/opt/my-cmux.app-notes/bin",
    "/usr/bin",
  ].join(":"));
  const result = sanitizeCmuxDispatchEnv(env, posix);
  assert.equal(env.PATH, "/x/cmux.app:/x/cmux.app/Other:/opt/my-cmux.app-notes/bin:/usr/bin");
  assert.equal(result.removed_path_entry_count, 4);
  assert.equal(isIdentifiableCmuxPathEntry("/x/cmux.app"), false);
  assert.equal(isIdentifiableCmuxPathEntry("/x/cmux.app/Other"), false);
  assert.equal(isIdentifiableCmuxPathEntry("/opt/my-cmux.app-notes/bin"), false);

  const upper = posixEnv("/APPLICATIONS/CMUX.APP/CONTENTS/RESOURCES/BIN:/usr/bin");
  assert.equal(sanitizeCmuxDispatchEnv(upper, posix).removed_path_entry_count, 1);
  assert.equal(upper.PATH, "/usr/bin");
});

test("A3 win32 PATH uses semicolon delimiter and keeps non-cmux entries", () => {
  const env = { PATH: String.raw`C:\Temp\cmux-cli-shims\u;C:\Windows\System32` };
  const result = sanitizeCmuxDispatchEnv(env, win32);
  assert.equal(env.PATH, String.raw`C:\Windows\System32`);
  assert.deepEqual(result, {
    changed: true,
    removed_path_entry_count: 1,
    node_options_cleared: false,
  });
});

test("A4 mixed PATH keeps empty entries byte-for-byte in original order", () => {
  const original = "keep-a::/tmp/cmux-cli-shims/u:/usr/local/bin:";
  const env = posixEnv(original);
  const result = sanitizeCmuxDispatchEnv(env, posix);
  assert.equal(env.PATH, "keep-a::/usr/local/bin:");
  assert.equal(result.removed_path_entry_count, 1);
  const leading = posixEnv(":/usr/bin:/tmp/cmux-cli-shims/u");
  sanitizeCmuxDispatchEnv(leading, posix);
  assert.equal(leading.PATH, ":/usr/bin");
});

test("A5 unmatched PATH is a byte-preserving no-op and is idempotent", () => {
  const pathValue = "/usr/bin:/bin";
  const nodeOptions = "--max-old-space-size=4096";
  const env = posixEnv(pathValue, nodeOptions);
  const first = sanitizeCmuxDispatchEnv(env, posix);
  assert.deepEqual(first, {
    changed: false,
    removed_path_entry_count: 0,
    node_options_cleared: false,
  });
  assert.ok(Object.is(env.PATH, pathValue));
  assert.ok(Object.is(env.NODE_OPTIONS, nodeOptions));
  assert.deepEqual(sanitizeCmuxDispatchEnv(env, posix), first);
  assert.equal(isIdentifiableCmuxPathEntry("/opt/bin"), false);
});

test("A6 NODE_OPTIONS clears only on identifiable cmux evidence", () => {
  assert.equal(nodeOptionsCarriesCmuxIdentity(undefined), false);
  assert.equal(nodeOptionsCarriesCmuxIdentity(null), false);

  const withPath = posixEnv("/tmp/cmux-cli-shims/u1:/usr/bin", "--max-old-space-size=4096");
  const clearedByPath = sanitizeCmuxDispatchEnv(withPath, posix);
  assert.equal(clearedByPath.node_options_cleared, true);
  assert.equal(Object.hasOwn(withPath, "NODE_OPTIONS"), false);

  const cleanPath = posixEnv("/usr/bin:/bin", "--require /tmp/cmux-cli-shims/u/hook.cjs");
  const clearedByNodeOptions = sanitizeCmuxDispatchEnv(cleanPath, posix);
  assert.equal(cleanPath.PATH, "/usr/bin:/bin");
  assert.equal(clearedByNodeOptions.removed_path_entry_count, 0);
  assert.equal(clearedByNodeOptions.node_options_cleared, true);
  assert.equal(Object.hasOwn(cleanPath, "NODE_OPTIONS"), false);

  const unrelated = posixEnv("/usr/bin:/bin", "--max-old-space-size=4096");
  sanitizeCmuxDispatchEnv(unrelated, posix);
  assert.equal(unrelated.NODE_OPTIONS, "--max-old-space-size=4096");

  const prefixSuffix = [
    "--require /opt/notcmux.app/Contents/Resources/hook.cjs",
    "--require /opt/prefix-cmux.app/Contents/Resources/hook.cjs",
    "--require /tmp/cmux.app.backup/Contents/Resources/hook.cjs",
  ];
  for (const value of prefixSuffix) {
    assert.equal(nodeOptionsCarriesCmuxIdentity(value), false, value);
    const env = posixEnv("/usr/bin:/bin", value);
    const result = sanitizeCmuxDispatchEnv(env, posix);
    assert.equal(result.node_options_cleared, false, value);
    assert.equal(env.NODE_OPTIONS, value);
  }
  assert.equal(
    nodeOptionsCarriesCmuxIdentity("--require /Applications/cmux.app/Contents/Resources/hook.cjs"),
    true,
  );

  const unset = posixEnv("/tmp/cmux-cli-shims/u1:/usr/bin");
  const unsetResult = sanitizeCmuxDispatchEnv(unset, posix);
  assert.equal(Object.hasOwn(unset, "NODE_OPTIONS"), false);
  assert.equal(unsetResult.node_options_cleared, false);

  const afterClear = sanitizeCmuxDispatchEnv(cleanPath, posix);
  assert.deepEqual(afterClear, {
    changed: false,
    removed_path_entry_count: 0,
    node_options_cleared: false,
  });
});

test("A7 missing PATH is a whole-env no-op; fully stripped PATH becomes empty", () => {
  const missing = { NODE_OPTIONS: "--require /tmp/cmux-cli-shims/u/hook.cjs" };
  const missingResult = sanitizeCmuxDispatchEnv(missing, posix);
  assert.deepEqual(missingResult, {
    changed: false,
    removed_path_entry_count: 0,
    node_options_cleared: false,
  });
  assert.equal(missing.NODE_OPTIONS, "--require /tmp/cmux-cli-shims/u/hook.cjs");
  assert.equal(Object.hasOwn(missing, "PATH"), false);

  const onlyCmux = posixEnv("/tmp/cmux-cli-shims/u1");
  const emptied = sanitizeCmuxDispatchEnv(onlyCmux, posix);
  assert.equal(onlyCmux.PATH, "");
  assert.equal(emptied.changed, true);
  assert.equal(emptied.removed_path_entry_count, 1);
});

test("A8 stripped dir shapes are file-identifiable; retained shapes are not", () => {
  const stripped = [
    "/tmp/cmux-cli-shims/u1",
    "/private/var/folders/x/cmux-cli-shims/u2",
    "/Applications/cmux.app/Contents/Resources",
    "/Applications/cmux.app/Contents/Resources/app",
    "/Applications/cmux.app/Contents/Resources/bin",
    "/Applications/cmux.app/Contents/Resources/app/bin",
    "/APPLICATIONS/CMUX.APP/CONTENTS/RESOURCES/BIN",
    String.raw`C:\Temp\cmux-cli-shims\u`,
  ];
  const retained = [
    "/x/cmux.app",
    "/x/cmux.app/Other",
    "/opt/my-cmux.app-notes/bin",
    "/usr/bin",
  ];
  for (const entry of stripped) {
    const toolPath = `${normalizedJoin(entry)}/claude`;
    assert.equal(isIdentifiableCmuxPathEntry(entry), true, entry);
    assert.equal(isIdentifiableCmuxExecutable(toolPath, toolPath), true, toolPath);
  }
  for (const entry of retained) {
    const toolPath = `${normalizedJoin(entry)}/claude`;
    assert.equal(isIdentifiableCmuxPathEntry(entry), false, entry);
    assert.equal(isIdentifiableCmuxExecutable(toolPath, toolPath), false, toolPath);
  }
});

test("A9 child process inherits the sanitized PATH and cleared NODE_OPTIONS", () => {
  const env = {
    ...process.env,
    PATH: "/tmp/cmux-cli-shims/u1:/usr/bin:/bin",
    NODE_OPTIONS: "--require /tmp/cmux-cli-shims/u1/hook.cjs",
  };
  const result = sanitizeCmuxDispatchEnv(env, posix);
  assert.equal(result.changed, true);
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      "process.stdout.write(JSON.stringify({ PATH: process.env.PATH, hasNodeOptions: Object.hasOwn(process.env, 'NODE_OPTIONS') }))",
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.PATH, "/usr/bin:/bin");
  assert.equal(observed.hasNodeOptions, false);
});

test("A10 moved isIdentifiableCmuxExecutable keeps the three file shapes", () => {
  assert.equal(
    isIdentifiableCmuxExecutable("/tmp/cmux-cli-shims/session/claude", "/tmp/cmux-cli-shims/session/claude"),
    true,
  );
  assert.equal(
    isIdentifiableCmuxExecutable("/usr/local/bin/cmux-claude-wrapper", "/usr/local/bin/cmux-claude-wrapper"),
    true,
  );
  assert.equal(
    isIdentifiableCmuxExecutable("/usr/local/bin/cmux-codex-wrapper.sh", "/opt/bin/cmux-codex-wrapper"),
    true,
  );
  assert.equal(
    isIdentifiableCmuxExecutable(
      "/Apps/cmux.app/Contents/Resources/bin/claude",
      "/Apps/cmux.app/Contents/Resources/app/codex",
    ),
    true,
  );
  assert.equal(
    isIdentifiableCmuxExecutable("/clean/bin/claude", "/opt/cmux-claude-wrapper"),
    true,
  );
  assert.equal(isIdentifiableCmuxExecutable("/usr/bin/claude", "/usr/bin/claude"), false);
  assert.equal(
    isIdentifiableCmuxExecutable("/x/cmux.app/Other/claude", "/x/cmux.app/Other/claude"),
    false,
  );
  assert.equal(
    isIdentifiableCmuxExecutable("/opt/my-cmux.app-notes/bin/claude", "/opt/my-cmux.app-notes/bin/claude"),
    false,
  );
});

function normalizedJoin(entry) {
  return String(entry).replaceAll("\\", "/").replace(/\/+$/, "");
}
