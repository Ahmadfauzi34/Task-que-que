import { opendir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

import {
  GATEWAY_VERSION,
  MAX_PUBLIC_REQUEST_BYTES,
  type GatewayDependencies,
} from "./app";

const MAX_RELATIVE_PATH_BYTES = 4_096;
const MAX_DIRECTORY_ENTRIES = 256;
const MAX_TEXT_FILE_BYTES = 256 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

class FilesystemBoundaryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
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

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function filesystemError(error: unknown): FilesystemBoundaryError {
  if (error instanceof FilesystemBoundaryError) return error;
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
  if (code === "ENOENT") {
    return new FilesystemBoundaryError(404, "filesystem_not_found", "filesystem path was not found");
  }
  if (code === "EACCES" || code === "EPERM") {
    return new FilesystemBoundaryError(403, "filesystem_forbidden", "filesystem path is not readable");
  }
  return new FilesystemBoundaryError(500, "filesystem_error", "filesystem provider failed");
}

function normalizeRelativePath(value: unknown): string {
  if (typeof value !== "string") {
    throw new FilesystemBoundaryError(400, "invalid_path", "path must be a relative string");
  }
  if (value.length === 0 || encoder.encode(value).byteLength > MAX_RELATIVE_PATH_BYTES) {
    throw new FilesystemBoundaryError(400, "invalid_path", "path length is invalid");
  }
  if (value.includes("\0") || value.includes("\\") || posix.isAbsolute(value)) {
    throw new FilesystemBoundaryError(400, "invalid_path", "path must stay relative to the configured filesystem root");
  }
  if (value.split("/").some((segment) => segment === "..")) {
    throw new FilesystemBoundaryError(403, "filesystem_escape", "parent traversal is not allowed");
  }

  const normalized = posix.normalize(value);
  if (
    normalized === ".."
    || normalized.startsWith("../")
    || posix.isAbsolute(normalized)
  ) {
    throw new FilesystemBoundaryError(403, "filesystem_escape", "path escapes the configured filesystem root");
  }
  return normalized;
}

function containedBy(root: string, target: string): boolean {
  const delta = relative(root, target);
  return delta === ""
    || (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta));
}

async function canonicalRoot(root: string | null): Promise<string> {
  if (!root) {
    throw new FilesystemBoundaryError(
      503,
      "filesystem_unavailable",
      "filesystem provider is not configured",
    );
  }

  try {
    const canonical = await realpath(root);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory()) {
      throw new FilesystemBoundaryError(
        503,
        "filesystem_unavailable",
        "configured filesystem root is not a directory",
      );
    }
    return canonical;
  } catch (error) {
    if (error instanceof FilesystemBoundaryError) throw error;
    throw new FilesystemBoundaryError(
      503,
      "filesystem_unavailable",
      "configured filesystem root is not readable",
    );
  }
}

async function resolveTarget(root: string, requestedPath: string): Promise<string> {
  const candidate = resolve(root, requestedPath);
  if (!containedBy(root, candidate)) {
    throw new FilesystemBoundaryError(403, "filesystem_escape", "path escapes the configured filesystem root");
  }

  try {
    const canonical = await realpath(candidate);
    if (!containedBy(root, canonical)) {
      throw new FilesystemBoundaryError(
        403,
        "filesystem_escape",
        "symlink target escapes the configured filesystem root",
      );
    }
    return canonical;
  } catch (error) {
    throw filesystemError(error);
  }
}

async function readPathRequest(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new FilesystemBoundaryError(415, "unsupported_media_type", "content-type must be application/json");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isInteger(length) || length < 0) {
      throw new FilesystemBoundaryError(400, "invalid_content_length", "invalid content-length");
    }
    if (length > MAX_PUBLIC_REQUEST_BYTES) {
      throw new FilesystemBoundaryError(413, "request_too_large", "request body exceeds 1 MiB");
    }
  }

  const raw = await request.text();
  if (encoder.encode(raw).byteLength > MAX_PUBLIC_REQUEST_BYTES) {
    throw new FilesystemBoundaryError(413, "request_too_large", "request body exceeds 1 MiB");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FilesystemBoundaryError(400, "invalid_json", "request body must contain valid JSON");
  }

  if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || !("path" in parsed)) {
    throw new FilesystemBoundaryError(400, "invalid_request", "request body must contain only path");
  }
  return normalizeRelativePath(parsed.path);
}

function entryType(entry: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): "file" | "directory" | "symlink" | "other" {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

function statType(metadata: {
  isFile(): boolean;
  isDirectory(): boolean;
}): "file" | "directory" | "other" {
  if (metadata.isFile()) return "file";
  if (metadata.isDirectory()) return "directory";
  return "other";
}

export async function filesystemRootAvailable(root: string | null): Promise<boolean> {
  try {
    await canonicalRoot(root);
    return true;
  } catch {
    return false;
  }
}

async function listFilesystem(root: string, requestedPath: string): Promise<Response> {
  const target = await resolveTarget(root, requestedPath);
  const metadata = await stat(target);
  if (!metadata.isDirectory()) {
    throw new FilesystemBoundaryError(400, "filesystem_not_directory", "filesystem path is not a directory");
  }

  const entries: Array<{ name: string; type: string }> = [];
  let truncated = false;
  const directory = await opendir(target);
  try {
    for await (const entry of directory) {
      if (entries.length >= MAX_DIRECTORY_ENTRIES) {
        truncated = true;
        break;
      }
      entries.push({ name: entry.name, type: entryType(entry) });
    }
  } finally {
    try {
      await directory.close();
    } catch {
      // for-await closes the directory automatically on normal/break paths.
    }
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));

  return jsonResponse({
    path: requestedPath,
    entries,
    truncated,
    limit: MAX_DIRECTORY_ENTRIES,
  });
}

async function statFilesystem(root: string, requestedPath: string): Promise<Response> {
  const target = await resolveTarget(root, requestedPath);
  const metadata = await stat(target);
  return jsonResponse({
    path: requestedPath,
    type: statType(metadata),
    size: metadata.size,
  });
}

async function readFilesystem(root: string, requestedPath: string): Promise<Response> {
  const target = await resolveTarget(root, requestedPath);
  const metadata = await stat(target);
  if (!metadata.isFile()) {
    throw new FilesystemBoundaryError(400, "filesystem_not_file", "filesystem path is not a regular file");
  }
  if (metadata.size > MAX_TEXT_FILE_BYTES) {
    throw new FilesystemBoundaryError(413, "filesystem_file_too_large", "filesystem file exceeds 256 KiB read limit");
  }

  const bytes = await readFile(target);
  if (bytes.byteLength > MAX_TEXT_FILE_BYTES) {
    throw new FilesystemBoundaryError(413, "filesystem_file_too_large", "filesystem file exceeds 256 KiB read limit");
  }

  let content: string;
  try {
    content = decoder.decode(bytes);
  } catch {
    throw new FilesystemBoundaryError(415, "filesystem_not_utf8", "filesystem.read supports UTF-8 text files only");
  }

  return jsonResponse({
    path: requestedPath,
    encoding: "utf-8",
    bytes: bytes.byteLength,
    content,
  });
}

export async function handleFilesystemRequest(
  request: Request,
  dependencies: GatewayDependencies,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const operation = path === "/v1/filesystem/list"
    ? "list"
    : path === "/v1/filesystem/stat"
      ? "stat"
      : path === "/v1/filesystem/read"
        ? "read"
        : null;
  if (!operation) return null;

  if (request.method !== "POST") {
    return errorResponse(405, "method_not_allowed", "POST required");
  }

  try {
    const requestedPath = await readPathRequest(request);
    const root = await canonicalRoot(dependencies.config.filesystemRoot);
    if (operation === "list") return await listFilesystem(root, requestedPath);
    if (operation === "stat") return await statFilesystem(root, requestedPath);
    return await readFilesystem(root, requestedPath);
  } catch (error) {
    const mapped = filesystemError(error);
    return errorResponse(mapped.status, mapped.code, mapped.message);
  }
}
