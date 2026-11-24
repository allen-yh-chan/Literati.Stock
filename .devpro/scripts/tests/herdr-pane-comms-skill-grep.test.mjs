import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SKILL_REL = ".devpro/agent-skills/devpro-workflows/herdr-pane-comms";
const SKILL_MD = path.join(ROOT, SKILL_REL, "SKILL.md");
const MANIFEST = path.join(ROOT, ".devpro/agent-skills/manifest.json");
const HANDOFF = path.join(ROOT, ".devpro/agent-rules/multi-agent-handoff.md");
const DISCOVERY_DIRS = [".agents/skills", ".claude/skills"];

// Anchors lock devpro-specific guardrails only; herdr is pre-1.0, so command
// syntax stays owned by the installed binary and is not asserted here.
test("herdr-pane-comms skill probes per shell before answering", () => {
  const body = readFileSync(SKILL_MD, "utf8");
  // Each probe must check HERDR_ENV on the same line as its CLI lookup, so a
  // probe that drops the in-pane check cannot hide behind prose mentions.
  assert.match(body, /^command -v herdr .*HERDR_ENV.*= 1/m);
  assert.match(body, /^\[bool\]\(\(Get-Command herdr .*\$env:HERDR_ENV -eq '1'\)\)$/m);
  assert.match(body, /^where herdr .*"%HERDR_ENV%"=="1"/m);
});

// The Herdr app (herdr-core, CLI `hc`) sets no HERDR_ENV, so a probe that only
// checks the legacy pair falsely reports "not in herdr" inside the app.
test("herdr-pane-comms skill also probes the Herdr app per shell", () => {
  const body = readFileSync(SKILL_MD, "utf8");
  assert.match(body, /^command -v hc .*HC_TERMINAL_SOCKET/m);
  assert.match(body, /^\[bool\]\(\(Get-Command hc .*\$env:HC_TERMINAL_SOCKET\)$/m);
  assert.match(body, /^where hc .*if defined HC_TERMINAL_SOCKET/m);
  assert.match(body, /\*\*任一成立\*\*就在 herdr 內，不得回報「不在 herdr 內」/);
  assert.match(body, /只在兩者\*\*皆不成立\*\*時才回報「不在 herdr pane／Herdr terminal 內」/);
});

test("herdr-pane-comms skill identifies Herdr app targets by the foreground process", () => {
  const body = readFileSync(SKILL_MD, "utf8");
  assert.match(body, /看 `hc get <t>` 的 `foreground\.cwd`[^\n]*不看 `hc ls` 的 `cwd`/);
  assert.match(body, /^- 自己是哪個 terminal：`HC_TERMINAL_ID`/m);
  // Keep an even number of backticks in regex literals: stripJsCommentSpans
  // reads an odd count as an unterminated template and shard discovery rejects
  // the file (run-test-suite.test.mjs EXPECTED_SHARD_DISCOVERY_SCANNER_REJECTS).
  assert.match(body, /hc send <t> [^\n]*不得加 `--force`/);
});

test("herdr-pane-comms skill keeps trigger split and never self-initiates", () => {
  const body = readFileSync(SKILL_MD, "utf8");
  assert.match(body, /明示 herdr/);
  assert.match(body, /沒指名工具/);
  assert.match(body, /不得使用/);
  assert.match(body, /cmux-surface-comms/);
});

test("herdr-pane-comms skill keeps tasks.md as durable carrier and wait as wake-up only", () => {
  const body = readFileSync(SKILL_MD, "utf8");
  assert.match(body, /tasks\.md/);
  assert.match(body, /一次性傳話/);
  assert.match(body, /喚醒訊號/);
  assert.match(body, /不得直接重送/);
});

test("herdr-pane-comms skill requires reading the screen before sending", () => {
  const body = readFileSync(SKILL_MD, "utf8");
  assert.match(body, /停在輸入框/);
  assert.match(body, /不得只憑 `agent_status`/);
  assert.match(body, /--source visible/);
  assert.match(body, /絕對路徑/);
  assert.match(body, /--machine/);
});

test("herdr-pane-comms skill keeps out-of-scope boundaries", () => {
  const body = readFileSync(SKILL_MD, "utf8");
  assert.match(body, /Out of scope/);
  assert.match(body, /integration install/);
  assert.match(body, /Ask First/);
  assert.match(body, /merge gate/);
});

test("herdr-pane-comms is manifest-registered exactly once", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const hits = [];
  for (const group of manifest.groups || []) {
    for (const skill of group.skills || []) {
      if (skill.name === "herdr-pane-comms") hits.push(skill);
    }
  }
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, SKILL_REL);
});

test("herdr-pane-comms is discoverable via the devpro entry per discovery root", () => {
  for (const discoveryDir of DISCOVERY_DIRS) {
    const skillMdViaEntry = path.join(ROOT, discoveryDir, "devpro", "devpro-workflows", "herdr-pane-comms", "SKILL.md");
    assert.equal(existsSync(skillMdViaEntry), true, `herdr-pane-comms must be discoverable via ${discoveryDir}/devpro`);
  }
});

test("multi-agent-handoff points at herdr-pane-comms with its trigger", () => {
  const body = readFileSync(HANDOFF, "utf8");
  assert.match(body, /herdr-pane-comms/);
  assert.match(body, /HERDR_ENV=1/);
  assert.match(body, /HC_TERMINAL_SOCKET/);
});
