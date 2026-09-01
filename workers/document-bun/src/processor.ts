import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MAX_DOCUMENT_TEXT_BYTES = 256 * 1024;
const DOCUMENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface DocumentPayload {
  text: string;
  document_id?: string;
}

export interface DocumentResult {
  schema_version: 1;
  task_id: number;
  document_id?: string;
  bytes: number;
  characters: number;
  lines: number;
  words: number;
  sha256: string;
}

export class DocumentPayloadError extends Error {
  readonly code = "invalid_payload";
}

export function parseDocumentPayload(raw: string): DocumentPayload {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DocumentPayloadError("payload must be valid JSON");
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DocumentPayloadError("payload must be a JSON object");
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "text" && key !== "document_id") {
      throw new DocumentPayloadError(`unsupported payload field: ${key}`);
    }
  }

  if (typeof record.text !== "string") {
    throw new DocumentPayloadError("payload.text must be a string");
  }

  const bytes = new TextEncoder().encode(record.text).byteLength;
  if (bytes > MAX_DOCUMENT_TEXT_BYTES) {
    throw new DocumentPayloadError("payload.text exceeds the 256 KiB worker limit");
  }

  let documentId: string | undefined;
  if (record.document_id !== undefined) {
    if (typeof record.document_id !== "string" || !DOCUMENT_ID.test(record.document_id)) {
      throw new DocumentPayloadError(
        "payload.document_id must be a 1-128 character safe identifier",
      );
    }
    documentId = record.document_id;
  }

  return documentId === undefined
    ? { text: record.text }
    : { text: record.text, document_id: documentId };
}

export async function processDocument(
  taskId: number,
  rawPayload: string,
): Promise<DocumentResult> {
  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    throw new Error("task id must be a positive safe integer");
  }

  const payload = parseDocumentPayload(rawPayload);
  const encoded = new TextEncoder().encode(payload.text);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  const trimmed = payload.text.trim();
  const result: DocumentResult = {
    schema_version: 1,
    task_id: taskId,
    bytes: encoded.byteLength,
    characters: [...payload.text].length,
    lines: payload.text.length === 0 ? 0 : payload.text.split(/\r\n|\r|\n/).length,
    words: trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length,
    sha256,
  };

  if (payload.document_id !== undefined) {
    result.document_id = payload.document_id;
  }

  return result;
}

export async function writeDocumentResultAtomic(
  outputDir: string,
  result: DocumentResult,
): Promise<string> {
  if (outputDir.length === 0) {
    throw new Error("output directory must not be empty");
  }

  await mkdir(outputDir, { recursive: true });
  const finalPath = join(outputDir, `task-${result.task_id}.json`);
  const tempPath = join(
    outputDir,
    `.task-${result.task_id}.${crypto.randomUUID()}.tmp`,
  );

  try {
    await writeFile(tempPath, `${JSON.stringify(result)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return finalPath;
}
