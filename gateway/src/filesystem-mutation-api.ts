import { spawn } from "node:child_process";
import { posix } from "node:path";

import {
  GATEWAY_VERSION,
  MAX_PUBLIC_REQUEST_BYTES,
  type GatewayDependencies,
} from "./app";

const MAX_MUTATION_PATH_BYTES = 4_096;
const encoder = new TextEncoder();

export type FilesystemMutationOperation = "probe" | "write" | "mkdir";

export interface FilesystemMutationCommand {
  binary: string;
  root: string;
  operation: FilesystemMutationOperation;
  path?: string;
  payload?: Uint8Array;
  timeoutMs: number;
}

export interface FilesystemMutationResult {
  ok: boolean;
  error?: string;
}

export type FilesystemMutationRunner = (
  command: FilesystemMutationCommand,
) => Promise<FilesystemMutationResult>;

interface MutationAwareDependencies extends GatewayDependencies {
  filesystemMutationRunImpl?: FilesystemMutationRunner;
}

class FilesystemMutationBoundaryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-gateway-version": GATEWAY_VERSION,
    },
  });
}

function errorResponse(error: FilesystemMutationBoundaryError): Response {
  return jsonResponse(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ?? {}),
      },
    },
    error.status,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length
    && keys.every((key) => allowed.includes(key));
}

function validateMutationPath(value: unknown): string {
  if (typeof value !== "string") {
    throw new FilesystemMutationBoundaryError(400, "invalid_path", "path must be a relative string");
  }
  if (
    value.length === 0
    || encoder.encode(value).byteLength > MAX_MUTATION_PATH_BYTES
    || value.includes("\0")
    || value.includes("\\")
    || posix.isAbsolute(value)
  ) {
    throw new FilesystemMutationBoundaryError(400, "invalid_path", "path is not a valid delegated relative path");
  }

  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new FilesystemMutationBoundaryError(400, "invalid_path", "path components must be exact and may not contain dot traversal");
  }
  return value;
}

async function readBoundedJson(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new FilesystemMutationBoundaryError(415, "unsupported_media_type", "content-type must be application/json");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isInteger(length) || length < 0) {
      throw new FilesystemMutationBoundaryError(400, "invalid_content_length", "invalid content-length");
    }
    if (length > MAX_PUBLIC_REQUEST_BYTES) {
      throw new FilesystemMutationBoundaryError(413, "request_too_large", "request body exceeds 1 MiB");
    }
  }

  const raw = await request.text();
  if (encoder.encode(raw).byteLength > MAX_PUBLIC_REQUEST_BYTES) {
    throw new FilesystemMutationBoundaryError(413, "request_too_large", "request body exceeds 1 MiB");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FilesystemMutationBoundaryError(400, "invalid_json", "request body must contain valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new FilesystemMutationBoundaryError(400, "invalid_request", "request body must be a JSON object");
  }
  return parsed;
}

function parseMutatorError(stderr: string): string {
  const lines = stderr.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && parsed.ok === false && typeof parsed.error === "string") {
        return parsed.error;
      }
    } catch {
      // Keep looking for the mutator's stable JSON error record.
    }
  }
  return "mutation_process_error";
}

export const defaultFilesystemMutationRunner: FilesystemMutationRunner = async (
  command,
) => new Promise((resolve) => {
  const args = [command.operation, "--root", command.root];
  if (command.path !== undefined) args.push("--path", command.path);

  let settled = false;
  const child = spawn(command.binary, args, {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";

  const finish = (result: FilesystemMutationResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(result);
  };

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (stderr.length < 16_384) stderr += chunk.slice(0, 16_384 - stderr.length);
  });
  child.on("error", () => finish({ ok: false, error: "mutation_process_unavailable" }));
  child.on("close", (code) => {
    finish(code === 0
      ? { ok: true }
      : { ok: false, error: parseMutatorError(stderr) });
  });

  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish({ ok: false, error: "mutation_process_timeout" });
  }, command.timeoutMs);

  if (command.payload !== undefined) child.stdin?.end(command.payload);
  else child.stdin?.end();
});

async function invokeMutator(
  dependencies: GatewayDependencies,
  operation: FilesystemMutationOperation,
  path?: string,
  payload?: Uint8Array,
): Promise<FilesystemMutationResult> {
  const root = dependencies.config.filesystemRoot;
  const binary = dependencies.config.filesystemMutatorBin;
  if (!root || !binary) return { ok: false, error: "mutation_process_unavailable" };

  const runner = (dependencies as MutationAwareDependencies).filesystemMutationRunImpl
    ?? defaultFilesystemMutationRunner;
  try {
    return await runner({
      binary,
      root,
      operation,
      ...(path === undefined ? {} : { path }),
      ...(payload === undefined ? {} : { payload }),
      timeoutMs: dependencies.config.upstreamTimeoutMs,
    });
  } catch {
    return { ok: false, error: "mutation_process_unavailable" };
  }
}

export async function filesystemMutationAvailable(
  dependencies: GatewayDependencies,
): Promise<boolean> {
  const result = await invokeMutator(dependencies, "probe");
  return result.ok;
}

function mapMutationFailure(error: string | undefined): FilesystemMutationBoundaryError {
  switch (error) {
    case "invalid_root":
    case "mutation_process_unavailable":
      return new FilesystemMutationBoundaryError(
        503,
        "filesystem_mutator_unavailable",
        "filesystem mutation provider is unavailable",
      );
    case "mutation_process_timeout":
      return new FilesystemMutationBoundaryError(
        504,
        "filesystem_mutator_timeout",
        "filesystem mutation provider timed out before a result was proven",
      );
    case "invalid_path":
      return new FilesystemMutationBoundaryError(400, "invalid_path", "mutation path was rejected by the Rust boundary");
    case "payload_too_large":
      return new FilesystemMutationBoundaryError(413, "filesystem_payload_too_large", "filesystem mutation payload exceeds 1 MiB");
    case "committed_durability_unknown":
      return new FilesystemMutationBoundaryError(
        500,
        "filesystem_committed_durability_unknown",
        "filesystem mutation committed but durability could not be proven; do not retry blindly",
        { committed: true, durability: "unknown", retry_safe: false },
      );
    default:
      return new FilesystemMutationBoundaryError(
        500,
        "filesystem_mutation_failed",
        "filesystem mutation failed before a durable success was proven",
        { committed: false },
      );
  }
}

export async function handleFilesystemMutationRequest(
  request: Request,
  dependencies: GatewayDependencies,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const operation = path === "/v1/filesystem/write"
    ? "write"
    : path === "/v1/filesystem/mkdir"
      ? "mkdir"
      : null;
  if (!operation) return null;

  if (request.method !== "POST") {
    return jsonResponse({ error: { code: "method_not_allowed", message: "POST required" } }, 405);
  }

  try {
    const parsed = await readBoundedJson(request);
    let requestedPath: string;
    let payload: Uint8Array | undefined;

    if (operation === "write") {
      if (!exactKeys(parsed, ["path", "content"]) || typeof parsed.content !== "string") {
        throw new FilesystemMutationBoundaryError(
          400,
          "invalid_request",
          "filesystem.write requires exactly path and UTF-8 content",
        );
      }
      requestedPath = validateMutationPath(parsed.path);
      payload = encoder.encode(parsed.content);
      if (payload.byteLength > MAX_PUBLIC_REQUEST_BYTES) {
        throw new FilesystemMutationBoundaryError(413, "filesystem_payload_too_large", "filesystem mutation payload exceeds 1 MiB");
      }
    } else {
      if (!exactKeys(parsed, ["path"])) {
        throw new FilesystemMutationBoundaryError(
          400,
          "invalid_request",
          "filesystem.mkdir requires exactly path",
        );
      }
      requestedPath = validateMutationPath(parsed.path);
    }

    const result = await invokeMutator(
      dependencies,
      operation,
      requestedPath,
      payload,
    );
    if (!result.ok) throw mapMutationFailure(result.error);

    return jsonResponse({
      operation,
      path: requestedPath,
      committed: true,
      durability: "synced",
    });
  } catch (error) {
    if (error instanceof FilesystemMutationBoundaryError) return errorResponse(error);
    return errorResponse(
      new FilesystemMutationBoundaryError(
        500,
        "filesystem_mutation_failed",
        "filesystem mutation failed before a durable success was proven",
        { committed: false },
      ),
    );
  }
}
