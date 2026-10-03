/**
 * MCP client untuk komunikasi dengan MCP server lokal.
 * Mengikuti protocol MCP: initialize -> tools/call.
 */

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: any;
}

export class MCPError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MCPError";
  }
}

export class MCPClient {
  private baseUrl: string;
  private timeout: number;

  constructor(mcpUrl: string, timeout: number = 30000) {
    this.baseUrl = mcpUrl.replace(/\/$/, "");
    this.timeout = timeout;
  }

  private async request(method: string, params: any = {}, id: number = 1): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const resp = await fetch(this.baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new MCPError(`MCP HTTP ${resp.status}`);
      }

      const data = await resp.json();
      if (data.error) {
        throw new MCPError(`MCP error: ${JSON.stringify(data.error)}`);
      }
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "tqq-connector-js", version: "0.1.0" },
    });
    // Kirim notification (tidak perlu tunggu respons)
    await this.request("notifications/initialized", {}, 999).catch(() => {});
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.request("tools/list", {}, 2);
    return result.tools || [];
  }

  async callTool(name: string, args: any = {}): Promise<string> {
    const result = await this.request("tools/call", {
      name,
      arguments: args,
    }, 3);

    if (result.isError) {
      const text = result.content?.[0]?.text || "Unknown MCP error";
      throw new MCPError(text);
    }

    // Gabungkan semua content text
    const texts = (result.content || [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text);
    return texts.join("\n");
  }
}
