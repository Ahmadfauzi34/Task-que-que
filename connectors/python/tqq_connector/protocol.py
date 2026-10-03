"""Gateway API client for Task-que-que agent endpoints."""
import json
import urllib.request
import urllib.error


class GatewayError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class GatewayClient:
    """HTTP client for /v1/agent/* endpoints."""

    def __init__(self, gateway_url: str, token: str, timeout: int = 30):
        self.base = gateway_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.agent_token = None
        self.agent_id = None

    def _headers(self, extra: dict = None):
        h = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.token}",
        }
        if self.agent_token:
            h["X-Agent-Token"] = self.agent_token
        if self.agent_id:
            h["X-Agent-Id"] = self.agent_id
        if extra:
            h.update(extra)
        return h

    def _request(self, method: str, path: str, data: dict = None):
        url = self.base + path
        body = json.dumps(data).encode() if data else None
        req = urllib.request.Request(
            url, data=body, method=method,
            headers=self._headers(),
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                if resp.status == 204:
                    return None
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 204:
                return None
            try:
                err = json.loads(e.read().decode())
            except Exception:
                err = {"error": f"HTTP {e.code}"}
            raise GatewayError(err.get("error", str(err)), e.code)
        except urllib.error.URLError as e:
            raise GatewayError(f"connection failed: {e.reason}")

    def register(self, agent_id: str, agent_type: str = "python"):
        """Register agent, get unique token."""
        resp = self._request("POST", "/v1/agent/register", {
            "agent_id": agent_id, "agent_type": agent_type,
        })
        self.agent_id = agent_id
        self.agent_token = resp.get("agent_token")
        return resp

    def poll(self, agent_id: str):
        """Poll for a task. Returns task dict or None."""
        return self._request("POST", "/v1/agent/poll", {"agent_id": agent_id})

    def report_result(self, task_id: int, result: dict = None, error: str = None):
        """Report task completion."""
        data = {"task_id": task_id}
        if error:
            data["error"] = error
        else:
            data["result"] = result or {}
        return self._request("POST", "/v1/agent/result", data)

    def heartbeat(self, agent_id: str, mcp_tools: list = None, agent_type: str = "python"):
        """Send heartbeat to indicate aliveness."""
        return self._request("POST", "/v1/agent/heartbeat", {
            "agent_id": agent_id,
            "mcp_tools": mcp_tools or [],
            "agent_type": agent_type,
        })

    def list_agents(self):
        """List active agents."""
        return self._request("GET", "/v1/agents")

    def submit(self, task_type: str, payload: dict, idempotency_key: str = None):
        """Submit a new task (optional, for agents that create work)."""
        headers_extra = {}
        # Note: idempotency via header not supported in this minimal client
        return self._request("POST", "/v1/tasks", {
            "type": task_type, "payload": payload,
        })

    def get_task(self, task_id: int):
        """Get task status."""
        return self._request("GET", f"/v1/tasks/{task_id}")
