# devpro:second-review — Claude Code host projection route

由 `SKILL.md` §Projection Routes 載入：當前 host 是 Claude Code 時讀，其他 host 不讀。本檔內「本 skill」指 `devpro:second-review`（`SKILL.md`）。

### Claude Code Host

Claude Code host 可使用 `.claude/agents/dp-second-reviewer.md` 作 thin projection。deterministic route chain：

1. `.devpro/agent-skills/devpro-reviews/second-review/SKILL.md`
2. `platform-adapters/claude-code.md`
3. `platform-adapters/claude-code-cross-review.md`
4. `.devpro/agent-skills-refs/autonomous-ai-agents/codex/SKILL.md`
5. `platform-adapters/codex-cli-tooling.md`
6. Codex CLI reviewer path (`codex exec --json`, render-time probe-selected highest-capability available model, cross-review recipe-policy reasoning tier `xhigh`)

Claude primary host default reviewer 是 Codex/OpenAI-family reviewer。若 active primary family 不是 `claude`，不得直接沿用 Claude projection 的 default route；先回到本 skill 的 `primary_family` selection。

Projection observability: if the unmarked outer wrapper invokes `codex exec` or another reviewer CLI internally, it MUST use the renderer-generated `<packet-dir>/observability-context.json` sidecar, expose those TL-readable artifacts before or at dispatch, and update them while the CLI is active. The sidecar requires `reviewer_surface: host-non-sandbox-required`；without a host/non-sandbox runner, return `projection_runner_unavailable` before dispatch. `projection_log_unavailable_by_runtime_api` describes runtime API visibility only and is not a waiver for renderer-generated wrapper-owned artifact paths.

The wrapper first executable action executes exact `projection_runner_command`；the marked terminal reviewer receives packet stdin, never the sidecar. The runner is the sole caller of `projection_bootstrap_command` / acknowledgement；TL and projection instructions MUST NOT execute bootstrap or acknowledgement manually before the runner. After acknowledgement and dispatch identity-collision validation, the runner first sanitizes its own dispatch env（bounded cmux PATH entries removed; NODE_OPTIONS cleared on cmux evidence）then inspects only the reviewer tool's first executable PATH hit before sticky/scope/help/auth/reviewer work；missing、realpath failure、or a bounded identifiable cmux path shape（including a `cmux-cli-shims` segment or cmux wrapper/app-resource identity）returns exact `tool_discovery_blocked` with a `spawn_or_probe_failure` pre-spawn terminal receipt、no invocation claim、no later PATH search、and no raw resolved path in persistent evidence. Arbitrary scripts or ambient environment markers alone are not cmux proof. On Win32 it uses native path/delimiter and PATHEXT order, ignores extensionless files and malformed non-pure extension tokens, trusts only `.COM`/`.EXE` directly, and exact-blocks the first existing `.BAT`/`.CMD`/other shell-dependent candidate without fallback or `shell: true`. A trusted direct hit binds one absolute realpath to help、auth、and reviewer spawns while preserving renderer-owned canonical argv and logical tool identity；path-bearing probe failures restore logical identity and expose only stable generic/code evidence. Runner preserves sidecar event order and emits exactly one `projection_handoff_validated` on success；at hard cap verification precedes timeout/termination。Post-PR exact current-head marker-matching `PASS`保留consumer gate success且later `cli_exit.timed_out`仍可觀測、不要求receipts；`WARN`須無current fault與完整receipt chain。Actual merge hook Path F驗exactly-one canonical current-head `PASS|WARN`，並拒絕known operator-disposed dispatch；正常PASS不新增local receipt要求。Extra/missing/reordered entries fail closed；stale sticky不算 write attempt。

TL waits the runtime completion callback/event and MUST NOT use periodic polling or list-agents busy wait when callback-capable. Only when no callback/event exists and active monitoring is required may TL use bounded `60s` artifact/sticky polls，at most 30 attempts and total hard cap `30m`. The no-callback first 60s observation window MUST see terminal status、fresh sticky、or post-handoff heartbeat/activity；otherwise classify `projection_activity_stale` without waiting `30m`.
