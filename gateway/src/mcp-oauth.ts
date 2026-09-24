import type { GatewayDependencies } from "./app";
import {
  handleMcpRequestWithRegisteredProcesses,
  MCP_ENDPOINT,
  MCP_PROTOCOL_VERSION,
} from "./mcp-process";
import type { GatewayInvoker } from "./mcp";
import { oauthBearerChallenge } from "./oauth-resource-metadata";

export { MCP_ENDPOINT, MCP_PROTOCOL_VERSION };

export async function handleMcpRequestWithOAuthDiscovery(
  request: Request,
  dependencies: GatewayDependencies,
  invokeGateway: GatewayInvoker,
): Promise<Response | null> {
  const response = await handleMcpRequestWithRegisteredProcesses(
    request,
    dependencies,
    invokeGateway,
  );
  if (!response || response.status !== 401) return response;

  const selfHostedScopes =
    dependencies.config.oauthAuthorizationServer
      === dependencies.config.publicOrigin
      && (
        dependencies.oauthPublicClientPolicy
          ?.scopes
          .includes("capability.read")
        || !!dependencies.oauthCimdDiscovery
      )
      ? ["capability.read"]
      : [];

  const challenge = oauthBearerChallenge(
    dependencies.config,
    selfHostedScopes,
  );
  if (challenge === "Bearer") return response;

  const headers = new Headers(response.headers);
  headers.set("www-authenticate", challenge);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
