import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";

/**
 * Guarantee ceiling (cooperative-only).
 *
 * Locks: internal consistency of the Immutable quantifier and its `**...**`
 * token list across `AGENTS.md` and `README.md`.
 * Does NOT prove: that the three Immutables are the correct three, that the
 * surrounding prose means what the token list says, or that other carriers
 * (for example `docs/`, adapters, or consumer copies) agree. It is a
 * count-consistency guard, not a semantic one. Review owns that half.
 */

// 中文數字 → 阿拉伯數字對應表，供「數量詞」與「實際 token 數」互相比對。
const CHINESE_DIGIT_TO_NUMBER = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function chineseDigitToNumber(digit) {
  assert.ok(
    Object.hasOwn(CHINESE_DIGIT_TO_NUMBER, digit),
    `未知中文數字「${digit}」，無法對應阿拉伯數字`
  );
  return CHINESE_DIGIT_TO_NUMBER[digit];
}

// 從 `**MUST/MUST NOT/FAIL CLOSED**` 這類 token 清單抽出以 `/` 分隔的項目數。
function countSlashTokens(tokenListText) {
  return tokenListText.split("/").map((token) => token.trim()).filter(Boolean).length;
}

test("AGENTS.md Core Contract：中文數量詞為「三 Immutable」", () => {
  const agents = read("AGENTS.md");
  const line = agents.match(/^.*Immutable.*$/m);
  assert.ok(line, "AGENTS.md 應含有 Core Contract 的 Immutable 行");

  assert.match(
    line[0],
    /三\s*Immutable/,
    `AGENTS.md 的 Immutable 行數量詞應為「三」，實際：${line[0]}`
  );
  assert.doesNotMatch(
    line[0],
    /五\s*Immutable/,
    `AGENTS.md 的 Immutable 行不應殘留舊數量詞「五」，實際：${line[0]}`
  );
});

test("AGENTS.md Core Contract：token 清單數量與中文數量詞一致", () => {
  const agents = read("AGENTS.md");
  const line = agents.match(/^.*Immutable.*$/m);
  assert.ok(line, "AGENTS.md 應含有 Core Contract 的 Immutable 行");

  const quantifierMatch = line[0].match(/([一二三四五六七八九十])\s*Immutable/);
  assert.ok(quantifierMatch, `AGENTS.md 的 Immutable 行缺少中文數量詞，實際：${line[0]}`);
  const expectedCount = chineseDigitToNumber(quantifierMatch[1]);

  const tokenListMatch = line[0].match(/\*\*([^*]+)\*\*/);
  assert.ok(tokenListMatch, `AGENTS.md 的 Immutable 行缺少 **...** token 清單，實際：${line[0]}`);
  const actualCount = countSlashTokens(tokenListMatch[1]);

  assert.equal(
    actualCount,
    expectedCount,
    `AGENTS.md 數量詞「${quantifierMatch[1]}」對應 ${expectedCount}，但 token 清單「${tokenListMatch[1]}」實際有 ${actualCount} 個，兩者須一致`
  );
});

test("README.md Core Contract：阿拉伯數字為「3 Immutables」且 token 清單數一致", () => {
  const readme = read("README.md");
  const line = readme.match(/^.*Core Contract.*Immutables.*$/m);
  assert.ok(line, "README.md 應含有 Core Contract 的 Immutables 行");

  assert.match(
    line[0],
    /3\s*Immutables/,
    `README.md 的 Core Contract 行數量詞應為「3」，實際：${line[0]}`
  );
  assert.doesNotMatch(
    line[0],
    /5\s*Immutables/,
    `README.md 的 Core Contract 行不應殘留舊數量詞「5」，實際：${line[0]}`
  );

  const quantifierMatch = line[0].match(/(\d+)\s*Immutables/);
  assert.ok(quantifierMatch, `README.md 的 Core Contract 行缺少數量詞，實際：${line[0]}`);
  const expectedCount = Number(quantifierMatch[1]);

  const tokenListMatch = line[0].match(/[—-]\s*(MUST[^）)]*)/);
  assert.ok(tokenListMatch, `README.md 的 Core Contract 行缺少 MUST/MUST NOT/FAIL CLOSED token 清單，實際：${line[0]}`);
  const actualCount = countSlashTokens(tokenListMatch[1]);

  assert.equal(
    actualCount,
    expectedCount,
    `README.md 數量詞 ${expectedCount} 與 token 清單「${tokenListMatch[1]}」實際 ${actualCount} 個不一致`
  );
});

test("AGENTS.md 與 README.md 的 Immutable 數量必須互相一致", () => {
  const agents = read("AGENTS.md");
  const readme = read("README.md");

  const agentsLine = agents.match(/^.*Immutable.*$/m);
  assert.ok(agentsLine, "AGENTS.md 應含有 Core Contract 的 Immutable 行");
  const agentsQuantifierMatch = agentsLine[0].match(/([一二三四五六七八九十])\s*Immutable/);
  assert.ok(agentsQuantifierMatch, `AGENTS.md 的 Immutable 行缺少中文數量詞，實際：${agentsLine[0]}`);
  const agentsCount = chineseDigitToNumber(agentsQuantifierMatch[1]);

  const readmeLine = readme.match(/^.*Core Contract.*Immutables.*$/m);
  assert.ok(readmeLine, "README.md 應含有 Core Contract 的 Immutables 行");
  const readmeQuantifierMatch = readmeLine[0].match(/(\d+)\s*Immutables/);
  assert.ok(readmeQuantifierMatch, `README.md 的 Core Contract 行缺少數量詞，實際：${readmeLine[0]}`);
  const readmeCount = Number(readmeQuantifierMatch[1]);

  assert.equal(
    agentsCount,
    readmeCount,
    `AGENTS.md 數量詞「${agentsQuantifierMatch[1]}」(${agentsCount}) 與 README.md 數量詞「${readmeQuantifierMatch[1]}」(${readmeCount}) 必須一致`
  );
});
