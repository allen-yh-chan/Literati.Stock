import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";

/**
 * Guarantee ceiling (cooperative-only).
 *
 * Locks: literal convergence of the two invariants in
 * `.devpro/agent-rules/security-coding.md` — application logs MUST NOT carry PII,
 * and the access-audit trail MUST carry client context — plus absence of raw
 * logging patterns the file names.
 * Does NOT prove: that a given log statement in application code satisfies the
 * invariant, that a reworded rule is judged correctly, or that no contradicting
 * passage exists elsewhere in the carrier. Review owns that half.
 */
const changeName = "add-client-context-audit-trail";

function readIfExists(relPath) {
  const fullPath = repoPath(relPath);
  return existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
}

// 從 startHeading 切到下一個 heading（任意層級）為止，避免斷言在整檔範圍內
// 被 Exit Criteria／Verification 區塊對同一字面的逐字複述代償（mutation 審計
// 要求：刪掉 operative 行時，斷言必須真的轉紅，而非被別處複述頂住）。
function sliceSection(content, startHeading) {
  const startIdx = content.indexOf(startHeading);
  assert.ok(startIdx !== -1, `missing section heading: ${startHeading}`);
  const rest = content.slice(startIdx + startHeading.length);
  const nextHeadingMatch = rest.match(/\n#{1,6} /);
  return nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest;
}

// 刻意不 union archive：change 一旦 archive，canonical spec 承接內容，
// active delta 會消失；若 union 進 archive 副本，日後 canonical 被刪也測不出來。
// canonical 用 readIfExists（非 read）：security-access-audit-trail 是全新 capability，
// archive 前 canonical 尚不存在，用會 throw 的 read() 會誤判為測試錯誤而非「符合預期的
// pre-archive 狀態」；archive 後 canonical 出現、delta 消失，readIfExists 兩種狀態皆正確覆蓋。
function readSpecWithDelta(capability) {
  const canonical = readIfExists(`openspec/specs/${capability}/spec.md`);
  const activeDelta = readIfExists(`openspec/changes/${changeName}/specs/${capability}/spec.md`);
  return [canonical, activeDelta].join("\n");
}

test("security-access-audit-trail.md carries the 區辨術語 and 七個必備欄位字面 as table rows", () => {
  const content = read(".devpro/agent-rules/security-access-audit-trail.md");
  assert.match(content, /存取稽核軌跡/);
  // 只在「必備欄位契約表」小節內斷言，且要求 table-row 形狀（`| 欄位 |`）——
  // 避免被 Exit Criteria/Verification 的逐字複述、或「宣告式法遵四項」段落
  // 對「事件」「Client IP」等字面的巧合命中代償。
  const fieldTableSection = sliceSection(content, "### 必備欄位契約表");
  for (const field of ["時間戳", "Client IP", "Peer IP", "來源 Port", "User-Agent", "主體", "事件"]) {
    const rowPattern = new RegExp(`^\\|\\s*${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|`, "m");
    assert.match(fieldTableSection, rowPattern, `missing field table row: ${field}`);
  }
});

test("security-access-audit-trail.md forbids RemotePort/X-Forwarded-Port as client source port and cites the legitimate extraction paths", () => {
  const content = read(".devpro/agent-rules/security-access-audit-trail.md");
  // 只在「擷取點與 XFF 信任邊界」小節內斷言，避免被 Exit Criteria/Verification
  // 對同一批 anchor 片語的逐字複述代償。
  const xffSection = sliceSection(content, "### 擷取點與 XFF 信任邊界");
  assert.ok(
    xffSection.includes("MUST NOT 以 RemotePort 或 X-Forwarded-Port 作為客戶端來源埠"),
    "missing exact MUST NOT literal in XFF section"
  );
  assert.ok(xffSection.includes("RFC 7239"), "missing RFC 7239 literal in XFF section");
  // 綁 backtick 包住的裸 token，而非子字串 "Forwarded"——後者是
  // "X-Forwarded-Port"/"X-Forwarded-For" 的子字串，刪掉合法路徑那句仍會誤判通過。
  assert.ok(xffSection.includes("`Forwarded`"), "missing bare `Forwarded` token in XFF section");
  assert.ok(xffSection.includes("邊緣側擷取"), "missing 邊緣側擷取 literal in XFF section");
});

test("security-access-audit-trail.md requires edge header rewrite, rightmost-hop selection, and fail-closed parse handling", () => {
  const content = read(".devpro/agent-rules/security-access-audit-trail.md");
  const xffSection = sliceSection(content, "### 擷取點與 XFF 信任邊界");
  assert.ok(
    xffSection.includes("必須在轉發前剝除或覆寫"),
    "missing edge header strip/overwrite requirement in XFF section"
  );
  assert.ok(xffSection.includes("由右至左"), "missing rightmost-hop-first selection literal in XFF section");
  assert.ok(xffSection.includes("ForwardLimit"), "missing ForwardLimit literal in XFF section");
  assert.ok(xffSection.includes("必須 fail-closed"), "missing fail-closed parse-failure requirement in XFF section");
});

test("security-access-audit-trail.md disclosure ban uses placeholder literals", () => {
  const content = read(".devpro/agent-rules/security-access-audit-trail.md");
  const disclosureSection = sliceSection(content, "### 披露禁令");
  assert.ok(disclosureSection.includes("<client-ip>"), "missing <client-ip> placeholder literal in 披露禁令 section");
  assert.ok(disclosureSection.includes("<user-agent>"), "missing <user-agent> placeholder literal in 披露禁令 section");
});

test("security-coding.md has zero raw 'audit trail' literal (disambiguation regression guard)", () => {
  const content = read(".devpro/agent-rules/security-coding.md");
  assert.ok(!content.includes("audit trail"), "regression: raw 'audit trail' literal reappeared in security-coding.md");
});

test("security-coding.md converges both invariants: 應用程式 log MUST NOT PII, 存取稽核軌跡 MUST carry client context", () => {
  const content = read(".devpro/agent-rules/security-coding.md");
  assert.ok(content.includes("應用程式 log"), "missing 應用程式 log literal");
  assert.ok(content.includes("存取稽核軌跡"), "missing 存取稽核軌跡 literal");
});

test("security-access-audit-trail capability spec (delta) declares the Client Context Access Audit Trail requirement", () => {
  const body = readSpecWithDelta("security-access-audit-trail");
  assert.ok(body.includes("### Requirement: Client Context Access Audit Trail"), "missing capability requirement title");
  assert.ok(body.includes("Client IP"), "missing Client IP literal in spec");
});

test("security-access-audit-trail capability spec (delta) declares the client-supplied forwarding chain negative scenario", () => {
  const body = readSpecWithDelta("security-access-audit-trail");
  assert.ok(
    body.includes("#### Scenario: Client-supplied forwarding chain is not trusted verbatim"),
    "missing client-supplied forwarding chain negative scenario title"
  );
  assert.ok(body.includes("ForwardLimit"), "missing ForwardLimit literal in spec scenario");
});

test("code-review-checklist capability spec (delta) declares the sub-check requirement", () => {
  const body = readSpecWithDelta("code-review-checklist");
  assert.ok(
    body.includes("### Requirement: Client Context Access Audit Trail Sub-check"),
    "missing sub-check requirement title"
  );
});
