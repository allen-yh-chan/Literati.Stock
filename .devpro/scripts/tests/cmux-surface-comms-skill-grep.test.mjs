import assert from "node:assert/strict";
import { readFileSync, existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SKILL_REL = ".devpro/agent-skills/devpro-workflows/cmux-surface-comms";
const SKILL_MD = path.join(ROOT, SKILL_REL, "SKILL.md");
const MANIFEST = path.join(ROOT, ".devpro/agent-skills/manifest.json");
const HANDOFF = path.join(ROOT, ".devpro/agent-rules/multi-agent-handoff.md");
const CATALOG_ROOT = path.join(ROOT, ".devpro/agent-skills");
// design D3 (refactor-agent-skills-entry) — discovery is the single `devpro`
// entry per root, resolving to the catalog root itself, not a per-skill link.
const DISCOVERY_DIRS = [".agents/skills", ".claude/skills"];

test("cmux-surface-comms skill documents probe-first and two pitfalls", () => {
  const body = readFileSync(SKILL_MD, "utf8");
  assert.match(body, /command -v cmux/);
  assert.match(body, /CMUX=/);
  assert.match(body, /"\$CMUX"/);
  assert.match(body, /\[ -x \/Applications\/cmux\.app\/Contents\/Resources\/bin\/cmux \]/);
  assert.doesNotMatch(body, /which cmux \|\| ls /);
  assert.match(body, /send-key Enter/);
  assert.match(body, /handoff-/);
  assert.match(body, /Out of scope/);
  assert.match(body, /new-surface/);
  assert.match(body, /頁籤|surface|跨 session|cmux/);
});

test("cmux-surface-comms is manifest-registered exactly once", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const hits = [];
  for (const group of manifest.groups || []) {
    for (const skill of group.skills || []) {
      if (skill.name === "cmux-surface-comms") hits.push(skill);
    }
  }
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, SKILL_REL);
});

test("cmux-surface-comms is discoverable via the single devpro entry per discovery root", () => {
  const catalogRealpath = realpathSync(CATALOG_ROOT);
  for (const discoveryDir of DISCOVERY_DIRS) {
    const dirFull = path.join(ROOT, discoveryDir);
    assert.deepEqual(
      readdirSync(dirFull),
      ["devpro"],
      `${discoveryDir} must hold only the 'devpro' entry, not a per-skill link`
    );
    const entryFull = path.join(dirFull, "devpro");
    assert.equal(lstatSync(entryFull).isSymbolicLink(), true, `${discoveryDir}/devpro must be a symlink`);
    assert.equal(
      realpathSync(entryFull),
      catalogRealpath,
      `${discoveryDir}/devpro must resolve to the catalog root itself`
    );
    const skillMdViaEntry = path.join(entryFull, "devpro-workflows", "cmux-surface-comms", "SKILL.md");
    assert.equal(
      existsSync(skillMdViaEntry),
      true,
      `cmux-surface-comms must be discoverable via ${discoveryDir}/devpro/devpro-workflows/cmux-surface-comms/SKILL.md`
    );
  }
});

test("multi-agent-handoff points at cmux-surface-comms", () => {
  const body = readFileSync(HANDOFF, "utf8");
  assert.match(body, /cmux-surface-comms/);
  assert.match(body, /command -v cmux/);
});
