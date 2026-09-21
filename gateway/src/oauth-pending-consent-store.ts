import { randomBytes } from "node:crypto";

import type {
  ValidatedOAuthAuthorizationRequest,
} from "./oauth-authorization-validation";

const encoder = new TextEncoder();

const DEFAULT_MAX_ENTRIES = 64;
const HARD_MAX_ENTRIES = 64;

const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 5 * 60 * 1_000;

const MAX_SCOPE_BYTES = 128;
const MAX_STATE_BYTES = 1_024;
const MAX_URI_BYTES = 4_096;

const CLIENT_ID = /^[\x21-\x7E]{1,512}$/;
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
const PKCE_S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;

export type OAuthConsentDecision = "approved" | "denied";
export type PendingOAuthConsentStatus = "pending" | OAuthConsentDecision;

export interface PendingOAuthConsentProjection {
  requestId: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: readonly string[];
  status: PendingOAuthConsentStatus;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface PendingOAuthConsentStoreOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
  idFactory?: () => string;
}

export type PendingOAuthConsentCreateResult =
  | {
      ok: true;
      value: PendingOAuthConsentProjection;
    }
  | {
      ok: false;
      error:
        | "invalid_request"
        | "capacity"
        | "id_generation_failed";
    };

export type PendingOAuthConsentDecisionResult =
  | {
      ok: true;
      value: PendingOAuthConsentProjection;
    }
  | {
      ok: false;
      error: "not_found" | "already_decided";
    };

export type PendingOAuthConsentConsumeResult =
  | {
      ok: true;
      value: {
        decision: OAuthConsentDecision;
        request: ValidatedOAuthAuthorizationRequest;
      };
    }
  | {
      ok: false;
      error: "not_found" | "pending";
    };

interface PendingEntry {
  requestId: string;
  request: ValidatedOAuthAuthorizationRequest;
  status: PendingOAuthConsentStatus;
  createdAtMs: number;
  expiresAtMs: number;
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function isBoundedHttpsUri(
  value: string,
  options: {
    allowQuery: boolean;
  },
): boolean {
  if (
    value.length === 0
    || byteLength(value) > MAX_URI_BYTES
  ) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  return url.protocol === "https:"
    && !url.username
    && !url.password
    && !url.hash
    && (options.allowQuery || !url.search);
}

function requestIsBounded(
  request: ValidatedOAuthAuthorizationRequest,
): boolean {
  if (request.responseType !== "code") return false;

  if (
    !CLIENT_ID.test(request.clientId)
    || !isBoundedHttpsUri(
      request.redirectUri,
      { allowQuery: true },
    )
    || !isBoundedHttpsUri(
      request.resource,
      { allowQuery: false },
    )
  ) {
    return false;
  }

  if (
    request.scopes.length === 0
    || request.scopes.length > 64
  ) {
    return false;
  }

  const scopes = new Set<string>();

  for (const scope of request.scopes) {
    if (
      !SCOPE_TOKEN.test(scope)
      || byteLength(scope) > MAX_SCOPE_BYTES
      || scopes.has(scope)
    ) {
      return false;
    }

    scopes.add(scope);
  }

  if (
    request.state !== null
    && (
      request.state.length === 0
      || byteLength(request.state) > MAX_STATE_BYTES
    )
  ) {
    return false;
  }

  return request.codeChallengeMethod === "S256"
    && PKCE_S256_CHALLENGE.test(
      request.codeChallenge,
    );
}

function freezeRequest(
  request: ValidatedOAuthAuthorizationRequest,
): ValidatedOAuthAuthorizationRequest {
  return Object.freeze({
    responseType: "code" as const,
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    resource: request.resource,
    scopes: Object.freeze([
      ...request.scopes,
    ]),
    state: request.state,
    codeChallenge: request.codeChallenge,
    codeChallengeMethod: "S256" as const,
  });
}

function defaultIdFactory(): string {
  return randomBytes(24).toString("base64url");
}

export class PendingOAuthConsentStore {
  private readonly entries =
    new Map<string, PendingEntry>();

  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(
    options: PendingOAuthConsentStoreOptions = {},
  ) {
    const maxEntries =
      options.maxEntries ?? DEFAULT_MAX_ENTRIES;

    const ttlMs =
      options.ttlMs ?? DEFAULT_TTL_MS;

    if (
      !Number.isInteger(maxEntries)
      || maxEntries < 1
      || maxEntries > HARD_MAX_ENTRIES
    ) {
      throw new Error(
        `maxEntries must be an integer between 1 and ${HARD_MAX_ENTRIES}`,
      );
    }

    if (
      !Number.isInteger(ttlMs)
      || ttlMs < MIN_TTL_MS
      || ttlMs > MAX_TTL_MS
    ) {
      throw new Error(
        `ttlMs must be an integer between ${MIN_TTL_MS} and ${MAX_TTL_MS}`,
      );
    }

    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.now = options.now ?? Date.now;
    this.idFactory =
      options.idFactory ?? defaultIdFactory;
  }

  private currentTime(): number {
    const value = this.now();

    if (
      !Number.isFinite(value)
      || !Number.isInteger(value)
      || value < 0
    ) {
      throw new Error(
        "pending consent clock returned an invalid timestamp",
      );
    }

    return value;
  }

  private projection(
    entry: PendingEntry,
  ): PendingOAuthConsentProjection {
    return Object.freeze({
      requestId: entry.requestId,
      clientId: entry.request.clientId,
      redirectUri: entry.request.redirectUri,
      resource: entry.request.resource,
      scopes: Object.freeze([
        ...entry.request.scopes,
      ]),
      status: entry.status,
      createdAtMs: entry.createdAtMs,
      expiresAtMs: entry.expiresAtMs,
    });
  }

  private purgeAt(now: number): number {
    let removed = 0;

    for (const [
      requestId,
      entry,
    ] of this.entries) {
      if (entry.expiresAtMs <= now) {
        this.entries.delete(requestId);
        removed += 1;
      }
    }

    return removed;
  }

  purgeExpired(): number {
    return this.purgeAt(
      this.currentTime(),
    );
  }

  size(): number {
    this.purgeExpired();
    return this.entries.size;
  }

  create(
    request: ValidatedOAuthAuthorizationRequest,
  ): PendingOAuthConsentCreateResult {
    const now = this.currentTime();

    this.purgeAt(now);

    if (!requestIsBounded(request)) {
      return {
        ok: false,
        error: "invalid_request",
      };
    }

    if (
      this.entries.size >= this.maxEntries
    ) {
      return {
        ok: false,
        error: "capacity",
      };
    }

    let requestId: string | null = null;

    for (
      let attempt = 0;
      attempt < 4;
      attempt += 1
    ) {
      const candidate =
        this.idFactory();

      if (!REQUEST_ID.test(candidate)) {
        return {
          ok: false,
          error: "id_generation_failed",
        };
      }

      if (!this.entries.has(candidate)) {
        requestId = candidate;
        break;
      }
    }

    if (requestId === null) {
      return {
        ok: false,
        error: "id_generation_failed",
      };
    }

    const entry: PendingEntry = {
      requestId,
      request: freezeRequest(request),
      status: "pending",
      createdAtMs: now,
      expiresAtMs: now + this.ttlMs,
    };

    this.entries.set(
      requestId,
      entry,
    );

    return {
      ok: true,
      value: this.projection(entry),
    };
  }

  get(
    requestId: string,
  ): PendingOAuthConsentProjection | null {
    const now = this.currentTime();

    this.purgeAt(now);

    const entry =
      this.entries.get(requestId);

    return entry
      ? this.projection(entry)
      : null;
  }

  list():
    readonly PendingOAuthConsentProjection[] {
    const now = this.currentTime();

    this.purgeAt(now);

    return Object.freeze(
      [...this.entries.values()]
        .sort(
          (left, right) =>
            left.createdAtMs
              - right.createdAtMs
            || left.requestId.localeCompare(
              right.requestId,
            ),
        )
        .map((entry) =>
          this.projection(entry)
        ),
    );
  }

  decide(
    requestId: string,
    decision: OAuthConsentDecision,
  ): PendingOAuthConsentDecisionResult {
    const now = this.currentTime();

    this.purgeAt(now);

    const entry =
      this.entries.get(requestId);

    if (!entry) {
      return {
        ok: false,
        error: "not_found",
      };
    }

    if (entry.status !== "pending") {
      return {
        ok: false,
        error: "already_decided",
      };
    }

    entry.status = decision;

    return {
      ok: true,
      value: this.projection(entry),
    };
  }

  consumeDecision(
    requestId: string,
  ): PendingOAuthConsentConsumeResult {
    const now = this.currentTime();

    this.purgeAt(now);

    const entry =
      this.entries.get(requestId);

    if (!entry) {
      return {
        ok: false,
        error: "not_found",
      };
    }

    if (entry.status === "pending") {
      return {
        ok: false,
        error: "pending",
      };
    }

    this.entries.delete(requestId);

    return {
      ok: true,
      value: Object.freeze({
        decision: entry.status,
        request: entry.request,
      }),
    };
  }
}
