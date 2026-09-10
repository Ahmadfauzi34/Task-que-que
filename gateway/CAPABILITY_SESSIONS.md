# Capability sessions

Capability sessions bind the D0-D6 depth model and A0-A4 authority model to a bearer credential issued by the Task-que-que gateway.

They are an attenuation mechanism for external agents, not a client-asserted permission header and not a sandbox-escape primitive.

## Authority transition

```text
root operator bearer
        ↓
POST /v1/capability-sessions
        ↓
server validates requested D/A/scopes/TTL
        ↓
HMAC-signed bounded session token
        ↓
agent request
        ↓
verify signature + expiry
        ↓
capability depth/authority/scope proof
        ↓
public gateway facade
        ↓
existing admission / exact routing / fencing
```

Only the exact configured root bearer may mint sessions. Explicit unauthenticated development mode does not become a signing authority.

A session token contains a random session id, issue time, expiry, depth, authority and scopes. The maximum lifetime is 24 hours. The client cannot increase authority by editing claims because the complete payload is authenticated by the server signature.

## Internal delegation

After a session request passes its public capability proof, the gateway translates that request to the existing internal root-authenticated facade. This is deliberate: an agent granted `workflow.submit` should not also need the private `workflow.run` executor scope merely because the gateway implements the public workflow facade using that internal registered task.

```text
agent session grant
        ↓
public workflow.submit proof
        ↓
trusted gateway transition
        ↓
internal workflow.run
```

The transition exists only inside the gateway router. The original session token is not forwarded to the Rust queue.

## Compatibility

The existing root bearer retains the PR #40 compatibility grant (`D6/A4/*`). Existing public task/workflow behavior therefore stays available to the operator while MCP clients can be issued narrower sessions.

The next MCP adapter should consume the same authenticated session context and capability registry rather than inventing a separate MCP permission model.
