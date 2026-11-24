#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(modulePath);
const defaultRoot = path.resolve(scriptDir, "../..");
const KNOWN_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
  "user-invocable",
  "disable-model-invocation",
  "argument-hint",
  // Legacy fields kept for copied upstream CLI manuals.
  "version",
  "author",
  "platforms",
]);
const KNOWN_WARNING_CODES = new Set([
  "missing-use-when",
  "long-body",
]);
// use-when 觸發詞契約（中英雙收）：description 須含此組任一觸發詞，否則 missing-use-when warning。
// 此 const 為詞集 SSOT（英文 "use when" ｜ 中文「使用時機」｜ 中文「當…時」)；中文「當…時」分支限制
// 「當」到「時」之間不可跨句號（`[^。]*`），避免任意含「當」「時」字樣的句子被誤判為已宣告 use-when。
// governance:25 契約文字與 agent-skill-governance.test.mjs 的 USE_WHEN_BILINGUAL_RE 引同一語意，
// 禁各自 hardcode 平行清單；三者需同步變更。
const USE_WHEN_TRIGGER_RE = /use when|使用時機|當[^。]*時/i;

// design D1/D3 — catalog root: the single tree reachable through the
// `devpro` discovery entries and the plugin manifest's `skills`. MUST NOT
// contain a bare SKILL.md at its own root, and MUST NOT contain refs/
// template content — those live in SKILL_REFS_REL (design D2), a sibling
// root outside the entry tree so Codex's recursive scan and Claude's
// skills-dir plugin never expose them as `devpro:<name>`.
const SKILL_CATALOG_REL = ".devpro/agent-skills";
const SKILL_CATALOG_MANIFEST_REL = ".devpro/agent-skills/manifest.json";
const SKILL_REFS_REL = ".devpro/agent-skills-refs";
const SKILL_REFS_MANIFEST_REL = ".devpro/agent-skills-refs/manifest.json";
const SKILL_PLUGIN_MANIFEST_REL = ".devpro/agent-skills/.claude-plugin/plugin.json";
// design D3 — the sole permitted discovery entry name under each runtime
// skill discovery dir (mirrors sync-agent-rules.mjs's SKILL_ENTRY_NAME).
const SKILL_ENTRY_NAME = "devpro";
const SKILL_ENTRY_LINK_TARGET = `../../${SKILL_CATALOG_REL}`;
// design D1 Open Question — Claude accepts a bare group name or a "./"
// -prefixed relative path in a skills-dir plugin manifest's `skills` array;
// the refactor-agent-skills-entry D12 probe confirmed Claude accepts
// "./<group>"; with it Claude and Codex both list `devpro:<name>` (see that
// change's skill-evaluation.md). This is the ONLY place the form is
// encoded — flipping it is a one-constant change.
const PLUGIN_SKILL_PATH_FORM = "./<group>";
function formatPluginSkillPath(group) {
  return PLUGIN_SKILL_PATH_FORM.replace("<group>", group);
}

function parseArgs(argv) {
  const args = { root: defaultRoot };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") {
      args.root = path.resolve(argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

function normalizeRel(p) {
  return p.split(path.sep).join("/");
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const SKILL_DISCOVERY_DIRS = [
  path.join(".agents", "skills"),
  path.join(".claude", "skills"),
];

// Each runtime skill discovery directory (.agents/skills, .claude/skills)
// MUST hold exactly one entry, named `devpro` (design D1/D3 — the
// entry-basename lock), which is a symlink resolving to the catalog root
// itself (not merely "under" it, unlike the pre-2-entry-topology contract).
// Any other entry name, a non-symlink node, or a symlink that resolves
// elsewhere all fail closed.
async function assertSkillDiscoveryEntry(root, dirRelPath, errors) {
  const dirAbs = path.join(root, dirRelPath);
  if (!(await pathExists(dirAbs))) return;
  // Canonicalize root before the realpath comparison — mirrors
  // sync-agent-rules.mjs' buildManagedSkillInventory() discovery check.
  const realRoot = await fs.realpath(root).catch(() => root);
  const catalogRootAbs = path.join(realRoot, ...SKILL_CATALOG_REL.split("/"));
  let catalogRealPath;
  try {
    catalogRealPath = await fs.realpath(catalogRootAbs);
  } catch {
    errors.push(`${SKILL_CATALOG_REL}: catalog root missing; cannot validate ${dirRelPath}/${SKILL_ENTRY_NAME}`);
    return;
  }

  const entries = await fs.readdir(dirAbs, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name !== SKILL_ENTRY_NAME) {
      const entryRel = normalizeRel(path.join(dirRelPath, entry.name));
      errors.push(
        `${entryRel}: only '${normalizeRel(dirRelPath)}/${SKILL_ENTRY_NAME}' is allowed under this discovery root`
      );
    }
  }

  const entryAbs = path.join(dirAbs, SKILL_ENTRY_NAME);
  const entryRel = normalizeRel(path.join(dirRelPath, SKILL_ENTRY_NAME));
  const stat = await fs.lstat(entryAbs).catch(() => null);
  if (!stat) {
    errors.push(`${entryRel}: missing — this discovery dir must contain the '${SKILL_ENTRY_NAME}' entry`);
    return;
  }
  if (!stat.isSymbolicLink()) {
    errors.push(
      `${entryRel}: must be a symlink resolving to ${SKILL_CATALOG_REL}, found ${stat.isDirectory() ? "directory" : "file"}`
    );
    return;
  }
  let linkTarget;
  try {
    linkTarget = await fs.readlink(entryAbs);
  } catch (e) {
    errors.push(`${entryRel}: symlink unreadable (${e.message})`);
    return;
  }
  // Literal-target lock (reusable-skill-adoption): mirrors sync-agent-rules.mjs,
  // which normalizes only `\` → `/` before comparing.
  const normalizedTarget = linkTarget.replaceAll("\\", "/");
  if (normalizedTarget !== SKILL_ENTRY_LINK_TARGET) {
    errors.push(`${entryRel}: symlink literal target "${linkTarget}" must equal "${SKILL_ENTRY_LINK_TARGET}"`);
    return;
  }
  const resolved = path.resolve(path.dirname(entryAbs), linkTarget);
  let realResolved;
  try {
    realResolved = await fs.realpath(resolved);
  } catch {
    errors.push(`${entryRel}: symlink target "${linkTarget}" does not resolve (broken symlink)`);
    return;
  }
  if (realResolved !== catalogRealPath) {
    errors.push(`${entryRel}: symlink target "${linkTarget}" must resolve to ${SKILL_CATALOG_REL} itself`);
  }
}

async function findSkillFiles(dir) {
  if (!(await pathExists(dir))) return [];
  const out = [];
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out.sort();
}

/**
 * design D6 — expected-inventory: walk the catalog root the same way a
 * host's discovery scan would (following directory symlinks, guarded by
 * realpath cycle detection, mirroring Codex's recursive `.agents/skills/**`
 * scan), and report every SKILL.md-bearing directory (relative to
 * catalogRootAbs; "" means a SKILL.md sits directly at the catalog root —
 * the D1 anti-pattern) plus every `.claude-plugin/` directory found (a
 * second plugin manifest anywhere in the tree is a fault; only the one at
 * the catalog root itself is expected).
 */
export async function collectEntryTreeSkillSet(catalogRootAbs) {
  const skillDirs = [];
  const pluginManifestDirs = [];
  const visitedRealPaths = new Set();

  async function walk(dirAbs, relFromRoot) {
    const real = await fs.realpath(dirAbs).catch(() => null);
    if (real == null || visitedRealPaths.has(real)) return;
    visitedRealPaths.add(real);

    const entries = await fs.readdir(dirAbs, { withFileTypes: true }).catch(() => []);
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      skillDirs.push(relFromRoot);
    }
    for (const entry of entries) {
      if (entry.name === "SKILL.md") continue;
      const entryAbs = path.join(dirAbs, entry.name);
      const entryRel = relFromRoot === "" ? entry.name : `${relFromRoot}/${entry.name}`;
      if (entry.name === ".claude-plugin") {
        if (await pathExists(path.join(entryAbs, "plugin.json"))) {
          pluginManifestDirs.push(entryRel);
        }
        continue;
      }
      let isDir = entry.isDirectory();
      if (!isDir && entry.isSymbolicLink()) {
        const stat = await fs.stat(entryAbs).catch(() => null);
        isDir = stat?.isDirectory() ?? false;
      }
      if (isDir) await walk(entryAbs, entryRel);
    }
  }

  await walk(catalogRootAbs, "");
  return {
    skillDirs: [...new Set(skillDirs)].sort(),
    pluginManifestDirs: [...new Set(pluginManifestDirs)].sort(),
  };
}

function extractFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const end = lines.findIndex((line, idx) => idx > 0 && line === "---");
  if (end === -1) return null;
  return {
    text: lines.slice(1, end).join("\n"),
    body: lines.slice(end + 1).join("\n"),
  };
}

function cleanScalar(value) {
  return value.trim().replace(/^["']|["']$/g, "");
}

function readField(frontmatter, field) {
  const lines = frontmatter.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = new RegExp(`^${field}:\\s*(.*)$`).exec(lines[i]);
    if (!match) continue;
    const inline = match[1].trim();
    if (inline && inline !== ">" && inline !== "|") return cleanScalar(inline);
    const block = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^[a-z][a-z0-9-]*:/.test(lines[j])) break;
      if (/^\s+/.test(lines[j])) block.push(lines[j].trim());
    }
    return cleanScalar(block.join(" "));
  }
  return "";
}

function topLevelFields(frontmatter) {
  return frontmatter
    .split(/\r?\n/)
    .map((line) => /^([a-z][a-z0-9-]*):/.exec(line)?.[1])
    .filter(Boolean);
}

function validateSkill({ repoRoot, filePath, allowedWarnings = new Set() }) {
  const rel = normalizeRel(path.relative(repoRoot, filePath));
  const errors = [];
  const warnings = [];
  function pushWarning(code, message) {
    if (!allowedWarnings.has(code)) warnings.push(message);
  }
  return fs.readFile(filePath, "utf8").then((content) => {
    const parsed = extractFrontmatter(content);
    if (!parsed) {
      errors.push(`${rel}: missing YAML frontmatter delimiters`);
      return { rel, errors, warnings };
    }

    const name = readField(parsed.text, "name");
    const description = readField(parsed.text, "description");
    if (!name) errors.push(`${rel}: missing name`);
    if (!description) errors.push(`${rel}: missing description`);
    if (name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      errors.push(`${rel}: invalid name "${name}"`);
    }
    const dirName = path.basename(path.dirname(filePath));
    if (name && name !== dirName) {
      errors.push(`${rel}: name "${name}" does not match directory "${dirName}"`);
    }
    if (description.length > 1024) {
      errors.push(`${rel}: description exceeds 1024 characters`);
    }
    if (description && !USE_WHEN_TRIGGER_RE.test(description)) {
      pushWarning("missing-use-when", `${rel}: description missing "Use when" trigger wording`);
    }

    for (const field of topLevelFields(parsed.text)) {
      if (!KNOWN_FIELDS.has(field)) warnings.push(`${rel}: unknown frontmatter field "${field}"`);
    }
    for (const boolField of ["user-invocable", "disable-model-invocation"]) {
      const value = readField(parsed.text, boolField);
      if (value && value !== "true" && value !== "false") {
        errors.push(`${rel}: ${boolField} must be true or false`);
      }
    }

    const firstBodyLine = parsed.body.split(/\r?\n/).find((line) => line.trim());
    if (!firstBodyLine) errors.push(`${rel}: empty skill body`);
    if (firstBodyLine && !firstBodyLine.startsWith("#")) {
      errors.push(`${rel}: body must start with a markdown heading`);
    }

    const lineCount = content.split(/\r?\n/).length;
    if (lineCount > 500) pushWarning("long-body", `${rel}: ${lineCount} lines; split cold details into references/`);
    return { rel, errors, warnings };
  });
}

async function readManifestAt(repoRoot, manifestRelPath, label) {
  const manifestPath = path.join(repoRoot, ...manifestRelPath.split("/"));
  try {
    return JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (e) {
    throw new Error(`${label} unreadable: ${e.message}`);
  }
}

function manifestSkillEntries(manifest) {
  const entries = [];
  for (const group of manifest.groups ?? []) {
    for (const skill of group.skills ?? []) {
    if (typeof skill === "string") {
      entries.push({ group: group.name, name: path.basename(skill), path: skill });
    } else {
      entries.push({ group: group.name, ...skill });
    }
  }
  }
  return entries;
}

function manifestAllowedWarningMap(manifest) {
  const allowed = new Map();
  for (const entry of manifestSkillEntries(manifest)) {
    const rel = normalizeRel(entry.path ?? "");
    if (!rel) continue;
    const warnings = entry.upstreamCopy === true && Array.isArray(entry.allowedWarnings)
      ? entry.allowedWarnings
      : [];
    allowed.set(rel, new Set(warnings));
  }
  return allowed;
}

async function validateManifestSkills({ repoRoot, actualSkillDirs, manifest, rootPrefix, manifestLabel }) {
  const errors = [];
  if (!manifest.name) errors.push(`${manifestLabel}: missing name`);
  if (!Array.isArray(manifest.groups)) errors.push(`${manifestLabel}: groups must be an array`);

  const entries = manifestSkillEntries(manifest);
  const seen = new Map();
  for (const entry of entries) {
    if (!entry.name) errors.push(`${manifestLabel}: skill entry missing name for path ${entry.path}`);
    if (!entry.path) {
      errors.push(`${manifestLabel}: skill ${entry.name ?? "<unknown>"} missing path`);
      continue;
    }
    const rel = normalizeRel(entry.path);
    if (!rel.startsWith(rootPrefix)) {
      errors.push(`${manifestLabel}: ${rel} must stay under ${rootPrefix}`);
    }
    seen.set(rel, (seen.get(rel) ?? 0) + 1);
    const skillFile = path.join(repoRoot, rel, "SKILL.md");
    if (!(await pathExists(skillFile))) errors.push(`${manifestLabel}: ${rel}/SKILL.md missing`);
    if (entry.name && entry.name !== path.basename(rel)) {
      errors.push(`${manifestLabel}: name ${entry.name} does not match path basename ${path.basename(rel)}`);
    }
    if (Object.prototype.hasOwnProperty.call(entry, "upstreamCopy") && typeof entry.upstreamCopy !== "boolean") {
      errors.push(`${manifestLabel}: ${rel} upstreamCopy must be true or false`);
    }
    if (Object.prototype.hasOwnProperty.call(entry, "allowedWarnings")) {
      if (!Array.isArray(entry.allowedWarnings)) {
        errors.push(`${manifestLabel}: ${rel} allowedWarnings must be an array`);
      } else {
        for (const code of entry.allowedWarnings) {
          if (!KNOWN_WARNING_CODES.has(code)) {
            errors.push(`${manifestLabel}: ${rel} unknown allowedWarnings code "${code}"`);
          }
        }
        if (entry.allowedWarnings.length > 0 && entry.upstreamCopy !== true) {
          errors.push(`${manifestLabel}: ${rel} allowedWarnings require upstreamCopy=true`);
        }
      }
    }
  }

  for (const [rel, count] of seen) {
    if (count > 1) errors.push(`${manifestLabel}: ${rel} listed ${count} times`);
  }
  for (const actual of actualSkillDirs) {
    if (!seen.has(actual)) errors.push(`${manifestLabel}: missing skill ${actual}`);
  }
  for (const rel of seen.keys()) {
    if (!actualSkillDirs.includes(rel)) errors.push(`${manifestLabel}: stale skill ${rel}`);
  }
  return errors;
}

// design D1/D4 — host plugin manifest: entry-basename lock (`name` must
// equal the discovery entry name, "devpro"), no `version` (single SemVer
// SSOT stays the release version, not a second one here), and `skills`
// must equal the catalog manifest's group names (deduped, sorted), each
// formatted via the single PLUGIN_SKILL_PATH_FORM constant.
async function validatePluginManifest({ repoRoot, catalogManifest, errors }) {
  const pluginPath = path.join(repoRoot, ...SKILL_PLUGIN_MANIFEST_REL.split("/"));
  if (!(await pathExists(pluginPath))) {
    errors.push(`plugin manifest missing: ${SKILL_PLUGIN_MANIFEST_REL}`);
    return;
  }
  let plugin;
  try {
    plugin = JSON.parse(await fs.readFile(pluginPath, "utf8"));
  } catch (e) {
    errors.push(`plugin manifest unreadable: ${e.message}`);
    return;
  }
  if (plugin.name !== SKILL_ENTRY_NAME) {
    errors.push(`plugin manifest name must equal "${SKILL_ENTRY_NAME}", got ${JSON.stringify(plugin.name)}`);
  }
  if (typeof plugin.description !== "string" || plugin.description.length === 0) {
    errors.push("plugin manifest missing description");
  }
  if (Object.prototype.hasOwnProperty.call(plugin, "version")) {
    errors.push("plugin manifest must not declare version");
  }
  const expectedGroups = [...new Set((catalogManifest.groups ?? []).map((group) => group.name))].sort();
  const expectedSkills = expectedGroups.map(formatPluginSkillPath);
  const actualSkills = Array.isArray(plugin.skills) ? plugin.skills : null;
  if (actualSkills == null || JSON.stringify(actualSkills) !== JSON.stringify(expectedSkills)) {
    errors.push(
      `plugin manifest skills must equal ${JSON.stringify(expectedSkills)}, got ${JSON.stringify(plugin.skills)}`
    );
  }
  for (const entry of actualSkills ?? []) {
    if (
      typeof entry !== "string" ||
      entry.includes("..") ||
      path.posix.isAbsolute(entry) ||
      path.win32.isAbsolute(entry)
    ) {
      errors.push(`plugin manifest skills entry ${JSON.stringify(entry)} must be a relative path without ".."`);
    }
  }
}

// design D4 — qualified-name length lock: every catalog skill is reachable
// as `devpro:<name>` (Claude slash-completion / Codex prefix); the
// combined form must stay within the 64-char ceiling both hosts enforce.
const QUALIFIED_NAME_PREFIX = "devpro:";
const QUALIFIED_NAME_MAX_LENGTH = 64;

async function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const catalogRoot = path.join(root, ...SKILL_CATALOG_REL.split("/"));
  const refsRoot = path.join(root, ...SKILL_REFS_REL.split("/"));
  const errors = [];
  const warnings = [];

  // ── Catalog ──────────────────────────────────────────────────────────
  const catalogSkillFiles = await findSkillFiles(catalogRoot);
  const catalogSkillDirs = catalogSkillFiles.map((file) => normalizeRel(path.relative(root, path.dirname(file))));
  const catalogManifest = await readManifestAt(root, SKILL_CATALOG_MANIFEST_REL, "manifest");
  const catalogAllowedWarnings = manifestAllowedWarningMap(catalogManifest);

  for (const filePath of catalogSkillFiles) {
    const skillDir = normalizeRel(path.relative(root, path.dirname(filePath)));
    const result = await validateSkill({
      repoRoot: root,
      filePath,
      allowedWarnings: catalogAllowedWarnings.get(skillDir),
    });
    errors.push(...result.errors);
    warnings.push(...result.warnings);

    const qualifiedName = `${QUALIFIED_NAME_PREFIX}${path.basename(skillDir)}`;
    if (qualifiedName.length > QUALIFIED_NAME_MAX_LENGTH) {
      errors.push(
        `${skillDir}: qualified name "${qualifiedName}" is ${qualifiedName.length} chars, exceeds ${QUALIFIED_NAME_MAX_LENGTH}`
      );
    }
  }
  errors.push(
    ...(await validateManifestSkills({
      repoRoot: root,
      actualSkillDirs: catalogSkillDirs,
      manifest: catalogManifest,
      rootPrefix: `${SKILL_CATALOG_REL}/`,
      manifestLabel: "manifest",
    }))
  );

  // design D1/D6 — catalog-root SKILL.md, expected-inventory, and stray
  // plugin-manifest checks (entry-tree walk, symlink-following).
  if (await pathExists(catalogRoot)) {
    const entryTree = await collectEntryTreeSkillSet(catalogRoot);
    if (entryTree.skillDirs.includes("")) {
      errors.push(`${SKILL_CATALOG_REL}: catalog root must not contain a SKILL.md directly`);
    }
    const expectedEntryRelDirs = catalogSkillDirs
      .map((rel) => normalizeRel(path.posix.relative(SKILL_CATALOG_REL, rel)))
      .sort();
    const observedEntryRelDirs = entryTree.skillDirs.filter((rel) => rel !== "").sort();
    if (JSON.stringify(observedEntryRelDirs) !== JSON.stringify(expectedEntryRelDirs)) {
      errors.push(
        `${SKILL_CATALOG_REL}: entry tree skill set mismatch — expected ${JSON.stringify(expectedEntryRelDirs)}, ` +
        `observed ${JSON.stringify(observedEntryRelDirs)}`
      );
    }
    const strayPluginManifests = entryTree.pluginManifestDirs.filter((rel) => rel !== ".claude-plugin");
    if (strayPluginManifests.length > 0) {
      errors.push(`${SKILL_CATALOG_REL}: unexpected plugin manifest location(s) ${JSON.stringify(strayPluginManifests)}`);
    }
  }

  await validatePluginManifest({ repoRoot: root, catalogManifest, errors });

  // ── Refs (optional root; design D2) ─────────────────────────────────
  // Tolerated absent (older fixtures / minimal `--root` sandboxes never
  // create it), but every check runs fail-closed once the root exists.
  if (await pathExists(refsRoot)) {
    const refsSkillFilesRaw = await findSkillFiles(refsRoot);
    const refsSkillFiles = refsSkillFilesRaw.filter((file) => !normalizeRel(file).includes("/templates/"));
    const refsSkillDirs = refsSkillFiles.map((file) => normalizeRel(path.relative(root, path.dirname(file))));

    let refsManifest = null;
    try {
      refsManifest = await readManifestAt(root, SKILL_REFS_MANIFEST_REL, "refs manifest");
    } catch (e) {
      errors.push(e.message);
    }

    if (refsManifest) {
      const refsAllowedWarnings = manifestAllowedWarningMap(refsManifest);
      for (const filePath of refsSkillFiles) {
        const skillDir = normalizeRel(path.relative(root, path.dirname(filePath)));
        const result = await validateSkill({
          repoRoot: root,
          filePath,
          allowedWarnings: refsAllowedWarnings.get(skillDir),
        });
        errors.push(...result.errors);
        warnings.push(...result.warnings);
      }
      errors.push(
        ...(await validateManifestSkills({
          repoRoot: root,
          actualSkillDirs: refsSkillDirs,
          manifest: refsManifest,
          rootPrefix: `${SKILL_REFS_REL}/`,
          manifestLabel: "refs manifest",
        }))
      );
    }
  }
  // Note: each manifest's own rootPrefix check above (with a trailing "/")
  // already rejects a catalog entry pointing into the refs root (or vice
  // versa) — ".devpro/agent-skills-refs/<name>".startsWith(".devpro/agent-skills/")
  // is false because of the "-refs" divergence right after the shared
  // prefix, so no separate cross-root guard is needed here.

  if (await pathExists(path.join(root, "skills"))) errors.push("root skills/ must not exist");
  for (const dirRelPath of SKILL_DISCOVERY_DIRS) {
    await assertSkillDiscoveryEntry(root, dirRelPath, errors);
  }

  for (const warning of warnings) console.warn(`WARN: ${warning}`);
  for (const error of errors) console.error(`ERROR: ${error}`);
  console.log(`Checked ${catalogSkillFiles.length} skill(s), ${warnings.length} warning(s), ${errors.length} error(s)`);
  if (errors.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`ERROR: ${e.message}`);
    process.exitCode = 1;
  });
}
