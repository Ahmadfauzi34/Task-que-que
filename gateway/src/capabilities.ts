import { TASK_REGISTRY, type TaskRegistry } from "./registry";

export const CAPABILITY_DEPTH = Object.freeze({
  DISCOVER: 0,
  INSPECT: 1,
  REASON: 2,
  EXECUTE: 3,
  ORCHESTRATE: 4,
  DELEGATED_SYSTEM: 5,
  OPERATOR: 6,
} as const);

export type CapabilityDepth =
  (typeof CAPABILITY_DEPTH)[keyof typeof CAPABILITY_DEPTH];

export const CAPABILITY_AUTHORITY = Object.freeze({
  OBSERVE: 0,
  INVOKE: 1,
  COMPOSE: 2,
  MUTATE_SCOPED: 3,
  PRIVILEGED_DELEGATED: 4,
} as const);

export type CapabilityAuthority =
  (typeof CAPABILITY_AUTHORITY)[keyof typeof CAPABILITY_AUTHORITY];

export type CapabilityKind = "surface" | "task" | "workflow" | "operator";

export interface CapabilityDescriptor {
  name: string;
  kind: CapabilityKind;
  provider: string;
  description: string;
  minDepth: CapabilityDepth;
  minAuthority: CapabilityAuthority;
  requiredScopes: readonly string[];
  publiclyDiscoverable: boolean;
  mutatesState: boolean;
  cancellable: boolean;
  durable: boolean;
  route?: string;
  method?: "GET" | "POST";
  queueKind?: string;
}

export type CapabilityRegistry = Readonly<Record<string, CapabilityDescriptor>>;

export interface CapabilityGrant {
  depth: CapabilityDepth;
  authority: CapabilityAuthority;
  scopes: readonly string[];
}

export type CapabilityBlocker = "depth" | "authority" | "scope";

export interface CapabilityDecision {
  allowed: boolean;
  blockedBy: readonly CapabilityBlocker[];
}

export interface CapabilityProjection {
  name: string;
  kind: CapabilityKind;
  provider: string;
  description: string;
  min_depth: CapabilityDepth;
  min_authority: CapabilityAuthority;
  required_scopes: readonly string[];
  accessible: boolean;
  blocked_by: readonly CapabilityBlocker[];
  properties: {
    mutates_state: boolean;
    cancellable: boolean;
    durable: boolean;
  };
  route?: string;
  method?: "GET" | "POST";
  queue_kind?: string;
}

function capability(
  descriptor: CapabilityDescriptor,
): Readonly<CapabilityDescriptor> {
  return Object.freeze({
    ...descriptor,
    requiredScopes: Object.freeze([...descriptor.requiredScopes]),
  });
}

export const CAPABILITY_REGISTRY: CapabilityRegistry = Object.freeze({
  "system.health": capability({
    name: "system.health",
    kind: "surface",
    provider: "bun-gateway",
    description: "Read gateway liveness without touching queue state.",
    minDepth: CAPABILITY_DEPTH.DISCOVER,
    minAuthority: CAPABILITY_AUTHORITY.OBSERVE,
    requiredScopes: [],
    publiclyDiscoverable: true,
    mutatesState: false,
    cancellable: false,
    durable: false,
    route: "/healthz",
    method: "GET",
  }),
  "system.readiness": capability({
    name: "system.readiness",
    kind: "surface",
    provider: "bun-gateway",
    description: "Read gateway and queue readiness.",
    minDepth: CAPABILITY_DEPTH.DISCOVER,
    minAuthority: CAPABILITY_AUTHORITY.OBSERVE,
    requiredScopes: [],
    publiclyDiscoverable: true,
    mutatesState: false,
    cancellable: false,
    durable: false,
    route: "/readyz",
    method: "GET",
  }),
  "system.capabilities": capability({
    name: "system.capabilities",
    kind: "surface",
    provider: "bun-gateway",
    description: "Read the machine-readable capability inventory and access requirements.",
    minDepth: CAPABILITY_DEPTH.DISCOVER,
    minAuthority: CAPABILITY_AUTHORITY.OBSERVE,
    requiredScopes: ["capability.read"],
    publiclyDiscoverable: true,
    mutatesState: false,
    cancellable: false,
    durable: false,
    route: "/v1/capabilities",
    method: "GET",
  }),
  "task.inspect": capability({
    name: "task.inspect",
    kind: "surface",
    provider: "bun-gateway",
    description: "Read a public task state projection.",
    minDepth: CAPABILITY_DEPTH.INSPECT,
    minAuthority: CAPABILITY_AUTHORITY.OBSERVE,
    requiredScopes: ["task.read"],
    publiclyDiscoverable: true,
    mutatesState: false,
    cancellable: false,
    durable: true,
    route: "/v1/tasks/:id",
    method: "GET",
  }),
  "task.submit": capability({
    name: "task.submit",
    kind: "surface",
    provider: "bun-gateway",
    description: "Submit an allowlisted task through the public task facade.",
    minDepth: CAPABILITY_DEPTH.EXECUTE,
    minAuthority: CAPABILITY_AUTHORITY.INVOKE,
    requiredScopes: ["task.invoke"],
    publiclyDiscoverable: true,
    mutatesState: true,
    cancellable: false,
    durable: true,
    route: "/v1/tasks",
    method: "POST",
  }),
  "workflow.inspect": capability({
    name: "workflow.inspect",
    kind: "workflow",
    provider: "bun-gateway",
    description: "Read a workflow state projection.",
    minDepth: CAPABILITY_DEPTH.INSPECT,
    minAuthority: CAPABILITY_AUTHORITY.OBSERVE,
    requiredScopes: ["workflow.read"],
    publiclyDiscoverable: true,
    mutatesState: false,
    cancellable: false,
    durable: true,
    route: "/v1/workflows/:id",
    method: "GET",
  }),
  "workflow.result": capability({
    name: "workflow.result",
    kind: "workflow",
    provider: "bun-gateway",
    description: "Read declared workflow outputs after completion.",
    minDepth: CAPABILITY_DEPTH.INSPECT,
    minAuthority: CAPABILITY_AUTHORITY.OBSERVE,
    requiredScopes: ["workflow.read"],
    publiclyDiscoverable: true,
    mutatesState: false,
    cancellable: false,
    durable: true,
    route: "/v1/workflows/:id/result",
    method: "GET",
  }),
  "workflow.cancel": capability({
    name: "workflow.cancel",
    kind: "workflow",
    provider: "bun-gateway",
    description: "Trigger the fenced workflow cancellation chain.",
    minDepth: CAPABILITY_DEPTH.EXECUTE,
    minAuthority: CAPABILITY_AUTHORITY.INVOKE,
    requiredScopes: ["workflow.cancel"],
    publiclyDiscoverable: true,
    mutatesState: true,
    cancellable: false,
    durable: true,
    route: "/v1/workflows/:id/cancel",
    method: "POST",
  }),
  "workflow.submit": capability({
    name: "workflow.submit",
    kind: "workflow",
    provider: "bun-gateway",
    description: "Compose and submit a bounded workflow through workflow.run.",
    minDepth: CAPABILITY_DEPTH.ORCHESTRATE,
    minAuthority: CAPABILITY_AUTHORITY.COMPOSE,
    requiredScopes: ["workflow.compose"],
    publiclyDiscoverable: true,
    mutatesState: true,
    cancellable: true,
    durable: true,
    route: "/v1/workflows",
    method: "POST",
  }),
  "filesystem.list": capability({
    name: "filesystem.list",
    kind: "surface",
    provider: "bun-filesystem",
    description: "List one directory inside the server-configured delegated filesystem root.",
    minDepth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
    minAuthority: CAPABILITY_AUTHORITY.OBSERVE,
    requiredScopes: ["filesystem.inspect"],
    publiclyDiscoverable: true,
    mutatesState: false,
    cancellable: false,
    durable: false,
    route: "/v1/filesystem/list",
    method: "POST",
  }),
  "filesystem.stat": capability({
    name: "filesystem.stat",
    kind: "surface",
    provider: "bun-filesystem",
    description: "Inspect metadata for one path inside the server-configured delegated filesystem root.",
    minDepth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
    minAuthority: CAPABILITY_AUTHORITY.OBSERVE,
    requiredScopes: ["filesystem.inspect"],
    publiclyDiscoverable: true,
    mutatesState: false,
    cancellable: false,
    durable: false,
    route: "/v1/filesystem/stat",
    method: "POST",
  }),
  "filesystem.read": capability({
    name: "filesystem.read",
    kind: "surface",
    provider: "bun-filesystem",
    description: "Read a bounded UTF-8 text file inside the server-configured delegated filesystem root.",
    minDepth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
    minAuthority: CAPABILITY_AUTHORITY.OBSERVE,
    requiredScopes: ["filesystem.read"],
    publiclyDiscoverable: true,
    mutatesState: false,
    cancellable: false,
    durable: false,
    route: "/v1/filesystem/read",
    method: "POST",
  }),
  "filesystem.write": capability({
    name: "filesystem.write",
    kind: "surface",
    provider: "rust-fs-mutator",
    description: "Atomically replace one bounded UTF-8 file inside the server-configured delegated filesystem root through the Rust fd-relative mutation boundary.",
    minDepth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
    minAuthority: CAPABILITY_AUTHORITY.MUTATE_SCOPED,
    requiredScopes: ["filesystem.write"],
    publiclyDiscoverable: true,
    mutatesState: true,
    cancellable: false,
    durable: true,
    route: "/v1/filesystem/write",
    method: "POST",
  }),
  "filesystem.mkdir": capability({
    name: "filesystem.mkdir",
    kind: "surface",
    provider: "rust-fs-mutator",
    description: "Create one directory inside the server-configured delegated filesystem root through the Rust fd-relative mutation boundary.",
    minDepth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
    minAuthority: CAPABILITY_AUTHORITY.MUTATE_SCOPED,
    requiredScopes: ["filesystem.mkdir"],
    publiclyDiscoverable: true,
    mutatesState: true,
    cancellable: false,
    durable: true,
    route: "/v1/filesystem/mkdir",
    method: "POST",
  }),
  "git.head": capability({
    name: "git.head",
    kind: "surface",
    provider: "git-cli-metadata",
    description: "Read the current HEAD commit and symbolic branch from one server-configured Git repository without inspecting working-tree contents.",
    minDepth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
    minAuthority: CAPABILITY_AUTHORITY.OBSERVE,
    requiredScopes: ["git.inspect"],
    publiclyDiscoverable: true,
    mutatesState: false,
    cancellable: false,
    durable: false,
    route: "/v1/git/head",
    method: "GET",
  }),
  "git.log": capability({
    name: "git.log",
    kind: "surface",
    provider: "git-cli-metadata",
    description: "Read a bounded commit-id, timestamp, and parent projection from one server-configured Git repository.",
    minDepth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
    minAuthority: CAPABILITY_AUTHORITY.OBSERVE,
    requiredScopes: ["git.inspect"],
    publiclyDiscoverable: true,
    mutatesState: false,
    cancellable: false,
    durable: false,
    route: "/v1/git/log",
    method: "GET",
  }),
  "git.refs": capability({
    name: "git.refs",
    kind: "surface",
    provider: "git-cli-metadata",
    description: "Read a bounded local branch and tag reference projection from one server-configured Git repository.",
    minDepth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
    minAuthority: CAPABILITY_AUTHORITY.OBSERVE,
    requiredScopes: ["git.inspect"],
    publiclyDiscoverable: true,
    mutatesState: false,
    cancellable: false,
    durable: false,
    route: "/v1/git/refs",
    method: "GET",
  }),
  "document.process": capability({
    name: "document.process",
    kind: "task",
    provider: "worker:cpu",
    description: "Execute the registered document processing task on an exact cpu capability.",
    minDepth: CAPABILITY_DEPTH.EXECUTE,
    minAuthority: CAPABILITY_AUTHORITY.INVOKE,
    requiredScopes: ["task:document.process"],
    publiclyDiscoverable: true,
    mutatesState: true,
    cancellable: true,
    durable: true,
    queueKind: "cpu",
  }),
  "hash.compute": capability({
    name: "hash.compute",
    kind: "task",
    provider: "worker:cpu",
    description: "Compute a registered hash task on an exact cpu capability.",
    minDepth: CAPABILITY_DEPTH.EXECUTE,
    minAuthority: CAPABILITY_AUTHORITY.INVOKE,
    requiredScopes: ["task:hash.compute"],
    publiclyDiscoverable: true,
    mutatesState: true,
    cancellable: true,
    durable: true,
    queueKind: "cpu",
  }),
  "vector.dot": capability({
    name: "vector.dot",
    kind: "task",
    provider: "worker:vector",
    description: "Execute the registered vector dot-product specialist task.",
    minDepth: CAPABILITY_DEPTH.EXECUTE,
    minAuthority: CAPABILITY_AUTHORITY.INVOKE,
    requiredScopes: ["task:vector.dot"],
    publiclyDiscoverable: true,
    mutatesState: true,
    cancellable: true,
    durable: true,
    queueKind: "vector",
  }),
  "agent.invoke": capability({
    name: "agent.invoke",
    kind: "task",
    provider: "worker:remote-agent",
    description: "Delegate a registered invocation to the remote-agent specialist when that worker is enabled.",
    minDepth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
    minAuthority: CAPABILITY_AUTHORITY.MUTATE_SCOPED,
    requiredScopes: ["task:agent.invoke"],
    publiclyDiscoverable: true,
    mutatesState: true,
    cancellable: true,
    durable: true,
    queueKind: "remote-agent",
  }),
  "workflow.run": capability({
    name: "workflow.run",
    kind: "task",
    provider: "worker:workflow",
    description: "Execute the internal registered workflow orchestration task.",
    minDepth: CAPABILITY_DEPTH.ORCHESTRATE,
    minAuthority: CAPABILITY_AUTHORITY.COMPOSE,
    requiredScopes: ["task:workflow.run"],
    publiclyDiscoverable: true,
    mutatesState: true,
    cancellable: true,
    durable: true,
    queueKind: "workflow",
  }),
});

export const LEGACY_COMPAT_GRANT: CapabilityGrant = Object.freeze({
  depth: CAPABILITY_DEPTH.OPERATOR,
  authority: CAPABILITY_AUTHORITY.PRIVILEGED_DELEGATED,
  scopes: Object.freeze(["*"]),
});

export function getCapability(
  registry: CapabilityRegistry,
  name: string,
): CapabilityDescriptor | null {
  return Object.prototype.hasOwnProperty.call(registry, name)
    ? registry[name] ?? null
    : null;
}

function scopeMatches(granted: string, required: string): boolean {
  if (granted === "*") return true;
  if (granted === required) return true;
  if (!granted.endsWith(".*")) return false;
  const prefix = granted.slice(0, -1);
  return required.startsWith(prefix) && required.length > prefix.length;
}

function hasRequiredScopes(
  grantedScopes: readonly string[],
  requiredScopes: readonly string[],
): boolean {
  return requiredScopes.every((required) =>
    grantedScopes.some((granted) => scopeMatches(granted, required)),
  );
}

export function evaluateCapabilityGrant(
  grant: CapabilityGrant,
  descriptor: CapabilityDescriptor,
): CapabilityDecision {
  const blockedBy: CapabilityBlocker[] = [];
  if (grant.depth < descriptor.minDepth) blockedBy.push("depth");
  if (grant.authority < descriptor.minAuthority) blockedBy.push("authority");
  if (!hasRequiredScopes(grant.scopes, descriptor.requiredScopes)) {
    blockedBy.push("scope");
  }
  return Object.freeze({
    allowed: blockedBy.length === 0,
    blockedBy: Object.freeze(blockedBy),
  });
}

export function projectCapabilityCatalog(
  registry: CapabilityRegistry,
  grant: CapabilityGrant,
): readonly CapabilityProjection[] {
  return Object.freeze(
    Object.values(registry)
      .filter((descriptor) => descriptor.publiclyDiscoverable)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((descriptor) => {
        const decision = evaluateCapabilityGrant(grant, descriptor);
        return Object.freeze({
          name: descriptor.name,
          kind: descriptor.kind,
          provider: descriptor.provider,
          description: descriptor.description,
          min_depth: descriptor.minDepth,
          min_authority: descriptor.minAuthority,
          required_scopes: descriptor.requiredScopes,
          accessible: decision.allowed,
          blocked_by: decision.blockedBy,
          properties: Object.freeze({
            mutates_state: descriptor.mutatesState,
            cancellable: descriptor.cancellable,
            durable: descriptor.durable,
          }),
          ...(descriptor.route ? { route: descriptor.route } : {}),
          ...(descriptor.method ? { method: descriptor.method } : {}),
          ...(descriptor.queueKind ? { queue_kind: descriptor.queueKind } : {}),
        });
      }),
  );
}

export function validateTaskCapabilityCoverage(
  tasks: TaskRegistry = TASK_REGISTRY,
  capabilities: CapabilityRegistry = CAPABILITY_REGISTRY,
): readonly string[] {
  const errors: string[] = [];
  for (const [taskName, policy] of Object.entries(tasks)) {
    const descriptor = getCapability(capabilities, taskName);
    if (!descriptor) {
      errors.push(`${taskName}: missing capability descriptor`);
      continue;
    }
    if (descriptor.kind !== "task") {
      errors.push(`${taskName}: descriptor kind must be task`);
    }
    if (descriptor.queueKind !== policy.queueKind) {
      errors.push(
        `${taskName}: queue kind mismatch (${String(descriptor.queueKind)} != ${policy.queueKind})`,
      );
    }
  }
  return Object.freeze(errors);
}
