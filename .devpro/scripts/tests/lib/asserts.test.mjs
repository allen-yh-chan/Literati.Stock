/**
 * asserts.test.mjs
 *
 * Unit tests for tests/lib/asserts.mjs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertIncludes, literalRe } from "./asserts.mjs";

test("assertIncludes succeeds when the needle is present", () => {
  assertIncludes("hello.world", "hello", "haystack should include hello");
});

test("assertIncludes throws when the needle is missing", () => {
  assert.throws(
    () => assertIncludes("hello", "xyz", "missing xyz"),
    /missing xyz/,
  );
});

test("literalRe matches literal dots", () => {
  const re = literalRe("a.b");
  assert.match("a.b", re);
  assert.doesNotMatch("axb", re);
});
