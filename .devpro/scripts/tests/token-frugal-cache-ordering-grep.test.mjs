import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";
// B-mini chore strengthen-token-frugal-cache-ordering：
// 鎖 cache-aware ordering 段 + 長 context 退化「為何」論證 + 新世代 tokenizer 偏差錨點。
// 一手來源驗證於 2026-06（三家主流 LLM 平台 caching docs, NoLiMa arXiv:2502.05167, NVIDIA RULER, Chroma Context Rot）。

const rulesDir = path.join(REPO_ROOT, ".devpro", "agent-rules");
const TFI = readFileSync(path.join(rulesDir, "token-frugal-io.md"), "utf8");

describe("token-frugal cache-aware ordering + long-context degradation anchors", () => {
  it("Cache-Aware Ordering sub-section exists with prefix-build order", () => {
    assert.match(TFI, /### Cache-Aware Ordering/, "Cache-Aware Ordering heading missing");
    assert.match(TFI, /tools → system → messages/, "prefix build order (tools → system → messages) missing");
    assert.match(TFI, /static/, "static-prefix-first wording missing");
    assert.match(TFI, /dynamic/, "dynamic-suffix wording missing");
  });

  // 不變式 guard（cross-model PR #1230 axis-4 Important）：鎖「修正本身」而非只鎖範例字串。
  // tools→system→messages 必須維持 adapter-qualified（provider-specific / 依 active adapter），
  // 不得回退為「通用普世順序」——否則 runtime-neutral leaf 又把單一 provider 序列當普世規則。
  it("prefix sequence stays adapter-qualified (not stated as universal)", () => {
    assert.match(TFI, /provider\/API-specific/, "prefix sequence must be marked provider/API-specific");
    assert.match(TFI, /active platform adapter/, "prefix sequence must defer to active platform adapter");
    assert.match(TFI, /非普世序列/, "prefix sequence must be explicitly non-universal");
  });

  it("cache read economics anchor (0.1x base input) pinned", () => {
    assert.match(TFI, /0\.1/, "cache read 0.1x base-input multiplier anchor missing");
  });

  it("newer-generation tokenizer 35% bias warning pinned", () => {
    assert.match(TFI, /35%/, "newer-generation tokenizer 35% bias anchor missing");
    assert.match(TFI, /tokenizer/i, "tokenizer keyword missing");
  });

  it("long-context degradation 'why' rationale cites primary benchmarks", () => {
    assert.match(TFI, /NoLiMa/, "NoLiMa benchmark anchor missing");
    assert.match(TFI, /RULER/, "RULER benchmark anchor missing");
    assert.match(TFI, /Context Rot/, "Context Rot benchmark anchor missing");
  });

  it("does not break existing token-frugal anchors (regression guard)", () => {
    // 抽查既有關鍵 anchor 仍在（防追加段落誤刪/誤改既有條文）
    assert.match(TFI, /Throughput-Side/, "existing Throughput-Side anchor lost");
    assert.match(TFI, /### Pre-Read Gate/, "existing Pre-Read Gate anchor lost");
    assert.match(TFI, /MUST 先 `wc -l`/, "existing wc gate anchor lost");
    assert.match(TFI, /### Fanout Payload Gate/, "existing Fanout Payload Gate anchor lost");
  });
});
