---
name: platform-adapter-codex-github-writes
description: "Codex cold-path GitHub/writeback/worktree details: shell-observable gh/git writes, footer preflight, body-file staging, protected-branch git write command shape."
---

# Codex GitHub Writes And Worktree Evidence

## Overview

Cold-path detail for Codex GitHub write-back and protected-branch git write handling. Load only when Codex is about to create/edit PRs/issues/comments/releases, stage GitHub body files, or run git write commands in a worktree.

## When to Use

- Codex host performs any GitHub write action
- Codex `functions.exec_command` sends an AI-authored GitHub body
- Codex git write command runs from a worktree or after a worktree add
- A hook reports fallback-only / uncertain cwd evidence

## Process

### GitHub connector / MCP write path

先讀 `tool-selection.md`。本機 gh 有效登入時，所有 GitHub 操作優先 CLI。只有 gh 未安裝或明確未登入，且本 host MCP hook 已驗證、`github_policy_status` 宣告 compatible，才可用具共用閘門的 devpro-work MCP 完成 catalog 內的寫入，包括 PR/review/merge。其餘 GitHub connector 仍只可唯讀；未登入以外的錯誤不得觸發 fallback。

MCP body 由結構化參數直接驗證，不偽裝成已執行的 shell command；local receipts、consumer checks、post-PR 與 footer 義務均保留。未證明 hook 可觀察、舊後端或缺少適用證據時停止受影響寫入。完整 capability boundary 見 `tool-selection.md`。

### `functions.exec_command` footer hook boundary

Codex MUST append the required footer to every PR / issue / comment / review / discussion / release body before executing `gh`. When the active surface is not proven to enforce `.codex/hooks.json` JSON block decisions, file-backed bodies SHOULD run strict preflight against the exact command:

```bash
node .devpro/scripts/hooks/gh-footer-gate.mjs --strict-exit -- gh pr comment <PR#> --body-file <body-file>
```

This is a validator-only dry run: it never executes the nested `gh` command and MUST NOT be treated as a GitHub write. Exit `0` means validation passed only; run the real `gh` command separately if a write is intended. On hook-proven shells, run the real `gh` command directly and let PreToolUse invoke the gate; MUST NOT manually insert this validator as an executor wrapper. Strict mode exits non-zero even under `CODEX_CI` / `CODEX_THREAD_ID`, so `functions.exec_command` cannot silently continue on a JSON-only hook block.

### Worktree-scoped footer version equality

File-backed GitHub bodies authored by TL (PR body, issue/comment/review/release notes) MUST be written to the main checkout at `<repo-root>/notes/tmp/<purpose>-<unique>.md` (gitignored; not bound to worktree lifecycle; basename includes purpose plus session/timestamp/PID/random entropy). For generic GitHub writes, `gh-footer-gate.mjs` selects the session's rules repo first (the hook cwd checkout), keeps the body file's containing repo as the fallback only when the cwd checkout yields no version, then reads that repo's canonical remote-tip `AGENTS.md` (`origin/HEAD` → `origin/main`/`origin/master`; workspace fallback when the tip is unresolvable), so running `gh ... --body-file <repo-root>/notes/tmp/<purpose>-<unique>.md` from another cwd remains valid. A write-back that names its target with `-R/--repo [HOST/]<owner>/<repo>` MUST NOT switch the anchor to that target: the footer records the rules version this session loaded, so the cwd repo (or the body-file fallback) still gates it, and a footer carrying the target repository's version blocks. Canonical rules sync is the bounded exception: use `cd <abs-rules-worktree> && gh pr create ... --head rules/<source>-v<X.Y.Z>`；the gate validates current branch、explicit head、branch suffix、worktree `AGENTS.md` version and source whitelist, then anchors footer equality to that exact rules worktree `AGENTS.md`. Unresolved or conflicting rules context fails closed；a compound command containing multiple rules write-backs MUST be split into separate commands because bodies cannot be bound independently to operations. The body carrier remains in main-checkout `notes/tmp/`.

For Codex/non-persistent cwd hosts, if a relative TL body file is not hook-visible, use the main-checkout absolute path `<repo-root>/notes/tmp/<purpose>-<unique>.md`. Reviewer subprocess sticky staging is renderer-owned；every family uses a body file in the reviewer current neutral cwd (no `--add-dir` into main-checkout `notes/tmp`) and MUST NOT name the main checkout as a reviewer-owned sticky/body staging target；worktree-internal staging stays forbidden. TL-authored issue / PR / comment / release bodies likewise MUST NOT use repo-external `/tmp` (when the cwd checkout yields no version it removes the only remaining repo anchor). 寫檔目的地總表見 `file-write-destinations.md`。

### First-attempt TL body pattern

Before the real GitHub write:

1. Create the body file in the main checkout at `<repo-root>/notes/tmp/<purpose>-<unique>.md`.
2. Append `Rules: v<X.Y.Z> · Tool: <tool> · Model: <model>`.
3. Run `gh-footer-gate.mjs --strict-exit -- <exact gh command>` only when hook enforcement is not proven; treat it as the validator-only dry run described above.
4. Run the real `gh` command.
5. Immediately delete the temporary body file after the successful write.
6. Run `git status --short` to verify no residue.

TL-authored GitHub bodies 不得用 `--body-file -` / heredoc stdin as primary path; body file 應寫至 main-checkout `<repo-root>/notes/tmp/<purpose>-<unique>.md`，不得用 repo-external `/tmp` body file. Reviewer-owned sticky staging 不沿用 TL carrier；它 MUST use the renderer-owned reviewer neutral cwd path（全 family 一致，Codex 已無 `--add-dir` 授權）.

### Protected-Branch git Write Rule

When Codex runtime does not inject worktree workdir into hook payload, Codex git write commands (`git add` / `git rm` / `git mv` / `git restore` / `git reset` / `git stash` / `git rebase` and similar) MUST make the command string itself carry hook-visible cwd evidence:

```bash
git -C <abs-worktree> <verb> <args>
```

That is the only recommended git-write form: keep `git add` and `git commit` in separate Bash calls. A `cd`-prefixed git write is no longer recommended.

`functions.exec_command.workdir`, Codex UI cwd, statusline branch, and agent memory of cwd do not prove hook-visible cwd. If the hook only sees fallback `PWD=main`, plain `git add` produces `target branch/worktree could not be proven` / fallback-only evidence, not confirmed main. Confirmed protected evidence still hard-blocks.

After `git worktree add`, the next Bash invocation must literal `cd <abs-worktree>` unless the hook payload itself proves cwd/workdir. Single-command git writes in Codex should continue to use `git -C <abs-worktree>` even when the tool runner has a `workdir`.

## Exit Criteria

- GitHub writes follow `tool-selection.md`：authenticated gh first；僅經驗證的 devpro-work MCP 可作未安裝／未登入備援
- TL-authored bodies are written to main-checkout `notes/tmp/`, footered, and preflighted when needed（notes/tmp 在 main checkout；generic write 版號錨點 = 本 session cwd checkout 的 canonical remote tip `AGENTS.md`，cwd 讀不到版號才退回 body-file 所在 repo；#3437；canonical rules operation 錨定 exact rules worktree）
- Reviewer sticky staging uses renderer-owned reviewer current neutral cwd for all families；Codex no longer holds `--add-dir` into main-checkout `notes/tmp/`
- Codex git writes expose `git -C <abs-worktree>` only, with `git add` and `git commit` as separate Bash calls

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「connector write 成功也算」 | 成功不證明 gate parity；只允許 tool-selection.md 的已驗證 devpro-work 路徑 |
| 「body file 放 /tmp 比較乾淨」 | TL bodies lose the carrier anchor whenever the cwd checkout yields no version, plus the canonical body lifecycle; use main-checkout `notes/tmp/`（generic write 錨定本 session cwd checkout 的 canonical remote tip `AGENTS.md`，#3437；canonical rules operation 仍由 exact rules worktree 提供 version）|
| 「workdir 已設」 | hook may not receive it; command string must carry evidence |

## Verification

```bash
node --test .devpro/scripts/tests/gh-writeback-body-pattern-grep.test.mjs .devpro/scripts/tests/hook-pre-tool-gate-codex-cwd.test.mjs
```
