export interface GatewayConfig {
  hostname: string;
  port: number;
  queueDaemonOrigin: string;
  apiToken: string | null;
  allowUnauthenticated: boolean;
  upstreamTimeoutMs: number;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const DEFAULT_QUEUE_DAEMON = "http://127.0.0.1:7331";
const DEFAULT_UPSTREAM_TIMEOUT_MS = 3_000;

function parseBoundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }

  return value;
}

function assertLoopbackHostname(hostname: string, name: string): void {
  if (hostname !== "127.0.0.1" && hostname !== "::1") {
    throw new Error(`${name} must be a numeric loopback address (127.0.0.1 or ::1)`);
  }
}

function parseQueueDaemonOrigin(raw: string): string {
  const url = new URL(raw);

  if (url.protocol !== "http:") {
    throw new Error("QUEUE_DAEMON_URL must use plain HTTP on loopback");
  }
  assertLoopbackHostname(url.hostname, "QUEUE_DAEMON_URL hostname");
  if (url.username || url.password) {
    throw new Error("QUEUE_DAEMON_URL must not contain credentials");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("QUEUE_DAEMON_URL must be an origin without path, query, or fragment");
  }

  return url.origin;
}

export function loadGatewayConfig(
  env: Record<string, string | undefined> = process.env,
): GatewayConfig {
  const hostname = env.GATEWAY_HOST?.trim() || DEFAULT_HOST;
  assertLoopbackHostname(hostname, "GATEWAY_HOST");

  const port = parseBoundedInteger(env.GATEWAY_PORT, DEFAULT_PORT, 1, 65_535, "GATEWAY_PORT");
  const upstreamTimeoutMs = parseBoundedInteger(
    env.GATEWAY_UPSTREAM_TIMEOUT_MS,
    DEFAULT_UPSTREAM_TIMEOUT_MS,
    100,
    30_000,
    "GATEWAY_UPSTREAM_TIMEOUT_MS",
  );

  const allowUnauthenticated = env.GATEWAY_ALLOW_UNAUTHENTICATED === "1";
  const apiToken = env.GATEWAY_API_TOKEN?.trim() || null;

  if (!apiToken && !allowUnauthenticated) {
    throw new Error(
      "GATEWAY_API_TOKEN is required unless GATEWAY_ALLOW_UNAUTHENTICATED=1 is set explicitly",
    );
  }

  return {
    hostname,
    port,
    queueDaemonOrigin: parseQueueDaemonOrigin(
      env.QUEUE_DAEMON_URL?.trim() || DEFAULT_QUEUE_DAEMON,
    ),
    apiToken,
    allowUnauthenticated,
    upstreamTimeoutMs,
  };
}
