import {
  GATEWAY_VERSION,
  MAX_PUBLIC_REQUEST_BYTES,
  type GatewayDependencies,
} from "./app";
import {
  isCapabilityAvailable,
  loadCapabilityAvailability,
  type CapabilityAvailabilitySnapshot,
} from "./capability-availability";
import {
  resolveAuthorizationContext,
  type AuthorizationContext,
} from "./capability-auth";
import {
  CAPABILITY_REGISTRY,
  evaluateCapabilityGrant,
  getCapability,
  type CapabilityDescriptor,
} from "./capabilities";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_ENDPOINT = "/mcp";
const MCP_LIST_TTL_MS = 30_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_FILESYSTEM_PATH_CHARS = 4_096;

export type GatewayInvoker = (request: Request) => Promise<Response>;

type JsonRpcId = string | number;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params: Record<string, unknown>;
}

function serverInfo() {
  return {
    name: "task-que-que",
    version: GATEWAY_VERSION,
  };
}

function withServerMeta<T extends Record<string, unknown>>(
  result: T,
): T & { _meta: Record<string, unknown> } {
  const existing = isRecord(result._meta) ? result._meta : {};
  return {
    ...result,
    _meta: {
      ...existing,
      "io.modelcontextprotocol/serverInfo": serverInfo(),
    },
  };
}

function rpcResponse(
  value: Record<string, unknown>,
  status = 200,
  cacheControl = "no-store",
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", cacheControl);
  headers.set("x-gateway-version", GATEWAY_VERSION);
  return new Response(`${JSON.stringify(value)}\n`, { status, headers });
}

function rpcResult(
  id: JsonRpcId,
  result: Record<string, unknown>,
  cacheControl = "no-store",
): Response {
  return rpcResponse(
    {
      jsonrpc: "2.0",
      id,
      result: withServerMeta(result),
    },
    200,
    cacheControl,
  );
}

function rpcError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  status = 200,
  data?: Record<string, unknown>,
  extraHeaders?: HeadersInit,
): Response {
  return rpcResponse(
    {
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
        ...(data ? { data } : {}),
      },
    },
    status,
    "no-store",
    extraHeaders,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string"
    || (typeof value === "number" && Number.isSafeInteger(value));
}

function decodeMirroredHeader(value: string): string | null {
  const sentinel = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value);
  if (!sentinel) {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 0x20 || code > 0x7e) return null;
    }
    return value;
  }

  try {
    const binary = atob(sentinel[1]!);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function readBoundedJson(request: Request): Promise<unknown | Response> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return rpcError(null, -32600, "MCP requests require application/json", 415);
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isInteger(length) || length < 0) {
      return rpcError(null, -32600, "invalid content-length", 400);
    }
    if (length > MAX_PUBLIC_REQUEST_BYTES) {
      return rpcError(null, -32600, "MCP request body exceeds 1 MiB", 413);
    }
  }

  const raw = await request.text();
  if (encoder.encode(raw).byteLength > MAX_PUBLIC_REQUEST_BYTES) {
    return rpcError(null, -32600, "MCP request body exceeds 1 MiB", 413);
  }

  try {
    return JSON.parse(raw);
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }
}

function parseJsonRpc(value: unknown): JsonRpcRequest | Response {
  if (
    !isRecord(value)
    || value.jsonrpc !== "2.0"
    || !isJsonRpcId(value.id)
    || typeof value.method !== "string"
  ) {
    return rpcError(null, -32600, "Invalid Request", 400);
  }
  if (value.params !== undefined && !isRecord(value.params)) {
    return rpcError(value.id, -32602, "params must be an object", 400);
  }
  return {
    jsonrpc: "2.0",
    id: value.id,
    method: value.method,
    params: (value.params as Record<string, unknown> | undefined) ?? {},
  };
}

function validateMetaAndHeaders(
  request: Request,
  rpc: JsonRpcRequest,
): Response | null {
  const meta = rpc.params._meta;
  if (!isRecord(meta)) {
    return rpcError(rpc.id, -32602, "missing MCP request _meta", 400);
  }

  const bodyVersion = meta["io.modelcontextprotocol/protocolVersion"];
  const clientCapabilities = meta["io.modelcontextprotocol/clientCapabilities"];
  if (typeof bodyVersion !== "string" || !isRecord(clientCapabilities)) {
    return rpcError(rpc.id, -32602, "invalid MCP request metadata", 400);
  }

  const clientInfo = meta["io.modelcontextprotocol/clientInfo"];
  if (
    clientInfo !== undefined
    && (
      !isRecord(clientInfo)
      || typeof clientInfo.name !== "string"
      || typeof clientInfo.version !== "string"
    )
  ) {
    return rpcError(rpc.id, -32602, "invalid MCP clientInfo metadata", 400);
  }

  const headerVersion = request.headers.get("mcp-protocol-version");
  if (!headerVersion) {
    return rpcError(
      rpc.id,
      -32020,
      "Header mismatch: MCP-Protocol-Version is required",
      400,
    );
  }
  if (headerVersion !== bodyVersion) {
    return rpcError(
      rpc.id,
      -32020,
      "Header mismatch: MCP-Protocol-Version does not match request metadata",
      400,
    );
  }
  if (bodyVersion !== MCP_PROTOCOL_VERSION) {
    return rpcError(
      rpc.id,
      -32022,
      "Unsupported protocol version",
      400,
      { supported: [MCP_PROTOCOL_VERSION], requested: bodyVersion },
    );
  }

  const methodHeader = request.headers.get("mcp-method");
  if (!methodHeader || methodHeader !== rpc.method) {
    return rpcError(
      rpc.id,
      -32020,
      "Header mismatch: Mcp-Method does not match request method",
      400,
    );
  }

  if (rpc.method === "tools/call") {
    const toolName = rpc.params.name;
    if (typeof toolName !== "string") {
      return rpcError(rpc.id, -32602, "tools/call requires params.name", 400);
    }
    const nameHeader = request.headers.get("mcp-name");
    if (!nameHeader) {
      return rpcError(
        rpc.id,
        -32020,
        "Header mismatch: Mcp-Name is required for tools/call",
        400,
      );
    }
    const decoded = decodeMirroredHeader(nameHeader);
    if (decoded === null || decoded !== toolName) {
      return rpcError(
        rpc.id,
        -32020,
        "Header mismatch: Mcp-Name does not match params.name",
        400,
      );
    }
  }

  return null;
}

function capabilityAllowed(
  auth: AuthorizationContext,
  descriptor: CapabilityDescriptor,
): boolean {
  return evaluateCapabilityGrant(auth.grant, descriptor).allowed;
}

function capabilityExecutable(
  auth: AuthorizationContext,
  descriptor: CapabilityDescriptor,
  availability: CapabilityAvailabilitySnapshot,
): boolean {
  return capabilityAllowed(auth, descriptor)
    && isCapabilityAvailable(descriptor, availability);
}

function taskSubmitSurface(): CapabilityDescriptor | null {
  return getCapability(CAPABILITY_REGISTRY, "task.submit");
}

function toolPrerequisites(
  descriptor: CapabilityDescriptor,
): readonly CapabilityDescriptor[] {
  if (descriptor.kind !== "task") return [descriptor];
  const submit = taskSubmitSurface();
  return submit ? [submit, descriptor] : [];
}

function executableTaskNames(
  auth: AuthorizationContext,
  availability: CapabilityAvailabilitySnapshot,
): string[] {
  const submit = taskSubmitSurface();
  if (!submit || !capabilityAllowed(auth, submit)) return [];
  return Object.values(CAPABILITY_REGISTRY)
    .filter(
      (descriptor) => descriptor.kind === "task" && descriptor.publiclyDiscoverable,
    )
    .filter((descriptor) => capabilityExecutable(auth, descriptor, availability))
    .map((descriptor) => descriptor.name)
    .sort((left, right) => left.localeCompare(right));
}

function idempotencySchema() {
  return {
    type: "string",
    minLength: 1,
    maxLength: 128,
    pattern: "^[A-Za-z0-9._:-]+$",
    description: "Stable retry key for this mutating invocation.",
  };
}

function emptySchema() {
  return { type: "object", additionalProperties: false };
}

function positiveIdSchema(name: string) {
  return {
    type: "object",
    properties: {
      [name]: { type: "integer", minimum: 1 },
    },
    required: [name],
    additionalProperties: false,
  };
}

function filesystemPathSchema() {
  return {
    type: "object",
    properties: {
      path: {
        type: "string",
        minLength: 1,
        maxLength: MAX_FILESYSTEM_PATH_CHARS,
        description:
          "Relative POSIX path inside the server-configured filesystem root. Absolute paths, parent traversal, and backslashes are rejected by the gateway.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  };
}

function filesystemWriteSchema() {
  return {
    type: "object",
    properties: {
      path: {
        type: "string",
        minLength: 1,
        maxLength: MAX_FILESYSTEM_PATH_CHARS,
        description:
          "Exact relative POSIX path inside the server-configured filesystem root. Dot traversal, repeated separators, absolute paths, and backslashes are rejected.",
      },
      content: {
        type: "string",
        description:
          "UTF-8 file content. The gateway and Rust mutation substrate enforce a 1 MiB byte ceiling.",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  };
}

function taskEnvelopeSchema(
  includeType: boolean,
  taskNames: readonly string[] = [],
) {
  const properties: Record<string, unknown> = {
    payload: {},
    priority: { type: "integer" },
    max_retries: { type: "integer", minimum: 0 },
    idempotency_key: idempotencySchema(),
  };
  const required = ["payload", "idempotency_key"];
  if (includeType) {
    properties.type = {
      type: "string",
      ...(taskNames.length > 0 ? { enum: taskNames } : {}),
      description: "Registered task capability to invoke.",
    };
    required.unshift("type");
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function workflowSubmitSchema() {
  return {
    type: "object",
    properties: {
      workflow: { type: "object" },
      idempotency_key: idempotencySchema(),
    },
    required: ["workflow", "idempotency_key"],
    additionalProperties: false,
  };
}

function toolSchema(
  descriptor: CapabilityDescriptor,
  auth: AuthorizationContext,
  availability: CapabilityAvailabilitySnapshot,
): Record<string, unknown> | null {
  if (descriptor.provider === "bun-filesystem") {
    return filesystemPathSchema();
  }
  if (descriptor.provider === "rust-fs-mutator") {
    return descriptor.name === "filesystem.write"
      ? filesystemWriteSchema()
      : descriptor.name === "filesystem.mkdir"
        ? filesystemPathSchema()
        : null;
  }
  if (descriptor.provider === "git-cli-metadata") {
    return emptySchema();
  }

  switch (descriptor.name) {
    case "system.health":
    case "system.readiness":
    case "system.capabilities":
      return emptySchema();
    case "task.inspect":
      return positiveIdSchema("task_id");
    case "task.submit": {
      const taskNames = executableTaskNames(auth, availability);
      return taskNames.length > 0 ? taskEnvelopeSchema(true, taskNames) : null;
    }
    case "workflow.inspect":
    case "workflow.result":
    case "workflow.cancel":
      return positiveIdSchema("workflow_id");
    case "workflow.submit":
      return workflowSubmitSchema();
    default:
      return descriptor.kind === "task" ? taskEnvelopeSchema(false) : null;
  }
}

function mcpTool(
  descriptor: CapabilityDescriptor,
  auth: AuthorizationContext,
  availability: CapabilityAvailabilitySnapshot,
): Record<string, unknown> | null {
  const prerequisites = toolPrerequisites(descriptor);
  if (
    prerequisites.length === 0
    || prerequisites.some((item) => !capabilityAllowed(auth, item))
    || !isCapabilityAvailable(descriptor, availability)
  ) {
    return null;
  }

  const inputSchema = toolSchema(descriptor, auth, availability);
  if (!inputSchema) return null;

  return {
    name: descriptor.name,
    title: descriptor.name,
    description: descriptor.description,
    inputSchema,
    _meta: {
      "com.taskqueque/capability": {
        provider: descriptor.provider,
        min_depth: descriptor.minDepth,
        min_authority: descriptor.minAuthority,
        required_scopes: descriptor.requiredScopes,
        authorized: true,
        available: true,
        executable: true,
        mutates_state: descriptor.mutatesState,
        cancellable: descriptor.cancellable,
        durable: descriptor.durable,
      },
    },
  };
}

function listTools(
  auth: AuthorizationContext,
  availability: CapabilityAvailabilitySnapshot,
): Record<string, unknown>[] {
  return Object.values(CAPABILITY_REGISTRY)
    .filter((descriptor) => descriptor.publiclyDiscoverable)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((descriptor) => mcpTool(descriptor, auth, availability))
    .filter((tool): tool is Record<string, unknown> => tool !== null);
}

function exactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(record);
  return keys.length === allowed.length
    && keys.every((key) => allowed.includes(key));
}

function validIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY.test(value);
}

function validFilesystemPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_FILESYSTEM_PATH_CHARS
    && !value.includes("\0");
}

function taskArguments(
  args: Record<string, unknown>,
  includeType: boolean,
): { body: Record<string, unknown>; idempotencyKey: string } | null {
  const allowed = includeType
    ? ["type", "payload", "priority", "max_retries", "idempotency_key"] as const
    : ["payload", "priority", "max_retries", "idempotency_key"] as const;
  if (!exactKeysSubset(args, allowed)) return null;
  if (!("payload" in args) || !validIdempotencyKey(args.idempotency_key)) {
    return null;
  }
  if (
    includeType
    && (typeof args.type !== "string" || args.type.length === 0)
  ) {
    return null;
  }
  if (args.priority !== undefined && !Number.isInteger(args.priority)) return null;
  if (
    args.max_retries !== undefined
    && (!Number.isInteger(args.max_retries) || (args.max_retries as number) < 0)
  ) {
    return null;
  }

  return {
    body: {
      ...(includeType ? { type: args.type } : {}),
      payload: args.payload,
      ...(args.priority !== undefined ? { priority: args.priority } : {}),
      ...(args.max_retries !== undefined ? { max_retries: args.max_retries } : {}),
    },
    idempotencyKey: args.idempotency_key,
  };
}

function exactKeysSubset(
  record: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function gatewayRequest(
  source: Request,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
  idempotencyKey?: string,
): Request {
  const headers = new Headers();
  const authorization = source.headers.get("authorization");
  if (authorization !== null) headers.set("authorization", authorization);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);

  return new Request(`http://gateway.internal${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function invocationForTool(
  source: Request,
  descriptor: CapabilityDescriptor,
  auth: AuthorizationContext,
  availability: CapabilityAvailabilitySnapshot,
  args: Record<string, unknown>,
): Request | null {
  if (descriptor.provider === "bun-filesystem") {
    if (
      descriptor.method !== "POST"
      || !descriptor.route
      || !exactKeys(args, ["path"])
      || !validFilesystemPath(args.path)
    ) {
      return null;
    }
    return gatewayRequest(source, descriptor.route, "POST", { path: args.path });
  }

  if (descriptor.provider === "rust-fs-mutator") {
    if (descriptor.method !== "POST" || !descriptor.route) return null;
    if (descriptor.name === "filesystem.write") {
      if (
        !exactKeys(args, ["path", "content"])
        || !validFilesystemPath(args.path)
        || typeof args.content !== "string"
        || encoder.encode(args.content).byteLength > MAX_PUBLIC_REQUEST_BYTES
      ) {
        return null;
      }
      return gatewayRequest(
        source,
        descriptor.route,
        "POST",
        { path: args.path, content: args.content },
      );
    }
    if (descriptor.name === "filesystem.mkdir") {
      if (!exactKeys(args, ["path"]) || !validFilesystemPath(args.path)) return null;
      return gatewayRequest(source, descriptor.route, "POST", { path: args.path });
    }
    return null;
  }

  if (descriptor.provider === "git-cli-metadata") {
    if (
      descriptor.method !== "GET"
      || !descriptor.route
      || !exactKeys(args, [])
    ) {
      return null;
    }
    return gatewayRequest(source, descriptor.route, "GET");
  }

  switch (descriptor.name) {
    case "system.health":
      return exactKeys(args, [])
        ? gatewayRequest(source, "/healthz", "GET")
        : null;
    case "system.readiness":
      return exactKeys(args, [])
        ? gatewayRequest(source, "/readyz", "GET")
        : null;
    case "system.capabilities":
      return exactKeys(args, [])
        ? gatewayRequest(source, "/v1/capabilities", "GET")
        : null;
    case "task.inspect":
      return exactKeys(args, ["task_id"]) && positiveInteger(args.task_id)
        ? gatewayRequest(source, `/v1/tasks/${args.task_id}`, "GET")
        : null;
    case "task.submit": {
      const parsed = taskArguments(args, true);
      if (!parsed || typeof parsed.body.type !== "string") return null;
      const target = getCapability(CAPABILITY_REGISTRY, parsed.body.type);
      if (
        !target
        || target.kind !== "task"
        || !capabilityExecutable(auth, target, availability)
      ) {
        return null;
      }
      return gatewayRequest(
        source,
        "/v1/tasks",
        "POST",
        parsed.body,
        parsed.idempotencyKey,
      );
    }
    case "workflow.inspect":
      return exactKeys(args, ["workflow_id"]) && positiveInteger(args.workflow_id)
        ? gatewayRequest(source, `/v1/workflows/${args.workflow_id}`, "GET")
        : null;
    case "workflow.result":
      return exactKeys(args, ["workflow_id"]) && positiveInteger(args.workflow_id)
        ? gatewayRequest(source, `/v1/workflows/${args.workflow_id}/result`, "GET")
        : null;
    case "workflow.cancel":
      return exactKeys(args, ["workflow_id"]) && positiveInteger(args.workflow_id)
        ? gatewayRequest(source, `/v1/workflows/${args.workflow_id}/cancel`, "POST")
        : null;
    case "workflow.submit": {
      if (
        !exactKeys(args, ["workflow", "idempotency_key"])
        || !isRecord(args.workflow)
        || !validIdempotencyKey(args.idempotency_key)
      ) {
        return null;
      }
      return gatewayRequest(
        source,
        "/v1/workflows",
        "POST",
        args.workflow,
        args.idempotency_key,
      );
    }
    default: {
      if (descriptor.kind !== "task") return null;
      const parsed = taskArguments(args, false);
      if (!parsed) return null;
      return gatewayRequest(
        source,
        "/v1/tasks",
        "POST",
        { type: descriptor.name, ...parsed.body },
        parsed.idempotencyKey,
      );
    }
  }
}

async function gatewayToolResult(
  id: JsonRpcId,
  invocation: Request,
  invokeGateway: GatewayInvoker,
): Promise<Response> {
  let response: Response;
  try {
    response = await invokeGateway(invocation);
  } catch {
    return rpcResult(id, {
      resultType: "complete",
      content: [
        { type: "text", text: "Task-que-que gateway invocation failed." },
      ],
      isError: true,
    });
  }

  let structured: unknown = null;
  const raw = await response.text();
  try {
    structured = raw.length > 0 ? JSON.parse(raw) : null;
  } catch {
    return rpcResult(id, {
      resultType: "complete",
      content: [
        {
          type: "text",
          text: `Gateway returned HTTP ${response.status} with invalid JSON.`,
        },
      ],
      isError: true,
    });
  }

  const text = JSON.stringify(structured);
  return rpcResult(id, {
    resultType: "complete",
    content: [{ type: "text", text }],
    structuredContent: structured,
    isError: !response.ok,
    _meta: {
      "com.taskqueque/gatewayStatus": response.status,
      "com.taskqueque/gatewayVersion":
        response.headers.get("x-gateway-version") ?? GATEWAY_VERSION,
    },
  });
}

async function handleToolsCall(
  source: Request,
  rpc: JsonRpcRequest,
  auth: AuthorizationContext,
  availability: CapabilityAvailabilitySnapshot,
  invokeGateway: GatewayInvoker,
): Promise<Response> {
  const name = rpc.params.name;
  const args = rpc.params.arguments ?? {};
  if (typeof name !== "string" || !isRecord(args)) {
    return rpcError(rpc.id, -32602, "invalid tools/call parameters");
  }

  const descriptor = getCapability(CAPABILITY_REGISTRY, name);
  if (!descriptor || !descriptor.publiclyDiscoverable) {
    return rpcError(rpc.id, -32602, "unknown or unavailable tool");
  }
  const tool = mcpTool(descriptor, auth, availability);
  if (!tool) {
    return rpcError(rpc.id, -32602, "unknown or unavailable tool");
  }

  const invocation = invocationForTool(
    source,
    descriptor,
    auth,
    availability,
    args,
  );
  if (!invocation) {
    return rpcError(
      rpc.id,
      -32602,
      "tool arguments do not satisfy the advertised input schema",
    );
  }

  return gatewayToolResult(rpc.id, invocation, invokeGateway);
}

export async function handleMcpRequest(
  request: Request,
  dependencies: GatewayDependencies,
  invokeGateway: GatewayInvoker,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== MCP_ENDPOINT) return null;

  if (!originAllowed(request)) {
    return rpcError(null, -32000, "Origin is not allowed", 403);
  }
  if (request.method !== "POST") {
    return rpcError(
      null,
      -32600,
      "MCP endpoint requires POST",
      405,
      undefined,
      { allow: "POST" },
    );
  }

  const accept = request.headers.get("accept")?.toLowerCase() ?? "";
  if (
    !accept.includes("application/json")
    || !accept.includes("text/event-stream")
  ) {
    return rpcError(
      null,
      -32600,
      "Accept must include application/json and text/event-stream",
      406,
    );
  }

  const parsed = await readBoundedJson(request);
  if (parsed instanceof Response) return parsed;
  const rpc = parseJsonRpc(parsed);
  if (rpc instanceof Response) return rpc;

  const metadataError = validateMetaAndHeaders(request, rpc);
  if (metadataError) return metadataError;

  const auth = await resolveAuthorizationContext(request, dependencies.config);
  if (!auth) {
    return rpcError(
      rpc.id,
      -32000,
      "valid root or capability-session bearer token required",
      401,
      undefined,
      { "www-authenticate": "Bearer" },
    );
  }

  if (rpc.method === "server/discover") {
    return rpcResult(
      rpc.id,
      {
        resultType: "complete",
        supportedVersions: [MCP_PROTOCOL_VERSION],
        capabilities: {
          tools: { listChanged: false },
        },
        instructions:
          "Task-que-que advertises only capabilities that are both authorized by the bearer grant and backed by a live provider. Delegated filesystem tools are confined to a server-configured root, mutation tools execute only through the Rust fd-relative mutator, and Git metadata tools expose only a server-configured repository through fixed read-only metadata commands. Use system.capabilities to inspect registered capabilities, authorization blockers, and runtime availability.",
        ttlMs: MCP_LIST_TTL_MS,
        cacheScope: "private",
      },
      "private, max-age=30",
    );
  }

  if (rpc.method === "tools/list") {
    if (rpc.params.cursor !== undefined) {
      return rpcError(
        rpc.id,
        -32602,
        "pagination cursor is not supported because this tool set fits in one page",
      );
    }
    const availability = await loadCapabilityAvailability(dependencies);
    return rpcResult(
      rpc.id,
      {
        resultType: "complete",
        tools: listTools(auth, availability),
        ttlMs: MCP_LIST_TTL_MS,
        cacheScope: "private",
      },
      "private, max-age=30",
    );
  }

  if (rpc.method === "tools/call") {
    const availability = await loadCapabilityAvailability(dependencies);
    return handleToolsCall(
      request,
      rpc,
      auth,
      availability,
      invokeGateway,
    );
  }

  return rpcError(rpc.id, -32601, "Method not found", 404);
}
