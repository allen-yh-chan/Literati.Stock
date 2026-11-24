import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readRepoFile as read } from "./lib/read.mjs";
import {
  readDeltaForChange,
} from "./lib/spec-delta-reader.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const helperSrc = readFileSync(join(here, "lib/spec-delta-reader.mjs"), "utf8");

const CANONICAL_PLUS_ACTIVE_FILES = [
  "sql-casing-convention-grep.test.mjs",
  "sql-index-design-rule-guard.test.mjs",
  "spec-code-consistency-axis-grep.test.mjs",
  "runtime-parity-preflight-grep.test.mjs",
  "codex-subagent-authorization-fallback.test.mjs",
  "cross-carrier-assertion-sync-grep.test.mjs",
];

test("shared helper defaults includeArchive to false", () => {
  assert.match(helperSrc, /includeArchive = false/);
  const fn = helperSrc.slice(helperSrc.indexOf("export function readDeltaForChange"));
  const body = fn.slice(0, fn.indexOf("export function readSpecWithDelta"));
  assert.match(body, /if \(!includeArchive\) return active/);
});

test("canonical-plus-active callers import the shared helper and drop local copies", () => {
  for (const file of CANONICAL_PLUS_ACTIVE_FILES) {
    const src = read(`.devpro/scripts/tests/${file}`);
    assert.match(
      src,
      /from "\.\/lib\/spec-delta-reader\.mjs"/,
      `${file} must import spec-delta-reader.mjs`,
    );
    assert.equal(
      src.includes("function readSpecWithDelta"),
      false,
      `${file} must not keep a local readSpecWithDelta`,
    );
  }
});

test("cross-carrier readSpecWithDelta calls omit archive union", () => {
  const src = read(
    ".devpro/scripts/tests/cross-carrier-assertion-sync-grep.test.mjs",
  );
  const specCall = src.match(
    /function readSpecWithDelta[\s\S]*?^function /m,
  );
  assert.equal(specCall, null, "local readSpecWithDelta must be gone");
  assert.match(src, /readSpecWithDelta\(/);
  assert.match(src, /readDeltaForChange\(/);
  assert.match(src, /includeArchive:\s*true/);
});

test("default readSpecWithDelta source does not concatenate archive paths", () => {
  const start = helperSrc.indexOf("export function readSpecWithDelta");
  const end = helperSrc.indexOf(
    "export function readChangeSpecWithArchiveFallback",
  );
  const specFn = helperSrc.slice(start, end);
  assert.match(specFn, /includeArchive/);
  assert.equal(
    specFn.includes("openspec/changes/archive"),
    false,
    "readSpecWithDelta must delegate archive reads rather than inline archive joins",
  );
});

test("readDeltaForChange can still union archive when opted in", () => {
  const withArchive = readDeltaForChange("strengthen-cross-carrier-assertion-sync", "openspec-flow", {
    includeArchive: true,
  });
  const without = readDeltaForChange("strengthen-cross-carrier-assertion-sync", "openspec-flow", {
    includeArchive: false,
  });
  assert.ok(withArchive.length >= without.length);
});

test("scenario-omission uses shared delta-only reader, not canonical union", () => {
  const src = read(
    ".devpro/scripts/tests/scenario-omission-disclosure-axis-grep.test.mjs",
  );
  assert.match(src, /readDeltaForChange/);
  assert.equal(src.includes("function readDeltaOnly"), false);
  assert.match(src, /includeArchive:\s*true/);
});

test("feature-conflict uses archive-fallback helper, not archive union", () => {
  const src = read(
    ".devpro/scripts/tests/feature-conflict-routing-grep.test.mjs",
  );
  assert.match(src, /readChangeSpecWithArchiveFallback/);
  assert.equal(src.includes("function resolveChangeSpec"), false);
});
