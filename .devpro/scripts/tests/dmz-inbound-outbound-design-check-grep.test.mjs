import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";

function assertIncludes(body, phrases) {
  for (const phrase of phrases) {
    assert.ok(body.includes(phrase), `missing phrase: ${phrase}`);
  }
}

function assertMatches(body, patterns) {
  for (const pattern of patterns) {
    assert.ok(pattern.test(body), `pattern did not match: ${pattern}`);
  }
}

test("change-consequence-assessment.md carries DMZ IN/OUT + Relay Service design check", () => {
  const leaf = read(".devpro/agent-rules/change-consequence-assessment.md");
  assertIncludes(leaf, [
    "Inbound/outbound network zone separation",
    "DMZ IN",
    "DMZ OUT",
    "Relay Service",
    "inbound 接收",
    "outbound 反向呼叫",
  ]);
  assertMatches(leaf, [
    /Workflow\/state\/ops: Inbound\/outbound network zone separation/,
    /MUST NOT.*同機、同 process 直連/,
    /demo\/sandbox.*不得.*否定 production 分離/s,
  ]);
});

test("dp-architect.md pointers to consequence leaf DMZ IN/OUT check", () => {
  const architect = read(".claude/agents/dp-architect.md");
  assertIncludes(architect, [
    "change-consequence-assessment.md",
    "DMZ IN/OUT",
    "Relay Service",
  ]);
  assertMatches(architect, [
    /inbound 接收與 outbound 反向呼叫/,
    /MUST NOT.*默認同機直連/,
  ]);
});

test("openspec-flow-fallback Design Checklist pointers to consequence SSOT", () => {
  const fallback = read(".devpro/agent-rules/openspec-flow-fallback.md");
  assertIncludes(fallback, [
    "Inbound/outbound network zone（DMZ IN/OUT）",
    "change-consequence-assessment.md",
    "Relay Service",
  ]);
  assertMatches(fallback, [
    /段二：Design Checklist[\s\S]*Inbound\/outbound network zone/,
    /pointer only，正文 SSOT 在 consequence leaf/,
  ]);
});
