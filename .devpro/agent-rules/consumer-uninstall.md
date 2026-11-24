---
name: consumer-uninstall
description: 從 consumer repo 移除 devpro-agent-rules：sync-agent-rules.mjs --uninstall 三層指令、移除範圍、不可逆項目與不處理的範圍。觸發：使用者要求解除安裝／移除 devpro-agent-rules。
---

# Consumer Uninstall

> Load-chain：本檔由 `consumer-adoption.md` §Uninstall 與 consumer-doctor skill 按需載入；一般導入健康檢查（matrix／doctor／smoke）不需讀本檔。

Clean removal of devpro-agent-rules from a consumer repo. Three layers, all via `sync-agent-rules.mjs`:

```bash
node .devpro/scripts/sync-agent-rules.mjs --uninstall --dry-run   # preview only, zero side effects
node .devpro/scripts/sync-agent-rules.mjs --uninstall             # remove + stage deletions (TTY confirm)
node .devpro/scripts/sync-agent-rules.mjs --uninstall --git-flow  # remove, commit, push, open PR
```

`--dry-run` lists everything that would be removed and prints the irreversible warning without touching anything. Plain `--uninstall` requires confirmation (interactive `[y/N]`, or `--yes` for non-interactive); it deletes source-owned files, reverses merge-injected content, undoes non-file side effects, and stages the deletions (`git rm --cached`). `--git-flow` additionally checks out `chore/remove-devpro-agent-rules` (refuses on a protected/mainline branch), commits, pushes (needs `--yes` or interactive confirmation — never a silent push), and opens a PR; merge is left for a human — the tool never merges.

Removal scope: whole source-owned files (`AGENTS.md`, the per-runtime redirect entry files, `.windsurfrules`, `.claude/statusline.cjs`); source-tree-brought files under `.devpro/`, `.claude/commands|agents`, `.codex/`, `.cursor/`, `.github/` (per-file — consumer-only extras are preserved by omission, never `rm -rf`); merge-injected content (`.gitignore` managed block, `.claude/settings.json` + `.codex/.cursor/hooks.json` source hook event keys); and non-file side effects (`core.hooksPath` unset only when it points at our hooks-git dir, `.devpro-agent-rules` submodule deregister, the `.agents/skills/devpro` and `.claude/skills/devpro` discovery entries; legacy per-skill discovery symlinks under `.agents/skills/<name>`, `.claude/skills/<name>`, and the retired `.cursor/skills/<name>` root are still swept when they resolve into the consumer's `.devpro/agent-skills/`).

Three things are IRREVERSIBLE (no undo): (1) `settings.json`/`hooks.json` event keys matching source keys are deleted outright — any manual edits to those keys are lost; (2) `core.hooksPath` is cleared, not restored to a prior value; (3) directory-extras boundary is best-effort — only files with a source-tree counterpart are removed, so verify with `git status` before committing.

Out of scope (never touched): global files — `~/.zshrc`, `~/.bashrc`, `~/.codex/config.toml`；root `AGENTS.local.md`（consumer overlay；不在 A-class，`--uninstall` **不**刪，consumer 自決保留或手動移除）。Remove global files manually if desired.
