export type GatewayAuthMode = "bearer" | "cloudflare_access_service";

export interface GatewayConfig {
  hostname: string;
  port: number;
  queueDaemonOrigin: string;
  authMode?: GatewayAuthMode;
  apiToken: string | null;
  allowUnauthenticated: boolean;
  cloudflareAccessTeamDomain?: string | null;
  cloudflareAccessAudience?: string | null;
  cloudflareAccessServiceTokenClientId?: string | null;
  upstreamTimeoutMs: number;
  enqueueRatePerSecond: number;
  enqueueBurst: number;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const DEFAULT_QUEUE_DAEMON = "http://127.0.0.1:7331";
const DEFAULT_UPSTREAM_TIMEOUT_MS = 3_000;
const DEFAULT_ENQUEUE_RATE_PER_SECOND = 10;
const DEFAULT_ENQUEUE_BURST = 20;

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

function parseAuthMode(raw: string | undefined): GatewayAuthMode {
  const value = raw?.trim() || "bearer";
  if (value === "bearer" || value === "cloudflare_access_service") {
    return value;
  }
  throw new Error("GATEWAY_AUTH_MODE must be bearer or cloudflare_access_service");
}

function parseCloudflareTeamDomain(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }

  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.hostname.endsWith(".cloudflareaccess.com")
  ) {
    throw new Error(
      "GATEWAY_CF_ACCESS_TEAM_DOMAIN must be an HTTPS cloudflareaccess.com origin without path, credentials, port, query, or fragment",
    );
  }

  return url.origin;
}

function parseBoundedAsciiCredential(
  raw: string | undefined,
  name: string,
  maxLength: number,
): string | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  if (value.length > maxLength || !/^[A-Za-z0-9._:@-]+$/.test(value)) {
    throw new Error(`${name} contains unsupported characters or exceeds ${maxLength} bytes`);
  }
  return value;
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
  const enqueueRatePerSecond = parseBoundedInteger(
    env.GATEWAY_ENQUEUE_RATE_PER_SECOND,
    DEFAULT_ENQUEUE_RATE_PER_SECOND,
    1,
    10_000,
    "GATEWAY_ENQUEUE_RATE_PER_SECOND",
  );
  const enqueueBurst = parseBoundedInteger(
    env.GATEWAY_ENQUEUE_BURST,
    DEFAULT_ENQUEUE_BURST,
    1,
    100_000,
    "GATEWAY_ENQUEUE_BURST",
  );

  const authMode = parseAuthMode(env.GATEWAY_AUTH_MODE);
  const allowUnauthenticated = env.GATEWAY_ALLOW_UNAUTHENTICATED === "1";
  const apiToken = env.GATEWAY_API_TOKEN?.trim() || null;
  const cloudflareAccessTeamDomain = parseCloudflareTeamDomain(
    env.GATEWAY_CF_ACCESS_TEAM_DOMAIN,
  );
  const cloudflareAccessAudience = parseBoundedAsciiCredential(
    env.GATEWAY_CF_ACCESS_AUD,
    "GATEWAY_CF_ACCESS_AUD",
    128,
  );
  const cloudflareAccessServiceTokenClientId = parseBoundedAsciiCredential(
    env.GATEWAY_CF_ACCESS_SERVICE_TOKEN_CLIENT_ID,
    "GATEWAY_CF_ACCESS_SERVICE_TOKEN_CLIENT_ID",
    256,
  );

  if (allowUnauthenticated && authMode !== "bearer") {
    throw new Error(
      "GATEWAY_ALLOW_UNAUTHENTICATED=1 is incompatible with cloudflare_access_service mode",
    );
  }

  if (!allowUnauthenticated && authMode === "bearer" && !apiToken) {
    throw new Error(
      "GATEWAY_API_TOKEN is required unless GATEWAY_ALLOW_UNAUTHENTICATED=1 is set explicitly or GATEWAY_AUTH_MODE=cloudflare_access_service is configured",
    );
  }

  if (
    authMode === "cloudflare_access_service" &&
    (!cloudflareAccessTeamDomain ||
      !cloudflareAccessAudience ||
      !cloudflareAccessServiceTokenClientId)
  ) {
    throw new Error(
      "cloudflare_access_service mode requires GATEWAY_CF_ACCESS_TEAM_DOMAIN, GATEWAY_CF_ACCESS_AUD, and GATEWAY_CF_ACCESS_SERVICE_TOKEN_CLIENT_ID",
    );
  }

  return {
    hostname,
    port,
    queueDaemonOrigin: parseQueueDaemonOrigin(
      env.QUEUE_DAEMON_URL?.trim() || DEFAULT_QUEUE_DAEMON,
    ),
    authMode,
    apiToken,
    allowUnauthenticated,
    cloudflareAccessTeamDomain,
    cloudflareAccessAudience,
    cloudflareAccessServiceTokenClientId,
    upstreamTimeoutMs,
    enqueueRatePerSecond,
    enqueueBurst,
  };
}
