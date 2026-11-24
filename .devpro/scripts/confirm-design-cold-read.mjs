/**
 * confirm-design-cold-read.mjs
 *
 * Records the user's confirmation of a design cold read, so Gate CR releases.
 * The user answers in the conversation; the AI then runs this with the user's
 * own words, quoted as said:
 *
 *   node .devpro/scripts/confirm-design-cold-read.mjs <change> --user-answer "<原話>" [--unverified]
 *
 * The first line moves from `status: pending` to a releasing status, the line
 * below it becomes `user-answer: <原話>` (the record keeps it on one line, so
 * every run of whitespace, line breaks included, becomes one space and the
 * ends are trimmed; the words themselves are not changed), and the next names
 * the change as `change: <change>`, so a record copied into another change
 * does not release there. Running it again on a record already at the same status replaces the
 * quoted answer. A record that names another change is refused: its reader
 * text belongs to that change. `--unverified` records that the user accepted
 * the cold read as not verified.
 *
 * Run it only after the user has answered; writing it before the answer, or
 * with words the user did not say, is the accident this record exists to
 * avoid (design-core section 11, `consent-record-residual`).
 *
 * Exit: 0 recorded or unchanged, 1 refused, 2 usage.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESIGN_COLD_READ_ANSWER_PREFIX,
  DESIGN_COLD_READ_CHANGE_PREFIX,
  DESIGN_COLD_READ_CONFIRMED_LINE,
  DESIGN_COLD_READ_PENDING_LINE,
  DESIGN_COLD_READ_RECORD,
  DESIGN_COLD_READ_UNVERIFIED_LINE,
  designColdReadAnswerOf,
  designColdReadChangeNames,
  designColdReadStatusOf,
  firstLineOf,
  isDesignColdReadRecordReleased,
} from "./hooks/lib/design-cold-read-record.mjs";

const USAGE =
  'usage: node .devpro/scripts/confirm-design-cold-read.mjs <change> --user-answer "<user\'s words>" [--unverified]';
const CHANGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseArgs(argv) {
  let unverified = false;
  let answer = null;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--unverified") unverified = true;
    else if (arg === "--user-answer") {
      // A forgotten answer must not swallow the next flag as the user's words.
      if (answer !== null || i + 1 >= argv.length || argv[i + 1].startsWith("--")) return null;
      answer = argv[(i += 1)];
    } else if (arg.startsWith("--user-answer=")) {
      if (answer !== null) return null;
      answer = arg.slice("--user-answer=".length);
    } else rest.push(arg);
  }
  if (rest.length !== 1 || !CHANGE_NAME_RE.test(rest[0])) return null;
  const quoted = typeof answer === "string" ? answer.replace(/\s+/g, " ").trim() : "";
  if (!quoted) return null;
  return { change: rest[0], unverified, answer: quoted };
}

// The status line, the answer line and the change line, then the body without
// any earlier answer or change line. Each body line keeps its own ending, so a
// record mixing LF and CRLF loses none of the reader's text; the new lines take
// the first line's ending.
export function confirmedRecord({ content, target, answer, change }) {
  const lines = String(content ?? "").match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const firstEnding = lines[0]?.match(/\r?\n$/)?.[0] ?? "";
  const eol = firstEnding || "\n";
  const recorded = [DESIGN_COLD_READ_ANSWER_PREFIX, DESIGN_COLD_READ_CHANGE_PREFIX];
  const body = lines
    .slice(1)
    .filter((line) => !recorded.some((prefix) => line.trimEnd().startsWith(prefix)));
  const head = [target, `${DESIGN_COLD_READ_ANSWER_PREFIX} ${answer}`, `${DESIGN_COLD_READ_CHANGE_PREFIX} ${change}`];
  return head.join(eol) + firstEnding + body.join("");
}

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }

  let root;
  try {
    root = repoRoot();
  } catch {
    refuse("這裡不是 git repo，請到該 change 的 worktree 再跑。");
  }

  const relative = `openspec/changes/${args.change}/${DESIGN_COLD_READ_RECORD}`;
  const record = path.join(root, relative);
  if (!existsSync(record)) refuse(`找不到 ${relative}，請到該 change 的 worktree 再跑。`);

  const target = args.unverified ? DESIGN_COLD_READ_UNVERIFIED_LINE : DESIGN_COLD_READ_CONFIRMED_LINE;
  const content = readFileSync(record, "utf8");
  const firstLine = firstLineOf(content);
  const status = designColdReadStatusOf(firstLine);
  if (status !== DESIGN_COLD_READ_PENDING_LINE && status !== target) {
    refuse(`${relative} 第一行不是 ${DESIGN_COLD_READ_PENDING_LINE}（目前：${firstLine || "空白"}），沒有變更。`);
  }
  const foreign = designColdReadChangeNames(content).find((name) => name !== args.change);
  if (foreign !== undefined) {
    refuse(
      `${relative} 的 change: 寫的是 ${foreign || "空白"}，不是 ${args.change}，可能是從別的 change 複製來的，沒有變更。` +
        `把第一行改回 ${DESIGN_COLD_READ_PENDING_LINE}，為本 change 重做冷讀後再確認。`,
    );
  }
  if (
    firstLine === target &&
    designColdReadAnswerOf(content) === args.answer &&
    isDesignColdReadRecordReleased({ content, changeName: args.change })
  ) {
    process.stdout.write(`${relative} 已經是 ${target}，引用的回答相同，沒有變更。\n`);
    return;
  }

  writeFileSync(record, confirmedRecord({ content, target, answer: args.answer, change: args.change }));
  process.stdout.write(`${relative} 第一行已改成 ${target}，並記下使用者的回答。\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
