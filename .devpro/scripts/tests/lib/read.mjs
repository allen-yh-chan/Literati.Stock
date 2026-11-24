import { readFileSync } from "node:fs";
import { repoPath } from "./repo-root.mjs";
import { sourcePath } from "./source-root.mjs";

export function readRepoFile(rel) {
  return readFileSync(repoPath(rel), "utf8");
}

export function readRepoFileIfExists(rel) {
  try {
    return readRepoFile(rel);
  } catch {
    return null;
  }
}

export function readSourceFile(rel) {
  return readFileSync(sourcePath(rel), "utf8");
}
