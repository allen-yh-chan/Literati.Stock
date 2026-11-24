/**
 * sql-server-string-encoding-rule-guard.test.mjs
 *
 * Locks high-stakes phrases from `.devpro/agent-rules/database-conventions.md`
 * and `AGENTS.md` so they cannot be silently dropped during a refactor.
 *
 * Phrases registered by change `strengthen-sql-server-string-encoding`:
 * - "UTF-16LE": 編碼語意 anchor；防 trim
 * - "Encoding.Unicode": C# 正確編碼 anchor
 * - "中文 roundtrip": 測試要求 anchor；防退化為 ASCII-only
 * - "issue #853": traceability anchor
 * - "SQL Server 字串↔binary": AGENTS 觸發索引入口
 *
 * Pattern derived from `chore-classification-contract-guard.test.mjs`.
 * Removing or renaming any guarded phrase requires an amend change that
 * updates this list.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const CHECKS = [
  {
    file: ".devpro/agent-rules/database-conventions.md",
    phrase: "UTF-16LE",
    purpose: "編碼語意 anchor；防 trim",
  },
  {
    file: ".devpro/agent-rules/database-conventions.md",
    phrase: "Encoding.Unicode",
    purpose: "C# 正確編碼 anchor",
  },
  {
    file: ".devpro/agent-rules/database-conventions.md",
    phrase: "中文 roundtrip",
    purpose: "測試要求 anchor；防退化為 ASCII-only",
  },
  {
    file: ".devpro/agent-rules/database-conventions.md",
    phrase: "issue #853",
    purpose: "traceability anchor",
  },
  {
    file: "AGENTS.md",
    phrase: "SQL Server 字串↔binary",
    purpose: "AGENTS 觸發索引入口",
  },
];

describe("sql-server-string-encoding-rule-guard", () => {
  describe("Critical phrases must appear in their respective files", () => {
    for (const { file, phrase, purpose } of CHECKS) {
      it(`'${phrase}' is present in ${file}`, async () => {
        const filePath = repoPath(file);
        const content = await fs.readFile(filePath, "utf8");
        assert.ok(
          content.includes(phrase),
          [
            `違規：phrase「${phrase}」在 ${file} 搜不到。`,
            `用途：${purpose}`,
            `本 phrase 由 strengthen-sql-server-string-encoding change 註冊保護；trim 前須走 amend change 並更新本測試。`,
          ].join("\n"),
        );
      });
    }
  });
});
