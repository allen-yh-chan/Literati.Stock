#!/usr/bin/env node
/**
 * Builds the self-contained bundle the review server installs for remote ordinary-primary reviews.
 *
 *   node .devpro/scripts/build-remote-review-bundle.mjs --out <new or empty dir> [--allow-dirty]
 *   node .devpro/scripts/build-remote-review-bundle.mjs --verify <bundle dir>
 *
 * The bundle holds exactly: the shared OpenCode primary runner and the files it really imports (the
 * `.devpro/scripts/` subtree is kept so relative imports resolve), the prompt template, the rule files handed
 * to OpenCode as instruction files (under `rules/`), and `MANIFEST.json` (source commit plus the SHA-256 and
 * size of every file). Nothing in it depends on the rest of the repository, and the build is deterministic:
 * the same tree gives byte-identical output. A bundle built from files that differ from HEAD records
 * `source_dirty: true`, which an installer must refuse.
 *
 * One file is deliberately a stub (`stubs` in the manifest): `second-review-material-contract.mjs`, which the
 * runner reaches through its reviewer modules, resolves the real path of `render-second-review-packet.mjs` at
 * module load only to derive its canonical repository root. The runner never renders a packet, and shipping
 * the renderer would pull in 43 more files, so the bundle carries an empty module under that name instead.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLE_SCHEMA = "devpro.remote-review-bundle/v1";
export const BUNDLE_ENTRY = ".devpro/scripts/run-opencode-primary-review.mjs";
export const BUNDLE_TEMPLATE = ".devpro/scripts/lib/remote-review-primary-prompt.template.md";
export const BUNDLE_INSTRUCTION_FILES = Object.freeze(["code-review-checklist.md", "security-coding.md", "review-guarantee-ceiling.md"]);
// The values the launcher must supply to the template; the build refuses a template that asks for anything else.
export const TEMPLATE_PLACEHOLDERS = Object.freeze([
  "request_id", "head", "base", "worktree", "file_count", "file_list", "scope_block", "criteria_block", "diff_fence", "diff",
]);
export const BUNDLE_STUBS = Object.freeze({
  ".devpro/scripts/render-second-review-packet.mjs":
    "// Stub: present only because second-review-material-contract.mjs resolves this path at load.\n// The remote primary review never renders a second-review packet.\nexport {};\n",
});
const MANIFEST_NAME = "MANIFEST.json";
const SPECIFIER = [
  /\bfrom\s*["']([^"']+)["']/gu,
  /\bimport\s*["']([^"']+)["']/gu,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
  /\brequire\s*\(\s*["']([^"']+)["']/gu,
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const posix = (value) => value.split(path.sep).join("/");

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
}

/** Repo-relative paths of `entry` and every file it reaches through relative imports, sorted. */
export function importClosure(repoRoot, entry) {
  const seen = new Set();
  const visit = (relative) => {
    if (seen.has(relative)) return;
    const absolute = path.join(repoRoot, relative);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`bundle closure: ${relative} does not exist`);
    seen.add(relative);
    const source = stripComments(readFileSync(absolute, "utf8"));
    for (const pattern of SPECIFIER) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (specifier.startsWith("node:") || builtinModules.includes(specifier)) continue;
        if (!specifier.startsWith(".")) throw new Error(`bundle closure: ${relative} imports "${specifier}", which is not a Node built-in`);
        const next = posix(path.relative(repoRoot, path.resolve(path.dirname(absolute), specifier)));
        if (!existsSync(path.join(repoRoot, next))) throw new Error(`bundle closure: ${relative} imports ${specifier}, but ${next} is missing`);
        visit(next);
      }
    }
  };
  visit(entry);
  return [...seen].sort();
}

function gitText(repoRoot, args) {
  const run = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`bundle: git ${args[0]} failed`);
  return run.stdout;
}

function templatePlaceholders(text) {
  return [...new Set([...text.matchAll(/\{\{([a-z_]+)\}\}/gu)].map((match) => match[1]))].sort();
}

function listFiles(root, dir = root) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(root, full));
    else found.push(posix(path.relative(root, full)));
  }
  return found.sort();
}

export function buildRemoteReviewBundle({ repoRoot, outDir, requireClean = true }) {
  if (existsSync(outDir) && readdirSync(outDir).length > 0) throw new Error("bundle: the output directory is not empty");
  const sources = [
    ...importClosure(repoRoot, BUNDLE_ENTRY).map((file) => ({ from: file, to: file })),
    { from: BUNDLE_TEMPLATE, to: BUNDLE_TEMPLATE },
    ...BUNDLE_INSTRUCTION_FILES.map((name) => ({ from: `.devpro/agent-rules/${name}`, to: `rules/${name}` })),
  ];
  const unique = new Map(sources.map((source) => [source.to, source]));
  for (const stub of Object.keys(BUNDLE_STUBS)) {
    if (unique.has(stub)) throw new Error(`bundle: ${stub} is both a stub and a real dependency of the runner`);
  }
  for (const { from } of unique.values()) {
    if (!existsSync(path.join(repoRoot, from))) throw new Error(`bundle: ${from} does not exist`);
  }
  const template = readFileSync(path.join(repoRoot, BUNDLE_TEMPLATE), "utf8");
  const placeholders = templatePlaceholders(template);
  if (placeholders.join(",") !== [...TEMPLATE_PLACEHOLDERS].sort().join(",")) {
    throw new Error(`bundle: the template asks for {{${placeholders.join("}}, {{")}}}, which is not the launcher's value set`);
  }
  const changed = gitText(repoRoot, ["status", "--porcelain", "--", ...[...unique.values()].map((source) => source.from)]).trim();
  if (changed !== "" && requireClean) throw new Error(`bundle: source files differ from HEAD:\n${changed}`);

  const files = [];
  const contents = new Map([...unique].map(([target, source]) => [target, readFileSync(path.join(repoRoot, source.from))]));
  for (const [stub, text] of Object.entries(BUNDLE_STUBS)) contents.set(stub, Buffer.from(text, "utf8"));
  for (const target of [...contents.keys()].sort()) {
    const bytes = contents.get(target);
    const destination = path.join(outDir, target);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
    files.push({ path: target, sha256: sha256(bytes), bytes: bytes.length });
  }
  const manifest = {
    schema: BUNDLE_SCHEMA,
    source_commit: gitText(repoRoot, ["rev-parse", "HEAD"]).trim(),
    source_dirty: changed !== "",
    entry: BUNDLE_ENTRY,
    template: BUNDLE_TEMPLATE,
    stubs: Object.keys(BUNDLE_STUBS).sort(),
    template_placeholders: placeholders,
    instruction_files: BUNDLE_INSTRUCTION_FILES.map((name) => `rules/${name}`),
    files,
  };
  writeFileSync(path.join(outDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Re-reads a bundle directory and checks it against its own manifest. */
export function verifyRemoteReviewBundle(bundleDir) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(bundleDir, MANIFEST_NAME), "utf8"));
  } catch {
    return { ok: false, reason: "MANIFEST.json is missing or unreadable" };
  }
  if (manifest?.schema !== BUNDLE_SCHEMA || !Array.isArray(manifest.files)) return { ok: false, reason: "MANIFEST.json has an unsupported shape" };
  // Provenance and the fixed layout are part of what "intact" means: a manifest that lists nothing, or that
  // leaves out source_commit / source_dirty, would otherwise verify and let a dirty or unknown source through.
  if (typeof manifest.source_commit !== "string" || !/^[0-9a-f]{40}$/u.test(manifest.source_commit)) {
    return { ok: false, reason: "MANIFEST.json lacks a valid source_commit" };
  }
  if (typeof manifest.source_dirty !== "boolean") return { ok: false, reason: "MANIFEST.json lacks a boolean source_dirty" };
  if (manifest.entry !== BUNDLE_ENTRY) return { ok: false, reason: "MANIFEST.json names another entry point" };
  if (manifest.template !== BUNDLE_TEMPLATE) return { ok: false, reason: "MANIFEST.json names another template" };
  const sameList = (actual, expected) => Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
  if (!sameList(manifest.instruction_files, BUNDLE_INSTRUCTION_FILES.map((name) => `rules/${name}`))) {
    return { ok: false, reason: "MANIFEST.json names other instruction files" };
  }
  if (!sameList(manifest.stubs, Object.keys(BUNDLE_STUBS).sort())) return { ok: false, reason: "MANIFEST.json declares other stubs than the builder knows" };
  if (!sameList(manifest.template_placeholders, [...TEMPLATE_PLACEHOLDERS].sort())) {
    return { ok: false, reason: "MANIFEST.json declares another template placeholder set" };
  }
  if (manifest.files.length === 0) return { ok: false, reason: "MANIFEST.json lists no files" };
  const listed = new Set();
  for (const entry of manifest.files) {
    const relative = entry?.path;
    if (typeof relative !== "string" || relative === "" || path.isAbsolute(relative) || relative.split("/").includes("..") || relative.includes("\\")) {
      return { ok: false, reason: "MANIFEST.json lists an unsafe path" };
    }
    if (listed.has(relative)) return { ok: false, reason: `MANIFEST.json lists ${relative} twice (duplicate entry)` };
    listed.add(relative);
    let bytes;
    try {
      bytes = readFileSync(path.join(bundleDir, relative));
    } catch {
      return { ok: false, reason: `${relative} is missing` };
    }
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) return { ok: false, reason: `${relative} does not match its digest` };
  }
  const extra = listFiles(bundleDir).filter((file) => file !== MANIFEST_NAME && !listed.has(file));
  if (extra.length > 0) return { ok: false, reason: `unlisted file in the bundle: ${extra[0]}` };
  const required = [BUNDLE_ENTRY, BUNDLE_TEMPLATE, ...manifest.instruction_files, ...Object.keys(BUNDLE_STUBS)];
  const absent = required.find((member) => !listed.has(member));
  if (absent !== undefined) return { ok: false, reason: `required member ${absent} is not listed in the manifest` };
  for (const [stub, text] of Object.entries(BUNDLE_STUBS)) {
    if (readFileSync(path.join(bundleDir, stub), "utf8") !== text) return { ok: false, reason: `stub ${stub} is not the declared stand-in` };
  }
  // Every file the entry point reaches through relative imports must be in the manifest; otherwise a
  // transitive helper could be removed together with its manifest line and the bundle would verify yet not start.
  let closure;
  try {
    closure = importClosure(bundleDir, BUNDLE_ENTRY);
  } catch (error) {
    return { ok: false, reason: `the entry point's import closure is incomplete: ${error.message}` };
  }
  const unlistedImport = closure.find((file) => !listed.has(file));
  if (unlistedImport !== undefined) return { ok: false, reason: `imported file ${unlistedImport} is not listed in the manifest` };
  return { ok: true, reason: null, source_commit: manifest.source_commit, source_dirty: manifest.source_dirty };
}

function directInvocation() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (directInvocation()) {
  const argv = process.argv.slice(2);
  const usage = "usage: build-remote-review-bundle.mjs --out <new or empty dir> [--allow-dirty] | --verify <bundle dir>";
  try {
    if (argv.length === 2 && argv[0] === "--verify") {
      const verdict = verifyRemoteReviewBundle(path.resolve(argv[1]));
      process.stdout.write(`${JSON.stringify(verdict)}\n`);
      process.exitCode = verdict.ok ? 0 : 1;
    } else if ((argv.length === 2 || (argv.length === 3 && argv[2] === "--allow-dirty")) && argv[0] === "--out") {
      const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
      const manifest = buildRemoteReviewBundle({ repoRoot, outDir: path.resolve(argv[1]), requireClean: argv.length === 2 });
      process.stdout.write(`${JSON.stringify({ built: true, source_commit: manifest.source_commit, source_dirty: manifest.source_dirty, files: manifest.files.length })}\n`);
    } else {
      throw new Error(usage);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
