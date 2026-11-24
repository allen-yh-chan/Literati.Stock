import path from "node:path";

const cmuxAppDirSuffixes = new Set([
  "contents/resources",
  "contents/resources/app",
  "contents/resources/bin",
  "contents/resources/app/bin",
]);

export function normalizedExecutableIdentity(value) {
  return String(value).replaceAll("\\", "/").toLowerCase();
}

export function isIdentifiableCmuxExecutable(candidatePath, resolvedPath) {
  return [candidatePath, resolvedPath].some((value) => {
    const normalized = normalizedExecutableIdentity(value);
    const segments = normalized.split("/").filter(Boolean);
    const base = segments.at(-1) ?? "";
    if (segments.includes("cmux-cli-shims")) return true;
    if (/^cmux-(?:claude|codex)-wrapper(?:\.[a-z0-9_-]+)?$/.test(base)) return true;
    const appIndex = segments.findIndex((segment) => segment === "cmux.app");
    if (appIndex < 0) return false;
    const appResourceSuffix = segments.slice(appIndex + 1).join("/");
    return /^contents\/resources\/(?:app\/)?(?:bin\/)?(?:claude|codex|cmux-(?:claude|codex)-wrapper)(?:\.[a-z0-9_-]+)?$/.test(
      appResourceSuffix
    );
  });
}

export function isIdentifiableCmuxPathEntry(entry) {
  const normalized = normalizedExecutableIdentity(entry);
  const segments = normalized.split("/").filter(Boolean);
  if (segments.includes("cmux-cli-shims")) return true;
  const appIndex = segments.findIndex((segment) => segment === "cmux.app");
  if (appIndex < 0) return false;
  const appResourceSuffix = segments.slice(appIndex + 1).join("/");
  return cmuxAppDirSuffixes.has(appResourceSuffix);
}

function hasExactCmuxAppContentsResourcesSegments(segments) {
  const appIndex = segments.findIndex((segment) => segment === "cmux.app");
  if (appIndex < 0) return false;
  const rest = segments.slice(appIndex + 1);
  return rest[0] === "contents" && rest[1] === "resources";
}

export function nodeOptionsCarriesCmuxIdentity(value) {
  if (value == null) return false;
  const normalized = normalizedExecutableIdentity(value);
  const segments = normalized.split("/").filter(Boolean);
  if (segments.includes("cmux-cli-shims")) return true;
  if (hasExactCmuxAppContentsResourcesSegments(segments)) return true;
  return segments.some((segment) => /^cmux-(?:claude|codex)-wrapper(?:\.[a-z0-9_-]+)?$/.test(segment))
    || /(?:^|[^a-z0-9_-])cmux-(?:claude|codex)-wrapper(?:\.[a-z0-9_-]+)?(?![a-z0-9_-])/.test(normalized);
}

export function sanitizeCmuxDispatchEnv(env = process.env, { platform = process.platform } = {}) {
  if (env.PATH === undefined) {
    return { changed: false, removed_path_entry_count: 0, node_options_cleared: false };
  }

  const delimiter = (platform === "win32" ? path.win32 : path.posix).delimiter;
  const kept = [];
  let removed_path_entry_count = 0;
  for (const entry of String(env.PATH).split(delimiter)) {
    if (isIdentifiableCmuxPathEntry(entry)) {
      removed_path_entry_count += 1;
      continue;
    }
    kept.push(entry);
  }

  let pathChanged = false;
  if (removed_path_entry_count > 0) {
    env.PATH = kept.join(delimiter);
    pathChanged = true;
  }

  const shouldClearNodeOptions =
    removed_path_entry_count > 0 || nodeOptionsCarriesCmuxIdentity(env.NODE_OPTIONS);
  const node_options_cleared = Boolean(
    shouldClearNodeOptions && Object.prototype.hasOwnProperty.call(env, "NODE_OPTIONS"),
  );
  if (node_options_cleared) {
    delete env.NODE_OPTIONS;
  }

  return {
    changed: pathChanged || node_options_cleared,
    removed_path_entry_count,
    node_options_cleared,
  };
}
