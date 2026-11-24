/**
 * prompt-session.mjs
 *
 * Shared TTY yes/no prompt session used by sync / runtime / devpro:change CLIs.
 * Preserve existing TTY gating; do not invent non-TTY fallbacks.
 */

import { createInterface } from "node:readline/promises";

export function promptEnabled() {
  return process.stdin.isTTY;
}

export async function createPromptSession() {
  if (!promptEnabled()) {
    return null;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    async ask(question) {
      const answer = await rl.question(`${question} [y/N] `);
      return /^(y|yes)$/i.test(answer.trim());
    },
    close() {
      rl.close();
    },
  };
}

export async function askYesNo(session, q) {
  const answer = await session.ask(q);
  return answer;
}
