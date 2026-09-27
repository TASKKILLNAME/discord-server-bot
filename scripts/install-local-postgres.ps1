[CmdletBinding()]
param(
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$projectDir = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectDir '.env'
$logDir = Join-Path $projectDir 'logs'
$statusPath = Join-Path $logDir 'postgres-setup.log'
$postgresVersion = '16.15-3'
$postgresMajor = '16'
$serviceName = 'postgresql-x64-16'
$installDir = 'C:\Program Files\PostgreSQL\16'
$dataDir = Join-Path $installDir 'data'
$installerUrl = "https://get.enterprisedb.com/postgresql/postgresql-$postgresVersion-windows-x64.exe"
$installerSha256 = '5AE62E39571AAD71256AC20F769C01B6415E5DBB69A76B44EC643A42037FE45D'
$temporaryRoot = $null
$superPassword = $null
$servicePassword = $null
$appPassword = $null

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-SetupStatus {
  param([Parameter(Mandatory = $true)][string]$Message)

  [System.IO.Directory]::CreateDirectory($logDir) | Out-Null
  $line = '[{0}] {1}{2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message, [Environment]::NewLine
  [System.IO.File]::AppendAllText($statusPath, $line, $utf8)
}

function Protect-Message {
  param([string]$Message)

  $protected = [string]$Message
  foreach ($secret in @($superPassword, $servicePassword, $appPassword)) {
    if ($secret) { $protected = $protected.Replace($secret, '[REDACTED]') }
  }
  $protected
}

function Get-EnvironmentValue {
  param(
    [Parameter(Mandatory = $true)][string]$Content,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $match = [regex]::Match(
    $Content,
    '(?m)^[\t ]*' + [regex]::Escape($Name) + '[\t ]*=[\t ]*(.*)$'
  )
  if (-not $match.Success) { return $null }

  $value = $match.Groups[1].Value.Trim()
  if ($value.Length -ge 2) {
    $first = $value[0]
    $last = $value[$value.Length - 1]
    if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
      return $value.Substring(1, $value.Length - 2)
    }
  }

  $commentIndex = $value.IndexOf(' #', [StringComparison]::Ordinal)
  if ($commentIndex -ge 0) { $value = $value.Substring(0, $commentIndex).TrimEnd() }
  $value
}

function Get-DerivedHexSecret {
  param(
    [Parameter(Mandatory = $true)][string]$Seed,
    [Parameter(Mandatory = $true)][string]$Purpose
  )

  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes("$Purpose`:$Seed")
    $hash = $sha256.ComputeHash($bytes)
    -join ($hash | ForEach-Object { $_.ToString('x2') })
  } finally {
    $sha256.Dispose()
  }
}

function Invoke-PsqlScript {
  param(
    [Parameter(Mandatory = $true)][string]$PsqlPath,
    [Parameter(Mandatory = $true)][string]$User,
    [Parameter(Mandatory = $true)][string]$Database,
    [Parameter(Mandatory = $true)][string]$Password,
    [Parameter(Mandatory = $true)][string]$Sql
  )

  $processInfo = New-Object System.Diagnostics.ProcessStartInfo
  $processInfo.FileName = $PsqlPath
  $processInfo.Arguments = '-X -q -t -A -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 -U "{0}" -d "{1}"' -f $User, $Database
  $processInfo.UseShellExecute = $false
  $processInfo.CreateNoWindow = $true
  $processInfo.RedirectStandardInput = $true
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true
  $processInfo.StandardOutputEncoding = $utf8
  $processInfo.StandardErrorEncoding = $utf8
  $processInfo.EnvironmentVariables['PGPASSWORD'] = $Password

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $processInfo
  try {
    [void]$process.Start()
    $process.StandardInput.Write($Sql)
    $process.StandardInput.Close()
    $standardOutput = $process.StandardOutput.ReadToEnd()
    $standardError = $process.StandardError.ReadToEnd()
    $process.WaitForExit()

    if ($process.ExitCode -ne 0) {
      $details = Protect-Message(($standardError + [Environment]::NewLine + $standardOutput).Trim())
      throw "psql 실행 실패 (exit $($process.ExitCode)): $details"
    }
    $standardOutput.Trim()
  } finally {
    $process.Dispose()
  }
}

function Set-DatabaseUrl {
  param(
    [Parameter(Mandatory = $true)][string]$Content,
    [Parameter(Mandatory = $true)][string]$DatabaseUrl
  )

  $replacement = 'DATABASE_URL=' + $DatabaseUrl
  if ([regex]::IsMatch($Content, '(?m)^[\t ]*DATABASE_URL[\t ]*=.*$')) {
    $databaseUrlPattern = New-Object System.Text.RegularExpressions.Regex(
      '(?m)^[\t ]*DATABASE_URL[\t ]*=.*$'
    )
    return $databaseUrlPattern.Replace(
      $Content,
      [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $replacement },
      1
    )
  }

  if ($Content.Length -gt 0 -and -not $Content.EndsWith("`n")) {
    $Content += [Environment]::NewLine
  }
  $Content + $replacement + [Environment]::NewLine
}

function Remove-SetupTemporaryDirectory {
  if (-not $temporaryRoot -or -not (Test-Path -LiteralPath $temporaryRoot)) { return }

  $systemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
  $resolvedTarget = [System.IO.Path]::GetFullPath($temporaryRoot).TrimEnd('\')
  $expectedPrefix = $systemTemp + '\postgresql-local-setup-'
  if (-not $resolvedTarget.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "임시 디렉터리 경로 검증 실패: $resolvedTarget"
  }

  Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
}

if (-not (Test-IsAdministrator)) {
  if ($Elevated) { throw '관리자 권한으로 실행되지 않았습니다.' }

  [System.IO.Directory]::CreateDirectory($logDir) | Out-Null
  [System.IO.File]::WriteAllText($statusPath, '', $utf8)
  Write-Output 'Windows 관리자 승인 창에서 예를 눌러주세요.'

  $argumentList = @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', ('"{0}"' -f $PSCommandPath),
    '-Elevated'
  )

  try {
    $elevatedProcess = Start-Process `
      -FilePath (Get-Command powershell.exe -ErrorAction Stop).Source `
      -ArgumentList $argumentList `
      -Verb RunAs `
      -WindowStyle Hidden `
      -Wait `
      -PassThru
  } catch {
    throw '관리자 승인이 취소되었거나 관리자 프로세스를 시작하지 못했습니다.'
  }

  if (Test-Path -LiteralPath $statusPath) {
    Get-Content -LiteralPath $statusPath
  }
  if ($elevatedProcess.ExitCode -ne 0) {
    throw "PostgreSQL 설치에 실패했습니다. 설치 로그: $statusPath"
  }

  Write-Output 'PostgreSQL 로컬 설치와 DATABASE_URL 설정이 완료되었습니다.'
  exit 0
}

try {
  Write-SetupStatus '로컬 PostgreSQL 설치를 시작합니다.'

  if (-not (Test-Path -LiteralPath $envPath)) {
    throw '.env 파일이 없습니다.'
  }
  $envContent = [System.IO.File]::ReadAllText($envPath, [Text.Encoding]::UTF8)
  $sessionSecret = Get-EnvironmentValue -Content $envContent -Name 'SESSION_SECRET'
  if ([string]::IsNullOrWhiteSpace($sessionSecret)) {
    throw '.env의 SESSION_SECRET이 비어 있습니다.'
  }

  $superHex = Get-DerivedHexSecret -Seed $sessionSecret -Purpose 'local-postgres-super-v1'
  $serviceHex = Get-DerivedHexSecret -Seed $sessionSecret -Purpose 'local-postgres-service-v1'
  $appPassword = Get-DerivedHexSecret -Seed $sessionSecret -Purpose 'local-postgres-app-v1'
  $superPassword = 'PgS!' + $superHex
  $servicePassword = 'PgW!' + $serviceHex
  $sessionSecret = $null
  $superHex = $null
  $serviceHex = $null

  $existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if (-not $existingService) {
    if (Test-Path -LiteralPath $installDir) {
      throw "$installDir 경로는 있지만 $serviceName 서비스가 없습니다. 기존 설치를 먼저 확인해야 합니다."
    }
    $portConflict = Get-NetTCPConnection -State Listen -LocalPort 5432 -ErrorAction SilentlyContinue
    if ($portConflict) {
      throw '다른 프로그램이 이미 TCP 5432 port를 사용 중입니다.'
    }
    if (Get-Command Get-LocalUser -ErrorAction SilentlyContinue) {
      $existingPostgresAccount = Get-LocalUser -Name 'postgres' -ErrorAction SilentlyContinue
      if ($existingPostgresAccount) {
        throw 'PostgreSQL service 없이 postgres Windows 계정이 남아 있습니다. 기존 설치 흔적을 먼저 확인해야 합니다.'
      }
    }

    $temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('postgresql-local-setup-' + [Guid]::NewGuid().ToString('N'))
    [System.IO.Directory]::CreateDirectory($temporaryRoot) | Out-Null

    $temporaryAcl = New-Object System.Security.AccessControl.DirectorySecurity
    $temporaryAcl.SetAccessRuleProtection($true, $false)
    $directoryRights = [System.Security.AccessControl.FileSystemRights]::FullControl
    $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    foreach ($sidValue in @(
      [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
      'S-1-5-18',
      'S-1-5-32-544'
    )) {
      $sid = New-Object System.Security.Principal.SecurityIdentifier($sidValue)
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $sid,
        $directoryRights,
        $inheritance,
        $propagation,
        $allow
      )
      [void]$temporaryAcl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $temporaryRoot -AclObject $temporaryAcl

    $installerPath = Join-Path $temporaryRoot "postgresql-$postgresVersion-windows-x64.exe"

    Write-SetupStatus "PostgreSQL $postgresMajor 설치 파일을 내려받는 중입니다."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri $installerUrl -OutFile $installerPath

    $actualInstallerSha256 = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash
    if ($actualInstallerSha256 -ne $installerSha256) {
      throw '설치 파일 SHA-256이 공식 배포 manifest와 일치하지 않습니다.'
    }

    Write-SetupStatus '설치 파일의 디지털 서명을 확인하는 중입니다.'
    $signature = Get-AuthenticodeSignature -LiteralPath $installerPath
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
      throw "설치 파일 서명이 유효하지 않습니다: $($signature.Status)"
    }
    if (-not $signature.SignerCertificate -or
      $signature.SignerCertificate.Subject -notmatch '(EnterpriseDB|EDB)') {
      throw '설치 파일 서명자가 EnterpriseDB로 확인되지 않습니다.'
    }

    Write-SetupStatus 'PostgreSQL server와 command-line tools를 설치하는 중입니다.'
    $originalTemp = $env:TEMP
    $originalTmp = $env:TMP
    $env:TEMP = $temporaryRoot
    $env:TMP = $temporaryRoot
    try {
      $optionFilePath = Join-Path $temporaryRoot 'installer-options.conf'
      $debugTracePath = Join-Path $temporaryRoot 'install-postgresql.log'
      $optionFileContent = @(
        'mode=unattended',
        'unattendedmodeui=none',
        'create_shortcuts=0',
        'enable-components=server,commandlinetools',
        'disable-components=pgAdmin,stackbuilder',
        "prefix=$installDir",
        "datadir=$dataDir",
        'serverport=5432',
        "servicename=$serviceName",
        "superpassword=$superPassword",
        "servicepassword=$servicePassword",
        'debuglevel=0',
        "debugtrace=$debugTracePath"
      ) -join [Environment]::NewLine
      [System.IO.File]::WriteAllText($optionFilePath, $optionFileContent, $utf8)

      $optionFileAcl = New-Object System.Security.AccessControl.FileSecurity
      $optionFileAcl.SetAccessRuleProtection($true, $false)
      $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
      $allow = [System.Security.AccessControl.AccessControlType]::Allow
      foreach ($sidValue in @(
        [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
        'S-1-5-18',
        'S-1-5-32-544'
      )) {
        $sid = New-Object System.Security.Principal.SecurityIdentifier($sidValue)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
          $sid,
          $fullControl,
          $allow
        )
        [void]$optionFileAcl.AddAccessRule($rule)
      }
      Set-Acl -LiteralPath $optionFilePath -AclObject $optionFileAcl

      $installerArguments = @('--optionfile', ('"{0}"' -f $optionFilePath))
      $installerProcess = Start-Process `
        -FilePath $installerPath `
        -ArgumentList $installerArguments `
        -WindowStyle Hidden `
        -Wait `
        -PassThru
      if ($installerProcess.ExitCode -ne 0) {
        throw "PostgreSQL installer 종료 코드: $($installerProcess.ExitCode)"
      }
    } finally {
      $env:TEMP = $originalTemp
      $env:TMP = $originalTmp
    }
  } else {
    Write-SetupStatus '기존 PostgreSQL 16 서비스를 사용합니다.'
  }

  $psqlPath = Join-Path $installDir 'bin\psql.exe'
  if (-not (Test-Path -LiteralPath $psqlPath)) {
    throw "psql을 찾을 수 없습니다: $psqlPath"
  }

  $service = Get-Service -Name $serviceName -ErrorAction Stop
  Set-Service -Name $serviceName -StartupType Automatic
  if ($service.Status -ne 'Running') {
    Start-Service -Name $serviceName
    $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
  }

  Write-SetupStatus '봇 전용 database와 role을 만드는 중입니다.'
  $databaseSetupSql = @'
DO $setup$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'discord_bot') THEN
    CREATE ROLE discord_bot LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$setup$;
ALTER ROLE discord_bot WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '__APP_PASSWORD__';
SELECT 'CREATE DATABASE discord_server_bot OWNER discord_bot'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'discord_server_bot')
\gexec
ALTER DATABASE discord_server_bot OWNER TO discord_bot;
ALTER SYSTEM SET listen_addresses = '127.0.0.1';
'@.Replace('__APP_PASSWORD__', $appPassword)
  [void](Invoke-PsqlScript `
    -PsqlPath $psqlPath `
    -User 'postgres' `
    -Database 'postgres' `
    -Password $superPassword `
    -Sql $databaseSetupSql)

  Write-SetupStatus 'PostgreSQL을 로컬 접속 전용으로 재시작하는 중입니다.'
  Restart-Service -Name $serviceName -Force
  (Get-Service -Name $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))

  $verificationSql = "SELECT current_database() || ':' || current_user;"
  $verification = Invoke-PsqlScript `
    -PsqlPath $psqlPath `
    -User 'discord_bot' `
    -Database 'discord_server_bot' `
    -Password $appPassword `
    -Sql $verificationSql
  if ($verification -notmatch 'discord_server_bot:discord_bot') {
    throw '봇 전용 database 접속 검증 결과가 예상과 다릅니다.'
  }

  $listenAddress = Invoke-PsqlScript `
    -PsqlPath $psqlPath `
    -User 'postgres' `
    -Database 'postgres' `
    -Password $superPassword `
    -Sql 'SHOW listen_addresses;'
  if ($listenAddress.Trim() -ne '127.0.0.1') {
    throw "PostgreSQL listen_addresses 검증 실패: $listenAddress"
  }

  $databaseUrl = "postgresql://discord_bot:$appPassword@127.0.0.1:5432/discord_server_bot"
  $updatedEnv = Set-DatabaseUrl -Content $envContent -DatabaseUrl $databaseUrl
  [System.IO.File]::WriteAllText($envPath, $updatedEnv, $utf8)

  Write-SetupStatus 'database 접속 확인과 .env 설정을 완료했습니다.'
  Write-SetupStatus 'SUCCESS'
  exit 0
} catch {
  $safeMessage = Protect-Message $_.Exception.Message
  Write-SetupStatus "FAILED: $safeMessage"
  exit 1
} finally {
  $superPassword = $null
  $servicePassword = $null
  $appPassword = $null
  try {
    Remove-SetupTemporaryDirectory
  } catch {
    Write-SetupStatus "임시 설치 파일 정리 실패: $($_.Exception.Message)"
  }
}
