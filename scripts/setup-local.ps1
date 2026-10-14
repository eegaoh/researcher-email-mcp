# User-run local terminal wizard. Never asks for credentials in Codex chat.
$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$localRoot = [Environment]::GetEnvironmentVariable('RESEARCHER_LOCAL_AI','User')
if (-not $env:RESEARCHER_LOCAL_AI -and $localRoot) { $env:RESEARCHER_LOCAL_AI=$localRoot }
if (-not $env:RESEARCHER_LOCAL_AI) { throw 'Set RESEARCHER_LOCAL_AI to a local nonsynced directory first.' }
$entryPath = Join-Path $repoPath 'dist\researcher\main.js'
if (-not (Test-Path -LiteralPath $entryPath)) { throw 'Build required: npm run build' }
Write-Host 'Local IMAP setup: passwords are hidden and stored only in Windows Credential Manager.'
do {
 & $nodePath $entryPath account add
 if ($LASTEXITCODE -ne 0) { throw 'Account configuration not completed.' }
 $another = Read-Host 'Add another mailbox? (y/N)'
} while ($another -eq 'y')
& $nodePath $entryPath test
Write-Host 'After successful testing, restart Codex/new conversation and ask to scan review mail.'
