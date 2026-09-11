import { TokenBucketAdmissionController } from "./admission";
import { MAX_PUBLIC_REQUEST_BYTES } from "./app";
import { loadGatewayConfig } from "./config";
import {
  handleMcpRequestWithRegisteredProcesses,
  MCP_ENDPOINT,
  MCP_PROTOCOL_VERSION,
} from "./mcp-process";
import { TASK_REGISTRY } from "./registry";
import { routeGatewayRequest } from "./router";

const config = loadGatewayConfig();
const admissionController = new TokenBucketAdmissionController(
  config.enqueueRatePerSecond,
  config.enqueueBurst,
);
const dependencies = {
  config,
  registry: TASK_REGISTRY,
  admissionController,
  providerFetchImpl: fetch,
};

const server = Bun.serve({
  hostname: config.hostname,
  port: config.port,
  maxRequestBodySize: MAX_PUBLIC_REQUEST_BYTES,
  idleTimeout: 10,
  async fetch(request) {
    const mcpResponse = await handleMcpRequestWithRegisteredProcesses(
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
console.log(`filesystem: ${config.filesystemRoot ? "scoped read-only provider configured" : "disabled"}`);
console.log(`process: ${config.processRegistryFile && config.processExecBin ? "registered fixed operations configured" : "disabled"}`);
console.log("capability api: /v1/capabilities");
console.log("capability sessions: /v1/capability-sessions");
console.log("workflow api: /v1/workflows");
console.log("status : ready");