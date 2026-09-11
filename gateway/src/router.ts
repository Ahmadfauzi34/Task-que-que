import { handleRequest, type GatewayDependencies } from "./app";
import { enforceCapabilityAccess } from "./capability-access";
import { handleCapabilityRequest } from "./capability-api";
import { handleCapabilitySessionRequest } from "./capability-session-api";
import { handleFilesystemRequest } from "./filesystem-api";
import { handleFilesystemMutationRequest } from "./filesystem-mutation-api";
import { handleGitMetadataRequest } from "./git-api";
import { handleRegisteredProcessRequest } from "./process-api";
import { handleDeclaredWorkflowResultRequest } from "./workflow-results";
import { handlePublicWorkflowRequest } from "./workflows";

export async function routeGatewayRequest(
  request: Request,
  dependencies: GatewayDependencies,
): Promise<Response> {
  const sessionResponse = await handleCapabilitySessionRequest(request, dependencies);
  if (sessionResponse) return sessionResponse;

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
  return workflowResponse ?? handleRequest(enforced, dependencies);
}
