# Cloudflare Access provenance boundary

This document defines the first public exposure mode for the reference machine.

```text
Internet client
    |
    | CF-Access-Client-Id + CF-Access-Client-Secret
    v
Cloudflare Access
    |
    | signed Cf-Access-Jwt-Assertion
    v
cloudflared Tunnel on Termux
    |  validates Access JWT before proxying
    v
Bun Gateway 127.0.0.1:3000
    |  validates the JWT signature again against Access JWKS
    |  validates issuer + audience + exact service-token Client ID
    |  task registry / admission control / idempotency policy
    v
Rust Queue API 127.0.0.1:7331
    v
SQLite + lease fencing + Sinkhorn scheduler
```

## Why validation exists twice

Cloudflare Tunnel can require Access validation on an ingress route. The Bun gateway still validates `Cf-Access-Jwt-Assertion` cryptographically because loopback callers can otherwise bypass `cloudflared` and manufacture Cloudflare-looking headers.

The gateway fetches signing keys from:

```text
<TEAM_DOMAIN>/cdn-cgi/access/certs
```

It accepts only:

- JWT algorithm `RS256`
- token type `JWT`
- Access application claim `type=app`
- the configured issuer exactly
- the configured Access application audience
- a currently valid token (`exp`, optional `nbf`, optional `iat`, with bounded clock skew)
- service-token authentication (`sub` must be empty)
- the exact configured service-token Client ID in `common_name`
- a signature matching the JWK selected by JWT `kid`

Signing keys are cached for one hour. If refresh temporarily fails, a previously verified key may be used for at most another 24 hours. With no previously cached key, identity verification fails closed.

## Single-principal V1 boundary

This mode intentionally accepts one configured Cloudflare Access Service Token.

The current queue schema does not yet persist a task owner/tenant. Allowing multiple independent principals would therefore create an ambiguous authorization rule for `GET /v1/tasks/<id>`. Multi-principal support must add durable task ownership first rather than pretending that authentication alone provides tenant isolation.

## Gateway environment

Keep the gateway bound to loopback. Do not expose port 3000 directly.

```sh
export GATEWAY_AUTH_MODE='cloudflare_access_service'
export GATEWAY_CF_ACCESS_TEAM_DOMAIN='https://<TEAM_NAME>.cloudflareaccess.com'
export GATEWAY_CF_ACCESS_AUD='<ACCESS_APPLICATION_AUD>'
export GATEWAY_CF_ACCESS_SERVICE_TOKEN_CLIENT_ID='<SERVICE_TOKEN_CLIENT_ID>'

task-queue-bun run gateway/src/server.ts
```

In this mode `GATEWAY_API_TOKEN` is not required. `GATEWAY_ALLOW_UNAUTHENTICATED=1` is rejected as an incompatible configuration.

The service-token **Client Secret is never configured on the gateway**. It belongs only to the external client and Cloudflare Access. Never commit it to this repository.

## Tunnel ingress

`gateway/cloudflare.example.yml` is a locally-managed reference configuration. The important invariant is:

```yaml
service: http://127.0.0.1:3000
originRequest:
  access:
    required: true
    teamName: <TEAM_NAME>
    audTag:
      - <ACCESS_APPLICATION_AUD>
```

and the final catch-all must remain:

```yaml
- service: http_status:404
```

Validate a locally-managed configuration before starting the tunnel:

```sh
cloudflared tunnel ingress validate
```

A remotely-managed tunnel can express the same public-hostname origin settings in the Cloudflare dashboard.

## Client request

A machine client authenticates to Cloudflare with its Access Service Token and separately supplies the queue request's `Idempotency-Key`:

```sh
curl 'https://<PUBLIC_HOSTNAME>/v1/tasks' \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H 'Idempotency-Key: request-123' \
  -H 'Content-Type: application/json' \
  --data-binary '{
    "type":"document.process",
    "payload":{"document_id":"abc"},
    "priority":10,
    "max_retries":3
  }'
```

Cloudflare converts successful Access authentication into a signed application JWT forwarded as `Cf-Access-Jwt-Assertion`. The caller does not choose the trusted principal by sending that assertion directly.

For Cloudflare mode, the public `Idempotency-Key` is combined with the verified principal scope and SHA-256 hashed before it enters the private Rust protocol. Neither the external key nor service-token Client ID is stored as the private idempotency key.

## Live Termux proof harness

`gateway/tests/cloudflare-live-smoke.sh` is the physical proof harness for the real Access application and tunnel. It starts an isolated Rust daemon and Bun gateway locally, then drives requests through the public hostname.

Keep the Service Token Client Secret only in the Termux environment. A safe interactive setup is:

```sh
export CF_PUBLIC_ORIGIN='https://queue.example.com'
export CF_ACCESS_CLIENT_ID='YOUR_CLIENT_ID.access'
read -rsp 'Cloudflare Access Client Secret: ' CF_ACCESS_CLIENT_SECRET
export CF_ACCESS_CLIENT_SECRET
printf '\n'

export GATEWAY_CF_ACCESS_TEAM_DOMAIN='https://YOUR-TEAM.cloudflareaccess.com'
export GATEWAY_CF_ACCESS_AUD='YOUR_ACCESS_APPLICATION_AUD'

TASK_QUEUE_RUST_BIN="$HOME/pr13-bin/robust-sinkhorn-queue-aarch64-linux-android" \
TASK_QUEUE_BUN_BIN="$HOME/.local/bin/task-queue-bun" \
sh gateway/tests/cloudflare-live-smoke.sh

unset CF_ACCESS_CLIENT_SECRET
```

The script never prints the Client Secret. It proves that:

- a forged `Cf-Access-Jwt-Assertion` sent directly to localhost returns `401`;
- public requests without Access credentials are rejected;
- a deliberately wrong Service Token secret is rejected;
- the valid Service Token is accepted;
- the first accepted task is `task_id=1`, proving rejected attempts never reached Rust;
- the public path reaches Bun -> Rust -> SQLite;
- replay with the same public `Idempotency-Key` returns the same task;
- changed content with that key returns `409`;
- the public task snapshot still hides payload.

Expected final line:

```text
Cloudflare Access -> Termux provenance integration: OK
```

## Proof obligations before public use

The boundary is considered proven only when all of these hold on the physical Termux device:

1. Rust still binds only to `127.0.0.1:7331`.
2. Bun still binds only to `127.0.0.1:3000`.
3. `cloudflared tunnel ingress validate` accepts the configured ingress rules.
4. A public request without the Access Service Token is rejected by Cloudflare before reaching Bun.
5. A valid Access Service Token reaches Bun and successfully enqueues through Rust/SQLite.
6. A direct localhost request that only forges `Cf-Access-Jwt-Assertion` is rejected by Bun's signature/claim validation.
7. A token for the wrong Access audience is rejected.
8. A token for a different Service Token Client ID is rejected.
9. Repeating a valid request with the same `Idempotency-Key` returns the same task ID.
10. No Cloudflare credential or service-token secret is written to repository files or public responses.

Until the physical public-path proof is complete, Cloudflare exposure remains an unresolved deployment obligation rather than an assumed property.
