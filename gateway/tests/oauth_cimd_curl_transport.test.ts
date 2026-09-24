import {
  describe,
  expect,
  test,
} from "bun:test";

import {
  CIMD_CURL_METADATA_MARKER,
  buildCimdCurlInvocation,
  createCurlCimdPinnedTransport,
  runCimdCurlCommand,
  type CimdCurlCommandRunner,
} from "../src/oauth-cimd-curl-transport";
import type {
  CimdPinnedFetchRequest,
} from "../src/oauth-cimd-discovery";

const REQUEST:
  CimdPinnedFetchRequest = {
  url:
    "https://client.example:8443/.well-known/oauth-client.json",
  allowedAddresses: [
    "93.184.216.34",
    "2606:4700:4700::1111",
  ],
  maxBytes: 5 * 1024,
  timeoutMs: 3_000,
  redirect: "manual",
};

function metadata(
  overrides:
    Record<string, unknown> = {},
): string {
  return [
    "curl diagnostic",
    `${CIMD_CURL_METADATA_MARKER}${JSON.stringify({
      http_code: 200,
      content_type:
        "application/client-metadata+json",
      remote_ip:
        "93.184.216.34",
      ...overrides,
    })}`,
    "",
  ].join("\n");
}

describe(
  "CIMD pinned curl transport",
  () => {
    test(
      "builds a no-shell HTTPS-only direct invocation pinned to the validated address set",
      () => {
        const invocation =
          buildCimdCurlInvocation(
            "/usr/bin/curl",
            REQUEST,
          );

        expect(
          invocation.binary,
        ).toBe("/usr/bin/curl");

        expect(
          invocation.args[0],
        ).toBe("--disable");

        expect(
          invocation.args,
        ).toContain(
          "--globoff",
        );

        expect(
          invocation.args,
        ).not.toContain(
          "--location",
        );

        const proxyIndex =
          invocation.args.indexOf(
            "--proxy",
          );
        expect(
          invocation.args[
            proxyIndex + 1
          ],
        ).toBe("");

        const noProxyIndex =
          invocation.args.indexOf(
            "--noproxy",
          );
        expect(
          invocation.args[
            noProxyIndex + 1
          ],
        ).toBe("*");

        const protoIndex =
          invocation.args.indexOf(
            "--proto",
          );
        expect(
          invocation.args[
            protoIndex + 1
          ],
        ).toBe("=https");

        const redirectIndex =
          invocation.args.indexOf(
            "--proto-redir",
          );
        expect(
          invocation.args[
            redirectIndex + 1
          ],
        ).toBe("-all");

        const maxRedirsIndex =
          invocation.args.indexOf(
            "--max-redirs",
          );
        expect(
          invocation.args[
            maxRedirsIndex + 1
          ],
        ).toBe("0");

        const resolveIndex =
          invocation.args.indexOf(
            "--resolve",
          );
        expect(
          invocation.args[
            resolveIndex + 1
          ],
        ).toBe(
          "client.example:8443:93.184.216.34,[2606:4700:4700::1111]",
        );

        const maxFileIndex =
          invocation.args.indexOf(
            "--max-filesize",
          );
        expect(
          invocation.args[
            maxFileIndex + 1
          ],
        ).toBe("5120");

        expect(
          invocation.args[
            invocation.args.length - 1
          ],
        ).toBe(REQUEST.url);

        expect(
          invocation.timeoutMs,
        ).toBe(4_000);

        expect(
          invocation.maxStdoutBytes,
        ).toBe(5 * 1024);
      },
    );

    test(
      "returns the bounded body and the actual curl peer to the discovery layer",
      async () => {
        let captured:
          ReturnType<
            typeof buildCimdCurlInvocation
          >
          | null = null;

        const run:
          CimdCurlCommandRunner =
          async (invocation) => {
            captured = invocation;
            return {
              ok: true,
              exitCode: 0,
              stdout:
                new TextEncoder()
                  .encode(
                    '{"client_id":"https://client.example/client.json"}',
                  ),
              stderr:
                metadata(),
            };
          };

        const transport =
          createCurlCimdPinnedTransport(
            "/usr/bin/curl",
            run,
          );

        const response =
          await transport(
            REQUEST,
          );

        expect(captured).not.toBeNull();

        expect(response).toEqual({
          status: 200,
          contentType:
            "application/client-metadata+json",
          body:
            '{"client_id":"https://client.example/client.json"}',
          peerAddress:
            "93.184.216.34",
        });
      },
    );

    test(
      "rejects a remote peer outside the validated DNS set",
      async () => {
        const transport =
          createCurlCimdPinnedTransport(
            "/usr/bin/curl",
            async () => ({
              ok: true,
              exitCode: 0,
              stdout:
                new TextEncoder()
                  .encode("{}"),
              stderr:
                metadata({
                  remote_ip:
                    "8.8.8.8",
                }),
            }),
          );

        expect(
          transport(REQUEST),
        ).rejects.toThrow(
          "outside the pinned address set",
        );
      },
    );

    test(
      "rejects malformed curl metadata and non-UTF8 response bodies",
      async () => {
        const malformed =
          createCurlCimdPinnedTransport(
            "/usr/bin/curl",
            async () => ({
              ok: true,
              exitCode: 0,
              stdout:
                new TextEncoder()
                  .encode("{}"),
              stderr:
                "missing marker",
            }),
          );

        expect(
          malformed(REQUEST),
        ).rejects.toThrow(
          "metadata marker is missing",
        );

        const binaryBody =
          createCurlCimdPinnedTransport(
            "/usr/bin/curl",
            async () => ({
              ok: true,
              exitCode: 0,
              stdout:
                new Uint8Array([
                  0xff,
                  0xfe,
                ]),
              stderr:
                metadata(),
            }),
          );

        expect(
          binaryBody(REQUEST),
        ).rejects.toThrow(
          "not valid UTF-8",
        );
      },
    );

    test(
      "includes the native curl exit code on process failure without exposing response authority",
      async () => {
        const transport =
          createCurlCimdPinnedTransport(
            "/usr/bin/curl",
            async () => ({
              ok: false,
              error:
                "process_failed",
              exitCode: 60,
            }),
          );

        expect(
          transport(REQUEST),
        ).rejects.toThrow(
          "process_failed (exit=60)",
        );
      },
    );

    test(
      "defensively rejects ambiguous or unbounded pinned requests",
      () => {
        expect(() =>
          buildCimdCurlInvocation(
            "curl",
            REQUEST,
          ),
        ).toThrow(
          "absolute POSIX path",
        );

        expect(() =>
          buildCimdCurlInvocation(
            "/usr/bin/curl",
            {
              ...REQUEST,
              url:
                "http://client.example/client.json",
            },
          ),
        ).toThrow(
          "unambiguous HTTPS",
        );

        expect(() =>
          buildCimdCurlInvocation(
            "/usr/bin/curl",
            {
              ...REQUEST,
              allowedAddresses: [
                "93.184.216.34",
                "93.184.216.34",
              ],
            },
          ),
        ).toThrow(
          "duplicate destinations",
        );

        expect(() =>
          buildCimdCurlInvocation(
            "/usr/bin/curl",
            {
              ...REQUEST,
              maxBytes:
                9 * 1024,
            },
          ),
        ).toThrow(
          "outside the transport contract",
        );
      },
    );

    test(
      "native command runner preserves TLS/runtime environment but strips proxy routing",
      async () => {
        const previousCert =
          process.env.SSL_CERT_FILE;
        const previousProxy =
          process.env.HTTPS_PROXY;

        process.env.SSL_CERT_FILE =
          "/tmp/tqq-cimd-ca.pem";
        process.env.HTTPS_PROXY =
          "http://127.0.0.1:9999";

        try {
          const result =
            await runCimdCurlCommand({
              binary: "/bin/sh",
              args: [
                "-c",
                'printf "%s|%s" "$SSL_CERT_FILE" "$HTTPS_PROXY"',
              ],
              timeoutMs: 1_000,
              maxStdoutBytes: 1_024,
              maxStderrBytes: 1_024,
            });

          expect(result.ok).toBe(true);

          if (!result.ok) {
            throw new Error(
              "environment probe failed",
            );
          }

          expect(
            new TextDecoder().decode(
              result.stdout,
            ),
          ).toBe(
            "/tmp/tqq-cimd-ca.pem|",
          );
        } finally {
          if (
            previousCert === undefined
          ) {
            delete process.env.SSL_CERT_FILE;
          } else {
            process.env.SSL_CERT_FILE =
              previousCert;
          }

          if (
            previousProxy === undefined
          ) {
            delete process.env.HTTPS_PROXY;
          } else {
            process.env.HTTPS_PROXY =
              previousProxy;
          }
        }
      },
    );

    test(
      "native command runner bounds stdout independently of curl's own max-filesize",
      async () => {
        const result =
          await runCimdCurlCommand({
            binary: "/bin/sh",
            args: [
              "-c",
              "printf 123456789",
            ],
            timeoutMs: 1_000,
            maxStdoutBytes: 4,
            maxStderrBytes: 1_024,
          });

        expect(result).toEqual({
          ok: false,
          error:
            "output_too_large",
        });
      },
    );
  },
);
