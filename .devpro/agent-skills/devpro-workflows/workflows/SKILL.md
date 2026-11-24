---
name: workflows
description: "Devpro /dp workflow parity for Codex（Codex 版 Devpro 指令平行對應）。使用時機：使用者呼叫或要求 /devpro:init、/devpro:setup-ci、/devpro:security-scan、/devpro:change、/devpro:clarify、/devpro:pre-pr、/devpro:cross-review、/devpro:sync-rules、/devpro:load-plan、/devpro:project-verify、/devpro:project-docs，或要求 Codex 在本 repo 執行對應的 Devpro 指令 workflow 時。"
metadata:
  user-invocable: true
  argument-hint: "/devpro:<command> [args]"
---

# Devpro DP Workflows

## Overview

Use this skill as the **meta index** for Devpro `/dp:*` workflows. Each `/dp:*` workflow now has its own cross-platform single-function skill (discoverable as `devpro:<name>` through the `.agents/skills/devpro` and `.claude/skills/devpro` entries) that carries the full operational recipe. This carrier does **not** duplicate those recipes — it maps a requested command to the matching single-function skill and preserves the Codex adapter constraints for git, GitHub, worktrees, hooks, and approvals. Load the mapped skill and run it.

Do not treat this skill as a gate bypass. Load `AGENTS.md`, then `platform-adapter-contract.md`, then `platform-adapters/codex.md` before repo writes, git/GitHub writes, tests, PR work, or command execution.

## Invocation Forms

- Explicit: `Use $devpro:workflows to run /devpro:change <request>`.
- Natural-language parity: if the user asks for the Devpro equivalent of a command below, load and run the matching single-function skill.
- Slash-input caveat: this skill is not native Codex slash-command registration. `$devpro:workflows` and natural-language workflow requests are supported; direct `/dp:*` input may be intercepted by Codex UI as an unrecognized command and may not reach the model.

## Command Routing

Each row maps a requested command to the single-function workflow skill that owns its recipe. Load that skill's `SKILL.md` and run it; the policy/gate SSOT it points to (rule leaves) stays authoritative.

| Requested command | Load and run skill |
|---|---|
| `/devpro:init` | `devpro:init` |
| `/devpro:setup-ci [component]` | `devpro:setup-ci` (umbrella; `codeql` / `integration` / discover-mode details in its `references/`) |
| `/devpro:security-scan` | `devpro:security-scan` |
| `/devpro:change [name or request]` | `devpro:change` |
| `/devpro:clarify [explore\|pre-analyst]` | `devpro:clarify` |
| `/devpro:project-verify setup\|run\|maintain` | `devpro:project-verify` |
| `/devpro:project-docs build\|drift <repo-or-module>` | `devpro:project-docs` |
| `/devpro:pre-pr` | `devpro:pre-pr` |
| `/devpro:cross-review <PR#>` | `devpro:cross-review` |
| `/devpro:sync-rules` | `devpro:sync-rules` |
| `/devpro:load-plan` | `devpro:load-plan` |

## Codex Execution Rules

- Use Skills/Plugins as the shared Codex parity path. Do not create or depend on `~/.codex/prompts` for Devpro shared workflows.
- For `/devpro:change` requests sourced from `notes/session-pending.md`, run `node .devpro/scripts/session-pending-claim.mjs claim --item <N> --change <change-name>` before branch/worktree creation, per `session-pending-lifecycle.md`.
- Keep command execution shell-observable when hooks, GitHub footer gates, post-PR gates, or merge gates must see it.
- Before git writes in Codex worktrees, carry hook-visible cwd evidence with `git -C <abs-worktree> ...` only, and keep `git add` and `git commit` in separate Bash calls.
- If a command reaches a mandatory delegation threshold, follow `model-delegation.md` and `multi-agent-handoff.md`; lack of a Claude slash command is not a reason to skip delegation.
- For `/devpro:load-plan`, list this skill as the Codex command carrier and include its repo discovery path.

## Verification

After changing this skill or its discovery path, run:

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" .devpro/agent-skills/devpro-workflows/workflows
node .devpro/scripts/lint-agent-skills.mjs
node --test .devpro/scripts/tests/agent-skill-governance.test.mjs .devpro/scripts/tests/codex-dp-workflow-parity-grep.test.mjs
```
