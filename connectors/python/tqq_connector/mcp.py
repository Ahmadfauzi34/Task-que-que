"""MCP client for talking to local MCP servers."""
import json
import urllib.request
import urllib.error


class MCPError(Exception):
    pass


class MCPClient:
    """Minimal MCP client (Streamable HTTP / JSON-RPC)."""

    def __init__(self, url: str, timeout: int = 15):
        self.url = url.rstrip("/") + "/"
        self.timeout = timeout

    def _rpc(self, method: str, params: dict, req_id=None) -> dict:
        body = {"jsonrpc": "2.0", "method": method, "params": params}
        if req_id is not None:
            body["id"] = req_id
        data = json.dumps(body).encode()
        req = urllib.request.Request(
            self.url, data=data, method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                text = resp.read().decode()
        except urllib.error.HTTPError as e:
            raise MCPError(f"HTTP {e.code}")
        except Exception as e:
            raise MCPError(f"connection failed: {e}")

        # Handle SSE wrapper
        if text.startswith("event:"):
            for line in text.split("\n"):
                if line.startswith("data: "):
                    text = line[6:]
                    break
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            raise MCPError("invalid JSON response")

    def call_tool(self, tool: str, arguments: dict = None):
        """Call a tool, return the result content."""
        # Initialize
        init = self._rpc("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "tqq-connector", "version": "0.1.0"},
        }, req_id=1)
        if init.get("error"):
            raise MCPError(f"init failed: {init['error']}")

        # Initialized notification (no response expected)
        try:
            self._rpc("notifications/initialized", {}, req_id=None)
        except Exception:
            pass

        # Call tool
        result = self._rpc("tools/call", {
            "name": tool,
            "arguments": arguments or {},
        }, req_id=2)
        if result.get("error"):
            raise MCPError(f"tool error: {result['error']}")
        return result.get("result")

    def list_tools(self) -> list:
        """List available tools."""
        init = self._rpc("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "tqq-connector", "version": "0.1.0"},
        }, req_id=1)
        if init.get("error"):
            raise MCPError(f"init failed: {init['error']}")
        result = self._rpc("tools/list", {}, req_id=2)
        if result.get("error"):
            raise MCPError(f"list failed: {result['error']}")
        return result.get("result", {}).get("tools", [])
