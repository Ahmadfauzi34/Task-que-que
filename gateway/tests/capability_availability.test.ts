import { describe, expect, test } from "bun:test";

import type { AdmissionController } from "../src/admission";
import type { FetchLike, GatewayDependencies } from "../src/app";
import {
  isCapabilityAvailable,
  loadCapabilityAvailability,
} from "../src/capability-availability";
import { CAPABILITY_REGISTRY, getCapability } from "../src/capabilities";
import { loadGatewayConfig, type GatewayConfig } from "../src/config";
import { TASK_REGISTRY } from "../src/registry";

const config: GatewayConfig = {
  hostname: "127.0.0.1",
  port: 3000,
  queueDaemonOrigin: "http://127.0.0.1:7331",
  workerBrokerOrigin: "http://127.0.0.1:7332",
  apiToken: "test-secret",
  allowUnauthenticated: false,
  upstreamTimeoutMs: 1_000,
  enqueueRatePerSecond: 10,
  enqueueBurst: 20,
  maxActiveTasks: 256,
};

const admissionController: AdmissionController = {
  tryAcquire: () => ({ allowed: true, retryAfterSeconds: 0 }),
};

function deps(providerFetchImpl?: FetchLike): GatewayDependencies {
  return {
    config,
    registry: TASK_REGISTRY,
    admissionController,
    ...(providerFetchImpl ? { providerFetchImpl } : {}),
  } as GatewayDependencies;
}

function snapshot(activeTaskNames: unknown, status = 200): FetchLike {
  return async () => new Response(
    JSON.stringify({
      schema_version: 1,
      active_task_names: activeTaskNames,
      worker_types: [],
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function capability(name: string) {
  const descriptor = getCapability(CAPABILITY_REGISTRY, name);
  if (!descriptor) throw new Error(`missing capability ${name}`);
  return descriptor;
}

describe("runtime capability availability", () => {
  test("fails closed when no provider source is configured", async () => {
    const availability = await loadCapabilityAvailability(deps());
    expect(availability.providerReachable).toBe(false);
    expect(isCapabilityAvailable(capability("document.process"), availability)).toBe(false);
    expect(isCapabilityAvailable(capability("system.health"), availability)).toBe(true);
  });

  test("fails closed on malformed, unsafe, or unsuccessful provider snapshots", async () => {
    for (const source of [
      snapshot("document.process"),
      snapshot(["document.process", "../escape"]),
      snapshot(["document.process"], 503),
      (async () => new Response("not-json", { status: 200 })) as FetchLike,
    ]) {
      const availability = await loadCapabilityAvailability(deps(source));
      expect(availability.providerReachable).toBe(false);
      expect(isCapabilityAvailable(capability("document.process"), availability)).toBe(false);
    }
  });

  test("requires exact live task names and workflow.run for workflow composition", async () => {
    const availability = await loadCapabilityAvailability(
      deps(snapshot(["document.process", "workflow.run"])),
    );
    expect(availability.providerReachable).toBe(true);
    expect(isCapabilityAvailable(capability("document.process"), availability)).toBe(true);
    expect(isCapabilityAvailable(capability("hash.compute"), availability)).toBe(false);
    expect(isCapabilityAvailable(capability("agent.invoke"), availability)).toBe(false);
    expect(isCapabilityAvailable(capability("workflow.submit"), availability)).toBe(true);

    const withoutWorkflow = await loadCapabilityAvailability(
      deps(snapshot(["document.process"])),
    );
    expect(isCapabilityAvailable(capability("workflow.submit"), withoutWorkflow)).toBe(false);
  });
});

describe("worker broker configuration", () => {
  test("accepts only credential-free numeric loopback HTTP origins", () => {
    const base = {
      GATEWAY_API_TOKEN: "secret",
      WORKER_BROKER_URL: "http://127.0.0.1:7445",
    };
    expect(loadGatewayConfig(base).workerBrokerOrigin).toBe("http://127.0.0.1:7445");

    for (const value of [
      "http://0.0.0.0:7332",
      "https://127.0.0.1:7332",
      "http://localhost:7332",
      "http://user:pass@127.0.0.1:7332",
      "http://127.0.0.1:7332/path",
    ]) {
      expect(() => loadGatewayConfig({
        GATEWAY_API_TOKEN: "secret",
        WORKER_BROKER_URL: value,
      })).toThrow();
    }
  });
});
