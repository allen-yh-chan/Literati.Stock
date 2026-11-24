#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { storedOriginIdentity } from "./hooks/lib/git-utils.mjs";
import { clearPostmergeMarkerSnapshot, parsePostmergeMarker, postmergeMarkerKind, postmergeStateDir, readPostmergeMarkerSnapshot } from "./hooks/lib/postmerge-marker.mjs";
import { repoKey } from "./hooks/lib/repo-key.mjs";

const usage = "Usage: node .devpro/scripts/track-postmerge-workflows.mjs --repo github.com/OWNER/REPO (--pr NUMBER | --branch BRANCH)";
const shaPattern = /^(?!0{40}$)[a-f0-9]{40}$/;
const inFlightStatuses = new Set(["queued", "requested", "waiting", "pending", "in_progress"]);
const conclusions = new Set([
  "action_required", "cancelled", "failure", "neutral", "skipped", "stale", "startup_failure", "success", "timed_out",
]);
// The Actions endpoint caps a filtered query at 1,000 results. At the cap
// the pages cannot establish that the response contains every matching run.
const runQueryCap = 1000;

function readTarget(args) {
  if (args.length !== 4) throw new Error(usage);
  const [repoFlag, writtenRepo, selector, value] = args;
  const parts = writtenRepo.split("/");
  const [host, owner, name] = parts;
  const repo = repoFlag === "--repo" && parts.length === 3 && repoKey(host, `${owner}/${name}`);
  if (!repo) throw new Error(usage);
  if (selector === "--pr" && /^[1-9]\d{0,8}$/.test(value)) return { repo, prNumber: Number(value) };
  if (selector === "--branch" && value && !value.startsWith("-") && !/[\s\p{Cc}]/u.test(value)) {
    return { repo, branch: value };
  }
  throw new Error(usage);
}

function markerCandidates(target) {
  const dir = postmergeStateDir();
  let files;
  try { files = readdirSync(dir); }
  catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  let ownRepo;
  const matches = [];
  for (const name of files) {
    if (postmergeMarkerKind(name) !== (target.prNumber ? "merge" : "push")) continue;
    const snapshot = readPostmergeMarkerSnapshot(path.join(dir, name));
    const marker = snapshot && parsePostmergeMarker(snapshot.text, name);
    if (!marker || marker.repoUnknown) continue;
    if (!marker.repo && ownRepo === undefined) {
      const origin = storedOriginIdentity();
      ownRepo = origin ? repoKey(origin.host, origin.slug) : "";
    }
    if ((marker.repo || ownRepo) !== target.repo) continue;
    const selected = target.prNumber
      ? marker.prNumber === String(target.prNumber)
      : (marker.headRefName || marker.branch) === target.branch;
    if (selected) matches.push({ snapshot, marker });
  }
  return matches;
}

function ghGet(endpoint, step, args = []) {
  const result = spawnSync("gh", ["api", "--hostname", "github.com", "--method", "GET", endpoint, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${step} failed. Check GitHub access and retry.`);
  }
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`${step} did not return valid JSON.`); }
}

function matchesApiRepository(fullName, repo) {
  return typeof fullName === "string" && `github.com/${fullName.toLowerCase()}` === repo;
}

function confirmedMerge(target, slug, markers) {
  const pr = ghGet(`repos/${slug}/pulls/${target.prNumber}`, "PR lookup");
  if (pr?.number !== target.prNumber || pr.state !== "closed" || pr.merged !== true ||
      typeof pr.html_url !== "string" || pr.html_url.toLowerCase() !== `https://${target.repo}/pull/${target.prNumber}` ||
      !matchesApiRepository(pr.base?.repo?.full_name, target.repo) ||
      typeof pr.merge_commit_sha !== "string" || !shaPattern.test(pr.merge_commit_sha) ||
      typeof pr.base?.ref !== "string" || !pr.base.ref.trim() ||
      markers.some(({ marker }) => marker.baseRefName && marker.baseRefName !== pr.base.ref)) {
    throw new Error("PR lookup did not verify the selected repository, merged PR and merge commit.");
  }
  return pr.merge_commit_sha;
}

function validRun(run, target, mergeSha) {
  if (!Number.isSafeInteger(run?.id) || run.id <= 0 || !matchesApiRepository(run.repository?.full_name, target.repo)) return false;
  if (typeof run.head_sha !== "string" || !shaPattern.test(run.head_sha) ||
      typeof run.head_branch !== "string" || !run.head_branch ||
      (mergeSha ? run.head_sha !== mergeSha : run.head_branch !== target.branch)) return false;
  if (typeof run.name !== "string" || !run.name.trim() || typeof run.event !== "string" || !run.event.trim() ||
      typeof run.html_url !== "string" || run.html_url.toLowerCase() !== `https://${target.repo}/actions/runs/${run.id}`) return false;
  return run.status === "completed"
    ? conclusions.has(run.conclusion)
    : inFlightStatuses.has(run.status) && run.conclusion === null;
}

function confirmedRuns(target, slug, mergeSha) {
  const filter = mergeSha ? `head_sha=${mergeSha}` : `branch=${target.branch}`;
  const pages = ghGet(`repos/${slug}/actions/runs`, "Workflow lookup", [
    "--paginate", "--slurp", "-f", "per_page=100", "-f", filter,
  ]);
  const total = pages?.[0]?.total_count;
  if (!Array.isArray(pages) || !Number.isSafeInteger(total) || total < 0 || total >= runQueryCap) {
    throw new Error("Workflow lookup did not verify a complete result.");
  }
  const runs = [];
  const seen = new Set();
  for (const page of pages) {
    if (page?.total_count !== total || !Array.isArray(page.workflow_runs)) {
      throw new Error("Workflow lookup did not verify a complete result.");
    }
    for (const run of page.workflow_runs) {
      if (!validRun(run, target, mergeSha) || seen.has(run.id)) {
        throw new Error("Workflow lookup returned an invalid or mismatched run.");
      }
      seen.add(run.id);
      runs.push({
        id: run.id, name: run.name, event: run.event, branch: run.head_branch, headSha: run.head_sha,
        status: run.status, conclusion: run.conclusion, url: run.html_url,
      });
    }
  }
  if (runs.length !== total) throw new Error("Workflow lookup did not verify a complete result.");
  return runs;
}

try {
  const target = readTarget(process.argv.slice(2));
  const slug = target.repo.slice("github.com/".length);
  const markers = markerCandidates(target);
  const mergeSha = target.prNumber ? confirmedMerge(target, slug, markers) : undefined;
  const runs = confirmedRuns(target, slug, mergeSha);
  let cleared = 0;
  for (const { snapshot } of markers) {
    if (clearPostmergeMarkerSnapshot(snapshot)) cleared++;
  }
  process.stdout.write(JSON.stringify({ status: "queried", ...target, mergeSha, runs, cleared }) + "\n");
} catch (error) {
  process.stderr.write(`track-postmerge-workflows: ${error.message}\n`);
  process.exitCode = 1;
}
