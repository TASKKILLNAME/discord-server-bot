[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$NodeExecutable
)

$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$runnerScript = Join-Path $PSScriptRoot 'local-runner.js'

try {
  & $NodeExecutable $runnerScript --local-task
  exit $LASTEXITCODE
} catch {
  $logDir = Join-Path $projectDir 'logs'
  $date = Get-Date -Format 'yyyy-MM-dd'
  $logPath = Join-Path $logDir "bot-$date.log"
  [System.IO.Directory]::CreateDirectory($logDir) | Out-Null
  [System.IO.File]::AppendAllText(
    $logPath,
    "[$([DateTime]::UtcNow.ToString('o'))] [fatal] 로컬 runner 실패: $($_.Exception)`r`n",
    (New-Object System.Text.UTF8Encoding $false)
  )
  exit 1
}
