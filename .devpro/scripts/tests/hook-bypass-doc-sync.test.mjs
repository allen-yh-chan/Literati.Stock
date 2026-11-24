import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { SOURCE_ROOT, sourcePath } from "./lib/source-root.mjs";

const LEGACY_BYPASS = ["DEVPRO", "DISABLE", "PRE", "TOOL", "GATE"].join("_");
const CURRENT_BYPASS = "DEVPRO_HOOK_BYPASS=1";

const activeRoots = [
  ".devpro/scripts/hooks",
  ".devpro/scripts/tests",
  ".devpro/agent-rules",
  // .claude/commands/dp/ 冒號式 command 面已隨 migrate-skill-architecture-to-dp-prefix
  // 廢除，整個 .claude/commands 目錄不再是 active surface（改由跨平台 skill 分發）
  "openspec/specs",
];

const activeFiles = ["README.md"];
const wantedExtensions = new Set([".md", ".mjs", ".json"]);

function collectFiles(relativePath) {
  const absolute = sourcePath(relativePath);
  const stat = statSync(absolute);
  if (stat.isFile()) return [absolute];
  const out = [];
  for (const entry of readdirSync(absolute)) {
    const child = path.join(absolute, entry);
    const childStat = statSync(child);
    if (childStat.isDirectory()) {
      out.push(...collectFiles(path.relative(SOURCE_ROOT, child)));
    } else if (wantedExtensions.has(path.extname(child))) {
      out.push(child);
    }
  }
  return out;
}

test("active hook/rule/spec surfaces do not document the retired process-env bypass", () => {
  const files = [
    ...activeFiles.map((file) => sourcePath(file)),
    ...activeRoots.flatMap(collectFiles),
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.equal(
      text.includes(LEGACY_BYPASS),
      false,
      `${path.relative(SOURCE_ROOT, file)} still mentions retired hook bypass`,
    );
  }
});

test("active docs point to the hook-readable inline Bash bypass", () => {
  const requiredDocs = [
    "README.md",
    ".devpro/agent-rules/git-branch-hygiene.md",
    ".devpro/agent-rules/git-pr-template-and-merge.md",
    "openspec/specs/pre-tool-mechanical-gates/spec.md",
  ];
  for (const file of requiredDocs) {
    const text = readFileSync(sourcePath(file), "utf8");
    assert.match(text, new RegExp(CURRENT_BYPASS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
