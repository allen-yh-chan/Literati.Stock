import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";

/**
 * Guarantee ceiling (cooperative-only).
 *
 * Locks: literal presence of the encoding and web-data-safety anchors in
 * `.devpro/agent-rules/security-coding.md` (section headings and named APIs).
 * Does NOT prove: that emitted code follows those rules, that a paraphrase
 * carrying the same meaning is accepted or rejected correctly, or that no
 * paragraph elsewhere in the carrier contradicts an intact anchor. Deleting an
 * anchor fails this file; inverting the meaning around an intact anchor does
 * not. Review owns that half.
 */


test("security-coding.md contains 外部參數 URL 編碼 section heading", () => {
  const content = read(".devpro/agent-rules/security-coding.md");
  assert.match(content, /###\s+外部參數 URL 編碼/);
});

test("security-coding.md contains Uri.EscapeDataString", () => {
  const content = read(".devpro/agent-rules/security-coding.md");
  assert.match(content, /Uri\.EscapeDataString/);
});

test("security-coding.md contains 不可假設 and ASCII-safe", () => {
  const content = read(".devpro/agent-rules/security-coding.md");
  assert.match(content, /不可假設/);
  assert.match(content, /ASCII-safe/);
});

test("security-coding.md is the Web data access security SSOT", () => {
  const content = read(".devpro/agent-rules/security-coding.md");
  assert.match(content, /網頁開發安全性的 SSOT/);
  assert.match(content, /Web 資料存取安全/);
  assert.match(content, /URL encode/);
});

test("security-coding.md covers AJAX stale response and debounce limits", () => {
  const content = read(".devpro/agent-rules/security-coding.md");
  assert.match(content, /後發先至/);
  assert.match(content, /Debounce \/ throttle/);
  assert.match(content, /不是完整防線/);
  assert.match(content, /AbortController/);
  assert.match(content, /sequence id|latest token/);
});

test("security-coding.md covers URL object-level authorization", () => {
  const content = read(".devpro/agent-rules/security-coding.md");
  assert.match(content, /URL 參數不可作授權依據/);
  assert.match(content, /object-level authorization/);
  assert.match(content, /IDOR \/ BOLA/);
  assert.match(content, /route guard.*UX guard/);
});

test("frontend-session.md delegates Web data security to security-coding.md", () => {
  const content = read(".devpro/agent-rules/frontend-session.md");
  assert.match(content, /Web 資料存取安全/);
  assert.match(content, /security-coding\.md/);
  assert.match(content, /本檔只管 session \/ Cookie \/ CORS mechanics/);
});

test("codex.md 風險 G contains NuGet feed example", () => {
  const content = read(".devpro/agent-rules/platform-adapters/codex.md");
  assert.match(content, /api\.nuget\.org|nuget\.devexpress\.com|lookup api\.nuget\.org/);
});


test("URL encoding examples preserve the credential query prohibition", () => {
  const content = read(".devpro/agent-rules/security-coding.md");
  const protection = content.split("### Query String 個資保護")[1].split("### 外部參數 URL 編碼")[0];
  assert.match(protection, /禁止[^\n]*query string[^\n]*API 金鑰[^\n]*token/);
  const encoding = content.split("### 外部參數 URL 編碼")[1].split("\n### ")[0];
  assert.match(encoding, /編碼[^\n]*不豁免[^\n]*query string[^\n]*PII[^\n]*憑證禁令/);
  const example = encoding.match(/```csharp\n([\s\S]*?)\n```/)[1];
  assert.doesNotMatch(example, /apiKey|\?key=|&key=/);
  assert.match(example, /Uri\.EscapeDataString\(providerCode\)/);
  assert.match(example, /Uri\.EscapeDataString\(callbackRef\)/);
});
