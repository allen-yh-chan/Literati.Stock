/**
 * repo-identity.mjs
 *
 * One carrier for one fact: **which governance identity does this repository
 * have — source-maintainer, consumer, or unknown** (design.md D2 of
 * fix-consumer-pre-pr-gates). Extracted verbatim from `pre-pr-archive-gate.mjs`
 * so the archive gate and the consumer-only delta gate answer the same question
 * from one implementation: a second copy is how the "unknown is fail-closed"
 * semantics would drift apart.
 *
 * Boundary with `hooks/lib/repo-state-identity.mjs`: that module answers a
 * LOCATION question (git common-dir / main-checkout root — which checkout does
 * this worktree belong to). This module answers a GOVERNANCE question (which
 * identity class is this repository — is it held to source-maintainer-only
 * obligations). The names are adjacent; the semantics are not. Do not blend
 * their evidence or route one through the other.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export function consumerRootHasPositiveEvidence(repoRoot) {
  const installed = existsSync(path.join(repoRoot, '.devpro-agent-rules', 'AGENTS.md')) &&
    existsSync(path.join(repoRoot, '.devpro-agent-rules', '.devpro', 'scripts', 'sync-agent-rules.mjs'));
  const gitmodulesPath = path.join(repoRoot, '.gitmodules');
  const declared = existsSync(gitmodulesPath) &&
    /^\s*path\s*=\s*\.devpro-agent-rules\s*$/m.test(readFileSync(gitmodulesPath, 'utf8'));
  const generated = existsSync(path.join(repoRoot, '.devpro', 'scripts', 'sync-agent-rules.mjs')) &&
    existsSync(path.join(repoRoot, '.devpro', 'scripts', 'devpro-doctor.mjs'));
  return installed || (declared && generated);
}

export function classifyRepoIdentity(cwdArg) {
  const directConsumerEvidence = consumerRootHasPositiveEvidence(cwdArg);
  const superproject = spawnSync('git', ['-C', cwdArg, 'rev-parse', '--show-superproject-working-tree'], { encoding: 'utf8' });
  if (superproject.error || superproject.status !== 0) return { identity: 'unknown', evidence: 'superproject probe failed' };
  const parent = superproject.stdout.trim();
  let submoduleConsumerEvidence = false;
  if (parent) {
    if (path.resolve(cwdArg) === path.join(path.resolve(parent), '.devpro-agent-rules') && consumerRootHasPositiveEvidence(parent)) {
      submoduleConsumerEvidence = true;
    } else {
      return { identity: 'unknown', evidence: `unrecognized superproject ${parent}` };
    }
  }
  const remote = spawnSync('git', ['-C', cwdArg, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (remote.error || remote.status !== 0) return { identity: 'unknown', evidence: 'origin probe failed' };
  const hasSourceSentinels = existsSync(path.join(cwdArg, '.devpro', 'scripts', 'pre-pr-archive-gate.mjs')) &&
    existsSync(path.join(cwdArg, '.devpro', 'agent-rules', 'rule-audit-playbook.md'));
  const sourceEvidence = /(?:^|[/:])devpro-agent-rules(?:\.git)?\s*$/.test(remote.stdout.trim()) && hasSourceSentinels;
  const consumerEvidence = directConsumerEvidence || submoduleConsumerEvidence;
  // Conflict is only genuine when the SAME checkout shows direct adoption
  // evidence and source evidence. A recognized consumer-owned rules submodule
  // intentionally carries the source origin and maintained-corpus sentinels —
  // that placement is consumer governance, so its source-origin evidence MUST
  // NOT be read as a conflict (merge-gate review C5b).
  if (sourceEvidence && directConsumerEvidence) {
    return { identity: 'unknown', evidence: 'conflicting source and consumer positive evidence' };
  }
  if (consumerEvidence) {
    return {
      identity: 'consumer',
      evidence: submoduleConsumerEvidence ? 'true consumer-owned rules submodule' : 'direct adoption evidence',
    };
  }
  if (sourceEvidence) {
    return { identity: 'source', evidence: 'source origin and maintained-corpus sentinels' };
  }
  return { identity: 'unknown', evidence: 'no positive source/consumer evidence' };
}
