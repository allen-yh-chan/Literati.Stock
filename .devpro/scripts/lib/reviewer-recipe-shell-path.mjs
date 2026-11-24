import path from "node:path";

// Reviewer recipes and their `Bash(node <path>:*)` allowedTools prefixes are
// unquoted (PRIM-F11: quoting breaks approval-prefix matching) and run under a
// POSIX shell, which on a Windows host is Git Bash. An unquoted backslash is an
// escape there, so a win32 path is emitted with forward slashes; node and Git
// Bash both accept that form. Apply this only to the emitted command text:
// paths used for filesystem access or path comparison stay native.
export function toRecipeShellPath(nativePath, pathApi = path) {
  const text = String(nativePath);
  return pathApi.sep === "\\" ? text.replaceAll("\\", "/") : text;
}

export function recipeCliShellPath(repoRoot, scriptName, pathApi = path) {
  return toRecipeShellPath(pathApi.resolve(repoRoot, ".devpro", "scripts", scriptName), pathApi);
}

// Single source for the Claude linked-issue read command prefix: the packet
// duty line and the allowedTools rule must be the same string.
export function claudeLinkedIssueReadPrefix(repoRoot, repositorySlug, pathApi = path) {
  return `node ${recipeCliShellPath(repoRoot, "read-second-review-linked-issue.mjs", pathApi)} ${repositorySlug}`;
}
export function reviewerPrLinksReadPrefix(repoRoot,repositorySlug,pathApi=path) {
  return `node ${recipeCliShellPath(repoRoot,"read-second-review-pr-links.mjs",pathApi)} ${repositorySlug}`;
}
