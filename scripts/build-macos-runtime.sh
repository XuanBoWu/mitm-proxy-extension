#!/usr/bin/env bash
set -euo pipefail

RUNTIME_VERSION="0.1.0"
PYTHON_BIN=""
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime-version|-RuntimeVersion)
      RUNTIME_VERSION="$2"
      shift 2
      ;;
    --python|-Python)
      PYTHON_BIN="$2"
      shift 2
      ;;
    --output-dir|-OutputDir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="$REPO_ROOT/.build/macos-runtime"
VENV_DIR="$BUILD_ROOT/.venv"
DIST_DIR="$BUILD_ROOT/dist"
WORK_DIR="$BUILD_ROOT/work"
PACKAGE_ROOT="$BUILD_ROOT/package"
RUNTIME_DIR="$PACKAGE_ROOT/runtime"

if [[ -z "$OUTPUT_DIR" ]]; then
  OUTPUT_DIR="$REPO_ROOT/dist"
fi
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"

case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *)
    echo "Unsupported macOS runtime architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

if [[ -z "$PYTHON_BIN" ]]; then
  if [[ -x "$REPO_ROOT/.venv/bin/python3" ]]; then
    PYTHON_BIN="$REPO_ROOT/.venv/bin/python3"
  elif command -v python3.12 >/dev/null 2>&1; then
    PYTHON_BIN="python3.12"
  else
    PYTHON_BIN="python3"
  fi
fi

"$PYTHON_BIN" - <<'PY'
import sys
version = sys.version_info
if version.major != 3 or version.minor < 12 or version.minor >= 14:
    raise SystemExit(f"macOS runtime build requires Python >=3.12,<3.14, got {sys.version.split()[0]}")
print(f"Using Python {sys.version.split()[0]}")
PY

rm -rf "$BUILD_ROOT"
mkdir -p "$BUILD_ROOT" "$OUTPUT_DIR" "$RUNTIME_DIR/bin"

echo "Creating build venv with $PYTHON_BIN"
"$PYTHON_BIN" -m venv "$VENV_DIR"
VENV_PYTHON="$VENV_DIR/bin/python"
PYINSTALLER="$VENV_DIR/bin/pyinstaller"

echo "Installing runtime build dependencies"
"$VENV_PYTHON" -m pip install --upgrade pip wheel setuptools
"$VENV_PYTHON" -m pip install -r "$REPO_ROOT/requirements-runtime.txt"

echo "Building proxy_engine"
"$PYINSTALLER" \
  --noconfirm \
  --clean \
  --onedir \
  --name proxy_engine \
  --distpath "$DIST_DIR" \
  --workpath "$WORK_DIR" \
  --specpath "$BUILD_ROOT" \
  --collect-all mitmproxy \
  --collect-all mitmproxy_rs \
  --hidden-import mitmproxy.tools.web.master \
  --hidden-import mitmproxy.tools.web.app \
  "$REPO_ROOT/tools/proxy_engine.py"

echo "Building cert_manager"
"$PYINSTALLER" \
  --noconfirm \
  --clean \
  --onedir \
  --name cert_manager \
  --distpath "$DIST_DIR" \
  --workpath "$WORK_DIR" \
  --specpath "$BUILD_ROOT" \
  --collect-all cryptography \
  "$REPO_ROOT/tools/cert_manager.py"

echo "Staging runtime package"
cp -R "$DIST_DIR/proxy_engine" "$RUNTIME_DIR/bin/proxy_engine"
cp -R "$DIST_DIR/cert_manager" "$RUNTIME_DIR/bin/cert_manager"
chmod +x "$RUNTIME_DIR/bin/proxy_engine/proxy_engine"
chmod +x "$RUNTIME_DIR/bin/cert_manager/cert_manager"

cat > "$RUNTIME_DIR/manifest.json" <<JSON
{
  "runtimeVersion": "$RUNTIME_VERSION",
  "runtimeApiVersion": 1,
  "platform": "darwin",
  "arch": "$ARCH",
  "mitmproxyVersion": "12.2.2",
  "packageFormat": 1,
  "entrypoints": {
    "proxyEngine": "bin/proxy_engine/proxy_engine",
    "certManager": "bin/cert_manager/cert_manager"
  }
}
JSON

ZIP_NAME="secmp-runtime-darwin-$ARCH-$RUNTIME_VERSION.zip"
ZIP_PATH="$OUTPUT_DIR/$ZIP_NAME"
rm -f "$ZIP_PATH" "$ZIP_PATH.sha256"
(cd "$PACKAGE_ROOT" && zip -qr "$ZIP_PATH" runtime)

HASH="$(shasum -a 256 "$ZIP_PATH" | awk '{print $1}')"
printf "%s  %s\n" "$HASH" "$ZIP_NAME" > "$ZIP_PATH.sha256"

echo "Runtime package: $ZIP_PATH"
echo "SHA256: $HASH"
