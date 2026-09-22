import {
  describe,
  expect,
  test,
} from "bun:test";

import {
  MAX_CIMD_DOCUMENT_BYTES,
  validateCimdDocument,
} from "../src/oauth-cimd-document";

const CLIENT_ID =
  "https://client.example/.well-known/oauth-client.json";

function document(
  overrides:
    Record<string, unknown> = {},
): string {
  return JSON.stringify({
    client_id:
      CLIENT_ID,
    client_name:
      "Example MCP Client",
    redirect_uris: [
      "https://client.example/oauth/callback",
    ],
    token_endpoint_auth_method:
      "none",
    grant_types: [
      "authorization_code",
    ],
    response_types: [
      "code",
    ],
    custom_extension:
      "ignored-but-preserved-by-source",
    ...overrides,
  });
}

describe(
  "CIMD public-client metadata validation",
  () => {
    test(
      "accepts a bounded public client with exact identity and HTTPS redirect registration",
      () => {
        expect(
          validateCimdDocument(
            CLIENT_ID,
            document(),
          ),
        ).toEqual({
          ok: true,
          value: {
            clientId:
              CLIENT_ID,
            clientName:
              "Example MCP Client",
            redirectUris: [
              "https://client.example/oauth/callback",
            ],
            tokenEndpointAuthMethod:
              "none",
          },
        });
      },
    );

    test(
      "requires byte-for-byte client_id equality",
      () => {
        expect(
          validateCimdDocument(
            CLIENT_ID,
            document({
              client_id:
                "https://client.example:443/.well-known/oauth-client.json",
            }),
          ),
        ).toEqual({
          ok: false,
          error:
            "client_id_mismatch",
        });
      },
    );

    test(
      "rejects symmetric client secrets and unsupported token authentication",
      () => {
        expect(
          validateCimdDocument(
            CLIENT_ID,
            document({
              client_secret:
                "must-not-exist",
            }),
          ),
        ).toEqual({
          ok: false,
          error:
            "client_secret_forbidden",
        });

        expect(
          validateCimdDocument(
            CLIENT_ID,
            document({
              token_endpoint_auth_method:
                "client_secret_basic",
            }),
          ),
        ).toEqual({
          ok: false,
          error:
            "unsupported_client_authentication",
        });
      },
    );

    test(
      "requires unique bounded HTTPS redirect URIs",
      () => {
        for (
          const redirectUris
          of [
            [
              "http://client.example/callback",
            ],
            [
              "https://client.example/callback#fragment",
            ],
            [
              "https://client.example/callback",
              "https://client.example/callback",
            ],
            [],
          ]
        ) {
          expect(
            validateCimdDocument(
              CLIENT_ID,
              document({
                redirect_uris:
                  redirectUris,
              }),
            ),
          ).toEqual({
            ok: false,
            error:
              "invalid_redirect_uris",
          });
        }
      },
    );

    test(
      "accepts omitted grant/response metadata but rejects incompatible declarations",
      () => {
        const minimal =
          JSON.stringify({
            client_id:
              CLIENT_ID,
            client_name:
              "Example MCP Client",
            redirect_uris: [
              "https://client.example/oauth/callback",
            ],
            token_endpoint_auth_method:
              "none",
          });

        expect(
          validateCimdDocument(
            CLIENT_ID,
            minimal,
          ).ok,
        ).toBe(true);

        expect(
          validateCimdDocument(
            CLIENT_ID,
            document({
              grant_types: [
                "client_credentials",
              ],
            }),
          ),
        ).toEqual({
          ok: false,
          error:
            "unsupported_grant_type",
        });

        expect(
          validateCimdDocument(
            CLIENT_ID,
            document({
              response_types: [
                "token",
              ],
            }),
          ),
        ).toEqual({
          ok: false,
          error:
            "unsupported_response_type",
        });
      },
    );

    test(
      "enforces the recommended 5 KiB processing ceiling",
      () => {
        const oversized =
          " ".repeat(
            MAX_CIMD_DOCUMENT_BYTES
              + 1,
          );

        expect(
          validateCimdDocument(
            CLIENT_ID,
            oversized,
          ),
        ).toEqual({
          ok: false,
          error:
            "document_too_large",
        });
      },
    );
  },
);
