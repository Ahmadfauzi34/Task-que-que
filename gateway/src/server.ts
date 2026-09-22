import { TokenBucketAdmissionController } from "./admission";
import { MAX_PUBLIC_REQUEST_BYTES } from "./app";
import { loadGatewayConfig } from "./config";
import {
  handleMcpRequestWithOAuthDiscovery,
  MCP_ENDPOINT,
  MCP_PROTOCOL_VERSION,
} from "./mcp-oauth";
import { OAuthAuthorizationCodeStore } from "./oauth-authorization-code-store";
import { loadOAuthPublicClientPolicy } from "./oauth-public-client-policy";
import {
  createCurlBackedCimdDiscoveryDependencies,
} from "./oauth-cimd-curl-transport";
import { deriveOAuthCapabilityGrant } from "./oauth-scope-grant";
import { PendingOAuthConsentStore } from "./oauth-pending-consent-store";
import { TASK_REGISTRY } from "./registry";
import { routeGatewayRequest } from "./router";

const config = loadGatewayConfig();
const admissionController = new TokenBucketAdmissionController(
  config.enqueueRatePerSecond,
  config.enqueueBurst,
);
const oauthPendingConsentStore = new PendingOAuthConsentStore();
const oauthAuthorizationCodeStore = new OAuthAuthorizationCodeStore();
const oauthPublicClientPolicy = loadOAuthPublicClientPolicy(
  process.env,
  config.publicOrigin,
);

const configuredCimdCurlBin =
  process.env.GATEWAY_CIMD_CURL_BIN
    ?.trim()
  || null;

if (
  configuredCimdCurlBin
  && (
    !config.publicOrigin
    || config.oauthAuthorizationServer
      !== config.publicOrigin
  )
) {
  throw new Error(
    "GATEWAY_CIMD_CURL_BIN requires a self-hosted OAuth authorization server",
  );
}

const oauthCimdDiscovery =
  configuredCimdCurlBin
    ? createCurlBackedCimdDiscoveryDependencies(
        configuredCimdCurlBin,
      )
    : null;
if (oauthPublicClientPolicy) {
  const mapped = deriveOAuthCapabilityGrant(
    oauthPublicClientPolicy.scopes,
  );
  if (!mapped.ok) {
    throw new Error(
      `configured OAuth scope cannot map to capability authority: ${mapped.scope ?? mapped.error}`,
    );
  }
}

const dependencies = {
  config,
  registry: TASK_REGISTRY,
  admissionController,
  providerFetchImpl: fetch,
  oauthPendingConsentStore,
  oauthAuthorizationCodeStore,
  oauthPublicClientPolicy,
  oauthCimdDiscovery,
};

const server = Bun.serve({
  hostname: config.hostname,
  port: config.port,
  maxRequestBodySize: MAX_PUBLIC_REQUEST_BYTES,
  idleTimeout: 10,
  async fetch(request) {
    const mcpResponse = await handleMcpRequestWithOAuthDiscovery(
      request,
      dependencies,
      (inner) => routeGatewayRequest(inner, dependencies),
    );
    return mcpResponse ?? routeGatewayRequest(request, dependencies);
  },
  error(error) {
    console.error("gateway request failure", error);
    return new Response('{"error":{"code":"internal_error","message":"internal gateway error"}}\n', {
      status: 500,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  },
});

console.log("Task Queue Bun Gateway");
console.log(`listen : http://${config.hostname}:${server.port}`);
console.log(`queue  : ${config.queueDaemonOrigin}`);
console.log(`broker : ${config.workerBrokerOrigin}`);
console.log(`auth   : ${config.allowUnauthenticated ? "explicitly disabled" : "bearer token required"}`);
console.log(`tasks  : ${Object.keys(TASK_REGISTRY).join(", ") || "none"}`);
console.log(`enqueue: ${config.enqueueRatePerSecond}/s, burst ${config.enqueueBurst}`);
console.log(`mcp    : ${MCP_ENDPOINT} (${MCP_PROTOCOL_VERSION})`);
console.log(`oauth resource discovery: ${config.oauthAuthorizationServer ? "configured" : "disabled"}`);
console.log(`filesystem: ${config.filesystemRoot ? "scoped read-only provider configured" : "disabled"}`);
console.log(`process: ${config.processRegistryFile && config.processExecBin ? "registered fixed operations configured" : "disabled"}`);
console.log("capability api: /v1/capabilities");
console.log("capability sessions: /v1/capability-sessions");
const localOAuthConfigured =
  config.oauthAuthorizationServer
    === config.publicOrigin
  && !!config.publicOrigin
  && (
    !!oauthPublicClientPolicy
    || !!oauthCimdDiscovery
  );

console.log(`oauth authorize: ${localOAuthConfigured ? "/oauth/authorize" : "disabled"}`);
console.log(`oauth token: ${localOAuthConfigured ? "/oauth/token" : "disabled"}`);
console.log(`oauth CIMD: ${oauthCimdDiscovery ? "peer-pinned curl discovery enabled" : "disabled"}`);
console.log("oauth consent operator: /v1/oauth/pending-consents (root bearer only)");
console.log("workflow api: /v1/workflows");
console.log("status : ready");
