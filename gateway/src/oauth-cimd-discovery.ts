import { isIP } from "node:net";

import {
  validateCimdClientId,
  type ValidatedCimdClientId,
} from "./oauth-cimd-client-id";
import {
  MAX_CIMD_DOCUMENT_BYTES,
  validateCimdDocument,
  type ValidatedCimdDocument,
} from "./oauth-cimd-document";
import {
  validateCimdResolvedAddresses,
} from "./oauth-cimd-network";

export const DEFAULT_CIMD_FETCH_TIMEOUT_MS =
  3_000;

export interface CimdPinnedFetchRequest {
  url: string;
  allowedAddresses: readonly string[];
  maxBytes: number;
  timeoutMs: number;
  redirect: "manual";
}

export interface CimdPinnedFetchResponse {
  status: number;
  contentType: string | null;
  body: string;
  peerAddress: string;
}

export type CimdResolver = (
  hostname: string,
) => Promise<readonly string[]>;

export type CimdPinnedTransport = (
  request: CimdPinnedFetchRequest,
) => Promise<CimdPinnedFetchResponse>;

export interface CimdDiscoveryDependencies {
  resolve:
    CimdResolver;
  fetchPinned:
    CimdPinnedTransport;
  timeoutMs?: number;
}

export interface DiscoveredCimdClient {
  identifier:
    ValidatedCimdClientId;
  metadata:
    ValidatedCimdDocument;
}

export type CimdDiscoveryResult =
  | {
      ok: true;
      value: DiscoveredCimdClient;
    }
  | {
      ok: false;
      error:
        | "invalid_client_id"
        | "resolution_failed"
        | "unsafe_resolution"
        | "fetch_failed"
        | "peer_mismatch"
        | "http_status"
        | "invalid_content_type"
        | "invalid_document";
    };

function jsonContentType(
  value: string | null,
): boolean {
  if (!value) return false;

  const mediaType =
    value
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();

  return (
    mediaType === "application/json"
    || (
      mediaType.startsWith(
        "application/",
      )
      && mediaType.endsWith(
        "+json",
      )
    )
  );
}

function normalizeAddress(
  value: string,
): string {
  return (
    value.startsWith("[")
    && value.endsWith("]")
  )
    ? value.slice(1, -1)
    : value;
}

export async function discoverCimdClient(
  clientIdentifierUrl: string,
  dependencies:
    CimdDiscoveryDependencies,
): Promise<CimdDiscoveryResult> {
  const validated =
    validateCimdClientId(
      clientIdentifierUrl,
    );

  if (!validated.ok) {
    return {
      ok: false,
      error: "invalid_client_id",
    };
  }

  let addresses:
    readonly string[];

  if (
    isIP(
      validated.value.hostname,
    ) !== 0
  ) {
    addresses = [
      validated.value.hostname,
    ];
  } else {
    try {
      addresses =
        await dependencies.resolve(
          validated.value.hostname,
        );
    } catch {
      return {
        ok: false,
        error: "resolution_failed",
      };
    }
  }

  const safeResolution =
    validateCimdResolvedAddresses(
      addresses,
    );

  if (!safeResolution.ok) {
    return {
      ok: false,
      error: "unsafe_resolution",
    };
  }

  const timeoutMs =
    dependencies.timeoutMs
      ?? DEFAULT_CIMD_FETCH_TIMEOUT_MS;

  if (
    !Number.isInteger(timeoutMs)
    || timeoutMs < 100
    || timeoutMs > 10_000
  ) {
    return {
      ok: false,
      error: "fetch_failed",
    };
  }

  let response:
    CimdPinnedFetchResponse;

  try {
    response =
      await dependencies.fetchPinned({
        url:
          validated.value.value,
        allowedAddresses:
          safeResolution.addresses,
        maxBytes:
          MAX_CIMD_DOCUMENT_BYTES,
        timeoutMs,
        redirect: "manual",
      });
  } catch {
    return {
      ok: false,
      error: "fetch_failed",
    };
  }

  const peer =
    normalizeAddress(
      response.peerAddress,
    );

  if (
    !safeResolution.addresses
      .includes(peer)
  ) {
    return {
      ok: false,
      error: "peer_mismatch",
    };
  }

  if (response.status !== 200) {
    return {
      ok: false,
      error: "http_status",
    };
  }

  if (
    !jsonContentType(
      response.contentType,
    )
  ) {
    return {
      ok: false,
      error: "invalid_content_type",
    };
  }

  const document =
    validateCimdDocument(
      validated.value.value,
      response.body,
    );

  if (!document.ok) {
    return {
      ok: false,
      error: "invalid_document",
    };
  }

  return {
    ok: true,
    value: Object.freeze({
      identifier:
        validated.value,
      metadata:
        document.value,
    }),
  };
}
