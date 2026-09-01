export const MAX_WORKFLOW_RESULT_REFERENCES = 64;
export const MAX_RESULT_PATH_SEGMENTS = 8;
export const MAX_RESULT_PATH_BYTES = 256;
export const MAX_RESULT_API_RESPONSE_BYTES = 1024 * 1024;
export const MAX_RESOLVED_STEP_PAYLOAD_BYTES = 256 * 1024;
export const MAX_REFERENCE_PAYLOAD_DEPTH = 32;

const SAFE_STEP_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_ARRAY_INDEX = /^(0|[1-9][0-9]{0,5})$/;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const encoder = new TextEncoder();

export interface WorkflowResultReference {
  $from: string;
  path: string;
}

export interface ResultReferenceConfig {
  origin: string;
  requestTimeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class WorkflowResultReferenceError extends Error {}
export class WorkflowResultReadError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function normalizeWorkflowResultOrigin(raw: string): string {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  if (url.protocol !== "http:" || !loopback) {
    throw new Error("WORKFLOW_RESULT_ORIGIN must be a loopback http origin");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("WORKFLOW_RESULT_ORIGIN must contain only scheme, host, and port");
  }
  return url.origin;
}

export function parseResultPath(raw: string): string[] {
  if (raw.length === 0 || encoder.encode(raw).byteLength > MAX_RESULT_PATH_BYTES) {
    throw new WorkflowResultReferenceError("result reference path must contain 1-256 bytes");
  }
  const segments = raw.split(".");
  if (segments.length === 0 || segments.length > MAX_RESULT_PATH_SEGMENTS) {
    throw new WorkflowResultReferenceError(
      `result reference path supports at most ${MAX_RESULT_PATH_SEGMENTS} segments`,
    );
  }
  for (const segment of segments) {
    if (
      FORBIDDEN_PATH_SEGMENTS.has(segment) ||
      (!SAFE_PATH_SEGMENT.test(segment) && !SAFE_ARRAY_INDEX.test(segment))
    ) {
      throw new WorkflowResultReferenceError(`invalid result reference path segment: ${segment}`);
    }
  }
  return segments;
}

function parseReference(record: Record<string, unknown>): WorkflowResultReference | null {
  if (!own(record, "$from")) return null;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !own(record, "path")) {
    throw new WorkflowResultReferenceError(
      "result reference objects must contain exactly $from and path",
    );
  }
  if (typeof record.$from !== "string" || !SAFE_STEP_ID.test(record.$from)) {
    throw new WorkflowResultReferenceError("result reference $from must be a safe step id");
  }
  if (typeof record.path !== "string") {
    throw new WorkflowResultReferenceError("result reference path must be a string");
  }
  parseResultPath(record.path);
  return { $from: record.$from, path: record.path };
}

function walkReferences(
  value: unknown,
  depth: number,
  onReference: (reference: WorkflowResultReference) => void,
): void {
  if (depth > MAX_REFERENCE_PAYLOAD_DEPTH) {
    throw new WorkflowResultReferenceError(
      `workflow payload nesting exceeds ${MAX_REFERENCE_PAYLOAD_DEPTH}`,
    );
  }
  if (Array.isArray(value)) {
    for (const entry of value) walkReferences(entry, depth + 1, onReference);
    return;
  }
  if (!isRecord(value)) return;
  const reference = parseReference(value);
  if (reference !== null) {
    onReference(reference);
    return;
  }
  for (const entry of Object.values(value)) walkReferences(entry, depth + 1, onReference);
}

export function validateResultReferencePayload(
  payload: unknown,
  allowedSourceStepIds: ReadonlySet<string>,
): number {
  let references = 0;
  walkReferences(payload, 0, (reference) => {
    references += 1;
    if (references > MAX_WORKFLOW_RESULT_REFERENCES) {
      throw new WorkflowResultReferenceError(
        `workflow supports at most ${MAX_WORKFLOW_RESULT_REFERENCES} result references per step`,
      );
    }
    if (!allowedSourceStepIds.has(reference.$from)) {
      throw new WorkflowResultReferenceError(
        `result reference source ${reference.$from} is not an ancestor dependency`,
      );
    }
  });
  return references;
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESULT_API_RESPONSE_BYTES) {
      throw new WorkflowResultReadError("queue result response exceeds bounded size");
    }
  }
  if (response.body === null) {
    throw new WorkflowResultReadError("queue result response body is missing");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESULT_API_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new WorkflowResultReadError("queue result response exceeds bounded size");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WorkflowResultReadError("queue result response is not valid UTF-8");
  }
}

async function fetchProjection(
  taskId: number,
  config: ResultReferenceConfig,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await (config.fetchImpl ?? fetch)(`${config.origin}/v1/tasks/${taskId}/result`, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
    const raw = await readBoundedText(response);
    if (response.status === 404) {
      throw new WorkflowResultReadError(`completed source task ${taskId} has no result projection`);
    }
    if (response.status !== 200) {
      throw new WorkflowResultReadError(
        `queue result read for task ${taskId} failed with HTTP ${response.status}`,
      );
    }
    let wrapper: unknown;
    try {
      wrapper = JSON.parse(raw);
    } catch {
      throw new WorkflowResultReadError("queue result endpoint returned invalid JSON");
    }
    if (
      !isRecord(wrapper) ||
      wrapper.task_id !== taskId ||
      typeof wrapper.result_json !== "string" ||
      !Number.isSafeInteger(wrapper.result_bytes) ||
      (wrapper.result_bytes as number) < 0 ||
      (wrapper.result_bytes as number) > MAX_RESOLVED_STEP_PAYLOAD_BYTES ||
      encoder.encode(wrapper.result_json).byteLength !== wrapper.result_bytes
    ) {
      throw new WorkflowResultReadError("queue result endpoint returned an invalid projection wrapper");
    }
    let projection: unknown;
    try {
      projection = JSON.parse(wrapper.result_json);
    } catch {
      throw new WorkflowResultReadError("stored result projection is not valid JSON");
    }
    if (!isRecord(projection)) {
      throw new WorkflowResultReadError("stored result projection must be a JSON object");
    }
    return projection;
  } catch (error) {
    if (error instanceof WorkflowResultReadError) throw error;
    throw new WorkflowResultReadError(
      `queue result request failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function selectPath(root: Record<string, unknown>, path: string): unknown {
  const segments = parseResultPath(path);
  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!SAFE_ARRAY_INDEX.test(segment)) {
        throw new WorkflowResultReadError(`result path segment ${segment} is not an array index`);
      }
      const index = Number(segment);
      if (index >= current.length) {
        throw new WorkflowResultReadError(`result path array index ${segment} is out of bounds`);
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !own(current, segment)) {
      throw new WorkflowResultReadError(`result path segment ${segment} does not exist`);
    }
    current = current[segment];
  }
  return current;
}

export async function resolveResultReferences(
  payload: unknown,
  sourceTaskIds: ReadonlyMap<string, number>,
  rawConfig: ResultReferenceConfig,
): Promise<unknown> {
  const config: ResultReferenceConfig = {
    ...rawConfig,
    origin: normalizeWorkflowResultOrigin(rawConfig.origin),
  };
  if (
    !Number.isSafeInteger(config.requestTimeoutMs) ||
    config.requestTimeoutMs < 100 ||
    config.requestTimeoutMs > 60_000
  ) {
    throw new Error("workflow result request timeout must be between 100 and 60000");
  }
  validateResultReferencePayload(payload, new Set(sourceTaskIds.keys()));
  const cache = new Map<number, Record<string, unknown>>();
  let references = 0;

  const resolve = async (value: unknown, depth: number): Promise<unknown> => {
    if (depth > MAX_REFERENCE_PAYLOAD_DEPTH) {
      throw new WorkflowResultReferenceError(
        `workflow payload nesting exceeds ${MAX_REFERENCE_PAYLOAD_DEPTH}`,
      );
    }
    if (Array.isArray(value)) {
      return Promise.all(value.map((entry) => resolve(entry, depth + 1)));
    }
    if (!isRecord(value)) return value;
    const reference = parseReference(value);
    if (reference !== null) {
      references += 1;
      if (references > MAX_WORKFLOW_RESULT_REFERENCES) {
        throw new WorkflowResultReferenceError(
          `workflow supports at most ${MAX_WORKFLOW_RESULT_REFERENCES} result references per step`,
        );
      }
      const taskId = sourceTaskIds.get(reference.$from);
      if (taskId === undefined) {
        throw new WorkflowResultReferenceError(
          `result reference source ${reference.$from} is not an available ancestor`,
        );
      }
      let projection = cache.get(taskId);
      if (projection === undefined) {
        projection = await fetchProjection(taskId, config);
        cache.set(taskId, projection);
      }
      return selectPath(projection, reference.path);
    }
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = await resolve(entry, depth + 1);
    }
    return output;
  };

  const resolved = await resolve(payload, 0);
  let encoded: string;
  try {
    encoded = JSON.stringify(resolved);
  } catch {
    throw new WorkflowResultReadError("resolved workflow step payload is not JSON serializable");
  }
  if (encoder.encode(encoded).byteLength > MAX_RESOLVED_STEP_PAYLOAD_BYTES) {
    throw new WorkflowResultReadError("resolved workflow step payload exceeds 256 KiB");
  }
  return resolved;
}
