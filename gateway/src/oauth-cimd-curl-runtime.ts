import {
  isIP,
} from "node:net";

import type {
  CimdDiscoveryDependencies,
  CimdPinnedFetchRequest,
  CimdPinnedFetchResponse,
  CimdPinnedTransport,
} from "./oauth-cimd-discovery";
import {
  runCimdCurlCommand,
  type CimdCurlCommandRunner,
  type CimdCurlInvocation,
  validateConfiguredCimdCurlBinary,
  resolveSystemCimdHostname,
} from "./oauth-cimd-curl-transport";

const MAX_TRANSPORT_BODY_BYTES =
  8 * 1024;
const MAX_CURL_STDERR_BYTES =
  64 * 1024;
const MAX_CONNECT_ATTEMPTS = 2;
const MIN_ATTEMPT_TIMEOUT_MS = 100;

const STATUS_MARKER =
  "__TQQ_CIMD_STATUS__";
const TYPE_MARKER =
  "__TQQ_CIMD_TYPE__";
const PEER_MARKER =
  "__TQQ_CIMD_PEER__";

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

function curlAddress(
  value: string,
): string {
  const normalized =
    normalizedAddress(value);

  return isIP(normalized) === 6
    ? `[${normalized}]`
    : normalized;
}

function validatedRequest(
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
    || request.timeoutMs < 100
    || request.timeoutMs > 10_000
    || request.allowedAddresses.length < 1
    || request.allowedAddresses.length > 16
  ) {
    throw new Error(
      "CIMD runtime request is outside the pinned transport contract",
    );
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new Error(
      "CIMD runtime URL is invalid",
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
      "CIMD runtime URL must be unambiguous HTTPS",
    );
  }

  const addresses =
    request.allowedAddresses.map(
      (raw) => {
        const address =
          normalizedAddress(raw);

        if (isIP(address) === 0) {
          throw new Error(
            "CIMD runtime destination must be an IP address",
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
      "CIMD runtime destination set contains duplicates",
    );
  }

  return {
    url,
    addresses:
      Object.freeze(addresses),
  };
}

function preferredAddresses(
  addresses: readonly string[],
): readonly string[] {
  const ipv4 =
    addresses.find(
      (address) =>
        isIP(address) === 4,
    );
  const ipv6 =
    addresses.find(
      (address) =>
        isIP(address) === 6,
    );

  const preferred = [
    ipv4,
    ipv6,
  ].filter(
    (address): address is string =>
      typeof address === "string",
  );

  if (preferred.length > 0) {
    return Object.freeze(
      preferred.slice(
        0,
        MAX_CONNECT_ATTEMPTS,
      ),
    );
  }

  return Object.freeze(
    addresses.slice(
      0,
      MAX_CONNECT_ATTEMPTS,
    ),
  );
}

export function buildPortableCimdCurlInvocation(
  binary: string,
  request: CimdPinnedFetchRequest,
  address: string,
  attemptTimeoutMs:
    number = request.timeoutMs,
): CimdCurlInvocation {
  const bounded =
    validatedRequest(request);
  const peer =
    normalizedAddress(address);

  if (
    !bounded.addresses.includes(peer)
  ) {
    throw new Error(
      "CIMD runtime peer is outside the validated address set",
    );
  }

  if (
    !Number.isInteger(
      attemptTimeoutMs,
    )
    || attemptTimeoutMs
      < MIN_ATTEMPT_TIMEOUT_MS
    || attemptTimeoutMs
      > request.timeoutMs
  ) {
    throw new Error(
      "CIMD runtime attempt timeout is invalid",
    );
  }

  const hostname =
    bounded.url.hostname
      .replace(/^\[/, "")
      .replace(/\]$/, "");
  const port =
    bounded.url.port || "443";
  const seconds =
    (
      attemptTimeoutMs
      / 1_000
    ).toFixed(3);

  return Object.freeze({
    binary:
      validateConfiguredCimdCurlBinary(
        binary,
      ),
    args: Object.freeze([
      "--disable",
      "--globoff",
      "--silent",
      "--show-error",
      "--noproxy",
      "*",
      "--proto",
      "=https",
      "--connect-timeout",
      seconds,
      "--max-time",
      seconds,
      "--max-filesize",
      String(request.maxBytes),
      "--header",
      "Accept: application/json, application/*+json",
      "--header",
      "User-Agent: task-que-que-cimd/1",
      "--resolve",
      `${hostname}:${port}:${curlAddress(peer)}`,
      "--write-out",
      `%{stderr}\n${STATUS_MARKER}%{http_code}\n${TYPE_MARKER}%{content_type}\n${PEER_MARKER}%{remote_ip}\n`,
      request.url,
    ]),
    timeoutMs:
      attemptTimeoutMs + 500,
    maxStdoutBytes:
      request.maxBytes,
    maxStderrBytes:
      MAX_CURL_STDERR_BYTES,
  });
}

function markerValue(
  stderr: string,
  marker: string,
): string | null {
  const line =
    stderr
      .split(/\r?\n/)
      .find(
        (entry) =>
          entry.startsWith(marker),
      );

  return line
    ? line.slice(marker.length)
    : null;
}

function parseMetadata(
  stderr: string,
): {
  status: number;
  contentType: string | null;
  peerAddress: string;
} {
  const rawStatus =
    markerValue(
      stderr,
      STATUS_MARKER,
    );
  const rawType =
    markerValue(
      stderr,
      TYPE_MARKER,
    );
  const rawPeer =
    markerValue(
      stderr,
      PEER_MARKER,
    );

  const status =
    Number(rawStatus);
  const peerAddress =
    rawPeer
      ? normalizedAddress(rawPeer)
      : "";

  if (
    !Number.isInteger(status)
    || status < 100
    || status > 599
    || isIP(peerAddress) === 0
  ) {
    throw new Error(
      "CIMD runtime curl metadata is incomplete",
    );
  }

  return {
    status,
    contentType:
      rawType && rawType.length > 0
        ? rawType
        : null,
    peerAddress,
  };
}

function decodeUtf8(
  body: Uint8Array,
): string {
  try {
    return new TextDecoder(
      "utf-8",
      {
        fatal: true,
      },
    ).decode(body);
  } catch {
    throw new Error(
      "CIMD runtime response is not valid UTF-8",
    );
  }
}

export function createPortableCimdPinnedTransport(
  binary: string,
  run:
    CimdCurlCommandRunner =
      runCimdCurlCommand,
): CimdPinnedTransport {
  const curlBin =
    validateConfiguredCimdCurlBinary(
      binary,
    );

  return async (
    request,
  ): Promise<CimdPinnedFetchResponse> => {
    const bounded =
      validatedRequest(request);
    const attempts =
      preferredAddresses(
        bounded.addresses,
      );
    const attemptTimeoutMs =
      Math.max(
        MIN_ATTEMPT_TIMEOUT_MS,
        Math.floor(
          request.timeoutMs
            / attempts.length,
        ),
      );

    let lastExit:
      number | undefined;

    for (
      const address
      of attempts
    ) {
      const invocation =
        buildPortableCimdCurlInvocation(
          curlBin,
          request,
          address,
          attemptTimeoutMs,
        );

      const result =
        await run(invocation);

      if (!result.ok) {
        lastExit =
          result.exitCode;
        continue;
      }

      const metadata =
        parseMetadata(
          result.stderr,
        );

      if (
        metadata.peerAddress
          !== address
      ) {
        throw new Error(
          "CIMD runtime curl peer escaped the pinned address",
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
    }

    const suffix =
      lastExit === undefined
        ? ""
        : ` (exit=${lastExit})`;

    throw new Error(
      `CIMD portable curl transport failed${suffix}`,
    );
  };
}

export function createPortableCurlBackedCimdDiscoveryDependencies(
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
      createPortableCimdPinnedTransport(
        validatedBinary,
      ),
  });
}
