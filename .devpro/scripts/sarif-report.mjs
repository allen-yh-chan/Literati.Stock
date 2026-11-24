#!/usr/bin/env node
// Build a detailed HTML report from a CodeQL SARIF v2.1.0 file.
// Sections: executive summary, scanned files, rule catalog, findings with snippets.
// Zero deps; uses only node:fs and node:path.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

function parseArgs(argv) {
  const args = {
    sarif: null,
    sourceRoot: '.',
    project: null,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sarif') args.sarif = argv[++i];
    else if (a === '--source-root') args.sourceRoot = argv[++i];
    else if (a === '--project') args.project = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '-h' || a === '--help') {
      printUsageAndExit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      printUsageAndExit(2);
    }
  }
  if (!args.sarif) {
    console.error('error: --sarif <path> is required');
    printUsageAndExit(2);
  }
  return args;
}

function printUsageAndExit(code) {
  const msg = [
    'usage: node .devpro/scripts/sarif-report.mjs --sarif <path> [options]',
    '',
    'options:',
    '  --sarif <path>        input SARIF v2.1.0 file (required)',
    '  --source-root <dir>   base dir for snippet injection (default: .)',
    '  --project <name>      report title (default: repo folder name)',
    '  --out <path>          HTML output path (default: docs/codeql-YYYY-MM-DD.html)',
  ].join('\n');
  (code === 0 ? console.log : console.error)(msg);
  process.exit(code);
}

function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function mdToHtml(text) {
  if (!text) return '';
  const blocks = [];
  let t = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const i = blocks.length;
    blocks.push({ lang, code });
    return `\u0000BLOCK${i}\u0000`;
  });
  t = esc(t);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  t = t.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  t = t.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  t = t.replace(/^# (.+)$/gm, '<h2>$1</h2>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  let html = t.split('\n\n').map((p) => {
    const trimmed = p.trimStart();
    if (trimmed.startsWith('<h')) return p;
    if (trimmed.startsWith('\u0000BLOCK')) return p;
    return `<p>${p.replaceAll('\n', '<br>')}</p>`;
  }).join('\n');
  return html.replace(/\u0000BLOCK(\d+)\u0000/g, (_, i) => {
    const { lang, code } = blocks[Number(i)];
    const langClass = lang ? ` class="lang-${esc(lang)}"` : '';
    return `<pre><code${langClass}>${esc(code)}</code></pre>`;
  });
}

function readSnippet(sourceRoot, uri, startLine, endLine, context = 3) {
  if (!sourceRoot) return null;
  const fp = resolve(sourceRoot, uri);
  if (!existsSync(fp)) return null;
  let content;
  try {
    content = readFileSync(fp, 'utf8');
  } catch {
    return null;
  }
  const lines = content.split(/\r?\n/);
  const sl = Math.max(1, startLine - context);
  const el = Math.min(lines.length, endLine + context);
  const maxW = String(el).length;
  const out = [];
  for (let ln = sl; ln <= el; ln++) {
    const marker = ln >= startLine && ln <= endLine ? '▸' : ' ';
    const num = String(ln).padStart(maxW, ' ');
    out.push(`${marker} ${num} │ ${lines[ln - 1] ?? ''}`);
  }
  return out.join('\n');
}

function buildRulesIndex(run) {
  const idx = {};
  const tool = run.tool ?? {};
  for (const r of tool.driver?.rules ?? []) idx[r.id] = r;
  for (const ext of tool.extensions ?? []) {
    for (const r of ext.rules ?? []) idx[r.id] = r;
  }
  return idx;
}

function groupByRule(results) {
  const by = new Map();
  for (const r of results) {
    const id = r.ruleId ?? '(unknown)';
    if (!by.has(id)) by.set(id, []);
    by.get(id).push(r);
  }
  return by;
}

function severityOf(res, rulesIndex) {
  return res.level
    ?? rulesIndex[res.ruleId]?.defaultConfiguration?.level
    ?? 'warning';
}

/**
 * 從 SARIF rule 物件解析 CVSS 安全嚴重度分數。
 * @param {object|undefined} rule - SARIF rule 物件（含 properties.security-severity）
 * @returns {number|null} 解析後的浮點分數；NaN / 缺值 / rule 為 falsy 時回傳 null
 */
function parseSecuritySeverity(rule) {
  if (!rule || !rule.properties) return null;
  const raw = rule.properties['security-severity'];
  if (raw === undefined || raw === null) return null;
  const val = parseFloat(raw);
  if (isNaN(val)) return null;
  return val;
}

/**
 * 依 NVD CVSS v3 閉開區間將分數分桶。
 * Critical >= 9.0 / High >= 7.0 / Medium >= 4.0 / Low >= 0.1；
 * 不合法輸入或分數 < 0.1 時回傳 null。
 * @param {number|null|undefined} score - CVSS 分數
 * @returns {'Critical'|'High'|'Medium'|'Low'|null} 對應的嚴重度等級
 */
function bucketByCvss(score) {
  if (score === null || score === undefined) return null;
  if (typeof score !== 'number' || isNaN(score)) return null;
  if (score >= 9.0) return 'Critical';
  if (score >= 7.0) return 'High';
  if (score >= 4.0) return 'Medium';
  if (score >= 0.1) return 'Low';
  return null;
}

/**
 * 從 SARIF rule.properties.tags 過濾 `external/cwe/cwe-XXX` 格式 tag，
 * 回傳 `["CWE-XXX", ...]` 陣列；無 tag 或 rule 為 falsy 時回傳 `[]`。
 * @param {object|undefined} rule - SARIF rule 物件（含 properties.tags）
 * @returns {string[]} 解析出的 CWE 識別碼陣列（如 ["CWE-79", "CWE-116"]）
 */
function extractCwe(rule) {
  if (!rule || !rule.properties) return [];
  const tags = rule.properties.tags;
  if (!Array.isArray(tags)) return [];
  const cwes = [];
  for (const tag of tags) {
    const m = String(tag).match(/^external\/cwe\/cwe-(\d+)$/i);
    if (m) {
      cwes.push(`CWE-${parseInt(m[1], 10)}`);
    }
  }
  return cwes;
}

function renderHtml({ project, tool, toolVer, scanTime, results, byRule, sevCounts, artifacts, filesWithFindings, rulesIndex, sourceRoot, cvssCounts, noCvssCount, byRuleCvss }) {
  const css = `
  body { font-family: -apple-system, "Segoe UI", "Noto Sans TC", sans-serif;
         margin: 2rem; color: #24292f; line-height: 1.55; }
  h1 { border-bottom: 2px solid #0969da; padding-bottom: 0.3rem; }
  h2 { border-bottom: 1px solid #d0d7de; padding-bottom: 0.2rem; margin-top: 2rem; }
  h3 { color: #0550ae; margin-top: 1.5rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.9rem; }
  th, td { border: 1px solid #d0d7de; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f6f8fa; }
  code { background: #eff1f3; padding: 1px 5px; border-radius: 3px;
         font-family: "SF Mono", Consolas, monospace; font-size: 0.88em; }
  pre { background: #1e1e1e; color: #d4d4d4; padding: 0.8rem 1rem; border-radius: 4px;
        font-family: "SF Mono", Consolas, monospace; font-size: 0.82em; overflow-x: auto;
        line-height: 1.45; white-space: pre; margin: 0.5rem 0; }
  pre code { background: transparent; padding: 0; color: inherit; font-size: inherit; }
  .sev-error { color: #cf222e; font-weight: 600; }
  .sev-warning { color: #9a6700; font-weight: 600; }
  .sev-note { color: #0550ae; }
  .finding { border-left: 3px solid #d0d7de; padding: 0.5rem 0.8rem; margin: 0.6rem 0;
             background: #f6f8fa; font-size: 0.9rem; }
  .finding.level-error { border-left-color: #cf222e; }
  .finding.level-warning { border-left-color: #bf8700; }
  .finding.level-note { border-left-color: #0969da; }
  .loc { font-family: "SF Mono", Consolas, monospace; color: #57606a; font-size: 0.85em; }
  .rule-help { background: #fff; border: 1px solid #d0d7de; padding: 0.8rem 1rem;
               border-radius: 4px; margin: 0.6rem 0; }
  .rule-help h4 { margin-top: 0.8rem; color: #24292f; }
  .file-list { column-count: 2; column-gap: 2rem; font-size: 0.88em; }
  .file-list .item { break-inside: avoid; padding: 2px 0; }
  .file-list .has-findings { color: #cf222e; font-weight: 500; }
  .badge { display: inline-block; background: #d0d7de; color: #24292f;
           border-radius: 10px; padding: 1px 8px; font-size: 0.78em; margin-left: 6px; }
  .summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; margin: 1rem 0; }
  .summary-grid-cvss { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin: 1rem 0; }
  .summary-card { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px;
                  padding: 1rem; text-align: center; }
  .summary-card .num { font-size: 2rem; font-weight: 700; color: #0550ae; }
  .summary-card.error .num { color: #cf222e; }
  .summary-card.warning .num { color: #9a6700; }
  .summary-card .examples { font-size: 0.78em; color: #57606a; margin-top: 0.4rem; line-height: 1.35; }
  .summary-card .range { font-size: 0.85em; color: #57606a; margin-top: 0.2rem; }
  .summary-card .meaning { font-size: 0.82em; color: #57606a; margin-top: 0.4rem; }
  .summary-card.crit .num { color: #a40e26; }
  .summary-card.high .num { color: #cf222e; }
  .summary-card.med .num { color: #9a6700; }
  .summary-card.low .num { color: #57606a; }
  .cvss-footnote { font-style: italic; margin: 0.6rem 0 1rem; }
  .meta { color: #57606a; font-size: 0.9em; }
  .rule-meta { margin: 0.3rem 0 0.6rem; font-size: 0.88em; color: #57606a; }
  .rule-meta .badge { background: #d0d7de; }
  .page-break { page-break-before: always; }
  `;

  const parts = [];
  parts.push(`<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<title>CodeQL Security Analysis Report — ${esc(project)}</title>
<style>${css}</style>
</head>
<body>
<h1>CodeQL Security Analysis Report</h1>
<p class="meta">
  Repository: <strong>${esc(project)}</strong><br>
  Tool: <strong>${esc(tool)}</strong> v${esc(toolVer)}<br>
  Queries: <code>security-and-quality</code><br>
  Generated: ${esc(scanTime)}
</p>`);

  // §1 Executive Summary — dual grid layout
  parts.push(`
<h2>1. 執行摘要</h2>
<h3>Security Severity (CVSS)</h3>
<div class="summary-grid-cvss">
  <div class="summary-card crit">
    <div class="num">${cvssCounts.Critical ?? 0}</div>
    <div>Critical</div>
    <div class="range">9.0–10.0</div>
    <div class="examples">SQL Injection · RCE · Auth Bypass · Deserialization</div>
  </div>
  <div class="summary-card high">
    <div class="num">${cvssCounts.High ?? 0}</div>
    <div>High</div>
    <div class="range">7.0–8.9</div>
    <div class="examples">XSS · SSRF · Path Traversal · CSRF</div>
  </div>
  <div class="summary-card med">
    <div class="num">${cvssCounts.Medium ?? 0}</div>
    <div>Medium</div>
    <div class="range">4.0–6.9</div>
    <div class="examples">Information Disclosure · Weak Crypto · Open Redirect</div>
  </div>
  <div class="summary-card low">
    <div class="num">${cvssCounts.Low ?? 0}</div>
    <div>Low</div>
    <div class="range">0.1–3.9</div>
    <div class="examples">Hardcoded Constants · Verbose Errors · 一般資安提示</div>
  </div>
</div>
<p class="cvss-footnote meta">註：${noCvssCount} 筆 finding 不含 CVSS 分數，僅計入下排 Problem Severity；上下排總計皆等於 ${results.length} 筆 findings。</p>
<h3>Problem Severity</h3>
<div class="summary-grid">
  <div class="summary-card error">
    <div class="num">${sevCounts.error ?? 0}</div>
    <div>Error</div>
    <div class="meaning">直接安全漏洞或明確錯誤（如 SQLi、命令注入）</div>
  </div>
  <div class="summary-card warning">
    <div class="num">${sevCounts.warning ?? 0}</div>
    <div>Warning</div>
    <div class="meaning">可疑模式（潛在風險，需人工判讀）</div>
  </div>
  <div class="summary-card">
    <div class="num">${sevCounts.note ?? 0}</div>
    <div>Note</div>
    <div class="meaning">程式碼品質提示（最佳實務、可維護性）</div>
  </div>
</div>
<p>總計 <strong>${results.length}</strong> 筆 findings，涉及 <strong>${byRule.size}</strong> 條 rule，掃描 <strong>${artifacts.length}</strong> 個檔案。</p>

<h3>Findings by Rule</h3>
<table>
  <thead><tr><th>#</th><th>Rule ID</th><th>Rule Name</th><th>Security Severity</th><th>CVSS</th><th>Severity</th><th>Count</th></tr></thead>
  <tbody>`);

  const sortedRules = [...byRule.entries()].sort((a, b) => b[1].length - a[1].length);
  sortedRules.forEach(([rid, items], i) => {
    const rule = rulesIndex[rid] ?? {};
    const name = rule.name ?? rule.shortDescription?.text ?? '';
    const level = rule.defaultConfiguration?.level ?? 'warning';
    const cvssInfo = byRuleCvss[rid];
    const secSev = cvssInfo ? cvssInfo.bucket : '—';
    const cvssScore = cvssInfo ? cvssInfo.score : '—';
    parts.push(`<tr>
    <td>${i + 1}</td>
    <td><code>${esc(rid)}</code></td>
    <td>${esc(name)}</td>
    <td>${esc(secSev)}</td>
    <td>${esc(cvssScore)}</td>
    <td><span class="sev-${esc(level)}">${esc(level)}</span></td>
    <td style="text-align:right"><strong>${items.length}</strong></td>
  </tr>`);
  });
  parts.push('</tbody></table>');

  parts.push('<h2>2. 掃描檔案清單</h2>');
  parts.push(`<p>本次共掃描 ${artifacts.length} 個檔案（以下標紅者包含 findings）：</p>`);
  parts.push('<div class="file-list">');
  const sortedArtifacts = [...artifacts].sort((a, b) => {
    const ua = a.location?.uri ?? '';
    const ub = b.location?.uri ?? '';
    return ua.localeCompare(ub);
  });
  for (const art of sortedArtifacts) {
    const uri = art.location?.uri ?? '';
    const has = filesWithFindings.has(uri);
    const cls = has ? 'item has-findings' : 'item';
    const mark = has ? ' ●' : '';
    parts.push(`<div class="${cls}">${esc(uri)}${mark}</div>`);
  }
  parts.push('</div>');

  parts.push('<div class="page-break"></div><h2>3. Rule 說明</h2>');
  parts.push('<p>以下列出本次觸發的所有 rule 之完整描述與建議修復方向。</p>');

  const sortedIds = [...byRule.keys()].sort();
  for (const rid of sortedIds) {
    const rule = rulesIndex[rid] ?? {};
    const name = rule.name ?? rid;
    const short = rule.shortDescription?.text ?? '';
    const full = rule.fullDescription?.text ?? '';
    const help = rule.help?.markdown ?? rule.help?.text ?? '';
    const level = rule.defaultConfiguration?.level ?? 'warning';
    const cvssInfo = byRuleCvss[rid];
    const score = cvssInfo ? cvssInfo.score : null;
    const cwes = extractCwe(rule);
    const cweBadgesHtml = cwes.length
      ? cwes.map(c => `<span class="badge">${esc(c)}</span>`).join('')
      : '—';
    parts.push(`
<h3><code>${esc(rid)}</code> — ${esc(name)} <span class="badge">${esc(level)}</span></h3>
<p class="rule-meta">
  CVSS: <strong>${score !== null ? esc(String(score)) : 'N/A'}</strong>
  &nbsp;·&nbsp;
  CWE: ${cweBadgesHtml}
</p>
<p><em>${esc(short)}</em></p>
<div class="rule-help">
  <p>${esc(full)}</p>
  ${help ? mdToHtml(help) : ''}
</div>`);
  }

  parts.push('<div class="page-break"></div><h2>4. Findings 詳細清單</h2>');
  if (sourceRoot) {
    parts.push(`<p class="meta">含原始碼 snippet（由 <code>${esc(sourceRoot)}</code> 注入，命中行以 ▸ 標示）。</p>`);
  } else {
    parts.push('<p class="meta">無原始碼 snippet（未指定 --source-root）。</p>');
  }

  for (const rid of sortedIds) {
    const rule = rulesIndex[rid] ?? {};
    const name = rule.name ?? rid;
    const level = rule.defaultConfiguration?.level ?? 'warning';
    const items = byRule.get(rid);
    parts.push(`<h3><code>${esc(rid)}</code> — ${esc(name)} (${items.length} findings)</h3>`);
    items.forEach((it, idx) => {
      const msg = it.message?.text ?? '';
      const locs = it.locations ?? [];
      let locHtml = '';
      let snippetText = null;
      if (locs.length) {
        const pl = locs[0].physicalLocation ?? {};
        const uri = pl.artifactLocation?.uri ?? '?';
        const reg = pl.region ?? {};
        const sl = reg.startLine ?? 1;
        const el = reg.endLine ?? sl;
        const rangeSuffix = el !== sl ? `–${el}` : '';
        locHtml = `<span class="loc">${esc(uri)}:${esc(sl)}${esc(rangeSuffix)}</span>`;
        const ctx = pl.contextRegion ?? {};
        if (ctx.snippet?.text) {
          snippetText = ctx.snippet.text;
        } else {
          snippetText = readSnippet(sourceRoot, uri, sl, el, 3);
        }
      }
      const snippetHtml = snippetText ? `<pre><code>${esc(snippetText)}</code></pre>` : '';
      parts.push(`
<div class="finding level-${esc(level)}">
  <strong>#${idx + 1}</strong> ${esc(msg)}<br>
  ${locHtml}
  ${snippetHtml}
</div>`);
    });
  }

  parts.push('</body></html>');
  return parts.join('');
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  const sarifPath = resolve(args.sarif);
  if (!existsSync(sarifPath)) {
    console.error(`error: SARIF file not found: ${sarifPath}`);
    process.exit(2);
  }

  const data = JSON.parse(readFileSync(sarifPath, 'utf8'));
  if (data.version !== '2.1.0') {
    console.error(`warning: expected SARIF 2.1.0, got ${data.version ?? '(missing)'}; continuing`);
  }
  const run = data.runs?.[0];
  if (!run) {
    console.error('error: SARIF has no runs[]');
    process.exit(2);
  }

  const tool = run.tool?.driver ?? {};
  const toolName = tool.name ?? 'CodeQL';
  const toolVer = tool.semanticVersion ?? tool.version ?? '';
  const results = run.results ?? [];
  const artifacts = run.artifacts ?? [];
  const rulesIndex = buildRulesIndex(run);
  const byRule = groupByRule(results);

  const sevCounts = {};
  const cvssCounts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  let noCvssCount = 0;
  const filesWithFindings = new Set();

  for (const r of results) {
    const lv = severityOf(r, rulesIndex);
    sevCounts[lv] = (sevCounts[lv] ?? 0) + 1;

    const rule = rulesIndex[r.ruleId ?? '(unknown)'] ?? {};
    const bucket = bucketByCvss(parseSecuritySeverity(rule));
    if (bucket !== null) cvssCounts[bucket]++; else noCvssCount++;

    const uri = r.locations?.[0]?.physicalLocation?.artifactLocation?.uri;
    if (uri) filesWithFindings.add(uri);
  }

  const byRuleCvss = {};
  for (const rid of byRule.keys()) {
    const score = parseSecuritySeverity(rulesIndex[rid] ?? {});
    byRuleCvss[rid] = score !== null
      ? { bucket: bucketByCvss(score), score: String(score) }
      : null;
  }

  const project = args.project ?? process.cwd().split('/').pop();
  const out = args.out ?? join('docs', `codeql-${today()}.html`);
  const outAbs = resolve(out);
  const scanTime = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const html = renderHtml({
    project,
    tool: toolName,
    toolVer,
    scanTime,
    results,
    byRule,
    sevCounts,
    artifacts,
    filesWithFindings,
    rulesIndex,
    sourceRoot: args.sourceRoot,
    cvssCounts,
    noCvssCount,
    byRuleCvss,
  });

  mkdirSync(dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, html, 'utf8');
  const bytes = statSync(outAbs).size.toLocaleString();
  console.log(`Written ${outAbs} (${bytes} bytes)`);
  console.log(`  findings: ${results.length}, rules: ${byRule.size}, files scanned: ${artifacts.length}`);
  console.log(`  severity: error=${sevCounts.error ?? 0}, warning=${sevCounts.warning ?? 0}, note=${sevCounts.note ?? 0}`);
}

// Guard: only run main() when this script is executed directly, not when imported
import { fileURLToPath } from 'node:url';
const __filename = realpathSync(fileURLToPath(import.meta.url));
const argv1 = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (argv1 === __filename) {
  main();
}

export { parseSecuritySeverity, bucketByCvss, extractCwe, renderHtml };
