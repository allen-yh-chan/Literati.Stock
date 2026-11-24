#!/usr/bin/env node
/**
 * compliance-telemetry.mjs
 *
 * 分析 recent merged PRs 對 source repo 規範的遵守程度，產 markdown 報告
 * 至 stdout（CI 將其 post 到 GitHub Discussion 或 artifact）。
 *
 * Per GitHub issue #63 sub-item 4。Minimal v1 — 可後續擴充更多檢測項。
 *
 * 檢測 axis（每 PR 0/1 計分）：
 *   1. OpenSpec coverage：PR description 提及 `openspec/changes/` 或 archive
 *   2. dp-reviewer 六軸執行：PR description 含 "六軸" 或 "dp-reviewer"
 *   3. PR description 結構：有 ## Summary 段
 *   4. Session Recap 連結：PR description 含 "Recap" 或 "discussion"
 *
 * 使用：
 *   node .devpro/scripts/compliance-telemetry.mjs [--days N] [--limit M]
 *
 * 預設：分析最近 30 天 merged PR，limit 50 個。
 *
 * 依賴：gh CLI。
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 30, limit: 50, readingList: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days") opts.days = parseInt(args[++i], 10);
    else if (args[i] === "--limit") opts.limit = parseInt(args[++i], 10);
    else if (args[i] === "--reading-list") opts.readingList = true;
  }
  return opts;
}

function shStr(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function fetchMergedPRs(limit) {
  const json = shStr(
    `gh pr list --state merged --limit ${limit} --json number,title,body,mergedAt,author`
  );
  return JSON.parse(json);
}

function analyzePR(pr) {
  const body = pr.body || "";
  return {
    number: pr.number,
    title: pr.title,
    mergedAt: pr.mergedAt,
    author: pr.author?.login || "unknown",
    axes: {
      openspecCoverage:
        /openspec\/changes\/|archive|opsx:archive/i.test(body) ? 1 : 0,
      sixAxisReview: /六軸|dp-reviewer/i.test(body) ? 1 : 0,
      summarySection: /^##\s+Summary/im.test(body) ? 1 : 0,
      sessionRecap: /Recap|discussion/i.test(body) ? 1 : 0,
    },
  };
}

function buildReport(prs, analyses, days) {
  const total = analyses.length;
  if (total === 0) {
    return [
      "# Compliance Telemetry Report",
      "",
      `Window: last ${days} days`,
      "",
      "No merged PRs in window.",
    ].join("\n");
  }

  const sums = analyses.reduce(
    (acc, a) => {
      acc.openspecCoverage += a.axes.openspecCoverage;
      acc.sixAxisReview += a.axes.sixAxisReview;
      acc.summarySection += a.axes.summarySection;
      acc.sessionRecap += a.axes.sessionRecap;
      return acc;
    },
    {
      openspecCoverage: 0,
      sixAxisReview: 0,
      summarySection: 0,
      sessionRecap: 0,
    }
  );

  const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;

  const lines = [
    "# Compliance Telemetry Report",
    "",
    `Window: last ${days} days. PRs analyzed: **${total}**.`,
    "",
    "## Axis Coverage",
    "",
    "| Axis | Coverage | PRs |",
    "|---|---|---|",
    `| OpenSpec change reference | ${pct(sums.openspecCoverage)} | ${sums.openspecCoverage}/${total} |`,
    `| Six-axis review (dp-reviewer) reference | ${pct(sums.sixAxisReview)} | ${sums.sixAxisReview}/${total} |`,
    `| ## Summary section | ${pct(sums.summarySection)} | ${sums.summarySection}/${total} |`,
    `| Session Recap / discussion link | ${pct(sums.sessionRecap)} | ${sums.sessionRecap}/${total} |`,
    "",
    "## Per-PR Detail",
    "",
    "| PR | Title | OpenSpec | 六軸 | Summary | Recap |",
    "|---|---|---|---|---|---|",
  ];

  for (const a of analyses) {
    const mark = (v) => (v ? "✓" : "✗");
    lines.push(
      `| #${a.number} | ${a.title.slice(0, 50)} | ${mark(a.axes.openspecCoverage)} | ${mark(a.axes.sixAxisReview)} | ${mark(a.axes.summarySection)} | ${mark(a.axes.sessionRecap)} |`
    );
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "Note: This is a v1 minimal heuristic analyzer. Detection is keyword-based and may have false positives/negatives. Refine over time as patterns emerge."
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Reading-list mode helpers
// ---------------------------------------------------------------------------

export function parseAgentReadingList(content) {
  // Strict: anchor must exist; if not, agent has no formal reading list
  const sectionMatch = content.match(
    /(?:讀取以下規則檔案|Required Rules)[\s\S]*?(?=\n###|\n##|\n---)/
  );
  if (!sectionMatch) return [];
  const searchScope = sectionMatch[0];

  const pattern = /\.devpro\/agent-rules\/([a-z0-9-]+\.md)/g;
  const found = new Set();
  let m;
  while ((m = pattern.exec(searchScope)) !== null) {
    found.add(m[1]);
  }
  return Array.from(found);
}

export function analyzeSubagentReadingList(name, agentPath) {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
  );
  const content = fs.readFileSync(agentPath, "utf8");
  const files = parseAgentReadingList(content);

  let totalBytes = 0;
  let totalTokens = 0;
  let hasMissing = false;

  const fileDetails = files.map((file) => {
    const fullPath = path.join(repoRoot, ".devpro/agent-rules", file);
    try {
      const stat = fs.statSync(fullPath);
      const bytes = stat.size;
      const tokens = Math.ceil(bytes / 3.5);
      totalBytes += bytes;
      totalTokens += tokens;
      return { file, bytes, tokens, missing: false };
    } catch {
      hasMissing = true;
      return { file, bytes: 0, tokens: 0, missing: true };
    }
  });

  return { subagent: name, files: fileDetails, totalBytes, totalTokens, hasMissing };
}

export function buildReadingListReport(results) {
  let sha = "unknown";
  try {
    sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    // fallback already set
  }

  const timestamp = new Date().toISOString();

  const lines = [
    "# Subagent Reading List Footprint Telemetry",
    "",
    `Snapshot: ${timestamp} at ${sha}`,
    "",
  ];

  for (const r of results) {
    lines.push(`## ${r.subagent}`);
    lines.push("");
    lines.push("| File | Bytes | Tokens |");
    lines.push("|---|---|---|");
    for (const f of r.files) {
      const fileLabel = f.missing ? `${f.file} (missing)` : f.file;
      lines.push(`| ${fileLabel} | ${f.bytes} | ${f.tokens} |`);
    }
    lines.push(`| **Total** | **${r.totalBytes}** | **${r.totalTokens}** |`);
    lines.push("");
  }

  // Summary table sorted by token descending
  const sorted = [...results].sort((a, b) => b.totalTokens - a.totalTokens);

  lines.push("## Summary");
  lines.push("");
  lines.push("| Subagent | Total Bytes | Total Tokens |");
  lines.push("|---|---|---|");
  for (const r of sorted) {
    lines.push(`| ${r.subagent} | ${r.totalBytes} | ${r.totalTokens} |`);
  }
  lines.push("");
  lines.push(
    "<!-- Generated by .devpro/scripts/compliance-telemetry.mjs --reading-list -->"
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs();

  if (opts.readingList) {
    const argv = process.argv.slice(2);
    const hasDaysOrLimit = argv.some(
      (a) =>
        a === "--days" ||
        a === "--limit" ||
        a.startsWith("--days=") ||
        a.startsWith("--limit=")
    );
    if (hasDaysOrLimit) {
      process.stderr.write(
        "Error: --reading-list is mutually exclusive with --days/--limit\n"
      );
      process.exit(2);
    }

    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../.."
    );

    const subagents = [
      "dp-analyst",
      "dp-architect",
      "dp-reviewer",
      "dp-programmer",
      "dp-assistant",
    ];

    const results = subagents.map((name) => {
      const agentPath = path.join(repoRoot, `.claude/agents/${name}.md`);
      return analyzeSubagentReadingList(name, agentPath);
    });

    process.stdout.write(buildReadingListReport(results) + "\n");

    const anyMissing = results.some((r) => r.hasMissing);
    process.exit(anyMissing ? 1 : 0);
  }

  // PR analysis mode (original behaviour)
  const since = new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000);

  const prs = fetchMergedPRs(opts.limit).filter(
    (pr) => new Date(pr.mergedAt) >= since
  );

  const analyses = prs.map(analyzePR);
  console.log(buildReport(prs, analyses, opts.days));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
