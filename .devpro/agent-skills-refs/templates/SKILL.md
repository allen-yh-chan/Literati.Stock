---
name: your-skill-name
description: >
  Routing metadata only: say what this skill covers and when to use it.
  Use when the user asks about a concrete task, workflow, tool, or domain
  that this skill covers. Do not encode process steps here; put workflow
  in the body.
license: MIT
# compatibility: Codex, Claude Code, Cursor
# user-invocable: true
# disable-model-invocation: false
# metadata:
#   owner: devpro
---

# Your Skill Title

## Purpose

State the narrow problem this skill solves. Keep general programming advice out; include only knowledge the base agent is likely to miss or repeat incorrectly.

## Workflow

1. Identify the trigger and required context.
2. Follow the smallest reliable workflow.
3. Verify with the command, file, or artifact named by this skill.

## Progressive Disclosure

- Put long examples and checklists in `references/`.
- Put helper commands in `scripts/` and reference them by relative path.
- Put reusable schemas or static templates in `assets/`.
- Load supporting files only when the current task needs them.

## Verification

```bash
node .devpro/scripts/lint-agent-skills.mjs
```
