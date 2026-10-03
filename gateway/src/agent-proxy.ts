/**
 * Agent Proxy: expose broker worker API ke agen eksternal via gateway.
 *
 * Agen di environment lain (yang tidak bisa dihubungi langsung) poll
 * task via endpoint ini. Gateway meneruskan ke broker lokal.
 *
 * Endpoints:
 *   POST /v1/agent/register  -> broker /v1/register
 *   POST /v1/agent/claim     -> broker /v1/claim
 *   POST /v1/agent/heartbeat -> broker /v1/task/heartbeat
 *   POST /v1/agent/complete  -> broker /v1/task/complete
 *   POST /v1/agent/fail      -> broker /v1/task/fail
 *
 * Auth: Bearer token yang valid (sama seperti task.submit).
 * Header worker (x-worker-*) diteruskan apa adanya ke broker.
 */

const AGENT_ROUTES: Record<string, string> = {
  "/v1/agent/register": "/v1/register",
  "/v1/agent/claim": "/v1/claim",
  "/v1/agent/heartbeat": "/v1/task/heartbeat",
  "/v1/agent/complete": "/v1/task/complete",
  "/v1/agent/fail": "/v1/task/fail",
  "/v1/agent/session/heartbeat": "/v1/session/heartbeat",
};

export async function handleAgentProxyRequest(
  request: Request,
  brokerOrigin: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const brokerPath = AGENT_ROUTES[url.pathname];
  if (!brokerPath || request.method !== "POST") {
    return null;
  }

  // Teruskan headers yang relevan ke broker
  const forwardHeaders: Record<string, string> = {};
  const allowed = [
    "x-worker-id",
    "x-worker-type",
    "x-worker-capacity",
    "x-worker-tasks",
    "x-worker-session",
    "x-worker-token",
    "x-task-id",
    "x-lease-generation",
    "x-worker-error-code",
    "content-type",
  ];
  for (const name of allowed) {
    const v = request.headers.get(name);
    if (v !== null) forwardHeaders[name] = v;
  }

  const body = await request.arrayBuffer().catch(() => null);

  try {
    const res = await fetch(`${brokerOrigin}${brokerPath}`, {
      method: "POST",
      headers: forwardHeaders,
      body: body && body.byteLength > 0 ? body : undefined,
      signal: AbortSignal.timeout(30000),
    });

    const resBody = await res.arrayBuffer();
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k.toLowerCase().startsWith("content-")) resHeaders[k] = v;
    });

    return new Response(resBody, {
      status: res.status,
      headers: resHeaders,
    });
  } catch (e) {
    return Response.json(
      { error: { code: "broker_unavailable", message: "worker broker unreachable" } },
      { status: 503 },
    );
  }
}
