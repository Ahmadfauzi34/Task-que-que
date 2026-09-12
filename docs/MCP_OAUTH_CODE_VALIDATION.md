# MCP OAuth authorization-code validation boundary

This phase implements only pure validation primitives for the future Task-que-que OAuth 2.1 authorization server.

It does **not** expose `/oauth/authorize` or `/oauth/token`, store pending requests, issue authorization codes, redeem codes, or mint bearer tokens.

## Authorization request validator

The validator accepts only requests that satisfy all of these invariants:

- `response_type=code`
- exact pre-registered `client_id`
- exact pre-registered `redirect_uri`
- exact configured MCP `resource`
- requested scope is a unique non-empty subset of the operator-configured client scope ceiling
- PKCE `code_challenge_method=S256`
- canonical 43-character base64url SHA-256 challenge shape
- duplicate security-sensitive parameters are rejected
- `state` may be omitted, but if present must be non-empty

No redirect authority or consent state is created by this validator.

## Token request validator

The token validator is also stateless. It accepts a form request plus an immutable authorization-code binding supplied by a future state store and verifies:

- `grant_type=authorization_code`
- exact `client_id`
- exact `redirect_uri`
- exact `resource`
- exact authorization code value
- RFC 7636 verifier syntax
- SHA-256 verifier-to-challenge match
- duplicate security-sensitive parameters are rejected

The validator cannot mark a code as used and cannot issue a token. Single-use redemption remains the responsibility of a later bounded state-store phase.

## Why this phase is separate

Task-que-que treats OAuth as an acquisition layer in front of the existing capability authority. Reject-path validation is therefore proven before adding mutable authorization state.

The later stateful phase must preserve these invariants and additionally prove:

- operator-controlled consent
- bounded pending/code state
- short TTLs
- single-use code consumption
- exact issuer and resource binding
- successful exchange maps only to bounded D/A/scopes authority
- persistent root bearer never reaches the browser or remote MCP client
