// fix-cross-repo-state-keys: the one repository key every obligation marker uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRepoKey, repoKey, repoKeyToken } from "../hooks/lib/repo-key.mjs";

test("repoKey lowercases a github.com repository and refuses anything else", () => {
  assert.equal(repoKey("GitHub.com", "Owner/Repo.Name"), "github.com/owner/repo.name");
  assert.equal(repoKey("ghe.example.com", "owner/repo"), "", "other hosts have no key");
  assert.equal(repoKey("github.com", "owner"), "");
  assert.equal(repoKey("github.com", "owner/repo/extra"), "");
  assert.equal(repoKey("github.com", "owner/re po"), "");
  assert.equal(repoKey(undefined, undefined), "");
});

test("isRepoKey accepts only the lowercase key repoKey returns", () => {
  assert.equal(isRepoKey("github.com/owner/repo"), true);
  assert.equal(isRepoKey("github.com/Owner/repo"), false);
  assert.equal(isRepoKey("owner/repo"), false);
  assert.equal(isRepoKey(""), false);
  assert.equal(isRepoKey(null), false);
});

test("repoKeyToken is a file-name form that keeps two keys apart", () => {
  assert.equal(repoKeyToken("github.com/owner/repo"), "github.com+owner+repo");
  assert.equal(repoKeyToken("owner/repo"), "");
  assert.notEqual(repoKeyToken("github.com/a.b/c"), repoKeyToken("github.com/a/b.c"));
  assert.notEqual(repoKeyToken("github.com/a-b/c"), repoKeyToken("github.com/a/b-c"));
});

// #3704 r5 F3: a path component, a leading `-` or a `.git` suffix is no owner or repository name, so it gives no key.
test("repoKey rejects names that are path components or a clone suffix", () => {
  for (const slug of ["./target", "../x", "fixture/..", "fixture/.", "-fixture/repo", "fixture/-repo", "fixture/repo.git"]) {
    assert.equal(repoKey("github.com", slug), "", slug);
  }
  for (const key of ["github.com/./target", "github.com/fixture/..", "github.com/fixture/repo.git"]) assert.equal(isRepoKey(key), false, key);
  assert.equal(repoKey("github.com", "fixture/.github"), "github.com/fixture/.github");
  assert.equal(repoKey("github.com", "fixture/repo.gitx"), "github.com/fixture/repo.gitx");
});
