# /devpro:setup-ci integration

Topology note：本檔為 `devpro:setup-ci` umbrella skill 的子步驟，不是可獨立由使用者觸發的 skill/command（原始 command 來源帶有 `disable-model-invocation: true`）。只在 umbrella body 路由至此（`integration` fast path）時才載入本檔。

用途：安裝 integration deployment workflow 與必要 secrets/variables。

### Required Rules

- `.devpro/agent-rules/ci-cd-integration-deployment.md`

### Steps

1. 詢問並確認使用者提供：
   - integration IP
   - RunnerRelay API key
   - `runs-on` label
   - deploy path（若適用）
   - E2E command（若有）
2. 設定 secrets/variables：
   - `INTEGRATION_IP`
   - `INTEGRATION_AGENT_KEY`
   - `INTEGRATION_DEPLOY_PATH`（若適用）
   - `INTEGRATION_BASE_URL`（若適用）
3. 依規則模板建立/更新 workflow：
   - `deploy-integration.yml`
   - `e2e-integration.yml`
   - `fetch-integration-log.yml`
   - `test-runner-relay.yml`
4. 若遇同名既有 workflow，先詢問更新策略。
5. 回報下一步：手動觸發 `Test RunnerRelay` 驗證連線。
