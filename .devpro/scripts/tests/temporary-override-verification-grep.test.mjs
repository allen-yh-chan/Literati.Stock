// Issue #3527: a verification run that temporarily overrides environment
// settings must prove the override stayed in effect for the whole run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSourceFile as read } from "./lib/read.mjs";

const HEADING = "### 臨時改環境設定的驗證（設定全程生效）";

function section(content, heading) {
  const start = content.indexOf(heading);
  assert.notEqual(start, -1, `missing ${heading}`);
  const next = content.indexOf("\n### ", start + heading.length);
  return content.slice(start, next === -1 ? undefined : next);
}

test("testing-and-qa.md requires the temporary override to stay in effect", () => {
  const content = read(".devpro/agent-rules/testing-and-qa.md");
  const body = section(content, HEADING);
  assert.match(body, /compose override、環境變數、feature flag、設定檔/);
  assert.match(
    body,
    /^1\. 套用前先讀測試腳本，確認它會不會重建或重啟被測服務；會的話，把 override 放進腳本實際讀的設定來源（例如 `COMPOSE_FILE`）/m,
  );
  assert.match(
    body,
    /^2\. 測試前後各斷言一次：被測實例身分不變（container id／PID），生效設定值等於 override 值；把兩次斷言結果寫進驗證證據/m,
  );
  assert.match(
    body,
    /^3\. 任一斷言失敗，或證據裡沒有這兩次斷言，該次結果作廢，不得當驗收證據/m,
  );
  // It sits right after the basic real-path probe gate, before the whitespace gate.
  assert.ok(content.indexOf("### 基本功能探針 Gate") < content.indexOf(HEADING));
  assert.ok(content.indexOf(HEADING) < content.indexOf("### Committed-Diff Whitespace Push Gate 有效範圍"));
});

test("ci-cd-integration-deployment.md E2E workflow points to the override rule", () => {
  const content = read(".devpro/agent-rules/ci-cd-integration-deployment.md");
  const e2e = section(content, "#### e2e-integration.yml（部署成功後自動觸發）");
  assert.match(e2e, /`testing-and-qa\.md` §臨時改環境設定的驗證/);
  assert.match(e2e, /測試前後斷言設定仍生效/);
});
