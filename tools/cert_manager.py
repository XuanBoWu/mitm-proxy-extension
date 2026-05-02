#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
证书管理模块 - 将 CA 证书推送到 Android 设备并注入系统信任 store
输出 JSON 到 stdout，供 Node.js extension 消费
"""

import sys
import os
import json
import subprocess
import argparse
from pathlib import Path

if sys.platform == "win32":
    sys.stdout = open(sys.stdout.fileno(), mode="w", encoding="utf-8", buffering=1)
    sys.stderr = open(sys.stderr.fileno(), mode="w", encoding="utf-8", buffering=1)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SCRIPTS_DIR = os.path.join(SCRIPT_DIR, "scripts")
WORK_PATH = "/data/local/tmp/"


def run_adb(cmd, timeout=15):
    """Run an adb command and return completed process"""
    try:
        return subprocess.run(
            f"adb {cmd}",
            shell=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess([], -1, "", "Timeout")
    except Exception as e:
        return subprocess.CompletedProcess([], -1, "", str(e))


def check_device():
    """Check if ADB device is connected and has root"""
    result = run_adb("shell echo connected")
    if result.returncode != 0 or "connected" not in result.stdout:
        return {"connected": False, "error": "No ADB device connected"}

    # Get device info
    version = run_adb("shell getprop ro.build.version.release").stdout.strip()
    model = run_adb("shell getprop ro.product.model").stdout.strip()
    whoami = run_adb("shell whoami").stdout.strip()

    info = {
        "connected": True,
        "androidVersion": version,
        "model": model,
        "isRoot": whoami == "root",
    }

    # Try to get root if not already
    if not info["isRoot"]:
        root_result = run_adb("root")
        time.sleep(1)
        whoami2 = run_adb("shell whoami").stdout.strip()
        info["isRoot"] = whoami2 == "root"
        info["rootMessage"] = "Root access acquired" if info["isRoot"] else "Root failed"

    return info


def push_certificate(cert_path):
    """Push a certificate file to the device"""
    if not os.path.exists(cert_path):
        return {"success": False, "message": f"Certificate file not found: {cert_path}"}

    target = WORK_PATH
    result = run_adb(f'push "{cert_path}" {target}')

    if result.returncode != 0:
        return {"success": False, "message": f"Push failed: {result.stderr}"}

    basename = os.path.basename(cert_path)
    return {
        "success": True,
        "message": f"Certificate pushed: {basename}",
        "remotePath": f"{target}{basename}",
    }


def inject_certificates():
    """Run the shell script to inject certificates into system trust store"""
    # Check device first
    device = check_device()
    if not device.get("isRoot"):
        return {"success": False, "message": "Device must be rooted to inject certificates"}

    # Determine which script to use based on Android version
    try:
        android_version = int(device.get("androidVersion", "0"))
    except ValueError:
        android_version = 0

    script_name = "set_ca_android14.sh" if android_version >= 14 else "set_ca_android.sh"
    script_path = os.path.join(SCRIPTS_DIR, script_name)

    if not os.path.exists(script_path):
        return {"success": False, "message": f"Script not found: {script_name}"}

    # Push script to device
    push_result = run_adb(f'push "{script_path}" {WORK_PATH}')
    if push_result.returncode != 0:
        return {"success": False, "message": f"Failed to push script: {push_result.stderr}"}

    # Make executable
    remote_script = f"{WORK_PATH}{script_name}"
    run_adb(f"shell chmod 777 {remote_script}")

    # Execute the script
    result = run_adb(f"shell {remote_script}", timeout=60)

    return {
        "success": result.returncode == 0,
        "message": "Certificate injection completed" if result.returncode == 0 else f"Injection failed: {result.stderr}",
        "output": result.stdout,
        "error": result.stderr if result.returncode != 0 else "",
    }


def main():
    parser = argparse.ArgumentParser(description="Certificate Manager for MITM Proxy")
    subparsers = parser.add_subparsers(dest="command", required=True)

    check_parser = subparsers.add_parser("check", help="Check ADB device status")

    push_parser = subparsers.add_parser("push", help="Push and inject certificate")
    push_parser.add_argument("--cert", required=True, help="Path to certificate file")

    inject_parser = subparsers.add_parser("inject", help="Inject certificates only")

    args = parser.parse_args()

    if args.command == "check":
        result = check_device()
    elif args.command == "push":
        push_result = push_certificate(args.cert)
        if push_result["success"]:
            inject_result = inject_certificates()
            result = {
                "success": inject_result["success"],
                "message": f"Pushed and injected. {inject_result['message']}",
                "push": push_result,
                "inject": inject_result,
            }
        else:
            result = push_result
    elif args.command == "inject":
        result = inject_certificates()

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    import time
    main()
