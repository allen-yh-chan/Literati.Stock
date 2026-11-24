/**
 * Cooperative-only wording-stability guard for the Web theme/locale
 * pre-analyst probe (ambiguity-scoring.md) and its mechanism contract
 * (frontend-theming-and-i18n.md). It does not enforce runtime TL behavior;
 * it only proves the operative clauses exist, stay MUST/MUST NOT-polarized
 * on their own physical line, and cannot be silently deleted or diluted.
 *
 * Polarity-sensitive assertions bind the polarity keyword to its object on
 * the SAME physical line (no compensating alternation) so an unrelated
 * MUST/MUST NOT elsewhere in the file cannot keep the guard GREEN after the
 * real operative line is removed. structural-existence assertions (heading
 * presence, reciprocal pointer) use plain substring/regex matches instead.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { repoPath } from "./lib/repo-root.mjs";
import {
  countH2Sections,
  extractSection,
  hasMixedListSeparators,
  parseBulletFields,
  splitListItems,
} from "../lib/clarification-contract.mjs";

function stripFrontmatter(raw) {
  const frontmatter = raw.match(/^---\n[\s\S]*?\n---\n/);
  return frontmatter ? raw.slice(frontmatter[0].length) : raw;
}

function readBody(relativePath) {
  return stripFrontmatter(readFileSync(repoPath(relativePath), "utf8"));
}

const AMB_PATH = ".devpro/agent-rules/ambiguity-scoring.md";
const LEAF_PATH = ".devpro/agent-rules/frontend-theming-and-i18n.md";

const targets = {
  amb: readBody(AMB_PATH),
  leaf: readBody(LEAF_PATH),
};

// ---------------------------------------------------------------------------
// OPERATIVE_ANCHORS: every entry MUST hit exactly one line in its target and
// MUST go red (stop matching) when that exact line is deleted. Verified by
// the mutation-localization meta-test below — not by manual inspection.
// ---------------------------------------------------------------------------
const OPERATIVE_ANCHORS = [
  // --- ambiguity-scoring.md: ### Web theme/locale probe before dp-analyst dispatch ---
  {
    name: "probe section heading exists",
    target: "amb",
    rx: /^### Web theme\/locale probe before dp-analyst dispatch$/m,
  },
  {
    name: "theme dimension MUST be asked",
    target: "amb",
    rx: /web-theme:[^\n]*MUST[^\n]*主動問是否需要 dark\/light 主題切換機制/,
  },
  {
    name: "theme dimension MUST wait until answered",
    target: "amb",
    rx: /dark\/light 主題切換機制[^\n]*MUST wait until[^\n]*該題已 answered/,
  },
  {
    name: "locale dimension MUST be asked",
    target: "amb",
    rx: /web-locale:[^\n]*MUST[^\n]*主動問是否需要多語系支援/,
  },
  {
    name: "locale dimension MUST wait until answered",
    target: "amb",
    rx: /多語系支援[^\n]*MUST wait until[^\n]*該題已 answered/,
  },
  {
    name: "unresolved dimension fails closed before dp-analyst",
    target: "amb",
    rx: /任一維度未命中繼承判定[^\n]*UNRESOLVED:[^\n]*MUST NOT[^\n]*呼叫[^\n]*dp-analyst/,
  },
  {
    name: "inheritance evidence boundary excludes out-of-section/field text",
    target: "amb",
    rx: /區段外與他欄一律[^\n]*MUST NOT[^\n]*視為證據/,
  },
  {
    name: "probe pointers full judgment shape to the mechanism leaf",
    target: "amb",
    rx: /frontend-theming-and-i18n\.md`[^\n]*## When to Use/,
  },
  {
    name: "probe section MUST only apply when the create/rebuild trigger condition holds (F-W15/round 12)",
    target: "amb",
    rx: /\*\*本節僅在觸發條件成立時適用\*\*[^\n]*觸發條件逐字定義見[^\n]*frontend-theming-and-i18n\.md/,
  },
  {
    name: "probe section MUST NOT block dp-analyst for non-trigger existing-page/non-UI work (F-W15/round 12)",
    target: "amb",
    rx: /\*\*觸發條件不成立時\*\*[^\n]*本節 \*\*MUST NOT\*\* 被引用為阻擋 `dp-analyst` 呼叫的理由/,
  },

  // --- frontend-theming-and-i18n.md: mechanism contract ---
  {
    name: "theme cookie attrs MUST Secure+SameSite=Lax and MUST NOT HttpOnly",
    target: "leaf",
    rx: /cookie 屬性[^\n]*MUST[^\n]*Secure[^\n]*SameSite=Lax[^\n]*MUST NOT[^\n]*HttpOnly/,
  },
  {
    name: "theme MUST prevent FOUC",
    target: "leaf",
    rx: /MUST[^\n]*防 FOUC/,
  },
  {
    name: "cross-site iframe: SameSite=Lax governs attachment only, MUST NOT infer JS readability, MUST fall back on actual read result (F-W5/round 7)",
    target: "leaf",
    rx: /只決定 cookie 是否\*\*自動隨 request 送出\*\*[^\n]*MUST NOT\*\* 以此推論 JS `document\.cookie` 是否\*\*可讀\*\*[^\n]*MUST\*\* 依實際讀取結果回退[^\n]*MUST NOT\*\* 為了讓 iframe 情境下的偏好持久化而改用/,
  },
  {
    name: "theme closed-set literal MUST NOT be reworded",
    target: "leaf",
    rx: /\{light, dark\}[^\n]*為封閉集 grep anchor[^\n]*MUST NOT[^\n]*改寫成同義措辭/,
  },
  {
    name: "invalid theme value MUST fall back and MUST NOT be written back",
    target: "leaf",
    rx: /值不在封閉集內[^\n]*MUST[^\n]*視同 cookie 未設定[^\n]*MUST NOT[^\n]*回寫 cookie/,
  },
  {
    name: "theme value MUST NOT be injected raw into DOM",
    target: "leaf",
    rx: /MUST NOT[^\n]*把 cookie 原值直接插入 DOM[^\n]*MUST[^\n]*程式內常數/,
  },
  {
    name: "locale source with unvalidated value MUST continue, MUST NOT stop",
    target: "leaf",
    rx: /未通過白名單驗證[^\n]*MUST[^\n]*續查下一優先序來源[^\n]*MUST NOT[^\n]*停止解析/,
  },
  {
    name: "q=0 final veto MUST NOT be bypassed by another tag's truncation (pipeline stage 9)",
    target: "leaf",
    rx: /q=0[^\n]*最終否決[^\n]*MUST NOT[^\n]*繞過/,
  },
  {
    name: "worked example #9 MUST NOT let either q value win on cardinality overflow",
    target: "leaf",
    rx: /MUST NOT[^\n]*取[^\n]*q=0\.8[^\n]*或[^\n]*q=0[^\n]*任一者生效/,
  },
  {
    name: "worked example #1c MUST NOT misread uppercase Q=0 as absent q parameter (F13)",
    target: "leaf",
    rx: /Q=0[^\n]*MUST NOT[^\n]*誤判為未帶 q 參數/,
  },
  {
    name: "prefers-color-scheme MUST be the first-visit initial default (F10/F-W8)",
    target: "leaf",
    rx: /\*\*MUST\*\* 以 `prefers-color-scheme` 作為初始預設/,
  },
  {
    name: "decisions delimiter consistency: new item MUST match the value's existing delimiter, MUST NOT mix delimiters (F-W10/round 10)",
    target: "leaf",
    rx: /^\*\*分隔符一致性\*\*：新增 item 使用的分隔符 \*\*MUST\*\* 與該 `decisions:` 值目前既有分隔符相同[^\n]*\*\*MUST NOT\*\* 在既有值已用某一分隔符時插入使用另一分隔符的新 item[^\n]*導致既有維度的繼承證據悄悄失效。$/m,
  },
  {
    name: "pre-existing mixed-separator value MUST NOT be appended to; MUST halt UNRESOLVED instead (F-page18/round 21)",
    target: "leaf",
    rx: /^\*\*Fail-closed 補充條款（該值已同時含兩種分隔符時）\*\*：附加新 item 前 \*\*MUST\*\* 先呼叫[^\n]*`hasMixedListSeparators\(listText\)`[^\n]*\*\*MUST NOT\*\* 逕行依優先序附加[^\n]*\*\*MUST\*\* 停下並記為 `UNRESOLVED: mixed-separator-corruption`[^\n]*\*\*MUST NOT\*\* 呼叫 `dp-analyst`[^\n]*$/m,
  },
  {
    name: "read-side mixed-separator value MUST yield no hits, MUST NOT be parsed by splitListItems (F-page1/round 22)",
    target: "leaf",
    rx: /^\*\*讀取端 fail-closed\*\*：`hasMixedListSeparators\(fields\.decisions \|\| ""\)` 為 `true` 的文件 \*\*MUST\*\* 視為該文件對兩個維度皆無合格命中（`return \[\]`）[^\n]*\*\*MUST NOT\*\* 逕行呼叫 `splitListItems` 解析[^\n]*$/m,
  },
  {
    name: "every locale source segment MUST validate against the BCP-47 closed whitelist (F10)",
    target: "leaf",
    rx: /MUST[^\n]*BCP-47 封閉白名單驗證/,
  },
  {
    name: "all four locale sources MUST case-insensitively match the whitelist, query string/cookie MUST NOT skip normalization (round 15/F-W30)",
    target: "leaf",
    rx: /四段來源[^\n]*對白名單的比對 MUST 一律 case-insensitive[^\n]*query string／cookie 兩段讀到的原始 tag 值[^\n]*MUST NOT[^\n]*因大小寫不同而誤判為未命中白名單並錯誤跳至下一優先序來源。$/m,
  },
  {
    name: "translation strings MUST use resource file as SSOT, effective locale MUST align to <html lang> (F10)",
    target: "leaf",
    rx: /resource file 為 SSOT[^\n]*MUST[^\n]*<html lang>/,
  },
  {
    name: "item-stage MUST call splitListItems and MUST NOT hand-roll a splitter",
    target: "leaf",
    rx: /MUST[^\n]*呼叫[^\n]*splitListItems\(listText\)[^\n]*MUST NOT[^\n]*自造 splitter/,
  },
  {
    name: "judgment command precondition fails closed with SyntaxError by design",
    target: "leaf",
    rx: /SyntaxError[^\n]*刻意[^\n]*fail-closed[^\n]*寧可 import 硬失敗/,
  },
  {
    name: "leaf-local fail-closed invariant before dp-analyst",
    target: "leaf",
    rx: /任一維度未命中繼承判定[^\n]*MUST[^\n]*UNRESOLVED:[^\n]*MUST NOT[^\n]*呼叫[^\n]*dp-analyst/,
  },
  {
    name: "non-singular Clarification State section MUST be treated as no evidence",
    target: "leaf",
    rx: /countH2Sections[^\n]*MUST[^\n]*視為[^\n]*不提供[^\n]*任何繼承證據[^\n]*MUST NOT[^\n]*任選一個區段當證據/,
  },
  {
    name: "answer MUST NOT be written as an indented sub-bullet under decisions:",
    target: "leaf",
    rx: /MUST NOT[^\n]*縮排子 bullet[^\n]*unknown field[^\n]*Provenance MUST[^\n]*PROVENANCE_SUFFIX/,
  },
  {
    name: "scan path is a closed set; rule-text/vendored literals MUST NOT count as evidence",
    target: "leaf",
    rx: /掃描路徑為封閉集[^\n]*MUST NOT[^\n]*把下列任一項當作繼承證據/,
  },
  {
    name: "reciprocal pointer to frontend-session.md for session/Cookie/CORS",
    target: "leaf",
    rx: /session \/ Cookie \/ CORS mechanics 見 `frontend-session\.md`/,
  },
  {
    name: "CE-1~CE-7 counter-example table heading exists",
    target: "leaf",
    rx: /^### CE-1 ~ CE-7 反例（MUST NOT 命中）$/m,
  },
];

// ---------------------------------------------------------------------------
// F10 domain-partition completeness (decisions.md D17): rather than 1:1
// anchor every MUST line in the leaf (leaf has ~54 MUST lines total; cost
// unbounded and would dilute existing polarity anchors), declare a CLOSED
// extraction domain and assert every MUST line inside it is classified as
// either (a) covered by an existing leaf-target OPERATIVE_ANCHORS entry, or
// (b) a named ANCHOR_EXEMPT entry with a stated reason. This flips the
// default from "silently uncovered" (F10's root cause) to "must be
// classified or the guard goes red" for any newly-added operative clause.
// ---------------------------------------------------------------------------

// Sections deliberately OUTSIDE the domain, with the reason each is excluded
// (decisions.md D17). The extractor below excludes them structurally; this
// list documents *why*, for audit trail purposes.
const EXCLUDED_FROM_DOMAIN = [
  { section: "## Exit Criteria", reason: "gate-facing restatement of contracts already stated once inside the domain, not a new contract" },
  { section: "## Common Rationalizations", reason: "excuse -> rebuttal table, not itself an executable MUST/MUST NOT clause" },
  { section: "#### 排除的作法", reason: "describes REJECTED alternatives; MUST/MUST NOT phrases describe the rejected approach's flaw, not a contract this leaf requires" },
  { section: "#### Worked examples", reason: "pins examples of the rules, not the rules themselves (rules live in the numbered pipeline)" },
  { section: "## Verification", reason: "existence-grep checklist only, not a deletion-localized contract (decisions.md D20)" },
];

function extractH2Body(text, heading) {
  const re = new RegExp(`^## ${heading}\\n`, "m");
  const m = re.exec(text);
  if (!m) throw new Error(`## ${heading} not found`);
  const rest = text.slice(m.index + m[0].length);
  const next = rest.match(/^## /m);
  return next ? rest.slice(0, next.index) : rest;
}

function extractH3Body(text, headingRe) {
  const m = headingRe.exec(text);
  if (!m) throw new Error(`heading not found: ${headingRe}`);
  const rest = text.slice(m.index + m[0].length);
  const next = rest.match(/^#{2,3} /m);
  return next ? rest.slice(0, next.index) : rest;
}

// Subtracts a `#### <heading>` sub-block (up to the next `##`-`####` heading)
// from `text`. Used to carve the two excluded #### sub-blocks out of ### Locale.
function removeH4Block(text, headingRe) {
  const m = headingRe.exec(text);
  if (!m) return text;
  const before = text.slice(0, m.index);
  const rest = text.slice(m.index + m[0].length);
  const next = rest.match(/^#{2,4} /m);
  const after = next ? rest.slice(next.index) : "";
  return before + after;
}

function extractDomain(leafText) {
  const whenToUse = extractH2Body(leafText, "When to Use");
  const theme = extractH3Body(leafText, /^### Theme[^\n]*\n/m);
  let locale = extractH3Body(leafText, /^### Locale[^\n]*\n/m);
  locale = removeH4Block(locale, /^#### Worked examples[^\n]*\n/m);
  locale = removeH4Block(locale, /^#### 排除的作法[^\n]*\n/m);
  return `${whenToUse}\n${theme}\n${locale}`;
}

function domainMustLines(leafText) {
  return extractDomain(leafText).split("\n").filter((l) => /\bMUST\b/.test(l));
}

const LEAF_ANCHOR_RXS = OPERATIVE_ANCHORS.filter((a) => a.target === "leaf").map((a) => a.rx);

// Named exempt registry: every entry here is a domain MUST line that is
// deliberately NOT a dedicated deletion-localized OPERATIVE_ANCHORS entry.
// Each `rx` MUST resolve to exactly one live domain line (asserted below) and
// carries a `reason` explaining why a wording-stability anchor is not the
// right mechanism for that line (e.g. it is instead proven by a T15
// executable CE/CF fixture, or it is a framing/connective sentence whose
// substantive commitment is anchored elsewhere).
// Every rx below is deliberately full-line-bound (T24/F-W2): a stable prefix
// marker, `[^\n]*`, then a distinctive substring drawn from LATER in the same
// line (the substantive MUST/MUST NOT clause or table-row payload) — the same
// two-substring-per-line discipline OPERATIVE_ANCHORS already uses. A regex
// that only anchors the prefix would still match after the line's tail is
// silently swapped for unrelated content; the dilution mutation test below
// exists specifically to catch that regression class.
const ANCHOR_EXEMPT = [
  { name: "trigger paragraph framing prose", rx: /^> 當一項需求\*\*明示要新建或重建\*\*[^\n]*MUST NOT\*\* 以其中一維的已繼承證據視另一維為已繼承。$/, reason: "narrative framing of the trigger condition; substantive per-dimension MUST is anchored in ambiguity-scoring.md and this leaf's fail-closed invariant anchor" },
  { name: "four-stage procedure intro sentence", rx: /^\*\*判定程序（MUST 依序[^\n]*任一階段失敗 → 該維視為未繼承 → 照常提問）\*\*$/, reason: "framing sentence introducing the numbered stage list; stage 4 (item-aware) has its own anchor below, stages 1/2/3 are exempted below (round 23/W1: renumbered from three to four stages — the round 22/F-page1 mixed-separator guard is now its own enumerated stage 3)" },
  { name: "stage 1 (section-aware) body", rx: /^1\. \*\*區段階段（section-aware）\*\*[^\n]*MUST NOT\*\* 另寫一份平行的區段切法。$/, reason: "behavior proven by CE-1 executable fixture (T15), not a dedicated wording anchor" },
  { name: "stage 2 (field-aware) body", rx: /^2\. \*\*欄位階段（field-aware）\*\*[^\n]*MUST NOT\*\* 被當作繼承證據。$/, reason: "behavior proven by CE-2 executable fixture (T15), not a dedicated wording anchor" },
  { name: "stage 3 (separator-integrity-aware) body (round 23/W1)", rx: /^3\. \*\*分隔符完整性階段（separator-integrity-aware）\*\*[^\n]*細節、理由與獨立於寫入端的讀取端防線說明見下方「讀取端 fail-closed」段。$/, reason: "this stage is a cross-reference to the mechanism already anchored by the dedicated 'read-side mixed-separator value MUST yield no hits' OPERATIVE_ANCHORS entry and proven by the DM-2 fixture + guard-has-teeth test; round 23/W1 only added this numbered-procedure enumeration, the underlying MUST clauses are not duplicated here" },
  { name: "duplicate-field fail-closed supplementary clause (F-W1/T23)", rx: /^\*\*Fail-closed 補充條款（`decisions` 欄重複時）\*\*[^\n]*MUST NOT\*\* 僅採第一個 `decisions:` 物理行的值為準。$/, reason: "behavior proven by CF-3 executable fixture (T23), not a dedicated wording anchor" },
  { name: "conflict fail-closed supplementary clause (F9/T17)", rx: /^\*\*Fail-closed 補充條款（同一維度衝突時）\*\*[^\n]*MUST NOT\*\* 呼叫 `dp-analyst`，照常對該維度提問。$/, reason: "behavior proven by CF-1/CF-2 executable fixtures (T15), not a dedicated wording anchor" },
  { name: "answer-write-in obligation, positive form", rx: /^每一個被問的維度，其答覆[^\n]*MUST 寫成該 change `meeting-notes\.md` `## Clarification State` 區段內 \*\*`- decisions:` 那一行的值裡、以該值既有分隔符分隔的一個 item\*\*，逐字形如（值為空或本次為首次寫入時，預設使用 `;`）：$/, reason: "positive-form restatement; the negative form (MUST NOT indented sub-bullet) already has a dedicated anchor; the delimiter-consistency MUST NOT this line's wording refers to has its own dedicated F-W10 anchor below" },
  { name: "answer-write-in pipe-delimited continuation example", rx: /^若該行既有值已為 `\|` 分隔[^\n]*MUST 沿用 `\|` 而非改寫成 `;`，逐字形如：$/, reason: "illustrative continuation of the same obligation for the pipe-delimited case; the operative delimiter-consistency rule has its own dedicated F-W10 anchor below" },
  { name: "judgment command conflict-output explanation sentence", rx: /^同一指令對 `web-locale` 重跑一次[^\n]*MUST NOT\*\* 從命中清單挑一筆當答案。$/, reason: "prose explaining the fence's console output; the fence code itself is covered by the splitListItems-import test, the conflict behavior it describes by CF fixtures" },
  { name: "judgment command fence inline comment for the round-22 mixed-separator guard call site", rx: /^ {2}if \(hasMixedListSeparators\(fields\.decisions \|\| ""\)\) return \[\];[^\n]*pre-existing mixed-separator corruption MUST NOT be trusted as inheritance evidence$/, reason: "this fence line is the executable call site itself, not prose; the normative MUST/MUST NOT are stated once and anchored in the dedicated F-page1/round 22 prose entry above, and the call site's own correctness is proven by the DM-2 fixture + guard-has-teeth test" },
  { name: "CE-1 table row", rx: /^\| CE-1 \|[^\n]*階段 1（區段） \|$/, reason: "counter-example table row proven by the CE-1 executable fixture (T15), fixture regression is a stronger signal than a wording anchor" },
  { name: "CE-2 table row", rx: /^\| CE-2 \|[^\n]*階段 2（欄位） \|$/, reason: "counter-example table row proven by the CE-2 executable fixture (T15)" },
  { name: "CE-3 table row", rx: /^\| CE-3 \|[^\n]*guard MUST 各自斷言 \|$/, reason: "counter-example table row proven by the CE-3 executable fixture (T15)" },
  { name: "CE-4 table row", rx: /^\| CE-4 \|[^\n]*上述 fail-closed 補充條款 \|$/, reason: "counter-example table row proven by the CE-4 executable fixture (T15)" },
  { name: "CE-5 table row", rx: /^\| CE-5 \|[^\n]*階段 1（區段） \|$/, reason: "counter-example table row proven by the CE-5 executable fixture (T15)" },
  { name: "CE-6 table row", rx: /^\| CE-6 \|[^\n]*階段 4（整項錨定） \|$/, reason: "counter-example table row proven by the CE-6 executable fixture (T15)" },
  { name: "CE-7 table row", rx: /^\| CE-7 \|[^\n]*階段 4（整項錨定） \|$/, reason: "counter-example table row proven by the CE-7 executable fixture (T15)" },
  { name: "conflict counter-example section heading", rx: /^### 衝突反例（needed／not-needed 矛盾[^\n]*MUST NOT 視為已繼承）$/, reason: "structural heading; protected transitively by the CF-1/CF-2 fixture-covered rows beneath it, not by a dedicated anchor (decisions.md D23 only freezes the CE-1~CE-7 heading)" },
  { name: "conflict counter-example section frozen-heading note", rx: /^獨立分節承載（`decisions\.md` D23）[^\n]*MUST NOT\*\* 併入或改名上方 `### CE-1 ~ CE-7 反例（MUST NOT 命中）`。$/, reason: "restates the D23 heading-freeze decision; not itself an operative runtime rule" },
  { name: "CF-1 table row", rx: /^\| CF-1 \|[^\n]*`needed`／`not-needed` 兩值皆不得選用 \|$/, reason: "conflict counter-example table row proven by the CF-1 executable fixture (T15)" },
  { name: "CF-2 table row", rx: /^\| CF-2 \|[^\n]*衝突判定不比對檔案界限或時序 \|$/, reason: "conflict counter-example table row proven by the CF-2 executable fixture (T15)" },
  { name: "CF-3 table row", rx: /^\| CF-3 \|[^\n]*未檢查 `errors`[^\n]*MUST NOT\*\* 沿用 \|$/, reason: "conflict counter-example table row proven by the CF-3 executable fixture (T23)" },
  { name: "locale fallback value must itself be whitelisted (F-W21/round 12 rewording: three preceding sources, not four)", rx: /^2\. \*\*前三段\*\*（query string、cookie、`Accept-Language`）皆未產出白名單命中值時才使用 fallback 語系；fallback 值本身 \*\*MUST\*\* 在白名單內（fallback 是鏈的終點，不是「四段皆未命中」條件式的一員——它不能以自身結果作為使用自身的前提）。$/, reason: "entailed by the already-anchored 'unvalidated value MUST continue, MUST NOT stop' clause plus the closed whitelist mechanism" },
  { name: "locale MUST NOT write back unvalidated value (locale-side restatement)", rx: /^3\. 全程 \*\*MUST NOT\*\* 把未通過驗證的值回寫 cookie 或 `<html lang>`。$/, reason: "same no-write-back direction already anchored for theme cookie; this is the locale-side restatement of one rule, not a second contract" },
  { name: "Accept-Language pipeline section heading", rx: /^#### `Accept-Language` 全序解析管線[^\n]*階段間不得回頭）$/, reason: "pipeline-level ordering declaration; individual stages are listed and exempted separately below" },
  { name: "pipeline stage 1 (OWS)", rx: /^1\. \*\*切分與去空白（OWS）\*\*[^\n]*MUST NOT\*\* 因未去空白而把合法 entry 判為畸形。$/, reason: "covered by design.md D9-c 12-stage pipeline + worked examples (incl. #1/#1b/#1c), not one of the three F10-named anchors" },
  { name: "pipeline stage 2 (shape validation)", rx: /^2\. \*\*形狀驗證\*\*[^\n]*MUST NOT\*\* 使該 entry 通過本檢查。與條 8 相容：`\*` 是單段 entry（1 段）落在允許區間；`\*;q=0\.8` 是 2 段且第 2 段合法。$/, reason: "same as stage 1; scope bounded to the three F10-named anchors per decisions.md D17" },
  { name: "pipeline stage 3 (out-of-range q)", rx: /^3\. \*\*超範圍 q\*\*[^\n]*MUST 忽略該 entry，MUST NOT clamp\*\*。$/, reason: "same as stage 1" },
  { name: "pipeline stage 4 (normalization)", rx: /^4\. \*\*正規化\*\*[^\n]*MUST\*\* 視為權重 `1`。$/, reason: "same as stage 1" },
  { name: "pipeline stage 5 (dedupe)", rx: /^5\. \*\*去重\*\*[^\n]*MUST 取 header 內最後出現的那一筆（last-wins）\*\*，其餘丟棄。$/, reason: "same as stage 1" },
  { name: "pipeline stage 8 (wildcard)", rx: /^8\. \*\*`\*` wildcard\*\*[^\n]*排除任何白名單項。$/, reason: "same as stage 1" },
  { name: "pipeline stage 10 (no amplification)", rx: /^10\. \*\*放大方向 MUST NOT 推論\*\*[^\n]*MUST NOT\*\* 自行挑選任一變體。$/, reason: "same as stage 1" },
  { name: "pipeline stage 11 (all-miss fallthrough)", rx: /^11\. \*\*全數未命中\*\*[^\n]*MUST NOT\*\* 就地選用被否決值或任意白名單值代替。$/, reason: "same as stage 1" },
  { name: "pipeline stage 12 (whitelist authoring duty)", rx: /^12\. \*\*對應的白名單撰寫義務\*\*[^\n]*非解析期啟發式。$/, reason: "same as stage 1" },
];

test("F10 domain-partition completeness: every MUST line is anchored or named-exempt", () => {
  const mustLines = domainMustLines(targets.leaf);
  assert.ok(mustLines.length > 0, "domain extraction produced zero MUST lines; extractor is broken");

  const unclassified = [];
  const bothClassified = [];
  for (const line of mustLines) {
    const anchored = LEAF_ANCHOR_RXS.some((rx) => rx.test(line));
    const exempt = ANCHOR_EXEMPT.some(({ rx }) => rx.test(line));
    if (!anchored && !exempt) unclassified.push(line);
    if (anchored && exempt) bothClassified.push(line);
  }
  assert.deepEqual(unclassified, [], `unclassified domain MUST lines (need an anchor or a named exempt entry): ${JSON.stringify(unclassified)}`);
  assert.deepEqual(bothClassified, [], `lines classified as BOTH anchored and exempt (sets must be disjoint): ${JSON.stringify(bothClassified)}`);

  // Every exempt entry must resolve to a live domain line (not stale/dead),
  // and to EXACTLY one — a multi-hit exempt regex could silently absorb a
  // future MUST line the author never reviewed, the same hole class this
  // partition exists to close (mirrors the anchor exactly-one-hit meta-test).
  const domainText = extractDomain(targets.leaf);
  const domainLines = domainText.split("\n");
  const deadExempt = ANCHOR_EXEMPT.filter(({ rx }) => domainLines.filter((l) => rx.test(l)).length === 0).map(({ name }) => name);
  assert.deepEqual(deadExempt, [], `ANCHOR_EXEMPT entries that no longer resolve to any live domain line: ${deadExempt.join(", ")}`);
  const multiHitExempt = ANCHOR_EXEMPT.filter(({ rx }) => domainLines.filter((l) => rx.test(l)).length > 1).map(({ name }) => name);
  assert.deepEqual(multiHitExempt, [], `ANCHOR_EXEMPT entries matching more than one domain line (must narrow the regex to exactly one): ${multiHitExempt.join(", ")}`);

  // Documented exclusions must be non-empty and each carry a reason.
  for (const { section, reason } of EXCLUDED_FROM_DOMAIN) {
    assert.ok(section && reason, `EXCLUDED_FROM_DOMAIN entry missing section/reason: ${JSON.stringify({ section, reason })}`);
  }
});

test("F10 domain-partition insertion-side counter-run: an unanchored new MUST line goes unclassified", () => {
  const leafWithMutation = targets.leaf.replace(
    "### Theme（dark/light）\n",
    "### Theme（dark/light）\n\n- 插入的反證句：本行 **MUST** 不對應任何既有 anchor 或 exempt entry（domain-partition counter-run 專用）。\n",
  );
  assert.notEqual(leafWithMutation, targets.leaf, "mutation did not apply; ### Theme heading text changed upstream");

  const mustLines = domainMustLines(leafWithMutation);
  const injected = mustLines.find((l) => l.includes("domain-partition counter-run 專用"));
  assert.ok(injected, "injected counter-run line was not captured by the domain extractor");

  const anchored = LEAF_ANCHOR_RXS.some((rx) => rx.test(injected));
  const exempt = ANCHOR_EXEMPT.some(({ rx }) => rx.test(injected));
  assert.equal(anchored, false, "counter-run line unexpectedly matched an existing anchor");
  assert.equal(exempt, false, "counter-run line unexpectedly matched an existing exempt entry");
  // i.e. this line WOULD be reported unclassified by the completeness test
  // above if it were really added to the leaf without a matching anchor or
  // exempt entry — proving the classifier actually detects new gaps.
});

// round 5 finding (F-c584fbb8aaa5, decisions.md Audit Findings Ledger),
// closed round 18: the completeness test above only asserts every
// EXCLUDED_FROM_DOMAIN entry is well-formed (`section && reason` truthy) —
// it never checks that extractDomain() actually excludes that section's own
// MUST lines from the domain, so the claim and the extractor's real behavior
// could silently drift apart (e.g. a future edit to extractH2Body/removeH4Block
// stops excluding one of these sections, but this list keeps claiming it
// does). This binds the claim to the extractor mechanically: for every
// EXCLUDED_FROM_DOMAIN entry, pull that section's own body straight out of
// the leaf and assert none of its MUST lines appear in domainMustLines().
function extractH4Body(text, headingRe) {
  const m = headingRe.exec(text);
  if (!m) throw new Error(`heading not found: ${headingRe}`);
  const rest = text.slice(m.index + m[0].length);
  const next = rest.match(/^#{2,4} /m);
  return next ? rest.slice(0, next.index) : rest;
}

test("EXCLUDED_FROM_DOMAIN sections are mechanically bound to extractDomain()'s actual exclusion behavior (F-c584fbb8aaa5, round 5, closed round 18)", () => {
  const leafText = targets.leaf;
  const domainMust = new Set(domainMustLines(leafText));
  for (const { section, reason } of EXCLUDED_FROM_DOMAIN) {
    const isH4 = section.startsWith("#### ");
    const heading = section.replace(/^#{2,4} /, "");
    const body = isH4
      ? extractH4Body(leafText, new RegExp(`^#### ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*\\n`, "m"))
      : extractH2Body(leafText, heading);
    const sectionMustLines = body.split("\n").filter((l) => /\bMUST\b/.test(l));
    assert.ok(
      sectionMustLines.length > 0,
      `${section}: expected at least one live MUST line in the leaf to test exclusion against (test premise broke — reason: ${reason})`,
    );
    for (const line of sectionMustLines) {
      assert.ok(
        !domainMust.has(line),
        `EXCLUDED_FROM_DOMAIN claims "${section}" is excluded (${reason}), but its own MUST line leaked into extractDomain()'s output: ${JSON.stringify(line)}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// T24 (F-W2, decisions.md D33): the completeness test above only proves every
// domain MUST line is classified as anchored-or-exempt; it says nothing about
// how MUCH of the line an exempt regex actually binds. A prefix-only exempt
// regex (e.g. the pre-T24 `/^3\. 全程 \*\*MUST NOT\*\*/`) still classifies its
// line correctly even after the line's substantive tail is silently swapped
// for unrelated content — the exact gap round 6's cross-model review flagged.
//
// round 12/F-W16 correction: the original mutation below diluted the last 12
// characters of the regex's OWN matched span (`matchEnd`), not the tail of
// the LINE. For a genuinely full-line-bound entry (every current ANCHOR_EXEMPT
// regex is `^...$`) matchEnd === line.length, so the two coincide and the
// test happened to work — but for a hypothetical prefix-only regressed entry
// (matchEnd well short of line.length), mutating within its own short match
// destroys the literal text the regex requires and makes it "fail to match"
// for the wrong reason (broken literal, not exposed lack of full-line
// binding), while the real substantive tail beyond the match is left
// untouched and never exercised. `diluteLineTail` below mutates the tail of
// the LINE itself (always, regardless of where the match ends), which is the
// only mutation point that actually discriminates "regex binds the whole
// line" from "regex only binds a prefix". A structural full-match assertion
// (`m.index + m[0].length === line.length`) backs this up directly per entry.
function diluteLineTail(line) {
  const cut = Math.max(0, line.length - 12);
  return line.slice(0, cut) + "OPAQUE_MUTATION_PAYLOAD";
}
// ---------------------------------------------------------------------------

test("ANCHOR_EXEMPT entries fully consume their matched line, not just a prefix (F-W16/round 12)", () => {
  const domainText = extractDomain(targets.leaf);
  const domainLines = domainText.split("\n");
  const partial = [];
  for (const { name, rx } of ANCHOR_EXEMPT) {
    const line = domainLines.find((l) => rx.test(l));
    if (!line) continue; // already covered by the deadExempt assertion above
    const m = line.match(rx);
    if (m.index !== 0 || m.index + m[0].length !== line.length) partial.push(name);
  }
  assert.deepEqual(
    partial,
    [],
    `ANCHOR_EXEMPT entries whose match does not span the entire domain line, start to end (prefix/partial binding, F-W16): ${partial.join(", ")}`,
  );
});

test("ANCHOR_EXEMPT entries are diluted by mutating the tail of their own matched line (F-W2/T24, mutation point corrected F-W16/round 12)", () => {
  const domainText = extractDomain(targets.leaf);
  const domainLines = domainText.split("\n");
  const notDiluted = [];
  for (const { name, rx } of ANCHOR_EXEMPT) {
    const line = domainLines.find((l) => rx.test(l));
    if (!line) continue; // already covered by the deadExempt assertion above
    const mutated = diluteLineTail(line);
    if (rx.test(mutated)) notDiluted.push(name);
  }
  assert.deepEqual(
    notDiluted,
    [],
    `ANCHOR_EXEMPT entries whose regex still matches after their line's tail is diluted (prefix-only binding, F-W2/F-W16): ${notDiluted.join(", ")}`,
  );
});

test("ANCHOR_EXEMPT dilution test has teeth: a synthetic prefix-only regex fails it, using the same production helper (F-W2/F-W16 counter-run)", () => {
  const line = "3. 全程 **MUST NOT** 把未通過驗證的值回寫 cookie 或 `<html lang>`。";
  const weakRx = /^3\. 全程 \*\*MUST NOT\*\*/; // the exact pre-T24 shape the reviewer flagged; no `$`, so it does not span the whole line
  assert.ok(weakRx.test(line), "sanity: weak regex must still match the unmutated line");
  const mutated = diluteLineTail(line);
  assert.ok(
    weakRx.test(mutated),
    "sanity: a genuinely prefix-only regex must still match after the SAME production diluteLineTail helper used by the real test above mutates the line's tail — proving that test's notDiluted assertion is what actually catches this defect class, not a bespoke mutation shape",
  );
});

test("web theme/locale probe exposes every operative anchor", () => {
  const missing = OPERATIVE_ANCHORS.filter(({ target, rx }) => !rx.test(targets[target])).map(
    ({ name }) => name,
  );
  assert.deepEqual(missing, [], `missing operative anchors: ${missing.join(", ")}`);
});

test("operative-anchor registry is unique and deleting its line turns the guard red", () => {
  for (const { name, target, rx } of OPERATIVE_ANCHORS) {
    const lines = targets[target].split("\n");
    const hitIndexes = lines.flatMap((line, index) => (rx.test(line) ? [index] : []));
    assert.equal(hitIndexes.length, 1, `anchor "${name}" matched ${hitIndexes.length} lines; expected 1`);

    const mutant = lines.filter((_, index) => index !== hitIndexes[0]).join("\n");
    assert.ok(!rx.test(mutant), `anchor "${name}" stayed GREEN after deleting its operative line`);
  }
});

// ---------------------------------------------------------------------------
// F-W8 (round 9): the prior "prefers-color-scheme MUST be the first-visit
// initial default" anchor matched `prefers-color-scheme[^\n]*作為初始預設`
// without binding the MUST keyword itself — a polarity downgrade (MUST ->
// SHOULD, or MUST removed) on that leaf line would still match. Full-line
// deletion (tested above) does not prove polarity-binding; this test proves
// it directly by mutating only the MUST token on the live line and asserting
// the anchor goes red, while the unmutated line still matches.
// ---------------------------------------------------------------------------

test("prefers-color-scheme anchor is polarity-bound: a MUST -> SHOULD downgrade on its own line goes unmatched (F-W8)", () => {
  const anchor = OPERATIVE_ANCHORS.find((a) => a.name.includes("F-W8"));
  assert.ok(anchor, "F-W8 anchor entry not found in OPERATIVE_ANCHORS");
  const lines = targets[anchor.target].split("\n");
  const hitIndex = lines.findIndex((line) => anchor.rx.test(line));
  assert.notEqual(hitIndex, -1, "F-W8 anchor did not match any live line");
  const originalLine = lines[hitIndex];
  assert.ok(originalLine.includes("**MUST**"), "sanity: live line must contain **MUST** for this mutation to be meaningful");

  const downgraded = originalLine.replace("**MUST**", "**SHOULD**");
  assert.notEqual(downgraded, originalLine, "mutation did not apply; MUST literal changed upstream");
  assert.ok(!anchor.rx.test(downgraded), "F-W8 anchor stayed GREEN after downgrading MUST to SHOULD on its own line");
});

// ---------------------------------------------------------------------------
// Three closed-set bidirectional equality assertions, each backed by a live
// insertion-side AND removal-side counter-run (not a hypothetical claim) —
// per rule-anchor-guard-strength.md's guidance for value-set anchors.
// ---------------------------------------------------------------------------

function assertClosedSetEquality(actualSetText, expected, label) {
  const actual = actualSetText.split(",").map((s) => s.trim()).filter(Boolean);
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  assert.deepEqual(
    actualSorted,
    expectedSorted,
    `${label}: expected {${expectedSorted.join(", ")}} got {${actualSorted.join(", ")}}`,
  );
}

// round 23/W4: scoped to the ### Theme section specifically (not a whole-leaf
// .match(), which would silently accept the FIRST `封閉集 \`{...}\`` literal in
// the file — the leaf has a second, non-operative copy of this exact literal
// in the Exit Criteria section (:201), and an unscoped .match() would only
// happen to land on the right one by positional accident). Requiring exactly
// one match within the Theme section makes a stray extra copy fail loudly
// instead of being silently ignored.
function extractThemeClosedSet(leafText) {
  const themeBody = extractH3Body(leafText, /^### Theme[^\n]*\n/m);
  const matches = [...themeBody.matchAll(/封閉集 `\{([^`}]*)\}`/g)];
  assert.equal(matches.length, 1, `expected exactly one theme closed-set literal within ### Theme, found ${matches.length}`);
  return matches[0][1];
}

test("theme value domain is exactly the closed set {light, dark}", () => {
  assertClosedSetEquality(extractThemeClosedSet(targets.leaf), ["light", "dark"], "theme domain");

  const original = extractH3Body(targets.leaf, /^### Theme[^\n]*\n/m).match(/封閉集 `\{[^`}]*\}`/)[0];

  // insertion-side counter-proof: an extra member injected into the REAL
  // source declaration, through the SAME extraction path (not a hand-authored
  // string bypassing assertClosedSetEquality's caller), must break equality.
  const withExtraMember = targets.leaf.replace(original, original.replace("{light, dark}", "{light, dark, system}"));
  assert.throws(() => assertClosedSetEquality(extractThemeClosedSet(withExtraMember), ["light", "dark"], "theme domain"));

  // removal-side counter-proof: a dropped member, same real-source path.
  const withDroppedMember = targets.leaf.replace(original, original.replace("{light, dark}", "{light}"));
  assert.throws(() => assertClosedSetEquality(extractThemeClosedSet(withDroppedMember), ["light", "dark"], "theme domain"));
});

function extractLocaleStages(text) {
  const m = text.match(/優先序：(.*?)。每一段/);
  assert.ok(m, "locale priority sequence not found");
  return m[1].split("→").map((s) => s.replace(/`/g, "").trim());
}

test("locale priority is exactly the four-stage sequence in order", () => {
  const stages = extractLocaleStages(targets.leaf);
  assert.deepEqual(stages, ["query string", "cookie", "Accept-Language", "fallback"]);

  const original = targets.leaf.match(/優先序：.*?。每一段/)[0];

  // insertion-side counter-proof: an extra stage must break the sequence,
  // through the SAME extraction regex against a mutated leaf text (not a
  // hand-authored array bypassing the extraction path)
  const withExtraStage = targets.leaf.replace(
    original,
    original.replace("`Accept-Language` → fallback", "`Accept-Language` → session storage → fallback"),
  );
  assert.notDeepEqual(extractLocaleStages(withExtraStage), stages);

  // removal-side counter-proof: a dropped stage must break the sequence,
  // through the same extraction path
  const withDroppedStage = targets.leaf.replace(
    original,
    original.replace("cookie → `Accept-Language` → fallback", "cookie → fallback"),
  );
  assert.notDeepEqual(extractLocaleStages(withDroppedStage), stages);
});

function extractInheritanceDomains(text) {
  return [...text.matchAll(/\(needed\|not-needed\)/g)].map((m) => m[0].slice(1, -1).split("|"));
}

test("web-theme:/web-locale: inheritance value domain is exactly {needed, not-needed}", () => {
  const domains = extractInheritanceDomains(targets.leaf);
  // exactly 2 copies expected: the ## When to Use prose (item-aware stage)
  // and its sole copy-executable judgment command; ## Verification MUST
  // pointer to the latter rather than re-paste it (F-b431260e37ce)
  assert.equal(domains.length, 2, `expected 2 alternation copies, found ${domains.length}`);
  for (const domain of domains) {
    assertClosedSetEquality(domain.join(", "), ["needed", "not-needed"], "web-theme/web-locale inheritance domain");
  }

  // insertion-side counter-proof: a third value must break equality
  assert.throws(() => assertClosedSetEquality("needed, not-needed, maybe", ["needed", "not-needed"], "inheritance domain"));
  // removal-side counter-proof: a missing member must break equality too
  assert.throws(() => assertClosedSetEquality("needed", ["needed", "not-needed"], "inheritance domain"));

  assert.ok(targets.leaf.includes("web-theme:"), "web-theme: anchor prefix missing");
  assert.ok(targets.leaf.includes("web-locale:"), "web-locale: anchor prefix missing");
});

// ---------------------------------------------------------------------------
// splitListItems SSOT: the leaf's copy-executable judgment command MUST
// import the shared splitter and MUST NOT reimplement it locally.
// ---------------------------------------------------------------------------

function extractCodeFences(text) {
  return [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
}

test("leaf's judgment command imports splitListItems and defines no local splitter", () => {
  assert.match(targets.leaf, /import \{[^}]*splitListItems[^}]*\}\s*\n?\s*from ["']\.\/\.devpro\/scripts\/lib\/clarification-contract\.mjs["']/);

  // Scoped to actual code (fenced blocks), not the leaf's own prose
  // describing the prohibited shapes it bans (e.g. the literal string
  // "[;|]" appears in ## When to Use's prose warning against it).
  const code = extractCodeFences(targets.leaf);
  assert.equal(
    (code.match(/(?:const|let|function)\s+split\w*/g) || []).length,
    0,
    "leaf MUST NOT define a local split/splitter identifier (SSOT violation)",
  );
  assert.equal(
    (code.match(/\.split\(\s*["'][;|]["']\s*\)/g) || []).length,
    0,
    "leaf MUST NOT hand-roll a direct .split(\";\") or .split(\"|\") (SSOT violation)",
  );
  assert.equal(
    (code.match(/\[;\|\]/g) || []).length,
    0,
    "leaf MUST NOT hand-roll a combined [;|] splitter regex (SSOT violation)",
  );
});

// ---------------------------------------------------------------------------
// T15 (F11, decisions.md D15/D19): CE-1~CE-7 counter-examples + the F9
// conflict counter-examples (CF-1 same-file, CF-2 cross-file) landed as
// in-repo executable fixtures, replacing the scratchpad-only comparisons
// referenced by decisions.md D10/D11. Fixtures are in-memory strings ONLY —
// per decisions.md D19 they MUST NOT live under openspec/changes/** as an
// actual meeting-notes.md, because the judgment command recursively scans
// that exact filename and would treat a real fixture file as genuine
// inheritance evidence for every other change in the repo.
//
// The harness below is the SAME four-stage procedure as the leaf's
// copy-executable judgment command (section -> field -> separator-integrity
// -> item, using countH2Sections / extractSection / parseBulletFields /
// hasMixedListSeparators / splitListItems from clarification-contract.mjs,
// per design.md :295's SSOT requirement), plus the F9 conflict fail-closed
// rule (needed and not-needed both present for the same dimension, within
// one file's decisions field or across files, => not inherited).
// round 23/W1: renumbered from three to four stages — the round 22/F-page1
// mixed-separator guard (hasMixedListSeparators, see dimensionValuesInDocument
// below) was already implemented here but this comment had not been updated
// to enumerate it as its own stage.
// ---------------------------------------------------------------------------

const ITEM_ANCHOR_RX = (prefix) =>
  new RegExp(`^${prefix}:\\s*(needed|not-needed)\\s*\\(provenance: user\\)$`);

/** @returns {string[]} the (needed|not-needed) values a single document yields for `prefix` */
function dimensionValuesInDocument(md, prefix) {
  if (countH2Sections(md, "Clarification State") !== 1) return []; // CE-4 / CE-5
  const { fields, errors } = parseBulletFields(extractSection(md, "Clarification State"));
  if (errors.includes("duplicate field: decisions")) return []; // CF-3 (F-W1)
  if (hasMixedListSeparators(fields.decisions || "")) return []; // round 22/F-page1: pre-existing mixed-separator corruption MUST NOT be trusted, even if one ;-split chunk would otherwise pass the item anchor
  const re = ITEM_ANCHOR_RX(prefix);
  return splitListItems(fields.decisions || "")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((i) => i.match(re))
    .filter(Boolean)
    .map((m) => m[1]);
}

/**
 * Evaluates one dimension across a corpus of meeting-notes.md documents
 * (mirrors the leaf's judgment command aggregating hits across the whole
 * `openspec/changes/**\/meeting-notes.md` tree) and applies the F9 conflict
 * fail-closed rule.
 * @param {string[]} mdDocuments
 * @param {"web-theme"|"web-locale"} prefix
 */
function evaluateDimension(mdDocuments, prefix) {
  const values = mdDocuments.flatMap((md) => dimensionValuesInDocument(md, prefix));
  const valueSet = [...new Set(values)];
  if (valueSet.length === 0) return { inherited: false, reason: "no-qualifying-item" };
  if (valueSet.length > 1) return { inherited: false, reason: "conflict" };
  return { inherited: true, value: valueSet[0] };
}

// round 13/F-W23, round 14/T44-finding-2, round 15/F-W29, round 21/finding-1
// (claim B): leak-detection needs a marker that could only appear if literal
// fixture TEXT (not just structurally-similar organic content) was pasted
// into a real file. Defined here (before the fixtures) as the single SSOT for
// the sentinel's exact bytes, and those exact bytes are inlined as the first
// line of every fixture's own `md`/`mdDocuments` string LITERAL below — not
// produced by a `.map()` over a separate sentinel-free `RAW_*` source array
// (round 14's gap), and not concatenated on via a separate
// `FIXTURE_LEAK_SENTINEL + "..."` expression (round 21/finding-1's gap: a
// human intending to copy "the Markdown body" naturally selects only the
// quoted string, skipping an identifier+operator that reads as code rather
// than content). With the bytes inlined into the same quoted string, the
// natural copy unit always carries the sentinel. A drift guard below asserts
// every fixture literal still starts with this exact constant. Copying only
// the body PAST the sentinel line remains — and must remain — undetectable:
// that is Claim A, proven byte-identical to organic content and closed by
// round 18 (see the two tests below for the A/B split in full).
const FIXTURE_LEAK_SENTINEL = "<!-- devpro-test-fixture:web-theme-locale-probe-grep.test.mjs:T15 -->\n";

// --- Single-document fixtures: positive control + CE-1~CE-7 + CF-1 (same-file conflict) ---
// Sentinel is the first literal characters of every `md:` value — countH2Sections/
// extractSection/parseBulletFields all anchor on `## <heading>`, so a comment line
// before the first heading is inert to parsing and does not change any
// evaluateDimension() result used by the structural tests.
export const CE_FIXTURES = Object.freeze([
  {
    id: "POS-1",
    label: "positive control: qualifying item inherits",
    md: "<!-- devpro-test-fixture:web-theme-locale-probe-grep.test.mjs:T15 -->\n## Clarification State\n- decisions: web-theme: needed (provenance: user)\n",
    expectInherited: true,
  },
  {
    id: "CE-1",
    label: "same-shaped bullet outside the Clarification State section",
    md:
      "<!-- devpro-test-fixture:web-theme-locale-probe-grep.test.mjs:T15 -->\n## 完整計畫\n" +
      "web-theme: needed (provenance: user)\n\n" +
      "## Clarification State\n- decisions: (empty)\n",
    expectInherited: false,
  },
  {
    id: "CE-2",
    label: "same-shaped item inside the section but under frontier:, not decisions:",
    md: "<!-- devpro-test-fixture:web-theme-locale-probe-grep.test.mjs:T15 -->\n## Clarification State\n- frontier: web-theme: needed (provenance: user)\n- decisions: (empty)\n",
    expectInherited: false,
  },
  {
    id: "CE-3-field",
    label: "unresolved: field barrier — item lives under unresolved:, not decisions:",
    md:
      "<!-- devpro-test-fixture:web-theme-locale-probe-grep.test.mjs:T15 -->\n## Clarification State\n" +
      "- unresolved: UNRESOLVED: web-theme: needed (provenance: user)\n" +
      "- decisions: (empty)\n",
    expectInherited: false,
  },
  {
    id: "CE-3-item",
    label: "item-anchor barrier — UNRESOLVED: prefix inside decisions: rejected by ^web-theme: anchor",
    md: "<!-- devpro-test-fixture:web-theme-locale-probe-grep.test.mjs:T15 -->\n## Clarification State\n- decisions: UNRESOLVED: web-theme: needed (provenance: user)\n",
    expectInherited: false,
  },
  {
    id: "CE-4",
    label: "duplicate Clarification State sections in one file",
    md:
      "<!-- devpro-test-fixture:web-theme-locale-probe-grep.test.mjs:T15 -->\n## Clarification State\n- decisions: web-theme: needed (provenance: user)\n\n" +
      "## Clarification State\n- decisions: web-theme: needed (provenance: user)\n",
    expectInherited: false,
  },
  {
    id: "CE-5",
    label: "no Clarification State section at all",
    md: "<!-- devpro-test-fixture:web-theme-locale-probe-grep.test.mjs:T15 -->\n## 完整計畫\n- decisions: web-theme: needed (provenance: user)\n",
    expectInherited: false,
  },
  {
    id: "CE-6",
    label: "item missing the (provenance: user) suffix",
    md: "<!-- devpro-test-fixture:web-theme-locale-probe-grep.test.mjs:T15 -->\n## Clarification State\n- decisions: web-theme: needed\n",
    expectInherited: false,
  },
  {
    id: "CE-7",
    label: "value outside the {needed, not-needed} closed set",
    md: "<!-- devpro-test-fixture:web-theme-locale-probe-grep.test.mjs:T15 -->\n## Clarification State\n- decisions: web-theme: maybe (provenance: user)\n",
    expectInherited: false,
  },
  {
    id: "CF-1",
    label: "F9 conflict, same file: both needed and not-needed qualify in one decisions: field",
    md:
      "<!-- devpro-test-fixture:web-theme-locale-probe-grep.test.mjs:T15 -->\n## Clarification State\n" +
      "- decisions: web-theme: needed (provenance: user); web-theme: not-needed (provenance: user)\n",
    expectInherited: false,
  },
  {
    id: "CF-3",
    label: "F-W1 duplicate field, same file: two physical `- decisions:` bullet lines in one section; the first line alone would qualify as needed if the errors array were not inspected",
    md:
      "<!-- devpro-test-fixture:web-theme-locale-probe-grep.test.mjs:T15 -->\n## Clarification State\n" +
      "- decisions: web-theme: needed (provenance: user)\n" +
      "- decisions: web-theme: not-needed (provenance: user)\n",
    expectInherited: false,
  },
  {
    id: "DM-1",
    label: "F-W10 delimiter-mixing pitfall (NOT part of the frozen CE-1~CE-7 set, decisions.md D23 — a different defect class: append-time delimiter mismatch, not a structural/shape counter-example): appending a ;-joined web-theme item onto an existing |-delimited decisions value merges the prior pipe items into one blob, so an earlier valid web-locale: item silently stops matching its own item-anchor",
    md:
      "<!-- devpro-test-fixture:web-theme-locale-probe-grep.test.mjs:T15 -->\n## Clarification State\n" +
      "- decisions: web-locale: not-needed (provenance: user) | D2 unrelated decision (provenance: user); web-theme: needed (provenance: user)\n",
    expectInherited: false,
    dimension: "web-locale",
  },
  {
    id: "DM-2",
    label: "round 22/F-page1: read-side mixed-separator bypass — the value mixes ; and | (same MUST-NOT-mix violation as DM-1), but its FIRST `;`-split chunk happens to be a clean, fully-anchored web-theme item on its own; without an explicit hasMixedListSeparators() guard at the scan site, splitListItems' ;-priority split would still yield that chunk as a valid hit and treat the corrupted document as inherited",
    md:
      "<!-- devpro-test-fixture:web-theme-locale-probe-grep.test.mjs:T15 -->\n## Clarification State\n" +
      "- decisions: web-theme: needed (provenance: user); web-locale: needed (provenance: user) | stray unrelated text (provenance: user)\n",
    expectInherited: false,
    dimension: "web-theme",
  },
]);

// --- Composed fixture: CF-2, the cross-file conflict form (two documents) ---
export const CROSS_FILE_CONFLICT_FIXTURES = Object.freeze([
  {
    id: "CF-2",
    label: "F9 conflict, cross-file: one qualifying item each in two different meeting-notes.md",
    mdDocuments: [
      "<!-- devpro-test-fixture:web-theme-locale-probe-grep.test.mjs:T15 -->\n## Clarification State\n- decisions: web-theme: needed (provenance: user)\n",
      "<!-- devpro-test-fixture:web-theme-locale-probe-grep.test.mjs:T15 -->\n## Clarification State\n- decisions: web-theme: not-needed (provenance: user)\n",
    ],
    expectInherited: false,
  },
]);

test("round 21/finding-1 (claim B) drift guard: every fixture's md/mdDocuments literal starts with the exact FIXTURE_LEAK_SENTINEL bytes, so the inlined copies cannot silently drift from the named constant", () => {
  for (const fx of CE_FIXTURES) {
    assert.ok(fx.md.startsWith(FIXTURE_LEAK_SENTINEL), `${fx.id}: md must start with FIXTURE_LEAK_SENTINEL`);
  }
  for (const fx of CROSS_FILE_CONFLICT_FIXTURES) {
    for (const doc of fx.mdDocuments) {
      assert.ok(doc.startsWith(FIXTURE_LEAK_SENTINEL), `${fx.id}: each mdDocuments entry must start with FIXTURE_LEAK_SENTINEL`);
    }
  }
});

test("T15/T23/T31 CE-1~CE-7 + CF-1/CF-3 + DM-1/DM-2 single-document fixtures evaluate as designed (F11/F9/F-W1/F-W10/round-22-F-page1)", () => {
  assert.equal(CE_FIXTURES.length, 13, "fixture count drifted; update decisions.md D10/D11/D37 references (T16/T31) if this is intentional");
  for (const fx of CE_FIXTURES) {
    const result = evaluateDimension([fx.md], fx.dimension || "web-theme");
    assert.equal(result.inherited, fx.expectInherited, `${fx.id} (${fx.label}): expected inherited=${fx.expectInherited}, got ${JSON.stringify(result)}`);
  }
});

test("round 22/F-page1: the read-side mixed-separator guard has teeth — WITHOUT it, DM-2's corrupted value would still yield a false-positive web-theme hit via splitListItems' ;-priority split alone", () => {
  const dm2 = CE_FIXTURES.find((fx) => fx.id === "DM-2");
  assert.ok(dm2, "DM-2 fixture missing");
  const { decisions: dm2Value } = parseBulletFields(extractSection(dm2.md, "Clarification State")).fields;
  assert.ok(hasMixedListSeparators(dm2Value), "DM-2's decisions: value must mix ; and | (that is the whole point of the fixture)");
  const unguardedHits = splitListItems(dm2Value)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((i) => i.match(ITEM_ANCHOR_RX("web-theme")))
    .filter(Boolean);
  assert.equal(unguardedHits.length, 1, "sanity check: without the guard, DM-2's first ;-split chunk MUST still pass the web-theme item anchor on its own — otherwise this fixture does not exercise the bypass it claims to");
  // dimensionValuesInDocument (the guarded path under test) must reject the whole document instead.
  assert.deepEqual(dimensionValuesInDocument(dm2.md, "web-theme"), [], "the guarded scan path MUST return no hits for a mixed-separator document, even though the unguarded split alone would produce one");
});

test("round 21/F-page18: hasMixedListSeparators() detects a pre-existing decisions: value already containing both `;` and `|`, and stays negative for well-formed single-separator and empty values", () => {
  const dm1 = CE_FIXTURES.find((fx) => fx.id === "DM-1");
  assert.ok(dm1, "DM-1 fixture missing");
  const { decisions: dm1Value } = parseBulletFields(extractSection(dm1.md, "Clarification State")).fields;
  assert.ok(
    hasMixedListSeparators(dm1Value),
    "DM-1's decisions: value already mixes ; and | (that is the whole point of the fixture) — hasMixedListSeparators() MUST flag it"
  );
  assert.equal(hasMixedListSeparators("web-theme: needed (provenance: user); web-locale: not-needed (provenance: user)"), false, "a well-formed ;-only value MUST NOT be flagged");
  assert.equal(hasMixedListSeparators("D1 …… (provenance: user) | D2 …… (provenance: user)"), false, "a well-formed |-only value MUST NOT be flagged");
  assert.equal(hasMixedListSeparators("(empty)"), false, "an empty/single-item value MUST NOT be flagged");
});

test("T23 CF-3 fixture actually exercises the duplicate-field error path (F-W1)", () => {
  const cf3 = CE_FIXTURES.find((fx) => fx.id === "CF-3");
  assert.ok(cf3, "CF-3 fixture missing");
  const { errors } = parseBulletFields(extractSection(cf3.md, "Clarification State"));
  assert.ok(
    errors.includes("duplicate field: decisions"),
    `CF-3 fixture must trigger parseBulletFields' duplicate-field error, got errors=${JSON.stringify(errors)}`,
  );
});

test("T15 CF-2 cross-file conflict fixture evaluates as not-inherited (F9)", () => {
  assert.equal(CROSS_FILE_CONFLICT_FIXTURES.length, 1);
  for (const fx of CROSS_FILE_CONFLICT_FIXTURES) {
    const result = evaluateDimension(fx.mdDocuments, "web-theme");
    assert.equal(result.inherited, fx.expectInherited, `${fx.id} (${fx.label}): expected inherited=${fx.expectInherited}, got ${JSON.stringify(result)}`);
    assert.equal(result.reason, "conflict", `${fx.id}: expected fail-closed reason "conflict"`);
  }
});

// round 13/F-W23: raw fixture-body substring matching produced a false-positive
// risk — POS-1's md ("## Clarification State\n- decisions: web-theme: needed
// (provenance: user)\n") is not just fixture text, it is ALSO exactly what a
// real, legitimate, minimal single-decision meeting-notes.md would contain.
// Comparing content.includes(rawFixtureBody) would reject that legitimate file
// as a "leak". Fix (round 13/F-W23, corrected round 15/F-W29): the sentinel is
// now written directly into each fixture's `md`/`mdDocuments` string LITERAL
// above, not produced by a `.map()` over a separate sentinel-free source array.
// Round 14's `.map()`-wrapper fix left the underlying literal (what a human
// reading this file's source and copy-pasting would actually get) sentinel-free;
// round 15 cross-model review correctly re-flagged that gap. Because the
// sentinel is now part of each fixture's own literal text, `CE_FIXTURES`/
// `CROSS_FILE_CONFLICT_FIXTURES` need no further wrapping.

// All fixture md content, flattened and de-duplicated (CF-2's first document
// happens to be textually identical to POS-1's), already sentinel-bearing, for
// the leak-detection scan below.
const ALL_FIXTURE_MD_STRINGS = [
  ...new Set([
    ...CE_FIXTURES.map((fx) => fx.md),
    ...CROSS_FILE_CONFLICT_FIXTURES.flatMap((fx) => fx.mdDocuments),
  ]),
];

/**
 * Returns diagnostic evidence of fixture leakage in `content`. Exact
 * `fixtureStrings` matches are returned for attribution when present. When no
 * exact match exists but the bare sentinel marker itself is present, that
 * marker is returned instead — a real author never writes this internal
 * comment, so its presence alone is proof of a leaked fixture even if the
 * copied body was altered by one or more characters after the sentinel
 * (round 16/F-W34: a whole-fixture-string `includes()` check alone lets a
 * single-character mutation of the copied body evade detection while the
 * sentinel — the actual leak signal — still sits unmodified in the file).
 */
function leakedFixtures(content, fixtureStrings) {
  const exactMatches = fixtureStrings.filter((fx) => content.includes(fx));
  if (exactMatches.length > 0) return exactMatches;
  const sentinelMarker = FIXTURE_LEAK_SENTINEL.trim();
  return content.includes(sentinelMarker) ? [sentinelMarker] : [];
}

/** Recursively finds every file literally named `meeting-notes.md` under `dir`. */
function findMeetingNotesFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && e.name === "meeting-notes.md")
    .map((e) => joinPath(e.parentPath ?? e.path, e.name));
}

test("T15 fixtures MUST NOT be present in any real meeting-notes.md under openspec/changes/** (F11 negative assertion)", () => {
  // Content-based, commit-independent: unlike a `git status`/`git diff`
  // comparison (which only flags CHANGES relative to a ref and goes silently
  // green again the moment T15's edits are committed), this scans the actual
  // file content every time it runs — including after commit — for the exact
  // in-memory fixture text landing inside a file the judgment command's
  // recursive `openspec/changes/**/meeting-notes.md` scan treats as real
  // inheritance evidence (decisions.md D19's exact concern).
  const files = findMeetingNotesFiles(repoPath("openspec/changes"));
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const leaked = leakedFixtures(content, ALL_FIXTURE_MD_STRINGS);
    assert.deepEqual(leaked, [], `T15 fixture text MUST NOT appear in ${file}: ${leaked.join(" | ")}`);
  }
});

test("T15 negative assertion counter-run: leakedFixtures() has teeth (detects an UNMODIFIED, verbatim copy-paste of a fixture's own .md body embedded in a document, round 14/T44 finding 2)", () => {
  // Deterministic proof the check above is not vacuously green: feed it a
  // synthetic document that DOES contain one fixture's exact `.md` value
  // verbatim (as if someone copy-pasted CE_FIXTURES[0].md straight out of this
  // test file into a real meeting-notes.md, sentinel included since the
  // sentinel is now baked into the fixture's own body — not a derived wrapper
  // a copy-paste could omit) and confirm it is flagged. Does not depend on
  // real repo file content, so it stays a valid counter-run regardless of what
  // else is committed under openspec/changes/.
  const leakedDocument = `## 完整計畫\n\n${ALL_FIXTURE_MD_STRINGS[0]}\n`;
  const leaked = leakedFixtures(leakedDocument, ALL_FIXTURE_MD_STRINGS);
  assert.deepEqual(leaked, [ALL_FIXTURE_MD_STRINGS[0]], "counter-run MUST detect the embedded, unmodified fixture body; a no-op check would not");
});

test("T15 negative assertion counter-run (round 16/F-W34): a sentinel-bearing fixture copy mutated by a single character is STILL detected, closing the whole-fixture-string escape", () => {
  // Simulates someone copying a sentinel-bearing fixture body into a real
  // document and then altering one character of the copied body (typo fix,
  // rewording, accidental edit) while leaving the sentinel comment itself
  // untouched. A pre-F-W34 `content.includes(fx)` check over the COMPLETE
  // fixture string would silently miss this — the mutated body no longer
  // equals the original fixture string, but the sentinel (the actual leak
  // signal) is still present verbatim.
  const original = ALL_FIXTURE_MD_STRINGS[0];
  const mutated = original.slice(0, -2) + "X" + original.slice(-1);
  assert.notEqual(mutated, original, "test premise: the mutated copy must differ from every known fixture string");
  assert.ok(!ALL_FIXTURE_MD_STRINGS.includes(mutated), "test premise: the mutated copy must not coincidentally equal a different fixture");
  const leakedDocument = `## 完整計畫\n\n${mutated}\n`;
  const leaked = leakedFixtures(leakedDocument, ALL_FIXTURE_MD_STRINGS);
  assert.notDeepEqual(leaked, [], "a one-character-mutated sentinel-bearing copy MUST still be flagged as a leak");
});

test("T15 literal-copy regression (round 15/F-W29; superseded round 21/finding-1 claim B; localization fixed round 22/F-page5+F-page27): the sentinel is present in POS-1's OWN SOURCE TEXT as the literal first line of the SAME quoted string as its fixture body, not appended via a separate identifier + operator a body-only copy-paste could skip", () => {
  // Reads this test file's own source bytes and greps for the sentinel bytes
  // inlined directly inside POS-1's fixture body string literal. Round 15
  // flagged round 14's `.map()`-based indirection (sentinel only on the
  // exported, module-eval-derived constant, not the source literal). Round
  // 15's fix used `FIXTURE_LEAK_SENTINEL + "body"` — the sentinel was in the
  // literal EXPRESSION, but round 21/finding-1 (claim B) correctly observed
  // that a human intending to copy "the Markdown body" naturally selects only
  // the quoted string after the `+`, which reads as content, while
  // `FIXTURE_LEAK_SENTINEL +` reads as code and is easy to skip. This
  // assertion now checks the stronger inlined form: the sentinel's exact
  // bytes are the first line INSIDE the same quoted string, so selecting
  // "the quoted string" (the natural copy unit) always carries the sentinel.
  //
  // round 22/F-page5+F-page27 correction: the earlier version of this
  // assertion searched the WHOLE file (`thisFileSource.includes(...)`), which
  // is not actually localized to POS-1 — CF-2's first `mdDocuments` entry
  // happens to share byte-identical content, so this assertion would have
  // stayed green even if POS-1 alone regressed back to the old concatenation
  // form, as long as CF-2 remained inlined. Bound the search to POS-1's own
  // fixture object text specifically so the assertion can only pass because
  // of POS-1's own declaration.
  const thisFileSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const pos1BlockStart = thisFileSource.indexOf('id: "POS-1",');
  assert.notEqual(pos1BlockStart, -1, "POS-1 fixture declaration not found in this file's own source");
  const pos1BlockEnd = thisFileSource.indexOf("\n  },", pos1BlockStart);
  assert.notEqual(pos1BlockEnd, -1, "POS-1 fixture object's closing brace not found");
  const pos1SourceBlock = thisFileSource.slice(pos1BlockStart, pos1BlockEnd);
  const inlinedLiteral =
    '"<!-- devpro-test-fixture:web-theme-locale-probe-grep.test.mjs:T15 -->\\n## Clarification State\\n- decisions: web-theme: needed (provenance: user)\\n"';
  assert.ok(
    pos1SourceBlock.includes(inlinedLiteral),
    "POS-1's `md:` source literal MUST inline the sentinel's exact bytes as the first line of the same quoted string, not concatenate them via a separate identifier + operator"
  );
});

test("round 22/F-page5+F-page27: the localized POS-1 drift-guard has teeth — mutating POS-1's own block back to the old concatenation form fails, even though an unrelated fixture (CF-2) still carries the identical inlined bytes elsewhere in the file", () => {
  const thisFileSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const pos1BlockStart = thisFileSource.indexOf('id: "POS-1",');
  const pos1BlockEnd = thisFileSource.indexOf("\n  },", pos1BlockStart);
  const pos1SourceBlock = thisFileSource.slice(pos1BlockStart, pos1BlockEnd);
  const inlinedLiteral =
    '"<!-- devpro-test-fixture:web-theme-locale-probe-grep.test.mjs:T15 -->\\n## Clarification State\\n- decisions: web-theme: needed (provenance: user)\\n"';
  // Sanity: the unrelated CF-2 block elsewhere in the file DOES carry this
  // exact literal (documented coincidence, not a bug) — that is precisely
  // why the whole-file version of this assertion was vacuous.
  assert.ok(
    thisFileSource.includes(inlinedLiteral),
    "test premise: the exact inlined literal must still exist SOMEWHERE else in the file (CF-2), or this counter-test proves nothing"
  );
  const mutatedPos1Block = pos1SourceBlock.replace(
    inlinedLiteral,
    'FIXTURE_LEAK_SENTINEL + "## Clarification State\\n- decisions: web-theme: needed (provenance: user)\\n"'
  );
  assert.notEqual(mutatedPos1Block, pos1SourceBlock, "test premise: the replace must actually change POS-1's block");
  assert.equal(
    mutatedPos1Block.includes(inlinedLiteral),
    false,
    "once POS-1's own block is mutated back to the concatenation form, the BOUNDED (POS-1-only) check MUST fail — proving the assertion above is actually localized, not passing via CF-2's coincidental match"
  );
});

test("T15 positive legitimate-note counter-test (F-W23/round 13): an organic, sentinel-free meeting-notes.md structurally identical to POS-1's original content MUST NOT be flagged as a fixture leak", () => {
  // Hardcoded independently of CE_FIXTURES (which now always carries the
  // sentinel baked into its literal — see FIXTURE_LEAK_SENTINEL note above
  // CE_FIXTURES): this is POS-1's clinical content BEFORE the sentinel, exactly
  // what a real single-decision meeting-notes.md could legitimately contain.
  // Before F-W23, raw fixture-body substring matching would have rejected this
  // legitimate file as a "leak" purely because its content happens to coincide
  // with the fixture's. A real author never writes our internal sentinel
  // comment, so this document proves the sentinel-bearing scan no longer
  // false-positives on organic, sentinel-free content.
  const organicLegitimateDocument = "## Clarification State\n- decisions: web-theme: needed (provenance: user)\n";
  assert.ok(
    !organicLegitimateDocument.includes(FIXTURE_LEAK_SENTINEL.trim()),
    "test premise: the organic document must not itself already contain the sentinel"
  );
  const leaked = leakedFixtures(organicLegitimateDocument, ALL_FIXTURE_MD_STRINGS);
  assert.deepEqual(leaked, [], "a real, sentinel-free file with legitimate single-decision content MUST NOT be flagged as a fixture leak");
});

test("round 18/F-t44-sentinel-scan-bypass verification (re-verified round 21/finding-1 claim A): a fixture body copied WITHOUT its sentinel is intentionally indistinguishable from organic content, not a bug — the two prior tests above are the same boundary from opposite sides", () => {
  // round 18 flagged: "T44 prepends the leak sentinel only to the scan
  // needles, not to the canonical fixture .md values, so realistic
  // sentinel-free fixture copies evade leakedFixtures()". Two things are
  // wrong with that framing as applied to the CURRENT code (verified by
  // reading ALL_FIXTURE_MD_STRINGS above, ~line 842): (a) the "scan needle"
  // and "canonical fixture .md value" are the exact same string — T51
  // (round 15/F-W29) already collapsed the indirection this finding
  // describes; (b) even if they were separate, making a sentinel-stripped
  // copy detectable is IMPOSSIBLE without reintroducing F-W23 (round 13):
  // the sentinel is the ONLY signal that distinguishes "someone copy-pasted
  // this fixture and stripped just the sentinel line" from "an author wrote
  // organically identical content by coincidence" — the test immediately
  // above (F-W23) proves the latter MUST NOT be flagged. A detector cannot
  // honor both "flag sentinel-free copies" (this finding's ask) and "never
  // flag sentinel-free organic content" (F-W23's ask) for the same input,
  // because after stripping the sentinel the two inputs are byte-identical.
  //
  // Round 21/finding-1 re-raised this same concern and split into two
  // claims: Claim A ("a body-only copy evades detection") is this test,
  // re-verified as correctly closed — the byte-identity argument above still
  // holds and is not affected by anything else changed this round. Claim B
  // ("the sentinel sits behind a `FIXTURE_LEAK_SENTINEL +` code token a
  // human would naturally skip while copying just the body") was a distinct,
  // real, fixable gap that round 18 never addressed — see the literal-copy
  // regression test above, which now asserts the inlined form applied to
  // close it.
  const fixtureBodyWithoutSentinel = ALL_FIXTURE_MD_STRINGS[0].slice(FIXTURE_LEAK_SENTINEL.length);
  assert.ok(fixtureBodyWithoutSentinel.length > 0, "test premise: fixture has body content beyond the sentinel prefix");
  assert.ok(
    !fixtureBodyWithoutSentinel.includes(FIXTURE_LEAK_SENTINEL.trim()),
    "test premise: stripping the sentinel prefix must not leave a residual sentinel elsewhere in the body"
  );
  const leaked = leakedFixtures(fixtureBodyWithoutSentinel, ALL_FIXTURE_MD_STRINGS);
  assert.deepEqual(
    leaked,
    [],
    "a sentinel-stripped fixture copy is BY DESIGN treated identically to organic content (F-W23) — this is the required, not accidental, behavior at this boundary"
  );
});

// ---------------------------------------------------------------------------
// round 24/finding-2: the literal-copy regression above is bounded to POS-1's
// source block only, and the round-21 drift guard evaluates fixture VALUES
// (`fx.md.startsWith(...)`), which cannot tell an inlined sentinel apart from
// a `FIXTURE_LEAK_SENTINEL + "body"` or `"<sentinel>\n" + "body"` concatenation
// — the exact claim-B gap, just in any fixture other than POS-1. Generalize:
// every fixture's SOURCE block must carry the sentinel bytes inline as the
// first line of the SAME quoted string as its first body line, once per
// document, and must never reference the named constant.
const SENTINEL_SOURCE_LITERAL_PREFIX = '"<!-- devpro-test-fixture:web-theme-locale-probe-grep.test.mjs:T15 -->\\n';

function fixtureSourceBlock(source, id) {
  const start = source.indexOf(`id: "${id}",`);
  if (start === -1) throw new Error(`fixture ${id} declaration not found in this file's own source`);
  const end = source.indexOf("\n  },", start);
  if (end === -1) throw new Error(`fixture ${id} object's closing brace not found`);
  return source.slice(start, end);
}

/**
 * Returns the list of source-literal violations for one fixture block.
 * `expectedDocs` is the number of md documents the fixture declares (1 for
 * `md`, N for `mdDocuments`), each of which must open with exactly one
 * inlined sentinel prefix that is immediately followed by body bytes.
 */
function fixtureSourceLiteralViolations(block, expectedDocs) {
  const violations = [];
  if (block.includes("FIXTURE_LEAK_SENTINEL")) violations.push("references the named constant instead of inlining the sentinel bytes");
  const inlined = block.split(SENTINEL_SOURCE_LITERAL_PREFIX).length - 1;
  if (inlined !== expectedDocs) violations.push(`expected ${expectedDocs} inlined sentinel literal(s), found ${inlined}`);
  // A sentinel that is its own quoted string (`-->\n" +`) is the claim-B shape:
  // the body lives in a separate literal a body-only copy would select alone.
  if (/-->\\n"\s*\+/.test(block)) violations.push("sentinel sits in its own quoted string, body concatenated via `+`");
  return violations;
}

test("round 24/finding-2: EVERY fixture's source block inlines the sentinel into the same quoted string as its body (not only POS-1)", () => {
  const thisFileSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const failures = [];
  for (const fx of CE_FIXTURES) {
    const v = fixtureSourceLiteralViolations(fixtureSourceBlock(thisFileSource, fx.id), 1);
    if (v.length) failures.push(`${fx.id}: ${v.join("; ")}`);
  }
  for (const fx of CROSS_FILE_CONFLICT_FIXTURES) {
    const v = fixtureSourceLiteralViolations(fixtureSourceBlock(thisFileSource, fx.id), fx.mdDocuments.length);
    if (v.length) failures.push(`${fx.id}: ${v.join("; ")}`);
  }
  assert.deepEqual(failures, [], `fixture source blocks whose sentinel is not inlined into the body's own quoted string: ${failures.join(" | ")}`);
});

test("round 24/finding-2 counter-run: the all-fixture source-literal check has teeth on a NON-POS-1 fixture (CE-1 mutated back to a separate-string sentinel, and to the named-constant form)", () => {
  const thisFileSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const ce1 = fixtureSourceBlock(thisFileSource, "CE-1");
  assert.deepEqual(fixtureSourceLiteralViolations(ce1, 1), [], "test premise: CE-1's current source block must be clean");
  const inlinedHead = `${SENTINEL_SOURCE_LITERAL_PREFIX}## 完整計畫\\n"`;
  assert.ok(ce1.includes(inlinedHead), "test premise: CE-1 must currently inline the sentinel with its first body line");
  const separateString = ce1.replace(inlinedHead, `${SENTINEL_SOURCE_LITERAL_PREFIX}" +\n      "## 完整計畫\\n"`);
  assert.notEqual(separateString, ce1, "test premise: mutation must change the block");
  assert.notDeepEqual(fixtureSourceLiteralViolations(separateString, 1), [], "separate-string sentinel form MUST be flagged");
  const namedConstant = ce1.replace(inlinedHead, 'FIXTURE_LEAK_SENTINEL + "## 完整計畫\\n"');
  assert.notEqual(namedConstant, ce1, "test premise: mutation must change the block");
  assert.notDeepEqual(fixtureSourceLiteralViolations(namedConstant, 1), [], "named-constant concatenation form MUST be flagged");
});

// ---------------------------------------------------------------------------
// round 24/finding-1: extractDomain() and EXCLUDED_FROM_DOMAIN only DECLARE the
// partition; nothing asserted that every heading in the leaf lands on one side
// of it. A future `### Cookie 保留` under `## Process`, or a MUST line added to
// `## Overview`, would sit outside the extraction domain AND outside the named
// excluded list, so its operative clauses would never reach the
// anchored-or-exempt classifier — silently reopening F10. Close the partition:
// every `##`/`###`/`####` heading must be (a) a domain root, (b) a heading
// contained in the extracted domain text, (c) a named EXCLUDED_FROM_DOMAIN
// section, or (d) a named structural section whose OWN body (up to the next
// heading of any level) is asserted MUST-free.
const DOMAIN_ROOT_HEADINGS = [/^## When to Use$/, /^### Theme（dark\/light）$/, /^### Locale（多語系\/i18n）$/];
const STRUCTURAL_MUST_FREE_SECTIONS = ["## Overview", "## Process", "### Enforcement Metadata"];

function ownBody(text, headingLine) {
  const idx = text.indexOf(`${headingLine}\n`);
  if (idx === -1) throw new Error(`heading not found: ${headingLine}`);
  const rest = text.slice(idx + headingLine.length + 1);
  const next = rest.match(/^#{2,4} /m);
  return next ? rest.slice(0, next.index) : rest;
}

function classifyLeafHeadings(leafText) {
  const body = stripFrontmatter(leafText);
  const domainText = extractDomain(body);
  const headings = body.split("\n").filter((l) => /^#{2,4} /.test(l));
  const unclassified = [];
  const structuralWithMust = [];
  for (const h of headings) {
    if (DOMAIN_ROOT_HEADINGS.some((rx) => rx.test(h))) continue;
    if (domainText.includes(`${h}\n`)) continue;
    if (EXCLUDED_FROM_DOMAIN.some(({ section }) => h === section || h.startsWith(`${section}（`))) continue;
    if (STRUCTURAL_MUST_FREE_SECTIONS.includes(h)) {
      const mustLines = ownBody(body, h).split("\n").filter((l) => /\bMUST\b/.test(l));
      if (mustLines.length) structuralWithMust.push(`${h}: ${JSON.stringify(mustLines[0])}`);
      continue;
    }
    unclassified.push(h);
  }
  return { headings, unclassified, structuralWithMust };
}

test("round 24/finding-1: heading closure — every leaf heading is a domain root, inside the extracted domain, a named excluded section, or a named MUST-free structural section", () => {
  const { headings, unclassified, structuralWithMust } = classifyLeafHeadings(targets.leaf);
  assert.ok(headings.length >= 10, `heading extraction produced suspiciously few headings (${headings.length}); extractor broken`);
  assert.deepEqual(unclassified, [], `leaf headings outside the domain partition (add to the domain, EXCLUDED_FROM_DOMAIN with a reason, or STRUCTURAL_MUST_FREE_SECTIONS): ${unclassified.join(" | ")}`);
  assert.deepEqual(structuralWithMust, [], `STRUCTURAL_MUST_FREE_SECTIONS now carry operative MUST lines that no classifier sees: ${structuralWithMust.join(" | ")}`);
  for (const s of STRUCTURAL_MUST_FREE_SECTIONS) {
    assert.ok(headings.includes(s), `STRUCTURAL_MUST_FREE_SECTIONS entry no longer resolves to a live heading: ${s}`);
  }
});

test("round 24/finding-1 counter-run: a new out-of-domain section carrying a MUST line is invisible to the F10 classifier but caught by the heading-closure test", () => {
  const injectedHeading = "### Cookie 保留（heading-closure counter-run 專用）";
  const injected = `${injectedHeading}\n\n- 本行 **MUST** 不對應任何 anchor、exempt entry 或 excluded section（round 24 counter-run 專用）。\n\n`;
  const leafWithMutation = targets.leaf.replace("## Process\n", `## Process\n\n${injected}`);
  assert.notEqual(leafWithMutation, targets.leaf, "test premise: the injection must land after `## Process`");
  // (a) the gap is real: F10's domain classifier never sees the injected MUST line
  assert.ok(
    !domainMustLines(leafWithMutation).some((l) => l.includes("round 24 counter-run 專用")),
    "test premise: the injected MUST line must fall OUTSIDE extractDomain(), otherwise this counter-run proves nothing"
  );
  // (b) the heading-closure test catches it
  const { unclassified } = classifyLeafHeadings(leafWithMutation);
  assert.deepEqual(unclassified, [injectedHeading], "heading closure MUST report the injected out-of-domain section");
  // (c) and a MUST line slipped into a structural section is caught too
  const leafWithStructuralMust = targets.leaf.replace("## Process\n", "## Process\n\n本段 **MUST** 不得出現（round 24 structural counter-run 專用）。\n");
  assert.notEqual(leafWithStructuralMust, targets.leaf, "test premise: the structural injection must land");
  const { structuralWithMust } = classifyLeafHeadings(leafWithStructuralMust);
  assert.equal(structuralWithMust.length, 1, `a MUST line injected into \`## Process\` own body MUST be reported: ${JSON.stringify(structuralWithMust)}`);
});
