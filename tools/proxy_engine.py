#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MITM Proxy Engine - 基于 mitmproxy 的中间人抓包引擎
输出 JSONL 到 stdout，供 Node.js extension 消费
"""

import sys
import os
import json
import uuid
import time
import asyncio
import argparse
from datetime import datetime, timezone

if sys.platform == "win32":
    sys.stdout = open(sys.stdout.fileno(), mode="w", encoding="utf-8", buffering=1)
    sys.stderr = open(sys.stderr.fileno(), mode="w", encoding="utf-8", buffering=1)

try:
    from mitmproxy import options, http
    from mitmproxy.master import Master
    from mitmproxy.addons import default_addons
except ImportError as e:
    print(json.dumps({"error": f"mitmproxy not installed: {e}"}))
    sys.exit(1)


def safe_str(v):
    """Safely decode bytes to string, truncate large bodies"""
    if v is None:
        return ""
    if isinstance(v, bytes):
        try:
            return v.decode("utf-8", errors="replace")
        except Exception:
            return v.decode("latin-1", errors="replace")
    return str(v)


def truncate_body(body, max_len=65536):
    """Truncate large bodies to avoid excessive output"""
    if len(body) > max_len:
        return body[:max_len] + f"\n... [truncated {len(body) - max_len} bytes]"
    return body


def build_flow_dict(flow: http.HTTPFlow) -> dict:
    """Extract complete flow data as a dictionary"""
    req = flow.request
    res = flow.response

    req_headers = {}
    for k, v in req.headers.items():
        key = k.lower()
        if key not in req_headers:
            req_headers[key] = v
        elif isinstance(req_headers[key], list):
            req_headers[key].append(v)
        else:
            req_headers[key] = [req_headers[key], v]

    res_headers = {}
    if res:
        for k, v in res.headers.items():
            key = k.lower()
            if key not in res_headers:
                res_headers[key] = v
            elif isinstance(res_headers[key], list):
                res_headers[key].append(v)
            else:
                res_headers[key] = [res_headers[key], v]

    req_body = truncate_body(safe_str(req.content))
    res_body = truncate_body(safe_str(res.content)) if res else ""

    req_ts = req.timestamp_start or time.time()
    res_ts = res.timestamp_start if res else 0
    duration_ms = round((res_ts - req_ts) * 1000) if res else 0

    tls_version = ""
    tls_cipher = ""
    server_ip = ""

    if flow.server_conn:
        tls_version = flow.server_conn.tls_version or ""
        tls_cipher = flow.server_conn.sni or ""
        if flow.server_conn.peername:
            server_ip = flow.server_conn.peername[0] or ""

        # cipher info from server connection
        if hasattr(flow.server_conn, "cipher") and flow.server_conn.cipher:
            tls_cipher = safe_str(flow.server_conn.cipher)
        if hasattr(flow.server_conn, "tls_version") and flow.server_conn.tls_version:
            tls_version = safe_str(flow.server_conn.tls_version)

    client_ip = ""
    if flow.client_conn and flow.client_conn.peername:
        client_ip = flow.client_conn.peername[0] or ""

    content_type = ""
    if res:
        ct = res.headers.get("content-type", "")
        if ct:
            content_type = ct.split(";")[0].strip()

    flow_id = str(uuid.uuid4())[:8]

    return {
        "id": flow_id,
        "url": req.pretty_url,
        "method": req.method,
        "host": req.host,
        "port": req.port,
        "path": req.path,
        "status_code": res.status_code if res else 0,
        "req_headers": req_headers,
        "res_headers": res_headers,
        "req_body": req_body,
        "res_body": res_body,
        "req_timestamp": req_ts,
        "res_timestamp": res_ts,
        "duration_ms": duration_ms,
        "tls_version": tls_version,
        "tls_cipher": tls_cipher,
        "server_ip": server_ip,
        "client_ip": client_ip,
        "content_type": content_type,
        "req_size": len(req.content) or 0,
        "res_size": len(res.content) if res else 0,
    }


class CaptureAddon:
    """mitmproxy addon that captures flows and outputs JSONL to stdout"""

    def response(self, flow: http.HTTPFlow):
        try:
            data = build_flow_dict(flow)
            print(json.dumps(data, ensure_ascii=False), flush=True)
        except Exception as e:
            print(json.dumps({"error": str(e), "url": flow.request.pretty_url if flow.request else "unknown"}), flush=True)

    def error(self, flow: http.HTTPFlow):
        """Capture connection errors"""
        try:
            req = flow.request
            if not req:
                return
            data = {
                "id": str(uuid.uuid4())[:8],
                "url": req.pretty_url,
                "method": req.method,
                "host": req.host,
                "port": req.port,
                "path": req.path,
                "status_code": 0,
                "req_headers": dict(req.headers),
                "res_headers": {},
                "req_body": truncate_body(safe_str(req.content)),
                "res_body": "",
                "req_timestamp": req.timestamp_start or time.time(),
                "res_timestamp": 0,
                "duration_ms": 0,
                "tls_version": "",
                "tls_cipher": "",
                "server_ip": "",
                "client_ip": "",
                "content_type": "",
                "req_size": len(req.content) or 0,
                "res_size": 0,
                "error": safe_str(flow.error.msg) if flow.error else "Connection error",
            }
            print(json.dumps(data, ensure_ascii=False), flush=True)
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(description="MITM Proxy Engine")
    parser.add_argument("--host", default="0.0.0.0", help="Listen host")
    parser.add_argument("--port", type=int, default=8080, help="Listen port")
    parser.add_argument("--confdir", default=None, help="mitmproxy config directory")
    args = parser.parse_args()

    # Use extension's certificate directory as confdir
    if not args.confdir:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        cert_dir = os.path.join(os.path.dirname(script_dir), "certificate")
        os.makedirs(cert_dir, exist_ok=True)
        args.confdir = cert_dir

    opts = options.Options(
        listen_host=args.host,
        listen_port=args.port,
        confdir=args.confdir,
        ssl_insecure=True,  # Accept all upstream certs
    )

    async def run_proxy():
        master = Master(opts)
        master.addons.add(CaptureAddon())
        master.addons.add(*default_addons())
        sys.stderr.write(f"Proxy server listening on {args.host}:{args.port}\n")
        sys.stderr.write(f"CA cert directory: {args.confdir}\n")
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
