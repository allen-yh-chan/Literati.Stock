/**
 * strengthen-clarify-operator-usage-grep.test.mjs
 *
 * Prove-it / wording lock for #2226 lineage (plain-language card replacement):
 * pre-analyst MUST synthesize a five-field plain-language card and get
 * confirm-or-edit before a packaged default;
 * user-story field MUST carry who/state/trigger (no tautology);
 * greenfield MUST NOT invent last-real-episode options;
 * immutable-after-create identity MUST regenerate vs Create (not {source}.copy);
 * devpro:clarify MUST NOT transplant US/UC/grill-me as elicitation (confirmation shape OK).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sourcePath } from "./lib/source-root.mjs";

const AMB_PATH = ".devpro/agent-rules/ambiguity-scoring.md";
const PROP_PATH = ".devpro/agent-rules/proposal-template.md";
const SKILL_PATH = ".devpro/agent-skills/devpro-workflows/clarify/SKILL.md";
const STOP_PATH = ".devpro/agent-rules/stop-point-comms.md";

const amb = readFileSync(sourcePath(AMB_PATH), "utf8");
const prop = readFileSync(sourcePath(PROP_PATH), "utf8");
const skill = readFileSync(sourcePath(SKILL_PATH), "utf8");
const stop = readFileSync(sourcePath(STOP_PATH), "utf8");

function extractUsageProbe(md) {
  const block = md.match(
    /### Operator usage probe before packaged default[\s\S]*?(?=\n### |\n## )/,
  );
  assert.ok(block, `${AMB_PATH}: ### Operator usage probe before packaged default missing`);
  return block[0];
}

test("ambiguity-scoring.md locks plain-language card confirm-or-edit gate", () => {
  const section = extractUsageProbe(amb);
  assert.match(section, /operator-usage-before-packaged-default/);
  assert.match(section, /plain-language-card-before-first-implementation-write/);
  assert.match(section, /使用者故事/);
  assert.match(section, /做成後你會看到/);
  assert.match(section, /不該被整包丟掉的/);
  assert.match(section, /請確認或改/);
  assert.match(section, /MUST[^\n]*packaged default/);
  assert.match(section, /MUST[^\n]*dp-analyst/);
  assert.match(section, /確認（含改寫後再確認）前/);
  assert.match(section, /與五欄是否已合成齊全|與是否尚無 `UNRESOLVED:`|無關/);
  assert.match(section, /等待使用者回覆/);
  assert.match(section, /UNRESOLVED:/);
  assert.doesNotMatch(section, /MUST wait until that probe is answered/);
  assert.match(section, /誰/);
  assert.match(section, /什麼狀態|狀態/);
  assert.match(section, /什麼觸發|觸發/);
  assert.match(section, /同義反覆/);
  assert.match(section, /greenfield|尚無該能力/);
  assert.match(section, /捏造/);
  assert.match(section, /last real episode|current workaround|上次真實|現況繞法/);
  assert.match(section, /immutable after create|建立後不可變/);
  assert.match(section, /create path|Create 路徑|對齊 Create|與.*Create/);
  assert.match(section, /\{source\}\.copy/);
  assert.match(section, /regenerate/);
  assert.match(section, /空泛|「使用者／有人會用」/);
  assert.match(section, /卡確認後寫回|五欄全部/);
  assert.match(section, /provenance: user/);
  assert.match(section, /禁只留/);
});

test("proposal-template.md pointer names plain-language card (Seams schema unchanged)", () => {
  assert.match(prop, /operator-usage-before-packaged-default/);
  assert.match(prop, /白話卡|plain-language card|請確認或改/);
  assert.match(prop, /observable done-when is not a substitute for operator usage/);
  assert.match(prop, /dp-analyst/);
  assert.match(prop, /五欄全部|decisions:/);
  assert.doesNotMatch(
    prop.match(/operator-usage-before-packaged-default[^\n]*/)?.[0] ?? "",
    /MUST wait until that probe is answered/,
  );
  assert.match(prop, /\{source\}\.copy/);
  assert.match(prop, /regenerate/);
});

test("canonical openspec-flow spec locks card gate and #2226 identity rules", () => {
  const spec = readFileSync(sourcePath("openspec/specs/openspec-flow/spec.md"), "utf8");
  assert.match(spec, /### Requirement: Operator Usage Probe Before Packaged Defaults/);
  assert.match(spec, /plain-language card|confirm-or-edit|請確認或改/);
  assert.match(spec, /who.*state.*trigger|who \/ state \/ trigger|使用者故事/);
  assert.match(spec, /greenfield|MUST NOT invent/);
  assert.match(spec, /last real episode|current workaround/);
  assert.match(spec, /\{source\}\.copy/);
  assert.match(spec, /regenerate/);
  assert.match(spec, /MUST NOT presuppose the operator already does the thing being clarified|tautolog/);
  assert.match(spec, /before dispatching `dp-analyst`|before.*dp-analyst/i);
  assert.match(spec, /independently of|regardless of whether.*UNRESOLVED|even when no UNRESOLVED/i);
  assert.match(spec, /all five confirmed fields|五欄全部|Clarification State `decisions:`|Clarification `decisions:`/);
  assert.doesNotMatch(
    spec.match(
      /### Requirement: Operator Usage Probe Before Packaged Defaults[\s\S]*?(?=\n### Requirement:)/,
    )?.[0] ?? "",
    /MUST wait until that probe is answered/,
  );
});

test("devpro:clarify skill pointers card confirmation and forbids US elicitation", () => {
  assert.match(skill, /operator-usage-before-packaged-default/);
  assert.match(skill, /白話卡|plain-language card|請確認或改|confirmation/);
  assert.doesNotMatch(skill, /MUST wait until that probe is answered/);
  assert.match(skill, /\{source\}\.copy/);
  assert.match(skill, /MUST NOT[\s\S]{0,120}移植 grill-me|elicitation/);
  assert.match(skill, /confirmation|產物形狀|白話卡形狀/);
  assert.match(skill, /確認（含改寫後再確認）前/);
  assert.match(skill, /五欄全部/);
  assert.match(skill, /provenance: user/);
  const affirmative = skill
    .split("\n")
    .filter((l) => !/MUST NOT|禁|不做|移植|Avoid|_Avoid_|允|允許|confirmation|產物形狀/i.test(l))
    .join("\n");
  assert.doesNotMatch(affirmative, /\bUser Story\b/);
  assert.doesNotMatch(affirmative, /\bUse Case\b/);
});

test("stop-point-comms rule 5 includes plain-language card and auth/requirement partition", () => {
  assert.match(stop, /白話卡|請確認或改/);
  assert.match(stop, /授權|batch|git/);
  assert.match(stop, /分區|需求卡/);
  assert.match(stop, /第零步與授權題同則分區/);
});
