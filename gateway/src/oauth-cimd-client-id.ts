import { isIP } from "node:net";

import {
  isSpecialUseIpAddress,
} from "./oauth-cimd-network";

export const MAX_CIMD_CLIENT_ID_BYTES =
  2_048;

const encoder = new TextEncoder();

export interface ValidatedCimdClientId {
  value: string;
  hostname: string;
  port: string | null;
}

export type CimdClientIdValidationResult =
  | {
      ok: true;
      value: ValidatedCimdClientId;
    }
  | {
      ok: false;
      error:
        | "invalid_url"
        | "too_large"
        | "https_required"
        | "userinfo_forbidden"
        | "query_forbidden"
        | "fragment_forbidden"
        | "path_required"
        | "root_path_forbidden"
        | "dot_segment_forbidden"
        | "localhost_forbidden"
        | "special_use_ip";
    };

function rawPath(
  value: string,
): string | null {
  const scheme =
    value.indexOf("://");
  if (scheme < 0) return null;

  const authorityStart =
    scheme + 3;

  const query =
    value.indexOf("?", authorityStart);
  const fragment =
    value.indexOf("#", authorityStart);

  let end = value.length;
  if (query >= 0) {
    end = Math.min(end, query);
  }
  if (fragment >= 0) {
    end = Math.min(end, fragment);
  }

  const slash =
    value.indexOf("/", authorityStart);

  if (
    slash < 0
    || slash >= end
  ) {
    return null;
  }

  return value.slice(slash, end);
}

function hasDotSegment(
  path: string,
): boolean {
  for (const segment of path.split("/")) {
    if (!segment) continue;

    let decoded: string;
    try {
      decoded =
        decodeURIComponent(segment);
    } catch {
      return true;
    }

    if (
      decoded === "."
      || decoded === ".."
    ) {
      return true;
    }
  }

  return false;
}

export function validateCimdClientId(
  value: string,
): CimdClientIdValidationResult {
  if (
    value.length === 0
    || value !== value.trim()
    || value.includes("\\")
  ) {
    return {
      ok: false,
      error: "invalid_url",
    };
  }

  if (
    encoder.encode(value).byteLength
      > MAX_CIMD_CLIENT_ID_BYTES
  ) {
    return {
      ok: false,
      error: "too_large",
    };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      ok: false,
      error: "invalid_url",
    };
  }

  if (url.protocol !== "https:") {
    return {
      ok: false,
      error: "https_required",
    };
  }

  if (url.username || url.password) {
    return {
      ok: false,
      error: "userinfo_forbidden",
    };
  }

  if (url.search) {
    return {
      ok: false,
      error: "query_forbidden",
    };
  }

  if (url.hash) {
    return {
      ok: false,
      error: "fragment_forbidden",
    };
  }

  const path = rawPath(value);
  if (!path) {
    return {
      ok: false,
      error: "path_required",
    };
  }

  if (path === "/") {
    return {
      ok: false,
      error: "root_path_forbidden",
    };
  }

  if (hasDotSegment(path)) {
    return {
      ok: false,
      error: "dot_segment_forbidden",
    };
  }

  const hostname =
    url.hostname
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .toLowerCase();

  if (
    hostname === "localhost"
    || hostname.endsWith(
      ".localhost",
    )
  ) {
    return {
      ok: false,
      error: "localhost_forbidden",
    };
  }

  if (
    isIP(hostname) !== 0
    && isSpecialUseIpAddress(hostname)
  ) {
    return {
      ok: false,
      error: "special_use_ip",
    };
  }

  return {
    ok: true,
    value: Object.freeze({
      value,
      hostname,
      port:
        url.port || null,
    }),
  };
}
