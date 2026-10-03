"""Contoh agen sederhana."""
import os
from tqq_connector import Agent

agent = Agent(
    gateway_url=os.environ["TQQ_GATEWAY_URL"],
    token=os.environ["TQQ_GATEWAY_TOKEN"],
    agent_id=os.environ.get("TQQ_AGENT_ID", "python-agent"),
    mcp_url=os.environ.get("TQQ_MCP_URL", "http://127.0.0.1:18090/"),
)
agent.serve()
