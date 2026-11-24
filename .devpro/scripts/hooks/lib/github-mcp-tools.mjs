import { normalizeGithubOperation } from './github-operation-policy.mjs';

// Names emitted by the official devpro-work installers and the owner-bound Hermes bridge.
const PREFIX = /^(?:mcp__devpro[-_]work__|devpro[-_]work_|mcp_devpro_)(github_[a-z_]+|git_proxy_ticket)$/;
export function devproGithubToolName(name) { return typeof name === 'string' ? name.match(PREFIX)?.[1] ?? null : null; }
export function githubShellCommand(payload) {
  const command=payload?.tool_input?.command ?? payload?.tool_input?.cmd ?? '';
  return typeof command === 'string' ? command.replace(/\\\r?\n/g,'') : '';
}
export function isGithubWritePayload(payload) {
  const name = payload?.tool_name ?? payload?.toolName ?? '';
  const tool = devproGithubToolName(name);
  if (tool) return normalizeGithubOperation(tool, payload.tool_input ?? payload.arguments).kind !== 'read';
  const command = githubShellCommand(payload);
  // Conservative on shell syntax only in the runner's failure path; ordinary gates
  // still use their existing shell parser and do not execute this classification.
  return /\bgit\b[^\n]*\bpush\b/.test(command) || /\bgh\b[^\n]*(?:\b(?:create|edit|comment|review|merge|close|reopen|delete|upload|run|rerun)\b|\bapi\b[^\n]*(?:--method|-X|--input|--field|--raw-field|-f|-F)\b)/.test(command);
}
export function githubHookDeny(reason) {
  return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}};
}
