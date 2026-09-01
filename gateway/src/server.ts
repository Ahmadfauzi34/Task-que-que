import { TokenBucketAdmissionController } from "./admission";
import { handleRequest, MAX_PUBLIC_REQUEST_BYTES } from "./app";
import { CloudflareAccessServiceVerifier } from "./cloudflare_access";
import { loadGatewayConfig } from "./config";
import { TASK_REGISTRY } from "./registry";

const config = loadGatewayConfig();
const admissionController = new TokenBucketAdmissionController(
  config.enqueueRatePerSecond,
  config.enqueueBurst,
);
const cloudflareAccessVerifier =
  config.authMode === "cloudflare_access_service"
    ? new CloudflareAccessServiceVerifier({
        teamDomain: config.cloudflareAccessTeamDomain!,
        audience: config.cloudflareAccessAudience!,
        serviceTokenClientId: config.cloudflareAccessServiceTokenClientId!,
      })
    : undefined;

const server = Bun.serve({
  hostname: config.hostname,
  port: config.port,
  maxRequestBodySize: MAX_PUBLIC_REQUEST_BYTES,
  idleTimeout: 10,
  fetch(request) {
    return handleRequest(request, {
      config,
      registry: TASK_REGISTRY,
      admissionController,
      cloudflareAccessVerifier,
    });
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
console.log(
  `auth   : ${
    config.allowUnauthenticated
      ? "explicitly disabled"
      : config.authMode === "bearer"
        ? "bearer token required"
        : "Cloudflare Access service JWT required"
  }`,
);
console.log(`tasks  : ${Object.keys(TASK_REGISTRY).join(", ") || "none"}`);
console.log(`enqueue: ${config.enqueueRatePerSecond}/s, burst ${config.enqueueBurst}`);
console.log("status : ready");
