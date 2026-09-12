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
  const oauthMetadata = handleOAuthProtectedResourceMetadataRequest(
    request,
    dependencies.config,
    GATEWAY_VERSION,
  );
  return oauthMetadata ?? handleRequest(request, dependencies);
}
