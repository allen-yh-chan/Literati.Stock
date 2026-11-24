/**
 * spec-thenclause-citations.mjs
 *
 * Shared judgment for `- **THEN**` / `- **AND**` clause citations of the form
 * `` `leaf.md` §heading `` (optionally `per `leaf.md` §heading`):
 *   - the named leaf must exist under the agent-rules directory,
 *   - the cited heading must be a heading of that leaf (parenthetical gloss tolerated),
 *   - the citation must be clause-final (only trailing punctuation after the heading).
 *
 * Two callers share this single copy so a citation accepted before archive cannot
 * be rejected after promotion by a different rule:
 *   - tests/cross-ref-spec-thenclause-grep.test.mjs (canonical openspec/specs scan)
 *   - lint-delta-spec-citations.mjs (the change's own delta, pre-archive)
 * No top-level side effects: importing this module never runs a test or a CLI.
 *
 * tests/cross-ref-heading-anchor-grep.test.mjs keeps its own headingMatchesRef
 * copy on purpose (agent-rules prose "見 file.md §heading" is a different surface).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { closesFence, fenceDelimiter } from './markdown-fence-aware.mjs';

/**
 * Citation pattern inside a THEN/AND line:
 *   - `...` limits to a backtick-wrapped slug filename
 *   - §\s* tolerates a space after § ("§heading" and "§ heading" both match)
 *   - terminator set [^，。、|\n]+ aligns with PATTERN_B_SECTION_RE (cross-ref-heading-anchor-grep).
 *     ASCII comma/period are NOT terminators: they stay inside the captured heading.
 */
export const THEN_AND_LINE_RE = /^- \*\*(?:THEN|AND)\*\*/;
export const LEAF_SECTION_RE = /`([a-z][a-z0-9-]+\.md)`\s*§\s*([^，。、|\n]+)/g;
export const CITATION_TRAILING_RE = /^\s*[。．.]*\s*$/;

/** heading 行去掉 # 前綴，取純文字 */
export function headingText(line) {
  return line.replace(/^#{1,6}\s+/, '').trim();
}

/**
 * parenthetical-aware prefix-match（同 cross-ref-heading-anchor-grep.test.mjs）：
 *   1. ref === h：完全相等 ✓
 *   2. h.startsWith(ref) 且 ref 後緊接括號（全形/半形）或「空白+括號」：parenthetical gloss 容忍 ✓
 *   3. 其他（空白後接詞、substring-only）：拒絕
 */
export function headingMatchesRef(line, ref) {
  const h = headingText(line);
  if (h === ref) return true;
  if (h.startsWith(ref)) {
    const rest = h.slice(ref.length);
    if (rest[0] === '（' || rest[0] === '(') return true;
    if (/^\s+[（(]/.test(rest)) return true;
  }
  return false;
}

/**
 * 中和 fenced code block（防 fence 內範例誤報），**保留行數結構**：
 * 逐行掃描，fence 的開／關判定一律委給 lib/markdown-fence-aware.mjs 的
 * fenceDelimiter／closesFence（CommonMark：``` 與 ~~~ 各自配對、關閉 run 不短於開頭且無 info string、
 * info string 含 backtick 的 ``` 行不是 fence；與 lint-modified-scenario-preservation 的
 * deltaContainsRemovedScenariosHeading 同一組 helper）。
 * fence 分隔行與其內每一行都換成空字串而非整段刪除，使後續 `lineNo = i + 1`
 * 與原始 raw 行號 1:1 對應。整段 .replace(/.../,'') 會折疊多行 fence → 後續行號全錯，故不採。
 * 不改用 neutraliseInertMarkdown：它另會空白 HTML comment，會改變 canonical test 的掃描面。
 */
export function stripFencedCodeBlocks(content) {
  let open = null;
  return String(content)
    .split('\n')
    .map((line) => {
      const delim = fenceDelimiter(line.replace(/\r$/u, ''));
      if (open !== null) {
        if (delim && closesFence(delim, open)) open = null;
        return '';
      }
      if (delim) {
        open = delim;
        return '';
      }
      return line;
    })
    .join('\n');
}

/** `heading` is a heading (any level) of the markdown file at `targetPath`. */
export function headingExistsInTarget(targetPath, heading) {
  const targetLines = readFileSync(targetPath, 'utf8').split('\n');
  return targetLines
    .filter((line) => /^#{1,6}\s/.test(line))
    .some((line) => headingMatchesRef(line, heading));
}

/** resolve leaf：只找 agent-rules/ 根層 */
function resolveTarget(agentRulesDir, filename) {
  const candidate = path.join(agentRulesDir, filename);
  try { readFileSync(candidate); return candidate; } catch (_) {}
  return null;
}

/**
 * Scan THEN/AND lines of `content` (already fence-neutralized by the caller when
 * fenced examples must be ignored; line count is preserved 1:1).
 * Missing leaves fail closed (#2287); citations must be clause-final (#2286) so
 * LEAF_SECTION_RE cannot swallow trailing English as a heading.
 *
 * @param {{ content: string, agentRulesDir: string }} opts
 * @returns {{
 *   citations: Array<{ lineNo: number, filename: string, heading: string, targetPath: string }>,
 *   unresolved: Array<{ lineNo: number, filename: string }>,
 *   nonClauseFinal: Array<{ lineNo: number, after: string }>,
 * }}
 */
export function scanThenAndCitations({ content, agentRulesDir }) {
  const citationsOut = [];
  const unresolved = [];
  const nonClauseFinal = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!THEN_AND_LINE_RE.test(line)) continue;

    const found = [...line.matchAll(LEAF_SECTION_RE)];
    if (found.length === 0) continue;

    const last = found[found.length - 1];
    const after = line.slice(last.index + last[0].length);
    if (!CITATION_TRAILING_RE.test(after)) {
      nonClauseFinal.push({ lineNo: i + 1, after });
    }

    for (const match of found) {
      const filename = match[1];
      const heading = match[2].trim();
      const targetPath = resolveTarget(agentRulesDir, filename);
      if (!targetPath) {
        unresolved.push({ lineNo: i + 1, filename });
        continue;
      }
      citationsOut.push({ lineNo: i + 1, filename, heading, targetPath });
    }
  }

  return { citations: citationsOut, unresolved, nonClauseFinal };
}
