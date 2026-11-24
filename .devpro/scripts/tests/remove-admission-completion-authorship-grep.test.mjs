/**
 * remove-admission-completion-authorship: prove SubagentStop completion carriers gone;
 * #2619 no-ticket ordinary fingerprint remains.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { repoPath } from "./lib/repo-root.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function read(rel) {
  return fs.readFileSync(repoPath(rel), "utf8");
}

test("authorship completion hooks and APIs are absent", () => {
  assert.equal(fs.existsSync(path.join(ROOT, ".devpro/scripts/hooks/subagent-start-authorship.mjs")), false);
  assert.equal(fs.existsSync(path.join(ROOT, ".devpro/scripts/hooks/subagent-stop-completion.mjs")), false);
  assert.equal(fs.existsSync(path.join(ROOT, ".devpro/scripts/tests/admission-completion-authorship.test.mjs")), false);
  const manifest = read(".devpro/scripts/test-suite-manifest.mjs");
  assert.equal(manifest.includes("admission-completion-authorship.test.mjs"), false);
  assert.match(manifest, /remove-admission-completion-authorship-grep\.test\.mjs/);
  const settings = read(".claude/settings.json");
  assert.doesNotMatch(settings, /SubagentStart/);
  assert.doesNotMatch(settings, /SubagentStop/);
  assert.doesNotMatch(settings, /subagent-start-authorship/);
  assert.doesNotMatch(settings, /subagent-stop-completion/);
  const admission = read(".devpro/scripts/hooks/lib/admission-record.mjs");
  for (const tok of [
    "writeAdmissionCompletion",
    "readAdmissionCompletion",
    "STOP_CAPABLE_ADMISSION_HOSTS",
    "writeAdmissionAuthorshipPending",
    "writeAdmissionAuthorshipRaw",
    "claude-subagent-stop-live-binding-incomplete",
  ]) {
    assert.equal(admission.includes(tok), false, tok);
  }
  const core = read(".devpro/scripts/lib/review-remediation-evidence-core.mjs");
  assert.equal(core.includes("assertAdmissionCompletionMatches"), false);
  assert.equal(core.includes("admission-completion-missing"), false);
});

test("Executor Kind stays admission-not-authorship cooperative-only", () => {
  const spec = read("openspec/specs/subagent-behavioral-contract/spec.md");
  assert.match(spec, /admission proof, not an authorship proof/);
  assert.doesNotMatch(spec, /claude-subagent-stop-live-binding-incomplete/);
  assert.doesNotMatch(spec, /Stop-Capable Host Requires Completion Authorship Proof/);
  assert.match(spec, /no-ticket-ordinary-all-hosts-v3/);
  assert.match(
    spec,
    /same `\[cooperative-only\]` authorship caveat as a fresh runtime-agent receipt/,
  );
  assert.doesNotMatch(spec, /host-conditional authorship rules as a fresh runtime-agent receipt/);
});
