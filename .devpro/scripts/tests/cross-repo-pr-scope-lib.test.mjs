/**
 * cross-repo-pr-scope-lib.test.mjs
 *
 * Unit tests that import .devpro/scripts/hooks/lib/cross-repo-pr-scope.mjs directly (no hook subprocess) for
 * openspec change add-cross-repo-pr-scope-marker, design D3 (judge only the values the command writes) and D8
 * (no host / worktree / filesystem discovery). `crossRepoPrAuthorization` needs a real git checkout and is covered by
 * hook-pre-tool-gate-cross-repo-pr-marker.test.mjs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  crossRepoPrMarkerValues,
  ghPrWriteClauses,
  joinCommandLineContinuations,
  markerMatchesTarget,
  parseGhRepoValue,
  resolveExplicitPrTarget,
} from "../hooks/lib/cross-repo-pr-scope.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB_PATH = path.resolve(HERE, "../hooks/lib/cross-repo-pr-scope.mjs");

// Run `fn` with GH_REPO set (or removed when undefined), then restore the inherited value.
function withGhRepo(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, "GH_REPO");
  const before = process.env.GH_REPO;
  if (value === undefined) delete process.env.GH_REPO;
  else process.env.GH_REPO = value;
  try {
    return fn();
  } finally {
    if (had) process.env.GH_REPO = before;
    else delete process.env.GH_REPO;
  }
}

const resolveOne = (cmd) => {
  const clauses = ghPrWriteClauses(cmd);
  assert.equal(clauses.length, 1, `expected exactly one clause in: ${cmd}`);
  return resolveExplicitPrTarget(clauses[0]);
};

// ── parseGhRepoValue ──────────────────────────────────────────────────────────────────────────────────────────────

test("parseGhRepoValue accepts literal values", () => {
  assert.deepEqual(parseGhRepoValue("owner/repo"), { host: undefined, slug: "owner/repo" });
  assert.deepEqual(parseGhRepoValue("Host.Example/owner/repo"), { host: "host.example", slug: "owner/repo" });
  assert.deepEqual(parseGhRepoValue("host.example:8443/owner/repo"), { host: "host.example:8443", slug: "owner/repo" });
  assert.deepEqual(parseGhRepoValue('"owner/repo"'), { host: undefined, slug: "owner/repo" });
});

test("parseGhRepoValue rejects non-literal values", () => {
  for (const bad of ["owner", "https://github.com/owner/repo", "$REPO", "${REPO}", "$(echo a/b)", "`echo a/b`", "*", "owner/*", "", undefined, null]) {
    assert.equal(parseGhRepoValue(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

// ── markerMatchesTarget ───────────────────────────────────────────────────────────────────────────────────────────

test("markerMatchesTarget compares slug case-insensitively", () => {
  assert.equal(markerMatchesTarget({ slug: "Owner/Repo" }, { slug: "owner/repo" }), true);
  assert.equal(markerMatchesTarget({ slug: "owner/repo" }, { slug: "owner/other" }), false);
  assert.equal(markerMatchesTarget(null, { slug: "owner/repo" }), false);
  assert.equal(markerMatchesTarget({ slug: "owner/repo" }, null), false);
});

test("markerMatchesTarget without a marker host matches any target host", () => {
  assert.equal(markerMatchesTarget({ slug: "owner/repo" }, { slug: "owner/repo" }), true);
  assert.equal(markerMatchesTarget({ slug: "owner/repo" }, { host: "ghe.example", slug: "owner/repo" }), true);
});

test("markerMatchesTarget with a marker host needs the same written host", () => {
  const marker = { host: "ghe.example", slug: "owner/repo" };
  assert.equal(markerMatchesTarget(marker, { host: "ghe.example", slug: "owner/repo" }), true);
  assert.equal(markerMatchesTarget(marker, { host: "other.example", slug: "owner/repo" }), false);
  assert.equal(markerMatchesTarget(marker, { slug: "owner/repo" }), false);
});

// ── crossRepoPrMarkerValues ───────────────────────────────────────────────────────────────────────────────────────

test("crossRepoPrMarkerValues reads values in real command text", () => {
  assert.deepEqual(crossRepoPrMarkerValues("DEVPRO_CROSS_REPO_PR=owner/repo gh pr comment 1 --repo owner/repo"), ["owner/repo"]);
  assert.deepEqual(crossRepoPrMarkerValues('DEVPRO_CROSS_REPO_PR="owner/repo" gh pr edit 1'), ["owner/repo"]);
  assert.deepEqual(crossRepoPrMarkerValues("DEVPRO_CROSS_REPO_PR=a/b true; DEVPRO_CROSS_REPO_PR=c/d true"), ["a/b", "c/d"]);
  assert.deepEqual(crossRepoPrMarkerValues("gh pr view 1"), []);
});

test("crossRepoPrMarkerValues ignores quoted data, heredoc bodies and comments", () => {
  assert.deepEqual(crossRepoPrMarkerValues('echo "DEVPRO_CROSS_REPO_PR=owner/repo"'), []);
  assert.deepEqual(crossRepoPrMarkerValues("cat <<'EOF'\nDEVPRO_CROSS_REPO_PR=owner/repo\nEOF"), []);
  assert.deepEqual(crossRepoPrMarkerValues("true # DEVPRO_CROSS_REPO_PR=owner/repo"), []);
});

// ── ghPrWriteClauses ──────────────────────────────────────────────────────────────────────────────────────────────

test("ghPrWriteClauses finds create, edit and comment", () => {
  for (const verb of ["create", "edit", "comment"]) {
    const clauses = ghPrWriteClauses(`gh pr ${verb} 5 --repo owner/repo`);
    assert.equal(clauses.length, 1, verb);
    assert.equal(clauses[0].verb, verb);
  }
  const global = ghPrWriteClauses("gh -R x/y pr comment 1");
  assert.equal(global.length, 1);
  assert.deepEqual(global[0].repoValues, ["x/y"]);
  assert.equal(global[0].flagsBeforeVerb, true);
});

test("ghPrWriteClauses reads --repo/-R in all three positions, in command order (review r6)", () => {
  const between = ghPrWriteClauses("gh pr -R x/y comment 1 --body hi");
  assert.equal(between.length, 1);
  assert.equal(between[0].verb, "comment");
  assert.equal(between[0].selector, "1");
  assert.deepEqual(between[0].repoValues, ["x/y"]);
  assert.equal(between[0].flagsBeforeVerb, true);
  const all = ghPrWriteClauses("gh --repo=a/b pr -Rc/d --repo e/f create --repo g/h --head x");
  assert.deepEqual(all[0].repoValues, ["a/b", "c/d", "e/f", "g/h"]);
  const plain = ghPrWriteClauses("gh pr create --repo g/h --head x");
  assert.equal(plain[0].flagsBeforeVerb, false, "the plain form has no flag before the verb");
});

test("ghPrWriteClauses skips other verbs and quoted text", () => {
  assert.deepEqual(ghPrWriteClauses("gh pr view 1 --repo owner/repo"), []);
  assert.deepEqual(ghPrWriteClauses("gh pr -R owner/repo view 1"), []);
  assert.deepEqual(ghPrWriteClauses('echo "gh pr comment 1"'), []);
});

test("ghPrWriteClauses reads --repo only from real flags", () => {
  assert.deepEqual(ghPrWriteClauses('gh pr comment 1 --body "text --repo x/y more"')[0].repoValues, []);
  assert.deepEqual(ghPrWriteClauses("gh pr comment 1 --body-file - <<'EOF'\n--repo x/y\nEOF")[0].repoValues, []);
  assert.deepEqual(ghPrWriteClauses("gh pr comment 1 --repo=x/y")[0].repoValues, ["x/y"]);
  assert.deepEqual(ghPrWriteClauses("gh pr comment 1 -Rx/y")[0].repoValues, ["x/y"]);
  assert.deepEqual(ghPrWriteClauses("gh pr comment 1 -R x/y")[0].repoValues, ["x/y"]);
  assert.deepEqual(ghPrWriteClauses("gh pr comment 1 --repo x/y")[0].repoValues, ["x/y"]);
});

// ── resolveExplicitPrTarget ───────────────────────────────────────────────────────────────────────────────────────

test("resolveExplicitPrTarget takes a PR URL selector as the target", () => {
  withGhRepo(undefined, () => {
    const resolved = resolveOne("gh pr comment https://github.com/owner/repo/pull/7 --body x");
    assert.equal(resolved.error, undefined);
    assert.equal(resolved.source, "url");
    assert.deepEqual(resolved.target, { host: "github.com", slug: "owner/repo" });
  });
});

test("resolveExplicitPrTarget merges a URL and a --repo of the same slug", () => {
  withGhRepo(undefined, () => {
    const resolved = resolveOne("gh pr edit https://github.com/Owner/Repo/pull/7 --repo owner/repo");
    assert.equal(resolved.error, undefined);
    assert.equal(resolved.source, "mixed");
    assert.equal(resolved.target.slug.toLowerCase(), "owner/repo");
  });
});

test("resolveExplicitPrTarget reports ambiguous slugs and hosts", () => {
  withGhRepo(undefined, () => {
    const slugs = resolveOne("gh pr edit https://github.com/owner/a/pull/7 --repo owner/b");
    assert.equal(slugs.target, null);
    assert.equal(slugs.error.kind, "ambiguous");
    const twoFlags = resolveOne("gh pr comment 1 --repo owner/a --repo owner/b");
    assert.equal(twoFlags.error.kind, "ambiguous");
    const hosts = resolveOne("gh pr comment 1 --repo one.example/owner/repo --repo two.example/owner/repo");
    assert.equal(hosts.target, null);
    assert.equal(hosts.error.kind, "ambiguous");
  });
});

test("resolveExplicitPrTarget reports a shell-expanded value as literal error", () => {
  withGhRepo(undefined, () => {
    const resolved = resolveOne("gh pr comment 1 --repo $REPO");
    assert.equal(resolved.target, null);
    assert.equal(resolved.error.kind, "literal");
  });
});

test("resolveExplicitPrTarget reads inherited GH_REPO only when the command writes no target", () => {
  withGhRepo("env/owned", () => {
    const inherited = resolveOne("gh pr comment 1 --body x");
    assert.equal(inherited.source, "inherited-env");
    assert.deepEqual(inherited.target, { host: undefined, slug: "env/owned" });

    const written = resolveOne("gh pr comment 1 --repo cmd/owned");
    assert.equal(written.source, "flag");
    assert.equal(written.error, undefined);
    assert.deepEqual(written.target, { host: undefined, slug: "cmd/owned" });
  });
});

test("resolveExplicitPrTarget returns no target when the command writes none", () => {
  withGhRepo(undefined, () => {
    assert.deepEqual(resolveOne("gh pr comment 1 --body x"), { target: null, source: "none" });
  });
});

// ── D8: no host / worktree / filesystem discovery ─────────────────────────────────────────────────────────────────

test("lib source does not discover host, worktrees or directories", () => {
  const source = readFileSync(LIB_PATH, "utf8");
  for (const forbidden of ["GH_HOST", "hosts.yml", "worktree list", "branch --show-current", "readdir"]) {
    assert.equal(source.includes(forbidden), false, `lib must not contain ${forbidden}`);
  }
});

test("joinCommandLineContinuations joins real-command continuations and keeps every offset", () => {
  for (const sep of ["\\\n", "\\\r\n"]) {
    const raw = `DEVPRO_PR_CHECKOUT=/abs/wt ${sep}gh pr create --repo b/other --head x`;
    const joined = joinCommandLineContinuations(raw);
    assert.equal(joined.length, raw.length, "same length, so offsets stay the raw command's");
    assert.equal(joined.indexOf("gh pr create"), raw.indexOf("gh pr create"));
    assert.doesNotMatch(joined, /[\\\r\n]/, "the continuation is gone");
    assert.equal(ghPrWriteClauses(joined).length, 1);
  }
  assert.equal(joinCommandLineContinuations("gh pr comment 7 --body hi"), "gh pr comment 7 --body hi", "no continuation, no change");
  // An even run of backslashes before the newline is an escaped backslash, not a continuation.
  assert.equal(joinCommandLineContinuations("echo a\\\\\ngh pr comment 7"), "echo a\\\\\ngh pr comment 7");
});

test("joinCommandLineContinuations leaves quoted data, comments and heredoc bodies untouched", () => {
  const heredoc = "cat <<'EOF' > /dev/null\nfoo \\\nEOF\ngh pr comment 7 --repo b/other --body hi";
  assert.equal(joinCommandLineContinuations(heredoc), heredoc, "a quoted heredoc keeps its backslash, so EOF still ends it");
  const quoted = "echo 'a \\\nb' && gh pr comment 7 --body hi";
  assert.equal(joinCommandLineContinuations(quoted), quoted);
  const commented = "gh pr comment 7 --body hi # note \\\necho done";
  assert.equal(joinCommandLineContinuations(commented), commented);
});
