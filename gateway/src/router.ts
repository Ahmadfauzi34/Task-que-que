import type { GatewayDependencies } from "./app";
import { enforceCapabilityAccess } from "./capability-access";
import { handleCapabilityRequest } from "./capability-api";
import { handleCapabilitySessionRequest } from "./capability-session-api";
import { handleOAuthAuthorizationRequest } from "./oauth-authorization-api";
import { handleOAuthAuthorizationServerMetadataRequest } from "./oauth-authorization-server-metadata";
import { handleOAuthConsentOperatorRequest } from "./oauth-consent-operator-api";
import { handleOAuthTokenRequest } from "./oauth-token-api";
import { handleFilesystemRequest } from "./filesystem-api";
import { handleFilesystemMutationRequest } from "./filesystem-mutation-api";
import { handleGitMetadataRequest } from "./git-api";
import { handleRegisteredProcessRequest } from "./process-api";
import { handlePublicSurfaceRequest } from "./public-surface";
import { handleDeclaredWorkflowResultRequest } from "./workflow-results";
import { handlePublicWorkflowRequest } from "./workflows";

export async function routeGatewayRequest(
  request: Request,
  dependencies: GatewayDependencies,
): Promise<Response> {
  const sessionResponse = await handleCapabilitySessionRequest(request, dependencies);
  if (sessionResponse) return sessionResponse;

  const consentOperatorResponse = await handleOAuthConsentOperatorRequest(
    request,
    dependencies.config,
    dependencies.oauthPendingConsentStore,
  );
  if (consentOperatorResponse) return consentOperatorResponse;

  const oauthMetadataResponse = handleOAuthAuthorizationServerMetadataRequest(
    request,
    dependencies.config,
    dependencies.oauthPublicClientPolicy,
  );
  if (oauthMetadataResponse) return oauthMetadataResponse;

  const oauthAuthorizationResponse = await handleOAuthAuthorizationRequest(
    request,
    dependencies.config,
    dependencies.oauthPublicClientPolicy,
    dependencies.oauthPendingConsentStore,
    dependencies.oauthAuthorizationCodeStore,
  );
  if (oauthAuthorizationResponse) return oauthAuthorizationResponse;

  const oauthTokenResponse = await handleOAuthTokenRequest(
    request,
    dependencies.config,
    dependencies.oauthPublicClientPolicy,
    dependencies.oauthAuthorizationCodeStore,
  );
  if (oauthTokenResponse) return oauthTokenResponse;

  const capabilityResponse = await handleCapabilityRequest(request, dependencies);
  if (capabilityResponse) return capabilityResponse;

  const enforced = await enforceCapabilityAccess(request, dependencies);
  if (enforced instanceof Response) return enforced;

  const processResponse = await handleRegisteredProcessRequest(enforced, dependencies);
  if (processResponse) return processResponse;

  const filesystemResponse = await handleFilesystemRequest(enforced, dependencies);
  if (filesystemResponse) return filesystemResponse;

  const filesystemMutationResponse = await handleFilesystemMutationRequest(
    enforced,
    dependencies,
  );
  if (filesystemMutationResponse) return filesystemMutationResponse;

  const gitMetadataResponse = await handleGitMetadataRequest(enforced, dependencies);
  if (gitMetadataResponse) return gitMetadataResponse;

  const declaredResult = await handleDeclaredWorkflowResultRequest(enforced, dependencies);
  if (declaredResult) return declaredResult;

  const workflowResponse = await handlePublicWorkflowRequest(enforced, dependencies);
  return workflowResponse ?? handlePublicSurfaceRequest(enforced, dependencies);
}
