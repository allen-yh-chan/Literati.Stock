/**
 * model-delegation-contract-guard.test.mjs
 *
 * purpose: Lock high-stakes phrases from model-delegation rule files
 * so they cannot be silently dropped during a refactor or trim pass.
 *
 * source change: add-reference-pattern-and-threshold-cheatsheet
 * updated by: rationalize-overbundled-entry-leaves (T1 de-bundle)
 *   — phrases that moved to sibling files now checked in their new location.
 *
 * Guarded phrases and their canonical file locations:
 *   1. "Reference Pattern"                        — model-delegation-token-efficiency.md, rule (k)
 *   2. "Quantified Threshold Cheatsheet"          — model-delegation.md (entry leaf, stays)
 *   3. "Subagent context是runtime-native"          — model-delegation-delegation-rules.md
 *   4. "MUST NOT一律宣稱不繼承main history"         — model-delegation-delegation-rules.md
 *   5. "lineage total仍包含child input/output、handoff、duplicate read與回流" — delegation-rules sibling
 *
 * Removing or renaming any guarded phrase requires an amend change that
 * updates this list.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { repoPath } from "./lib/repo-root.mjs";

const rulesDir = repoPath(".devpro/agent-rules");

function ruleFile(name) {
  return path.join(rulesDir, name);
}

async function loadFile(filePath) {
  return fs.readFile(filePath, "utf8");
}

const CALLBACK_CAPABLE_WAIT_CONTRACT =
  /callback-capable runtime[\s\S]{0,320}`completion_mode:\s*callback`[\s\S]{0,220}`completion_channel`[\s\S]{0,180}real[\s\S]{0,180}required[\s\S]{0,220}MUST register once[\s\S]{0,160}yield[\s\S]{0,240}MUST NOT[\s\S]{0,180}repeated short\/intermediate timed waits[\s\S]{0,120}`wait_agent`/i;

const MEANINGFUL_TRANSITION_CONTRACT =
  /Meaningful transition gate[\s\S]{0,320}`wait timeout`[\s\S]{0,160}`no callback yet`[\s\S]{0,160}unchanged poll sample[\s\S]{0,220}internal telemetry[\s\S]{0,180}MUST NOT[\s\S]{0,140}user-visible progress\/update[\s\S]{0,180}(?:只有|only)[\s\S]{0,180}new artifact\/checkpoint evidence[\s\S]{0,160}blocker\/decision[\s\S]{0,160}completed\/terminal/i;

const NO_CALLBACK_POLL_CONTRACT =
  /explicit no-callback runtime[\s\S]{0,180}(?:只有|只可|only)[\s\S]{0,180}bounded poll[\s\S]{0,220}`poll_interval`[\s\S]{0,180}`maximum_attempts`[\s\S]{0,180}`hard_deadline`[\s\S]{0,260}poll telemetry[\s\S]{0,120}log-only/i;

const CALLBACK_TIMING_CONTRACT =
  /delegated test\/long command completion schema[\s\S]{0,280}`started_at`[\s\S]{0,140}`ended_at`[\s\S]{0,140}`elapsed_ms`[\s\S]{0,260}`completed_at`[\s\S]{0,320}`callback_received_at`[\s\S]{0,220}`callback_delivery_latency_ms`[\s\S]{0,360}execution duration[\s\S]{0,180}delivery delay/i;

const CLOCK_DOMAIN_CONTRACT =
  /clock domains differ[\s\S]{0,260}MUST NOT subtract[\s\S]{0,260}runtime monotonic evidence/i;

const COOPERATIVE_GUARD_CONTRACT =
  /cooperative rule guard[\s\S]{0,240}MUST NOT[\s\S]{0,160}runtime hard enforcement/i;

const READABILITY_BEFORE_COMPRESSION_CONTRACT =
  /Readability precheck[\s\S]{0,300}before compression[\s\S]{0,360}MUST NOT[\s\S]{0,220}high-density unreadable single paragraph[\s\S]{0,420}over CAP[\s\S]{0,320}increase the smallest practical cap\/headroom/i;

const CALLBACK_COMPLETION_MODE_BRANCH =
  /`completion_mode:\s*callback`[\s\S]{0,260}`completion_channel`[\s\S]{0,220}(?:real|actual)[\s\S]{0,180}required[\s\S]{0,260}register once[\s\S]{0,180}yield[\s\S]{0,260}MUST NOT[\s\S]{0,180}repeated short\/intermediate timed waits/i;

const BOUNDED_POLL_COMPLETION_MODE_BRANCH =
  /explicit no-callback runtime[\s\S]{0,260}`completion_mode:\s*bounded_poll`[\s\S]{0,220}(?:只有|只可|only)[\s\S]{0,160}bounded poll[\s\S]{0,220}MUST NOT[\s\S]{0,180}(?:fabricate|偽造|要求不存在)[\s\S]{0,160}`completion_channel`[\s\S]{0,260}`no_callback_evidence`[\s\S]{0,180}`poll_interval`[\s\S]{0,180}`maximum_attempts`[\s\S]{0,180}`hard_deadline`[\s\S]{0,260}(?:log-only|internal-only)/i;

const COMPLETION_MODE_FAIL_CLOSED_BRANCH =
  /(?:Any other|其他)[\s\S]{0,220}`completion_mode`[\s\S]{0,220}(?:missing|缺漏|mixed|混用|unclassified|未分類)[\s\S]{0,260}FAIL CLOSED/i;

const LEGACY_UNCONDITIONAL_CALLBACK_GATE =
  /briefing MUST 明列：[\s\S]{0,520}`completion_channel: runtime completion callback\/event`[\s\S]{0,520}缺任一欄即 FAIL CLOSED/i;

const FIRST_PERSISTED_ARTIFACT_CONTRACT =
  /first persisted artifact[\s\S]{0,520}(?:target file patch|failing RED test)[\s\S]{0,260}repro(?:duction)? evidence[\s\S]{0,420}`claimed_artifact_paths`[\s\S]{0,260}`first_artifact_deadline`[\s\S]{0,520}(?:skills\/rules|skills or rules)[\s\S]{0,220}(?:探索|exploration)[\s\S]{0,220}(?:milestone|plan)[\s\S]{0,260}(?:不算落盤|do not count)/i;

const DEADLINE_MISS_CONVERGENCE_CONTRACT =
  /artifact_landing_deadline_missed[\s\S]{0,420}(?:立即|immediately)[\s\S]{0,180}(?:callback|回報)[\s\S]{0,260}actual state[\s\S]{0,180}blocker[\s\S]{0,180}evidence[\s\S]{0,360}focused scope convergence\/rebrief[\s\S]{0,420}(?:MUST NOT|不得)[\s\S]{0,260}(?:停用|disable)[\s\S]{0,220}(?:後續委派|subsequent delegation)/i;

const DEADLINE_MISS_NO_AUTO_TAKEOVER_CONTRACT =
  /(?:TL takeover\/reassign|TL 接手\/重派)[\s\S]{0,420}(?:interruption evidence|中斷證據)[\s\S]{0,260}(?:user explicit|使用者明示)[\s\S]{0,360}(?:deadline miss|期限 miss)[\s\S]{0,260}(?:MUST NOT|不得)[\s\S]{0,220}(?:automatic takeover|自動接手)/i;

const ARCHITECT_DISPATCH_SCHEMA_CONTRACT =
  /\/devpro:change[\s\S]{0,260}dp-architect[\s\S]{0,320}`claimed_artifact_paths`[\s\S]{0,260}openspec\/changes\/<change>\/proposal\.md[\s\S]{0,180}openspec\/changes\/<change>\/design\.md[\s\S]{0,260}`first_artifact_deadline:\s*30m_total`[\s\S]{0,220}`writer_lease:\s*single`[\s\S]{0,260}`completion_mode:\s*callback`[\s\S]{0,260}`completion_channel:\s*runtime completion callback\/event`/i;

// Polarity-bearing architect clauses deliberately stay on one physical line.
// This prevents unrelated nearby MUST / MUST NOT tokens from preserving GREEN.
const ARCHITECT_NON_RESETTABLE_CLOCK_CONTRACT =
  /dp-architect[^\n]*(?:accepted dispatch|接受委派)[^\n]*(?:30m_total|30-minute total)[^\n]*(?:MUST NOT|不得|不可)[^\n]*(?:reset|extend|重置|延長)[^\n]*activity[^\n]*heartbeat[^\n]*status[^\n]*poll[^\n]*message[^\n]*(?:focused rebrief|focused scope convergence\/rebrief)[^\n]*(?:neither|不是|非)[^\n]*(?:idle timeout|idle-timeout)[^\n]*(?:nor|也不是|也非)[^\n]*(?:total task timeout|total-task-timeout)/i;

const ARCHITECT_VALID_EITHER_ARTIFACT_CONTRACT =
  /dp-architect[^\n]*(?:internally valid|內部有效)[^\n]*(?:proposal\.md|target proposal)[^\n]*(?:or|或)[^\n]*(?:design\.md|target design)[^\n]*(?:MUST|即可|任一)[^\n]*(?:satisfy|滿足)[^\n]*(?:first-artifact|first artifact|首檔)/i;

const ARCHITECT_MISS_SAME_WRITER_CONTRACT =
  /artifact_landing_deadline_missed[^\n]*(?:actual state callback|callback actual state|callback[^\n]*actual state)[^\n]*(?:exactly one|one focused|只送一次|恰好一次)[^\n]*(?:focused rebrief|focused scope convergence\/rebrief)[^\n]*(?:same writer|same architect|原 architect|同一 writer)[^\n]*(?:MUST NOT|不得|不可)[^\n]*(?:second writer|second-writer|第二 writer)[^\n]*(?:takeover|接手)[^\n]*(?:TL fallback|fallback)/i;

const ARCHITECT_ORDERED_TAKEOVER_CONTRACT =
  /(?:dp-architect|architect)[^\n]*(?:takeover|接手)[^\n]*(?:explicit user replacement|使用者明示 replacement)[^\n]*(?:independent(?:ly sufficient)?|獨立充分)[^\n]*(?:terminal\/interruption evidence|terminal or interruption evidence|終止\/中斷證據)[^\n]*(?:MUST|必須)[^\n]*(?:revoke|撤銷)[^\n]*(?:original writer lease|原 writer lease)[^\n]*(?:after revocation|撤銷後)[^\n]*(?:MUST|必須)[^\n]*(?:confirm|確認)[^\n]*(?:inactive|不活動)[^\n]*(?:only then|才可)[^\n]*(?:never before|不得提前|不可先)[^\n]*(?:ownership transfer|ownership-transfer|ownership-transfer record)[^\n]*(?:missing or reordered steps|缺步或換序)[^\n]*(?:MUST FAIL CLOSED|FAIL CLOSED)/i;

const ARCHITECT_READ_ONLY_REVIEWER_CONTRACT =
  /(?:independent design reviewer|獨立 design reviewer)[^\n]*(?:MAY|可)[^\n]*(?:coexist|並存)[^\n]*(?:only|僅限|只有)[^\n]*no-write[^\n]*no-claim[^\n]*(?:MUST NOT|不得|不可)[^\n]*(?:writer lease|write authority|修改|claim)/i;

// Phrases that remain in the entry leaf
const ENTRY_PHRASES = [
  {
    phrase: "Quantified Threshold Cheatsheet",
    purpose:
      "§Process 開頭速查表 heading；防後續 refactor 拆散使其消失",
  },
];

// Phrases that moved to the delegation-rules sibling (rationalize-overbundled-entry-leaves T1)
const DELEGATION_RULES_PHRASES = [
  {
    phrase: "Subagent context是runtime-native",
    purpose:
      "委派context mode依runtime-native surface判定，不再假設全部fresh",
  },
  {
    phrase: "MUST NOT一律宣稱不繼承main history",
    purpose:
      "防止retired universal fresh-context claim回流",
  },
  {
    phrase: "lineage total仍包含child input/output、handoff、duplicate read與回流",
    purpose:
      "委派成本模型保留lineage total的input/output、handoff與重讀成本",
  },
];

// Phrases that moved to the token-efficiency sibling (rationalize-overbundled-entry-leaves T1)
const TOKEN_EFFICIENCY_PHRASES = [
  {
    phrase: "Reference Pattern",
    purpose:
      "規則 (k) 委派 briefing 紀律；防後續 trim 誤刪",
  },
];

const DELEGATION_LIVENESS_ENTRY_PHRASES = [
  {
    phrase: "first_artifact_deadline",
    pattern: /^產出檔案或 diff 的委派在 spawn 前，briefing MUST 明列：.*`first_artifact_deadline`/m,
    purpose:
      "artifact-producing delegate 的 briefing 必須有首次可驗證落盤期限",
  },
  {
    phrase: "completion callback/event",
    pattern: /^TL 等待期間.*runtime 提供 completion callback\/event 時 MUST event-driven 等待/m,
    purpose:
      "TL 等待 subagent 時預設使用 runtime completion event，不做 periodic polling busy wait",
  },
];

const DELEGATION_LIVENESS_HANDOFF_PHRASES = [
  {
    phrase: "Artifact-first Delegation Liveness",
    pattern: /^### Artifact-first Delegation Liveness$/m,
    purpose:
      "多 agent SSOT 必須保留 artifact deadline、韌性與 event-driven completion 契約",
  },
  {
    phrase: "safe alternative path",
    pattern: /^Delegate 遇到第一個.*MUST NOT 立即放棄.*`safe alternative path`/m,
    purpose:
      "delegate 遇到第一個問題不得立即放棄，須先嘗試安全替代路徑",
  },
  {
    phrase: "periodic polling/list-agents busy wait",
    pattern: /^TL 等待 agent.*MUST NOT 用 `periodic polling\/list-agents busy wait`/m,
    purpose:
      "禁止以週期 polling/list-agents busy wait 取代 runtime callback",
  },
  {
    phrase: "artifact_landing_deadline_missed",
    pattern: /^若 `first_artifact_deadline` 到期.*分類為 `artifact_landing_deadline_missed`/m,
    purpose:
      "首次有效 checkpoint 逾期有穩定分類，但不製造 agent stall",
  },
  {
    phrase: "deadline miss is not verified stall",
    pattern: /^若 `first_artifact_deadline` 到期.*MUST NOT 單獨分類成 verified stall、agent unavailable、terminal failure，或授權中斷／重派／TL fallback/m,
    purpose:
      "落盤期限 miss 只記交付契約，不能繞過 interruption evidence gate",
  },
  {
    phrase: "valid checkpoint only",
    pattern: /^Delegate 遇到第一個.*不得為滿足 deadline 落下結構無效、跨 carrier 不一致或無法通過適用 strict validation 的半成品/m,
    purpose:
      "不得為展示進度或趕 deadline 製造無效 intermediate carrier",
  },
];

describe("model-delegation-contract-guard", () => {
  describe(
    "Critical phrases in entry leaf model-delegation.md",
    () => {
      for (const { phrase, purpose } of ENTRY_PHRASES) {
        it(`'${phrase}' is present in entry leaf`, async () => {
          const content = await loadFile(ruleFile("model-delegation.md"));
          assert.ok(
            content.includes(phrase),
            [
              `違規：phrase「${phrase}」在 .devpro/agent-rules/model-delegation.md 搜不到。`,
              `用途：${purpose}`,
              `本 phrase 由 add-reference-pattern-and-threshold-cheatsheet change 註冊保護；trim 或重構前必須走 amend change 並更新本測試 phrase list。`,
            ].join("\n"),
          );
        });
      }
    },
  );

  describe(
    "Critical phrases in sibling model-delegation-delegation-rules.md",
    () => {
      for (const { phrase, purpose } of DELEGATION_RULES_PHRASES) {
        it(`'${phrase}' is present in delegation-rules sibling`, async () => {
          const content = await loadFile(ruleFile("model-delegation-delegation-rules.md"));
          assert.ok(
            content.includes(phrase),
            [
              `違規：phrase「${phrase}」在 .devpro/agent-rules/model-delegation-delegation-rules.md 搜不到。`,
              `用途：${purpose}`,
              `本 phrase 由 rationalize-overbundled-entry-leaves T1 移至此 sibling；trim 或重構前必須走 amend change 並更新本測試 phrase list。`,
            ].join("\n"),
          );
        });
      }

      it("retired universal fresh-context phrases stay absent and negative matchers are live", async () => {
        const content = await loadFile(ruleFile("model-delegation-delegation-rules.md"));
        const retired = [
          /Subagents start with an independent context/,
          /do not inherit main session history/,
          /invocation input and returned output/,
        ];
        for (const pattern of retired) assert.doesNotMatch(content, pattern);
        assert.match("Subagents start with an independent context", retired[0]);
        assert.match("do not inherit main session history", retired[1]);
        assert.match("invocation input and returned output", retired[2]);
      });
    },
  );

  describe(
    "Critical phrases in sibling model-delegation-token-efficiency.md",
    () => {
      for (const { phrase, purpose } of TOKEN_EFFICIENCY_PHRASES) {
        it(`'${phrase}' is present in token-efficiency sibling`, async () => {
          const content = await loadFile(ruleFile("model-delegation-token-efficiency.md"));
          assert.ok(
            content.includes(phrase),
            [
              `違規：phrase「${phrase}」在 .devpro/agent-rules/model-delegation-token-efficiency.md 搜不到。`,
              `用途：${purpose}`,
              `本 phrase 由 rationalize-overbundled-entry-leaves T1 移至此 sibling；trim 或重構前必須走 amend change 並更新本測試 phrase list。`,
            ].join("\n"),
          );
        });
      }
    },
  );

  describe("Delegation liveness regression guards", () => {
    for (const { phrase, pattern, purpose } of DELEGATION_LIVENESS_ENTRY_PHRASES) {
      it(`'${phrase}' is present in model-delegation entry leaf`, async () => {
        const content = await loadFile(ruleFile("model-delegation.md"));
        assert.match(
          content,
          pattern,
          [
            `違規：delegation liveness anchor「${phrase}」在 model-delegation.md 搜不到。`,
            `用途：${purpose}`,
          ].join("\n"),
        );
      });
    }

    for (const { phrase, pattern, purpose } of DELEGATION_LIVENESS_HANDOFF_PHRASES) {
      it(`'${phrase}' is present in multi-agent handoff SSOT`, async () => {
        const content = await loadFile(ruleFile("multi-agent-handoff.md"));
        assert.match(
          content,
          pattern,
          [
            `違規：delegation liveness anchor「${phrase}」在 multi-agent-handoff.md 搜不到。`,
            `用途：${purpose}`,
          ].join("\n"),
        );
      });
    }
  });

  describe("Callback delivery control-plane relational guards", () => {
    const parityCases = [
      {
        label: "callback-capable runtime registers the channel, yields, and does not simulate callbacks with timed waits",
        files: ["model-delegation.md", "multi-agent-handoff.md"],
        pattern: CALLBACK_CAPABLE_WAIT_CONTRACT,
      },
      {
        label: "only meaningful transitions may become user-visible",
        files: ["model-delegation.md", "multi-agent-handoff.md"],
        pattern: MEANINGFUL_TRANSITION_CONTRACT,
      },
      {
        label: "explicit no-callback mode has bounded log-only polling",
        files: ["multi-agent-handoff.md", "model-delegation-briefing.md"],
        pattern: NO_CALLBACK_POLL_CONTRACT,
      },
      {
        label: "execution timing and callback delivery timing stay distinct",
        files: ["multi-agent-handoff.md", "model-delegation-briefing.md"],
        pattern: CALLBACK_TIMING_CONTRACT,
      },
    ];

    for (const { label, files, pattern } of parityCases) {
      for (const file of files) {
        it(`${label} in ${file}`, async () => {
          assert.ok(
            pattern.test(await loadFile(ruleFile(file))),
            `違規：${file} 缺少同一段內的 relational callback-delivery contract：${label}`,
          );
        });
      }
    }

    it("guards clock-domain arithmetic and cooperative enforcement wording", async () => {
      const handoff = await loadFile(ruleFile("multi-agent-handoff.md"));
      assert.ok(CLOCK_DOMAIN_CONTRACT.test(handoff));
      assert.ok(COOPERATIVE_GUARD_CONTRACT.test(handoff));
      assert.doesNotMatch(
        handoff,
        /callback delivery[\s\S]{0,180}runtime hard enforcement guarantee/i,
        "cooperative wording must not be upgraded into a runtime guarantee",
      );
    });

    it("requires readability before compressing a load-bearing contract", async () => {
      assert.ok(
        READABILITY_BEFORE_COMPRESSION_CONTRACT.test(
          await loadFile(ruleFile("token-frugal-io.md")),
        ),
      );
    });

    it("rejects scattered tokens, reversed polarity, and incomplete schemas", () => {
      const farApart = "x".repeat(1200);

      assert.doesNotMatch(
        `callback-capable runtime ${farApart} \`completion_mode: callback\`; \`completion_channel\` is real and required; MUST register once it then yield; MUST NOT use repeated short/intermediate timed waits such as \`wait_agent\`.`,
        CALLBACK_CAPABLE_WAIT_CONTRACT,
        "tokens outside the bounded contract window are not an operative anchor",
      );
      assert.doesNotMatch(
        "Meaningful transition gate: `wait timeout`, `no callback yet`, and unchanged poll sample are internal telemetry and MUST become user-visible progress/update; new artifact/checkpoint evidence, blocker/decision, completed/terminal.",
        MEANINGFUL_TRANSITION_CONTRACT,
        "reversed user-visible polarity must fail",
      );
      assert.doesNotMatch(
        "explicit no-callback runtime may bounded poll with `poll_interval`, `maximum_attempts`, and `hard_deadline`; poll telemetry is user-visible.",
        NO_CALLBACK_POLL_CONTRACT,
        "poll telemetry without log-only suppression must fail",
      );
      assert.doesNotMatch(
        "delegated test/long command completion schema has `started_at`, `ended_at`, `elapsed_ms`, `completed_at`, and `callback_received_at`; report execution duration and delivery delay.",
        CALLBACK_TIMING_CONTRACT,
        "timing schema without callback_delivery_latency_ms must fail",
      );
      assert.doesNotMatch(
        "Readability precheck before compression permits a high-density unreadable single paragraph when over CAP; decrease the cap.",
        READABILITY_BEFORE_COMPRESSION_CONTRACT,
        "readability wording with reversed policy must fail",
      );
    });

    describe("First persisted artifact deadline contract", () => {
      const carriers = [
        "multi-agent-handoff.md",
        "model-delegation.md",
        "model-delegation-briefing.md",
      ];

      for (const file of carriers) {
        it(`defines qualifying and non-qualifying first persisted artifacts in ${file}`, async () => {
          assert.match(await loadFile(ruleFile(file)), FIRST_PERSISTED_ARTIFACT_CONTRACT);
        });

        it(`requires deadline-miss callback convergence without disabling delegation in ${file}`, async () => {
          assert.match(await loadFile(ruleFile(file)), DEADLINE_MISS_CONVERGENCE_CONTRACT);
        });

        it(`forbids automatic takeover on a deadline miss in ${file}`, async () => {
          assert.match(await loadFile(ruleFile(file)), DEADLINE_MISS_NO_AUTO_TAKEOVER_CONTRACT);
        });
      }

      it("rejects mutations that count planning as an artifact or auto-authorize takeover", () => {
        const validArtifact = "first persisted artifact may be a target file patch, failing RED test, or repro evidence; bind it to `claimed_artifact_paths` and `first_artifact_deadline`; loading skills/rules, exploration, milestone, and plan do not count.";
        const validTakeover = "TL takeover/reassign requires interruption evidence or user explicit direction; a deadline miss MUST NOT authorize automatic takeover.";

        assert.match(validArtifact, FIRST_PERSISTED_ARTIFACT_CONTRACT);
        assert.doesNotMatch(
          validArtifact.replace("do not count", "count as persisted artifacts"),
          FIRST_PERSISTED_ARTIFACT_CONTRACT,
        );
        assert.match(validTakeover, DEADLINE_MISS_NO_AUTO_TAKEOVER_CONTRACT);
        assert.doesNotMatch(
          validTakeover.replace("MUST NOT authorize", "authorizes"),
          DEADLINE_MISS_NO_AUTO_TAKEOVER_CONTRACT,
        );
      });
    });

    describe("Completion-mode branch contract", () => {
      const branchCarriers = [
        "model-delegation.md",
        "model-delegation-briefing.md",
        "multi-agent-handoff.md",
      ];

      for (const file of branchCarriers) {
        it(`requires the callback branch schema in ${file}`, async () => {
          assert.ok(
            CALLBACK_COMPLETION_MODE_BRANCH.test(await loadFile(ruleFile(file))),
            `違規：${file} 缺少 completion_mode: callback 的 real channel/register-once/yield/no-timed-wait 關聯契約`,
          );
        });

        it(`requires the bounded-poll branch schema in ${file}`, async () => {
          assert.ok(
            BOUNDED_POLL_COMPLETION_MODE_BRANCH.test(
              await loadFile(ruleFile(file)),
            ),
            `違規：${file} 缺少 completion_mode: bounded_poll 的 no-channel evidence/bounds/telemetry 關聯契約`,
          );
        });

        it(`fails closed for missing, mixed, or unclassified completion modes in ${file}`, async () => {
          assert.ok(
            COMPLETION_MODE_FAIL_CLOSED_BRANCH.test(
              await loadFile(ruleFile(file)),
            ),
            `違規：${file} 未對未分類或混用 completion_mode FAIL CLOSED`,
          );
        });
      }

      it("does not block a bounded-poll briefing with the legacy unconditional callback gate", async () => {
        const entry = await loadFile(ruleFile("model-delegation.md"));
        const briefing = await loadFile(ruleFile("model-delegation-briefing.md"));

        assert.doesNotMatch(entry, LEGACY_UNCONDITIONAL_CALLBACK_GATE);
        assert.match(briefing, BOUNDED_POLL_COMPLETION_MODE_BRANCH);
      });

      it("rejects callback-without-channel, fake-channel bounded poll, and incomplete bounded schema", () => {
        assert.doesNotMatch(
          "`completion_mode: callback` is required; register once, yield, and MUST NOT use repeated short/intermediate timed waits.",
          CALLBACK_COMPLETION_MODE_BRANCH,
          "callback mode without a real completion_channel must fail",
        );
        assert.doesNotMatch(
          "explicit no-callback runtime uses `completion_mode: bounded_poll`; only bounded poll; fabricate `completion_channel: fake`; require `no_callback_evidence`, `poll_interval`, `maximum_attempts`, `hard_deadline`; telemetry is log-only.",
          BOUNDED_POLL_COMPLETION_MODE_BRANCH,
          "bounded_poll with a fabricated callback channel must fail",
        );
        assert.doesNotMatch(
          "explicit no-callback runtime uses `completion_mode: bounded_poll`; only bounded poll; MUST NOT fabricate `completion_channel`; require `no_callback_evidence`, `poll_interval`, and `maximum_attempts`; telemetry is internal-only.",
          BOUNDED_POLL_COMPLETION_MODE_BRANCH,
          "bounded_poll without hard_deadline must fail",
        );
      });
    });

    describe("dp-architect single-writer first-artifact contract", () => {
      it("requires /devpro:change to carry exact proposal/design paths, 30m_total, one writer lease, and callback channel", async () => {
        assert.match(
          await loadFile(ruleFile("model-delegation.md")),
          ARCHITECT_DISPATCH_SCHEMA_CONTRACT,
          "違規：model-delegation.md 缺少 dp-architect immutable dispatch schema（exact proposal/design paths + 30m_total + single lease + callback channel）",
        );
      });

      // The briefing leaf is loaded from model-delegation.md, which already carries the schema, so
      // the briefing keeps one routing line instead of a second copy.
      it("routes the dp-architect dispatch contract from the briefing to its carriers without restating it", async () => {
        const briefing = await loadFile(ruleFile("model-delegation-briefing.md"));
        assert.match(
          briefing,
          /^\*\*dp-architect immutable dispatch\*\*：[^\n]*`30m_total`[^\n]*`model-delegation\.md`[^\n]*\*\*dp-architect dispatch action point\*\*[^\n]*independent design reviewer[^\n]*`multi-agent-handoff\.md` §Artifact-first Delegation Liveness/m,
        );
        assert.doesNotMatch(briefing, ARCHITECT_DISPATCH_SCHEMA_CONTRACT);
        assert.doesNotMatch(briefing, ARCHITECT_NON_RESETTABLE_CLOCK_CONTRACT);
      });

      it("locks accepted-dispatch total elapsed time against every reset signal and timeout reinterpretation", async () => {
        assert.match(
          await loadFile(ruleFile("model-delegation.md")),
          ARCHITECT_NON_RESETTABLE_CLOCK_CONTRACT,
        );
      });

      it("accepts either internally valid proposal.md or design.md as the architect first artifact", async () => {
        assert.match(
          await loadFile(ruleFile("model-delegation.md")),
          ARCHITECT_VALID_EITHER_ARTIFACT_CONTRACT,
        );
      });

      it("keeps a deadline miss with the same writer and forbids second-writer, takeover, and fallback authority", async () => {
        assert.match(
          await loadFile(ruleFile("multi-agent-handoff.md")),
          ARCHITECT_MISS_SAME_WRITER_CONTRACT,
        );
      });

      it("orders takeover authorization, original-lease revocation/inactivity, and ownership transfer", async () => {
        assert.match(
          await loadFile(ruleFile("multi-agent-handoff.md")),
          ARCHITECT_ORDERED_TAKEOVER_CONTRACT,
        );
      });

      it("allows an independent design reviewer only with explicit no-write/no-claim authority", async () => {
        assert.match(
          await loadFile(ruleFile("multi-agent-handoff.md")),
          ARCHITECT_READ_ONLY_REVIEWER_CONTRACT,
        );
      });

      it("rejects reset, auto-takeover, reversed transfer, and reviewer-write mutations", () => {
        const validClock = "dp-architect accepted dispatch starts `30m_total` and MUST NOT reset or extend for activity, heartbeat, status, poll, message, or focused rebrief; it is neither an idle timeout nor a total task timeout.";
        const validMiss = "`artifact_landing_deadline_missed` requires actual state callback and exactly one focused rebrief to the same writer; it MUST NOT authorize a second writer, takeover, or TL fallback.";
        const validTakeover = "A dp-architect takeover requires authorization from explicit user replacement or independently sufficient terminal/interruption evidence; the takeover MUST then revoke the original writer lease; after revocation it MUST confirm the original writer inactive; only then, and never before, may it create the ownership-transfer record. Missing or reordered steps MUST FAIL CLOSED.";
        const validReviewer = "An independent design reviewer MAY coexist only with explicit no-write/no-claim and MUST NOT acquire a writer lease.";

        assert.match(validClock, ARCHITECT_NON_RESETTABLE_CLOCK_CONTRACT);
        assert.doesNotMatch(
          validClock.replace("MUST NOT reset or extend", "MAY reset or extend"),
          ARCHITECT_NON_RESETTABLE_CLOCK_CONTRACT,
          "activity must never reset or extend 30m_total",
        );
        assert.match(validMiss, ARCHITECT_MISS_SAME_WRITER_CONTRACT);
        assert.doesNotMatch(
          validMiss.replace("MUST NOT authorize", "authorizes"),
          ARCHITECT_MISS_SAME_WRITER_CONTRACT,
          "a miss must not create second-writer/takeover/fallback authority",
        );
        assert.match(validTakeover, ARCHITECT_ORDERED_TAKEOVER_CONTRACT);
        assert.doesNotMatch(
          "dp-architect takeover creates ownership-transfer first, then explicit user replacement or independently sufficient terminal/interruption evidence, revoke the original writer lease and confirm it inactive.",
          ARCHITECT_ORDERED_TAKEOVER_CONTRACT,
          "ownership transfer before authorization/revocation must fail",
        );
        assert.doesNotMatch(
          validTakeover.replace("after revocation it MUST confirm", "before revocation it MUST confirm"),
          ARCHITECT_ORDERED_TAKEOVER_CONTRACT,
          "writer inactivity must be confirmed after lease revocation",
        );
        assert.doesNotMatch(
          validTakeover.replace("Missing or reordered steps MUST FAIL CLOSED.", "Missing steps may continue."),
          ARCHITECT_ORDERED_TAKEOVER_CONTRACT,
          "missing or reordered takeover steps must fail closed",
        );
        assert.match(validReviewer, ARCHITECT_READ_ONLY_REVIEWER_CONTRACT);
        assert.doesNotMatch(
          validReviewer.replace("MUST NOT acquire", "MAY acquire"),
          ARCHITECT_READ_ONLY_REVIEWER_CONTRACT,
          "reviewer write ownership must fail",
        );
      });
    });
  });
});
