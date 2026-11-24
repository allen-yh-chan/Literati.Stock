import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  advanceSessionRuleLoadLedgerEpoch,
  analyzeAgentsIndex,
  applySessionStartRuleLoadLedger,
  buildRuleLoadLedger,
  estimateTokens,
  extractAgentsIndexRows,
  findEagerLoadViolations,
  inspectSessionRuleLoadDuplicates,
  markSessionRuleLoadLedgerUnknown,
  recordSessionRuleLoads,
  resetSessionRuleLoadLedger,
} from "../rule-load-ledger.mjs";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = repoPath(".devpro/scripts/rule-load-ledger.mjs");

describe("rule-load-ledger", () => {
  it("uses the shared bytes/3.5 token estimate", () => {
    assert.equal(estimateTokens(0), 0);
    assert.equal(estimateTokens(1), 1);
    assert.equal(estimateTokens(35), 10);
    assert.equal(estimateTokens(36), 11);
  });

  it("dedupes repeated rule refs in a file ledger", async () => {
    const ledger = await buildRuleLoadLedger([
      "token-frugal-io.md",
      ".devpro/agent-rules/token-frugal-io.md",
      "token-frugal-io.md",
    ], REPO_ROOT);

    assert.equal(ledger.files.length, 1);
    assert.equal(ledger.files[0].relPath, "token-frugal-io.md");
    assert.ok(ledger.totalBytes > 0);
    assert.ok(ledger.totalTokens > 0);
  });

  it("expands wildcard refs for byte and token accounting", async () => {
    const ledger = await buildRuleLoadLedger(["platform-adapters/*.md"], REPO_ROOT);
    const relPaths = ledger.files.map((file) => file.relPath);

    assert.ok(relPaths.includes("platform-adapters/codex.md"));
    assert.ok(relPaths.includes("platform-adapters/claude-code.md"));
    assert.ok(ledger.files.length >= 4, `expected multiple adapter files, got ${relPaths.join(", ")}`);
    assert.ok(ledger.totalBytes > 100000, `wildcard bytes should include adapter files, got ${ledger.totalBytes}`);
    assert.ok(ledger.totalTokens > 25000, `wildcard tokens should include adapter files, got ${ledger.totalTokens}`);
  });

  it("AGENTS adapter/runtime footprint avoids wildcard eager-load", async () => {
    const rows = await analyzeAgentsIndex(REPO_ROOT);
    const adapterRow = rows.find((row) => row.intent === "adapter/runtime");

    assert.ok(adapterRow, "adapter/runtime row must exist");
    assert.deepEqual(adapterRow.refs, ["platform-adapter-contract.md"]);
    // Observation threshold only — overage soft-warns for /devpro:rule-governance.
    // Ordinary suite MUST NOT fail closed on entry footprint alone.
    const adapterObs = 3000;
    if (adapterRow.totalTokens >= adapterObs) {
      const utilization = Number(((adapterRow.totalTokens / adapterObs) * 100).toFixed(2));
      console.warn(
        `soft-warn cap-pressure=over path=openspec-index:adapter/runtime tokens=${adapterRow.totalTokens} obs=${adapterObs} utilization=${utilization}`
      );
    }
    assert.ok(!adapterRow.files.some((file) => file.relPath.startsWith("platform-adapters/")));
  });

  it("AGENTS hot trigger rows use compact entry leaves", async () => {
    const rows = await analyzeAgentsIndex(REPO_ROOT);
    const byIntent = new Map(rows.map((row) => [row.intent, row]));

    assert.deepEqual(byIntent.get("功能/行為")?.refs, ["openspec-flow.md"]);
    assert.deepEqual(byIntent.get("OpenSpec/tasks/quality")?.refs, ["openspec-step-1-to-9.md"]);
    // Footprint thresholds are soft/governance observations only (Ordinary-PR Cap Soft Gate).
    // Structural eager-ref shape stays hard; token overage alone MUST NOT fail the ordinary suite.
    // Remediation owner: /devpro:rule-governance (accepted-finding-only). Do NOT hard-trim valued
    // entry semantics or raise these obs numbers just to clear a release suite.
    const observations = [
      ["功能/行為", 3700],
      ["OpenSpec/tasks/quality", 5000],
    ];
    for (const [intent, obs] of observations) {
      const tokens = byIntent.get(intent)?.totalTokens ?? 0;
      assert.ok(tokens > 0, `${intent} entry must be measurable`);
      if (tokens >= obs) {
        const utilization = Number(((tokens / obs) * 100).toFixed(2));
        console.warn(
          `soft-warn cap-pressure=over path=openspec-index:${intent} tokens=${tokens} obs=${obs} utilization=${utilization}`
        );
      }
    }
  });

  it("compact entry leaves pin on-demand load-chain anchors", async () => {
    const readRule = (name) => fs.readFile(path.join(REPO_ROOT, ".devpro", "agent-rules", name), "utf8");
    const [adapterContract, openspecFlow, openspecSteps] = await Promise.all([
      readRule("platform-adapter-contract.md"),
      readRule("openspec-flow.md"),
      readRule("openspec-step-1-to-9.md"),
    ]);

    assert.match(adapterContract, /Load-chain：AGENTS\.md 只 eager-load 本契約/);
    assert.match(adapterContract, /platform-adapters\/<runtime>\.md/);
    assert.match(openspecFlow, /Load-chain：需要委派、多 agent、或 implementation briefing 細節時，按需載入 `model-delegation\.md`/);
    assert.match(openspecSteps, /Load-chain：tasks 品質、Scope Change、文件格式、Archive task wording 等細節按需載入 `openspec-quality-and-formats\.md`/);
    assert.match(openspecSteps, /openspec-archive-principles\.md/);
  });

  it("extracts AGENTS trigger rows and enforces eager ref budget", async () => {
    const rows = await analyzeAgentsIndex(REPO_ROOT);
    assert.ok(rows.length > 0, "AGENTS trigger index rows must be discovered");

    const violations = findEagerLoadViolations(rows, 2);
    assert.deepEqual(
      violations.map((row) => `${row.line}:${row.intent}:${row.eagerRefCount}`),
      [],
      "AGENTS trigger rows must eager-load no more than two rule refs"
    );
  });

  it("parses row refs from markdown table content", () => {
    const markdown = [
      "## 觸發式載入索引",
      "",
      "|情境|讀取|",
      "|---|---|",
      "|A|`one.md`+`two.md`|",
      "---",
    ].join("\n");
    const rows = extractAgentsIndexRows(markdown);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].refs, ["one.md", "two.md"]);
  });

  it("keeps GFM literal pipes inside an index intent cell", () => {
    // Escaped and matched-code-span pipes are cell content, not delimiters;
    // the shared splitter must preserve both without shifting the refs column.
    const markdown = [
      "## 觸發式載入索引",
      "",
      "|情境|讀取|",
      "|---|---|",
      "|A\\|B 與 `C|D`|`one.md`+`two.md`|",
      "---",
    ].join("\n");
    const rows = extractAgentsIndexRows(markdown);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].intent, "A|B 與 `C|D`");
    assert.deepEqual(rows[0].refs, ["one.md", "two.md"]);
  });

  it("CLI emits JSON ledger for explicit files", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath,
      "--files",
      "token-frugal-io.md",
      "--json",
    ]);
    const ledger = JSON.parse(stdout);
    assert.equal(ledger.files.length, 1);
    assert.equal(ledger.files[0].relPath, "token-frugal-io.md");
    assert.ok(ledger.totalTokens > 0);
  });

  it("records duplicate same-session rule loads with byte/token evidence", async () => {
    const dir = makeTempDir("rule-load-session-");
    const stateFile = path.join(dir, "ledger.json");

    const first = await recordSessionRuleLoads(["token-frugal-io.md"], { repoRoot: REPO_ROOT, stateFile });
    assert.deepEqual(first.duplicates, []);

    const second = await recordSessionRuleLoads([".devpro/agent-rules/token-frugal-io.md"], {
      repoRoot: REPO_ROOT,
      stateFile,
    });

    assert.equal(second.duplicates.length, 1);
    assert.equal(second.duplicates[0].relPath, "token-frugal-io.md");
    assert.ok(second.duplicates[0].bytes > 0);
    assert.ok(second.duplicates[0].tokens > 0);
    assert.equal(second.records[0].readCount, 2);
  });

  it("does not treat a partial read as covering a later full read", async () => {
    const dir = makeTempDir("rule-load-partial-");
    const stateFile = path.join(dir, "ledger.json");

    const partial = await recordSessionRuleLoads([
      { ref: "token-frugal-io.md", coverage: "partial", coverageKey: "sed:1,40p", commandKind: "sed" },
    ], { repoRoot: REPO_ROOT, stateFile });
    assert.deepEqual(partial.duplicates, []);

    const firstFull = await recordSessionRuleLoads([
      { ref: "token-frugal-io.md", coverage: "full", commandKind: "cat" },
    ], { repoRoot: REPO_ROOT, stateFile });
    assert.deepEqual(firstFull.duplicates, []);

    const secondFull = await recordSessionRuleLoads([
      { ref: "token-frugal-io.md", coverage: "full", commandKind: "cat" },
    ], { repoRoot: REPO_ROOT, stateFile });
    assert.equal(secondFull.duplicates.length, 1);
    assert.equal(secondFull.duplicates[0].coverage, "full");
  });

  it("does not treat legacy entries without coverage as full duplicates", async () => {
    const dir = makeTempDir("rule-load-legacy-coverage-");
    const stateFile = path.join(dir, "ledger.json");

    const baseline = await recordSessionRuleLoads(["token-frugal-io.md"], { repoRoot: REPO_ROOT, stateFile });
    const legacy = baseline.records[0];
    await fs.writeFile(stateFile, JSON.stringify({
      version: 2,
      contextEpoch: 0,
      lifecycle: "reliable",
      files: {
        "token-frugal-io.md": {
          relPath: legacy.relPath,
          bytes: legacy.bytes,
          tokens: legacy.tokens,
          hash: legacy.hash,
          contextEpoch: legacy.contextEpoch,
          firstReadAt: legacy.firstReadAt,
          lastReadAt: legacy.lastReadAt,
          readCount: legacy.readCount,
        },
      },
    }));

    const firstFullAfterLegacy = await recordSessionRuleLoads([
      { ref: "token-frugal-io.md", coverage: "full", commandKind: "cat" },
    ], { repoRoot: REPO_ROOT, stateFile });
    assert.deepEqual(firstFullAfterLegacy.duplicates, []);

    const secondFull = await recordSessionRuleLoads([
      { ref: "token-frugal-io.md", coverage: "full", commandKind: "cat" },
    ], { repoRoot: REPO_ROOT, stateFile });
    assert.equal(secondFull.duplicates.length, 1);
    assert.equal(secondFull.duplicates[0].coverage, "full");
  });

  it("compact advances epoch so the first post-compact reread is not duplicate", async () => {
    const dir = makeTempDir("rule-load-compact-");
    const stateFile = path.join(dir, "ledger.json");

    await recordSessionRuleLoads(["token-frugal-io.md"], { repoRoot: REPO_ROOT, stateFile });
    const compact = await advanceSessionRuleLoadLedgerEpoch({
      stateFile,
      reason: "test compact",
      source: "compact",
    });
    assert.equal(compact.contextEpoch, 1);

    const firstAfterCompact = await recordSessionRuleLoads(["token-frugal-io.md"], {
      repoRoot: REPO_ROOT,
      stateFile,
    });
    assert.deepEqual(firstAfterCompact.duplicates, []);

    const secondAfterCompact = await recordSessionRuleLoads(["token-frugal-io.md"], {
      repoRoot: REPO_ROOT,
      stateFile,
    });
    assert.equal(secondAfterCompact.duplicates.length, 1);
    assert.equal(secondAfterCompact.duplicates[0].contextEpoch, 1);
  });

  it("SessionStart source=startup resets session rule-load ledger state", async () => {
    const dir = makeTempDir("rule-load-session-startup-");
    const stateFile = path.join(dir, "ledger.json");
    await fs.writeFile(stateFile, JSON.stringify({
      contextEpoch: 2,
      lifecycle: "unknown",
      files: { "token-frugal-io.md": { readCount: 2 } },
    }));

    const result = applySessionStartRuleLoadLedger(
      { source: "startup", session_id: "test-session" },
      { stateFile }
    );
    const state = JSON.parse(await fs.readFile(stateFile, "utf8"));

    assert.equal(result.action, "reset");
    assert.equal(result.contextEpoch, 3);
    assert.deepEqual(state.files, {});
    assert.equal(state.lifecycle, "reliable");
    assert.equal(state.audit.at(-1).type, "reset");
    assert.equal(state.audit.at(-1).source, "startup");
  });

  it("SessionStart source=resume preserves unknown lifecycle telemetry-only behavior", async () => {
    const dir = makeTempDir("rule-load-session-resume-unknown-");
    const stateFile = path.join(dir, "ledger.json");
    await fs.writeFile(stateFile, JSON.stringify({
      contextEpoch: 2,
      lifecycle: "unknown",
      files: {},
    }));

    const resume = applySessionStartRuleLoadLedger(
      { source: "resume", session_id: "test-session" },
      { stateFile }
    );
    await recordSessionRuleLoads(["token-frugal-io.md"], { repoRoot: REPO_ROOT, stateFile });
    const duplicate = inspectSessionRuleLoadDuplicates(["token-frugal-io.md"], { repoRoot: REPO_ROOT, stateFile });
    const state = JSON.parse(await fs.readFile(stateFile, "utf8"));

    assert.equal(resume.action, "preserve");
    assert.equal(resume.lifecycle, "unknown");
    assert.equal(state.lifecycle, "unknown");
    assert.equal(state.audit.findLast((entry) => entry.type === "preserve")?.lifecycle, "unknown");
    assert.equal(duplicate.lifecycle, "unknown");
    assert.equal(duplicate.duplicates.length, 1);
  });

  it("manual session reset requires a reason and writes audit state", async () => {
    const dir = makeTempDir("rule-load-reset-");
    const stateFile = path.join(dir, "ledger.json");

    assert.throws(
      () => resetSessionRuleLoadLedger({ stateFile, reason: "", requireReason: true }),
      /--reason is required/
    );

    await recordSessionRuleLoads(["token-frugal-io.md"], { repoRoot: REPO_ROOT, stateFile });
    const reset = resetSessionRuleLoadLedger({
      stateFile,
      reason: "test isolation",
      actor: "test",
      requireReason: true,
    });
    assert.equal(reset.entryCount, 1);

    const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
    assert.deepEqual(state.files, {});
    assert.equal(state.audit.at(-1).type, "reset");
    assert.equal(state.audit.at(-1).reason, "test isolation");
    assert.equal(state.audit.at(-1).actor, "test");
  });

  it("session mutators and record helper require an explicit target", () => {
    assert.throws(
      () => recordSessionRuleLoads(["token-frugal-io.md"], { repoRoot: REPO_ROOT }),
      /session ledger target required/
    );
    assert.throws(
      () => resetSessionRuleLoadLedger({ reason: "manual reset" }),
      /requires an explicit session ledger stateFile/
    );
    assert.throws(
      () => advanceSessionRuleLoadLedgerEpoch({ reason: "manual compact" }),
      /requires an explicit session ledger stateFile/
    );
    assert.throws(
      () => markSessionRuleLoadLedgerUnknown({ reason: "unsupported source" }),
      /requires an explicit session ledger stateFile/
    );
  });

  it("CLI session reset requires an explicit session target", async () => {
    await assert.rejects(
      () => execFileAsync(process.execPath, [
        scriptPath,
        "--session-reset",
        "--reason",
        "missing target",
      ]),
      (error) => {
        assert.match(error.stderr || error.message, /session ledger target required/);
        return true;
      }
    );
  });

  it("CLI session-record requires an explicit session target", async () => {
    await assert.rejects(
      () => execFileAsync(process.execPath, [
        scriptPath,
        "--session-record",
        "--files",
        "token-frugal-io.md",
        "--json",
      ]),
      (error) => {
        assert.match(error.stderr || error.message, /session ledger target required/);
        return true;
      }
    );
  });

  it("CLI session reset targets an explicit session id", async () => {
    const dir = makeTempDir("rule-load-cli-explicit-");
    const stateDir = path.join(dir, "state");
    const stateFile = path.join(stateDir, "rule-load-session-ledger-cli-session.json");
    await fs.mkdir(stateDir, { recursive: true });
    await recordSessionRuleLoads(["token-frugal-io.md"], { repoRoot: REPO_ROOT, stateFile });

    const env = {
      ...process.env,
      DEVPRO_RULE_LOAD_LEDGER_STATE_FILE: "",
      DEVPRO_RULE_LOAD_LEDGER_STATE_DIR: stateDir,
    };
    const result = await execFileAsync(process.execPath, [
      scriptPath,
      "--session-reset",
      "--reason",
      "manual explicit session reset",
      "--session-id",
      "cli-session",
    ], { env });

    assert.match(result.stdout, new RegExp(stateFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
    assert.deepEqual(state.files, {});
    assert.equal(state.audit.at(-1).reason, "manual explicit session reset");
  });

  it("does not report a duplicate when the rule leaf content changes", async () => {
    const dir = makeTempDir("rule-load-changed-");
    const tempRepo = path.join(dir, "repo");
    const stateFile = path.join(dir, "ledger.json");
    const ruleDir = path.join(tempRepo, ".devpro", "agent-rules");
    await fs.mkdir(ruleDir, { recursive: true });
    await fs.writeFile(path.join(ruleDir, "sample.md"), "# one\n");

    const first = await recordSessionRuleLoads(["sample.md"], { repoRoot: tempRepo, stateFile });
    assert.deepEqual(first.duplicates, []);

    await fs.writeFile(path.join(ruleDir, "sample.md"), "# two\n");
    const second = await recordSessionRuleLoads(["sample.md"], { repoRoot: tempRepo, stateFile });

    assert.deepEqual(second.duplicates, []);
    assert.equal(second.records[0].relPath, "sample.md");
    assert.equal(second.records[0].readCount, 1);
  });

  it("CLI session-record reports duplicate rule-load evidence as JSON", async () => {
    const dir = makeTempDir("rule-load-cli-session-");
    const stateFile = path.join(dir, "ledger.json");
    const env = { ...process.env, DEVPRO_RULE_LOAD_LEDGER_STATE_FILE: "" };

    await execFileAsync(process.execPath, [
      scriptPath,
      "--session-reset",
      "--reason",
      "test isolation",
      "--state-file",
      stateFile,
    ], { env });
    const first = await execFileAsync(process.execPath, [
      scriptPath,
      "--session-record",
      "--files",
      "token-frugal-io.md",
      "--state-file",
      stateFile,
      "--json",
    ], { env });
    assert.deepEqual(JSON.parse(first.stdout).session.duplicates, []);

    const second = await execFileAsync(process.execPath, [
      scriptPath,
      "--session-record",
      "--files",
      "token-frugal-io.md",
      "--state-file",
      stateFile,
      "--json",
    ], { env });
    const body = JSON.parse(second.stdout);

    assert.equal(body.session.duplicates.length, 1);
    assert.equal(body.session.duplicates[0].relPath, "token-frugal-io.md");
    assert.ok(body.session.duplicateTokens > 0);
  });

  it("CLI check mode reports concise pass output", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath,
      "--check-agents-index",
      "--max-eager-refs",
      "2",
    ]);
    assert.match(stdout, /AGENTS trigger index eager refs: all rows <= 2/);
  });
});
