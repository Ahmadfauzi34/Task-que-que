export interface OAuthAuthorizationCodeBinding {
  code: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  codeChallenge: string;
}

export interface ValidatedOAuthTokenRequest {
  grantType: "authorization_code";
  code: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  codeVerifier: string;
}

export type OAuthTokenValidationErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_target";

export type OAuthTokenValidationResult =
  | { ok: true; value: ValidatedOAuthTokenRequest }
  | {
      ok: false;
      error: OAuthTokenValidationErrorCode;
      description: string;
    };

const TOKEN_PARAMS = [
  "grant_type",
  "code",
  "client_id",
  "redirect_uri",
  "resource",
  "code_verifier",
] as const;

const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();

function failure(
  error: OAuthTokenValidationErrorCode,
  description: string,
): OAuthTokenValidationResult {
  return { ok: false, error, description };
}

function exactSingleValue(
  params: URLSearchParams,
  name: (typeof TOKEN_PARAMS)[number],
): string | null | "duplicate" {
  const values = params.getAll(name);
  if (values.length === 0) return null;
  if (values.length !== 1) return "duplicate";
  return values[0]!;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function pkceS256Challenge(verifier: string): Promise<string | null> {
  if (!PKCE_VERIFIER.test(verifier)) return null;
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export async function validateOAuthTokenRequest(
  params: URLSearchParams,
  binding: OAuthAuthorizationCodeBinding,
): Promise<OAuthTokenValidationResult> {
  if (
    !binding.code
    || !binding.clientId
    || !binding.redirectUri
    || !binding.resource
    || !PKCE_CHALLENGE.test(binding.codeChallenge)
  ) {
    return failure("invalid_grant", "authorization-code binding is invalid");
  }

  const values = new Map<string, string | null>();
  for (const name of TOKEN_PARAMS) {
    const value = exactSingleValue(params, name);
    if (value === "duplicate") {
      return failure("invalid_request", `duplicate ${name} parameter`);
    }
    values.set(name, value);
  }

  if (values.get("grant_type") !== "authorization_code") {
    return failure("invalid_request", "grant_type must be authorization_code");
  }

  if (values.get("client_id") !== binding.clientId) {
    return failure("invalid_client", "client_id does not match the authorization code");
  }

  if (values.get("redirect_uri") !== binding.redirectUri) {
    return failure("invalid_grant", "redirect_uri does not match the authorization code");
  }

  if (values.get("resource") !== binding.resource) {
    return failure("invalid_target", "resource does not match the authorization code");
  }

  const code = values.get("code");
  if (code === null || code !== binding.code) {
    return failure("invalid_grant", "authorization code is invalid");
  }

  const codeVerifier = values.get("code_verifier");
  if (codeVerifier === null || !PKCE_VERIFIER.test(codeVerifier)) {
    return failure("invalid_grant", "PKCE code_verifier is invalid");
  }

  const derivedChallenge = await pkceS256Challenge(codeVerifier);
  if (derivedChallenge !== binding.codeChallenge) {
    return failure("invalid_grant", "PKCE verification failed");
  }

  return {
    ok: true,
    value: Object.freeze({
      grantType: "authorization_code" as const,
      code,
      clientId: binding.clientId,
      redirectUri: binding.redirectUri,
      resource: binding.resource,
      codeVerifier,
    }),
  };
}
