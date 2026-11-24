import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./lib/repo-root.mjs";
import { stepSixASection } from "./lib/step-6a-blocks.mjs";

// The release back-merge completion gate (Stop hook that checks a pushed production-* tag against origin/main)
// only exists on Claude Code and Codex, and only when the host runs the project hooks and the clone has the
// pre-push hook. Step 6A must say so, and the registrations must match what the rule text claims. This file
// locks the rule text (Step 6A paragraph group, host table, preconditions, adapter lines, rationalization row,
// rigor row) and the registration anchors. The behavior itself is executed in hook-release-back-merge-check.test.mjs.
//
// Guard strength (rule-anchor-guard-strength.md): section headings, table rows and list items are structural
// anchors (existence is the point, includes or a row regex is enough); "a released turn is not completion" and
// the two preconditions carry polarity, so each is one single-physical-line regex binding the polarity word to
// its object. Token presence cannot prove a sentence was not semantically inverted; that stays a review duty.

// A Windows checkout with core.autocrlf=true has CRLF in tracked Markdown; the line anchors below end at LF.
const read = (file) => readFileSync(path.join(REPO_ROOT, file), "utf8").replace(/\r\n/g, "\n");

const STEPS = ".devpro/agent-rules/release-step-1-7.md";
const ROUTER = ".devpro/agent-rules/release-sit-uat-pat-prod.md";
const RIGOR = ".devpro/agent-rules/rules-rigor-level.md";
const ADAPTERS = {
  "claude-code": ".devpro/agent-rules/platform-adapters/claude-code.md",
  codex: ".devpro/agent-rules/platform-adapters/codex.md",
  cursor: ".devpro/agent-rules/platform-adapters/cursor.md",
  opencode: ".devpro/agent-rules/platform-adapters/opencode.md",
};
const GATE_FILE = "release-back-merge-check.mjs";
const GATE_HEADING = "**release back-merge completion gate";

// The paragraph group sits at the end of Step 6A; cut from its heading to the end of the section.
function gateGroup() {
  const section = stepSixASection();
  const start = section.indexOf(GATE_HEADING);
  assert.ok(start >= 0, `Step 6A lost the paragraph group heading ${GATE_HEADING}`);
  assert.equal(section.indexOf(GATE_HEADING, start + 1), -1, "the paragraph group heading appears exactly once");
  return section.slice(start);
}

const linesOf = (text) => text.split("\n");
const exactlyOne = (text, regex, what) => {
  const hits = linesOf(text).filter((line) => regex.test(line));
  assert.equal(hits.length, 1, `expected exactly one line for ${what}, found ${hits.length}`);
  return hits[0];
};

test("Step 6A carries the release back-merge completion gate paragraph group after the three command blocks", () => {
  const section = stepSixASection();
  const pointer = section.indexOf("release-back-merge-completion.md");
  assert.ok(pointer >= 0 && section.indexOf(GATE_HEADING) > pointer, "the paragraph group comes after the pointer to the Step 6A command leaf");
  assert.equal(section.includes("```bash"), false, "the command blocks live in the on-demand leaf, not in the Step 6A section");
  const group = gateGroup();
  assert.match(group, /^\*\*release back-merge completion gate[^\n]*\*\*$/m, "heading is a bold standalone line");
  exactlyOne(group, /^機制：[^\n]*pre-push[^\n]*PostToolUse[^\n]*Stop[^\n]*--require-main-ancestor[^\n]*Step 6A/, "the mechanism description (pre-push record, PostToolUse binding, Stop check against origin with the ancestry gate, pointer to Step 6A)");
});

test("Scenario: Hosts without the mechanism are marked rule-text-only (Step 6A host table)", () => {
  const group = gateGroup();
  exactlyOne(group, /^\| `platform-adapters\/claude-code\.md` \| 機制 \|/, "Claude Code host row");
  exactlyOne(group, /^\| `platform-adapters\/codex\.md` \| 機制 \|[^\n]*專案 hook 已被 Codex 信任並實際執行/, "Codex host row with the trust precondition");
  exactlyOne(group, /^\| `platform-adapters\/cursor\.md` \| 只靠文字 \|[^\n]*無 `postToolUse`[^\n]*no-op/, "Cursor host row");
  exactlyOne(group, /^\| `platform-adapters\/opencode\.md` \| 只靠文字 \|[^\n]*`session\.idle`[^\n]*非同步[^\n]*不登記/, "OpenCode host row");
});

test("Scenario: Hosts without the mechanism are marked rule-text-only (adapters)", () => {
  const pointer = /^(?=.*release back-merge completion gate)(?=.*只靠文字)(?=.*release-step-1-7\.md)(?=.*Step 6A)/;
  exactlyOne(read(ADAPTERS.cursor), pointer, "the Cursor adapter pointer line");
  exactlyOne(read(ADAPTERS.opencode), pointer, "the OpenCode adapter pointer line");
});

test("Scenario: Claude Code and Codex register the gate (adapter pointer lines)", () => {
  const claude = exactlyOne(read(ADAPTERS["claude-code"]), /release back-merge completion gate/, "the Claude Code adapter pointer line");
  assert.match(claude, /機制/);
  assert.match(claude, /release-step-1-7\.md/);
  assert.match(claude, /Step 6A/);
  const codex = exactlyOne(read(ADAPTERS.codex), /release back-merge completion gate/, "the Codex adapter pointer line");
  assert.match(codex, /機制[^\n]*專案 hook 已被 Codex 信任並實際執行/, "Codex marks the mechanism with its trust precondition on the same line");
  assert.match(codex, /release-step-1-7\.md/);
  assert.match(codex, /Step 6A/);
});

test("Scenario: Preconditions are disclosed", () => {
  const group = gateGroup();
  exactlyOne(group, /^- 前提 1：[^\n]*已信任並實際執行專案 hook[^\n]*沒執行時[^\n]*只剩本段文字/, "precondition 1 (host trusts and runs the project hooks)");
  exactlyOne(group, /^- 前提 2：[^\n]*已裝 pre-push（`core\.hooksPath`[^）\n]*）[^\n]*沒裝時沒有任何記錄[^\n]*機制不生效[^\n]*只剩本段文字/, "precondition 2 (clone has the pre-push hook)");
});

test("a mechanism release is not completion: completion is only the --require-main-ancestor exit 0, and merging into main stays Ask First", () => {
  const group = gateGroup();
  const line = exactlyOne(group, /^放行不等於完成：/, "the released-is-not-complete line");
  assert.match(line, /完成仍只看 `--require-main-ancestor` exit 0/);
  for (const token of ["origin-unverified", "qualified-handoff", "`BackMergeDeferredByUser: <原話摘要>`", "次數上限", "迴圈防護"]) {
    assert.ok(line.includes(token), `release reasons must be listed on the same line: ${token}`);
  }
  assert.match(line, /合進 `main` 仍是 Ask First 停點[^\n]*不授權代為合併/);
});

test("release-sit-uat-pat-prod.md: Common Rationalizations has the row that a quiet Stop does not mean back-merge is done", () => {
  const row = exactlyOne(read(ROUTER), /^\| 「Stop 沒擋，所以 back-merge 已完成或可以不做」 \|/, "the quiet-Stop rationalization row");
  assert.match(row, /只在 `platform-adapters\/claude-code\.md`／`platform-adapters\/codex\.md` 的 host 且前提成立時運作/);
  assert.match(row, /其餘 host（`platform-adapters\/cursor\.md`、`platform-adapters\/opencode\.md`）只靠文字/);
  assert.match(row, /放行不等於完成/);
  assert.match(row, /`--require-main-ancestor` exit 0/);
});

test("rules-rigor-level.md: release back-merge at off is scoped to linked repositories", () => {
  exactlyOne(read(RIGOR), /^\| `release-back-merge-check`（hard-block） \| fire \| fire \| 只檢查本 session 已連結到其他 repo 的未結紀錄 \|$/, "the rigor matrix row");
});

// ---- registration anchors (RED until the hook, registrations and runner changes land) ----

const stopCommands = (file, key) => {
  const hooks = JSON.parse(read(file)).hooks[key];
  assert.ok(Array.isArray(hooks) && hooks.length > 0, `${file} has no ${key} registrations`);
  return hooks.flatMap((entry) => (Array.isArray(entry.hooks) ? entry.hooks : [entry]).map((hook) => hook.command));
};
const registered = (commands, host) => commands.filter((command) => command.includes(GATE_FILE) && command.includes(`--host=${host}`));

test("Scenario: Claude Code and Codex register the gate (Stop registrations)", () => {
  assert.equal(registered(stopCommands(".claude/settings.json", "Stop"), "claude-code").length, 1, ".claude/settings.json Stop registers the gate once");
  assert.equal(registered(stopCommands(".codex/hooks.json", "Stop"), "codex").length, 1, ".codex/hooks.json Stop registers the gate once");
});

test("Scenario: Registration for the host without a post-tool hook is a parity no-op (stop registration exists for parity)", () => {
  assert.equal(registered(stopCommands(".cursor/hooks.json", "stop"), "cursor").length, 1, ".cursor/hooks.json stop registers the gate once");
});

test("Scenario: Claude Code and Codex register the gate (run-hook STOP_PAYLOAD_HOOKS forwards the Stop payload)", () => {
  assert.match(read(".devpro/scripts/hooks/run-hook.mjs"), /const STOP_PAYLOAD_HOOKS = new Set\(\[[^\]\n]*"release-back-merge-check\.mjs"[^\]\n]*\]\);/);
});

test("Scenario: Claude Code and Codex register the gate (off only fires with linked obligations)", async () => {
  const mod = await import(pathToFileURL(path.join(REPO_ROOT, ".devpro/scripts/hooks/lib/rigor-level.mjs")).href);
  assert.equal(mod.HOOK_NOOP_POLICY[GATE_FILE], "cross-repo-stop");
  assert.equal(mod.shouldNoOp(GATE_FILE, "off"), true);
  assert.equal(mod.shouldNoOp(GATE_FILE, "off", { hasCrossRepoObligation: true }), false);
});

test("Scenario: Hosts without the mechanism are marked rule-text-only (the OpenCode plugin never names the gate)", () => {
  assert.equal(read(".opencode/plugins/devpro-hooks.js").includes("release-back-merge-check"), false);
});

test("pre-push.mjs reaches the recorder only through a lazy await import(), never a static import", () => {
  const source = read(".devpro/scripts/hooks-git/pre-push.mjs");
  const lines = linesOf(source);
  // static imports at the time the recorder was added: node:readline only; any new one (the recorder or anything else) turns this red
  const staticSpecifiers = lines.flatMap((line) => {
    const hit = /^import\b[^\n]*?\bfrom\s+["']([^"']+)["']/.exec(line) ?? /^import\s+["']([^"']+)["']/.exec(line);
    return hit ? [hit[1]] : [];
  });
  assert.deepEqual(staticSpecifiers, ["node:readline"], "pre-push.mjs gained a static import");
  assert.ok(lines.some((line) => line.includes("release-back-merge-state.mjs")), "pre-push.mjs must reference the recorder module (loaded lazily)");
  assert.ok(lines.some((line) => /await import\(/.test(line)), "the recorder is loaded with await import(");
  assert.equal(lines.filter((line) => /(?<!await )(?<![\w.])import\(/.test(line)).length, 0, "every dynamic import( is awaited at the call site");
});

test("pre-push.mjs decides without loading any sibling lib, and its review prefix equals the branch-naming export", async () => {
  const source = read(".devpro/scripts/hooks-git/pre-push.mjs");
  // The only module the hook may load is the recorder, inside its own error
  // boundary. A second one turns an ordinary push into "Cannot find module"
  // wherever the hook is installed without the lib tree.
  const siblingSpecifiers = [...source.matchAll(/["'](\.\.?\/[^"']+\.mjs)["']/g)].map((hit) => hit[1]);
  assert.deepEqual(
    siblingSpecifiers,
    ["../hooks/lib/release-back-merge-state.mjs"],
    "pre-push.mjs references a sibling module other than the recorder",
  );
  const literal = /^const LOCAL_REVIEW_BRANCH_PREFIX = "([^"]+)";$/m.exec(source);
  assert.ok(literal, "pre-push.mjs must declare LOCAL_REVIEW_BRANCH_PREFIX as a string literal");
  const { LOCAL_REVIEW_BRANCH_PREFIX } = await import("../hooks/lib/branch-naming.mjs");
  assert.equal(literal[1], LOCAL_REVIEW_BRANCH_PREFIX, "pre-push.mjs review prefix drifted from branch-naming.mjs");
});
