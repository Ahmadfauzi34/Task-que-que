import {
  describe,
  expect,
  test,
} from "bun:test";

import {
  validateCimdClientId,
} from "../src/oauth-cimd-client-id";

describe(
  "CIMD client identifier URL validation",
  () => {
    test(
      "preserves an exact stable HTTPS client identifier",
      () => {
        expect(
          validateCimdClientId(
            "https://client.example/.well-known/oauth-client.json",
          ),
        ).toEqual({
          ok: true,
          value: {
            value:
              "https://client.example/.well-known/oauth-client.json",
            hostname:
              "client.example",
            port: null,
          },
        });

        expect(
          validateCimdClientId(
            "https://93.184.216.34:8443/client.json",
          ),
        ).toEqual({
          ok: true,
          value: {
            value:
              "https://93.184.216.34:8443/client.json",
            hostname:
              "93.184.216.34",
            port: "8443",
          },
        });
      },
    );

    test(
      "rejects insecure or ambiguous client identifiers",
      () => {
        const cases:
          Array<[string, string]> = [
            [
              "http://client.example/client.json",
              "https_required",
            ],
            [
              "https://user@client.example/client.json",
              "userinfo_forbidden",
            ],
            [
              "https://client.example/client.json?v=1",
              "query_forbidden",
            ],
            [
              "https://client.example/client.json#fragment",
              "fragment_forbidden",
            ],
            [
              "https://client.example",
              "path_required",
            ],
            [
              "https://client.example/",
              "root_path_forbidden",
            ],
            [
              "https://client.example/a/../client.json",
              "dot_segment_forbidden",
            ],
            [
              "https://client.example/a/%2e%2e/client.json",
              "dot_segment_forbidden",
            ],
          ];

        for (
          const [value, error]
          of cases
        ) {
          expect(
            validateCimdClientId(
              value,
            ),
          ).toEqual({
            ok: false,
            error,
          });
        }
      },
    );

    test(
      "rejects localhost and direct special-use IP destinations before DNS",
      () => {
        for (
          const value
          of [
            "https://localhost/client.json",
            "https://api.localhost/client.json",
          ]
        ) {
          expect(
            validateCimdClientId(
              value,
            ),
          ).toEqual({
            ok: false,
            error:
              "localhost_forbidden",
          });
        }

        for (
          const value
          of [
            "https://127.0.0.1/client.json",
            "https://10.0.0.1/client.json",
            "https://[::1]/client.json",
            "https://[fc00::1]/client.json",
          ]
        ) {
          expect(
            validateCimdClientId(
              value,
            ),
          ).toEqual({
            ok: false,
            error:
              "special_use_ip",
          });
        }
      },
    );
  },
);
