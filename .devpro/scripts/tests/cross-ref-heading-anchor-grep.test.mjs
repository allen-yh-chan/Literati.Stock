/**
 * cross-ref-heading-anchor-grep.test.mjs
 *
 * 分工說明（避免與 cross-ref-section-anchor-grep.test.mjs 重複）：
 *   既有 cross-ref-section-anchor-grep.test.mjs  = Pattern A
 *     `` `file.md`「phrase」 ``（backtick 包裹 filename）+ substring 存在驗證
 *   本檔 cross-ref-heading-anchor-grep.test.mjs  = Pattern B
 *     `見 file.md §heading` / `見 file.md「heading」`（無 backtick，navigational 引用）
 *     + heading **真實存在**驗證（parenthetical-aware prefix-match，見下）
 *
 * Heading 驗證策略：parenthetical-aware prefix-match（非 naive includes）
 *   - `ref === headingText`：完全相等，命中
 *   - `headingText.startsWith(ref)` 且 ref 後緊接括號（含「空白+括號」）：parenthetical gloss 容忍，命中
 *     例：ref=`§Cadence` → `### Cadence（何時開審）` ✓（緊接全形括號）
 *          ref=`§可促進單位` → `## 可促進單位 (Promotable Unit)` ✓（空白+半形括號 gloss）
 *          ref=`§Cad` → 拒絕（偶然 substring，非括號邊界）
 *   - 空白後接「詞」**拒絕**：空白後是 heading 實質延續，ref 應寫完整概念
 *     例：ref=`§body` → `## body file two-step 紀律` 拒絕；ref=`§Foo` → `### Foo bar (x)` 拒絕
 *   - 其他一律拒絕
 *
 * 四層 false-positive 防線：
 *   1. strip fenced code block：移除 ``` ... ``` 區塊，避免 fence 內 bash/grep 範例誤報
 *   2. 限「見」前綴：只匹配字面 `見 ` 開頭，排除 inline prose 引用（如 rule-audit-playbook.md 內 `rule-design-principles.md §6` 這類無「見」前綴的散文提及）
 *   3. slug 限定：filename 限 [a-z][a-z0-9-]+\.md
 *   4. rule-leaf resolve skip：resolve 不到的引用（如 generated proposal.md）skip，不誤報
 *
 * LATENT EDGE — slug uniqueness (by-design, 0 trigger)
 *
 *   Edge 條件：
 *     當 target 檔同時存在 `## Done (Why) When` 與 `## Done` 兩個 heading 時，
 *     navigational ref `§Done` 經 parenthetical-aware prefix-match 容忍
 *     （headingMatchesRef 邏輯：h.startsWith(ref) 且 rest[0]==='('）
 *     會匹配第一個 satisfying heading（依行序），而非精確唯一 slug。
 *     此行為是 prefix-collision 的潛在 false-positive 路徑。
 *
 *   為何 by-design（uniqueness 非 guard scope）：
 *     guard 設計目標是「heading 存在性」驗證，不是「ref 唯一性」驗證。
 *     headingMatchesRef 驗 existence，不保證同 target 無重複 prefix-sharing heading。
 *     收緊為 uniqueness guard 需要跨所有 target headings 去重比對，
 *     屬 guard scope 擴張，需主 agent 決策與 TL 共識，不在本 guard 職責內。
 *
 *   0 current trigger（現有 3 個 navigational ref 皆不命中）：
 *     1. preflight-checklist §Cadence
 *        → target preflight-checklist.md 無多個 "Cadence" prefix-sharing heading，無衝突
 *     2. codex-host-cross-review §Protected-Branch git Write Rule（×2 來源）
 *        → target 無多個 "Protected-Branch git Write Rule" prefix-sharing heading，無衝突
 *     3. code-review-checklist「專案約定測試指令」
 *        → target 無多個 "專案約定測試指令" prefix-sharing heading，無衝突
 *     以上 3 ref 皆不觸發 prefix-collision edge。
 *
 *   兩模型 + TL 停損共識（2026-06-28）：
 *     停損點：guard 維持「existence 容忍括號 gloss」，不升級為「uniqueness 嚴格」。
 *     理由：(1) 0 current trigger，無實際 false-positive；
 *           (2) 收緊需要重構 headingMatchesRef 呼叫鏈，成本 > 當前收益；
 *           (3) 停損共識落地為本 docstring + positive characterization test，
 *               供未來 trigger 時快速定位收緊方向。
 *
 *   未來收緊 trigger：
 *     當某 navigational ref §X 指向 target 同時有 `## X (Gloss)` 與 `## X` 時，
 *     且測試人員確認「應指向唯一 slug 但 guard 未報錯」，
 *     先讀本段再決定是否啟動 slug-uniqueness tightening。
 *     啟動後：新增會先失敗的 uniqueness regression，再補實作與斷言。
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, repoPath } from './lib/repo-root.mjs';

const agentRulesDir = repoPath('.devpro/agent-rules');
const agentRulesAdaptersDir = repoPath('.devpro/agent-rules/platform-adapters');
const dpCommandsDir = repoPath('.claude/commands/dp');

// Pattern B — § 形（容許 § 後有空格）
const PATTERN_B_SECTION_RE = /見\s+([a-z][a-z0-9-]+\.md)\s*§\s*([^，。、）)|\n]+)/g;
// Pattern B — 「」形（無 backtick navigational）
const PATTERN_B_QUOTE_RE = /見\s+([a-z][a-z0-9-]+\.md)「([^」]+)」/g;

/** 移除 fenced code block（```...```），防止 fence 內範例誤報 */
function stripFencedCodeBlocks(content) {
  return content.replace(/```[\s\S]*?```/g, '');
}

/** heading 行去掉 # 前綴，取純文字 */
function headingText(line) {
  return line.replace(/^#{1,6}\s+/, '').trim();
}

/**
 * parenthetical-aware prefix-match：
 *   1. ref === h：完全相等 ✓
 *   2. h.startsWith(ref) 且 ref 後緊接括號 OR 空白+括號（半形/全形）：parenthetical gloss 容忍 ✓
 *      例：ref="Cadence" → "Cadence（何時開審）" ✓（緊接全形括號）
 *           ref="可促進單位" → "可促進單位 (Promotable Unit)" ✓（空白+半形括號）
 *           ref="Cad" → 拒絕（偶然 substring，非括號邊界）
 *   3. 空白後接詞不容忍：ref="body"→"body file..." 拒絕；ref="Foo"→"Foo bar (x)" 拒絕
 *   4. 其他：拒絕
 */
export function headingMatchesRef(line, ref) {
  const h = headingText(line);
  if (h === ref) return true;
  if (h.startsWith(ref)) {
    const rest = h.slice(ref.length);
    // 緊接括號（全形/半形）
    if (rest[0] === '（' || rest[0] === '(') return true;
    // 空白後緊接括號（"stem (Gloss)" 格式），仍拒絕空白後接詞
    if (/^\s+[（(]/.test(rest)) return true;
  }
  return false;
}

/** resolve target file：先 agent-rules/，再 platform-adapters/，再 dp commands/ */
function resolveTarget(filename) {
  const candidates = [
    path.join(agentRulesDir, filename),
    path.join(agentRulesAdaptersDir, filename),
    path.join(dpCommandsDir, filename),
  ];
  for (const p of candidates) {
    try { readFileSync(p); return p; } catch (_) {}
  }
  return null;
}

/** 收集來源檔：agent-rules/（一層）、platform-adapters/（子目錄）、dp commands/ */
function collectSources() {
  const dirs = [agentRulesDir, agentRulesAdaptersDir, dpCommandsDir];
  return dirs.flatMap(dir =>
    existsSync(dir)
      ? readdirSync(dir).filter(f => f.endsWith('.md')).map(f => path.join(dir, f))
      : []
  );
}

/** 從 stripped content 抽出所有 Pattern B 命中 */
function extractPatternBRefs(content) {
  const refs = [];
  const stripped = stripFencedCodeBlocks(content);

  for (const [, filename, heading] of stripped.matchAll(PATTERN_B_SECTION_RE)) {
    refs.push({ filename, heading: heading.trim() });
  }
  for (const [, filename, heading] of stripped.matchAll(PATTERN_B_QUOTE_RE)) {
    refs.push({ filename, heading: heading.trim() });
  }
  return refs;
}

// --- 收集所有 Pattern B 命中（供 sanity count + 動態 test）---
const allMatches = [];

for (const srcPath of collectSources()) {
  const srcBase = path.basename(srcPath);
  const content = readFileSync(srcPath, 'utf8');
  const srcRel = srcPath.replace(REPO_ROOT + '/', '');

  for (const { filename, heading } of extractPatternBRefs(content)) {
    if (filename === srcBase) continue; // skip self-ref

    const targetPath = resolveTarget(filename);
    if (!targetPath) continue; // 防線 4：resolve 不到 → skip（如 generated proposal.md）

    allMatches.push({ srcRel, filename, heading, targetPath });
  }
}

// Sanity：至少要命中 3 個 Pattern B，防 regex 寫錯導致 0 命中假綠（KNOWN GAPS 回歸保護）
test('Pattern B cross-ref count ≥ 3 (sanity: regex not empty)', () => {
  assert.ok(
    allMatches.length >= 3,
    `expected ≥ 3 Pattern B cross-refs but found ${allMatches.length} — regex may be broken`
  );
});

// 動態測試：每個命中驗 heading 真實存在於 target 檔的 heading 行（parenthetical-aware prefix-match）
for (const { srcRel, filename, heading, targetPath } of allMatches) {
  test(`${srcRel} → ${filename} §「${heading}」 — is a heading in target`, () => {
    const targetContent = readFileSync(targetPath, 'utf8');
    const targetLines = targetContent.split('\n');
    const headingLines = targetLines.filter(line => /^#{1,6}\s/.test(line));
    const found = headingLines.some(line => headingMatchesRef(line, heading));
    assert.ok(
      found,
      `"${heading}" is not a heading in ${filename} (from ${srcRel})`
    );
  });
}

// --- negative unit tests for headingMatchesRef（鎖住 hardening）---

// 偶然 substring 必須被拒絕（ref="Cad"，heading 全文="Cadence（何時開審）"）
test('headingMatchesRef: substring-only ref "Cad" is rejected (not parenthetical gloss)', () => {
  assert.equal(
    headingMatchesRef('### Cadence（何時開審）', 'Cad'),
    false,
    'naive-includes would accept "Cad" inside "Cadence（何時開審）", but prefix-match must reject it'
  );
});

// parenthetical gloss 容忍：ref="Cadence"，heading 帶補述括號
test('headingMatchesRef: "Cadence" matches "### Cadence（何時開審）" (parenthetical gloss)', () => {
  assert.equal(
    headingMatchesRef('### Cadence（何時開審）', 'Cadence'),
    true
  );
});

// 完全相等
test('headingMatchesRef: exact match "Protected-Branch git Write Rule"', () => {
  assert.equal(
    headingMatchesRef('### Protected-Branch git Write Rule', 'Protected-Branch git Write Rule'),
    true
  );
});

// 空白邊界必須拒絕：ref="body" 後接空白是 heading 實質延續，不是 parenthetical gloss
test('headingMatchesRef: space-boundary ref "body" is rejected (word prefix, not complete concept)', () => {
  assert.equal(
    headingMatchesRef('## body file two-step 紀律', 'body'),
    false,
    '"body" should not match "body file two-step 紀律" — space boundary is not parenthetical gloss'
  );
});

// 半截 prefix 靠空白邊界也必須拒絕（收緊前可能為 true）
test('headingMatchesRef: space-boundary prefix "Protected-Branch" is rejected (incomplete concept)', () => {
  assert.equal(
    headingMatchesRef('### Protected-Branch git Write Rule', 'Protected-Branch'),
    false,
    '"Protected-Branch" alone should not match — space after it means heading continues'
  );
});

// 空白+括號 gloss 容忍：ref="可促進單位"，heading 為 "可促進單位 (Promotable Unit)"
test('headingMatchesRef: "可促進單位" matches "## 可促進單位 (Promotable Unit)" (space + paren gloss)', () => {
  assert.equal(
    headingMatchesRef('## 可促進單位 (Promotable Unit)', '可促進單位'),
    true,
    '"可促進單位" should match "可促進單位 (Promotable Unit)" — space+paren is parenthetical gloss'
  );
});

// 空白後接詞仍拒絕（即使後面有括號，括號不緊接 ref）
test('headingMatchesRef: "Foo" is rejected when space is followed by word then paren ("Foo bar (x)")', () => {
  assert.equal(
    headingMatchesRef('### Foo bar (x)', 'Foo'),
    false,
    '"Foo" should not match "Foo bar (x)" — space is followed by word "bar", not a paren'
  );
});

// LATENT EDGE positive characterization：
// ref="Done" 匹配 "## Done (Why) When" by-design（existence 容忍括號 gloss）
// 若此 test 轉 RED 代表 headingMatchesRef 被收緊為 slug-uniqueness，
// 先讀 docstring LATENT EDGE 段確認 trigger 條件再決定是否維持收緊。
test('headingMatchesRef: "Done" matches "## Done (Why) When" (by-design existence-tolerance; uniqueness 非 guard scope; 若此 test 轉 RED 代表你正在收緊 slug-uniqueness，先讀 docstring LATENT EDGE 段確認 trigger 條件)', () => {
  assert.equal(
    headingMatchesRef('## Done (Why) When', 'Done'),
    true,
    'by-design: existence-tolerance matches first satisfying heading; uniqueness 非 guard scope'
  );
});
