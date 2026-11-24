import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Repo root resolved from THIS helper's location (cwd-independent).
 *
 * tests/lib/repo-root.mjs → tests/ → scripts/ → .devpro/ → repo root,
 * so the repo root is four levels up from this file. Tests that read repo
 * files (or pass a repo-root cwd to a hook) MUST use this instead of
 * `process.cwd()` / bare relative paths, which break when the suite is run
 * from a subdirectory (e.g. `cd .devpro/scripts && node --test tests/` →
 * ENOENT on `.devpro/scripts/.devpro/agent-rules/...`).
 */
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.."
);

/**
 * Source root: the `.devpro-agent-rules` submodule when this suite runs inside a
 * consumer that vendors it, else REPO_ROOT (the source repository itself).
 * Defined here rather than in source-root.mjs so repoPath can use it without an
 * import cycle; source-root.mjs re-exports these names.
 */
export function resolveSourceRoot(repoRoot) {
  const submoduleRoot = path.join(repoRoot, ".devpro-agent-rules");
  const hasSubmoduleSource =
    existsSync(path.join(submoduleRoot, "AGENTS.md")) &&
    existsSync(path.join(submoduleRoot, ".devpro", "scripts", "sync-agent-rules.mjs"));

  return hasSubmoduleSource ? submoduleRoot : repoRoot;
}

export const SOURCE_ROOT = resolveSourceRoot(REPO_ROOT);

/** Resolve a source-relative path against SOURCE_ROOT (absolute paths pass through). */
export function sourcePath(rel) {
  return path.resolve(SOURCE_ROOT, rel);
}

// The OpenSpec corpus (`openspec/specs`, `openspec/changes`, archive) exists
// only in the source repository; a consumer reaches it through the submodule.
// rules-flow.md "Consumer full Node suite diagnostic" requires source-only
// tests to resolve it there instead of expecting a consumer-local corpus.
function isSourceOnlyCorpusPath(rel) {
  return typeof rel === "string" && /^openspec(?:[\\/]|$)/.test(rel);
}

/**
 * Resolve a repo-relative path against REPO_ROOT (absolute paths pass through).
 * `openspec/...` paths resolve against SOURCE_ROOT, which equals REPO_ROOT in
 * the source repository, so source behavior is unchanged.
 */
export function repoPath(rel) {
  return path.resolve(isSourceOnlyCorpusPath(rel) ? SOURCE_ROOT : REPO_ROOT, rel);
}

/**
 * ESM-safe `file://` URL for a repo-relative module path.
 * Windows drive letters (e.g. `C:`) are URL schemes — never pass a raw abs
 * path into dynamic `import()` / `from ${JSON.stringify(abs)}`; use this href.
 */
export function repoFileUrl(rel) {
  return pathToFileURL(repoPath(rel)).href;
}
