/**
 * Behavioral fixture for the consumer rules-lane primary-checkout close-out.
 * `git submodule status` uses a leading space for an aligned checkout and
 * `+`, `-`, or `U` for states that must remain blocked.
 */

const STATUS_PATH = ".devpro-agent-rules";

export function primaryCheckoutCompletionAllowed(statusOutput) {
  const statusLine = String(statusOutput)
    .split(/\r?\n/)
    .find((line) => line.endsWith(` ${STATUS_PATH}`));

  return Boolean(statusLine) && statusLine.startsWith(" ");
}

export function fixtureStatus(prefix) {
  return `${prefix}${"a".repeat(40)} ${STATUS_PATH}`;
}

export const BLOCKING_STATUS_PREFIXES = ["+", "-", "U"];
