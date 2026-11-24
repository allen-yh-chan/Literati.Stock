import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { repoPath } from './lib/repo-root.mjs';
const aiAutonomyPath = repoPath('.devpro/agent-rules/ai-autonomy.md');
const agentsMdPath = repoPath('AGENTS.md');

const aiAutonomyContent = readFileSync(aiAutonomyPath, 'utf8');
const agentsMdContent = readFileSync(agentsMdPath, 'utf8');

const AI_AUTONOMY_REQUIRED = [
  'session 環境 context',
  '使用者 email',
  '本機絕對路徑',
  '/Users/<name>/',
  'C:\\Users\\', // JS literal 'C:\\Users\\' = runtime string `C:\Users\` — matches markdown source literal `C:\Users\`
  '/home/<name>/',
  'repo artifact',
];

const AI_AUTONOMY_FORBIDDEN = [
  '視情況',
  '可斟酌',
  '非必要時',
  'low-risk 跳過',
];

const AGENTS_MD_REQUIRED = [
  'email/路徑 入 repo',
];

const AGENTS_MD_FORBIDDEN = [
  '視情況',
  '可斟酌',
  '敏感 session context',
  '建議不要',
];

for (const phrase of AI_AUTONOMY_REQUIRED) {
  test(`ai-autonomy.md 必含 "${phrase}"`, () => {
    assert.ok(
      aiAutonomyContent.includes(phrase),
      `ban-session-env-leakage 規則完整性受損：「${phrase}」 missing — Never 條目可能被退化或刪除`
    );
  });
}

for (const phrase of AI_AUTONOMY_FORBIDDEN) {
  test(`ai-autonomy.md 禁含 "${phrase}"`, () => {
    assert.ok(
      !aiAutonomyContent.includes(phrase),
      `ban-session-env-leakage 規則退化：「${phrase}」 出現 — 軟化字眼會破壞 Never 強度`
    );
  });
}

for (const phrase of AGENTS_MD_REQUIRED) {
  test(`AGENTS.md §0 Never 速查 必含 "${phrase}"`, () => {
    assert.ok(
      agentsMdContent.includes(phrase),
      `AGENTS.md §0 Never 速查 失去 ban-session-env-leakage 條目：「${phrase}」 missing`
    );
  });
}

// The Never line's `per` pointer must resolve to a named heading that exists;
// a numbered checklist point drifted once (`preflight-checklist.md` 點 8).
test('ai-autonomy.md session 環境 context 條的 per pointer 指向存在的段落標題', () => {
  const line = aiAutonomyContent.split('\n').find((l) => l.includes('session 環境 context'));
  assert.ok(line, 'ai-autonomy.md: session 環境 context Never 條目 missing');
  // \x60 is a backtick: a literal one inside a regex literal reads as a template start to stripJsCommentSpans.
  const match = line.match(/per \x60([^\x60]+\.md)\x60 §([^）)]+)[）)]/);
  assert.ok(match, `pointer 須為 \`per \`<leaf>.md\` §<段落標題>\`：${line}`);
  const [, leaf, heading] = match;
  const target = readFileSync(repoPath(`.devpro/agent-rules/${leaf}`), 'utf8');
  assert.ok(
    target.split('\n').some((l) => /^#{2,4} /.test(l) && l.replace(/^#+ /, '').trim() === heading.trim()),
    `${leaf} 沒有標題「${heading}」— pointer 失效`
  );
});

for (const phrase of AGENTS_MD_FORBIDDEN) {
  test(`AGENTS.md §0 Never 速查 禁含 "${phrase}"`, () => {
    assert.ok(
      !agentsMdContent.includes(phrase),
      `AGENTS.md §0 速查 ban-session-env-leakage 條目退化：「${phrase}」 出現 — 軟化字眼會破壞 Never 強度`
    );
  });
}
