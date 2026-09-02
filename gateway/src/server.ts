import { TokenBucketAdmissionController } from "./admission";
import { handleRequest, MAX_PUBLIC_REQUEST_BYTES } from "./app";
import { loadGatewayConfig } from "./config";
import { TASK_REGISTRY } from "./registry";
import { handleDeclaredWorkflowResultRequest } from "./workflow-results";
import { handlePublicWorkflowRequest } from "./workflows";

const config = loadGatewayConfig();
const admissionController = new TokenBucketAdmissionController(
  config.enqueueRatePerSecond,
  config.enqueueBurst,
);
const dependencies = {
  config,
  registry: TASK_REGISTRY,
  admissionController,
};

const server = Bun.serve({
  hostname: config.hostname,
  port: config.port,
  maxRequestBodySize: MAX_PUBLIC_REQUEST_BYTES,
  idleTimeout: 10,
  async fetch(request) {
    const declaredResult = await handleDeclaredWorkflowResultRequest(request, dependencies);
    if (declaredResult) return declaredResult;
    const workflowResponse = await handlePublicWorkflowRequest(request, dependencies);
    return workflowResponse ?? handleRequest(request, dependencies);
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
console.log(`auth   : ${config.allowUnauthenticated ? "explicitly disabled" : "bearer token required"}`);
console.log(`tasks  : ${Object.keys(TASK_REGISTRY).join(", ") || "none"}`);
console.log(`enqueue: ${config.enqueueRatePerSecond}/s, burst ${config.enqueueBurst}`);
console.log("workflow api: /v1/workflows");
console.log("status : ready");
