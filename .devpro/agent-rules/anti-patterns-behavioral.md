---
name: anti-patterns-behavioral
description: LLM agent behavioral anti-patterns（§7-§16：OpenSpec skip、delegation skip、token burst、spec drift、silent assumption、POSIX-only shell/syscall、boundary placement、incomplete char-class、incomplete supersede、retained-API deprecation）。觸發：review/反思 agent 行為時對照。
---

# LLM Agent Behavioral Anti-Patterns（§7-§16）

> Load-chain：本檔由 `anti-patterns-examples.md` 按需載入；entry leaf 只保留 pattern 索引，§7-§16 detail 在此。

> 借鏡 andrej-karpathy-skills EXAMPLES.md 模式：每反例對 ❌ 錯誤 + ✅ 正確 + **認知根源**，作為 design / code 決策時的 falsifiable self-check。

### §7. OpenSpec 缺失（直接寫碼跳過流程）

❌ 收到「加個小功能」就直接 Edit 程式碼，無 `devpro:change`、無 change folder、無 brd / proposal / tasks。

✅ 任何行為變更先 `/devpro:change`：建 change folder + meeting-notes → dp-analyst pre-flight → dp-architect proposal → 實作。chore A 純技術雜事免，但**判定屬於 chore A 也須書面化**。

**認知根源**：「很簡單／不用走 OpenSpec」是合理化（per ai-autonomy-rationalizations.md Common Rationalizations）。一行 change 也是 change，30 秒開好；目錄不存在不是免除依據。

對應 leaf：`openspec-flow.md`、`openspec-branch-routing.md`、`ai-autonomy.md`

### §8. 委派失敗（沒做 executor 決策就自己做 ≥2 步）

❌ TL 識別 task ≥ 2 步 / ≥ 2 檔，沒做 executor 決策就直接自己做（理由：「先做完再 refactor」/「subagent 比較慢」）。

✅ ≥ 2 步非判斷性是 task-shape 訊號，不單獨授權 spawn：依 `model-delegation.md` §Executor 決策序判定，要派時非判斷性 → dp-assistant、需設計判斷的實作 → dp-programmer、review 任務 → dp-reviewer，否則 TL-direct。Step 5 委派計畫逐 task 記 executor（dp-* 或 TL 自己做）與理由，不強制出現 dp-*。

**認知根源**：沒做 executor 決策就自己動手，多步 Edit/Write 會讓主 agent context 吞掉中間結果（token efficiency）；是否派 subagent 由 `model-delegation.md` §Executor 決策序判定，TL-direct 是合法結果；Step 5 委派計畫是 mechanical reinforcement。

對應 leaf：`model-delegation.md`、`multi-agent-handoff.md`

### §9. Token burst（regex 全文 grep / 全 read）

❌ `Read large-file.md` 整檔 / `grep -r "X" .` 全 repo 不限路徑 → 主 agent context 吞 5K+ token。

✅ `Grep` 用 `path` / `glob` 限縮 + `head_limit` / `output_mode: "files_with_matches"`；大檔用 `Read offset/limit`；委派 dp-assistant 跑 grep 並摘要回傳。

**認知根源**：design-core「token efficiency」hard constraint；context 是稀缺資源，不是免費。

對應 leaf：`token-frugal-io.md`、`model-delegation.md`

### §10. 文件未更新（PR review 後 spec drift）

❌ PR review 中改了行為（加 scenario / 改 SHALL）但沒重新 archive；merge 時 `openspec/specs/` 與 archived spec.md 不一致。

✅ Review 後行為變更 → re-archive 前 update spec deltas + decisions.md（觸發點 `reviewer-rejection`）→ 同分支重新 `/opsx:archive` → push merge。Pre-PR archive gate + openspec validate strict 雙重把關。

**認知根源**：spec 是契約，不是事後文件；review 是契約 negotiation 一部分。

對應 leaf：`openspec-archive-principles.md`（Archive 原則）+ `openspec-step-1-to-9.md`（decisions.md 同步／Post-merge）

### §11. 假設未明示（腦補使用者意圖）

❌ 「我覺得 user 應該想要 X」直接做 X（沒問、沒列待確認項、沒書面 surface 取捨）。

✅ design-core「寫程式前先思考」：明示假設清單；存在歧義 → 列多種解讀 + AskUserQuestion；不確定 → 停下問。

**認知根源**：默默選擇 = 把 LLM 偏好強加到 user；surface 取捨 = 讓 user 留住主動權。

對應 leaf：`ai-autonomy.md`（§0 第 3 條「假設」）、`design-core.md`

### §12. POSIX-only Shell Built-ins and Node.js Syscall Semantics in Source-Repo Scripts

**請求**：在 `.claude/settings.json` hook command 中包裝條件式腳本執行

❌ POSIX-only（失敗於 Windows cmd.exe / PowerShell）：

```bash
test -f .devpro/scripts/hooks/recap-check.mjs && node .devpro/scripts/hooks/recap-check.mjs || true
```

- `test -f` 是 POSIX shell built-in，在 macOS / Linux / Git Bash / WSL 可用
- Windows cmd.exe / PowerShell 無 `test` 指令 → 整個 hook command 報錯

❌ 裸相對路徑（cwd 漂移時 crash 或靜默失效）：

```bash
node .devpro/scripts/hooks/run-hook.mjs Stop .devpro/scripts/hooks/recap-check.mjs
```

- hook 執行時 cwd 不保證在 repo root（agent `cd` 子目錄、Codex/Cursor 不保證 hook-visible cwd）
- cwd 漂移 → `MODULE_NOT_FOUND` crash；或 wrapper 載到但 gate 相對路徑錯誤 → 靜默 `exit 0`，保護機制無聲失效

✅ cwd-proof inline launcher（跨平台 + 不依賴 cwd，含 submodule-mount disqualification）：

```bash
node -e "const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');const orig=process.cwd();let d=orig,root='';while(true){if(path.basename(d)==='.devpro-agent-rules'){const p=path.dirname(d);if(p===d)break;d=p;continue;}process.chdir(d);if(fs.existsSync('.devpro/scripts/hooks/run-hook.mjs')){root=d;break;}const p=path.dirname(d);if(p===d)break;d=p;}process.chdir(orig);const a=process.argv.slice(1);let e=process.env.DEVPRO_RULES_ROOT,r='',bad=false;if(e){if(process.platform==='win32'&&/^\/[a-zA-Z]\//.test(e))e=e[1].toUpperCase()+':'+e.slice(2);const x=path.resolve(orig,e);r=path.join(x,'scripts','hooks','run-hook.mjs');if(fs.existsSync(r)){if(String(a[1]).startsWith('.devpro/'))a[1]=path.join(x,a[1].slice(8));}else{bad=true;process.stderr.write('run-hook: DEVPRO_RULES_ROOT has no scripts/hooks/run-hook.mjs: '+x+'\n');a[1]=path.join(r,path.basename(String(a[1])));r=root?path.join(root,'.devpro','scripts','hooks','run-hook.mjs'):'';}}else if(root){r=path.join(root,'.devpro','scripts','hooks','run-hook.mjs');}if(r===''){if(bad===false)process.stderr.write('run-hook: repo root not found from '+orig+'\n');process.exit(1);}const res=spawnSync(process.execPath,[r,...a],{cwd:root||orig,stdio:bad?['inherit','pipe','inherit']:'inherit'});if(bad){if(res.stdout&&res.stdout.length>0){process.stdout.write(res.stdout);process.exit(res.status??1);}process.exit(1);}process.exit(res.status??1);" Stop .devpro/scripts/hooks/recap-check.mjs --host=<runtime>
```

- 從 `process.cwd()` 向上 walk，找到含 `run-hook.mjs` 的 repo root；以該 root 為 cwd spawn wrapper
- `path.basename(d)==='.devpro-agent-rules'` disqualification：跳過 submodule mount 本身（basename 命中），不誤判上層祖先目錄（祖先 basename 不等於 mount 名則不跳）
- rules 來源：預設＝上述 repo root 的 `.devpro`；只有明確設定環境變數 `DEVPRO_RULES_ROOT`（空字串視同未設）才改用 `<DEVPRO_RULES_ROOT>/scripts/hooks/` 的 `run-hook.mjs` 與 gate（兩者同一 root；相對路徑以 session cwd 解析；win32 上 Git Bash 形式 `/c/rules` 視為 `C:/rules`；cwd 仍是 repo root）。設了但該處沒有 `run-hook.mjs` → stderr 具名錯誤，repo 與該 root 的 gate **都不**執行（即使該 root 有同名 gate）：改由 repo 的 `run-hook.mjs` 收一個放在缺失 runner 路徑底下、必不存在的 gate 路徑，走既有「hook file missing」分支，GitHub 寫入照樣被拒（fail-closed），其他操作 exit 1（不擋）；連 repo root 也找不到時 exit 1。plugin 型 runtime 的 hook bridge 同一套解析序（見其 platform adapter）；測試見 `hook-launcher-rules-root.test.mjs`
- 純 Node.js `fs` + `child_process`，不依賴 shell built-ins；child hook 失敗時會顯示 event、script path、exit code
- 任何有 `node` 的平台皆可執行（macOS / Linux / Windows 原生）；launcher body 在三 runtime byte-identical，命令尾端 `--host=<runtime>` 允許依 runtime 不同

**為什麼**：`devpro-agent-rules` 以 submodule 形式被多平台專案引用。source-repo scripts 失敗於某一平台 = consumer 體驗破損。裸相對路徑在 agent `cd` 子目錄後靜默失效，是比 POSIX shell 更危險的隱性失效。

**POSIX-only 不限 shell built-ins——Node.js API 也有 POSIX-only syscall 語意**：改寫成 `node -e` 或 `.mjs` 不自動保證跨平台；某些 `node:fs` 呼叫本身封裝的是 POSIX-only syscall，在 win32 上無等價 API。

❌ 目錄 handle fsync 未判斷平台（win32 上 `openSync`/`fsyncSync` 於目錄路徑丟出）：

```js
function fsyncDirectory(directory) {
  const fd = openSync(directory, "r"); // throws on win32: no directory-handle open
  fsyncSync(fd);
  closeSync(fd);
}
```

✅ 平台注入的 SSOT helper，win32 no-op（無等價 API，明文揭露而非鬆綁 durability 保證，見 `openspec/changes/archive/2026-08-18-fix-windows-cross-review-dispatch/design.md` D1/D2）：

```js
export function fsyncDirectory(directory, { platform = process.platform } = {}) {
  if (platform === "win32") return;
  let fd;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
```

**適用範圍**：
- `.claude/settings.json` / `.codex/hooks.json` / `.cursor/hooks.json` hook commands
- `.devpro/scripts/**` shell scripts（.sh）— 優先改寫成 .mjs
- rule file 範例中的 inline shell command
- **Node.js API 的 POSIX-only syscall 語意**（例：目錄 handle 的 `openSync`/`fsyncSync` 組合——檔案 fd 的 fsync 全平台皆可，目錄 entry fsync 為 POSIX-only、win32 無等價 API）

**可接受的 POSIX-only 例外**：
- 明確標注「僅 macOS/Linux」的文件範例
- 僅在 maintainer 機器執行的內部建置腳本（不會隨 submodule 出貨）

**Test guard 局限**：`cross-platform-hook-commands.test.mjs` 的 regex 為 minimum tripwire（涵蓋 `test -[fdrwxe]`、單 `[ -f`、line-start `find`），**未涵蓋** bash `[[ -f`、GNU-only `find -mtime` / `-printf` 等延伸式，也**未涵蓋** Node.js API 層的 POSIX-only syscall（目錄 fsync 例見 `directory-fsync-portability.test.mjs`）。完整 cross-platform detection 由 reviewer 軸（`code-review-checklist.md` §Cross-Platform）補位。

對應 leaf：`code-review-checklist.md`（§Cross-Platform 軸）；`rule-design-principles.md` Principle 5（cross-platform scripts）；`directory-fsync-portability.test.mjs`（Node.js POSIX-only syscall 反例：目錄 handle fsync）

### §13. Convenience-Driven Boundary Placement（為部署方便而錯置邊界）

❌ Consumer repo 把 PredictiveDialer 的 dashboard（`*.html / *.css / *.js`）塞進
`Literati.Connect.WebDialer/wwwroot/`，理由是「nginx 已 mount `/usr/share/nginx/html`，
放這裡最省事」。但 PredictiveDialer 早已有獨立的 `.PredictiveDialer` +
`.PredictiveDialer.Api` project；dashboard 是 campaign / operator tool，與
browser SIP 撥號器（WebDialer）毫無 domain 重疊——邊界完全錯置。

✅ 先問：「這個檔案的 domain 屬於這個 project 嗎？」邊界正確才放。

對上例：建 `Literati.Connect.PredictiveDialer.Dashboard` 獨立 static asset
project（或併入 `.PredictiveDialer.Api/wwwroot`，若 dashboard 與 API 同
ownership）。nginx mount 路徑之後補設定、CI pipeline 之後補步驟——這些成本可逆；
錯誤邊界造成的汙染不可逆。

**認知根源**：便利性的成本是可逆的（補一條 nginx config、加一個 CI 步驟即解）；
錯誤邊界的成本是不可逆的（持續累積 coupling、模糊 ownership、汙染所有
後續 caller / consumer）。成本不對稱 → 邊界正確永遠優先於部署方便。

「目前部署比較方便」「reuse 既有目錄」「nginx / CI 已經設好」全是合理化
（per `ai-autonomy-rationalizations.md` Common Rationalizations）。Review 看到此類安排必須
surface、不得默許。

**適用範圍**：跨 C# project、front-end app、static asset、spec、rule leaf
等**任何** ownership 邊界決策——不限 .NET，只要涉及「要把這個東西放在哪個
module / repo / 目錄」的判斷，均適用本 anti-pattern。

對應 leaf：`project-structure-sln-and-folders.md`、`ai-autonomy.md`、`rule-design-principles.md`

### §14. Incomplete Character-Class Enumeration（改 regex 字元類沒窮舉成員）

改既有 regex 的字元類 / whitespace boundary 時，只盯著 happy-path token，沒有**系統性窮舉「被加入或移除的字元類成員的完整集合」**，導致跨命令-段邊界被意外打開或關閉。

❌ 收緊 `CMD_POSITION_ANCHOR` 的 command-introducing keyword 前綴，把 `[\s;|&(`{]` 改成
`[;|&(`{]`（目的：擋掉 `echo then git push` 這種 keyword 在 argument position 的誤判）。
看起來只是「移除一個空白邊界」，但 **`\s` 涵蓋 `\n`/`\r`**——一移除，`if true⏎then git
push --force⏎fi` 這種 **natural multiline keyword block** 就不再 match → 真實 force-push
漏接（Axis-A false-negative）。

❌ 同一個 PR 的 content-materialize gate，inter-token 空白用 `\s+`（`git checkout
<tree-ish>(\s+<token>)+ \s+ -- <pathspec>`）。`\s` **含 `\n`**，所以 `git checkout
main⏎git diff -- x`（兩條獨立命令、換行分隔）被 `\s+` 橋接，綁到後面那條的 `-- x` →
正常多行命令誤擋（false-positive）。**同一個 `\s`-含-`\n` 錯誤，同一個 PR 犯兩次。**

✅ 改字元類前，先把**被加/移除字元類的完整成員列出來**，逐一問「這個成員在我的語境是要的嗎？」固定等價表（背下來）：

- `\s` ⊇ space ` ` + `\t` + **`\n`** + **`\r`** + `\f` + `\v`，且 JS 還含 Unicode 空白（NBSP U+00A0、U+2028/U+2029 行/段分隔、BOM、各式 en/em space）——所以連這張表都不算窮舉，正是「速記藏成員」本身的例子；改動 `\s` 時務必對照引擎實際定義（移除 `\s` = 連帶移除換行邊界 + 這些 Unicode 空白）
- `\S` = `\s` 的補集（改一個，同步想另一個會不會反向破洞）
- `.` 預設**不**含 `\n`（除非 `s`/dotAll flag）
- `[^|;&]` 之類排除集：有沒有漏排 `\n` / `<>()` / grouping 字元而跨命令段？
- 「命令分隔符」只有 `\n` 與 `; | &`（及其組合）；`\t` 是 token 空白**不是**命令分隔——要區分「horizontal whitespace」`[^\S\n\r]`（space/tab，同命令內）與「命令邊界」（newline / `;|&`）。
- 同理 `\w` ≡ `[A-Za-z0-9_]`（含底線、不含連字號）、`\d` ≡ `[0-9]`、unicode property `\p{...}`（如 `\p{L}` 含全部 Unicode 字母，遠大於 ASCII）——任何把一組字元壓成單一符號的速記，改動時都要先展開成員。

✅ 對上例：keyword 前綴應保留 `\n\r`（`[;|&(`{\n\r]`，只排除裸 space/tab）；inter-token 空白應用 horizontal-only `[^\S\n\r]+`（不跨 newline）。

**測試義務**：每個被加/移除的類成員都要有對應正/負 case，**特別是 `\n`/`\r`/`\t` 分隔形式**；且斷言**可觀測**——block 要帶可辨識 reason marker，禁止用「reason 不含某字串」這種對通用 reason 永真的 **vacuous 斷言**（PR #933 round 6：negative 測試斷言 `doesNotMatch(/content|materialize/)` 對通用 protected-write reason 永遠通過，等於沒測）。

**認知根源**：字元類速記（`\s` `\S` `.` `\b`）把一組字元壓成一個符號，省了打字但藏了成員——改動時大腦只 retrieve「空白」這個 label，不會自動展開 `\n\r\f\v`。primary 六軸與 proposer 同樣靠 retrieve label，所以**同型錯誤會反覆漏**；唯有把「展開成員逐一驗 + 每成員配 `\n` 測試」變成 mechanical sub-check（`code-review-checklist.md` 軸 1）才前移得了。

**適用範圍**：任何 regex 字元類 / whitespace 量詞 / anchor / boundary 的**新增或修改**——hook gate、rule 範例 inline regex、CI script、test fixture 皆適用。

對應 leaf：`code-review-checklist.md` 軸 1 Regex character-class sub-check、`rule-design-principles.md`

### §15 Incomplete Supersede Sweep（取代舊方法未掃全 call site）

引入新方法（NewMethod）取代舊方法（OldMethod）時，只遷移部分 call site，其餘殘株繼續呼叫舊方法——且編譯零警告，未來新開發者也可能再次誤用舊方法。

❌ 新增 `ParseContent()` 取代 `ParseContentLegacy()`，只改了發起此次需求的三處呼叫端，其他 8 處 `ParseContentLegacy()` 維持原樣。新格式的 output 與舊格式 incompatible：舊路徑在真實環境 throw `FormatException`，但 unit test mock passthrough、六軸 review 全未偵測，上線才爆發 latent bug。

```js
// ❌ 只改了 3 處，殘留 8 處舊呼叫——零警告，零提示
parseContentLegacy(data);  // 未遷移的殘株
```

✅ grep 全 repo 定位 `ParseContentLegacy` 所有 call site，逐一遷移或明確標注保留理由（保留須走 §16 deprecate）；PR 佐證掃描已執行：

```bash
grep -rn "ParseContentLegacy" .   # 掃全 repo，確認 0 命中或每命中均有書面理由
```

```js
// ✅ 全部 call site 已遷移或有明確保留理由
parseContent(data);
```

**§1 張力對照（MUST 理解）**：

| | §1 Drive-by Refactor | §15 Incomplete Supersede Sweep |
|---|---|---|
| 核心問題 | 改了**不相關**的 call site（scope creep） | 漏改了**應該改**的 call site（scope completeness） |
| 判準 | 該行變更是否能追溯回被取代的 symbol？ | call site 是否為被取代 symbol 的「真實依賴」？ |
| 行動 | 不相關 → 不改 | 真實依賴 → 必須改或有書面保留理由 |

兩者不矛盾：**真實依賴**的 call site 全要改到（§15）；無關的程式碼不要碰（§1）。判準統一為「這個 call site 是否依賴被取代的 symbol 的舊語意」。

**認知根源**：PR scope 自然聚焦在「觸發本次需求的那幾個 call site」，其餘殘株在 diff 看不到、test mock 遮住、reviewer 只看新增行——同型 latent bug 在下次格式不符的環境才引爆。唯有把 grep 掃全 repo 變成 PR 交付義務（佐證截圖或 `grep -c` 結果 = 0）才能機械化兜底。

**適用範圍**：任何語言的方法取代、API 遷移、serializer 替換、格式升版——只要引入新 symbol 取代舊 symbol，均須 Supersede Sweep。

對應 leaf：`code-review-checklist.md`（軸 1 Root-cause adequacy sub-check / 軸 4 測試充分性——PR review 時要求 supersede sweep 的 grep 佐證）

### §16 Retained-API Without Hard-Fail Deprecation（保留舊 API 未配硬攔 deprecate）

保留舊 API（§15 允許保留，但保留就要走本條）時，**MUST** 用語言的 deprecate 機制標記 + 排期移除計畫（removal plan）。只做標記而不升 error 級，大型 codebase 中警告被淹沒，等於沒有任何攔截。

**核心論點：標記 ≠ 硬攔**：deprecate 標記預設多為 warning / IDE hint；未升 error 級則新呼叫靜默通過，舊 symbol 持續蔓延——保留項 **MUST** 配 build-error 升級或等效 linter error 強制。

**7 語言對照表**：

| 語言 | 標記 | 硬攔（升 error） |
|---|---|---|
| C# | `[Obsolete("理由 + 指向替代")]` | `error: true` 參數，或 `TreatWarningsAsErrors`；規模化：`BannedApiAnalyzers` + `BannedSymbols.txt` + `allowlist`；合法保留處 `#pragma warning disable CS0618` |
| Java | `@Deprecated` | `javac -Xlint:deprecation -Werror`（需 `-Xlint:deprecation` 才會升 error）/ error-prone |
| TypeScript | `@deprecated` JSDoc（TS LS 型別感知警告） | `eslint-plugin-deprecation`（type-aware，設 error 才硬攔；tsc 本身不因 `@deprecated` 報錯） |
| JavaScript | `@deprecated` JSDoc（editor 警告，弱、無型別感知） | ESLint `no-restricted-imports` / 自訂規則（涵蓋較淺） |
| Python | `warnings.warn(DeprecationWarning)` / `@deprecated`（PEP 702 / `typing_extensions`） | runtime `python -W error::DeprecationWarning`；型別層 pyright / mypy（認 PEP 702 `@deprecated`）。注意 `ruff` 不對任意 `@deprecated` 做通用 hard-fail |
| Go | `// Deprecated:` 註解 | staticcheck / gopls（CI 強制） |
| Rust | `#[deprecated]` | `#![deny(deprecated)]` |

> **關鍵註腳**：`@deprecated`（JS/TS JSDoc）本身永遠只是提示，真正 build-error 強制一律靠 linter 設 error 級——「標記 ≠ 硬攔」最明顯處。

**反 footgun（MUST）**：禁止把錯誤/已過時的那組標成「推薦/優化版本」。真實反例：legacy `EncryptString` 的 docstring 標記了「加密-優化版本」，主動把舊格式標成推薦，加劇 footgun——新開發者看到「優化版本」反而優先選錯的那個。標記方向必須是舊（壞）→ deprecated，新（好）→ preferred。

**§15 互引**：§15 允許在有書面理由時保留 call site；保留就要走本條 deprecate + 排期移除（removal）計畫，使殘留不再是零警告的盲點。

**認知根源**：「加個 `[Obsolete]` 標記就夠了」是最常見的認知捷徑；但 warning 在 CI log 幾百行中消失無蹤，大型 codebase 裡 warning = silence。只有升 error 級才能讓舊 symbol 的每次新用途立刻阻擋 build。

**適用範圍**：任何語言的 API 保留決策——helper / util / serializer / formatter / HTTP endpoint，只要決定「暫時保留舊版」，均適用本條。

對應 leaf：`code-review-checklist.md`（軸 1 Root-cause adequacy / 軸 4 測試充分性）、`csharp-style-and-dry.md`（C# 一般風格；本條 C# 的 `[Obsolete]` 機制見上方 7 語言對照表）
