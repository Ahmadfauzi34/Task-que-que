import type { OAuthPublicClientPolicy } from "./oauth-authorization-validation";

const encoder = new TextEncoder();
const CLIENT_ID = /^[\x21-\x7E]{1,512}$/;
const CAPABILITY_SCOPE = /^[A-Za-z0-9*][A-Za-z0-9._:/*-]*$/;
const MAX_SCOPES = 64;
const MAX_SCOPE_BYTES = 128;

export interface OAuthPublicClientEnv {
  GATEWAY_OAUTH_CLIENT_ID?: string;
  GATEWAY_OAUTH_REDIRECT_URI?: string;
  GATEWAY_OAUTH_CLIENT_SCOPES?: string;
}

function exactConfiguredValue(raw: string | undefined, name: string): string | null {
  if (raw === undefined || raw === "") return null;
  if (raw !== raw.trim()) {
    throw new Error(`${name} must not contain leading or trailing whitespace`);
  }
  return raw;
}

function parseClientId(raw: string | undefined): string | null {
  const value = exactConfiguredValue(raw, "GATEWAY_OAUTH_CLIENT_ID");
  if (value === null) return null;
  if (!CLIENT_ID.test(value)) {
    throw new Error(
      "GATEWAY_OAUTH_CLIENT_ID must be 1..512 visible ASCII characters without spaces",
    );
  }
  return value;
}

function parseRedirectUri(raw: string | undefined): string | null {
  const value = exactConfiguredValue(raw, "GATEWAY_OAUTH_REDIRECT_URI");
  if (value === null) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GATEWAY_OAUTH_REDIRECT_URI must be a valid absolute HTTPS URL");
  }

  if (url.protocol !== "https:") {
    throw new Error("GATEWAY_OAUTH_REDIRECT_URI must use HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("GATEWAY_OAUTH_REDIRECT_URI must not contain credentials");
  }
  if (url.hash) {
    throw new Error("GATEWAY_OAUTH_REDIRECT_URI must not contain a fragment");
  }

  return value;
}

function parseScopes(raw: string | undefined): readonly string[] | null {
  const value = exactConfiguredValue(raw, "GATEWAY_OAUTH_CLIENT_SCOPES");
  if (value === null) return null;
  if (value.length === 0 || value.includes("  ")) {
    throw new Error(
      "GATEWAY_OAUTH_CLIENT_SCOPES must use single ASCII-space separators",
    );
  }

  const scopes = value.split(" ");
  if (scopes.length === 0 || scopes.length > MAX_SCOPES) {
    throw new Error(`GATEWAY_OAUTH_CLIENT_SCOPES must contain 1..${MAX_SCOPES} scopes`);
  }

  const seen = new Set<string>();
  for (const scope of scopes) {
    if (
      !CAPABILITY_SCOPE.test(scope)
      || encoder.encode(scope).byteLength > MAX_SCOPE_BYTES
    ) {
      throw new Error(
        "GATEWAY_OAUTH_CLIENT_SCOPES contains a scope that cannot map to capability authority",
      );
    }
    if (seen.has(scope)) {
      throw new Error("GATEWAY_OAUTH_CLIENT_SCOPES must not contain duplicate scopes");
    }
    seen.add(scope);
  }

  return Object.freeze([...scopes]);
}

function validatePublicOrigin(publicOrigin: string | null | undefined): string {
  if (!publicOrigin) {
    throw new Error(
      "GATEWAY_PUBLIC_ORIGIN is required when a pre-registered OAuth client is configured",
    );
  }

  let url: URL;
  try {
    url = new URL(publicOrigin);
  } catch {
    throw new Error("publicOrigin must be a valid absolute HTTPS origin");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error("publicOrigin must be an absolute HTTPS origin");
  }
  return url.origin;
}

export function loadOAuthPublicClientPolicy(
  env: OAuthPublicClientEnv,
  publicOrigin: string | null | undefined,
): OAuthPublicClientPolicy | null {
  const clientId = parseClientId(env.GATEWAY_OAUTH_CLIENT_ID);
  const redirectUri = parseRedirectUri(env.GATEWAY_OAUTH_REDIRECT_URI);
  const scopes = parseScopes(env.GATEWAY_OAUTH_CLIENT_SCOPES);

  const configuredCount = [clientId, redirectUri, scopes].filter(
    (value) => value !== null,
  ).length;
  if (configuredCount === 0) return null;
  if (configuredCount !== 3) {
    throw new Error(
      "GATEWAY_OAUTH_CLIENT_ID, GATEWAY_OAUTH_REDIRECT_URI, and GATEWAY_OAUTH_CLIENT_SCOPES must be configured together",
    );
  }

  const origin = validatePublicOrigin(publicOrigin);
  return Object.freeze({
    clientId: clientId!,
    redirectUri: redirectUri!,
    resource: `${origin}/mcp`,
    scopes: Object.freeze([...(scopes!)]),
  });
}
