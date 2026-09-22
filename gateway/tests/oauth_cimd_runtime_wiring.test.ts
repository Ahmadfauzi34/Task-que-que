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
  CimdDiscoveryDependencies,
} from "../src/oauth-cimd-discovery";
import {
  PendingOAuthConsentStore,
} from "../src/oauth-pending-consent-store";
import {
  TASK_REGISTRY,
} from "../src/registry";
import {
  routeGatewayRequest,
} from "../src/router";

const ORIGIN =
  "https://mcp.example.com";
const ROOT =
  "root-secret";

const CLIENT_ID =
  "https://client.example/.well-known/oauth-client.json";
const REDIRECT_URI =
  "https://client.example/oauth/callback";

const REQUEST_ID =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CODE =
  "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const VERIFIER =
  "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE =
  "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const admissionController:
  AdmissionController = {
    tryAcquire: () => ({
      allowed: true,
      retryAfterSeconds: 0,
    }),
  };

function config():
  GatewayConfig {
  return {
    hostname: "127.0.0.1",
    port: 3000,
    queueDaemonOrigin:
      "http://127.0.0.1:7331",
    publicOrigin: ORIGIN,
    oauthAuthorizationServer:
      ORIGIN,
    apiToken: ROOT,
    allowUnauthenticated: false,
    upstreamTimeoutMs: 1_000,
    enqueueRatePerSecond: 10,
    enqueueBurst: 20,
    maxActiveTasks: 256,
  };
}

function cimd(
  options: {
    redirectUris?: readonly string[];
    failFetch?: boolean;
    privateResolution?: boolean;
    onFetch?: () => void;
  } = {},
): CimdDiscoveryDependencies {
  return {
    resolve:
      async () => (
        options.privateResolution
          ? ["10.0.0.7"]
          : ["93.184.216.34"]
      ),
    fetchPinned:
      async (request) => {
        options.onFetch?.();

        if (options.failFetch) {
          throw new Error(
            "metadata transport unavailable",
          );
        }

        return {
          status: 200,
          contentType:
            "application/json",
          peerAddress:
            "93.184.216.34",
          body:
            JSON.stringify({
              client_id:
                CLIENT_ID,
              client_name:
                "Dynamic MCP Client",
              redirect_uris:
                options.redirectUris
                ?? [REDIRECT_URI],
              token_endpoint_auth_method:
                "none",
              grant_types: [
                "authorization_code",
              ],
              response_types: [
                "code",
              ],
            }),
        };
      },
  };
}

function dependencies(
  discovery:
    CimdDiscoveryDependencies
    | null = cimd(),
): GatewayDependencies {
  return {
    config: config(),
    registry: TASK_REGISTRY,
    admissionController,
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
    oauthPublicClientPolicy:
      null,
    oauthCimdDiscovery:
      discovery,
  };
}

function authorizationUrl(
  scope = "capability.read",
  redirectUri =
    REDIRECT_URI,
): string {
  const url =
    new URL(
      "http://127.0.0.1:3000/oauth/authorize",
    );

  const params = {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri:
      redirectUri,
    resource:
      `${ORIGIN}/mcp`,
    scope,
    state:
      "dynamic-state",
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

async function issueApprovedCode(
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

  const approval =
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
          body:
            JSON.stringify({
              decision: "approved",
            }),
        },
      ),
      deps,
    );

  expect(approval.status).toBe(200);

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

  const redirect =
    new URL(location!);

  expect(
    redirect.origin,
  ).toBe(
    "https://client.example",
  );
  expect(
    redirect.pathname,
  ).toBe(
    "/oauth/callback",
  );
  expect(
    redirect.searchParams.get(
      "state",
    ),
  ).toBe(
    "dynamic-state",
  );
  expect(
    redirect.searchParams.get(
      "iss",
    ),
  ).toBe(ORIGIN);

  const code =
    redirect.searchParams.get(
      "code",
    );

  expect(code).toBe(CODE);
  return code!;
}

function tokenBody(
  code: string,
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
  });
}

describe(
  "CIMD runtime OAuth wiring",
  () => {
    test(
      "advertises CIMD only when runtime discovery exists",
      async () => {
        const enabled =
          await routeGatewayRequest(
            new Request(
              `${ORIGIN}/.well-known/oauth-authorization-server`,
            ),
            dependencies(),
          );

        expect(enabled.status).toBe(200);
        expect(
          await enabled.json(),
        ).toMatchObject({
          issuer: ORIGIN,
          scopes_supported: [
            "capability.read",
          ],
          client_id_metadata_document_supported:
            true,
        });

        const disabled =
          await routeGatewayRequest(
            new Request(
              `${ORIGIN}/.well-known/oauth-authorization-server`,
            ),
            dependencies(null),
          );

        expect(disabled.status).toBe(404);
      },
    );

    test(
      "converts a discovered client into one D0/A0 capability.read session",
      async () => {
        let fetches = 0;

        const deps =
          dependencies(
            cimd({
              onFetch: () => {
                fetches += 1;
              },
            }),
          );

        const code =
          await issueApprovedCode(
            deps,
          );

        expect(fetches).toBe(1);

        const token =
          await routeGatewayRequest(
            new Request(
              "http://127.0.0.1:3000/oauth/token",
              {
                method: "POST",
                headers: {
                  "content-type":
                    "application/x-www-form-urlencoded",
                },
                body:
                  tokenBody(code)
                    .toString(),
              },
            ),
            deps,
          );

        expect(token.status).toBe(200);

        const parsed =
          await token.json();
        const body =
          parsed as Record<
            string,
            unknown
          >;

        expect(body.scope).toBe(
          "capability.read",
        );
        expect(
          String(body.access_token),
        ).toStartWith("tqq1.");

        // Token redemption must not fetch
        // client metadata a second time.
        expect(fetches).toBe(1);

        const capability =
          await routeGatewayRequest(
            new Request(
              "http://127.0.0.1:3000/v1/capabilities",
              {
                headers: {
                  authorization:
                    `Bearer ${String(body.access_token)}`,
                },
              },
            ),
            deps,
          );

        expect(
          capability.status,
        ).toBe(200);

        const projection =
          await capability.json()
          as {
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
      },
    );

    test(
      "uses exact CIMD redirect registration before trusting any redirect",
      async () => {
        const response =
          await routeGatewayRequest(
            new Request(
              authorizationUrl(
                "capability.read",
                "https://attacker.example/callback",
              ),
            ),
            dependencies(),
          );

        expect(response.status).toBe(400);
        expect(
          response.headers.get(
            "location",
          ),
        ).toBeNull();

        expect(
          await response.json(),
        ).toMatchObject({
          error: {
            code:
              "invalid_redirect_uri",
          },
        });
      },
    );

    test(
      "keeps dynamic clients at the server-owned capability.read ceiling",
      async () => {
        const response =
          await routeGatewayRequest(
            new Request(
              authorizationUrl(
                "task.invoke",
              ),
            ),
            dependencies(),
          );

        expect(response.status).toBe(302);

        const location =
          response.headers.get(
            "location",
          );

        expect(location).not.toBeNull();

        const redirected =
          new URL(location!);

        expect(
          redirected.origin,
        ).toBe(
          "https://client.example",
        );
        expect(
          redirected.searchParams.get(
            "error",
          ),
        ).toBe(
          "invalid_scope",
        );
        expect(
          redirected.searchParams.has(
            "code",
          ),
        ).toBe(false);
      },
    );

    test(
      "fails locally when CIMD resolution is unsafe and does not redirect",
      async () => {
        const response =
          await routeGatewayRequest(
            new Request(
              authorizationUrl(),
            ),
            dependencies(
              cimd({
                privateResolution:
                  true,
              }),
            ),
          );

        expect(response.status).toBe(400);
        expect(
          response.headers.get(
            "location",
          ),
        ).toBeNull();
        expect(
          await response.json(),
        ).toMatchObject({
          error: {
            code:
              "unauthorized_client",
          },
        });
      },
    );

    test(
      "returns a local temporary failure when safe metadata transport is unavailable",
      async () => {
        const response =
          await routeGatewayRequest(
            new Request(
              authorizationUrl(),
            ),
            dependencies(
              cimd({
                failFetch: true,
              }),
            ),
          );

        expect(response.status).toBe(503);
        expect(
          response.headers.get(
            "location",
          ),
        ).toBeNull();
        expect(
          await response.json(),
        ).toMatchObject({
          error: {
            code:
              "cimd_discovery_unavailable",
          },
        });
      },
    );
  },
);
