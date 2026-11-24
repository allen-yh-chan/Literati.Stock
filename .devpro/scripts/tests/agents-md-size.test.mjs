import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { READABILITY_CAP_GUARDS } from "../lib/rule-token-budget.mjs";
import { repoPath } from "./lib/repo-root.mjs";

const agentsPath = repoPath("AGENTS.md");

// Caps measured in bytes (token-efficiency mode).
// SOFT (建議): AI should aim to keep total file ≤ this; if over, compress in next maintenance round.
// HARD (觀測／治理): exceeding HARD emits soft-warn (`cap-pressure=over`); ordinary test/PR
// path MUST NOT fail closed. Remediation is governance-owned (remove-token-budget-pr-gate).
// Thresholds set after v6.0.0 refactor compressed AGENTS.md from 22,798 bytes to ~5,500 bytes
// while preserving full rule coverage (Never list, Anti-Rationalization, Red Flags, Remind, etc.).
// Raised 5500/6000 → 6000/6500 to admit the always-on 輸出紀律 anchors (簡潔 + 條件式 memory)
// in §0 per enforce-output-discipline-always-on-load — these load every session across all
// runtimes (the cross-runtime SSOT for the two disciplines); the cap still guards growth.
// Lowered hard cap 6800 → 6500 after trigger-index recompression, while keeping
// the prior 6300 soft target so protected trigger synonyms stay searchable and
// edits still warn before the file has <200B hard-cap headroom.
// Raised caps 6300/6500 → 6500/7000 in clarify-agents-md-entry-anchors per
// repo-owner directive: the entry-anchor clarifications (Core Contract gloss,
// 委派 分流 pointer, Ask First/Never 子集 signal) are load-bearing corrections,
// not compressible padding — do NOT strip added clarity to chase the cap. Soft
// 6500 stays as an early growth warning; hard 7000 is the real block threshold.
// Raised hard 7000 → 7190 in amend-output-language-zh to admit the 語言
// (output-language) policy pointer bullet in §輸出紀律 — the pointer is a
// necessary minimal increment (measured 7167B actual after adding it), not
// compressible padding. Soft 6500 stays unchanged (no SOFT > HARD risk).
// Raised hard 7190 → 7550 in strengthen-preflight-self-check to admit the new
// §0 動手前十句自檢 item 10 「一致性掃描」 — the file was already 8B under the
// prior cap (7182B baseline), so the load-bearing 10th self-check (consistency
// sweep before action; the防改漏 symmetry of item 1's追溯性) cannot fit without
// this bump. Measured ~7518B after adding item 10; the item is a normative
// pre-action gate the change was chartered to add, not compressible padding.
// Soft 6500 stays unchanged (no SOFT > HARD risk).
// Raised hard 7550 → 7650 in strengthen-current-state-delta-gate to keep the
// §0 traceability item readable while adding the no-op 現況差異 anchor for
// code/rule changes. The startup summary remains compact; this avoids turning
// an always-loaded gate into punctuation-heavy shorthand.
// Raised hard 7650 → 8750 in strengthen-token-waste-controls to admit the
// `workflow-cost-controls.md` trigger-index route without lossy compression of
// existing trigger phrases. The route is load-bearing for status/next-step fast
// path lookup; preserving the prior token-frugal and nvm trigger wording is
// intentionally preferred over shortening semantics to chase byte count.
// 8750 is the archive-gate minimum for a 7688B AGENTS.md carrier: estimated
// bytes + 875B edit headroom rounded to the 1750B quantum.
// Raised hard 8750 → 10500 in amend-agents-md-hard-cap (governance accepted
// finding from the 2026-10-14 rule audit). The carrier measured 8815B. Trim
// was tried first and rejected: every candidate line is held by an index
// mapping test, a §0 anchor test or a scenario assertion, so no 65B could go
// without deleting a routing entry. Min-necessary-cap formula:
// ceil((8815 + 875) / 1750) * 1750 = 10500.
const SOFT_CAP_BYTES = 6_500;
const HARD_CAP_BYTES = READABILITY_CAP_GUARDS["AGENTS.md"];

async function countBytes() {
  const buf = await fs.readFile(agentsPath);
  return buf.byteLength;
}

async function countLines() {
  const full = await fs.readFile(agentsPath, "utf8");
  return full.split("\n").length;
}

describe("AGENTS.md size cap", () => {
  it("registers AGENTS.md readability cap guard", () => {
    assert.equal(READABILITY_CAP_GUARDS["AGENTS.md"], HARD_CAP_BYTES);
    assert.equal(typeof HARD_CAP_BYTES, "number");
    assert.ok(HARD_CAP_BYTES > 0);
    assert.ok(SOFT_CAP_BYTES > 0, "soft-cap constant must remain registered");
  });

  it(`HARD threshold exceedance soft-warns (does not fail) at ${HARD_CAP_BYTES} bytes`, async () => {
    const bytes = await countBytes();
    const lines = await countLines();
    const notes = [];
    if (bytes > SOFT_CAP_BYTES) {
      notes.push("OVER SOFT CAP — compress in next maintenance round");
    }
    if (bytes > HARD_CAP_BYTES) {
      const utilization = Number(((bytes / HARD_CAP_BYTES) * 100).toFixed(2));
      const warn =
        `soft-warn cap-pressure=over path=AGENTS.md bytes=${bytes} hard=${HARD_CAP_BYTES} utilization=${utilization}`;
      notes.push(`OVER HARD CAP — governance-owned; ${warn}`);
      console.warn(warn);
    }
    console.log(
      `[AGENTS.md size] bytes=${bytes} lines=${lines} (soft cap ${SOFT_CAP_BYTES}B, hard cap ${HARD_CAP_BYTES}B` +
        (notes.length ? `; ${notes.join("; ")}` : "") +
        ")"
    );
    // Ordinary path: MUST NOT assert.fail on HARD exceedance (soft-warn only).
    assert.ok(bytes > 0, "AGENTS.md must be readable for size measurement");
  });
});
