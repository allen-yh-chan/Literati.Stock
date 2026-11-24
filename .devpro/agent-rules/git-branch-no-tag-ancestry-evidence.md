---
name: git-branch-no-tag-ancestry-evidence
description: 缺 legal consumer production tag 時判定 ancestry gate N/A 的證據清單（first-import 七項、adopted pre-first-release 四項）。觸發：change／rules sync 缺 legal production tag。
---

# Git：缺 production tag 的 ancestry gate 證據

> Load-chain（entry）：本檔是 `git-branch-naming-and-anchor.md`「開始實作前」步驟 3 的條件 leaf；步驟序（fetch、Evaluation order、fail closed）留在 entry，本檔只載兩組證據清單。有 legal latest production tag 時不讀本檔。

#### Consumer genuine no-tag first import 證據

步驟 1 的 `git fetch origin --tags` 完成後，只有下列七項證據全部成立，canonical detection 才可判定 `genuine no-tag first import` 並記錄 `ancestry gate: N/A`：

1. `git ls-tree origin/main -- .devpro-agent-rules` 沒有 mode `160000` 的 gitlink。
2. `git show origin/main:.gitmodules` 顯示檔案不存在，或內容沒有 `.devpro-agent-rules` 的 `path` 記錄；任一 gitlink 或對應 `.gitmodules` 記錄都是 adoption evidence。
3. `git rev-parse --is-shallow-repository` 必須 exit 0 且輸出 literal `false`，才可接受第 4、5 項 empty history probes。輸出 literal `true` 時可執行 `git fetch --unshallow origin`；完成後必須重驗 `git rev-parse --is-shallow-repository` 為 literal `false`，並重跑第 4、5 項兩個 history probes。`is-shallow-repository` command failure、其他輸出或 ambiguous／無法可靠判讀一律 fail closed 並停下。
4. `git log --all --format=%H -- .devpro-agent-rules` exit 0 且沒有輸出；任何輸出都表示 reachable history 曾有 Devpro path carrier，必須阻擋 N/A。
5. `git log --all --format=%H -G'^[[:space:]]*path[[:space:]]*=[[:space:]]*([.]devpro-agent-rules|"[.]devpro-agent-rules")[[:space:]]*$' -- .gitmodules` exit 0 且沒有輸出；任何輸出都表示 reachable history 曾有 Devpro `.gitmodules` path-line，必須阻擋 N/A。此 regex 容忍合法 whitespace 與 optional double quotes，但只匹配 exact `.devpro-agent-rules` 值；unrelated `.gitmodules` history 本身不是 adoption evidence。兩個 history commands 的 `--` 都是 path separator，必須保留。
6. `git tag -l 'production-*'` 找不到 canonical parser 接受的 legal consumer production tag。
7. `git ls-remote --tags origin 'refs/tags/production-*'` 找不到同一 canonical parser 接受的 legal remote production tag。

第 4、5 項任一 history probe 執行失敗，或結果 ambiguous／無法可靠判讀時，一律 fail closed 並停下；第 6、7 項的 glob 只用於蒐集 local／remote discovery evidence，不得自行取代 canonical tag legality／latest selection。fetch 後 local／remote tag 證據不一致時，必須 fail closed 並停下排查。**不得**把 N/A 當 acknowledgement 或 bypass。

#### Consumer adopted pre-first-release 證據

第二合法無-tag：`adopted, pre-first-release` → `ancestry gate: N/A (pre-first-release)`（≠ first-import 的 bare `ancestry gate: N/A`；缺 tag 序見步驟 3）。四項全過才可判定；任一缺／ambiguous → fail closed。此 N/A 不授權 release／promote。MUST NOT 要求另加確認檔、config 或 GitHub variable。

1. **Adoption：** `origin/main` 有 `.devpro-agent-rules` gitlink／`.gitmodules` path，或 reachable Devpro path／path-line history 非空。
2. **Non-shallow：** `git rev-parse --is-shallow-repository` → `false`。
3. **No legal tags：** local／remote 皆無 legal `production-*`（不一致 → fail closed）。
4. **No promotion history：** `for-each-ref` 無 `release/`；無 `production` 或 `rev-list --count MAIN..PROD`=`0`；**禁** MAIN `--merges --grep='release/'` hard evidence（4(c)；completed promote 考古權威＝item 3 `production-*` 與 4(a)/4(b) 聯合；不另設 message／MAIN..PROD-merge sole 探針）。

已導入而缺失 production tag、但四項不成立 → fail closed；禁 N/A acknowledgement bypass。

#### Production branch／tag 判定

remote production 須 fresh discover；local-only ≠ protected PR target。tag 用 canonical legal parser；local／remote 不一致、查詢失敗、stale／不明 MUST fail closed，禁作「無」。

| remote production branch | legal production tag | 判定／下一步 |
|---|---|---|
| 有 | 有 | 已正式發布；走正常 production lane，仍須驗 exact tag ancestry。 |
| 有 | 無 | 四項證據全過才是 adopted pre-first-release；否則 fail closed。 |
| 無 | 無 | 先驗 first-import；有 adoption 時再驗四項 pre-first-release 證據；不得合成 production。 |
| 無 | 有 | production target absent；MUST NOT 判為 pre-first-release。 |

首 legal tag 即終止 pre-first-release；同步終點／首發授權見 `rules-flow.md`。

**證據限制**：曾上線但 tag 遺失、release ref 已刪、production 已回併 main，四項仍可能全過。已知曾上線／tag 遺失時 MUST 停下，依既有 release/tag 復原核對原 promoted commit；禁 N/A bypass、憑空補 tag、重設確認 carrier。有 production tag 卻無合法 anchor／discovery 不明時 MUST 先報 anchor blocker，MUST NOT 退回 pre-first-release。
