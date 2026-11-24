import path from "node:path";
import { extractCredentialDenyTokens } from "./second-review-sticky-credential-gate.mjs";

/** Consumer-owned second-review rules file: free-form markdown (repo-root relative, posix). */
export const CONSUMER_SECOND_REVIEW_RULES_REL = ".devpro/second-review-rules.local.md";

/** Derived basename — MUST be the reserved consumer basename, not a second literal. */
export const CONSUMER_SECOND_REVIEW_RULES_BASENAME = path.posix.basename(CONSUMER_SECOND_REVIEW_RULES_REL);

/** The pre-markdown file name. It is no longer read; doctor warns when it is still present. */
export const CONSUMER_SECOND_REVIEW_RULES_LEGACY_REL = ".devpro/second-review-rules.local";

/** Packet budget for the whole file; the packet validator imports this same value. */
export const CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES = 32768;

/** What second review does with each problem code; doctor and the handoff builder share it. */
export const CONSUMER_SECOND_REVIEW_RULES_PROBLEM_HINTS = Object.freeze({
  "invalid-utf8": "review stops; save the file as UTF-8",
  "not-a-regular-file": "review stops; the path must be a regular file, not a directory, symlink or submodule",
  "nul-byte": "review stops; remove the NUL byte",
  "too-large": `review stops; keep the file within ${CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES} bytes`,
  "credential-shape": "review stops; remove the credential-shaped text from the file",
  "pii-or-secret-pattern": "review stops in every execution mode; remove the PII or secret pattern from the file",
});

const UTF8_BOM = [0xef, 0xbb, 0xbf];

function problem(code, detail = null) {
  return { code, detail, blocking: true };
}

/**
 * Packet integrity check for the raw bytes of the second-review rules file. Pure: it reads no file, runs no git
 * and touches no runtime state. The file is free-form markdown, so nothing here splits it into entries: one leading
 * UTF-8 BOM is removed (not a problem), the rest must decode as strict UTF-8, hold no NUL byte, stay within
 * `CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES` and yield no credential deny token. `text` is the decoded markdown
 * unchanged when there is no problem (the empty string when the file holds only whitespace, which callers treat as
 * no rules) and the empty string otherwise. Problems never carry any text of the file.
 *
 * @param {Uint8Array} buffer
 * @returns {{ text: string, problems: Array<{code: string, detail: number|null, blocking: boolean}> }}
 */
export function checkConsumerReviewRulesBytes(buffer) {
  let content = buffer;
  if (UTF8_BOM.every((byte, index) => content[index] === byte)) content = content.subarray(UTF8_BOM.length);

  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    return { text: "", problems: [problem("invalid-utf8")] };
  }

  const problems = [];
  if (decoded.includes("\u0000")) problems.push(problem("nul-byte"));
  if (content.byteLength > CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES) problems.push(problem("too-large", content.byteLength));
  if (problems.length > 0) return { text: "", problems };

  if (extractCredentialDenyTokens({ materialTexts: [decoded] }).length > 0) {
    return { text: "", problems: [problem("credential-shape")] };
  }
  return { text: decoded.trim() === "" ? "" : decoded, problems: [] };
}
