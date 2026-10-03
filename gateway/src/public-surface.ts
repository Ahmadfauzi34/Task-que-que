import {
  GATEWAY_VERSION,
  handleRequest,
  type GatewayDependencies,
} from "./app";
import { handleOAuthProtectedResourceMetadataRequest } from "./oauth-resource-metadata";

export async function handlePublicSurfaceRequest(
  request: Request,
  dependencies: GatewayDependencies,
): Promise<Response> {
  const selfHostedScopes =
    dependencies.config.oauthAuthorizationServer
      === dependencies.config.publicOrigin
      ? [
          ...new Set([
            ...(
              dependencies.oauthPublicClientPolicy
                ?.scopes
              ?? []
            ),
            ...(
              dependencies.oauthCimdDiscovery
                ? ["capability.read"]
                : []
            ),
          ]),
        ]
      : [];

  const oauthMetadata =
    handleOAuthProtectedResourceMetadataRequest(
      request,
      dependencies.config,
      GATEWAY_VERSION,
      selfHostedScopes,
    );
  return oauthMetadata ?? handleRequest(request, dependencies);
}
