export interface CloudflareAccessServiceConfig {
  teamDomain: string;
  audience: string;
  serviceTokenClientId: string;
}

export interface CloudflareAccessPrincipal {
  kind: "service";
  scope: string;
}

export type CloudflareAccessVerificationResult =
  | { ok: true; principal: CloudflareAccessPrincipal }
  | { ok: false; reason: "invalid" | "unavailable" };

export interface CloudflareAccessVerifierLike {
  verify(assertion: string): Promise<CloudflareAccessVerificationResult>;
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface AccessJwk extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

interface AccessClaims {
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  nbf?: unknown;
  iss?: unknown;
  type?: unknown;
  sub?: unknown;
  common_name?: unknown;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_ASSERTION_BYTES = 16 * 1024;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_STALE_GRACE_MS = 24 * 60 * 60 * 1_000;
const CLOCK_SKEW_SECONDS = 60;

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("invalid base64url");
  }

  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJsonSegment<T>(value: string): T {
  return JSON.parse(decoder.decode(decodeBase64Url(value))) as T;
}

function asAudienceList(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  return [];
}

function validNumericDate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;

  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }

  return diff === 0;
}

export class CloudflareAccessServiceVerifier implements CloudflareAccessVerifierLike {
  private keys = new Map<string, AccessJwk>();
  private refreshedAtMs = 0;

  constructor(
    private readonly config: CloudflareAccessServiceConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly nowMs: () => number = () => Date.now(),
    private readonly cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    private readonly staleGraceMs = DEFAULT_STALE_GRACE_MS,
  ) {}

  async verify(assertion: string): Promise<CloudflareAccessVerificationResult> {
    if (!assertion || encoder.encode(assertion).byteLength > MAX_ASSERTION_BYTES) {
      return { ok: false, reason: "invalid" };
    }

    const parts = assertion.split(".");
    if (parts.length !== 3) {
      return { ok: false, reason: "invalid" };
    }

    let header: Record<string, unknown>;
    let claims: AccessClaims;
    let signature: Uint8Array;
    try {
      header = decodeJsonSegment<Record<string, unknown>>(parts[0]);
      claims = decodeJsonSegment<AccessClaims>(parts[1]);
      signature = decodeBase64Url(parts[2]);
    } catch {
      return { ok: false, reason: "invalid" };
    }

    if (
      header.alg !== "RS256" ||
      header.typ !== "JWT" ||
      typeof header.kid !== "string" ||
      header.kid.length === 0 ||
      header.kid.length > 256
    ) {
      return { ok: false, reason: "invalid" };
    }

    if (!this.validateClaims(claims)) {
      return { ok: false, reason: "invalid" };
    }

    const keyResult = await this.keyFor(header.kid);
    if (!keyResult.ok) {
      return keyResult;
    }

    let cryptoKey: CryptoKey;
    try {
      cryptoKey = await crypto.subtle.importKey(
        "jwk",
        keyResult.key,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
    } catch {
      return { ok: false, reason: "invalid" };
    }

    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signature,
      encoder.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!verified) {
      return { ok: false, reason: "invalid" };
    }

    return {
      ok: true,
      principal: {
        kind: "service",
        scope: `cloudflare-service:${this.config.serviceTokenClientId}`,
      },
    };
  }

  private validateClaims(claims: AccessClaims): boolean {
    const nowSeconds = Math.floor(this.nowMs() / 1_000);
    const expectedIssuer = this.config.teamDomain;

    if (claims.type !== "app" || claims.iss !== expectedIssuer) {
      return false;
    }
    if (!asAudienceList(claims.aud).includes(this.config.audience)) {
      return false;
    }
    if (!validNumericDate(claims.exp) || claims.exp < nowSeconds - CLOCK_SKEW_SECONDS) {
      return false;
    }
    if (claims.nbf !== undefined && (!validNumericDate(claims.nbf) || claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS)) {
      return false;
    }
    if (claims.iat !== undefined && (!validNumericDate(claims.iat) || claims.iat > nowSeconds + CLOCK_SKEW_SECONDS)) {
      return false;
    }
    if (claims.sub !== "") {
      return false;
    }
    if (
      typeof claims.common_name !== "string" ||
      claims.common_name.length === 0 ||
      claims.common_name.length > 256
    ) {
      return false;
    }

    return constantTimeEqual(claims.common_name, this.config.serviceTokenClientId);
  }

  private async keyFor(
    kid: string,
  ): Promise<{ ok: true; key: AccessJwk } | { ok: false; reason: "invalid" | "unavailable" }> {
    const now = this.nowMs();
    const cached = this.keys.get(kid);
    if (cached && now - this.refreshedAtMs <= this.cacheTtlMs) {
      return { ok: true, key: cached };
    }

    try {
      await this.refreshKeys();
    } catch {
      if (cached && now - this.refreshedAtMs <= this.cacheTtlMs + this.staleGraceMs) {
        return { ok: true, key: cached };
      }
      return { ok: false, reason: "unavailable" };
    }

    const refreshed = this.keys.get(kid);
    return refreshed
      ? { ok: true, key: refreshed }
      : { ok: false, reason: "invalid" };
  }

  private async refreshKeys(): Promise<void> {
    const response = await this.fetchImpl(`${this.config.teamDomain}/cdn-cgi/access/certs`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error("Cloudflare Access JWKS unavailable");
    }

    const body = (await response.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys)) {
      throw new Error("Cloudflare Access JWKS response is invalid");
    }

    const next = new Map<string, AccessJwk>();
    for (const candidate of body.keys) {
      if (
        typeof candidate === "object" &&
        candidate !== null &&
        "kid" in candidate &&
        typeof candidate.kid === "string" &&
        candidate.kid.length > 0 &&
        candidate.kid.length <= 256 &&
        "kty" in candidate &&
        candidate.kty === "RSA" &&
        "alg" in candidate &&
        candidate.alg === "RS256" &&
        "use" in candidate &&
        candidate.use === "sig"
      ) {
        next.set(candidate.kid, candidate as AccessJwk);
      }
    }

    if (next.size === 0) {
      throw new Error("Cloudflare Access JWKS contains no usable signing keys");
    }

    this.keys = next;
    this.refreshedAtMs = this.nowMs();
  }
}
