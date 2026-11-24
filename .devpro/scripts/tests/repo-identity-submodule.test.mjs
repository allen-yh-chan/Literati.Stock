/**
 * repo-identity-submodule.test.mjs
 *
 * Real-submodule regression for merge-gate review C5b of
 * fix-consumer-pre-pr-gates: a recognized consumer-owned `.devpro-agent-rules`
 * submodule carries the source origin and the maintained-corpus sentinels (it
 * IS the rules repository), so its source evidence MUST NOT be read as a
 * conflict with the parent's consumer evidence. The placement resolves to
 * `consumer`; unknown is fail-closed and must not be reached here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeTempDir } from "./lib/tmp.mjs";
import { classifyRepoIdentity } from "../lib/repo-identity.mjs";

function git(repo, args, extra = []) {
  const result = spawnSync("git", ["-C", repo, ...extra, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} exited ${result.status}\n${result.stderr}`);
  return result;
}

function initRepo(repo) {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["config", "user.name", "Fixture"]);
}

test("a consumer-owned .devpro-agent-rules submodule resolves to consumer identity", () => {
  const root = realpathSync(makeTempDir("repo-identity-submodule-"));
  const parent = path.join(root, "parent");
  // Named `devpro-agent-rules` so the submodule origin matches the source-origin
  // pattern even though this checkout is consumer-owned.
  const rules = path.join(root, "devpro-agent-rules");
  try {
    // The rules repository: source origin + maintained-corpus sentinels, plus
    // the consumer adoption artifacts the parent probe looks for.
    initRepo(rules);
    mkdirSync(path.join(rules, ".devpro/scripts"), { recursive: true });
    mkdirSync(path.join(rules, ".devpro/agent-rules"), { recursive: true });
    writeFileSync(path.join(rules, ".devpro/scripts/pre-pr-archive-gate.mjs"), "// sentinel\n");
    writeFileSync(path.join(rules, ".devpro/scripts/sync-agent-rules.mjs"), "// sentinel\n");
    writeFileSync(path.join(rules, ".devpro/agent-rules/rule-audit-playbook.md"), "# sentinel\n");
    writeFileSync(path.join(rules, "AGENTS.md"), "# rules\n");
    git(rules, ["add", "-A"]);
    git(rules, ["commit", "-q", "-m", "rules"]);
    git(rules, ["remote", "add", "origin", "https://example.invalid/devpro-agent-rules.git"]);

    initRepo(parent);
    writeFileSync(path.join(parent, "README.md"), "# consumer\n");
    git(parent, ["add", "-A"]);
    git(parent, ["commit", "-q", "-m", "parent"]);
    git(parent, ["remote", "add", "origin", "https://example.invalid/consumer.git"]);
    // Local-path submodules are refused unless the file protocol is allowed.
    git(parent, ["submodule", "add", rules, ".devpro-agent-rules"], ["-c", "protocol.file.allow=always"]);
    git(parent, ["commit", "-q", "-m", "add rules submodule"]);

    const submoduleCwd = path.join(parent, ".devpro-agent-rules");
    const submoduleIdentity = classifyRepoIdentity(submoduleCwd);
    assert.equal(submoduleIdentity.identity, "consumer", JSON.stringify(submoduleIdentity));
    assert.match(submoduleIdentity.evidence, /consumer-owned rules submodule/);

    // The parent root (direct adoption evidence) is consumer too, and the same
    // rules checkout outside any superproject is still source.
    assert.equal(classifyRepoIdentity(parent).identity, "consumer");
    assert.equal(classifyRepoIdentity(rules).identity, "source");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
