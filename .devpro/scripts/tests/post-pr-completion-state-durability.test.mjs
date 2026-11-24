import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const stateHelperPath = path.resolve(
  scriptDir,
  "../hooks/lib/post-pr-completion-state.mjs"
);
const source = readFileSync(stateHelperPath, "utf8");
const controlEvidenceSource = readFileSync(path.resolve(
  scriptDir,
  "../hooks/lib/second-review-control-evidence.mjs"
), "utf8");
const capacityLockSource = readFileSync(path.resolve(
  scriptDir,
  "../lib/control-evidence-capacity-lock.mjs"
), "utf8");
const rendererSource = readFileSync(path.resolve(
  scriptDir,
  "../render-second-review-packet.mjs"
), "utf8");

function sourceSection(startAnchor, endAnchor) {
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  assert.notEqual(start, -1, `missing source anchor: ${startAnchor}`);
  assert.notEqual(end, -1, `missing source anchor: ${endAnchor}`);
  return source.slice(start, end);
}

function assertAppearsInOrder(body, fragments) {
  let cursor = 0;
  for (const fragment of fragments) {
    const index = body.indexOf(fragment, cursor);
    assert.notEqual(index, -1, `missing or out-of-order durability step: ${fragment}`);
    cursor = index + fragment.length;
  }
}

test("marker candidate publication fsyncs the file before rename and the directory after rename", () => {
  const durablePublish = sourceSection(
    "function replacePostPrCompletionMarkerDurably(",
    "export async function compareAndSwapPostPrCompletionExpectedDispatch("
  );
  assertAppearsInOrder(durablePublish, [
    "candidateFd = openSync(candidate, \"wx\", 0o600)",
    "writeFileSync(candidateFd, serializedMarker)",
    "fsyncSync(candidateFd)",
    "closeSync(candidateFd)",
    "renameSync(candidate, markerFile)",
    // The directory fsync itself is the cross-platform SSOT in
    // lib/durable-fs.mjs (see directory-fsync-portability.test.mjs); this
    // call site only needs to keep routing through the shared wrapper.
    "fsyncContainingDirectory(markerFile)",
  ]);
});

test("same-head marker CAS uses durable candidate publication", () => {
  const sameHeadCas = sourceSection(
    "export async function compareAndSwapPostPrCompletionExpectedDispatch(",
    "export async function compareAndSwapPostPrCompletionHeadBinding("
  );
  assert.match(
    sameHeadCas,
    /replacePostPrCompletionMarkerDurably\(markerFile, data\)/,
    "same-head CAS must use the durable marker publisher"
  );
});

test("head-advance marker CAS uses durable candidate publication", () => {
  const headAdvanceCas = sourceSection(
    "export async function compareAndSwapPostPrCompletionHeadBinding(",
    "export function markPostPrCompletionReminded("
  );
  assert.match(
    headAdvanceCas,
    /replacePostPrCompletionMarkerDurably\(markerFile, data\)/,
    "head-advance CAS must use the durable marker publisher"
  );
});

test("dispatch reservation durably publishes its new directory before dispatch.json", () => {
  const start = controlEvidenceSource.indexOf("export async function reserveDispatchRecord(");
  const end = controlEvidenceSource.indexOf(
    "export function rollbackUnclaimedDispatchReservation(",
    start
  );
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const reservation = controlEvidenceSource.slice(start, end);
  assertAppearsInOrder(reservation, [
    "const resolvedRoot = ensureDurableDirectory(rootDir, 0o700)",
    "mkdirSync(directory, { mode: 0o700 })",
    "fsyncDirectory(resolvedRoot)",
    "publishImmutable(finalPath, bytes",
  ]);
});

test("renderer durably creates transaction and carrier parent directories", () => {
  assert.match(
    rendererSource,
    /ensureDurableDirectory\(transaction\.control_evidence_root, 0o700\)/
  );
  const start = rendererSource.indexOf("function publishCarrierWithLedger(");
  const end = rendererSource.indexOf("function publishCarriersWithLedger(", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assertAppearsInOrder(rendererSource.slice(start, end), [
    "const directory = path.dirname(entry.path)",
    "ensureDurableDirectory(directory, 0o700, {",
    "trustedParent: canonicalCarrierRoot,",
    "writeRecordedStagingBytes(stagingPath, entry.bytes)",
    "linkSync(stagingPath, entry.path)",
    "fsyncDirectory(directory)",
  ]);
});

test("stale contender cleanup is durable before common transaction finalization", () => {
  const durableUnlink = sourceSection(
    "function unlinkDurably(",
    "function markerLockContenderBlocks("
  );
  assertAppearsInOrder(durableUnlink, [
    "unlinkSync(targetPath)",
    "fsyncContainingDirectory(targetPath)",
  ]);
  const contenderCleanup = sourceSection(
    "function markerLockContenderBlocks(",
    "function hasBlockingMarkerLockContender("
  );
  assertAppearsInOrder(contenderCleanup, [
    "unlinkDurably(lockFile)",
    "if (finalizeRecovery) finalizeRecovery()",
  ]);
});

test("compare-and-swap lock release verifies ownership before durable unlink", () => {
  const release = sourceSection(
    "function releaseMarkerCompareAndSwapLock(",
    "function markerIdentityMatches("
  );
  assertAppearsInOrder(release, [
    "readFileSync(lock.lockFile, \"utf8\")",
    "record.owner_token !== lock.ownerToken",
    "throw new Error",
    "unlinkDurably(lock.lockFile)",
  ]);
});

test("exact marker clear durably unlinks only after the full marker identity matches", () => {
  const clearStart = source.indexOf("export function clearPostPrCompletionMarker(");
  assert.notEqual(clearStart, -1);
  const clear = source.slice(clearStart);
  assertAppearsInOrder(clear, [
    "markerIdentityMatches(data",
    "return false",
    "retireAuthorityAndSubscriptions(markerFile, data)",
    "return true",
  ]);
  const retirement = sourceSection("function retireAuthorityAndSubscriptions(", "function retireExpiredPostPrAuthority(");
  assertAppearsInOrder(retirement, ["renameSync(markerFile, retired)", "fsyncContainingDirectory(markerFile)",
    "renameSync(retired, markerFile)", "unlinkDurably(retired)", "subscriptionMatchesAuthority(record, authority)", "unlinkDurably(file)"]);
  assert.match(
    clear,
    /catch\s*\{\s*return false;\s*\}/,
    "unlink or parent-directory fsync failure must fail closed"
  );
});

test("capacity mutex stale cleanup and release fsync their parent directory after removal", () => {
  const staleRecoveryStart = capacityLockSource.indexOf("function recoverStaleCapacityLock(");
  const staleRecoveryEnd = capacityLockSource.indexOf(
    "function releaseOwnedCapacityLock(",
    staleRecoveryStart
  );
  const releaseStart = staleRecoveryEnd;
  const releaseEnd = capacityLockSource.indexOf(
    "function acquireCapacityLock(",
    releaseStart
  );
  assert.notEqual(staleRecoveryStart, -1);
  assert.notEqual(staleRecoveryEnd, -1);
  assert.notEqual(releaseEnd, -1);
  assertAppearsInOrder(capacityLockSource.slice(staleRecoveryStart, staleRecoveryEnd), [
    "rmdirSync(recoveryPath)",
    "fsyncDirectory(rootDir)",
  ]);
  assertAppearsInOrder(capacityLockSource.slice(releaseStart, releaseEnd), [
    "rmdirSync(releasePath)",
    "fsyncDirectory(rootDir)",
  ]);
});
