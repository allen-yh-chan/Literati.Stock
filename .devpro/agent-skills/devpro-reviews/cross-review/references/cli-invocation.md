# Cross-Review CLI Invocation Reference (cold reference)

Concrete CLI flags are owned by the host adapters; this file is a fast lookup index, not a replacement. Always confirm against the adapter file before invoking — CLI flags drift as vendor CLIs update.

## Cursor host → render + projection

SSOT for Claude-family **TL renderer Shell**：`platform-adapters/cursor.md`（render 與 Task 派 projection 同 host surface）。本檔不複寫 Cursor Shell 等待數字。

## Codex host → Claude CLI second reviewer

SSOT: `platform-adapters/codex-host-cross-review.md`.

```bash
# Host/non-sandbox runner only. Packet is file-backed/stdin; do not inline the long packet.
# Canonical carrier root — MUST be outside the reviewer's own current neutral cwd reviewer-writable root;
# the renderer fails closed with reviewer_writable_root_carrier_collision otherwise (issue #1735).
# TL passes the root only; the renderer allocates a fresh attempt_id directory under it and
# prints the resulting absolute packet path to stdout on success — TL does not name the directory.
CARRIER_ROOT="<main-checkout-root>/notes/cross-review"
PACKET_FILE=$(node .devpro/scripts/render-second-review-packet.mjs "$HANDOFF_JSON" --carrier-root "$CARRIER_ROOT") &&
node .devpro/scripts/validate-second-review-packet.mjs "$PACKET_FILE" &&
node .devpro/scripts/probe-second-reviewer-cli-recipe.mjs "$(dirname "$PACKET_FILE")/observability-context.json" &&
# The fixed system prompt is read from the constant the runner itself uses; it is not copied
# here because copies drift. Run from the repository root.
CLAUDE_REVIEWER_SYSTEM_PROMPT=$(node --input-type=module -e 'import { CLAUDE_REVIEWER_SYSTEM_PROMPT } from "./.devpro/scripts/second-reviewer-cli-recipe-contract.mjs"; process.stdout.write(CLAUDE_REVIEWER_SYSTEM_PROMPT)') &&
DEVPRO_CROSS_MODEL_REVIEWER=1 claude -p \
  --safe-mode \
  --system-prompt "$CLAUDE_REVIEWER_SYSTEM_PROMPT" \
  --model <resolved> \
  --effort xhigh \
  --verbose \
  --output-format stream-json \
  --include-partial-messages \
  --include-hook-events \
  --tools Write,Bash \
  --allowedTools "Write,Bash(command -v gh),Bash(gh pr view:*),Bash(gh pr diff:*),Bash(node <repo>/.devpro/scripts/read-second-review-sticky-comment.mjs:*),Bash(node <repo>/.devpro/scripts/write-second-review-sticky-gated.mjs:*)" \
  < "$PACKET_FILE"
```

Key constraints (full rationale in the adapter):

- Both Claude modes use this renderer-owned fixed `--system-prompt` exactly once. It replaces exploratory default bootstrap, forbids cwd/environment/git/host discovery, and does not summarize or compress packet semantics.
- For Claude Code 2.1.207, host functional probe evidence shows `--bare` breaks logged-in `claude -p` auth/session; do not include it in the canonical recipe unless the exact host/non-sandbox probe proves active auth/session is preserved.
- `--tools Write,Bash` selects the `pr-sticky` tool surface；`--allowedTools` further narrows that positive permission profile. Claude Code 2.1.207 canonical packet recipe does not use `--bare` / `--permission-mode`.
- In `pr-sticky`, Claude uses `Write` only for the fixed neutral-cwd `cross-model-second-opinion.md`, then executes only the packet's renderer-selected、disposition-bound、fully concrete、single-quoted endpoint `sticky_write_exact_recipe` unchanged. It must not derive、substitute、reconstruct、or choose the target/action/path/endpoint/repository/PR/comment identity/arguments；direct PR comment permission is absent.
- `Bash(command -v gh)` authorizes only the exact availability probe. Do not append arguments, operators, pipes, redirects, substitutions, or another command.
- Add `Bash(node <absolute-linked-issue-reader> <validated-repository-slug>:*)` to `--allowedTools` exactly when `linked_issue_context` is `issue_read_required`. Route SSOT: `openspec/specs/cross-runtime-parity/spec.md` → `Requirement: External Reviewer Linked Issue Route`; this file MUST NOT restate the route How.
- Never authorize `Task` (subagent delegation), repo file write, `git add/commit/push`, or `gh pr merge`.
- MUST pin `--model <resolved>` for the external Claude second-review recipe；effort is probe-backed highest-compatible `--effort xhigh`（禁 silent fixed effort=`high` / omit-model）。General Claude CLI ceiling remains `max`。`.codex/agents/dp-second-reviewer.toml` `model_reasoning_effort=xhigh` is wrapper Codex layer, NOT terminal `claude -p --effort`. `<resolved>` 為探測後釘選的 exact model，可經 `DEVPRO_SECOND_REVIEWER_MODEL_CLAUDE` 覆寫；政策 selector 集中宣告於 `second-reviewer-cli-recipe-contract.mjs` 的 `SECOND_REVIEWER_MODEL_DEFAULTS`；實際 exact model 與探測證據以 renderer 的 `reviewer_model_selection` 為準。

## Claude Code host → Codex CLI second reviewer

SSOT: `platform-adapters/claude-code-cross-review.md` for the Claude-host dispatch shape. When Codex is instead the *reviewer* CLI, it uses `-c model_reasoning_effort="xhigh"` (the cross-review recipe policy tier; the `gpt-6` catalog additionally offers `max`/`ultra`, which this recipe does not adopt, and `high`/`max` remain fail-closed), followed by an explicit `-c model="<resolved>"` — see `platform-adapters/codex-host-cross-review.md` §Reasoning Depth Control and `platform-adapters/codex-effort-tiers.md` for the canonical tier table. `<resolved>` 是集中定義的探測政策解析結果，可經 `DEVPRO_SECOND_REVIEWER_MODEL_CODEX` 覆寫；政策 selector 集中宣告於 `second-reviewer-cli-recipe-contract.mjs` 的 `SECOND_REVIEWER_MODEL_DEFAULTS`；實際 exact model 以 renderer 的 `reviewer_model_selection` 為準。

## External evaluator (no runner CLI recipe)

When neither runner CLI is reachable/authorized, or `reviewer_family` has no runner recipe (e.g. `gemini`), dispatch the ticket-based path instead of a CLI invocation above: `render-second-review-packet.mjs` with `executor_kind: "external-evaluator"`, then `accept-external-second-review.mjs <packet-dir>` (or `--void-external-dispatch <packet-dir>` to void). SSOT: `second-review-external-evaluator.md`（審查單＋收據）。

## Sticky schema (both directions — canonical, do not paraphrase)

```
<!-- cross-model-second-opinion:sticky -->
verdict: PASS | WARN | CRITICAL | UNAVAILABLE
last_reviewed_sha: <headRefOid>
dispatch_id: <current v3 dispatch_id>
reason: <trimmed non-empty verdict-specific reason>
Rules: v<exact AGENTS.md version> · Tool: <token per STICKY_PROVENANCE_TOOL_TOKENS, second-review-sticky-authority.mjs> · Model: <actual reviewer model>
```

Bare lines only — regex the merge gate parses against:

- `^verdict:\s+(PASS|WARN|CRITICAL|UNAVAILABLE)\s*$`
- `^last_reviewed_sha:\s+([a-f0-9]{7,40})\s*$`
- `^dispatch_id:\s+([^\s]+)\s*$`

The renderer emits the exact `AGENTS.md` Rules-version literal; packet schema `v3` is not a Rules version. The runner rejects a non-final, missing, malformed, version/tool-mismatched, or placeholder-model provenance footer.

Markdown emphasis, code spans, bullets, or headings wrapping those lines are parse failures.

## Verification

```bash
rg -n '(claude -p|--effort xhigh\|max|--model <resolved>|stream-json|canonical recipe)' .devpro/agent-rules/platform-adapters/codex-host-cross-review.md
rg -n 'model_reasoning_effort="xhigh"' .devpro/agent-rules/platform-adapters/codex-host-cross-review.md
rg -n 'model_reasoning_effort=xhigh.*NOT terminal|≠ terminal `claude -p --effort`' .devpro/agent-rules/platform-adapters/codex-host-cross-review.md .codex/agents/dp-second-reviewer.toml
```
