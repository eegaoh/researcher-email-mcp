param([ValidateSet('read','write','self-test')][string]$Action, [string]$Reference)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
if ($Action -eq 'self-test') { $Reference = 'researcher-email-mcp/test-' + [Guid]::NewGuid().ToString('N') }
if ($Reference -notmatch '^researcher-email-mcp/[a-zA-Z0-9_-]{1,48}$') { exit 1 }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ResearcherCred {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 public struct Credential { public uint Flags; public uint Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
 [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Read(string target,uint type,uint flags,out IntPtr ptr);
 [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Write(ref Credential cred,uint flags);
 [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr ptr);
 [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Delete(string target,uint type,uint flags);
}
'@
try {
 if ($Action -eq 'self-test') {
  $testSecret = 'synthetic-only-' + [Guid]::NewGuid().ToString('N')
  $testPtr = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($testSecret)
  $created = $false
  try {
   $cred = New-Object ResearcherCred+Credential; $cred.Type=1; $cred.TargetName=$Reference; $cred.CredentialBlobSize=$testSecret.Length*2; $cred.CredentialBlob=$testPtr; $cred.Persist=2; $cred.UserName=$Reference
   if (-not [ResearcherCred]::Write([ref]$cred,0)) { throw 'write failed' }; $created=$true
   $readPtr=[IntPtr]::Zero
   if (-not [ResearcherCred]::Read($Reference,1,0,[ref]$readPtr)) { throw 'read failed' }
   try { $readCred=[Runtime.InteropServices.Marshal]::PtrToStructure($readPtr,[type][ResearcherCred+Credential]); $readSecret=[Runtime.InteropServices.Marshal]::PtrToStringUni($readCred.CredentialBlob,$readCred.CredentialBlobSize/2); if($readSecret -cne $testSecret){throw 'mismatch'} }
   finally { [ResearcherCred]::CredFree($readPtr) }
  } finally { [Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($testPtr); if($created -and -not [ResearcherCred]::Delete($Reference,1,0)){throw 'test credential cleanup failed'} }
  Write-Output '{"ok":true,"scope":"synthetic Credential Manager roundtrip; test item removed"}'
 } elseif ($Action -eq 'read') {
  $ptr = [IntPtr]::Zero
  if (-not [ResearcherCred]::Read($Reference,1,0,[ref]$ptr)) { exit 2 }
  try { $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr,[type][ResearcherCred+Credential]); $secret = [Runtime.InteropServices.Marshal]::PtrToStringUni($cred.CredentialBlob, $cred.CredentialBlobSize / 2); @{secret=$secret} | ConvertTo-Json -Compress }
  finally { [ResearcherCred]::CredFree($ptr) }
 } else {
  $secure = Read-Host 'Enter mailbox application password (hidden; never paste into Codex)' -AsSecureString
  if ($secure.Length -eq 0) { exit 3 }
  $secretPtr = [Runtime.InteropServices.Marshal]::SecureStringToCoTaskMemUnicode($secure)
  try { $cred = New-Object ResearcherCred+Credential; $cred.Type=1; $cred.TargetName=$Reference; $cred.CredentialBlobSize=$secure.Length*2; $cred.CredentialBlob=$secretPtr; $cred.Persist=2; $cred.UserName=$Reference; if(-not [ResearcherCred]::Write([ref]$cred,0)) { exit 4 } }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($secretPtr); $secure.Dispose() }
  Write-Host 'Saved to Windows Credential Manager.'
 }
} catch { Write-Error 'Credential operation failed (details suppressed)'; exit 5 }
