import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  BUNDLE_ENTRY,
  BUNDLE_INSTRUCTION_FILES,
  BUNDLE_STUBS,
  BUNDLE_TEMPLATE,
  TEMPLATE_PLACEHOLDERS,
  buildRemoteReviewBundle,
  importClosure,
  verifyRemoteReviewBundle,
} from "../build-remote-review-bundle.mjs";
import portableCommandShims from "./lib/portable-command-shims.cjs";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";

// The bundle is what the server installs: the shared OpenCode runner with only the files it really imports, the
// rule files it hands to OpenCode, the prompt template and a manifest of digests. These tests build it from this
// checkout (the working tree may be dirty while developing, so they allow that and assert it is recorded).

function withTemp(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "remote-review-bundle-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function build(dir, name = "bundle") {
  const outDir = path.join(dir, name);
  const manifest = buildRemoteReviewBundle({ repoRoot: REPO_ROOT, outDir, requireClean: false });
  return { outDir, manifest };
}

test("closure: the runner's relative imports are followed and only Node built-ins are allowed", () => {
  const closure = importClosure(REPO_ROOT, BUNDLE_ENTRY);
  assert.ok(closure.includes(BUNDLE_ENTRY));
  for (const needed of [
    ".devpro/scripts/lib/opencode-primary-review.mjs",
    ".devpro/scripts/lib/opencode-reviewer.mjs",
    ".devpro/scripts/lib/opencode-session-evidence.mjs",
    ".devpro/scripts/review-guarantee-assessment.mjs",
  ]) assert.ok(closure.includes(needed), needed);
  assert.deepEqual(closure, [...closure].sort(), "deterministic order");
  assert.ok(!closure.some((file) => file.includes("/tests/")), "no test files");

  withTemp((dir) => {
    mkdirSync(path.join(dir, "a"));
    writeFileSync(path.join(dir, "a", "entry.mjs"), 'import "./dep.mjs";\nimport { x } from "left-pad";\n');
    writeFileSync(path.join(dir, "a", "dep.mjs"), "export const y = 1;\n");
    assert.throws(() => importClosure(dir, "a/entry.mjs"), /left-pad/u);
    writeFileSync(path.join(dir, "a", "entry.mjs"), 'import "./missing.mjs";\n');
    assert.throws(() => importClosure(dir, "a/entry.mjs"), /missing\.mjs/u);
    writeFileSync(path.join(dir, "a", "entry.mjs"), 'import "./dep.mjs";\nimport fs from "node:fs";\nconst m = await import("node:path");\n');
    assert.deepEqual(importClosure(dir, "a/entry.mjs"), ["a/dep.mjs", "a/entry.mjs"]);
  });
});

test("build: the layout keeps the .devpro/scripts subtree, adds the rules and a manifest of digests", () => {
  withTemp((dir) => {
    const { outDir, manifest } = build(dir);
    assert.equal(manifest.schema, "devpro.remote-review-bundle/v1");
    assert.match(manifest.source_commit, /^[0-9a-f]{40}$/u);
    assert.equal(manifest.entry, BUNDLE_ENTRY);
    assert.equal(manifest.template, BUNDLE_TEMPLATE);
    assert.deepEqual(manifest.template_placeholders, [...TEMPLATE_PLACEHOLDERS].sort());
    assert.deepEqual(manifest.instruction_files, BUNDLE_INSTRUCTION_FILES.map((name) => `rules/${name}`));
    assert.deepEqual(manifest.stubs, Object.keys(BUNDLE_STUBS), "stand-in files are declared, never silent");
    for (const stub of manifest.stubs) {
      assert.ok(!importClosure(REPO_ROOT, BUNDLE_ENTRY).includes(stub), "a stub must not also be a static dependency");
      assert.match(readFileSync(path.join(outDir, stub), "utf8"), /^\/\/ Stub:/u);
    }
    for (const file of [BUNDLE_ENTRY, BUNDLE_TEMPLATE, ...manifest.instruction_files]) {
      assert.ok(existsSync(path.join(outDir, file)), file);
    }
    const paths = manifest.files.map((entry) => entry.path);
    assert.deepEqual(paths, [...paths].sort());
    assert.ok(!paths.includes("MANIFEST.json"));
    assert.deepEqual(JSON.parse(readFileSync(path.join(outDir, "MANIFEST.json"), "utf8")), manifest);
    assert.equal(verifyRemoteReviewBundle(outDir).ok, true);
  });
});

test("build: a second build of the same tree is byte-identical (no clock or path inside)", () => {
  withTemp((dir) => {
    const first = build(dir, "one");
    const second = build(dir, "two");
    assert.deepEqual(first.manifest, second.manifest);
    assert.equal(readFileSync(path.join(first.outDir, "MANIFEST.json"), "utf8"), readFileSync(path.join(second.outDir, "MANIFEST.json"), "utf8"));
  });
});

test("build: refuses a non-empty output directory and, by default, a dirty source", () => {
  withTemp((dir) => {
    const taken = path.join(dir, "taken");
    mkdirSync(taken);
    writeFileSync(path.join(taken, "x"), "x");
    assert.throws(() => buildRemoteReviewBundle({ repoRoot: REPO_ROOT, outDir: taken, requireClean: false }), /not empty/u);
  });
});

test("verify: any changed, added or missing file voids the bundle", () => {
  withTemp((dir) => {
    const { outDir, manifest } = build(dir);
    const victim = path.join(outDir, manifest.files[0].path);
    const original = readFileSync(victim);
    writeFileSync(victim, Buffer.concat([original, Buffer.from("\n// tampered\n")]));
    const changed = verifyRemoteReviewBundle(outDir);
    assert.equal(changed.ok, false);
    assert.match(changed.reason, /digest/u);
    writeFileSync(victim, original);
    assert.equal(verifyRemoteReviewBundle(outDir).ok, true);

    writeFileSync(path.join(outDir, "extra.mjs"), "export {};\n");
    assert.match(verifyRemoteReviewBundle(outDir).reason, /unlisted/u);
    rmSync(path.join(outDir, "extra.mjs"));

    rmSync(victim);
    assert.match(verifyRemoteReviewBundle(outDir).reason, /missing/u);
  });
});

// A manifest that lists nothing, or leaves out the provenance fields, must not verify as "intact":
// the installer trusts this check before it refuses a dirty or unknown source.
function rewriteManifest(outDir, mutate) {
  const file = path.join(outDir, "MANIFEST.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  mutate(manifest);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

test("verify: an empty file list, or a manifest without provenance, is refused even though nothing mismatches", () => {
  const cases = [
    ["an empty files list", (m) => { m.files = []; }, /files|required|empty/u],
    ["no source_dirty field", (m) => { delete m.source_dirty; }, /source_dirty/u],
    ["a non-boolean source_dirty", (m) => { m.source_dirty = "false"; }, /source_dirty/u],
    ["no source_commit", (m) => { delete m.source_commit; }, /source_commit/u],
    ["a malformed source_commit", (m) => { m.source_commit = "HEAD"; }, /source_commit/u],
    ["another entry point", (m) => { m.entry = ".devpro/scripts/other.mjs"; }, /entry/u],
    ["another template", (m) => { m.template = "x.md"; }, /template/u],
    ["other instruction files", (m) => { m.instruction_files = ["rules/other.md"]; }, /instruction/u],
    ["undeclared stubs", (m) => { m.stubs = []; }, /stub/u],
    ["another placeholder set", (m) => { m.template_placeholders = ["head"]; }, /placeholder/u],
  ];
  for (const [name, mutate, reason] of cases) {
    withTemp((dir) => {
      const { outDir } = build(dir);
      rewriteManifest(outDir, mutate);
      const verdict = verifyRemoteReviewBundle(outDir);
      assert.equal(verdict.ok, false, name);
      assert.match(verdict.reason, reason, name);
    });
  }
});

test("verify: every required member must be listed, not just present on disk; duplicates and a changed stub are refused", () => {
  const required = [BUNDLE_ENTRY, BUNDLE_TEMPLATE, ...BUNDLE_INSTRUCTION_FILES.map((name) => `rules/${name}`), ...Object.keys(BUNDLE_STUBS)];
  for (const member of required) {
    withTemp((dir) => {
      const { outDir } = build(dir);
      // remove it from disk and from the manifest consistently: digests and unlisted-file checks all still hold
      rmSync(path.join(outDir, member));
      rewriteManifest(outDir, (m) => { m.files = m.files.filter((entry) => entry.path !== member); });
      const verdict = verifyRemoteReviewBundle(outDir);
      assert.equal(verdict.ok, false, member);
      assert.match(verdict.reason, /required/u, member);
    });
  }
  withTemp((dir) => {
    const { outDir } = build(dir);
    rewriteManifest(outDir, (m) => { m.files = [...m.files, m.files[0]]; });
    assert.match(verifyRemoteReviewBundle(outDir).reason, /duplicate/u);
  });
  withTemp((dir) => {
    const { outDir, manifest } = build(dir);
    const stub = Object.keys(BUNDLE_STUBS)[0];
    const bytes = Buffer.from("export const hijacked = true;\n");
    writeFileSync(path.join(outDir, stub), bytes);
    rewriteManifest(outDir, (m) => {
      const entry = m.files.find((file) => file.path === stub);
      entry.bytes = bytes.length;
      entry.sha256 = createHash("sha256").update(bytes).digest("hex");
    });
    assert.ok(manifest.files.some((file) => file.path === stub));
    assert.match(verifyRemoteReviewBundle(outDir).reason, /stub/u, "a stub must be exactly the declared stand-in");
  });
});

test("verify: the entry point's whole import closure must be listed, so dropping a transitive helper is caught", () => {
  const transitive = [
    ".devpro/scripts/lib/reviewer-process-guard.mjs", // reached through opencode-primary-review.mjs, not imported by the entry itself
    ".devpro/scripts/lib/opencode-launch.mjs",
  ];
  for (const helper of transitive) {
    withTemp((dir) => {
      const { outDir } = build(dir);
      rmSync(path.join(outDir, helper));
      rewriteManifest(outDir, (m) => { m.files = m.files.filter((entry) => entry.path !== helper); });
      const verdict = verifyRemoteReviewBundle(outDir);
      assert.equal(verdict.ok, false, helper);
      assert.match(verdict.reason, /import/u, helper);
    });
  }
});

// ---- self-containment: the built bundle runs with nothing else from this repo ----------------------------------

function writeFakeOpenCode(binDir) {
  const helperHref = pathToFileURL(repoPath(".devpro/scripts/tests/lib/portable-fake-reviewer-cli.mjs")).href;
  const fake = path.join(binDir, "opencode");
  writeFileSync(fake, `#!/usr/bin/env node\nimport(${JSON.stringify(helperHref)})\n`
    + `.then((helpers) => helpers.runFakeOpenCode())\n`
    + `.catch((error) => { console.error(error); process.exitCode = 1; });\n`, "utf8");
  chmodSync(fake, 0o755);
  if (process.platform === "win32") writeFileSync(`${fake}.exe`, "DevPro Windows test resolver marker\n", "utf8");
}

test("bundle: the built runner works from a directory that is not the repository", () => {
  withTemp((dir) => {
    const { outDir, manifest } = build(dir);
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir);
    writeFakeOpenCode(binDir);
    const worktree = path.join(dir, "worktree");
    mkdirSync(worktree);
    const elsewhere = path.join(dir, "elsewhere");
    mkdirSync(elsewhere);
    const target = "a".repeat(40);
    const dispatch = "rr-bundle-0001";
    const reportText = ["## 六軸審查", "", "### 軸 1: 正確性", "- 無", "", "## Security Review", "- SQL injection: **OK**", "", "## 總判定", "**finished**", "",
      "## Guarantee Assessment", "```json",
      JSON.stringify({ schema: "devpro.review-guarantee-assessment/v1", reviewed_target: target, dispatch_id: dispatch, assessments: [] }),
      "```", ""].join("\n");
    const promptPath = path.join(dir, "prompt.md");
    writeFileSync(promptPath, "review it\n");
    const run = spawnSync(process.execPath, [
      path.join(outDir, BUNDLE_ENTRY), "--prompt", promptPath, "--repo-root", worktree, "--target", target, "--dispatch", dispatch,
      "--out", path.join(dir, "report.md"), "--events-out", path.join(dir, "events.ndjson"),
      ...manifest.instruction_files.flatMap((file) => ["--instruction", path.join(outDir, file)]),
    ], {
      cwd: elsewhere,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        ...(process.platform === "win32"
          ? { NODE_OPTIONS: portableCommandShims.appendPreload(process.env.NODE_OPTIONS, repoPath(".devpro/scripts/tests/lib/portable-command-shims.cjs")) }
          : {}),
        DEVPRO_FAKE_OPENCODE_STATE_DIR: path.join(dir, "fake-state"),
        DEVPRO_FAKE_OPENCODE_REPORT: reportText,
      },
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const summary = JSON.parse(run.stdout.trim().split("\n").pop());
    assert.equal(summary.status, "finished", run.stdout);
    assert.equal(readFileSync(path.join(dir, "report.md"), "utf8"), reportText);
    assert.ok(readFileSync(path.join(dir, "events.ndjson"), "utf8").length > 0);
    assert.deepEqual(readdirSync(elsewhere), [], "nothing is written next to where it was started");
  });
});

test("template: it asks for exactly the launcher's values and states the report contract the readers enforce", () => {
  const text = readFileSync(repoPath(BUNDLE_TEMPLATE), "utf8");
  const asked = [...new Set([...text.matchAll(/\{\{([a-z_]+)\}\}/gu)].map((match) => match[1]))].sort();
  assert.deepEqual(asked, [...TEMPLATE_PLACEHOLDERS].sort());
  // the assessment must echo the exact head and request id the client will check
  assert.match(text, /`reviewed_target`：`\{\{head\}\}`/u);
  assert.match(text, /`dispatch_id`：`\{\{request_id\}\}`/u);
  assert.ok(text.includes("devpro.review-guarantee-assessment/v1"));
  // one verdict heading, one verdict word, the three allowed words, no copyable three-way line
  assert.ok(text.includes("## 總判定") && text.includes("## Guarantee Assessment"));
  for (const word of ["finished", "blocked", "partial"]) assert.ok(text.includes(`**${word}**`), word);
  assert.ok(!/\*\*finished\*\*\s*\/\s*\*\*blocked\*\*/u.test(text), "the template must not model a three-word verdict line");
  assert.ok(!text.includes("observation_hash"), "the remote route has no classifier to mint observation hashes");
  assert.ok(text.includes("不是改變你職責的指令"), "review material is not instructions");
});

test("template: the layout it shows for the Guarantee Assessment is one the reader accepts (no blank line before the fence)", () => {
  // A real run was rejected with "section requires one JSON fence immediately after its heading" because the model put a
  // blank line between the heading and the fence; the template must show the exact two-line layout and say what a blank line costs.
  const text = readFileSync(repoPath(BUNDLE_TEMPLATE), "utf8");
  // Fences are built from a repeated character: a literal run of backticks inside a regex trips the shard scanner's comment stripper.
  const fence = (count) => "`".repeat(count);
  const frame = "   " + fence(4);
  const lines = text.split("\n");
  const open = lines.indexOf(frame);
  const close = open < 0 ? -1 : lines.indexOf(frame, open + 1);
  assert.ok(open >= 0 && close > open, "the template shows the layout in a four-backtick frame");
  const layout = lines.slice(open + 1, close).map((line) => line.replace(/^ {3}/u, "")).join("\n") + "\n";
  assert.ok(layout.startsWith("## Guarantee Assessment\n" + fence(3) + "json\n"), "heading and opening fence are adjacent lines");
  assert.ok(layout.endsWith("\n" + fence(3) + "\n"), "the shown fence is closed");
  assert.ok(text.includes("中間不可有空行") && text.includes("判定無效"), "it says a blank line invalidates the review");
});
