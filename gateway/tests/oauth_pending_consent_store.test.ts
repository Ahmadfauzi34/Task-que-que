import {
  describe,
  expect,
  test,
} from "bun:test";

import {
  PendingOAuthConsentStore,
} from "../src/oauth-pending-consent-store";

import type {
  ValidatedOAuthAuthorizationRequest,
} from "../src/oauth-authorization-validation";

const CHALLENGE =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function validRequest(
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
    codeChallenge: CHALLENGE,
    codeChallengeMethod: "S256",
    ...overrides,
  };
}

function idSequence(
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
        "test id sequence exhausted",
      );
    }

    return value;
  };
}

const ID_A =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const ID_B =
  "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const ID_C =
  "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

describe(
  "bounded OAuth pending consent store",
  () => {
    test(
      "stores a validated request but exposes only a safe operator projection",
      () => {
        let now = 1_000;

        const store =
          new PendingOAuthConsentStore({
            now: () => now,
            idFactory:
              idSequence(ID_A),
          });

        const created =
          store.create(
            validRequest(),
          );

        expect(created.ok).toBe(true);

        if (!created.ok) {
          throw new Error(
            "expected consent creation",
          );
        }

        expect(created.value).toEqual({
          requestId: ID_A,
          clientId:
            "claude-public-client",
          redirectUri:
            "https://claude.example/api/mcp/auth_callback",
          resource:
            "https://mcp.example.com/mcp",
          scopes: [
            "capability.read",
          ],
          status: "pending",
          createdAtMs: 1_000,
          expiresAtMs: 301_000,
        });

        expect(
          "state" in created.value,
        ).toBe(false);

        expect(
          "codeChallenge"
            in created.value,
        ).toBe(false);

        expect(store.size()).toBe(1);

        now += 1;
        expect(
          store.get(ID_A)?.status,
        ).toBe("pending");
      },
    );

    test(
      "fails closed at capacity without evicting an existing pending request",
      () => {
        const store =
          new PendingOAuthConsentStore({
            maxEntries: 2,
            now: () => 1_000,
            idFactory:
              idSequence(
                ID_A,
                ID_B,
                ID_C,
              ),
          });

        expect(
          store.create(
            validRequest(),
          ).ok,
        ).toBe(true);

        expect(
          store.create(
            validRequest({
              state: "state-2",
            }),
          ).ok,
        ).toBe(true);

        expect(
          store.create(
            validRequest({
              state: "state-3",
            }),
          ),
        ).toEqual({
          ok: false,
          error: "capacity",
        });

        expect(store.size()).toBe(2);
        expect(
          store.get(ID_A),
        ).not.toBeNull();
        expect(
          store.get(ID_B),
        ).not.toBeNull();
      },
    );

    test(
      "expires pending state and refuses decisions after expiry",
      () => {
        let now = 10_000;

        const store =
          new PendingOAuthConsentStore({
            ttlMs: 1_000,
            now: () => now,
            idFactory:
              idSequence(ID_A),
          });

        expect(
          store.create(
            validRequest(),
          ).ok,
        ).toBe(true);

        now = 10_999;

        expect(
          store.get(ID_A),
        ).not.toBeNull();

        now = 11_000;

        expect(
          store.get(ID_A),
        ).toBeNull();

        expect(
          store.decide(
            ID_A,
            "approved",
          ),
        ).toEqual({
          ok: false,
          error: "not_found",
        });

        expect(store.size()).toBe(0);
      },
    );

    test(
      "allows one operator decision and one internal consumption only",
      () => {
        const store =
          new PendingOAuthConsentStore({
            now: () => 1_000,
            idFactory:
              idSequence(ID_A),
          });

        const created =
          store.create(
            validRequest(),
          );

        expect(created.ok).toBe(true);

        const decision =
          store.decide(
            ID_A,
            "approved",
          );

        expect(decision.ok).toBe(true);

        if (decision.ok) {
          expect(
            decision.value.status,
          ).toBe("approved");
        }

        expect(
          store.decide(
            ID_A,
            "denied",
          ),
        ).toEqual({
          ok: false,
          error: "already_decided",
        });

        const consumed =
          store.consumeDecision(
            ID_A,
          );

        expect(consumed.ok).toBe(true);

        if (!consumed.ok) {
          throw new Error(
            "expected decided request",
          );
        }

        expect(
          consumed.value.decision,
        ).toBe("approved");

        expect(
          consumed.value.request.state,
        ).toBe("state-123");

        expect(
          consumed.value.request
            .codeChallenge,
        ).toBe(CHALLENGE);

        expect(
          store.consumeDecision(
            ID_A,
          ),
        ).toEqual({
          ok: false,
          error: "not_found",
        });

        expect(store.size()).toBe(0);
      },
    );

    test(
      "does not allow consuming a request before operator decision",
      () => {
        const store =
          new PendingOAuthConsentStore({
            now: () => 1_000,
            idFactory:
              idSequence(ID_A),
          });

        store.create(
          validRequest(),
        );

        expect(
          store.consumeDecision(
            ID_A,
          ),
        ).toEqual({
          ok: false,
          error: "pending",
        });

        expect(store.size()).toBe(1);
      },
    );

    test(
      "copies the validated request so caller mutation cannot change stored authority",
      () => {
        const scopes = [
          "capability.read",
        ];

        const request =
          validRequest({
            scopes,
          });

        const store =
          new PendingOAuthConsentStore({
            now: () => 1_000,
            idFactory:
              idSequence(ID_A),
          });

        expect(
          store.create(request).ok,
        ).toBe(true);

        scopes.push(
          "process.command.admin",
        );

        store.decide(
          ID_A,
          "approved",
        );

        const consumed =
          store.consumeDecision(
            ID_A,
          );

        expect(consumed.ok).toBe(true);

        if (consumed.ok) {
          expect(
            consumed.value.request
              .scopes,
          ).toEqual([
            "capability.read",
          ]);
        }
      },
    );

    test(
      "defensively rejects malformed or unbounded direct callers",
      () => {
        const requests = [
          validRequest({
            state:
              "x".repeat(1_025),
          }),
          validRequest({
            scopes: [
              "capability.read",
              "capability.read",
            ],
          }),
          validRequest({
            resource:
              "http://mcp.example.com/mcp",
          }),
          validRequest({
            codeChallenge:
              "too-short",
          }),
          validRequest({
            codeChallengeMethod:
              "plain" as "S256",
          }),
        ];

        for (
          let index = 0;
          index < requests.length;
          index += 1
        ) {
          const store =
            new PendingOAuthConsentStore({
              now: () => 1_000,
              idFactory:
                idSequence(ID_A),
            });

          expect(
            store.create(
              requests[index]!,
            ),
          ).toEqual({
            ok: false,
            error: "invalid_request",
          });
        }
      },
    );

    test(
      "fails closed if request identifiers collide repeatedly",
      () => {
        const store =
          new PendingOAuthConsentStore({
            now: () => 1_000,
            idFactory:
              () => ID_A,
          });

        expect(
          store.create(
            validRequest(),
          ).ok,
        ).toBe(true);

        expect(
          store.create(
            validRequest({
              state: "state-2",
            }),
          ),
        ).toEqual({
          ok: false,
          error:
            "id_generation_failed",
        });

        expect(store.size()).toBe(1);
      },
    );

    test(
      "lists pending decisions deterministically without exposing PKCE or state",
      () => {
        let now = 1_000;

        const store =
          new PendingOAuthConsentStore({
            now: () => now,
            idFactory:
              idSequence(
                ID_B,
                ID_A,
              ),
          });

        store.create(
          validRequest({
            state: "first",
          }),
        );

        now = 1_001;

        store.create(
          validRequest({
            state: "second",
          }),
        );

        const listed =
          store.list();

        expect(
          listed.map(
            (item) =>
              item.requestId,
          ),
        ).toEqual([
          ID_B,
          ID_A,
        ]);

        for (const item of listed) {
          expect(
            "state" in item,
          ).toBe(false);

          expect(
            "codeChallenge" in item,
          ).toBe(false);
        }
      },
    );
  },
);
