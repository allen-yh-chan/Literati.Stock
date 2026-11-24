/**
 * claude-code-auto-mode-guardrails-grep.test.mjs
 *
 * Alignment guard for the Claude Code adapter §風險 F (auto mode classifier blocks and chained key commands):
 * stop and hand back after a block, run `gh pr merge` / `git push` / the runner as a single Bash call,
 * follow gate messages, fall back to the user's `!` prefix, and name the cooperative-only boundary.
 *
 * Guard strength (rule-anchor-guard-strength.md): polarity-sensitive anchors bind the polarity word and its
 * object on one physical line; the section is sliced up to the next `### ` heading and must be unique; every
 * anchor matches exactly one line; deleting any operative line turns at least one anchor red. The root limit
 * still holds: token presence cannot prove a sentence was not reversed with its tokens kept, so a deliberate
 * semantic reversal is a code-review matter, not something this file can catch.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { sourcePath } from './lib/source-root.mjs';

const adapterPath = '.devpro/agent-rules/platform-adapters/claude-code.md';
const adapter = readFileSync(sourcePath(adapterPath), 'utf8');

const HEADING = '### 風險 F：auto mode 分類器擋下與關鍵指令串接';

/** §風險 F from its heading to the next `### ` heading (exclusive); the heading must exist exactly once. */
function extractRiskF(md) {
  const headings = md.split('\n').filter((line) => line === HEADING);
  assert.equal(headings.length, 1, `${adapterPath}: 「${HEADING}」須恰好出現一次，實際 ${headings.length} 次`);
  const block = md.match(/### 風險 F[\s\S]*?(?=\n### )/);
  assert.ok(block, `${adapterPath}: ### 風險 F 段不存在，或其後沒有下一個 ### 標題`);
  return block[0];
}

const riskF = extractRiskF(adapter);

// Every anchor is a single-line regex; polarity words and their objects sit in the same regex.
const ANCHORS = [
  { name: '觸發：分類器在 PreToolUse 之前、與 repo hook 無關', re: /^- \*\*觸發\*\*：[^\n]*分類器（發生在 PreToolUse 之前，與 repo hook 無關）擋下某個 Bash call/ },
  { name: '觸發：Merge Without Review 實測形狀', re: /^- \*\*觸發\*\*：[^\n]*`gh pr merge` 串在 `cd` 與後續 `gh pr view` 之間被以 `Merge Without Review` 擋下/ },
  { name: '擋下即停手：立即停止同一目標並交回使用者', re: /^- \*\*行為（擋下即停手）\*\*：被分類器擋下後立即停止同一目標並交回使用者，附停下交棒/ },
  { name: '擋下即停手：門檻以官方為準、不寫死', re: /^- \*\*行為（擋下即停手）\*\*：[^\n]*門檻以官方為準、本規範不寫死/ },
  { name: '關鍵指令各自單獨一個 call，不與 cd／pwd／tail 串接', re: /^- \*\*行為（關鍵指令單獨一個 call）\*\*：`gh pr merge`、`git push`、runner（`run-test-suite\.mjs`）這類關鍵指令各自單獨一個 Bash call，不與 `cd`／`pwd`／`\| tail` 或後續查詢串接/ },
  { name: '預檢另開一個 call', re: /^- \*\*行為（關鍵指令單獨一個 call）\*\*：[^\n]*`pwd && git rev-parse` 預檢另開一個 call/ },
  { name: 'gate：body file 先獨立寫入、再以字面絕對路徑執行 gh', re: /^- \*\*行為（照 gate 訊息做）\*\*：[^\n]*body file 先以獨立 call（或 Write 工具）寫入，再以字面絕對路徑執行 `gh`/ },
  { name: 'gate：admission 自由文字欄位寫 repo-relative', re: /^- \*\*行為（照 gate 訊息做）\*\*：[^\n]*`evidence_scope`／`return_and_stop`／`fork_reason`）寫 repo-relative 且去識別的內容/ },
  { name: 'gate：admission-record-unsafe-value 與 execution_root 例外', re: /^- \*\*行為（照 gate 訊息做）\*\*：[^\n]*`admission-record-unsafe-value`（`execution_root` 是例外，必須是絕對路徑）/ },
  { name: 'gate：大量輸出走 capture-command.mjs', re: /^- \*\*行為（照 gate 訊息做）\*\*：[^\n]*預期大量輸出的指令走 `capture-command\.mjs`/ },
  { name: '備援：被擋時停手交回、由使用者以 ! 前綴自行執行', re: /^- \*\*備援\*\*：Ready Response 的「是，授權 AI merge」選項在 auto mode 下可能被分類器擋；被擋時依上述停手交回，由使用者以 `!` 前綴自行執行/ },
  { name: 'Enforcement boundary：cooperative-only、沒有機械 backstop', re: /^- \*\*Enforcement boundary\*\*：`cooperative-only`[^\n]*沒有機械 backstop/ },
  { name: 'Enforcement boundary：擋下不是 hook 或 gate 失敗', re: /^- \*\*Enforcement boundary\*\*：[^\n]*分類器擋下不是 hook 或 gate 失敗，不得記成 hook 缺陷/ },
  { name: '禁止：換寫法重試同一個 merge／push', re: /^- \*\*禁止\*\*：被擋後換寫法重試同一個 merge／push（含拆成多步、改用別的指令繞過）/ },
  { name: '禁止：把一串動作塞進單一 call', re: /^- \*\*禁止\*\*：[^\n]*把一串動作塞進單一 call 以省一次往返/ },
];

function matchingLines(text, re) {
  return text.split('\n').filter((line) => re.test(line));
}

test('§風險 F：每個錨點都命中，且只命中一行', () => {
  for (const { name, re } of ANCHORS) {
    const hits = matchingLines(riskF, re);
    assert.equal(hits.length, 1, `${adapterPath} §風險 F 錨點「${name}」應恰好命中一行，實際 ${hits.length} 行`);
  }
});

test('§風險 F：mutation 審計——刪掉任何一條 operative 行，至少一個錨點轉紅', () => {
  const lines = riskF.split('\n');
  const bullets = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.startsWith('- **'));
  assert.ok(bullets.length >= 7, `§風險 F 預期至少 7 條 bullet，實際 ${bullets.length} 條`);
  for (const { line, index } of bullets) {
    const mutated = lines.filter((_, i) => i !== index).join('\n');
    const turnedRed = ANCHORS.filter(({ re }) => matchingLines(mutated, re).length === 0);
    assert.ok(
      turnedRed.length > 0,
      `${adapterPath} §風險 F 刪掉這一行後所有錨點仍綠，這條 operative 內容沒有被保護：${line.slice(0, 60)}…`,
    );
  }
});

test('§風險 F：極性反轉後（同一行內改成相反意思）對應錨點轉紅', () => {
  const flips = [
    ['立即停止同一目標並交回使用者', '可繼續嘗試同一目標而不必交回使用者'],
    ['各自單獨一個 Bash call', '可串成同一個 Bash call'],
    ['由使用者以 `!` 前綴自行執行', '由 AI 改寫成串接指令重試'],
    ['被擋後換寫法重試同一個 merge／push', '被擋後可換寫法重試同一個 merge／push'],
    ['`cooperative-only`', '`hook-enforced`'],
  ];
  for (const [from, to] of flips) {
    assert.ok(riskF.includes(from), `fixture 前提：§風險 F 應含「${from}」`);
    const mutated = riskF.replace(from, to);
    const turnedRed = ANCHORS.filter(({ re }) => matchingLines(mutated, re).length === 0);
    assert.ok(turnedRed.length > 0, `把「${from}」改成「${to}」後所有錨點仍綠，guard 對這個極性不敏感`);
  }
});

test('Common Rationalizations：授權 AI merge 不能當串接指令的理由', () => {
  const table = adapter.match(/## Common Rationalizations[\s\S]*?(?=\n## )/);
  assert.ok(table, `${adapterPath}: ## Common Rationalizations 段不存在`);
  const rows = table[0].split('\n').filter((line) => line.startsWith('| 「使用者已授權 AI merge'));
  assert.equal(rows.length, 1, `Common Rationalizations 應恰好一列「使用者已授權 AI merge…」，實際 ${rows.length} 列`);
  assert.match(
    rows[0],
    /關鍵指令單獨一個 Bash call；被分類器擋下就停手交回，由使用者以 `!` 前綴自行執行，不換寫法重試（§風險 F）/,
  );
});

test('Exit Criteria：關鍵指令單獨一個 call、被擋即停手', () => {
  const block = adapter.match(/## Exit Criteria[\s\S]*?(?=\n## )/);
  assert.ok(block, `${adapterPath}: ## Exit Criteria 段不存在`);
  const rows = block[0]
    .split('\n')
    .filter((line) => line.startsWith('- `gh pr merge`、`git push`、runner 以單獨一個 Bash call 執行'));
  assert.equal(rows.length, 1, `Exit Criteria 應恰好一條關鍵指令單獨 call 的條目，實際 ${rows.length} 條`);
  assert.match(rows[0], /被 auto mode 分類器擋下時已停手交回，沒有換寫法重試（§風險 F）$/);
});

test('Verification：rg 的 pattern 含風險 F', () => {
  const block = adapter.match(/## Verification[\s\S]*$/);
  assert.ok(block, `${adapterPath}: ## Verification 段不存在`);
  assert.match(block[0], /風險 D\|風險 F\|RuntimeCaps/);
});

test('風險段順序：風險 F 在風險 E 之後、能力真值之前', () => {
  const iE = adapter.indexOf('### 風險 E');
  const iF = adapter.indexOf(HEADING);
  const iCaps = adapter.indexOf('### 能力真值');
  assert.ok(iE !== -1 && iF !== -1 && iCaps !== -1, '風險 E、風險 F、能力真值 三個標題都須存在');
  assert.ok(iE < iF && iF < iCaps, '風險 F 須位於風險 E 之後、能力真值之前');
});
