#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
证书管理模块 - 将 CA 证书推送到 Android 设备并注入系统信任 store
输出 JSON 到 stdout，供 Node.js extension 消费
"""

import sys
import os
import re
import json
import time
import hashlib
import shutil
import subprocess
import argparse

if sys.platform == "win32":
    sys.stdout = open(sys.stdout.fileno(), mode="w", encoding="utf-8", buffering=1)
    sys.stderr = open(sys.stderr.fileno(), mode="w", encoding="utf-8", buffering=1)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
WORK_PATH = "/data/local/tmp/"

# Android cert directories
SYSTEM_CACERTS_DIR = "/system/etc/security/cacerts"
APEX_CONSCRYPT_CACERTS_DIR = "/apex/com.android.conscrypt/cacerts"


# ===== 通用工具函数 =====

def run_cmd(args, check=False, timeout=None):
    """
    执行本地命令。args 传 list，避免 Windows shell=True 路径空格问题。
    """
    try:
        result = subprocess.run(
            args,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=timeout,
        )
        if check and result.returncode != 0:
            cmd_text = " ".join(map(str, args))
            raise RuntimeError(
                f"Command failed: {cmd_text}\n"
                f"returncode: {result.returncode}\n"
                f"stdout: {result.stdout}\n"
                f"stderr: {result.stderr}"
            )
        return result
    except subprocess.TimeoutExpired:
        cmd_text = " ".join(map(str, args))
        raise RuntimeError(f"Command timed out: {cmd_text}")
    except FileNotFoundError as e:
        raise RuntimeError(
            "adb not found. Make sure adb is installed and in PATH."
        ) from e


def adb_shell(command, check=True, timeout=15):
    """在 Android 设备上执行 shell 命令。"""
    return run_cmd(
        ["adb", "shell", command],
        check=check,
        timeout=timeout,
    )


def adb_push(source, target_dir):
    """adb push 文件到设备。"""
    result = run_cmd(
        ["adb", "push", source, target_dir],
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"adb push failed: {source} -> {target_dir}\n"
            f"stdout: {result.stdout}\n"
            f"stderr: {result.stderr}"
        )
    return result


# ===== 证书格式转换：PEM → Android .0 格式 =====

def compute_subject_hash_old(cert_pem_path):
    """
    计算 OpenSSL -subject_hash_old（MD5 of DER Subject）。
    前 4 字节按小端序解释为 uint32。
    """
    from cryptography import x509
    from cryptography.hazmat.primitives.serialization import Encoding

    with open(cert_pem_path, "rb") as f:
        cert = x509.load_pem_x509_certificate(f.read())

    subject_der = cert.subject.public_bytes(Encoding.DER)
    md5 = hashlib.md5(subject_der).digest()
    hash_val = int.from_bytes(md5[:4], 'little')
    return format(hash_val, "08x")


def convert_to_android_cert(cert_pem_path, output_dir=None):
    """将 PEM 证书转换为 Android 系统信任 store 所需的 .0 格式。"""
    if not os.path.exists(cert_pem_path):
        raise FileNotFoundError(f"Certificate not found: {cert_pem_path}")

    hash_val = compute_subject_hash_old(cert_pem_path)
    target_name = f"{hash_val}.0"

    if output_dir is None:
        output_dir = os.path.dirname(cert_pem_path)

    target_path = os.path.join(output_dir, target_name)
    shutil.copy2(cert_pem_path, target_path)

    return target_path, hash_val


# ===== ADB 设备管理 =====

def check_device():
    """Check if ADB device is connected and has root."""
    try:
        result = run_cmd(["adb", "shell", "echo", "connected"], check=False, timeout=5)
        if result.returncode != 0 or "connected" not in result.stdout:
            return {"connected": False, "error": "No ADB device connected"}
    except Exception as e:
        return {"connected": False, "error": str(e)}

    version = adb_shell("getprop ro.build.version.release", check=False).stdout.strip()
    model = adb_shell("getprop ro.product.model", check=False).stdout.strip()
    whoami = adb_shell("whoami", check=False).stdout.strip()

    info = {
        "connected": True,
        "androidVersion": version,
        "model": model,
        "isRoot": whoami == "root",
    }

    if not info["isRoot"]:
        try:
            run_cmd(["adb", "root"], check=False, timeout=15)
            time.sleep(1)
            whoami2 = adb_shell("whoami", check=False).stdout.strip()
            info["isRoot"] = whoami2 == "root"
            info["rootMessage"] = "Root access acquired" if info["isRoot"] else "Root failed"
        except Exception as e:
            info["rootMessage"] = str(e)

    return info


def push_certificate(cert_path):
    """Push a certificate file to the device."""
    if not os.path.exists(cert_path):
        return {"success": False, "message": f"Certificate file not found: {cert_path}"}

    basename = os.path.basename(cert_path)
    try:
        adb_push(cert_path, WORK_PATH)
        return {
            "success": True,
            "message": f"Certificate pushed: {basename}",
            "remotePath": f"{WORK_PATH}{basename}",
        }
    except RuntimeError as e:
        return {"success": False, "message": str(e)}


# ===== 证书注入：纯 Python adb shell 编排 =====

def parse_android_major_version(version_text):
    """解析 Android 主版本号。"""
    m = re.search(r"\d+", (version_text or "").strip())
    if not m:
        raise RuntimeError(f"Cannot parse Android version: {version_text}")
    return int(m.group())


def _get_pids_by_name(process_name):
    """通过 pidof 获取进程 PID 列表。"""
    result = adb_shell(f"pidof {process_name}", check=False, timeout=10)
    if result.returncode != 0 or not result.stdout.strip():
        return []
    return [p for p in result.stdout.strip().split() if p.isdigit()]


def _get_child_pids(parent_pid):
    """获取指定父进程的所有子进程 PID。"""
    result = adb_shell(f"ps -o PID --ppid {parent_pid}", check=False, timeout=10)
    if result.returncode != 0:
        return []

    pids = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line or line.upper() == "PID":
            continue
        if line.isdigit():
            pids.append(line)
    return pids


def _chunk(items, size):
    """将列表分块。"""
    return [items[i:i + size] for i in range(0, len(items), size)]


def inject_certificates():
    """
    将证书注入 Android 系统信任 store。
    纯 Python adb shell 编排 —— 不依赖外部 .sh 脚本，彻底消除 CRLF 问题。
    """
    device = check_device()
    if not device.get("isRoot"):
        return {"success": False, "message": "Device must be rooted to inject certificates"}

    android_version = parse_android_major_version(device.get("androidVersion", "0"))
    is_android14 = android_version >= 14

    if is_android14:
        cert_source_dir = APEX_CONSCRYPT_CACERTS_DIR
        bind_target_dir = APEX_CONSCRYPT_CACERTS_DIR
    else:
        cert_source_dir = SYSTEM_CACERTS_DIR
        bind_target_dir = SYSTEM_CACERTS_DIR

    tmpfs_mount_dir = SYSTEM_CACERTS_DIR
    tmp_copy_dir = "/data/local/tmp/tmp-ca-copy"
    errors = []

    try:
        # Step 1: 清理并创建临时目录
        adb_shell(f"rm -rf {tmp_copy_dir} && mkdir -p -m 700 {tmp_copy_dir}",
                   check=True, timeout=15)

        # Step 2: 复制现有系统证书到临时目录
        adb_shell(f"cp {cert_source_dir}/* {tmp_copy_dir}/",
                   check=True, timeout=30)

        # Step 3: 在 /system/etc/security/cacerts 上挂载 tmpfs
        adb_shell(f"mount -t tmpfs tmpfs {tmpfs_mount_dir}",
                   check=True, timeout=15)

        # Step 4: 将原有证书移动回 tmpfs
        adb_shell(f"mv {tmp_copy_dir}/* {tmpfs_mount_dir}/",
                   check=True, timeout=30)

        # Step 5: 复制新的 .0 证书
        adb_shell(f"cp {WORK_PATH}*.0 {tmpfs_mount_dir}/",
                   check=True, timeout=30)

        # Step 6: 修正权限和 SELinux 上下文
        adb_shell(f"chown root:root {tmpfs_mount_dir}/*",
                   check=True, timeout=15)
        adb_shell(f"chmod 644 {tmpfs_mount_dir}/*",
                   check=True, timeout=15)
        adb_shell(f"chcon u:object_r:system_file:s0 {tmpfs_mount_dir}/*",
                   check=True, timeout=15)

        # Step 7: 获取 Zygote PID
        zygote_pids = []
        for name in ("zygote64", "zygote"):
            zygote_pids.extend(_get_pids_by_name(name))
        zygote_pids = sorted(set(zygote_pids), key=int)

        if not zygote_pids:
            errors.append("No Zygote process found, namespace injection skipped")
        else:
            # Step 8: 注入 Zygote namespace
            for z_pid in zygote_pids:
                try:
                    adb_shell(
                        f"nsenter --mount=/proc/{z_pid}/ns/mnt -- "
                        f"mount --bind {tmpfs_mount_dir} {bind_target_dir}",
                        check=True, timeout=15,
                    )
                except RuntimeError as e:
                    errors.append(f"nsenter zygote {z_pid}: {e}")

            # Step 9: 获取所有子进程 PID 并注入
            app_pids = []
            for z_pid in zygote_pids:
                children = _get_child_pids(z_pid)
                if children:
                    app_pids.extend(children)
            app_pids = sorted(set(app_pids), key=int)

            if app_pids:
                # 批量注入 app namespace（每批 20 个，后台并行）
                for batch in _chunk(app_pids, 20):
                    commands = []
                    for pid in batch:
                        commands.append(
                            f"( nsenter --mount=/proc/{pid}/ns/mnt -- "
                            f"mount --bind {tmpfs_mount_dir} {bind_target_dir} "
                            f">/dev/null 2>&1 || true ) &"
                        )
                    batch_cmd = " ".join(commands) + " wait"
                    adb_shell(batch_cmd, check=False, timeout=30)
            else:
                errors.append("No app processes found for namespace injection")

        # 清理临时目录
        adb_shell(f"rm -rf {tmp_copy_dir}", check=False)

        return {
            "success": True,
            "message": "Certificate injection completed"
                       + (f" (warnings: {'; '.join(errors)})" if errors else ""),
            "warnings": errors if errors else None,
        }

    except RuntimeError as e:
        # 尝试清理
        adb_shell(f"rm -rf {tmp_copy_dir}", check=False, timeout=5)
        return {
            "success": False,
            "message": f"Injection failed: {str(e)[:500]}",
        }


# ===== CLI =====

def main():
    parser = argparse.ArgumentParser(description="Certificate manager for SecMP")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("check", help="Check ADB device status")

    push_parser = subparsers.add_parser("push", help="Convert, push and inject certificate")
    push_parser.add_argument("--cert", required=True, help="Path to CA certificate (PEM format)")

    convert_parser = subparsers.add_parser("convert", help="Convert PEM cert to Android .0 format only")
    convert_parser.add_argument("--cert", required=True, help="Path to CA certificate (PEM format)")
    convert_parser.add_argument("--output-dir", default=None, help="Output directory (default: same as cert)")

    subparsers.add_parser("inject", help="Inject certificates only")

    args = parser.parse_args()

    if args.command == "check":
        result = check_device()
    elif args.command == "convert":
        try:
            target_path, hash_val = convert_to_android_cert(args.cert, args.output_dir)
            result = {
                "success": True,
                "message": f"Certificate converted: {os.path.basename(target_path)}",
                "hash": hash_val,
                "outputFile": target_path,
            }
        except Exception as e:
            result = {"success": False, "message": str(e)}
    elif args.command == "push":
        try:
            target_path, hash_val = convert_to_android_cert(args.cert)
        except Exception as e:
            result = {"success": False, "message": f"Certificate conversion failed: {e}"}
            print(json.dumps(result, ensure_ascii=False, indent=2))
            sys.exit(1)

        push_result = push_certificate(target_path)
        if push_result["success"]:
            inject_result = inject_certificates()
            result = {
                "success": inject_result["success"],
                "message": f"{hash_val}.0 pushed and injected. {inject_result['message']}",
                "hash": hash_val,
                "push": push_result,
                "inject": inject_result,
            }
        else:
            result = push_result
    elif args.command == "inject":
        result = inject_certificates()

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
