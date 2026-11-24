import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import path from 'node:path';

// Static program: only path/action arrive on stdin, never a capability or provider credential.
export const REVIEWER_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
  $acl = Get-Acl -LiteralPath $request.path
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
  if ($request.action -eq 'prepare-directory') {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in $allowed) {
      $principal = New-Object Security.Principal.SecurityIdentifier($identity)
      $rule = New-Object Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $request.path -AclObject $acl
    $acl = Get-Acl -LiteralPath $request.path
  } elseif ($request.action -ne 'verify') { throw 'action' }
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
  if ($acl -is [Security.AccessControl.DirectorySecurity] -and -not $acl.AreAccessRulesProtected) { throw 'inherited-directory-access' }
  $ownAccess = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow') {
      if ($allowed -notcontains $rule.IdentityReference.Value) { throw 'public-access' }
      if ($rule.IdentityReference.Value -eq $sid.Value) { $ownAccess = $true }
    }
  }
  if (-not $ownAccess) { throw 'missing-owner-access' }
  [Console]::Out.Write('private-reviewer-path-ok')
} catch { exit 1 }
`;

/** Check OS ownership/access before any secret read. Caller checks canonical paths. */
export function assertPrivateReviewerPath(filename,{platform=process.platform,prepareDirectory=false,
  spawnSyncImpl=spawnSync,systemRoot=process.env.SystemRoot??process.env.SYSTEMROOT}={}) {
  const stat=lstatSync(filename);
  if(stat.isSymbolicLink()||!(prepareDirectory?stat.isDirectory():stat.isFile()||stat.isDirectory()))throw new Error('reviewer_ticket_path_invalid');
  if(platform!=='win32') {
    if((stat.mode&0o077)!==0||(process.getuid&&stat.uid!==process.getuid()))throw new Error('reviewer_ticket_file_not_private');
    return;
  }
  if(typeof systemRoot!=='string'||!path.win32.isAbsolute(systemRoot)||systemRoot.startsWith('\\\\'))throw new Error('reviewer_ticket_acl_unavailable');
  const input=JSON.stringify({path:filename,action:prepareDirectory?'prepare-directory':'verify'}).replace(/[^\x00-\x7f]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
  const result=spawnSyncImpl(path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),
    ['-NoLogo','-NoProfile','-NonInteractive','-Command',REVIEWER_ACL_SCRIPT],
    {input,encoding:'utf8',windowsHide:true,timeout:10_000,maxBuffer:16*1024,
      env:{SystemRoot:systemRoot,WINDIR:systemRoot,...Object.fromEntries(['TEMP','TMP'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]))}});
  if(result.error||result.status!==0||result.stdout?.trim()!=='private-reviewer-path-ok')throw new Error('reviewer_ticket_acl_unavailable');
}
