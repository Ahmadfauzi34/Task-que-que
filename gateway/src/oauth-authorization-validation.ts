export interface OAuthPublicClientPolicy {
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: readonly string[];
}

export interface ValidatedOAuthAuthorizationRequest {
  responseType: "code";
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: readonly string[];
  state: string | null;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}

export type OAuthAuthorizationValidationErrorCode =
  | "invalid_request"
  | "unauthorized_client"
  | "unsupported_response_type"
  | "invalid_redirect_uri"
  | "invalid_target"
  | "invalid_scope"
  | "invalid_code_challenge";

export type OAuthAuthorizationValidationResult =
  | { ok: true; value: ValidatedOAuthAuthorizationRequest }
  | {
      ok: false;
      error: OAuthAuthorizationValidationErrorCode;
      description: string;
      redirectAllowed: boolean;
    };

const SINGLE_VALUE_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "resource",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
] as const;

const PKCE_S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

function failure(
  error: OAuthAuthorizationValidationErrorCode,
  description: string,
  redirectAllowed = false,
): OAuthAuthorizationValidationResult {
  return { ok: false, error, description, redirectAllowed };
}

function exactSingleValue(
  params: URLSearchParams,
  name: (typeof SINGLE_VALUE_PARAMS)[number],
): string | null | "duplicate" {
  const values = params.getAll(name);
  if (values.length === 0) return null;
  if (values.length !== 1) return "duplicate";
  return values[0]!;
}

function policyIsValid(policy: OAuthPublicClientPolicy): boolean {
  if (!policy.clientId || !policy.redirectUri || !policy.resource) return false;
  if (policy.scopes.length === 0) return false;
  const unique = new Set(policy.scopes);
  return unique.size === policy.scopes.length
    && policy.scopes.every((scope) => scope.length > 0 && SCOPE_TOKEN.test(scope));
}

export function validateOAuthAuthorizationRequest(
  requestUrl: string | URL,
  policy: OAuthPublicClientPolicy,
): OAuthAuthorizationValidationResult {
  if (!policyIsValid(policy)) {
    return failure("invalid_request", "OAuth client policy is invalid");
  }

  let url: URL;
  try {
    url = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
  } catch {
    return failure("invalid_request", "authorization request URL is invalid");
  }

  const values = new Map<string, string | null>();
  for (const name of SINGLE_VALUE_PARAMS) {
    const value = exactSingleValue(url.searchParams, name);
    if (value === "duplicate") {
      return failure("invalid_request", `duplicate ${name} parameter`);
    }
    values.set(name, value);
  }

  const clientId = values.get("client_id");
  if (clientId !== policy.clientId) {
    return failure("unauthorized_client", "client_id is not registered");
  }

  const redirectUri = values.get("redirect_uri");
  if (redirectUri !== policy.redirectUri) {
    return failure(
      "invalid_redirect_uri",
      "redirect_uri does not exactly match the registered URI",
    );
  }

  // From this point onward, the client and redirect URI have both been
  // authenticated against operator-owned policy. A future HTTP handler may
  // return an OAuth error through that exact redirect URI; failures before
  // this point must stay on the authorization server itself.
  const redirectAllowed = true;

  const responseType = values.get("response_type");
  if (responseType !== "code") {
    return failure(
      "unsupported_response_type",
      "response_type must be code",
      redirectAllowed,
    );
  }

  const resource = values.get("resource");
  if (resource !== policy.resource) {
    return failure(
      "invalid_target",
      "resource does not exactly match the configured MCP resource",
      redirectAllowed,
    );
  }

  const rawScope = values.get("scope");
  if (rawScope === null || rawScope.trim().length === 0) {
    return failure("invalid_scope", "scope must be non-empty", redirectAllowed);
  }
  if (rawScope !== rawScope.trim() || rawScope.includes("  ")) {
    return failure(
      "invalid_scope",
      "scope must use single ASCII-space separators",
      redirectAllowed,
    );
  }

  const requestedScopes = rawScope.split(" ");
  const requestedSet = new Set(requestedScopes);
  if (
    requestedSet.size !== requestedScopes.length
    || requestedScopes.some((scope) => !SCOPE_TOKEN.test(scope))
    || requestedScopes.some((scope) => !policy.scopes.includes(scope))
  ) {
    return failure(
      "invalid_scope",
      "requested scopes must be a unique subset of the registered client scopes",
      redirectAllowed,
    );
  }

  const codeChallenge = values.get("code_challenge");
  const codeChallengeMethod = values.get("code_challenge_method");
  if (
    codeChallengeMethod !== "S256"
    || codeChallenge === null
    || !PKCE_S256_CHALLENGE.test(codeChallenge)
  ) {
    return failure(
      "invalid_code_challenge",
      "PKCE S256 with a 43-character base64url challenge is required",
      redirectAllowed,
    );
  }

  const state = values.get("state");
  if (state !== null && state.length === 0) {
    return failure(
      "invalid_request",
      "state must not be empty when present",
      redirectAllowed,
    );
  }

  return {
    ok: true,
    value: Object.freeze({
      responseType: "code" as const,
      clientId,
      redirectUri,
      resource,
      scopes: Object.freeze([...requestedScopes]),
      state,
      codeChallenge,
      codeChallengeMethod: "S256" as const,
    }),
  };
}
