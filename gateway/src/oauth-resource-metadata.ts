import { GATEWAY_VERSION } from "./app";
import type { GatewayConfig } from "./config";

export const OAUTH_PROTECTED_RESOURCE_ROOT = "/.well-known/oauth-protected-resource";
export const OAUTH_PROTECTED_RESOURCE_MCP = `${OAUTH_PROTECTED_RESOURCE_ROOT}/mcp`;
const MCP_RESOURCE_PATH = "/mcp";

function configured(config: GatewayConfig): boolean {
  return Boolean(config.publicOrigin && config.oauthAuthorizationServer);
}

export function oauthProtectedResourceMetadataUrl(
  config: GatewayConfig,
): string | null {
  if (!configured(config)) return null;
  return `${config.publicOrigin}${OAUTH_PROTECTED_RESOURCE_MCP}`;
}

export function oauthBearerChallenge(config: GatewayConfig): string {
  const metadataUrl = oauthProtectedResourceMetadataUrl(config);
  return metadataUrl
    ? `Bearer resource_metadata="${metadataUrl}"`
    : "Bearer";
}

function metadataResponse(config: GatewayConfig): Response {
  return new Response(
    `${JSON.stringify({
      resource: `${config.publicOrigin}${MCP_RESOURCE_PATH}`,
      authorization_servers: [config.oauthAuthorizationServer],
      bearer_methods_supported: ["header"],
      resource_name: "Task-que-que MCP",
    })}\n`,
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=300",
        "x-gateway-version": GATEWAY_VERSION,
      },
    },
  );
}

export function handleOAuthProtectedResourceMetadataRequest(
  request: Request,
  config: GatewayConfig,
): Response | null {
  const path = new URL(request.url).pathname;
  if (
    path !== OAUTH_PROTECTED_RESOURCE_ROOT
    && path !== OAUTH_PROTECTED_RESOURCE_MCP
  ) {
    return null;
  }

  if (!configured(config)) {
    return new Response(
      `${JSON.stringify({
        error: {
          code: "oauth_discovery_unavailable",
          message: "OAuth protected-resource discovery is not configured",
        },
      })}\n`,
      {
        status: 404,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-gateway-version": GATEWAY_VERSION,
        },
      },
    );
  }

  if (request.method !== "GET") {
    return new Response(
      `${JSON.stringify({
        error: {
          code: "method_not_allowed",
          message: "GET required",
        },
      })}\n`,
      {
        status: 405,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          allow: "GET",
          "x-gateway-version": GATEWAY_VERSION,
        },
      },
    );
  }

  return metadataResponse(config);
}
