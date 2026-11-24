import { test } from "node:test";
import assert from "node:assert/strict";
import { LINKED_ISSUE_CONTEXTS } from "../second-review-material-contract.mjs";
import {
  CLAUDE_REVIEWER_SYSTEM_PROMPT,
  canonicalReviewerCliRecipe,
} from "../second-reviewer-cli-recipe-contract.mjs";
import {
  externalEvaluatorPacketStaticPrefix,
  secondReviewPacketStaticPrefix,
  stickyWriteDispositionLines,
} from "../validate-second-review-packet.mjs";
import { repoPath } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";


// Guard 強度邊界（`rule-anchor-guard-strength.md`）
// ------------------------------------------------------------------
// `linked_issue_context` 是 mode token 而非 content 欄位。本檔**不**以可自由改寫的散文措辭當
// anchor——那正是前一版的失效模式：它把 `issue number/title/state/body` 釘死五處，於是措辭正確與否
// 與它無關，只確保措辭不變，反而把錯誤鎖住。判準是「改寫這句話會不會讓 guard 誤紅」，不是
// 「這串字看起來像不像自然語言」：本檔僅存的三個字串 anchor（`mode token`、`orchestration fault`、
// `hand-typed or guessed`）都是被 spec／runtime 釘住的**契約術語**，改動它們本來就該轉紅。
// 改為 docs↔runtime parity：token 集合的唯一定義
// 點是 `second-review-material-contract.mjs` 的 `LINKED_ISSUE_CONTEXTS`，carrier 必須跟著它
// 走；route How 的 SSOT 是 `openspec/specs/cross-runtime-parity/spec.md` →
// `Requirement: External Reviewer Linked Issue Route`。
//
// 正向斷言一律寫成吃注入 body 的純函式，好讓檔尾的 mutation 審計 meta-test 在記憶體中逐行
// 刪除、重跑全部正向斷言（§驗證方法）。審計範圍是本 change 觸及的 carrier set，不含既有
// route SSOT spec 的 guard。
//
// Carrier 覆蓋分界（新增 carrier 前先讀）：positive 側只加在**列舉**值集合的 carrier，即下方
// 6 條 mode-token 宣告行；**委派**值集合的 carrier 只走 forbidden 單側。兩個 canonical spec 寫的
// 是「exactly the values accepted by the canonical reviewer CLI recipe contract」，CLI leaf 只指
// route SSOT——它們沒有可落後的枚舉，硬加 positive 斷言等於逼它們把值抄回文件，反而**新增**一個
// 漂移源。判準是「這個 carrier 列舉還是委派」，不是「它是不是 carrier」。
//
// 委派側**仍須**進 forbidden 集合：本 change 的 pre-PR walkthrough 實測，`cli-invocation.md`
// 這類只指 SSOT 的委派 carrier 一樣復活了「未內嵌才授權 issue view」的條件式措辭，而它當時
// 不在任何 forbidden 集合裡。forbidden 覆蓋面因此以「是不是 carrier」為準，比 positive 寬。


// Spec 側一律只讀 **canonical**。前一版把 active delta 與 `openspec/changes/archive/` union 進
// 取材面，於是 archive（不可變歷史）成為 token 供給源：實測本 change 自己的 archived delta 單獨
// 就滿足下方兩條 spec 斷言的全部片語，canonical 即使被清空也不會轉紅——正是本檔 forbidden 側
// 註解早已論證過的失效模式，只是當時沒套用到 positive 側。canonical-only 同時解除對
// `changeName` 的歷史耦合（該常數隨 union helper 一併移除）。
function readSpec(capability) {
  return read(`openspec/specs/${capability}/spec.md`);
}

function assertIncludes(body, phrases) {
  for (const phrase of phrases) {
    assert.ok(body.includes(phrase), `missing phrase: ${phrase}`);
  }
}

function assertExcludes(body, phrases) {
  for (const phrase of phrases) {
    assert.ok(!body.includes(phrase), `unexpected phrase: ${phrase}`);
  }
}

// §錨點作用域守則 1：取材邊界有界且唯一；任一 marker 缺席即 fail closed，不得靜默略過或
// 指向錯誤位置（否則刪掉 marker 行反而全綠）。
function sliceSection(body, label, startMarker, endMarker) {
  const start = body.indexOf(startMarker);
  assert.notEqual(start, -1, `${label}: missing start marker ${JSON.stringify(startMarker)}`);
  const end = body.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${label}: missing end marker ${JSON.stringify(endMarker)}`);
  return body.slice(start, end);
}

function extractRequirementProse(body, title) {
  const marker = `### Requirement: ${title}`;
  const start = body.indexOf(marker);
  assert.notEqual(start, -1, `missing requirement: ${title}`);
  const scenario = body.indexOf("\n#### Scenario:", start + marker.length);
  assert.notEqual(scenario, -1, `missing scenario boundary for requirement: ${title}`);
  return body.slice(start, scenario);
}

// 宣告 `linked_issue_context` 契約的 carrier（bounded、具名；不掃全樹，故本 change 自身的
// proposal/design/tasks 這類「描述缺陷」的文件不會誤觸 forbidden 側）。值為該檔預期的
// mode-token 宣告行數——`cross-review/SKILL.md` 有兩份 host 投影，故為 2。
const CLI_CONTRACT = ".devpro/agent-rules/code-review-cross-model-cli-contract.md";
const MODE_TOKEN_DECLARATION_LINES = {
  ".claude/agents/dp-second-reviewer.md": 1,
  ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md": 1,
  ".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md": 2,
  ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md": 1,
  ".devpro/agent-rules/platform-adapters/codex-host-cross-review.md": 1,
  ".devpro/agent-rules/platform-adapters/claude-code-cross-review.md": 1,
};
const MODE_TOKEN_CARRIERS = Object.keys(MODE_TOKEN_DECLARATION_LINES);
const AUDIT_FILES = [...MODE_TOKEN_CARRIERS, CLI_CONTRACT];

// 委派值集合的 carrier：不進 positive 側（無枚舉可落後），但 forbidden 側必須涵蓋。
const DELEGATING_CARRIERS = [
  CLI_CONTRACT,
  ".devpro/agent-skills/devpro-reviews/cross-review/references/cli-invocation.md",
];
const EMBED_FORBIDDEN_CARRIERS = [...MODE_TOKEN_CARRIERS, ...DELEGATING_CARRIERS];

// 同一 template 的三份手工投影（§錨點作用域守則 4：同契約多投影集合相等）。既有
// `cross-review-cli-skills-grep.test.mjs` 的 `auditHostNeutralFieldSet()` 只鎖欄位**名稱**
// 層；本檔補的是冒號後的**值**層。
const TEMPLATE_PROJECTION_LINES = {
  ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md": 1,
  ".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md": 2,
};

// 短字面（`none`）是 typed enum 值、不可改措辭 → MUST 走 token-boundary matcher（§守則 2/3）；
// 裸 `includes("none")` 會被任意子字串汙染。CJK 相鄰時 `\b` 不可靠，故用 lookaround。
function tokenBoundaryRegex(token) {
  return new RegExp(`(?<![\\w-])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
}

// Forbidden 側：具邊界形式，不退回寬鬆 includes。三個 marker 都對 issue 特化，避免與正當的
// `embedded-diff` review-material carrier 相撞。
const LEGACY_EMBED_LITERAL = "issue number/title/state/body";
const EMBED_PERMISSION_RE =
  /embed(?:ded|s)?\s+(?:the\s+)?(?:linked\s+)?issue\s+(?:number|title|state|body|content)/i;

// 上面那條要求 embed 語詞在 issue 之前，抓不到**條件句**語序（`issue body is not embedded`、
// `linked-issue content is not embedded`、`未內嵌 issue body`）——本 change 的 pre-PR walkthrough
// 實測 4 處殘留全屬此類，前一版 guard 全數放行。改抓語序無關的形式：既然授權條件的唯一合法
// 判準是 mode token，任何把 `gh issue view` 授權與「是否內嵌」寫在**同一物理行**的措辭都禁止。
const ISSUE_VIEW_AUTHORIZATION = "gh issue view";
const EMBED_WORD_RE = /embed(?:ded|ding|s)?|內嵌/i;
// `embedded-diff`、`embedded-complete-diff-v1`、`scope-bound-embedded-complete-diff-v1` 是
// review-material carrier/capability 的**值 token**，不是「以是否內嵌為條件」的措辭；比對前先
// 剝除，否則 forbidden 側會誤傷正當行。剝除只吃帶後綴連字號的複合 token，裸 `embedded` 不受影響。
const REVIEW_MATERIAL_EMBED_TOKEN_RE = /[\w-]*embedded-[\w-]+/gi;

function conditionsIssueViewOnEmbedding(line) {
  if (!line.includes(ISSUE_VIEW_AUTHORIZATION)) return false;
  return EMBED_WORD_RE.test(line.replace(REVIEW_MATERIAL_EMBED_TOKEN_RE, ""));
}

// 宣告行的值集合抽取。前一版用 `LINKED_ISSUE_CONTEXTS.every(...)` 只做**超集**檢查：宣告行多列
// 一個 runtime 會拒絕的第三值照樣匹配，docs ⊆ runtime 這一側毫無機械保證（deletion-only 的
// mutation 審計也抓不到插入）。改為解析列舉 run 再與 canonical 做**集合相等**，兩側同時鎖住。
// 原子只吃 lowercase identifier（可帶反引號），分隔符取三種實際存在的寫法。
const DECLARATION_ATOM = "`?[a-z][a-z0-9_]*`?";
const DECLARATION_SEPARATOR = "\\s*(?:OR|or|/|或)\\s*";

function declaredTokenRuns(line) {
  const runs =
    line.match(new RegExp(`${DECLARATION_ATOM}(?:${DECLARATION_SEPARATOR}${DECLARATION_ATOM})+`, "g")) ?? [];
  return runs
    .map((run) => run.split(new RegExp(DECLARATION_SEPARATOR)).map((atom) => atom.replace(/`/g, "")))
    // 只認與 canonical 有交集的 run：同一物理行上的 `stdout/stderr`、`PR title/body/comments`
    // 這類無關列舉不得被誤讀成值集合（`claude-code-cross-review.md` 的宣告行即為整段散文）。
    .filter((atoms) => atoms.some((atom) => LINKED_ISSUE_CONTEXTS.includes(atom)));
}

function declaresExactTokenSet(line) {
  const runs = declaredTokenRuns(line);
  // 值集合的載體必須唯一：同一行出現多個與 canonical 交集的列舉即無法判定何者為準（§守則 1）。
  if (runs.length !== 1) return false;
  const declared = new Set(runs[0]);
  return (
    declared.size === runs[0].length &&
    declared.size === LINKED_ISSUE_CONTEXTS.length &&
    LINKED_ISSUE_CONTEXTS.every((token) => declared.has(token))
  );
}

// mode-token 宣告行 = 同一物理行同時帶欄位名、`mode token` 定性、以及**恰好** runtime 的
// canonical token 集合。整檔存在性會被同檔其他提及代償（該 token 在 skill 散文裡另有出現），
// 故錨到宣告行本身。
function modeTokenDeclarationLines(body) {
  return body
    .split("\n")
    .filter(
      (line) =>
        line.includes("linked_issue_context") && line.includes("mode token") && declaresExactTokenSet(line),
    );
}

function assertModeTokenDeclaration(relPath, body) {
  assert.ok(LINKED_ISSUE_CONTEXTS.length >= 2, "canonical token set must not be empty");
  const declarations = modeTokenDeclarationLines(body);
  // docs ↔ runtime 雙向：runtime 擴充／改名而 carrier 沒跟（漏列），或 carrier 宣傳一個 runtime
  // 會拒絕的值（插入），宣告行都不再匹配，這裡具名轉紅。
  assert.equal(
    declarations.length,
    MODE_TOKEN_DECLARATION_LINES[relPath],
    `${relPath} must carry ${MODE_TOKEN_DECLARATION_LINES[relPath]} linked_issue_context mode-token declaration line(s) declaring exactly [${LINKED_ISSUE_CONTEXTS.join(", ")}] — no missing and no extra value; found ${declarations.length}`,
  );
}

function assertTemplateProjectionIdentity(bodies) {
  const declarations = [];
  for (const relPath of Object.keys(TEMPLATE_PROJECTION_LINES)) {
    for (const line of bodies[relPath].split("\n")) {
      if (/^linked_issue_context:/.test(line)) declarations.push({ relPath, line });
    }
  }
  for (const [relPath, expected] of Object.entries(TEMPLATE_PROJECTION_LINES)) {
    const found = declarations.filter((d) => d.relPath === relPath).length;
    // 匹配單元數不符即 fail closed（§守則 1）。
    assert.equal(found, expected, `${relPath} must expose ${expected} template projection(s), found ${found}`);
  }
  const unique = new Set(declarations.map((d) => d.line));
  assert.equal(
    unique.size,
    1,
    `template projections diverged:\n${declarations.map((d) => `  ${d.relPath}: ${d.line}`).join("\n")}`,
  );
}

function assertCliLeafRouteSsot(bodies) {
  const linkedIssueStep = sliceSection(
    bodies[CLI_CONTRACT],
    "cli-leaf linked-issue step",
    "6. Linked-issue PR context",
    "\n7. Reviewer path unavailable",
  );
  assertIncludes(linkedIssueStep, [
    "Requirement: External Reviewer Linked Issue Route",
    "Missing issue context is an invocation/orchestration fault",
    "A cross-repo linked issue is only annotated, never read",
  ]);
  assertExcludes(linkedIssueStep, ["adoption-notice", "disclosure scope", "Second-review disclosure"]);
  // 指 SSOT 而非重述 route How。
  assertExcludes(linkedIssueStep, [
    "closingIssuesReferences",
    "tool-returned issue number",
    "repository.owner.login",
    "repository.name",
  ]);
}

function assertCliLeafSizeLimitPointer(bodies) {
  const capsSection = sliceSection(
    bodies[CLI_CONTRACT],
    "cli-leaf handoff size-limit pointer",
    "Handoff 欄位上限：",
    "\nTimeout policy：",
  );
  assertIncludes(capsSection, [".devpro/scripts/validate-second-review-packet.mjs"]);
  // 不得手抄數值——那會建立第二份會漂移的副本。
  assert.doesNotMatch(
    capsSection,
    /\d{2,}/,
    "the size-limit pointer must not hand-copy byte numbers from the validator",
  );
}

// 正向斷言登錄表：id → 執行函式 + 預期 operative 行分佈（檔案 → 刪除後轉紅的行數）。
// 檔尾 meta-test 以此做 mutation 審計。
const POSITIVE_ASSERTIONS = [
  ...MODE_TOKEN_CARRIERS.map((relPath) => ({
    id: `mode-token-declaration:${relPath}`,
    run: (bodies) => assertModeTokenDeclaration(relPath, bodies[relPath]),
    operative: { [relPath]: MODE_TOKEN_DECLARATION_LINES[relPath] },
  })),
  {
    id: "template-projection-identity",
    run: assertTemplateProjectionIdentity,
    operative: { ...TEMPLATE_PROJECTION_LINES },
  },
  // 兩條 marker 行（起始與終止）都是 operative：任一被刪，取材邊界即不再唯一（§守則 1）。
  { id: "cli-leaf-route-ssot", run: assertCliLeafRouteSsot, operative: { [CLI_CONTRACT]: 2 } },
  { id: "cli-leaf-size-limit-pointer", run: assertCliLeafSizeLimitPointer, operative: { [CLI_CONTRACT]: 2 } },
];

function readAuditBodies() {
  return Object.fromEntries(AUDIT_FILES.map((relPath) => [relPath, read(relPath)]));
}

test("every carrier advertises exactly the runtime-canonical linked_issue_context tokens", () => {
  const bodies = readAuditBodies();
  for (const relPath of MODE_TOKEN_CARRIERS) {
    assertModeTokenDeclaration(relPath, bodies[relPath]);
  }
});

test("no carrier reintroduces the embedded-issue-content form", () => {
  for (const relPath of EMBED_FORBIDDEN_CARRIERS) {
    const body = read(relPath);
    // C1：舊的許可式字面（只在「可內嵌」的寫法裡出現過）整檔缺席。
    assert.ok(
      !body.includes(LEGACY_EMBED_LITERAL),
      `${relPath} must not reintroduce the legacy embed literal \`${LEGACY_EMBED_LITERAL}\``,
    );
    for (const [index, line] of body.split("\n").entries()) {
      // C2：polarity-sensitive 同物理行複合式——欄位名與「內嵌 issue 內容」不得同行。
      if (line.includes("linked_issue_context")) {
        assert.ok(
          !EMBED_PERMISSION_RE.test(line),
          `${relPath}:${index + 1} must not pair linked_issue_context with an embedded-issue-content form`,
        );
      }
      // C3：語序無關的條件式——`gh issue view` 授權不得與「是否內嵌」同物理行。
      assert.ok(
        !conditionsIssueViewOnEmbedding(line),
        `${relPath}:${index + 1} must not condition the \`${ISSUE_VIEW_AUTHORIZATION}\` authorization on whether issue content is embedded; the only legal condition is the \`issue_read_required\` mode token`,
      );
    }
  }
});

// 非空轉反證（§驗證方法）：forbidden 側沒有 positive 側那種逐行刪除審計可用（刪行只會讓禁止
// 措辭更缺席），故改以 fixture 雙向釘死——正例是本 change pre-PR walkthrough 實際抓到的 4 條
// 殘留原文，反例是必須放行的正當行。marker 若被改寬或改窄，這條就轉紅。
const HISTORICAL_EMBED_RESIDUES = [
  "- Add `Bash(gh issue view:*)` to `--allowedTools` only when linked-issue content is not embedded in the packet.",
  "linked issue read-only `Bash(gh issue view:*)` when issue body is not embedded（`closingIssuesReferences` → tool-returned decimal issue numbers）；",
  "Add `Bash(gh issue view:*)` only when linked issue content is not embedded, after `closingIssuesReferences` returns tool-returned issue numbers；",
  "issue-linked PR 未內嵌 issue body時，initial `--allowedTools` MUST include `Bash(gh pr view:*)` and `Bash(gh issue view:*)`；",
];
const EMBED_FORBIDDEN_NEGATIVE_FIXTURES = [
  "- Add `Bash(gh issue view:*)` to `--allowedTools` exactly when `linked_issue_context` is `issue_read_required`.",
  "review_material_carrier: embedded-diff；reviewer 另依 mode token 以 `gh issue view` 讀 linked issue",
  "review_material_capability: scope-bound-embedded-complete-diff-v1，`gh issue view` 由 mode token 授權",
];

test("the embed-form forbidden marker is not vacuous", () => {
  for (const line of HISTORICAL_EMBED_RESIDUES) {
    assert.ok(
      conditionsIssueViewOnEmbedding(line),
      `forbidden marker missed a known historical residue: ${line}`,
    );
  }
  for (const line of EMBED_FORBIDDEN_NEGATIVE_FIXTURES) {
    assert.ok(
      !conditionsIssueViewOnEmbedding(line),
      `forbidden marker false-positives on a legitimate line: ${line}`,
    );
  }
});

// 非空轉反證（插入側）：檔尾 mutation 審計只模擬**刪除**，本質上抓不到「宣告行多列一個 runtime
// 會拒絕的值」——刪行只會讓宣告更缺席。於是 docs ⊆ runtime 這一側原本沒有任何機械保證：carrier
// 可以宣傳第三個值而 parity 與 mutation 審計全綠。此處以 fixture 雙向釘死宣告行匹配器：正例是
// 三種實際存在的宣告語法（template angle-bracket、CJK 頓號式、CJK 斜線式），反例是插入未預期
// token 與漏列 canonical token。fixture 由 `LINKED_ISSUE_CONTEXTS` 生成，不手抄值集合。
const UNEXPECTED_TOKEN = "issue_read_optional";
const backticked = (tokens, separator) => tokens.map((token) => `\`${token}\``).join(separator);
const DECLARATION_POSITIVE_FIXTURES = [
  `linked_issue_context: <${LINKED_ISSUE_CONTEXTS.join(" OR ")} — mode token only, never issue content>`,
  `- \`linked_issue_context\`: mode token，只收 ${backticked(LINKED_ISSUE_CONTEXTS, " 或 ")}，MUST NOT 承載 issue 內容`,
  `該欄位是 **mode token**，只收 ${backticked(LINKED_ISSUE_CONTEXTS, " / ")}；\`linked_issue_context\` MUST NOT 承載 issue 內容`,
];
const DECLARATION_DRIFT_FIXTURES = [
  // 插入側（本 WARN 的原始重現）：宣告一個 runtime 會拒絕的第三值。
  `linked_issue_context: <${[...LINKED_ISSUE_CONTEXTS, UNEXPECTED_TOKEN].join(" OR ")} — mode token only, never issue content>`,
  `該欄位是 **mode token**，只收 ${backticked([...LINKED_ISSUE_CONTEXTS, UNEXPECTED_TOKEN], " / ")}；\`linked_issue_context\` MUST NOT 承載 issue 內容`,
  // 漏列側：carrier 落後於 runtime 的值集合。
  `linked_issue_context: <${LINKED_ISSUE_CONTEXTS.slice(0, 1).join(" OR ")} — mode token only, never issue content>`,
];

test("the mode-token declaration matcher rejects value-set drift in either direction", () => {
  assert.ok(
    !LINKED_ISSUE_CONTEXTS.includes(UNEXPECTED_TOKEN),
    `${UNEXPECTED_TOKEN} must stay outside the canonical set for this fixture to mean anything`,
  );
  for (const line of DECLARATION_POSITIVE_FIXTURES) {
    assert.equal(
      modeTokenDeclarationLines(line).length,
      1,
      `matcher missed a legitimate declaration shape: ${line}`,
    );
  }
  for (const line of DECLARATION_DRIFT_FIXTURES) {
    assert.equal(
      modeTokenDeclarationLines(line).length,
      0,
      `matcher accepted a drifted value set: ${line}`,
    );
  }
});

test("the template projections carry a byte-identical linked_issue_context value", () => {
  assertTemplateProjectionIdentity(readAuditBodies());
});

test("runtime accepts exactly the canonical tokens and rejects embedded issue content", () => {
  for (const token of LINKED_ISSUE_CONTEXTS) {
    assert.doesNotThrow(
      () =>
        canonicalReviewerCliRecipe({
          repository_slug: "devpro/example",
          reviewer_family: "claude",
          mode: "pr-sticky",
          linked_issue_context: token,
        }, { selected_effort: "xhigh" }),
      `canonical token \`${token}\` must be accepted by the reviewer CLI recipe contract`,
    );
  }

  // Spec scenario `Unaccepted linked issue context value fails closed`：rejection
  // MUST NOT 依賴 reviewer family 或 pr-sticky / audit-only output mode。
  for (const rejected of [LEGACY_EMBED_LITERAL, "embedded", "", "issue_read_optional"]) {
    for (const reviewerFamily of ["claude", "openai-codex"]) {
      for (const mode of ["pr-sticky", "audit-only"]) {
        assert.throws(
          () =>
            canonicalReviewerCliRecipe({
              repository_slug: "devpro/example",
              reviewer_family: reviewerFamily,
              mode,
              neutral_cwd_path: "/tmp/devpro-neutral",
              linked_issue_context: rejected,
            }, reviewerFamily === "claude" ? { selected_effort: "xhigh" } : {}),
          /linked_issue_context must be/,
          `\`${rejected}\` must fail closed for ${reviewerFamily}/${mode} before reviewer dispatch`,
        );
      }
    }
  }
});

test("issue-view allowlist is granted exactly when linked_issue_context is issue_read_required", () => {
  // 綁住 route SSOT 的 "exactly when" 語意，並覆蓋 recipe contract 內以字面
  // `=== "issue_read_required"` 決定 allowlist 的分支——token 改名而該分支沒跟時轉紅。
  const issueView = `Bash(node ${repoPath(".devpro/scripts/read-second-review-linked-issue.mjs")} devpro/example:*)`;
  const granting = [];

  for (const token of LINKED_ISSUE_CONTEXTS) {
    const recipe = canonicalReviewerCliRecipe({
      repository_slug: "devpro/example",
      reviewer_family: "claude",
      mode: "pr-sticky",
      linked_issue_context: token,
    }, { selected_effort: "xhigh" });
    // 結構化取值，不 stringify 整個 recipe：`required_invocation_args` 內含
    // `CLAUDE_REVIEWER_SYSTEM_PROMPT` 這段散文，join 後做 includes() 會被 prose 汙染，
    // 讓 `none` 誤報成已授權。
    const args = recipe.required_invocation_args;
    const flagIndex = args.lastIndexOf("--allowedTools");
    assert.notEqual(flagIndex, -1, "pr-sticky recipe must declare --allowedTools");
    const allowlist = String(args[flagIndex + 1]).split(",");
    if (allowlist.includes(issueView)) granting.push(token);
    assert.equal(
      allowlist.includes(issueView),
      token === "issue_read_required",
      `\`${token}\` must ${token === "issue_read_required" ? "grant" : "omit"} ${issueView}; got ${allowlist.join("|")}`,
    );
  }

  // 與字面無關的不變量：恰有一個 canonical token 授權 issue-view。少了它，enum 改名而
  // recipe 內 `=== "issue_read_required"` 分支沒跟時，會變成「沒有任何 token 授權」卻仍全綠。
  assert.deepEqual(
    granting,
    ["issue_read_required"],
    `exactly one canonical token must grant ${issueView}; got [${granting.join(", ")}]`,
  );
});

test("capability specs state the mode-token contract and drop the embed form", () => {
  const checklistSpec = readSpec("code-review-checklist");
  const openspecFlowSpec = readSpec("openspec-flow");

  assertIncludes(checklistSpec, [
    "External Reviewer Linked Issue Context",
    "mode token, not a content field",
    "linked_issue_context: issue_read_required",
    "Requirement: External Reviewer Linked Issue Route",
    "orchestration fault",
  ]);
  assertIncludes(openspecFlowSpec, [
    "Post-PR Linked Issue Context for Cross-Review",
    "Fixes #N",
    "mode token, not a content field",
    "Requirement: External Reviewer Linked Issue Route",
  ]);

  // Forbidden 側只查 canonical spec：delta 尚未 promote 時 canonical 仍載舊措辭，故本斷言
  // 在 archive/promote 完成前為紅——那正是 promote 是否真的發生的證據。
  for (const capability of ["code-review-checklist", "openspec-flow"]) {
    const canonical = read(`openspec/specs/${capability}/spec.md`);
    assert.ok(
      !canonical.includes(LEGACY_EMBED_LITERAL),
      `openspec/specs/${capability}/spec.md must not retain the legacy embed literal after promote`,
    );
  }
});

// 同一 enumerate-vs-delegate 分界套到 spec 側：route SSOT 自己**列舉** repo identity 的推導
// 義務，其餘 capability 一律**委派**。前一版對兩個 capability 都要求列舉，`code-review-checklist`
// 的 canonical 其實一個 token 都沒有，全靠 archive union 供給——既空轉又與本 change「MUST NOT
// 重述 route How」的原則相衝突。
const ROUTE_DERIVATION_TOKENS = [
  "--repo <owner>/<repo>",
  "repository.owner.login",
  "repository.name",
  "hand-typed or guessed",
];
const ROUTE_SSOT_POINTER = "Requirement: External Reviewer Linked Issue Route";

test("linked-issue route derivation lives in the route SSOT and is delegated elsewhere (T6/S2)", () => {
  assertIncludes(readSpec("cross-runtime-parity"), ROUTE_DERIVATION_TOKENS);
  const checklistSpec = readSpec("code-review-checklist");
  assert.ok(
    checklistSpec.includes(ROUTE_SSOT_POINTER),
    "code-review-checklist must delegate the linked-issue route by naming the route SSOT requirement",
  );
  assertExcludes(checklistSpec, ROUTE_DERIVATION_TOKENS);
});

test("Claude positive-tool-profile prose references the linked-issue route SSOT without restating route How", () => {
  const requirement = extractRequirementProse(
    read("openspec/specs/cross-runtime-parity/spec.md"),
    "Claude Code packet mode uses positive tool profile and sticky-first timeout verification",
  );
  const routeReference = "Requirement: External Reviewer Linked Issue Route";

  assert.equal(
    requirement.split(routeReference).length - 1,
    1,
    "the adjacent requirement prose must contain exactly one linked-issue route SSOT reference",
  );
  assertExcludes(requirement, [
    "closingIssuesReferences",
    "tool-returned decimal issue numbers",
    "repository.owner.login",
    "repository.name",
  ]);
});

test("CLI leaf points to the linked-issue route SSOT and keeps the missing-context action point", () => {
  assertCliLeafRouteSsot(readAuditBodies());
});

test("CLI leaf points at the validator as SSOT for handoff field size limits", () => {
  assertCliLeafSizeLimitPointer(readAuditBodies());
});

// §驗證方法：mutation 審計（收斂判準）。逐行模擬刪除、重跑全部正向斷言；每個斷言 MUST 恰在
// 其 operative 行被刪時轉紅。刪了仍全綠＝被他行 token 代償（洞）；命中行數多於宣告＝token 組合
// 非該行獨有。本 meta-test 把收斂性釘進 regression：新增斷言若引入代償洞會被自動抓到。
test("mutation audit: every positive assertion turns red exactly on its declared operative lines", () => {
  const real = readAuditBodies();

  // 未 mutate 時全部正向斷言 MUST 綠，否則下面的「處處轉紅」是空洞的。
  for (const assertion of POSITIVE_ASSERTIONS) {
    assert.doesNotThrow(() => assertion.run(real), `${assertion.id} must pass on unmutated carriers`);
  }

  const observed = new Map(POSITIVE_ASSERTIONS.map((a) => [a.id, { counts: {}, lines: [] }]));
  for (const relPath of AUDIT_FILES) {
    const lines = real[relPath].split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const mutated = {
        ...real,
        [relPath]: lines.filter((_, other) => other !== index).join("\n"),
      };
      for (const assertion of POSITIVE_ASSERTIONS) {
        try {
          assertion.run(mutated);
        } catch {
          const record = observed.get(assertion.id);
          record.counts[relPath] = (record.counts[relPath] ?? 0) + 1;
          record.lines.push(`${relPath}:${index + 1}`);
        }
      }
    }
  }

  // 收齊全部斷言再一次報告：只在第一個 mismatch 就 throw 會遮住其餘斷言的實際分佈。
  const mismatches = [];
  for (const assertion of POSITIVE_ASSERTIONS) {
    const record = observed.get(assertion.id);
    try {
      assert.deepEqual(record.counts, assertion.operative);
    } catch {
      mismatches.push(
        `${assertion.id}: expected ${JSON.stringify(assertion.operative)}, got ${JSON.stringify(record.counts)}; red lines: ${record.lines.join(", ") || "(none — compensated by other lines)"}`,
      );
    }
  }
  assert.deepEqual(mismatches, [], `mutation audit did not converge:\n${mismatches.join("\n")}`);
});

// T11 / D8：linked issue route 收窄為同 repo。
// 這組測項只讀 **runtime** 文字（packet reviewer duties 與 CLI recipe system prompt），不讀
// canonical spec：D8 的 spec 文字要到 archive 才進 `openspec/specs/`，且 route How 的 SSOT
// 仍是那份 spec；這裡鎖的是 reviewer 實際收到的 duty／recipe 文字。
// Duty guards preserve same-repo discovery/provenance; linked-issue-repo-binding.test.mjs
// separately verifies the repo-bound helper permission and strict argument parser.
const CROSS_REPO_ANNOTATION = "cross-repo linked issue <owner>/<repo>#<n>（未讀）";
const SAME_REPO_GATE = "exactly equals the packet's validated repository_slug (the sticky_write_repository value; never GH_REPO, cwd, git remote, or framed Review Data)";
const NO_REPO_FAIL_SAFE = "If no validated repository_slug is available, treat every entry that way.";

function dutyLinkedIssueBullet(prefix, label) {
  const bullets = prefix
    .split("\n")
    .filter((line) => line.startsWith("- If linked_issue_context is issue_read_required"));
  assert.equal(bullets.length, 1, `${label}: exactly one linked-issue duty bullet expected`);
  return bullets[0];
}

function recipeLinkedIssueSentence() {
  return sliceSection(
    CLAUDE_REVIEWER_SYSTEM_PROMPT,
    "recipe linked-issue sentence",
    "When linked_issue_context is issue_read_required",
    " Only when a validated v4 packet",
  );
}

function linkedIssueCarriers() {
  return {
    "runner packet duty": dutyLinkedIssueBullet(
      secondReviewPacketStaticPrefix("Claude Code", "pr-sticky"),
      "runner packet",
    ),
    "external evaluator packet duty": dutyLinkedIssueBullet(
      externalEvaluatorPacketStaticPrefix("Claude Code", "dispatch-test"),
      "external evaluator packet",
    ),
    "CLI recipe system prompt": recipeLinkedIssueSentence(),
  };
}

test("Only the same-repo linked issue is readable when a PR links both", () => {
  // PR 同時連結同 repo 與 cross-repo issue 的 `closingIssuesReferences[]` 形狀。
  const closingIssuesReferences = [
    { number: 12, repository: { name: "app", owner: { login: "acme" } } },
    { number: 34, repository: { name: "other", owner: { login: "elsewhere" } } },
  ];
  const packetRepository = "acme/app";

  // 比對基準 `repository_slug` 真的會以 `sticky_write_repository` 出現在 packet——duty 文字指的
  // 欄位名稱必須是 packet 實際輸出的欄位，而不是無法對上的名稱。
  const stickyLines = stickyWriteDispositionLines(
    {
      schema: "devpro-second-review-sticky-write-disposition/v1",
      action: "not-applicable",
      repository_slug: packetRepository,
      pr_number: 5,
      dispatch_id: "dispatch-test",
      candidate_count: 0,
      snapshot_digest: "none",
    },
    "audit-only",
    "Claude Code",
  );
  assert.ok(
    stickyLines.includes(`sticky_write_repository: ${packetRepository}`),
    "packet must expose the validated repository_slug as sticky_write_repository",
  );
  const sameRepo = closingIssuesReferences.filter(
    (entry) => `${entry.repository.owner.login}/${entry.repository.name}` === packetRepository,
  );
  assert.deepEqual(sameRepo.map((entry) => entry.number), [12]);

  for (const [label, text] of Object.entries(linkedIssueCarriers())) {
    // (1) 同 repo gate 以 packet 驗證過的 slug 為基準，且在任何 `gh issue view` 授權之前出現。
    const gateAt = text.indexOf(SAME_REPO_GATE);
    assert.notEqual(gateAt, -1, `${label}: missing same-repo gate anchor`);
    const firstIssueView = text.indexOf("gh issue view");
    assert.notEqual(firstIssueView, -1, `${label}: missing gh issue view route`);
    assert.ok(gateAt < firstIssueView, `${label}: same-repo gate must precede the first gh issue view permission`);

    // (2) 其他（cross-repo）條目只有標註指示，且該句明確禁止執行 issue view 與讀內容。
    const annotationSentence = text
      .split(/(?<=\.)\s+/)
      .find((sentence) => sentence.includes(CROSS_REPO_ANNOTATION));
    assert.ok(annotationSentence, `${label}: missing cross-repo annotation instruction`);
    assert.match(
      annotationSentence,
      /do not run (`gh issue view`|gh issue view) and do not read its content/,
      `${label}: annotation sentence must forbid gh issue view and content read for the other entries`,
    );
    assert.equal(
      text.split(CROSS_REPO_ANNOTATION).length - 1,
      1,
      `${label}: cross-repo annotation instruction must appear exactly once`,
    );
  }

  // (3) 無已驗證 slug 時 fail safe：duty 與 recipe 都不得把整批 issue 當同 repo 讀。
  for (const label of ["runner packet duty", "external evaluator packet duty"]) {
    assert.ok(linkedIssueCarriers()[label].includes(NO_REPO_FAIL_SAFE), `${label}: missing no-slug fail-safe`);
  }
  assert.ok(
    recipeLinkedIssueSentence().includes("if the packet carries no validated repository_slug, treat every entry as cross-repo"),
    "recipe: missing no-slug fail-safe",
  );
});

test("Linked issue read covers only same-repo linked issue content", () => {
  // 只讀同 repo linked issue 內容：duty／recipe 文字不得留下任何容許讀 cross-repo
  // issue 內容的措辭。用具體 anchor，不用寬鬆 includes。
  for (const [label, text] of Object.entries(linkedIssueCarriers())) {
    // 舊的無條件讀取形式（每個 tool-returned issue number 都讀）必須消失。
    assertExcludes(text, [
      "then read each tool-returned issue number with gh issue view",
      "read each tool-returned issue number",
    ]);

    // 每一處「讀內容」字樣都必須緊接在 `do not` 之後，不存在肯定句形式的讀內容授權。
    const readClaims = [...text.matchAll(/read its content/g)];
    assert.equal(readClaims.length, 1, `${label}: exactly one content-read clause expected`);
    for (const match of readClaims) {
      assert.equal(
        text.slice(Math.max(0, match.index - "do not ".length), match.index),
        "do not ",
        `${label}: content-read wording must only appear as a prohibition`,
      );
    }

    // cross-repo 句內不得有「例外／條件式放行」措辭。
    const annotationSentence = text
      .split(/(?<=\.)\s+/)
      .find((sentence) => sentence.includes(CROSS_REPO_ANNOTATION));
    assert.ok(annotationSentence, `${label}: missing cross-repo annotation sentence`);
    assert.doesNotMatch(
      annotationSentence,
      /\b(unless|except|when permitted|if allowed|may read|may run)\b/i,
      `${label}: cross-repo sentence must not carry an exemption`,
    );

    // 比對基準只能是 packet 驗證過的 slug，不得改由 cwd／git remote／framed Review Data 推導。
    assertIncludes(text, ["never GH_REPO, cwd, git remote, or framed Review Data"]);
    // --repo argv 仍只來自該 issue 自己的 entry。
    assertIncludes(text, [
      "own closingIssuesReferences[] entry's nested repository.owner.login/repository.name fields — never hand-typed, guessed, another entry's, or GH_REPO",
    ]);
  }

  const recipe = canonicalReviewerCliRecipe({
    reviewer_family: "claude", mode: "pr-sticky", linked_issue_context: "issue_read_required",
    repository_slug: "devpro/example",
  }, { selected_effort: "xhigh" });
  const args = recipe.required_invocation_args;
  const allowed = args[args.indexOf("--allowedTools") + 1].split(",");
  assert.ok(allowed.includes(`Bash(node ${repoPath(".devpro/scripts/read-second-review-linked-issue.mjs")} devpro/example:*)`));
  assert.ok(!allowed.includes("Bash(gh issue view:*)"));

});
