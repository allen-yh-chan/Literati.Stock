#!/usr/bin/env node
/**
 * stop-handoff-cite.mjs — Stop hook
 *
 * Gate A — Handoff Cite Gate 串接點。在 AI turn 結束前（Stop event）偵測最後
 * 一條 assistant message：若含 handoff keyword 但未引述 rule file:line → block。
 *
 * Gate B — Stop-Point Handoff Shape Gate。若最後回覆把球交給使用者
 * （Owner:user / AskFirstPending / PR user wait），
 * 必須使用 stop-point-comms.md 的 user-facing 編號選項交棒格式。
 *
 * 設計：
 *   - 讀 stdin JSON payload 取 `transcript_path`（Stop event 格式）
 *   - 解析 JSONL transcript 取最後一條 role=assistant message（lib/transcript-message.mjs；role 可在 `message.role` 或頂層 `role`）
 *   - 呼叫 lib/stop-point-handoff-shape-gate.mjs `checkStopPointHandoffShape`
 *   - 呼叫 lib/handoff-cite-gate.mjs `checkHandoffCite`
 *   - shouldBlock → emit `{decision:"block", reason}` + exit 2（Stop hook block）
 *   - skip / pass → empty stdout + exit 0
 *
 * Fail-open：transcript 讀取失敗 / parse 失敗 / 任何 error → exit 0（不 block）。
 * 10MB cap：超大 transcript fail-open（與 pre-tool-gate.mjs 一致；cap 在 lib/transcript-message.mjs）。
 *
 * Bypass：env DEVPRO_DISABLE_STOP_POINT_HANDOFF_SHAPE_GATE=1 或
 *         env DEVPRO_DISABLE_HANDOFF_CITE_GATE=1。
 *
 * Per Gate A spec：ai-autonomy.md + handoff-cite-gate.mjs。
 *
 * Output：
 *   - block：JSON `{decision:"block", reason}` to stdout + exit 2
 *   - skip/pass：empty stdout + exit 0
 */

import { readStdin } from "./lib/stdin.mjs";
import { checkHandoffCite } from "./lib/handoff-cite-gate.mjs";
import { checkBranchRoutingCite } from "./lib/branch-routing-cite-gate.mjs";
import { checkStopPointHandoffShape } from "./lib/stop-point-handoff-shape-gate.mjs";
import { lastAssistantMessageText } from "./lib/transcript-message.mjs";

async function main() {
  // Bypass
  if (process.env.DEVPRO_DISABLE_HANDOFF_CITE_GATE === "1") {
    process.exit(0);
  }

  // Read stdin payload
  const raw = await readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    // fail-open：JSON parse 失敗 → 繼續（無 transcript_path）
  }

  const transcriptPath =
    payload.transcript_path || payload.transcriptPath || "";

  // Extract last assistant message
  const messageText = lastAssistantMessageText(transcriptPath);

  // Run Gate B check before cite gate so user-owned stops cannot exit with only
  // agent-facing labels/footer.
  if (process.env.DEVPRO_DISABLE_STOP_POINT_HANDOFF_SHAPE_GATE !== "1") {
    const shapeResult = checkStopPointHandoffShape({ messageText });
    if (shapeResult.shouldBlock) {
      process.stdout.write(JSON.stringify({ decision: "block", reason: shapeResult.message }));
      process.exit(2);
    }
  }

  // Run Gate A check
  const result = checkHandoffCite({ messageText });

  if (!result.shouldBlock) {
    // Gate A passed — run Gate H (branch routing cite, warn-only)
    if (process.env.DEVPRO_DISABLE_BRANCH_ROUTING_GATE !== "1") {
      const routingResult = checkBranchRoutingCite({ messageText });
      if (routingResult.shouldBlock) {
        // Warn-only: emit advisory to stderr, do not block
        process.stderr.write(
          `[Gate H Advisory]\n${routingResult.message}\n`
        );
      }
    }
    process.exit(0);
  }

  // Block：emit decision block
  process.stdout.write(JSON.stringify({ decision: "block", reason: result.message }));
  process.exit(2);
}

main().catch((err) => {
  // Silent fail — 不該因 hook bug 卡 AI workflow
  process.stderr.write(`stop-handoff-cite hook error: ${err.message}\n`);
  process.exit(0);
});
