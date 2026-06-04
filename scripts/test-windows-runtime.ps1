param(
  [Parameter(Mandatory = $true)]
  [string]$RuntimeZip,

  [string]$RuntimeVersion = "0.1.0"
)

$ErrorActionPreference = "Stop"

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )
  if (-not $Condition) {
    throw $Message
  }
}

$RuntimeZip = Resolve-Path $RuntimeZip
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("mitm-runtime-test-" + [System.Guid]::NewGuid().ToString("N"))
$ExtractDir = Join-Path $TempRoot "extract"
$ConfDir = Join-Path $TempRoot "confdir"
$StdoutPath = Join-Path $TempRoot "proxy.stdout.log"
$StderrPath = Join-Path $TempRoot "proxy.stderr.log"
$Process = $null

try {
  New-Item -ItemType Directory -Force -Path $ExtractDir, $ConfDir | Out-Null
  Expand-Archive -LiteralPath $RuntimeZip -DestinationPath $ExtractDir -Force

  $RuntimeDir = Join-Path $ExtractDir "runtime"
  $ManifestPath = Join-Path $RuntimeDir "manifest.json"
  Assert-True (Test-Path $ManifestPath) "Runtime manifest not found: $ManifestPath"

  $Manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
  Assert-True ($Manifest.runtimeVersion -eq $RuntimeVersion) "Unexpected runtimeVersion: $($Manifest.runtimeVersion)"
  Assert-True ($Manifest.platform -eq "win32") "Unexpected platform: $($Manifest.platform)"
  Assert-True ($Manifest.arch -in @("x64", "arm64")) "Unexpected arch: $($Manifest.arch)"
  Assert-True ($Manifest.mitmproxyVersion -eq "12.2.2") "Unexpected mitmproxyVersion: $($Manifest.mitmproxyVersion)"

  $ProxyExe = Join-Path $RuntimeDir $Manifest.entrypoints.proxyEngine
  $CertManagerExe = Join-Path $RuntimeDir $Manifest.entrypoints.certManager
  Assert-True (Test-Path $ProxyExe) "proxy_engine entrypoint not found: $ProxyExe"
  Assert-True (Test-Path $CertManagerExe) "cert_manager entrypoint not found: $CertManagerExe"

  Write-Host "Checking proxy_engine dependencies"
  $DepsOutput = & $ProxyExe --check-deps
  if ($LASTEXITCODE -ne 0) {
    throw "proxy_engine --check-deps failed: $DepsOutput"
  }
  $Deps = $DepsOutput | ConvertFrom-Json
  Assert-True ($Deps.success -eq $true) "Dependency check did not report success"
  Assert-True ($Deps.mitmproxyVersion -eq "12.2.2") "Dependency check reported mitmproxy $($Deps.mitmproxyVersion)"

  Write-Host "Checking cert_manager CLI"
  & $CertManagerExe --help | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "cert_manager --help failed"
  }

  $ProxyPort = Get-Random -Minimum 28000 -Maximum 28999
  $WebPort = Get-Random -Minimum 29000 -Maximum 29999
  while ($WebPort -eq $ProxyPort) {
    $WebPort = Get-Random -Minimum 29000 -Maximum 29999
  }

  Write-Host "Starting proxy_engine on proxy port $ProxyPort and web port $WebPort"
  $Args = @("--port", "$ProxyPort", "--web-port", "$WebPort", "--confdir", "$ConfDir")
  $Process = Start-Process `
    -FilePath $ProxyExe `
    -ArgumentList $Args `
    -RedirectStandardOutput $StdoutPath `
    -RedirectStandardError $StderrPath `
    -NoNewWindow `
    -PassThru

  $Token = $null
  $Deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $Deadline) {
    if ($Process.HasExited) {
      $stderr = if (Test-Path $StderrPath) { Get-Content $StderrPath -Raw } else { "" }
      throw "proxy_engine exited before startup completed. stderr: $stderr"
    }

    if (Test-Path $StderrPath) {
      $stderr = Get-Content $StderrPath -Raw
      if ($stderr -match "AUTH_TOKEN=([a-f0-9]+)") {
        $Token = $Matches[1]
      }
      if ($Token -and ($stderr -match "WEB_PORT=$WebPort")) {
        break
      }
    }
    Start-Sleep -Milliseconds 500
  }

  Assert-True (!!$Token) "AUTH_TOKEN was not emitted by proxy_engine"

  $StateUrl = "http://127.0.0.1:$WebPort/state.json?token=$Token"
  Write-Host "Requesting $StateUrl"
  $State = Invoke-RestMethod -Uri $StateUrl -TimeoutSec 10
  Assert-True ($State.version -eq "12.2.2") "Unexpected mitmproxy state version: $($State.version)"

  Write-Host "Windows runtime smoke test passed"
}
finally {
  if ($Process -and -not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    $Process.WaitForExit(5000) | Out-Null
  }
  Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
