import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./repo-root.mjs";

export const STEPS = ".devpro/agent-rules/release-step-1-7.md";

// A Windows checkout with core.autocrlf=true has CRLF in tracked Markdown; the anchors and the extracted bash
// blocks below are LF.
const readLf = (file) => readFileSync(path.join(REPO_ROOT, file), "utf8").replace(/\r\n/g, "\n");

export function stepSixASection() {
  const text = readLf(STEPS);
  const start = text.indexOf("**Step 6A：tagged production ancestry completion**");
  const end = text.indexOf("**分支清理 / Notes Tmp Hygiene", start);
  assert.ok(start >= 0 && end > start, "Step 6A section boundaries");
  return text.slice(start, end);
}

// The Step 6A command blocks and routing bullets live in an on-demand leaf; the Step 6A
// section of release-step-1-7.md keeps the applicability line, the pointer and the gate group.
export const STEP_6A_COMMANDS = ".devpro/agent-rules/release-back-merge-completion.md";

export function stepSixACommandSection() {
  const text = readLf(STEP_6A_COMMANDS);
  const start = text.indexOf("Step 6A 指令（");
  assert.ok(start >= 0, "Step 6A command section start");
  return text.slice(start);
}

export function stepSixABlocks() {
  const blocks = [...stepSixACommandSection().matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);
  assert.equal(blocks.length, 3, "Step 6A carries three bash blocks: check+classify+ff+push, open the PR, verify after merge");
  return blocks;
}
