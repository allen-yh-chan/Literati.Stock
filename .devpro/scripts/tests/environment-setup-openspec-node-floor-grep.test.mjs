import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";

const LEAF = ".devpro/agent-rules/environment-setup-nvm-nodejs-openspec.md";

function readFirst(paths) {
  for (const rel of paths) {
    if (existsSync(repoPath(rel))) return { path: rel, content: read(rel) };
  }
  throw new Error(`none of the expected files exist: ${paths.join(", ")}`);
}

const FLOOR = ">=20.19.0";
const SYMPTOM = "SyntaxError: Invalid regular expression flags";

describe("environment-setup openspec Node floor anchors", () => {
  const leaf = read(LEAF);
  // Prefer active change delta while open; after archive fall back to canonical
  // (same durable pattern as environment-setup-playwright-grep.test.mjs).
  const { path: specPath, content: delta } = readFirst([
    "openspec/changes/fix-environment-setup-openspec-node-prerequisite/specs/environment-setup/spec.md",
    "openspec/specs/environment-setup/spec.md",
  ]);

  it("leaf states openspec engines floor and SyntaxError symptom", () => {
    assert.match(leaf, />=20\.19\.0/, `leaf missing ${FLOOR}`);
    assert.ok(
      leaf.includes(SYMPTOM),
      `leaf missing symptom anchor ${SYMPTOM}`,
    );
  });

  it("leaf step-4 fallback MUST NOT use 團隊既定版本 / 既定版本", () => {
    assert.doesNotMatch(
      leaf,
      /團隊既定版本/,
      "leaf still contains 團隊既定版本",
    );
    assert.doesNotMatch(
      leaf,
      /既定版本/,
      "leaf still contains 既定版本 as fallback phrase",
    );
  });

  it("leaf Exit／必停 require engines floor and HELP INSTALL, not engine-strict DoD", () => {
    assert.match(
      leaf,
      />=20\.19\.0/,
      "Exit／必停 path must carry engines floor >=20.19.0",
    );
    assert.match(
      leaf,
      /HELP INSTALL|協助安裝|nvm install/i,
      "below-floor path must point to nvm HELP INSTALL",
    );
    assert.match(
      leaf,
      /engine-strict/,
      "leaf must explicitly reject engine-strict as default DoD",
    );
    assert.match(
      leaf,
      /MUST NOT.*engine-strict|不以.*engine-strict|禁.*engine-strict|不是.*engine-strict|不得.*engine-strict/i,
      "leaf must forbid engine-strict as default DoD",
    );
  });

  it("capability spec (active delta or canonical) carries floor／help-install and drops team-defined fallback", () => {
    assert.match(delta, />=20\.19\.0/, `${specPath} missing ${FLOOR}`);
    assert.ok(
      delta.includes(SYMPTOM),
      `${specPath} missing symptom anchor ${SYMPTOM}`,
    );
    assert.match(
      delta,
      /HELP INSTALL|help-install|nvm/i,
      `${specPath} missing help-install／nvm remediation language`,
    );
    assert.match(
      delta,
      /no `\\.nvmrc`|\.nvmrc` is absent/i,
      `${specPath} missing no-.nvmrc scenario language`,
    );
    assert.doesNotMatch(
      delta,
      /or with the team's?[- ]defined version|uses? (?:the )?team-defined version/i,
      `${specPath} still uses team-defined version as no-.nvmrc fallback`,
    );
    assert.match(
      delta,
      /MUST NOT.*team-defined version|undefined "team-defined version"/i,
      `${specPath} must explicitly forbid team-defined version fallback`,
    );
    assert.match(
      delta,
      /MUST NOT.*engine-strict|engine-strict.*MUST NOT|not.*default.*(DoD|done)|engine-strict/i,
      `${specPath} should mention engine-strict boundary (forbid as default DoD)`,
    );
  });

  it("leaf and capability spec stay aligned on floor and symptom", () => {
    for (const [label, content] of [
      ["leaf", leaf],
      [specPath, delta],
    ]) {
      assert.ok(content.includes(FLOOR), `${label} missing ${FLOOR}`);
      assert.ok(content.includes(SYMPTOM), `${label} missing ${SYMPTOM}`);
    }
  });
});
