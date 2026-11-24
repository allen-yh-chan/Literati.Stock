import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";



const leaf = read(".devpro/agent-rules/rule-self-evolution.md");

// catastrophic-block: absence of anti-hack anchors would let rule-evolution happen without
// evaluation gates, silently inflating corpus and bypassing why_not_hack scrutiny.
// state-backed: anchors are grep-asserted in CI; any removal fails this test.
// nudge: cooperative-only judgment (why_not_hack quality / cruel-metric面向 認定) carried
// by reviewer axis; mechanical guard only asserts anchor presence, not content quality.

test("rule-self-evolution leaf contains value-score anchor", () => {
  assert.match(leaf, /value-score/);
});

test("rule-self-evolution leaf contains cruel-metric anchor", () => {
  assert.match(leaf, /cruel-metric/);
});

test("rule-self-evolution leaf contains why_not_hack anchor", () => {
  assert.match(leaf, /why_not_hack/);
});

test("rule-self-evolution leaf contains dedup / 去重 anchor", () => {
  assert.match(leaf, /去重/);
});

test("rule-self-evolution leaf contains governance-budget anchor", () => {
  assert.match(leaf, /governance-budget/);
});

test("rule-self-evolution leaf contains governance-budget net-add veto clause", () => {
  assert.match(leaf, /net-add 無配對且缺 rationale.*退回精簡/);
});

test("rule-self-evolution leaf contains 6-step sequence string", () => {
  assert.match(leaf, /收集.*value-score.*cruel-metric.*why_not_hack.*去重.*規範 PR/s);
});

test("rule-self-evolution leaf contains why_not_hack 缺失 自動拒 veto clause", () => {
  assert.match(leaf, /why_not_hack 缺失.*自動拒/);
});

test("rule-self-evolution leaf contains cruel-metric 任一面向退步 整筆否決 veto clause", () => {
  assert.match(leaf, /cruel-metric 任一面向退步.*整筆否決/);
});

test("rule-self-evolution leaf cross-refs rule-audit-playbook", () => {
  assert.match(leaf, /rule-audit-playbook/);
});

test("rule-self-evolution leaf cross-refs session-recap", () => {
  assert.match(leaf, /session-recap/);
});

test("rule-self-evolution leaf MUST-scan token-budget cap-pressure lane", () => {
  assert.match(leaf, /MUST.*掃 token budget[\/／]cap pressure/);
  assert.match(leaf, /accepted-finding-only/);
  assert.match(leaf, /hard-trim-for-cap/);
});

// strengthen-rule-governance-pending-ingest: dual-source ingest + fail-closed selection.
// catastrophic-block: missing anchors would let banned provenance / half-claimed batches /
// post-claim non-durable selection proceed into repair.
// state-backed: grep-asserted; cooperative judgment of eligibility stays in leaf/spec scenarios.

test("rule-self-evolution leaf locks dual-source pending ingest anchors", () => {
  assert.match(leaf, /source_provenance/);
  assert.match(leaf, /batch-now/);
  assert.match(leaf, /gate5-recap|dogfood-friction|gh-rule-feedback/);
  assert.match(leaf, /eligible.*pending|pending.*eligible/i);
});

test("rule-self-evolution leaf locks Unified Candidate Ledger dispositions", () => {
  assert.match(leaf, /consumed-temporary/);
  assert.match(leaf, /consumed-completed/);
  assert.match(leaf, /batch-now/);
});

test("rule-self-evolution leaf locks cluster formula and batch caps", () => {
  assert.match(leaf, /max\(U\)\s*\+\s*0\.5\s*\*\s*median\(U\)/);
  assert.match(leaf, /≤\s*7|unique\s*≤\s*7|≤7/);
  assert.match(leaf, /無關 carrier|unrelated carrier/i);
});

test("rule-self-evolution leaf locks selection claim-all and durable selection", () => {
  assert.match(leaf, /Governance Batch Selection/);
  assert.match(leaf, /claim-all/);
  assert.match(leaf, /revalidate/);
  assert.match(leaf, /release/);
  assert.match(leaf, /reselect/);
  assert.match(leaf, /首次無 proposal/);
  assert.match(leaf, /骨架＋選批段|骨架\+選批段/);
});

test("rule-self-evolution leaf locks post-claim durable-persist failure paths", () => {
  assert.match(leaf, /durable.?persist|persist.*durable|Governance Batch Selection/i);
  assert.match(leaf, /retry|重試/);
  assert.match(leaf, /A.*所有權仍 OK.*重試.*persist only/s);
  assert.match(leaf, /A.*禁 reselect／repair/s);
  assert.match(leaf, /B.*不可續行.*release.*reselect/s);
  assert.match(leaf, /C.*release 失敗.*STOP.*fail closed/s);
  assert.match(leaf, /C.*禁 reselect/s);
  assert.match(leaf, /STOP|fail closed|停下/);
});

test("rule-self-evolution leaf locks abandon restore eligibility", () => {
  assert.match(leaf, /abandon/);
  assert.match(leaf, /restore|恢復/);
});
