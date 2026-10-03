/**
 * Polling agent: poll HP -> eksekusi via MCP -> lapor hasil.
 *
 * Contoh:
 *   const agent = new Agent({
 *     gatewayUrl: "http://localhost:3100",
 *     agentId: "my-agent",
 *     mcpUrl: "http://127.0.0.1:18090",
 *   });
 *   await agent.serve();
 */

import { MCPClient } from "./mcp.js";
import { GatewayClient, GatewayError } from "./protocol.js";

export interface AgentOptions {
  gatewayUrl: string;
  agentId: string;
  mcpUrl: string;
  pollTimeout?: number;
  heartbeatInterval?: number;
}

export class Agent {
  private gateway: GatewayClient;
  private mcp: MCPClient;
  private agentId: string;
  private pollTimeout: number;
  private heartbeatInterval: number;
  private running: boolean = false;
  private tools: string[] = [];

  constructor(opts: AgentOptions) {
    this.agentId = opts.agentId;
    this.gateway = new GatewayClient(opts.gatewayUrl, opts.agentId);
    this.mcp = new MCPClient(opts.mcpUrl);
    this.pollTimeout = opts.pollTimeout || 30;
    this.heartbeatInterval = opts.heartbeatInterval || 30000;
  }

  private log(msg: string): void {
    console.log(`[${this.agentId}] ${msg}`);
  }

  async start(): Promise<void> {
    // 1. Initialize MCP
    this.log("Initializing MCP...");
    await this.mcp.initialize();
    const tools = await this.mcp.listTools();
    this.tools = tools.map((t) => t.name);
    this.log(`MCP tools: ${this.tools.join(", ")}`);

    // 2. Register ke gateway
    this.log("Registering to gateway...");
    const token = await this.gateway.register(this.tools);
    this.log(`Registered (token: ${token.slice(0, 8)}...)`);

    this.running = true;

    // 3. Heartbeat loop
    const hb = setInterval(() => {
      if (this.running) this.gateway.heartbeat(this.tools);
    }, this.heartbeatInterval);

    // 4. Poll loop
    this.log("Polling for tasks...");
    while (this.running) {
      try {
        const task = await this.gateway.poll(this.pollTimeout);
        if (task) {
          await this.executeTask(task);
        }
      } catch (e) {
        if (e instanceof GatewayError && e.status === 401) {
          this.log("Token invalid, re-registering...");
          await this.gateway.register(this.tools);
        } else {
          this.log(`Poll error: ${e}, retrying...`);
          await this.sleep(5000);
        }
      }
    }

    clearInterval(hb);
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async serve(): Promise<void> {
    // Handle SIGINT/SIGTERM
    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());
    await this.start();
  }

  private async executeTask(task: any): Promise<void> {
    const taskId = task.task_id;
    const type = task.type;
    const payload = task.payload || {};

    this.log(`Executing task ${taskId} (${type})`);

    try {
      let result: any;

      if (type === "agent.invoke") {
        result = await this.executeInvoke(payload);
      } else if (type === "workflow.run") {
        result = await this.executeWorkflow(payload);
      } else {
        throw new Error(`Unknown task type: ${type}`);
      }

      await this.gateway.submitResult(taskId, result);
      this.log(`Task ${taskId} completed`);
    } catch (e) {
      this.log(`Task ${taskId} failed: ${e}`);
      await this.gateway.submitResult(taskId, {
        error: String(e),
      }).catch(() => {});
    }
  }

  private async executeInvoke(payload: any): Promise<any> {
    // Verifikasi: hanya untuk agen ini
    if (payload.agent !== this.agentId) {
      throw new Error("Task not for this agent");
    }

    const mcpResult = await this.mcp.callTool(
      payload.tool,
      payload.arguments || {}
    );

    return {
      agent: this.agentId,
      tool: payload.tool,
      mcp_result: mcpResult,
    };
  }

  private async executeWorkflow(payload: any): Promise<any> {
    const steps = payload.steps || [];
    const results: any[] = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      // Hanya eksekusi step untuk agen ini
      if (step.agent !== this.agentId) {
        results.push({ step: i, skipped: true, reason: "not for this agent" });
        continue;
      }

      const mcpResult = await this.mcp.callTool(
        step.tool,
        step.arguments || {}
      );

      results.push({
        step: i,
        agent: step.agent,
        tool: step.tool,
        mcp_result: mcpResult,
      });
    }

    return {
      steps_completed: results.filter((r) => !r.skipped).length,
      results,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export { MCPClient, MCPError } from "./mcp.js";
export { GatewayClient, GatewayError } from "./protocol.js";
