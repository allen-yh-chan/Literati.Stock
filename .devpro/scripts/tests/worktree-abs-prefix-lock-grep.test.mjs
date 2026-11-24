/**
 * worktree-abs-prefix-lock-grep.test.mjs
 *
 * Locks Gate D's tightened `checkWorktreeAbsolutePath` in pre-tool-gate.mjs
 * (SC1/R4 from the "strengthen-pretool-gate-invariants" change) so a future
 * refactor cannot silently regress the gate from
 *   "any absolute path passes"
 * back to the pre-hardening posture, by removing the
 *   "must resolve under <repo-root>/.worktree/" boundary check.
 *
 * `checkWorktreeAbsolutePath` itself does NOT resolve repo-root or compare
 * path prefixes inline — it delegates to two helpers:
 *   - `resolveRepoRootForWorktreeGate(baseCwd)` → wraps `gitCommonDir` +
 *     `path.dirname` to derive `<repo-root>`.
 *   - `isUnderRepoRootWorktreeDir(absWtPath, repoRoot)` → does the literal
 *     `.worktree` + `path.sep`-bounded prefix comparison (guards against a
 *     sibling dir like `<repo-root>-evil/.worktree/x` false-passing on a bare
 *     string startsWith).
 *
 * So this guard asserts at TWO levels:
 *   (1) the primary function body still CALLS both helpers (a refactor that
 *       inlines/removes either call, or stops gating on the absolute-path
 *       branch entirely, trips here even if the helper bodies are untouched);
 *   (2) the helper bodies still contain the literal implementation anchors
 *       (`gitCommonDir` call; `.worktree` + `path.sep` boundary check) — a
 *       refactor that guts a helper's internals while leaving the call-site
 *       intact trips here.
 *
 * Extraction is done by locating `function <name>(` and brace-counting to the
 * matching close, rather than scanning the whole file — this avoids false
 * green from an unrelated function elsewhere in the file coincidentally
 * containing the same literal tokens (e.g. `gitCommonDir` is called by many
 * other gates in this file).
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const hookPath = repoPath(".devpro/scripts/hooks/pre-tool-gate.mjs");
const content = readFileSync(hookPath, "utf8");

// Extract a named function's full body (declaration through matching close
// brace) via brace-depth counting. Sufficient for this file's style (no
// unbalanced braces inside string/regex literals within these functions).
function extractFunctionBody(source, fnName) {
  const startMarker = `function ${fnName}(`;
  const startIdx = source.indexOf(startMarker);
  if (startIdx < 0) {
    throw new Error(
      `extractFunctionBody: could not locate "function ${fnName}(" in ${hookPath} — function may have been renamed or removed`
    );
  }
  const braceStart = source.indexOf("{", startIdx);
  let i = braceStart + 1;
  let depth = 1;
  while (depth > 0) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    i++;
  }
  return source.slice(startIdx, i);
}

const primaryBody = extractFunctionBody(content, "checkWorktreeAbsolutePath");
const repoRootHelperBody = extractFunctionBody(content, "resolveRepoRootForWorktreeGate");
const boundaryHelperBody = extractFunctionBody(content, "isUnderRepoRootWorktreeDir");

test("checkWorktreeAbsolutePath 呼叫 resolveRepoRootForWorktreeGate（repo-root 解析不被移除）", () => {
  assert.ok(
    primaryBody.includes("resolveRepoRootForWorktreeGate("),
    "checkWorktreeAbsolutePath 函式體期望呼叫 resolveRepoRootForWorktreeGate(...) 來解析 <repo-root>，未找到 — 若此呼叫被移除，Gate D 會失去 repo-root 錨點，absolute path 分支將無法判斷路徑是否落在 <repo-root>/.worktree/ 之下，等同 Gate D 的收緊被無聲撤回，退回「任何絕對路徑都放行」的舊行為"
  );
});

test("checkWorktreeAbsolutePath 呼叫 isUnderRepoRootWorktreeDir（.worktree 邊界檢查不被移除）", () => {
  assert.ok(
    primaryBody.includes("isUnderRepoRootWorktreeDir("),
    "checkWorktreeAbsolutePath 函式體期望呼叫 isUnderRepoRootWorktreeDir(...) 來判斷絕對路徑是否落在 <repo-root>/.worktree/ 子路徑，未找到 — 若此呼叫被移除或該分支被砍掉，absolute path 分支會退化成單純 `path.isAbsolute(wtPath)` 即放行，等同 Gate D 的收緊被無聲撤回"
  );
});

test("resolveRepoRootForWorktreeGate 呼叫 gitCommonDir（repo-root 解析機制不被替換成弱化實作）", () => {
  assert.ok(
    repoRootHelperBody.includes("gitCommonDir("),
    "resolveRepoRootForWorktreeGate 函式體期望呼叫 gitCommonDir(...) 取得 git common dir 再 path.dirname 得到 <repo-root>，未找到 — 若改用其他（可能不 fail-open 或解析不到 worktree 情境下正確 repo-root 的）方式取得 repo-root，Gate D 的 repo-root 解析基礎會被削弱，且可能破壞既有 fail-open（R4）語意"
  );
});

test("isUnderRepoRootWorktreeDir 含 `.worktree` 字面 + `path.sep` 邊界檢查（防前綴誤判）", () => {
  assert.ok(
    boundaryHelperBody.includes(".worktree") && boundaryHelperBody.includes("path.sep"),
    "isUnderRepoRootWorktreeDir 函式體期望同時含 `.worktree`（worktree 根目錄字面）與 `path.sep`（邊界化前綴比較），未找到 — 若 `path.sep` 邊界檢查被移除、改回裸字串 startsWith 比較，`<repo-root>-evil/.worktree/x` 這類同前綴但非真子路徑的目錄會被誤判為合法 worktree 路徑而放行，等同 Gate D 收緊時特別防的 SC1 邊界漏洞重新出現"
  );
});

test("checkWorktreeAbsolutePath 的 block 訊息含字面 `<repo-root>/.worktree/<change-name>`", () => {
  assert.ok(
    primaryBody.includes("<repo-root>/.worktree/<change-name>"),
    "checkWorktreeAbsolutePath 的 block reason 期望含字面 `<repo-root>/.worktree/<change-name>`，未找到 — 這是使用者被擋下時看到的規範根層慣例提示；若被改寫或移除，使用者收到的錯誤訊息會失去可操作的修正路徑指引"
  );
});
