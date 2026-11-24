/**
 * Prove-it for fix-cross-review-visibility R1+R2+R4 (skill/projection carriers).
 * Formal path = durable runner + runtime-native background; host timing honesty;
 * scope_summary 4096-byte / ~1,365 CJK feed-forward.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SCOPE_SUMMARY_MAX_BYTES } from "../validate-second-review-packet.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const skill = readFileSync(
  path.join(REPO_ROOT, ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md"),
  "utf8"
);
const runner = readFileSync(
  path.join(REPO_ROOT, ".devpro/scripts/run-second-reviewer-projection.mjs"),
  "utf8"
);
const prePrDispatch = readFileSync(
  path.join(REPO_ROOT, ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md"),
  "utf8"
);
const crossReviewSkill = readFileSync(
  path.join(REPO_ROOT, ".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md"),
  "utf8"
);
const claudeAdapter = readFileSync(
  path.join(REPO_ROOT, ".devpro/agent-rules/platform-adapters/claude-code-cross-review.md"),
  "utf8"
);
const projections = {
  cursor: readFileSync(path.join(REPO_ROOT, ".cursor/agents/dp-second-reviewer.md"), "utf8"),
  claude: readFileSync(path.join(REPO_ROOT, ".claude/agents/dp-second-reviewer.md"), "utf8"),
  codex: readFileSync(path.join(REPO_ROOT, ".codex/agents/dp-second-reviewer.toml"), "utf8"),
};

describe("R1 formal path = durable runner + runtime-native background", () => {
  it("skill names formal path as run-second-reviewer-projection with runtime-native background / block_until_ms: 0", () => {
    assert.match(skill, /formal path/i);
    assert.match(skill, /run-second-reviewer-projection/);
    assert.match(skill, /runtime-native background/i);
    assert.match(skill, /block_until_ms:\s*0|block_until_ms`:\s*`0/);
  });

  it("skill forbids Task/subagent as pr-sticky formal path", () => {
    assert.match(
      skill,
      /MUST NOT[\s\S]{0,200}(Task|subagent)[\s\S]{0,200}formal path|formal path[\s\S]{0,200}MUST NOT[\s\S]{0,200}(Task|subagent)/i
    );
  });

  it("Claude Code dispatch carriers keep the TL-owned formal path ahead of the short-timeout proxy", () => {
    const prePrStart = prePrDispatch.indexOf("## Step 5.5.3:");
    const crossReviewStart = crossReviewSkill.indexOf("### 4. Dispatch reviewer（adapter-specific）");
    const claudeProxyStart = crossReviewSkill.indexOf("Claude Code host 委派格式");
    const codexStart = crossReviewSkill.indexOf("Codex host 委派格式");
    assert.ok(prePrStart >= 0, "pre-PR Step 5.5.3 dispatch reference must exist");
    assert.ok(crossReviewStart >= 0 && claudeProxyStart > crossReviewStart && codexStart > claudeProxyStart,
      "Claude-host handoff must remain bounded before the Codex-host section");
    const prePrStep = prePrDispatch.slice(prePrStart);
    const crossReviewClaudePath = crossReviewSkill.slice(crossReviewStart, codexStart);

    for (const [label, body] of [
      ["pre-PR dispatch reference", prePrStep],
      ["cross-review Claude-host section", crossReviewClaudePath],
    ]) {
      assert.match(body, /formal path[\s\S]{0,100}TL|正式路徑由 TL/i, `${label}: formal path is TL-owned`);
      assert.match(body, /projection_runner_command/);
      assert.match(body, /runtime-native background/);
      assert.match(body, /10m[\s\S]{0,180}30m|30m[\s\S]{0,180}10m/);
      assert.match(body, /optional proxy|非預設 proxy/i);
      assert.match(body, /30m[\s\S]{0,220}(optional proxy|非預設 proxy)|(optional proxy|非預設 proxy)[\s\S]{0,220}30m/i);
      assert.match(body, /active wrapper has timeout evidence at least equal to the runner's 30m hard cap|active wrapper.*可查 timeout 證據.*30m hard cap/i,
        `${label}: proxy timeout evidence must cover the runner hard cap`);
      assert.match(body, /retain the return gate through terminal events|持有 return gate 至 terminal events/i,
        `${label}: eligible proxy must own the return gate through terminal events`);
      assert.match(body, /Stop before launch only when neither the formal route nor a qualified proxy is available|只有正式路徑不可用且 proxy 不符合資格時，才在 launch 前停止/i,
        `${label}: stop only when the formal route and proxy are both unavailable`);
      assert.doesNotMatch(body, /If the host cannot provide that durable path, stop before launching the runner/i,
        `${label}: unavailable formal path alone must not reject an eligible proxy`);
      assert.doesNotMatch(body, /若沒有可存活至終態的 TL-owned background，必須在 launch 前停下/,
        `${label}: reject the prior unconditional-stop wording in the Chinese carrier`);
    }

    assert.match(prePrStep, /MUST NOT use the `Agent\(\{\.\.\.\}\)` example below as the default/);
    assert.match(crossReviewClaudePath, /MUST NOT dispatch `dp-second-reviewer`/);
    assert.match(claudeAdapter, /Claude Code host runner carrier[\s\S]{0,350}pr-sticky formal path[\s\S]{0,600}runtime-native background/);
  });

  it("skill forbids foreground nohup& as durable (survival-past-parent-exit)", () => {
    assert.match(skill, /survival-past-parent-exit|survive past parent/i);
    assert.match(skill, /nohup/);
    assert.doesNotMatch(
      skill,
      /formal path[\s\S]{0,300}nohup[\s\S]{0,80}&[\s\S]{0,80}(SHOULD|durable default)/i
    );
  });

  for (const [host, body] of Object.entries(projections)) {
    it(`${host} projection thin-pointers formal = durable runner + host-native background`, () => {
      assert.match(body, /run-second-reviewer-projection|durable runner/i);
      assert.match(body, /runtime-native background|host-native background|block_until_ms:\s*0/i);
      assert.match(body, /formal/i);
    });
  }
});

describe("R2 host timing honesty; runner constants unchanged", () => {
  it("skill names host foreground ~10min kill", () => {
    assert.match(skill, /~?10\s*min|10min|約\s*10\s*min/i);
    assert.match(skill, /foreground|前景/i);
  });

  it("skill claims 15m/30m only for durable/background path", () => {
    assert.match(skill, /15m/);
    assert.match(skill, /30m/);
    assert.match(skill, /durable[\s\S]{0,120}(15m|30m)|(15m|30m)[\s\S]{0,120}durable/i);
  });

  it("runner defaultTotalTimeoutMs / defaultStatusCheckpointMs stay 30m / 15m", () => {
    assert.match(runner, /const defaultStatusCheckpointMs = 15 \* 60 \* 1000/);
    assert.match(runner, /const defaultTotalTimeoutMs = 30 \* 60 \* 1000/);
  });
});

describe("R4 scope_summary feed-forward before render", () => {
  it("Skill names the scope_summary byte and CJK feed-forward: 4096 bytes / ~1,365 CJK before render", () => {
    assert.match(skill, /4096/);
    assert.match(skill, /1,365/);
    assert.match(skill, /CJK|中文/);
    assert.match(skill, /scope_summary[\s\S]{0,400}4096|4096[\s\S]{0,400}scope_summary/i);
    assert.doesNotMatch(skill, /(?<![\d#,])340(?![\d,])/, "the old CJK estimate must not linger");
    assert.doesNotMatch(skill, /maxBytes 仍為 1024/, "the old validator limit must not linger");
  });
});

describe("R4 scope_summary prose carriers follow SCOPE_SUMMARY_MAX_BYTES", () => {
  // The evidence section limit is a different constant (SECOND_REVIEW_EVIDENCE_NARRATIVE_MAX_BYTES), so every phrase carries its own scope_summary context
  // and the numbers come from the imported constant, never from a literal in this test.
  const max = SCOPE_SUMMARY_MAX_BYTES;
  const cjk = Math.floor(max / 3).toLocaleString("en-US");
  const carriers = [
    // The builder refusal note moved verbatim from code-review-cross-model.md to this sibling.
    [".devpro/agent-rules/code-review-cross-model-dispatch-mechanics.md", [`\`scope_summary\` ${max}-byte limit`]],
    [".devpro/agent-rules/proposal-template.md", [`\`scope_summary\`，上限 ≤${max} UTF-8 bytes（約 ${cjk} 個中日文字`]],
    [".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md", [`第二意見 \`scope_summary\`（≤${max} UTF-8 bytes`]],
    [
      ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
      [
        `\`scope_summary\` feed-forward（before render）：UTF-8 max **${max}** bytes（約 **~${cjk}** CJK`,
        `Validator \`maxBytes\` 同為 ${max}（見`,
      ],
    ],
  ];

  for (const [relPath, phrases] of carriers) {
    it(`${relPath} states the scope_summary limit the validator enforces`, () => {
      const text = readFileSync(path.join(REPO_ROOT, relPath), "utf8");
      for (const phrase of phrases) {
        assert.ok(
          text.includes(phrase),
          `${relPath} must state "${phrase}" (SCOPE_SUMMARY_MAX_BYTES=${max}); update the prose when the constant changes`
        );
      }
    });
  }
});
