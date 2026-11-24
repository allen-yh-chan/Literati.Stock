# devpro:second-review — Cursor 或其他（非 Claude Code、非 Codex） host projection route

由 `SKILL.md` §Projection Routes 載入：當前 host 是 Cursor 或其他（非 Claude Code、非 Codex） 時讀，其他 host 不讀。本檔內「本 skill」指 `devpro:second-review`（`SKILL.md`）。

### Cursor And Other Hosts

Cursor projection 必須先讀 `.cursor/agents/dp-second-reviewer.md`、本 skill、以及 `platform-adapters/cursor.md`。Host-auth 邊界涵蓋 **renderer effort probe**（Claude-family `render-second-review-packet.mjs` live `claude -p`），不只 runner 的 `claude -p` / `codex exec`。Cursor 跑 renderer 前 MUST 套用 adapter **TL renderer Shell**。Cursor host 無固定 primary model；resolve `primary_family` 後依下表選 reviewer。**primary 未證明時仍 dispatch `reviewer_family=codex`（不停下 remap），但 pr-sticky 不得宣稱 cross-model credit**：

- `primary_family=claude`：走 Claude-host 對稱的 Codex reviewer chain（Codex CLI manual + `platform-adapters/codex-cli-tooling.md`；packet `reviewer_family=codex`）。
- `primary_family=openai-codex`：走 Codex-host 對稱的 Claude reviewer chain（Claude Code manual + `platform-adapters/claude-code-cross-review.md` + `claude -p`）。
- `primary_family=gemini` / `other`：使用 `platform-adapters/cursor.md` 指定的 adapter-configured different-family reviewer（有 explicit `$CROSS_MODEL_REVIEWER` 時優先）；若無明示 reviewer，先問或標 fallback。
- `primary_family=unknown` 或 Cursor host 無 trusted primary evidence：**pr-sticky** — dispatch `reviewer_family=codex` + packet `primary_family=unknown`；sticky MUST 標 `cross-model-unverified`（或 proven same-family 時才 `same-family fallback`）；MUST NOT 宣稱 different-family cross-model。**design gate only** — Design-Author `identity: unknown` + `provenance: unknown` + handoff `primary_family: unknown` + 預設 `reviewer_family: codex`（見 `platform-adapters/cursor.md` design-gate default；helper=`host_primary_unproven`，禁假 `claude` alias／禁 same-family 貶義）。TL MUST NOT 因 primary 未知**在 dispatch 當下**停下詢問「Claude 還是 Codex」；devpro:change 開頭條件式預選（change ledger `second_reviewer_family`）為 sanctioned 前饋，不在禁止之列。禁止 `cursor-composer` 等非 canonical token。
