// Source-root resolution lives in repo-root.mjs so repoPath can route the
// source-only OpenSpec corpus without an import cycle.
export { resolveSourceRoot, SOURCE_ROOT, sourcePath } from "./repo-root.mjs";
