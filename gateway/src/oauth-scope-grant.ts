import {
  CAPABILITY_AUTHORITY,
  CAPABILITY_DEPTH,
  CAPABILITY_REGISTRY,
  type CapabilityAuthority,
  type CapabilityDepth,
  type CapabilityGrant,
  type CapabilityRegistry,
} from "./capabilities";

export type OAuthScopeGrantResult =
  | {
      ok: true;
      grant: CapabilityGrant;
    }
  | {
      ok: false;
      error:
        | "empty_scope"
        | "wildcard_scope"
        | "unmapped_scope";
      scope?: string;
    };

export function deriveOAuthCapabilityGrant(
  scopes: readonly string[],
  registry: CapabilityRegistry = CAPABILITY_REGISTRY,
): OAuthScopeGrantResult {
  if (scopes.length === 0) {
    return {
      ok: false,
      error: "empty_scope",
    };
  }

  let depth: CapabilityDepth =
    CAPABILITY_DEPTH.DISCOVER;
  let authority: CapabilityAuthority =
    CAPABILITY_AUTHORITY.OBSERVE;

  const seen = new Set<string>();

  for (const scope of scopes) {
    if (seen.has(scope)) {
      return {
        ok: false,
        error: "unmapped_scope",
        scope,
      };
    }
    seen.add(scope);

    if (
      scope === "*"
      || scope.endsWith(".*")
    ) {
      return {
        ok: false,
        error: "wildcard_scope",
        scope,
      };
    }

    const matching =
      Object.values(registry).filter(
        (descriptor) =>
          descriptor.requiredScopes
            .includes(scope),
      );

    if (matching.length === 0) {
      return {
        ok: false,
        error: "unmapped_scope",
        scope,
      };
    }

    for (const descriptor of matching) {
      if (descriptor.minDepth > depth) {
        depth = descriptor.minDepth;
      }
      if (
        descriptor.minAuthority
          > authority
      ) {
        authority =
          descriptor.minAuthority;
      }
    }
  }

  return {
    ok: true,
    grant: Object.freeze({
      depth,
      authority,
      scopes: Object.freeze([
        ...scopes,
      ]),
    }),
  };
}
