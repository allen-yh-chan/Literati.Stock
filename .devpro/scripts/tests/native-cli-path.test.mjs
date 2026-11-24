import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isAbsoluteCliPath, resolveCliPath } from "../lib/native-cli-path.mjs";
import { repoPath } from "./lib/repo-root.mjs";

// A path typed in Git Bash reaches Node as `/c/work/repo`; on Windows `path.resolve` would read that as the
// current drive's `\c\work\repo`. The two CLI entry points must map the drive spelling first.

test("on Windows every spelling of the same checkout resolves to the same native path", () => {
  for (const input of ["/c/work/repo", "C:/work/repo", "C:\\work\\repo", "c:\\work\\repo", "/C/work/repo"]) {
    assert.equal(resolveCliPath(input, { platform: "win32" }), "C:\\work\\repo", input);
  }
  assert.equal(resolveCliPath("/c", { platform: "win32" }), "C:\\");
  assert.equal(resolveCliPath("/c/", { platform: "win32" }), "C:\\");
});

test("off Windows a /<letter>/ path is an ordinary absolute path and is left alone", () => {
  for (const platform of ["linux", "darwin"]) {
    assert.equal(resolveCliPath("/c/work/repo", { platform }), "/c/work/repo", platform);
    assert.equal(resolveCliPath("/usr/lib/x", { platform }), "/usr/lib/x", platform);
  }
});

test("a path that is not a drive spelling resolves as before", () => {
  assert.equal(resolveCliPath("/work/repo", { platform: "linux" }), "/work/repo");
  if (process.platform !== "win32") assert.match(resolveCliPath("relative/dir", { platform: "linux" }), /relative\/dir$/u); // needs a POSIX cwd
  assert.equal(resolveCliPath("\\\\server\\share\\x", { platform: "win32" }), "\\\\server\\share\\x");
});

test("absoluteness is judged after the drive spelling is mapped; relative paths stay relative", () => {
  for (const input of ["/c/work/repo", "C:/work/repo", "C:\\work\\repo"]) assert.equal(isAbsoluteCliPath(input, { platform: "win32" }), true, input);
  for (const input of ["work/repo", ".\\repo", "..", "repo"]) assert.equal(isAbsoluteCliPath(input, { platform: "win32" }), false, input);
  assert.equal(isAbsoluteCliPath("/c/work/repo", { platform: "linux" }), true);
  assert.equal(isAbsoluteCliPath("work/repo", { platform: "linux" }), false);
});

test("both CLI entry points resolve every path flag through it, never through bare path.resolve", () => {
  for (const file of [".devpro/scripts/run-opencode-primary-review.mjs", ".devpro/scripts/run-remote-review.mjs"]) {
    const source = readFileSync(repoPath(file), "utf8");
    assert.match(source, /resolveCliPath/u, file);
    assert.ok(!/path\.resolve\(/u.test(source), `${file} must not resolve a user-typed path with bare path.resolve`);
  }
});
