import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";

const rulesDir = path.join(REPO_ROOT, ".devpro", "agent-rules");

const TFI = readFileSync(path.join(rulesDir, "token-frugal-io.md"), "utf8");
// The session ledger mechanics (recording sources, lifecycle, hard block, re-read and reset
// rules) moved verbatim to an on-demand leaf; the entry keeps the recording rule and a pointer.
const LEDGER = readFileSync(path.join(rulesDir, "rule-load-ledger-internals.md"), "utf8");
const PAC = readFileSync(path.join(rulesDir, "platform-adapter-contract.md"), "utf8");
const CS = readFileSync(path.join(rulesDir, "code-simplification.md"), "utf8");
const MD = readFileSync(path.join(rulesDir, "model-delegation.md"), "utf8");
// rationalize-overbundled-entry-leaves T1: Token efficiency rules (i) and (j) moved to sibling
const MD_TOKEN = readFileSync(path.join(rulesDir, "model-delegation-token-efficiency.md"), "utf8");
const OF = readFileSync(path.join(rulesDir, "openspec-flow.md"), "utf8");
const CC = readFileSync(path.join(rulesDir, "chore-classification.md"), "utf8");
const CODEX = readFileSync(path.join(rulesDir, "platform-adapters", "codex.md"), "utf8");
const CLAUDE = readFileSync(path.join(rulesDir, "platform-adapters", "claude-code.md"), "utf8");
const OBS = readFileSync(path.join(rulesDir, "observability-capabilities.md"), "utf8");
const SPL = readFileSync(path.join(rulesDir, "session-pending-lifecycle.md"), "utf8");

function section(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(
    new RegExp(
      `(?:^|\\n)(?:#{2,4} .*${escaped}.*|\\d+\\. \\*\\*${escaped}\\*\\*.*)\\n?([\\s\\S]*?)(?=\\n(?:#{2,4} |\\d+\\. \\*\\*)|$)`,
    ),
  );
  assert.ok(match, `section not found: ${heading}`);
  return match[0];
}

describe("token-frugal mechanical gates (B-mini chore strengthen-token-efficiency-rules)", () => {
  it("Throughput-Side framing exists in token-frugal-io.md", () => {
    assert.match(TFI, /Throughput-Side/, "Throughput-Side heading or content missing");
    assert.match(TFI, /prompt-bundle/, "prompt-bundle reference missing in throughput section");
  });

  it("Fanout Payload Gate pins repeated subagent payload cost", () => {
    assert.match(TFI, /### Fanout Payload Gate/, "Fanout Payload Gate heading missing");
    assert.match(TFI, /payload tokens x subagent count/, "fanout cost formula missing");
    assert.match(TFI, />2000 tokens sent to >=2 subagents/, "large payload fanout threshold missing");
    assert.match(TFI, /any same payload sent to >=3 subagents/, "same payload fanout threshold missing");
    assert.match(TFI, /file path \+ line range \+ task/, "filesystem-readable payload guidance missing");
    assert.match(TFI, /inline needed excerpt/, "bounded inline excerpt fallback missing");
  });

  it("Rule Load Ledger Gate pins session rule-load observability", () => {
    assert.match(TFI, /### Rule Load Ledger Gate/, "Rule Load Ledger Gate heading missing");
    assert.match(TFI, /rule-load ledger/, "rule-load ledger wording missing");
    assert.match(TFI, /rule_load_bytes/, "rule_load_bytes field missing");
    assert.match(TFI, /rule_load_tokens_est/, "rule_load_tokens_est field missing");
    assert.match(TFI, /rule-load-ledger\.mjs/, "rule-load-ledger script anchor missing");
    assert.match(TFI, /AGENTS trigger index eager-load row 預設 ≤2 refs/, "AGENTS eager-load budget missing");
  });

  it("entry routes session ledger mechanics to the on-demand leaf without restating them", () => {
    const pointer = TFI.split("\n").filter((line) => line.startsWith("> Load-chain（session ledger 機制）："));
    assert.equal(pointer.length, 1, "entry must keep exactly one session-ledger Load-chain line");
    assert.match(
      pointer[0],
      /lifecycle.*duplicate full read hard block.*何時可重讀.*`--session-reset`.*`rule-load-ledger-internals\.md`.*被 hard block 擋下.*MUST 先讀該 leaf/,
      "session-ledger Load-chain line must name the leaf, what it holds and when it must be read",
    );
    assert.ok(section(TFI, "Rule Load Ledger Gate").includes(pointer[0]), "pointer must sit inside the Rule Load Ledger Gate section");
    assert.doesNotMatch(TFI, /^- PostToolUse 不作為 rule-load recording 權威來源/m, "entry must not restate the leaf bullets");
  });

  it("session ledger leaf holds the recording, lifecycle, hard-block and re-read rules", () => {
    const oneLine = (regex, label) => {
      const hits = LEDGER.split("\n").filter((line) => regex.test(line));
      assert.equal(hits.length, 1, `${label} must match exactly one line; actual=${hits.length}`);
    };
    oneLine(/^Session rule-load ledger 是 source-aware gate \+ telemetry，state 依 runtime session identity 分檔：$/, "ledger scope line");
    oneLine(/^- PreToolUse 在 compatible shell-command 讀取.*native `Read` payload.*進 context 前已有 ledger/, "recording source");
    oneLine(/^- PostToolUse 不作為 rule-load recording 權威來源.*不得 double-count/, "PostToolUse non-authority");
    oneLine(/^- PreToolUse 在同 session ledger 的 lifecycle=`reliable` 且同 context epoch 內重複 full read 未變更 leaf 時 hard block.*duplicate bytes\/tokens/, "duplicate hard block");
    oneLine(/^- lifecycle 只有 `reliable` \/ `unknown`.*runtime 無 session identity 時不寫 shared ledger、不啟用機械 duplicate block/, "lifecycle and fail-open");
    oneLine(/^- partial read 不覆蓋後續 full read；檔案 hash 已變、使用者要求重驗、或 context 確認遺失可重讀/, "re-read conditions");
    oneLine(/^- 手動校正必須顯式指定 target.*--session-reset --reason.*不猜 current session/, "manual reset");
    oneLine(/^- 若 live session 顯示 SessionStart 已 reset ledger 但真實 rule-read 後 ledger 仍空.*MUST 先加 bounded host diagnostic log/, "host diagnostic before fix");
  });

  it("reference-only review and handoff packet guidance exists", () => {
    assert.match(TFI, /Reference-only review\/handoff packets/, "reference-only packet heading missing");
    assert.match(TFI, /file path \+ line range \+ task \+ acceptance/, "reference-only packet shape missing");
    assert.match(TFI, /不得 inline full diff \/ full PR body \/ full sticky body \/ full log/, "inline payload ban missing");
    assert.match(TFI, /verdict.*last_reviewed_sha.*URL/, "minimal sticky fields missing");
  });

  it("reference-only review/handoff packet guidance pins telemetry hard-gate evidence fields", () => {
    const packetSection = section(TFI, "Reference-only review/handoff packets");
    for (const [pattern, message] of [
      [/hard gate/, "hard gate wording missing from reference-only packet section"],
      [/telemetry/, "telemetry wording missing from reference-only packet section"],
      [/source_lines/, "source_lines telemetry capsule field missing from reference-only packet section"],
      [/packet_lines/, "packet_lines telemetry capsule field missing from reference-only packet section"],
      [/inline_full_payloads/, "inline_full_payloads telemetry capsule field missing from reference-only packet section"],
      [/reference_only/, "reference_only telemetry capsule field missing from reference-only packet section"],
      [/report-session-token-usage/, "real-usage carrier reference missing from reference-only packet section"],
    ]) {
      assert.match(packetSection, pattern, message);
    }
  });

  it("full Devpro development flow requires equivalent lineage-inclusive actual measurements", () => {
    assert.match(TFI, /Full Devpro Flow Token Reduction Gate/, "full-flow token gate heading missing");
    assert.match(TFI, /full Devpro development flow/, "full-flow scope literal missing");
    assert.match(TFI, /machine-observed actual baseline/i, "actual baseline requirement missing");
    assert.match(TFI, /actual after/i, "actual after requirement missing");
    assert.match(TFI, /equivalent lineage-inclusive/i, "equivalent lineage boundary requirement missing");
    assert.match(TFI, /root.*descendant.*external reviewer/is, "all contributor roles missing");
    assert.match(TFI, /\(actualBaseline - actualAfter\) \/ actualBaseline/, "actual savings formula missing");
    assert.match(TFI, /rule-load ledger/, "rule-load ledger required for full-flow reduction missing");
    assert.match(TFI, /reference-only packets/, "reference-only packets required for full-flow reduction missing");
    assert.match(TFI, /no duplicate rule-load/, "duplicate rule-load guard missing");
    assert.doesNotMatch(TFI, /baseline estimate|after estimate/, "estimate-only ledger wording must be retired");
  });

  it("token-cost reduction claims cite reconciled lineage usage and keep quota inference unavailable", () => {
    assert.match(TFI, /真實用量載體/, "real-usage carrier label missing");
    assert.match(TFI, /report-session-token-usage\.mjs/, "report-session-token-usage.mjs anchor missing");
    assert.match(TFI, /--lineage/, "lineage reporter flag missing");
    assert.match(TFI, /lineage-complete.*reconciled/is, "complete and reconciled evidence guard missing");
    assert.match(TFI, /quota.*N\/A|N\/A.*quota/is, "numeric quota inference guard missing");
    assert.match(TFI, /不得只憑估算或口頭宣稱|不得宣稱/, "estimate-only claim guard missing");
    assert.doesNotMatch(TFI, /Actual Savings Claim Gate/, "removed Actual Savings Claim Gate heading must not remain");
  });

  it("delegation token-efficiency action point uses descendant-inclusive equivalent evidence", () => {
    assert.match(MD_TOKEN, /descendant-inclusive|lineage-inclusive/, "descendant-inclusive measurement anchor missing");
    assert.match(MD_TOKEN, /equivalent.*baseline.*after|baseline.*after.*equivalent/is, "equivalent comparison anchor missing");
    assert.match(MD_TOKEN, /external reviewer/i, "external reviewer contributor anchor missing");
    assert.match(MD_TOKEN, /quota.*N\/A|N\/A.*quota/is, "quota authority guard missing");
  });

  it("Pre-Read Gate sub-section in token-frugal-io.md", () => {
    assert.match(TFI, /### Pre-Read Gate/, "Pre-Read Gate sub-heading missing");
    assert.match(TFI, />100 行/, "Pre-Read Gate 100-line threshold missing");
    assert.match(TFI, /對稱.*Pre-Edit Gate/, "Pre-Read Gate symmetry reference to Pre-Edit Gate missing");
  });

  it("wc mechanical gate (MUST clause) in token-frugal-io.md", () => {
    assert.match(TFI, /MUST 先 `wc -l`/, "wc mechanical gate MUST clause missing");
    assert.match(TFI, />200 行/, "wc gate 200-line threshold missing");
  });

  it("Default Flags table includes git show and Read entries", () => {
    assert.match(TFI, /\|\s*git show\s*\|/, "git show row missing in Default Flags table");
    assert.match(TFI, /\|\s*整檔讀取\s*\|/, "整檔讀取 row missing in Default Flags table");
  });

  it("Skill / Slash Command Exception sub-section", () => {
    assert.match(TFI, /### Skill \/ Slash Command Exception/, "Skill exception sub-heading missing");
    assert.match(TFI, />5K\s*token/, "Skill exception 5K token threshold missing");
    assert.match(TFI, /Skill.*MUST|MUST.*降級/, 'Skill exception MUST keyword missing');
  });

  it("long-output test failure evidence uses notes/tmp log and filtered summary", () => {
    assert.match(TFI, /Long-output test failure evidence/, "long-output test failure evidence heading missing");
    assert.match(TFI, /node --test \.devpro\/scripts\/tests\//, "full source test command anchor missing");
    assert.match(TFI, /notes\/tmp/, "notes/tmp log requirement missing");
    assert.match(TFI, /mktemp "\$repo_root\/notes\/tmp\/devpro-test\.XXXXXX"/, "portable notes/tmp mktemp example missing");
    assert.match(TFI, />"\$log" 2>&1/, "redirect-to-log example missing");
    assert.match(TFI, /rc=\$\?/, "rc return-code variable missing");
    assert.match(TFI, /zsh readonly `status`/, "zsh readonly status guard missing");
    assert.match(TFI, /not ok\|failureType\|location:\|error:\|# fail/, "failure-summary rg pattern missing");
    assert.match(TFI, /-C 8/, "bounded context flag missing");
    assert.match(TFI, /Command Output Hard Gate/, "command output hard gate heading missing");
    assert.match(TFI, /capture-command\.mjs --topic <topic> -- <cmd> \[args\.\.\.\]/, "canonical capture-command helper usage missing");
    assert.match(TFI, /command=.+rc=.+lines=.+bytes=.+log=/, "capture-command compact summary fields missing");
    assert.match(TFI, /stdout\+stderr/, "stdout+stderr capture requirement missing");
    assert.match(TFI, /compact summary/, "compact summary requirement missing");
    assert.match(TFI, /line\/byte count/, "line/byte count summary missing");
    assert.match(TFI, /failed test names/, "failed test names summary missing");
    assert.match(TFI, /log path/, "log path summary missing");
    assert.match(TFI, /openspec validate --strict --all/, "OpenSpec high-output command anchor missing");
    assert.match(TFI, /external reviewer NDJSON \/ stream output/, "external reviewer stream anchor missing");
    assert.match(TFI, /MUST NOT tail raw TAP on success/, "success-path raw TAP tail ban missing");
    assert.match(TFI, /失敗路徑也 MUST NOT tail raw TAP/, "failure-path raw TAP tail ban missing");
    assert.match(TFI, /bounded ≤500 tokens excerpt/, "failure/parser-debug bounded excerpt requirement missing");
    assert.match(TFI, /MUST NOT append `\.log` after `XXXXXX`/, "mktemp .log suffix ban missing");
    assert.doesNotMatch(TFI, /tail -n 80 "\$log"/, "failure fallback must not dump raw tail output");
    assert.doesNotMatch(TFI, /mktemp "\$repo_root\/notes\/tmp\/[^"]*XXXXXX\.log"/, "mktemp template must not append .log after XXXXXX");
    assert.doesNotMatch(TFI, /\/tmp\/agent-out/, "legacy /tmp/agent-out guidance must not remain in token-frugal-io.md");
  });

  it("code-simplification.md has single-file < 200 lines downgrade clause", () => {
    assert.match(CS, /diff < 200 行/, "simplify downgrade clause for small diff missing");
  });

  // rationalize-overbundled-entry-leaves T1: Token efficiency rules (i) and (j) moved from
  // model-delegation.md to model-delegation-token-efficiency.md (on-demand sibling).
  // Assertions repointed to the sibling file where the content now lives.
  it("model-delegation-token-efficiency.md has (i) and (j) Token efficiency rules with full-width parens", () => {
    assert.match(MD_TOKEN, /（i）/, "（i）clause missing in Token efficiency rules");
    assert.match(MD_TOKEN, /（j）/, "（j）clause missing in Token efficiency rules");
    assert.match(MD_TOKEN, /同檔.*≥\s*3\s*處.*Edit/, "(i) same-file ≥3 Edit clause content missing");
    // (j) bilingual tier mapping lives in model-delegation.md TL推理層選擇建議 section (entry leaf)
    assert.match(MD, /高推理層 \(reasoning\).*中執行層 \(execution\)/s, "(j) bilingual tier mapping missing");
    assert.match(MD, /低機械層 \(rote\)/, "low rote tier mapping missing");
    assert.match(MD_TOKEN, /是否委派仍由admission決定/, "(i) admission decision contract missing");
    assert.match(MD_TOKEN, /不能為避免post-edit dump反而付出更大的context handoff/, "(i) handoff-cost polarity missing");
    assert.match(MD_TOKEN, /output長度本身不授權spawn/, "(j) output-length non-authorization missing");
    assert.match(MD_TOKEN, /不證明lineage成本較低/, "(j) lineage-cost non-proof missing");
    const retiredMandatory = /MUST 委派 dp-programmer|委派中執行層 subagent/;
    assert.doesNotMatch(MD_TOKEN, retiredMandatory);
    assert.match("MUST 委派 dp-programmer", retiredMandatory);
  });

  it("B-mini classification + Fast-Track exists across hub or chore-classification leaf", () => {
    // Post-split: hub keeps redirect summary, chore-classification.md has full table + Fast-Track.
    // Sum mentions across both files (≥5 total) so future hub trims won't break the gate.
    const combined = OF + CC;
    assert.match(combined, /B-mini/, "B-mini classification missing in both hub and leaf");
    const bminiMatches = combined.match(/B-mini/g) || [];
    assert.ok(bminiMatches.length >= 5, `Expected ≥5 B-mini mentions across hub + chore-classification, got ${bminiMatches.length}`);
    assert.match(combined, /B-mini Fast-Track/, "B-mini Fast-Track section heading missing in both hub and leaf");
  });

  it("chore A Fast-Track section references /devpro:pre-pr (anchor + content double-check)", () => {
    // Match heading + ≤4000 chars block until next ### or ## section
    // Window expanded 800→2000 after PR strengthen-chore-a-self-alignment-grep：A 類 fast-track section 加入「對齊類 chore A 必驗」sub-bullet 後超過 800 chars
    // Window expanded 2000→3000 after PR strengthen-chore-a-dp-change-entry：chore A fast-track 描述改為兩條 co-equal 入口 + 共同 gate 不變式後 section 達 ~2310 chars
    // Window expanded 3000→4000 after PR fix-seal-receipt-deadlocks：共同不變式加入 receipt_authority_unavailable pointer（#2495）後 section ~3129 chars
    const choreAFastTrackBlock = CC.match(/### Chore A 類 Fast-Track[\s\S]{0,4000}?(?=\n###|\n##\s)/);
    assert.ok(choreAFastTrackBlock, "Chore A Fast-Track section heading missing");
    assert.match(choreAFastTrackBlock[0], /\/devpro:pre-pr/, "Chore A Fast-Track must reference /devpro:pre-pr (issue #351 斷點 6: align with pre-tool-gate Gate #9)");
  });

  it("issue#1200: rule loading scope order + archive/.worktree/refs forbidden-path defaults", () => {
    assert.match(TFI, /### Rule Loading Scope Order/, "Rule Loading Scope Order heading missing");
    assert.match(TFI, /AGENTS\.md/, "AGENTS.md in loading order missing");
    assert.match(TFI, /active platform adapter/, "active platform adapter in loading order missing");
    assert.match(TFI, /Forbidden-path default/, "Forbidden-path default missing");
    assert.match(TFI, /openspec\/changes\/archive/, "archive forbidden path missing");
    assert.match(TFI, /\.worktree/, ".worktree forbidden path missing");
    assert.match(TFI, /refs\//, "refs forbidden path missing");
  });

  it("session-pending formalization starts narrow before broad search", () => {
    assert.match(TFI, /Session Pending Formalization Narrowing Gate/, "session-pending narrowing gate heading missing");
    assert.match(TFI, /notes\/session-pending\.md/, "session-pending source anchor missing");
    assert.match(TFI, /selected pending item/, "selected pending item input missing");
    assert.match(TFI, /target file\(s\)/, "target files input missing");
    assert.match(TFI, /minimum routing leaf/, "minimum routing leaf input missing");
    assert.match(TFI, /proposal\/spec drafting/, "drafting-before-broad-exploration order missing");
    assert.match(TFI, /broad `rg -n \.\.\. \.devpro \.claude openspec`/, "broad raw rg example ban missing");
    assert.match(TFI, /rg -l/, "rg -l first-pass option missing");
    assert.match(TFI, /rg --count/, "rg --count first-pass option missing");
    assert.match(TFI, /direct file ranges/, "direct file ranges first-pass option missing");
    assert.match(TFI, /main-checkout `notes\/tmp`/, "notes/tmp redirect option missing");
    assert.match(TFI, /openspec\/changes\/archive.*\.worktree.*refs/s, "forbidden path defaults missing from narrowing gate");
    assert.match(TFI, /pending item 明確點名 archived change\/spec\/capability/, "archive/spec named exception missing");
    assert.match(TFI, /active adapter loading requirements/, "adapter loading preservation missing");
    assert.match(TFI, /adapter siblings or cold leaves/, "eager adapter sibling/cold leaf guard missing");
  });

  it("session-pending lifecycle cross-references token-frugal narrowing gate without duplicating details", () => {
    assert.match(SPL, /Session Pending Formalization Narrowing Gate/, "lifecycle cross-reference missing");
    assert.match(SPL, /token-frugal-io\.md/, "lifecycle token-frugal source reference missing");
    assert.match(SPL, /Detailed search\/path rules live there/, "lifecycle must point details to token-frugal");
    assert.doesNotMatch(SPL, /broad `rg -n \.\.\. \.devpro \.claude openspec`/, "lifecycle must not duplicate detailed broad-search ban");
  });

  it("issue#1200: codex /dp:* parity prefers Skills/Plugins over deprecated Custom Prompts", () => {
    assert.match(CODEX, /Custom Prompts/, "Custom Prompts mention missing in codex adapter");
    assert.match(CODEX, /deprecated/, "deprecated marker missing for Custom Prompts");
    assert.match(CODEX, /~\/\.codex\/prompts/, "custom prompts path missing");
    assert.match(CODEX, /\/prompts:/, "/prompts: invocation form missing");
    assert.match(CODEX, /Skills/, "Skills recommended path missing");
    assert.match(CODEX, /Plugins/, "Plugins distribution path missing");
  });

  it("issue#1200: claude-code + observability cross-ref token-frugal Rule Loading Scope Order", () => {
    assert.match(CLAUDE, /Token-Frugal Rule Loading/, "claude-code token-frugal cross-ref missing");
    assert.match(CLAUDE, /Rule Loading Scope Order/, "claude-code Rule Loading Scope Order ref missing");
    assert.match(OBS, /Rule Loading Scope Order/, "observability Rule Loading Scope Order ref missing");
    assert.match(OBS, /Forbidden-path default/, "observability Forbidden-path default ref missing");
  });
});

describe("active-adapter action routing scenarios", () => {
  it("Scenario: Pure-text response does not load a runtime adapter", () => {
    assert.match(PAC, /純文字問答且不讀寫 repo、不呼叫工具時不載入 runtime adapter/);
  });

  it("Scenario: Read-only repository inspection loads the active entry only", () => {
    assert.match(PAC, /唯讀 rg／cat.*只載 shared contract 與 active adapter/);
    assert.match(TFI, /leaf 只在 trigger 命中時讀，不預載 sibling/);
  });

  it("Scenario: A read-only query transitions to an action", () => {
    assert.match(PAC, /唯讀發現若轉成寫入、測試、git\/gh、reviewer 或 workflow，在該動作前再載入其明確 leaf 與 gate/);
  });

  it("Scenario: Required leaf or gate is unavailable", () => {
    assert.match(PAC, /必要 leaf 不可讀或 gate 可見性未證明.*停止受影響動作/);
  });

  it("Scenario: Claude shared-contract routing preserves the post-PR trigger", () => {
    assert.match(PAC, /PR 建立後即使沒有再呼叫 gh.*post-PR completion gate/);
  });
});
