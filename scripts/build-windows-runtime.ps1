param(
  [string]$RuntimeVersion = "0.1.0",
  [string]$Python = "python",
  [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"

function Get-RuntimeArch {
  $arch = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString().ToLowerInvariant()
  switch ($arch) {
    "x64" { return "x64" }
    "arm64" { return "arm64" }
    default { throw "Unsupported Windows runtime architecture: $arch" }
  }
}

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$BuildRoot = Join-Path $RepoRoot ".build\windows-runtime"
$VenvDir = Join-Path $BuildRoot ".venv"
$DistDir = Join-Path $BuildRoot "dist"
$WorkDir = Join-Path $BuildRoot "work"
$PackageRoot = Join-Path $BuildRoot "package"
$RuntimeDir = Join-Path $PackageRoot "runtime"
$Arch = Get-RuntimeArch

if (-not $OutputDir) {
  $OutputDir = Join-Path $RepoRoot "dist"
}

Remove-Item $BuildRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $BuildRoot, $OutputDir | Out-Null

Write-Host "Creating build venv with $Python"
& $Python -m venv $VenvDir
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$PyInstaller = Join-Path $VenvDir "Scripts\pyinstaller.exe"

Write-Host "Installing runtime build dependencies"
& $VenvPython -m pip install --upgrade pip wheel setuptools
& $VenvPython -m pip install -r (Join-Path $RepoRoot "requirements-runtime.txt")

Write-Host "Building proxy_engine.exe"
& $PyInstaller `
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
  (Join-Path $RepoRoot "tools\proxy_engine.py")

Write-Host "Building cert_manager.exe"
& $PyInstaller `
  --noconfirm `
  --clean `
  --onedir `
  --name cert_manager `
  --distpath $DistDir `
  --workpath $WorkDir `
  --specpath $BuildRoot `
  --collect-all cryptography `
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
$Manifest | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $RuntimeDir "manifest.json")

$ZipName = "mitm-proxy-runtime-win32-$Arch-$RuntimeVersion.zip"
$ZipPath = Join-Path $OutputDir $ZipName
Remove-Item $ZipPath -Force -ErrorAction SilentlyContinue
Compress-Archive -Path $RuntimeDir -DestinationPath $ZipPath -Force

$Hash = (Get-FileHash -Algorithm SHA256 $ZipPath).Hash.ToLowerInvariant()
$ShaPath = "$ZipPath.sha256"
"$Hash  $ZipName" | Set-Content -Encoding ASCII $ShaPath

Write-Host "Runtime package: $ZipPath"
Write-Host "SHA256: $Hash"
