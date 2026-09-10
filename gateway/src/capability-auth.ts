import {
  CAPABILITY_AUTHORITY,
  CAPABILITY_DEPTH,
  LEGACY_COMPAT_GRANT,
  type CapabilityAuthority,
  type CapabilityDepth,
  type CapabilityGrant,
} from "./capabilities";
import type { GatewayConfig } from "./config";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SESSION_TOKEN_PREFIX = "tqq1";
const SIGNING_DOMAIN = "task-que-que-capability-session-v1";
export const MIN_CAPABILITY_SESSION_TTL_SECONDS = 60;
export const MAX_CAPABILITY_SESSION_TTL_SECONDS = 24 * 60 * 60;
export const MAX_CAPABILITY_SESSION_SCOPES = 64;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_SCOPE_BYTES = 128;
const SAFE_SCOPE = /^[A-Za-z0-9*][A-Za-z0-9._:/*-]*$/;
const SAFE_SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

export interface CapabilitySessionClaims {
  v: 1;
  sid: string;
  iat: number;
  exp: number;
  depth: CapabilityDepth;
  authority: CapabilityAuthority;
  scopes: readonly string[];
}

export interface CapabilitySessionIssue {
  token: string;
  claims: CapabilitySessionClaims;
}

export interface AuthorizationContext {
  kind: "root" | "session" | "development" | "internal";
  grant: CapabilityGrant;
  sessionId: string | null;
  expiresAt: number | null;
}

export const INTERNAL_SYSTEM_AUTH_CONTEXT: AuthorizationContext = Object.freeze({
  kind: "internal",
  grant: LEGACY_COMPAT_GRANT,
  sessionId: null,
  expiresAt: null,
});

function isDepth(value: unknown): value is CapabilityDepth {
  return (
    Number.isInteger(value) &&
    Object.values(CAPABILITY_DEPTH).includes(value as CapabilityDepth)
  );
}

function isAuthority(value: unknown): value is CapabilityAuthority {
  return (
    Number.isInteger(value) &&
    Object.values(CAPABILITY_AUTHORITY).includes(value as CapabilityAuthority)
  );
}

export function validateCapabilityGrant(grant: CapabilityGrant): readonly string[] {
  const errors: string[] = [];
  if (!isDepth(grant.depth)) errors.push("invalid depth");
  if (!isAuthority(grant.authority)) errors.push("invalid authority");
  if (!Array.isArray(grant.scopes)) {
    errors.push("scopes must be an array");
    return Object.freeze(errors);
  }
  if (grant.scopes.length > MAX_CAPABILITY_SESSION_SCOPES) {
    errors.push(`too many scopes (max ${MAX_CAPABILITY_SESSION_SCOPES})`);
  }
  const seen = new Set<string>();
  for (const scope of grant.scopes) {
    if (
      typeof scope !== "string" ||
      encoder.encode(scope).byteLength === 0 ||
      encoder.encode(scope).byteLength > MAX_SCOPE_BYTES ||
      !SAFE_SCOPE.test(scope)
    ) {
      errors.push("invalid scope");
      continue;
    }
    if (seen.has(scope)) errors.push("duplicate scope");
    seen.add(scope);
  }
  return Object.freeze(errors);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padding = (4 - (value.length % 4)) % 4;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padding));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signPayload(secret: string, payload: string): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(`${SIGNING_DOMAIN}.${payload}`),
  );
  return new Uint8Array(signature);
}

async function verifyPayload(
  secret: string,
  payload: string,
  signature: Uint8Array,
): Promise<boolean> {
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signature,
    encoder.encode(`${SIGNING_DOMAIN}.${payload}`),
  );
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function parseClaims(bytes: Uint8Array): CapabilitySessionClaims | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const claims = parsed as Record<string, unknown>;
  if (
    !exactKeys(claims, ["v", "sid", "iat", "exp", "depth", "authority", "scopes"]) ||
    claims.v !== 1 ||
    typeof claims.sid !== "string" ||
    !SAFE_SESSION_ID.test(claims.sid) ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    !isDepth(claims.depth) ||
    !isAuthority(claims.authority) ||
    !Array.isArray(claims.scopes)
  ) {
    return null;
  }
  const grant: CapabilityGrant = {
    depth: claims.depth,
    authority: claims.authority,
    scopes: claims.scopes as string[],
  };
  if (validateCapabilityGrant(grant).length > 0) return null;
  return Object.freeze({
    v: 1,
    sid: claims.sid,
    iat: claims.iat as number,
    exp: claims.exp as number,
    depth: grant.depth,
    authority: grant.authority,
    scopes: Object.freeze([...grant.scopes]),
  });
}

export async function issueCapabilitySession(
  secret: string,
  grant: CapabilityGrant,
  ttlSeconds: number,
  nowMs: number = Date.now(),
): Promise<CapabilitySessionIssue> {
  if (!secret) throw new Error("capability session signing secret is required");
  const grantErrors = validateCapabilityGrant(grant);
  if (grantErrors.length > 0) {
    throw new Error(`invalid capability grant: ${grantErrors.join(", ")}`);
  }
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < MIN_CAPABILITY_SESSION_TTL_SECONDS ||
    ttlSeconds > MAX_CAPABILITY_SESSION_TTL_SECONDS
  ) {
    throw new Error(
      `ttlSeconds must be between ${MIN_CAPABILITY_SESSION_TTL_SECONDS} and ${MAX_CAPABILITY_SESSION_TTL_SECONDS}`,
    );
  }

  const issuedAt = Math.floor(nowMs / 1_000);
  const claims: CapabilitySessionClaims = Object.freeze({
    v: 1,
    sid: crypto.randomUUID(),
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    depth: grant.depth,
    authority: grant.authority,
    scopes: Object.freeze([...grant.scopes]),
  });
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const signature = base64UrlEncode(await signPayload(secret, payload));
  return Object.freeze({
    token: `${SESSION_TOKEN_PREFIX}.${payload}.${signature}`,
    claims,
  });
}

export async function verifyCapabilitySession(
  token: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<AuthorizationContext | null> {
  if (!secret || encoder.encode(token).byteLength > MAX_TOKEN_BYTES) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== SESSION_TOKEN_PREFIX) return null;
  const payload = parts[1]!;
  const signature = base64UrlDecode(parts[2]!);
  const payloadBytes = base64UrlDecode(payload);
  if (!signature || !payloadBytes) return null;
  if (!(await verifyPayload(secret, payload, signature))) return null;

  const claims = parseClaims(payloadBytes);
  if (!claims) return null;
  const nowSeconds = Math.floor(nowMs / 1_000);
  if (
    claims.iat > nowSeconds + 60 ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > MAX_CAPABILITY_SESSION_TTL_SECONDS ||
    nowSeconds >= claims.exp
  ) {
    return null;
  }

  return Object.freeze({
    kind: "session" as const,
    grant: Object.freeze({
      depth: claims.depth,
      authority: claims.authority,
      scopes: claims.scopes,
    }),
    sessionId: claims.sid,
    expiresAt: claims.exp,
  });
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

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  return token.length > 0 ? token : null;
}

export function isRootAuthorization(request: Request, config: GatewayConfig): boolean {
  if (!config.apiToken) return false;
  const token = bearerToken(request);
  return token !== null && constantTimeEqual(token, config.apiToken);
}

export async function resolveAuthorizationContext(
  request: Request,
  config: GatewayConfig,
  nowMs: number = Date.now(),
): Promise<AuthorizationContext | null> {
  if (config.allowUnauthenticated && !config.apiToken) {
    return Object.freeze({
      kind: "development" as const,
      grant: LEGACY_COMPAT_GRANT,
      sessionId: null,
      expiresAt: null,
    });
  }

  const token = bearerToken(request);
  if (!token || !config.apiToken) return null;
  if (constantTimeEqual(token, config.apiToken)) {
    return Object.freeze({
      kind: "root" as const,
      grant: LEGACY_COMPAT_GRANT,
      sessionId: null,
      expiresAt: null,
    });
  }
  return verifyCapabilitySession(token, config.apiToken, nowMs);
}
