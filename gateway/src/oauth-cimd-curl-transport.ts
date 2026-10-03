import { Buffer } from "node:buffer";
import {
  spawn,
} from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  realpathSync,
} from "node:fs";
import {
  lookup,
} from "node:dns/promises";
import {
  isIP,
} from "node:net";
import {
  posix,
} from "node:path";

import type {
  CimdDiscoveryDependencies,
  CimdPinnedFetchRequest,
  CimdPinnedFetchResponse,
  CimdPinnedTransport,
  CimdResolver,
} from "./oauth-cimd-discovery";

const MAX_CURL_STDERR_BYTES =
  64 * 1024;
const MAX_TRANSPORT_BODY_BYTES =
  8 * 1024;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10_000;

export const CIMD_CURL_METADATA_MARKER =
  "__TQQ_CIMD_META__";

export interface CimdCurlInvocation {
  binary: string;
  args: readonly string[];
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

export type CimdCurlRunResult =
  | {
      ok: true;
      exitCode: 0;
      stdout: Uint8Array;
      stderr: string;
    }
  | {
      ok: false;
      error:
        | "spawn_failed"
        | "timeout"
        | "output_too_large"
        | "process_failed";
      exitCode?: number;
    };

export type CimdCurlCommandRunner = (
  invocation: CimdCurlInvocation,
) => Promise<CimdCurlRunResult>;

function boundedAbsoluteBinary(
  value: string,
): string {
  if (
    value.length === 0
    || value.length > 4_096
    || value.includes("\0")
    || !posix.isAbsolute(value)
  ) {
    throw new Error(
      "CIMD curl binary must be a bounded absolute POSIX path",
    );
  }

  const normalized =
    posix.normalize(value);

  if (normalized === "/") {
    throw new Error(
      "CIMD curl binary must identify an executable",
    );
  }

  return normalized;
}

export function validateConfiguredCimdCurlBinary(
  value: string,
): string {
  const binary =
    boundedAbsoluteBinary(value);

  let stat;
  try {
    stat = lstatSync(binary);
    accessSync(
      binary,
      fsConstants.X_OK,
    );
  } catch {
    throw new Error(
      "configured CIMD curl binary is unavailable or not executable",
    );
  }

  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || posix.normalize(
      realpathSync(binary),
    ) !== binary
  ) {
    throw new Error(
      "configured CIMD curl binary must be a canonical non-symlink executable",
    );
  }

  return binary;
}

function normalizedAddress(
  value: string,
): string {
  return (
    value.startsWith("[")
    && value.endsWith("]")
  )
    ? value.slice(1, -1)
    : value;
}

function curlResolveAddress(
  address: string,
): string {
  const normalized =
    normalizedAddress(address);

  return isIP(normalized) === 6
    ? `[${normalized}]`
    : normalized;
}

function boundedRequest(
  request: CimdPinnedFetchRequest,
): {
  url: URL;
  addresses: readonly string[];
} {
  if (
    request.redirect !== "manual"
    || !Number.isInteger(
      request.maxBytes,
    )
    || request.maxBytes < 1
    || request.maxBytes
      > MAX_TRANSPORT_BODY_BYTES
    || !Number.isInteger(
      request.timeoutMs,
    )
    || request.timeoutMs
      < MIN_TIMEOUT_MS
    || request.timeoutMs
      > MAX_TIMEOUT_MS
    || request.allowedAddresses.length
      < 1
    || request.allowedAddresses.length
      > 16
  ) {
    throw new Error(
      "CIMD pinned request is outside the transport contract",
    );
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new Error(
      "CIMD pinned request URL is invalid",
    );
  }

  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.hash
    || request.url.includes("\r")
    || request.url.includes("\n")
  ) {
    throw new Error(
      "CIMD pinned request must use unambiguous HTTPS",
    );
  }

  const addresses =
    request.allowedAddresses.map(
      (raw) => {
        const address =
          normalizedAddress(raw);

        if (isIP(address) === 0) {
          throw new Error(
            "CIMD pinned request contains a non-IP destination",
          );
        }

        return address;
      },
    );

  if (
    new Set(addresses).size
      !== addresses.length
  ) {
    throw new Error(
      "CIMD pinned request contains duplicate destinations",
    );
  }

  return {
    url,
    addresses:
      Object.freeze(addresses),
  };
}

export function buildCimdCurlInvocation(
  binary: string,
  request: CimdPinnedFetchRequest,
): CimdCurlInvocation {
  const curlBin =
    boundedAbsoluteBinary(binary);

  const bounded =
    boundedRequest(request);

  const hostname =
    bounded.url.hostname
      .replace(/^\[/, "")
      .replace(/\]$/, "");

  const port =
    bounded.url.port || "443";

  const resolveTarget =
    `${hostname}:${port}:${
      bounded.addresses
        .map(curlResolveAddress)
        .join(",")
    }`;

  const timeoutSeconds =
    (
      request.timeoutMs
      / 1_000
    ).toFixed(3);

  return Object.freeze({
    binary: curlBin,
    args: Object.freeze([
      "--disable",
      "--globoff",
      "--silent",
      "--show-error",
      "--proxy",
      "",
      "--noproxy",
      "*",
      "--request",
      "GET",
      "--proto",
      "=https",
      "--proto-redir",
      "-all",
      "--max-redirs",
      "0",
      "--connect-timeout",
      timeoutSeconds,
      "--max-time",
      timeoutSeconds,
      "--max-filesize",
      String(request.maxBytes),
      "--header",
      "Accept: application/json, application/*+json",
      "--header",
      "User-Agent: task-que-que-cimd/1",
      "--resolve",
      resolveTarget,
      "--write-out",
      `%{stderr}\n${CIMD_CURL_METADATA_MARKER}%{json}\n`,
      request.url,
    ]),
    timeoutMs:
      request.timeoutMs + 1_000,
    maxStdoutBytes:
      request.maxBytes,
    maxStderrBytes:
      MAX_CURL_STDERR_BYTES,
  });
}

function nativeCurlEnvironment():
  NodeJS.ProcessEnv {
  const environment:
    NodeJS.ProcessEnv = {
      ...process.env,
      LANG: "C",
      LC_ALL: "C",
      http_proxy: "",
      https_proxy: "",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      all_proxy: "",
      ALL_PROXY: "",
      no_proxy: "*",
      NO_PROXY: "*",
    };

  // Avoid side-channel TLS logging and curl state/config
  // destinations while preserving the native platform's
  // runtime and CA environment (important on Termux).
  delete environment.SSLKEYLOGFILE;
  delete environment.QLOGDIR;
  delete environment.NETRC;
  delete environment.CURL_HOME;
  delete environment.XDG_CONFIG_HOME;

  return environment;
}

function killProcessGroup(
  child: ReturnType<typeof spawn>,
): void {
  const pid = child.pid;

  if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Fall through to direct-child cleanup.
    }
  }

  try {
    child.kill("SIGKILL");
  } catch {
    // Child may already be terminal.
  }
}

export async function runCimdCurlCommand(
  invocation: CimdCurlInvocation,
): Promise<CimdCurlRunResult> {
  return new Promise((resolve) => {
    let child:
      ReturnType<typeof spawn>;

    try {
      child = spawn(
        invocation.binary,
        [...invocation.args],
        {
          env:
            nativeCurlEnvironment(),
          shell: false,
          detached: true,
          stdio: [
            "ignore",
            "pipe",
            "pipe",
          ],
        },
      );
    } catch {
      resolve({
        ok: false,
        error: "spawn_failed",
      });
      return;
    }

    let settled = false;
    let terminated:
      "timeout"
      | "output_too_large"
      | null = null;

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timer:
      ReturnType<typeof setTimeout>
      | null = null;

    const finish = (
      result: CimdCurlRunResult,
    ) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    const terminate = (
      error:
        "timeout"
        | "output_too_large",
    ) => {
      if (
        settled
        || terminated !== null
      ) {
        return;
      }

      terminated = error;
      killProcessGroup(child);
    };

    child.stdout?.on(
      "data",
      (chunk: Buffer) => {
        if (terminated !== null) {
          return;
        }

        stdoutBytes +=
          chunk.byteLength;

        if (
          stdoutBytes
            > invocation
              .maxStdoutBytes
        ) {
          terminate(
            "output_too_large",
          );
          return;
        }

        stdout.push(chunk);
      },
    );

    child.stderr?.on(
      "data",
      (chunk: Buffer) => {
        if (terminated !== null) {
          return;
        }

        stderrBytes +=
          chunk.byteLength;

        if (
          stderrBytes
            > invocation
              .maxStderrBytes
        ) {
          terminate(
            "output_too_large",
          );
          return;
        }

        stderr.push(chunk);
      },
    );

    child.on(
      "error",
      () => finish({
        ok: false,
        error: "spawn_failed",
      }),
    );

    child.on(
      "close",
      (code) => {
        if (settled) return;

        if (terminated !== null) {
          finish({
            ok: false,
            error: terminated,
          });
          return;
        }

        if (code !== 0) {
          finish({
            ok: false,
            error:
              "process_failed",
            ...(typeof code
              === "number"
              ? {
                  exitCode:
                    code,
                }
              : {}),
          });
          return;
        }

        finish({
          ok: true,
          exitCode: 0,
          stdout:
            Buffer.concat(
              stdout,
              stdoutBytes,
            ),
          stderr:
            Buffer.concat(
              stderr,
              stderrBytes,
            ).toString("utf8"),
        });
      },
    );

    timer = setTimeout(
      () => terminate("timeout"),
      invocation.timeoutMs,
    );
  });
}

function parseCurlMetadata(
  stderr: string,
): {
  status: number;
  contentType: string | null;
  peerAddress: string;
} {
  const markerIndex =
    stderr.lastIndexOf(
      CIMD_CURL_METADATA_MARKER,
    );

  if (markerIndex < 0) {
    throw new Error(
      "CIMD curl metadata marker is missing",
    );
  }

  const tail =
    stderr.slice(
      markerIndex
        + CIMD_CURL_METADATA_MARKER
          .length,
    );

  const line =
    tail.split(
      /\r?\n/,
      1,
    )[0]!;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(
      "CIMD curl metadata is malformed",
    );
  }

  if (
    parsed === null
    || typeof parsed !== "object"
    || Array.isArray(parsed)
  ) {
    throw new Error(
      "CIMD curl metadata is malformed",
    );
  }

  const metadata =
    parsed as Record<
      string,
      unknown
    >;

  const status =
    typeof metadata.http_code
      === "number"
      ? metadata.http_code
      : Number(
          metadata.http_code,
        );

  const peerAddress =
    typeof metadata.remote_ip
      === "string"
      ? normalizedAddress(
          metadata.remote_ip,
        )
      : "";

  const contentType =
    metadata.content_type === null
      || metadata.content_type
        === ""
      ? null
      : typeof metadata.content_type
        === "string"
        ? metadata.content_type
        : null;

  if (
    !Number.isInteger(status)
    || status < 100
    || status > 599
    || isIP(peerAddress) === 0
  ) {
    throw new Error(
      "CIMD curl metadata is incomplete",
    );
  }

  return {
    status,
    contentType,
    peerAddress,
  };
}

function decodeUtf8(
  bytes: Uint8Array,
): string {
  try {
    return new TextDecoder(
      "utf-8",
      {
        fatal: true,
      },
    ).decode(bytes);
  } catch {
    throw new Error(
      "CIMD response body is not valid UTF-8",
    );
  }
}

export function createCurlCimdPinnedTransport(
  binary: string,
  run:
    CimdCurlCommandRunner =
      runCimdCurlCommand,
): CimdPinnedTransport {
  const curlBin =
    boundedAbsoluteBinary(binary);

  return async (
    request,
  ): Promise<CimdPinnedFetchResponse> => {
    const invocation =
      buildCimdCurlInvocation(
        curlBin,
        request,
      );

    const result =
      await run(invocation);

    if (!result.ok) {
      const exit =
        result.exitCode === undefined
          ? ""
          : ` (exit=${result.exitCode})`;

      throw new Error(
        `CIMD curl transport failed: ${result.error}${exit}`,
      );
    }

    const metadata =
      parseCurlMetadata(
        result.stderr,
      );

    if (
      !request.allowedAddresses
        .map(normalizedAddress)
        .includes(
          metadata.peerAddress,
        )
    ) {
      throw new Error(
        "CIMD curl peer is outside the pinned address set",
      );
    }

    return {
      status:
        metadata.status,
      contentType:
        metadata.contentType,
      body:
        decodeUtf8(
          result.stdout,
        ),
      peerAddress:
        metadata.peerAddress,
    };
  };
}

export const resolveSystemCimdHostname:
  CimdResolver =
  async (hostname) => {
    const records =
      await lookup(
        hostname,
        {
          all: true,
          verbatim: true,
        },
      );

    return records.map(
      (record) =>
        record.address,
    );
  };

export function createCurlBackedCimdDiscoveryDependencies(
  binary: string,
): CimdDiscoveryDependencies {
  const validatedBinary =
    validateConfiguredCimdCurlBinary(
      binary,
    );

  return Object.freeze({
    resolve:
      resolveSystemCimdHostname,
    fetchPinned:
      createCurlCimdPinnedTransport(
        validatedBinary,
      ),
  });
}
