---
name: platform-adapter-codex-host-cross-review-troubleshooting
description: Codex-host cross-review cold troubleshooting sibling：Claude probe history、permission_denials、error_max_turns、sticky-only retry。只在 Codex-host Claude reviewer invocation 出錯時載入；一般 orchestration 只讀 `platform-adapters/codex-host-cross-review.md`。
---

# Codex Host Cross-Review Troubleshooting

> Load-chain：由 `platform-adapters/codex-host-cross-review.md` on-demand 指到；正常 Step 5.5 / focused sticky-refresh 不預載。

## Provider Probe History

2026-06-05 live probe：Claude Code 2.1.163 `--max-turns 1` trivial no-tools JSON 仍可回 `error_max_turns`；PR #910 `--max-turns 2/3` same；no-max `--output-format json` exit 0 但 `result` 空；stream-json 可能先出 parseable completion JSON 再混入 Stop hook chatter。

Default correction：不要把調大 `--max-turns` 當主要修復。Codex-host Claude path uses stream-json evidence；owning wrapper 每 `60s` sample stdout/stderr delta，`15m` checkpoint 自動續跑，`30m` final verify/classify 後自動終止。Host extract 第一個 schema-valid completion JSON (`sticky_comment_url` / `verdict` / `last_reviewed_sha` / `reviewer_model` / `reason`) then verify PR sticky。`WARN` / `CRITICAL` 缺少可見 actionable reason 時，不得猜測 hidden thinking 或視為完成；missing/blank reason=`reviewer_completion_reason_missing`，修正 packet 後 focused retry；over-cap/invalid reason=`reviewer_completion_contract_invalid`。

## Projection Observability Faults

Runtime-native `dp-second-reviewer` projection may hide projection-internal `claude -p` stdout/stderr from TL; that alone is not hang evidence.

- If runtime API cannot expose projection-internal stdout/stderr/activity artifacts, record `projection_log_unavailable_by_runtime_api`; this does not waive wrapper-owned artifact paths when wrapper owns reviewer CLI.
- Runtime 有 completion callback/event 時，TL registers and waits for it；MUST NOT poll projection/agent lifecycle。只有 runtime 明確沒有 callback/event 時，TL 才可每 `60s` bounded poll lifecycle/artifact/sticky，最多30次／`30m`。Reviewer subprocess owner 仍獨立每 `60s` sample stdout/stderr liveness；兩者不可混為一談。
- Wrapper MUST write `activity_log_path` / `stdout_log_path` / `stderr_log_path` or heartbeat while reviewer CLI is active; TL polls mtime/size/heartbeat. Do not ask reviewer packet to create logs with Python/heredoc/pipes/redirection/loops.
- Renderer sidecar MUST expose `reviewer_cli_recipe.required_invocation_args`; after `flags_supported`, wrapper uses them exactly, no reconstructed `claude -p` argv. Codex-host Claude `stream-json` includes `--verbose` before `--output-format stream-json`.
- Only `required_flag_absent_in_host_help` is true unsupported recipe evidence. `probe_evidence_unavailable`, `probe_malformed`, `probe_capture_suspect`, and `recipe_parser_mismatch` are probe faults; fix capture/parser first.
- Typed HTTP `400` that explicitly names unsupported/invalid effort、thinking、or reasoning input is `reviewer_cli_recipe_incompatible`；HTTP `401`/`403` or explicit auth type remains authentication failure；unrelated `400` remains `reviewer_cli_failed`。
- Missing required wrapper-owned artifacts are `projection_observability_contract_missing`; stale artifact + no fresh sticky + non-terminal projection is `projection_activity_stale`.
- Missing TL-side stdout/stderr MUST NOT be treated as reviewer inactivity. Reviewer-runner stdout liveness sampling applies only to a direct runner/executor surface that owns/captures reviewer subprocess stream.
- Direct CLI fallback is allowed only after a documented reason: `projection_unavailable`, `tool_discovery_blocked`, manual/projection failure, `projection_observability_contract_missing`, `projection_activity_stale`, or stale/no fresh sticky after observation. Verify sticky freshness first.
- Dispatch sanitizes cmux PATH; leftover then fallback.

## Max-Turn / Empty Result

- `error_max_turns` = invocation/orchestration evidence。
- Allowed next actions：重組更小 packet、修 mode、改 stream/progress extraction、切 approved Deep Review/tmux path，或寫 audit-only `UNAVAILABLE`。
- Forbidden：same-shape broad rerun, or only changing `--max-turns`；不得只調 `--max-turns` 反覆重跑。
- stale `PASS|WARN` + narrow delta broad rerun timeout/error：reframe focused sticky-refresh packet.

## Permission Denials And Sticky Write

`requires approval` / `permission_denials` / sticky write failure 是 allowlist or command-shape fault，不是 reviewer unavailable。

- 若第一批工具要求是 `pwd`、`ls`、`env`、`printenv`、`set`、`git` 或 compound shell，代表 Claude 探索式 default system prompt 仍生效；canonical renderer recipe 的 exact-once fixed `--system-prompt` 缺失或 drift。MUST stop、repair recipe/probe、重新 render/dispatch；MUST NOT 擴大 allowlist、忽略 denial、或壓縮／改寫 packet 語意。
- Bounded profile：PR read/diff/comment/API, read-only repo inspection, optional `Write` only to a body file in the reviewer current neutral cwd.
- Existing sticky PATCH retry MUST be sticky-only：comment id + head SHA + final sticky body; Write `cross-model-second-opinion.md` in the neutral cwd, then execute only the packet `sticky_write_exact_recipe` (gated sticky write CLI + credential-gate sidecar). NEVER raw `gh api` POST|PATCH `body=@`.
- Forbid heredoc, repo body staging, redirection, pipe, backtick, inline `--body`, worktree-internal sticky body files, repo write, git write, merge.
- Allowlist may narrow to Write + the absolute gated sticky-write / sticky-read CLI patterns with `--permission-mode dontAsk`. Initial create and update MUST use the packet `sticky_write_exact_recipe` only; NEVER recover via raw `gh api` POST|PATCH `body=@` or `gh pr comment`. Claude copies the literal PR number only from the validator-checked canonical PR target；`gh` consumes injected `GH_REPO` implicitly，and shell parameter expansion remains forbidden.
- If optional verification commands are denied, sticky evidence MUST NOT claim they ran. Reviewer/sticky-only PATCH must correct overclaim.
- Sticky provenance MUST copy the renderer-provided exact `AGENTS.md` Rules version and end the body as `Rules: v<exact version> · Tool: <token per STICKY_PROVENANCE_TOOL_TOKENS, second-review-sticky-authority.mjs> · Model: <actual reviewer model>`；packet schema `v3` MUST NOT be substituted for the Rules version，and runner mismatch is a sticky-contract fault.

## Provider Transient

HTTP `529 overloaded` is provider transient, separate from sandbox/auth/permission denial. Use retry/backoff or human handoff; do not classify it as auth failure.

## Verification

```bash
rg -n "2026-06-05 live probe|error_max_turns|permission_denials|Sticky write|529 overloaded" .devpro/agent-rules/platform-adapters/codex-host-cross-review-troubleshooting.md
```
