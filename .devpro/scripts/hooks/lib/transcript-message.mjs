/**
 * transcript-message.mjs — last assistant message from a host JSONL transcript.
 *
 * One reader for the Stop hooks that need the final assistant text. A transcript
 * line carries the role either nested (`{ type: "assistant", message: { role:
 * "assistant", content } }`, one content block per line, which is what real
 * transcripts hold) or at the top level (`{ role: "assistant", content }`, the
 * older shape). Content is a string, a `type:"text"` part array, or an object
 * wrapping either. Fail-open: an unreadable, missing or oversized transcript gives "".
 */

import { existsSync, readFileSync, statSync } from "node:fs";

export const TRANSCRIPT_MAX_BYTES = 10 * 1024 * 1024;

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const inner = content.content || content;
    if (inner !== content) return textOfContent(inner);
  }
  return "";
}

/** Text of one parsed transcript line when it is an assistant line, else "". */
export function assistantTextOfEntry(entry) {
  if (!entry || typeof entry !== "object") return "";
  const role = entry.message?.role ?? entry.role;
  if (role !== "assistant") return "";
  return textOfContent(entry.message?.content ?? entry.content);
}

/** Text of the last assistant line that has any text; "" when none or unreadable. */
export function lastAssistantMessageText(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return "";
  try {
    if (statSync(transcriptPath).size > TRANSCRIPT_MAX_BYTES) return "";
    const lines = readFileSync(transcriptPath, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].trim()) continue;
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const text = assistantTextOfEntry(entry);
      if (text.trim()) return text;
    }
  } catch {
    // fail-open: an unreadable transcript has no message
  }
  return "";
}
