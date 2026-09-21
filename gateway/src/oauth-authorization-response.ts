import type {
  ValidatedOAuthAuthorizationRequest,
} from "./oauth-authorization-validation";

const encoder = new TextEncoder();

const MAX_URI_BYTES = 4_096;
const MAX_ERROR_DESCRIPTION_BYTES = 512;
const MAX_STATE_BYTES = 1_024;
const AUTHORIZATION_CODE = /^[A-Za-z0-9_-]{32,128}$/;
const OAUTH_ERROR = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

const RESERVED_RESPONSE_PARAMS = new Set([
  "code",
  "error",
  "error_description",
  "error_uri",
  "state",
  "iss",
]);

export type OAuthAuthorizationResponseBuildError =
  | "invalid_redirect_uri"
  | "ambiguous_redirect_uri"
  | "invalid_issuer"
  | "invalid_code"
  | "invalid_error";

export type OAuthAuthorizationResponseBuildResult =
  | {
      ok: true;
      redirectUri: string;
    }
  | OAuthAuthorizationResponseBuildFailure;

interface OAuthAuthorizationResponseBuildFailure {
  ok: false;
  error: OAuthAuthorizationResponseBuildError;
}

interface PreparedOAuthRedirect {
  ok: true;
  redirect: URL;
  issuer: string;
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function parseRedirectUri(
  request: ValidatedOAuthAuthorizationRequest,
): URL | null {
  if (
    request.responseType !== "code"
    || request.redirectUri.length === 0
    || byteLength(request.redirectUri) > MAX_URI_BYTES
  ) {
    return null;
  }

  let redirect: URL;
  try {
    redirect = new URL(request.redirectUri);
  } catch {
    return null;
  }

  if (
    redirect.protocol !== "https:"
    || redirect.username
    || redirect.password
    || redirect.hash
  ) {
    return null;
  }

  return redirect;
}

function redirectHasReservedResponseParams(redirect: URL): boolean {
  for (const key of redirect.searchParams.keys()) {
    if (RESERVED_RESPONSE_PARAMS.has(key)) {
      return true;
    }
  }
  return false;
}

function normalizeIssuer(issuer: string): string | null {
  if (!issuer || byteLength(issuer) > MAX_URI_BYTES) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return null;
  }

  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    return null;
  }

  return issuer;
}

function prepareRedirect(
  request: ValidatedOAuthAuthorizationRequest,
  issuer: string,
): OAuthAuthorizationResponseBuildFailure | PreparedOAuthRedirect {
  const redirect = parseRedirectUri(request);
  if (!redirect) {
    return {
      ok: false,
      error: "invalid_redirect_uri",
    };
  }

  if (
    request.state !== null
    && (
      request.state.length === 0
      || byteLength(request.state) > MAX_STATE_BYTES
    )
  ) {
    return {
      ok: false,
      error: "invalid_redirect_uri",
    };
  }

  if (redirectHasReservedResponseParams(redirect)) {
    return {
      ok: false,
      error: "ambiguous_redirect_uri",
    };
  }

  const normalizedIssuer = normalizeIssuer(issuer);
  if (!normalizedIssuer) {
    return {
      ok: false,
      error: "invalid_issuer",
    };
  }

  return {
    ok: true,
    redirect,
    issuer: normalizedIssuer,
  };
}

function appendCommonResponseParams(
  params: URLSearchParams,
  request: ValidatedOAuthAuthorizationRequest,
  issuer: string,
): void {
  if (request.state !== null) {
    params.append("state", request.state);
  }
  params.append("iss", issuer);
}

function appendResponseQuery(
  exactRedirectUri: string,
  params: URLSearchParams,
): string {
  const separator =
    exactRedirectUri.endsWith("?") || exactRedirectUri.endsWith("&")
      ? ""
      : exactRedirectUri.includes("?")
        ? "&"
        : "?";
  return `${exactRedirectUri}${separator}${params.toString()}`;
}

export function buildOAuthAuthorizationSuccessRedirect(
  request: ValidatedOAuthAuthorizationRequest,
  issuer: string,
  code: string,
): OAuthAuthorizationResponseBuildResult {
  if (!AUTHORIZATION_CODE.test(code)) {
    return {
      ok: false,
      error: "invalid_code",
    };
  }

  const prepared = prepareRedirect(request, issuer);
  if (!prepared.ok) return prepared;

  const params = new URLSearchParams();
  params.append("code", code);
  appendCommonResponseParams(
    params,
    request,
    prepared.issuer,
  );

  return {
    ok: true,
    redirectUri: appendResponseQuery(
      request.redirectUri,
      params,
    ),
  };
}

export function buildOAuthAuthorizationErrorRedirect(
  request: ValidatedOAuthAuthorizationRequest,
  issuer: string,
  error: string,
  description: string | null = null,
): OAuthAuthorizationResponseBuildResult {
  if (
    !OAUTH_ERROR.test(error)
    || (
      description !== null
      && (
        description.length === 0
        || byteLength(description) > MAX_ERROR_DESCRIPTION_BYTES
        || /[\r\n]/.test(description)
      )
    )
  ) {
    return {
      ok: false,
      error: "invalid_error",
    };
  }

  const prepared = prepareRedirect(request, issuer);
  if (!prepared.ok) return prepared;

  const params = new URLSearchParams();
  params.append("error", error);
  if (description !== null) {
    params.append(
      "error_description",
      description,
    );
  }

  appendCommonResponseParams(
    params,
    request,
    prepared.issuer,
  );

  return {
    ok: true,
    redirectUri: appendResponseQuery(
      request.redirectUri,
      params,
    ),
  };
}
