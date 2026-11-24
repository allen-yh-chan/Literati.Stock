import { existsSync, readFileSync, readdirSync } from "node:fs";
import { repoPath } from "./repo-root.mjs";
import { readRepoFile } from "./read.mjs";

export function readIfExists(relPath) {
  const full = repoPath(relPath);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
}

export function listArchivedChangeDirs(changeName) {
  const archiveDir = repoPath("openspec/changes/archive");
  if (!existsSync(archiveDir)) return [];
  return readdirSync(archiveDir).filter((name) => name.endsWith(`-${changeName}`));
}

export function readArchivedDeltas(changeName, capability) {
  return listArchivedChangeDirs(changeName)
    .map((name) =>
      readIfExists(`openspec/changes/archive/${name}/specs/${capability}/spec.md`),
    )
    .join("\n");
}

/** Active delta, plus archived deltas only when includeArchive is true. */
export function readDeltaForChange(
  changeName,
  capability,
  { includeArchive = false } = {},
) {
  const active = readIfExists(
    `openspec/changes/${changeName}/specs/${capability}/spec.md`,
  );
  if (!includeArchive) return active;
  return [active, readArchivedDeltas(changeName, capability)].join("\n");
}

/**
 * Canonical spec plus active deltas. Does not union archive unless
 * includeArchive is true (historical-delta assertions only).
 */
export function readSpecWithDelta(capability, options = {}) {
  const { changeName, changeNames, includeArchive = false } = options;
  const names = changeNames ?? (changeName ? [changeName] : []);
  const canonical = readRepoFile(`openspec/specs/${capability}/spec.md`);
  const deltas = names
    .map((name) => readDeltaForChange(name, capability, { includeArchive }))
    .join("\n");
  return [canonical, deltas].join("\n");
}

/**
 * Archive-fallback, not union: active change file, else latest matching
 * archive copy, else canonical fallback. Used by frozen routing tests.
 */
export function readChangeSpecWithArchiveFallback(
  changeName,
  specRelPath,
  canonicalFallbackRel,
) {
  const active = readIfExists(`openspec/changes/${changeName}/${specRelPath}`);
  if (active) return active;

  const archived = listArchivedChangeDirs(changeName)
    .map((name) => readIfExists(`openspec/changes/archive/${name}/${specRelPath}`))
    .filter(Boolean)
    .sort();
  if (archived.length > 0) return archived.at(-1);

  return readRepoFile(canonicalFallbackRel);
}
