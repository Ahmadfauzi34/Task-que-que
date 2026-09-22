import {
  describe,
  expect,
  test,
} from "bun:test";

import {
  discoverCimdClient,
  type CimdPinnedFetchRequest,
} from "../src/oauth-cimd-discovery";

const CLIENT_ID =
  "https://client.example/.well-known/oauth-client.json";

function body(
  clientId = CLIENT_ID,
): string {
  return JSON.stringify({
    client_id:
      clientId,
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
  });
}

describe(
  "CIMD pinned discovery contract",
  () => {
    test(
      "accepts exactly one bounded 200 JSON fetch whose peer is in the validated DNS set",
      async () => {
        let captured:
          CimdPinnedFetchRequest
          | null = null;

        const result =
          await discoverCimdClient(
            CLIENT_ID,
            {
              resolve: async (
                hostname,
              ) => {
                expect(
                  hostname,
                ).toBe(
                  "client.example",
                );
                return [
                  "93.184.216.34",
                ];
              },
              fetchPinned:
                async (request) => {
                  captured = request;
                  return {
                    status: 200,
                    contentType:
                      "application/client-metadata+json; charset=utf-8",
                    body: body(),
                    peerAddress:
                      "93.184.216.34",
                  };
                },
            },
          );

        expect(result.ok).toBe(true);

        expect(captured).toEqual({
          url: CLIENT_ID,
          allowedAddresses: [
            "93.184.216.34",
          ],
          maxBytes: 5 * 1024,
          timeoutMs: 3_000,
          redirect: "manual",
        });

        if (!result.ok) {
          throw new Error(
            "expected successful discovery",
          );
        }

        expect(
          result.value.metadata,
        ).toEqual({
          clientId:
            CLIENT_ID,
          clientName:
            "Example MCP Client",
          redirectUris: [
            "https://client.example/oauth/callback",
          ],
          tokenEndpointAuthMethod:
            "none",
        });
      },
    );

    test(
      "blocks private DNS answers before any fetch is attempted",
      async () => {
        let fetched = false;

        const result =
          await discoverCimdClient(
            CLIENT_ID,
            {
              resolve:
                async () => [
                  "10.0.0.9",
                ],
              fetchPinned:
                async () => {
                  fetched = true;
                  throw new Error(
                    "must not fetch",
                  );
                },
            },
          );

        expect(result).toEqual({
          ok: false,
          error:
            "unsafe_resolution",
        });
        expect(fetched).toBe(false);
      },
    );

    test(
      "rejects DNS rebinding or transport drift through peer mismatch",
      async () => {
        const result =
          await discoverCimdClient(
            CLIENT_ID,
            {
              resolve:
                async () => [
                  "93.184.216.34",
                ],
              fetchPinned:
                async () => ({
                  status: 200,
                  contentType:
                    "application/json",
                  body: body(),
                  peerAddress:
                    "8.8.8.8",
                }),
            },
          );

        expect(result).toEqual({
          ok: false,
          error:
            "peer_mismatch",
        });
      },
    );

    test(
      "does not follow redirects and rejects non-JSON or malformed metadata",
      async () => {
        for (
          const response
          of [
            {
              status: 302,
              contentType:
                "application/json",
              body: body(),
              peerAddress:
                "93.184.216.34",
              error:
                "http_status",
            },
            {
              status: 200,
              contentType:
                "text/html",
              body: body(),
              peerAddress:
                "93.184.216.34",
              error:
                "invalid_content_type",
            },
            {
              status: 200,
              contentType:
                "application/json",
              body: body(
                "https://other.example/client.json",
              ),
              peerAddress:
                "93.184.216.34",
              error:
                "invalid_document",
            },
          ] as const
        ) {
          const result =
            await discoverCimdClient(
              CLIENT_ID,
              {
                resolve:
                  async () => [
                    "93.184.216.34",
                  ],
                fetchPinned:
                  async (request) => {
                    expect(
                      request.redirect,
                    ).toBe("manual");

                    return {
                      status:
                        response.status,
                      contentType:
                        response.contentType,
                      body:
                        response.body,
                      peerAddress:
                        response.peerAddress,
                    };
                  },
              },
            );

          expect(result).toEqual({
            ok: false,
            error:
              response.error,
          });
        }
      },
    );

    test(
      "fails closed when DNS or the pinned transport fails",
      async () => {
        expect(
          await discoverCimdClient(
            CLIENT_ID,
            {
              resolve:
                async () => {
                  throw new Error(
                    "dns down",
                  );
                },
              fetchPinned:
                async () => {
                  throw new Error(
                    "unused",
                  );
                },
            },
          ),
        ).toEqual({
          ok: false,
          error:
            "resolution_failed",
        });

        expect(
          await discoverCimdClient(
            CLIENT_ID,
            {
              resolve:
                async () => [
                  "93.184.216.34",
                ],
              fetchPinned:
                async () => {
                  throw new Error(
                    "network down",
                  );
                },
            },
          ),
        ).toEqual({
          ok: false,
          error:
            "fetch_failed",
        });
      },
    );
  },
);
