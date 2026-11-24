---
name: platform-adapter-codex-cli-tooling
description: "Codex CLI cold-path details for external reviewer/tool invocations, anti-hang stdin handling, PTY/timeout evidence, and focused sticky refresh."
---

# Codex CLI Tooling

## Overview

Cold-path instructions for using Codex CLI as an external tool, especially for cross-model review from non-Codex primary hosts. Ordinary Codex repo work should not load this leaf.

## When to Use

- Another host invokes Codex CLI as a second-opinion reviewer
- A workflow needs `codex exec` non-interactive output
- A prior Codex CLI invocation hung, waited on stdin, or failed with auth/session ambiguity

## Process

### Auth and sandbox boundary

When another host treats Codex CLI as second-opinion / external CLI tool, first read `code-review-cross-model.md` §Second-Opinion / External-CLI Sandbox Policy.

Codex sandbox 禁用: Codex CLI needs host-level auth/session (account, keychain, home-dir state, local daemon state depending on version). When Codex CLI is used as external reviewer CLI (`codex exec`), it MUST NOT run inside Codex sandbox. Sandbox failures such as `not logged in` / permission denied only prove wrong surface, not invalid credentials. Sandbox may only run no-auth probes such as `command -v codex` or `codex --version`.

This same host-auth rule applies to `gh` / GitHub remote `git` / `claude` host-auth modes.

### CLI flags

| Need | Codex CLI flag |
|---|---|
| non-interactive run + machine-readable stream | `codex exec --json "<prompt>"` |
| close stdin | `</dev/null` |
| working root | `-C <neutral>` for prompt-contained review; `-C <abs-worktree>` only for intentionally repo-bound invocations |
| model | `-m <model>` when needed; shared rules do not hardcode model literals |
| reasoning effort | `-c model_reasoning_effort="xhigh"` when available; otherwise highest available tier |
| sandbox policy | `-s read-only` / `-s workspace-write` / `-s danger-full-access` only when changing current surface; pr-sticky reviewer uses `-s workspace-write -c sandbox_workspace_write.network_access=true` (network+host auth for `gh pr comment`; sticky body writes to the `-C` neutral cwd, no `--add-dir`) |
| approval policy | none for `exec` — `codex exec` is non-interactive by default; `-a` / `--ask-for-approval` is top-level-only (interactive TUI) and the `exec` subcommand rejects it as an arg error |
| final-message file | `-o <verdict-file>` / `--output-last-message <verdict-file>` |
| response schema | `--output-schema <schema-file>` |

If TL already runs on an outside/full-access surface, repo file writes do not need another sandbox flag. Do not use approval/sandbox bypass flags as a substitute for policy judgment.

### Codex CLI Cross-Review Skill

Read the full skill when invoked: `.devpro/agent-skills-refs/autonomous-ai-agents/codex/SKILL.md`. Fixed Devpro anchors:

- Git repo required.
- Auth may come from env or Codex OAuth; missing env var alone is not unavailable.
- `codex exec` is bounded one-shot; background / `/goal` / broader interactive lane are not default cross-review paths.
- Some Codex CLI versions need `pty=true` even for `exec`; if terminal integration has a PTY option, set it.
- Capture stdout/stderr evidence and child-process lifecycle.
- When `codex exec` is owned by a `dp-second-reviewer` projection/executor wrapper, the wrapper MUST expose renderer-generated TL-readable `observability_context` artifacts (`reviewer_surface: host-non-sandbox-required`, `runner_owner: adapter-host-runner`, `sandbox_policy: auth-required-reviewer-cli-must-not-run-in-sandbox`, `activity_log_path` / `stdout_log_path` / `stderr_log_path` / `cli_probe_result_path`, `projection_bootstrap_script`, cwd-independent absolute `projection_bootstrap_command` (every host, no exception), `projection_runner_script`, `projection_runner_command` (cwd-independent absolute on every non-Codex primary host calling `codex exec` **except the Claude Code host**, whose runner carrier is **repo-root-relative**), `cli-probe-result.json`, `reviewer_cli_recipe`, `reviewer_cli_recipe.required_invocation_args`, `required_activity_events` / `duration_conditional_activity_events`, `heartbeat_interval_seconds > 0 && <= 60`) and update heartbeat/progress while the CLI is active. Its first tool action after handoff MUST execute the exact `projection_runner_command` from the sidecar：on the Claude Code host this is the relative typed carrier `node .devpro/scripts/run-second-reviewer-projection.mjs '<observability_context_path>'`, executed with cwd at the renderer repo root; the runner self-check before authorization/any mutation returns `projection_runner_cwd_not_repo_root` when cwd/own-root/renderer-root disagree. On every other primary host it is a cwd-independent absolute path to canonical `.devpro/scripts/run-second-reviewer-projection.mjs` plus `observability_context_path`. The canonical runner MUST run `.devpro/scripts/ack-second-reviewer-projection.mjs`, append `projection_handoff_validated` (or `projection_observability_contract_missing` / `projection_runner_unavailable`) to `activity_log_path`, refresh `heartbeat_path`, run `.devpro/scripts/probe-second-reviewer-cli-recipe.mjs <observability_context_path>`, append `projection_cli_probe_started` and `projection_cli_probe_result`, write `cli_probe_result_path`, and only proceed to CLI when classification is `flags_supported`. After `flags_supported`, the runner MUST invoke with `reviewer_cli_recipe.required_invocation_args` exactly; cross-host sidecars carry the full args, including Codex-host Claude `--verbose` before `--output-format stream-json` where applicable. Only `required_flag_absent_in_host_help` is a true unsupported CLI recipe; `probe_evidence_unavailable`, `probe_malformed`, `probe_capture_suspect`, and `recipe_parser_mismatch` are probe evidence faults, not `projection_runner_unavailable`. Before CLI spawn it MUST append `projection_cli_starting`, then `projection_cli_started` after successful spawn, `projection_cli_liveness_sampled` every `60s` while open, and `projection_cli_status_checkpoint` at a non-terminal `15m`. In `pr-sticky`, sticky freshness MUST be verified with `projection_sticky_verification_started` and `projection_sticky_verified|projection_sticky_verification_failed` before `projection_cli_exited`; at the hard cap this verification precedes timeout record and transport termination，a marker-bound exactly-one canonical current-head `PASS` preserves Post-PR completion while `cli_exit.timed_out` retains the transport/finalization fault；`WARN` preserves Post-PR completion only with no current fault and a complete correctly bound completion/receipt chain； sticky write attempts MUST NOT be inferred from stale sticky comments. TL first 60s observation window MUST see that post-handoff heartbeat/activity event, terminal status, or fresh sticky; otherwise TL classifies `projection_activity_stale` without waiting for the total cap. `projection_log_unavailable_by_runtime_api` is not a waiver for wrapper-owned artifacts. If the projection cannot access a host/non-sandbox runner surface for auth-required reviewer CLI execution, it MUST return `projection_runner_unavailable` before dispatch rather than waiting through the `30m` observation window.
- The canonical runner is the sole caller of `projection_bootstrap_command` / acknowledgement；TL and projection instructions MUST NOT execute either manually before `projection_runner_command`. Before first-PATH-hit inspection, the runner sanitizes its own dispatch env once（bounded cmux PATH directory entries removed; NODE_OPTIONS cleared on cmux evidence; unmatched env is a no-op; evidence may record only counts/booleans）. After acknowledgement and the dispatch identity-collision check, and before sticky disposition、scope、help、auth、or reviewer spawn, the runner MUST inspect only the logical reviewer tool's first executable PATH hit and realpath it. Missing hit、realpath failure、or a bounded identifiable cmux path shape（including a `cmux-cli-shims` segment or cmux wrapper/app-resource identity）MUST return exact `tool_discovery_blocked`, publish the `spawn_or_probe_failure` pre-spawn closed-terminal receipt with no invocation claim, perform no later PATH search or affected process invocation, and persist no resolved path. Arbitrary scripts and ambient environment markers alone MUST NOT be rejected. Win32 discovery MUST use Win32 paths/delimiter and PATHEXT order, accept only bounded pure extension tokens, ignore extensionless files and malformed separator/traversal tokens, trust only `.COM`/`.EXE` as direct, and block the first existing `.BAT`/`.CMD`/other shell-dependent candidate as exact `tool_discovery_blocked` without fallback or `shell: true`. A trusted direct hit binds the same absolute realpath to help、auth、and reviewer spawns through the production probe executor while preserving renderer-owned argv and the logical tool contract；path-bearing probe failures restore logical tool identity and persist/return only stable generic/code evidence；successful attempts emit exactly one `projection_handoff_validated`.
- Canonical `reviewer_cli_recipe.auth_preflight` is executable host-surface evidence, not reviewer argv. After help flags pass and before neutral cwd、claim、or spawn, the runner MUST directly execute exact `claude auth status --json`（exit 0 + top-level `loggedIn: true`）or exact `codex login status`（exit 0）with the reviewer's inherited environment. Only exact success preserves `flags_supported`; all other／timeout／overflow／restricted-HOME／ambiguous outcomes are pre-spawn `reviewer_host_surface_unverified`, not a real auth diagnosis. Raw policy is `memory-only-do-not-persist`; artifacts omit raw、excerpt、hash、identity、token、path, and declarations or output keywords cannot forge verification.
- Streaming/progress mode: owning wrapper samples stdout/stderr liveness every `60s`; a non-terminal `15m` checkpoint auto-continues; total hard cap is `30m`.
- Single-result JSON-only mode: same `15m` auto-continue checkpoint and `30m` hard cap; no stdout alone is not hang. Callback/process close is the sole terminal completion signal.
- Projection sidecar is untrusted after render：renderer、ack、and runner each MUST use the same exact family/mode canonical-recipe validator before artifact mutation、probe、or spawn；the complete ordered tool/probes/flags/aliases/argv/paths/allowlist object MUST match or fail `reviewer_cli_recipe_invalid`. `projection_cli_started`、process start time、timers、and stdin begin only after the child `spawn` event. At hard cap the wrapper performs `SIGTERM` → bounded grace → process-group `SIGKILL` where supported（child fallback otherwise）→ bounded force-settle, so the runner promise always resolves even if `close` never arrives.
- Codex `audit-only` exit 0 is successful only when JSONL contains an `item.completed` `agent_message` whose text is the exact ordered completion object `sticky_comment_url`、`verdict`、`last_reviewed_sha`、`reviewer_model`、`reason`, with `sticky_comment_url: "none"`, current SHA, and `PASS|WARN`. Missing、malformed、extra/reordered keys、stale SHA、`CRITICAL`、or `UNAVAILABLE` fail closed.

#### Neutral-CWD Launch Contract（SSOT）

Cross-review codex invocation **MUST** use a neutral cwd (scratchpad / system temp, not the target repo root) to prevent codex from auto-loading the target repo `AGENTS.md` into TL-orchestrator mode. **The neutral cwd (`-C`) is the primary TL-mode protection**: codex auto-loads project docs (`AGENTS.md`) from its working-root tree, so a cwd outside the repo means there is no `AGENTS.md` to load. Mandatory flags:

- `-C <neutral>` — set cwd to a neutral directory (e.g. system temp / scratchpad), not the target repo root. **This is the flag that prevents `AGENTS.md` auto-load** (codex reads project docs relative to its working root).
- `--ignore-rules` — do not load user/project execpolicy `.rules` files (a command-approval mechanism; defense-in-depth so the neutral dir's policy can't alter behavior — it does NOT control `AGENTS.md` project-doc loading, which is governed by `-C`)
- `--skip-git-repo-check` — do not require a git repo at the cwd (neutral dir is not a repo)
- `-s <policy>` — pr-sticky mode reviewer MUST write the PR sticky (`gh pr comment`), so the recipe uses `-s workspace-write -c sandbox_workspace_write.network_access=true` to give the reviewer network+host auth for that write while keeping filesystem isolation (not `danger-full-access`); `read-only` would block it. The "reviewer must not run shell/write other files" guarantee comes from the in-prompt-only preamble below, not from sandbox read-only. `audit-only` mode shares the same network-enabled surface (read-only would cut off adapter-live-pr-reads); the write-vs-read boundary is carried by write_path/approval mode-awareness, not by the sandbox flag.
- No `--add-dir` grant — the `-s workspace-write` sandbox writable set is the `-C <neutral>` cwd only, and the sticky `write_path` now requires the reviewer to write its body file into that same neutral cwd (never worktree-internal, never main-checkout `notes/tmp`), so no additional directory grant is needed; the renderer derives its writable-root set from the exact recipe args, so a future re-add is caught mechanically. **Regression fence**: MUST NOT re-add `--add-dir` pointing at the main checkout's `notes/tmp`, or at any other repo-internal path — that would hand the reviewer read/write access to an unbounded shared directory tree and reopen issue #1735.
- `-o <verdict-file>` / `--output-last-message <verdict-file>` — canonical verdict capture path; stdout/stderr are transport evidence, not the verdict artifact
- `--output-schema <schema-file>` — provide the JSON schema that the final reviewer message must satisfy

**已知 cooperative 殘餘（審查者可能仍執行指令）**：上面那段 preamble 只是 prompt 約束，sandbox 仍是 `workspace-write` 加 network，所以審查者技術上跑得動 `command -v`、`python3 -c` 這類探針（2026-10-24 dispatch-43135dab 實測跑過 6 個指令）。runner 目前不會把「審查者執行了指令」變成事件或 advisory，終態仍是 `reviewer_completion_critical`，只有讀 reviewer stdout 原文才看得到。

因此 TL 收到 reviewer 結果時 **MUST** 掃一次 stdout／stderr 的執行痕跡（`$ `／`exec`／command 原文）：

- 不要直接把結論當成已完成驗證；若結論引用執行結果，TL **MUST** 自己重跑同一探針，或改以純讀 diff 的證據支撐。
- 在 sticky／回報註明「審查者曾執行指令」，避免下一位讀的人誤以為那條保證來自 gate。

要真正把這條變成機械偵測（runner 在 activity log 留一筆 advisory），是另一個 change；在那之前，本段就是這道缺口的唯一載體。

Neutral cwd and target worktree are different concepts: neutral cwd prevents target-repo `AGENTS.md` auto-load for prompt-contained review; the target worktree / repo context still must be supplied through the review packet, prompt, diff, refs, or explicit reference files as appropriate. Do not replace the neutral cwd with `-C <abs-worktree>` for this prompt-contained reviewer mode just to give context; that reintroduces target project-doc auto-load.

In-prompt-only preamble：reviewer 不跑 shell、全部在 prompt 內完成 review（DO NOT run any shell commands, tests, or builds; review entirely within the prompt context）。理由：reviewer 是純讀-diff 的第二意見，不需要也不應跑 shell/test/build——這道 preamble 是防 reviewer 主動執行命令的主防線；pr-sticky mode 需要 `-s workspace-write -c sandbox_workspace_write.network_access=true` 才能寫 sticky（`gh pr comment`），故此邊界不再靠 `-s read-only` 承擔。（AGENTS.md auto-load 由 `-C` neutral cwd 防，非本 preamble。）

```bash
# neutral-cwd launch contract:
# - neutral cwd (-C system-temp): PRIMARY protection — prevents auto-load of target repo AGENTS.md (codex reads project docs from its cwd tree)
# - --ignore-rules: do not load execpolicy .rules files (command-approval; defense-in-depth, NOT the AGENTS.md control)
# - --skip-git-repo-check: neutral dir is not a git repo
# - -s workspace-write -c sandbox_workspace_write.network_access=true: pr-sticky reviewer needs network+host auth to write sticky (read-only would block gh pr comment), while keeping filesystem isolation (not danger-full-access); in-prompt-only preamble bounds reviewer from running shell/writes
# - no --add-dir: sticky body-file write now stays inside the -C neutral cwd (write_path mandates that same directory); regression fence — do not re-add a repo-internal grant
# - -o/--output-last-message <verdict-file>: canonical verdict capture
# - --output-schema <schema-file>: deterministic schema-valid final response
# - </dev/null: close stdin to prevent hang (codex exec reads additional stdin by default)
DEVPRO_CROSS_MODEL_REVIEWER=1 codex exec --json \
  -c model_reasoning_effort="xhigh" \
  -C /tmp \
  --ignore-rules \
  --skip-git-repo-check \
  -s workspace-write \
  -c sandbox_workspace_write.network_access=true \
  --output-last-message /tmp/codex-review-verdict.json \
  --output-schema /tmp/codex-review-output-schema.json \
  "<prompt>" </dev/null 2>&1
```

Verdict capture rule: the canonical parsed verdict comes from `-o <verdict-file>` / `--output-last-message <verdict-file>` after the process exits successfully; when `--output-schema <schema-file>` is used, that final message MUST validate against the schema. Stdout redirection (`> verdict.json`, `2>&1`, tee, or parsing the terminal transcript) is **not reliable verdict capture** because `--json` / terminal output may contain progress, transport events, stderr interleaving, or hook noise. Keep stdout/stderr as bounded evidence only.

Prompt must request JSON-only six-axis + security review. Do not use `--full-auto` / yolo / auto-edit modes for read-first review. If reviewer subprocess loads repo Stop hooks, pass `DEVPRO_CROSS_MODEL_REVIEWER=1`; do not put that env on TL host session, merge, or sticky verification.

Canonical packet discipline：initial dispatch、focused sticky-refresh、and fault recovery MUST instantiate the `devpro:second-review` Canonical Reviewer Packet Template from structured handoff JSON with `.devpro/scripts/render-second-review-packet.mjs` (or adapter-equivalent deterministic renderer) before `codex exec`; new nonpaged `pr-sticky` uses only `devpro-second-review-data/v4`, renderer-paged page-window `pr-sticky` uses exclusively `devpro-second-review-data/v5`, while `audit-only` retains exact canonical `devpro-second-review-data/v3`。TL supplies bounded handoff/optional `retry_context`, never alternate prompt text. Validate the rendered packet with `.devpro/scripts/validate-second-review-packet.mjs` or adapter-equivalent section checks before launch. When `codex exec` is owned by a `dp-second-reviewer` projection/executor wrapper, TL MUST render+validate before spawning the projection, read renderer-generated `observability_context`, and pass exact `packet_path`, `observability_context_path`, `heartbeat_path`, `activity_log_path`, `stdout_log_path`, `stderr_log_path`, `cli_probe_result_path`, cwd-independent absolute `projection_bootstrap_command` (every host), and `projection_runner_command` (cwd-independent absolute on every host except the Claude Code host, which uses a repo-root-relative typed carrier), and `tl_pre_dispatch_contract: tl-must-render-before-runtime-native-projection-spawn` in the handoff; the sidecar MUST include `required_spawn_payload_fields`, `projection_bootstrap_script`, `projection_bootstrap_command`, `projection_runner_script`, `projection_runner_command`, `reviewer_cli_recipe`, `reviewer_cli_recipe.required_invocation_args`, `required_activity_events` / `duration_conditional_activity_events`, `reviewer_surface: host-non-sandbox-required`, `runner_owner: adapter-host-runner`, and `sandbox_policy: auth-required-reviewer-cli-must-not-run-in-sandbox`。The projection first executable action MUST run the exact sidecar `projection_runner_command`, which owns bootstrap, probe, reviewer CLI stream capture, heartbeat, and mode-specific exact terminal ordering（`audit-only`: `projection_cli_exited` then `projection_sticky_verification_skipped`; `pr-sticky`: sticky verification events then `projection_cli_exited`）. After `flags_supported`, wrapper MUST use `reviewer_cli_recipe.required_invocation_args` exactly and MUST NOT reconstruct argv; Codex-host Claude stream-json args include `--verbose`. Missing sidecar or handoff path is `projection_observability_contract_missing` before reviewer CLI, not a wait to either checkpoint or cap.

Focused-range CLI contract：v4 `review_scope` is typed `full-pr` / `commit-range` with strict lowercase 40-hex SHA. Finite matrix accepts either scope with `scope-bound-embedded-complete-diff-v1` + `embedded-complete-diff-v1`；full PR live with `full-pr-bounded-live-reads-v1` + `gh-pr-bounded-live-v1`；commit range live with `commit-range-exact-compare-v1` + `gh-api-exact-compare-v1`。Embedded proof binds/reconciles exact diff bytes、digest、scope、paths；live material is exact empty。Generic `gh pr view` / `gh pr diff` and broad `Bash(gh api:*)` do not prove range capability；the sole route is exact quoted `gh api 'repos/{owner}/{repo}/compare/<base>...<head>'` with typed base/head only. The wrapper MUST pre-spawn probe exact identities、declared-base merge-base、bounded non-truncated counts、and paths；failure is `review_material_scope_unresolvable` in `spawn_or_probe_failure` with zero reviewer/completion/sticky. Recovery changing scope、carrier、route、or material MUST allocate a fresh dispatch and regenerate/revalidate packet、proof、recipe、probe；typed `permission_denials` fatal precedence remains unchanged.

### Focused sticky refresh

Claude-host -> Codex CLI focused sticky-refresh: stale `verdict: PASS|WARN` + narrow follow-up / finding disposition / test-only / gate-evidence commit → packet contains previous sticky/verdict/findings, latest delta/range, current head SHA, current gate/test evidence. Codex evaluates only delta and patches through the active adapter writer contract. Insufficient focused packet, changed risk shape, missing/malformed/`CRITICAL`/`UNAVAILABLE` prior sticky → broad exploration. Same-shape broad rerun timeout/error is orchestration friction, not reviewer unavailable.

## Exit Criteria

- First real `codex exec` reviewer invocation ran on host/outside surface
- stdin was closed with `</dev/null`
- timeout and stdout/stderr evidence were captured
- projection-owned `codex exec` received TL pre-rendered `packet_path` / `observability_context_path` / heartbeat/activity/stdout/stderr paths and exposed wrapper-owned activity/stdout/stderr or heartbeat artifacts, or documented `projection_observability_contract_missing` before fallback
- reviewer mode stayed read-first; no `--full-auto`

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「`command -v codex` 成功所以可在 sandbox review」 | binary probe is not auth/session evidence |
| 「沒有 OPENAI_API_KEY 就 unavailable」 | Codex OAuth may satisfy auth |
| 「沉默就是 hang」 | use total cap/health probe; no stdout alone is insufficient |
| 「projection runtime 看不到 codex stdout，所以等滿 30m」 | no；projection-owned `codex exec` needs wrapper-owned activity/stdout/stderr or heartbeat artifacts. Runtime callback controls completion；wrapper independently samples reviewer stream every `60s`，records a `15m` checkpoint，and enforces `30m` hard cap. Missing artifacts are `projection_observability_contract_missing`, not a silent wait. |

## Verification

```bash
node --test .devpro/scripts/tests/cross-review-cli-skills-grep.test.mjs
```
