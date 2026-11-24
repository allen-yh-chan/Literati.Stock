import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { repoPath } from './lib/repo-root.mjs';
const sessionRecapPath = repoPath('.devpro/agent-rules/session-recap.md');

const content = readFileSync(sessionRecapPath, 'utf8');

// REQUIRED — 鎖新 wording 關鍵 phrase
const REQUIRED = [
  'devpro-tw/devpro-agent-rules',
  '不論 cwd',
  'Recap Discussion 寫入位置',
  '規範改進 Issue 寫入位置',
  'gh issue create --repo devpro-tw/devpro-agent-rules',
  '<cwd-repo-name>',
  'Naming entity 釐清',
  '不同 entity',
  '`.devpro-agent-rules`',  // dot prefix submodule path
  'repository(owner: "devpro-tw", name: "devpro-agent-rules") { discussions(first: 5',  // verification command fixed-target 鎖
];

// FORBIDDEN — 退化字眼（舊 wording 殘留 / 軟化字眼 / 誤指 target）
const FORBIDDEN = [
  '`<repo-name>` 為當前工作的 repo 名稱',  // 舊 wording 殘留
  '視 cwd 決定',
  '視情況決定 repo',
  'submodule path 作為 target',
  'repository(owner: "<owner>"',  // 鎖 owner placeholder 退化（覆蓋 write step + verification step）
  'name: "<repo>"',  // 鎖 repo placeholder 退化（同上）
];

for (const phrase of REQUIRED) {
  test(`session-recap.md 必含 "${phrase}"`, () => {
    assert.ok(
      content.includes(phrase),
      `clarify-recap-issue-source-repo-routing 規則完整性受損：「${phrase}」 missing — Recap/Issue routing 可能被退化或刪除`
    );
  });
}

for (const phrase of FORBIDDEN) {
  test(`session-recap.md 禁含 "${phrase}"`, () => {
    assert.ok(
      !content.includes(phrase),
      `clarify-recap-issue-source-repo-routing 規則退化：「${phrase}」 出現 — wording 退化會破壞 fixed-target 強度`
    );
  });
}
