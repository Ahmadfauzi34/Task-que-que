import {
  validateCimdClientId,
} from "./oauth-cimd-client-id";

export const MAX_CIMD_DOCUMENT_BYTES =
  5 * 1024;
export const MAX_CIMD_REDIRECT_URIS =
  16;

const MAX_CLIENT_NAME_BYTES = 256;
const MAX_REDIRECT_URI_BYTES = 2_048;
const encoder = new TextEncoder();

export interface ValidatedCimdDocument {
  clientId: string;
  clientName: string;
  redirectUris: readonly string[];
  tokenEndpointAuthMethod: "none";
}

export type CimdDocumentValidationResult =
  | {
      ok: true;
      value: ValidatedCimdDocument;
    }
  | {
      ok: false;
      error:
        | "document_too_large"
        | "invalid_json"
        | "invalid_document"
        | "client_id_mismatch"
        | "invalid_client_name"
        | "invalid_redirect_uris"
        | "unsupported_client_authentication"
        | "client_secret_forbidden"
        | "unsupported_grant_type"
        | "unsupported_response_type";
    };

function stringArray(
  value: unknown,
): readonly string[] | null {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some(
      (entry) =>
        typeof entry !== "string",
    )
  ) {
    return null;
  }

  return value as string[];
}

function validClientName(
  value: unknown,
): value is string {
  return (
    typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && encoder.encode(value).byteLength
      <= MAX_CLIENT_NAME_BYTES
    && !/[\u0000-\u001F\u007F]/.test(
      value,
    )
  );
}

function validRedirectUri(
  value: string,
): boolean {
  if (
    value.length === 0
    || value !== value.trim()
    || encoder.encode(value).byteLength
      > MAX_REDIRECT_URI_BYTES
  ) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  return (
    url.protocol === "https:"
    && !url.username
    && !url.password
    && !url.hash
  );
}

export function validateCimdDocument(
  clientIdentifierUrl: string,
  raw: string,
): CimdDocumentValidationResult {
  if (
    encoder.encode(raw).byteLength
      > MAX_CIMD_DOCUMENT_BYTES
  ) {
    return {
      ok: false,
      error: "document_too_large",
    };
  }

  const clientId =
    validateCimdClientId(
      clientIdentifierUrl,
    );

  if (!clientId.ok) {
    return {
      ok: false,
      error: "invalid_document",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: "invalid_json",
    };
  }

  if (
    parsed === null
    || typeof parsed !== "object"
    || Array.isArray(parsed)
  ) {
    return {
      ok: false,
      error: "invalid_document",
    };
  }

  const document =
    parsed as Record<
      string,
      unknown
    >;

  if (
    document.client_id
      !== clientIdentifierUrl
  ) {
    return {
      ok: false,
      error: "client_id_mismatch",
    };
  }

  if (
    !validClientName(
      document.client_name,
    )
  ) {
    return {
      ok: false,
      error: "invalid_client_name",
    };
  }

  const redirectUris =
    stringArray(
      document.redirect_uris,
    );

  if (
    !redirectUris
    || redirectUris.length
      > MAX_CIMD_REDIRECT_URIS
    || new Set(redirectUris).size
      !== redirectUris.length
    || redirectUris.some(
      (uri) =>
        !validRedirectUri(uri),
    )
  ) {
    return {
      ok: false,
      error: "invalid_redirect_uris",
    };
  }

  if (
    "client_secret" in document
    || "client_secret_expires_at"
      in document
  ) {
    return {
      ok: false,
      error: "client_secret_forbidden",
    };
  }

  if (
    document.token_endpoint_auth_method
      !== "none"
  ) {
    return {
      ok: false,
      error:
        "unsupported_client_authentication",
    };
  }

  if (
    document.grant_types
      !== undefined
  ) {
    const grantTypes =
      stringArray(
        document.grant_types,
      );

    if (
      !grantTypes
      || !grantTypes.includes(
        "authorization_code",
      )
    ) {
      return {
        ok: false,
        error:
          "unsupported_grant_type",
      };
    }
  }

  if (
    document.response_types
      !== undefined
  ) {
    const responseTypes =
      stringArray(
        document.response_types,
      );

    if (
      !responseTypes
      || !responseTypes.includes(
        "code",
      )
    ) {
      return {
        ok: false,
        error:
          "unsupported_response_type",
      };
    }
  }

  return {
    ok: true,
    value: Object.freeze({
      clientId:
        clientIdentifierUrl,
      clientName:
        document.client_name,
      redirectUris:
        Object.freeze([
          ...redirectUris,
        ]),
      tokenEndpointAuthMethod:
        "none" as const,
    }),
  };
}
