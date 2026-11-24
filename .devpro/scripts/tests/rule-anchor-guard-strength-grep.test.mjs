/**
 * rule-anchor-guard-strength-grep.test.mjs
 *
 * Locks two related rule-authoring guardrails so a future edit cannot silently
 * drop the discipline that PR #1453 cross-model iteration surfaced:
 *   1. the "Rule-Anchor Guard 強度守則" leaf (rule-anchor-guard-strength.md) —
 *      polarity anchors MUST be bound on a single physical line with a compound
 *      regex; grep-guard fundamental limit.
 *   2. the 守則 4 corollary in rule-design-principles.md — tier-cap 撞頂 must run
 *      the three-branch eval (提 cap / 拆檔 / trim) and MUST NOT hard-trim valued
 *      semantics to守 a bound. (strengthen-rule-anchor-guard-authoring, this change)
 *
 * ── Dogfood note ──────────────────────────────────────────────────────────
 * This test applies the very rule it locks:
 *   - structural-existence anchors (the `# Rule-Anchor Guard 強度守則` heading,
 *     the 二分表 column headers, the corollary heading) → direct includes() is
 *     sufficient; a heading cannot be "semantically reversed" while its token
 *     survives.
 *   - polarity-sensitive anchors (the "polarity 錨點 MUST 用同一物理行 compound
 *     regex，禁 decoupled includes" clause, the 根本極限 clause, the "禁硬 trim"
 *     clause) → bound with a single-physical-line compound regex (`[^\n]*`, no
 *     bare alternation), so a token-preserving weakening (e.g. reversing "禁 硬
 *     trim" to "可 硬 trim") flips the guard red instead of passing on tokens
 *     supplied by unrelated lines.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

// Strip the YAML frontmatter block before asserting, so polarity anchors are
// bound against BODY rule lines only — not the `description:` line, which packs
// the same tokens (無法…證明 / MUST…同一物理行 compound regex) onto one physical
// line and would satisfy a body-targeting compound regex even after the body
// clause was semantically reversed. That false-pass is exactly the failure mode
// this leaf's own rule warns against (token supplied by an unrelated line), so
// the guard MUST NOT depend on frontmatter tokens. Dogfood: with frontmatter
// stripped, reversing a body clause while keeping `description:` intact flips
// the guard red (see the negative-assertion tests below).
function stripFrontmatter(raw) {
  const m = raw.match(/^---\n[\s\S]*?\n---\n/);
  return m ? raw.slice(m[0].length) : raw;
}

const leafPath = repoPath(".devpro/agent-rules/rule-anchor-guard-strength.md");
const content = stripFrontmatter(readFileSync(leafPath, "utf8"));

const principlesPath = repoPath(".devpro/agent-rules/rule-design-principles.md");
const principles = stripFrontmatter(readFileSync(principlesPath, "utf8"));

// polarity 錨點 compound regex（同一物理行綁定，`[^\n]*` 禁跨行）——模組層共用，
// 供正向守衛與 dogfood 負向斷言引用。
const polarityRuleClause =
  /MUST[^\n]*同一物理行[^\n]*compound regex|同一物理行[^\n]*compound regex[^\n]*MUST/;
const fundamentalLimitClause =
  /token-presence[^\n]*無法[^\n]*證明|無法[^\n]*token-presence[^\n]*證明/;

// ── operative-anchor registry（收斂驗證的 SSOT）──────────────────────────────
// 每個正向 structural/polarity 斷言在此註冊，供下方各 test 引用**與** meta-test
// 的 mutation 審計共用（DRY）。新增守則斷言時，MUST 在此註冊——meta-test 會對每個
// registry 條目做「刪其唯一命中行 → 必轉紅」的掃描，任何代償洞（斷言被他行 token
// 撐綠、或命中 >1 行）都會被自動抓到，把「每個 anchor 唯一保護一條 operative 內容」
// 的收斂性釘進 regression（見 leaf §驗證方法：mutation 審計）。
// target: "leaf" → 對 content 掃描；"principles" → 對 principles 掃描。
const OPERATIVE_ANCHORS = [
  { name: "leaf heading", target: "leaf", rx: /# Rule-Anchor Guard 強度守則/ },
  { name: "leaf 根本極限", target: "leaf", rx: fundamentalLimitClause },
  { name: "leaf polarity MUST 同物理行", target: "leaf", rx: polarityRuleClause },
  {
    name: "leaf 禁 cross-file/decoupled includes",
    target: "leaf",
    rx: /同一物理行[^\n]*禁[^\n]*cross-file[^\n]*decoupled[^\n]*includes/,
  },
  {
    name: "leaf structural 區分句",
    target: "leaf",
    rx: /structural-existence[^\n]*直接[^\n]*includes[^\n]*即足/,
  },
  {
    name: "corollary heading",
    target: "principles",
    rx: /守則 4 corollary[^\n]*撞 tier cap 時三分支評估/,
  },
  { name: "corollary 分支1 拆檔", target: "principles", rx: /拆檔[^\n]*決策 gate[^\n]*拆 leaf/ },
  { name: "corollary 分支2 trim", target: "principles", rx: /trim[^\n]*真冗餘[^\n]*trim 該冗餘段/ },
  {
    name: "corollary 分支3 提 cap",
    target: "principles",
    rx: /提 cap[^\n]*單一主題[^\n]*headroom[^\n]*提該檔/,
  },
  {
    name: "corollary 禁硬 trim",
    target: "principles",
    rx: /禁[^\n]*硬 trim[^\n]*語意不可讀|禁[^\n]*語意不可讀[^\n]*硬 trim/,
  },
  {
    name: "corollary cap 是設計參數",
    target: "principles",
    rx: /設計參數[^\n]*不是[^\n]*物理定律|物理定律[^\n]*不是[^\n]*設計參數/,
  },
  // ── 錨點作用域守則段（strengthen-cross-review-dispatch-guard T8）：與上方二分表
  // 正交的第二軸，四條 row-bound 斷言 + 一條 heading + 一條正交聲明，逐一 mutation
  // 審計（見下方 meta-test，自動對本 registry 每條做「刪其唯一命中行 → 必轉紅」掃描）。
  { name: "錨點作用域段標題", target: "leaf", rx: /## 錨點作用域守則（與錨點性質正交）/ },
  {
    name: "錨點作用域正交聲明",
    target: "leaf",
    rx: /兩軸正交[^\n]*任一性質的錨點都須[^\n]*同時[^\n]*滿足本段/,
  },
  {
    name: "作用域第1條 isolation 有界唯一",
    target: "leaf",
    rx: /terminator MUST 取有限集合的 min[^\n]*!== 1[^\n]*fail closed/,
  },
  {
    name: "作用域第2條 value-binding token 邊界",
    target: "leaf",
    rx: /值比對[^\n]*MUST 有 token 邊界[^\n]*禁裸[^\n]*includes/,
  },
  {
    name: "作用域第3條 同集合互相包含",
    target: "leaf",
    rx: /任一元素是另一元素的子字串[^\n]*MUST 掃描集合內部兩兩互相包含關係並擇一處置[^\n]*token-boundary matcher/,
  },
  {
    name: "作用域第4條 同契約多投影集合相等",
    target: "leaf",
    rx: /MUST 由機械集合相等斷言維持同步[^\n]*不得只靠人工在改一側時「記得」同步改另一側/,
  },
  // ── §驗證方法：mutation 審計 的兩條新軸（strengthen-evidence-reverifiability
  // T1/R4）。刪除審計本身只覆蓋「漏列」與「內容存在但寫錯」；插入軸與缺席軸是它
  // 證不到的兩個盲區，各自 row-bound 註冊，由下方 meta-test 逐條實測。
  {
    name: "R4 插入軸 雙向集合相等",
    target: "leaf",
    rx: /\*\*插入軸\*\*[^\n]*\*\*超集\*\*檢查[^\n]*收斂判準 MUST 是\*\*雙向集合相等\*\*[^\n]*漏列與插入\*\*皆\*\*轉紅/,
  },
  {
    name: "R4 缺席軸 常駐雙向 fixture",
    target: "leaf",
    rx: /\*\*缺席軸\*\*[^\n]*forbidden 側[^\n]*斷言恆綠[^\n]*\*\*常駐雙向 fixture\*\*[^\n]*fixture MUST 常駐測試檔/,
  },
  {
    name: "R4 兩軸一般化 存在性≠內容",
    target: "leaf",
    rx: /\*\*存在性與內容是兩個獨立的斷言軸\*\*[^\n]*existsSync[^\n]*要涵蓋缺席軸/,
  },
];

test("rule-anchor-guard-strength.md 含「Rule-Anchor Guard 強度守則」段標題（structural-existence 錨點，直接 includes）", () => {
  // structural anchor: heading 存在與否是漂移判準，反轉無意義 → 直接 includes 即足（本守則自身規定）。
  assert.ok(
    content.includes("# Rule-Anchor Guard 強度守則"),
    "rule-anchor-guard-strength.md 期望含「# Rule-Anchor Guard 強度守則」段標題，未找到 — guard-authoring 強度守則 leaf 可能被移除"
  );
});

test("根本極限錨點：token-presence grep 無法證明語意未反轉（polarity，同物理行綁定）", () => {
  // Compound：`無法`（否定）、`token-presence`（受詞）、`證明` 三者必須同一物理行。
  // 若有人把根本極限句反轉成「token-presence grep 可以證明 …」，`無法` 會消失或被移到別行，
  // 而 `token-presence`/`證明` 仍可能存在檔內其他句 → 單獨 includes 會偽陽。單一 regex + `[^\n]*`
  // 禁跨行，強制三者綁在根本極限那一句，反轉語意即轉紅。
  assert.ok(
    fundamentalLimitClause.test(content),
    "期望「token-presence grep **無法**機械證明自然語言規則未被語意反轉竄改」根本極限句三者同一物理行綁定，未找到 — 若根本極限論述被反轉（如弱化成『grep 可證明語意未反轉』）或 token 被拆到不同行，guard 會偽陽放行；根本極限原則是本守則的理論基礎，不可被弱化"
  );
});

test("polarity 錨點守則錨點：MUST 用同一物理行 compound regex + 禁 decoupled includes（polarity，同物理行綁定）", () => {
  // Compound：`同一物理行`（正解）、`compound regex`（機制）、`MUST` 三者必須同一物理行。
  // 這是本守則的操作核心。若被弱化成「polarity 錨點可用 decoupled includes」，`MUST`+`同一物理行`
  // 的綁定會被破壞。單一 regex，`[^\n]*` 禁跨行。
  assert.ok(
    polarityRuleClause.test(content),
    "期望「polarity-sensitive 錨點 **MUST** 用**同一物理行** compound regex 綁定」三者同一物理行綁定，未找到 — 若 polarity 錨點強度守則被弱化（如允許 decoupled includes）或 token 被拆行，guard 會偽陽；此為本守則的操作核心"
  );
});

test("dogfood 負向斷言：兩個 polarity 守衛只吃 body、不吃 frontmatter description 行", () => {
  // 本 leaf 的 `description:` 行把「無法…證明」「MUST…同一物理行 compound regex」全部 token
  // 打包在同一物理行；若守衛沒有先剝 frontmatter，反轉 body 條款而保留 description 也不會轉紅
  // ——正是本守則要防的「token 由無關行供給而偽陽」。此測試釘住 stripFrontmatter：對「frontmatter
  // 原封不動、body 的 polarity 行整段抽掉」的模擬內容，兩個 polarity 守衛都 MUST fail（若通過，
  // 代表守衛在吃 frontmatter token，本 leaf 的 guard 在自身上失效 = dogfood 反例）。
  // 構造 mutant：frontmatter **原封保留**、但 body 的 polarity/根本極限行整段移除。
  // 這模擬「body 條款被反轉/移除、frontmatter description 行不動」的攻擊——本 leaf 的
  // description 行同時打包了 polarity + 根本極限的全部 token（見檔頭 stripFrontmatter 說明）。
  const raw = readFileSync(leafPath, "utf8");
  const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n/);
  const frontmatterBlock = fmMatch ? fmMatch[0] : "";
  const bodyPolarityLinesRemoved = stripFrontmatter(raw)
    .split("\n")
    .filter(
      (line) =>
        !polarityRuleClause.test(line) && !fundamentalLimitClause.test(line)
    )
    .join("\n");
  // frontmatterKept：frontmatter（含 description token 炸彈）+ 已抽掉 polarity 行的 body。
  const frontmatterKept = frontmatterBlock + bodyPolarityLinesRemoved;

  // 若守衛**沒**先剝 frontmatter（直接對 frontmatterKept 跑 regex），description 行會供給
  // 全部 token → 偽陽通過。這正是要防的失效模式，故先斷言「不剝就偽陽」以證明 description
  // 行確實是 token 炸彈（前提）：
  assert.ok(
    polarityRuleClause.test(frontmatterKept),
    "前提失效：frontmatter description 行未供給 polarity token — mutant 或 leaf description 需更新"
  );
  assert.ok(
    fundamentalLimitClause.test(frontmatterKept),
    "前提失效：frontmatter description 行未供給根本極限 token — mutant 或 leaf description 需更新"
  );
  // 而守衛實際跑的是 stripFrontmatter(frontmatterKept)：剝掉 frontmatter 後 description
  // token 消失、body polarity 行也已移除 → MUST 轉紅。這才證明守衛只吃 body、不吃 frontmatter。
  const guardSees = stripFrontmatter(frontmatterKept);
  assert.ok(
    !polarityRuleClause.test(guardSees),
    "polarity 守衛在 body 條款移除 + frontmatter 剝除後仍通過 — 代表 stripFrontmatter 未生效或守衛吃到 frontmatter token；guard 在本 leaf 自身上失效（dogfood 反例）"
  );
  assert.ok(
    !fundamentalLimitClause.test(guardSees),
    "根本極限守衛在 body 條款移除 + frontmatter 剝除後仍通過 — 代表 stripFrontmatter 未生效或守衛吃到 frontmatter token；guard 在本 leaf 自身上失效（dogfood 反例）"
  );

  // 正向鎖定 body-loading 路徑（cross-model codex Suggestion）：`content` 常數 MUST 等於
  // stripFrontmatter(raw)，且不得含 frontmatter 的 `name:`/`description:` 行。若有人改壞
  // stripFrontmatter 或 content 定義（如退回讀原始含 frontmatter 內容），此斷言即轉紅，
  // 補上負向斷言的對稱面——確保守衛既不吃 frontmatter（負向）、也確實載入了 body（正向）。
  assert.equal(
    content,
    stripFrontmatter(raw),
    "content 常數不等於 stripFrontmatter(raw) — body-loading 路徑被改壞；polarity 守衛可能退回吃 frontmatter token"
  );
  assert.ok(
    !/^description:/m.test(content) && !/^name:/m.test(content),
    "content 仍含 frontmatter 的 name:/description: 行 — stripFrontmatter 未生效，守衛有吃 frontmatter token 的風險"
  );
});

test("禁 decoupled includes 錨點：decoupled includes 明列為禁（polarity，綁 normative row）", () => {
  // Compound：`同一物理行`（normative 表列 Guard 寫法欄的錨定結構詞）+ `禁`（極性）+
  // `decoupled`（不可弱化的核心受詞）+ `includes` 四者必須同一物理行。核心禁令「禁 decoupled
  // includes」出現在二分表 polarity-sensitive 列的 Guard 寫法欄；該 normative row 是唯一同時
  // 帶「同一物理行」錨定結構詞的行。
  //
  // Dogfood guard hole（cross-model codex re-run 第三輪抓到）：舊寫法 `/禁[^\n]*decoupled[^\n]*
  // includes/` 命中 body 兩行——normative table row（L20）與 §為什麼這樣設計 的 anti-example 段
  // （L27，literally 內嵌「禁 cross-file 或 decoupled includes」以說明 alternation 陷阱）。移除
  // normative row 後，anti-example 段仍供給全部 token → 正向守衛偽陽撐綠，operative 禁令被靜默
  // 移除卻不轉紅。正是本 leaf 標榜要防的「token 由無關行供給而偽陽」在自身 test 上第三次重演。
  // 修法：綁 `同一物理行`（anti-example 段不含此 token），讓 anti-example 撐不住，移除 normative
  // row 即轉紅。
  //
  // 第四輪 codex 追加：normative row 的禁令有**兩個**核心受詞——cross-file includes 與 decoupled
  // includes（兩者都是「把極性詞與受詞拆到不同 includes() 斷言」的手法）。只綁 decoupled 會讓
  // cross-file 半邊可被靜默刪而不轉紅（leaf §為什麼這樣設計 明文要求「每個不可弱化的核心受詞 MUST
  // 各自強制出現」，此處 dogfood 未貫徹）。修法：cross-file 與 decoupled **皆** row-bound 到含
  // `同一物理行` 的 normative row。
  const banDecoupledClause =
    /同一物理行[^\n]*禁[^\n]*cross-file[^\n]*decoupled[^\n]*includes/;
  assert.ok(
    banDecoupledClause.test(content),
    "期望「同一物理行 … 禁 … cross-file … decoupled includes」normative row 上極性詞與兩核心受詞 cross-file/decoupled 同一物理行綁定，未找到 — 若任一受詞被反轉為允許（或被拆行 / normative row 被移除），guard 應轉紅；不得用 alternation 讓某半邊代償，也不得讓 anti-example 段代償"
  );

  // Committed regression #1（dogfood hole 固化，本輪 codex Important）：對「normative row 被
  // 移除、只剩 anti-example 段」的 mutant，舊 banDecoupledClause（無「同一物理行」錨）會被
  // anti-example 撐綠偽陽放行；綁 normative row 的 strict 形式必轉紅。此斷言把兩者的失效差異
  // 釘進 test——未來若有人把 banDecoupledClause 改回不綁「同一物理行」，antiExampleOnlyMutant
  // 的偽陽期望仍成立、strict 期望會 fail，直接標示退化。
  const antiExampleOnlyMutant =
    "**compound regex 內禁用「代償式 alternation」**：當一條禁令有多個受詞（如「禁 cross-file **或** decoupled includes」）……";
  const looseDecoupledForm = /禁[^\n]*decoupled[^\n]*includes/;
  assert.ok(
    looseDecoupledForm.test(antiExampleOnlyMutant),
    "前提失效：loose 形式對 anti-example-only mutant 未偽陽 — mutant 字串或需更新"
  );
  assert.ok(
    !banDecoupledClause.test(antiExampleOnlyMutant),
    "退化偵測：strict banDecoupledClause 對「只剩 anti-example 段、normative row 被移除」的 mutant 竟通過 — regex 已被弱化回不綁 normative row 的形式，operative 禁令可被靜默移除而 anti-example 段代償偽陽放行"
  );

  // Committed regression #2（cross-model codex 前輪要求固化）：對「守則只禁 cross-file、decoupled
  // 半邊被移除」的 mutant，代償式 alternation 形式會偽陽放行、綁 decoupled 的 strict 形式必轉紅。
  // 此斷言把「不得用代償式 alternation」的失效差異釘進 test——未來若有人把 banDecoupledClause
  // 改回 /禁[^\n]*(cross-file|decoupled)[^\n]*includes/，alternation 偽陽期望仍成立、strict 期望
  // 會 fail，直接標示退化。
  const crossFileOnlyMutant =
    "MUST 用同一物理行 compound regex；**禁** cross-file `includes()`";
  const alternationForm = /禁[^\n]*(cross-file|decoupled)[^\n]*includes/;
  assert.ok(
    alternationForm.test(crossFileOnlyMutant),
    "前提失效：alternation 形式對 cross-file-only mutant 未偽陽 — mutant 字串或需更新"
  );
  assert.ok(
    !banDecoupledClause.test(crossFileOnlyMutant),
    "退化偵測：strict banDecoupledClause 對「只禁 cross-file、無 decoupled」的 mutant 竟通過 — regex 已被弱化回代償式 alternation，decoupled 禁令可被反轉而 guard 偽陽放行"
  );
});

test("structural 錨點區分錨點：structural-existence 錨點直接 includes 即足（structural row 同一物理行綁定）", () => {
  // structural anchor：「structural-existence 錨點直接 includes 即足」這句本身是 structural-existence
  // 描述（反轉無意義——若被移除，代表二分守則塌成單一過嚴規則）。
  //
  // Dogfood guard hole（cross-model codex 第四輪抓到）：舊寫法
  // `content.includes("structural-existence") && content.includes("includes")` 有 token-供給洞——
  // `includes` 是 leaf 內 ubiquitous token（body 7 行都有），故移除 structural row 的 guard-cell 措辭
  // 「直接 includes() 即足」後，`includes` 仍被他行供給、`structural-existence` 仍在表列左欄 → 兩個
  // includes() 各自為真而偽陽撐綠，operative 區分句被靜默移除卻不轉紅。正是本 leaf 標榜要防的
  // 「token 由無關行供給而偽陽」在 structural 斷言上重演。修法：綁 structural row 的 guard-cell
  // 獨有結構（`直接` + `includes` + `即足` 同一物理行），使他行 includes 無法代償。
  const structRowClause = /structural-existence[^\n]*直接[^\n]*includes[^\n]*即足/;
  assert.ok(
    structRowClause.test(content),
    "期望「structural-existence … 直接 includes() 即足」二分表 structural 列 guard-cell 同一物理行綁定，未找到 — 二分守則（polarity 用 compound regex / structural 用直接 includes）可能塌成單一過嚴規則，徒增 guard 脆度；不得讓他行 ubiquitous 的 includes token 代償"
  );
});

// ── 守則 4 corollary（rule-design-principles.md）：撞 tier cap 三分支評估 ──────

test("corollary 段標題：守則 4 三分支評估段存在（structural-existence，heading 整句綁定）", () => {
  // structural anchor: corollary heading 存在與否是漂移判準，反轉無意義 → includes 整句。
  //
  // Dogfood guard hole（cross-model codex 第五輪抓到）：舊寫法
  // `includes("守則 4 corollary") && includes("提 cap") && includes("拆檔")` 的三個 token 全部
  // 出現在 corollary **heading 本身**（heading = 「撞 tier cap 時三分支評估（提 cap / 拆檔 / trim…）」），
  // 故刪掉三個 branch body row 後，heading 單獨即滿足全部 token → operative 三分支內容可被靜默移除
  // 卻不轉紅。此 heading structural 斷言僅能證「段存在」，故改綁 heading **整句**（獨有 literal）；
  // 三分支 operative 內容改由下方三個 row-bound 斷言各自把關（見「corollary 三分支 body」test）。
  const headingClause = /守則 4 corollary[^\n]*撞 tier cap 時三分支評估/;
  assert.ok(
    headingClause.test(principles),
    "rule-design-principles.md 期望含「守則 4 corollary — 撞 tier cap 時三分支評估」段標題（整句綁定），未找到 — cap 撞頂三分支評估守則段可能被移除，會讓後人反射性硬 trim"
  );
});

test("corollary 三分支 body：拆檔 / trim / 提 cap 三 operative branch 各自 row-bound（防三分支內容被靜默刪）", () => {
  // structural anchor（operative content 存在性）：三分支的 body 各是一條 operative 守則，其存在
  // 是漂移判準。第五輪 dogfood 教訓——不可用 heading 也含的 branch 名（提 cap / 拆檔）當 token，
  // 那會被 heading 代償；每個 branch MUST 綁該 body 行的**獨有 token 組合**（heading 不含者），
  // 使刪掉該 branch body 即轉紅。
  const branchSplit = /拆檔[^\n]*決策 gate[^\n]*拆 leaf/; // L33 獨有：決策 gate + 拆 leaf
  const branchTrim = /trim[^\n]*真冗餘[^\n]*trim 該冗餘段/; // L34 獨有：真冗餘 + trim 該冗餘段
  const branchRaiseCap = /提 cap[^\n]*單一主題[^\n]*headroom[^\n]*提該檔/; // L35 獨有：單一主題 + headroom + 提該檔
  assert.ok(
    branchSplit.test(principles),
    "期望「拆檔 … §決策 gate … 拆 leaf」分支 1 body 同一物理行綁定，未找到 — 分支 1（拆檔）operative 內容可能被靜默移除；heading 的「拆檔」token 不得代償"
  );
  assert.ok(
    branchTrim.test(principles),
    "期望「trim … 真冗餘 … trim 該冗餘段」分支 2 body 同一物理行綁定，未找到 — 分支 2（trim 真冗餘）operative 內容可能被靜默移除"
  );
  assert.ok(
    branchRaiseCap.test(principles),
    "期望「提 cap … 單一主題 … headroom … 提該檔」分支 3 body 同一物理行綁定，未找到 — 分支 3（提 cap）operative 內容可能被靜默移除；heading 的「提 cap」token 不得代償"
  );
});

test("§驗證方法 兩條盲區軸：插入軸 / 缺席軸 各自 row-bound（strengthen-evidence-reverifiability R4）", () => {
  // 刪除審計只證得了「漏列」與「內容存在但寫錯」；這兩軸是它證不到的盲區，
  // 各綁該行獨有 token 組合（見 OPERATIVE_ANCHORS 同名條目，meta-test 會實測
  // 「刪其唯一命中行 → 必轉紅」）。
  const insertionAxis =
    /\*\*插入軸\*\*[^\n]*\*\*超集\*\*檢查[^\n]*收斂判準 MUST 是\*\*雙向集合相等\*\*[^\n]*漏列與插入\*\*皆\*\*轉紅/;
  const absenceAxis =
    /\*\*缺席軸\*\*[^\n]*forbidden 側[^\n]*斷言恆綠[^\n]*\*\*常駐雙向 fixture\*\*[^\n]*fixture MUST 常駐測試檔/;
  const generalization =
    /\*\*存在性與內容是兩個獨立的斷言軸\*\*[^\n]*existsSync[^\n]*要涵蓋缺席軸/;
  assert.ok(
    insertionAxis.test(content),
    "期望「插入軸 … 超集檢查 … MUST 雙向集合相等 … 漏列與插入皆轉紅」同一物理行綁定，未找到 — 超集斷言可讓多宣告一個值的受保護檔全綠，該盲區條款可能被靜默移除或反轉成單向檢查"
  );
  assert.ok(
    absenceAxis.test(content),
    "期望「缺席軸 … forbidden 側 … 斷言恆綠 … 常駐雙向 fixture … MUST 常駐測試檔」同一物理行綁定，未找到 — forbidden 側沒有刪除審計可用，少了常駐正反例就分不出 guard 有效與空轉"
  );
  assert.ok(
    generalization.test(content),
    "期望「存在性與內容是兩個獨立的斷言軸 … existsSync … 要涵蓋缺席軸」同一物理行綁定，未找到 — 兩軸的共同一般化被移除後，`if (!existsSync(p)) continue;` 形狀的早退會重新變成無聲通過"
  );
});

test("corollary polarity 錨點：禁硬 trim 到語意不可讀（polarity，同物理行綁定）", () => {
  // Compound：`禁`（極性）、`硬 trim`（受詞）、`語意不可讀` 三者必須同一物理行。
  // 這是 corollary 的操作核心禁令。若被反轉成「可硬 trim」或把「語意不可讀」拆到別行，
  // 綁定即破，guard 轉紅。`[^\n]*` 禁跨行，強制三者綁在同一句。
  const banHardTrimClause =
    /禁[^\n]*硬 trim[^\n]*語意不可讀|禁[^\n]*語意不可讀[^\n]*硬 trim/;
  assert.ok(
    banHardTrimClause.test(principles),
    "期望「**禁**硬 trim 到**語意不可讀**」極性詞與受詞同一物理行綁定，未找到 — 若該禁令被反轉（如弱化成『可硬 trim』）或 token 被拆行，guard 會偽陽放行；此禁令是 corollary 阻止『為守 cap 壓縮到自己看不懂』的操作核心"
  );
});

test("corollary polarity 錨點：cap 是設計參數不是物理定律（polarity，同物理行綁定）", () => {
  // Compound：`設計參數`（正解）、`不是`（否定）、`物理定律`（對立面）三者同一物理行。
  // 若被反轉成「cap 是物理定律不可動」，`不是` 會消失或移行 → 綁定破，guard 轉紅。
  const capIsParamClause =
    /設計參數[^\n]*不是[^\n]*物理定律|物理定律[^\n]*不是[^\n]*設計參數/;
  assert.ok(
    capIsParamClause.test(principles),
    "期望「tier cap 是**設計參數不是物理定律**」三者同一物理行綁定，未找到 — 若此前提被反轉（cap 不可動）或拆行，corollary 的三分支評估失去理論基礎，後人會誤把 cap 當硬約束而反射性 trim"
  );
});

// ── meta-test：mutation 審計（收斂性 regression）─────────────────────────────
// 對 OPERATIVE_ANCHORS 每個條目做逐行 mutation 掃描，證明每個 anchor 唯一保護一條
// operative 內容——(1) 恰命中 1 行（token 組合為該行獨有）；(2) 刪該命中行後轉紅
// （無他行 token 代償）。這把「靜默移除 operative 內容仍偽陽撐綠」的整類 dogfood 洞
// （本 PR 五輪 cross-model 逐輪抓到的同一根因）一次性釘進 regression：未來新增/改
// 斷言若引入代償洞或非唯一命中，此 meta-test 立即轉紅。方法論 SSOT 見 leaf
// §驗證方法：mutation 審計。
test("meta：OPERATIVE_ANCHORS 全部唯一命中 + 刪命中行即紅（mutation 審計，收斂證明）", () => {
  const targets = { leaf: content, principles };
  for (const { name, target, rx } of OPERATIVE_ANCHORS) {
    const text = targets[target];
    assert.ok(text !== undefined, `registry 條目「${name}」的 target「${target}」無對應內容`);
    const lines = text.split("\n");
    const hitIdxs = lines
      .map((l, i) => [i, l])
      .filter(([, l]) => rx.test(l))
      .map(([i]) => i);
    // (1) 唯一命中：token 組合必須是某 operative 行獨有
    assert.equal(
      hitIdxs.length,
      1,
      `mutation 審計失敗：anchor「${name}」命中 ${hitIdxs.length} 行（期望恰 1）— 選的 token 組合非 operative 行獨有，可能被他行代償；請綁該行更獨有的結構詞`
    );
    // (2) 刪命中行即紅：無他行 token 代償
    const removed = lines.filter((_, i) => i !== hitIdxs[0]).join("\n");
    assert.ok(
      !rx.test(removed),
      `mutation 審計失敗：anchor「${name}」在其唯一命中行被刪後仍通過 — operative 內容可被靜默移除而 guard 不轉紅（token 由他行代償）；這是本 leaf 標榜要防的失效模式，請改綁該行獨有 token 組合`
    );
  }
});
