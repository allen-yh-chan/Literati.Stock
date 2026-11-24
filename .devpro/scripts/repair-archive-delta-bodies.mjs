#!/usr/bin/env node
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { execGitFileSyncWithRetry } from "./lib/git-exec-retry.mjs";
import { CHANGE_ID_SHAPE, readNoFollowFile } from "./lib/durable-fs.mjs";
import { planArchiveDeltaBodyRepair } from "./lib/requirement-body-whitespace.mjs";
import { isDirectCliInvocation } from "./lib/cli-entry.mjs";

/** Pre-commit working-tree repair, never review/transition authority. */
export function repairArchiveDeltaBodies({ repoRoot, changeId, reviewedHeadSha, archiveRoot, apply = false, recoveryAfterMerge = false }) {
  if (!CHANGE_ID_SHAPE.test(changeId)) throw new Error("invalid change name");
  if (!/^[0-9a-f]{40}$/u.test(reviewedHeadSha)) throw new Error("reviewed head must be an immutable 40-character SHA");
  if (!new RegExp(`^openspec/changes/archive/\\d{4}-\\d{2}-\\d{2}-${changeId}$`, "u").test(archiveRoot)) {
    throw new Error("archive root must be the dated archive of this change");
  }
  const git = args => execGitFileSyncWithRetry(args, { cwd: repoRoot, encoding: "utf8" }).trim();
  const headSha = git(["rev-parse", "HEAD"]);
  if (headSha !== reviewedHeadSha) {
    // Normal flow archives before the reviewed commit exists. Post-merge archive
    // recovery (openspec-step-1-to-9.md §Post-merge Archive Recovery) cannot meet
    // that ordering by construction, so it may proceed as long as the reviewed
    // head is still an ancestor: the reviewed delta blob is then still readable
    // and remains the comparison baseline below.
    if (!recoveryAfterMerge) throw new Error("repair must run before the archive commit at the reviewed HEAD");
    // Distinguish "you gave me the wrong SHA" from "this clone cannot see that object yet":
    // a shallow clone or a missing fetch otherwise reads as a false non-ancestor refusal.
    try {
      execGitFileSyncWithRetry(["cat-file", "-e", `${reviewedHeadSha}^{commit}`], { cwd: repoRoot });
    } catch {
      throw new Error(`reviewed head is not available in this clone (fetch or unshallow first): ${reviewedHeadSha}`);
    }
    try {
      execGitFileSyncWithRetry(["merge-base", "--is-ancestor", reviewedHeadSha, headSha], { cwd: repoRoot });
    } catch {
      throw new Error("recovery requires the reviewed head to be an ancestor of HEAD");
    }
  }
  if (apply && /^(?:(?:main|master|production|integration)$|release\/)/u.test(git(["rev-parse", "--abbrev-ref", "HEAD"]))) {
    throw new Error("repair cannot write on a protected branch");
  }
  const readWorking = relativePath => {
    const target = path.join(repoRoot, relativePath);
    return readNoFollowFile({ root: repoRoot, parent: path.dirname(target), target }).bytes;
  };
  const decode = bytes => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const readTree = relativePath => {
    const entry = git(["ls-tree", reviewedHeadSha, "--", relativePath]);
    if (!entry) return null;
    if (!/^100(?:644|755) blob [0-9a-f]{40}\t/u.test(entry)) throw new Error(`reviewed carrier is not a regular blob: ${relativePath}`);
    return execGitFileSyncWithRetry(["show", `${reviewedHeadSha}:${relativePath}`], { cwd: repoRoot });
  };
  const activeSpecs = `openspec/changes/${changeId}/specs/`;
  const sourcePaths = git(["ls-tree", "-r", "--name-only", reviewedHeadSha, "--", activeSpecs]).split("\n").filter(p => p.endsWith("/spec.md"));
  // Recovery can be handed an ancestor that predates the change folder, which would
  // enumerate nothing and report a clean "checked: []" while verifying zero deltas.
  // Cross-check the archive side so a wrong SHA fails closed instead of reading green.
  const archivedSpecsRoot = path.join(repoRoot, archiveRoot, "specs");
  const archivedCapabilities = existsSync(archivedSpecsRoot)
    ? readdirSync(archivedSpecsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(path.join(archivedSpecsRoot, entry.name, "spec.md")))
      .map(entry => entry.name)
    : [];
  for (const capability of archivedCapabilities) {
    if (!sourcePaths.includes(`${activeSpecs}${capability}/spec.md`)) {
      throw new Error(`archived delta has no reviewed counterpart at the reviewed head: ${archiveRoot}/specs/${capability}/spec.md`);
    }
  }
  const plans = [];
  for (const deltaPath of sourcePaths) {
    const capability = deltaPath.slice(activeSpecs.length, -"/spec.md".length);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(capability)) throw new Error(`invalid delta capability: ${deltaPath}`);
    const reviewedDelta = readTree(deltaPath);
    const archivedDeltaPath = `${archiveRoot}/specs/${capability}/spec.md`;
    const archivedBytes = readWorking(archivedDeltaPath);
    if (!reviewedDelta.equals(archivedBytes)) {
      // Compare what Git would store, allowing checkout-only EOL conversion
      // while still refusing content edits before any canonical write.
      const cleaned = execGitFileSyncWithRetry(["hash-object", `--path=${archivedDeltaPath}`, "--stdin"], { cwd: repoRoot, input: archivedBytes, encoding: "utf8" }).trim();
      if (cleaned !== git(["rev-parse", `${reviewedHeadSha}:${deltaPath}`])) {
        throw new Error(`archived delta differs from reviewed bytes after Git clean normalization: ${archivedDeltaPath}`);
      }
    }
    const canonicalPath = `openspec/specs/${capability}/spec.md`;
    const before = readTree(canonicalPath);
    const original = readWorking(canonicalPath);
    const plan = planArchiveDeltaBodyRepair({
      deltaText: decode(reviewedDelta), preCanonicalText: before === null ? "" : decode(before),
      postCanonicalText: decode(original), label: canonicalPath,
    });
    plans.push({ path: canonicalPath, original, ...plan });
  }
  // Finish every content check before writing the first capability.
  if (apply) {
    for (const plan of plans) {
      if (!readWorking(plan.path).equals(plan.original)) throw new Error(`canonical changed during preview: ${plan.path}`);
    }
    for (const plan of plans.filter(plan => plan.repairs.length > 0)) {
      writeFileSync(path.join(repoRoot, plan.path), plan.text);
    }
  }
  return {
    applied: apply,
    repairs: plans.flatMap(plan => plan.repairs.map(repair => ({ path: plan.path, ...repair }))),
    checked: plans.map(plan => plan.path),
  };
}

function main(argv) {
  const usage = "Usage: repair-archive-delta-bodies.mjs --change <name> --reviewed-head <SHA> --archive-root openspec/changes/archive/<date>-<name> [--recovery-archive-after-merge] [--apply]";
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apply") {
      if (options.apply) throw new Error("duplicate --apply");
      options.apply = true;
      continue;
    }
    if (argv[i] === "--recovery-archive-after-merge") {
      if (options.recoveryAfterMerge) throw new Error("duplicate --recovery-archive-after-merge");
      options.recoveryAfterMerge = true;
      continue;
    }
    const key = { "--change": "changeId", "--reviewed-head": "reviewedHeadSha", "--archive-root": "archiveRoot" }[argv[i]];
    if (!key || options[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith("--")) {
      throw new Error(usage);
    }
    options[key] = argv[++i];
  }
  if (!["changeId", "reviewedHeadSha", "archiveRoot"].every(key => options[key])) {
    throw new Error(usage);
  }
  options.repoRoot = execGitFileSyncWithRetry(["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  console.log(JSON.stringify(repairArchiveDeltaBodies(options)));
}

if (isDirectCliInvocation(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
