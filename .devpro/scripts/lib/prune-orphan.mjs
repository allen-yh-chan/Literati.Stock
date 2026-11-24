import { execFileSync } from 'node:child_process';
import { accessSync, constants, lstatSync, readdirSync } from 'node:fs';
import { join, toNamespacedPath } from 'node:path';

/** Prove a tree is ordinary and readable without following any links. */
export function inspectOrphanTree(mainRoot, container, target, { allowNativeProbe = true } = {}) {
  function inspect(item, recurse) {
    const nativePath = toNamespacedPath(item);
    const stat = lstatSync(nativePath);
    if (stat.isSymbolicLink()) throw new Error(`refuse linked/reparse path: ${item}`);
    if (!stat.isDirectory() && !stat.isFile()) throw new Error(`refuse non-ordinary path: ${item}`);
    accessSync(nativePath, constants.R_OK);
    if (recurse && stat.isDirectory()) {
      for (const name of readdirSync(nativePath)) {
        if (name.toLowerCase() === '.git') throw new Error(`refuse .git marker: ${join(item, name)}`);
        inspect(join(item, name), true);
      }
    }
    return stat;
  }
  for (const root of [mainRoot, container, target]) {
    if (!inspect(root, false).isDirectory()) throw new Error(`refuse non-directory target/root: ${root}`);
  }
  if (process.platform === 'win32') {
    // lstat catches symlinks/junctions; native attributes cover other reparse types.
    // One batch, no shell interpolation, no per-entry PowerShell processes.
    if (!allowNativeProbe) throw new Error('native reparse proof unavailable in explicit --local-only mode (non-Git processes forbidden)');
    const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  # PowerShell 5.1 preserves JSON arrays as one pipeline object; @() would nest it.
  $roots = ConvertFrom-Json $env:DEVPRO_ORPHAN_SCAN_PATHS
  if ($roots.Count -ne 3) { throw 'native reparse probe expected three roots' }
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  foreach ($p in $roots) {
    if ($p -isnot [string] -or [string]::IsNullOrEmpty($p)) { throw 'native reparse probe expected path strings' }
    if (([System.IO.File]::GetAttributes($p) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw ('refuse reparse path: ' + $p)
    }
  }
  $pending.Push($roots[2])
  while ($pending.Count -gt 0) {
    $p = $pending.Pop()
    $a = [System.IO.File]::GetAttributes($p)
    if (($a -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('refuse reparse path: ' + $p) }
    if (($a -band [System.IO.FileAttributes]::Directory) -ne 0) {
      foreach ($child in [System.IO.Directory]::GetFileSystemEntries($p)) { $pending.Push($child) }
    }
  }
  Write-Output 'OK'
} catch {
  Write-Output ('ERROR: ' + $_.Exception.Message)
  exit 1
}`;
    let result;
    try {
      result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DEVPRO_ORPHAN_SCAN_PATHS: JSON.stringify([mainRoot, container, target].map(toNamespacedPath)) },
      });
    } catch (error) {
      throw new Error(`native reparse probe failed: ${String(error.stdout || '').trim() || error.message}`);
    }
    if (result.trim() !== 'OK') throw new Error('native reparse probe returned unknown result');
  }
  // On Windows prove native no-follow attributes before Node recurses into directories.
  inspect(target, true);
}

/** Missing dependencies are N/A; an unreadable present directory is an error. */
export function dependencyEntryCount(mainRoot) {
  const target = toNamespacedPath(join(mainRoot, 'node_modules'));
  try {
    lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return readdirSync(target).length;
}

export function checkDependencyInvariant(mainRoot, before) {
  const after = dependencyEntryCount(mainRoot);
  if (before !== after) throw new Error(`main-checkout dependency invariant failed: node_modules entries ${before ?? 'absent'} → ${after ?? 'absent'}`);
  return after;
}
