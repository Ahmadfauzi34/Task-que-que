import type { FetchLike, GatewayDependencies } from "./app";
import type { CapabilityDescriptor } from "./capabilities";
import { DEFAULT_WORKER_BROKER } from "./config";

interface ProviderAwareDependencies extends GatewayDependencies {
  providerFetchImpl?: FetchLike;
}

export interface CapabilityAvailabilitySnapshot {
  providerReachable: boolean;
  activeTaskNames: ReadonlySet<string>;
}

function unavailableSnapshot(): CapabilityAvailabilitySnapshot {
  return Object.freeze({
    providerReachable: false,
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
  const providerFetchImpl = (dependencies as ProviderAwareDependencies).providerFetchImpl;
  if (!providerFetchImpl) return unavailableSnapshot();

  const origin = dependencies.config.workerBrokerOrigin ?? DEFAULT_WORKER_BROKER;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dependencies.config.upstreamTimeoutMs);

  try {
    const response = await providerFetchImpl(`${origin}/v1/providers`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status !== 200) return unavailableSnapshot();

    const parsed: unknown = await response.json();
    if (!isRecord(parsed) || parsed.schema_version !== 1 || !Array.isArray(parsed.active_task_names)) {
      return unavailableSnapshot();
    }

    const activeTaskNames = new Set<string>();
    for (const value of parsed.active_task_names) {
      if (!safeTaskName(value)) return unavailableSnapshot();
      activeTaskNames.add(value);
    }

    return Object.freeze({
      providerReachable: true,
      activeTaskNames,
    });
  } catch {
    return unavailableSnapshot();
  } finally {
    clearTimeout(timer);
  }
}

export function isCapabilityAvailable(
  descriptor: CapabilityDescriptor,
  snapshot: CapabilityAvailabilitySnapshot,
): boolean {
  if (descriptor.kind === "task") {
    return snapshot.providerReachable && snapshot.activeTaskNames.has(descriptor.name);
  }

  if (descriptor.name === "workflow.submit") {
    return snapshot.providerReachable && snapshot.activeTaskNames.has("workflow.run");
  }

  return true;
}
