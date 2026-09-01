import { WorkerHandlerRegistry } from "../../document-bun/src/registry";
import { runWorker, type WorkerConfig } from "../../document-bun/src/worker";
import {
  createRemoteAgentHandler,
  normalizeRemoteEndpoint,
  type RemoteAgentConfig,
} from "./remote-handler";

export interface RemoteAgentWorkerConfig extends WorkerConfig {
  remote: RemoteAgentConfig;
}

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function normalizeBrokerOrigin(raw: string): string {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "[::1]" ||
    host === "::1";

  if (url.protocol !== "http:" || !loopback) {
    throw new Error("REMOTE_AGENT_WORKER_ORIGIN must be a loopback http origin");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("REMOTE_AGENT_WORKER_ORIGIN must contain only scheme, host, and port");
  }
  return url.origin;
}

export function loadRemoteAgentWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): RemoteAgentWorkerConfig {
  const workerId = env.REMOTE_AGENT_WORKER_ID ?? "remote-agent-reference-worker";
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(workerId)) {
    throw new Error("REMOTE_AGENT_WORKER_ID must be a safe 1-128 character identifier");
  }

  const outputDir = env.REMOTE_AGENT_OUTPUT_DIR ?? "./var/remote-agent-results";
  if (outputDir.length === 0 || outputDir.includes("\0")) {
    throw new Error("REMOTE_AGENT_OUTPUT_DIR is invalid");
  }

  const providerId = env.REMOTE_AGENT_PROVIDER_ID ?? "reference-agent";
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(providerId)) {
    throw new Error("REMOTE_AGENT_PROVIDER_ID must be a safe 1-128 character identifier");
  }

  const remote: RemoteAgentConfig = {
    endpoint: normalizeRemoteEndpoint(
      env.REMOTE_AGENT_ENDPOINT ?? "http://127.0.0.1:7440/invoke",
    ),
    providerId,
    ...(env.REMOTE_AGENT_BEARER_TOKEN !== undefined
      ? { bearerToken: env.REMOTE_AGENT_BEARER_TOKEN }
      : {}),
    timeoutMs: positiveInteger(
      env.REMOTE_AGENT_REQUEST_TIMEOUT_MS,
      30_000,
      "REMOTE_AGENT_REQUEST_TIMEOUT_MS",
      100,
      300_000,
    ),
  };

  return {
    origin: normalizeBrokerOrigin(
      env.REMOTE_AGENT_WORKER_ORIGIN ?? "http://127.0.0.1:7332",
    ),
    workerId,
    outputDir,
    capacity: positiveInteger(
      env.REMOTE_AGENT_WORKER_CAPACITY,
      1,
      "REMOTE_AGENT_WORKER_CAPACITY",
      1,
      64,
    ),
    pollMs: positiveInteger(
      env.REMOTE_AGENT_WORKER_POLL_MS,
      250,
      "REMOTE_AGENT_WORKER_POLL_MS",
      1,
      60_000,
    ),
    processDelayMs: 0,
    requestTimeoutMs: positiveInteger(
      env.REMOTE_AGENT_BROKER_TIMEOUT_MS,
      5_000,
      "REMOTE_AGENT_BROKER_TIMEOUT_MS",
      100,
      60_000,
    ),
    remote,
  };
}

export function createRemoteAgentWorkerRegistry(
  config: RemoteAgentConfig,
): WorkerHandlerRegistry {
  return new WorkerHandlerRegistry("remote-agent", [createRemoteAgentHandler(config)]);
}

if (import.meta.main) {
  const config = loadRemoteAgentWorkerConfig();
  const registry = createRemoteAgentWorkerRegistry(config.remote);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  runWorker(config, controller.signal, registry).catch((error) => {
    console.error(
      `reference remote agent worker fatal: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
}
