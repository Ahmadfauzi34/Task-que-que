/**
 * HTTP client untuk Task-que-que gateway.
 * Menangani: register, poll, result, heartbeat.
 */

export class GatewayError extends Error {
  status: number;
  constructor(message: string, status: number = 0) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
  }
}

export interface TaskPayload {
  type: string;
  payload: any;
  task_id: string;
  lease_expires_at?: string;
}

export class GatewayClient {
  private baseUrl: string;
  private agentId: string;
  private token: string | null = null;

  constructor(gatewayUrl: string, agentId: string) {
    this.baseUrl = gatewayUrl.replace(/\/$/, "");
    this.agentId = agentId;
  }

  private async request(
    method: string,
    path: string,
    body?: any,
    useAuth: boolean = true
  ): Promise<any> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (useAuth && this.token) {
      headers["X-Agent-Token"] = this.token;
    }

    const resp = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (resp.status === 401) {
      throw new GatewayError("Invalid agent token", 401);
    }
    if (resp.status === 204) {
      return null; // No content (poll kosong)
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new GatewayError(`Gateway HTTP ${resp.status}: ${text}`, resp.status);
    }

    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  }

  async register(tools: string[]): Promise<string> {
    const result = await this.request("POST", "/v1/agent/register", {
      agent_id: this.agentId,
      tools,
    }, false);
    this.token = result.token;
    return this.token!;
  }

  async poll(timeoutSec: number = 30): Promise<TaskPayload | null> {
    return await this.request(
      "GET",
      `/v1/agent/poll?agent_id=${encodeURIComponent(this.agentId)}&timeout=${timeoutSec}`
    );
  }

  async submitResult(taskId: string, result: any): Promise<void> {
    await this.request("POST", "/v1/agent/result", {
      task_id: taskId,
      agent_id: this.agentId,
      result,
    });
  }

  async heartbeat(tools: string[]): Promise<void> {
    await this.request("POST", "/v1/agent/heartbeat", {
      agent_id: this.agentId,
      tools,
    }).catch(() => {
      // Heartbeat gagal tidak fatal
    });
  }

  getToken(): string | null {
    return this.token;
  }
}
