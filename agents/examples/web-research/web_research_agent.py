#!/usr/bin/env python3
"""
Web Research Agent - Contoh agen Jenis 2 yang nyata.

Agen ini:
1. Register ke HP (Task-que-que gateway)
2. Poll untuk task bertipe workflow.run / agent.invoke
3. Eksekusi via MCP server lokal (web_mcp_server.py)
4. Lapor hasil ke HP

Jalankan:
  1. Start MCP server: python3 web_mcp_server.py 18091
  2. Start agent: python3 web_research_agent.py

Environment variables:
  TQQ_GATEWAY  - URL gateway HP (default: http://localhost:3100)
  TQQ_AGENT_ID - ID agen (default: web-research-1)
  TQQ_MCP_URL  - URL MCP server lokal (default: http://127.0.0.1:18091)
"""
import os
import sys

# Tambah path ke tqq-connector (atau pip install tqq-connector)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tqq-connector'))

from tqq_connector import Agent

GATEWAY = os.environ.get("TQQ_GATEWAY", "http://localhost:3100")
AGENT_ID = os.environ.get("TQQ_AGENT_ID", "web-research-1")
MCP_URL = os.environ.get("TQQ_MCP_URL", "http://127.0.0.1:18091")

if __name__ == "__main__":
    print(f"Web Research Agent '{AGENT_ID}'", flush=True)
    print(f"  Gateway: {GATEWAY}", flush=True)
    print(f"  MCP: {MCP_URL}", flush=True)
    print(f"  Tools: fetch_url, extract_text", flush=True)
    print("", flush=True)

    agent = Agent(
        gateway_url=GATEWAY,
        agent_id=AGENT_ID,
        mcp_url=MCP_URL,
    )
    agent.serve()
