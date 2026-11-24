import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";
import { parseDoneWhen } from "../build-pr-sticky-handoff.mjs";

// The dp-architect proposal template produces a numbered Section 1, but the handoff builder only
// read `- * +` bullets, so a numbered Done When failed at post-PR with "no acceptance bullets"
// (after the head was already pushed). parseDoneWhen now reads numbered items (`1.` and `1)`) too.

const full = (body) => ["## Why", "x", "", "## Section 1: Target State (Done When)", "", body, "", "## Section 2: Touch", "- a.md"].join("\n");

test("parseDoneWhen reads `1.` numbered items", () => {
  assert.deepEqual(parseDoneWhen(full("1. first anchor\n2. second anchor\n10. tenth anchor")), ["first anchor", "second anchor", "tenth anchor"]);
});

test("parseDoneWhen reads `1)` numbered items", () => {
  assert.deepEqual(parseDoneWhen(full("1) first anchor\n2) second anchor")), ["first anchor", "second anchor"]);
});

test("parseDoneWhen keeps reading `- * +` bullets unchanged", () => {
  assert.deepEqual(parseDoneWhen(full("- dash item\n* star item\n+ plus item")), ["dash item", "star item", "plus item"]);
});

test("parseDoneWhen reads a list that mixes numbered items and bullets", () => {
  assert.deepEqual(parseDoneWhen(full("1. numbered item\n- bullet item\n2. another numbered item")), ["numbered item", "bullet item", "another numbered item"]);
});

test("parseDoneWhen still counts an indented bullet under a numbered item as its own item", () => {
  assert.deepEqual(parseDoneWhen(full("1. parent item\n   - child item\n2. next parent")), ["parent item", "child item", "next parent"]);
});

test("parseDoneWhen does not take a decimal, a bare number, a glued marker or prose as a numbered item", () => {
  const items = parseDoneWhen(full("1.5 is a decimal not an item\n2024.\n3.x glued marker\nplain prose line\n> **Guard**: quoted guard text\n1. real item"));
  assert.deepEqual(items, ["real item"]);
});

test("parseDoneWhen reads a B-mini `## Target State` numbered list", () => {
  assert.deepEqual(parseDoneWhen(["## Target State", "", "1. mini one", "2. mini two", "", "## Tasks", "- [ ] t"].join("\n")), ["mini one", "mini two"]);
});

test("parseDoneWhen still fails closed on a section with no items, and names numbered items in the message", () => {
  assert.throws(
    () => parseDoneWhen(full("only prose here, no list")),
    (error) => error.classification === "proposal_evidence_missing" && /no acceptance bullets or numbered items/.test(error.message),
  );
});

test("the PR template points the Change Context author at the handoff size limit by name", () => {
  const text = readFileSync(path.join(REPO_ROOT, ".devpro/agent-rules/git-pr-template-and-merge.md"), "utf8");
  const line = text.split("\n").filter((entry) => entry.startsWith("- **Change Context**："));
  assert.equal(line.length, 1, "exactly one Change Context template entry");
  assert.match(line[0], /第二意見 handoff 的 `scope_summary` 有長度上限，數值見 `proposal-template\.md` Section 1 的「第二意見 handoff 上限」/);
});
