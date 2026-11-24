import test from 'node:test';
import assert from 'node:assert/strict';
import { readRepoFile as read } from './lib/read.mjs';



// Slice a markdown section starting at an ATX `#`-heading line and ending at the
// next heading of the SAME or SHALLOWER level (level-aware), so an anchor cannot
// false-pass by drifting into a sibling section, nor get truncated by a deeper
// child sub-heading. Lines inside fenced ``` code blocks are NOT treated as
// heading boundaries (a `# comment` inside bash must not end the section).
function section(content, heading) {
  const level = (heading.match(/^#+/) || [''])[0].length;
  assert.ok(level >= 1, `section() requires an ATX heading anchor, got: ${heading}`);
  const lines = content.split('\n');
  const start = lines.findIndex((l) => l === heading || l.startsWith(`${heading} `) || l.trimEnd() === heading);
  assert.ok(start !== -1, `heading not found: ${heading}`);

  let inFence = false;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence) {
      const m = line.match(/^(#{1,6}) /);
      if (m && m[1].length <= level) break; // same or shallower heading => section end
    }
    out.push(line);
  }
  return out.join('\n');
}

// Slice a bold-delimited sub-block: from a `**…**` marker line to the next
// `**…**` marker line, the next ATX heading, or EOF. Used for A1, whose anchor
// is a bold paragraph inside the larger "Worktree 規範" section rather than its
// own heading — scoping to the sub-block prevents over-capturing the unrelated
// 清理 / Verification / rationalization subsections that follow.
function boldBlock(content, boldMarker) {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => l.startsWith(boldMarker));
  assert.ok(start !== -1, `bold marker not found: ${boldMarker}`);
  const out = [lines[start]];
  let inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence) {
      if (/^#{1,6} /.test(line)) break; // next heading
      if (/^\*\*/.test(line) && line !== lines[start]) break; // next bold sub-block
    }
    out.push(line);
  }
  return out.join('\n');
}

const branchRule = read('.devpro/agent-rules/git-branch-naming-and-anchor.md');
const routingRule = read('.devpro/agent-rules/openspec-branch-routing.md');
const reviewer = read('.claude/agents/dp-second-reviewer.md');
const codexAdapter = read('.devpro/agent-rules/platform-adapters/codex.md');
const codexCliTooling = read('.devpro/agent-rules/platform-adapters/codex-cli-tooling.md');
const codexEffort = read('.devpro/agent-rules/platform-adapters/codex-effort-tiers.md');
const evidenceSsot = read('.devpro/agent-rules/pr-review-evidence-verification.md');

// ── A: rebuild worktree / change base must (re)create the change folder ──────

test('A1: rebuild-worktree sub-block requires confirming the OpenSpec change folder', () => {
  // The new rule MUST live in the bold "既有分支但 worktree 不存在" sub-block,
  // not merely somewhere in the file.
  const block = boldBlock(branchRule, '**既有分支但 worktree 不存在**');
  // The rebuild snippet itself prompts an explicit existence check.
  assert.match(block, /ls openspec\/changes\/<change-name>\//);
  // And the prose MUST clause + archive-reuse ban + cross-ref live in the
  // immediately-following bold block.
  const clause = boldBlock(branchRule, '**重建 worktree 後必須確認');
  assert.match(clause, /重建 worktree 後必須確認 `openspec\/changes\/<change-name>\/` 仍存在/);
  assert.match(clause, /會隨原 worktree .*消失/);
  assert.match(clause, /不得復用已 archive 的舊 folder/);
  assert.match(clause, /openspec-branch-routing\.md/);
});

test('A2: routing rule has a dedicated section for rebuild => new independent change folder', () => {
  const sec = section(routingRule, '### 改 base / 重建分支須新建獨立 change folder');
  assert.match(sec, /必須.*新建獨立的 `openspec\/changes\/<name>\/` change folder/);
  assert.match(sec, /會隨原 worktree 移除一併消失/);
  // No archive reuse.
  assert.match(sec, /不得.*復用已 archive 的舊 folder/);
  // Cross-ref back to the rebuild section in the branch-naming rule.
  assert.match(sec, /git-branch-naming-and-anchor\.md/);
});

// ── B: codex exec must close stdin (</dev/null) at every cross-review site ───

test('B: cross-review Codex CLI invocation details live in tooling SSOT and close stdin', () => {
  // devpro:second-review is now a thin projection: it must cite tooling SSOT, not duplicate
  // the full codex exec invocation flags.
  assert.match(reviewer, /platform-adapters\/codex-cli-tooling\.md/);
  assert.match(reviewer, /Codex CLI tooling|codex exec --json/);
  // codex.md keeps hot-path anchors and delegates the canonical recipe to the cold-path CLI tooling leaf.
  assert.match(codexAdapter, /`codex exec --json`/);
  assert.match(codexAdapter, /`-c model_reasoning_effort="xhigh"`/);
  assert.match(codexAdapter, /stdin must be closed with `<\/dev\/null`/);
  assert.match(codexAdapter, /platform-adapters\/codex-cli-tooling\.md/);
  // codex-cli-tooling.md owns the canonical recipe and must keep closed stdin.
  assert.match(codexCliTooling, /DEVPRO_CROSS_MODEL_REVIEWER=1 codex exec --json/);
  assert.match(codexCliTooling, /--output-last-message \/tmp\/codex-review-verdict\.json/);
  assert.match(codexCliTooling, /"<prompt>" <\/dev\/null 2>&1/);
  // codex-effort-tiers.md reference invocation — same: cross-review recipe policy tier (xhigh for codex).
  assert.match(
    codexEffort,
    /codex exec --json -c model_reasoning_effort="xhigh" -C <abs-worktree> "<prompt>" <\/dev\/null/,
  );
  // Rationale must be documented in the prose adapters/tooling (not bare flag).
  assert.match(codexCliTooling, /close stdin to prevent hang/);
  assert.match(codexAdapter, /stdin must be closed with `<\/dev\/null`/);
});

// ── C: reviewer agent must forbid autonomously running tests ─────────────────

test('C: reviewer prohibitions forbid autonomously running the test suite', () => {
  const sec = section(reviewer, '## 禁止事項');
  assert.match(sec, /禁止自主執行測試套件 \/ build/);
  // Must point at the SSOT instead of duplicating the full rule.
  assert.match(sec, /pr-review-evidence-verification\.md/);
  // Must keep the "verify primary evidence, don't re-run" framing.
  assert.match(sec, /核對 primary 的 test evidence/);
});

test('C: the cited SSOT section actually resolves (no dangling cross-reference)', () => {
  // The prohibition cites `§Cross-Model Second Reviewer Evidence Reuse`; that
  // section MUST exist as a real heading in the SSOT, and MUST contain the
  // no-re-run rule the prohibition relies on. This guards against the citation
  // becoming dangling if the SSOT is refactored.
  const prohibitions = section(reviewer, '## 禁止事項');
  assert.match(prohibitions, /§Cross-Model Second Reviewer Evidence Reuse/);
  assert.match(evidenceSsot, /^## Cross-Model Second Reviewer Evidence Reuse$/m);
  const ssotSection = section(evidenceSsot, '## Cross-Model Second Reviewer Evidence Reuse');
  assert.match(ssotSection, /不重跑/); // the no-re-run rule lives here
});

test('C: codex prompt instructs the model not to run tests/builds/shell commands', () => {
  assert.match(codexCliTooling, /DO NOT run any shell commands, tests, or builds/);
  assert.match(codexCliTooling, /review entirely within the prompt context/);
});
