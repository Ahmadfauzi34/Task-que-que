import { Buffer } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import { posix } from "node:path";

import { GATEWAY_VERSION, type GatewayDependencies } from "./app";
import {
  resolveAuthorizationContext,
  type AuthorizationContext,
} from "./capability-auth";
import {
  CAPABILITY_AUTHORITY,
  CAPABILITY_DEPTH,
  evaluateCapabilityGrant,
  type CapabilityDescriptor,
} from "./capabilities";
import {
  loadRegisteredProcessRegistry,
  runRegisteredProcess,
  type RegisteredProcessDescriptor,
  type RegisteredProcessRegistry,
  type RegisteredProcessResult,
} from "./process-substrate";

const PROCESS_ROUTE = /^\/v1\/process\/([a-z][a-z0-9._-]{0,63})$/;
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

export interface RegisteredProcessProvider {
  registry: RegisteredProcessRegistry;
  helperBin: string;
}

export type RegisteredProcessRunner = typeof runRegisteredProcess;

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

async function helperAvailable(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) return false;
    await access(path, fsConstants.X_OK);
    if (posix.normalize(await realpath(path)) !== path) return false;
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const magic = Buffer.alloc(ELF_MAGIC.byteLength);
      const { bytesRead } = await handle.read(magic, 0, magic.byteLength, 0);
      return bytesRead === ELF_MAGIC.byteLength && magic.equals(ELF_MAGIC);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

export function registeredProcessCapability(
  descriptor: RegisteredProcessDescriptor,
): Readonly<CapabilityDescriptor> {
  return Object.freeze({
    name: descriptor.required_scope,
    kind: "surface",
    provider: "rust-process-exec",
    description:
      `Run the operator-registered fixed process command ${descriptor.name} with no caller-selected executable, arguments, environment, or cwd.`,
    minDepth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
    minAuthority: descriptor.authority === "invoke"
      ? CAPABILITY_AUTHORITY.INVOKE
      : CAPABILITY_AUTHORITY.MUTATE_SCOPED,
    requiredScopes: Object.freeze([descriptor.required_scope]),
    publiclyDiscoverable: true,
    mutatesState: descriptor.mutates_state,
    cancellable: true,
    durable: false,
    route: `/v1/process/${descriptor.name}`,
    method: "POST",
  });
}

export function registeredProcessCapabilities(
  provider: RegisteredProcessProvider,
): readonly Readonly<CapabilityDescriptor>[] {
  return Object.freeze(
    [...provider.registry.commands.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(registeredProcessCapability),
  );
}

export async function loadRegisteredProcessProvider(
  dependencies: GatewayDependencies,
): Promise<RegisteredProcessProvider | null> {
  const registryPath = dependencies.config.processRegistryFile;
  const helperBin = dependencies.config.processExecBin;
  if (!registryPath || !helperBin) return null;
  if (!await helperAvailable(helperBin)) return null;

  try {
    const writableRoot = dependencies.config.filesystemMutatorBin
      ? dependencies.config.filesystemRoot
      : null;
    const registry = await loadRegisteredProcessRegistry(registryPath, writableRoot);
    return Object.freeze({ registry, helperBin });
  } catch {
    return null;
  }
}

function resultResponse(result: RegisteredProcessResult): Response {
  if (result.ok) {
    return jsonResponse({
      ok: true,
      exit_code: result.exit_code ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    });
  }

  const payload = {
    ok: false,
    error: result.error ?? "process_failed",
    ...(result.exit_code === undefined ? {} : { exit_code: result.exit_code }),
    ...(result.stdout === undefined ? {} : { stdout: result.stdout }),
    ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
  };

  switch (result.error) {
    case "unregistered_process":
      return jsonResponse(payload, 404);
    case "process_unauthorized":
      return jsonResponse(payload, 403);
    case "process_unavailable":
      return jsonResponse(payload, 503);
    case "process_timeout":
      return jsonResponse(payload, 504);
    case "process_cancelled":
      return jsonResponse(payload, 409);
    case "process_output_too_large":
      return jsonResponse(payload, 502);
    case "process_failed":
    default:
      return jsonResponse(payload, 422);
  }
}

export async function handleRegisteredProcessRequest(
  request: Request,
  dependencies: GatewayDependencies,
  providerOverride?: RegisteredProcessProvider,
  authOverride?: AuthorizationContext,
  runner: RegisteredProcessRunner = runRegisteredProcess,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = PROCESS_ROUTE.exec(url.pathname);
  if (!match) return null;

  if (request.method !== "POST") {
    return errorResponse(405, "method_not_allowed", "POST required");
  }
  if (url.search.length > 0) {
    return errorResponse(400, "process_arguments_forbidden", "query parameters are not accepted");
  }

  const raw = await request.text();
  if (raw.length !== 0) {
    return errorResponse(
      400,
      "process_arguments_forbidden",
      "registered process commands accept no caller body or arguments",
    );
  }

  const auth = authOverride ?? await resolveAuthorizationContext(request, dependencies.config);
  if (!auth) {
    return errorResponse(
      401,
      "unauthorized",
      "valid root or capability-session bearer token required",
    );
  }

  const provider = providerOverride ?? await loadRegisteredProcessProvider(dependencies);
  if (!provider) {
    return errorResponse(503, "process_provider_unavailable", "registered process provider is unavailable");
  }

  const name = match[1]!;
  const descriptor = provider.registry.commands.get(name);
  if (!descriptor) {
    return errorResponse(404, "process_command_not_found", "registered process command is not available");
  }

  const capability = registeredProcessCapability(descriptor);
  const decision = evaluateCapabilityGrant(auth.grant, capability);
  if (!decision.allowed) {
    return errorResponse(403, "capability_denied", "registered process command is not authorized");
  }

  const result = await runner(provider.registry, name, {
    helperBin: provider.helperBin,
    grant: auth.grant,
    signal: request.signal,
  });
  return resultResponse(result);
}
