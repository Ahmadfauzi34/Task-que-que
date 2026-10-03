"""
TQQ Connector: Python client library for Task-que-que polling agents.

Usage:
    from tqq_connector import Agent

    agent = Agent(
        gateway_url="https://<tunnel>",
        token="<capability-token>",
        agent_id="my-agent",
        mcp_url="http://127.0.0.1:18090/",
    )
    agent.serve()  # poll -> execute -> report, forever
"""

from .agent import Agent
from .mcp import MCPClient
from .protocol import GatewayClient

__version__ = "0.1.0"
__all__ = ["Agent", "MCPClient", "GatewayClient"]
