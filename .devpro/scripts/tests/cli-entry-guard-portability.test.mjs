import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REPO_ROOT } from "./lib/repo-root.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const scriptsRoot = path.resolve(scriptDir, "..");

const ENTRY_SCRIPTS = [
  "devpro-doctor.mjs",
  "consumer-adoption-matrix.mjs",
  "rule-load-ledger.mjs",
  "lint-agent-skills.mjs",
  "detect-branch-base.mjs",
  "hooks/post-tool-gate.mjs",
  "hooks/gh-footer-gate.mjs",
  "hooks/pre-tool-gate.mjs",
  "lint-delta-body-canonical-wrap.mjs",
  "lint-delta-spec-citations.mjs",
  "lint-delta-requirement-mode.mjs",
  "lint-modified-scenario-preservation.mjs",
  "lint-proposal-tasks-checked.mjs",
  "lint-proposal-touch-self-path.mjs",
  "lint-risk-classes-record.mjs",
  "lint-spec-shall-must.mjs",
  "pre-pr-body-template-check.mjs",
  "recap-body-template-check.mjs",
  "recap-title-check.mjs",
  "validate-openspec-change.mjs",
];

// Build at runtime so this test file itself does not contain the broken
// contiguous template that the repo-wide fixed-string scan must remain zero for.
const BROKEN_TEMPLATE = ["file://", "${process.argv[1]}"].join("");
// Broad form covering modulePath and argv variants (assembled so this file
// never contains the contiguous forbidden equality prefix).
const BROKEN_EQUALITY_FORM = ["import.meta.url === `", "file://"].join("");
const FIXED_COMPARISON = "pathToFileURL(process.argv[1]).href";

describe("CLI entry guard portability", () => {
  it("doctor main runs under space-containing argv (pathToFileURL-normalized)", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cli-entry-guard-"));
    const spaceDir = path.join(tmpRoot, "with space");
    try {
      await fs.mkdir(spaceDir, { recursive: true });
      await fs.copyFile(
        path.join(scriptsRoot, "devpro-doctor.mjs"),
        path.join(spaceDir, "devpro-doctor.mjs")
      );
      await fs.mkdir(path.join(spaceDir, "lib"), { recursive: true });
      await fs.copyFile(
        path.join(scriptsRoot, "lib/find-root.mjs"),
        path.join(spaceDir, "lib/find-root.mjs")
      );
      await fs.copyFile(
        path.join(scriptsRoot, "lib/consumer-pre-pr-checks.mjs"),
        path.join(spaceDir, "lib/consumer-pre-pr-checks.mjs")
      );
      await fs.copyFile(
        path.join(scriptsRoot, "lib/consumer-second-review-rules.mjs"),
        path.join(spaceDir, "lib/consumer-second-review-rules.mjs")
      );
      await fs.copyFile(
        path.join(scriptsRoot, "lib/second-review-sticky-credential-gate.mjs"),
        path.join(spaceDir, "lib/second-review-sticky-credential-gate.mjs")
      );
      // Minimal sibling so the copied doctor can load; --help never calls these.
      await fs.writeFile(
        path.join(spaceDir, "consumer-adoption-matrix.mjs"),
        [
          "export function generateMatrix() { return {}; }",
          "export function profileEntries() { return []; }",
          "export const SUPPORTED_PROFILES = [];",
          "",
        ].join("\n")
      );

      // realpath keeps argv on the same path form as import.meta.url (macOS
      // /var → /private/var); the remaining mismatch for the broken template is
      // space percent-encoding, which pathToFileURL fixes.
      const scriptPath = realpathSync(path.join(spaceDir, "devpro-doctor.mjs"));
      assert.ok(
        scriptPath.includes(" "),
        "precondition: argv path must contain a space so broken file:// template ≠ import.meta.url"
      );
      assert.notEqual(
        `file://${scriptPath}`,
        pathToFileURL(scriptPath).href,
        "precondition: broken file:// template must disagree with pathToFileURL on this argv"
      );

      const result = spawnSync(process.execPath, [scriptPath, "--help"], {
        encoding: "utf8",
        cwd: path.dirname(scriptPath),
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(
        result.stdout,
        /Usage:\s+node .*devpro-doctor\.mjs/,
        "direct-exec guard must enter main(); silent empty stdout is the false-green defect"
      );
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("lint-agent-skills main runs under space-containing argv (pathToFileURL-normalized)", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cli-entry-lint-"));
    const spaceDir = path.join(tmpRoot, "with space");
    try {
      await fs.mkdir(spaceDir, { recursive: true });
      await fs.copyFile(
        path.join(scriptsRoot, "lint-agent-skills.mjs"),
        path.join(spaceDir, "lint-agent-skills.mjs")
      );

      const scriptPath = realpathSync(path.join(spaceDir, "lint-agent-skills.mjs"));
      assert.ok(
        scriptPath.includes(" "),
        "precondition: argv path must contain a space so broken file:// template ≠ import.meta.url"
      );
      assert.notEqual(
        `file://${scriptPath}`,
        pathToFileURL(scriptPath).href,
        "precondition: broken file:// template must disagree with pathToFileURL on this argv"
      );

      const result = spawnSync(
        process.execPath,
        [scriptPath, "--root", REPO_ROOT],
        {
          encoding: "utf8",
          cwd: path.dirname(scriptPath),
        }
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(
        result.stdout,
        /Checked \d+ skill/,
        "direct-exec guard must enter main(); silent empty stdout is the false-green defect"
      );
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("entry scripts use pathToFileURL comparison and drop the broken file:// template", async () => {
    for (const name of ENTRY_SCRIPTS) {
      const source = await fs.readFile(path.join(scriptsRoot, name), "utf8");
      assert.equal(
        source.includes(BROKEN_TEMPLATE),
        false,
        `${name} must not use raw ${BROKEN_TEMPLATE}`
      );
      assert.equal(
        source.includes(BROKEN_EQUALITY_FORM),
        false,
        `${name} must not use ${BROKEN_EQUALITY_FORM}… equality`
      );
      assert.ok(
        source.includes(FIXED_COMPARISON),
        `${name} must compare import.meta.url to ${FIXED_COMPARISON}`
      );
    }

    const argvScan = spawnSync(
      "git",
      ["grep", "--untracked", "--exclude-standard", "-F", "-e", BROKEN_TEMPLATE, "--", ":(glob).devpro/scripts/**/*.mjs"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    // Git is available on supported hosts; include untracked, non-ignored source.
    // grep exit 1 = no matches (desired); 0 = hits remain.
    assert.equal(
      argvScan.status,
      1,
      `broken argv template still present under .devpro/scripts:\n${argvScan.stdout}`
    );

    const equalityScan = spawnSync(
      "git",
      ["grep", "--untracked", "--exclude-standard", "-F", "-e", BROKEN_EQUALITY_FORM, "--", ":(glob).devpro/**/*.mjs"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    assert.equal(
      equalityScan.status,
      1,
      `broken import.meta.url === \`file:// form still present under .devpro/**/*.mjs:\n${equalityScan.stdout}`
    );
  });
});


it("pre-PR path constants bootstrap with only their own file copied", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consumer-pre-pr-constants-bootstrap-"));
  try {
    const target = path.join(dir, "consumer-pre-pr-checks.mjs");
    await fs.copyFile(path.join(scriptsRoot, "lib/consumer-pre-pr-checks.mjs"), target);
    const program = `import * as paths from ${JSON.stringify(pathToFileURL(target).href)}; console.log(JSON.stringify(paths));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).CONSUMER_PRE_PR_CHECKS_REL, ".devpro/pre-pr-checks.local.md");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
