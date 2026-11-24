import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { sourcePath } from './lib/source-root.mjs';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function readFile(relPath) {
  return readFileSync(sourcePath(relPath), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. git-branch-naming-and-anchor.md — 6 phrase guards (Worktree 規範段)
// ---------------------------------------------------------------------------
const ANCHOR_FILE = '.devpro/agent-rules/git-branch-naming-and-anchor.md';

const ANCHOR_PHRASES = [
  'per change',
  'per branch',
  'git worktree add',
  'git submodule update',
  'git worktree remove',
  '規範統一',
  '子模組指標更新',
];

for (const phrase of ANCHOR_PHRASES) {
  test(`${ANCHOR_FILE} 含 phrase: "${phrase}"`, () => {
    const content = readFile(ANCHOR_FILE);
    assert.ok(
      content.includes(phrase),
      `${ANCHOR_FILE} 未含必要 phrase: "${phrase}"`
    );
  });
}

test(`${ANCHOR_FILE} uses anchor JSON .sha as git base`, () => {
  const content = readFile(ANCHOR_FILE);
  assert.match(content, /jq -r \.sha/);
  assert.match(content, /<anchor-sha>/);
  assert.doesNotMatch(content, /jq -r \.ref/);
});

// ---------------------------------------------------------------------------
// 2. hub git-branch-and-pr-flow.md — redirect pointer to 4 leaves (each ≥1)
// ---------------------------------------------------------------------------
const HUB_FILE = '.devpro/agent-rules/git-branch-and-pr-flow.md';

const LEAF_REFS = [
  'git-branch-naming-and-anchor.md',
  'git-pr-template-and-merge.md',
  'git-workflow-tracking.md',
];

for (const leaf of LEAF_REFS) {
  test(`${HUB_FILE} 含 redirect pointer 至 leaf: "${leaf}"`, () => {
    const content = readFile(HUB_FILE);
    assert.ok(
      content.includes(leaf),
      `${HUB_FILE} 未含指向 leaf "${leaf}" 的 redirect pointer`
    );
  });
}

// ---------------------------------------------------------------------------
// 3. multi-agent-handoff.md — 2 phrase guards (assertOptional pattern)
//    T5 完成後自動生效：當檔案含 anchor "Worktree 粒度" 時執行斷言
// ---------------------------------------------------------------------------
const HANDOFF_FILE = '.devpro/agent-rules/multi-agent-handoff.md';
const HANDOFF_ACTIVATION_ANCHOR = 'Worktree 粒度';

const HANDOFF_PHRASES = [
  'per change',
  '不 per agent',
];

for (const phrase of HANDOFF_PHRASES) {
  test(`${HANDOFF_FILE} 含 phrase: "${phrase}" (assertOptional — T5 完成後生效)`, () => {
    const content = readFile(HANDOFF_FILE);
    if (!content.includes(HANDOFF_ACTIVATION_ANCHOR)) {
      // T5 尚未完成；anchor 不存在，skip assertion
      return;
    }
    assert.ok(
      content.includes(phrase),
      `${HANDOFF_FILE} 含 activation anchor "${HANDOFF_ACTIVATION_ANCHOR}" 但未含必要 phrase: "${phrase}"`
    );
  });
}

// ---------------------------------------------------------------------------
// 4. devpro:change skill body — 1 phrase guard (assertOptional pattern)
//    migrate-skill-architecture-to-dp-prefix：`.claude/commands/dp/change.md`
//    廢除（`/dp:` 冒號入口移除），worktree 建立 recipe SSOT 改落 devpro:change
//    skill body；guard 改指向該 skill（同 assertOptional 慣例，anchor 存在時
//    才斷言）。
// ---------------------------------------------------------------------------
const CHANGE_CMD_FILE = '.devpro/agent-skills/devpro-workflows/change/SKILL.md';
const CHANGE_CMD_ACTIVATION_ANCHOR = 'worktree';

const CHANGE_CMD_PHRASES = [
  'git worktree add',
];

for (const phrase of CHANGE_CMD_PHRASES) {
  test(`${CHANGE_CMD_FILE} 含 phrase: "${phrase}" (assertOptional)`, () => {
    const content = readFile(CHANGE_CMD_FILE);
    if (!content.includes(CHANGE_CMD_ACTIVATION_ANCHOR)) {
      // activation anchor 不存在，skip assertion
      return;
    }
    assert.ok(
      content.includes(phrase),
      `${CHANGE_CMD_FILE} 含 activation anchor "${CHANGE_CMD_ACTIVATION_ANCHOR}" 但未含必要 phrase: "${phrase}"`
    );
  });
}

// ---------------------------------------------------------------------------
// 5. git-branch-naming-and-anchor.md — missing-worktree restore (S6 gap fix)
//    Lock to S6-specific phrases (not the standard 開工序列 段) so deletion fails.
// ---------------------------------------------------------------------------
test("git-branch-naming-and-anchor.md contains missing-worktree restore section", () => {
  const content = readFile(ANCHOR_FILE);
  assert.ok(
    content.includes("worktree 不存在") && content.includes("git fetch origin"),
    "missing-worktree restore section should mention both 'worktree 不存在' and 'git fetch origin' (S6 gap fix)"
  );
});

// ---------------------------------------------------------------------------
// 6. per-change-worktree spec — S6 main-worktree checkout 禁令必須明文
// ---------------------------------------------------------------------------
test("per-change-worktree spec forbids `git checkout` in main worktree", () => {
  const content = readFile('openspec/specs/per-change-worktree/spec.md');
  assert.ok(
    content.includes("MUST NOT") && content.includes("git checkout") && content.includes("main worktree"),
    "spec must contain MUST NOT git checkout <branch> in the main worktree (S6 normative)"
  );
});

// ---------------------------------------------------------------------------
// 7. anti-phrase guard: old path convention `../<repo>-` MUST NOT appear in
//    active rules / specs / skill (D5 path convention reversal)
// ---------------------------------------------------------------------------
const ACTIVE_AREAS = [
  '.devpro/agent-rules/git-branch-and-pr-flow.md',
  '.devpro/agent-rules/git-branch-naming-and-anchor.md',
  '.devpro/agent-rules/git-pr-template-and-merge.md',
  '.devpro/agent-rules/git-workflow-tracking.md',
  '.devpro/agent-rules/multi-agent-handoff.md',
  '.devpro/agent-skills/devpro-workflows/change/SKILL.md',
  'openspec/specs/per-change-worktree/spec.md',
  'openspec/specs/openspec-flow/spec.md',
];

const FORBIDDEN_OLD_PATH = /\.\.\/<repo>-<(branch|change)-name>/;

for (const file of ACTIVE_AREAS) {
  test(`${file} MUST NOT contain old worktree path convention "../<repo>-..."`, () => {
    const content = readFile(file);
    assert.ok(
      !FORBIDDEN_OLD_PATH.test(content),
      `${file} contains forbidden old path "../<repo>-<...-name>" — D5 reversal requires .worktree/<change-name>`
    );
  });
}
