import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RegistryTask, WorkerHandler } from "../../document-bun/src/registry";

export const MAX_REMOTE_INPUT_BYTES = 256 * 1024;
export const MAX_REMOTE_RESPONSE_BYTES = 256 * 1024;

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface RemoteAgentInvocation {
  input: unknown;
  request_id?: string;
}

export interface RemoteAgentConfig {
  endpoint: string;
  providerId: string;
  bearerToken?: string;
  timeoutMs: number;
}

export interface RemoteAgentResult {
  schema_version: 1;
  task_id: number;
  provider_id: string;
  request_id?: string;
  result: unknown;
  meta?: Record<string, unknown>;
}

export class RemoteAgentPayloadError extends Error {
  readonly code = "invalid_payload";
}

export class RemoteAgentCallError extends Error {
  readonly code = "processing_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeRemoteEndpoint(raw: string): string {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "[::1]" ||
    host === "::1";

  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("REMOTE_AGENT_ENDPOINT must use https, or http on loopback only");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("REMOTE_AGENT_ENDPOINT must not contain credentials, query, or fragment");
  }

  return url.toString();
}

export function validateRemoteAgentConfig(config: RemoteAgentConfig): RemoteAgentConfig {
  const endpoint = normalizeRemoteEndpoint(config.endpoint);
  if (!SAFE_ID.test(config.providerId)) {
    throw new Error("REMOTE_AGENT_PROVIDER_ID must be a safe 1-128 character identifier");
  }
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 300_000) {
    throw new Error("REMOTE_AGENT_REQUEST_TIMEOUT_MS must be between 100 and 300000");
  }
  if (
    config.bearerToken !== undefined &&
    (config.bearerToken.length === 0 ||
      config.bearerToken.length > 4096 ||
      /[\r\n]/.test(config.bearerToken))
  ) {
    throw new Error("REMOTE_AGENT_BEARER_TOKEN is invalid");
  }

  return { ...config, endpoint };
}

export function parseRemoteAgentInvocation(raw: string): RemoteAgentInvocation {
  if (new TextEncoder().encode(raw).byteLength > MAX_REMOTE_INPUT_BYTES) {
    throw new RemoteAgentPayloadError("remote agent payload exceeds 256 KiB");
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RemoteAgentPayloadError("payload must be valid JSON");
  }
  if (!isRecord(value)) {
    throw new RemoteAgentPayloadError("payload must be a JSON object");
  }

  for (const key of Object.keys(value)) {
    if (key !== "input" && key !== "request_id") {
      throw new RemoteAgentPayloadError(`unsupported payload field: ${key}`);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(value, "input")) {
    throw new RemoteAgentPayloadError("payload.input is required");
  }
  if (
    value.request_id !== undefined &&
    (typeof value.request_id !== "string" || !SAFE_ID.test(value.request_id))
  ) {
    throw new RemoteAgentPayloadError("payload.request_id must be a safe 1-128 character identifier");
  }

  return {
    input: value.input,
    ...(typeof value.request_id === "string" ? { request_id: value.request_id } : {}),
  };
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new RemoteAgentCallError("remote agent response must be application/json");
  }
  if (response.body === null) {
    throw new RemoteAgentCallError("remote agent response body is missing");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REMOTE_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RemoteAgentCallError("remote agent response exceeds 256 KiB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RemoteAgentCallError("remote agent response is not valid UTF-8");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RemoteAgentCallError("remote agent response is not valid JSON");
  }
  if (!isRecord(value)) {
    throw new RemoteAgentCallError("remote agent response must be a JSON object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "result" && key !== "meta") {
      throw new RemoteAgentCallError(`unsupported remote response field: ${key}`);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(value, "result")) {
    throw new RemoteAgentCallError("remote agent response.result is required");
  }
  if (value.meta !== undefined && !isRecord(value.meta)) {
    throw new RemoteAgentCallError("remote agent response.meta must be a JSON object");
  }

  return value;
}

export async function invokeRemoteAgent(
  taskId: number,
  rawPayload: string,
  rawConfig: RemoteAgentConfig,
): Promise<RemoteAgentResult> {
  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    throw new Error("task id must be a positive safe integer");
  }
  const invocation = parseRemoteAgentInvocation(rawPayload);
  const config = validateRemoteAgentConfig(rawConfig);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Idempotency-Key": `task-queue-${taskId}`,
    "X-Task-Queue-Task-Id": String(taskId),
  };
  if (config.bearerToken !== undefined) {
    headers.Authorization = `Bearer ${config.bearerToken}`;
  }

  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      redirect: "error",
      headers,
      body: JSON.stringify({
        schema_version: 1,
        task_id: taskId,
        ...(invocation.request_id !== undefined ? { request_id: invocation.request_id } : {}),
        input: invocation.input,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new RemoteAgentCallError(`remote agent returned HTTP ${response.status}`);
    }

    const remote = await readBoundedJson(response);
    return {
      schema_version: 1,
      task_id: taskId,
      provider_id: config.providerId,
      ...(invocation.request_id !== undefined ? { request_id: invocation.request_id } : {}),
      result: remote.result,
      ...(remote.meta !== undefined ? { meta: remote.meta as Record<string, unknown> } : {}),
    };
  } catch (error) {
    if (error instanceof RemoteAgentCallError) {
      throw error;
    }
    throw new RemoteAgentCallError(
      `remote agent request failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function writeRemoteAgentResultAtomic(
  outputDir: string,
  result: RemoteAgentResult,
): Promise<string> {
  if (outputDir.length === 0 || outputDir.includes("\0")) {
    throw new Error("output directory is invalid");
  }

  await mkdir(outputDir, { recursive: true });
  const finalPath = join(outputDir, `task-${result.task_id}.json`);
  const tempPath = join(outputDir, `.task-${result.task_id}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(result)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return finalPath;
}

export function createRemoteAgentHandler(config: RemoteAgentConfig): WorkerHandler {
  const validated = validateRemoteAgentConfig(config);
  return {
    taskName: "agent.invoke",
    taskType: "remote-agent",

    async handle(task: RegistryTask, context) {
      const result = await invokeRemoteAgent(task.task_id, task.payload, validated);
      await writeRemoteAgentResultAtomic(context.outputDir, result);
    },

    classifyError(error) {
      return error instanceof RemoteAgentPayloadError ? "invalid_payload" : "processing_failed";
    },
  };
}
