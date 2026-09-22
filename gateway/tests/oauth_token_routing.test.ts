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

const VERIFIER =
  "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE =
  "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const ORIGIN =
  "https://mcp.example.com";
const CLIENT_ID =
  "claude-public-client";
const REDIRECT_URI =
  "https://claude.example/api/mcp/auth_callback";

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
    clientId: CLIENT_ID,
    redirectUri:
      REDIRECT_URI,
    resource:
      `${ORIGIN}/mcp`,
    scopes: Object.freeze([
      "capability.read",
    ]),
  });

function config(
  issuer = ORIGIN,
): GatewayConfig {
  return {
    hostname: "127.0.0.1",
    port: 3000,
    queueDaemonOrigin:
      "http://127.0.0.1:7331",
    publicOrigin: ORIGIN,
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
  issuer = ORIGIN,
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

function authorizationUrl(): string {
  const url =
    new URL(
      "http://127.0.0.1:3000/oauth/authorize",
    );

  const params = {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri:
      REDIRECT_URI,
    resource:
      `${ORIGIN}/mcp`,
    scope:
      "capability.read",
    state:
      "state-123",
    code_challenge:
      CHALLENGE,
    code_challenge_method:
      "S256",
  };

  for (
    const [key, value]
    of Object.entries(params)
  ) {
    url.searchParams.set(
      key,
      value,
    );
  }

  return url.toString();
}

async function issueCode(
  deps: GatewayDependencies,
): Promise<string> {
  const start =
    await routeGatewayRequest(
      new Request(
        authorizationUrl(),
      ),
      deps,
    );

  expect(start.status).toBe(202);

  const approved =
    await routeGatewayRequest(
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
            decision: "approved",
          }),
        },
      ),
      deps,
    );

  expect(approved.status).toBe(200);

  const continued =
    await routeGatewayRequest(
      new Request(
        `http://127.0.0.1:3000/oauth/authorize?request_id=${REQUEST_ID}`,
      ),
      deps,
    );

  expect(continued.status).toBe(302);

  const location =
    continued.headers.get(
      "location",
    );

  expect(location).not.toBeNull();

  const code =
    new URL(location!)
      .searchParams
      .get("code");

  expect(code).toBe(CODE);

  return code!;
}

function tokenBody(
  code: string,
  overrides:
    Record<string, string> = {},
): URLSearchParams {
  return new URLSearchParams({
    grant_type:
      "authorization_code",
    code,
    client_id:
      CLIENT_ID,
    redirect_uri:
      REDIRECT_URI,
    resource:
      `${ORIGIN}/mcp`,
    code_verifier:
      VERIFIER,
    ...overrides,
  });
}

async function tokenRequest(
  deps: GatewayDependencies,
  body: URLSearchParams,
  headers:
    HeadersInit = {},
): Promise<Response> {
  const requestHeaders =
    new Headers(headers);

  requestHeaders.set(
    "content-type",
    "application/x-www-form-urlencoded",
  );

  return routeGatewayRequest(
    new Request(
      "http://127.0.0.1:3000/oauth/token",
      {
        method: "POST",
        headers:
          requestHeaders,
        body: body.toString(),
      },
    ),
    deps,
  );
}

describe(
  "OAuth token exchange gateway wiring",
  () => {
    test(
      "exchanges one approved PKCE code for one scoped tqq1 session usable at the capability boundary",
      async () => {
        const deps =
          dependencies();

        const code =
          await issueCode(deps);

        const token =
          await tokenRequest(
            deps,
            tokenBody(code),
          );

        expect(token.status).toBe(200);

        const parsedBody =
          await token.json();
        const body =
          parsedBody as Record<
            string,
            unknown
          >;

        expect(
          body.token_type,
        ).toBe("Bearer");
        expect(
          body.expires_in,
        ).toBe(900);
        expect(
          body.scope,
        ).toBe(
          "capability.read",
        );

        const accessToken =
          body.access_token;

        expect(
          typeof accessToken,
        ).toBe("string");
        expect(
          String(accessToken),
        ).toStartWith("tqq1.");

        const capabilities =
          await routeGatewayRequest(
            new Request(
              "http://127.0.0.1:3000/v1/capabilities",
              {
                headers: {
                  authorization:
                    `Bearer ${String(accessToken)}`,
                },
              },
            ),
            deps,
          );

        expect(
          capabilities.status,
        ).toBe(200);

        const parsedProjection =
          await capabilities.json();
        const projection =
          parsedProjection as {
            subject: {
              kind: string;
            };
            grant: {
              depth: number;
              authority: number;
              scopes: string[];
            };
          };

        expect(
          projection.subject.kind,
        ).toBe("session");

        expect(
          projection.grant,
        ).toEqual({
          depth: 0,
          authority: 0,
          scopes: [
            "capability.read",
          ],
        });

        const replay =
          await tokenRequest(
            deps,
            tokenBody(code),
          );

        expect(
          replay.status,
        ).toBe(400);
        expect(
          await replay.json(),
        ).toMatchObject({
          error:
            "invalid_grant",
        });
      },
    );

    test(
      "burns the code on a wrong PKCE verifier so a later retry cannot mint authority",
      async () => {
        const deps =
          dependencies();

        const code =
          await issueCode(deps);

        const wrong =
          await tokenRequest(
            deps,
            tokenBody(code, {
              code_verifier:
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            }),
          );

        expect(
          wrong.status,
        ).toBe(400);
        expect(
          await wrong.json(),
        ).toMatchObject({
          error:
            "invalid_grant",
        });

        const retry =
          await tokenRequest(
            deps,
            tokenBody(code),
          );

        expect(
          retry.status,
        ).toBe(400);
        expect(
          await retry.json(),
        ).toMatchObject({
          error:
            "invalid_grant",
        });
      },
    );

    test(
      "rejects public-client Authorization headers before consuming the code",
      async () => {
        const deps =
          dependencies();

        const code =
          await issueCode(deps);

        const withAuth =
          await tokenRequest(
            deps,
            tokenBody(code),
            {
              authorization:
                "Basic Zm9vOmJhcg==",
            },
          );

        expect(
          withAuth.status,
        ).toBe(401);
        expect(
          withAuth.headers.get(
            "www-authenticate",
          ),
        ).toBe(
          'Basic realm="oauth-token"',
        );
        expect(
          await withAuth.json(),
        ).toMatchObject({
          error:
            "invalid_client",
        });

        const valid =
          await tokenRequest(
            deps,
            tokenBody(code),
          );

        expect(valid.status).toBe(200);
      },
    );

    test(
      "ignores extension token parameters without weakening exact binding",
      async () => {
        const deps =
          dependencies();

        const code =
          await issueCode(deps);

        const extended =
          tokenBody(code);

        extended.set(
          "future_extension",
          "opaque",
        );

        const response =
          await tokenRequest(
            deps,
            extended,
          );

        expect(response.status).toBe(200);

        const parsed =
          await response.json();
        const body =
          parsed as Record<
            string,
            unknown
          >;

        expect(
          String(body.access_token),
        ).toStartWith("tqq1.");
        expect(body.scope).toBe(
          "capability.read",
        );
      },
    );

    test(
      "returns invalid_client as HTTP 400 for a mismatched public client identifier",
      async () => {
        const deps =
          dependencies();

        const code =
          await issueCode(deps);

        const response =
          await tokenRequest(
            deps,
            tokenBody(code, {
              client_id:
                "other-client",
            }),
          );

        expect(response.status).toBe(400);
        expect(
          await response.json(),
        ).toMatchObject({
          error:
            "invalid_client",
        });
      },
    );

    test(
      "fails closed for an external issuer without consuming code state",
      async () => {
        const deps =
          dependencies(
            "https://auth.example.com/tenant/",
          );

        const response =
          await tokenRequest(
            deps,
            tokenBody(CODE),
          );

        expect(
          response.status,
        ).toBe(404);
        expect(
          await response.json(),
        ).toMatchObject({
          error:
            "temporarily_unavailable",
        });
      },
    );

    test(
      "publishes RFC 8414 metadata through the real gateway router",
      async () => {
        const response =
          await routeGatewayRequest(
            new Request(
              `${ORIGIN}/.well-known/oauth-authorization-server`,
            ),
            dependencies(),
          );

        expect(
          response.status,
        ).toBe(200);

        expect(
          await response.json(),
        ).toMatchObject({
          issuer: ORIGIN,
          authorization_endpoint:
            `${ORIGIN}/oauth/authorize`,
          token_endpoint:
            `${ORIGIN}/oauth/token`,
          token_endpoint_auth_methods_supported: [
            "none",
          ],
          code_challenge_methods_supported: [
            "S256",
          ],
        });
      },
    );
  },
);
