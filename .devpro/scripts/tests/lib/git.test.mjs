/**
 * git.test.mjs
 *
 * Integration tests for tests/lib/git.mjs helpers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { git, initRepo, tryGit } from "./git.mjs";
import { makeTempDir } from "./tmp.mjs";
import { rmSync } from "node:fs";

test("initRepo initializes a repo and git() returns trimmed stdout", () => {
  const dir = makeTempDir("devpro-git-test-");
  try {
    initRepo(dir, {
      branch: "main",
      commit: true,
      userName: "t",
      userEmail: "t@t.com",
    });
    assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.equal(git(dir, "log", "-1", "--pretty=%s"), "init");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tryGit never throws on a failing git command", () => {
  const dir = makeTempDir("devpro-trygit-test-");
  try {
    initRepo(dir);
    const result = tryGit(dir, "rev-parse", "definitely-not-a-ref");
    assert.notEqual(result.status, 0);
    assert.equal(typeof result.stdout, "string");
    assert.equal(typeof result.stderr, "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git() throws when the command fails", () => {
  const dir = makeTempDir("devpro-git-throw-");
  try {
    initRepo(dir);
    assert.throws(() => git(dir, "rev-parse", "definitely-not-a-ref"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
