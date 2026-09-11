# MCP OAuth resource discovery

Task-que-que can advertise its public MCP endpoint as an OAuth protected resource without changing the internal capability proof boundary.

This phase implements resource-server discovery only. It does **not** add an authorization endpoint, token endpoint, refresh-token store, Dynamic Client Registration, or Client ID Metadata Document validation. Existing root and `tqq1.*` capability-session tokens remain the only accepted Task-que-que bearer tokens until a later authorization-server integration is proven.

## Configuration

Configure a stable public HTTPS origin and the HTTPS issuer URL of the authorization server that will eventually issue tokens for this resource:

```sh
GATEWAY_PUBLIC_ORIGIN=https://mcp.example.com
GATEWAY_OAUTH_AUTHORIZATION_SERVER=https://auth.example.com/tenant
```

`GATEWAY_PUBLIC_ORIGIN` must be an HTTPS origin with no path, query, fragment, or embedded credentials. `GATEWAY_OAUTH_AUTHORIZATION_SERVER` must be an absolute HTTPS issuer URL and may contain an issuer path.

When both values are configured, Task-que-que serves equivalent RFC 9728 Protected Resource Metadata at:

```text
https://mcp.example.com/.well-known/oauth-protected-resource
https://mcp.example.com/.well-known/oauth-protected-resource/mcp
```

The path-aware form corresponds to the protected MCP resource `https://mcp.example.com/mcp`.

An unauthenticated MCP request receives a challenge shaped as:

```text
WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"
```

The metadata document advertises:

```json
{
  "resource": "https://mcp.example.com/mcp",
  "authorization_servers": ["https://auth.example.com/tenant"],
  "bearer_methods_supported": ["header"],
  "resource_name": "Task-que-que MCP"
}
```

## Security boundary

OAuth discovery is public metadata, not authority. Serving this document does not create a new execution path and does not authorize requests.

The request path remains:

```text
MCP client
  -> /mcp
  -> existing MCP validation
  -> bearer resolution
  -> capability grant
  -> normal gateway router
  -> provider proof boundary
```

The OAuth discovery wrapper only augments an existing MCP `401` response with a standards-facing `resource_metadata` pointer. It does not alter successful MCP requests, provider routing, signed capability sessions, root-token handling, or registered-process execution.

## Deployment note

A stable HTTPS origin is strongly preferred for OAuth. Account-less Quick Tunnel URLs are useful for physical MCP transport proofs, but their hostname is ephemeral. A named tunnel or another stable HTTPS domain is a better fit before enabling a real authorization-code flow.

## Next authorization phase

A later PR can bind an OAuth 2.1 authorization server to the existing capability model. That phase must define and prove:

- authorization-code + PKCE behavior;
- issuer and redirect-URI validation;
- Client ID Metadata Documents and/or compatibility DCR;
- token audience/resource binding;
- mapping OAuth scopes to Task-que-que depth, authority, and exact capability scopes;
- refresh and revocation semantics;
- physical interoperability with a real external MCP client.

Until those invariants are proven, this discovery layer deliberately does not pretend to be a complete OAuth authorization server.
