import {
  describe,
  expect,
  test,
} from "bun:test";

import type {
  AdmissionController,
} from "../src/admission";
import type {
  GatewayDependencies,
} from "../src/app";
import type {
  GatewayConfig,
} from "../src/config";
import {
  OAuthAuthorizationCodeStore,
} from "../src/oauth-authorization-code-store";
import type {
  OAuthPublicClientPolicy,
} from "../src/oauth-authorization-validation";
import {
  PendingOAuthConsentStore,
} from "../src/oauth-pending-consent-store";
import {
  TASK_REGISTRY,
} from "../src/registry";
import {
  routeGatewayRequest,
} from "../src/router";

const ROOT = "root-secret";
const REQUEST_ID =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CODE =
  "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const CHALLENGE =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PUBLIC_ORIGIN =
  "https://mcp.example.com";
const REDIRECT_URI =
  "https://claude.example/api/mcp/auth_callback?source=test";

const admissionController:
  AdmissionController = {
    tryAcquire: () => ({
      allowed: true,
      retryAfterSeconds: 0,
    }),
  };

const policy:
  OAuthPublicClientPolicy =
  Object.freeze({
    clientId:
      "claude-public-client",
    redirectUri:
      REDIRECT_URI,
    resource:
      `${PUBLIC_ORIGIN}/mcp`,
    scopes: Object.freeze([
      "capability.read",
      "git.head",
    ]),
  });

function config(
  issuer = PUBLIC_ORIGIN,
): GatewayConfig {
  return {
    hostname: "127.0.0.1",
    port: 3000,
    queueDaemonOrigin:
      "http://127.0.0.1:7331",
    publicOrigin:
      PUBLIC_ORIGIN,
    oauthAuthorizationServer:
      issuer,
    apiToken: ROOT,
    allowUnauthenticated: false,
    upstreamTimeoutMs: 1_000,
    enqueueRatePerSecond: 10,
    enqueueBurst: 20,
    maxActiveTasks: 256,
  };
}

function dependencies(
  issuer = PUBLIC_ORIGIN,
): GatewayDependencies {
  return {
    config: config(issuer),
    registry: TASK_REGISTRY,
    admissionController,
    oauthPublicClientPolicy:
      policy,
    oauthPendingConsentStore:
      new PendingOAuthConsentStore({
        now: () => 1_000,
        idFactory:
          () => REQUEST_ID,
      }),
    oauthAuthorizationCodeStore:
      new OAuthAuthorizationCodeStore({
        now: () => 1_000,
        codeFactory:
          () => CODE,
      }),
  };
}

function authorizeUrl(
  overrides:
    Record<string, string> = {},
): string {
  const url =
    new URL(
      "http://127.0.0.1:3000/oauth/authorize",
    );

  const values = {
    response_type: "code",
    client_id:
      policy.clientId,
    redirect_uri:
      policy.redirectUri,
    resource:
      policy.resource,
    scope:
      "capability.read",
    state:
      "state-123",
    code_challenge:
      CHALLENGE,
    code_challenge_method:
      "S256",
    ...overrides,
  };

  for (
    const [key, value]
    of Object.entries(values)
  ) {
    url.searchParams.set(
      key,
      value,
    );
  }

  return url.toString();
}

async function start(
  deps: GatewayDependencies,
): Promise<Record<string, unknown>> {
  const response =
    await routeGatewayRequest(
      new Request(
        authorizeUrl(),
      ),
      deps,
    );

  expect(response.status).toBe(202);

  return (await response.json())
    as Record<string, unknown>;
}

async function decide(
  deps: GatewayDependencies,
  decision:
    "approved" | "denied",
): Promise<Response> {
  return routeGatewayRequest(
    new Request(
      `http://127.0.0.1:3000/v1/oauth/pending-consents/${REQUEST_ID}/decision`,
      {
        method: "POST",
        headers: {
          authorization:
            `Bearer ${ROOT}`,
          "content-type":
            "application/json",
        },
        body: JSON.stringify({
          decision,
        }),
      },
    ),
    deps,
  );
}

describe(
  "OAuth authorization gateway wiring",
  () => {
    test(
      "creates only pending consent before operator approval",
      async () => {
        const deps =
          dependencies();

        const body =
          await start(deps);

        expect(body).toEqual({
          schema_version: 1,
          status:
            "pending_operator_consent",
          request_id: REQUEST_ID,
          expires_at_ms: 301_000,
          continue_uri:
            `${PUBLIC_ORIGIN}/oauth/authorize?request_id=${REQUEST_ID}`,
        });

        const serialized =
          JSON.stringify(body);

        expect(
          serialized,
        ).not.toContain(
          "code_challenge",
        );
        expect(
          serialized,
        ).not.toContain(
          "state-123",
        );
        expect(
          serialized,
        ).not.toContain(
          CODE,
        );

        expect(
          deps.oauthPendingConsentStore
            ?.get(REQUEST_ID)
            ?.status,
        ).toBe("pending");

        expect(
          deps.oauthAuthorizationCodeStore
            ?.size(),
        ).toBe(0);
      },
    );

    test(
      "root approval is required before continuation can issue one code and exact redirect",
      async () => {
        const deps =
          dependencies();

        await start(deps);

        const pending =
          await routeGatewayRequest(
            new Request(
              `http://127.0.0.1:3000/oauth/authorize?request_id=${REQUEST_ID}`,
            ),
            deps,
          );

        expect(
          pending.status,
        ).toBe(202);
        expect(
          deps.oauthAuthorizationCodeStore
            ?.size(),
        ).toBe(0);

        const approved =
          await decide(
            deps,
            "approved",
          );

        expect(
          approved.status,
        ).toBe(200);

        const completed =
          await routeGatewayRequest(
            new Request(
              `http://127.0.0.1:3000/oauth/authorize?request_id=${REQUEST_ID}`,
            ),
            deps,
          );

        expect(
          completed.status,
        ).toBe(302);

        const location =
          completed.headers.get(
            "location",
          );

        expect(location).not.toBeNull();

        const redirect =
          new URL(location!);

        expect(
          `${redirect.origin}${redirect.pathname}`,
        ).toBe(
          "https://claude.example/api/mcp/auth_callback",
        );
        expect(
          redirect.searchParams.get(
            "source",
          ),
        ).toBe("test");
        expect(
          redirect.searchParams.get(
            "code",
          ),
        ).toBe(CODE);
        expect(
          redirect.searchParams.get(
            "state",
          ),
        ).toBe("state-123");
        expect(
          redirect.searchParams.get(
            "iss",
          ),
        ).toBe(PUBLIC_ORIGIN);

        expect(
          deps.oauthPendingConsentStore
            ?.get(REQUEST_ID),
        ).toBeNull();

        expect(
          deps.oauthAuthorizationCodeStore
            ?.size(),
        ).toBe(1);

        const consumed =
          deps.oauthAuthorizationCodeStore
            ?.consume(CODE);

        expect(
          consumed?.ok,
        ).toBe(true);

        if (
          !consumed
          || !consumed.ok
        ) {
          throw new Error(
            "expected live authorization code",
          );
        }

        expect(
          consumed.value.binding,
        ).toEqual({
          code: CODE,
          clientId:
            policy.clientId,
          redirectUri:
            policy.redirectUri,
          resource:
            policy.resource,
          codeChallenge:
            CHALLENGE,
        });

        expect(
          consumed.value.scopes,
        ).toEqual([
          "capability.read",
        ]);

        const replay =
          await routeGatewayRequest(
            new Request(
              `http://127.0.0.1:3000/oauth/authorize?request_id=${REQUEST_ID}`,
            ),
            deps,
          );

        expect(
          replay.status,
        ).toBe(404);
      },
    );

    test(
      "operator denial redirects access_denied and creates no code authority",
      async () => {
        const deps =
          dependencies();

        await start(deps);

        expect(
          (
            await decide(
              deps,
              "denied",
            )
          ).status,
        ).toBe(200);

        const response =
          await routeGatewayRequest(
            new Request(
              `http://127.0.0.1:3000/oauth/authorize?request_id=${REQUEST_ID}`,
            ),
            deps,
          );

        expect(
          response.status,
        ).toBe(302);

        const redirect =
          new URL(
            response.headers.get(
              "location",
            )!,
          );

        expect(
          redirect.searchParams.get(
            "error",
          ),
        ).toBe(
          "access_denied",
        );
        expect(
          redirect.searchParams.get(
            "state",
          ),
        ).toBe("state-123");
        expect(
          redirect.searchParams.get(
            "iss",
          ),
        ).toBe(PUBLIC_ORIGIN);
        expect(
          redirect.searchParams.has(
            "code",
          ),
        ).toBe(false);

        expect(
          deps.oauthAuthorizationCodeStore
            ?.size(),
        ).toBe(0);
      },
    );

    test(
      "never redirects an untrusted client or redirect URI",
      async () => {
        for (
          const overrides
          of [
            {
              client_id:
                "other-client",
            },
            {
              redirect_uri:
                "https://attacker.example/callback",
            },
          ]
        ) {
          const deps =
            dependencies();

          const response =
            await routeGatewayRequest(
              new Request(
                authorizeUrl(
                  overrides,
                ),
              ),
              deps,
            );

          expect(
            response.status,
          ).toBe(400);
          expect(
            response.headers.has(
              "location",
            ),
          ).toBe(false);
          expect(
            deps.oauthPendingConsentStore
              ?.size(),
          ).toBe(0);
        }
      },
    );

    test(
      "redirects protocol errors only after client and redirect are trusted",
      async () => {
        const deps =
          dependencies();

        const response =
          await routeGatewayRequest(
            new Request(
              authorizeUrl({
                scope:
                  "process.command.admin",
              }),
            ),
            deps,
          );

        expect(
          response.status,
        ).toBe(302);

        const redirect =
          new URL(
            response.headers.get(
              "location",
            )!,
          );

        expect(
          redirect.searchParams.get(
            "error",
          ),
        ).toBe(
          "invalid_scope",
        );
        expect(
          redirect.searchParams.get(
            "state",
          ),
        ).toBe("state-123");
        expect(
          redirect.searchParams.get(
            "iss",
          ),
        ).toBe(PUBLIC_ORIGIN);

        expect(
          deps.oauthPendingConsentStore
            ?.size(),
        ).toBe(0);
        expect(
          deps.oauthAuthorizationCodeStore
            ?.size(),
        ).toBe(0);
      },
    );

    test(
      "keeps local authorization disabled when resource metadata points at an external issuer",
      async () => {
        const deps =
          dependencies(
            "https://auth.example.com/tenant/",
          );

        const response =
          await routeGatewayRequest(
            new Request(
              authorizeUrl(),
            ),
            deps,
          );

        expect(
          response.status,
        ).toBe(404);
        expect(
          await response.text(),
        ).toContain(
          "oauth_authorization_unavailable",
        );
        expect(
          deps.oauthPendingConsentStore
            ?.size(),
        ).toBe(0);
      },
    );

    test(
      "rejects ambiguous continuations and non-GET methods before touching consent state",
      async () => {
        const deps =
          dependencies();

        await start(deps);

        const ambiguous =
          await routeGatewayRequest(
            new Request(
              `http://127.0.0.1:3000/oauth/authorize?request_id=${REQUEST_ID}&scope=capability.read`,
            ),
            deps,
          );

        expect(
          ambiguous.status,
        ).toBe(400);

        const post =
          await routeGatewayRequest(
            new Request(
              "http://127.0.0.1:3000/oauth/authorize",
              {
                method: "POST",
              },
            ),
            deps,
          );

        expect(
          post.status,
        ).toBe(405);

        expect(
          deps.oauthPendingConsentStore
            ?.get(REQUEST_ID)
            ?.status,
        ).toBe("pending");
        expect(
          deps.oauthAuthorizationCodeStore
            ?.size(),
        ).toBe(0);
      },
    );
  },
);
