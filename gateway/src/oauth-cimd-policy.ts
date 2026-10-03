import type {
  OAuthPublicClientPolicy,
} from "./oauth-authorization-validation";
import {
  discoverCimdClient,
  type CimdDiscoveryDependencies,
} from "./oauth-cimd-discovery";

export const CIMD_DYNAMIC_SCOPES =
  Object.freeze([
    "capability.read",
  ] as const);

export type OAuthAuthorizationClientPolicyResolution =
  | {
      ok: true;
      source:
        | "pre_registered"
        | "cimd";
      policy:
        OAuthPublicClientPolicy;
      clientName?: string;
    }
  | {
      ok: false;
      error:
        | "invalid_request"
        | "unauthorized_client"
        | "invalid_redirect_uri"
        | "cimd_discovery_unavailable";
      description: string;
      status: 400 | 503;
    };

function exactQueryValue(
  url: URL,
  name: string,
): string | null | "duplicate" {
  const values =
    url.searchParams.getAll(name);

  if (values.length === 0) {
    return null;
  }

  if (values.length !== 1) {
    return "duplicate";
  }

  return values[0]!;
}

function staticPolicyMatches(
  policy:
    OAuthPublicClientPolicy
    | null
    | undefined,
  clientId: string,
): policy is OAuthPublicClientPolicy {
  return !!policy
    && policy.clientId
      === clientId;
}

function discoveryUnavailable(
  error: string,
): boolean {
  return (
    error === "resolution_failed"
    || error === "fetch_failed"
  );
}

export async function resolveOAuthAuthorizationClientPolicy(
  url: URL,
  publicOrigin: string,
  staticPolicy:
    OAuthPublicClientPolicy
    | null
    | undefined,
  cimd:
    CimdDiscoveryDependencies
    | null
    | undefined,
): Promise<OAuthAuthorizationClientPolicyResolution> {
  const clientId =
    exactQueryValue(
      url,
      "client_id",
    );

  if (
    clientId === null
    || clientId === "duplicate"
    || clientId.length === 0
  ) {
    return {
      ok: false,
      error: "invalid_request",
      description:
        "authorization request must contain exactly one non-empty client_id",
      status: 400,
    };
  }

  const redirectUri =
    exactQueryValue(
      url,
      "redirect_uri",
    );

  if (
    redirectUri === null
    || redirectUri === "duplicate"
    || redirectUri.length === 0
  ) {
    return {
      ok: false,
      error: "invalid_request",
      description:
        "authorization request must contain exactly one non-empty redirect_uri",
      status: 400,
    };
  }

  if (
    staticPolicyMatches(
      staticPolicy,
      clientId,
    )
  ) {
    return {
      ok: true,
      source: "pre_registered",
      policy:
        staticPolicy,
    };
  }

  if (!cimd) {
    return {
      ok: false,
      error: "unauthorized_client",
      description:
        "client_id is not pre-registered and CIMD discovery is not configured",
      status: 400,
    };
  }

  const discovered =
    await discoverCimdClient(
      clientId,
      cimd,
    );

  if (!discovered.ok) {
    if (
      discoveryUnavailable(
        discovered.error,
      )
    ) {
      return {
        ok: false,
        error:
          "cimd_discovery_unavailable",
        description:
          "client metadata could not be retrieved safely",
        status: 503,
      };
    }

    return {
      ok: false,
      error:
        "unauthorized_client",
      description:
        "client metadata is invalid or does not satisfy server policy",
      status: 400,
    };
  }

  if (
    !discovered.value.metadata
      .redirectUris
      .includes(redirectUri)
  ) {
    return {
      ok: false,
      error:
        "invalid_redirect_uri",
      description:
        "redirect_uri does not exactly match a CIMD-registered URI",
      status: 400,
    };
  }

  return {
    ok: true,
    source: "cimd",
    clientName:
      discovered.value.metadata
        .clientName,
    policy:
      Object.freeze({
        clientId,
        redirectUri,
        resource:
          `${publicOrigin}/mcp`,
        scopes:
          CIMD_DYNAMIC_SCOPES,
      }),
  };
}
