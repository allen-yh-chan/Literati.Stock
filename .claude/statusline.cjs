#!/usr/bin/env node

const { spawnSync } = require('child_process');

let gitBranch = '';
try {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 2000 });
  if (r.status === 0) gitBranch = r.stdout.trim();
} catch {}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let d;
  try { d = JSON.parse(raw); } catch { process.exit(0); }

  const get = (obj, path, fallback = '') => {
    const val = path.split('.').reduce((o, k) => o?.[k], obj);
    return val ?? fallback;
  };

  const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    magenta: '\x1b[35m',
    blue: '\x1b[34m',
    bgGreen: '\x1b[48;2;34;139;34m',
    bgYellow: '\x1b[48;2;204;153;0m',
    bgRed: '\x1b[48;2;204;51;51m',
    white: '\x1b[37m',
    black: '\x1b[30m',
  };

  const model = get(d, 'model.display_name', '?');
  // effort.level: live reasoning effort (low/medium/high/xhigh/max); reflects
  // mid-session /effort changes. Absent when the model lacks effort support → ''.
  const effort = get(d, 'effort.level', '');
  const effortTag = effort ? ` ${c.magenta}⚡${effort}${c.reset}` : '';
  const style = get(d, 'output_style.name', '');
  const session = get(d, 'session_name', '') || get(d, 'session_id', '').slice(0, 8);
  // Full session id for the line-3 right-most field (copy-paste-ready for `claude --resume`).
  const sessionFull = get(d, 'session_id', '');
  const agent = get(d, 'agent.name', '');
  const vim = get(d, 'vim.mode', '');

  const cwd = get(d, 'workspace.current_dir', '');
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dir = home ? cwd.replace(home, '~') : cwd;

  const ctxPct = Math.round(Number(get(d, 'context_window.used_percentage', 0)));
  const inputTok = Number(get(d, 'context_window.total_input_tokens', 0));
  const outputTok = Number(get(d, 'context_window.total_output_tokens', 0));
  const cachCreate = Number(get(d, 'context_window.current_usage.cache_creation_input_tokens', 0));
  const cachRead = Number(get(d, 'context_window.current_usage.cache_read_input_tokens', 0));
  const over200k = get(d, 'exceeds_200k_tokens', false);

  const cost = Number(get(d, 'cost.total_cost_usd', 0)).toFixed(2);
  const added = Number(get(d, 'cost.total_lines_added', 0));
  const removed = Number(get(d, 'cost.total_lines_removed', 0));

  const rl5pct = get(d, 'rate_limits.five_hour.used_percentage', '');
  const rl7pct = get(d, 'rate_limits.seven_day.used_percentage', '');
  const rl5reset = Number(get(d, 'rate_limits.five_hour.resets_at', 0));
  const rl7reset = Number(get(d, 'rate_limits.seven_day.resets_at', 0));

  const fmt = (ms) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m${s % 60}s`;
    return `${Math.floor(m / 60)}h${m % 60}m`;
  };

  const remaining = (epochSec) => {
    if (!epochSec) return '';
    const left = Math.max(0, epochSec - Math.floor(Date.now() / 1000));
    return fmt(left * 1000);
  };

  const tokK = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;

  const weekday = (epochSec) => {
    if (!epochSec) return '';
    const d = new Date(epochSec * 1000);
    const days = ['日', '一', '二', '三', '四', '五', '六'];
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `週${days[d.getDay()]} ${hh}:${mm}`;
  };

  const ctxColor = ctxPct >= 80 ? c.red : ctxPct >= 60 ? c.yellow : c.green;
  const rlColor = (pct) => pct >= 80 ? c.red : pct >= 50 ? c.yellow : c.green;
  const rlBg = (pct) => pct >= 80 ? c.bgRed : pct >= 50 ? c.bgYellow : c.bgGreen;
  const rlFg = (pct) => pct >= 80 ? c.white : '\x1b[38;2;255;255;255m';
  const sep = ` ${c.dim}\u2502${c.reset} `;

  const parts1 = [`${c.bold}${c.cyan}${model}${c.reset}${effortTag}`];
  if (style && style !== 'default') parts1.push(`${c.dim}${style}${c.reset}`);
  if (vim) parts1.push(`${c.yellow}${vim}${c.reset}`);
  if (dir || gitBranch) {
    let loc = '';
    if (dir) loc += `${c.blue}${dir}${c.reset}`;
    // Hide branch when last dir segment matches branch (or branch leaf after '/'):
    // avoids redundancy in worktree dirs like .worktree/<change-name> on chore/<change-name>.
    const dirBase = dir.split('/').filter(Boolean).pop() || '';
    const branchLeaf = gitBranch.split('/').pop();
    const branchRedundant = gitBranch && (gitBranch === dirBase || branchLeaf === dirBase);
    if (gitBranch && !branchRedundant) loc += ` ${c.dim}(${c.reset}${c.green}${gitBranch}${c.reset}${c.dim})${c.reset}`;
    parts1.push(loc);
  }
  const line1 = parts1.join(sep);

  // Line 2: 限額/餘量 — ctx, 5h, 7d
  const bw = 30;
  const filled = Math.round(ctxPct / 100 * bw);
  const bar = ctxColor + '\u2501'.repeat(filled) + c.reset + c.dim + '\u2500'.repeat(bw - filled) + c.reset;
  const parts2 = [`${ctxColor}ctx${c.reset} ${bar} ${ctxColor}${c.bold}${ctxPct}%${c.reset}`];
  if (over200k) parts2.push(`${c.red}${c.bold}[>200k]${c.reset}`);
  const rlParts = [];
  if (rl5pct !== '') {
    const v5 = Math.round(Number(rl5pct));
    const r5 = remaining(rl5reset);
    rlParts.push(`${rlBg(v5)}${rlFg(v5)}${c.bold} 5h:${v5}% ${c.reset}${r5 ? ` ${c.dim}(${r5})${c.reset}` : ''}`);
  }
  if (rl7pct !== '') {
    const v7 = Math.round(Number(rl7pct));
    const w7 = weekday(rl7reset);
    rlParts.push(`${rlBg(v7)}${rlFg(v7)}${c.bold} 7d:${v7}% ${c.reset}${w7 ? ` ${c.dim}(${w7})${c.reset}` : ''}`);
  }
  if (rlParts.length) parts2.push(rlParts.join(' '));
  const line2 = parts2.join(sep);

  // Line 3: 累積統計 — cost/token, lines changed, session id
  const parts3 = [];
  const allInput = inputTok + cachCreate + cachRead;
  const cachePct = allInput > 0 ? Math.round(cachRead / allInput * 100) : 0;
  let tokenInfo = `${c.yellow}$${cost}${c.reset} ${c.dim}(token:${tokK(allInput)}+${tokK(outputTok)}`;
  if (cachRead) tokenInfo += ` cache:${c.cyan}${cachePct}%${c.reset}${c.dim}`;
  tokenInfo += `)${c.reset}`;
  parts3.push(tokenInfo);
  if (added || removed) parts3.push(`${c.green}+${added}${c.reset}/${c.red}-${removed}${c.reset}`);
  // Right-most field: full session id (copy-paste-ready for `claude --resume`),
  // replacing the former total/api duration readout.
  if (sessionFull) parts3.push(`${c.dim}sid:${c.reset}${c.cyan}${sessionFull}${c.reset}`);
  const line3 = parts3.join(sep);

  const lines = [line1, line2];
  if (parts3.length) lines.push(line3);
  console.log(lines.join('\n'));
});
