import { describe, expect, test } from "bun:test";

import type { AdmissionController } from "../src/admission";
import type { GatewayDependencies } from "../src/app";
import { issueCapabilitySession } from "../src/capability-auth";
import {
  CAPABILITY_AUTHORITY,
  CAPABILITY_DEPTH,
} from "../src/capabilities";
import type { GatewayConfig } from "../src/config";
import { PendingOAuthConsentStore } from "../src/oauth-pending-consent-store";
import type { ValidatedOAuthAuthorizationRequest } from "../src/oauth-authorization-validation";
import { TASK_REGISTRY } from "../src/registry";
import { routeGatewayRequest } from "../src/router";

const ROOT = "root-secret";
const REQUEST_ID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CHALLENGE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const config: GatewayConfig = {
  hostname: "127.0.0.1",
  port: 3000,
  queueDaemonOrigin: "http://127.0.0.1:7331",
  apiToken: ROOT,
  allowUnauthenticated: false,
  upstreamTimeoutMs: 1_000,
  enqueueRatePerSecond: 10,
  enqueueBurst: 20,
  maxActiveTasks: 256,
};

const admissionController: AdmissionController = {
  tryAcquire: () => ({ allowed: true, retryAfterSeconds: 0 }),
};

function requestValue(): ValidatedOAuthAuthorizationRequest {
  return {
    responseType: "code",
    clientId: "claude-public-client",
    redirectUri: "https://claude.example/callback",
    resource: "https://mcp.example.com/mcp",
    scopes: ["capability.read"],
    state: "opaque-state",
    codeChallenge: CHALLENGE,
    codeChallengeMethod: "S256",
  };
}

function dependencies(): GatewayDependencies {
  const oauthPendingConsentStore = new PendingOAuthConsentStore({
    now: () => 1_000,
    idFactory: () => REQUEST_ID,
  });
  const created = oauthPendingConsentStore.create(requestValue());
  if (!created.ok) throw new Error("expected pending consent seed");

  return {
    config,
    registry: TASK_REGISTRY,
    admissionController,
    oauthPendingConsentStore,
  };
}

describe("OAuth consent operator gateway routing", () => {
  test("root bearer reaches the operator surface through the normal gateway router", async () => {
    const response = await routeGatewayRequest(
      new Request("http://127.0.0.1:3000/v1/oauth/pending-consents", {
        headers: {
          authorization: `Bearer ${ROOT}`,
        },
      }),
      dependencies(),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      pending_consents: Array<Record<string, unknown>>;
    };
    expect(body.pending_consents).toHaveLength(1);
    expect(body.pending_consents[0]?.requestId).toBe(REQUEST_ID);
  });

  test("a signed capability session cannot become an operator approval credential", async () => {
    const issued = await issueCapabilitySession(
      ROOT,
      {
        depth: CAPABILITY_DEPTH.DELEGATED_SYSTEM,
        authority: CAPABILITY_AUTHORITY.PRIVILEGED_DELEGATED,
        scopes: ["*"],
      },
      300,
    );

    const response = await routeGatewayRequest(
      new Request(
        `http://127.0.0.1:3000/v1/oauth/pending-consents/${REQUEST_ID}/decision`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${issued.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ decision: "approved" }),
        },
      ),
      dependencies(),
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("root bearer token required");
  });

  test("root decision mutates only consent state and still issues no authority", async () => {
    const deps = dependencies();

    const response = await routeGatewayRequest(
      new Request(
        `http://127.0.0.1:3000/v1/oauth/pending-consents/${REQUEST_ID}/decision`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${ROOT}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ decision: "approved" }),
        },
      ),
      deps,
    );

    expect(response.status).toBe(200);
    const bodyText = await response.text();
    expect(bodyText).not.toContain("session_token");
    expect(bodyText).not.toContain("authorization_code");
    expect(bodyText).not.toContain("access_token");

    expect(deps.oauthPendingConsentStore?.get(REQUEST_ID)?.status).toBe("approved");
  });
});
