import {
  GATEWAY_VERSION,
} from "./app";
import {
  deriveOAuthResourceSessionSecret,
  issueCapabilitySession,
} from "./capability-auth";
import type {
  GatewayConfig,
} from "./config";
import type {
  OAuthPublicClientPolicy,
} from "./oauth-authorization-validation";
import {
  OAuthAuthorizationCodeStore,
} from "./oauth-authorization-code-store";
import {
  deriveOAuthCapabilityGrant,
} from "./oauth-scope-grant";
import {
  validateCimdClientId,
} from "./oauth-cimd-client-id";
import {
  CIMD_DYNAMIC_SCOPES,
} from "./oauth-cimd-policy";
import {
  validateOAuthTokenRequest,
} from "./oauth-token-validation";

export const OAUTH_TOKEN_PATH =
  "/oauth/token";
export const OAUTH_ACCESS_TOKEN_TTL_SECONDS =
  15 * 60;

const MAX_TOKEN_REQUEST_BYTES =
  16 * 1024;
const AUTHORIZATION_CODE =
  /^[A-Za-z0-9_-]{43}$/;

const encoder = new TextEncoder();

function oauthJson(
  value: unknown,
  status = 200,
  extraHeaders?: HeadersInit,
): Response {
  const headers =
    new Headers(extraHeaders);
  headers.set(
    "content-type",
    "application/json; charset=utf-8",
  );
  headers.set(
    "cache-control",
    "no-store",
  );
  headers.set("pragma", "no-cache");
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

function oauthError(
  error: string,
  description: string,
  status = 400,
  extraHeaders?: HeadersInit,
): Response {
  return oauthJson(
    {
      error,
      error_description:
        description,
    },
    status,
    extraHeaders,
  );
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

async function parseTokenForm(
  request: Request,
): Promise<
  URLSearchParams | Response
> {
  if (new URL(request.url).search) {
    return oauthError(
      "invalid_request",
      "token endpoint does not accept query parameters",
    );
  }

  const authorization =
    request.headers.get(
      "authorization",
    );

  if (authorization !== null) {
    const scheme =
      /^([A-Za-z][A-Za-z0-9+.-]*)\s/.exec(
        authorization,
      )?.[1];

    return oauthError(
      "invalid_client",
      "this public client uses token_endpoint_auth_method=none",
      401,
      scheme
        ? {
            "www-authenticate":
              `${scheme} realm="oauth-token"`,
          }
        : undefined,
    );
  }

  const contentType =
    request.headers
      .get("content-type")
      ?.toLowerCase()
    ?? "";

  if (
    !contentType.startsWith(
      "application/x-www-form-urlencoded",
    )
  ) {
    return oauthError(
      "invalid_request",
      "content-type must be application/x-www-form-urlencoded",
      415,
    );
  }

  const declaredLength =
    request.headers.get(
      "content-length",
    );

  if (
    declaredLength !== null
  ) {
    const length =
      Number(declaredLength);

    if (
      !Number.isInteger(length)
      || length < 0
    ) {
      return oauthError(
        "invalid_request",
        "invalid content-length",
      );
    }

    if (
      length
        > MAX_TOKEN_REQUEST_BYTES
    ) {
      return oauthError(
        "invalid_request",
        "token request is too large",
        413,
      );
    }
  }

  const raw =
    await request.text();

  if (
    encoder.encode(raw).byteLength
      > MAX_TOKEN_REQUEST_BYTES
  ) {
    return oauthError(
      "invalid_request",
      "token request is too large",
      413,
    );
  }

  return new URLSearchParams(raw);
}

function exactCode(
  params: URLSearchParams,
): string | null {
  const values =
    params.getAll("code");

  if (
    values.length !== 1
    || !AUTHORIZATION_CODE.test(
      values[0]!,
    )
  ) {
    return null;
  }

  return values[0]!;
}

function bindingMatchesConfiguredAuthority(
  consumed: {
    binding: {
      clientId: string;
      redirectUri: string;
      resource: string;
    };
    scopes: readonly string[];
  },
  config: GatewayConfig,
  policy:
    OAuthPublicClientPolicy
    | null
    | undefined,
  cimdEnabled: boolean,
): boolean {
  if (policy) {
    const staticIdentityMatches =
      consumed.binding.clientId
        === policy.clientId
      && consumed.binding.redirectUri
        === policy.redirectUri
      && consumed.binding.resource
        === policy.resource;

    if (staticIdentityMatches) {
      const permitted =
        new Set(policy.scopes);

      return consumed.scopes.every(
        (scope) =>
          permitted.has(scope),
      );
    }
  }

  if (
    !cimdEnabled
    || !config.publicOrigin
    || consumed.binding.resource
      !== `${config.publicOrigin}/mcp`
    || !validateCimdClientId(
      consumed.binding.clientId,
    ).ok
  ) {
    return false;
  }

  let redirect: URL;
  try {
    redirect =
      new URL(
        consumed.binding.redirectUri,
      );
  } catch {
    return false;
  }

  if (
    redirect.protocol !== "https:"
    || redirect.username
    || redirect.password
    || redirect.hash
  ) {
    return false;
  }

  return (
    consumed.scopes.length
      === CIMD_DYNAMIC_SCOPES.length
    && consumed.scopes.every(
      (scope, index) =>
        scope
          === CIMD_DYNAMIC_SCOPES[
            index
          ],
    )
  );
}

export async function handleOAuthTokenRequest(
  request: Request,
  config: GatewayConfig,
  policy:
    OAuthPublicClientPolicy
    | null
    | undefined,
  cimdEnabled: boolean,
  codeStore:
    OAuthAuthorizationCodeStore
    | null
    | undefined,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname !== OAUTH_TOKEN_PATH) {
    return null;
  }

  if (request.method !== "POST") {
    return oauthError(
      "invalid_request",
      "POST required",
      405,
    );
  }

  if (
    !selfHostedIssuer(config)
    || (!policy && !cimdEnabled)
    || !codeStore
    || !config.apiToken
  ) {
    return oauthError(
      "temporarily_unavailable",
      "local OAuth token exchange is not configured",
      404,
    );
  }

  const parsed =
    await parseTokenForm(
      request,
    );

  if (parsed instanceof Response) {
    return parsed;
  }

  const code =
    exactCode(parsed);

  if (!code) {
    return oauthError(
      "invalid_grant",
      "authorization code is invalid",
    );
  }

  // Consume before asynchronous PKCE verification so
  // one authorization code can never be observed as live
  // by two redemption attempts.
  const consumed =
    codeStore.consume(code);

  if (!consumed.ok) {
    return oauthError(
      "invalid_grant",
      "authorization code is invalid, expired, or already used",
    );
  }

  if (
    !bindingMatchesConfiguredAuthority(
      consumed.value,
      config,
      policy,
      cimdEnabled,
    )
  ) {
    return oauthError(
      "invalid_grant",
      "authorization code is not bound to an accepted OAuth client policy",
    );
  }

  const validated =
    await validateOAuthTokenRequest(
      parsed,
      consumed.value.binding,
    );

  if (!validated.ok) {
    return oauthError(
      validated.error,
      validated.description,
    );
  }

  const derived =
    deriveOAuthCapabilityGrant(
      consumed.value.scopes,
    );

  if (!derived.ok) {
    return oauthError(
      "invalid_scope",
      "approved OAuth scopes cannot be mapped to bounded capability authority",
    );
  }

  let issued;
  try {
    const signingSecret =
      await deriveOAuthResourceSessionSecret(
        config.apiToken,
        consumed.value.binding.resource,
      );

    issued =
      await issueCapabilitySession(
        signingSecret,
        derived.grant,
        OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      );
  } catch {
    return oauthError(
      "temporarily_unavailable",
      "capability-session issuance failed",
      503,
    );
  }

  return oauthJson({
    access_token:
      issued.token,
    token_type: "Bearer",
    expires_in:
      OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    scope:
      issued.claims.scopes.join(
        " ",
      ),
  });
}
