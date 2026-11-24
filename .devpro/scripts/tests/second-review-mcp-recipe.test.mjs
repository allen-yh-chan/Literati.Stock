import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalOpenCodeLaunchScope, claudeAllowedTools } from '../second-reviewer-cli-recipe-contract.mjs';

test('an MCP-bound OpenCode dispatch grants the restricted PR-link helper rather than requiring gh',()=>{
  const scope=canonicalOpenCodeLaunchScope({mode:'pr-sticky',linked_issue_context:'issue_read_required',repository_slug:'org/repo',
    neutral_cwd_path:'/tmp/reviewer',github_transport:'mcp-ticket-v1'});
  assert.ok(scope.shell_commands.some(command=>command.includes('read-second-review-pr-links.mjs')));
  assert.ok(!scope.shell_commands.includes('gh pr view'));
});
test('the MCP-bound Claude recipe removes raw gh commands while the legacy recipe keeps its contract',()=>{
  const mcp=claudeAllowedTools('issue_read_required','org/repo',{githubTransport:'mcp-ticket-v1'});
  assert.ok(!mcp.includes('Bash(gh pr view:*)'));
  assert.ok(mcp.includes('read-second-review-pr-links.mjs'));
  const legacy=claudeAllowedTools('issue_read_required','org/repo');
  assert.ok(legacy.includes('Bash(gh pr view:*)'));
});
