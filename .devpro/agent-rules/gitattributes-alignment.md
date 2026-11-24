---
name: gitattributes-alignment
description: Devpro-managed consumer `.gitattributes` derive contract (LF baseline + source-derived whitespace exceptions); sync-rules owns the managed block, last-match-wins priority, and terminal-block placement.
---

# Gitattributes Alignment

## Overview

Consumer root `.gitattributes` managed begin／end content is produced at sync time by `sync-agent-rules.mjs` via a **derive contract**:

1. **LF baseline（explicit constant）**：seven `text eol=lf` paths kept as an explicit baseline in the sync script（hooks-git／`.gitignore`／`.gitattributes`／三 runtime JSON／`.opencode/plugins/devpro-hooks.js`）. Tests lock the constant to the same path rows in source `.gitattributes`.
2. **Whitespace exceptions（derive from source）**：path-scoped `whitespace=` tokens declared in the **source** repo root `.gitattributes` are derived into the managed block. Output is token-level only：`<path> whitespace=<value>` — other attribute kinds on the same source line（`text`／`eol=`／`diff=`／`merge=`／`binary`／`linguist-*`／`export-ignore`／`filter=`）are **not** copied.
3. **Bound filter／fail-closed**：`[attr]` macro lines are skipped；path `*`（or extension-only `*.ext`）carrying `whitespace=` fails closed（sync／derive MUST NOT silently omit or accept them）. Consumer-local-only rules outside the managed block are never pulled into it.

**Authority**：source repo root `.gitattributes` decides which path-scoped whitespace exceptions exist. This document describes the contract and shows an illustrative example — it is **not** a hand-maintained runtime SSOT table to copy-paste into sync.

## When to Use

- Updating Devpro-managed `.gitattributes` baseline entries
- Understanding how Devpro-managed `.gitattributes` entries are derived（LF baseline constant ∪ source `whitespace=`）
- Debugging consumer rules sync `.gitattributes` drift
- Explaining why a Devpro LF rule takes effect over a consumer's own conflicting `.gitattributes` line（incl. derived whitespace exceptions）
- Remediating release／pre-PR whitespace false reds on source-declared intentional trailing space

## Rules

- `sync-agent-rules.mjs --sync` MUST create or update this block in consumer root `.gitattributes`, creating the file when it does not exist. Illustrative shape（LF baseline + representative derived whitespace exceptions；actual whitespace rows follow source）：

  ```gitattributes
  # devpro-agent-rules gitattributes managed begin
  .devpro/scripts/hooks-git/* text eol=lf
  .gitignore text eol=lf
  .gitattributes text eol=lf
  .claude/settings.json text eol=lf
  .codex/hooks.json text eol=lf
  .cursor/hooks.json text eol=lf
  .opencode/plugins/devpro-hooks.js text eol=lf
  .devpro/agent-rules/anti-patterns-design.md whitespace=-trailing-space
  .devpro/scripts/tests/fixtures/d30-post-hoc-r11-reviewer-output.md whitespace=-trailing-space
  # devpro-agent-rules gitattributes managed end
  ```

- The sync script MUST preserve consumer-owned attribute rules outside the managed block in their original relative order, and MUST avoid duplicate Devpro-managed entries outside the managed block.
- `sync-agent-rules.mjs --check` MUST fail when the managed block is missing or differs from the **derived canonical** block, and instruct the user to rerun `--sync`.
- **MUST NOT** hand-edit synced `.devpro`（or other Devpro-managed synced）file bytes solely to clear trailing whitespace so the committed-diff whitespace gate passes when the trailing space is source-declared via `.gitattributes` exceptions. Remediation：rerun `sync-agent-rules.mjs --sync` so derived managed attributes apply，or report the missing source declaration upstream — do not strip intentional trailing spaces and fight `--check`.

## Last-Match-Wins Priority

Git resolves `.gitattributes` conflicts by **last matching pattern wins**, not first-match or most-specific-match. A consumer-owned rule for `.gitignore` or `.gitattributes` written *before* the managed block is silently overridden the moment sync appends the managed block, because the managed block's entries physically come after it in the file.

This is why the block placement below is load-bearing, not cosmetic: a consumer who wrote `.gitattributes text eol=crlf` earlier in the file keeps that behavior right up until the first sync — after which the Devpro `eol=lf` entry wins, because it now sits later in the file. Sync MUST NOT be read as "adding a suggestion beside" the consumer's rule; it is authoritative for the managed paths from that point on.

**First-sync notice**: the AI running `--sync` for a consumer repo that has pre-existing conflicting rules for these managed paths MUST tell the user that the Devpro managed block now takes priority for them post-sync, rather than letting the silent last-match-wins semantics surprise the consumer later.

## Canonical Terminal Block

The managed block MUST be the final non-blank content of consumer root `.gitattributes`. This is a direct consequence of last-match-wins: if consumer content were appended after the block, that later content — not the managed block — would win for any overlapping path, silently defeating the LF／whitespace protection this file exists to guarantee.

## Exit Criteria

- Managed entries exist only inside the managed begin／end block（LF baseline ∪ derived whitespace）.
- Consumer sync creates/updates the managed block without overwriting unrelated local entries, and creates `.gitattributes` when absent.
- Consumer check fails on missing or drifted managed block and instructs rerunning `--sync`.
- The managed block remains the terminal content of consumer root `.gitattributes`.

## Consumer-owned suggestion (outside managed block)

Husky（或同等 consumer shell hook）在 mac／Linux POSIX 上需要 **LF** 行尾。Consumer 可自行在 managed begin／end **之外**加入：

```gitattributes
.husky/* text eol=lf
```

**MUST NOT** 把 `.husky/*`（或等價 husky user-hook 路徑）寫進上方 managed 清單／managed begin–end 區塊——那是 consumer ownership seam；sync last-match-wins 會把 managed 路徑變成強佔。

三種狀態（禁止只講「WT vs 未來 checkout」兩態）：

- **(a) blob 已是 LF**，僅工作樹因 `core.autocrlf`／checkout 變 CRLF → 加屬性可修好**之後**的 checkout／正規化。已存在且未改的工作樹檔**不會**因加屬性自動變 LF。
- **(b) blob 已是 CRLF**（已進 index／history）→ **僅加屬性不會**把歷史 blob 變 LF；fresh clone／POSIX CI 仍可能 exit 127；須對具名檔跑 consent-gated 修檔（`node .devpro/scripts/repair-named-hook-eol.mjs --file <path> … --i-consent-rewrite-named-files`）後 **commit**（或 consumer 經同意自行 `git add --renormalize` 等同等路徑），再推送。
- **(c) 既有 dirty 工作樹檔** → 屬性不自動改寫；須明示選檔＋操作者同意後跑同一修檔 CLI。

交叉引用與「flag ≠ 操作者同意」見 `consumer-adoption.md`。

## Common Rationalizations

| Rationalization | Response |
|---|---|
| "The consumer's existing `.gitattributes` rule for these paths should stay authoritative." | Last-match-wins means whichever rule is physically last controls the path; the managed block must be terminal for LF／whitespace protection to actually hold. |
| "Sync can insert the managed block anywhere convenient." | Placement is not cosmetic — a non-terminal block can be silently overridden by later consumer content for the same paths. |
| "I'll hand-edit synced `.devpro` to strip trailing spaces so whitespace gate goes green." | Forbidden when the trailing space is source-declared. Rerun `--sync` or report the gap to source — do not fight `--check`. |
| "I'll hand-maintain the managed whitespace list in this markdown as sync SSOT." | Forbidden. Source `.gitattributes` + derive helper are the runtime authority; this file is contract／example only. |

## Verification

```bash
node .devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs --sync
node .devpro/scripts/sync-agent-rules.mjs --check
```
