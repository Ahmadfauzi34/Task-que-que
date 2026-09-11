import type { FetchLike, GatewayDependencies } from "./app";
import type { CapabilityDescriptor } from "./capabilities";
import { DEFAULT_WORKER_BROKER } from "./config";
import { filesystemRootAvailable } from "./filesystem-api";
import { filesystemMutationAvailable } from "./filesystem-mutation-api";

interface ProviderAwareDependencies extends GatewayDependencies {
  providerFetchImpl?: FetchLike;
}

export interface CapabilityAvailabilitySnapshot {
  providerReachable: boolean;
  filesystemReachable: boolean;
  filesystemMutationReachable: boolean;
  activeTaskNames: ReadonlySet<string>;
}

function unavailableSnapshot(
  filesystemReachable: boolean,
  filesystemMutationReachable: boolean,
): CapabilityAvailabilitySnapshot {
  return Object.freeze({
    providerReachable: false,
    filesystemReachable,
    filesystemMutationReachable,
    activeTaskNames: new Set<string>(),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeTaskName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

export async function loadCapabilityAvailability(
  dependencies: GatewayDependencies,
): Promise<CapabilityAvailabilitySnapshot> {
  const [filesystemReachable, filesystemMutationReachable] = await Promise.all([
    filesystemRootAvailable(dependencies.config.filesystemRoot),
    filesystemMutationAvailable(dependencies),
  ]);
  const providerFetchImpl = (dependencies as ProviderAwareDependencies).providerFetchImpl;
  if (!providerFetchImpl) {
    return unavailableSnapshot(filesystemReachable, filesystemMutationReachable);
  }

  const origin = dependencies.config.workerBrokerOrigin ?? DEFAULT_WORKER_BROKER;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dependencies.config.upstreamTimeoutMs);

  try {
    const response = await providerFetchImpl(`${origin}/v1/providers`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status !== 200) {
      return unavailableSnapshot(filesystemReachable, filesystemMutationReachable);
    }

    const parsed: unknown = await response.json();
    if (!isRecord(parsed) || parsed.schema_version !== 1 || !Array.isArray(parsed.active_task_names)) {
      return unavailableSnapshot(filesystemReachable, filesystemMutationReachable);
    }

    const activeTaskNames = new Set<string>();
    for (const value of parsed.active_task_names) {
      if (!safeTaskName(value)) {
        return unavailableSnapshot(filesystemReachable, filesystemMutationReachable);
      }
      activeTaskNames.add(value);
    }

    return Object.freeze({
      providerReachable: true,
      filesystemReachable,
      filesystemMutationReachable,
      activeTaskNames,
    });
  } catch {
    return unavailableSnapshot(filesystemReachable, filesystemMutationReachable);
  } finally {
    clearTimeout(timer);
  }
}

export function isCapabilityAvailable(
  descriptor: CapabilityDescriptor,
  snapshot: CapabilityAvailabilitySnapshot,
): boolean {
  if (descriptor.provider === "bun-filesystem") {
    return snapshot.filesystemReachable;
  }

  if (descriptor.provider === "rust-fs-mutator") {
    return snapshot.filesystemMutationReachable;
  }

  if (descriptor.kind === "task") {
    return snapshot.providerReachable && snapshot.activeTaskNames.has(descriptor.name);
  }

  if (descriptor.name === "workflow.submit") {
    return snapshot.providerReachable && snapshot.activeTaskNames.has("workflow.run");
  }

  return true;
}
