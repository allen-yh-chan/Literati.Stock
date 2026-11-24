/**
 * force-push-verify-head-grep.test.mjs
 *
 * Locks the "Force-Push 前：驗 HEAD 內容匹配預期修正" anchors in
 * git-branch-hygiene.md so a future edit cannot silently drop the pre-force-push
 * content-verification discipline:
 *   (a) force-push 改寫已推歷史前 MUST 先驗 HEAD 實際內容含預期修正
 *   (b) MUST NOT 只憑 amend-exit / push-exit 綠色 exit code 判定修正已落 commit
 *   (c) 提供 `git show HEAD:<file>` 內容驗法示範
 *   (d) 與下方 §Squash-Source Cleanup（治 force-push 後清理）區分為「接續非重複」
 *
 * 目的：防止把「force-push 前驗 HEAD 內容匹配預期修正」的強制前置閘退化回
 * 「只信 exit code 就 force-push」的舊行為（本 session PR #1450 首推漏修正 commit
 * 覆蓋正確歷史之根因）。
 *
 * ── Guard 強度邊界（設計取捨，非缺陷）──────────────────────────────
 * 本 guard 的職責是攔「意外漂移 / 錨點被移除 / refactor 把 token 拆到無關行後
 * 偽陽」這類 *realistic* 退化。polarity 錨點（test 2 exit-code、test 3 primary、
 * test 4 diff）用**同一物理行** compound regex 綁定，封掉「token 由跨檔無關行供給
 * 而偽陽」的路徑（cross-model 前三輪 findings 之類）。
 * 但 grep-guard **無法**機械證明一條自然語言規則沒有被「語意反轉但 token 全保留在
 * 同一行」地竄改（例：把「MUST 停下、不 push」改成「不必停下、不 push 亦非必須」——
 * token `停下`/`不 push` 仍在同行，任何 token-presence check 都會偽陽）。這是
 * grep-guard 的**根本極限**，非本檔缺陷；對抗「刻意語意反轉」屬 code review / cross-
 * model 人審職責，不是機械 anchor guard 能涵蓋。structural-existence 錨點（test 1
 * 段標題、test 6 `接續非重複` 區分句）本質不可被 token-preserving 反轉攻擊，維持
 * 直接 includes 即足。
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const leafPath = repoPath(".devpro/agent-rules/git-branch-hygiene.md");
const content = readFileSync(leafPath, "utf8");

test("git-branch-hygiene.md 含「Force-Push 前」驗證段標題 + 驗 HEAD 實際內容錨點", () => {
  assert.ok(
    content.includes("Force-Push 前：驗 HEAD 內容匹配預期修正") &&
      content.includes("HEAD commit **實際內容**"),
    "git-branch-hygiene.md 期望含「Force-Push 前：驗 HEAD 內容匹配預期修正」段標題 + 「驗 HEAD commit 實際內容」錨點，未找到 — force-push 前驗內容紀律可能被移除"
  );
});

test("exit code 綠不足錨點：MUST NOT 只憑 amend/push exit 判定修正已落", () => {
  // Compound：`MUST NOT`、`只憑`、`exit`（amend-exit / push-exit）三者必須同一物理行。
  // 舊版用三個 cross-file 獨立 content.includes，可被 token-preserving 弱化偽陽：把規則反轉成
  // 「可只憑 …exit… 判定」時，`MUST NOT` 由別行（git diff 那條）供、`只憑` 由弱化句自身的
  // 「可只憑」供、`exit` 由 fail-handling 句（amend 漏 stage…）供，三 token 仍全在檔內 → 偽陽。
  // 單一 regex + `[^\n]*` 禁跨行，強制三者綁在 exit-code 規則那一句，反轉語意即轉紅。
  const exitInsufficientClause = /MUST NOT[^\n]*只憑[^\n]*exit|MUST NOT[^\n]*exit[^\n]*只憑/;
  assert.ok(
    exitInsufficientClause.test(content),
    "期望「**MUST NOT** 只憑 `amend-exit=0` / `push-exit=0` 判定」三者同一物理行綁定，未找到 — 若 exit-code-不足論述被反轉（如弱化成『可只憑 exit 判定』）或三 token 被拆到不同行，guard 會偽陽放行反轉規則語意的弱化"
  );
});

test("內容驗法示範錨點：git show HEAD:<file> | grep 為必用 primary", () => {
  // Compound：`必用（primary）`、`git show HEAD:`、`| grep` 三者必須綁在**同一物理行**。
  // `| grep` 不可省——primary 驗法的整個重點是「讀 blob 內容並 grep 錨點」，只 `git show
  // HEAD:<file>` 不夾 grep 只證明檔案存在、不證明內容含修正。單一 regex（無 bare 替代式），
  // `[^\n]*` 禁跨行，防 token-preserving 弱化（把 primary 標記搬離 show、或砍掉 `| grep`）。
  const primaryClause =
    /必用（primary）[^\n]*`git show HEAD:[^\n]*\| ?grep|`git show HEAD:[^\n]*\| ?grep[^\n]*必用（primary）/;
  assert.ok(
    primaryClause.test(content),
    "期望「**必用（primary）** + `git show HEAD:<改動檔>` + `| grep <錨點>`」三者同一物理行綁定（唯一能證明 HEAD blob 含修正；`| grep` 不可省，否則只證明檔案存在不證明內容），未找到 — 若 primary 標記被搬離 show、或砍掉 `| grep` 內容驗證部分，force-push 前驗證的核心 invariant 會被弱化"
  );
});

test("diff 非替代錨點：git diff MUST NOT 單獨當驗法（同句綁定）", () => {
  // Compound：`git diff`、`MUST NOT`、`單獨當驗法` 三者必須依序出現在**同一物理行**。
  // 單一 regex、無 bare 替代式——舊版有個 `/`git diff`[^\n]*單獨當驗法/` 替代式會 match
  // 到「diff 可單獨當驗法」這種**反轉規則語意**的弱化行（因 `MUST NOT` 另存在於 exit-code
  // 句，獨立 content.includes 會偽陽）。移除該替代式並拿掉獨立 includes，強制 `MUST NOT`
  // 必須與 `git diff`+`單獨當驗法` 同物理行。
  const diffNotSubstitute = /`git diff[^\n]*MUST NOT[^\n]*單獨當驗法/;
  assert.ok(
    diffNotSubstitute.test(content),
    "期望「`git diff` … MUST NOT … 單獨當驗法」三者同一物理行綁定（diff 可能把預期行顯示為刪除/只顯示鄰近改動，未證明 HEAD blob 含錨點），未找到 — 若 diff 被允許單獨驗證（例如弱化成『diff 可單獨當驗法』），規則會退化成無法證明 HEAD 實際內容含修正的弱驗法"
  );
});

test("驗證失敗處置錨點：停下重 stage/amend、不 push", () => {
  assert.ok(
    content.includes("停下") &&
      content.includes("不 push"),
    "期望含「驗證失敗 → 停下重 stage / amend，不 push」處置錨點，未找到 — fail-closed 停下語意可能退化"
  );
});

test("接續非重複錨點：與 §Squash-Source Cleanup（force-push 後）區分", () => {
  assert.ok(
    content.includes("接續非重複") &&
      content.includes("force-push **後**"),
    "期望含「本段治 force-push 前驗內容，與 §Squash-Source Cleanup 治 force-push 後清理是接續非重複」區分錨點，未找到 — 兩段可能被誤判為重複而合併"
  );
});
