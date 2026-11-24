# Spec Delta Authoring Pitfalls (cold reference)

SSOT: `openspec-quality-and-formats.md` §Writing Spec Deltas and its on-demand leaf `openspec-spec-delta-pitfalls.md` (MAY-only catch-22, scope-shift, promoted-delta grep guard). Distilled index for quick lookup when hitting one of these failure modes; the rule leaf carries the full rationale and historical evidence citations.

| Pitfall | What happens | Fix |
|---|---|---|
| **MODIFIED full-replace silent deletion** | A `## MODIFIED Requirements` block replaces the entire canonical requirement on promotion — any existing scenario you didn't copy is silently deleted | Copy every existing scenario under that requirement into the delta before adding your changes; list intentional removals under `## Removed Scenarios` |
| **MAY-only catch-22** | Copying an existing MAY-only scenario into a `MODIFIED` delta trips the SHALL/MUST lint | Either (a) edit the canonical promoted spec directly and record why in proposal/PR body, or (b) extend `lint-spec-shall-must` exemption for untouched MAY-only scenarios in this or another chore |
| **No-delta ERROR without skip_specs (OpenSpec ≥1.9.0)** | `Change must have at least one delta. No deltas found` is ERROR, not a warn to wave through | Set `skip_specs: true` in change-folder `.openspec.yaml` when proposal documents no capability-spec impact (cite-only bugfix, doc/test chore, hygiene archive); otherwise stop and add the missing delta. MUST NOT invent requirements to pass the gate |
| **Scope-shift scenario over-broad** | Abstracting a single-mode requirement into multi-mode (e.g. adding a new tracker mode) leaves old scenarios' `WHEN` clauses implicitly scoped to the old mode, but preservation lint only checks "nothing was dropped," not "is this still correct under the new mode" | Add a requirement-level mode-scope statement ("all scenarios below apply only to `<mode>`; see `<other requirement>` for other modes") instead of qualifying every scenario individually |
| **Grep-guard no-op on promoted delta** | A static grep guard asserting "canonical + delta text" reads as green even when the delta is empty, if every asserted phrase is already in canonical | Add a delta-only assertion: delta content non-empty + at least one anchor string that exists in the delta but NOT canonical (e.g. the delta file's own title) |
| **Value-level drift** | Spec delta cites a concrete value (env value/flag/constant/filename) written from memory instead of grepped from the implementation | Grep the implementation to confirm the value before writing it into the delta |
| **Cross-carrier assertion desync** | Changing a fail-open/fail-closed direction, contract, or constant in code without updating every narrative carrier (spec delta, canonical, brd/proposal/meeting-notes/tasks) that restates it | `grep` all natural-language variants (bidirectional, both languages) of the assertion across every carrier before finishing the edit — don't fix only the carrier a reviewer pointed at |

## Pre-archive mechanical check (always run before archiving)

```bash
git diff main --stat -- <spec>
grep -c "#### Scenario:" <spec>
node .devpro/scripts/lint-modified-scenario-preservation.mjs openspec/changes/<name> --base <change-base-ref>
node .devpro/scripts/lint-delta-body-canonical-wrap.mjs openspec/changes/<name> --base <change-base-ref>
```

`<change-base-ref>` is the immutable anchor SHA used to create the worktree and retained in startup evidence; never substitute `HEAD^`, the latest remediation commit, or an arbitrary recent ref. A missing or invalid base fails closed. The base-aware lint also requires every canonical Requirement touched since that anchor to appear in the delta, including multiple Requirements in one file. With the same base, `lint-modified-scenario-preservation` also expects the scenarios canonical had at that anchor, so renaming or dropping a scenario in delta and canonical together is reported unless the old title is listed under `## Removed Scenarios` (#2978). Unexpected large deletions or a scenario-count drop is the signal for the full-replace trap — stop, restore, and re-add the intended changes rather than force through.

## Verification

```bash
grep -n "MODIFIED 全替換" .devpro/agent-rules/openspec-quality-and-formats.md
```
