import { GATEWAY_VERSION } from "./app";
import type { GatewayConfig } from "./config";
import {
  buildOAuthAuthorizationErrorRedirect,
  buildOAuthAuthorizationSuccessRedirect,
} from "./oauth-authorization-response";
import {
  validateOAuthAuthorizationRequest,
  type OAuthPublicClientPolicy,
  type ValidatedOAuthAuthorizationRequest,
} from "./oauth-authorization-validation";
import {
  OAuthAuthorizationCodeStore,
} from "./oauth-authorization-code-store";
import type {
  CimdDiscoveryDependencies,
} from "./oauth-cimd-discovery";
import {
  resolveOAuthAuthorizationClientPolicy,
} from "./oauth-cimd-policy";
import {
  PendingOAuthConsentStore,
} from "./oauth-pending-consent-store";

const AUTHORIZATION_PATH = "/oauth/authorize";
const REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_STATE_BYTES = 1_024;
const encoder = new TextEncoder();

const PREFLIGHT_CODE =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function jsonResponse(
  value: unknown,
  status = 200,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set(
    "content-type",
    "application/json; charset=utf-8",
  );
  headers.set("cache-control", "no-store");
  headers.set(
    "x-gateway-version",
    GATEWAY_VERSION,
  );

  return new Response(
    `${JSON.stringify(value)}\n`,
    {
      status,
      headers,
    },
  );
}

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return jsonResponse(
    {
      error: {
        code,
        message,
      },
    },
    status,
  );
}

function redirectResponse(
  location: string,
): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "cache-control": "no-store",
      "x-gateway-version":
        GATEWAY_VERSION,
    },
  });
}

function selfHostedIssuer(
  config: GatewayConfig,
): string | null {
  if (
    !config.publicOrigin
    || !config.oauthAuthorizationServer
    || config.oauthAuthorizationServer
      !== config.publicOrigin
  ) {
    return null;
  }

  return config.oauthAuthorizationServer;
}

function safeReflectedState(
  url: URL,
): string | null {
  const values =
    url.searchParams.getAll("state");

  if (values.length !== 1) {
    return null;
  }

  const value = values[0]!;
  if (
    value.length === 0
    || encoder.encode(value).byteLength
      > MAX_STATE_BYTES
  ) {
    return null;
  }

  return value;
}

function redirectContext(
  policy: OAuthPublicClientPolicy,
  url: URL,
): ValidatedOAuthAuthorizationRequest {
  return Object.freeze({
    responseType: "code" as const,
    clientId: policy.clientId,
    redirectUri: policy.redirectUri,
    resource: policy.resource,
    scopes: Object.freeze([
      ...policy.scopes,
    ]),
    state: safeReflectedState(url),
    codeChallenge: PREFLIGHT_CODE,
    codeChallengeMethod: "S256" as const,
  });
}

function oauthErrorCode(
  error: string,
): string {
  if (error === "invalid_code_challenge") {
    return "invalid_request";
  }

  return error;
}

function pendingResponse(
  requestId: string,
  expiresAtMs: number,
  issuer: string,
): Response {
  const continueUrl =
    new URL(AUTHORIZATION_PATH, issuer);

  continueUrl.searchParams.set(
    "request_id",
    requestId,
  );

  return jsonResponse(
    {
      schema_version: 1,
      status: "pending_operator_consent",
      request_id: requestId,
      expires_at_ms: expiresAtMs,
      continue_uri:
        continueUrl.toString(),
    },
    202,
    {
      "retry-after": "2",
    },
  );
}

function exactRequestId(
  url: URL,
): string | Response | null {
  if (!url.searchParams.has("request_id")) {
    return null;
  }

  const values =
    url.searchParams.getAll("request_id");

  if (
    values.length !== 1
    || !REQUEST_ID.test(values[0]!)
  ) {
    return errorResponse(
      400,
      "invalid_request_id",
      "request_id is invalid",
    );
  }

  for (
    const key
    of url.searchParams.keys()
  ) {
    if (key !== "request_id") {
      return errorResponse(
        400,
        "ambiguous_authorization_request",
        "request_id continuation cannot be combined with authorization parameters",
      );
    }
  }

  return values[0]!;
}

async function startAuthorization(
  request: Request,
  url: URL,
  issuer: string,
  policy: OAuthPublicClientPolicy,
  pendingStore: PendingOAuthConsentStore,
): Promise<Response> {
  const validated =
    validateOAuthAuthorizationRequest(
      url,
      policy,
    );

  if (!validated.ok) {
    if (!validated.redirectAllowed) {
      return errorResponse(
        400,
        validated.error,
        validated.description,
      );
    }

    const redirect =
      buildOAuthAuthorizationErrorRedirect(
        redirectContext(policy, url),
        issuer,
        oauthErrorCode(
          validated.error,
        ),
        validated.description,
      );

    if (!redirect.ok) {
      return errorResponse(
        400,
        "invalid_authorization_request",
        "authorization request could not be redirected safely",
      );
    }

    return redirectResponse(
      redirect.redirectUri,
    );
  }

  const created =
    pendingStore.create(
      validated.value,
    );

  if (!created.ok) {
    if (created.error === "capacity") {
      return errorResponse(
        503,
        "oauth_consent_capacity",
        "OAuth consent capacity is temporarily exhausted",
      );
    }

    return errorResponse(
      500,
      "oauth_consent_unavailable",
      "OAuth consent request could not be created",
    );
  }

  return pendingResponse(
    created.value.requestId,
    created.value.expiresAtMs,
    issuer,
  );
}

async function continueAuthorization(
  requestId: string,
  issuer: string,
  pendingStore: PendingOAuthConsentStore,
  codeStore: OAuthAuthorizationCodeStore,
): Promise<Response> {
  const projection =
    pendingStore.get(requestId);

  if (!projection) {
    return errorResponse(
      404,
      "pending_consent_not_found",
      "pending consent request was not found or has expired",
    );
  }

  if (
    projection.status === "pending"
  ) {
    return pendingResponse(
      projection.requestId,
      projection.expiresAtMs,
      issuer,
    );
  }

  const consumed =
    pendingStore.consumeDecision(
      requestId,
    );

  if (!consumed.ok) {
    return errorResponse(
      409,
      "pending_consent_unavailable",
      "pending consent decision could not be consumed",
    );
  }

  if (
    consumed.value.decision
      === "denied"
  ) {
    const denied =
      buildOAuthAuthorizationErrorRedirect(
        consumed.value.request,
        issuer,
        "access_denied",
        "resource owner denied the authorization request",
      );

    if (!denied.ok) {
      return errorResponse(
        500,
        "oauth_redirect_failure",
        "OAuth denial response could not be built safely",
      );
    }

    return redirectResponse(
      denied.redirectUri,
    );
  }

  // Preflight the exact redirect contract before
  // creating code authority. The real code generated
  // below has the same canonical base64url shape.
  const preflight =
    buildOAuthAuthorizationSuccessRedirect(
      consumed.value.request,
      issuer,
      PREFLIGHT_CODE,
    );

  if (!preflight.ok) {
    return errorResponse(
      500,
      "oauth_redirect_failure",
      "OAuth success response could not be built safely",
    );
  }

  const issued =
    codeStore.issue({
      request:
        consumed.value.request,
    });

  if (!issued.ok) {
    return errorResponse(
      issued.error === "capacity"
        ? 503
        : 500,
      "oauth_authorization_code_unavailable",
      "OAuth authorization code could not be issued",
    );
  }

  const success =
    buildOAuthAuthorizationSuccessRedirect(
      consumed.value.request,
      issuer,
      issued.value.code,
    );

  if (!success.ok) {
    // Fail closed: do not leave an authority-bearing
    // code live if its redirect cannot be produced.
    codeStore.consume(
      issued.value.code,
    );

    return errorResponse(
      500,
      "oauth_redirect_failure",
      "OAuth success response could not be built safely",
    );
  }

  return redirectResponse(
    success.redirectUri,
  );
}

export async function handleOAuthAuthorizationRequest(
  request: Request,
  config: GatewayConfig,
  policy:
    OAuthPublicClientPolicy
    | null
    | undefined,
  pendingStore:
    PendingOAuthConsentStore
    | null
    | undefined,
  codeStore:
    OAuthAuthorizationCodeStore
    | null
    | undefined,
  cimdDiscovery?:
    CimdDiscoveryDependencies
    | null,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname !== AUTHORIZATION_PATH) {
    return null;
  }

  if (request.method !== "GET") {
    return errorResponse(
      405,
      "method_not_allowed",
      "GET required",
    );
  }

  const issuer =
    selfHostedIssuer(config);

  if (
    !issuer
    || (!policy && !cimdDiscovery)
    || !pendingStore
    || !codeStore
  ) {
    return errorResponse(
      404,
      "oauth_authorization_unavailable",
      "local OAuth authorization is not configured",
    );
  }

  const requestId =
    exactRequestId(url);

  if (requestId instanceof Response) {
    return requestId;
  }

  if (requestId !== null) {
    return continueAuthorization(
      requestId,
      issuer,
      pendingStore,
      codeStore,
    );
  }

  const resolvedPolicy =
    await resolveOAuthAuthorizationClientPolicy(
      url,
      issuer,
      policy,
      cimdDiscovery,
    );

  if (!resolvedPolicy.ok) {
    return errorResponse(
      resolvedPolicy.status,
      resolvedPolicy.error,
      resolvedPolicy.description,
    );
  }

  return startAuthorization(
    request,
    url,
    issuer,
    resolvedPolicy.policy,
    pendingStore,
  );
}
