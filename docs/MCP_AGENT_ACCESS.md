# MCP agent access

Task-que-que exposes the MCP endpoint through the same Bun gateway that owns capability authorization. An external agent should receive only a public MCP URL and a short-lived signed capability-session bearer token.

## Operator flow

1. Start the Termux reference machine with the Cloudflare tunnel enabled. The lifecycle stores the current HTTPS origin in `$HOME/.task-queue/public-url` and keeps the persistent gateway root token in `$HOME/.task-queue/gateway-token`.
2. Mint a scoped agent handoff locally on the Android device. A least-privilege discovery-only grant is:

   ```sh
   TASK_QUEUE_AGENT_TTL_SECONDS=900 \
     sh ops/termux-mcp-agent-handoff.sh \
       0 0 capability.read
   ```

   Higher depth or authority should only be added when a specific capability requires it.
3. Give the agent only the emitted `mcp_url` and `authorization` values. Do not give the agent the contents of `gateway-token`.

The handoff command calls `/v1/capability-sessions` only through the local loopback gateway. It emits a signed `tqq1.*` session whose depth, authority, scopes, and expiry are bounded by the requested grant.

## Agent-side shape

A conformant MCP client can use the emitted values as:

```text
MCP URL       = https://<public-origin>/mcp
Authorization = Bearer <signed-capability-session>
```

The official TypeScript MCP v2 client is covered by the repository interoperability proof. It negotiates MCP 2026-07-28 and generates the standard mirrored MCP request headers itself; the operator or agent does not manually construct `Mcp-Method` or `Mcp-Name`.

## Security boundary

- The persistent root bearer remains local to the operator-controlled Termux machine.
- The public handoff contains a short-lived signed session, not the root bearer.
- The session cannot exceed the depth, authority, scopes, or expiry encoded in its signed claims.
- `tools/list` only advertises capabilities executable under the live signed grant and provider state.
- `tools/call` still enters the normal gateway router and provider-specific authorization boundary.
- Registered process operations remain fixed server-owned operations; the agent does not supply executable paths, argv, environment, cwd, or shell text.

The Quick Tunnel URL is transport, not authority. Possession of the URL alone does not authorize MCP capability use.
