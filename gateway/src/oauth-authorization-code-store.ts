import {
  createHash,
  randomBytes,
} from "node:crypto";

import type {
  ValidatedOAuthAuthorizationRequest,
} from "./oauth-authorization-validation";

import type {
  OAuthAuthorizationCodeBinding,
} from "./oauth-token-validation";

const encoder = new TextEncoder();

const DEFAULT_MAX_ENTRIES = 64;
const HARD_MAX_ENTRIES = 64;

const DEFAULT_TTL_MS = 2 * 60 * 1_000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 5 * 60 * 1_000;

const MAX_SCOPE_BYTES = 128;
const MAX_URI_BYTES = 4_096;

const AUTHORIZATION_CODE =
  /^[A-Za-z0-9_-]{43}$/;
const CLIENT_ID =
  /^[\x21-\x7E]{1,512}$/;
const SCOPE_TOKEN =
  /^[\x21\x23-\x5B\x5D-\x7E]+$/;
const PKCE_S256_CHALLENGE =
  /^[A-Za-z0-9_-]{43}$/;

export interface OAuthAuthorizationCodeStoreOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
  codeFactory?: () => string;
}

export interface OAuthAuthorizationCodeGrant {
  request:
    ValidatedOAuthAuthorizationRequest;
}

export interface IssuedOAuthAuthorizationCode {
  code: string;
  expiresAtMs: number;
}

export interface ConsumedOAuthAuthorizationCode {
  binding: OAuthAuthorizationCodeBinding;
  scopes: readonly string[];
  expiresAtMs: number;
}

export type OAuthAuthorizationCodeIssueResult =
  | {
      ok: true;
      value: IssuedOAuthAuthorizationCode;
    }
  | {
      ok: false;
      error:
        | "invalid_grant"
        | "capacity"
        | "code_generation_failed";
    };

export type OAuthAuthorizationCodeConsumeResult =
  | {
      ok: true;
      value: ConsumedOAuthAuthorizationCode;
    }
  | {
      ok: false;
      error: "invalid_grant";
    };

interface AuthorizationCodeEntry {
  digest: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: readonly string[];
  codeChallenge: string;
  createdAtMs: number;
  expiresAtMs: number;
}

function byteLength(
  value: string,
): number {
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
    && (
      options.allowQuery
      || !url.search
    );
}

function requestIsBounded(
  request:
    ValidatedOAuthAuthorizationRequest,
): boolean {
  if (
    request.responseType !== "code"
    || !CLIENT_ID.test(request.clientId)
    || !isBoundedHttpsUri(
      request.redirectUri,
      { allowQuery: true },
    )
    || !isBoundedHttpsUri(
      request.resource,
      { allowQuery: false },
    )
    || request.scopes.length === 0
    || request.scopes.length > 64
    || request.codeChallengeMethod
      !== "S256"
    || !PKCE_S256_CHALLENGE.test(
      request.codeChallenge,
    )
  ) {
    return false;
  }

  const scopes =
    new Set<string>();

  for (
    const scope
    of request.scopes
  ) {
    if (
      !SCOPE_TOKEN.test(scope)
      || byteLength(scope)
        > MAX_SCOPE_BYTES
      || scopes.has(scope)
    ) {
      return false;
    }

    scopes.add(scope);
  }

  return true;
}

function defaultCodeFactory(): string {
  return randomBytes(32)
    .toString("base64url");
}

function digestCode(
  code: string,
): string {
  return createHash("sha256")
    .update(code, "utf8")
    .digest("hex");
}

function frozenScopes(
  scopes: readonly string[],
): readonly string[] {
  return Object.freeze([
    ...scopes,
  ]);
}

export class OAuthAuthorizationCodeStore {
  private readonly entries =
    new Map<
      string,
      AuthorizationCodeEntry
    >();

  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly codeFactory:
    () => string;

  constructor(
    options:
      OAuthAuthorizationCodeStoreOptions = {},
  ) {
    const maxEntries =
      options.maxEntries
      ?? DEFAULT_MAX_ENTRIES;

    const ttlMs =
      options.ttlMs
      ?? DEFAULT_TTL_MS;

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
    this.now =
      options.now ?? Date.now;
    this.codeFactory =
      options.codeFactory
      ?? defaultCodeFactory;
  }

  private currentTime(): number {
    const value = this.now();

    if (
      !Number.isFinite(value)
      || !Number.isInteger(value)
      || value < 0
    ) {
      throw new Error(
        "authorization-code clock returned an invalid timestamp",
      );
    }

    return value;
  }

  private purgeAt(
    now: number,
  ): number {
    let removed = 0;

    for (
      const [
        digest,
        entry,
      ]
      of this.entries
    ) {
      if (
        entry.expiresAtMs <= now
      ) {
        this.entries.delete(digest);
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

  issue(
    grant: OAuthAuthorizationCodeGrant,
  ): OAuthAuthorizationCodeIssueResult {
    const now = this.currentTime();

    this.purgeAt(now);

    if (
      !grant
      || !grant.request
      || !requestIsBounded(
        grant.request,
      )
    ) {
      return {
        ok: false,
        error: "invalid_grant",
      };
    }

    if (
      this.entries.size
      >= this.maxEntries
    ) {
      return {
        ok: false,
        error: "capacity",
      };
    }

    let code: string | null = null;
    let digest: string | null = null;

    for (
      let attempt = 0;
      attempt < 4;
      attempt += 1
    ) {
      const candidate =
        this.codeFactory();

      if (
        !AUTHORIZATION_CODE.test(
          candidate,
        )
      ) {
        return {
          ok: false,
          error:
            "code_generation_failed",
        };
      }

      const candidateDigest =
        digestCode(candidate);

      if (
        !this.entries.has(
          candidateDigest,
        )
      ) {
        code = candidate;
        digest =
          candidateDigest;
        break;
      }
    }

    if (
      code === null
      || digest === null
    ) {
      return {
        ok: false,
        error:
          "code_generation_failed",
      };
    }

    const request =
      grant.request;

    const entry:
      AuthorizationCodeEntry = {
        digest,
        clientId:
          request.clientId,
        redirectUri:
          request.redirectUri,
        resource:
          request.resource,
        scopes:
          frozenScopes(
            request.scopes,
          ),
        codeChallenge:
          request.codeChallenge,
        createdAtMs: now,
        expiresAtMs:
          now + this.ttlMs,
      };

    this.entries.set(
      digest,
      entry,
    );

    return {
      ok: true,
      value: Object.freeze({
        code,
        expiresAtMs:
          entry.expiresAtMs,
      }),
    };
  }

  consume(
    presentedCode: string,
  ): OAuthAuthorizationCodeConsumeResult {
    const now = this.currentTime();

    this.purgeAt(now);

    if (
      !AUTHORIZATION_CODE.test(
        presentedCode,
      )
    ) {
      return {
        ok: false,
        error: "invalid_grant",
      };
    }

    const digest =
      digestCode(presentedCode);

    const entry =
      this.entries.get(digest);

    if (!entry) {
      return {
        ok: false,
        error: "invalid_grant",
      };
    }

    // Delete before returning authority-bearing
    // binding so a second redemption cannot
    // observe the same code as live.
    this.entries.delete(digest);

    return {
      ok: true,
      value: Object.freeze({
        binding: Object.freeze({
          code: presentedCode,
          clientId:
            entry.clientId,
          redirectUri:
            entry.redirectUri,
          resource:
            entry.resource,
          codeChallenge:
            entry.codeChallenge,
        }),
        scopes:
          frozenScopes(
            entry.scopes,
          ),
        expiresAtMs:
          entry.expiresAtMs,
      }),
    };
  }
}
