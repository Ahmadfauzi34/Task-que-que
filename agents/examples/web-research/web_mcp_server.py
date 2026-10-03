#!/usr/bin/env python3
"""
Web Research MCP Server - Contoh agen Jenis 2 yang nyata.

Tools:
- fetch_url: ambil konten dari URL
- extract_text: ekstrak teks bersih dari HTML

Jalankan: python3 web_mcp_server.py [port]
Default port: 18091
"""
import json
import sys
import re
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18091

def fetch_url(url: str, max_chars: int = 5000) -> str:
    """Ambil konten dari URL."""
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (compatible; TQQ-Agent/1.0)'
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            content_type = resp.headers.get('Content-Type', '')
            data = resp.read().decode('utf-8', errors='ignore')
            if 'html' in content_type:
                text = extract_text(data)
            else:
                text = data
            return text[:max_chars]
    except Exception as e:
        return f"Error fetching {url}: {e}"

def extract_text(html: str) -> str:
    """Ekstrak teks bersih dari HTML."""
    # Hapus script dan style
    html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<style[^>]*>.*?</style>', '', html, flags=re.DOTALL | re.IGNORECASE)
    # Hapus tag HTML
    text = re.sub(r'<[^>]+>', ' ', html)
    # Decode entities sederhana
    text = text.replace('&nbsp;', ' ').replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
    # Normalisasi whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    return text

TOOLS = {
    "fetch_url": {
        "description": "Ambil konten dari URL, kembalikan teks (max 5000 char)",
        "params": ["url"],
        "handler": lambda args: fetch_url(args.get("url", ""))
    },
    "extract_text": {
        "description": "Ekstrak teks bersih dari HTML",
        "params": ["html"],
        "handler": lambda args: extract_text(args.get("html", ""))[:5000]
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
                "serverInfo": {"name": "web-research-agent", "version": "1.0.0"},
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
    print(f"Web Research MCP Server on :{PORT}", flush=True)
    print(f"Tools: {', '.join(TOOLS.keys())}", flush=True)
    server.serve_forever()
