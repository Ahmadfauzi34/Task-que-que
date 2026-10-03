#!/usr/bin/env python3
"""
Code Runner MCP Server - Contoh agen Jenis 2 untuk komputasi.

Tools:
- run_python: eksekusi kode Python (dengan timeout)
- run_javascript: eksekusi kode JavaScript via node/bun (dengan timeout)

PERINGATAN: Tool ini mengeksekusi kode arbitrer. Hanya jalankan di
environment terisolasi yang kamu percaya.

Jalankan: python3 code_mcp_server.py [port]
Default port: 18092
"""
import json
import sys
import subprocess
import tempfile
import os
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18092
DEFAULT_TIMEOUT = 30

def run_python(code: str, timeout: int = DEFAULT_TIMEOUT) -> str:
    """Eksekusi kode Python dengan timeout."""
    try:
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
            f.write(code)
            fname = f.name
        try:
            result = subprocess.run(
                [sys.executable, fname],
                capture_output=True, text=True, timeout=timeout
            )
            output = ""
            if result.stdout:
                output += result.stdout
            if result.stderr:
                output += f"\n[stderr]\n{result.stderr}"
            if result.returncode != 0:
                output += f"\n[exit code: {result.returncode}]"
            return output[:10000] or "(no output)"
        finally:
            os.unlink(fname)
    except subprocess.TimeoutExpired:
        return f"Error: execution timed out after {timeout}s"
    except Exception as e:
        return f"Error: {e}"

def run_javascript(code: str, timeout: int = DEFAULT_TIMEOUT) -> str:
    """Eksekusi kode JavaScript via node atau bun."""
    # Cari runtime yang tersedia
    runtime = None
    for cmd in ["bun", "node"]:
        try:
            subprocess.run([cmd, "--version"], capture_output=True, timeout=5)
            runtime = cmd
            break
        except:
            continue

    if not runtime:
        return "Error: no JavaScript runtime (bun/node) found"

    try:
        with tempfile.NamedTemporaryFile(mode='w', suffix='.js', delete=False) as f:
            f.write(code)
            fname = f.name
        try:
            result = subprocess.run(
                [runtime, fname],
                capture_output=True, text=True, timeout=timeout
            )
            output = ""
            if result.stdout:
                output += result.stdout
            if result.stderr:
                output += f"\n[stderr]\n{result.stderr}"
            if result.returncode != 0:
                output += f"\n[exit code: {result.returncode}]"
            return output[:10000] or "(no output)"
        finally:
            os.unlink(fname)
    except subprocess.TimeoutExpired:
        return f"Error: execution timed out after {timeout}s"
    except Exception as e:
        return f"Error: {e}"

TOOLS = {
    "run_python": {
        "description": "Eksekusi kode Python, kembalikan stdout/stderr",
        "params": ["code", "timeout"],
        "handler": lambda args: run_python(
            args.get("code", ""),
            int(args.get("timeout", DEFAULT_TIMEOUT))
        )
    },
    "run_javascript": {
        "description": "Eksekusi kode JavaScript (bun/node), kembalikan stdout/stderr",
        "params": ["code", "timeout"],
        "handler": lambda args: run_javascript(
            args.get("code", ""),
            int(args.get("timeout", DEFAULT_TIMEOUT))
        )
    },
}

class MCPHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length) or b'{}')
        method = body.get("method", "")
        req_id = body.get("id")

        if method == "initialize":
            result = {
                "protocolVersion": "2024-11-05",
                "serverInfo": {"name": "code-runner-agent", "version": "1.0.0"},
                "capabilities": {"tools": {}}
            }
        elif method == "tools/list":
            result = {
                "tools": [
                    {"name": name, "description": t["description"],
                     "inputSchema": {"type": "object", "properties": {
                         p: {"type": "string"} for p in t["params"]}}}
                    for name, t in TOOLS.items()
                ]
            }
        elif method == "tools/call":
            name = body.get("params", {}).get("name", "")
            args = body.get("params", {}).get("arguments", {})
            if name in TOOLS:
                try:
                    output = TOOLS[name]["handler"](args)
                    result = {"content": [{"type": "text", "text": str(output)}]}
                except Exception as e:
                    result = {"content": [{"type": "text", "text": f"Error: {e}"}], "isError": True}
            else:
                result = {"content": [{"type": "text", "text": f"Unknown tool: {name}"}], "isError": True}
        elif method == "notifications/initialized":
            result = {}
        else:
            result = {"error": f"Unknown method: {method}"}

        resp = json.dumps({"jsonrpc": "2.0", "id": req_id, "result": result}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)

if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), MCPHandler)
    print(f"Code Runner MCP Server on :{PORT}", flush=True)
    print(f"Tools: {', '.join(TOOLS.keys())}", flush=True)
    print("WARNING: executes arbitrary code - use in trusted environment only", flush=True)
    server.serve_forever()
