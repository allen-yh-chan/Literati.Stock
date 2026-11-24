#!/usr/bin/env node
/**
 * record-regression-head.mjs
 *
 * `/devpro:pre-pr` Step 1: run this immediately after the canonical test suite is
 * green. It records WHICH committed HEAD that green run covered, so
 * `pre-pr-archive-gate.mjs --pre-review` can refuse to dispatch the six-axis
 * reviewer against a tree the suite has never actually seen (R6 / D16), and so
 * the PreToolUse local-test merge gate can require head-bound `fail=0`
 * suite_evidence before `gh pr merge` of a code/rule-carrier PR.
 *
 *     node .devpro/scripts/record-regression-head.mjs --change <name> \
 *       --suite-status pass --suite-fail 0 --suite-digest <64hex>
 *
 * **The sha is derived here, never handed in.** The failure item `## 107.`
 * documents is forgetting, not forging: the suite goes green at HEAD1, Step 2's
 * simplification pass commits to HEAD2, and the reviewer is dispatched against
 * HEAD2 on the strength of HEAD1's run. A receipt frozen at HEAD1 catches that
 * either way — but deriving the sha in the recorder also removes the
 * transcription-error class for the cost of one `git rev-parse`, and leaves the
 * TL with one thing to remember (run the command) instead of two (run it, and
 * copy the right sha into it).
 *
 * `run-test-suite.mjs` deliberately stays untouched (D16): its invocation is
 * `--changed main` / `--tier fast`, which carries no change name, so wiring the
 * write in there would mean a new `--change` flag that the TL must equally
 * remember to pass — a cooperative step wearing a mechanical costume, plus a
 * side effect inside the test runner.
 *
 * Exit 0 only when the receipt was written. Every failure exits 1: unlike the
 * `/devpro:change` startup checkpoint (fail-open, because blocking startup on
 * gitignored local state has no remedy), this receipt has a consumer that fails
 * closed, so a silent failure here just relocates the stop to the gate and
 * throws away the diagnosis on the way.
 */
import { spawnSync } from 'node:child_process';
import { isDirectCliInvocation } from './lib/cli-entry.mjs';
import {
  isValidChangeName,
  normalizeMergeAcceptableSuiteEvidence,
  writeRegressionHeadRecord,
} from './lib/regression-head-record.mjs';

const USAGE =
  'usage: node .devpro/scripts/record-regression-head.mjs --change <name> --suite-status pass --suite-fail 0 --suite-digest <64hex>';

function takeFlag(args, i, longName) {
  const arg = args[i];
  const eq = `--${longName}=`;
  if (arg === `--${longName}`) {
    return { value: args[i + 1] ?? null, next: i + 2, missing: args[i + 1] === undefined };
  }
  if (arg.startsWith(eq)) {
    return { value: arg.slice(eq.length), next: i + 1, missing: false };
  }
  return null;
}

export function parseRecordRegressionHeadArgs(argv) {
  const args = argv.slice(2);
  let change = null;
  let suiteStatus = null;
  let suiteFailRaw = null;
  let suiteDigest = null;
  for (let i = 0; i < args.length; ) {
    const arg = args[i];
    const changeFlag = takeFlag(args, i, 'change');
    if (changeFlag) {
      if (changeFlag.missing || changeFlag.value === null || changeFlag.value === '') {
        return { error: `--change <name> is required` };
      }
      change = changeFlag.value;
      i = changeFlag.next;
      continue;
    }
    const statusFlag = takeFlag(args, i, 'suite-status');
    if (statusFlag) {
      if (statusFlag.missing || statusFlag.value === null || statusFlag.value === '') {
        return { error: `--suite-status pass is required` };
      }
      suiteStatus = statusFlag.value;
      i = statusFlag.next;
      continue;
    }
    const failFlag = takeFlag(args, i, 'suite-fail');
    if (failFlag) {
      if (failFlag.missing || failFlag.value === null || failFlag.value === '') {
        return { error: `--suite-fail 0 is required` };
      }
      suiteFailRaw = failFlag.value;
      i = failFlag.next;
      continue;
    }
    const digestFlag = takeFlag(args, i, 'suite-digest');
    if (digestFlag) {
      if (digestFlag.missing || digestFlag.value === null || digestFlag.value === '') {
        return { error: `--suite-digest <64hex> is required` };
      }
      suiteDigest = digestFlag.value;
      i = digestFlag.next;
      continue;
    }
    return { error: `unrecognized argument: ${arg}` };
  }
  if (change === null || change === '') return { error: `--change <name> is required` };
  if (!isValidChangeName(change)) return { error: `invalid change name: ${JSON.stringify(String(change))}` };
  if (suiteStatus === null) return { error: `--suite-status pass is required` };
  if (suiteFailRaw === null) return { error: `--suite-fail 0 is required` };
  if (suiteDigest === null) return { error: `--suite-digest <64hex> is required` };

  const failParsed = Number(suiteFailRaw);
  const suiteEvidence = {
    status: suiteStatus,
    // Reject non-integer strings (Number("0x0") etc.) — only plain decimal int.
    fail: /^-?\d+$/.test(String(suiteFailRaw)) ? failParsed : suiteFailRaw,
    digest_sha256: suiteDigest,
  };
  const suite = normalizeMergeAcceptableSuiteEvidence(suiteEvidence);
  if (!suite.ok) return { error: suite.reason };

  return { change, suiteEvidence: suite.suite_evidence };
}

function gitOut(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return String(result.stdout ?? '').trim();
}

export function runRecordRegressionHead({ argv = process.argv, cwd = process.cwd() } = {}) {
  const parsed = parseRecordRegressionHeadArgs(argv);
  if (parsed.error) return { ok: false, error: `${parsed.error}\n${USAGE}` };

  const headSha = gitOut(cwd, ['rev-parse', 'HEAD']);
  if (!headSha) {
    return {
      ok: false,
      error:
        `could not resolve the current committed HEAD in ${cwd}.` +
        ` A regression-head receipt names a commit, so there is nothing to record until one exists.`,
    };
  }
  // Diagnosis only — never compared. A detached HEAD reports "HEAD" here, which
  // is a perfectly good receipt: the sha is what the gate checks.
  const branch = gitOut(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);

  const written = writeRegressionHeadRecord({
    cwd,
    change: parsed.change,
    headSha,
    branch,
    suiteEvidence: parsed.suiteEvidence,
  });
  if (written.status !== 'written') {
    return { ok: false, error: `could not write ${written.recordPath}: ${written.reason}` };
  }
  return { ok: true, recordPath: written.recordPath, record: written.record };
}

if (isDirectCliInvocation(import.meta.url)) {
  let result;
  try {
    result = runRecordRegressionHead();
  } catch (error) {
    result = { ok: false, error: error?.message || String(error) };
  }
  if (!result.ok) {
    process.stderr.write(`[record-regression-head] ${result.error}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `[record-regression-head] recorded ${result.record.head_sha} for change "${result.record.change}"\n` +
        `  receipt: ${result.recordPath}\n` +
        `  suite_evidence: status=${result.record.suite_evidence.status} fail=${result.record.suite_evidence.fail} digest=${result.record.suite_evidence.digest_sha256}\n` +
        `  Re-run this command after any further non-bookkeeping commit, or --pre-review / local-test merge gate will refuse.\n`
    );
    process.exitCode = 0;
  }
}
