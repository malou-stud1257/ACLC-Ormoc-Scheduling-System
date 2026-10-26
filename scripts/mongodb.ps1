<#
  Starts or stops the portable MongoDB server used for local development.

  The project normally uses `docker compose up -d mongodb`. When Docker is not
  installed, this script runs the same MongoDB release from the portable ZIP
  download, which needs no administrator rights.

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts/mongodb.ps1 start
    powershell -ExecutionPolicy Bypass -File scripts/mongodb.ps1 stop
    powershell -ExecutionPolicy Bypass -File scripts/mongodb.ps1 status
#>
param(
  [ValidateSet('start', 'stop', 'status')]
  [string]$Action = 'start'
)

$ErrorActionPreference = 'Stop'

$userHome = [Environment]::GetFolderPath('UserProfile')
$mongoDir = Join-Path $userHome 'mongodb'
$exe      = Join-Path $mongoDir 'mongodb-win32-x86_64-windows-8.0.12\bin\mongod.exe'
$dataPath = Join-Path $mongoDir 'data'
$logPath  = Join-Path $mongoDir 'logs\mongod.log'

function Get-MongoProcess {
  Get-Process mongod -ErrorAction SilentlyContinue
}

function Get-ListeningPid {
  (Get-NetTCPConnection -LocalPort 27017 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty OwningProcess)
}

function Get-PortableProcess {
  Get-MongoProcess | Where-Object {
    try { $_.Path -eq $exe } catch { $false }
  }
}

switch ($Action) {
  'status' {
    $listenerPid = Get-ListeningPid
    if ($listenerPid) {
      Write-Host "MongoDB is running (PID $listenerPid) on 127.0.0.1:27017."
    } else {
      Write-Host 'MongoDB is not running.'
    }
  }

  'start' {
    $listenerPid = Get-ListeningPid
    if ($listenerPid) {
      Write-Host "MongoDB is already running on 127.0.0.1:27017 (PID $listenerPid)."
      break
    }
    if (-not (Test-Path $exe)) {
      throw "mongod.exe not found at $exe. Download the MongoDB 8.0 ZIP from https://www.mongodb.com/try/download/community and extract it to $mongoDir."
    }
    New-Item -ItemType Directory -Force -Path $dataPath, (Split-Path $logPath) | Out-Null
    $arguments = @(
      '--dbpath', $dataPath,
      '--logpath', $logPath,
      '--bind_ip', '127.0.0.1',
      '--port', '27017',
      '--wiredTigerCacheSizeGB', '0.25'
    )
    $process = Start-Process -FilePath $exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
    Write-Host "MongoDB starting (PID $($process.Id)). Logs: $logPath"
  }

  'stop' {
    $process = Get-PortableProcess
    if (-not $process) {
      Write-Host 'No portable MongoDB instance is running. A MongoDB Windows service, if installed, is managed with Get-Service/Stop-Service and needs administrator rights.'
      break
    }
    $process | Stop-Process
    Write-Host 'Portable MongoDB stopped.'
  }
}
