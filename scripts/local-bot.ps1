[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('install', 'uninstall', 'start', 'stop', 'status')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$taskName = 'DiscordServerBot-Local'
$projectDir = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $projectDir 'logs'
$stopRequestPath = Join-Path $logDir 'local-bot.stop'
$pidPath = Join-Path $logDir 'local-bot.pid.json'

function Get-NodeExecutable {
  (Get-Command node.exe -ErrorAction Stop).Source
}

function Assert-LocalSetup {
  param(
    [Parameter(Mandatory = $true)]
    [string]$NodeExecutable,
    [switch]$Silent
  )

  $checkScript = Join-Path $PSScriptRoot 'check-local-setup.js'
  $processInfo = New-Object System.Diagnostics.ProcessStartInfo
  $processInfo.FileName = $NodeExecutable
  $processInfo.Arguments = '"' + $checkScript.Replace('"', '\"') + '"'
  $processInfo.WorkingDirectory = $projectDir
  $processInfo.UseShellExecute = $false
  $processInfo.CreateNoWindow = $true
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true

  $checkProcess = New-Object System.Diagnostics.Process
  $checkProcess.StartInfo = $processInfo
  [void]$checkProcess.Start()
  $standardOutput = $checkProcess.StandardOutput.ReadToEnd().Trim()
  $standardError = $checkProcess.StandardError.ReadToEnd().Trim()
  $checkProcess.WaitForExit()
  $checkExitCode = $checkProcess.ExitCode
  $checkOutput = @($standardOutput, $standardError) |
    Where-Object { $_ } |
    Out-String
  $checkOutput = $checkOutput.Trim()

  if (-not $Silent -and $checkOutput) {
    Write-Output $checkOutput
  }
  if ($checkExitCode -ne 0) {
    throw "로컬 설정 점검에 실패했습니다.`r`n$checkOutput"
  }
}

function Get-LocalTask {
  try {
    Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  } catch {
    if ($_.FullyQualifiedErrorId -match 'CmdletizationQuery_NotFound') {
      return $null
    }
    throw
  }
}

function Stop-RemainingBotProcess {
  if (-not (Test-Path -LiteralPath $pidPath)) { return }

  $removePidFile = $false
  try {
    $savedProcess = Get-Content -LiteralPath $pidPath -Raw | ConvertFrom-Json
    $savedPid = $savedProcess.pid
    if (-not $savedPid -or -not $savedProcess.executable -or
      -not $savedProcess.entryPoint -or -not $savedProcess.startedAt) {
      throw 'PID 파일에 프로세스 검증 정보가 없습니다.'
    }

    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction Stop
    if (-not $process) {
      $removePidFile = $true
      return
    }

    $expectedNode = [System.IO.Path]::GetFullPath([string]$savedProcess.executable)
    $actualExecutable = [System.IO.Path]::GetFullPath([string]$process.ExecutablePath)
    $runnerScript = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'local-runner.js'))
    $savedEntryPoint = [System.IO.Path]::GetFullPath([string]$savedProcess.entryPoint)
    $commandLine = [string]$process.CommandLine
    $savedStart = ([DateTime]::Parse([string]$savedProcess.startedAt)).ToUniversalTime()
    $actualStart = ([DateTime]$process.CreationDate).ToUniversalTime()
    $startDifference = [Math]::Abs(($actualStart - $savedStart).TotalSeconds)
    $isExpectedProcess = $actualExecutable -ieq $expectedNode -and
      $savedEntryPoint -ieq $runnerScript -and
      $commandLine.IndexOf($runnerScript, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $startDifference -lt 10

    if (-not $isExpectedProcess) {
      throw "PID 파일이 다른 프로세스를 가리켜 강제 종료하지 않았습니다: $savedPid"
    }

    try {
      Stop-Process -Id $savedPid -Force -ErrorAction Stop
    } catch {
      if ($_.FullyQualifiedErrorId -notmatch 'NoProcessFoundForGivenId') { throw }
    }
    $removePidFile = $true
  } catch [Microsoft.Management.Infrastructure.CimException] {
    if ($_.Exception.Message -notmatch 'not found|찾을 수') { throw }
    $removePidFile = $true
  } finally {
    if ($removePidFile) {
      Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Stop-LocalTask {
  $task = Get-LocalTask
  if (-not $task) {
    Remove-Item -LiteralPath $stopRequestPath -Force -ErrorAction SilentlyContinue
    return
  }

  try {
    if ($task.State -eq 'Running') {
      [System.IO.Directory]::CreateDirectory($logDir) | Out-Null
      [System.IO.File]::WriteAllText($stopRequestPath, (Get-Date -Format o))

      $gracefulDeadline = (Get-Date).AddSeconds(8)
      do {
        Start-Sleep -Milliseconds 250
        $task = Get-LocalTask
        if (-not $task -or $task.State -notin @('Running', 'Queued')) { break }
      } while ((Get-Date) -lt $gracefulDeadline)
    }

    # Ready 상태여도 예약된 자동 재시작을 취소하기 위해 항상 중지 요청을 보냅니다.
    Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null

    $deadline = (Get-Date).AddSeconds(5)
    do {
      $task = Get-LocalTask
      if (-not $task -or $task.State -notin @('Running', 'Queued')) { break }
      Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)

    Stop-RemainingBotProcess

    $settleDeadline = (Get-Date).AddSeconds(5)
    do {
      $task = Get-LocalTask
      if (-not $task -or $task.State -notin @('Running', 'Queued')) { return }
      Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $settleDeadline)

    throw "예약 작업이 중지되지 않았습니다: $taskName"
  } finally {
    Remove-Item -LiteralPath $stopRequestPath -Force -ErrorAction SilentlyContinue
  }
}

function Install-LocalTask {
  $nodeExe = Get-NodeExecutable
  Assert-LocalSetup -NodeExecutable $nodeExe

  $launcherSource = Join-Path $PSScriptRoot 'BackgroundBotLauncher.cs'
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  try {
    $launcherHash = [BitConverter]::ToString($hasher.ComputeHash([System.IO.File]::ReadAllBytes($launcherSource))).Replace('-', '').Substring(0, 16)
  } finally {
    $hasher.Dispose()
  }
  $launcherDirectory = Join-Path $projectDir '.local-runtime'
  [System.IO.Directory]::CreateDirectory($launcherDirectory) | Out-Null
  $launcherExe = Join-Path $launcherDirectory ("BackgroundBotLauncher-$launcherHash.exe")
  if (-not (Test-Path -LiteralPath $launcherExe)) {
    Add-Type -Path $launcherSource -OutputAssembly $launcherExe -OutputType WindowsApplication
  }

  $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  Remove-Item -LiteralPath $stopRequestPath -Force -ErrorAction SilentlyContinue

  $existingTask = Get-LocalTask
  if ($existingTask) {
    Stop-LocalTask | Out-Null
  }

  $taskAction = New-ScheduledTaskAction `
    -Execute $launcherExe `
    -Argument ('"{0}" "{1}"' -f $nodeExe, $projectDir) `
    -WorkingDirectory $projectDir
  $trigger = New-ScheduledTaskTrigger `
    -AtLogOn `
    -User $currentUser `
    -RandomDelay (New-TimeSpan -Seconds 30)
  $principal = New-ScheduledTaskPrincipal `
    -UserId $currentUser `
    -LogonType Interactive `
    -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 255 `
    -RestartInterval (New-TimeSpan -Minutes 1)

  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $taskAction `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description '현재 사용자가 로그인한 동안 Discord bot을 로컬에서 실행합니다.' `
    -Force | Out-Null

  Write-Output "자동 시작 등록 완료: $taskName"
  Write-Output '다음 로그인부터 자동 실행됩니다. 지금 실행하려면 npm run local:start 를 사용하세요.'
}

switch ($Action) {
  'install' {
    Install-LocalTask
  }
  'uninstall' {
    $task = Get-LocalTask
    if (-not $task) {
      Write-Output "등록된 작업이 없습니다: $taskName"
      break
    }
    Stop-LocalTask | Out-Null
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "자동 시작 제거 완료: $taskName"
  }
  'start' {
    if (-not (Get-LocalTask)) {
      throw '자동 시작이 등록되지 않았습니다. 먼저 npm run local:install 을 실행하세요.'
    }
    $nodeExe = Get-NodeExecutable
    Assert-LocalSetup -NodeExecutable $nodeExe
    Remove-Item -LiteralPath $stopRequestPath -Force -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $taskName
    Write-Output "봇 시작 요청 완료: $taskName"
  }
  'stop' {
    if (-not (Get-LocalTask)) {
      throw '자동 시작이 등록되지 않았습니다.'
    }
    Stop-LocalTask | Out-Null
    Write-Output "봇 중지 완료: $taskName"
  }
  'status' {
    $task = Get-LocalTask
    if (-not $task) {
      Write-Output "자동 시작 미등록: $taskName"
      break
    }
    $info = Get-ScheduledTaskInfo -TaskName $taskName
    [PSCustomObject]@{
      Task = $taskName
      State = $task.State
      LastRunTime = $info.LastRunTime
      LastTaskResult = $info.LastTaskResult
      NextRunTime = $info.NextRunTime
      LogDirectory = $logDir
    } | Format-List
  }
}
