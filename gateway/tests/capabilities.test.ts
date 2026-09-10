import { describe, expect, test } from "bun:test";

import {
  CAPABILITY_AUTHORITY,
  CAPABILITY_DEPTH,
  CAPABILITY_REGISTRY,
  LEGACY_COMPAT_GRANT,
  evaluateCapabilityGrant,
  getCapability,
  projectCapabilityCatalog,
  validateTaskCapabilityCoverage,
  type CapabilityGrant,
} from "../src/capabilities";
import { TASK_REGISTRY } from "../src/registry";

describe("capability inventory", () => {
  test("covers every registered task with the exact queue kind", () => {
    expect(validateTaskCapabilityCoverage(TASK_REGISTRY, CAPABILITY_REGISTRY)).toEqual([]);

    for (const [taskName, policy] of Object.entries(TASK_REGISTRY)) {
      expect(getCapability(CAPABILITY_REGISTRY, taskName)).toMatchObject({
        name: taskName,
        kind: "task",
        queueKind: policy.queueKind,
      });
    }
  });

  test("keeps prototype-looking names outside the capability registry", () => {
    expect(getCapability(CAPABILITY_REGISTRY, "constructor")).toBeNull();
    expect(getCapability(CAPABILITY_REGISTRY, "toString")).toBeNull();
    expect(getCapability(CAPABILITY_REGISTRY, "__proto__")).toBeNull();
  });

  test("keeps current public surfaces and task specialists discoverable", () => {
    expect(getCapability(CAPABILITY_REGISTRY, "system.health")).toMatchObject({
      minDepth: CAPABILITY_DEPTH.DISCOVER,
      minAuthority: CAPABILITY_AUTHORITY.OBSERVE,
      route: "/healthz",
    });
    expect(getCapability(CAPABILITY_REGISTRY, "workflow.submit")).toMatchObject({
      minDepth: CAPABILITY_DEPTH.ORCHESTRATE,
      minAuthority: CAPABILITY_AUTHORITY.COMPOSE,
      route: "/v1/workflows",
    });
    expect(getCapability(CAPABILITY_REGISTRY, "agent.invoke")).toMatchObject({
      minDepth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
      minAuthority: CAPABILITY_AUTHORITY.MUTATE_SCOPED,
      queueKind: "remote-agent",
    });
  });
});

describe("depth and authority are independent proof dimensions", () => {
  test("deep visibility does not imply execution authority", () => {
    const descriptor = getCapability(CAPABILITY_REGISTRY, "agent.invoke");
    expect(descriptor).not.toBeNull();

    const grant: CapabilityGrant = {
      depth: CAPABILITY_DEPTH.OPERATOR,
      authority: CAPABILITY_AUTHORITY.OBSERVE,
      scopes: ["*"],
    };
    expect(evaluateCapabilityGrant(grant, descriptor!)).toEqual({
      allowed: false,
      blockedBy: ["authority"],
    });
  });

  test("high authority does not bypass an insufficient depth", () => {
    const descriptor = getCapability(CAPABILITY_REGISTRY, "workflow.submit");
    expect(descriptor).not.toBeNull();

    const grant: CapabilityGrant = {
      depth: CAPABILITY_DEPTH.INSPECT,
      authority: CAPABILITY_AUTHORITY.PRIVILEGED_DELEGATED,
      scopes: ["*"],
    };
    expect(evaluateCapabilityGrant(grant, descriptor!)).toEqual({
      allowed: false,
      blockedBy: ["depth"],
    });
  });

  test("missing scope remains denied even when depth and authority are sufficient", () => {
    const descriptor = getCapability(CAPABILITY_REGISTRY, "hash.compute");
    expect(descriptor).not.toBeNull();

    const grant: CapabilityGrant = {
      depth: CAPABILITY_DEPTH.EXECUTE,
      authority: CAPABILITY_AUTHORITY.INVOKE,
      scopes: ["workflow.read"],
    };
    expect(evaluateCapabilityGrant(grant, descriptor!)).toEqual({
      allowed: false,
      blockedBy: ["scope"],
    });
  });

  test("legacy compatibility grant preserves the existing server capability surface", () => {
    for (const descriptor of Object.values(CAPABILITY_REGISTRY)) {
      expect(evaluateCapabilityGrant(LEGACY_COMPAT_GRANT, descriptor).allowed).toBe(true);
    }
  });
});

describe("agent-facing capability projection", () => {
  test("shows inaccessible deeper capabilities instead of pretending they do not exist", () => {
    const discoveryOnly: CapabilityGrant = {
      depth: CAPABILITY_DEPTH.DISCOVER,
      authority: CAPABILITY_AUTHORITY.OBSERVE,
      scopes: ["capability.read"],
    };

    const projected = projectCapabilityCatalog(CAPABILITY_REGISTRY, discoveryOnly);
    const health = projected.find((entry) => entry.name === "system.health");
    const remoteAgent = projected.find((entry) => entry.name === "agent.invoke");

    expect(health).toMatchObject({ accessible: true, blocked_by: [] });
    expect(remoteAgent).toMatchObject({
      accessible: false,
      blocked_by: ["depth", "authority", "scope"],
    });
  });

  test("projection is deterministic and sorted by capability name", () => {
    const projected = projectCapabilityCatalog(CAPABILITY_REGISTRY, LEGACY_COMPAT_GRANT);
    const names = projected.map((entry) => entry.name);
    expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right)));
  });
});
