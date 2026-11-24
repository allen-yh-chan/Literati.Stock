/**
 * remote-review-gateway-grep.test.mjs
 *
 * Locks the contract of `remote-review-gateway.md`:
 *   (a) shared facts (host, port 20222, `rr` runs on the gateway, target, `items` key)
 *   (b) each user's gateway account lives in their own ssh alias, never in the repo
 *   (c) unreachable / unconfigured gateway fails closed with no remote fallback
 *   (d) AGENTS.md and README route to the leaf
 *   (e) the only gateway port mentioned anywhere in the rule corpus is 20222, and no
 *       personal account or key path is embedded in the rules
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { repoPath } from "./lib/repo-root.mjs";
import { DEFAULT_BRIDGE_COMMAND } from "../lib/remote-review-client.mjs";

const leafPath = repoPath(".devpro/agent-rules/remote-review-gateway.md");
const leaf = readFileSync(leafPath, "utf8");
const agents = readFileSync(repoPath("AGENTS.md"), "utf8");
const readme = readFileSync(repoPath("README.md"), "utf8");

function markdownFilesUnder(relativeDir) {
  const root = repoPath(relativeDir);
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) found.push(full);
    }
  };
  walk(root);
  return found;
}

test("leaf 含共用事實：host、port 20222、rr 在 gateway、target 與 items 鍵", () => {
  for (const anchor of [
    "demo.devpro.com.tw",
    "**20222**",
    "`rr` 是 gateway 上的指令",
    "`rr skill`",
    "`devpro-demo-01`",
    "`items`",
    "`hermes-agent`",
  ]) {
    assert.ok(leaf.includes(anchor), `remote-review-gateway.md 缺少錨點：${anchor}`);
  }
});

test("leaf 以 ssh alias 承載個人帳號，範本只用 placeholder", () => {
  assert.match(leaf, /Host devpro-runnerrelay/);
  assert.match(leaf, /User <your-gateway-user>/);
  assert.match(leaf, /IdentityFile <your-private-key>/);
  assert.ok(leaf.includes("ssh devpro-runnerrelay rr <子命令>"));
  assert.ok(leaf.includes("MUST NOT** 猜帳號"));
});

test("leaf 區分 catalog 與 target shell 兩種登入，第二個 alias 只用 placeholder", () => {
  assert.match(leaf, /Host devpro-runnerrelay-demo/);
  assert.match(leaf, /User <your-gateway-user>\+devpro-demo-01/);
  assert.ok(leaf.includes("`<principal>+devpro-demo-01` 是 target shell"));
  assert.ok(leaf.includes("沒有送審類子命令"));
  assert.ok(leaf.includes("不是 gateway principal，也不是 `hermes-agent`"));
});

test("leaf 不把缺 alias 當停點：可用完整指令，使用者已提供的輸入直接用", () => {
  assert.ok(leaf.includes("沒設 alias 本身不是停點"));
  assert.ok(leaf.includes("有就直接用於本次連線，不再追問"));
  assert.ok(leaf.includes("MUST NOT** 未經同意自行寫入 ssh config"));
});

test("leaf 規定送審入口：只支援兩種模式、pr-sticky 拒絕、不重鑄 sealed evidence", () => {
  assert.ok(leaf.includes("node .devpro/scripts/run-remote-review.mjs"));
  assert.ok(leaf.includes("`pr-sticky` 遠端**拒絕**"));
  assert.ok(leaf.includes("`target_dirty`"));
  assert.ok(leaf.includes("`sealed_admission: false`"));
  assert.ok(leaf.includes("MUST NOT** 重鑄成本機 sealed control evidence"));
});

test("leaf 規定 submit 走 Gateway 自有 verb：無 PTY、恰好三個字、不退回直接呼叫 bridge", () => {
  assert.ok(leaf.includes("`submit` 以 `ssh -T`（無 PTY）執行恰好 `hermes review submit`"));
  assert.ok(leaf.includes("用換行、Unicode 空白分隔，都不是這個 verb"));
  assert.ok(leaf.includes("`request id:` 是診斷，不是失敗"));
  assert.ok(leaf.includes("MUST NOT** 為了繞過錯誤改回直接呼叫 bridge 的 `submit`"));
  assert.ok(leaf.includes("替 `hermes review submit` 簽發建立者 proof"));
});

test("leaf 規定建立者語意：不透明代號、null 不是失敗、不宣稱匿名或 ACL 隔離、原值只留伺服器端", () => {
  assert.ok(leaf.includes("`creator_ref`（16 位小寫 hex）"));
  assert.ok(leaf.includes("`null` 表示「沒有記錄建立者」"));
  assert.ok(leaf.includes("不是失敗，**MUST NOT** 補填或推測"));
  assert.ok(leaf.includes("代號不是匿名"));
  assert.ok(leaf.includes("原值只存在伺服器端"));
  assert.ok(leaf.includes("偽造可被發現、但無法防抹除"));
  assert.ok(leaf.includes("**MUST NOT** 宣稱 ACL 隔離"));
});

test("leaf 區分送出前的拒絕與可能已送出的失敗，後者用同一個 request id 重試", () => {
  assert.ok(leaf.includes("exit 2、3 是送出前的拒絕"));
  assert.ok(leaf.includes("`gateway_review_unavailable`"));
  assert.ok(leaf.includes("exit 4–6（例如 `gateway_result_unknown`）可能已送出"));
  assert.ok(leaf.includes("用同一個 `--request-id` 重試"));
});

test("leaf 寫的 bridge wrapper 位置就是 client 的預設值；其餘四個子命令不是權限邊界", () => {
  assert.ok(leaf.includes(`\`${DEFAULT_BRIDGE_COMMAND}\`（client 內建為預設，不必設定；可用 \`DEVPRO_REMOTE_REVIEW_BRIDGE_COMMAND\` 覆寫）`));
  assert.ok(leaf.includes("`status`／`result`／`cancel`／`purge` 不帶建立者 proof"));
  assert.ok(leaf.includes("那是防呆，不是權限邊界，**MUST NOT** 宣稱只有建立者能取消或清除"));
  assert.ok(leaf.includes("`review-bridge.cmd` 沒裝（其餘四個子命令回 `transport_failed`）即 unavailable"));
});

test("leaf 規定首次設定才寫入：離線 ssh -G 檢查、同意後追加、不覆寫", () => {
  assert.ok(leaf.includes("只在首次設定寫一次"));
  assert.ok(leaf.includes("`ssh -G devpro-runnerrelay`"));
  assert.ok(leaf.includes("MUST NOT** 未經同意自行寫入"));
  assert.ok(leaf.includes("**追加**"));
  assert.ok(leaf.includes("不覆寫"));
});

test("leaf 涵蓋 Windows：config 位置、寫檔編碼、金鑰 ACL 交棒", () => {
  assert.ok(leaf.includes("%USERPROFILE%\\.ssh\\config"));
  assert.ok(leaf.includes("Out-File"));
  assert.ok(leaf.includes("UNPROTECTED PRIVATE KEY FILE"));
  assert.ok(leaf.includes("Bad owner or permissions"));
});

test("leaf fail closed：不退回其他通道、不放寬權限、不讓 Hermes 代下 verdict", () => {
  assert.ok(leaf.includes("### Fail Closed"));
  assert.ok(leaf.includes("遠端審查 **unavailable**"));
  assert.ok(leaf.includes("MUST NOT** 試其他 port"));
  assert.ok(leaf.includes("MUST NOT** 改用任何本機 reviewer CLI 探測或 fallback"));
  assert.ok(leaf.includes("MUST NOT** 由 Hermes 自行給 verdict"));
  assert.ok(leaf.includes("`StrictHostKeyChecking no`"));
  assert.ok(leaf.includes("`stop-point-comms.md`"));
});

test("leaf 的 unavailable 條件與完成條件跟「沒設 alias 不是停點」一致（alias 與直連 ssh 兩種形式都算）", () => {
  assert.ok(leaf.includes("沒設 alias 本身不是停點"));
  assert.ok(!leaf.includes("alias 不存在、"), "alias 不存在不能單獨構成 unavailable");
  const failClosed = leaf.slice(leaf.indexOf("### Fail Closed"), leaf.indexOf("## Exit Criteria"));
  assert.ok(failClosed.includes("使用者也沒給直連 ssh 參數"));
  const exit = leaf.slice(leaf.indexOf("## Exit Criteria"), leaf.indexOf("## Common Rationalizations"));
  assert.ok(exit.includes("`ssh -G devpro-runnerrelay`"));
  assert.ok(exit.includes("未設 alias 時"), "完成條件要涵蓋直連 ssh 形式");
});

test("AGENTS.md 觸發索引與 README 規則表都指向 leaf", () => {
  assert.match(agents, /\|遠端審查[^\n]*\|`remote-review-gateway\.md`\|/);
  assert.ok(readme.includes("(.devpro/agent-rules/remote-review-gateway.md)"));
});

test("規則與 skill 語料不含 20022、個人帳號、金鑰路徑或本機絕對路徑", () => {
  const corpus = [
    ...markdownFilesUnder(".devpro/agent-rules"),
    ...markdownFilesUnder(".devpro/agent-skills"),
    repoPath("AGENTS.md"),
    repoPath("README.md"),
  ];
  const forbidden = [
    [/\b20022\b/, "只能提 20222"],
    [/[A-Za-z0-9._-]+@demo\.devpro\.com\.tw/, "user@host 形式的個人帳號"],
    [/ssh\s+-i\s/, "寫死金鑰路徑的 ssh 指令"],
    [/\/Users\/[A-Za-z0-9][A-Za-z0-9._-]*/, "本機絕對路徑（字面 /Users/... 禁令句不算）"],
  ];
  for (const file of corpus) {
    const text = readFileSync(file, "utf8");
    for (const [pattern, why] of forbidden) {
      assert.ok(!pattern.test(text), `${path.relative(repoPath("."), file)} 含禁用內容（${why}）`);
    }
  }
});
