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

function headers(
  gatewayVersion: string,
  cacheControl: string,
  extra?: HeadersInit,
): Headers {
  const value = new Headers(extra);
  value.set("content-type", "application/json; charset=utf-8");
  value.set("cache-control", cacheControl);
  value.set("x-gateway-version", gatewayVersion);
  return value;
}

function metadataResponse(config: GatewayConfig, gatewayVersion: string): Response {
  return new Response(
    `${JSON.stringify({
      resource: `${config.publicOrigin}${MCP_RESOURCE_PATH}`,
      authorization_servers: [config.oauthAuthorizationServer],
      bearer_methods_supported: ["header"],
      resource_name: "Task-que-que MCP",
    })}\n`,
    {
      status: 200,
      headers: headers(gatewayVersion, "public, max-age=300"),
    },
  );
}

export function handleOAuthProtectedResourceMetadataRequest(
  request: Request,
  config: GatewayConfig,
  gatewayVersion: string,
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
        headers: headers(gatewayVersion, "no-store"),
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
        headers: headers(gatewayVersion, "no-store", { allow: "GET" }),
      },
    );
  }

  return metadataResponse(config, gatewayVersion);
}
