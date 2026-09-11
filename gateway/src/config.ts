import { posix } from "node:path";

export interface GatewayConfig {
  hostname: string;
  port: number;
  queueDaemonOrigin: string;
  workerBrokerOrigin?: string;
  filesystemRoot?: string | null;
  filesystemMutatorBin?: string | null;
  gitRepository?: string | null;
  gitBin?: string | null;
  processRegistryFile?: string | null;
  apiToken: string | null;
  allowUnauthenticated: boolean;
  upstreamTimeoutMs: number;
  enqueueRatePerSecond: number;
  enqueueBurst: number;
  maxActiveTasks: number;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const DEFAULT_QUEUE_DAEMON = "http://127.0.0.1:7331";
export const DEFAULT_WORKER_BROKER = "http://127.0.0.1:7332";
const DEFAULT_UPSTREAM_TIMEOUT_MS = 3_000;
const DEFAULT_ENQUEUE_RATE_PER_SECOND = 10;
const DEFAULT_ENQUEUE_BURST = 20;
const DEFAULT_MAX_ACTIVE_TASKS = 256;

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

function parseLoopbackOrigin(raw: string, name: string): string {
  const url = new URL(raw);

  if (url.protocol !== "http:") {
    throw new Error(`${name} must use plain HTTP on loopback`);
  }
  assertLoopbackHostname(url.hostname, `${name} hostname`);
  if (url.username || url.password) {
    throw new Error(`${name} must not contain credentials`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an origin without path, query, or fragment`);
  }

  return url.origin;
}

function parseAbsoluteProviderPath(
  raw: string | undefined,
  name: string,
  rootError: string,
): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (value.includes("\0") || value.length > 4_096 || !posix.isAbsolute(value)) {
    throw new Error(`${name} must be a bounded absolute POSIX path`);
  }
  const normalized = posix.normalize(value);
  if (normalized === "/") {
    throw new Error(rootError);
  }
  return normalized;
}

function parseFilesystemRoot(raw: string | undefined): string | null {
  return parseAbsoluteProviderPath(
    raw,
    "GATEWAY_FILESYSTEM_ROOT",
    "GATEWAY_FILESYSTEM_ROOT must not delegate the filesystem root /",
  );
}

function parseFilesystemMutatorBin(raw: string | undefined): string | null {
  return parseAbsoluteProviderPath(
    raw,
    "GATEWAY_FILESYSTEM_MUTATOR_BIN",
    "GATEWAY_FILESYSTEM_MUTATOR_BIN must identify a binary, not /",
  );
}

function parseGitRepository(raw: string | undefined): string | null {
  return parseAbsoluteProviderPath(
    raw,
    "GATEWAY_GIT_REPOSITORY",
    "GATEWAY_GIT_REPOSITORY must not delegate the filesystem root /",
  );
}

function parseGitBin(raw: string | undefined): string | null {
  return parseAbsoluteProviderPath(
    raw,
    "GATEWAY_GIT_BIN",
    "GATEWAY_GIT_BIN must identify a binary, not /",
  );
}

function parseProcessRegistryFile(raw: string | undefined): string | null {
  return parseAbsoluteProviderPath(
    raw,
    "GATEWAY_PROCESS_REGISTRY_FILE",
    "GATEWAY_PROCESS_REGISTRY_FILE must identify a registry file, not /",
  );
}

function pathIsSameOrWithin(root: string, candidate: string): boolean {
  const relative = posix.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith("../") && !posix.isAbsolute(relative));
}

function validateProviderIsolation(
  filesystemRoot: string | null,
  filesystemMutatorBin: string | null,
  gitRepository: string | null,
  gitBin: string | null,
  processRegistryFile: string | null,
): void {
  if (!filesystemRoot || !filesystemMutatorBin) return;

  if (pathIsSameOrWithin(filesystemRoot, filesystemMutatorBin)) {
    throw new Error(
      "GATEWAY_FILESYSTEM_MUTATOR_BIN must be outside the delegated writable filesystem root",
    );
  }
  if (gitRepository && pathIsSameOrWithin(filesystemRoot, gitRepository)) {
    throw new Error(
      "GATEWAY_GIT_REPOSITORY control directory must be outside the delegated writable filesystem root",
    );
  }
  if (gitBin && pathIsSameOrWithin(filesystemRoot, gitBin)) {
    throw new Error(
      "GATEWAY_GIT_BIN must be outside the delegated writable filesystem root",
    );
  }
  if (processRegistryFile && pathIsSameOrWithin(filesystemRoot, processRegistryFile)) {
    throw new Error(
      "GATEWAY_PROCESS_REGISTRY_FILE must be outside the delegated writable filesystem root",
    );
  }
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
  const maxActiveTasks = parseBoundedInteger(
    env.GATEWAY_MAX_ACTIVE_TASKS,
    DEFAULT_MAX_ACTIVE_TASKS,
    1,
    1_000_000,
    "GATEWAY_MAX_ACTIVE_TASKS",
  );

  const allowUnauthenticated = env.GATEWAY_ALLOW_UNAUTHENTICATED === "1";
  const apiToken = env.GATEWAY_API_TOKEN?.trim() || null;

  if (!apiToken && !allowUnauthenticated) {
    throw new Error(
      "GATEWAY_API_TOKEN is required unless GATEWAY_ALLOW_UNAUTHENTICATED=1 is set explicitly",
    );
  }

  const filesystemRoot = parseFilesystemRoot(env.GATEWAY_FILESYSTEM_ROOT);
  const filesystemMutatorBin = parseFilesystemMutatorBin(
    env.GATEWAY_FILESYSTEM_MUTATOR_BIN,
  );
  const gitRepository = parseGitRepository(env.GATEWAY_GIT_REPOSITORY);
  const gitBin = parseGitBin(env.GATEWAY_GIT_BIN);
  const processRegistryFile = parseProcessRegistryFile(
    env.GATEWAY_PROCESS_REGISTRY_FILE,
  );

  validateProviderIsolation(
    filesystemRoot,
    filesystemMutatorBin,
    gitRepository,
    gitBin,
    processRegistryFile,
  );

  return {
    hostname,
    port,
    queueDaemonOrigin: parseLoopbackOrigin(
      env.QUEUE_DAEMON_URL?.trim() || DEFAULT_QUEUE_DAEMON,
      "QUEUE_DAEMON_URL",
    ),
    workerBrokerOrigin: parseLoopbackOrigin(
      env.WORKER_BROKER_URL?.trim() || DEFAULT_WORKER_BROKER,
      "WORKER_BROKER_URL",
    ),
    filesystemRoot,
    filesystemMutatorBin,
    gitRepository,
    gitBin,
    processRegistryFile,
    apiToken,
    allowUnauthenticated,
    upstreamTimeoutMs,
    enqueueRatePerSecond,
    enqueueBurst,
    maxActiveTasks,
  };
}
