---
risk_classes: none
rationale: Shared lint/classify-bounded alignment fixture; no auth/state/write/disclosure surface in this change.
---

# Proposal Mini: risk-classes-lint-classify-alignment-fixture

## Target State

1. Lint and classify-bounded agree on none+rationale front matter.

## Touch

| 檔案 | 類別 | 動作 | Requirement |
|---|---|---|---|
| `src/review-target.mjs` | code | modify | R1 |
