import { describe, expect, test } from "bun:test";

import {
  issueCapabilitySession,
  resolveAuthorizationContext,
  verifyCapabilitySession,
} from "../src/capability-auth";
import {
  CAPABILITY_AUTHORITY,
  CAPABILITY_DEPTH,
} from "../src/capabilities";
import type { GatewayConfig } from "../src/config";

const config: GatewayConfig = {
  hostname: "127.0.0.1",
  port: 3000,
  queueDaemonOrigin: "http://127.0.0.1:7331",
  apiToken: "root-secret",
  allowUnauthenticated: false,
  upstreamTimeoutMs: 1_000,
  enqueueRatePerSecond: 10,
  enqueueBurst: 20,
  maxActiveTasks: 256,
};

function request(token?: string): Request {
  return new Request("http://127.0.0.1:3000/v1/tasks/1", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("signed capability sessions", () => {
  test("round-trips an attenuated grant", async () => {
    const now = 1_800_000_000_000;
    const issued = await issueCapabilitySession(
      "root-secret",
      {
        depth: CAPABILITY_DEPTH.EXECUTE,
        authority: CAPABILITY_AUTHORITY.INVOKE,
        scopes: ["task.read", "task.invoke", "task:document.process"],
      },
      600,
      now,
    );

    const verified = await verifyCapabilitySession(issued.token, "root-secret", now + 10_000);
    expect(verified).toMatchObject({
      kind: "session",
      sessionId: issued.claims.sid,
      grant: {
        depth: 3,
        authority: 1,
        scopes: ["task.read", "task.invoke", "task:document.process"],
      },
    });
  });

  test("rejects tampering, wrong signing authority, and expiry", async () => {
    const now = 1_800_000_000_000;
    const issued = await issueCapabilitySession(
      "root-secret",
      { depth: CAPABILITY_DEPTH.DISCOVER, authority: CAPABILITY_AUTHORITY.OBSERVE, scopes: [] },
      60,
      now,
    );
    const parts = issued.token.split(".");
    const tampered = `${parts[0]}.${parts[1]}x.${parts[2]}`;

    expect(await verifyCapabilitySession(tampered, "root-secret", now)).toBeNull();
    expect(await verifyCapabilitySession(issued.token, "wrong-secret", now)).toBeNull();
    expect(await verifyCapabilitySession(issued.token, "root-secret", now + 60_000)).toBeNull();
  });

  test("resolves root and signed sessions but not arbitrary bearer values", async () => {
    const now = 1_800_000_000_000;
    const issued = await issueCapabilitySession(
      "root-secret",
      { depth: CAPABILITY_DEPTH.INSPECT, authority: CAPABILITY_AUTHORITY.OBSERVE, scopes: ["task.read"] },
      300,
      now,
    );

    const root = await resolveAuthorizationContext(request("root-secret"), config, now);
    expect(root).toMatchObject({ kind: "root", grant: { depth: 6, authority: 4, scopes: ["*"] } });

    const session = await resolveAuthorizationContext(request(issued.token), config, now);
    expect(session).toMatchObject({ kind: "session", grant: { depth: 1, authority: 0 } });

    expect(await resolveAuthorizationContext(request("not-a-session"), config, now)).toBeNull();
  });

  test("keeps explicit unauthenticated development compatibility separate from signed sessions", async () => {
    const development: GatewayConfig = { ...config, apiToken: null, allowUnauthenticated: true };
    const auth = await resolveAuthorizationContext(request(), development);
    expect(auth).toMatchObject({
      kind: "development",
      grant: { depth: 6, authority: 4, scopes: ["*"] },
    });
  });
});
