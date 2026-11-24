/**
 * Guarantee ceiling (cooperative-only).
 *
 * Locks: the agent output redaction section in `security-coding.md`, its trigger
 * and exit pointers and `AGENTS.md` route, plus the other v1.3 mechanism anchors
 * in this file.
 * Does NOT prove: that agents follow the locked wording, that a paraphrase with
 * the same meaning is handled correctly, or that the meaning around an intact
 * anchor has not been inverted. Deleting an anchor fails this file; inverting the
 * meaning around an intact anchor does not. Review owns that half.
 *
 * strengthen-matt-v1-3-mechanisms-grep.test.mjs
 *
 * Contract guards for the mattpocock/skills v1.3.1 ingest (lite chore):
 * agent output credential redaction (security-coding SSOT + troubleshooting
 * pointer), RED Evidence Quality "Mutation landed" row (+ revert pointer), and
 * the knowledge digest carrier with its per-item verdicts.
 *
 * Polarity anchors bind the polarity word and its object on one physical line
 * and must match exactly one line, so deleting the operative line turns the
 * assertion red (rule-anchor-guard-strength.md).
 *
 * Style reference: strengthen-matt-skill-mechanisms-grep.test.mjs
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { sourcePath } from "./lib/source-root.mjs";
import { readSourceFile as read } from "./lib/read.mjs";

const SECURITY = read(".devpro/agent-rules/security-coding.md");
const TROUBLESHOOTING = read(".devpro/agent-rules/troubleshooting.md");
const TESTING = read(".devpro/agent-rules/testing-and-qa.md");
const DIGEST_PATH = "docs/skill-evaluations/strengthen-matt-v1-3-mechanisms/knowledge-digest.md";

function assertUniqueLine(body, re, label) {
  const hits = body.split("\n").filter((line) => re.test(line));
  assert.equal(hits.length, 1, `${label}: expected exactly one matching line, got ${hits.length}`);
}

// ---------------------------------------------------------------------------
// Redact — agent output credential redaction
// ---------------------------------------------------------------------------

test("redact: security-coding owns the agent output redaction section", () => {
  assertUniqueLine(SECURITY, /^### Agent 輸出憑證遮蔽$/, "section heading");
  assertUniqueLine(
    SECURITY,
    /^`cooperative-only`（無 hook 掃描對外文字中的憑證/,
    "cooperative-only enforcement label",
  );
});

test("redact: credential values are replaced before anything is shown", () => {
  assertUniqueLine(SECURITY, /貼出前 MUST 將[^\n]*憑證值改寫為 `<REDACTED>`/, "redact-before-show");
  assertUniqueLine(
    SECURITY,
    /MUST 以環境變數傳遞憑證[^\n]*不得把憑證值寫進命令字串/,
    "env-var loop without inline credential",
  );
  assertUniqueLine(SECURITY, /擷取物只引用帶有診斷訊號的行/, "signal-only quoting");
  assertUniqueLine(
    SECURITY,
    /遮蔽後不足以診斷時[^\n]*MUST 停下[^\n]*MUST NOT 改貼原值/,
    "insufficient redaction stops instead of pasting raw values",
  );
});

test("redact: trigger, overview scope and exit criterion point at the section", () => {
  assertUniqueLine(SECURITY, /^- AI 貼出命令、輸出或擷取物[^\n]*§Agent 輸出憑證遮蔽/, "When to Use trigger");
  assertUniqueLine(SECURITY, /\(5\) AI 貼出命令／輸出／擷取物前遮蔽憑證/, "Overview scope item");
  assertUniqueLine(SECURITY, /^- 貼出的命令／輸出／擷取物已遮蔽憑證$/, "Exit Criteria line");
});

test("redact: AGENTS.md trigger index routes output pasting to security-coding", () => {
  assertUniqueLine(read("AGENTS.md"), /\/貼出輸出·憑證遮蔽\/[^\n|]*\|`security-coding\.md`\|$/, "AGENTS index row");
});

test("redact: troubleshooting Debug Report evidence points to the SSOT", () => {
  assertUniqueLine(
    TROUBLESHOOTING,
    /^- \*\*Evidence\*\*：[^\n]*先遮蔽憑證[^\n]*`security-coding\.md` §Agent 輸出憑證遮蔽/,
    "Debug Report Evidence pointer",
  );
});

// ---------------------------------------------------------------------------
// Mutation landed — RED Evidence Quality
// ---------------------------------------------------------------------------

test("mutation landed: RED Evidence Quality row requires proof the edit applied", () => {
  assertUniqueLine(
    TESTING,
    /^\| Mutation landed \|[^\n]*MUST 先 diff 對照原始版本[^\n]*確認改動確實落地/,
    "diff-before-trust",
  );
  assertUniqueLine(
    TESTING,
    /^\| Mutation landed \|[^\n]*改動無聲未套用[^\n]*不得當 RED 證據/,
    "silent no-op red is not evidence",
  );
});

test("mutation landed: revert-then-RED path points at the row", () => {
  assertUniqueLine(TESTING, /revert 是否真的落地[^\n]*`Mutation landed`/, "revert pointer");
});

// ---------------------------------------------------------------------------
// Knowledge digest carrier
// ---------------------------------------------------------------------------

test("digest: lite evidence carrier exists with verdicts per item", () => {
  assert.ok(existsSync(sourcePath(DIGEST_PATH)), `${DIGEST_PATH} must exist`);
  const digest = read(DIGEST_PATH);
  assertUniqueLine(digest, /^## Ingest-Mapping Ledger$/, "ledger heading");
  assertUniqueLine(digest, /^\| diagnosing Redact[^\n]*\| adopt-rewrite/, "redact verdict");
  assertUniqueLine(digest, /^\| diagnosing Phase 5 mutation landed[^\n]*\| adopt-rewrite/, "mutation verdict");
  assertUniqueLine(
    digest,
    /^\| retro 載體分流[^\n]*\| mine-only[^\n]*knowledge-distillation\.md/,
    "carrier triage kept by existing ladder",
  );
  assertUniqueLine(digest, /^\| implement-spec[^\n]*\| reject/, "implement-spec rejected");
});
