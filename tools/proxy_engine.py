#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MITM Proxy Engine - 基于 mitmproxy WebMaster 的抓包引擎
通过 WebSocket 实时推送 flow 数据，body 内容通过 REST API 按需获取
"""

import sys
import os
import json
import secrets
import logging
import asyncio
import argparse

EXPECTED_MITMPROXY_VERSION = "12.2.2"

if sys.platform == "win32":
    sys.stdout = open(sys.stdout.fileno(), mode="w", encoding="utf-8", buffering=1)
    sys.stderr = open(sys.stderr.fileno(), mode="w", encoding="utf-8", buffering=1)

# Route mitmproxy logging to stderr so extension.js can parse info
logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
    stream=sys.stderr,
)


def load_mitmproxy():
    try:
        from mitmproxy import options
        from mitmproxy import version
        from mitmproxy.tools.web.master import WebMaster
    except ImportError as e:
        raise RuntimeError(f"mitmproxy is not installed or cannot be imported: {e}") from e
    return options, WebMaster, version.VERSION


def check_dependencies():
    try:
        _, _, actual_version = load_mitmproxy()
    except RuntimeError as e:
        return {
            "success": False,
            "message": str(e),
            "requiredMitmproxyVersion": EXPECTED_MITMPROXY_VERSION,
        }

    if actual_version != EXPECTED_MITMPROXY_VERSION:
        return {
            "success": False,
            "message": (
                f"mitmproxy version mismatch: detected {actual_version}, "
                f"required {EXPECTED_MITMPROXY_VERSION}."
            ),
            "actualMitmproxyVersion": actual_version,
            "requiredMitmproxyVersion": EXPECTED_MITMPROXY_VERSION,
        }

    return {
        "success": True,
        "mitmproxyVersion": actual_version,
        "requiredMitmproxyVersion": EXPECTED_MITMPROXY_VERSION,
    }


def main():
    parser = argparse.ArgumentParser(description="MITM Proxy Engine")
    parser.add_argument("--check-deps", action="store_true", help="Check runtime dependencies and exit")
    parser.add_argument("--host", default="0.0.0.0", help="Listen host")
    parser.add_argument("--port", type=int, default=8080, help="Proxy listen port")
    parser.add_argument("--web-port", type=int, default=8081, help="Web UI port")
    parser.add_argument("--confdir", default=None, help="mitmproxy config directory")
    args = parser.parse_args()

    if args.check_deps:
        result = check_dependencies()
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0 if result["success"] else 1)

    dep_result = check_dependencies()
    if not dep_result["success"]:
        sys.stderr.write(json.dumps(dep_result, ensure_ascii=False) + "\n")
        sys.stderr.flush()
        sys.exit(1)

    options, WebMaster, _ = load_mitmproxy()

    if not args.confdir:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        cert_dir = os.path.join(os.path.dirname(script_dir), "certificate")
        os.makedirs(cert_dir, exist_ok=True)
        args.confdir = cert_dir

    # Generate auth token for WebSocket/REST API access
    auth_token = secrets.token_hex(16)

    # Print CA cert fingerprint for verification
    ca_cert_path = os.path.join(args.confdir, "mitmproxy-ca-cert.pem")
    if os.path.exists(ca_cert_path):
        import hashlib
        with open(ca_cert_path, "rb") as f:
            cert_der = f.read()
        fp = hashlib.sha256(cert_der).hexdigest().upper()
        sys.stderr.write(f"CA cert fingerprint (SHA-256): {':'.join(fp[i:i+2] for i in range(0, len(fp), 2))}\n")
    else:
        sys.stderr.write("CA cert not found, mitmproxy will generate a new one on first request\n")
    sys.stderr.flush()

    opts = options.Options(
        listen_host=args.host,
        listen_port=args.port,
        confdir=args.confdir,
        ssl_insecure=True,
    )

    async def run_proxy():
        master = WebMaster(opts)
        # web_host/web_port registered by WebAddon, must set AFTER WebMaster creation
        master.options.update(
            web_host="127.0.0.1",
            web_port=args.web_port,
            web_password=auth_token,
            web_open_browser=False,
        )

        # Output connection info in parseable format for extension.js
        sys.stderr.write(f"WEB_PORT={args.web_port}\n")
        sys.stderr.write(f"AUTH_TOKEN={auth_token}\n")
        sys.stderr.write(f"Proxy server listening on {args.host}:{args.port}\n")
        sys.stderr.flush()

        try:
            await master.run()
        except KeyboardInterrupt:
            pass
        finally:
            master.shutdown()

    try:
        asyncio.run(run_proxy())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
