#!/usr/bin/env python3
"""
Code Runner Agent - Contoh agen Jenis 2 untuk komputasi.

Agen ini:
1. Register ke HP (Task-que-que gateway)
2. Poll untuk task bertipe workflow.run / agent.invoke
3. Eksekusi kode via MCP server lokal (code_mcp_server.py)
4. Lapor hasil ke HP

Jalankan:
  1. Start MCP server: python3 code_mcp_server.py 18092
  2. Start agent: python3 code_runner_agent.py

Environment variables:
  TQQ_GATEWAY  - URL gateway HP (default: http://localhost:3100)
  TQQ_AGENT_ID - ID agen (default: code-runner-1)
  TQQ_MCP_URL  - URL MCP server lokal (default: http://127.0.0.1:18092)
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tqq-connector'))

from tqq_connector import Agent

GATEWAY = os.environ.get("TQQ_GATEWAY", "http://localhost:3100")
AGENT_ID = os.environ.get("TQQ_AGENT_ID", "code-runner-1")
MCP_URL = os.environ.get("TQQ_MCP_URL", "http://127.0.0.1:18092")

if __name__ == "__main__":
    print(f"Code Runner Agent '{AGENT_ID}'", flush=True)
    print(f"  Gateway: {GATEWAY}", flush=True)
    print(f"  MCP: {MCP_URL}", flush=True)
    print(f"  Tools: run_python, run_javascript", flush=True)
    print("  WARNING: executes arbitrary code", flush=True)
    print("", flush=True)

    agent = Agent(
        gateway_url=GATEWAY,
        agent_id=AGENT_ID,
        mcp_url=MCP_URL,
    )
    agent.serve()
