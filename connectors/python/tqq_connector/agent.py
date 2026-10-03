"""Polling agent: poll HP -> execute via MCP -> report results."""
import time
import traceback

from .mcp import MCPClient, MCPError
from .protocol import GatewayClient, GatewayError


class Agent:
    """
    A polling agent that fetches work from Task-que-que and executes
    it using local MCP tools.

    Example:
        agent = Agent(
            gateway_url="https://xxx.trycloudflare.com",
            token="...",
            agent_id="my-agent",
            mcp_url="http://127.0.0.1:18090/",
        )
        agent.serve()
    """

    def __init__(
        self,
        gateway_url: str,
        token: str,
        agent_id: str,
        mcp_url: str,
        poll_interval: float = 2.0,
        max_backoff: float = 60.0,
        heartbeat_interval: float = 30.0,
    ):
        self.agent_id = agent_id
        self.gateway = GatewayClient(gateway_url, token)
        self.mcp = MCPClient(mcp_url)
        self.poll_interval = poll_interval
        self.max_backoff = max_backoff
        self.heartbeat_interval = heartbeat_interval
        self._backoff = poll_interval
        self._running = False
        self._last_heartbeat = 0
        self._mcp_tools = []

    def log(self, msg: str):
        print(f"[{self.agent_id}] {msg}", flush=True)

    def execute_task(self, task: dict):
        """Execute a single task, return result dict."""
        task_type = task.get("type")
        payload = task.get("payload_json")
        if isinstance(payload, str):
            import json
            payload = json.loads(payload)

        if task_type == "workflow.run":
            return self._execute_workflow(payload)
        elif task_type == "agent.invoke":
            return self._execute_invoke(payload)
        else:
            raise ValueError(f"unsupported task type: {task_type}")

    def _execute_workflow(self, payload: dict) -> dict:
        steps = payload.get("steps", [])
        if not isinstance(steps, list):
            raise ValueError("steps must be a list")
        results = []
        for i, step in enumerate(steps):
            # Only execute steps for this agent
            if step.get("agent") != self.agent_id:
                results.append({"step": i, "skipped": True})
                continue
            tool = step.get("tool")
            args = step.get("arguments", {})
            self.log(f"step {i}: {tool}({args})")
            mcp_result = self.mcp.call_tool(tool, args)
            results.append({
                "step": i, "agent": self.agent_id,
                "tool": tool, "mcp_result": mcp_result,
            })
        return {"steps_completed": len(results), "results": results}

    def _execute_invoke(self, payload: dict) -> dict:
        if payload.get("agent") != self.agent_id:
            raise ValueError("task not for this agent")
        tool = payload.get("tool")
        args = payload.get("arguments", {})
        self.log(f"invoke: {tool}({args})")
        mcp_result = self.mcp.call_tool(tool, args)
        return {"agent": self.agent_id, "tool": tool, "mcp_result": mcp_result}

    def _poll_once(self) -> bool:
        """Single poll cycle. Returns True if a task was processed."""
        try:
            resp = self.gateway.poll(self.agent_id)
        except GatewayError as e:
            self.log(f"poll failed: {e} (backoff {self._backoff:.0f}s)")
            time.sleep(self._backoff)
            self._backoff = min(self._backoff * 2, self.max_backoff)
            return False

        # Reset backoff on successful poll
        self._backoff = self.poll_interval

        task = (resp or {}).get("task")
        if not task:
            return False

        task_id = task["id"]
        self.log(f"claimed task {task_id} ({task.get('type')})")
        try:
            result = self.execute_task(task)
            self.gateway.report_result(task_id, result=result)
            self.log(f"task {task_id} COMPLETED")
        except Exception as e:
            err = f"{type(e).__name__}: {e}"
            self.log(f"task {task_id} FAILED: {err}")
            traceback.print_exc()
            try:
                self.gateway.report_result(task_id, error=err)
            except Exception as e2:
                self.log(f"failed to report error: {e2}")
        return True

    def _maybe_heartbeat(self):
        """Send heartbeat if interval elapsed."""
        import time
        now = time.time()
        if now - self._last_heartbeat >= self.heartbeat_interval:
            try:
                self.gateway.heartbeat(
                    self.agent_id,
                    mcp_tools=self._mcp_tools,
                    agent_type="python",
                )
                self._last_heartbeat = now
            except Exception as e:
                self.log(f"heartbeat failed: {e}")

    def serve(self):
        """Main loop: poll -> execute -> report, forever."""
        self._running = True
        self.log(f"starting, gateway={self.gateway.base}")
        # Register agent, get token
        try:
            reg = self.gateway.register(self.agent_id, agent_type="python")
            self.log(f"registered, token OK")
        except GatewayError as e:
            self.log(f"registration failed: {e}")
            return
        # Verify MCP connection and cache tools
        try:
            tools = self.mcp.list_tools()
            self._mcp_tools = [t["name"] for t in tools]
            self.log(f"MCP connected, tools: {self._mcp_tools}")
        except MCPError as e:
            self.log(f"WARNING: MCP not reachable: {e}")
        # Initial heartbeat
        self._maybe_heartbeat()
        self._last_heartbeat = __import__("time").time()
        while self._running:
            try:
                self._maybe_heartbeat()
                had_task = self._poll_once()
                if not had_task:
                    time.sleep(self.poll_interval)
            except KeyboardInterrupt:
                self.log("stopping...")
                break
            except Exception as e:
                self.log(f"unexpected error: {e}")
                traceback.print_exc()
                time.sleep(self._backoff)

    def stop(self):
        self._running = False
