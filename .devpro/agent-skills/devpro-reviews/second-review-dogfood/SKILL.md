---
name: second-review-dogfood
description: "Second-reviewer projection observability dogfood recipe。使用時機：修改 dp-second-reviewer projection、render-second-review-packet、run-second-reviewer-projection、CLI probe、heartbeat/stdout/stderr sidecar、sticky freshness verification，或需要證明 TL 能判斷 reviewer CLI 是否仍在運作時。"
---

# Second Reviewer Dogfood

## Purpose

Use this recipe to prove a second-reviewer observability change works as executable behavior, not only as docs or tests. It validates the renderer-owned sidecar, canonical runner, CLI probe, stdout/stderr capture, heartbeat, activity events, and sticky freshness classification.

This skill does not define reviewer semantics. Load `.devpro/agent-skills/devpro-reviews/second-review/SKILL.md` and the active host adapter for the authoritative review workflow.

## Inputs

- Target PR, local diff, or bounded artifact.
- Current head SHA when the target is a PR or PR-like branch.
- Mode: use `audit-only` for runner/log dogfood unless the task explicitly requires PR sticky write-back evidence.
- Primary validation/test evidence already produced by the owner. Cross-model review dogfood must not run broad project tests.

## Recipe

1. Render from structured handoff input with `.devpro/scripts/render-second-review-packet.mjs <handoff-json> --carrier-root <main-checkout-root>/notes/cross-review`. The renderer, not the caller, allocates a fresh `<attempt_id>/` carrier directory under that root and returns `<packet-file>` under it; anything inside the reviewer's own current neutral cwd reviewer-writable root fails closed as `reviewer_writable_root_carrier_collision` (a reviewer that re-reads its own packet there overflows the runner complete-line bound).
2. Validate the packet with `.devpro/scripts/validate-second-review-packet.mjs <packet-file>`.
3. Read the renderer-generated `observability-context.json`. Do not invent or hand-author `heartbeat_path`, `activity_log_path`, `stdout_log_path`, `stderr_log_path`, `cli_probe_result_path`, `projection_bootstrap_command`, or `projection_runner_command`.
   - `pr-sticky` MUST carry versioned `sticky_write_disposition` derived from a complete bounded issue-comments snapshot：0 marker candidates=`create`；1=`update` with exact comment id/URL/node id（when supplied）/body digest/`updated_at`；more than 1 or invalid/incomplete/query-failed evidence=`blocked` without target。Its binding includes repo/PR/dispatch/snapshot，and `audit-only` explicitly records N/A。
   - Exercise the same 0/1/multiple-candidate matrix for initial、focused sticky-refresh、and fault-recovery renders；`previous_sticky` is inert review context and MUST NOT affect the action or target。
4. Execute or dispatch the exact `projection_runner_command` from the sidecar as the first projection action. Do not manually run bootstrap, probe, or reviewer CLI out of sequence.
   Before claim、probe、or spawn，confirm the runner revalidates disposition binding and snapshot freshness；missing、tampered、stale、or blocked state records `process_spawned=false` and requires a new dispatch/rerender。
5. Register the runtime completion callback/event and wait for that notification when the runtime exposes one. A callback-capable runtime MUST NOT use periodic polling or list-agents busy wait. Only when the runtime explicitly exposes no callback/event and active monitoring is required may TL poll the following artifacts every `60s`, with at most 30 attempts and a `30m` hard cap:
   - `heartbeat.json`
   - `projection-activity.ndjson`
   - `reviewer-stdout.ndjson`
   - `reviewer-stderr.log`
   - `cli-probe-result.json`
   - `reviewer-completion-evidence.json` (only when the runner had to preserve already-arrived completion-stream fragments; it is attempt-local, carries the literal `completion_authority: "none"`, and MUST NOT be read as a completion or verdict source)
6. Independently confirm the wrapper samples reviewer stream liveness every `60s` and activity ordering includes `projection_handoff_validated`, `projection_cli_probe_started`, `projection_cli_probe_result`, `projection_cli_starting`, `projection_cli_started`, `projection_cli_liveness_sampled`, a non-terminal `projection_cli_status_checkpoint` at `15m`, and `projection_cli_exited`, or an explicit pre-CLI blocker. A round whose completion parse produced no completion object (`missing` / `not-successful` / `malformed` / `reason-missing`; `stale` excluded) additionally carries exactly one `projection_completion_stream_evidence` containing the bounded end-shape diagnostics. The `15m` checkpoint automatically continues without kill or user-authorization wait；at the `30m` total hard cap the wrapper final-verifies/classifies and terminates. Callback/process close is the terminal signal.
7. Confirm help-like probes (`--help`, `-help`, `-h`, `help`) capture beyond `8192` bytes when the host CLI emits more data. Exact `8192` bytes plus missing required flags is `probe_capture_suspect`, not proof that the CLI lacks the flag.
8. Confirm auth/session failures are terminal artifacts such as `claude_reviewer_authentication_failed`, not silent waits.
9. In `pr-sticky` mode, verify current-head/current-dispatch freshness and exact target continuity after CLI exit：`update` must retain the disposition comment id/URL；`create` must return a new identity that is the sole authority。Stale/drifted comments are not accepted sticky write attempts。Confirm the reviewer did not search candidates、infer from cwd/git remote/framed data、use `previous_sticky` as authority、or switch action/path after failure。
10. For Claude, confirm the stream-json `system/init.tools` set is exact for the selected mode: exactly `StructuredOutput` for `audit-only`, or exactly `Bash`, `StructuredOutput`, and `Write` for `pr-sticky`. Missing, malformed, duplicate, or extra tools fail closed; argv/help evidence alone is insufficient.

11. For OpenCode, verify the render-owned catalog selection and effort evidence, then the exact `--model provider/model#variant` in the recipe and `requested_variant` / `observed_variant` in `projection_opencode_session_verified`. Inventory success or argv alone is not execution proof. Exercise unknown/ambiguous capability, missing effort and changed exported variant; all must refuse without silent downgrade. For DeepSeek, assert the recipe's fixed native `max` and refuse a missing or downgraded variant. Preserve failed probes as failed evidence; they do not count as a completed review.

## Acceptance

Dogfood passes when TL can answer these from `observability-context.json` and sibling artifacts alone:

- Where is the reviewer CLI stdout log?
- Where is stderr?
- Where is heartbeat?
- Did probe finish, and what flags were observed?
- Did reviewer CLI start?
- Did reviewer CLI exit, timeout, or block before start?
- If the round ended without a usable completion object, can the runner's named classification and bounded end-shape diagnostics (and, when present, the non-authoritative arrived-evidence carrier) be answered without mining the raw stdout transcript?
- What exact sticky action and, for `update`, target identity did the trusted disposition authorize?
- Was snapshot freshness revalidated before claim/probe/spawn, with blocked/drifted state preventing process spawn?
- Did Claude expose exactly the mode-selected init tool set?
- If sticky write-back is required, does the sticky match current head/dispatch and preserve exact target continuity?

Dogfood fails closed when any answer requires guessing, transcript mining, or waiting for the `30m` hard cap without fresh heartbeat/activity/stdout/stderr evidence.

## Verification Commands

```bash
node --test .devpro/scripts/tests/probe-second-reviewer-cli-recipe.test.mjs \
  .devpro/scripts/tests/render-second-review-packet.test.mjs \
  .devpro/scripts/tests/ack-second-reviewer-projection.test.mjs \
  .devpro/scripts/tests/validate-second-review-packet.test.mjs \
  .devpro/scripts/tests/run-second-reviewer-projection.test.mjs \
  .devpro/scripts/tests/second-review-sticky-authority.test.mjs \
  .devpro/scripts/tests/second-reviewer-projection-contract.test.mjs \
  .devpro/scripts/tests/cross-review-cli-skills-grep.test.mjs

node .devpro/scripts/lint-agent-skills.mjs
```
