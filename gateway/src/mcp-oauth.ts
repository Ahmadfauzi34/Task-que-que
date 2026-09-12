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

  const challenge = oauthBearerChallenge(dependencies.config);
  if (challenge === "Bearer") return response;

  const headers = new Headers(response.headers);
  headers.set("www-authenticate", challenge);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
