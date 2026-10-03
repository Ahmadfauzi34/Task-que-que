/**
 * Worker handlers: implementasi 5 operasi terdaftar Task-que-que.
 *
 * Setiap handler: (payload) => Promise<result>.
 * Payload sudah di-parse dari JSON oleh template worker.
 */

import { registerHandler } from "./worker.ts";

// ---------------------------------------------------------------------------
// 1. hash.compute — SHA-256 hex dari input string
//    payload: { input: string } atau string langsung
// ---------------------------------------------------------------------------

registerHandler("hash.compute", async (payload) => {
  const input =
    typeof payload === "string"
      ? payload
      : (payload as Record<string, unknown>)?.input;

  if (typeof input !== "string") {
    throw new Error("invalid_payload: input must be a string");
  }

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return {
    algorithm: "sha256",
    input_length: input.length,
    digest_hex: hex,
  };
});

// ---------------------------------------------------------------------------
// 2. vector.dot — dot product dua vektor
//    payload: { a: number[], b: number[] }
// ---------------------------------------------------------------------------

registerHandler("vector.dot", async (payload) => {
  const p = payload as Record<string, unknown>;
  const a = p?.a;
  const b = p?.b;

  if (!Array.isArray(a) || !Array.isArray(b)) {
    throw new Error("invalid_payload: a and b must be arrays");
  }
  if (a.length !== b.length) {
    throw new Error("invalid_payload: vector length mismatch");
  }
  if (a.length === 0) {
    throw new Error("invalid_payload: vectors must not be empty");
  }
  if (!a.every((x) => typeof x === "number") || !b.every((x) => typeof x === "number")) {
    throw new Error("invalid_payload: vectors must contain only numbers");
  }

  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number);
  }

  return { dimension: a.length, dot };
});

// ---------------------------------------------------------------------------
// 3. document.process — transformasi dokumen teks deterministik
//    payload: { text: string, operations: string[] }
//    operations: "word_count" | "line_count" | "uppercase" | "word_frequency"
//    (v1: statistik + transformasi sederhana; NLP berat = fase berikut)
// ---------------------------------------------------------------------------

registerHandler("document.process", async (payload) => {
  const p = payload as Record<string, unknown>;
  const text = p?.text;
  const operations = p?.operations;

  if (typeof text !== "string") {
    throw new Error("invalid_payload: text must be a string");
  }
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error("invalid_payload: operations must be a non-empty array");
  }

  const words = text.split(/\s+/).filter(Boolean);
  const lines = text.split("\n");
  const result: Record<string, unknown> = {};

  for (const op of operations) {
    switch (op) {
      case "word_count":
        result.word_count = words.length;
        break;
      case "line_count":
        result.line_count = lines.length;
        break;
      case "char_count":
        result.char_count = text.length;
        break;
      case "uppercase":
        result.uppercase = text.toUpperCase();
        break;
      case "word_frequency": {
        const freq: Record<string, number> = {};
        for (const w of words) {
          const key = w.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (key) freq[key] = (freq[key] ?? 0) + 1;
        }
        const top = Object.entries(freq)
          .sort((x, y) => y[1] - x[1])
          .slice(0, 20);
        result.word_frequency = Object.fromEntries(top);
        break;
      }
      default:
        throw new Error(`unsupported_operation: ${op}`);
    }
  }

  return result;
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 4. agent.invoke — panggil tool di MCP server agen remote
//    payload: { agent: string, tool: string, arguments?: object }
//    v1: agen didefinisikan via env TQQ_AGENTS_JSON
//        {"nama-agen": "http://host:port/mcp"}
//    Protokol: MCP Streamable HTTP (JSON-RPC): initialize -> tools/call
// ---------------------------------------------------------------------------

registerHandler("agent.invoke", async (payload) => {
  const p = payload as Record<string, unknown>;
  const agent = p?.agent;
  const tool = p?.tool;

  if (typeof agent !== "string" || typeof tool !== "string") {
    throw new Error("invalid_payload: agent and tool must be strings");
  }

  const agentsJson = process.env.TQQ_AGENTS_JSON ?? "{}";
  let agents: Record<string, string>;
  try {
    agents = JSON.parse(agentsJson);
  } catch {
    throw new Error("misconfigured: TQQ_AGENTS_JSON is not valid JSON");
  }

  const mcpUrl = agents[agent];
  if (!mcpUrl) {
    throw new Error("unknown_agent: " + agent);
  }

  const rpc = async (method: string, params: unknown, id: number | null) => {
    const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
    if (id !== null) body.id = id;
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error("mcp_http_" + res.status);
    const text = await res.text();
    let dataText = text;
    if (text.startsWith("event:")) {
      const m = text.match(/^data: (.+)$/m);
      if (m) dataText = m[1];
    }
    return JSON.parse(dataText);
  };

  const initRes = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "tqq-worker", version: "0.2.1" },
  }, 1);
  if (initRes.error) throw new Error("mcp_init_failed");

  await rpc("notifications/initialized", {}, null).catch(() => {});

  const callRes = await rpc("tools/call", {
    name: tool,
    arguments: (p?.arguments ?? {}) as object,
  }, 2);
  if (callRes.error) throw new Error("mcp_tool_error: " + JSON.stringify(callRes.error));

  return { agent, tool, mcp_result: callRes.result };
});


// ---------------------------------------------------------------------------
// 5. workflow.run — orkestrasi MCP tool calls ke agen-agen remote
//    payload: { steps: [{ agent: string, tool: string, arguments?: object }] }
//    Setiap step = satu MCP tools/call ke MCP server agen yang dituju.
//    Agen didefinisikan via env TQQ_AGENTS_JSON: {"nama-agen": "http://host/mcp"}
//    Handler ini adalah "custom konektor": MCP client yang bicara ke
//    custom MCP server di environment masing-masing agen.
// ---------------------------------------------------------------------------

registerHandler("workflow.run", async (payload) => {
  const p = payload as Record<string, unknown>;
  const steps = p?.steps;

  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("invalid_payload: steps must be a non-empty array");
  }
  if (steps.length > 16) {
    throw new Error("invalid_payload: max 16 steps per workflow");
  }

  const agentsJson = process.env.TQQ_AGENTS_JSON ?? "{}";
  let agents: Record<string, string>;
  try {
    agents = JSON.parse(agentsJson);
  } catch {
    throw new Error("misconfigured: TQQ_AGENTS_JSON is not valid JSON");
  }

  // MCP client (custom konektor)
  const mcpCall = async (
    mcpUrl: string,
    tool: string,
    args: object,
  ): Promise<unknown> => {
    const rpc = async (method: string, params: unknown, id: number | null) => {
      const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
      if (id !== null) body.id = id;
      const res = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error("mcp_http_" + res.status);
      const text = await res.text();
      let dataText = text;
      if (text.startsWith("event:")) {
        const m = text.match(/^data: (.+)$/m);
        if (m) dataText = m[1];
      }
      return JSON.parse(dataText);
    };

    const initRes = await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "tqq-workflow", version: "0.2.1" },
    }, 1);
    if (initRes.error) throw new Error("mcp_init_failed");
    await rpc("notifications/initialized", {}, null).catch(() => {});
    const callRes = await rpc("tools/call", {
      name: tool,
      arguments: args,
    }, 2);
    if (callRes.error) {
      throw new Error("mcp_tool_error: " + JSON.stringify(callRes.error));
    }
    return callRes.result;
  };

  const results: unknown[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] as Record<string, unknown>;
    const agent = step?.agent;
    const tool = step?.tool;
    if (typeof agent !== "string" || typeof tool !== "string") {
      throw new Error(`invalid_step ${i}: agent and tool must be strings`);
    }
    const mcpUrl = agents[agent];
    if (!mcpUrl) {
      throw new Error(`unknown_agent at step ${i}: ${agent}`);
    }

    const mcpResult = await mcpCall(
      mcpUrl,
      tool,
      (step?.arguments ?? {}) as object,
    );
    results.push({ step: i, agent, tool, mcp_result: mcpResult });
  }

  return { steps_completed: results.length, results };
});

