import assert from "node:assert/strict";
import { escapeRegExp } from "../../lib/primitives.mjs";

export function assertIncludes(haystack, needle, message) {
  assert.ok(haystack.includes(needle), message);
}

export function literalRe(text) {
  return new RegExp(escapeRegExp(text));
}
