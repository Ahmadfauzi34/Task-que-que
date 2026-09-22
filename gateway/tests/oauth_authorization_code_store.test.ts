import {
  describe,
  expect,
  test,
} from "bun:test";

import {
  OAuthAuthorizationCodeStore,
} from "../src/oauth-authorization-code-store";

import {
  validateOAuthTokenRequest,
} from "../src/oauth-token-validation";

import type {
  ValidatedOAuthAuthorizationRequest,
} from "../src/oauth-authorization-validation";

const RFC7636_VERIFIER =
  "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

const RFC7636_CHALLENGE =
  "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const CODE_A =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const CODE_B =
  "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const CODE_C =
  "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

function request(
  overrides:
    Partial<ValidatedOAuthAuthorizationRequest> = {},
): ValidatedOAuthAuthorizationRequest {
  return {
    responseType: "code",
    clientId: "claude-public-client",
    redirectUri:
      "https://claude.example/api/mcp/auth_callback",
    resource:
      "https://mcp.example.com/mcp",
    scopes: [
      "capability.read",
    ],
    state: "state-123",
    codeChallenge:
      RFC7636_CHALLENGE,
    codeChallengeMethod: "S256",
    ...overrides,
  };
}

function sequence(
  ...values: string[]
): () => string {
  let index = 0;

  return () => {
    const value =
      values[index]
      ?? values[values.length - 1];

    index += 1;

    if (!value) {
      throw new Error(
        "test code sequence exhausted",
      );
    }

    return value;
  };
}

function tokenParams(
  code: string,
): URLSearchParams {
  return new URLSearchParams({
    grant_type:
      "authorization_code",
    code,
    client_id:
      "claude-public-client",
    redirect_uri:
      "https://claude.example/api/mcp/auth_callback",
    resource:
      "https://mcp.example.com/mcp",
    code_verifier:
      RFC7636_VERIFIER,
  });
}

describe(
  "bounded single-use OAuth authorization code store",
  () => {
    test(
      "issues an opaque code and consumes it exactly once",
      () => {
        const store =
          new OAuthAuthorizationCodeStore({
            now: () => 1_000,
            codeFactory:
              sequence(CODE_A),
          });

        const issued =
          store.issue({
            request: request(),
          });

        expect(issued).toEqual({
          ok: true,
          value: {
            code: CODE_A,
            expiresAtMs: 121_000,
          },
        });

        expect(store.size()).toBe(1);

        const consumed =
          store.consume(CODE_A);

        expect(consumed.ok).toBe(true);

        if (!consumed.ok) {
          throw new Error(
            "expected authorization-code consumption",
          );
        }

        expect(
          consumed.value.binding,
        ).toEqual({
          code: CODE_A,
          clientId:
            "claude-public-client",
          redirectUri:
            "https://claude.example/api/mcp/auth_callback",
          resource:
            "https://mcp.example.com/mcp",
          codeChallenge:
            RFC7636_CHALLENGE,
        });

        expect(
          consumed.value.scopes,
        ).toEqual([
          "capability.read",
        ]);

        expect(store.size()).toBe(0);

        expect(
          store.consume(CODE_A),
        ).toEqual({
          ok: false,
          error: "invalid_grant",
        });
      },
    );

    test(
      "returns a binding that the existing PKCE token validator accepts",
      async () => {
        const store =
          new OAuthAuthorizationCodeStore({
            now: () => 1_000,
            codeFactory:
              sequence(CODE_A),
          });

        const issued =
          store.issue({
            request: request(),
          });

        expect(issued.ok).toBe(true);

        const consumed =
          store.consume(CODE_A);

        expect(consumed.ok).toBe(true);

        if (!consumed.ok) {
          throw new Error(
            "expected consumed code",
          );
        }

        const validated =
          await validateOAuthTokenRequest(
            tokenParams(CODE_A),
            consumed.value.binding,
          );

        expect(validated.ok).toBe(true);
      },
    );

    test(
      "expires codes and fails closed at the exact TTL boundary",
      () => {
        let now = 10_000;

        const store =
          new OAuthAuthorizationCodeStore({
            ttlMs: 1_000,
            now: () => now,
            codeFactory:
              sequence(CODE_A),
          });

        expect(
          store.issue({
            request: request(),
          }).ok,
        ).toBe(true);

        now = 10_999;

        expect(store.size()).toBe(1);

        now = 11_000;

        expect(
          store.consume(CODE_A),
        ).toEqual({
          ok: false,
          error: "invalid_grant",
        });

        expect(store.size()).toBe(0);
      },
    );

    test(
      "fails closed at capacity without evicting a live code",
      () => {
        const store =
          new OAuthAuthorizationCodeStore({
            maxEntries: 2,
            now: () => 1_000,
            codeFactory:
              sequence(
                CODE_A,
                CODE_B,
                CODE_C,
              ),
          });

        expect(
          store.issue({
            request: request(),
          }).ok,
        ).toBe(true);

        expect(
          store.issue({
            request: request({
              state: "state-2",
            }),
          }).ok,
        ).toBe(true);

        expect(
          store.issue({
            request: request({
              state: "state-3",
            }),
          }),
        ).toEqual({
          ok: false,
          error: "capacity",
        });

        expect(store.size()).toBe(2);

        expect(
          store.consume(CODE_A).ok,
        ).toBe(true);

        expect(
          store.consume(CODE_B).ok,
        ).toBe(true);
      },
    );

    test(
      "does not replace a live code when generation collides repeatedly",
      () => {
        const store =
          new OAuthAuthorizationCodeStore({
            now: () => 1_000,
            codeFactory: () => CODE_A,
          });

        expect(
          store.issue({
            request: request(),
          }).ok,
        ).toBe(true);

        expect(
          store.issue({
            request: request({
              state: "second",
            }),
          }),
        ).toEqual({
          ok: false,
          error:
            "code_generation_failed",
        });

        expect(store.size()).toBe(1);

        expect(
          store.consume(CODE_A).ok,
        ).toBe(true);
      },
    );

    test(
      "rejects malformed generated and presented codes",
      () => {
        const malformedFactory =
          new OAuthAuthorizationCodeStore({
            now: () => 1_000,
            codeFactory:
              () => "too-short",
          });

        expect(
          malformedFactory.issue({
            request: request(),
          }),
        ).toEqual({
          ok: false,
          error:
            "code_generation_failed",
        });

        const store =
          new OAuthAuthorizationCodeStore({
            now: () => 1_000,
            codeFactory:
              sequence(CODE_A),
          });

        expect(
          store.consume("too-short"),
        ).toEqual({
          ok: false,
          error: "invalid_grant",
        });
      },
    );

    test(
      "copies authority-bearing scopes so caller mutation cannot widen the stored grant",
      () => {
        const scopes = [
          "capability.read",
        ];

        const grantRequest =
          request({ scopes });

        const store =
          new OAuthAuthorizationCodeStore({
            now: () => 1_000,
            codeFactory:
              sequence(CODE_A),
          });

        expect(
          store.issue({
            request: grantRequest,
          }).ok,
        ).toBe(true);

        scopes.push(
          "process.command.admin",
        );

        const consumed =
          store.consume(CODE_A);

        expect(consumed.ok).toBe(true);

        if (consumed.ok) {
          expect(
            consumed.value.scopes,
          ).toEqual([
            "capability.read",
          ]);
        }
      },
    );

    test(
      "defensively rejects malformed direct grants before code authority exists",
      () => {
        const malformed = [
          request({
            state:
              "x".repeat(1_025),
          }),
          request({
            scopes: [
              "capability.read",
              "capability.read",
            ],
          }),
          request({
            resource:
              "http://mcp.example.com/mcp",
          }),
          request({
            redirectUri:
              "http://claude.example/callback",
          }),
          request({
            codeChallenge:
              "too-short",
          }),
          request({
            codeChallengeMethod:
              "plain" as "S256",
          }),
        ];

        for (
          const candidate
          of malformed
        ) {
          const store =
            new OAuthAuthorizationCodeStore({
              now: () => 1_000,
              codeFactory:
                sequence(CODE_A),
            });

          expect(
            store.issue({
              request: candidate,
            }),
          ).toEqual({
            ok: false,
            error: "invalid_grant",
          });

          expect(store.size()).toBe(0);
        }
      },
    );

    test(
      "purges expired entries before applying capacity",
      () => {
        let now = 1_000;

        const store =
          new OAuthAuthorizationCodeStore({
            maxEntries: 1,
            ttlMs: 1_000,
            now: () => now,
            codeFactory:
              sequence(
                CODE_A,
                CODE_B,
              ),
          });

        expect(
          store.issue({
            request: request(),
          }).ok,
        ).toBe(true);

        now = 2_000;

        const replacement =
          store.issue({
            request: request({
              state: "replacement",
            }),
          });

        expect(replacement).toEqual({
          ok: true,
          value: {
            code: CODE_B,
            expiresAtMs: 3_000,
          },
        });

        expect(store.size()).toBe(1);
      },
    );
  },
);
