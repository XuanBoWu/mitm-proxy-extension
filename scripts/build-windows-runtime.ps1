param(
  [string]$RuntimeVersion = "0.1.0",
  [string]$Python = "",
  [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
  }
}

function Get-RuntimeArch {
  $arch = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString().ToLowerInvariant()
  switch ($arch) {
    "x64" { return "x64" }
    "arm64" { return "arm64" }
    default { throw "Unsupported Windows runtime architecture: $arch" }
  }
}

function Resolve-BuildPython {
  param(
    [string]$RequestedPython,
    [string]$RepoRoot
  )

  if ($RequestedPython) {
    return $RequestedPython
  }

  $LocalVenvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"
  if (Test-Path $LocalVenvPython) {
    return $LocalVenvPython
  }

  return "python"
}

function Assert-SupportedPython {
  param([string]$PythonExe)

  $VersionJson = & $PythonExe -c "import json, sys; print(json.dumps({'major': sys.version_info.major, 'minor': sys.version_info.minor, 'version': sys.version.split()[0]}))"
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to inspect Python version: $PythonExe"
  }

  $Version = $VersionJson | ConvertFrom-Json
  if ($Version.major -ne 3 -or $Version.minor -lt 12 -or $Version.minor -ge 14) {
    throw "Windows runtime build requires Python >=3.12,<3.14, got $($Version.version) from $PythonExe"
  }

  Write-Host "Using Python $($Version.version): $PythonExe"
}

function Compress-WithRetry {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SourcePath,

    [Parameter(Mandatory = $true)]
    [string]$DestinationPath,

    [int]$Retries = 5
  )

  for ($attempt = 1; $attempt -le $Retries; $attempt++) {
    try {
      Remove-Item $DestinationPath -Force -ErrorAction SilentlyContinue
      Compress-Archive -Path $SourcePath -DestinationPath $DestinationPath -Force -ErrorAction Stop
      return
    } catch {
      if ($attempt -eq $Retries) {
        throw
      }
      Write-Host "Compress-Archive failed on attempt $attempt/${Retries}: $($_.Exception.Message)"
      Start-Sleep -Seconds $attempt
    }
  }
}

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$FilePath)

  $Sha256 = [System.Security.Cryptography.SHA256]::Create()
  $Stream = [System.IO.File]::OpenRead($FilePath)
  try {
    $HashBytes = $Sha256.ComputeHash($Stream)
    return (($HashBytes | ForEach-Object { $_.ToString("x2") }) -join "")
  } finally {
    $Stream.Dispose()
    $Sha256.Dispose()
  }
}

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Python = Resolve-BuildPython -RequestedPython $Python -RepoRoot $RepoRoot
Assert-SupportedPython -PythonExe $Python

$BuildRoot = Join-Path $RepoRoot ".build\windows-runtime"
$VenvDir = Join-Path $BuildRoot ".venv"
$DistDir = Join-Path $BuildRoot "dist"
$WorkDir = Join-Path $BuildRoot "work"
$PackageRoot = Join-Path $BuildRoot "package"
$RuntimeDir = Join-Path $PackageRoot "runtime"
$RuntimeIcon = Join-Path $RepoRoot "media\secmp.ico"
$Arch = Get-RuntimeArch

if (-not $OutputDir) {
  $OutputDir = Join-Path $RepoRoot "dist"
}

Remove-Item $BuildRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $BuildRoot, $OutputDir | Out-Null

Write-Host "Creating build venv with $Python"
Invoke-Native $Python -m venv $VenvDir
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$PyInstaller = Join-Path $VenvDir "Scripts\pyinstaller.exe"

Write-Host "Installing runtime build dependencies"
Invoke-Native $VenvPython -m pip install --upgrade pip wheel setuptools
Invoke-Native $VenvPython -m pip install -r (Join-Path $RepoRoot "requirements-runtime.txt")

Write-Host "Building proxy_engine.exe"
Invoke-Native $PyInstaller `
  --noconfirm `
  --clean `
  --onedir `
  --name proxy_engine `
  --distpath $DistDir `
  --workpath $WorkDir `
  --specpath $BuildRoot `
  --collect-all mitmproxy `
  --collect-all mitmproxy_rs `
  --collect-all pydivert `
  --hidden-import mitmproxy.tools.web.master `
  --hidden-import mitmproxy.tools.web.app `
  --icon $RuntimeIcon `
  (Join-Path $RepoRoot "tools\proxy_engine.py")

Write-Host "Building cert_manager.exe"
Invoke-Native $PyInstaller `
  --noconfirm `
  --clean `
  --onedir `
  --name cert_manager `
  --distpath $DistDir `
  --workpath $WorkDir `
  --specpath $BuildRoot `
  --collect-all cryptography `
  --icon $RuntimeIcon `
  (Join-Path $RepoRoot "tools\cert_manager.py")

Write-Host "Staging runtime package"
Remove-Item $PackageRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $RuntimeDir "bin") | Out-Null
Copy-Item (Join-Path $DistDir "proxy_engine") (Join-Path $RuntimeDir "bin\proxy_engine") -Recurse
Copy-Item (Join-Path $DistDir "cert_manager") (Join-Path $RuntimeDir "bin\cert_manager") -Recurse

$Manifest = [ordered]@{
  runtimeVersion = $RuntimeVersion
  platform = "win32"
  arch = $Arch
  mitmproxyVersion = "12.2.2"
  packageFormat = 1
  entrypoints = [ordered]@{
    proxyEngine = "bin/proxy_engine/proxy_engine.exe"
    certManager = "bin/cert_manager/cert_manager.exe"
  }
}
$ManifestJson = $Manifest | ConvertTo-Json -Depth 5
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $RuntimeDir "manifest.json"), $ManifestJson, $Utf8NoBom)

$ZipName = "secmp-runtime-win32-$Arch-$RuntimeVersion.zip"
$ZipPath = Join-Path $OutputDir $ZipName
Compress-WithRetry -SourcePath $RuntimeDir -DestinationPath $ZipPath

$Hash = Get-Sha256Hex -FilePath $ZipPath
$ShaPath = "$ZipPath.sha256"
"$Hash  $ZipName" | Set-Content -Encoding ASCII $ShaPath

Write-Host "Runtime package: $ZipPath"
Write-Host "SHA256: $Hash"
