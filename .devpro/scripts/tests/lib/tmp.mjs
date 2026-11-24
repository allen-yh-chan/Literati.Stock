import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Explicit full-change BRD fixture for tests whose subject is not BRD validation.
 * Keep this static instead of deriving it from the production heading list, so
 * a production drift cannot make unrelated fixtures silently bless themselves.
 */
export const VALID_BRD_FIXTURE = [
  "# BRD: fixture",
  "## 問題陳述\n\nfixture",
  "## 業務目標\n\nfixture",
  "## 功能需求\n\nfixture",
  "## 非功能需求\n\nfixture",
  "## 範圍界定\n\nfixture",
  "## 限制與假設\n\nfixture",
  "## 成功標準\n\nfixture",
  "## 風險\n\nfixture",
  "## 現況分析\n\nfixture",
  "## 先前嘗試\n\nfixture",
  "## Pre-flight 驗證結果表\n\nfixture",
  "## 分支資訊\n\nfixture",
].join("\n\n") + "\n";

/** Create a unique temp directory. Caller owns cleanup unless using withTempDir. */
export function makeTempDir(prefix = "devpro-") {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Run fn(dir) in a temp directory and always rmSync it afterwards. */
export async function withTempDir(fn, { prefix } = {}) {
  const dir = makeTempDir(prefix);
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
