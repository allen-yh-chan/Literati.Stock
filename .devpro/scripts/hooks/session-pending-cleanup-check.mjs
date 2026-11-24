#!/usr/bin/env node
/**
 * session-pending-cleanup-check.mjs
 *
 * Stop hook：在主 agent 結束 turn 前 fire。檢查 notes/session-pending.md
 * 是否存在且沒有 countable list-item。若只剩 boilerplate，直接刪除並靜默；
 * 若仍有非 boilerplate 內容，emit 短提醒請檢查格式/內容。
 *
 * 設計原則：
 * - SRP：與 recap-check.mjs 分開，只負責 session-pending.md 清理/格式提醒
 * - Silent fail：任何錯誤都不 block workflow（exit 0 + stderr）
 * - Dedup：30min mtime marker（同 recap-utils.mjs 使用的 notes/tmp/state 目錄）
 * - Test hook: DEVPRO_RECAP_STATE_DIR overrides marker dir (defaults to <repo-root>/notes/tmp/state/devpro-recap-state)
 *
 * Output:
 *   - skip → empty stdout (exit 0)
 *   - emit → JSON `{systemMessage}` 軟提醒（per Stop event schema）
 */

import { promises as fs } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { defaultRepoStateDir } from "./lib/repo-state-identity.mjs";
import { parseListItemBlocks } from "../lib/session-pending-blocks.mjs";

// MARKER_DIR base: <main-checkout-root>/notes/tmp/state/devpro-recap-state
// (same base as recap-utils.mjs; DEVPRO_RECAP_STATE_DIR override for tests)
const MARKER_DIR =
  process.env.DEVPRO_RECAP_STATE_DIR ||
  defaultRepoStateDir("devpro-recap-state");
const MARKER_KEY = "session-pending-cleanup";
const MARKER_TTL_MS = 30 * 60_000;

function shStr(cmd) {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

async function isPromptedRecently() {
  try {
    const stat = await fs.stat(`${MARKER_DIR}/${MARKER_KEY}`);
    return Date.now() - stat.mtimeMs < MARKER_TTL_MS;
  } catch {
    return false;
  }
}

async function setPromptedMarker() {
  await fs.mkdir(MARKER_DIR, { recursive: true });
  await fs.writeFile(`${MARKER_DIR}/${MARKER_KEY}`, "");
}

/**
 * Boilerplate means the drained file shell only: headings, markdown separators,
 * HTML comments, and blank lines. Any prose is kept and surfaced because it may
 * be malformed pending content rather than housekeeping residue.
 *
 * Note: `## ` H2 lines are countable pending sections (via parseListItemBlocks),
 * so a file that still has H2 pending sections never reaches this helper for
 * auto-delete — only the drained H1/separator/comment shell does.
 */
function isBoilerplateOnly(content) {
  let inHtmlComment = false;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    if (inHtmlComment) {
      const closeIndex = line.indexOf("-->");
      if (closeIndex !== -1) {
        inHtmlComment = false;
        if (line.slice(closeIndex + 3).trim()) return false;
      }
      continue;
    }

    if (line.startsWith("<!--")) {
      const closeIndex = line.indexOf("-->");
      if (closeIndex === -1) {
        inHtmlComment = true;
      } else if (line.slice(closeIndex + 3).trim()) {
        return false;
      }
      continue;
    }

    if (/^#{1,6}\s+/.test(line)) continue;
    if (/^-{3,}$/.test(line)) continue;

    return false;
  }
  return !inHtmlComment;
}

async function main() {
  // Resolve repo root so hook works from any cwd
  const repoRoot = shStr("git rev-parse --show-toplevel");
  if (!repoRoot) {
    process.exit(0);
  }

  const pendingPath = path.join(repoRoot, "notes", "session-pending.md");

  // Step 1: file must exist
  let content;
  try {
    content = await fs.readFile(pendingPath, "utf8");
  } catch {
    // File doesn't exist or unreadable — nothing to do
    process.exit(0);
  }

  // Step 2: count pending blocks (## H2 sections + legacy top-level - bullets)
  const itemCount = parseListItemBlocks(content).length;

  // Step 3: Non-zero items → active todos remain, nothing to do.
  // Do NOT delete files that still have ## pending sections.
  if (itemCount !== 0) {
    process.exit(0);
  }

  // Step 4: zero items + drained boilerplate → scratch housekeeping. notes/ is
  // ignored state, so the hook can remove the empty shell without asking.
  if (isBoilerplateOnly(content)) {
    try {
      await fs.unlink(pendingPath);
    } catch {
      // fail-open: cleanup failure should not block or nag the workflow
    }
    process.exit(0);
  }

  // Step 5: zero items + non-boilerplate content → likely malformed pending
  // content or prose that the parser cannot count. Warn concisely, with dedup.
  if (await isPromptedRecently()) {
    process.exit(0);
  }

  await setPromptedMarker();

  const msg = [
    "### session-pending.md 內容需檢查",
    "",
    "`notes/session-pending.md` 有內容但沒有可計數待辦（缺少 `## ` H2 sections OR top-level `- ` / `* ` bullets）。",
    "",
    "請確認這是說明文字、格式漏寫，或應刪除的本機 scratch 內容。",
  ].join("\n");

  process.stdout.write(JSON.stringify({ systemMessage: msg }));
  process.exit(0);
}

main().catch((err) => {
  // Silent fail — 不該因 hook bug 卡 AI workflow
  process.stderr.write(`session-pending-cleanup-check hook error: ${err.message}\n`);
  process.exit(0);
});
