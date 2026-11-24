// Tests for Gate P (OpenSpec doc PII pre-write block) — issue #706.
//
// Scope: pre-write block of Edit/Write/MultiEdit targeting
// openspec/changes/<X>/(meeting-notes|brd|proposal|proposal-mini|tasks|qa-test-scope|decisions).md when the
// NEW content contains canonical PII patterns (email / Unix /Users/ or /home/
// + lowercase letter / Windows C:\Users\ + lowercase letter). Archive paths
// are exempt. Email allowlist covers RFC 2606 reserved example domains and
// anthropic.com (commit-footer noreply).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  OPENSPEC_DOC_PATH_RE,
  PII_EMAIL_RE,
  PII_EMAIL_ALLOW_RE,
  PII_UNIX_USERS_RE,
  PII_UNIX_HOME_RE,
  PII_WINDOWS_USERS_RE,
  findPIIHits,
  simulatePostWriteContent,
  checkOpenSpecDocPII,
} from "../hooks/pre-tool-gate.mjs";

const HOOK_SOURCE_URL = new URL("../hooks/pre-tool-gate.mjs", import.meta.url);

function moduleDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function loadHookWithClassifier(classifierBody) {
  let source = readFileSync(HOOK_SOURCE_URL, "utf8");
  const realPiiUrl = new URL("../lib/pii-pattern-contract.mjs", import.meta.url).href;
  const stub = moduleDataUrl(`
    export const PII_EMAIL_RE = /email/g;
    export const PII_EMAIL_ALLOW_RE = /allow/i;
    export const PII_UNIX_USERS_RE = /users/g;
    export const PII_UNIX_HOME_RE = /home/g;
    export const PII_WINDOWS_USERS_RE = /windows/gi;
    export { isValidHitResult } from ${JSON.stringify(realPiiUrl)};
    export function findPIIHits() { ${classifierBody} }
  `);
  let sharedReplacements = 0;
  source = source.replace(
    /(["'])\.\.\/lib\/pii-pattern-contract\.mjs\1/,
    () => {
      sharedReplacements += 1;
      return JSON.stringify(stub);
    },
  );
  assert.equal(sharedReplacements, 1, "Gate P must import the shared PII leaf exactly once");
  source = source.replace(
    /from\s+(["'])(\.\.?\/[^"']+)\1/g,
    (_match, _quote, specifier) => `from ${JSON.stringify(new URL(specifier, HOOK_SOURCE_URL).href)}`,
  );
  source = source.replaceAll("import.meta.url", JSON.stringify(HOOK_SOURCE_URL.href));
  return import(`${moduleDataUrl(`${source}\n// fault-${Math.random()}`)}`);
}

describe("Gate P — OpenSpec doc PII gate", () => {
  describe("path matcher", () => {
    it("matches meeting-notes.md inside active change folder", () => {
      assert.ok(
        OPENSPEC_DOC_PATH_RE.test("openspec/changes/add-foo/meeting-notes.md")
      );
    });

    it("matches brd.md / proposal.md / proposal-mini.md inside active change folder", () => {
      assert.ok(OPENSPEC_DOC_PATH_RE.test("openspec/changes/add-foo/brd.md"));
      assert.ok(OPENSPEC_DOC_PATH_RE.test("openspec/changes/add-foo/proposal.md"));
      assert.ok(
        OPENSPEC_DOC_PATH_RE.test("openspec/changes/add-foo/proposal-mini.md")
      );
    });

    it("matches tasks.md / qa-test-scope.md / decisions.md inside active change folder", () => {
      assert.ok(OPENSPEC_DOC_PATH_RE.test("openspec/changes/add-foo/tasks.md"));
      assert.ok(
        OPENSPEC_DOC_PATH_RE.test("openspec/changes/add-foo/qa-test-scope.md")
      );
      assert.ok(
        OPENSPEC_DOC_PATH_RE.test("openspec/changes/add-foo/decisions.md")
      );
    });

    it("does NOT match unrelated paths", () => {
      assert.ok(!OPENSPEC_DOC_PATH_RE.test("README.md"));
      assert.ok(!OPENSPEC_DOC_PATH_RE.test(".devpro/agent-rules/foo.md"));
      assert.ok(!OPENSPEC_DOC_PATH_RE.test("openspec/specs/foo/spec.md"));
      // make-vs-buy.md is intentionally excluded (low-frequency conditional
      // output; dp-architect C2 decision: does not meet ROI bar for Gate P).
      assert.ok(
        !OPENSPEC_DOC_PATH_RE.test("openspec/changes/add-foo/make-vs-buy.md")
      );
    });

    it("does NOT match archive paths (extra dir level breaks the single-segment regex)", () => {
      // Archive structure adds a date-name dir: archive/<date>-<name>/<doc>.md.
      // The path regex has only one [^/]+ segment, so archive paths fall
      // through naturally. Gate also has a defensive changeFolder === 'archive'
      // check for safety. New file names placed under archive also stay exempt.
      assert.ok(
        !OPENSPEC_DOC_PATH_RE.test(
          "openspec/changes/archive/2026-05-17-x/meeting-notes.md"
        )
      );
      assert.ok(
        !OPENSPEC_DOC_PATH_RE.test(
          "openspec/changes/archive/2026-05-17-x/tasks.md"
        )
      );
      assert.ok(
        !OPENSPEC_DOC_PATH_RE.test(
          "openspec/changes/archive/2026-05-17-x/qa-test-scope.md"
        )
      );
      assert.ok(
        !OPENSPEC_DOC_PATH_RE.test(
          "openspec/changes/archive/2026-05-17-x/decisions.md"
        )
      );
    });
  });

  describe("findPIIHits regex behavior", () => {
    it("has exact parity with the shared classifier across the common corpus", async () => {
      let shared;
      try {
        shared = await import("../lib/pii-pattern-contract.mjs");
      } catch (error) {
        assert.fail(`shared PII contract must load: ${error.message}`);
      }
      for (const text of [
        "person@corp.dev",
        "/Users/Alice/work",
        "/home/bob/work",
        "D:/Users/Alice/work",
        String.raw`e:\uSeRs/Bob\work`,
        "user@example.com",
        "/Users/<name>",
        "clean text",
      ]) {
        assert.deepEqual(findPIIHits(text), shared.findPIIHits(text), text);
      }
    });

    it("detects Unix /Users/ path with lowercase letter", () => {
      const hits = findPIIHits("path is /Users/john/Documents/repo");
      assert.equal(hits.length, 1);
      assert.equal(hits[0].type, "unix-users-path");
      assert.equal(hits[0].match, "/Users/j");
    });

    it("detects Unix /Users/ path with CAPITALIZED letter (codex C2)", () => {
      const hits = findPIIHits("path is /Users/Allen/Documents/repo");
      assert.equal(hits.length, 1);
      assert.equal(hits[0].type, "unix-users-path");
    });

    it("detects Unix /home/ path with lowercase + capitalized letter", () => {
      assert.equal(findPIIHits("server side: /home/alice/data").length, 1);
      assert.equal(findPIIHits("server side: /home/Alice/data").length, 1);
    });

    it("detects Windows C:\\Users\\ path with lowercase + capitalized letter", () => {
      assert.equal(findPIIHits(String.raw`Win: C:\Users\bob\Documents`).length, 1);
      assert.equal(findPIIHits(String.raw`Win: C:\Users\Bob\Documents`).length, 1);
    });

    it("detects email address", () => {
      const hits = findPIIHits("Contact: john.doe@company.com for help");
      assert.equal(hits.length, 1);
      assert.equal(hits[0].type, "email");
    });

    it("allowlists example.com / example.org / example.net domains", () => {
      assert.equal(findPIIHits("see user@example.com").length, 0);
      assert.equal(findPIIHits("see foo@example.org").length, 0);
      assert.equal(findPIIHits("see foo@example.net").length, 0);
    });

    it("allowlists noreply@anthropic.com commit footer", () => {
      assert.equal(
        findPIIHits("Co-Authored-By: noreply@anthropic.com").length,
        0
      );
    });

    it("does NOT match placeholder forms (/Users/<name> / /home/<user> / C:\\Users\\<name>)", () => {
      // Placeholders use `<...>` immediately after the path prefix; `<` is not
      // in [a-z], so the strictened regex passes them through.
      assert.equal(findPIIHits("path is /Users/<name>/foo").length, 0);
      assert.equal(findPIIHits("server: /home/<user>/data").length, 0);
      assert.equal(
        findPIIHits(String.raw`win: C:\Users\<name>\Documents`).length,
        0
      );
    });

    it("does NOT match the canonical regex set written as text (e.g. /Users/[a-z])", () => {
      // Critical for self-dogfood: rule-design-principles.md SSOT and this
      // proposal-mini describe the regex literally. `[` after the prefix is
      // not in [a-z], so the description prose passes.
      assert.equal(findPIIHits("regex `/Users/[a-z]`").length, 0);
      assert.equal(findPIIHits("regex `/home/[a-z]`").length, 0);
      assert.equal(
        findPIIHits(String.raw`regex \`C:\Users\\` + "[a-z]`").length,
        0
      );
    });

    it("returns multiple hits when multiple PII patterns present", () => {
      const text = "see /Users/john/x and email me at foo@company.com";
      const hits = findPIIHits(text);
      assert.equal(hits.length, 2);
      const types = hits.map((h) => h.type).sort();
      assert.deepEqual(types, ["email", "unix-users-path"]);
    });

    it("returns empty array for clean text", () => {
      assert.equal(findPIIHits("no PII here").length, 0);
      assert.equal(findPIIHits("").length, 0);
      assert.equal(findPIIHits(null).length, 0);
    });
  });

  describe("simulatePostWriteContent (post-edit content simulator)", () => {
    it("Write returns full content (priorContent ignored)", () => {
      assert.equal(
        simulatePostWriteContent("Write", { content: "hello" }, "old file"),
        "hello"
      );
    });

    it("Edit replaces first occurrence of old_string in priorContent", () => {
      const prior = "line A\nline B\nline A";
      const out = simulatePostWriteContent(
        "Edit",
        { old_string: "line A", new_string: "line X" },
        prior
      );
      assert.equal(out, "line X\nline B\nline A");
    });

    it("Edit with replace_all replaces every occurrence", () => {
      const prior = "x x x";
      const out = simulatePostWriteContent(
        "Edit",
        { old_string: "x", new_string: "y", replace_all: true },
        prior
      );
      assert.equal(out, "y y y");
    });

    it("Edit returns priorContent unchanged when old_string missing", () => {
      const prior = "abc";
      const out = simulatePostWriteContent(
        "Edit",
        { old_string: "not-found", new_string: "X" },
        prior
      );
      assert.equal(out, prior);
    });

    it("MultiEdit applies edits sequentially", () => {
      const prior = "alpha beta gamma";
      const out = simulatePostWriteContent(
        "MultiEdit",
        {
          edits: [
            { old_string: "alpha", new_string: "ALPHA" },
            { old_string: "gamma", new_string: "GAMMA" },
          ],
        },
        prior
      );
      assert.equal(out, "ALPHA beta GAMMA");
    });

    it("returns empty string for unknown tool names", () => {
      assert.equal(simulatePostWriteContent("Bash", { command: "ls" }, "x"), "");
    });
  });

  describe("checkOpenSpecDocPII gate", () => {
    // Helper: build a readFile stub from an in-memory map. Production gate
    // injects readFileSync; tests use this to avoid touching disk.
    const stubReadFile = (map = {}) => (abs) => {
      for (const [k, v] of Object.entries(map)) {
        if (abs.endsWith(k)) return v;
      }
      return "";
    };

    it("fails closed with bounded reason shape when shared classifier throws", async () => {
      const faulted = await loadHookWithClassifier("throw new Error('private raw classifier detail');");
      const result = faulted.checkOpenSpecDocPII({
        toolName: "Write",
        filePath: "openspec/changes/add-foo/meeting-notes.md",
        toolInput: { content: "clean text" },
        readFile: stubReadFile(),
      });
      assert.deepEqual(Object.keys(result).sort(), ["block", "reason"]);
      assert.equal(result.block, true);
      assert.match(result.reason, /^Gate P \(OpenSpec doc PII\)：classification-failure/);
      assert.match(result.reason, /exception/);
      assert.doesNotMatch(result.reason, /private raw classifier detail|clean text|stack/i);
    });

    it("fails closed with bounded reason shape for every invalid shared result", async () => {
      for (const body of [
        "return null;",
        "return {};",
        "return [null];",
        "return [1];",
        "return [{}];",
        "return [{ type: 'unknown', match: 'x', placeholder: 'y' }];",
        "return [{ type: 1, match: 'a@b.dev', placeholder: '<user-email>' }];",
        "return [{ type: 'email', match: '', placeholder: '<user-email>' }];",
        "return [{ type: 'email', match: 'a@b.dev', placeholder: 'wrong' }];",
        "return [{ type: 'email', match: 'a@b.dev', placeholder: '<user-email>', extra: 'x' }];",
      ]) {
        const faulted = await loadHookWithClassifier(body);
        const result = faulted.checkOpenSpecDocPII({
          toolName: "Write",
          filePath: "openspec/changes/add-foo/tasks.md",
          toolInput: { content: "clean text" },
          readFile: stubReadFile(),
        });
        assert.deepEqual(Object.keys(result).sort(), ["block", "reason"], body);
        assert.equal(result.block, true, body);
        assert.match(result.reason, /^Gate P \(OpenSpec doc PII\)：classification-failure/, body);
        assert.match(result.reason, /invalid-result/, body);
        assert.doesNotMatch(result.reason, /clean text|\[object Object\]/i, body);
      }
    });

    it("blocks widened Windows paths in post-write Write/Edit/MultiEdit content", () => {
      const cases = [
        {
          toolName: "Write",
          toolInput: { content: "D:/Users/Alice/work" },
          readFile: stubReadFile(),
        },
        {
          toolName: "Edit",
          toolInput: { old_string: "clean", new_string: String.raw`e:\uSeRs/Bob\work` },
          readFile: stubReadFile({ "meeting-notes.md": "clean" }),
        },
        {
          toolName: "MultiEdit",
          toolInput: { edits: [{ old_string: "clean", new_string: String.raw`F:/USERS\Carol/work` }] },
          readFile: stubReadFile({ "meeting-notes.md": "clean" }),
        },
      ];
      for (const input of cases) {
        const result = checkOpenSpecDocPII({
          ...input,
          filePath: "openspec/changes/add-foo/meeting-notes.md",
        });
        assert.equal(result?.block, true, input.toolName);
        assert.match(result.reason, /windows-users-path/, input.toolName);
      }
    });

    it("keeps all protected document names in scope for material PII", () => {
      for (const name of [
        "meeting-notes",
        "brd",
        "proposal",
        "proposal-mini",
        "tasks",
        "qa-test-scope",
        "decisions",
      ]) {
        const result = checkOpenSpecDocPII({
          toolName: "Write",
          filePath: `openspec/changes/add-foo/${name}.md`,
          toolInput: { content: "/home/Alice/work" },
          readFile: stubReadFile(),
        });
        assert.equal(result?.block, true, name);
      }
    });

    it("blocks Write to meeting-notes.md with /Users/ PII", () => {
      const result = checkOpenSpecDocPII({
        toolName: "Write",
        filePath: "openspec/changes/add-foo/meeting-notes.md",
        toolInput: { content: "user ran from /Users/john/Documents/repo" },
        readFile: stubReadFile(),
      });
      assert.ok(result);
      assert.ok(result.block);
      assert.ok(result.reason.includes("Gate P"));
      assert.ok(result.reason.includes("unix-users-path"));
    });

    it("blocks Edit to brd.md with email PII introduced in new_string", () => {
      const result = checkOpenSpecDocPII({
        toolName: "Edit",
        filePath: "openspec/changes/add-foo/brd.md",
        toolInput: {
          old_string: "Contact stakeholder",
          new_string: "Contact john.doe@acme-corp.com for sign-off",
        },
        readFile: stubReadFile({
          "brd.md": "## Stakeholders\n\nContact stakeholder.\n",
        }),
      });
      assert.ok(result?.block);
      assert.ok(result.reason.includes("email"));
    });

    it("blocks MultiEdit to proposal-mini.md when ONE edit introduces PII", () => {
      const result = checkOpenSpecDocPII({
        toolName: "MultiEdit",
        filePath: "openspec/changes/add-foo/proposal-mini.md",
        toolInput: {
          edits: [
            { old_string: "OK", new_string: "clean text" },
            { old_string: "X", new_string: String.raw`Windows: C:\Users\bob\foo` },
          ],
        },
        readFile: stubReadFile({
          "proposal-mini.md": "OK\nX\n",
        }),
      });
      assert.ok(result?.block);
      assert.ok(result.reason.includes("windows-users-path"));
    });

    it("PASSES Edit when sanitizing PII to placeholder (post-edit content clean)", () => {
      // Critical for sanitize workflow: AI fixing PII via Edit must succeed.
      // Post-edit content has only the placeholder, no remaining PII.
      const result = checkOpenSpecDocPII({
        toolName: "Edit",
        filePath: "openspec/changes/add-foo/meeting-notes.md",
        toolInput: {
          old_string: "ran from /Users/john/Documents/repo",
          new_string: "ran from <repo-root-abs>",
        },
        readFile: stubReadFile({
          "meeting-notes.md":
            "# Meeting notes\n\nAI ran from /Users/john/Documents/repo today.\n",
        }),
      });
      assert.equal(result, null);
    });

    it("BLOCKS Edit when new_string is clean but residual PII remains in file (codex C1 fix)", () => {
      // Codex C1: prior implementation scanned only new_string, so Edit on
      // an unrelated line bypassed the gate even when residual PII lived
      // outside the edit window. Now the gate scans the simulated post-edit
      // content — must catch residual PII to force full sanitization.
      const result = checkOpenSpecDocPII({
        toolName: "Edit",
        filePath: "openspec/changes/add-foo/meeting-notes.md",
        toolInput: {
          old_string: "unrelated header",
          new_string: "updated header",
        },
        readFile: stubReadFile({
          "meeting-notes.md":
            "# Meeting notes\n\nunrelated header\n\n## Run trace\n\n/Users/john/Documents/repo\n",
        }),
      });
      assert.ok(result?.block, "residual PII outside edit window must block");
      assert.ok(result.reason.includes("unix-users-path"));
    });

    it("BLOCKS Write/Edit with capitalized Unix path /Users/Allen (codex C2 fix)", () => {
      const writeResult = checkOpenSpecDocPII({
        toolName: "Write",
        filePath: "openspec/changes/add-foo/meeting-notes.md",
        toolInput: { content: "run trace: /Users/Allen/Documents/repo" },
        readFile: stubReadFile(),
      });
      assert.ok(writeResult?.block, "capitalized /Users/Allen must block");
      assert.ok(writeResult.reason.includes("unix-users-path"));
    });

    it("BLOCKS Write with capitalized /home/Alice and C:\\Users\\Bob (codex C2 fix)", () => {
      const homeResult = checkOpenSpecDocPII({
        toolName: "Write",
        filePath: "openspec/changes/add-foo/meeting-notes.md",
        toolInput: { content: "server: /home/Alice/data" },
        readFile: stubReadFile(),
      });
      assert.ok(homeResult?.block, "capitalized /home/Alice must block");

      const winResult = checkOpenSpecDocPII({
        toolName: "Write",
        filePath: "openspec/changes/add-foo/meeting-notes.md",
        toolInput: { content: String.raw`win: C:\Users\Bob\Documents` },
        readFile: stubReadFile(),
      });
      assert.ok(winResult?.block, "capitalized C:\\Users\\Bob must block");
    });

    it("PASSES Write to archive path even with PII", () => {
      const result = checkOpenSpecDocPII({
        toolName: "Write",
        filePath:
          "openspec/changes/archive/2026-05-17-x/meeting-notes.md",
        toolInput: { content: "/Users/john/leftover" },
        readFile: stubReadFile(),
      });
      assert.equal(result, null);
    });

    it("PASSES Write to non-openspec path with PII (out of scope)", () => {
      const result = checkOpenSpecDocPII({
        toolName: "Write",
        filePath: "README.md",
        toolInput: { content: "/Users/john/repo" },
        readFile: stubReadFile(),
      });
      assert.equal(result, null);
    });

    it("BLOCKS Write to openspec/changes/<X>/tasks.md with /Users/ PII (now covered by Gate P)", () => {
      const result = checkOpenSpecDocPII({
        toolName: "Write",
        filePath: "openspec/changes/add-foo/tasks.md",
        toolInput: { content: "task: review /Users/Allen/repo" },
        readFile: stubReadFile(),
      });
      assert.ok(result?.block);
      assert.ok(result.reason.includes("Gate P"));
      assert.ok(result.reason.includes("unix-users-path"));
    });

    it("PASSES Write to openspec/changes/<X>/tasks.md with placeholder (no PII)", () => {
      const result = checkOpenSpecDocPII({
        toolName: "Write",
        filePath: "openspec/changes/add-foo/tasks.md",
        toolInput: { content: "task: review <repo-root-abs>/foo" },
        readFile: stubReadFile(),
      });
      assert.equal(result, null);
    });

    it("BLOCKS Write to openspec/changes/<X>/qa-test-scope.md with email PII", () => {
      const result = checkOpenSpecDocPII({
        toolName: "Write",
        filePath: "openspec/changes/add-foo/qa-test-scope.md",
        toolInput: { content: "reviewer: john.doe@acme-corp.com" },
        readFile: stubReadFile(),
      });
      assert.ok(result?.block);
      assert.ok(result.reason.includes("email"));
    });

    it("BLOCKS Write to openspec/changes/<X>/decisions.md with /Users/ PII", () => {
      const result = checkOpenSpecDocPII({
        toolName: "Write",
        filePath: "openspec/changes/add-foo/decisions.md",
        toolInput: { content: "decision log: ran from /Users/Allen/Documents/repo" },
        readFile: stubReadFile(),
      });
      assert.ok(result?.block);
      assert.ok(result.reason.includes("unix-users-path"));
    });

    it("PASSES Write with allowlisted email domain", () => {
      const result = checkOpenSpecDocPII({
        toolName: "Write",
        filePath: "openspec/changes/add-foo/meeting-notes.md",
        toolInput: { content: "stakeholder: user@example.com" },
        readFile: stubReadFile(),
      });
      assert.equal(result, null);
    });

    it("PASSES Write with placeholder forms (no PII)", () => {
      const result = checkOpenSpecDocPII({
        toolName: "Write",
        filePath: "openspec/changes/add-foo/meeting-notes.md",
        toolInput: {
          content:
            "AI ran in <repo-root-abs>; user is <name>; email <user-email>",
        },
        readFile: stubReadFile(),
      });
      assert.equal(result, null);
    });

    it("reason includes placeholder hints for each hit type", () => {
      const result = checkOpenSpecDocPII({
        toolName: "Write",
        filePath: "openspec/changes/add-foo/meeting-notes.md",
        toolInput: {
          content:
            "see /Users/john and contact me@company.com plus /home/alice and " +
            String.raw`C:\Users\bob`,
        },
        readFile: stubReadFile(),
      });
      assert.ok(result?.block);
      assert.ok(result.reason.includes("<user-email>"));
      assert.ok(result.reason.includes("<repo-root-abs>"));
      assert.ok(result.reason.includes("<user>"));
      assert.ok(result.reason.includes("<name>"));
    });

    it("reason caps preview list at 5 hits and reports overflow count", () => {
      const text = Array.from({ length: 8 })
        .map((_, i) => `path-${i}: /Users/u${i}/foo`)
        .join(" ");
      const result = checkOpenSpecDocPII({
        toolName: "Write",
        filePath: "openspec/changes/add-foo/meeting-notes.md",
        toolInput: { content: text },
        readFile: stubReadFile(),
      });
      assert.ok(result?.block);
      assert.match(result.reason, /總 8/);
      assert.match(result.reason, /...及其他 3 個 hit/);
    });
  });
});
