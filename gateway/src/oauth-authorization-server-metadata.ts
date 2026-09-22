import { GATEWAY_VERSION } from "./app";
import type { GatewayConfig } from "./config";
import type { OAuthPublicClientPolicy } from "./oauth-authorization-validation";

export const OAUTH_AUTHORIZATION_SERVER_METADATA_PATH =
  "/.well-known/oauth-authorization-server";

function selfHostedIssuer(
  config: GatewayConfig,
): string | null {
  if (
    !config.publicOrigin
    || !config.oauthAuthorizationServer
    || config.oauthAuthorizationServer
      !== config.publicOrigin
  ) {
    return null;
  }

  return config.oauthAuthorizationServer;
}

export function handleOAuthAuthorizationServerMetadataRequest(
  request: Request,
  config: GatewayConfig,
  policy:
    OAuthPublicClientPolicy
    | null
    | undefined,
): Response | null {
  const url = new URL(request.url);

  if (
    url.pathname
      !== OAUTH_AUTHORIZATION_SERVER_METADATA_PATH
  ) {
    return null;
  }

  if (request.method !== "GET") {
    return new Response(
      `${JSON.stringify({
        error: "method_not_allowed",
      })}\n`,
      {
        status: 405,
        headers: {
          allow: "GET",
          "content-type":
            "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-gateway-version":
            GATEWAY_VERSION,
        },
      },
    );
  }

  const issuer =
    selfHostedIssuer(config);

  if (!issuer || !policy) {
    return new Response(
      `${JSON.stringify({
        error:
          "oauth_authorization_server_unavailable",
      })}\n`,
      {
        status: 404,
        headers: {
          "content-type":
            "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-gateway-version":
            GATEWAY_VERSION,
        },
      },
    );
  }

  return new Response(
    `${JSON.stringify({
      issuer,
      authorization_endpoint:
        `${issuer}/oauth/authorize`,
      token_endpoint:
        `${issuer}/oauth/token`,
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
        ...policy.scopes,
      ],
    })}\n`,
    {
      status: 200,
      headers: {
        "content-type":
          "application/json; charset=utf-8",
        "cache-control":
          "public, max-age=300",
        "x-gateway-version":
          GATEWAY_VERSION,
      },
    },
  );
}
