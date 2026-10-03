import {
  describe,
  expect,
  test,
} from "bun:test";

import {
  buildPortableCimdCurlInvocation,
  createPortableCimdPinnedTransport,
} from "../src/oauth-cimd-curl-runtime";
import type {
  CimdCurlCommandRunner,
} from "../src/oauth-cimd-curl-transport";
import type {
  CimdPinnedFetchRequest,
} from "../src/oauth-cimd-discovery";

const REQUEST:
  CimdPinnedFetchRequest = {
  url:
    "https://client.example/.well-known/oauth-client.json",
  allowedAddresses: [
    "93.184.216.34",
    "2606:4700:4700::1111",
  ],
  maxBytes: 5 * 1024,
  timeoutMs: 4_000,
  redirect: "manual",
};

function successMetadata(
  peer: string,
): string {
  return [
    "__TQQ_CIMD_STATUS__200",
    "__TQQ_CIMD_TYPE__application/json",
    `__TQQ_CIMD_PEER__${peer}`,
    "",
  ].join("\n");
}

describe(
  "portable CIMD curl runtime",
  () => {
    test(
      "uses a minimal no-shell command with no empty argv and one pinned peer",
      () => {
        const invocation =
          buildPortableCimdCurlInvocation(
            "/usr/bin/curl",
            REQUEST,
            "93.184.216.34",
            2_000,
          );

        expect(
          invocation.args,
        ).not.toContain("");
        expect(
          invocation.args,
        ).not.toContain(
          "--proxy",
        );
        expect(
          invocation.args,
        ).not.toContain(
          "--location",
        );
        expect(
          invocation.args,
        ).not.toContain(
          "--proto-redir",
        );
        expect(
          invocation.args,
        ).not.toContain(
          "--max-redirs",
        );

        const noProxy =
          invocation.args.indexOf(
            "--noproxy",
          );
        expect(
          invocation.args[
            noProxy + 1
          ],
        ).toBe("*");

        const protocol =
          invocation.args.indexOf(
            "--proto",
          );
        expect(
          invocation.args[
            protocol + 1
          ],
        ).toBe("=https");

        const resolve =
          invocation.args.indexOf(
            "--resolve",
          );
        expect(
          invocation.args[
            resolve + 1
          ],
        ).toBe(
          "client.example:443:93.184.216.34",
        );
      },
    );

    test(
      "tries at most one IPv4 and one IPv6 peer inside one total timeout budget",
      async () => {
        const seen:
          string[] = [];

        const run:
          CimdCurlCommandRunner =
          async (invocation) => {
            const index =
              invocation.args.indexOf(
                "--resolve",
              );
            const target =
              invocation.args[
                index + 1
              ]!;
            seen.push(target);

            if (
              target.endsWith(
                ":93.184.216.34",
              )
            ) {
              return {
                ok: false,
                error:
                  "process_failed",
                exitCode: 7,
              };
            }

            return {
              ok: true,
              exitCode: 0,
              stdout:
                new TextEncoder()
                  .encode(
                    '{"client_id":"https://client.example/.well-known/oauth-client.json"}',
                  ),
              stderr:
                successMetadata(
                  "2606:4700:4700::1111",
                ),
            };
          };

        const transport =
          createPortableCimdPinnedTransport(
            "/usr/bin/curl",
            run,
          );

        const response =
          await transport(REQUEST);

        expect(seen).toEqual([
          "client.example:443:93.184.216.34",
          "client.example:443:[2606:4700:4700::1111]",
        ]);
        expect(
          response.peerAddress,
        ).toBe(
          "2606:4700:4700::1111",
        );
      },
    );

    test(
      "rejects a successful transfer whose actual peer differs from the pinned peer",
      async () => {
        const transport =
          createPortableCimdPinnedTransport(
            "/usr/bin/curl",
            async () => ({
              ok: true,
              exitCode: 0,
              stdout:
                new TextEncoder()
                  .encode("{}"),
              stderr:
                successMetadata(
                  "8.8.8.8",
                ),
            }),
          );

        expect(
          transport(REQUEST),
        ).rejects.toThrow(
          "escaped the pinned address",
        );
      },
    );

    test(
      "keeps total attempts bounded and reports only the final curl exit code",
      async () => {
        let attempts = 0;

        const transport =
          createPortableCimdPinnedTransport(
            "/usr/bin/curl",
            async () => {
              attempts += 1;
              return {
                ok: false,
                error:
                  "process_failed",
                exitCode:
                  attempts === 1
                    ? 2
                    : 7,
              };
            },
          );

        await expect(
          transport(REQUEST),
        ).rejects.toThrow(
          "exit=7",
        );
        expect(attempts).toBe(2);
      },
    );
  },
);
