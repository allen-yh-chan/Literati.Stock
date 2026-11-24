---
name: gitignore-alignment
description: Devpro-managed consumer `.gitignore` baseline SSOT; sync-rules creates/checks the managed block, while environment setup only warns and references this file.
---

# Gitignore Alignment
> Load-chain：consumer root `.gitattributes` LF checkout protection managed block SSOT 見 `gitattributes-alignment.md`。

## Overview

This file is the single source of truth for Devpro-managed consumer repo `.gitignore` baseline entries. The rules sync flow owns writing these entries into a managed block in consumer root `.gitignore`; environment setup only warns and points here.

## When to Use

- Updating Devpro-managed `.gitignore` baseline entries
- Debugging consumer rules sync `.gitignore` drift
- Environment setup warns about missing/stale `.gitignore` alignment
- Reviewing whether repo-specific local/sensitive patterns belong in the global baseline

## Rules

- sync：建立/更新 consumer root `.gitignore` managed block。
- check：managed block missing/drift → fail，提示 rerun `--sync`。
- preserve：consumer-owned rules 留在 block 外；baseline duplicates 去重。
- boundary：repo-specific local/sensitive patterns 維持 ask-first。

`sync-agent-rules.mjs --sync` MUST create or update this block in consumer root `.gitignore`:

```gitignore
# devpro-agent-rules managed begin
<baseline entries>
# devpro-agent-rules managed end
```

The sync script MUST preserve consumer-owned ignore rules outside the managed block and MUST avoid duplicate Devpro-managed baseline entries outside the managed block.

`sync-agent-rules.mjs --check` MUST fail when the managed block is missing or differs from this SSOT and instruct the user to rerun `--sync`.

## Managed Skill Inventory

`sync-agent-rules.mjs` MUST build one shared inventory before either `--sync` or `--check` distributes files. There are two manifest sources: the catalog `.devpro/agent-skills/manifest.json` (paths MUST stay below `.devpro/agent-skills/`) and the refs `.devpro/agent-skills-refs/manifest.json` (paths MUST stay below `.devpro/agent-skills-refs/`). Inventory-building logic (`buildManagedSkillInventory` and its callers) MUST NOT hard-code a release group, a skill such as `devpro:release-runbook`, or either manifest's own group/skill names — the sole named exemption is `.devpro/scripts/lib/legacy-skill-entry-artifacts.mjs`'s frozen retired-name allowlists, which exist precisely to name specific retired skills no current manifest declares.

Inventory validation is fail-closed:

- Every manifest skill path MUST be a unique, normalized, repository-relative POSIX path below its own manifest's root and MUST name an existing physical directory. Reject absolute paths, backslashes, empty/`.`/`..` segments, path-pattern metacharacters, Windows-ambiguous characters, and segments ending in a dot or space.
- Inventory outputs include each declared target directory and every file, directory, and symlink recursively below it, plus the catalog plugin manifest `.devpro/agent-skills/.claude-plugin/plugin.json` as a managed file output (it is not a skill target). Wrong node types, missing nodes, duplicate paths, and duplicate resolved targets are faults.
- Discovery is a fixed 2-entry topology, not per-skill links: the managed entry in each of `.agents/skills/` and `.claude/skills/` is named `devpro`, and its literal (separator-normalized) target MUST equal `../../.devpro/agent-skills` and its realpath MUST equal the repository's own catalog root. In the source repository each directory MUST contain only that entry; any other node name is a fault (`only '<dir>/devpro' is allowed`). In a consumer, other nodes in those directories are consumer-owned (for example `.claude/skills/<own-name>`), except the legacy per-skill links covered below: sync keeps them and they are not inventory outputs. Missing source links are not synthesized. `.cursor/skills/` is a retired discovery root: `--sync` prunes leftover managed `.cursor/skills/<name>` entries and `--check` fails closed on residue. A fixed legacy allowlist (`.devpro/scripts/lib/legacy-skill-entry-artifacts.mjs`) separately governs pruning the 40 retired per-skill discovery links and their now-orphaned catalog payload from consumers upgrading from the old topology; residue there fails closed with exit code `30`, distinct from the exit `1` contract above.
- Repository paths and Git evidence use `/` on every platform. A discovery entry MUST remain mode `120000` in Git. A host that cannot materialize physical symlinks MAY expose its link blob as a plain checkout file only when Git metadata proves that exact path is a `120000` entry with the expected link target. If `fs.symlink` returns `EPERM`, `EACCES`, or `ENOSYS` for a new discovery path with no index entry, sync MUST first create and read back the exact target blob as mode `120000` in the exact consumer Git root, then materialize the same bytes as the plain checkout; wrong/non-Git roots, existing conflicting records, Git faults, or mismatched read-back evidence MUST fail closed.

## Canonical Terminal Block

The managed block MUST be the final non-blank content of consumer root `.gitignore`. Its content is the baseline above plus inventory-derived exceptions. Rebuild it as follows:

1. Preserve every consumer-owned line outside earlier managed blocks in its original bytes（含 CRLF／mixed line endings）與相對順序；只有既有 baseline duplicate cleanup 可移除整行。
2. Remove only duplicate baseline entries outside the block. Do not delete or reorder other consumer patterns.
3. Add exact negations for every managed target's ancestors (shallow to deep), target directory, target descendants, discovery-link ancestors, and discovery-link path.
4. De-duplicate generated exceptions and sort them deterministically by path depth, then repository-path lexical order.
5. Append exactly one canonical managed block. Broad exceptions such as `!/release/` are forbidden; non-managed artifacts such as `release/build.bin` MUST remain ignored when consumer rules ignore them.

Both modes MUST use the same inventory and canonical-block functions. `--sync` distributes inventory outputs before writing the block, then validates filesystem completeness and Git persistence. `--check` validates filesystem completeness before block parity and Git persistence. A missing or wrong-type output, broken/wrong-target link, malformed block marker, non-terminal content, or parity mismatch MUST fail with the affected path and the `--sync` repair action.

## Git Persistence Proof

After filesystem and block validation, probe `git rev-parse --show-toplevel`. A non-Git consumer reports exactly `Git persistence validation: N/A (non-Git consumer root)`; a Git result whose root is not the consumer root is a fault. If the Git executable is unavailable, that `N/A` compatibility path is allowed only when neither `GIT_DIR`／`GIT_WORK_TREE` nor a `.git` file or directory exists at or above the consumer root; otherwise the missing executable is a validator fault and MUST fail closed.

For a Git consumer, send every inventory output as one NUL-delimited batch to:

```bash
git check-ignore -v -z --no-index --stdin
```

Parse each returned record strictly as four NUL-delimited fields: source, source line, pattern, and repository path. Exit `1` with no records means no output matched an ignore rule. Exit `0` requires records; exit `1` with records, status above `1`, incomplete fields, malformed line numbers, missing/unknown paths, or duplicate/contradictory records are validator faults. An unescaped leading `!` is a healthy negation; an escaped `\!` remains a positive ignore pattern. Any positive record fails with the managed path and exact `source:line` plus pattern provenance; the repair is to fix ignore rules and rerun `--sync`, never `git add -f`.

The clean-clone/staging proof is mandatory: ordinary `git add` MUST stage every target file as a regular blob and retain every discovery link as mode `120000`; the committed tree and clean clone MUST contain the same target bytes and link-target blobs. Only physical checkout materialization is capability-gated—the Git tree-mode assertion is not.

## Devpro-Managed Baseline

Baseline MUST use literal paths only（今日為字面 `.claude/settings.local.json`，**不是** `*.local.*` glob）。MUST NOT 把 `*.local.*`（或等價寬 glob）引入 Devpro-managed baseline——會誤傷／誤忽略 root `AGENTS.local.md` 等 consumer overlay。`AGENTS.local.md` 是否 ignore 仍 Ask First／consumer 自決，**不**進 managed baseline（synced `AGENTS.md` 仍禁手改；合法出口見 `consumer-local-rules.md`）。

<!-- devpro-gitignore-baseline begin -->
```gitignore
.claude/settings.local.json
.claude/scheduled_tasks.lock
refs/
notes/
codeql-results/
node_modules/
packages/
.vscode/
.vs/
.worktree/
.devpro/scripts/hooks/state/
openspec/changes/**/override-ledger/
openspec/changes/**/admission-records/
openspec/changes/**/lite-scope.md
openspec/changes/*/plan.md
```
<!-- devpro-gitignore-baseline end -->

## Local / Sensitive Project-Specific Patterns

Repo-specific local settings and sensitive config remain Ask First. Do not add these to the global Devpro-managed baseline:

- `.env.local`
- `appsettings.Development.json`
- `launchSettings.json`
- project-specific `*.local.json`, `.env*`, `secrets.*`, or equivalent local config

When such files appear before `git add` / `git commit`, follow `git-branch-hygiene.md` and `security-coding.md`: ask whether to add a repo-specific ignore rule, and proceed only according to the user's answer.

## Environment Setup Boundary

`environment-setup-nvm-nodejs-openspec.md` MAY warn that `.gitignore` alignment is missing or stale and MUST reference this file, but it MUST NOT write `.gitignore`. The correction path is the dedicated sync-rules lane, because that lane has an explicit change/PR to commit `.gitignore`.

**Bootstrap early-ignore（可選）**：首次導入 README Step 1 允許在 `--sync` 前以 consumer-owned 行先加入 `.worktree/`（後續 managed block 會吸收／去重）。這是可選提前步，非正式唯一路徑；正式 managed baseline 仍以本檔 SSOT ＋ sync 為準。不得把 delete／stash 活 worktree 當必選修復（見 README Step 1 carve-out）。

## Exit Criteria

- Baseline entries exist only in this file's marked block.
- Consumer sync creates/updates the managed block without overwriting local entries.
- Consumer check fails on missing or drifted managed block.
- Repo-specific local/sensitive patterns remain ask-first outside this baseline.

## Common Rationalizations

| Rationalization | Response |
|---|---|
| "Environment setup can just append the missing entries." | Environment setup has no dedicated sync PR; `.gitignore` writes belong to rules sync. |
| "Put every common local file in the global baseline." | Project-specific local/sensitive patterns stay ask-first to avoid hiding meaningful repo files. |

## Verification

```bash
node .devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs --sync
node .devpro/scripts/sync-agent-rules.mjs --check
```
