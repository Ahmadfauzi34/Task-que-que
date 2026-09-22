import {
  describe,
  expect,
  test,
} from "bun:test";

import type {
  GatewayConfig,
} from "../src/config";
import {
  handleOAuthAuthorizationServerMetadataRequest,
  OAUTH_AUTHORIZATION_SERVER_METADATA_PATH,
} from "../src/oauth-authorization-server-metadata";
import type {
  OAuthPublicClientPolicy,
} from "../src/oauth-authorization-validation";

const ORIGIN =
  "https://mcp.example.com";

const POLICY:
  OAuthPublicClientPolicy =
  Object.freeze({
    clientId:
      "claude-public-client",
    redirectUri:
      "https://claude.example/callback",
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
    apiToken: "root-secret",
    allowUnauthenticated: false,
    upstreamTimeoutMs: 1_000,
    enqueueRatePerSecond: 10,
    enqueueBurst: 20,
    maxActiveTasks: 256,
  };
}

describe(
  "RFC 8414 OAuth authorization server metadata",
  () => {
    test(
      "publishes exact self-hosted code flow metadata",
      async () => {
        const response =
          handleOAuthAuthorizationServerMetadataRequest(
            new Request(
              `${ORIGIN}${OAUTH_AUTHORIZATION_SERVER_METADATA_PATH}`,
            ),
            config(),
            POLICY,
          );

        expect(response).not.toBeNull();
        expect(response!.status).toBe(200);
        expect(
          await response!.json(),
        ).toEqual({
          issuer: ORIGIN,
          authorization_endpoint:
            `${ORIGIN}/oauth/authorize`,
          token_endpoint:
            `${ORIGIN}/oauth/token`,
          response_types_supported: [
            "code",
          ],
          grant_types_supported: [
            "authorization_code",
          ],
          token_endpoint_auth_methods_supported: [
            "none",
          ],
          code_challenge_methods_supported: [
            "S256",
          ],
          scopes_supported: [
            "capability.read",
          ],
        });

        expect(
          response!.headers.get(
            "cache-control",
          ),
        ).toBe(
          "public, max-age=300",
        );
      },
    );

    test(
      "does not claim local authorization server ownership for an external issuer",
      () => {
        const response =
          handleOAuthAuthorizationServerMetadataRequest(
            new Request(
              `${ORIGIN}${OAUTH_AUTHORIZATION_SERVER_METADATA_PATH}`,
            ),
            config(
              "https://auth.example.com/tenant/",
            ),
            POLICY,
          );

        expect(response).not.toBeNull();
        expect(response!.status).toBe(404);
      },
    );

    test(
      "accepts only GET on the metadata route",
      () => {
        const response =
          handleOAuthAuthorizationServerMetadataRequest(
            new Request(
              `${ORIGIN}${OAUTH_AUTHORIZATION_SERVER_METADATA_PATH}`,
              {
                method: "POST",
              },
            ),
            config(),
            POLICY,
          );

        expect(response).not.toBeNull();
        expect(response!.status).toBe(405);
        expect(
          response!.headers.get("allow"),
        ).toBe("GET");
      },
    );
  },
);
