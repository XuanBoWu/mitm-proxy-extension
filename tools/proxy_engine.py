#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SecMP proxy engine - 基于 mitmproxy WebMaster 的抓包引擎。
通过 WebSocket 实时推送 flow 数据，body 内容通过 REST API 按需获取。
"""

import sys
import os
import base64
import hashlib
import json
import secrets
import logging
import asyncio
import argparse
import platform
import threading
import traceback

EXPECTED_MITMPROXY_VERSION = "12.2.2"
FATAL_TORNADO_SELECTOR_EXIT_CODE = 88
WINDOWS_EVENT_LOOP_POLICY_ENV = "SECMP_WINDOWS_EVENT_LOOP_POLICY"
RUNTIME_EVENT_PREFIX = "SECMPRT_EVENT="
RUNTIME_EVENT_BODY_CHUNK_BYTES = 64 * 1024
DEFAULT_RUNTIME_EVENT_BODY_MAX_BYTES = 8 * 1024 * 1024


class UpstreamBindAddon:
    def __init__(self, connect_addr):
        self.connect_addr = connect_addr

    def server_connect(self, data):
        if self.connect_addr and not data.server.sockname:
            data.server.sockname = (self.connect_addr, 0)


class RuntimeCaptureEventAddon:
    def __init__(self, max_body_bytes=DEFAULT_RUNTIME_EVENT_BODY_MAX_BYTES):
        self.max_body_bytes = max(0, int(max_body_bytes or 0))

    def request(self, flow):
        self.emit_body(flow, "request", getattr(flow, "request", None))

    def response(self, flow):
        self.emit_body(flow, "response", getattr(flow, "response", None))

    def error(self, flow):
        flow_id = getattr(flow, "id", "")
        if flow_id and getattr(flow, "error", None):
            emit_runtime_event({
                "type": "body/error",
                "flowId": flow_id,
                "side": "response",
                "message": str(flow.error),
                "retryable": False,
            })

    def emit_body(self, flow, side, message):
        if not flow or not message:
            return
        flow_id = getattr(flow, "id", "")
        if not flow_id:
            return
        content_encoding = get_message_content_encoding(message)
        payload = get_message_body_payload(message, content_encoding)
        if payload.get("error"):
            emit_runtime_event({
                "type": "body/error",
                "flowId": flow_id,
                "side": side,
                "message": payload["error"],
                "retryable": True,
                "contentEncoding": content_encoding,
            })
            return
        body = payload["body"]
        if not body:
            return
        content_type = get_message_content_type(message)
        if self.max_body_bytes and len(body) > self.max_body_bytes:
            emit_runtime_event({
                "type": "body/error",
                "flowId": flow_id,
                "side": side,
                "message": f"body size {len(body)} exceeds runtime event limit {self.max_body_bytes}",
                "retryable": True,
                "contentEncoding": content_encoding,
            })
            return

        offset = 0
        for start in range(0, len(body), RUNTIME_EVENT_BODY_CHUNK_BYTES):
            chunk = body[start:start + RUNTIME_EVENT_BODY_CHUNK_BYTES]
            emit_runtime_event({
                "type": "body/chunk",
                "flowId": flow_id,
                "side": side,
                "encoding": "base64",
                "contentType": content_type,
                "contentEncoding": content_encoding,
                "decoded": payload["decoded"],
                "offset": offset,
                "data": base64.b64encode(chunk).decode("ascii"),
            })
            offset += len(chunk)
        emit_runtime_event({
            "type": "body/complete",
            "flowId": flow_id,
            "side": side,
            "size": len(body),
            "sha256": hashlib.sha256(body).hexdigest(),
            "contentType": content_type,
            "contentEncoding": content_encoding,
            "decoded": payload["decoded"],
        })

if sys.platform == "win32":
    sys.stdout = open(sys.stdout.fileno(), mode="w", encoding="utf-8", buffering=1)
    sys.stderr = open(sys.stderr.fileno(), mode="w", encoding="utf-8", buffering=1)

# Route mitmproxy logging to stderr so extension.js can parse info
logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
    stream=sys.stderr,
)


def write_stderr_line(line):
    sys.stderr.write(f"{line}\n")
    sys.stderr.flush()


def write_stdout_line(line):
    sys.stdout.write(f"{line}\n")
    sys.stdout.flush()


def emit_runtime_event(event):
    write_stdout_line(RUNTIME_EVENT_PREFIX + json.dumps(event, ensure_ascii=False, sort_keys=True))


def get_message_content_type(message):
    try:
        return message.headers.get("content-type", "") or ""
    except Exception:
        return ""


def get_message_content_encoding(message):
    try:
        return message.headers.get("content-encoding", "") or ""
    except Exception:
        return ""


def coerce_body_bytes(body):
    if body is None:
        return b""
    if isinstance(body, bytes):
        return body
    if isinstance(body, str):
        return body.encode("utf-8", errors="replace")
    try:
        return bytes(body)
    except Exception:
        return b""


def get_message_body_payload(message, content_encoding=""):
    try:
        body = getattr(message, "content", None)
        if body is not None:
            return {
                "body": coerce_body_bytes(body),
                "decoded": bool(content_encoding and content_encoding.lower() != "identity"),
                "error": "",
            }
    except Exception as e:
        if content_encoding and content_encoding.lower() != "identity":
            return {
                "body": b"",
                "decoded": False,
                "error": f"failed to decode {content_encoding} body: {e}",
            }

    raw_body = getattr(message, "raw_content", None)
    return {
        "body": coerce_body_bytes(raw_body),
        "decoded": False,
        "error": "",
    }


def get_tornado_version():
    try:
        import tornado
        return getattr(tornado, "version", "") or getattr(tornado, "__version__", "")
    except Exception as e:
        return f"unavailable: {e}"


def get_event_loop_policy_name():
    try:
        return type(asyncio.get_event_loop_policy()).__name__
    except Exception as e:
        return f"unavailable: {e}"


def configure_windows_event_loop_policy():
    if sys.platform != "win32":
        return get_event_loop_policy_name()

    requested = os.environ.get(WINDOWS_EVENT_LOOP_POLICY_ENV, "selector").strip().lower()
    if requested in ("", "selector", "windowsselector"):
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    elif requested in ("default", "proactor", "windowsproactor"):
        # Keep Python's default Windows policy for A/B comparison.
        pass
    else:
        write_stderr_line(
            f"RUNTIME_DIAGNOSTIC_WARNING=unknown {WINDOWS_EVENT_LOOP_POLICY_ENV}={requested}; using current policy"
        )
    return get_event_loop_policy_name()


def emit_runtime_diagnostics(actual_loop=None, mitmproxy_version=""):
    diagnostics = {
        "python": sys.version.replace("\n", " "),
        "pythonExecutable": sys.executable,
        "platform": platform.platform(),
        "system": sys.platform,
        "mitmproxy": mitmproxy_version,
        "tornado": get_tornado_version(),
        "asyncioPolicy": get_event_loop_policy_name(),
        "asyncioLoop": type(actual_loop).__name__ if actual_loop else "",
    }
    write_stderr_line("RUNTIME_DIAGNOSTICS=" + json.dumps(diagnostics, ensure_ascii=False, sort_keys=True))


def install_threading_excepthook():
    if not hasattr(threading, "excepthook"):
        return

    previous_hook = threading.excepthook

    def secmp_threading_excepthook(args):
        thread_name = getattr(args.thread, "name", "") or ""
        message = "".join(traceback.format_exception(args.exc_type, args.exc_value, args.exc_traceback)).strip()
        fatal = "Tornado selector" in thread_name
        payload = {
            "component": "tornado-selector" if fatal else "thread",
            "thread": thread_name,
            "exception": getattr(args.exc_type, "__name__", str(args.exc_type)),
            "message": str(args.exc_value),
            "fatal": fatal,
        }
        prefix = "RUNTIME_FATAL" if fatal else "RUNTIME_THREAD_EXCEPTION"
        write_stderr_line(prefix + "=" + json.dumps(payload, ensure_ascii=False, sort_keys=True))
        if message:
            write_stderr_line(message)
        try:
            previous_hook(args)
        except Exception:
            pass
        if fatal:
            os._exit(FATAL_TORNADO_SELECTOR_EXIT_CODE)

    threading.excepthook = secmp_threading_excepthook


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
    install_threading_excepthook()
    selected_policy = configure_windows_event_loop_policy()

    parser = argparse.ArgumentParser(description="SecMP proxy engine")
    parser.add_argument("--check-deps", action="store_true", help="Check runtime dependencies and exit")
    parser.add_argument("--host", default="0.0.0.0", help="Listen host")
    parser.add_argument("--port", type=int, default=8080, help="Proxy listen port")
    parser.add_argument("--web-port", type=int, default=8081, help="Web UI port")
    parser.add_argument("--confdir", default=None, help="mitmproxy config directory")
    parser.add_argument("--connect-addr", default=None, help="Local source address for upstream connections")
    parser.add_argument(
        "--connection-strategy",
        choices=("lazy", "eager"),
        default="lazy",
        help="When mitmproxy establishes upstream server connections",
    )
    parser.add_argument(
        "--runtime-event-body-max-bytes",
        type=int,
        default=DEFAULT_RUNTIME_EVENT_BODY_MAX_BYTES,
        help="Maximum request/response body size emitted through runtime capture events; 0 disables the limit",
    )
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

    options, WebMaster, actual_mitmproxy_version = load_mitmproxy()

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
        emit_runtime_diagnostics(
            actual_loop=asyncio.get_running_loop(),
            mitmproxy_version=actual_mitmproxy_version,
        )
        write_stderr_line(f"ASYNCIO_EVENT_LOOP_POLICY={selected_policy}")
        master = WebMaster(opts)
        if args.connect_addr:
            master.addons.add(UpstreamBindAddon(args.connect_addr))
        master.addons.add(RuntimeCaptureEventAddon(args.runtime_event_body_max_bytes))
        # web_host/web_port registered by WebAddon, must set AFTER WebMaster creation
        master.options.update(
            web_host="127.0.0.1",
            web_port=args.web_port,
            web_password=auth_token,
            web_open_browser=False,
            connection_strategy=args.connection_strategy,
        )

        # Output connection info in parseable format for extension.js
        sys.stderr.write(f"WEB_PORT={args.web_port}\n")
        sys.stderr.write(f"AUTH_TOKEN={auth_token}\n")
        sys.stderr.write(f"LISTEN_HOST={args.host}\n")
        sys.stderr.write(f"CONNECT_ADDR={args.connect_addr or ''}\n")
        sys.stderr.write(f"CONNECTION_STRATEGY={args.connection_strategy}\n")
        sys.stderr.write(f"Proxy server listening on {args.host}:{args.port}\n")
        sys.stderr.flush()
        emit_runtime_event({
            "type": "runtime/ready",
            "webPort": args.web_port,
            "authToken": auth_token,
            "proxyPort": args.port,
            "runtimeApiVersion": 1,
        })

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
