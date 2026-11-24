/**
 * Executable contract for the shared Gate-P / clarification PII classifier.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_ROOT = join(HERE, "..");
const SHARED_PATH = join(SCRIPTS_ROOT, "lib", "pii-pattern-contract.mjs");

let shared = null;
let sharedLoadError = null;
try {
  shared = await import("../lib/pii-pattern-contract.mjs");
} catch (error) {
  sharedLoadError = error;
}

function requireSharedContract() {
  assert.equal(
    sharedLoadError,
    null,
    `shared PII contract must load: ${sharedLoadError?.message || "unknown error"}`,
  );
  return shared;
}

const placeholders = Object.freeze({
  email: "<user-email>",
  "unix-users-path": "<repo-root-abs>/... or /Users/<name>/...",
  "unix-home-path": "/home/<user>/...",
  "windows-users-path": String.raw`C:\Users\<name>\...`,
});

function assertExactHit(text, expectedStart, expectedMatch, expectedType) {
  const { findPIIHits } = requireSharedContract();
  const hits = findPIIHits(text);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0], {
    type: expectedType,
    match: expectedMatch,
    placeholder: placeholders[expectedType],
  });
  const actualStart = text.indexOf(hits[0].match);
  assert.equal(actualStart, expectedStart);
  assert.equal(actualStart + hits[0].match.length, expectedStart + expectedMatch.length);
}

test("shared classifier reports exact single-hit extents and compatibility placeholders", () => {
  assertExactHit("contact a.person@corp.dev now", 8, "a.person@corp.dev", "email");
  assertExactHit("path /Users/Alice/work", 5, "/Users/A", "unix-users-path");
  assertExactHit("path /home/bob/work", 5, "/home/b", "unix-home-path");
  assertExactHit(String.raw`path C:\Users\Carol\work`, 5, String.raw`C:\Users\C`, "windows-users-path");
});

test("Windows candidate owns every overlapping Unix /Users/ span", () => {
  const corpus = [
    ["D:/Users/Alice/work", "D:/Users/A"],
    [String.raw`e:\users\bob\work`, String.raw`e:\users\b`],
    [String.raw`F:/USERS\Carol/work`, String.raw`F:/USERS\C`],
    [String.raw`g:\uSeRs/Dave\work`, String.raw`g:\uSeRs/D`],
  ];
  const { findPIIHits } = requireSharedContract();
  for (const [text, expectedMatch] of corpus) {
    const hits = findPIIHits(text);
    assert.deepEqual(hits, [{
      type: "windows-users-path",
      match: expectedMatch,
      placeholder: placeholders["windows-users-path"],
    }]);
    const windowsSpan = [text.indexOf(expectedMatch), text.indexOf(expectedMatch) + expectedMatch.length];
    const unixStart = text.toLowerCase().indexOf("/users/");
    const unixSpan = [unixStart, unixStart + "/Users/A".length];
    assert.ok(windowsSpan[0] < unixSpan[1] && unixSpan[0] < windowsSpan[1]);
  }
});

test("Windows matcher accepts ASCII drives, independent separators, and Users casing", () => {
  const { findPIIHits } = requireSharedContract();
  for (const [text, expectedMatch] of [
    [String.raw`A:\Users\Alice`, String.raw`A:\Users\A`],
    [String.raw`Z:\users/zulu`, String.raw`Z:\users/z`],
    [String.raw`a:/USERS/adam`, "a:/USERS/a"],
    [String.raw`z:/uSeRs\Zed`, String.raw`z:/uSeRs\Z`],
  ]) {
    assertExactHit(text, 0, expectedMatch, "windows-users-path");
  }
  for (const text of [
    "1:/Users/Alice",
    "Å:/Users/Alice",
    "C:/Users/7alice",
    "C:/Users/éclair",
    "C:/Users/<name>",
  ]) {
    assert.equal(
      findPIIHits(text).some((hit) => hit.type === "windows-users-path"),
      false,
      text,
    );
  }
  for (const text of ["/users/Alice", "/USERS/Alice", "/Home/Alice"]) {
    assert.equal(findPIIHits(text).length, 0, text);
  }
});

test("email allowlist, Unix paths, placeholders, and clean inputs remain compatible", () => {
  const { findPIIHits } = requireSharedContract();
  for (const text of [
    "user@example.com",
    "foo@example.org",
    "foo@example.net",
    "Co-Authored-By: noreply@anthropic.com",
  ]) {
    assert.deepEqual(findPIIHits(text), [], text);
  }
  assert.deepEqual(findPIIHits("/Users/<name> /home/<user> C:/Users/<name>"), []);
  assert.deepEqual(findPIIHits(""), []);
  assert.deepEqual(findPIIHits(null), []);
  assert.deepEqual(
    findPIIHits("/Users/A and /home/b plus person@corp.dev").map((hit) => hit.type).sort(),
    ["email", "unix-home-path", "unix-users-path"],
  );
  assert.equal(findPIIHits("/Users/A then /Users/A").length, 2);
  for (const text of [
    String.raw`\\server\Users\Alice`,
    "%2FUsers%2FAlice",
    "$HOME/project",
    "%USERPROFILE%/project",
  ]) {
    assert.deepEqual(findPIIHits(text), [], text);
  }
});

test("caller-mutated exported regex lastIndex cannot influence classifier state", () => {
  const contract = requireSharedContract();
  for (const name of [
    "PII_EMAIL_RE",
    "PII_EMAIL_ALLOW_RE",
    "PII_UNIX_USERS_RE",
    "PII_UNIX_HOME_RE",
    "PII_WINDOWS_USERS_RE",
  ]) {
    contract[name].lastIndex = 999;
  }
  const lastIndexes = Object.fromEntries([
    "PII_EMAIL_RE",
    "PII_EMAIL_ALLOW_RE",
    "PII_UNIX_USERS_RE",
    "PII_UNIX_HOME_RE",
    "PII_WINDOWS_USERS_RE",
  ].map((name) => [name, contract[name].lastIndex]));
  const first = contract.findPIIHits(String.raw`D:\Users\Alice and me@corp.dev`);
  const second = contract.findPIIHits(String.raw`D:\Users\Alice and me@corp.dev`);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((hit) => hit.type).sort(), ["email", "windows-users-path"]);
  for (const [name, lastIndex] of Object.entries(lastIndexes)) {
    assert.equal(contract[name].lastIndex, lastIndex, name);
  }
});

test("classifier always returns the bounded own-enumerable result schema", () => {
  const { findPIIHits } = requireSharedContract();
  for (const hit of findPIIHits("/Users/A /home/b c@corp.dev")) {
    assert.deepEqual(Object.keys(hit).sort(), ["match", "placeholder", "type"]);
    for (const key of ["type", "match", "placeholder"]) {
      assert.equal(Object.hasOwn(hit, key), true);
      assert.equal(typeof hit[key], "string");
      assert.notEqual(hit[key], "");
    }
    assert.equal(placeholders[hit.type], hit.placeholder);
  }
});

test("shared leaf is the only production regex/classifier definition carrier", () => {
  requireSharedContract();
  const scanScript = String.raw`
    const { readdirSync, readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const [scriptsRoot, sharedPath] = process.argv.slice(1);

    function productionModules(dir) {
      const files = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "tests") files.push(...productionModules(full));
        } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
          files.push(full);
        }
      }
      return files;
    }

    const forbidden = [];
    for (const file of productionModules(scriptsRoot)) {
      if (file === sharedPath) continue;
      const source = readFileSync(file, "utf8");
      if (/\b(?:const|let|var)\s+PII_(?:EMAIL|EMAIL_ALLOW|UNIX_USERS|UNIX_HOME|WINDOWS_USERS)_RE\s*=\s*(?:\/|new\s+RegExp\b)/.test(source)) {
        forbidden.push(file + ": duplicate PII regex definition");
      }
      const regexBodies = [
        ...source.matchAll(/\/((?:\\.|[^/\n])+)\/[dgimsuvy]*/g),
        ...source.matchAll(/new\s+RegExp\s*\(\s*(?:String\.raw)?(?:\`([^\`]*)\`|"([^"]*)"|'([^']*)')/g),
      ].map((match) => match[1] || match[2] || match[3] || "");
      const hasKnownPIIBody = regexBodies.some((body) =>
        (body.includes("[a-zA-Z0-9._%+-]+@") && body.includes("[a-zA-Z]{2,}")) ||
        (body.includes("\\/Users\\/") && body.includes("[A-Za-z]")) ||
        (body.includes("\\/home\\/") && body.includes("[A-Za-z]")) ||
        (body.includes("[A-Za-z]:") && body.includes("Users") && body.includes("[\\\\/]")) ||
        (body.includes("C:\\\\Users\\\\") && body.includes("[A-Za-z]"))
      );
      if (hasKnownPIIBody) {
        forbidden.push(file + ": duplicate known PII regex body");
      }
      if (/\b(?:function\s+findPIIHits\s*\([^)]*\)\s*\{|(?:const|let|var)\s+findPIIHits\s*=)/.test(source)) {
        forbidden.push(file + ": duplicate findPIIHits implementation");
      }
    }
    process.stdout.write(JSON.stringify(forbidden));
  `;
  const scan = spawnSync(
    process.execPath,
    ["--input-type=commonjs", "-e", scanScript, SCRIPTS_ROOT, SHARED_PATH],
    { encoding: "utf8" },
  );
  assert.equal(scan.status, 0, scan.stderr);
  assert.deepEqual(JSON.parse(scan.stdout), []);
});

test("three-way matrix and same-name compatibility adapter share one authority", async () => {
  const contract = requireSharedContract();
  const clarificationModule = await import("../lib/clarification-contract.mjs");
  const hookModule = await import("../hooks/pre-tool-gate.mjs");
  const clarification = readFileSync(join(SCRIPTS_ROOT, "lib", "clarification-contract.mjs"), "utf8");
  const hook = readFileSync(join(SCRIPTS_ROOT, "hooks", "pre-tool-gate.mjs"), "utf8");
  const rule = readFileSync(join(SCRIPTS_ROOT, "..", "agent-rules", "rule-design-principles.md"), "utf8");
  assert.match(clarification, /import\s*\{[^}]*findPIIHits[^}]*\}\s*from\s*["']\.\/pii-pattern-contract\.mjs["']/s);
  assert.match(hook, /import\s*\{[^}]*PII_EMAIL_RE[^}]*findPIIHits[^}]*\}\s*from\s*["']\.\.\/lib\/pii-pattern-contract\.mjs["']/s);
  assert.match(hook, /export\s*\{[\s\S]*\bPII_EMAIL_RE\b[\s\S]*\bfindPIIHits\b/);
  assert.equal(hookModule.findPIIHits, contract.findPIIHits);

  const rows = [
    ["person@corp.dev", ["email"], []],
    ["user@example.com", [], []],
    ["user@example.org", [], []],
    ["user@example.net", [], []],
    ["noreply@anthropic.com", [], []],
    ["/Users/Alice/work", ["unix-users-path"], []],
    ["/Users/zulu/work", ["unix-users-path"], []],
    ["/home/Alice/work", ["unix-home-path"], []],
    ["/home/zulu/work", ["unix-home-path"], []],
    ["/users/Alice /USERS/Alice /Home/Alice", [], []],
    [String.raw`A:\Users\Alice`, ["windows-users-path"], []],
    [String.raw`Z:\users/zulu`, ["windows-users-path"], []],
    [String.raw`a:/USERS/adam`, ["windows-users-path"], []],
    [String.raw`z:/uSeRs\Zed`, ["windows-users-path"], []],
    ["D:/Users/Alice/project/file.txt", ["windows-users-path"], []],
    ["C:/Users/7alice C:/Users/éclair", [], []],
    [String.raw`/Users/<name> /home/<user> C:\Users\<name>`, [], []],
    [String.raw`\\server\Users\Alice %2FUsers%2FAlice $HOME %USERPROFILE%`, [], []],
    ["token sk-abcdefghijklmnopqrstuvwxyz", [], ["secret-like"]],
    ["paste full transcript here", [], ["transcript-like"]],
    ["", [], []],
    ["clean text", [], []],
    ["/Users/A and /home/b", ["unix-users-path", "unix-home-path"], []],
  ];
  const normalizedClarificationType = {
    "email-like": "email",
    "unix-users-path": "unix-users-path",
    "unix-home-path": "unix-home-path",
    "windows-users-path": "windows-users-path",
  };
  for (const [text, expectedPII, expectedLocal] of rows) {
    const sharedTypes = contract.findPIIHits(text).map((hit) => hit.type);
    const hookTypes = hookModule.findPIIHits(text).map((hit) => hit.type);
    const clarificationHits = clarificationModule.detectSensitiveHits(text);
    const clarificationTypes = clarificationHits
      .filter((hit) => Object.hasOwn(normalizedClarificationType, hit))
      .map((hit) => normalizedClarificationType[hit]);
    assert.deepEqual(sharedTypes, expectedPII, `shared: ${text}`);
    assert.deepEqual(hookTypes, expectedPII, `hook: ${text}`);
    assert.deepEqual(clarificationTypes, expectedPII, `clarification: ${text}`);
    assert.deepEqual(
      clarificationHits.filter((hit) => hit.endsWith("-like") && hit !== "email-like"),
      expectedLocal,
      `clarification local: ${text}`,
    );
    const decision = hookModule.checkOpenSpecDocPII({
      toolName: "Write",
      filePath: "openspec/changes/synthetic/tasks.md",
      toolInput: { content: text },
      readFile: () => "",
    });
    assert.equal(Boolean(decision?.block), expectedPII.length > 0, `material decision: ${text}`);
  }

  assert.match(rule, /Canonical FORBIDDEN Regex Set/);
  assert.match(rule, /pii-pattern-contract\.mjs/);
  assert.match(rule, /example\.\{com,org,net\}.*anthropic\.com/);
  assert.match(rule, /Unix.*case-sensitive/s);
  assert.match(rule, /Windows.*ASCII drive\/username.*separator.*Users.*single-hit/s);
});
