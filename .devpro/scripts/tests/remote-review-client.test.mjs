import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  DEFAULT_BRIDGE_COMMAND,
  RemoteReviewError,
  checkGatewayAlias,
  fetchRemoteReview,
  freezeCommitTarget,
  purgeRemoteReview,
  recordPath,
  remoteReviewStatus,
  sshBridgeTransport,
  submitRemoteReview,
} from "../lib/remote-review-client.mjs";
import { runRemoteReviewCli } from "../run-remote-review.mjs";

// Real Git in throwaway repositories; the bridge is an in-memory fake that follows the contract
// in devpro-hermes-plugins/README.md. No ssh, no network, no Hermes.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(repo, name, text) {
  writeFileSync(path.join(repo, name), text, "utf8");
  git(repo, "add", name);
  git(repo, "commit", "-q", "-m", `add ${name}`);
  return git(repo, "rev-parse", "HEAD");
}

function makeWorld() {
  const root = mkdtempSync(path.join(tmpdir(), "remote-review-client-"));
  const origin = path.join(root, "origin.git");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: GIT_ENV });
  const dev = path.join(root, "dev");
  mkdirSync(dev);
  git(dev, "init", "-q", "-b", "main");
  git(dev, "remote", "add", "origin", origin);
  const base = commit(dev, "README.md", "seed\n");
  git(dev, "push", "-q", "-u", "origin", "main");
  const state = path.join(root, "state");
  const bundles = path.join(root, "bundles");
  return { root, origin, dev, base, state, bundles, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const withinCeiling = (id) => ({ finding_id: id, guarantee_ceiling: "cooperative review; mechanical shape checks", classification: "within-ceiling", rationale: "bounded by the review ceiling" });

function goodReport(head, requestId) {
  return "## 六軸審查\n\n## 總判定\n**finished**\n\n## Guarantee Assessment\n```json\n"
    + JSON.stringify({ schema: "devpro.review-guarantee-assessment/v1", reviewed_target: head, dispatch_id: requestId, assessments: [] })
    + "\n```\n";
}

/** In-memory bridge: records what it was given and answers like review_bridge.py would. */
function fakeBridge(world, { onCall } = {}) {
  const calls = [];
  const uploads = {};
  const requests = {};
  const bridge = {
    calls, uploads, requests,
    uploadBundle(localPath, requestId) {
      onCall?.("upload", requestId);
      uploads[requestId] = readFileSync(localPath);
      calls.push(["upload", requestId]);
    },
    callBridge(subcommand, { requestId, stdinBytes } = {}) {
      calls.push([subcommand, requestId]);
      onCall?.(subcommand, requestId);
      if (subcommand === "submit") {
        const text = stdinBytes.toString("utf8");
        // One JSON document on one line, newline-terminated: the bridge reads to the newline, not to end-of-input.
        assert.ok(text.endsWith("\n") && text.indexOf("\n") === text.length - 1, "submit stdin must be exactly one newline-terminated line");
        const request = JSON.parse(text);
        requests[request.request_id] = request;
        return { ok: true, payload: { request_id: request.request_id, run_id: "run_0001", bridge_state: "submitted", ...(bridge.creatorRef === undefined ? {} : { creator_ref: bridge.creatorRef }) } };
      }
      const request = requests[requestId];
      if (!request) return { ok: false, error: { code: "unknown_request", message: "no such request" } };
      if (subcommand === "status") return { ok: true, payload: { request_id: requestId, overall: "running" } };
      if (subcommand === "cancel") return { ok: true, payload: { request_id: requestId, cancel: "requested" } };
      if (subcommand === "purge") return { ok: true, payload: { request_id: requestId, purged: true } };
      const report = Buffer.from(bridge.reportFor?.(request) ?? goodReport(request.target.head, requestId), "utf8");
      return {
        ok: true,
        payload: {
          request_id: requestId,
          status: "succeeded",
          result: {
            request_id: requestId, repo_id: request.repo_id, role: request.role, mode: request.mode, target: request.target,
            reviewer: { cli: "opencode", version: "1.18.31", session_id: "ses_fake0001", provider_id: "deepseek", model_id: "deepseek-v4-pro" },
            files: { "report.md": { sha256: sha256(report), bytes: report.length } },
          },
          files: { "report.md": { sha256: sha256(report), bytes: report.length, base64: report.toString("base64") } },
        },
      };
    },
  };
  return bridge;
}

const baseArgs = (world, extra = {}) => ({
  repoRoot: world.dev, repoId: "demo-repo", role: "dp-reviewer", mode: "ordinary-primary",
  base: world.base, head: "HEAD", requestId: "rr-0123456789abcdef", stateDir: world.state, bundleDir: world.bundles, ...extra,
});

test("a pushed head is submitted without a bundle, after the local record exists", () => {
  const world = makeWorld();
  try {
    const head = commit(world.dev, "a.txt", "a\n");
    git(world.dev, "push", "-q", "origin", "main");
    const bridge = fakeBridge(world, {
      onCall(sub) {
        if (sub === "submit") {
          const record = JSON.parse(readFileSync(recordPath(world.state, "rr-0123456789abcdef"), "utf8"));
          assert.equal(record.submitted, false, "the binding is persisted before anything leaves this machine");
        }
      },
    });
    const out = submitRemoteReview({ ...baseArgs(world), transport: bridge });
    assert.deepEqual(out, { request_id: "rr-0123456789abcdef", run_id: "run_0001", bridge_state: "submitted", creator_ref: null, bundled: false });
    const request = bridge.requests["rr-0123456789abcdef"];
    assert.deepEqual(request.target, { kind: "commits", base: world.base, head });
    assert.deepEqual(request.repo_binding.root_commits, [world.base]);
    assert.equal(request.bundle, null);
    assert.deepEqual(bridge.calls, [["submit", undefined]]);
    const record = JSON.parse(readFileSync(recordPath(world.state, "rr-0123456789abcdef"), "utf8"));
    assert.equal(record.submitted, true);
    assert.equal(record.local_head, head);
  } finally { world.cleanup(); }
});

test("an unpushed head travels as a digest-checked bundle that a clone of origin can import", () => {
  const world = makeWorld();
  try {
    const head = commit(world.dev, "local-only.txt", "local\n");
    const bridge = fakeBridge(world, {
      onCall(sub) {
        if (sub === "upload") assert.ok(existsSync(recordPath(world.state, "rr-0123456789abcdef")), "the record is written before the bundle leaves");
      },
    });
    const out = submitRemoteReview({ ...baseArgs(world), transport: bridge });
    assert.equal(out.bundled, true);
    const request = bridge.requests["rr-0123456789abcdef"];
    const uploaded = bridge.uploads["rr-0123456789abcdef"];
    assert.equal(request.bundle.sha256, sha256(uploaded));
    assert.equal(request.bundle.bytes, uploaded.length);
    assert.equal(request.bundle.ref, "HEAD");
    assert.deepEqual(bridge.calls.map(([name]) => name), ["upload", "submit"], "upload happens before the bridge is asked to run");

    const server = path.join(world.root, "server");
    spawnSync("git", ["clone", "-q", world.origin, server], { env: GIT_ENV });
    const bundleFile = path.join(world.root, "uploaded.bundle");
    writeFileSync(bundleFile, uploaded);
    git(server, "bundle", "verify", bundleFile);
    git(server, "fetch", "-q", bundleFile, `${request.bundle.ref}:refs/devpro-review/test/head`);
    assert.equal(git(server, "rev-parse", "refs/devpro-review/test/head"), head);
    assert.deepEqual(readdirSync(world.bundles), [], "the local bundle copy is removed after submission");
    assert.equal(git(world.dev, "for-each-ref", "refs/devpro-review"), "", "no ref is written in the developer's repository");
  } finally { world.cleanup(); }
});

// A shallow clone lists its cut-off commits as roots (`rev-list --max-parents=0`) even though
// their commit objects still name parents; only commits that really have no parent are roots.
function shallowCloneOfTwoRootHistory(world, depth) {
  const full = path.join(world.root, "full");
  mkdirSync(full);
  git(full, "init", "-q", "-b", "main");
  commit(full, "a.txt", "1\n");
  commit(full, "b.txt", "2\n");
  git(full, "checkout", "-q", "--orphan", "other");
  git(full, "rm", "-rfq", ".");
  const secondRoot = commit(full, "o.txt", "o\n");
  git(full, "checkout", "-q", "main");
  git(full, "merge", "-q", "--allow-unrelated-histories", "-m", "merge", "other");
  commit(full, "c.txt", "4\n");
  const shallow = path.join(world.root, "shallow");
  mkdirSync(shallow);
  git(shallow, "init", "-q", "-b", "main");
  git(shallow, "fetch", "-q", "--depth", String(depth), `file://${full}`, "main");
  git(shallow, "checkout", "-q", "FETCH_HEAD");
  return { shallow, secondRoot };
}

test("in a shallow clone only commits that really have no parent count as repository roots", () => {
  const world = makeWorld();
  try {
    const { shallow, secondRoot } = shallowCloneOfTwoRootHistory(world, 3);
    assert.equal(git(shallow, "rev-parse", "--is-shallow-repository"), "true");
    assert.equal(git(shallow, "rev-list", "--max-parents=0", "HEAD").split("\n").length, 2, "git itself reports the cut-off commit as a root too");
    const frozen = freezeCommitTarget({ repoRoot: shallow, base: "HEAD", head: "HEAD" });
    assert.deepEqual(frozen.rootCommits, [secondRoot]);
  } finally { world.cleanup(); }
});

test("a clone too shallow to show any real root cannot establish the repository binding", () => {
  const world = makeWorld();
  try {
    const { shallow } = shallowCloneOfTwoRootHistory(world, 1);
    assert.throws(() => freezeCommitTarget({ repoRoot: shallow, base: "HEAD", head: "HEAD" }),
      (error) => error instanceof RemoteReviewError && error.code === "target_unresolved" && /shallow/u.test(error.detail));
  } finally { world.cleanup(); }
});

test("tracked changes are not-ready (nothing stashed or sent); untracked files are not part of the review", () => {
  const world = makeWorld();
  try {
    writeFileSync(path.join(world.dev, "README.md"), "edited\n", "utf8");
    const bridge = fakeBridge(world);
    assert.throws(() => submitRemoteReview({ ...baseArgs(world), transport: bridge }),
      (error) => error instanceof RemoteReviewError && error.code === "target_dirty");
    assert.deepEqual(bridge.calls, []);
    assert.ok(!existsSync(recordPath(world.state, "rr-0123456789abcdef")));
    assert.equal(git(world.dev, "stash", "list"), "");
    assert.equal(readFileSync(path.join(world.dev, "README.md"), "utf8"), "edited\n", "the edit is untouched");

    git(world.dev, "checkout", "--", "README.md");
    writeFileSync(path.join(world.dev, "scratch.txt"), "x\n", "utf8");
    commit(world.dev, "b.txt", "b\n");
    git(world.dev, "push", "-q", "origin", "main");
    assert.equal(submitRemoteReview({ ...baseArgs(world), transport: bridge }).bundled, false);
  } finally { world.cleanup(); }
});

test("pr-sticky and unsupported role/mode pairs are refused before any git or transport work", () => {
  const world = makeWorld();
  try {
    const bridge = fakeBridge(world);
    for (const [role, mode] of [["dp-second-reviewer", "pr-sticky"], ["dp-reviewer", "audit-only"], ["dp-second-reviewer", "ordinary-primary"], ["hermes", "audit-only"]]) {
      assert.throws(() => submitRemoteReview({ ...baseArgs(world, { role, mode }), transport: bridge }),
        (error) => error.code === "mode_not_supported_remote" && (mode !== "pr-sticky" || /sticky/u.test(error.detail)), `${role}/${mode}`);
    }
    assert.deepEqual(bridge.calls, []);
    assert.deepEqual(existsSync(world.bundles) ? readdirSync(world.bundles) : [], []);
  } finally { world.cleanup(); }
});

test("an unpushed head that is neither the checkout nor a branch tip cannot be bundled", () => {
  const world = makeWorld();
  try {
    const first = commit(world.dev, "one.txt", "1\n");
    commit(world.dev, "two.txt", "2\n");
    assert.throws(() => submitRemoteReview({ ...baseArgs(world, { head: first }), transport: fakeBridge(world) }),
      (error) => error.code === "head_not_bundlable");
  } finally { world.cleanup(); }
});

test("a lost bridge answer is an unknown outcome and keeps the record so status can resolve it", () => {
  const world = makeWorld();
  try {
    commit(world.dev, "a.txt", "a\n");
    git(world.dev, "push", "-q", "origin", "main");
    const bridge = fakeBridge(world);
    const broken = { ...bridge, callBridge() { throw new RemoteReviewError("transport_failed", "lost", { outcome_unknown: true }); } };
    assert.throws(() => submitRemoteReview({ ...baseArgs(world), transport: broken }),
      (error) => error.code === "transport_failed" && error.extra.outcome_unknown === true);
    const record = JSON.parse(readFileSync(recordPath(world.state, "rr-0123456789abcdef"), "utf8"));
    assert.equal(record.submitted, false);
    const working = fakeBridge(world);
    working.requests["rr-0123456789abcdef"] = { request_id: "rr-0123456789abcdef" };
    assert.equal(remoteReviewStatus({ requestId: "rr-0123456789abcdef", stateDir: world.state, transport: working }).overall, "running");
  } finally { world.cleanup(); }
});

test("fetching a result writes the exact report bytes and an unsealed receipt", () => {
  const world = makeWorld();
  try {
    const head = commit(world.dev, "a.txt", "a\n");
    git(world.dev, "push", "-q", "origin", "main");
    const bridge = fakeBridge(world);
    submitRemoteReview({ ...baseArgs(world), transport: bridge });
    const outDir = path.join(world.root, "out");
    const receipt = fetchRemoteReview({ requestId: "rr-0123456789abcdef", repoRoot: world.dev, stateDir: world.state, transport: bridge, outDir });
    assert.equal(receipt.status, "finished");
    assert.equal(receipt.sealed_admission, false);
    assert.equal(receipt.executor, "remote-opencode");
    const reportFile = path.join(outDir, "remote-review-rr-0123456789abcdef.report.md");
    assert.equal(readFileSync(reportFile, "utf8"), goodReport(head, "rr-0123456789abcdef"));
    assert.equal(sha256(readFileSync(reportFile)), receipt.report_sha256);
    const written = JSON.parse(readFileSync(path.join(outDir, "remote-review-rr-0123456789abcdef.receipt.json"), "utf8"));
    assert.equal(written.classification, "remote_review_completed");
  } finally { world.cleanup(); }
});

test("a repository that moved on after submission gets a failed receipt and no report file", () => {
  const world = makeWorld();
  try {
    commit(world.dev, "a.txt", "a\n");
    git(world.dev, "push", "-q", "origin", "main");
    const bridge = fakeBridge(world);
    submitRemoteReview({ ...baseArgs(world), transport: bridge });
    commit(world.dev, "later.txt", "later\n");
    const outDir = path.join(world.root, "out");
    const receipt = fetchRemoteReview({ requestId: "rr-0123456789abcdef", repoRoot: world.dev, stateDir: world.state, transport: bridge, outDir });
    assert.equal(receipt.classification, "remote_target_changed");
    assert.ok(!existsSync(outDir) || readdirSync(outDir).length === 0);
  } finally { world.cleanup(); }
});

// result.json (meta.files) is what binds the returned report to the worker's recording; the client must not
// accept a report that result.json does not name with its digest, nor files it never declared.
test("a result whose manifest does not bind report.md by digest is refused, whatever else it carries", () => {
  const extra = Buffer.from("not declared anywhere\n", "utf8");
  const wrongType = (payload) => { payload.result.files = ["report.md"]; };
  const cases = [
    ["no files manifest", (payload) => { delete payload.result.files; }],
    ["an empty files manifest", (payload) => { payload.result.files = {}; }],
    ["a manifest that omits report.md", (payload) => {
      const declared = payload.result.files["report.md"];
      payload.result.files = { "notes.txt": declared };
      payload.files["notes.txt"] = payload.files["report.md"];
    }],
    ["a manifest entry without a sha256", (payload) => { payload.result.files["report.md"] = { bytes: payload.result.files["report.md"].bytes }; }],
    ["a manifest entry with a malformed sha256", (payload) => { payload.result.files["report.md"].sha256 = "ABC"; }],
    ["a manifest of the wrong type", wrongType],
    ["a returned file the manifest never declared", (payload) => {
      payload.files["extra.txt"] = { sha256: sha256(extra), bytes: extra.length, base64: extra.toString("base64") };
    }],
  ];
  for (const [name, mutate] of cases) {
    const world = makeWorld();
    try {
      commit(world.dev, "a.txt", "a\n");
      git(world.dev, "push", "-q", "origin", "main");
      const bridge = fakeBridge(world);
      submitRemoteReview({ ...baseArgs(world), transport: bridge });
      const tampering = { ...bridge, callBridge(subcommand, args) {
        const answer = bridge.callBridge(subcommand, args);
        if (subcommand === "result") mutate(answer.payload);
        return answer;
      } };
      const outDir = path.join(world.root, "out");
      const receipt = fetchRemoteReview({ requestId: "rr-0123456789abcdef", repoRoot: world.dev, stateDir: world.state, transport: tampering, outDir });
      assert.equal(receipt.status, "failed", name);
      assert.equal(receipt.classification, "remote_result_invalid", name);
      assert.ok(!existsSync(outDir) || readdirSync(outDir).length === 0, `${name}: no report may be written`);
    } finally { world.cleanup(); }
  }
});

test("reusing a request id never overwrites the record of an earlier request; an identical retry of an unaccepted one is fine", () => {
  const world = makeWorld();
  try {
    commit(world.dev, "a.txt", "a\n");
    git(world.dev, "push", "-q", "origin", "main");
    const bridge = fakeBridge(world);
    submitRemoteReview({ ...baseArgs(world, { scope: "original scope" }), transport: bridge });
    const before = readFileSync(recordPath(world.state, "rr-0123456789abcdef"), "utf8");
    const callsBefore = bridge.calls.length;

    // a different request under the same id, and even the same one once accepted, is refused before anything is written or sent
    for (const scope of ["a different scope", "original scope"]) {
      assert.throws(() => submitRemoteReview({ ...baseArgs(world, { scope }), transport: bridge }), (error) => error.code === "request_id_in_use", scope);
    }
    assert.equal(readFileSync(recordPath(world.state, "rr-0123456789abcdef"), "utf8"), before, "the accepted record is untouched");
    assert.equal(bridge.calls.length, callsBefore, "nothing was sent");

    // the earlier result still verifies against the earlier request
    const receipt = fetchRemoteReview({ requestId: "rr-0123456789abcdef", repoRoot: world.dev, stateDir: world.state, transport: bridge });
    assert.equal(receipt.status, "finished");
  } finally { world.cleanup(); }

  const lost = makeWorld();
  try {
    commit(lost.dev, "a.txt", "a\n");
    git(lost.dev, "push", "-q", "origin", "main");
    const broken = { ...fakeBridge(lost), callBridge() { throw new RemoteReviewError("transport_failed", "lost", { outcome_unknown: true }); } };
    assert.throws(() => submitRemoteReview({ ...baseArgs(lost, { scope: "s" }), transport: broken }), (error) => error.code === "transport_failed");
    const unaccepted = readFileSync(recordPath(lost.state, "rr-0123456789abcdef"), "utf8");
    // a different request must not replace the unaccepted one either (the lost answer may have been accepted)
    assert.throws(() => submitRemoteReview({ ...baseArgs(lost, { scope: "other" }), transport: fakeBridge(lost) }), (error) => error.code === "request_id_in_use");
    assert.equal(readFileSync(recordPath(lost.state, "rr-0123456789abcdef"), "utf8"), unaccepted);
    // the identical request can be sent again
    const retry = submitRemoteReview({ ...baseArgs(lost, { scope: "s" }), transport: fakeBridge(lost) });
    assert.equal(retry.request_id, "rr-0123456789abcdef");
  } finally { lost.cleanup(); }
});

test("a record another process creates between the check and the write is never replaced", () => {
  // `now` runs after the "no record yet" check and before the record is written, so it stands in for a second
  // process that wins that window: the loser must not overwrite the winner's binding, and must send nothing.
  for (const rival of ["a different request", "an identical request"]) {
    const world = makeWorld();
    try {
      commit(world.dev, "a.txt", "a\n");
      git(world.dev, "push", "-q", "origin", "main");
      const bridge = fakeBridge(world);
      const file = recordPath(world.state, "rr-0123456789abcdef");
      const winner = `${JSON.stringify({ schema: 1, request_id: "rr-0123456789abcdef", rival, request_sha256: "b".repeat(64), submitted: false })}\n`;
      const racing = () => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, winner); return 1; };
      assert.throws(() => submitRemoteReview({ ...baseArgs(world), transport: bridge, now: racing }), (error) => error.code === "request_id_in_use", rival);
      assert.equal(readFileSync(file, "utf8"), winner, "the winner's record is untouched");
      assert.deepEqual(bridge.calls, [], "nothing was sent");
      assert.deepEqual(readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp")), [], "no temp file is left behind");
    } finally { world.cleanup(); }
  }
});

test("a rejected competing submission leaves the winner's bundle alone", () => {
  // The rival runs while the winner is uploading: it is refused (the id is taken), and the files it made for its own
  // attempt must not be the winner's file, or its cleanup would delete the upload out from under the winner.
  const world = makeWorld();
  try {
    commit(world.dev, "local-only.txt", "local\n");
    let rivalError = null;
    const bridge = fakeBridge(world, {
      onCall(sub) {
        if (sub !== "upload" || rivalError !== null) return;
        try {
          submitRemoteReview({ ...baseArgs(world, { scope: "a rival scope" }), transport: fakeBridge(world) });
        } catch (error) { rivalError = error; }
      },
    });
    const out = submitRemoteReview({ ...baseArgs(world), transport: bridge });
    assert.equal(rivalError?.code, "request_id_in_use", "the rival was refused");
    assert.equal(out.bundled, true, "the winner's submission went through");
    const request = bridge.requests["rr-0123456789abcdef"];
    assert.equal(request.bundle.sha256, sha256(bridge.uploads["rr-0123456789abcdef"]), "the winner uploaded the bundle its request describes");
    assert.deepEqual(readdirSync(world.bundles), [], "every attempt cleans up only what it made, and nothing is left");
  } finally { world.cleanup(); }
});

test("a prose PASS from the remote side is not a result: the report must satisfy the existing readers", () => {
  const world = makeWorld();
  try {
    commit(world.dev, "a.txt", "a\n");
    git(world.dev, "push", "-q", "origin", "main");
    const bridge = fakeBridge(world);
    bridge.reportFor = () => "Hermes says: PASS, ship it.\n";
    submitRemoteReview({ ...baseArgs(world), transport: bridge });
    const receipt = fetchRemoteReview({ requestId: "rr-0123456789abcdef", repoRoot: world.dev, stateDir: world.state, transport: bridge });
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.classification, "remote_report_contract_invalid");
  } finally { world.cleanup(); }
});

test("without the local record nothing about a remote answer can be trusted", () => {
  const world = makeWorld();
  try {
    const bridge = fakeBridge(world);
    for (const call of [
      () => remoteReviewStatus({ requestId: "rr-0123456789abcdef", stateDir: world.state, transport: bridge }),
      () => fetchRemoteReview({ requestId: "rr-0123456789abcdef", repoRoot: world.dev, stateDir: world.state, transport: bridge }),
    ]) {
      assert.throws(call, (error) => error.code === "local_record_missing");
    }
    assert.deepEqual(bridge.calls, []);
  } finally { world.cleanup(); }
});

test("a remote refusal surfaces its stable code; purge also drops the local record", () => {
  const world = makeWorld();
  try {
    commit(world.dev, "a.txt", "a\n");
    git(world.dev, "push", "-q", "origin", "main");
    const bridge = fakeBridge(world);
    submitRemoteReview({ ...baseArgs(world), transport: bridge });
    const refusing = { callBridge: () => ({ ok: false, error: { code: "not_purgeable", message: "still running" } }) };
    assert.throws(() => purgeRemoteReview({ requestId: "rr-0123456789abcdef", stateDir: world.state, transport: refusing }),
      (error) => error.code === "remote_refused" && error.extra.remote_code === "not_purgeable");
    assert.ok(existsSync(recordPath(world.state, "rr-0123456789abcdef")), "a refused purge keeps the record");
    purgeRemoteReview({ requestId: "rr-0123456789abcdef", stateDir: world.state, transport: bridge });
    assert.ok(!existsSync(recordPath(world.state, "rr-0123456789abcdef")));
  } finally { world.cleanup(); }
});

test("ssh transport: no shell, only the user's alias, a bounded command and the request id", () => {
  const seen = [];
  const runProcess = (file, args, options) => {
    seen.push({ file, args, options });
    return { status: 0, stdout: `${JSON.stringify({ request_id: "rr-0123456789abcdef", ok: 1 })}\n`, stderr: "", error_code: null };
  };
  const transport = sshBridgeTransport({ alias: "devpro-runnerrelay-demo", bridgeCommand: "C:\\bridge\\review-bridge.cmd", stagingRemotePath: "/C:/staging/", runProcess });
  transport.callBridge("status", { requestId: "rr-0123456789abcdef" });
  assert.deepEqual(seen[0].args, ["-T", "-o", "BatchMode=yes", "devpro-runnerrelay-demo", "C:\\bridge\\review-bridge.cmd status rr-0123456789abcdef"]);
  transport.callBridge("submit", { stdinBytes: Buffer.from("{}") });
  assert.deepEqual(seen[1].args, ["-T", "-o", "BatchMode=yes", "devpro-runnerrelay-demo", "hermes review submit"],
    "submit is the Gateway verb: exactly three words, no PTY, and not the configured bridge command");
  assert.equal(seen[1].options.input.toString(), "{}");
  transport.uploadBundle("/tmp/x.bundle", "rr-0123456789abcdef");
  assert.deepEqual(seen[2].args, ["-q", "-o", "BatchMode=yes", "/tmp/x.bundle", "devpro-runnerrelay-demo:/C:/staging/rr-0123456789abcdef.bundle"]);
  assert.ok(seen.every((call) => !JSON.stringify(call).includes("@")), "no account name is ever put on a command line");

  for (const bad of ["cmd & calc", "cmd; rm", "a|b", "$(x)", "", "x\ny"]) {
    assert.throws(() => sshBridgeTransport({ alias: "a", bridgeCommand: bad, runProcess }), (error) => error.code === "not_configured", bad);
  }
  assert.throws(() => transport.callBridge("status", { requestId: "bad id; rm -rf" }), (error) => error.code === "invalid_input");
});

test("ssh transport: without a configured bridge command the server's fixed review-bridge.cmd is used", () => {
  const seen = [];
  const runProcess = (file, args) => {
    seen.push(args);
    return { status: 0, stdout: `${JSON.stringify({ request_id: "rr-0123456789abcdef", overall: "running" })}\n`, stderr: "", error_code: null };
  };
  // Building the transport also proves the default passes the character allowlist that guards every ssh command line.
  const transport = sshBridgeTransport({ alias: "devpro-runnerrelay-demo", runProcess });
  transport.callBridge("status", { requestId: "rr-0123456789abcdef" });
  assert.deepEqual(seen[0], ["-T", "-o", "BatchMode=yes", "devpro-runnerrelay-demo", `${DEFAULT_BRIDGE_COMMAND} status rr-0123456789abcdef`]);
  assert.ok(DEFAULT_BRIDGE_COMMAND.endsWith("\\review-bridge.cmd"), "the default is the fixed wrapper, not an interpreter path");
  assert.ok(!/\\Users\\/iu.test(DEFAULT_BRIDGE_COMMAND), "no per-user path is baked into the client");
  assert.throws(() => sshBridgeTransport({ bridgeCommand: null, runProcess }), (error) => error.code === "not_configured", "an explicit null is not the default");
});

test("ssh transport: transport failure is an unknown outcome; a bridge refusal keeps its code", () => {
  const failing = sshBridgeTransport({ bridgeCommand: "bridge", runProcess: () => ({ status: 255, stdout: "", stderr: "x", error_code: null }) });
  assert.throws(() => failing.callBridge("status", { requestId: "rr-0123456789abcdef" }),
    (error) => error.code === "transport_failed" && error.extra.outcome_unknown === true);
  const refusing = sshBridgeTransport({
    bridgeCommand: "bridge",
    runProcess: () => ({ status: 2, stdout: `${JSON.stringify({ error: { code: "unknown_request", message: "nope" } })}\n`, stderr: "", error_code: null }),
  });
  assert.deepEqual(refusing.callBridge("status", { requestId: "rr-0123456789abcdef" }), { ok: false, error: { code: "unknown_request", message: "nope" } });
  const garbled = sshBridgeTransport({ bridgeCommand: "bridge", runProcess: () => ({ status: 0, stdout: "not json\n", stderr: "", error_code: null }) });
  assert.throws(() => garbled.callBridge("status", { requestId: "rr-0123456789abcdef" }), (error) => error.code === "transport_failed");
});

const gatewayReply = (status, body, stderr = "") => () => ({ status, stdout: `${JSON.stringify(body)}\n`, stderr, error_code: null });
const submitVia = (runProcess) => sshBridgeTransport({ bridgeCommand: "bridge", runProcess }).callBridge("submit", { stdinBytes: Buffer.from("{}\n") });

test("ssh transport: the Gateway's request-id line on stderr is a diagnostic, not part of the result", () => {
  const reply = { request_id: "rr-0123456789abcdef", run_id: "run_0001", bridge_state: "submitted", creator_ref: "31d9f7bc0fad336c" };
  assert.deepEqual(submitVia(gatewayReply(0, reply, "request id: rr-0123456789abcdef\n")), { ok: true, payload: reply });
});

test("ssh transport: a Gateway refusal before anything is committed is a typed refusal with its code", () => {
  for (const [status, code] of [[2, "invalid_input"], [3, "gateway_review_unavailable"], [3, "gateway_authorization_denied"]]) {
    assert.deepEqual(
      submitVia(gatewayReply(status, { error: { code, message: "m" } })),
      { ok: false, error: { code, message: "m" } },
      `${status} ${code}`,
    );
  }
});

test("ssh transport: a Gateway failure that may follow the commit is an unknown outcome that keeps its code", () => {
  for (const status of [4, 5, 6]) {
    assert.throws(
      () => submitVia(gatewayReply(status, { error: { code: "gateway_result_unknown", message: "retry with the same request_id" } })),
      (error) => error.code === "transport_failed" && error.extra.outcome_unknown === true && error.extra.remote_code === "gateway_result_unknown",
      String(status),
    );
  }
  // A code the client cannot trust as a token is not echoed anywhere.
  assert.throws(
    () => submitVia(gatewayReply(5, { error: { code: "x; rm -rf", message: "m" } })),
    (error) => error.code === "transport_failed" && error.extra.outcome_unknown === true && error.extra.remote_code === undefined && !error.message.includes("rm -rf"),
  );
});

test("ssh transport: only submit gets the Gateway's exit classification; the other calls keep theirs", () => {
  const body = { error: { code: "gateway_review_unavailable", message: "m" } };
  const status = sshBridgeTransport({ bridgeCommand: "bridge", runProcess: gatewayReply(3, body) });
  assert.throws(() => status.callBridge("status", { requestId: "rr-0123456789abcdef" }), (error) => error.code === "transport_failed");
});

test("submit carries the Gateway-verified creator_ref into the summary and the local record; null is a normal answer", () => {
  const world = makeWorld();
  try {
    commit(world.dev, "a.txt", "a\n");
    git(world.dev, "push", "-q", "origin", "main");
    const bridge = fakeBridge(world);
    bridge.creatorRef = "31d9f7bc0fad336c";
    const out = submitRemoteReview({ ...baseArgs(world), transport: bridge });
    assert.equal(out.creator_ref, "31d9f7bc0fad336c");
    assert.equal(JSON.parse(readFileSync(recordPath(world.state, "rr-0123456789abcdef"), "utf8")).creator_ref, "31d9f7bc0fad336c");

    const unrecorded = fakeBridge(world);
    unrecorded.creatorRef = null; // a request first created without a proof: the bridge never backfills a creator
    const second = submitRemoteReview({ ...baseArgs(world, { requestId: "rr-0123456789abcd01" }), transport: unrecorded });
    assert.equal(second.creator_ref, null);
    assert.equal(JSON.parse(readFileSync(recordPath(world.state, "rr-0123456789abcd01"), "utf8")).creator_ref, null);
  } finally {
    world.cleanup();
  }
});

test("submit records no creator for anything that is not a 16-hex code, and still succeeds", () => {
  const world = makeWorld();
  try {
    commit(world.dev, "a.txt", "a\n");
    git(world.dev, "push", "-q", "origin", "main");
    let index = 0;
    for (const bad of ["31D9F7BC0FAD336C", "31d9f7bc0fad336", "31d9f7bc0fad336c0", "user", 12, { id: "user" }, ["31d9f7bc0fad336c"]]) {
      const bridge = fakeBridge(world);
      bridge.creatorRef = bad;
      const requestId = `rr-0123456789abc${(index += 1).toString(16).padStart(3, "0")}`;
      const out = submitRemoteReview({ ...baseArgs(world, { requestId }), transport: bridge });
      assert.equal(out.creator_ref, null, JSON.stringify(bad));
      assert.equal(out.run_id, "run_0001");
    }
  } finally {
    world.cleanup();
  }
});

test("gateway alias check: only an alias that points at the gateway and port 20222 passes", () => {
  const answer = (stdout, status = 0) => () => ({ status, stdout, stderr: "", error_code: null });
  checkGatewayAlias({ alias: "devpro-runnerrelay-demo", runProcess: answer("user someone\nhostname demo.devpro.com.tw\nport 20222\n") });
  for (const stdout of ["hostname devpro-runnerrelay-demo\nport 22\n", "hostname demo.devpro.com.tw\nport 22\n", "hostname other.example\nport 20222\n"]) {
    assert.throws(() => checkGatewayAlias({ alias: "devpro-runnerrelay-demo", runProcess: answer(stdout) }),
      (error) => error.code === "gateway_alias_not_configured", stdout);
  }
  assert.throws(() => checkGatewayAlias({ alias: "x", runProcess: answer("", 255) }), (error) => error.code === "gateway_alias_not_configured");
});

test("CLI: configuration, usage and the full submit/result cycle through an injected transport", () => {
  const world = makeWorld();
  try {
    commit(world.dev, "a.txt", "a\n");
    git(world.dev, "push", "-q", "origin", "main");
    const env = { DEVPRO_REMOTE_REVIEW_STATE_DIR: world.state };
    const common = ["--repo-root", world.dev, "--repo-id", "demo-repo", "--role", "dp-reviewer", "--mode", "ordinary-primary", "--base", world.base, "--head", "HEAD", "--request-id", "rr-0123456789abcdef"];
    assert.throws(() => runRemoteReviewCli(["bogus"], { env }), (error) => error.code === "usage");
    assert.throws(() => runRemoteReviewCli(["submit", "--repo-root", "relative/path"], { env }), (error) => error.code === "usage");
    assert.throws(() => runRemoteReviewCli(["submit", ...common, "--head", "HEAD"], { env }), (error) => error.code === "usage", "repeated flags are refused");

    const bridge = fakeBridge(world);
    const submitted = runRemoteReviewCli(["submit", ...common], { env, transport: bridge });
    assert.equal(submitted.run_id, "run_0001");
    assert.equal(runRemoteReviewCli(["status", "--repo-root", world.dev, "--request-id", "rr-0123456789abcdef"], { env, transport: bridge }).overall, "running");
    const outDir = path.join(world.root, "cli-out");
    const receipt = runRemoteReviewCli(["result", "--repo-root", world.dev, "--request-id", "rr-0123456789abcdef", "--out-dir", outDir], { env, transport: bridge });
    assert.equal(receipt.status, "finished");
    assert.ok(existsSync(path.join(outDir, "remote-review-rr-0123456789abcdef.report.md")));
    assert.throws(() => runRemoteReviewCli(["result", "--repo-root", world.dev, "--request-id", "rr-0123456789abcdef"], { env, transport: bridge }),
      (error) => error.code === "usage", "--out-dir is required for result");
  } finally { world.cleanup(); }
});

test("CLI: with nothing configured, submit goes through the Gateway verb and the other four use the server's review-bridge.cmd", () => {
  const world = makeWorld();
  try {
    commit(world.dev, "a.txt", "a\n");
    git(world.dev, "push", "-q", "origin", "main");
    const requestId = "rr-0123456789abcdef";
    const env = { DEVPRO_REMOTE_REVIEW_STATE_DIR: world.state };
    const submit = ["submit", "--repo-root", world.dev, "--repo-id", "demo-repo", "--role", "dp-reviewer", "--mode", "ordinary-primary", "--base", world.base, "--head", "HEAD", "--request-id", requestId];
    const calls = [];
    // No ssh: the alias check and every bridge call are answered here, and the last argument of a bridge call is its remote command.
    const runProcess = (file, args) => {
      calls.push(args);
      if (args[0] === "-G") return { status: 0, stdout: "hostname demo.devpro.com.tw\nport 20222\n", stderr: "", error_code: null };
      return { status: 0, stdout: `${JSON.stringify({ request_id: requestId, run_id: "run_0001", bridge_state: "submitted", overall: "running" })}\n`, stderr: "", error_code: null };
    };
    const remoteCommand = () => calls.at(-1).at(-1);

    assert.equal(runRemoteReviewCli(submit, { env, runProcess }).run_id, "run_0001", "submit needs no bridge command");
    assert.equal(remoteCommand(), "hermes review submit");

    const query = (command, ...extra) => runRemoteReviewCli([command, "--repo-root", world.dev, "--request-id", requestId, ...extra], { env, runProcess });
    assert.equal(query("status").overall, "running");
    assert.equal(remoteCommand(), `${DEFAULT_BRIDGE_COMMAND} status ${requestId}`);
    query("cancel");
    assert.equal(remoteCommand(), `${DEFAULT_BRIDGE_COMMAND} cancel ${requestId}`);
    // This answer carries no result, so the receipt is a failed verification; what matters here is which command was run.
    assert.equal(query("result", "--out-dir", path.join(world.root, "out")).status, "failed");
    assert.equal(remoteCommand(), `${DEFAULT_BRIDGE_COMMAND} result ${requestId}`);

    const override = { ...env, DEVPRO_REMOTE_REVIEW_BRIDGE_COMMAND: "C:\\other\\bridge.cmd" };
    runRemoteReviewCli(["status", "--repo-root", world.dev, "--request-id", requestId], { env: override, runProcess });
    assert.equal(remoteCommand(), `C:\\other\\bridge.cmd status ${requestId}`, "the environment overrides the default");

    const before = calls.length;
    assert.throws(() => runRemoteReviewCli(["status", "--repo-root", world.dev, "--request-id", requestId], { env: { ...env, DEVPRO_REMOTE_REVIEW_BRIDGE_COMMAND: "" }, runProcess }),
      (error) => error.code === "not_configured", "an empty override is refused, not replaced by the default");
    assert.equal(calls.slice(before).filter((args) => args[0] === "-T").length, 0, "nothing is sent to the server on a refusal");

    query("purge");
    assert.equal(remoteCommand(), `${DEFAULT_BRIDGE_COMMAND} purge ${requestId}`);
    assert.ok(!existsSync(recordPath(world.state, requestId)), "purge removes the local record");
  } finally { world.cleanup(); }
});
