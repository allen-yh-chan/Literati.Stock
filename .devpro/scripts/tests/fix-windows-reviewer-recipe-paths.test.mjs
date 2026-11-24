// #3187: on a Windows host the Claude reviewer's Bash tool is Git Bash. An
// unquoted backslash path in a recipe is eaten as an escape there, and a quoted
// one no longer matches its `Bash(node <path>:*)` allowedTools prefix. Recipes
// and allowedTools prefixes must therefore be one backslash-free string.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { claudeAllowedTools } from "../second-reviewer-cli-recipe-contract.mjs";
import {
  gatedStickyWriteExactRecipe,
  stickyWriteReadbackRecipe,
} from "../validate-second-review-packet.mjs";
import { claudeLinkedIssueReadPrefix } from "../lib/reviewer-recipe-shell-path.mjs";

const winRoot = "C:\\Users\\x\\repo";
const win = { repoRoot: winRoot, pathApi: path.win32 };
const slug = "devpro/example";
const dispatchId = "dispatch-3187";
const explicitSidecar = `${winRoot}\\notes\\tmp\\sticky-credential-gate-${dispatchId}.json`;

function recipeCommand(line, label) {
  const prefix = `${label}: `;
  assert.ok(line.startsWith(prefix), `${label} line shape: ${line}`);
  return line.slice(prefix.length);
}

function winRecipes() {
  return {
    "write (explicit sidecar)": recipeCommand(
      gatedStickyWriteExactRecipe(explicitSidecar, dispatchId, win),
      "sticky_write_exact_recipe",
    ),
    "write (derived sidecar)": recipeCommand(
      gatedStickyWriteExactRecipe(undefined, dispatchId, win),
      "sticky_write_exact_recipe",
    ),
    "read-back": recipeCommand(
      stickyWriteReadbackRecipe(slug, 4242, win),
      "sticky_write_readback_recipe",
    ),
    "linked-issue read": `${claudeLinkedIssueReadPrefix(winRoot, slug, path.win32)} 17`,
  };
}

function winNodeRulePrefixes() {
  return claudeAllowedTools("issue_read_required", slug, win)
    .split(",")
    .filter((rule) => rule.startsWith("Bash(node "))
    .map((rule) => {
      assert.ok(rule.endsWith(":*)"), `prefix rule shape: ${rule}`);
      return rule.slice("Bash(".length, -":*)".length);
    });
}

function bashExecutable() {
  if (process.platform !== "win32") return "bash";
  const gitBash = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
  return existsSync(gitBash) ? gitBash : null;
}

function bashArgv(command, bash) {
  const result = spawnSync(bash, ["-c", `printf '%s\\n' ${command}`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.replace(/\r?\n$/, "").split(/\r?\n/);
}

test("#3187 win32 recipes and allowedTools prefixes carry no backslash", () => {
  const prefixes = winNodeRulePrefixes();
  assert.equal(prefixes.length, 3);
  for (const text of [...prefixes, ...Object.values(winRecipes())]) {
    assert.ok(text.includes("C:/Users/x/repo/"), `expected a forward-slash win32 path: ${text}`);
    assert.ok(!text.includes("\\"), `backslash survives in: ${text}`);
  }
});

test("#3187 each win32 recipe matches an allowedTools prefix byte for byte", () => {
  const prefixes = winNodeRulePrefixes();
  for (const [name, command] of Object.entries(winRecipes())) {
    assert.ok(
      prefixes.some((prefix) => command === prefix || command.startsWith(`${prefix} `)),
      `${name} recipe has no matching Bash(...:*) prefix: ${command}`,
    );
  }
});

test("#3187 win32 recipes reach argv unchanged through bash", (t) => {
  const bash = bashExecutable();
  if (bash === null) {
    t.skip("Git Bash not found on this Windows host");
    return;
  }
  // Control: the legacy unquoted backslash form is what bash destroys.
  assert.deepEqual(bashArgv(`node ${winRoot}\\x.mjs`, bash), ["node", "C:Usersxrepox.mjs"]);
  for (const [name, command] of Object.entries(winRecipes())) {
    assert.deepEqual(bashArgv(command, bash), command.split(" "), name);
  }
});

test("#3187 POSIX recipe paths are emitted unchanged", () => {
  const posix = { repoRoot: "/srv/back\\slash/repo", pathApi: path.posix };
  const recipe = stickyWriteReadbackRecipe(slug, 4242, posix);
  assert.equal(
    recipe,
    `sticky_write_readback_recipe: node /srv/back\\slash/repo/.devpro/scripts/read-second-review-sticky-comment.mjs get ${slug} 4242`,
  );
});
