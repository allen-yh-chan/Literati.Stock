---
name: model-delegation-active-lifecycle
description: 委派送出之後的 TL 行為：Active Delegation Interruption Gate（no-file 不等於 stall、observation contract、progress suppression、interruption allowlist、ownership transfer、TL-caused recovery、R3 checkpoint）與 Subagent Artifact Landing Verification。觸發：delegate 執行中想查狀態、懷疑 stall、要中斷／接手／重派，或收到 checkpoint／handoff／done claim 要驗收落盤時。
---

# Active Delegation Lifecycle

> Load-chain：本檔由 `model-delegation.md` 的 Load-chain（active delegation lifecycle）與 `model-delegation-briefing.md` 的 Load-chain（委派後）行按需載入；只是要查 dispatch 時的 briefing 模板、admission record 或回報格式時不需讀本檔。dispatch 時就要滿足的條件（Dispatch completeness、dp-architect immutable dispatch）留在 `model-delegation-briefing.md`。

### Active Delegation Interruption Gate

`[cooperative-only, weak enforcement]` — Current cross-runtime hooks cannot reliably observe TL-side interrupt decisions without unacceptable false positives. The grep/mutation guard protects operative wording, not runtime interruption behavior.

- **Active evidence**: Before a `checkpoint` / `handoff` / `done` claim, TL MUST NOT treat no landed files as stall or failure; Artifact Landing Verification MUST run only after one of those claims.
- **Ownership transfer**: Write ownership MAY occur only with explicit user replacement or valid interruption evidence, and only after the old owner is terminal or lawfully interrupted and confirmed inactive; otherwise MUST fail closed.
- **Read-only reviewer exception**: An independent reviewer must be explicitly no-write, MUST NOT claim overlapping artifact paths, MUST NOT patch them, and MUST NOT acquire write authority.
- **Observation contract**: TL MUST NOT invent a task deadline; a briefing-defined `first_artifact_deadline` is a delivery checkpoint, while a wait/poll timeout is observation cadence only. Neither alone proves stall. A valid stall observation window MUST be a task-stall or heartbeat boundary defined by the user, briefing, or runtime contract; a TL-selected poll MUST NOT qualify.
- **Progress suppression**: Any progress or ETA MUST reset stall suspicion; a missed delivery checkpoint permits at most one focused status/rebrief, and TL MUST NOT send repeated status requests before the stated next window or configured checkpoint.
- **Interruption allowlist**: TL MAY interrupt an active agent only for explicit user cancellation/replacement, detected safety or scope violation, terminal runtime/tool failure, or verified stall; verified stall MUST include one status request after any reported ETA/checkpoint, one valid observation window with no response and no runtime activity/heartbeat, and runtime evidence that the agent is not `running`; TL MUST record the actual interruption reason.
- **No-contract fail-closed**: If no observation-window contract exists, silence and no landed files MUST NOT establish verified stall; TL MUST continue waiting for explicit user direction, runtime evidence, or terminal failure.
- **TL-caused recovery**: A TL-caused interrupt MUST NOT classify the agent unavailable or justify fallback; TL MUST first resume or rebrief an available agent, or recover from a valid landed checkpoint.
- **R3 checkpoint**: For multi-artifact work, the delegate MUST land a resumable checkpoint at a natural boundary when it is internally valid, cross-carrier consistent, preserves complete requirement/scenario blocks and canonical/delta consistency, and passes applicable structural/strict validation; otherwise it MUST report progress and defer landing.

### Subagent Artifact Landing Verification

Subagent claimed file changes：TL MUST verify before acceptance：`git status --short`；new `test -f <path>`；update `git diff --name-only` 或 `git diff -- <path>`。

Missing path => `partial` / `failed`；fallback + rerun/rebrief/reconstruct。TL MUST NOT mark OpenSpec tasks/handoff/PR readiness/final completion from subagent prose only。
