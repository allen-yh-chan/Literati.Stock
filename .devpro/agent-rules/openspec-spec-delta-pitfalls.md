---
name: openspec-spec-delta-pitfalls
description: 撰寫 OpenSpec spec delta 的條件性陷阱：MODIFIED 的 lint-delta-body-canonical-wrap 的 contiguous-block 比對實務、MAY-only catch-22、scope-shift scenario 語意 check、grep guard 對 promoted delta 的 no-op 陷阱。觸發：寫 `## MODIFIED Requirements`、把 MAY-only scenario 搬進 MODIFIED、抽象既有 requirement 的 scope／mode、或為已 promoted 的 delta 寫 static grep guard 時。
---

# OpenSpec Spec Delta Pitfalls

> Load-chain：本檔由 `openspec-quality-and-formats.md` §Writing Spec Deltas 按需載入；delta 顆粒度、MODIFIED 兩種合法形狀與 new-scenario-only 禁令、寫入前自問、`## Removed Scenarios` 位置、機械守門指令、No-delta／skip_specs、值級一致性與 scenario 涵蓋面宣告留在該檔。只寫 `## ADDED Requirements` 且不涉及下列情境時不必讀本檔。

## MODIFIED 寫入實務

- **實務注意**：本 repo `lint-delta-body-canonical-wrap`（archive 前 blocking）採 **contiguous-block-anchored** 比對：canonical 每個 requirement block（main-section + 每 scenario）須以連續、原序、逐行相等的 run 出現在 delta；**允許** MODIFIED 對既有 requirement **新增完整 scenario**（delta 在既有 segment 之間/末尾插入新 scenario segment 即可＝additive contiguous-insert），**仍擋** hard-wrap（拆行破壞 segment 內部相鄰性）與刪行（segment 缺行）。若同時**改既有 body 措辭**（非只加 scenario），依 lint remediation，須同步改 canonical 讓兩邊逐行一致（archive 前 delta 與 canonical 對齊）。（歷史註：早期先例 `strengthen-spec-delta-mode-scope`、`add-spec-code-consistency-axis` 因舊等長 lint 繞道改用 `## ADDED Requirements` 承載加 scenario；此繞道因放寬已不需要，非現行指引。）

## 其他條件性陷阱

- **MAY-only catch-22**：canonical 既有 MAY-only scenario 複製進 `MODIFIED` delta 會撞 SHALL/MUST lint。只允許：(a) 直接改 canonical promoted spec，proposal/PR body 記錄原因，且 change-folder `.openspec.yaml` 設 `skip_specs: true`（OpenSpec ≥1.9.0 零 delta 為 **ERROR**，非 warn）；或 (b) 改 `lint-spec-shall-must` 豁免未改動既有 MAY-only scenario（本 scope 或另開 chore B/B-mini）。**禁止**為過 gate 發明 requirement。
- **Scope-shift scenario 語意 check（抽象既有 requirement 時）**：把既有 single-mode/single-scope requirement 抽象成 multi-mode（如新增 tracker mode、per-repo→per-entity）時，`MODIFIED` 保留的既有 scenario 其 `WHEN` clause 隱含舊 mode/scope context；preservation lint 只驗「scenario 沒漏刪」、**不驗「保留的 scenario 在新 mode 下語意是否 over-broad」**。MUST 主動逐條掃過 MODIFIED requirement 的**每個** scenario，確認其 `WHEN`/`THEN` 在新 mode 下仍正確；最省力的根治是在 requirement description 加一句**總括 mode-scope 聲明**（例：「本 requirement 全部 scenario 僅適用 `<mode>`；其他 mode 對等行為見 `<other requirement>`」），一次涵蓋全部 scenario，免逐句 qualify。Evidence：PR #1055 經 6 輪 cross-model 才把逐個 over-broad 的 Issue-first scenario 收斂，最終靠 requirement-level mode-scope 聲明根治。
- **grep guard 對 promoted delta 的 no-op 陷阱**：static grep guard 斷言「canonical + delta 串接文字」時，若所有斷言 phrase 在 archive 後都已 promote 進 canonical，則 delta 讀空也會綠——delta path 形同 dead code。MUST 對 delta 另立斷言：delta 內容非空 + 至少一個 **delta-only anchor**（canonical 不含的字串，如 delta 檔標題 `# <cap> Delta: <name>`），並斷言該 anchor 不在 canonical，確保 guard 真 exercise delta path。Evidence：PR #1055 round-5 cross-model 抓出 archived-delta fallback 是 silent no-op。
