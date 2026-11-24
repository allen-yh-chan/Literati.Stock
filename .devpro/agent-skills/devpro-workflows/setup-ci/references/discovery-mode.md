# /devpro:setup-ci discovery mode（無參數）

Topology note：本檔為 `devpro:setup-ci` umbrella skill 的子步驟，不是可獨立由使用者觸發的 skill/command（原始 command 來源帶有 `disable-model-invocation: true`）。只在 umbrella body 路由至此（無參數呼叫）時才載入本檔。

用途：偵測目前 repo 尚未安裝的 CI component，逐一詢問 user 是否安裝。

### Steps

1. 掃描 `.github/workflows/` 現有檔案。
2. 依 `ci-setup-components.md` dispatch 規則判斷 stack 與可安裝 component。
3. 只列「可安裝且未安裝」的 component。
4. 逐一詢問：
   - `detected <x>, missing <y> — install <y>? [y/N]`
5. user 回 `y` 時，再呼叫對應 fast path leaf（integration/codeql）。

### Constraints

- 每個 component 都需單獨確認
- 不得在 discovery 模式直接套用預設覆寫現有 workflow
