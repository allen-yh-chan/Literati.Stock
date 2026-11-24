---
name: rule-anchor-guard-strength
description: grep-based rule-anchor guard 的強度守則：token-presence grep 的根本極限（無法機械證明語意未反轉）+ polarity-sensitive 錨點 MUST 用同一物理行 compound regex、structural-existence 錨點直接 includes 即足的二分守則。觸發：新增/修改 .devpro/scripts/tests/*grep*.test.mjs 或任何鎖自然語言規則的 anchor test。
metadata:
  tier: next
---

# Rule-Anchor Guard 強度守則

## Overview

決定用 grep-based anchor test 鎖一條規則後（防未來 edit 靜默移除／弱化），本 leaf 規定該 guard 該怎麼寫才夠強。設計層母規範見 `rule-design-principles.md`（本 leaf 為其 guard-authoring 方法論的深化）。

## When to Use

- 新增或修改 `.devpro/scripts/tests/*grep*.test.mjs` 等鎖自然語言規則的 anchor test 前
- code review 時判斷某 anchor guard 是否夠強（polarity 錨點是否被 decoupled includes 弱化）

## 根本極限（先認清）

token-presence grep **無法**機械證明一條自然語言規則未被「語意反轉但 token 全保留在同一行」地竄改。例：把「MUST 停下、不 push」改成「不必停下、不 push 亦非必須」——token `停下`／`不 push` 仍在同行，任何 token-presence check 都會偽陽。這是 grep-guard 的**根本極限**，非特定 test 缺陷；對抗「刻意語意反轉」屬 code review / cross-model 人審職責，不是機械 anchor guard 能涵蓋。認清此極限才不會誤把「加更多 includes」當成補強。

## 操作守則（依錨點性質二分）

| 錨點性質 | 定義 | Guard 寫法 |
|---|---|---|
| **polarity-sensitive** | 語意含極性、反轉後仍合語法（MUST/MUST NOT、停下/不停下、禁/允許）| **MUST** 用**同一物理行** compound regex 綁定極性詞 + 受詞（如 `/MUST\s+先驗\s+HEAD\s+實際內容/`）；**禁** cross-file 或 decoupled `includes()`（把極性詞與受詞拆到不同 `includes()` 斷言，token 可由跨檔無關行供給而偽陽）|
| **structural-existence** | 段標題、區分句、清單項存在與否（反轉無意義，移除才是漂移）| 直接 `includes()` 即足；本質不可被 token-preserving 反轉攻擊，不需 compound regex |

## 為什麼這樣設計

polarity 錨點的失效模式是「token 齊全但語意被弱化」——單獨 `includes(極性詞)` + 單獨 `includes(受詞)` 會被「極性詞在 A 行、受詞在 B 行、兩者語意已脫鉤」的改動偽陽通過（PR #1453 cross-model 前三輪 findings 即此類）。把兩者綁進**同一物理行** compound regex，才能要求「極性與受詞仍在同一句結構」。structural 錨點無此風險，強加 compound regex 只增脆度。

**compound regex 內禁用「代償式 alternation」**：當一條禁令有多個受詞（如「禁 cross-file **或** decoupled includes」），**不可**寫成 `/禁[^\n]*(cross-file|decoupled)[^\n]*includes/`——alternation 讓任一受詞單獨滿足即 pass，於是「禁 cross-file」半邊還在、「禁 decoupled」半邊被反轉成允許時 guard 仍偽陽放行。每個**不可弱化的核心受詞** MUST 各自強制出現（`/禁[^\n]*decoupled[^\n]*includes/` 讓 decoupled 為必要 token），需要時把其他受詞另立獨立斷言，而非讓它們互相代償。此 alternation 陷阱由本 leaf PR 的 cross-model review 在自身 test 上抓到（dogfood）。此外，**anti-example 段內嵌的違規 literal 也是 token 供給源**：本段為說明 alternation 陷阱而內嵌「禁 cross-file 或 decoupled includes」字樣，這會讓一條只綁 `禁…decoupled…includes` 的正向斷言在 normative row 被移除後仍被 anti-example 段撐綠（同根因第三面，亦由 cross-model dogfood 抓到）。正向斷言 MUST 綁 normative row 的**獨有錨定結構詞**（如二分表 Guard 寫法欄的「同一物理行」），使 anti-example 段無法代償。

**正向 structural 斷言同受此根因約束**（第四輪 dogfood）：（a）一條禁令有多個核心受詞（如二分表 polarity 列同時禁 cross-file 與 decoupled 兩種 includes 拆解手法）時，**每個**受詞都 MUST row-bound 到 normative row，只綁其一會讓另一半邊可被靜默刪；（b）structural 存在性斷言 MUST 綁該 row 的**獨有 guard-cell 措辭全句**，**不可**只 `content.includes(某泛用 token)`——泛用 token 在檔內多行出現，會被無關行供給而在 operative 句被移除後仍偽陽撐綠。判準：正向斷言選的 token 組合必須是 operative 行**唯一**能同時滿足者（本段刻意不複述任一 operative 措辭的完整 token 序列，以免散文本身成為供給源——此即上述判準的一次 dogfood 應用）。

## 驗證方法：mutation 審計（收斂判準）

逐條加正向斷言、逐輪修代償洞會陷入 whack-a-mole。收斂的機械證明是 **mutation 審計**：對受保護檔的每一行，模擬「該行被刪」，重跑**全部**正向斷言——每個斷言 MUST 在其對應 operative 行被刪時**恰好轉紅**（命中該行且無他行代償）。若刪掉某 operative 行後仍全綠，代表該斷言被他行 token 代償（洞）；若某斷言命中 >1 行，代表選的 token 組合非該行獨有。全部斷言皆「唯一命中 + 刪即紅」時，才證明每個 anchor 唯一保護一條 operative 內容，guard set 對「靜默移除」收斂。本 leaf 的 grep-anchor test 附一個 meta-test 跑此審計，把收斂性釘進 regression（新增斷言若引入代償洞會被自動抓到）。

**刪除軸不是全部——mutation 審計對「多出來」與「整個不見」結構性盲**。上述審計只模擬「該行被刪」，只證明 guard 對**移除**收斂；下列兩軸須各自獨立斷言：

- **插入軸**：斷言若寫成**超集**檢查（要求 canonical 值全數出現，但不抽取受保護檔實際宣告的值、也不拒斥額外值），受保護檔可多宣傳一個 runtime 會拒絕的值而全綠，刪除審計照樣零代償洞——多出來的值不對應任何 operative 行。凡受保護內容是**一組值**（enum、白名單、carrier 清單、mode token 集合），收斂判準 MUST 是**雙向集合相等**：漏列與插入**皆**轉紅，差異須具名報出是哪一個值。驗收 MUST 有插入側實跑反證（真的插一個值看它轉紅），不接受「斷言看起來是雙向的」宣稱。
- **缺席軸**：forbidden 側（斷言某措辭 MUST NOT 出現）沒有刪除審計可用——刪任何一行只讓禁止措辭更缺席，斷言恆綠，分不出「guard 有效」與「guard 空轉」。改以**常駐雙向 fixture** 釘死：正例＝真實出現過的殘留原文（marker 改窄即漏放，轉紅），反例＝必須被放行的正當行（marker 改寬即誤傷，轉紅）。fixture MUST 常駐測試檔而非一次性手動驗證，否則下次改 marker 時沒有東西會轉紅。

兩軸的共同一般化：**存在性與內容是兩個獨立的斷言軸**。只驗「內容存在時是否正確」的 guard 對「內容整個缺席」盲——`if (!existsSync(p)) continue;` 形狀的早退讓「檔不存在」與「本來就不該檢查」在輸出上無法區分。要涵蓋缺席軸，須先有獨立於內容的判準回答「這個對象該不該存在」，再對缺席本身斷言。

## 已實作參照

`force-push-verify-head-grep.test.mjs` 檔頭「Guard 強度邊界」caveat 為本守則的具體示範（test 2 exit-code / test 3 primary / test 4 diff 為 polarity 錨點用同物理行 compound regex；test 1 段標題 / test 6 區分句為 structural 錨點用直接 includes）。本 leaf 為該 per-file caveat 的升格 SSOT。

## 錨點作用域守則（與錨點性質正交）

上表二分的是錨點性質（polarity 與 structural）；本段管的是錨點**作用域**——即取材邊界與比對範圍，兩軸正交，任一性質的錨點都須**同時**滿足本段四條，缺一即弱化。

1. **isolation 有界唯一**：anchor 到內容邊界（如 fenced block）的取材 MUST 有界且唯一。Lazy 匹配（`[\s\S]*?`）只保證「anchor 之後最近的一個」，不保證「屬於這個 anchor 的那個」——干擾內容插在 anchor 與目標之間即可誘導取到錯誤內容而全綠。terminator MUST 取有限集合的 min（如下一個同級或更高級 heading、同檔下一個 sibling anchor、EOF）；命中內容單位（如 fenced block）數 `!== 1` 即 fail closed，且訊息 MUST 回報實際數量與位置，不得靜默略過或指向錯誤位置。
2. **value-binding token 邊界**：值比對（非僅存在性）MUST 有 token 邊界，禁裸 `String.prototype.includes()` 子字串語意——後綴延長會偽陽；散文片語以尾界為必要，前綴風險由片語自身長度承擔。宣告行值（`key: value`）用整行精確比對（`^value$`，`m` flag）；欄位名存在性用行首錨定（`^field`）；散文片語用尾界 `(?![\w-])`（CJK 字元相鄰時 `\b` 不可靠）。forbidden 側同理升為有邊界形式，不得退回寬鬆 includes。
3. **同集合互相包含**：同一 anchor／token 集合內，若任一元素是另一元素的子字串（`"A" ⊂ "B"`），裸 `includes()` 會讓短 anchor 成為結構性死斷言——其對應規則被移除時仍被同集合內的長 anchor 代償供給，永遠無法獨立轉紅。guard 集合定案時 MUST 掃描集合內部兩兩互相包含關係並擇一處置：改措辭消解包含關係，或改用 token-boundary matcher（`(?<![\w-])A(?![\w-])`）使長 anchor 不再代償短 anchor；短 anchor 是外部契約字面（如 typed enum 值）而不可改措辭時 MUST 走後者。只驗證各元素獨立存在不算處置。
4. **同契約多投影集合相等**：同一契約若有多個 host／carrier 各自一份手工副本（如同一 dispatch 契約的不同 host payload），MUST 由機械集合相等斷言維持同步——取雙側欄位名集合，扣除已知 host-specific 差異後雙向 diff 皆為空；不得只靠人工在改一側時「記得」同步改另一側。

四條的具體範例見 `cross-review-cli-skills-grep.test.mjs` 的 `sliceSection`（第 1 條）、`declarationLineRegex`/`fieldDeclarationRegex`/`phraseBoundaryRegex`（第 2 條）、`exactAnchors` 互相包含掃描（第 3 條）、`HOST_DIFF_MATRIX` 雙向斷言（第 4 條）。
