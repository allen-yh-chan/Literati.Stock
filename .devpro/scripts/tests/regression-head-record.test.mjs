/**
 * regression-head-record.test.mjs
 *
 * R6 / design.md D16. The receipt that says which committed HEAD the canonical
 * test suite was last recorded green at, and the recorder that writes it.
 *
 * The gate-side behaviour (three states, both shas in the message, fail closed)
 * lives in `pre-pr-archive-gate-pre-review.test.mjs`, against the real gate.
 * What is proven HERE is the layer underneath: that writer and reader resolve
 * the same path, and that every way a receipt can be untrustworthy is reported
 * as untrustworthy rather than quietly treated as absent — or worse, as green.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";
import {
  evaluateLocalTestTipMoveReceipt,
  evaluateRegressionHeadCurrency,
  findAcceptableLocalTestReceipt,
  isAllowedPostRegressionHeadDeltaPath,
  isValidChangeName,
  normalizeMergeAcceptableSuiteEvidence,
  readRegressionHeadRecord,
  REGRESSION_HEAD_SHA_RE,
  regressionHeadRecordPath,
  SUITE_DIGEST_SHA256_RE,
  writeRegressionHeadRecord,
} from "../lib/regression-head-record.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDER = path.resolve(HERE, "../record-regression-head.mjs");

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const CHANGE = "fix-zero-value-review-rounds";

/** A bare directory standing in for a main-checkout root. Passing
 * `mainCheckoutRoot` explicitly keeps these cases off git entirely; the
 * git-derived resolution is exercised by the CLI cases below. */
function withRoot(fn) {
  const root = makeTempDir("regression-head-root-");
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const PASS_SUITE_EVIDENCE = { status: "pass", fail: 0, digest_sha256: "c".repeat(64) };
describe("isValidChangeName", () => {
  test("accepts the shapes `openspec/changes/` actually holds", () => {
    for (const name of ["fix-zero-value-review-rounds", "a", "v1.2.3", "chore_x", "R2-D2"]) {
      assert.equal(isValidChangeName(name), true, name);
    }
  });

  test("rejects anything that could escape notes/ or name another change's receipt", () => {
    // The name is interpolated into a filename, so this is the containment
    // boundary — rejected outright rather than sanitized into something
    // adjacent-but-wrong.
    for (const name of ["..", ".", "", "a/b", "../../etc/passwd", "a b", "-leading", "x\0y", null, undefined]) {
      assert.equal(isValidChangeName(name), false, JSON.stringify(name));
    }
  });
});

describe("regressionHeadRecordPath", () => {
  test("is <main-checkout-root>/notes/qa-regression-head-<change>.json", () => {
    withRoot((root) => {
      assert.equal(
        regressionHeadRecordPath({ change: CHANGE, mainCheckoutRoot: root }),
        path.join(root, "notes", `qa-regression-head-${CHANGE}.json`)
      );
    });
  });

  test("throws rather than building a path from an unusable change name", () => {
    withRoot((root) => {
      assert.throws(
        () => regressionHeadRecordPath({ change: "../escape", mainCheckoutRoot: root }),
        /invalid change name/
      );
    });
  });
});

describe("writeRegressionHeadRecord", () => {
  test("writes the four recorded fields and creates notes/ on the way", () => {
    withRoot((root) => {
      const result = writeRegressionHeadRecord({
        change: CHANGE,
        headSha: SHA_A,
        branch: "chore/fix-zero-value-review-rounds",
        mainCheckoutRoot: root,
        now: () => new Date("2026-09-09T00:00:00.000Z"),
      suiteEvidence: PASS_SUITE_EVIDENCE,
    });
      assert.equal(result.status, "written");
      const onDisk = JSON.parse(readFileSync(result.recordPath, "utf8"));
      assert.deepEqual(onDisk, {
        change: CHANGE,
        branch: "chore/fix-zero-value-review-rounds",
        head_sha: SHA_A,
        recorded_at: "2026-09-09T00:00:00.000Z",
        suite_evidence: PASS_SUITE_EVIDENCE,
      });
    });
  });

  test("refuses missing or non-merge-acceptable suiteEvidence", () => {
    withRoot((root) => {
      assert.equal(
        writeRegressionHeadRecord({ change: CHANGE, headSha: SHA_A, mainCheckoutRoot: root }).status,
        "invalid_suite_evidence",
      );
      assert.equal(
        writeRegressionHeadRecord({
          change: CHANGE,
          headSha: SHA_A,
          mainCheckoutRoot: root,
          suiteEvidence: { status: "fail", fail: 0, digest_sha256: "c".repeat(64) },
        }).status,
        "invalid_suite_evidence",
      );
      assert.equal(
        writeRegressionHeadRecord({
          change: CHANGE,
          headSha: SHA_A,
          mainCheckoutRoot: root,
          suiteEvidence: { status: "pass", fail: 1, digest_sha256: "c".repeat(64) },
        }).status,
        "invalid_suite_evidence",
      );
      assert.equal(
        writeRegressionHeadRecord({
          change: CHANGE,
          headSha: SHA_A,
          mainCheckoutRoot: root,
          suiteEvidence: { status: "pass", fail: 0, digest_sha256: "abc" },
        }).status,
        "invalid_suite_evidence",
      );
    });
  });

  test("refuses a sha that is not strict lowercase 40-hex", () => {
    withRoot((root) => {
      for (const sha of [SHA_A.slice(0, 12), SHA_A.toUpperCase(), "", null, "zzzz"]) {
        const result = writeRegressionHeadRecord({ change: CHANGE, headSha: sha, mainCheckoutRoot: root,
      suiteEvidence: PASS_SUITE_EVIDENCE,
    });
        assert.equal(result.status, "invalid_sha", JSON.stringify(sha));
      }
    });
  });

  test("reports a failed write instead of failing open", () => {
    // A silent failure here would only relocate the stop to the gate, where the
    // author is told "no receipt" instead of "the receipt could not be written".
    withRoot((root) => {
      writeFileSync(path.join(root, "notes"), "not a directory\n");
      const result = writeRegressionHeadRecord({ change: CHANGE, headSha: SHA_A, mainCheckoutRoot: root,
      suiteEvidence: PASS_SUITE_EVIDENCE,
    });
      assert.equal(result.status, "write_failed");
      assert.ok(result.reason.length > 0);
    });
  });

  test("rejects a symlinked notes parent without creating an outside receipt", (t) => {
    withRoot((root) => {
      const outside = makeTempDir("regression-head-outside-parent-");
      try {
        try {
          symlinkSync(outside, path.join(root, "notes"), process.platform === "win32" ? "junction" : "dir");
        } catch (error) {
          if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error?.code)) {
            t.skip(`symlink creation unavailable: ${error.code}`);
            return;
          }
          throw error;
        }
        const outsideReceipt = path.join(outside, `qa-regression-head-${CHANGE}.json`);
        const result = writeRegressionHeadRecord({ change: CHANGE, headSha: SHA_A, mainCheckoutRoot: root,
      suiteEvidence: PASS_SUITE_EVIDENCE,
    });
        assert.equal(result.status, "write_failed");
        assert.equal(existsSync(outsideReceipt), false, "writer must not follow the parent link outside its root");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  test("rejects a symlinked final target without overwriting its outside sentinel", (t) => {
    withRoot((root) => {
      const outside = makeTempDir("regression-head-outside-target-");
      try {
        const notes = path.join(root, "notes");
        mkdirSync(notes);
        const sentinel = path.join(outside, "sentinel.json");
        writeFileSync(sentinel, "outside sentinel\n");
        try {
          symlinkSync(sentinel, regressionHeadRecordPath({ change: CHANGE, mainCheckoutRoot: root }), "file");
        } catch (error) {
          if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error?.code)) {
            t.skip(`symlink creation unavailable: ${error.code}`);
            return;
          }
          throw error;
        }
        const result = writeRegressionHeadRecord({ change: CHANGE, headSha: SHA_A, mainCheckoutRoot: root,
      suiteEvidence: PASS_SUITE_EVIDENCE,
    });
        assert.equal(result.status, "write_failed");
        assert.equal(readFileSync(sentinel, "utf8"), "outside sentinel\n");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });
});

describe("readRegressionHeadRecord", () => {
  function seed(root, contents) {
    const recordPath = regressionHeadRecordPath({ change: CHANGE, mainCheckoutRoot: root });
    mkdirSync(path.dirname(recordPath), { recursive: true });
    writeFileSync(recordPath, contents);
    return recordPath;
  }

  test("round-trips what the writer wrote", () => {
    withRoot((root) => {
      writeRegressionHeadRecord({ change: CHANGE, headSha: SHA_A, branch: "main", mainCheckoutRoot: root,
      suiteEvidence: PASS_SUITE_EVIDENCE,
    });
      const read = readRegressionHeadRecord({ change: CHANGE, mainCheckoutRoot: root });
      assert.equal(read.status, "ok");
      assert.equal(read.record.head_sha, SHA_A);
    });
  });

  test("an absent receipt is `missing`, distinct from an untrustworthy one", () => {
    withRoot((root) => {
      const read = readRegressionHeadRecord({ change: CHANGE, mainCheckoutRoot: root });
      assert.equal(read.status, "missing");
      assert.equal(read.record, null);
    });
  });

  test("unparseable, non-object and malformed-sha receipts are all `unusable`", () => {
    withRoot((root) => {
      for (const [contents, pattern] of [
        ["{not json", /not valid JSON/],
        ["[]\n", /not a JSON object/],
        ["null\n", /not a JSON object/],
        [`{"change":"${CHANGE}","head_sha":"abc"}\n`, /head_sha is not 40-hex/],
        [`{"change":"${CHANGE}"}\n`, /head_sha is not 40-hex/],
        [`{"change":"${CHANGE}","head_sha":"${SHA_A.toUpperCase()}"}\n`, /head_sha is not 40-hex/],
      ]) {
        seed(root, contents);
        const read = readRegressionHeadRecord({ change: CHANGE, mainCheckoutRoot: root });
        assert.equal(read.status, "unusable", contents);
        assert.match(read.reason, pattern);
      }
    });
  });

  test("invalid UTF-8 is unusable even when replacement decoding would preserve authority fields", () => {
    withRoot((root) => {
      seed(root, Buffer.concat([
        Buffer.from(`{"change":"${CHANGE}","branch":"`, "utf8"),
        Buffer.from([0xc3, 0x28]),
        Buffer.from(`","head_sha":"${SHA_A}"}\n`, "utf8"),
      ]));
      const read = readRegressionHeadRecord({ change: CHANGE, mainCheckoutRoot: root });
      assert.equal(read.status, "unusable");
      assert.match(read.reason, /UTF-8/i);
    });
  });

  test("a receipt keyed to another change is unusable, not silently accepted", () => {
    // The filename IS the key. A body disagreeing with it means the file was
    // hand-edited or written by a different scheme; trusting either half of a
    // contradiction is a guess.
    withRoot((root) => {
      seed(root, `{"change":"some-other-change","head_sha":"${SHA_A}"}\n`);
      const read = readRegressionHeadRecord({ change: CHANGE, mainCheckoutRoot: root });
      assert.equal(read.status, "unusable");
      assert.match(read.reason, /keyed to change "some-other-change"/);
    });
  });

  test("rejects a symlinked target instead of reading an outside valid receipt", (t) => {
    withRoot((root) => {
      const outside = makeTempDir("regression-head-read-outside-");
      try {
        const notes = path.join(root, "notes");
        mkdirSync(notes);
        const sentinel = path.join(outside, "valid.json");
        writeFileSync(sentinel, `{"change":"${CHANGE}","head_sha":"${SHA_A}"}\n`);
        try {
          symlinkSync(sentinel, regressionHeadRecordPath({ change: CHANGE, mainCheckoutRoot: root }), "file");
        } catch (error) {
          if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error?.code)) {
            t.skip(`symlink creation unavailable: ${error.code}`);
            return;
          }
          throw error;
        }
        const read = readRegressionHeadRecord({ change: CHANGE, mainCheckoutRoot: root });
        assert.equal(read.status, "unusable");
        assert.match(read.reason, /target-not-regular-file/);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  test("rejects an oversized receipt before allocating or parsing its body", () => {
    withRoot((root) => {
      const recordPath = regressionHeadRecordPath({ change: CHANGE, mainCheckoutRoot: root });
      mkdirSync(path.dirname(recordPath));
      writeFileSync(recordPath, "");
      truncateSync(recordPath, 64 * 1024 + 1);
      const read = readRegressionHeadRecord({ change: CHANGE, mainCheckoutRoot: root });
      assert.equal(read.status, "unusable");
      assert.match(read.reason, /target-oversize/);
    });
  });
});

describe("evaluateRegressionHeadCurrency", () => {
  test("matching sha is the only `ok` verdict", () => {
    withRoot((root) => {
      writeRegressionHeadRecord({ change: CHANGE, headSha: SHA_A, branch: "main", mainCheckoutRoot: root,
      suiteEvidence: PASS_SUITE_EVIDENCE,
    });
      const verdict = evaluateRegressionHeadCurrency({ change: CHANGE, currentHeadSha: SHA_A, mainCheckoutRoot: root });
      assert.equal(verdict.ok, true);
      assert.equal(verdict.kind, "current");
      assert.equal(verdict.testedSha, SHA_A);
      assert.equal(verdict.currentSha, SHA_A);
    });
  });

  test("a moved HEAD is `stale` and carries BOTH shas", () => {
    withRoot((root) => {
      writeRegressionHeadRecord({ change: CHANGE, headSha: SHA_A, mainCheckoutRoot: root,
      suiteEvidence: PASS_SUITE_EVIDENCE,
    });
      const verdict = evaluateRegressionHeadCurrency({ change: CHANGE, currentHeadSha: SHA_B, mainCheckoutRoot: root });
      assert.equal(verdict.ok, false);
      assert.equal(verdict.kind, "stale");
      assert.equal(verdict.testedSha, SHA_A);
      assert.equal(verdict.currentSha, SHA_B);
    });
  });

  test("missing and unusable both fail, and stay distinguishable", () => {
    withRoot((root) => {
      const missing = evaluateRegressionHeadCurrency({ change: CHANGE, currentHeadSha: SHA_A, mainCheckoutRoot: root });
      assert.equal(missing.ok, false);
      assert.equal(missing.kind, "missing");
      assert.equal(missing.testedSha, null, "there is no tested sha to name");

      const recordPath = regressionHeadRecordPath({ change: CHANGE, mainCheckoutRoot: root });
      mkdirSync(path.dirname(recordPath), { recursive: true });
      writeFileSync(recordPath, "{oops");
      const unusable = evaluateRegressionHeadCurrency({ change: CHANGE, currentHeadSha: SHA_A, mainCheckoutRoot: root });
      assert.equal(unusable.kind, "unusable");
    });
  });

  test("an unresolvable current HEAD fails closed too", () => {
    // If the gate cannot say what it is about to review, a matching receipt
    // would be matching against nothing.
    withRoot((root) => {
      writeRegressionHeadRecord({ change: CHANGE, headSha: SHA_A, mainCheckoutRoot: root,
      suiteEvidence: PASS_SUITE_EVIDENCE,
    });
      const verdict = evaluateRegressionHeadCurrency({ change: CHANGE, currentHeadSha: "", mainCheckoutRoot: root });
      assert.equal(verdict.ok, false);
      assert.equal(verdict.kind, "unusable");
      assert.match(verdict.reason, /current HEAD is not a 40-hex sha/);
    });
  });
});

describe("isAllowedPostRegressionHeadDeltaPath (D1; narrower than smoke)", () => {
  test("allows bookkeeping surfaces and denies scripts/tests/UI/behavior skill md", () => {
    assert.equal(isAllowedPostRegressionHeadDeltaPath("openspec/changes/x/qa-test-scope.md"), true);
    assert.equal(isAllowedPostRegressionHeadDeltaPath("notes/qa.json"), true);
    assert.equal(isAllowedPostRegressionHeadDeltaPath("docs/guide.md"), true);
    assert.equal(isAllowedPostRegressionHeadDeltaPath("README.md"), true);
    // Must NOT byte-reuse smoke allowlist: scripts are green for smoke, stale for R6.
    assert.equal(isAllowedPostRegressionHeadDeltaPath(".devpro/scripts/x.mjs"), false);
    assert.equal(isAllowedPostRegressionHeadDeltaPath(".devpro/scripts/tests/x.test.mjs"), false);
    assert.equal(isAllowedPostRegressionHeadDeltaPath("src/foo.test.mjs"), false);
    assert.equal(isAllowedPostRegressionHeadDeltaPath("pkg/tests/helper.mjs"), false);
    assert.equal(isAllowedPostRegressionHeadDeltaPath("src/App.tsx"), false);
    assert.equal(
      isAllowedPostRegressionHeadDeltaPath(
        ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md",
      ),
      false,
    );
    assert.equal(
      isAllowedPostRegressionHeadDeltaPath(
        ".devpro/agent-skills/devpro-workflows/pre-pr/references/x.md",
      ),
      false,
    );
  });
});

describe("evaluateRegressionHeadCurrency bookkeeping tip-move carve-out (D2/D7)", () => {
  function gitRepo() {
    const dir = makeTempDir("regression-head-carve-");
    const git = (args) => {
      const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
      assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
      return r;
    };
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git(["config", "user.name", "Fixture"]);
    writeFileSync(path.join(dir, "README.md"), "fixture\n");
    writeFileSync(path.join(dir, ".gitignore"), "notes/\n");
    mkdirSync(path.join(dir, "openspec/changes", CHANGE), { recursive: true });
    writeFileSync(path.join(dir, "openspec/changes", CHANGE, "proposal.md"), "# p\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "baseline"]);
    return { dir, git };
  }

  function recordAtHead(dir, git) {
    const head = git(["rev-parse", "HEAD"]).stdout.trim();
    const written = writeRegressionHeadRecord({ cwd: dir, change: CHANGE, headSha: head, branch: "main",
      suiteEvidence: PASS_SUITE_EVIDENCE,
    });
    assert.equal(written.status, "written");
    return head;
  }

  test("D7-1 bookkeeping-only tip-move keeps currency without rewriting the receipt", () => {
    const { dir, git } = gitRepo();
    try {
      const tested = recordAtHead(dir, git);
      mkdirSync(path.join(dir, "docs"), { recursive: true });
      writeFileSync(path.join(dir, "docs", "tip-move.md"), "docs only\n");
      writeFileSync(
        path.join(dir, "openspec/changes", CHANGE, "qa-test-scope.md"),
        "### 1)\nbookkeeping\n",
      );
      git(["add", "docs/tip-move.md", `openspec/changes/${CHANGE}/qa-test-scope.md`]);
      git(["commit", "-q", "-m", "docs and change-folder tip-move"]);
      const current = git(["rev-parse", "HEAD"]).stdout.trim();
      assert.notEqual(tested, current);

      const verdict = evaluateRegressionHeadCurrency({
        cwd: dir,
        change: CHANGE,
        currentHeadSha: current,
      });
      assert.equal(verdict.ok, true);
      assert.equal(verdict.kind, "current-bookkeeping-tip-move");
      assert.equal(verdict.testedSha, tested);
      assert.equal(verdict.currentSha, current);
      // Receipt must still name the last-green tree — no rewrite.
      const read = readRegressionHeadRecord({ cwd: dir, change: CHANGE });
      assert.equal(read.record.head_sha, tested);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("D7-2 scripts/tests delta remains stale", () => {
    const { dir, git } = gitRepo();
    try {
      const tested = recordAtHead(dir, git);
      mkdirSync(path.join(dir, ".devpro/scripts/tests"), { recursive: true });
      writeFileSync(path.join(dir, ".devpro/scripts/lib-helper.mjs"), "export const x = 1;\n");
      writeFileSync(path.join(dir, ".devpro/scripts/tests/lib-helper.test.mjs"), "import 'node:test';\n");
      git(["add", ".devpro/scripts/lib-helper.mjs", ".devpro/scripts/tests/lib-helper.test.mjs"]);
      git(["commit", "-q", "-m", "scripts and tests delta"]);
      const current = git(["rev-parse", "HEAD"]).stdout.trim();

      const verdict = evaluateRegressionHeadCurrency({
        cwd: dir,
        change: CHANGE,
        currentHeadSha: current,
      });
      assert.equal(verdict.ok, false);
      assert.equal(verdict.kind, "stale");
      assert.equal(verdict.testedSha, tested);
      assert.equal(verdict.currentSha, current);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("D7-5 rename of non-allowed path into docs/ still stale (rename-aware)", () => {
    const { dir, git } = gitRepo();
    try {
      mkdirSync(path.join(dir, ".devpro/scripts"), { recursive: true });
      // Keep body identical across the move so git rename detection fires;
      // --name-only then shows only docs/, which would falsely green without
      // rename-aware source+destination expansion (F-DG-R1-01).
      const body = "export const task = 1;\n" + "// pad\n".repeat(40);
      writeFileSync(path.join(dir, ".devpro/scripts/task.mjs"), body);
      git(["add", ".devpro/scripts/task.mjs"]);
      git(["commit", "-q", "-m", "add executable"]);
      const tested = recordAtHead(dir, git);

      mkdirSync(path.join(dir, "docs"), { recursive: true });
      git(["mv", ".devpro/scripts/task.mjs", "docs/task.md"]);
      git(["commit", "-q", "-m", "rename scripts to docs"]);
      const current = git(["rev-parse", "HEAD"]).stdout.trim();

      const nameOnly = git(["diff", "--name-only", "-M", `${tested}..${current}`]).stdout;
      assert.equal(nameOnly.trim(), "docs/task.md", "fixture must expose destination-only under name-only");
      const nameStatus = git(["diff", "--name-status", "-M", `${tested}..${current}`]).stdout;
      assert.match(nameStatus, /^R\d+\t\.devpro\/scripts\/task\.mjs\tdocs\/task\.md$/m);

      const verdict = evaluateRegressionHeadCurrency({
        cwd: dir,
        change: CHANGE,
        currentHeadSha: current,
      });
      assert.equal(verdict.ok, false, "destination-only allowlist must not mint currency across a scripts rename");
      assert.equal(verdict.kind, "stale");
      assert.equal(verdict.testedSha, tested);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("D7-6 behavior-bearing devpro:pre-pr SKILL.md edit is stale, not bookkeeping", () => {
    const { dir, git } = gitRepo();
    try {
      const skillDir = path.join(dir, ".devpro/agent-skills/devpro-workflows/pre-pr");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(path.join(skillDir, "SKILL.md"), "# devpro:pre-pr\nexact-HEAD only\n");
      git(["add", ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md"]);
      git(["commit", "-q", "-m", "seed skill"]);
      const tested = recordAtHead(dir, git);

      writeFileSync(path.join(skillDir, "SKILL.md"), "# devpro:pre-pr\nancestor bookkeeping carve-out\n");
      git(["add", ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md"]);
      git(["commit", "-q", "-m", "behavior-bearing skill edit"]);
      const current = git(["rev-parse", "HEAD"]).stdout.trim();

      const verdict = evaluateRegressionHeadCurrency({
        cwd: dir,
        change: CHANGE,
        currentHeadSha: current,
      });
      assert.equal(verdict.ok, false);
      assert.equal(verdict.kind, "stale");
      assert.equal(verdict.testedSha, tested);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("record-regression-head.mjs (CLI)", () => {
  function gitRepo() {
    const dir = makeTempDir("regression-head-cli-");
    const git = (args) => {
      const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
      assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
      return r;
    };
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git(["config", "user.name", "Fixture"]);
    writeFileSync(path.join(dir, "README.md"), "fixture\n");
    writeFileSync(path.join(dir, ".gitignore"), "notes/\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "baseline"]);
    return { dir, git };
  }

  function runRecorder(dir, args) {
    return spawnSync("node", [RECORDER, ...args], { encoding: "utf8", cwd: dir });
  }

  test("derives the sha itself — the TL never hands one in", () => {
    const { dir, git } = gitRepo();
    try {
      const r = runRecorder(dir, ["--change", CHANGE, "--suite-status", "pass", "--suite-fail", "0", "--suite-digest", "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"]);
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);

      const head = git(["rev-parse", "HEAD"]).stdout.trim();
      assert.match(r.stdout, new RegExp(`recorded ${head} for change "${CHANGE}"`));

      const read = readRegressionHeadRecord({ cwd: dir, change: CHANGE });
      assert.equal(read.status, "ok");
      assert.equal(read.record.head_sha, head);
      assert.equal(read.record.branch, "main");
      assert.match(read.record.head_sha, REGRESSION_HEAD_SHA_RE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a second commit makes the recorded receipt stale until it is re-run", () => {
    // This is item `## 107.`'s actual shape: suite green at HEAD1, Step 2's
    // simplification pass commits to HEAD2, reviewer dispatched against HEAD2.
    const { dir, git } = gitRepo();
    try {
      assert.equal(runRecorder(dir, ["--change", CHANGE, "--suite-status", "pass", "--suite-fail", "0", "--suite-digest", "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"]).status, 0);
      const tested = git(["rev-parse", "HEAD"]).stdout.trim();

      writeFileSync(path.join(dir, "simplified.md"), "chore: simplify\n");
      git(["add", "simplified.md"]);
      git(["commit", "-q", "-m", "chore: simplify"]);
      const current = git(["rev-parse", "HEAD"]).stdout.trim();

      const stale = evaluateRegressionHeadCurrency({ cwd: dir, change: CHANGE, currentHeadSha: current });
      assert.equal(stale.kind, "stale");
      assert.equal(stale.testedSha, tested);

      assert.equal(runRecorder(dir, ["--change", CHANGE, "--suite-status", "pass", "--suite-fail", "0", "--suite-digest", "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"]).status, 0);
      const refreshed = evaluateRegressionHeadCurrency({ cwd: dir, change: CHANGE, currentHeadSha: current });
      assert.equal(refreshed.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--change=<name> is accepted in both spellings", () => {
    const { dir } = gitRepo();
    try {
      assert.equal(runRecorder(dir, [`--change=${CHANGE}`, "--suite-status=pass", "--suite-fail=0", `--suite-digest=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc`]).status, 0);
      assert.equal(readRegressionHeadRecord({ cwd: dir, change: CHANGE }).status, "ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing, invalid or unrecognized argument is a loud usage error", () => {
    const { dir } = gitRepo();
    try {
      for (const [args, pattern] of [
        [[], /--change <name> is required/],
        [["--change"], /--change <name> is required/],
        [["--change", "../escape"], /invalid change name/],
        [["--change", CHANGE], /--suite-status pass is required/],
        [["--change", CHANGE, "--suite-status", "pass"], /--suite-fail 0 is required/],
        [["--change", CHANGE, "--suite-status", "pass", "--suite-fail", "0"], /--suite-digest <64hex> is required/],
        [["--change", CHANGE, "--suite-status", "fail", "--suite-fail", "0", "--suite-digest", "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"], /status must be "pass"/],
        [["--change", CHANGE, "--suite-status", "pass", "--suite-fail", "1", "--suite-digest", "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"], /fail must be integer 0/],
        [["--sha", SHA_A], /unrecognized argument: --sha/],
      ]) {
        const r = runRecorder(dir, args);
        assert.equal(r.status, 1, `expected exit 1 for ${JSON.stringify(args)}: ${r.stdout}`);
        assert.match(r.stderr, pattern);
        assert.match(r.stderr, /usage: node \.devpro\/scripts\/record-regression-head\.mjs --change <name> --suite-status pass --suite-fail 0 --suite-digest <64hex>/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a repo with no commit yet exits 1 rather than writing an empty receipt", () => {
    const dir = makeTempDir("regression-head-empty-");
    try {
      const init = spawnSync("git", ["-C", dir, "init", "-q", "-b", "main"], { encoding: "utf8" });
      assert.equal(init.status, 0, init.stderr);
      const r = runRecorder(dir, ["--change", CHANGE, "--suite-status", "pass", "--suite-fail", "0", "--suite-digest", "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"]);
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout}`);
      assert.match(r.stderr, /could not resolve the current committed HEAD/);
      assert.equal(readRegressionHeadRecord({ cwd: dir, change: CHANGE }).status, "missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("normalizeMergeAcceptableSuiteEvidence", () => {
  test("accepts pass/fail0/64hex only", () => {
    assert.equal(normalizeMergeAcceptableSuiteEvidence(PASS_SUITE_EVIDENCE).ok, true);
    assert.equal(normalizeMergeAcceptableSuiteEvidence({ status: "pass", fail: 0, digest_sha256: "AB".repeat(32) }).ok, false);
    assert.equal(SUITE_DIGEST_SHA256_RE.test("c".repeat(64)), true);
  });
});

describe("findAcceptableLocalTestReceipt", () => {
  test("matching pass/fail0 receipt is ok; missing suite_evidence is not", () => {
    withRoot((root) => {
      const written = writeRegressionHeadRecord({
        change: CHANGE,
        headSha: SHA_A,
        mainCheckoutRoot: root,
        suiteEvidence: PASS_SUITE_EVIDENCE,
      });
      assert.equal(written.status, "written");
      const found = findAcceptableLocalTestReceipt({ headSha: SHA_A, mainCheckoutRoot: root });
      assert.equal(found.ok, true);
      assert.equal(found.record.head_sha, SHA_A);

      // Old currency-only receipt (no suite_evidence) is readable but not merge-acceptable.
      const legacyPath = regressionHeadRecordPath({ change: "legacy-currency", mainCheckoutRoot: root });
      writeFileSync(
        legacyPath,
        JSON.stringify({ change: "legacy-currency", head_sha: SHA_A, recorded_at: "2026-01-01T00:00:00.000Z" }, null, 2) + "\n",
      );
      // SHA_A already has acceptable receipt from first write — use SHA_B for legacy-only.
      writeFileSync(
        regressionHeadRecordPath({ change: "legacy-only", mainCheckoutRoot: root }),
        JSON.stringify({ change: "legacy-only", head_sha: SHA_B, recorded_at: "2026-01-01T00:00:00.000Z" }, null, 2) + "\n",
      );
      const legacy = findAcceptableLocalTestReceipt({ headSha: SHA_B, mainCheckoutRoot: root });
      assert.equal(legacy.ok, false);
      assert.match(legacy.reason, /no acceptable local-test receipt/);
    });
  });

  test("fail!==0 and wrong head are not acceptable", () => {
    withRoot((root) => {
      const recordPath = regressionHeadRecordPath({ change: CHANGE, mainCheckoutRoot: root });
      mkdirSync(path.dirname(recordPath), { recursive: true });
      writeFileSync(
        recordPath,
        JSON.stringify({
          change: CHANGE,
          head_sha: SHA_A,
          suite_evidence: { status: "pass", fail: 2, digest_sha256: "c".repeat(64) },
        }) + "\n",
      );
      assert.equal(findAcceptableLocalTestReceipt({ headSha: SHA_A, mainCheckoutRoot: root }).ok, false);
      assert.equal(findAcceptableLocalTestReceipt({ headSha: SHA_B, mainCheckoutRoot: root }).ok, false);
    });
  });
});

describe("evaluateLocalTestTipMoveReceipt (D3 — form (2) / S1)", () => {
  function gitRepo() {
    const dir = makeTempDir("regression-head-tip-move-receipt-");
    const git = (args) => {
      const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
      assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
      return r;
    };
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git(["config", "user.name", "Fixture"]);
    writeFileSync(path.join(dir, "README.md"), "fixture\n");
    writeFileSync(path.join(dir, ".gitignore"), "notes/\n");
    mkdirSync(path.join(dir, "openspec/changes", CHANGE), { recursive: true });
    writeFileSync(path.join(dir, "openspec/changes", CHANGE, "proposal.md"), "# p\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "baseline"]);
    return { dir, git };
  }

  function recordAtHead(dir, git) {
    const head = git(["rev-parse", "HEAD"]).stdout.trim();
    const written = writeRegressionHeadRecord({
      cwd: dir,
      change: CHANGE,
      headSha: head,
      branch: "main",
      suiteEvidence: PASS_SUITE_EVIDENCE,
    });
    assert.equal(written.status, "written");
    return head;
  }

  /** A pre-`suite_evidence` receipt (D16-era): readable for `--pre-review`
   * currency, never merge-acceptable. Written by hand because
   * `writeRegressionHeadRecord` refuses to write one (by design). */
  function recordLegacyAtHead(dir) {
    const head = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const recordPath = regressionHeadRecordPath({ cwd: dir, change: CHANGE });
    mkdirSync(path.dirname(recordPath), { recursive: true });
    writeFileSync(
      recordPath,
      JSON.stringify({ change: CHANGE, head_sha: head, recorded_at: "2026-01-01T00:00:00.000Z" }, null, 2) + "\n",
    );
    return head;
  }

  test("bookkeeping tip-move over an acceptable receipt is accepted", () => {
    const { dir, git } = gitRepo();
    try {
      const tested = recordAtHead(dir, git);
      mkdirSync(path.join(dir, "docs"), { recursive: true });
      writeFileSync(path.join(dir, "docs", "tip-move.md"), "docs only\n");
      git(["add", "docs/tip-move.md"]);
      git(["commit", "-q", "-m", "docs-only tip-move"]);
      const current = git(["rev-parse", "HEAD"]).stdout.trim();

      const result = evaluateLocalTestTipMoveReceipt({ cwd: dir, change: CHANGE, headSha: current });
      assert.equal(result.ok, true);
      assert.equal(result.kind, "current-bookkeeping-tip-move");
      assert.equal(result.testedSha, tested);
      assert.equal(result.currentSha, current);
      assert.equal(typeof result.delta_count, "number");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bookkeeping tip-move over a receipt missing suite_evidence is not merge-acceptable, even though currency alone holds", () => {
    const { dir, git } = gitRepo();
    try {
      const tested = recordLegacyAtHead(dir);
      mkdirSync(path.join(dir, "docs"), { recursive: true });
      writeFileSync(path.join(dir, "docs", "tip-move.md"), "docs only\n");
      git(["add", "docs/tip-move.md"]);
      git(["commit", "-q", "-m", "docs-only tip-move"]);
      const current = git(["rev-parse", "HEAD"]).stdout.trim();

      const currency = evaluateRegressionHeadCurrency({ cwd: dir, change: CHANGE, currentHeadSha: current });
      assert.equal(currency.ok, true, "the currency-only evaluator still greenlights a legacy receipt");
      assert.equal(currency.kind, "current-bookkeeping-tip-move");

      const result = evaluateLocalTestTipMoveReceipt({ cwd: dir, change: CHANGE, headSha: current });
      assert.equal(result.ok, false);
      assert.equal(result.kind, "suite-evidence-unacceptable");
      assert.equal(result.testedSha, tested);
      assert.equal(result.currentSha, current);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a non-bookkeeping delta touching openspec/specs/** stays stale, and the path is named in `blocked`", () => {
    const { dir, git } = gitRepo();
    try {
      const tested = recordAtHead(dir, git);
      mkdirSync(path.join(dir, "openspec/specs/pre-tool-mechanical-gates"), { recursive: true });
      writeFileSync(path.join(dir, "openspec/specs/pre-tool-mechanical-gates/spec.md"), "# spec\n");
      git(["add", "openspec/specs/pre-tool-mechanical-gates/spec.md"]);
      git(["commit", "-q", "-m", "promote spec"]);
      const current = git(["rev-parse", "HEAD"]).stdout.trim();

      const result = evaluateLocalTestTipMoveReceipt({ cwd: dir, change: CHANGE, headSha: current });
      assert.equal(result.ok, false);
      assert.equal(result.kind, "stale");
      assert.equal(result.testedSha, tested);
      assert.equal(result.currentSha, current);
      assert.ok(
        result.blocked.includes("openspec/specs/pre-tool-mechanical-gates/spec.md"),
        JSON.stringify(result.blocked),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a current head unrelated to (not a descendant of) the tested sha is stale, with no `blocked` list", () => {
    const { dir, git } = gitRepo();
    try {
      const tested = recordAtHead(dir, git);
      git(["checkout", "-q", "--orphan", "unrelated"]);
      writeFileSync(path.join(dir, "other.md"), "other\n");
      git(["add", "other.md"]);
      git(["commit", "-q", "-m", "unrelated root"]);
      const current = git(["rev-parse", "HEAD"]).stdout.trim();
      assert.notEqual(tested, current);

      const result = evaluateLocalTestTipMoveReceipt({ cwd: dir, change: CHANGE, headSha: current });
      assert.equal(result.ok, false);
      assert.equal(result.kind, "stale");
      assert.equal(result.testedSha, tested);
      assert.equal(result.currentSha, current);
      assert.equal(result.blocked, undefined, "non-ancestor stale never reached the delta-path diff");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unmappable change name is refused before any git or receipt lookup", () => {
    const { dir } = gitRepo();
    try {
      const result = evaluateLocalTestTipMoveReceipt({ cwd: dir, change: "../escape", headSha: SHA_A });
      assert.deepEqual(result, { ok: false, kind: "change-unmapped" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a mapped change with no receipt at all is `missing`, not silently accepted", () => {
    const { dir } = gitRepo();
    try {
      const head = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      const result = evaluateLocalTestTipMoveReceipt({ cwd: dir, change: CHANGE, headSha: head });
      assert.equal(result.ok, false);
      assert.equal(result.kind, "missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("F-r1-1: an exact-head receipt (`kind: current`) is refused here regardless of suite_evidence — tip-move never accepts `current`", () => {
    const { dir, git } = gitRepo();
    try {
      const tested = recordAtHead(dir, git);
      const acceptableReceipt = evaluateLocalTestTipMoveReceipt({ cwd: dir, change: CHANGE, headSha: tested });
      assert.equal(acceptableReceipt.ok, false);
      assert.equal(acceptableReceipt.kind, "not-bookkeeping-tip-move");
      assert.equal(acceptableReceipt.verdictKind, "current");
      assert.equal(acceptableReceipt.testedSha, tested);
      assert.equal(acceptableReceipt.currentSha, tested);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const { dir: legacyDir } = gitRepo();
    try {
      const testedLegacy = recordLegacyAtHead(legacyDir);
      const unacceptableReceipt = evaluateLocalTestTipMoveReceipt({
        cwd: legacyDir,
        change: CHANGE,
        headSha: testedLegacy,
      });
      assert.equal(unacceptableReceipt.ok, false);
      assert.equal(unacceptableReceipt.kind, "not-bookkeeping-tip-move");
      assert.equal(unacceptableReceipt.verdictKind, "current");
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});
