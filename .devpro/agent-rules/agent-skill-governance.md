---
name: agent-skill-governance
description: ".devpro/agent-skills reusable skill 治理：template、manifest、lint、progressive disclosure；新增/修改 skill 時觸發。"
---

# Agent Skill Governance

## Overview

`.devpro/agent-skills/` 放 reusable agent skills and on-demand CLI manuals。它不是 always-loaded root rule，也不是 root `skills/` marketplace。每個支援平台在 repo 內的 discovery 目錄——`.agents/skills`（neutral/`AGENTS.md` runtime discovery，`.cursor/` 的 runtime 也經此發現）、`.claude/skills`（`.cursor/` 的 runtime 相容讀取）——在 source repo 只有一條 entry `devpro`（consumer 在旁自建的 skill 由 sync 保留），是指向 catalog root `.devpro/agent-skills` 的 symlink；catalog root 另有 plugin manifest `.claude-plugin/plugin.json`（`name: devpro`），skill 因此以 `devpro:<name>` 叫用（各 host 叫用形見 active platform adapter）。不得把任一 discovery 目錄當第二份 SSOT。`.cursor/skills/<name>` 已退役，不再是 discovery root：擁有 `.cursor/` 的 runtime 透過 `.agents/skills` 與 `.claude/skills` 發現 skill。新增 skill 前先走本規範，確保每個 skill 可發現、可 lint、可按需載入，且不引入 runtime-only storage。

## When to Use

- 新增或修改 `.devpro/agent-skills/**/SKILL.md` 時
- 新增 skill supporting files under `references/`、`scripts/`、`assets/` 時
- 修改 `.devpro/agent-skills/manifest.json` 時
- 設計未來可安裝 skill / marketplace lane 前

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | N/A for semantic execution |
| Advisory | N/A |
| Doctrine | `cooperative-only`：依現有入口由 TL／角色執行；focused tests 僅守載體與契約，不證明語意遵循。 |


### Skill Template

1. 從 `.devpro/agent-skills-refs/templates/SKILL.md` 複製結構。
2. `name` 必須是 lowercase alphanumeric + hyphen，且與 skill folder basename 一致。
3. `description` 是 routing metadata，不是 process summary；必須說明 what + trigger，並包含 use-when 觸發詞（`Use when`／`使用時機`／`當…時`，中英皆可，任一即可）；缺漏時 `lint-agent-skills.mjs` 報 `missing-use-when` warning。此觸發詞集的 SSOT 在 `lint-agent-skills.mjs` 的 use-when 觸發詞 regex（非本文件另立平行清單，避免兩處 drift）。不要把 workflow steps 寫進 description，避免 agent 未讀完整 `SKILL.md` 就執行過期摘要。
4. Body 第一個非空行必須是 markdown heading。
5. First-party skill 目標 ≤ 500 lines；超過時先拆 `references/`，不要把長手冊塞進 `SKILL.md`。

### Skill Manifest

1. 正式 skill 必須列在 `.devpro/agent-skills/manifest.json`。
2. Manifest path 必須指向 `.devpro/agent-skills/<group>/<skill>`，且該目錄含 `SKILL.md`。三鎖：目錄名＝frontmatter `name`＝manifest `name`（裸名，不帶 `devpro:`）；`devpro:<name>` ≤64 字元。
3. On-demand 參考手冊與 template 放 `.devpro/agent-skills-refs/`（自有 `manifest.json`），不放 catalog；entry 樹可達的 `SKILL.md` 集合必須恰等於 catalog manifest。
4. 每個非 template `SKILL.md` folder 必須在所屬 manifest 中出現 exactly once。
5. `templates/` 是 authoring asset，不列入 manifest skills。
6. Manifest 是 Devpro local discovery metadata，不是 root marketplace manifest；若要公開 marketplace，另開 OpenSpec change。
7. 新 skill 放進 catalog 即經 `devpro` entry 被發現；**不得**另建 per-skill discovery link。

### 機器端 skill 分類（owner 投影白名單）

一部分 skill 是「在主機／owner 上直接操作」用的，不需要 repo checkout，也不該假設自己有 repo 的 gate。這類 skill 的分類前綴**固定為 `devops/`（未來可擴充 `ops/`，只這兩個）**：

- 放得進 `devops/`（或未來 `ops/`）：部署、主機操作、服務維運這類「機器端」流程。
- **不要**放進去：`devpro-workflows/`、`devpro-reviews/`、`release/`、`rules-authoring/`、`consumer/`、`openspec/`、`security/` 這些 repo 工作流——owner 沒有 repo checkout 與對應 gate，拿到只會誤以為自己跑得了。
- Hermes 的 `behavior_export` 以這兩個前綴當白名單，只把 `devops/`（未來 `ops/`）投影進 owner 的 behavior snapshot；其餘 group 不投影。
- 改這個前綴屬跨 repo 契約變更：先改本節，再通知 hermes-plugins 側同步白名單。

### Skill Lint

Run `node .devpro/scripts/lint-agent-skills.mjs` before PR. Errors fail closed for structural issues: missing frontmatter, invalid name, missing description, manifest drift, missing `SKILL.md`, forbidden root skill dir, source-repository discovery directories holding anything other than one `devpro` symlink resolving to `.devpro/agent-skills`, plugin manifest drift, a `SKILL.md` at the catalog root, and an entry-tree inventory that differs from the catalog manifest. Warning exceptions are allowed only for manifest entries with `upstreamCopy: true` and exact `allowedWarnings` codes (currently `missing-use-when`, `long-body`); first-party skills keep those warnings visible.

### Behavioral Evaluation Before Deployment

When a change adds a first-party Devpro skill or materially changes its routing or operative instructions, it MUST include proportional behavioral evaluation before deployment. A new skill MUST use a no-guidance baseline; a materially changed existing skill MUST use the deployed or current-version skill as its baseline. The treatment MUST rerun the same scenario and expected behavior with the proposed skill in a fresh context.

Separate a missing reusable workflow contract from an observed execution gap and comparative quality. Claims of an observed execution gap or comparative superiority MUST be narrowed to the actual baseline and treatment evidence. An explicitly requested missing workflow contract MAY be standardized only with a mechanism-level gap, direct user value, an action point, and fresh-context verification. Baseline success limits inability/superiority claims; it is not a blanket veto on that contract. If the existing contract is mechanism-equivalent, the author MUST keep it rather than add duplicate guidance. Source popularity or prose preference cannot substitute for a gap.

Bind each claim to its activation and exercised stage. An unexercised stage MUST be recorded as not exercised, not as equivalence, success, or evidence that the stage is unnecessary. A failed treatment requires repair or a narrowed/abandoned claim, not a passing verdict.

Evaluation inputs MUST hide scoring answers, sibling-arm results, and arm-identifying paths from the candidate. Use the same organic task and grade actual reads, decisions, commands and artifacts rather than self-reported compliance; keep the rubric and arm mapping outside candidate access.

Choose scenarios that fit the claim:

| Evaluation type | Required scenario shape |
|---|---|
| Routing | should-trigger, should-not-trigger, and ambiguous-boundary requests |
| Discipline | a realistic incentive to bypass the instruction |
| Technique | applying the method to a new or edge case |
| Reference | retrieving and correctly applying the relevant information |

Record the evidence in one change-local `skill-evaluation.md`: subject and claim, evaluation type, baseline kind and result, scenario and expected behavior, fresh-context treatment result, tested and untested runtime/model families with limitations, and a `proceed`, `narrow`, or `abandon` verdict.

Existing all-runtime distribution and support MUST remain unchanged. Per-family behavioral evidence is required only when the change makes an explicit runtime/model-specific behavioral-equivalence claim, and then for every family named by that claim. Missing authority or tooling MUST be recorded as a limitation and MUST NOT by itself narrow shared support. This workflow MUST NOT prescribe a fixed repetition count, a single runtime harness, copied upstream prompts, or grant external-disclosure authorization; those remain change-specific design and authorization decisions.

Actual model-behavior evidence is `cooperative-only`. Repository anchor guards can lock the carrier and contract wording, but they are not semantic proof that an agent followed the skill.

### Progressive Disclosure

Keep `SKILL.md` as the routing and common workflow layer. Put cold details in:

| Directory | Use |
|---|---|
| `references/` | long examples, API notes, troubleshooting, checklists |
| `scripts/` | executable helpers referenced from `SKILL.md` by relative path |
| `assets/` | templates, schemas, static data |

Load supporting files only when the current task needs them. Do not require every session to read a skill's full reference tree.

### Storage Boundary

- Allowed: `.devpro/agent-skills/**` (single source of truth for skill content)
- Discovery entries：規則見下方 §Skill Cross-Platform Distribution。
- Forbidden in this repo: root `skills/`
- Existing `.devpro/agent-skills-refs/autonomous-ai-agents/*` CLI manuals remain on-demand external reviewer manuals; do not rewrite their upstream-specific body unless a Devpro test or adapter contract requires it.

### Skill Cross-Platform Distribution

First-party Devpro user-invocable skills are exposed to every supported runtime through two checked-in symbolic links, never through copied content. The topology and lint rules below apply to the source repository. In a consumer, `--sync` installs the same two `devpro` entries and keeps consumer-owned nodes beside them (for example `.claude/skills/<own-name>`); legacy per-skill links whose literal target equals a shipped literal are devpro-owned and pruned (see `gitignore-alignment.md`, `rules-flow.md`).

- **Discovery paths**: `.agents/skills/devpro` (neutral / `AGENTS.md` runtime discovery; the runtime that owns `.cursor/` also reads this root) and `.claude/skills/devpro` (compatibility read for the runtime that owns `.cursor/`). Both MUST be symbolic links, and in the source repository each MUST be the only entry in its directory; neither may hold independent `SKILL.md` content.
- **Target resolution**: each symlink's relative target (`../../.devpro/agent-skills`) MUST resolve to the catalog root; a skill is reached as `<entry>/<group>/<skill>/SKILL.md`. Placing a real file/directory (not a symlink) at either discovery path is forbidden — it creates a parallel SSOT that will drift from `.devpro/agent-skills/...`.
- **Distribution mechanism**: source repo symlinks are relative and git-tracked (mode `120000`). Consumer repos receive the same relative symlink via `sync-agent-rules.mjs`'s `onSymlink` handling (`readlink` the source target, `symlink` it at the consumer destination) rather than `fs.copyFile`, which would materialize the symlink target into a plain file and break discovery.
- **Lint enforcement**: in the source repository, each of `.claude/skills` and `.agents/skills` MUST contain exactly one entry, `devpro`, a symbolic link (checked via `lstat().isSymbolicLink()`, not a followed `stat()`) resolving to `.devpro/agent-skills` itself. Any other entry, a non-symlink `devpro`, or a link resolving elsewhere (including a broken link) MUST fail lint closed. `.cursor/skills` is retired and is no longer scanned by this lint; `sync-agent-rules.mjs --sync` prunes leftover managed `.cursor/skills/<name>` entries and the legacy per-skill `.agents`／`.claude` links (only when the literal target equals the shipped literal), `--check` fails closed on residue (legacy per-skill entries: exit 30 `legacy-skill-entry-residue`), and `--uninstall` still sweeps the retired root to remove devpro-owned symlinks.

## Exit Criteria

- New or changed skill passes `node .devpro/scripts/lint-agent-skills.mjs`
- Manifest lists all non-template skill folders exactly once
- In the source repository, `.agents/skills` and `.claude/skills` each hold only the `devpro` symlink to `.devpro/agent-skills`, and the entry-tree skill set equals the catalog manifest
- `SKILL.md` description has clear trigger wording, stays routing-only, and does not encode process steps; exceptions are documented as upstream copied manuals
- New or materially changed first-party skill guidance has change-local baseline and fresh-context treatment evidence, scope limitations, and a `proceed`, `narrow`, or `abandon` verdict
- Long details are split into `references/` / `scripts/` / `assets/` when applicable
- No root `skills/` directory is introduced, and no copy of a catalog skill exists under `.claude/skills` or `.agents/skills`; `.cursor/skills` is retired and MUST NOT be reintroduced as a discovery root

## Common Rationalizations

| Rationalization | Response |
|---|---|
| "先放 skill，manifest 之後補" | Manifest is the discovery contract; unlisted skills are hidden drift. |
| "直接用 root skills/ 比較標準" | Current Devpro specs intentionally forbid root `skills/`; marketplace lane needs a separate design. |
| "在 .claude/skills 直接放一份內容比較快" | Catalog skills live only in `.devpro/agent-skills`; a copy or per-skill link under `.claude/skills` or `.agents/skills` creates a parallel SSOT that drifts. A consumer's own skill at `.claude/skills/<own-name>` is not a copy and is kept by sync. `.cursor/skills` is retired and no longer a discovery root. |
| "這份手冊很長但先塞 SKILL.md" | Long bodies raise token cost; split cold details into `references/`. |
| "description 寫完整流程比較容易觸發" | Description 只負責 routing；流程摘要會變成平行 mini-SSOT，應留在 body。 |
| "lint warning 可以忽略，所以不用跑" | 只有 manifest-declared upstream-copy exceptions 可 suppress warning；structural errors still fail closed. |
| "lint 和 anchor tests 都過了，代表 skill 有效" | Mechanical guards 只證明結構與條款存在；實際行為仍需 `skill-evaluation.md` 的 baseline 與 fresh-context treatment evidence。 |

## Verification

```bash
node .devpro/scripts/lint-agent-skills.mjs
node --test .devpro/scripts/tests/agent-skill-governance.test.mjs
rg -n "Behavioral Evaluation Before Deployment|no-guidance baseline|fresh context|cooperative-only" .devpro/agent-rules/agent-skill-governance.md
rg -n "agent-skill-governance.md" AGENTS.md README.md
test ! -d skills
test -L .agents/skills/devpro
```
